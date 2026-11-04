//! Portable (Phase 5, docs/PORTABLE.md): export the whole setup, and when ticked the memory and the workspace, to a
//! folder or one `.tar.gz`; import one back after a preview, only ever adding.
//!
//! ```text
//! manifest.json                 format, version, what was ticked, counts, every file with its size and SHA-256
//! setup/                        written by the webview (it owns these stores): setup.json, projects/<id>.json,
//!                               monos/<id>/{mono.json,SOUL.md,habits.json,sheet.md,skills.json[,MEMORY.md,memory/]},
//!                               (mono.json may carry roleLabel: Ash's own sidebar role line; "" = cleared),
//!                               connectors.json (names and where each login lives, never the login)
//! memory/<project>/…            Ash OS project memory, only if ticked; <project>.git.bundle with its history if ticked
//! workspace/                    only if ticked: sessions/<id>.json (transcript, engine, provider transcript pointer),
//!                               notes.json + note-assets/, automations.json, reminders.json, delegations.json,
//!                               hub/ (the webview's group chats)
//! ```
//!
//! Every text that goes into an export passes the secret scrubber (one pattern list with the webview:
//! `src/features/portable/model/secretPatterns.json`), and the finished export is scanned again: one hit and nothing
//! is left behind. Import never overwrites: a chat, note or memory file that is already here and differs is kept, and
//! the file's version comes in beside it only when asked. Automations come back paused, delegations as history only,
//! and a dev copy never keeps a provider session id or writes into the real memory folder.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::session_store::{self, now_millis, SessionStore, SessionUpsert};

pub const FORMAT: &str = "monocode-hub-export";
/// The newest export format this build writes and reads. A newer one is refused, never half-read.
pub const VERSION: u64 = 2;
const V1_FORMAT: &str = "monocode-hub-setup";
const MANIFEST: &str = "manifest.json";
/// Unpacked size and entry caps for an archive: a damaged or hostile file can't fill the disk.
const MAX_UNPACKED: u64 = 8 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 500_000;
/// The folders the webview writes and reads back; everything else is this module's.
const WEBVIEW_PREFIXES: [&str; 2] = ["setup/", "workspace/hub/"];

// ---- the secret scrubber -------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatternFile {
    marker: String,
    patterns: Vec<PatternSpec>,
    secret_keys: String,
}

#[derive(Deserialize)]
struct PatternSpec {
    name: String,
    regex: String,
    #[serde(default)]
    flags: String,
    #[serde(default)]
    group: Option<usize>,
    #[serde(default)]
    mixed: bool,
}

struct Pattern {
    name: String,
    regex: Regex,
    group: Option<usize>,
    mixed: bool,
}

pub struct Scrubber {
    marker: String,
    patterns: Vec<Pattern>,
    keys: Regex,
    /// A key name from the shared list, then a value of 8 or more characters.
    /// Chat text is not JSON, so `redact_value` never sees it.
    assignment: Regex,
}

/// The one scrubber, from the pattern list the webview uses too.
pub fn scrubber() -> &'static Scrubber {
    static SCRUBBER: OnceLock<Scrubber> = OnceLock::new();
    SCRUBBER.get_or_init(|| {
        Scrubber::load(include_str!(
            "../../src/features/portable/model/secretPatterns.json"
        ))
        .expect("secretPatterns.json compiles")
    })
}

impl Scrubber {
    fn load(text: &str) -> Result<Self, String> {
        let file: PatternFile = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let mut patterns = Vec::new();
        for spec in file.patterns {
            let source = if spec.flags.contains('i') {
                format!("(?i){}", spec.regex)
            } else {
                spec.regex.clone()
            };
            patterns.push(Pattern {
                regex: Regex::new(&source).map_err(|e| format!("{}: {e}", spec.name))?,
                name: spec.name,
                group: spec.group,
                mixed: spec.mixed,
            });
        }
        let bare = file
            .secret_keys
            .trim_start_matches('^')
            .trim_end_matches('$');
        let assignment =
            format!(r#"(?i)(?:^|[\s,{{"'])["']?{bare}["']?\s*[:=]\s*["']?([^\s"',}}\]]{{8,}})"#);
        Ok(Self {
            marker: file.marker,
            patterns,
            keys: Regex::new(&format!("(?i){}", file.secret_keys)).map_err(|e| e.to_string())?,
            assignment: Regex::new(&assignment).map_err(|e| e.to_string())?,
        })
    }

    fn qualifies(&self, text: &str, mixed: bool) -> bool {
        text != self.marker
            && (!mixed
                || (text.chars().any(|c| c.is_ascii_alphabetic())
                    && text.chars().any(|c| c.is_ascii_digit())))
    }

    /// The text with every secret replaced by the marker, and how many were.
    pub fn redact_text(&self, text: &str) -> (String, usize) {
        let mut out = text.to_string();
        let mut count = 0;
        for pattern in &self.patterns {
            if !pattern.regex.is_match(&out) {
                continue;
            }
            let mut next = String::with_capacity(out.len());
            let mut last = 0;
            for caps in pattern.regex.captures_iter(&out) {
                let found = match pattern.group {
                    Some(group) => caps.get(group),
                    None => caps.get(0),
                };
                let Some(found) = found else { continue };
                if !self.qualifies(found.as_str(), pattern.mixed) {
                    continue;
                }
                next.push_str(&out[last..found.start()]);
                next.push_str(&self.marker);
                last = found.end();
                count += 1;
            }
            if last > 0 {
                next.push_str(&out[last..]);
                out = next;
            }
        }
        (out, count)
    }

    /// Scrubs every string in a JSON value; a value under a secret-looking key goes whatever it looks like.
    pub fn redact_value(&self, value: &mut Value) -> usize {
        match value {
            Value::String(text) => {
                let (clean, count) = self.redact_text(text);
                if count > 0 {
                    *text = clean;
                }
                count
            }
            Value::Array(items) => items.iter_mut().map(|item| self.redact_value(item)).sum(),
            Value::Object(map) => {
                let mut count = 0;
                for (key, item) in map.iter_mut() {
                    if self.keys.is_match(key) {
                        if let Value::String(text) = item {
                            if text.len() >= 8 && *text != self.marker {
                                *text = self.marker.clone();
                                count += 1;
                                continue;
                            }
                        }
                    }
                    count += self.redact_value(item);
                }
                count
            }
            _ => 0,
        }
    }

    /// The names of the patterns that still find something in `text`.
    pub fn findings(&self, text: &str) -> Vec<String> {
        let mut names = BTreeSet::new();
        for pattern in &self.patterns {
            for caps in pattern.regex.captures_iter(text) {
                let found = match pattern.group {
                    Some(group) => caps.get(group),
                    None => caps.get(0),
                };
                if found.is_some_and(|found| self.qualifies(found.as_str(), pattern.mixed)) {
                    names.insert(pattern.name.clone());
                    break;
                }
            }
        }
        names.into_iter().collect()
    }

    /// A token shape, or a value of 8 or more characters written after a key name.
    pub fn has_secret(&self, text: &str) -> bool {
        if !self.findings(text).is_empty() {
            return true;
        }
        self.assignment.captures_iter(text).any(|caps| {
            caps.get(1)
                .is_some_and(|value| value.as_str().len() >= 8 && value.as_str() != self.marker)
        })
    }
}

// ---- where things live ---------------------------------------------------------------------------------------------

/// Everything this module reads or writes, so the tests can point it all at temporary folders.
#[derive(Clone, Debug)]
pub struct Env {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    /// The Ash OS project memory: one folder per project, the global layer included.
    pub memory_root: PathBuf,
    /// A dev copy: it never keeps a provider session id from a file.
    pub dev: bool,
    /// Folders this copy must never write into (a dev copy: the real memory folder and the daily data folder).
    pub protected: Vec<PathBuf>,
    /// Claude Code's config folder, to say where a chat's provider transcript is.
    pub claude_home: Option<PathBuf>,
    pub home: Option<PathBuf>,
    /// Where the Monos live (`mono::resolved_root`): on the daily app `~/agent-memory/monos`, inside `memory_root`, so a
    /// memory restore can write a Mono's soul, and the report names each one (`souls_restored`).
    pub monos_root: PathBuf,
}

impl Env {
    pub fn for_app(app: &AppHandle) -> Result<Self, String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let dev = crate::instance::kind() == crate::instance::Kind::Dev;
        let home = crate::dirs_home().map(PathBuf::from);
        let configured = std::env::var_os("MONOCODE_HUB_MEMORY_ROOT")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        // The daily app reads and adds to ~/agent-memory; a dev copy keeps its own, inside its data folder.
        let memory_root = configured.unwrap_or_else(|| {
            if dev {
                data_dir.join("agent-memory")
            } else {
                home.clone().unwrap_or_default().join("agent-memory")
            }
        });
        let mut protected = Vec::new();
        if dev {
            for base in [crate::instance::real_home(), home.clone()]
                .into_iter()
                .flatten()
            {
                protected.push(base.join("agent-memory"));
                protected.push(base.join("Library/Application Support/com.ash.monocode-hub"));
                protected.push(base.join(".claude"));
            }
        }
        let claude_home = crate::instance::dev_claude_config_dir()
            .ok()
            .flatten()
            .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
            .or_else(|| home.as_ref().map(|home| home.join(".claude")));
        Ok(Self {
            monos_root: crate::mono::resolved_root(&data_dir),
            db_path: data_dir.join("monocode.db"),
            data_dir,
            memory_root,
            dev,
            protected,
            claude_home,
            home,
        })
    }

