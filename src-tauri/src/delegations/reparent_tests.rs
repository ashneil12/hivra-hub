//! SC-19: the open work of a retired chat moves to the chat that takes its place (reparent.rs).

use super::*;
use crate::delegations::{
    cancel, get, list_open, owned, record, set_delivery, set_question, settle, DeliveryInput,
    OwnedQuery, RecordInput, SettleInput, ACKNOWLEDGED, COMPLETED, DELIVERED, DISPOSED, FAILED,
    PENDING, QUESTION, QUEUED, RUNNING,
};
use crate::firstmate::status::Status;
use serde_json::{json, Value};

const OLD: &str = "chat-old";
const NEW: &str = "chat-new";

fn store() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn launch(owner: &str, request: &str, title: &str) -> RecordInput {
    RecordInput {
        owner_session: owner.into(),
        owner_mono: Some("exo-chief".into()),
        request_id: request.into(),
        child_session: format!("worker-{request}"),
        project: Some("/Users/ash/Projects/exo".into()),
        title: Some(title.into()),
        brief: Some(format!("Do {title}")),
        ..Default::default()
    }
}

fn input(from: &str, to: &str) -> ReparentInput {
    ReparentInput {
        from: from.into(),
        to: to.into(),
        to_mono: Some("exo-chief".into()),
        from_title: Some("Planning chat".into()),
        why: Some("reset".into()),
    }
}

fn finish(id: &str, state: &str) -> SettleInput {
    SettleInput {
        id: id.into(),
        generation: 1,
        state: state.into(),
        result: Some("All done".into()),
        ..Default::default()
    }
}

fn deliver(ids: &[&str], delivery: &str, message: Option<&str>) -> DeliveryInput {
    DeliveryInput {
        ids: ids.iter().map(|id| id.to_string()).collect(),
        delivery: delivery.into(),
        queued_message: message.map(str::to_string),
        ..Default::default()
    }
}

/// The five shapes of work a reset meets, all owned by `OLD`, plus two that are over (a delivered report and a
/// cancelled row). Returns the ids in a fixed order: running, question, queued, finished-unreported, delivered, cancelled.
struct Seeded {
    running: String,
    question: String,
    queued: String,
    unreported: String,
    delivered: String,
    cancelled: String,
}

fn seed(conn: &mut Connection) -> Seeded {
    let running = record(conn, launch(OLD, "r-running", "Fix the save bug"), 10).unwrap();
    let question = record(conn, launch(OLD, "r-question", "Pick the palette"), 11).unwrap();
    set_question(conn, &question.id, Some("Which blue?".into()), None, 12).unwrap();
    let queued = record(conn, launch(OLD, "r-queued", "Write the docs"), 13).unwrap();
    settle(conn, finish(&queued.id, COMPLETED), 14).unwrap();
    set_delivery(
        conn,
        deliver(&[&queued.id], QUEUED, Some("mono-completion-r-queued-g1")),
        15,
    )
    .unwrap();
    let unreported = record(conn, launch(OLD, "r-unreported", "Tidy the tests"), 16).unwrap();
    settle(conn, finish(&unreported.id, COMPLETED), 17).unwrap();
    let delivered = record(conn, launch(OLD, "r-delivered", "Old finished job"), 18).unwrap();
    settle(conn, finish(&delivered.id, COMPLETED), 19).unwrap();
    set_delivery(
        conn,
        deliver(
            &[&delivered.id],
            QUEUED,
            Some("mono-completion-r-delivered-g1"),
        ),
        20,
    )
    .unwrap();
    set_delivery(conn, deliver(&[&delivered.id], DELIVERED, None), 21).unwrap();
    let cancelled = record(conn, launch(OLD, "r-cancelled", "Dropped job"), 22).unwrap();
    cancel(
        conn,
        std::slice::from_ref(&cancelled.id),
        Some("Stopped".into()),
        None,
        23,
    )
    .unwrap();
    Seeded {
        running: running.id,
        question: question.id,
        queued: queued.id,
        unreported: unreported.id,
        delivered: delivered.id,
        cancelled: cancelled.id,
    }
}

fn owner_of(conn: &Connection, id: &str) -> String {
    get(conn, id).unwrap().unwrap().owner_session
}

