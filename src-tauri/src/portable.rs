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
//!                               notes.json + note-assets/, doc-versions.json, doc-mentions.json, automations.json, reminders.json, delegations.json,
//!                               activity.json (WP-78), hub/ (the webview's group chats)
//! ```
//!
//! Every text that goes into an export passes the secret scrubber (one pattern list with the webview:
//! `src/features/portable/model/secretPatterns.json`), and the finished export is scanned again: one hit and nothing
//! is left behind. Import never overwrites: a chat, note or memory file that is already here and differs is kept, and
//! the file's version comes in beside it only when asked. Automations come back paused, delegations as history only,
//! and a dev copy never keeps a provider session id or writes into the real memory folder.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::plain_file::{self, Refusal};
use crate::session_store::{self, now_millis, SessionStore, SessionUpsert};

mod folders;
use folders::{refused_project_folder, FolderRules};

pub const FORMAT: &str = "monocode-hub-export";
/// The newest export format this build writes and reads. A newer one is refused, never half-read.
pub const VERSION: u64 = 2;
const V1_FORMAT: &str = "monocode-hub-setup";
const MANIFEST: &str = "manifest.json";
/// Unpacked size and entry caps for an archive: a damaged or hostile file can't fill the disk.
const MAX_UNPACKED: u64 = 8 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 500_000;
/// The most a manifest.json may hold: about 350,000 listed files. Inspect hands it to the window whole.
const MAX_MANIFEST: u64 = 64 * 1024 * 1024;
/// The most one text or JSON file of an export may be (a chat, a table of notes or note versions, a setup file, a memory
/// file). Large is normal: a chat keeps every tool output, and Claude's own transcript of a long one can pass 150 MB.
/// The file is read whole into memory, so the cap is what one hostile file can cost, whatever size the manifest says.
/// A file over it is left out with a line in the report, never a reason to refuse the whole export or the whole open.
const MAX_TEXT_FILE: u64 = 512 * 1024 * 1024;
/// A memory folder's history as a git bundle. It is copied to disk, never held in memory.
const MAX_BUNDLE: u64 = 1024 * 1024 * 1024;
/// The most of the webview's own files (`setup/`, `workspace/hub/`) Inspect holds at once, to send to the window; the
/// file that would take them past it is left out.
const MAX_INSPECT_BYTES: u64 = 256 * 1024 * 1024;
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
                if cfg!(windows) && windows_unsafe_name(name) {
                    return None;
                }
                out.push(name);
            }
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// A name Windows doesn't take for a file of that name: a device (`CON`, `NUL`, `CONIN$`, `COM1`, `LPT¹`, with or
/// without an extension), an alternate data stream (`name:stream`), or one that ends in a dot or a space.
fn windows_unsafe_name(name: &str) -> bool {
    if name.contains(':') || name.ends_with('.') || name.ends_with(' ') {
        return true;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end()
        .to_ascii_uppercase();
    // COM and LPT with one digit, 0 to 9, or one of the superscripts Windows also takes for one.
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix).is_some_and(|n| {
            let mut chars = n.chars();
            matches!(
                (chars.next(), chars.next()),
                (Some('0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'), None)
            )
        })
    };
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || numbered("COM")
        || numbered("LPT")
}

/// A relative path as the manifest spells it: plain names joined by `/`, whatever the platform.
fn canonical_relative(path: &Path) -> String {
    path.components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

/// What two spellings of one file have in common (a case-insensitive disk keeps one file under both): each name folded
/// the way `folders::fold_name` folds it.
fn fold(canonical: &str) -> String {
    canonical
        .split('/')
        .map(folders::fold_name)
        .collect::<Vec<_>>()
        .join("/")
}

/// A memory folder or id that is one plain name.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.starts_with('.')
        // Windows reads `monos.` and `monos ` as `monos`: a name that ends so is another spelling of a folder.
        && !name.ends_with(['.', ' '])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_of(&Sha256::digest(bytes))
}

