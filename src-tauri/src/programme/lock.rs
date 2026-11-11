//! The programme lead lease. A fresh lock is kept. A lock past its expiry can be
//! taken, and that takeover is one activity line in the same write as the lock.
//! If the line cannot be written, the old holder stays.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::activity::{self, Who};

const DEFAULT_LEASE_MS: i64 = 15 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Acquire {
    Acquired,
    Extended,
    TakenOver { previous: String },
    Refused { holder: String, expires_at: i64 },
}

struct Row {
    holder: String,
    expires_at: i64,
}

struct Txn<'a> {
    conn: &'a Connection,
    open: bool,
}

impl Drop for Txn<'_> {
    fn drop(&mut self) {
        if self.open {
            let _ = self.conn.execute("ROLLBACK", []);
        }
    }
}

impl<'a> Txn<'a> {
    fn begin(conn: &'a Connection) -> Result<Self, String> {
        conn.execute("BEGIN IMMEDIATE", [])
            .map_err(|error| error.to_string())?;
        Ok(Self { conn, open: true })
    }

    fn commit(mut self) -> Result<(), String> {
        self.conn
            .execute("COMMIT", [])
            .map_err(|error| error.to_string())?;
        self.open = false;
        Ok(())
    }
}

pub fn acquire(
    conn: &Connection,
    project: &str,
    holder: &str,
    now: i64,
    lease_ms: i64,
) -> Result<Acquire, String> {
    let project = super::settings::project_key(project)?;
    let holder = holder_name(holder)?;
    let lease_ms = lease_ms_of(lease_ms)?;
    let txn = Txn::begin(conn)?;
    let outcome = match read(conn, &project)? {
        None => {
            insert(conn, &project, &holder, now, lease_ms)?;
            Acquire::Acquired
        }
        Some(row) if row.holder == holder => {
            let extended = row.expires_at > now;
            cas_expiry(
                conn,
                &project,
                &holder,
                row.expires_at,
                now,
                lease_ms,
                !extended,
            )?;
            if extended {
                Acquire::Extended
            } else {
                Acquire::Acquired
            }
        }
        Some(row) if row.expires_at > now => {
            let refused = Acquire::Refused {
                holder: row.holder,
                expires_at: row.expires_at,
            };
            txn.commit()?;
            return Ok(refused);
        }
        Some(row) => take_over(conn, &project, &holder, &row, now, lease_ms)?,
    };
    txn.commit()?;
    Ok(outcome)
}

pub fn heartbeat(
    conn: &Connection,
    project: &str,
    holder: &str,
    now: i64,
    lease_ms: i64,
) -> Result<bool, String> {
    let project = super::settings::project_key(project)?;
    let holder = holder_name(holder)?;
    let lease_ms = lease_ms_of(lease_ms)?;
    let txn = Txn::begin(conn)?;
    let Some(row) = read(conn, &project)? else {
        return Ok(false);
    };
    if row.holder != holder || row.expires_at <= now {
        return Ok(false);
    }
    let wrote = conn
        .execute(
            "UPDATE programme_lead_lock SET expires_at = ?2 \
             WHERE project = ?1 AND holder = ?3 AND expires_at = ?4",
            params![
                project,
                now.saturating_add(lease_ms),
                holder,
                row.expires_at
            ],
        )
        .map_err(|error| error.to_string())?;
    if wrote != 1 {
        return Ok(false);
    }
    txn.commit()?;
    Ok(true)
}

pub(crate) fn default_lease_ms() -> i64 {
    DEFAULT_LEASE_MS
}

fn take_over(
    conn: &Connection,
    project: &str,
    holder: &str,
    row: &Row,
    now: i64,
    lease_ms: i64,
) -> Result<Acquire, String> {
    let wrote = conn
        .execute(
            "UPDATE programme_lead_lock \
             SET holder = ?2, expires_at = ?3, acquired_at = ?4 \
             WHERE project = ?1 AND holder = ?5 AND expires_at = ?6",
            params![
                project,
                holder,
                now.saturating_add(lease_ms),
                now,
                row.holder,
                row.expires_at
            ],
        )
        .map_err(|error| error.to_string())?;
    if wrote != 1 {
        let current = read(conn, project)?.ok_or_else(|| {
            "That programme lead lock changed in another window. Look again.".to_string()
        })?;
        return Ok(Acquire::Refused {
            holder: current.holder,
            expires_at: current.expires_at,
        });
    }
    let who = Who::first_mate(holder, holder);
    activity::record(
        conn,
        "programme.lead_lock",
        &who,
        &who,
        project,
        "lead",
        &format!("Took over a stale programme lead lock from {}.", row.holder),
        "",
        now,
    )
    .map_err(|_| "The takeover was not recorded, so the lock was left as it was.".to_string())?;
    Ok(Acquire::TakenOver {
        previous: row.holder.clone(),
    })
}

