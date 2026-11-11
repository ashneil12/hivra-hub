//! WP-12's proof: each mode against a fake remote (a local bare repository standing in for GitHub, and a stand-in
//! for `gh`), the merge refusals, and the teardown guard.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::deliver::{self, DeliverInput};
use super::events::{self, Kind, News};
use super::github::fake::FakeGithub;
use super::github::Github;
use super::merge::{
    self, decide, floor_decision, Allow, Caller, Decision, MergeOutcome, MergeRequest, Method,
};
use super::protected::{shared_list, ChangedFiles};
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
    let dir = std::env::temp_dir().join(format!(
        "hivra-delivery-{tag}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    Temp(crate::fs::canonical(&dir).unwrap())
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
        ])
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
    git(&project, &["config", "core.autocrlf", "false"]);
    git(&project, &["config", "user.name", "Test"]);
    git(&project, &["config", "user.email", "test@example.com"]);
    git(
        &project,
        &["remote", "add", "origin", "https://github.com/acme/web.git"],
    );
    let bare_url = format!("file://{}", bare.to_string_lossy().replace('\\', "/"));
    git(
        &project,
        &[
            "config",
            &format!("url.{bare_url}.insteadOf"),
            "https://github.com/acme/web.git",
        ],
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
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "work",
            copy.to_str().unwrap(),
            "main",
        ],
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
        url: Some(format!(
            "https://github.com/acme/web/actions/runs/99/job/{name}"
        )),
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
        base_tip: Some("ba5e".repeat(10)),
        head_repo: Some("acme/web".into()),
        review_decision: None,
        labels: Vec::new(),
        detail: Detail {
            head_sha: Some(head.into()),
            checks,
            mergeability: Mergeability::Mergeable,
            viewer: Some("ash".into()),
            author: Some("ash".into()),
        },
        remarks: Some(Vec::new()),
        rate: None,
        changed_files: None,
    }
}

fn green(head: &str) -> PrRead {
    pr(
        PrState::Open,
        head,
        vec![
            check("build", CheckStatus::Success, true),
            check("lint", CheckStatus::Success, true),
        ],
    )
}

fn store() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

/// Rows still inside the test clock. The real clock would treat a test's `now` of 10 as years ago.
fn activity_at(store: &SessionStore, now: i64) -> Vec<crate::activity::Entry> {
    let conn = store.lock_conn().unwrap();
    crate::activity::list(
        &conn,
        &crate::activity::ListQuery {
            limit: Some(50),
            ..Default::default()
        },
        now,
    )
    .unwrap()
    .entries
}

fn set_mode(store: &SessionStore, project: &Path, mode: Option<Mode>, yolo: bool) {
    let conn = store.lock_conn().unwrap();
    let current = settings::get(&conn, project.to_str().unwrap()).unwrap();
    settings::set(
        &conn,
        project.to_str().unwrap(),
        mode,
        yolo,
        current.updated_at,
        current.updated_at.unwrap_or(0) + 1,
    )
    .unwrap();
}

const REPORT: &str = "\
## Report
Summary: Saving no longer drops the last line.
Files changed:
- a.txt
Checks:
- npm test: passed (14 passed)
Evidence:
- commit abc1234
Open questions:
- none

## Self-review
I think it works great now.
";

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

    // The same folder is one key, including ".." and a path that isn't there yet.
    let via_dot = f.project.join("..").join(f.project.file_name().unwrap());
    assert_eq!(
        settings::key(f.project.to_str().unwrap()),
        settings::key(via_dot.to_str().unwrap())
    );
    assert_eq!(
        settings::key("/no/such/hivra-wp12/../place"),
        settings::key("/no/such/place")
    );
    assert_eq!(
        settings::key("/no/such/hivra-wp12/foo/../../bar"),
        settings::key("/no/such/bar")
    );
    assert_eq!(
        settings::key("/../../no/such/hivra-wp12"),
        settings::key("/no/such/hivra-wp12")
    );
    // A space or a non-ascii name is part of the key, and `..` still folds.
    assert_eq!(
        settings::key("/no/such/My Project/../café"),
        settings::key("/no/such/café")
    );
    assert_eq!(
        settings::key("/no/such/hivra-wp12/"),
        settings::key("/no/such/hivra-wp12")
    );
    // A `..` that leaves a relative path is not thrown away, so it does not collide with a bare name.
    assert_ne!(
        settings::key("hivra-wp12-not-a-folder/../../../hivra-wp12-escaped-key"),
        settings::key("hivra-wp12-escaped-key")
    );
    #[cfg(windows)]
    assert_eq!(
        settings::key(r"C:\no\such\hivra-wp12\..\place"),
        settings::key(r"C:\no\such\place")
    );

    // A stored choice wins; "merge without asking" is off until switched on.
    let s = store();
    let stored = settings::get(&s.lock_conn().unwrap(), f.project.to_str().unwrap()).unwrap();
    assert_eq!(
        (stored.mode, stored.merge_without_asking, stored.updated_at),
        (None, false, None)
    );
    let e = settings::effective(stored, &probe);
    assert_eq!(
        (e.mode, e.defaulted, e.blocked.is_none()),
        (Mode::CheckedPr, true, true)
    );
    set_mode(&s, &f.project, Some(Mode::Pr), true);
    let stored = settings::get(&s.lock_conn().unwrap(), f.project.to_str().unwrap()).unwrap();
    assert_eq!(
        (stored.mode, stored.merge_without_asking),
        (Some(Mode::Pr), true)
    );
    // A PR mode with nothing to push to says why instead of pretending.
    let blocked = settings::effective(stored, &no_remote);
    assert!(blocked.blocked.unwrap().contains("no GitHub remote"));
}

#[test]
fn a_stale_settings_write_does_not_overwrite_a_newer_choice() {
    let s = store();
    let project = "/no/such/hivra-wp12-settings";
    let conn = s.lock_conn().unwrap();
    let first = settings::set(&conn, project, Some(Mode::Local), false, None, 10).unwrap();
    assert_eq!(first.updated_at, Some(10));
    let stale = settings::set(&conn, project, Some(Mode::Pr), true, None, 11).unwrap_err();
    assert!(stale.contains("another window"), "{stale}");
    let wrong = settings::set(&conn, project, Some(Mode::Pr), true, Some(9), 12).unwrap_err();
    assert!(wrong.contains("another window"), "{wrong}");
    let kept = settings::get(&conn, project).unwrap();
    assert_eq!(
        (kept.mode, kept.merge_without_asking, kept.updated_at),
        (Some(Mode::Local), false, Some(10))
    );
    let fresh = settings::set(&conn, project, Some(Mode::Pr), true, Some(10), 13).unwrap();
    assert_eq!(
        (fresh.mode, fresh.merge_without_asking, fresh.updated_at),
        (Some(Mode::Pr), true, Some(13))
    );

    // The same folder, named with a space and "..", is one row. A real directory, so the canonical path is the key.
    let root = Temp(std::env::temp_dir().join(format!("hivra-wp12-key-{}", std::process::id())));
    let dir = root.0.join("My Project").join("café");
    std::fs::create_dir_all(&dir).unwrap();
    // `café/../café` exists, so this goes through the canonical path, not the lexical fallback.
    let via = dir.join("..").join("café");
    assert_eq!(
        settings::key(dir.to_str().unwrap()),
        settings::key(via.to_str().unwrap())
    );
}

#[test]
#[cfg(unix)]
fn a_git_child_does_not_inherit_the_process_environment() {
    let out = super::child("sh")
        .args(["-c", "printf '%s' \"$CARGO_MANIFEST_DIR\""])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.stdout.is_empty(),
        "a cargo variable reached git's environment: {}",
        String::from_utf8_lossy(&out.stdout)
    );
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
    assert_eq!(
        (d.mode.as_str(), d.state.as_str()),
        ("local", deliver::LANDED)
    );
    assert_eq!(
        std::fs::read_to_string(f.project.join("a.txt")).unwrap(),
        "two\n"
    );
    assert!(
        !git_ok(&f.bare, &["rev-parse", "--verify", "refs/heads/work"]),
        "nothing is pushed"
    );
    assert!(gh.ran("pr", "create").is_empty());
    assert_eq!(
        deliver::list(&s.lock_conn().unwrap(), None).unwrap(),
        vec![d]
    );
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
    assert_eq!(
        git(&f.bare, &["rev-parse", "refs/heads/work"]),
        head,
        "the branch is on the remote"
    );
    let created = gh.ran("pr", "create");
    assert_eq!(created.len(), 1);
    let args = &created[0];
    let value = |flag: &str| args[args.iter().position(|a| a == flag).unwrap() + 1].clone();
    assert_eq!(value("--repo"), "acme/web");
    assert_eq!(
        (value("--head"), value("--base")),
        ("work".into(), "main".into())
    );
    assert_eq!(value("--title"), "Fix the save bug");
    let body = gh.bodies.lock().unwrap()[0].clone();
    assert!(
        body.contains("## Brief\n\nSaving drops the last line. Fix it."),
        "{body}"
    );
    assert!(
        body.contains("Saving no longer drops the last line."),
        "{body}"
    );
    assert!(body.contains("- `npm test`: passed (14 passed)"), "{body}");
    assert!(body.contains("- commit abc1234"), "{body}");
    // The worker's own opinion is kept apart and never presented as evidence.
    let opinion = body
        .find("not evidence")
        .expect("the worker's own view is labelled");
    assert!(
        body.find("I think it works great now.").unwrap() > opinion,
        "{body}"
    );
    assert_eq!(d.state, deliver::READY);
    assert_eq!((d.repo.as_deref(), d.number), (Some("acme/web"), Some(7)));
    assert_eq!(d.url.as_deref(), Some("https://github.com/acme/web/pull/7"));
    // Nothing went into the project's checkout.
    assert_eq!(
        std::fs::read_to_string(f.project.join("a.txt")).unwrap(),
        "one\n"
    );
    let rows = activity_at(&s, 10);
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(
        rows.iter()
            .filter(|row| row.kind == crate::activity::PUSH)
            .count(),
        1
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.kind == crate::activity::PULL_REQUEST)
            .count(),
        1
    );
    assert!(rows
        .iter()
        .all(|row| row.actor == crate::activity::Who::app()));
    assert!(rows
        .iter()
        .all(|row| row.initiator == crate::activity::Who::person()));
    assert!(rows
        .iter()
        .all(|row| !row.summary.contains("Saving drops") && !row.summary.contains("Brief")));
}

#[test]
fn a_delegated_push_names_the_worker_and_keeps_the_brief_out() {
    let f = fixture("worker-pr");
    let s = store();
    set_mode(&s, &f.project, Some(Mode::Pr), false);
    let id = {
        let mut conn = s.lock_conn().unwrap();
        task(&mut conn, "lead-1", "r-worker", "worker-9")
    };
    commit(&f.copy, "a.txt", "two\n");
    let gh = FakeGithub::new(vec![]);
    let planted = "ghp_PLANTED0123456789abcdefghijklmnopqrstu";
    deliver::deliver(
        &s,
        &gh,
        DeliverInput {
            project: f.project.to_string_lossy().into(),
            checkout: f.copy.to_string_lossy().into(),
            delegation_id: Some(id),
            brief: Some(format!("Saving drops the last line. {planted}")),
            ..Default::default()
        },
        10,
    )
    .unwrap();
    let rows = activity_at(&s, 10);
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(rows
        .iter()
        .all(|row| row.actor == crate::activity::Who::worker("worker-9", "")));
    assert!(rows
        .iter()
        .all(|row| row.initiator == crate::activity::Who::person()));
    let pushed = rows
        .iter()
        .find(|row| row.kind == crate::activity::PUSH)
        .unwrap();
    assert_eq!(pushed.summary, "Pushed work.");
    assert!(rows.iter().all(|row| !format!("{row:?}").contains(planted)));
    assert!(rows.iter().all(|row| !row.summary.contains("Saving drops")));
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
    assert!(!git_ok(
        &f.bare,
        &["rev-parse", "--verify", "refs/heads/work"]
    ));
    assert!(gh.ran("pr", "create").is_empty());
    assert!(deliver::list(&s.lock_conn().unwrap(), None)
        .unwrap()
        .is_empty());

    // With nothing beyond its base there is nothing to deliver either.
    let g = fixture("empty");
    set_mode(&s, &g.project, Some(Mode::Pr), false);
    let input = DeliverInput {
        project: g.project.to_string_lossy().into(),
        checkout: g.copy.to_string_lossy().into(),
        ..Default::default()
    };
    assert!(deliver::deliver(&s, &gh, input, 10)
        .unwrap_err()
        .contains("nothing to deliver"));
    // A signed-out gh blocks a PR mode before anything is pushed.
    let mut signed_out = FakeGithub::new(vec![]);
    signed_out.signed_in = false;
    commit(&g.copy, "a.txt", "two\n");
    let input = DeliverInput {
        project: g.project.to_string_lossy().into(),
        checkout: g.copy.to_string_lossy().into(),
        ..Default::default()
    };
    assert!(deliver::deliver(&s, &signed_out, input, 10)
        .unwrap_err()
        .contains("gh isn't signed in"));
    assert!(!git_ok(
        &g.bare,
        &["rev-parse", "--verify", "refs/heads/work"]
    ));
}

