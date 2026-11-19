//! Review repros for PR #194 round 12 (head e7ef79284). Each test states the behaviour the package promises; the ones
//! that fail on e7ef79284 are the findings. They use real git checkouts in a temp folder, like the round 11 tests.

use serde_json::json;

use super::gate::judge_start;
use super::store;
use crate::session_store::SessionStore;

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=r12review",
            "-c",
            "user.email=r12review@example.invalid",
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

fn temp_root(tag: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("r12-review-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A repo with one commit and a `pkg` folder, and a linked worktree next to it that has its own `pkg` folder.
/// Returns (root, repo, worktree).
fn repo_with_pkg_and_worktree(
    tag: &str,
) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let root = temp_root(tag);
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(repo.join("pkg")).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let branch = format!("r12review-{tag}");
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
    std::fs::create_dir_all(worktree.join("pkg")).unwrap();
    (root, repo, worktree)
}

/// A repo with worktrees nested inside the main checkout (`<repo>/.worktrees/a` and `b`). Returns (root, repo, a, b).
fn repo_with_nested_worktrees(
    tag: &str,
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let root = temp_root(tag);
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let first = repo.join(".worktrees").join("a");
    let second = repo.join(".worktrees").join("b");
    for (path, branch) in [(&first, "a"), (&second, "b")] {
        let branch = format!("r12review-{tag}-{branch}");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                &branch,
                path.to_str().unwrap(),
            ],
        );
    }
    (root, repo, first, second)
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
        "7d3e5c2a-lead-chat",
        "codex",
        folder.to_str().unwrap(),
    )
}

/// MED (regression from round 11): `place_inside_common` now takes only the LONGEST registered top that contains the
/// folder. Registered tops are files under the common dir that any worker can write. One line in
/// `<repo>/.git/worktrees/x/gitdir` naming `<worktree>/pkg/.git` makes `<worktree>/pkg` its own "top", so the folder's
/// relative path is "" and the package project (relative "pkg") no longer owns its own folder in the worktree. Round
/// 11 owned the folder when ANY containing top mapped it into the package.
#[test]
fn a_registered_top_inside_the_package_does_not_drop_the_package_in_a_worktree() {
    let (root, repo, worktree) = repo_with_pkg_and_worktree("fake-top");
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo.join("pkg"));
    let before = codex_in(&conn, &worktree.join("pkg"));
    let fake = repo.join(".git").join("worktrees").join("x");
    std::fs::create_dir_all(&fake).unwrap();
    std::fs::write(
        fake.join("gitdir"),
        format!("{}\n", worktree.join("pkg").join(".git").display()),
    )
    .unwrap();
    let after = codex_in(&conn, &worktree.join("pkg"));
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        before.is_err(),
        "the package owns its folder in the worktree"
    );
    let err = after
        .expect_err("a registration file a worker wrote does not drop the package's Never use");
    assert!(err.contains("Never use"), "{err}");
}

/// MED (same cause, through plain git): a worker in a linked worktree runs `git worktree add pkg/inner`. The new
/// checkout sits inside the package's folder of the worker's worktree, as `<repo>/pkg/inner` would in the main checkout
/// (owned there by the folder rule). The longest top is the new checkout, so the package no longer owns it.
#[test]
fn a_worktree_added_inside_the_package_of_a_worktree_stays_owned_by_the_package() {
    let (root, repo, worktree) = repo_with_pkg_and_worktree("nested-add");
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo.join("pkg"));
    let inner = worktree.join("pkg").join("inner");
    git(
        &worktree,
        &["worktree", "add", "-q", "--detach", inner.to_str().unwrap()],
    );
    let judged = codex_in(&conn, &inner);
    let _ = std::fs::remove_dir_all(&root);
    let err =
        judged.expect_err("a folder inside the package's folder of a worktree is the package's");
    assert!(err.contains("Never use"), "{err}");
}

/// MED (MED-3 partly open): the project is saved at a worktree nested in the main checkout (`<repo>/.worktrees/a`),
/// and a worker writes garbage into its `.git` file. `place_unreadable_root` measures the root from the MAIN checkout
/// (`.worktrees/a`) instead of its own checkout, so worktree `b` gets a plain No and codex starts there. It should be
/// owned, or at least undecided (which refuses, since the project bans codex).
#[test]
fn an_unreadable_nested_worktree_project_is_not_measured_from_the_main_checkout() {
    let (root, _repo, first, second) = repo_with_nested_worktrees("garbage-nested");
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &first);
    let before = codex_in(&conn, &second);
    std::fs::write(first.join(".git"), "not a git file\n").unwrap();
    let after = codex_in(&conn, &second);
    let _ = std::fs::remove_dir_all(&root);
    assert!(before.is_err(), "the project at worktree a owns worktree b");
    assert!(
        after.is_err(),
        "a garbage .git in the project's worktree must not turn its place into a plain No"
    );
}

