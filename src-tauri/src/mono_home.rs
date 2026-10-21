//! Where each Mono lives, and the one-time move there (decided 20 Oct, "Option A").
//!
//! The daily app keeps every Mono in one permanent home beside Ash OS's project memory:
//!
//! ```text
//! ~/agent-memory/monos/
//! ├── MONOS.json            the roster: who each Mono is, its look, engine, projects and chat id
//! ├── .migration.json       written once, when the Monos were copied here from the app's data folder
//! └── <mono id>/
//!     ├── SOUL.md  MEMORY.md  memory/  habits.json   (as before, see mono.rs)
//!     ├── chats.json        its chat id now and the ones it had before
//!     └── soul-template.md  the app's soul template as this Mono last took it (soul refresh compares against it)
//! ```
//!
//! Only the app writes here, through its own commands (mono.rs), and it checks each change before saving
//! ([`check_write`]). Workers may read it but never write: every hub chat's Claude Code session is denied edits under
//! this folder (hubMcp.ts) and their briefs say so. That keeps the intent of the old rule in mono.rs, which kept souls
//! out of repos because anything with full file access could rewrite them.
//!
//! A dev copy (and the bench) never points at the daily home: it keeps its own `monos/` in its own data folder. A
//! throwaway home can be named with `MONOCODE_MONOS_HOME`, so a test can move a copy's Monos without touching Ash's.
//!
//! The move copies; it never moves or deletes. The old folder stays as it was, as a fallback, until Ash says it can go.
//! Nothing here touches the database except [`rename_refs`], which follows a renamed Mono (ash-lead → hub-lead).

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const HOME_ENV: &str = "MONOCODE_MONOS_HOME";
pub const MIGRATION_FILE: &str = ".migration.json";
pub const ROSTER_FILE: &str = "MONOS.json";
pub const CHATS_FILE: &str = "chats.json";
pub const SOUL_TEMPLATE_FILE: &str = "soul-template.md";
const ARCHIVE_DIR: &str = ".archive";
const INDEX_FILE: &str = "index.json";
/// `{ "<old id>": "<new id>" }` for every Mono renamed in this home, so a late read or write that still names the old
/// id lands in the renamed folder instead of making an empty one (the leftover `ash-lead/` beside `hub-lead/`).
pub const RENAMED_FILE: &str = ".renamed.json";

/// The id a renamed Mono has now, if `id` was renamed in this home (followed through later renames).
pub fn renamed_to(root: &Path, id: &str) -> Option<String> {
    let text = std::fs::read_to_string(root.join(RENAMED_FILE)).ok()?;
    let map: std::collections::BTreeMap<String, String> = serde_json::from_str(&text).ok()?;
    let mut current = map.get(id)?.clone();
    for _ in 0..map.len() {
        match map.get(&current) {
            Some(next) if next != id => current = next.clone(),
            _ => break,
        }
    }
    valid_id(&current).then_some(current)
}

fn record_rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let path = root.join(RENAMED_FILE);
    let mut map: std::collections::BTreeMap<String, String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    if map.get(from).map(String::as_str) == Some(to) {
        return Ok(());
    }
    map.remove(to);
    map.insert(from.to_string(), to.to_string());
    let text = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    write_private(&path, text.as_bytes())
}

fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Which folder holds the Monos. A named override wins (the bench, a test); the daily app uses the permanent home;
/// every other copy keeps `monos/` in its own data folder.
pub fn choose_root(
    daily: bool,
    home: Option<&Path>,
    override_root: Option<&Path>,
    data: &Path,
) -> PathBuf {
    if let Some(root) = override_root.filter(|p| p.is_absolute()) {
        return root.to_path_buf();
    }
    match home {
        Some(home) if daily => home.join("agent-memory").join("monos"),
        _ => data.join("monos"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    /// When it ran (the caller's stamp).
    pub at: String,
    /// The folder the Monos were copied from; empty when there was nothing to copy.
    pub from: String,
    /// Mono folder names copied (not `.archive`).
    pub monos: Vec<String>,
    /// Every copied file, relative to the root, with its SHA-256 (checked against the original after copying).
    pub files: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HomeState {
    /// Already moved (or made fresh) before: nothing was done.
    Ready,
    /// Moved now, with this record.
    Migrated(Migration),
}

/// A folder the app made and nothing has written to: an empty MEMORY.md and an empty memory/ at most.
pub fn only_defaults(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return true;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let path = entry.path();
        if name == "MEMORY.md" {
            if std::fs::metadata(&path)
                .map(|m| m.len() > 0)
                .unwrap_or(true)
            {
                return false;
            }
        } else if name == "memory" {
            if std::fs::read_dir(&path)
                .map(|mut it| it.next().is_some())
                .unwrap_or(true)
            {
                return false;
            }
        } else {
            return false;
        }
    }
    true
}

fn copy_tree(
    from: &Path,
    to: &Path,
    rel: &str,
    files: &mut std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    let mut entries: Vec<_> = std::fs::read_dir(from)
        .map_err(|e| format!("{}: {e}", from.display()))?
        .flatten()
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry
            .file_type()
            .map_err(|e| format!("{}: {e}", entry.path().display()))?;
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        // Half-written files from an interrupted save are not part of a Mono.
        if name.ends_with(".tmp") {
            continue;
        }
        if kind.is_dir() {
            copy_tree(&entry.path(), &to.join(&name), &child_rel, files)?;
        } else if kind.is_file() {
            let bytes = std::fs::read(entry.path())
                .map_err(|e| format!("{}: {e}", entry.path().display()))?;
            let dest = to.join(&name);
            write_private(&dest, &bytes)?;
            let back = std::fs::read(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
            let hash = hash_bytes(&bytes);
            if hash_bytes(&back) != hash {
                return Err(format!("the copy of {child_rel} doesn't match it"));
            }
            files.insert(child_rel, hash);
        }
        // Symlinks are skipped: a Mono's files are plain files, and a link could point anywhere.
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
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

/// Makes the home ready, copying the Monos from `old_root` the first time. Copy, check, then switch: everything is
/// copied into a staging folder and checked byte for byte before any of it takes its place, and the record is written
/// last, so an interrupted move simply runs again next launch. A home that already has a Mono with files under the
/// same name stops the move with nothing changed (the caller keeps using the old folder). The old folder is never
/// changed.
pub fn ensure_home(home_root: &Path, old_root: &Path, stamp: &str) -> Result<HomeState, String> {
    let record_path = home_root.join(MIGRATION_FILE);
    if record_path.is_file() {
        return Ok(HomeState::Ready);
    }
    std::fs::create_dir_all(home_root).map_err(|e| format!("{}: {e}", home_root.display()))?;
    let mut sources: Vec<String> = Vec::new();
    if old_root.is_dir() && old_root != home_root {
        for entry in std::fs::read_dir(old_root)
            .map_err(|e| format!("{}: {e}", old_root.display()))?
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if (is_dir && (valid_id(&name) || name == ARCHIVE_DIR))
                || (!is_dir && name == INDEX_FILE)
            {
                sources.push(name);
            }
        }
    }
    sources.sort();
    // Never over a Mono that already lives here.
    for name in &sources {
        let target = home_root.join(name);
        if name == INDEX_FILE || name == ARCHIVE_DIR {
            if target.exists() {
                return Err(format!(
                    "{} already has {name}, so nothing was moved",
                    home_root.display()
                ));
            }
        } else if target.exists() && !only_defaults(&target) {
            return Err(format!(
                "{} already has a Mono called {name} with files, so nothing was moved",
                home_root.display()
            ));
        }
    }
    let staging = home_root.join(format!(".migrating-{stamp}"));
    let _ = std::fs::remove_dir_all(&staging);
    let mut files = std::collections::BTreeMap::new();
    let copied = (|| -> Result<(), String> {
        for name in &sources {
            let from = old_root.join(name);
            if name == INDEX_FILE {
                let bytes = std::fs::read(&from).map_err(|e| format!("{}: {e}", from.display()))?;
                std::fs::create_dir_all(&staging)
                    .map_err(|e| format!("{}: {e}", staging.display()))?;
                write_private(&staging.join(name), &bytes)?;
                files.insert(name.clone(), hash_bytes(&bytes));
            } else {
                copy_tree(&from, &staging.join(name), name, &mut files)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = copied {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    for name in &sources {
        let target = home_root.join(name);
        if target.is_dir() {
            // Checked above: an empty folder the app made, nothing in it.
            std::fs::remove_dir_all(&target).map_err(|e| format!("{}: {e}", target.display()))?;
        }
        std::fs::rename(staging.join(name), &target)
            .map_err(|e| format!("{}: {e}", target.display()))?;
    }
    let _ = std::fs::remove_dir_all(&staging);
    let migration = Migration {
        at: stamp.to_string(),
        from: if sources.is_empty() {
            String::new()
        } else {
            old_root.to_string_lossy().into_owned()
        },
        monos: sources.iter().filter(|n| valid_id(n)).cloned().collect(),
        files,
    };
    let text = serde_json::to_string_pretty(&migration).map_err(|e| e.to_string())?;
    write_private(&record_path, text.as_bytes())?;
    Ok(HomeState::Migrated(migration))
}

/// What the app may save, checked before every write: no NUL bytes, a soul is never blank, and JSON files parse and
/// have the shape the app reads. A rewrite that fails this is refused and the file keeps its last good text.
pub fn check_write(relative: &str, text: &str) -> Result<(), String> {
    if text.contains('\0') {
        return Err(format!("{relative} has a NUL byte, so it wasn't saved"));
    }
    if relative == "SOUL.md" && text.trim().is_empty() {
        return Err("A soul can't be empty, so it wasn't saved".into());
    }
    if relative.ends_with(".json") {
        let value: serde_json::Value = serde_json::from_str(text)
            .map_err(|e| format!("{relative} isn't valid JSON ({e}), so it wasn't saved"))?;
        match relative {
            CHATS_FILE => check_chats(&value)?,
            ROSTER_FILE => check_roster(&value)?,
            "habits.json" if !value.is_array() && !value.is_object() => {
                return Err("habits.json must be a list, so it wasn't saved".into())
            }
            _ => {}
        }
    }
    Ok(())
}

fn check_chats(value: &serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or("chats.json must be an object, so it wasn't saved")?;
    if let Some(main) = object.get("main") {
        if !main.is_string() && !main.is_null() {
            return Err("chats.json: main must be a chat id".into());
        }
    }
    if let Some(history) = object.get("history") {
        let ok = history
            .as_array()
            .map(|list| list.iter().all(|v| v.is_string()))
            .unwrap_or(false);
        if !ok {
            return Err("chats.json: history must be a list of chat ids".into());
        }
    }
    Ok(())
}

fn check_roster(value: &serde_json::Value) -> Result<(), String> {
    let monos = value
        .get("monos")
        .and_then(|m| m.as_array())
        .ok_or("MONOS.json must list its monos, so it wasn't saved")?;
    let mut seen = std::collections::HashSet::new();
    for mono in monos {
        let id = mono.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if !valid_id(id) {
            return Err(format!(
                "MONOS.json: \"{id}\" isn't a Mono id, so it wasn't saved"
            ));
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("MONOS.json lists {id} twice, so it wasn't saved"));
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
    /// The folder moved now (false: it had moved already, or there was none).
    pub moved: bool,
    /// The old soul is kept as `memory/<from>-soul.md`.
    pub kept_soul: bool,
    /// SOUL.md's `ASH_MONO_ID=<from>` now says `<to>`.
    pub soul_updated: bool,
}

/// Renames a Mono's folder (`from` → `to`), keeping its old soul as a topic note (`memory/<from>-soul.md`, when it
/// moves) and pointing the soul's Ash OS identity at the new id. Safe to run again: a folder already moved is left alone. Never
/// over a Mono that already has files under the new name.
pub fn rename_mono_folder(root: &Path, from: &str, to: &str) -> Result<Renamed, String> {
    if !valid_id(from) || !valid_id(to) || from == to {
        return Err("Not a Mono id".into());
    }
    let old = root.join(from);
    let new = root.join(to);
    let mut moved = false;
    if old.is_dir() && new.is_dir() && only_defaults(&old) && !only_defaults(&new) {
        // Already renamed, and something made an empty folder under the old id since: it holds nothing, so it goes.
        std::fs::remove_dir_all(&old).map_err(|e| format!("{}: {e}", old.display()))?;
    }
    if old.is_dir() {
        if new.exists() {
            if !only_defaults(&new) {
                return Err(format!("{to} already has files, so {from} wasn't renamed"));
            }
            std::fs::remove_dir_all(&new).map_err(|e| format!("{}: {e}", new.display()))?;
        }
        std::fs::rename(&old, &new).map_err(|e| format!("{}: {e}", new.display()))?;
        moved = true;
    }
    if new.is_dir() {
        record_rename(root, from, to)?;
    }
    let mut renamed = Renamed {
        moved,
        kept_soul: false,
        soul_updated: false,
    };
    let soul_path = new.join("SOUL.md");
    let Ok(soul) = std::fs::read_to_string(&soul_path) else {
        return Ok(renamed);
    };
    let note = new.join("memory").join(format!("{from}-soul.md"));
    if moved && !note.exists() {
        std::fs::create_dir_all(new.join("memory"))
            .map_err(|e| format!("{}: {e}", new.display()))?;
        write_private(&note, soul.as_bytes())?;
        renamed.kept_soul = true;
    }
    let from_mark = format!("ASH_MONO_ID={from}");
    if !soul.contains(&from_mark) {
        return Ok(renamed);
    }
    let updated = soul.replace(&from_mark, &format!("ASH_MONO_ID={to}"));
    let temp = soul_path.with_extension("md.tmp");
    write_private(&temp, updated.as_bytes())?;
    std::fs::rename(&temp, &soul_path).map_err(|e| format!("{}: {e}", soul_path.display()))?;
    renamed.soul_updated = true;
    Ok(renamed)
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsRenamed {
    pub room_members: usize,
    pub room_origins: usize,
    pub room_messages: usize,
    pub delegations: usize,
    pub chat_binds: usize,
}

fn has_table(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

/// The renamed Mono's rows follow it: its seats in rooms, its room posts and open origins, its open delegations and
/// its chat binds (both re-mirrored to Ash OS, by a version bump). Finished delegations keep the id they ran under:
/// that is history. One transaction; tables a copy doesn't have yet are skipped.
pub fn rename_refs(conn: &mut Connection, from: &str, to: &str) -> Result<RefsRenamed, String> {
    if !valid_id(from) || !valid_id(to) || from == to {
        return Err("Not a Mono id".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut out = RefsRenamed::default();
    let run = |sql: &str| -> Result<usize, String> {
        tx.execute(sql, [from, to]).map_err(|e| e.to_string())
    };
    if has_table(&tx, "room_members").map_err(|e| e.to_string())? {
        out.room_members =
            run("UPDATE OR IGNORE room_members SET mono_id = ?2 WHERE mono_id = ?1")?;
        // Already seated under the new id too: one seat is enough.
        run("DELETE FROM room_members WHERE mono_id = ?1 AND ?2 = ?2")?;
    }
    if has_table(&tx, "room_origins").map_err(|e| e.to_string())? {
        out.room_origins = run("UPDATE room_origins SET mono_id = ?2 WHERE mono_id = ?1")?;
    }
    if has_table(&tx, "room_messages").map_err(|e| e.to_string())? {
        out.room_messages = run("UPDATE room_messages SET author = ?2 WHERE author = ?1")?;
    }
    if has_table(&tx, "delegations").map_err(|e| e.to_string())? {
        out.delegations = run(
            "UPDATE delegations SET owner_mono = ?2, version = version + 1
             WHERE owner_mono = ?1 AND settled_at IS NULL",
        )?;
    }
    if has_table(&tx, "delegation_chat_binds").map_err(|e| e.to_string())? {
        out.chat_binds = run(
            "UPDATE delegation_chat_binds SET mono_id = ?2, version = version + 1 WHERE mono_id = ?1",
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mono-home-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A copy of the live folder as it was on 20 Oct: a lead, CoS with memory and a habit, the archive and index.
    fn live_folder(data: &Path) -> PathBuf {
        let old = data.join("monos");
        write(
            &old.join("chief-of-staff/SOUL.md"),
            "# Soul\n\n## Role\nCoS\n",
        );
        write(
            &old.join("chief-of-staff/MEMORY.md"),
            "- 2026-10-19 · a fact\n",
        );
        write(&old.join("chief-of-staff/memory/hub.md"), "# Hub\n");
        write(
            &old.join("checker/habits.json"),
            "[{\"id\":\"checker-hourly\"}]",
        );
        write(&old.join("checker/SOUL.md"), "You are the Checker");
        write(&old.join("checker/MEMORY.md"), "");
        write(&old.join("ash-lead/SOUL.md"), "ASH_MONO_ID=ash-lead\n");
        write(&old.join("ash-lead/memory/harness-lead-soul.md"), "old");
        write(&old.join(".archive/proof-1/SOUL.md"), "retired");
        write(&old.join("index.json"), "{\"agents\":[]}");
        write(&old.join("chief-of-staff/SOUL.md.tmp"), "half-written");
        old
    }

    #[test]
    fn the_daily_app_lives_in_agent_memory_and_a_dev_copy_never_does() {
        let home = Path::new("/Users/ash");
        let data = Path::new("/Users/ash/Library/Application Support/com.ash.monocode-hub");
        assert_eq!(
            choose_root(true, Some(home), None, data),
            PathBuf::from("/Users/ash/agent-memory/monos")
        );
        let dev = Path::new("/Users/ash/Library/Application Support/com.ash.monocode-hub.dev.x");
        assert_eq!(choose_root(false, Some(home), None, dev), dev.join("monos"));
        // The bench names a throwaway home; a relative one is ignored.
        let throwaway = Path::new("/tmp/bench/monos");
        assert_eq!(
            choose_root(false, Some(home), Some(throwaway), dev),
            throwaway
        );
        assert_eq!(
            choose_root(true, Some(home), Some(Path::new("relative")), data),
            PathBuf::from("/Users/ash/agent-memory/monos")
        );
        assert_eq!(choose_root(true, None, None, data), data.join("monos"));
    }

    #[test]
    fn the_first_launch_copies_every_mono_byte_for_byte_and_leaves_the_old_folder_alone() {
        let data = temp();
        let old = live_folder(&data);
        let home = data.join("agent-memory/monos");
        let before: Vec<_> = walk(&old);
        let HomeState::Migrated(record) = ensure_home(&home, &old, "20261021-0900").unwrap() else {
            panic!("should have migrated");
        };
        assert_eq!(record.monos, vec!["ash-lead", "checker", "chief-of-staff"]);
        assert_eq!(
            std::fs::read_to_string(home.join("chief-of-staff/MEMORY.md")).unwrap(),
            "- 2026-10-19 · a fact\n"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("checker/habits.json")).unwrap(),
            "[{\"id\":\"checker-hourly\"}]"
        );
        assert!(home.join(".archive/proof-1/SOUL.md").is_file());
        assert!(home.join("index.json").is_file());
        assert!(!home.join("chief-of-staff/SOUL.md.tmp").exists());
        assert_eq!(
            record.files.get("chief-of-staff/memory/hub.md"),
            Some(&hash_bytes(b"# Hub\n"))
        );
        // The old folder is exactly as it was.
        assert_eq!(walk(&old), before);
        // No staging folder is left behind, and the record says where they came from.
        assert!(std::fs::read_dir(&home)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().starts_with(".migrating")));
        let saved = std::fs::read_to_string(home.join(MIGRATION_FILE)).unwrap();
        assert!(saved.contains(&old.to_string_lossy().into_owned()));
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn it_moves_once_and_a_later_launch_never_copies_over_newer_files() {
        let data = temp();
        let old = live_folder(&data);
        let home = data.join("agent-memory/monos");
        ensure_home(&home, &old, "1").unwrap();
        write(
            &home.join("chief-of-staff/MEMORY.md"),
            "- learned after the move\n",
        );
        write(&old.join("chief-of-staff/MEMORY.md"), "- stale\n");
        assert_eq!(ensure_home(&home, &old, "2").unwrap(), HomeState::Ready);
        assert_eq!(
            std::fs::read_to_string(home.join("chief-of-staff/MEMORY.md")).unwrap(),
            "- learned after the move\n"
        );
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn a_home_that_already_has_that_mono_stops_the_move_with_nothing_changed() {
        let data = temp();
        let old = live_folder(&data);
        let home = data.join("agent-memory/monos");
        write(&home.join("checker/SOUL.md"), "someone else's checker");
        let error = ensure_home(&home, &old, "1").unwrap_err();
        assert!(error.contains("checker"), "{error}");
        assert!(!home.join(MIGRATION_FILE).exists());
        assert!(!home.join("chief-of-staff").exists());
        assert_eq!(
            std::fs::read_to_string(home.join("checker/SOUL.md")).unwrap(),
            "someone else's checker"
        );
        // An empty folder the app made gives way.
        std::fs::remove_dir_all(home.join("checker")).unwrap();
        std::fs::create_dir_all(home.join("checker/memory")).unwrap();
        write(&home.join("checker/MEMORY.md"), "");
        assert!(matches!(
            ensure_home(&home, &old, "2").unwrap(),
            HomeState::Migrated(_)
        ));
        assert_eq!(
            std::fs::read_to_string(home.join("checker/SOUL.md")).unwrap(),
            "You are the Checker"
        );
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn a_fresh_install_with_nothing_to_move_just_makes_the_home() {
        let data = temp();
        let home = data.join("agent-memory/monos");
        let HomeState::Migrated(record) = ensure_home(&home, &data.join("monos"), "1").unwrap()
        else {
            panic!()
        };
        assert!(record.monos.is_empty());
        assert_eq!(record.from, "");
        assert_eq!(
            ensure_home(&home, &data.join("monos"), "2").unwrap(),
            HomeState::Ready
        );
        std::fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn copied_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let data = temp();
        let old = live_folder(&data);
        let home = data.join("agent-memory/monos");
        ensure_home(&home, &old, "1").unwrap();
        let mode = std::fs::metadata(home.join("chief-of-staff/MEMORY.md"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn every_write_is_checked_before_it_is_saved() {
        assert!(check_write("SOUL.md", "# Soul\n").is_ok());
        assert!(check_write("SOUL.md", "  \n").is_err());
        assert!(check_write("MEMORY.md", "").is_ok());
        assert!(check_write("MEMORY.md", "a\0b").is_err());
        assert!(check_write("habits.json", "[]").is_ok());
        assert!(check_write("habits.json", "[{").is_err());
        assert!(check_write("habits.json", "\"text\"").is_err());
        assert!(check_write(CHATS_FILE, r#"{"main":"df9a","history":["old"]}"#).is_ok());
        assert!(check_write(CHATS_FILE, r#"{"main":3}"#).is_err());
        assert!(check_write(CHATS_FILE, r#"{"history":[1]}"#).is_err());
        assert!(check_write(
            ROSTER_FILE,
            r#"{"monos":[{"id":"frank"},{"id":"hub-lead"}]}"#
        )
        .is_ok());
        assert!(check_write(ROSTER_FILE, r#"{"monos":[{"id":"../x"}]}"#).is_err());
        assert!(check_write(ROSTER_FILE, r#"{"monos":[{"id":"a"},{"id":"a"}]}"#).is_err());
        assert!(check_write(ROSTER_FILE, r#"[]"#).is_err());
    }

    #[test]
    fn renaming_ash_lead_keeps_its_old_soul_in_memory_and_points_its_identity_at_hub_lead() {
        let root = temp();
        let soul = "# Soul\n\nYou are MonoCode Hub lead.\n- ASH_MONO_ID=ash-lead, ASH_ROLE=lead\n";
        write(&root.join("ash-lead/SOUL.md"), soul);
        write(&root.join("ash-lead/MEMORY.md"), "- kept\n");
        write(&root.join("ash-lead/memory/harness-lead-soul.md"), "older");
        write(&root.join("ash-lead/habits.json"), "[]");
        let renamed = rename_mono_folder(&root, "ash-lead", "hub-lead").unwrap();
        assert_eq!(
            renamed,
            Renamed {
                moved: true,
                kept_soul: true,
                soul_updated: true
            }
        );
        assert!(!root.join("ash-lead").exists());
        let new = root.join("hub-lead");
        assert_eq!(
            std::fs::read_to_string(new.join("memory/ash-lead-soul.md")).unwrap(),
            soul
        );
        let now = std::fs::read_to_string(new.join("SOUL.md")).unwrap();
        assert!(now.contains("ASH_MONO_ID=hub-lead"));
        assert!(!now.contains("ash-lead"));
        assert_eq!(
            std::fs::read_to_string(new.join("MEMORY.md")).unwrap(),
            "- kept\n"
        );
        assert_eq!(
            std::fs::read_to_string(new.join("memory/harness-lead-soul.md")).unwrap(),
            "older"
        );
        // Again: nothing to move, nothing rewritten.
        assert_eq!(
            rename_mono_folder(&root, "ash-lead", "hub-lead").unwrap(),
            Renamed {
                moved: false,
                kept_soul: false,
                soul_updated: false
            }
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_soul_without_the_old_identity_is_still_kept_and_left_as_it_is() {
        let root = temp();
        write(&root.join("ash-lead/SOUL.md"), "# Soul\nAsh's own words\n");
        let renamed = rename_mono_folder(&root, "ash-lead", "hub-lead").unwrap();
        assert!(renamed.moved && renamed.kept_soul && !renamed.soul_updated);
        assert_eq!(
            std::fs::read_to_string(root.join("hub-lead/memory/ash-lead-soul.md")).unwrap(),
            "# Soul\nAsh's own words\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("hub-lead/SOUL.md")).unwrap(),
            "# Soul\nAsh's own words\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_rename_never_lands_on_a_mono_that_already_has_files() {
        let root = temp();
        write(&root.join("ash-lead/SOUL.md"), "ASH_MONO_ID=ash-lead");
        write(&root.join("hub-lead/SOUL.md"), "a real hub-lead");
        assert!(rename_mono_folder(&root, "ash-lead", "hub-lead").is_err());
        assert!(root.join("ash-lead/SOUL.md").is_file());
        assert_eq!(
            std::fs::read_to_string(root.join("hub-lead/SOUL.md")).unwrap(),
            "a real hub-lead"
        );
        // An empty one the app made gives way.
        std::fs::remove_dir_all(root.join("hub-lead")).unwrap();
        std::fs::create_dir_all(root.join("hub-lead/memory")).unwrap();
        write(&root.join("hub-lead/MEMORY.md"), "");
        assert!(
            rename_mono_folder(&root, "ash-lead", "hub-lead")
                .unwrap()
                .moved
        );
        assert!(rename_mono_folder(&root, "../x", "hub-lead").is_err());
        assert!(rename_mono_folder(&root, "a", "a").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_renamed_monos_rows_follow_it_but_finished_work_keeps_its_history() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE room_members (room_id TEXT, mono_id TEXT, position INTEGER, added_at INTEGER,
               PRIMARY KEY (room_id, mono_id));
             CREATE TABLE room_origins (child_session TEXT PRIMARY KEY, mono_id TEXT);
             CREATE TABLE room_messages (seq INTEGER PRIMARY KEY, author TEXT);
             CREATE TABLE delegations (id TEXT PRIMARY KEY, owner_mono TEXT, settled_at INTEGER,
               version INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE delegation_chat_binds (provider_session TEXT PRIMARY KEY, mono_id TEXT,
               version INTEGER NOT NULL DEFAULT 1);
             INSERT INTO room_members VALUES ('hub:leadership','ash-lead',0,0),('hub:room','ash-lead',0,0),
               ('hub:room','hub-lead',1,0),('hub:room','frank',2,0);
             INSERT INTO room_origins VALUES ('c1','ash-lead');
             INSERT INTO room_messages VALUES (1,'ash-lead'),(2,'ash');
             INSERT INTO delegations VALUES ('open','ash-lead',NULL,3),('done','ash-lead',100,1);
             INSERT INTO delegation_chat_binds VALUES ('p1','ash-lead',1);",
        )
        .unwrap();
        let counts = rename_refs(&mut conn, "ash-lead", "hub-lead").unwrap();
        assert_eq!(counts.room_origins, 1);
        assert_eq!(counts.room_messages, 1);
        assert_eq!(counts.delegations, 1);
        assert_eq!(counts.chat_binds, 1);
        let seats: Vec<(String, String)> = conn
            .prepare("SELECT room_id, mono_id FROM room_members ORDER BY room_id, position")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            seats,
            vec![
                ("hub:leadership".into(), "hub-lead".into()),
                ("hub:room".into(), "hub-lead".into()),
                ("hub:room".into(), "frank".into()),
            ]
        );
        let open: (String, i64) = conn
            .query_row(
                "SELECT owner_mono, version FROM delegations WHERE id='open'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(open, ("hub-lead".into(), 4));
        let done: String = conn
            .query_row(
                "SELECT owner_mono FROM delegations WHERE id='done'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(done, "ash-lead");
        let author: String = conn
            .query_row("SELECT author FROM room_messages WHERE seq=2", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(author, "ash");
        // A store with none of these tables yet is fine.
        let mut empty = Connection::open_in_memory().unwrap();
        assert_eq!(
            rename_refs(&mut empty, "ash-lead", "hub-lead").unwrap(),
            RefsRenamed::default()
        );
    }

    fn walk(root: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        fn go(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    go(&path, base, out);
                } else {
                    out.push((
                        path.strip_prefix(base)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                        std::fs::read(&path).unwrap(),
                    ));
                }
            }
        }
        go(root, root, &mut out);
        out.sort();
        out
    }
}
