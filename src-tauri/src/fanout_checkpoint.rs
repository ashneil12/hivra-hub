//! Hivra WP-172: the checkpoint of a First Mate fan-out (delegate_tasks), kept in the app database so a crash or a
//! restart in the middle of a plan can be resumed without sending again the tasks that already started.
//!
//! - One row per plan, keyed by its owner chat and its request id. The body is the checkpoint as the app wrote it
//!   (src/features/firstmate/model/fanoutCheckpoint.ts); this file only keeps identity, order and the revision.
//! - `save` is a compare-and-swap on `revision`: a copy with a revision not newer than the stored one changes nothing,
//!   so a late write never overwrites a newer one.
//! - `list` drops every checkpoint not written for seven days (any owner), then returns one owner's, newest first.
//! - Own table, made by `ensure_tables` (no numbered migration), like worker_queue and delegations.

use rusqlite::{params, Connection};
use serde_json::Value;
use tauri::State;

use crate::session_store::{now_millis, SessionStore};

/// How long a checkpoint is kept after its last write (FANOUT_CHECKPOINT_RETENTION_MS in the model).
pub const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// How long a window holds a plan without renewing it. A window that dies mid-send loses the lease after this.
pub const LEASE_MS: i64 = 90_000;
const ID_MAX: usize = 100;
const OWNER_MAX: usize = 200;
/// A plan of eight tasks, each with a brief of up to 60 000 characters, and its contract, fits well inside this.
const BODY_MAX: usize = 2 * 1024 * 1024;

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS fanout_checkpoints (
            owner TEXT NOT NULL,
            id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (owner, id)
         );
         CREATE TABLE IF NOT EXISTS fanout_leases (
            owner TEXT NOT NULL,
            id TEXT NOT NULL,
            holder TEXT NOT NULL,
            until INTEGER NOT NULL,
            PRIMARY KEY (owner, id)
         );",
    )?;
    // The database is opened once per run, and the instance lock lets one app run per data folder: a lease left in the
    // table was held by a window that has gone, so it must not hold its plan for up to LEASE_MS after a restart.
    conn.execute("DELETE FROM fanout_leases", [])?;
    Ok(())
}

/// Takes the plan's lease for `holder` (one window) when it is free, its holder is `holder`, or it has run out.
/// One statement, so two windows on the same file cannot both win. `Ok(false)` when another window holds it.
pub fn acquire_lease(
    conn: &Connection,
    owner: &str,
    id: &str,
    holder: &str,
    now: i64,
    ttl: i64,
) -> Result<bool, String> {
    if !valid_owner(owner) || !valid_id(id) || holder.is_empty() {
        return Err("A fan-out lease needs an owner, a plan id and a holder".into());
    }
    let changed = conn
        .execute(
            "INSERT INTO fanout_leases (owner, id, holder, until) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(owner, id) DO UPDATE SET
                holder = excluded.holder,
                until = excluded.until
             WHERE fanout_leases.holder = excluded.holder OR fanout_leases.until < ?5",
            params![owner, id, holder, now + ttl, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed == 1)
}

/// Extends a lease the holder still has. `Ok(false)` when it was taken over or released meanwhile.
pub fn renew_lease(
    conn: &Connection,
    owner: &str,
    id: &str,
    holder: &str,
    now: i64,
    ttl: i64,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE fanout_leases SET until = ?1 WHERE owner = ?2 AND id = ?3 AND holder = ?4",
            params![now + ttl, owner, id, holder],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed == 1)
}

/// Gives the lease up, if this holder still has it.
pub fn release_lease(
    conn: &Connection,
    owner: &str,
    id: &str,
    holder: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "DELETE FROM fanout_leases WHERE owner = ?1 AND id = ?2 AND holder = ?3",
            params![owner, id, holder],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed == 1)
}

#[tauri::command(async)]
pub fn fanout_lease_acquire(
    store: State<'_, SessionStore>,
    owner: String,
    id: String,
    holder: String,
) -> Result<bool, String> {
    acquire_lease(
        &*store.lock_conn()?,
        &owner,
        &id,
        &holder,
        now_millis(),
        LEASE_MS,
    )
}

#[tauri::command(async)]
pub fn fanout_lease_renew(
    store: State<'_, SessionStore>,
    owner: String,
    id: String,
    holder: String,
) -> Result<bool, String> {
    renew_lease(
        &*store.lock_conn()?,
        &owner,
        &id,
        &holder,
        now_millis(),
        LEASE_MS,
    )
}

