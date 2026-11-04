//! Hivra WP-14: steering, a first mate's messages to a worker that is already running (docs/hivra/SPEC.md section 4,
//! docs/hivra/work/WP-14-steering-decisions.md).
//!
//! A message is stored here first, then delivered the way the worker's CLI allows (firstmate's durable inbox:
//! `fm-send.sh`, an inbox record plus a doorbell re-rung until acked; PandaCode's hold and replay):
//!
//! - **pending**: stored, not yet in the worker's chat. Either nobody has tried yet, or the worker was busy on a CLI
//!   that can't take a message mid-turn and it is **held** (`held_at`) to go in as the worker's next turn.
//! - **delivered**: it went in (`delivery`: `steered` into the running turn, or `started` as a new turn).
//! - **failed**: it can't go in (the worker's chat is gone, or delivery failed `MAX_ATTEMPTS` times), with the reason.
//!
//! Only pending moves, and only forwards, so a late or repeated report changes nothing. Pending rows are what the app
//! replays after a restart and whenever a held worker goes idle (src/features/firstmate/hooks/useSteering.ts).
//!
//! Caps refuse with a plain reason instead of cutting (OpenBot): a message over `TEXT_MAX` is refused, not truncated,
//! and a worker with `PENDING_MAX` messages still waiting takes no more until they go in.
//!
//! Own table, made by `ensure_tables` (no numbered migration, so upstream's migration numbers can't collide).

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::session_store::{now_millis, SessionStore};

/// Tauri event after any change: `{ids, children}`.
pub const CHANGED: &str = "hivra:steering-changed";

pub const PENDING: &str = "pending";
pub const DELIVERED: &str = "delivered";
pub const FAILED: &str = "failed";

pub const STEERED: &str = "steered";
pub const STARTED: &str = "started";

/// How the sender wants it in: `auto` (steer if the CLI can, else the next turn), `steer`, or `queue` (next turn).
const MODES: [&str; 3] = ["auto", "steer", "queue"];

pub const TEXT_MAX: usize = 8_000;
pub const PENDING_MAX: usize = 20;
pub const MAX_ATTEMPTS: i64 = 5;
const ERROR_MAX: usize = 1_000;
const LIST_MAX: usize = 50;

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS steer_messages (
           id TEXT PRIMARY KEY,
           owner_session TEXT NOT NULL,
           child_session TEXT NOT NULL,
           delegation_id TEXT,
           request_id TEXT NOT NULL,
           source TEXT NOT NULL DEFAULT 'first-mate',
           decision_key TEXT,
           text TEXT NOT NULL,
           mode TEXT NOT NULL DEFAULT 'auto',
           state TEXT NOT NULL,
           delivery TEXT,
           attempts INTEGER NOT NULL DEFAULT 0,
           error TEXT,
           held_at INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           delivered_at INTEGER,
           UNIQUE (owner_session, request_id)
         );
         CREATE INDEX IF NOT EXISTS steer_messages_pending ON steer_messages(state, created_at);
         CREATE INDEX IF NOT EXISTS steer_messages_child ON steer_messages(child_session, created_at);",
    )
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SteerMessage {
    pub id: String,
    pub owner_session: String,
    pub child_session: String,
    pub delegation_id: Option<String>,
    pub request_id: String,
    /// `first-mate` (task_message) or `decision` (an answered decision releasing its waiting work).
    pub source: String,
    pub decision_key: Option<String>,
    pub text: String,
    pub mode: String,
    pub state: String,
    pub delivery: Option<String>,
    pub attempts: i64,
    pub error: Option<String>,
    /// Set while the worker was busy on a CLI that can't take it mid-turn: it goes in as the next turn.
    pub held_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub delivered_at: Option<i64>,
}

const COLUMNS: &str = "id, owner_session, child_session, delegation_id, request_id, source, decision_key, text, mode, \
     state, delivery, attempts, error, held_at, created_at, updated_at, delivered_at";

fn from_row(row: &Row) -> rusqlite::Result<SteerMessage> {
    Ok(SteerMessage {
        id: row.get(0)?,
        owner_session: row.get(1)?,
        child_session: row.get(2)?,
        delegation_id: row.get(3)?,
        request_id: row.get(4)?,
        source: row.get(5)?,
        decision_key: row.get(6)?,
        text: row.get(7)?,
        mode: row.get(8)?,
        state: row.get(9)?,
        delivery: row.get(10)?,
        attempts: row.get(11)?,
        error: row.get(12)?,
        held_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        delivered_at: row.get(16)?,
    })
}

