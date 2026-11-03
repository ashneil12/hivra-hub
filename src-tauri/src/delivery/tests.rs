//! WP-12's proof: each mode against a fake remote (a local bare repository standing in for GitHub, and a stand-in
//! for `gh`), the merge refusals, and the teardown guard.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::deliver::{self, DeliverInput};
use super::events::{self, Kind, News};
use super::github::fake::FakeGithub;
use super::merge::{self, decide, Allow, Caller, Decision, MergeOutcome, MergeRequest, Method};
use super::settings::{self, Mode, Probe};
use super::teardown::{self, Safe};
use crate::delegations::{self, RecordInput};
use crate::pr_watch::eval::{Change, Check, CheckStatus, Detail, Mergeability};
use crate::pr_watch::github::{PrRead, PrState};
use crate::session_store::SessionStore;

// ---- fixtures ----------------------------------------------------------------------------------------------------------

struct Temp(PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp(tag: &str) -> Temp {
    let dir = std::env::temp_dir().join(format!("hivra-delivery-{tag}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    Temp(crate::fs::canonical(&dir).unwrap())
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .is_ok_and(|o| o.status.success())
}

/// A project whose `origin` is `https://github.com/acme/web.git`, rewritten (`insteadOf`) to a local bare repository,
/// and a worker's copy on branch `work` where `land.rs` expects it (`<parent>/<name>-worktrees/<copy>`).
struct Fixture {
    _temp: Temp,
    bare: PathBuf,
    project: PathBuf,
    copy: PathBuf,
}

fn fixture(tag: &str) -> Fixture {
    let temp = temp(tag);
    let bare = temp.0.join("remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "-q", "--bare", "-b", "main"]);
    let project = temp.0.join("web");
    std::fs::create_dir_all(&project).unwrap();
    git(&project, &["init", "-q", "-b", "main"]);
    git(&project, &["config", "user.name", "Test"]);
    git(&project, &["config", "user.email", "test@example.com"]);
    git(&project, &["remote", "add", "origin", "https://github.com/acme/web.git"]);
    let bare_url = format!("file://{}", bare.to_string_lossy().replace('\\', "/"));
    git(
        &project,
        &["config", &format!("url.{bare_url}.insteadOf"), "https://github.com/acme/web.git"],
    );
    std::fs::write(project.join("a.txt"), "one\n").unwrap();
    git(&project, &["add", "a.txt"]);
    git(&project, &["commit", "-qm", "start"]);
    git(&project, &["push", "-q", "origin", "main"]);
    git(&project, &["fetch", "-q", "origin"]);
    let copies = temp.0.join("web-worktrees");
    std::fs::create_dir_all(&copies).unwrap();
    let copy = copies.join("work");
    git(
        &project,
        &["worktree", "add", "-q", "-b", "work", copy.to_str().unwrap(), "main"],
    );
    let copy = crate::fs::canonical(&copy).unwrap();
    Fixture {
        _temp: temp,
        bare,
        project: crate::fs::canonical(&project).unwrap(),
        copy,
    }
}

fn commit(dir: &Path, file: &str, text: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-qm", &format!("change {file}")]);
    git(dir, &["rev-parse", "HEAD"])
}

fn check(name: &str, status: CheckStatus, required: bool) -> Check {
    Check {
        name: name.into(),
        status,
        url: Some(format!("https://github.com/acme/web/actions/runs/99/job/{name}")),
        required,
    }
}

fn pr(state: PrState, head: &str, checks: Vec<Check>) -> PrRead {
    PrRead {
        repo: "acme/web".into(),
        number: 7,
        url: "https://github.com/acme/web/pull/7".into(),
        title: "Fix the save bug".into(),
        state,
        draft: false,
        merge_sha: (state == PrState::Merged).then(|| "m3rg3".into()),
        merged_at: None,
        head_ref: "work".into(),
        base_ref: "main".into(),
        head_repo: Some("acme/web".into()),
        review_decision: None,
        detail: Detail {
            head_sha: Some(head.into()),
            checks,
            mergeability: Mergeability::Mergeable,
            viewer: Some("ash".into()),
            author: Some("ash".into()),
        },
        remarks: Some(Vec::new()),
        rate: None,
    }
}

fn green(head: &str) -> PrRead {
    pr(
        PrState::Open,
        head,
        vec![check("build", CheckStatus::Success, true), check("lint", CheckStatus::Success, true)],
    )
}

fn store() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn set_mode(store: &SessionStore, project: &Path, mode: Option<Mode>, yolo: bool) {
    settings::set(&*store.lock_conn().unwrap(), project.to_str().unwrap(), mode, yolo, 1).unwrap();
}

const REPORT: &str = "## Report\nSummary: Saving no longer drops the last line.\nFiles changed:\n- a.txt\nChecks:\n- npm test: passed (14 passed)\nEvidence:\n- commit abc123\nOpen questions:\n- none\n\nI think it works great now.";

// ---- settings ----------------------------------------------------------------------------------------------------------

#[test]
fn the_default_is_checked_pr_with_a_github_remote_and_gh_signed_in_otherwise_local() {
    let f = fixture("default");
    let mut gh = FakeGithub::new(vec![]);
    let probe = settings::probe(&f.project, &gh);
    assert_eq!(probe.github_repo.as_deref(), Some("acme/web"));
    assert_eq!(probe.remote.as_deref(), Some("origin"));
    assert_eq!(settings::default_mode(&probe), Mode::CheckedPr);

    gh.signed_in = false;
    let signed_out = settings::probe(&f.project, &gh);
    assert_eq!(settings::default_mode(&signed_out), Mode::Local);

    let no_remote = Probe::default();
    assert_eq!(settings::default_mode(&no_remote), Mode::Local);

    // A stored choice wins; "merge without asking" is off until switched on.
    let s = store();
    let stored = settings::get(&*s.lock_conn().unwrap(), f.project.to_str().unwrap()).unwrap();
    assert_eq!((stored.mode, stored.merge_without_asking), (None, false));
    let e = settings::effective(stored, &probe);
    assert_eq!((e.mode, e.defaulted, e.blocked.is_none()), (Mode::CheckedPr, true, true));
    set_mode(&s, &f.project, Some(Mode::Pr), true);
    let stored = settings::get(&*s.lock_conn().unwrap(), f.project.to_str().unwrap()).unwrap();
    assert_eq!((stored.mode, stored.merge_without_asking), (Some(Mode::Pr), true));
    // A PR mode with nothing to push to says why instead of pretending.
    let blocked = settings::effective(stored, &no_remote);
    assert!(blocked.blocked.unwrap().contains("no GitHub remote"));
}

// ---- local -------------------------------------------------------------------------------------------------------------

#[test]
fn local_lands_the_change_in_the_project_and_pushes_nothing() {
    let f = fixture("local");
    let s = store();
    set_mode(&s, &f.project, Some(Mode::Local), false);
    std::fs::write(f.copy.join("a.txt"), "two\n").unwrap();
    let gh = FakeGithub::new(vec![]);
    let d = deliver::deliver(
        &s,
        &gh,
        DeliverInput {
            project: f.project.to_string_lossy().into(),
            checkout: f.copy.to_string_lossy().into(),
            ..Default::default()
        },
        10,
    )
    .unwrap();
    assert_eq!((d.mode.as_str(), d.state.as_str()), ("local", deliver::LANDED));
    assert_eq!(std::fs::read_to_string(f.project.join("a.txt")).unwrap(), "two\n");
    assert!(!git_ok(&f.bare, &["rev-parse", "--verify", "refs/heads/work"]), "nothing is pushed");
    assert!(gh.ran("pr", "create").is_empty());
    assert_eq!(deliver::list(&*s.lock_conn().unwrap(), None).unwrap(), vec![d]);
}

// ---- PR and checked PR -------------------------------------------------------------------------------------------------

#[test]
fn pr_pushes_the_branch_and_opens_a_pull_request_with_the_brief_and_evidence() {
    let f = fixture("pr");
    let s = store();
    set_mode(&s, &f.project, Some(Mode::Pr), false);
    let head = commit(&f.copy, "a.txt", "two\n");
    let gh = FakeGithub::new(vec![]);
    let d = deliver::deliver(
        &s,
        &gh,
        DeliverInput {
            project: f.project.to_string_lossy().into(),
            checkout: f.copy.to_string_lossy().into(),
            title: Some("Fix the save bug".into()),
            brief: Some("Saving drops the last line. Fix it.".into()),
            report: Some(REPORT.into()),
            ..Default::default()
        },
        10,
    )
    .unwrap();
    assert_eq!(git(&f.bare, &["rev-parse", "refs/heads/work"]), head, "the branch is on the remote");
    let created = gh.ran("pr", "create");
    assert_eq!(created.len(), 1);
    let args = &created[0];
    let value = |flag: &str| args[args.iter().position(|a| a == flag).unwrap() + 1].clone();
    assert_eq!(value("--repo"), "acme/web");
    assert_eq!((value("--head"), value("--base")), ("work".into(), "main".into()));
    assert_eq!(value("--title"), "Fix the save bug");
    let body = gh.bodies.lock().unwrap()[0].clone();
    assert!(body.contains("## Brief\n\nSaving drops the last line. Fix it."), "{body}");
    assert!(body.contains("Saving no longer drops the last line."), "{body}");
    assert!(body.contains("- `npm test`: passed (14 passed)"), "{body}");
    assert!(body.contains("- commit abc123"), "{body}");
    // The worker's own opinion is kept apart and never presented as evidence.
    let opinion = body.find("not evidence").expect("the worker's own view is labelled");
    assert!(body.find("I think it works great now.").unwrap() > opinion, "{body}");
    assert_eq!(d.state, deliver::READY);
    assert_eq!((d.repo.as_deref(), d.number), (Some("acme/web"), Some(7)));
    assert_eq!(d.url.as_deref(), Some("https://github.com/acme/web/pull/7"));
    // Nothing went into the project's checkout.
    assert_eq!(std::fs::read_to_string(f.project.join("a.txt")).unwrap(), "one\n");
}

#[test]
fn a_pr_mode_refuses_uncommitted_work_and_records_nothing() {
    let f = fixture("dirty");
    let s = store();
    set_mode(&s, &f.project, Some(Mode::CheckedPr), false);
    commit(&f.copy, "a.txt", "two\n");
    std::fs::write(f.copy.join("b.txt"), "left over\n").unwrap();
    let gh = FakeGithub::new(vec![]);
    let input = DeliverInput {
        project: f.project.to_string_lossy().into(),
        checkout: f.copy.to_string_lossy().into(),
        ..Default::default()
    };
    let error = deliver::deliver(&s, &gh, input, 10).unwrap_err();
    assert!(error.contains("uncommitted"), "{error}");
    assert!(!git_ok(&f.bare, &["rev-parse", "--verify", "refs/heads/work"]));
    assert!(gh.ran("pr", "create").is_empty());
    assert!(deliver::list(&*s.lock_conn().unwrap(), None).unwrap().is_empty());

    // With nothing beyond its base there is nothing to deliver either.
    let g = fixture("empty");
    set_mode(&s, &g.project, Some(Mode::Pr), false);
    let input = DeliverInput {
        project: g.project.to_string_lossy().into(),
        checkout: g.copy.to_string_lossy().into(),
        ..Default::default()
    };
    assert!(deliver::deliver(&s, &gh, input, 10).unwrap_err().contains("nothing to deliver"));
    // A signed-out gh blocks a PR mode before anything is pushed.
    let mut signed_out = FakeGithub::new(vec![]);
    signed_out.signed_in = false;
    commit(&g.copy, "a.txt", "two\n");
    let input = DeliverInput {
        project: g.project.to_string_lossy().into(),
        checkout: g.copy.to_string_lossy().into(),
        ..Default::default()
    };
    assert!(deliver::deliver(&s, &signed_out, input, 10).unwrap_err().contains("gh isn't signed in"));
    assert!(!git_ok(&g.bare, &["rev-parse", "--verify", "refs/heads/work"]));
}

fn checked_delivery(s: &SessionStore, f: &Fixture) -> deliver::Delivery {
    set_mode(s, &f.project, Some(Mode::CheckedPr), false);
    commit(&f.copy, "a.txt", "two\n");
    let d = deliver::deliver(
        s,
        &FakeGithub::new(vec![]),
        DeliverInput {
            project: f.project.to_string_lossy().into(),
            checkout: f.copy.to_string_lossy().into(),
            ..Default::default()
        },
        10,
    )
    .unwrap();
    assert_eq!(d.state, deliver::CHECKING, "checked PR isn't ready until green");
    d
}

fn red_news() -> Vec<News> {
    vec![News {
        kind: Kind::CiRed,
        detail: Some("build".into()),
    }]
}

#[test]
fn checked_pr_is_ready_only_when_green_and_gets_one_fix_round_for_red() {
    let f = fixture("checked");
    let s = store();
    let d = checked_delivery(&s, &f);
    let conn = s.lock_conn().unwrap();
    let state = |conn: &rusqlite::Connection| deliver::get(conn, &d.id).unwrap().unwrap();

    // First red: one fix round.
    assert_eq!(events::record(&conn, "acme/web", 7, Some("h1"), &red_news(), 20).unwrap(), vec![d.id.clone()]);
    let now = state(&conn);
    assert_eq!((now.state.as_str(), now.fix_rounds), (deliver::FIXING, 1));
    assert!(now.detail.unwrap().contains("one fix round"));
    // Red again after the fix round: failed, and its first mate decides.
    events::record(&conn, "acme/web", 7, Some("h2"), &red_news(), 30).unwrap();
    assert_eq!(state(&conn).state, deliver::FAILED);
    // Every event is kept for WP-11's classifier, tied to the delivery.
    let open = events::open(&conn).unwrap();
    assert_eq!(open.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["ci-red", "ci-red"]);
    assert!(open.iter().all(|e| e.delivery_id.as_deref() == Some(d.id.as_str())));
    assert_eq!(events::consume(&conn, &[open[0].id], 40).unwrap(), 1);
    assert_eq!(events::open(&conn).unwrap().len(), 1);
    drop(conn);

    // A fix round that turns green is ready; the merge then settles it.
    let g = fixture("checked-green");
    let e = checked_delivery(&s, &g);
    let conn = s.lock_conn().unwrap();
    // `by_pr` is the newest delivery of acme/web#7: this one.
    events::record(&conn, "acme/web", 7, Some("h1"), &red_news(), 50).unwrap();
    let green = [News {
        kind: Kind::CiGreen,
        detail: None,
    }];
    events::record(&conn, "acme/web", 7, Some("h2"), &green, 60).unwrap();
    assert_eq!(deliver::get(&conn, &e.id).unwrap().unwrap().state, deliver::READY);
    let merged = [News {
        kind: Kind::Merged,
        detail: Some("m3rg3".into()),
    }];
    events::record(&conn, "acme/web", 7, Some("h2"), &merged, 70).unwrap();
    assert_eq!(deliver::get(&conn, &e.id).unwrap().unwrap().state, deliver::MERGED);
    // A merged delivery stays merged.
    events::record(&conn, "acme/web", 7, None, &[News { kind: Kind::Closed, detail: None }], 80).unwrap();
    assert_eq!(deliver::get(&conn, &e.id).unwrap().unwrap().state, deliver::MERGED);
}

#[test]
fn pr_watch_reads_classify_as_ci_red_green_merged_and_closed() {
    let red = check("build", CheckStatus::Failure, true);
    let news = events::classify(
        &green("h1"),
        Some(&[
            Change::ChecksFailed(vec![red]),
            Change::ChecksPassed { count: 2, required: true },
            Change::Conflicting,
        ]),
    );
    assert_eq!(news.iter().map(|n| n.kind).collect::<Vec<_>>(), vec![Kind::CiRed, Kind::CiGreen]);
    assert!(news[0].detail.as_deref().unwrap().contains("actions/runs/99"));
    assert_eq!(events::classify(&green("h1"), Some(&[])), vec![]);
    let merged = events::classify(&pr(PrState::Merged, "h1", vec![]), None);
    assert_eq!(merged, vec![News { kind: Kind::Merged, detail: Some("m3rg3".into()) }]);
    assert_eq!(events::classify(&pr(PrState::Closed, "h1", vec![]), None)[0].kind, Kind::Closed);
    assert_eq!(events::run_id("https://github.com/a/b/actions/runs/123/job/456"), Some("123"));
    assert_eq!(events::run_id("https://example.com/ci/1"), None);
}

#[test]
fn the_fix_round_carries_the_failing_log() {
    let read = pr(
        PrState::Open,
        "h1",
        vec![check("build", CheckStatus::Failure, true), check("lint", CheckStatus::Success, true)],
    );
    let gh = FakeGithub::new(vec![read]);
    let ask = events::fix_ask(&gh, "acme/web", 7).unwrap();
    assert!(ask.contains("### build"), "{ask}");
    assert!(ask.contains("expected 2, got 3"), "{ask}");
    assert!(!ask.contains("### lint"));
    let logs = gh.ran("run", "view");
    assert_eq!(logs[0][2], "99");
    assert!(logs[0].contains(&"--log-failed".to_string()));
}

// ---- the merge path ----------------------------------------------------------------------------------------------------

fn person() -> Allow {
    Allow::Person { by: "person (Inbox)".into() }
}

#[test]
fn decide_refuses_red_pending_drafts_conflicts_and_open_decisions() {
    let refused = |read: &PrRead, open: Option<&str>, allow: &Allow| match decide(read, open, allow) {
        Decision::Refuse(why) => why,
        other => panic!("expected a refusal, got {other:?}"),
    };
    let red = pr(PrState::Open, "h1", vec![check("build", CheckStatus::Failure, true)]);
    assert!(refused(&red, None, &person()).contains("Red is never merged"));
    assert!(refused(&red, None, &Allow::Switch).contains("Red is never merged"));
    let cancelled = pr(PrState::Open, "h1", vec![check("build", CheckStatus::Cancelled, false)]);
    assert!(refused(&cancelled, None, &person()).contains("failed"));
    let pending = pr(PrState::Open, "h1", vec![check("build", CheckStatus::Pending, true)]);
    assert!(refused(&pending, None, &person()).contains("still running"));
    let mut draft = green("h1");
    draft.draft = true;
    assert!(refused(&draft, None, &person()).contains("draft"));
    let mut conflict = green("h1");
    conflict.detail.mergeability = Mergeability::Conflicting;
    assert!(refused(&conflict, None, &person()).contains("conflicts"));
    assert!(refused(&pr(PrState::Merged, "h1", vec![]), None, &person()).contains("already merged"));
    assert!(refused(&pr(PrState::Closed, "h1", vec![]), None, &person()).contains("closed"));
    let open = refused(&green("h1"), Some("Keep the old API?"), &person());
    assert!(open.contains("Keep the old API?"), "{open}");

    // Green: the person's word merges, the switch merges, nobody's word asks.
    assert_eq!(
        decide(&green("h1"), None, &person()),
        Decision::Merge { allowed_by: "person (Inbox)".into() }
    );
    assert!(matches!(decide(&green("h1"), None, &Allow::Switch), Decision::Merge { .. }));
    assert!(matches!(decide(&green("h1"), None, &Allow::Nobody), Decision::Ask(_)));
    // Only the required checks decide when some are required (as the PR watch counts them).
    let optional_red = pr(
        PrState::Open,
        "h1",
        vec![check("build", CheckStatus::Success, true), check("flaky", CheckStatus::Failure, false)],
    );
    assert!(matches!(decide(&optional_red, None, &person()), Decision::Merge { .. }));
    // No checks is not green: the switch alone can't merge it.
    let unchecked = pr(PrState::Open, "h1", vec![]);
    assert!(matches!(decide(&unchecked, None, &Allow::Switch), Decision::Ask(_)));
    assert!(matches!(decide(&unchecked, None, &person()), Decision::Merge { .. }));
}

fn agent_merge(repo: &str) -> MergeRequest {
    MergeRequest {
        repo: repo.into(),
        number: 7,
        caller: Caller::Agent { session: "lead-1".into() },
        project: None,
        delegation_id: None,
        method: Method::Merge,
    }
}

#[test]
fn an_agent_merge_asks_the_person_and_merges_only_the_head_they_allowed() {
    let s = store();
    let gh = FakeGithub::new(vec![green("h1")]);
    let asked = merge::merge(&s, &gh, agent_merge("acme/web"), 10).unwrap();
    assert!(matches!(&asked, MergeOutcome::NeedsYou { head_sha, .. } if head_sha == "h1"), "{asked:?}");
    assert!(gh.ran("pr", "merge").is_empty(), "nothing merges without the person's word");

    // The person allows h1; a push since (h2) needs their word again.
    merge::approve(&*s.lock_conn().unwrap(), "Acme/Web", 7, "h1", "person", 20).unwrap();
    let moved = FakeGithub::new(vec![green("h2")]);
    assert!(matches!(
        merge::merge(&s, &moved, agent_merge("acme/web"), 30).unwrap(),
        MergeOutcome::NeedsYou { .. }
    ));
    assert!(moved.ran("pr", "merge").is_empty());

    let merged = merge::merge(&s, &gh, agent_merge("acme/web"), 40).unwrap();
    assert!(matches!(&merged, MergeOutcome::Merged { head_sha, allowed_by } if head_sha == "h1" && allowed_by.contains("person")));
    let calls = gh.ran("pr", "merge");
    assert_eq!(
        calls[0],
        ["pr", "merge", "7", "--repo", "acme/web", "--merge", "--match-head-commit", "h1"]
    );

    // Every attempt is logged, with who allowed the merge.
    let log = merge::log(&*s.lock_conn().unwrap(), "acme/web", 7).unwrap();
    assert_eq!(
        log.iter().map(|l| l.outcome.as_str()).collect::<Vec<_>>(),
        vec!["asked", "asked", "merged"]
    );
    assert_eq!(log[2].allowed_by.as_deref(), Some("person (approved this head)"));
    assert_eq!(log[2].caller, "agent lead-1");
}

#[test]
fn the_switch_merges_green_without_asking_and_never_red() {
    let f = fixture("yolo");
    let s = store();
    set_mode(&s, &f.project, Some(Mode::Pr), true);
    let mut request = agent_merge("acme/web");
    request.project = Some(f.project.to_string_lossy().into());

    let red = FakeGithub::new(vec![pr(PrState::Open, "h1", vec![check("build", CheckStatus::Failure, true)])]);
    let refused = merge::merge(&s, &red, request.clone(), 10).unwrap();
    assert!(matches!(&refused, MergeOutcome::Refused { reason } if reason.contains("Red is never merged")));
    assert!(red.ran("pr", "merge").is_empty());

    let gh = FakeGithub::new(vec![green("h1")]);
    let merged = merge::merge(&s, &gh, request, 20).unwrap();
    assert!(matches!(&merged, MergeOutcome::Merged { allowed_by, .. } if allowed_by.contains("merge without asking")));
    assert_eq!(gh.ran("pr", "merge").len(), 1);

    // Switched off again (the default), the same green pull request asks.
    set_mode(&s, &f.project, Some(Mode::Pr), false);
    let mut again = agent_merge("acme/web");
    again.project = Some(f.project.to_string_lossy().into());
    assert!(matches!(merge::merge(&s, &gh, again, 30).unwrap(), MergeOutcome::NeedsYou { .. }));
}

#[test]
fn an_open_question_on_the_work_blocks_even_the_persons_merge() {
    let s = store();
    let row = delegations::record(
        &mut s.lock_conn().unwrap(),
        RecordInput {
            owner_session: "lead-1".into(),
            request_id: "r1".into(),
            child_session: "worker-1".into(),
            title: Some("Fix the save bug".into()),
            brief: Some("Fix the save bug".into()),
            ..Default::default()
        },
        1,
    )
    .unwrap();
    delegations::set_question(
        &mut s.lock_conn().unwrap(),
        &row.id,
        Some("Keep the old file format?".into()),
        None,
        2,
    )
    .unwrap();
    let gh = FakeGithub::new(vec![green("h1")]);
    let request = MergeRequest {
        caller: Caller::Person { via: "Inbox".into() },
        delegation_id: Some(row.id.clone()),
        ..agent_merge("acme/web")
    };
    let refused = merge::merge(&s, &gh, request, 10).unwrap();
    assert!(
        matches!(&refused, MergeOutcome::Refused { reason } if reason.contains("Keep the old file format?")),
        "{refused:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn the_inbox_merge_button_goes_through_the_same_path() {
    let s = store();
    let red = FakeGithub::new(vec![pr(PrState::Open, "h1", vec![check("build", CheckStatus::Failure, true)])]);
    let error = merge::by_person(&s, &red, "acme/web", 7, Method::Squash, "Inbox", 10).unwrap_err();
    assert!(error.contains("Red is never merged"), "{error}");
    assert!(red.ran("pr", "merge").is_empty());
    let gh = FakeGithub::new(vec![green("h1")]);
    merge::by_person(&s, &gh, "acme/web", 7, Method::Squash, "Inbox", 20).unwrap();
    assert!(gh.ran("pr", "merge")[0].contains(&"--squash".to_string()));
    let log = merge::log(&*s.lock_conn().unwrap(), "acme/web", 7).unwrap();
    assert_eq!(log[1].allowed_by.as_deref(), Some("person (Inbox)"));
    assert_eq!(Method::from_action("close"), None);
}

// ---- teardown ----------------------------------------------------------------------------------------------------------

#[test]
fn teardown_keeps_a_copy_whose_work_has_not_landed_or_merged() {
    let f = fixture("teardown");
    // Committed but not in the project: kept.
    commit(&f.copy, "a.txt", "two\n");
    let kept = teardown::guard(&f.project, &f.copy).unwrap_err();
    assert!(kept.contains("hasn't landed"), "{kept}");
    // Uncommitted on top: still kept.
    std::fs::write(f.copy.join("b.txt"), "more\n").unwrap();
    assert!(teardown::guard(&f.project, &f.copy).is_err());
    // Landed (as land.rs does it, uncommitted in the project): it may go.
    assert_eq!(crate::land::land(&f.copy, &f.project).unwrap().outcome, "landed");
    assert_eq!(teardown::guard(&f.project, &f.copy).unwrap(), Safe::Landed);
    // The project changes the same lines afterwards: the work is no longer all there, so it is kept again.
    std::fs::write(f.project.join("a.txt"), "three\n").unwrap();
    assert!(teardown::guard(&f.project, &f.copy).is_err());

    // Merged and clean: it may go. A folder already gone: nothing to lose.
    let g = fixture("teardown-merged");
    commit(&g.copy, "a.txt", "two\n");
    git(&g.project, &["merge", "-q", "--ff-only", "work"]);
    assert_eq!(teardown::guard(&g.project, &g.copy).unwrap(), Safe::Merged);
    assert_eq!(teardown::guard(&g.project, &g.project.join("gone")).unwrap(), Safe::Missing);
}

#[test]
fn the_janitor_never_offers_to_remove_a_landed_but_unmerged_copy() {
    use crate::worktree_janitor::{gather, verdict, Context, Kind as TreeKind, Outcome, Policy};
    let f = fixture("janitor");
    commit(&f.copy, "a.txt", "two\n");
    assert_eq!(crate::land::land(&f.copy, &f.project).unwrap().outcome, "landed");
    let facts = gather(&f.copy, TreeKind::Linked, &Context::default());
    let week_later = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 7 * 24 * 3_600_000;
    let v = verdict(&facts, &Policy::default(), week_later);
    assert_ne!(v.outcome, Outcome::Remove, "{v:?}");
    // Once its branch is merged, the janitor may offer it (and the guard agrees).
    git(&f.project, &["checkout", "-q", "--", "a.txt"]);
    git(&f.project, &["merge", "-q", "--ff-only", "work"]);
    assert_eq!(teardown::guard(&f.project, &f.copy).unwrap(), Safe::Merged);
}
