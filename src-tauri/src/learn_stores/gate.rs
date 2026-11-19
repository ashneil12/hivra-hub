//! Which transcripts a copy may read.
//!
//! A dev copy reads only stand-ins a test names, never the real stores.
//! A symlink is not followed. A file over WP-50's cap is not read.
//! Claude, Codex and Hermes bytes go through WP-50's reader after that check.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::cursor::{self, ide_user_dir};
use super::events::LearnEvent;
use super::grok;
use super::opencode;
use super::pi;
use crate::history_import::{self, MAX_FILES, MAX_READ_BYTES};

#[derive(Clone, Copy)]
pub struct Limits {
    pub max_read: u64,
    pub max_files: usize,
}

impl Limits {
    pub fn production() -> Self {
        Self {
            max_read: MAX_READ_BYTES,
            max_files: MAX_FILES,
        }
    }
}

/// Where Hermes lives. Passed in so a test can name `HERMES_HOME` or the Windows
/// folder without changing the process environment.
#[derive(Clone, Copy)]
pub struct StoreLocate<'a> {
    pub hermes_env: Option<&'a str>,
    pub windows: bool,
    pub local_app_data: Option<&'a str>,
}

impl StoreLocate<'static> {
    #[cfg(test)]
    pub fn unix() -> Self {
        Self {
            hermes_env: None,
            windows: false,
            local_app_data: None,
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandIn {
    pub source: String,
    pub root: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListedChat {
    pub source: String,
    pub id: String,
    pub root: String,
    pub rel: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub mtime_ms: i64,
    /// Size of the backing file. OpenCode rows share one database, so a cost
    /// estimate has to count that file once.
    pub bytes: u64,
}

/// What a listing left out, so a person is told rather than shown a quiet bias.
#[derive(Debug, Default, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListStats {
    /// Chats older than the newest `max_files`, not listed.
    pub left_out: usize,
    /// Chats whose file is over the read cap. One of them never fails the listing.
    pub too_big: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub chats: Vec<ListedChat>,
    pub left_out: usize,
    pub too_big: usize,
}

#[cfg(test)]
pub fn list_stores(
    home: &Path,
    stand_ins: Option<&[StandIn]>,
    include_cursor_ide: bool,
    dev: bool,
    limits: Limits,
) -> Result<Vec<ListedChat>, String> {
    list_located(
        home,
        stand_ins,
        include_cursor_ide,
        dev,
        limits,
        &StoreLocate::unix(),
    )
}

#[cfg(test)]
pub fn list_located(
    home: &Path,
    stand_ins: Option<&[StandIn]>,
    include_cursor_ide: bool,
    dev: bool,
    limits: Limits,
    locate: &StoreLocate<'_>,
) -> Result<Vec<ListedChat>, String> {
    list_report(home, stand_ins, include_cursor_ide, dev, limits, locate).map(|found| found.chats)
}

/// The newest `max_files` chats across every store, newest first, with a count of what
/// was left out. Each store is read whole and sorted by modified time before any cap, so
/// the cap never keeps the first names in the folder and drops the recent work.
pub fn list_report(
    home: &Path,
    stand_ins: Option<&[StandIn]>,
    include_cursor_ide: bool,
    dev: bool,
    limits: Limits,
    locate: &StoreLocate<'_>,
) -> Result<Listing, String> {
    let mut stats = ListStats::default();
    let mut chats = list_all(
        home,
        stand_ins,
        include_cursor_ide,
        dev,
        limits,
        locate,
        &mut stats,
    )?;
    chats.sort_by(|a, b| {
        b.mtime_ms
            .cmp(&a.mtime_ms)
            .then_with(|| a.root.cmp(&b.root))
            .then_with(|| a.rel.cmp(&b.rel))
    });
    if chats.len() > limits.max_files {
        stats.left_out += chats.len() - limits.max_files;
        chats.truncate(limits.max_files);
    }
    Ok(Listing {
        chats,
        left_out: stats.left_out,
        too_big: stats.too_big,
    })
}

fn list_all(
    home: &Path,
    stand_ins: Option<&[StandIn]>,
    include_cursor_ide: bool,
    dev: bool,
    limits: Limits,
    locate: &StoreLocate<'_>,
    stats: &mut ListStats,
) -> Result<Vec<ListedChat>, String> {
    if dev {
        let Some(stand_ins) = stand_ins.filter(|items| !items.is_empty()) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for stand_in in stand_ins {
            let root = PathBuf::from(&stand_in.root);
            if refuses_stand_in(home, &root, locate) {
                return Err("A dev copy only reads transcript stand-ins a test names.".into());
            }
            if is_symlink(&root) {
                return Err("That folder is a link, so it was not read.".into());
            }
            if root
                .components()
                .any(|component| matches!(component, Component::ParentDir))
            {
                return Err("That path is not inside the named folder.".into());
            }
            list_one(
                &stand_in.source,
                &root,
                include_cursor_ide || stand_in.source == "cursor-ide",
                limits,
                &mut out,
                stats,
            )?;
        }
        return Ok(out);
    }
    let mut out = Vec::new();
    for (source, root) in daily_roots(home, include_cursor_ide, locate) {
        if is_symlink(&root) || !root.exists() {
            continue;
        }
        list_one(&source, &root, include_cursor_ide, limits, &mut out, stats)?;
    }
    Ok(out)
}

pub fn read_store(source: &str, root: &Path, rel: &str, limits: Limits) -> Result<String, String> {
    if rel.contains('\0')
        || Path::new(rel).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
        || Path::new(rel).is_absolute()
    {
        return Err("That file isn't in the folder.".into());
    }
    if is_symlink(root) {
        return Err("That folder is a link, so it was not read.".into());
    }
    match source {
        "opencode" => {
            let db = if root.is_file() {
                root.to_path_buf()
            } else {
                root.join(rel)
            };
            let session = if root.is_file() { rel } else { "" };
            ensure_inside(root, &db)?;
            ensure_size(&db, limits.max_read)?;
            let read = if session.is_empty() {
                return Err("That chat wasn't found.".into());
            } else {
                opencode::read(&db, session, None)?
            };
            let mut text = render(&read.events);
            if let Some(model) = read
                .model
                .as_deref()
                .filter(|model| !model.is_empty() && !model.contains('\0'))
            {
                text.insert_str(0, &format!("model: {model}\n"));
            }
            Ok(text)
        }
        "cursor-ide" => {
            if !include_cursor_rel(rel) {
                return Err("That chat wasn't found.".into());
            }
            let db = root.join("globalStorage").join("state.vscdb");
            ensure_inside(root, &db)?;
            ensure_size(&db, limits.max_read)?;
            let events = cursor::read_ide(root, rel)?;
            Ok(render(&events))
        }
        "cursor" => {
            let path = joined(root, rel)?;
            ensure_size(&path, limits.max_read)?;
            Ok(render(&cursor::read_db(&path)?))
        }
        "grok" | "pi" => {
            let path = joined(root, rel)?;
            let text = read_bytes(&path, limits.max_read)?;
            let (events, _) = if source == "grok" {
                grok::read_text(&text)
            } else {
                pi::read_text(&text)
            };
            Ok(render(&events))
        }
        "claude" | "codex" | "hermes" => {
            let path = joined(root, rel)?;
            ensure_size(&path, limits.max_read)?;
            history_import::read_transcript(root, rel, limits.max_read)
        }
        _ => Err("That store isn't one Hivra reads.".into()),
    }
}

fn include_cursor_rel(rel: &str) -> bool {
    !rel.is_empty() && !rel.contains('/') && !rel.contains('\\')
}

fn list_one(
    source: &str,
    root: &Path,
    include_cursor_ide: bool,
    limits: Limits,
    out: &mut Vec<ListedChat>,
    stats: &mut ListStats,
) -> Result<(), String> {
    match source {
        "opencode" => {
            let db = if root.is_file() {
                root.to_path_buf()
            } else {
                root.join("opencode.db")
            };
            if !db.is_file() || is_symlink(&db) {
                return Ok(());
            }
            let meta =
                fs::symlink_metadata(&db).map_err(|_| "Couldn't read this store.".to_string())?;
            if meta.len() > limits.max_read {
                // One database too big to read must not fail the whole listing.
                stats.too_big += 1;
                return Ok(());
            }
            let bytes = meta.len();
            for session in opencode::discover(&db, None)? {
                out.push(ListedChat {
                    source: "opencode".into(),
                    id: session.id.clone(),
                    root: crate::fs::path_to_js(&db),
                    rel: session.id,
                    cwd: Some(session.cwd),
                    title: session.title,
                    mtime_ms: session.mtime_ms,
                    bytes,
                });
            }
        }
        "cursor-ide" => {
            if !include_cursor_ide {
                return Ok(());
            }
            let db = root.join("globalStorage").join("state.vscdb");
            match fs::symlink_metadata(&db) {
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(_) => return Err("Couldn't read this store.".into()),
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err("That file isn't in the folder.".into());
                }
                Ok(meta) if !meta.is_file() => return Ok(()),
                Ok(meta) if meta.len() > limits.max_read => {
                    stats.too_big += 1;
                    return Ok(());
                }
                Ok(_) => {}
            }
            for session in cursor::discover_ide(root, None)? {
                out.push(ListedChat {
                    source: "cursor-ide".into(),
                    id: session.id.clone(),
                    root: crate::fs::path_to_js(root),
                    rel: session.id,
                    cwd: Some(session.cwd),
                    title: None,
                    mtime_ms: session.mtime_ms,
                    bytes: 0,
                });
            }
        }
        "grok" => {
            for file in walk_named(root, "chat_history.jsonl", limits, true, stats) {
                let dir = file.parent().unwrap_or(root);
                let descriptor = grok::classify_dir(dir);
                push_file(
                    out,
                    "grok",
                    root,
                    &file,
                    descriptor.as_ref().map(|item| item.id.clone()),
                    descriptor.as_ref().map(|item| item.cwd.clone()),
                    None,
                );
            }
        }
        "cursor" => {
            for file in walk_named(root, "meta.json", limits, false, stats) {
                let dir = file.parent().unwrap_or(root);
                let Some(descriptor) = cursor::classify_dir(dir) else {
                    continue;
                };
                let hash = cursor::cwd_hash(&descriptor.cwd);
                let folder = dir
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if folder.len() == hash.len()
                    && folder.chars().all(|ch| ch.is_ascii_hexdigit())
                    && folder != hash
                {
                    continue;
                }
                let db = dir.join("store.db");
                if !db.is_file() || is_symlink(&db) {
                    continue;
                }
                push_file(
                    out,
                    "cursor",
                    root,
                    &db,
                    Some(descriptor.id),
                    Some(descriptor.cwd),
                    descriptor.title,
                );
            }
        }
        "pi" | "claude" | "codex" | "hermes" => {
            for file in walk_suffix(root, ".jsonl", limits, true, stats) {
                let id = file
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let (cwd, title) = if source == "pi" {
                    let Some(text) = read_head(&file, limits.max_read) else {
                        continue;
                    };
                    let descriptor = pi::classify_text(&text, false, &id);
                    (descriptor.as_ref().map(|item| item.cwd.clone()), None)
                } else {
                    (None, None)
                };
                push_file(out, source, root, &file, Some(id), cwd, title);
            }
        }
        _ => return Err("That store isn't one Hivra reads.".into()),
    }
    Ok(())
}

fn push_file(
    out: &mut Vec<ListedChat>,
    source: &str,
    root: &Path,
    file: &Path,
    id: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
) {
    let rel = file.strip_prefix(root).unwrap_or(file);
    let meta = fs::symlink_metadata(file).ok();
    let bytes = meta.as_ref().map(|item| item.len()).unwrap_or(0);
    let mtime_ms = meta
        .as_ref()
        .and_then(|item| item.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    out.push(ListedChat {
        source: source.to_string(),
        id: id.unwrap_or_default(),
        root: crate::fs::path_to_js(root),
        rel: crate::fs::path_to_js(rel),
        cwd,
        title,
        mtime_ms,
        bytes,
    });
}

struct Found {
    path: PathBuf,
    mtime_ms: i64,
    len: u64,
}

/// Newest first, then the cap. A file over the read cap is counted and left out when
/// `skip_big` is set (the file itself is what gets read), so it can't fail a run later.
fn newest_files(
    mut found: Vec<Found>,
    limits: Limits,
    skip_big: bool,
    stats: &mut ListStats,
) -> Vec<PathBuf> {
    if skip_big {
        let before = found.len();
        found.retain(|item| item.len <= limits.max_read);
        stats.too_big += before - found.len();
    }
    found.sort_by(|a, b| {
        b.mtime_ms
            .cmp(&a.mtime_ms)
            .then_with(|| a.path.cmp(&b.path))
    });
    if found.len() > limits.max_files {
        stats.left_out += found.len() - limits.max_files;
        found.truncate(limits.max_files);
    }
    found.into_iter().map(|item| item.path).collect()
}

fn walk_suffix(
    root: &Path,
    suffix: &str,
    limits: Limits,
    skip_big: bool,
    stats: &mut ListStats,
) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(root, &mut found, &|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(suffix))
    });
    newest_files(found, limits, skip_big, stats)
}

