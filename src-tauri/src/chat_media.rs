//! Which folders a chat may show local images and videos from.
//!
//! A reply, or a chat imported from elsewhere, is untrusted text. The folders its media may come from are worked
//! out here from the app's own records of the chat, never from what the window that asks says: the chat's own folder
//! and worktree, the projects of the Mono it belongs to and the worktrees the app knows for them, and the folders of
//! the workers it delegated to. `fs.rs` then holds each folder to what a chat's own can be (`Withheld`) and checks a
//! path against them (`chat_media_file_via`); this module only names candidates.
//!
//! Most Mono chats start in the home folder, which is too broad to be a root. What they may show is what lies in
//! their Mono's projects, found here through the roster (`MONOS.json`, written by the webview) and the hub's local
//! documents (projects and which Monos work on them).

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

/// The most worktrees read for one project, so a project with a very long history stays cheap to ask about.
const WORKTREES_PER_PROJECT: usize = 200;

/// Candidate folders for chat `session_id`, in no particular trust order: each is checked again before it counts.
/// Anything the records do not have is simply left out, and a record that cannot be read adds nothing.
pub(crate) fn folders(conn: &Connection, roster: Option<&Value>, session_id: &str) -> Vec<String> {
    // Folders that count as they are, and project folders, whose worktrees count too.
    let mut folders: Vec<String> = Vec::new();
    let mut projects: Vec<String> = Vec::new();

    if let Some((cwd, worktree)) = session_folders(conn, session_id) {
        projects.push(cwd);
        folders.extend(worktree);
    }
    let (monos, roster_projects) = roster_monos(roster, session_id);
    projects.extend(roster_projects);
    projects.extend(hub_projects(conn, &monos));

    // A worker's own folder is its worktree, or the project when it has none.
    for child in delegated_children(conn, session_id, &monos) {
        if let Some((cwd, worktree)) = session_folders(conn, &child) {
            folders.push(worktree.unwrap_or(cwd));
        }
    }
    for project in &projects {
        folders.extend(worktrees_of(conn, project));
    }
    folders.extend(projects);

    let mut seen = std::collections::HashSet::new();
    folders.retain(|folder| !folder.trim().is_empty() && seen.insert(folder.clone()));
    folders
}

