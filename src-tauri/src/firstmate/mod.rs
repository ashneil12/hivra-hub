//! Hivra WP-10: the first mate contract (docs/hivra/SPEC.md section 4, docs/hivra/work/WP-10-first-mate-contract.md).
//!
//! What code enforces of "a first mate reads, plans, briefs, supervises and reports":
//! - `status`: the five statuses, computed from the delegation row and its gates and nothing else.
//! - `report`: the worker's typed final report; its opinion of its own work is kept and never counts as evidence.
//! - `checkout_guard`: after each first-mate turn, a change to the project's main checkout that no landing explains is
//!   flagged and offered for revert.
//! - `gates` (WP-40): the completion gates and the verdict check a worker's "done" has to pass.
//! - `fact_gaps` (WP-145): session facts that fail a worker's done claim.
//! - `done_check` (WP-249): the report's claims checked against the diff in code, before the verdict model.
//! - the depth cap (`check_depth`): a delegation is never deeper than two (first mate, first mate, workers).
//! - WP-14's fan-out cap (`check_fanout`): one first mate runs at most `MAX_FANOUT` tasks at once.
//! - WP-171's `mcp`: delegate_tasks, the multi-part form of delegate_task. Its contract (what each task owns, provides,
//!   requires and checks), the waves and the checks of what a provider made are in the webview, with the briefs.
//!
//! The brief scaffold and the per-CLI read-only launch live in the webview (src/features/firstmate/), where briefs are
//! written and sessions launched. The role rules are src/features/firstmate/contract.md.

pub mod brief_checks; // SC-4: a brief's runnable check lines, its commit stamp and its do-not-touch list
pub mod checker; // SC-5: the running checker (re-runs the brief's checks in a read-only copy, on another model family)
pub mod checker_copy; // SC-5: the read-only copy of a worker's checkout
pub mod checker_family; // SC-5: which CLI and model checks, by the app's family rule
pub mod checkout_guard;
pub mod dismissals; // SC-5: a worker's dismissal of a finding, on one of five grounds
pub mod done_check;
pub mod fact_gaps;
pub mod gates;
pub mod mcp;
pub mod open_work; // SC-7: what is still open under a first mate, for the hold on its "done"
mod proof_gate; // PT-1: the "Proof tools" gate: the open-source tools a project already has, run on a task's change
pub mod protected_paths;
pub mod report;
pub mod rounds; // SC-5: the round cap, the rethink after two failed rounds, and the person's decision after that
pub mod status;
pub mod testing_mode; // SC-3a: the gates a finished task gets, by the project's testing mode

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, State};

use crate::delegations::{self, Change};
use crate::session_store::{now_millis, SessionStore};

/// First mate, first mate, workers: a delegation sits at most two below the chat the person talks to.
pub const MAX_DEPTH: usize = 2;

/// Refuses a delegation from `owner` that would sit deeper than `MAX_DEPTH`, in words the model can act on.
pub fn check_depth(conn: &Connection, owner: &str) -> Result<usize, String> {
    let depth = delegations::depth_above(conn, owner)? + 1;
    if depth > MAX_DEPTH {
        return Err(format!(
            "This task would sit {depth} levels deep; work stops at {MAX_DEPTH} (a first mate, at most one first mate \
             under it, then workers). You are a worker here: do the work yourself, or tell your first mate what more is \
             needed in your report."
        ));
    }
    Ok(depth)
}

/// Hivra WP-14: a first mate runs at most this many of its own tasks at once (a plan is 3 to 8 tasks plus synthesis).
pub const MAX_FANOUT: usize = 8;

/// Refuses an `owner`'s next task when it already has `MAX_FANOUT` open, in words the model can act on. Nothing is
/// dropped or queued silently: the caller hears why and what to do.
pub fn check_fanout(conn: &Connection, owner: &str) -> Result<usize, String> {
    let open: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM delegations WHERE owner_session = ?1 AND follow IS NULL \
             AND state IN ('running', 'question')",
            [owner],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let open = open as usize;
    if open >= MAX_FANOUT {
        return Err(format!(
            "Not started: you already have {open} tasks running, the most one first mate runs at once ({MAX_FANOUT}). \
             End your turn and let one report, stop one with task_cancel, or add this to a running task with \
             task_message."
        ));
    }
    Ok(open)
}

/// Depth, and the fan-out cap when a task would actually start. A pick starts nothing, so it skips the cap.
pub fn depth_and_fanout(conn: &Connection, owner: &str, fanout: bool) -> Result<usize, String> {
    let depth = check_depth(conn, owner)?;
    if fanout {
        check_fanout(conn, owner)?;
    }
    Ok(depth)
}

#[tauri::command(async)]
pub fn firstmate_check_depth(
    store: State<'_, SessionStore>,
    owner_session: String,
    fanout: Option<bool>,
) -> Result<usize, String> {
    let conn = store.lock_conn()?;
    depth_and_fanout(&conn, &owner_session, fanout.unwrap_or(true))
}

#[tauri::command(async)]
pub fn firstmate_set_question_owner(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    generation: i64,
    owner: String,
    by: Option<String>,
) -> Result<Change, String> {
    let change = delegations::set_question_owner(
        &mut *store.lock_conn()?,
        &id,
        generation,
        &owner,
        by,
        now_millis(),
    )?;
    if let Some(row) = change.row.as_ref().filter(|_| change.applied) {
        let _ = app.emit(delegations::CHANGED, serde_json::json!({ "ids": [row.id] }));
        crate::tasks::emit_for_delegations(&app); // WP-70
    }
    Ok(change)
}

#[tauri::command]
pub fn firstmate_parse_report(text: String) -> report::WorkerReport {
    report::parse(&text)
}

#[tauri::command]
pub async fn firstmate_checkout_snapshot(cwd: String) -> Result<checkout_guard::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkout_guard::snapshot(std::path::Path::new(&cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn firstmate_checkout_check(
    before: checkout_guard::Snapshot,
) -> Result<Option<checkout_guard::Flag>, String> {
    tauri::async_runtime::spawn_blocking(move || checkout_guard::check(&before))
        .await
        .map_err(|e| e.to_string())?
}

/// Only on the person's tap (WP-15 shows the flag): put back the paths they chose.
#[tauri::command]
pub async fn firstmate_checkout_revert(
    before: checkout_guard::Snapshot,
    flag: checkout_guard::Flag,
    paths: Vec<String>,
) -> Result<checkout_guard::RevertOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || checkout_guard::revert(&before, &flag, &paths))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod fact_gaps_red_tests; // SC-7: the "no red before the fix" gap

#[cfg(test)]
mod tests;
