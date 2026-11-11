//! Review repros for PR #194 round 10 (head b28d877f9). Each test states the behaviour the package promises; the ones
//! that fail on b28d877f9 are the findings. They use real git checkouts in a temp folder, like the round 10 test.

use serde_json::json;

use super::gate::judge_spawn;
use super::store;
use crate::session_store::SessionStore;

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=r10",
            "-c",
            "user.email=r10@example.invalid",
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

/// A repo with one commit and a linked worktree next to it. Returns (root, repo, worktree).
fn repo_with_worktree(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("r10-review-{tag}-{}", uuid::Uuid::new_v4()));
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
            tag,
            worktree.to_str().unwrap(),
        ],
    );
    (root, repo, worktree)
}

fn ban_codex(store: &SessionStore, repo: &std::path::Path) {
    let mut conn = store.lock_conn().unwrap();
    store::set_policy(
        &mut conn,
        "project",
        repo.to_str().unwrap(),
        &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
        0,
    )
    .unwrap();
}

fn judge_codex(store: &SessionStore, folder: &std::path::Path) -> Result<(), String> {
    let conn = store.lock_conn().unwrap();
    judge_spawn(
        &conn,
        "7d3e5c2a-lead-chat",
        "codex",
        folder.to_str().unwrap(),
        None,
    )
}

/// MED-1a: round 10 refuses a worktree whose `.git` file is garbage, but the same tamper written as a `gitdir:` line
/// naming any folder that exists (not a git directory) still escapes: `common_from_entry` returns that folder as the
/// common directory, so the git fallback never runs. git itself says "not a git repository" here.
#[test]
fn a_worktree_git_file_naming_a_folder_that_is_not_a_repository_keeps_the_refusal() {
    let (root, repo, worktree) = repo_with_worktree("r10-nonrepo");
    let store = SessionStore::open_in_memory().unwrap();
    ban_codex(&store, &repo);
    std::fs::write(
        worktree.join(".git"),
        format!("gitdir: {}\n", root.display()),
    )
    .unwrap();
    let judged = judge_codex(&store, &worktree);
    let _ = std::fs::remove_dir_all(&root);
    judged.expect_err(
        "a worktree whose .git names a folder that is not a git directory must not drop its project's Never use",
    );
}

/// MED-1b: the same escape when the worktree's `.git` file is replaced by an empty folder. git fails on it
/// ("not a git repository"), the file read takes the empty folder as its own common directory.
#[test]
fn a_worktree_whose_git_file_became_an_empty_folder_keeps_the_refusal() {
    let (root, repo, worktree) = repo_with_worktree("r10-emptydir");
    let store = SessionStore::open_in_memory().unwrap();
    ban_codex(&store, &repo);
    std::fs::remove_file(worktree.join(".git")).unwrap();
    std::fs::create_dir(worktree.join(".git")).unwrap();
    let judged = judge_codex(&store, &worktree);
    let _ = std::fs::remove_dir_all(&root);
    judged.expect_err(
        "a worktree whose .git became an empty folder must not drop its project's Never use",
    );
}

/// MED-1c: a stray, empty `.git` folder in a subfolder of a valid worktree. git walks past it and says the folder is
/// the project's worktree; the judgment reads only the nearest `.git` entry, takes the stray folder as a common
/// directory of its own, and the project's Never use is dropped.
#[test]
fn a_stray_git_folder_inside_a_worktree_does_not_hide_the_project() {
    let (root, repo, worktree) = repo_with_worktree("r10-stray");
    let store = SessionStore::open_in_memory().unwrap();
    ban_codex(&store, &repo);
    let sub = worktree.join("sub");
    std::fs::create_dir_all(sub.join(".git")).unwrap();
    // git agrees this folder is the project's worktree.
    let top = std::process::Command::new("git")
        .arg("-C")
        .arg(&sub)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .unwrap();
    let judged = judge_codex(&store, &sub);
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        top.status.success(),
        "git reads the worktree through the stray folder"
    );
    let err =
        judged.expect_err("git says this is the project's worktree, so its Never use applies");
    assert!(err.contains("Never use"), "{err}");
}

