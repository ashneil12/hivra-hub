//! The first mate's durable wake queue (Hivra WP-11; firstmate's `fm-wake-lib.sh` and `fm-wake-drain.sh`, MIT,
//! Copyright (c) 2026 Kun Chen, re-told on the Hub's delivery ladder).
//!
//! A wake is one thing a first mate must judge that is not a worker's report: a stall notice, a worker saying it can't
//! finish, a timer the first mate set. Reports keep their own road (delegations.rs); this queue moves the same way:
//! `pending` → `queued` (it waits in the owner's queue under one message) → `delivered` → `acknowledged`, or
//! `disposed` (the owner is gone, or Ash removed it from the queue). A repeated or backwards move changes nothing.
//!
//! - **One wake per thing**: `(owner, key)` is unique, so the watcher can say the same thing on every look, before and
//!   after a restart, and the first mate hears it once.
//! - **Drain**: every wake still owed to an owner goes out as one turn. `seq` grows per owner; the drained message
//!   carries the highest one (`through`), and when that turn starts the owner acknowledges everything up to it. A wake
//!   that arrives meanwhile has a higher `seq` and waits for the next drain.
//! - **Restart**: rows are the truth. A queued wake whose message never reached the owner's transcript or queue is
//!   queued again under the same message; one that did is acknowledged.
//!
//! Plain code only: nothing here calls a model or starts a CLI.

use rusqlite::{params, Connection, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::delegations::{delivery_step, ACKNOWLEDGED, DELIVERED, DISPOSED, PENDING, QUEUED};

/// Every drained turn starts with this, so nothing mistakes it for Ash's words (the studio's sweep skips `[MonoCode `).
pub const PREFIX: &str = "[MonoCode watcher]";
/// A drained turn's message id (and receipt): `fm-wake-<owner>-<through>`.
pub const MESSAGE_PREFIX: &str = "fm-wake-";

/// What a wake is about. Reports, questions and PR events keep their own roads; these are the rest.
pub const KINDS: [&str; 4] = ["stall", "blocked", "timer", "note"];

const TEXT_MAX: usize = 2_000;
const TITLE_MAX: usize = 300;
const KEY_MAX: usize = 300;
/// A drained turn lists at most this many wakes; the rest wait for the next one.
pub const DRAIN_MAX: usize = 20;
/// Settled wakes are kept this long, then deleted.
pub const KEEP_SETTLED: i64 = 30 * 24 * 60 * 60_000;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Wake {
    pub id: String,
    pub owner_session: String,
    pub seq: i64,
    pub kind: String,
    pub key: String,
    pub delegation_id: Option<String>,
    pub generation: Option<i64>,
    pub title: Option<String>,
    pub text: String,
    pub delivery: String,
    pub delivery_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS firstmate_wakes (
           id TEXT PRIMARY KEY,
           owner_session TEXT NOT NULL,
           seq INTEGER NOT NULL,
           kind TEXT NOT NULL,
           key TEXT NOT NULL,
           delegation_id TEXT,
           generation INTEGER,
           title TEXT,
           text TEXT NOT NULL,
           delivery TEXT NOT NULL,
           delivery_message TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           UNIQUE (owner_session, key)
         );
         CREATE INDEX IF NOT EXISTS firstmate_wakes_open ON firstmate_wakes(delivery, owner_session, seq);
         CREATE INDEX IF NOT EXISTS firstmate_wakes_message ON firstmate_wakes(delivery_message)
           WHERE delivery_message IS NOT NULL;",
    )
}

const COLUMNS: &str =
    "id, owner_session, seq, kind, key, delegation_id, generation, title, text, delivery, \
                       delivery_message, created_at, updated_at";

