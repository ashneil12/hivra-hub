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
        keys: Vec::new(),
        force: false,
        reason: None,
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

    let mut first = ask_input("fm", "retention", &[]);
    first.keys = vec!["sessions".into(), "retention".into()];
    ask(&mut conn, first, 2).unwrap();
    // Off: match words are not stored, and a later ask does not report a match.
    assert!(get(&conn, "hivra", "retention")
        .unwrap()
        .unwrap()
        .keys
        .is_empty());
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
    assert!(!out.matched);
    assert!(out.standing_id.is_none());
    assert!(out.decision.keys.is_empty());
    let value = serde_json::to_value(&out).unwrap();
    assert!(value.get("matched").is_none(), "{value}");
    assert!(value.get("standingId").is_none(), "{value}");
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
    assert!(missing.relied.is_empty());

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

#[test]
fn the_same_key_stays_one_decision_even_when_standing_answers_are_on() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
    let first = ask(&mut conn, ask_input("fm", "retention", &[]), 2).unwrap();
    assert!(first.created);
    assert!(!first.matched);
    assert!(first.standing_id.is_none());
    let words = first.decision.keys.clone();
    assert!(words.contains(&"keep".to_string()), "{words:?}");
    assert!(words.contains(&"session".to_string()), "{words:?}");
    assert!(!words.iter().any(|word| word == "for"), "{words:?}");

    // Force and new match words do not open a second row, and they do not replace the stored words.
    let mut again = ask_input("fm", "retention", &[]);
    again.keys = vec!["logo".into()];
    again.force = true;
    let second = ask(&mut conn, again, 3).unwrap();
    assert!(!second.created);
    assert!(!second.matched);
    assert!(second.standing_id.is_none());
    assert_eq!(second.decision.keys, words);
    assert_eq!(second.decision.question, first.decision.question);
    assert_eq!(list(&conn, 10).unwrap().len(), 1);
}

#[test]
fn a_reworded_question_reuses_the_standing_answer() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
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
    let kept = get(&conn, "hivra", "retention").unwrap().unwrap();

    let child = record(&mut conn, launch("fm", "r2", "w2"), 4).unwrap();
    let mut again = ask_input("fm", "retention-wording", &[&child.id]);
    again.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    let out = ask(&mut conn, again, 5).unwrap();
    assert!(out.matched);
    assert!(!out.created);
    assert!(out.added.is_empty());
    assert_eq!(out.decision.answer.as_deref(), Some("Keep 30 days"));
    assert_eq!(out.decision.decision_key, "retention");
    assert_eq!(out.standing_id.as_deref(), Some(kept.standing_id.as_str()));
    assert_eq!(
        out.standing_id.as_deref(),
        Some(out.decision.standing_id.as_str())
    );
    assert_eq!(out.released.len(), 1);
    assert_eq!(out.released[0].child_session, "w2");
    let value = serde_json::to_value(&out).unwrap();
    assert_eq!(value["matched"], true);
    assert_eq!(value["standingId"], kept.standing_id);
    assert_eq!(list(&conn, 10).unwrap().len(), 1);
    assert!(get(&conn, "hivra", "retention")
        .unwrap()
        .unwrap()
        .waiting
        .is_empty());

    let mut quiet = ask_input("fm", "retention-again", &[]);
    quiet.question = "Should we keep deleted sessions for 30 days?".into();
    assert!(ask(&mut conn, quiet, 6).unwrap().matched);

    // The same task cited again does not add a second row.
    let mut third = ask_input("fm", "retention-third", &[&child.id]);
    third.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    assert!(ask(&mut conn, third, 7).unwrap().matched);

    let retired = retire(&mut conn, "hivra", "retention", "The host changed", 8).unwrap();
    assert!(retired.applied);
    let ids: Vec<&str> = retired
        .relied
        .iter()
        .map(|row| row.task_id.as_str())
        .collect();
    assert_eq!(ids, vec![child.id.as_str(), "fm"]);

    let twice = retire(&mut conn, "hivra", "retention", "A later reason", 9).unwrap();
    assert!(!twice.applied);
    assert_eq!(twice.relied.len(), retired.relied.len());

    let mut fresh = ask_input("fm", "retention-after", &[]);
    fresh.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    let after = ask(&mut conn, fresh, 10).unwrap();
    assert!(!after.matched);
    assert!(after.created);
    assert_eq!(after.decision.state, OPEN);
    assert_eq!(list(&conn, 10).unwrap().len(), 2);
}

