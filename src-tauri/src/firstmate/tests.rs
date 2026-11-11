//! Hivra WP-10's "Done when": depth 3 is refused, `derive_status` covers every state, stall kind, question owner and gate
//! result, a worker's report is typed with its opinion kept apart, and a first-mate turn that edits the main checkout is
//! flagged (driven by the fake Claude CLI, scripts/fake-claude.mjs).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::checkout_guard;
use super::report::{self, CheckOutcome};
use super::status::{derive_status, DerivedStatus, GateVerdict, Status};
use super::*;
use crate::delegations::{
    cancel, record, set_gate_verdict, set_question, set_stall, settle, Delegation, RecordInput,
    SettleInput, StallInput, COMPLETED, FAILED,
};
use crate::session_store::SessionStore;

fn store() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn launch(owner: &str, request: &str, child: &str) -> RecordInput {
    RecordInput {
        owner_session: owner.into(),
        request_id: request.into(),
        child_session: child.into(),
        title: Some("Fix the save bug".into()),
        brief: Some("Fix the save bug on mission two".into()),
        ..Default::default()
    }
}

fn finish(row: &Delegation, state: &str) -> SettleInput {
    SettleInput {
        id: row.id.clone(),
        generation: row.generation,
        state: state.into(),
        result: Some("All done.".into()),
        ..Default::default()
    }
}

fn status(row: &Delegation, gates: GateVerdict) -> (Status, Option<String>) {
    let DerivedStatus { status, notice } = derive_status(row, gates);
    (status, notice)
}

// ---- depth ---------------------------------------------------------------------------------------------------------

#[test]
fn depth_three_is_refused_with_a_plain_reason() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    // The person talks to the Mono; nothing is above it.
    assert_eq!(check_depth(&conn, "mono").unwrap(), 1);
    // The Mono briefs a Lead (depth 1); the Lead's worker is depth 2.
    record(&mut conn, launch("mono", "r1", "lead"), 1).unwrap();
    assert_eq!(check_depth(&conn, "lead").unwrap(), 2);
    record(&mut conn, launch("lead", "r2", "worker"), 2).unwrap();
    // The worker's own delegation would be depth 3.
    let refused = check_depth(&conn, "worker").unwrap_err();
    assert!(refused.contains("3 levels deep"), "{refused}");
    assert!(refused.contains("at 2"), "{refused}");
    // A sibling of the Lead's worker is still fine.
    assert_eq!(check_depth(&conn, "lead").unwrap(), 2);
}

#[test]
fn a_pick_at_the_fanout_cap_still_reads_the_depth() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    for n in 0..8 {
        record(
            &mut conn,
            launch("mono", &format!("r{n}"), &format!("child-{n}")),
            n + 1,
        )
        .unwrap();
    }
    let blocked = depth_and_fanout(&conn, "mono", true).unwrap_err();
    assert!(blocked.starts_with("Not started:"), "{blocked}");
    assert_eq!(depth_and_fanout(&conn, "mono", false).unwrap(), 1);
}

#[test]
fn a_mono_brief_to_a_coding_team_runs_at_depth_two_and_a_third_level_is_refused() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    // The person talks to the Mono. Its followed brief to the coding team is the nested case.
    let brief = record(
        &mut conn,
        RecordInput {
            follow: Some("lead".into()),
            ..launch("mono", "brief", "coding-team")
        },
        1,
    )
    .unwrap();
    assert_eq!(brief.follow.as_deref(), Some("lead"));
    // The coding team sits under the Mono, so the workers it starts are depth 2.
    assert_eq!(check_depth(&conn, "coding-team").unwrap(), 2);
    record(
        &mut conn,
        RecordInput {
            parent_id: Some(brief.id.clone()),
            ..launch("coding-team", "work", "worker")
        },
        2,
    )
    .unwrap();
    let refused = check_depth(&conn, "worker").unwrap_err();
    assert!(refused.contains("3 levels deep"), "{refused}");
    assert!(refused.contains("at 2"), "{refused}");
    // The Mono's own next brief is still depth 1: the coding team's workers are not above it.
    assert_eq!(check_depth(&conn, "mono").unwrap(), 1);
}

