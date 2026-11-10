//! WP-162: bring main into a package branch, and hold the programme lead lease.
//!
//! The update runs only in the package worktree. It fetches main and merges
//! (the default) or rebases, then pushes with a normal push. It refuses a dirty
//! tree, the wrong branch, and anything that would edit main. A timeout or a
//! remote that cannot be reached is not a final failure.

mod checkout;
mod gitrun;
mod names;
mod settings;
mod update;

use rusqlite::Connection;
use serde::Deserialize;
use tauri::State;

use crate::session_store::{now_millis, SessionStore};

pub use checkout::Checkout;
pub use settings::{Strategy, UpdateSettings};
pub use update::{update_from_main, UpdateReport};

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS programme_update_settings (
           project TEXT PRIMARY KEY,
           update_conflicting INTEGER NOT NULL DEFAULT 0,
           strategy TEXT NOT NULL DEFAULT 'merge',
           version INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS programme_checkouts (
           package_id TEXT PRIMARY KEY,
           project TEXT NOT NULL,
           worktree TEXT NOT NULL,
           branch TEXT NOT NULL,
           base_branch TEXT NOT NULL,
           remote_name TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )
}

#[tauri::command]
pub fn programme_update_settings_get(
    store: State<'_, SessionStore>,
    project: String,
) -> Result<UpdateSettings, String> {
    settings::get(&*store.lock_conn()?, &project)
}

#[tauri::command]
pub fn programme_update_settings_set(
    store: State<'_, SessionStore>,
    project: String,
    update_conflicting: bool,
    strategy: String,
    expected_version: i64,
) -> Result<UpdateSettings, String> {
    let strategy = Strategy::parse(&strategy).ok_or_else(|| "Use merge or rebase.".to_string())?;
    settings::set(
        &*store.lock_conn()?,
        &project,
        update_conflicting,
        strategy,
        expected_version,
        now_millis(),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindRequest {
    pub package_id: String,
    pub project: String,
    pub worktree: String,
    pub branch: String,
    pub base: Option<String>,
    pub remote: Option<String>,
    pub expected_updated_at: Option<i64>,
}

#[tauri::command]
pub fn programme_bind_checkout(
    store: State<'_, SessionStore>,
    request: BindRequest,
) -> Result<Checkout, String> {
    checkout::bind(
        &*store.lock_conn()?,
        checkout::Bind {
            package_id: &request.package_id,
            project: &request.project,
            worktree: std::path::Path::new(&request.worktree),
            branch: &request.branch,
            base: request.base.as_deref().unwrap_or("main"),
            remote: request.remote.as_deref().unwrap_or("origin"),
            expected_updated_at: request.expected_updated_at,
            now: now_millis(),
        },
    )
}

/// `programme.update_from_main`. The git work runs off the UI thread, and the
/// database lock is not held while it runs.
#[tauri::command]
pub async fn programme_update_from_main(
    store: State<'_, SessionStore>,
    package_id: String,
) -> Result<UpdateReport, String> {
    let plan = {
        let conn = store.lock_conn()?;
        update::load(&conn, &package_id)?
    };
    let Some(plan) = plan else {
        return Ok(UpdateReport::refused(
            package_id.trim(),
            "That package has no worktree recorded.",
        ));
    };
    tauri::async_runtime::spawn_blocking(move || update::execute(&plan))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod update_tests;