/// MED-2: a nested repository (a submodule, a vendored clone, a test fixture repo) inside a worktree. In the main
/// checkout the same folder is the project's (it is inside the project's folder). In a worktree the judgment stops at
/// the nested `.git` and the project's Never use is dropped. "A worktree or a subfolder counts as its project."
#[test]
fn a_nested_repository_inside_a_worktree_counts_like_it_does_in_the_main_checkout() {
    let (root, repo, worktree) = repo_with_worktree("r10-nested");
    let store = SessionStore::open_in_memory().unwrap();
    ban_codex(&store, &repo);
    let in_main = repo.join("vendor-lib");
    let in_worktree = worktree.join("vendor-lib");
    for dir in [&in_main, &in_worktree] {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
    }
    let main_judged = judge_codex(&store, &in_main);
    let worktree_judged = judge_codex(&store, &in_worktree);
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        main_judged.is_err(),
        "control: the nested repo in the main checkout is the project's"
    );
    let err = worktree_judged
        .expect_err("the same nested repo in a worktree must keep the project's Never use");
    assert!(err.contains("Never use"), "{err}");
}

/// LOW-1: a folder whose own `.git` cannot be read (a worktree whose main repo moved) is refused for every CLI, for
/// Ash's own chat too, as soon as any project has a saved crew row, even when no saved policy could refuse this CLI
/// (nothing on Never use, no lock). Round 10 only needs to refuse when an undecidable owner could change the answer.
#[test]
fn an_orphaned_worktree_is_not_refused_when_no_saved_policy_could_refuse_the_cli() {
    let (root, repo, _worktree) = repo_with_worktree("r10-orphan");
    let store = SessionStore::open_in_memory().unwrap();
    {
        let mut conn = store.lock_conn().unwrap();
        store::set_policy(
            &mut conn,
            "project",
            repo.to_str().unwrap(),
            &json!({ "lockDefault": false, "neverUse": [], "fallback": [] }),
            0,
        )
        .unwrap();
    }
    let orphan = root.join("orphan");
    std::fs::create_dir_all(&orphan).unwrap();
    std::fs::write(
        orphan.join(".git"),
        format!(
            "gitdir: {}\n",
            root.join("moved-away/.git/worktrees/orphan").display()
        ),
    )
    .unwrap();
    let judged = {
        let conn = store.lock_conn().unwrap();
        judge_spawn(
            &conn,
            "5b1f8f0e-9d43-4c11-8a55-ash-own-chat",
            "claude",
            orphan.to_str().unwrap(),
            None,
        )
    };
    let _ = std::fs::remove_dir_all(&root);
    judged.expect("no saved policy bans Claude Code or locks, so Ash's own chat starts");
}

/// LOW-2: neither read has a bound. A `.git` that is a FIFO (in ANY saved project's folder) blocks `read_to_string`
/// forever, while `judge_spawn_in` holds the session store's lock, so every judgment for every folder hangs the app.
#[cfg(unix)]
#[test]
fn a_fifo_git_entry_in_an_unrelated_project_does_not_hang_every_judgment() {
    let root = std::env::temp_dir().join(format!("r10-review-fifo-{}", uuid::Uuid::new_v4()));
    let project = root.join("project");
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    let fifo = project.join(".git");
    let made = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap();
    assert!(made.success(), "mkfifo");
    let (tx, rx) = std::sync::mpsc::channel();
    let (project_s, elsewhere_s) = (
        project.to_str().unwrap().to_string(),
        elsewhere.to_str().unwrap().to_string(),
    );
    std::thread::spawn(move || {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        store::set_policy(
            &mut conn,
            "project",
            &project_s,
            &json!({ "lockDefault": false, "neverUse": ["codex"], "fallback": [] }),
            0,
        )
        .unwrap();
        let judged = judge_spawn(&conn, "5b1f8f0e-ash-own-chat", "claude", &elsewhere_s, None);
        let _ = tx.send(judged.is_ok());
    });
    let answered = rx.recv_timeout(std::time::Duration::from_secs(10));
    if answered.is_err() {
        // Unblock the stuck reader so the thread ends: a writer opens the FIFO and closes it.
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .open(&fifo)
            .map(|mut f| std::io::Write::write_all(&mut f, b"gitdir: /nowhere\n"));
        let _ = rx.recv_timeout(std::time::Duration::from_secs(10));
    }
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        answered.is_ok(),
        "a FIFO named .git in one project must not hang the judgment of an unrelated folder"
    );
}
