use crate::delegations::{self, RecordInput, SettleInput};
use crate::session_store::SessionStore;
use crate::tasks::store::{self, Actor, CreateInput, UpdateInput};

fn mem() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn person(project: &str) -> Actor {
    Actor {
        id: "person".into(),
        project: project.into(),
        kind: "person".into(),
    }
}

fn launch(owner: &str, request: &str, child: &str) -> RecordInput {
    RecordInput {
        owner_session: owner.into(),
        owner_mono: Some("lead-mono".into()),
        request_id: request.into(),
        child_session: child.into(),
        project: Some("crew".into()),
        title: Some("Fix the save bug".into()),
        brief: Some("Fix the save bug".into()),
        ..Default::default()
    }
}

fn task_id(conn: &rusqlite::Connection, delegation: &str) -> String {
    conn.query_row(
        "SELECT id FROM tasks WHERE delegation_id = ?1",
        [delegation],
        |row| row.get(0),
    )
    .unwrap()
}

fn task(conn: &rusqlite::Connection, delegation: &str) -> store::Task {
    let id = task_id(conn, delegation);
    store::get(conn, &person("crew"), &id).unwrap()
}

fn settle(
    conn: &mut rusqlite::Connection,
    id: &str,
    generation: i64,
    state: &str,
    now: i64,
) -> delegations::Change {
    delegations::settle(
        conn,
        SettleInput {
            id: id.into(),
            generation,
            state: state.into(),
            ..Default::default()
        },
        now,
    )
    .unwrap()
}

#[test]
fn recording_a_delegation_files_a_task_and_settling_it_moves_the_task() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    let row = delegations::record(&mut conn, launch("mate-1", "req-1", "worker-1"), 10).unwrap();
    let filed = task(&conn, &row.id);
    assert_eq!(filed.status, "In progress");
    assert_eq!(filed.assignee.as_deref(), Some("lead-mono"));
    assert_eq!(filed.version, 1);
    assert!(filed
        .activity
        .iter()
        .any(|item| item.kind == "work" && item.text == "recorded"));
    let again = delegations::record(&mut conn, launch("mate-1", "req-1", "worker-1"), 11).unwrap();
    assert_eq!(again, row);
    assert_eq!(task(&conn, &row.id).version, 1);
    let done = settle(&mut conn, &row.id, row.generation, "completed", 20);
    assert!(done.applied);
    assert_eq!(task(&conn, &row.id).status, "Done");
}

#[test]
fn every_delegation_state_lands_on_the_workflow() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    let queued = delegations::record(
        &mut conn,
        RecordInput {
            follow: Some("queue".into()),
            request_id: "req-q".into(),
            ..launch("mate-1", "req-q", "worker-q")
        },
        10,
    )
    .unwrap();
    assert_eq!(task(&conn, &queued.id).status, "Todo");

    let asked =
        delegations::record(&mut conn, launch("mate-1", "req-ask", "worker-ask"), 11).unwrap();
    delegations::set_question(&mut conn, &asked.id, Some("Which one?".into()), None, 12).unwrap();
    let asked_task = task(&conn, &asked.id);
    assert_eq!(asked_task.status, "In progress");
    assert!(asked_task.needs_you);

    for (name, gate) in [
        ("pending", "pending"),
        ("unsure", "unsure"),
        ("unknown", "unknown"),
        ("blank", ""),
    ] {
        let row = delegations::record(
            &mut conn,
            launch("mate-1", &format!("req-{name}"), &format!("worker-{name}")),
            13,
        )
        .unwrap();
        delegations::set_gate_verdict(&mut conn, &row.id, gate, "waiting", None, 14).unwrap();
        settle(&mut conn, &row.id, row.generation, "completed", 15);
        assert_eq!(task(&conn, &row.id).status, "In review", "{name}");
    }

    let failed_gate =
        delegations::record(&mut conn, launch("mate-1", "req-fg", "worker-fg"), 16).unwrap();
    delegations::set_gate_verdict(&mut conn, &failed_gate.id, "failed", "no", None, 17).unwrap();
    settle(
        &mut conn,
        &failed_gate.id,
        failed_gate.generation,
        "completed",
        18,
    );
    let failed_task = task(&conn, &failed_gate.id);
    assert_eq!(failed_task.status, "In progress");
    assert!(failed_task.failed);

    let passed =
        delegations::record(&mut conn, launch("mate-1", "req-pass", "worker-pass"), 19).unwrap();
    delegations::set_gate_verdict(&mut conn, &passed.id, "passed", "yes", None, 20).unwrap();
    settle(&mut conn, &passed.id, passed.generation, "completed", 21);
    assert_eq!(task(&conn, &passed.id).status, "Done");

    let failed =
        delegations::record(&mut conn, launch("mate-1", "req-fail", "worker-fail"), 22).unwrap();
    settle(&mut conn, &failed.id, failed.generation, "failed", 23);
    assert!(task(&conn, &failed.id).failed);

    let cancelled = delegations::record(
        &mut conn,
        RecordInput {
            follow: Some("queue".into()),
            request_id: "req-stop".into(),
            ..launch("mate-1", "req-stop", "worker-stop")
        },
        24,
    )
    .unwrap();
    delegations::set_gate_verdict(&mut conn, &cancelled.id, "pending", "waiting", None, 25)
        .unwrap();
    settle(
        &mut conn,
        &cancelled.id,
        cancelled.generation,
        "cancelled",
        26,
    );
    assert_eq!(task(&conn, &cancelled.id).status, "Cancelled");
}