/// A worker copy checked out on the base, or on the remote's default, must not be pushed: `HEAD:refs/heads/<branch>`
/// would move that branch on the remote and skip the merge path.
#[test]
fn pr_and_checked_pr_refuse_a_worker_on_the_base_or_the_default_branch() {
    let f = fixture("protected");
    let s = store();
    git(&f.project, &["branch", "release"]);
    git(&f.project, &["push", "-q", "origin", "release"]);
    git(&f.copy, &["checkout", "-q", "release"]);
    commit(&f.copy, "a.txt", "two\n");
    let release_at = git(&f.bare, &["rev-parse", "refs/heads/release"]);
    let main_at = git(&f.bare, &["rev-parse", "refs/heads/main"]);
    let deliver_at = |base: &str| DeliverInput {
        project: f.project.to_string_lossy().into(),
        checkout: f.copy.to_string_lossy().into(),
        base: Some(base.into()),
        ..Default::default()
    };

    for mode in [Mode::Pr, Mode::CheckedPr] {
        set_mode(&s, &f.project, Some(mode), false);
        let gh = FakeGithub::new(vec![]);
        let error = deliver::deliver(&s, &gh, deliver_at("release"), 10).unwrap_err();
        assert!(
            error.contains("release") && error.contains("base"),
            "{mode:?}: {error}"
        );
        assert!(
            gh.ran("pr", "create").is_empty(),
            "{mode:?} opened a pull request"
        );
        // The same branch named as a full ref is still the base.
        let prefixed = deliver::deliver(&s, &gh, deliver_at("refs/heads/release"), 11).unwrap_err();
        assert!(
            prefixed.contains("release") && prefixed.contains("base"),
            "{prefixed}"
        );
    }
    assert_eq!(
        git(&f.bare, &["rev-parse", "refs/heads/release"]),
        release_at
    );
    assert_eq!(git(&f.bare, &["rev-parse", "refs/heads/main"]), main_at);
    assert!(deliver::list(&s.lock_conn().unwrap(), None)
        .unwrap()
        .is_empty());

    // On the remote's default branch, even when the pull request's base is a different branch.
    git(&f.project, &["checkout", "-q", "-b", "dev"]);
    git(&f.copy, &["checkout", "-q", "main"]);
    commit(&f.copy, "a.txt", "three\n");
    for mode in [Mode::Pr, Mode::CheckedPr] {
        set_mode(&s, &f.project, Some(mode), false);
        let gh = FakeGithub::new(vec![]);
        let error = deliver::deliver(&s, &gh, deliver_at("release"), 12).unwrap_err();
        assert!(
            error.contains("main") && error.contains("default"),
            "{mode:?}: {error}"
        );
        assert!(gh.ran("pr", "create").is_empty(), "{mode:?}");
    }
    assert_eq!(
        git(&f.bare, &["rev-parse", "refs/heads/main"]),
        main_at,
        "main on the bare repo did not move"
    );
    assert_eq!(
        git(&f.bare, &["rev-parse", "refs/heads/release"]),
        release_at
    );
    assert!(deliver::list(&s.lock_conn().unwrap(), None)
        .unwrap()
        .is_empty());
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
    assert_eq!(
        d.state,
        deliver::CHECKING,
        "checked PR isn't ready until green"
    );
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
    assert_eq!(
        events::record(
            &conn,
            "acme/web",
            7,
            Some("1111111111111111111111111111111111111111"),
            &red_news(),
            20
        )
        .unwrap(),
        vec![d.id.clone()]
    );
    let now = state(&conn);
    assert_eq!((now.state.as_str(), now.fix_rounds), (deliver::FIXING, 1));
    assert!(now.detail.unwrap().contains("one fix round"));
    // Red again after the fix round: failed, and its first mate decides.
    events::record(
        &conn,
        "acme/web",
        7,
        Some("2222222222222222222222222222222222222222"),
        &red_news(),
        30,
    )
    .unwrap();
    assert_eq!(state(&conn).state, deliver::FAILED);
    // Every event is kept for WP-11's classifier, tied to the delivery.
    let open = events::open(&conn).unwrap();
    assert_eq!(
        open.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
        vec!["ci-red", "ci-red"]
    );
    assert!(open
        .iter()
        .all(|e| e.delivery_id.as_deref() == Some(d.id.as_str())));
    assert_eq!(events::consume(&conn, &[open[0].id], 40).unwrap(), 1);
    assert_eq!(events::open(&conn).unwrap().len(), 1);
    drop(conn);

    // A fix round that turns green is ready; the merge then settles it.
    let g = fixture("checked-green");
    let e = checked_delivery(&s, &g);
    let conn = s.lock_conn().unwrap();
    // `by_pr` is the newest delivery of acme/web#7: this one.
    events::record(
        &conn,
        "acme/web",
        7,
        Some("1111111111111111111111111111111111111111"),
        &red_news(),
        50,
    )
    .unwrap();
    let green = [News {
        kind: Kind::CiGreen,
        detail: None,
    }];
    events::record(
        &conn,
        "acme/web",
        7,
        Some("2222222222222222222222222222222222222222"),
        &green,
        60,
    )
    .unwrap();
    assert_eq!(
        deliver::get(&conn, &e.id).unwrap().unwrap().state,
        deliver::READY
    );
    let merged = [News {
        kind: Kind::Merged,
        detail: Some("m3rg3".into()),
    }];
    events::record(
        &conn,
        "acme/web",
        7,
        Some("2222222222222222222222222222222222222222"),
        &merged,
        70,
    )
    .unwrap();
    assert_eq!(
        deliver::get(&conn, &e.id).unwrap().unwrap().state,
        deliver::MERGED
    );
    // A merged delivery stays merged.
    events::record(
        &conn,
        "acme/web",
        7,
        None,
        &[News {
            kind: Kind::Closed,
            detail: None,
        }],
        80,
    )
    .unwrap();
    assert_eq!(
        deliver::get(&conn, &e.id).unwrap().unwrap().state,
        deliver::MERGED
    );
}

#[test]
fn a_checked_pr_already_green_or_red_on_the_first_read_settles_once() {
    let f = fixture("first-read");
    let s = store();
    let d = checked_delivery(&s, &f);
    let conn = s.lock_conn().unwrap();
    // The watch's first read is "already told", so classify sees no change. The delivery still has to leave checking.
    let green = green("1111111111111111111111111111111111111111");
    assert!(events::classify(&green, Some(&[])).is_empty());
    let moved = events::note_current(&conn, "acme/web", 7, &green, 20).unwrap();
    assert_eq!(moved, vec![d.id.clone()]);
    assert_eq!(
        deliver::get(&conn, &d.id).unwrap().unwrap().state,
        deliver::READY
    );
    // Told again, it stays ready: the first read must not also count as a failure later.
    assert!(events::note_current(&conn, "acme/web", 7, &green, 21)
        .unwrap()
        .is_empty());
    drop(conn);

    let red = pr(
        PrState::Open,
        "2222222222222222222222222222222222222222",
        vec![check("build", CheckStatus::Failure, true)],
    );
    let g = fixture("first-read-red");
    let e = checked_delivery(&s, &g);
    let conn = s.lock_conn().unwrap();
    // Newest acme/web#7 is this delivery. One red starts the fix round; the same red again does not fail it.
    let moved = events::note_current(&conn, "acme/web", 7, &red, 30).unwrap();
    assert_eq!(moved, vec![e.id.clone()]);
    let now = deliver::get(&conn, &e.id).unwrap().unwrap();
    assert_eq!((now.state.as_str(), now.fix_rounds), (deliver::FIXING, 1));
    assert!(events::note_current(&conn, "acme/web", 7, &red, 31)
        .unwrap()
        .is_empty());
    assert_eq!(
        deliver::get(&conn, &e.id).unwrap().unwrap().state,
        deliver::FIXING
    );
    // A newer red, after that round, fails it. A write that still thinks the row is checking does not.
    assert!(!deliver::move_state(
        &conn,
        &e.id,
        deliver::CHECKING,
        0,
        deliver::FAILED,
        1,
        None,
        32
    )
    .unwrap());
    events::record(
        &conn,
        "acme/web",
        7,
        Some("3333333333333333333333333333333333333333"),
        &red_news(),
        33,
    )
    .unwrap();
    assert_eq!(
        deliver::get(&conn, &e.id).unwrap().unwrap().state,
        deliver::FAILED
    );
}

#[test]
fn pr_watch_reads_classify_as_ci_red_green_merged_and_closed() {
    let red = check("build", CheckStatus::Failure, true);
    let news = events::classify(
        &green("1111111111111111111111111111111111111111"),
        Some(&[
            Change::ChecksFailed(vec![red]),
            Change::ChecksPassed {
                count: 2,
                required: true,
            },
            Change::Conflicting,
        ]),
    );
    assert_eq!(
        news.iter().map(|n| n.kind).collect::<Vec<_>>(),
        vec![Kind::CiRed, Kind::CiGreen]
    );
    assert!(news[0]
        .detail
        .as_deref()
        .unwrap()
        .contains("actions/runs/99"));
    assert_eq!(
        events::classify(
            &green("1111111111111111111111111111111111111111"),
            Some(&[])
        ),
        vec![]
    );
    let merged = events::classify(
        &pr(
            PrState::Merged,
            "1111111111111111111111111111111111111111",
            vec![],
        ),
        None,
    );
    assert_eq!(
        merged,
        vec![News {
            kind: Kind::Merged,
            detail: Some("m3rg3".into())
        }]
    );
    assert_eq!(
        events::classify(
            &pr(
                PrState::Closed,
                "1111111111111111111111111111111111111111",
                vec![]
            ),
            None
        )[0]
        .kind,
        Kind::Closed
    );
    assert_eq!(
        events::run_id("https://github.com/a/b/actions/runs/123/job/456"),
        Some("123")
    );
    assert_eq!(events::run_id("https://example.com/ci/1"), None);
    // Already green or red, with no *change* since the watch's first read, is still news for a delivery that is checking.
    let mut quiet = events::classify(
        &green("1111111111111111111111111111111111111111"),
        Some(&[]),
    );
    events::include_current(
        &mut quiet,
        &green("1111111111111111111111111111111111111111"),
        deliver::CHECKING,
    );
    assert_eq!(
        quiet,
        vec![News {
            kind: Kind::CiGreen,
            detail: None
        }]
    );
    let mut already = quiet.clone();
    events::include_current(
        &mut already,
        &green("1111111111111111111111111111111111111111"),
        deliver::READY,
    );
    assert_eq!(
        already, quiet,
        "a settled delivery is not told the same thing again"
    );
    assert_eq!(
        events::current(&pr(
            PrState::Open,
            "1111111111111111111111111111111111111111",
            vec![]
        )),
        None,
        "no checks is not green"
    );
    let pending = pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![check("build", CheckStatus::Pending, true)],
    );
    assert_eq!(events::current(&pending), None);
}

#[test]
fn the_fix_round_carries_the_failing_log() {
    let read = pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![
            check("build", CheckStatus::Failure, true),
            check("lint", CheckStatus::Success, true),
        ],
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
    Allow::Person {
        by: "person (Inbox)".into(),
    }
}

