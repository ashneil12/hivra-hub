//! Round 12 checks that the round 11 repro file does not already cover.

use serde_json::json;

use super::gate::{check_launch_with, judge_start, record_grant_with, LaunchCheck};
use super::store;
use crate::session_store::SessionStore;

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=r12",
            "-c",
            "user.email=r12@example.invalid",
            "-c",
            "init.defaultBranch=main",
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

/// A worker unregisters its own worktree after its grant was saved. A child it starts still carries that grant's
/// projects, so the project's Never use is not dropped just because the worktree is gone.
#[test]
fn a_child_keeps_the_parent_grant_projects_after_the_worktree_is_unregistered() {
    let root = std::env::temp_dir().join(format!("r12-parent-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "r12-feature",
            worktree.to_str().unwrap(),
        ],
    );
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        repo.to_str().unwrap(),
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
    let repo_key = store::path_key(repo.to_str().unwrap());
    let folder = worktree.to_str().unwrap();
    let parent = LaunchCheck {
        cli: "claude".into(),
        mono: None,
        project: Some(folder.to_string()),
        locked_default: Some("claude".into()),
    };
    record_grant_with(&conn, "app-r12-parent", &parent, None).unwrap();
    std::fs::remove_file(worktree.join(".git")).unwrap();
    git(&repo, &["worktree", "prune"]);
    let child = |cli: &str| LaunchCheck {
        cli: cli.into(),
        mono: None,
        project: Some(folder.to_string()),
        locked_default: Some("claude".into()),
    };
    let refused = check_launch_with(&conn, &child("codex"), Some("app-r12-parent"));
    check_launch_with(&conn, &child("claude"), Some("app-r12-parent"))
        .expect("a CLI the project allows still starts");
    record_grant_with(
        &conn,
        "app-r12-child",
        &child("claude"),
        Some("app-r12-parent"),
    )
    .unwrap();
    let stored = store::grant_of(&conn, "app-r12-child").unwrap().unwrap();
    let later = judge_start(&conn, "app-r12-child", "codex", folder);
    let _ = std::fs::remove_dir_all(&root);
    let err =
        refused.expect_err("the child keeps the parent's Never use after the worktree is gone");
    assert!(err.contains("Never use"), "{err}");
    assert!(
        stored
            .projects
            .iter()
            .any(|id| store::path_key(id) == repo_key),
        "the child grant keeps the project the parent was in: {:?}",
        stored.projects
    );
    let err = later.expect_err("a later start of the child is still refused");
    assert!(err.contains("Never use"), "{err}");
}

/// Opening a git file must not block when the name is a fifo. A symlink to a regular file is still read: git dir files
/// may be links, and refusing every link would drop a real checkout.
#[cfg(unix)]
#[test]
fn a_git_file_that_is_a_fifo_or_a_link_to_one_does_not_block() {
    let root = std::env::temp_dir().join(format!("r12-gitfile-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let fifo = root.join("fifo");
    let made = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap();
    assert!(made.success(), "mkfifo");
    let linked = root.join("linked-fifo");
    std::os::unix::fs::symlink(&fifo, &linked).unwrap();
    let real = root.join("real");
    std::fs::write(&real, "gitdir: /tmp/example.git\n").unwrap();
    let link = root.join("linked-file");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let started = std::time::Instant::now();
    let fifo_read = store::read_git_file(&fifo);
    let link_read = store::read_git_file(&linked);
    let file_read = store::read_git_file(&link);
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "reading a fifo git file blocked"
    );
    assert!(
        fifo_read.is_none(),
        "a fifo is not a git file: {fifo_read:?}"
    );
    assert!(
        link_read.is_none(),
        "a link to a fifo is not a git file: {link_read:?}"
    );
    assert_eq!(file_read.as_deref(), Some("gitdir: /tmp/example.git\n"));
}

#[cfg(windows)]
#[test]
fn a_git_file_that_is_a_fifo_or_a_link_to_one_does_not_block() {
    // Windows has no fifo. The regular-file read is what the other git dir tests cover.
}
