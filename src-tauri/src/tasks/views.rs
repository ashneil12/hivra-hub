//! Saved task views. Orbit's `apps/server/src/repositories/views.rs` (name cleaning, version conflicts,
//! page keys, and a stored state that no longer parses) translated onto rusqlite. Hivra has no
//! workspaces, so a view belongs to a page (`all` or one project) and the default one cannot be removed.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use super::store::{actor_ok, Actor};

const NAME_MAX: usize = 80;
const STATE_MAX: usize = 100_000;
const PAGE_MAX: usize = 1_000;

/// The same object `defaultViewState()` builds in `vendor/views/viewState.ts`.
pub fn default_state() -> Value {
    json!({
        "filter": { "op": "and", "children": [] },
        "display": {
            "layout": "list",
            "group_by": "status",
            "sub_group_by": "none",
            "order_by": "manual",
            "order_direction": "asc",
            "properties": ["id", "status", "assignee", "priority", "project", "due_date", "labels", "sub_issue_progress"],
            "show_completed": "all",
            "show_empty_groups": false,
            "sub_issues": "nested"
        }
    })
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_views (
           id TEXT PRIMARY KEY,
           page_key TEXT NOT NULL,
           name TEXT NOT NULL,
           state TEXT NOT NULL,
           version INTEGER NOT NULL DEFAULT 1,
           builtin INTEGER NOT NULL DEFAULT 0,
           UNIQUE (page_key, name)
         );",
    )
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewRecord {
    pub id: String,
    pub page_key: String,
    pub name: String,
    pub state: Value,
    pub version: i64,
    pub builtin: bool,
    /// The stored JSON could not be read. `state` is the default and the row was left as it was.
    pub fallback: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewSaved {
    pub stale: bool,
    pub view: ViewRecord,
}

pub struct ViewInput {
    pub id: Option<String>,
    pub page_key: String,
    pub name: String,
    pub state: Value,
    pub version: Option<i64>,
}

struct Stored {
    id: String,
    page_key: String,
    name: String,
    state: String,
    version: i64,
    builtin: bool,
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("The name is empty.".into());
    }
    if name.chars().count() > NAME_MAX {
        return Err("The name is too long.".into());
    }
    if name.chars().any(char::is_control) {
        return Err("The name isn't valid.".into());
    }
    Ok(name.to_string())
}

/// `all`, `preset:<name>`, or `project:` plus a project id. A `..` segment is refused; spaces and
/// non-ASCII names are kept.
pub fn page_key_ok(page_key: &str) -> bool {
    if page_key == "all" {
        return true;
    }
    let Some((kind, rest)) = page_key.split_once(':') else {
        return false;
    };
    if rest.is_empty() || rest.chars().any(char::is_control) {
        return false;
    }
    match kind {
        "preset" => {
            matches!(
                rest,
                "mine" | "overdue" | "due_soon" | "current_week" | "my_week"
            )
        }
        "project" => {
            rest.chars().count() <= PAGE_MAX
                && !rest.split(['/', '\\']).any(|segment| segment == "..")
        }
        _ => false,
    }
}

fn check_page(page_key: &str) -> Result<(), String> {
    if page_key_ok(page_key) {
        Ok(())
    } else {
        Err("That page key isn't valid.".into())
    }
}

fn state_ok(state: &Value) -> bool {
    let Some(object) = state.as_object() else {
        return false;
    };
    object.get("filter").and_then(Value::as_object).is_some()
        && object.get("display").and_then(Value::as_object).is_some()
}

fn check_state(state: &Value) -> Result<String, String> {
    if !state_ok(state) {
        return Err("That view can't be read.".into());
    }
    let raw = serde_json::to_string(state).map_err(|_| "That view can't be read.".to_string())?;
    if raw.len() > STATE_MAX {
        return Err("That view can't be read.".into());
    }
    Ok(raw)
}