fn hex_of(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
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

    /// A new folder only this user can open (0700), under a name nobody can guess, that must not exist already.
    fn private(label: &str) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!(
            "monocode-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&dir)
            .map_err(|e| format!("{}: {e}", dir.display()))?;
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
    /// Plain lines about files that were left out of the export and why.
    left_out: Vec<String>,
    /// The names written so far, folded (`fold`): an import refuses an export that lists one twice.
    seen: BTreeSet<String>,
    /// How much of the webview's files the export may hold (`MAX_INSPECT_BYTES`).
    webview_budget: u64,
}

impl Writer {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            secrets: 0,
            files: Vec::new(),
            left_out: Vec::new(),
            seen: BTreeSet::new(),
            webview_budget: MAX_INSPECT_BYTES,
        }
    }

    fn text(&mut self, relative: &str, text: &str) -> Result<bool, String> {
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

    fn json(&mut self, relative: &str, value: &Value) -> Result<bool, String> {
        let mut value = value.clone();
        self.secrets += scrubber().redact_value(&mut value);
        let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        let path = safe_relative(relative)
            .ok_or_else(|| format!("Not a path inside an export: {relative}"))?;
        self.raw(relative, &path, text.as_bytes())
    }

    /// A binary file (a git bundle) copied as it is: a plain file that is not a link. One past `cap` bytes is left out of
    /// the export, with a line, rather than failing it.
    fn binary(&mut self, relative: &str, source: &Path, cap: u64) -> Result<bool, String> {
        match plain_file::read(source, cap) {
            Ok(bytes) => self.bytes(relative, &bytes),
            Err(Refusal::TooBig) => {
                self.left_out.push(format!(
                    "The history in {relative} is larger than an export may hold of one file, so it was left out of the export."
                ));
                Ok(false)
            }
            Err(why) => Err(format!(
                "{} {}.",
                source.display(),
                match why {
                    Refusal::Link => "is a link",
                    Refusal::NotAFile => "isn't a plain file",
                    _ => "couldn't be read",
                }
            )),
        }
    }

    /// A binary file whose bytes are already in hand (an image), written as they are.
    fn bytes(&mut self, relative: &str, bytes: &[u8]) -> Result<bool, String> {
        let path = safe_relative(relative)
            .ok_or_else(|| format!("Not a path inside an export: {relative}"))?;
        self.raw(relative, &path, bytes)
    }

    /// Writes the file, or leaves it out with a line: true when it was written.
    fn raw(&mut self, relative: &str, path: &Path, bytes: &[u8]) -> Result<bool, String> {
        let canonical = canonical_relative(path);
        // The limits an import holds a file to (`left_out_reason`): a file past them is left out with a line, so the
        // export never holds a file the import would turn away.
        let webview_used: u64 = if is_webview(&canonical) {
            self.files
                .iter()
                .filter(|(name, _, _)| is_webview(name))
                .map(|(_, size, _)| size)
                .sum()
        } else {
            0
        };
        if let Some(why) = left_out_reason(
            &canonical,
            bytes.len() as u64,
            webview_used,
            self.webview_budget,
        ) {
            self.left_out.push(format!(
                "{relative} {why}, so it was left out of the export."
            ));
            return Ok(false);
        }
        // An import refuses an export that names one file twice (a name that differs only in capitals included).
        if !self.seen.insert(fold(&canonical)) {
            self.left_out.push(format!(
                "{relative} has the same name as a file already in the export, apart from capitals, so it was left out of the export."
            ));
            return Ok(false);
        }
        write_private(&self.root.join(path), bytes)?;
        self.files
            .push((relative.to_string(), bytes.len() as u64, sha256_hex(bytes)));
        Ok(true)
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
    export_with_vault(env, request, crate::secrets::store::active())
}

/// WP-92: the export with the vault handed in, so a test can pass an in-memory one and never touch the keychain.
pub fn export_with_vault(
    env: &Env,
    request: &ExportRequest,
    vault: &dyn crate::secrets::store::Vault,
) -> Result<ExportReport, String> {
    export_within(env, request, MAX_INSPECT_BYTES, vault)
}

/// The file that holds the setup itself: the one webview file an export never goes without.
const SETUP_FILE: &str = "setup/setup.json";

/// The webview's files, setup/setup.json first: should the budget leave one out, it is never that one.
fn write_webview_files(
    writer: &mut Writer,
    files: &BTreeMap<String, String>,
) -> Result<(), String> {
    if let Some(text) = files.get(SETUP_FILE) {
        writer.text(SETUP_FILE, text)?;
    }
    for (path, text) in files.iter().filter(|(path, _)| path.as_str() != SETUP_FILE) {
        writer.text(path, text)?;
    }
    Ok(())
}

/// Setup files that together are past what the preview holds stop the export with one line, before anything is
/// written, rather than an export that leaves some of them out.
fn check_webview_total(
    files: &BTreeMap<String, String>,
    webview_budget: u64,
) -> Result<(), String> {
    let total: u64 = files.values().map(|text| text.len() as u64).sum();
    if total > webview_budget {
        return Err(format!(
            "The setup files come to {:.1} MB; an export holds at most {} MB of them. Leave something out and try again.",
            total as f64 / 1024.0 / 1024.0,
            (webview_budget / 1024 / 1024).max(1)
        ));
    }
    Ok(())
}

/// `export`, holding the webview's files to `webview_budget` bytes.
fn export_within(
    env: &Env,
    request: &ExportRequest,
    webview_budget: u64,
    vault: &dyn crate::secrets::store::Vault,
) -> Result<ExportReport, String> {
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

    check_webview_total(&request.files, webview_budget)?;

    let staging = Scratch::beside(&destination, "export")?;
    let mut writer = Writer::new(staging.0.clone());
    writer.webview_budget = webview_budget;
    let mut counts = request.counts.clone();
    let mut notes = Vec::new();

    write_webview_files(&mut writer, &request.files)?;
    if let Some(choice) = &request.memory {
        export_memory(env, choice, &mut writer, &mut counts, &mut notes)?;
    }
    let vault_db = env.read_db()?;
    if request.workspace {
        if let Some(conn) = vault_db.as_ref() {
            export_workspace(env, conn, &mut writer, &mut counts).map_err(|e| e.to_string())?;
        }
        export_note_assets(env, &mut writer, &counts, &mut notes)?;
        counts.remove("noteIds");
    }
    // WP-92: the vault goes as an index of handles, never a value, and one exact-value pass runs before the last net.
    if let Some(conn) = vault_db.as_ref() {
        writer.json("secrets/index.json", &crate::secrets::index_json(conn)?)?;
        // Read once, not once per file: each value is a round trip to the Keychain.
        let needles = crate::secrets::known_needles(vault, conn, None)?;
        for index in 0..writer.files.len() {
            let relative = writer.files[index].0.clone();
            if is_binary(&relative) || relative == "secrets/index.json" {
                continue;
            }
            let path = staging.0.join(&relative);
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let clean = crate::secrets::scrub::mask(&text, &needles);
            if clean != text {
                write_private(&path, clean.as_bytes())?;
                writer.files[index] = (relative, clean.len() as u64, sha256_hex(clean.as_bytes()));
            }
        }
    }

    notes.append(&mut writer.left_out);
    // Everything an import holds an export to as a whole: the same limits, so no export is written that one refuses.
    check_export_limits(
        writer.files.len(),
        writer.files.iter().map(|(_, size, _)| size).sum(),
    )?;

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
    let manifest_text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    if manifest_text.len() as u64 > MAX_MANIFEST {
        return Err(format!(
            "This export's list of files would be {} MB; an import reads at most {} MB of one. Leave something out and try again.",
            manifest_text.len() / 1024 / 1024,
            MAX_MANIFEST / 1024 / 1024
        ));
    }
    write_private(&staging.0.join(MANIFEST), manifest_text.as_bytes())?;
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
            if writer.text(&format!("memory/{name}/{relative}"), &text)? {
                files += 1;
            }
        }
        if choice.history && dir.join(".git").exists() {
            match history_bundle(&dir) {
                Ok(bundle) => {
                    writer.binary(&format!("memory/{name}.git.bundle"), &bundle.1, MAX_BUNDLE)?;
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

/// The name Claude Code gives a folder's transcripts: every character that isn't a letter or digit becomes `-`.
fn claude_project_dir_name(folder: &str) -> String {
    folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The transcript is in the Claude project folder of this working folder, not just somewhere on this Mac.
fn claude_transcript_for(env: &Env, provider_session_id: &str, folder: &str) -> bool {
    session_file_id(provider_session_id)
        && env.claude_home.as_ref().is_some_and(|home| {
            home.join("projects")
                .join(claude_project_dir_name(folder))
                .join(format!("{provider_session_id}.jsonl"))
                .is_file()
        })
}

/// Another chat here already resumes this provider conversation.
fn provider_id_held(conn: &Connection, provider_session_id: &str, own_id: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE provider_session_id = ?1 AND id != ?2)",
        params![provider_session_id, own_id],
        |row| row.get(0),
    )
    .unwrap_or(true)
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
    private_chat: bool,
    private_boundary_id: Option<String>,
    registry_agent_id: Option<String>,
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
    // A database from before the column has no More agents link to export.
    let registry_select = if columns.iter().any(|c| c == "registry_agent_id") {
        "registry_agent_id"
    } else {
        "NULL"
    };
    let mut statement = conn.prepare(&format!(
        "SELECT id, cwd, harness, model, model_settings, runtime_mode, title, provider_session_id, blocks_json,
                created_at, updated_at, branch, context_used, context_window, archived, worktree_cwd, pinned,
                linked_work_item_json, worktree_removed, automation_id, sidebar_hidden,
                private_chat, private_boundary_id, {registry_select}
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
                private_chat: row.get::<_, i64>(21)? != 0,
                private_boundary_id: crate::session_store::boundary_for_read(row.get(22)?),
                registry_agent_id: row.get(23)?,
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
            "private": row.private_chat,
            "privateBoundaryId": row.private_boundary_id,
            "registryAgentId": row.registry_agent_id,
            "linkedWorkItem": row.linked_work_item_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
            "automationId": row.automation_id,
            "contextUsed": row.context_used,
            "contextWindow": row.context_window,
            "monoTranscript": mono,
            "providerTranscript": pointer,
            "blocks": blocks,
        });
        // Only a chat the export holds is counted: one the writer left out is in its notes instead.
        if writer
            .json(&format!("workspace/sessions/{id}.json"), &file)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?
        {
            sessions += 1;
        }
    }
    counts.insert("sessions".into(), json!(sessions));

    let wrote = |writer: &mut Writer, path: &str, value: Value| {
        writer
            .json(path, &value)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
    };
    // A table's count is what its file holds in the export: nothing, when the writer left the file out.
    let counted = |writer: &mut Writer,
                   counts: &mut Map<String, Value>,
                   key: &str,
                   path: &str,
                   rows: Vec<Value>| {
        let len = rows.len();
        let written = wrote(writer, path, Value::Array(rows))?;
        counts.insert(key.into(), json!(if written { len } else { 0 }));
        Ok::<(), rusqlite::Error>(())
    };
    let notes = table_rows(conn, "notes", "created_at, id")?;
    let note_ids: Vec<Value> = notes.iter().filter_map(|n| n.get("id").cloned()).collect();
    let note_count = notes.len();
    // Notes left out of the export take their pictures with them: none are exported for notes it doesn't hold.
    if wrote(
        writer,
        "workspace/notes.json",
        Value::Array(notes.into_iter().map(Value::Object).collect()),
    )? {
        counts.insert("notes".into(), json!(note_count));
        counts.insert("noteIds".into(), Value::Array(note_ids));
    } else {
        counts.insert("notes".into(), json!(0));
        counts.insert("noteIds".into(), Value::Array(Vec::new()));
    }
    // WP-72: a page's history and mentions travel with the note. An older export has neither file.
    let doc_versions = table_rows(conn, "note_versions", "note_id, version")?;
    counted(
        writer,
        counts,
        "docVersions",
        "workspace/doc-versions.json",
        doc_versions.into_iter().map(Value::Object).collect(),
    )?;
    let doc_mentions = table_rows(conn, "note_mentions", "note_id, kind, target_id")?;
    counted(
        writer,
        counts,
        "docMentions",
        "workspace/doc-mentions.json",
        doc_mentions.into_iter().map(Value::Object).collect(),
    )?;

    let automations: Vec<Value> = table_rows(conn, "automations", "updated_at, id")?
        .into_iter()
        .filter_map(|row| {
            row.get("definition_json")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str(raw).ok())
        })
        .collect();
    counted(
        writer,
        counts,
        "automations",
        "workspace/automations.json",
        automations,
    )?;

    let reminders: Vec<Value> = table_rows(conn, "session_reminders", "due_at, session_id")?
        .into_iter()
        .map(|row| json!({"sessionId": row.get("session_id"), "dueAt": row.get("due_at"), "firedAt": row.get("fired_at")}))
        .collect();
    counted(
        writer,
        counts,
        "reminders",
        "workspace/reminders.json",
        reminders,
    )?;

    let delegations: Vec<Value> = table_rows(conn, "delegations", "created_at, id")?
        .into_iter()
        .map(|mut row| {
            for mirror in ["mirrored_version", "mirror_error"] {
                row.remove(mirror);
            }
            Value::Object(row)
        })
        .collect();
    counted(
        writer,
        counts,
        "delegations",
        "workspace/delegations.json",
        delegations,
    )?;

    // WP-78: the activity log rides with the workspace. Rows past 90 days stay
    // out, and the writer scrubs the summaries again.
    let activity = crate::activity::export_rows(conn)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
    counted(
        writer,
        counts,
        "activity",
        "workspace/activity.json",
        activity,
    )?;
    Ok(())
}

const NOTE_ASSET_DIR: &str = "note-assets";

/// Each exported note's pictures, as they are: plain files of a size a note takes, in a folder that is not a link
/// (one that is would carry out whatever it points at). What is left out is said in `notes`.
fn export_note_assets(
    env: &Env,
    writer: &mut Writer,
    counts: &Map<String, Value>,
    notes: &mut Vec<String>,
) -> Result<(), String> {
    let Some(ids) = counts.get("noteIds").and_then(Value::as_array) else {
        return Ok(());
    };
    let all = env.data_dir.join(NOTE_ASSET_DIR);
    match folder_state(&all) {
        Folder::Absent => return Ok(()),
        Folder::Real => {}
        Folder::Refused => {
            notes.push(format!(
                "{NOTE_ASSET_DIR} is a link, so no note pictures were exported."
            ));
            return Ok(());
        }
    }
    for id in ids
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| session_file_id(id))
    {
        let dir = all.join(id);
        match folder_state(&dir) {
            Folder::Absent => continue,
            Folder::Real => {}
            Folder::Refused => {
                notes.push(format!(
                    "The pictures of note {id} were not exported: {NOTE_ASSET_DIR}/{id} is a link."
                ));
                continue;
            }
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|entry| {
                entry
                    .file_type()
                    .is_ok_and(|t| t.is_file() || t.is_symlink())
            })
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| safe_relative(name).is_some())
            .collect();
        names.sort();
        for name in names {
            let relative = format!("workspace/{NOTE_ASSET_DIR}/{id}/{name}");
            match plain_file::read(&dir.join(&name), crate::notes::IMAGE_MAX_BYTES) {
                Ok(bytes) => {
                    writer.bytes(&relative, &bytes)?;
                }
                Err(why) => notes.push(format!(
                    "{NOTE_ASSET_DIR}/{id}/{name} was not exported: {}.",
                    match why {
                        Refusal::Link => "it is a link",
                        Refusal::NotAFile => "it isn't a plain file",
                        Refusal::Unreadable => "it couldn't be read",
                        Refusal::TooBig => "it is too large for a note picture",
                    }
                )),
            }
        }
    }
    Ok(())
}

// ---- reading an export ---------------------------------------------------------------------------------------------

/// One file the manifest lists: where it is in the export (spelled the one way, `a/b`), the bytes it says it holds,
/// and its SHA-256.
struct Listed {
    path: String,
    declared: u64,
    sha256: String,
}

/// Why a file the manifest lists couldn't be used as listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unusable {
    Link,
    NotAFile,
    Unreadable,
    /// Longer than the manifest says, or it doesn't hash as listed.
    Changed,
}

impl From<Refusal> for Unusable {
    fn from(why: Refusal) -> Self {
        match why {
            Refusal::Link => Unusable::Link,
            Refusal::NotAFile => Unusable::NotAFile,
            Refusal::Unreadable => Unusable::Unreadable,
            Refusal::TooBig => Unusable::Changed,
        }
    }
}

impl Unusable {
    /// For the report: what happened to a file that was fine when the export was checked.
    fn since_the_check(self) -> &'static str {
        match self {
            Unusable::Link => "is now a link",
            Unusable::NotAFile => "is no longer a plain file",
            Unusable::Unreadable => "couldn't be read",
            Unusable::Changed => "changed after the export was checked",
        }
    }
}

/// The most one listed file may hold, by what it is: a note's picture is no bigger than a note takes, a memory
/// folder's history is a bundle, and everything else is text or JSON that is read whole into memory.
fn kind_cap(canonical: &str) -> u64 {
    let history = canonical
        .strip_prefix("memory/")
        .is_some_and(|name| name.ends_with(".git.bundle") && !name.contains('/'));
    if canonical.starts_with("workspace/note-assets/") {
        crate::notes::IMAGE_MAX_BYTES
    } else if history {
        MAX_BUNDLE
    } else {
        MAX_TEXT_FILE
    }
}

/// Whether a path is one of the webview's own files, which Inspect holds whole.
fn is_webview(canonical: &str) -> bool {
    WEBVIEW_PREFIXES
        .iter()
        .any(|prefix| canonical.starts_with(prefix))
}

/// Why a file of `size` bytes can't be part of an export, or None if it can: the one rule export and import share, so
/// what one writes the other takes. `webview_used` is how much of the webview's files are in already.
fn left_out_reason(
    canonical: &str,
    size: u64,
    webview_used: u64,
    webview_budget: u64,
) -> Option<String> {
    let cap = kind_cap(canonical);
    if size > cap {
        return Some(format!(
            "is {} MB, more than a file of that kind may be ({} MB)",
            size / 1024 / 1024,
            cap / 1024 / 1024
        ));
    }
    if is_webview(canonical) && size > webview_budget.saturating_sub(webview_used) {
        return Some(format!(
            "would take the setup files past the {} MB the preview holds",
            (webview_budget / 1024 / 1024).max(1)
        ));
    }
    None
}

