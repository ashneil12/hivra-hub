// Copyright coollabsio and the Orbit contributors
// SPDX-License-Identifier: Apache-2.0
// Source: https://github.com/coollabsio/orbit crates/platform/src/backup.rs
//
// Translated to rusqlite for Hivra (WP-75). S3, Postgres and collaborative-document
// epochs are not included: Hivra has no object storage and one SQLite file.
// Hivra adds several source trees, secret scrubbing, and dev-copy confinement.
// A symlink or a secret file is left out of the snapshot instead of failing the
// whole backup; Orbit rejected those as unsupported attachments.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::portable::scrubber;
use crate::session_store::{self, SCHEMA_VERSION};

pub const DATABASE_FILE: &str = "database.sqlite";
pub const MANIFEST_FILE: &str = "manifest.json";
/// Retention keeps up to this many snapshots from the last day, so a manual or hourly backup does not replace an
/// earlier one from the same day.
const RECENT_SNAPSHOTS: usize = 24;
const RECENT_MILLIS: i64 = 24 * 60 * 60 * 1000;
const TEXT_EXTENSIONS: &[&str] = &[
    "md", "json", "txt", "markdown", "csv", "yml", "yaml", "toml", "log", "html", "css", "js",
    "ts", "tsx", "jsx", "svg",
];
const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "pdf", "zip", "gz", "wasm", "sqlite", "db", "ico",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupKind {
    Snapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BackupFile {
    pub path: String,
    pub sha256: String,
    pub byte_size: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BackupManifest {
    pub id: String,
    pub created_at: i64,
    pub kind: BackupKind,
    pub schema_version: i64,
    pub application_version: String,
    pub files: Vec<BackupFile>,
    /// Paths left out (a secret file, a symlink, a `.git` directory). Not part of the file inventory.
    #[serde(default)]
    pub omitted: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub id: String,
    pub path: PathBuf,
    pub manifest: BackupManifest,
}

#[derive(Debug)]
pub enum BackupError {
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Manifest {
        path: PathBuf,
        source: serde_json::Error,
    },
    NotFound {
        id: String,
    },
    ChecksumMismatch {
        path: String,
        expected: String,
        actual: String,
    },
    UnsupportedAttachment {
        path: PathBuf,
    },
    UnsafeManifestPath {
        path: String,
    },
    InventoryMismatch,
    PathOverlap {
        backup_root: PathBuf,
        other: PathBuf,
    },
    UnsupportedSchema {
        found: i64,
        maximum_supported: i64,
    },
    OnlineBackup(String),
    InvalidSnapshot(String),
    SnapshotRead(String),
    Confined(String),
    Busy,
    RosterChanged,
    Conflict,
    Missing(String),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "Couldn't read or write {}: {source}", path.display()),
            Self::Manifest { path, source } => write!(f, "This backup's manifest is unreadable ({}): {source}", path.display()),
            Self::NotFound { id } => write!(f, "Backup {id} isn't there."),
            Self::ChecksumMismatch { path, expected, actual } => {
                write!(f, "This backup is damaged ({path}: {actual}, expected {expected}).")
            }
            Self::UnsupportedAttachment { path } => write!(f, "This backup has an entry that isn't a file ({}).", path.display()),
            Self::UnsafeManifestPath { path } => write!(f, "This backup names an unsafe path ({path})."),
            Self::InventoryMismatch => write!(f, "This backup is incomplete."),
            Self::PathOverlap { backup_root, other } => write!(
                f,
                "The backup folder {} overlaps {}.",
                backup_root.display(),
                other.display()
            ),
            Self::UnsupportedSchema { found, maximum_supported } => write!(
                f,
                "This backup is from a newer Hivra (schema {found}; this build reads up to {maximum_supported})."
            ),
            Self::OnlineBackup(message) => write!(f, "The database couldn't be copied. {message}"),
            Self::InvalidSnapshot(message) => write!(f, "This backup can't be read. {message}"),
            Self::SnapshotRead(message) => write!(f, "This backup couldn't be read. {message}"),
            Self::Confined(message) => write!(f, "{message}"),
            Self::Busy => write!(f, "A backup is already running."),
            Self::RosterChanged => write!(f, "The Mono list changed. Try again."),
            Self::Conflict => write!(f, "Those settings changed. They were reloaded."),
            Self::Missing(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for BackupError {}

/// Everything a backup reads, and the folders it must not write into.
#[derive(Clone, Debug)]
pub struct Roots {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub monos_root: PathBuf,
    pub memory_root: PathBuf,
    pub notes_root: PathBuf,
    pub docs_root: PathBuf,
    pub dev: bool,
    /// The daily app's data folder. A dev copy must not read or write it.
    pub daily_data_dir: Option<PathBuf>,
    pub protected: Vec<PathBuf>,
}

impl Roots {
    pub fn trees(&self) -> Vec<(&str, &Path)> {
        vec![
            ("monos", self.monos_root.as_path()),
            ("memory", self.memory_root.as_path()),
            ("notes", self.notes_root.as_path()),
            ("docs", self.docs_root.as_path()),
        ]
    }
}

pub fn now_millis() -> i64 {
    session_store::now_millis()
}

/// Write a snapshot into `.{id}.tmp`, check it, then rename it into place. The manifest is written last, and a name
/// starting with `.` is never listed, so a half-written backup is never taken for a whole one.
pub fn create(roots: &Roots, backup_root: &Path) -> Result<Snapshot, BackupError> {
    let backup_root = confine(roots, backup_root)?;
    fs::create_dir_all(&backup_root).map_err(|source| io_error(&backup_root, source))?;
    let id = uuid::Uuid::new_v4().to_string();
    let temporary = backup_root.join(format!(".{id}.tmp"));
    let final_path = backup_root.join(&id);
    let mut temp = TempSnapshot {
        path: temporary.clone(),
        committed: false,
    };
    fs::create_dir_all(&temporary).map_err(|source| io_error(&temporary, source))?;

    let result = (|| {
        let schema_version = read_schema(&roots.db_path)?;
        if roots.db_path.is_file() {
            let database = temporary.join(DATABASE_FILE);
            vacuum_into(&roots.db_path, &database)?;
            scrub_database(&database)?;
        }
        let mut files = Vec::new();
        let mut omitted = Vec::new();
        if temporary.join(DATABASE_FILE).is_file() {
            files.push(file_manifest(&temporary.join(DATABASE_FILE), &temporary)?);
        }
        for (name, source) in roots.trees() {
            copy_tree(
                source,
                &temporary.join(name),
                &temporary,
                skip_child(roots, name, source),
                &mut files,
                &mut omitted,
            )?;
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        omitted.sort();
        let manifest = BackupManifest {
            id: id.clone(),
            created_at: now_millis(),
            kind: BackupKind::Snapshot,
            schema_version,
            application_version: env!("CARGO_PKG_VERSION").to_owned(),
            files,
            omitted,
        };
        write_manifest(&temporary, &manifest)?;
        let unpublished = Snapshot {
            id: id.clone(),
            path: temporary.clone(),
            manifest: manifest.clone(),
        };
        verify_snapshot(&unpublished)?;
        fs::rename(&temporary, &final_path).map_err(|source| io_error(&final_path, source))?;
        Ok(Snapshot {
            id,
            path: final_path,
            manifest,
        })
    })();
    if result.is_ok() {
        temp.committed = true;
    }
    result
}

/// The newest of the last 24 hours (up to 24), the newest of each of the last 7 days, and the newest of each of the
/// last 4 ISO weeks. Anything else is deleted. A snapshot whose time doesn't parse is not put in a day or week bucket.
pub fn apply_retention(backup_root: &Path, now_millis: i64) -> Result<(), BackupError> {
    let snapshots = list(backup_root)?;
    let created: Vec<(String, i64)> = snapshots
        .iter()
        .map(|snapshot| (snapshot.id.clone(), snapshot.manifest.created_at))
        .collect();
    let keep = retention_ids(&created, now_millis);
    for snapshot in snapshots {
        if keep.contains(&snapshot.id) {
            continue;
        }
        guarded_remove(backup_root, &snapshot.path)?;
    }
    Ok(())
}

/// Which of `created` (id, unix millis) retention keeps. `created` need not be sorted.
pub fn retention_ids(created: &[(String, i64)], now_millis: i64) -> HashSet<String> {
    let mut ordered: Vec<&(String, i64)> = created.iter().collect();
    ordered.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| right.0.cmp(&left.0)));
    let mut daily = HashSet::new();
    let mut weekly = HashSet::new();
    let mut keep = HashSet::new();
    let recent_since = now_millis.saturating_sub(RECENT_MILLIS);
    for (id, created_at) in ordered {
        if keep.len() < RECENT_SNAPSHOTS && *created_at > recent_since {
            keep.insert(id.clone());
        }
        let Some((day, week)) = day_and_week(*created_at) else {
            continue;
        };
        if daily.len() < 7 && daily.insert(day) {
            keep.insert(id.clone());
        }
        if weekly.len() < 4 && weekly.insert(week) {
            keep.insert(id.clone());
        }
    }
    keep
}

pub fn list(backup_root: &Path) -> Result<Vec<Snapshot>, BackupError> {
    if !backup_root.exists() {
        return Ok(Vec::new());
    }
    let mut snapshots = Vec::new();
    let entries = fs::read_dir(backup_root).map_err(|source| io_error(backup_root, source))?;
    for entry in entries {
        let entry = entry.map_err(|source| io_error(backup_root, source))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || !valid_snapshot_id(&name) {
            continue;
        }
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| io_error(&path, source))?;
        if !file_type.is_dir() || !path.join(MANIFEST_FILE).is_file() {
            continue;
        }
        if let Ok(snapshot) = read_snapshot(path) {
            snapshots.push(snapshot);
        }
    }
    snapshots.sort_by(|left, right| {
        right
            .manifest
            .created_at
            .cmp(&left.manifest.created_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    Ok(snapshots)
}

pub fn find(backup_root: &Path, id: &str) -> Result<Snapshot, BackupError> {
    if !valid_snapshot_id(id) {
        return Err(BackupError::NotFound { id: id.to_owned() });
    }
    let path = backup_root.join(id);
    let root = canonicalize_future_path(backup_root)?;
    let resolved = canonicalize_future_path(&path)?;
    if resolved != root && !resolved.starts_with(&root) {
        return Err(BackupError::NotFound { id: id.to_owned() });
    }
    if !path.join(MANIFEST_FILE).is_file() {
        return Err(BackupError::NotFound { id: id.to_owned() });
    }
    read_snapshot(path)
}

pub fn verify_dir(path: &Path) -> Result<Snapshot, BackupError> {
    let snapshot = read_snapshot(path.to_path_buf())?;
    verify_snapshot(&snapshot)?;
    Ok(snapshot)
}

pub fn verify_snapshot(snapshot: &Snapshot) -> Result<(), BackupError> {
    if snapshot.manifest.schema_version < 0 || snapshot.manifest.schema_version > SCHEMA_VERSION {
        return Err(BackupError::UnsupportedSchema {
            found: snapshot.manifest.schema_version,
            maximum_supported: SCHEMA_VERSION,
        });
    }
    let mut actual_files = Vec::new();
    collect_snapshot_files(&snapshot.path, &snapshot.path, &mut actual_files)?;
    actual_files.sort();
    let mut expected_files: Vec<String> = snapshot
        .manifest
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect();
    expected_files.sort();
    if actual_files != expected_files {
        return Err(BackupError::InventoryMismatch);
    }
    for expected in &snapshot.manifest.files {
        let relative = safe_manifest_path(&expected.path)?;
        let path = snapshot.path.join(relative);
        let actual = file_manifest(&path, &snapshot.path)?;
        if actual.sha256 != expected.sha256 || actual.byte_size != expected.byte_size {
            return Err(BackupError::ChecksumMismatch {
                path: expected.path.clone(),
                expected: expected.sha256.clone(),
                actual: actual.sha256,
            });
        }
    }
    Ok(())
}

pub fn safe_manifest_path(path: &str) -> Result<&Path, BackupError> {
    let relative = Path::new(path);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(BackupError::UnsafeManifestPath {
            path: path.to_owned(),
        });
    }
    Ok(relative)
}

pub fn valid_snapshot_id(id: &str) -> bool {
    crate::ship::valid_id(id) && !id.contains('/') && !id.contains('\\')
}

/// The backup folder must not overlap a tree it copies, and a dev copy may only write inside its own data folder,
/// never the daily app's.
pub fn confine(roots: &Roots, backup_root: &Path) -> Result<PathBuf, BackupError> {
    let backup_root = canonicalize_future_path(backup_root)?;
    let data_dir = canonicalize_future_path(&roots.data_dir)?;
    if backup_root == data_dir {
        return Err(BackupError::Confined(
            "Pick a folder inside the data folder, not the data folder itself.".into(),
        ));
    }
    for (_, source) in roots.trees() {
        if !source.exists() {
            continue;
        }
        let source = canonicalize_future_path(source)?;
        if backup_root == source
            || backup_root.starts_with(&source)
            || source.starts_with(&backup_root)
        {
            return Err(BackupError::PathOverlap {
                backup_root,
                other: source,
            });
        }
    }
    if roots.dev && backup_root != data_dir && !backup_root.starts_with(&data_dir) {
        return Err(BackupError::Confined(
            "A dev copy only writes backups inside its own folder.".into(),
        ));
    }
    // The daily app's own `<data>/backups` is inside its data folder. Only a dev copy is kept out of that folder.
    if roots.dev {
        if let Some(daily) = &roots.daily_data_dir {
            let daily = canonicalize_future_path(daily)?;
            if backup_root == daily || backup_root.starts_with(&daily) {
                return Err(BackupError::Confined(
                    "A backup can't go in the daily app's folder.".into(),
                ));
            }
        }
    }
    for protected in &roots.protected {
        if !protected.exists() && canonicalize_future_path(protected).is_err() {
            continue;
        }
        let Ok(protected) = canonicalize_future_path(protected) else {
            continue;
        };
        if backup_root == protected || backup_root.starts_with(&protected) {
            return Err(BackupError::Confined(format!(
                "A backup can't go in {}.",
                protected.display()
            )));
        }
    }
    Ok(backup_root)
}

pub fn default_backup_root(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

pub fn write_manifest(path: &Path, manifest: &BackupManifest) -> Result<(), BackupError> {
    let manifest_path = path.join(MANIFEST_FILE);
    let contents = serde_json::to_vec_pretty(manifest).map_err(|source| BackupError::Manifest {
        path: manifest_path.clone(),
        source,
    })?;
    let mut file =
        File::create(&manifest_path).map_err(|source| io_error(&manifest_path, source))?;
    file.write_all(&contents)
        .and_then(|()| file.sync_all())
        .map_err(|source| io_error(&manifest_path, source))?;
    Ok(())
}

pub fn read_snapshot(path: PathBuf) -> Result<Snapshot, BackupError> {
    let manifest_path = path.join(MANIFEST_FILE);
    let contents = fs::read(&manifest_path).map_err(|source| io_error(&manifest_path, source))?;
    let manifest: BackupManifest =
        serde_json::from_slice(&contents).map_err(|source| BackupError::Manifest {
            path: manifest_path,
            source,
        })?;
    if manifest.id.is_empty() || !valid_snapshot_id(&manifest.id) {
        return Err(BackupError::InvalidSnapshot(
            "the manifest id is not a backup id".into(),
        ));
    }
    Ok(Snapshot {
        id: manifest.id.clone(),
        path,
        manifest,
    })
}

fn read_schema(db: &Path) -> Result<i64, BackupError> {
    if !db.is_file() {
        return Ok(0);
    }
    let conn =
        Connection::open(db).map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
    let _ = conn.busy_timeout(Duration::from_secs(5));
    session_store::schema_version(&conn)
        .map_err(|error| BackupError::OnlineBackup(error.to_string()))
}

fn vacuum_into(db: &Path, destination: &Path) -> Result<(), BackupError> {
    let conn =
        Connection::open(db).map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
    conn.busy_timeout(Duration::from_secs(30))
        .map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
    let destination = destination.to_string_lossy().into_owned();
    conn.execute("VACUUM INTO ?1", [destination])
        .map(|_| ())
        .map_err(|error| BackupError::OnlineBackup(error.to_string()))
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn is_text_type(declared: &str) -> bool {
    let upper = declared.to_ascii_uppercase();
    upper.contains("TEXT")
        || upper.contains("CHAR")
        || upper.contains("CLOB")
        || upper.contains("JSON")
}

/// Redact text columns in the snapshot copy only. The live database is not opened for writing.
fn scrub_database(path: &Path) -> Result<(), BackupError> {
    let conn =
        Connection::open(path).map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
    let _ = conn.busy_timeout(Duration::from_secs(30));
    let tables = {
        let mut statement = conn
            .prepare(
                "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| BackupError::OnlineBackup(error.to_string()))?
    };
    let redactor = scrubber();
    for (table, sql) in tables {
        let without_rowid = sql
            .unwrap_or_default()
            .to_ascii_uppercase()
            .contains("WITHOUT ROWID");
        scrub_table(&conn, &table, without_rowid, redactor)?;
    }
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    drop(conn);
    if let (Some(parent), Some(name)) = (
        path.parent(),
        path.file_name().and_then(|name| name.to_str()),
    ) {
        for suffix in ["-wal", "-shm", "-journal"] {
            let _ = fs::remove_file(parent.join(format!("{name}{suffix}")));
        }
    }
    Ok(())
}

fn scrub_table(
    conn: &Connection,
    table: &str,
    without_rowid: bool,
    redactor: &crate::portable::Scrubber,
) -> Result<(), BackupError> {
    let mut info = conn
        .prepare(&format!("PRAGMA table_info({})", quote_ident(table)))
        .map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
    let columns = info
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|error| BackupError::OnlineBackup(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
    drop(info);
    let text_names: Vec<String> = columns
        .iter()
        .filter(|(_, declared, _)| is_text_type(declared))
        .map(|(name, _, _)| name.clone())
        .collect();
    if text_names.is_empty() {
        return Ok(());
    }
    let mut key_names: Vec<String> = Vec::new();
    if without_rowid {
        let mut keyed: Vec<(i64, String)> = columns
            .iter()
            .filter(|(_, _, pk)| *pk > 0)
            .map(|(name, _, pk)| (*pk, name.clone()))
            .collect();
        keyed.sort_by_key(|(pk, _)| *pk);
        key_names = keyed.into_iter().map(|(_, name)| name).collect();
        if key_names.is_empty() {
            return Ok(());
        }
    }
    let mut selected = Vec::new();
    if without_rowid {
        selected.extend(key_names.iter().map(|name| quote_ident(name)));
    } else {
        selected.push("rowid".to_owned());
    }
    selected.extend(text_names.iter().map(|name| quote_ident(name)));
    let query = format!("SELECT {} FROM {}", selected.join(", "), quote_ident(table));
    let key_count = if without_rowid { key_names.len() } else { 1 };
    let mut pending: Vec<(Vec<rusqlite::types::Value>, Vec<Option<String>>)> = Vec::new();
    {
        let mut statement = conn
            .prepare(&query)
            .map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
        let mut rows = statement
            .query([])
            .map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
        while let Some(row) = rows
            .next()
            .map_err(|error| BackupError::OnlineBackup(error.to_string()))?
        {
            let mut keys = Vec::with_capacity(key_count);
            for index in 0..key_count {
                keys.push(
                    row.get(index)
                        .map_err(|error| BackupError::OnlineBackup(error.to_string()))?,
                );
            }
            let mut changed = false;
            let mut texts = Vec::with_capacity(text_names.len());
            for offset in 0..text_names.len() {
                let value = row
                    .get_ref(key_count + offset)
                    .map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
                let text = match value {
                    rusqlite::types::ValueRef::Text(bytes) => {
                        Some(String::from_utf8_lossy(bytes).into_owned())
                    }
                    _ => None,
                };
                match text {
                    Some(text) => {
                        let (redacted, count) = redactor.redact_text(&text);
                        if count > 0 && redacted != text {
                            changed = true;
                            texts.push(Some(redacted));
                        } else {
                            texts.push(Some(text));
                        }
                    }
                    None => texts.push(None),
                }
            }
            if changed {
                pending.push((keys, texts));
            }
        }
    }
    for (keys, texts) in pending {
        let set = text_names
            .iter()
            .enumerate()
            .map(|(index, name)| format!("{} = ?{}", quote_ident(name), index + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let where_sql = if without_rowid {
            key_names
                .iter()
                .enumerate()
                .map(|(index, name)| {
                    format!("{} = ?{}", quote_ident(name), text_names.len() + 1 + index)
                })
                .collect::<Vec<_>>()
                .join(" AND ")
        } else {
            format!("rowid = ?{}", text_names.len() + 1)
        };
        let update = format!("UPDATE {} SET {set} WHERE {where_sql}", quote_ident(table));
        let mut values: Vec<rusqlite::types::Value> = texts
            .into_iter()
            .map(|text| match text {
                Some(text) => rusqlite::types::Value::Text(text),
                None => rusqlite::types::Value::Null,
            })
            .collect();
        values.extend(keys);
        conn.execute(&update, rusqlite::params_from_iter(values.iter()))
            .map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
    }
    Ok(())
}

/// When `memory/` contains the Monos folder, that child is skipped so a Mono isn't stored twice.
fn skip_child<'a>(roots: &'a Roots, name: &str, source: &Path) -> Option<&'a Path> {
    if name != "memory" {
        return None;
    }
    let monos = roots.monos_root.as_path();
    if monos == source || monos.starts_with(source) {
        Some(monos)
    } else {
        None
    }
}

fn copy_tree(
    source: &Path,
    destination: &Path,
    snapshot_root: &Path,
    skip: Option<&Path>,
    files: &mut Vec<BackupFile>,
    omitted: &mut Vec<String>,
) -> Result<(), BackupError> {
    if !source.exists() {
        return Ok(());
    }
    if let Some(skip) = skip {
        if paths_same(source, skip) {
            return Ok(());
        }
    }
    let source_meta =
        fs::symlink_metadata(source).map_err(|source_error| io_error(source, source_error))?;
    if source_meta.file_type().is_symlink() {
        omitted.push(relabel(destination, snapshot_root));
        return Ok(());
    }
    fs::create_dir_all(destination).map_err(|error| io_error(destination, error))?;
    let mut entries = fs::read_dir(source)
        .map_err(|error| io_error(source, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| io_error(source, error))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source_path = entry.path();
        if let Some(skip) = skip {
            if paths_same(&source_path, skip) {
                continue;
            }
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| io_error(&source_path, error))?;
        if name == ".git" && file_type.is_dir() {
            omitted.push(relabel(&destination_path, snapshot_root));
            continue;
        }
        if file_type.is_symlink() {
            omitted.push(relabel(&destination_path, snapshot_root));
            continue;
        }
        if file_type.is_dir() {
            copy_tree(
                &source_path,
                &destination_path,
                snapshot_root,
                skip,
                files,
                omitted,
            )?;
            continue;
        }
        if !file_type.is_file() {
            return Err(BackupError::UnsupportedAttachment { path: source_path });
        }
        if is_secret_name(&name) {
            omitted.push(relabel(&destination_path, snapshot_root));
            continue;
        }
        write_file(&source_path, &destination_path)?;
        files.push(file_manifest(&destination_path, snapshot_root)?);
    }
    Ok(())
}

fn write_file(source: &Path, destination: &Path) -> Result<(), BackupError> {
    let bytes = fs::read(source).map_err(|error| io_error(source, error))?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let bytes = if is_text(name, &bytes) {
        scrubber()
            .redact_text(&String::from_utf8_lossy(&bytes))
            .0
            .into_bytes()
    } else {
        bytes
    };
    let mut file = File::create(destination).map_err(|error| io_error(destination, error))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| io_error(destination, error))?;
    Ok(())
}

fn is_text(name: &str, bytes: &[u8]) -> bool {
    let ext = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
    if TEXT_EXTENSIONS
        .iter()
        .any(|known| ext.eq_ignore_ascii_case(known))
    {
        return std::str::from_utf8(bytes).is_ok();
    }
    if BINARY_EXTENSIONS
        .iter()
        .any(|known| ext.eq_ignore_ascii_case(known))
    {
        return false;
    }
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

pub fn is_secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower == "id_rsa"
        || lower == "id_dsa"
        || lower == "id_ecdsa"
        || lower == "id_ed25519"
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower == "credentials"
        || lower.starts_with("credentials.")
}

fn collect_snapshot_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<String>,
) -> Result<(), BackupError> {
    if !directory.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(directory).map_err(|source| io_error(directory, source))?;
    for entry in entries {
        let entry = entry.map_err(|source| io_error(directory, source))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| io_error(&path, source))?;
        if file_type.is_dir() {
            collect_snapshot_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = relabel(&path, root);
            if relative != MANIFEST_FILE {
                files.push(relative);
            }
        } else {
            return Err(BackupError::UnsupportedAttachment { path });
        }
    }
    Ok(())
}

fn file_manifest(path: &Path, root: &Path) -> Result<BackupFile, BackupError> {
    let (sha256, byte_size) = hash_file(path)?;
    Ok(BackupFile {
        path: relabel(path, root),
        sha256,
        byte_size,
    })
}

pub fn hash_file(path: &Path) -> Result<(String, u64), BackupError> {
    let mut file = File::open(path).map_err(|source| io_error(path, source))?;
    let mut digest = Sha256::new();
    let mut byte_size = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|source| io_error(path, source))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        byte_size = byte_size.saturating_add(read as u64);
    }
    Ok((format!("{:x}", digest.finalize()), byte_size))
}

fn relabel(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
}

fn day_and_week(millis: i64) -> Option<((i32, u16), (i32, u8))> {
    // Truncating toward -inf keeps the calendar day: a millisecond never crosses a day boundary on its own.
    let created = OffsetDateTime::from_unix_timestamp(millis.div_euclid(1000)).ok()?;
    let date = created.date();
    let (year, week, _) = date.to_iso_week_date();
    Some(((date.year(), date.ordinal()), (year, week)))
}

pub fn canonicalize_future_path(path: &Path) -> Result<PathBuf, BackupError> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|source| io_error(path, source))?
            .join(path)
    };
    let normalized = normalize_path(&absolute)?;
    let mut existing = normalized.clone();
    let mut missing = Vec::<std::ffi::OsString>::new();
    while !existing.exists() {
        let name = existing.file_name().ok_or_else(|| {
            io_error(
                path,
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "path has no existing ancestor",
                ),
            )
        })?;
        missing.push(name.to_owned());
        existing.pop();
    }
    let mut resolved =
        crate::fs::canonical(&existing).map_err(|source| io_error(&existing, source))?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn normalize_path(path: &Path) -> Result<PathBuf, BackupError> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(io_error(
                        path,
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "path escapes its filesystem root",
                        ),
                    ));
                }
            }
        }
    }
    Ok(normalized)
}

