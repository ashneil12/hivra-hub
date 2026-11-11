//! Round 11 checks for the round 10 review. The official repro commit was not in this checkout, so these tests
//! name the same cases: a bad git dir must not drop Never use, a nested checkout inside a worktree stays owned,
//! the most specific project wins, and a folder git cannot place refuses only the CLI a doubtful project would change.

use serde_json::json;

use super::gate::{issue_ticket, judge_spawn, judge_start, record_grant, LaunchCheck};
use super::store;
use crate::session_store::SessionStore;

fn memory() -> SessionStore {
    SessionStore::open_in_memory().unwrap()
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=r11",
            "-c",
            "user.email=r11@example.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A repository and a linked worktree beside it. The worktree is registered in the repository's git dir.
fn repo_with_worktree(label: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("r11-{label}-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let branch = format!("r11-{label}");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            &branch,
            worktree.to_str().unwrap(),
        ],
    );
    (root, repo, worktree)
}

fn ban(conn: &mut rusqlite::Connection, folder: &str, never: &[&str], lock: bool) {
    store::set_policy(
        conn,
        "project",
        folder,
        &json!({ "lockDefault": lock, "neverUse": never, "fallback": [] }),
        0,
    )
    .unwrap();
}

#[test]
fn a_worktree_git_file_naming_a_plain_folder_keeps_never_use() {
    let (root, repo, worktree) = repo_with_worktree("plain-gitdir");
    let decoy = root.join("not-a-repo");
    std::fs::create_dir_all(&decoy).unwrap();
    std::fs::write(
        worktree.join(".git"),
        format!("gitdir: {}\n", decoy.display()),
    )
    .unwrap();
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    ban(&mut conn, repo.to_str().unwrap(), &["codex"], false);
    let judged = judge_start(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        worktree.to_str().unwrap(),
    );
    let _ = std::fs::remove_dir_all(&root);
    let err = judged.expect_err("a gitdir that is not a repository must not drop Never use");
    assert!(err.contains("Never use"), "{err}");
}

#[test]
fn a_worktree_whose_git_entry_is_an_empty_folder_keeps_never_use() {
    let (root, repo, worktree) = repo_with_worktree("empty-git");
    std::fs::remove_file(worktree.join(".git")).unwrap();
    std::fs::create_dir(worktree.join(".git")).unwrap();
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    ban(&mut conn, repo.to_str().unwrap(), &["codex"], false);
    let judged = judge_start(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        worktree.to_str().unwrap(),
    );
    let _ = std::fs::remove_dir_all(&root);
    let err = judged.expect_err("an empty .git folder must not drop Never use");
    assert!(err.contains("Never use"), "{err}");
}

#[test]
fn a_stray_git_folder_inside_a_worktree_keeps_never_use() {
    let (root, repo, worktree) = repo_with_worktree("stray-git");
    let nested = worktree.join("nested");
    std::fs::create_dir_all(nested.join(".git")).unwrap();
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    ban(&mut conn, repo.to_str().unwrap(), &["codex"], false);
    let judged = judge_start(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        nested.to_str().unwrap(),
    );
    let _ = std::fs::remove_dir_all(&root);
    let err = judged.expect_err("a stray .git folder must not drop Never use");
    assert!(err.contains("Never use"), "{err}");
}

#[test]
fn a_repo_nested_in_a_worktree_keeps_the_projects_never_use() {
    let (root, repo, worktree) = repo_with_worktree("vendor");
    let vendor = worktree.join("vendor-lib");
    std::fs::create_dir_all(&vendor).unwrap();
    git(&vendor, &["init", "-q"]);
    let main_vendor = repo.join("vendor-lib");
    std::fs::create_dir_all(&main_vendor).unwrap();
    git(&main_vendor, &["init", "-q"]);
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    ban(&mut conn, repo.to_str().unwrap(), &["codex"], false);
    let in_worktree = judge_start(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        vendor.to_str().unwrap(),
    );
    let in_main = judge_start(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        main_vendor.to_str().unwrap(),
    );
    let _ = std::fs::remove_dir_all(&root);
    for (what, judged) in [("worktree", in_worktree), ("main checkout", in_main)] {
        let err = judged.expect_err(what);
        assert!(err.contains("Never use"), "{what}: {err}");
    }
}