fn walk_named(
    root: &Path,
    name: &str,
    limits: Limits,
    skip_big: bool,
    stats: &mut ListStats,
) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(root, &mut found, &|path| {
        path.file_name().and_then(|file| file.to_str()) == Some(name)
    });
    newest_files(found, limits, skip_big, stats)
}

fn walk(dir: &Path, out: &mut Vec<Found>, keep: &dyn Fn(&Path) -> bool) {
    if is_symlink(dir) {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, out, keep);
        } else if kind.is_file() && keep(&path) {
            let meta = entry.metadata().ok();
            out.push(Found {
                path,
                mtime_ms: meta
                    .as_ref()
                    .and_then(|item| item.modified().ok())
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or(0),
                len: meta.map(|item| item.len()).unwrap_or(0),
            });
        }
    }
}

fn daily_roots(
    home: &Path,
    include_cursor_ide: bool,
    locate: &StoreLocate<'_>,
) -> Vec<(String, PathBuf)> {
    let hermes = history_import::resolve_hermes_home(
        home,
        locate.hermes_env,
        locate.windows,
        locate.local_app_data,
    );
    let mut roots = vec![
        ("claude".into(), home.join(".claude").join("projects")),
        ("codex".into(), home.join(".codex").join("sessions")),
        (
            "codex".into(),
            home.join(".codex").join("archived_sessions"),
        ),
        ("hermes".into(), hermes),
        ("pi".into(), home.join(".pi").join("agent").join("sessions")),
        ("grok".into(), home.join(".grok").join("sessions")),
        (
            "opencode".into(),
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db"),
        ),
        ("cursor".into(), home.join(".cursor").join("chats")),
    ];
    if include_cursor_ide {
        roots.push(("cursor-ide".into(), ide_user_dir(home)));
    }
    roots
}

