//! The app's own git calls. The app's git goes through `git()` or `child()`, which turn off `core.fsmonitor` and point
//! `core.hooksPath` at /dev/null, so a config file an agent could write (a linked worktree's `.git` file, a global git
//! config) cannot name a command the app then runs outside the sandbox (WP-178 review r2, HIGH-2). The after-turn checks,
//! the worktree sweep and the janitor use these.
//!
//! Attribution's crew commits run the repo's own hooks on purpose (its forwarder), so they use `child_keep_hooks()`:
//! fsmonitor is still off, and the hooks path is left to the repo. Those commits are the one place
//! a repo hook runs unsandboxed; docs/hivra/work/WP-178-agent-os-sandbox.md records that as a known limit.
//!
//! The settings are leading `-c` arguments, so they come before whatever the caller adds (`-C dir`, the subcommand).

use std::process::Command;

const FSMONITOR: &str = "core.fsmonitor=false";
const NO_HOOKS: &str = "core.hooksPath=/dev/null";

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

/// `git`, hardened: no fsmonitor, no hooks.
pub fn git() -> Command {
    with_settings(Command::new("git"), &[FSMONITOR, NO_HOOKS])
}

/// `git` from the app's scrubbed child environment (`delivery::child`), hardened: no fsmonitor, no hooks.
pub(crate) fn child() -> std::process::Command {
    with_settings(crate::delivery::child("git"), &[FSMONITOR, NO_HOOKS])
}

/// `git` with fsmonitor off, and the repo's own hooks still run. Attribution's tests use it for their own commits.
#[cfg(test)]
pub(crate) fn git_keep_hooks() -> Command {
    with_settings(Command::new("git"), &[FSMONITOR])
}

/// `git` from the scrubbed child environment, with fsmonitor off and the repo's own hooks still run.
pub(crate) fn child_keep_hooks() -> std::process::Command {
    with_settings(crate::delivery::child("git"), &[FSMONITOR])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hardening_reaches_git_and_turns_fsmonitor_and_hooks_off() {
        let out = git()
            .args(["config", "--get-all", "core.fsmonitor"])
            .output()
            .expect("git runs");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "false");
        let hooks = git()
            .args(["config", "--get-all", "core.hooksPath"])
            .output()
            .expect("git runs");
        assert_eq!(String::from_utf8_lossy(&hooks.stdout).trim(), "/dev/null");
    }
}
