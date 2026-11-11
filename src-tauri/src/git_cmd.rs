//! The app's own git calls.
//!
//! Background git (`git()`, `child()`) turns off `core.fsmonitor` and points `core.hooksPath` at `/dev/null`, so a config
//! file an agent could write cannot name a command the app then runs. Ash's own commit, push and pull use
//! `git_with_hooks()`: fsmonitor stays off, and the repo's hooks run. Those calls are not sandboxed.
//!
//! While the agent sandbox is on, background git starts under `agent_sandbox::container_profile` (no `.git` write deny, so
//! `git status` can write the index). A filter git still runs is inside that profile. A container that cannot be built
//! does not fall back to unsandboxed git: the command's program does not exist, so it fails before git reads config.
//! Unit tests never build that container, so they do not read the real data folder or the real `~/.gitconfig`. The wrap
//! itself is `command_for`.
//!
//! Attribution's crew commits run the repo's own hooks on purpose (its forwarder), so they use `child_keep_hooks()`:
//! fsmonitor is still off, and the hooks path is left to the repo. Those commits are the one place a repo hook runs
//! unsandboxed; docs/hivra/work/WP-178-agent-os-sandbox.md records that as a known limit.
//!
//! The settings are leading `-c` arguments, so they come before whatever the caller adds (`-C dir`, the subcommand).

use std::path::{Path, PathBuf};
use std::process::Command;

const FSMONITOR: &str = "core.fsmonitor=false";
const NO_HOOKS: &str = "core.hooksPath=/dev/null";

/// The empty tree. Read-only git looks up attributes here, so a checkout's `.gitattributes` cannot name a filter.
pub(crate) const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Spawn fails before git runs. Not `/usr/bin/false`: that is a real program, and git would already have read config.
const REFUSED_PROGRAM: &str = "/nonexistent/monocode-sandbox-refused";

/// How background git is contained. `Plain` is the sandbox off, and every unit test.
#[derive(Clone, Debug)]
pub(crate) enum Contain {
    Plain,
    Profile(String),
    Refused,
}

/// `git` with the given `-c` settings first, so every argument the caller adds after them is a git argument. The settings
/// are arguments, not environment: attribution's own forwarder sets `GIT_CONFIG_COUNT` for its hooks, and an environment
/// setting here would be overwritten by it.
fn with_settings(program: Command, settings: &[&str]) -> Command {
    let mut command = program;
    for setting in settings {
        command.arg("-c").arg(setting);
    }
    command
}

fn settings(keep_hooks: bool) -> &'static [&'static str] {
    if keep_hooks {
        &[FSMONITOR]
    } else {
        &[FSMONITOR, NO_HOOKS]
    }
}

/// Copy the allow-listed child environment onto `command` and drop everything else. `sandbox-exec` would otherwise pass
/// this process's environment through to git.
fn apply_scrub(command: &mut Command) {
    let template = crate::delivery::child("git");
    command.env_clear();
    for (key, value) in template.get_envs() {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
    }
}

/// `git` as `contain` says. A refused container is a program that does not exist, so spawn fails before git starts.
pub(crate) fn command_for(scrubbed: bool, keep_hooks: bool, contain: Contain) -> Command {
    match contain {
        Contain::Refused => Command::new(REFUSED_PROGRAM),
        Contain::Plain => {
            let program = if scrubbed {
                crate::delivery::child("git")
            } else {
                Command::new("git")
            };
            with_settings(program, settings(keep_hooks))
        }
        Contain::Profile(profile) => {
            let mut command = Command::new(crate::agent_sandbox::SANDBOX_EXEC);
            command.arg("-p").arg(profile).arg("git");
            if scrubbed {
                apply_scrub(&mut command);
            }
            with_settings(command, settings(keep_hooks))
        }
    }
}

