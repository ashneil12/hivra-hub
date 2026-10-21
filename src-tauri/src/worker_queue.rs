//! The workers waiting for a free worker (board H8, src/features/monos/model/workerPool.ts), kept in the app database
//! so the queue survives a restart, every window sees the same one, and there is only one of it.
//!
//! - **worker_queue**: one row per waiting job, in the order it was asked (`seq`). The job itself is the app's own
//!   object (delegate_task's input, title, project...), stored as JSON: this file only keeps order and identity.
//! - Starting a job is a lease, not a removal: `claim` marks it as being started by one window until `claimed_until`
//!   (LEASE_MS), `finish` removes it once started. A job whose lease runs out (the window died mid-start), and every
//!   claim on the next launch (`init`), is free again, still in its original place. `take` removes a job outright (it
//!   started through its own delegate_task, or was taken back).
//! - **worker_limits** (per project: workers at once, of them heavy) and **worker_heavy** (the workers the Lead marked
//!   heavy, the newest HEAVY_MAX): every window reads the same ones, and they survive a restart.
//! - **worker_queue_meta**: `imported_local` (the queue) and `imported_local_settings` (limits and heavy list), set the
//!   first time a window hands over what an older build kept in its own local storage, so each is imported once.
//! - Own tables, no numbered migration (like rooms and delegations), so an older build still opens the database.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::session_store::{now_millis, SessionStore};

pub const CHANGED: &str = "worker-queue-changed";
const ID_MAX: usize = 600;
/// A brief is up to 60 000 characters (agentAppTasks.ts); the rest of a job is small.
const JOB_MAX: usize = 200_000;
const QUEUE_MAX: i64 = 500;
/// How long a window has to start a job it claimed before another may.
pub const LEASE_MS: i64 = 2 * 60_000;
const HEAVY_MAX: i64 = 500;
const LIMIT_MAX: i64 = 30;

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
         );
         CREATE TABLE IF NOT EXISTS worker_limits (
            project TEXT PRIMARY KEY,
            workers INTEGER NOT NULL,
            heavy INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS worker_heavy (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            child TEXT NOT NULL UNIQUE
         );",
    )?;
    // The lease columns came after the table (H8c): add them to a database made before.
    let has_lease: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('worker_queue') WHERE name = 'claimed_until'")?
        .exists([])?;
    if !has_lease {
        conn.execute_batch(
            "ALTER TABLE worker_queue ADD COLUMN claimed_until INTEGER;
             ALTER TABLE worker_queue ADD COLUMN claimed_by TEXT;",
        )?;
    }
    Ok(())
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

/// Every waiting job, first asked first. One a window is starting right now carries `claimedUntil`.
pub fn list(conn: &Connection, now: i64) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare("SELECT job_json, claimed_until FROM worker_queue ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut jobs = Vec::new();
    for row in rows {
        let (text, claimed_until) = row.map_err(|e| e.to_string())?;
        if let Ok(mut job) = serde_json::from_str::<Value>(&text) {
            if let (Some(until), Some(object)) =
                (claimed_until.filter(|u| *u > now), job.as_object_mut())
            {
                object.insert("claimedUntil".into(), json!(until));
            }
            jobs.push(job);
        }
    }
    Ok(jobs)
}

/// A window is about to start this job: it holds it until `now + lease_ms`. True when this call got it (it is still
/// waiting, and nobody else holds an unexpired claim on it).
pub fn claim(
    conn: &Connection,
    id: &str,
    by: &str,
    now: i64,
    lease_ms: i64,
) -> Result<bool, String> {
    let claimed = conn
        .execute(
            "UPDATE worker_queue SET claimed_until = ?3, claimed_by = ?2
             WHERE id = ?1 AND (claimed_until IS NULL OR claimed_until <= ?4)",
            params![id, by, now + lease_ms, now],
        )
        .map_err(|e| e.to_string())?;
    Ok(claimed > 0)
}

/// The claimed job started: out of the queue. Only its claimant's finish counts.
pub fn finish(conn: &Connection, id: &str, by: &str) -> Result<bool, String> {
    let removed = conn
        .execute(
            "DELETE FROM worker_queue WHERE id = ?1 AND claimed_by = ?2",
            params![id, by],
        )
        .map_err(|e| e.to_string())?;
    Ok(removed > 0)
}

/// The app just started: no window can be mid-start, so every claim is free again, each job in its place.
pub fn release_all_claims(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "UPDATE worker_queue SET claimed_until = NULL, claimed_by = NULL WHERE claimed_until IS NOT NULL",
        [],
    )
    .map_err(|e| e.to_string())
}

// ---- limits and heavy workers ----------------------------------------------------------------------------------

fn clamp(n: i64) -> i64 {
    n.clamp(1, LIMIT_MAX)
}

