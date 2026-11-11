//! Review repros for PR #247 round 1 (head e0c4ff509). Each test states the behaviour the package promises; the ones
//! that fail on e0c4ff509 are the findings. They use real git checkouts in a temp folder, like the round 12 tests, and
//! judge a start from a chat with no grant, so the folder judgment alone has to hold.

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
    let root = std::env::temp_dir().join(format!("r247-review-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A repo with one commit and the folders `inside` (relative), and a linked worktree next to it with the same folders.
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
    let branch = format!("r247review-{tag}");
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
        "4c9b1e77-r247-lead-chat",
        "codex",
        folder.to_str().unwrap(),
    )
}

/// MED: the project's top is the LONGEST registered top that contains the project. For a package two levels down
/// (`<repo>/packages/web`), one line in `<repo>/.git/worktrees/x/gitdir` naming `<repo>/packages/.git` makes
/// `<repo>/packages` a top, the project measures as `web`, and `<worktree>/packages/web` (relative `packages/web` from
/// its real top) no longer maps into it. This is MED-A's write aimed at the project's side instead of the folder's.
#[test]
fn a_registered_top_between_the_repo_and_a_deep_package_does_not_drop_the_package() {
    let (root, repo, worktree) = repo_and_worktree("deep-top", &["packages/web"]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    let package = repo.join("packages").join("web");
    let copy = worktree.join("packages").join("web");
    ban_codex(&mut conn, &package);
    let before = codex_in(&conn, &copy);
    let fake = repo.join(".git").join("worktrees").join("x");
    std::fs::create_dir_all(&fake).unwrap();
    std::fs::write(
        fake.join("gitdir"),
        format!("{}\n", repo.join("packages").join(".git").display()),
    )
    .unwrap();
    let after = codex_in(&conn, &copy);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the package owns its copy in the worktree");
    assert!(err.contains("Never use"), "{err}");
    let err = after.expect_err(
        "a registration naming a folder above the package does not drop the package's Never use",
    );
    assert!(err.contains("Never use"), "{err}");
}

/// MED (MED-C one level up): the fix judges through the enclosing checkout only when the PROJECT folder is itself the
/// new checkout. A worker that runs `git init` in a folder between the package and the repo top (`<repo>/packages`)
/// gives the package a nearest `.git` whose only top is `<repo>/packages`, and the project is not that checkout's top,
/// so the enclosing checkout is never asked.
#[test]
fn a_repository_made_above_the_package_does_not_drop_the_package_in_a_worktree() {
    let (root, repo, worktree) = repo_and_worktree("init-above", &["packages/web"]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    let package = repo.join("packages").join("web");
    let copy = worktree.join("packages").join("web");
    ban_codex(&mut conn, &package);
    let before = codex_in(&conn, &copy);
    git(&repo.join("packages"), &["init", "-q"]);
    let after = codex_in(&conn, &copy);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the package owns its copy in the worktree");
    assert!(err.contains("Never use"), "{err}");
    let err = after
        .expect_err("a repository made above the package does not drop the package's Never use");
    assert!(err.contains("Never use"), "{err}");
}

/// MED (MED-C + MED-D's write): `enclosing_common` skips a `.git` whose common dir it cannot read and keeps walking up.
/// A worker runs `git init` in the package and pads `<repo>/.git/commondir` past `GIT_FILE_CAP` (git still reads the
/// repo). The enclosing checkout is skipped, `place_project` falls back to the inner repository's plain No, and every
/// worktree copy of the package loses its Never use.
#[test]
fn a_repository_made_in_the_package_keeps_it_when_the_main_git_cannot_be_read_by_the_judgment() {
    let (root, repo, worktree) = repo_and_worktree("init-padded", &["pkg"]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    let package = repo.join("pkg");
    let copy = worktree.join("pkg");
    ban_codex(&mut conn, &package);
    let before = codex_in(&conn, &copy);
    git(&package, &["init", "-q"]);
    let mut padded = String::from(".\n");
    padded.push_str(&"\n".repeat(9000));
    std::fs::write(repo.join(".git").join("commondir"), padded).unwrap();
    // Git still reads the main repository and the worktree.
    git(&repo, &["rev-parse", "--git-common-dir", "--show-toplevel"]);
    git(
        &worktree,
        &["rev-parse", "--git-common-dir", "--show-toplevel"],
    );
    let after = codex_in(&conn, &copy);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the package owns its copy in the worktree");
    assert!(err.contains("Never use"), "{err}");
    let err = after.expect_err(
        "an enclosing .git the judgment cannot read is doubt, not a reason to skip to the inner repository",
    );
    assert!(err.contains("Never use"), "{err}");
}

/// MED: `common_dir` follows a `commondir` file inside the main `.git` FOLDER (git never writes one there). A worker
/// writes `<repo>/.git/commondir` naming a repository it made in its own worktree, and registers `<repo>/.git` in that
/// decoy's `worktrees/*/gitdir`. `known_checkout` then calls the project a registered checkout of the decoy, the only
/// tops are the decoy's, the worktree is in none of them, and the project's Never use is dropped. The worktree's own
/// git keeps working: its admin dir's `commondir` still names the real `.git`.
#[test]
fn a_main_git_commondir_naming_a_decoy_does_not_drop_the_project() {
    let (root, repo, worktree) = repo_and_worktree("decoy-commondir", &[]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo);
    let before = codex_in(&conn, &worktree);
    let decoy = worktree.join("decoy");
    std::fs::create_dir_all(&decoy).unwrap();
    git(&decoy, &["init", "-q"]);
    let registration = decoy.join(".git").join("worktrees").join("main");
    std::fs::create_dir_all(&registration).unwrap();
    std::fs::write(
        registration.join("gitdir"),
        format!("{}\n", repo.join(".git").display()),
    )
    .unwrap();
    std::fs::write(
        repo.join(".git").join("commondir"),
        format!("{}\n", decoy.join(".git").display()),
    )
    .unwrap();
    git(
        &worktree,
        &["rev-parse", "--git-common-dir", "--show-toplevel"],
    );
    let after = codex_in(&conn, &worktree);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the project owns its worktree");
    assert!(err.contains("Never use"), "{err}");
    let err = after.expect_err(
        "a commondir a worker wrote into the main .git does not move the project to another repository",
    );
    assert!(err.contains("Never use"), "{err}");
}

/// MED (separate git dir): when the common dir is not named `.git`, `checkout_tops` takes the project's top from
/// `git rev-parse --show-toplevel` on the project, and git honours `core.worktree` from the common dir's config. A
/// worker sets it to the folder above the repo: the project's top becomes `<root>`, the project measures as `repo`, and
/// no top maps the worktree into `repo`. The `.git` file's mtime is bumped so the checkout cache reads git again.
#[test]
fn a_core_worktree_in_a_separate_git_dir_does_not_drop_the_project() {
    let root = temp_root("core-worktree");
    let repo = root.join("repo");
    let separate = root.join("separate.git");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    git(
        &repo,
        &[
            "init",
            "-q",
            "--separate-git-dir",
            separate.to_str().unwrap(),
        ],
    );
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "r247review-core-worktree",
            worktree.to_str().unwrap(),
        ],
    );
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo);
    let before = codex_in(&conn, &worktree);
    git(&repo, &["config", "core.worktree", root.to_str().unwrap()]);
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    std::fs::File::options()
        .write(true)
        .open(repo.join(".git"))
        .unwrap()
        .set_modified(later)
        .unwrap();
    let after = codex_in(&conn, &worktree);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the project owns its worktree");
    assert!(err.contains("Never use"), "{err}");
    let err = after
        .expect_err("core.worktree in the common dir's config does not move the project's top");
    assert!(err.contains("Never use"), "{err}");
}

