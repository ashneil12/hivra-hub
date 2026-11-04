//! Timers a first mate sets (Hivra WP-11): "wake me at 9 to look at the deploy". A timer is a row; when it falls due the
//! watcher turns it into a wake in the same transaction, so a restart can neither lose it nor fire it twice.

use rusqlite::{params, Connection, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::queue::{self, Wake, WakeInput};

pub const ARMED: &str = "armed";

/// A timer is at least a minute out and at most 30 days.
pub const MIN_DELAY: i64 = 60_000;
pub const MAX_DELAY: i64 = 30 * 24 * 60 * 60_000;
/// A chat holds at most this many armed timers.
pub const ARMED_MAX: usize = 20;
const NOTE_MAX: usize = 500;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub id: String,
    pub owner_session: String,
    pub due_at: i64,
    pub note: String,
    pub state: String,
    pub wake_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS firstmate_timers (
           id TEXT PRIMARY KEY,
           owner_session TEXT NOT NULL,
           due_at INTEGER NOT NULL,
           note TEXT NOT NULL,
           state TEXT NOT NULL,
           wake_id TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS firstmate_timers_due ON firstmate_timers(state, due_at);",
    )
}

const COLUMNS: &str = "id, owner_session, due_at, note, state, wake_id, created_at, updated_at";

fn from_row(row: &Row) -> rusqlite::Result<Timer> {
    Ok(Timer {
        id: row.get(0)?,
        owner_session: row.get(1)?,
        due_at: row.get(2)?,
        note: row.get(3)?,
        state: row.get(4)?,
        wake_id: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn query(
    conn: &Connection,
    clause: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Timer>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM firstmate_timers {clause}"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(args, from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string());
    rows
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerInput {
    pub owner_session: String,
    /// When, epoch ms.
    pub due_at: i64,
    /// What to look at then, in the first mate's own words.
    pub note: String,
}

/// Arm a timer, in plain refusals the model can act on.
pub fn set(conn: &mut Connection, input: TimerInput, now: i64) -> Result<Timer, String> {
    let owner = input.owner_session.trim().to_string();
    if !queue::session_ok(&owner) {
        return Err("a timer names the chat it wakes".into());
    }
    let note: String = input.note.trim().chars().take(NOTE_MAX).collect();
    if note.is_empty() {
        return Err("say what to look at when the timer fires".into());
    }
    if input.due_at < now + MIN_DELAY {
        return Err("a timer is at least a minute from now".into());
    }
    if input.due_at > now + MAX_DELAY {
        return Err("a timer is at most 30 days from now".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let armed: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM firstmate_timers WHERE owner_session = ?1 AND state = 'armed'",
            params![owner],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if armed as usize >= ARMED_MAX {
        return Err(format!(
            "this chat already has {ARMED_MAX} timers set; cancel one first"
        ));
    }
    let timer = Timer {
        id: format!("timer-{}", uuid::Uuid::new_v4().simple()),
        owner_session: owner,
        due_at: input.due_at,
        note,
        state: ARMED.into(),
        wake_id: None,
        created_at: now,
        updated_at: now,
    };
    tx.execute(
        "INSERT INTO firstmate_timers (id, owner_session, due_at, note, state, wake_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
        params![
            timer.id,
            timer.owner_session,
            timer.due_at,
            timer.note,
            timer.state,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(timer)
}

/// Cancel one of the chat's own armed timers. Returns it, or none when it isn't armed (or isn't this chat's).
pub fn cancel(
    conn: &mut Connection,
    owner: &str,
    id: &str,
    now: i64,
) -> Result<Option<Timer>, String> {
    let changed = conn
        .execute(
            "UPDATE firstmate_timers SET state = 'cancelled', updated_at = ?3
              WHERE id = ?1 AND owner_session = ?2 AND state = 'armed'",
            params![id, owner, now],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Ok(None);
    }
    Ok(query(conn, "WHERE id = ?1", &[&id])?.into_iter().next())
}

/// A chat's armed timers, soonest first.
pub fn armed(conn: &Connection, owner: &str) -> Result<Vec<Timer>, String> {
    query(
        conn,
        "WHERE owner_session = ?1 AND state = 'armed' ORDER BY due_at",
        &[&owner],
    )
}

fn when(due_at: i64, now: i64) -> String {
    let late = (now - due_at).max(0) / 60_000;
    if late >= 2 {
        format!(" (due {late} minutes ago; the app was closed)")
    } else {
        String::new()
    }
}

/// Every armed timer due by `now` fires: it becomes a wake (`timer:<id>`) and the timer is marked fired, together.
pub fn fire_due(conn: &mut Connection, now: i64) -> Result<Vec<Wake>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let due = query(
        &tx,
        "WHERE state = 'armed' AND due_at <= ?1 ORDER BY due_at",
        &[&now],
    )?;
    let mut woke = Vec::new();
    for timer in due {
        let added = queue::add_in(
            &tx,
            WakeInput {
                owner_session: timer.owner_session.clone(),
                kind: "timer".into(),
                key: format!("timer:{}", timer.id),
                title: Some("Timer".into()),
                text: format!("Your timer{}: {}", when(timer.due_at, now), timer.note),
                ..Default::default()
            },
            now,
        )?;
        tx.execute(
            "UPDATE firstmate_timers SET state = 'fired', wake_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![timer.id, added.wake.id, now],
        )
        .map_err(|e| e.to_string())?;
        if added.fresh {
            woke.push(added.wake);
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(woke)
}

/// Delete fired and cancelled timers `queue::KEEP_SETTLED` on.
pub fn prune(conn: &Connection, now: i64) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM firstmate_timers WHERE state IN ('fired', 'cancelled') AND updated_at < ?1",
        params![now - queue::KEEP_SETTLED],
    )
    .map_err(|e| e.to_string())
}
