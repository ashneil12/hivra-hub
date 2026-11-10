// SPDX-License-Identifier: Apache-2.0
//
// Translated from Orbit (https://github.com/coollabsio/orbit) apps/server/src/audit.rs.
// The upstream file does not carry a separate copyright line.
//
// Hivra WP-78: one append-only list of what agents and the app did.
// `bounded_text`, `bounded_metadata` and the newest-first page (ask for one
// extra row; the cursor is the last row kept) are Orbit's. Hivra keeps a
// person, the app or an agent, and keeps who asked (the initiator) apart from
// who did it (the actor). That split is OpenBot's audit stamp
// (toolkit/src/initiator.ts, MIT): the actor is whose authority was used, the
// initiator is what caused it, and a person's own action has the person as both.

//! The activity log (docs/hivra/work/WP-78-activity-log.md).
//!
//! Rows are inserted and then left alone. A trigger rejects updates. The only
//! delete is the 90-day prune. Two windows both insert: nothing is read and
//! written back, so neither window can overwrite the other.

use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;

use crate::portable::scrubber;
use crate::session_store::{now_millis, SessionStore};

/// How long a row stays. A row written at exactly this age is kept.
pub const RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

const MAX_METADATA_BYTES: usize = 2_048;
const MAX_SUMMARY_CHARS: usize = 500;
const MAX_FIELD_CHARS: usize = 500;
const MAX_NAME_CHARS: usize = 200;
const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 200;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub const MERGE: &str = "git.merge";
pub const PUSH: &str = "git.push";
pub const PULL_REQUEST: &str = "git.pr";
pub const PLUGIN_INSTALL: &str = "plugin.install";
pub const PLUGIN_UPDATE: &str = "plugin.update";
pub const PLUGIN_ROLLBACK: &str = "plugin.rollback";
pub const PLUGIN_REMOVE: &str = "plugin.remove";
pub const BROWSER_START: &str = "browser.start";
pub const BROWSER_STOP: &str = "browser.stop";
pub const DESKTOP_START: &str = "desktop.start";
pub const DESKTOP_STOP: &str = "desktop.stop";
pub const SHIP: &str = "ship";
pub const SHIP_TRIAL: &str = "ship.trial";
pub const SHIP_ROLLBACK: &str = "ship.rollback";
pub const PERMISSION_GRANT: &str = "permission.grant";

/// Who did a thing, or who asked for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "kebab-case")]
pub enum Who {
    Person,
    App,
    FirstMate {
        #[serde(default)]
        id: String,
        #[serde(default)]
        name: String,
    },
    Mono {
        #[serde(default)]
        id: String,
        #[serde(default)]
        name: String,
    },
    Worker {
        #[serde(default)]
        id: String,
        #[serde(default)]
        name: String,
    },
}

impl Who {
    pub fn person() -> Self {
        Self::Person
    }

    pub fn app() -> Self {
        Self::App
    }

    pub fn first_mate(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self::FirstMate {
            id: id.into(),
            name: name.into(),
        }
    }

    pub fn mono(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self::Mono {
            id: id.into(),
            name: name.into(),
        }
    }

    pub fn worker(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self::Worker {
            id: id.into(),
            name: name.into(),
        }
    }

    fn parts(&self) -> (&'static str, &str, &str) {
        match self {
            Self::Person => ("person", "", ""),
            Self::App => ("app", "", ""),
            Self::FirstMate { id, name } => ("first-mate", id, name),
            Self::Mono { id, name } => ("mono", id, name),
            Self::Worker { id, name } => ("worker", id, name),
        }
    }
}