#[test]
fn a_question_below_the_overlap_still_asks() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
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

    let mut logo = ask_input("fm", "logo", &[]);
    logo.question = "What colour should the new logo be?".into();
    let logo = ask(&mut conn, logo, 4).unwrap();
    assert!(logo.created);
    assert!(!logo.matched);

    let mut near = ask_input("fm", "logo-blue", &[]);
    near.question = "Keep the logo blue?".into();
    let near = ask(&mut conn, near, 5).unwrap();
    assert!(near.created && !near.matched, "{near:?}");

    let mut low = ask_input("fm", "logo-mix", &[]);
    low.question = "Keep sessions, but change the logo colour, the blue and the font".into();
    let low = ask(&mut conn, low, 6).unwrap();
    assert!(low.created && !low.matched, "{low:?}");

    let mut other = ask_input("fm", "other-retention", &[]);
    other.project = Some("other".into());
    other.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    let other = ask(&mut conn, other, 7).unwrap();
    assert!(other.created && !other.matched);

    // Still open: a close wording is a new question, not a reuse.
    let mut notes = ask_input("fm", "notes", &[]);
    notes.question = "Ship the weekly notes, or hold them?".into();
    ask(&mut conn, notes, 8).unwrap();
    let mut notes_again = ask_input("fm", "notes-again", &[]);
    notes_again.question = "Should we ship the weekly notes?".into();
    let notes_again = ask(&mut conn, notes_again, 9).unwrap();
    assert!(notes_again.created && !notes_again.matched);

    let mut tiny = ask_input("fm", "tiny", &[]);
    tiny.question = "Go now?".into();
    let tiny = ask(&mut conn, tiny, 10).unwrap();
    assert!(tiny.created && !tiny.matched);

    set_standing(&mut conn, "hivra", "retention", false, 11)
        .unwrap()
        .unwrap();
    let mut off = ask_input("fm", "retention-off", &[]);
    off.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    let off = ask(&mut conn, off, 12).unwrap();
    assert!(off.created && !off.matched);
    assert_eq!(off.decision.state, OPEN);
}

#[test]
fn force_asks_again_only_with_a_reason() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
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

    let mut forced = ask_input("fm", "retention-force", &[]);
    forced.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    forced.force = true;
    let empty = ask(&mut conn, forced, 4).unwrap_err();
    assert!(empty.contains("empty"), "{empty}");
    assert_eq!(list(&conn, 10).unwrap().len(), 1);

    let mut blank = ask_input("fm", "retention-force", &[]);
    blank.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    blank.force = true;
    blank.reason = Some("   ".into());
    assert!(ask(&mut conn, blank, 5).unwrap_err().contains("empty"));

    let mut long = ask_input("fm", "retention-force", &[]);
    long.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    long.force = true;
    long.reason = Some("x".repeat(301));
    assert!(ask(&mut conn, long, 6).unwrap_err().contains("at most 300"));
    assert_eq!(list(&conn, 10).unwrap().len(), 1);
    assert!(get(&conn, "hivra", "retention-force").unwrap().is_none());

    let mut reason = ask_input("fm", "retention-force", &[]);
    reason.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    reason.force = true;
    reason.reason = Some("  The host now deletes them  ".into());
    let opened = ask(&mut conn, reason, 7).unwrap();
    assert!(!opened.matched);
    assert!(opened.created);
    assert_eq!(opened.decision.state, OPEN);
    assert!(opened.decision.answer.is_none());
    assert_eq!(
        get(&conn, "hivra", "retention")
            .unwrap()
            .unwrap()
            .answer
            .as_deref(),
        Some("Keep 30 days")
    );
    assert_eq!(list(&conn, 10).unwrap().len(), 2);

    // No standing answer applies, so force does not need a reason.
    let mut logo = ask_input("fm", "logo", &[]);
    logo.question = "What colour should the new logo be?".into();
    logo.force = true;
    let logo = ask(&mut conn, logo, 8).unwrap();
    assert!(logo.created && !logo.matched);
}

