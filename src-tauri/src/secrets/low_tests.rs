//! WP-92 follow-up: a secret card's version never repeats when the row is ahead of the counter, and a Once
//! card is deleted only at the version that was read.

use super::store::Memory;
use super::*;
use crate::session_store::SessionStore;
use rusqlite::{params, Connection};

const VALUE: &str = "sk_live_51NxAbCdEfGhIjKl";
const NOW: i64 = 1_700_000_000_000;

fn open_decisions() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE decisions (
            project TEXT NOT NULL,
            decision_key TEXT NOT NULL,
            version INTEGER NOT NULL,
            PRIMARY KEY (project, decision_key)
         );",
    )
    .unwrap();
    conn
}

fn put_row(conn: &Connection, version: i64) {
    conn.execute(
        "INSERT INTO decisions (project, decision_key, version) VALUES ('p', 'secret/stripe/curl', ?1)
         ON CONFLICT (project, decision_key) DO UPDATE SET version = excluded.version",
        params![version],
    )
    .unwrap();
}

fn set_high_water(conn: &Connection, high_water: i64) {
    conn.execute(
        "UPDATE secret_card_epochs SET high_water = ?1 WHERE project = 'p'",
        params![high_water],
    )
    .unwrap();
}

/// A row that is already past the counter must not be handed an older version.
/// Before the fix the counter only did `high_water + 1`, so a row at 7 with a counter at 3 was given 4.
#[test]
fn alloc_card_version_stays_past_a_row_ahead_of_the_counter() {
    let conn = open_decisions();
    put_row(&conn, 0);
    assert_eq!(
        alloc_card_version(&conn, "p", "secret/stripe/curl").unwrap(),
        1
    );
    put_row(&conn, 7);
    set_high_water(&conn, 3);
    let next = alloc_card_version(&conn, "p", "secret/stripe/curl").unwrap();
    assert_eq!(
        next, 8,
        "issued {next}, which the row at version 7 already passed (counter was 3)"
    );
    let again = alloc_card_version(&conn, "p", "secret/stripe/curl").unwrap();
    assert_eq!(again, 9, "the next call repeated {next}");
}

/// The counter still starts one past an existing row, and a row behind the counter does not pull it backwards.
#[test]
fn alloc_card_version_keeps_the_higher_of_the_counter_and_the_row() {
    let conn = open_decisions();
    put_row(&conn, 7);
    assert_eq!(
        alloc_card_version(&conn, "p", "secret/stripe/curl").unwrap(),
        8,
        "a first number for an existing row must be one past that row"
    );
    put_row(&conn, 2);
    set_high_water(&conn, 10);
    assert_eq!(
        alloc_card_version(&conn, "p", "secret/stripe/curl").unwrap(),
        11
    );
    // No row at all: the counter still climbs, it does not restart.
    conn.execute("DELETE FROM decisions", []).unwrap();
    assert_eq!(
        alloc_card_version(&conn, "p", "secret/stripe/curl").unwrap(),
        12
    );
}

fn run_request(mono: &str) -> RunRequest {
    RunRequest {
        chat: "chat-1".into(),
        mono: Some(mono.into()),
        project: None,
        name: "stripe-api-key".into(),
        env: "STRIPE_API_KEY".into(),
        command: vec![harmless_program().into(), "customers".into(), "list".into()],
        cwd: None,
        timeout_seconds: None,
    }
}

/// The Once card is deleted inside the grant transaction, and only at the version that was read.
/// A version that moves while the grant is written (another window rebound the card) is left in place.
/// Before the fix the delete ran after the commit and named no version, so it removed the newer card.
#[test]
fn once_grant_leaves_a_card_whose_version_moved() {
    let store = SessionStore::open_in_memory().unwrap();
    let vault = Memory::new();
    {
        let conn = store.lock_conn().unwrap();
        save_value(
            &vault,
            &conn,
            SCOPE_GLOBAL,
            "stripe-api-key",
            None,
            VALUE,
            NOW,
        )
        .unwrap();
    }
    let mut conn = store.lock_conn().unwrap();
    let RunOutcome::Waiting { decision_key, .. } =
        prepare_run(&vault, &mut conn, run_request("mono-1"), NOW).unwrap()
    else {
        panic!("the first run must ask");
    };
    let seen = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .unwrap()
        .version;
    crate::decisions::answer_seen(
        &mut conn,
        "",
        &decision_key,
        "Once",
        Some("person".into()),
        Some(seen),
        NOW + 1,
    )
    .unwrap();
    let read = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .unwrap()
        .version;
    // Moves the card's version in the same transaction as the once grant, which is what a racing rebind does.
    conn.execute_batch(
        "CREATE TRIGGER bump_secret_card_during_once
         AFTER INSERT ON secret_grants
         BEGIN
           UPDATE decisions SET version = version + 100;
         END;",
    )
    .unwrap();
    let outcome = prepare_run(&vault, &mut conn, run_request("mono-1"), NOW + 2).unwrap();
    assert!(
        matches!(outcome, RunOutcome::Granted { .. }),
        "the once answer still grants this run, got {outcome:?}"
    );
    let card = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .expect("a stale version deleted the newer card");
    assert_eq!(card.version, read + 100, "card version is {}", card.version);
    assert_eq!(card.answer.as_deref(), Some("Once"));
    assert!(
        binding_of(&conn, "", &decision_key).unwrap().is_some(),
        "the newer card's binding was deleted with the stale version"
    );
    assert!(
        grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .is_empty(),
        "the once grant must still be spent"
    );
}
