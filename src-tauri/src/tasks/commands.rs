//! The window's calls. The lock is dropped before anything is emitted.

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::session_store::{now_millis, SessionStore};

use super::store::{self, Actor, CreateInput, Set, Task, UpdateInput, Written};

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
pub struct CreateBody {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub due_at: Option<i64>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBody {
    pub id: String,
    #[serde(default)]
    pub version: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// Missing stays, null or "" clears, a string sets.
    #[serde(default, deserialize_with = "present_or_absent")]
    pub parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_or_absent")]
    pub assignee: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_or_absent")]
    pub due_at: Option<Option<i64>>,
    #[serde(default)]
    pub clear_due: bool,
    #[serde(default)]
    pub sort_key: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub trash: bool,
    #[serde(default)]
    pub source: Option<String>,
}

fn present_or_absent<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

fn set_of<T>(value: Option<Option<T>>) -> Set<T> {
    match value {
        None => Set::Keep,
        Some(None) => Set::Clear,
        Some(Some(value)) => Set::Value(value),
    }
}

fn scope(actor: &Actor, project: Option<&str>) -> Result<(), String> {
    let Some(project) = project.map(str::trim).filter(|project| !project.is_empty()) else {
        return Ok(());
    };
    if actor.kind == "agent" && project != actor.project.trim() {
        return Err("That project isn't this chat's.".into());
    }
    Ok(())
}

fn emit(app: &AppHandle, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let _ = app.emit(store::CHANGED, serde_json::json!({ "ids": ids }));
}

#[tauri::command(async)]
pub fn tasks_list(
    store: State<'_, SessionStore>,
    actor: ActorBody,
    project: Option<String>,
) -> Result<Vec<Task>, String> {
    let actor = Actor::from(actor);
    scope(&actor, project.as_deref())?;
    let conn = store.lock_conn()?;
    store::list(&conn, &actor)
}

#[tauri::command(async)]
pub fn tasks_get(
    store: State<'_, SessionStore>,
    actor: ActorBody,
    id: String,
) -> Result<Task, String> {
    let conn = store.lock_conn()?;
    store::get(&conn, &Actor::from(actor), &id)
}

#[tauri::command(async)]
pub fn tasks_create(
    app: AppHandle,
    store: State<'_, SessionStore>,
    actor: ActorBody,
    input: CreateBody,
) -> Result<Written, String> {
    let actor = Actor::from(actor);
    scope(&actor, input.project.as_deref())?;
    let written = {
        let mut conn = store.lock_conn()?;
        store::create(
            &mut conn,
            &actor,
            &CreateInput {
                title: input.title,
                description: input.description,
                status: input.status,
                priority: input.priority,
                labels: input.labels,
                parent_id: input.parent_id,
                assignee: input.assignee,
                due_at: input.due_at,
                project: input.project,
                source: input.source,
                needs_you: false,
            },
            now_millis(),
        )?
    };
    emit(&app, &written.changed);
    Ok(written)
}

#[tauri::command(async)]
pub fn tasks_update(
    app: AppHandle,
    store: State<'_, SessionStore>,
    actor: ActorBody,
    input: UpdateBody,
) -> Result<Written, String> {
    let due = if input.clear_due {
        Set::Clear
    } else {
        set_of(input.due_at)
    };
    let written = {
        let mut conn = store.lock_conn()?;
        store::update(
            &mut conn,
            &Actor::from(actor),
            &UpdateInput {
                id: input.id,
                version: input.version,
                title: input.title,
                description: input.description,
                status: input.status,
                priority: input.priority,
                labels: input.labels,
                parent: set_of(input.parent_id),
                assignee: set_of(input.assignee),
                due,
                sort_key: input.sort_key,
                comment: input.comment,
                trash: input.trash,
                source: input.source,
            },
            now_millis(),
        )?
    };
    if !written.stale {
        emit(&app, &written.changed);
    }
    Ok(written)
}