#[test]
fn depth_counts_only_open_work_above_the_chat() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let lead = record(&mut conn, launch("mono", "r1", "lead"), 1).unwrap();
    record(&mut conn, launch("lead", "r2", "worker"), 2).unwrap();
    // The Mono's brief to the Lead finished: the Lead is the chat the person talks to again.
    settle(&mut conn, finish(&lead, COMPLETED), 3).unwrap();
    assert_eq!(delegations::depth_above(&conn, "lead").unwrap(), 0);
    assert_eq!(check_depth(&conn, "lead").unwrap(), 1);
    // The worker still has its open row, under a finished parent: it counts that chain as it was recorded.
    assert_eq!(delegations::depth_above(&conn, "worker").unwrap(), 2);
}

// ---- derive_status -------------------------------------------------------------------------------------------------

/// The worktree clean-up asks `is_done` of every row without loading it. It must say what the shown status says.
#[test]
fn is_done_agrees_with_the_shown_status_for_every_state_and_verdict() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch("mono", "r1", "child"), 1).unwrap();
    let states = [
        "running",
        "question",
        "completed",
        "failed",
        "cancelled",
        "nonsense",
    ];
    let verdicts = [
        None,
        Some("pending"),
        Some("passed"),
        Some("failed"),
        Some("unsure"),
        Some("odd"),
    ];
    let mut done = 0;
    for state in states {
        for verdict in verdicts {
            let mut shown = row.clone();
            shown.state = state.into();
            shown.gate_verdict = verdict.map(str::to_string);
            let expected = status::status_of(&shown).status == Status::Done;
            assert_eq!(
                status::is_done(state, verdict),
                expected,
                "{state} with {verdict:?}"
            );
            done += usize::from(expected);
        }
    }
    // Completed with no gates or passed gates: the only two that are done.
    assert_eq!(done, 2);
}

#[test]
fn a_running_row_is_working_and_a_judged_stall_is_only_a_notice() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch("mono", "r1", "child"), 1).unwrap();
    assert_eq!(
        status(&row, GateVerdict::NotRequired),
        (Status::Working, None)
    );
    assert_eq!(row.status, Status::Working, "the row carries its status");
    for (kind, lead) in [
        ("quiet", "Quiet for a while"),
        ("loop", "Repeating itself"),
        ("idle", "Stopped without a report"),
    ] {
        let change = set_stall(
            &mut conn,
            StallInput {
                id: row.id.clone(),
                generation: 1,
                kind: Some(kind.into()),
                reason: Some("no output".into()),
                ..Default::default()
            },
            10,
        )
        .unwrap();
        let stalled = change.row.unwrap();
        assert_eq!(stalled.state, "running");
        let (shown, notice) = status(&stalled, GateVerdict::NotRequired);
        assert_eq!(shown, Status::Working, "{kind} is a notice, not a state");
        assert_eq!(
            notice.as_deref(),
            Some(format!("{lead}: no output").as_str())
        );
        assert_eq!(
            (stalled.status, stalled.status_notice.clone()),
            (shown, notice)
        );
    }
}

#[test]
fn a_block_is_the_persons_only_when_the_first_mate_declares_it() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch("lead", "r1", "worker"), 1).unwrap();
    let block = |by: &str| StallInput {
        id: row.id.clone(),
        generation: 1,
        kind: Some("blocked".into()),
        reason: Some("the API key is missing".into()),
        by: Some(by.into()),
        ..Default::default()
    };
    // The worker says it can't finish its own task: its first mate hears it first.
    let by_self = set_stall(&mut conn, block("self:worker"), 2)
        .unwrap()
        .row
        .unwrap();
    let (shown, notice) = status(&by_self, GateVerdict::NotRequired);
    assert_eq!(shown, Status::Working);
    assert!(notice.unwrap().contains("first mate is on it"));
    // Its first mate says it to the person (task_cannot on its own task): needs you.
    let mut by_owner = by_self.clone();
    by_owner
        .log
        .push(serde_json::json!({ "event": "stalled", "kind": "blocked", "by": "owner:lead" }));
    assert_eq!(
        status(&by_owner, GateVerdict::NotRequired),
        (
            Status::NeedsYou,
            Some("Cannot finish: the API key is missing".into())
        )
    );
    // A block whose log line is gone keeps the old meaning: the person's.
    let mut unknown = by_self.clone();
    unknown.log.clear();
    assert_eq!(
        status(&unknown, GateVerdict::NotRequired).0,
        Status::NeedsYou
    );
}