/// What an import holds a whole export to, checked by the export before it writes the manifest: no more files than an
/// archive has entries, no more bytes than it may unpack to.
fn check_export_limits(entries: usize, total: u64) -> Result<(), String> {
    if entries > MAX_ENTRIES {
        return Err(format!(
            "This export would hold {entries} files; an import takes at most {MAX_ENTRIES}. Leave something out and try again."
        ));
    }
    if total > MAX_UNPACKED {
        return Err(format!(
            "This export would be {} GB; an import takes at most {} GB. Leave something out and try again.",
            total / 1024 / 1024 / 1024,
            MAX_UNPACKED / 1024 / 1024 / 1024
        ));
    }
    Ok(())
}

/// No more than the manifest says a file holds (and a manifest can't say more than its kind allows): a file swapped
/// for something huge can't fill the memory.
fn listed_cap(listed: &Listed) -> u64 {
    listed.declared.min(kind_cap(&listed.path))
}

/// Whether the file at `path` is a plain file, not a link, that hashes as `listed` says. Streamed: it is never held in
/// memory whole, and no more than the listed size is read.
fn check_listed(path: &Path, listed: &Listed) -> Result<(), Unusable> {
    let mut hash = Sha256::new();
    plain_file::stream(path, listed_cap(listed), |piece| hash.update(piece))?;
    if hex_of(&hash.finalize()) == listed.sha256 {
        Ok(())
    } else {
        Err(Unusable::Changed)
    }
}

/// The bytes of the plain file at `path`, if they hash as `listed` says. The hash is of the very bytes returned: the
/// caller uses what was checked, never a second read of the file.
fn read_as_listed(path: &Path, listed: &Listed) -> Result<Vec<u8>, Unusable> {
    let bytes = plain_file::read(path, listed_cap(listed))?;
    if sha256_hex(&bytes) == listed.sha256 {
        Ok(bytes)
    } else {
        Err(Unusable::Changed)
    }
}

/// Whether `folder`, links resolved, is inside `real_root` (itself resolved). A folder that isn't there is, for now: the
/// file in it is missing, which is said next. A folder that can't be resolved for any other reason is not.
fn folder_is_inside(real_root: &Path, folder: &Path) -> bool {
    match fs::canonicalize(folder) {
        Ok(real) => real.starts_with(real_root),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// What a manifest lists, checked against what an export may be before anything is read from the disk.
struct Listing {
    /// The files that can be used, in the manifest's order.
    files: Vec<Listed>,
    /// Where each of them is in `files` (folded: see `fold`).
    index: HashMap<String, usize>,
    /// Lines for the report about files left out (see `left_out_reason`), and the paths they are.
    left_out: Vec<String>,
    left_out_paths: HashSet<String>,
    /// Each file left out and why, for the preview.
    too_big: Vec<LeftOutFile>,
}

/// A file an export lists that an import will leave out, and why (`left_out_reason`), for the preview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftOutFile {
    pub path: String,
    pub reason: String,
}

/// Every file a manifest lists, checked against what an export may be before anything is read from the disk: no more
/// than an archive has entries, each with a path that is inside the export and a size, all of them together no bigger
/// than an archive may unpack to, and none listed twice (however it is spelled: `a/./b`, `a//b`, `A/B` are one file;
/// two names that differ only in capitals are refused too, which a disk that tells them apart could keep apart). A file
/// bigger than its kind allows, or past what Inspect holds of the webview's files, is not a reason to refuse the lot:
/// it is left out, and never hashed or read.
fn list_files(manifest: &Value, webview_budget: u64) -> Result<Listing, String> {
    let entries = manifest["files"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if entries.len() > MAX_ENTRIES {
        return Err("That export lists too many files to be an export.".into());
    }
    let mut listing = Listing {
        files: Vec::with_capacity(entries.len()),
        index: HashMap::with_capacity(entries.len()),
        left_out: Vec::new(),
        left_out_paths: HashSet::new(),
        too_big: Vec::new(),
    };
    let mut seen: HashSet<String> = HashSet::with_capacity(entries.len());
    let mut total = 0u64;
    let mut webview = 0u64;
    for file in entries {
        let relative = file["path"].as_str().unwrap_or("");
        let safe = safe_relative(relative)
            .ok_or_else(|| format!("The export lists a bad path: {relative}"))?;
        let canonical = canonical_relative(&safe);
        let declared = file["bytes"]
            .as_u64()
            .ok_or_else(|| format!("The export doesn't say how big {relative} is."))?;
        total = total.saturating_add(declared);
        if total > MAX_UNPACKED {
            return Err(
                "That export lists more than an archive may hold; it is too large to be an export."
                    .into(),
            );
        }
        let key = fold(&canonical);
        if !seen.insert(key.clone()) {
            return Err(format!("The export lists {relative} more than once."));
        }
        if let Some(why) = left_out_reason(&canonical, declared, webview, webview_budget) {
            // A note's pictures are said per note, when the note comes in (`copy_note_assets`).
            if !canonical.starts_with("workspace/note-assets/") {
                listing
                    .left_out
                    .push(format!("{relative} {why}, so it was left out."));
            }
            listing.too_big.push(LeftOutFile {
                path: relative.to_string(),
                reason: why,
            });
            listing.left_out_paths.insert(canonical);
            continue;
        }
        if is_webview(&canonical) {
            webview += declared;
        }
        listing.index.insert(key, listing.files.len());
        listing.files.push(Listed {
            path: canonical,
            declared,
            sha256: file["sha256"].as_str().unwrap_or("").to_string(),
        });
    }
    Ok(listing)
}

/// An export opened for reading. An archive is unpacked into a scratch folder that goes when this does.
// One of these exists per import, so the size of the bigger variant costs nothing.
#[allow(clippy::large_enum_variant)]
enum Opened {
    V1(String),
    V2 {
        root: PathBuf,
        manifest: Value,
        /// Every file the manifest lists, in its order. `open_export` found each one there and hashing as listed.
        files: Vec<Listed>,
        /// Where each listed path is in `files` (folded: see `fold`).
        index: HashMap<String, usize>,
        /// Lines about listed files that were left out (`left_out_reason`), and which paths they are.
        left_out: Vec<String>,
        left_out_paths: HashSet<String>,
        /// Each file left out and why, for the preview.
        too_big: Vec<LeftOutFile>,
        /// Listed files that were fine when the export was checked and weren't when they were read, for the report.
        problems: Mutex<Vec<String>>,
        _scratch: Option<Scratch>,
    },
}

/// Why a file of the export couldn't be read as text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadFailure {
    /// The manifest doesn't list it.
    Unlisted,
    Unusable(Unusable),
    /// It hashes as listed, and isn't UTF-8.
    NotText,
}

impl Opened {
    fn root(&self) -> Option<&Path> {
        match self {
            Opened::V2 { root, .. } => Some(root),
            Opened::V1(_) => None,
        }
    }

    /// The manifest's entry for a file, by any spelling of its path.
    fn listed_file(&self, relative: &str) -> Option<&Listed> {
        let Opened::V2 { files, index, .. } = self else {
            return None;
        };
        let key = fold(&canonical_relative(&safe_relative(relative)?));
        Some(&files[*index.get(&key)?])
    }

    /// The text of a file the manifest lists, as the bytes that hash as listed: nothing the manifest doesn't list is
    /// read, whatever its name, and a listed file that is a link, or changed since `open_export` checked it, isn't
    /// either.
    fn read_text(&self, relative: &str) -> Result<String, ReadFailure> {
        let (Some(root), Some(listed)) = (self.root(), self.listed_file(relative)) else {
            return Err(ReadFailure::Unlisted);
        };
        let path = root.join(safe_relative(&listed.path).ok_or(ReadFailure::Unlisted)?);
        let bytes = read_as_listed(&path, listed).map_err(ReadFailure::Unusable)?;
        String::from_utf8(bytes).map_err(|_| ReadFailure::NotText)
    }

    /// `read_text`, and a listed file that can't be used any more is kept for the report (`take_problems`).
    fn read(&self, relative: &str) -> Option<String> {
        match self.read_text(relative) {
            Ok(text) => Some(text),
            Err(ReadFailure::Unusable(why)) => {
                if let Opened::V2 { problems, .. } = self {
                    let line = format!(
                        "{relative} {}, so nothing was used from it.",
                        why.since_the_check()
                    );
                    if let Ok(mut problems) = problems.lock() {
                        if !problems.contains(&line) {
                            problems.push(line);
                        }
                    }
                }
                None
            }
            Err(_) => None,
        }
    }

    fn json(&self, relative: &str) -> Option<Value> {
        serde_json::from_str(&self.read(relative)?).ok()
    }

    /// Whether the manifest lists this path and it was left out for its size.
    fn is_left_out(&self, canonical: &str) -> bool {
        matches!(self, Opened::V2 { left_out_paths, .. } if left_out_paths.contains(canonical))
    }

    /// The lines for the report about listed files that were left out.
    fn left_out_notes(&self) -> &[String] {
        match self {
            Opened::V2 { left_out, .. } => left_out,
            Opened::V1(_) => &[],
        }
    }

    /// The lines for the report about listed files that couldn't be used since the export was checked.
    fn take_problems(&self) -> Vec<String> {
        match self {
            Opened::V2 { problems, .. } => problems
                .lock()
                .map(|mut lines| std::mem::take(&mut *lines))
                .unwrap_or_default(),
            Opened::V1(_) => Vec::new(),
        }
    }

    fn listed(&self) -> Vec<String> {
        self.listed_files()
            .iter()
            .map(|listed| listed.path.clone())
            .collect()
    }

    /// Each file the manifest lists.
    fn listed_files(&self) -> &[Listed] {
        match self {
            Opened::V2 { files, .. } => files,
            Opened::V1(_) => &[],
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
        // A folder, not a link to one: an export isn't taken from somewhere else through a link inside the picked folder.
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_dir())
                && !e.file_name().to_string_lossy().starts_with('.')
        });
    let only = inner.next()?;
    if inner.next().is_some() {
        return None;
    }
    only.path().join(MANIFEST).is_file().then(|| only.path())
}

fn unpack(archive: &Path) -> Result<Scratch, String> {
    unpack_within(archive, MAX_UNPACKED)
}

/// `unpack` with the most bytes the archive may unpack to.
fn unpack_within(archive: &Path, budget: u64) -> Result<Scratch, String> {
    // A folder only this user can open: an export holds Ash's chats and memory.
    let scratch = Scratch::private("import")?;
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
            // `size()` is what the tar crate copies: a PAX size record overrides the header's own.
            let remaining = budget - total;
            if entry.size() > remaining {
                return Err("That archive is too large to be an export.".into());
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
            // And what is really written is checked against what is left, not taken from the entry's word.
            let written = std::io::copy(
                &mut std::io::Read::take(&mut entry, remaining + 1),
                &mut out,
            )
            .map_err(|e| e.to_string())?;
            total += written;
            if total > budget {
                return Err("That archive is too large to be an export.".into());
            }
        } else {
            return Err("That archive holds links or devices; it was not opened.".into());
        }
    }
    Ok(scratch)
}

fn open_export(path: &str) -> Result<Opened, String> {
    open_export_within(path, MAX_INSPECT_BYTES)
}