/// One stored row, newest fields first in the screen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub seq: i64,
    pub kind: String,
    pub actor: Who,
    pub initiator: Who,
    pub project: String,
    pub target: String,
    pub summary: String,
    pub link: String,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub at: i64,
    pub seq: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub entries: Vec<Entry>,
    pub next: Option<Cursor>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub before: Option<Cursor>,
    #[serde(default)]
    pub limit: Option<u32>,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS activity (
           seq INTEGER PRIMARY KEY,
           id TEXT NOT NULL UNIQUE,
           kind TEXT NOT NULL,
           actor_role TEXT NOT NULL,
           actor_id TEXT NOT NULL DEFAULT '',
           actor_name TEXT NOT NULL DEFAULT '',
           initiator_role TEXT NOT NULL,
           initiator_id TEXT NOT NULL DEFAULT '',
           initiator_name TEXT NOT NULL DEFAULT '',
           project TEXT NOT NULL DEFAULT '',
           target TEXT NOT NULL DEFAULT '',
           summary TEXT NOT NULL,
           link TEXT NOT NULL DEFAULT '',
           at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS activity_newest ON activity (at DESC, seq DESC);
         CREATE TRIGGER IF NOT EXISTS activity_append_only
         BEFORE UPDATE ON activity
         BEGIN
           SELECT RAISE(ABORT, 'activity is append-only');
         END;",
    )
}

/// Orbit `bounded_text`: the first `max_chars` characters, so a multibyte
/// character is never cut in half.
pub(crate) fn bounded_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

/// Orbit `bounded_metadata`: a JSON blob over 2048 bytes is replaced with
/// `{"truncated":true}`, never a sliced payload that could keep half a secret.
pub(crate) fn bounded_metadata(metadata: &Value) -> String {
    let serialized = serde_json::to_string(metadata).unwrap_or_else(|_| "{}".to_owned());
    if serialized.len() <= MAX_METADATA_BYTES {
        serialized
    } else {
        "{\"truncated\":true}".to_owned()
    }
}

fn redact(text: &str) -> String {
    scrubber().redact_text(text).0
}

fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\0' => {}
            '\r' | '\n' | '\t' => out.push(' '),
            _ => out.push(c),
        }
    }
    out.trim().to_string()
}

fn clean_field(value: &str, max_chars: usize) -> String {
    let text = bounded_text(&one_line(&redact(value)), max_chars);
    if scrubber().findings(&text).is_empty() {
        text
    } else {
        String::new()
    }
}

fn clean_summary(summary: &str) -> String {
    let text = one_line(&redact(summary));
    let text = if text.is_empty() {
        "Recorded.".to_string()
    } else {
        text
    };
    let bounded = bounded_text(&text, MAX_SUMMARY_CHARS);
    // Same rule as Orbit's metadata: if the bounded text still doesn't fit as
    // JSON, drop it instead of slicing a secret in half.
    if bounded_metadata(&Value::String(bounded.clone())) == "{\"truncated\":true}"
        || !scrubber().findings(&bounded).is_empty()
    {
        return "Summary left out because it was too long.".into();
    }
    bounded
}

fn stored_who(who: &Who) -> Who {
    match who.clone() {
        Who::Person => Who::Person,
        Who::App => Who::App,
        Who::FirstMate { id, name } => agent("first-mate", id, name),
        Who::Mono { id, name } => agent("mono", id, name),
        Who::Worker { id, name } => agent("worker", id, name),
    }
}

fn agent(role: &str, id: String, name: String) -> Who {
    let id = clean_field(&id, MAX_NAME_CHARS);
    let name = clean_field(&name, MAX_NAME_CHARS);
    if id.is_empty() {
        return Who::App;
    }
    match role {
        "first-mate" => Who::FirstMate { id, name },
        "mono" => Who::Mono { id, name },
        _ => Who::Worker { id, name },
    }
}

fn valid_kind(kind: &str) -> bool {
    let chars = kind.chars().count();
    (1..=64).contains(&chars)
        && !kind.starts_with('.')
        && !kind.ends_with('.')
        && !kind.contains("..")
        && kind.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

/// Extra tries after the connection's own busy timeout. A loaded runner can
/// still hand back "database is locked" once that wait has just ended.
const BUSY_TRIES: u32 = 8;

fn with_busy_retry<T>(mut op: impl FnMut() -> Result<T, rusqlite::Error>) -> Result<T, String> {
    let mut busy = 0;
    loop {
        match op() {
            Ok(value) => return Ok(value),
            Err(err) if is_busy(&err) && busy < BUSY_TRIES => {
                busy += 1;
                std::thread::sleep(Duration::from_millis(20 * u64::from(busy)));
            }
            Err(err) => return Err(err.to_string()),
        }
    }
}

fn is_busy(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::DatabaseBusy
                || code.code == rusqlite::ErrorCode::DatabaseLocked
    )
}