#[test]
fn a_question_goes_to_the_first_mate_first_and_needs_you_once_passed_on() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch("lead", "r1", "worker"), 1).unwrap();
    let asked = set_question(&mut conn, &row.id, Some("Which port?".into()), None, 2)
        .unwrap()
        .row
        .unwrap();
    assert_eq!(
        (asked.status, asked.status_notice.as_deref()),
        (Status::Working, Some("Asked its first mate: Which port?"))
    );
    // Only an open question of this generation moves; an unknown owner is refused.
    assert!(
        delegations::set_question_owner(&mut conn, &row.id, 2, "person", None, 3)
            .unwrap()
            .row
            .is_some_and(|r| r.question_owner.is_none())
    );
    assert!(delegations::set_question_owner(&mut conn, &row.id, 1, "ash", None, 3).is_err());
    let passed = delegations::set_question_owner(
        &mut conn,
        &row.id,
        1,
        "person",
        Some("owner:lead".into()),
        4,
    )
    .unwrap();
    assert!(passed.applied);
    let passed = passed.row.unwrap();
    assert_eq!(
        (passed.status, passed.status_notice.as_deref()),
        (Status::NeedsYou, Some("Question for you: Which port?"))
    );
    // Asking the same again changes nothing.
    assert!(
        !delegations::set_question_owner(&mut conn, &row.id, 1, "person", None, 5)
            .unwrap()
            .applied
    );
    // A new question starts with the first mate again.
    let next = set_question(&mut conn, &row.id, Some("And the host?".into()), None, 6)
        .unwrap()
        .row
        .unwrap();
    assert_eq!(next.status, Status::Working);
    // The answer returns it to work.
    let answered = set_question(&mut conn, &row.id, None, None, 7)
        .unwrap()
        .row
        .unwrap();
    assert_eq!(
        (answered.state.as_str(), answered.status),
        ("running", Status::Working)
    );
}

#[test]
fn completed_is_done_only_once_the_gates_pass() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch("mono", "r1", "child"), 1).unwrap();
    let done = settle(&mut conn, finish(&row, COMPLETED), 2)
        .unwrap()
        .row
        .unwrap();
    assert_eq!(
        status(&done, GateVerdict::NotRequired),
        (Status::Done, None)
    );
    assert_eq!(status(&done, GateVerdict::Passed), (Status::Done, None));
    assert_eq!(status(&done, GateVerdict::Pending).0, Status::Working);
    assert_eq!(
        status(&done, GateVerdict::Failed),
        (
            Status::Failed,
            Some("Finished, but its checks failed".into())
        )
    );
    // The row's own stored verdict is what the shown status reads; an unknown value is never a pass.
    for (stored, shown) in [
        (None, Status::Done),
        (Some("pending"), Status::Working),
        (Some("passed"), Status::Done),
        (Some("failed"), Status::Failed),
        (Some("maybe"), Status::Working),
    ] {
        let mut row = done.clone();
        row.gate_verdict = stored.map(str::to_string);
        assert_eq!(status::status_of(&row).status, shown, "{stored:?}");
    }
}

