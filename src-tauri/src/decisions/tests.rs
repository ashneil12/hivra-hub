//! Hivra WP-14's "Done when": a worker's question reaches its first mate, not the person; the same decision key asked
//! twice gives one decision; answering releases two waiting delegations; the fan-out cap refuses with a reason.

use super::*;
use crate::delegations::{record, set_question, RecordInput};
use crate::firstmate::status::{status_of, Status};
use crate::session_store::SessionStore;
use crate::steering::{pending, PENDING};

fn store() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn launch(owner: &str, request: &str, child: &str) -> RecordInput {
    RecordInput {
        owner_session: owner.into(),
        request_id: request.into(),
        child_session: child.into(),
        title: Some("Clean up old sessions".into()),
        brief: Some("Remove stale sessions".into()),
        ..Default::default()
    }
}

fn ask_input(asked_by: &str, key: &str, tasks: &[&str]) -> AskInput {
    AskInput {
        asked_by: asked_by.into(),
        asked_by_mono: None,
        project: Some("hivra".into()),
        key: key.into(),
        question: "Keep deleted sessions for 30 days, or delete them for good?".into(),
        options: vec!["Keep 30 days".into(), "Delete for good".into()],
        recommended: Some("Keep 30 days".into()),
        task_ids: tasks.iter().map(|t| t.to_string()).collect(),
    }
}

#[test]
fn a_worker_question_reaches_its_first_mate_not_the_person() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let row = record(&mut conn, launch("fm", "r1", "worker"), 1).unwrap();
    let asked = set_question(&mut conn, &row.id, Some("Which API?".into()), None, 2)
        .unwrap()
        .row
        .unwrap();
    // Its question is its first mate's: the row reads as working, never as needing the person.
    assert_eq!(status_of(&asked).status, Status::Working);
    // The worker can't put it to the person itself.
    let err = ask(&mut conn, ask_input("worker", "which-api", &[]), 3).unwrap_err();
    assert!(err.contains("goes to it, not to the person"), "{err}");
    assert!(list(&conn, 10).unwrap().is_empty());
    // Its first mate can, and then the task waits on the person.
    let out = ask(&mut conn, ask_input("fm", "which-api", &[&row.id]), 4).unwrap();
    assert!(out.created);
    let waiting = delegations::get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(status_of(&waiting).status, Status::NeedsYou);
}

#[test]
fn a_first_mate_under_a_first_mate_asks_up_one_level() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    // The coding team briefed a Mono, which works for it: the Mono asks the coding team, not the person.
    record(&mut conn, launch("coding-team", "r1", "mono"), 1).unwrap();
    assert!(ask(&mut conn, ask_input("mono", "k", &[]), 2).is_err());
    assert!(ask(&mut conn, ask_input("coding-team", "k", &[]), 3).is_ok());
}

#[test]
fn the_same_key_asked_twice_gives_one_decision() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("fm", "r1", "w1"), 1).unwrap();
    let b = record(&mut conn, launch("fm", "r2", "w2"), 1).unwrap();
    let first = ask(&mut conn, ask_input("fm", "retention", &[&a.id]), 2).unwrap();
    assert!(first.created);
    let mut again = ask_input("fm", "retention", &[&a.id, &b.id]);
    again.question = "Something reworded".into();
    again.options = vec!["Yes".into(), "No".into()];
    again.recommended = None;
    let second = ask(&mut conn, again, 3).unwrap();
    assert!(!second.created);
    // Nothing about the question changed; only the new waiter joined.
    assert_eq!(second.decision.question, first.decision.question);
    assert_eq!(second.decision.options, first.decision.options);
    assert_eq!(second.decision.recommended.as_deref(), Some("Keep 30 days"));
    assert_eq!(second.added, vec![b.id.clone()]);
    assert_eq!(second.decision.waiting, vec![a.id.clone(), b.id.clone()]);
    // A third identical ask changes nothing at all.
    let third = ask(&mut conn, ask_input("fm", "retention", &[&a.id]), 4).unwrap();
    assert!(third.added.is_empty());
    assert_eq!(third.decision.version, second.decision.version);
    assert_eq!(list(&conn, 10).unwrap().len(), 1);
    // The same key in another project is another decision.
    let mut elsewhere = ask_input("fm", "retention", &[]);
    elsewhere.project = Some("exo".into());
    assert!(ask(&mut conn, elsewhere, 5).unwrap().created);
}