fn is_constraint(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

/// A clock far ahead of every row already stored must not wipe them.
fn prune_clock(conn: &Connection, at: i64) -> i64 {
    let newest: Option<i64> = conn
        .query_row("SELECT MAX(at) FROM activity", [], |row| row.get(0))
        .ok()
        .flatten();
    match newest {
        Some(newest) if at > newest.saturating_add(DAY_MS) => newest,
        _ => at,
    }
}

pub fn prune(conn: &Connection, now: i64) -> Result<(), String> {
    let cutoff = now.saturating_sub(RETENTION_MS);
    with_busy_retry(|| {
        conn.execute("DELETE FROM activity WHERE at < ?1", [cutoff])
            .map(|_| ())
    })
}

#[allow(clippy::too_many_arguments)]
pub fn record(
    conn: &Connection,
    kind: &str,
    actor: &Who,
    initiator: &Who,
    project: &str,
    target: &str,
    summary: &str,
    link: &str,
    at: i64,
) -> Result<Entry, String> {
    if !valid_kind(kind) {
        return Err("The activity kind isn't one this log keeps.".into());
    }
    let _ = conn.busy_timeout(Duration::from_secs(5));
    let clock = prune_clock(conn, at);
    prune(conn, clock)?;
    let actor = stored_who(actor);
    let initiator = stored_who(initiator);
    let project = clean_field(project, MAX_FIELD_CHARS);
    let target = clean_field(target, MAX_FIELD_CHARS);
    let summary = clean_summary(summary);
    let link = clean_field(link, MAX_FIELD_CHARS);
    let (actor_role, actor_id, actor_name) = actor.parts();
    let (initiator_role, initiator_id, initiator_name) = initiator.parts();
    let seq = insert(
        conn,
        kind,
        actor_role,
        actor_id,
        actor_name,
        initiator_role,
        initiator_id,
        initiator_name,
        &project,
        &target,
        &summary,
        &link,
        at,
    )?;
    read_seq(conn, seq)
}

#[allow(clippy::too_many_arguments)]
fn insert(
    conn: &Connection,
    kind: &str,
    actor_role: &str,
    actor_id: &str,
    actor_name: &str,
    initiator_role: &str,
    initiator_id: &str,
    initiator_name: &str,
    project: &str,
    target: &str,
    summary: &str,
    link: &str,
    at: i64,
) -> Result<i64, String> {
    let sql = "INSERT INTO activity (
            id, kind, actor_role, actor_id, actor_name,
            initiator_role, initiator_id, initiator_name,
            project, target, summary, link, at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)";
    for _ in 0..2 {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut busy: u32 = 0;
        loop {
            match conn.execute(
                sql,
                params![
                    id,
                    kind,
                    actor_role,
                    actor_id,
                    actor_name,
                    initiator_role,
                    initiator_id,
                    initiator_name,
                    project,
                    target,
                    summary,
                    link,
                    at
                ],
            ) {
                Ok(_) => return Ok(conn.last_insert_rowid()),
                Err(err) if is_busy(&err) && busy < BUSY_TRIES => {
                    busy += 1;
                    std::thread::sleep(Duration::from_millis(20 * u64::from(busy)));
                }
                Err(err) if is_constraint(&err) => break,
                Err(err) => return Err(err.to_string()),
            }
        }
    }
    Err("The activity row could not be written.".into())
}

fn read_seq(conn: &Connection, seq: i64) -> Result<Entry, String> {
    with_busy_retry(|| {
        conn.query_row(
            "SELECT seq, id, kind, actor_role, actor_id, actor_name, initiator_role, initiator_id, initiator_name, project, target, summary, link, at
             FROM activity WHERE seq = ?1",
            [seq],
            from_row,
        )
    })
}

fn who_from(role: String, id: String, name: String) -> Who {
    match role.as_str() {
        "person" => Who::Person,
        "app" => Who::App,
        "first-mate" if !id.is_empty() => Who::FirstMate { id, name },
        "mono" if !id.is_empty() => Who::Mono { id, name },
        "worker" if !id.is_empty() => Who::Worker { id, name },
        _ => Who::App,
    }
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    let actor = who_from(row.get(3)?, row.get(4)?, row.get(5)?);
    let initiator = who_from(row.get(6)?, row.get(7)?, row.get(8)?);
    Ok(Entry {
        seq: row.get(0)?,
        id: row.get(1)?,
        kind: row.get(2)?,
        actor,
        initiator,
        project: row.get(9)?,
        target: row.get(10)?,
        summary: row.get(11)?,
        link: row.get(12)?,
        at: row.get(13)?,
    })
}