fn query(
    conn: &Connection,
    tail: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<SteerMessage>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM steer_messages {tail}"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(args, from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string());
    rows
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<SteerMessage>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM steer_messages WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn id_like(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("Invalid {label}"));
    }
    Ok(value.to_string())
}

fn cap(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerInput {
    pub owner_session: String,
    pub child_session: String,
    #[serde(default)]
    pub delegation_id: Option<String>,
    pub request_id: String,
    pub text: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub decision_key: Option<String>,
}

/// Store a message before anything tries to deliver it. The same sender and request id with the same text is the same
/// message (a retried call never sends twice); with other text it is refused.
pub fn record(conn: &Connection, input: SteerInput, now: i64) -> Result<SteerMessage, String> {
    let owner = id_like(&input.owner_session, "owner session", 256)?;
    let child = id_like(&input.child_session, "worker session", 256)?;
    let request = id_like(&input.request_id, "request id", 300)?;
    let text = input.text.trim().to_string();
    if text.is_empty() {
        return Err("The message is empty.".into());
    }
    let length = text.chars().count();
    if length > TEXT_MAX {
        return Err(format!(
            "The message is {length} characters; a steering message holds at most {TEXT_MAX}. Send the essentials, or \
             put the detail in a file in the worker's checkout and name it."
        ));
    }
    let mode = input.mode.unwrap_or_else(|| "auto".into());
    if !MODES.contains(&mode.as_str()) {
        return Err("whenBusy must be auto, steer or queue".into());
    }
    let source = input.source.unwrap_or_else(|| "first-mate".into());
    if !["first-mate", "decision"].contains(&source.as_str()) {
        return Err("Unknown steering source".into());
    }
    if let Some(existing) = query(
        conn,
        "WHERE owner_session = ?1 AND request_id = ?2",
        &[&owner, &request],
    )?
    .into_iter()
    .next()
    {
        if existing.text != text {
            return Err("That request id was already used with another message.".into());
        }
        return Ok(existing);
    }
    let waiting: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM steer_messages WHERE child_session = ?1 AND state = 'pending'",
            [&child],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if waiting as usize >= PENDING_MAX {
        return Err(format!(
            "That worker already has {waiting} messages waiting to go in; it takes no more until they do. Wait for its \
             next turn, or stop it with task_cancel and brief a new one."
        ));
    }
    let message = SteerMessage {
        id: format!("s-{}", uuid::Uuid::new_v4().simple()),
        owner_session: owner,
        child_session: child,
        delegation_id: input.delegation_id.filter(|d| !d.trim().is_empty()),
        request_id: request,
        source,
        decision_key: input.decision_key,
        text,
        mode,
        state: PENDING.into(),
        delivery: None,
        attempts: 0,
        error: None,
        held_at: None,
        created_at: now,
        updated_at: now,
        delivered_at: None,
    };
    conn.execute(
        &format!(
            "INSERT INTO steer_messages ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, \
             ?14, ?15, ?16, ?17)"
        ),
        params![
            message.id,
            message.owner_session,
            message.child_session,
            message.delegation_id,
            message.request_id,
            message.source,
            message.decision_key,
            message.text,
            message.mode,
            message.state,
            message.delivery,
            message.attempts,
            message.error,
            message.held_at,
            message.created_at,
            message.updated_at,
            message.delivered_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(message)
}

/// Every message still to go in, oldest first: what the app replays.
pub fn pending(conn: &Connection) -> Result<Vec<SteerMessage>, String> {
    query(
        conn,
        "WHERE state = 'pending' ORDER BY created_at, rowid LIMIT 500",
        &[],
    )
}

/// The newest messages to one worker chat, or from one sender (either may be left out, not both).
pub fn list(
    conn: &Connection,
    child: Option<&str>,
    owner: Option<&str>,
) -> Result<Vec<SteerMessage>, String> {
    let limit = LIST_MAX as i64;
    match (child, owner) {
        (Some(child), Some(owner)) => query(
            conn,
            "WHERE child_session = ?1 AND owner_session = ?2 ORDER BY created_at DESC, rowid DESC LIMIT ?3",
            &[&child, &owner, &limit],
        ),
        (Some(child), None) => query(
            conn,
            "WHERE child_session = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
            &[&child, &limit],
        ),
        (None, Some(owner)) => query(
            conn,
            "WHERE owner_session = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
            &[&owner, &limit],
        ),
        (None, None) => Err("Name a worker session or a sender".into()),
    }
}

/// What happened to one delivery attempt.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    /// It went in: `steered` into the running turn or `started` as a new one.
    Delivered { delivery: String },
    /// The worker is busy and its CLI can't take it mid-turn: kept to go in as its next turn.
    Held,
    /// This try failed; it is tried again until `MAX_ATTEMPTS`, then fails for good. `fatal` fails it at once (the
    /// worker's chat is gone).
    Failed {
        error: String,
        #[serde(default)]
        fatal: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub applied: bool,
    pub message: Option<SteerMessage>,
}

/// Record a delivery attempt. Only a pending message moves; anything else changes nothing and says so.
pub fn settle(conn: &Connection, id: &str, outcome: Outcome, now: i64) -> Result<Change, String> {
    let Some(mut message) = get(conn, id)? else {
        return Ok(Change {
            applied: false,
            message: None,
        });
    };
    if message.state != PENDING {
        return Ok(Change {
            applied: false,
            message: Some(message),
        });
    }
    match outcome {
        Outcome::Delivered { delivery } => {
            if delivery != STEERED && delivery != STARTED {
                return Err("delivery must be steered or started".into());
            }
            message.state = DELIVERED.into();
            message.delivery = Some(delivery);
            message.delivered_at = Some(now);
            message.error = None;
        }
        Outcome::Held => {
            if message.held_at.is_some() {
                return Ok(Change {
                    applied: false,
                    message: Some(message),
                });
            }
            message.held_at = Some(now);
        }
        Outcome::Failed { error, fatal } => {
            message.attempts += 1;
            message.error = Some(cap(error.trim(), ERROR_MAX));
            if fatal || message.attempts >= MAX_ATTEMPTS {
                message.state = FAILED.into();
            }
        }
    }
    message.updated_at = now;
    conn.execute(
        "UPDATE steer_messages SET state = ?2, delivery = ?3, attempts = ?4, error = ?5, held_at = ?6, \
         updated_at = ?7, delivered_at = ?8 WHERE id = ?1 AND state = 'pending'",
        params![
            message.id,
            message.state,
            message.delivery,
            message.attempts,
            message.error,
            message.held_at,
            message.updated_at,
            message.delivered_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(Change {
        applied: true,
        message: Some(message),
    })
}

pub(crate) fn changed(app: &AppHandle, messages: &[&SteerMessage]) {
    if messages.is_empty() {
        return;
    }
    let ids: Vec<&str> = messages.iter().map(|m| m.id.as_str()).collect();
    let children: Vec<&str> = messages.iter().map(|m| m.child_session.as_str()).collect();
    let _ = app.emit(
        CHANGED,
        serde_json::json!({ "ids": ids, "children": children }),
    );
}

#[tauri::command(async)]
pub fn steering_record(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: SteerInput,
) -> Result<SteerMessage, String> {
    let message = record(&*store.lock_conn()?, input, now_millis())?;
    changed(&app, &[&message]);
    Ok(message)
}

#[tauri::command(async)]
pub fn steering_pending(store: State<'_, SessionStore>) -> Result<Vec<SteerMessage>, String> {
    pending(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn steering_list(
    store: State<'_, SessionStore>,
    child_session: Option<String>,
    owner_session: Option<String>,
) -> Result<Vec<SteerMessage>, String> {
    list(
        &*store.lock_conn()?,
        child_session.as_deref(),
        owner_session.as_deref(),
    )
}

#[tauri::command(async)]
pub fn steering_settle(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    outcome: Outcome,
) -> Result<Change, String> {
    let change = settle(&*store.lock_conn()?, &id, outcome, now_millis())?;
    if let Some(message) = change.message.as_ref().filter(|_| change.applied) {
        changed(&app, &[message]);
    }
    Ok(change)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    fn input(request: &str, text: &str) -> SteerInput {
        SteerInput {
            owner_session: "fm".into(),
            child_session: "worker".into(),
            delegation_id: Some("t-1".into()),
            request_id: request.into(),
            text: text.into(),
            mode: None,
            source: None,
            decision_key: None,
        }
    }

    #[test]
    fn a_message_is_stored_once_per_request() {
        let conn = conn();
        let a = record(&conn, input("r1", "Use the v2 API."), 1).unwrap();
        assert_eq!(a.state, PENDING);
        let again = record(&conn, input("r1", " Use the v2 API. "), 2).unwrap();
        assert_eq!(again.id, a.id);
        assert!(record(&conn, input("r1", "Something else"), 3)
            .unwrap_err()
            .contains("already used"));
        assert_eq!(pending(&conn).unwrap().len(), 1);
    }

    #[test]
    fn caps_refuse_instead_of_cutting() {
        let conn = conn();
        let long = "x".repeat(TEXT_MAX + 1);
        let err = record(&conn, input("r1", &long), 1).unwrap_err();
        assert!(err.contains("at most 8000"), "{err}");
        assert!(record(&conn, input("r2", "   "), 1).is_err());
        for i in 0..PENDING_MAX {
            record(&conn, input(&format!("r-{i}"), "go"), 1).unwrap();
        }
        let err = record(&conn, input("one-more", "go"), 1).unwrap_err();
        assert!(err.contains("takes no more"), "{err}");
        // Nothing was dropped to make room.
        assert_eq!(pending(&conn).unwrap().len(), PENDING_MAX);
    }

    #[test]
    fn a_held_message_stays_pending_until_it_goes_in() {
        let conn = conn();
        let m = record(&conn, input("r1", "Also cover the empty list."), 1).unwrap();
        let held = settle(&conn, &m.id, Outcome::Held, 2).unwrap();
        assert!(held.applied);
        let held = held.message.unwrap();
        assert_eq!((held.state.as_str(), held.held_at), (PENDING, Some(2)));
        // Held again: nothing new.
        assert!(!settle(&conn, &m.id, Outcome::Held, 3).unwrap().applied);
        // The worker went idle: it goes in as its next turn.
        let done = settle(
            &conn,
            &m.id,
            Outcome::Delivered {
                delivery: STARTED.into(),
            },
            4,
        )
        .unwrap()
        .message
        .unwrap();
        assert_eq!(done.state, DELIVERED);
        assert_eq!(done.delivery.as_deref(), Some(STARTED));
        assert!(pending(&conn).unwrap().is_empty());
        // A late report changes nothing.
        assert!(
            !settle(
                &conn,
                &m.id,
                Outcome::Failed {
                    error: "late".into(),
                    fatal: false
                },
                5
            )
            .unwrap()
            .applied
        );
    }

    #[test]
    fn failures_retry_then_fail_for_good() {
        let conn = conn();
        let m = record(&conn, input("r1", "go"), 1).unwrap();
        for attempt in 1..MAX_ATTEMPTS {
            let now = settle(
                &conn,
                &m.id,
                Outcome::Failed {
                    error: "not loaded".into(),
                    fatal: false,
                },
                attempt,
            )
            .unwrap()
            .message
            .unwrap();
            assert_eq!(now.state, PENDING);
            assert_eq!(now.attempts, attempt);
        }
        let last = settle(
            &conn,
            &m.id,
            Outcome::Failed {
                error: "not loaded".into(),
                fatal: false,
            },
            9,
        )
        .unwrap()
        .message
        .unwrap();
        assert_eq!(last.state, FAILED);
        assert_eq!(last.error.as_deref(), Some("not loaded"));

        let gone = record(&conn, input("r2", "go"), 1).unwrap();
        let gone = settle(
            &conn,
            &gone.id,
            Outcome::Failed {
                error: "The worker's chat is gone".into(),
                fatal: true,
            },
            2,
        )
        .unwrap()
        .message
        .unwrap();
        assert_eq!(gone.state, FAILED);
    }

    #[test]
    fn steering_survives_a_restart() {
        let dir =
            std::env::temp_dir().join(format!("hivra-steer-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("monocode.db");
        let id = {
            let conn = Connection::open(&path).unwrap();
            ensure_tables(&conn).unwrap();
            let m = record(&conn, input("r1", "Rebase on main first."), 1).unwrap();
            settle(&conn, &m.id, Outcome::Held, 2).unwrap();
            m.id
        };
        // The app quit with the message held; the next start finds it and replays it.
        let conn = Connection::open(&path).unwrap();
        ensure_tables(&conn).unwrap();
        let waiting = pending(&conn).unwrap();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].id, id);
        assert_eq!(waiting[0].held_at, Some(2));
        assert_eq!(waiting[0].text, "Rebase on main first.");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_by_worker_or_sender() {
        let conn = conn();
        record(&conn, input("r1", "a"), 1).unwrap();
        let mut other = input("r2", "b");
        other.child_session = "worker-2".into();
        record(&conn, other, 2).unwrap();
        assert_eq!(list(&conn, Some("worker"), None).unwrap().len(), 1);
        assert_eq!(list(&conn, None, Some("fm")).unwrap().len(), 2);
        assert!(list(&conn, None, None).is_err());
    }
}
