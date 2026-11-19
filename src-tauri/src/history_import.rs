//! WP-50: read past chats, with a person's OK, into a proposal.
//!
//! Listing returns a header only. The full file is read when a run starts.
//! State is compare-and-swapped. A proposal is a draft and is never applied here.
//! The model call goes only to a model the person chose, and never with a Claude key.
//! Translated from Raven's importer (Apache-2.0) and Agent Zero's migrate-agents
//! preview (MIT). Tool noise is dropped and a line without a source is refused.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::model_router::{may_route, session_token, CustomRoute};
use crate::portable::scrubber;

pub const HEADER_BYTES: usize = 8192;
pub const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;
pub const ACTIVE: Duration = Duration::from_secs(300);
pub const MAX_FILES: usize = 5000;
const ERROR_LIMIT: usize = 200;
const PROMPT_LIMIT: usize = 100_000;

#[derive(Clone, Copy)]
pub struct Limits {
    pub header_bytes: usize,
    pub max_read: u64,
    pub active: Duration,
    pub max_files: usize,
}

impl Limits {
    pub fn production() -> Self {
        Self {
            header_bytes: HEADER_BYTES,
            max_read: MAX_READ_BYTES,
            active: ACTIVE,
            max_files: MAX_FILES,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListedFile {
    pub path: String,
    pub bytes: u64,
    pub mtime_ms: u64,
    pub header: String,
    pub too_big: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListReport {
    pub missing: bool,
    pub files: Vec<ListedFile>,
    pub active: u64,
    pub links: u64,
    pub database: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub revision: u64,
    pub state: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Roots {
    pub claude_code: Vec<String>,
    pub codex: Vec<String>,
    pub hermes: Vec<String>,
    pub hermes_database: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalIn {
    pub id: String,
    pub markdown: String,
    pub source: String,
    pub conversation_id: String,
    pub project: String,
    #[serde(default)]
    pub source_key: String,
    #[serde(default)]
    pub applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostResult {
    Answer(String),
    Status(u16),
    Unreachable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AskOutcome {
    pub ok: bool,
    pub text: String,
    pub kind: String,
    pub reason: String,
}

fn empty_report(missing: bool) -> ListReport {
    ListReport {
        missing,
        files: Vec::new(),
        active: 0,
        links: 0,
        database: false,
        truncated: false,
    }
}

fn empty_state() -> Value {
    json!({ "entries": {} })
}

fn cite_re() -> &'static Regex {
    static CITE: OnceLock<Regex> = OnceLock::new();
    CITE.get_or_init(|| {
        Regex::new(r"\[src:\s+[A-Za-z0-9._:-]+\s+#[A-Za-z0-9._:-]+\]").expect("citation pattern")
    })
}

fn id_re() -> &'static Regex {
    static ID: OnceLock<Regex> = OnceLock::new();
    ID.get_or_init(|| Regex::new(r"^[a-z0-9-]{1,80}$").expect("id pattern"))
}

pub(crate) fn is_jsonl(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
}

pub(crate) fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| u64::try_from(age.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub(crate) fn is_active(meta: &fs::Metadata, now: SystemTime, window: Duration) -> bool {
    let Ok(modified) = meta.modified() else {
        return false;
    };
    match now.duration_since(modified) {
        Ok(age) => age < window,
        Err(_) => true,
    }
}

fn at_cap(report: &ListReport, limits: Limits) -> bool {
    report
        .files
        .len()
        .saturating_add(usize::try_from(report.active).unwrap_or(usize::MAX))
        >= limits.max_files
}

/// Copies `model_router::chat_url`, which is private. Ollama with no `/v1` gets one.
fn loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// The import calls only the host that belongs to the provider. A custom
/// address is refused: `may_route` would allow any https URL, and the chat
/// must not be sent there.
pub fn import_destination_allowed(route: &CustomRoute) -> bool {
    let Ok(parsed) = url::Url::parse(route.base_url.trim()) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    match route.provider.as_str() {
        "ollama" => parsed.scheme() == "http" && loopback_host(&host),
        "xai" => parsed.scheme() == "https" && host == "api.x.ai",
        "openrouter" => parsed.scheme() == "https" && host == "openrouter.ai",
        "deepseek" => parsed.scheme() == "https" && host == "api.deepseek.com",
        _ => false,
    }
}

pub fn completions_url(provider: &str, base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if provider == "ollama" && !base.ends_with("/v1") {
        format!("{base}/v1/chat/completions")
    } else {
        format!("{base}/chat/completions")
    }
}

pub fn classify(code: u16) -> &'static str {
    match code {
        408 | 429 | 500..=599 => "retryable",
        _ => "refused",
    }
}

fn refused(reason: &str) -> AskOutcome {
    AskOutcome {
        ok: false,
        text: String::new(),
        kind: "refused".into(),
        reason: reason.into(),
    }
}

fn retryable(reason: &str) -> AskOutcome {
    AskOutcome {
        ok: false,
        text: String::new(),
        kind: "retryable".into(),
        reason: reason.into(),
    }
}

fn status_reason(kind: &str) -> String {
    if kind == "retryable" {
        "The model didn't answer this time. It can be run again.".into()
    } else {
        "That model turned this down.".into()
    }
}

/// Hermes home. `HERMES_HOME` wins. A profile file named `default` stays on the root.
/// `windows` is passed in so the Windows layout can be tested on this Mac.
pub fn resolve_hermes_home(
    home: &Path,
    env_home: Option<&str>,
    windows: bool,
    local_app_data: Option<&str>,
) -> PathBuf {
    if let Some(env) = env_home.map(str::trim).filter(|value| !value.is_empty()) {
        return PathBuf::from(env);
    }
    let root = if windows {
        let base = local_app_data
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        base.join("hermes")
    } else {
        home.join(".hermes")
    };
    let active = read_active_profile(&root);
    if active.is_empty() {
        root
    } else {
        root.join("profiles").join(active)
    }
}

fn read_active_profile(root: &Path) -> String {
    let raw = fs::read_to_string(root.join("active_profile")).unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("default") {
        String::new()
    } else {
        raw.to_ascii_lowercase()
    }
}

pub fn roots_for(
    home: &Path,
    env_home: Option<&str>,
    windows: bool,
    local_app_data: Option<&str>,
) -> Roots {
    let hermes = resolve_hermes_home(home, env_home, windows, local_app_data);
    Roots {
        claude_code: vec![crate::fs::path_to_js(
            &home.join(".claude").join("projects"),
        )],
        codex: vec![
            crate::fs::path_to_js(&home.join(".codex").join("sessions")),
            crate::fs::path_to_js(&home.join(".codex").join("archived_sessions")),
        ],
        hermes_database: hermes.join("state.db").is_file(),
        hermes: vec![crate::fs::path_to_js(&hermes)],
    }
}

fn contained(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let root =
        crate::fs::canonical(root).map_err(|_| "That folder isn't on this Mac.".to_string())?;
    if !root.is_dir() {
        return Err("That folder isn't on this Mac.".to_string());
    }
    let full = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let full =
        crate::fs::canonical(&full).map_err(|_| "That file isn't in the folder.".to_string())?;
    if !full.starts_with(&root) {
        return Err("That file isn't in the folder.".to_string());
    }
    Ok(full)
}

fn read_header(path: &Path, cap: usize) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "Could not read this chat.".to_string())?;
    let mut buf = vec![0u8; cap];
    let mut filled = 0;
    while filled < cap {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Err("Could not read this chat.".to_string()),
        }
    }
    Ok(String::from_utf8_lossy(&buf[..filled]).into_owned())
}

fn consider(root: &Path, path: &Path, now: SystemTime, limits: Limits, report: &mut ListReport) {
    if at_cap(report, limits) {
        report.truncated = true;
        return;
    }
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => return,
    };
    let Ok(rel) = path.strip_prefix(root) else {
        return;
    };
    if is_active(&meta, now, limits.active) {
        report.active += 1;
        return;
    }
    let rel = crate::fs::path_to_js(rel);
    if meta.len() > limits.max_read {
        report.files.push(ListedFile {
            path: rel,
            bytes: meta.len(),
            mtime_ms: mtime_ms(&meta),
            header: String::new(),
            too_big: true,
        });
        return;
    }
    let Ok(header) = read_header(path, limits.header_bytes) else {
        return;
    };
    report.files.push(ListedFile {
        path: rel,
        bytes: meta.len(),
        mtime_ms: mtime_ms(&meta),
        header,
        too_big: false,
    });
}

fn rel_key(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok().map(crate::fs::path_to_js)
}

fn is_skipped(root: &Path, path: &Path, skip: &HashSet<String>) -> bool {
    rel_key(root, path).is_some_and(|rel| skip.contains(&rel))
}

fn walk(
    root: &Path,
    dir: &Path,
    now: SystemTime,
    limits: Limits,
    skip: &HashSet<String>,
    report: &mut ListReport,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
    paths.sort_by_key(|entry| entry.file_name());
    for entry in paths {
        if report.truncated {
            return;
        }
        let path = entry.path();
        let name = entry.file_name();
        if name == "node_modules" {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // A chat already submitted does not count toward the cap, and does not
        // stop the walk, so a later run can reach the chats past it.
        if is_jsonl(&path)
            && (file_type.is_file() || file_type.is_symlink())
            && is_skipped(root, &path, skip)
        {
            continue;
        }
        if at_cap(report, limits) {
            report.truncated = true;
            return;
        }
        if file_type.is_symlink() {
            match crate::fs::canonical(&path) {
                Ok(target) if target.starts_with(root) && target.is_file() && is_jsonl(&path) => {
                    consider(root, &path, now, limits, report);
                }
                _ => report.links += 1,
            }
            continue;
        }
        if file_type.is_dir() {
            walk(root, &path, now, limits, skip, report);
            continue;
        }
        if file_type.is_file() && is_jsonl(&path) {
            consider(root, &path, now, limits, report);
        }
    }
}

fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn roots_match(requested: &Path, allowed: &Path) -> bool {
    match (
        crate::fs::canonical(requested),
        crate::fs::canonical(allowed),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => lexical(requested) == lexical(allowed),
    }
}

fn source_dirs(
    home: &Path,
    hermes_env: Option<&str>,
    windows: bool,
    local_app_data: Option<&str>,
    source: &str,
) -> Result<Vec<PathBuf>, String> {
    match source {
        "claude_code" => Ok(vec![home.join(".claude").join("projects")]),
        "codex" => Ok(vec![
            home.join(".codex").join("sessions"),
            home.join(".codex").join("archived_sessions"),
        ]),
        "hermes" => Ok(vec![resolve_hermes_home(
            home,
            hermes_env,
            windows,
            local_app_data,
        )]),
        _ => Err("That source isn't one of the chats you can read.".into()),
    }
}

pub(crate) fn confirm_root(
    home: &Path,
    hermes_env: Option<&str>,
    windows: bool,
    local_app_data: Option<&str>,
    root: &Path,
    source: &str,
) -> Result<(), String> {
    let dirs = source_dirs(home, hermes_env, windows, local_app_data, source)?;
    if dirs.iter().any(|dir| roots_match(root, dir)) {
        Ok(())
    } else {
        Err("That folder isn't one of the chat folders.".into())
    }
}

/// Submitted chats are left out of the next list. A Hermes session key
/// (`file#id`) does not hide the rest of that file.
fn skip_paths(state: Option<&Value>, source: &str) -> HashSet<String> {
    let mut skip = HashSet::new();
    let Some(entries) = state
        .and_then(|value| value.get("entries"))
        .and_then(Value::as_object)
    else {
        return skip;
    };
    let prefix = format!("{source}:");
    for (key, entry) in entries {
        if entry.get("status").and_then(Value::as_str) != Some("submitted") {
            continue;
        }
        let Some(source_key) = key.strip_prefix(&prefix) else {
            continue;
        };
        if source_key.is_empty() || (source == "hermes" && source_key.contains('#')) {
            continue;
        }
        skip.insert(source_key.to_string());
    }
    skip
}

#[allow(clippy::too_many_arguments)]
pub fn list_checked(
    home: &Path,
    hermes_env: Option<&str>,
    windows: bool,
    local_app_data: Option<&str>,
    root: &Path,
    source: &str,
    state: Option<&Value>,
    now: SystemTime,
    limits: Limits,
) -> Result<ListReport, String> {
    confirm_root(home, hermes_env, windows, local_app_data, root, source)?;
    let skip = skip_paths(state, source);
    if skip.is_empty() {
        return list_tree(root, source, now, limits);
    }
    list_tree_skip(root, source, now, limits, &skip)
}

#[allow(clippy::too_many_arguments)]
pub fn read_checked(
    home: &Path,
    hermes_env: Option<&str>,
    windows: bool,
    local_app_data: Option<&str>,
    root: &Path,
    rel: &str,
    source: &str,
    max_bytes: u64,
) -> Result<String, String> {
    confirm_root(home, hermes_env, windows, local_app_data, root, source)?;
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("That file isn't in the folder.".into());
    }
    if !is_jsonl(rel_path) {
        return Err("That isn't a chat file.".into());
    }
    let joined = root.join(rel_path);
    match fs::symlink_metadata(&joined) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("That file isn't in the folder.".into());
        }
        Ok(_) => {}
        Err(_) => return Err("That file isn't in the folder.".into()),
    }
    read_transcript(root, rel, max_bytes)
}

