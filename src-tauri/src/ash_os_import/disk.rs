//! Ash OS's own record on disk, for the one-time import when Ash OS no longer answers (it was retired as a service,
//! its data stayed). The answer has exactly the shape the three live reads give (`ash-hub-projects` with archived
//! projects, `ash-hub-mono-projects`, `ash-hub-pages`), so the webview's import, its question and `importFrom` don't
//! know which one they got.
//!
//! Never writes to Ash OS: the database (and its write-ahead log, if one is there) is copied byte for byte into a
//! private folder (0700, files 0600, removed after) and only that copy is opened. Opening the real file, even read-only,
//! would make SQLite create a `-wal` and `-shm` beside it (the record is in WAL mode); `immutable=1` would avoid that but
//! miss rows still in a log nobody checkpointed. Only these are read: meta `hub_project_set` and `hub_project_overlay`,
//! `hub_mono_projects`, kept `hub_pages`, and each strip project's `projects/<id>/project.json`. Every value is
//! treated as untrusted: checked, capped, and left out when it doesn't fit.
//!
//! Where it is read from follows the live read's rule: the daily app reads Ash OS's real record; a dev copy reads only
//! a stand-in a test names with `MONOCODE_ASHOS_DB` (and optionally `MONOCODE_ASHOS_PROJECTS`), never a path inside
//! the real `~/.local/share/exo-cc-studio` or `~/Projects/exo-cc-studio` (nor a hard link to the real record). The
//! daily app ignores those variables. A strip that names projects none of whose files are there is no answer this
//! time (the checkout may be elsewhere), never a sure "nothing to import".

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row};
use serde_json::{json, Map, Value};

use super::{ImportFound, ImportState};

/// Ash OS's data folder, under a home.
pub(super) const DATA_SUBPATH: &str = ".local/share/exo-cc-studio";
/// Ash OS's checkout, where its curated projects live (`projects/<id>/project.json`).
pub(super) const CHECKOUT_SUBPATH: &str = "Projects/exo-cc-studio";
const DB_NAME: &str = "ashos.db";

const MAX_DB: u64 = 512 * 1024 * 1024;
const MAX_WAL: u64 = 256 * 1024 * 1024;
const MAX_META: usize = 1024 * 1024;
const MAX_PROJECT_FILE: u64 = 256 * 1024;
const MAX_SPEC: usize = 1024 * 1024;
/// All kept Pages' contents together, in bytes: the live read's whole answer was capped at 32 MB.
const MAX_SPECS_TOTAL: usize = 24 * 1024 * 1024;
/// A private copy left behind by a crash is swept once it is this old.
const STALE_COPY_SECS: u64 = 60 * 60;
const MAX_STRIP: usize = 100;
const MAX_MEMBERSHIPS: usize = 5000;
const MAX_PAGES: usize = 500;
const MAX_PERMISSIONS: usize = 100;
const MAX_FOLDER: usize = 1024;
const COPY_TRIES: usize = 3;

const ICON_SHAPES: [&str; 14] = [
    "gamepad",
    "sparkles",
    "palette",
    "gauge",
    "folder",
    "code",
    "rocket",
    "chart",
    "briefcase",
    "megaphone",
    "book",
    "heart",
    "globe",
    "bolt",
];
const DEFAULT_ICON: &str = "folder";
const GLOBAL_PROJECTS: [&str; 1] = ["ash"];
const HUB_ID: &str = "hub";

/// Where Ash OS's record is: its database, then the project roots in the order Ash OS reads them (curated first: a
/// curated project wins over a local one with the same id).
#[derive(Debug, Clone, PartialEq)]
pub(super) struct DiskRecord {
    pub db: PathBuf,
    pub roots: Vec<PathBuf>,
}

/// Where to read the record. `live`: the daily app (its real record, or what the env names). A dev copy needs
/// `db_env` and never gets a path inside Ash OS's real folders, under HOME or under the real home.
pub(super) fn resolve(
    live: bool,
    db_env: Option<PathBuf>,
    projects_env: Option<PathBuf>,
    home: Option<PathBuf>,
    real_home: Option<PathBuf>,
) -> Result<DiskRecord, String> {
    if !live {
        let Some(db) = db_env else {
            return Err(
                "A dev copy reads Ash OS's record only from a stand-in (MONOCODE_ASHOS_DB).".into(),
            );
        };
        let real: Vec<PathBuf> = [&home, &real_home]
            .into_iter()
            .flatten()
            .flat_map(|h| [h.join(DATA_SUBPATH), h.join(CHECKOUT_SUBPATH)])
            .collect();
        let local = db.parent().map(|p| p.join("projects"));
        let named = [Some(db.clone()), local.clone(), projects_env.clone()];
        let real_dbs: Vec<PathBuf> = [&home, &real_home]
            .into_iter()
            .flatten()
            .map(|h| h.join(DATA_SUBPATH).join(DB_NAME))
            .collect();
        if named.iter().flatten().any(|path| {
            path.components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
                || real.iter().any(|r| inside(path, r))
        }) || real_dbs.iter().any(|r| same_file(&db, r))
        {
            return Err("A dev copy never reads Ash OS's real record.".into());
        }
        return Ok(DiskRecord {
            db,
            roots: projects_env.into_iter().chain(local).collect(),
        });
    }
    let home =
        home.ok_or_else(|| "There is no home folder to find Ash OS's record in.".to_string())?;
    let db = db_env.unwrap_or_else(|| home.join(DATA_SUBPATH).join(DB_NAME));
    let curated = projects_env.unwrap_or_else(|| home.join(CHECKOUT_SUBPATH).join("projects"));
    let local = db.parent().map(|p| p.join("projects"));
    Ok(DiskRecord {
        db,
        roots: std::iter::once(curated).chain(local).collect(),
    })
}

/// Whether two paths are the same file on disk (a hard link included). False when either isn't there.
fn same_file(a: &Path, b: &Path) -> bool {
    let (Ok(a), Ok(b)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (a, b);
        false
    }
}

