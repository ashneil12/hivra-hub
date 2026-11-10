//! Hivra WP-11: the watcher's durable side (docs/hivra/SPEC.md section 4 step 5, docs/hivra/work/WP-11-watcher.md).
//!
//! The classifier itself is headless TypeScript (src/features/firstmate/watcher/classifier.ts): it reads the records,
//! the workers' looks, PR events and timers, and decides whether a first mate needs to judge something. What has to
//! survive a restart lives here, in the app's own database:
//! - `queue`: the first mate's wake queue, on the delegation delivery ladder (pending, queued, delivered,
//!   acknowledged, disposed), one wake per owner and key, drained into one turn and acknowledged through the `seq` that
//!   turn saw.
//! - `timers`: timers a first mate sets ("wake me in an hour to look at the deploy"); a due timer becomes a wake in the
//!   same transaction.
//! - `checks` (WP-104): a command the safe table already allows, polled until it exits 0 or its text matches, then one
//!   wake. The poll runs from `watcher_tick`, not from `tick`, so a look never holds the database while a process runs.
//!
//! Nothing here calls a model or spends a token. Own tables, made by `ensure_tables` (no numbered
//! migration, so upstream's migration numbers can't collide).

pub mod checks;
pub mod queue;
mod safe_cmd;
pub mod timers;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::session_store::{now_millis, SessionStore};

/// Tauri event: a wake was stored (`{owners}`), so the main window delivers it.
pub const WAKE: &str = "monocode:firstmate-wake";

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    queue::ensure_tables(conn)?;
    timers::ensure_tables(conn)?;
    checks::ensure_tables(conn)
}

fn woke(app: &AppHandle, wakes: &[queue::Wake]) {
    if wakes.is_empty() {
        return;
    }
    let mut owners: Vec<&str> = wakes.iter().map(|w| w.owner_session.as_str()).collect();
    owners.sort_unstable();
    owners.dedup();
    let _ = app.emit(WAKE, serde_json::json!({ "owners": owners }));
}

#[tauri::command(async)]
pub fn watcher_wake_add(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: queue::WakeInput,
) -> Result<queue::Added, String> {
    let added = queue::add(&mut *store.lock_conn()?, input, now_millis())?;
    if added.fresh {
        woke(&app, std::slice::from_ref(&added.wake));
    }
    Ok(added)
}

#[tauri::command(async)]
pub fn watcher_wakes_open(store: State<'_, SessionStore>) -> Result<Vec<queue::Wake>, String> {
    queue::open(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn watcher_wakes_of(
    store: State<'_, SessionStore>,
    owner_session: String,
    limit: Option<usize>,
) -> Result<Vec<queue::Wake>, String> {
    queue::of_owner(&*store.lock_conn()?, &owner_session, limit.unwrap_or(20))
}

#[tauri::command(async)]
pub fn watcher_wake_drain(
    store: State<'_, SessionStore>,
    owner_session: String,
) -> Result<Option<queue::Drained>, String> {
    queue::drain(&mut *store.lock_conn()?, &owner_session, now_millis())
}

#[tauri::command(async)]
pub fn watcher_wake_ack(
    store: State<'_, SessionStore>,
    owner_session: String,
    through: i64,
) -> Result<Vec<queue::Wake>, String> {
    queue::ack(
        &mut *store.lock_conn()?,
        &owner_session,
        through,
        now_millis(),
    )
}

/// The drained turn went to its owner as a turn: acknowledged through what it carried.
#[tauri::command(async)]
pub fn watcher_wake_delivered(
    store: State<'_, SessionStore>,
    message_id: String,
) -> Result<Vec<queue::Wake>, String> {
    queue::delivered(&mut *store.lock_conn()?, &message_id, now_millis())
}

#[tauri::command(async)]
pub fn watcher_wake_delivery(
    store: State<'_, SessionStore>,
    message_id: String,
    delivery: String,
) -> Result<Vec<queue::Wake>, String> {
    queue::set_delivery(
        &mut *store.lock_conn()?,
        &message_id,
        &delivery,
        now_millis(),
    )
}

#[tauri::command(async)]
pub fn watcher_dispose_owner(
    store: State<'_, SessionStore>,
    owner_session: String,
) -> Result<usize, String> {
    queue::dispose_owner(&mut *store.lock_conn()?, &owner_session, now_millis())
}

#[tauri::command(async)]
pub fn watcher_timer_set(
    store: State<'_, SessionStore>,
    input: timers::TimerInput,
) -> Result<timers::Timer, String> {
    timers::set(&mut *store.lock_conn()?, input, now_millis())
}

#[tauri::command(async)]
pub fn watcher_timer_cancel(
    store: State<'_, SessionStore>,
    owner_session: String,
    id: String,
) -> Result<Option<timers::Timer>, String> {
    timers::cancel(&mut *store.lock_conn()?, &owner_session, &id, now_millis())
}

#[tauri::command(async)]
pub fn watcher_timers(
    store: State<'_, SessionStore>,
    owner_session: String,
) -> Result<Vec<timers::Timer>, String> {
    timers::armed(&*store.lock_conn()?, &owner_session)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tick {
    /// Wakes the due timers became.
    pub fired: Vec<queue::Wake>,
    pub pruned: usize,
}

/// The watcher's look, also run once at start: due timers fire into the queue, and old settled rows go.
/// Checks are not run here. This stays database-only; `watcher_tick` runs a due check after it drops the lock.
pub fn tick(conn: &mut Connection, now: i64) -> Result<Tick, String> {
    let fired = timers::fire_due(conn, now)?;
    let pruned = queue::prune(conn, now)? + timers::prune(conn, now)? + checks::prune(conn, now)?;
    Ok(Tick { fired, pruned })
}

#[tauri::command(async)]
pub fn watcher_tick(app: AppHandle, store: State<'_, SessionStore>) -> Result<Tick, String> {
    let now = now_millis();
    // Claim under the lock, then drop it before any process starts.
    let (mut done, due) = {
        let mut conn = store.lock_conn()?;
        let done = tick(&mut conn, now)?;
        let due = checks::claim_due(&mut conn, now)?;
        (done, due)
    };
    let attempts: Vec<_> = due
        .iter()
        .map(|item| checks::look(item, &checks::LiveRunner))
        .collect();
    if !due.is_empty() {
        let mut conn = store.lock_conn()?;
        for (item, attempt) in due.into_iter().zip(attempts) {
            if let Some(wake) = checks::settle(&mut conn, &item, attempt, now)? {
                done.fired.push(wake);
            }
        }
    }
    woke(&app, &done.fired);
    Ok(done)
}

#[tauri::command(async)]
pub fn watcher_check_set(
    store: State<'_, SessionStore>,
    input: checks::CheckInput,
) -> Result<checks::Check, String> {
    // Judged before the lock: a refused command never holds the store, and nothing here can poison it (round 4, item 9).
    checks::vet_command(input.command.trim())?;
    checks::set(&mut *store.lock_conn()?, input, now_millis())
}

#[tauri::command(async)]
pub fn watcher_check_cancel(
    store: State<'_, SessionStore>,
    owner_session: String,
    id: String,
) -> Result<Option<checks::Check>, String> {
    checks::cancel(&mut *store.lock_conn()?, &owner_session, &id, now_millis())
}

#[cfg(test)]
mod tests;