#[test]
fn a_reset_moves_running_question_queued_and_unreported_rows_and_only_those() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let ids = seed(&mut conn);

    let moved = reparent(&mut conn, input(OLD, NEW), 100).unwrap();

    let mut moved_ids: Vec<&str> = moved.rows.iter().map(|row| row.id.as_str()).collect();
    moved_ids.sort_unstable();
    let mut want = vec![
        ids.running.as_str(),
        ids.question.as_str(),
        ids.queued.as_str(),
        ids.unreported.as_str(),
    ];
    want.sort_unstable();
    assert_eq!(moved_ids, want);
    for id in &want {
        assert_eq!(owner_of(&conn, id), NEW, "{id} follows the new chat");
    }
    // What is over stays where it ran.
    assert_eq!(
        owner_of(&conn, &ids.delivered),
        OLD,
        "a delivered report is history"
    );
    assert_eq!(
        owner_of(&conn, &ids.cancelled),
        OLD,
        "a cancelled, disposed row is history"
    );
    assert_eq!(
        owned(
            &conn,
            OwnedQuery {
                owner_session: OLD.into(),
                ..Default::default()
            }
        )
        .unwrap()
        .len(),
        0,
        "the old chat owes and runs nothing now"
    );
}

#[test]
fn a_move_changes_the_owner_and_nothing_else_about_the_work() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let ids = seed(&mut conn);
    let before: Vec<Delegation> = [&ids.running, &ids.question, &ids.queued, &ids.unreported]
        .iter()
        .map(|id| get(&conn, id).unwrap().unwrap())
        .collect();

    let moved = reparent(&mut conn, input(OLD, NEW), 100).unwrap();

    for was in before {
        let now = get(&conn, &was.id).unwrap().unwrap();
        assert_eq!(
            now.state, was.state,
            "{} is not cancelled or restarted",
            was.id
        );
        assert_eq!(now.delivery, was.delivery);
        assert_eq!(
            now.delivery_message, was.delivery_message,
            "the report keeps its message id"
        );
        assert_eq!(now.generation, was.generation);
        assert_eq!(now.child_session, was.child_session);
        assert_eq!(now.pending_question, was.pending_question);
        assert_eq!(now.settled_at, was.settled_at);
        assert_eq!(now.run_started_at, was.run_started_at);
        assert_eq!(
            now.version,
            was.version + 1,
            "one new version for the outbox"
        );
        assert_eq!(now.status, crate::firstmate::status::status_of(&now).status);
    }
    assert_eq!(moved.rows.len(), 4);
    // Still open and still owed: the moved running row is running, the question still asks.
    let open = list_open(&conn).unwrap();
    assert!(open.iter().any(|row| row.state == RUNNING));
    assert!(open.iter().any(|row| row.state == QUESTION));
    assert_eq!(
        get(&conn, &ids.running).unwrap().unwrap().status,
        Status::Working
    );
}

#[test]
fn each_moved_row_says_where_it_came_from() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let ids = seed(&mut conn);

    reparent(&mut conn, input(OLD, NEW), 100).unwrap();

    let row = get(&conn, &ids.running).unwrap().unwrap();
    let line = row.log.last().unwrap();
    assert_eq!(line["event"], json!("moved"));
    assert_eq!(line["at"], json!(100));
    assert_eq!(line["from"], json!(OLD));
    assert_eq!(line["to"], json!(NEW));
    assert_eq!(
        line["text"],
        json!("Moved from Planning chat after a reset")
    );
    // The rows that stayed carry no such line.
    let stayed = get(&conn, &ids.delivered).unwrap().unwrap();
    assert!(stayed
        .log
        .iter()
        .all(|entry| entry["event"] != json!("moved")));
}