#[test]
fn decide_refuses_red_pending_drafts_conflicts_and_open_decisions() {
    let refused = |read: &PrRead, open: Option<&str>, allow: &Allow| match decide(read, open, allow)
    {
        Decision::Refuse(why) => why,
        other => panic!("expected a refusal, got {other:?}"),
    };
    let red = pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![check("build", CheckStatus::Failure, true)],
    );
    assert!(refused(&red, None, &person()).contains("Red is never merged"));
    assert!(refused(&red, None, &Allow::Switch).contains("Red is never merged"));
    let cancelled = pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![check("build", CheckStatus::Cancelled, false)],
    );
    assert!(refused(&cancelled, None, &person()).contains("failed"));
    let pending = pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![check("build", CheckStatus::Pending, true)],
    );
    assert!(refused(&pending, None, &person()).contains("still running"));
    let mut draft = green("1111111111111111111111111111111111111111");
    draft.draft = true;
    assert!(refused(&draft, None, &person()).contains("draft"));
    let mut conflict = green("1111111111111111111111111111111111111111");
    conflict.detail.mergeability = Mergeability::Conflicting;
    assert!(refused(&conflict, None, &person()).contains("conflicts"));
    assert!(refused(
        &pr(
            PrState::Merged,
            "1111111111111111111111111111111111111111",
            vec![]
        ),
        None,
        &person()
    )
    .contains("already merged"));
    assert!(refused(
        &pr(
            PrState::Closed,
            "1111111111111111111111111111111111111111",
            vec![]
        ),
        None,
        &person()
    )
    .contains("closed"));
    let open = refused(
        &green("1111111111111111111111111111111111111111"),
        Some("Keep the old API?"),
        &person(),
    );
    assert!(open.contains("Keep the old API?"), "{open}");

    // Green: the person's word merges, the switch merges, nobody's word asks.
    assert_eq!(
        decide(
            &green("1111111111111111111111111111111111111111"),
            None,
            &person()
        ),
        Decision::Merge {
            allowed_by: "person (Inbox)".into()
        }
    );
    assert!(matches!(
        decide(
            &green("1111111111111111111111111111111111111111"),
            None,
            &Allow::Switch
        ),
        Decision::Merge { .. }
    ));
    assert!(matches!(
        decide(
            &green("1111111111111111111111111111111111111111"),
            None,
            &Allow::Nobody
        ),
        Decision::Ask(_)
    ));
    // Only the required checks decide when some are required (as the PR watch counts them).
    let optional_red = pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![
            check("build", CheckStatus::Success, true),
            check("flaky", CheckStatus::Failure, false),
        ],
    );
    assert!(matches!(
        decide(&optional_red, None, &person()),
        Decision::Merge { .. }
    ));
    // No checks is not green: the switch alone can't merge it.
    let unchecked = pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![],
    );
    assert!(matches!(
        decide(&unchecked, None, &Allow::Switch),
        Decision::Ask(_)
    ));
    assert!(matches!(
        decide(&unchecked, None, &person()),
        Decision::Merge { .. }
    ));
}

fn agent_merge(repo: &str) -> MergeRequest {
    MergeRequest {
        repo: repo.into(),
        number: 7,
        caller: Caller::Agent {
            session: "lead-1".into(),
        },
        project: None,
        delegation_id: None,
        method: Method::Merge,
    }
}

#[test]
fn an_agent_merge_asks_the_person_and_merges_only_the_head_they_allowed() {
    let s = store();
    let gh = FakeGithub::new(vec![green("1111111111111111111111111111111111111111")]);
    let asked = merge::merge(&s, &gh, agent_merge("acme/web"), 10).unwrap();
    assert!(
        matches!(&asked, MergeOutcome::NeedsYou { head_sha, .. } if head_sha == "1111111111111111111111111111111111111111"),
        "{asked:?}"
    );
    assert!(
        gh.ran("pr", "merge").is_empty(),
        "nothing merges without the person's word"
    );
    assert!(activity_at(&s, 10).is_empty(), "asking is not a merge");

    // The person allows h1; a push since (h2) needs their word again.
    merge::approve(
        &s.lock_conn().unwrap(),
        "Acme/Web",
        7,
        "1111111111111111111111111111111111111111",
        "person",
        20,
    )
    .unwrap();
    let moved = FakeGithub::new(vec![green("2222222222222222222222222222222222222222")]);
    assert!(matches!(
        merge::merge(&s, &moved, agent_merge("acme/web"), 30).unwrap(),
        MergeOutcome::NeedsYou { .. }
    ));
    assert!(moved.ran("pr", "merge").is_empty());

    let merged = merge::merge(&s, &gh, agent_merge("acme/web"), 40).unwrap();
    assert!(
        matches!(&merged, MergeOutcome::Merged { head_sha, allowed_by } if head_sha == "1111111111111111111111111111111111111111" && allowed_by.contains("person"))
    );
    let calls = gh.ran("pr", "merge");
    assert_eq!(
        calls[0],
        [
            "pr",
            "merge",
            "7",
            "--repo",
            "acme/web",
            "--merge",
            "--match-head-commit",
            "1111111111111111111111111111111111111111"
        ]
    );

    // Every attempt is logged, with who allowed the merge.
    let log = merge::log(&s.lock_conn().unwrap(), "acme/web", 7).unwrap();
    assert_eq!(
        log.iter().map(|l| l.outcome.as_str()).collect::<Vec<_>>(),
        vec!["asked", "asked", "merged"]
    );
    assert_eq!(
        log[2].allowed_by.as_deref(),
        Some("person (approved this head)")
    );
    assert_eq!(log[2].caller, "agent lead-1");

    let rows = activity_at(&s, 40);
    assert_eq!(rows.len(), 2, "{rows:?}");
    let grant = rows
        .iter()
        .find(|row| row.kind == crate::activity::PERMISSION_GRANT)
        .unwrap();
    assert_eq!(grant.actor, crate::activity::Who::person());
    assert_eq!(grant.initiator, crate::activity::Who::person());
    assert!(
        !grant
            .summary
            .contains("1111111111111111111111111111111111111111"),
        "{}",
        grant.summary
    );
    let merged_row = rows
        .iter()
        .find(|row| row.kind == crate::activity::MERGE)
        .unwrap();
    assert_eq!(
        merged_row.actor,
        crate::activity::Who::first_mate("lead-1", "")
    );
    assert_eq!(merged_row.initiator, crate::activity::Who::person());
    assert_eq!(merged_row.summary, "Merged acme/web#7.");
}

#[test]
fn an_agent_merge_refuses_a_security_park_label_even_on_an_approved_head() {
    // The lead tick's rule, read fresh on the merge path: the label is checked here, not only in the tick's copy.
    for label in [
        "security-park",
        "Security Park",
        "never-merge",
        "never-merge-here",
    ] {
        let s = store();
        merge::approve(&s.lock_conn().unwrap(), "acme/web", 7, "h1", "person", 10).unwrap();
        let mut parked = green("h1");
        parked.labels = vec![label.into()];
        let gh = FakeGithub::new(vec![parked]);
        let outcome = merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap();
        assert!(
            matches!(&outcome, MergeOutcome::Refused { reason } if reason.contains("an agent never merges it")),
            "{label}: {outcome:?}"
        );
        assert!(gh.ran("pr", "merge").is_empty(), "{label}: nothing merges");
        let log = merge::log(&s.lock_conn().unwrap(), "acme/web", 7).unwrap();
        assert_eq!(
            log.last().map(|l| l.outcome.as_str()),
            Some("refused"),
            "{label}"
        );
    }
}

fn remember_delivery(
    store: &SessionStore,
    project: &Path,
    delegation_id: Option<&str>,
    number: u64,
) {
    store
        .lock_conn()
        .unwrap()
        .execute(
            "INSERT INTO work_deliveries (id, delegation_id, project, checkout, mode, state, repo, number, url, branch, fix_rounds, detail, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, 'pr', 'ready', 'acme/web', ?4, NULL, 'work', 0, NULL, ?5, ?5)",
            rusqlite::params![
                format!("dlv-{number}"),
                delegation_id,
                settings::key(project.to_str().unwrap()),
                number as i64,
                number as i64,
            ],
        )
        .unwrap();
}

fn task(conn: &mut rusqlite::Connection, owner: &str, request: &str, child: &str) -> String {
    delegations::record(
        conn,
        RecordInput {
            owner_session: owner.into(),
            request_id: request.into(),
            child_session: child.into(),
            title: Some("Fix the save bug".into()),
            ..Default::default()
        },
        1,
    )
    .unwrap()
    .id
}