#[test]
fn the_most_specific_owning_project_comes_first() {
    let root = std::env::temp_dir().join(format!("r11-order-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let package = repo.join("pkg");
    std::fs::create_dir_all(package.join("src")).unwrap();
    let key = |path: &std::path::Path| {
        std::fs::canonicalize(path)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    };
    let (repo_key, package_key) = (key(&repo), key(&package));
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    ban(&mut conn, &repo_key, &[], false);
    ban(&mut conn, &package_key, &["codex"], false);
    let owners = store::projects_owning(&conn, package.join("src").to_str().unwrap()).unwrap();
    let _ = std::fs::remove_dir_all(&root);
    let rank = |saved: &str| {
        owners
            .iter()
            .position(|owner| store::path_key(owner) == store::path_key(saved))
            .expect("both projects own the nested folder")
    };
    assert!(
        rank(&package_key) < rank(&repo_key),
        "outermost project was first: {owners:?}"
    );
}

#[test]
fn an_unreadable_folder_is_refused_only_when_a_doubtful_project_would_change_the_answer() {
    let root = std::env::temp_dir().join(format!("r11-doubt-{}", uuid::Uuid::new_v4()));
    let valid = root.join("valid");
    let broken = root.join("broken");
    let folder = root.join("folder");
    std::fs::create_dir_all(&valid).unwrap();
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::create_dir_all(&folder).unwrap();
    git(&valid, &["init", "-q"]);
    std::fs::write(broken.join(".git"), "garbage\n").unwrap();
    std::fs::write(folder.join(".git"), "garbage\n").unwrap();
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    ban(&mut conn, valid.to_str().unwrap(), &[], false);
    ban(&mut conn, broken.to_str().unwrap(), &["codex"], true);
    let folder = folder.to_str().unwrap();
    record_grant(
        &conn,
        "app-r11-doubt",
        &LaunchCheck {
            cli: "claude".into(),
            mono: None,
            project: Some(folder.to_string()),
            locked_default: Some("claude".into()),
        },
    )
    .unwrap();
    let chat_claude = judge_start(&conn, "7d3e5c2a-lead-chat", "claude", folder);
    let chat_codex = judge_start(&conn, "7d3e5c2a-lead-chat", "codex", folder);
    let worker_claude = judge_start(&conn, "app-r11-doubt", "claude", folder);
    let _ = std::fs::remove_dir_all(&root);
    chat_claude.expect("a CLI the doubtful project does not ban is allowed");
    assert!(
        chat_codex.is_err(),
        "codex is on the doubtful project's Never use"
    );
    assert!(
        worker_claude.is_err(),
        "the lock on a doubtful project refuses an agent session"
    );
}

#[test]
fn an_app_more_agents_launch_needs_a_ticket_for_its_own_id() {
    let store = memory();
    let mut conn = store.lock_conn().unwrap();
    let session = "app-r11-more";
    let folder = "/tmp/r11-more-agents";
    let missing = judge_spawn(&conn, session, "my-acp", folder, None).unwrap_err();
    assert!(missing.contains("no crew gate ticket"), "{missing}");
    let claude_ticket = issue_ticket(&conn, session, "claude", folder).unwrap();
    let wrong = judge_spawn(&conn, session, "my-acp", folder, Some(&claude_ticket)).unwrap_err();
    assert!(
        wrong.contains("another launch"),
        "a ticket for claude must not start my-acp: {wrong}"
    );
    let ticket = issue_ticket(&conn, session, "my-acp", folder).unwrap();
    judge_spawn(&conn, session, "my-acp", folder, Some(&ticket))
        .expect("a ticket for the entry id allows that one launch");
    let again = judge_spawn(&conn, session, "my-acp", folder, Some(&ticket)).unwrap_err();
    assert!(
        again.contains("already used") || again.contains("unknown"),
        "{again}"
    );
    store::set_policy(
        &mut conn,
        "system",
        "system",
        &json!({ "lockDefault": false, "neverUse": ["claude"], "fallback": [] }),
        0,
    )
    .unwrap();
    let banned = judge_start(&conn, session, "claude", folder).unwrap_err();
    assert!(banned.contains("Never use"), "{banned}");
    let again_ticket = issue_ticket(&conn, session, "my-acp", folder).unwrap();
    judge_spawn(&conn, session, "my-acp", folder, Some(&again_ticket))
        .expect("Never use of claude does not refuse another entry id");
}

/// A fifo named `.git` must not block the judgment. The read used to wait on the fifo while the spawn
/// gate held the session store. Windows has no fifo; the other git-dir tests cover that target.
#[cfg(unix)]
#[test]
fn a_fifo_named_git_does_not_stall_the_judgment() {
    let root = std::env::temp_dir().join(format!("r11-fifo-{}", uuid::Uuid::new_v4()));
    let project = root.join("project");
    let plain = root.join("plain");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&plain).unwrap();
    let git = project.join(".git");
    let made = std::process::Command::new("mkfifo")
        .arg(&git)
        .status()
        .unwrap();
    assert!(made.success(), "mkfifo");
    let store = memory();
    {
        let mut conn = store.lock_conn().unwrap();
        ban(&mut conn, project.to_str().unwrap(), &["codex"], false);
    }
    let plain = plain.to_string_lossy().into_owned();
    let (tx, rx) = std::sync::mpsc::channel();
    // The store lock stays in this thread. A guard cannot move to another thread, and holding it here would
    // deadlock the judgment instead of showing that the `.git` read itself blocks.
    std::thread::spawn(move || {
        let result = (|| {
            let conn = store.lock_conn()?;
            store::projects_owning(&conn, &plain).map(|_| ())
        })();
        let _ = tx.send(result);
    });
    let got = rx.recv_timeout(std::time::Duration::from_secs(2));
    let _ = std::fs::remove_dir_all(&root);
    got.expect("the judgment blocked on a fifo named .git")
        .expect("a fifo project does not own an unrelated folder");
}

#[cfg(windows)]
#[test]
fn a_fifo_named_git_does_not_stall_the_judgment() {
    // Windows has no fifo. Reading only a regular file is covered by the empty-folder git dir test.
}