#[test]
fn the_log_line_names_how_the_chat_went_and_survives_a_hostile_title() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("chat-a", "ra", "A"), 1).unwrap();
    let b = record(&mut conn, launch("chat-b", "rb", "B"), 2).unwrap();
    let c = record(&mut conn, launch("chat-c", "rc", "C"), 3).unwrap();
    let d = record(&mut conn, launch("chat-d", "rd", "D"), 4).unwrap();

    let mut archived = input("chat-a", NEW);
    archived.why = Some("archive".into());
    reparent(&mut conn, archived, 10).unwrap();
    let mut deleted = input("chat-b", NEW);
    deleted.why = Some("delete".into());
    deleted.from_title = Some("Old\nchat \u{7}with   spaces".into());
    reparent(&mut conn, deleted, 11).unwrap();
    let mut untitled = input("chat-c", NEW);
    untitled.from_title = Some("   ".into());
    reparent(&mut conn, untitled, 12).unwrap();
    let mut unknown = input("chat-d", NEW);
    unknown.why = Some("something else".into());
    unknown.from_title = Some("x".repeat(500));
    reparent(&mut conn, unknown, 13).unwrap();

    let text = |id: &str| -> String {
        get(&conn, id).unwrap().unwrap().log.last().unwrap()["text"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        text(&a.id),
        "Moved from Planning chat after it was archived"
    );
    assert_eq!(
        text(&b.id),
        "Moved from Old chat with spaces after it was deleted"
    );
    assert_eq!(text(&c.id), "Moved from its old chat after a reset");
    let long = text(&d.id);
    assert!(long.chars().count() < 140, "a long title is cut: {long}");
    assert!(
        long.ends_with("after a reset"),
        "an unknown reason reads as a reset: {long}"
    );
}

