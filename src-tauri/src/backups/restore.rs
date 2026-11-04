// Copyright coollabsio and the Orbit contributors
// SPDX-License-Identifier: Apache-2.0
// Source: https://github.com/coollabsio/orbit crates/platform/src/backup_items.rs
//
// One item comes back as a new row titled "… (restored)"; nothing else in the live
// database changes. Hivra's docs are notes (WP-72), so a doc restore copies a note.
// A full restore stages a ship folder and calls `ship::restore_db` (the same steps
// as the ship runner's `restoreData`). The current database is copied first.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::reader::SnapshotReader;
use super::snapshot::{self, BackupError, Roots, Snapshot, DATABASE_FILE};
use crate::ship::{self, Ship};

pub const RESTORED_SUFFIX: &str = " (restored)";
const ROSTER_FILE: &str = "MONOS.json";
const PENDING_FILE: &str = "pending-restore.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub kind: String,
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingRestore {
    pub ship_dir: PathBuf,
    pub replaced: PathBuf,
    pub snapshot_id: String,
    pub monos_root: PathBuf,
    pub memory_root: PathBuf,
    pub notes_root: PathBuf,
    pub docs_root: PathBuf,
    pub snapshot_path: PathBuf,
    pub data_dir: PathBuf,
    #[serde(default)]
    pub dev: bool,
    #[serde(default)]
    pub failed: bool,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn restored_title(title: &str) -> String {
    format!("{title}{RESTORED_SUFFIX}")
}

/// Verify the snapshot, then list what can be brought back. An unknown `tasks` table is an empty list, not an error.
pub fn items(snapshot: &Snapshot) -> Result<Vec<Item>, BackupError> {
    snapshot::verify_snapshot(snapshot)?;
    let mut items = Vec::new();
    if snapshot.path.join(DATABASE_FILE).is_file() {
        let reader = SnapshotReader::open(snapshot)?;
        items.extend(table_items(&reader, "sessions", "chat", &["id", "title"])?);
        items.extend(note_items(&reader)?);
        items.extend(task_items(&reader)?);
    }
    items.extend(mono_items(snapshot)?);
    Ok(items)
}

fn table_items(
    reader: &SnapshotReader,
    table: &str,
    kind: &str,
    columns: &[&str],
) -> Result<Vec<Item>, BackupError> {
    let Some(available) = reader.columns(table)? else {
        return Ok(Vec::new());
    };
    if !columns
        .iter()
        .all(|column| available.iter().any(|name| name == column))
    {
        return Ok(Vec::new());
    }
    let rows = reader.rows(table, columns, |_| true)?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let id = row.get("id")?.to_owned();
            let title = row.get("title").unwrap_or(&id).to_owned();
            Some(Item {
                kind: kind.to_owned(),
                id,
                title,
            })
        })
        .collect())
}

fn note_items(reader: &SnapshotReader) -> Result<Vec<Item>, BackupError> {
    let Some(available) = reader.columns("notes")? else {
        return Ok(Vec::new());
    };
    let columns: Vec<&str> = ["id", "title", "content_kind"]
        .into_iter()
        .filter(|column| available.iter().any(|name| name == column))
        .collect();
    if !columns.contains(&"id") || !columns.contains(&"title") {
        return Ok(Vec::new());
    }
    let rows = reader.rows("notes", &columns, |row| match row.get("content_kind") {
        Some(kind) => kind == "note" || kind == "doc",
        None => true,
    })?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(Item {
                kind: "doc".into(),
                id: row.get("id")?.to_owned(),
                title: row.get("title").unwrap_or("Doc").to_owned(),
            })
        })
        .collect())
}

fn task_items(reader: &SnapshotReader) -> Result<Vec<Item>, BackupError> {
    let Some(available) = reader.columns("tasks")? else {
        return Ok(Vec::new());
    };
    if !available.iter().any(|name| name == "id") {
        return Ok(Vec::new());
    }
    let columns: Vec<&str> = ["id", "title"]
        .into_iter()
        .filter(|column| available.iter().any(|name| name == *column))
        .collect();
    let rows = reader.rows("tasks", &columns, |_| true)?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let id = row.get("id")?.to_owned();
            Some(Item {
                kind: "task".into(),
                id: id.clone(),
                title: row.get("title").unwrap_or(&id).to_owned(),
            })
        })
        .collect())
}