fn present(row: Stored) -> ViewRecord {
    let (state, fallback) = match serde_json::from_str::<Value>(&row.state) {
        Ok(value) if state_ok(&value) => (value, false),
        _ => (default_state(), true),
    };
    ViewRecord {
        id: row.id,
        page_key: row.page_key,
        name: row.name,
        state,
        version: row.version,
        builtin: row.builtin,
        fallback,
    }
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Stored> {
    Ok(Stored {
        id: row.get(0)?,
        page_key: row.get(1)?,
        name: row.get(2)?,
        state: row.get(3)?,
        version: row.get(4)?,
        builtin: row.get::<_, i64>(5)? != 0,
    })
}

fn load(conn: &Connection, id: &str) -> Result<Option<Stored>, String> {
    conn.query_row(
        "SELECT id, page_key, name, state, version, builtin FROM task_views WHERE id = ?1",
        [id],
        read_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn builtin_id(page_key: &str) -> String {
    format!("default:{page_key}")
}

fn ensure_builtin(conn: &Connection, page_key: &str) -> Result<(), String> {
    let state = serde_json::to_string(&default_state()).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO task_views (id, page_key, name, state, version, builtin)
         VALUES (?1, ?2, 'Tasks', ?3, 1, 1)",
        params![builtin_id(page_key), page_key, state],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn list(conn: &Connection, actor: &Actor, page_key: &str) -> Result<Vec<ViewRecord>, String> {
    actor_ok(actor, false)?;
    check_page(page_key)?;
    ensure_tables(conn).map_err(|error| error.to_string())?;
    ensure_builtin(conn, page_key)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, page_key, name, state, version, builtin FROM task_views
             WHERE page_key = ?1 ORDER BY builtin DESC, name, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([page_key], read_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows.into_iter().map(present).collect())
}

pub fn save(conn: &Connection, actor: &Actor, input: &ViewInput) -> Result<ViewSaved, String> {
    actor_ok(actor, false)?;
    check_page(&input.page_key)?;
    let name = clean_name(&input.name)?;
    let state = check_state(&input.state)?;
    ensure_tables(conn).map_err(|error| error.to_string())?;
    ensure_builtin(conn, &input.page_key)?;
    let Some(id) = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return insert(conn, &input.page_key, &name, &state);
    };
    let Some(current) = load(conn, id)? else {
        return Err("No view with that id.".into());
    };
    if current.page_key != input.page_key {
        return Err("No view with that id.".into());
    }
    if current.builtin && name != current.name {
        return Err("The default view stays.".into());
    }
    let expected = input.version.unwrap_or(current.version);
    let changed = conn
        .execute(
            "UPDATE task_views SET name = ?1, state = ?2, version = version + 1
             WHERE id = ?3 AND version = ?4",
            params![name, state, id, expected],
        )
        .map_err(|error| error.to_string())?;
    let stored = load(conn, id)?.ok_or_else(|| "No view with that id.".to_string())?;
    if changed == 0 {
        return Ok(ViewSaved {
            stale: true,
            view: present(stored),
        });
    }
    Ok(ViewSaved {
        stale: false,
        view: present(stored),
    })
}

fn insert(conn: &Connection, page_key: &str, name: &str, state: &str) -> Result<ViewSaved, String> {
    let id = format!("view-{}", uuid::Uuid::new_v4().simple());
    let inserted = conn.execute(
        "INSERT INTO task_views (id, page_key, name, state, version, builtin) VALUES (?1, ?2, ?3, ?4, 1, 0)",
        params![id, page_key, name, state],
    );
    if let Err(error) = inserted {
        if error.to_string().contains("UNIQUE") {
            return Err("A view with that name is already here.".into());
        }
        return Err(error.to_string());
    }
    let stored = load(conn, &id)?.ok_or_else(|| "No view with that id.".to_string())?;
    Ok(ViewSaved {
        stale: false,
        view: present(stored),
    })
}

pub fn delete(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    version: i64,
) -> Result<ViewSaved, String> {
    actor_ok(actor, false)?;
    ensure_tables(conn).map_err(|error| error.to_string())?;
    let Some(current) = load(conn, id)? else {
        return Err("No view with that id.".into());
    };
    if current.builtin {
        return Err("The default view stays.".into());
    }
    let view = present(current);
    let changed = conn
        .execute(
            "DELETE FROM task_views WHERE id = ?1 AND version = ?2 AND builtin = 0",
            params![id, version],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        let stored = load(conn, id)?.ok_or_else(|| "No view with that id.".to_string())?;
        return Ok(ViewSaved {
            stale: true,
            view: present(stored),
        });
    }
    Ok(ViewSaved { stale: false, view })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::SessionStore;

    fn person() -> Actor {
        Actor {
            id: "person".into(),
            project: "crew".into(),
            kind: "person".into(),
        }
    }

    fn mem() -> SessionStore {
        SessionStore::open_in_memory().unwrap()
    }

    #[test]
    fn page_keys_keep_spaces_and_unicode_and_refuse_a_parent_segment() {
        assert!(page_key_ok("all"));
        assert!(page_key_ok("project:my project"));
        assert!(page_key_ok("project:café"));
        assert!(page_key_ok("preset:mine"));
        assert!(!page_key_ok(""));
        assert!(!page_key_ok("project:"));
        assert!(!page_key_ok("project:../x"));
        assert!(!page_key_ok("project:foo/../bar"));
        assert!(!page_key_ok("project:..\\x"));
        assert!(!page_key_ok("project:a\nb"));
        assert!(!page_key_ok("project:a\r\nb"));
        assert!(!page_key_ok("other:crew"));
        assert!(!page_key_ok(&format!(
            "project:{}",
            "x".repeat(PAGE_MAX + 1)
        )));
    }

    #[test]
    fn the_default_view_is_created_and_cannot_be_renamed_or_deleted() {
        let store = mem();
        let conn = store.lock_conn().unwrap();
        let views = list(&conn, &person(), "project:my project").unwrap();
        assert_eq!(views.len(), 1);
        assert!(views[0].builtin);
        assert_eq!(views[0].name, "Tasks");
        assert_eq!(views[0].state, default_state());
        assert!(!views[0].fallback);
        let again = list(&conn, &person(), "project:my project").unwrap();
        assert_eq!(again.len(), 1);
        let rename = save(
            &conn,
            &person(),
            &ViewInput {
                id: Some(views[0].id.clone()),
                page_key: "project:my project".into(),
                name: "Board".into(),
                state: default_state(),
                version: Some(1),
            },
        );
        assert_eq!(rename.unwrap_err(), "The default view stays.");
        assert_eq!(
            delete(&conn, &person(), &views[0].id, 1).unwrap_err(),
            "The default view stays."
        );
    }

    #[test]
    fn a_broken_state_is_read_as_the_default_and_the_row_stays() {
        let store = mem();
        let conn = store.lock_conn().unwrap();
        list(&conn, &person(), "all").unwrap();
        conn.execute(
            "UPDATE task_views SET state = ?1 WHERE id = ?2",
            params!["{not json", "default:all"],
        )
        .unwrap();
        let views = list(&conn, &person(), "all").unwrap();
        assert!(views[0].fallback);
        assert_eq!(views[0].state, default_state());
        let raw: String = conn
            .query_row(
                "SELECT state FROM task_views WHERE id = 'default:all'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw, "{not json");
    }

    #[test]
    fn an_empty_name_and_a_duplicate_are_refused() {
        let store = mem();
        let conn = store.lock_conn().unwrap();
        let err = save(
            &conn,
            &person(),
            &ViewInput {
                id: None,
                page_key: "all".into(),
                name: "   ".into(),
                state: default_state(),
                version: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, "The name is empty.");
        save(
            &conn,
            &person(),
            &ViewInput {
                id: None,
                page_key: "all".into(),
                name: "Café".into(),
                state: default_state(),
                version: None,
            },
        )
        .unwrap();
        let dup = save(
            &conn,
            &person(),
            &ViewInput {
                id: None,
                page_key: "all".into(),
                name: "  Café  ".into(),
                state: default_state(),
                version: None,
            },
        )
        .unwrap_err();
        assert_eq!(dup, "A view with that name is already here.");
    }

    #[test]
    fn a_stale_save_does_not_overwrite_the_first_one() {
        let dir =
            std::env::temp_dir().join(format!("hivra-views-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("views.sqlite");
        let first = Connection::open(&path).unwrap();
        let second = Connection::open(&path).unwrap();
        let who = person();
        let created = save(
            &first,
            &who,
            &ViewInput {
                id: None,
                page_key: "all".into(),
                name: "Board".into(),
                state: default_state(),
                version: None,
            },
        )
        .unwrap();
        assert!(!created.stale);
        let mut next = default_state();
        next["display"]["layout"] = json!("board");
        let won = save(
            &first,
            &who,
            &ViewInput {
                id: Some(created.view.id.clone()),
                page_key: "all".into(),
                name: "Board".into(),
                state: next,
                version: Some(1),
            },
        )
        .unwrap();
        assert!(!won.stale);
        assert_eq!(won.view.version, 2);
        let lost = save(
            &second,
            &who,
            &ViewInput {
                id: Some(created.view.id.clone()),
                page_key: "all".into(),
                name: "Board".into(),
                state: default_state(),
                version: Some(1),
            },
        )
        .unwrap();
        assert!(lost.stale);
        assert_eq!(lost.view.version, 2);
        assert_eq!(lost.view.state["display"]["layout"], "board");
        drop(first);
        drop(second);
        let temp = std::env::temp_dir();
        if path.starts_with(&temp) {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
