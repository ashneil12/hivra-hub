//! Review repros for PR #194 round 11 (head f91297483). Each test states the behaviour the package promises; the ones
//! that fail on f91297483 are the findings. They use real git checkouts in a temp folder, like the round 10 tests.

use serde_json::json;

use super::gate::judge_start;
use super::store;
use crate::session_store::SessionStore;

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=r11review",
            "-c",
            "user.email=r11review@example.invalid",
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
    let root = std::env::temp_dir().join(format!("r11-review-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A repo with one commit and a linked worktree next to it. Returns (root, repo, worktree).
fn repo_with_worktree(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let root = temp_root(tag);
    let repo = root.join("repo");
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let branch = format!("r11review-{tag}");
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

fn route_in(conn: &rusqlite::Connection, folder: &std::path::Path) -> Result<(), String> {
    let query: store::RouteQuery =
        serde_json::from_value(json!({ "project": folder.to_str().unwrap() })).unwrap();
    store::route(conn, &query, &[]).map(|_| ())
}

/// A worker's checkout of a repo whose git dir is not a `.git` folder (a bare repo with worktrees, or
/// `git init --separate-git-dir`). Returns (root, project, worker, untouched sibling worktree).
fn decoy_layout(
    tag: &str,
    bare: bool,
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let root = temp_root(tag);
    let (git_home, project) = if bare {
        let seed = root.join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        git(&seed, &["init", "-q"]);
        git(&seed, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git(
            &root,
            &["clone", "-q", "--bare", seed.to_str().unwrap(), "repo.git"],
        );
        let main = root.join("main");
        git(
            &root.join("repo.git"),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "r11-main",
                main.to_str().unwrap(),
            ],
        );
        (root.join("repo.git"), main)
    } else {
        let project = root.join("repo");
        let gitdir = root.join("gd");
        git(
            &root,
            &[
                "init",
                "-q",
                &format!("--separate-git-dir={}", gitdir.display()),
                project.to_str().unwrap(),
            ],
        );
        git(&project, &["commit", "-q", "--allow-empty", "-m", "init"]);
        (project.clone(), project)
    };
    let worker = root.join("feature");
    let sibling = root.join("sibling");
    git(
        &git_home,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "r11-feature",
            worker.to_str().unwrap(),
        ],
    );
    git(
        &git_home,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "r11-sibling",
            sibling.to_str().unwrap(),
        ],
    );
    (root, project, worker, sibling)
}

/// The worker rewrites its own `.git` file to name a repository it made itself. Git reads that repository happily,
/// so a membership read that asks git about the folder's own `.git` sees "another repo" and drops the project.
fn point_git_at_a_decoy(root: &std::path::Path, worker: &std::path::Path) {
    let decoy = root.join("decoy");
    std::fs::create_dir_all(&decoy).unwrap();
    git(&decoy, &["init", "-q"]);
    std::fs::write(
        worker.join(".git"),
        format!("gitdir: {}\n", decoy.join(".git").display()),
    )
    .unwrap();
}

/// MED (regression from round 10's project-side read): a hub project saved at a linked worktree's folder makes every
/// other folder of that repo "undecided" (`place_inside_common` passes the MAIN checkout as the project's top, and a
/// root in a linked worktree is not inside it, so `owns_within_checkout` errors). The route and the owners read have no
/// CLI, so they fail closed: every route in the main checkout is refused for a project that bans nothing relevant.
/// Round 10 read the root's own top from git and answered.
#[test]
fn a_project_saved_at_a_linked_worktree_does_not_refuse_routes_elsewhere_in_its_repo() {
    let (root, repo, worktree) = repo_with_worktree("wt-project");
    let src = repo.join("src");
    std::fs::create_dir_all(&src).unwrap();
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &worktree);
    let owners = store::projects_owning(&conn, src.to_str().unwrap());
    let route = route_in(&conn, &src);
    let _ = std::fs::remove_dir_all(&root);
    owners.expect("the owners of a main-checkout folder can be read");
    route.expect("a route in the main checkout is not refused");
}

/// MED (same root cause, loosening direction): when the worktrees live INSIDE the main checkout (`<repo>/.worktrees/a`),
/// a project saved at worktree `a` is "inside" the main top, so `owns_within_checkout(.., root, main)` measures the
/// project as `.worktrees/a` instead of the worktree's top and answers a plain No for every other checkout. The
/// project's Never use is dropped in worktree `b`, which round 10 (root top read from the root's own checkout) owned.
#[test]
fn a_project_saved_at_a_nested_worktree_keeps_never_use_in_a_sibling_worktree() {
    let root = temp_root("nested-wt");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let first = repo.join(".worktrees").join("a");
    let second = repo.join(".worktrees").join("b");
    for (path, branch) in [(&first, "r11-nested-a"), (&second, "r11-nested-b")] {
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                branch,
                path.to_str().unwrap(),
            ],
        );
    }
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &first);
    let judged = codex_in(&conn, &second);
    let _ = std::fs::remove_dir_all(&root);
    let err =
        judged.expect_err("the project saved at worktree a owns the same place in worktree b");
    assert!(err.contains("Never use"), "{err}");
}