/// Whether `path` is `root` or inside it, by their real locations when they exist (a symlink or `..` can't dodge it).
fn inside(path: &Path, root: &Path) -> bool {
    let real = |p: &Path| -> PathBuf {
        // The nearest part that exists, resolved, plus the rest as written.
        let mut head = p.to_path_buf();
        let mut tail = Vec::new();
        loop {
            if let Ok(found) = head.canonicalize() {
                return tail
                    .iter()
                    .rev()
                    .fold(found, |acc: PathBuf, part| acc.join(part));
            }
            match (head.file_name().map(|n| n.to_os_string()), head.parent()) {
                (Some(name), Some(parent)) => {
                    tail.push(name);
                    head = parent.to_path_buf();
                }
                _ => return p.to_path_buf(),
            }
        }
    };
    let (path, root) = (real(path), real(root));
    path.starts_with(&root)
}

/// A private copy of the record, removed when dropped.
struct Snapshot {
    dir: PathBuf,
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Snapshot {
    fn db(&self) -> PathBuf {
        self.dir.join(DB_NAME)
    }
}

const COPY_PREFIX: &str = "monocode-ashos-read-";

/// Private copies a crash left behind (only this reader's own folders, and only old ones).
fn sweep_stale_copies(temp: &Path) {
    sweep_copies_older_than(temp, SystemTime::now());
}

fn sweep_copies_older_than(temp: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(COPY_PREFIX) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age.as_secs() > STALE_COPY_SECS);
        if meta.file_type().is_dir() && old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn private_dir() -> Result<PathBuf, String> {
    let temp = std::env::temp_dir();
    sweep_stale_copies(&temp);
    let dir = temp.join(format!("{COPY_PREFIX}{}", uuid::Uuid::new_v4()));
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&dir)
        .map_err(|_| "Couldn't make a private folder to read Ash OS's record in.".to_string())?;
    Ok(dir)
}

/// (length, modified) of a regular file; None when it isn't there. A symlink or anything but a file is an error.
fn stamp(path: &Path) -> Result<Option<(u64, Option<SystemTime>)>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => Ok(Some((meta.len(), meta.modified().ok()))),
        Ok(_) => Err(format!("{} is not a plain file.", name_of(path))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(format!("Couldn't look at {}.", name_of(path))),
    }
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Ash OS's record".into())
}

/// Copy `from` (read only) into a new 0600 file `to`, at most `cap` bytes.
fn copy_capped(from: &Path, to: &Path, cap: u64) -> Result<(), String> {
    // Never through a link, and never waiting on something that isn't a file (a swap after the check can't hang this).
    let mut open = std::fs::OpenOptions::new();
    open.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let source = open
        .open(from)
        .map_err(|_| format!("Couldn't read {}.", name_of(from)))?;
    if !source.metadata().is_ok_and(|m| m.file_type().is_file()) {
        return Err(format!("{} is not a plain file.", name_of(from)));
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut target = options
        .open(to)
        .map_err(|_| "Couldn't write the private copy of Ash OS's record.".to_string())?;
    let copied = std::io::copy(&mut source.take(cap + 1), &mut target)
        .map_err(|_| format!("Couldn't read {}.", name_of(from)))?;
    if copied > cap {
        return Err(format!("{} is too big to read.", name_of(from)));
    }
    target
        .flush()
        .map_err(|_| "Couldn't write the private copy of Ash OS's record.".to_string())
}

/// Copy the database and its write-ahead log (if there is one) into a private folder. None when there is no record.
/// A record that changed while it was copied is copied again; one that keeps changing is an error (try next start).
fn snapshot(db: &Path) -> Result<Option<Snapshot>, String> {
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    let wal = PathBuf::from(wal);
    for _ in 0..COPY_TRIES {
        let Some(before_db) = stamp(db)? else {
            return Ok(None);
        };
        let before_wal = stamp(&wal)?;
        if before_db.0 > MAX_DB {
            return Err("Ash OS's record is too big to read.".into());
        }
        if before_wal.is_some_and(|w| w.0 > MAX_WAL) {
            return Err("Ash OS's record log is too big to read.".into());
        }
        let snap = Snapshot {
            dir: private_dir()?,
        };
        copy_capped(db, &snap.db(), MAX_DB)?;
        if before_wal.is_some() {
            copy_capped(&wal, &snap.dir.join(format!("{DB_NAME}-wal")), MAX_WAL)?;
        }
        if stamp(db)? == Some(before_db) && stamp(&wal)? == before_wal {
            return Ok(Some(snap));
        }
    }
    Err("Ash OS's record kept changing while it was read.".into())
}

/// A string that fits: trimmed, not empty, no control characters, at most `max` characters.
fn text(value: Option<&Value>, max: usize) -> Option<String> {
    let s = value?.as_str()?.trim();
    (!s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control))
        .then(|| s.to_string())
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
        _ => false,
    }
}