#[test]
fn match_words_drop_the_invalid_ones_and_keep_twelve() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();

    let mut logo = ask_input("fm", "logo", &[]);
    logo.question = "What colour should the new logo be?".into();
    logo.keys = vec![
        "Session-Retention".into(),
        "bad word".into(),
        "x".into(),
        "".into(),
        "Session-Retention".into(),
    ];
    let logo = ask(&mut conn, logo, 2).unwrap();
    assert!(logo.created && !logo.matched);
    assert_eq!(logo.decision.keys, vec!["session-retention".to_string()]);

    let mut derived = ask_input("fm", "derived", &[]);
    derived.keys = vec![" ".into(), "x".into(), "bad word".into()];
    let derived = ask(&mut conn, derived, 3).unwrap();
    assert!(derived.created);
    assert!(
        derived.decision.keys.contains(&"keep".to_string()),
        "{:?}",
        derived.decision.keys
    );
    assert!(derived.decision.keys.contains(&"session".to_string()));
    assert!(!derived.decision.keys.iter().any(|word| word == "for"));

    let mut many = ask_input("fm", "font", &[]);
    many.question = "Which font should the title use?".into();
    many.keys = (0..13).map(|n| format!("k{n:02}")).collect();
    let many = ask(&mut conn, many, 4).unwrap();
    assert_eq!(many.decision.keys.len(), 12);
    assert_eq!(many.decision.keys[0], "k00");
    assert_eq!(many.decision.keys[11], "k11");
    assert!(!many.decision.keys.iter().any(|word| word == "k12"));
}

#[test]
fn the_closer_standing_answer_wins_and_a_tie_keeps_the_newer() {
    let closer = store();
    let mut conn = closer.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
    insert_answered(
        &conn,
        "hivra",
        "full",
        "Keep deleted sessions for 30 days, or delete them for good?",
        "Keep",
        4,
    );
    insert_answered(
        &conn,
        "hivra",
        "part",
        "Keep deleted sessions or the logo?",
        "Archive",
        9,
    );
    let mut asked = ask_input("fm", "again", &[]);
    asked.question = "Should we keep deleted sessions for 30 days?".into();
    let out = ask(&mut conn, asked, 10).unwrap();
    assert!(out.matched);
    assert_eq!(out.decision.decision_key, "full");
    assert_eq!(out.decision.answer.as_deref(), Some("Keep"));

    let tie = store();
    let mut conn = tie.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
    insert_answered(
        &conn,
        "hivra",
        "first",
        "Keep deleted sessions for 30 days, or delete them for good?",
        "Keep",
        4,
    );
    insert_answered(
        &conn,
        "hivra",
        "second",
        "Keep deleted sessions for 30 days, or delete them for good?",
        "Archive",
        9,
    );
    let mut asked = ask_input("fm", "again", &[]);
    asked.question = "Should we keep deleted sessions for 30 days, or delete them?".into();
    let out = ask(&mut conn, asked, 10).unwrap();
    assert!(out.matched);
    assert_eq!(out.decision.decision_key, "second");
    assert_eq!(out.decision.answer.as_deref(), Some("Archive"));
}

