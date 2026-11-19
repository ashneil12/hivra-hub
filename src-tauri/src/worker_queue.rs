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
            heavy INTEGER NOT NULL,
            model TEXT,
            effort TEXT,
            cli TEXT
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
    // A project's own worker model came after the table (E7): add it to a database made before.
    let has_model: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('worker_limits') WHERE name = 'model'")?
        .exists([])?;
    if !has_model {
        conn.execute_batch(
            "ALTER TABLE worker_limits ADD COLUMN model TEXT;
             ALTER TABLE worker_limits ADD COLUMN effort TEXT;",
        )?;
    }
    // WP-89: the project's worker default can name a CLI. A row from before has none, and reads as Claude.
    let has_cli: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('worker_limits') WHERE name = 'cli'")?
        .exists([])?;
    if !has_cli {
        conn.execute_batch("ALTER TABLE worker_limits ADD COLUMN cli TEXT;")?;
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

/// A project's own worker model (E7, Ash's choice in the Workers dialog): the model and effort every worker in the
/// project runs on unless the task names its own. `None` clears it, and the project's workers go back to the usual
/// Sonnet (taskDifficulty.ts). Clearing a model clears its effort with it. The limits are left as they are.
fn usable_text(value: Option<String>, what: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let text = value.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.chars().count() > ID_MAX || text.contains(['\r', '\n']) {
        return Err(format!("That {what} isn't usable."));
    }
    Ok(Some(text.to_string()))
}

pub fn set_model(
    conn: &Connection,
    project: &str,
    model: Option<String>,
    effort: Option<String>,
    cli: Option<String>,
) -> Result<Value, String> {
    if project.trim().is_empty() || project.len() > ID_MAX {
        return Err("A project is needed".into());
    }
    let model = usable_text(model, "model id")?;
    // Clearing the model clears the effort and the CLI with it. No CLI stored means the old Claude-only row.
    let effort = model.as_ref().and(usable_text(effort, "effort")?);
    let cli = model.as_ref().and(usable_text(cli, "CLI")?);
    // A new row starts at the app's own defaults, the same as workerPool.ts (6 at once, 2 of them heavy).
    conn.execute(
        "INSERT INTO worker_limits (project, workers, heavy, model, effort, cli) VALUES (?1, 6, 2, ?2, ?3, ?4)
         ON CONFLICT(project) DO UPDATE SET model = excluded.model, effort = excluded.effort, cli = excluded.cli",
        params![project, model, effort, cli],
    )
    .map_err(|e| e.to_string())?;
    let mut saved = json!({ "model": model, "effort": effort });
    if let Some(cli) = &cli {
        saved["cli"] = json!(cli);
    }
    Ok(saved)
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

/// `{ limits: { <project>: { workers, heavy, model?, effort?, cli? } }, heavy: [<child>...], workerDefault? }`.
/// `cli` is present only when a model is set and a CLI was stored. `workerDefault` is present only when one is set.
/// An old row has neither, and reads as the Claude choice it always was.
pub fn settings(conn: &Connection) -> Result<Value, String> {
    let mut limits = serde_json::Map::new();
    let mut statement = conn
        .prepare("SELECT project, workers, heavy, model, effort, cli FROM worker_limits")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (project, workers, heavy, model, effort, cli) = row.map_err(|e| e.to_string())?;
        let mut saved = json!({ "workers": workers, "heavy": heavy });
        if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
            saved["model"] = json!(model);
            if let Some(effort) = effort.filter(|value| !value.trim().is_empty()) {
                saved["effort"] = json!(effort);
            }
            if let Some(cli) = cli.filter(|value| !value.trim().is_empty()) {
                saved["cli"] = json!(cli);
            }
        }
        limits.insert(project, saved);
    }
    let mut statement = conn
        .prepare("SELECT child FROM worker_heavy ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let heavy = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = json!({ "limits": limits, "heavy": heavy });
    if let Some(worker_default) = read_system_default(conn)? {
        out["workerDefault"] = worker_default;
    }
    // WP-161: absent when unset or still the defaults.
    if let Some(scale) = read_builder_scale(conn)? {
        out["builderScale"] = scale;
    }
    Ok(out)
}

const WORKER_DEFAULT_KEY: &str = "worker_default";

/// The app-wide worker default (WP-89). `None`, or an object whose fields are all blank, clears it.
/// A field that is empty, too long, or holds a line break is refused. Only the fields that were set are stored.
pub fn set_system_default(conn: &Connection, value: Option<&Value>) -> Result<Value, String> {
    let Some(value) = value else {
        conn.execute(
            "DELETE FROM worker_queue_meta WHERE key = ?1",
            params![WORKER_DEFAULT_KEY],
        )
        .map_err(|e| e.to_string())?;
        return Ok(Value::Null);
    };
    let Some(object) = value.as_object() else {
        return Err("A worker default is an object".into());
    };
    let mut saved = serde_json::Map::new();
    for key in ["cli", "model", "effort"] {
        let Some(field) = object.get(key) else {
            continue;
        };
        if field.is_null() {
            continue;
        }
        let Value::String(text) = field else {
            return Err(format!("That {key} isn't usable."));
        };
        if let Some(clean) = usable_text(Some(text.clone()), key)? {
            saved.insert(key.to_string(), json!(clean));
        }
    }
    if saved.is_empty() {
        conn.execute(
            "DELETE FROM worker_queue_meta WHERE key = ?1",
            params![WORKER_DEFAULT_KEY],
        )
        .map_err(|e| e.to_string())?;
        return Ok(Value::Null);
    }
    let text = Value::Object(saved.clone()).to_string();
    conn.execute(
        "INSERT INTO worker_queue_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![WORKER_DEFAULT_KEY, text],
    )
    .map_err(|e| e.to_string())?;
    Ok(Value::Object(saved))
}

/// A stored default that isn't the shape we wrote (or a field that isn't usable) is left out, not an error.
fn read_system_default(conn: &Connection) -> Result<Option<Value>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM worker_queue_meta WHERE key = ?1",
            params![WORKER_DEFAULT_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    let mut saved = serde_json::Map::new();
    for key in ["cli", "model", "effort"] {
        let Some(text) = object.get(key).and_then(Value::as_str) else {
            continue;
        };
        if let Ok(Some(clean)) = usable_text(Some(text.to_string()), key) {
            saved.insert(key.to_string(), json!(clean));
        }
    }
    if saved.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Object(saved)))
    }
}

