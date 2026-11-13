//! SC-7: what is still open under a first mate, for the hold on its "done" (docs/specs/shipping-confidence-gap-spec.md
//! section 4c item 6, the MAMUBench predicate). A first mate that tells the person the work is done while one of its tasks
//! is still going, or failed and not taken up again, or while a worker's question waits unanswered, is held by the app
//! (`src/features/firstmate/model/doneHold.ts` asks this, once its turn ends).
//!
//! The rows are the delegation rows and the status is `status::status_of`, the one place a status is computed. A task is
//! open when it works, needs the person, or is paused for a usage limit. A failed one is open unless it was cancelled (the
//! first mate stopped it on purpose) or redone (a later task took it on: `delegations::note_redo` leaves a `lead_redo`
//! line). A done task is not open. A worker's question is unanswered while its row is in the `question` state.

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::status::{self, Status};
use crate::delegations::{self, Delegation};
use crate::session_store::SessionStore;

/// The most open tasks and questions named; a first mate with more than this has plenty to finish.
pub const MAX_OPEN: usize = 50;
const MAX_TITLE: usize = 80;

/// One open task.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OpenTask {
    pub id: String,
    pub title: String,
    /// `working`, `needs-you`, `paused` or `failed`.
    pub status: &'static str,
}

/// A worker's question its first mate has not answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unanswered {
    pub task_id: String,
    pub title: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct OpenWork {
    pub tasks: Vec<OpenTask>,
    pub unanswered: Vec<Unanswered>,
}

/// A row's name for the person: its title, else the first line of its brief, else a plain word. One line, no control
/// characters (it is untrusted text on its way into a message), cut short.
fn title_of(row: &Delegation) -> String {
    let named = |text: Option<&str>| -> Option<String> {
        let line: String = text?
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())?
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_TITLE)
            .collect();
        let line = line.trim().to_string();
        (!line.is_empty()).then_some(line)
    };
    named(row.title.as_deref())
        .or_else(|| named(row.brief.as_deref()))
        .unwrap_or_else(|| "Untitled task".to_string())
}

/// A later task took this one on (`delegations::note_redo`).
fn redone(row: &Delegation) -> bool {
    row.log
        .iter()
        .any(|entry| entry.get("event").and_then(Value::as_str) == Some("lead_redo"))
}

/// What is open among `rows` (one first mate's, oldest first).
pub fn open_work(rows: &[Delegation]) -> OpenWork {
    let mut work = OpenWork::default();
    for row in rows {
        let word = match status::status_of(row).status {
            Status::Working => "working",
            Status::NeedsYou => "needs-you",
            Status::Paused => "paused",
            Status::Failed if row.state == delegations::CANCELLED || redone(row) => continue,
            Status::Failed => "failed",
            Status::Done => continue,
        };
        work.tasks.push(OpenTask {
            id: row.id.clone(),
            title: title_of(row),
            status: word,
        });
        if row.state == delegations::QUESTION {
            work.unanswered.push(Unanswered {
                task_id: row.id.clone(),
                title: title_of(row),
            });
        }
    }
    // Bounded, and the newest are the ones kept: `rows` run oldest first.
    let cut = work.tasks.len().saturating_sub(MAX_OPEN);
    work.tasks.drain(..cut);
    let cut = work.unanswered.len().saturating_sub(MAX_OPEN);
    work.unanswered.drain(..cut);
    work
}