#[test]
fn a_sent_back_reason_is_the_notice_and_a_stall_still_wins() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch("mono", "r-sent", "child"), 1).unwrap();
    let reason = "Sent back: tests went stale after the last edit.";
    let marked = set_gate_verdict(&mut conn, &row.id, GateVerdict::FAILED, reason, None, 2)
        .unwrap()
        .row
        .unwrap();
    assert_eq!(marked.state, "running");
    assert_eq!(
        status(&marked, GateVerdict::Failed),
        (Status::Working, Some(reason.into())),
        "the fix round stays working, with the reason"
    );
    assert_eq!(status::status_of(&marked).notice.as_deref(), Some(reason));
    // A pass, or a check still running, does not keep showing an older failure.
    assert_eq!(status(&marked, GateVerdict::Passed).1, None);
    assert_eq!(status(&marked, GateVerdict::Pending).1, None);

    let quiet = set_stall(
        &mut conn,
        StallInput {
            id: marked.id.clone(),
            generation: marked.generation,
            kind: Some("quiet".into()),
            reason: Some("no output".into()),
            ..Default::default()
        },
        3,
    )
    .unwrap()
    .row
    .unwrap();
    let (shown, notice) = status(&quiet, GateVerdict::Failed);
    assert_eq!(shown, Status::Working);
    assert_eq!(notice.as_deref(), Some("Quiet for a while: no output"));

    let other = record(&mut conn, launch("mono", "r-done", "child-2"), 4).unwrap();
    let listed = "Sent back: a check failed this turn (npm test). Also 1 more.\nA check failed this turn (npm test).";
    let open = set_gate_verdict(&mut conn, &other.id, GateVerdict::FAILED, listed, None, 5)
        .unwrap()
        .row
        .unwrap();
    // The status rule itself: a completed row whose verdict is still failed shows the reason.
    let mut held = open.clone();
    held.state = COMPLETED.into();
    assert_eq!(
        status(&held, GateVerdict::Failed),
        (
            Status::Failed,
            Some("Sent back: a check failed this turn (npm test). Also 1 more.".into())
        )
    );
    // Delivering the fix clears that failure. The log keeps the reason.
    let done = settle(&mut conn, finish(&open, COMPLETED), 6)
        .unwrap()
        .row
        .unwrap();
    assert_eq!(done.status, Status::Done);
    assert!(done.status_notice.is_none());

    let mut poisoned = done.clone();
    poisoned.log.push(serde_json::json!({
        "event": "gates",
        "verdict": "failed",
        "summary": "Sent back: tests\u{7}went stale."
    }));
    assert_eq!(
        status(&poisoned, GateVerdict::Failed),
        (
            Status::Failed,
            Some("Finished, but its checks failed".into())
        ),
        "a control character is not a reason"
    );
    let mut blank = done.clone();
    blank.log.push(serde_json::json!({
        "event": "gates",
        "verdict": "failed",
        "summary": "Sent back:   "
    }));
    assert_eq!(
        status(&blank, GateVerdict::Failed).1.as_deref(),
        Some("Finished, but its checks failed")
    );
    let mut long = done;
    long.log.push(serde_json::json!({
        "event": "gates",
        "verdict": "failed",
        "summary": format!("Sent back: {}", "x".repeat(200))
    }));
    assert_eq!(
        status(&long, GateVerdict::Failed).1.as_deref(),
        Some("Finished, but its checks failed")
    );
}

#[test]
fn a_usage_limit_is_paused_and_any_other_failure_failed() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("mono", "r1", "a"), 1).unwrap();
    let mut limit = finish(&a, FAILED);
    limit.error_class = Some("usage_limit".into());
    limit.resets_at = Some(10_000);
    let paused = settle(&mut conn, limit, 2).unwrap().row.unwrap();
    assert_eq!(paused.status, Status::Paused);
    // A usage-limit class alone pauses too; one marked unretryable is a failure.
    let mut class_only = paused.clone();
    class_only.resets_at = None;
    assert_eq!(
        status(&class_only, GateVerdict::NotRequired).0,
        Status::Paused
    );
    let mut dead = paused.clone();
    dead.retryable = Some(false);
    assert_eq!(status(&dead, GateVerdict::NotRequired).0, Status::Failed);

    let b = record(&mut conn, launch("mono", "r2", "b"), 3).unwrap();
    let mut broke = finish(&b, FAILED);
    broke.error = Some("The build broke.".into());
    let failed = settle(&mut conn, broke, 4).unwrap().row.unwrap();
    assert_eq!(
        (failed.status, failed.status_notice.as_deref()),
        (Status::Failed, Some("The build broke."))
    );
}