/// An agent doesn't get to name the project or the delegation. The delivery row is the only source: another project's
/// switch can't be borrowed, and a delegation with no open question can't hide the one this pull request belongs to.
/// With no delivery row, the agent is asked unless the person approved this head.
#[test]
fn an_agent_merge_uses_only_the_delivery_record() {
    let quiet = fixture("quiet");
    let loud = fixture("loud");
    let s = store();
    set_mode(&s, &quiet.project, Some(Mode::Pr), false);
    set_mode(&s, &loud.project, Some(Mode::Pr), true);
    let mut conn = s.lock_conn().unwrap();
    let blocked = task(&mut conn, "lead-1", "r-blocked", "worker-1");
    delegations::set_question(
        &mut conn,
        &blocked,
        Some("Keep the old file format?".into()),
        None,
        2,
    )
    .unwrap();
    let clean = task(&mut conn, "lead-2", "r-clean", "worker-2");
    drop(conn);
    // The pull request belongs to the project whose switch is off, and to the delegation that is waiting.
    remember_delivery(&s, &quiet.project, Some(&blocked), 7);

    let mut borrow = agent_merge("acme/web");
    borrow.project = Some(loud.project.to_string_lossy().into());
    borrow.delegation_id = Some(clean);
    let gh = FakeGithub::new(vec![green("1111111111111111111111111111111111111111")]);
    let refused = merge::merge(&s, &gh, borrow, 10).unwrap();
    assert!(
        matches!(&refused, MergeOutcome::Refused { reason } if reason.contains("Keep the old file format?")),
        "naming a clean delegation hid the open question: {refused:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty());

    // No open question on the delivery's own delegation: the other project's switch still doesn't apply.
    let s = store();
    set_mode(&s, &quiet.project, Some(Mode::Pr), false);
    set_mode(&s, &loud.project, Some(Mode::Pr), true);
    remember_delivery(&s, &quiet.project, None, 7);
    let mut borrow = agent_merge("acme/web");
    borrow.project = Some(loud.project.to_string_lossy().into());
    let gh = FakeGithub::new(vec![green("1111111111111111111111111111111111111111")]);
    let asked = merge::merge(&s, &gh, borrow, 10).unwrap();
    assert!(
        matches!(&asked, MergeOutcome::NeedsYou { .. }),
        "the agent borrowed the other project's switch: {asked:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty());

    // No delivery row at all: asked, even with the switch named on the request, until this head is approved.
    let s = store();
    set_mode(&s, &loud.project, Some(Mode::Pr), true);
    let mut named = agent_merge("acme/web");
    named.project = Some(loud.project.to_string_lossy().into());
    let gh = FakeGithub::new(vec![
        green("1111111111111111111111111111111111111111"),
        green("1111111111111111111111111111111111111111"),
    ]);
    let asked = merge::merge(&s, &gh, named.clone(), 20).unwrap();
    assert!(
        matches!(&asked, MergeOutcome::NeedsYou { head_sha, .. } if head_sha == "1111111111111111111111111111111111111111"),
        "{asked:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty());
    merge::approve(
        &s.lock_conn().unwrap(),
        "acme/web",
        7,
        "1111111111111111111111111111111111111111",
        "person",
        21,
    )
    .unwrap();
    let merged = merge::merge(&s, &gh, named, 22).unwrap();
    assert!(
        matches!(&merged, MergeOutcome::Merged { head_sha, allowed_by } if head_sha == "1111111111111111111111111111111111111111" && allowed_by.contains("person"))
    );
    assert_eq!(gh.ran("pr", "merge").len(), 1);
}

#[test]
fn the_switch_merges_green_without_asking_and_never_red() {
    let f = fixture("yolo");
    let s = store();
    set_mode(&s, &f.project, Some(Mode::Pr), true);
    // The switch is read from the delivery's project. The project on the request is a decoy.
    remember_delivery(&s, &f.project, None, 7);
    let mut request = agent_merge("acme/web");
    request.project = Some("/not/the/delivery/project".into());

    let red = FakeGithub::new(vec![pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![check("build", CheckStatus::Failure, true)],
    )]);
    let refused = merge::merge(&s, &red, request.clone(), 10).unwrap();
    assert!(
        matches!(&refused, MergeOutcome::Refused { reason } if reason.contains("Red is never merged"))
    );
    assert!(red.ran("pr", "merge").is_empty());
    assert!(activity_at(&s, 10).is_empty(), "a red check merges nothing");

    let gh = FakeGithub::new(vec![green("1111111111111111111111111111111111111111")]);
    let merged = merge::merge(&s, &gh, request, 20).unwrap();
    assert!(
        matches!(&merged, MergeOutcome::Merged { allowed_by, .. } if allowed_by.contains("merge without asking"))
    );
    assert_eq!(gh.ran("pr", "merge").len(), 1);

    // Switched off again (the default), the same green pull request asks.
    set_mode(&s, &f.project, Some(Mode::Pr), false);
    let mut again = agent_merge("acme/web");
    again.project = Some("/not/the/delivery/project".into());
    assert!(matches!(
        merge::merge(&s, &gh, again, 30).unwrap(),
        MergeOutcome::NeedsYou { .. }
    ));
    let rows = activity_at(&s, 30);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].kind, crate::activity::MERGE);
    assert_eq!(
        rows[0].actor,
        crate::activity::Who::first_mate("lead-1", "")
    );
    assert_eq!(
        rows[0].initiator,
        crate::activity::Who::first_mate("lead-1", "")
    );
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
    let gh = FakeGithub::new(vec![green("1111111111111111111111111111111111111111")]);
    let request = MergeRequest {
        caller: Caller::Person {
            via: "Inbox".into(),
        },
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

/// A WP-14 decision (its own table, state open) waiting on any task in the tree blocks the merge, even when no
/// delegation row is in the question state.
#[test]
fn an_open_wp14_decision_on_the_trees_task_blocks_the_merge() {
    let s = store();
    let mut conn = s.lock_conn().unwrap();
    let parent = task(&mut conn, "lead-1", "r-parent", "worker-1");
    let child = task(&mut conn, "worker-1", "r-child", "worker-2");
    let other = task(&mut conn, "lead-2", "r-other", "worker-9");
    assert_eq!(
        delegations::get(&conn, &parent).unwrap().unwrap().state,
        delegations::RUNNING,
        "the block has to come from the decisions table, not a question on the row"
    );
    // A broken waiting list is ignored, not a failure. The real decision waits on the child only.
    conn.execute(
        "INSERT INTO decisions (project, decision_key, question, options, recommended, asked_by, asked_by_mono, waiting, state, answer, answered_by, answered_at, created_at, updated_at, version)
         VALUES ('web', 'broken', 'Ignore this row', '[]', NULL, 'lead-1', NULL, 'not-json', 'open', NULL, NULL, NULL, 1, 1, 1)",
        [],
    )
    .unwrap();
    let waiting = serde_json::json!(["not-in-this-tree", child]).to_string();
    conn.execute(
        "INSERT INTO decisions (project, decision_key, question, options, recommended, asked_by, asked_by_mono, waiting, state, answer, answered_by, answered_at, created_at, updated_at, version)
         VALUES ('web', 'ship', 'Ship the migration?', '[\"Ship it\",\"Hold it\"]', NULL, 'lead-1', NULL, ?1, 'open', NULL, NULL, NULL, 2, 2, 1)",
        [&waiting],
    )
    .unwrap();
    drop(conn);

    let question = merge::open_decision(&s.lock_conn().unwrap(), &parent).unwrap();
    assert_eq!(question.as_deref(), Some("Ship the migration?"));
    assert_eq!(
        merge::open_decision(&s.lock_conn().unwrap(), &child)
            .unwrap()
            .as_deref(),
        Some("Ship the migration?")
    );
    assert_eq!(
        merge::open_decision(&s.lock_conn().unwrap(), &other).unwrap(),
        None
    );

    let gh = FakeGithub::new(vec![
        green("1111111111111111111111111111111111111111"),
        green("1111111111111111111111111111111111111111"),
    ]);
    let request = MergeRequest {
        caller: Caller::Person {
            via: "Inbox".into(),
        },
        delegation_id: Some(parent.clone()),
        ..agent_merge("acme/web")
    };
    let refused = merge::merge(&s, &gh, request.clone(), 10).unwrap();
    assert!(
        matches!(&refused, MergeOutcome::Refused { reason } if reason.contains("Ship the migration?")),
        "{refused:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty());

    // Answered (or any state other than open) no longer blocks, and the switch can merge.
    s.lock_conn()
        .unwrap()
        .execute(
            "UPDATE decisions SET state = 'answered', answer = 'Hold it' WHERE decision_key = 'ship'",
            [],
        )
        .unwrap();
    assert_eq!(
        merge::open_decision(&s.lock_conn().unwrap(), &parent).unwrap(),
        None
    );
    let merged = merge::merge(&s, &gh, request, 20).unwrap();
    assert!(matches!(merged, MergeOutcome::Merged { .. }), "{merged:?}");
}

#[test]
fn the_inbox_merge_button_goes_through_the_same_path() {
    let s = store();
    let red = FakeGithub::new(vec![pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![check("build", CheckStatus::Failure, true)],
    )]);
    let error = merge::by_person(&s, &red, "acme/web", 7, Method::Squash, "Inbox", 10).unwrap_err();
    assert!(error.contains("Red is never merged"), "{error}");
    assert!(red.ran("pr", "merge").is_empty());
    assert!(
        activity_at(&s, 10).is_empty(),
        "a refused tap is not a merge"
    );
    let gh = FakeGithub::new(vec![green("1111111111111111111111111111111111111111")]);
    merge::by_person(&s, &gh, "acme/web", 7, Method::Squash, "Inbox", 20).unwrap();
    assert!(gh.ran("pr", "merge")[0].contains(&"--squash".to_string()));
    let log = merge::log(&s.lock_conn().unwrap(), "acme/web", 7).unwrap();
    assert_eq!(log[1].allowed_by.as_deref(), Some("person (Inbox)"));
    assert_eq!(Method::from_action("close"), None);
    let rows = activity_at(&s, 20);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].kind, crate::activity::MERGE);
    assert_eq!(rows[0].actor, crate::activity::Who::person());
    assert_eq!(rows[0].initiator, crate::activity::Who::person());
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
    assert_eq!(
        crate::land::land(&f.copy, &f.project).unwrap().outcome,
        "landed"
    );
    assert_eq!(teardown::guard(&f.project, &f.copy).unwrap(), Safe::Landed);
    // The project changes the same lines afterwards: the work is no longer all there, so it is kept again.
    std::fs::write(f.project.join("a.txt"), "three\n").unwrap();
    assert!(teardown::guard(&f.project, &f.copy).is_err());

    // Merged and clean: it may go. A folder already gone: nothing to lose.
    let g = fixture("teardown-merged");
    commit(&g.copy, "a.txt", "two\n");
    git(&g.project, &["merge", "-q", "--ff-only", "work"]);
    assert_eq!(teardown::guard(&g.project, &g.copy).unwrap(), Safe::Merged);
    assert_eq!(
        teardown::guard(&g.project, &g.project.join("gone")).unwrap(),
        Safe::Missing
    );
}

// WP-91: an orchestration worker's handoff is a note kept in its own checkout. Integration leaves it out of what the
// worker changed (checkpoint.rs), so it never reaches the project; the guard must not then call the copy unlanded for
// holding it, or an accepted worker's copy could never be removed.
#[test]
fn teardown_does_not_count_a_workers_handoff_as_unlanded_work() {
    let f = fixture("teardown-handoff");
    let note = f.copy.join(".hivra").join("handoff").join("task-1.md");
    std::fs::create_dir_all(note.parent().unwrap()).unwrap();
    std::fs::write(&note, "## Changed\nsrc/a.ts\n").unwrap();
    // Only the note in it: the worker changed nothing, so there is nothing to lose.
    assert_eq!(teardown::guard(&f.project, &f.copy).unwrap(), Safe::Landed);
    assert_eq!(
        crate::land::land(&f.copy, &f.project).unwrap().outcome,
        "nothing"
    );

    // A change that has not landed keeps the copy, note or no note.
    std::fs::write(f.copy.join("a.txt"), "two\n").unwrap();
    let kept = teardown::guard(&f.project, &f.copy).unwrap_err();
    assert!(kept.contains("hasn't landed"), "{kept}");
    // Once it has, the copy may go: the work is in the project and the note stays behind in the copy.
    let landing = crate::land::land(&f.copy, &f.project).unwrap();
    assert_eq!(landing.outcome, "landed");
    assert_eq!(landing.files, vec!["a.txt".to_string()]);
    assert_eq!(teardown::guard(&f.project, &f.copy).unwrap(), Safe::Landed);
    assert!(!f.project.join(".hivra").exists());
    assert!(note.is_file());
}

#[test]
fn the_janitor_never_offers_to_remove_a_landed_but_unmerged_copy() {
    use crate::worktree_janitor::{gather, verdict, Context, Kind as TreeKind, Outcome, Policy};
    let f = fixture("janitor");
    commit(&f.copy, "a.txt", "two\n");
    assert_eq!(
        crate::land::land(&f.copy, &f.project).unwrap().outcome,
        "landed"
    );
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

// ---- the security gate (WP-203) on the merge path --------------------------------------------------------------------
// A pull request that touches a securityPaths file (or carries a park label) merges only with a security review for its
// exact head in <git common dir>/hivra-security-review/<head>/: findings.json, run.json and coverage-ledger.json, as the
// review command and the ship helper read them.

const SECURITY_FILE: &str = "src-tauri/src/mobile_access.rs";

/// Records a hand-written result for `head`, as the review delegation's settle would receive it.
fn record_raw(s: &SessionStore, head: &str, author: &str, reviewer: &str, result: &str) {
    let conn = s.lock_conn().unwrap();
    conn.execute(
        "INSERT INTO work_deliveries (id, project, mode, state, repo, number, fix_rounds, created_at, updated_at, author) \
         VALUES (?1, '/no/such/review', 'pr', 'open', 'acme/web', 7, 0, 1, 1, ?2)",
        rusqlite::params![format!("dlv-{head}"), author],
    )
    .unwrap();
    crate::delivery::review::record_settled(
        &conn,
        &format!("del-{head}"),
        &crate::delivery::review::request_id("acme/web", 7, head, reviewer),
        Some(result),
        10,
    )
    .unwrap();
}

/// Records a review for `head` the way the app does: a delivery row names the author, and the review delegation's
/// settle writes the record from its result. A finding without a severity or a verifier gets a low severity and a
/// fresh verifier, so each test states only what it is about.
fn record_review(
    s: &SessionStore,
    head: &str,
    findings: &str,
    author: &str,
    reviewer: &str,
    covered: &[&str],
) {
    let conn = s.lock_conn().unwrap();
    conn.execute(
        "INSERT INTO work_deliveries (id, project, mode, state, repo, number, fix_rounds, created_at, updated_at, author) \
         VALUES (?1, '/no/such/review', 'pr', 'open', 'acme/web', 7, 0, 1, 1, ?2)",
        rusqlite::params![format!("dlv-{head}"), author],
    )
    .unwrap();
    let mut list: Vec<serde_json::Value> = serde_json::from_str(findings).unwrap();
    let verifier = ["human", "grok", "devin"]
        .into_iter()
        .find(|name| *name != author && *name != reviewer)
        .unwrap();
    for finding in &mut list {
        if finding.get("severity").is_none() {
            finding["severity"] = serde_json::json!({ "overall_severity": "low" });
        }
        if finding.get("verified_by").is_none() {
            finding["verified_by"] = serde_json::json!(verifier);
        }
    }
    let ledger: Vec<serde_json::Value> = covered
        .iter()
        .map(|f| serde_json::json!({ "status": "covered", "starting_paths": [f] }))
        .collect();
    let result = serde_json::json!({
        "hunt": { "builder": reviewer, "candidates": list.len(), "files": covered },
        "findings": list,
        "ledger": ledger,
    });
    crate::delivery::review::record_settled(
        &conn,
        &format!("del-{head}"),
        &crate::delivery::review::request_id("acme/web", 7, head, reviewer),
        Some(&result.to_string()),
        10,
    )
    .unwrap();
}

// ---- protected-path floor (WP-158) ---------------------------------------------------------------------------------------

fn floor_project(tag: &str) -> PathBuf {
    PathBuf::from(format!("/no/such/hivra-wp158-{tag}"))
}

fn turn_floor_on(store: &SessionStore, project: &Path) {
    let conn = store.lock_conn().unwrap();
    let current = settings::get(&conn, project.to_str().unwrap()).unwrap();
    settings::set_protect_paths(
        &conn,
        project.to_str().unwrap(),
        true,
        current.updated_at,
        current.updated_at.unwrap_or(0) + 1,
    )
    .unwrap();
}

fn protect_also(store: &SessionStore, project: &Path, paths: &[&str]) {
    let conn = store.lock_conn().unwrap();
    let current = settings::get(&conn, project.to_str().unwrap()).unwrap();
    let owned: Vec<String> = paths.iter().map(|path| (*path).to_string()).collect();
    settings::add_protected_paths(
        &conn,
        project.to_str().unwrap(),
        &owned,
        current.updated_at,
        current.updated_at.unwrap_or(0) + 1,
    )
    .unwrap();
}

fn security_request(project: &Path) -> MergeRequest {
    MergeRequest {
        repo: "acme/web".into(),
        number: 7,
        caller: Caller::Person {
            via: "Inbox".into(),
        },
        project: Some(project.display().to_string()),
        delegation_id: None,
        method: Method::Merge,
    }
}

/// The pull request's changed files, read the way the gate reads them: the compare answer lists them and the
/// pull request's count agrees.
fn security_gh(head: &str, files: &[&str]) -> FakeGithub {
    let body: String = files.iter().map(|f| format!("{f}\n")).collect();
    let gh = FakeGithub::new(vec![green(head)]);
    gh.reads.lock().unwrap()[0].changed_files = Some(files.len() as u64);
    *gh.files.lock().unwrap() = Some(Ok(body));
    gh
}

/// Commit-shaped heads: the file list is read between commits, and only a full commit id is asked for.
const H1_SEC: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const H0_SEC: &str = "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";

#[test]
fn a_security_pr_without_a_review_for_its_head_is_refused() {
    let s = store();
    let f = fixture("sec-none");
    let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
    let outcome = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Refused { reason } if reason.contains("author is not recorded")),
        "{outcome:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty(), "nothing merges");
}

