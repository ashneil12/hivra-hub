//! WP-83: transcripts Hivra can learn from, and the write that follows an accept.
//!
//! Pi, grok, opencode and Cursor are translated from backpass (MIT).
//! Claude, Codex and Hermes bytes go through the WP-50 reader after a symlink check.

mod apply;
mod cursor;
mod events;
mod gate;
mod grok;
mod md5;
mod opencode;
mod pi;

use std::path::Path;

use serde_json::Value;
use tauri::{AppHandle, Manager};

pub use apply::{profile_load, profile_save, state_cas, state_load, LoadedProfiles, LoadedState};
pub use gate::{Limits, Listing, StandIn, StoreLocate};

#[tauri::command(async)]
pub fn learn_stores_list(
    stand_ins: Option<Vec<StandIn>>,
    include_cursor_ide: Option<bool>,
) -> Result<Listing, String> {
    let home = crate::dirs_home().ok_or_else(|| "This Mac has no home folder.".to_string())?;
    let dev = crate::instance::kind() == crate::instance::Kind::Dev;
    let (env_home, local) = store_locate();
    gate::list_report(
        Path::new(&home),
        stand_ins.as_deref(),
        include_cursor_ide.unwrap_or(false),
        dev,
        Limits::production(),
        &StoreLocate {
            hermes_env: env_home.as_deref(),
            windows: cfg!(windows),
            local_app_data: local.as_deref(),
        },
    )
}

#[tauri::command(async)]
pub fn learn_stores_read(
    source: String,
    root: String,
    rel: String,
    stand_ins: Option<Vec<StandIn>>,
) -> Result<String, String> {
    let home = crate::dirs_home().ok_or_else(|| "This Mac has no home folder.".to_string())?;
    let dev = crate::instance::kind() == crate::instance::Kind::Dev;
    let (env_home, local) = store_locate();
    gate::read_allowed(
        Path::new(&home),
        &source,
        Path::new(&root),
        &rel,
        stand_ins.as_deref(),
        dev,
        Limits::production(),
        &StoreLocate {
            hermes_env: env_home.as_deref(),
            windows: cfg!(windows),
            local_app_data: local.as_deref(),
        },
    )
}

#[tauri::command]
pub fn learn_apply_edit(
    app: AppHandle,
    path: String,
    expected_sha256: String,
    next: String,
    role: String,
) -> Result<bool, String> {
    apply::apply_inside(
        &store_dir(&app)?,
        Path::new(&path),
        &expected_sha256,
        &next,
        &role,
    )
}

#[tauri::command]
pub fn learn_state_load(app: AppHandle) -> Result<LoadedState, String> {
    state_load(&store_dir(&app)?)
}

#[tauri::command]
pub fn learn_state_cas(app: AppHandle, revision: u64, state: Value) -> Result<bool, String> {
    state_cas(&store_dir(&app)?, revision, state)
}

#[tauri::command]
pub fn learn_profile_load(app: AppHandle) -> Result<LoadedProfiles, String> {
    profile_load(&store_dir(&app)?)
}

#[tauri::command]
pub fn learn_profile_save(
    app: AppHandle,
    which: String,
    expected_sha256: String,
    next: String,
) -> Result<bool, String> {
    profile_save(&store_dir(&app)?, &which, &expected_sha256, &next)
}

fn store_locate() -> (Option<String>, Option<String>) {
    (
        std::env::var("HERMES_HOME").ok(),
        std::env::var("LOCALAPPDATA").ok(),
    )
}

fn store_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Couldn't find the app folder.".to_string())?
        .join("learn"))
}

#[cfg(test)]
mod tests;
