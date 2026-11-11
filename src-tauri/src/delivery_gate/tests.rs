use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::params;

use super::*;
use crate::delegations::{self, RecordInput};
use crate::delivery::deliver::{self, DeliverInput};
use crate::delivery::events::{self, Kind, News};
use crate::delivery::github::Github;
use crate::delivery::settings::{self, Mode};
use crate::firstmate::gates::{
    self, CommandEvidence, GateKind, GatePlan, Outcome, RoundInput, Runners,
};
use crate::pr_watch::eval::{Change, Remark, RemarkKind};
use crate::session_store::SessionStore;

static LOCK: Mutex<()> = Mutex::new(());

struct Guard {
    _lock: MutexGuard<'static, ()>,
}

impl Drop for Guard {
    fn drop(&mut self) {
        force_dev(None);
        set_test_data_dir(None);
        std::env::remove_var("MONOCODE_NO_MISTAKES");
        std::env::remove_var("HIVRA_SECRET_NOT_ALLOWED");
    }
}

fn guard() -> Guard {
    let lock = LOCK.lock().unwrap_or_else(|err| err.into_inner());
    force_dev(Some(true));
    Guard { _lock: lock }
}

fn scratch() -> PathBuf {
    let name = format!("h{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    // A macOS temp folder is too long for the check's socket. `/tmp` stays under the limit.
    #[cfg(unix)]
    {
        PathBuf::from("/tmp").join(name)
    }
    #[cfg(windows)]
    {
        std::env::temp_dir().join(name)
    }
}

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let dir = scratch();
        std::fs::create_dir_all(dir.join("data")).unwrap();
        set_test_data_dir(Some(dir.join("data")));
        Temp(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct NoGh;

impl Github for NoGh {
    fn read_pr(
        &self,
        _repo: &str,
        _number: u64,
    ) -> Result<crate::pr_watch::github::PrRead, String> {
        Err("gh was called".into())
    }
    fn run(&self, _dir: Option<&Path>, _args: &[String]) -> Result<String, String> {
        Err("gh was called".into())
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = crate::delivery::child("git")
        .current_dir(dir)
        .arg("-c")
        .arg("protocol.file.allow=always")
        .args(args)
        .env("GIT_AUTHOR_NAME", "Gate Test")
        .env("GIT_AUTHOR_EMAIL", "gate@example.com")
        .env("GIT_COMMITTER_NAME", "Gate Test")
        .env("GIT_COMMITTER_EMAIL", "gate@example.com")
        .output()
        .unwrap_or_else(|err| panic!("git {args:?}: {err}"));
    assert!(
        output.status.success(),
        "git {args:?}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    }
}

fn pair(dir: &Path, origin: &str) -> (PathBuf, PathBuf) {
    let bare = dir.join("origin.git");
    let main = dir.join("main");
    let work = dir.join("work");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare"]);
    std::fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-b", "main"]);
    std::fs::write(main.join("readme.txt"), "base\n").unwrap();
    git(&main, &["add", "."]);
    git(&main, &["commit", "-m", "base"]);
    git(&main, &["remote", "add", "origin", origin]);
    if !real_remote(origin) {
        git(&main, &["push", "-u", "origin", "main"]);
    }
    git(
        &main,
        &["worktree", "add", "-b", "work", work.to_str().unwrap()],
    );
    std::fs::write(work.join("readme.txt"), "changed\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-m", "work"]);
    (main, work)
}

fn script(dir: &Path, log: &Path, run: &str) -> PathBuf {
    let path = dir.join("no-mistakes");
    let body = format!(
        "#!hivra-stand-in\nlog={}\nrun={run}\nstatus=step: tests\ninit=Added the no-mistakes remote.\nrespond=ok\n",
        log.display()
    );
    std::fs::write(&path, body.replace("\r\n", "\n")).unwrap();
    path
}

fn use_script(dir: &Path, log: &Path, run: &str) {
    let path = script(dir, log, run);
    std::env::set_var("MONOCODE_NO_MISTAKES", &path);
}

fn store() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn crew(store: &SessionStore, project: &str, goal: &str) -> String {
    let row = delegations::record(
        &mut store.lock_conn().unwrap(),
        RecordInput {
            owner_session: "owner-1".into(),
            request_id: format!("req-{}", uuid::Uuid::new_v4().simple()),
            child_session: "child-1".into(),
            project: Some(project.to_string()),
            title: Some("Name the thing".into()),
            brief: Some("Say what it is.".into()),
            goal: Some(goal.into()),
            ..RecordInput::default()
        },
        1,
    )
    .unwrap();
    row.id
}

fn pr_mode(store: &SessionStore, project: &str) {
    settings::set(
        &store.lock_conn().unwrap(),
        project,
        Some(Mode::Pr),
        false,
        None,
        1,
    )
    .unwrap();
}

fn turn_on(store: &SessionStore, project: &str) -> SettingView {
    set_enabled(store, project, true, 0, 2).unwrap()
}

fn log_of(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[test]
fn the_gate_is_off_until_it_is_turned_on() {
    let _guard = guard();
    let dir = Temp::new();
    let store = store();
    let project = dir.path().join("main");
    std::fs::create_dir_all(&project).unwrap();
    let view = setting(&store.lock_conn().unwrap(), project.to_str().unwrap()).unwrap();
    assert!(!view.enabled);
    assert_eq!(view.version, 0);
    assert!(!enabled(&store.lock_conn().unwrap(), project.to_str().unwrap()).unwrap());
}

#[test]
fn a_finished_crew_runs_axi_with_its_intent_and_nothing_is_pushed() {
    let _guard = guard();
    let dir = Temp::new();
    let (main, work) = pair(dir.path(), &file_url(&dir.path().join("origin.git")));
    let log = dir.path().join("tool.log");
    use_script(
        dir.path(),
        &log,
        r#"{"outcome":"running","runId":"r1","step":"tests"}"#,
    );
    let store = store();
    let project = main.to_str().unwrap();
    let id = crew(&store, project, "The name reads clearly.");
    pr_mode(&store, project);
    let note = turn_on(&store, project);
    assert!(note.note.unwrap().contains("no-mistakes remote"));
    let delivery = deliver::deliver(
        &store,
        &NoGh,
        DeliverInput {
            project: project.to_string(),
            checkout: work.to_string_lossy().into_owned(),
            delegation_id: Some(id),
            ..DeliverInput::default()
        },
        5,
    )
    .unwrap();
    assert_eq!(delivery.mode, "pr");
    assert!(delivery.url.is_none());
    let text = log_of(&log);
    assert!(text.contains("\"axi\""), "{text}");
    assert!(text.contains("\"run\""), "{text}");
    assert!(text.contains("\"--yes\""), "{text}");
    assert!(text.contains("\"--intent\""), "{text}");
    assert!(text.contains("\"--pr-title\""), "{text}");
    assert!(text.contains("\"--pr-body-file\""), "{text}");
    assert!(!text.contains("appendix"), "{text}");
    assert!(text.contains("The name reads clearly."), "{text}");
    assert!(!text.contains("\"start\""), "{text}");
    let remote = git(&main, &["ls-remote", "origin", "refs/heads/work"]);
    assert!(remote.is_empty(), "{remote}");
    let cards = cards(&store.lock_conn().unwrap(), project).unwrap();
    assert_eq!(cards[0].line, "checking: tests");
    assert!(cards[0].decision_key.is_none());
    let checks: i64 = store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM gate_activity WHERE kind = 'gate.checks'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checks, 0);
}

struct OnceChecks {
    calls: std::cell::Cell<usize>,
}

impl Runners for OnceChecks {
    fn checks(
        &self,
        _checkout: &Path,
        _named: &[String],
        _changed: &[String],
    ) -> Result<Vec<CommandEvidence>, String> {
        self.calls.set(self.calls.get() + 1);
        Ok(vec![CommandEvidence {
            command: "npm run check".into(),
            outcome: Outcome::Passed,
            exit_code: Some(0),
            output: String::new(),
            seconds: 0.0,
        }])
    }

    fn routes(&self, _checkout: &Path) -> Option<CommandEvidence> {
        None
    }

    fn verdict(&self, _prompt: &str) -> Result<String, String> {
        Ok(r#"{"verdict":"met","why":"the diff does what the brief asks"}"#.into())
    }
}

#[test]
fn a_code_briefs_delivery_runs_the_checks_exactly_once_and_records_the_layer() {
    let _guard = guard();
    let dir = Temp::new();
    let (main, work) = pair(dir.path(), &file_url(&dir.path().join("origin.git")));
    let log = dir.path().join("tool.log");
    use_script(
        dir.path(),
        &log,
        r#"{"outcome":"running","runId":"r1","step":"tests"}"#,
    );
    let store = store();
    let project = main.to_str().unwrap();
    let id = crew(&store, project, "The name reads clearly.");
    let plan = GatePlan {
        gates: vec![GateKind::Diff, GateKind::Checks],
        checks: Vec::new(),
    };
    gates::save_plan(&store.lock_conn().unwrap(), &id, &plan, 1).unwrap();
    pr_mode(&store, project);
    turn_on(&store, project);
    let owns = owns_project_checks(&store.lock_conn().unwrap(), project, &id);
    assert!(owns);
    let counter = OnceChecks {
        calls: std::cell::Cell::new(0),
    };
    gates::run_round(
        &RoundInput {
            delegation_id: &id,
            round: 1,
            checkout: &work,
            plan: &plan,
            brief: "Say what it is.",
            done_when: "The name reads clearly.",
            report: "Named it.",
            now: 4,
            gate_owns_checks: owns,
        },
        &counter,
    );
    assert_eq!(counter.calls.get(), 0);
    deliver::deliver(
        &store,
        &NoGh,
        DeliverInput {
            project: project.to_string(),
            checkout: work.to_string_lossy().into_owned(),
            delegation_id: Some(id.clone()),
            ..DeliverInput::default()
        },
        5,
    )
    .unwrap();
    let text = log_of(&log);
    assert_eq!(text.matches("\"axi\",\"run\"").count(), 1, "{text}");
    let summary: String = store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT summary FROM gate_activity WHERE kind = 'gate.checks' AND target = ?1",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(summary.contains("no-mistakes"), "{summary}");
    assert!(summary.contains("npm run check"), "{summary}");
    let count: i64 = store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM gate_activity WHERE kind = 'gate.checks' AND target = ?1",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn a_parked_finding_is_one_decision_and_each_answer_reaches_axi_respond() {
    let _guard = guard();
    let dir = Temp::new();
    let (main, work) = pair(dir.path(), &file_url(&dir.path().join("origin.git")));
    let log = dir.path().join("tool.log");
    let store = store();
    let project = main.to_str().unwrap();
    pr_mode(&store, project);
    use_script(
        dir.path(),
        &log,
        r#"{"outcome":"parked","runId":"r1","step":"review","finding":"Needs a look.","findingId":"f1"}"#,
    );
    turn_on(&store, project);
    let deliver_once = |store: &SessionStore| {
        let id = crew(store, project, "The name reads clearly.");
        deliver::deliver(
            store,
            &NoGh,
            DeliverInput {
                project: project.to_string(),
                checkout: work.to_string_lossy().into_owned(),
                delegation_id: Some(id),
                ..DeliverInput::default()
            },
            5,
        )
        .unwrap();
    };
    deliver_once(&store);
    deliver_once(&store);
    let count: i64 = store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM decisions WHERE decision_key = 'gate/r1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let shown = cards(&store.lock_conn().unwrap(), project).unwrap();
    assert!(shown
        .iter()
        .any(|card| card.decision_key.as_deref() == Some("gate/r1")));
    assert!(shown.iter().any(|card| card.line.contains("Needs a look.")));

    let answers = [
        ("r-approve", "fa", "Approve", "approve", None),
        ("r-fix", "ff", "Fix", "fix", Some("ff")),
        ("r-skip", "fs", "Skip", "skip", None),
    ];
    for (run_id, finding_id, answer, action, findings) in answers {
        use_script(
            dir.path(),
            &log,
            &format!(
                r#"{{"outcome":"parked","runId":"{run_id}","step":"review","finding":"Needs a look.","findingId":"{finding_id}"}}"#
            ),
        );
        deliver_once(&store);
        let stored: String = store
            .lock_conn()
            .unwrap()
            .query_row(
                "SELECT project FROM gate_runs WHERE decision_key = ?1 ORDER BY created_at DESC LIMIT 1",
                [format!("gate/{run_id}")],
                |row| row.get(0),
            )
            .unwrap();
        forward_answer(&store, &stored, &format!("gate/{run_id}"), answer).unwrap();
        let text = log_of(&log);
        assert!(text.contains(&format!("\"--run\",\"{run_id}\"")), "{text}");
        assert!(
            text.contains(&format!("\"--action\",\"{action}\"")),
            "{text}"
        );
        assert!(text.contains("\"--wait\",\"0\""), "{text}");
        if let Some(id) = findings {
            assert!(text.contains("\"--findings\""), "{text}");
            assert!(text.contains(&format!("\"{id}\"")), "{text}");
        }
    }
}

#[test]
fn a_passed_run_links_its_pull_request_to_the_task() {
    let _guard = guard();
    let dir = Temp::new();
    let (main, work) = pair(dir.path(), &file_url(&dir.path().join("origin.git")));
    let log = dir.path().join("tool.log");
    use_script(
        dir.path(),
        &log,
        r#"{"outcome":"passed","runId":"rp","step":"pr","prUrl":"https://github.com/acme/web/pull/7","prRepo":"acme/web","prNumber":7}"#,
    );
    let store = store();
    let project = main.to_str().unwrap();
    let id = crew(&store, project, "The name reads clearly.");
    pr_mode(&store, project);
    turn_on(&store, project);
    let delivery = deliver::deliver(
        &store,
        &NoGh,
        DeliverInput {
            project: project.to_string(),
            checkout: work.to_string_lossy().into_owned(),
            delegation_id: Some(id.clone()),
            ..DeliverInput::default()
        },
        9,
    )
    .unwrap();
    assert_eq!(delivery.delegation_id.as_deref(), Some(id.as_str()));
    assert_eq!(
        delivery.url.as_deref(),
        Some("https://github.com/acme/web/pull/7")
    );
    assert_eq!(delivery.repo.as_deref(), Some("acme/web"));
    assert_eq!(delivery.number, Some(7));
    assert!(deliver::through_gate(
        &store.lock_conn().unwrap(),
        "acme/web",
        7
    ));
    let kinds: Vec<String> = store
        .lock_conn()
        .unwrap()
        .prepare("SELECT kind FROM gate_activity ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(kinds.iter().any(|kind| kind == "gate.started"), "{kinds:?}");
    assert!(kinds.iter().any(|kind| kind == "gate.passed"), "{kinds:?}");
    assert!(
        kinds.iter().any(|kind| kind == "gate.pr-opened"),
        "{kinds:?}"
    );
    let remote = git(&main, &["ls-remote", "origin", "refs/heads/work"]);
    assert!(remote.is_empty(), "{remote}");
}

#[test]
fn a_red_check_on_a_gated_pull_request_does_not_start_a_fix_round() {
    let _guard = guard();
    let _dir = Temp::new();
    let store = store();
    let conn = store.lock_conn().unwrap();
    conn.execute(
        "INSERT INTO work_deliveries (
            id, project, mode, state, repo, number, fix_rounds, created_at, updated_at, gate
         ) VALUES ('dlv_gate', '/tmp/p', 'checked-pr', 'checking', 'acme/web', 7, 0, 1, 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO work_deliveries (
            id, project, mode, state, repo, number, fix_rounds, created_at, updated_at, gate
         ) VALUES ('dlv_plain', '/tmp/p', 'checked-pr', 'checking', 'acme/web', 8, 0, 1, 1, 0)",
        [],
    )
    .unwrap();
    drop(conn);
    let red = [News {
        kind: Kind::CiRed,
        detail: Some("lint".into()),
    }];
    events::record(&store.lock_conn().unwrap(), "acme/web", 7, None, &red, 2).unwrap();
    events::record(&store.lock_conn().unwrap(), "acme/web", 8, None, &red, 2).unwrap();
    let gated = deliver::get(&store.lock_conn().unwrap(), "dlv_gate")
        .unwrap()
        .unwrap();
    let plain = deliver::get(&store.lock_conn().unwrap(), "dlv_plain")
        .unwrap()
        .unwrap();
    assert_eq!(gated.state, "checking");
    assert_eq!(gated.fix_rounds, 0);
    assert_eq!(plain.state, "fixing");
    assert_eq!(plain.fix_rounds, 1);
}

#[test]
fn wake_changes_drop_checks_only_when_the_pull_request_came_through_the_gate() {
    let remark = Remark {
        id: "c1".into(),
        kind: RemarkKind::Comment,
        author: Some("ada".into()),
        body: "Look here.".into(),
        created_at: "2026-11-04T00:00:00Z".into(),
        edited_at: None,
        url: None,
        path: None,
        review_state: None,
    };
    let changes = vec![
        Change::ChecksFailed(vec![]),
        Change::ChecksPassed {
            count: 1,
            required: true,
        },
        Change::Remarks(vec![remark]),
        Change::Conflicting,
    ];
    let kept = wake_changes(&changes, true);
    assert!(kept.iter().all(|change| !matches!(
        change,
        Change::ChecksFailed(_) | Change::ChecksPassed { .. }
    )));
    assert_eq!(kept.len(), 2);
    assert_eq!(wake_changes(&changes, false).len(), changes.len());
}

#[test]
fn the_socket_path_is_refused_when_it_is_too_long_for_the_system() {
    let short = PathBuf::from("/tmp/hivra-nm");
    assert!(check_socket(&short, "macos").is_ok());
    assert!(check_socket(&short, "linux").is_ok());
    assert!(check_socket(&PathBuf::from("C:/nm"), "windows").is_ok());
    let long = PathBuf::from(format!("/tmp/{}", "n".repeat(120)));
    let err = check_socket(&long, "macos").unwrap_err();
    assert!(err.contains("103"), "{err}");
    assert!(err.contains("bytes"), "{err}");
    assert!(
        err.contains(&socket_path(&long).display().to_string()),
        "{err}"
    );
    let bytes = path_bytes(&socket_path(&long));
    assert!(err.contains(&bytes.len().to_string()), "{err}");
    assert!(check_socket(&long, "windows").is_ok());
    let linux_ok = PathBuf::from(format!("/tmp/{}", "n".repeat(80)));
    if path_bytes(&socket_path(&linux_ok)).len() <= 107 {
        assert!(check_socket(&linux_ok, "linux").is_ok());
    }
    assert_eq!(socket_limit_for("macos"), Some(103));
    assert_eq!(socket_limit_for("linux"), Some(107));
    assert_eq!(socket_limit_for("windows"), None);
}

#[test]
fn a_dev_copy_never_names_a_real_remote_and_a_daily_copy_ignores_the_stand_in() {
    let _guard = guard();
    let dir = Temp::new();
    let (main, _) = pair(dir.path(), "https://github.com/acme/web.git");
    let log = dir.path().join("tool.log");
    use_script(
        dir.path(),
        &log,
        r#"{"outcome":"running","runId":"r1","step":"tests"}"#,
    );
    let store = store();
    let err = set_enabled(&store, main.to_str().unwrap(), true, 0, 2).unwrap_err();
    assert!(err.contains("never uses a real remote"), "{err}");
    assert!(err.contains("https://github.com/acme/web.git"), "{err}");
    assert!(!log.exists());

    force_dev(Some(false));
    assert!(stand_in_program().is_none());
    assert!(!log.exists());
}

#[test]
fn real_remotes_are_network_urls_and_the_pool_is_not_the_persons() {
    assert!(real_remote("https://github.com/acme/web.git"));
    assert!(real_remote("ssh://git@github.com/acme/web.git"));
    assert!(real_remote("git@github.com:acme/web.git"));
    assert!(!real_remote("file:///tmp/origin.git"));
    assert!(!real_remote("/tmp/origin.git"));
    assert!(!real_remote("C:/repo.git"));
    assert!(!real_remote("C:\\repo.git"));
    assert!(is_real_pool(Path::new("/Users/ash/Worktrees/pool")));
    assert!(!is_real_pool(Path::new("/tmp/hivra/nm/pool")));
    let home = std::env::temp_dir().join(format!("hivra-nm-{}", uuid::Uuid::new_v4().simple()));
    write_config(&home, Some("grok-cli")).unwrap();
    let text = std::fs::read_to_string(home.join("config.yaml")).unwrap();
    assert!(text.contains("grok"));
    assert!(text.contains("claude"));
    // The path is written YAML-quoted, so a Windows path has its backslashes doubled.
    assert!(text.contains(&yaml_quote(&home.join("pool").to_string_lossy())));
    assert!(!text.contains("Worktrees/pool"), "{text}");
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(
        intent_text(Some("Ship it.\r\n"), Some("Ship it.")),
        "Ship it."
    );
    assert_eq!(
        intent_text(None, Some("  ")),
        "Deliver the crew's finished work."
    );
    let huge = "あ".repeat(20_000);
    assert!(intent_text(Some(&huge), None).len() <= 49_122);
}

#[test]
fn a_stale_setting_is_not_overwritten_and_off_removes_the_remote() {
    let _guard = guard();
    let dir = Temp::new();
    let main = dir.path().join("main");
    std::fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-b", "main"]);
    std::fs::write(main.join("readme.txt"), "a\n").unwrap();
    git(&main, &["add", "."]);
    git(&main, &["commit", "-m", "base"]);
    let bare = dir.path().join("nm.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare"]);
    git(&main, &["remote", "add", "no-mistakes", &file_url(&bare)]);
    let log = dir.path().join("tool.log");
    use_script(
        dir.path(),
        &log,
        r#"{"outcome":"running","runId":"r1","step":"tests"}"#,
    );
    let store = store();
    let project = main.to_str().unwrap();
    let on = turn_on(&store, project);
    assert!(on.enabled);
    let err = set_enabled(&store, project, false, 0, 4).unwrap_err();
    assert!(err.contains("another window"), "{err}");
    let off = set_enabled(&store, project, false, on.version, 5).unwrap();
    assert!(!off.enabled);
    let remotes = git(&main, &["remote"]);
    assert!(
        !remotes.lines().any(|line| line == "no-mistakes"),
        "{remotes}"
    );
}

#[test]
fn a_tool_that_does_not_answer_is_not_a_final_failure() {
    let _guard = guard();
    let dir = Temp::new();
    let (main, work) = pair(dir.path(), &file_url(&dir.path().join("origin.git")));
    let log = dir.path().join("tool.log");
    use_script(
        dir.path(),
        &log,
        r#"{"outcome":"retry","runId":"rr","step":"tests"}"#,
    );
    let store = store();
    let project = main.to_str().unwrap();
    pr_mode(&store, project);
    turn_on(&store, project);
    let id = crew(&store, project, "The name reads clearly.");
    let delivery = deliver::deliver(
        &store,
        &NoGh,
        DeliverInput {
            project: project.to_string(),
            checkout: work.to_string_lossy().into_owned(),
            delegation_id: Some(id),
            ..DeliverInput::default()
        },
        5,
    )
    .unwrap();
    assert_eq!(delivery.state, "checking");
    assert_eq!(delivery.detail.as_deref(), Some(TRY_AGAIN));
}

#[test]
fn turning_the_check_off_is_safe_when_the_remote_is_already_gone() {
    let _guard = guard();
    let dir = Temp::new();
    let main = dir.path().join("plain");
    std::fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-b", "main"]);
    let store = store();
    let off = set_enabled(&store, main.to_str().unwrap(), false, 0, 1).unwrap();
    assert!(!off.enabled);
    assert!(off.note.unwrap().contains("Removed"));
}

#[test]
fn status_lines_and_json_both_name_the_step() {
    assert_eq!(parse_status("step: tests"), "tests");
    assert_eq!(parse_status("checking: docs"), "docs");
    assert_eq!(parse_status("{\"step\":\"pr\"}"), "pr");
    assert_eq!(checking_line("tests"), "checking: tests");
    assert_eq!(checking_line("document"), "checking: docs");
    assert_eq!(checking_line(""), "checking: the work");
    assert_eq!(checking_line("pr"), "checking: the pull request");
}

#[test]
fn daemon_args_never_install_a_service() {
    let home = Path::new("/tmp/hivra nm/café");
    let args = daemon_args(home);
    assert_eq!(
        args,
        vec![
            "daemon".to_string(),
            "run".to_string(),
            "--root".to_string(),
            home.to_string_lossy().into_owned()
        ]
    );
    assert!(args.iter().all(|arg| arg != "start" && arg != "uninstall"));
}

#[cfg(unix)]
#[test]
fn the_daemon_is_a_child_hivra_stops_and_its_environment_is_allow_listed() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = guard();
    let dir = Temp::new();
    let home = dir.path().join("data").join("nm");
    std::fs::create_dir_all(&home).unwrap();
    let program = dir.path().join("daemon.sh");
    std::fs::write(
        &program,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$NM_HOME/argv\"\nenv | awk -F= '{print $1}' | sort > \"$NM_HOME/keys\"\nprintf '%s\\n' \"$NM_TEST_START_DAEMON\" > \"$NM_HOME/start\"\nprintf '%s\\n' \"$NO_MISTAKES_NO_UPDATE_CHECK\" > \"$NM_HOME/noupdate\"\nprintf '%s\\n' \"$NO_MISTAKES_TELEMETRY\" > \"$NM_HOME/telemetry\"\necho $$ > \"$NM_HOME/pid\"\nexec sleep 60\n",
    )
    .unwrap();
    let mut perms = std::fs::metadata(&program).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&program, perms).unwrap();
    std::env::set_var("HIVRA_SECRET_NOT_ALLOWED", "sekrit");
    ensure_daemon(&program, &home).unwrap();
    let argv = wait_file(&home.join("argv"));
    assert_eq!(
        argv.lines().collect::<Vec<_>>(),
        vec!["daemon", "run", "--root", home.to_str().unwrap()]
    );
    let keys = wait_file(&home.join("keys"));
    assert!(
        !keys.lines().any(|key| key == "HIVRA_SECRET_NOT_ALLOWED"),
        "{keys}"
    );
    assert!(keys.lines().any(|key| key == "NM_HOME"), "{keys}");
    assert_eq!(wait_file(&home.join("start")).trim(), "1");
    assert_eq!(wait_file(&home.join("noupdate")).trim(), "1");
    assert_eq!(wait_file(&home.join("telemetry")).trim(), "0");
    let pid: i32 = wait_file(&home.join("pid")).trim().parse().unwrap();
    stop_daemons();
    let alive = unsafe { libc::kill(pid, 0) == 0 };
    assert!(!alive, "pid {pid} still running");
}

#[cfg(unix)]
fn wait_file(path: &Path) -> String {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if !text.is_empty() {
                return text;
            }
        }
        if std::time::Instant::now() >= deadline {
            panic!("nothing was written to {}", path.display());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

// The daemon writes its files from another process. A loaded machine can take longer than a couple of seconds to
// get there, so the wait must be on the file appearing, with a deadline far past what a busy machine needs.
#[cfg(unix)]
#[test]
fn a_daemons_file_is_waited_for_while_the_machine_is_busy() {
    let dir = std::env::temp_dir().join(format!("wp-flake-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("argv");
    let writer = {
        let file = file.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            std::fs::write(&file, "daemon\n").unwrap();
        })
    };
    assert_eq!(wait_file(&file).trim(), "daemon");
    writer.join().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_secret_in_a_finding_is_not_stored() {
    let _guard = guard();
    let dir = Temp::new();
    let (main, work) = pair(dir.path(), &file_url(&dir.path().join("origin.git")));
    let log = dir.path().join("tool.log");
    use_script(
        dir.path(),
        &log,
        r#"{"outcome":"parked","runId":"rs","step":"review","finding":"token ghp_abcdefghijklmnop","findingId":"fs"}"#,
    );
    let store = store();
    let project = main.to_str().unwrap();
    pr_mode(&store, project);
    turn_on(&store, project);
    let id = crew(&store, project, "The name reads clearly.");
    deliver::deliver(
        &store,
        &NoGh,
        DeliverInput {
            project: project.to_string(),
            checkout: work.to_string_lossy().into_owned(),
            delegation_id: Some(id),
            ..DeliverInput::default()
        },
        5,
    )
    .unwrap();
    let stored: String = store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT COALESCE(finding, '') || COALESCE(detail, '') FROM gate_runs",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!stored.contains("ghp_"), "{stored}");
    assert!(stored.contains("[redacted]"), "{stored}");
}

// WP-102 item 3: the tail scrubber knew four prefixes. A test run's last lines can carry any of these, and the tail is
// stored on the row and shown in the chat.
#[test]
fn a_tail_masks_the_other_common_secret_shapes_and_leaves_prose_alone() {
    // SendGrid is `SG.` then 22 characters, a dot, then 43.
    let sendgrid = format!("SG.PLANTED{}.PLANTED{}", "a".repeat(15), "b".repeat(36));
    let pypi = format!("pypi-AgEIcHlwaS5vcmcPLANTED{}", "x".repeat(40));
    let cases = [
        ("glpat-PLANTEDtoken0123456789ab".to_string(), "[redacted]"),
        (pypi, "[redacted]"),
        (sendgrid, "[redacted]"),
        (
            "xapp-1-A0PLANTED01-1234567890123-PLANTEDappsecret".to_string(),
            "[redacted]",
        ),
        (
            "whsec_PLANTEDwebhooksecret0123456789".to_string(),
            "[redacted]",
        ),
        ("ASIAPLANTED2ABCDEFGH".to_string(), "[redacted]"),
    ];
    for (token, want) in cases {
        let out = scrub(&format!("before {token} after"));
        assert_eq!(out, format!("before {want} after"), "{token}");
    }
    let prose = "From GitLab to PyPI with SendGrid, the xapp- prefix, whsec_, and the ASIA region.";
    assert_eq!(scrub(prose), prose);
    // A short `code=` value, as an OAuth callback or a device sign-in prints it, goes; a code that spells a word in
    // prose does not.
    assert_eq!(
        scrub("visit http://127.0.0.1:54321/?code=PLANTEDcode9&state=abc now"),
        "visit http://127.0.0.1:54321/?code=[redacted]&state=abc now"
    );
    assert_eq!(
        scrub("the error code=404 and this code=abcd are not secrets"),
        "the error code=404 and this code=abcd are not secrets"
    );
    // A private key's body goes; its header and footer stay so a reader knows what it was.
    let pem =
        "-----BEGIN OPENSSH PRIVATE KEY-----\nPLANTEDkeybody\n-----END OPENSSH PRIVATE KEY-----";
    let out = scrub(pem);
    assert!(!out.contains("PLANTEDkeybody"), "{out}");
    assert!(
        out.contains("BEGIN OPENSSH PRIVATE KEY") && out.contains("END OPENSSH PRIVATE KEY"),
        "{out}"
    );
}

fn park(
    store: &SessionStore,
    id: &str,
    project: &str,
    run_id: &str,
    decision_key: &str,
    created_at: i64,
) {
    store
        .lock_conn()
        .unwrap()
        .execute(
            "INSERT INTO gate_runs (
                id, project, state, run_id, finding_id, decision_key, created_at, updated_at, version
             ) VALUES (?1, ?2, 'parked', ?3, 'f1', ?4, ?5, ?5, 1)",
            params![id, project, run_id, decision_key, created_at],
        )
        .unwrap();
}

fn ask_gate(store: &SessionStore, project: &str, key: &str) {
    crate::decisions::ask(
        &mut store.lock_conn().unwrap(),
        crate::decisions::AskInput {
            asked_by: "fm".into(),
            asked_by_mono: None,
            project: Some(project.into()),
            key: key.into(),
            question: "The check needs a decision.".into(),
            options: vec!["Approve".into(), "Fix".into(), "Skip".into()],
            recommended: None,
            task_ids: Vec::new(),
            keys: Vec::new(),
            force: false,
            reason: None,
        },
        2,
    )
    .unwrap();
}

fn responded(store: &SessionStore, project: &str, key: &str) -> Option<String> {
    store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT responded FROM gate_runs WHERE project = ?1 AND decision_key = ?2",
            [project, key],
            |row| row.get(0),
        )
        .unwrap()
}

/// A chat that knows the run id must not approve `gate/<run>`, in any spelling, and the check's tool hears nothing.
#[test]
fn a_chat_cannot_approve_a_gate_and_nothing_is_forwarded() {
    let _guard = guard();
    let dir = Temp::new();
    let log = dir.path().join("tool.log");
    use_script(dir.path(), &log, r#"{"outcome":"parked"}"#);
    let store = store();
    let alpha = "proj-alpha";
    let beta = "proj-beta";
    ask_gate(&store, alpha, "gate/r1");
    park(&store, "run-a", alpha, "r-alpha", "gate/r1", 10);
    park(&store, "run-b", beta, "r-beta", "gate/r1", 20);
    let spellings = [
        "gate/r1",
        "GATE/r1",
        "Gate/r1",
        " gate/r1",
        "ｇａｔｅ/r1",
        "gate／r1",
        "g\u{200B}ate/r1",
        "\u{200B}gate/r1",
        "gate\u{200B}/r1",
        "\u{FEFF}gate/r1",
    ];
    for key in spellings {
        for by in ["chat:s1", "autopilot"] {
            let refusal = crate::decisions::answer_and_relay(
                &store,
                alpha,
                key,
                "approve",
                Some(by.into()),
                None,
                3,
            )
            .unwrap_err();
            assert!(
                refusal.contains("Only the person answers the check"),
                "{key:?} by {by}: {refusal}"
            );
        }
    }
    let open = crate::decisions::get(&store.lock_conn().unwrap(), alpha, "gate/r1")
        .unwrap()
        .unwrap();
    assert_eq!(open.state, crate::decisions::OPEN);
    assert_eq!(responded(&store, alpha, "gate/r1"), None);
    assert_eq!(responded(&store, beta, "gate/r1"), None);
    assert!(
        !log_of(&log).contains("r-alpha") && !log_of(&log).contains("r-beta"),
        "{}",
        log_of(&log)
    );
}

/// No open decision means nothing is sent on: a missing key, and a key that was already answered.
#[test]
fn an_answer_on_a_decision_that_is_not_open_forwards_nothing() {
    let _guard = guard();
    let dir = Temp::new();
    let log = dir.path().join("tool.log");
    use_script(dir.path(), &log, r#"{"outcome":"parked"}"#);
    let store = store();
    let alpha = "proj-alpha";
    park(
        &store,
        "run-missing",
        alpha,
        "r-missing",
        "gate/missing",
        10,
    );
    let missing = crate::decisions::answer_and_relay(
        &store,
        alpha,
        "gate/missing",
        "approve",
        Some("user".into()),
        None,
        3,
    )
    .unwrap();
    assert!(!missing.applied);
    assert!(missing.decision.is_none());
    assert_eq!(responded(&store, alpha, "gate/missing"), None);

    ask_gate(&store, alpha, "gate/r1");
    park(&store, "run-a", alpha, "r-alpha", "gate/r1", 11);
    // Land the answer without the relay, so the run is still waiting. A second answer must not send it on.
    assert!(
        crate::decisions::answer(
            &mut store.lock_conn().unwrap(),
            alpha,
            "gate/r1",
            "approve",
            Some("user".into()),
            4,
        )
        .unwrap()
        .applied
    );
    assert_eq!(responded(&store, alpha, "gate/r1"), None);
    let again = crate::decisions::answer_and_relay(
        &store,
        alpha,
        "gate/r1",
        "skip",
        Some("person".into()),
        None,
        5,
    )
    .unwrap();
    assert!(!again.applied);
    assert_eq!(responded(&store, alpha, "gate/r1"), None);

    // The same hold if the refusal in front of the relay is skipped: a chat-shaped outcome is not forwarded.
    let stored = again.decision.clone().unwrap();
    let mut chat_shaped = stored.clone();
    chat_shaped.answered_by = Some("chat:s1".into());
    crate::decisions::relay_gate_answer(
        &store,
        &crate::decisions::AnswerOutcome {
            applied: true,
            decision: Some(chat_shaped),
            released: Vec::new(),
            released_tasks: Vec::new(),
        },
        "approve",
    );
    crate::decisions::relay_gate_answer(
        &store,
        &crate::decisions::AnswerOutcome {
            applied: false,
            decision: Some(stored),
            released: Vec::new(),
            released_tasks: Vec::new(),
        },
        "approve",
    );
    assert_eq!(responded(&store, alpha, "gate/r1"), None);
    assert!(!log_of(&log).contains("r-alpha"), "{}", log_of(&log));
    assert!(!log_of(&log).contains("r-missing"), "{}", log_of(&log));
}

/// The person's answer still reaches the check, and only the run in that project.
#[test]
fn the_persons_answer_still_forwards_and_another_projects_run_does_not() {
    let _guard = guard();
    let dir = Temp::new();
    let log = dir.path().join("tool.log");
    use_script(dir.path(), &log, r#"{"outcome":"parked"}"#);
    let store = store();
    let alpha = "proj-alpha";
    let beta = "proj-beta";
    ask_gate(&store, alpha, "gate/r1");
    park(&store, "run-a", alpha, "r-alpha", "gate/r1", 10);
    // Newer, and the same key, but another project. A lookup by key alone would send this one.
    park(&store, "run-b", beta, "r-beta", "gate/r1", 20);
    let out = crate::decisions::answer_and_relay(
        &store,
        alpha,
        "GATE/r1",
        "approve",
        Some("user".into()),
        None,
        30,
    )
    .unwrap();
    assert!(out.applied);
    assert_eq!(out.decision.as_ref().unwrap().decision_key, "gate/r1");
    assert_eq!(
        responded(&store, alpha, "gate/r1").as_deref(),
        Some("approve")
    );
    assert_eq!(responded(&store, beta, "gate/r1"), None);
    let text = log_of(&log);
    assert!(text.contains("\"--run\",\"r-alpha\""), "{text}");
    assert!(text.contains("\"--action\",\"approve\""), "{text}");
    assert!(!text.contains("r-beta"), "{text}");

    // Nobody named, and the word "person", are the person too.
    for (key, run_id, by) in [
        ("gate/r2", "r-none", None),
        ("gate/r3", "r-person", Some("person".into())),
    ] {
        ask_gate(&store, alpha, key);
        park(&store, run_id, alpha, run_id, key, 40);
        let landed =
            crate::decisions::answer_and_relay(&store, alpha, key, "fix", by, None, 41).unwrap();
        assert!(landed.applied, "{key}");
        assert_eq!(responded(&store, alpha, key).as_deref(), Some("fix"));
        let text = log_of(&log);
        assert!(text.contains(&format!("\"--run\",\"{run_id}\"")), "{text}");
        assert!(text.contains("\"--action\",\"fix\""), "{text}");
        assert!(text.contains("\"--findings\""), "{text}");
    }
}

#[cfg(windows)]
#[test]
fn the_daemon_command_and_environment_stay_allow_listed() {
    let _guard = guard();
    std::env::set_var("HIVRA_SECRET_NOT_ALLOWED", "sekrit");
    let home = Path::new("C:/hivra nm/cafe");
    let args = daemon_args(home);
    assert!(args.iter().all(|arg| arg != "start" && arg != "uninstall"));
    let keys = tool_env_keys();
    assert!(
        !keys.iter().any(|key| key == "HIVRA_SECRET_NOT_ALLOWED"),
        "{keys:?}"
    );
    assert!(keys.iter().any(|key| key == "NM_HOME"));
    assert!(keys.iter().any(|key| key == "NM_TEST_START_DAEMON"));
    assert!(keys.iter().any(|key| key == "NO_MISTAKES_NO_UPDATE_CHECK"));
    assert!(keys.iter().any(|key| key == "NO_MISTAKES_TELEMETRY"));
}