#[test]
fn standing_rows_count_who_relied_and_stay_empty_while_off() {
    let store = store();
    let conn = store.lock_conn().unwrap();
    for n in 1..=21 {
        insert_answered(
            &conn,
            "hivra",
            &format!("k{n}"),
            &format!("Row {n} only"),
            "Keep",
            n,
        );
    }
    insert_answered(&conn, "hivra", "off", "Reuse this one?", "No", 30);
    conn.execute(
        "UPDATE decisions SET standing = 0 WHERE decision_key = 'off'",
        [],
    )
    .unwrap();
    insert_answered(&conn, "hivra", "gone", "The retired one?", "Old", 31);
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
        "Another project?",
        "Elsewhere",
        40,
    );
    conn.execute(
        "INSERT INTO decision_citations (project, decision_key, task_id, cited_at) VALUES
         ('hivra', 'k21', 'task-a', 1),
         ('hivra', 'k21', 'task-b', 2)",
        [],
    )
    .unwrap();

    assert!(standing_rows(&conn, "hivra").unwrap().is_empty());
    assert!(standing_rows(&conn, "  ").unwrap().is_empty());
    set_standing_enabled(&conn, true).unwrap();
    assert!(standing_rows(&conn, "").unwrap().is_empty());
    assert!(standing_rows(&conn, "   ").unwrap().is_empty());

    let rows = standing_rows(&conn, "hivra").unwrap();
    assert_eq!(rows.len(), 20);
    assert_eq!(rows[0].decision_key, "k21");
    assert_eq!(rows[0].uses, 2);
    assert_eq!(rows[0].answer, "Keep");
    assert!(rows[0].standing_id.starts_with("S-"));
    assert!(rows.iter().all(|row| row.decision_key != "k1"));
    assert!(rows.iter().all(|row| row.decision_key != "off"));
    assert!(rows.iter().all(|row| row.decision_key != "gone"));
    assert!(rows.iter().all(|row| row.decision_key != "open-one"));
    assert!(standing_rows(&conn, "other").unwrap().len() == 1);
}

#[test]
fn only_the_person_answers_a_fresh_eyes_review_and_the_app_may_close_it() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    for key in [
        "fresh-eyes/r1/00112233aabbccdd",
        "fresh-eyes-start/r1/00112233aabbccdd",
    ] {
        ask(
            &mut conn,
            AskInput {
                question: "Fresh-eyes review: waiting on you".into(),
                options: vec!["Approve".into(), "Edit plan".into(), "Skip once".into()],
                recommended: None,
                ..ask_input("lead", key, &[])
            },
            2,
        )
        .unwrap();
        // The chat that asked cannot take the question out of the person's Inbox, nor can anything else but the person.
        for machine in [
            Some("chat:lead"),
            Some("autopilot"),
            Some("chat:someone-else"),
        ] {
            let refusal = answer(
                &mut conn,
                "hivra",
                key,
                "Approve",
                machine.map(str::to_string),
                3,
            )
            .unwrap_err();
            assert!(
                refusal.contains("Only the person answers a fresh-eyes review"),
                "{refusal}"
            );
        }
        assert_eq!(
            get(&conn, "hivra", key).unwrap().unwrap().state,
            OPEN,
            "{key}"
        );
    }
    // The person, in either of the app's own answer paths, goes through.
    for (key, by) in [
        ("fresh-eyes/r1/00112233aabbccdd", Some("user")),
        ("fresh-eyes-start/r1/00112233aabbccdd", None),
    ] {
        assert!(
            answer(
                &mut conn,
                "hivra",
                key,
                "Approve",
                by.map(str::to_string),
                4
            )
            .unwrap()
            .applied,
            "{key}"
        );
    }
    // The app closes its own question when a brief is taken back, and tells the chat that asked nothing: it did it.
    let key = "fresh-eyes/r2/ffeeddccbbaa0011";
    ask(&mut conn, ask_input("lead", key, &[]), 5).unwrap();
    let out = answer(
        &mut conn,
        "hivra",
        key,
        "Cancelled by the chat that asked.",
        Some(APP_CLOSER.into()),
        6,
    )
    .unwrap();
    assert!(out.applied);
    assert!(out.released.is_empty(), "{:?}", out.released);
    assert_eq!(
        get(&conn, "hivra", key)
            .unwrap()
            .unwrap()
            .answered_by
            .as_deref(),
        Some(APP_CLOSER)
    );
    // The app's word is not a way round for any other key: an irreversible step is still the person's alone.
    let hard = "irreversible/lead/task-9";
    ask(&mut conn, ask_input("lead", hard, &[]), 7).unwrap();
    let refusal = answer(
        &mut conn,
        "hivra",
        hard,
        "Approve",
        Some(APP_CLOSER.into()),
        8,
    )
    .unwrap_err();
    assert!(
        refusal.contains("Only the person answers an irreversible step"),
        "{refusal}"
    );
}

