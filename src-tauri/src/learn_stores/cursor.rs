//! Cursor CLI and the opt-in Cursor IDE reader.
//!
//! Translated from backpass (MIT) `src/discovery/adapters/cursor-cli.js` and
//! `cursor-ide.js`. Copyright (c) 2026 Kun Chen.
//! Rewrite reason: the adapters are JavaScript; Hivra's readers are Rust.
//! The directory name is MD5 of the cwd. See `md5.rs` for why that digest is local.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use super::events::LearnEvent;
use super::md5::md5_hex;

pub fn cwd_hash(cwd: &str) -> String {
    md5_hex(cwd.as_bytes())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorDescriptor {
    pub id: String,
    pub cwd: String,
    pub title: Option<String>,
}

pub fn classify_dir(dir: &Path) -> Option<CursorDescriptor> {
    let meta = fs::read_to_string(dir.join("meta.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
    let cwd = meta
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty())?;
    let id = dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string();
    let title = meta
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .map(str::to_string);
    Some(CursorDescriptor {
        id,
        cwd: cwd.to_string(),
        title,
    })
}

/// Blobs that are not JSON `{role, content}` are skipped. Order is rowid.
pub fn read_db(db: &Path) -> Result<Vec<LearnEvent>, String> {
    if !db.is_file() {
        return Ok(Vec::new());
    }
    let conn = open_read_only(db)?;
    let mut stmt = conn
        .prepare("SELECT data FROM blobs ORDER BY rowid")
        .map_err(|_| "Couldn't read this Cursor chat.".to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|_| "Couldn't read this Cursor chat.".to_string())?;
    let mut events = Vec::new();
    for row in rows {
        let data = row.map_err(|_| "Couldn't read this Cursor chat.".to_string())?;
        let text = String::from_utf8_lossy(&data);
        let text = text.trim();
        if !text.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        let Some(role) = value.get("role").and_then(Value::as_str) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        push_content(
            role,
            value.get("content").unwrap_or(&Value::Null),
            &mut events,
        );
    }
    Ok(events)
}

fn push_content(role: &str, content: &Value, events: &mut Vec<LearnEvent>) {
    if let Some(text) = content.as_str() {
        if !text.trim().is_empty() {
            events.push(LearnEvent::message(role, text.to_string()));
        }
        return;
    }
    let Some(blocks) = content.as_array() else {
        return;
    };
    let texts: Vec<&str> = blocks
        .iter()
        .filter_map(|block| {
            block
                .as_str()
                .or_else(|| block.get("text").and_then(Value::as_str))
                .filter(|text| !text.trim().is_empty())
        })
        .collect();
    if !texts.is_empty() {
        events.push(LearnEvent::message(role, texts.join("\n")));
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorIdeSession {
    pub id: String,
    pub cwd: String,
    pub mtime_ms: i64,
}

/// No workspace folder means the composer is skipped. A missing table is empty, not a failure.
pub fn discover_ide(
    user_dir: &Path,
    cutoff_ms: Option<i64>,
) -> Result<Vec<CursorIdeSession>, String> {
    let db_path = user_dir.join("globalStorage").join("state.vscdb");
    if !db_path.is_file() {
        return Ok(Vec::new());
    }
    let conn = open_read_only(&db_path)?;
    let headers = match conn.prepare("SELECT composerId, workspaceId FROM composerHeaders") {
        Ok(mut stmt) => {
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|_| "Couldn't read Cursor.".to_string())?;
            let mut headers = Vec::new();
            for row in rows {
                headers.push(row.map_err(|_| "Couldn't read Cursor.".to_string())?);
            }
            headers
        }
        Err(_) => return Ok(Vec::new()),
    };
    let folders = workspace_folders(&user_dir.join("workspaceStorage"));
    let mut out = Vec::new();
    for (composer_id, workspace_id) in headers {
        let Some(workspace_id) = workspace_id.filter(|id| !id.is_empty()) else {
            continue;
        };
        let Some(cwd) = folders.get(&workspace_id) else {
            continue;
        };
        let key = format!("composerData:{composer_id}");
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key = ?1",
                [&key],
                |row| row.get(0),
            )
            .ok();
        let data = raw.and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let updated = data
            .as_ref()
            .and_then(|value| {
                value
                    .get("lastUpdatedAt")
                    .or_else(|| value.get("createdAt"))
            })
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if let Some(cutoff) = cutoff_ms {
            if updated != 0 && updated < cutoff {
                continue;
            }
        }
        out.push(CursorIdeSession {
            id: composer_id,
            cwd: cwd.clone(),
            mtime_ms: updated,
        });
    }
    Ok(out)
}

pub fn read_ide(user_dir: &Path, composer_id: &str) -> Result<Vec<LearnEvent>, String> {
    let db_path = user_dir.join("globalStorage").join("state.vscdb");
    if !db_path.is_file() {
        return Ok(Vec::new());
    }
    let conn = open_read_only(&db_path)?;
    let like = format!("bubbleId:{composer_id}:%");
    let mut stmt = conn
        .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ?1 ORDER BY key")
        .map_err(|_| "Couldn't read Cursor.".to_string())?;
    let rows = stmt
        .query_map([&like], |row| row.get::<_, String>(0))
        .map_err(|_| "Couldn't read Cursor.".to_string())?;
    let mut events = Vec::new();
    for row in rows {
        let text = row.map_err(|_| "Couldn't read Cursor.".to_string())?;
        let Ok(bubble) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let role = if bubble.get("type").and_then(Value::as_i64) == Some(1) {
            "user"
        } else {
            "assistant"
        };
        let body = bubble
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .or_else(|| {
                bubble
                    .get("richText")
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
            });
        if let Some(body) = body {
            events.push(LearnEvent::message(role, body.to_string()));
        }
    }
    Ok(events)
}

fn workspace_folders(dir: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return map;
    };
    for entry in entries.flatten() {
        let file_type = entry.file_type().ok();
        if file_type.map(|kind| kind.is_symlink()).unwrap_or(true) {
            continue;
        }
        if !file_type.map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let meta = fs::read_to_string(entry.path().join("workspace.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let Some(folder) = meta
            .as_ref()
            .and_then(|value| value.get("folder"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        map.insert(name, decode_file_uri(folder));
    }
    map
}

fn decode_file_uri(folder: &str) -> String {
    let stripped = folder.strip_prefix("file://").unwrap_or(folder);
    percent_decode(stripped).unwrap_or_else(|_| stripped.to_string())
}

fn percent_decode(input: &str) -> Result<String, ()> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(|_| ())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| ())?);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).map_err(|_| ())
}

pub fn ide_user_dir(home: &Path) -> PathBuf {
    if cfg!(windows) {
        home.join("AppData")
            .join("Roaming")
            .join("Cursor")
            .join("User")
    } else if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Cursor")
            .join("User")
    } else {
        home.join(".config").join("Cursor").join("User")
    }
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Couldn't read this store.".to_string())
}
