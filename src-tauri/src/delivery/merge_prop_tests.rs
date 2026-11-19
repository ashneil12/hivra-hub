//! SC-6 (spec 4i): property tests for the merge decision.
//!
//! The rule that must always hold: red checks, pending checks, a draft, a conflict or an open decision never merge, and a
//! merge only ever runs on the head it judged. `decide` is pure, so it is driven over every combination of the facts it
//! reads. The head rule lives across two reads in `merge`, so it is driven through `merge` with the test `gh` stand-in.

use proptest::prelude::*;

use super::{approve, decide, merge, Allow, Caller, Decision, MergeOutcome, MergeRequest, Method};
use crate::delivery::github::fake::FakeGithub;
use crate::pr_watch::eval::{Check, CheckStatus, Detail, Mergeability};
use crate::pr_watch::github::{PrRead, PrState};
use crate::session_store::SessionStore;

/// 64 cases a run, or whatever `PROPTEST_CASES` says (an explicit `cases` would override the variable).
fn config() -> ProptestConfig {
    let mut config = ProptestConfig::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = 64;
    }
    config
}

/// Three real-looking heads: the base hold only reads hex commit ids, and a head moving is one of these becoming another.
const HEADS: [&str; 3] = [
    "1111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222",
    "3333333333333333333333333333333333333333",
];

/// Every fact `decide` reads from the pull request.
#[derive(Clone, Debug)]
struct Facts {
    state: PrState,
    draft: bool,
    head: Option<String>,
    mergeability: Mergeability,
    merge_state: Option<String>,
    checks: Vec<Check>,
}

impl Facts {
    fn read(&self) -> PrRead {
        PrRead {
            repo: "acme/web".into(),
            number: 7,
            url: "https://github.com/acme/web/pull/7".into(),
            title: "Fix the save bug".into(),
            state: self.state,
            draft: self.draft,
            merge_sha: (self.state == PrState::Merged).then(|| "m3rg3".to_string()),
            merged_at: None,
            head_ref: "work".into(),
            base_ref: "main".into(),
            // The merge stand-in's merge base is this same commit: main has not moved under the pull request.
            base_tip: Some("ba5e".repeat(10)),
            head_repo: Some("acme/web".into()),
            review_decision: None,
            merge_state: self.merge_state.clone(),
            labels: Vec::new(),
            detail: Detail {
                head_sha: self.head.clone(),
                checks: self.checks.clone(),
                mergeability: self.mergeability,
                viewer: None,
                author: None,
            },
            remarks: Some(Vec::new()),
            rate: None,
            changed_files: None,
        }
    }
}

/// The checks that decide, written out on its own: the required ones, or every check when none is required.
fn deciding(checks: &[Check]) -> Vec<&Check> {
    let required: Vec<&Check> = checks.iter().filter(|c| c.required).collect();
    if required.is_empty() {
        checks.iter().collect()
    } else {
        required
    }
}

/// Whether the facts alone, with no word from anyone, rule a merge out. The spec's table, as an independent model.
fn blocked(facts: &Facts, open_decision: Option<&str>) -> bool {
    let red = deciding(&facts.checks).iter().any(|c| {
        matches!(
            c.status,
            CheckStatus::Failure | CheckStatus::Cancelled | CheckStatus::ActionRequired
        )
    });
    let pending = deciding(&facts.checks)
        .iter()
        .any(|c| c.status == CheckStatus::Pending);
    facts.state != PrState::Open
        || facts.draft
        || facts.head.is_none()
        || facts.mergeability == Mergeability::Conflicting
        || facts.merge_state.as_deref() == Some("DIRTY")
        || red
        || pending
        || open_decision.is_some()
}

fn status() -> impl Strategy<Value = CheckStatus> {
    prop_oneof![
        5 => Just(CheckStatus::Success),
        2 => Just(CheckStatus::Pending),
        2 => Just(CheckStatus::Failure),
        1 => Just(CheckStatus::Cancelled),
        1 => Just(CheckStatus::ActionRequired),
        1 => Just(CheckStatus::Skipped),
        1 => Just(CheckStatus::Neutral),
    ]
}

fn check_with(status: impl Strategy<Value = CheckStatus>) -> impl Strategy<Value = Check> {
    (
        "[a-z]{1,8}",
        status,
        prop::option::of("[a-z0-9]{1,6}"),
        prop::bool::ANY,
    )
        .prop_map(|(name, status, url, required)| Check {
            url: url.map(|id| format!("https://github.com/acme/web/actions/runs/1/job/{id}")),
            name,
            status,
            required,
        })
}

fn head() -> impl Strategy<Value = Option<String>> {
    prop_oneof![
        9 => prop::sample::select(HEADS.to_vec()).prop_map(|h| Some(h.to_string())),
        1 => Just(None),
    ]
}

