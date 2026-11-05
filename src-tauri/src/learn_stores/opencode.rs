//! OpenCode 1.x and 2.x transcripts.
//!
//! Translated from backpass (MIT) `src/discovery/adapters/opencode.js`.
//! Copyright (c) 2026 Kun Chen. The licence text is beside the TypeScript port.
//! Rewrite reason: the adapter is JavaScript; Hivra's readers are Rust.
//! A store with neither session table is reported, never read as empty.

use std::collections::{HashMap, HashSet};
use std::path::Path;

#[cfg(test)]
use rusqlite::params_from_iter;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use super::events::LearnEvent;

const SENTINEL: &str = "<!-- backpass:self-session -->";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenSession {
    pub id: String,
    pub path: String,
    pub cwd: String,
    pub git_root: Option<String>,
    pub title: Option<String>,
    pub started_at: Option<i64>,
    pub mtime_ms: i64,
    pub layout: String,
    pub parent_id: Option<String>,
    pub self_session: bool,
}

#[derive(Debug, Clone)]
pub struct OpenRead {
    pub events: Vec<LearnEvent>,
    pub model: Option<String>,
}

#[derive(Debug, Clone)]
struct RawSession {
    id: String,
    directory: String,
    title: Option<String>,
    parent_id: Option<String>,
    time_created: i64,
    mtime_ms: i64,
    worktree: Option<String>,
    layout: String,
    first_user_text: Option<String>,
    recorded: bool,
}

pub fn discover(file: &Path, cutoff_ms: Option<i64>) -> Result<Vec<OpenSession>, String> {
    if !file.is_file() {
        return Ok(Vec::new());
    }
    let conn = open_read_only(file)?;
    let v2 = has_table(&conn, "session_v2") && has_table(&conn, "session_message");
    let v1 = has_table(&conn, "session");
    if !v2 && !v1 {
        return Err("no session or session_v2 table (unrecognised opencode store)".into());
    }
    let mut sessions = list_both(&conn, v1, v2, cutoff_ms, None)?;
    let mut visited: HashSet<String> = sessions.iter().map(|session| session.id.clone()).collect();
    let mut index = 0;
    while index < sessions.len() {
        if let Some(parent) = sessions[index].parent_id.clone() {
            if visited.insert(parent.clone()) {
                sessions.extend(list_both(&conn, v1, v2, None, Some(parent.as_str()))?);
            }
        }
        index += 1;
    }
    let own = self_ids(&sessions);
    let path = file.to_string_lossy().into_owned();
    let mut out = Vec::new();
    for session in sessions {
        let in_window = cutoff_ms
            .map(|cutoff| session.mtime_ms >= cutoff)
            .unwrap_or(true);
        if !session.recorded || !in_window {
            continue;
        }
        out.push(OpenSession {
            id: session.id.clone(),
            path: path.clone(),
            cwd: session.directory,
            git_root: session.worktree.filter(|root| !root.is_empty()),
            title: session.title.filter(|title| !title.is_empty()),
            started_at: if session.time_created == 0 {
                None
            } else {
                Some(session.time_created)
            },
            mtime_ms: session.mtime_ms,
            layout: session.layout,
            parent_id: session.parent_id,
            self_session: own.contains(&session.id),
        });
    }
    Ok(out)
}

pub fn read(file: &Path, session_id: &str, layout: Option<&str>) -> Result<OpenRead, String> {
    if !file.is_file() {
        return Err(format!("opencode store {} not found", file.display()));
    }
    let conn = open_read_only(file)?;
    let layout = match layout {
        Some(layout) if !layout.is_empty() => layout.to_string(),
        _ => layout_of(&conn, session_id),
    };
    if layout == "v2" {
        read_v2(&conn, session_id)
    } else {
        read_v1(&conn, session_id)
    }
}

fn list_both(
    conn: &Connection,
    v1: bool,
    v2: bool,
    cutoff_ms: Option<i64>,
    session_id: Option<&str>,
) -> Result<Vec<RawSession>, String> {
    let mut sessions = Vec::new();
    if v2 {
        sessions.extend(list_v2(conn, cutoff_ms, session_id)?);
    }
    if v1 {
        sessions.extend(list_v1(conn, v2, cutoff_ms, session_id)?);
    }
    Ok(sessions)
}

