//! Where a programme package's worktree is. The row is untrusted: names are
//! checked again before any git command, and two windows only write the row
//! they last read.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::names;

const STALE: &str = "That package worktree changed in another window. Look again, then set it.";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Checkout {
    pub package_id: String,
    pub project: String,
    pub worktree: String,
    pub branch: String,
    pub base: String,
    pub remote: String,
    pub updated_at: i64,
}

pub struct Bind<'a> {
    pub package_id: &'a str,
    pub project: &'a str,
    pub worktree: &'a Path,
    pub branch: &'a str,
    pub base: &'a str,
    pub remote: &'a str,
    /// None when the package has no row yet. A row written since the last read is refused.
    pub expected_updated_at: Option<i64>,
    pub now: i64,
}

pub fn get(conn: &Connection, package_id: &str) -> Result<Option<Checkout>, String> {
    let package_id = names::package_id(package_id)?;
    let found = conn
        .query_row(
            "SELECT package_id, project, worktree, branch, base_branch, remote_name, updated_at \
             FROM programme_checkouts WHERE package_id = ?1",
            [package_id],
            read_row,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(found)
}

pub fn bind(conn: &Connection, bind: Bind<'_>) -> Result<Checkout, String> {
    let package_id = names::package_id(bind.package_id)?.to_string();
    let branch = names::branch_name(bind.branch)?.to_string();
    let base = names::branch_name(bind.base)?.to_string();
    let remote = names::remote_name(bind.remote)?.to_string();
    let project = super::settings::project_key(bind.project)?;
    let worktree = worktree_text(bind.worktree)?;
    let existing = get(conn, &package_id)?;
    if existing.as_ref().map(|row| row.updated_at) != bind.expected_updated_at {
        return Err(STALE.into());
    }
    let wrote = if bind.expected_updated_at.is_none() {
        conn.execute(
            "INSERT INTO programme_checkouts \
             (package_id, project, worktree, branch, base_branch, remote_name, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![package_id, project, worktree, branch, base, remote, bind.now],
        )
    } else {
        conn.execute(
            "UPDATE programme_checkouts \
             SET project = ?2, worktree = ?3, branch = ?4, base_branch = ?5, remote_name = ?6, \
                 updated_at = ?7 \
             WHERE package_id = ?1 AND updated_at = ?8",
            params![
                package_id,
                project,
                worktree,
                branch,
                base,
                remote,
                bind.now,
                bind.expected_updated_at
            ],
        )
    };
    match wrote {
        Ok(0) => Err(STALE.into()),
        Ok(_) => {
            get(conn, &package_id)?.ok_or_else(|| "That package worktree was not saved.".into())
        }
        Err(error) if constraint(&error) => Err(STALE.into()),
        Err(error) => Err(error.to_string()),
    }
}

fn worktree_text(path: &Path) -> Result<String, String> {
    let canonical = crate::fs::canonical(path)
        .map_err(|_| "That worktree folder could not be read. Nothing was changed.".to_string())?;
    if !canonical.is_dir() {
        return Err("That worktree folder could not be read. Nothing was changed.".into());
    }
    canonical
        .into_os_string()
        .into_string()
        .map_err(|_| "That worktree folder could not be read. Nothing was changed.".to_string())
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Checkout> {
    Ok(Checkout {
        package_id: row.get(0)?,
        project: row.get(1)?,
        worktree: row.get(2)?,
        branch: row.get(3)?,
        base: row.get(4)?,
        remote: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn constraint(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

pub(crate) fn path_of(checkout: &Checkout) -> PathBuf {
    PathBuf::from(&checkout.worktree)
}