const BUILDER_SCALE_KEY: &str = "builder_scale";

fn finite_f64(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

fn clean_gb(value: Option<&Value>) -> Value {
    let Some(n) = value.and_then(finite_f64) else {
        return Value::Null;
    };
    if n <= 0.0 || n > 1_000_000.0 {
        return Value::Null;
    }
    json!((n * 1000.0).round() / 1000.0)
}

/// The disk pause is on until a person turns it off: 30 GB free, a floor under which new builders wait.
const DEFAULT_FREE_DISK_GB: f64 = 30.0;
/// A stored scale from this version on says "disk pause off" with a null. One without it was written while the pause
/// was off until a person turned it on, so its null only meant "never set" and reads as the default.
const SCALE_VERSION: i64 = 2;

/// The disk floor of a stored or incoming scale. A usable number is kept. `current` says a null (or a blank, `false`
/// or 0) is a person's own "off"; an older row's null is not, so it takes the default. Missing or unusable is the
/// default, the safe way round.
fn clean_disk_gb(value: Option<&Value>, current: bool) -> Value {
    let default = json!(DEFAULT_FREE_DISK_GB);
    let Some(value) = value else {
        return default;
    };
    if current {
        match value {
            Value::Null | Value::Bool(false) => return Value::Null,
            Value::String(text) if text.is_empty() => return Value::Null,
            _ => {}
        }
    }
    match finite_f64(value) {
        Some(n) if n == 0.0 && current => Value::Null,
        Some(n) if n > 0.0 && n <= 1_000_000.0 => {
            let rounded = (n * 1000.0).round() / 1000.0;
            if rounded > 0.0 {
                json!(rounded)
            } else {
                default
            }
        }
        _ => default,
    }
}

/// A stored or incoming scale becomes the canonical object, or `None` when it is the defaults.
/// Not an object is an error (the setter refuses it). A bad field is dropped, not a failure.
fn clean_builder_scale(value: &Value) -> Result<Option<Value>, String> {
    let Some(object) = value.as_object() else {
        return Err("A builder scale is an object".into());
    };
    let max_builders = match object.get("maxBuilders").and_then(finite_f64) {
        Some(n) => (n.round() as i64).clamp(1, LIMIT_MAX),
        None => 6,
    };
    let load = match object.get("load") {
        None => json!("default"),
        Some(Value::String(text)) if text == "default" || text == "off" => json!(text),
        Some(Value::Object(row)) => match row.get("above").and_then(finite_f64) {
            Some(n) if n > 0.0 && n <= 10_000.0 => {
                json!({ "above": (n * 1000.0).round() / 1000.0 })
            }
            _ => json!("default"),
        },
        Some(Value::Bool(false)) => json!("off"),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(n) if n.is_finite() && n > 0.0 && n <= 10_000.0 => {
                json!({ "above": (n * 1000.0).round() / 1000.0 })
            }
            _ => json!("default"),
        },
        _ => json!("default"),
    };
    let current = object
        .get("version")
        .and_then(finite_f64)
        .is_some_and(|n| n >= SCALE_VERSION as f64);
    let saved = json!({
        "version": SCALE_VERSION,
        "maxBuilders": max_builders,
        "load": load,
        "pauseFreeMemoryGb": clean_gb(object.get("pauseFreeMemoryGb")),
        "pauseFreeDiskGb": clean_disk_gb(object.get("pauseFreeDiskGb"), current),
    });
    let is_default = saved["maxBuilders"] == json!(6)
        && saved["load"] == json!("default")
        && saved["pauseFreeMemoryGb"].is_null()
        && saved["pauseFreeDiskGb"].as_f64() == Some(DEFAULT_FREE_DISK_GB);
    if is_default {
        Ok(None)
    } else {
        Ok(Some(saved))
    }
}