fn mono_items(snapshot: &Snapshot) -> Result<Vec<Item>, BackupError> {
    let roster = snapshot.path.join("monos").join(ROSTER_FILE);
    if roster.is_file() {
        let text = fs::read_to_string(&roster).map_err(|source| snapshot_io(&roster, source))?;
        if let Ok(doc) = serde_json::from_str::<Value>(&text) {
            if let Some(monos) = doc.get("monos").and_then(Value::as_array) {
                return Ok(monos
                    .iter()
                    .filter_map(|mono| {
                        let id = mono.get("id")?.as_str()?.to_owned();
                        if snapshot::safe_manifest_path(&id).is_err() {
                            return None;
                        }
                        let title = mono
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(&id)
                            .to_owned();
                        Some(Item {
                            kind: "mono".into(),
                            id,
                            title,
                        })
                    })
                    .collect());
            }
        }
    }
    let root = snapshot.path.join("monos");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(&root).map_err(|source| snapshot_io(&root, source))? {
        let entry = entry.map_err(|source| snapshot_io(&root, source))?;
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if snapshot::safe_manifest_path(&id).is_err() {
            continue;
        }
        items.push(Item {
            kind: "mono".into(),
            title: id.clone(),
            id,
        });
    }
    Ok(items)
}

pub fn restore_item(
    roots: &Roots,
    live: &Connection,
    snapshot: &Snapshot,
    kind: &str,
    item_id: &str,
) -> Result<Item, BackupError> {
    snapshot::verify_snapshot(snapshot)?;
    if snapshot::safe_manifest_path(item_id).is_err()
        || item_id.contains('/')
        || item_id.contains('\\')
    {
        return Err(BackupError::UnsafeManifestPath {
            path: item_id.to_owned(),
        });
    }
    match kind {
        "chat" => restore_row(
            live,
            snapshot,
            "sessions",
            item_id,
            "chat",
            &["provider_session_id"],
            None,
        ),
        "doc" => restore_doc(roots, live, snapshot, item_id),
        "task" => restore_task(live, snapshot, item_id),
        "mono" => restore_mono(roots, snapshot, item_id),
        _ => Err(BackupError::Missing(
            "Choose a chat, a Mono, a doc or a task.".into(),
        )),
    }
}

fn restore_doc(
    roots: &Roots,
    live: &Connection,
    snapshot: &Snapshot,
    item_id: &str,
) -> Result<Item, BackupError> {
    let item = restore_row(live, snapshot, "notes", item_id, "doc", &[], Some("slug"))?;
    let reader = SnapshotReader::open(snapshot)?;
    let old_body = reader
        .rows("notes", &["id", "body"], |row| {
            row.get("id") == Some(item_id)
        })?
        .into_iter()
        .next()
        .and_then(|row| row.get("body").map(str::to_owned))
        .unwrap_or_default();
    let new_body = rewrite_assets(snapshot, roots, item_id, &item.id, &old_body)?;
    if reader
        .columns("notes")?
        .is_some_and(|columns| columns.iter().any(|name| name == "body"))
    {
        live.execute(
            "UPDATE notes SET body = ?1 WHERE id = ?2",
            params![new_body, item.id],
        )
        .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
    }
    Ok(item)
}

fn rewrite_assets(
    snapshot: &Snapshot,
    roots: &Roots,
    old_id: &str,
    new_id: &str,
    body: &str,
) -> Result<String, BackupError> {
    let from = snapshot.path.join("notes").join(old_id);
    let to = roots.notes_root.join(new_id);
    if from.is_dir() {
        copy_raw(&from, &to)?;
    }
    Ok(body.replace(
        &format!("/note-assets/{old_id}/"),
        &format!("/note-assets/{new_id}/"),
    ))
}

fn restore_task(
    live: &Connection,
    snapshot: &Snapshot,
    item_id: &str,
) -> Result<Item, BackupError> {
    let reader = SnapshotReader::open(snapshot)?;
    if reader.columns("tasks")?.is_none() {
        return Err(BackupError::Missing("This backup has no tasks.".into()));
    }
    restore_row(live, snapshot, "tasks", item_id, "task", &[], None)
}