fn real_prefixes(home: &Path, locate: &StoreLocate<'_>) -> Vec<PathBuf> {
    let mut prefixes = vec![
        home.join(".claude"),
        home.join(".grok"),
        home.join(".codex"),
        home.join(".pi"),
        home.join(".omp"),
        home.join(".cursor"),
        home.join(".hermes"),
        home.join(".local").join("share").join("opencode"),
        home.join("Library")
            .join("Application Support")
            .join("Cursor"),
        home.join("AppData").join("Roaming").join("Cursor"),
    ];
    if let Some(env) = locate
        .hermes_env
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        prefixes.push(PathBuf::from(env));
    }
    prefixes.push(history_import::resolve_hermes_home(
        home,
        locate.hermes_env,
        locate.windows,
        locate.local_app_data,
    ));
    prefixes
}

/// A stand-in inside a real store, or a parent of one (including the home), is refused.
fn refuses_stand_in(home: &Path, root: &Path, locate: &StoreLocate<'_>) -> bool {
    let root = absolute(root);
    let home = absolute(home);
    if root == home {
        return true;
    }
    for store in real_prefixes(&home, locate) {
        let store = absolute(&store);
        if root.starts_with(&store) || store.starts_with(&root) {
            return true;
        }
    }
    false
}

fn same_path(left: &Path, right: &Path) -> bool {
    crate::fs::path_to_js(&absolute(left)) == crate::fs::path_to_js(&absolute(right))
}