#[tauri::command(async)]
pub fn fanout_lease_release(
    store: State<'_, SessionStore>,
    owner: String,
    id: String,
    holder: String,
) -> Result<bool, String> {
    release_lease(&*store.lock_conn()?, &owner, &id, &holder)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= ID_MAX
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_owner(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= OWNER_MAX && !value.chars().any(char::is_control)
}

/// Writes the checkpoint when its revision is newer than the stored one. `Ok(false)` when a newer copy is already there.
pub fn save(
    conn: &Connection,
    owner: &str,
    id: &str,
    revision: i64,
    body: &Value,
    now: i64,
) -> Result<bool, String> {
    if !valid_owner(owner) {
        return Err("A fan-out checkpoint needs an owner chat".into());
    }
    if !valid_id(id) {
        return Err(
            "A fan-out checkpoint id must be letters, digits, - and _ (up to 100 characters)"
                .into(),
        );
    }
    if revision < 1 {
        return Err("A fan-out checkpoint revision must be at least 1".into());
    }
    if !body.is_object() {
        return Err("A fan-out checkpoint must be an object".into());
    }
    let text = serde_json::to_string(body).map_err(|error| error.to_string())?;
    if text.len() > BODY_MAX {
        return Err("This fan-out checkpoint is too large to keep".into());
    }
    let changed = conn
        .execute(
            "INSERT INTO fanout_checkpoints (owner, id, revision, updated_at, body)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(owner, id) DO UPDATE SET
                revision = excluded.revision,
                updated_at = excluded.updated_at,
                body = excluded.body
             WHERE excluded.revision > fanout_checkpoints.revision",
            params![owner, id, revision, now, text],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed == 1)
}

/// One owner's checkpoints, newest first, after the expired ones of every owner are dropped. A body that no longer
/// parses is skipped rather than failing the list.
pub fn list(conn: &Connection, owner: &str, now: i64) -> Result<Vec<Value>, String> {
    conn.execute(
        "DELETE FROM fanout_checkpoints WHERE updated_at < ?1",
        params![now - RETENTION_MS],
    )
    .map_err(|error| error.to_string())?;
    // A lease that has run out is held by nobody: drop it, so the table does not keep every plan ever sent.
    conn.execute("DELETE FROM fanout_leases WHERE until < ?1", params![now])
        .map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT body FROM fanout_checkpoints WHERE owner = ?1 ORDER BY updated_at DESC, id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![owner], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let text = row.map_err(|error| error.to_string())?;
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            out.push(value);
        }
    }
    Ok(out)
}