fn restore_row(
    live: &Connection,
    snapshot: &Snapshot,
    table: &str,
    item_id: &str,
    kind: &str,
    null_columns: &[&str],
    unique_column: Option<&str>,
) -> Result<Item, BackupError> {
    let reader = SnapshotReader::open(snapshot)?;
    let Some(snapshot_columns) = reader.columns(table)? else {
        return Err(BackupError::Missing(format!("This backup has no {kind}.")));
    };
    let live_columns = live_columns(live, table)?;
    let columns: Vec<String> = snapshot_columns
        .into_iter()
        .filter(|column| live_columns.iter().any(|name| name == column))
        .collect();
    let column_refs: Vec<&str> = columns.iter().map(String::as_str).collect();
    let row = reader
        .rows(table, &column_refs, |row| row.get("id") == Some(item_id))?
        .into_iter()
        .next()
        .ok_or_else(|| BackupError::Missing(format!("That {kind} isn't in this backup.")))?;
    let new_id = uuid::Uuid::new_v4().to_string();
    let old_title = row.get("title").unwrap_or(kind);
    let title = restored_title(old_title);
    let values: Vec<Option<String>> = columns
        .iter()
        .map(|column| {
            if column == "id" {
                Some(new_id.clone())
            } else if column == "title" {
                Some(title.clone())
            } else if null_columns.contains(&column.as_str()) {
                None
            } else if unique_column == Some(column) {
                Some(unique_value(
                    live,
                    table,
                    column,
                    row.get(column).unwrap_or(&new_id),
                ))
            } else {
                row.get(column).map(str::to_owned)
            }
        })
        .collect();
    let placeholders = (1..=columns.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({placeholders})",
        quote(table_name(table)?),
        columns
            .iter()
            .map(|column| quote(column))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let params = rusqlite::params_from_iter(values.iter().map(|value| value.as_deref()));
    live.execute(&sql, params)
        .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
    Ok(Item {
        kind: kind.to_owned(),
        id: new_id,
        title,
    })
}

fn unique_value(live: &Connection, table: &str, column: &str, base: &str) -> String {
    let mut candidate = format!("{base}-restored");
    for n in 2..1000 {
        let sql = format!(
            "SELECT {} FROM {} WHERE {} = ?1",
            quote(column),
            quote(table),
            quote(column)
        );
        let taken: Option<String> = live
            .query_row(&sql, [&candidate], |row| row.get(0))
            .optional()
            .ok()
            .flatten();
        if taken.is_none() {
            return candidate;
        }
        candidate = format!("{base}-restored-{n}");
    }
    candidate
}

fn live_columns(live: &Connection, table: &str) -> Result<Vec<String>, BackupError> {
    let mut statement = live
        .prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")
        .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
    let rows = statement
        .query_map([table], |row| row.get::<_, String>(0))
        .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| BackupError::SnapshotRead(error.to_string()))
}

fn table_name(table: &str) -> Result<&str, BackupError> {
    match table {
        "sessions" | "notes" | "tasks" => Ok(table),
        _ => Err(BackupError::Missing(
            "Choose a chat, a Mono, a doc or a task.".into(),
        )),
    }
}