#[test]
fn a_stop_and_a_take_over_are_failed_with_what_happened() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let first = record(&mut conn, launch("mono", "r1", "child"), 1).unwrap();
    // A later request to the same chat takes it over.
    record(&mut conn, launch("mono", "r2", "child"), 2).unwrap();
    let rows = delegations::owned(
        &conn,
        delegations::OwnedQuery {
            owner_session: "mono".into(),
            ids: vec![first.id.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        (rows[0].status, rows[0].status_notice.as_deref()),
        (Status::Failed, Some("Taken over by a later request"))
    );
    let other = record(&mut conn, launch("mono", "r3", "other"), 3).unwrap();
    let stopped = cancel(
        &mut conn,
        std::slice::from_ref(&other.id),
        Some("Stopped".into()),
        Some("user".into()),
        4,
    )
    .unwrap();
    assert_eq!(
        (stopped[0].status, stopped[0].status_notice.as_deref()),
        (Status::Failed, Some("Stopped"))
    );
}

#[test]
fn an_unknown_state_is_never_shown_as_going_well() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let mut row = record(&mut conn, launch("mono", "r1", "child"), 1).unwrap();
    row.state = "exploded".into();
    assert_eq!(status(&row, GateVerdict::Passed).0, Status::Failed);
}

#[test]
fn every_status_serializes_in_the_words_the_ui_reads() {
    let words: Vec<String> = [
        Status::Working,
        Status::NeedsYou,
        Status::Done,
        Status::Failed,
        Status::Paused,
    ]
    .iter()
    .map(|s| {
        serde_json::to_value(s)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    })
    .collect();
    assert_eq!(words, ["working", "needs-you", "done", "failed", "paused"]);
}

#[test]
fn an_older_store_gets_the_contract_columns() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // A store from before WP-10: no question_owner, gate_verdict or report.
    conn.execute_batch(
        "CREATE TABLE delegations (id TEXT PRIMARY KEY, owner_session TEXT NOT NULL, owner_mono TEXT, batch_id TEXT,
           parent_id TEXT, root_id TEXT NOT NULL, child_session TEXT NOT NULL, request_id TEXT NOT NULL,
           generation INTEGER NOT NULL DEFAULT 1, project TEXT, title TEXT, brief TEXT, goal TEXT,
           ask_ids TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, error_class TEXT, error TEXT, retryable INTEGER,
           resets_at INTEGER, result TEXT, pending_question TEXT, delivery TEXT NOT NULL, delivery_message TEXT,
           created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER, log TEXT NOT NULL DEFAULT '[]',
           version INTEGER NOT NULL DEFAULT 1, mirrored_version INTEGER NOT NULL DEFAULT 0, mirror_error TEXT,
           follow TEXT, stall_kind TEXT, stall_reason TEXT, stalled_at INTEGER,
           review_required INTEGER NOT NULL DEFAULT 0, self_review TEXT,
           UNIQUE (owner_session, request_id));",
    )
    .unwrap();
    delegations::ensure_tables(&conn).unwrap();
    for column in ["question_owner", "gate_verdict", "report"] {
        assert!(conn
            .prepare(&format!(
                "SELECT 1 FROM pragma_table_info('delegations') WHERE name = '{column}'"
            ))
            .unwrap()
            .exists([])
            .unwrap());
    }
}

// ---- the worker's report -------------------------------------------------------------------------------------------

const REPORT: &str = "Fixed it.\n\n## Report\nSummary: Saving on mission two works again.\nFiles changed:\n- src/save.ts\n\
- src/save.test.ts\nChecks:\n- npm test: passed (14 passed)\n- `npm run test:unit`: failed (2 failed)\n- cargo test\n\
Evidence:\n- https://github.com/ashneil12/hivra-hub/pull/7\n- It works now, I'm confident.\n- src/save.ts:42\n\
Open questions:\n- none\n\n## Self-review\nChecked: the save path\nHow: ran the tests\nUnsure: the cloud sync\n";

#[test]
fn a_report_is_typed_and_the_workers_opinion_is_never_evidence() {
    let r = report::parse(REPORT);
    assert_eq!(
        r.summary.as_deref(),
        Some("Saving on mission two works again.")
    );
    assert_eq!(r.files_changed, ["src/save.ts", "src/save.test.ts"]);
    let checks: Vec<(&str, CheckOutcome)> = r
        .checks
        .iter()
        .map(|c| (c.command.as_str(), c.outcome))
        .collect();
    assert_eq!(
        checks,
        [
            ("npm test", CheckOutcome::Passed),
            ("npm run test:unit", CheckOutcome::Failed),
            ("cargo test", CheckOutcome::NotRun),
        ]
    );
    assert_eq!(r.checks[0].detail.as_deref(), Some("14 passed"));
    assert_eq!(
        r.evidence,
        [
            "https://github.com/ashneil12/hivra-hub/pull/7",
            "src/save.ts:42"
        ]
    );
    assert!(r.open_questions.is_empty());
    assert!(r
        .self_assessment
        .iter()
        .any(|line| line.contains("I'm confident")));
    assert!(r
        .self_assessment
        .iter()
        .any(|line| line.starts_with("Checked:")));
    assert!(r.missing.is_empty(), "{:?}", r.missing);
}