/// `open_export` with how much of the webview's files Inspect may hold.
fn open_export_within(path: &str, webview_budget: u64) -> Result<Opened, String> {
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
            // Read like the manifest: a plain file that is not a link, of a size a manifest can be.
            let text = plain_file::read(&path, MAX_MANIFEST)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .ok_or_else(|| "That file isn't a MonoCode Hub export.".to_string())?;
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
    // The manifest is read like every file it lists: a plain file that is not a link, of a size a manifest can be.
    let manifest: Value = serde_json::from_slice(
        &plain_file::read(&root.join(MANIFEST), MAX_MANIFEST)
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
    // What the manifest lists is checked against what an export may be before anything is read from the disk.
    let Listing {
        files,
        index,
        left_out,
        left_out_paths,
        too_big,
    } = list_files(&manifest, webview_budget)?;
    // Every listed file must be there, in a folder of the export itself, a plain file (not a link, a pipe or a
    // device), unchanged.
    let real_root =
        fs::canonicalize(&root).map_err(|_| "The export's folder couldn't be read.".to_string())?;
    let mut folders: HashMap<PathBuf, bool> = HashMap::new();
    for listed in &files {
        let relative = &listed.path;
        let path = root.join(
            safe_relative(relative)
                .ok_or_else(|| format!("The export lists a bad path: {relative}"))?,
        );
        if let Some(folder) = path.parent() {
            // A folder that is a link (or has one above it) leads out of the export; a folder that isn't there leaves
            // the file missing, said below.
            let inside = *folders
                .entry(folder.to_path_buf())
                .or_insert_with(|| folder_is_inside(&real_root, folder));
            if !inside {
                return Err(format!(
                    "The export lists {relative}, which is in a folder that leads outside the export."
                ));
            }
        }
        check_listed(&path, listed).map_err(|why| match why {
            Unusable::Link => {
                format!("The export lists {relative}, which is a link. Links aren't followed.")
            }
            Unusable::NotAFile => format!("The export lists {relative}, which isn't a plain file."),
            Unusable::Unreadable => format!("The export is missing {relative}."),
            Unusable::Changed => {
                format!("The export is damaged or was changed after it was made: {relative}.")
            }
        })?;
    }
    Ok(Opened::V2 {
        root,
        manifest,
        files,
        index,
        left_out,
        left_out_paths,
        too_big,
        problems: Mutex::new(Vec::new()),
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
    /// Activity rows in the file. They come in with the workspace, with no tick of their own.
    pub activity: usize,
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
    /// Files the export lists that an import will leave out (too big for their kind, or past what the preview holds).
    pub left_out: Vec<LeftOutFile>,
}

/// Two chats are the same when their words and blocks match. File paths are left out of the comparison: an import
/// never keeps them (`drop_imported_file_paths`), and keeps a tool row's paths only inside the chat's kept folder
/// (`FolderRules::confine_tool_paths`), so a chat that came in from this file must still read as here.
fn blocks_digest(title: &str, blocks: &[Value]) -> String {
    let mut blocks = Value::Array(blocks.to_vec());
    drop_imported_file_paths(&mut blocks);
    drop_tool_paths(&mut blocks);
    let mut text = String::from(title);
    text.push('\n');
    text.push_str(&serde_json::to_string(&blocks).unwrap_or_default());
    sha256_hex(text.as_bytes())
}

/// Empties the paths an import may drop from a chat's tool rows and approvals (`FolderRules::confine_tool_paths`), for
/// the comparison only.
fn drop_tool_paths(blocks: &mut Value) {
    let Some(list) = blocks.as_array_mut() else {
        return;
    };
    for block in list {
        for pointer in ["/tool/paths", "/approval/call/paths"] {
            if let Some(paths) = block.pointer_mut(pointer) {
                *paths = json!([]);
            }
        }
        if let Some(preview) = block
            .pointer_mut("/tool/preview")
            .and_then(Value::as_object_mut)
        {
            preview.remove("path");
        }
    }
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
    inspect_within(env, path, MAX_INSPECT_BYTES)
}

/// `inspect` with how much of the webview's files it may hold.
fn inspect_within(env: &Env, path: &str, webview_budget: u64) -> Result<Inspection, String> {
    let opened = open_export_within(path, webview_budget)?;
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
                left_out: Vec::new(),
            })
        }
        Opened::V2 { manifest, .. } => manifest.clone(),
    };
    let left_out = match &opened {
        Opened::V2 { too_big, .. } => too_big.clone(),
        Opened::V1(_) => Vec::new(),
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
        left_out,
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
    // WP-78: how many activity rows the file holds. Import adds them whenever the workspace comes in.
    preview.activity = opened
        .json("workspace/activity.json")
        .and_then(|v| v.as_array().map(Vec::len))
        .unwrap_or(0);
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
    /// Folders the window lists as projects (the project rail's), on top of the app's own project record. A chat or
    /// automation keeps its folder only inside one of these or a project in that record; none given means only the record.
    #[serde(default)]
    pub known_folders: Vec<String>,
    /// The Monos seated here (their ids): a chat keeps a Mono's own folder only for one of these.
    #[serde(default)]
    pub known_monos: Vec<String>,
    /// This Mac's folder for each project the file names, by project id: `{from: the file's folder, to: this Mac's}`.
    /// A chat's folder from another Mac (another user name, another home) is mapped through it, then judged as usual.
    #[serde(default)]
    pub folder_map: Vec<FolderMapping>,
}

/// A project the file names, for mapping a chat's folder from another Mac: its id and folder in the file, and this Mac's
/// folder for the same id (blank when the project has none here yet).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMapping {
    #[serde(default)]
    pub project_id: String,
    pub from: String,
    #[serde(default)]
    pub to: String,
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
    /// WP-78: activity rows added. A row already stored, or older than 90 days, is not counted.
    pub activity_added: usize,
    /// Chats whose folder (or worktree) the file named and that isn't inside a project here: it was cleared, so the chat
    /// asks which project to use before it runs anything.
    pub folders_cleared: usize,
    /// Automations that lost a folder or worktree the same way (they come back paused).
    pub automation_folders_cleared: usize,
    /// Paths in tool rows and approvals that lay outside the chat's kept folders, dropped.
    pub tool_paths_dropped: usize,
    /// Pictures of imported notes that were left out: a link, a file the manifest doesn't list, one that changed
    /// after the export was checked. Each is also said in `notes`.
    pub note_assets_skipped: usize,
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
    /// WP-92: vault rows added, each waiting for its value.
    pub secrets_added: usize,
}

/// `lock` takes the session store's lock. Every chat save waits on it, so it is taken only around the rows that go in
/// (the workspace's, and WP-92's vault index when the export names any secret): the export is unpacked and checked (up
/// to MAX_UNPACKED) and the memory written before it, never under it.
pub fn import<G: std::ops::Deref<Target = Connection>>(
    env: &Env,
    request: &ImportRequest,
    lock: impl FnOnce() -> Result<G, String>,
) -> Result<ImportReport, String> {
    let opened = open_export(&request.path)?;
    import_opened(env, &opened, request, lock)
}

/// `import` of an export that is already open and checked.
fn import_opened<G: std::ops::Deref<Target = Connection>>(
    env: &Env,
    opened: &Opened,
    request: &ImportRequest,
    lock: impl FnOnce() -> Result<G, String>,
) -> Result<ImportReport, String> {
    let mut report = ImportReport::default();
    if opened.root().is_none() {
        return Ok(report);
    }
    // Memory first (never under the chat store's lock). What it wrote is remembered as files: a chat can't keep a folder
    // where one that a CLI reads as instructions now sits.
    let mut written = Vec::new();
    if let Some(memory) = &request.memory {
        import_memory(env, opened, memory, &mut report, &mut written)?;
    }
    // The folder rules load after it: a Mono's folder is one of a Mono seated here (never whatever is on disk), so a
    // memory folder in the file (`monos/evil`) is nobody's, and a fresh Mac's restored Monos are theirs once seated. The
    // project record is read without holding the chat store's lock.
    let mut rules = {
        let none = WorkspaceImport::default();
        let ws = request.workspace.as_ref().unwrap_or(&none);
        let map: Vec<folders::ProjectMapping> = ws
            .folder_map
            .iter()
            .map(|pair| folders::ProjectMapping {
                id: pair.project_id.clone(),
                from: pair.from.clone(),
                to: pair.to.clone(),
            })
            .collect();
        FolderRules::load(
            env,
            &project_record_folders(env),
            &ws.known_folders,
            &ws.known_monos,
            &map,
        )
    };
    rules.note_written(&written);
    // WP-92: the vault's index lands as rows that wait for their value, with no grants and no .env records. An index
    // that names nothing is not a reason to take the lock every chat save waits on.
    let index = opened.json("secrets/index.json").filter(|index| {
        index
            .get("secrets")
            .and_then(Value::as_array)
            .is_some_and(|list| !list.is_empty())
    });
    if request.workspace.is_some() || index.is_some() {
        let conn = lock()?;
        if let Some(index) = &index {
            report.secrets_added =
                crate::secrets::import_index(&conn, index, crate::session_store::now_millis())?;
        }
        if let Some(workspace) = &request.workspace {
            import_workspace(env, &conn, opened, workspace, &mut report, &rules)
                .map_err(|e| e.to_string())?;
            // Said in the report, so nobody finds out by surprise.
            if report.sessions_added + report.sessions_copied + report.automations_added > 0 {
                report.notes.push(
                    "Every restored chat and automation comes back supervised, whatever its file said; raise it for the ones you want freer."
                        .to_string(),
                );
            }
            if report.folders_cleared + report.automation_folders_cleared > 0 {
                report.notes.push(
                    "A chat or automation whose folder is in ~/agent-memory, in a hidden folder or outside your home folder can't be relinked; choose a folder for it."
                        .to_string(),
                );
            }
        }
    }
    // Files left out for their size, and a listed file that was fine when the export was checked and wasn't when it
    // was read: not used, and said.
    report.notes.extend(opened.left_out_notes().iter().cloned());
    report.notes.extend(opened.take_problems());
    Ok(report)
}

/// One chat that came in with no folder and can have one back now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relink {
    pub session_id: String,
    /// The folder as this Mac resolves it.
    pub folder: String,
    /// The project (or Mono) folder it sits in: what "Relink all" groups by.
    pub group: String,
}

