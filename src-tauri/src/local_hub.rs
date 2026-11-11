//! The Hub's own local store (WP-04): what the app used to read from Ash OS and still needs (projects, which Monos
//! work on which project, kept Pages, the import marker) lives here, in the app's own database, as one JSON document
//! per key. The webview owns the shapes (`src/features/hub/model/localHub/`); this module only keeps the documents.
//!
//! Own table, made on first use (no numbered migration, so upstream's migration numbers can't collide). It lives in
//! `monocode.db`, so ship's backup and rollback carry it with the chats.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::session_store::{now_millis, SessionStore};

/// A document's largest size: Pages carry their HTML, so allow plenty, but never an unbounded write.
const MAX_DOC: usize = 32 * 1024 * 1024;

/// Sent to every window after a write, so a second window reads the record again (`{key, rev}`).
pub const CHANGED_EVENT: &str = "local-hub://changed";

pub(crate) fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS hub_local_docs (
           key TEXT PRIMARY KEY,
           json TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           rev INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    // A table made before documents had a revision gets one (each write then counts up from there).
    let has_rev = conn
        .prepare("SELECT 1 FROM pragma_table_info('hub_local_docs') WHERE name = 'rev'")?
        .exists([])?;
    if !has_rev {
        conn.execute_batch(
            "ALTER TABLE hub_local_docs ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
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

/// A document and its revision: 0 and no value when nothing was kept under that key yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Doc {
    pub value: Option<Value>,
    pub rev: i64,
}

pub(crate) fn read_doc(conn: &Connection, key: &str) -> Result<Doc, String> {
    check_key(key)?;
    ensure_table(conn).map_err(|e| e.to_string())?;
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT json, rev FROM hub_local_docs WHERE key = ?1",
            params![key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Ok(Doc {
            value: None,
            rev: 0,
        }),
        Some((raw, rev)) => Ok(Doc {
            value: Some(serde_json::from_str(&raw).map_err(|e| format!("{key}: {e}"))?),
            rev,
        }),
    }
}

#[cfg(test)]
pub(crate) fn read(conn: &Connection, key: &str) -> Result<Option<Value>, String> {
    read_doc(conn, key).map(|doc| doc.value)
}

/// Keep a document. With `expect`, only if it is still at that revision (a window that read an older copy must read
/// again instead of overwriting another window's change): `Ok(None)` then, and nothing is written. Returns the new
/// revision. The app has one database connection behind a lock, so the check and the write can't be split.
pub(crate) fn write_if(
    conn: &Connection,
    key: &str,
    value: &Value,
    expect: Option<i64>,
) -> Result<Option<i64>, String> {
    check_key(key)?;
    let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
    if raw.len() > MAX_DOC {
        return Err(format!("{key} is too large to keep ({} bytes).", raw.len()));
    }
    ensure_table(conn).map_err(|e| e.to_string())?;
    let current: i64 = conn
        .query_row(
            "SELECT rev FROM hub_local_docs WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    if expect.is_some_and(|expect| expect != current) {
        return Ok(None);
    }
    let rev = current + 1;
    conn.execute(
        "INSERT INTO hub_local_docs (key, json, updated_at, rev) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, rev = excluded.rev",
        params![key, raw, now_millis(), rev],
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(rev))
}

#[cfg(test)]
pub(crate) fn write(conn: &Connection, key: &str, value: &Value) -> Result<(), String> {
    write_if(conn, key, value, None).map(|_| ())
}

/// `local_hub_read(key)`: the document and its revision (`{value: null, rev: 0}` when nothing was kept yet).
#[tauri::command(async)]
pub fn local_hub_read(store: State<'_, SessionStore>, key: String) -> Result<Doc, String> {
    read_doc(&*store.lock_conn()?, &key)
}

/// `local_hub_write(key, value, expectRev?)`: keep the document, replacing the one before; with `expectRev`, only if
/// no other window changed it since (null back, nothing written). Every window hears `local-hub://changed`.
#[tauri::command(async)]
pub fn local_hub_write<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    key: String,
    value: Value,
    expect_rev: Option<i64>,
) -> Result<Option<i64>, String> {
    let rev = write_if(&*store.lock_conn()?, &key, &value, expect_rev)?;
    if let Some(rev) = rev {
        let _ = app.emit(CHANGED_EVENT, json!({"key": key, "rev": rev}));
        // Team workspaces (off by default): a change to the projects goes to the team's server when the switch is on.
        if key == "projects" {
            crate::team_workspace::sync_after_change(&app);
        }
    }
    Ok(rev)
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
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Couldn't make {}: {e}", folder.display()))?;
    std::fs::write(folder.join("README.md"), format!("# {id}\n"))
        .map_err(|e| format!("Couldn't write its README: {e}"))?;
    // Git is optional: without it the folder is still a project, just not a repo yet.
    let _ = crate::git_cmd::git()
        .args(["init", "-q"])
        .current_dir(&folder)
        .output();
    Ok(folder)
}

/// Absolute folders from the `projects` document. The agent sandbox locks each one's `.git`, not only the chat's
/// folder. A missing document is no folders. A document that is not `{projects: [...]}` or a bare array is an error,
/// so a start does not go on with only the chat folder locked. Each item is untrusted: a null, empty, relative or
/// `..` folder is skipped, and a repeated folder is kept once.
pub(crate) fn project_folders(conn: &Connection) -> Result<Vec<PathBuf>, String> {
    let doc = read_doc(conn, "projects")?;
    let Some(value) = doc.value else {
        return Ok(Vec::new());
    };
    let list = if let Some(projects) = value.get("projects") {
        projects.as_array()
    } else {
        value.as_array()
    };
    let Some(list) = list else {
        return Err("the project list is not a list".into());
    };
    let mut out = Vec::new();
    for item in list {
        let Some(text) = item.get("folder").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = absolute_project_folder(text) else {
            continue;
        };
        if !out.iter().any(|have| have == &path) {
            out.push(path);
        }
    }
    Ok(out)
}

/// An absolute folder with no `..` and no null. Anything else is skipped, not trusted.
fn absolute_project_folder(text: &str) -> Option<PathBuf> {
    if text.is_empty() || text.contains('\0') {
        return None;
    }
    let path = Path::new(text);
    if !path.is_absolute() {
        return None;
    }
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(path.to_path_buf())
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
                &json!({"memberships": [{"monoId": "ed", "projectId": "exo"}]}),
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
            "ed"
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
    fn a_write_from_an_older_copy_is_refused_and_changes_nothing() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        assert_eq!(
            read_doc(&conn, "projects").unwrap(),
            Doc {
                value: None,
                rev: 0
            }
        );
        // Two windows read revision 0; the first one's write lands, the second one's is refused.
        let first = json!({"projects": [{"id": "exo"}]});
        assert_eq!(
            write_if(&conn, "projects", &first, Some(0)).unwrap(),
            Some(1)
        );
        assert_eq!(
            write_if(
                &conn,
                "projects",
                &json!({"projects": [{"id": "nibbii"}]}),
                Some(0)
            )
            .unwrap(),
            None
        );
        assert_eq!(
            read_doc(&conn, "projects").unwrap(),
            Doc {
                value: Some(first),
                rev: 1
            }
        );
        // Read again, write again: it lands on top.
        let both = json!({"projects": [{"id": "exo"}, {"id": "nibbii"}]});
        assert_eq!(
            write_if(&conn, "projects", &both, Some(1)).unwrap(),
            Some(2)
        );
        // Without a revision a write always lands (the import marker).
        assert_eq!(
            write_if(&conn, "ash-os-import", &json!({}), None).unwrap(),
            Some(1)
        );
        assert_eq!(read_doc(&conn, "projects").unwrap().value, Some(both));
    }

    #[test]
    fn project_folders_keep_absolute_paths_and_skip_the_rest() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        assert!(project_folders(&conn).unwrap().is_empty());
        let a = std::env::temp_dir().join("proj-a");
        let b = std::env::temp_dir().join("proj-b");
        let parent = std::env::temp_dir().join("..").join("etc");
        write(
            &conn,
            "projects",
            &json!({"projects": [
                {"folder": a.to_string_lossy()},
                {"folder": a.to_string_lossy()},
                {"folder": null},
                {"folder": "relative"},
                {"folder": parent.to_string_lossy()},
                {"folder": ""},
                {"id": "no-folder"},
                {"folder": b.to_string_lossy()}
            ]}),
        )
        .unwrap();
        assert_eq!(project_folders(&conn).unwrap(), vec![a.clone(), b]);
        write(&conn, "projects", &json!([{"folder": a.to_string_lossy()}])).unwrap();
        assert_eq!(project_folders(&conn).unwrap(), vec![a]);
        write(&conn, "projects", &json!({"projects": "nope"})).unwrap();
        assert!(project_folders(&conn).is_err());
    }

    #[test]
    fn a_table_from_before_revisions_gets_one() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        conn.execute_batch(
            "DROP TABLE IF EXISTS hub_local_docs;
             CREATE TABLE hub_local_docs (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO hub_local_docs VALUES ('projects', '{\"projects\":[]}', 1);",
        )
        .unwrap();
        assert_eq!(read_doc(&conn, "projects").unwrap().rev, 0);
        assert_eq!(
            write_if(
                &conn,
                "projects",
                &json!({"projects": [{"id": "exo"}]}),
                Some(0)
            )
            .unwrap(),
            Some(1)
        );
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
        assert_eq!(
            std::fs::read_to_string(made.join("README.md")).unwrap(),
            "mine"
        );
        for bad in ["", "../x", "Exo", "a/b", "-x"] {
            assert!(make_project_folder(&root, bad).is_err(), "{bad}");
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