#[test]
fn a_crews_delegations_nest_under_the_briefs_task() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    let parent = delegations::record(
        &mut conn,
        launch("mate-1", "req-parent", "worker-session"),
        10,
    )
    .unwrap();
    let child = delegations::record(
        &mut conn,
        RecordInput {
            owner_session: "worker-session".into(),
            owner_mono: Some("worker-mono".into()),
            request_id: "req-child".into(),
            child_session: "worker-2".into(),
            project: Some("crew".into()),
            title: Some("The smaller job".into()),
            brief: Some("Do the smaller part".into()),
            ..Default::default()
        },
        11,
    )
    .unwrap();
    let parent_task = task(&conn, &parent.id);
    let child_task = task(&conn, &child.id);
    assert_eq!(
        child_task.parent_id.as_deref(),
        Some(parent_task.id.as_str())
    );
    assert_eq!(child_task.assignee.as_deref(), Some("worker-mono"));
}

#[test]
fn a_persons_task_assigned_to_a_first_mate_starts_a_linked_delegation() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    let filed = store::create(
        &mut conn,
        &person("crew"),
        &CreateInput {
            title: "Pick me".into(),
            assignee: Some("mate-1".into()),
            ..Default::default()
        },
        10,
    )
    .unwrap()
    .task;
    let row = delegations::record(
        &mut conn,
        RecordInput {
            task_id: Some(filed.id.clone()),
            ..launch("mate-1", "req-link", "worker-link")
        },
        11,
    )
    .unwrap();
    let linked = store::get(&conn, &person("crew"), &filed.id).unwrap();
    assert_eq!(linked.delegation_id.as_deref(), Some(row.id.as_str()));
    assert_eq!(linked.status, "In progress");
    let tasks: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tasks, 1);
    let missing = delegations::record(
        &mut conn,
        RecordInput {
            task_id: Some("task-missing".into()),
            ..launch("mate-1", "req-missing", "worker-missing")
        },
        12,
    );
    assert_eq!(missing.unwrap_err(), "No task with that id.");
    let left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM delegations WHERE request_id = 'req-missing'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn a_delegation_cannot_take_a_task_from_another_project() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    let filed = store::create(
        &mut conn,
        &person("other"),
        &CreateInput {
            title: "Theirs".into(),
            ..Default::default()
        },
        10,
    )
    .unwrap()
    .task;
    let taken = delegations::record(
        &mut conn,
        RecordInput {
            task_id: Some(filed.id.clone()),
            ..launch("mate-1", "req-cross", "worker-cross")
        },
        11,
    );
    assert_eq!(taken.unwrap_err(), "That task is in another project.");
    let left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM delegations WHERE request_id = 'req-cross'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
    let still = store::get(&conn, &person("other"), &filed.id).unwrap();
    assert!(still.delegation_id.is_none());
}

#[test]
fn reviving_a_refused_delegation_links_the_persons_task() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    let row = delegations::record(
        &mut conn,
        launch("mate-1", "req-revive", "worker-revive"),
        10,
    )
    .unwrap();
    delegations::refuse(&mut conn, &row.id, None, 11).unwrap();
    conn.execute("DELETE FROM tasks WHERE delegation_id = ?1", [&row.id])
        .unwrap();
    let missing = delegations::record(
        &mut conn,
        RecordInput {
            task_id: Some("task-gone".into()),
            ..launch("mate-1", "req-revive", "worker-revive")
        },
        12,
    );
    assert_eq!(missing.unwrap_err(), "No task with that id.");
    let state: String = conn
        .query_row(
            "SELECT state FROM delegations WHERE id = ?1",
            [&row.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "cancelled");
    let gone: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(gone, 0);
    let filed = store::create(
        &mut conn,
        &person("crew"),
        &CreateInput {
            title: "Pick me".into(),
            ..Default::default()
        },
        13,
    )
    .unwrap()
    .task;
    let revived = delegations::record(
        &mut conn,
        RecordInput {
            task_id: Some(filed.id.clone()),
            ..launch("mate-1", "req-revive", "worker-revive")
        },
        14,
    )
    .unwrap();
    assert_eq!(revived.state, "running");
    let linked = store::get(&conn, &person("crew"), &filed.id).unwrap();
    assert_eq!(linked.delegation_id.as_deref(), Some(revived.id.as_str()));
    let tasks: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tasks, 1);
}