/// Records, and if the write fails says nothing. The summary is not logged.
#[allow(clippy::too_many_arguments)]
pub fn note(
    conn: &Connection,
    kind: &str,
    actor: &Who,
    initiator: &Who,
    project: &str,
    target: &str,
    summary: &str,
    link: &str,
    at: i64,
) {
    let _ = record(
        conn, kind, actor, initiator, project, target, summary, link, at,
    );
}

/// Inserts into an existing database that already has the table. Does not
/// create the file, and does not migrate it. A missing file or a locked
/// database is not a failure of the thing that just happened.
#[allow(clippy::too_many_arguments)]
pub fn note_db(
    db: &Path,
    kind: &str,
    actor: &Who,
    initiator: &Who,
    project: &str,
    target: &str,
    summary: &str,
    link: &str,
) {
    if !db.is_file() {
        return;
    }
    let Ok(conn) = Connection::open(db) else {
        return;
    };
    let _ = conn.busy_timeout(Duration::from_secs(5));
    let Ok(ready) = has_table(&conn) else {
        return;
    };
    if !ready {
        return;
    }
    note(
        &conn,
        kind,
        actor,
        initiator,
        project,
        target,
        summary,
        link,
        now_millis(),
    );
}

fn has_table(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity')",
        [],
        |row| row.get(0),
    )
}