/// What is open under one first mate's chat. Read-only.
#[tauri::command(async)]
pub fn firstmate_open_work(
    store: State<'_, SessionStore>,
    owner_session: String,
) -> Result<OpenWork, String> {
    let rows = delegations::of_owner(&*store.lock_conn()?, &owner_session)?;
    Ok(open_work(&rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delegations::{
        record, set_gate_verdict, set_question, settle, RecordInput, SettleInput,
    };
    use rusqlite::Connection;

    const OWNER: &str = "mono-exo";

    fn start(
        conn: &mut Connection,
        owner: &str,
        request: &str,
        title: Option<&str>,
        at: i64,
    ) -> Delegation {
        record(
            conn,
            RecordInput {
                owner_session: owner.into(),
                request_id: request.into(),
                child_session: format!("app-{request}"),
                title: title.map(str::to_string),
                brief: Some("Fix the save bug\nOn mission two".into()),
                ..Default::default()
            },
            at,
        )
        .unwrap()
    }

    fn end(conn: &mut Connection, id: &str, state: &str, error: Option<&str>) {
        settle(
            conn,
            SettleInput {
                id: id.into(),
                generation: 1,
                state: state.into(),
                result: Some("report".into()),
                error: error.map(str::to_string),
                ..Default::default()
            },
            50,
        )
        .unwrap();
    }

    fn of(conn: &Connection, owner: &str) -> OpenWork {
        open_work(&delegations::of_owner(conn, owner).unwrap())
    }

    fn named(work: &OpenWork) -> Vec<(String, &'static str)> {
        work.tasks
            .iter()
            .map(|t| (t.title.clone(), t.status))
            .collect()
    }

    #[test]
    fn a_running_task_is_open_and_a_done_one_is_not() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let running = start(&mut conn, OWNER, "r-1", Some("Fix the save bug"), 10);
        let finished = start(&mut conn, OWNER, "r-2", Some("Add the export"), 11);
        end(&mut conn, &finished.id, "completed", None);
        let work = of(&conn, OWNER);
        assert_eq!(named(&work), [("Fix the save bug".to_string(), "working")]);
        assert_eq!(work.tasks[0].id, running.id);
        assert!(work.unanswered.is_empty());
    }

    #[test]
    fn a_failed_task_is_open_until_it_is_redone_or_cancelled() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let failed = start(&mut conn, OWNER, "r-1", Some("Add the export"), 10);
        end(&mut conn, &failed.id, "failed", Some("it crashed"));
        assert_eq!(
            named(&of(&conn, OWNER)),
            [("Add the export".to_string(), "failed")]
        );
        // A later task takes it on: the failed one is no longer a loose end, and the new one is open on its own.
        let again = start(&mut conn, OWNER, "r-2", Some("Add the export, again"), 20);
        delegations::note_redo(&mut conn, OWNER, &failed.id, &again.id, 21).unwrap();
        assert_eq!(
            named(&of(&conn, OWNER)),
            [("Add the export, again".to_string(), "working")]
        );
        end(&mut conn, &again.id, "completed", None);
        assert!(of(&conn, OWNER).tasks.is_empty());
        // A task the first mate stopped on purpose is not open either.
        let stopped = start(&mut conn, OWNER, "r-3", Some("Try the old way"), 30);
        delegations::cancel(
            &mut conn,
            &[stopped.id.clone()],
            Some("not needed".into()),
            None,
            31,
        )
        .unwrap();
        assert!(of(&conn, OWNER).tasks.is_empty());
    }

    #[test]
    fn a_task_whose_checks_failed_or_are_running_is_open_and_one_that_passed_is_not() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let checks_failed = start(&mut conn, OWNER, "r-1", Some("Failed checks"), 10);
        let checks_running = start(&mut conn, OWNER, "r-2", Some("Running checks"), 11);
        let checks_passed = start(&mut conn, OWNER, "r-3", Some("Passed checks"), 12);
        for (row, verdict) in [
            (&checks_failed, "failed"),
            (&checks_running, "pending"),
            (&checks_passed, "passed"),
        ] {
            // The gates run while the row is still open; the worker's report then settles it.
            set_gate_verdict(&mut conn, &row.id, verdict, "the checks said so", None, 40).unwrap();
            end(&mut conn, &row.id, "completed", None);
        }
        assert_eq!(
            named(&of(&conn, OWNER)),
            [
                ("Failed checks".to_string(), "failed"),
                ("Running checks".to_string(), "working"),
            ]
        );
    }

    #[test]
    fn a_workers_open_question_is_unanswered_until_it_is_answered() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let asking = start(&mut conn, OWNER, "r-1", Some("Fix the save bug"), 10);
        set_question(
            &mut conn,
            &asking.id,
            Some("Which folder?".into()),
            None,
            20,
        )
        .unwrap();
        let work = of(&conn, OWNER);
        assert_eq!(work.unanswered.len(), 1);
        assert_eq!(work.unanswered[0].task_id, asking.id);
        assert_eq!(
            work.tasks.len(),
            1,
            "the task with the question is open too"
        );
        set_question(&mut conn, &asking.id, None, None, 30).unwrap();
        let after = of(&conn, OWNER);
        assert!(after.unanswered.is_empty());
        assert_eq!(after.tasks.len(), 1, "answered, it is still working");
    }

    #[test]
    fn a_question_passed_to_the_person_is_needs_you_and_still_unanswered() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let asking = start(&mut conn, OWNER, "r-1", Some("Fix the save bug"), 10);
        set_question(
            &mut conn,
            &asking.id,
            Some("Which folder?".into()),
            None,
            20,
        )
        .unwrap();
        delegations::set_question_owner(&mut conn, &asking.id, 1, "person", None, 25).unwrap();
        let work = of(&conn, OWNER);
        assert_eq!(
            named(&work),
            [("Fix the save bug".to_string(), "needs-you")]
        );
        assert_eq!(work.unanswered.len(), 1);
    }

    #[test]
    fn a_task_paused_for_a_usage_limit_is_open() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let row = start(&mut conn, OWNER, "r-1", Some("Big refactor"), 10);
        settle(
            &mut conn,
            SettleInput {
                id: row.id.clone(),
                generation: 1,
                state: "failed".into(),
                error: Some("usage limit".into()),
                error_class: Some("usage_limit".into()),
                resets_at: Some(9_999_999),
                ..Default::default()
            },
            50,
        )
        .unwrap();
        assert_eq!(
            named(&of(&conn, OWNER)),
            [("Big refactor".to_string(), "paused")]
        );
    }

    #[test]
    fn another_chats_tasks_are_never_named() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        start(
            &mut conn,
            "other-mono",
            "r-1",
            Some("Someone else's job"),
            10,
        );
        assert_eq!(of(&conn, OWNER), OpenWork::default());
        assert!(
            delegations::of_owner(&conn, "").is_err(),
            "a blank owner is refused, not read as everyone"
        );
        assert_eq!(of(&conn, "other-mono").tasks.len(), 1);
    }

    #[test]
    fn tasks_come_oldest_first_with_a_plain_title() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        start(&mut conn, OWNER, "r-1", Some("First"), 10);
        start(&mut conn, OWNER, "r-2", None, 11);
        start(
            &mut conn,
            OWNER,
            "r-3",
            Some("  \u{1b}[31mRed\u{7} title  "),
            12,
        );
        let long = "y".repeat(300);
        start(&mut conn, OWNER, "r-4", Some(long.as_str()), 13);
        let titles: Vec<String> = of(&conn, OWNER)
            .tasks
            .into_iter()
            .map(|t| t.title)
            .collect();
        assert_eq!(titles[0], "First");
        assert_eq!(
            titles[1], "Fix the save bug",
            "no title: the first line of the brief"
        );
        assert_eq!(titles[2], "[31mRed title", "control characters are dropped");
        assert_eq!(titles[3].chars().count(), MAX_TITLE);
    }

    #[test]
    fn a_first_mate_with_many_tasks_names_a_bounded_number() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        for n in 0..(MAX_OPEN as i64 + 20) {
            start(
                &mut conn,
                OWNER,
                &format!("r-{n}"),
                Some(&format!("Task {n}")),
                10 + n,
            );
        }
        let work = of(&conn, OWNER);
        assert_eq!(work.tasks.len(), MAX_OPEN);
        // The newest are the ones kept, oldest first.
        assert_eq!(work.tasks.last().map(|t| t.title.as_str()), Some("Task 69"));
    }

    #[test]
    fn it_serializes_the_way_the_webview_reads_it() {
        let work = OpenWork {
            tasks: vec![OpenTask {
                id: "t-1".into(),
                title: "Fix the save bug".into(),
                status: "needs-you",
            }],
            unanswered: vec![Unanswered {
                task_id: "t-1".into(),
                title: "Fix the save bug".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&work).unwrap(),
            serde_json::json!({
                "tasks": [{ "id": "t-1", "title": "Fix the save bug", "status": "needs-you" }],
                "unanswered": [{ "taskId": "t-1", "title": "Fix the save bug" }]
            })
        );
    }
}