/// The chats that came in with no folder and can have the folder their file named back: it exists here, passes the
/// same allow-list, sits inside a project this copy has or in the folder of a Mono seated here, and is not one the
/// import itself wrote instructions into. A chat that has a folder, one with no note, and one whose folder still
/// doesn't qualify are left out. Nothing runs from the note itself.
pub(crate) fn relink_candidates(
    env: &Env,
    only: Option<&str>,
    known: &[String],
    known_monos: &[String],
) -> Vec<Relink> {
    let Ok(Some(conn)) = env.read_db() else {
        return Vec::new();
    };
    let Ok(mut statement) = conn.prepare(
        "SELECT n.session_id, n.cwd, n.project_id, n.rest FROM imported_chat_folders n
         JOIN sessions s ON s.id = n.session_id
         WHERE s.cwd = '' AND n.blocked = 0 AND (?1 IS NULL OR n.session_id = ?1)
         ORDER BY n.session_id",
    ) else {
        return Vec::new();
    };
    let rows: Vec<(String, String, Option<String>, Option<String>)> = statement
        .query_map([only], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default();
    drop(statement);
    drop(conn);
    if rows.is_empty() {
        return Vec::new();
    }
    let record = project_record(env);
    let record_folders: Vec<String> = record.iter().map(|(_, folder)| folder.clone()).collect();
    let rules = FolderRules::load(env, &record_folders, known, known_monos, &[]);
    rows.into_iter()
        .filter_map(|(session_id, named, project_id, rest)| {
            // A chat whose file named a project is mapped through the project record as it is now, by id, the way a
            // Mono's folder is: the project may only have got its folder here since the import.
            let current = project_id.as_deref().and_then(|id| {
                record
                    .iter()
                    .find(|(known, _)| known == id)
                    .map(|(_, folder)| {
                        Path::new(folder)
                            .join(rest.as_deref().unwrap_or_default())
                            .to_string_lossy()
                            .into_owned()
                    })
            });
            let kept = rules.vet(Some(current.as_deref().unwrap_or(&named)), None);
            if kept.cwd.is_empty() {
                return None;
            }
            // A Mono's folder is checked on disk again: instruction files there now (the import's snapshot may be old)
            // keep it from being offered.
            let group = kept.group.clone().unwrap_or_else(|| kept.cwd.clone());
            if rules.is_mono_folder(Path::new(&group))
                && rules.instructions_on_disk(Path::new(&kept.cwd), Path::new(&group))
            {
                return None;
            }
            Some(Relink {
                group,
                folder: kept.cwd,
                session_id,
            })
        })
        .collect()
}

pub(crate) fn relink_candidate(
    env: &Env,
    session_id: &str,
    known: &[String],
    known_monos: &[String],
) -> Option<String> {
    relink_candidates(env, Some(session_id), known, known_monos)
        .into_iter()
        .next()
        .map(|relink| relink.folder)
}

/// Gives these chats their folders back and forgets their notes. Only a chat that still has none is touched.
pub(crate) fn apply_relinks(
    conn: &Connection,
    relinks: &[Relink],
) -> rusqlite::Result<Vec<Relink>> {
    let mut applied = Vec::new();
    for relink in relinks {
        let changed = conn.execute(
            "UPDATE sessions SET cwd = ?1, worktree_cwd = NULL WHERE id = ?2 AND cwd = ''",
            params![relink.folder, relink.session_id],
        )?;
        conn.execute(
            "DELETE FROM imported_chat_folders WHERE session_id = ?1",
            [&relink.session_id],
        )?;
        if changed > 0 {
            applied.push(relink.clone());
        }
    }
    Ok(applied)
}

#[tauri::command]
pub async fn portable_relink_candidate(
    app: AppHandle,
    session_id: String,
    known_folders: Vec<String>,
    known_monos: Vec<String>,
) -> Result<Option<String>, String> {
    let env = Env::for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        relink_candidate(&env, &session_id, &known_folders, &known_monos)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Every chat with no folder that can have one back, for the sidebar's "Relink all" (one button per project or Mono).
#[tauri::command]
pub async fn portable_relink_candidates(
    app: AppHandle,
    known_folders: Vec<String>,
    known_monos: Vec<String>,
) -> Result<Vec<Relink>, String> {
    let env = Env::for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        relink_candidates(&env, None, &known_folders, &known_monos)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Relinks these chats: each is checked again now, then given its folder in the store. The window updates the ones it
/// has open to the same folder.
#[tauri::command]
pub async fn portable_relink_apply(
    app: AppHandle,
    store: State<'_, SessionStore>,
    session_ids: Vec<String>,
    known_folders: Vec<String>,
    known_monos: Vec<String>,
) -> Result<Vec<Relink>, String> {
    let env = Env::for_app(&app)?;
    let wanted: BTreeSet<String> = session_ids.into_iter().collect();
    let candidates = tauri::async_runtime::spawn_blocking(move || {
        relink_candidates(&env, None, &known_folders, &known_monos)
    })
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .filter(|relink| wanted.contains(&relink.session_id))
    .collect::<Vec<_>>();
    let conn = store.lock_conn()?;
    apply_relinks(&conn, &candidates).map_err(|e| e.to_string())
}

/// The folders of the projects in the app's own record (`hub_local_docs`, key `projects`), read through a read-only
/// connection so the chat store's lock isn't taken before the chats go in. Nothing found reads as no projects.
fn project_record_folders(env: &Env) -> Vec<String> {
    project_record(env)
        .into_iter()
        .map(|(_, folder)| folder)
        .collect()
}

/// The app's own project record as `(id, folder)`, for the projects that have a folder.
fn project_record(env: &Env) -> Vec<(String, String)> {
    let Ok(Some(conn)) = env.read_db() else {
        return Vec::new();
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT json FROM hub_local_docs WHERE key = 'projects'",
            [],
            |row| row.get(0),
        )
        .ok();
    let Some(doc) = raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
        return Vec::new();
    };
    doc.get("projects")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|project| {
                    let id = project.get("id").and_then(Value::as_str)?;
                    let folder = project.get("folder").and_then(Value::as_str)?;
                    (!folder.trim().is_empty()).then(|| (id.to_string(), folder.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
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
    rules: &FolderRules,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let mut after = AfterRows::default();
    workspace_rows(env, &tx, opened, wanted, report, &mut after, rules)?;
    tx.commit()?;
    for (from, to) in &after.note_assets {
        let left_out = copy_note_assets(env, opened, from, to);
        if !left_out.is_empty() {
            report.note_assets_skipped += left_out.len();
            report.notes.push(left_out_note(from, &left_out));
        }
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

/// Versions and mentions for notes this import actually added. A copy gets its own rows, and a page
/// mention follows a page that was copied. An export from before docs has neither file.
fn import_doc_history(
    conn: &Connection,
    opened: &Opened,
    inserted: &BTreeMap<String, String>,
    renamed: &BTreeMap<String, String>,
) -> rusqlite::Result<()> {
    let rewrite = |text: &str, from: &str, to: &str| {
        text.replace(
            &format!("{NOTE_ASSET_DIR}/{from}/"),
            &format!("{NOTE_ASSET_DIR}/{to}/"),
        )
    };
    if has_table(conn, "note_versions")? {
        for row in opened
            .json("workspace/doc-versions.json")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
        {
            let Some(mut row) = row.as_object().cloned() else {
                continue;
            };
            let Some(note_id) = row
                .get("note_id")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            let Some(target) = inserted.get(&note_id).cloned() else {
                continue;
            };
            if target != note_id {
                if let Some(Value::String(body)) = row.get_mut("body") {
                    *body = rewrite(body, &note_id, &target);
                }
                if let Some(Value::String(blocks)) = row.get_mut("blocks_json") {
                    *blocks = rewrite(blocks, &note_id, &target);
                }
                if let Some(old) = row.get("id").and_then(Value::as_str).map(str::to_string) {
                    row.insert("id".into(), json!(format!("{target}-{old}")));
                }
                row.insert("note_id".into(), json!(target));
            }
            insert_row(conn, "note_versions", &row)?;
        }
    }
    if has_table(conn, "note_mentions")? {
        for row in opened
            .json("workspace/doc-mentions.json")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
        {
            let Some(mut row) = row.as_object().cloned() else {
                continue;
            };
            let Some(note_id) = row
                .get("note_id")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            let Some(target) = inserted.get(&note_id).cloned() else {
                continue;
            };
            row.insert("note_id".into(), json!(target));
            if row.get("kind").and_then(Value::as_str) == Some("page") {
                if let Some(mentioned) = row
                    .get("target_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    if let Some(next) = renamed.get(&mentioned) {
                        row.insert("target_id".into(), json!(next));
                    }
                }
            }
            insert_row(conn, "note_mentions", &row)?;
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
    rules: &FolderRules,
) -> rusqlite::Result<()> {
    // Notes first: chats' artifact cards point at them.
    let note_ids: BTreeSet<&String> = wanted.notes.iter().collect();
    let copies: BTreeSet<&String> = wanted.note_copies.iter().collect();
    let mut inserted: BTreeMap<String, String> = BTreeMap::new();
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
            if let Some(Value::String(blocks)) = row.get_mut("blocks_json") {
                *blocks = blocks.replace(
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
            inserted.insert(id.clone(), target.clone());
            after.note_assets.push((id.clone(), target));
        }
    }

    // A copied page follows its copied parent. The kept original's children stay where they are.
    for (old, target) in &inserted {
        if old == target {
            continue;
        }
        let parent: Option<String> = conn.query_row(
            "SELECT parent_id FROM notes WHERE id = ?1",
            [target],
            |row| row.get(0),
        )?;
        if let Some(parent) = parent {
            if let Some(next) = report.renamed.get(&parent) {
                conn.execute(
                    "UPDATE notes SET parent_id = ?1 WHERE id = ?2",
                    params![next, target],
                )?;
            }
        }
    }
    import_doc_history(conn, opened, &inserted, &report.renamed)?;

    let mut paths_left_out = 0;
    let session_ids: BTreeSet<&String> = wanted.sessions.iter().collect();
    let session_copies: BTreeSet<&String> = wanted.session_copies.iter().collect();
    // Chats that came in with this import under their own id: the only ones a delegation row may name.
    let mut came_in: BTreeSet<String> = BTreeSet::new();
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
        let kept = insert_session(env, conn, &target, &title, &file, rules)?;
        report.folders_cleared += usize::from(kept.cleared);
        report.tool_paths_dropped += kept.paths_dropped;
        paths_left_out += kept.files_left_out;
        if file["monoTranscript"].as_bool() == Some(true) {
            after.transcripts.push(target.clone());
        }
        if exists {
            report.sessions_copied += 1;
        } else {
            report.sessions_added += 1;
            came_in.insert(id.clone());
        }
    }

    if paths_left_out > 0 {
        report.notes.push(format!(
            "{paths_left_out} file paths in the imported chats were left out. They name files on the Mac that made the export, so those pictures and attachments show as not here."
        ));
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
            // Comes back paused: nothing starts running on this Mac until Ash turns it on. A folder that isn't a
            // project here is cleared, so turning it on asks for one.
            automation["enabled"] = json!(false);
            // A file doesn't choose how freely it runs: supervised, as imported chats are.
            automation["runtimeMode"] = json!(IMPORTED_RUNTIME_MODE);
            let cleared = rules.vet_automation(&mut automation);
            let next = automation["nextRunAt"].as_i64().unwrap_or(0);
            let updated = automation["updatedAt"].as_i64().unwrap_or_else(now_millis);
            let changed = conn.execute(
                "INSERT OR IGNORE INTO automations (id, definition_json, enabled, next_run_at, updated_at) VALUES (?1, ?2, 0, ?3, ?4)",
                params![id, automation.to_string(), next, updated],
            )?;
            if changed > 0 {
                report.automations_added += 1;
                report.automation_folders_cleared += usize::from(cleared);
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
            // Only a row whose chats both came in with this import: one naming a chat that was here already would
            // attach history (and a report to deliver) to something the file doesn't own.
            let both_came_in = ["owner_session", "child_session"].iter().all(|key| {
                row.get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|id| came_in.contains(id))
            });
            if !both_came_in {
                continue;
            }
            // History only: nothing here runs it, reports it or copies it to Ash OS again. Any state that isn't a
            // finished one settles as cancelled.
            let open = !matches!(
                row.get("state").and_then(Value::as_str),
                Some(
                    crate::delegations::COMPLETED
                        | crate::delegations::FAILED
                        | crate::delegations::CANCELLED
                )
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
            // Marked as an import's row, whatever the file says: a marked row never lends a chat a worktree (chat_media).
            row.insert("imported".into(), json!(1));
            if insert_row(conn, "delegations", &row)? {
                report.delegations_added += 1;
            }
        }
    }

    // WP-78: the log comes with the workspace. There is no tick for it.
    if let Some(rows) = opened
        .json("workspace/activity.json")
        .and_then(|v| v.as_array().cloned())
    {
        let added = crate::activity::import_rows(conn, &rows)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
        report.activity_added += added;
    }
    Ok(())
}

// Why a note's picture was left out. Said to the person in the import report, so plain words.
const LEFT_OUT_ID: &str = "the note's id isn't one plain name";
const LEFT_OUT_FOLDER_LINK: &str = "its folder is a link";
const LEFT_OUT_LINK: &str = "it is a link";
const LEFT_OUT_NOT_A_FILE: &str = "it isn't a plain file";
const LEFT_OUT_UNLISTED: &str = "the export doesn't list it";
const LEFT_OUT_NAME: &str = "its name isn't one plain file name";
const LEFT_OUT_TOO_LARGE: &str = "it is too large for a note picture";
const LEFT_OUT_UNREADABLE: &str = "it couldn't be read";
const LEFT_OUT_CHANGED: &str = "it changed after the export was checked";
const LEFT_OUT_UNWRITABLE: &str = "it couldn't be written here";

/// What an import found at a folder it is about to read from.
enum Folder {
    Absent,
    /// A folder, and not a link to one.
    Real,
    /// A link, or something that isn't a folder: not followed.
    Refused,
}

fn folder_state(path: &Path) -> Folder {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_dir() => Folder::Real,
        Ok(_) => Folder::Refused,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Folder::Absent,
        Err(_) => Folder::Refused,
    }
}

/// The bytes of one picture the manifest lists: a plain file that is not a link, read ONCE (see `read_as_listed`),
/// and only if they hash as the manifest says. The caller writes these same bytes, so a file swapped between the
/// export's check and now can't bring anything in that the manifest didn't hash.
fn read_listed_picture(path: &Path, listed: &Listed) -> Result<Vec<u8>, &'static str> {
    read_as_listed(path, listed).map_err(|why| match why {
        Unusable::Link => LEFT_OUT_LINK,
        Unusable::NotAFile => LEFT_OUT_NOT_A_FILE,
        Unusable::Unreadable => LEFT_OUT_UNREADABLE,
        Unusable::Changed => LEFT_OUT_CHANGED,
    })
}

/// A name that is exactly one plain path component: a picture sits directly in its note's folder.
fn one_plain_name(name: &str) -> bool {
    safe_relative(name)
        .is_some_and(|path| path.as_os_str() == name && path.components().count() == 1)
}

/// The folder this Mac keeps a note's pictures in, made when the first one is about to be written. Never a link:
/// one here would send the write somewhere else.
fn picture_folder(env: &Env, to: &str) -> Option<PathBuf> {
    fs::create_dir_all(&env.data_dir).ok()?;
    let all = env.data_dir.join(NOTE_ASSET_DIR);
    let folder = all.join(to);
    for path in [&all, &folder] {
        match fs::create_dir(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
        if !matches!(folder_state(path), Folder::Real) {
            return None;
        }
    }
    Some(folder)
}

/// A new file nobody else made: it never replaces one that is there and never writes through a link at that name
/// (O_EXCL). Owner-only, like every other file an import writes.
fn write_new_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    if let Err(e) = file.write_all(bytes) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(e);
    }
    Ok(())
}

/// A folder export's pictures for one imported note, copied from `from`'s folder into `to`'s here. Only the files
/// the manifest lists come in, each as the bytes that hash as listed (see `read_listed_picture`), and none through a
/// link: not the picture, not its folder, not `note-assets` or `workspace`. A file that is already here is kept.
/// Returns why each picture that did not come in was left out; nothing is copied for it. (An archive can't hold
/// links: `unpack` refuses them. A hidden file such as `.DS_Store` is skipped without a word, as `unpack` does.)
fn copy_note_assets(env: &Env, opened: &Opened, from: &str, to: &str) -> Vec<&'static str> {
    let mut left_out = Vec::new();
    let Some(root) = opened.root() else {
        return left_out;
    };
    // The id names one folder on each side: `..` or a path would read or write somewhere else.
    if !session_file_id(from) || !session_file_id(to) {
        left_out.push(LEFT_OUT_ID);
        return left_out;
    }
    let prefix = format!("workspace/{NOTE_ASSET_DIR}/{from}/");
    let mut listed: BTreeMap<String, &Listed> = BTreeMap::new();
    // What the export lists under this note that is not one of its pictures, by the folder it names.
    let mut elsewhere: BTreeSet<String> = BTreeSet::new();
    let mut not_pictures = 0;
    for file in opened.listed_files() {
        let Some(name) = file.path.strip_prefix(&prefix) else {
            continue;
        };
        // The export keeps every picture directly in its note's folder: a name with a path in it isn't one of ours,
        // and is neither read (the folder it names could be a link) nor written.
        if one_plain_name(name) {
            listed.insert(name.to_string(), file);
        } else {
            not_pictures += 1;
            elsewhere.insert(name.split('/').next().unwrap_or(name).to_string());
        }
    }
    left_out.resize(not_pictures, LEFT_OUT_NAME);

    let workspace = root.join("workspace");
    let all = workspace.join(NOTE_ASSET_DIR);
    let source = all.join(from);
    for path in [&workspace, &all, &source] {
        match folder_state(path) {
            Folder::Real => {}
            // This note has no pictures.
            Folder::Absent => return left_out,
            Folder::Refused => {
                // Not looked into: what it lists is what is left out (at least the link itself).
                left_out.clear();
                left_out.resize((listed.len() + not_pictures).max(1), LEFT_OUT_FOLDER_LINK);
                return left_out;
            }
        }
    }

    let mut folder: Option<Option<PathBuf>> = None;
    for (name, file) in &listed {
        let bytes = match read_listed_picture(&source.join(name), file) {
            Ok(bytes) => bytes,
            Err(why) => {
                left_out.push(why);
                continue;
            }
        };
        let Some(folder) = folder.get_or_insert_with(|| picture_folder(env, to)) else {
            left_out.push(LEFT_OUT_UNWRITABLE);
            continue;
        };
        match write_new_private(&folder.join(name), &bytes) {
            Ok(()) => {}
            // Already here: kept as it is.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => left_out.push(LEFT_OUT_UNWRITABLE),
        }
    }
    // Whatever else is in the folder, a link or a plain file, is never opened.
    if let Ok(entries) = fs::read_dir(&source) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_str();
            if name.is_some_and(|n| n.starts_with('.')) {
                continue;
            }
            if name.is_some_and(|n| opened.is_left_out(&format!("{prefix}{n}"))) {
                left_out.push(LEFT_OUT_TOO_LARGE);
            } else if !name.is_some_and(|n| listed.contains_key(n) || elsewhere.contains(n)) {
                left_out.push(LEFT_OUT_UNLISTED);
            }
        }
    }
    left_out
}

/// The report's line about pictures that were left out of a note.
fn left_out_note(from: &str, reasons: &[&str]) -> String {
    let mut why: Vec<&str> = Vec::new();
    for reason in reasons {
        if !why.contains(reason) {
            why.push(reason);
        }
    }
    let (count, verb) = match reasons.len() {
        1 => ("1 picture".to_string(), "was"),
        n => (format!("{n} pictures"), "were"),
    };
    let note = if session_file_id(from) {
        format!("note {from}")
    } else {
        "a note".to_string()
    };
    format!("{count} of {note} {verb} not copied ({}).", why.join("; "))
}

/// How an imported chat or automation runs: a file never chooses it. `full-access` maps to a provider's bypass-permissions
/// mode, so every mode a file names comes in as supervised, and the person raises it for that chat.
const IMPORTED_RUNTIME_MODE: &str = "supervised";

/// What an imported chat lost on the way in.
struct Kept {
    /// Its file named a folder that isn't inside a project here.
    cleared: bool,
    /// Paths in its tool rows that lay outside its folders.
    paths_dropped: usize,
    /// Generated-image and attachment paths left out of its blocks (`drop_imported_file_paths`).
    files_left_out: usize,
}

/// Paths in an import come from the Mac that made the export, or from a file written by hand: never from this Mac.
/// A chat that kept them would read whatever they name the first time it shows the picture, copies the message or
/// sends it again. So the path of every generated image and of every attachment in the chat's blocks, side threads
/// included, is left out. The block stays: an image keeps its name, caption and size with an empty path (the chat
/// shows that its file is not here), and an attachment keeps its name and kind. Returns how many paths were left out.
fn drop_imported_file_paths(value: &mut Value) -> usize {
    match value {
        Value::Array(items) => items.iter_mut().map(drop_imported_file_paths).sum(),
        Value::Object(map) => {
            let mut dropped = 0;
            if let Some(Value::Object(image)) = map.get_mut("image") {
                if image
                    .get("path")
                    .is_some_and(|path| path.as_str() != Some(""))
                {
                    image.insert("path".into(), json!(""));
                    dropped += 1;
                }
            }
            if let Some(Value::Array(files)) = map.get_mut("attachments") {
                for file in files.iter_mut().filter_map(Value::as_object_mut) {
                    dropped += usize::from(file.remove("path").is_some());
                    file.remove("copyFromPath");
                }
            }
            dropped
                + map
                    .values_mut()
                    .map(drop_imported_file_paths)
                    .sum::<usize>()
        }
        _ => 0,
    }
}

/// Adds the chat to the store. Returns what it lost on the way in (`Kept`).
fn insert_session(
    env: &Env,
    conn: &Connection,
    id: &str,
    title: &str,
    file: &Value,
    rules: &FolderRules,
) -> rusqlite::Result<Kept> {
    let engine = &file["engine"];
    let harness = engine["harness"].as_str().unwrap_or("claude").to_string();
    let text = |key: &str| file[key].as_str().map(str::to_string);
    // The file's folder is nobody's choice here: kept only inside a project this copy has (folders.rs). A chat with
    // none asks for one before it runs; it is never given the home folder.
    let folders = rules.vet(file["cwd"].as_str(), file["worktreeCwd"].as_str());
    // A provider session id is kept only where it can resume and is this chat's own: the daily app, a Claude chat that
    // isn't private, no other chat here holds it, and its transcript lives in the project folder of the chat's vetted
    // folder (a chat with none keeps none).
    let private = file["private"].as_bool().unwrap_or(false);
    let work_folder = folders.worktree.as_deref().unwrap_or(&folders.cwd);
    let provider = file["providerTranscript"]["providerSessionId"]
        .as_str()
        .filter(|psid| {
            !env.dev
                && harness == "claude"
                && !private
                && !work_folder.is_empty()
                && claude_transcript_for(env, psid, work_folder)
                && !provider_id_held(conn, psid, id)
        })
        .map(str::to_string);
    let mut blocks = file.get("blocks").cloned().unwrap_or(json!([]));
    let files_left_out = drop_imported_file_paths(&mut blocks);
    let paths_dropped = rules.confine_tool_paths(&mut blocks, &folders.roots);
    let session = SessionUpsert {
        sidebar_hidden: file["sidebarHidden"].as_bool().unwrap_or(false),
        id: id.to_string(),
        cwd: folders.cwd.clone(),
        harness,
        model: engine["model"].as_str().unwrap_or("").to_string(),
        model_settings: engine.get("modelSettings").cloned().unwrap_or(json!({})),
        runtime_mode: IMPORTED_RUNTIME_MODE.to_string(),
        title: title.to_string(),
        provider_session_id: provider,
        provider_account_id: None,
        blocks,
        queued_messages: Vec::new(),
        queue_status: None,
        context_used: file["contextUsed"].as_i64(),
        context_window: file["contextWindow"].as_i64(),
        branch: text("branch"),
        worktree_cwd: folders.worktree.clone(),
        worktree_removed: file["worktreeRemoved"].as_bool().unwrap_or(false),
        linked_work_item: file.get("linkedWorkItem").filter(|v| !v.is_null()).cloned(),
        automation_id: text("automationId"),
        // A /goal belongs to its Claude conversation on this Mac; it never travels.
        goal: None,
        // WP-111: a private chat stays private after import. An old file has no flag, so it stays readable.
        private_chat: file["private"].as_bool().unwrap_or(false),
        // The entry id only. The target's own list and approval still decide whether the chat runs.
        registry_agent_id: file["registryAgentId"].as_str().map(str::to_string),
        private_boundary_id: match &file["privateBoundaryId"] {
            Value::Null => None,
            Value::String(value) => crate::session_store::boundary_for_read(Some(value.clone())),
            _ => Some("private-boundary-unreadable".to_string()),
        },
    };
    session_store::upsert_session(conn, &session)?;
    note_named_folder(conn, id, &folders)?;
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
    Ok(Kept {
        cleared: folders.cleared,
        paths_dropped,
        files_left_out,
    })
}

/// What the file named for a chat whose folder was cleared, kept as an inert note nothing runs from: the window offers
/// it back (`portable_relink_candidate`) once it exists here and passes the same checks. A chat that kept its folder
/// has no note.
fn note_named_folder(
    conn: &Connection,
    id: &str,
    folders: &folders::Folders,
) -> rusqlite::Result<()> {
    match (&folders.named_cwd, folders.cwd.is_empty()) {
        (Some(named), true) => {
            conn.execute(
                "INSERT OR REPLACE INTO imported_chat_folders (session_id, cwd, worktree_cwd, blocked, project_id, rest) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    id,
                    named,
                    folders.named_worktree,
                    i64::from(folders.named_blocked),
                    folders.named_project.as_ref().map(|(id, _)| id),
                    folders.named_project.as_ref().map(|(_, rest)| rest),
                ],
            )?;
        }
        _ => {
            conn.execute(
                "DELETE FROM imported_chat_folders WHERE session_id = ?1",
                [id],
            )?;
        }
    }
    Ok(())
}