fn merge_state() -> impl Strategy<Value = Option<String>> {
    prop_oneof![
        3 => Just(None),
        1 => Just(Some("DIRTY".to_string())),
        1 => Just(Some("dirty".to_string())),
        2 => Just(Some("BEHIND".to_string())),
        2 => Just(Some("CLEAN".to_string())),
        1 => Just(Some("UNSTABLE".to_string())),
        1 => any::<String>().prop_map(Some),
    ]
}

/// Any combination of the facts, leaning toward a pull request that would otherwise be fine.
fn facts() -> impl Strategy<Value = Facts> {
    (
        prop_oneof![
            6 => Just(PrState::Open),
            1 => Just(PrState::Closed),
            1 => Just(PrState::Merged),
        ],
        prop::bool::weighted(0.15),
        head(),
        prop_oneof![
            6 => Just(Mergeability::Mergeable),
            2 => Just(Mergeability::Unknown),
            1 => Just(Mergeability::Conflicting),
        ],
        merge_state(),
        prop::collection::vec(check_with(status()), 0..6),
    )
        .prop_map(
            |(state, draft, head, mergeability, merge_state, checks)| Facts {
                state,
                draft,
                head,
                mergeability,
                merge_state,
                checks,
            },
        )
}

/// A pull request nothing rules out: open, ready, a head, no conflict, every deciding check passed or skipped.
fn calm() -> impl Strategy<Value = Facts> {
    (
        prop::sample::select(HEADS.to_vec()),
        prop_oneof![Just(Mergeability::Mergeable), Just(Mergeability::Unknown)],
        prop_oneof![
            Just(None),
            Just(Some("BEHIND".to_string())),
            Just(Some("CLEAN".to_string()))
        ],
        prop::collection::vec(
            check_with(prop_oneof![
                Just(CheckStatus::Success),
                Just(CheckStatus::Skipped),
                Just(CheckStatus::Neutral)
            ]),
            0..5,
        ),
    )
        .prop_map(|(head, mergeability, merge_state, checks)| Facts {
            state: PrState::Open,
            draft: false,
            head: Some(head.to_string()),
            mergeability,
            merge_state,
            checks,
        })
}

/// A fact that rules a merge out on its own.
#[derive(Clone, Debug)]
enum Defect {
    Closed,
    Merged,
    Draft,
    NoHead,
    Conflict,
    Dirty,
    Red(CheckStatus),
    Pending,
    OpenDecision(String),
}

fn defect() -> impl Strategy<Value = Defect> {
    prop_oneof![
        Just(Defect::Closed),
        Just(Defect::Merged),
        Just(Defect::Draft),
        Just(Defect::NoHead),
        Just(Defect::Conflict),
        Just(Defect::Dirty),
        prop_oneof![
            Just(CheckStatus::Failure),
            Just(CheckStatus::Cancelled),
            Just(CheckStatus::ActionRequired)
        ]
        .prop_map(Defect::Red),
        Just(Defect::Pending),
        // An empty question is still an open decision.
        prop_oneof![Just(String::new()), "[a-z ?]{1,20}", any::<String>()]
            .prop_map(Defect::OpenDecision),
    ]
}

fn allow() -> impl Strategy<Value = Allow> {
    prop_oneof![
        any::<String>().prop_map(|by| Allow::Person { by }),
        Just(Allow::Switch),
        Just(Allow::Nobody),
    ]
}

fn red_or_pending(status: CheckStatus) -> Check {
    Check {
        name: "build".into(),
        status,
        url: None,
        required: true,
    }
}