/// WP-156 security: a key the person alone answers, a delivery gate's approval, or a secret never reuses an old answer
/// and never shows up as guidance. A reworded question on an ordinary key still gets the standing answer.
#[test]
fn a_gate_secret_or_irreversible_key_never_reuses_or_shows_a_standing_answer() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
    let kept = [
        (
            "gate/run-1",
            "Merge the room branch into main?",
            vec!["Approve", "Fix", "Skip"],
        ),
        (
            "secret/token-1",
            "Rotate the room token for the bot?",
            vec!["Yes", "No"],
        ),
        (
            "irreversible/run/a",
            "Delete the room archive for good?",
            vec!["Yes", "No"],
        ),
        (
            "fresh-eyes/r1/00112233",
            "Fresh-eyes review of the room plan?",
            vec!["Approve", "Skip once"],
        ),
    ];
    for (n, (key, question, options)) in kept.iter().enumerate() {
        let asked = ask(
            &mut conn,
            AskInput {
                asked_by: "fm".into(),
                asked_by_mono: None,
                project: Some("hivra".into()),
                key: key.to_string(),
                question: question.to_string(),
                options: options.iter().map(|o| o.to_string()).collect(),
                recommended: None,
                task_ids: Vec::new(),
                keys: Vec::new(),
                force: false,
                reason: None,
            },
            2 + n as i64,
        )
        .unwrap();
        assert!(asked.created && !asked.matched);
        assert!(
            get(&conn, "hivra", key).unwrap().unwrap().keys.is_empty(),
            "{key} stored match words"
        );
        let done = answer(
            &mut conn,
            "hivra",
            key,
            options[0],
            Some("user".into()),
            10 + n as i64,
        )
        .unwrap();
        assert!(done.applied, "{key} was not answered");
    }
    assert!(standing_rows(&conn, "hivra").unwrap().is_empty());
    assert_eq!(standing_block(&conn, "hivra").unwrap(), "");

    let probes = [
        "Merge the room branch into main, please?",
        "Rotate the room token for the bot?",
        "Delete the room archive for good?",
        "Fresh-eyes review of the room plan?",
    ];
    for (n, question) in probes.iter().enumerate() {
        let mut probe = ask_input("fm", &format!("probe-{n}"), &[]);
        probe.question = question.to_string();
        probe.options = vec!["Yes".into(), "No".into()];
        probe.recommended = None;
        let out = ask(&mut conn, probe, 20 + n as i64).unwrap();
        assert!(!out.matched, "{question} reused a key it must not");
        assert!(out.created, "{question} did not open a decision");
        assert_eq!(out.decision.state, OPEN);
    }

    assert!(standing_eligible("retention-policy"));
    assert!(!standing_eligible("gate/run-1"));
    assert!(!standing_eligible("secret/token-1"));
    assert!(!standing_eligible("irreversible/run/a"));
    assert!(!standing_eligible("fresh-eyes-start/r1"));
}

/// WP-156 security, the chat-start path: a protected key never shows as guidance, whatever its case. Keys are stored as
/// typed (`key_like` keeps the case), so `Gate/...` must be refused the same as `gate/...`.
#[test]
fn a_protected_key_in_any_case_never_shows_at_a_chat_start() {
    let store = store();
    let conn = store.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();
    insert_answered(
        &conn,
        "hivra",
        "ordinary",
        "Ship to staging first?",
        "Staging first",
        1,
    );
    insert_answered(
        &conn,
        "hivra",
        "Gate/run-9",
        "Merge the room branch?",
        "Approve",
        2,
    );
    insert_answered(
        &conn,
        "hivra",
        "SECRET/token-9",
        "Rotate the bot token?",
        "Yes",
        3,
    );
    insert_answered(
        &conn,
        "hivra",
        "Irreversible/lead/task",
        "Delete the archive?",
        "Yes",
        4,
    );
    insert_answered(
        &conn,
        "hivra",
        "Fresh-Eyes/r1/0011",
        "Review the plan?",
        "Approve",
        5,
    );
    let block = standing_block(&conn, "hivra").unwrap();
    assert!(block.contains("Ship to staging first?"), "{block}");
    for leaked in [
        "Gate/run-9",
        "Merge the room branch",
        "SECRET/",
        "Rotate the bot",
        "Irreversible/",
        "Delete the archive",
        "Fresh-Eyes",
        "Review the plan",
    ] {
        assert!(
            !block.contains(leaked),
            "{leaked} leaked into the chat-start block:\n{block}"
        );
    }
    assert_eq!(
        block.lines().filter(|line| line.starts_with("S-")).count(),
        1,
        "{block}"
    );
    assert!(!standing_eligible("Gate/run-9"));
    assert!(!standing_eligible(" SECRET/token-9 "));
    assert!(!standing_eligible("Irreversible/lead/task"));
    assert!(!standing_eligible("Fresh-Eyes/r1"));
    assert!(standing_eligible("retention-policy"));
}

