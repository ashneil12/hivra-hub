//! SC-6 (spec 4i): property tests for the merge gate's base check (`hold`).
//!
//! The rule that must always hold: an unknown or failed answer about main never lets a merge through (it holds), and
//! main changing a file the pull request touches always holds. GitHub's three answers (the merge base, the compare of
//! what main changed, the pull request's own files) are drawn as typed facts, rendered into the REST bodies `hold` reads,
//! and `hold`'s answer is checked against the rule written out on its own.

use std::cell::RefCell;

use proptest::prelude::*;
use serde_json::{json, Value};

use super::{hold, COMPARE_FILE_CAP, PULL_FILES_PAGE};
use crate::pr_watch::eval::{Detail, Mergeability};
use crate::pr_watch::github::{PrRead, PrState};

/// 64 cases a run, or whatever `PROPTEST_CASES` says (an explicit `cases` would override the variable).
fn config() -> ProptestConfig {
    let mut config = ProptestConfig::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = 64;
    }
    config
}

const HEAD: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const BASE: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const OLDER: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

/// A few files shared by every list so they overlap often: spaces, unicode, a Windows-looking name, a doubled slash and
/// two names that differ only in case (git paths are case-sensitive, so those are different files).
const POOL: [&str; 10] = [
    "src/lib.rs",
    "src/main.rs",
    "README.md",
    "docs/with space.md",
    "src/日本語.rs",
    "Cargo.toml",
    "a\\b\\c.rs",
    "dir//double.rs",
    "UPPER.RS",
    "upper.rs",
];

/// One entry of a GitHub file list: its name, and the name it had before when it was renamed.
#[derive(Clone, Debug)]
struct Entry {
    name: String,
    previous: Option<String>,
}

impl Entry {
    /// Every name the entry puts on the list: a rename lists both.
    fn names(&self) -> Vec<&str> {
        let mut names = vec![self.name.as_str()];
        if let Some(previous) = self
            .previous
            .as_deref()
            .filter(|p| !p.is_empty() && *p != self.name)
        {
            names.push(previous);
        }
        names
    }

    fn json(&self) -> Value {
        match &self.previous {
            Some(previous) => json!({ "filename": self.name, "previous_filename": previous }),
            None => json!({ "filename": self.name }),
        }
    }
}

fn entry() -> impl Strategy<Value = Entry> {
    (
        prop::sample::select(POOL.to_vec()),
        prop::option::weighted(0.2, prop::sample::select(POOL.to_vec())),
    )
        .prop_map(|(name, previous)| Entry {
            name: name.to_string(),
            previous: previous.map(str::to_string),
        })
}

fn entries(max: usize) -> impl Strategy<Value = Vec<Entry>> {
    prop::collection::vec(entry(), 0..max)
}

/// What GitHub said about the merge base of main and the head.
#[derive(Clone, Debug)]
enum MergeBase {
    Fail(String),
    /// A body that does not say a merge base: not JSON, no field, an id that is not a commit id.
    Garbage(String),
    Took(String),
}

/// What GitHub said main changed since the branch last took it.
#[derive(Clone, Debug)]
enum Moved {
    Fail(String),
    Garbage(String),
    Diverged,
    Behind,
    /// Listed. `filler` pads the list to GitHub's cap, which may be a short view of what changed.
    Listed {
        files: Vec<Entry>,
        filler: usize,
    },
}

/// What GitHub said the pull request itself changed.
#[derive(Clone, Debug)]
enum Own {
    Fail(String),
    Garbage(String),
    /// `short` is how many files GitHub claims beyond the ones it listed.
    Listed {
        files: Vec<Entry>,
        short: u64,
        claim: bool,
    },
}

#[derive(Clone, Debug)]
struct Scenario {
    base: Option<String>,
    merge_base: MergeBase,
    moved: Moved,
    own: Own,
}

fn error_text() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("HTTP 502".to_string()),
        Just(String::new()),
        any::<String>()
    ]
}

/// Bodies that are not what was asked for, in every way GitHub or a proxy can get that wrong.
fn garbage() -> impl Strategy<Value = String> {
    prop::sample::select(vec![
        "",
        "not json",
        "<html>502 Bad Gateway</html>",
        "{}",
        "null",
        // Not "[]": an empty list is a real answer for the pull request's files (no files).
        "[null]",
        "{\"message\":\"Not Found\"}",
        "{\"files\":5}",
        "{\"files\":[{}]}",
        "[{}]",
        "[1]",
        "{\"merge_base_commit\":{}}",
        "{\"merge_base_commit\":{\"sha\":\"zzzzzzz\"}}",
        "{\"merge_base_commit\":{\"sha\":\"abc\"}}",
    ])
    .prop_map(str::to_string)
}