fn list_tree_skip(
    root: &Path,
    source: &str,
    now: SystemTime,
    limits: Limits,
    skip: &HashSet<String>,
) -> Result<ListReport, String> {
    if !root.exists() {
        return Ok(empty_report(true));
    }
    let root =
        crate::fs::canonical(root).map_err(|_| "That folder isn't on this Mac.".to_string())?;
    if !root.is_dir() {
        return Err("That folder isn't on this Mac.".to_string());
    }
    let mut report = empty_report(false);
    report.database = source == "hermes" && root.join("state.db").is_file();
    walk(&root, &root, now, limits, skip, &mut report);
    Ok(report)
}

pub fn list_tree(
    root: &Path,
    source: &str,
    now: SystemTime,
    limits: Limits,
) -> Result<ListReport, String> {
    list_tree_skip(root, source, now, limits, &HashSet::new())
}

pub fn read_transcript(root: &Path, rel: &str, max_bytes: u64) -> Result<String, String> {
    let path = contained(root, Path::new(rel))?;
    let meta = fs::metadata(&path).map_err(|_| "Could not read this chat.".to_string())?;
    if !meta.is_file() {
        return Err("That isn't a chat file.".to_string());
    }
    if meta.len() > max_bytes {
        return Err("That chat is too big to read in one go.".to_string());
    }
    let bytes = fs::read(&path).map_err(|_| "Could not read this chat.".to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

static STATE_LOCK: Mutex<()> = Mutex::new(());

fn state_lock() -> MutexGuard<'static, ()> {
    STATE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn clean_error(value: &Value) -> Value {
    let Some(text) = value.as_str() else {
        return Value::Null;
    };
    if text.is_empty() || mentions_secret(text) {
        return Value::Null;
    }
    Value::String(text.chars().take(ERROR_LIMIT).collect())
}

fn clean_entry(value: &Value) -> Option<Value> {
    let status = value.get("status")?.as_str()?;
    if !matches!(status, "submitted" | "failed" | "deferred") {
        return None;
    }
    let timestamp = value.get("timestamp").and_then(Value::as_u64).unwrap_or(0);
    let error = value.get("error").map(clean_error).unwrap_or(Value::Null);
    Some(json!({ "status": status, "timestamp": timestamp, "error": error }))
}

fn wrapper_key(key: &str) -> bool {
    matches!(key, "meta" | "entries" | "revision" | "state")
}

fn sanitize_state(value: Value) -> Value {
    let Value::Object(obj) = value else {
        return empty_state();
    };
    if !obj.contains_key("entries") {
        if let Some(inner) = obj.get("state").filter(|inner| inner.is_object()).cloned() {
            return sanitize_state(inner);
        }
    }
    let skip_wrappers = !matches!(obj.get("entries"), Some(Value::Object(_)));
    let source = if let Some(Value::Object(map)) = obj.get("entries") {
        map.clone()
    } else {
        obj
    };
    let mut entries = Map::new();
    for (key, entry) in source {
        if skip_wrappers && wrapper_key(&key) {
            continue;
        }
        if mentions_secret(&key) {
            continue;
        }
        if let Some(clean) = clean_entry(&entry) {
            entries.insert(key, clean);
        }
    }
    json!({ "entries": entries })
}

fn interpret(value: Value) -> Loaded {
    let revision = value.get("revision").and_then(Value::as_u64);
    let state = value.get("state").cloned();
    if let (Some(revision), Some(state)) = (revision, state) {
        return Loaded {
            revision,
            state: sanitize_state(state),
        };
    }
    Loaded {
        revision: 0,
        state: sanitize_state(value),
    }
}

fn backup_corrupt(path: &Path) -> Result<(), String> {
    let backup = path.with_extension("json.corrupt");
    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|_| "Couldn't move the broken state aside.".to_string())?;
    }
    fs::rename(path, backup).map_err(|_| "Couldn't move the broken state aside.".to_string())
}