#[test]
fn a_review_for_another_head_does_not_pass_a_new_head() {
    let s = store();
    let f = fixture("sec-stale");
    record_review(&s, H0_SEC, "[]", "claude", "codex", &[SECURITY_FILE]);
    let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
    let outcome = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Refused { .. }),
        "{outcome:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn a_confirmed_high_on_the_head_refuses_the_merge() {
    let s = store();
    let f = fixture("sec-high");
    let high = r#"[{"verdict":"confirmed","title":"Stale head merges","severity":{"overall_severity":"high"}}]"#;
    record_review(&s, H1_SEC, high, "claude", "codex", &[SECURITY_FILE]);
    let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
    let outcome = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Refused { reason } if reason.contains("confirmed high")),
        "{outcome:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn a_clean_review_for_the_exact_head_lets_the_security_pr_merge() {
    let s = store();
    let f = fixture("sec-clean");
    record_review(
        &s,
        H1_SEC,
        r#"[{"verdict":"rejected","title":"Cap exists"}]"#,
        "claude",
        "codex",
        &[SECURITY_FILE],
    );
    let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
    let outcome = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Merged { .. }),
        "{outcome:?}"
    );
    assert_eq!(gh.ran("pr", "merge").len(), 1);
}

#[test]
fn a_needs_validation_question_holds_the_merge_until_the_person_answers() {
    // M4: the candidates that need validation hold the merge until the person answers the Inbox question. Nothing merges
    // in the call that asks, and "Hold the merge" keeps it from ever merging on this head.
    let pending = r#"[{"verdict":"needs_validation","title":"Unbounded read"},{"verdict":"needs_validation","title":"Second"}]"#;
    let key = format!("security-review/{H1_SEC}");
    for (tag, answer, expect_merge) in [
        ("sec-held", "Hold the merge", false),
        ("sec-looked", "Looked at it", true),
    ] {
        let f = fixture(tag);
        let project = f.project.display().to_string();
        let s = store();
        record_review(&s, H1_SEC, pending, "claude", "codex", &[SECURITY_FILE]);
        let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
        let first = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
        assert!(
            matches!(&first, MergeOutcome::NeedsYou { question, .. } if question.contains("2 candidates need validation")),
            "{tag}: {first:?}"
        );
        assert!(
            gh.ran("pr", "merge").is_empty(),
            "{tag}: the first call holds, it does not merge"
        );
        {
            let conn = s.lock_conn().unwrap();
            let item = crate::decisions::get(&conn, &project, &key)
                .unwrap()
                .expect("one Inbox question");
            assert_eq!(item.state, crate::decisions::OPEN);
            assert_eq!(item.options.len(), 2);
        }
        {
            let mut conn = s.lock_conn().unwrap();
            crate::decisions::answer(&mut conn, &project, &key, answer, Some("person".into()), 11)
                .unwrap();
        }
        let second = merge::merge(&s, &gh, security_request(&f.project), 12).unwrap();
        if expect_merge {
            assert!(
                matches!(second, MergeOutcome::Merged { .. }),
                "{tag}: {second:?}"
            );
            assert_eq!(gh.ran("pr", "merge").len(), 1);
        } else {
            assert!(
                matches!(&second, MergeOutcome::Refused { reason } if reason.contains("held the merge")),
                "{tag}: {second:?}"
            );
            assert!(
                gh.ran("pr", "merge").is_empty(),
                "{tag}: a held head never merges"
            );
        }
    }
}

#[test]
fn a_review_by_the_same_builder_is_refused_at_the_merge() {
    let s = store();
    let f = fixture("sec-same");
    record_review(&s, H1_SEC, "[]", "claude", "claude", &[SECURITY_FILE]);
    let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
    let outcome = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Refused { reason } if reason.contains("same builder")),
        "{outcome:?}"
    );
}

#[test]
fn a_security_path_past_the_file_list_cap_is_held_not_missed() {
    let s = store();
    let f = fixture("sec-cap");
    // Three hundred other files, then the security path as the 301st. GitHub's list stops at 300, so the gate
    // cannot see the path: it holds the merge (never merges) rather than pass a list it cannot trust.
    let mut body: String = (0..300).map(|n| format!("docs/note{n}.md\n")).collect();
    body.push_str(&format!("{SECURITY_FILE}\n"));
    let gh = files_of(Ok(&body));
    let outcome = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::NeedsYou { question, .. } if question.contains("couldn't be read") && question.contains("stops at 300")),
        "{outcome:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty(), "nothing merges");
}

#[test]
fn a_security_pr_whose_review_leaves_a_changed_file_uncovered_is_refused() {
    let s = store();
    let f = fixture("sec-uncovered");
    record_review(&s, H1_SEC, "[]", "claude", "codex", &[SECURITY_FILE]);
    let gh = security_gh(
        H1_SEC,
        &[SECURITY_FILE, "src/features/mobile/ui/PairPhoneDialog.tsx"],
    );
    let outcome = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Refused { reason } if reason.contains("not covered")),
        "{outcome:?}"
    );
}

fn files_of(body: Result<&str, &str>) -> FakeGithub {
    let gh = FakeGithub::new(vec![green("1111111111111111111111111111111111111111")]);
    // A readable body agrees with the second pull-request read, unless a test sets another count.
    if let Ok(text) = body {
        if let Ok(list) = super::protected::parse_file_list(text) {
            gh.reads.lock().unwrap()[0].changed_files = Some(list.filenames as u64);
        }
    }
    *gh.files.lock().unwrap() = Some(match body {
        Ok(text) => Ok(text.to_string()),
        Err(text) => Err(text.to_string()),
    });
    gh
}

fn asked(outcome: &MergeOutcome) -> String {
    match outcome {
        MergeOutcome::NeedsYou { question, .. } => question.clone(),
        other => panic!("expected the merge to ask, got {other:?}"),
    }
}

#[test]
fn the_floor_off_decides_exactly_as_before() {
    let decision = decide(
        &green("1111111111111111111111111111111111111111"),
        None,
        &Allow::Switch,
    );
    assert_eq!(
        floor_decision(
            &shared_list(),
            decision.clone(),
            false,
            &ChangedFiles::Unread {
                reason: "gh didn't answer".into(),
            },
            &["*".to_string()],
            "acme/web#7",
        ),
        decision
    );

    let project = floor_project("off");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    remember_delivery(&s, &project, None, 7);
    let mut request = agent_merge("acme/web");
    request.project = Some("/not/the/delivery/project".into());
    let gh = files_of(Ok(".github/workflows/x.yml\n"));
    let merged = merge::merge(&s, &gh, request, 20).unwrap();
    assert!(
        matches!(&merged, MergeOutcome::Merged { allowed_by, .. } if allowed_by.contains("merge without asking")),
        "the floor is off, so a protected diff still merges: {merged:?}"
    );
    assert_eq!(
        api_calls(&gh),
        1,
        "the security gate reads the list once; an off floor reads nothing more"
    );
}

#[test]
fn the_floor_names_at_most_five_files_and_an_unreadable_list_asks() {
    let allowed = Decision::Merge {
        allowed_by: "project setting: merge without asking".into(),
    };
    let six = ChangedFiles::Listed(vec![
        ".github/workflows/a.yml".into(),
        "migrations/001.sql".into(),
        "Dockerfile".into(),
        ".env".into(),
        "compose.yml".into(),
        "id_rsa".into(),
    ]);
    let named = floor_decision(
        &shared_list(),
        allowed.clone(),
        true,
        &six,
        &[],
        "acme/web#7",
    );
    let question = asked_decision(&named);
    for name in [
        ".github/workflows/a.yml",
        "migrations/001.sql",
        "Dockerfile",
        ".env",
        "compose.yml",
    ] {
        assert!(question.contains(name), "{question}");
    }
    assert!(question.contains("1 more"), "{question}");
    assert!(question.contains("your word"), "{question}");
    assert!(!question.contains("id_rsa"), "{question}");
    assert!(!question.contains('\u{2014}') && !question.contains('\u{2013}'));

    let one = floor_decision(
        &shared_list(),
        allowed.clone(),
        true,
        &ChangedFiles::Listed(vec![".github/workflows/x.yml".into()]),
        &[],
        "acme/web#7",
    );
    let question = asked_decision(&one);
    assert!(question.contains(".github/workflows/x.yml"), "{question}");
    assert!(!question.contains("more"), "{question}");

    assert_eq!(
        floor_decision(
            &shared_list(),
            allowed.clone(),
            true,
            &ChangedFiles::Listed(vec!["readme.md".into()]),
            &[],
            "acme/web#7",
        ),
        allowed
    );

    let unread_decision = floor_decision(
        &shared_list(),
        allowed,
        true,
        &ChangedFiles::Unread {
            reason: "gh didn't answer within 2 minutes".into(),
        },
        &[],
        "acme/web#7",
    );
    let unread = asked_decision(&unread_decision);
    assert!(unread.contains("couldn't be read"), "{unread}");
    assert!(unread.contains("2 minutes"), "{unread}");
    assert!(!unread.contains("secret"), "{unread}");
}

#[test]
fn a_protected_list_that_will_not_load_asks_and_never_panics() {
    // The list is an error value, not a panic: the pull request needs the person's word, and the store is not poisoned.
    let allowed = Decision::Merge {
        allowed_by: "project setting: merge without asking".into(),
    };
    let unloaded: Result<&super::protected::Shared, String> =
        Err("the list is not version 1".into());
    let decision = floor_decision(
        &unloaded,
        allowed,
        true,
        &ChangedFiles::Listed(vec!["readme.md".into()]),
        &[],
        "acme/web#7",
    );
    let question = asked_decision(&decision);
    assert!(question.contains("couldn't be loaded"), "{question}");
    assert!(question.contains("not version 1"), "{question}");
    assert!(question.contains("your word"), "{question}");
}

fn asked_decision(decision: &Decision) -> String {
    match decision {
        Decision::Ask(question) => question.clone(),
        other => panic!("expected an ask, got {other:?}"),
    }
}

#[test]
fn yolo_merges_a_clean_diff_and_asks_for_a_protected_path() {
    let project = floor_project("clean");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);
    let mut request = agent_merge("acme/web");
    request.project = Some("/not/the/delivery/project".into());

    let clean = files_of(Ok("readme.md\n"));
    let merged = merge::merge(&s, &clean, request.clone(), 20).unwrap();
    assert!(
        matches!(&merged, MergeOutcome::Merged { allowed_by, .. } if allowed_by.contains("merge without asking")),
        "{merged:?}"
    );
    assert_eq!(clean.ran("pr", "merge").len(), 1);

    let protected = files_of(Ok(".github/workflows/x.yml\n"));
    let outcome = merge::merge(&s, &protected, request, 30).unwrap();
    let question = asked(&outcome);
    assert!(question.contains(".github/workflows/x.yml"), "{question}");
    assert!(question.contains("your word"), "{question}");
    assert!(protected.ran("pr", "merge").is_empty());
}

