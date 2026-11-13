//! SC-19 (never lose an ask, gap D1): a chat that owns open work is retired (reset, archived or deleted), so the work
//! moves to the chat that takes its place and the reports it owes still arrive.
//!
//! Before this, `ownerSession` kept naming the old chat. The report of a worker that finished afterwards was queued to
//! a chat that no longer existed (dropped silently), a worker waiting for a free worker was dropped as "owner gone", and
//! boot recovery cancelled the rest. The ask stayed `started` with nobody to tell.
//!
//! - **What moves**: the rows the old chat owns that are still open (`running`, `question`) or whose report is still
//!   owed (`delivery` `pending` or `queued`), and its jobs waiting for a free worker (`worker_queue`), in ONE immediate
//!   transaction. Finished rows whose report was delivered, read or discarded stay where they ran: that is history.
//! - **Compare-and-swap**: every row moves only while its `owner_session` still is `from`, so two windows (or a retry)
//!   moving the same chat never move a row twice, and a row someone else already moved is left alone.
//! - **Nothing else changes**: state, delivery, generation, stall and the report's message id are untouched. A report
//!   that was `queued` into the old chat's queue stays `queued` under the same message id; the app queues that same
//!   message into the new chat and its receipt dedupes it, so it arrives once. Nothing is cancelled or restarted.
//! - Each row's log says where it came from: "Moved from <old chat title> after a reset".

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use super::{cap, mono_id_ok, query, session_id, text, Delegation};
use crate::session_store::{now_millis, SessionStore};

/// The longest chat title the log line carries.
const TITLE_MAX: usize = 80;

/// How the old chat was retired, for the words in the log line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Retired {
    Reset,
    Archived,
    Deleted,
}

impl Retired {
    fn of(why: Option<&str>) -> Self {
        match why.map(str::trim) {
            Some("archive") => Self::Archived,
            Some("delete") => Self::Deleted,
            _ => Self::Reset,
        }
    }

    fn after(self) -> &'static str {
        match self {
            Self::Reset => "after a reset",
            Self::Archived => "after it was archived",
            Self::Deleted => "after it was deleted",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReparentInput {
    /// The chat being retired.
    pub from: String,
    /// The chat that takes its work.
    pub to: String,
    /// The Mono the new chat belongs to: the moved rows' `owner_mono` follows it. Left as it was when absent.
    #[serde(default)]
    pub to_mono: Option<String>,
    /// The old chat's title, for the log line.
    #[serde(default)]
    pub from_title: Option<String>,
    /// `reset`, `archive` or `delete`.
    #[serde(default)]
    pub why: Option<String>,
}

/// A job that was waiting for a free worker and now waits for the new chat.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitingMoved {
    pub id: String,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reparented {
    /// The delegation rows that moved, oldest first, as they are now.
    pub rows: Vec<Delegation>,
    /// The waiting jobs that moved with them.
    pub waiting: Vec<WaitingMoved>,
}

/// "Moved from <old chat title> after a reset". The title is the app's chat title, so it is made one plain line first:
/// controls and runs of spaces become one space, and a long one is cut.
fn move_line(title: Option<&str>, how: Retired) -> String {
    let spaced: String = title
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let one_line = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let named = cap(&one_line, TITLE_MAX);
    let named = named.trim_end();
    let from = if named.is_empty() {
        "its old chat"
    } else {
        named
    };
    format!("Moved from {from} {}", how.after())
}

/// Move everything `from` still owes or runs to `to`, in one transaction. A chat with nothing open moves nothing (the
/// caller posts no note), and a chat moved onto itself is nothing to do.
pub fn reparent(
    conn: &mut Connection,
    input: ReparentInput,
    now: i64,
) -> Result<Reparented, String> {
    let from = session_id(&input.from, "old chat")?;
    let to = session_id(&input.to, "new chat")?;
    let to_mono = match text(input.to_mono, 64) {
        Some(mono) if mono_id_ok(&mono) => Some(mono),
        Some(_) => return Err("Invalid Mono id".into()),
        None => None,
    };
    if from == to {
        return Ok(Reparented::default());
    }
    let line = move_line(
        input.from_title.as_deref(),
        Retired::of(input.why.as_deref()),
    );
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let owned = query(
        &tx,
        "WHERE owner_session = ?1
           AND (state IN ('running', 'question') OR delivery IN ('pending', 'queued'))
         ORDER BY created_at, rowid",
        &[&from],
    )?;
    let mut rows = Vec::new();
    for mut row in owned {
        // A chat never reports to itself: work the new chat is doing stays with the owner it had.
        if row.child_session == to {
            continue;
        }
        row.note(
            now,
            "app",
            "moved",
            json!({ "from": from, "to": to, "text": line }),
        );
        row.owner_session = to.clone();
        if let Some(mono) = &to_mono {
            row.owner_mono = Some(mono.clone());
        }
        row.touch(now);
        let swapped = tx
            .execute(
                "UPDATE delegations SET owner_session = ?3, owner_mono = ?4, updated_at = ?5, log = ?6, version = ?7
                 WHERE id = ?1 AND owner_session = ?2",
                params![
                    row.id,
                    from,
                    row.owner_session,
                    row.owner_mono,
                    row.updated_at,
                    serde_json::to_string(&row.log).unwrap_or_else(|_| "[]".into()),
                    row.version,
                ],
            )
            .map_err(|e| e.to_string())?;
        if swapped == 1 {
            rows.push(row);
        }
    }
    let waiting = crate::worker_queue::move_owner(&tx, &from, &to)?
        .into_iter()
        .map(|(id, title)| WaitingMoved { id, title })
        .collect();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Reparented { rows, waiting })
}

#[tauri::command(async)]
pub fn delegations_reparent(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: ReparentInput,
) -> Result<Reparented, String> {
    let moved = reparent(&mut *store.lock_conn()?, input, now_millis())?;
    if !moved.rows.is_empty() {
        let rows: Vec<&Delegation> = moved.rows.iter().collect();
        super::changed(&app, &rows);
    }
    if !moved.waiting.is_empty() {
        let _ = app.emit(crate::worker_queue::CHANGED, json!({}));
    }
    Ok(moved)
}

#[cfg(test)]
#[path = "reparent_tests.rs"]
mod tests;
