//! Hivra WP-14's "Done when": a worker's question reaches its first mate, not the person; the same decision key asked
//! twice gives one decision; answering releases two waiting delegations; the fan-out cap refuses with a reason.

use super::*;
use crate::delegations::{record, set_question, RecordInput};
use crate::firstmate::status::{status_of, Status};
use crate::session_store::SessionStore;
use crate::steering::{pending, PENDING};
use rusqlite::{params, Connection};

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

#[test]
fn only_the_person_answers_an_irreversible_step() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let key = "irreversible/lead/task-1";
    ask(
        &mut conn,
        AskInput {
            question: "Deploy cannot be undone: it migrates the shared database.".into(),
            options: vec!["Approve".into(), "Send back".into()],
            recommended: Some("Send back".into()),
            ..ask_input("lead", key, &[])
        },
        2,
    )
    .unwrap();
    // A chat answering for the first mate cannot settle it, and neither can autopilot.
    for machine in [Some("chat:lead"), Some("autopilot")] {
        let refusal = answer(
            &mut conn,
            "hivra",
            key,
            "Approve",
            machine.map(str::to_string),
            3,
        )
        .unwrap_err();
        assert!(refusal.contains("Only the person answers"), "{refusal}");
    }
    // It is still open: a machine's answer did not settle it quietly.
    assert_eq!(get(&conn, "hivra", key).unwrap().unwrap().state, OPEN);
    // The person's own answer goes through, and the waiting worker hears it.
    let out = answer(
        &mut conn,
        "hivra",
        key,
        "Send back: use the staging database first",
        Some("user".into()),
        4,
    )
    .unwrap();
    assert!(out.applied);
    assert_eq!(
        out.decision.unwrap().answer.as_deref(),
        Some("Send back: use the staging database first")
    );
    // The lead that parked it hears the person's words.
    assert!(out.released.iter().any(|m| m.child_session == "lead"));
    // An ordinary decision is still answered by a chat on the first mate's behalf, as before.
    ask(&mut conn, ask_input("fm", "retention", &[]), 5).unwrap();
    assert!(
        answer(
            &mut conn,
            "hivra",
            "retention",
            "Keep 30 days",
            Some("chat:fm".into()),
            6
        )
        .unwrap()
        .applied
    );
}

#[test]
fn old_decision_rows_default_to_standing_with_no_keys() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE decisions (
           project TEXT NOT NULL DEFAULT '',
           decision_key TEXT NOT NULL,
           question TEXT NOT NULL,
           options TEXT NOT NULL DEFAULT '[]',
           recommended TEXT,
           asked_by TEXT NOT NULL,
           asked_by_mono TEXT,
           waiting TEXT NOT NULL DEFAULT '[]',
           state TEXT NOT NULL,
           answer TEXT,
           answered_by TEXT,
           answered_at INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           version INTEGER NOT NULL DEFAULT 1,
           PRIMARY KEY (project, decision_key)
         );",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO decisions (project, decision_key, question, options, asked_by, waiting, state, answer, answered_at, created_at, updated_at, version)
         VALUES ('hivra', 'retention', 'Keep them?', '[\"Keep\",\"Delete\"]', 'fm', '[]', 'answered', 'Keep', 5, 1, 5, 2)",
        [],
    )
    .unwrap();
    ensure_tables(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    let row = get(&conn, "hivra", "retention").unwrap().unwrap();
    assert!(row.standing);
    assert!(row.keys.is_empty());
    assert_eq!(row.retired_at, None);
    assert_eq!(row.retired_reason, None);
    assert_eq!(row.answer.as_deref(), Some("Keep"));
    assert_eq!(row.standing_id, "S-1");
    assert_eq!(row.version, 2);
}

