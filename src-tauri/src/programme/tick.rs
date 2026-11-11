//! What the lead tick asks when a package's pull request conflicts with main.
//!
//! The lead tick (src/features/leadTick) calls `programme_consider_conflict` only
//! for a conflicting pull request. When "Update conflicting packages from main" is
//! off, the answer is a report and no git runs at all. When it is on, the package
//! worktree is the one worktree in the project folder that has the package's
//! branch checked out. That is recorded, then updated from main. Main is never edited.

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

use super::checkout;
use super::names;
use super::settings;
use super::update::{Plan, UpdateReport};

const REPORT_ONLY: &str =
    "This package conflicts with main. It was only reported. Nothing was merged or rebased.";
const NO_WORKTREE: &str = "That package has no worktree recorded.";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Tick {
    /// The setting is off, or there is nothing to update. Git was not run.
    Reported { message: String },
    /// The setting is on, so the package branch was updated from main.
    Ran(UpdateReport),
}

/// What the command does next. Git runs outside the database lock.
pub(crate) enum Next {
    Done(Tick),
    /// No worktree is recorded yet: find the one with the branch checked out.
    Find {
        branch: String,
    },
    Update(Plan),
}

pub(crate) fn next(
    conn: &Connection,
    project: &str,
    package_id: &str,
    branch: &str,
) -> Result<Next, String> {
    let project = settings::project_key(project)?;
    if !settings::get(conn, &project)?.update_conflicting {
        return Ok(Next::Done(Tick::Reported {
            message: REPORT_ONLY.into(),
        }));
    }
    let branch = names::branch_name(branch)?.to_string();
    let Some(recorded) = checkout::get(conn, package_id)? else {
        return Ok(Next::Find { branch });
    };
    if recorded.project != project {
        return Ok(Next::Done(Tick::Reported {
            message: "That package's worktree belongs to another project. Nothing was changed."
                .into(),
        }));
    }
    match super::update::load(conn, package_id)? {
        Some(plan) => Ok(Next::Update(plan)),
        None => Ok(Next::Done(Tick::Reported {
            message: NO_WORKTREE.into(),
        })),
    }
}

/// Records the worktree found for a package's branch, so later ticks reuse it.
pub(crate) fn record(
    conn: &Connection,
    project: &str,
    package_id: &str,
    worktree: &Path,
    branch: &str,
    now: i64,
) -> Result<(), String> {
    checkout::bind(
        conn,
        checkout::Bind {
            package_id,
            project,
            worktree,
            branch,
            base: "main",
            remote: "origin",
            expected_updated_at: None,
            now,
        },
    )
    .map(|_| ())
}

#[cfg(test)]
pub fn consider_conflict(
    conn: &Connection,
    project: &str,
    package_id: &str,
    branch: &str,
) -> Result<Tick, String> {
    match next(conn, project, package_id, branch)? {
        Next::Done(tick) => Ok(tick),
        Next::Find { .. } => Ok(Tick::Reported {
            message: NO_WORKTREE.into(),
        }),
        Next::Update(plan) => Ok(Tick::Ran(super::update::execute(&plan))),
    }
}