fn restore_mono(roots: &Roots, snapshot: &Snapshot, item_id: &str) -> Result<Item, BackupError> {
    let from = snapshot.path.join("monos").join(item_id);
    if !from.is_dir() {
        return Err(BackupError::Missing(
            "That Mono isn't in this backup.".into(),
        ));
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    let to = roots.monos_root.join(&new_id);
    copy_raw(&from, &to)?;
    rewrite_soul(&to.join("SOUL.md"), item_id, &new_id)?;
    let name = roster_name(snapshot, item_id).unwrap_or_else(|| item_id.to_owned());
    let title = restored_title(&name);
    let mut entry = roster_entry(snapshot, item_id).unwrap_or_else(|| json!({ "id": item_id }));
    if let Some(object) = entry.as_object_mut() {
        object.insert("id".into(), json!(new_id));
        object.insert("name".into(), json!(title));
        object.remove("sessionId");
    }
    cas_roster(&roots.monos_root.join(ROSTER_FILE), entry)?;
    Ok(Item {
        kind: "mono".into(),
        id: new_id,
        title,
    })
}

fn roster_entry(snapshot: &Snapshot, item_id: &str) -> Option<Value> {
    let text = fs::read_to_string(snapshot.path.join("monos").join(ROSTER_FILE)).ok()?;
    let doc: Value = serde_json::from_str(&text).ok()?;
    doc.get("monos")?
        .as_array()?
        .iter()
        .find(|mono| mono.get("id").and_then(Value::as_str) == Some(item_id))
        .cloned()
}

fn roster_name(snapshot: &Snapshot, item_id: &str) -> Option<String> {
    roster_entry(snapshot, item_id)?
        .get("name")?
        .as_str()
        .map(str::to_owned)
}

/// Replace a whole `ASH_MONO_ID=<old>` line. The rest of the soul stays as it was.
fn rewrite_soul(path: &Path, old_id: &str, new_id: &str) -> Result<(), BackupError> {
    if !path.is_file() {
        return Ok(());
    }
    let text = fs::read_to_string(path).map_err(|source| snapshot_io(path, source))?;
    let needle = format!("ASH_MONO_ID={old_id}");
    let replacement = format!("ASH_MONO_ID={new_id}");
    let mut changed = false;
    let rewritten: String = text
        .split_inclusive('\n')
        .map(|line| {
            let bare = line.trim_end_matches(['\n', '\r']);
            if bare == needle {
                changed = true;
                format!("{replacement}{}", &line[bare.len()..])
            } else {
                line.to_owned()
            }
        })
        .collect();
    if changed {
        fs::write(path, rewritten).map_err(|source| snapshot_io(path, source))?;
    }
    Ok(())
}

/// Write the roster only when it still matches what was read. One retry, then a conflict.
pub fn cas_roster(path: &Path, entry: Value) -> Result<(), BackupError> {
    for _ in 0..2 {
        let existed = path.is_file();
        let original = if existed {
            fs::read(path).map_err(|source| snapshot_io(path, source))?
        } else {
            Vec::new()
        };
        let hash = sha256(&original);
        let mut doc: Value = if original.is_empty() {
            json!({ "version": 1, "monos": [] })
        } else {
            serde_json::from_slice(&original).map_err(|error| {
                BackupError::InvalidSnapshot(format!("MONOS.json isn't JSON: {error}"))
            })?
        };
        let object = doc
            .as_object_mut()
            .ok_or_else(|| BackupError::InvalidSnapshot("MONOS.json has no Mono list".into()))?;
        let list = object.entry("monos").or_insert_with(|| json!([]));
        let monos = list
            .as_array_mut()
            .ok_or_else(|| BackupError::InvalidSnapshot("MONOS.json has no Mono list".into()))?;
        monos.push(entry.clone());
        let bytes = serde_json::to_vec_pretty(&doc)
            .map_err(|error| BackupError::InvalidSnapshot(error.to_string()))?;
        if replace_if_unchanged(path, existed, &hash, &bytes)? {
            return Ok(());
        }
    }
    Err(BackupError::RosterChanged)
}

/// Replace `path` only when its bytes still hash to `expected` (or it is still missing, when `existed` is false).
pub fn replace_if_unchanged(
    path: &Path,
    existed: bool,
    expected: &str,
    bytes: &[u8],
) -> Result<bool, BackupError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|source| snapshot_io(parent, source))?;
    let tmp = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("roster")
    ));
    {
        let mut file = File::create(&tmp).map_err(|source| snapshot_io(&tmp, source))?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| snapshot_io(&tmp, source))?;
    }
    let current = if path.is_file() {
        fs::read(path).map_err(|source| snapshot_io(path, source))?
    } else {
        Vec::new()
    };
    let still = path.is_file() == existed && sha256(&current) == expected;
    if !still {
        let _ = fs::remove_file(&tmp);
        return Ok(false);
    }
    fs::rename(&tmp, path).map_err(|source| snapshot_io(path, source))?;
    Ok(true)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Copy the live database and Monos first, stage a ship folder, and write `pending-restore.json`. Nothing live is