#[test]
fn a_report_arriving_after_the_move_is_owed_to_the_new_chat() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let ids = seed(&mut conn);
    reparent(&mut conn, input(OLD, NEW), 100).unwrap();

    // The worker that was running finishes after the move: the settle's row names the new chat.
    let change = settle(&mut conn, finish(&ids.running, COMPLETED), 101).unwrap();
    assert!(change.applied);
    let row = change.row.unwrap();
    assert_eq!(row.owner_session, NEW);
    assert_eq!(row.delivery, PENDING);
    // A question answered later and the report after it go the same way.
    let owed = owned(
        &conn,
        OwnedQuery {
            owner_session: NEW.into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(owed.iter().any(|r| r.id == ids.running));
    assert!(owed
        .iter()
        .any(|r| r.id == ids.question && r.state == QUESTION));
    assert!(owned(
        &conn,
        OwnedQuery {
            owner_session: OLD.into(),
            ..Default::default()
        }
    )
    .unwrap()
    .is_empty());
}

#[test]
fn a_report_in_flight_to_the_old_chat_lands_in_the_new_one_once() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    // The worker finished; its report is about to be queued to the chat that is being reset.
    let row = record(&mut conn, launch(OLD, "r-flight", "Ship it"), 10).unwrap();
    let settled = settle(&mut conn, finish(&row.id, COMPLETED), 11)
        .unwrap()
        .row
        .unwrap();
    assert_eq!(
        settled.owner_session, OLD,
        "the reporter read the old owner"
    );

    // The reset moves the work while the report is in flight.
    reparent(&mut conn, input(OLD, NEW), 12).unwrap();

    // The reporter marks the report queued (by row id, as it always does): it still applies, and the row it gets back
    // names the new chat, so the report is queued there and nowhere else.
    let marked = set_delivery(
        &mut conn,
        deliver(&[&row.id], QUEUED, Some("mono-completion-r-flight-g1")),
        13,
    )
    .unwrap();
    assert_eq!(marked.len(), 1);
    assert_eq!(marked[0].owner_session, NEW);
    assert_eq!(marked[0].delivery, QUEUED);
    // The app queues the same message into the new chat after the move; marking it again changes nothing, so the
    // receipt can't make a second report.
    let again = set_delivery(
        &mut conn,
        deliver(&[&row.id], QUEUED, Some("mono-completion-r-flight-g1")),
        14,
    )
    .unwrap();
    assert!(again.is_empty(), "the same message is not queued twice");
    // And a report already queued for the old chat when it moved keeps its message id for the new chat's queue.
    let queued = record(&mut conn, launch(OLD, "r-waiting", "Docs"), 15).unwrap();
    settle(&mut conn, finish(&queued.id, COMPLETED), 16).unwrap();
    set_delivery(
        &mut conn,
        deliver(&[&queued.id], QUEUED, Some("mono-completion-r-waiting-g1")),
        17,
    )
    .unwrap();
    reparent(&mut conn, input(OLD, NEW), 18).unwrap();
    let moved = get(&conn, &queued.id).unwrap().unwrap();
    assert_eq!(
        (
            moved.owner_session.as_str(),
            moved.delivery.as_str(),
            moved.delivery_message.as_deref()
        ),
        (NEW, QUEUED, Some("mono-completion-r-waiting-g1"))
    );
    // Delivered in the new chat (found by its message id, as the app does), then read there: forward only.
    let by_message = set_delivery(
        &mut conn,
        DeliveryInput {
            message_id: Some("mono-completion-r-waiting-g1".into()),
            delivery: DELIVERED.into(),
            ..Default::default()
        },
        20,
    )
    .unwrap();
    assert_eq!(by_message.len(), 1);
    assert_eq!(by_message[0].owner_session, NEW);
    assert_eq!(
        set_delivery(&mut conn, deliver(&[&queued.id], ACKNOWLEDGED, None), 21)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn a_late_queued_mark_from_a_window_that_did_not_hear_of_the_move_changes_nothing() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch(OLD, "r-late", "Ship it"), 10).unwrap();
    settle(&mut conn, finish(&row.id, COMPLETED), 11).unwrap();
    reparent(&mut conn, input(OLD, NEW), 12).unwrap();
    // The move's own window queued the report under its receipt.
    set_delivery(
        &mut conn,
        deliver(&[&row.id], QUEUED, Some("mono-completion-r-late-g1")),
        13,
    )
    .unwrap();

    // Another window still names the old chat and marks the row queued under a batch message that went nowhere.
    let stale = DeliveryInput {
        owner_session: Some(OLD.into()),
        ..deliver(&[&row.id], QUEUED, Some("mono-completion-batch-x"))
    };
    assert!(set_delivery(&mut conn, stale, 14).unwrap().is_empty());
    let kept = get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(
        kept.delivery_message.as_deref(),
        Some("mono-completion-r-late-g1")
    );
    // The same mark naming the chat that owns the row goes through, and one naming no owner is as it always was.
    let current = DeliveryInput {
        owner_session: Some(NEW.into()),
        ..deliver(&[&row.id], QUEUED, Some("mono-completion-batch-y"))
    };
    assert_eq!(set_delivery(&mut conn, current, 15).unwrap().len(), 1);
    let open = record(&mut conn, launch(NEW, "r-open", "Open"), 16).unwrap();
    settle(&mut conn, finish(&open.id, COMPLETED), 17).unwrap();
    assert_eq!(
        set_delivery(&mut conn, deliver(&[&open.id], QUEUED, Some("m")), 18)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn a_second_move_of_the_same_chat_moves_nothing_and_a_stale_from_leaves_rows_alone() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let ids = seed(&mut conn);

    let first = reparent(&mut conn, input(OLD, NEW), 100).unwrap();
    assert_eq!(first.rows.len(), 4);
    // Another window (or a retry) asks again: nothing is left under the old chat.
    let second = reparent(&mut conn, input(OLD, NEW), 101).unwrap();
    assert!(second.rows.is_empty() && second.waiting.is_empty());
    // A second window that thinks the work went to a different chat can't take it from the one it already reached.
    let rival = reparent(&mut conn, input(OLD, "chat-rival"), 102).unwrap();
    assert!(rival.rows.is_empty());
    assert_eq!(owner_of(&conn, &ids.running), NEW);
    let row = get(&conn, &ids.running).unwrap().unwrap();
    let moved_lines = row
        .log
        .iter()
        .filter(|entry| entry["event"] == json!("moved"))
        .count();
    assert_eq!(moved_lines, 1, "one move, one log line");
    // The chat that took the work can be retired in its turn: it follows once more.
    let onward = reparent(&mut conn, input(NEW, "chat-third"), 103).unwrap();
    assert_eq!(onward.rows.len(), 4);
    assert_eq!(owner_of(&conn, &ids.running), "chat-third");
}

#[test]
fn a_reset_with_no_open_rows_moves_nothing_and_asks_for_no_note() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    // Nothing at all.
    let none = reparent(&mut conn, input(OLD, NEW), 1).unwrap();
    assert_eq!(none, Reparented::default());
    // Only finished, delivered and cancelled work.
    let done = record(&mut conn, launch(OLD, "r-done", "Done"), 2).unwrap();
    settle(&mut conn, finish(&done.id, COMPLETED), 3).unwrap();
    set_delivery(
        &mut conn,
        deliver(&[&done.id], QUEUED, Some("mono-completion-r-done-g1")),
        4,
    )
    .unwrap();
    set_delivery(&mut conn, deliver(&[&done.id], DELIVERED, None), 5).unwrap();
    let gone = record(&mut conn, launch(OLD, "r-gone", "Gone"), 6).unwrap();
    cancel(&mut conn, std::slice::from_ref(&gone.id), None, None, 7).unwrap();
    let discarded = record(&mut conn, launch(OLD, "r-discarded", "Discarded"), 8).unwrap();
    settle(&mut conn, finish(&discarded.id, FAILED), 9).unwrap();
    set_delivery(&mut conn, deliver(&[&discarded.id], DISPOSED, None), 10).unwrap();

    let moved = reparent(&mut conn, input(OLD, NEW), 11).unwrap();

    assert!(moved.rows.is_empty() && moved.waiting.is_empty());
    for id in [&done.id, &gone.id, &discarded.id] {
        assert_eq!(owner_of(&conn, id), OLD);
    }
}

