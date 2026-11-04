//! Translated from Orbit (Apache-2.0), https://github.com/coollabsio/orbit:
//!   apps/server/src/repositories/pages.rs — delete_page, restore_page, page_trash, purge_page, empty_trash
//!   apps/server/src/repositories/tasks.rs — delete_task, restore_task, task_trash, TRASH_RETENTION_MILLIS
//!   apps/server/src/repositories/sub_issues.rs — a live subtree, and a batch that shares one trashed_with
//!   apps/server/src/repositories/workspaces.rs — purge_retention (a batch shares one deleted_at, so it expires together)
//!
//! The upstream files do not carry a separate copyright line (Apache-2.0).
//!
//! Orbit stamps `deleted_at` and `trashed_with` on the page or task row. Hivra has no such rows
//! for projects (they are JSON), Monos (they are files) or, until WP-70 and WP-72 merge, tasks
//! and docs. The same rules sit on one ledger. A direct trash sets `trashed_with` to itself, so
//! two deletes in the same millisecond stay separate batches. Restoring a root brings back that
//! batch only. An item trashed on its own earlier keeps its own entry.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::session_store::{now_millis, validate_id, SessionStore};

/// 30 days, in milliseconds. Orbit's `TRASH_RETENTION_MILLIS`.
pub const RETENTION_MILLIS: i64 = 30 * 24 * 60 * 60 * 1_000;

pub const CHANGED: &str = "monocode:trash";

pub const RUNNING_CHAT: &str = "This chat is still running. Stop it, then move it to the trash.";

const KINDS: &[&str] = &["chat", "mono", "project", "note", "doc", "task"];

/// Chats the sidebar, search and `sessions.read` must not show. `id` is already in the covering
/// index, so this lookup does not pull the transcript blob into the list.
pub const HIDDEN_CHAT_SQL: &str = "id NOT IN (SELECT item_id FROM trash_items WHERE kind = 'chat')";

/// Appended to a notes query once the ledger exists. A database from before it has no table.
pub const HIDDEN_NOTE_CLAUSE: &str =
    " AND id NOT IN (SELECT item_id FROM trash_items WHERE kind = 'note')";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrashError {
    Running,
    NotFound,
    NotTrashed,
    Conflict,
    Outside,
    Invalid(&'static str),
    Io(String),
    Db(String),
}

impl std::fmt::Display for TrashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Running => f.write_str(RUNNING_CHAT),
            Self::NotFound => f.write_str("That is not in the trash."),
            Self::NotTrashed => {
                f.write_str("Only something trashed on its own can be deleted forever.")
            }
            Self::Conflict => {
                f.write_str("That changed in another window. Look again, then retry.")
            }
            Self::Outside => f.write_str("Refusing to touch a path outside the trash."),
            Self::Invalid(what) => write!(f, "Invalid {what}."),
            Self::Io(message) => f.write_str(message),
            Self::Db(message) => f.write_str(message),
        }
    }
}

