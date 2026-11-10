//! Which folders a chat may show local images and videos from.
//!
//! A reply, or a chat imported from elsewhere, is untrusted text. The folders its media may come from are worked
//! out here from the app's own records of the chat, never from what the window that asks says: the chat's own folder,
//! the projects of the Mono it belongs to, and the worktrees git itself records for those projects. `fs.rs` then
//! holds each folder to what a chat's own can be (`Withheld`) and checks a path against them
//! (`chat_media_file_via`); this module only names candidates.
//!
//! An import writes rows too (chats, delegations), and what it writes is not the user's own record. Of those rows only
//! a chat's own folder reaches here, and it does so only as the folder `FolderRules` kept when the import wrote it
//! (`sessions.cwd` is that vetted folder; `fs.rs` still checks it against `Withheld`). The rest grants nothing by itself:
//!
//! - a delegation counts only when its owner is one of the chats the roster gives this chat's Mono, which an import
//!   cannot name (the roster is the window's own file, and ids are random), not by the Mono id it carries;
//! - a worktree counts only when the project's own git records it (`is_worktree_of`), whichever chat row names it,
//!   so a chat whose folder matches a real project cannot lend that project a worktree such as `~/Pictures`;
//! - a worker's bare folder never counts, only its worktree.
//!
//! Most Mono chats start in the home folder, which is too broad to be a root. What they may show is what lies in
//! their Mono's projects, found here through the roster (`MONOS.json`, written by the webview) and the hub's local
//! documents (projects and which Monos work on them).

use std::io::Read;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::fs::local_path_text;

/// The most worktrees read for one project, so a project with a very long history stays cheap to ask about.
const WORKTREES_PER_PROJECT: usize = 200;

/// What the app's records give one chat.
#[derive(Debug, Default)]
pub(crate) struct ChatFolders {
    /// Candidate folders, each checked again before it counts. Anything the records do not have is left out.
    pub folders: Vec<String>,
    /// The Monos the chat belongs to, for the folders that are theirs (`fs.rs`).
    pub monos: Vec<String>,
}

/// The folders for chat `session_id`: its folder and worktree, the projects of its Mono, and the worktrees of those
/// projects (and of the workers its Mono's own chats delegated to) that git records. The app reads `candidates` under the database
/// lock and calls `vet` after letting go of it; this is both in one, for the tests.
#[cfg(test)]
pub(crate) fn folders(conn: &Connection, roster: Option<&Value>, session_id: &str) -> ChatFolders {
    candidates(conn, roster, session_id).vet()
}

/// What the records name for one chat, read from the database only. The disk and git checks come after, in `vet`,
/// so a caller can let go of the database first: a worktree on a slow or missing volume must not hold up every other
/// database user while it is looked at.
#[derive(Debug, Default)]
pub(crate) struct Candidates {
    /// The chat's own folder and worktree.
    own: Option<(String, Option<String>)>,
    monos: Vec<String>,
    /// Project folders, whose worktrees count once git records them.
    projects: Vec<String>,
    /// Workers delegated by the Mono's own chats (or this chat): folder and worktree.
    workers: Vec<(String, String)>,
    /// Each project's worktrees as the chat rows name them, not yet checked.
    project_worktrees: Vec<(String, Vec<String>)>,
}

/// Reads the candidates for chat `session_id` (database only; see `Candidates`).
pub(crate) fn candidates(
    conn: &Connection,
    roster: Option<&Value>,
    session_id: &str,
) -> Candidates {
    let own = session_folders(conn, session_id);
    let owner = roster_owner(roster, session_id);
    let mut projects: Vec<String> = Vec::new();
    projects.extend(own.as_ref().map(|(cwd, _)| cwd.clone()));
    projects.extend(owner.projects);
    projects.extend(hub_projects(conn, &owner.monos));

    // Workers: only those delegated by one of the Mono's own chats (the roster's, this chat included when the roster
    // gives it), and only their worktree. A chat outside the roster owns no delegation that counts: an imported chat
    // names its own id as owner in the rows it wrote, and that must not lend a worker's worktree.
    let owners = owner.chats;
    let workers = delegated_children(conn, &owners)
        .into_iter()
        .filter_map(|child| match session_folders(conn, &child) {
            Some((cwd, Some(worktree))) => Some((cwd, worktree)),
            _ => None,
        })
        .collect();
    let project_worktrees = projects
        .iter()
        .map(|project| (project.clone(), worktrees_of(conn, project)))
        .collect();
    Candidates {
        own,
        monos: owner.monos,
        projects,
        workers,
        project_worktrees,
    }
}