/// replaced until [`finish_pending`], which calls [`ship::restore_db`].
pub fn stage_full_restore(
    roots: &Roots,
    snapshot: &Snapshot,
) -> Result<PendingRestore, BackupError> {
    snapshot::verify_snapshot(snapshot)?;
    let id = snapshot.id.clone();
    if !snapshot::valid_snapshot_id(&id) {
        return Err(BackupError::NotFound { id });
    }
    let replaced = roots.data_dir.join("backups").join("replaced").join(&id);
    fs::create_dir_all(&replaced).map_err(|source| snapshot_io(&replaced, source))?;
    if roots.db_path.is_file() {
        vacuum_copy(&roots.db_path, &replaced.join("monocode.db"))?;
    }
    copy_if(&roots.monos_root, &replaced.join("monos"))?;
    copy_if(&roots.memory_root, &replaced.join("memory"))?;
    copy_if(&roots.notes_root, &replaced.join("notes"))?;
    copy_if(&roots.docs_root, &replaced.join("docs"))?;

    let ship_dir = roots.data_dir.join(ship::SHIP_DIR).join(&id);
    let backup = ship_dir.join(ship::BACKUP_DIR);
    fs::create_dir_all(&backup).map_err(|source| snapshot_io(&backup, source))?;
    let database = snapshot.path.join(DATABASE_FILE);
    if !database.is_file() {
        return Err(BackupError::InvalidSnapshot(
            "the snapshot has no database".into(),
        ));
    }
    let mut sums = serde_json::Map::new();
    let to = backup.join("monocode.db");
    fs::copy(&database, &to).map_err(|source| snapshot_io(&to, source))?;
    let (sum, _) = snapshot::hash_file(&to)?;
    sums.insert("monocode.db".into(), json!(sum));
    let saved_monos = snapshot.path.join("monos");
    if saved_monos.is_dir() {
        copy_raw(&saved_monos, &backup.join(ship::MONOS))?;
    }
    let doc = json!({
        "id": id,
        "dataDir": roots.data_dir,
        "db": { "backup": sums },
    });
    let state = ship_dir.join(ship::STATE);
    fs::write(
        &state,
        serde_json::to_vec_pretty(&doc)
            .map_err(|error| BackupError::InvalidSnapshot(error.to_string()))?,
    )
    .map_err(|source| snapshot_io(&state, source))?;

    let pending = PendingRestore {
        ship_dir,
        replaced,
        snapshot_id: id,
        monos_root: roots.monos_root.clone(),
        memory_root: roots.memory_root.clone(),
        notes_root: roots.notes_root.clone(),
        docs_root: roots.docs_root.clone(),
        snapshot_path: snapshot.path.clone(),
        data_dir: roots.data_dir.clone(),
        dev: roots.dev,
        failed: false,
        error: None,
    };
    write_pending(&roots.data_dir, &pending)?;
    Ok(pending)
}

fn vacuum_copy(db: &Path, destination: &Path) -> Result<(), BackupError> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|source| snapshot_io(parent, source))?;
    }
    let conn =
        Connection::open(db).map_err(|error| BackupError::OnlineBackup(error.to_string()))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(30));
    conn.execute(
        "VACUUM INTO ?1",
        [destination.to_string_lossy().to_string()],
    )
    .map(|_| ())
    .map_err(|error| BackupError::OnlineBackup(error.to_string()))
}

/// Finish a staged restore. The database and `<data>/monos` go through [`ship::restore_db`]. A Monos folder that lives
/// somewhere else (the daily app's `~/agent-memory/monos`, which the ship path does not swap) is swapped afterwards.
/// On failure the pending file is marked failed so the next start doesn't try forever.
pub fn finish_pending(data_dir: &Path) -> Result<bool, String> {
    let path = pending_path(data_dir);
    if !path.is_file() {
        return Ok(false);
    }
    let pending = read_pending(&path)?;
    if pending.failed {
        return Ok(false);
    }
    if !inside(data_dir, &pending.ship_dir) || !inside(data_dir, &pending.replaced) {
        mark_failed(
            &path,
            &pending,
            "the staged restore points outside the data folder",
        );
        return Err("The staged restore points outside the data folder.".into());
    }
    match finish(&pending) {
        Ok(()) => {
            let _ = fs::remove_file(&path);
            Ok(true)
        }
        Err(error) => {
            mark_failed(&path, &pending, &error);
            Err(error)
        }
    }
}