#[test]
fn a_report_without_its_block_says_what_is_missing() {
    let none = report::parse("I fixed it, trust me.");
    assert_eq!(none.missing, ["report"]);
    let partial = report::parse("## Report\nSummary: half of it\nChecks:\n- npm test: ok\n");
    assert_eq!(partial.missing, ["files", "evidence", "questions"]);
    assert_eq!(partial.checks[0].outcome, CheckOutcome::Passed);
}

#[test]
fn a_settled_row_keeps_the_typed_report() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch("mono", "r1", "child"), 1).unwrap();
    let mut done = finish(&row, COMPLETED);
    done.result = Some(REPORT.into());
    let settled = settle(&mut conn, done, 2).unwrap().row.unwrap();
    let stored: serde_json::Value =
        serde_json::from_str(settled.report.as_deref().unwrap()).unwrap();
    assert_eq!(stored["filesChanged"][0], "src/save.ts");
    assert_eq!(stored["checks"][1]["outcome"], "failed");
    // It survives a read back from the store.
    let again = delegations::tree(&conn, &row.id).unwrap();
    assert_eq!(again[0].report, settled.report);
}

// ---- the checkout guard, with the fake Claude CLI ---------------------------------------------------------------------

struct Repo(PathBuf);

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

fn repo(name: &str) -> Repo {
    let dir = std::env::temp_dir().join(format!("hivra-guard-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    run(&dir, &["init", "-q"]);
    // Byte-exact checkouts on every OS (Windows runners default to autocrlf, which a restore would apply).
    run(&dir, &["config", "core.autocrlf", "false"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    std::fs::write(dir.join("notes.md"), "mine\n").unwrap();
    run(&dir, &["add", "."]);
    run(&dir, &["commit", "-q", "-m", "start"]);
    Repo(dir)
}

/// One turn of scripts/fake-claude.mjs in `dir`, playing `steps`, the way the app runs the CLI.
fn fake_turn(dir: &Path, steps: serde_json::Value) {
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-claude.mjs");
    let state = dir.with_extension("fake-state");
    std::fs::create_dir_all(&state).unwrap();
    let rules = state.join("rules.json");
    std::fs::write(
        &rules,
        serde_json::json!({ "version": 1, "rules": [{ "name": "turn", "match": ".", "steps": steps }] }).to_string(),
    )
    .unwrap();
    let mut child = Command::new("node")
        .arg(&fake)
        .args([
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
        ])
        .current_dir(dir)
        .env("FAKE_CLAUDE_SCENARIO", &rules)
        .env("FAKE_CLAUDE_STATE", &state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("node runs scripts/fake-claude.mjs");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(
            stdin,
            "{}",
            serde_json::json!({ "type": "user", "message": { "role": "user", "content": "Look at the README." } })
        )
        .unwrap();
    }
    drop(child.stdin.take());
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "fake claude: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("\"type\":\"result\""),
        "a turn ends with a result: {stdout}"
    );
    let _ = std::fs::remove_dir_all(&state);
}

#[test]
fn a_first_mate_turn_that_edits_the_main_checkout_is_flagged() {
    let repo = repo("edit");
    let before = checkout_guard::snapshot(&repo.0).unwrap();
    fake_turn(
        &repo.0,
        serde_json::json!([
            { "say": "I'll just fix it myself." },
            { "write": { "path": "README.md", "text": "edited by the first mate\n" } },
            { "write": { "path": "src/new.ts", "text": "export {};\n" } }
        ]),
    );
    let flag = checkout_guard::check(&before)
        .unwrap()
        .expect("the turn is flagged");
    let paths: Vec<(&str, bool)> = flag
        .changed
        .iter()
        .map(|c| (c.path.as_str(), c.revertable))
        .collect();
    assert_eq!(paths, [("README.md", true), ("src/new.ts", true)]);
    assert!(flag.head_moved.is_none());
    assert!(flag.summary.contains("2 files"));
    // Offered for revert, and the revert puts the checkout back as the turn found it.
    let outcome =
        checkout_guard::revert(&before, &flag, &["README.md".into(), "src/new.ts".into()]).unwrap();
    assert_eq!(outcome.reverted, ["README.md", "src/new.ts"]);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("README.md")).unwrap(),
        "hello\n"
    );
    assert!(!repo.0.join("src/new.ts").exists());
    assert!(checkout_guard::check(&before).unwrap().is_none());
}