    /// The Monos home in use (`monos_root`, what mono.rs `resolved_root` settled on: `~/agent-memory/monos` on the daily
    /// app, the slot's own on a dev copy). Only while it isn't there yet, `<app data>/monos`, where Monos lived before.
    /// After the move the old folder is a stale copy, so it is never read while the home exists.
    pub fn mono_home(&self) -> PathBuf {
        if self.monos_root.is_dir() {
            self.monos_root.clone()
        } else {
            self.data_dir.join("monos")
        }
    }

    fn read_db(&self) -> Result<Option<Connection>, String> {
        if !self.db_path.is_file() {
            return Ok(None);
        }
        let conn = Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        Ok(Some(conn))
    }

    /// Refuses a write into a protected folder (symlinks resolved in the part that exists).
    fn check_writable(&self, target: &Path) -> Result<(), String> {
        let target = resolved(target);
        for protected in &self.protected {
            let protected = resolved(protected);
            if target == protected || target.starts_with(&protected) {
                return Err(format!(
                    "A dev copy never writes into {}. Pick another folder.",
                    protected.display()
                ));
            }
        }
        Ok(())
    }
}

/// The path with symlinks resolved in the part that exists, so a link into a protected folder is caught too.
fn resolved(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut out = existing.canonicalize().unwrap_or(existing);
    for name in rest.into_iter().rev() {
        out.push(name);
    }
    out
}

/// A relative path inside an export: plain names only, no `..`, nothing absolute or hidden.
fn safe_relative(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\\') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in Path::new(path).components() {
        match part {
            Component::Normal(name) => {
                let name = name.to_str()?;
                if name.starts_with('.') && name != ".gitkeep" {
                    return None;
                }
                out.push(name);
            }
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// A memory folder or id that is one plain name.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Owner-only files: an export holds Ash's chats and memory.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Writes beside the target and renames over it, so a crash never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        uuid::Uuid::new_v4().simple()
    ));
    write_private(&temp, bytes)?;
    fs::rename(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("{}: {e}", path.display())
    })
}

/// A folder this module made for itself, removed when it goes out of scope.
struct Scratch(PathBuf);

impl Scratch {
    fn beside(target: &Path, label: &str) -> Result<Self, String> {
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let dir = parent.join(format!(
            ".monocode-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Self(dir))
    }

    fn temp(label: &str) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!(
            "monocode-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Self(dir))
    }

    fn keep(mut self) -> PathBuf {
        std::mem::take(&mut self.0)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

// ---- database rows as JSON -----------------------------------------------------------------------------------------

fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let names = statement
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect();
    names
}

fn has_table(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
}

fn cell(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(n) => json!(n),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

/// Every row of `table` as `{column: value}`, ordered by `order`.
fn table_rows(
    conn: &Connection,
    table: &str,
    order: &str,
) -> rusqlite::Result<Vec<Map<String, Value>>> {
    if !has_table(conn, table)? {
        return Ok(Vec::new());
    }
    let columns = table_columns(conn, table)?;
    let mut statement = conn.prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))?;
    let rows = statement
        .query_map([], |row| {
            let mut object = Map::new();
            for (index, column) in columns.iter().enumerate() {
                object.insert(column.clone(), cell(row.get_ref(index)?));
            }
            Ok(object)
        })?
        .collect();
    rows
}

fn sql_value(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .map(rusqlite::types::Value::Integer)
            .unwrap_or_else(|| rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

/// Inserts the columns this table has; a row whose key is taken is left alone. Returns whether it went in.
fn insert_row(conn: &Connection, table: &str, row: &Map<String, Value>) -> rusqlite::Result<bool> {
    let local = table_columns(conn, table)?;
    let columns: Vec<&String> = local.iter().filter(|c| row.contains_key(*c)).collect();
    if columns.is_empty() {
        return Ok(false);
    }
    let names = columns
        .iter()
        .map(|c| c.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let marks = (1..=columns.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let values: Vec<rusqlite::types::Value> = columns.iter().map(|c| sql_value(&row[*c])).collect();
    let changed = conn.execute(
        &format!("INSERT OR IGNORE INTO {table} ({names}) VALUES ({marks})"),
        rusqlite::params_from_iter(values),
    )?;
    Ok(changed > 0)
}

// ---- export --------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Form {
    Folder,
    Archive,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryChoice {
    /// Memory folders by name (the global layer `ash` among them).
    pub projects: Vec<String>,
    /// Each folder's git history, as a bundle beside it.
    #[serde(default)]
    pub history: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    /// The folder to create (folder form) or the file to write (archive form).
    pub destination: String,
    pub form: Form,
    /// The webview's files, by path inside the export (`setup/…`, `workspace/hub/…`).
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub memory: Option<MemoryChoice>,
    #[serde(default)]
    pub workspace: bool,
    /// The webview's own counts (projects, Monos, …), merged into the manifest's.
    #[serde(default)]
    pub counts: Map<String, Value>,
    /// Which build made it (version, commit), for the manifest.
    #[serde(default)]
    pub app: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub form: Form,
    pub counts: Map<String, Value>,
    pub secrets_removed: usize,
    pub files: usize,
    pub bytes: u64,
    /// Plain lines about what was left out and why.
    pub notes: Vec<String>,
}

struct Writer {
    root: PathBuf,
    secrets: usize,
    files: Vec<(String, u64, String)>,
}

impl Writer {
    fn text(&mut self, relative: &str, text: &str) -> Result<(), String> {
        let path = safe_relative(relative)
            .ok_or_else(|| format!("Not a path inside an export: {relative}"))?;
        // A file without secrets goes byte for byte as it is (a Mono's habits.json stays as written).
        let clean = if relative.ends_with(".json") {
            match serde_json::from_str::<Value>(text) {
                Ok(mut value) => {
                    let count = scrubber().redact_value(&mut value);
                    self.secrets += count;
                    if count == 0 {
                        text.to_string()
                    } else {
                        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
                    }
                }
                Err(_) => {
                    let (clean, count) = scrubber().redact_text(text);
                    self.secrets += count;
                    clean
                }
            }
        } else {
            let (clean, count) = scrubber().redact_text(text);
            self.secrets += count;
            clean
        };
        self.raw(relative, &path, clean.as_bytes())
    }

    fn json(&mut self, relative: &str, value: &Value) -> Result<(), String> {
        let mut value = value.clone();
        self.secrets += scrubber().redact_value(&mut value);
        let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        let path = safe_relative(relative)
            .ok_or_else(|| format!("Not a path inside an export: {relative}"))?;
        self.raw(relative, &path, text.as_bytes())
    }

    /// A binary file (an image, a git bundle) copied as it is.
    fn binary(&mut self, relative: &str, source: &Path) -> Result<(), String> {
        let path = safe_relative(relative)
            .ok_or_else(|| format!("Not a path inside an export: {relative}"))?;
        let bytes = fs::read(source).map_err(|e| format!("{}: {e}", source.display()))?;
        self.raw(relative, &path, &bytes)
    }

    fn raw(&mut self, relative: &str, path: &Path, bytes: &[u8]) -> Result<(), String> {
        write_private(&self.root.join(path), bytes)?;
        self.files
            .push((relative.to_string(), bytes.len() as u64, sha256_hex(bytes)));
        Ok(())
    }
}

fn is_binary(relative: &str) -> bool {
    relative.ends_with(".bundle") || relative.starts_with("workspace/note-assets/")
}

/// The archive's top folder: the file name without `.tar.gz`.
fn archive_stem(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("monocode-hub-export");
    let stem = name
        .strip_suffix(".tar.gz")
        .or_else(|| name.strip_suffix(".tgz"))
        .unwrap_or(name);
    if stem.is_empty() {
        "monocode-hub-export".into()
    } else {
        stem.into()
    }
}

pub fn export(env: &Env, request: &ExportRequest) -> Result<ExportReport, String> {
    let mut destination = crate::fs::expand_home(request.destination.trim());
    if request.destination.trim().is_empty() || !destination.is_absolute() {
        return Err("Pick where the export goes.".into());
    }
    if request.form == Form::Archive {
        let name = destination
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if !name.ends_with(".tar.gz") && !name.ends_with(".tgz") {
            destination = destination.with_file_name(format!("{name}.tar.gz"));
        }
    } else if destination.exists() {
        return Err(format!(
            "{} already exists. Pick another name.",
            destination.display()
        ));
    }
    env.check_writable(&destination)?;
    for path in request.files.keys() {
        if !WEBVIEW_PREFIXES
            .iter()
            .any(|prefix| path.starts_with(prefix))
            || safe_relative(path).is_none()
        {
            return Err(format!("Not a setup file: {path}"));
        }
    }

    let staging = Scratch::beside(&destination, "export")?;
    let mut writer = Writer {
        root: staging.0.clone(),
        secrets: 0,
        files: Vec::new(),
    };
    let mut counts = request.counts.clone();
    let mut notes = Vec::new();

    for (path, text) in &request.files {
        writer.text(path, text)?;
    }
    if let Some(choice) = &request.memory {
        export_memory(env, choice, &mut writer, &mut counts, &mut notes)?;
    }
    if request.workspace {
        if let Some(conn) = env.read_db()? {
            export_workspace(env, &conn, &mut writer, &mut counts).map_err(|e| e.to_string())?;
        }
        export_note_assets(env, &mut writer, &counts)?;
        counts.remove("noteIds");
    }

    // The last net: nothing written may still look like a secret.
    for (relative, _, _) in &writer.files {
        if is_binary(relative) {
            continue;
        }
        let text = fs::read_to_string(staging.0.join(relative)).unwrap_or_default();
        let found = scrubber().findings(&text);
        if !found.is_empty() {
            return Err(format!(
                "{relative} still holds something that looks like a secret ({}). Nothing was exported.",
                found.join(", ")
            ));
        }
    }

    let manifest = json!({
        "format": FORMAT,
        "version": VERSION,
        "createdAt": now_millis(),
        "app": request.app,
        "parts": {
            "setup": true,
            "memory": request.memory.as_ref().map(|m| json!({"projects": m.projects, "history": m.history})).unwrap_or(Value::Bool(false)),
            "workspace": request.workspace,
        },
        "counts": counts,
        "secretsRemoved": writer.secrets,
        "notes": notes,
        "files": writer.files.iter().map(|(path, bytes, sha)| json!({"path": path, "bytes": bytes, "sha256": sha})).collect::<Vec<_>>(),
    });
    write_private(
        &staging.0.join(MANIFEST),
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )?;
    let bytes: u64 = writer.files.iter().map(|(_, size, _)| size).sum();
    let file_count = writer.files.len() + 1;

    match request.form {
        Form::Folder => {
            let dir = staging.keep();
            fs::rename(&dir, &destination).map_err(|e| {
                let _ = fs::remove_dir_all(&dir);
                format!("{}: {e}", destination.display())
            })?;
        }
        Form::Archive => {
            let partial = destination.with_file_name(format!(
                ".{}.partial",
                destination
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("export")
            ));
            let result = (|| -> Result<(), String> {
                let file = fs::File::create(&partial)
                    .map_err(|e| format!("{}: {e}", partial.display()))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
                }
                let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
                let mut tar = tar::Builder::new(gz);
                tar.mode(tar::HeaderMode::Deterministic);
                tar.append_dir_all(archive_stem(&destination), &staging.0)
                    .map_err(|e| e.to_string())?;
                let gz = tar.into_inner().map_err(|e| e.to_string())?;
                gz.finish()
                    .map_err(|e| e.to_string())?
                    .sync_all()
                    .map_err(|e| e.to_string())?;
                fs::rename(&partial, &destination)
                    .map_err(|e| format!("{}: {e}", destination.display()))
            })();
            if result.is_err() {
                let _ = fs::remove_file(&partial);
            }
            result?;
        }
    }

    Ok(ExportReport {
        path: destination.to_string_lossy().into_owned(),
        form: request.form,
        counts,
        secrets_removed: writer.secrets,
        files: file_count,
        bytes,
        notes,
    })
}

/// The memory folders a project's memory can be read from: each folder under the root with a MEMORY.md.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFolder {
    pub name: String,
    pub files: usize,
    pub bytes: u64,
    pub history: bool,
    /// The layer every project reads (`ash`, `global`).
    pub global: bool,
}

pub fn memory_folders(env: &Env) -> Vec<MemoryFolder> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&env.memory_root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !path.is_dir() || !plain_name(&name) || !path.join("MEMORY.md").is_file() {
            continue;
        }
        let files = memory_files(&path);
        out.push(MemoryFolder {
            files: files.len(),
            bytes: files.iter().map(|(_, size)| size).sum(),
            history: path.join(".git").exists(),
            global: name == "ash" || name == "global",
            name,
        });
    }
    out.sort_by(|a, b| b.global.cmp(&a.global).then(a.name.cmp(&b.name)));
    out
}

/// A memory folder's markdown files, by path inside it; nothing hidden, no links followed.
fn memory_files(dir: &Path) -> Vec<(String, u64)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, u64)>, depth: usize) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() && depth < 6 {
                walk(base, &path, out, depth + 1);
            } else if kind.is_file() && name.to_ascii_lowercase().ends_with(".md") {
                if let Ok(relative) = path.strip_prefix(base) {
                    let relative = relative.to_string_lossy().replace('\\', "/");
                    if safe_relative(&relative).is_some() {
                        out.push((relative, entry.metadata().map(|m| m.len()).unwrap_or(0)));
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out, 0);
    out.sort();
    out
}

fn export_memory(
    env: &Env,
    choice: &MemoryChoice,
    writer: &mut Writer,
    counts: &mut Map<String, Value>,
    notes: &mut Vec<String>,
) -> Result<(), String> {
    let mut projects = 0;
    let mut files = 0;
    let wanted: BTreeSet<&String> = choice.projects.iter().collect();
    for name in wanted {
        let dir = env.memory_root.join(name);
        if !plain_name(name) || !dir.join("MEMORY.md").is_file() {
            notes.push(format!("No memory folder called {name}; left out."));
            continue;
        }
        projects += 1;
        for (relative, _) in memory_files(&dir) {
            let text =
                fs::read_to_string(dir.join(&relative)).map_err(|e| format!("{relative}: {e}"))?;
            writer.text(&format!("memory/{name}/{relative}"), &text)?;
            files += 1;
        }
        if choice.history && dir.join(".git").exists() {
            match history_bundle(&dir) {
                Ok(bundle) => {
                    writer.binary(&format!("memory/{name}.git.bundle"), &bundle.1)?;
                }
                Err(why) => notes.push(format!("The history of {name} was left out: {why}")),
            }
        }
    }
    counts.insert("memoryProjects".into(), json!(projects));
    counts.insert("memoryFiles".into(), json!(files));
    Ok(())
}

/// A git bundle of the folder's whole history, unless an old commit holds something that looks like a secret.
fn history_bundle(dir: &Path) -> Result<(Scratch, PathBuf), String> {
    let log = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["log", "--all", "-p", "--format=%H%n%an <%ae>%n%s%n%b"])
        .output()
        .map_err(|e| format!("git didn't run ({e})"))?;
    if !log.status.success() {
        return Err("git couldn't read it".into());
    }
    let found = scrubber().findings(&String::from_utf8_lossy(&log.stdout));
    if !found.is_empty() {
        return Err(format!(
            "an old commit holds something that looks like a secret ({})",
            found.join(", ")
        ));
    }
    let scratch = Scratch::temp("bundle")?;
    let bundle = scratch.0.join("history.bundle");
    let made = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["bundle", "create"])
        .arg(&bundle)
        .arg("--all")
        .output()
        .map_err(|e| format!("git didn't run ({e})"))?;
    if !made.status.success() || !bundle.is_file() {
        return Err("git couldn't bundle it".into());
    }
    Ok((scratch, bundle))
}