/// Saves a project's limits (heavy never past workers) and returns them.
pub fn set_limits(
    conn: &Connection,
    project: &str,
    workers: i64,
    heavy: i64,
) -> Result<Value, String> {
    if project.trim().is_empty() || project.len() > ID_MAX {
        return Err("A project is needed".into());
    }
    let workers = clamp(workers);
    let heavy = clamp(heavy).min(workers);
    conn.execute(
        "INSERT INTO worker_limits (project, workers, heavy) VALUES (?1, ?2, ?3)
         ON CONFLICT(project) DO UPDATE SET workers = excluded.workers, heavy = excluded.heavy",
        params![project, workers, heavy],
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({ "workers": workers, "heavy": heavy }))
}

pub fn mark_heavy(conn: &Connection, child: &str) -> Result<bool, String> {
    if child.trim().is_empty() || child.len() > ID_MAX {
        return Err("A worker is needed".into());
    }
    let added = conn
        .execute(
            "INSERT OR IGNORE INTO worker_heavy (child) VALUES (?1)",
            params![child],
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM worker_heavy WHERE seq <= (SELECT MAX(seq) FROM worker_heavy) - ?1",
        params![HEAVY_MAX],
    )
    .map_err(|e| e.to_string())?;
    Ok(added > 0)
}

/// `{ limits: { <project>: { workers, heavy } }, heavy: [<child>...] }`.
pub fn settings(conn: &Connection) -> Result<Value, String> {
    let mut limits = serde_json::Map::new();
    let mut statement = conn
        .prepare("SELECT project, workers, heavy FROM worker_limits")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (project, workers, heavy) = row.map_err(|e| e.to_string())?;
        limits.insert(project, json!({ "workers": workers, "heavy": heavy }));
    }
    let mut statement = conn
        .prepare("SELECT child FROM worker_heavy ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let heavy = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(json!({ "limits": limits, "heavy": heavy }))
}

