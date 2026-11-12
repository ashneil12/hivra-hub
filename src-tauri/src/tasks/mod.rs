//! WP-70: a task is the one thing the person and their agents share.

pub(crate) mod commands;
mod mapping;
pub(crate) mod mcp;
pub(crate) mod pickup;
pub(crate) mod store;
pub(crate) mod sync;
mod views;

pub(crate) use store::ensure_tables;
// WP-79: the outside door reads and writes tasks through the store.
pub(crate) use store::{create, get, list, update, Actor, CreateInput, Task, UpdateInput};

use tauri::{AppHandle, Emitter, Manager};

/// Task ids a delegation write left in the outbox. The command has already dropped the store lock.
pub fn emit_for_delegations(app: &AppHandle) {
    let Some(store) = app.try_state::<crate::session_store::SessionStore>() else {
        return;
    };
    let Ok(mut conn) = store.lock_conn() else {
        return;
    };
    let Ok(ids) = store::drain_emits(&mut conn) else {
        return;
    };
    drop(conn);
    if ids.is_empty() {
        return;
    }
    let _ = app.emit(store::CHANGED, serde_json::json!({ "ids": ids }));
}
