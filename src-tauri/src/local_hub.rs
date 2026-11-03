//! The Hub's own local store (WP-04): what the app used to read from Ash OS and still needs (projects, which Monos
//! work on which project, kept Pages, the import marker) lives here, in the app's own database, as one JSON document
//! per key. The webview owns the shapes (`src/features/hub/model/localHub/`); this module only keeps the documents.
//!
//! Own table, made on first use (no numbered migration, so upstream's migration numbers can't collide). It lives in
//! `monocode.db`, so ship's backup and rollback carry it with the chats.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tauri::State;

use crate::session_store::{now_millis, SessionStore};

/// A document's largest size: Pages carry their HTML, so allow plenty, but never an unbounded write.
const MAX_DOC: usize = 32 * 1024 * 1024;

pub(crate) fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS hub_local_docs (
           key TEXT PRIMARY KEY,
           json TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )
}

fn check_key(key: &str) -> Result<(), String> {
    let tidy = !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if tidy {
        Ok(())
    } else {
        Err(format!("Not a local hub key: {key:?}"))
    }
}

pub(crate) fn read(conn: &Connection, key: &str) -> Result<Option<Value>, String> {
    check_key(key)?;
    ensure_table(conn).map_err(|e| e.to_string())?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT json FROM hub_local_docs WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|e| format!("{key}: {e}")))
        .transpose()
}

pub(crate) fn write(conn: &Connection, key: &str, value: &Value) -> Result<(), String> {
    check_key(key)?;
    let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
    if raw.len() > MAX_DOC {
        return Err(format!("{key} is too large to keep ({} bytes).", raw.len()));
    }
    ensure_table(conn).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO hub_local_docs (key, json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![key, raw, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// `local_hub_read(key)`: the document, or null when nothing was kept under that key yet.
#[tauri::command(async)]
pub fn local_hub_read(
    store: State<'_, SessionStore>,
    key: String,
) -> Result<Option<Value>, String> {
    read(&*store.lock_conn()?, &key)
}

/// `local_hub_write(key, value)`: keep the document, replacing the one before.
#[tauri::command(async)]
pub fn local_hub_write(
    store: State<'_, SessionStore>,
    key: String,
    value: Value,
) -> Result<(), String> {
    write(&*store.lock_conn()?, &key, &value)
}

/// A new project's code folder, `<projects>/<id>`: a local git repo with a README, never pushed. A folder already there
/// is adopted as it is (never emptied or overwritten). Returns the folder.
pub(crate) fn make_project_folder(projects: &Path, id: &str) -> Result<PathBuf, String> {
    let tidy = !id.is_empty()
        && id.len() <= 48
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !tidy {
        return Err("A project id is lowercase letters, digits and dashes.".into());
    }
    let folder = projects.join(id);
    if folder.exists() {
        return Ok(folder);
    }
    std::fs::create_dir_all(&folder).map_err(|e| format!("Couldn't make {}: {e}", folder.display()))?;
    std::fs::write(folder.join("README.md"), format!("# {id}\n"))
        .map_err(|e| format!("Couldn't write its README: {e}"))?;
    // Git is optional: without it the folder is still a project, just not a repo yet.
    let _ = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&folder)
        .output();
    Ok(folder)
}

/// `local_hub_make_folder(id)`: `~/Projects/<id>` for a new project (see [`make_project_folder`]).
#[tauri::command(async)]
pub fn local_hub_make_folder(id: String) -> Result<String, String> {
    let home = crate::fs::expand_home("~");
    let folder = make_project_folder(&home.join("Projects"), &id)?;
    Ok(folder.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_db() -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("local-hub-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("monocode.db");
        (dir, db)
    }

    #[test]
    fn documents_survive_reopening_the_database() {
        let (dir, db) = temp_db();
        {
            let store = SessionStore::open(db.clone()).unwrap();
            let conn = store.lock_conn().unwrap();
            assert_eq!(read(&conn, "projects").unwrap(), None);
            write(
                &conn,
                "projects",
                &json!({"projects": [{"id": "exo", "name": "EXO"}]}),
            )
            .unwrap();
            write(
                &conn,
                "memberships",
                &json!({"memberships": [{"monoId": "frank", "projectId": "exo"}]}),
            )
            .unwrap();
            write(
                &conn,
                "pages",
                &json!({"pages": [{"id": "pg-1", "state": "kept"}]}),
            )
            .unwrap();
            write(
                &conn,
                "projects",
                &json!({"projects": [{"id": "exo", "name": "EXO game"}]}),
            )
            .unwrap();
        }
        // A restart: a fresh store on the same file.
        let store = SessionStore::open(db).unwrap();
        let conn = store.lock_conn().unwrap();
        assert_eq!(
            read(&conn, "projects").unwrap(),
            Some(json!({"projects": [{"id": "exo", "name": "EXO game"}]}))
        );
        assert_eq!(
            read(&conn, "memberships").unwrap().unwrap()["memberships"][0]["monoId"],
            "frank"
        );
        assert_eq!(
            read(&conn, "pages").unwrap().unwrap()["pages"][0]["id"],
            "pg-1"
        );
        drop(conn);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_odd_keys_and_huge_documents() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        assert!(write(&conn, "../etc", &json!({})).is_err());
        assert!(write(&conn, "", &json!({})).is_err());
        assert!(read(&conn, "Projects").is_err());
        let huge = Value::String("x".repeat(MAX_DOC + 1));
        assert!(write(&conn, "pages", &huge).is_err());
        assert_eq!(read(&conn, "pages").unwrap(), None);
    }

    #[test]
    fn a_new_project_folder_is_made_once_and_never_overwritten() {
        let root = std::env::temp_dir().join(format!("local-hub-folders-{}", uuid::Uuid::new_v4()));
        let made = make_project_folder(&root, "exo-game").unwrap();
        assert_eq!(made, root.join("exo-game"));
        assert!(made.join("README.md").is_file());
        std::fs::write(made.join("README.md"), "mine").unwrap();
        assert_eq!(make_project_folder(&root, "exo-game").unwrap(), made);
        assert_eq!(std::fs::read_to_string(made.join("README.md")).unwrap(), "mine");
        for bad in ["", "../x", "Exo", "a/b", "-x"] {
            assert!(make_project_folder(&root, bad).is_err(), "{bad}");
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