fn list_v2(
    conn: &Connection,
    cutoff_ms: Option<i64>,
    session_id: Option<&str>,
) -> Result<Vec<RawSession>, String> {
    let filter = if session_id.is_some() {
        "s.id = ?1"
    } else if cutoff_ms.is_some() {
        "(s.time_updated >= ?1 OR s.time_created >= ?1 OR s.id IN (SELECT session_id FROM session_message WHERE time_updated >= ?1))"
    } else {
        "1"
    };
    let sql = format!(
        "SELECT s.id AS id, s.directory AS directory, s.title AS title, s.parent_id AS parent_id,
                s.time_created AS time_created, s.time_updated AS time_updated,
                p.worktree AS worktree,
                EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = s.id
                        AND m.type IN ('user', 'assistant', 'shell', 'skill')) AS recorded,
                (SELECT MAX(m.time_updated) FROM session_message m WHERE m.session_id = s.id) AS message_time,
                (SELECT CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.text') END
                   FROM session_message m
                  WHERE m.session_id = s.id AND m.type = 'user'
                  ORDER BY m.seq LIMIT 1) AS first_user_text
           FROM session_v2 s
           LEFT JOIN project p ON p.id = s.project_id
          WHERE {filter}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let mut rows = Vec::new();
    let collected = if let Some(id) = session_id {
        stmt.query_map([id], map_v2_row)
    } else if let Some(cutoff) = cutoff_ms {
        stmt.query_map([cutoff], map_v2_row)
    } else {
        stmt.query_map([], map_v2_row)
    }
    .map_err(|err| err.to_string())?;
    for row in collected {
        rows.push(row.map_err(|err| err.to_string())?);
    }
    Ok(rows)
}

fn map_v2_row(row: &rusqlite::Row) -> rusqlite::Result<RawSession> {
    let time_updated: i64 = row.get::<_, Option<i64>>("time_updated")?.unwrap_or(0);
    let time_created: i64 = row.get::<_, Option<i64>>("time_created")?.unwrap_or(0);
    let message_time: i64 = row.get::<_, Option<i64>>("message_time")?.unwrap_or(0);
    let max = time_updated.max(message_time);
    let mtime_ms = if max != 0 { max } else { time_created };
    Ok(RawSession {
        id: row.get("id")?,
        directory: row
            .get::<_, Option<String>>("directory")?
            .unwrap_or_default(),
        title: row.get("title")?,
        parent_id: non_empty_opt(row.get("parent_id")?),
        time_created,
        mtime_ms,
        worktree: row.get("worktree")?,
        layout: "v2".into(),
        first_user_text: row.get("first_user_text")?,
        recorded: row.get::<_, i64>("recorded")? != 0,
    })
}