/// WP-156 steps a to e, through the store the way the app drives it (the same calls `decisions_*` make): a first mate
/// asks, the person answers in the Inbox, a reworded question comes back with the answer and its citation, retire lists
/// who relied on it, the reworded question is then asked fresh, and with the setting off nothing matches.
#[test]
fn standing_answer_flow_asks_answers_reuses_retires_and_turns_off() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    set_standing_enabled(&conn, true).unwrap();

    // a. A first mate asks, with a task of its own waiting on the answer.
    let task = record(&mut conn, launch("fm", "r1", "w1"), 1).unwrap();
    let mut first = ask_input("fm", "release-target", &[&task.id]);
    first.question = "Should the release go to staging or straight to prod?".into();
    first.options = vec!["Staging first".into(), "Prod now".into()];
    first.recommended = Some("Staging first".into());
    first.keys = vec!["staging".into(), "prod".into(), "release".into()];
    let asked = ask(&mut conn, first, 2).unwrap();
    assert!(asked.created && !asked.matched);
    assert_eq!(asked.decision.state, OPEN);
    assert_eq!(
        list(&conn, 10)
            .unwrap()
            .iter()
            .filter(|d| d.state == OPEN)
            .count(),
        1
    );

    // b. The person answers in the Inbox. The waiting task is released, and the answer is standing for the project.
    let answered = answer(
        &mut conn,
        "hivra",
        "release-target",
        "Staging first",
        Some("user".into()),
        3,
    )
    .unwrap();
    assert!(answered.applied);
    assert_eq!(answered.released_tasks, vec![task.id.clone()]);
    let block = standing_block(&conn, "hivra").unwrap();
    assert!(
        block.contains("S-")
            && block
                .contains("Should the release go to staging or straight to prod? -> Staging first"),
        "{block}"
    );

    // c. Later, a reworded question on a new key returns the answer, with its id, and no Inbox item opens.
    let later = record(&mut conn, launch("fm", "r2", "w2"), 4).unwrap();
    let mut reworded = ask_input("fm", "where-do-we-ship", &[&later.id]);
    reworded.question = "Do we ship the release to staging first, or go to prod now?".into();
    reworded.options = vec!["Staging first".into(), "Prod now".into()];
    reworded.recommended = Some("Staging first".into());
    reworded.keys = Vec::new();
    let hit = ask(&mut conn, reworded, 5).unwrap();
    assert!(hit.matched && !hit.created, "{hit:?}");
    assert_eq!(hit.decision.decision_key, "release-target");
    assert_eq!(hit.decision.answer.as_deref(), Some("Staging first"));
    assert_eq!(
        hit.standing_id.as_deref(),
        Some(hit.decision.standing_id.as_str())
    );
    assert_eq!(hit.released.len(), 1);
    assert_eq!(hit.released[0].child_session, "w2");
    assert_eq!(
        list(&conn, 10)
            .unwrap()
            .iter()
            .filter(|d| d.state == OPEN)
            .count(),
        0
    );
    let uses = standing_rows(&conn, "hivra").unwrap();
    assert_eq!(uses.len(), 1);
    assert_eq!(
        uses[0].uses, 1,
        "the waiting task that asked is the one that relied on it"
    );

    // d. Retire is asked for a reason, and lists every task that relied on it. The reworded question is then asked fresh.
    let retired = retire(
        &mut conn,
        "hivra",
        "release-target",
        "Staging was removed",
        6,
    )
    .unwrap();
    assert!(retired.applied);
    let relied: Vec<&str> = retired
        .relied
        .iter()
        .map(|row| row.task_id.as_str())
        .collect();
    assert_eq!(relied, vec![later.id.as_str()]);
    assert!(standing_rows(&conn, "hivra").unwrap().is_empty());
    assert_eq!(standing_block(&conn, "hivra").unwrap(), "");
    let mut fresh = ask_input("fm", "where-do-we-ship-again", &[]);
    fresh.question = "Do we ship the release to staging first, or go to prod now?".into();
    fresh.options = vec!["Staging first".into(), "Prod now".into()];
    fresh.recommended = Some("Staging first".into());
    let after = ask(&mut conn, fresh, 7).unwrap();
    assert!(after.created && !after.matched, "{after:?}");
    assert_eq!(after.decision.state, OPEN);
    assert_eq!(
        list(&conn, 10)
            .unwrap()
            .iter()
            .filter(|d| d.state == OPEN)
            .count(),
        1
    );

    // e. With the setting off, the same wording never matches, and no block is handed to a chat.
    answer(
        &mut conn,
        "hivra",
        "where-do-we-ship-again",
        "Prod now",
        Some("user".into()),
        8,
    )
    .unwrap();
    set_standing_enabled(&conn, false).unwrap();
    let mut off = ask_input("fm", "where-do-we-ship-off", &[]);
    off.question = "Do we ship the release to staging first, or go to prod now?".into();
    off.options = vec!["Staging first".into(), "Prod now".into()];
    off.recommended = Some("Staging first".into());
    let off = ask(&mut conn, off, 9).unwrap();
    assert!(off.created && !off.matched, "{off:?}");
    assert_eq!(standing_block(&conn, "hivra").unwrap(), "");
    assert!(standing_rows(&conn, "hivra").unwrap().is_empty());
}