/// The command's gate. A dev copy may read only a named stand-in. A daily copy may
/// read only a store root this build already knows. The bytes are read after that.
#[allow(clippy::too_many_arguments)]
pub fn read_allowed(
    home: &Path,
    source: &str,
    root: &Path,
    rel: &str,
    stand_ins: Option<&[StandIn]>,
    dev: bool,
    limits: Limits,
    locate: &StoreLocate<'_>,
) -> Result<String, String> {
    if rel.contains('\0')
        || Path::new(rel).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
        || Path::new(rel).is_absolute()
    {
        return Err("That file isn't in the folder.".into());
    }
    if is_symlink(root) {
        return Err("That folder is a link, so it was not read.".into());
    }
    if dev {
        let named = stand_ins.unwrap_or(&[]).iter().any(|stand_in| {
            stand_in.source == source && same_path(Path::new(&stand_in.root), root)
        });
        if !named || refuses_stand_in(home, root, locate) {
            return Err("A dev copy only reads transcript stand-ins a test names.".into());
        }
    } else {
        let allowed = daily_roots(home, true, locate)
            .iter()
            .any(|(store_source, store_root)| {
                store_source == source && same_path(store_root, root)
            });
        if !allowed {
            return Err("That folder isn't one of the chat folders.".into());
        }
    }
    read_store(source, root, rel, limits)
}