fn import_memory(
    env: &Env,
    opened: &Opened,
    wanted: &MemoryImport,
    report: &mut ImportReport,
    written: &mut Vec<PathBuf>,
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
        // The Monos home takes only what mono.rs names, and only under its own name: another spelling or a link that
        // reaches it (a case alias on a case-insensitive disk, `monos.` on Windows) would carry files past that.
        if let Some(why) = aliases_monos_home(env, name, &target) {
            report.notes.push(format!("{name} wasn't restored: {why}."));
            continue;
        }
        env.check_writable(&target)?;
        let bundle = root.join("memory").join(format!("{name}.git.bundle"));
        let history = opened.listed_file(&format!("memory/{name}.git.bundle"));
        // A folder made here from the history is this import's own: its files may take the export's newest text.
        let mut fresh = false;
        if let (true, Some(history), false) = (wanted.history, history, target.exists()) {
            fs::create_dir_all(&env.memory_root).map_err(|e| e.to_string())?;
            match restore_history(&bundle, history, &target) {
                Ok(restored) => {
                    report.memory_history.push(name.clone());
                    fresh = true;
                    if !restored.control.is_empty() {
                        report.notes.push(format!(
                            "The history of {name} held {} (files that tell git what to run or fetch); they were not restored.",
                            restored.control.join(", ")
                        ));
                    }
                    // Whatever the history's newest tree held that a CLI would read as instructions or settings, or that is
                    // hidden, was removed in a commit of its own, in every folder (`restore_history`). The export's tip stays
                    // under refs/hivra/imported-tip.
                    if !restored.pruned.is_empty() {
                        report.notes.push(format!(
                            "The history of {name} held {} (instruction, settings or hidden files); they were removed in a commit of its own, and the export's tip is kept as refs/hivra/imported-tip.",
                            restored.pruned.join(", ")
                        ));
                    }
                    written.extend(files_under(&target));
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
                        HistoryRefusal::NotAsListed => format!(
                            "The history of {name} changed after the export was checked, so it wasn't restored; its files came in without it."
                        ),
                        HistoryRefusal::NotABundle => format!(
                            "The history of {name} isn't a git bundle, so it wasn't restored; its files came in without it."
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
            // A memory import writes notes only, in every folder: `.md` files, nothing hidden (round 6 restored this for
            // folders outside the Monos home too). An instruction file (CLAUDE.md, AGENTS.md, settings, rules ...) never
            // comes in under its own name, in any folder: it is held beside its original, for Ash to review. Inside the
            // Monos home only the names a Mono's folder uses are written, and an instruction file is held for review only
            // where a Mono keeps one (`folders::instruction_file_for_review`). Trust is never decided by a folder's name.
            let monos_relative = inside_monos_home(env, &dest);
            let instruction = match &monos_relative {
                Some(relative) => folders::instruction_file_for_review(relative),
                None => folders::instruction_file_at(&safe),
            };
            match &monos_relative {
                Some(relative) => {
                    if !folders::mono_folder_file(relative) && !instruction {
                        report.notes.push(format!(
                            "{path} wasn't written: a Mono's folder only takes SOUL.md, MEMORY.md, soul-template.md and its memory and skills notes."
                        ));
                        continue;
                    }
                }
                None => {
                    if !folders::memory_note_file(&safe) && !instruction {
                        // A file a restored history brought in is already here: nothing is reported for it.
                        if !(fresh && dest.exists()) {
                            report.notes.push(format!(
                                "{path} wasn't written: a memory import only writes notes (.md files), never instructions, rules or settings."
                            ));
                        }
                        continue;
                    }
                }
            }
            // Memory is text: a file that isn't UTF-8 is skipped, never written as nothing over what is here.
            let text = match opened.read_text(path) {
                Ok(text) => text,
                Err(ReadFailure::Unusable(why)) => {
                    report.notes.push(format!(
                        "{path} {}, so it was skipped; nothing here changed for it.",
                        why.since_the_check()
                    ));
                    continue;
                }
                Err(_) => {
                    report.notes.push(format!(
                        "{path} isn't plain text (UTF-8), so it was skipped; nothing here changed for it."
                    ));
                    continue;
                }
            };
            if instruction {
                // Never under its own name, here or in a restored history: beside its original, for Ash to review.
                let review = beside_name(&dest);
                write_within(&inside, &review, &text)?;
                report.notes.push(format!(
                    "{path} came in as {} for you to review: an instruction file is never written under its own name here, so nothing was written under that name.",
                    review.file_name().and_then(|n| n.to_str()).unwrap_or_default()
                ));
                written.push(review);
                continue;
            }
            // Whether `dest` now holds the export's text because of this restore (a fresh folder's history counts).
            let wrote = match fs::read_to_string(&dest) {
                Ok(local) if local == text => fresh,
                Ok(_) if fresh => {
                    write_within(&inside, &dest, &text)?;
                    written.push(dest.clone());
                    true
                }
                Ok(_) => {
                    if wanted.keep_both {
                        write_within(&inside, &beside_name(&dest), &text)?;
                        written.push(beside_name(&dest));
                        report.memory_files_beside += 1;
                    } else {
                        report.kept += 1;
                    }
                    false
                }
                Err(_) => {
                    write_within(&inside, &dest, &text)?;
                    written.push(dest.clone());
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

/// Every file under a folder (the repository's own `.git` left out): what a restored history put there.
fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        let Ok(entries) = fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_name() == ".git" {
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(path),
                Ok(kind) if kind.is_file() => out.push(path),
                _ => {}
            }
        }
    }
    out
}

/// The message of the commit that takes instruction and hidden files out of a restored history (in every folder).
const INSTRUCTIONS_REMOVED: &str = "Removed instruction and hidden files from an imported history";

/// Whether a file of a restored history is one a CLI reads as instructions or settings, or anything hidden: those are
/// removed in the restore's own commit, in every folder. `relative` is inside the folder.
fn prunable_path(relative: &str) -> bool {
    let parts: Vec<&str> = relative.split('/').collect();
    let hidden = parts.iter().any(|part| part.starts_with('.'));
    let instruction = parts
        .last()
        .is_some_and(|name| folders::instruction_file(name));
    hidden || instruction
}

/// How a path component is compared when two spellings may be one folder (`folders::fold_name`: case-folded, compatibility
/// forms and the long s folded, trailing dots and spaces dropped).
fn fold_part(part: &std::ffi::OsStr) -> String {
    folders::fold_name(&part.to_string_lossy())
}

fn folded(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|part| match part {
            Component::Normal(name) => Some(fold_part(name)),
            _ => None,
        })
        .collect()
}

/// Two paths are one place: the same device and inode where the disk says so, else the same resolved path read with
/// case folded.
fn same_place(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(x), Ok(y)) = (fs::metadata(a), fs::metadata(b)) {
            return x.dev() == y.dev() && x.ino() == y.ino();
        }
    }
    folded(&resolved(a)) == folded(&resolved(b))
}

/// The path inside the Monos home that `dest` is, however it is spelled or linked: the resolved paths, the same read
/// with case folded and trailing dots and spaces dropped, and any folder above `dest` that is the Monos home by identity.
fn inside_monos_home(env: &Env, dest: &Path) -> Option<PathBuf> {
    let home = resolved(&env.monos_root);
    let target = resolved(dest);
    if let Ok(relative) = target.strip_prefix(&home) {
        return Some(relative.to_path_buf());
    }
    let (home_parts, target_parts) = (folded(&home), folded(&target));
    if target_parts.starts_with(&home_parts) {
        let skip = home_parts.len();
        let below: PathBuf = target
            .components()
            .filter(|part| matches!(part, Component::Normal(_)))
            .skip(skip)
            .map(|part| part.as_os_str().to_os_string())
            .collect();
        return Some(below);
    }
    let mut above = Some(target.as_path());
    while let Some(folder) = above {
        if folder.exists() && same_place(folder, &env.monos_root) {
            return Some(target.strip_prefix(folder).ok()?.to_path_buf());
        }
        above = folder.parent();
    }
    None
}

/// Why a memory folder named `name` can't be restored because it reaches the Monos home under another name: it spells
/// the Monos home's name another way (case, trailing dot or space), or it leads there (a link, a case alias).
fn aliases_monos_home(env: &Env, name: &str, target: &Path) -> Option<&'static str> {
    let home_name = env.monos_root.file_name()?;
    if home_name.to_string_lossy() == name {
        return None;
    }
    if fold_part(std::ffi::OsStr::new(name)) == fold_part(home_name) {
        return Some("it is the Monos home under another spelling");
    }
    if target.exists() && same_place(target, &env.monos_root) {
        return Some("it leads to the Monos home under another name");
    }
    None
}