fn sha() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(BASE.to_string()),
        Just(OLDER.to_string()),
        "[0-9a-f]{7,64}",
    ]
}

fn merge_base() -> impl Strategy<Value = MergeBase> {
    prop_oneof![
        1 => error_text().prop_map(MergeBase::Fail),
        2 => garbage().prop_map(MergeBase::Garbage),
        1 => Just(MergeBase::Took(BASE.to_string())),
        4 => sha().prop_map(MergeBase::Took),
    ]
}

fn moved() -> impl Strategy<Value = Moved> {
    prop_oneof![
        1 => error_text().prop_map(Moved::Fail),
        2 => garbage().prop_map(Moved::Garbage),
        1 => Just(Moved::Diverged),
        1 => Just(Moved::Behind),
        6 => (entries(8), prop_oneof![9 => Just(0usize), 1 => Just(COMPARE_FILE_CAP)])
            .prop_map(|(files, cap)| Moved::Listed {
                filler: cap.saturating_sub(files.len()),
                files,
            }),
    ]
}

fn own() -> impl Strategy<Value = Own> {
    prop_oneof![
        1 => error_text().prop_map(Own::Fail),
        2 => garbage().prop_map(Own::Garbage),
        // Up to a few pages, so paging and the "GitHub says more than it listed" case are both reached.
        6 => (
            prop_oneof![8 => entries(10), 1 => prop::collection::vec(entry(), PULL_FILES_PAGE..PULL_FILES_PAGE * 2 + 3)],
            prop_oneof![5 => Just(0u64), 2 => 1u64..4],
            prop::bool::ANY,
        )
            .prop_map(|(files, short, claim)| Own::Listed { files, short, claim }),
    ]
}

fn scenario() -> impl Strategy<Value = Scenario> {
    (
        prop_oneof![
            12 => Just(Some(BASE.to_string())),
            1 => Just(None),
            1 => Just(Some("not a commit id".to_string())),
        ],
        merge_base(),
        moved(),
        own(),
    )
        .prop_map(|(base, merge_base, moved, own)| Scenario {
            base,
            merge_base,
            moved,
            own,
        })
}

impl Scenario {
    fn read(&self) -> PrRead {
        PrRead {
            repo: "acme/web".into(),
            number: 7,
            url: String::new(),
            title: "Fix".into(),
            state: PrState::Open,
            draft: false,
            merge_sha: None,
            merged_at: None,
            head_ref: "work".into(),
            base_ref: "main".into(),
            base_tip: self.base.clone(),
            head_repo: Some("acme/web".into()),
            review_decision: None,
            labels: Vec::new(),
            detail: Detail {
                head_sha: Some(HEAD.into()),
                checks: Vec::new(),
                mergeability: Mergeability::Mergeable,
                viewer: None,
                author: None,
            },
            remarks: Some(Vec::new()),
            rate: None,
            merge_state: None,
            changed_files: match &self.own {
                Own::Listed {
                    files,
                    short,
                    claim: true,
                } => Some(files.len() as u64 + short),
                _ => None,
            },
        }
    }