#[test]
fn another_chats_rows_are_never_taken() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let mine = record(&mut conn, launch(OLD, "r-mine", "Mine"), 1).unwrap();
    let theirs = record(&mut conn, launch("chat-other", "r-theirs", "Theirs"), 2).unwrap();
    // A chat whose name merely starts the same is a different chat.
    let near = record(&mut conn, launch("chat-old-2", "r-near", "Near"), 3).unwrap();

    let moved = reparent(&mut conn, input(OLD, NEW), 4).unwrap();

    assert_eq!(
        moved.rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        vec![mine.id]
    );
    assert_eq!(owner_of(&conn, &theirs.id), "chat-other");
    assert_eq!(owner_of(&conn, &near.id), "chat-old-2");
}

#[test]
fn the_owner_mono_follows_the_new_chat_when_it_belongs_to_another_mono() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch(OLD, "r-lead", "Work"), 1).unwrap();
    assert_eq!(row.owner_mono.as_deref(), Some("exo-chief"));

    // The first mate is gone: the project's Lead takes its work.
    let mut to_lead = input(OLD, "lead-chat");
    to_lead.to_mono = Some("exo-lead".into());
    reparent(&mut conn, to_lead, 2).unwrap();
    assert_eq!(
        get(&conn, &row.id).unwrap().unwrap().owner_mono.as_deref(),
        Some("exo-lead")
    );

    // No mono named: the row keeps the one it had.
    let mut plain = input("lead-chat", "lead-chat-2");
    plain.to_mono = None;
    reparent(&mut conn, plain, 3).unwrap();
    let kept = get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(kept.owner_session, "lead-chat-2");
    assert_eq!(kept.owner_mono.as_deref(), Some("exo-lead"));
}

#[test]
fn work_the_new_chat_itself_does_is_not_handed_to_it() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    // The deleted first mate had briefed the Lead; the Lead is also where its work is falling back to.
    let mut brief = launch(OLD, "r-brief", "Brief the lead");
    brief.child_session = "lead-chat".into();
    let own = record(&mut conn, brief, 1).unwrap();
    let other = record(&mut conn, launch(OLD, "r-other", "Other"), 2).unwrap();

    let moved = reparent(&mut conn, input(OLD, "lead-chat"), 3).unwrap();

    assert_eq!(
        moved.rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        vec![other.id]
    );
    assert_eq!(
        owner_of(&conn, &own.id),
        OLD,
        "a chat never reports to itself"
    );
}

#[test]
fn bad_ids_are_refused_and_changed_nothing() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch(OLD, "r-ok", "Ok"), 1).unwrap();
    for (from, to) in [
        ("", NEW),
        (OLD, ""),
        ("  ", NEW),
        ("chat old", NEW),
        (OLD, "chat/../new"),
        (OLD, "chat\nnew"),
    ] {
        assert!(
            reparent(&mut conn, input(from, to), 2).is_err(),
            "{from:?} -> {to:?}"
        );
    }
    let mut bad_mono = input(OLD, NEW);
    bad_mono.to_mono = Some("not a mono!".into());
    assert!(reparent(&mut conn, bad_mono, 2).is_err());
    // Moving a chat onto itself is nothing to do, not an error.
    assert_eq!(
        reparent(&mut conn, input(OLD, OLD), 3).unwrap(),
        Reparented::default()
    );
    assert_eq!(owner_of(&conn, &row.id), OLD);
    assert_eq!(get(&conn, &row.id).unwrap().unwrap().version, row.version);
}