fn list_v1(
    conn: &Connection,
    skip_v2: bool,
    cutoff_ms: Option<i64>,
    session_id: Option<&str>,
) -> Result<Vec<RawSession>, String> {
    let parent_select = if table_has_column(conn, "session", "parent_id") {
        ", s.parent_id AS parent_id"
    } else {
        ""
    };
    let first_user = if has_table(conn, "message") && has_table(conn, "part") {
        ", (SELECT pt.data FROM part pt WHERE pt.message_id = (
              SELECT m.id FROM message m
               WHERE m.session_id = s.id
                 AND CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END = 'user'
               ORDER BY m.time_created, m.id LIMIT 1)
             AND CASE WHEN json_valid(pt.data) THEN json_extract(pt.data, '$.type') END = 'text'
             ORDER BY pt.id LIMIT 1) AS first_user_part"
    } else {
        ""
    };
    let recorded = if has_table(conn, "message") {
        "EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)"
    } else {
        "1"
    };
    let skip = if skip_v2 {
        "s.id NOT IN (SELECT id FROM session_v2) AND"
    } else {
        ""
    };
    let filter = if session_id.is_some() {
        "s.id = ?1"
    } else if cutoff_ms.is_some() {
        "COALESCE(NULLIF(s.time_updated, 0), s.time_created, 0) >= ?1"
    } else {
        "1"
    };
    let sql = format!(
        "SELECT s.id AS id, s.directory AS directory, s.title AS title,
                s.time_created AS time_created, s.time_updated AS time_updated,
                p.worktree AS worktree, {recorded} AS recorded{parent_select}{first_user}
           FROM session s
           LEFT JOIN project p ON p.id = s.project_id
          WHERE {skip} {filter}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let has_parent = !parent_select.is_empty();
    let has_part = !first_user.is_empty();
    let map = |row: &rusqlite::Row| -> rusqlite::Result<RawSession> {
        let time_updated: i64 = row.get::<_, Option<i64>>("time_updated")?.unwrap_or(0);
        let time_created: i64 = row.get::<_, Option<i64>>("time_created")?.unwrap_or(0);
        let part: Option<String> = if has_part {
            row.get("first_user_part")?
        } else {
            None
        };
        let parent: Option<String> = if has_parent {
            row.get("parent_id")?
        } else {
            None
        };
        Ok(RawSession {
            id: row.get("id")?,
            directory: row
                .get::<_, Option<String>>("directory")?
                .unwrap_or_default(),
            title: row.get("title")?,
            parent_id: non_empty_opt(parent),
            time_created,
            mtime_ms: if time_updated != 0 {
                time_updated
            } else {
                time_created
            },
            worktree: row.get("worktree")?,
            layout: "v1".into(),
            first_user_text: part.as_deref().and_then(json_text_field),
            recorded: row.get::<_, i64>("recorded")? != 0,
        })
    };
    let collected = if let Some(id) = session_id {
        stmt.query_map([id], map)
    } else if let Some(cutoff) = cutoff_ms {
        stmt.query_map([cutoff], map)
    } else {
        stmt.query_map([], map)
    }
    .map_err(|err| err.to_string())?;
    let mut rows = Vec::new();
    for row in collected {
        rows.push(row.map_err(|err| err.to_string())?);
    }
    Ok(rows)
}