fn session_file_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// The transcript as the chat shows it: a Mono's indexed blocks, else the session's own.
fn session_blocks(
    conn: &Connection,
    id: &str,
    blocks_json: &str,
) -> rusqlite::Result<(Vec<Value>, bool)> {
    if has_table(conn, "mono_transcripts")? && crate::mono_transcript::is_indexed(conn, id)? {
        let mut statement =
            conn.prepare("SELECT block_json FROM mono_blocks WHERE session_id = ?1 ORDER BY seq")?;
        let blocks = statement
            .query_map([id], |row| row.get::<_, String>(0))?
            .filter_map(|raw| raw.ok().and_then(|raw| serde_json::from_str(&raw).ok()))
            .collect();
        return Ok((blocks, true));
    }
    let blocks = serde_json::from_str::<Value>(blocks_json)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    Ok((blocks, false))
}

/// Where a Claude chat's own transcript is on this Mac, if it is.
fn claude_transcript(env: &Env, provider_session_id: &str) -> Option<PathBuf> {
    if !session_file_id(provider_session_id) {
        return None;
    }
    let projects = env.claude_home.as_ref()?.join("projects");
    let name = format!("{provider_session_id}.jsonl");
    fs::read_dir(projects).ok()?.flatten().find_map(|dir| {
        let candidate = dir.path().join(&name);
        candidate.is_file().then_some(candidate)
    })
}

struct SessionRow {
    id: String,
    cwd: String,
    harness: String,
    model: String,
    model_settings: String,
    runtime_mode: String,
    title: String,
    provider_session_id: Option<String>,
    blocks_json: String,
    created_at: i64,
    updated_at: i64,
    branch: Option<String>,
    context_used: Option<i64>,
    context_window: Option<i64>,
    archived: bool,
    worktree_cwd: Option<String>,
    pinned: bool,
    linked_work_item_json: Option<String>,
    worktree_removed: bool,
    automation_id: Option<String>,
    sidebar_hidden: bool,
}

