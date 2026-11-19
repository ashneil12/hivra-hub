//! Per project: whether a lead tick may update a conflicting package, and
//! whether that update merges or rebases. Both are off the dangerous path by
//! default: the tick does nothing, and an update merges.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const STALE: &str = "That setting changed in another window. Look again, then set it.";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Strategy {
    Merge,
    Rebase,
}

impl Strategy {
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "merge" => Some(Self::Merge),
            "rebase" => Some(Self::Rebase),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Rebase => "rebase",
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub project: String,
    /// Off until the person turns it on. The lead tick then only reports a conflict.
    pub update_conflicting: bool,
    pub strategy: Strategy,
    pub version: i64,
}

pub fn get(conn: &Connection, project: &str) -> Result<UpdateSettings, String> {
    let project = project_key(project)?;
    let found = conn
        .query_row(
            "SELECT update_conflicting, strategy, version FROM programme_update_settings \
             WHERE project = ?1",
            [&project],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(match found {
        Some((flag, strategy, version)) => UpdateSettings {
            project,
            update_conflicting: flag != 0,
            // A value written by something else is not a strategy. Merge is the safe default.
            strategy: Strategy::parse(&strategy).unwrap_or(Strategy::Merge),
            version,
        },
        None => UpdateSettings {
            project,
            update_conflicting: false,
            strategy: Strategy::Merge,
            version: 0,
        },
    })
}

pub fn set(
    conn: &Connection,
    project: &str,
    update_conflicting: bool,
    strategy: Strategy,
    expected_version: i64,
    now: i64,
) -> Result<UpdateSettings, String> {
    let current = get(conn, project)?;
    if current.version != expected_version {
        return Err(STALE.into());
    }
    let flag = i64::from(update_conflicting);
    let wrote = if expected_version == 0 {
        conn.execute(
            "INSERT INTO programme_update_settings \
             (project, update_conflicting, strategy, version, updated_at) \
             VALUES (?1, ?2, ?3, 1, ?4)",
            params![current.project, flag, strategy.as_str(), now],
        )
    } else {
        conn.execute(
            "UPDATE programme_update_settings \
             SET update_conflicting = ?2, strategy = ?3, version = version + 1, updated_at = ?4 \
             WHERE project = ?1 AND version = ?5",
            params![
                current.project,
                flag,
                strategy.as_str(),
                now,
                expected_version
            ],
        )
    };
    match wrote {
        Ok(0) => Err(STALE.into()),
        Ok(_) => get(conn, &current.project),
        Err(error) if constraint(&error) => Err(STALE.into()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn project_key(project: &str) -> Result<String, String> {
    let project = crate::delivery::settings::key(project);
    if project.is_empty() {
        return Err("Which project? Its folder is needed.".into());
    }
    Ok(project)
}

fn constraint(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::ConstraintViolation
    )
}