#[test]
fn a_comment_on_an_agent_task_reaches_its_first_mate() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    let row =
        delegations::record(&mut conn, launch("mate-1", "req-note", "worker-note"), 10).unwrap();
    let filed = task(&conn, &row.id);
    store::update(
        &mut conn,
        &person("crew"),
        &UpdateInput {
            id: filed.id.clone(),
            comment: Some("Please look".into()),
            ..Default::default()
        },
        11,
    )
    .unwrap();
    let (text, delegation): (String, String) = conn
        .query_row(
            "SELECT text, delegation_id FROM steer_messages",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(delegation, row.id);
    let number = filed.number;
    assert!(text.starts_with(
        &format!("Comment on task #{number} (this is a comment on the task, not a new instruction):\nPlease look")
    ));
    let wake: String = conn
        .query_row(
            "SELECT text FROM firstmate_wakes WHERE owner_session = 'mate-1' AND kind = 'note'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let number = filed.number;
    assert_eq!(wake, format!("A comment on task #{number}"));
    let too_long = store::update(
        &mut conn,
        &person("crew"),
        &UpdateInput {
            id: filed.id.clone(),
            comment: Some("x".repeat(8_000)),
            ..Default::default()
        },
        12,
    );
    assert_eq!(
        too_long.unwrap_err(),
        "That comment is too long to send on."
    );
    assert_eq!(
        store::get(&conn, &person("crew"), &filed.id)
            .unwrap()
            .comments
            .len(),
        1
    );
}

#[test]
fn a_later_request_cancels_the_older_task_and_a_late_settle_does_not_move_it() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    let older =
        delegations::record(&mut conn, launch("mate-1", "req-old", "same-child"), 10).unwrap();
    let newer =
        delegations::record(&mut conn, launch("mate-1", "req-new", "same-child"), 11).unwrap();
    assert_eq!(task(&conn, &older.id).status, "Cancelled");
    assert_eq!(task(&conn, &newer.id).status, "In progress");
    assert_ne!(task_id(&conn, &older.id), task_id(&conn, &newer.id));
    let late = settle(&mut conn, &newer.id, newer.generation + 1, "completed", 12);
    assert!(!late.applied);
    assert_eq!(task(&conn, &newer.id).status, "In progress");
}

#[test]
fn a_missing_title_or_project_still_files_the_task() {
    let store = mem();
    let mut conn = store.lock_conn().unwrap();
    let from_brief = delegations::record(
        &mut conn,
        RecordInput {
            title: None,
            brief: Some("Überprüfung\r\nnext".into()),
            request_id: "req-brief".into(),
            ..launch("mate-1", "req-brief", "worker-brief")
        },
        10,
    )
    .unwrap();
    let briefed = task(&conn, &from_brief.id);
    assert_eq!(briefed.title, "Überprüfung");
    assert_eq!(briefed.description, "Überprüfung\r\nnext");
    let untitled = delegations::record(
        &mut conn,
        RecordInput {
            title: None,
            brief: None,
            project: None,
            request_id: "req-empty".into(),
            child_session: "worker-empty".into(),
            owner_session: "mate-1".into(),
            ..Default::default()
        },
        11,
    )
    .unwrap();
    let empty = store::get(&conn, &person("none"), &task_id(&conn, &untitled.id)).unwrap();
    assert_eq!(empty.title, "Untitled");
    assert_eq!(empty.project_id, "none");
}

#[test]
fn the_task_and_its_link_survive_opening_the_same_file_again() {
    let stamp = uuid::Uuid::new_v4().simple();
    let dir = std::env::temp_dir().join(format!("wp70 restart Überprüfung {stamp}"));
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("marker.txt");
    std::fs::write(&marker, "keep").unwrap();
    let db = dir.join("monocode.db");
    let (delegation, generation) = {
        let store = SessionStore::open(db.clone()).unwrap();
        let mut conn = store.lock_conn().unwrap();
        let row = delegations::record(
            &mut conn,
            launch("mate-1", "req-restart", "worker-restart"),
            10,
        )
        .unwrap();
        (row.id, row.generation)
    };
    let store = SessionStore::open(db).unwrap();
    let mut conn = store.lock_conn().unwrap();
    let filed = task(&conn, &delegation);
    assert_eq!(filed.delegation_id.as_deref(), Some(delegation.as_str()));
    assert_eq!(filed.status, "In progress");
    let again = delegations::record(
        &mut conn,
        launch("mate-1", "req-restart", "worker-restart"),
        15,
    )
    .unwrap();
    assert_eq!(again.id, delegation);
    let tasks: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tasks, 1);
    let resumed = task(&conn, &delegation);
    assert_eq!(resumed.id, filed.id);
    assert_eq!(resumed.delegation_id.as_deref(), Some(delegation.as_str()));
    settle(&mut conn, &delegation, generation, "completed", 20);
    assert_eq!(task(&conn, &delegation).status, "Done");
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "keep");
    drop(conn);
    drop(store);
    let dir = crate::fs::canonical(&dir).unwrap();
    let temp = crate::fs::canonical(std::env::temp_dir()).unwrap();
    assert!(
        dir.starts_with(&temp),
        "refusing to delete outside the temp folder"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