fn insert(
    conn: &Connection,
    project: &str,
    holder: &str,
    now: i64,
    lease_ms: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO programme_lead_lock (project, holder, expires_at, acquired_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![project, holder, now.saturating_add(lease_ms), now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn cas_expiry(
    conn: &Connection,
    project: &str,
    holder: &str,
    expected_expiry: i64,
    now: i64,
    lease_ms: i64,
    reset_acquired: bool,
) -> Result<(), String> {
    let sql = if reset_acquired {
        "UPDATE programme_lead_lock \
         SET expires_at = ?2, acquired_at = ?3 \
         WHERE project = ?1 AND holder = ?4 AND expires_at = ?5"
    } else {
        "UPDATE programme_lead_lock \
         SET expires_at = ?2, acquired_at = acquired_at \
         WHERE project = ?1 AND holder = ?4 AND expires_at = ?5"
    };
    let wrote = conn
        .execute(
            sql,
            params![
                project,
                now.saturating_add(lease_ms),
                now,
                holder,
                expected_expiry
            ],
        )
        .map_err(|error| error.to_string())?;
    if wrote == 1 {
        return Ok(());
    }
    Err("That programme lead lock changed in another window. Look again.".into())
}

fn read(conn: &Connection, project: &str) -> Result<Option<Row>, String> {
    conn.query_row(
        "SELECT holder, expires_at FROM programme_lead_lock WHERE project = ?1",
        [project],
        |row| {
            Ok(Row {
                holder: row.get(0)?,
                expires_at: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn holder_name(holder: &str) -> Result<String, String> {
    let holder = holder.trim();
    if holder.is_empty() || holder.chars().count() > 200 || holder.chars().any(|c| c.is_control()) {
        return Err("Which lead?".into());
    }
    Ok(holder.to_string())
}

fn lease_ms_of(lease_ms: i64) -> Result<i64, String> {
    if lease_ms <= 0 {
        return Err("The lease needs a length.".into());
    }
    Ok(lease_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::programme::ensure_tables(&conn).unwrap();
        crate::activity::ensure_tables(&conn).unwrap();
        conn
    }

    fn summaries(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT summary FROM activity WHERE kind = 'programme.lead_lock' ORDER BY seq")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    fn holder_of(conn: &Connection, project: &str) -> (String, i64, i64) {
        conn.query_row(
            "SELECT holder, expires_at, acquired_at FROM programme_lead_lock WHERE project = ?1",
            [project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }

    #[test]
    fn a_fresh_lock_is_kept_and_a_stale_one_is_taken_with_a_line() {
        let conn = memory();
        let project = "alpha";
        assert!(matches!(
            acquire(&conn, project, "  ", 1_000, 500)
                .unwrap_err()
                .as_str(),
            "Which lead?"
        ));
        assert!(acquire(&conn, project, "lead-a", 1_000, 0).is_err());
        assert!(summaries(&conn).is_empty());

        assert_eq!(
            acquire(&conn, project, "lead-a", 1_000, 500).unwrap(),
            Acquire::Acquired
        );
        assert!(summaries(&conn).is_empty());
        assert_eq!(holder_of(&conn, project), ("lead-a".into(), 1_500, 1_000));

        assert_eq!(
            acquire(&conn, project, "lead-b", 1_200, 500).unwrap(),
            Acquire::Refused {
                holder: "lead-a".into(),
                expires_at: 1_500,
            }
        );
        assert!(summaries(&conn).is_empty());
        assert_eq!(holder_of(&conn, project).0, "lead-a");

        assert_eq!(
            acquire(&conn, project, "lead-a", 1_300, 500).unwrap(),
            Acquire::Extended
        );
        assert!(summaries(&conn).is_empty());
        assert_eq!(holder_of(&conn, project), ("lead-a".into(), 1_800, 1_000));

        assert_eq!(
            acquire(&conn, " alpha ", "lead-b", 1_800, 500).unwrap(),
            Acquire::TakenOver {
                previous: "lead-a".into(),
            }
        );
        let lines = summaries(&conn);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("stale"), "{}", lines[0]);
        assert!(lines[0].contains("lead-a"), "{}", lines[0]);
        assert_eq!(holder_of(&conn, project), ("lead-b".into(), 2_300, 1_800));

        assert_eq!(
            acquire(&conn, project, "lead-b", 2_300, 500).unwrap(),
            Acquire::Acquired
        );
        assert_eq!(summaries(&conn).len(), 1);
        assert_eq!(holder_of(&conn, project), ("lead-b".into(), 2_800, 2_300));
    }

    #[test]
    fn a_heartbeat_extends_only_the_current_lead() {
        let conn = memory();
        assert!(!heartbeat(&conn, "alpha", "lead-a", 1_000, 500).unwrap());
        acquire(&conn, "alpha", "lead-a", 1_000, 500).unwrap();
        assert!(heartbeat(&conn, "alpha", "lead-a", 1_200, 500).unwrap());
        assert_eq!(holder_of(&conn, "alpha"), ("lead-a".into(), 1_700, 1_000));
        assert!(!heartbeat(&conn, "alpha", "lead-b", 1_300, 500).unwrap());
        assert_eq!(holder_of(&conn, "alpha").0, "lead-a");
        assert!(!heartbeat(&conn, "alpha", "lead-a", 1_700, 500).unwrap());
        assert_eq!(holder_of(&conn, "alpha"), ("lead-a".into(), 1_700, 1_000));
        assert!(summaries(&conn).is_empty());
    }

    #[test]
    fn a_takeover_without_a_log_line_does_not_keep_the_lock() {
        let conn = Connection::open_in_memory().unwrap();
        crate::programme::ensure_tables(&conn).unwrap();
        acquire(&conn, "alpha", "lead-a", 1_000, 500).unwrap();
        let error = acquire(&conn, "alpha", "lead-b", 1_500, 500).unwrap_err();
        assert!(error.contains("left as it was"), "{error}");
        assert_eq!(holder_of(&conn, "alpha"), ("lead-a".into(), 1_500, 1_000));
    }

    #[test]
    fn two_spellings_of_one_folder_share_one_lock() {
        let root = std::env::temp_dir().join(format!("hivra-wp162-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("project")).unwrap();
        let project = root.join("project");
        let dotted = project.join("..").join("project");
        let conn = memory();
        acquire(&conn, project.to_str().unwrap(), "lead-a", 1_000, 500).unwrap();
        let refused = acquire(&conn, dotted.to_str().unwrap(), "lead-b", 1_100, 500).unwrap();
        assert!(matches!(refused, Acquire::Refused { .. }), "{refused:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