/// Drops one owner's checkpoint. `false` when there was none.
pub fn remove(conn: &Connection, owner: &str, id: &str) -> Result<bool, String> {
    if !valid_owner(owner) || !valid_id(id) {
        return Ok(false);
    }
    let removed = conn
        .execute(
            "DELETE FROM fanout_checkpoints WHERE owner = ?1 AND id = ?2",
            params![owner, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(removed == 1)
}

#[tauri::command(async)]
pub fn fanout_checkpoint_save(
    store: State<'_, SessionStore>,
    owner: String,
    id: String,
    revision: i64,
    body: Value,
) -> Result<bool, String> {
    save(
        &*store.lock_conn()?,
        &owner,
        &id,
        revision,
        &body,
        now_millis(),
    )
}

#[tauri::command(async)]
pub fn fanout_checkpoint_list(
    store: State<'_, SessionStore>,
    owner: String,
) -> Result<Vec<Value>, String> {
    list(&*store.lock_conn()?, &owner, now_millis())
}

#[tauri::command(async)]
pub fn fanout_checkpoint_remove(
    store: State<'_, SessionStore>,
    owner: String,
    id: String,
) -> Result<bool, String> {
    remove(&*store.lock_conn()?, &owner, &id)
}

#[cfg(test)]
mod lease_tests {
    use super::*;

    const T0: i64 = 1_000_000_000;

    /// Two connections to one SQLite file, as two windows of the app hold them.
    fn two_windows(name: &str) -> (Connection, Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "fanout-lease-{name}-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = Connection::open(&path).unwrap();
        ensure_tables(&first).unwrap();
        let second = Connection::open(&path).unwrap();
        second
            .busy_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        (first, second, path)
    }

    #[test]
    fn two_windows_on_one_file_cannot_both_hold_the_same_plan() {
        let (a, b, path) = two_windows("exclusive");
        assert!(acquire_lease(&a, "chat-1", "plan-1", "window-a", T0, LEASE_MS).unwrap());
        // The second window is refused while the first holds it.
        assert!(!acquire_lease(&b, "chat-1", "plan-1", "window-b", T0 + 1, LEASE_MS).unwrap());
        // A different plan is free.
        assert!(acquire_lease(&b, "chat-1", "plan-2", "window-b", T0 + 1, LEASE_MS).unwrap());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_holder_renews_and_a_stranger_cannot_renew_or_release() {
        let (a, b, path) = two_windows("renew");
        assert!(acquire_lease(&a, "chat-1", "plan-1", "window-a", T0, LEASE_MS).unwrap());
        assert!(renew_lease(&a, "chat-1", "plan-1", "window-a", T0 + 1000, LEASE_MS).unwrap());
        assert!(!renew_lease(&b, "chat-1", "plan-1", "window-b", T0 + 1000, LEASE_MS).unwrap());
        assert!(!release_lease(&b, "chat-1", "plan-1", "window-b").unwrap());
        // Still held by window-a after the stranger's attempts.
        assert!(!acquire_lease(&b, "chat-1", "plan-1", "window-b", T0 + 1001, LEASE_MS).unwrap());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_released_lease_is_free_and_an_expired_one_is_taken_over() {
        let (a, b, path) = two_windows("takeover");
        assert!(acquire_lease(&a, "chat-1", "plan-1", "window-a", T0, LEASE_MS).unwrap());
        // Window a is gone; once its lease has run out, window b takes it over.
        assert!(acquire_lease(
            &b,
            "chat-1",
            "plan-1",
            "window-b",
            T0 + LEASE_MS + 1,
            LEASE_MS
        )
        .unwrap());
        // A holder that comes back after its lease was taken cannot renew it.
        assert!(!renew_lease(
            &a,
            "chat-1",
            "plan-1",
            "window-a",
            T0 + LEASE_MS + 2,
            LEASE_MS
        )
        .unwrap());
        assert!(release_lease(&b, "chat-1", "plan-1", "window-b").unwrap());
        assert!(acquire_lease(
            &a,
            "chat-1",
            "plan-1",
            "window-a",
            T0 + LEASE_MS + 3,
            LEASE_MS
        )
        .unwrap());
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: i64 = 1_000_000_000;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    fn body(revision: i64) -> Value {
        json!({ "version": 1, "id": "plan-1", "owner": "chat-1", "revision": revision })
    }

    #[test]
    fn ensure_tables_can_run_twice() {
        let conn = db();
        ensure_tables(&conn).unwrap();
    }

    #[test]
    fn a_saved_checkpoint_is_listed_back_for_its_owner_only() {
        let conn = db();
        assert!(save(&conn, "chat-1", "plan-1", 1, &body(1), T0).unwrap());
        let mine = list(&conn, "chat-1", T0).unwrap();
        assert_eq!(mine, vec![body(1)]);
        assert!(list(&conn, "chat-2", T0).unwrap().is_empty());
    }

    #[test]
    fn a_copy_that_is_not_newer_never_replaces_the_stored_one() {
        let conn = db();
        assert!(save(&conn, "chat-1", "plan-1", 2, &body(2), T0).unwrap());
        // A late, older write loses.
        assert!(!save(&conn, "chat-1", "plan-1", 1, &body(1), T0 + 1).unwrap());
        // A repeat of the same revision changes nothing either.
        assert!(!save(
            &conn,
            "chat-1",
            "plan-1",
            2,
            &json!({ "revision": 2, "other": true }),
            T0 + 2
        )
        .unwrap());
        assert_eq!(list(&conn, "chat-1", T0 + 3).unwrap(), vec![body(2)]);
    }

    #[test]
    fn the_same_request_id_under_two_owners_is_two_plans() {
        let conn = db();
        save(&conn, "chat-1", "plan-1", 1, &body(1), T0).unwrap();
        save(
            &conn,
            "chat-2",
            "plan-1",
            1,
            &json!({ "owner": "chat-2", "revision": 1 }),
            T0,
        )
        .unwrap();
        assert_eq!(list(&conn, "chat-1", T0).unwrap(), vec![body(1)]);
        assert_eq!(list(&conn, "chat-2", T0).unwrap().len(), 1);
    }

    #[test]
    fn bad_owner_id_revision_or_body_is_refused_and_nothing_is_written() {
        let conn = db();
        assert!(save(&conn, "  ", "plan-1", 1, &body(1), T0).is_err());
        assert!(save(&conn, "chat-1", "has space", 1, &body(1), T0).is_err());
        assert!(save(&conn, "chat-1", "", 1, &body(1), T0).is_err());
        assert!(save(&conn, "chat-1", "plan-1", 0, &body(0), T0).is_err());
        assert!(save(&conn, "chat-1", "plan-1", 1, &json!("a string"), T0).is_err());
        let too_big = json!({ "blob": "x".repeat(BODY_MAX + 1) });
        assert!(save(&conn, "chat-1", "plan-1", 1, &too_big, T0).is_err());
        assert!(list(&conn, "chat-1", T0).unwrap().is_empty());
    }

    #[test]
    fn a_checkpoint_not_written_for_seven_days_is_dropped_for_every_owner() {
        let conn = db();
        save(&conn, "chat-1", "old", 1, &body(1), T0).unwrap();
        save(&conn, "chat-2", "old", 1, &body(1), T0).unwrap();
        let later = T0 + RETENTION_MS + 1;
        save(&conn, "chat-1", "fresh", 1, &body(1), later).unwrap();
        let listed = list(&conn, "chat-1", later).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(list(&conn, "chat-2", later).unwrap().is_empty());
    }

    #[test]
    fn a_checkpoint_exactly_at_the_limit_is_kept() {
        let conn = db();
        save(&conn, "chat-1", "plan-1", 1, &body(1), T0).unwrap();
        assert_eq!(list(&conn, "chat-1", T0 + RETENTION_MS).unwrap().len(), 1);
    }

    #[test]
    fn newest_first_and_a_damaged_body_is_skipped() {
        let conn = db();
        save(&conn, "chat-1", "older", 1, &body(1), T0).unwrap();
        save(&conn, "chat-1", "newer", 1, &body(1), T0 + 10).unwrap();
        conn.execute(
            "INSERT INTO fanout_checkpoints (owner, id, revision, updated_at, body) VALUES ('chat-1', 'broken', 1, ?1, 'not json')",
            params![T0 + 20],
        )
        .unwrap();
        let listed = list(&conn, "chat-1", T0 + 30).unwrap();
        assert_eq!(listed.len(), 2);
    }

    #[test]
    fn remove_drops_only_that_plan_and_reports_when_there_was_none() {
        let conn = db();
        save(&conn, "chat-1", "plan-1", 1, &body(1), T0).unwrap();
        save(&conn, "chat-1", "plan-2", 1, &body(1), T0).unwrap();
        assert!(remove(&conn, "chat-1", "plan-1").unwrap());
        assert!(!remove(&conn, "chat-1", "plan-1").unwrap());
        assert!(!remove(&conn, "chat-1", "bad id").unwrap());
        assert_eq!(list(&conn, "chat-1", T0).unwrap().len(), 1);
    }
}

#[cfg(test)]
mod lease_hygiene_tests {
    use super::*;

    const T0: i64 = 1_000_000_000;

    /// One SQLite file with the fan-out tables, as the app opens it.
    fn file_db(name: &str) -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "fanout-hygiene-{name}-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let conn = Connection::open(&path).unwrap();
        ensure_tables(&conn).unwrap();
        (conn, path)
    }

    fn lease_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM fanout_leases", [], |row| row.get(0))
            .unwrap()
    }

    /// A lease that has run out is dropped when the checkpoints are listed; one still live stays.
    #[test]
    fn listing_drops_the_leases_that_have_run_out_and_keeps_a_live_one() {
        let (conn, path) = file_db("prune");
        assert!(acquire_lease(&conn, "chat-1", "plan-1", "window-a", T0, LEASE_MS).unwrap());
        assert!(acquire_lease(
            &conn,
            "chat-1",
            "plan-2",
            "window-a",
            T0 + LEASE_MS,
            LEASE_MS
        )
        .unwrap());
        list(&conn, "chat-1", T0 + LEASE_MS + 1).unwrap();
        assert_eq!(lease_rows(&conn), 1);
        let _ = std::fs::remove_file(path);
    }

    /// The app quits without giving its lease up; the next run opens the same database and may take the plan.
    #[test]
    fn a_lease_left_by_an_earlier_run_does_not_block_the_next_open() {
        let (first, path) = file_db("restart");
        assert!(acquire_lease(&first, "chat-1", "plan-1", "window-a", T0, LEASE_MS).unwrap());
        let second = Connection::open(&path).unwrap();
        ensure_tables(&second).unwrap();
        assert!(acquire_lease(&second, "chat-1", "plan-1", "window-b", T0 + 1, LEASE_MS).unwrap());
        let _ = std::fs::remove_file(path);
    }
}