/// The first slice of a chat, for classifying a pi session. A link, a non-file,
/// or a file over the cap is skipped rather than failing the whole list.
fn read_head(path: &Path, max_read: u64) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > max_read {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let take = 65_536u64.min(meta.len()) as usize;
    let mut buf = vec![0u8; take];
    let read = file.read(&mut buf).ok()?;
    buf.truncate(read);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn joined(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = root.join(rel);
    ensure_inside(root, &path)?;
    Ok(path)
}

fn ensure_inside(root: &Path, path: &Path) -> Result<(), String> {
    if is_symlink(path) {
        return Err("That file isn't in the folder.".into());
    }
    let mut cursor = root.to_path_buf();
    if is_symlink(&cursor) {
        return Err("That folder is a link, so it was not read.".into());
    }
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "That file isn't in the folder.".to_string())?;
    for component in rel.components() {
        match component {
            Component::Normal(part) => {
                cursor.push(part);
                if is_symlink(&cursor) {
                    return Err("That file isn't in the folder.".into());
                }
            }
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err("That file isn't in the folder.".into());
            }
        }
    }
    Ok(())
}

fn ensure_size(path: &Path, max_read: u64) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Could not read this chat.".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("That file isn't in the folder.".into());
    }
    if !meta.is_file() {
        return Err("That isn't a chat file.".into());
    }
    if meta.len() > max_read {
        return Err("That chat is too big to read in one go.".into());
    }
    Ok(())
}

fn read_bytes(path: &Path, max_read: u64) -> Result<String, String> {
    ensure_size(path, max_read)?;
    let bytes = fs::read(path).map_err(|_| "Could not read this chat.".to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

pub fn render(events: &[LearnEvent]) -> String {
    let mut out = String::new();
    for event in events {
        if event.kind == "message" {
            out.push_str(event.role.as_deref().unwrap_or(""));
            out.push_str(": ");
            out.push_str(event.text.as_deref().unwrap_or(""));
            out.push('\n');
        } else if event.kind == "tool" {
            out.push_str("tool ");
            out.push_str(event.name.as_deref().unwrap_or(""));
            if let Some(result) = &event.result {
                out.push_str(" -> ");
                out.push_str(result);
            }
            out.push('\n');
        }
    }
    out
}