#[test]
fn a_move_is_all_or_nothing() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let ids = seed(&mut conn);
    // A row that can't be written (its log column is made unwritable) rolls the whole move back.
    conn.execute_batch(
        "CREATE TRIGGER refuse_move BEFORE UPDATE OF owner_session ON delegations
         WHEN NEW.request_id = 'r-unreported'
         BEGIN SELECT RAISE(ABORT, 'refused'); END;",
    )
    .unwrap();

    let error = reparent(&mut conn, input(OLD, NEW), 100).unwrap_err();
    assert!(
        error.contains("refused"),
        "the failure is the row's own: {error}"
    );

    for id in [&ids.running, &ids.question, &ids.queued, &ids.unreported] {
        assert_eq!(owner_of(&conn, id), OLD, "{id} did not move alone");
    }
    assert_eq!(get(&conn, &ids.running).unwrap().unwrap().version, 1);
    // The refusal gone, the same move goes through whole.
    conn.execute_batch("DROP TRIGGER refuse_move;").unwrap();
    assert_eq!(
        reparent(&mut conn, input(OLD, NEW), 101)
            .unwrap()
            .rows
            .len(),
        4
    );
}

fn waiting_job(id: &str, owner: &str, title: &str) -> Value {
    json!({
        "id": id, "ownerSession": owner, "requestId": id, "project": "exo",
        "title": title, "queuedAt": 1, "input": { "brief": id }
    })
}

#[test]
fn jobs_waiting_for_a_free_worker_move_with_the_rows() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    crate::worker_queue::add(&conn, &waiting_job("w1", OLD, "Queued one")).unwrap();
    crate::worker_queue::add(&conn, &waiting_job("w2", "chat-other", "Someone else's")).unwrap();
    crate::worker_queue::add(&conn, &waiting_job("w3", OLD, "Queued two")).unwrap();
    // A claimed job (a window is starting it right now) moves too: its owner is gone either way.
    assert!(crate::worker_queue::claim(&conn, "w3", "win-1", 1_000, 60_000).unwrap());
    let running = record(&mut conn, launch(OLD, "r-run", "Running"), 1).unwrap();

    let moved = reparent(&mut conn, input(OLD, NEW), 2_000).unwrap();

    assert_eq!(moved.rows.len(), 1);
    assert_eq!(moved.rows[0].id, running.id);
    assert_eq!(
        moved.waiting,
        vec![
            WaitingMoved {
                id: "w1".into(),
                title: Some("Queued one".into())
            },
            WaitingMoved {
                id: "w3".into(),
                title: Some("Queued two".into())
            },
        ]
    );
    let jobs = crate::worker_queue::list(&conn, 2_000).unwrap();
    let owners: Vec<(String, String)> = jobs
        .iter()
        .map(|job| {
            (
                job["id"].as_str().unwrap().into(),
                job["ownerSession"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        owners,
        vec![
            ("w1".to_string(), NEW.to_string()),
            ("w2".to_string(), "chat-other".to_string()),
            ("w3".to_string(), NEW.to_string()),
        ],
        "the order they were asked in is kept, and the column and the job agree"
    );
    let column: String = conn
        .query_row(
            "SELECT owner_session FROM worker_queue WHERE id = 'w1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(column, NEW);
    // A second move finds none of them.
    assert!(reparent(&mut conn, input(OLD, NEW), 2_001)
        .unwrap()
        .waiting
        .is_empty());
}

#[test]
fn waiting_jobs_alone_are_enough_to_move() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    crate::worker_queue::add(&conn, &waiting_job("w1", OLD, "Only a waiting job")).unwrap();

    let moved = reparent(&mut conn, input(OLD, NEW), 1).unwrap();

    assert!(moved.rows.is_empty());
    assert_eq!(moved.waiting.len(), 1);
}
