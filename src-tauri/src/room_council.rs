//! WP-23: a council's row, written on its own so a room save cannot wipe it.
//!
//! `expected` is the revision this write replaces (0 when the room has no council yet). The record's own `revision`
//! must be one past that. A write that lost the race returns the row that won and changes nothing. A missing row is
//! written again; a second insert of the same room keeps the row that landed.

use rusqlite::{
    params, Connection, Error, ErrorCode, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::session_store::{now_millis, SessionStore};

const ID_MAX: usize = 200;
const TEXT_MAX: usize = 100_000;

pub(crate) fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS room_council (
           room_id TEXT PRIMARY KEY,
           revision INTEGER NOT NULL,
           json TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )
}

pub(crate) fn rows(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut council = conn
        .prepare("SELECT room_id, json FROM room_council")
        .map_err(|e| e.to_string())?;
    let council_rows = council
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(council);
    Ok(council_rows)
}

pub(crate) fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM room_council WHERE room_id = ?1", params![id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn id_ok(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > ID_MAX || value.chars().any(char::is_control) {
        return Err(format!("room id must be 1 to {ID_MAX} characters"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CouncilWrite {
    pub applied: bool,
    pub revision: i64,
    pub json: String,
}

/// Insert one council row. A room that already has one keeps that row (`applied: false`); nothing is overwritten.
pub(crate) fn insert_council(
    tx: &Transaction,
    room_id: &str,
    rev: i64,
    json: &str,
    now: i64,
) -> Result<CouncilWrite, String> {
    match tx.execute(
        "INSERT INTO room_council (room_id, revision, json, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![room_id, rev, json, now],
    ) {
        Ok(_) => Ok(CouncilWrite {
            applied: true,
            revision: rev,
            json: json.to_string(),
        }),
        Err(Error::SqliteFailure(err, _)) if err.code == ErrorCode::ConstraintViolation => {
            let (have, body) = tx
                .query_row(
                    "SELECT revision, json FROM room_council WHERE room_id = ?1",
                    params![room_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(|e| e.to_string())?;
            Ok(CouncilWrite {
                applied: false,
                revision: have,
                json: body,
            })
        }
        Err(error) => Err(error.to_string()),
    }
}

pub fn set_council(
    conn: &mut Connection,
    room_id: &str,
    expected: i64,
    json: &str,
    now: i64,
) -> Result<CouncilWrite, String> {
    id_ok(room_id)?;
    if expected < 0 {
        return Err("the revision is not a whole number".into());
    }
    if json.len() > TEXT_MAX {
        return Err("the council record is too long".into());
    }
    let value: Value =
        serde_json::from_str(json).map_err(|_| "the council record is not json".to_string())?;
    let rev = value
        .as_object()
        .ok_or("the council record is not an object")?
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or("the council record has no revision")?;
    if rev != expected + 1 {
        return Err("the council record's revision does not follow the one it replaces".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let room_exists: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM rooms WHERE id = ?1",
            params![room_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if room_exists.is_none() {
        return Err("that room does not exist".into());
    }
    let current: Option<(i64, String)> = tx
        .query_row(
            "SELECT revision, json FROM room_council WHERE room_id = ?1",
            params![room_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let outcome = if let Some((have, body)) = current {
        if have != expected {
            CouncilWrite {
                applied: false,
                revision: have,
                json: body,
            }
        } else {
            let n = tx
                .execute(
                    "UPDATE room_council SET revision = ?2, json = ?3, updated_at = ?4 WHERE room_id = ?1 AND revision = ?5",
                    params![room_id, rev, json, now, expected],
                )
                .map_err(|e| e.to_string())?;
            if n == 1 {
                CouncilWrite {
                    applied: true,
                    revision: rev,
                    json: json.to_string(),
                }
            } else {
                let (have, body) = tx
                    .query_row(
                        "SELECT revision, json FROM room_council WHERE room_id = ?1",
                        params![room_id],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                    )
                    .map_err(|e| e.to_string())?;
                CouncilWrite {
                    applied: false,
                    revision: have,
                    json: body,
                }
            }
        }
    } else {
        // No row, including a revision past 0: the row was removed. Write it. A racing insert keeps the one that landed.
        insert_council(&tx, room_id, rev, json, now)?
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(outcome)
}

#[tauri::command(async)]
pub fn rooms_set_council(
    store: State<'_, SessionStore>,
    room_id: String,
    expected_revision: i64,
    json: String,
) -> Result<CouncilWrite, String> {
    set_council(
        &mut *store.lock_conn()?,
        &room_id,
        expected_revision,
        &json,
        now_millis(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rooms::{ensure_tables, upsert_room, RoomInput};

    #[test]
    fn a_second_insert_keeps_the_row_that_landed() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        let made = RoomInput {
            id: "old".into(),
            project_id: "hub".into(),
            name: "Council".into(),
            ..Default::default()
        };
        upsert_room(&mut conn, &made, 1).unwrap();
        let tx = conn.transaction().unwrap();
        let first =
            insert_council(&tx, "old", 1, r#"{"revision":1,"question":"Ship?"}"#, 2).unwrap();
        assert!(first.applied);
        let second =
            insert_council(&tx, "old", 2, r#"{"revision":2,"question":"late"}"#, 3).unwrap();
        assert!(!second.applied);
        assert!(second.json.contains("Ship?"));
        assert!(!second.json.contains("late"));
    }
}
