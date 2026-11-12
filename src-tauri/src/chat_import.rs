//! Onboarding: bring a person's past Claude Code and Codex chats in as the app's own projects and chats.
//!
//! Read-only on `~/.claude` and `~/.codex`. The roots are the same ones WP-50 reads (`history_import::confirm_root`),
//! a symlink is never followed, a chat still being written is left out, and a path outside the root is refused.
//! Nothing here has a file count cap: the index is paged, newest first, and only the first lines of each file on a
//! page are read. A whole chat is read line by line and only its prose comes back (tool calls, tool output, thinking
//! and images stay on disk), so a chat of any size streams instead of being loaded whole.
//!
//! A dev copy never reads the real stores: it reads only the stand-in home a test names in
//! `MONOCODE_CHAT_IMPORT_HOME`, and without one it sees nothing.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::history_import::{confirm_root, is_active, is_jsonl, mtime_ms, ACTIVE};

/// The most a header read takes from one file while indexing.
pub const HEADER_CAP: u64 = 64 * 1024;
/// One line longer than this is a tool dump, never prose worth keeping: the rest of it is skipped unread.
pub const LINE_CAP: usize = 4 * 1024 * 1024;
/// The most prose one chat brings back. A longer chat keeps its first part and says it was cut.
pub const OUT_CAP: usize = 16 * 1024 * 1024;
/// The most rows one index page holds.
pub const PAGE_MAX: usize = 1000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexedChat {
    /// Relative to the root, with forward slashes.
    pub path: String,
    pub bytes: u64,
    pub mtime_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The first timestamp in the file, in Unix ms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_ms: Option<u64>,
    /// A title the tool itself saved (Claude's custom title or summary). Never message text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexPage {
    /// The folder isn't there: this tool was never used here.
    pub missing: bool,
    /// Chat files in the whole folder (after the left-outs below).
    pub total: usize,
    pub offset: usize,
    pub chats: Vec<IndexedChat>,
    /// Still being written in the last few minutes: left out this time.
    pub active: usize,
    /// Symlinks: never followed.
    pub links: usize,
    /// Another agent's side trace (Claude's subagents): not a chat of the person's.
    pub side: usize,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProseRead {
    /// JSON lines in the tool's own shape, with only what the chat readers use.
    pub text: String,
    /// The chat was longer than [`OUT_CAP`] and its tail was left out.
    pub cut: bool,
    /// Lines over [`LINE_CAP`] that were skipped.
    pub long_lines: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub exists: bool,
    /// For a git worktree, the main checkout it belongs to. For a checkout, itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
}

// ---- the stores --------------------------------------------------------------------------------------------------

fn source_ok(source: &str) -> Result<(), String> {
    match source {
        "claude_code" | "codex" => Ok(()),
        _ => Err("Only Claude Code and Codex chats can be brought in so far.".into()),
    }
}

/// The home whose stores this copy reads, or `None` when it must read nothing.
fn store_home() -> Option<PathBuf> {
    if crate::instance::kind() == crate::instance::Kind::Dev {
        return std::env::var("MONOCODE_CHAT_IMPORT_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
    }
    crate::dirs_home().map(PathBuf::from)
}

/// The folders each source keeps its chats in under `home`.
pub fn roots_in(home: &Path) -> Value {
    json!({
        "claudeCode": [crate::fs::path_to_js(&home.join(".claude").join("projects"))],
        "codex": [
            crate::fs::path_to_js(&home.join(".codex").join("sessions")),
            crate::fs::path_to_js(&home.join(".codex").join("archived_sessions")),
        ],
    })
}

// ---- the index ---------------------------------------------------------------------------------------------------

struct Found {
    rel: String,
    full: PathBuf,
    bytes: u64,
    mtime_ms: u64,
}

fn is_side_trace(rel: &Path) -> bool {
    rel.components()
        .any(|part| matches!(part, Component::Normal(name) if name == "subagents"))
}

fn walk(
    root: &Path,
    dir: &Path,
    now: SystemTime,
    active: Duration,
    found: &mut Vec<Found>,
    page: &mut IndexPage,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if entry.file_name() == "node_modules" {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            page.links += 1;
            continue;
        }
        if kind.is_dir() {
            walk(root, &path, now, active, found, page);
            continue;
        }
        if !kind.is_file() || !is_jsonl(&path) {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        if is_side_trace(rel) {
            page.side += 1;
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if is_active(&meta, now, active) {
            page.active += 1;
            continue;
        }
        found.push(Found {
            rel: crate::fs::path_to_js(rel),
            full: path.clone(),
            bytes: meta.len(),
            mtime_ms: mtime_ms(&meta),
        });
    }
}

fn parse_ms(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(n) => {
            let raw = n.as_f64()?;
            if !raw.is_finite() || raw < 0.0 {
                return None;
            }
            Some(if raw > 1e12 {
                raw as u64
            } else {
                (raw * 1000.0) as u64
            })
        }
        Value::String(text) => {
            time::OffsetDateTime::parse(text.trim(), &time::format_description::well_known::Rfc3339)
                .ok()
                .and_then(|at| u64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok())
        }
        _ => None,
    }
}

fn text_of(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(200).collect())
}

/// Reads lines from the start of a file until it knows the folder, the id and the first time, or hits [`HEADER_CAP`].
fn header_of(
    source: &str,
    path: &Path,
) -> (Option<String>, Option<String>, Option<u64>, Option<String>) {
    let (mut cwd, mut id, mut first, mut title) = (None, None, None, None);
    let Ok(file) = File::open(path) else {
        return (cwd, id, first, title);
    };
    let mut reader = BufReader::new(file.take(HEADER_CAP));
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(row) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if source == "codex" {
            if row.get("type").and_then(Value::as_str) == Some("session_meta") {
                let payload = row.get("payload");
                cwd = cwd.or_else(|| text_of(payload.and_then(|p| p.get("cwd"))));
                id = id.or_else(|| {
                    text_of(payload.and_then(|p| p.get("id").or_else(|| p.get("session_id"))))
                });
                first = first.or_else(|| parse_ms(payload.and_then(|p| p.get("timestamp"))));
            }
            first = first.or_else(|| parse_ms(row.get("timestamp")));
        } else {
            if row.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            match row.get("type").and_then(Value::as_str) {
                Some("custom-title") => title = text_of(row.get("customTitle")).or(title),
                Some("summary") => title = title.or_else(|| text_of(row.get("summary"))),
                _ => {}
            }
            cwd = cwd.or_else(|| text_of(row.get("cwd")));
            id = id.or_else(|| text_of(row.get("sessionId")));
            first = first.or_else(|| parse_ms(row.get("timestamp")));
        }
        if cwd.is_some()
            && id.is_some()
            && first.is_some()
            && (source == "codex" || title.is_some())
        {
            break;
        }
    }
    (cwd, id, first, title)
}