#[derive(Debug)]
enum HistoryRefusal {
    /// The newest tree holds a link (or anything else that isn't a plain file) at this path.
    Link(String),
    Failed,
    /// The bundle isn't the file the manifest hashed any more (a link, another size, other bytes).
    NotAsListed,
    /// It hashes as listed and isn't a git bundle.
    NotABundle,
}

/// The first line of a git bundle, either format.
const BUNDLE_HEADERS: [&[u8]; 2] = [b"# v2 git bundle\n", b"# v3 git bundle\n"];

/// `source`, an export's listed bundle, copied to `copy` through the plain reader as it is hashed: the copy is the
/// very bytes that hash as listed, begins like a git bundle, and is a file nothing else can touch.
fn copy_listed_bundle(source: &Path, listed: &Listed, copy: &Path) -> Result<(), HistoryRefusal> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut out = options.open(copy).map_err(|_| HistoryRefusal::Failed)?;
    let mut hash = Sha256::new();
    let mut head: Vec<u8> = Vec::new();
    let mut write_failed = false;
    let streamed = plain_file::stream(source, listed_cap(listed), |piece| {
        if head.len() < BUNDLE_HEADERS[0].len() {
            let room = BUNDLE_HEADERS[0].len() - head.len();
            head.extend_from_slice(&piece[..room.min(piece.len())]);
        }
        hash.update(piece);
        write_failed = write_failed || out.write_all(piece).is_err();
    });
    drop(out);
    streamed.map_err(|_| HistoryRefusal::NotAsListed)?;
    if write_failed {
        return Err(HistoryRefusal::Failed);
    }
    if hex_of(&hash.finalize()) != listed.sha256 {
        return Err(HistoryRefusal::NotAsListed);
    }
    if !BUNDLE_HEADERS.contains(&head.as_slice()) {
        return Err(HistoryRefusal::NotABundle);
    }
    Ok(())
}