fn filled(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn like_pattern(text: &str) -> String {
    let mut out = String::from('%');
    for c in text.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

fn page_limit(limit: Option<u32>) -> usize {
    match limit {
        None | Some(0) => DEFAULT_LIMIT,
        Some(n) => (n as usize).clamp(1, MAX_LIMIT),
    }
}

pub fn list(conn: &Connection, query: &ListQuery, now: i64) -> Result<Page, String> {
    let _ = conn.busy_timeout(Duration::from_secs(5));
    // A clock more than a day ahead of the newest row is not the cut. Opening
    // the screen must not delete the log.
    let now = prune_clock(conn, now);
    // A prune that fails (the file is busy) still lets the screen read.
    if let Err(err) = prune(conn, now) {
        if !err.contains("locked") && !err.contains("busy") {
            return Err(err);
        }
    }
    let limit = page_limit(query.limit);
    let mut sql = String::from(
        "SELECT seq, id, kind, actor_role, actor_id, actor_name, initiator_role, initiator_id, initiator_name, project, target, summary, link, at
         FROM activity WHERE 1 = 1",
    );
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    let mut push = |sql: &mut String, value: rusqlite::types::Value| {
        values.push(value);
        sql.push_str(&format!(" ?{}", values.len()));
    };
    if let Some(project) = filled(query.project.as_deref()) {
        sql.push_str(" AND project =");
        push(&mut sql, project.into());
    }
    if let Some(kind) = filled(query.kind.as_deref()) {
        sql.push_str(" AND kind =");
        push(&mut sql, kind.into());
    }
    if let Some(agent) = filled(query.agent.as_deref()) {
        let pattern = like_pattern(&agent);
        sql.push_str(" AND (actor_id =");
        push(&mut sql, agent.clone().into());
        sql.push_str(" OR initiator_id =");
        push(&mut sql, agent.into());
        for column in ["actor_name", "initiator_name", "actor_id", "initiator_id"] {
            sql.push_str(&format!(" OR {column} LIKE"));
            push(&mut sql, pattern.clone().into());
            sql.push_str(" ESCAPE '\\'");
        }
        sql.push(')');
    }
    if let Some(search) = filled(query.search.as_deref()) {
        let pattern = like_pattern(&search);
        sql.push_str(" AND (");
        let mut first = true;
        for column in [
            "summary",
            "target",
            "project",
            "kind",
            "actor_name",
            "initiator_name",
            "actor_id",
            "initiator_id",
        ] {
            if !first {
                sql.push_str(" OR");
            }
            first = false;
            sql.push_str(&format!(" {column} LIKE"));
            push(&mut sql, pattern.clone().into());
            sql.push_str(" ESCAPE '\\'");
        }
        sql.push(')');
    }
    if let Some(before) = &query.before {
        sql.push_str(" AND (at <");
        push(&mut sql, before.at.into());
        sql.push_str(" OR (at =");
        push(&mut sql, before.at.into());
        sql.push_str(" AND seq <");
        push(&mut sql, before.seq.into());
        sql.push_str("))");
    }
    sql.push_str(" ORDER BY at DESC, seq DESC LIMIT");
    push(&mut sql, ((limit as i64) + 1).into());

    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let has_more = rows.len() > limit;
    let mut entries = rows;
    if has_more {
        entries.truncate(limit);
    }
    let next = has_more.then(|| entries.last().map(cursor_of)).flatten();
    Ok(Page { entries, next })
}

fn cursor_of(entry: &Entry) -> Cursor {
    Cursor {
        at: entry.at,
        seq: entry.seq,
    }
}

const EXPORT_KEYS: &[&str] = &[
    "id",
    "kind",
    "actor_role",
    "actor_id",
    "actor_name",
    "initiator_role",
    "initiator_id",
    "initiator_name",
    "project",
    "target",
    "summary",
    "link",
    "at",
];

/// Every row, oldest first, without the sequence number (that number belongs
/// to this file; an import must not reuse it and collide).
pub fn export_rows(conn: &Connection) -> Result<Vec<Value>, String> {
    let cutoff = prune_clock(conn, now_millis()).saturating_sub(RETENTION_MS);
    let mut statement = conn
        .prepare(
            "SELECT id, kind, actor_role, actor_id, actor_name, initiator_role, initiator_id, initiator_name, project, target, summary, link, at
             FROM activity WHERE at >= ?1 ORDER BY at ASC, seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([cutoff], |row| {
            let mut object = Map::new();
            let id: String = row.get(0)?;
            let kind: String = row.get(1)?;
            let actor_role: String = row.get(2)?;
            let actor_id: String = row.get(3)?;
            let actor_name: String = row.get(4)?;
            let initiator_role: String = row.get(5)?;
            let initiator_id: String = row.get(6)?;
            let initiator_name: String = row.get(7)?;
            let project: String = row.get(8)?;
            let target: String = row.get(9)?;
            let summary: String = row.get(10)?;
            let link: String = row.get(11)?;
            let at: i64 = row.get(12)?;
            let fields = [
                id,
                kind,
                actor_role,
                actor_id,
                actor_name,
                initiator_role,
                initiator_id,
                initiator_name,
                project,
                target,
                summary,
                link,
            ];
            for (key, value) in EXPORT_KEYS.iter().zip(fields) {
                object.insert(
                    (*key).to_string(),
                    Value::String(clean_field(&value, MAX_FIELD_CHARS)),
                );
            }
            object.insert(
                "summary".into(),
                Value::String(clean_summary(&row.get::<_, String>(10)?)),
            );
            object.insert("at".into(), Value::from(at));
            Ok(Value::Object(object))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn string_field(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_string)
}

fn import_id(id: &str) -> bool {
    let chars = id.chars().count();
    (1..=80).contains(&chars)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Adds rows from an export. A row already stored is left as it was. A row
/// that isn't a real entry is skipped. Secrets are removed again.
pub fn import_rows(conn: &Connection, rows: &[Value]) -> Result<usize, String> {
    import_rows_at(conn, rows, now_millis())
}

/// `now` is the clock the caller trusts. Tests pass one that is ahead of the rows.
pub(crate) fn import_rows_at(conn: &Connection, rows: &[Value], now: i64) -> Result<usize, String> {
    let _ = conn.busy_timeout(Duration::from_secs(5));
    // Same cut as the prune. A row older than 90 days is not added and then
    // deleted, or a second import of the same file would add it again.
    let cutoff = prune_clock(conn, now).saturating_sub(RETENTION_MS);
    let mut added = 0;
    for row in rows {
        let Some(row) = row.as_object() else {
            continue;
        };
        let Some(id) = string_field(row, "id") else {
            continue;
        };
        if !import_id(&id) {
            continue;
        }
        let Some(kind) = string_field(row, "kind") else {
            continue;
        };
        if !valid_kind(&kind) {
            continue;
        }
        let Some(at) = row.get("at").and_then(Value::as_i64) else {
            continue;
        };
        if at < 0 || at < cutoff {
            continue;
        }
        let actor_role = clean_field(&string_field(row, "actor_role").unwrap_or_default(), 32);
        let initiator_role =
            clean_field(&string_field(row, "initiator_role").unwrap_or_default(), 32);
        let actor_id = clean_field(
            &string_field(row, "actor_id").unwrap_or_default(),
            MAX_NAME_CHARS,
        );
        let actor_name = clean_field(
            &string_field(row, "actor_name").unwrap_or_default(),
            MAX_NAME_CHARS,
        );
        let initiator_id = clean_field(
            &string_field(row, "initiator_id").unwrap_or_default(),
            MAX_NAME_CHARS,
        );
        let initiator_name = clean_field(
            &string_field(row, "initiator_name").unwrap_or_default(),
            MAX_NAME_CHARS,
        );
        let project = clean_field(
            &string_field(row, "project").unwrap_or_default(),
            MAX_FIELD_CHARS,
        );
        let target = clean_field(
            &string_field(row, "target").unwrap_or_default(),
            MAX_FIELD_CHARS,
        );
        let summary = clean_summary(&string_field(row, "summary").unwrap_or_default());
        let link = clean_field(
            &string_field(row, "link").unwrap_or_default(),
            MAX_FIELD_CHARS,
        );
        if !scrubber().findings(&summary).is_empty() {
            continue;
        }
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO activity (
                    id, kind, actor_role, actor_id, actor_name,
                    initiator_role, initiator_id, initiator_name,
                    project, target, summary, link, at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    id,
                    kind,
                    actor_role,
                    actor_id,
                    actor_name,
                    initiator_role,
                    initiator_id,
                    initiator_name,
                    project,
                    target,
                    summary,
                    link,
                    at
                ],
            )
            .map_err(|e| e.to_string())?;
        added += changed;
    }
    // Re-read the newest row. One this import just added can be the anchor, so a
    // clock ahead of the file cannot delete the rows the cutoff kept.
    prune(conn, prune_clock(conn, now))?;
    Ok(added)
}

/// One row from a Mono's own chat. A blank summary, or a summary or name over
/// 500 characters, is refused. A locked database is not a failure: `note`
/// keeps the caller's work.
#[allow(clippy::too_many_arguments)]
pub fn record_mono_note(
    conn: &Connection,
    kind: &str,
    summary: &str,
    project: &str,
    target: &str,
    actor_id: &str,
    actor_name: &str,
    at: i64,
) -> Result<(), String> {
    if !valid_kind(kind) {
        return Err("The activity kind isn't one this log keeps.".into());
    }
    let summary = summary.trim();
    if summary.is_empty() || summary.chars().count() > MAX_SUMMARY_CHARS {
        return Err("The summary must be text under 500 characters.".into());
    }
    if project.chars().count() > MAX_FIELD_CHARS || target.chars().count() > MAX_FIELD_CHARS {
        return Err("That name is too long.".into());
    }
    if actor_id.trim().is_empty() {
        return Err("Say who did this.".into());
    }
    note(
        conn,
        kind,
        &Who::mono(actor_id, actor_name),
        &Who::person(),
        project,
        target,
        summary,
        "",
        at,
    );
    Ok(())
}

#[tauri::command(async)]
pub fn activity_list(
    store: State<'_, SessionStore>,
    query: Option<ListQuery>,
) -> Result<Page, String> {
    let conn = store.lock_conn()?;
    list(&conn, &query.unwrap_or_default(), now_millis())
}

/// WP-89: a Mono's chat records one activity row. The arguments are the row;
/// the time is the app's clock.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn activity_note(
    store: State<'_, SessionStore>,
    kind: String,
    summary: String,
    project: String,
    target: String,
    actor_id: String,
    actor_name: String,
) -> Result<(), String> {
    let conn = store.lock_conn()?;
    record_mono_note(
        &conn,
        &kind,
        &summary,
        &project,
        &target,
        &actor_id,
        &actor_name,
        now_millis(),
    )
}

#[cfg(test)]
mod tests;
