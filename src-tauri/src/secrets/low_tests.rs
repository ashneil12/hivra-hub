//! WP-92 follow-up: a secret card's version never repeats when the row is ahead of the counter.

use super::*;
use rusqlite::{params, Connection};

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