proptest! {
    #![proptest_config(config())]

    /// Whatever the facts and whoever allows it: red or pending checks, a draft, a conflict, a pull request that is not
    /// open, no readable head, or an open decision is a refusal. Never a merge, and never a question the person could
    /// answer yes to.
    #[test]
    fn prop_red_pending_draft_conflict_or_open_decision_never_merges(
        facts in facts(),
        open in prop::option::of(prop_oneof![Just(String::new()), "[a-z ?]{0,30}", any::<String>()]),
        allow in allow(),
    ) {
        let got = decide(&facts.read(), open.as_deref(), &allow);
        if blocked(&facts, open.as_deref()) {
            prop_assert!(matches!(got, Decision::Refuse(_)), "a blocked pull request got {:?}", got);
        }
        if let Decision::Merge { .. } = got {
            prop_assert!(!blocked(&facts, open.as_deref()));
        }
    }

    /// Each blocking fact alone, on a pull request that is otherwise green, refuses, for every way of allowing it.
    #[test]
    fn prop_a_single_defect_alone_always_refuses(
        base in calm(),
        defect in defect(),
        allow in allow(),
    ) {
        let mut facts = base;
        let mut open: Option<String> = None;
        match defect.clone() {
            Defect::Closed => facts.state = PrState::Closed,
            Defect::Merged => facts.state = PrState::Merged,
            Defect::Draft => facts.draft = true,
            Defect::NoHead => facts.head = None,
            Defect::Conflict => facts.mergeability = Mergeability::Conflicting,
            Defect::Dirty => facts.merge_state = Some("DIRTY".into()),
            // A required check decides whatever else is listed.
            Defect::Red(status) => facts.checks.push(red_or_pending(status)),
            Defect::Pending => facts.checks.push(red_or_pending(CheckStatus::Pending)),
            Defect::OpenDecision(question) => open = Some(question),
        }
        let got = decide(&facts.read(), open.as_deref(), &allow);
        prop_assert!(matches!(got, Decision::Refuse(_)), "{:?} then {:?}", defect, got);
    }

    /// With nothing in the way, the word decides: the person's merges, nobody's asks, and the project's switch merges
    /// unless there are no checks at all (no checks is not green), which asks.
    #[test]
    fn prop_a_clear_pull_request_merges_only_with_the_word_that_allows_it(
        facts in calm(),
        allow in allow(),
    ) {
        let got = decide(&facts.read(), None, &allow);
        match (&allow, facts.checks.is_empty()) {
            (Allow::Person { by }, _) => {
                prop_assert_eq!(got, Decision::Merge { allowed_by: by.clone() });
            }
            (Allow::Switch, false) => prop_assert!(matches!(got, Decision::Merge { .. }), "{:?}", got),
            (Allow::Switch, true) | (Allow::Nobody, _) => {
                prop_assert!(matches!(got, Decision::Ask(_)), "{:?}", got);
            }
        }
    }

    /// `merge` runs `gh pr merge` only on the head it judged. A second read before the merge that shows another head, or
    /// any blocking fact, stops it; when it does run, the merge pins the first read's head.
    #[test]
    fn prop_merge_only_runs_on_the_head_it_judged(
        first in prop_oneof![3 => calm(), 1 => facts()],
        later in facts(),
        pick in 0u8..8,
        other in prop::sample::select(HEADS.to_vec()),
    ) {
        // Most second reads are the first again (maybe on another head), so the merge path is reached often.
        let second = match pick {
            0..=2 => first.clone(),
            3..=4 => Facts { head: Some(other.to_string()), ..first.clone() },
            _ => later,
        };
        let store = SessionStore::open_in_memory().unwrap();
        let gh = FakeGithub::new(vec![first.read(), second.read()]).steady();
        let request = MergeRequest {
            repo: "acme/web".into(),
            number: 7,
            caller: Caller::Person { via: "Inbox".into() },
            project: None,
            delegation_id: None,
            method: Method::Merge,
        };
        let outcome = merge(&store, &gh, request, 10).unwrap();
        let merges = gh.ran("pr", "merge");
        let should = !blocked(&first, None) && !blocked(&second, None) && first.head == second.head;
        prop_assert_eq!(merges.len(), usize::from(should), "{:?} / {:?} gave {:?}", first, second, outcome);
        if should {
            let judged = first.head.clone().unwrap();
            let at = merges[0].iter().position(|arg| arg == "--match-head-commit").expect("the merge pins a head");
            prop_assert_eq!(merges[0].get(at + 1), Some(&judged));
            prop_assert_eq!(
                outcome,
                MergeOutcome::Merged { head_sha: judged, allowed_by: "person (Inbox)".into() }
            );
        } else {
            prop_assert!(!matches!(outcome, MergeOutcome::Merged { .. }), "{:?}", outcome);
        }
    }

    /// An agent's merge runs only on a head the person approved, and only while the facts still allow it.
    #[test]
    fn prop_an_agent_merges_only_the_head_the_person_approved(
        facts in prop_oneof![3 => calm(), 1 => facts()],
        approved in prop::option::of(prop::sample::select(HEADS.to_vec())),
    ) {
        let store = SessionStore::open_in_memory().unwrap();
        if let Some(head) = approved {
            approve(&store.lock_conn().unwrap(), "Acme/Web", 7, head, "person", 5).unwrap();
        }
        let gh = FakeGithub::new(vec![facts.read()]).steady();
        let request = MergeRequest {
            repo: "acme/web".into(),
            number: 7,
            caller: Caller::Agent { session: "lead-1".into() },
            project: None,
            delegation_id: None,
            method: Method::Merge,
        };
        let outcome = merge(&store, &gh, request, 10).unwrap();
        let merges = gh.ran("pr", "merge");
        let allowed = approved.is_some() && facts.head.as_deref() == approved;
        let should = allowed && !blocked(&facts, None);
        prop_assert_eq!(merges.len(), usize::from(should), "{:?} approved {:?} gave {:?}", facts, approved, outcome);
        if should {
            prop_assert!(matches!(outcome, MergeOutcome::Merged { .. }), "{:?}", outcome);
        } else {
            prop_assert!(!matches!(outcome, MergeOutcome::Merged { .. }), "{:?}", outcome);
        }
    }
}