fn export_workspace(
    env: &Env,
    conn: &Connection,
    writer: &mut Writer,
    counts: &mut Map<String, Value>,
) -> rusqlite::Result<()> {
    let columns = table_columns(conn, "sessions")?;
    let legacy_inbox = if columns.iter().any(|c| c == "inbox_ask") {
        "WHERE inbox_ask IS NULL"
    } else {
        ""
    };
    let mut statement = conn.prepare(&format!(
        "SELECT id, cwd, harness, model, model_settings, runtime_mode, title, provider_session_id, blocks_json,
                created_at, updated_at, branch, context_used, context_window, archived, worktree_cwd, pinned,
                linked_work_item_json, worktree_removed, automation_id, sidebar_hidden
         FROM sessions {legacy_inbox} ORDER BY created_at, id"
    ))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                cwd: row.get(1)?,
                harness: row.get(2)?,
                model: row.get(3)?,
                model_settings: row.get(4)?,
                runtime_mode: row.get(5)?,
                title: row.get(6)?,
                provider_session_id: row.get(7)?,
                blocks_json: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                branch: row.get(11)?,
                context_used: row.get(12)?,
                context_window: row.get(13)?,
                archived: row.get::<_, i64>(14)? != 0,
                worktree_cwd: row.get(15)?,
                pinned: row.get::<_, i64>(16)? != 0,
                linked_work_item_json: row.get(17)?,
                worktree_removed: row.get::<_, i64>(18)? != 0,
                automation_id: row.get(19)?,
                sidebar_hidden: row.get::<_, i64>(20)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut sessions = 0;
    for row in rows {
        let id = row.id.clone();
        if !session_file_id(&id) {
            continue;
        }
        let (blocks, mono) = session_blocks(conn, &id, &row.blocks_json)?;
        if blocks.is_empty() {
            continue;
        }
        let harness = row.harness.clone();
        let pointer = row
            .provider_session_id
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(|provider| {
                let path = (harness == "claude")
                    .then(|| claude_transcript(env, provider))
                    .flatten()
                    .map(|p| p.to_string_lossy().into_owned());
                json!({"harness": harness, "providerSessionId": provider, "path": path})
            });
        let file = json!({
            "id": id,
            "title": row.title,
            "cwd": row.cwd,
            "worktreeCwd": row.worktree_cwd,
            "worktreeRemoved": row.worktree_removed,
            "branch": row.branch,
            "engine": {
                "harness": row.harness,
                "model": row.model,
                "modelSettings": serde_json::from_str::<Value>(&row.model_settings).unwrap_or(json!({})),
                "runtimeMode": row.runtime_mode,
            },
            "createdAt": row.created_at,
            "updatedAt": row.updated_at,
            "archived": row.archived,
            "pinned": row.pinned,
            "sidebarHidden": row.sidebar_hidden,
            "linkedWorkItem": row.linked_work_item_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
            "automationId": row.automation_id,
            "contextUsed": row.context_used,
            "contextWindow": row.context_window,
            "monoTranscript": mono,
            "providerTranscript": pointer,
            "blocks": blocks,
        });
        writer
            .json(&format!("workspace/sessions/{id}.json"), &file)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
        sessions += 1;
    }
    counts.insert("sessions".into(), json!(sessions));

    let notes = table_rows(conn, "notes", "created_at, id")?;
    counts.insert("notes".into(), json!(notes.len()));
    let note_ids: Vec<Value> = notes.iter().filter_map(|n| n.get("id").cloned()).collect();
    counts.insert("noteIds".into(), Value::Array(note_ids));
    let wrote = |writer: &mut Writer, path: &str, value: Value| {
        writer
            .json(path, &value)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
    };
    wrote(
        writer,
        "workspace/notes.json",
        Value::Array(notes.into_iter().map(Value::Object).collect()),
    )?;

    let automations: Vec<Value> = table_rows(conn, "automations", "updated_at, id")?
        .into_iter()
        .filter_map(|row| {
            row.get("definition_json")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str(raw).ok())
        })
        .collect();
    counts.insert("automations".into(), json!(automations.len()));
    wrote(
        writer,
        "workspace/automations.json",
        Value::Array(automations),
    )?;

    let reminders: Vec<Value> = table_rows(conn, "session_reminders", "due_at, session_id")?
        .into_iter()
        .map(|row| json!({"sessionId": row.get("session_id"), "dueAt": row.get("due_at"), "firedAt": row.get("fired_at")}))
        .collect();
    counts.insert("reminders".into(), json!(reminders.len()));
    wrote(writer, "workspace/reminders.json", Value::Array(reminders))?;

    let delegations: Vec<Value> = table_rows(conn, "delegations", "created_at, id")?
        .into_iter()
        .map(|mut row| {
            for mirror in ["mirrored_version", "mirror_error"] {
                row.remove(mirror);
            }
            Value::Object(row)
        })
        .collect();
    counts.insert("delegations".into(), json!(delegations.len()));
    wrote(
        writer,
        "workspace/delegations.json",
        Value::Array(delegations),
    )?;
    Ok(())
}

const NOTE_ASSET_DIR: &str = "note-assets";

/// Each exported note's pictures, as they are.
fn export_note_assets(
    env: &Env,
    writer: &mut Writer,
    counts: &Map<String, Value>,
) -> Result<(), String> {
    let Some(ids) = counts.get("noteIds").and_then(Value::as_array) else {
        return Ok(());
    };
    for id in ids
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| session_file_id(id))
    {
        let dir = env.data_dir.join(NOTE_ASSET_DIR).join(id);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && safe_relative(&name).is_some()
            {
                writer.binary(
                    &format!("workspace/{NOTE_ASSET_DIR}/{id}/{name}"),
                    &entry.path(),
                )?;
            }
        }
    }
    Ok(())
}

// ---- reading an export ---------------------------------------------------------------------------------------------

/// An export opened for reading. An archive is unpacked into a scratch folder that goes when this does.
enum Opened {
    V1(String),
    V2 {
        root: PathBuf,
        manifest: Value,
        _scratch: Option<Scratch>,
    },
}

impl Opened {
    fn root(&self) -> Option<&Path> {
        match self {
            Opened::V2 { root, .. } => Some(root),
            Opened::V1(_) => None,
        }
    }

    fn read(&self, relative: &str) -> Option<String> {
        let root = self.root()?;
        fs::read_to_string(root.join(safe_relative(relative)?)).ok()
    }

    fn json(&self, relative: &str) -> Option<Value> {
        serde_json::from_str(&self.read(relative)?).ok()
    }