#[test]
fn an_unreadable_file_list_asks_and_keeps_the_reader_error() {
    let project = floor_project("unread");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);
    let gh = files_of(Err("gh didn't answer within 2 minutes"));
    let outcome = merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap();
    let question = asked(&outcome);
    assert!(question.contains("couldn't be read"), "{question}");
    assert!(question.contains("2 minutes"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
    assert!(matches!(outcome, MergeOutcome::NeedsYou { .. }));
}

#[test]
fn an_extra_path_asks_and_a_glob_matches_nothing() {
    let project = floor_project("extra");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    protect_also(&s, &project, &["docs/runbook.md"]);
    remember_delivery(&s, &project, None, 7);
    let mut request = agent_merge("acme/web");
    request.project = Some("/not/the/delivery/project".into());

    let hit = files_of(Ok("docs/runbook.md\n"));
    let question = asked(&merge::merge(&s, &hit, request.clone(), 20).unwrap());
    assert!(question.contains("docs/runbook.md"), "{question}");
    assert!(hit.ran("pr", "merge").is_empty());

    let miss = files_of(Ok("docs/other.md\n"));
    let merged = merge::merge(&s, &miss, request.clone(), 30).unwrap();
    assert!(
        matches!(merged, MergeOutcome::Merged { .. }),
        "a different file is not the extra path: {merged:?}"
    );

    let project = floor_project("star");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    // A bare `*` is refused on write, so nothing is added and the built-in floor still decides.
    {
        let conn = s.lock_conn().unwrap();
        let current = settings::get(&conn, project.to_str().unwrap()).unwrap();
        let refused = settings::add_protected_paths(
            &conn,
            project.to_str().unwrap(),
            &["*".to_string()],
            current.updated_at,
            current.updated_at.unwrap_or(0) + 1,
        )
        .unwrap_err();
        assert!(refused.contains("matches nothing"), "{refused}");
    }
    remember_delivery(&s, &project, None, 7);
    let mut request = agent_merge("acme/web");
    request.project = Some("/not/the/delivery/project".into());
    let ordinary = files_of(Ok("readme.md\n"));
    assert!(
        matches!(
            merge::merge(&s, &ordinary, request.clone(), 40).unwrap(),
            MergeOutcome::Merged { .. }
        ),
        "a bare * matches nothing"
    );
    let built_in = files_of(Ok(".github/workflows/x.yml\n"));
    let question = asked(&merge::merge(&s, &built_in, request, 50).unwrap());
    assert!(
        question.contains(".github/workflows/x.yml"),
        "an extra * does not turn the built-in list off: {question}"
    );
}

#[test]
fn an_approval_of_this_head_still_merges_a_protected_diff() {
    let project = floor_project("approved");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);
    let gh = files_of(Ok(".github/workflows/x.yml\n"));
    let first = merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap();
    assert!(matches!(first, MergeOutcome::NeedsYou { .. }), "{first:?}");
    assert!(gh.ran("pr", "merge").is_empty());
    let before = api_calls(&gh);
    merge::approve(
        &s.lock_conn().unwrap(),
        "acme/web",
        7,
        "1111111111111111111111111111111111111111",
        "person",
        21,
    )
    .unwrap();
    let merged = merge::merge(&s, &gh, agent_merge("acme/web"), 22).unwrap();
    assert!(
        matches!(&merged, MergeOutcome::Merged { allowed_by, .. } if allowed_by.contains("person")),
        "{merged:?}"
    );
    assert_eq!(gh.ran("pr", "merge").len(), 1);
    assert_eq!(
        api_calls(&gh) - before,
        1,
        "the approved head reads the list once, for the security gate, and the floor doesn't read it again"
    );
}

#[test]
fn the_persons_own_tap_merges_a_protected_diff_with_one_read_for_the_gate() {
    let project = floor_project("person");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    let gh = files_of(Ok(".github/workflows/x.yml\n"));
    let request = MergeRequest {
        caller: Caller::Person {
            via: "Inbox".into(),
        },
        project: Some(project.to_string_lossy().into()),
        ..agent_merge("acme/web")
    };
    let merged = merge::merge(&s, &gh, request, 20).unwrap();
    assert!(matches!(merged, MergeOutcome::Merged { .. }), "{merged:?}");
    assert_eq!(
        api_calls(&gh),
        1,
        "the security gate reads the list once; the person's tap adds no floor read"
    );
}