#[cfg(not(test))]
fn contain_now() -> Contain {
    let data = crate::instance::data_dir(&crate::instance::current().identifier);
    if !crate::agent_sandbox::enabled(data.as_deref()) {
        return Contain::Plain;
    }
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Contain::Refused;
    };
    let profile = match crate::agent_sandbox::container_profile(&home, data.as_deref()) {
        Ok(profile) => profile,
        Err(_) => return Contain::Refused,
    };
    let launcher = Path::new(crate::agent_sandbox::SANDBOX_EXEC);
    if crate::agent_sandbox::self_check(launcher).is_err()
        || crate::agent_sandbox::preflight_with(launcher, &profile).is_err()
    {
        return Contain::Refused;
    }
    Contain::Profile(profile)
}

#[cfg(test)]
fn contain_now() -> Contain {
    Contain::Plain
}

/// `git`, hardened: no fsmonitor, no hooks. Under the agent sandbox, inside the container profile.
pub fn git() -> Command {
    command_for(false, false, contain_now())
}

/// `git` for the Git panel: fsmonitor off, the repo's own hooks left alone, never sandboxed. Ash's commit, push and pull.
pub(crate) fn git_with_hooks() -> Command {
    command_for(false, true, Contain::Plain)
}

/// `git` from the app's scrubbed child environment (`delivery::child`), hardened: no fsmonitor, no hooks.
pub(crate) fn child() -> Command {
    command_for(true, false, contain_now())
}

/// `git` with fsmonitor off, and the repo's own hooks still run. Attribution's tests use it for their own commits.
#[cfg(test)]
pub(crate) fn git_keep_hooks() -> Command {
    command_for(false, true, Contain::Plain)
}

/// `git` from the scrubbed child environment, with fsmonitor off and the repo's own hooks still run.
pub(crate) fn child_keep_hooks() -> Command {
    command_for(true, true, Contain::Plain)
}

/// Read-only subcommands. Anything else (commit, restore, config) is left unchanged: attribute flags would break a write.
const READONLY: &[&str] = &[
    "status",
    "diff",
    "show",
    "log",
    "rev-parse",
    "cat-file",
    "ls-files",
    "rev-list",
    "diff-tree",
    "diff-index",
    "diff-files",
    "blame",
    "for-each-ref",
    "describe",
    "name-rev",
    "merge-base",
    "check-ignore",
    "version",
];

fn is_diff_family(subcommand: &str) -> bool {
    matches!(
        subcommand,
        "diff" | "show" | "log" | "diff-tree" | "diff-index" | "diff-files"
    )
}

/// The git subcommand in `args`, skipping the global options a caller may already have put there.
fn subcommand<'a>(args: &[&'a str]) -> Option<&'a str> {
    let mut index = 0;
    while index < args.len() {
        let arg = args[index];
        if arg == "--" {
            return None;
        }
        if matches!(
            arg,
            "-c" | "-C"
                | "--git-dir"
                | "--work-tree"
                | "--namespace"
                | "--attr-source"
                | "--config-env"
                | "--super-prefix"
        ) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        return Some(arg);
    }
    None
}

/// Add the read-only guards, then `args`. `--attr-source` and `-c` are global, so they come before the subcommand.
/// `--no-textconv` and `--no-ext-diff` are only valid on the diff family (`git status` rejects them). A write is passed
/// through with nothing added.
pub(crate) fn extend_readonly<'a>(command: &'a mut Command, args: &[&str]) -> &'a mut Command {
    let sub = subcommand(args);
    if sub.is_some_and(|name| READONLY.contains(&name)) {
        command.arg("--attr-source").arg(EMPTY_TREE);
        command.arg("-c").arg("core.attributesFile=/dev/null");
    }
    let mut placed = false;
    for arg in args {
        command.arg(*arg);
        if !placed && sub == Some(*arg) && sub.is_some_and(is_diff_family) {
            command.arg("--no-textconv").arg("--no-ext-diff");
            placed = true;
        }
    }
    command
}

fn has_git_component(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == ".git")
}