    fn listed(&self) -> Vec<String> {
        match self {
            Opened::V2 { manifest, .. } => manifest["files"]
                .as_array()
                .map(|files| {
                    files
                        .iter()
                        .filter_map(|f| f["path"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            Opened::V1(_) => Vec::new(),
        }
    }
}

fn manifest_root(dir: &Path) -> Option<PathBuf> {
    if dir.join(MANIFEST).is_file() {
        return Some(dir.to_path_buf());
    }
    let mut inner = fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.'));
    let only = inner.next()?;
    if inner.next().is_some() {
        return None;
    }
    only.path().join(MANIFEST).is_file().then(|| only.path())
}

fn unpack(archive: &Path) -> Result<Scratch, String> {
    let scratch = Scratch::temp("import")?;
    let file = fs::File::open(archive).map_err(|e| format!("{}: {e}", archive.display()))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut total = 0u64;
    let entries = tar
        .entries()
        .map_err(|_| "That file isn't a MonoCode Hub export.".to_string())?;
    for (count, entry) in entries.enumerate() {
        if count > MAX_ENTRIES {
            return Err("That archive has too many files to be an export.".into());
        }
        let mut entry = entry.map_err(|_| "That archive is damaged.".to_string())?;
        let kind = entry.header().entry_type();
        let path = entry
            .path()
            .map_err(|_| "That archive is damaged.".to_string())?
            .into_owned();
        let relative = path.to_string_lossy().replace('\\', "/");
        let relative = relative.trim_end_matches('/');
        if relative.is_empty() || relative == "." {
            continue;
        }
        let Some(safe) = safe_relative(relative) else {
            // Hidden files (.DS_Store) are skipped; anything that climbs out is refused.
            if path
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
            {
                return Err("That archive points outside itself; it was not opened.".into());
            }
            continue;
        };
        let target = scratch.0.join(&safe);
        if kind.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else if kind.is_file() {
            total += entry.header().size().unwrap_or(0);
            if total > MAX_UNPACKED {
                return Err("That archive is too large to be an export.".into());
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        } else {
            return Err("That archive holds links or devices; it was not opened.".into());
        }
    }
    Ok(scratch)
}

fn open_export(path: &str) -> Result<Opened, String> {
    let path = crate::fs::expand_home(path.trim());
    let (root, scratch) = if path.is_dir() {
        (
            manifest_root(&path)
                .ok_or("That folder isn't a MonoCode Hub export (no manifest.json).")?,
            None,
        )
    } else if path.is_file() {
        let head = {
            use std::io::Read;
            let mut buf = [0u8; 2];
            let mut file = fs::File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let n = file.read(&mut buf).unwrap_or(0);
            buf[..n].to_vec()
        };
        if head == [0x1f, 0x8b] {
            let scratch = unpack(&path)?;
            let root = manifest_root(&scratch.0)
                .ok_or("That archive isn't a MonoCode Hub export (no manifest.json).")?;
            (root, Some(scratch))
        } else {
            let text = fs::read_to_string(&path)
                .map_err(|_| "That file isn't a MonoCode Hub export.".to_string())?;
            let value: Value = serde_json::from_str(&text)
                .map_err(|_| "That file isn't a MonoCode Hub export.".to_string())?;
            match value["format"].as_str() {
                Some(V1_FORMAT) => return Ok(Opened::V1(text)),
                Some(FORMAT) => (
                    path.parent().map(Path::to_path_buf).unwrap_or_default(),
                    None,
                ),
                _ => return Err("That file isn't a MonoCode Hub export.".into()),
            }
        }
    } else {
        return Err(format!("{} isn't there.", path.display()));
    };
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(root.join(MANIFEST))
            .map_err(|_| "The export has no readable manifest.json.".to_string())?,
    )
    .map_err(|_| "The export's manifest.json is damaged.".to_string())?;
    if manifest["format"].as_str() != Some(FORMAT) {
        return Err("That folder isn't a MonoCode Hub export.".into());
    }
    let version = manifest["version"].as_u64().unwrap_or(0);
    if version > VERSION {
        return Err(format!(
            "This export was made by a newer MonoCode Hub (format {version}; this build reads up to {VERSION}). Update the app first."
        ));
    }
    if version < 2 {
        return Err("That export's format is unknown.".into());
    }
    // Every listed file must be there, unchanged.
    for file in manifest["files"].as_array().into_iter().flatten() {
        let relative = file["path"].as_str().unwrap_or("");
        let safe = safe_relative(relative)
            .ok_or_else(|| format!("The export lists a bad path: {relative}"))?;
        let bytes =
            fs::read(root.join(&safe)).map_err(|_| format!("The export is missing {relative}."))?;
        if file["sha256"].as_str() != Some(sha256_hex(&bytes).as_str()) {
            return Err(format!(
                "The export is damaged or was changed after it was made: {relative}."
            ));
        }
    }
    Ok(Opened::V2 {
        root,
        manifest,
        _scratch: scratch,
    })
}

// ---- the preview ---------------------------------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Not here yet: it comes in.
    New,
    /// Already here, the same: nothing to do.
    Same,
    /// Already here and different: yours is kept unless asked to add the file's beside it.
    Differs,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub status: Status,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPreview {
    pub name: String,
    pub target_exists: bool,
    pub history: bool,
    pub files: Vec<FilePreview>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPreview {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub harness: String,
    pub model: String,
    pub blocks: usize,
    pub updated_at: i64,
    pub archived: bool,
    pub mono_transcript: bool,
    pub status: Status,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPreview {
    pub id: String,
    pub title: String,
    pub status: Status,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePreview {
    pub sessions: Vec<SessionPreview>,
    pub notes: Vec<ItemPreview>,
    pub automations: Vec<ItemPreview>,
    pub reminders: usize,
    pub delegations: Vec<ItemPreview>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    /// "v1" (a single setup .json from before Phase 5) or "v2".
    pub format: String,
    /// The v1 file's text; the webview migrates it.
    pub v1: Option<String>,
    pub manifest: Value,
    /// The webview's files (`setup/…`, `workspace/hub/…`), by path.
    pub files: BTreeMap<String, String>,
    pub memory: Vec<MemoryPreview>,
    pub workspace: Option<WorkspacePreview>,
    /// Where imported memory goes on this copy.
    pub memory_target: String,
}

fn blocks_digest(title: &str, blocks: &[Value]) -> String {
    let mut text = String::from(title);
    text.push('\n');
    text.push_str(&serde_json::to_string(blocks).unwrap_or_default());
    sha256_hex(text.as_bytes())
}

fn local_session_digest(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT title, blocks_json FROM sessions WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((title, blocks_json)) = row else {
        return Ok(None);
    };
    let (blocks, _) = session_blocks(conn, id, &blocks_json)?;
    // What an export of this chat would carry: scrubbed the same way.
    let mut value = Value::Array(blocks);
    scrubber().redact_value(&mut value);
    let (title, _) = scrubber().redact_text(&title);
    Ok(Some(blocks_digest(
        &title,
        value.as_array().map(Vec::as_slice).unwrap_or(&[]),
    )))
}

fn row_status(
    conn: Option<&Connection>,
    table: &str,
    id: &str,
    same: impl Fn(&Map<String, Value>) -> bool,
) -> rusqlite::Result<Status> {
    let Some(conn) = conn else {
        return Ok(Status::New);
    };
    if !has_table(conn, table)? {
        return Ok(Status::New);
    }
    let rows = table_rows_where(conn, table, id)?;
    Ok(match rows {
        None => Status::New,
        Some(row) if same(&row) => Status::Same,
        Some(_) => Status::Differs,
    })
}

fn table_rows_where(
    conn: &Connection,
    table: &str,
    id: &str,
) -> rusqlite::Result<Option<Map<String, Value>>> {
    let columns = table_columns(conn, table)?;
    conn.query_row(
        &format!("SELECT * FROM {table} WHERE id = ?1"),
        [id],
        |row| {
            let mut object = Map::new();
            for (index, column) in columns.iter().enumerate() {
                object.insert(column.clone(), cell(row.get_ref(index)?));
            }
            Ok(object)
        },
    )
    .optional()
}

fn scrubbed(value: &Value) -> Value {
    let mut value = value.clone();
    scrubber().redact_value(&mut value);
    value
}

pub fn inspect(env: &Env, path: &str) -> Result<Inspection, String> {
    let opened = open_export(path)?;
    let manifest = match &opened {
        Opened::V1(text) => {
            return Ok(Inspection {
                format: "v1".into(),
                v1: Some(text.clone()),
                manifest: Value::Null,
                files: BTreeMap::new(),
                memory: Vec::new(),
                workspace: None,
                memory_target: env.memory_root.to_string_lossy().into_owned(),
            })
        }
        Opened::V2 { manifest, .. } => manifest.clone(),
    };
    let listed = opened.listed();
    let files: BTreeMap<String, String> = listed
        .iter()
        .filter(|path| {
            WEBVIEW_PREFIXES
                .iter()
                .any(|prefix| path.starts_with(prefix))
        })
        .filter_map(|path| opened.read(path).map(|text| (path.clone(), text)))
        .collect();

    let mut memory: BTreeMap<String, MemoryPreview> = BTreeMap::new();
    for path in &listed {
        let Some(rest) = path.strip_prefix("memory/") else {
            continue;
        };
        if let Some(name) = rest.strip_suffix(".git.bundle") {
            if plain_name(name) {
                memory_entry(&mut memory, env, name).history = true;
            }
            continue;
        }
        let Some((name, inner)) = rest.split_once('/') else {
            continue;
        };
        if !plain_name(name) {
            continue;
        }
        let text = opened.read(path).unwrap_or_default();
        let target = env.memory_root.join(name).join(inner);
        let status = match fs::read_to_string(&target) {
            Ok(local) if local == text => Status::Same,
            Ok(_) => Status::Differs,
            Err(_) => Status::New,
        };
        memory_entry(&mut memory, env, name)
            .files
            .push(FilePreview {
                path: inner.to_string(),
                status,
            });
    }

    let workspace = if manifest["parts"]["workspace"].as_bool() == Some(true) {
        let conn = env.read_db()?;
        Some(workspace_preview(&opened, conn.as_ref(), &listed).map_err(|e| e.to_string())?)
    } else {
        None
    };

    Ok(Inspection {
        format: "v2".into(),
        v1: None,
        manifest,
        files,
        memory: memory.into_values().collect(),
        workspace,
        memory_target: env.memory_root.to_string_lossy().into_owned(),
    })
}

fn memory_entry<'a>(
    memory: &'a mut BTreeMap<String, MemoryPreview>,
    env: &Env,
    name: &str,
) -> &'a mut MemoryPreview {
    memory
        .entry(name.to_string())
        .or_insert_with(|| MemoryPreview {
            name: name.to_string(),
            target_exists: env.memory_root.join(name).is_dir(),
            history: false,
            files: Vec::new(),
        })
}

fn workspace_preview(
    opened: &Opened,
    conn: Option<&Connection>,
    listed: &[String],
) -> rusqlite::Result<WorkspacePreview> {
    let mut preview = WorkspacePreview::default();
    for path in listed {
        let Some(id) = path
            .strip_prefix("workspace/sessions/")
            .and_then(|p| p.strip_suffix(".json"))
        else {
            continue;
        };
        let Some(file) = opened.json(path) else {
            continue;
        };
        let blocks = file["blocks"].as_array().cloned().unwrap_or_default();
        let title = file["title"].as_str().unwrap_or("").to_string();
        let status = match conn
            .map(|c| local_session_digest(c, id))
            .transpose()?
            .flatten()
        {
            None => Status::New,
            Some(local) if local == blocks_digest(&title, &blocks) => Status::Same,
            Some(_) => Status::Differs,
        };
        preview.sessions.push(SessionPreview {
            id: id.to_string(),
            cwd: file["cwd"].as_str().unwrap_or("").to_string(),
            harness: file["engine"]["harness"].as_str().unwrap_or("").to_string(),
            model: file["engine"]["model"].as_str().unwrap_or("").to_string(),
            blocks: blocks.len(),
            updated_at: file["updatedAt"].as_i64().unwrap_or(0),
            archived: file["archived"].as_bool().unwrap_or(false),
            mono_transcript: file["monoTranscript"].as_bool().unwrap_or(false),
            title,
            status,
        });
    }
    preview
        .sessions
        .sort_by_key(|a| std::cmp::Reverse(a.updated_at));
    for note in opened
        .json("workspace/notes.json")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
    {
        let Some(id) = note["id"].as_str() else {
            continue;
        };
        let status = row_status(conn, "notes", id, |local| {
            ["title", "body", "tags_json"]
                .iter()
                .all(|key| scrubbed(&local.get(*key).cloned().unwrap_or(Value::Null)) == note[*key])
        })?;
        preview.notes.push(ItemPreview {
            id: id.into(),
            title: note["title"].as_str().unwrap_or("").into(),
            status,
        });
    }
    for automation in opened
        .json("workspace/automations.json")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
    {
        let Some(id) = automation["id"].as_str() else {
            continue;
        };
        let status = row_status(conn, "automations", id, |local| {
            local
                .get("definition_json")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .map(|v| without_enabled(&scrubbed(&v)))
                == Some(without_enabled(&automation))
        })?;
        preview.automations.push(ItemPreview {
            id: id.into(),
            title: automation["name"].as_str().unwrap_or("").into(),
            status,
        });
    }
    preview.reminders = opened
        .json("workspace/reminders.json")
        .and_then(|v| v.as_array().map(Vec::len))
        .unwrap_or(0);
    for delegation in opened
        .json("workspace/delegations.json")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
    {
        let Some(id) = delegation["id"].as_str() else {
            continue;
        };
        let status = row_status(conn, "delegations", id, |_| true)?;
        preview.delegations.push(ItemPreview {
            id: id.into(),
            title: delegation["title"].as_str().unwrap_or("").into(),
            status,
        });
    }
    Ok(preview)
}

fn without_enabled(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(map) = value.as_object_mut() {
        for key in [
            "enabled",
            "nextRunAt",
            "next_run_at",
            "lastRunAt",
            "last_run_at",
            "updatedAt",
            "updated_at",
        ] {
            map.remove(key);
        }
    }
    value
}

// ---- import --------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImport {
    pub projects: Vec<String>,
    /// For a file that is here and differs: add the file's version beside it (`<name>.imported.md`).
    #[serde(default)]
    pub keep_both: bool,
    /// Bring a folder's history back when that folder isn't here yet.
    #[serde(default)]
    pub history: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImport {
    /// Chats to add by id. One that is here and differs is skipped unless it is in `session_copies`.
    #[serde(default)]
    pub sessions: Vec<String>,
    /// Chats that are here and differ: add the file's as a copy with a new id.
    #[serde(default)]
    pub session_copies: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub note_copies: Vec<String>,
    #[serde(default)]
    pub automations: Vec<String>,
    #[serde(default)]
    pub reminders: bool,
    #[serde(default)]
    pub delegations: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub path: String,
    #[serde(default)]
    pub memory: Option<MemoryImport>,
    #[serde(default)]
    pub workspace: Option<WorkspaceImport>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub sessions_added: usize,
    pub sessions_copied: usize,
    pub notes_added: usize,
    pub notes_copied: usize,
    pub automations_added: usize,
    pub reminders_added: usize,
    pub delegations_added: usize,
    pub memory_files_added: usize,
    pub memory_files_beside: usize,
    pub memory_history: Vec<String>,
    /// Things already here that were kept as they are.
    pub kept: usize,
    /// Old ids to new ones, for chats and notes that came in as copies.
    pub renamed: BTreeMap<String, String>,
    pub notes: Vec<String>,
    /// Monos whose SOUL.md this restore wrote from Rust (a memory folder that is the Monos home). The app records these
    /// as its own saves, so its soul tamper check doesn't take them for outside edits (hub/model/soulTamper.ts).
    pub souls_restored: Vec<String>,
}

/// `lock` takes the session store's lock. Every chat save waits on it, so it is taken only around the workspace's
/// rows: the export is unpacked and checked (up to MAX_UNPACKED) and the memory written before it, never under it.
pub fn import<G: std::ops::Deref<Target = Connection>>(
    env: &Env,
    request: &ImportRequest,
    lock: impl FnOnce() -> Result<G, String>,
) -> Result<ImportReport, String> {
    let opened = open_export(&request.path)?;
    let mut report = ImportReport::default();
    if opened.root().is_none() {
        return Ok(report);
    }
    if let Some(memory) = &request.memory {
        import_memory(env, &opened, memory, &mut report)?;
    }
    if let Some(workspace) = &request.workspace {
        let conn = lock()?;
        import_workspace(env, &conn, &opened, workspace, &mut report).map_err(|e| e.to_string())?;
    }
    Ok(report)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// What an import does once its rows are in: the pictures of the notes that went in, the Mono transcripts to index.
#[derive(Default)]
struct AfterRows {
    note_assets: Vec<(String, String)>,
    transcripts: Vec<String>,
}

/// The workspace's rows go in as one transaction: an error midway leaves nothing half in, so a retry starts clean
/// rather than counting its own earlier rows as "already here".
fn import_workspace(
    env: &Env,
    conn: &Connection,
    opened: &Opened,
    wanted: &WorkspaceImport,
    report: &mut ImportReport,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let mut after = AfterRows::default();
    workspace_rows(env, &tx, opened, wanted, report, &mut after)?;
    tx.commit()?;
    for (from, to) in &after.note_assets {
        copy_note_assets(env, opened, from, to);
    }
    // Indexing has its own transaction. A chat it fails for still opens from its rows, and is indexed then.
    for id in &after.transcripts {
        if crate::mono_transcript::migrate_transcript(conn, id).is_err() {
            report.notes.push(format!(
                "The transcript of chat {id} will be indexed the first time it opens."
            ));
        }
    }
    Ok(())
}

fn workspace_rows(
    env: &Env,
    conn: &Connection,
    opened: &Opened,
    wanted: &WorkspaceImport,
    report: &mut ImportReport,
    after: &mut AfterRows,
) -> rusqlite::Result<()> {
    // Notes first: chats' artifact cards point at them.
    let note_ids: BTreeSet<&String> = wanted.notes.iter().collect();
    let copies: BTreeSet<&String> = wanted.note_copies.iter().collect();
    for note in opened
        .json("workspace/notes.json")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
    {
        let Some(mut row) = note.as_object().cloned() else {
            continue;
        };
        let Some(id) = row.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if !note_ids.contains(&id) || !session_file_id(&id) {
            continue;
        }
        let exists = table_rows_where(conn, "notes", &id)?.is_some();
        let target = if exists {
            if !copies.contains(&id) {
                report.kept += 1;
                continue;
            }
            let fresh = new_id();
            if let Some(Value::String(body)) = row.get_mut("body") {
                *body = body.replace(
                    &format!("{NOTE_ASSET_DIR}/{id}/"),
                    &format!("{NOTE_ASSET_DIR}/{fresh}/"),
                );
            }
            row.insert("id".into(), json!(fresh));
            report.renamed.insert(id.clone(), fresh.clone());
            fresh
        } else {
            id.clone()
        };
        // Slugs are unique: a clash gets -2, -3 …
        if let Some(slug) = row.get("slug").and_then(Value::as_str).map(str::to_string) {
            let mut candidate = slug.clone();
            let mut n = 2;
            while conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE slug = ?1)",
                [&candidate],
                |r| r.get::<_, bool>(0),
            )? {
                candidate = format!("{slug}-{n}");
                n += 1;
            }
            row.insert("slug".into(), json!(candidate));
        }
        if insert_row(conn, "notes", &row)? {
            if exists {
                report.notes_copied += 1;
            } else {
                report.notes_added += 1;
            }
            after.note_assets.push((id.clone(), target));
        }
    }

    let session_ids: BTreeSet<&String> = wanted.sessions.iter().collect();
    let session_copies: BTreeSet<&String> = wanted.session_copies.iter().collect();
    for id in session_ids {
        if !session_file_id(id) {
            continue;
        }
        let Some(file) = opened.json(&format!("workspace/sessions/{id}.json")) else {
            continue;
        };
        let exists = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            [id],
            |r| r.get::<_, bool>(0),
        )?;
        let (target, title) = if exists {
            if !session_copies.contains(id) {
                report.kept += 1;
                continue;
            }
            let fresh = new_id();
            report.renamed.insert(id.clone(), fresh.clone());
            (
                fresh,
                format!("{} (imported)", file["title"].as_str().unwrap_or("Chat")),
            )
        } else {
            (
                id.clone(),
                file["title"].as_str().unwrap_or("Chat").to_string(),
            )
        };
        insert_session(env, conn, &target, &title, &file)?;
        if file["monoTranscript"].as_bool() == Some(true) {
            after.transcripts.push(target.clone());
        }
        if exists {
            report.sessions_copied += 1;
        } else {
            report.sessions_added += 1;
        }
    }

    if !wanted.automations.is_empty() {
        let wanted_ids: BTreeSet<&String> = wanted.automations.iter().collect();
        for mut automation in opened
            .json("workspace/automations.json")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
        {
            let Some(id) = automation["id"].as_str().map(str::to_string) else {
                continue;
            };
            if !wanted_ids.contains(&id) || !session_file_id(&id) {
                continue;
            }
            // Comes back paused: nothing starts running on this Mac until Ash turns it on.
            automation["enabled"] = json!(false);
            let next = automation["nextRunAt"].as_i64().unwrap_or(0);
            let updated = automation["updatedAt"].as_i64().unwrap_or_else(now_millis);
            let changed = conn.execute(
                "INSERT OR IGNORE INTO automations (id, definition_json, enabled, next_run_at, updated_at) VALUES (?1, ?2, 0, ?3, ?4)",
                params![id, automation.to_string(), next, updated],
            )?;
            if changed > 0 {
                report.automations_added += 1;
            } else {
                report.kept += 1;
            }
        }
    }

    if wanted.reminders {
        let now = now_millis();
        for reminder in opened
            .json("workspace/reminders.json")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
        {
            let Some(session) = reminder["sessionId"].as_str() else {
                continue;
            };
            let session = report
                .renamed
                .get(session)
                .map(String::as_str)
                .unwrap_or(session);
            let due = reminder["dueAt"].as_i64().unwrap_or(0);
            if due <= 0 {
                continue;
            }
            // A reminder whose time passed comes back done, so it doesn't fire the moment it lands.
            let fired = reminder["firedAt"].as_i64().or((due <= now).then_some(now));
            let changed = conn.execute(
                "INSERT OR IGNORE INTO session_reminders (session_id, due_at, fired_at)
                 SELECT ?1, ?2, ?3 WHERE EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
                params![session, due, fired],
            )?;
            report.reminders_added += changed;
        }
    }

    if wanted.delegations {
        for delegation in opened
            .json("workspace/delegations.json")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
        {
            let Some(mut row) = delegation.as_object().cloned() else {
                continue;
            };
            // History only: nothing here runs it, reports it or copies it to Ash OS again.
            let open = matches!(
                row.get("state").and_then(Value::as_str),
                Some(crate::delegations::RUNNING | crate::delegations::QUESTION)
            );
            if open {
                row.insert("state".into(), json!(crate::delegations::CANCELLED));
                row.insert(
                    "error".into(),
                    json!("Imported from another copy of the hub; it was not running here."),
                );
                row.insert("settled_at".into(), json!(now_millis()));
            }
            if !matches!(
                row.get("delivery").and_then(Value::as_str),
                Some(
                    crate::delegations::DELIVERED
                        | crate::delegations::ACKNOWLEDGED
                        | crate::delegations::DISPOSED
                )
            ) {
                row.insert("delivery".into(), json!(crate::delegations::DISPOSED));
            }
            let version = row.get("version").and_then(Value::as_i64).unwrap_or(1);
            row.insert("mirrored_version".into(), json!(version));
            if insert_row(conn, "delegations", &row)? {
                report.delegations_added += 1;
            }
        }
    }
    Ok(())
}

fn copy_note_assets(env: &Env, opened: &Opened, from: &str, to: &str) {
    let Some(root) = opened.root() else { return };
    let source = root.join("workspace").join(NOTE_ASSET_DIR).join(from);
    let Ok(entries) = fs::read_dir(&source) else {
        return;
    };
    let target = env.data_dir.join(NOTE_ASSET_DIR).join(to);
    for entry in entries.flatten() {
        let dest = target.join(entry.file_name());
        if !dest.exists() && fs::create_dir_all(&target).is_ok() {
            let _ = fs::copy(entry.path(), &dest);
        }
    }
}

fn insert_session(
    env: &Env,
    conn: &Connection,
    id: &str,
    title: &str,
    file: &Value,
) -> rusqlite::Result<()> {
    let engine = &file["engine"];
    let harness = engine["harness"].as_str().unwrap_or("claude").to_string();
    // A provider session id is kept only where it can resume: the daily app, a Claude chat, its transcript here.
    let provider = file["providerTranscript"]["providerSessionId"]
        .as_str()
        .filter(|psid| !env.dev && harness == "claude" && claude_transcript(env, psid).is_some())
        .map(str::to_string);
    let text = |key: &str| file[key].as_str().map(str::to_string);
    let session = SessionUpsert {
        sidebar_hidden: file["sidebarHidden"].as_bool().unwrap_or(false),
        id: id.to_string(),
        cwd: text("cwd").unwrap_or_else(|| "~".into()),
        harness,
        model: engine["model"].as_str().unwrap_or("").to_string(),
        model_settings: engine.get("modelSettings").cloned().unwrap_or(json!({})),
        runtime_mode: engine["runtimeMode"].as_str().unwrap_or("auto").to_string(),
        title: title.to_string(),
        provider_session_id: provider,
        provider_account_id: None,
        blocks: file.get("blocks").cloned().unwrap_or(json!([])),
        queued_messages: Vec::new(),
        queue_status: None,
        context_used: file["contextUsed"].as_i64(),
        context_window: file["contextWindow"].as_i64(),
        branch: text("branch"),
        worktree_cwd: text("worktreeCwd"),
        worktree_removed: file["worktreeRemoved"].as_bool().unwrap_or(false),
        linked_work_item: file.get("linkedWorkItem").filter(|v| !v.is_null()).cloned(),
        automation_id: text("automationId"),
        // A /goal belongs to its Claude conversation on this Mac; it never travels.
        goal: None,
    };
    session_store::upsert_session(conn, &session)?;
    // Keep the chat's own dates, place and flags rather than "made just now".
    conn.execute(
        "UPDATE sessions SET created_at = ?2, updated_at = ?3, archived = ?4, pinned = ?5, branch = ?6 WHERE id = ?1",
        params![
            id,
            file["createdAt"].as_i64().unwrap_or_else(now_millis),
            file["updatedAt"].as_i64().unwrap_or_else(now_millis),
            i64::from(file["archived"].as_bool().unwrap_or(false)),
            i64::from(file["pinned"].as_bool().unwrap_or(false)),
            text("branch"),
        ],
    )?;
    Ok(())
}

fn import_memory(
    env: &Env,
    opened: &Opened,
    wanted: &MemoryImport,
    report: &mut ImportReport,
) -> Result<(), String> {
    let Some(root) = opened.root() else {
        return Ok(());
    };
    let listed = opened.listed();
    let wanted_names: BTreeSet<&String> =
        wanted.projects.iter().filter(|n| plain_name(n)).collect();
    if wanted_names.is_empty() {
        return Ok(());
    }
    env.check_writable(&env.memory_root)?;
    for name in wanted_names {
        let target = env.memory_root.join(name);
        env.check_writable(&target)?;
        let bundle = root.join("memory").join(format!("{name}.git.bundle"));
        let has_bundle = listed
            .iter()
            .any(|p| p == &format!("memory/{name}.git.bundle"));
        // A folder made here from the history is this import's own: its files may take the export's newest text.
        let mut fresh = false;
        if wanted.history && has_bundle && !target.exists() {
            fs::create_dir_all(&env.memory_root).map_err(|e| e.to_string())?;
            match restore_history(&bundle, &target) {
                Ok(()) => {
                    report.memory_history.push(name.clone());
                    fresh = true;
                }
                Err(why) => {
                    let _ = fs::remove_dir_all(&target);
                    report.notes.push(match why {
                        HistoryRefusal::Link(path) => format!(
                            "The history of {name} holds a link ({path}) that could point outside its folder, so it wasn't restored; its files came in without it."
                        ),
                        HistoryRefusal::Failed => format!(
                            "The history of {name} couldn't be restored; its files came in without it."
                        ),
                    });
                }
            }
        }
        // Every write stays inside this folder, links resolved: one already here can't carry a file elsewhere.
        let inside = resolved(&target);
        let prefix = format!("memory/{name}/");
        for path in listed.iter().filter(|p| p.starts_with(&prefix)) {
            let inner = &path[prefix.len()..];
            let Some(safe) = safe_relative(inner) else {
                continue;
            };
            let dest = target.join(&safe);
            if !within(&inside, &dest) {
                report.notes.push(format!(
                    "{path} wasn't written: its place in {name} leads outside the memory folder."
                ));
                continue;
            }
            // Memory is text: a file that isn't UTF-8 is skipped, never written as nothing over what is here.
            let Some(text) = opened.read(path) else {
                report.notes.push(format!(
                    "{path} isn't plain text (UTF-8), so it was skipped; nothing here changed for it."
                ));
                continue;
            };
            // Whether `dest` now holds the export's text because of this restore (a fresh folder's history counts).
            let wrote = match fs::read_to_string(&dest) {
                Ok(local) if local == text => fresh,
                Ok(_) if fresh => {
                    write_within(&inside, &dest, &text)?;
                    true
                }
                Ok(_) => {
                    if wanted.keep_both {
                        write_within(&inside, &beside_name(&dest), &text)?;
                        report.memory_files_beside += 1;
                    } else {
                        report.kept += 1;
                    }
                    false
                }
                Err(_) => {
                    write_within(&inside, &dest, &text)?;
                    report.memory_files_added += 1;
                    true
                }
            };
            if wrote {
                if let Some(mono) = restored_soul(&env.monos_root, &dest) {
                    if !report.souls_restored.contains(&mono) {
                        report.souls_restored.push(mono);
                    }
                }
            }
        }
    }
    Ok(())
}

enum HistoryRefusal {
    /// The newest tree holds a link (or anything else that isn't a plain file) at this path.
    Link(String),
    Failed,
}

/// A memory folder's history from an export's bundle, into `target` (not there yet): no hooks, no templates, and
/// nothing but plain files. A tree with a link is refused before anything is checked out, so no write that follows
/// can go through it.
fn restore_history(bundle: &Path, target: &Path) -> Result<(), HistoryRefusal> {
    let git = || {
        let mut command = Command::new("git");
        command.args([
            "-c",
            "core.symlinks=false",
            "-c",
            "core.hooksPath=/dev/null",
            // The files come back byte for byte, whatever the machine's `core.autocrlf` (true on most Windows setups).
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.eol=lf",
        ]);
        command
    };
    let ok = |command: &mut Command| command.output().is_ok_and(|out| out.status.success());
    if !ok(git()
        .args(["clone", "--quiet", "--no-checkout", "--template="])
        // ... and so does every later commit in the folder this makes for itself.
        .args(["--config", "core.autocrlf=false", "--config", "core.eol=lf"])
        .arg(bundle)
        .arg(target))
    {
        return Err(HistoryRefusal::Failed);
    }
    let listing = git()
        .arg("-C")
        .arg(target)
        .args(["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
        .output()
        .map_err(|_| HistoryRefusal::Failed)?;
    if !listing.status.success() {
        return Err(HistoryRefusal::Failed);
    }
    // Plain files only (a hidden one like .gitignore is still a plain file; git itself refuses `..` and `.git`).
    for entry in listing.stdout.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let entry = String::from_utf8_lossy(entry);
        let (meta, path) = entry.split_once('\t').unwrap_or((&entry, ""));
        let mode = meta.split(' ').next().unwrap_or("");
        if !matches!(mode, "100644" | "100755") {
            return Err(HistoryRefusal::Link(path.to_string()));
        }
    }
    if !ok(git()
        .arg("-C")
        .arg(target)
        .args(["checkout", "--quiet", "--force", "HEAD"]))
    {
        return Err(HistoryRefusal::Failed);
    }
    // The bundle was a scratch file: don't leave a remote pointing at it.
    let _ = git()
        .arg("-C")
        .arg(target)
        .args(["remote", "remove", "origin"])
        .output();
    Ok(())
}

/// Whether `dest`'s folder, links resolved, is `inside` (itself resolved).
fn within(inside: &Path, dest: &Path) -> bool {
    dest.parent()
        .is_some_and(|parent| resolved(parent).starts_with(inside))
}

/// Writes `dest` only when its folder is inside `inside`, checked before the folder is made and again after.
/// The Mono whose soul `dest` is, when it is `<monos_root>/<id>/SOUL.md` (links resolved on both sides).
fn restored_soul(monos_root: &Path, dest: &Path) -> Option<String> {
    if dest.file_name()? != "SOUL.md" {
        return None;
    }
    let folder = resolved(dest.parent()?);
    if folder.parent()? != resolved(monos_root) {
        return None;
    }
    let id = folder.file_name()?.to_str()?.to_string();
    plain_name(&id).then_some(id)
}

fn write_within(inside: &Path, dest: &Path, text: &str) -> Result<(), String> {
    let refused = || {
        format!(
            "{} leads outside the memory folder; nothing was written there.",
            dest.display()
        )
    };
    let parent = dest.parent().ok_or_else(refused)?;
    if !within(inside, dest) {
        return Err(refused());
    }
    fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    if !parent
        .canonicalize()
        .is_ok_and(|parent| parent.starts_with(inside))
    {
        return Err(refused());
    }
    write_atomic(dest, text.as_bytes())
}

/// `decisions.md` → `decisions.imported.md`, then `.imported-2.md`, … never over anything.
fn beside_name(path: &Path) -> PathBuf {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{stem}.imported.md")
        } else {
            format!("{stem}.imported-{n}.md")
        };
        let candidate = path.with_file_name(name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

// ---- a Mono's own files, read for the export -----------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonoRef {
    pub id: String,
    #[serde(default)]
    pub legacy_project: Option<String>,
}

/// Each Mono's SOUL.md and habits.json, and with `memory` its MEMORY.md and memory/ notes, from the Monos home in use
/// (`Env::mono_home`). Read only: a folder that isn't there yet stays not there.
pub fn mono_files(
    env: &Env,
    monos: &[MonoRef],
    memory: bool,
) -> BTreeMap<String, BTreeMap<String, String>> {
    mono_files_in(&env.mono_home(), monos, memory)
}

/// The same, from the folder this copy's Monos live in (mono.rs `resolved_root`).
pub fn mono_files_in(
    root: &Path,
    monos: &[MonoRef],
    memory: bool,
) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for mono in monos {
        if mono.id.is_empty()
            || !mono
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            continue;
        }
        let mut dir = root.join(&mono.id);
        if !dir.is_dir() {
            if let Some(legacy) = mono
                .legacy_project
                .as_deref()
                .and_then(|project| legacy_folder(root, project))
            {
                dir = legacy;
            }
        }
        let mut files = BTreeMap::new();
        let mut names = vec!["SOUL.md".to_string(), "habits.json".to_string()];
        if memory {
            names.push("MEMORY.md".into());
            if let Ok(entries) = fs::read_dir(dir.join("memory")) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.ends_with(".md") && !name.starts_with('.') && entry.path().is_file() {
                        names.push(format!("memory/{name}"));
                    }
                }
            }
        }
        for name in names {
            if let Ok(text) = fs::read_to_string(dir.join(&name)) {
                files.insert(name, text);
            }
        }
        out.insert(mono.id.clone(), files);
    }
    out
}

