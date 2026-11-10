//! The window's calls. The lock is dropped before anything is emitted.

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::session_store::{now_millis, SessionStore};

use super::store::{self, Actor, EnqueueInput, Package};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorBody {
    pub id: String,
    pub project: String,
    pub kind: String,
}

impl From<ActorBody> for Actor {
    fn from(body: ActorBody) -> Self {
        Actor {
            id: body.id,
            project: body.project,
            kind: body.kind,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueBody {
    pub wp: String,
    pub title: String,
    pub brief_path: String,
    pub branch: String,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub security_park: bool,
}

impl From<EnqueueBody> for EnqueueInput {
    fn from(body: EnqueueBody) -> Self {
        EnqueueInput {
            wp: body.wp,
            title: body.title,
            brief_path: body.brief_path,
            branch: body.branch,
            priority: body.priority,
            notes: body.notes,
            security_park: body.security_park,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBody {
    pub id: String,
    pub version: i64,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkBody {
    pub id: String,
    pub version: i64,
    pub reason: String,
    #[serde(default)]
    pub security: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearBody {
    pub id: String,
    pub version: i64,
}

fn emit(app: &AppHandle, id: &str) {
    let _ = app.emit(store::CHANGED, serde_json::json!({ "ids": [id] }));
}

/// A claim and a finish are status moves. Parked is not a status you set here.
fn move_status(
    conn: &mut rusqlite::Connection,
    actor: &Actor,
    input: &StatusBody,
    now: i64,
) -> Result<Package, String> {
    match input.status.as_str() {
        "building" => store::claim(conn, actor, &input.id, input.version, now),
        "pr_open" | "merged" | "failed" => {
            store::finish(conn, actor, &input.id, input.version, &input.status, now)
        }
        _ => store::set_status(conn, actor, &input.id, input.version, &input.status, now),
    }
}

/// Merged rows are left out unless the caller asks for them (`includeMerged`).
#[tauri::command(async)]
pub fn programme_list(
    store: State<'_, SessionStore>,
    actor: ActorBody,
    include_merged: Option<bool>,
) -> Result<Vec<Package>, String> {
    let conn = store.lock_conn()?;
    let actor = Actor::from(actor);
    if include_merged.unwrap_or(false) {
        store::list_with(&conn, &actor, true, store::LIST_MAX)
    } else {
        store::list(&conn, &actor)
    }
}

#[tauri::command(async)]
pub fn programme_enqueue(
    app: AppHandle,
    store: State<'_, SessionStore>,
    actor: ActorBody,
    input: EnqueueBody,
) -> Result<Package, String> {
    let package = {
        let mut conn = store.lock_conn()?;
        store::enqueue(&mut conn, &Actor::from(actor), &input.into(), now_millis())?
    };
    emit(&app, &package.id);
    Ok(package)
}

#[tauri::command(async)]
pub fn programme_set_status(
    app: AppHandle,
    store: State<'_, SessionStore>,
    actor: ActorBody,
    input: StatusBody,
) -> Result<Package, String> {
    let package = {
        let mut conn = store.lock_conn()?;
        move_status(&mut conn, &Actor::from(actor), &input, now_millis())?
    };
    emit(&app, &package.id);
    Ok(package)
}

#[tauri::command(async)]
pub fn programme_park(
    app: AppHandle,
    store: State<'_, SessionStore>,
    actor: ActorBody,
    input: ParkBody,
) -> Result<Package, String> {
    let package = {
        let mut conn = store.lock_conn()?;
        store::park(
            &mut conn,
            &Actor::from(actor),
            &input.id,
            input.version,
            &input.reason,
            input.security,
            now_millis(),
        )?
    };
    emit(&app, &package.id);
    Ok(package)
}

/// The person's clear. A first mate's call is refused by the store.
#[tauri::command(async)]
pub fn programme_clear(
    app: AppHandle,
    store: State<'_, SessionStore>,
    actor: ActorBody,
    input: ClearBody,
) -> Result<Package, String> {
    let package = {
        let mut conn = store.lock_conn()?;
        store::clear_park(
            &mut conn,
            &Actor::from(actor),
            &input.id,
            input.version,
            now_millis(),
        )?
    };
    emit(&app, &package.id);
    Ok(package)
}
