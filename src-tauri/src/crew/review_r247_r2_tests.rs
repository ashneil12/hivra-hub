//! Review repros for PR #247 round 2 (head a5486d28d). Each test is the next bypass of a round 1 fix: the same goal (a
//! worker's own file writes drop a project's Never use) by the write the fix does not look at. Each one checks that
//! git still works where the worker needs it, and judges a start from a chat with no grant, like the round 1 tests.

use serde_json::json;

use super::gate::judge_start;
use super::store;
use crate::session_store::SessionStore;

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=r247review",
            "-c",
            "user.email=r247review@example.invalid",
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
    let root = std::env::temp_dir().join(format!("r247r2-review-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A repo with one commit and the folders `inside`, and a linked worktree `<root>/worktree` with the same folders.
/// Returns (root, repo, worktree).
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
    let branch = format!("r247r2review-{tag}");
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
        "4c9b1e77-r247r2-lead-chat",
        "codex",
        folder.to_str().unwrap(),
    )
}

/// HIGH (next bypass of r1 #1, the deep top): the fix keeps a registered top between the main checkout and the package
/// only when the registration "round-trips" (the named `.git` file points back at `<common>/worktrees/<id>`). Those are
/// three more files the same worker writes: `<repo>/packages/.git`, and `commondir` + `gitdir` in a new admin dir. The
/// round trip holds, `<repo>/packages` measures the package as `web`, and `<worktree>/packages/web` gets a plain No.
#[test]
fn a_round_tripping_registration_between_the_repo_and_a_deep_package_does_not_drop_the_package() {
    let (root, repo, worktree) = repo_and_worktree("deep-round-trip", &["packages/web"]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    let package = repo.join("packages").join("web");
    let copy = worktree.join("packages").join("web");
    ban_codex(&mut conn, &package);
    let before = codex_in(&conn, &copy);
    let admin = repo.join(".git").join("worktrees").join("x");
    std::fs::create_dir_all(&admin).unwrap();
    std::fs::write(admin.join("commondir"), "../..\n").unwrap();
    std::fs::write(admin.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(
        admin.join("gitdir"),
        format!("{}\n", repo.join("packages").join(".git").display()),
    )
    .unwrap();
    std::fs::write(
        repo.join("packages").join(".git"),
        format!("gitdir: {}\n", admin.display()),
    )
    .unwrap();
    // The worker's own worktree is untouched.
    git(&worktree, &["status", "--short"]);
    let after = codex_in(&conn, &copy);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the package owns its copy in the worktree");
    assert!(err.contains("Never use"), "{err}");
    let err = after.expect_err(
        "a registration the worker wrote to round-trip does not drop the package's Never use",
    );
    assert!(err.contains("Never use"), "{err}");
}

/// HIGH (next bypass of r1 #2, a repository made above the package): `enclosing_common` stops at the NEAREST `.git`
/// above the project's checkout. Two `git init`s, one in the package and one in the folder above it, make the nearest
/// enclosing checkout the worker's second repository, and the real `<repo>/.git` is never asked.
#[test]
fn two_repositories_made_in_and_above_the_package_do_not_drop_the_package() {
    let (root, repo, worktree) = repo_and_worktree("two-inits", &["packages/web"]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    let package = repo.join("packages").join("web");
    let copy = worktree.join("packages").join("web");
    ban_codex(&mut conn, &package);
    let before = codex_in(&conn, &copy);
    git(&repo.join("packages"), &["init", "-q"]);
    git(&package, &["init", "-q"]);
    git(&worktree, &["status", "--short"]);
    let after = codex_in(&conn, &copy);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the package owns its copy in the worktree");
    assert!(err.contains("Never use"), "{err}");
    let err = after.expect_err(
        "two repositories made in and above the package do not drop the package's Never use",
    );
    assert!(err.contains("Never use"), "{err}");
}

/// HIGH (regression from the r1 #4 fix): `common_dir` now stops at a directory that "is already a git admin" (a `HEAD`
/// file and `objects` and `refs` folders) and no longer follows its `commondir`. A linked worktree's admin dir already
/// has `HEAD`; two `mkdir`s in `<repo>/.git/worktrees/wt-a` make it look like a repository of its own. A project saved
/// at worktree `wt-a` (Ash's `~/Worktrees/x` layout) then has its admin dir as its common dir, owns nothing outside
/// itself, and worktree `wt-b` gets a plain No. Git keeps working in `wt-a`: it reads `commondir`.
#[test]
fn admin_folders_added_to_a_worktree_projects_admin_dir_do_not_drop_it_in_a_sibling() {
    let root = temp_root("admin-look");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let first = root.join("wt-a");
    let second = root.join("wt-b");
    for (path, branch) in [(&first, "a"), (&second, "b")] {
        let branch = format!("r247r2review-admin-look-{branch}");
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
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &first);
    let before = codex_in(&conn, &second);
    let admin = repo.join(".git").join("worktrees").join("wt-a");
    std::fs::create_dir_all(admin.join("objects")).unwrap();
    std::fs::create_dir_all(admin.join("refs")).unwrap();
    // Git still works in the project's worktree and still names the shared repository.
    git(&first, &["status", "--short"]);
    git(
        &first,
        &["commit", "-q", "--allow-empty", "-m", "still works"],
    );
    let after = codex_in(&conn, &second);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the project at worktree a owns worktree b");
    assert!(err.contains("Never use"), "{err}");
    let err = after.expect_err(
        "objects/ and refs/ in a worktree's admin dir do not move the project to another repository",
    );
    assert!(err.contains("Never use"), "{err}");
}

/// HIGH (next bypass of r1 #7, the emptied registration): the fix adds the folder's own checkout as a top through
/// `folder_checkout_top`, which asks `common_dir` of the folder's `.git`. The worker empties its registration as in r1 #7
/// and adds `objects/` and `refs/` to its own admin dir, so `common_dir` stops at the admin dir and the folder's top is
/// dropped again. The project is the main checkout, the worker is in a linked worktree: Ash's everyday layout.
#[test]
fn an_emptied_registration_and_an_admin_looking_admin_dir_do_not_drop_the_project() {
    let (root, repo, worktree) = repo_and_worktree("emptied-admin-look", &[]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo);
    let before = codex_in(&conn, &worktree);
    let admin = repo.join(".git").join("worktrees").join("worktree");
    std::fs::write(admin.join("gitdir"), "\n").unwrap();
    std::fs::create_dir_all(admin.join("objects")).unwrap();
    std::fs::create_dir_all(admin.join("refs")).unwrap();
    git(&worktree, &["status", "--short"]);
    git(
        &worktree,
        &["commit", "-q", "--allow-empty", "-m", "still works"],
    );
    let after = codex_in(&conn, &worktree);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the project owns its worktree");
    assert!(err.contains("Never use"), "{err}");
    let err = after.expect_err(
        "a worktree whose .git still names the project's repository keeps the project's Never use",
    );
    assert!(err.contains("Never use"), "{err}");
}

/// HIGH (next bypass of r1 #7): `folder_checkout_top` counts the folder only when its `.git` file names
/// `<common>/worktrees/<id>`. The worker moves its admin dir into its own worktree (`.adm`, with `commondir` naming the
/// project's `.git`), points its `.git` file there and empties the old registration. Git works in the folder against the
/// project's repository, but the folder is in no top and gets a plain No.
#[test]
fn a_worktree_admin_moved_out_of_worktrees_does_not_drop_the_project() {
    let (root, repo, worktree) = repo_and_worktree("moved-admin", &[]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo);
    let before = codex_in(&conn, &worktree);
    let old_admin = repo.join(".git").join("worktrees").join("worktree");
    let new_admin = worktree.join(".adm");
    std::fs::create_dir_all(&new_admin).unwrap();
    for name in ["HEAD", "index"] {
        std::fs::copy(old_admin.join(name), new_admin.join(name)).unwrap();
    }
    std::fs::write(
        new_admin.join("commondir"),
        format!("{}\n", repo.join(".git").display()),
    )
    .unwrap();
    std::fs::write(
        worktree.join(".git"),
        format!("gitdir: {}\n", new_admin.display()),
    )
    .unwrap();
    std::fs::remove_dir_all(&old_admin).unwrap();
    // Git works in the folder, against the project's repository.
    git(&worktree, &["status", "--short"]);
    git(
        &worktree,
        &["commit", "-q", "--allow-empty", "-m", "still works"],
    );
    git(&repo, &["log", "-1", "r247r2review-moved-admin"]);
    let after = codex_in(&conn, &worktree);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the project owns its worktree");
    assert!(err.contains("Never use"), "{err}");
    // The folder is in no top, so its place is undecided; a project whose Never use lists the CLI then refuses.
    assert!(
        after.is_err(),
        "a worktree whose .git still names the project's repository keeps the project's Never use"
    );
}