fn read_line_path(file: &Path, base: &Path) -> Result<PathBuf, String> {
    let meta = std::fs::symlink_metadata(file).map_err(|error| {
        format!("This checkout's git dir could not be read, so the app will not run git here ({error}).")
    })?;
    if !meta.is_file() || meta.len() > 4096 {
        return Err(
            "This checkout's git dir could not be read, so the app will not run git here.".into(),
        );
    }
    let text = std::fs::read_to_string(file).map_err(|error| {
        format!("This checkout's git dir could not be read, so the app will not run git here ({error}).")
    })?;
    let line = text.lines().next().unwrap_or("").trim();
    let path = line.strip_prefix("gitdir:").map(str::trim).unwrap_or(line);
    if path.is_empty() || path.contains('\0') {
        return Err(
            "This checkout's git dir could not be read, so the app will not run git here.".into(),
        );
    }
    let raw = Path::new(path);
    Ok(if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        base.join(raw)
    })
}

/// `commondir` inside `git_dir` must resolve inside that directory. No file is fine (an ordinary repository).
fn commondir_stays_inside(git_dir: &Path) -> Result<(), String> {
    let file = git_dir.join("commondir");
    if std::fs::symlink_metadata(&file).is_err() {
        return Ok(());
    }
    let target = read_line_path(&file, git_dir)?;
    let git_canon = std::fs::canonicalize(git_dir).map_err(|_| {
        "This checkout's git dir points outside the repository, so the app will not run git here."
            .to_string()
    })?;
    let target_canon = std::fs::canonicalize(&target).map_err(|_| {
        "This checkout's git dir points outside the repository, so the app will not run git here."
            .to_string()
    })?;
    if target_canon.starts_with(&git_canon) {
        return Ok(());
    }
    Err(
        "This checkout's git dir points outside the repository, so the app will not run git here."
            .into(),
    )
}

fn outside() -> String {
    "This checkout's git dir is not inside a .git directory, so the app will not run git here."
        .into()
}

/// A `.git` file's git dir: it must exist, keep a `.git` path segment after links are resolved, and its `commondir`
/// (a worktree's) must be the `.git` directory that contains it.
fn contained_gitdir(checkout: &Path, dot: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(dot).map_err(|error| {
        format!("This checkout's git dir could not be read, so the app will not run git here ({error}).")
    })?;
    let rest = text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .strip_prefix("gitdir:")
        .map(str::trim)
        .ok_or_else(|| {
            "This checkout's .git file is not a git dir the app recognises, so git will not run here."
                .to_string()
        })?;
    if rest.is_empty() || rest.contains('\0') {
        return Err(outside());
    }
    let raw = Path::new(rest);
    let gitdir = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        checkout.join(raw)
    };
    if !has_git_component(&gitdir) {
        return Err(outside());
    }
    if std::fs::symlink_metadata(&gitdir).is_err() {
        return Err("This checkout's git dir is missing, so the app will not run git here.".into());
    }
    let canon = std::fs::canonicalize(&gitdir).map_err(|_| outside())?;
    if !has_git_component(&canon) {
        return Err(outside());
    }
    let common_file = gitdir.join("commondir");
    if std::fs::symlink_metadata(&common_file).is_err() {
        return Ok(());
    }
    let common = read_line_path(&common_file, &gitdir)?;
    let common_canon = std::fs::canonicalize(&common).map_err(|_| outside())?;
    if has_git_component(&common_canon) && canon.starts_with(&common_canon) {
        return Ok(());
    }
    Err(outside())
}

