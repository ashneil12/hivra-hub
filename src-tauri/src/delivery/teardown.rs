//! The teardown guard: a worktree whose work hasn't landed or merged is never removed (firstmate, `bin/fm-teardown.sh`:
//! "never discard unlanded work").
//!
//! What already guaranteed it, and what this adds:
//! - The worktree janitor (worktree_janitor.rs) only ever removes a clean worktree whose branch is merged, never moved,
//!   or whose pull request merged with this exact head, and `git worktree remove` runs without `--force`. A worker
//!   copy that is ahead or dirty is kept, even after `land.rs` landed it (tests in delivery/tests.rs pin that).
//! - The orchestration clean-up (`git_orchestration_worktree_remove`) removes with `--force` and deletes the branch. It
//!   applies the worker's checkpoint first in the webview; now the Rust side checks too, with `guard`, so a skipped or
//!   failed integration keeps the worktree instead of losing it.
//!
//! The person's own "Delete worktree" (with force) is their word and is not guarded here.

use std::path::Path;

/// Why a worktree may go: its work is in the project, or merged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Safe {
    /// The folder is already gone; git only forgets it.
    Missing,
    /// Everything it changed (committed or not) is already in the project's checkout.
    Landed,
    /// It is clean and its commit is in the project's history.
    Merged,
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    crate::git_cmd::child()
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .is_ok_and(|out| out.status.success())
}

fn clean(worktree: &Path) -> bool {
    crate::git_cmd::child()
        .arg("-C")
        .arg(worktree)
        .args(["status", "--porcelain", "--untracked-files=normal"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .is_ok_and(|out| out.status.success() && out.stdout.is_empty())
}

/// Whether `worktree` may be removed without losing work, with `project` the checkout its work lands in. An error says
/// why not, in words.
pub fn guard(project: &Path, worktree: &Path) -> Result<Safe, String> {
    if !worktree.exists() {
        return Ok(Safe::Missing);
    }
    if clean(worktree)
        && git_ok(
            project,
            &["merge-base", "--is-ancestor", &head(worktree)?, "HEAD"],
        )
    {
        return Ok(Safe::Merged);
    }
    if crate::land::landed_in(worktree, project)? {
        return Ok(Safe::Landed);
    }
    Err(format!(
        "{} still holds work that hasn't landed in the project or merged, so it was kept. Land or merge it first, or \
         delete it yourself if it should go.",
        worktree.display()
    ))
}

fn head(worktree: &Path) -> Result<String, String> {
    let out = crate::git_cmd::child()
        .arg("-C")
        .arg(worktree)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|e| format!("git couldn't start: {e}"))?;
    if !out.status.success() {
        return Err(format!("{} isn't a git checkout.", worktree.display()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