fn paths_same(left: &Path, right: &Path) -> bool {
    match (crate::fs::canonical(left), crate::fs::canonical(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// Delete `target` only when it is a child of `root`.
pub fn guarded_remove(root: &Path, target: &Path) -> Result<(), BackupError> {
    let root = canonicalize_future_path(root)?;
    let target_resolved = canonicalize_future_path(target)?;
    if target_resolved == root || !target_resolved.starts_with(&root) {
        return Err(BackupError::Confined(format!(
            "Refusing to delete {} (it is not inside {}).",
            target.display(),
            root.display()
        )));
    }
    let metadata = fs::symlink_metadata(target).map_err(|source| io_error(target, source))?;
    if metadata.file_type().is_symlink() {
        fs::remove_file(target).map_err(|source| io_error(target, source))?;
    } else if metadata.is_dir() {
        fs::remove_dir_all(target).map_err(|source| io_error(target, source))?;
    } else {
        fs::remove_file(target).map_err(|source| io_error(target, source))?;
    }
    Ok(())
}

fn io_error(path: impl Into<PathBuf>, source: std::io::Error) -> BackupError {
    BackupError::Io {
        path: path.into(),
        source,
    }
}

struct TempSnapshot {
    path: PathBuf,
    committed: bool,
}

impl Drop for TempSnapshot {
    fn drop(&mut self) {
        if self.committed || !self.path.exists() {
            return;
        }
        if let Some(root) = self.path.parent() {
            let _ = guarded_remove(root, &self.path);
        }
    }
}