fn parse_loaded(path: &Path, text: &str) -> Result<Loaded, String> {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => Ok(interpret(value)),
        Err(_) => {
            backup_corrupt(path)?;
            Ok(Loaded {
                revision: 0,
                state: empty_state(),
            })
        }
    }
}

fn load_unlocked(dir: &Path) -> Result<Loaded, String> {
    let path = dir.join("state.json");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            let backup = path.with_extension("json.bak");
            match fs::read_to_string(&backup) {
                Ok(text) => {
                    // Put the previous progress back. If that rename fails, still
                    // read what was saved rather than starting the import over.
                    if fs::rename(&backup, &path).is_err() && !path.is_file() {
                        return parse_loaded(&backup, &text);
                    }
                    fs::read_to_string(&path).unwrap_or(text)
                }
                Err(err) if err.kind() == ErrorKind::NotFound => {
                    return Ok(Loaded {
                        revision: 0,
                        state: empty_state(),
                    });
                }
                Err(_) => return Err("Couldn't read the progress.".to_string()),
            }
        }
        Err(_) => return Err("Couldn't read the progress.".to_string()),
    };
    parse_loaded(&path, &text)
}

pub fn load_state(dir: &Path) -> Result<Loaded, String> {
    let _guard = state_lock();
    load_unlocked(dir)
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    if !to.exists() {
        return fs::rename(from, to).map_err(|_| "Couldn't save the progress.".to_string());
    }
    // Move the current file aside first. It is never deleted before the new
    // one is in its place, and a failed second rename puts it back.
    let backup = to.with_extension("json.bak");
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| "Couldn't save the progress.".to_string())?;
    }
    fs::rename(to, &backup).map_err(|_| "Couldn't save the progress.".to_string())?;
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            if !to.exists() {
                let _ = fs::rename(&backup, to);
            }
            Err("Couldn't save the progress.".to_string())
        }
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if is_link(parent) {
            return Err("Couldn't save the progress.".to_string());
        }
        fs::create_dir_all(parent).map_err(|_| "Couldn't save the progress.".to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    // A link at the temp path would be followed by the write and would
    // overwrite whatever it points at. Remove the link itself first.
    if is_link(&tmp) {
        let Some(parent) = path.parent() else {
            return Err("Couldn't save the progress.".to_string());
        };
        if is_link(parent) || tmp.parent() != Some(parent) || !inside(parent, parent) {
            return Err("Couldn't save the progress.".to_string());
        }
        fs::remove_file(&tmp).map_err(|_| "Couldn't save the progress.".to_string())?;
        if is_link(&tmp) {
            return Err("Couldn't save the progress.".to_string());
        }
    }
    fs::write(&tmp, bytes).map_err(|_| "Couldn't save the progress.".to_string())?;
    replace_file(&tmp, path)
}

pub fn cas_state(dir: &Path, expected: u64, state: Value) -> Result<bool, String> {
    let _guard = state_lock();
    let current = load_unlocked(dir)?;
    if current.revision != expected {
        return Ok(false);
    }
    let next = json!({
        "revision": expected + 1,
        "state": sanitize_state(state),
    });
    let bytes =
        serde_json::to_vec_pretty(&next).map_err(|_| "Couldn't save the progress.".to_string())?;
    atomic_write(&dir.join("state.json"), &bytes)?;
    Ok(true)
}

fn same_chat(folder: &Path, proposal: &ProposalIn) -> bool {
    let Ok(text) = fs::read_to_string(folder.join("proposal.json")) else {
        return false;
    };
    let Ok(meta) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    meta.get("source").and_then(Value::as_str) == Some(proposal.source.as_str())
        && meta.get("conversationId").and_then(Value::as_str)
            == Some(proposal.conversation_id.as_str())
        && meta.get("sourceKey").and_then(Value::as_str).unwrap_or("") == proposal.source_key
}

fn sourced(markdown: &str) -> bool {
    if markdown.trim().is_empty() {
        return false;
    }
    markdown
        .lines()
        .all(|line| line.trim().is_empty() || cite_re().is_match(line))
}

fn has_secret(text: &str) -> bool {
    scrubber().has_secret(text)
}

/// The shared patterns, including a `token=…` that sits after `/`, `\`, or the
/// `platform:` prefix. Those are not boundaries in the shared list, but a path
/// still must not be stored.
fn mentions_secret(text: &str) -> bool {
    if has_secret(text) {
        return true;
    }
    if !(text.contains('/') || text.contains('\\') || text.contains(':')) {
        return false;
    }
    has_secret(&text.replace(['/', '\\', ':'], " "))
}

fn inside(parent: &Path, child: &Path) -> bool {
    let Ok(parent) = crate::fs::canonical(parent) else {
        return false;
    };
    let Ok(child) = crate::fs::canonical(child) else {
        return false;
    };
    child.starts_with(parent)
}

fn remove_if_inside(parent: &Path, child: &Path) {
    if inside(parent, child) {
        let _ = fs::remove_dir_all(child);
    }
}

pub fn write_proposal(dir: &Path, proposal: &ProposalIn) -> Result<(), String> {
    if proposal.applied {
        return Err("A draft can't be applied from here.".into());
    }
    if !id_re().is_match(&proposal.id) {
        return Err("That draft id can't be used.".into());
    }
    if !sourced(&proposal.markdown) {
        return Err("A line without a source was left in.".into());
    }
    if mentions_secret(&proposal.markdown)
        || mentions_secret(&proposal.source)
        || mentions_secret(&proposal.project)
        || mentions_secret(&proposal.conversation_id)
        || mentions_secret(&proposal.source_key)
    {
        return Err("That draft looks like it contains a secret, so it was not saved.".into());
    }
    let proposals = dir.join("proposals");
    fs::create_dir_all(&proposals).map_err(|_| "The draft could not be saved.".to_string())?;
    let folder = proposals.join(&proposal.id);
    match fs::create_dir(&folder) {
        Ok(()) => {}
        Err(err) if err.kind() == ErrorKind::AlreadyExists => {
            if same_chat(&folder, proposal) {
                return Err("This chat was already drafted.".into());
            }
            return Err("That draft belongs to a different chat.".into());
        }
        Err(_) => return Err("The draft could not be saved.".into()),
    }
    let meta = json!({
        "format": 1,
        "kind": "history-import",
        "status": "unreviewed",
        "applied": false,
        "source": proposal.source,
        "conversationId": proposal.conversation_id,
        "project": proposal.project,
        "sourceKey": proposal.source_key,
    });
    let markdown_path = folder.join("how-you-work.md");
    let meta_path = folder.join("proposal.json");
    let meta_bytes = match serde_json::to_vec_pretty(&meta) {
        Ok(bytes) => bytes,
        Err(_) => {
            remove_if_inside(&proposals, &folder);
            return Err("The draft could not be saved.".into());
        }
    };
    if let Err(_err) = fs::write(&markdown_path, &proposal.markdown)
        .and_then(|_| fs::write(&meta_path, meta_bytes))
    {
        remove_if_inside(&proposals, &folder);
        return Err("The draft could not be saved.".into());
    }
    Ok(())
}

pub fn ask_with(
    route: &CustomRoute,
    prompt: &str,
    key: Option<&str>,
    post: impl FnOnce(&str, &str, &str) -> PostResult,
) -> AskOutcome {
    if has_secret(prompt) {
        return refused("That chat contained a secret, so it was not sent.");
    }
    if prompt.chars().count() > PROMPT_LIMIT {
        return refused("That chat is too long to send.");
    }
    if !import_destination_allowed(route) || !may_route(route) {
        return refused("That model can't be used for this.");
    }
    let token = match session_token(&route.provider, key) {
        Ok(token) => token,
        Err(reason) => return refused(&reason),
    };
    let url = completions_url(&route.provider, &route.base_url);
    let body = json!({
        "model": route.model_id.trim(),
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": 800,
        "stream": false,
    })
    .to_string();
    match post(&url, &token, &body) {
        PostResult::Answer(text) => AskOutcome {
            ok: true,
            text,
            kind: "ok".into(),
            reason: String::new(),
        },
        PostResult::Status(200) => refused("The model answered in a shape that couldn't be read."),
        PostResult::Status(code) => {
            let kind = classify(code);
            if kind == "retryable" {
                retryable(&status_reason(kind))
            } else {
                refused(&status_reason(kind))
            }
        }
        PostResult::Unreachable => {
            retryable("The model didn't answer this time. It can be run again.")
        }
    }
}