/// MED: the same, with no crew policy saved anywhere. `crew_projects_owning` gets every hub project folder as a root
/// (round 11) and has no CLI, so one hub project at a linked worktree refuses the owners read, and with it the
/// worker default every sessions.start, delegate_task and crew pick reads (projectDefaultFor): every launch in that
/// repo is refused although no policy exists.
#[test]
fn a_hub_project_at_a_linked_worktree_does_not_refuse_the_default_read_elsewhere_in_its_repo() {
    let (root, repo, worktree) = repo_with_worktree("wt-hub-root");
    let src = repo.join("src");
    std::fs::create_dir_all(&src).unwrap();
    let store = SessionStore::open_in_memory().unwrap();
    let conn = store.lock_conn().unwrap();
    let roots = vec![
        repo.to_string_lossy().into_owned(),
        worktree.to_string_lossy().into_owned(),
    ];
    let owners = store::projects_owning_for(
        &conn,
        src.to_str().unwrap(),
        &store::OwningQuery {
            roots: &roots,
            cli: None,
            agent: false,
        },
    );
    let _ = std::fs::remove_dir_all(&root);
    let owners = owners.expect("no crew policy exists, so the default read is not refused");
    assert!(
        owners
            .iter()
            .any(|owner| store::path_key(owner) == store::path_key(&roots[0])),
        "the main checkout's project owns its own folder: {owners:?}"
    );
}

/// MED: for a repo whose git dir is not named `.git` (bare repo + worktrees), `main_checkout_top` is None and the
/// membership falls back to `place_by_git`, which asks git about the FOLDER's own `.git`. A worker points that file at
/// a repo it made: git answers with a different common dir and the project's Never use is dropped.
#[test]
fn a_bare_repo_worktree_keeps_never_use_when_its_git_file_names_another_repo() {
    let (root, project, worker, sibling) = decoy_layout("bare-decoy", true);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &project);
    // The layout is owned as a worktree should be (an untouched sibling worktree is refused).
    let untouched = codex_in(&conn, &sibling);
    point_git_at_a_decoy(&root, &worker);
    let tampered = codex_in(&conn, &worker);
    let _ = std::fs::remove_dir_all(&root);
    let err = untouched.expect_err("a sibling worktree of a bare repo is owned by the project");
    assert!(err.contains("Never use"), "{err}");
    let err = tampered
        .expect_err("a .git file naming another repo must not drop the project's Never use");
    assert!(err.contains("Never use"), "{err}");
}

/// MED: the same escape for `git init --separate-git-dir` (the main checkout's `.git` is a file, so its common dir is
/// not named `.git` either). Submodule projects take the same `place_by_git` path.
#[test]
fn a_separate_git_dir_worktree_keeps_never_use_when_its_git_file_names_another_repo() {
    let (root, project, worker, sibling) = decoy_layout("sep-decoy", false);
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &project);
    let untouched = codex_in(&conn, &sibling);
    point_git_at_a_decoy(&root, &worker);
    let tampered = codex_in(&conn, &worker);
    let _ = std::fs::remove_dir_all(&root);
    let err = untouched.expect_err("a sibling worktree is owned by the project");
    assert!(err.contains("Never use"), "{err}");
    let err = tampered
        .expect_err("a .git file naming another repo must not drop the project's Never use");
    assert!(err.contains("Never use"), "{err}");
}

/// MED (fail-open error path): a package project (`<repo>/pkg`) owns `<worktree>/pkg` through the repo's git dir.
/// A garbage `.git` file written into the project's own folder makes `git_entry` stop there, `common_dir` read None,
/// git fail ("invalid gitfile format"), and `place_by_git` return `Place::No` because the FOLDER is readable. The
/// project's Never use is dropped for every worktree copy of the package. An unreadable project side must not read as
/// "not owned" when the project sits inside the folder's own repository.
#[test]
fn a_package_project_with_a_bad_git_file_keeps_its_worktree_copies() {
    let (root, repo, worktree) = repo_with_worktree("pkg-bad-git");
    let package = repo.join("pkg");
    std::fs::create_dir_all(&package).unwrap();
    let copy = worktree.join("pkg");
    std::fs::create_dir_all(&copy).unwrap();
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    ban_codex(&mut conn, &package);
    let before = codex_in(&conn, &copy);
    std::fs::write(package.join(".git"), "not a gitfile\n").unwrap();
    let after = codex_in(&conn, &copy);
    let _ = std::fs::remove_dir_all(&root);
    let err = before.expect_err("the package's worktree copy is owned");
    assert!(err.contains("Never use"), "{err}");
    let err = after
        .expect_err("a bad .git in the project folder must not drop its Never use in a worktree");
    assert!(err.contains("Never use"), "{err}");
}

/// LOW: owners come back in the crew row's spelling even when the caller passed the hub project's folder as a root
/// (`candidate_ids`: "the crew row's spelling wins"). The webview maps an owner to its hub project by text
/// (`hubProjectIdFor` -> `pathKey`), so when the saved row is the canonical path and the hub folder is a symlinked
/// spelling, the owner maps to no project and the worker default falls to the system's under the lock.
#[cfg(unix)]
#[test]
fn an_owner_found_through_a_hub_root_comes_back_in_the_roots_spelling() {
    let root = temp_root("spelling");
    let real = root.join("real");
    std::fs::create_dir_all(&real).unwrap();
    let repo = real.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let worktree = root.join("worktree");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "r11-spelling",
            worktree.to_str().unwrap(),
        ],
    );
    let link = root.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let hub_folder = link.join("repo").to_string_lossy().into_owned();
    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    // Settings saves the project's crew row from the hub folder; the row key is the canonical path.
    store::set_policy(
        &mut conn,
        "project",
        &hub_folder,
        &json!({ "lockDefault": true, "neverUse": [], "fallback": [] }),
        0,
    )
    .unwrap();
    let roots = vec![hub_folder.clone()];
    let owners = store::projects_owning_for(
        &conn,
        worktree.to_str().unwrap(),
        &store::OwningQuery {
            roots: &roots,
            cli: None,
            agent: false,
        },
    );
    let _ = std::fs::remove_dir_all(&root);
    let owners = owners.unwrap();
    assert!(
        owners.contains(&hub_folder),
        "the webview maps owners by the hub folder's text, so it must get that spelling back: {owners:?}"
    );
}