/// WP-172: a stopped fan-out task starts again only on the person's yes. No chat (the model's own ask_person answer
/// included) and no app closer can give it.
#[test]
fn only_the_person_answers_a_restart_decision_of_a_stopped_task() {
    let store = store();
    let mut conn = store.lock_conn().unwrap();
    let key = "fanout-again/r1/api/f2_r1-api";
    ask(
        &mut conn,
        AskInput {
            question: "Start api again?".into(),
            options: vec!["Start it again".into(), "Leave it stopped".into()],
            recommended: Some("Leave it stopped".into()),
            ..ask_input("lead", key, &[])
        },
        2,
    )
    .unwrap();
    for machine in [Some("chat:lead"), Some("autopilot"), Some(APP_CLOSER)] {
        let refusal = answer(
            &mut conn,
            "hivra",
            key,
            "Start it again",
            machine.map(str::to_string),
            3,
        )
        .unwrap_err();
        assert!(
            refusal.contains("Only the person answers whether a stopped task starts again"),
            "{refusal}"
        );
    }
    assert_eq!(get(&conn, "hivra", key).unwrap().unwrap().state, OPEN);
    // The person's own answer goes through.
    assert!(
        answer(
            &mut conn,
            "hivra",
            key,
            "Start it again",
            Some("user".into()),
            4
        )
        .unwrap()
        .applied
    );
}

/// WP-172: a restart decision names a plan, a task and a request id, each up to its own length, so its key can be longer
/// than an ordinary decision's; the longer limit is for that prefix only.
#[test]
fn a_restart_decision_key_names_a_whole_plan_task_and_request() {
    let key = format!(
        "fanout-again/{}/{}/{}/{}",
        "p".repeat(100),
        "t".repeat(40),
        "r".repeat(100),
        "0".repeat(16)
    );
    assert!(key.len() > KEY_MAX && key.len() <= FANOUT_AGAIN_KEY_MAX);
    assert_eq!(key_like(&key).unwrap(), key);
    assert!(key_like(&"k".repeat(KEY_MAX + 1)).is_err());
    assert!(key_like(&format!("other/{}", "x".repeat(KEY_MAX))).is_err());
}