/// One page of a store's chat files, newest first. Every call walks the folder again (names and sizes only), so the
/// pages agree on order without the app holding a list between calls.
pub fn index_root(
    root: &Path,
    source: &str,
    offset: usize,
    limit: usize,
    now: SystemTime,
    active: Duration,
) -> IndexPage {
    let mut page = IndexPage {
        offset,
        ..IndexPage::default()
    };
    let Ok(root) = crate::fs::canonical(root) else {
        page.missing = true;
        page.done = true;
        return page;
    };
    if !root.is_dir() {
        page.missing = true;
        page.done = true;
        return page;
    }
    let mut found = Vec::new();
    walk(&root, &root, now, active, &mut found, &mut page);
    found.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms).then_with(|| a.rel.cmp(&b.rel)));
    page.total = found.len();
    let limit = limit.clamp(1, PAGE_MAX);
    let end = offset.saturating_add(limit).min(found.len());
    for item in found.get(offset..end).unwrap_or(&[]) {
        let (cwd, session_id, first_ms, title) = header_of(source, &item.full);
        page.chats.push(IndexedChat {
            path: item.rel.clone(),
            bytes: item.bytes,
            mtime_ms: item.mtime_ms,
            cwd,
            session_id,
            first_ms,
            title,
        });
    }
    page.done = end >= found.len();
    page
}

// ---- reading one chat ----------------------------------------------------------------------------------------------