fn json_text_field(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn self_ids(sessions: &[RawSession]) -> HashSet<String> {
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    let mut queue = Vec::new();
    for session in sessions {
        if session
            .first_user_text
            .as_deref()
            .is_some_and(|text| text.starts_with(SENTINEL))
        {
            queue.push(session.id.clone());
        }
        if let Some(parent) = &session.parent_id {
            children
                .entry(parent.clone())
                .or_default()
                .push(session.id.clone());
        }
    }
    let mut own = HashSet::new();
    while let Some(id) = queue.pop() {
        if !own.insert(id.clone()) {
            continue;
        }
        if let Some(kids) = children.get(&id) {
            queue.extend(kids.iter().cloned());
        }
    }
    own
}

fn layout_of(conn: &Connection, session_id: &str) -> String {
    if !(has_table(conn, "session_v2") && has_table(conn, "session_message")) {
        return "v1".into();
    }
    let found: Result<i64, _> = conn.query_row(
        "SELECT 1 FROM session_v2 WHERE id = ?1",
        [session_id],
        |row| row.get(0),
    );
    if found.is_ok() { "v2" } else { "v1" }.into()
}

fn read_v1(conn: &Connection, session_id: &str) -> Result<OpenRead, String> {
    let mut messages = conn
        .prepare("SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created, id")
        .map_err(|err| err.to_string())?;
    let message_rows = messages
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?;
    let mut message_list = Vec::new();
    for row in message_rows {
        message_list.push(row.map_err(|err| err.to_string())?);
    }
    let mut parts = conn
        .prepare(
            "SELECT message_id, data FROM part WHERE session_id = ?1 ORDER BY time_created, id",
        )
        .map_err(|err| err.to_string())?;
    let part_rows = parts
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?;
    let mut by_message: HashMap<String, Vec<Value>> = HashMap::new();
    for row in part_rows {
        let (message_id, data) = row.map_err(|err| err.to_string())?;
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            by_message.entry(message_id).or_default().push(value);
        }
    }
    let mut events = Vec::new();
    let mut model = None;
    for (id, data) in message_list {
        let data: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        let role = if data.get("role").and_then(Value::as_str) == Some("user") {
            "user"
        } else {
            "assistant"
        };
        if model.is_none() {
            model = data
                .get("modelID")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    data.get("model")
                        .and_then(|model| model.get("modelID"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
        }
        let mut texts = Vec::new();
        let mut has_files = false;
        for part in by_message.get(&id).into_iter().flatten() {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = part
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        texts.push(text.to_string());
                    }
                }
                Some("file") => has_files = true,
                Some("tool") => {
                    let name = part
                        .get("tool")
                        .or_else(|| part.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let state = part.get("state");
                    let input = state
                        .and_then(|state| state.get("input"))
                        .or_else(|| part.get("input"))
                        .cloned();
                    let result = state
                        .and_then(|state| state.get("output"))
                        .or_else(|| part.get("output"))
                        .and_then(value_string);
                    let status = state
                        .and_then(|state| state.get("status"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    events.push(LearnEvent {
                        kind: "tool".into(),
                        role: None,
                        text: None,
                        name: Some(name),
                        input,
                        result,
                        status,
                        pending_id: None,
                    });
                }
                _ => {}
            }
        }
        if role == "user" && has_files && texts.join("\n").trim().is_empty() {
            texts.clear();
            texts.push("[Attachment-only user message]".into());
        }
        if !texts.is_empty() {
            events.push(LearnEvent::message(role, texts.join("\n")));
        }
    }
    Ok(OpenRead { events, model })
}

fn read_v2(conn: &Connection, session_id: &str) -> Result<OpenRead, String> {
    let mut stmt = conn
        .prepare("SELECT type, data FROM session_message WHERE session_id = ?1 ORDER BY seq")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?;
    let mut events = Vec::new();
    let mut background: HashMap<String, usize> = HashMap::new();
    let mut model = None;
    for row in rows {
        let (kind, raw) = row.map_err(|err| err.to_string())?;
        let data: Value = match serde_json::from_str::<Value>(&raw) {
            Ok(value) if value.is_object() => value,
            _ => continue,
        };
        match kind.as_str() {
            "user" => {
                if let Some(text) = data
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                {
                    events.push(LearnEvent::message("user", text.to_string()));
                } else if data
                    .get("files")
                    .and_then(Value::as_array)
                    .is_some_and(|files| !files.is_empty())
                {
                    events.push(LearnEvent::message(
                        "user",
                        "[Attachment-only user message]".into(),
                    ));
                }
            }
            "assistant" => {
                if model.is_none() {
                    model = data
                        .get("model")
                        .and_then(|model| model.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                let mut texts = Vec::new();
                let content = data
                    .get("content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for item in content {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(text) = item
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                        {
                            texts.push(text.to_string());
                        }
                    } else if item.get("type").and_then(Value::as_str) == Some("tool") {
                        if !texts.is_empty() {
                            events.push(LearnEvent::message("assistant", texts.join("\n")));
                            texts.clear();
                        }
                        let call = tool_event(&item);
                        let job = item
                            .get("state")
                            .and_then(|state| state.get("metadata"))
                            .and_then(|meta| meta.get("sessionID").or_else(|| meta.get("shellID")))
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let index = events.len();
                        events.push(call);
                        if let Some(job) = job {
                            background.insert(job, index);
                        }
                    }
                }
                if !texts.is_empty() {
                    events.push(LearnEvent::message("assistant", texts.join("\n")));
                }
            }
            "shell" => {
                let status = shell_status(&data);
                events.push(LearnEvent {
                    kind: "tool".into(),
                    role: None,
                    text: None,
                    name: Some("shell".into()),
                    input: Some(serde_json::json!({ "command": data.get("command").and_then(Value::as_str).unwrap_or("") })),
                    result: data.get("output").and_then(|output| output.get("output")).and_then(value_string),
                    status: Some(status),
                    pending_id: None,
                });
            }
            "skill" => {
                events.push(LearnEvent {
                    kind: "tool".into(),
                    role: None,
                    text: None,
                    name: Some("skill".into()),
                    input: Some(serde_json::json!({ "name": data.get("name").and_then(Value::as_str).unwrap_or("") })),
                    result: None,
                    status: Some("completed".into()),
                    pending_id: None,
                });
            }
            "synthetic" => {
                let job = data
                    .get("metadata")
                    .and_then(|meta| meta.get("childID").or_else(|| meta.get("shellID")))
                    .and_then(Value::as_str);
                if let (Some(job), Some(text)) = (job, data.get("text").and_then(Value::as_str)) {
                    if let Some(index) = background.get(job).copied() {
                        events[index].result = Some(text.to_string());
                        if let Some(state) = data
                            .get("metadata")
                            .and_then(|meta| meta.get("state"))
                            .and_then(Value::as_str)
                        {
                            events[index].status = Some(state.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(OpenRead { events, model })
}

fn tool_event(item: &Value) -> LearnEvent {
    let state = item.get("state").filter(|state| state.is_object());
    let content = state
        .and_then(|state| state.get("content"))
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|entry| entry.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let error = if state
        .and_then(|state| state.get("status"))
        .and_then(Value::as_str)
        == Some("error")
    {
        state
            .and_then(|state| state.get("error"))
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("")
    } else {
        ""
    };
    let result = [error, content.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    LearnEvent {
        kind: "tool".into(),
        role: None,
        text: None,
        name: item.get("name").and_then(Value::as_str).map(str::to_string),
        input: state.and_then(|state| state.get("input")).cloned(),
        result: if result.is_empty() {
            None
        } else {
            Some(result)
        },
        status: state
            .and_then(|state| state.get("status"))
            .and_then(Value::as_str)
            .map(str::to_string),
        pending_id: None,
    }
}

fn shell_status(shell: &Value) -> String {
    let status = shell.get("status").and_then(Value::as_str).unwrap_or("");
    if status != "exited" {
        return status.to_string();
    }
    if shell.get("exit").and_then(Value::as_i64).unwrap_or(0) == 0 {
        "completed".into()
    } else {
        "error".into()
    }
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn non_empty_opt(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
    if table != "session" && table != "session_v2" {
        return false;
    }
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return false;
    };
    let mut names = Vec::new();
    for name in rows.flatten() {
        names.push(name);
    }
    names.iter().any(|name| name == column)
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "The store is busy. Try again.".to_string())
}

/// Build a store from a golden fixture. Foreign keys stay off, matching Node's loader.
#[cfg(test)]
pub fn write_fixture(file: &Path, fixture: &Value, skip_tables: &[&str]) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "Couldn't write the fixture store.".to_string())?;
    }
    let conn = Connection::open(file).map_err(|err| err.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|err| err.to_string())?;
    let schema = fixture
        .get("schema")
        .and_then(Value::as_array)
        .ok_or_else(|| "The fixture has no schema.".to_string())?;
    for statement in schema {
        let Some(sql) = statement.as_str() else {
            continue;
        };
        if let Some(table) = create_table_name(sql) {
            if skip_tables.contains(&table) {
                continue;
            }
        }
        conn.execute_batch(sql).map_err(|err| err.to_string())?;
    }
    let Some(rows) = fixture.get("rows").and_then(Value::as_object) else {
        return Ok(());
    };
    for (table, body) in rows {
        if skip_tables.contains(&table.as_str()) {
            continue;
        }
        if !valid_ident(table) {
            return Err("The fixture names a table that isn't safe.".into());
        }
        let Some(records) = body.as_array() else {
            continue;
        };
        for record in records {
            let Some(record) = record.as_object() else {
                continue;
            };
            let mut columns = Vec::new();
            let mut values = Vec::new();
            for (column, value) in record {
                if !valid_ident(column) {
                    return Err("The fixture names a column that isn't safe.".into());
                }
                columns.push(column.clone());
                values.push(sql_value(value));
            }
            if columns.is_empty() {
                continue;
            }
            let placeholders = vec!["?"; columns.len()].join(", ");
            let sql = format!(
                "INSERT INTO `{table}` ({}) VALUES ({placeholders})",
                columns
                    .iter()
                    .map(|column| format!("`{column}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            conn.execute(&sql, params_from_iter(values.iter()))
                .map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
fn create_table_name(sql: &str) -> Option<&str> {
    let rest = sql.trim_start().strip_prefix("CREATE TABLE `")?;
    let end = rest.find('`')?;
    Some(&rest[..end])
}

#[cfg(test)]
fn valid_ident(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

#[cfg(test)]
fn sql_value(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(flag) => rusqlite::types::Value::Integer(if *flag { 1 } else { 0 }),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                rusqlite::types::Value::Integer(integer)
            } else if let Some(unsigned) = number.as_u64() {
                rusqlite::types::Value::Integer(unsigned as i64)
            } else {
                rusqlite::types::Value::Real(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(text) => rusqlite::types::Value::Text(text.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}
