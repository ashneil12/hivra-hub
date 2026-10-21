//! The workers waiting for a free worker (board H8, src/features/monos/model/workerPool.ts), kept in the app database
//! so the queue survives a restart, every window sees the same one, and there is only one of it.
//!
//! - **worker_queue**: one row per waiting job, in the order it was asked (`seq`). The job itself is the app's own
//!   object (delegate_task's input, title, project...), stored as JSON: this file only keeps order and identity.
//! - `take` removes a job and says whether this call removed it, so of two windows starting the same job only one does.
//! - **worker_queue_meta**: `imported_local`, set the first time a window hands over the queue an older build kept in
//!   its own local storage, so that is imported once.
//! - Own tables, no numbered migration (like rooms and delegations), so an older build still opens the database.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::session_store::SessionStore;

pub const CHANGED: &str = "worker-queue-changed";
const ID_MAX: usize = 600;
/// A brief is up to 60 000 characters (agentAppTasks.ts); the rest of a job is small.
const JOB_MAX: usize = 200_000;
const QUEUE_MAX: i64 = 500;

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS worker_queue (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            owner_session TEXT NOT NULL,
            project TEXT NOT NULL,
            job_json TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS worker_queue_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )
}

fn field<'a>(job: &'a Value, name: &str) -> Result<&'a str, String> {
    match job.get(name).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() && value.len() <= ID_MAX => Ok(value),
        _ => Err(format!("A waiting worker needs {name}")),
    }
}

/// Adds a job at the end; one already waiting keeps its place. True when it was added.
pub fn add(conn: &Connection, job: &Value) -> Result<bool, String> {
    if !job.is_object() {
        return Err("A waiting worker is an object".into());
    }
    let id = field(job, "id")?;
    let owner = field(job, "ownerSession")?;
    let project = field(job, "project")?;
    field(job, "requestId")?;
    let text = job.to_string();
    if text.len() > JOB_MAX {
        return Err("This waiting worker is too large to keep".into());
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM worker_queue", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if count >= QUEUE_MAX {
        return Err(format!("{QUEUE_MAX} workers are already waiting"));
    }
    let added = conn
        .execute(
            "INSERT OR IGNORE INTO worker_queue (id, owner_session, project, job_json) VALUES (?1, ?2, ?3, ?4)",
            params![id, owner, project, text],
        )
        .map_err(|e| e.to_string())?;
    Ok(added > 0)
}

/// Every waiting job, first asked first.
pub fn list(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare("SELECT job_json FROM worker_queue ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut jobs = Vec::new();
    for text in rows {
        if let Ok(job) = serde_json::from_str::<Value>(&text.map_err(|e| e.to_string())?) {
            jobs.push(job);
        }
    }
    Ok(jobs)
}

/// Removes one job. True only for the call that removed it.
pub fn take(conn: &Connection, id: &str) -> Result<bool, String> {
    let removed = conn
        .execute("DELETE FROM worker_queue WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(removed > 0)
}

/// The queue an older build kept in a window's local storage, imported once (in the order it was asked, after any
/// already here). Returns how many were added: none once it has been imported before.
pub fn import_local(conn: &mut Connection, mut jobs: Vec<Value>) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let done = tx
        .query_row(
            "SELECT value FROM worker_queue_meta WHERE key = 'imported_local'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if done.is_some() {
        return Ok(0);
    }
    jobs.sort_by_key(|job| job.get("queuedAt").and_then(Value::as_i64).unwrap_or(0));
    let mut added = 0;
    for job in &jobs {
        // A malformed leftover is skipped, never a reason to lose the rest.
        if let Ok(true) = add(&tx, job) {
            added += 1;
        }
    }
    tx.execute(
        "INSERT INTO worker_queue_meta (key, value) VALUES ('imported_local', ?1)",
        params![added.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED, json!({}));
}

#[tauri::command(async)]
pub fn worker_queue_list(store: State<'_, SessionStore>) -> Result<Vec<Value>, String> {
    list(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn worker_queue_add(
    app: AppHandle,
    store: State<'_, SessionStore>,
    job: Value,
) -> Result<bool, String> {
    let added = add(&*store.lock_conn()?, &job)?;
    if added {
        changed(&app);
    }
    Ok(added)
}

#[tauri::command(async)]
pub fn worker_queue_take(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
) -> Result<bool, String> {
    let taken = take(&*store.lock_conn()?, &id)?;
    if taken {
        changed(&app);
    }
    Ok(taken)
}

#[tauri::command(async)]
pub fn worker_queue_import_local(
    app: AppHandle,
    store: State<'_, SessionStore>,
    jobs: Vec<Value>,
) -> Result<usize, String> {
    let added = import_local(&mut *store.lock_conn()?, jobs)?;
    if added > 0 {
        changed(&app);
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    fn job(id: &str, queued_at: i64) -> Value {
        json!({ "id": id, "ownerSession": "lead", "requestId": id, "project": "hivra", "queuedAt": queued_at, "input": { "brief": id } })
    }

    fn ids(conn: &Connection) -> Vec<String> {
        list(conn)
            .unwrap()
            .iter()
            .map(|j| j["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn keeps_the_order_asked_and_never_adds_a_job_twice() {
        let conn = conn();
        assert!(add(&conn, &job("b", 5)).unwrap());
        assert!(add(&conn, &job("a", 1)).unwrap());
        assert!(!add(&conn, &job("b", 9)).unwrap(), "b keeps its place");
        assert_eq!(ids(&conn), ["b", "a"]);
        assert_eq!(list(&conn).unwrap()[0]["input"]["brief"], "b");
    }

    #[test]
    fn only_one_caller_takes_a_job() {
        let conn = conn();
        add(&conn, &job("a", 1)).unwrap();
        assert!(take(&conn, "a").unwrap());
        assert!(!take(&conn, "a").unwrap());
        assert!(ids(&conn).is_empty());
    }

    #[test]
    fn survives_reopening_the_database() {
        let dir = std::env::temp_dir().join(format!("worker-queue-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            ensure_tables(&conn).unwrap();
            for (id, at) in [("q1", 1), ("q2", 2), ("q3", 3)] {
                add(&conn, &job(id, at)).unwrap();
            }
        }
        let conn = Connection::open(&path).unwrap();
        ensure_tables(&conn).unwrap();
        assert_eq!(ids(&conn), ["q1", "q2", "q3"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_a_local_queue_once_in_its_order_after_what_is_here() {
        let mut conn = conn();
        add(&conn, &job("here", 50)).unwrap();
        let added = import_local(
            &mut conn,
            vec![
                job("late", 30),
                json!({ "id": "" }),
                job("early", 10),
                job("here", 1),
            ],
        )
        .unwrap();
        assert_eq!(added, 2);
        assert_eq!(ids(&conn), ["here", "early", "late"]);
        assert_eq!(import_local(&mut conn, vec![job("again", 1)]).unwrap(), 0);
        assert_eq!(ids(&conn), ["here", "early", "late"]);
    }

    #[test]
    fn refuses_a_job_without_its_identity() {
        let conn = conn();
        assert!(add(
            &conn,
            &json!({ "id": "x", "ownerSession": "lead", "project": "hivra" })
        )
        .is_err());
        assert!(add(&conn, &json!("x")).is_err());
    }
}