#[test]
fn a_moved_head_is_not_merged_on_the_file_list_of_the_old_one() {
    let project = floor_project("moved");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);
    let gh = FakeGithub::new(vec![
        green("1111111111111111111111111111111111111111"),
        green("2222222222222222222222222222222222222222"),
    ]);
    *gh.files.lock().unwrap() = Some(Ok("readme.md\n".into()));
    let outcome = merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap();
    let question = asked(&outcome);
    assert!(question.contains("couldn't be read"), "{question}");
    assert!(question.contains("head changed"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
}

fn reported(gh: &FakeGithub, count: Option<u64>) {
    gh.reads.lock().unwrap()[0].changed_files = count;
}

#[test]
fn a_short_file_list_asks_even_when_the_page_is_clean() {
    let project = floor_project("short");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);
    // GitHub's first page is 30 files. This pull request has 60, and none of the first page is protected.
    let page: String = (0..30).map(|i| format!("src/f{i}.rs\n")).collect();
    let gh = files_of(Ok(&page));
    reported(&gh, Some(60));
    let question = asked(&merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains("couldn't be read"), "{question}");
    assert!(question.contains("60"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn an_empty_file_list_asks_and_only_a_listed_change_can_merge() {
    let project = floor_project("empty");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);

    // An empty list is unread even when GitHub's count is 0: it asks, and merges nothing.
    let none = files_of(Ok(""));
    let question = asked(&merge::merge(&s, &none, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains("empty"), "{question}");
    assert!(none.ran("pr", "merge").is_empty());

    let short = files_of(Ok(""));
    reported(&short, Some(5));
    let question = asked(&merge::merge(&s, &short, agent_merge("acme/web"), 30).unwrap());
    assert!(question.contains("couldn't be read"), "{question}");
    assert!(question.contains("empty"), "{question}");
    assert!(short.ran("pr", "merge").is_empty());

    let missing = files_of(Ok("readme.md\n"));
    reported(&missing, None);
    let question = asked(&merge::merge(&s, &missing, agent_merge("acme/web"), 40).unwrap());
    assert!(question.contains("didn't say"), "{question}");
    assert!(missing.ran("pr", "merge").is_empty());
}

#[test]
fn a_capped_file_list_asks_even_when_the_count_matches() {
    let project = floor_project("capped");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);
    let page: String = (0..3000).map(|i| format!("src/f{i}.rs\n")).collect();
    let gh = files_of(Ok(&page));
    let question = asked(&merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains("300"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn a_rename_counts_the_current_name_and_still_holds_the_old_path() {
    let project = floor_project("rename");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);

    let protected = files_of(Ok("filename:src/new.rs\nprevious:.env\n"));
    let question = asked(&merge::merge(&s, &protected, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains(".env"), "{question}");
    assert!(!question.contains("couldn't be read"), "{question}");
    assert!(protected.ran("pr", "merge").is_empty());

    let ordinary = files_of(Ok("filename:src/new.rs\nprevious:src/old.rs\n"));
    let merged = merge::merge(&s, &ordinary, agent_merge("acme/web"), 30).unwrap();
    assert!(
        matches!(merged, MergeOutcome::Merged { .. }),
        "a rename of an ordinary file is one file: {merged:?}"
    );
}

#[test]
fn red_and_a_pull_request_with_no_checks_do_not_consult_the_floor() {
    let project = floor_project("red");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);
    let red = FakeGithub::new(vec![pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![check("build", CheckStatus::Failure, true)],
    )]);
    *red.files.lock().unwrap() = Some(Ok(".github/workflows/x.yml\n".into()));
    let refused = merge::merge(&s, &red, agent_merge("acme/web"), 20).unwrap();
    assert!(
        matches!(&refused, MergeOutcome::Refused { reason } if reason.contains("Red is never merged")),
        "{refused:?}"
    );
    assert!(red.ran("api", "--paginate").is_empty());

    // With no checks the switch still asks. The floor reads the list only to say what the question should name.
    let mut read = pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![],
    );
    read.changed_files = Some(1);
    let unchecked = FakeGithub::new(vec![read]);
    *unchecked.files.lock().unwrap() = Some(Ok("readme.md\n".into()));
    let question = asked(&merge::merge(&s, &unchecked, agent_merge("acme/web"), 30).unwrap());
    assert!(question.contains("no checks"), "{question}");
    assert!(!question.contains("couldn't be read"), "{question}");
    assert!(!question.contains("protected-path floor"), "{question}");
    assert_eq!(
        api_calls(&unchecked),
        2,
        "the security gate and the floor each read the list once"
    );
    assert!(unchecked.ran("pr", "merge").is_empty());
}

#[test]
fn a_mode_change_does_not_clear_the_floor_and_bad_extras_do_not_either() {
    let s = store();
    let project = "/no/such/hivra-wp158-keep";
    let conn = s.lock_conn().unwrap();
    let turned = settings::set_protect_paths(&conn, project, true, None, 10).unwrap();
    let added = settings::add_protected_paths(
        &conn,
        project,
        &[
            "docs/runbook.md".into(),
            "docs/runbook.md".into(),
            "  ".into(),
        ],
        turned.updated_at,
        11,
    )
    .unwrap();
    assert_eq!(added.protected_extra, vec!["docs/runbook.md".to_string()]);
    let mode = settings::set(&conn, project, Some(Mode::Pr), true, added.updated_at, 12).unwrap();
    assert!(mode.merge_without_asking);
    assert!(mode.protect_paths);
    assert_eq!(mode.protected_extra, vec!["docs/runbook.md".to_string()]);
    drop(conn);

    let project = floor_project("bad-json");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, None, 7);
    s.lock_conn()
        .unwrap()
        .execute(
            "UPDATE delivery_settings SET protected_extra = 'not-json' WHERE project = ?1",
            [settings::key(project.to_str().unwrap())],
        )
        .unwrap();
    let stored = settings::get(&s.lock_conn().unwrap(), project.to_str().unwrap()).unwrap();
    assert!(stored.protect_paths);
    assert!(stored.protected_extra.is_empty());
    let protected = files_of(Ok(".github/workflows/x.yml\n"));
    let question = asked(&merge::merge(&s, &protected, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains(".github/workflows/x.yml"), "{question}");
    let clean = files_of(Ok("readme.md\n"));
    assert!(matches!(
        merge::merge(&s, &clean, agent_merge("acme/web"), 30).unwrap(),
        MergeOutcome::Merged { .. }
    ));
}

#[test]
fn extra_protected_paths_only_add_and_a_stale_write_is_refused() {
    assert_eq!(settings::PROTECTED_EXTRA_LABEL, "Also protect these paths");
    assert!(!settings::PROTECTED_EXTRA_LABEL.contains('\u{2014}'));
    assert!(!settings::PROTECTED_EXTRA_LABEL.contains('\u{2013}'));

    let s = store();
    let project = "/no/such/hivra-wp158-add";
    let conn = s.lock_conn().unwrap();
    let missing =
        settings::add_protected_paths(&conn, "  ", &["docs/a.md".into()], None, 1).unwrap_err();
    assert!(missing.contains("Which project"), "{missing}");

    let added = settings::add_protected_paths(
        &conn,
        project,
        &[
            "docs/a.md".into(),
            "docs/a.md".into(),
            "docs/b.md".into(),
            "docs/donnée.md".into(),
            "  ".into(),
            "docs/bad\nname.md".into(),
            "p".repeat(201),
        ],
        None,
        10,
    )
    .unwrap();
    assert_eq!(added.updated_at, Some(10));
    assert!(
        !added.protect_paths,
        "adding a path does not turn the floor on"
    );
    assert_eq!(
        added.protected_extra,
        vec![
            "docs/a.md".to_string(),
            "docs/b.md".to_string(),
            "docs/donnée.md".to_string(),
        ]
    );
    // The same path again changes nothing, so the row's time stays put.
    let same = settings::add_protected_paths(
        &conn,
        project,
        &["docs/a.md".into(), "  ".into()],
        Some(10),
        11,
    )
    .unwrap();
    assert_eq!(same.updated_at, Some(10));
    assert_eq!(same.protected_extra, added.protected_extra);

    // A second window still holding the "no row yet" time cannot add or turn the floor off.
    let stale_add =
        settings::add_protected_paths(&conn, project, &["docs/c.md".into()], None, 12).unwrap_err();
    assert!(stale_add.contains("another window"), "{stale_add}");
    let stale_flag = settings::set_protect_paths(&conn, project, false, Some(9), 13).unwrap_err();
    assert!(stale_flag.contains("another window"), "{stale_flag}");
    let kept = settings::get(&conn, project).unwrap();
    assert_eq!(kept.protected_extra, added.protected_extra);
    assert!(!kept.protect_paths);

    let more =
        settings::add_protected_paths(&conn, project, &["docs/c.md".into()], Some(10), 14).unwrap();
    assert_eq!(
        more.protected_extra,
        vec![
            "docs/a.md".to_string(),
            "docs/b.md".to_string(),
            "docs/donnée.md".to_string(),
            "docs/c.md".to_string(),
        ]
    );
    let off = settings::set_protect_paths(&conn, project, false, more.updated_at, 15).unwrap();
    assert!(!off.protect_paths);
    assert_eq!(off.protected_extra, more.protected_extra);
    let on = settings::set_protect_paths(&conn, project, true, off.updated_at, 16).unwrap();
    assert!(on.protect_paths);
    assert_eq!(on.protected_extra, more.protected_extra);
    // The built-in list is not shrunk by what is stored.
    assert_eq!(
        super::protected::protected_hits(
            super::protected::shared_list().ok(),
            &[".github/workflows/x.yml", "readme.md"],
            &on.protected_extra
        ),
        vec![".github/workflows/x.yml".to_string()]
    );
}

#[test]
fn the_extra_list_stops_at_one_hundred_paths() {
    let s = store();
    let project = "/no/such/hivra-wp158-cap";
    let conn = s.lock_conn().unwrap();
    let paths: Vec<String> = (0..100).map(|n| format!("keep/{n}.txt")).collect();
    let full = settings::add_protected_paths(&conn, project, &paths, None, 10).unwrap();
    assert_eq!(full.protected_extra.len(), 100);
    let overflow = settings::add_protected_paths(
        &conn,
        project,
        &["one-more.txt".into()],
        full.updated_at,
        11,
    )
    .unwrap_err();
    assert_eq!(
        overflow,
        format!("{} can hold 100 paths.", settings::PROTECTED_EXTRA_LABEL)
    );
    assert!(!overflow.contains('\u{2014}') && !overflow.contains('\u{2013}'));
    let kept = settings::get(&conn, project).unwrap();
    assert_eq!(kept.protected_extra.len(), 100);
    assert!(!kept
        .protected_extra
        .iter()
        .any(|path| path == "one-more.txt"));
    assert_eq!(kept.updated_at, full.updated_at);

    // Two new paths on a list of 99 are refused together. Neither is written.
    let project = "/no/such/hivra-wp158-cap-partial";
    let almost: Vec<String> = (0..99).map(|n| format!("keep/{n}.txt")).collect();
    let row = settings::add_protected_paths(&conn, project, &almost, None, 20).unwrap();
    let refused = settings::add_protected_paths(
        &conn,
        project,
        &["extra/a.txt".into(), "extra/b.txt".into()],
        row.updated_at,
        21,
    )
    .unwrap_err();
    assert!(refused.contains("100"), "{refused}");
    let kept = settings::get(&conn, project).unwrap();
    assert_eq!(kept.protected_extra.len(), 99);
    assert!(!kept
        .protected_extra
        .iter()
        .any(|path| path.starts_with("extra/")));
}

// ---- protected-path floor: the review's fixes (WP-158 review round) ----------------------------------------------------

fn api_calls(gh: &FakeGithub) -> usize {
    gh.runs
        .lock()
        .unwrap()
        .iter()
        .filter(|args| args.first().map(String::as_str) == Some("api"))
        .count()
}

fn floor_pr(tag: &str, number: u64, delegation: Option<&str>) -> (SessionStore, PathBuf) {
    let project = floor_project(tag);
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    remember_delivery(&s, &project, delegation, number);
    (s, project)
}

#[test]
fn agent_configuration_in_the_diff_asks_even_with_the_switch_on() {
    let (s, _project) = floor_pr("agent-config", 7, None);
    let gh = files_of(Ok(".claude/settings.json\n"));
    let question = asked(&merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains(".claude/settings.json"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn the_file_list_is_read_for_the_base_and_head_commits_it_judges() {
    let (s, _project) = floor_pr("pinned", 7, None);
    let gh = files_of(Ok("readme.md\n"));
    let merged = merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap();
    assert!(matches!(merged, MergeOutcome::Merged { .. }), "{merged:?}");
    let base = "ba5e".repeat(10);
    let runs = gh.runs.lock().unwrap().clone();
    assert!(
        runs.iter().any(|args| args.get(1).map(String::as_str)
            == Some(format!("repos/acme/web/compare/{base}...{}", "1".repeat(40)).as_str())),
        "{runs:?}"
    );
    assert!(
        !runs
            .iter()
            .any(|args| args.iter().any(|arg| arg.contains("pulls/7/files"))),
        "the pull request's own list has no commit pin: {runs:?}"
    );
}

#[test]
fn a_change_outside_the_security_paths_merges_without_a_review() {
    let s = store();
    let f = fixture("sec-skip");
    let gh = security_gh(H1_SEC, &["docs/hivra/PLAN.md"]);
    let outcome = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Merged { .. }),
        "{outcome:?}"
    );
}

#[test]
fn a_base_that_moves_while_the_files_are_read_is_asked_again() {
    let (s, _project) = floor_pr("base-moved", 7, None);
    let mut moved = green("1111111111111111111111111111111111111111");
    moved.base_tip = Some("dec0".repeat(10));
    let gh = FakeGithub::new(vec![
        green("1111111111111111111111111111111111111111"),
        moved,
    ]);
    *gh.files.lock().unwrap() = Some(Ok("readme.md\n".into()));
    let question = asked(&merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains("base changed"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn a_base_that_is_not_a_commit_is_never_listed() {
    let (s, _project) = floor_pr("base-odd", 7, None);
    for base in [Some("main".to_string()), None] {
        let mut read = green("1111111111111111111111111111111111111111");
        read.base_tip = base;
        let gh = FakeGithub::new(vec![read]);
        *gh.files.lock().unwrap() = Some(Ok("readme.md\n".into()));
        let question = asked(&merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap());
        assert!(question.contains("couldn't be read"), "{question}");
        assert_eq!(
            api_calls(&gh),
            0,
            "no list is read without a commit to pin it to"
        );
        assert!(gh.ran("pr", "merge").is_empty());
    }
}

#[test]
fn a_pull_request_on_another_branch_than_the_delivery_is_refused() {
    // The delivery pushed `work`. A pull request whose head has since been pointed at another branch is not the work
    // the delivery judged, so it is refused rather than merged.
    let (s, _project) = floor_pr("other-head", 7, None);
    let mut read = green("1111111111111111111111111111111111111111");
    read.head_ref = "someone-else".into();
    let gh = FakeGithub::new(vec![read]);
    *gh.files.lock().unwrap() = Some(Ok("readme.md\n".into()));
    match merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap() {
        MergeOutcome::Refused { reason } => {
            assert!(reason.contains("someone-else"), "{reason}");
            assert!(reason.contains("work"), "{reason}");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn the_head_branch_check_belongs_to_the_floor() {
    // The floor is off, so the project decides exactly as before: a pull request on another branch than the delivery
    // pushed merges with the switch on, as it did before the floor existed.
    let project = floor_project("branch-off");
    let s = store();
    set_mode(&s, &project, Some(Mode::Pr), true);
    remember_delivery(&s, &project, None, 7);
    let mut read = green("1111111111111111111111111111111111111111");
    read.head_ref = "someone-else".into();
    let gh = FakeGithub::new(vec![read]);
    *gh.files.lock().unwrap() = Some(Ok("readme.md\n".into()));
    let merged = merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap();
    assert!(
        matches!(&merged, MergeOutcome::Merged { .. }),
        "the floor is off, so the branch check does not apply: {merged:?}"
    );
}

#[test]
fn the_security_path_glob_matches_like_the_ship_helper() {
    assert!(merge::glob_match(
        "src-tauri/src/remote*.rs",
        "src-tauri/src/remote_ssh.rs"
    ));
    assert!(!merge::glob_match(
        "src-tauri/src/remote*.rs",
        "src-tauri/src/remote/x.rs"
    ));
    assert!(merge::glob_match(
        "src/features/mobile/**",
        "src/features/mobile/model/mobilePairing.ts"
    ));
    assert!(merge::glob_match(
        "src/features/sessions/model/approval*.ts",
        "src/features/sessions/model/approvalWait.ts"
    ));
    // H2: the approval files match at any name (childApproval.ts is an approval too), and case does not matter.
    assert!(merge::glob_match(
        "src/features/sessions/model/*approval*.ts",
        "src/features/sessions/model/childApproval.ts"
    ));
    assert!(merge::glob_match(
        "src/features/sessions/model/*approval*.ts",
        "SRC/features/sessions/model/CHILDAPPROVAL.TS"
    ));
    assert!(merge::security_paths()
        .iter()
        .any(|p| p == "src-tauri/src/mobile_access.rs"));
}

#[test]
fn a_list_of_three_hundred_files_is_capped_and_asks() {
    let (s, _project) = floor_pr("cap-300", 7, None);
    let page: String = (0..300).map(|i| format!("src/f{i}.rs\n")).collect();
    let gh = files_of(Ok(&page));
    let question = asked(&merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains("300"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn an_empty_file_list_asks_even_when_nothing_changed() {
    let (s, _project) = floor_pr("empty-asks", 7, None);
    let gh = files_of(Ok(""));
    reported(&gh, Some(0));
    let question = asked(&merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains("couldn't be read"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn a_repeated_filename_asks_instead_of_counting_twice() {
    let (s, _project) = floor_pr("repeat", 7, None);
    let gh = files_of(Ok("filename:src/a.rs\nfilename:src/a.rs\n"));
    let question = asked(&merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains("couldn't be read"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
}

/// `gh` whose second pull-request read fails, the way a timeout or a rate limit does.
struct SecondReadFails<'a> {
    inner: &'a FakeGithub,
    reads: std::sync::atomic::AtomicUsize,
}

impl Github for SecondReadFails<'_> {
    fn read_pr(&self, repo: &str, number: u64) -> Result<PrRead, String> {
        if self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
            return Err("gh didn't answer within 2 minutes".into());
        }
        self.inner.read_pr(repo, number)
    }

    fn run(&self, dir: Option<&Path>, args: &[String]) -> Result<String, String> {
        self.inner.run(dir, args)
    }
}

#[test]
fn a_failing_second_read_asks_and_merges_nothing() {
    let (s, _project) = floor_pr("second-read", 7, None);
    let gh = files_of(Ok("readme.md\n"));
    let wrapped = SecondReadFails {
        inner: &gh,
        reads: std::sync::atomic::AtomicUsize::new(0),
    };
    let question = asked(&merge::merge(&s, &wrapped, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains("couldn't be read"), "{question}");
    assert!(question.contains("2 minutes"), "{question}");
    assert!(gh.ran("pr", "merge").is_empty());
}

/// `gh` that runs one thing while the files are read, the way another window's question can land mid-read.
struct OpensAQuestionWhileReading<'a> {
    inner: &'a FakeGithub,
    during_list: Box<dyn Fn() + Send + Sync + 'a>,
}

impl Github for OpensAQuestionWhileReading<'_> {
    fn read_pr(&self, repo: &str, number: u64) -> Result<PrRead, String> {
        self.inner.read_pr(repo, number)
    }

    fn run(&self, dir: Option<&Path>, args: &[String]) -> Result<String, String> {
        if args.first().map(String::as_str) == Some("api") {
            (self.during_list)();
        }
        self.inner.run(dir, args)
    }
}

#[test]
fn a_question_opened_during_the_file_read_stops_the_merge() {
    let s = store();
    let project = floor_project("mid-read");
    set_mode(&s, &project, Some(Mode::Pr), true);
    turn_floor_on(&s, &project);
    let delegation = task(&mut s.lock_conn().unwrap(), "lead-1", "r-mid", "worker-1");
    remember_delivery(&s, &project, Some(&delegation), 7);
    let gh = files_of(Ok("readme.md\n"));
    let wrapped = OpensAQuestionWhileReading {
        inner: &gh,
        during_list: Box::new(|| {
            delegations::set_question(
                &mut s.lock_conn().unwrap(),
                &delegation,
                Some("Keep the old file format?".into()),
                None,
                3,
            )
            .unwrap();
        }),
    };
    let refused = merge::merge(&s, &wrapped, agent_merge("acme/web"), 20).unwrap();
    assert!(
        matches!(&refused, MergeOutcome::Refused { reason } if reason.contains("Keep the old file format?")),
        "{refused:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn the_floor_path_merges_only_the_head_it_judged() {
    let (s, _project) = floor_pr("judged-head", 7, None);
    let gh = files_of(Ok("readme.md\n"));
    assert!(matches!(
        merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap(),
        MergeOutcome::Merged { .. }
    ));
    let merges = gh.ran("pr", "merge");
    assert_eq!(merges.len(), 1);
    let at = merges[0]
        .iter()
        .position(|arg| arg == "--match-head-commit")
        .expect("the merge names the head");
    assert_eq!(
        merges[0].get(at + 1).map(String::as_str),
        Some("1111111111111111111111111111111111111111")
    );
}

#[test]
fn the_no_checks_question_names_a_protected_file_too() {
    let (s, _project) = floor_pr("no-checks-named", 7, None);
    let mut read = pr(
        PrState::Open,
        "1111111111111111111111111111111111111111",
        vec![],
    );
    read.changed_files = Some(1);
    let unchecked = FakeGithub::new(vec![read]);
    *unchecked.files.lock().unwrap() = Some(Ok(".github/workflows/x.yml\n".into()));
    let question = asked(&merge::merge(&s, &unchecked, agent_merge("acme/web"), 20).unwrap());
    assert!(question.contains("no checks"), "{question}");
    assert!(question.contains(".github/workflows/x.yml"), "{question}");
    assert!(unchecked.ran("pr", "merge").is_empty());
}

#[test]
fn a_protected_name_with_a_hidden_format_character_is_shown_escaped() {
    let (s, _project) = floor_pr("bidi", 7, None);
    let gh = files_of(Ok("docs/\u{202e}gnp.key\n"));
    let question = asked(&merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap());
    assert!(!question.contains('\u{202e}'), "{question:?}");
    assert!(question.contains("\\u{202e}"), "{question}");
}

#[test]
fn a_pattern_that_matches_nothing_is_refused_on_write_and_nothing_is_saved() {
    let s = store();
    let project = "/no/such/hivra-wp158-glob";
    let conn = s.lock_conn().unwrap();
    for bad in [
        "*",
        "secret*",
        "docs/[a].md",
        "/etc/passwd",
        "../outside.md",
        "C:/keys/server.txt",
        "docs/../x.md",
    ] {
        let refused =
            settings::add_protected_paths(&conn, project, &[bad.into()], None, 10).unwrap_err();
        assert!(refused.contains("matches nothing"), "{bad}: {refused}");
    }
    let kept = settings::get(&conn, project).unwrap();
    assert!(kept.protected_extra.is_empty());
    assert_eq!(kept.updated_at, None);
}

// ---- review/220-r1 repros (red at 82876e1b) ---------------------------------------------------------------------------

/// WP-92's vault (#213) is src-tauri/src/secrets/**, not src-tauri/src/vault/**: a later change to it merges unreviewed.
#[test]
fn repro_220_a_change_to_the_wp92_vault_needs_a_security_review() {
    let s = store();
    let f = fixture("r220-vault");
    let gh = security_gh(H1_SEC, &["src-tauri/src/secrets/store.rs"]);
    let outcome = merge::merge(&s, &gh, security_request(&f.project), 10).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Refused { .. }),
        "{outcome:?}"
    );
    assert!(
        gh.ran("pr", "merge").is_empty(),
        "the vault merged with no review"
    );
}

/// The gate's own list is neither a security path nor on the floor: the lead tick's switch merges a PR that empties
/// `securityPaths` with no person and no review, and the next ship has no gate.
#[test]
fn repro_220_a_change_to_the_gates_own_list_is_not_merged_by_the_switch() {
    let (s, _project) = floor_pr("r220-list", 7, None);
    let gh = files_of(Ok("src/features/leadTick/model/neverMerge.json\n"));
    let outcome = merge::merge(&s, &gh, agent_merge("acme/web"), 20).unwrap();
    assert!(
        !matches!(outcome, MergeOutcome::Merged { .. }),
        "the switch merged a change to the security path list: {outcome:?}"
    );
}

/// The merge path does not run the validators: a findings file the review command could never write (an object, not
/// the schema's array) carrying a confirmed critical is read as "no findings", and builders that differ only in case,
/// or are not known builders, pass. All three are files anyone with the checkout can write by hand.
#[test]
fn repro_220_a_hand_written_review_the_validators_would_refuse_does_not_pass() {
    // A findings object with no hunter, a hunter whose builder differs from the reviewer only in case, and a reviewer
    // the app does not know: none of them is a review the app records, and the gate refuses each.
    let critical = r#"{"findings":[{"verdict":"confirmed","title":"Token leaks","severity":{"overall_severity":"critical"}}]}"#;
    let case_only = r#"{"hunt":{"builder":"Claude","candidates":0,"files":["src-tauri/src/mobile_access.rs"]},"findings":[],"ledger":[{"status":"covered","starting_paths":["src-tauri/src/mobile_access.rs"]}]}"#;
    for (tag, result, author, reviewer) in [
        ("r220-object", critical, "codex", "claude"),
        ("r220-case", case_only, "Claude", "claude"),
        ("r220-unknown", case_only, "codex", "y"),
    ] {
        let s = store();
        record_raw(&s, H1_SEC, author, reviewer, result);
        let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
        let outcome = merge::merge(&s, &gh, security_request(&floor_project(tag)), 10).unwrap();
        assert!(
            matches!(&outcome, MergeOutcome::Refused { .. }),
            "{tag}: {outcome:?}"
        );
        assert!(gh.ran("pr", "merge").is_empty(), "{tag}: nothing merges");
    }
}

// ---- WP-203 round 3: the app starts a review and the gate waits for its settle (fakes for the reviewer's session) ----

fn seed_author(s: &SessionStore, author: &str) {
    let conn = s.lock_conn().unwrap();
    conn.execute(
        "INSERT INTO work_deliveries (id, project, mode, state, repo, number, fix_rounds, created_at, updated_at, author) \
         VALUES ('dlv-launch', '/no/such/launch', 'pr', 'open', 'acme/web', 7, 0, 1, 1, ?1)",
        rusqlite::params![author],
    )
    .unwrap();
}

fn presence(cli: &str, installed: bool, signed_in: bool) -> crate::crew::resolve::Presence {
    crate::crew::resolve::Presence {
        cli: cli.into(),
        installed,
        signed_in,
    }
}

fn review_result(findings: &str) -> String {
    format!(
        r#"{{"hunt":{{"builder":"claude","candidates":{},"files":["{SECURITY_FILE}"]}},"findings":{findings},"ledger":[{{"status":"covered","starting_paths":["{SECURITY_FILE}"]}}]}}"#,
        if findings == "[]" { 0 } else { 1 }
    )
}

/// The reviewer's session settles its run. Only the app's review delegation can be settled this way in the test.
fn settle_review(s: &SessionStore, id: &str, result: &str) {
    let mut conn = s.lock_conn().unwrap();
    crate::delegations::settle(
        &mut conn,
        crate::delegations::SettleInput {
            id: id.into(),
            generation: 1,
            state: "completed".into(),
            result: Some(result.into()),
            error: None,
            error_class: None,
            retryable: None,
            resets_at: None,
            by: None,
            self_review: None,
        },
        20,
    )
    .unwrap();
}

fn review_rows(s: &SessionStore) -> Vec<(String, String, String)> {
    let conn = s.lock_conn().unwrap();
    let mut statement = conn
        .prepare("SELECT id, owner_session, state FROM delegations WHERE owner_session = ?1")
        .unwrap();
    statement
        .query_map([crate::delivery::review::OWNER], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
}

#[test]
fn the_gate_starts_a_review_to_another_builder_waits_for_its_settle_and_then_merges() {
    let s = store();
    let f = fixture("sec-launch");
    seed_author(&s, "codex");
    let present = [
        presence("codex", true, true),
        presence("claude", true, true),
    ];
    let gh = security_gh(H1_SEC, &[SECURITY_FILE]);

    // 1. No record for the head: the app starts the review to claude (not the author, codex) and holds the merge.
    let first = merge::merge_with(&s, &gh, security_request(&f.project), 10, &present).unwrap();
    assert!(
        matches!(&first, MergeOutcome::NeedsYou { question, .. } if question.contains("Security review running for PR #7") && question.contains("(claude,")),
        "{first:?}"
    );
    assert!(
        gh.ran("pr", "merge").is_empty(),
        "held while the review runs"
    );
    let rows = review_rows(&s);
    assert_eq!(
        rows.len(),
        1,
        "one review delegation, owned by the app: {rows:?}"
    );
    let (id, owner, state) = rows[0].clone();
    assert_eq!(owner, crate::delivery::review::OWNER);
    assert_eq!(state, "running");

    // 2. Asking again while it runs holds again and starts nothing new.
    let again = merge::merge_with(&s, &gh, security_request(&f.project), 11, &present).unwrap();
    assert!(
        matches!(&again, MergeOutcome::NeedsYou { question, .. } if question.contains("running")),
        "{again:?}"
    );
    assert_eq!(review_rows(&s).len(), 1);

    // 3. The reviewer settles with a clean result: the record is written by the app and the gate passes.
    settle_review(&s, &id, &review_result("[]"));
    {
        let conn = s.lock_conn().unwrap();
        let record = crate::delivery::review::lookup(&conn, "acme/web", 7, H1_SEC)
            .unwrap()
            .expect("the app wrote the record");
        assert_eq!(record.status, "recorded");
        assert_eq!(record.reviewer, "claude");
        assert_eq!(record.author.as_deref(), Some("codex"));
    }
    let merged = merge::merge_with(&s, &gh, security_request(&f.project), 30, &present).unwrap();
    assert!(matches!(merged, MergeOutcome::Merged { .. }), "{merged:?}");
    assert_eq!(gh.ran("pr", "merge").len(), 1);
}

#[test]
fn a_review_that_settles_with_a_high_finding_holds_the_merge_refused() {
    let s = store();
    let f = fixture("sec-launch-high");
    seed_author(&s, "codex");
    let present = [
        presence("codex", true, true),
        presence("claude", true, true),
    ];
    let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
    merge::merge_with(&s, &gh, security_request(&f.project), 10, &present).unwrap();
    let (id, _, _) = review_rows(&s)[0].clone();
    let high = r#"[{"verdict":"confirmed","title":"Token leaks","severity":{"overall_severity":"high"},"verified_by":"human"}]"#;
    settle_review(&s, &id, &review_result(high));
    let outcome = merge::merge_with(&s, &gh, security_request(&f.project), 30, &present).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Refused { reason } if reason.contains("confirmed high")),
        "{outcome:?}"
    );
    assert!(gh.ran("pr", "merge").is_empty());
}

#[test]
fn no_other_builder_signed_in_means_no_review_is_started_and_the_merge_is_refused() {
    let s = store();
    let f = fixture("sec-launch-none");
    seed_author(&s, "codex");
    let only_author = [
        presence("codex", true, true),
        presence("claude", false, false),
    ];
    let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
    let outcome =
        merge::merge_with(&s, &gh, security_request(&f.project), 10, &only_author).unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::Refused { reason } if reason.contains("no builder other than its author")),
        "{outcome:?}"
    );
    assert!(
        review_rows(&s).is_empty(),
        "nothing is started without a reviewer"
    );
}

#[test]
fn a_review_running_past_an_hour_is_stuck_and_still_holds_the_merge() {
    // Item 5: a review that has run longer than the timeout says so, and holds: it never passes on its own clock.
    let s = store();
    let f = fixture("sec-stuck");
    seed_author(&s, "codex");
    let present = [
        presence("codex", true, true),
        presence("claude", true, true),
    ];
    let gh = security_gh(H1_SEC, &[SECURITY_FILE]);
    let started = 1_000_000;
    merge::merge_with(&s, &gh, security_request(&f.project), started, &present).unwrap();
    let hour_and_a_bit = started + 60 * 60 * 1000 + 1;
    let outcome = merge::merge_with(
        &s,
        &gh,
        security_request(&f.project),
        hour_and_a_bit,
        &present,
    )
    .unwrap();
    assert!(
        matches!(&outcome, MergeOutcome::NeedsYou { question, .. } if question.contains("Security review stuck")),
        "{outcome:?}"
    );
    assert!(
        gh.ran("pr", "merge").is_empty(),
        "a stuck review never merges"
    );
}
