use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::Digest;
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};

use super::restore::{self, replace_if_unchanged};
use super::snapshot::{
    self, BackupError, BackupKind, BackupManifest, Roots, DATABASE_FILE, MANIFEST_FILE,
};
use super::{default_schedule, due, Schedule};
use crate::session_store::{SessionStore, SCHEMA_VERSION};

struct Tmp {
    dir: PathBuf,
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture(label: &str) -> (Tmp, Roots, PathBuf) {
    let dir = std::env::temp_dir().join(format!("hivra-wp75-{label}-{}", uuid::Uuid::new_v4()));
    let data = dir.join("data");
    fs::create_dir_all(data.join("monos")).unwrap();
    fs::create_dir_all(data.join("agent-memory")).unwrap();
    let roots = Roots {
        db_path: data.join("monocode.db"),
        monos_root: data.join("monos"),
        memory_root: data.join("agent-memory"),
        notes_root: data.join("note-assets"),
        docs_root: data.join("docs"),
        daily_data_dir: None,
        protected: Vec::new(),
        data_dir: data,
        dev: false,
    };
    let backup = roots.data_dir.join("backups");
    (Tmp { dir }, roots, backup)
}

fn millis(year: i32, month: Month, day: u8, hour: u8) -> i64 {
    PrimitiveDateTime::new(
        Date::from_calendar_date(year, month, day).unwrap(),
        Time::from_hms(hour, 0, 0).unwrap(),
    )
    .assume_utc()
    .unix_timestamp()
        * 1000
}

fn open_store(path: &Path) -> SessionStore {
    SessionStore::open(path.to_path_buf()).unwrap()
}

/// `cargo test` shares one process. Setting `HOME` is serialized here and put back afterwards, so a test that
/// finishes a restore cannot write the real home. It does not stop some other crate's test from reading `HOME`
/// during that window.
static HOME_LOCK: Mutex<()> = Mutex::new(());

struct TempHome {
    previous_home: Option<std::ffi::OsString>,
    previous_profile: Option<std::ffi::OsString>,
    previous_monos: Option<std::ffi::OsString>,
    previous_memory: Option<std::ffi::OsString>,
    _guard: MutexGuard<'static, ()>,
}

fn temp_home(home: &Path) -> TempHome {
    let guard = HOME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let previous_home = std::env::var_os("HOME");
    // Windows finds the home folder through USERPROFILE before HOME (dirs_home), so set both.
    let previous_profile = std::env::var_os("USERPROFILE");
    let previous_monos = std::env::var_os(crate::mono_home::HOME_ENV);
    let previous_memory = std::env::var_os("MONOCODE_HUB_MEMORY_ROOT");
    std::env::set_var("HOME", home);
    std::env::set_var("USERPROFILE", home);
    std::env::remove_var(crate::mono_home::HOME_ENV);
    std::env::remove_var("MONOCODE_HUB_MEMORY_ROOT");
    TempHome {
        previous_home,
        previous_profile,
        previous_monos,
        previous_memory,
        _guard: guard,
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        restore_env("HOME", &self.previous_home);
        restore_env("USERPROFILE", &self.previous_profile);
        restore_env(crate::mono_home::HOME_ENV, &self.previous_monos);
        restore_env("MONOCODE_HUB_MEMORY_ROOT", &self.previous_memory);
    }
}

fn restore_env(key: &str, previous: &Option<std::ffi::OsString>) {
    match previous {
        Some(value) => std::env::set_var(key, value),
        None => std::env::remove_var(key),
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn mono_snapshot(roots: &Roots, backup: &Path) -> snapshot::Snapshot {
    let mono = roots.monos_root.join("ada");
    fs::create_dir_all(mono.join("memory")).unwrap();
    fs::write(mono.join("SOUL.md"), "name: Ada\nASH_MONO_ID=ada\n").unwrap();
    fs::write(
        roots.monos_root.join("MONOS.json"),
        r#"{"version":1,"monos":[{"id":"ada","name":"Ada"}]}"#,
    )
    .unwrap();
    snapshot::create(roots, backup).unwrap()
}

fn insert_session(conn: &Connection, id: &str, title: &str, blocks: &str) {
    conn.execute(
        "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, blocks_json, created_at, updated_at, provider_session_id)
         VALUES (?1, '/work', 'claude', 'opus', 'code', ?2, ?3, 1, 1, 'live-provider')",
        params![id, title, blocks],
    )
    .unwrap();
}

fn put_manifest(root: &Path, id: &str, at: i64) {
    let dir = root.join(id);
    fs::create_dir_all(&dir).unwrap();
    snapshot::write_manifest(
        &dir,
        &BackupManifest {
            id: id.to_owned(),
            created_at: at,
            kind: BackupKind::Snapshot,
            schema_version: 0,
            application_version: "0".into(),
            files: Vec::new(),
            omitted: Vec::new(),
        },
    )
    .unwrap();
}

#[test]
fn a_backup_verifies_and_a_flipped_byte_does_not() {
    let (_tmp, roots, backup) = fixture("verify");
    fs::write(roots.memory_root.join("note.md"), "hello\n").unwrap();
    let store = open_store(&roots.db_path);
    insert_session(
        &store.lock_conn().unwrap(),
        "chat-1",
        "Ship plan",
        "[\"keep\"]",
    );
    drop(store);

    let snapshot = snapshot::create(&roots, &backup).unwrap();
    snapshot::verify_snapshot(&snapshot).unwrap();
    assert!(snapshot.path.join(MANIFEST_FILE).is_file());
    assert!(snapshot
        .manifest
        .files
        .iter()
        .any(|file| file.path == DATABASE_FILE));
    let listed = snapshot::list(&backup).unwrap();
    assert_eq!(listed.len(), 1);
    assert!(!listed[0]
        .path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with('.'));

    let database = snapshot.path.join(DATABASE_FILE);
    let mut bytes = fs::read(&database).unwrap();
    bytes[0] ^= 0xff;
    fs::write(&database, &bytes).unwrap();
    let again = snapshot::read_snapshot(snapshot.path.clone()).unwrap();
    assert!(matches!(
        snapshot::verify_snapshot(&again),
        Err(BackupError::ChecksumMismatch { .. })
    ));
}

#[test]
fn unsafe_paths_extra_files_and_missing_manifests_are_rejected() {
    let (_tmp, roots, backup) = fixture("inventory");
    fs::create_dir_all(&roots.docs_root).unwrap();
    fs::write(roots.docs_root.join("ü nï.txt"), "ok").unwrap();
    fs::write(roots.docs_root.join("my notes.txt"), "a\r\nb\r\n").unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let notes = fs::read_to_string(snapshot.path.join("docs").join("my notes.txt")).unwrap();
    assert_eq!(notes, "a\r\nb\r\n");
    assert!(snapshot.path.join("docs").join("ü nï.txt").is_file());

    assert!(matches!(
        snapshot::safe_manifest_path("../evil"),
        Err(BackupError::UnsafeManifestPath { .. })
    ));
    assert!(matches!(
        snapshot::find(&backup, "../outside"),
        Err(BackupError::NotFound { .. })
    ));

    let original = snapshot.manifest.clone();
    let mut manifest = original.clone();
    manifest.files[0].path = "../../outside.sqlite".into();
    snapshot::write_manifest(&snapshot.path, &manifest).unwrap();
    assert!(snapshot::verify_dir(&snapshot.path).is_err());

    snapshot::write_manifest(&snapshot.path, &original).unwrap();
    fs::write(snapshot.path.join("extra.txt"), "nope").unwrap();
    assert!(matches!(
        snapshot::verify_dir(&snapshot.path),
        Err(BackupError::InventoryMismatch)
    ));

    fs::create_dir_all(backup.join("not-a-backup")).unwrap();
    fs::create_dir_all(backup.join(".half-written")).unwrap();
    let ids: Vec<_> = snapshot::list(&backup)
        .unwrap()
        .into_iter()
        .map(|item| item.id)
        .collect();
    assert!(ids.contains(&snapshot.id));
    assert!(!ids
        .iter()
        .any(|id| id == "not-a-backup" || id.starts_with('.')));
}

#[test]
fn a_failed_backup_removes_its_hidden_temporary_directory() {
    let (_tmp, mut roots, backup) = fixture("temp");
    fs::create_dir_all(&backup).unwrap();
    let bad = roots.data_dir.join("not-a-database");
    fs::write(&bad, b"this is not a sqlite database").unwrap();
    roots.db_path = bad;
    assert!(snapshot::create(&roots, &backup).is_err());
    let leftovers: Vec<_> = fs::read_dir(&backup)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with('.'))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn retention_keeps_the_newest_day_and_week_buckets() {
    let now = millis(2026, Month::November, 4, 12);
    let mut created = Vec::new();
    let mut day = Date::from_calendar_date(2026, Month::September, 26).unwrap();
    let end = Date::from_calendar_date(2026, Month::November, 4).unwrap();
    while day <= end {
        let at = PrimitiveDateTime::new(day, Time::from_hms(12, 0, 0).unwrap())
            .assume_utc()
            .unix_timestamp()
            * 1000;
        created.push((format!("d{at}"), at));
        day = day.next_day().unwrap();
    }
    let keep = snapshot::retention_ids(&created, now);
    let kept_days: Vec<Date> = keep
        .iter()
        .map(|id| {
            let at = created.iter().find(|(name, _)| name == id).unwrap().1;
            OffsetDateTime::from_unix_timestamp(at.div_euclid(1000))
                .unwrap()
                .date()
        })
        .collect();
    for expected in [
        Date::from_calendar_date(2026, Month::November, 4).unwrap(),
        Date::from_calendar_date(2026, Month::November, 3).unwrap(),
        Date::from_calendar_date(2026, Month::November, 2).unwrap(),
        Date::from_calendar_date(2026, Month::November, 1).unwrap(),
        Date::from_calendar_date(2026, Month::October, 31).unwrap(),
        Date::from_calendar_date(2026, Month::October, 30).unwrap(),
        Date::from_calendar_date(2026, Month::October, 29).unwrap(),
        Date::from_calendar_date(2026, Month::October, 25).unwrap(),
        Date::from_calendar_date(2026, Month::October, 18).unwrap(),
    ] {
        assert!(kept_days.contains(&expected), "missing {expected}");
    }
    for dropped in [
        Date::from_calendar_date(2026, Month::October, 28).unwrap(),
        Date::from_calendar_date(2026, Month::October, 24).unwrap(),
        Date::from_calendar_date(2026, Month::October, 11).unwrap(),
    ] {
        assert!(!kept_days.contains(&dropped), "kept {dropped}");
    }
    assert_eq!(keep.len(), 9);

    let same_day = vec![
        ("a".into(), millis(2026, Month::November, 4, 10)),
        ("b".into(), millis(2026, Month::November, 4, 11)),
        ("c".into(), millis(2026, Month::November, 4, 12)),
    ];
    let kept = snapshot::retention_ids(&same_day, now);
    assert_eq!(kept.len(), 3);

    let mut burst = Vec::new();
    for index in 0..25 {
        burst.push((format!("b{index:02}"), now - i64::from(index) * 60_000));
    }
    let kept = snapshot::retention_ids(&burst, now);
    assert_eq!(kept.len(), 24);
    assert!(!kept.contains("b24"));

    let odd = vec![("old".into(), i64::MIN), ("future".into(), i64::MAX)];
    let kept = snapshot::retention_ids(&odd, now);
    assert!(kept.contains("future"));
    assert!(!kept.contains("old"));
}

#[test]
fn retention_deletes_the_snapshots_it_does_not_keep() {
    let (_tmp, _roots, backup) = fixture("retain");
    fs::create_dir_all(&backup).unwrap();
    let now = millis(2026, Month::November, 4, 12);
    // Seven days plus two older weeks fill both buckets, so 11 October (a fifth week) goes.
    for (id, at) in [
        ("nov-4", millis(2026, Month::November, 4, 12)),
        ("nov-3", millis(2026, Month::November, 3, 12)),
        ("nov-2", millis(2026, Month::November, 2, 12)),
        ("nov-1", millis(2026, Month::November, 1, 12)),
        ("oct-31", millis(2026, Month::October, 31, 12)),
        ("oct-30", millis(2026, Month::October, 30, 12)),
        ("oct-29", millis(2026, Month::October, 29, 12)),
        ("oct-25", millis(2026, Month::October, 25, 12)),
        ("oct-18", millis(2026, Month::October, 18, 12)),
        ("oct-11", millis(2026, Month::October, 11, 12)),
    ] {
        put_manifest(&backup, id, at);
    }
    snapshot::apply_retention(&backup, now).unwrap();
    assert!(backup.join("nov-4").is_dir());
    assert!(backup.join("oct-18").is_dir());
    assert!(!backup.join("oct-11").exists());
}

#[test]
fn online_backup_includes_a_row_that_exists_only_in_the_wal() {
    let (_tmp, roots, backup) = fixture("wal");
    let conn = Connection::open(&roots.db_path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "wal_autocheckpoint", "0").unwrap();
    conn.execute_batch("CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (7);")
        .unwrap();
    let raw = roots.data_dir.join("raw-copy.sqlite");
    fs::copy(&roots.db_path, &raw).unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let copied = Connection::open(snapshot.path.join(DATABASE_FILE)).unwrap();
    let id: i64 = copied
        .query_row("SELECT id FROM t", [], |row| row.get(0))
        .unwrap();
    assert_eq!(id, 7);
    let raw_conn = Connection::open(&raw).unwrap();
    let raw_id = raw_conn.query_row("SELECT id FROM t", [], |row| row.get::<_, i64>(0));
    assert!(raw_id.ok() != Some(7));
    drop(conn);
}

#[test]
fn secrets_are_scrubbed_and_secret_files_are_left_out() {
    let (_tmp, roots, backup) = fixture("secrets");
    let key = "sk-ant-abcdefghijklmnopqrst";
    fs::write(
        roots.memory_root.join("note.md"),
        format!("token {key} end\n"),
    )
    .unwrap();
    fs::write(roots.memory_root.join(".env"), "SECRET=1\n").unwrap();
    fs::create_dir_all(roots.memory_root.join("proj").join(".git")).unwrap();
    fs::write(
        roots.memory_root.join("proj").join(".git").join("config"),
        "secret",
    )
    .unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let text = fs::read_to_string(snapshot.path.join("memory").join("note.md")).unwrap();
    assert!(text.contains("[secret removed]"));
    assert!(!text.contains(key));
    assert!(!snapshot.path.join("memory").join(".env").exists());
    assert!(!snapshot
        .path
        .join("memory")
        .join("proj")
        .join(".git")
        .exists());
    assert!(snapshot
        .manifest
        .omitted
        .iter()
        .any(|path| path.ends_with(".env")));
    snapshot::verify_snapshot(&snapshot).unwrap();
}

#[cfg(unix)]
#[test]
fn a_symlink_is_left_out_instead_of_followed() {
    let (_tmp, roots, backup) = fixture("link");
    let target = roots.data_dir.join("outside.txt");
    fs::write(&target, "outside").unwrap();
    std::os::unix::fs::symlink(&target, roots.memory_root.join("link.txt")).unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    assert!(!snapshot.path.join("memory").join("link.txt").exists());
    assert!(snapshot
        .manifest
        .omitted
        .iter()
        .any(|path| path.ends_with("link.txt")));
    snapshot::verify_snapshot(&snapshot).unwrap();
}

#[test]
fn a_newer_schema_fails_verification_without_touching_the_target() {
    let (_tmp, roots, backup) = fixture("schema");
    fs::write(roots.memory_root.join("note.md"), "x").unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let marker = roots.data_dir.join("marker.txt");
    fs::write(&marker, "untouched").unwrap();
    let mut manifest = snapshot.manifest.clone();
    manifest.schema_version = SCHEMA_VERSION + 1;
    snapshot::write_manifest(&snapshot.path, &manifest).unwrap();
    assert!(matches!(
        snapshot::verify_dir(&snapshot.path),
        Err(BackupError::UnsupportedSchema { found, maximum_supported })
            if found == SCHEMA_VERSION + 1 && maximum_supported == SCHEMA_VERSION
    ));
    assert_eq!(fs::read_to_string(marker).unwrap(), "untouched");
}

#[test]
fn deleting_outside_the_backup_folder_is_refused() {
    let (tmp, _roots, backup) = fixture("delete");
    fs::create_dir_all(&backup).unwrap();
    let outside = tmp.dir.join("outside");
    fs::create_dir(&outside).unwrap();
    assert!(snapshot::guarded_remove(&backup, &outside).is_err());
    assert!(outside.is_dir());
}

#[test]
fn a_chat_a_doc_and_a_task_restore_as_new_items() {
    let (_tmp, roots, backup) = fixture("items");
    let store = open_store(&roots.db_path);
    {
        let conn = store.lock_conn().unwrap();
        insert_session(&conn, "chat-1", "Ship plan", "[\"a\"]");
        insert_session(&conn, "chat-2", "Ship plan", "[\"other\"]");
        crate::notes::ensure_notes_table(&conn).unwrap();
        conn.execute(
            "INSERT INTO notes (id, slug, title, body, tags_json, slug_pending, created_at, updated_at, content_kind)
             VALUES ('n1', 'ship-plan', 'Ship plan', 'see /note-assets/n1/pic.png', '[]', 0, 1, 1, 'doc')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL)",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, title, state) VALUES ('t1', 'File the report', 'open')",
            [],
        )
        .unwrap();
    }
    drop(store);
    fs::create_dir_all(roots.notes_root.join("n1")).unwrap();
    fs::write(roots.notes_root.join("n1").join("pic.png"), [1, 2, 3, 4]).unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();

    let store = open_store(&roots.db_path);
    let conn = store.lock_conn().unwrap();
    let before = conn
        .query_row(
            "SELECT title, blocks_json, provider_session_id FROM sessions WHERE id = 'chat-2'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    let chat = restore::restore_item(&roots, &conn, &snapshot, "chat", "chat-1").unwrap();
    assert_eq!(chat.title, "Ship plan (restored)");
    assert_ne!(chat.id, "chat-1");
    let provider: Option<String> = conn
        .query_row(
            "SELECT provider_session_id FROM sessions WHERE id = ?1",
            [&chat.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(provider.is_none());
    let after = conn
        .query_row(
            "SELECT title, blocks_json, provider_session_id FROM sessions WHERE id = 'chat-2'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(before, after);
    let again = restore::restore_item(&roots, &conn, &snapshot, "chat", "chat-1").unwrap();
    assert_eq!(again.title, "Ship plan (restored)");
    assert_ne!(again.id, chat.id);

    let doc = restore::restore_item(&roots, &conn, &snapshot, "doc", "n1").unwrap();
    assert_eq!(doc.title, "Ship plan (restored)");
    let body: String = conn
        .query_row("SELECT body FROM notes WHERE id = ?1", [&doc.id], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(body.contains(&format!("/note-assets/{}/pic.png", doc.id)));
    assert!(!body.contains("/note-assets/n1/"));
    assert_eq!(
        fs::read(roots.notes_root.join(&doc.id).join("pic.png")).unwrap(),
        vec![1, 2, 3, 4]
    );
    let old_body: String = conn
        .query_row("SELECT body FROM notes WHERE id = 'n1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(old_body.contains("/note-assets/n1/pic.png"));

    let task = restore::restore_item(&roots, &conn, &snapshot, "task", "t1").unwrap();
    assert_eq!(task.title, "File the report (restored)");
    let old_state: String = conn
        .query_row("SELECT state FROM tasks WHERE id = 't1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(old_state, "open");
    let new_state: String = conn
        .query_row("SELECT state FROM tasks WHERE id = ?1", [&task.id], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(new_state, "open");
}

#[test]
fn a_restored_mono_keeps_its_soul_and_memory() {
    let (_tmp, roots, backup) = fixture("mono");
    let mono = roots.monos_root.join("ada");
    fs::create_dir_all(mono.join("memory")).unwrap();
    fs::write(
        mono.join("SOUL.md"),
        "name: Ada\nASH_MONO_ID=ada\nkeep this\n",
    )
    .unwrap();
    fs::write(mono.join("MEMORY.md"), "remembers\n").unwrap();
    fs::write(mono.join("memory").join("fact.md"), "a fact\n").unwrap();
    fs::write(
        roots.monos_root.join("MONOS.json"),
        r#"{"version":1,"monos":[{"id":"ada","name":"Ada","sessionId":"chat-1"}]}"#,
    )
    .unwrap();
    fs::write(roots.memory_root.join("note.md"), "x").unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let store = open_store(&roots.db_path);
    let conn = store.lock_conn().unwrap();
    let restored = restore::restore_item(&roots, &conn, &snapshot, "mono", "ada").unwrap();
    assert_eq!(restored.title, "Ada (restored)");
    let soul = fs::read_to_string(roots.monos_root.join(&restored.id).join("SOUL.md")).unwrap();
    assert!(soul.contains(&format!("ASH_MONO_ID={}", restored.id)));
    assert!(soul.contains("keep this"));
    assert!(!soul.contains("ASH_MONO_ID=ada\n") && !soul.contains("ASH_MONO_ID=ada\r"));
    assert_eq!(
        fs::read_to_string(roots.monos_root.join(&restored.id).join("MEMORY.md")).unwrap(),
        "remembers\n"
    );
    assert_eq!(
        fs::read_to_string(
            roots
                .monos_root
                .join(&restored.id)
                .join("memory")
                .join("fact.md")
        )
        .unwrap(),
        "a fact\n"
    );
    assert_eq!(
        fs::read_to_string(roots.monos_root.join("ada").join("SOUL.md")).unwrap(),
        "name: Ada\nASH_MONO_ID=ada\nkeep this\n"
    );
    let roster: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(roots.monos_root.join("MONOS.json")).unwrap())
            .unwrap();
    let monos = roster["monos"].as_array().unwrap();
    assert_eq!(monos.len(), 2);
    let added = monos.iter().find(|mono| mono["id"] == restored.id).unwrap();
    assert_eq!(added["name"], "Ada (restored)");
    assert!(added.get("sessionId").is_none());
    assert!(monos
        .iter()
        .any(|mono| mono["id"] == "ada" && mono["sessionId"] == "chat-1"));
}

#[test]
fn a_changed_mono_list_is_not_overwritten() {
    let (tmp, _roots, _backup) = fixture("roster");
    let path = tmp.dir.join("MONOS.json");
    fs::write(&path, b"{\"version\":1,\"monos\":[]}").unwrap();
    let hash = format!("{:x}", sha2::Sha256::digest(fs::read(&path).unwrap()));
    fs::write(&path, b"{\"version\":1,\"monos\":[{\"id\":\"other\"}]}").unwrap();
    let wrote = replace_if_unchanged(
        &path,
        true,
        &hash,
        b"{\"version\":1,\"monos\":[{\"id\":\"new\"}]}",
    )
    .unwrap();
    assert!(!wrote);
    assert!(fs::read_to_string(&path).unwrap().contains("other"));
    assert!(!tmp.dir.join(".MONOS.json.tmp").exists());
}

#[test]
fn a_full_restore_puts_the_data_back_and_keeps_a_copy() {
    let (tmp, roots, backup) = fixture("full");
    let _home = temp_home(&tmp.dir);
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "keep-me", "Old", "[]");
    drop(store);
    fs::write(roots.monos_root.join("SOUL.md"), "hello").unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();

    let store = open_store(&roots.db_path);
    {
        let conn = store.lock_conn().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = 'keep-me'", [])
            .unwrap();
        insert_session(&conn, "new-one", "New", "[]");
    }
    drop(store);
    fs::write(roots.monos_root.join("SOUL.md"), "changed").unwrap();

    let pending = restore::stage_full_restore(&roots, &snapshot).unwrap();
    assert!(pending.replaced.join("monocode.db").is_file());
    restore::finish_pending(&roots.data_dir).unwrap();
    let store = open_store(&roots.db_path);
    let conn = store.lock_conn().unwrap();
    let title: String = conn
        .query_row(
            "SELECT title FROM sessions WHERE id = 'keep-me'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(title, "Old");
    let gone =
        conn.query_row::<String, _, _>("SELECT id FROM sessions WHERE id = 'new-one'", [], |row| {
            row.get(0)
        });
    assert!(gone.is_err());
    drop(conn);
    drop(store);
    let replaced = Connection::open(pending.replaced.join("monocode.db")).unwrap();
    let replaced_title: String = replaced
        .query_row(
            "SELECT title FROM sessions WHERE id = 'new-one'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(replaced_title, "New");
    assert_eq!(
        fs::read_to_string(roots.monos_root.join("SOUL.md")).unwrap(),
        "hello"
    );
    assert_eq!(
        fs::read_to_string(pending.replaced.join("monos").join("SOUL.md")).unwrap(),
        "changed"
    );
}

#[test]
fn a_full_restore_puts_monos_back_when_they_live_inside_memory() {
    let (tmp, mut roots, backup) = fixture("nested");
    let _home = temp_home(&tmp.dir);
    let memory = tmp.dir.join("agent-memory");
    let monos = memory.join("monos");
    fs::create_dir_all(&monos).unwrap();
    roots.memory_root = memory.clone();
    roots.monos_root = monos.clone();
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "keep-me", "Old", "[]");
    drop(store);
    fs::write(memory.join("note.md"), "note\n").unwrap();
    fs::write(monos.join("SOUL.md"), "hello\n").unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    assert!(snapshot.path.join("memory").join("note.md").is_file());
    assert!(!snapshot.path.join("memory").join("monos").exists());
    assert_eq!(
        fs::read_to_string(snapshot.path.join("monos").join("SOUL.md")).unwrap(),
        "hello\n"
    );
    fs::write(memory.join("note.md"), "changed\n").unwrap();
    fs::write(monos.join("SOUL.md"), "changed\n").unwrap();
    restore::stage_full_restore(&roots, &snapshot).unwrap();
    restore::finish_pending(&roots.data_dir).unwrap();
    assert_eq!(
        fs::read_to_string(memory.join("note.md")).unwrap(),
        "note\n"
    );
    assert_eq!(
        fs::read_to_string(monos.join("SOUL.md")).unwrap(),
        "hello\n"
    );
}

#[test]
fn a_full_restore_of_a_monos_folder_outside_the_data_folder_puts_it_back() {
    let (tmp, mut roots, backup) = fixture("home");
    let _home = temp_home(&tmp.dir);
    let home = tmp.dir.join("agent-memory").join("monos");
    fs::create_dir_all(&home).unwrap();
    roots.monos_root = home.clone();
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "keep-me", "Old", "[]");
    drop(store);
    fs::write(home.join("SOUL.md"), "hello").unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    fs::write(home.join("SOUL.md"), "changed").unwrap();
    restore::stage_full_restore(&roots, &snapshot).unwrap();
    restore::finish_pending(&roots.data_dir).unwrap();
    assert_eq!(fs::read_to_string(home.join("SOUL.md")).unwrap(), "hello");
}

#[test]
fn a_bad_checksum_refuses_the_restore_and_leaves_the_live_files() {
    let (tmp, roots, backup) = fixture("badsum");
    let _home = temp_home(&tmp.dir);
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "keep-me", "Old", "[]");
    drop(store);
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let store = open_store(&roots.db_path);
    {
        let conn = store.lock_conn().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = 'keep-me'", [])
            .unwrap();
        insert_session(&conn, "new-one", "New", "[]");
    }
    drop(store);
    let pending = restore::stage_full_restore(&roots, &snapshot).unwrap();
    let database = pending.ship_dir.join("backup").join("monocode.db");
    let mut bytes = fs::read(&database).unwrap();
    bytes[0] ^= 0xff;
    fs::write(&database, bytes).unwrap();
    assert!(restore::finish_pending(&roots.data_dir).is_err());
    let store = open_store(&roots.db_path);
    let title: String = store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT title FROM sessions WHERE id = 'new-one'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(title, "New");
    let pending_text = fs::read_to_string(restore::pending_path(&roots.data_dir)).unwrap();
    assert!(pending_text.contains("\"failed\": true"));
}

#[test]
fn dev_copies_stay_off_and_inside_their_own_folder() {
    let (tmp, mut roots, backup) = fixture("dev");
    roots.dev = true;
    assert_eq!(default_schedule(true), Schedule::Off);
    assert!(!due(Schedule::Off, None, 0));
    assert!(!due(Schedule::Off, Some(0), 60 * 60 * 1000));
    assert_eq!(super::load_settings(&roots).schedule, Schedule::Off);
    assert!(due(Schedule::Hourly, None, 0));
    assert!(!due(Schedule::Hourly, Some(1_000), 1_000 + 59 * 60 * 1000));
    assert!(due(Schedule::Hourly, Some(1_000), 1_000 + 60 * 60 * 1000));
    assert!(!due(Schedule::Daily, Some(0), 24 * 60 * 60 * 1000 - 1));
    assert!(due(Schedule::Daily, Some(0), 24 * 60 * 60 * 1000));

    let elsewhere = tmp.dir.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    assert!(snapshot::confine(&roots, &elsewhere).is_err());
    let daily = tmp.dir.join("daily");
    fs::create_dir_all(daily.join("backups")).unwrap();
    roots.daily_data_dir = Some(daily.clone());
    assert!(snapshot::confine(&roots, &daily.join("backups")).is_err());
    assert!(snapshot::confine(&roots, &backup).is_ok());

    fs::write(roots.memory_root.join("note.md"), "slot").unwrap();
    snapshot::create(&roots, &backup).unwrap();
    put_manifest(&daily.join("backups"), "daily-backup", 1);
    assert!(snapshot::list(&backup)
        .unwrap()
        .iter()
        .all(|item| item.id != "daily-backup"));
    assert_eq!(snapshot::list(&daily.join("backups")).unwrap().len(), 1);
    assert!(snapshot::find(&backup, "daily-backup").is_err());
}

#[test]
fn a_second_backup_waits_instead_of_writing_the_same_folder() {
    let (_tmp, _roots, backup) = fixture("lock");
    fs::create_dir_all(&backup).unwrap();
    let held = super::try_lock(&backup).unwrap();
    assert!(matches!(super::try_lock(&backup), Err(BackupError::Busy)));
    drop(held);
    assert!(super::try_lock(&backup).is_ok());
}

#[cfg(unix)]
#[test]
fn a_lock_left_by_a_dead_process_can_be_taken() {
    let (_tmp, _roots, backup) = fixture("stale");
    fs::create_dir_all(&backup).unwrap();
    fs::write(backup.join(".lock"), "{\"pid\":99999999,\"at\":0}").unwrap();
    assert!(super::try_lock(&backup).is_ok());
}

#[test]
fn a_failed_backup_does_not_move_the_last_good_time() {
    let (_tmp, mut roots, backup) = fixture("lastgood");
    fs::write(roots.memory_root.join("note.md"), "x").unwrap();
    let store = open_store(&roots.db_path);
    drop(store);
    super::run_backup(&roots, &backup).unwrap();
    let at = super::load_state(&roots.data_dir)
        .last_good
        .unwrap()
        .created_at;
    let held = super::try_lock(&backup).unwrap();
    assert!(matches!(
        super::run_backup(&roots, &backup),
        Err(BackupError::Busy)
    ));
    drop(held);
    assert_eq!(
        super::load_state(&roots.data_dir)
            .last_good
            .unwrap()
            .created_at,
        at
    );
    let bad = roots.data_dir.join("not-a-database");
    fs::write(&bad, b"this is not a sqlite database").unwrap();
    roots.db_path = bad;
    assert!(super::run_backup(&roots, &backup).is_err());
    assert_eq!(
        super::load_state(&roots.data_dir)
            .last_good
            .unwrap()
            .created_at,
        at
    );
}

#[test]
fn a_dev_copy_does_not_restore_a_mono_folder_outside_its_own() {
    let (tmp, mut roots, backup) = fixture("devout");
    let _home = temp_home(&tmp.dir);
    roots.dev = true;
    let outside = tmp.dir.join("outside-monos");
    fs::create_dir_all(&outside).unwrap();
    roots.monos_root = outside.clone();
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "keep-me", "Old", "[]");
    drop(store);
    fs::write(outside.join("SOUL.md"), "hello").unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    fs::write(outside.join("SOUL.md"), "mine").unwrap();
    restore::stage_full_restore(&roots, &snapshot).unwrap();
    let _ = restore::finish_pending(&roots.data_dir);
    assert_eq!(fs::read_to_string(outside.join("SOUL.md")).unwrap(), "mine");
    assert_eq!(
        fs::read_to_string(tmp.dir.join("agent-memory").join("monos").join("SOUL.md")).unwrap(),
        "hello"
    );
}

#[test]
fn the_backup_folder_cannot_overlap_a_tree_it_copies() {
    let (_tmp, roots, _backup) = fixture("overlap");
    assert!(matches!(
        snapshot::create(&roots, &roots.monos_root),
        Err(BackupError::PathOverlap { .. })
    ));
}

#[test]
fn a_backup_with_no_tasks_table_says_so() {
    let (_tmp, roots, backup) = fixture("notasks");
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "chat-1", "Hi", "[]");
    drop(store);
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let store = open_store(&roots.db_path);
    let err = restore::restore_item(&roots, &store.lock_conn().unwrap(), &snapshot, "task", "t1")
        .unwrap_err();
    assert!(matches!(err, BackupError::Missing(_)));
}

#[test]
fn a_row_committed_after_staging_is_in_the_kept_copy() {
    let (tmp, roots, backup) = fixture("walkeep");
    let _home = temp_home(&tmp.dir);
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "keep-me", "Old", "[]");
    drop(store);
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let pending = restore::stage_full_restore(&roots, &snapshot).unwrap();
    {
        let conn = Connection::open(&roots.db_path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        insert_session(&conn, "after-stage", "After", "[]");
    }
    restore::finish_pending(&roots.data_dir).unwrap();
    let kept = Connection::open(pending.replaced.join("monocode.db")).unwrap();
    let kept_title: String = kept
        .query_row(
            "SELECT title FROM sessions WHERE id = 'after-stage'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kept_title, "After");
    let store = open_store(&roots.db_path);
    let conn = store.lock_conn().unwrap();
    let old: String = conn
        .query_row(
            "SELECT title FROM sessions WHERE id = 'keep-me'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old, "Old");
    let gone = conn.query_row::<String, _, _>(
        "SELECT id FROM sessions WHERE id = 'after-stage'",
        [],
        |row| row.get(0),
    );
    assert!(gone.is_err());
}

#[test]
fn a_failed_helper_does_not_restore_on_the_next_start() {
    let (tmp, roots, backup) = fixture("spawnfail");
    let _home = temp_home(&tmp.dir);
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "keep-me", "Old", "[]");
    drop(store);
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let started =
        restore::arm_full_restore(
            &roots,
            &snapshot,
            |_| Err("the helper did not start".into()),
        );
    assert!(started.is_err());
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "still-here", "Live", "[]");
    drop(store);
    assert!(
        !restore::finish_pending(&roots.data_dir).unwrap(),
        "a helper that never started must not restore on the next launch"
    );
    let store = open_store(&roots.db_path);
    let title: String = store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT title FROM sessions WHERE id = 'still-here'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(title, "Live");
    let pending = restore::pending_path(&roots.data_dir);
    if pending.is_file() {
        let text = fs::read_to_string(&pending).unwrap();
        assert!(text.contains("\"failed\": true"), "{text}");
    }
}

#[test]
fn a_tampered_pending_file_cannot_move_a_folder_outside() {
    let (tmp, roots, backup) = fixture("tamper");
    let _home = temp_home(&tmp.dir);
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "keep-me", "Old", "[]");
    drop(store);
    fs::write(roots.memory_root.join("note.md"), "note\n").unwrap();
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let mut pending = restore::stage_full_restore(&roots, &snapshot).unwrap();
    let stolen = tmp.dir.join("stolen-memory");
    fs::create_dir_all(&stolen).unwrap();
    fs::write(stolen.join("keep.txt"), "mine").unwrap();
    pending.memory_root = stolen.clone();
    pending.monos_root = stolen.join("monos");
    pending.dev = false;
    fs::write(
        restore::pending_path(&roots.data_dir),
        serde_json::to_vec_pretty(&pending).unwrap(),
    )
    .unwrap();
    let _ = restore::finish_pending(&roots.data_dir);
    assert!(stolen.join("keep.txt").is_file());
    assert_eq!(fs::read_to_string(stolen.join("keep.txt")).unwrap(), "mine");
}

#[test]
fn a_ship_record_that_names_another_folder_is_refused() {
    let (tmp, roots, backup) = fixture("shipdir");
    let _home = temp_home(&tmp.dir);
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "keep-me", "Old", "[]");
    drop(store);
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let store = open_store(&roots.db_path);
    insert_session(&store.lock_conn().unwrap(), "new-one", "New", "[]");
    drop(store);
    let pending = restore::stage_full_restore(&roots, &snapshot).unwrap();
    let stolen = tmp.dir.join("stolen-data");
    fs::create_dir_all(&stolen).unwrap();
    fs::write(stolen.join("marker.txt"), "mine").unwrap();
    let state_path = pending.ship_dir.join("state.json");
    let mut doc: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    doc["dataDir"] = Value::String(stolen.to_string_lossy().into_owned());
    fs::write(&state_path, serde_json::to_vec_pretty(&doc).unwrap()).unwrap();
    assert!(restore::finish_pending(&roots.data_dir).is_err());
    assert_eq!(
        fs::read_to_string(stolen.join("marker.txt")).unwrap(),
        "mine"
    );
    assert!(!stolen.join("monocode.db").exists());
    let store = open_store(&roots.db_path);
    let title: String = store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT title FROM sessions WHERE id = 'new-one'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(title, "New");
}

#[test]
fn a_failed_mono_restore_leaves_no_new_folder() {
    let (_tmp, roots, backup) = fixture("halfmono");
    let snapshot = mono_snapshot(&roots, &backup);
    fs::write(roots.monos_root.join("MONOS.json"), b"not json").unwrap();
    let before = names(&roots.monos_root);
    let store = open_store(&roots.db_path);
    let err = restore::restore_item(
        &roots,
        &store.lock_conn().unwrap(),
        &snapshot,
        "mono",
        "ada",
    );
    assert!(err.is_err());
    assert_eq!(names(&roots.monos_root), before);
}

#[test]
fn a_held_roster_lock_is_not_written_over() {
    let (_tmp, roots, backup) = fixture("rosterlock");
    let snapshot = mono_snapshot(&roots, &backup);
    let roster = roots.monos_root.join("MONOS.json");
    let before = fs::read(&roster).unwrap();
    fs::write(
        roots.monos_root.join("MONOS.json.lock"),
        // Fresh as well as ours: Windows judges a lock by its age (stale after two days), not its pid.
        format!(
            "{{\"pid\":{},\"at\":{}}}",
            std::process::id(),
            snapshot::now_millis()
        ),
    )
    .unwrap();
    let listing = names(&roots.monos_root);
    let store = open_store(&roots.db_path);
    let err = restore::restore_item(
        &roots,
        &store.lock_conn().unwrap(),
        &snapshot,
        "mono",
        "ada",
    );
    assert!(err.is_err());
    assert_eq!(fs::read(&roster).unwrap(), before);
    assert_eq!(names(&roots.monos_root), listing);
}

#[cfg(unix)]
#[test]
fn a_roster_lock_left_by_a_dead_process_can_be_taken() {
    let (_tmp, roots, backup) = fixture("rosters tale");
    let snapshot = mono_snapshot(&roots, &backup);
    let lock = roots.monos_root.join("MONOS.json.lock");
    fs::write(&lock, "{\"pid\":99999999,\"at\":0}").unwrap();
    let store = open_store(&roots.db_path);
    let restored = restore::restore_item(
        &roots,
        &store.lock_conn().unwrap(),
        &snapshot,
        "mono",
        "ada",
    )
    .unwrap();
    assert!(!lock.exists());
    assert!(roots
        .monos_root
        .join(&restored.id)
        .join("SOUL.md")
        .is_file());
}

#[cfg(not(unix))]
#[test]
fn a_roster_lock_older_than_two_days_can_be_taken() {
    let (_tmp, roots, backup) = fixture("rosterold");
    let snapshot = mono_snapshot(&roots, &backup);
    let lock = roots.monos_root.join("MONOS.json.lock");
    fs::write(&lock, "{\"pid\":1,\"at\":0}").unwrap();
    let store = open_store(&roots.db_path);
    let restored = restore::restore_item(
        &roots,
        &store.lock_conn().unwrap(),
        &snapshot,
        "mono",
        "ada",
    )
    .unwrap();
    assert!(!lock.exists());
    assert!(roots
        .monos_root
        .join(&restored.id)
        .join("SOUL.md")
        .is_file());
}

#[test]
fn a_database_backup_scrubs_secrets_and_leaves_the_live_row() {
    let (_tmp, roots, backup) = fixture("dbsecret");
    let secret = "sk-ant-abcdefghijklmnopqrst";
    let store = open_store(&roots.db_path);
    insert_session(
        &store.lock_conn().unwrap(),
        "chat-1",
        "Hi",
        &format!("[\"{secret}\"]"),
    );
    drop(store);
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let copy = Connection::open(snapshot.path.join(DATABASE_FILE)).unwrap();
    let blocks: String = copy
        .query_row(
            "SELECT blocks_json FROM sessions WHERE id = 'chat-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(blocks.contains("[secret removed]"), "{blocks}");
    assert!(!blocks.contains(secret), "{blocks}");
    let live = open_store(&roots.db_path);
    let live_blocks: String = live
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT blocks_json FROM sessions WHERE id = 'chat-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(live_blocks.contains(secret));
}

#[test]
fn a_stale_settings_save_does_not_overwrite_a_newer_one() {
    let (_tmp, roots, _backup) = fixture("staleset");
    let path = roots.data_dir.join("backup-settings.json");
    fs::write(&path, b"{\n  \"schedule\": \"daily\"\n}").unwrap();
    let loaded = super::snapshot_settings(&roots);
    assert_eq!(loaded.settings.schedule, Schedule::Daily);
    fs::write(&path, b"{\n  \"schedule\": \"hourly\"\n}").unwrap();
    let mut settings = loaded.settings;
    settings.schedule = Schedule::Off;
    let saved = super::save_settings(&roots, &settings, loaded.existed, &loaded.hash);
    assert!(
        saved.is_err(),
        "a stale save must not replace the newer file"
    );
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("hourly"), "{text}");
    assert!(!text.contains("off"), "{text}");
    assert!(!roots.data_dir.join(".backup-settings.json.tmp").exists());
    assert!(!roots.data_dir.join("backup-settings.json.tmp").exists());
}

#[test]
fn a_deleted_chat_comes_back_as_a_new_row() {
    let (_tmp, roots, backup) = fixture("deleted");
    let store = open_store(&roots.db_path);
    {
        let conn = store.lock_conn().unwrap();
        insert_session(&conn, "keep-me", "Keep", "[]");
        insert_session(&conn, "gone", "Ship plan", "[\"body\"]");
    }
    drop(store);
    let snapshot = snapshot::create(&roots, &backup).unwrap();
    let store = open_store(&roots.db_path);
    store
        .lock_conn()
        .unwrap()
        .execute("DELETE FROM sessions WHERE id = 'gone'", [])
        .unwrap();
    let restored = restore::restore_item(
        &roots,
        &store.lock_conn().unwrap(),
        &snapshot,
        "chat",
        "gone",
    )
    .unwrap();
    assert_eq!(restored.title, "Ship plan (restored)");
    let conn = store.lock_conn().unwrap();
    let (title, provider): (String, Option<String>) = conn
        .query_row(
            "SELECT title, provider_session_id FROM sessions WHERE id = ?1",
            [&restored.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(title, "Ship plan (restored)");
    assert!(provider.is_none());
    let keep: String = conn
        .query_row(
            "SELECT title FROM sessions WHERE id = 'keep-me'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(keep, "Keep");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
    let old_provider: String = conn
        .query_row(
            "SELECT provider_session_id FROM sessions WHERE id = 'keep-me'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old_provider, "live-provider");
}
