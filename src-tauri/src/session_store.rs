use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  model_settings TEXT NOT NULL DEFAULT '{}',
  runtime_mode TEXT NOT NULL,
  title TEXT NOT NULL,
  provider_session_id TEXT,
  blocks_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_cwd_updated_idx
  ON sessions (cwd, updated_at DESC);
"#;

/// The newest schema this build writes (`schema_migrations`). A database at a higher version was written by a newer
/// build: it is refused, never opened or migrated, because this build would misread it (docs/PHASE-1B-DEV-SETUP.md).
/// Raise it with every new numbered migration; `schema_version_matches_the_migrations` checks.
pub const SCHEMA_VERSION: i64 = 21;

/// A database newer than this build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewerSchema {
    pub found: i64,
    pub supported: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    Newer(NewerSchema),
    Other(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Newer(newer) => write!(
                f,
                "this database was written by a newer build (schema {}; this build knows up to {})",
                newer.found, newer.supported
            ),
            Self::Other(error) => f.write_str(error),
        }
    }
}

impl From<rusqlite::Error> for OpenError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Other(error.to_string())
    }
}

impl From<String> for OpenError {
    fn from(error: String) -> Self {
        Self::Other(error)
    }
}

/// The schema version a database was last migrated to: 0 for a new one.
pub(crate) fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
    let has_table: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |row| row.get(0),
    )?;
    if !has_table {
        return Ok(0);
    }
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )
}

/// The schema guard: the version found, or a refusal when it is newer than this build.
fn guard_schema(conn: &Connection) -> Result<i64, OpenError> {
    let found = schema_version(conn)?;
    if found > SCHEMA_VERSION {
        return Err(OpenError::Newer(NewerSchema {
            found,
            supported: SCHEMA_VERSION,
        }));
    }
    Ok(found)
}

pub struct SessionStore {
    conn: Mutex<Connection>,
    read_conn: Mutex<Option<Connection>>,
}

impl SessionStore {
    #[cfg(test)]
    pub fn open(path: PathBuf) -> Result<Self, String> {
        Self::open_guarded(path).map_err(|error| error.to_string())
    }

    /// Open, refuse a database from a newer build before touching it, then migrate.
    pub(crate) fn open_guarded(path: PathBuf) -> Result<Self, OpenError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(&path)?;
        guard_schema(&conn)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        migrate(&conn)?;
        crate::worktrees::reconcile_removals(&conn)?;
        let read_conn = Connection::open(&path).map_err(|e| e.to_string())?;
        read_conn
            .execute_batch("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;")
            .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            read_conn: Mutex::new(Some(read_conn)),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            read_conn: Mutex::new(None),
        })
    }

    pub(crate) fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "Session store is locked".into())
    }

    /// `None` when another caller already holds the store. Tests use it to prove a `gh`
    /// read does not keep the lock. The app itself only uses `lock_conn`.
    #[cfg(test)]
    pub(crate) fn try_lock_conn(
        &self,
    ) -> Result<Option<std::sync::MutexGuard<'_, Connection>>, String> {
        match self.conn.try_lock() {
            Ok(guard) => Ok(Some(guard)),
            Err(std::sync::TryLockError::WouldBlock) => Ok(None),
            Err(std::sync::TryLockError::Poisoned(_)) => Err("Session store is locked".into()),
        }
    }
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    init_with(
        || app.path().app_data_dir().map_err(|e| e.to_string()),
        |path| match SessionStore::open_guarded(path.clone()) {
            Ok(store) => Ok(store),
            // An alert and exit 65, not a crash: an older build must never open a newer database.
            Err(OpenError::Newer(newer)) => {
                crate::instance::refuse(&crate::instance::Refusal::NewerDatabase {
                    data_dir: path.parent().map(Path::to_path_buf).unwrap_or(path),
                    found: newer.found,
                    supported: newer.supported,
                })
            }
            Err(OpenError::Other(error)) => Err(error),
        },
        |store| {
            app.manage(store);
        },
    )
}

/// What `monocode healthcheck` found in its copy of the live database.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub schema_before: i64,
    pub schema_after: i64,
    pub build_schema: i64,
    pub sessions: i64,
    pub integrity: String,
}

