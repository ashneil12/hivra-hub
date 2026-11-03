//! Hivra WP-10: the first mate contract (docs/hivra/SPEC.md section 4, docs/hivra/work/WP-10-first-mate-contract.md).
//!
//! What code enforces of "a first mate reads, plans, briefs, supervises and reports":
//! - `status`: the five statuses, computed from the delegation row and its gates and nothing else.
//! - `report`: the worker's typed final report; its opinion of its own work is kept and never counts as evidence.
//! - `checkout_guard`: after each first-mate turn, a change to the project's main checkout that no landing explains is
//!   flagged and offered for revert.
//! - the depth cap (`check_depth`): a delegation is never deeper than two (first mate, first mate, workers).
//!
//! The brief scaffold and the per-CLI read-only launch live in the webview (src/features/firstmate/), where briefs are
//! written and sessions launched. The role rules are src/features/firstmate/contract.md.

pub mod checkout_guard;
pub mod report;
pub mod status;

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

#[tauri::command(async)]
pub fn firstmate_check_depth(
    store: State<'_, SessionStore>,
    owner_session: String,
) -> Result<usize, String> {
    check_depth(&*store.lock_conn()?, &owner_session)
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
    paths: Vec<String>,
) -> Result<checkout_guard::RevertOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || checkout_guard::revert(&before, &paths))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