    /// GitHub's REST answer for a path `hold` asks, or the failure. Every path asked is recorded.
    fn serve(&self, path: &str, asked: &RefCell<Vec<String>>) -> Result<String, String> {
        asked.borrow_mut().push(path.to_string());
        if path.contains("/pulls/") {
            return match &self.own {
                Own::Fail(error) => Err(error.clone()),
                Own::Garbage(body) => Ok(body.clone()),
                Own::Listed { files, .. } => {
                    let page: usize = path
                        .rsplit("&page=")
                        .next()
                        .and_then(|n| n.parse().ok())
                        .expect("a page number");
                    let from = ((page - 1) * PULL_FILES_PAGE).min(files.len());
                    let to = (page * PULL_FILES_PAGE).min(files.len());
                    Ok(Value::Array(files[from..to].iter().map(Entry::json).collect()).to_string())
                }
            };
        }
        // The merge base is the one compare with a query (`?per_page=1`); the pull request's file pages were answered above.
        if path.ends_with("?per_page=1") {
            return match &self.merge_base {
                MergeBase::Fail(error) => Err(error.clone()),
                MergeBase::Garbage(body) => Ok(body.clone()),
                MergeBase::Took(sha) => {
                    Ok(json!({ "merge_base_commit": { "sha": sha }, "files": [] }).to_string())
                }
            };
        }
        match &self.moved {
            Moved::Fail(error) => Err(error.clone()),
            Moved::Garbage(body) => Ok(body.clone()),
            Moved::Diverged => {
                Ok(json!({ "status": "diverged", "ahead_by": 1, "files": [] }).to_string())
            }
            Moved::Behind => {
                Ok(json!({ "status": "behind", "ahead_by": 0, "files": [] }).to_string())
            }
            Moved::Listed { files, filler } => {
                let mut listed: Vec<Value> = files.iter().map(Entry::json).collect();
                listed.extend((0..*filler).map(|n| json!({ "filename": format!("filler/{n}") })));
                Ok(json!({ "status": "ahead", "ahead_by": 1, "files": listed }).to_string())
            }
        }
    }

    /// Whether the pull request's own list is known to be short of what GitHub says it changed.
    fn own_cut(&self) -> bool {
        matches!(&self.own, Own::Listed { short, claim: true, .. } if *short > 0)
    }

    /// The rule, written out on its own: does the merge hold?
    fn should_hold(&self) -> bool {
        let Some(base) = self.base.as_deref().filter(|b| is_hex_sha(b)) else {
            return true;
        };
        let took = match &self.merge_base {
            MergeBase::Took(sha) if is_hex_sha(sha) => sha,
            // A failed read, or a body that names no commit: unknown.
            _ => return true,
        };
        if took == base {
            // The branch already has main: nothing to ask, nothing to hold.
            return false;
        }
        let (files, filler) = match &self.moved {
            Moved::Listed { files, filler } => (files, *filler),
            // Failed read, garbage, a rewritten main, main behind where the branch took it: unknown.
            _ => return true,
        };
        let Own::Listed { files: own, .. } = &self.own else {
            return true;
        };
        let moved_names: Vec<&str> = files.iter().flat_map(Entry::names).collect();
        let own_names: Vec<&str> = own.iter().flat_map(Entry::names).collect();
        let touches = moved_names.iter().any(|name| own_names.contains(name));
        let main_cut = files.len() + filler >= COMPARE_FILE_CAP;
        touches || main_cut || self.own_cut()
    }
}