#[test]
fn a_revert_never_undoes_an_edit_made_after_the_flag() {
    let repo = repo("later-edit");
    let before = checkout_guard::snapshot(&repo.0).unwrap();
    fake_turn(
        &repo.0,
        serde_json::json!([
            { "write": { "path": "README.md", "text": "edited by the first mate\n" } },
            { "write": { "path": "scratch.ts", "text": "export {};\n" } }
        ]),
    );
    let flag = checkout_guard::check(&before).unwrap().expect("flagged");
    // The person keeps working on README.md after the turn ended, before tapping revert.
    std::fs::write(repo.0.join("README.md"), "the person's later words\n").unwrap();
    let outcome =
        checkout_guard::revert(&before, &flag, &["README.md".into(), "scratch.ts".into()]).unwrap();
    assert_eq!(outcome.reverted, ["scratch.ts"]);
    assert_eq!(outcome.skipped.len(), 1);
    assert!(outcome.skipped[0]
        .why_not
        .as_deref()
        .unwrap()
        .contains("changed again"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("README.md")).unwrap(),
        "the person's later words\n"
    );
}

#[test]
fn a_first_mate_turn_that_only_reads_is_not_flagged() {
    let repo = repo("read");
    let before = checkout_guard::snapshot(&repo.0).unwrap();
    fake_turn(
        &repo.0,
        serde_json::json!([{ "say": "The README says hello." }]),
    );
    assert_eq!(checkout_guard::check(&before).unwrap(), None);
}

#[test]
fn a_landing_explains_its_files_and_the_persons_own_edits_are_never_reverted() {
    let repo = repo("landing");
    // The person had their own edit in progress before the turn.
    std::fs::write(repo.0.join("notes.md"), "mine, half written\n").unwrap();
    let before = checkout_guard::snapshot(&repo.0).unwrap();
    fake_turn(
        &repo.0,
        serde_json::json!([
            { "write": { "path": "landed.ts", "text": "from a worker\n" } },
            { "write": { "path": "notes.md", "text": "overwritten by the first mate\n" } }
        ]),
    );
    // The app landed a worker's landed.ts during the turn: not the first mate's edit.
    checkout_guard::note_landing_for_test(&repo.0, &["landed.ts".into()], before.taken_at + 1);
    let flag = checkout_guard::check(&before)
        .unwrap()
        .expect("notes.md is flagged");
    assert_eq!(flag.changed.len(), 1);
    assert_eq!(flag.changed[0].path, "notes.md");
    assert!(
        !flag.changed[0].revertable,
        "it had the person's uncommitted edit"
    );
    let outcome =
        checkout_guard::revert(&before, &flag, &["notes.md".into(), "landed.ts".into()]).unwrap();
    assert!(outcome.reverted.is_empty());
    assert_eq!(outcome.skipped.len(), 2);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("notes.md")).unwrap(),
        "overwritten by the first mate\n",
        "nothing was put back over the person's work"
    );
}

#[test]
fn a_commit_during_a_first_mate_turn_is_flagged_and_never_rewritten() {
    let repo = repo("commit");
    let before = checkout_guard::snapshot(&repo.0).unwrap();
    std::fs::write(repo.0.join("README.md"), "committed\n").unwrap();
    run(&repo.0, &["commit", "-qam", "first mate commit"]);
    let flag = checkout_guard::check(&before).unwrap().expect("flagged");
    assert!(flag.head_moved.is_some());
    assert_eq!(flag.changed[0].path, "README.md");
    assert!(!flag.changed[0].revertable);
}