/// Reads one line into `buf`, up to [`LINE_CAP`]. A longer line is drained to its end and reported as too long.
fn next_line<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<Option<bool>> {
    buf.clear();
    let mut too_long = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if available.is_empty() {
            return Ok(if buf.is_empty() && !too_long {
                None
            } else {
                Some(too_long)
            });
        }
        let (take, ends) = match available.iter().position(|byte| *byte == b'\n') {
            Some(at) => (at + 1, true),
            None => (available.len(), false),
        };
        if !too_long {
            if buf.len() + take > LINE_CAP {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&available[..take]);
            }
        }
        reader.consume(take);
        if ends {
            return Ok(Some(too_long));
        }
    }
}

const CLAUDE_KEEP_BLOCKS: [&str; 1] = ["text"];

/// A Claude line with only what `claude.ts` reads. Tool calls, tool output, thinking and images are dropped.
fn claude_prose(row: &Value) -> Option<Value> {
    let kind = row.get("type").and_then(Value::as_str);
    let mut out = Map::new();
    for key in [
        "type",
        "sessionId",
        "cwd",
        "timestamp",
        "isMeta",
        "isSidechain",
        "isCompactSummary",
        "isApiErrorMessage",
        "entrypoint",
    ] {
        if let Some(value) = row.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if kind == Some("custom-title") {
        out.insert("customTitle".into(), row.get("customTitle")?.clone());
        return Some(Value::Object(out));
    }
    let message = row.get("message")?;
    let role = message.get("role")?.as_str()?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let content = match message.get("content")? {
        Value::String(text) => Value::String(text.clone()),
        Value::Array(blocks) => {
            let kept: Vec<Value> = blocks
                .iter()
                .filter(|block| {
                    block.as_str().is_some()
                        || block
                            .get("type")
                            .and_then(Value::as_str)
                            .is_some_and(|kind| CLAUDE_KEEP_BLOCKS.contains(&kind))
                })
                .map(|block| match block.get("text") {
                    Some(text) => json!({ "type": "text", "text": text }),
                    None => block.clone(),
                })
                .collect();
            if kept.is_empty() {
                // Keep the folder and id a tool-only line carries, with no content.
                if out.contains_key("cwd") || out.contains_key("sessionId") {
                    out.remove("timestamp");
                    return Some(Value::Object(out));
                }
                return None;
            }
            Value::Array(kept)
        }
        _ => return None,
    };
    out.insert(
        "message".into(),
        json!({ "role": role, "content": content }),
    );
    Some(Value::Object(out))
}

/// A Codex line with only what `codex.ts` reads: the session's id and folder, and the person's and the agent's words.
fn codex_prose(row: &Value) -> Option<Value> {
    let payload = row.get("payload")?;
    match row.get("type").and_then(Value::as_str)? {
        "session_meta" => {
            let mut body = Map::new();
            for key in ["id", "session_id", "cwd", "timestamp", "originator"] {
                if let Some(value) = payload.get(key) {
                    body.insert(key.into(), value.clone());
                }
            }
            Some(
                json!({ "type": "session_meta", "timestamp": row.get("timestamp"), "payload": body }),
            )
        }
        "event_msg" => {
            let kind = payload.get("type").and_then(Value::as_str)?;
            if kind != "user_message" && kind != "agent_message" {
                return None;
            }
            let mut body = Map::new();
            for key in ["type", "message", "phase"] {
                if let Some(value) = payload.get(key) {
                    body.insert(key.into(), value.clone());
                }
            }
            Some(json!({ "type": "event_msg", "timestamp": row.get("timestamp"), "payload": body }))
        }
        _ => None,
    }
}

/// The prose of one chat file, streamed. The caller has already checked `path` is inside the root.
pub fn read_prose(path: &Path, source: &str) -> Result<ProseRead, String> {
    let file = File::open(path).map_err(|_| "Could not read this chat.".to_string())?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buf = Vec::new();
    let mut out = String::new();
    let mut long_lines = 0;
    let mut cut = false;
    while let Some(too_long) =
        next_line(&mut reader, &mut buf).map_err(|_| "Could not read this chat.".to_string())?
    {
        if too_long {
            long_lines += 1;
            continue;
        }
        let Ok(row) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        let kept = if source == "codex" {
            codex_prose(&row)
        } else {
            claude_prose(&row)
        };
        let Some(kept) = kept else {
            continue;
        };
        let line = kept.to_string();
        if out.len() + line.len() + 1 > OUT_CAP {
            cut = true;
            break;
        }
        out.push_str(&line);
        out.push('\n');
    }
    Ok(ProseRead {
        text: out,
        cut,
        long_lines,
    })
}

/// `rel` inside `root`: relative, no `..`, a `.jsonl` file, never a symlink, and still inside after resolving.
fn checked_file(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel.is_empty()
        || rel_path.is_absolute()
        || rel_path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
        || !is_jsonl(rel_path)
    {
        return Err("That file isn't in the folder.".into());
    }
    let root =
        crate::fs::canonical(root).map_err(|_| "That folder isn't on this Mac.".to_string())?;
    let joined = root.join(rel_path);
    let meta =
        fs::symlink_metadata(&joined).map_err(|_| "That file isn't in the folder.".to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("That file isn't in the folder.".into());
    }
    let full =
        crate::fs::canonical(&joined).map_err(|_| "That file isn't in the folder.".to_string())?;
    if !full.starts_with(&root) {
        return Err("That file isn't in the folder.".into());
    }
    Ok(full)
}

// ---- folders -------------------------------------------------------------------------------------------------------

/// The main checkout a worktree's `.git` file points at (`gitdir: <repo>/.git/worktrees/<name>`).
fn main_checkout(folder: &Path) -> Option<PathBuf> {
    let dot_git = folder.join(".git");
    let meta = fs::symlink_metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some(folder.to_path_buf());
    }
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    let text = fs::read_to_string(&dot_git).ok()?;
    let gitdir = text
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))?
        .trim();
    let gitdir = if Path::new(gitdir).is_absolute() {
        PathBuf::from(gitdir)
    } else {
        folder.join(gitdir)
    };
    let mut parts: Vec<_> = gitdir.components().collect();
    // .../<repo>/.git/worktrees/<name>
    if parts.len() >= 3 {
        let n = parts.len();
        if parts[n - 2].as_os_str() == "worktrees" && parts[n - 3].as_os_str() == ".git" {
            parts.truncate(n - 3);
            let repo: PathBuf = parts.iter().collect();
            return repo.is_dir().then_some(repo);
        }
    }
    None
}