fn is_hex_sha(text: &str) -> bool {
    (7..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

fn run(scenario: &Scenario) -> (Option<String>, Vec<String>) {
    let asked = RefCell::new(Vec::new());
    let get = |path: &str| scenario.serve(path, &asked);
    let got = hold(&get, "acme/web", 7, HEAD, &scenario.read());
    (got, asked.into_inner())
}

proptest! {
    #![proptest_config(config())]

    /// An unknown or failed answer never lets a merge through: whichever one of the base, the merge base, main's changes
    /// or the pull request's files is missing, unreadable or a rewrite of main, with everything else reading fine, the
    /// merge holds.
    #[test]
    fn prop_an_unknown_or_failed_answer_never_lets_a_merge_through(
        which in 0u8..6,
        files in entries(6),
        error in error_text(),
        garbage in garbage(),
    ) {
        // Everything reads fine, and main has moved over a file the pull request does not touch (the pool never names it).
        let mut s = Scenario {
            base: Some(BASE.to_string()),
            merge_base: MergeBase::Took(OLDER.to_string()),
            moved: Moved::Listed {
                files: vec![Entry { name: "elsewhere/only.txt".into(), previous: None }],
                filler: 0,
            },
            own: Own::Listed { files, short: 0, claim: false },
        };
        let (clear, _) = run(&s);
        prop_assert_eq!(clear, None, "the control must not hold: {:?}", s);
        match which {
            0 => s.base = None,
            1 => s.merge_base = MergeBase::Fail(error),
            2 => s.merge_base = MergeBase::Garbage(garbage),
            3 => s.moved = if garbage.len() % 2 == 0 { Moved::Fail(error) } else { Moved::Garbage(garbage) },
            4 => s.moved = if error.len() % 2 == 0 { Moved::Diverged } else { Moved::Behind },
            _ => s.own = if garbage.len() % 2 == 0 { Own::Fail(error) } else { Own::Garbage(garbage) },
        }
        let (got, _) = run(&s);
        prop_assert!(got.is_some(), "an unknown answer merged: {:?}", s);
    }

    /// Main changing a file the pull request touches always holds, and the hold names the file. A rename counts under
    /// both of its names.
    #[test]
    fn prop_main_changing_a_file_the_pull_request_touches_always_holds(
        mut moved_files in entries(6),
        mut own_files in entries(6),
        shared in entry(),
        pull_has_old_name in prop::bool::ANY,
    ) {
        // Put one file on both lists. A rename's old name on the pull request's side counts too.
        moved_files.push(shared.clone());
        own_files.push(if pull_has_old_name {
            Entry { name: shared.name.clone(), previous: None }
        } else {
            shared.clone()
        });
        let s = Scenario {
            base: Some(BASE.to_string()),
            merge_base: MergeBase::Took(OLDER.to_string()),
            moved: Moved::Listed { files: moved_files, filler: 0 },
            own: Own::Listed { files: own_files, short: 0, claim: false },
        };
        let (got, _) = run(&s);
        prop_assert!(got.is_some(), "main changed a file the pull request touches, so it must hold: {:?}", s);
        let reason = got.unwrap_or_default();
        prop_assert!(reason.contains(&shared.name), "the hold names {:?}: {}", shared.name, reason);
    }

    /// A branch that already has main holds nothing, whatever else is unreadable; and a move that misses the pull
    /// request's files holds nothing.
    #[test]
    fn prop_a_branch_with_main_or_a_move_that_misses_it_never_holds(
        mut s in scenario(),
        misses in entries(6),
        own_files in entries(6),
    ) {
        // The branch has main: every later answer can be garbage.
        s.base = Some(BASE.to_string());
        s.merge_base = MergeBase::Took(BASE.to_string());
        let (got, asked) = run(&s);
        prop_assert_eq!(got, None);
        prop_assert_eq!(asked.len(), 1, "only the merge base is read: {:?}", asked);

        // Main moved over files outside the pull request's own: nothing to hold.
        let own_names: Vec<String> = own_files.iter().flat_map(|e| e.names().into_iter().map(str::to_string)).collect();
        let misses: Vec<Entry> = misses
            .into_iter()
            .filter(|e| e.names().iter().all(|n| !own_names.iter().any(|o| o == n)))
            .collect();
        let s = Scenario {
            base: Some(BASE.to_string()),
            merge_base: MergeBase::Took(OLDER.to_string()),
            moved: Moved::Listed { files: misses, filler: 0 },
            own: Own::Listed { files: own_files, short: 0, claim: false },
        };
        let (got, _) = run(&s);
        prop_assert_eq!(got, None, "a move that misses the pull request held: {:?}", s);
    }

    /// Over every mix of answers the hold is exactly the rule: it holds on an unknown, a touched file or a short list,
    /// and holds nothing otherwise. It never panics on what a proxy sends.
    #[test]
    fn prop_hold_matches_the_rule_for_every_mix_of_answers(scenario in scenario()) {
        let (got, _) = run(&scenario);
        prop_assert_eq!(got.is_some(), scenario.should_hold(), "{:?} gave {:?}", scenario, got);
    }

    /// A commit id that is not a commit id never reaches a request path, and holds: a head or base with a slash, a
    /// `..`, a query or a newline cannot steer the read.
    #[test]
    fn prop_a_commit_id_that_is_not_hex_never_reaches_a_request_path(
        head in prop_oneof![
            any::<String>(),
            Just("../../etc/passwd".to_string()),
            Just(format!("{HEAD}?x=1")),
            Just(format!("{HEAD}\n")),
            Just(String::new()),
            Just("a1a1a1".to_string()),
        ],
        scenario in scenario(),
    ) {
        prop_assume!(!is_hex_sha(&head));
        let asked = RefCell::new(Vec::new());
        let get = |path: &str| scenario.serve(path, &asked);
        let got = hold(&get, "acme/web", 7, &head, &scenario.read());
        prop_assert!(got.is_some(), "a head that is not a commit id merged");
        prop_assert!(asked.borrow().is_empty(), "a request went out for {:?}: {:?}", head, asked.borrow());
    }
}