fn delete_builder_scale(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM worker_queue_meta WHERE key = ?1",
        params![BUILDER_SCALE_KEY],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// WP-161. `None` or a default object clears the row. The saved value never names a builder to stop.
pub fn set_builder_scale(conn: &Connection, value: Option<&Value>) -> Result<Value, String> {
    let Some(value) = value.filter(|item| !item.is_null()) else {
        delete_builder_scale(conn)?;
        return Ok(Value::Null);
    };
    let Some(saved) = clean_builder_scale(value)? else {
        delete_builder_scale(conn)?;
        return Ok(Value::Null);
    };
    let text = saved.to_string();
    conn.execute(
        "INSERT INTO worker_queue_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![BUILDER_SCALE_KEY, text],
    )
    .map_err(|e| e.to_string())?;
    Ok(saved)
}

/// A row that is not the shape we wrote is left out, not an error.
fn read_builder_scale(conn: &Connection) -> Result<Option<Value>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM worker_queue_meta WHERE key = ?1",
            params![BUILDER_SCALE_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    match clean_builder_scale(&value) {
        Ok(scale) => Ok(scale),
        Err(_) => Ok(None),
    }
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

/// SC-19: the jobs a retired chat left waiting now wait for the chat that takes its place. The `owner_session` column and
/// the job's own `ownerSession` change together, in the caller's transaction, and only while the owner still is `from`
/// (compare-and-swap), so a job is never moved twice or taken from a chat that already moved it. Place, claim and lease
/// stay as they were. A job whose stored JSON can't be read (it was never startable) is left alone. Returns each moved
/// job's id and title, in the order they were asked.
pub(crate) fn move_owner(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<Vec<(String, Option<String>)>, String> {
    let waiting = conn
        .prepare("SELECT id, job_json FROM worker_queue WHERE owner_session = ?1 ORDER BY seq")
        .map_err(|e| e.to_string())?
        .query_map(params![from], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut moved = Vec::new();
    for (id, text) in waiting {
        let Ok(mut job) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(object) = job.as_object_mut() else {
            continue;
        };
        let title = object
            .get("title")
            .and_then(Value::as_str)
            .map(|t| t.chars().take(300).collect::<String>())
            .filter(|t| !t.trim().is_empty());
        object.insert("ownerSession".into(), json!(to));
        let swapped = conn
            .execute(
                "UPDATE worker_queue SET owner_session = ?3, job_json = ?4 WHERE id = ?1 AND owner_session = ?2",
                params![id, from, to, job.to_string()],
            )
            .map_err(|e| e.to_string())?;
        if swapped > 0 {
            moved.push((id, title));
        }
    }
    Ok(moved)
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
pub fn worker_model_set(
    app: AppHandle,
    store: State<'_, SessionStore>,
    project: String,
    model: Option<String>,
    effort: Option<String>,
    cli: Option<String>,
) -> Result<Value, String> {
    let saved = set_model(&*store.lock_conn()?, &project, model, effort, cli)?;
    changed(&app);
    Ok(saved)
}

/// WP-161: the shared builder ceiling and the optional pauses. `None` clears them.
#[tauri::command(async)]
pub fn builder_scale_set(
    app: AppHandle,
    store: State<'_, SessionStore>,
    value: Option<Value>,
) -> Result<Value, String> {
    let saved = set_builder_scale(&*store.lock_conn()?, value.as_ref())?;
    changed(&app);
    Ok(saved)
}

/// WP-89: the system-wide worker default. `None` clears it.
#[tauri::command(async)]
pub fn worker_default_set(
    app: AppHandle,
    store: State<'_, SessionStore>,
    value: Option<Value>,
) -> Result<Value, String> {
    let saved = set_system_default(&*store.lock_conn()?, value.as_ref())?;
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
    fn keeps_a_projects_own_worker_model_apart_from_its_limits() {
        let conn = conn();
        // Chosen before any limit was set: the row starts at the app's defaults.
        assert_eq!(
            set_model(
                &conn,
                "hivra",
                Some("claude:opus-5".into()),
                Some("high".into()),
                None,
            )
            .unwrap(),
            json!({ "model": "claude:opus-5", "effort": "high" })
        );
        assert_eq!(
            settings(&conn).unwrap()["limits"]["hivra"],
            json!({ "workers": 6, "heavy": 2, "model": "claude:opus-5", "effort": "high" })
        );
        // The numbers Ash set later leave the model alone; the model he picks leaves the numbers alone.
        set_limits(&conn, "hivra", 9, 3).unwrap();
        set_model(&conn, "hivra", Some("custom:deepseek".into()), None, None).unwrap();
        assert_eq!(
            settings(&conn).unwrap()["limits"]["hivra"],
            json!({ "workers": 9, "heavy": 3, "model": "custom:deepseek" })
        );
        // Back to the usual model: the field goes, and nothing else does.
        set_model(
            &conn,
            "hivra",
            None,
            Some("high".into()),
            Some("grok".into()),
        )
        .unwrap();
        assert_eq!(
            settings(&conn).unwrap()["limits"]["hivra"],
            json!({ "workers": 9, "heavy": 3 })
        );
    }

    #[test]
    fn adds_the_model_columns_to_limits_made_before_them() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE worker_limits (project TEXT PRIMARY KEY, workers INTEGER NOT NULL,
                heavy INTEGER NOT NULL);",
        )
        .unwrap();
        set_limits(&conn, "old", 4, 1).unwrap();
        ensure_tables(&conn).unwrap();
        set_model(&conn, "old", Some("claude:sonnet-5".into()), None, None).unwrap();
        assert_eq!(
            settings(&conn).unwrap()["limits"]["old"],
            json!({ "workers": 4, "heavy": 1, "model": "claude:sonnet-5" })
        );
    }

    #[test]
    fn a_project_cli_and_the_system_default_round_trip_and_an_old_row_has_no_cli() {
        let conn = conn();
        assert!(settings(&conn).unwrap().get("workerDefault").is_none());
        assert_eq!(
            set_model(
                &conn,
                "hivra",
                Some("  grok-4  ".into()),
                Some("high".into()),
                Some("grok".into()),
            )
            .unwrap(),
            json!({ "model": "grok-4", "effort": "high", "cli": "grok" })
        );
        assert_eq!(
            settings(&conn).unwrap()["limits"]["hivra"],
            json!({ "workers": 6, "heavy": 2, "model": "grok-4", "effort": "high", "cli": "grok" })
        );
        // No CLI stored: the old Claude-only row, with no cli key.
        set_model(
            &conn,
            "vg-game",
            Some("claude:opus-5".into()),
            Some("high".into()),
            None,
        )
        .unwrap();
        assert!(settings(&conn).unwrap()["limits"]["vg-game"]
            .get("cli")
            .is_none());
        // Clearing the model clears the CLI with it.
        set_model(&conn, "hivra", None, None, Some("grok".into())).unwrap();
        assert!(settings(&conn).unwrap()["limits"]["hivra"]
            .get("cli")
            .is_none());
        assert!(settings(&conn).unwrap()["limits"]["hivra"]
            .get("model")
            .is_none());

        let chosen = json!({ "cli": " cursor ", "model": "composer", "effort": "medium" });
        assert_eq!(
            set_system_default(&conn, Some(&chosen)).unwrap(),
            json!({ "cli": "cursor", "model": "composer", "effort": "medium" })
        );
        assert_eq!(
            settings(&conn).unwrap()["workerDefault"],
            json!({ "cli": "cursor", "model": "composer", "effort": "medium" })
        );
        // A blank object clears it, and the key goes.
        assert_eq!(
            set_system_default(&conn, Some(&json!({ "cli": "  " }))).unwrap(),
            Value::Null
        );
        assert!(settings(&conn).unwrap().get("workerDefault").is_none());
        // A line break or a value that isn't text is refused, and nothing is stored.
        assert!(set_system_default(&conn, Some(&json!({ "model": "bad\nid" }))).is_err());
        assert!(set_system_default(&conn, Some(&json!({ "effort": 4 }))).is_err());
        assert!(settings(&conn).unwrap().get("workerDefault").is_none());
        // What is already on disk and isn't ours is left out, not an error.
        conn.execute(
            "INSERT INTO worker_queue_meta (key, value) VALUES ('worker_default', 'not-json')",
            [],
        )
        .unwrap();
        assert!(settings(&conn).unwrap().get("workerDefault").is_none());
        conn.execute(
            "UPDATE worker_queue_meta SET value = ?1 WHERE key = 'worker_default'",
            params![format!(r#"{{"model":"{}"}}"#, "x".repeat(601))],
        )
        .unwrap();
        assert!(settings(&conn).unwrap().get("workerDefault").is_none());
    }

    #[test]
    fn adds_the_cli_column_to_a_limit_row_made_before_it() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE worker_limits (project TEXT PRIMARY KEY, workers INTEGER NOT NULL,
                heavy INTEGER NOT NULL, model TEXT, effort TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO worker_limits (project, workers, heavy, model, effort)
             VALUES ('old', 4, 1, 'claude:sonnet-5', 'medium')",
            [],
        )
        .unwrap();
        ensure_tables(&conn).unwrap();
        let row = settings(&conn).unwrap();
        assert_eq!(
            row["limits"]["old"],
            json!({ "workers": 4, "heavy": 1, "model": "claude:sonnet-5", "effort": "medium" })
        );
        assert!(row["limits"]["old"].get("cli").is_none());
        assert!(row.get("workerDefault").is_none());
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

    #[test]
    fn keeps_a_builder_scale_and_drops_a_bad_or_default_one() {
        let conn = conn();
        assert!(settings(&conn).unwrap().get("builderScale").is_none());
        assert_eq!(set_builder_scale(&conn, None).unwrap(), Value::Null);
        let saved = set_builder_scale(
            &conn,
            Some(&json!({
                "version": 2,
                "maxBuilders": 20,
                "load": "off",
                "pauseFreeMemoryGb": 4,
                "pauseFreeDiskGb": 0
            })),
        )
        .unwrap();
        assert_eq!(saved["maxBuilders"], json!(20));
        assert_eq!(saved["load"], json!("off"));
        assert_eq!(saved["pauseFreeMemoryGb"].as_f64(), Some(4.0));
        // A disk pause turned off is kept as off.
        assert!(saved["pauseFreeDiskGb"].is_null());
        assert_eq!(saved["version"], json!(2));
        assert!(!saved.to_string().contains("kill"));
        assert_eq!(
            settings(&conn).unwrap()["builderScale"]["maxBuilders"],
            json!(20)
        );
        // The defaults (disk below 30 GB on) are not stored, so an older reader still sees no key.
        assert_eq!(
            set_builder_scale(
                &conn,
                Some(&json!({
                    "version": 2,
                    "maxBuilders": 6,
                    "load": "default",
                    "pauseFreeMemoryGb": null,
                    "pauseFreeDiskGb": 30
                })),
            )
            .unwrap(),
            Value::Null
        );
        assert!(settings(&conn).unwrap().get("builderScale").is_none());
        conn.execute(
            "INSERT INTO worker_queue_meta (key, value) VALUES ('builder_scale', 'not-json')",
            [],
        )
        .unwrap();
        assert!(settings(&conn).unwrap().get("builderScale").is_none());
        conn.execute(
            "UPDATE worker_queue_meta SET value = ?1 WHERE key = 'builder_scale'",
            params![r#"{"maxBuilders":100,"load":"off","pauseFreeMemoryGb":"lots"}"#],
        )
        .unwrap();
        let row = settings(&conn).unwrap()["builderScale"].clone();
        assert_eq!(row["maxBuilders"], json!(30));
        assert_eq!(row["load"], json!("off"));
        assert!(row["pauseFreeMemoryGb"].is_null());
        // Not an object is refused, and the stored scale stays.
        assert!(set_builder_scale(&conn, Some(&json!("nope"))).is_err());
        assert_eq!(
            settings(&conn).unwrap()["builderScale"]["maxBuilders"],
            json!(30)
        );
        // A bare load number is an explicit threshold. An empty object is the defaults, so it clears.
        let above = set_builder_scale(&conn, Some(&json!({ "load": 2.5 }))).unwrap();
        assert_eq!(above["load"]["above"], json!(2.5));
        assert_eq!(
            set_builder_scale(&conn, Some(&json!({}))).unwrap(),
            Value::Null
        );
        assert!(settings(&conn).unwrap().get("builderScale").is_none());
    }

    #[test]
    fn the_disk_pause_is_on_by_default_and_an_old_row_adopts_that() {
        let conn = conn();
        // Nothing stored: the caller's default applies (30 GB), so no key.
        assert!(settings(&conn).unwrap().get("builderScale").is_none());

        // A row saved before the pause was on by default has no version, and its null only meant "never set".
        conn.execute(
            "INSERT INTO worker_queue_meta (key, value) VALUES ('builder_scale', ?1)",
            params![
                r#"{"maxBuilders":12,"load":"default","pauseFreeMemoryGb":null,"pauseFreeDiskGb":null}"#
            ],
        )
        .unwrap();
        let old = settings(&conn).unwrap()["builderScale"].clone();
        assert_eq!(old["maxBuilders"], json!(12));
        assert_eq!(old["pauseFreeDiskGb"].as_f64(), Some(30.0));
        assert_eq!(old["version"], json!(2));

        // An old row with a number a person chose keeps it.
        conn.execute(
            "UPDATE worker_queue_meta SET value = ?1 WHERE key = 'builder_scale'",
            params![
                r#"{"maxBuilders":12,"load":"default","pauseFreeMemoryGb":null,"pauseFreeDiskGb":5}"#
            ],
        )
        .unwrap();
        let chosen = settings(&conn).unwrap()["builderScale"].clone();
        assert_eq!(chosen["pauseFreeDiskGb"].as_f64(), Some(5.0));

        // A row saved by this version with a null means off, and stays off after a read.
        let off = set_builder_scale(
            &conn,
            Some(&json!({
                "version": 2,
                "maxBuilders": 6,
                "load": "default",
                "pauseFreeMemoryGb": null,
                "pauseFreeDiskGb": null
            })),
        )
        .unwrap();
        assert!(off["pauseFreeDiskGb"].is_null());
        let read = settings(&conn).unwrap()["builderScale"].clone();
        assert!(read["pauseFreeDiskGb"].is_null());
        assert_eq!(read["version"], json!(2));

        // This version's row with no disk field at all is the default, and a bad one falls back to it too.
        let missing = set_builder_scale(
            &conn,
            Some(&json!({ "version": 2, "maxBuilders": 8, "load": "default" })),
        )
        .unwrap();
        assert_eq!(missing["pauseFreeDiskGb"].as_f64(), Some(30.0));
        let bad = set_builder_scale(
            &conn,
            Some(&json!({ "version": 2, "maxBuilders": 8, "pauseFreeDiskGb": "lots" })),
        )
        .unwrap();
        assert_eq!(bad["pauseFreeDiskGb"].as_f64(), Some(30.0));
        let negative = set_builder_scale(
            &conn,
            Some(&json!({ "version": 2, "maxBuilders": 8, "pauseFreeDiskGb": -4 })),
        )
        .unwrap();
        assert_eq!(negative["pauseFreeDiskGb"].as_f64(), Some(30.0));
    }
}
