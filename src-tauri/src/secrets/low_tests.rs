//! WP-92 follow-up: a secret card's version never repeats when the row is ahead of the counter, and a Once
//! card is deleted only at the version that was read.

use super::store::Memory;
use super::*;
use crate::session_store::SessionStore;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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

/// The Once card is cleared only at the version that was read. A newer version another window has already
/// committed is left in place, and this run waits: its grant rolls back. A missed version used to commit
/// the grant anyway.
#[test]
fn once_grant_leaves_a_card_whose_version_moved() {
    // A file, not memory: another window commits the new version, and a memory database is private to one connection.
    let dir = std::env::temp_dir().join(format!("mc-once-version-{}", uuid::Uuid::new_v4()));
    let _rm = RmDir(dir.clone());
    let path = dir.join("monocode.db");
    let store = SessionStore::open(path.clone()).unwrap();
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
    // Another window commits a new version after this run has read the card and before the grant is written.
    // A bump inside the grant transaction would roll back with the grant, so it cannot stand in for that window.
    let bumped = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&bumped);
    let bump_path = path.clone();
    let bump_key = decision_key.clone();
    conn.authorizer(Some(move |ctx: AuthContext<'_>| {
        if let AuthAction::Read {
            table_name: "secret_card_bindings",
            ..
        } = ctx.action
        {
            if !flag.swap(true, Ordering::SeqCst) {
                let other = Connection::open(&bump_path).unwrap();
                other
                    .busy_timeout(std::time::Duration::from_secs(2))
                    .unwrap();
                let moved = other
                    .execute(
                        "UPDATE decisions SET version = version + 100 WHERE project = '' AND decision_key = ?1",
                        params![bump_key.as_str()],
                    )
                    .unwrap();
                assert_eq!(moved, 1, "the other window must move the card");
            }
        }
        Authorization::Allow
    }))
    .unwrap();
    let outcome = prepare_run(&vault, &mut conn, run_request("mono-1"), NOW + 2).unwrap();
    assert!(
        bumped.load(Ordering::SeqCst),
        "the other window never moved the card"
    );
    assert!(
        matches!(outcome, RunOutcome::Waiting { .. }),
        "a once answer whose card moved must wait, got {outcome:?}"
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
        "no grant may be left behind"
    );
}

/// A refused Always deletes the card it read, and only that version. A newer card another window has
/// already committed stays, binding and all. Covers both refusal sentences: a program that can run any
/// code, and one that cannot.
#[test]
fn a_refused_always_does_not_delete_a_newer_card() {
    for program in [code_program(), harmless_program()] {
        refused_always_leaves_the_newer_card(program);
    }
}

fn refused_always_leaves_the_newer_card(program: &str) {
    let dir = std::env::temp_dir().join(format!("mc-always-version-{}", uuid::Uuid::new_v4()));
    let _rm = RmDir(dir.clone());
    let path = dir.join("monocode.db");
    let store = SessionStore::open(path.clone()).unwrap();
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
    let request = RunRequest {
        chat: "chat-1".into(),
        mono: Some("mono-1".into()),
        project: None,
        name: "stripe-api-key".into(),
        env: "STRIPE_API_KEY".into(),
        command: vec![program.into(), "customers".into(), "list".into()],
        cwd: None,
        timeout_seconds: None,
    };
    let mut conn = store.lock_conn().unwrap();
    let RunOutcome::Waiting { decision_key, .. } =
        prepare_run(&vault, &mut conn, request.clone(), NOW).unwrap()
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
        "Always for this Mono",
        Some("person".into()),
        Some(seen),
        NOW + 1,
    )
    .unwrap();
    let read = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .unwrap()
        .version;
    let bumped = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&bumped);
    let bump_path = path.clone();
    let bump_key = decision_key.clone();
    conn.authorizer(Some(move |ctx: AuthContext<'_>| {
        if let AuthAction::Read {
            table_name: "secret_card_bindings",
            ..
        } = ctx.action
        {
            if !flag.swap(true, Ordering::SeqCst) {
                let other = Connection::open(&bump_path).unwrap();
                other
                    .busy_timeout(std::time::Duration::from_secs(2))
                    .unwrap();
                let moved = other
                    .execute(
                        "UPDATE decisions SET version = version + 100 WHERE project = '' AND decision_key = ?1",
                        params![bump_key.as_str()],
                    )
                    .unwrap();
                assert_eq!(moved, 1, "the other window must move the card");
            }
        }
        Authorization::Allow
    }))
    .unwrap();
    let err = prepare_run(&vault, &mut conn, request, NOW + 2).unwrap_err();
    assert!(
        bumped.load(Ordering::SeqCst),
        "{program}: the other window never moved the card"
    );
    assert!(err.contains("asks every time"), "{program}: {err}");
    let card = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .expect("a refused Always deleted a newer card");
    assert_eq!(
        card.version,
        read + 100,
        "{program}: card version is {}",
        card.version
    );
    assert_eq!(card.answer.as_deref(), Some("Always for this Mono"));
    assert!(
        binding_of(&conn, "", &decision_key).unwrap().is_some(),
        "{program}: the newer card's binding was deleted"
    );
    assert!(
        grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .is_empty(),
        "{program}: a refused Always left a grant"
    );
}

/// "Always for this project" with no project never reaches put_grant. It must not fall through to a grant.
#[test]
fn an_always_for_this_project_with_no_project_does_not_grant() {
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
        "Always for this project",
        Some("person".into()),
        Some(seen),
        NOW + 1,
    )
    .unwrap();
    let outcome = prepare_run(&vault, &mut conn, run_request("mono-1"), NOW + 2);
    assert!(
        outcome.is_err(),
        "an Always answer with no project granted the run: {outcome:?}"
    );
    assert!(
        grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .is_empty(),
        "no grant may be left behind"
    );
    let again = prepare_run(&vault, &mut conn, run_request("mono-1"), NOW + 3).unwrap();
    assert!(
        matches!(again, RunOutcome::Waiting { .. }),
        "the next run must be asked, got {again:?}"
    );
}

/// Removes a temp database directory after the store that uses it has been dropped.
struct RmDir(std::path::PathBuf);

impl Drop for RmDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