/// MED (regression from origin/main): a project saved at a linked worktree OUTSIDE the main checkout (the usual
/// `~/Worktrees/x` layout) with garbage in its `.git` file. On main, `place_unreadable_root` found the root outside the
/// folder's main checkout and answered Undecided, which refuses a CLI the project bans. Now `enclosing_common` finds
/// no checkout above a sibling worktree and the readable folder gets a plain No, so codex starts in a sibling worktree
/// the project owned a moment before.
#[test]
fn an_unreadable_sibling_worktree_project_keeps_never_use_in_another_worktree() {
    let root = temp_root("sibling-garbage");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let first = root.join("wt-a");
    let second = root.join("wt-b");
    for (path, branch) in [(&first, "a"), (&second, "b")] {
        let branch = format!("r247review-sibling-{branch}");
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
    std::fs::write(first.join(".git"), "not a git file\n").unwrap();
    let after = codex_in(&conn, &second);
    let _ = std::fs::remove_dir_all(&root);
    assert!(before.is_err(), "the project at worktree a owns worktree b");
    assert!(
        after.is_err(),
        "a garbage .git in the project's sibling worktree must not turn its place into a plain No"
    );
}

/// MED (MED-B's write aimed at the folder's side): `worktrees/<id>/gitdir` is only git's back-pointer; git does not
/// read it to work in the worktree. Emptying it (in the common dir, for the worker's own worktree or any other one)
/// takes the worktree out of the registered tops while its `.git` file still names this repository's admin dir and git
/// keeps working there. The folder is then in none of the tops, so it is not owned and the project's Never use is
/// dropped there. Unlike `rm .git && git worktree prune`, the folder is still a working checkout of the project.
#[test]
fn an_emptied_registration_does_not_drop_the_project_in_a_working_worktree() {
    let (root, repo, worktree) = repo_and_worktree("emptied-own", &[]);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &repo);
    let before = codex_in(&conn, &worktree);
    std::fs::write(
        repo.join(".git")
            .join("worktrees")
            .join("worktree")
            .join("gitdir"),
        "\n",
    )
    .unwrap();
    // Git still works in the worktree, and still names the project's repository as its common dir.
    git(
        &worktree,
        &["rev-parse", "--git-common-dir", "--show-toplevel"],
    );
    git(&worktree, &["status", "--short"]);
    let after = codex_in(&conn, &worktree);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the project owns its worktree");
    assert!(err.contains("Never use"), "{err}");
    let err = after.expect_err(
        "a worktree whose .git still names the project's repository keeps the project's Never use",
    );
    assert!(err.contains("Never use"), "{err}");
}