/// Refuse a checkout whose git dir was pointed at somewhere else (a `commondir`, a worktree `gitdir:` file, or a link
/// that leaves `.git`). No `.git` yet is fine: that is `git init`. A directory `.git` may not name a `commondir` outside
/// itself. A file `.git` must name a git dir that stays inside a `.git` path.
pub(crate) fn ensure_contained(checkout: &Path) -> Result<(), String> {
    let dot = checkout.join(".git");
    let meta = match std::fs::symlink_metadata(&dot) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "This checkout's git dir could not be read, so the app will not run git here ({error})."
            ))
        }
    };
    if meta.file_type().is_symlink() {
        return Err("This checkout's .git is a link, so the app will not run git here.".into());
    }
    if meta.is_dir() {
        return commondir_stays_inside(&dot);
    }
    if meta.is_file() {
        if meta.len() > 4096 {
            return Err(
                "This checkout's .git file is not a git dir the app recognises, so git will not run here."
                    .into(),
            );
        }
        return contained_gitdir(checkout, &dot);
    }
    Err("This checkout's .git is not a repository the app will run git in.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_of(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    /// Point git at an empty config file, so a probe does not open the real `~/.gitconfig`.
    fn without_user_gitconfig<'a>(command: &'a mut Command, home: &Path) -> &'a mut Command {
        let empty =
            std::env::temp_dir().join(format!("git-cmd-empty-gitconfig-{}", std::process::id()));
        if !empty.is_file() {
            std::fs::write(&empty, "").unwrap();
        }
        command
            .env("HOME", home)
            .env("GIT_CONFIG_GLOBAL", &empty)
            .env("GIT_CONFIG_NOSYSTEM", "1")
    }

    #[test]
    fn the_hardening_reaches_git_and_turns_fsmonitor_and_hooks_off() {
        let home = scratch("noconfig");
        let mut command = git();
        let out = without_user_gitconfig(&mut command, &home)
            .args(["config", "--get-all", "core.fsmonitor"])
            .output()
            .expect("git runs");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "false");
        let mut command = git();
        let hooks = without_user_gitconfig(&mut command, &home)
            .args(["config", "--get-all", "core.hooksPath"])
            .output()
            .expect("git runs");
        assert_eq!(String::from_utf8_lossy(&hooks.stdout).trim(), "/dev/null");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_panel_git_leaves_hooks_on_and_still_turns_fsmonitor_off() {
        let panel = args_of(&git_with_hooks()).join(" ");
        assert!(panel.contains("core.fsmonitor=false"), "{panel}");
        assert!(
            !panel.contains("core.hooksPath"),
            "the panel turns hooks off: {panel}"
        );
        let background = args_of(&git()).join(" ");
        assert!(
            background.contains("core.hooksPath=/dev/null"),
            "{background}"
        );
    }

    #[test]
    fn a_refused_container_is_not_a_git_that_can_read_config() {
        let mut command = command_for(false, false, Contain::Refused);
        assert_eq!(command.get_program(), REFUSED_PROGRAM);
        assert!(
            command.output().is_err(),
            "a refused container spawned a program that can read config"
        );
    }

    #[test]
    fn the_container_wrap_is_sandbox_exec_in_front_of_git() {
        let command = command_for(
            false,
            false,
            Contain::Profile("(version 1)\n(allow default)\n".into()),
        );
        assert_eq!(
            command.get_program(),
            std::ffi::OsStr::new(crate::agent_sandbox::SANDBOX_EXEC)
        );
        let got = args_of(&command);
        assert_eq!(got[0], "-p");
        assert_eq!(got[2], "git");
        assert!(got.iter().any(|arg| arg == "core.hooksPath=/dev/null"));
    }

    #[cfg(unix)]
    #[test]
    fn a_scrubbed_command_does_not_inherit_the_parent_environment() {
        // `/bin/sh` fills in `$SHELL` from the login account when the variable is unset, so the probe is `env`,
        // which prints only what the process was given.
        let mut command = Command::new("/usr/bin/env");
        command.env("MONOCODE_SANDBOX_CANARY", "nope");
        apply_scrub(&mut command);
        let out = command.output().expect("env");
        let child_env = String::from_utf8_lossy(&out.stdout);
        assert!(
            !child_env.lines().any(|line| line.starts_with("SHELL=")),
            "SHELL reached the scrubbed command"
        );
        assert!(
            !child_env.contains("MONOCODE_SANDBOX_CANARY"),
            "a variable set on the command survived the scrub"
        );
    }

    #[test]
    fn read_only_git_disables_attributes_and_only_the_diff_family_disables_textconv() {
        let mut status = Command::new("git");
        extend_readonly(&mut status, &["status", "--porcelain"]);
        let got = args_of(&status);
        assert!(got.contains(&"--attr-source".to_string()), "{got:?}");
        assert!(got.contains(&EMPTY_TREE.to_string()));
        assert!(got
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "core.attributesFile=/dev/null"));
        assert!(!got.contains(&"--no-textconv".to_string()), "{got:?}");

        let mut diff = Command::new("git");
        extend_readonly(&mut diff, &["diff", "HEAD"]);
        let got = args_of(&diff);
        let at = got.iter().position(|arg| arg == "diff").unwrap();
        assert_eq!(got[at + 1], "--no-textconv");
        assert_eq!(got[at + 2], "--no-ext-diff");

        let mut commit = Command::new("git");
        extend_readonly(&mut commit, &["commit", "-m", "x"]);
        let got = args_of(&commit);
        assert!(!got
            .iter()
            .any(|arg| arg == "--attr-source" || arg == "--no-textconv"));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "git-cmd-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let mut command = Command::new("git");
        without_user_gitconfig(&mut command, dir);
        let ok = command
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn a_missing_git_dir_is_allowed_and_one_outside_dot_git_is_refused() {
        let root = scratch("contained");
        let fresh = root.join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        assert!(ensure_contained(&fresh).is_ok(), "git init has no .git yet");

        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_in(&repo, &["init", "-q"]);
        assert!(ensure_contained(&repo).is_ok());

        let evil = root.join("evil-gitdir");
        git_in(&root, &["init", "-q", "--bare", evil.to_str().unwrap()]);
        let pointed = root.join("pointed");
        std::fs::create_dir_all(&pointed).unwrap();
        std::fs::write(
            pointed.join(".git"),
            format!("gitdir: {}\n", evil.display()),
        )
        .unwrap();
        assert!(
            ensure_contained(&pointed).is_err(),
            "a git dir with no .git segment was allowed"
        );

        std::fs::write(
            repo.join(".git").join("commondir"),
            format!("{}\n", root.display()),
        )
        .unwrap();
        assert!(
            ensure_contained(&repo).is_err(),
            "a commondir outside .git was allowed"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_worktree_git_dir_is_allowed_and_a_dangling_one_is_refused() {
        let root = scratch("worktree");
        let main = root.join("main");
        let wt = root.join("wt");
        std::fs::create_dir_all(&main).unwrap();
        git_in(&main, &["init", "-q"]);
        git_in(&main, &["commit", "-q", "--allow-empty", "-m", "x"]);
        git_in(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        assert!(
            ensure_contained(&wt).is_ok(),
            "a real worktree was refused: {}",
            ensure_contained(&wt).unwrap_err()
        );

        let dangling = root.join("dangling");
        std::fs::create_dir_all(&dangling).unwrap();
        std::fs::write(
            dangling.join(".git"),
            format!(
                "gitdir: {}\n",
                main.join(".git")
                    .join("worktrees")
                    .join("missing")
                    .display()
            ),
        )
        .unwrap();
        assert!(
            ensure_contained(&dangling).is_err(),
            "a missing git dir was allowed"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_git_dir_that_leaves_dot_git_is_refused() {
        let root = scratch("symlink");
        let main = root.join("main");
        std::fs::create_dir_all(main.join(".git").join("worktrees")).unwrap();
        git_in(&main, &["init", "-q"]);
        let evil = root.join("evil-gitdir");
        git_in(&root, &["init", "-q", "--bare", evil.to_str().unwrap()]);
        std::os::unix::fs::symlink(&evil, main.join(".git").join("worktrees").join("name"))
            .unwrap();
        let wt = root.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(
            wt.join(".git"),
            format!(
                "gitdir: {}\n",
                main.join(".git").join("worktrees").join("name").display()
            ),
        )
        .unwrap();
        assert!(
            ensure_contained(&wt).is_err(),
            "a symlink out of .git was allowed"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn the_panel_commit_runs_the_repo_hook_and_background_git_does_not() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("hooks");
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_in(&repo, &["init", "-q"]);
        let marker = root.join("hook-ran");
        let hook = repo.join(".git").join("hooks").join("pre-commit");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\necho ran > '{}'\nexit 0\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let commit = [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "x",
        ];
        let mut panel = git_with_hooks();
        assert!(without_user_gitconfig(&mut panel, &root)
            .arg("-C")
            .arg(&repo)
            .args(commit)
            .status()
            .unwrap()
            .success());
        assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "ran");
        std::fs::remove_file(&marker).unwrap();
        let mut background = git();
        assert!(without_user_gitconfig(&mut background, &root)
            .arg("-C")
            .arg(&repo)
            .args(commit)
            .status()
            .unwrap()
            .success());
        assert!(!marker.exists(), "background git ran the repo hook");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_diff_does_not_run_textconv() {
        let root = scratch("textconv");
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_in(&repo, &["init", "-q"]);
        let marker = root.join("textconv-ran");
        git_in(
            &repo,
            &[
                "config",
                "diff.pwn.textconv",
                &format!("touch '{}'", marker.display()),
            ],
        );
        std::fs::write(repo.join(".gitattributes"), "* diff=pwn\n").unwrap();
        std::fs::write(repo.join("file"), "one\n").unwrap();
        git_in(&repo, &["add", "file", ".gitattributes"]);
        git_in(&repo, &["commit", "-q", "-m", "x"]);
        std::fs::write(repo.join("file"), "two\n").unwrap();

        let mut control = Command::new("git");
        let control = without_user_gitconfig(&mut control, &root)
            .arg("-C")
            .arg(&repo)
            .args(["diff", "HEAD"])
            .output()
            .unwrap();
        assert!(control.status.success() || control.status.code() == Some(1));
        assert!(marker.exists(), "the control diff did not run textconv");
        std::fs::remove_file(&marker).unwrap();

        let mut guarded = Command::new("git");
        without_user_gitconfig(&mut guarded, &root);
        guarded.arg("-C").arg(&repo);
        extend_readonly(&mut guarded, &["diff", "HEAD"]);
        let _ = guarded.output().unwrap();
        assert!(!marker.exists(), "textconv ran under the read-only flags");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_clean_filter_under_the_container_cannot_write_the_switch_file() {
        let root = scratch("filter");
        let home = root.join("home");
        let repo = home.join("repo");
        let data = home.join("Library/Application Support/com.ash.monocode-hub");
        std::fs::create_dir_all(data.join("settings")).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        let switch = data
            .join("settings")
            .join(crate::agent_sandbox::SETTING_FILE);
        std::fs::write(&switch, "on\n").unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(
            &repo,
            &[
                "config",
                "filter.pwn.clean",
                &format!("printf pwned > '{}'; cat", switch.display()),
            ],
        );
        git_in(&repo, &["config", "filter.pwn.required", "true"]);
        std::fs::write(repo.join(".gitattributes"), "* filter=pwn\n").unwrap();
        std::fs::write(repo.join("file"), "one\n").unwrap();
        git_in(&repo, &["add", "file", ".gitattributes"]);
        // The setup add runs the filter outside the sandbox. Put the switch back before the contained add.
        std::fs::write(&switch, "on\n").unwrap();
        let profile = crate::agent_sandbox::container_profile(&home, Some(&data)).unwrap();
        let status = Command::new(crate::agent_sandbox::SANDBOX_EXEC)
            .args(["-p", &profile, "git", "-C"])
            .arg(&repo)
            .args(["-c", "core.fsmonitor=false", "add", "--", "file"])
            .env("HOME", &home)
            .output()
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&switch).unwrap(),
            "on\n",
            "the clean filter wrote the switch file: {}",
            String::from_utf8_lossy(&status.stderr)
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