impl Candidates {
    /// Keeps only the worktrees git records for their project (this asks the disk), then the projects.
    pub(crate) fn vet(self) -> ChatFolders {
        let mut worktrees: Vec<String> = Vec::new();
        if let Some((cwd, Some(worktree))) = &self.own {
            if is_worktree_of(cwd, worktree) {
                worktrees.push(worktree.clone());
            }
        }
        for (cwd, worktree) in self.workers {
            if is_worktree_of(&cwd, &worktree) {
                worktrees.push(worktree);
            }
        }
        for (project, listed) in &self.project_worktrees {
            for worktree in listed {
                if is_worktree_of(project, worktree) {
                    worktrees.push(worktree.clone());
                }
            }
        }
        let mut found = ChatFolders {
            folders: worktrees,
            monos: self.monos,
        };
        found.folders.extend(self.projects);
        let mut seen = std::collections::HashSet::new();
        found
            .folders
            .retain(|folder| !folder.trim().is_empty() && seen.insert(folder.clone()));
        found
    }
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

/// The Monos a chat belongs to (its 1:1 chat or one of its room chats), all the chats those Monos have, and the
/// project folders they work on.
#[derive(Debug, Default)]
struct Owner {
    monos: Vec<String>,
    chats: Vec<String>,
    projects: Vec<String>,
}

fn roster_owner(roster: Option<&Value>, session_id: &str) -> Owner {
    let mut owner = Owner::default();
    let monos = roster
        .and_then(|roster| roster.get("monos"))
        .and_then(Value::as_array);
    for mono in monos.into_iter().flatten() {
        let rooms: Vec<&str> = mono
            .get("roomSessions")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|rooms| rooms.values())
            .filter_map(Value::as_str)
            .collect();
        let chat = mono.get("sessionId").and_then(Value::as_str);
        if chat != Some(session_id) && !rooms.contains(&session_id) {
            continue;
        }
        if let Some(id) = mono.get("id").and_then(Value::as_str) {
            owner.monos.push(id.to_string());
        }
        owner.chats.extend(chat.map(str::to_string));
        owner.chats.extend(rooms.into_iter().map(str::to_string));
        owner.projects.extend(strings(mono.get("projects")));
    }
    owner
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

/// The chats of the workers that these chats, the Mono's own, delegated to.
fn delegated_children(conn: &Connection, owners: &[String]) -> Vec<String> {
    let Ok(mut query) =
        conn.prepare("SELECT DISTINCT child_session FROM delegations WHERE owner_session = ?1")
    else {
        return Vec::new();
    };
    let mut children = Vec::new();
    for owner in owners {
        if let Ok(rows) = query.query_map(params![owner], |row| row.get::<_, String>(0)) {
            children.extend(rows.flatten());
        }
    }
    children
}

/// The worktrees the app knows for a project: those its chats work in, newest first. The project's folder is matched
/// as written and with or without a closing slash. A row only says where a chat claims to work; `is_worktree_of`
/// says whether the project agrees.
fn worktrees_of(conn: &Connection, project: &str) -> Vec<String> {
    let Ok(mut query) = conn.prepare(
        "SELECT worktree_cwd FROM sessions
         WHERE cwd IN (?1, ?2, ?3) AND worktree_removed = 0
           AND worktree_cwd IS NOT NULL AND worktree_cwd <> ''
         GROUP BY worktree_cwd ORDER BY MAX(updated_at) DESC
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

/// Whether `worktree` is a git worktree that `project` made, as git records it in both places: the worktree's `.git`
/// is a file naming a folder under the project's own `.git/worktrees`, and that folder names the worktree's `.git`
/// back. A folder anywhere else (`~/Pictures`, another project) is not, whatever a chat row says. Both paths are held
/// to being on this computer (`local_path_text`) before the disk is asked about them.
fn is_worktree_of(project: &str, worktree: &str) -> bool {
    let (Some(project), Some(worktree)) = (local_path_text(project), local_path_text(worktree))
    else {
        return false;
    };
    let link = worktree.join(".git");
    // A file, not a folder (a clone) and not a link that could point anywhere.
    if !std::fs::symlink_metadata(&link).is_ok_and(|meta| meta.is_file()) {
        return false;
    }
    let Some(text) = read_small(&link) else {
        return false;
    };
    let Some(admin) = text
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("gitdir:"))
        .map(str::trim)
    else {
        return false;
    };
    let admin = if Path::new(admin).is_absolute() {
        local_path_text(admin)
    } else {
        local_path_text(&worktree.join(admin).to_string_lossy())
    };
    let Some(admin) = admin else {
        return false;
    };
    let (Ok(common), Ok(admin), Ok(link)) = (
        std::fs::canonicalize(project.join(".git")),
        std::fs::canonicalize(&admin),
        std::fs::canonicalize(&link),
    ) else {
        return false;
    };
    if !common.is_dir() || admin.parent() != Some(common.join("worktrees").as_path()) {
        return false;
    }
    let Some(back) = read_small(&admin.join("gitdir")) else {
        return false;
    };
    local_path_text(back.trim())
        .and_then(|back| std::fs::canonicalize(back).ok())
        .is_some_and(|back| back == link)
}

/// The start of a small text file; git's own link files are a line long.
fn read_small(path: &Path) -> Option<String> {
    let mut text = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(4096)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::SessionStore;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp(label: &str) -> Tmp {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "monocode-chat-media-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // The folder as the app's records name one: `C:\...` on Windows, not the `\\?\C:\...` form that
        // `std::fs::canonicalize` gives there, which `local_path_text` refuses as text from a chat.
        Tmp(dunce::canonicalize(dir).unwrap())
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// A git repository's folder, as far as a worktree's records go.
    fn repo(dir: &Path, name: &str) -> PathBuf {
        let project = dir.join(name);
        std::fs::create_dir_all(project.join(".git/worktrees")).unwrap();
        project
    }

    /// A worktree of `project` as `git worktree add` records it: `.git` in the worktree names the project's
    /// `.git/worktrees/<name>`, which names the worktree's `.git` back.
    fn worktree(project: &Path, at: &Path, name: &str) -> PathBuf {
        let admin = project.join(".git/worktrees").join(name);
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::create_dir_all(at).unwrap();
        std::fs::write(at.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        std::fs::write(
            admin.join("gitdir"),
            format!("{}\n", at.join(".git").display()),
        )
        .unwrap();
        at.to_path_buf()
    }

    fn store() -> SessionStore {
        SessionStore::open_in_memory().unwrap()
    }

    fn session(conn: &Connection, id: &str, cwd: &str, worktree: Option<&str>, removed: i64) {
        session_at(conn, id, cwd, worktree, removed, 0);
    }

    fn session_at(
        conn: &Connection,
        id: &str,
        cwd: &str,
        worktree: Option<&str>,
        removed: i64,
        updated_at: i64,
    ) {
        conn.execute(
            "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, blocks_json, created_at, updated_at, worktree_cwd, worktree_removed) VALUES (?1, ?2, 'codex', 'test', 'supervised', 'Test', '[]', 0, ?5, ?3, ?4)",
            params![id, cwd, worktree, removed, updated_at],
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

    fn folders_of(conn: &Connection, roster: Option<&Value>, id: &str) -> Vec<String> {
        folders(conn, roster, id).folders
    }

    #[test]
    fn a_chat_has_its_folder_and_the_worktree_its_project_records() {
        let dir = tmp("own");
        let store = store();
        let conn = store.lock_conn().unwrap();
        let project = repo(&dir.0, "repo");
        let tree = worktree(&project, &dir.0.join("trees/repo-a"), "repo-a");
        session(&conn, "chat", &text(&project), Some(&text(&tree)), 0);

        assert_eq!(
            folders_of(&conn, None, "chat"),
            vec![text(&tree), text(&project)]
        );
    }

    #[test]
    fn a_worktree_the_project_does_not_record_is_not_a_folder() {
        let dir = tmp("forged");
        let store = store();
        let conn = store.lock_conn().unwrap();
        let project = repo(&dir.0, "repo");
        let other = repo(&dir.0, "other");
        std::fs::create_dir_all(dir.0.join("Pictures")).unwrap();
        // Another project's worktree, a clone, a folder with a `.git` file that names a place the project has
        // no record of, one that does not name the folder back, and a plain folder.
        let others = worktree(&other, &dir.0.join("trees/other-a"), "other-a");
        let clone = dir.0.join("trees/clone");
        std::fs::create_dir_all(clone.join(".git")).unwrap();
        let stray = dir.0.join("trees/stray");
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::write(
            stray.join(".git"),
            format!("gitdir: {}\n", dir.0.join("Pictures").display()),
        )
        .unwrap();
        let unrecorded = worktree(&project, &dir.0.join("trees/repo-b"), "repo-b");
        std::fs::write(
            project.join(".git/worktrees/repo-b/gitdir"),
            "/elsewhere/.git\n",
        )
        .unwrap();
        for (id, tree) in [
            ("pictures", dir.0.join("Pictures")),
            ("others", others),
            ("clone", clone),
            ("stray", stray),
            ("unrecorded", unrecorded),
            ("gone", dir.0.join("trees/not-there")),
        ] {
            session(&conn, id, &text(&project), Some(&text(&tree)), 0);
            assert_eq!(folders_of(&conn, None, id), vec![text(&project)], "{id}");
        }
    }

    #[test]
    fn a_relative_gitdir_is_followed() {
        let dir = tmp("relative");
        let project = repo(&dir.0, "repo");
        let tree = worktree(&project, &dir.0.join("trees/repo-a"), "repo-a");
        std::fs::write(
            tree.join(".git"),
            "gitdir: ../../repo/.git/worktrees/repo-a\n",
        )
        .unwrap();

        assert!(is_worktree_of(&text(&project), &text(&tree)));
        assert!(!is_worktree_of(&text(&dir.0.join("trees")), &text(&tree)));
    }

    #[test]
    fn a_removed_worktree_and_an_empty_one_are_not_a_folder() {
        let dir = tmp("removed");
        let store = store();
        let conn = store.lock_conn().unwrap();
        let project = repo(&dir.0, "repo");
        let tree = worktree(&project, &dir.0.join("trees/repo-a"), "repo-a");
        session(&conn, "gone", &text(&project), Some(&text(&tree)), 1);
        session(&conn, "empty", &text(&project), Some(" "), 0);

        assert_eq!(folders_of(&conn, None, "gone"), vec![text(&project)]);
        assert_eq!(folders_of(&conn, None, "empty"), vec![text(&project)]);
    }

    #[test]
    fn a_chat_the_app_has_no_record_of_has_no_folders() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        assert!(folders_of(&conn, None, "unknown").is_empty());
        assert!(folders_of(&conn, Some(&json!({"monos": []})), "unknown").is_empty());
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
            let found = folders(&conn, Some(&roster), id);
            assert_eq!(
                found.folders,
                vec!["/home/me", "/work/p", "/work/q"],
                "{id}"
            );
            assert_eq!(found.monos, vec!["ada"], "{id}");
        }
        assert_eq!(
            folders_of(&conn, Some(&roster), "other-chat"),
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
            folders_of(&conn, Some(&roster), "mono-chat"),
            vec!["/home/me", "/work/alpha"]
        );
    }

    #[test]
    fn a_lead_has_the_worktrees_of_the_workers_it_delegated_to() {
        let dir = tmp("lead");
        let store = store();
        let conn = store.lock_conn().unwrap();
        let project = repo(&dir.0, "p");
        let other = repo(&dir.0, "q");
        let feature = worktree(&project, &dir.0.join("trees/p-feature"), "p-feature");
        let sibling = worktree(&project, &dir.0.join("trees/p-other"), "p-other");
        let foreign = worktree(&other, &dir.0.join("trees/q-feature"), "q-feature");
        session(&conn, "lead", &text(&project), None, 0);
        session(&conn, "worker", &text(&project), Some(&text(&feature)), 0);
        session(&conn, "plain-worker", "/somewhere/else", None, 0);
        session(
            &conn,
            "someone-else",
            &text(&project),
            Some(&text(&sibling)),
            0,
        );
        session(&conn, "elsewhere", &text(&other), Some(&text(&foreign)), 0);
        delegation(&conn, "d1", "lead", Some("lead-mono"), "worker");
        delegation(&conn, "d2", "lead", Some("lead-mono"), "plain-worker");
        // A worker another chat delegated to is not this chat's.
        delegation(&conn, "d3", "someone-else", Some("other-mono"), "elsewhere");
        let roster = json!({"monos": [{"id": "lead-mono", "sessionId": "lead", "projects": [text(&project)]}]});

        let found = folders_of(&conn, Some(&roster), "lead");
        assert!(found.contains(&text(&project)), "{found:?}");
        // The worker's worktree, and the worktree of the project's other chat.
        assert!(found.contains(&text(&feature)), "{found:?}");
        assert!(found.contains(&text(&sibling)), "{found:?}");
        // A worker's bare folder, and another project's worktree, are not.
        assert!(!found.contains(&"/somewhere/else".to_string()), "{found:?}");
        assert!(!found.contains(&text(&foreign)), "{found:?}");
        assert!(!found.contains(&text(&other)), "{found:?}");
    }

    #[test]
    fn a_delegation_an_import_wrote_grants_no_folder() {
        let dir = tmp("import-delegation");
        let store = store();
        let conn = store.lock_conn().unwrap();
        let project = repo(&dir.0, "p");
        let pictures = dir.0.join("Pictures");
        std::fs::create_dir_all(&pictures).unwrap();
        let genuine = worktree(&project, &dir.0.join("trees/p-feature"), "p-feature");
        session(&conn, "lead-chat", &text(&dir.0), None, 0);
        session(&conn, "worker", &text(&project), Some(&text(&genuine)), 0);
        delegation(&conn, "real", "lead-chat", Some("hivra-lead"), "worker");
        // Rows a crafted export brings: they name the Lead's id, and workers that are chats of the export's own.
        session(&conn, "imported-a", &text(&pictures), None, 0);
        session(
            &conn,
            "imported-b",
            &text(&project),
            Some(&text(&pictures)),
            0,
        );
        delegation(
            &conn,
            "fake-a",
            "imported-owner",
            Some("hivra-lead"),
            "imported-a",
        );
        delegation(
            &conn,
            "fake-b",
            "imported-owner",
            Some("hivra-lead"),
            "imported-b",
        );
        let roster = json!({"monos": [
            {"id": "hivra-lead", "sessionId": "lead-chat", "projects": [text(&project)]},
        ]});

        let found = folders_of(&conn, Some(&roster), "lead-chat");
        assert!(found.contains(&text(&genuine)), "{found:?}");
        assert!(!found.contains(&text(&pictures)), "{found:?}");
        // Not by the Lead's own chats either: the owner is what counts.
        assert!(
            !found.iter().any(|folder| folder.contains("Pictures")),
            "{found:?}"
        );
    }

    #[test]
    fn a_delegation_from_one_of_the_monos_own_chats_counts() {
        let dir = tmp("own-chats");
        let store = store();
        let conn = store.lock_conn().unwrap();
        let project = repo(&dir.0, "p");
        let old = worktree(&project, &dir.0.join("trees/p-old"), "p-old");
        session(&conn, "new-chat", &text(&dir.0), None, 0);
        session(&conn, "room-chat", &text(&dir.0), None, 0);
        session(&conn, "old-worker", &text(&project), Some(&text(&old)), 0);
        delegation(&conn, "d1", "room-chat", Some("ada"), "old-worker");
        let roster = json!({"monos": [{"id": "ada", "sessionId": "new-chat",
            "roomSessions": {"[\"c\",\"d\"]": "room-chat"}, "projects": []}]});

        let found = folders_of(&conn, Some(&roster), "new-chat");
        assert!(found.contains(&text(&old)), "{found:?}");
    }

    #[test]
    fn a_chat_with_no_mono_gets_no_worker_from_an_empty_owner() {
        let dir = tmp("no-mono");
        let store = store();
        let conn = store.lock_conn().unwrap();
        let project = repo(&dir.0, "p");
        let tree = worktree(&project, &dir.0.join("trees/p-a"), "p-a");
        session(&conn, "chat", &text(&dir.0), None, 0);
        session(&conn, "worker", &text(&project), Some(&text(&tree)), 0);
        // The empty owner the old query matched for a chat with no Mono matches nothing now.
        delegation(&conn, "d1", "", Some(""), "worker");

        assert!(!folders_of(&conn, None, "chat").contains(&text(&tree)));
        // Round 6: even a row that names the chat itself as owner lends nothing, since the chat is not on any roster.
        delegation(&conn, "d2", "chat", None, "worker");
        assert!(!folders_of(&conn, None, "chat").contains(&text(&tree)));
    }

    #[test]
    fn a_chat_that_claims_a_projects_folder_cannot_lend_it_a_folder() {
        // What an import can write, once it has been held to known projects: a chat whose folder is a real
        // project's, with a worktree of its own choosing.
        let dir = tmp("lend");
        let store = store();
        let conn = store.lock_conn().unwrap();
        let project = repo(&dir.0, "p");
        let pictures = dir.0.join("Pictures");
        std::fs::create_dir_all(&pictures).unwrap();
        session(&conn, "mono-chat", &text(&dir.0), None, 0);
        session(
            &conn,
            "imported",
            &text(&project),
            Some(&text(&pictures)),
            0,
        );
        let roster = json!({"monos": [{"id": "ada", "sessionId": "mono-chat", "projects": [text(&project)]}]});

        // The row is there to be found; the project does not record it.
        assert_eq!(worktrees_of(&conn, &text(&project)), vec![text(&pictures)]);
        assert_eq!(
            folders_of(&conn, Some(&roster), "mono-chat"),
            vec![text(&dir.0), text(&project)]
        );
    }

    #[test]
    fn a_project_lists_only_the_live_worktrees_of_its_own_chats_newest_first() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session_at(&conn, "a", "/work/p", Some("/trees/one"), 0, 1);
        session_at(&conn, "b", "/work/p/", Some("/trees/two"), 0, 3);
        session_at(&conn, "c", "/work/p", Some("/trees/three"), 0, 2);
        session_at(&conn, "d", "/work/p", Some("/trees/removed"), 1, 9);
        session_at(&conn, "e", "/work/p-evil", Some("/trees/evil"), 0, 9);
        session_at(&conn, "f", "/work/p", None, 0, 9);
        session_at(&conn, "g", "/work/p", Some("/trees/one"), 0, 0);

        let expected = vec!["/trees/two", "/trees/three", "/trees/one"];
        assert_eq!(worktrees_of(&conn, "/work/p"), expected);
        assert_eq!(worktrees_of(&conn, "/work/p/"), expected);
    }

    #[test]
    fn a_project_with_a_long_history_keeps_its_newest_worktrees() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        for index in 0..(WORKTREES_PER_PROJECT + 5) {
            session_at(
                &conn,
                &format!("s{index}"),
                "/work/p",
                Some(&format!("/trees/t{index}")),
                0,
                index as i64,
            );
        }

        let found = worktrees_of(&conn, "/work/p");
        assert_eq!(found.len(), WORKTREES_PER_PROJECT);
        assert_eq!(found[0], format!("/trees/t{}", WORKTREES_PER_PROJECT + 4));
        assert!(!found.contains(&"/trees/t0".to_string()));
        assert!(found.contains(&"/trees/t5".to_string()));
    }

    #[test]
    fn a_chat_outside_the_roster_lends_no_worktree_for_its_own_delegations() {
        // Round 6 (LOW-1): the owner of a delegation counts only when the roster gives it to a Mono. A chat that is not
        // on the roster (an imported chat, say) names its own id as owner in a row it wrote, and its worker's worktree
        // is no folder of its own.
        let dir = tmp("self-owner");
        let store = store();
        let conn = store.lock_conn().unwrap();
        let project = repo(&dir.0, "p");
        let tree = worktree(&project, &dir.0.join("trees/p-a"), "p-a");
        session(&conn, "imported", &text(&dir.0), None, 0);
        session(&conn, "worker", &text(&project), Some(&text(&tree)), 0);
        delegation(&conn, "d1", "imported", None, "worker");

        assert!(!folders_of(&conn, None, "imported").contains(&text(&tree)));
        assert!(!folders_of(&conn, Some(&json!({"monos": []})), "imported").contains(&text(&tree)));
    }

    #[test]
    fn folders_are_listed_once() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        session(&conn, "chat", "/work/p", None, 0);
        let roster =
            json!({"monos": [{"id": "ada", "sessionId": "chat", "projects": ["/work/p", " "]}]});

        assert_eq!(folders_of(&conn, Some(&roster), "chat"), vec!["/work/p"]);
    }
}