/// Migrate-only, for `monocode healthcheck`: copy `live` to `copy` with VACUUM INTO (the live file is only opened
/// read-only), then run this build's migrations on the copy and check it. Nothing else of `open` runs: no worktree
/// reconcile, no second connection.
pub fn healthcheck(live: &Path, copy: &Path) -> Result<HealthReport, OpenError> {
    {
        let source = Connection::open_with_flags(
            live,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        source.busy_timeout(Duration::from_secs(5))?;
        source.execute("VACUUM INTO ?1", [copy.to_string_lossy()])?;
    }
    let conn = Connection::open(copy)?;
    let schema_before = guard_schema(&conn)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    migrate(&conn)?;
    Ok(HealthReport {
        schema_before,
        schema_after: schema_version(&conn)?,
        build_schema: SCHEMA_VERSION,
        sessions: conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?,
        integrity: conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?,
    })
}

// Keep the complete startup path here so the transcript-read test covers it.
fn init_with(
    data_dir: impl FnOnce() -> Result<PathBuf, String>,
    open: impl FnOnce(PathBuf) -> Result<SessionStore, String>,
    manage: impl FnOnce(SessionStore),
) -> Result<(), String> {
    let store = open(data_dir()?.join("monocode.db"))?;
    manage(store);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpsert {
    #[serde(default)]
    pub sidebar_hidden: bool,
    pub id: String,
    pub cwd: String,
    pub harness: String,
    pub model: String,
    pub model_settings: Value,
    pub runtime_mode: String,
    pub title: String,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub provider_account_id: Option<String>,
    pub blocks: Value,
    #[serde(default)]
    pub queued_messages: Vec<Value>,
    #[serde(default)]
    pub queue_status: Option<String>,
    /// Last context-window reading reported by the harness, if any.
    #[serde(default)]
    pub context_used: Option<i64>,
    #[serde(default)]
    pub context_window: Option<i64>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree_cwd: Option<String>,
    #[serde(default)]
    pub worktree_removed: bool,
    #[serde(default)]
    pub linked_work_item: Option<Value>,
    #[serde(default)]
    pub automation_id: Option<String>,
    /// Claude Code's /goal while it is still open (the webview's `SessionGoal`), kept so a restart can restore it.
    /// None clears it: a met or cleared goal never comes back.
    #[serde(default)]
    pub goal: Option<Value>,
    /// WP-111: memory does not read or write this chat. Omitted on old saves, which stay readable.
    #[serde(default, rename = "private")]
    pub private_chat: bool,
    /// WP-111: after privacy is switched off, this message and everything before it stay unread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_boundary_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[serde(default)]
    pub sidebar_hidden: bool,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestration_lead_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestration: Option<Value>,
    pub cwd: String,
    pub harness: String,
    pub model: String,
    pub runtime_mode: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_cwd: Option<String>,
    #[serde(default)]
    pub worktree_removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub draft: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_work_item: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    /// WP-111: memory leaves this chat alone. Absent on a chat saved before the flag existed.
    #[serde(default, rename = "private")]
    pub private_chat: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    #[serde(default)]
    pub sidebar_hidden: bool,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestration_lead_id: Option<String>,
    pub cwd: String,
    pub harness: String,
    pub model: String,
    pub model_settings: Value,
    pub runtime_mode: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_account_id: Option<String>,
    pub blocks: Value,
    #[serde(default)]
    pub queued_messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_used: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_cwd: Option<String>,
    #[serde(default)]
    pub worktree_removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_work_item: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    /// The open /goal stored with the chat (see `SessionUpsert::goal`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<Value>,
    /// Archived chats keep their waiting queue paused after a restart: nothing is delivered to them.
    #[serde(default)]
    pub archived: bool,
    /// WP-111: memory does not read or write this chat.
    #[serde(default, rename = "private")]
    pub private_chat: bool,
    /// WP-111: messages at or before this id stay unread after privacy is switched off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_boundary_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The longest stored goal (its condition is capped at 1,000 characters; the rest is a few counters).
const GOAL_JSON_MAX: usize = 4_096;

/// A goal worth storing: an object with a non-empty `objective`, small enough. Anything else stores nothing.
fn goal_json(goal: Option<&Value>) -> Option<String> {
    let goal = goal?;
    let objective = goal.get("objective")?.as_str()?;
    if objective.trim().is_empty() || !goal.is_object() {
        return None;
    }
    serde_json::to_string(goal)
        .ok()
        .filter(|json| json.len() <= GOAL_JSON_MAX)
}

/// A message id worth storing as a privacy boundary. Anything else stores nothing.
fn stored_boundary(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.len() > 80
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(value.to_string())
}

/// A bad boundary from disk stays unread. An empty one means the chat was never private.
pub(crate) fn boundary_for_read(value: Option<String>) -> Option<String> {
    let raw = value?;
    if raw.trim().is_empty() {
        return None;
    }
    stored_boundary(Some(&raw)).or(Some("private-boundary-unreadable".to_string()))
}

/// What a saved chat must look like. A blank folder is allowed: it is a chat that came in from an export with no folder
/// that is a project here (docs/PORTABLE.md), and it has to keep saving (title, pin, a new folder) until one is chosen.
/// Nothing runs in it: every launcher refuses a blank folder (`chat_folder.rs`).
fn check_upsert(session: &SessionUpsert) -> Result<(), String> {
    validate_id(&session.id, "session")?;
    if let Some(provider_session_id) = &session.provider_session_id {
        if !provider_session_id.is_empty() {
            validate_id(provider_session_id, "provider session")?;
        }
    }
    if let Some(provider_account_id) = &session.provider_account_id {
        if !provider_account_id.is_empty() {
            validate_id(provider_account_id, "provider account")?;
        }
    }
    if let Some(automation_id) = &session.automation_id {
        if !automation_id.is_empty() {
            validate_id(automation_id, "automation")?;
        }
    }
    if !session.model_settings.is_object() {
        return Err("modelSettings must be an object".into());
    }
    if !session.blocks.is_array() {
        return Err("blocks must be an array".into());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn session_upsert(
    store: State<'_, SessionStore>,
    session: SessionUpsert,
) -> Result<SessionSummary, String> {
    check_upsert(&session)?;
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    let summary = upsert_session(&conn, &session).map_err(|e| e.to_string())?;
    Ok(summary)
}

fn generated_image_paths(blocks: &Value) -> Vec<String> {
    blocks
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block.get("role").and_then(Value::as_str) == Some("image"))
        .filter_map(|block| {
            block
                .get("image")
                .and_then(|image| image.get("path"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

#[tauri::command(async)]
pub fn session_list_by_project(
    store: State<'_, SessionStore>,
    cwd: String,
) -> Result<Vec<SessionSummary>, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is required".into());
    }
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    list_by_project(&conn, &cwd).map_err(|e| e.to_string())
}

/// The chats that have no folder (an import cleared it, docs/PORTABLE.md), newest first: the sidebar's "Needs a folder"
/// group, so none of them is findable only through search.
#[tauri::command(async)]
pub fn session_list_folderless(
    store: State<'_, SessionStore>,
) -> Result<Vec<SessionSummary>, String> {
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    list_folderless(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn session_rebase_project(
    store: State<'_, SessionStore>,
    from_cwd: String,
    to_cwd: String,
) -> Result<(), String> {
    if from_cwd.trim().is_empty() || to_cwd.trim().is_empty() {
        return Err("project paths are required".into());
    }
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    rebase_project(&conn, &from_cwd, &to_cwd).map_err(|error| error.to_string())
}

fn rebase_project(conn: &Connection, from_cwd: &str, to_cwd: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET cwd = ?2 WHERE cwd = ?1",
        params![from_cwd, to_cwd],
    )?;
    Ok(())
}

#[tauri::command(async)]
pub fn session_list_linked(store: State<'_, SessionStore>) -> Result<Vec<SessionSummary>, String> {
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    list_linked(&conn).map_err(|e| e.to_string())
}

/// WP-108: every saved turn's metrics for the usage page, as a narrow projection.
///
/// Only the fields the history counts are read out of each transcript: the chat's engine, model and folder, and each
/// user turn's start time plus token and price counts. The prompt and reply text never leave this function. Rows with
/// nothing to count are dropped here so the webview does not carry a long list of empty turns, and a transcript that
/// cannot be read is skipped rather than failing the whole page.
#[derive(Debug, Clone, Serialize)]
pub struct UsageSessionRow {
    pub id: String,
    pub cwd: String,
    pub harness: String,
    pub model: String,
    pub blocks: Value,
}

#[tauri::command(async)]
pub fn session_usage_rows(
    store: State<'_, SessionStore>,
    since: i64,
) -> Result<Vec<UsageSessionRow>, String> {
    let read_conn = store
        .read_conn
        .lock()
        .map_err(|_| "Session read store is locked")?;
    if let Some(conn) = read_conn.as_ref() {
        usage_rows(conn, since)
    } else {
        let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
        usage_rows(&conn, since)
    }
}

/// The projection `session_usage_rows` runs. Split out so the test can run it on any connection.
fn usage_rows(conn: &Connection, since: i64) -> Result<Vec<UsageSessionRow>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, cwd, harness, model, blocks_json
             FROM sessions
             WHERE has_user_message = 1
               AND updated_at >= ?1
               AND id NOT IN (SELECT item_id FROM trash_items WHERE kind = 'chat')
             ORDER BY updated_at DESC, id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![since], |row| {
            let blocks_json: String = row.get(4)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                blocks_json,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let Ok((id, cwd, harness, model, blocks_json)) = row else {
            continue;
        };
        let Ok(mut blocks) = serde_json::from_str::<Value>(&blocks_json) else {
            continue;
        };
        // A first mate's transcript lives in mono_blocks and its blocks_json is `[]`.
        if crate::mono_transcript::is_indexed(conn, &id).unwrap_or(false) {
            if let Ok(user_blocks) = crate::mono_transcript::user_blocks(conn, &id) {
                blocks = Value::Array(user_blocks);
            }
        }
        let turns = usage_turns(&blocks);
        if turns.is_empty() {
            continue;
        }
        out.push(UsageSessionRow {
            id,
            cwd,
            harness,
            model,
            blocks: Value::Array(turns),
        });
    }
    Ok(out)
}

/// A finite, non-negative number. A string, a negative, or anything else is dropped, never copied through.
fn usage_number(value: &Value) -> Option<Value> {
    let number = value.as_f64()?;
    if number.is_finite() && number >= 0.0 {
        Some(value.clone())
    } else {
        None
    }
}

/// One user turn with a count to tally, reduced to the fields the page reads: no text, no tool output, no filename.
///
/// A time or a count that is not a number is left out, and the model record keeps only the engine and the model name.
/// Anything else on the block (a prompt, a reply, a note) stays in the database.
fn usage_turns(blocks: &Value) -> Vec<Value> {
    let Some(blocks) = blocks.as_array() else {
        return Vec::new();
    };
    let mut turns = Vec::new();
    for block in blocks {
        if block.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(metrics) = block.get("turnMetrics").and_then(Value::as_object) else {
            continue;
        };
        let mut kept = serde_json::Map::new();
        for (key, value) in metrics {
            if USAGE_METRIC_KEYS.contains(&key.as_str()) {
                if let Some(number) = usage_number(value) {
                    kept.insert(key.clone(), number);
                }
            }
        }
        if kept.is_empty() {
            continue;
        }
        let mut turn = serde_json::Map::new();
        if let Some(id) = block.get("id").and_then(Value::as_str) {
            if !id.is_empty() {
                turn.insert("id".into(), Value::String(id.to_string()));
            }
        }
        turn.insert("role".into(), Value::String("user".into()));
        for stamp in ["startedAt", "sentAt"] {
            if let Some(value) = block.get(stamp).and_then(usage_number) {
                turn.insert(stamp.into(), value);
            }
        }
        if let Some(model) = block.get("turnModel").and_then(Value::as_object) {
            let mut kept_model = serde_json::Map::new();
            for key in ["harness", "name"] {
                if let Some(value) = model.get(key).and_then(Value::as_str) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        kept_model.insert(key.into(), Value::String(trimmed.to_string()));
                    }
                }
            }
            if !kept_model.is_empty() {
                turn.insert("turnModel".into(), Value::Object(kept_model));
            }
        }
        turn.insert("turnMetrics".into(), Value::Object(kept));
        turns.push(Value::Object(turn));
    }
    turns
}

const USAGE_METRIC_KEYS: [&str; 5] = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costUsd",
];

#[tauri::command(async)]
pub fn session_get(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<Option<SessionRecord>, String> {
    validate_id(&session_id, "session")?;
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    let mut record = get_session(&conn, &session_id).map_err(|e| e.to_string())?;
    if let Some(record) = record.as_mut() {
        crate::tool_detail::omit_large_details(&mut record.blocks);
    }
    Ok(record)
}

/// WP-111: ids of chats memory must not read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateChatKey {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
}

#[tauri::command(async)]
pub fn session_private_keys(store: State<'_, SessionStore>) -> Result<Vec<PrivateChatKey>, String> {
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    list_private_keys(&conn).map_err(|error| error.to_string())
}

fn list_private_keys(conn: &Connection) -> rusqlite::Result<Vec<PrivateChatKey>> {
    let mut statement = conn.prepare(
        "SELECT id, provider_session_id FROM sessions WHERE private_chat != 0 OR (private_boundary_id IS NOT NULL AND private_boundary_id != '') ORDER BY id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        let provider: Option<String> = row.get(1)?;
        Ok(PrivateChatKey {
            id: row.get(0)?,
            provider_session_id: provider.filter(|value| !value.is_empty()),
        })
    })?;
    rows.collect()
}

/// Output the transcript omitted on load, fetched when its row is expanded.
#[tauri::command(async)]
pub fn session_tool_detail(
    store: State<'_, SessionStore>,
    session_id: String,
    block_id: String,
    step_id: Option<String>,
) -> Result<Option<String>, String> {
    validate_id(&session_id, "session")?;
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    crate::tool_detail::stored_detail(&conn, &session_id, &block_id, step_id.as_deref())
        .map_err(|e| e.to_string())
}

const MAX_SEARCH_SCAN: usize = 400;
const MAX_CONVERSATION_HITS: usize = 40;
const MAX_MESSAGE_HITS: usize = 40;
const SNIPPET_RADIUS: usize = 42;
const SEARCH_PROGRESS_INTERVAL: usize = 1_000;
const MAX_SEARCH_BUFFER_BYTES: usize = 8 * 1024 * 1024;
static SESSION_SEARCH_TOKENS: Mutex<Option<HashMap<String, Arc<AtomicU64>>>> = Mutex::new(None);

#[derive(Clone)]
struct SessionSearchToken {
    owner: String,
    counter: Arc<AtomicU64>,
    generation: u64,
}

impl SessionSearchToken {
    fn is_current(&self) -> bool {
        self.counter.load(Ordering::Acquire) == self.generation
    }
}

fn begin_session_search(owner: &str) -> Option<SessionSearchToken> {
    if owner.is_empty() {
        return None;
    }
    let mut tokens = SESSION_SEARCH_TOKENS.lock().ok()?;
    let tokens = tokens.get_or_insert_with(HashMap::new);
    let counter = tokens
        .entry(owner.to_string())
        .or_insert_with(|| Arc::new(AtomicU64::new(0)))
        .clone();
    let generation = counter.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
    Some(SessionSearchToken {
        owner: owner.to_string(),
        counter,
        generation,
    })
}

/// Release the entry a finished search was holding, on every exit path.
///
/// Every search runs under a fresh `searchOwner` (`SearchView` mints a UUID per
/// keystroke), so an entry left behind is never reused or overwritten — it just
/// accumulates for the life of the process. A plain call after the search would
/// not do: the search returns through `?` on any SQLite error, and `SearchView`
/// swallows the rejection, so the error path is the common case, not the rare
/// one. `Drop` covers the early return and the unwind both.
struct SessionSearchRelease(Option<SessionSearchToken>);

impl Drop for SessionSearchRelease {
    fn drop(&mut self) {
        end_session_search(self.0.as_ref());
    }
}

/// The generation check happens under the map lock, not before it.
///
/// `begin_session_search` bumps the counter while holding that same lock, so
/// checking `is_current` outside the critical section leaves a window: a newer
/// search can register in between, and since both tokens share one `Arc`, the
/// `ptr_eq` test cannot tell them apart. Removing the entry then would strip
/// the live search of its registration, leaving it running and impossible to
/// cancel. The superseded search must leave the newer counter alone, so the
/// whole decision has to be atomic with respect to registration.
fn end_session_search(token: Option<&SessionSearchToken>) {
    let Some(token) = token else {
        return;
    };
    let Ok(mut tokens) = SESSION_SEARCH_TOKENS.lock() else {
        return;
    };
    let ours = tokens
        .as_ref()
        .and_then(|tokens| tokens.get(&token.owner))
        .is_some_and(|registered| Arc::ptr_eq(registered, &token.counter) && token.is_current());
    if ours {
        if let Some(tokens) = tokens.as_mut() {
            tokens.remove(&token.owner);
        }
    }
}

#[cfg(test)]
fn session_search_token_registered(owner: &str) -> bool {
    SESSION_SEARCH_TOKENS
        .lock()
        .ok()
        .and_then(|tokens| tokens.as_ref().map(|tokens| tokens.contains_key(owner)))
        .unwrap_or(false)
}

fn cancel_owned_session_search(owner: &str) {
    if owner.is_empty() {
        return;
    }
    if let Ok(mut tokens) = SESSION_SEARCH_TOKENS.lock() {
        if let Some(counter) = tokens.as_mut().and_then(|tokens| tokens.remove(owner)) {
            counter.fetch_add(1, Ordering::AcqRel);
        }
    }
}

fn session_search_is_current(token: Option<&SessionSearchToken>) -> bool {
    token.is_none_or(SessionSearchToken::is_current)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchOptions {
    pub query: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub search_owner: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub kind: String,
    pub session_id: String,
    pub cwd: String,
    pub harness: String,
    pub title: String,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResult {
    pub hits: Vec<SessionSearchHit>,
    pub truncated: bool,
}

#[tauri::command(async)]
pub fn session_search(
    store: State<'_, SessionStore>,
    options: SessionSearchOptions,
) -> Result<SessionSearchResult, String> {
    search_store(&store, &options)
}

fn search_store(
    store: &SessionStore,
    options: &SessionSearchOptions,
) -> Result<SessionSearchResult, String> {
    let token = begin_session_search(&options.search_owner);
    let release = SessionSearchRelease(token.clone());
    let result = {
        let read_conn = store
            .read_conn
            .lock()
            .map_err(|_| "Session read store is locked")?;
        if let Some(conn) = read_conn.as_ref() {
            search_sessions_with_connection(conn, options, token.as_ref())?
        } else {
            let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
            search_sessions_with_connection(&conn, options, token.as_ref())?
        }
    };
    drop(release);
    if session_search_is_current(token.as_ref()) {
        Ok(result)
    } else {
        Ok(SessionSearchResult {
            hits: Vec::new(),
            truncated: false,
        })
    }
}

#[tauri::command(async)]
pub fn cancel_session_search(search_owner: String) {
    cancel_owned_session_search(&search_owner);
}

#[tauri::command(async)]
pub fn session_delete(
    app: AppHandle,
    store: State<'_, SessionStore>,
    live: State<'_, crate::live_turns::LiveTurns>,
    session_id: String,
    image_paths: Vec<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    // Images stay until the chat is purged or deleted forever. The argument stays so the
    // existing invoke keeps working.
    let _ = image_paths;
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    // WP-76: a chat a Mono just moved is already in the ledger. Say so, and don't refuse it
    // for a turn this window has already stopped.
    if crate::trash::is_trashed(&conn, "chat", &session_id).map_err(|error| error.to_string())? {
        return Ok(());
    }
    let Some(record) = get_session(&conn, &session_id).map_err(|error| error.to_string())? else {
        return Ok(());
    };
    // WP-76: the running check and the ledger insert hold the live-turn lock together.
    crate::trash::commit_if_idle(
        &conn,
        &live,
        &crate::trash::Item {
            kind: "chat".into(),
            id: session_id,
            title: record.title,
            parent_kind: Some("project".into()),
            parent_id: Some(record.cwd),
            payload: "{}".into(),
        },
        &[],
        now_millis(),
    )
    .map_err(|error| error.to_string())?;
    drop(conn);
    let _ = app.emit(crate::trash::CHANGED, ());
    Ok(())
}

#[cfg(test)]
thread_local! {
    static FAIL_IMAGE_FOR: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn fail_chat_image_read_for(id: Option<&str>) {
    FAIL_IMAGE_FOR.with(|cell| *cell.borrow_mut() = id.map(str::to_string));
}

/// Image paths a hard delete must know before it removes anything. A failed read is not "no images".
pub(crate) fn collect_chat_image_paths(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<String>, String> {
    #[cfg(test)]
    if FAIL_IMAGE_FOR.with(|cell| cell.borrow().as_deref() == Some(session_id)) {
        return Err(format!("image read failed for {session_id}"));
    }
    let mut image_paths = get_session(conn, session_id)
        .ok()
        .flatten()
        .map(|record| generated_image_paths(&record.blocks))
        .unwrap_or_default();
    image_paths.extend(
        crate::mono_transcript::generated_image_paths(conn, session_id)
            .map_err(|error| error.to_string())?,
    );
    Ok(image_paths)
}

/// Hard-delete a chat and its generated images. Only the daily purge calls this. Delete forever
/// preflights every chat, then deletes the ledger and the rows in one transaction.
pub(crate) fn purge_chat(
    app: &AppHandle,
    conn: &Connection,
    session_id: &str,
) -> Result<(), String> {
    purge_chat_with(conn, session_id, |paths| {
        crate::fs::delete_generated_images_sync(app, paths)
    })
}

fn purge_chat_with(
    conn: &Connection,
    session_id: &str,
    remove_images: impl FnOnce(&[String]) -> Result<crate::fs::GeneratedImageDeletion, String>,
) -> Result<(), String> {
    let image_paths = collect_chat_image_paths(conn, session_id)?;
    delete_session(conn, session_id).map_err(|error| error.to_string())?;
    if !image_paths.is_empty() {
        if let Err(error) = remove_images(&image_paths) {
            eprintln!("Generated image cleanup will need a retry: {error}");
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn session_set_archived(
    store: State<'_, SessionStore>,
    session_id: String,
    archived: bool,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    set_archived(&conn, &session_id, archived).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn session_set_pinned(
    store: State<'_, SessionStore>,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    set_pinned(&conn, &session_id, pinned).map_err(|e| e.to_string())
}

/// WP-111: only this write changes the private flag. A later transcript save must not clear it.
#[tauri::command(async)]
pub fn session_set_private(
    store: State<'_, SessionStore>,
    session_id: String,
    private_chat: bool,
    private_boundary_id: Option<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    set_private(
        &conn,
        &session_id,
        private_chat,
        private_boundary_id.as_deref(),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn set_private(
    conn: &Connection,
    session_id: &str,
    private_chat: bool,
    private_boundary_id: Option<&str>,
) -> rusqlite::Result<()> {
    let boundary = if private_chat {
        stored_boundary(private_boundary_id)
    } else {
        match private_boundary_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            None => None,
            Some(value) => stored_boundary(Some(value))
                .or_else(|| Some("private-boundary-unreadable".to_string())),
        }
    };
    conn.execute(
        "UPDATE sessions
         SET private_chat = ?2,
             private_boundary_id = CASE
               WHEN ?2 != 0 AND ?3 IS NULL THEN private_boundary_id
               ELSE ?3
             END
         WHERE id = ?1",
        params![session_id, i64::from(private_chat), boundary],
    )?;
    Ok(())
}

#[tauri::command(async)]
pub fn session_set_linked_work_item(
    store: State<'_, SessionStore>,
    session_id: String,
    linked_work_item: Option<Value>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    set_linked_work_item(&conn, &session_id, linked_work_item.as_ref()).map_err(|e| e.to_string())
}

/// Work a running turn left going in the background (a subagent, a backgrounded shell, a monitor), saved with its
/// in-flight row so a resume after a quit or crash can say what was cut, with the id to restart it by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutWork {
    /// subagent, shell, monitor or task.
    pub kind: String,
    pub label: String,
    pub id: String,
}

/// At most this many background entries are kept per row; the resume note shows fewer still.
pub const IN_FLIGHT_WORK_MAX: usize = 50;
const IN_FLIGHT_WORK_LABEL_MAX: usize = 400;
const IN_FLIGHT_WORK_ID_MAX: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InFlightSession {
    pub session_id: String,
    pub cwd: String,
    /// The turn's background work when it was last saved.
    #[serde(default)]
    pub background: Vec<CutWork>,
    /// How many times this turn has already been resumed by itself after a restart (none yet: 0). The app stops
    /// resuming at three, so a turn that keeps taking the app down ends in Needs you instead of a loop.
    #[serde(default)]
    pub resumes: u32,
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

/// Bounded and well-formed: unknown kinds become "task", blank entries go, labels and ids are clipped, and only the
/// first [`IN_FLIGHT_WORK_MAX`] entries stay.
fn sanitize_cut_work(work: &[CutWork]) -> Vec<CutWork> {
    work.iter()
        .filter(|entry| !entry.id.trim().is_empty() || !entry.label.trim().is_empty())
        .take(IN_FLIGHT_WORK_MAX)
        .map(|entry| CutWork {
            kind: match entry.kind.as_str() {
                "subagent" | "shell" | "monitor" | "task" => entry.kind.clone(),
                _ => "task".into(),
            },
            label: clip(
                &entry.label.split_whitespace().collect::<Vec<_>>().join(" "),
                IN_FLIGHT_WORK_LABEL_MAX,
            ),
            id: clip(entry.id.trim(), IN_FLIGHT_WORK_ID_MAX),
        })
        .collect()
}

#[tauri::command(async)]
pub fn session_set_in_flight(
    store: State<'_, SessionStore>,
    sessions: Vec<InFlightSession>,
) -> Result<(), String> {
    for session in &sessions {
        validate_id(&session.session_id, "session")?;
        if session.cwd.trim().is_empty() {
            return Err("cwd is required".into());
        }
    }
    let mut conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    replace_in_flight(&mut conn, &sessions).map_err(|e| e.to_string())
}

/// Drop one chat from the quit snapshot: a turn that stopped resuming (three restarts) must not be marked
/// interrupted again at the next boot.
#[tauri::command(async)]
pub fn session_drop_in_flight(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    drop_in_flight(&conn, &session_id).map_err(|e| e.to_string())
}

/// Read the quit snapshot without clearing it. Vite/dev reloads must not
/// consume the only copy.
#[tauri::command(async)]
pub fn session_list_in_flight(
    store: State<'_, SessionStore>,
) -> Result<Vec<InFlightSession>, String> {
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    list_in_flight(&conn).map_err(|e| e.to_string())
}

/// Read and clear the quit snapshot so a restored window cannot take it twice.
#[tauri::command(async)]
pub fn session_take_in_flight(
    store: State<'_, SessionStore>,
) -> Result<Vec<InFlightSession>, String> {
    let mut conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    take_in_flight(&mut conn).map_err(|e| e.to_string())
}

const WORKSPACE_SNAPSHOT_MAX_BYTES: usize = 2_000_000;

#[tauri::command(async)]
pub fn workspace_set_snapshot(
    store: State<'_, SessionStore>,
    snapshot: Value,
) -> Result<(), String> {
    if !snapshot.is_object() {
        return Err("workspace snapshot must be an object".into());
    }
    let json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    if json.len() > WORKSPACE_SNAPSHOT_MAX_BYTES {
        return Err("workspace snapshot is too large".into());
    }
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    set_workspace_snapshot(&conn, &json).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn workspace_get_snapshot(store: State<'_, SessionStore>) -> Result<Option<Value>, String> {
    let conn = store.conn.lock().map_err(|_| "Session store is locked")?;
    let json = get_workspace_snapshot(&conn).map_err(|e| e.to_string())?;
    match json {
        None => Ok(None),
        Some(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
    }
}

/// Add `column` to `table` when it is absent.
pub(crate) fn ensure_table_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> rusqlite::Result<()> {
    let present: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |row| row.get(0),
    )?;
    if present == 0 {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

/// Add a `sessions` column when it is absent, so a half-applied history cannot
/// leave the schema short of what the queries select.
fn ensure_session_column(conn: &Connection, column: &str, decl: &str) -> rusqlite::Result<()> {
    ensure_table_column(conn, "sessions", column, decl)
}

/// Add a `sessions` column when it is missing, tolerating the case where a
/// recorded migration version has no matching column.
fn ensure_column(conn: &Connection, name: &str, decl: &str) -> rusqlite::Result<()> {
    let present: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    if present > 0 {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE sessions ADD COLUMN {name} {decl}"),
        [],
    )?;
    Ok(())
}

/// The table of what an import's file named for a cleared folder, with every column. A table made by an earlier build
/// (before `blocked`, `project_id` or `rest` existed, or on the fly before it was a migration) gets the missing ones.
fn ensure_imported_chat_folders(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS imported_chat_folders (
           session_id TEXT PRIMARY KEY,
           cwd TEXT NOT NULL,
           worktree_cwd TEXT
         );",
    )?;
    for (column, definition) in [
        ("blocked", "INTEGER NOT NULL DEFAULT 0"),
        ("project_id", "TEXT"),
        ("rest", "TEXT"),
    ] {
        let present = conn
            .prepare("SELECT 1 FROM pragma_table_info('imported_chat_folders') WHERE name = ?1")?
            .exists([column])?;
        if !present {
            conn.execute_batch(&format!(
                "ALTER TABLE imported_chat_folders ADD COLUMN {column} {definition};"
            ))?;
        }
    }
    Ok(())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         )",
        [],
    )?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if current < 1 {
        conn.execute_batch(MIGRATION_V1)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 2 {
        conn.execute("ALTER TABLE sessions ADD COLUMN branch TEXT", [])?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 3 {
        conn.execute("ALTER TABLE sessions ADD COLUMN context_used INTEGER", [])?;
        conn.execute("ALTER TABLE sessions ADD COLUMN context_window INTEGER", [])?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 4 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS in_flight_sessions (
               session_id TEXT PRIMARY KEY,
               cwd TEXT NOT NULL,
               sort_index INTEGER NOT NULL
             );",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 5 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS workspace_snapshot (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               snapshot_json TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 6 {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 7 {
        conn.execute("ALTER TABLE sessions ADD COLUMN worktree_cwd TEXT", [])?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 8 {
        // `list_by_project` used to filter with
        // `blocks_json LIKE '%"role":"user"%'`, which reads and substring-scans
        // every transcript in the project on each switch. Materialize the
        // predicate so the covering index can answer it instead.
        ensure_column(conn, "has_user_message", "INTEGER NOT NULL DEFAULT 0")?;
        conn.execute(
            "UPDATE sessions SET has_user_message =
               CASE WHEN blocks_json != '[]' AND blocks_json LIKE '%\"role\":\"user\"%'
                    THEN 1 ELSE 0 END",
            [],
        )?;
        conn.execute_batch(
            "DROP INDEX IF EXISTS sessions_cwd_updated_idx;
             CREATE INDEX IF NOT EXISTS sessions_cwd_listed_idx
               ON sessions (cwd, has_user_message, updated_at DESC);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (8, ?1)",
            params![now_millis()],
        )?;
    }
    // A recorded version row can outlive the schema it describes when another
    // build reuses the same numbers, leaving columns that every listing query
    // (and the covering index below) depends on missing. Repair before use.
    for (column, decl) in [
        ("branch", "TEXT"),
        ("context_used", "INTEGER"),
        ("context_window", "INTEGER"),
        ("archived", "INTEGER NOT NULL DEFAULT 0"),
        ("worktree_cwd", "TEXT"),
        ("has_user_message", "INTEGER NOT NULL DEFAULT 0"),
        ("pinned", "INTEGER NOT NULL DEFAULT 0"),
        ("linked_work_item_json", "TEXT"),
        ("provider_account_id", "TEXT"),
        ("worktree_removed", "INTEGER NOT NULL DEFAULT 0"),
        ("is_draft", "INTEGER NOT NULL DEFAULT 0"),
        ("automation_id", "TEXT"),
        ("queued_messages_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("queue_status", "TEXT"),
        ("sidebar_hidden", "INTEGER NOT NULL DEFAULT 0"),
        // WP-111: old rows stay readable. The boundary is only set when privacy is switched off.
        ("private_chat", "INTEGER NOT NULL DEFAULT 0"),
        ("private_boundary_id", "TEXT"),
        // Added in place, not as a numbered migration, so an older build (a ship rollback) still opens this database.
        ("goal_json", "TEXT"),
    ] {
        ensure_session_column(conn, column, decl)?;
    }
    if current < 9 {
        // v8 stopped the blob scan but still cost a table seek per row, and
        // every summary column (`created_at`, `updated_at`, `branch`,
        // `archived`) is stored *after* `blocks_json` in the record — so
        // reaching them meant walking past a ~180 KB transcript's overflow
        // pages, 120 times over, on each project switch. Widening the index to
        // cover the whole projection keeps the query inside the index and off
        // the table entirely: measured 7.3 ms -> 0.24 ms for 120 sessions.
        // Version rows are not proof the columns landed: a DB can carry a
        // recorded version from another build without the ALTER that went with
        // it, and indexing a missing column aborts the whole migration.
        ensure_column(conn, "branch", "TEXT")?;
        ensure_column(conn, "archived", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(conn, "has_user_message", "INTEGER NOT NULL DEFAULT 0")?;
        conn.execute_batch(
            "DROP INDEX IF EXISTS sessions_cwd_listed_idx;
             CREATE INDEX IF NOT EXISTS sessions_cwd_cover_idx
               ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                            model, runtime_mode, title, provider_session_id,
                            created_at, branch, archived);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (9, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 10 {
        crate::notes::ensure_notes_table(conn)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (10, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 11 {
        // Pinning is a listing column, so it has to live in the covering
        // index with `archived`. Selecting it off the table would walk past
        // `blocks_json` on every project switch.
        ensure_column(conn, "pinned", "INTEGER NOT NULL DEFAULT 0")?;
        conn.execute_batch(
            "DROP INDEX IF EXISTS sessions_cwd_cover_idx;
             CREATE INDEX IF NOT EXISTS sessions_cwd_cover_idx
               ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                            model, runtime_mode, title, provider_session_id,
                            created_at, branch, archived, pinned);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (11, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 12 {
        // The sidebar renders this metadata for every row, so keep it in the
        // same covering index as the rest of the session-card projection.
        ensure_column(conn, "linked_work_item_json", "TEXT")?;
        conn.execute_batch(
            "DROP INDEX IF EXISTS sessions_cwd_cover_idx;
             CREATE INDEX IF NOT EXISTS sessions_cwd_cover_idx
               ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                            model, runtime_mode, title, provider_session_id,
                            created_at, branch, archived, pinned,
                            linked_work_item_json);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (12, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 13 {
        crate::notes::ensure_notes_table(conn)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (13, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 14 {
        ensure_session_column(conn, "provider_account_id", "TEXT")?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (14, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 15 {
        ensure_session_column(conn, "worktree_removed", "INTEGER NOT NULL DEFAULT 0")?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (15, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 16 {
        conn.execute_batch(
            "DROP INDEX IF EXISTS sessions_cwd_cover_idx;
             CREATE INDEX sessions_cwd_cover_idx
               ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                            model, runtime_mode, title, provider_session_id,
                            created_at, branch, archived, pinned,
                            linked_work_item_json, worktree_cwd, worktree_removed);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (16, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 17 {
        // Draft is rendered on every session card. Materialize it alongside
        // `has_user_message` so listing never has to read transcript blobs.
        ensure_session_column(conn, "is_draft", "INTEGER NOT NULL DEFAULT 0")?;
        conn.execute(
            "UPDATE sessions SET is_draft =
               CASE WHEN blocks_json LIKE '%\"role\":\"user\"%'
                          AND blocks_json LIKE '%\"draft\":true%'
                    THEN 1 ELSE 0 END",
            [],
        )?;
        conn.execute_batch(
            "DROP INDEX IF EXISTS sessions_cwd_cover_idx;
             CREATE INDEX sessions_cwd_cover_idx
               ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                            model, runtime_mode, title, provider_session_id,
                            created_at, branch, archived, pinned,
                            linked_work_item_json, worktree_cwd, worktree_removed,
                            is_draft);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (17, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 18 {
        // Sidebar cards show whether a session came from an automation.
        ensure_session_column(conn, "automation_id", "TEXT")?;
        conn.execute_batch(
            "DROP INDEX IF EXISTS sessions_cwd_cover_idx;
             CREATE INDEX sessions_cwd_cover_idx
               ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                            model, runtime_mode, title, provider_session_id,
                            created_at, branch, archived, pinned,
                            linked_work_item_json, worktree_cwd, worktree_removed,
                            is_draft, automation_id);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (18, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 19 {
        // Keep sidebar visibility in the projection without reading transcripts.
        conn.execute_batch(
            "DROP INDEX IF EXISTS sessions_cwd_cover_idx;
             CREATE INDEX sessions_cwd_cover_idx
               ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                            model, runtime_mode, title, provider_session_id,
                            created_at, branch, archived, pinned,
                            linked_work_item_json, worktree_cwd, worktree_removed,
                            is_draft, automation_id, sidebar_hidden);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (19, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 20 {
        // WP-111: the sidebar menu reads the private flag without opening the transcript.
        ensure_session_column(conn, "private_chat", "INTEGER NOT NULL DEFAULT 0")?;
        conn.execute_batch(
            "DROP INDEX IF EXISTS sessions_cwd_cover_idx;
             CREATE INDEX sessions_cwd_cover_idx
               ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                            model, runtime_mode, title, provider_session_id,
                            created_at, branch, archived, pinned,
                            linked_work_item_json, worktree_cwd, worktree_removed,
                            is_draft, automation_id, sidebar_hidden, private_chat);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (20, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 21 {
        // An imported chat whose folder was cleared keeps what its file named, as an inert note: the window offers it
        // back once it passes the import's checks (docs/PORTABLE.md). Nothing runs from this table. (Its columns are
        // kept whole by `ensure_imported_chat_folders` below, whichever build made the table first.)
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (21, ?1)",
            params![now_millis()],
        )?;
    }
    ensure_imported_chat_folders(conn)?;
    // Create even when a version row already exists (another build may have
    // used the same numbers, or a previous run recorded the version without
    // the table). Restore writes into these; missing tables look like a
    // blank homepage.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS in_flight_sessions (
           session_id TEXT PRIMARY KEY,
           cwd TEXT NOT NULL,
           sort_index INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workspace_snapshot (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           snapshot_json TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS worktree_removals (
           path TEXT PRIMARY KEY,
           sessions_json TEXT NOT NULL
         );",
    )?;
    // Restart-safe resume (Phase 1b WP5): what each cut turn left running and how often it has resumed itself.
    // Added in place, not as a numbered migration, so an older build (a ship rollback) still opens this database;
    // its own inserts name their columns and leave these at their defaults.
    ensure_table_column(conn, "in_flight_sessions", "background_json", "TEXT")?;
    ensure_table_column(
        conn,
        "in_flight_sessions",
        "resumes",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    // Compatibility only: earlier Inbox Ask builds saved temporary chats here.
    // Keep those records off normal surfaces without deleting their transcripts.
    ensure_session_column(conn, "inbox_ask", "TEXT")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS sessions_legacy_inbox
         ON sessions (id) WHERE inbox_ask IS NOT NULL;",
    )?;
    // Unscoped session search pins this index with `INDEXED BY`, and SQLite
    // rejects that statement outright when the index is missing instead of
    // falling back to another plan. The versioned blocks above are the normal
    // path, but a recorded version can outlive the schema it describes, so
    // restore the index here for the same reason the tables above are
    // restored: a missing index would fail every search without a `cwd`.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS sessions_cwd_cover_idx
           ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                        model, runtime_mode, title, provider_session_id,
                        created_at, branch, archived, pinned,
                        linked_work_item_json, worktree_cwd, worktree_removed,
                        is_draft, automation_id, sidebar_hidden, private_chat);",
    )?;
    crate::notes::ensure_notes_table(conn)?;
    crate::reminders::ensure_table(conn)?;
    crate::automations::ensure_tables(conn)?;
    ensure_orchestration_history(conn)?;
    crate::mono_transcript::ensure_tables(conn)?;
    crate::delegations::ensure_tables(conn)?;
    // WP-70
    crate::tasks::ensure_tables(conn)?;
    // WP-159: the programme board. An older build never reads this table.
    crate::programme::ensure_tables(conn)?;
    // WP-74: the task and doc search index, after both tables exist.
    crate::finder::ensure_index(conn)?;
    // Hivra WP-11: the first mate's wake queue and timers.
    crate::watcher::ensure_tables(conn)?;
    // Hivra WP-14: steering messages and decisions.
    crate::steering::ensure_tables(conn)?;
    crate::decisions::ensure_tables(conn)?;
    crate::autopilot::ensure_tables(conn)?;
    crate::pr_watch::ensure_tables(conn)?;
    crate::delivery::ensure_tables(conn)?; // Hivra WP-12
    crate::delivery_gate::ensure_tables(conn)?; // Hivra WP-81
    crate::crew::ensure_tables(conn)?; // Hivra WP-13
    crate::spend_ledger::ensure_table(conn)?; // WP-176
    crate::rooms::ensure_tables(conn)?;
    crate::worker_queue::ensure_tables(conn)?;
    crate::ship::ensure_acceptance_table(conn)?;
    // WP-78: the activity log. In place, so an older build still opens this file.
    crate::activity::ensure_tables(conn)?;
    // WP-157: the work log. In place, so an older build still opens this file.
    crate::work_log::ensure_tables(conn)?;
    // WP-86: commit attribution. In place, so an older build still opens this file.
    crate::attribution::ensure_tables(conn)?;
    // WP-76: the trash ledger. Not a numbered migration: an older build simply never reads it.
    crate::trash::ensure_table(conn)?;
    Ok(())
}

fn ensure_orchestration_history(conn: &Connection) -> rusqlite::Result<()> {
    let indexed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'orchestration_sidebar')",
        [],
        |row| row.get(0),
    )?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS orchestration_runs (lead_id TEXT PRIMARY KEY, state TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS orchestration_sidebar (lead_id TEXT PRIMARY KEY, summary TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS orchestration_workers (session_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL);",
    )?;
    if !indexed {
        // One-time compatibility pass for the preview that listed workers as
        // separate chats. Normal sidebar reads never scan transcripts/run blobs.
        let runs = tx
            .prepare("SELECT lead_id, state FROM orchestration_runs")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (lead, state) in runs {
            if let Ok(run) = serde_json::from_str::<Value>(&state) {
                index_orchestration(&tx, &lead, &run)?;
            }
        }
        let workers = tx.prepare("SELECT id, blocks_json FROM sessions WHERE blocks_json LIKE '%orchestrationLeadId%'")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, blocks) in workers {
            if let Ok(blocks) = serde_json::from_str::<Value>(&blocks) {
                remember_worker_from_blocks(&tx, &id, &blocks)?;
            }
        }
    }
    tx.commit()
}

fn remember_worker(conn: &Connection, id: &str, lead: &str) -> rusqlite::Result<()> {
    if id != lead && validate_id(id, "Worker").is_ok() && validate_id(lead, "Lead").is_ok() {
        // Keep earlier workers indexed when a lead starts a subsequent run.
        conn.execute(
            "INSERT OR IGNORE INTO orchestration_workers(session_id, lead_id) VALUES (?1, ?2)",
            params![id, lead],
        )?;
    }
    Ok(())
}

fn remember_worker_from_blocks(
    conn: &Connection,
    id: &str,
    blocks: &Value,
) -> rusqlite::Result<()> {
    if let Some(blocks) = blocks.as_array() {
        for block in blocks {
            if block["role"] == "user" {
                if let Some(lead) = block["orchestrationLeadId"].as_str() {
                    remember_worker(conn, id, lead)?;
                    break;
                }
            }
        }
    }
    Ok(())
}

fn index_orchestration(conn: &Connection, lead: &str, run: &Value) -> rusqlite::Result<()> {
    let Some(tasks) = run["tasks"].as_array() else {
        return Ok(());
    };
    let mut summaries = Vec::new();
    for task in tasks {
        let Some(id) = task["sessionId"].as_str() else {
            continue;
        };
        remember_worker(conn, id, lead)?;
        summaries.push(serde_json::json!({
            "sessionId": id, "title": task["title"], "harness": task["harness"],
            "model": task["model"], "status": task["status"],
        }));
    }
    let summary = serde_json::json!({ "status": run["status"], "tasks": summaries });
    conn.execute("INSERT INTO orchestration_sidebar(lead_id, summary) VALUES (?1, ?2) ON CONFLICT(lead_id) DO UPDATE SET summary = excluded.summary", params![lead, summary.to_string()])?;
    Ok(())
}

pub(crate) fn save_orchestration(
    conn: &Connection,
    lead: &str,
    run: &Value,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("INSERT INTO orchestration_runs(lead_id, state) VALUES (?1, ?2) ON CONFLICT(lead_id) DO UPDATE SET state = excluded.state", params![lead, run.to_string()])?;
    index_orchestration(&tx, lead, run)?;
    tx.commit()
}

fn worker_parent(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT lead_id FROM orchestration_workers WHERE session_id = ?1",
        [id],
        |row| row.get(0),
    )
    .optional()
}

fn orchestration_summary(conn: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    Ok(optional_json(
        conn.query_row(
            "SELECT summary FROM orchestration_sidebar WHERE lead_id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?,
    ))
}

pub(crate) fn upsert_session(
    conn: &Connection,
    session: &SessionUpsert,
) -> rusqlite::Result<SessionSummary> {
    let now = now_millis();
    let model_settings = serde_json::to_string(&session.model_settings)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let existing: Option<(i64, i64, String, i64, i64, String)> = conn
        .query_row(
            "SELECT created_at, updated_at, blocks_json, archived, pinned, queued_messages_json FROM sessions WHERE id = ?1",
            params![session.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()?;
    let previous_blocks: Option<Value> = existing
        .as_ref()
        .and_then(|(_, _, raw, _, _, _)| serde_json::from_str(raw).ok());
    let blocks = crate::artifacts::retain_existing_cards(conn, &session.blocks)?;
    // Loaded transcripts omit large tool output; never let a save erase it.
    let blocks = match &previous_blocks {
        Some(previous) => match crate::tool_detail::restore_details(previous, &blocks) {
            Cow::Owned(restored) => Cow::Owned(restored),
            Cow::Borrowed(_) => blocks,
        },
        None => blocks,
    };
    let blocks_json = serde_json::to_string(blocks.as_ref())
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let queued_messages_json = serde_json::to_string(&session.queued_messages)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let linked_work_item_json = session
        .linked_work_item
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let automation_id = session
        .automation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let provider_session_id = session
        .provider_session_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let provider_account_id = session
        .provider_account_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let git = crate::fs::git_info_for(&crate::fs::expand_home(
        session
            .worktree_cwd
            .as_deref()
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or(&session.cwd),
    ));
    let branch = if session.worktree_removed {
        None
    } else {
        git.branch
            .as_deref()
            .filter(|value| !value.is_empty())
            .or_else(|| {
                session
                    .branch
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
    };
    let worktree_cwd = session
        .worktree_cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let has_user_message = has_user_block(&session.blocks);
    let is_draft = has_draft_block(&session.blocks);

    let created_at = existing
        .as_ref()
        .map(|(value, _, _, _, _, _)| *value)
        .unwrap_or(now);
    let updated_at = match &existing {
        Some((_, prev_updated, _, _, _, prev_queue))
            if previous_blocks.as_ref() == Some(blocks.as_ref())
                && prev_queue == &queued_messages_json =>
        {
            *prev_updated
        }
        _ => now,
    };
    let archived = existing
        .as_ref()
        .map(|(_, _, _, value, _, _)| *value != 0)
        .unwrap_or(false);
    let pinned = existing
        .as_ref()
        .map(|(_, _, _, _, value, _)| *value != 0)
        .unwrap_or(false);

    conn.execute(
        "INSERT INTO sessions (
           id, cwd, harness, model, model_settings, runtime_mode, title,
           provider_session_id, blocks_json, created_at, updated_at, branch,
           context_used, context_window, worktree_cwd, has_user_message,
           linked_work_item_json, provider_account_id, worktree_removed, is_draft,
           automation_id, queued_messages_json, queue_status, sidebar_hidden, goal_json,
           private_chat, private_boundary_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
           harness = excluded.harness,
           model = excluded.model,
           model_settings = excluded.model_settings,
           runtime_mode = excluded.runtime_mode,
           title = excluded.title,
           provider_session_id = excluded.provider_session_id,
           blocks_json = excluded.blocks_json,
           updated_at = excluded.updated_at,
           branch = excluded.branch,
           context_used = excluded.context_used,
           context_window = excluded.context_window,
           worktree_cwd = excluded.worktree_cwd,
           has_user_message = excluded.has_user_message,
           linked_work_item_json = excluded.linked_work_item_json,
           provider_account_id = excluded.provider_account_id,
           worktree_removed = excluded.worktree_removed,
           is_draft = excluded.is_draft,
           automation_id = excluded.automation_id,
           queued_messages_json = excluded.queued_messages_json,
           queue_status = excluded.queue_status,
           sidebar_hidden = excluded.sidebar_hidden,
           goal_json = excluded.goal_json",
        params![
            session.id,
            session.cwd,
            session.harness,
            session.model,
            model_settings,
            session.runtime_mode,
            session.title,
            provider_session_id,
            blocks_json,
            created_at,
            updated_at,
            branch,
            session.context_used,
            session.context_window,
            worktree_cwd,
            i64::from(has_user_message),
            linked_work_item_json,
            provider_account_id,
            i64::from(session.worktree_removed),
            i64::from(is_draft),
            automation_id,
            queued_messages_json,
            session.queue_status,
            i64::from(session.sidebar_hidden),
            goal_json(session.goal.as_ref()),
            i64::from(session.private_chat),
            stored_boundary(session.private_boundary_id.as_deref()),
        ],
    )?;

    remember_worker_from_blocks(conn, &session.id, &session.blocks)?;
    Ok(SessionSummary {
        sidebar_hidden: session.sidebar_hidden,
        private_chat: session.private_chat,
        id: session.id.clone(),
        orchestration_lead_id: worker_parent(conn, &session.id)?,
        orchestration: orchestration_summary(conn, &session.id)?,
        cwd: session.cwd.clone(),
        harness: session.harness.clone(),
        model: session.model.clone(),
        runtime_mode: session.runtime_mode.clone(),
        title: session.title.clone(),
        provider_session_id: provider_session_id.map(str::to_owned),
        branch: branch.map(str::to_owned),
        worktree_cwd: worktree_cwd.map(str::to_owned),
        worktree_removed: session.worktree_removed,
        repo: git.repo,
        additions: 0,
        deletions: 0,
        created_at,
        updated_at,
        archived,
        pinned,
        draft: is_draft,
        linked_work_item: session.linked_work_item.clone(),
        automation_id: automation_id.map(str::to_owned),
    })
}

struct SearchProgressGuard<'a>(&'a Connection);

impl Drop for SearchProgressGuard<'_> {
    fn drop(&mut self) {
        let _ = self.0.progress_handler(1, None::<fn() -> bool>);
    }
}

#[cfg(test)]
fn search_sessions(
    conn: &Connection,
    options: &SessionSearchOptions,
) -> Result<SessionSearchResult, String> {
    let token = begin_session_search(&options.search_owner);
    let _release = SessionSearchRelease(token.clone());
    search_sessions_with_connection(conn, options, token.as_ref())
}

fn search_sessions_sql(include_archived: bool, cwd_scoped: bool) -> String {
    let mut sql = String::from(
        "SELECT id, cwd, harness, title, updated_at, archived,
                CASE WHEN octet_length(blocks_json) <= ?2
                     THEN blocks_json ELSE NULL END
         FROM sessions",
    );
    if !cwd_scoped {
        // Without a `cwd` equality to anchor the leading index column, the
        // planner answers this from a table scan, and every column it reads
        // (`inbox_ask`, `archived`, `has_user_message`, `updated_at`) sits after
        // `blocks_json` in the record, so it walks each transcript's overflow
        // pages before the size guard can reject the row. The partial inbox
        // index answers the same filter without the table, and pinning the
        // covering index keeps the rest of the predicate and the projection
        // inside it: the table is then reached only for `blocks_json` rows that
        // are already known to fit the budget.
        sql.push_str(" INDEXED BY sessions_cwd_cover_idx");
    }
    sql.push_str(
        " WHERE id NOT IN (SELECT id FROM sessions WHERE inbox_ask IS NOT NULL)
            AND id NOT IN (SELECT item_id FROM trash_items WHERE kind = 'chat')
            AND has_user_message = 1
            AND (LOWER(title) LIKE LOWER(?1) ESCAPE '\\'
                 OR CASE WHEN octet_length(blocks_json) <= ?2
                         THEN LOWER(blocks_json) LIKE LOWER(?1) ESCAPE '\\'
                         ELSE 0 END
                 OR EXISTS(SELECT 1 FROM mono_blocks
                           WHERE mono_blocks.session_id = sessions.id
                             AND search_text LIKE LOWER(?1) ESCAPE '\\'))",
    );
    if !include_archived {
        sql.push_str(" AND archived = 0");
    }
    if cwd_scoped {
        sql.push_str(" AND cwd = ?3");
        sql.push_str(" ORDER BY updated_at DESC, id ASC LIMIT ?4");
    } else {
        sql.push_str(" ORDER BY updated_at DESC, id ASC LIMIT ?3");
    }
    sql
}

fn search_sessions_with_connection(
    conn: &Connection,
    options: &SessionSearchOptions,
    token: Option<&SessionSearchToken>,
) -> Result<SessionSearchResult, String> {
    let query = options.query.trim();
    if query.is_empty() {
        return Ok(SessionSearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let needle = query.to_lowercase();
    let pattern = like_pattern(query);
    let cwd = options
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let budget = MAX_SEARCH_BUFFER_BYTES as i64;
    let sql = search_sessions_sql(options.include_archived, cwd.is_some());

    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let limit = (MAX_SEARCH_SCAN as i64) + 1;
    let mut rows = if let Some(cwd) = cwd {
        statement
            .query(params![pattern, budget, cwd, limit])
            .map_err(|e| e.to_string())?
    } else {
        statement
            .query(params![pattern, budget, limit])
            .map_err(|e| e.to_string())?
    };

    let progress_token = token.cloned();
    conn.progress_handler(
        SEARCH_PROGRESS_INTERVAL as i32,
        Some(move || !session_search_is_current(progress_token.as_ref())),
    )
    .map_err(|e| e.to_string())?;
    let _progress_guard = SearchProgressGuard(conn);
    let mut conversations = Vec::new();
    let mut messages = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;
    loop {
        if !session_search_is_current(token) {
            return Ok(SessionSearchResult {
                hits: Vec::new(),
                truncated: false,
            });
        }
        let row = match rows.next() {
            Ok(None) => break,
            Ok(Some(row)) => row,
            Err(_) if !session_search_is_current(token) => {
                return Ok(SessionSearchResult {
                    hits: Vec::new(),
                    truncated: false,
                });
            }
            Err(error) => return Err(error.to_string()),
        };
        scanned += 1;
        if scanned > MAX_SEARCH_SCAN {
            truncated = true;
            break;
        }

        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let cwd: String = row.get(1).map_err(|e| e.to_string())?;
        let harness: String = row.get(2).map_err(|e| e.to_string())?;
        let title: String = row.get(3).map_err(|e| e.to_string())?;
        let updated_at: i64 = row.get(4).map_err(|e| e.to_string())?;
        let title_hit = title.to_lowercase().contains(&needle);
        if title_hit && conversations.len() < MAX_CONVERSATION_HITS {
            conversations.push(SessionSearchHit {
                kind: "conversation".into(),
                session_id: id.clone(),
                cwd: cwd.clone(),
                harness: harness.clone(),
                title: title.clone(),
                updated_at,
                block_id: None,
                role: None,
                preview: String::new(),
            });
        }

        if messages.len() >= MAX_MESSAGE_HITS {
            if title_hit {
                continue;
            }
            if conversations.len() >= MAX_CONVERSATION_HITS {
                truncated = true;
                break;
            }
            continue;
        }

        let blocks_raw = match row.get_ref(6).map_err(|e| e.to_string())? {
            rusqlite::types::ValueRef::Null => {
                truncated = true;
                continue;
            }
            value => {
                String::from_utf8_lossy(value.as_bytes().map_err(|e| e.to_string())?).into_owned()
            }
        };
        let blocks = if crate::mono_transcript::is_indexed(conn, &id).map_err(|e| e.to_string())? {
            crate::mono_transcript::matching_blocks(
                conn,
                &id,
                &needle,
                MAX_MESSAGE_HITS - messages.len(),
            )
            .map_err(|e| e.to_string())?
        } else {
            let Ok(blocks) = serde_json::from_str::<Value>(&blocks_raw) else {
                continue;
            };
            blocks
        };
        for hit in block_hits(&blocks, &needle) {
            messages.push(SessionSearchHit {
                kind: "message".into(),
                session_id: id.clone(),
                cwd: cwd.clone(),
                harness: harness.clone(),
                title: title.clone(),
                updated_at,
                block_id: Some(hit.0),
                role: Some(hit.1),
                preview: hit.2,
            });
            if messages.len() >= MAX_MESSAGE_HITS {
                truncated = true;
                break;
            }
        }
    }

    if conversations.len() >= MAX_CONVERSATION_HITS {
        truncated = true;
    }
    let mut hits = conversations;
    hits.extend(messages);
    Ok(SessionSearchResult { hits, truncated })
}

fn like_pattern(query: &str) -> String {
    let mut out = String::from("%");
    for ch in query.chars().take(200) {
        match ch {
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('%');
    out
}

fn block_hits(blocks: &Value, needle: &str) -> Vec<(String, String, String)> {
    let Some(items) = blocks.as_array() else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    for block in items {
        let role = block
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(
            role,
            "user" | "assistant" | "tool" | "tasks" | "plan" | "image"
        ) {
            continue;
        }
        let id = block
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            continue;
        }
        for text in block_texts(block) {
            if !text.to_lowercase().contains(needle) {
                continue;
            }
            hits.push((id.clone(), role.to_string(), snippet_around(&text, needle)));
            break;
        }
    }
    hits
}

fn block_texts(block: &Value) -> Vec<String> {
    let mut texts = Vec::new();
    push_text(&mut texts, block.get("text"));
    if let Some(image) = block.get("image") {
        push_text(&mut texts, image.get("name"));
        push_text(&mut texts, image.get("alt"));
    }
    if let Some(tool) = block.get("tool") {
        push_text(&mut texts, tool.get("title"));
        push_text(&mut texts, tool.get("detail"));
        if let Some(preview) = tool.get("preview") {
            push_text(&mut texts, preview.get("query"));
            push_text(&mut texts, preview.get("path"));
            push_text(&mut texts, preview.get("output"));
            push_text(&mut texts, preview.get("title"));
        }
    }
    texts
}

fn push_text(texts: &mut Vec<String>, value: Option<&Value>) {
    if let Some(text) = value.and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            texts.push(trimmed.to_string());
        }
    }
}

fn snippet_around(text: &str, needle: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = compact.to_lowercase();
    let Some(index) = lower.find(needle) else {
        if compact.chars().count() <= SNIPPET_RADIUS * 2 {
            return compact;
        }
        return format!(
            "{}…",
            compact.chars().take(SNIPPET_RADIUS * 2).collect::<String>()
        );
    };
    let start = floor_char_boundary(&compact, index.saturating_sub(SNIPPET_RADIUS));
    let end = ceil_char_boundary(
        &compact,
        (index + needle.len() + SNIPPET_RADIUS).min(compact.len()),
    );
    let mut snippet = compact[start..end].trim().to_string();
    if start > 0 {
        snippet = format!("…{snippet}");
    }
    if end < compact.len() {
        snippet = format!("{snippet}…");
    }
    snippet
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn list_by_project(conn: &Connection, cwd: &str) -> rusqlite::Result<Vec<SessionSummary>> {
    list_chats_in(conn, cwd, "AND has_user_message = 1")
}

/// Every chat that has no folder, with or without a message of its own: an imported chat that was only a draft or a
/// brief still has to be findable in "Needs a folder".
fn list_folderless(conn: &Connection) -> rusqlite::Result<Vec<SessionSummary>> {
    list_chats_in(conn, "", "")
}

fn list_chats_in(
    conn: &Connection,
    cwd: &str,
    message_filter: &str,
) -> rusqlite::Result<Vec<SessionSummary>> {
    let git = crate::fs::git_info_for(&crate::fs::expand_home(cwd));
    let mut statement = conn.prepare(&format!(
        "SELECT id, cwd, harness, model, runtime_mode, title, provider_session_id,
                created_at, updated_at, branch, archived, pinned,
                linked_work_item_json,
                (SELECT summary FROM orchestration_sidebar WHERE lead_id = sessions.id), worktree_cwd,
                worktree_removed, is_draft, automation_id, sidebar_hidden, private_chat
         FROM sessions
         WHERE cwd = ?1
           {message_filter}
           AND id NOT IN (SELECT id FROM sessions WHERE inbox_ask IS NOT NULL)
           AND id NOT IN (SELECT session_id FROM orchestration_workers)
           AND id NOT IN (SELECT item_id FROM trash_items WHERE kind = 'chat')
         ORDER BY updated_at DESC, id ASC"
    ))?;
    let rows = statement.query_map(params![cwd], |row| {
        let stored_branch: Option<String> = row.get(9)?;
        let archived: i64 = row.get(10)?;
        let pinned: i64 = row.get(11)?;
        let linked_work_item = optional_json(row.get(12)?);
        Ok(SessionSummary {
            sidebar_hidden: row.get::<_, i64>(18)? != 0,
            private_chat: row.get::<_, i64>(19)? != 0,
            id: row.get(0)?,
            orchestration_lead_id: None,
            orchestration: optional_json(row.get(13)?),
            cwd: row.get(1)?,
            harness: row.get(2)?,
            model: row.get(3)?,
            runtime_mode: row.get(4)?,
            title: row.get(5)?,
            provider_session_id: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            branch: if row.get::<_, i64>(15)? != 0 {
                None
            } else {
                nonempty(stored_branch).or_else(|| git.branch.clone())
            },
            worktree_cwd: row.get(14)?,
            worktree_removed: row.get::<_, i64>(15)? != 0,
            repo: git.repo.clone(),
            additions: 0,
            deletions: 0,
            archived: archived != 0,
            pinned: pinned != 0,
            draft: row.get::<_, i64>(16)? != 0,
            linked_work_item,
            automation_id: nonempty(row.get(17)?),
        })
    })?;
    rows.collect()
}

fn list_linked(conn: &Connection) -> rusqlite::Result<Vec<SessionSummary>> {
    let mut statement = conn.prepare(
        "SELECT id, cwd, harness, model, runtime_mode, title, provider_session_id,
                created_at, updated_at, branch, archived, pinned,
                linked_work_item_json,
                (SELECT summary FROM orchestration_sidebar WHERE lead_id = sessions.id), worktree_cwd,
                worktree_removed, is_draft, automation_id, sidebar_hidden, private_chat
         FROM sessions
         WHERE has_user_message = 1
           AND linked_work_item_json IS NOT NULL
           AND id NOT IN (SELECT id FROM sessions WHERE inbox_ask IS NOT NULL)
           AND id NOT IN (SELECT session_id FROM orchestration_workers)
           AND id NOT IN (SELECT item_id FROM trash_items WHERE kind = 'chat')
         ORDER BY updated_at DESC, id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        let archived: i64 = row.get(10)?;
        let pinned: i64 = row.get(11)?;
        Ok(SessionSummary {
            sidebar_hidden: row.get::<_, i64>(18)? != 0,
            private_chat: row.get::<_, i64>(19)? != 0,
            id: row.get(0)?,
            orchestration_lead_id: None,
            orchestration: optional_json(row.get(13)?),
            cwd: row.get(1)?,
            harness: row.get(2)?,
            model: row.get(3)?,
            runtime_mode: row.get(4)?,
            title: row.get(5)?,
            provider_session_id: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            branch: nonempty(row.get(9)?),
            worktree_cwd: row.get(14)?,
            worktree_removed: row.get::<_, i64>(15)? != 0,
            repo: None,
            additions: 0,
            deletions: 0,
            archived: archived != 0,
            pinned: pinned != 0,
            draft: row.get::<_, i64>(16)? != 0,
            linked_work_item: optional_json(row.get(12)?),
            automation_id: nonempty(row.get(17)?),
        })
    })?;
    rows.collect()
}

/// Mirrors the sidebar's notion of a listable session: a transcript that the
/// user has actually said something in.
fn has_user_block(blocks: &Value) -> bool {
    blocks.as_array().is_some_and(|blocks| {
        blocks
            .iter()
            .any(|block| block.get("role").and_then(Value::as_str) == Some("user"))
    })
}

fn has_draft_block(blocks: &Value) -> bool {
    blocks.as_array().is_some_and(|blocks| {
        blocks.iter().any(|block| {
            block.get("role").and_then(Value::as_str) == Some("user")
                && block.get("draft").and_then(Value::as_bool) == Some(true)
        })
    })
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn optional_json(raw: Option<String>) -> Option<Value> {
    raw.and_then(|value| serde_json::from_str(&value).ok())
}

pub(crate) fn delete_session(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        delete_session_in(&tx, session_id)?;
        return tx.commit();
    }
    conn.execute_batch("SAVEPOINT trash_delete_session")?;
    match delete_session_in(conn, session_id) {
        Ok(()) => conn.execute_batch("RELEASE trash_delete_session"),
        Err(error) => match conn.execute_batch("ROLLBACK TO trash_delete_session") {
            Ok(()) => {
                conn.execute_batch("RELEASE trash_delete_session")?;
                Err(error)
            }
            Err(rollback) => Err(rusqlite::Error::InvalidParameterName(format!(
                "{error}; rollback failed: {rollback}"
            ))),
        },
    }
}

fn delete_session_in(tx: &Connection, session_id: &str) -> rusqlite::Result<()> {
    let parent = worker_parent(tx, session_id)?;
    // Ownership is also carried in transcripts for older clients. Release
    // that metadata along with the index so reopening a worker stays detached.
    let workers = tx.prepare("SELECT id, blocks_json FROM sessions WHERE id IN (SELECT session_id FROM orchestration_workers WHERE lead_id = ?1)")?
        .query_map([session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, raw) in workers {
        let mut blocks: Value = serde_json::from_str(&raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
        if let Some(blocks) = blocks.as_array_mut() {
            for block in blocks {
                if block["orchestrationLeadId"] == session_id {
                    if let Some(block) = block.as_object_mut() {
                        block.remove("orchestrationLeadId");
                    }
                }
            }
        }
        tx.execute(
            "UPDATE sessions SET blocks_json = ?1 WHERE id = ?2",
            params![blocks.to_string(), id],
        )?;
    }
    tx.execute(
        "DELETE FROM orchestration_runs WHERE lead_id = ?1",
        [session_id],
    )?;
    tx.execute(
        "DELETE FROM orchestration_sidebar WHERE lead_id = ?1",
        [session_id],
    )?;
    // What an import's file named for this chat's folder goes with the chat.
    tx.execute(
        "DELETE FROM imported_chat_folders WHERE session_id = ?1",
        [session_id],
    )?;
    if let Some(parent) = parent.filter(|id| id != session_id) {
        let raw: Option<String> = tx
            .query_row(
                "SELECT state FROM orchestration_runs WHERE lead_id = ?1",
                [&parent],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(raw) = raw {
            let mut run: Value = serde_json::from_str(&raw).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            let mut removed = false;
            if let Some(tasks) = run["tasks"].as_array_mut() {
                let ids: Vec<String> = tasks
                    .iter()
                    .filter(|task| task["sessionId"] == session_id)
                    .filter_map(|task| task["id"].as_str().map(str::to_string))
                    .collect();
                let before = tasks.len();
                tasks.retain(|task| task["sessionId"] != session_id);
                removed = before != tasks.len();
                if removed {
                    for task in tasks {
                        if let Some(deps) = task["dependsOn"].as_array_mut() {
                            deps.retain(|dep| !ids.iter().any(|id| dep == id));
                        }
                        // Removing a prerequisite must not release queued work.
                        // The app stops the run before deleting any current member.
                        if matches!(
                            task["status"].as_str(),
                            Some("queued" | "running" | "cancelling")
                        ) {
                            task["status"] = json!("cancelled");
                            task["accepted"] = json!(false);
                            task["delivered"] = json!(true);
                        }
                    }
                }
            }
            if removed {
                if matches!(run["status"].as_str(), Some("active" | "paused")) {
                    run["status"] = json!("stopped");
                    run["error"] =
                        json!("A worker conversation was deleted. Start a new run to continue.");
                }
                run["requests"] = json!({});
                tx.execute(
                    "UPDATE orchestration_runs SET state = ?1 WHERE lead_id = ?2",
                    params![run.to_string(), parent],
                )?;
                index_orchestration(tx, &parent, &run)?;
            }
        }
        // Also handle summaries left by an older client without a run record.
        if let Some(mut summary) = orchestration_summary(tx, &parent)? {
            if let Some(tasks) = summary["tasks"].as_array_mut() {
                tasks.retain(|task| task["sessionId"] != session_id);
            }
            tx.execute(
                "UPDATE orchestration_sidebar SET summary = ?1 WHERE lead_id = ?2",
                params![summary.to_string(), parent],
            )?;
        }
    }
    tx.execute(
        "DELETE FROM orchestration_workers WHERE session_id = ?1 OR lead_id = ?1",
        [session_id],
    )?;
    tx.execute("DELETE FROM sessions WHERE id = ?1", [session_id])?;
    Ok(())
}

fn set_archived(conn: &Connection, session_id: &str, archived: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET archived = ?1 WHERE id = ?2",
        params![if archived { 1 } else { 0 }, session_id],
    )?;
    Ok(())
}

fn set_pinned(conn: &Connection, session_id: &str, pinned: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET pinned = ?1 WHERE id = ?2",
        params![if pinned { 1 } else { 0 }, session_id],
    )?;
    Ok(())
}

fn set_linked_work_item(
    conn: &Connection,
    session_id: &str,
    linked_work_item: Option<&Value>,
) -> rusqlite::Result<()> {
    let linked_work_item_json = linked_work_item
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    conn.execute(
        "UPDATE sessions SET linked_work_item_json = ?1 WHERE id = ?2",
        params![linked_work_item_json, session_id],
    )?;
    Ok(())
}

pub(crate) fn get_session(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<SessionRecord>> {
    get_session_record(conn, session_id, true)
}

pub(crate) fn get_session_metadata(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<SessionRecord>> {
    get_session_record(conn, session_id, false)
}

fn get_session_record(
    conn: &Connection,
    session_id: &str,
    with_blocks: bool,
) -> rusqlite::Result<Option<SessionRecord>> {
    let blocks = if with_blocks { "blocks_json" } else { "'[]'" };
    conn.query_row(
        &format!(
            "SELECT id, cwd, harness, model, model_settings, runtime_mode, title,
                provider_session_id, {blocks}, created_at, updated_at,
                context_used, context_window, branch, worktree_cwd,
                linked_work_item_json, provider_account_id, worktree_removed,
                automation_id, queued_messages_json, queue_status, sidebar_hidden,
                goal_json, archived, private_chat, private_boundary_id
         FROM sessions
         WHERE id = ?1 AND inbox_ask IS NULL
           AND id NOT IN (SELECT item_id FROM trash_items WHERE kind = 'chat')"
        ),
        params![session_id],
        |row| {
            let model_settings_raw: String = row.get(4)?;
            let blocks_raw: String = row.get(8)?;
            let model_settings = serde_json::from_str(&model_settings_raw).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    4,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            let blocks = serde_json::from_str(&blocks_raw).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            Ok(SessionRecord {
                sidebar_hidden: row.get::<_, i64>(21)? != 0,
                id: row.get(0)?,
                orchestration_lead_id: worker_parent(conn, session_id)?,
                cwd: row.get(1)?,
                harness: row.get(2)?,
                model: row.get(3)?,
                model_settings,
                runtime_mode: row.get(5)?,
                title: row.get(6)?,
                provider_session_id: row.get(7)?,
                blocks,
                queued_messages: serde_json::from_str(&row.get::<_, String>(19)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        19,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                queue_status: row.get(20)?,
                context_used: row.get(11)?,
                context_window: row.get(12)?,
                branch: row.get(13)?,
                worktree_cwd: row.get(14)?,
                worktree_removed: row.get::<_, i64>(17)? != 0,
                linked_work_item: optional_json(row.get(15)?),
                provider_account_id: row.get(16)?,
                automation_id: nonempty(row.get(18)?),
                goal: optional_json(row.get(22)?),
                archived: row.get::<_, i64>(23)? != 0,
                private_chat: row.get::<_, i64>(24)? != 0,
                private_boundary_id: boundary_for_read(row.get(25)?),
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        },
    )
    .optional()
}

const IN_FLIGHT_COLUMNS: &str = "session_id, cwd, background_json, resumes";

fn in_flight_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InFlightSession> {
    let background: Option<String> = row.get(2)?;
    let resumes: Option<i64> = row.get(3)?;
    Ok(InFlightSession {
        session_id: row.get(0)?,
        cwd: row.get(1)?,
        // A row an older build wrote, or one that no longer parses, simply has no background list.
        background: background
            .and_then(|json| serde_json::from_str::<Vec<CutWork>>(&json).ok())
            .map(|work| sanitize_cut_work(&work))
            .unwrap_or_default(),
        resumes: resumes.unwrap_or(0).clamp(0, u32::MAX as i64) as u32,
    })
}

fn list_in_flight(conn: &Connection) -> rusqlite::Result<Vec<InFlightSession>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {IN_FLIGHT_COLUMNS} FROM in_flight_sessions ORDER BY sort_index ASC, session_id ASC"
    ))?;
    let rows = statement.query_map([], in_flight_row)?;
    rows.collect()
}

fn replace_in_flight(conn: &mut Connection, sessions: &[InFlightSession]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM in_flight_sessions", [])?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO in_flight_sessions (session_id, cwd, sort_index, background_json, resumes)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for (index, session) in sessions.iter().enumerate() {
            let background = sanitize_cut_work(&session.background);
            let background = if background.is_empty() {
                None
            } else {
                serde_json::to_string(&background).ok()
            };
            insert.execute(params![
                session.session_id,
                session.cwd,
                index as i64,
                background,
                session.resumes as i64
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn drop_in_flight(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM in_flight_sessions WHERE session_id = ?1",
        params![session_id],
    )?;
    Ok(())
}

fn take_in_flight(conn: &mut Connection) -> rusqlite::Result<Vec<InFlightSession>> {
    let tx = conn.transaction()?;
    let sessions = {
        let mut statement = tx.prepare(&format!(
            "SELECT {IN_FLIGHT_COLUMNS} FROM in_flight_sessions ORDER BY sort_index ASC, session_id ASC"
        ))?;
        let rows = statement.query_map([], in_flight_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    tx.execute("DELETE FROM in_flight_sessions", [])?;
    tx.commit()?;
    Ok(sessions)
}

fn set_workspace_snapshot(conn: &Connection, json: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO workspace_snapshot (id, snapshot_json, updated_at)
         VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at",
        params![json, now_millis()],
    )?;
    Ok(())
}

fn get_workspace_snapshot(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT snapshot_json FROM workspace_snapshot WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .optional()
}

pub(crate) fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("Invalid {label} id"));
    }
    Ok(())
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::hooks::{AuthAction, Authorization};
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn search_keeps_older_mono_messages_available_after_conversion() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut mono = sample("mono", "/tmp/a", "Mono");
        mono.blocks = json!([{ "id":"old", "role":"user", "text":"Archived needle" }, { "id":"answer", "role":"assistant", "text":"Done" }]);
        upsert_session(&conn, &mono).unwrap();
        crate::mono_transcript::migrate_transcript(&conn, "mono").unwrap();
        let result = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "Archived needle".into(),
                cwd: None,
                include_archived: false,
                search_owner: "mono-search".into(),
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].block_id.as_deref(), Some("old"));
    }

    #[test]
    fn usage_rows_keep_only_counts_and_drop_prompt_text() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut session = sample("s1", "/tmp/project", "Secret plan");
        session.blocks = json!([
            {
                "id": "b1",
                "role": "user",
                "text": "my bank password is hunter2",
                "startedAt": 1_700_000_000_000_i64,
                "turnModel": { "harness": "claude", "name": "sonnet-5", "note": "note that must not travel" },
                "turnMetrics": { "inputTokens": 12, "outputTokens": 3, "costUsd": 0.02, "hidden": "no" },
                "toolUses": [{ "output": "ls output that must not travel" }]
            },
            { "id": "b2", "role": "assistant", "text": "the reply that must not travel" },
            { "id": "b3", "role": "user", "text": "no metrics here" },
            {
                "id": "b4",
                "role": "user",
                "startedAt": "time that must not travel",
                "turnMetrics": { "inputTokens": "count that must not travel", "outputTokens": 4, "costUsd": -3 }
            }
        ]);
        // The row's updated_at is the real time, which the window filter reads.
        upsert_session(&conn, &session).unwrap();

        let rows = usage_rows(&conn, 0).unwrap();
        assert_eq!(rows.len(), 1);
        let kept = serde_json::to_string(&rows[0].blocks).unwrap();
        assert!(!kept.contains("hunter2"));
        assert!(!kept.contains("must not travel"));
        assert!(!kept.contains("/tmp/project"));
        assert!(!kept.contains("hidden"));
        let blocks = rows[0].blocks.as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["id"], "b1");
        assert_eq!(blocks[0]["turnMetrics"]["inputTokens"], 12);
        assert_eq!(blocks[0]["turnModel"]["name"], "sonnet-5");
        assert!(blocks[0]["turnModel"].get("note").is_none());
        // A time or a count that is not a usable number is left out. The negative price is too.
        assert!(blocks[1].get("startedAt").is_none());
        assert!(blocks[1]["turnMetrics"].get("inputTokens").is_none());
        assert!(blocks[1]["turnMetrics"].get("costUsd").is_none());
        assert_eq!(blocks[1]["turnMetrics"]["outputTokens"], 4);
        // A user block with no metrics is dropped entirely, and the reply role never appears.
        assert!(blocks.iter().all(|block| block["role"] == "user"));
    }

    #[test]
    fn usage_rows_include_a_first_mate_whose_transcript_is_in_mono_blocks() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut mono = sample("mono", "/tmp/a", "Mono");
        mono.blocks = json!([
            {
                "id": "m1",
                "role": "user",
                "text": "mono prompt that must not travel",
                "turnMetrics": { "inputTokens": 7, "outputTokens": 2, "costUsd": 0.01 }
            },
            { "id": "m2", "role": "assistant", "text": "reply" }
        ]);
        upsert_session(&conn, &mono).unwrap();
        crate::mono_transcript::migrate_transcript(&conn, "mono").unwrap();
        let stored: String = conn
            .query_row(
                "SELECT blocks_json FROM sessions WHERE id = 'mono'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "[]");

        let rows = usage_rows(&conn, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "mono");
        let blocks = rows[0].blocks.as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["turnMetrics"]["inputTokens"], 7);
        assert!(!serde_json::to_string(&rows[0].blocks)
            .unwrap()
            .contains("must not travel"));
    }

    #[test]
    fn usage_rows_skip_a_trashed_chat() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut gone = sample("gone", "/tmp/secret", "Gone");
        gone.blocks = json!([{
            "id": "b1",
            "role": "user",
            "text": "trashed prompt",
            "startedAt": 1_i64,
            "turnMetrics": { "inputTokens": 9 }
        }]);
        upsert_session(&conn, &gone).unwrap();
        conn.execute(
            "INSERT INTO trash_items (
               kind, item_id, title, deleted_at, trashed_with_kind, trashed_with_id, version
             ) VALUES ('chat', 'gone', 'Gone', 1, 'chat', 'gone', 1)",
            [],
        )
        .unwrap();
        let mut kept = sample("kept", "/tmp/ok", "Kept");
        kept.blocks = json!([{
            "id": "b1",
            "role": "user",
            "startedAt": 1_i64,
            "turnMetrics": { "inputTokens": 2 }
        }]);
        upsert_session(&conn, &kept).unwrap();

        let rows = usage_rows(&conn, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "kept");
        let kept_json = serde_json::to_string(&rows).unwrap();
        assert!(!kept_json.contains("trashed prompt"));
    }

    #[test]
    fn usage_rows_respect_the_since_cutoff_and_skip_unreadable_transcripts() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut recent = sample("recent", "/tmp/a", "Recent");
        recent.blocks = json!([{ "id": "b1", "role": "user", "startedAt": 1_i64,
                                 "turnMetrics": { "inputTokens": 5 } }]);
        upsert_session(&conn, &recent).unwrap();
        let now = now_millis();
        // A transcript that is not valid JSON is skipped, not fatal. Its updated_at is inside the window, so the
        // cutoff is not what leaves it out.
        conn.execute(
            "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, blocks_json,
                                   created_at, updated_at, has_user_message)
             VALUES ('broken', '/tmp/b', 'claude', 'm', 'supervised', 'Broken', 'not json', ?1, ?1, 1)",
            [now],
        )
        .unwrap();

        let rows = usage_rows(&conn, now - 60_000).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "recent");
        // Older than the cutoff: left out.
        assert!(usage_rows(&conn, now + 60_000).unwrap().is_empty());
    }

    #[test]
    fn startup_does_not_read_saved_transcripts() {
        let data_dir = std::env::temp_dir().join(format!(
            "monocode-startup-transcripts-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = data_dir.join("monocode.db");
        {
            let store = SessionStore::open(path.clone()).unwrap();
            let conn = store.lock_conn().unwrap();
            conn.execute(
                "INSERT INTO sessions (
                   id, cwd, harness, model, runtime_mode, title,
                   blocks_json, created_at, updated_at
                 ) VALUES ('large', '/tmp', 'codex', 'test', 'supervised', 'Large', ?1, 1, 1)",
                ["x".repeat(8_000_000)],
            )
            .unwrap();
        }

        let transcript_reads = Arc::new(AtomicUsize::new(0));
        let reads = Arc::clone(&transcript_reads);
        let mut managed = None;
        init_with(
            || Ok(data_dir.clone()),
            |requested_path| {
                assert_eq!(requested_path, path);
                let store = SessionStore::open(requested_path)?;
                store
                    .lock_conn()?
                    .authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
                        if matches!(
                            context.action,
                            AuthAction::Read {
                                table_name: "sessions",
                                column_name: "blocks_json"
                            }
                        ) {
                            reads.fetch_add(1, Ordering::Relaxed);
                            Authorization::Deny
                        } else {
                            Authorization::Allow
                        }
                    }))
                    .map_err(|error| error.to_string())?;
                Ok(store)
            },
            |store| managed = Some(store),
        )
        .unwrap();
        assert_eq!(transcript_reads.load(Ordering::Relaxed), 0);
        drop(managed);
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn a_purge_with_one_outside_image_path_still_removes_the_chats_own_images() {
        let data =
            std::env::temp_dir().join(format!("hivra purge outside {}", uuid::Uuid::new_v4()));
        let images = data.join("generated-images");
        std::fs::create_dir_all(&images).unwrap();
        let outsider = data.join("outsider.png");
        std::fs::write(&outsider, "keep me").unwrap();
        let first = images.join("one.png");
        let second = images.join("two.png");
        std::fs::write(&first, "1").unwrap();
        std::fs::write(&second, "2").unwrap();

        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut chat = sample("chat-images", "/tmp/project", "Pictures");
        // The refused path is the chat's first image, so a delete that stops at it removes nothing.
        chat.blocks = json!([
            { "id": "i0", "role": "image", "image": { "path": outsider.to_string_lossy() } },
            { "id": "i1", "role": "image", "image": { "path": first.to_string_lossy() } },
            { "id": "i2", "role": "image", "image": { "path": second.to_string_lossy() } },
        ]);
        upsert_session(&conn, &chat).unwrap();

        let mut report = None;
        purge_chat_with(&conn, "chat-images", |paths| {
            let done = crate::fs::delete_generated_images_in(&images, paths)?;
            report = Some(done.skipped);
            Ok(done)
        })
        .unwrap();

        assert_eq!(report, Some(1));
        assert!(get_session(&conn, "chat-images").unwrap().is_none());
        assert!(!first.exists());
        assert!(!second.exists());
        assert_eq!(std::fs::read_to_string(&outsider).unwrap(), "keep me");
        let _ = std::fs::remove_dir_all(&data);
    }

    fn sample(id: &str, cwd: &str, title: &str) -> SessionUpsert {
        SessionUpsert {
            sidebar_hidden: false,
            id: id.into(),
            cwd: cwd.into(),
            harness: "cursor".into(),
            model: "gpt-5".into(),
            model_settings: json!({ "thinking": "high" }),
            runtime_mode: "supervised".into(),
            title: title.into(),
            provider_session_id: Some("acp-session-1".into()),
            provider_account_id: None,
            blocks: json!([{ "id": "b1", "role": "user", "text": "hello" }]),
            queued_messages: vec![],
            queue_status: None,
            context_used: None,
            context_window: None,
            branch: None,
            worktree_cwd: None,
            worktree_removed: false,
            linked_work_item: None,
            automation_id: None,
            goal: None,
            private_chat: false,
            private_boundary_id: None,
        }
    }

    #[test]
    fn an_open_goal_is_kept_with_its_chat_and_a_finished_one_is_cleared() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let goal = json!({ "objective": "the save test passes", "checks": 2, "status": "active", "setAt": 5,
                           "providerSessionId": "conv-1" });
        let mut session = SessionUpsert {
            goal: Some(goal.clone()),
            ..sample("worker", "/tmp/project", "Worker")
        };
        upsert_session(&conn, &session).unwrap();
        let stored = get_session(&conn, "worker").unwrap().unwrap();
        assert_eq!(stored.goal, Some(goal.clone()));
        assert!(!stored.archived);
        // The webview stops sending it once the goal is met or cleared: the row forgets it.
        session.goal = None;
        upsert_session(&conn, &session).unwrap();
        assert_eq!(get_session(&conn, "worker").unwrap().unwrap().goal, None);
        // Nothing malformed or oversized is stored.
        for bad in [
            json!({ "checks": 1, "status": "active" }),
            json!({ "objective": "   " }),
            json!("the save test passes"),
            json!({ "objective": "x".repeat(GOAL_JSON_MAX) }),
        ] {
            session.goal = Some(bad.clone());
            upsert_session(&conn, &session).unwrap();
            assert_eq!(
                get_session(&conn, "worker").unwrap().unwrap().goal,
                None,
                "{bad}"
            );
        }
        // An archived chat says so, so its waiting queue stays paused after a restart.
        set_archived(&conn, "worker", true).unwrap();
        assert!(get_session(&conn, "worker").unwrap().unwrap().archived);
        // The Mono metadata read (mono_session_get) carries the goal too.
        session.goal = Some(goal.clone());
        upsert_session(&conn, &session).unwrap();
        assert_eq!(
            get_session_metadata(&conn, "worker").unwrap().unwrap().goal,
            Some(goal)
        );
    }

    #[test]
    fn legacy_inbox_chats_are_not_normal_sessions() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        upsert_session(&conn, &sample("project", "/tmp/project", "Login")).unwrap();
        upsert_session(&conn, &sample("ask", "/tmp/project", "Login")).unwrap();
        conn.execute("UPDATE sessions SET inbox_ask = '{}' WHERE id = 'ask'", [])
            .unwrap();
        migrate(&conn).unwrap();
        let rows = list_by_project(&conn, "/tmp/project").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "project");
        assert!(get_session(&conn, "ask").unwrap().is_none());
        let search = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "Login".into(),
                cwd: None,
                include_archived: true,
                search_owner: String::new(),
            },
        )
        .unwrap();
        assert!(search.hits.iter().all(|hit| hit.session_id == "project"));
        // Hiding the old implementation's records does not delete their data.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn orchestration_history_groups_workers_and_keeps_their_transcripts() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        for id in ["lead", "worker-a", "worker-b", "unrelated"] {
            upsert_session(&conn, &sample(id, "/tmp/a", id)).unwrap();
        }
        let run = json!({"status": "active", "tasks": [
            {"sessionId": "worker-a", "title": "UI", "harness": "codex", "model": "one", "status": "running", "prompt": "private instructions", "result": "large result"},
            {"sessionId": "worker-b", "title": "Tests", "harness": "claude", "model": "two", "status": "queued"}
        ]});
        save_orchestration(&conn, "lead", &run).unwrap();
        // Reopening/migration must not hydrate, pause or otherwise mutate runs.
        migrate(&conn).unwrap();
        let rows = list_by_project(&conn, "/tmp/a").unwrap();
        assert_eq!(rows.len(), 2);
        let lead = rows.iter().find(|row| row.id == "lead").unwrap();
        let summary = lead.orchestration.as_ref().unwrap();
        assert_eq!(summary["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(summary["status"], "active");
        assert!(summary["tasks"][0].get("prompt").is_none());
        assert!(summary["tasks"][0].get("result").is_none());
        let worker = get_session(&conn, "worker-a").unwrap().unwrap();
        assert_eq!(worker.orchestration_lead_id.as_deref(), Some("lead"));
        assert!(has_user_block(&worker.blocks));
        // A later run replaces the card's agents without resurfacing old chats.
        save_orchestration(&conn, "lead", &json!({"status": "active", "tasks": []})).unwrap();
        assert_eq!(list_by_project(&conn, "/tmp/a").unwrap().len(), 2);
    }

    #[test]
    fn worker_upserts_carry_ownership_before_the_run_is_saved() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut worker = sample("worker", "/tmp/a", "Worker");
        worker.blocks =
            json!([{"id": "u", "role": "user", "text": "Task", "orchestrationLeadId": "lead"}]);
        worker.linked_work_item = Some(json!({"kind": "pr", "number": 1}));
        let summary = upsert_session(&conn, &worker).unwrap();
        assert_eq!(summary.orchestration_lead_id.as_deref(), Some("lead"));
        assert!(list_by_project(&conn, "/tmp/a").unwrap().is_empty());
        assert!(list_linked(&conn).unwrap().is_empty());
        // An older renderer's next write cannot accidentally detach a worker.
        worker.blocks = json!([{"id": "u", "role": "user", "text": "Task"}]);
        upsert_session(&conn, &worker).unwrap();
        assert!(list_by_project(&conn, "/tmp/a").unwrap().is_empty());
    }

    #[test]
    fn migration_groups_workers_from_the_earlier_preview() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        for id in ["lead", "old-worker", "current-worker"] {
            upsert_session(&conn, &sample(id, "/tmp/a", id)).unwrap();
        }
        conn.execute(
            "UPDATE sessions SET blocks_json = ?1 WHERE id = 'old-worker'",
            [
                json!([{"role": "user", "orchestrationLeadId": "lead", "text": "Old task"}])
                    .to_string(),
            ],
        )
        .unwrap();
        conn.execute("INSERT INTO orchestration_runs(lead_id, state) VALUES ('lead', ?1)", [json!({"status": "paused", "tasks": [{"sessionId": "current-worker", "title": "Task", "harness": "codex", "model": "one", "status": "completed"}]}).to_string()]).unwrap();
        conn.execute_batch("DROP TABLE orchestration_sidebar; DROP TABLE orchestration_workers;")
            .unwrap();
        migrate(&conn).unwrap();
        let rows = list_by_project(&conn, "/tmp/a").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "lead");
        assert_eq!(
            rows[0].orchestration.as_ref().unwrap()["tasks"][0]["title"],
            "Task"
        );
        assert_eq!(
            worker_parent(&conn, "old-worker").unwrap().as_deref(),
            Some("lead")
        );
        assert_eq!(
            worker_parent(&conn, "current-worker").unwrap().as_deref(),
            Some("lead")
        );
    }

    /// The sidebar query must stay answerable from the index alone. Selecting a
    /// column the index does not carry silently reintroduces a table seek per
    /// row, and every summary column sits behind a ~180 KB `blocks_json` blob
    /// in the record, so that regression is worth ~30x on a real project.
    #[test]
    fn list_by_project_is_served_by_a_covering_index() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "A1")).unwrap();
        for upgraded in [false, true] {
            if upgraded {
                // Exercise an existing v15 database with the old projection.
                conn.execute_batch(
                    "DROP INDEX sessions_cwd_cover_idx;
                     CREATE INDEX sessions_cwd_cover_idx
                       ON sessions (cwd, has_user_message, updated_at DESC, id, harness,
                                    model, runtime_mode, title, provider_session_id,
                                    created_at, branch, archived, pinned, linked_work_item_json);
                     DELETE FROM schema_migrations WHERE version IN (16, 17, 18, 19, 20, 21);",
                )
                .unwrap();
                migrate(&conn).unwrap();
            }
            let plan: String = conn
                .query_row(
                    "EXPLAIN QUERY PLAN
                 SELECT id, cwd, harness, model, runtime_mode, title, provider_session_id,
                        created_at, updated_at, branch, archived, pinned,
                        linked_work_item_json, worktree_cwd, worktree_removed, is_draft,
                        automation_id, sidebar_hidden, private_chat,
                        (SELECT summary FROM orchestration_sidebar WHERE lead_id = sessions.id)
                 FROM sessions
                 WHERE cwd = ?1
                   AND has_user_message = 1
                   AND id NOT IN (SELECT id FROM sessions WHERE inbox_ask IS NOT NULL)
                   AND id NOT IN (SELECT session_id FROM orchestration_workers)
                   AND id NOT IN (SELECT item_id FROM trash_items WHERE kind = 'chat')
                 ORDER BY updated_at DESC, id ASC",
                    params!["/tmp/a"],
                    |row| row.get(3),
                )
                .unwrap();
            assert!(
                plan.contains("COVERING INDEX"),
                "sidebar listing fell back to table seeks: {plan}"
            );
        }
    }

    #[test]
    fn upsert_tracks_whether_a_user_has_spoken() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut quiet = sample("s1", "/tmp/a", "Quiet");
        quiet.blocks = json!([{ "id": "b1", "role": "assistant", "text": "hi" }]);
        upsert_session(&conn, &quiet).unwrap();
        assert!(list_by_project(&conn, "/tmp/a").unwrap().is_empty());

        // The flag has to follow the transcript, not just the first write.
        quiet.blocks = json!([
            { "id": "b1", "role": "assistant", "text": "hi" },
            { "id": "b2", "role": "user", "text": "hello" }
        ]);
        upsert_session(&conn, &quiet).unwrap();
        assert_eq!(list_by_project(&conn, "/tmp/a").unwrap().len(), 1);
    }

    #[test]
    fn draft_marker_round_trips_through_session_summaries() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut session = sample("s1", "/tmp/a", "Draft");
        session.blocks = json!([
            { "id": "b1", "role": "user", "text": "start" },
            { "id": "b2", "role": "assistant", "text": "done" },
            { "id": "b3", "role": "user", "text": "hello", "draft": true }
        ]);

        let saved = upsert_session(&conn, &session).unwrap();
        assert!(saved.draft);
        assert!(list_by_project(&conn, "/tmp/a").unwrap()[0].draft);

        session.blocks = json!([
            { "id": "b1", "role": "user", "text": "start" },
            { "id": "b2", "role": "assistant", "text": "done" },
            { "id": "b3", "role": "user", "text": "hello" }
        ]);
        let sent = upsert_session(&conn, &session).unwrap();
        assert!(!sent.draft);
        assert!(!list_by_project(&conn, "/tmp/a").unwrap()[0].draft);
    }

    #[test]
    fn migrate_creates_sessions_table() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table, 1);
        let branch: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'branch'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(branch, 1);
    }

    fn temp_db_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-schema-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn schema_version_matches_the_migrations() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        assert_eq!(
            schema_version(&conn).unwrap(),
            SCHEMA_VERSION,
            "a new numbered migration must raise SCHEMA_VERSION, or the schema guard lets an older build open it"
        );
        let fresh = Connection::open_in_memory().unwrap();
        assert_eq!(schema_version(&fresh).unwrap(), 0);
    }

    #[test]
    fn the_schema_guard_refuses_a_database_from_a_newer_build_without_touching_it() {
        let dir = temp_db_dir("guard");
        let path = dir.join("monocode.db");
        drop(SessionStore::open(path.clone()).unwrap());
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 1)",
                params![SCHEMA_VERSION + 1],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
                 VALUES ('kept', '/tmp', 'claude', 'm', 'supervised', 'Kept', 1, 1)",
                [],
            )
            .unwrap();
        }
        let before = std::fs::read(&path).unwrap();
        match SessionStore::open_guarded(path.clone()) {
            Err(OpenError::Newer(newer)) => {
                assert_eq!(newer.found, SCHEMA_VERSION + 1);
                assert_eq!(newer.supported, SCHEMA_VERSION);
            }
            Err(other) => panic!("expected the schema guard, got {other}"),
            Ok(_) => panic!("a newer database must be refused"),
        }
        assert!(SessionStore::open(path.clone())
            .err()
            .unwrap()
            .contains("newer build"));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "a refused database is left as it was"
        );

        // The same version is this build's own: it opens.
        let same = dir.join("same.db");
        drop(SessionStore::open(same.clone()).unwrap());
        assert!(SessionStore::open(same).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn healthcheck_migrates_a_copy_and_never_writes_the_live_database() {
        let dir = temp_db_dir("health");
        let live = dir.join("monocode.db");
        {
            // An older database: only the first three migrations, one chat.
            let conn = Connection::open(&live).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
            )
            .unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN branch TEXT;
                 ALTER TABLE sessions ADD COLUMN context_used INTEGER;
                 ALTER TABLE sessions ADD COLUMN context_window INTEGER;
                 INSERT INTO schema_migrations VALUES (1, 1), (2, 1), (3, 1);
                 INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
                 VALUES ('old', '/tmp', 'claude', 'm', 'supervised', 'Old chat', 1, 1);",
            )
            .unwrap();
        }
        let before = std::fs::read(&live).unwrap();
        let copy = dir.join("copy.db");
        let report = healthcheck(&live, &copy).unwrap();
        assert_eq!(report.schema_before, 3);
        assert_eq!(report.schema_after, SCHEMA_VERSION);
        assert_eq!(report.build_schema, SCHEMA_VERSION);
        assert_eq!(report.sessions, 1);
        assert_eq!(report.integrity, "ok");
        assert_eq!(
            std::fs::read(&live).unwrap(),
            before,
            "the live database is only read"
        );
        let live_conn = Connection::open(&live).unwrap();
        assert_eq!(schema_version(&live_conn).unwrap(), 3);
        drop(live_conn);

        // A database from a newer build is refused, copy and all.
        {
            let conn = Connection::open(&live).unwrap();
            conn.execute(
                "INSERT INTO schema_migrations VALUES (?1, 1)",
                params![SCHEMA_VERSION + 5],
            )
            .unwrap();
        }
        let newer = healthcheck(&live, &dir.join("copy2.db")).unwrap_err();
        assert_eq!(
            newer,
            OpenError::Newer(NewerSchema {
                found: SCHEMA_VERSION + 5,
                supported: SCHEMA_VERSION
            })
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn upsert_preserves_created_at_and_updates_fields() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let first = upsert_session(&conn, &sample("s1", "/tmp/a", "First")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut next = sample("s1", "/tmp/a", "Updated");
        next.provider_session_id = Some("acp-session-2".into());
        next.blocks = json!([
            { "id": "b1", "role": "user", "text": "hello" },
            { "id": "b2", "role": "assistant", "text": "world" }
        ]);
        let second = upsert_session(&conn, &next).unwrap();
        assert_eq!(second.created_at, first.created_at);
        assert!(second.updated_at > first.updated_at);
        assert_eq!(second.title, "Updated");
        assert_eq!(second.provider_session_id.as_deref(), Some("acp-session-2"));
    }

    #[test]
    fn saving_a_loaded_transcript_keeps_its_omitted_tool_output() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let output = "line\n".repeat(1_000);
        let mut row = sample("s1", "/tmp/a", "First");
        row.blocks = json!([
            { "id": "u", "role": "user", "text": "run" },
            { "id": "t", "role": "tool", "text": "npm test",
              "tool": { "kind": "execute", "status": "completed", "detail": output } }
        ]);
        upsert_session(&conn, &row).unwrap();

        // What `session_get` hands the transcript.
        let mut loaded = get_session(&conn, "s1").unwrap().unwrap().blocks;
        crate::tool_detail::omit_large_details(&mut loaded);
        assert!(loaded[1]["tool"].get("detail").is_none());
        loaded
            .as_array_mut()
            .unwrap()
            .push(json!({ "id": "a", "role": "assistant", "text": "done" }));
        row.blocks = loaded;
        upsert_session(&conn, &row).unwrap();

        let stored = get_session(&conn, "s1").unwrap().unwrap().blocks;
        assert_eq!(stored[1]["tool"]["detail"], output);
        assert!(stored[1]["tool"].get("detailOmitted").is_none());
        assert_eq!(stored[2]["text"], "done");
        assert_eq!(
            crate::tool_detail::stored_detail(&conn, "s1", "t", None).unwrap(),
            Some(output)
        );
    }

    #[test]
    fn context_usage_round_trips() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut row = sample("s1", "/tmp/a", "First");
        row.context_used = Some(29_821);
        row.context_window = Some(1_000_000);
        upsert_session(&conn, &row).unwrap();
        let stored = get_session(&conn, "s1").unwrap().unwrap();
        assert_eq!(stored.context_used, Some(29_821));
        assert_eq!(stored.context_window, Some(1_000_000));
    }

    #[test]
    fn queued_messages_round_trip_and_clear_without_changing_the_transcript() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut row = sample("queued", "/tmp/a", "Conversation");
        row.queued_messages = vec![
            json!({"id":"first", "text":"One", "attachments":[]}),
            json!({"id":"second", "text":"", "attachments":[{"id":"image", "kind":"image", "data":"bytes"}], "error":"Offline"}),
        ];
        row.queue_status = Some("paused".into());
        upsert_session(&conn, &row).unwrap();
        let stored = get_session(&conn, "queued").unwrap().unwrap();
        assert_eq!(stored.queued_messages, row.queued_messages);
        assert_eq!(stored.queue_status.as_deref(), Some("paused"));
        assert_eq!(stored.blocks, row.blocks);

        row.queued_messages.clear();
        row.queue_status = None;
        upsert_session(&conn, &row).unwrap();
        let stored = get_session(&conn, "queued").unwrap().unwrap();
        assert!(stored.queued_messages.is_empty());
        assert_eq!(stored.queue_status, None);
        assert_eq!(stored.blocks, row.blocks);
    }

    #[test]
    fn sidebar_visibility_round_trips_without_hiding_session_access() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut row = sample("hidden", "/tmp/a", "Review");
        row.sidebar_hidden = true;
        row.linked_work_item = Some(json!({"kind": "pr", "repo": "a/b", "number": 1}));
        assert!(upsert_session(&conn, &row).unwrap().sidebar_hidden);
        assert!(list_by_project(&conn, &row.cwd).unwrap()[0].sidebar_hidden);
        assert!(list_linked(&conn).unwrap()[0].sidebar_hidden);
        let stored = get_session(&conn, &row.id).unwrap().unwrap();
        assert!(stored.sidebar_hidden);
        assert_eq!(stored.blocks, row.blocks);
        row.title = "Review complete".into();
        upsert_session(&conn, &row).unwrap();
        assert!(get_session(&conn, &row.id).unwrap().unwrap().sidebar_hidden);
    }

    #[test]
    fn sidebar_visibility_migration_keeps_existing_sessions_visible() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        upsert_session(&conn, &sample("existing", "/tmp/a", "Existing")).unwrap();
        conn.execute_batch(
            "DROP INDEX sessions_cwd_cover_idx;
             ALTER TABLE sessions DROP COLUMN sidebar_hidden;
             DELETE FROM schema_migrations WHERE version = 19;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        assert!(!list_by_project(&conn, "/tmp/a").unwrap()[0].sidebar_hidden);
        assert!(
            !get_session(&conn, "existing")
                .unwrap()
                .unwrap()
                .sidebar_hidden
        );
    }

    #[test]
    fn private_chat_round_trips_and_a_bad_boundary_stays_locked() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut row = sample("secret", "/tmp/a", "Secret");
        row.private_chat = true;
        row.private_boundary_id = Some("  turn-1  ".into());
        row.provider_session_id = Some("provider-secret".into());
        row.linked_work_item = Some(json!({"kind": "pr", "repo": "a/b", "number": 1}));
        assert!(upsert_session(&conn, &row).unwrap().private_chat);
        assert!(list_by_project(&conn, &row.cwd).unwrap()[0].private_chat);
        assert!(list_linked(&conn).unwrap()[0].private_chat);
        let stored = get_session(&conn, &row.id).unwrap().unwrap();
        assert!(stored.private_chat);
        assert_eq!(stored.private_boundary_id.as_deref(), Some("turn-1"));
        let keys = list_private_keys(&conn).unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].id, "secret");
        assert_eq!(
            keys[0].provider_session_id.as_deref(),
            Some("provider-secret")
        );

        // A later save of the chat, built before the switch, must not clear the flag.
        let mut stale = row.clone();
        stale.private_chat = false;
        stale.private_boundary_id = None;
        stale.title = "Secret, saved again".into();
        upsert_session(&conn, &stale).unwrap();
        let kept = get_session(&conn, &row.id).unwrap().unwrap();
        assert!(kept.private_chat);
        assert_eq!(kept.private_boundary_id.as_deref(), Some("turn-1"));
        assert_eq!(kept.title, "Secret, saved again");

        // Switching off records the boundary. Switching on again does not move it.
        set_private(&conn, &row.id, false, Some("turn-2")).unwrap();
        let opened = get_session(&conn, &row.id).unwrap().unwrap();
        assert!(!opened.private_chat);
        assert_eq!(opened.private_boundary_id.as_deref(), Some("turn-2"));
        set_private(&conn, &row.id, true, None).unwrap();
        let again = get_session(&conn, &row.id).unwrap().unwrap();
        assert!(again.private_chat);
        assert_eq!(again.private_boundary_id.as_deref(), Some("turn-2"));
        set_private(&conn, &row.id, false, Some("../no")).unwrap();
        assert_eq!(
            get_session(&conn, &row.id)
                .unwrap()
                .unwrap()
                .private_boundary_id
                .as_deref(),
            Some("private-boundary-unreadable")
        );

        // An old row, and a flag that was never set, stay readable.
        upsert_session(&conn, &sample("old", "/tmp/a", "Old")).unwrap();
        let old = get_session(&conn, "old").unwrap().unwrap();
        assert!(!old.private_chat);
        assert_eq!(old.private_boundary_id, None);
        assert!(!list_by_project(&conn, "/tmp/a")
            .unwrap()
            .iter()
            .any(|item| item.id == "old" && item.private_chat));

        // A chat switched back off still has a private part, so it stays on the list.
        set_private(&conn, &row.id, false, Some("turn-3")).unwrap();
        assert_eq!(list_private_keys(&conn).unwrap().len(), 1);

        // A boundary that is not a message id must not unlock the chat.
        conn.execute(
            "UPDATE sessions SET private_chat = 0, private_boundary_id = '../no' WHERE id = 'secret'",
            [],
        )
        .unwrap();
        let locked = get_session(&conn, "secret").unwrap().unwrap();
        assert!(!locked.private_chat);
        assert_eq!(
            locked.private_boundary_id.as_deref(),
            Some("private-boundary-unreadable")
        );
    }

    #[test]
    fn private_chat_migration_keeps_existing_sessions_readable() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        upsert_session(&conn, &sample("existing", "/tmp/a", "Existing")).unwrap();
        conn.execute_batch(
            "DROP INDEX sessions_cwd_cover_idx;
             ALTER TABLE sessions DROP COLUMN private_chat;
             ALTER TABLE sessions DROP COLUMN private_boundary_id;
             DELETE FROM schema_migrations WHERE version = 20;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert!(!listed[0].private_chat);
        let stored = get_session(&conn, "existing").unwrap().unwrap();
        assert!(!stored.private_chat);
        assert_eq!(stored.private_boundary_id, None);
        assert!(list_private_keys(&conn).unwrap().is_empty());
    }

    #[test]
    fn linked_work_item_round_trips() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut row = sample("s1", "/tmp/a", "Fix PR");
        row.linked_work_item = Some(json!({
            "kind": "pr",
            "repo": "openai/codex",
            "number": 42,
            "url": "https://github.com/openai/codex/pull/42"
        }));

        let summary = upsert_session(&conn, &row).unwrap();
        assert_eq!(summary.linked_work_item, row.linked_work_item);
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert_eq!(listed[0].linked_work_item, row.linked_work_item);
        let stored = get_session(&conn, "s1").unwrap().unwrap();
        assert_eq!(stored.linked_work_item, row.linked_work_item);
    }

    #[test]
    fn linked_work_item_can_be_set_and_removed_without_rewriting_the_session() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "Fix PR")).unwrap();
        let linked = json!({
            "kind": "pr",
            "repo": "openai/codex",
            "number": 42,
            "url": "https://github.com/openai/codex/pull/42"
        });

        set_linked_work_item(&conn, "s1", Some(&linked)).unwrap();
        assert_eq!(
            get_session(&conn, "s1").unwrap().unwrap().linked_work_item,
            Some(linked)
        );

        set_linked_work_item(&conn, "s1", None).unwrap();
        assert_eq!(
            get_session(&conn, "s1").unwrap().unwrap().linked_work_item,
            None
        );
    }

    #[test]
    fn automation_id_round_trips() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut row = sample("s1", "/tmp/a", "Nightly review");
        row.automation_id = Some("automation-id".into());

        let summary = upsert_session(&conn, &row).unwrap();
        assert_eq!(summary.automation_id.as_deref(), Some("automation-id"));
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert_eq!(listed[0].automation_id.as_deref(), Some("automation-id"));
        let stored = get_session(&conn, "s1").unwrap().unwrap();
        assert_eq!(stored.automation_id.as_deref(), Some("automation-id"));
    }

    #[test]
    fn list_linked_finds_threads_across_projects() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let linked = json!({
            "kind": "pr",
            "repo": "openai/codex",
            "number": 42,
            "url": "https://github.com/openai/codex/pull/42"
        });
        let mut first = sample("s1", "/tmp/a", "First");
        first.linked_work_item = Some(linked.clone());
        let mut second = sample("s2", "/tmp/b", "Second");
        second.linked_work_item = Some(linked);
        upsert_session(&conn, &first).unwrap();
        upsert_session(&conn, &second).unwrap();
        upsert_session(&conn, &sample("s3", "/tmp/a", "Unlinked")).unwrap();

        let rows = list_linked(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|row| row.id == "s1"));
        assert!(rows.iter().any(|row| row.id == "s2"));
        assert!(rows.iter().all(|row| row.linked_work_item.is_some()));
    }

    #[test]
    fn context_usage_is_absent_until_a_harness_reports() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "First")).unwrap();
        let stored = get_session(&conn, "s1").unwrap().unwrap();
        assert_eq!(stored.context_used, None);
        assert_eq!(stored.context_window, None);
    }

    #[test]
    fn migration_v3_adds_context_columns() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 3",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn upsert_same_blocks_keeps_updated_at() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let first = upsert_session(&conn, &sample("s1", "/tmp/a", "First")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut next = sample("s1", "/tmp/a", "First");
        next.model = "gpt-5.4".into();
        let second = upsert_session(&conn, &next).unwrap();
        assert_eq!(second.updated_at, first.updated_at);
        assert_eq!(second.model, "gpt-5.4");
    }

    #[test]
    fn list_does_not_sum_write_preview_diffs() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut session = sample("s1", "/tmp/a", "Diffs");
        session.blocks = json!([
            { "id": "b1", "role": "user", "text": "edit it" },
            {
                "id": "b2",
                "role": "tool",
                "text": "",
                "tool": {
                    "preview": {
                        "kind": "write",
                        "path": "src/a.ts",
                        "additions": 12,
                        "deletions": 3
                    }
                }
            }
        ]);
        let summary = upsert_session(&conn, &session).unwrap();
        assert_eq!(summary.additions, 0);
        assert_eq!(summary.deletions, 0);
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert_eq!(listed[0].additions, 0);
        assert_eq!(listed[0].deletions, 0);
    }

    #[test]
    fn list_by_project_filters_and_orders() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "A1")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        upsert_session(&conn, &sample("s2", "/tmp/a", "A2")).unwrap();
        upsert_session(&conn, &sample("s3", "/tmp/b", "B1")).unwrap();
        let mut empty = sample("s4", "/tmp/a", "Empty");
        empty.blocks = json!([]);
        upsert_session(&conn, &empty).unwrap();
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "s2");
        assert_eq!(listed[1].id, "s1");
    }

    #[test]
    fn delete_removes_session() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "First")).unwrap();
        delete_session(&conn, "s1").unwrap();
        assert!(get_session(&conn, "s1").unwrap().is_none());
        assert!(list_by_project(&conn, "/tmp/a").unwrap().is_empty());
    }

    #[test]
    fn deleting_a_lead_releases_current_and_earlier_workers() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        for id in ["lead", "earlier", "current", "other-lead", "other-worker"] {
            let mut session = sample(id, "/tmp/a", id);
            session.linked_work_item = Some(json!({"kind": "pr", "number": 1}));
            if ["earlier", "current"].contains(&id) {
                session.blocks = json!([{"id":"u","role":"user","text":"Keep this transcript","orchestrationLeadId":"lead"}]);
            }
            upsert_session(&conn, &session).unwrap();
        }
        save_orchestration(
            &conn,
            "lead",
            &json!({"status":"stopped","tasks":[{"id":"task","sessionId":"current"}]}),
        )
        .unwrap();
        let other =
            json!({"status":"active","tasks":[{"id":"other-task","sessionId":"other-worker"}]});
        save_orchestration(&conn, "other-lead", &other).unwrap();
        delete_session(&conn, "lead").unwrap();

        for id in ["earlier", "current"] {
            let worker = get_session(&conn, id).unwrap().unwrap();
            assert!(worker.orchestration_lead_id.is_none());
            assert!(worker.blocks[0].get("orchestrationLeadId").is_none());
            assert_eq!(worker.blocks[0]["text"], "Keep this transcript");
            assert!(list_by_project(&conn, "/tmp/a")
                .unwrap()
                .iter()
                .any(|row| row.id == id));
            assert!(list_linked(&conn).unwrap().iter().any(|row| row.id == id));
        }
        assert!(orchestration_summary(&conn, "lead").unwrap().is_none());
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orchestration_runs WHERE lead_id = 'lead'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(
            worker_parent(&conn, "other-worker").unwrap().as_deref(),
            Some("other-lead")
        );
        let raw: String = conn
            .query_row(
                "SELECT state FROM orchestration_runs WHERE lead_id = 'other-lead'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), other);
        migrate(&conn).unwrap();
        assert!(worker_parent(&conn, "current").unwrap().is_none());
    }

    #[test]
    fn deleting_a_worker_prunes_parent_state_and_does_not_release_dependencies() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        for id in ["lead", "worker", "dependent", "earlier"] {
            upsert_session(&conn, &sample(id, "/tmp/a", id)).unwrap();
        }
        remember_worker(&conn, "earlier", "lead").unwrap();
        save_orchestration(
            &conn,
            "lead",
            &json!({"status":"active", "requests":{"old":{"result":"worker"}}, "tasks":[
                {"id":"task", "sessionId":"worker", "status":"running", "dependsOn":[]},
                {"id":"next", "sessionId":"dependent", "status":"queued", "dependsOn":["task"]}
            ]}),
        )
        .unwrap();
        delete_session(&conn, "worker").unwrap();
        assert!(get_session(&conn, "worker").unwrap().is_none());
        assert!(worker_parent(&conn, "worker").unwrap().is_none());
        assert_eq!(
            worker_parent(&conn, "earlier").unwrap().as_deref(),
            Some("lead")
        );
        let raw: String = conn
            .query_row(
                "SELECT state FROM orchestration_runs WHERE lead_id = 'lead'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let run: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(run["status"], "stopped");
        assert_eq!(run["requests"], json!({}));
        assert_eq!(run["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(run["tasks"][0]["sessionId"], "dependent");
        assert_eq!(run["tasks"][0]["status"], "cancelled");
        assert_eq!(run["tasks"][0]["dependsOn"], json!([]));
        let summary = orchestration_summary(&conn, "lead").unwrap().unwrap();
        assert_eq!(summary["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(summary["tasks"][0]["sessionId"], "dependent");
        assert_eq!(summary["tasks"][0]["status"], "cancelled");
    }

    #[test]
    fn failed_session_deletion_rolls_back_orchestration_cleanup() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        for id in ["lead", "worker"] {
            upsert_session(&conn, &sample(id, "/tmp/a", id)).unwrap();
        }
        save_orchestration(
            &conn,
            "lead",
            &json!({"status":"stopped", "tasks":[{"id":"task", "sessionId":"worker"}]}),
        )
        .unwrap();
        conn.execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        for id in ["lead", "worker"] {
            assert!(delete_session(&conn, id).is_err());
            assert!(get_session(&conn, id).unwrap().is_some());
            assert_eq!(
                worker_parent(&conn, "worker").unwrap().as_deref(),
                Some("lead")
            );
            assert_eq!(
                orchestration_summary(&conn, "lead").unwrap().unwrap()["tasks"][0]["sessionId"],
                "worker"
            );
        }
    }

    #[test]
    fn migration_v6_adds_archived_column() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 6",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let archived: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'archived'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(archived, 1);
    }

    #[test]
    fn migration_v7_adds_worktree_cwd_column() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'worktree_cwd'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(column, 1);
    }

    #[test]
    fn removed_worktree_state_round_trips_and_can_be_reselected() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut session = sample("s1", "/tmp/a", "First");
        session.worktree_cwd = Some("/tmp/a-worktrees/feature".into());
        session.worktree_removed = true;
        session.branch = Some("stale-branch".into());
        let summary = upsert_session(&conn, &session).unwrap();
        assert!(summary.worktree_removed);
        assert!(summary.branch.is_none());
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert!(listed[0].worktree_removed);
        assert!(listed[0].branch.is_none());
        let restored = get_session(&conn, "s1").unwrap().unwrap();
        assert!(restored.worktree_removed);
        assert_eq!(restored.blocks, session.blocks);
        session.worktree_removed = false;
        session.worktree_cwd = None;
        session.branch = Some("main".into());
        upsert_session(&conn, &session).unwrap();
        let restored = get_session(&conn, "s1").unwrap().unwrap();
        assert!(!restored.worktree_removed);
        assert_eq!(restored.branch.as_deref(), Some("main"));
    }

    /// A chat that came in with no folder (docs/PORTABLE.md) keeps saving while it waits for one; the checks that
    /// protect the row itself stay.
    #[test]
    fn a_chat_with_no_folder_yet_can_still_be_saved() {
        assert_eq!(check_upsert(&sample("s1", "", "Imported")), Ok(()));
        assert!(check_upsert(&sample("../s1", "", "Imported")).is_err());
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "", "Imported")).unwrap();
        let saved = get_session(&conn, "s1").unwrap().unwrap();
        assert_eq!(saved.cwd, "");
        // Never the branch of whatever checkout the app itself runs in.
        assert_eq!(saved.branch, None);
    }

    /// Migration 21: what an import's file named for a cleared folder is kept in a real table, and goes with its chat.
    #[test]
    fn the_imported_folder_notes_are_a_migration_and_go_with_their_chat() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('imported_chat_folders') ORDER BY cid")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(
            columns,
            [
                "session_id",
                "cwd",
                "worktree_cwd",
                "blocked",
                "project_id",
                "rest"
            ]
        );
        // An older database (version 20, no table) gets it.
        conn.execute_batch(
            "DROP TABLE imported_chat_folders; DELETE FROM schema_migrations WHERE version = 21;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 21);
        upsert_session(&conn, &sample("s1", "", "Imported")).unwrap();
        conn.execute(
            "INSERT INTO imported_chat_folders (session_id, cwd) VALUES ('s1', '/Users/old/app')",
            [],
        )
        .unwrap();
        delete_session(&conn, "s1").unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM imported_chat_folders", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(left, 0);
    }

    /// The "Needs a folder" group: every chat with a conversation and no folder, and no chat that has one.
    #[test]
    fn chats_with_no_folder_are_listed_together() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let said = json!([{ "id": "u", "role": "user", "text": "hello" }]);
        for (id, cwd) in [("a", ""), ("b", ""), ("c", "/tmp/a")] {
            let mut session = sample(id, cwd, id);
            session.blocks = said.clone();
            upsert_session(&conn, &session).unwrap();
        }
        // An imported chat that never had a message of its own is listed too: it has to be findable.
        let mut quiet = sample("d", "", "d");
        quiet.blocks = json!([]);
        upsert_session(&conn, &quiet).unwrap();
        let ids: Vec<_> = list_folderless(&conn)
            .unwrap()
            .into_iter()
            .map(|summary| summary.id)
            .collect();
        assert_eq!(ids.len(), 3, "{ids:?}");
        for id in ["a", "b", "d"] {
            assert!(ids.contains(&id.to_string()), "{id}");
        }
        // A chat with a folder still lists only by project, and only once it has a message.
        assert_eq!(list_by_project(&conn, "").unwrap().len(), 2);
    }

    #[test]
    fn archive_round_trips_and_survives_upsert() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "First")).unwrap();
        set_archived(&conn, "s1", true).unwrap();
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert!(listed[0].archived);
        let mut next = sample("s1", "/tmp/a", "Updated");
        next.blocks = json!([
            { "id": "b1", "role": "user", "text": "hello" },
            { "id": "b2", "role": "assistant", "text": "world" }
        ]);
        let summary = upsert_session(&conn, &next).unwrap();
        assert!(summary.archived);
        assert_eq!(summary.title, "Updated");
        set_archived(&conn, "s1", false).unwrap();
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert!(!listed[0].archived);
    }

    #[test]
    fn migration_v11_adds_pinned_column() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 11",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let pinned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'pinned'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pinned, 1);
    }

    #[test]
    fn pin_round_trips_and_survives_upsert() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "First")).unwrap();
        set_pinned(&conn, "s1", true).unwrap();
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert!(listed[0].pinned);
        let mut next = sample("s1", "/tmp/a", "Updated");
        next.blocks = json!([
            { "id": "b1", "role": "user", "text": "hello" },
            { "id": "b2", "role": "assistant", "text": "world" }
        ]);
        let summary = upsert_session(&conn, &next).unwrap();
        assert!(summary.pinned);
        assert_eq!(summary.title, "Updated");
        set_pinned(&conn, "s1", false).unwrap();
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert!(!listed[0].pinned);
    }

    #[test]
    fn get_round_trips_blocks_provider_session_and_account() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut session = sample("s1", "/tmp/a", "First");
        session.provider_account_id = Some("account-work".into());
        upsert_session(&conn, &session).unwrap();
        let record = get_session(&conn, "s1").unwrap().unwrap();
        assert_eq!(record.id, "s1");
        assert_eq!(record.provider_session_id.as_deref(), Some("acp-session-1"));
        assert_eq!(record.provider_account_id.as_deref(), Some("account-work"));
        assert_eq!(record.model_settings["thinking"], "high");
        assert_eq!(record.blocks.as_array().unwrap().len(), 1);
        assert_eq!(record.blocks[0]["text"], "hello");
    }

    #[test]
    fn upsert_snapshots_git_branch() {
        let dir = std::env::temp_dir().join(format!(
            "monocode-session-git-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let init = std::process::Command::new("git")
            .args(["init"])
            .current_dir(&dir)
            .output();
        let Ok(init) = init else {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        };
        if !init.status.success() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let head = std::process::Command::new("git")
            .args(["symbolic-ref", "HEAD", "refs/heads/fix-sidebar"])
            .current_dir(&dir)
            .status();
        if head.map(|status| !status.success()).unwrap_or(true) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let origin = std::process::Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/acme/widget.git",
            ])
            .current_dir(&dir)
            .status();
        if origin.map(|status| !status.success()).unwrap_or(true) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let cwd = dir.to_string_lossy().into_owned();
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let summary = upsert_session(&conn, &sample("s1", &cwd, "First")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(summary.branch.as_deref(), Some("fix-sidebar"));
        assert_eq!(summary.repo.as_deref(), Some("widget"));
    }

    #[test]
    fn upsert_keeps_session_branch_and_worktree() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut session = sample("s1", "/tmp/a", "First");
        session.branch = Some("feat/picker".into());
        session.worktree_cwd = Some("/tmp/a-feat".into());
        let summary = upsert_session(&conn, &session).unwrap();
        assert_eq!(summary.branch.as_deref(), Some("feat/picker"));
        assert_eq!(summary.worktree_cwd.as_deref(), Some("/tmp/a-feat"));
        let record = get_session(&conn, "s1").unwrap().unwrap();
        assert_eq!(record.branch.as_deref(), Some("feat/picker"));
        assert_eq!(record.worktree_cwd.as_deref(), Some("/tmp/a-feat"));
        let listed = list_by_project(&conn, "/tmp/a").unwrap();
        assert_eq!(listed[0].branch.as_deref(), Some("feat/picker"));
        assert_eq!(listed[0].worktree_cwd.as_deref(), Some("/tmp/a-feat"));
    }

    #[test]
    fn rebase_project_moves_saved_sessions_to_the_renamed_path() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("moved", "/tmp/old", "Moved")).unwrap();
        upsert_session(&conn, &sample("other", "/tmp/other", "Other")).unwrap();

        rebase_project(&conn, "/tmp/old", "/tmp/new").unwrap();

        assert!(list_by_project(&conn, "/tmp/old").unwrap().is_empty());
        assert_eq!(list_by_project(&conn, "/tmp/new").unwrap()[0].id, "moved");
        assert_eq!(list_by_project(&conn, "/tmp/other").unwrap()[0].id, "other");
    }

    #[test]
    fn migration_v4_creates_in_flight_table() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 4",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'in_flight_sessions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table, 1);
    }

    #[test]
    fn in_flight_set_take_is_ordered_and_destructive() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.conn.lock().unwrap();
        replace_in_flight(
            &mut conn,
            &[
                InFlightSession {
                    session_id: "s2".into(),
                    cwd: "/tmp/b".into(),
                    background: vec![],
                    resumes: 0,
                },
                InFlightSession {
                    session_id: "s1".into(),
                    cwd: "/tmp/a".into(),
                    background: vec![],
                    resumes: 0,
                },
            ],
        )
        .unwrap();
        let first = take_in_flight(&mut conn).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].session_id, "s2");
        assert_eq!(first[0].cwd, "/tmp/b");
        assert_eq!(first[1].session_id, "s1");
        let second = take_in_flight(&mut conn).unwrap();
        assert!(second.is_empty());
    }

    #[test]
    fn in_flight_list_does_not_clear() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.conn.lock().unwrap();
        replace_in_flight(
            &mut conn,
            &[InFlightSession {
                session_id: "s1".into(),
                cwd: "/tmp/a".into(),
                background: vec![],
                resumes: 0,
            }],
        )
        .unwrap();
        let listed = list_in_flight(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "s1");
        let listed_again = list_in_flight(&conn).unwrap();
        assert_eq!(listed_again.len(), 1);
    }

    #[test]
    fn in_flight_replace_clears_previous() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.conn.lock().unwrap();
        replace_in_flight(
            &mut conn,
            &[InFlightSession {
                session_id: "old".into(),
                cwd: "/tmp/old".into(),
                background: vec![],
                resumes: 0,
            }],
        )
        .unwrap();
        replace_in_flight(&mut conn, &[]).unwrap();
        assert!(take_in_flight(&mut conn).unwrap().is_empty());
    }

    fn work(kind: &str, label: &str, id: &str) -> CutWork {
        CutWork {
            kind: kind.into(),
            label: label.into(),
            id: id.into(),
        }
    }

    #[test]
    fn in_flight_rows_keep_their_background_work_and_resume_count() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.conn.lock().unwrap();
        replace_in_flight(
            &mut conn,
            &[
                InFlightSession {
                    session_id: "lead".into(),
                    cwd: "/tmp/a".into(),
                    background: vec![
                        work("subagent", "Audit src/math.ts", "a44c0ed810da9e4f3"),
                        work("shell", "npm run dev", "b7"),
                    ],
                    resumes: 2,
                },
                InFlightSession {
                    session_id: "plain".into(),
                    cwd: "/tmp/b".into(),
                    background: vec![],
                    resumes: 0,
                },
            ],
        )
        .unwrap();
        let rows = list_in_flight(&conn).unwrap();
        assert_eq!(rows[0].resumes, 2);
        assert_eq!(
            rows[0].background,
            vec![
                work("subagent", "Audit src/math.ts", "a44c0ed810da9e4f3"),
                work("shell", "npm run dev", "b7"),
            ]
        );
        assert_eq!((rows[1].resumes, rows[1].background.len()), (0, 0));
        // An empty list is stored as nothing at all.
        let stored: Option<String> = conn
            .query_row(
                "SELECT background_json FROM in_flight_sessions WHERE session_id = 'plain'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, None);
        drop_in_flight(&conn, "lead").unwrap();
        let rest = take_in_flight(&mut conn).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].session_id, "plain");
    }

    #[test]
    fn in_flight_background_work_is_bounded() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.conn.lock().unwrap();
        let mut background: Vec<CutWork> = (0..80)
            .map(|i| work("subagent", &format!("task {i}"), &format!("id{i}")))
            .collect();
        background[0] = work("weird", &"x".repeat(5_000), " id0 ");
        background[1] = work("shell", "   ", "  ");
        replace_in_flight(
            &mut conn,
            &[InFlightSession {
                session_id: "s".into(),
                cwd: "/tmp/a".into(),
                background,
                resumes: 1,
            }],
        )
        .unwrap();
        let row = list_in_flight(&conn).unwrap().remove(0);
        assert_eq!(row.background.len(), IN_FLIGHT_WORK_MAX);
        assert_eq!(row.background[0].kind, "task", "unknown kinds become tasks");
        assert_eq!(row.background[0].id, "id0");
        assert_eq!(
            row.background[0].label.chars().count(),
            IN_FLIGHT_WORK_LABEL_MAX
        );
        assert!(row.background[0].label.ends_with('…'));
        assert_eq!(
            row.background[1].label, "task 2",
            "blank entries are dropped"
        );
    }

    #[test]
    fn an_older_in_flight_table_gains_the_resume_columns_and_reads_as_none() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE in_flight_sessions (
               session_id TEXT PRIMARY KEY,
               cwd TEXT NOT NULL,
               sort_index INTEGER NOT NULL
             );
             INSERT INTO in_flight_sessions VALUES ('old', '/tmp/a', 0);",
        )
        .unwrap();
        ensure_table_column(&conn, "in_flight_sessions", "background_json", "TEXT").unwrap();
        ensure_table_column(
            &conn,
            "in_flight_sessions",
            "resumes",
            "INTEGER NOT NULL DEFAULT 0",
        )
        .unwrap();
        // Twice is harmless.
        ensure_table_column(&conn, "in_flight_sessions", "resumes", "INTEGER").unwrap();
        let rows = list_in_flight(&conn).unwrap();
        assert_eq!(rows[0].session_id, "old");
        assert_eq!((rows[0].resumes, rows[0].background.len()), (0, 0));
        // An older build's insert, naming only its own columns, still works.
        conn.execute(
            "INSERT INTO in_flight_sessions (session_id, cwd, sort_index) VALUES ('older', '/tmp/b', 1)",
            [],
        )
        .unwrap();
        assert_eq!(list_in_flight(&conn).unwrap().len(), 2);
        // Junk in the JSON column reads as no background work rather than an error.
        conn.execute(
            "UPDATE in_flight_sessions SET background_json = 'not json' WHERE session_id = 'old'",
            [],
        )
        .unwrap();
        assert!(list_in_flight(&conn).unwrap()[0].background.is_empty());
    }

    #[test]
    fn a_fresh_store_has_the_resume_columns() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('in_flight_sessions')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(columns.contains(&"background_json".to_string()));
        assert!(columns.contains(&"resumes".to_string()));
    }

    #[test]
    fn migration_v5_creates_workspace_snapshot_table() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 5",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'workspace_snapshot'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table, 1);
    }

    #[test]
    fn workspace_snapshot_round_trips_and_replaces() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        set_workspace_snapshot(&conn, r#"{"tabs":[{"id":"t1"}]}"#).unwrap();
        let first = get_workspace_snapshot(&conn).unwrap().unwrap();
        assert!(first.contains("t1"));
        set_workspace_snapshot(&conn, r#"{"tabs":[{"id":"t2"}]}"#).unwrap();
        let second = get_workspace_snapshot(&conn).unwrap().unwrap();
        assert!(second.contains("t2"));
        assert!(!second.contains("t1"));
    }

    #[test]
    fn migrate_creates_workspace_tables_when_versions_already_recorded() {
        let path = std::env::temp_dir().join(format!(
            "monocode-stale-migrations-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_migrations (
                   version INTEGER PRIMARY KEY,
                   applied_at INTEGER NOT NULL
                 );
                 CREATE TABLE sessions (
                   id TEXT PRIMARY KEY,
                   cwd TEXT NOT NULL,
                   harness TEXT NOT NULL,
                   model TEXT NOT NULL,
                   model_settings TEXT NOT NULL DEFAULT '{}',
                   runtime_mode TEXT NOT NULL,
                   title TEXT NOT NULL,
                   provider_session_id TEXT,
                   blocks_json TEXT NOT NULL DEFAULT '[]',
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 INSERT INTO schema_migrations (version, applied_at)
                   VALUES (1, 1), (2, 1), (3, 1), (4, 1), (5, 1);",
            )
            .unwrap();
        }
        let store = SessionStore::open(path.clone()).unwrap();
        let conn = store.conn.lock().unwrap();
        let inflight: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'in_flight_sessions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let snapshot: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'workspace_snapshot'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);
        drop(store);
        let _ = std::fs::remove_file(&path);
        assert_eq!(inflight, 1);
        assert_eq!(snapshot, 1);
    }

    #[test]
    fn migrate_restores_the_covering_index_when_versions_already_recorded() {
        let path = std::env::temp_dir().join(format!(
            "monocode-stale-index-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            // A database that claims every version but carries none of the
            // columns or indexes those versions describe.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_migrations (
                   version INTEGER PRIMARY KEY,
                   applied_at INTEGER NOT NULL
                 );
                 CREATE TABLE sessions (
                   id TEXT PRIMARY KEY,
                   cwd TEXT NOT NULL,
                   harness TEXT NOT NULL,
                   model TEXT NOT NULL,
                   model_settings TEXT NOT NULL DEFAULT '{}',
                   runtime_mode TEXT NOT NULL,
                   title TEXT NOT NULL,
                   provider_session_id TEXT,
                   blocks_json TEXT NOT NULL DEFAULT '[]',
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 INSERT INTO schema_migrations (version, applied_at)
                   VALUES (1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 1),
                          (8, 1), (9, 1), (10, 1), (11, 1), (12, 1), (13, 1),
                          (14, 1), (15, 1), (16, 1), (17, 1), (18, 1);",
            )
            .unwrap();
        }
        let store = SessionStore::open(path.clone()).unwrap();
        let conn = store.conn.lock().unwrap();
        let index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'
                   AND name = 'sessions_cwd_cover_idx'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index, 1);
        upsert_session(&conn, &sample("s1", "/tmp/a", "Restored index")).unwrap();
        let result = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "Restored".into(),
                cwd: None,
                include_archived: false,
                search_owner: String::new(),
            },
        )
        .expect("unscoped search must not fail when the index was restored");
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.session_id == "s1" && hit.kind == "conversation"));
        drop(conn);
        drop(store);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_search_uses_a_query_only_read_connection() {
        let path = std::env::temp_dir().join(format!(
            "monocode-session-read-conn-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SessionStore::open(path.clone()).unwrap();
        upsert_session(
            &store.conn.lock().unwrap(),
            &sample("s1", "/tmp/a", "Searchable title"),
        )
        .unwrap();

        let read_conn = store.read_conn.lock().unwrap();
        let conn = read_conn.as_ref().unwrap();
        let result = search_sessions_with_connection(
            conn,
            &SessionSearchOptions {
                query: "Searchable".into(),
                cwd: None,
                include_archived: false,
                search_owner: String::new(),
            },
            None,
        )
        .unwrap();

        assert!(result.hits.iter().any(|hit| hit.session_id == "s1"));
        assert!(conn
            .execute("UPDATE sessions SET title = 'nope' WHERE id = 's1'", [])
            .is_err());
        drop(read_conn);
        drop(store);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn oversized_transcript_keeps_title_hit_without_hiding_older_messages() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut small = sample("small", "/tmp/a", "Needle title");
        small.blocks = json!([{ "id": "small", "role": "user", "text": "needle" }]);
        upsert_session(&conn, &small).unwrap();
        let mut huge = sample("huge", "/tmp/a", "Needle title");
        huge.blocks = json!([{
            "id": "huge",
            "role": "user",
            "text": "needle ".repeat(1_500_000),
        }]);
        upsert_session(&conn, &huge).unwrap();
        conn.execute("UPDATE sessions SET updated_at = 1 WHERE id = 'small'", [])
            .unwrap();
        conn.execute("UPDATE sessions SET updated_at = 2 WHERE id = 'huge'", [])
            .unwrap();

        let result = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "needle".into(),
                cwd: None,
                include_archived: false,
                search_owner: String::new(),
            },
        )
        .unwrap();

        assert!(result.truncated);
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.session_id == "huge" && hit.kind == "conversation"));
        assert!(!result
            .hits
            .iter()
            .any(|hit| hit.session_id == "huge" && hit.kind == "message"));
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.session_id == "small" && hit.kind == "message"));
    }

    #[test]
    fn session_search_without_a_cwd_avoids_the_sessions_table() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let sql = format!("EXPLAIN QUERY PLAN {}", search_sessions_sql(false, false));
        let mut statement = conn.prepare(&sql).unwrap();
        let plan: Vec<String> = statement
            .query_map(
                params!["%needle%", MAX_SEARCH_BUFFER_BYTES as i64, 401i64],
                |row| row.get::<_, String>(3),
            )
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert!(plan
            .iter()
            .any(|step| step.contains("USING INDEX sessions_cwd_cover_idx")));
        for step in &plan {
            if step.contains("sessions") {
                assert!(step.contains("USING INDEX"), "table access: {step}");
            }
        }
    }

    #[test]
    fn a_new_session_search_supersedes_the_same_owner() {
        let owner = "session-search-owner-test";
        let first = begin_session_search(owner).unwrap();
        assert!(first.is_current());
        let second = begin_session_search(owner).unwrap();
        assert!(!first.is_current());
        assert!(second.is_current());
        cancel_owned_session_search(owner);
        assert!(!second.is_current());
    }

    #[test]
    fn a_completed_session_search_releases_its_token() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "Needle title")).unwrap();
        drop(conn);
        let owner = "completed-session-search-owner";

        let result = search_store(
            &store,
            &SessionSearchOptions {
                query: "Needle".into(),
                cwd: None,
                include_archived: false,
                search_owner: owner.into(),
            },
        )
        .unwrap();

        assert!(result
            .hits
            .iter()
            .any(|hit| hit.session_id == "s1" && hit.kind == "conversation"));
        assert!(!session_search_token_registered(owner));
    }

    #[test]
    fn a_superseded_session_search_does_not_release_the_newer_token() {
        let owner = "superseded-release-owner";
        let first = begin_session_search(owner).unwrap();
        let second = begin_session_search(owner).unwrap();

        end_session_search(Some(&first));

        assert!(session_search_token_registered(owner));
        assert!(!first.is_current());
        assert!(second.is_current());
        cancel_owned_session_search(owner);
    }

    #[test]
    fn cancelling_one_session_search_does_not_cancel_another() {
        let first = begin_session_search("first-session-owner").unwrap();
        let second = begin_session_search("second-session-owner").unwrap();

        cancel_owned_session_search("first-session-owner");

        assert!(!first.is_current());
        assert!(second.is_current());
    }

    #[test]
    fn a_superseded_session_search_returns_no_hits() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "Searchable title")).unwrap();
        let owner = "superseded-session-search-test";
        let stale = begin_session_search(owner).unwrap();
        begin_session_search(owner);
        let options = SessionSearchOptions {
            query: "Searchable".into(),
            cwd: None,
            include_archived: false,
            search_owner: owner.into(),
        };

        let result = search_sessions_with_connection(&conn, &options, Some(&stale)).unwrap();

        assert!(result.hits.is_empty());
        assert!(!result.truncated);
        // The progress handler belongs to the search, not the shared connection.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        cancel_owned_session_search(owner);
    }

    #[test]
    fn a_failed_session_search_releases_its_token() {
        let store = SessionStore::open_in_memory().unwrap();
        // Point the read connection at a database with no schema, so the search
        // fails inside SQLite. That error return is the path that used to skip
        // the release, and `SearchView` swallows the rejection.
        *store.read_conn.lock().unwrap() = Some(Connection::open_in_memory().unwrap());
        let owner = "failed-session-search-owner";

        let error = search_store(
            &store,
            &SessionSearchOptions {
                query: "Needle".into(),
                cwd: None,
                include_archived: false,
                search_owner: owner.into(),
            },
        );

        assert!(error.is_err(), "a search with no schema must fail");
        assert!(!session_search_token_registered(owner));
    }

    #[test]
    fn a_test_helper_session_search_releases_its_token() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "Needle title")).unwrap();
        let owner = "helper-session-search-owner";

        let result = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "Needle".into(),
                cwd: None,
                include_archived: false,
                search_owner: owner.into(),
            },
        )
        .unwrap();

        assert!(result
            .hits
            .iter()
            .any(|hit| hit.session_id == "s1" && hit.kind == "conversation"));
        assert!(!session_search_token_registered(owner));
    }

    #[test]
    fn search_uses_top_level_user_blocks_for_the_materialized_filter() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut session = sample("s1", "/tmp/a", "Unrelated title");
        session.blocks = json!([
            { "id": "t1", "role": "tool", "text": "wrapper", "tool": {
                "preview": { "output": "nested role: user needle" }
            } }
        ]);
        upsert_session(&conn, &session).unwrap();

        let result = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "needle".into(),
                cwd: None,
                include_archived: false,
                search_owner: String::new(),
            },
        )
        .unwrap();

        assert!(result.hits.is_empty());
    }

    #[test]
    fn search_finds_title_and_message_hits() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut session = sample("s1", "/tmp/a", "Fix sidebar search");
        session.blocks = json!([
            { "id": "u1", "role": "user", "text": "Please search the sidebar filter chips" },
            { "id": "a1", "role": "assistant", "text": "I will look through the explorer next." }
        ]);
        upsert_session(&conn, &session).unwrap();
        upsert_session(&conn, &sample("s2", "/tmp/b", "Unrelated title")).unwrap();

        let result = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "sidebar".into(),
                cwd: None,
                include_archived: false,
                search_owner: String::new(),
            },
        )
        .unwrap();
        let kinds: Vec<_> = result
            .hits
            .iter()
            .map(|hit| {
                (
                    hit.kind.as_str(),
                    hit.session_id.as_str(),
                    hit.block_id.as_deref(),
                )
            })
            .collect();
        assert!(kinds.contains(&("conversation", "s1", None)));
        assert!(kinds.contains(&("message", "s1", Some("u1"))));
        assert!(!result.hits.iter().any(|hit| hit.session_id == "s2"));
    }

    #[test]
    fn search_skips_inbox_ask_sessions_when_scoped_and_unscoped() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("ask", "/tmp/a", "Needle ask")).unwrap();
        upsert_session(&conn, &sample("chat", "/tmp/a", "Needle chat")).unwrap();
        conn.execute("UPDATE sessions SET inbox_ask = '{}' WHERE id = 'ask'", [])
            .unwrap();

        for cwd in [None, Some("/tmp/a".to_string())] {
            let result = search_sessions(
                &conn,
                &SessionSearchOptions {
                    query: "Needle".into(),
                    cwd,
                    include_archived: false,
                    search_owner: String::new(),
                },
            )
            .unwrap();
            assert!(result.hits.iter().all(|hit| hit.session_id == "chat"));
        }
    }

    #[test]
    fn search_respects_cwd_and_skips_archived() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "Search project a")).unwrap();
        upsert_session(&conn, &sample("s2", "/tmp/b", "Search project b")).unwrap();
        set_archived(&conn, "s1", true).unwrap();

        let scoped = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "Search project".into(),
                cwd: Some("/tmp/a".into()),
                include_archived: false,
                search_owner: String::new(),
            },
        )
        .unwrap();
        assert!(scoped.hits.is_empty());

        let with_archived = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "Search project".into(),
                cwd: Some("/tmp/a".into()),
                include_archived: true,
                search_owner: String::new(),
            },
        )
        .unwrap();
        assert!(with_archived
            .hits
            .iter()
            .any(|hit| hit.session_id == "s1" && hit.kind == "conversation"));

        let other = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "Search project".into(),
                cwd: Some("/tmp/b".into()),
                include_archived: false,
                search_owner: String::new(),
            },
        )
        .unwrap();
        assert!(other.hits.iter().any(|hit| hit.session_id == "s2"));
    }

    #[test]
    fn search_empty_query_is_empty() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        upsert_session(&conn, &sample("s1", "/tmp/a", "Anything")).unwrap();
        let result = search_sessions(
            &conn,
            &SessionSearchOptions {
                query: "   ".into(),
                cwd: None,
                include_archived: false,
                search_owner: String::new(),
            },
        )
        .unwrap();
        assert!(result.hits.is_empty());
        assert!(!result.truncated);
    }
}