/// A project id Ash OS's registry and the app's store both take.
fn project_id_ok(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 48
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn mono_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn page_id_ok(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn role_ok(role: &str) -> bool {
    let bytes = role.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 40
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

/// A stored shape as the app draws it (Ash OS's `shape_of`): itself, a retired one's replacement, else None.
fn shape_of(value: Option<&Value>) -> Option<String> {
    let shape = match value?.as_str()? {
        "ghost" => "gamepad",
        other => other,
    };
    ICON_SHAPES.contains(&shape).then(|| shape.to_string())
}

/// Ash OS's `short_name`: the name up to its first ' & ', ' / ' or ' - ', cut to 12 characters.
fn short_name(name: &str) -> String {
    let name = name.trim();
    let mut head = name;
    let chars: Vec<(usize, char)> = name.char_indices().collect();
    for (i, &(at, c)) in chars.iter().enumerate() {
        if matches!(c, '&' | '/' | '-' | '\u{2013}' | '\u{2014}')
            && i > 0
            && chars[i - 1].1.is_whitespace()
            && chars.get(i + 1).is_some_and(|(_, n)| n.is_whitespace())
        {
            head = name[..at].trim_end();
            break;
        }
    }
    let head = head.trim();
    if head.chars().count() <= 12 {
        head.to_string()
    } else {
        head.chars()
            .take(12)
            .collect::<String>()
            .trim_end()
            .to_string()
    }
}

/// A folder as the import takes it: an absolute path that fits, else none.
fn folder_of(value: Option<&Value>) -> Option<String> {
    text(value, MAX_FOLDER).filter(|f| {
        f.starts_with('/') && !f.contains('\0') && !f.split('/').any(|part| part == "..")
    })
}

/// UTC ISO-8601 with a Z, as Ash OS writes it (`iso`): microseconds when there are any.
fn iso(ts: f64) -> Option<String> {
    if !ts.is_finite() || ts <= 0.0 || ts > 253_402_300_799.0 {
        return None;
    }
    let micros = (ts * 1_000_000.0).round() as i64;
    let (secs, frac) = (micros.div_euclid(1_000_000), micros.rem_euclid(1_000_000));
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let clock = format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    );
    Some(if frac == 0 {
        format!("{clock}Z")
    } else {
        format!("{clock}.{frac:06}Z")
    })
}

/// A cell as text: only a TEXT value (SQLite doesn't hold a column to its type, so any other value is left out).
fn cell_text(row: &Row, i: usize) -> Option<String> {
    match row.get_ref(i).ok()? {
        ValueRef::Text(t) => std::str::from_utf8(t).ok().map(str::to_string),
        _ => None,
    }
}

fn cell_f64(row: &Row, i: usize) -> Option<f64> {
    match row.get_ref(i).ok()? {
        ValueRef::Real(f) => Some(f),
        ValueRef::Integer(n) => Some(n as f64),
        _ => None,
    }
}

fn cell_i64(row: &Row, i: usize) -> Option<i64> {
    match row.get_ref(i).ok()? {
        ValueRef::Integer(n) => Some(n),
        ValueRef::Real(f) if f.is_finite() && f.abs() < 9.0e15 => Some(f as i64),
        _ => None,
    }
}

/// A table's column names (an older record may lack some).
fn columns(conn: &Connection, table: &str) -> Result<std::collections::HashSet<String>, String> {
    let failed = |_| "Ash OS's record couldn't be read.".to_string();
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .map_err(failed)?;
    let names = stmt
        .query_map([table], |row| Ok(cell_text(row, 0)))
        .map_err(failed)?
        .filter_map(|r| r.ok().flatten())
        .collect();
    Ok(names)
}

fn has_table(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(|_| "Ash OS's record couldn't be read.".to_string())
}

/// One meta value, parsed. None when it isn't there, is too big or isn't JSON (Ash OS's `get_meta` default).
fn meta(conn: &Connection, key: &str) -> Result<Option<Value>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT CASE WHEN length(value) <= ?2 THEN value END FROM meta WHERE key=?1",
            rusqlite::params![key, MAX_META as i64],
            |row| Ok(cell_text(row, 0)),
        )
        .optional()
        .map_err(|_| "Ash OS's record couldn't be read.".to_string())?
        .flatten();
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
}

fn default_hub_set() -> Vec<Value> {
    vec![
        json!({"id": "vg-game", "iconShape": "gamepad"}),
        json!({"id": "hivra", "iconShape": "sparkles"}),
        json!({"id": "nibbii", "iconShape": "palette"}),
        hub_entry(),
    ]
}

fn hub_entry() -> Value {
    json!({"id": HUB_ID, "name": "MonoCode Hub", "shortName": "Hub", "iconShape": "gauge"})
}

fn entry_id(entry: &Value) -> Option<&str> {
    match entry {
        Value::String(id) => Some(id),
        Value::Object(o) => o.get("id").and_then(Value::as_str),
        _ => None,
    }
}

