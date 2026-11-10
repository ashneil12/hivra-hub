//! What a lead tick calls when a package conflicts with main.
//!
//! WP-160 owns the timer. This does not start one. When "Update conflicting
//! packages from main" is off, the tick only reports the conflict and does not
//! run git. Main is never edited either way.

use rusqlite::Connection;
use serde::Serialize;

use super::checkout;
use super::settings;
use super::update::{self, UpdateReport};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Tick {
    /// The setting is off, or there is nothing to update. Git was not run.
    Reported { message: String },
    /// The setting is on, so the package branch was updated from main.
    Ran(UpdateReport),
}

pub fn consider_conflict(conn: &Connection, package_id: &str) -> Result<Tick, String> {
    let Some(checkout) = checkout::get(conn, package_id)? else {
        return Ok(Tick::Reported {
            message: "That package has no worktree recorded.".into(),
        });
    };
    if !settings::get(conn, &checkout.project)?.update_conflicting {
        return Ok(Tick::Reported {
            message: "This package conflicts with main. It was only reported. Nothing was merged or rebased.".into(),
        });
    }
    Ok(Tick::Ran(update::update_from_main(conn, package_id)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::programme::ensure_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn a_missing_package_is_only_reported() {
        let conn = memory();
        match consider_conflict(&conn, "pkg-1").unwrap() {
            Tick::Reported { message } => assert!(message.contains("no worktree"), "{message}"),
            other => panic!("expected a report, got {other:?}"),
        }
        assert!(consider_conflict(&conn, " ").is_err());
        assert!(consider_conflict(&conn, "../pkg").is_err());
    }
}