/// A memory folder's history from an export's bundle, into `target` (not there yet): no hooks, no templates, and
/// nothing but plain files. A tree with a link is refused before anything is checked out, so no write that follows
/// can go through it.
///
/// git is not handed the bundle's path in the export: `git clone` decides for itself what a path means (a gitfile
/// there clones the repository it names, and `<path>.git` beside it is cloned in its place), so the hash of the file
/// would limit nothing. The listed bytes are copied, hashed as they go, into a private folder as its only file, and
/// git clones that; the folder goes when this returns, however it returns.
///
/// Whatever the newest tree holds that a CLI would read as instructions or settings, or that is hidden, is removed in a
/// commit of its own on top of the export's tip, in every folder (`prunable_path`). The tip itself is kept under
/// `refs/hivra/imported-tip` first, so nothing of the export is lost. Every commit here runs under the isolated git of
/// this function, so a failed commit refuses the restore (the caller removes the folder).
fn restore_history(
    bundle: &Path,
    listed: &Listed,
    target: &Path,
) -> Result<Restored, HistoryRefusal> {
    let scratch = Scratch::private("history").map_err(|_| HistoryRefusal::Failed)?;
    let copy = scratch.0.join("history.bundle");
    copy_listed_bundle(bundle, listed, &copy)?;
    let bundle = &copy;
    // What git is told it has for configuration, hooks and attributes: nothing. A filter defined in the machine's own
    // git config (git-lfs, on a Mac that has it) would otherwise run at checkout on paths the history chose.
    let nothing = Scratch::private("history-git").map_err(|_| HistoryRefusal::Failed)?;
    let (config, attributes, hooks) = (
        nothing.0.join("config"),
        nothing.0.join("attributes"),
        nothing.0.join("hooks"),
    );
    fs::write(&config, b"").map_err(|_| HistoryRefusal::Failed)?;
    fs::write(&attributes, b"").map_err(|_| HistoryRefusal::Failed)?;
    fs::create_dir(&hooks).map_err(|_| HistoryRefusal::Failed)?;
    let git = || {
        let mut command = Command::new("git");
        #[cfg(test)]
        INHERITED_GIT_ENV.with(|vars| {
            for (name, value) in vars.borrow().iter() {
                command.env(name, value);
            }
        });
        command
            .env("GIT_CONFIG_GLOBAL", &config)
            .env("GIT_CONFIG_SYSTEM", &config)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_ATTR_NOSYSTEM", "1")
            // An LFS pointer stays a pointer: nothing is fetched from a server the history names.
            .env("GIT_LFS_SKIP_SMUDGE", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(["-c", "core.symlinks=false"])
            .arg("-c")
            .arg(format!("core.hooksPath={}", hooks.display()))
            .arg("-c")
            .arg(format!("core.attributesFile={}", attributes.display()))
            // The files come back byte for byte, whatever the machine's `core.autocrlf` (true on most Windows setups).
            .args(["-c", "core.autocrlf=false", "-c", "core.eol=lf"]);
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
    // The export's tip, as it came, under a ref of its own: the removal below is a commit on top of it, never an amend.
    if !ok(git()
        .arg("-C")
        .arg(target)
        .args(["update-ref", IMPORTED_TIP, "HEAD"]))
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
    // Plain files only (a hidden one like .gitignore is still a plain file; git itself refuses `..` and `.git`), and
    // not the files that tell git what to run or fetch, nor the instruction and hidden files a CLI would read: a bundle
    // doesn't get to bring those in, in any folder.
    let mut dropped: Vec<String> = Vec::new();
    let mut dropped_paths: Vec<String> = Vec::new();
    let mut pruned_paths: Vec<String> = Vec::new();
    for entry in listing.stdout.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let entry = String::from_utf8_lossy(entry);
        let (meta, path) = entry.split_once('\t').unwrap_or((&entry, ""));
        let mode = meta.split(' ').next().unwrap_or("");
        if !matches!(mode, "100644" | "100755") {
            return Err(HistoryRefusal::Link(path.to_string()));
        }
        let name = path.rsplit('/').next().unwrap_or(path);
        if let Some(known) = GIT_CONTROL_FILES
            .iter()
            .find(|known| folders::fold_name(name) == **known)
        {
            dropped_paths.push(path.to_string());
            if !dropped.iter().any(|d| d == known) {
                dropped.push((*known).to_string());
            }
        } else if prunable_path(path) {
            pruned_paths.push(path.to_string());
        }
    }
    // The index is the tree as the export has it, and the files that must not be restored leave the index before anything
    // is checked out: a file that is never in the index is never written to the folder, not even for a moment, so it can
    // never act on it. Each removal is a commit of its own, made while nothing is configured (this same isolated git). A
    // commit that fails refuses the restore, so no deletion is left uncommitted for a later checkout to undo.
    if !ok(git().arg("-C").arg(target).args(["read-tree", "HEAD"])) {
        return Err(HistoryRefusal::Failed);
    }
    let commit = |message: &str| {
        ok(git()
            .arg("-C")
            .arg(target)
            .args(["-c", "user.name=Hivra import"])
            .args(["-c", "user.email=import@hivra.invalid"])
            .args(["-c", "commit.gpgsign=false"])
            .args(["commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m"])
            .arg(message))
    };
    // A long list goes to git as a pathspec file on standard input: as arguments, a few thousand names overflow the
    // argument list. Literal, so no name is read as a pattern.
    let remove_from_index = |paths: &[String]| {
        pathspecs_from_stdin(
            git().arg("-C").arg(target).args([
                "--literal-pathspecs",
                "rm",
                "--cached",
                "--quiet",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]),
            paths,
        )
    };
    // Left in HEAD, the control files would be one `git reset --hard` (under the machine's own config, filters and all)
    // from coming back and acting on the folder.
    let control_removed = dropped_paths.is_empty()
        || (remove_from_index(dropped_paths.as_slice()) && commit(CONTROL_FILES_REMOVED));
    if !control_removed {
        return Err(HistoryRefusal::Failed);
    }
    // The instruction and hidden files are taken out of HEAD in a commit of their own, in every folder.
    let instructions_removed = pruned_paths.is_empty()
        || (remove_from_index(pruned_paths.as_slice()) && commit(INSTRUCTIONS_REMOVED));
    if !instructions_removed {
        return Err(HistoryRefusal::Failed);
    }
    if !ok(git()
        .arg("-C")
        .arg(target)
        .args(["checkout-index", "--all", "--force"]))
    {
        return Err(HistoryRefusal::Failed);
    }
    // And should one come back by another way, git-lfs in this folder fetches nothing and runs no filter.
    for (key, value) in [
        ("lfs.fetchexclude", "*"),
        ("filter.lfs.process", ""),
        ("filter.lfs.smudge", ""),
        ("filter.lfs.clean", ""),
        ("filter.lfs.required", "false"),
    ] {
        if !ok(git()
            .arg("-C")
            .arg(target)
            .args(["config", "--local", key, value]))
        {
            return Err(HistoryRefusal::Failed);
        }
    }
    // The bundle was a scratch file: don't leave a remote pointing at it.
    let _ = git()
        .arg("-C")
        .arg(target)
        .args(["remote", "remove", "origin"])
        .output();
    Ok(Restored {
        control: dropped,
        pruned: pruned_paths,
    })
}

/// Runs `command` with `paths` on its standard input, NUL-separated, for a `--pathspec-from-file=-` form. True when git
/// succeeds (and the list was written whole).
fn pathspecs_from_stdin(command: &mut Command, paths: &[String]) -> bool {
    use std::io::Write;
    use std::process::Stdio;
    let Ok(mut child) = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let mut list: Vec<u8> = Vec::new();
    for path in paths {
        list.extend_from_slice(path.as_bytes());
        list.push(0);
    }
    let written = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(&list).is_ok());
    child.wait().is_ok_and(|status| status.success()) && written
}

/// What a restored history left out: the files that tell git what to run or fetch (`control`), and the instruction,
/// settings and hidden files a CLI would read (`pruned`), both removed in the restore's own commits.
#[derive(Debug)]
struct Restored {
    control: Vec<String>,
    pruned: Vec<String>,
}

/// Where an export's history tip is kept, once restored: a ref of its own, so nothing of the export is lost when the
/// removal commit goes on top of it.
const IMPORTED_TIP: &str = "refs/hivra/imported-tip";

#[cfg(test)]
thread_local! {
    /// What a test hands the git commands of a history restore on its thread, standing in for the environment the app
    /// was started with (the machine's own git config, say) without setting anything for the whole test process.
    static INHERITED_GIT_ENV: std::cell::RefCell<Vec<(std::ffi::OsString, std::ffi::OsString)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// The message of the commit that takes a history's git control files out of its HEAD.
const CONTROL_FILES_REMOVED: &str = "Removed git control files from an imported history";

/// Files in a history that tell git what to run or fetch (filters, an LFS server, submodules): never restored.
const GIT_CONTROL_FILES: [&str; 3] = [".gitattributes", ".lfsconfig", ".gitmodules"];

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

/// The project folders an export names that can never be adopted (the folder isn't on this Mac, or it is the home
/// folder, a folder that holds it, `/`, `/Volumes` or the app's data folder), each with why. A folder that can be
/// adopted is left out. The import asks again as it registers, so ticking a folder never overrides this.
#[tauri::command]
pub async fn portable_project_folder_checks(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<BTreeMap<String, String>, String> {
    let env = Env::for_app(&app)?;
    Ok(project_folder_checks(&env, &paths))
}

fn project_folder_checks(env: &Env, paths: &[String]) -> BTreeMap<String, String> {
    paths
        .iter()
        .filter_map(|path| refused_project_folder(env, path).map(|why| (path.clone(), why)))
        .collect()
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