/// The strip's entries in order (Ash OS's `_hub_set` with `migrate_hub_set`): the default four when the setting was
/// never written or can't be read; the global `ash` entry becomes the hub's; a retired shape its replacement; each id
/// once; never a global project.
fn hub_set(raw: Option<Value>) -> Vec<Map<String, Value>> {
    let got = match raw {
        Some(Value::Array(items)) => {
            let mut has_hub = items.iter().any(|e| entry_id(e) == Some(HUB_ID));
            let mut out = Vec::new();
            for e in items {
                if entry_id(&e).is_some_and(|id| GLOBAL_PROJECTS.contains(&id)) {
                    if !has_hub {
                        out.push(hub_entry());
                        has_hub = true;
                    }
                    continue;
                }
                let e = match e {
                    Value::Object(mut o)
                        if o.get("iconShape").and_then(Value::as_str) == Some("ghost") =>
                    {
                        o.insert("iconShape".into(), json!("gamepad"));
                        Value::Object(o)
                    }
                    other => other,
                };
                out.push(e);
            }
            out
        }
        _ => default_hub_set(),
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for e in got {
        let e = match e {
            Value::String(id) => {
                let mut o = Map::new();
                o.insert("id".into(), Value::String(id));
                o
            }
            Value::Object(o) => o,
            _ => continue,
        };
        let Some(id) = e.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if GLOBAL_PROJECTS.contains(&id.as_str()) || !seen.insert(id) {
            continue;
        }
        out.push(e);
    }
    out
}

/// A project's own file (`<root>/<id>/project.json`), curated root first. None when no root has it. A symlinked or
/// oversized one, or one that isn't a JSON object, is skipped with a line in `notes`.
fn project_file(
    roots: &[PathBuf],
    id: &str,
    notes: &mut Vec<String>,
) -> Option<Map<String, Value>> {
    for root in roots {
        let dir = root.join(id);
        let file = dir.join("project.json");
        let (Ok(dir_meta), Ok(file_meta)) = (
            std::fs::symlink_metadata(&dir),
            std::fs::symlink_metadata(&file),
        ) else {
            continue;
        };
        if dir_meta.file_type().is_symlink() || file_meta.file_type().is_symlink() {
            notes.push(format!("Left out {id}: its project file is a link."));
            return None;
        }
        if !file_meta.file_type().is_file() {
            continue;
        }
        if file_meta.len() > MAX_PROJECT_FILE {
            notes.push(format!("Left out {id}: its project file is too big."));
            return None;
        }
        let mut raw = Vec::new();
        let read =
            File::open(&file).and_then(|f| f.take(MAX_PROJECT_FILE + 1).read_to_end(&mut raw));
        if read.is_err() || raw.len() as u64 > MAX_PROJECT_FILE {
            notes.push(format!("Left out {id}: its project file couldn't be read."));
            return None;
        }
        return match serde_json::from_slice::<Value>(&raw) {
            Ok(Value::Object(o)) => Some(o),
            // Ash OS's registry skips a file it can't read the same way.
            _ => {
                notes.push(format!("Left out {id}: its project file couldn't be read."));
                None
            }
        };
    }
    None
}

/// `ash-hub-projects {include_archived: true}`: the strip's projects as Ash OS answers them.
fn projects(
    conn: &Connection,
    roots: &[PathBuf],
    notes: &mut Vec<String>,
) -> Result<Vec<Value>, String> {
    let overlay = match meta(conn, "hub_project_overlay")? {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    };
    let mut set = hub_set(meta(conn, "hub_project_set")?);
    if set.len() > MAX_STRIP {
        notes.push(format!(
            "Left out {} projects past the first {MAX_STRIP}.",
            set.len() - MAX_STRIP
        ));
        set.truncate(MAX_STRIP);
    }
    let empty = Map::new();
    let mut out = Vec::new();
    let mut named = 0;
    for entry in set {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !project_id_ok(id) {
            continue;
        }
        named += 1;
        let Some(p) = project_file(roots, id, notes) else {
            continue;
        };
        let o = overlay.get(id).and_then(Value::as_object).unwrap_or(&empty);
        let o_name = text(o.get("name"), 60);
        let name = o_name
            .clone()
            .or_else(|| text(entry.get("name"), 60))
            .or_else(|| text(p.get("name"), 60))
            .unwrap_or_else(|| id.to_string());
        let short = text(o.get("short_name"), 16)
            .or_else(|| o_name.as_deref().map(short_name))
            .or_else(|| text(entry.get("shortName"), 16))
            .or_else(|| text(p.get("short_name"), 16))
            .unwrap_or_else(|| short_name(&name));
        let icon = shape_of(o.get("icon_shape"))
            .or_else(|| shape_of(entry.get("iconShape")))
            .or_else(|| shape_of(p.get("icon_shape")))
            .unwrap_or_else(|| DEFAULT_ICON.to_string());
        let work_owner = text(o.get("work_owner"), 20)
            .or_else(|| text(p.get("work_owner"), 20))
            .filter(|w| w == "ash_os" || w == "in_app")
            .unwrap_or_else(|| "ash_os".into());
        let status = text(p.get("status"), 20)
            .filter(|s| s == "active" || s == "parked")
            .unwrap_or_else(|| "active".into());
        let mut row = json!({
            "id": id,
            "name": name,
            "shortName": short,
            "iconShape": icon,
            "folder": folder_of(p.get("repo")),
            "workOwner": work_owner,
            "status": status,
        });
        if truthy(o.get("archived")) {
            row["archived"] = json!(true);
        }
        out.push(row);
    }
    // The strip names projects but none of their files is where the import looks: not a sure "no projects".
    if named > 0 && out.is_empty() {
        return Err("Ash OS's project files weren't found.".into());
    }
    Ok(out)
}

/// `ash-hub-mono-projects`: every membership, ordered as Ash OS orders them.
fn memberships(conn: &Connection, notes: &mut Vec<String>) -> Result<Vec<Value>, String> {
    if !has_table(conn, "hub_mono_projects")? {
        return Ok(Vec::new());
    }
    let failed = |_| "Ash OS's record couldn't be read.".to_string();
    let cols = columns(conn, "hub_mono_projects")?;
    if !cols.contains("mono_id") || !cols.contains("project_id") {
        notes.push("Left out Monos' projects: their table couldn't be read.".into());
        return Ok(Vec::new());
    }
    let col = |name: &'static str| if cols.contains(name) { name } else { "NULL" };
    let sql = format!(
        "SELECT mono_id, project_id, {role}, {added} FROM hub_mono_projects \
         ORDER BY project_id, {role} DESC, mono_id LIMIT ?1",
        role = col("role"),
        added = col("added_at"),
    );
    let mut stmt = conn.prepare(&sql).map_err(failed)?;
    let rows = stmt
        .query_map([MAX_MEMBERSHIPS as i64 + 1], |row| {
            Ok((
                cell_text(row, 0),
                cell_text(row, 1),
                cell_text(row, 2),
                cell_f64(row, 3),
            ))
        })
        .map_err(failed)?;
    let mut out = Vec::new();
    for row in rows {
        let (mono, project, role, added) = row.map_err(failed)?;
        if out.len() == MAX_MEMBERSHIPS {
            notes.push(format!(
                "Left out Monos' projects past the first {MAX_MEMBERSHIPS}."
            ));
            break;
        }
        let (Some(mono), Some(project)) = (mono, project) else {
            continue;
        };
        if !mono_id_ok(&mono) || !project_id_ok(&project) {
            continue;
        }
        let role = role
            .filter(|r| role_ok(r))
            .unwrap_or_else(|| "member".into());
        out.push(json!({
            "monoId": mono,
            "projectId": project,
            "role": role,
            "addedAt": added.and_then(iso),
        }));
    }
    Ok(out)
}

/// `ash-hub-pages`: kept pages, newest kept first, as the app's Page type has them.
fn pages(conn: &Connection, notes: &mut Vec<String>) -> Result<Vec<Value>, String> {
    if !has_table(conn, "hub_pages")? {
        return Ok(Vec::new());
    }
    let failed = |_| "Ash OS's record couldn't be read.".to_string();
    let cols = columns(conn, "hub_pages")?;
    if !["id", "project", "mono_id", "title", "spec", "state"]
        .iter()
        .all(|c| cols.contains(*c))
    {
        notes.push("Left out kept Hubs: their table couldn't be read.".into());
        return Ok(Vec::new());
    }
    // Each value no longer than it may be (a longer one reads as missing); a column an older record lacks reads as NULL.
    let capped = |name: &str, max: usize| {
        if cols.contains(name) {
            format!("CASE WHEN length({name}) <= {max} THEN {name} END")
        } else {
            "NULL".to_string()
        }
    };
    let plain = |name: &str| {
        if cols.contains(name) {
            name.to_string()
        } else {
            "NULL".to_string()
        }
    };
    let sql = format!(
        "SELECT {id}, {project}, {mono}, {by}, {title}, {request}, {spec}, {permissions}, {pin_asked}, {pinned}, \
                {pinned_by}, {kept_at}, {version} \
         FROM hub_pages WHERE state='kept' ORDER BY {kept_at} DESC, {created_at} DESC LIMIT ?1",
        id = capped("id", 128),
        project = capped("project", 48),
        mono = capped("mono_id", 64),
        by = capped("by_name", 80),
        title = capped("title", 200),
        request = capped("request", 4000),
        spec = capped("spec", MAX_SPEC),
        permissions = capped("permissions", 64 * 1024),
        pin_asked = plain("pin_asked"),
        pinned = plain("pinned"),
        pinned_by = capped("pinned_by", 80),
        kept_at = plain("kept_at"),
        version = plain("version"),
        created_at = plain("created_at"),
    );
    let mut stmt = conn.prepare(&sql).map_err(failed)?;
    let rows = stmt
        .query_map(rusqlite::params![MAX_PAGES as i64 + 1], |row| {
            let t = |i| cell_text(row, i).map(Value::String);
            Ok([
                t(0),
                t(1),
                t(2),
                t(3),
                t(4),
                t(5),
                t(6),
                t(7),
                cell_i64(row, 8).map(Value::from),
                cell_i64(row, 9).map(Value::from),
                t(10),
                cell_f64(row, 11).map(Value::from),
                cell_i64(row, 12).map(Value::from),
            ])
        })
        .map_err(failed)?;
    let mut out = Vec::new();
    let mut spec_bytes = 0usize;
    for row in rows {
        let [id, project, mono, by, title, request, spec, permissions, pin_asked, pinned, pinned_by, kept_at, version] =
            row.map_err(failed)?;
        if out.len() == MAX_PAGES {
            notes.push(format!("Left out kept Hubs past the first {MAX_PAGES}."));
            break;
        }
        spec_bytes += spec.as_ref().and_then(Value::as_str).map_or(0, str::len);
        if spec_bytes > MAX_SPECS_TOTAL {
            notes.push(
                "Left out the oldest kept Hubs: together they were too big to bring over.".into(),
            );
            break;
        }
        let (Some(id), Some(project), Some(mono)) = (
            text(id.as_ref(), 128).filter(|i| page_id_ok(i)),
            text(project.as_ref(), 48),
            text(mono.as_ref(), 64).filter(|m| mono_id_ok(m)),
        ) else {
            continue;
        };
        let Some(spec) = spec
            .as_ref()
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .filter(Value::is_object)
        else {
            notes.push(format!(
                "Left out a kept Hub ({id}): its contents couldn't be read."
            ));
            continue;
        };
        let Some(title) = text(title.as_ref(), 200) else {
            continue;
        };
        let permissions: Vec<Value> = permissions
            .as_ref()
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter(|p| text(Some(p), 200).is_some())
            .take(MAX_PERMISSIONS)
            .collect();
        let mut page = json!({
            "id": id,
            "projectId": project,
            "title": title,
            "request": text(request.as_ref(), 4000).unwrap_or_default(),
            "by": text(by.as_ref(), 80).unwrap_or_else(|| mono.clone()),
            "monoId": mono,
            "spec": spec,
            "permissions": permissions,
            "state": "kept",
            "version": version.as_ref().and_then(Value::as_i64).filter(|v| *v > 0).unwrap_or(1),
        });
        if let Some(kept) = kept_at
            .as_ref()
            .and_then(Value::as_f64)
            .filter(|k| k.is_finite() && *k > 0.0)
        {
            page["keptAt"] = json!((kept * 1000.0) as i64);
        }
        if truthy(pinned.as_ref()) {
            page["pinned"] = json!(true);
            page["pinnedBy"] = json!(text(pinned_by.as_ref(), 80).unwrap_or_else(|| "you".into()));
        }
        if truthy(pin_asked.as_ref()) {
            page["pinAsked"] = json!(true);
        }
        out.push(page);
    }
    Ok(out)
}

/// What Ash OS's record holds, in the live reads' shape. `Ok(None)`: there is no record here (no database, or a file
/// that isn't Ash OS's). `Err`: there is one but it couldn't be read this time.
pub(super) fn read(record: &DiskRecord) -> Result<Option<ImportFound>, String> {
    let Some(snap) = snapshot(&record.db)? else {
        return Ok(None);
    };
    let conn = Connection::open_with_flags(
        snap.db(),
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Ash OS's record couldn't be opened.".to_string())?;
    let _ = conn.execute_batch("PRAGMA query_only=1;");
    if !has_table(&conn, "meta")? {
        return Ok(None);
    }
    let mut notes = Vec::new();
    let projects = projects(&conn, &record.roots, &mut notes)?;
    let memberships = memberships(&conn, &mut notes)?;
    let pages = pages(&conn, &mut notes)?;
    drop(conn);
    drop(snap);
    let message = std::iter::once(
        "Ash OS isn't running, so this was read from its saved record.".to_string(),
    )
    .chain(notes)
    .collect::<Vec<_>>()
    .join(" ");
    Ok(Some(ImportFound {
        state: ImportState::Found,
        message: Some(message),
        projects: Value::Array(projects),
        memberships: Value::Array(memberships),
        pages: Value::Array(pages),
    }))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ash-os-disk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const SCHEMA: &str = "
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE hub_mono_projects (mono_id TEXT NOT NULL, project_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member', added_at REAL NOT NULL, PRIMARY KEY (mono_id, project_id));
        CREATE TABLE hub_pages (id TEXT PRIMARY KEY, project TEXT NOT NULL, mono_id TEXT NOT NULL, by_name TEXT,
          title TEXT NOT NULL, request TEXT, kind TEXT NOT NULL, spec TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]',
          pin_asked INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, pinned_by TEXT, state TEXT NOT NULL,
          request_key TEXT, delivered_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL, kept_at REAL,
          version INTEGER NOT NULL DEFAULT 1, log TEXT, replaces TEXT);";

    /// A synthetic Ash OS record laid out as the real one is: `<data>/ashos.db` (WAL mode), `<data>/projects/<id>`
    /// (local projects) and `<checkout>/projects/<id>` (curated). Invented content only.
    pub struct Fixture {
        pub data: PathBuf,
        pub checkout: PathBuf,
    }

    impl Fixture {
        pub fn new(base: &Path) -> Self {
            let fixture = Fixture {
                data: base.join(DATA_SUBPATH),
                checkout: base.join(CHECKOUT_SUBPATH),
            };
            std::fs::create_dir_all(fixture.data.join("projects")).unwrap();
            std::fs::create_dir_all(fixture.checkout.join("projects")).unwrap();
            fixture
        }

        pub fn db(&self) -> PathBuf {
            self.data.join(DB_NAME)
        }

        pub fn record(&self) -> DiskRecord {
            DiskRecord {
                db: self.db(),
                roots: vec![self.checkout.join("projects"), self.data.join("projects")],
            }
        }

        pub fn project(&self, curated: bool, id: &str, body: Value) {
            let root = if curated { &self.checkout } else { &self.data };
            let dir = root.join("projects").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("project.json"), body.to_string()).unwrap();
        }

        /// Ash OS's record with a strip of four (one archived), memberships with a Lead each, and pages (two kept).
        /// Returns the open connection: while it is open, what it wrote may sit only in the log.
        pub fn standard(&self) -> Connection {
            for (curated, id, name, repo) in [
                (true, "vg-game", "EXO game", "/tmp/fixture/vg-game"),
                (true, "hivra", "Hivra & site", "/tmp/fixture/hivra"),
                (true, "hub", "Harness", "/tmp/fixture/hub"),
                (true, "atlas", "Atlas", "/tmp/fixture/atlas"),
                (false, "kids-sums", "Kids sums", "/tmp/fixture/kids-sums"),
            ] {
                self.project(
                    curated,
                    id,
                    json!({"id": id, "name": name, "one_line": "x", "repo": repo}),
                );
            }
            let conn = Connection::open(self.db()).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
                .unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            let set = json!([
                {"id": "vg-game", "iconShape": "gamepad"},
                {"id": "ash", "iconShape": "folder"},
                {"id": "hivra", "iconShape": "ghost"},
                "kids-sums",
                {"id": "not-registered"},
                {"id": "vg-game"}
            ]);
            let overlay = json!({"kids-sums": {"archived": true, "name": "Sums", "icon_shape": "book"},
                                 "hivra": {"short_name": "Hiv"}});
            conn.execute(
                "INSERT INTO meta VALUES ('hub_project_set', ?1)",
                [set.to_string()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO meta VALUES ('hub_project_overlay', ?1)",
                [overlay.to_string()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO meta VALUES ('unrelated', '\"secret-ish\"')",
                [],
            )
            .unwrap();
            for (mono, project, role) in [
                ("vg-game-lead", "vg-game", "lead"),
                ("hivra-lead", "hivra", "lead"),
                ("hub-lead", "hub", "lead"),
                ("kids-sums-lead", "kids-sums", "lead"),
                ("cos", "vg-game", "member"),
                ("cos", "hivra", "member"),
                ("bad id!", "hivra", "member"),
            ] {
                conn.execute(
                    "INSERT INTO hub_mono_projects VALUES (?1, ?2, ?3, 1760495568.622547)",
                    [mono, project, role],
                )
                .unwrap();
            }
            for (id, state, kept) in [
                ("pg-old", "kept", Some(1_760_000_000.5)),
                ("pg-new", "kept", Some(1_760_100_000.25)),
                ("pg-gone", "removed", Some(1_760_000_000.0)),
                ("pg-draft", "preview", None),
            ] {
                conn.execute(
                    "INSERT INTO hub_pages (id, project, mono_id, by_name, title, request, kind, spec, permissions, \
                     pinned, state, created_at, updated_at, kept_at, version) \
                     VALUES (?1, 'hivra', 'hivra-lead', 'Hivra lead', 'Signups', 'show signups', 'table', \
                     '{\"title\":\"Signups\",\"kind\":\"table\"}', '[\"read:signups\"]', 1, ?2, 1.0, 2.0, ?3, 3)",
                    rusqlite::params![id, state, kept],
                )
                .unwrap();
            }
            conn
        }
    }

    fn listing(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn reads_the_record_in_the_live_reads_shape() {
        let base = temp_dir();
        let fixture = Fixture::new(&base);
        drop(fixture.standard());
        let found = read(&fixture.record()).unwrap().expect("a record");
        assert_eq!(found.state, ImportState::Found);
        // The strip, in order: ash became the hub entry, a retired shape its replacement, an unregistered and a
        // repeated id left out, the archived one kept and marked.
        assert_eq!(
            found.projects,
            json!([
                {"id": "vg-game", "name": "EXO game", "shortName": "EXO game", "iconShape": "gamepad",
                 "folder": "/tmp/fixture/vg-game", "workOwner": "ash_os", "status": "active"},
                {"id": "hub", "name": "MonoCode Hub", "shortName": "Hub", "iconShape": "gauge",
                 "folder": "/tmp/fixture/hub", "workOwner": "ash_os", "status": "active"},
                {"id": "hivra", "name": "Hivra & site", "shortName": "Hiv", "iconShape": "gamepad",
                 "folder": "/tmp/fixture/hivra", "workOwner": "ash_os", "status": "active"},
                {"id": "kids-sums", "name": "Sums", "shortName": "Sums", "iconShape": "book",
                 "folder": "/tmp/fixture/kids-sums", "workOwner": "ash_os", "status": "active", "archived": true},
            ])
        );
        // Memberships as ash-hub-mono-projects lists them (by project, then role descending, then Mono); a bad id left out.
        let members: Vec<(String, String, String)> = found
            .memberships
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                (
                    m["projectId"].as_str().unwrap().into(),
                    m["monoId"].as_str().unwrap().into(),
                    m["role"].as_str().unwrap().into(),
                )
            })
            .collect();
        assert_eq!(
            members,
            [
                ("hivra", "cos", "member"),
                ("hivra", "hivra-lead", "lead"),
                ("hub", "hub-lead", "lead"),
                ("kids-sums", "kids-sums-lead", "lead"),
                ("vg-game", "cos", "member"),
                ("vg-game", "vg-game-lead", "lead"),
            ]
            .map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string()))
        );
        assert_eq!(
            found.memberships[1]["addedAt"],
            "2025-10-15T02:32:48.622547Z"
        );
        // Kept pages only, newest kept first, as the app's Page type has them.
        assert_eq!(
            found.pages,
            json!([
                {"id": "pg-new", "projectId": "hivra", "title": "Signups", "request": "show signups", "by": "Hivra lead",
                 "monoId": "hivra-lead", "spec": {"title": "Signups", "kind": "table"}, "permissions": ["read:signups"],
                 "state": "kept", "version": 3, "keptAt": 1_760_100_000_250_i64, "pinned": true, "pinnedBy": "you"},
                {"id": "pg-old", "projectId": "hivra", "title": "Signups", "request": "show signups", "by": "Hivra lead",
                 "monoId": "hivra-lead", "spec": {"title": "Signups", "kind": "table"}, "permissions": ["read:signups"],
                 "state": "kept", "version": 3, "keptAt": 1_760_000_000_500_i64, "pinned": true, "pinnedBy": "you"},
            ])
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn rows_still_in_the_log_are_read_and_nothing_is_made_beside_the_record() {
        let base = temp_dir();
        let fixture = Fixture::new(&base);
        // The writer stays open with checkpoints off: every row so far is only in ashos.db-wal.
        let writer = fixture.standard();
        assert!(fixture.data.join("ashos.db-wal").exists());
        let before = listing(&fixture.data);
        let db_bytes = std::fs::read(fixture.db()).unwrap();
        let wal_bytes = std::fs::read(fixture.data.join("ashos.db-wal")).unwrap();
        let found = read(&fixture.record()).unwrap().expect("a record");
        assert_eq!(found.projects.as_array().unwrap().len(), 4, "{found:?}");
        assert_eq!(found.memberships.as_array().unwrap().len(), 6);
        assert_eq!(found.pages.as_array().unwrap().len(), 2);
        // Ash OS's files are exactly as they were.
        assert_eq!(listing(&fixture.data), before);
        assert_eq!(std::fs::read(fixture.db()).unwrap(), db_bytes);
        assert_eq!(
            std::fs::read(fixture.data.join("ashos.db-wal")).unwrap(),
            wal_bytes
        );
        drop(writer);

        // A record closed cleanly (WAL mode, no log or shared-memory file beside it): reading it makes none.
        assert_eq!(listing(&fixture.data), vec!["ashos.db", "projects"]);
        let db_bytes = std::fs::read(fixture.db()).unwrap();
        read(&fixture.record()).unwrap().expect("a record");
        assert_eq!(listing(&fixture.data), vec!["ashos.db", "projects"]);
        assert_eq!(std::fs::read(fixture.db()).unwrap(), db_bytes);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn the_private_copy_is_removed_after() {
        let base = temp_dir();
        let fixture = Fixture::new(&base);
        drop(fixture.standard());
        let snap = snapshot(&fixture.db()).unwrap().unwrap();
        let dir = snap.dir.clone();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(snap.db()).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(snap);
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_or_oversized_project_file_is_left_out_with_a_line() {
        let base = temp_dir();
        let fixture = Fixture::new(&base);
        drop(fixture.standard());
        // hivra's file becomes a link to a file elsewhere; vg-game's grows past the cap.
        let elsewhere = base.join("elsewhere.json");
        std::fs::write(
            &elsewhere,
            json!({"name": "Linked", "repo": "/etc"}).to_string(),
        )
        .unwrap();
        let hivra = fixture.checkout.join("projects/hivra/project.json");
        std::fs::remove_file(&hivra).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &hivra).unwrap();
        let big = json!({"name": "Big", "one_line": "x".repeat(MAX_PROJECT_FILE as usize)});
        std::fs::write(
            fixture.checkout.join("projects/vg-game/project.json"),
            big.to_string(),
        )
        .unwrap();
        // A linked project folder counts the same.
        std::fs::rename(fixture.checkout.join("projects/hub"), base.join("hub-real")).unwrap();
        std::os::unix::fs::symlink(base.join("hub-real"), fixture.checkout.join("projects/hub"))
            .unwrap();
        let found = read(&fixture.record()).unwrap().expect("a record");
        let ids: Vec<&str> = found
            .projects
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["kids-sums"]);
        let message = found.message.unwrap();
        assert!(
            message.contains("Left out hivra: its project file is a link."),
            "{message}"
        );
        assert!(
            message.contains("Left out hub: its project file is a link."),
            "{message}"
        );
        assert!(
            message.contains("Left out vg-game: its project file is too big."),
            "{message}"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn untrusted_values_are_checked_and_capped() {
        let base = temp_dir();
        let fixture = Fixture::new(&base);
        let conn = fixture.standard();
        // A relative or oversized folder is no folder; a name with control characters falls back; a bad page spec is
        // left out with a line; a bad shape falls back to the default.
        fixture.project(
            true,
            "vg-game",
            json!({"name": "EXO\u{7}", "repo": "relative/path", "icon_shape": "skull"}),
        );
        fixture.project(
            true,
            "hivra",
            json!({"name": "Hivra", "repo": format!("/{}", "a".repeat(MAX_FOLDER))}),
        );
        conn.execute("UPDATE hub_pages SET spec='not json' WHERE id='pg-old'", [])
            .unwrap();
        conn.execute(
            "UPDATE meta SET value=?1 WHERE key='hub_project_overlay'",
            [format!("\"{}\"", "x".repeat(MAX_META + 1))],
        )
        .unwrap();
        drop(conn);
        let found = read(&fixture.record()).unwrap().expect("a record");
        let p = &found.projects;
        assert_eq!(p[0]["id"], "vg-game");
        assert_eq!(p[0]["name"], "vg-game");
        assert_eq!(p[0]["folder"], Value::Null);
        assert_eq!(p[0]["iconShape"], "gamepad");
        assert_eq!(p[2]["id"], "hivra");
        assert_eq!(p[2]["folder"], Value::Null);
        // The overlay was too big to read: no archive, no renames from it.
        assert_eq!(p[3]["name"], "Kids sums");
        assert!(p[3].get("archived").is_none());
        assert_eq!(found.pages.as_array().unwrap().len(), 1);
        assert!(found
            .message
            .unwrap()
            .contains("Left out a kept Hub (pg-old)"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn no_database_is_no_record_and_another_file_is_none_either() {
        let base = temp_dir();
        let fixture = Fixture::new(&base);
        assert_eq!(read(&fixture.record()), Ok(None));
        // A database with no meta table isn't Ash OS's record.
        Connection::open(fixture.db())
            .unwrap()
            .execute_batch("CREATE TABLE t (x);")
            .unwrap();
        assert_eq!(read(&fixture.record()), Ok(None));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn short_names_and_times_match_ash_os() {
        assert_eq!(short_name("Hivra & site"), "Hivra");
        assert_eq!(short_name("Recall Check - kids"), "Recall Check");
        assert_eq!(short_name("A very long project name"), "A very long");
        assert_eq!(short_name("Sci-fi"), "Sci-fi");
        assert_eq!(
            iso(1_760_495_568.622_547).unwrap(),
            "2025-10-15T02:32:48.622547Z"
        );
        assert_eq!(iso(1_700_000_000.0).unwrap(), "2023-11-14T22:13:20Z");
        assert_eq!(iso(f64::NAN), None);
    }

    #[test]
    fn a_strip_whose_project_files_are_missing_is_no_answer_this_time() {
        let base = temp_dir();
        let fixture = Fixture::new(&base);
        drop(fixture.standard());
        // The checkout moved: the strip still names projects, but no file is where the import looks.
        std::fs::remove_dir_all(fixture.checkout.join("projects")).unwrap();
        std::fs::remove_dir_all(fixture.data.join("projects")).unwrap();
        assert_eq!(
            read(&fixture.record()).unwrap_err(),
            "Ash OS's project files weren't found."
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn an_odd_value_or_an_older_table_leaves_out_only_what_it_touches() {
        let base = temp_dir();
        let fixture = Fixture::new(&base);
        let conn = fixture.standard();
        // SQLite doesn't hold columns to their types: text where a time belongs, a real where a flag belongs, a blob
        // in meta. And an older record without a column.
        conn.execute(
            "UPDATE hub_mono_projects SET added_at='yesterday' WHERE mono_id='cos' AND project_id='hivra'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE hub_pages SET pinned=1.0, version='three' WHERE id='pg-new'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE meta SET value=X'00FF' WHERE key='hub_project_overlay'",
            [],
        )
        .unwrap();
        conn.execute_batch("ALTER TABLE hub_pages DROP COLUMN pin_asked;")
            .unwrap();
        drop(conn);
        let found = read(&fixture.record()).unwrap().expect("a record");
        let cos = found
            .memberships
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["monoId"] == "cos" && m["projectId"] == "hivra")
            .expect("the membership is kept")
            .clone();
        assert_eq!(cos["addedAt"], Value::Null);
        let pages = found.pages.as_array().unwrap();
        assert_eq!(pages.len(), 2);
        let new = pages.iter().find(|p| p["id"] == "pg-new").unwrap();
        assert_eq!(new["pinned"], json!(true));
        assert_eq!(new["version"], json!(1));
        assert_eq!(found.projects.as_array().unwrap().len(), 4);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_folder_that_climbs_out_is_no_folder() {
        assert_eq!(folder_of(Some(&json!("/work/../etc"))), None);
        assert_eq!(
            folder_of(Some(&json!("/work/app"))),
            Some("/work/app".into())
        );
        assert_eq!(folder_of(Some(&json!("~/work/app"))), None);
    }

    #[test]
    fn a_copy_a_crash_left_behind_is_swept_and_nothing_else() {
        let temp = temp_dir();
        let copy = temp.join(format!("{COPY_PREFIX}left"));
        let other = temp.join("someone-else");
        for dir in [&copy, &other] {
            std::fs::create_dir_all(dir).unwrap();
        }
        // Just made: kept.
        sweep_stale_copies(&temp);
        assert!(copy.exists());
        // An hour and more later: the reader's own copy goes, nothing else does.
        let later = SystemTime::now() + std::time::Duration::from_secs(STALE_COPY_SECS + 60);
        sweep_copies_older_than(&temp, later);
        assert!(!copy.exists());
        assert!(other.exists());
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn a_dev_copy_reads_only_a_named_stand_in() {
        let home = temp_dir();
        let real = temp_dir();
        for h in [&home, &real] {
            drop(Fixture::new(h).standard());
        }
        // Named nothing: off.
        assert!(resolve(false, None, None, Some(home.clone()), Some(real.clone())).is_err());
        // The real record, under HOME or the real home, by its own path, through `..`, or through a link: refused.
        for h in [&home, &real] {
            let db = h.join(DATA_SUBPATH).join(DB_NAME);
            assert!(resolve(
                false,
                Some(db),
                None,
                Some(home.clone()),
                Some(real.clone())
            )
            .is_err());
            let sneaky = h.join(DATA_SUBPATH).join("projects/../ashos.db");
            assert!(resolve(
                false,
                Some(sneaky),
                None,
                Some(home.clone()),
                Some(real.clone())
            )
            .is_err());
            let stand_in = temp_dir();
            let curated = h.join(CHECKOUT_SUBPATH).join("projects");
            assert!(resolve(
                false,
                Some(stand_in.join(DB_NAME)),
                Some(curated),
                Some(home.clone()),
                Some(real.clone())
            )
            .is_err());
            #[cfg(unix)]
            {
                let link = stand_in.join("link");
                std::os::unix::fs::symlink(h.join(DATA_SUBPATH), &link).unwrap();
                assert!(resolve(
                    false,
                    Some(link.join(DB_NAME)),
                    None,
                    Some(home.clone()),
                    Some(real.clone())
                )
                .is_err());
            }
            let _ = std::fs::remove_dir_all(stand_in);
        }
        // A hard link to the real record (told apart by its inode, so Unix only), and a `..` that doesn't resolve
        // yet: refused too.
        let elsewhere = temp_dir();
        #[cfg(unix)]
        {
            let hard = elsewhere.join("copy.db");
            std::fs::hard_link(real.join(DATA_SUBPATH).join(DB_NAME), &hard).unwrap();
            assert!(resolve(
                false,
                Some(hard),
                None,
                Some(home.clone()),
                Some(real.clone())
            )
            .is_err());
        }
        assert!(resolve(
            false,
            Some(elsewhere.join("not-yet/../../x.db")),
            None,
            Some(home.clone()),
            Some(real.clone())
        )
        .is_err());
        let _ = std::fs::remove_dir_all(elsewhere);
        // A stand-in a test names: read from there only.
        let stand_in = temp_dir();
        let record = resolve(
            false,
            Some(stand_in.join(DB_NAME)),
            Some(stand_in.join("curated")),
            Some(home.clone()),
            Some(real.clone()),
        )
        .unwrap();
        assert_eq!(
            record,
            DiskRecord {
                db: stand_in.join(DB_NAME),
                roots: vec![stand_in.join("curated"), stand_in.join("projects")]
            }
        );
        // The daily app reads the real record under its home: data folder, then the curated checkout first.
        assert_eq!(
            resolve(true, None, None, Some(home.clone()), None).unwrap(),
            DiskRecord {
                db: home.join(DATA_SUBPATH).join(DB_NAME),
                roots: vec![
                    home.join(CHECKOUT_SUBPATH).join("projects"),
                    home.join(DATA_SUBPATH).join("projects")
                ]
            }
        );
        for dir in [home, real, stand_in] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