impl From<rusqlite::Error> for TrashError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Db(error.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct Item {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub parent_kind: Option<String>,
    pub parent_id: Option<String>,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Trashed {
    pub version: i64,
    pub already: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoredItem {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub payload: String,
    pub detached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashRow {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub parent_kind: Option<String>,
    pub parent_id: Option<String>,
    pub deleted_at: i64,
    pub trashed_with_kind: String,
    pub trashed_with_id: String,
    pub version: i64,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashListItem {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub deleted_at: i64,
    pub version: i64,
    pub with_count: i64,
    pub payload: String,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Emptied {
    /// Roots only. Children that went with a root are not counted again (Orbit `empty_trash`).
    pub purged: u64,
    pub rows: Vec<TrashRow>,
}

pub fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS trash_items (
           kind TEXT NOT NULL,
           item_id TEXT NOT NULL,
           title TEXT NOT NULL,
           parent_kind TEXT,
           parent_id TEXT,
           deleted_at INTEGER NOT NULL,
           trashed_with_kind TEXT NOT NULL,
           trashed_with_id TEXT NOT NULL,
           version INTEGER NOT NULL,
           payload TEXT NOT NULL DEFAULT '{}',
           PRIMARY KEY (kind, item_id)
         );
         CREATE INDEX IF NOT EXISTS trash_items_batch_idx
           ON trash_items (trashed_with_kind, trashed_with_id);
         CREATE INDEX IF NOT EXISTS trash_items_deleted_idx
           ON trash_items (deleted_at);
         CREATE TABLE IF NOT EXISTS trash_clock (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           n INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO trash_clock (id, n) VALUES (1, 0);",
    )
}

pub fn cutoff(now: i64) -> i64 {
    now.saturating_sub(RETENTION_MILLIS)
}

/// Insert `root` and the live children that are not already trashed. A second call for the same
/// root does not restamp it and does not pull those children into a new batch.
pub fn trash(
    conn: &Connection,
    root: &Item,
    children: &[Item],
    running: bool,
    now: i64,
) -> Result<Trashed, TrashError> {
    check_item(root)?;
    if running && root.kind == "chat" {
        return Err(TrashError::Running);
    }
    let tx = conn.unchecked_transaction()?;
    if let Some(existing) = read_row(&tx, &root.kind, &root.id)? {
        tx.commit()?;
        return Ok(Trashed {
            version: existing.version,
            already: true,
        });
    }
    let version = insert_row(&tx, root, now, &root.kind, &root.id)?;
    for child in children {
        if check_item(child).is_err() {
            continue;
        }
        if read_row(&tx, &child.kind, &child.id)?.is_some() {
            continue;
        }
        insert_row(&tx, child, now, &root.kind, &root.id)?;
    }
    tx.commit()?;
    Ok(Trashed {
        version,
        already: false,
    })
}

pub fn restore(
    conn: &Connection,
    kind: &str,
    id: &str,
    expected_version: i64,
    now: i64,
) -> Result<Vec<RestoredItem>, TrashError> {
    let tx = conn.unchecked_transaction()?;
    let Some(row) = read_row(&tx, kind, id)? else {
        return Err(TrashError::NotFound);
    };
    // At the cutoff the row is gone, even if the daily job has not deleted it yet (Orbit).
    if row.deleted_at <= cutoff(now) {
        return Err(TrashError::NotFound);
    }
    if row.version != expected_version {
        return Err(TrashError::Conflict);
    }
    let direct = is_direct(&row);
    let rows = if direct {
        batch_rows(&tx, &row.kind, &row.id)?
    } else {
        vec![row.clone()]
    };
    if direct {
        tx.execute(
            "DELETE FROM trash_items WHERE trashed_with_kind = ?1 AND trashed_with_id = ?2",
            params![row.kind, row.id],
        )?;
    } else {
        let changed = tx.execute(
            "DELETE FROM trash_items WHERE kind = ?1 AND item_id = ?2 AND version = ?3",
            params![kind, id, expected_version],
        )?;
        if changed == 0 {
            return Err(if read_row(&tx, kind, id)?.is_some() {
                TrashError::Conflict
            } else {
                TrashError::NotFound
            });
        }
    }
    let mut restored = Vec::with_capacity(rows.len());
    for (index, item) in rows.iter().enumerate() {
        // Only the item the person restored detaches. Children that come back with a project keep it.
        let detach_this = if direct { index == 0 } else { true };
        let parent_trashed = detach_this && parent_still_trashed(&tx, item)?;
        if parent_trashed {
            detach(&tx, item)?;
        }
        restored.push(RestoredItem {
            kind: item.kind.clone(),
            id: item.id.clone(),
            title: item.title.clone(),
            payload: item.payload.clone(),
            detached: parent_trashed,
        });
    }
    tx.commit()?;
    Ok(restored)
}

#[cfg(test)]
pub fn delete_forever(
    conn: &Connection,
    kind: &str,
    id: &str,
    expected_version: i64,
) -> Result<Vec<TrashRow>, TrashError> {
    let tx = conn.unchecked_transaction()?;
    let Some(row) = read_row(&tx, kind, id)? else {
        return Err(TrashError::NotFound);
    };
    if !is_direct(&row) {
        return Err(TrashError::NotTrashed);
    }
    if row.version != expected_version {
        return Err(TrashError::Conflict);
    }
    let rows = batch_rows(&tx, kind, id)?;
    let changed = tx.execute(
        "DELETE FROM trash_items WHERE kind = ?1 AND item_id = ?2 AND version = ?3",
        params![kind, id, expected_version],
    )?;
    if changed == 0 {
        return Err(TrashError::Conflict);
    }
    tx.execute(
        "DELETE FROM trash_items WHERE trashed_with_kind = ?1 AND trashed_with_id = ?2",
        params![kind, id],
    )?;
    tx.commit()?;
    Ok(rows)
}

/// Every direct root, with no 30-day cutoff (Orbit `empty_trash`).
#[cfg(test)]
pub fn empty(conn: &Connection) -> Result<Emptied, TrashError> {
    let tx = conn.unchecked_transaction()?;
    let roots = direct_rows(&tx, None)?;
    let mut rows = Vec::new();
    for root in &roots {
        rows.extend(batch_rows(&tx, &root.kind, &root.id)?);
        tx.execute(
            "DELETE FROM trash_items WHERE trashed_with_kind = ?1 AND trashed_with_id = ?2",
            params![root.kind, root.id],
        )?;
    }
    let purged = roots.len() as u64;
    tx.commit()?;
    Ok(Emptied { purged, rows })
}

/// Rows whose `deleted_at` is at or before the cutoff. A batch shares one `deleted_at`, so it
/// expires together. The clock is the caller's `now`.
fn expired_rows(conn: &Connection, now: i64) -> Result<Vec<TrashRow>, TrashError> {
    let mut statement = conn.prepare(
        "SELECT kind, item_id, title, parent_kind, parent_id, deleted_at,
                trashed_with_kind, trashed_with_id, version, payload
         FROM trash_items WHERE deleted_at <= ?1
         ORDER BY deleted_at, kind, item_id",
    )?;
    let rows = statement
        .query_map(params![cutoff(now)], read_mapped)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn purge_expired(conn: &Connection, now: i64) -> Result<Vec<TrashRow>, TrashError> {
    let tx = conn.unchecked_transaction()?;
    let rows = expired_rows(&tx, now)?;
    tx.execute(
        "DELETE FROM trash_items WHERE deleted_at <= ?1",
        params![cutoff(now)],
    )?;
    tx.commit()?;
    Ok(rows)
}

pub fn list_items(conn: &Connection, now: i64) -> Result<Vec<TrashListItem>, TrashError> {
    let mut statement = conn.prepare(
        "SELECT kind, item_id, title, deleted_at, version, payload,
                (SELECT COUNT(*) FROM trash_items AS child
                  WHERE child.trashed_with_kind = trash_items.kind
                    AND child.trashed_with_id = trash_items.item_id
                    AND NOT (child.kind = trash_items.kind AND child.item_id = trash_items.item_id))
         FROM trash_items
         WHERE trashed_with_kind = kind AND trashed_with_id = item_id AND deleted_at > ?1
         ORDER BY deleted_at DESC, kind ASC, item_id ASC",
    )?;
    let rows = statement.query_map(params![cutoff(now)], |row| {
        Ok(TrashListItem {
            kind: row.get(0)?,
            id: row.get(1)?,
            title: row.get(2)?,
            deleted_at: row.get(3)?,
            version: row.get(4)?,
            payload: row.get(5)?,
            with_count: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn is_trashed(conn: &Connection, kind: &str, id: &str) -> Result<bool, TrashError> {
    Ok(read_row(conn, kind, id)?.is_some())
}

/// Live chats and, when a `tasks` or `docs` table is already here, the rows for this folder.
pub fn project_children(conn: &Connection, folder: &str) -> Result<Vec<Item>, TrashError> {
    let mut children = Vec::new();
    if table_exists(conn, "sessions")? {
        let mut statement = conn.prepare(&format!(
            "SELECT id, title FROM sessions WHERE cwd = ?1 AND {HIDDEN_CHAT_SQL}"
        ))?;
        let rows = statement.query_map(params![folder], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, title) = row?;
            children.push(Item {
                kind: "chat".into(),
                id,
                title,
                parent_kind: Some("project".into()),
                parent_id: Some(folder.to_string()),
                payload: "{}".into(),
            });
        }
    }
    for (table, kind) in [("tasks", "task"), ("docs", "doc")] {
        children.extend(table_children(conn, table, kind, folder)?);
    }
    Ok(children)
}

fn table_children(
    conn: &Connection,
    table: &str,
    kind: &str,
    folder: &str,
) -> Result<Vec<Item>, TrashError> {
    if !table_exists(conn, table)? {
        return Ok(Vec::new());
    }
    let cols = table_columns(conn, table)?;
    if !cols.iter().any(|name| name == "id") {
        return Ok(Vec::new());
    }
    let key = ["cwd", "project_id", "project"]
        .into_iter()
        .find(|name| cols.iter().any(|column| column == name));
    let Some(key) = key else {
        return Ok(Vec::new());
    };
    let title = if cols.iter().any(|name| name == "title") {
        "title"
    } else {
        "id"
    };
    let live = if cols.iter().any(|name| name == "trashed_at") {
        "AND trashed_at IS NULL"
    } else if cols.iter().any(|name| name == "deleted_at") {
        "AND deleted_at IS NULL"
    } else {
        ""
    };
    // `table`, `key` and `title` are allow-listed above. Nothing else is interpolated.
    let sql = format!(
        "SELECT id, {title} FROM {table} WHERE {key} = ?1 {live}
           AND id NOT IN (SELECT item_id FROM trash_items WHERE kind = ?2)"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![folder, kind], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title) = row?;
        out.push(Item {
            kind: kind.to_string(),
            id,
            title,
            parent_kind: Some("project".into()),
            parent_id: Some(folder.to_string()),
            payload: "{}".into(),
        });
    }
    Ok(out)
}

/// A project stays put while one of its chats is still running, here or in another window.
fn child_is_running(children: &[Item], running: &[String]) -> bool {
    children
        .iter()
        .any(|item| item.kind == "chat" && running.iter().any(|id| id == &item.id))
}

fn check_item(item: &Item) -> Result<(), TrashError> {
    if !KINDS.contains(&item.kind.as_str()) {
        return Err(TrashError::Invalid("kind"));
    }
    if item.kind == "project" {
        if item.id.trim().is_empty() || item.id.contains('\0') || item.id.len() > 4096 {
            return Err(TrashError::Invalid("project"));
        }
    } else {
        validate_id(&item.id, &item.kind).map_err(|_| TrashError::Invalid("id"))?;
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static FAIL_INSERTS: std::cell::Cell<i32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn fail_next_inserts(count: i32) {
    FAIL_INSERTS.with(|cell| cell.set(count));
}

fn next_version(conn: &Connection) -> Result<i64, TrashError> {
    let changed = conn.execute("UPDATE trash_clock SET n = n + 1 WHERE id = 1", [])?;
    if changed == 0 {
        conn.execute("INSERT INTO trash_clock (id, n) VALUES (1, 1)", [])?;
        return Ok(1);
    }
    let version: i64 = conn.query_row("SELECT n FROM trash_clock WHERE id = 1", [], |row| {
        row.get(0)
    })?;
    Ok(version)
}

fn insert_row(
    conn: &Connection,
    item: &Item,
    now: i64,
    with_kind: &str,
    with_id: &str,
) -> Result<i64, TrashError> {
    #[cfg(test)]
    if FAIL_INSERTS.with(|cell| {
        let left = cell.get();
        if left > 0 {
            cell.set(left - 1);
            true
        } else {
            false
        }
    }) {
        return Err(TrashError::Db("ledger down".into()));
    }
    let (parent_kind, parent_id) = clean_parent(
        &item.kind,
        item.parent_kind.as_deref(),
        item.parent_id.as_deref(),
    );
    let version = next_version(conn)?;
    conn.execute(
        "INSERT INTO trash_items (
           kind, item_id, title, parent_kind, parent_id, deleted_at,
           trashed_with_kind, trashed_with_id, version, payload
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            item.kind,
            item.id,
            clean_title(&item.title),
            parent_kind,
            parent_id,
            now,
            with_kind,
            with_id,
            version,
            clean_payload(&item.payload),
        ],
    )?;
    Ok(version)
}

fn clean_parent(
    kind: &str,
    parent_kind: Option<&str>,
    parent_id: Option<&str>,
) -> (Option<String>, Option<String>) {
    let (Some(parent_kind), Some(parent_id)) = (parent_kind, parent_id) else {
        return (None, None);
    };
    if !KINDS.contains(&parent_kind) {
        return (None, None);
    }
    let id_ok = if parent_kind == "project" {
        !parent_id.is_empty() && !parent_id.contains('\0') && parent_id.len() <= 4096
    } else {
        validate_id(parent_id, parent_kind).is_ok()
    };
    if !id_ok || parent_kind == kind && parent_id.is_empty() {
        return (None, None);
    }
    (Some(parent_kind.to_string()), Some(parent_id.to_string()))
}

fn clean_title(raw: &str) -> String {
    let one_line = raw
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', " ");
    let trimmed = one_line.trim();
    if trimmed.is_empty() {
        "Untitled".into()
    } else {
        trimmed.chars().take(200).collect()
    }
}

fn clean_payload(raw: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) if value.is_object() => value.to_string(),
        _ => "{}".into(),
    }
}

fn is_direct(row: &TrashRow) -> bool {
    row.trashed_with_kind == row.kind && row.trashed_with_id == row.id
}

fn parent_still_trashed(conn: &Connection, row: &TrashRow) -> Result<bool, TrashError> {
    match (row.parent_kind.as_deref(), row.parent_id.as_deref()) {
        (Some(kind), Some(id)) => Ok(read_row(conn, kind, id)?.is_some()),
        _ => Ok(false),
    }
}

fn detach(conn: &Connection, row: &TrashRow) -> Result<(), TrashError> {
    if row.kind == "chat" && table_exists(conn, "sessions")? {
        conn.execute(
            "UPDATE sessions SET cwd = '~' WHERE id = ?1",
            params![row.id],
        )?;
    }
    let table = match row.kind.as_str() {
        "task" => "tasks",
        "doc" => "docs",
        _ => return Ok(()),
    };
    if !table_exists(conn, table)? {
        return Ok(());
    }
    let cols = table_columns(conn, table)?;
    if cols.iter().any(|name| name == "project_id") {
        conn.execute(
            &format!("UPDATE {table} SET project_id = NULL WHERE id = ?1"),
            params![row.id],
        )?;
    } else if cols.iter().any(|name| name == "cwd") {
        conn.execute(
            &format!("UPDATE {table} SET cwd = '~' WHERE id = ?1"),
            params![row.id],
        )?;
    }
    Ok(())
}

fn read_row(conn: &Connection, kind: &str, id: &str) -> Result<Option<TrashRow>, TrashError> {
    let row = conn
        .query_row(
            "SELECT kind, item_id, title, parent_kind, parent_id, deleted_at,
                    trashed_with_kind, trashed_with_id, version, payload
             FROM trash_items WHERE kind = ?1 AND item_id = ?2",
            params![kind, id],
            read_mapped,
        )
        .optional()?;
    Ok(row)
}

fn read_mapped(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrashRow> {
    Ok(TrashRow {
        kind: row.get(0)?,
        id: row.get(1)?,
        title: row.get(2)?,
        parent_kind: row.get(3)?,
        parent_id: row.get(4)?,
        deleted_at: row.get(5)?,
        trashed_with_kind: row.get(6)?,
        trashed_with_id: row.get(7)?,
        version: row.get(8)?,
        payload: row.get(9)?,
    })
}

fn batch_rows(conn: &Connection, kind: &str, id: &str) -> Result<Vec<TrashRow>, TrashError> {
    let mut statement = conn.prepare(
        "SELECT kind, item_id, title, parent_kind, parent_id, deleted_at,
                trashed_with_kind, trashed_with_id, version, payload
         FROM trash_items
         WHERE trashed_with_kind = ?1 AND trashed_with_id = ?2
         ORDER BY CASE WHEN kind = ?1 AND item_id = ?2 THEN 0 ELSE 1 END, kind, item_id",
    )?;
    let rows = statement
        .query_map(params![kind, id], read_mapped)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn direct_rows(conn: &Connection, not_after: Option<i64>) -> Result<Vec<TrashRow>, TrashError> {
    let sql = match not_after {
        Some(_) => {
            "SELECT kind, item_id, title, parent_kind, parent_id, deleted_at,
                    trashed_with_kind, trashed_with_id, version, payload
             FROM trash_items
             WHERE trashed_with_kind = kind AND trashed_with_id = item_id AND deleted_at <= ?1
             ORDER BY deleted_at, kind, item_id"
        }
        None => {
            "SELECT kind, item_id, title, parent_kind, parent_id, deleted_at,
                    trashed_with_kind, trashed_with_id, version, payload
             FROM trash_items
             WHERE trashed_with_kind = kind AND trashed_with_id = item_id
             ORDER BY deleted_at, kind, item_id"
        }
    };
    let mut statement = conn.prepare(sql)?;
    let rows = match not_after {
        Some(cutoff) => statement
            .query_map(params![cutoff], read_mapped)?
            .collect::<Result<Vec<_>, _>>()?,
        None => statement
            .query_map([], read_mapped)?
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(rows)
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, TrashError> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(found != 0)
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, TrashError> {
    // `table` is one of the allow-listed names the callers pass.
    let mut statement = conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
fn count_rows(conn: &Connection) -> Result<i64, TrashError> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM trash_items", [], |row| row.get(0))?;
    Ok(count)
}

// ---- files ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveOutcome {
    Moved(PathBuf),
    Missing,
}

/// Move `source` to `<trash_root>/<name>`. `name` is one path component we build (a Mono id, or
/// `note-<id>`), never a path the person typed. A rename that crosses devices is copied, and the
/// source is removed only after the copy is inside the trash.
pub fn move_into(trash_root: &Path, source: &Path, name: &str) -> Result<MoveOutcome, TrashError> {
    let dest = destination(trash_root, name)?;
    if dest.exists() {
        return Err(TrashError::Conflict);
    }
    let meta = match std::fs::symlink_metadata(source) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MoveOutcome::Missing)
        }
        Err(error) => return Err(TrashError::Io(error.to_string())),
    };
    if !meta.is_dir() && !meta.file_type().is_symlink() {
        return Err(TrashError::Invalid("folder"));
    }
    relocate(source, &dest, trash_root)?;
    Ok(MoveOutcome::Moved(dest))
}

/// Put a trashed folder back at `original`. An existing original is left alone.
pub fn restore_into(
    trash_root: &Path,
    name: &str,
    original: &Path,
) -> Result<MoveOutcome, TrashError> {
    let dest = destination(trash_root, name)?;
    if !dest.exists() {
        return Ok(MoveOutcome::Missing);
    }
    if std::fs::symlink_metadata(original).is_ok() {
        return Err(TrashError::Conflict);
    }
    if let Some(parent) = original.parent() {
        std::fs::create_dir_all(parent).map_err(|error| TrashError::Io(error.to_string()))?;
    }
    let proven = prove_existing_inside(trash_root, &dest)?;
    relocate(&proven, original, original.parent().unwrap_or(original))?;
    Ok(MoveOutcome::Moved(original.to_path_buf()))
}

/// Delete one trashed folder. A symlink that points outside the trash is refused, and so is any
/// name that is not a single safe component.
pub fn remove_trashed(trash_root: &Path, name: &str) -> Result<(), TrashError> {
    let dest = match destination(trash_root, name) {
        Ok(dest) => dest,
        Err(TrashError::Io(_)) => return Ok(()),
        Err(error) => return Err(error),
    };
    if std::fs::symlink_metadata(&dest).is_err() {
        return Ok(());
    }
    let proven = prove_existing_inside(trash_root, &dest)?;
    std::fs::remove_dir_all(proven).map_err(|error| TrashError::Io(error.to_string()))
}

fn destination(trash_root: &Path, name: &str) -> Result<PathBuf, TrashError> {
    let name = safe_component(name)?;
    std::fs::create_dir_all(trash_root).map_err(|error| TrashError::Io(error.to_string()))?;
    let root =
        std::fs::canonicalize(trash_root).map_err(|error| TrashError::Io(error.to_string()))?;
    let dest = root.join(name);
    if !dest.starts_with(&root) {
        return Err(TrashError::Outside);
    }
    Ok(dest)
}

fn safe_component(name: &str) -> Result<&str, TrashError> {
    if name.is_empty()
        || name.len() > 200
        || name == "."
        || name == ".."
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(TrashError::Invalid("name"));
    }
    Ok(name)
}

fn prove_existing_inside(trash_root: &Path, candidate: &Path) -> Result<PathBuf, TrashError> {
    let root =
        std::fs::canonicalize(trash_root).map_err(|error| TrashError::Io(error.to_string()))?;
    let full =
        std::fs::canonicalize(candidate).map_err(|error| TrashError::Io(error.to_string()))?;
    if full == root || !full.starts_with(&root) {
        return Err(TrashError::Outside);
    }
    Ok(full)
}

fn relocate(source: &Path, dest: &Path, must_contain: &Path) -> Result<(), TrashError> {
    match std::fs::rename(source, dest) {
        Ok(()) => Ok(()),
        Err(error) if crosses_devices(&error) => copy_then_remove(source, dest, must_contain),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(TrashError::Conflict)
        }
        Err(error) => Err(TrashError::Io(error.to_string())),
    }
}

fn crosses_devices(error: &std::io::Error) -> bool {
    // EXDEV is 18 on Unix. Windows ERROR_NOT_SAME_DEVICE is 17.
    error.raw_os_error() == Some(18) || error.raw_os_error() == Some(17)
}

/// The body of a cross-device move. The source is removed only after `dest` canonicalises inside
/// `must_contain`. A failed copy removes the partial dest when that is inside the trash, and
/// leaves the source.
pub fn copy_then_remove(source: &Path, dest: &Path, must_contain: &Path) -> Result<(), TrashError> {
    if let Err(error) = copy_nofollow(source, dest) {
        if prove_existing_inside(must_contain, dest).is_ok() {
            let _ = std::fs::remove_dir_all(dest);
        }
        return Err(error);
    }
    let proven = prove_existing_inside(must_contain, dest)?;
    let _ = proven;
    remove_source(source)
}

fn remove_source(source: &Path) -> Result<(), TrashError> {
    let meta =
        std::fs::symlink_metadata(source).map_err(|error| TrashError::Io(error.to_string()))?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        std::fs::remove_dir_all(source).map_err(|error| TrashError::Io(error.to_string()))
    } else {
        std::fs::remove_file(source).map_err(|error| TrashError::Io(error.to_string()))
    }
}

fn copy_nofollow(source: &Path, dest: &Path) -> Result<(), TrashError> {
    let meta =
        std::fs::symlink_metadata(source).map_err(|error| TrashError::Io(error.to_string()))?;
    if meta.file_type().is_symlink() {
        copy_symlink(source, dest)
    } else if meta.is_dir() {
        std::fs::create_dir(dest).map_err(|error| TrashError::Io(error.to_string()))?;
        for entry in std::fs::read_dir(source).map_err(|error| TrashError::Io(error.to_string()))? {
            let entry = entry.map_err(|error| TrashError::Io(error.to_string()))?;
            copy_nofollow(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(source, dest)
            .map(|_| ())
            .map_err(|error| TrashError::Io(error.to_string()))
    }
}

#[cfg(unix)]
fn copy_symlink(source: &Path, dest: &Path) -> Result<(), TrashError> {
    let target = std::fs::read_link(source).map_err(|error| TrashError::Io(error.to_string()))?;
    std::os::unix::fs::symlink(target, dest).map_err(|error| TrashError::Io(error.to_string()))
}

#[cfg(windows)]
fn copy_symlink(source: &Path, dest: &Path) -> Result<(), TrashError> {
    let target = std::fs::read_link(source).map_err(|error| TrashError::Io(error.to_string()))?;
    std::os::windows::fs::symlink_file(&target, dest)
        .or_else(|_| std::os::windows::fs::symlink_dir(&target, dest))
        .map_err(|error| TrashError::Io(error.to_string()))
}

// ---- commands ---------------------------------------------------------------

/// The running check and the ledger insert are one step. The live-turn lock stays held until the
/// row is in, so a turn that starts in between cannot land in the trash.
pub fn commit_if_idle(
    conn: &Connection,
    live: &crate::live_turns::LiveTurns,
    root: &Item,
    children: &[Item],
    now: i64,
) -> Result<Trashed, TrashError> {
    let guard = live.lock_map();
    let running = crate::live_turns::sorted_ids(&guard);
    let busy = match root.kind.as_str() {
        "chat" => running.iter().any(|id| id == &root.id),
        "project" => child_is_running(children, &running),
        _ => false,
    };
    if busy {
        return Err(TrashError::Running);
    }
    #[cfg(test)]
    crate::live_turns::run_hold_probe(live);
    let trashed = trash(conn, root, children, false, now)?;
    drop(guard);
    Ok(trashed)
}

#[derive(Debug)]
pub(crate) struct HardDeleted {
    pub rows: Vec<TrashRow>,
    pub images: Vec<String>,
}

fn preflight_images(conn: &Connection, rows: &[TrashRow]) -> Result<Vec<String>, TrashError> {
    let mut images = Vec::new();
    for row in rows {
        if row.kind == "chat" {
            images.extend(
                crate::session_store::collect_chat_image_paths(conn, &row.id)
                    .map_err(TrashError::Db)?,
            );
        }
    }
    Ok(images)
}

fn apply_domain_sql(conn: &Connection, row: &TrashRow) -> Result<(), TrashError> {
    match row.kind.as_str() {
        "chat" => crate::session_store::delete_session(conn, &row.id)
            .map_err(|error| TrashError::Db(error.to_string())),
        "note" => crate::notes::purge_note(conn, &row.id)
            .map_err(|error| TrashError::Db(error.to_string())),
        "task" => delete_optional_row(conn, "tasks", &row.id),
        "doc" => delete_optional_row(conn, "docs", &row.id),
        _ => Ok(()),
    }
}

/// Read every chat's images first. Then, in one transaction, drop the ledger rows and the domain
/// rows. Nothing is destroyed if a later read throws.
pub(crate) fn hard_delete_root(
    conn: &Connection,
    kind: &str,
    id: &str,
    version: i64,
) -> Result<HardDeleted, TrashError> {
    let Some(row) = read_row(conn, kind, id)? else {
        return Err(TrashError::NotFound);
    };
    if !is_direct(&row) {
        return Err(TrashError::NotTrashed);
    }
    if row.version != version {
        return Err(TrashError::Conflict);
    }
    let rows = batch_rows(conn, kind, id)?;
    let images = preflight_images(conn, &rows)?;
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "DELETE FROM trash_items WHERE kind = ?1 AND item_id = ?2 AND version = ?3",
        params![kind, id, version],
    )?;
    if changed == 0 {
        return Err(TrashError::Conflict);
    }
    tx.execute(
        "DELETE FROM trash_items WHERE trashed_with_kind = ?1 AND trashed_with_id = ?2",
        params![kind, id],
    )?;
    for row in &rows {
        apply_domain_sql(&tx, row)?;
    }
    tx.commit()?;
    Ok(HardDeleted { rows, images })
}

pub(crate) fn hard_empty(conn: &Connection) -> Result<HardDeleted, TrashError> {
    let roots = direct_rows(conn, None)?;
    let mut rows = Vec::new();
    for root in &roots {
        rows.extend(batch_rows(conn, &root.kind, &root.id)?);
    }
    let images = preflight_images(conn, &rows)?;
    let tx = conn.unchecked_transaction()?;
    for root in &roots {
        tx.execute(
            "DELETE FROM trash_items WHERE trashed_with_kind = ?1 AND trashed_with_id = ?2",
            params![root.kind, root.id],
        )?;
    }
    for row in &rows {
        apply_domain_sql(&tx, row)?;
    }
    tx.commit()?;
    Ok(HardDeleted { rows, images })
}

fn reinsert_rows(conn: &Connection, rows: &[TrashRow]) -> Result<(), TrashError> {
    let tx = conn.unchecked_transaction()?;
    for row in rows {
        tx.execute(
            "INSERT OR IGNORE INTO trash_items (
               kind, item_id, title, parent_kind, parent_id, deleted_at,
               trashed_with_kind, trashed_with_id, version, payload
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                row.kind,
                row.id,
                row.title,
                row.parent_kind,
                row.parent_id,
                row.deleted_at,
                row.trashed_with_kind,
                row.trashed_with_id,
                row.version,
                row.payload,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn remove_files_or_restore(
    app: &AppHandle,
    store: &SessionStore,
    deleted: &HardDeleted,
) -> Result<(), String> {
    let mut remaining = deleted.rows.clone();
    for row in &deleted.rows {
        if let Err(error) = apply_files(app, row) {
            let conn = store.lock_conn()?;
            if let Err(again) = reinsert_rows(&conn, &remaining) {
                return Err(format!("{error}; rollback failed: {again}"));
            }
            return Err(error.to_string());
        }
        remaining.remove(0);
    }
    if !deleted.images.is_empty() {
        if let Err(error) = crate::fs::delete_generated_images_sync(app, &deleted.images) {
            eprintln!("Generated image cleanup will need a retry: {error}");
        }
    }
    Ok(())
}

fn restore_mono_pair(
    trash_root: &Path,
    id: &str,
    original: &Path,
    team: &Path,
) -> Result<(), TrashError> {
    let moved = restore_into(trash_root, id, original)?;
    let team_name = format!("{id}.team");
    if let Err(error) = restore_into(trash_root, &team_name, team) {
        if matches!(moved, MoveOutcome::Moved(_)) {
            match move_into(trash_root, original, id) {
                Ok(_) => return Err(error),
                Err(rollback) => {
                    return Err(TrashError::Io(format!(
                        "{error}; rollback failed: {rollback}"
                    )));
                }
            }
        }
        return Err(error);
    }
    Ok(())
}

fn undo_parked(trash_root: &Path, parked: &[(&str, &Path)]) -> Result<(), TrashError> {
    let mut problems = Vec::new();
    for (name, original) in parked {
        if let Err(error) = restore_into(trash_root, name, original) {
            problems.push(format!("{name}: {error}"));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(TrashError::Io(format!(
            "rollback failed: {}",
            problems.join("; ")
        )))
    }
}

/// The ledger write for folders already sitting in the trash. A failed write puts the folders
/// back. If they cannot come back, the ledger is tried again so the trash can still list them.
pub fn record_after_moves(
    conn: &Connection,
    trash_root: &Path,
    parked: &[(String, PathBuf)],
    root: &Item,
    children: &[Item],
    now: i64,
) -> Result<Trashed, TrashError> {
    match trash(conn, root, children, false, now) {
        Ok(trashed) => Ok(trashed),
        Err(error) => {
            let refs: Vec<(&str, &Path)> = parked
                .iter()
                .map(|(name, path)| (name.as_str(), path.as_path()))
                .collect();
            match undo_parked(trash_root, &refs) {
                Ok(()) => Err(error),
                Err(rollback) => match trash(conn, root, children, false, now) {
                    Ok(_) => Err(TrashError::Io(format!(
                        "{error}; rollback failed: {rollback}; the trash still lists it"
                    ))),
                    Err(again) => Err(TrashError::Io(format!(
                        "{error}; rollback failed: {rollback}; ledger retry failed: {again}"
                    ))),
                },
            }
        }
    }
}

fn mono_item(mono: &MonoTrash) -> Item {
    Item {
        kind: "mono".into(),
        id: mono.id.clone(),
        title: mono.title.clone(),
        parent_kind: None,
        parent_id: None,
        payload: mono.payload.clone(),
    }
}

fn keep_or_undo(
    store: &SessionStore,
    trash_root: &Path,
    parked: &[(String, PathBuf)],
    mono: &MonoTrash,
    error: TrashError,
) -> String {
    let refs: Vec<(&str, &Path)> = parked
        .iter()
        .map(|(name, path)| (name.as_str(), path.as_path()))
        .collect();
    match undo_parked(trash_root, &refs) {
        Ok(()) => error.to_string(),
        Err(rollback) => {
            let Ok(mut conn) = store.lock_conn() else {
                return format!(
                    "{error}; rollback failed: {rollback}; ledger retry failed: Session store is locked"
                );
            };
            cancel_mono_work(&mut conn, &mono.id);
            let children = mono_children(&conn, mono);
            match trash(&conn, &mono_item(mono), &children, false, now_millis()) {
                Ok(_) => format!("{error}; rollback failed: {rollback}; the trash still lists it"),
                Err(again) => {
                    format!("{error}; rollback failed: {rollback}; ledger retry failed: {again}")
                }
            }
        }
    }
}

fn emit(app: &AppHandle) {
    let _ = app.emit(CHANGED, ());
}

#[tauri::command]
pub fn trash_list(store: State<'_, SessionStore>) -> Result<Vec<TrashListItem>, String> {
    let conn = store.lock_conn()?;
    list_items(&conn, now_millis()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn trash_restore(
    app: AppHandle,
    store: State<'_, SessionStore>,
    kind: String,
    id: String,
    version: i64,
) -> Result<Vec<RestoredItem>, String> {
    let conn = store.lock_conn()?;
    let row = read_row(&conn, &kind, &id).map_err(|error| error.to_string())?;
    let Some(row) = row else {
        return Err(TrashError::NotFound.to_string());
    };
    if let Err(error) = restore_files(&app, &row) {
        return Err(error.to_string());
    }
    match restore(&conn, &kind, &id, version, now_millis()) {
        Ok(items) => {
            drop(conn);
            emit(&app);
            Ok(items)
        }
        Err(error) => {
            if let Err(rollback) = park_files(&app, &row) {
                return Err(format!("{error}; rollback failed: {rollback}"));
            }
            Err(error.to_string())
        }
    }
}

#[tauri::command]
pub fn trash_delete_forever(
    app: AppHandle,
    store: State<'_, SessionStore>,
    kind: String,
    id: String,
    version: i64,
) -> Result<u64, String> {
    let conn = store.lock_conn()?;
    let row = read_row(&conn, &kind, &id).map_err(|error| error.to_string())?;
    let Some(row) = row else {
        return Err(TrashError::NotFound.to_string());
    };
    if !is_direct(&row) {
        return Err(TrashError::NotTrashed.to_string());
    }
    if row.version != version {
        return Err(TrashError::Conflict.to_string());
    }
    let deleted =
        hard_delete_root(&conn, &kind, &id, version).map_err(|error| error.to_string())?;
    drop(conn);
    remove_files_or_restore(&app, &store, &deleted)?;
    emit(&app);
    let _ = app.emit(crate::reminders::CHANGED, ());
    Ok(deleted.rows.iter().filter(|row| is_direct(row)).count() as u64)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyResult {
    pub purged: u64,
}

#[tauri::command]
pub fn trash_empty(app: AppHandle, store: State<'_, SessionStore>) -> Result<EmptyResult, String> {
    let conn = store.lock_conn()?;
    let deleted = hard_empty(&conn).map_err(|error| error.to_string())?;
    let purged = deleted.rows.iter().filter(|row| is_direct(row)).count() as u64;
    drop(conn);
    remove_files_or_restore(&app, &store, &deleted)?;
    emit(&app);
    let _ = app.emit(crate::reminders::CHANGED, ());
    Ok(EmptyResult { purged })
}

#[tauri::command]
pub fn trash_project(
    app: AppHandle,
    store: State<'_, SessionStore>,
    live: State<'_, crate::live_turns::LiveTurns>,
    folder: String,
    title: String,
) -> Result<Trashed, String> {
    let conn = store.lock_conn()?;
    let children = project_children(&conn, &folder).map_err(|error| error.to_string())?;
    // A chat that is still running, in this window or another, keeps the project where it is.
    // The check and the insert hold the live-turn lock together.
    let trashed = commit_if_idle(
        &conn,
        &live,
        &Item {
            kind: "project".into(),
            id: folder,
            title,
            parent_kind: None,
            parent_id: None,
            payload: "{}".into(),
        },
        &children,
        now_millis(),
    )
    .map_err(|error| error.to_string())?;
    drop(conn);
    emit(&app);
    Ok(trashed)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonoTrash {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub payload: String,
}

#[tauri::command]
pub fn trash_mono(
    app: AppHandle,
    store: State<'_, SessionStore>,
    live: State<'_, crate::live_turns::LiveTurns>,
    id: String,
    title: String,
    session_ids: Option<Vec<String>>,
    payload: Option<String>,
) -> Result<Trashed, String> {
    let mono = MonoTrash {
        id,
        title,
        session_ids: session_ids.unwrap_or_default(),
        payload: payload.unwrap_or_default(),
    };
    validate_id(&mono.id, "mono").map_err(|_| TrashError::Invalid("id").to_string())?;
    let running = live.list();
    if mono
        .session_ids
        .iter()
        .any(|id| running.iter().any(|live_id| live_id == id))
    {
        return Err(RUNNING_CHAT.to_string());
    }
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let root = crate::mono::resolved_root(&data);
    let source = root.join(&mono.id);
    let team = data.join("mono-teams").join(&mono.id);
    let trash_root = data.join("trash");
    let team_name = format!("{}.team", mono.id);
    let mut parked: Vec<(String, PathBuf)> = Vec::new();
    match move_into(&trash_root, &source, &mono.id).map_err(|error| error.to_string())? {
        MoveOutcome::Moved(_) => parked.push((mono.id.clone(), source.clone())),
        MoveOutcome::Missing => {}
    }
    match move_into(&trash_root, &team, &team_name) {
        Ok(MoveOutcome::Moved(_)) => parked.push((team_name, team.clone())),
        Ok(MoveOutcome::Missing) => {}
        Err(error) => return Err(keep_or_undo(&store, &trash_root, &parked, &mono, error)),
    }
    let mut conn = store.lock_conn()?;
    cancel_mono_work(&mut conn, &mono.id);
    let children = mono_children(&conn, &mono);
    let trashed = record_after_moves(
        &conn,
        &trash_root,
        &parked,
        &mono_item(&mono),
        &children,
        now_millis(),
    )
    .map_err(|error| error.to_string())?;
    drop(conn);
    emit(&app);
    Ok(trashed)
}

fn mono_children(conn: &Connection, mono: &MonoTrash) -> Vec<Item> {
    let mut children = Vec::new();
    for session_id in &mono.session_ids {
        if validate_id(session_id, "chat").is_err() {
            continue;
        }
        let cwd = session_cwd(conn, session_id);
        children.push(Item {
            kind: "chat".into(),
            id: session_id.clone(),
            title: session_title(conn, session_id).unwrap_or_else(|| "Chat".into()),
            // The chat's project is its cwd, so a restore while that project is trashed detaches it.
            // The Mono is the batch root (`trashed_with`), which is separate from this parent.
            parent_kind: cwd.as_ref().map(|_| "project".into()),
            parent_id: cwd,
            payload: "{}".into(),
        });
    }
    children
}

fn session_title(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT title FROM sessions WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .ok()
}

fn session_cwd(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT cwd FROM sessions WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .ok()
}

fn cancel_mono_work(conn: &mut Connection, mono_id: &str) {
    if !table_exists(conn, "delegations").unwrap_or(false) {
        return;
    }
    let ids = conn
        .prepare(
            "SELECT id FROM delegations WHERE owner_mono = ?1 AND state IN ('running', 'question')",
        )
        .and_then(|mut statement| {
            statement
                .query_map(params![mono_id], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()
        });
    let Ok(ids) = ids else {
        return;
    };
    if ids.is_empty() {
        return;
    }
    let _ = crate::delegations::cancel(
        conn,
        &ids,
        Some("Moved to the trash.".into()),
        None,
        now_millis(),
    );
}

fn restore_files(app: &AppHandle, row: &TrashRow) -> Result<(), TrashError> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| TrashError::Io(error.to_string()))?;
    let trash_root = data.join("trash");
    if row.kind == "mono" {
        let original = crate::mono::resolved_root(&data).join(&row.id);
        let team = data.join("mono-teams").join(&row.id);
        restore_mono_pair(&trash_root, &row.id, &original, &team)?;
    }
    if row.kind == "note" {
        let name = format!("note-{}", row.id);
        let original = data.join("note-assets").join(&row.id);
        restore_into(&trash_root, &name, &original)?;
    }
    Ok(())
}

fn park_files(app: &AppHandle, row: &TrashRow) -> Result<(), TrashError> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| TrashError::Io(error.to_string()))?;
    let trash_root = data.join("trash");
    if row.kind == "mono" {
        let original = crate::mono::resolved_root(&data).join(&row.id);
        move_into(&trash_root, &original, &row.id)?;
        let team = data.join("mono-teams").join(&row.id);
        move_into(&trash_root, &team, &format!("{}.team", row.id))?;
    }
    if row.kind == "note" {
        let original = data.join("note-assets").join(&row.id);
        move_into(&trash_root, &original, &format!("note-{}", row.id))?;
    }
    Ok(())
}

fn apply_domain(app: &AppHandle, conn: &Connection, row: &TrashRow) -> Result<(), TrashError> {
    match row.kind.as_str() {
        "chat" => crate::session_store::purge_chat(app, conn, &row.id).map_err(TrashError::Db),
        "note" => {
            crate::notes::purge_note(conn, &row.id)
                .map_err(|error| TrashError::Db(error.to_string()))?;
            Ok(())
        }
        "task" => delete_optional_row(conn, "tasks", &row.id),
        "doc" => delete_optional_row(conn, "docs", &row.id),
        _ => Ok(()),
    }
}

fn delete_optional_row(conn: &Connection, table: &str, id: &str) -> Result<(), TrashError> {
    if !table_exists(conn, table)? {
        return Ok(());
    }
    let cols = table_columns(conn, table)?;
    if !cols.iter().any(|name| name == "id") {
        return Ok(());
    }
    conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])?;
    Ok(())
}

fn apply_files(app: &AppHandle, row: &TrashRow) -> Result<(), TrashError> {
    let Ok(data) = app.path().app_data_dir() else {
        return Ok(());
    };
    let trash_root = data.join("trash");
    match row.kind.as_str() {
        "mono" => {
            remove_trashed(&trash_root, &row.id)?;
            remove_trashed(&trash_root, &format!("{}.team", row.id))?;
        }
        "note" => {
            remove_trashed(&trash_root, &format!("note-{}", row.id))?;
            let _ = crate::notes::remove_note_assets(app, &row.id);
        }
        _ => {}
    }
    Ok(())
}

pub fn start_daily_purge(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("trash-purge".into())
        .spawn(move || loop {
            if let Err(error) = purge_once(&app) {
                eprintln!("Trash purge will retry tomorrow: {error}");
            }
            std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60));
        });
}

fn purge_once(app: &AppHandle) -> Result<(), String> {
    let store = app
        .try_state::<SessionStore>()
        .ok_or_else(|| "Trash purge found no session store".to_string())?;
    let conn = store.lock_conn()?;
    let rows = expired_rows(&conn, now_millis()).map_err(|error| error.to_string())?;
    if rows.is_empty() {
        return Ok(());
    }
    for row in &rows {
        apply_domain(app, &conn, row).map_err(|error| error.to_string())?;
        apply_files(app, row).map_err(|error| error.to_string())?;
    }
    // The row stays in the ledger until the chat, note or files are actually gone, so a
    // failure here is retried tomorrow instead of bringing the item back.
    purge_expired(&conn, now_millis()).map_err(|error| error.to_string())?;
    drop(conn);
    emit(app);
    Ok(())
}

/// Move a note's images into the trash. Missing images are fine.
pub fn park_note_assets(app: &AppHandle, note_id: &str) -> Result<(), TrashError> {
    validate_id(note_id, "note").map_err(|_| TrashError::Invalid("id"))?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| TrashError::Io(error.to_string()))?;
    let source = data.join("note-assets").join(note_id);
    move_into(&data.join("trash"), &source, &format!("note-{note_id}")).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_table(&conn).unwrap();
        conn
    }

    fn item(kind: &str, id: &str, title: &str) -> Item {
        Item {
            kind: kind.into(),
            id: id.into(),
            title: title.into(),
            parent_kind: None,
            parent_id: None,
            payload: "{}".into(),
        }
    }

    fn child(kind: &str, id: &str, parent_kind: &str, parent_id: &str) -> Item {
        Item {
            kind: kind.into(),
            id: id.into(),
            title: id.into(),
            parent_kind: Some(parent_kind.into()),
            parent_id: Some(parent_id.into()),
            payload: "{}".into(),
        }
    }

    fn deleted_at(conn: &Connection, kind: &str, id: &str) -> i64 {
        read_row(conn, kind, id).unwrap().unwrap().deleted_at
    }

    #[test]
    fn every_kind_trashes_and_restores() {
        let conn = memory();
        for kind in ["chat", "mono", "note", "doc", "task"] {
            let id = format!("{kind}1");
            let trashed = trash(&conn, &item(kind, &id, "Title"), &[], false, 10).unwrap();
            assert!(!trashed.already);
            assert!(list_items(&conn, 10)
                .unwrap()
                .iter()
                .any(|row| row.id == id));
            let restored = restore(&conn, kind, &id, trashed.version, 10).unwrap();
            assert_eq!(restored.len(), 1);
            assert!(!is_trashed(&conn, kind, &id).unwrap());
        }
        let project = item("project", "/Users/ash/My Project", "Mine");
        let trashed = trash(&conn, &project, &[], false, 10).unwrap();
        restore(&conn, "project", &project.id, trashed.version, 10).unwrap();
        assert!(!is_trashed(&conn, "project", &project.id).unwrap());
    }

    #[test]
    fn a_running_chat_is_refused_and_writes_nothing() {
        let conn = memory();
        let error = trash(&conn, &item("chat", "chat1", "Live"), &[], true, 10).unwrap_err();
        assert_eq!(error, TrashError::Running);
        assert_eq!(count_rows(&conn).unwrap(), 0);
        // A project is not a turn. The flag does not block it.
        trash(&conn, &item("project", "/tmp/p", "P"), &[], true, 10).unwrap();
        assert_eq!(count_rows(&conn).unwrap(), 1);
    }

    #[test]
    fn cascade_restores_what_went_with_the_project_and_not_what_was_already_trashed() {
        let conn = memory();
        trash(&conn, &item("chat", "earlier", "Earlier"), &[], false, 1).unwrap();
        let project = item("project", "/work/app", "App");
        let children = vec![
            child("chat", "earlier", "project", "/work/app"),
            child("chat", "with", "project", "/work/app"),
            child("task", "task1", "project", "/work/app"),
            child("doc", "doc1", "project", "/work/app"),
        ];
        let trashed = trash(&conn, &project, &children, false, 50).unwrap();
        assert_eq!(
            deleted_at(&conn, "chat", "earlier"),
            1,
            "an earlier trash is not restamped"
        );
        assert_eq!(
            read_row(&conn, "chat", "earlier")
                .unwrap()
                .unwrap()
                .trashed_with_id,
            "earlier"
        );
        let listed = list_items(&conn, 50).unwrap();
        let project_row = listed.iter().find(|row| row.id == "/work/app").unwrap();
        assert_eq!(
            project_row.with_count, 3,
            "the earlier chat is not part of the batch"
        );
        assert!(listed.iter().any(|row| row.id == "earlier"));
        assert!(
            !listed.iter().any(|row| row.id == "with"),
            "a child is not its own row"
        );

        restore(&conn, "project", "/work/app", trashed.version, 50).unwrap();
        assert!(!is_trashed(&conn, "chat", "with").unwrap());
        assert!(!is_trashed(&conn, "task", "task1").unwrap());
        assert!(!is_trashed(&conn, "doc", "doc1").unwrap());
        assert!(is_trashed(&conn, "chat", "earlier").unwrap());
    }

    #[test]
    fn restoring_under_a_trashed_parent_comes_back_at_the_top() {
        let conn = memory();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT);
             INSERT INTO sessions (id, cwd, title) VALUES ('with', '/work/app', 'With');
             CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, project_id TEXT);
             INSERT INTO tasks (id, title, project_id) VALUES ('task1', 'Task', '/work/app');",
        )
        .unwrap();
        let children = vec![
            child("chat", "with", "project", "/work/app"),
            child("task", "task1", "project", "/work/app"),
        ];
        trash(
            &conn,
            &item("project", "/work/app", "App"),
            &children,
            false,
            5,
        )
        .unwrap();
        let chat_version = read_row(&conn, "chat", "with").unwrap().unwrap().version;
        let restored = restore(&conn, "chat", "with", chat_version, 5).unwrap();
        assert_eq!(restored.len(), 1);
        assert!(restored[0].detached);
        let cwd: String = conn
            .query_row("SELECT cwd FROM sessions WHERE id = 'with'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(cwd, "~");
        assert!(is_trashed(&conn, "project", "/work/app").unwrap());
        assert!(is_trashed(&conn, "task", "task1").unwrap());

        let task_version = read_row(&conn, "task", "task1").unwrap().unwrap().version;
        let task = restore(&conn, "task", "task1", task_version, 5).unwrap();
        assert!(task[0].detached);
        let project_id: Option<String> = conn
            .query_row(
                "SELECT project_id FROM tasks WHERE id = 'task1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project_id, None);
    }

    #[test]
    fn restoring_the_project_keeps_its_chats_with_it() {
        let conn = memory();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT);
             INSERT INTO sessions (id, cwd, title) VALUES ('with', '/work/app', 'With');",
        )
        .unwrap();
        trash(
            &conn,
            &item("project", "/work/app", "App"),
            &[child("chat", "with", "project", "/work/app")],
            false,
            5,
        )
        .unwrap();
        let restored = restore(&conn, "project", "/work/app", 1, 5).unwrap();
        assert!(restored.iter().all(|item| !item.detached));
        let cwd: String = conn
            .query_row("SELECT cwd FROM sessions WHERE id = 'with'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(cwd, "/work/app");
    }

    #[test]
    fn a_direct_chat_under_a_trashed_project_also_detaches() {
        let conn = memory();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT);
             INSERT INTO sessions (id, cwd, title) VALUES ('own', '/work/app', 'Own');",
        )
        .unwrap();
        let mut own = item("chat", "own", "Own");
        own.parent_kind = Some("project".into());
        own.parent_id = Some("/work/app".into());
        trash(&conn, &own, &[], false, 1).unwrap();
        trash(&conn, &item("project", "/work/app", "App"), &[], false, 2).unwrap();
        let restored = restore(&conn, "chat", "own", 1, 2).unwrap();
        assert!(restored[0].detached);
        let cwd: String = conn
            .query_row("SELECT cwd FROM sessions WHERE id = 'own'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(cwd, "~");
        assert!(is_trashed(&conn, "project", "/work/app").unwrap());
    }

    #[test]
    fn purge_uses_the_cutoff_and_restore_refuses_at_exactly_30_days() {
        let conn = memory();
        trash(&conn, &item("note", "n1", "Note"), &[], false, 0).unwrap();
        trash(
            &conn,
            &item("project", "/p", "P"),
            &[child("chat", "c1", "project", "/p")],
            false,
            0,
        )
        .unwrap();
        let just_before = RETENTION_MILLIS - 1;
        assert_eq!(purge_expired(&conn, just_before).unwrap().len(), 0);
        assert_eq!(list_items(&conn, just_before).unwrap().len(), 2);
        let refused = restore(&conn, "note", "n1", 1, RETENTION_MILLIS).unwrap_err();
        assert_eq!(refused, TrashError::NotFound);
        assert!(
            is_trashed(&conn, "note", "n1").unwrap(),
            "the row stays until the job runs"
        );
        let purged = purge_expired(&conn, RETENTION_MILLIS).unwrap();
        assert_eq!(purged.len(), 3, "the project batch expires together");
        assert!(list_items(&conn, RETENTION_MILLIS).unwrap().is_empty());
    }

    #[test]
    fn a_newer_item_is_not_purged_with_an_older_batch() {
        let conn = memory();
        trash(&conn, &item("chat", "old", "Old"), &[], false, 0).unwrap();
        trash(
            &conn,
            &item("chat", "new", "New"),
            &[],
            false,
            RETENTION_MILLIS,
        )
        .unwrap();
        let purged = purge_expired(&conn, RETENTION_MILLIS).unwrap();
        assert_eq!(purged.len(), 1);
        assert!(is_trashed(&conn, "chat", "new").unwrap());
    }

    #[test]
    fn version_conflict_leaves_the_row_and_a_second_restore_is_gone() {
        let conn = memory();
        trash(&conn, &item("doc", "d1", "Doc"), &[], false, 4).unwrap();
        let error = restore(&conn, "doc", "d1", 2, 4).unwrap_err();
        assert_eq!(error, TrashError::Conflict);
        assert_eq!(deleted_at(&conn, "doc", "d1"), 4);
        restore(&conn, "doc", "d1", 1, 4).unwrap();
        assert_eq!(
            restore(&conn, "doc", "d1", 1, 4).unwrap_err(),
            TrashError::NotFound
        );
        let forever = delete_forever(&conn, "doc", "missing", 1).unwrap_err();
        assert_eq!(forever, TrashError::NotFound);
    }

    #[test]
    fn delete_forever_refuses_a_child_and_empty_has_no_cutoff() {
        let conn = memory();
        trash(
            &conn,
            &item("project", "/p", "P"),
            &[child("chat", "c1", "project", "/p")],
            false,
            0,
        )
        .unwrap();
        trash(&conn, &item("note", "n1", "N"), &[], false, 0).unwrap();
        assert_eq!(
            delete_forever(&conn, "chat", "c1", 1).unwrap_err(),
            TrashError::NotTrashed
        );
        assert!(is_trashed(&conn, "chat", "c1").unwrap());
        let removed = delete_forever(&conn, "project", "/p", 1).unwrap();
        assert_eq!(removed.len(), 2);
        assert!(
            is_trashed(&conn, "note", "n1").unwrap(),
            "the note was not in that batch"
        );
        // Expired rows are still emptied. empty() does not look at the clock.
        assert!(list_items(&conn, RETENTION_MILLIS).unwrap().is_empty());
        let emptied = empty(&conn).unwrap();
        assert_eq!(emptied.purged, 1, "the note is the only remaining root");
        assert_eq!(count_rows(&conn).unwrap(), 0);
    }

    #[test]
    fn a_second_trash_does_not_restamp_or_adopt_new_children() {
        let conn = memory();
        trash(&conn, &item("chat", "c1", "C"), &[], false, 1).unwrap();
        let again = trash(
            &conn,
            &item("chat", "c1", "C"),
            &[child("task", "t1", "chat", "c1")],
            false,
            99,
        )
        .unwrap();
        assert!(again.already);
        assert_eq!(again.version, 1);
        assert_eq!(deleted_at(&conn, "chat", "c1"), 1);
        assert!(!is_trashed(&conn, "task", "t1").unwrap());
    }

    #[test]
    fn a_restored_item_trashed_again_does_not_reuse_its_version() {
        let conn = memory();
        let first = trash(&conn, &item("chat", "c1", "One"), &[], false, 1).unwrap();
        let old = first.version;
        restore(&conn, "chat", "c1", old, 2).unwrap();
        let second = trash(&conn, &item("chat", "c1", "One"), &[], false, 3).unwrap();
        assert_ne!(second.version, old);
        assert_eq!(
            delete_forever(&conn, "chat", "c1", old).unwrap_err(),
            TrashError::Conflict
        );
        assert!(read_row(&conn, "chat", "c1").unwrap().is_some());
        delete_forever(&conn, "chat", "c1", second.version).unwrap();
        assert!(read_row(&conn, "chat", "c1").unwrap().is_none());
    }

    struct ResetInserts;
    impl Drop for ResetInserts {
        fn drop(&mut self) {
            fail_next_inserts(0);
        }
    }

    thread_local! {
        static LIVE_LOCK_HELD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    fn probe_live_lock(live: &crate::live_turns::LiveTurns) {
        LIVE_LOCK_HELD.with(|cell| cell.set(!live.mutex_is_free()));
    }

    #[test]
    fn the_live_lock_stays_held_until_the_row_is_inserted() {
        use crate::live_turns::{set_hold_probe, LiveTurns};
        let _reset = ResetInserts;
        LIVE_LOCK_HELD.with(|cell| cell.set(false));
        set_hold_probe(Some(probe_live_lock));
        let live = LiveTurns::default();
        let conn = memory();
        commit_if_idle(&conn, &live, &item("chat", "c1", "C"), &[], 1).unwrap();
        set_hold_probe(None);
        assert!(LIVE_LOCK_HELD.with(|cell| cell.get()));
        assert!(is_trashed(&conn, "chat", "c1").unwrap());
    }

    #[test]
    fn a_later_chat_image_failure_removes_nothing() {
        use crate::session_store::{fail_chat_image_read_for, SessionStore};
        let _reset = ResetInserts;
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        for id in ["chat-a", "chat-b"] {
            conn.execute(
                "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, blocks_json, created_at, updated_at, worktree_cwd, archived) VALUES (?1, '/work/app', 'codex', 'test', 'supervised', 'Test', '[]', 0, 0, NULL, 0)",
                params![id],
            )
            .unwrap();
        }
        let mut project = item("project", "/work/app", "App");
        project.payload = "{}".into();
        let children = vec![
            Item {
                kind: "chat".into(),
                id: "chat-a".into(),
                title: "A".into(),
                parent_kind: Some("project".into()),
                parent_id: Some("/work/app".into()),
                payload: "{}".into(),
            },
            Item {
                kind: "chat".into(),
                id: "chat-b".into(),
                title: "B".into(),
                parent_kind: Some("project".into()),
                parent_id: Some("/work/app".into()),
                payload: "{}".into(),
            },
        ];
        let trashed = trash(&conn, &project, &children, false, 10).unwrap();
        fail_chat_image_read_for(Some("chat-b"));
        let error = hard_delete_root(&conn, "project", "/work/app", trashed.version).unwrap_err();
        fail_chat_image_read_for(None);
        assert!(error.to_string().contains("chat-b"), "{error}");
        for id in ["chat-a", "chat-b"] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sessions WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "{id} was destroyed");
            assert!(
                is_trashed(&conn, "chat", id).unwrap(),
                "{id} left the ledger"
            );
        }
        let restored = restore(&conn, "project", "/work/app", trashed.version, 11).unwrap();
        assert!(restored.iter().any(|item| item.id == "chat-a"));
        assert!(restored.iter().any(|item| item.id == "chat-b"));
    }

    #[test]
    fn a_failed_team_restore_puts_the_mono_folder_back() {
        let tmp = Tmp::new("team-rollback");
        let trash_root = tmp.0.join("trash");
        let mono = tmp.0.join("monos").join("mono1");
        let team = tmp.0.join("teams").join("mono1");
        std::fs::create_dir_all(&mono).unwrap();
        std::fs::write(mono.join("soul"), "soul").unwrap();
        std::fs::create_dir_all(&team).unwrap();
        std::fs::write(team.join("habit"), "habit").unwrap();
        move_into(&trash_root, &mono, "mono1").unwrap();
        move_into(&trash_root, &team, "mono1.team").unwrap();
        std::fs::create_dir_all(&team).unwrap();
        let error = restore_mono_pair(&trash_root, "mono1", &mono, &team).unwrap_err();
        assert_eq!(error, TrashError::Conflict);
        assert_eq!(
            std::fs::read_to_string(trash_root.join("mono1").join("soul")).unwrap(),
            "soul"
        );
        assert!(!mono.join("soul").exists());
    }

    #[test]
    fn a_blocked_rollback_is_reported_and_the_ledger_keeps_the_folder() {
        let _reset = ResetInserts;
        let tmp = Tmp::new("blocked-rollback");
        let conn = memory();
        let trash_root = tmp.0.join("trash");
        let mono = tmp.0.join("monos").join("mono1");
        std::fs::create_dir_all(&mono).unwrap();
        std::fs::write(mono.join("soul"), "soul").unwrap();
        move_into(&trash_root, &mono, "mono1").unwrap();
        std::fs::create_dir_all(&mono).unwrap();
        fail_next_inserts(1);
        let error = record_after_moves(
            &conn,
            &trash_root,
            &[("mono1".into(), mono.clone())],
            &item("mono", "mono1", "Mono"),
            &[],
            1,
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("rollback failed"), "{message}");
        assert!(message.contains("ledger down"), "{message}");
        assert!(is_trashed(&conn, "mono", "mono1").unwrap());
        assert_eq!(
            std::fs::read_to_string(trash_root.join("mono1").join("soul")).unwrap(),
            "soul"
        );

        fail_next_inserts(8);
        let other = tmp.0.join("monos").join("mono2");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("soul"), "soul").unwrap();
        move_into(&trash_root, &other, "mono2").unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let error = record_after_moves(
            &conn,
            &trash_root,
            &[("mono2".into(), other)],
            &item("mono", "mono2", "Mono"),
            &[],
            2,
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("rollback failed"), "{message}");
        assert!(message.contains("ledger retry failed"), "{message}");
        assert!(!is_trashed(&conn, "mono", "mono2").unwrap());
        assert!(trash_root.join("mono2").join("soul").exists());
    }

    #[test]
    fn invalid_empty_and_duplicate_inputs_are_safe() {
        let conn = memory();
        assert_eq!(
            trash(&conn, &item("nope", "a", "A"), &[], false, 1).unwrap_err(),
            TrashError::Invalid("kind")
        );
        assert_eq!(
            trash(&conn, &item("chat", "", "A"), &[], false, 1).unwrap_err(),
            TrashError::Invalid("id")
        );
        assert_eq!(
            trash(&conn, &item("chat", "..", "A"), &[], false, 1).unwrap_err(),
            TrashError::Invalid("id")
        );
        assert_eq!(count_rows(&conn).unwrap(), 0);
        let mut messy = item("note", "n1", "a\r\nb");
        messy.payload = "not json".into();
        trash(
            &conn,
            &messy,
            &[
                child("task", "t1", "note", "n1"),
                child("task", "t1", "note", "n1"),
                child("task", "", "note", "n1"),
            ],
            false,
            3,
        )
        .unwrap();
        let row = read_row(&conn, "note", "n1").unwrap().unwrap();
        assert_eq!(row.title, "a b");
        assert_eq!(row.payload, "{}");
        assert!(is_trashed(&conn, "task", "t1").unwrap());
        assert_eq!(count_rows(&conn).unwrap(), 2);
    }

    #[test]
    fn project_children_include_tasks_and_docs_when_those_tables_exist() {
        let conn = memory();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT);
             INSERT INTO sessions (id, cwd, title) VALUES ('c1', '/work/app', 'Chat');
             CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, project_id TEXT, trashed_at INTEGER);
             INSERT INTO tasks (id, title, project_id, trashed_at) VALUES
               ('live', 'Live', '/work/app', NULL),
               ('gone', 'Gone', '/work/app', 1);
             CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, cwd TEXT);
             INSERT INTO docs (id, title, cwd) VALUES ('d1', 'Doc', '/work/app');",
        )
        .unwrap();
        trash(&conn, &item("chat", "c1", "Chat"), &[], false, 1).unwrap();
        let children = project_children(&conn, "/work/app").unwrap();
        let ids: Vec<_> = children.iter().map(|item| item.id.as_str()).collect();
        assert!(
            !ids.contains(&"c1"),
            "an already trashed chat stays its own entry"
        );
        assert!(ids.contains(&"live"));
        assert!(!ids.contains(&"gone"));
        assert!(ids.contains(&"d1"));
    }

    #[test]
    fn a_running_chat_keeps_its_project_out_of_the_trash() {
        let children = vec![item("chat", "live", "Live"), item("doc", "d1", "Doc")];
        assert!(child_is_running(&children, &["live".into()]));
        assert!(!child_is_running(&children, &["other".into()]));
        assert!(!child_is_running(&children, &[]));
        // A doc id that happens to match a running chat id is not a chat.
        assert!(!child_is_running(
            &[item("doc", "live", "Doc")],
            &["live".into()]
        ));
    }

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "hivra trash {} {}",
                label,
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn mono_files_move_into_the_trash_and_come_back() {
        let tmp = Tmp::new("ünicode");
        let spaced = tmp.0.join("dir with space");
        let trash_root = spaced.join("trash");
        let mono = spaced.join("monos").join("mono1");
        std::fs::create_dir_all(&mono).unwrap();
        std::fs::write(mono.join("SOUL.md"), "soul").unwrap();
        let moved = move_into(&trash_root, &mono, "mono1").unwrap();
        assert!(matches!(moved, MoveOutcome::Moved(_)));
        assert!(!mono.exists());
        assert_eq!(
            std::fs::read_to_string(trash_root.join("mono1").join("SOUL.md")).unwrap(),
            "soul"
        );
        restore_into(&trash_root, "mono1", &mono).unwrap();
        assert_eq!(
            std::fs::read_to_string(mono.join("SOUL.md")).unwrap(),
            "soul"
        );
        assert!(!trash_root.join("mono1").exists());
    }

    #[test]
    fn an_existing_destination_or_original_is_a_conflict_and_nothing_is_deleted() {
        let tmp = Tmp::new("conflict");
        let trash_root = tmp.0.join("trash");
        let mono = tmp.0.join("mono1");
        std::fs::create_dir_all(&mono).unwrap();
        std::fs::write(mono.join("a.txt"), "a").unwrap();
        std::fs::create_dir_all(trash_root.join("mono1")).unwrap();
        assert_eq!(
            move_into(&trash_root, &mono, "mono1").unwrap_err(),
            TrashError::Conflict
        );
        assert_eq!(std::fs::read_to_string(mono.join("a.txt")).unwrap(), "a");

        std::fs::remove_dir_all(trash_root.join("mono1")).unwrap();
        move_into(&trash_root, &mono, "mono1").unwrap();
        std::fs::create_dir_all(&mono).unwrap();
        std::fs::write(mono.join("a.txt"), "kept").unwrap();
        assert_eq!(
            restore_into(&trash_root, "mono1", &mono).unwrap_err(),
            TrashError::Conflict
        );
        assert_eq!(std::fs::read_to_string(mono.join("a.txt")).unwrap(), "kept");
        assert!(trash_root.join("mono1").exists());
    }

    #[test]
    fn unsafe_names_are_refused_and_a_path_outside_the_trash_is_not_deleted() {
        let tmp = Tmp::new("outside");
        let trash_root = tmp.0.join("trash");
        let source = tmp.0.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("keep.txt"), "keep").unwrap();
        let outside = tmp.0.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        for name in [
            "",
            ".",
            "..",
            "../etc",
            "foo/bar",
            "foo\\bar",
            "a..b",
            "has space",
        ] {
            assert!(
                move_into(&trash_root, &source, name).is_err(),
                "{name} should be refused"
            );
        }
        assert!(source.join("keep.txt").exists());
        assert_eq!(
            remove_trashed(&trash_root, "..").unwrap_err(),
            TrashError::Invalid("name")
        );
        assert_eq!(
            std::fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "secret"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_trash_that_points_outside_is_not_followed() {
        let tmp = Tmp::new("link");
        let trash_root = tmp.0.join("trash");
        std::fs::create_dir_all(&trash_root).unwrap();
        let outside = tmp.0.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside, trash_root.join("evil")).unwrap();
        assert_eq!(
            remove_trashed(&trash_root, "evil").unwrap_err(),
            TrashError::Outside
        );
        assert_eq!(
            std::fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "secret"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_skips_the_symlink_escape_check_without_a_privilege_to_make_one() {
        let tmp = Tmp::new("win");
        let trash_root = tmp.0.join("trash");
        let folder = tmp.0.join("folder");
        std::fs::create_dir_all(&folder).unwrap();
        move_into(&trash_root, &folder, "folder").unwrap();
        remove_trashed(&trash_root, "folder").unwrap();
        assert!(!trash_root.join("folder").exists());
    }

    #[test]
    fn the_copy_fallback_removes_the_source_only_after_the_dest_is_inside() {
        let tmp = Tmp::new("copy");
        let trash_root = tmp.0.join("trash");
        std::fs::create_dir_all(&trash_root).unwrap();
        let source = tmp.0.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("soul.md"), "soul").unwrap();
        let dest = destination(&trash_root, "mono1").unwrap();
        copy_then_remove(&source, &dest, &trash_root).unwrap();
        assert!(!source.exists());
        assert_eq!(
            std::fs::read_to_string(dest.join("soul.md")).unwrap(),
            "soul"
        );

        let source = tmp.0.join("source2");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("soul.md"), "soul").unwrap();
        let outside = tmp.0.join("not-trash");
        std::fs::create_dir_all(&outside).unwrap();
        let error = copy_then_remove(&source, &outside.join("mono1"), &trash_root).unwrap_err();
        assert!(matches!(error, TrashError::Outside | TrashError::Io(_)));
        assert_eq!(
            std::fs::read_to_string(source.join("soul.md")).unwrap(),
            "soul"
        );
    }

    #[test]
    fn exdev_is_the_cross_device_error() {
        let error = std::io::Error::from_raw_os_error(18);
        assert!(crosses_devices(&error));
        let error = std::io::Error::from_raw_os_error(17);
        assert!(crosses_devices(&error));
        let error = std::io::Error::from_raw_os_error(2);
        assert!(!crosses_devices(&error));
    }

    #[cfg(unix)]
    #[test]
    fn the_copy_keeps_a_symlink_without_following_it() {
        let tmp = Tmp::new("symlink-copy");
        let trash_root = tmp.0.join("trash");
        std::fs::create_dir_all(&trash_root).unwrap();
        let source = tmp.0.join("source");
        std::fs::create_dir_all(&source).unwrap();
        let outside = tmp.0.join("outside.txt");
        std::fs::write(&outside, "outside").unwrap();
        std::os::unix::fs::symlink(&outside, source.join("link")).unwrap();
        let dest = destination(&trash_root, "mono1").unwrap();
        copy_then_remove(&source, &dest, &trash_root).unwrap();
        assert_eq!(std::fs::read_link(dest.join("link")).unwrap(), outside);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside");
    }
}
