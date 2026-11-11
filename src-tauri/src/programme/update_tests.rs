use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use rusqlite::Connection;

use super::checkout::{self, Bind};
use super::gitrun;
use super::settings::{self, Strategy};
use super::tick::{self, Next, Tick};
use super::update::{
    self, fetch_args, merge_args, push_transport_args, rebase_args, Interrupt, Outcome,
};
use super::UpdateReport;

fn memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::programme::ensure_tables(&conn).unwrap();
    conn
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap_or_else(|error| panic!("git {args:?} failed to start: {error}"));
    assert!(
        out.status.success(),
        "git {args:?} in {} failed\n{}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct Lab {
    root: PathBuf,
    origin: PathBuf,
    main: PathBuf,
    package: PathBuf,
}

impl Lab {
    fn open(folder: &str) -> Self {
        let root = std::env::temp_dir().join(format!("hivra-wp162-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let seed = root.join("seed");
        fs::create_dir_all(&seed).unwrap();
        git(&root, &["init", "-b", "main", "seed"]);
        configure(&seed);
        fs::write(seed.join("README.md"), "one\n").unwrap();
        git(&seed, &["add", "README.md"]);
        git(&seed, &["commit", "-m", "one"]);
        let origin = root.join("origin.git");
        git(&root, &["clone", "--bare", "seed", "origin.git"]);
        git(&origin, &["config", "receive.denyNonFastForwards", "true"]);
        let main = root.join("main checkout");
        git(&root, &["clone", "origin.git", "main checkout"]);
        configure(&main);
        let package = root.join(folder);
        let package_path = package.to_string_lossy().into_owned();
        git(
            &main,
            &["worktree", "add", "-b", "pkg", &package_path, "main"],
        );
        Self {
            root,
            origin,
            main,
            package,
        }
    }

    fn commit(&self, dir: &Path, file: &str, body: &str) {
        fs::write(dir.join(file), body).unwrap();
        git(dir, &["add", file]);
        git(dir, &["commit", "-m", file]);
    }

    fn push(&self, dir: &Path, branch: &str) {
        git(dir, &["push", "origin", branch]);
    }

    fn sha(&self, dir: &Path, rev: &str) -> String {
        git(dir, &["rev-parse", rev])
    }

    fn bind(&self, conn: &Connection, branch: &str) -> checkout::Checkout {
        let via = self
            .package
            .join("..")
            .join(self.package.file_name().unwrap());
        checkout::bind(
            conn,
            Bind {
                package_id: "pkg-1",
                project: self.main.to_str().unwrap(),
                worktree: &via,
                branch,
                base: "main",
                remote: "origin",
                expected_updated_at: None,
                now: 1,
            },
        )
        .unwrap()
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let temp = std::env::temp_dir();
        if self.root.starts_with(&temp) && self.root != temp {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

fn configure(dir: &Path) {
    let hooks = dir.with_file_name(format!(
        "{}-hooks",
        dir.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("hooks")
    ));
    fs::create_dir_all(&hooks).unwrap();
    let hooks_path = hooks.to_string_lossy().into_owned();
    git(dir, &["config", "user.email", "test@example.com"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    git(dir, &["config", "core.autocrlf", "false"]);
    git(dir, &["config", "merge.ff", "true"]);
    git(dir, &["config", "pull.rebase", "false"]);
    git(dir, &["config", "core.hooksPath", &hooks_path]);
}

fn run(conn: &Connection) -> UpdateReport {
    update::update_from_main(conn, "pkg-1").unwrap()
}

struct InterruptGuard;

impl InterruptGuard {
    fn arm(kind: Interrupt) -> Self {
        update::set_interrupt(kind);
        Self
    }
}

impl Drop for InterruptGuard {
    fn drop(&mut self) {
        update::set_interrupt(Interrupt::Off);
    }
}

fn git_path_exists(dir: &Path, name: &str) -> bool {
    let printed = git(dir, &["rev-parse", "--git-path", name]);
    let path = PathBuf::from(&printed);
    let path = if path.is_absolute() {
        path
    } else {
        dir.join(path)
    };
    path.exists()
}

#[test]
fn the_commands_never_force_push_skip_hooks_or_write_main() {
    let fetch = fetch_args("origin", "main");
    assert_eq!(
        fetch,
        vec![
            "fetch",
            "--no-tags",
            "origin",
            "refs/heads/main:refs/remotes/origin/main"
        ]
    );
    assert_eq!(
        merge_args("origin", "main"),
        vec!["merge", "--no-edit", "refs/remotes/origin/main"]
    );
    assert_eq!(
        rebase_args("origin", "main"),
        vec!["rebase", "refs/remotes/origin/main"]
    );
    let (before, after) = push_transport_args(
        "https://example.invalid/repo.git",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/pkg",
    );
    let mut push = before;
    push.push("push".into());
    push.extend(after);
    assert_eq!(
        push,
        vec![
            "-c",
            "core.commitGraph=false",
            "-c",
            "pack.useBitmaps=false",
            "push",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "https://example.invalid/repo.git",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/pkg",
        ]
    );
    for args in [
        fetch,
        merge_args("origin", "main"),
        rebase_args("origin", "main"),
        push,
    ] {
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        assert!(gitrun::ensure_safe(&borrowed).is_ok());
        assert!(args.iter().all(|arg| {
            arg != "--force"
                && arg != "--force-with-lease"
                && arg != "--no-verify"
                && arg != "-f"
                && arg != "checkout"
                && !arg.ends_with(":refs/heads/main")
        }));
    }
}

#[test]
fn a_forbidden_flag_is_refused_before_git_runs() {
    let error = gitrun::run(
        Path::new("."),
        &["push", "--force", "origin", "pkg"],
        Duration::from_secs(5),
    )
    .unwrap_err();
    match error {
        gitrun::RunError::Refused(reason) => {
            assert!(reason.contains("not allowed"));
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn a_timeout_is_not_a_finished_update() {
    let (program, args) = sleeper();
    let error = gitrun::run_program(
        program,
        Path::new("."),
        &args,
        Duration::from_millis(200),
        false,
    )
    .unwrap_err();
    match error {
        gitrun::RunError::NotFinished(reason) => {
            assert!(reason.contains("Try again"));
            assert!(reason.contains("Nothing was changed"));
        }
        other => panic!("expected an unfinished update, got {other:?}"),
    }
}

#[cfg(unix)]
fn sleeper() -> (&'static str, Vec<&'static str>) {
    ("sleep", vec!["5"])
}

#[cfg(windows)]
fn sleeper() -> (&'static str, Vec<&'static str>) {
    ("powershell", vec!["-Command", "Start-Sleep -Seconds 5"])
}

#[test]
fn merge_updates_the_package_branch_and_leaves_main_alone() {
    let lab = Lab::open("pkg branch 名字");
    lab.commit(&lab.package, "pkg.txt", "pkg\r\n");
    lab.push(&lab.package, "pkg");
    lab.commit(&lab.main, "trunk.txt", "trunk\n");
    lab.push(&lab.main, "main");
    let main_sha = lab.sha(&lab.main, "refs/heads/main");
    let origin_main = lab.sha(&lab.origin, "refs/heads/main");
    let conn = memory();
    let bound = lab.bind(&conn, "pkg");
    assert!(bound.worktree.contains("pkg branch 名字"));
    assert!(!bound.worktree.contains(".."));

    let report = run(&conn);
    match report.outcome {
        Outcome::Updated { method, head } => {
            assert_eq!(method, Strategy::Merge);
            assert_eq!(head, lab.sha(&lab.package, "HEAD"));
            assert_eq!(lab.sha(&lab.origin, "refs/heads/pkg"), head);
        }
        other => panic!("expected an update, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
    assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), origin_main);
    assert_eq!(
        fs::read_to_string(lab.package.join("pkg.txt")).unwrap(),
        "pkg\r\n"
    );

    match run(&conn).outcome {
        Outcome::AlreadyCurrent => {}
        other => panic!("expected already current, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
}

/// WP-200 x WP-162: the update's push goes through the commit guard like every other push the app makes. A package
/// branch carrying an approval file is refused, nothing reaches the remote, and the branch is put back.
#[test]
fn an_update_whose_branch_carries_an_agent_file_is_refused_by_the_commit_guard() {
    let lab = Lab::open("pkg-guard");
    lab.commit(&lab.package, "pkg.txt", "pkg\n");
    lab.push(&lab.package, "pkg");
    let pushed = lab.sha(&lab.origin, "refs/heads/pkg");
    fs::create_dir_all(lab.package.join(".claude")).unwrap();
    fs::write(lab.package.join(".claude/settings.local.json"), "{}\n").unwrap();
    git(&lab.package, &["add", "-f", ".claude/settings.local.json"]);
    git(&lab.package, &["commit", "-m", "agent file"]);
    let before = lab.sha(&lab.package, "HEAD");
    lab.commit(&lab.main, "trunk.txt", "trunk\n");
    lab.push(&lab.main, "main");
    let conn = memory();
    lab.bind(&conn, "pkg");

    match run(&conn).outcome {
        Outcome::Refused { reason } => assert!(reason.contains("commit guard"), "{reason}"),
        other => panic!("expected the commit guard to refuse the push, got {other:?}"),
    }
    assert_eq!(
        lab.sha(&lab.origin, "refs/heads/pkg"),
        pushed,
        "nothing reached the remote"
    );
    assert_eq!(
        lab.sha(&lab.package, "HEAD"),
        before,
        "the branch was put back"
    );
}

#[test]
fn a_rebase_that_would_need_a_force_push_is_put_back() {
    let lab = Lab::open("pkg");
    lab.commit(&lab.package, "pkg.txt", "pkg\n");
    lab.push(&lab.package, "pkg");
    lab.commit(&lab.main, "trunk.txt", "trunk\n");
    lab.push(&lab.main, "main");
    let before = lab.sha(&lab.package, "HEAD");
    let origin_pkg = lab.sha(&lab.origin, "refs/heads/pkg");
    let main_sha = lab.sha(&lab.origin, "refs/heads/main");
    let conn = memory();
    lab.bind(&conn, "pkg");
    settings::set(
        &conn,
        lab.main.to_str().unwrap(),
        false,
        Strategy::Rebase,
        0,
        1,
    )
    .unwrap();

    match run(&conn).outcome {
        Outcome::NotFinished { reason } => {
            assert!(reason.contains("force-pushed"), "{reason}");
            assert!(reason.contains("put back"), "{reason}");
        }
        other => panic!("expected the push to be refused, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.package, "HEAD"), before);
    assert_eq!(lab.sha(&lab.origin, "refs/heads/pkg"), origin_pkg);
    assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
    assert!(git(&lab.package, &["status", "--porcelain"]).is_empty());
}

#[test]
fn a_merge_conflict_is_cancelled_and_the_branch_is_left() {
    let lab = Lab::open("pkg");
    lab.commit(&lab.package, "README.md", "package\n");
    lab.push(&lab.package, "pkg");
    lab.commit(&lab.main, "README.md", "trunk\n");
    lab.push(&lab.main, "main");
    let before = lab.sha(&lab.package, "HEAD");
    let main_sha = lab.sha(&lab.main, "refs/heads/main");
    let conn = memory();
    lab.bind(&conn, "pkg");

    match run(&conn).outcome {
        Outcome::Conflict { detail } => assert!(detail.contains("cancelled"), "{detail}"),
        other => panic!("expected a conflict, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.package, "HEAD"), before);
    assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
    assert_eq!(
        fs::read_to_string(lab.package.join("README.md")).unwrap(),
        "package\n"
    );
    assert!(!fs::read_to_string(lab.package.join("README.md"))
        .unwrap()
        .contains("<<<<<<<"));
    assert!(git(&lab.package, &["status", "--porcelain"]).is_empty());
}

#[test]
fn uncommitted_work_and_a_merge_already_in_progress_are_left_alone() {
    let lab = Lab::open("pkg");
    lab.commit(&lab.package, "pkg.txt", "pkg\n");
    lab.push(&lab.package, "pkg");
    let before = lab.sha(&lab.package, "HEAD");
    let conn = memory();
    lab.bind(&conn, "pkg");
    fs::write(lab.package.join("notes.txt"), "keep me\n").unwrap();

    match run(&conn).outcome {
        Outcome::Refused { reason } => assert!(reason.contains("uncommitted"), "{reason}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(
        fs::read_to_string(lab.package.join("notes.txt")).unwrap(),
        "keep me\n"
    );
    assert_eq!(lab.sha(&lab.package, "HEAD"), before);
    fs::remove_file(lab.package.join("notes.txt")).unwrap();

    fs::write(lab.package.join("README.md"), "local edit\n").unwrap();
    match run(&conn).outcome {
        Outcome::Refused { reason } => assert!(reason.contains("uncommitted"), "{reason}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(
        fs::read_to_string(lab.package.join("README.md")).unwrap(),
        "local edit\n"
    );
    git(&lab.package, &["checkout", "--", "README.md"]);

    lab.commit(&lab.main, "README.md", "trunk\n");
    lab.push(&lab.main, "main");
    git(&lab.package, &["fetch", "origin", "main"]);
    fs::write(lab.package.join("README.md"), "package\n").unwrap();
    git(&lab.package, &["commit", "-am", "conflict"]);
    let during = lab.sha(&lab.package, "HEAD");
    let merged = Command::new("git")
        .arg("-C")
        .arg(&lab.package)
        .args(["merge", "origin/main"])
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(
        !merged.status.success(),
        "the setup merge was meant to conflict"
    );
    match run(&conn).outcome {
        Outcome::Refused { reason } => assert!(reason.contains("already in progress"), "{reason}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(
        git(&lab.package, &["rev-parse", "--verify", "MERGE_HEAD"]).len(),
        40
    );
    assert_eq!(lab.sha(&lab.package, "HEAD"), during);
    let readme = fs::read_to_string(lab.package.join("README.md")).unwrap();
    assert!(
        readme.contains("<<<<<<<"),
        "an in-progress merge must be left in place"
    );
}

/// The package's builder may still be working in its worktree. A commit it makes while main is
/// fetched is not the update's to undo: the conflict path must never reset the branch past it.
#[cfg(unix)]
#[test]
fn a_commit_made_while_main_is_fetched_is_never_reset_away() {
    use std::os::unix::fs::PermissionsExt;
    let lab = Lab::open("pkg");
    lab.commit(&lab.package, "README.md", "package\n");
    lab.push(&lab.package, "pkg");
    lab.commit(&lab.main, "README.md", "trunk\n");
    lab.push(&lab.main, "main");
    let origin_pkg = lab.sha(&lab.origin, "refs/heads/pkg");
    // The fetch's upload-pack stands in for the builder: once, mid-fetch, it commits in the worktree.
    let script = lab.root.join("builder-commits.sh");
    let late_sha = lab.root.join("late-sha");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR\n\
             if [ ! -e '{sha}' ]; then\n  printf 'late\\n' > '{pkg}/late.txt'\n  \
             git -C '{pkg}' add late.txt >/dev/null 2>&1\n  \
             git -C '{pkg}' commit -q -m late >/dev/null 2>&1\n  \
             git -C '{pkg}' rev-parse HEAD > '{sha}'\nfi\nexec git upload-pack \"$@\"\n",
            sha = late_sha.display(),
            pkg = lab.package.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    git(
        &lab.package,
        &[
            "config",
            "remote.origin.uploadpack",
            script.to_str().unwrap(),
        ],
    );
    let conn = memory();
    lab.bind(&conn, "pkg");

    let outcome = run(&conn).outcome;
    let late = fs::read_to_string(&late_sha).expect("the stand-in builder did not commit");
    assert!(
        !matches!(outcome, Outcome::Updated { .. } | Outcome::AlreadyCurrent),
        "{outcome:?}"
    );
    assert_eq!(
        lab.sha(&lab.package, "HEAD"),
        late.trim(),
        "the builder's commit was reset away ({outcome:?})"
    );
    assert_eq!(
        fs::read_to_string(lab.package.join("late.txt")).unwrap(),
        "late\n"
    );
    assert_eq!(lab.sha(&lab.origin, "refs/heads/pkg"), origin_pkg);
}

#[test]
fn the_wrong_branch_is_refused() {
    let lab = Lab::open("pkg");
    let before = lab.sha(&lab.package, "HEAD");
    let conn = memory();
    lab.bind(&conn, "pkg");
    git(&lab.package, &["checkout", "-b", "other"]);
    match run(&conn).outcome {
        Outcome::Refused { reason } => {
            assert!(reason.contains("other"), "{reason}");
            assert!(reason.contains("pkg"), "{reason}");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.main, "refs/heads/pkg"), before);
}

#[test]
fn the_main_checkout_is_refused_even_on_another_branch() {
    let lab = Lab::open("pkg");
    git(&lab.main, &["checkout", "-b", "side"]);
    let side = lab.sha(&lab.main, "HEAD");
    let main_sha = lab.sha(&lab.origin, "refs/heads/main");
    let conn = memory();
    checkout::bind(
        &conn,
        Bind {
            package_id: "pkg-1",
            project: lab.main.to_str().unwrap(),
            worktree: &lab.main,
            branch: "side",
            base: "main",
            remote: "origin",
            expected_updated_at: None,
            now: 1,
        },
    )
    .unwrap();
    match run(&conn).outcome {
        Outcome::Refused { reason } => assert!(reason.contains("main checkout"), "{reason}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.main, "HEAD"), side);
    assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
}

#[test]
fn a_branch_named_main_is_refused() {
    let lab = Lab::open("pkg");
    let main_sha = lab.sha(&lab.main, "refs/heads/main");
    let conn = memory();
    let on_main = lab.root.join("on main");
    let on_main_path = on_main.to_string_lossy().into_owned();
    git(&lab.main, &["checkout", "-b", "parked"]);
    git(&lab.main, &["worktree", "add", &on_main_path, "main"]);
    checkout::bind(
        &conn,
        Bind {
            package_id: "pkg-1",
            project: lab.main.to_str().unwrap(),
            worktree: &on_main,
            branch: "main",
            base: "main",
            remote: "origin",
            expected_updated_at: None,
            now: 1,
        },
    )
    .unwrap();
    match run(&conn).outcome {
        Outcome::Refused { reason } => assert!(reason.contains("main"), "{reason}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
    assert_eq!(lab.sha(&on_main, "HEAD"), main_sha);
}

#[test]
fn an_unreachable_remote_is_not_a_final_failure() {
    let lab = Lab::open("pkg");
    let before = lab.sha(&lab.package, "HEAD");
    let main_sha = lab.sha(&lab.main, "refs/heads/main");
    let missing = lab.root.join("missing").to_string_lossy().into_owned();
    git(&lab.main, &["remote", "set-url", "origin", &missing]);
    let conn = memory();
    lab.bind(&conn, "pkg");
    match run(&conn).outcome {
        Outcome::NotFinished { reason } => {
            assert!(reason.contains("Try again"), "{reason}");
            assert!(reason.contains("Nothing was changed"), "{reason}");
        }
        other => panic!("expected an unfinished update, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.package, "HEAD"), before);
    assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
}

#[test]
fn a_missing_package_is_refused_and_a_blank_id_is_an_error() {
    let conn = memory();
    match update::update_from_main(&conn, "pkg-1").unwrap().outcome {
        Outcome::Refused { reason } => assert!(reason.contains("no worktree"), "{reason}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(update::update_from_main(&conn, " ").is_err());
    assert!(update::update_from_main(&conn, "../pkg").is_err());
}

#[test]
fn checkout_bind_refuses_a_stale_write_and_a_missing_folder() {
    let conn = memory();
    let root = std::env::temp_dir().join(format!("hivra-wp162-bind-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let first = checkout::bind(
        &conn,
        Bind {
            package_id: "pkg-1",
            project: root.to_str().unwrap(),
            worktree: &root,
            branch: "pkg",
            base: "main",
            remote: "origin",
            expected_updated_at: None,
            now: 1,
        },
    )
    .unwrap();
    let error = checkout::bind(
        &conn,
        Bind {
            package_id: "pkg-1",
            project: root.to_str().unwrap(),
            worktree: &root,
            branch: "other",
            base: "main",
            remote: "origin",
            expected_updated_at: None,
            now: 2,
        },
    )
    .unwrap_err();
    assert!(error.contains("another window"), "{error}");
    let again = checkout::bind(
        &conn,
        Bind {
            package_id: "pkg-1",
            project: root.to_str().unwrap(),
            worktree: &root,
            branch: "other",
            base: "main",
            remote: "origin",
            expected_updated_at: Some(first.updated_at),
            now: 2,
        },
    )
    .unwrap();
    assert_eq!(again.branch, "other");
    let missing = root.join("nope");
    assert!(checkout::bind(
        &conn,
        Bind {
            package_id: "pkg-2",
            project: root.to_str().unwrap(),
            worktree: &missing,
            branch: "pkg",
            base: "main",
            remote: "origin",
            expected_updated_at: None,
            now: 3,
        },
    )
    .is_err());
    assert!(checkout::bind(
        &conn,
        Bind {
            package_id: "pkg-2",
            project: root.to_str().unwrap(),
            worktree: &root,
            branch: "main",
            base: "main",
            remote: "--force",
            expected_updated_at: None,
            now: 3,
        },
    )
    .is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn settings_default_to_off_and_merge_and_a_stale_write_is_refused() {
    let conn = memory();
    let root = std::env::temp_dir().join(format!("hivra-wp162-set-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("project")).unwrap();
    let project = root.join("project");
    let dotted = root.join("project").join("..").join("project");
    let got = settings::get(&conn, dotted.to_str().unwrap()).unwrap();
    assert!(!got.update_conflicting);
    assert_eq!(got.strategy, Strategy::Merge);
    assert_eq!(got.version, 0);
    let saved = settings::set(
        &conn,
        project.to_str().unwrap(),
        false,
        Strategy::Rebase,
        0,
        5,
    )
    .unwrap();
    assert_eq!(saved.strategy, Strategy::Rebase);
    assert_eq!(saved.version, 1);
    let error =
        settings::set(&conn, dotted.to_str().unwrap(), true, Strategy::Merge, 0, 6).unwrap_err();
    assert!(error.contains("another window"), "{error}");
    conn.execute(
        "UPDATE programme_update_settings SET strategy = 'drop' WHERE project = ?1",
        [saved.project],
    )
    .unwrap();
    let got = settings::get(&conn, project.to_str().unwrap()).unwrap();
    assert_eq!(got.strategy, Strategy::Merge);
    assert!(settings::get(&conn, " ").is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_tick_only_reports_until_the_setting_is_on() {
    let lab = Lab::open("pkg");
    lab.commit(&lab.package, "pkg.txt", "pkg\n");
    lab.push(&lab.package, "pkg");
    lab.commit(&lab.main, "trunk.txt", "trunk\n");
    lab.push(&lab.main, "main");
    let before = lab.sha(&lab.package, "HEAD");
    let main_sha = lab.sha(&lab.main, "refs/heads/main");
    let conn = memory();
    lab.bind(&conn, "pkg");

    let project = lab.main.to_str().unwrap().to_string();
    match tick::consider_conflict(&conn, &project, "pkg-1", "pkg").unwrap() {
        Tick::Reported { message } => {
            assert!(message.contains("only reported"), "{message}");
            assert!(message.contains("Nothing was merged"), "{message}");
        }
        other => panic!("expected a report, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.package, "HEAD"), before);
    assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
    assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);

    settings::set(
        &conn,
        lab.main.to_str().unwrap(),
        true,
        Strategy::Merge,
        0,
        1,
    )
    .unwrap();
    match tick::consider_conflict(&conn, &project, "pkg-1", "pkg").unwrap() {
        Tick::Ran(report) => match report.outcome {
            Outcome::Updated { method, head } => {
                assert_eq!(method, Strategy::Merge);
                assert_ne!(head, before);
                assert_eq!(head, lab.sha(&lab.package, "HEAD"));
            }
            other => panic!("expected an update, got {other:?}"),
        },
        other => panic!("expected the update to run, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
    assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
}

#[test]
fn the_tick_finds_the_package_worktree_by_its_branch_and_updates_it() {
    let lab = Lab::open("pkg");
    lab.commit(&lab.package, "pkg.txt", "pkg\n");
    lab.push(&lab.package, "pkg");
    lab.commit(&lab.main, "trunk.txt", "trunk\n");
    lab.push(&lab.main, "main");
    let before = lab.sha(&lab.package, "HEAD");
    let main_sha = lab.sha(&lab.main, "refs/heads/main");
    let conn = memory();
    let project = lab.main.to_str().unwrap().to_string();
    settings::set(&conn, &project, true, Strategy::Merge, 0, 1).unwrap();

    // Nothing is recorded yet, so the tick looks the worktree up by its branch.
    let Next::Find { branch } = tick::next(&conn, &project, "pkg-1", "pkg").unwrap() else {
        panic!("expected a lookup before any worktree is recorded");
    };
    assert_eq!(
        update::branch_worktree(&lab.main, "no-such-branch").unwrap(),
        None
    );
    assert!(update::branch_worktree(&lab.main, "-x").is_err());
    let found = update::branch_worktree(&lab.main, &branch)
        .unwrap()
        .expect("the package worktree");
    assert_eq!(
        fs::canonicalize(&found).unwrap(),
        fs::canonicalize(&lab.package).unwrap()
    );
    tick::record(&conn, &project, "pkg-1", &found, &branch, 1).unwrap();

    // The recorded worktree is used from now on, with no second lookup.
    let Next::Update(plan) = tick::next(&conn, &project, "pkg-1", "pkg").unwrap() else {
        panic!("expected the recorded worktree to be updated");
    };
    match update::execute(&plan).outcome {
        Outcome::Updated { head, .. } => assert_eq!(head, lab.sha(&lab.package, "HEAD")),
        other => panic!("expected an update, got {other:?}"),
    }
    assert_ne!(lab.sha(&lab.package, "HEAD"), before);
    assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
    assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
}

#[test]
fn an_update_does_not_run_while_the_packages_builder_is_live() {
    let lab = Lab::open("pkg");
    lab.commit(&lab.package, "pkg.txt", "pkg\n");
    lab.push(&lab.package, "pkg");
    lab.commit(&lab.main, "trunk.txt", "trunk\n");
    lab.push(&lab.main, "main");
    let before = lab.sha(&lab.package, "HEAD");
    let main_sha = lab.sha(&lab.main, "refs/heads/main");
    let conn = memory();
    lab.bind(&conn, "pkg");
    conn.execute(
        "INSERT INTO programme_packages (
            id, project_id, wp, title, brief_path, branch, status, security_park, priority, notes,
            park_reason, version, created_at, updated_at, claimed_at, finished_at
         ) VALUES ('pkg-1', 'crew', 'WP-162', 'Update', 'docs/wp.md', 'pkg', 'building', 0, 0, '', NULL, 1, 1, 1, 1, NULL)",
        [],
    )
    .unwrap();

    match update::update_from_main(&conn, "pkg-1").unwrap().outcome {
        Outcome::Refused { reason } => {
            assert!(reason.to_ascii_lowercase().contains("builder"), "{reason}");
        }
        other => panic!("expected a refusal while the builder is live, got {other:?}"),
    }
    assert_eq!(lab.sha(&lab.package, "HEAD"), before, "the update ran");
    assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
    assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);

    conn.execute(
        "UPDATE programme_packages SET status = 'pr_open' WHERE id = 'pkg-1'",
        [],
    )
    .unwrap();
    match update::update_from_main(&conn, "pkg-1").unwrap().outcome {
        Outcome::Updated { .. } => {}
        other => panic!("expected the update once the builder is done, got {other:?}"),
    }
    assert_ne!(lab.sha(&lab.package, "HEAD"), before);
    assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
}

fn insert_package(conn: &Connection, id: &str, wp: &str, branch: &str) {
    conn.execute(
        "INSERT INTO programme_packages (
            id, project_id, wp, title, brief_path, branch, status, security_park, priority, notes,
            park_reason, version, created_at, updated_at, claimed_at, finished_at
         ) VALUES (?1, 'crew', ?2, 'Update', 'docs/wp.md', ?3, 'pr_open', 0, 0, '', NULL, 1, 1, 1, NULL, NULL)",
        rusqlite::params![id, wp, branch],
    )
    .unwrap();
}

#[test]
fn a_lead_cannot_claim_a_worktree_that_was_not_made_for_the_package() {
    let lab = Lab::open("pkg");
    let conn = memory();
    insert_package(&conn, "pkg-1", "WP-162", "wp/162");
    match update::claim_worktree(&conn, &lab.main, "pkg-1", "pkg").unwrap() {
        update::Claim::Reported(message) => {
            assert!(
                message.to_ascii_lowercase().contains("not")
                    && message.to_ascii_lowercase().contains("package"),
                "{message}"
            );
        }
        update::Claim::Worktree(path) => panic!("adopted {} for WP-162", path.display()),
    }
    assert!(checkout::get(&conn, "pkg-1").unwrap().is_none());

    match update::claim_worktree(&conn, &lab.main, "pkg-1", "wp/162b-update-leftovers").unwrap() {
        update::Claim::Reported(_) => {}
        update::Claim::Worktree(path) => panic!("adopted {} for WP-162", path.display()),
    }

    match update::claim_worktree(&conn, &lab.main, "missing", "pkg").unwrap() {
        update::Claim::Reported(message) => {
            assert!(
                message
                    .to_ascii_lowercase()
                    .contains("not on the programme"),
                "{message}"
            );
        }
        update::Claim::Worktree(path) => panic!("guessed {} with no programme row", path.display()),
    }

    let real = lab.root.join("wp-162");
    let real_path = real.to_string_lossy().into_owned();
    git(
        &lab.main,
        &["worktree", "add", "-b", "wp/162", &real_path, "main"],
    );
    match update::claim_worktree(&conn, &lab.main, "pkg-1", "wp/162").unwrap() {
        update::Claim::Worktree(path) => {
            assert_eq!(
                fs::canonicalize(&path).unwrap(),
                fs::canonicalize(&real).unwrap()
            );
        }
        update::Claim::Reported(message) => panic!("the package worktree was refused: {message}"),
    }
    assert!(checkout::get(&conn, "pkg-1").unwrap().is_none());
}

mod review_leftovers {
    use super::*;

    fn conflict_lab() -> (Lab, Connection, String, String) {
        let lab = Lab::open("pkg");
        lab.commit(&lab.package, "README.md", "package\n");
        lab.push(&lab.package, "pkg");
        lab.commit(&lab.main, "README.md", "trunk\n");
        lab.push(&lab.main, "main");
        let before = lab.sha(&lab.package, "HEAD");
        let main_sha = lab.sha(&lab.main, "refs/heads/main");
        let conn = memory();
        lab.bind(&conn, "pkg");
        (lab, conn, before, main_sha)
    }

    #[test]
    fn a_merge_timeout_aborts_before_saying_nothing_changed() {
        let _guard = InterruptGuard::arm(Interrupt::RewriteTimeout);
        let (lab, conn, before, main_sha) = conflict_lab();

        match run(&conn).outcome {
            Outcome::NotFinished { reason } => {
                assert!(reason.contains("Nothing was changed"), "{reason}");
            }
            other => panic!("expected an unfinished merge, got {other:?}"),
        }
        assert_eq!(lab.sha(&lab.package, "HEAD"), before);
        assert!(
            git(&lab.package, &["status", "--porcelain"]).is_empty(),
            "the merge was still in progress"
        );
        assert!(
            !git_path_exists(&lab.package, "MERGE_HEAD"),
            "the merge was not aborted"
        );
        assert!(!fs::read_to_string(lab.package.join("README.md"))
            .unwrap()
            .contains("<<<<<<<"));
        assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
    }

    #[test]
    fn a_rebase_timeout_aborts_before_saying_nothing_changed() {
        let _guard = InterruptGuard::arm(Interrupt::RewriteTimeout);
        let (lab, conn, before, main_sha) = conflict_lab();
        settings::set(
            &conn,
            lab.main.to_str().unwrap(),
            false,
            Strategy::Rebase,
            0,
            1,
        )
        .unwrap();

        match run(&conn).outcome {
            Outcome::NotFinished { reason } => {
                assert!(reason.contains("Nothing was changed"), "{reason}");
            }
            other => panic!("expected an unfinished rebase, got {other:?}"),
        }
        assert_eq!(lab.sha(&lab.package, "HEAD"), before);
        assert!(git(&lab.package, &["status", "--porcelain"]).is_empty());
        assert!(
            !git_path_exists(&lab.package, "rebase-merge"),
            "the rebase was not aborted"
        );
        assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
        assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
    }

    #[test]
    fn a_merge_that_cannot_be_cancelled_is_told_plainly() {
        let _guard = InterruptGuard::arm(Interrupt::AbortFails);
        let (lab, conn, before, main_sha) = conflict_lab();

        match run(&conn).outcome {
            Outcome::NotFinished { reason } => {
                assert!(reason.contains("could not be cancelled"), "{reason}");
                assert!(reason.contains("left for you"), "{reason}");
                assert!(!reason.contains("Nothing was changed"), "{reason}");
            }
            other => panic!("expected the failed abort to be reported, got {other:?}"),
        }
        assert!(git_path_exists(&lab.package, "MERGE_HEAD"));
        assert_eq!(lab.sha(&lab.package, "HEAD"), before);
        assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
    }

    #[test]
    fn a_rebase_that_cannot_be_cancelled_is_told_plainly() {
        let _guard = InterruptGuard::arm(Interrupt::AbortFails);
        let (lab, conn, _before, main_sha) = conflict_lab();
        settings::set(
            &conn,
            lab.main.to_str().unwrap(),
            false,
            Strategy::Rebase,
            0,
            1,
        )
        .unwrap();

        match run(&conn).outcome {
            Outcome::NotFinished { reason } => {
                assert!(reason.contains("could not be cancelled"), "{reason}");
                assert!(reason.contains("left for you"), "{reason}");
                assert!(!reason.contains("Nothing was changed"), "{reason}");
            }
            other => panic!("expected the failed abort to be reported, got {other:?}"),
        }
        assert!(git_path_exists(&lab.package, "rebase-merge"));
        assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
        assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
    }

    fn ahead_lab() -> (Lab, Connection, String, String) {
        let lab = Lab::open("pkg");
        lab.commit(&lab.package, "pkg.txt", "pkg\n");
        lab.push(&lab.package, "pkg");
        lab.commit(&lab.main, "trunk.txt", "trunk\n");
        lab.push(&lab.main, "main");
        let before = lab.sha(&lab.package, "HEAD");
        let main_sha = lab.sha(&lab.origin, "refs/heads/main");
        let conn = memory();
        lab.bind(&conn, "pkg");
        (lab, conn, before, main_sha)
    }

    #[test]
    fn a_push_timeout_after_the_remote_accepted_does_not_rewind_the_branch() {
        let _guard = InterruptGuard::arm(Interrupt::PushAfterAccept);
        let (lab, conn, before, main_sha) = ahead_lab();

        match run(&conn).outcome {
            Outcome::Updated { head, .. } => {
                assert_eq!(head, lab.sha(&lab.package, "HEAD"));
                assert_eq!(lab.sha(&lab.origin, "refs/heads/pkg"), head);
                assert_ne!(head, before);
            }
            other => panic!("expected the landed push to stand, got {other:?}"),
        }
        assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
        assert_eq!(lab.sha(&lab.main, "refs/heads/main"), main_sha);
    }

    #[test]
    fn a_push_timeout_that_cannot_be_read_does_not_rewind_the_branch() {
        let _guard = InterruptGuard::arm(Interrupt::PushUnreadable);
        let (lab, conn, before, main_sha) = ahead_lab();

        match run(&conn).outcome {
            Outcome::NotFinished { reason } => {
                assert!(reason.contains("left as it is"), "{reason}");
                assert!(!reason.contains("Nothing was changed"), "{reason}");
                assert!(!reason.contains("put back"), "{reason}");
            }
            other => panic!("expected the branch to be left, got {other:?}"),
        }
        assert_ne!(lab.sha(&lab.package, "HEAD"), before);
        assert_eq!(lab.sha(&lab.origin, "refs/heads/pkg"), before);
        assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
    }

    #[test]
    fn a_push_that_lands_on_one_remote_is_not_rewound_when_another_refuses() {
        let (lab, conn, before, main_sha) = ahead_lab();
        let other = lab.root.join("other.git");
        let other_path = other.to_string_lossy().into_owned();
        let origin = lab.origin.to_string_lossy().into_owned();
        git(&lab.root, &["clone", "--bare", &origin, &other_path]);
        let other_wt = lab.root.join("other-wt");
        let other_wt_path = other_wt.to_string_lossy().into_owned();
        git(&lab.root, &["clone", &other_path, &other_wt_path]);
        configure(&other_wt);
        git(&other_wt, &["checkout", "pkg"]);
        lab.commit(&other_wt, "diverge.txt", "no\n");
        lab.push(&other_wt, "pkg");
        git(
            &lab.package,
            &["remote", "set-url", "--add", "--push", "origin", &origin],
        );
        git(
            &lab.package,
            &[
                "remote",
                "set-url",
                "--add",
                "--push",
                "origin",
                &other_path,
            ],
        );

        match run(&conn).outcome {
            Outcome::NotFinished { reason } => {
                assert!(reason.contains("left as it is"), "{reason}");
                assert!(reason.contains("already has it"), "{reason}");
                assert!(!reason.contains("put back"), "{reason}");
            }
            other => panic!("expected the landed push to be left, got {other:?}"),
        }
        let head = lab.sha(&lab.package, "HEAD");
        assert_ne!(head, before);
        assert_eq!(lab.sha(&lab.origin, "refs/heads/pkg"), head);
        assert_eq!(lab.sha(&lab.origin, "refs/heads/main"), main_sha);
    }

    #[test]
    fn a_removed_recorded_worktree_is_looked_up_again() {
        let lab = Lab::open("pkg");
        lab.commit(&lab.package, "pkg.txt", "pkg\n");
        let conn = memory();
        let project = lab.main.to_str().unwrap().to_string();
        settings::set(&conn, &project, true, Strategy::Merge, 0, 1).unwrap();
        tick::record(&conn, &project, "pkg-1", &lab.package, "pkg", 1).unwrap();
        let Next::Update(_) = tick::next(&conn, &project, "pkg-1", "pkg").unwrap() else {
            panic!("a present worktree is reused");
        };

        let package_path = lab.package.to_string_lossy().into_owned();
        git(&lab.main, &["worktree", "remove", "--force", &package_path]);
        let Next::Find { branch } = tick::next(&conn, &project, "pkg-1", "pkg").unwrap() else {
            panic!("a removed worktree must be looked up again");
        };
        assert_eq!(branch, "pkg");

        let fresh = lab.root.join("pkg-again");
        let fresh_path = fresh.to_string_lossy().into_owned();
        git(&lab.main, &["worktree", "add", &fresh_path, "pkg"]);
        let found = update::branch_worktree(&lab.main, "pkg")
            .unwrap()
            .expect("the new worktree");
        tick::record(&conn, &project, "pkg-1", &found, "pkg", 2).unwrap();
        let Next::Update(plan) = tick::next(&conn, &project, "pkg-1", "pkg").unwrap() else {
            panic!("the new worktree should be recorded");
        };
        assert_eq!(
            fs::canonicalize(&plan.worktree).unwrap(),
            fs::canonicalize(&fresh).unwrap()
        );
    }

    #[test]
    fn a_deleted_worktree_folder_is_not_adopted() {
        let lab = Lab::open("pkg");
        fs::remove_dir_all(&lab.package).unwrap();
        assert_eq!(
            update::branch_worktree(&lab.main, "pkg").unwrap(),
            None,
            "a removed folder is not a worktree to adopt"
        );
    }
}

#[test]
fn migrate_creates_the_programme_tables() {
    let store = crate::session_store::SessionStore::open_in_memory().unwrap();
    let conn = store.lock_conn().unwrap();
    let got = settings::get(&conn, "a-project").unwrap();
    assert!(!got.update_conflicting);
    assert_eq!(got.strategy, Strategy::Merge);
}