#[test]
fn answering_releases_two_waiting_delegations() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("fm", "r1", "w1"), 1).unwrap();
    let b = record(&mut conn, launch("fm", "r2", "w2"), 1).unwrap();
    set_question(&mut conn, &a.id, Some("Keep or delete?".into()), None, 2).unwrap();
    ask(&mut conn, ask_input("fm", "retention", &[&a.id, &b.id]), 3).unwrap();
    let asked = delegations::get(&conn, &a.id).unwrap().unwrap();
    assert_eq!(status_of(&asked).status, Status::NeedsYou);

    let out = answer(
        &mut conn,
        "hivra",
        "retention",
        "Keep 30 days",
        Some("user".into()),
        4,
    )
    .unwrap();
    assert!(out.applied);
    assert_eq!(out.released_tasks, vec![a.id.clone(), b.id.clone()]);
    let d = out.decision.unwrap();
    assert_eq!(
        (d.state.as_str(), d.answer.as_deref()),
        (ANSWERED, Some("Keep 30 days"))
    );
    // Each waiting worker, then the first mate that asked, has a message with the answer, stored to go in.
    let messages = pending(&conn).unwrap();
    let to: Vec<&str> = messages.iter().map(|m| m.child_session.as_str()).collect();
    assert_eq!(to, ["w1", "w2", "fm"]);
    assert!(messages
        .iter()
        .all(|m| m.state == PENDING && m.source == "decision" && m.text.contains("Keep 30 days")));
    // The question is its first mate's again: the task reads as working.
    let released = delegations::get(&conn, &a.id).unwrap().unwrap();
    assert_eq!(status_of(&released).status, Status::Working);

    // A second answer changes nothing and sends nothing.
    let again = answer(&mut conn, "hivra", "retention", "Delete for good", None, 5).unwrap();
    assert!(!again.applied);
    assert_eq!(
        again.decision.unwrap().answer.as_deref(),
        Some("Keep 30 days")
    );
    assert_eq!(pending(&conn).unwrap().len(), 3);

    // A task that joins after the answer gets it straight away.
    let c = record(&mut conn, launch("fm", "r3", "w3"), 6).unwrap();
    let late = ask(&mut conn, ask_input("fm", "retention", &[&c.id]), 7).unwrap();
    assert_eq!(late.released.len(), 1);
    assert_eq!(late.released[0].child_session, "w3");
}

#[test]
fn a_finished_task_is_not_released_and_bad_asks_are_refused() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("fm", "r1", "w1"), 1).unwrap();
    let other = record(&mut conn, launch("someone-else", "r2", "w2"), 1).unwrap();
    assert!(ask(&mut conn, ask_input("fm", "k", &[&other.id]), 2)
        .unwrap_err()
        .contains("isn't one of your tasks"));
    let mut one = ask_input("fm", "k", &[]);
    one.options = vec!["Only".into()];
    assert!(ask(&mut conn, one, 2).is_err());
    let mut bad_pick = ask_input("fm", "k", &[]);
    bad_pick.recommended = Some("Maybe".into());
    assert!(ask(&mut conn, bad_pick, 2)
        .unwrap_err()
        .contains("isn't one of the options"));
    let mut bad_key = ask_input("fm", "has spaces", &[]);
    bad_key.key = "has spaces".into();
    assert!(ask(&mut conn, bad_key, 2).is_err());
    let mut long = ask_input("fm", "k", &[]);
    long.question = "x".repeat(QUESTION_MAX + 1);
    assert!(ask(&mut conn, long, 2).unwrap_err().contains("at most"));

    ask(&mut conn, ask_input("fm", "k", &[&a.id]), 3).unwrap();
    crate::delegations::cancel(
        &mut conn,
        std::slice::from_ref(&a.id),
        Some("stop".into()),
        None,
        4,
    )
    .unwrap();
    let out = answer(&mut conn, "hivra", "k", "Keep 30 days", None, 5).unwrap();
    assert!(out.applied);
    assert!(out.released_tasks.is_empty());
    // Only the asker hears it.
    assert_eq!(out.released.len(), 1);
    assert_eq!(out.released[0].child_session, "fm");
    assert!(
        !answer(&mut conn, "hivra", "missing", "x", None, 6)
            .unwrap()
            .applied
    );
}

#[test]
fn the_fanout_cap_refuses_with_a_plain_reason() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    for i in 0..crate::firstmate::MAX_FANOUT {
        assert_eq!(crate::firstmate::check_fanout(&conn, "fm").unwrap(), i);
        record(
            &mut conn,
            launch("fm", &format!("r{i}"), &format!("w{i}")),
            1,
        )
        .unwrap();
    }
    let err = crate::firstmate::check_fanout(&conn, "fm").unwrap_err();
    assert!(err.contains("you already have 8 tasks running"), "{err}");
    assert!(err.contains("task_cancel"));
    // Another first mate is not held back.
    assert_eq!(crate::firstmate::check_fanout(&conn, "other").unwrap(), 0);
}

#[test]
fn an_answer_given_in_the_askers_chat_is_not_repeated_to_it() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let a = record(&mut conn, launch("fm", "r1", "w1"), 1).unwrap();
    ask(&mut conn, ask_input("fm", "retention", &[&a.id]), 2).unwrap();
    let out = answer(
        &mut conn,
        "hivra",
        "retention",
        "Keep 30 days",
        Some("chat:fm".into()),
        3,
    )
    .unwrap();
    let to: Vec<&str> = out
        .released
        .iter()
        .map(|m| m.child_session.as_str())
        .collect();
    assert_eq!(to, ["w1"]);
}