fn finish(pending: &PendingRestore) -> Result<(), String> {
    let ship = Ship::load(&pending.ship_dir)?;
    ship::restore_db(&ship)?;
    // Memory is installed before Monos: the daily memory folder contains the Monos folder, and the snapshot's
    // memory tree leaves that child out. Putting Monos back afterwards puts them in the restored memory folder.
    install_checked(
        pending,
        &pending.snapshot_path.join("memory"),
        &pending.memory_root,
        "displaced-memory",
    )?;
    install_checked(
        pending,
        &pending.snapshot_path.join("notes"),
        &pending.notes_root,
        "displaced-notes",
    )?;
    install_checked(
        pending,
        &pending.snapshot_path.join("docs"),
        &pending.docs_root,
        "displaced-docs",
    )?;
    let data_monos = ship.data_dir().join(ship::MONOS);
    if pending.monos_root != data_monos {
        install_checked(
            pending,
            &pending.snapshot_path.join("monos"),
            &pending.monos_root,
            "displaced-monos",
        )?;
    }
    Ok(())
}

fn install_checked(
    pending: &PendingRestore,
    source: &Path,
    live: &Path,
    aside_name: &str,
) -> Result<(), String> {
    if pending.dev && !inside(&pending.data_dir, live) {
        return Err("A dev copy never restores into a folder outside its own.".into());
    }
    install_tree(source, live, &pending.replaced.join(aside_name))
}

/// Put `source` in place of `live` when the snapshot has that tree. The earlier copy in `replaced/` is left as it is.
fn install_tree(source: &Path, live: &Path, aside: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    if live.exists() {
        if let Some(parent) = aside.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if aside.exists() {
            fs::remove_dir_all(aside).map_err(|error| error.to_string())?;
        }
        fs::rename(live, aside)
            .map_err(|error| format!("Couldn't move {} aside: {error}", live.display()))?;
    }
    if let Some(parent) = live.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    copy_raw(source, live).map_err(|error| error.to_string())
}

fn inside(root: &Path, path: &Path) -> bool {
    match (
        snapshot::canonicalize_future_path(root),
        snapshot::canonicalize_future_path(path),
    ) {
        (Ok(root), Ok(path)) => path == root || path.starts_with(&root),
        _ => false,
    }
}

pub fn pending_path(data_dir: &Path) -> PathBuf {
    data_dir.join("backups").join(PENDING_FILE)
}

fn write_pending(data_dir: &Path, pending: &PendingRestore) -> Result<(), BackupError> {
    let path = pending_path(data_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| snapshot_io(parent, source))?;
    }
    let bytes = serde_json::to_vec_pretty(pending)
        .map_err(|error| BackupError::InvalidSnapshot(error.to_string()))?;
    fs::write(&path, bytes).map_err(|source| snapshot_io(&path, source))
}

fn read_pending(path: &Path) -> Result<PendingRestore, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("The staged restore isn't readable: {error}"))
}

fn mark_failed(path: &Path, pending: &PendingRestore, message: &str) {
    let mut failed = pending.clone();
    failed.failed = true;
    failed.error = Some(message.to_owned());
    if let Ok(bytes) = serde_json::to_vec_pretty(&failed) {
        let _ = fs::write(path, bytes);
    }
}

fn copy_if(from: &Path, to: &Path) -> Result<(), BackupError> {
    if from.exists() {
        copy_raw(from, to)?;
    }
    Ok(())
}

fn copy_raw(from: &Path, to: &Path) -> Result<(), BackupError> {
    let meta = fs::symlink_metadata(from).map_err(|source| snapshot_io(from, source))?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_file() {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|source| snapshot_io(parent, source))?;
        }
        fs::copy(from, to)
            .map(|_| ())
            .map_err(|source| snapshot_io(to, source))?;
        return Ok(());
    }
    fs::create_dir_all(to).map_err(|source| snapshot_io(to, source))?;
    let entries = fs::read_dir(from).map_err(|source| snapshot_io(from, source))?;
    for entry in entries {
        let entry = entry.map_err(|source| snapshot_io(from, source))?;
        let kind = entry
            .file_type()
            .map_err(|source| snapshot_io(&entry.path(), source))?;
        if kind.is_symlink() {
            continue;
        }
        copy_raw(&entry.path(), &to.join(entry.file_name()))?;
    }
    Ok(())
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn snapshot_io(path: &Path, source: std::io::Error) -> BackupError {
    BackupError::Io {
        path: path.to_path_buf(),
        source,
    }
}