fn from_row(row: &Row) -> rusqlite::Result<Wake> {
    Ok(Wake {
        id: row.get(0)?,
        owner_session: row.get(1)?,
        seq: row.get(2)?,
        kind: row.get(3)?,
        key: row.get(4)?,
        delegation_id: row.get(5)?,
        generation: row.get(6)?,
        title: row.get(7)?,
        text: row.get(8)?,
        delivery: row.get(9)?,
        delivery_message: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn query(
    conn: &Connection,
    clause: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Wake>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM firstmate_wakes {clause}"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(args, from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string());
    rows
}

/// A chat id as the queue keeps it: letters, digits, dash, underscore, dot, colon.
pub(crate) fn session_ok(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

fn cap(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

/// The message a drain of `owner` through `seq` goes out under.
pub fn message_id(owner: &str, through: i64) -> String {
    format!("{MESSAGE_PREFIX}{owner}-{through}")
}

/// The owner and `through` a drained message names, if it is one.
pub fn parse_message_id(id: &str) -> Option<(String, i64)> {
    let rest = id.strip_prefix(MESSAGE_PREFIX)?;
    let (owner, through) = rest.rsplit_once('-')?;
    let through = through.parse::<i64>().ok().filter(|n| *n > 0)?;
    session_ok(owner).then(|| (owner.to_string(), through))
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeInput {
    pub owner_session: String,
    pub kind: String,
    /// One wake per owner and key, ever (`stall:<row>:<generation>:<since>`, `timer:<id>`).
    pub key: String,
    #[serde(default)]
    pub delegation_id: Option<String>,
    #[serde(default)]
    pub generation: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
    /// The line the first mate reads, in plain words.
    pub text: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub wake: Wake,
    /// False when this owner already had a wake under this key (nothing changed).
    pub fresh: bool,
}

/// Store a wake once. The same key again returns the stored one unchanged.
pub fn add(conn: &mut Connection, input: WakeInput, now: i64) -> Result<Added, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let added = add_in(&tx, input, now)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

/// `add` inside a transaction the caller holds (a timer fires and wakes in one step).
pub(crate) fn add_in(conn: &Connection, input: WakeInput, now: i64) -> Result<Added, String> {
    let owner = input.owner_session.trim().to_string();
    if !session_ok(&owner) {
        return Err("a wake names the chat it wakes".into());
    }
    let kind = input.kind.trim();
    if !KINDS.contains(&kind) {
        return Err(format!("a wake is one of {}", KINDS.join(", ")));
    }
    let key = cap(&input.key, KEY_MAX);
    if key.is_empty() {
        return Err("a wake has a key, so it is said once".into());
    }
    let text = cap(&input.text, TEXT_MAX);
    if text.is_empty() {
        return Err("a wake says something".into());
    }
    if let Some(existing) = query(
        conn,
        "WHERE owner_session = ?1 AND key = ?2",
        &[&owner, &key],
    )?
    .into_iter()
    .next()
    {
        return Ok(Added {
            wake: existing,
            fresh: false,
        });
    }
    let seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM firstmate_wakes WHERE owner_session = ?1",
            params![owner],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let wake = Wake {
        id: format!("wake-{}", uuid::Uuid::new_v4().simple()),
        owner_session: owner,
        seq,
        kind: kind.into(),
        key,
        delegation_id: input
            .delegation_id
            .map(|id| cap(&id, 200))
            .filter(|id| !id.is_empty()),
        generation: input.generation,
        title: input
            .title
            .map(|title| cap(&title, TITLE_MAX))
            .filter(|title| !title.is_empty()),
        text,
        delivery: PENDING.into(),
        delivery_message: None,
        created_at: now,
        updated_at: now,
    };
    conn.execute(
        "INSERT INTO firstmate_wakes (id, owner_session, seq, kind, key, delegation_id, generation, title, text,
                                      delivery, delivery_message, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            wake.id,
            wake.owner_session,
            wake.seq,
            wake.kind,
            wake.key,
            wake.delegation_id,
            wake.generation,
            wake.title,
            wake.text,
            wake.delivery,
            wake.delivery_message,
            wake.created_at,
            wake.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(Added { wake, fresh: true })
}

/// Every wake still owed (pending or queued), oldest first per owner.
pub fn open(conn: &Connection) -> Result<Vec<Wake>, String> {
    query(
        conn,
        "WHERE delivery IN ('pending', 'queued') ORDER BY owner_session, seq",
        &[],
    )
}

/// An owner's wakes, newest first (the first mate's own look, and the tests).
pub fn of_owner(conn: &Connection, owner: &str, limit: usize) -> Result<Vec<Wake>, String> {
    let limit = limit.clamp(1, 200) as i64;
    query(
        conn,
        "WHERE owner_session = ?1 ORDER BY seq DESC LIMIT ?2",
        &[&owner, &limit],
    )
}

/// One drained turn: the wakes it carries, the message it goes out under, and how far it acknowledges.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Drained {
    pub owner_session: String,
    pub message_id: String,
    pub through: i64,
    pub text: String,
    pub wakes: Vec<Wake>,
}

/// The turn's words: one line per wake, oldest first, and that it is the app talking.
pub fn drained_text(wakes: &[Wake]) -> String {
    let mut text = String::from(PREFIX);
    if wakes.len() == 1 {
        text.push_str(" One thing needs your judgment (this is the app, not Ash):\n");
    } else {
        text.push_str(&format!(
            " {} things need your judgment (this is the app, not Ash):\n",
            wakes.len()
        ));
    }
    for wake in wakes {
        text.push_str("- ");
        text.push_str(&wake.text);
        text.push('\n');
    }
    text.push_str(
        "Decide what each needs (task_status shows a worker's record), act, and tell Ash only what he must decide or \
         know. Nothing here needs an answer to the app.",
    );
    text
}

/// Take what an owner is owed into one turn: every pending wake, and any queued one, up to `DRAIN_MAX`, marked queued
/// under the drained message. A stall or blocked notice whose worker moved on first is disposed instead. Draining again before delivery returns the same turn; nothing owed returns none.
pub fn drain(conn: &mut Connection, owner: &str, now: i64) -> Result<Option<Drained>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    // A notice about a worker that has since moved on (settled, stopped, or retried under a new generation) is no longer
    // a judgment to make: it is dropped, not delivered late.
    tx.execute(
        "UPDATE firstmate_wakes SET delivery = 'disposed', updated_at = ?2
          WHERE owner_session = ?1 AND delivery IN ('pending', 'queued') AND kind IN ('stall', 'blocked')
            AND delegation_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM delegations d
                             WHERE d.id = firstmate_wakes.delegation_id
                               AND d.state IN ('running', 'question')
                               AND d.generation = COALESCE(firstmate_wakes.generation, d.generation))",
        params![owner, now],
    )
    .map_err(|e| e.to_string())?;
    let limit = DRAIN_MAX as i64;
    let owed = query(
        &tx,
        "WHERE owner_session = ?1 AND delivery IN ('pending', 'queued') ORDER BY seq LIMIT ?2",
        &[&owner, &limit],
    )?;
    let Some(last) = owed.last() else {
        return Ok(None);
    };
    let through = last.seq;
    let message = message_id(owner, through);
    let mut wakes = Vec::with_capacity(owed.len());
    for mut wake in owed {
        let requeue = wake.delivery_message.as_deref() != Some(message.as_str());
        if delivery_step(&wake.delivery, QUEUED, true, requeue)
            || (wake.delivery == PENDING && requeue)
        {
            wake.delivery = QUEUED.into();
            wake.delivery_message = Some(message.clone());
            wake.updated_at = now;
            tx.execute(
                "UPDATE firstmate_wakes SET delivery = ?2, delivery_message = ?3, updated_at = ?4 WHERE id = ?1",
                params![wake.id, wake.delivery, wake.delivery_message, now],
            )
            .map_err(|e| e.to_string())?;
        }
        wakes.push(wake);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(Drained {
        owner_session: owner.to_string(),
        text: drained_text(&wakes),
        message_id: message,
        through,
        wakes,
    }))
}

/// The drained turn went to its owner: everything it carried, and anything older still marked, moves to
/// `acknowledged` (through the `seq` the turn saw). Later wakes are untouched. Returns what moved.
pub fn ack(
    conn: &mut Connection,
    owner: &str,
    through: i64,
    now: i64,
) -> Result<Vec<Wake>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let rows = query(
        &tx,
        "WHERE owner_session = ?1 AND seq <= ?2 AND delivery IN ('queued', 'delivered') ORDER BY seq",
        &[&owner, &through],
    )?;
    let mut moved = Vec::new();
    for mut wake in rows {
        if !delivery_step(&wake.delivery, ACKNOWLEDGED, true, false) {
            continue;
        }
        wake.delivery = ACKNOWLEDGED.into();
        wake.updated_at = now;
        tx.execute(
            "UPDATE firstmate_wakes SET delivery = ?2, updated_at = ?3 WHERE id = ?1",
            params![wake.id, wake.delivery, now],
        )
        .map_err(|e| e.to_string())?;
        moved.push(wake);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(moved)
}

/// Move every wake a drained message carries (`delivered`, or `disposed` when Ash removed it from the queue or the
/// owner is gone). Forward only.
pub fn set_delivery(
    conn: &mut Connection,
    message_id: &str,
    delivery: &str,
    now: i64,
) -> Result<Vec<Wake>, String> {
    if ![DELIVERED, ACKNOWLEDGED, DISPOSED].contains(&delivery) {
        return Err("a drained wake moves to delivered, acknowledged or disposed".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let rows = query(&tx, "WHERE delivery_message = ?1", &[&message_id])?;
    let mut moved = Vec::new();
    for mut wake in rows {
        if !delivery_step(&wake.delivery, delivery, true, false) {
            continue;
        }
        wake.delivery = delivery.into();
        wake.updated_at = now;
        tx.execute(
            "UPDATE firstmate_wakes SET delivery = ?2, updated_at = ?3 WHERE id = ?1",
            params![wake.id, wake.delivery, now],
        )
        .map_err(|e| e.to_string())?;
        moved.push(wake);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(moved)
}

/// The owner is gone: nothing it was owed will be read.
pub fn dispose_owner(conn: &mut Connection, owner: &str, now: i64) -> Result<usize, String> {
    conn.execute(
        "UPDATE firstmate_wakes SET delivery = 'disposed', updated_at = ?2
          WHERE owner_session = ?1 AND delivery IN ('pending', 'queued', 'delivered')",
        params![owner, now],
    )
    .map_err(|e| e.to_string())
}

/// Delete settled wakes `KEEP_SETTLED` on.
pub fn prune(conn: &Connection, now: i64) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM firstmate_wakes WHERE delivery IN ('acknowledged', 'disposed') AND updated_at < ?1",
        params![now - KEEP_SETTLED],
    )
    .map_err(|e| e.to_string())
}

/// The drained turn `message_id` went to its owner: acknowledge everything up to the `seq` it carried.
pub fn delivered(conn: &mut Connection, message_id: &str, now: i64) -> Result<Vec<Wake>, String> {
    let Some((owner, through)) = parse_message_id(message_id) else {
        return Ok(Vec::new());
    };
    ack(conn, &owner, through, now)
}