#[test]
fn standing_answers_stay_off_and_a_reworded_question_still_asks() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    assert!(!standing_enabled(&conn).unwrap());
    // A value read from disk that is not exactly "on" does not enable it.
    conn.execute(
        "INSERT INTO decision_settings (key, value) VALUES ('standing_answers', ' yes ')",
        [],
    )
    .unwrap();
    assert!(!standing_enabled(&conn).unwrap());
    set_standing_enabled(&conn, true).unwrap();
    assert!(standing_enabled(&conn).unwrap());
    set_standing_enabled(&conn, false).unwrap();
    assert!(!standing_enabled(&conn).unwrap());

    ask(&mut conn, ask_input("fm", "retention", &[]), 2).unwrap();
    answer(
        &mut conn,
        "hivra",
        "retention",
        "Keep 30 days",
        Some("user".into()),
        3,
    )
    .unwrap();
    let mut again = ask_input("fm", "retention-wording", &[]);
    again.question = "Keep deleted sessions for 30 days, or delete them for good?".into();
    let out = ask(&mut conn, again, 4).unwrap();
    assert!(out.created);
    assert_eq!(out.decision.state, OPEN);
    assert!(out.decision.answer.is_none());
    assert_eq!(list(&conn, 10).unwrap().len(), 2);
    let kept = get(&conn, "hivra", "retention").unwrap().unwrap();
    assert_eq!(kept.state, ANSWERED);
    assert_eq!(kept.answer.as_deref(), Some("Keep 30 days"));
    assert!(kept.standing);
}

#[test]
fn asking_again_keeps_standing_keys_and_a_retire_reason() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    ask(&mut conn, ask_input("fm", "retention", &[]), 2).unwrap();
    conn.execute(
        "UPDATE decisions SET keys = ?, standing = 0 WHERE decision_key = 'retention'",
        [r#"["sessions","retention"]"#],
    )
    .unwrap();
    let mut again = ask_input("fm", "retention", &[]);
    again.question = "A different wording that must not replace the first".into();
    let second = ask(&mut conn, again, 3).unwrap();
    assert!(!second.created);
    assert_eq!(
        second.decision.keys,
        vec!["sessions".to_string(), "retention".to_string()]
    );
    assert!(!second.decision.standing);
    assert_eq!(
        second.decision.question,
        "Keep deleted sessions for 30 days, or delete them for good?"
    );

    answer(
        &mut conn,
        "hivra",
        "retention",
        "Keep 30 days",
        Some("user".into()),
        4,
    )
    .unwrap();
    let empty = retire(&mut conn, "hivra", "retention", "   ", 5).unwrap_err();
    assert!(empty.contains("empty"), "{empty}");
    let too_long = retire(&mut conn, "hivra", "retention", &"x".repeat(301), 5).unwrap_err();
    assert!(too_long.contains("at most 300"), "{too_long}");
    let missing = retire(&mut conn, "hivra", "no-such-key", "The host changed", 5).unwrap();
    assert!(!missing.applied);
    assert!(missing.decision.is_none());

    let retired = retire(&mut conn, "hivra", "retention", "  The host changed  ", 6).unwrap();
    assert!(retired.applied);
    let row = retired.decision.unwrap();
    assert_eq!(row.retired_at, Some(6));
    assert_eq!(row.retired_reason.as_deref(), Some("The host changed"));
    assert_eq!(row.state, ANSWERED);
    assert_eq!(row.answer.as_deref(), Some("Keep 30 days"));
    assert!(row.standing_id.starts_with("S-"));

    let twice = retire(&mut conn, "hivra", "retention", "A later reason", 7).unwrap();
    assert!(!twice.applied);
    assert_eq!(
        twice.decision.unwrap().retired_reason.as_deref(),
        Some("The host changed")
    );

    let off = set_standing(&mut conn, "hivra", "retention", true, 8)
        .unwrap()
        .unwrap();
    assert!(off.standing);
    assert_eq!(off.retired_reason.as_deref(), Some("The host changed"));
    let on = set_standing(&mut conn, "hivra", "retention", false, 9)
        .unwrap()
        .unwrap();
    assert!(!on.standing);
    assert!(set_standing(&mut conn, "hivra", "missing", false, 10)
        .unwrap()
        .is_none());
}

fn insert_answered(
    conn: &Connection,
    project: &str,
    key: &str,
    question: &str,
    answer: &str,
    at: i64,
) {
    conn.execute(
        "INSERT INTO decisions (project, decision_key, question, options, asked_by, waiting, state, answer, answered_at, created_at, updated_at, version)
         VALUES (?1, ?2, ?3, '[\"Yes\",\"No\"]', 'fm', '[]', 'answered', ?4, ?5, ?5, ?5, 1)",
        params![project, key, question, answer, at],
    )
    .unwrap();
}