/// The limits and heavy list an older build kept in local storage, imported once. A project already set here keeps
/// its own. True when this call imported them.
pub fn import_local_settings(
    conn: &mut Connection,
    limits: &Value,
    heavy: &[String],
) -> Result<bool, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let done = tx
        .query_row(
            "SELECT 1 FROM worker_queue_meta WHERE key = 'imported_local_settings'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if done.is_some() {
        return Ok(false);
    }
    if let Some(projects) = limits.as_object() {
        for (project, value) in projects {
            let known: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM worker_limits WHERE project = ?1",
                    params![project],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let workers = value.get("workers").and_then(Value::as_i64);
            if known.is_some() || project.trim().is_empty() || project.len() > ID_MAX {
                continue;
            }
            if let Some(workers) = workers {
                let heavy = value.get("heavy").and_then(Value::as_i64).unwrap_or(2);
                set_limits(&tx, project, workers, heavy)?;
            }
        }
    }
    for child in heavy {
        let _ = mark_heavy(&tx, child);
    }
    tx.execute(
        "INSERT INTO worker_queue_meta (key, value) VALUES ('imported_local_settings', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
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

/// On launch: claims left by the last run are free again.
pub(crate) fn init(app: &AppHandle) {
    let store = app.state::<SessionStore>();
    let released = store.lock_conn().and_then(|conn| release_all_claims(&conn));
    if let Err(error) = released {
        eprintln!("Could not free the waiting workers' claims: {error}");
    }
}

#[tauri::command(async)]
pub fn worker_queue_list(store: State<'_, SessionStore>) -> Result<Vec<Value>, String> {
    list(&*store.lock_conn()?, now_millis())
}

#[tauri::command(async)]
pub fn worker_queue_claim(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    by: String,
) -> Result<bool, String> {
    let claimed = claim(&*store.lock_conn()?, &id, &by, now_millis(), LEASE_MS)?;
    if claimed {
        changed(&app);
    }
    Ok(claimed)
}

#[tauri::command(async)]
pub fn worker_queue_finish(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    by: String,
) -> Result<bool, String> {
    let removed = finish(&*store.lock_conn()?, &id, &by)?;
    if removed {
        changed(&app);
    }
    Ok(removed)
}

#[tauri::command(async)]
pub fn worker_settings(store: State<'_, SessionStore>) -> Result<Value, String> {
    settings(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn worker_limits_set(
    app: AppHandle,
    store: State<'_, SessionStore>,
    project: String,
    workers: i64,
    heavy: i64,
) -> Result<Value, String> {
    let saved = set_limits(&*store.lock_conn()?, &project, workers, heavy)?;
    changed(&app);
    Ok(saved)
}

#[tauri::command(async)]
pub fn worker_heavy_mark(
    app: AppHandle,
    store: State<'_, SessionStore>,
    child: String,
) -> Result<bool, String> {
    let added = mark_heavy(&*store.lock_conn()?, &child)?;
    if added {
        changed(&app);
    }
    Ok(added)
}

#[tauri::command(async)]
pub fn worker_settings_import_local(
    app: AppHandle,
    store: State<'_, SessionStore>,
    limits: Value,
    heavy: Vec<String>,
) -> Result<bool, String> {
    let imported = import_local_settings(&mut *store.lock_conn()?, &limits, &heavy)?;
    if imported {
        changed(&app);
    }
    Ok(imported)
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
        list(conn, 0)
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
        assert_eq!(list(&conn, 0).unwrap()[0]["input"]["brief"], "b");
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
    #[test]
    fn a_claim_is_a_lease_that_keeps_the_job_in_its_place() {
        let conn = conn();
        for (id, at) in [("q1", 1), ("q2", 2), ("q3", 3)] {
            add(&conn, &job(id, at)).unwrap();
        }
        assert!(claim(&conn, "q1", "window-a", 1_000, LEASE_MS).unwrap());
        // Another window can't claim it while the lease runs, and sees it is being started.
        assert!(!claim(&conn, "q1", "window-b", 1_000 + LEASE_MS - 1, LEASE_MS).unwrap());
        assert_eq!(
            list(&conn, 2_000).unwrap()[0]["claimedUntil"],
            1_000 + LEASE_MS
        );
        // The window died: once the lease runs out, the job is free again, still first.
        assert!(list(&conn, 1_000 + LEASE_MS).unwrap()[0]
            .get("claimedUntil")
            .is_none());
        assert!(claim(&conn, "q1", "window-b", 1_000 + LEASE_MS, LEASE_MS).unwrap());
        // Only the claimant's finish removes it.
        assert!(!finish(&conn, "q1", "window-a").unwrap());
        assert!(finish(&conn, "q1", "window-b").unwrap());
        assert_eq!(ids(&conn), ["q2", "q3"]);
    }

    #[test]
    fn a_launch_frees_every_claim_left_by_the_last_run() {
        let conn = conn();
        add(&conn, &job("q1", 1)).unwrap();
        add(&conn, &job("q2", 2)).unwrap();
        claim(&conn, "q1", "dead-window", 1_000, LEASE_MS).unwrap();
        assert_eq!(release_all_claims(&conn).unwrap(), 1);
        assert!(claim(&conn, "q1", "new-window", 1_001, LEASE_MS).unwrap());
        assert_eq!(ids(&conn), ["q1", "q2"]);
    }

    #[test]
    fn adds_the_lease_columns_to_a_queue_made_before_them() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE worker_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                owner_session TEXT NOT NULL, project TEXT NOT NULL, job_json TEXT NOT NULL);",
        )
        .unwrap();
        add(&conn, &job("old", 1)).unwrap();
        ensure_tables(&conn).unwrap();
        assert!(claim(&conn, "old", "w", 1, LEASE_MS).unwrap());
        assert_eq!(ids(&conn), ["old"]);
    }

    #[test]
    fn keeps_each_projects_limits_and_the_heavy_list() {
        let conn = conn();
        assert_eq!(
            settings(&conn).unwrap(),
            json!({ "limits": {}, "heavy": [] })
        );
        assert_eq!(
            set_limits(&conn, "hivra", 20, 4).unwrap(),
            json!({ "workers": 20, "heavy": 4 })
        );
        assert_eq!(
            set_limits(&conn, "vg-game", 99, 50).unwrap(),
            json!({ "workers": 30, "heavy": 30 })
        );
        assert_eq!(
            set_limits(&conn, "nibbii", 0, 3).unwrap(),
            json!({ "workers": 1, "heavy": 1 })
        );
        assert!(mark_heavy(&conn, "app-lead-r1").unwrap());
        assert!(!mark_heavy(&conn, "app-lead-r1").unwrap());
        let all = settings(&conn).unwrap();
        assert_eq!(all["limits"]["hivra"], json!({ "workers": 20, "heavy": 4 }));
        assert_eq!(all["heavy"], json!(["app-lead-r1"]));
    }

    #[test]
    fn keeps_only_the_newest_heavy_workers() {
        let conn = conn();
        for i in 0..(HEAVY_MAX + 5) {
            mark_heavy(&conn, &format!("w{i}")).unwrap();
        }
        let heavy = settings(&conn).unwrap()["heavy"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(heavy.len() as i64, HEAVY_MAX);
        assert_eq!(heavy[0], "w5");
    }

    #[test]
    fn imports_local_limits_and_heavy_list_once_without_overriding_what_is_set_here() {
        let mut conn = conn();
        set_limits(&conn, "hivra", 10, 2).unwrap();
        let local = json!({ "hivra": { "workers": 20, "heavy": 4 }, "vg-game": { "workers": 12, "heavy": 3 }, "bad": "x" });
        assert!(import_local_settings(&mut conn, &local, &["h1".into(), "h2".into()]).unwrap());
        let all = settings(&conn).unwrap();
        assert_eq!(all["limits"]["hivra"], json!({ "workers": 10, "heavy": 2 }));
        assert_eq!(
            all["limits"]["vg-game"],
            json!({ "workers": 12, "heavy": 3 })
        );
        assert!(all["limits"].get("bad").is_none());
        assert_eq!(all["heavy"], json!(["h1", "h2"]));
        assert!(
            !import_local_settings(&mut conn, &json!({ "nibbii": { "workers": 3 } }), &[]).unwrap()
        );
        assert!(settings(&conn).unwrap()["limits"].get("nibbii").is_none());
    }
}