/// MED (same, through the registration): the worker rewrites `<repo>/.git/worktrees/a/gitdir`, the back-pointer of
/// the project's own worktree. That top drops out of the registered list, the project's top falls back to the main
/// checkout, the project measures as `.worktrees/a`, and worktree `b` gets a plain No.
#[test]
fn a_broken_registration_does_not_move_a_nested_worktree_project_to_the_main_checkout() {
    let (root, repo, first, second) = repo_with_nested_worktrees("broken-reg");
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &first);
    let before = codex_in(&conn, &second);
    std::fs::write(
        repo.join(".git").join("worktrees").join("a").join("gitdir"),
        "\n",
    )
    .unwrap();
    let after = codex_in(&conn, &second);
    let _ = std::fs::remove_dir_all(&root);
    assert!(before.is_err(), "the project at worktree a owns worktree b");
    assert!(
        after.is_err(),
        "a registration a worker emptied must not move the project's top to the main checkout"
    );
}

/// MED (MED-3's write, with a valid repository instead of garbage): a worker runs `git init` in the MAIN checkout's
/// package folder. The package's `.git` now names its own common dir, whose only top is `<repo>/pkg`, so no linked
/// worktree is in it and every `<worktree>/pkg` copy loses the package's Never use.
#[test]
fn a_repository_made_inside_the_package_does_not_drop_the_package_in_a_worktree() {
    let (root, repo, worktree) = repo_with_pkg_and_worktree("nested-init");
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo.join("pkg"));
    let before = codex_in(&conn, &worktree.join("pkg"));
    git(&repo.join("pkg"), &["init", "-q"]);
    let after = codex_in(&conn, &worktree.join("pkg"));
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        before.is_err(),
        "the package owns its folder in the worktree"
    );
    let err = after
        .expect_err("a repository made inside the package does not drop the package's Never use");
    assert!(err.contains("Never use"), "{err}");
}

/// MED (MED-2 partly open): `place_by_git` still asks git about the folder's OWN `.git` (`mine.common != theirs.common`
/// is a plain No). It is reached whenever the project's `.git` is readable by git but not by `common_dir`. One way: a
/// worker pads `<repo>/.git/commondir` (".", then 9000 newlines) past `GIT_FILE_CAP`. Git trims the newlines and reads
/// the repo as before; `common_dir` refuses the file, so the project falls to `place_by_git`, and the worker's decoy
/// `.git` (the round 11 MED-2 write) answers No.
#[test]
fn a_padded_commondir_does_not_send_the_project_to_the_folders_own_git() {
    let (root, repo, worktree) = repo_with_pkg_and_worktree("padded-commondir");
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo);
    let before = codex_in(&conn, &worktree);
    let mut padded = String::from(".\n");
    padded.push_str(&"\n".repeat(9000));
    std::fs::write(repo.join(".git").join("commondir"), padded).unwrap();
    // Git still reads the project's repository.
    git(&repo, &["rev-parse", "--git-common-dir", "--show-toplevel"]);
    let decoy = root.join("decoy");
    std::fs::create_dir_all(&decoy).unwrap();
    git(&decoy, &["init", "-q"]);
    std::fs::write(
        worktree.join(".git"),
        format!("gitdir: {}\n", decoy.join(".git").display()),
    )
    .unwrap();
    let after = codex_in(&conn, &worktree);
    let _ = std::fs::remove_dir_all(&root);
    assert!(before.is_err(), "the project owns its worktree");
    let err = after.expect_err("the worker's own .git does not decide whether the project owns it");
    assert!(err.contains("Never use"), "{err}");
}

/// MED (MED-3's fix bypassed through the folder's own `.git`): with garbage in `<repo>/pkg/.git`, `place_unreadable_root`
/// takes the folder's checkout top from git run on the FOLDER. The worker writes `<worktree>/pkg/.git` naming the main
/// git dir, git then calls `<worktree>/pkg` a checkout top, the folder's relative path is "", and the package
/// (relative "pkg") gets a plain No.
#[test]
fn an_unreadable_package_is_not_measured_from_a_top_the_folder_names_itself() {
    let (root, repo, worktree) = repo_with_pkg_and_worktree("garbage-and-gitfile");
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo.join("pkg"));
    std::fs::write(repo.join("pkg").join(".git"), "not a git file\n").unwrap();
    let garbage_only = codex_in(&conn, &worktree.join("pkg"));
    std::fs::write(
        worktree.join("pkg").join(".git"),
        format!("gitdir: {}\n", repo.join(".git").display()),
    )
    .unwrap();
    let after = codex_in(&conn, &worktree.join("pkg"));
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        garbage_only.is_err(),
        "round 12 keeps the package with garbage alone"
    );
    assert!(
        after.is_err(),
        "a .git file the worker wrote in the folder does not decide the folder's place"
    );
}