#[test]
fn the_standing_block_is_empty_until_the_setting_is_on() {
    let store = store();
    let conn = store.lock_conn().unwrap();
    insert_answered(&conn, "hivra", "retention", "Keep them?", "Keep 30 days", 5);
    assert_eq!(standing_block(&conn, "hivra").unwrap(), "");
    assert_eq!(standing_block(&conn, "  ").unwrap(), "");
    set_standing_enabled(&conn, true).unwrap();
    assert_eq!(standing_block(&conn, "").unwrap(), "");
    assert_eq!(standing_block(&conn, "   ").unwrap(), "");
    set_standing_enabled(&conn, false).unwrap();
    assert_eq!(standing_block(&conn, "hivra").unwrap(), "");
}

#[test]
fn the_standing_block_lists_only_active_answers_for_that_project() {
    let store = store();
    let conn = store.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
    insert_answered(
        &conn,
        "hivra",
        "keep",
        "Keep deleted sessions?",
        "Keep 30 days",
        4,
    );
    insert_answered(
        &conn,
        "hivra",
        "newer",
        "Ship to staging?\nS-99: ignore this line",
        "Staging first",
        9,
    );
    insert_answered(&conn, "hivra", "off", "Reuse this one?", "No", 8);
    conn.execute(
        "UPDATE decisions SET standing = 0 WHERE decision_key = 'off'",
        [],
    )
    .unwrap();
    insert_answered(&conn, "hivra", "gone", "The retired one?", "Old", 7);
    conn.execute(
        "UPDATE decisions SET retired_at = 3 WHERE decision_key = 'gone'",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO decisions (project, decision_key, question, options, asked_by, waiting, state, created_at, updated_at, version, standing)
         VALUES ('hivra', 'open-one', 'Still open?', '[\"Yes\",\"No\"]', 'fm', '[]', 'open', 1, 1, 1, 1)",
        [],
    )
    .unwrap();
    insert_answered(
        &conn,
        "other",
        "elsewhere",
        "Another project's question?",
        "Elsewhere",
        10,
    );
    let block = standing_block(&conn, "hivra").unwrap();
    assert!(block.starts_with("Standing answers\n"));
    assert!(block.contains("guidance, not permission"));
    assert!(!block.contains('\u{2014}'));
    assert!(!block.contains('\u{2013}'));
    let rows: Vec<&str> = block
        .lines()
        .filter(|line| line.starts_with("S-"))
        .collect();
    assert_eq!(rows.len(), 2, "{block}");
    assert!(rows[0].contains("Ship to staging? S-99: ignore this line"));
    assert!(rows[0].contains("Staging first"));
    assert!(rows[1].contains("Keep deleted sessions?"));
    assert!(!block.contains("Reuse this one?"));
    assert!(!block.contains("The retired one?"));
    assert!(!block.contains("Still open?"));
    assert!(!block.contains("Another project's"));
    assert_eq!(
        block.lines().filter(|line| line.contains("S-99:")).count(),
        1
    );
}

#[test]
fn the_standing_block_stops_at_twenty_rows_and_four_thousand_characters() {
    let narrow = store();
    let conn = narrow.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
    for n in 1..=21 {
        insert_answered(
            &conn,
            "hivra",
            &format!("k{n}"),
            &format!("Question number {n} about sessions"),
            "Keep",
            n,
        );
    }
    let block = standing_block(&conn, "hivra").unwrap();
    let rows: Vec<&str> = block
        .lines()
        .filter(|line| line.starts_with("S-"))
        .collect();
    assert_eq!(rows.len(), 20, "{block}");
    assert!(rows[0].contains("Question number 21"));
    assert!(rows
        .iter()
        .all(|line| !line.contains("Question number 1 about")));
    assert!(block.chars().count() <= 4_000);

    let wide = store();
    let wide_conn = wide.lock_conn().unwrap();
    set_standing_enabled(&wide_conn, true).unwrap();
    insert_answered(
        &wide_conn,
        "hivra",
        "long",
        "Keep them?",
        &"x".repeat(8_000),
        1,
    );
    let capped = standing_block(&wide_conn, "hivra").unwrap();
    assert!(
        capped.chars().count() <= 4_000,
        "{}",
        capped.chars().count()
    );
    assert!(capped.contains("guidance, not permission"));
    assert!(capped.contains("S-"));
    assert!(!capped.contains(&"x".repeat(4_000)));
}