fn assistant_text(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let content = value.pointer("/choices/0/message/content")?;
    match content {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn post_chat(url: &str, token: &str, body: &str) -> PostResult {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .timeout_write(Duration::from_secs(30))
        .build();
    match agent
        .post(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(body)
    {
        Ok(response) => match assistant_text(&response.into_string().unwrap_or_default()) {
            Some(text) => PostResult::Answer(text),
            None => PostResult::Status(200),
        },
        Err(ureq::Error::Status(code, _)) => PostResult::Status(code),
        Err(ureq::Error::Transport(_)) => PostResult::Unreachable,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedProposal {
    pub id: String,
    pub project: String,
    pub conversation_id: String,
    pub source: String,
    pub status: String,
    pub markdown: String,
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// Proposals waiting for review. A symlink is skipped. A file that holds a secret is left out, text and all.
pub fn list_proposals(dir: &Path) -> Result<Vec<ListedProposal>, String> {
    let _guard = state_lock();
    let proposals = dir.join("proposals");
    if !proposals.exists() || is_link(&proposals) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&proposals).map_err(|_| "Couldn't read the drafts.".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "Couldn't read the drafts.".to_string())?;
        let path = entry.path();
        if is_link(&path) || !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !id_re().is_match(&id) || !inside(&proposals, &path) {
            continue;
        }
        let meta_path = path.join("proposal.json");
        let markdown_path = path.join("how-you-work.md");
        if is_link(&meta_path) || is_link(&markdown_path) {
            continue;
        }
        let Ok(meta_text) = fs::read_to_string(&meta_path) else {
            continue;
        };
        let Ok(markdown) = fs::read_to_string(&markdown_path) else {
            continue;
        };
        if markdown.len() > 256 * 1024 || mentions_secret(&meta_text) || mentions_secret(&markdown)
        {
            continue;
        }
        let Ok(meta) = serde_json::from_str::<Value>(&meta_text) else {
            continue;
        };
        let Some(status) = meta.get("status").and_then(Value::as_str) else {
            continue;
        };
        if status != "unreviewed" && status != "confirmed" && status != "rejected" {
            continue;
        }
        let Some(project) = meta.get("project").and_then(Value::as_str) else {
            continue;
        };
        let Some(source) = meta.get("source").and_then(Value::as_str) else {
            continue;
        };
        let Some(conversation_id) = meta.get("conversationId").and_then(Value::as_str) else {
            continue;
        };
        out.push(ListedProposal {
            id,
            project: project.to_string(),
            conversation_id: conversation_id.to_string(),
            source: source.to_string(),
            status: status.to_string(),
            markdown,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Moves a draft from unreviewed to confirmed or rejected. A second review does nothing.
pub fn review_proposal(dir: &Path, id: &str, decision: &str) -> Result<bool, String> {
    if decision != "confirmed" && decision != "rejected" {
        return Err("That review isn't one of the choices.".into());
    }
    if !id_re().is_match(id) {
        return Err("That draft id can't be used.".into());
    }
    let _guard = state_lock();
    let proposals = dir.join("proposals");
    let folder = proposals.join(id);
    if is_link(&folder) || !folder.is_dir() || !inside(&proposals, &folder) {
        return Ok(false);
    }
    let meta_path = folder.join("proposal.json");
    let markdown_path = folder.join("how-you-work.md");
    if is_link(&meta_path) || is_link(&markdown_path) {
        return Ok(false);
    }
    let text = match fs::read_to_string(&meta_path) {
        Ok(text) => text,
        Err(_) => return Ok(false),
    };
    if mentions_secret(&text) {
        return Ok(false);
    }
    let mut meta: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    if meta.get("status").and_then(Value::as_str) != Some("unreviewed") {
        return Ok(false);
    }
    let Some(obj) = meta.as_object_mut() else {
        return Ok(false);
    };
    obj.insert("status".to_string(), Value::String(decision.to_string()));
    let bytes = serde_json::to_vec_pretty(&meta)
        .map_err(|_| "That draft could not be saved.".to_string())?;
    if mentions_secret(&String::from_utf8_lossy(&bytes)) {
        return Ok(false);
    }
    atomic_write(&meta_path, &bytes)?;
    Ok(true)
}

fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Couldn't find the app folder.".to_string())?
        .join("history-import"))
}

#[tauri::command]
pub fn history_import_roots() -> Result<Roots, String> {
    let home = crate::dirs_home().ok_or_else(|| "This Mac has no home folder.".to_string())?;
    let env_home = std::env::var("HERMES_HOME").ok();
    let local = std::env::var("LOCALAPPDATA").ok();
    Ok(roots_for(
        Path::new(&home),
        env_home.as_deref(),
        cfg!(windows),
        local.as_deref(),
    ))
}

#[tauri::command]
pub fn history_import_list(
    app: AppHandle,
    root: String,
    source: String,
) -> Result<ListReport, String> {
    let home = crate::dirs_home().ok_or_else(|| "This Mac has no home folder.".to_string())?;
    let env_home = std::env::var("HERMES_HOME").ok();
    let local = std::env::var("LOCALAPPDATA").ok();
    let loaded = load_state(&store_dir(&app)?)?;
    list_checked(
        Path::new(&home),
        env_home.as_deref(),
        cfg!(windows),
        local.as_deref(),
        Path::new(&root),
        &source,
        Some(&loaded.state),
        SystemTime::now(),
        Limits::production(),
    )
}

#[tauri::command]
pub fn history_import_read(root: String, path: String, source: String) -> Result<String, String> {
    let home = crate::dirs_home().ok_or_else(|| "This Mac has no home folder.".to_string())?;
    let env_home = std::env::var("HERMES_HOME").ok();
    let local = std::env::var("LOCALAPPDATA").ok();
    read_checked(
        Path::new(&home),
        env_home.as_deref(),
        cfg!(windows),
        local.as_deref(),
        Path::new(&root),
        &path,
        &source,
        MAX_READ_BYTES,
    )
}

#[tauri::command]
pub fn history_import_load_state(app: AppHandle) -> Result<Loaded, String> {
    load_state(&store_dir(&app)?)
}

#[tauri::command]
pub fn history_import_cas_state(
    app: AppHandle,
    revision: u64,
    state: Value,
) -> Result<bool, String> {
    cas_state(&store_dir(&app)?, revision, state)
}

#[tauri::command]
pub fn history_import_write_proposal(app: AppHandle, proposal: ProposalIn) -> Result<(), String> {
    write_proposal(&store_dir(&app)?, &proposal)
}

#[tauri::command]
pub fn history_import_list_proposals(app: AppHandle) -> Result<Vec<ListedProposal>, String> {
    list_proposals(&store_dir(&app)?)
}

#[tauri::command]
pub fn history_import_review_proposal(
    app: AppHandle,
    id: String,
    decision: String,
) -> Result<bool, String> {
    review_proposal(&store_dir(&app)?, &id, &decision)
}

#[tauri::command]
pub async fn history_import_ask(route: CustomRoute, prompt: String) -> Result<AskOutcome, String> {
    if has_secret(&prompt) {
        return Ok(refused("That chat contained a secret, so it was not sent."));
    }
    if prompt.chars().count() > PROMPT_LIMIT {
        return Ok(refused("That chat is too long to send."));
    }
    let (route, key) = match import_route_and_key(&route, &crate::key_binding::keychain_item) {
        Ok(found) => found,
        Err(refusal) => return Ok(refusal),
    };
    tauri::async_runtime::spawn_blocking(move || {
        ask_with(&route, &prompt, key.as_deref(), post_chat)
    })
    .await
    .map_err(|_| "The model call didn't finish.".to_string())
}

/// The route an import call may use, and the key for it, or the refusal. The key is read only after the
/// route passes the import's own host rule.
pub(crate) fn import_route_and_key(
    route: &CustomRoute,
    read_item: crate::key_binding::ItemReader,
) -> Result<(CustomRoute, Option<String>), AskOutcome> {
    // The key belongs to the provider and address stored with it. Any other route gets no key.
    let (bound, key) = match crate::key_binding::bound_key(route, read_item) {
        Ok(Some(found)) => found,
        Ok(None) => return Err(refused(crate::key_binding::NOT_STORED_FOR_THIS)),
        Err(_) => return Err(refused("Couldn't reach the Keychain.")),
    };
    if !import_destination_allowed(&bound) || !may_route(&bound) {
        return Err(refused("That model can't be used for this."));
    }
    Ok((bound, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WP-129: a key saved for one provider is never read for a route that names another provider or address.
    #[test]
    fn an_import_reads_a_key_only_for_the_provider_and_address_stored_with_it() {
        let stored = CustomRoute {
            provider: "openrouter".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            model_id: "some/model".into(),
            custom_model_id: "acct-openrouter".into(),
            reasoning_effort: None,
        };
        let item = crate::key_binding::sealed_item(&stored, "sk-or-test-0123456789");
        let read = move |account: &str| -> Result<Option<String>, String> {
            Ok((account == "acct-openrouter").then(|| item.clone()))
        };
        let attempt = |provider: &str, base: &str, account: &str| {
            let route = CustomRoute {
                provider: provider.into(),
                base_url: base.into(),
                model_id: "some/model".into(),
                custom_model_id: account.into(),
                reasoning_effort: None,
            };
            import_route_and_key(&route, &read).is_ok()
        };
        // The same account, but another provider's host: xAI's host is allowed for xAI, not for this key.
        assert!(!attempt("xai", "https://api.x.ai/v1", "acct-openrouter"));
        // Another address for the same provider, and userinfo, a path prefix and an unsaved account.
        for (provider, base, account) in [
            (
                "openrouter",
                "https://openrouter.ai/api/v2",
                "acct-openrouter",
            ),
            (
                "openrouter",
                "https://evil.example@openrouter.ai/api/v1",
                "acct-openrouter",
            ),
            ("openrouter", "https://openrouter.ai/api/v1", "acct-other"),
        ] {
            assert!(!attempt(provider, base, account), "{base} {account}");
        }
        // The stored provider and address is the one key that is read.
        assert!(attempt(
            "openrouter",
            "https://openrouter.ai/api/v1",
            "acct-openrouter"
        ));
    }
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Tmp {
        path: PathBuf,
    }

    impl Tmp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "hivra-wp50-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn age(path: &Path) {
        let file = File::options().write(true).open(path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs(1_000_000))
            .unwrap();
    }

    fn route(provider: &str, base: &str, model: &str) -> CustomRoute {
        CustomRoute {
            provider: provider.into(),
            base_url: base.into(),
            model_id: model.into(),
            custom_model_id: "m1".into(),
            reasoning_effort: None,
        }
    }

    fn proposal(markdown: &str) -> ProposalIn {
        ProposalIn {
            id: "hi-abcdef01".into(),
            markdown: markdown.into(),
            source: "claude_code".into(),
            conversation_id: "sess-1".into(),
            project: "notes".into(),
            source_key: "notes/chat.jsonl".into(),
            applied: false,
        }
    }

    #[test]
    fn parent_escape_does_not_return_the_file() {
        // `..` is the check that also runs on Windows: Path climbs out on every
        // platform, and the outside file's bytes are not in the error.
        let tmp = Tmp::new();
        let outside = tmp.path.join("secret.jsonl");
        fs::write(&outside, b"SECRET_OUTSIDE").unwrap();
        let root = tmp.path.join("root");
        fs::create_dir(&root).unwrap();
        let err = read_transcript(&root, "../secret.jsonl", MAX_READ_BYTES).unwrap_err();
        assert!(!err.to_lowercase().contains("secret"), "{err}");
        let abs = outside.to_string_lossy().into_owned();
        let err = read_transcript(&root, &abs, MAX_READ_BYTES).unwrap_err();
        assert!(!err.to_lowercase().contains("secret"), "{err}");
    }

    #[test]
    fn lists_unicode_and_spaces() {
        let tmp = Tmp::new();
        let root = tmp.path.join("root");
        let folder = root.join("café notes");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("my chat.jsonl");
        fs::write(&file, b"{}\n").unwrap();
        age(&file);
        let report = list_tree(
            &root,
            "claude_code",
            SystemTime::now(),
            Limits::production(),
        )
        .unwrap();
        assert_eq!(report.files.len(), 1);
        let expected = crate::fs::path_to_js(file.strip_prefix(&root).unwrap());
        assert_eq!(report.files[0].path, expected);
        assert!(!expected.is_ascii(), "{expected}");
        assert!(expected.contains("my chat.jsonl"), "{expected}");
        let text = read_transcript(&root, &report.files[0].path, MAX_READ_BYTES).unwrap();
        assert_eq!(text, "{}\n");
    }

    #[cfg(unix)]
    struct Restore<'a>(&'a Path);

    #[cfg(unix)]
    impl Drop for Restore<'_> {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(self.0) {
                let mut perms = meta.permissions();
                perms.set_mode(0o644);
                let _ = fs::set_permissions(self.0, perms);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_outside_is_not_listed_or_read() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let outside = tmp.path.join("secret.jsonl");
        fs::write(&outside, b"SECRET_OUTSIDE").unwrap();
        let root = tmp.path.join("root");
        fs::create_dir(&root).unwrap();
        symlink(&outside, root.join("link.jsonl")).unwrap();
        let inside = root.join("ok.jsonl");
        fs::write(&inside, b"{}\n").unwrap();
        age(&inside);
        let report = list_tree(
            &root,
            "claude_code",
            SystemTime::now(),
            Limits::production(),
        )
        .unwrap();
        let dumped = serde_json::to_string(&report).unwrap();
        assert!(!dumped.contains("SECRET"), "{dumped}");
        assert_eq!(report.links, 1);
        assert_eq!(report.files.len(), 1);
        let err = read_transcript(&root, "link.jsonl", MAX_READ_BYTES).unwrap_err();
        assert!(!err.contains("SECRET"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn active_unreadable_file_is_counted_and_not_opened() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = Tmp::new();
        let root = tmp.path.join("root");
        fs::create_dir(&root).unwrap();
        let file = root.join("now.jsonl");
        fs::write(&file, b"SHOULD_NOT_BE_READ").unwrap();
        let mut perms = fs::metadata(&file).unwrap().permissions();
        perms.set_mode(0o000);
        fs::set_permissions(&file, perms).unwrap();
        let _restore = Restore(&file);
        let report = list_tree(
            &root,
            "claude_code",
            SystemTime::now(),
            Limits::production(),
        )
        .unwrap();
        assert_eq!(report.active, 1);
        assert!(report.files.is_empty());
        let dumped = serde_json::to_string(&report).unwrap();
        assert!(!dumped.contains("SHOULD_NOT_BE_READ"), "{dumped}");
    }

    #[test]
    fn header_stops_before_the_tail() {
        let tmp = Tmp::new();
        let root = tmp.path.join("root");
        fs::create_dir(&root).unwrap();
        let file = root.join("long.jsonl");
        let mut body = b"HEAD".to_vec();
        body.extend(std::iter::repeat_n(b'x', 20_000));
        body.extend(b"TAILMARKER");
        fs::write(&file, &body).unwrap();
        age(&file);
        let report = list_tree(
            &root,
            "claude_code",
            SystemTime::now(),
            Limits::production(),
        )
        .unwrap();
        assert_eq!(report.files.len(), 1);
        assert!(report.files[0].header.starts_with("HEAD"));
        assert!(!report.files[0].header.contains("TAILMARKER"));
        assert!(report.files[0].header.len() <= HEADER_BYTES);
    }

    #[test]
    fn too_big_is_listed_without_a_header() {
        let tmp = Tmp::new();
        let root = tmp.path.join("root");
        fs::create_dir(&root).unwrap();
        let file = root.join("big.jsonl");
        fs::write(&file, b"SECRET_BODY_AND_MORE").unwrap();
        age(&file);
        let limits = Limits {
            max_read: 4,
            ..Limits::production()
        };
        let report = list_tree(&root, "claude_code", SystemTime::now(), limits).unwrap();
        assert!(report.files[0].too_big);
        assert!(report.files[0].header.is_empty());
        let dumped = serde_json::to_string(&report).unwrap();
        assert!(!dumped.contains("SECRET"), "{dumped}");
    }

    #[test]
    fn missing_root_is_not_an_error() {
        let tmp = Tmp::new();
        let report = list_tree(
            &tmp.path.join("nope"),
            "claude_code",
            SystemTime::now(),
            Limits::production(),
        )
        .unwrap();
        assert!(report.missing);
        assert!(report.files.is_empty());
    }

    #[test]
    fn hermes_database_is_reported_not_opened() {
        let tmp = Tmp::new();
        let root = tmp.path.join("hermes");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("state.db"), b"SECRET_DB").unwrap();
        let chat = root.join("chat.jsonl");
        fs::write(&chat, b"{}\n").unwrap();
        age(&chat);
        let report = list_tree(&root, "hermes", SystemTime::now(), Limits::production()).unwrap();
        assert!(report.database);
        let dumped = serde_json::to_string(&report).unwrap();
        assert!(!dumped.contains("SECRET_DB"), "{dumped}");
        assert_eq!(report.files.len(), 1);
    }

    #[test]
    fn skips_node_modules() {
        let tmp = Tmp::new();
        let root = tmp.path.join("root");
        let nested = root.join("node_modules");
        fs::create_dir_all(&nested).unwrap();
        let hidden = nested.join("secret.jsonl");
        fs::write(&hidden, b"SECRET_MODULE").unwrap();
        age(&hidden);
        let report = list_tree(
            &root,
            "claude_code",
            SystemTime::now(),
            Limits::production(),
        )
        .unwrap();
        let dumped = serde_json::to_string(&report).unwrap();
        assert!(!dumped.contains("SECRET_MODULE"), "{dumped}");
        assert!(report.files.is_empty());
    }

    #[test]
    fn corrupt_state_is_renamed_and_flat_state_is_kept() {
        let tmp = Tmp::new();
        let dir = tmp.path.join("store");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("state.json"), b"{").unwrap();
        let loaded = load_state(&dir).unwrap();
        assert_eq!(loaded.revision, 0);
        assert!(dir.join("state.json.corrupt").is_file());
        assert_eq!(
            fs::read_to_string(dir.join("state.json.corrupt")).unwrap(),
            "{"
        );
        fs::write(
            dir.join("state.json"),
            br#"{"claude_code:one":{"status":"submitted","timestamp":1}}"#,
        )
        .unwrap();
        let loaded = load_state(&dir).unwrap();
        assert_eq!(loaded.revision, 0);
        assert!(loaded.state["entries"]["claude_code:one"].is_object());
    }

    #[test]
    fn state_error_drops_a_secret() {
        let tmp = Tmp::new();
        let dir = tmp.path.join("store");
        let state = json!({
            "entries": {
                "claude_code:a": {
                    "status": "failed",
                    "timestamp": 1,
                    "error": "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ"
                }
            }
        });
        assert!(cas_state(&dir, 0, state).unwrap());
        let loaded = load_state(&dir).unwrap();
        assert!(loaded.state["entries"]["claude_code:a"]["error"].is_null());
        let raw = fs::read_to_string(dir.join("state.json")).unwrap();
        assert!(!raw.contains("sk-ant-"), "{raw}");
    }

    fn apply(dir: &Path, key: &str) {
        for _ in 0..20 {
            let loaded = load_state(dir).unwrap();
            let mut entries = loaded
                .state
                .get("entries")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if entries.contains_key(key) {
                return;
            }
            entries.insert(
                key.to_string(),
                json!({"status": "submitted", "timestamp": 1, "error": null}),
            );
            let next = json!({ "entries": entries });
            if cas_state(dir, loaded.revision, next).unwrap() {
                return;
            }
        }
        panic!("lost {key}");
    }

    #[test]
    fn two_threads_keep_both_keys() {
        let tmp = Tmp::new();
        let dir = tmp.path.join("store");
        fs::create_dir_all(&dir).unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| apply(&dir, "claude_code:one"));
            scope.spawn(|| apply(&dir, "claude_code:two"));
        });
        let loaded = load_state(&dir).unwrap();
        assert!(loaded.state["entries"]["claude_code:one"].is_object());
        assert!(loaded.state["entries"]["claude_code:two"].is_object());
    }

    #[test]
    fn second_proposal_does_not_overwrite() {
        let tmp = Tmp::new();
        let dir = tmp.path.join("store");
        let first = proposal("- Decides on Tuesday [src: sess-1 #m2]\n");
        write_proposal(&dir, &first).unwrap();
        let err = write_proposal(&dir, &first).unwrap_err();
        assert!(err.to_lowercase().contains("already"), "{err}");
        let saved = fs::read_to_string(
            dir.join("proposals")
                .join("hi-abcdef01")
                .join("how-you-work.md"),
        )
        .unwrap();
        assert_eq!(saved, first.markdown);
        let meta: Value = serde_json::from_str(
            &fs::read_to_string(
                dir.join("proposals")
                    .join("hi-abcdef01")
                    .join("proposal.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(meta["applied"], false);
        assert_eq!(meta["status"], "unreviewed");
        assert_eq!(meta["format"], 1);
        assert_eq!(meta["kind"], "history-import");
    }

    #[test]
    fn proposal_refuses_a_secret_an_unsourced_line_and_applied() {
        let tmp = Tmp::new();
        let dir = tmp.path.join("store");
        let secret = proposal(
            "- key sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ [src: sess-1 #m1]\n",
        );
        let err = write_proposal(&dir, &secret).unwrap_err();
        assert!(err.to_lowercase().contains("secret"), "{err}");
        let unsourced = proposal("- Decides on Tuesday\n");
        let err = write_proposal(&dir, &unsourced).unwrap_err();
        assert!(err.to_lowercase().contains("source"), "{err}");
        let mut applied = proposal("- Decides on Tuesday [src: sess-1 #m2]\n");
        applied.applied = true;
        let err = write_proposal(&dir, &applied).unwrap_err();
        assert!(err.to_lowercase().contains("applied"), "{err}");
        assert!(!dir.join("proposals").exists());
    }

    #[test]
    fn secret_prompt_claude_model_and_claude_key_are_not_posted() {
        let mut posted = false;
        let local = route("ollama", "http://127.0.0.1:11434", "llama3.2");
        let outcome = ask_with(
            &local,
            "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ",
            None,
            |_, _, _| {
                posted = true;
                PostResult::Answer("no".into())
            },
        );
        assert!(!posted);
        assert_eq!(outcome.kind, "refused");
        assert!(!outcome.reason.contains("sk-ant-"), "{}", outcome.reason);

        let claude = route("xai", "https://api.x.ai/v1", "claude-3-haiku");
        let outcome = ask_with(&claude, "hello", Some("xai-key"), |_, _, _| {
            posted = true;
            PostResult::Answer("no".into())
        });
        assert!(!posted);
        assert_eq!(outcome.kind, "refused");

        let key = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
        let grok = route("xai", "https://api.x.ai/v1", "grok-2");
        let outcome = ask_with(&grok, "hello", Some(key), |_, _, _| {
            posted = true;
            PostResult::Answer("no".into())
        });
        assert!(!posted);
        assert!(!outcome.reason.contains("sk-ant-"), "{}", outcome.reason);
        assert_eq!(outcome.kind, "refused");
    }

    #[test]
    fn classify_retries_timeouts_and_a_body_is_not_kept() {
        assert_eq!(classify(408), "retryable");
        assert_eq!(classify(429), "retryable");
        assert_eq!(classify(500), "retryable");
        assert_eq!(classify(599), "retryable");
        assert_eq!(classify(400), "refused");
        assert_eq!(classify(401), "refused");
        assert_eq!(classify(403), "refused");
        assert_eq!(classify(200), "refused");
        let local = route("ollama", "http://127.0.0.1:11434/v1", "llama3.2");
        let outcome = ask_with(&local, "hello", None, |url, token, body| {
            assert!(url.ends_with("/v1/chat/completions"), "{url}");
            assert!(!url.contains("/v1/v1"), "{url}");
            assert_eq!(token, "monocode-ollama-local");
            assert!(body.contains("hello"));
            PostResult::Status(429)
        });
        assert_eq!(outcome.kind, "retryable");
        assert!(!outcome.reason.to_lowercase().contains("secret"));
        let down = ask_with(&local, "hello", None, |_, _, _| PostResult::Unreachable);
        assert_eq!(down.kind, "retryable");
    }

    #[test]
    fn ollama_and_other_urls() {
        assert_eq!(
            completions_url("ollama", "http://127.0.0.1:11434"),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        assert_eq!(
            completions_url("ollama", "http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        assert_eq!(
            completions_url("xai", "https://api.x.ai/v1/"),
            "https://api.x.ai/v1/chat/completions"
        );
    }

    #[test]
    fn hermes_home_profile_and_windows_default() {
        let tmp = Tmp::new();
        let home = tmp.path.join("home");
        fs::create_dir_all(home.join(".hermes")).unwrap();
        assert_eq!(
            resolve_hermes_home(&home, None, false, None),
            home.join(".hermes")
        );
        fs::write(home.join(".hermes").join("active_profile"), "Work\n").unwrap();
        assert_eq!(
            resolve_hermes_home(&home, None, false, None),
            home.join(".hermes").join("profiles").join("work")
        );
        fs::write(home.join(".hermes").join("active_profile"), " Default ").unwrap();
        assert_eq!(
            resolve_hermes_home(&home, None, false, None),
            home.join(".hermes")
        );
        let env = tmp.path.join("from-env");
        assert_eq!(
            resolve_hermes_home(&home, Some(env.to_str().unwrap()), false, None),
            env
        );
        assert_eq!(
            resolve_hermes_home(&home, Some("  "), false, None),
            home.join(".hermes")
        );
        let local = tmp.path.join("LocalApp");
        assert_eq!(
            resolve_hermes_home(&home, None, true, Some(local.to_str().unwrap())),
            local.join("hermes")
        );
        assert_eq!(
            resolve_hermes_home(&home, None, true, None),
            home.join("AppData").join("Local").join("hermes")
        );
    }

    #[test]
    fn submitted_chats_do_not_fill_the_next_list() {
        let tmp = Tmp::new();
        let home = tmp.path.join("home");
        let projects = home.join(".claude").join("projects");
        fs::create_dir_all(&projects).unwrap();
        for name in ["a.jsonl", "b.jsonl", "c.jsonl"] {
            let file = projects.join(name);
            fs::write(&file, b"{}\n").unwrap();
            age(&file);
        }
        let limits = Limits {
            max_files: 2,
            ..Limits::production()
        };
        let now = SystemTime::now();
        let first = list_checked(
            &home,
            None,
            false,
            None,
            &projects,
            "claude_code",
            None,
            now,
            limits,
        )
        .unwrap();
        assert!(first.truncated);
        assert_eq!(
            first
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.jsonl", "b.jsonl"]
        );
        let state = json!({
            "entries": {
                "claude_code:a.jsonl": { "status": "submitted", "timestamp": 1 },
                "claude_code:b.jsonl": { "status": "submitted", "timestamp": 1 }
            }
        });
        let second = list_checked(
            &home,
            None,
            false,
            None,
            &projects,
            "claude_code",
            Some(&state),
            now,
            limits,
        )
        .unwrap();
        assert_eq!(second.files.len(), 1);
        assert_eq!(second.files[0].path, "c.jsonl");
        assert!(!second.truncated);

        let hermes = home.join(".hermes");
        let session = hermes.join("sessions");
        fs::create_dir_all(&session).unwrap();
        let file = session.join("a.jsonl");
        fs::write(&file, b"{}\n").unwrap();
        age(&file);
        let open = json!({
            "entries": {
                "hermes:sessions/a.jsonl#one": { "status": "submitted", "timestamp": 1 }
            }
        });
        let still = list_checked(
            &home,
            None,
            false,
            None,
            &hermes,
            "hermes",
            Some(&open),
            now,
            limits,
        )
        .unwrap();
        assert_eq!(still.files.len(), 1);
        let done = json!({
            "entries": {
                "hermes:sessions/a.jsonl": { "status": "submitted", "timestamp": 1 }
            }
        });
        let skipped = list_checked(
            &home,
            None,
            false,
            None,
            &hermes,
            "hermes",
            Some(&done),
            now,
            limits,
        )
        .unwrap();
        assert!(skipped.files.is_empty());
        assert!(!skipped.truncated);
    }

    #[test]
    fn list_and_read_stay_inside_the_turned_on_source() {
        let tmp = Tmp::new();
        let home = tmp.path.join("home");
        let projects = home.join(".claude").join("projects");
        fs::create_dir_all(&projects).unwrap();
        let key = home.join("key.txt");
        fs::write(&key, b"SECRET").unwrap();
        let err = list_checked(
            &home,
            None,
            false,
            None,
            &home,
            "claude_code",
            None,
            SystemTime::now(),
            Limits::production(),
        )
        .unwrap_err();
        assert!(!err.contains("SECRET"), "{err}");
        fs::write(projects.join("key.txt"), b"SECRET").unwrap();
        let err = read_checked(
            &home,
            None,
            false,
            None,
            &projects,
            "key.txt",
            "claude_code",
            MAX_READ_BYTES,
        )
        .unwrap_err();
        assert!(!err.contains("SECRET"), "{err}");
        let err = read_checked(
            &home,
            None,
            false,
            None,
            &projects,
            "../key.txt",
            "claude_code",
            MAX_READ_BYTES,
        )
        .unwrap_err();
        assert!(!err.contains("SECRET"), "{err}");
        let outside = tmp.path.join("elsewhere");
        fs::create_dir_all(&outside).unwrap();
        let err = read_checked(
            &home,
            None,
            false,
            None,
            &outside,
            "key.txt",
            "claude_code",
            MAX_READ_BYTES,
        )
        .unwrap_err();
        assert!(!err.contains("SECRET"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn read_refuses_a_symlink_even_inside_the_root() {
        let tmp = Tmp::new();
        let home = tmp.path.join("home");
        let projects = home.join(".claude").join("projects");
        fs::create_dir_all(&projects).unwrap();
        let real = projects.join("real.jsonl");
        fs::write(&real, b"SECRET_LINK").unwrap();
        std::os::unix::fs::symlink(&real, projects.join("link.jsonl")).unwrap();
        let err = read_checked(
            &home,
            None,
            false,
            None,
            &projects,
            "link.jsonl",
            "claude_code",
            MAX_READ_BYTES,
        )
        .unwrap_err();
        assert!(!err.contains("SECRET_LINK"), "{err}");
    }

    #[test]
    fn a_different_chat_does_not_take_the_draft() {
        let tmp = Tmp::new();
        let dir = tmp.path.join("store");
        let first = proposal("- Decides on Tuesday [src: sess-1 #m2]\n");
        write_proposal(&dir, &first).unwrap();
        let mut other = proposal("- Something else [src: sess-2 #m1]\n");
        other.conversation_id = "sess-2".into();
        let err = write_proposal(&dir, &other).unwrap_err();
        assert!(err.to_lowercase().contains("different"), "{err}");
        assert!(!err.to_lowercase().contains("already"), "{err}");
        let saved = fs::read_to_string(
            dir.join("proposals")
                .join("hi-abcdef01")
                .join("how-you-work.md"),
        )
        .unwrap();
        assert_eq!(saved, first.markdown);
    }

    #[test]
    fn key_name_secret_is_not_stored() {
        assert!(has_secret("token=abcdefgh"));
        assert!(!has_secret("token=short"));
        let tmp = Tmp::new();
        let dir = tmp.path.join("store");
        let named = proposal("- token=abcdefgh [src: sess-1 #m1]\n");
        let err = write_proposal(&dir, &named).unwrap_err();
        assert!(err.to_lowercase().contains("secret"), "{err}");
        assert!(!dir.join("proposals").exists());
    }

    #[test]
    fn a_secret_in_the_path_is_not_stored() {
        let tmp = Tmp::new();
        let dir = tmp.path.join("store");
        let planted = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
        let mut named = proposal("- Decides on Tuesday [src: sess-1 #m1]\n");
        named.source_key = "notes/token=abcdefgh/chat.jsonl".into();
        let err = write_proposal(&dir, &named).unwrap_err();
        assert!(err.to_lowercase().contains("secret"), "{err}");
        assert!(!err.contains("abcdefgh"), "{err}");
        let mut shaped = proposal("- Decides on Tuesday [src: sess-1 #m1]\n");
        shaped.source_key = format!("notes/{planted}/chat.jsonl");
        let err = write_proposal(&dir, &shaped).unwrap_err();
        assert!(err.to_lowercase().contains("secret"), "{err}");
        assert!(!err.contains("PLANTED"), "{err}");
        let mut other = proposal("- Decides on Tuesday [src: sess-1 #m1]\n");
        other.project = "notes/token=abcdefgh".into();
        let err = write_proposal(&dir, &other).unwrap_err();
        assert!(err.to_lowercase().contains("secret"), "{err}");
        assert!(!dir.join("proposals").exists());

        let mut fine = proposal("- Decides on Tuesday [src: sess-1 #m1]\n");
        fine.source_key = "notes/token=short/chat.jsonl".into();
        write_proposal(&dir, &fine).unwrap();
        let saved = fs::read_to_string(
            dir.join("proposals")
                .join("hi-abcdef01")
                .join("proposal.json"),
        )
        .unwrap();
        assert!(saved.contains("token=short"));
        assert!(!saved.contains("abcdefgh"));
        assert!(!saved.contains("PLANTED"));

        let progress = tmp.path.join("progress");
        let state = json!({
            "entries": {
                "claude_code:notes/token=abcdefgh/chat.jsonl": {
                    "status": "failed",
                    "timestamp": 1,
                    "error": "Could not read notes/token=abcdefgh/chat.jsonl"
                },
                "claude_code:token=abcdefgh": {
                    "status": "failed",
                    "timestamp": 1,
                    "error": null
                },
                "claude_code:notes/chat.jsonl": {
                    "status": "failed",
                    "timestamp": 2,
                    "error": "Could not read notes/token=abcdefgh/chat.jsonl"
                },
                "claude_code:notes/token=short/chat.jsonl": {
                    "status": "submitted",
                    "timestamp": 3,
                    "error": null
                }
            }
        });
        let shaped_key = format!("claude_code:notes/{planted}/chat.jsonl");
        let mut with_shape = state;
        with_shape["entries"][&shaped_key] = json!({
            "status": "submitted",
            "timestamp": 4,
            "error": null
        });
        assert!(cas_state(&progress, 0, with_shape).unwrap());
        let text = fs::read_to_string(progress.join("state.json")).unwrap();
        assert!(!text.contains("abcdefgh"), "{text}");
        assert!(!text.contains("PLANTED"), "{text}");
        assert!(text.contains("notes/chat.jsonl"), "{text}");
        assert!(text.contains("token=short"), "{text}");
    }

    #[test]
    fn ask_does_not_post_to_an_arbitrary_url() {
        let mut posted = false;
        let ollama = route("ollama", "https://example.com", "llama3.2");
        let outcome = ask_with(&ollama, "hello", None, |_, _, _| {
            posted = true;
            PostResult::Answer("no".into())
        });
        assert!(!posted);
        assert_eq!(outcome.kind, "refused");
        posted = false;
        let xai = route("xai", "https://example.com/v1", "grok-2");
        let outcome = ask_with(&xai, "hello", Some("xai-key"), |_, _, _| {
            posted = true;
            PostResult::Answer("no".into())
        });
        assert!(!posted);
        assert_eq!(outcome.kind, "refused");
        posted = false;
        let custom = route("custom", "https://example.com/v1", "my-model");
        let outcome = ask_with(&custom, "hello", Some("custom-key"), |_, _, _| {
            posted = true;
            PostResult::Answer("no".into())
        });
        assert!(!posted, "a custom address is still an arbitrary url");
        assert_eq!(outcome.kind, "refused");
    }

    #[test]
    fn progress_replace_keeps_the_previous_file() {
        let tmp = Tmp::new();
        let dir = tmp.path.join("store");
        fs::create_dir_all(&dir).unwrap();
        let first = json!({
            "entries": {
                "claude_code:a.jsonl": { "status": "submitted", "timestamp": 1, "error": null }
            }
        });
        assert!(cas_state(&dir, 0, first).unwrap());
        let second = json!({
            "entries": {
                "claude_code:a.jsonl": { "status": "submitted", "timestamp": 1, "error": null },
                "claude_code:b.jsonl": { "status": "submitted", "timestamp": 2, "error": null }
            }
        });
        assert!(cas_state(&dir, 1, second).unwrap());
        let backup: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("state.json.bak")).unwrap()).unwrap();
        assert_eq!(backup["revision"], 1);
        assert!(backup["state"]["entries"]["claude_code:a.jsonl"].is_object());
        assert!(backup["state"]["entries"]
            .get("claude_code:b.jsonl")
            .is_none());
        let current: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("state.json")).unwrap()).unwrap();
        assert_eq!(current["revision"], 2);
        fs::remove_file(dir.join("state.json")).unwrap();
        let loaded = load_state(&dir).unwrap();
        assert_eq!(loaded.revision, 1);
        assert!(loaded.state["entries"]["claude_code:a.jsonl"].is_object());
        assert!(loaded.state["entries"].get("claude_code:b.jsonl").is_none());
    }

    fn plant(dir: &Path, id: &str, markdown: &str) {
        let folder = dir.join("proposals").join(id);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("how-you-work.md"), markdown).unwrap();
        fs::write(
            folder.join("proposal.json"),
            serde_json::to_vec_pretty(&json!({
                "format": 1,
                "kind": "history-import",
                "status": "unreviewed",
                "applied": false,
                "source": "claude_code",
                "conversationId": "sess-1",
                "project": "notes",
                "sourceKey": "notes/chat.jsonl",
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn proposals_are_listed_in_order_and_a_missing_folder_is_empty() {
        let tmp = Tmp::new();
        assert!(list_proposals(&tmp.path).unwrap().is_empty());
        plant(&tmp.path, "hi-bbbb", "- Second [src: sess-1 #m2]\n");
        plant(&tmp.path, "hi-aaaa", "- First [src: sess-1 #m1]\n");
        let listed = list_proposals(&tmp.path).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "hi-aaaa");
        assert_eq!(listed[1].id, "hi-bbbb");
        assert_eq!(listed[0].status, "unreviewed");
    }

    #[test]
    fn a_secret_proposal_is_not_returned() {
        let tmp = Tmp::new();
        let secret = "sk-ant-api03-abcdefghijklmnopqrst";
        plant(
            &tmp.path,
            "hi-secret",
            &format!("- {secret} [src: sess-1 #m1]\n"),
        );
        plant(
            &tmp.path,
            "hi-ok",
            "- Likes small commits [src: sess-1 #m1]\n",
        );
        let listed = list_proposals(&tmp.path).unwrap();
        let text = serde_json::to_string(&listed).unwrap();
        assert!(!text.contains(secret));
        assert!(!text.contains("sk-ant"));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "hi-ok");
    }

    #[test]
    fn a_proposal_is_reviewed_once_and_stays_unapplied() {
        let tmp = Tmp::new();
        plant(
            &tmp.path,
            "hi-abcdef01",
            "- Likes small commits [src: sess-1 #m1]\n",
        );
        assert!(review_proposal(&tmp.path, "hi-abcdef01", "confirmed").unwrap());
        assert!(!review_proposal(&tmp.path, "hi-abcdef01", "rejected").unwrap());
        assert!(!review_proposal(&tmp.path, "hi-missing1", "confirmed").unwrap());
        let meta: Value = serde_json::from_str(
            &fs::read_to_string(tmp.path.join("proposals/hi-abcdef01/proposal.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta["status"], "confirmed");
        assert_eq!(meta["applied"], false);
        assert!(review_proposal(&tmp.path, "../hi-abcdef01", "confirmed").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_proposal_is_not_listed() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let outside = tmp.path.join("outside");
        fs::create_dir(&outside).unwrap();
        let secret = "sk-ant-api03-abcdefghijklmnopqrst";
        fs::write(outside.join("how-you-work.md"), secret).unwrap();
        fs::create_dir_all(tmp.path.join("proposals")).unwrap();
        symlink(&outside, tmp.path.join("proposals/hi-link")).unwrap();
        let text = serde_json::to_string(&list_proposals(&tmp.path).unwrap()).unwrap();
        assert!(!text.contains(secret));
        assert!(list_proposals(&tmp.path).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_temp_file_is_not_followed() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let outside = tmp.path.join("outside.json");
        let marker = "keep-these-bytes";
        fs::write(&outside, marker).unwrap();
        plant(
            &tmp.path,
            "hi-abcdef01",
            "- Likes small commits [src: sess-1 #m1]\n",
        );
        symlink(
            &outside,
            tmp.path.join("proposals/hi-abcdef01/proposal.json.tmp"),
        )
        .unwrap();
        assert!(review_proposal(&tmp.path, "hi-abcdef01", "confirmed").unwrap());
        assert_eq!(fs::read_to_string(&outside).unwrap(), marker);
        let meta_path = tmp.path.join("proposals/hi-abcdef01/proposal.json");
        assert!(meta_path.is_file());
        assert!(!is_link(&meta_path));
        let meta: Value = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
        assert_eq!(meta["status"], "confirmed");
        assert_eq!(meta["applied"], false);
    }
}