fn legacy_folder(root: &Path, project: &str) -> Option<PathBuf> {
    let index: Value =
        serde_json::from_str(&fs::read_to_string(root.join("index.json")).ok()?).ok()?;
    index["agents"].as_array()?.iter().find_map(|entry| {
        let id = entry["id"].as_str()?;
        let owns = entry["projects"]
            .as_array()?
            .iter()
            .any(|p| p.as_str() == Some(project));
        (owns && plain_name(id)).then(|| root.join(id))
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRef {
    pub name: String,
    /// Where it lives on this Mac (`~/…` when under home), or None when it isn't here.
    pub path: Option<String>,
    pub source: Option<String>,
}

/// Where each named skill lives on this Mac, if it does.
pub fn find_skills(env: &Env, names: &[String]) -> Vec<SkillRef> {
    let home = env.home.clone();
    let found = crate::skills::list_skills_from(
        home.as_deref().unwrap_or(Path::new("/")),
        home.as_deref(),
        None,
    );
    names
        .iter()
        .map(|name| {
            let hit = found.iter().find(|skill| &skill.name == name);
            SkillRef {
                name: name.clone(),
                path: hit.map(|skill| match &home {
                    Some(home) => {
                        let home = home.to_string_lossy();
                        skill
                            .path
                            .strip_prefix(home.as_ref())
                            .map(|rest| format!("~{rest}"))
                            .unwrap_or_else(|| skill.path.clone())
                    }
                    None => skill.path.clone(),
                }),
                source: hit.map(|skill| skill.source.clone()),
            }
        })
        .collect()
}

/// The engine each of these chats runs on: `{id: {harness, model}}`, for the chats that exist.
pub fn session_engines(env: &Env, ids: &[String]) -> Result<BTreeMap<String, Value>, String> {
    let mut out = BTreeMap::new();
    let Some(conn) = env.read_db()? else {
        return Ok(out);
    };
    for id in ids.iter().filter(|id| session_file_id(id)) {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT harness, model FROM sessions WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((harness, model)) = row {
            out.insert(id.clone(), json!({"harness": harness, "model": model}));
        }
    }
    Ok(out)
}

/// Which of these paths exist on this Mac (project folders named in an export).
pub fn paths_exist(paths: &[String]) -> BTreeMap<String, bool> {
    paths
        .iter()
        .map(|p| (p.clone(), Path::new(&crate::fs::expand_home(p)).exists()))
        .collect()
}

// ---- commands ------------------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableInfo {
    pub memory_root: String,
    pub memory: Vec<MemoryFolder>,
    pub dev: bool,
}

#[tauri::command]
pub async fn portable_info(app: AppHandle) -> Result<PortableInfo, String> {
    let env = Env::for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || PortableInfo {
        memory_root: env.memory_root.to_string_lossy().into_owned(),
        memory: memory_folders(&env),
        dev: env.dev,
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn portable_mono_files(
    app: AppHandle,
    monos: Vec<MonoRef>,
    memory: bool,
) -> Result<BTreeMap<String, BTreeMap<String, String>>, String> {
    let env = Env::for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || mono_files(&env, &monos, memory))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn portable_find_skills(
    app: AppHandle,
    names: Vec<String>,
) -> Result<Vec<SkillRef>, String> {
    let env = Env::for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || find_skills(&env, &names))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn portable_session_engines(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<BTreeMap<String, Value>, String> {
    let env = Env::for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || session_engines(&env, &ids))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn portable_paths_exist(paths: Vec<String>) -> Result<BTreeMap<String, bool>, String> {
    Ok(paths_exist(&paths))
}

#[tauri::command]
pub async fn portable_export(
    app: AppHandle,
    request: ExportRequest,
) -> Result<ExportReport, String> {
    let env = Env::for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || export(&env, &request))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn portable_inspect(app: AppHandle, path: String) -> Result<Inspection, String> {
    let env = Env::for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || inspect(&env, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub fn portable_import(
    app: AppHandle,
    store: State<'_, SessionStore>,
    request: ImportRequest,
) -> Result<ImportReport, String> {
    let env = Env::for_app(&app)?;
    import(&env, &request, || store.lock_conn())
}

// ---- tests ---------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests;