/// A chat's folder and, while it still exists, its worktree.
fn session_folders(conn: &Connection, id: &str) -> Option<(String, Option<String>)> {
    let (cwd, worktree, removed): (String, Option<String>, i64) = conn
        .query_row(
            "SELECT cwd, worktree_cwd, worktree_removed FROM sessions WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .ok()??;
    let worktree = worktree.filter(|folder| removed == 0 && !folder.trim().is_empty());
    Some((cwd, worktree))
}

/// The Monos whose chat this is (its 1:1 chat or one of its room chats), and the project folders they work on.
fn roster_monos(roster: Option<&Value>, session_id: &str) -> (Vec<String>, Vec<String>) {
    let mut ids = Vec::new();
    let mut projects = Vec::new();
    let monos = roster
        .and_then(|roster| roster.get("monos"))
        .and_then(Value::as_array);
    for mono in monos.into_iter().flatten() {
        let owns = mono.get("sessionId").and_then(Value::as_str) == Some(session_id)
            || mono
                .get("roomSessions")
                .and_then(Value::as_object)
                .is_some_and(|rooms| rooms.values().any(|id| id.as_str() == Some(session_id)));
        if !owns {
            continue;
        }
        if let Some(id) = mono.get("id").and_then(Value::as_str) {
            ids.push(id.to_string());
        }
        projects.extend(strings(mono.get("projects")));
    }
    (ids, projects)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// The folders of the hub projects these Monos are members of.
fn hub_projects(conn: &Connection, monos: &[String]) -> Vec<String> {
    if monos.is_empty() {
        return Vec::new();
    }
    let doc = |key: &str| {
        crate::local_hub::read_doc(conn, key)
            .ok()
            .and_then(|doc| doc.value)
    };
    let (Some(memberships), Some(projects)) = (doc("memberships"), doc("projects")) else {
        return Vec::new();
    };
    let joined: Vec<&str> = memberships
        .as_array()
        .into_iter()
        .flatten()
        .filter(|member| {
            member
                .get("monoId")
                .and_then(Value::as_str)
                .is_some_and(|id| monos.iter().any(|mono| mono == id))
        })
        .filter_map(|member| member.get("projectId").and_then(Value::as_str))
        .collect();
    projects
        .as_array()
        .into_iter()
        .flatten()
        .filter(|project| {
            project
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| joined.contains(&id))
        })
        .filter_map(|project| project.get("folder").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// The chats of the workers this chat, or the Mono it belongs to, delegated to.
fn delegated_children(conn: &Connection, session_id: &str, monos: &[String]) -> Vec<String> {
    let Ok(mut query) = conn.prepare(
        "SELECT DISTINCT child_session FROM delegations WHERE owner_session = ?1 OR owner_mono = ?2",
    ) else {
        return Vec::new();
    };
    // A chat with no Mono asks about its own delegations only: the empty id matches no Mono.
    let owners: Vec<&str> = if monos.is_empty() {
        vec![""]
    } else {
        monos.iter().map(String::as_str).collect()
    };
    let mut children = Vec::new();
    for mono in owners {
        let Ok(rows) = query.query_map(params![session_id, mono], |row| row.get::<_, String>(0))
        else {
            continue;
        };
        children.extend(rows.flatten());
    }
    children
}

/// The worktrees the app knows for a project: those its chats work in. The project's folder is matched as written
/// and with or without a closing slash.
fn worktrees_of(conn: &Connection, project: &str) -> Vec<String> {
    let Ok(mut query) = conn.prepare(
        "SELECT DISTINCT worktree_cwd FROM sessions
         WHERE cwd IN (?1, ?2, ?3) AND worktree_removed = 0
           AND worktree_cwd IS NOT NULL AND worktree_cwd <> ''
         LIMIT ?4",
    ) else {
        return Vec::new();
    };
    let bare = project.trim_end_matches(['/', '\\']);
    query
        .query_map(
            params![
                project,
                bare,
                format!("{bare}/"),
                WORKTREES_PER_PROJECT as i64
            ],
            |row| row.get::<_, String>(0),
        )
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::SessionStore;
    use serde_json::json;

    fn store() -> SessionStore {
        SessionStore::open_in_memory().unwrap()
    }

    fn session(conn: &Connection, id: &str, cwd: &str, worktree: Option<&str>, removed: i64) {
        conn.execute(
            "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, blocks_json, created_at, updated_at, worktree_cwd, worktree_removed) VALUES (?1, ?2, 'codex', 'test', 'supervised', 'Test', '[]', 0, 0, ?3, ?4)",
            params![id, cwd, worktree, removed],
        )
        .unwrap();
    }

    fn delegation(conn: &Connection, id: &str, owner: &str, mono: Option<&str>, child: &str) {
        conn.execute(
            "INSERT INTO delegations (id, owner_session, owner_mono, root_id, child_session, request_id, state, delivery, created_at, updated_at) VALUES (?1, ?2, ?3, ?1, ?4, ?1, 'done', 'delivered', 0, 0)",
            params![id, owner, mono, child],
        )
        .unwrap();
    }

    #[test]
    fn a_chat_has_its_folder_and_its_worktree() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session(&conn, "chat", "/work/repo", Some("/trees/repo-a"), 0);

        assert_eq!(
            folders(&conn, None, "chat"),
            vec!["/trees/repo-a", "/work/repo"]
        );
    }

    #[test]
    fn a_removed_worktree_and_an_empty_one_are_not_a_folder() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session(&conn, "gone", "/work/repo", Some("/trees/repo-a"), 1);
        session(&conn, "empty", "/work/repo", Some(" "), 0);

        assert_eq!(folders(&conn, None, "gone"), vec!["/work/repo"]);
        assert_eq!(folders(&conn, None, "empty"), vec!["/work/repo"]);
    }

    #[test]
    fn a_chat_the_app_has_no_record_of_has_no_folders() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        assert!(folders(&conn, None, "unknown").is_empty());
        assert!(folders(&conn, Some(&json!({"monos": []})), "unknown").is_empty());
    }

    #[test]
    fn a_mono_chat_in_the_home_folder_has_the_projects_its_mono_works_on() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session(&conn, "mono-chat", "/home/me", None, 0);
        session(&conn, "room-chat", "/home/me", None, 0);
        session(&conn, "other-chat", "/home/me", None, 0);
        let roster = json!({"version": 1, "monos": [
            {"id": "ada", "sessionId": "mono-chat", "roomSessions": {"[\"c\",\"d\"]": "room-chat"},
             "projects": ["/work/p", "/work/q"]},
            {"id": "bob", "sessionId": "other-chat", "projects": ["/work/not-ada"]},
        ]});

        for id in ["mono-chat", "room-chat"] {
            assert_eq!(
                folders(&conn, Some(&roster), id),
                vec!["/home/me", "/work/p", "/work/q"],
                "{id}"
            );
        }
        assert_eq!(
            folders(&conn, Some(&roster), "other-chat"),
            vec!["/home/me", "/work/not-ada"]
        );
    }

    #[test]
    fn the_hub_projects_a_mono_is_a_member_of_count_too() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session(&conn, "mono-chat", "/home/me", None, 0);
        crate::local_hub::write(
            &conn,
            "projects",
            &json!([
                {"id": "alpha", "folder": "/work/alpha"},
                {"id": "beta", "folder": "/work/beta"},
                {"id": "loose", "folder": null},
            ]),
        )
        .unwrap();
        crate::local_hub::write(
            &conn,
            "memberships",
            &json!([
                {"monoId": "ada", "projectId": "alpha", "role": "lead"},
                {"monoId": "bob", "projectId": "beta", "role": "member"},
                {"monoId": "ada", "projectId": "loose", "role": "member"},
            ]),
        )
        .unwrap();
        let roster = json!({"monos": [{"id": "ada", "sessionId": "mono-chat", "projects": []}]});

        assert_eq!(
            folders(&conn, Some(&roster), "mono-chat"),
            vec!["/home/me", "/work/alpha"]
        );
    }

    #[test]
    fn a_lead_has_the_worktrees_of_the_workers_it_delegated_to() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session(&conn, "lead", "/work/p", None, 0);
        session(&conn, "worker", "/work/p", Some("/trees/p-feature"), 0);
        session(&conn, "plain-worker", "/work/p", None, 0);
        session(&conn, "someone-else", "/work/p", Some("/trees/p-other"), 0);
        session(&conn, "elsewhere", "/work/q", Some("/trees/q-feature"), 0);
        delegation(&conn, "d1", "lead", Some("lead-mono"), "worker");
        delegation(&conn, "d2", "lead", Some("lead-mono"), "plain-worker");
        // A worker another Mono's chat delegated to is not this chat's.
        delegation(&conn, "d3", "someone-else", Some("other-mono"), "elsewhere");

        let found = folders(&conn, None, "lead");
        assert!(found.contains(&"/work/p".to_string()), "{found:?}");
        // The worker's worktree, the worktree of a project's other chat, and a
        // worker with no worktree, which works in the project.
        assert!(found.contains(&"/trees/p-feature".to_string()), "{found:?}");
        assert!(found.contains(&"/trees/p-other".to_string()), "{found:?}");
        assert!(
            !found.iter().any(|folder| folder.contains("q-feature")),
            "{found:?}"
        );
        assert!(!found.contains(&"/work/q".to_string()), "{found:?}");
    }

    #[test]
    fn a_monos_later_chat_still_has_the_workers_of_its_earlier_ones() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session(&conn, "new-chat", "/home/me", None, 0);
        session(&conn, "old-worker", "/work/p", Some("/trees/p-old"), 0);
        delegation(&conn, "d1", "old-chat", Some("ada"), "old-worker");
        let roster =
            json!({"monos": [{"id": "ada", "sessionId": "new-chat", "projects": ["/work/p"]}]});

        let found = folders(&conn, Some(&roster), "new-chat");
        assert!(found.contains(&"/trees/p-old".to_string()), "{found:?}");
    }

    #[test]
    fn a_project_lists_only_the_live_worktrees_of_its_own_chats() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session(&conn, "a", "/work/p", Some("/trees/one"), 0);
        session(&conn, "b", "/work/p/", Some("/trees/two"), 0);
        session(&conn, "c", "/work/p", Some("/trees/removed"), 1);
        session(&conn, "d", "/work/p-evil", Some("/trees/evil"), 0);
        session(&conn, "e", "/work/p", None, 0);

        let mut found = worktrees_of(&conn, "/work/p");
        found.sort();
        assert_eq!(found, vec!["/trees/one", "/trees/two"]);
        let mut slash = worktrees_of(&conn, "/work/p/");
        slash.sort();
        assert_eq!(slash, vec!["/trees/one", "/trees/two"]);
    }

    #[test]
    fn folders_are_listed_once() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session(&conn, "chat", "/work/p", Some("/trees/p"), 0);
        let roster =
            json!({"monos": [{"id": "ada", "sessionId": "chat", "projects": ["/work/p", " "]}]});

        assert_eq!(
            folders(&conn, Some(&roster), "chat"),
            vec!["/trees/p", "/work/p"]
        );
    }
}
