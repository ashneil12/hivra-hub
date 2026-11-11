//! WP-141 follow-up (crew owner leftovers). Each test is a judgment the merged owner work still gets wrong:
//! the refusal sentence wrapped twice, a stray `.git` above a project turning every folder into doubt, and a
//! case-insensitive `.git` name not compared through the canonical path.

use serde_json::json;

use super::gate::judge_start;
use super::store;
use crate::session_store::SessionStore;

const LEAD: &str = "The crew policy could not be read, so nothing was started";

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=r141dreview",
            "-c",
            "user.email=r141dreview@example.invalid",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
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

fn temp_root(tag: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("r141d-review-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A repo with one commit and the folders `inside`, and a linked worktree `<root>/worktree`.
fn repo_and_worktree(
    tag: &str,
    inside: &[&str],
) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let root = temp_root(tag);
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    for folder in inside {
        std::fs::create_dir_all(repo.join(folder)).unwrap();
    }
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let branch = format!("r141dreview-{tag}");
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
    for folder in inside {
        std::fs::create_dir_all(worktree.join(folder)).unwrap();
    }
    (root, repo, worktree)
}

fn ban_codex(conn: &mut rusqlite::Connection, folder: &std::path::Path) {
    store::set_policy(
        conn,
        "project",
        folder.to_str().unwrap(),
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
}

fn codex_in(conn: &rusqlite::Connection, folder: &std::path::Path) -> Result<(), String> {
    judge_start(
        conn,
        "8a1c4e90-r141d-lead-chat",
        "codex",
        folder.to_str().unwrap(),
    )
}

fn lead_count(text: &str) -> usize {
    text.matches(LEAD).count()
}

/// The place cannot be decided, so the launch is refused. The store already says that in one sentence, and the
/// gate must not wrap that sentence again.
#[test]
fn a_doubtful_place_says_the_crew_refusal_once() {
    let root = temp_root("once");
    let broken = root.join("broken");
    let folder = root.join("folder");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(broken.join(".git"), "not a git dir\n").unwrap();
    std::fs::write(folder.join(".git"), "not a git dir\n").unwrap();
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &broken);
    let err = codex_in(&conn, &folder).expect_err("codex is on the doubtful project's Never use");
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(lead_count(&err), 1, "the refusal was wrapped again: {err}");
}

/// A `.git` above the project that is not a repository used to stop the walk, so every folder was undecided,
/// including one the project's own checkout does not own.
#[test]
fn a_stray_unreadable_git_above_a_project_does_not_undecide_every_folder() {
    let (root, repo, worktree) = repo_and_worktree("stray-above", &["pkg"]);
    let package = repo.join("pkg");
    let copy = worktree.join("pkg");
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    git(&elsewhere, &["init", "-q"]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &package);
    std::fs::write(root.join(".git"), "not a git dir\n").unwrap();
    git(&worktree, &["status", "--short"]);
    let owned = codex_in(&conn, &copy);
    let other = codex_in(&conn, &elsewhere);
    let _ = std::fs::remove_dir_all(&root);
    let err = owned.expect_err("the package still owns its copy in the worktree");
    assert!(err.contains("Never use"), "{err}");
    other.expect("a stray .git above the project does not refuse an unrelated folder");
}

/// The stray sits between the package's own repository and the real one. The walk used to stop there, so the
/// worktree copy lost Never use and came back as doubt instead.
#[test]
fn a_stray_unreadable_git_between_a_package_and_its_repo_keeps_never_use() {
    let (root, repo, worktree) = repo_and_worktree("stray-between", &["nest/pkg"]);
    let package = repo.join("nest").join("pkg");
    let copy = worktree.join("nest").join("pkg");
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &package);
    let before = codex_in(&conn, &copy);
    std::fs::write(repo.join("nest").join(".git"), "not a git dir\n").unwrap();
    git(&package, &["init", "-q"]);
    git(&worktree, &["status", "--short"]);
    let after = codex_in(&conn, &copy);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the package owns its copy in the worktree");
    assert!(err.contains("Never use"), "{err}");
    let err =
        after.expect_err("a stray .git between the package and its repo does not drop Never use");
    assert!(
        err.contains("Never use"),
        "the stray turned the judgment into doubt: {err}"
    );
}

/// True when this directory treats `FoldCase` and `foldcase` as one file. A case-sensitive volume skips the test.
fn folds_case(dir: &std::path::Path) -> bool {
    let probe = dir.join("FoldCase");
    if std::fs::write(&probe, b"x").is_err() {
        return false;
    }
    let same = std::fs::read(dir.join("foldcase")).ok().as_deref() == Some(b"x");
    let _ = std::fs::remove_file(&probe);
    same
}

/// Rename `.git` to `.GIT` in two steps. A single rename to a different case can fail on a case-insensitive volume.
fn rename_git_dir(repo: &std::path::Path) -> bool {
    let git = repo.join(".git");
    let tmp = repo.join(".git-case-tmp");
    let upper = repo.join(".GIT");
    if std::fs::rename(&git, &tmp).is_err() || std::fs::rename(&tmp, &upper).is_err() {
        return false;
    }
    std::fs::canonicalize(repo.join(".git"))
        .ok()
        .and_then(|path| path.file_name().map(|name| name == ".GIT"))
        .unwrap_or(false)
}

/// The main checkout is recognised by the canonical `.git` path. On a case-insensitive volume the directory can
/// be named `.GIT` and still be the same folder. Comparing the spelling dropped the package's Never use.
#[test]
fn a_case_renamed_git_dir_still_keeps_never_use_in_a_worktree() {
    let (root, repo, worktree) = repo_and_worktree("git-case", &["pkg"]);
    if !folds_case(&root) {
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    let package = repo.join("pkg");
    let copy = worktree.join("pkg");
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &package);
    assert!(
        rename_git_dir(&repo),
        "the volume did not keep .GIT as the on-disk name"
    );
    git(&worktree, &["status", "--short"]);
    let judged = codex_in(&conn, &copy);
    let _ = std::fs::remove_dir_all(&root);
    let err = judged.expect_err("the package still owns its copy after the git dir is named .GIT");
    assert!(err.contains("Never use"), "{err}");
}