pub fn folder_info(path: &str) -> FolderInfo {
    let folder = Path::new(path);
    let exists = folder.is_absolute() && folder.is_dir();
    let repo_root = if exists {
        main_checkout(folder).map(|repo| crate::fs::path_to_js(&repo))
    } else {
        None
    };
    FolderInfo {
        path: path.to_string(),
        exists,
        repo_root,
    }
}

// ---- commands ------------------------------------------------------------------------------------------------------

fn checked_root(home: &Path, root: &str, source: &str) -> Result<PathBuf, String> {
    source_ok(source)?;
    let root = PathBuf::from(root);
    confirm_root(home, None, cfg!(windows), None, &root, source)?;
    Ok(root)
}

/// Where this copy's Claude Code and Codex keep their chats. Empty lists in a dev copy with no stand-in.
#[tauri::command]
pub fn chat_import_roots() -> Value {
    match store_home() {
        Some(home) => roots_in(&home),
        None => json!({ "claudeCode": [], "codex": [] }),
    }
}

/// One page of a store's chats, newest first, with each chat's folder and id from its first lines.
#[tauri::command(async)]
pub fn chat_import_index(
    root: String,
    source: String,
    offset: usize,
    limit: usize,
) -> Result<IndexPage, String> {
    let home = store_home().ok_or_else(|| "This copy reads no chat folders.".to_string())?;
    let root = checked_root(&home, &root, &source)?;
    Ok(index_root(
        &root,
        &source,
        offset,
        limit,
        SystemTime::now(),
        ACTIVE,
    ))
}

/// The prose of one chat, streamed from disk.
#[tauri::command(async)]
pub fn chat_import_read(root: String, source: String, path: String) -> Result<ProseRead, String> {
    let home = store_home().ok_or_else(|| "This copy reads no chat folders.".to_string())?;
    let root = checked_root(&home, &root, &source)?;
    let full = checked_file(&root, &path)?;
    read_prose(&full, &source)
}

/// Whether each folder is still there, and which checkout a worktree belongs to.
#[tauri::command(async)]
pub fn chat_import_folders(paths: Vec<String>) -> Vec<FolderInfo> {
    paths
        .iter()
        .take(20_000)
        .map(|path| folder_info(path))
        .collect()
}

#[cfg(test)]
mod tests;
