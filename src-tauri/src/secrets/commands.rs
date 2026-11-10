//! WP-92: the app's door to the vault. The page, the chat card and the MCP tools all reach these.
//!
//! Only [`secrets_reveal`] returns a value; the page's invoke spy holds that: a value field on that call alone. Every
//! other command returns handles (name, label, scope, last four, grants, .env files), never the bytes.

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::session_store::{now_millis, SessionStore};

use super::*;

fn vault() -> &'static dyn Vault {
    store::active()
}

/// Every secret as a handle, newest metadata in.
#[tauri::command(async)]
pub fn secrets_list(store: State<'_, SessionStore>) -> Result<Vec<SecretRow>, String> {
    handles(&*store.lock_conn()?)
}

/// The import rows first: a secret that came from an export needs its value before it can be used.
#[tauri::command(async)]
pub fn secrets_pending(store: State<'_, SessionStore>) -> Result<Vec<RequestRow>, String> {
    list_requests(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn secrets_save_new(
    store: State<'_, SessionStore>,
    scope: String,
    name: String,
    label: Option<String>,
    value: String,
) -> Result<SecretRow, String> {
    let conn = store.lock_conn()?;
    save_value(
        vault(),
        &conn,
        &scope,
        &name,
        label.as_deref(),
        &value,
        now_millis(),
    )
}

/// The card's Save: the page has the token from `secrets_begin_save`, and the value is passed once, straight here.
#[tauri::command(async)]
pub fn secrets_begin_save(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<SaveTicket, String> {
    let conn = store.lock_conn()?;
    let (request, token) = begin_save(&conn, &id, now_millis())?;
    Ok(SaveTicket { request, token })
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTicket {
    pub request: RequestRow,
    /// The compare-and-swap token. It holds no value.
    pub token: String,
}

#[tauri::command(async)]
pub fn secrets_save<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    id: String,
    token: String,
    label: Option<String>,
    value: String,
) -> Result<SecretRow, String> {
    let mut conn = store.lock_conn()?;
    let saved = finish_save(
        vault(),
        &conn,
        &id,
        &token,
        label.as_deref(),
        &value,
        now_millis(),
    )?;
    let request = get_request(&conn, &id)?;
    if let Some(request) = request.as_ref() {
        if let Some(message) = resume(&mut conn, request, Some(&saved)) {
            announce_steering(&app, &message);
        }
    }
    let _ = app.emit(CHANGED, json!({ "id": id }));
    Ok(saved)
}

#[tauri::command(async)]
pub fn secrets_decline<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    id: String,
    token: Option<String>,
) -> Result<(), String> {
    let mut conn = store.lock_conn()?;
    decline(&conn, &id, token.as_deref(), now_millis())?;
    if let Some(request) = get_request(&conn, &id)? {
        if let Some(message) = resume(&mut conn, &request, None) {
            announce_steering(&app, &message);
        }
    }
    let _ = app.emit(CHANGED, json!({ "id": id }));
    Ok(())
}

/// The same event `steering::changed` emits, from a generic `AppHandle` so the plugin stays generic over its runtime.
fn announce_steering<R: tauri::Runtime>(
    app: &AppHandle<R>,
    message: &crate::steering::SteerMessage,
) {
    let _ = app.emit(
        crate::steering::CHANGED,
        json!({ "ids": [message.id], "children": [message.child_session] }),
    );
}

/// The note that brings the Mono's turn back, exactly as an answered decision does.
fn resume(
    conn: &mut rusqlite::Connection,
    request: &RequestRow,
    saved: Option<&SecretRow>,
) -> Option<crate::steering::SteerMessage> {
    let text = match saved {
        Some(row) => format!(
            "The person saved the key {} (scope {}). Call app secrets.run with that name; its value stays in their keychain and never reaches you. This is the app's note, not a new message.",
            row.name, row.scope
        ),
        None => format!(
            "The person said not now to the key {}. Carry on without it, or ask for it again later with the reason it is needed. This is the app's note, not a new message.",
            request.name
        ),
    };
    crate::steering::record(
        conn,
        crate::steering::SteerInput {
            owner_session: request.chat.clone(),
            child_session: request.chat.clone(),
            delegation_id: None,
            request_id: format!("secret-{}", request.id),
            text,
            mode: Some("queue".into()),
            source: Some("secret".into()),
            decision_key: None,
        },
        now_millis(),
    )
    .ok()
}

/// The tool `app secrets.request`: a card appears, or the handle comes back at once.
#[tauri::command(async)]
pub fn secrets_request<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    input: RequestInput,
) -> Result<RequestOutcome, String> {
    let conn = store.lock_conn()?;
    let outcome = open_request(vault(), &conn, input, now_millis())?;
    let _ = app.emit(CHANGED, json!({}));
    Ok(outcome)
}

/// Another pending request, for the Inbox card and the chat card.
#[tauri::command(async)]
pub fn secrets_requests(store: State<'_, SessionStore>) -> Result<Vec<RequestRow>, String> {
    list_requests(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn secrets_rename(
    store: State<'_, SessionStore>,
    scope: String,
    name: String,
    label: String,
    version: i64,
) -> Result<SecretRow, String> {
    let conn = store.lock_conn()?;
    rename(&conn, &scope, &name, &label, version, now_millis())
}

#[tauri::command(async)]
pub fn secrets_rotate<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    scope: String,
    name: String,
    label: Option<String>,
    value: String,
    update_env: Option<bool>,
) -> Result<RotateReport, String> {
    let update_env = update_env.unwrap_or(false);
    let conn = store.lock_conn()?;
    let old = read_value(vault(), &scope, &name).ok();
    let env_files: Vec<String> = env_writes_for(&conn, &scope, &name)?
        .into_iter()
        .map(|write| write.worktree)
        .collect();
    let row = match label.as_deref() {
        Some(label) => {
            let current = get_secret(&conn, &scope, &name)?
                .ok_or_else(|| "That key isn't here any more.".to_string())?;
            let renamed = rename(&conn, &scope, &name, label, current.version, now_millis())?;
            save_value(
                vault(),
                &conn,
                &scope,
                &name,
                Some(&renamed.label),
                &value,
                now_millis(),
            )?
        }
        None => rotate(vault(), &conn, &scope, &name, &value, now_millis())?,
    };
    // Only on the person's tap ("Update the files that hold it"), and only while a line still holds the old value. A
    // file that fails a check is reported with its reason, and the rest are still done.
    let mut updated = Vec::new();
    let mut left_alone = Vec::new();
    let mut refused = Vec::new();
    let mut shared = Vec::new();
    if update_env {
        if let Some(old) = old.as_deref() {
            for write in env_writes_for(&conn, &scope, &name)? {
                let path = std::path::Path::new(&write.worktree);
                match env_file::rewrite_line(path, &write.env_name, old, Some(&value)) {
                    Ok(env_file::LineChange::Changed) => {
                        if env_file::readable_by_others(&path.join(".env")) {
                            shared.push(write.worktree.clone());
                        }
                        updated.push(write.worktree);
                    }
                    Ok(env_file::LineChange::LeftAlone) => left_alone.push(write.worktree),
                    Ok(env_file::LineChange::Missing) => {}
                    Ok(env_file::LineChange::Refused(why)) | Err(why) => {
                        refused.push(RefusedFile {
                            worktree: write.worktree,
                            why,
                        })
                    }
                }
            }
        }
    }
    let _ = app.emit(CHANGED, json!({}));
    Ok(RotateReport {
        secret: row,
        env_files,
        updated,
        left_alone,
        refused,
        shared,
    })
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateReport {
    pub secret: SecretRow,
    /// The `.env` files that hold the old value, offered for a second tap.
    pub env_files: Vec<String>,
    /// Worktrees whose line was rewritten.
    pub updated: Vec<String>,
    /// Worktrees whose line no longer held the old value: a hand edit, left alone.
    pub left_alone: Vec<String>,
    /// Files that no longer pass the write's checks (now tracked, no longer ignored, now a link), left as they were.
    pub refused: Vec<RefusedFile>,
    /// Updated files that other accounts on this Mac can read (the person's own mode is kept).
    pub shared: Vec<String>,
}

#[tauri::command(async)]
pub fn secrets_delete<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    scope: String,
    name: String,
) -> Result<DeleteReport, String> {
    let conn = store.lock_conn()?;
    let report = delete(vault(), &conn, &scope, &name)?;
    let _ = app.emit(CHANGED, json!({}));
    Ok(report)
}

/// The one command that returns a value. The page clears it when the row closes.
#[tauri::command(async)]
pub fn secrets_reveal(scope: String, name: String) -> Result<String, String> {
    reveal(vault(), &scope, &name)
}

#[tauri::command(async)]
pub fn secrets_grants(
    store: State<'_, SessionStore>,
    scope: String,
    name: String,
) -> Result<Vec<GrantRow>, String> {
    grants_for(&*store.lock_conn()?, &scope, &name)
}

#[tauri::command(async)]
pub fn secrets_revoke_grant<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    scope: String,
    name: String,
    subject_kind: String,
    subject_id: String,
    executable: Option<String>,
) -> Result<usize, String> {
    let conn = store.lock_conn()?;
    let removed = revoke_grant(
        &conn,
        &scope,
        &name,
        &subject_kind,
        &subject_id,
        executable.as_deref(),
    )?;
    let _ = app.emit(CHANGED, json!({}));
    Ok(removed)
}

/// The `.env` files that hold a secret, before a rotate, so the page can offer to update them.
#[tauri::command(async)]
pub fn secrets_env_files(
    store: State<'_, SessionStore>,
    scope: String,
    name: String,
) -> Result<Vec<EnvWriteRow>, String> {
    env_writes_for(&*store.lock_conn()?, &scope, &name)
}

/// The worker route (`delegate_task`'s `secrets`): check every name, ask where needed, and arm the handles for the
/// session the worker is about to start. Values never leave Rust.
#[tauri::command(async)]
pub fn secrets_worker_arm(
    store: State<'_, SessionStore>,
    session_id: String,
    request: super::worker::WorkerRequest,
) -> Result<super::worker::WorkerOutcome, String> {
    let mut conn = store.lock_conn()?;
    let outcome = super::worker::prepare(vault(), &mut conn, request, now_millis())?;
    if let super::worker::WorkerOutcome::Ready { secrets } = &outcome {
        super::worker::arm(&session_id, secrets.clone());
    }
    Ok(outcome)
}

/// The tool `app secrets.run`: the checks, the approval card, then one signed grant.
#[tauri::command(async)]
pub fn secrets_grant<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    request: RunRequest,
) -> Result<RunOutcome, String> {
    let mut conn = store.lock_conn()?;
    let outcome = prepare_run(vault(), &mut conn, request, now_millis())?;
    if !matches!(outcome, RunOutcome::Granted { .. }) {
        let _ = app.emit(crate::decisions::CHANGED, json!({ "keys": [] }));
    }
    Ok(outcome)
}

/// The person's tap: write one secret into one worktree's `.env`. The value is read in Rust and never crosses the
/// webview.
#[tauri::command(async)]
pub fn secrets_env_write<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    project: String,
    worktree: String,
    scope: String,
    name: String,
    env_name: String,
) -> Result<EnvWriteReport, String> {
    // 1 to 5, before the value is read at all.
    let target = env_file::check(&project, &worktree)?;
    let value = read_value(vault(), &scope, &name)?;
    // 6.
    env_file::writable_value(&value)?;
    env_file::write(&target, &env_name, &value)?;
    let conn = store.lock_conn()?;
    record_env_write(
        &conn,
        &scope,
        &name,
        env_file::inside_project(&project, &worktree)?.as_str(),
        &env_name,
        now_millis(),
    )?;
    let _ = app.emit(CHANGED, json!({}));
    // An existing `.env` keeps the person's own mode; if other accounts can read it, the page says so.
    Ok(EnvWriteReport {
        readable_by_others: env_file::readable_by_others(&target.path),
    })
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvWriteReport {
    pub readable_by_others: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvRemoveInput {
    pub project: String,
    pub worktree: String,
    pub scope: String,
    pub name: String,
    pub env_name: String,
}

#[tauri::command(async)]
pub fn secrets_env_remove<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    input: EnvRemoveInput,
) -> Result<bool, String> {
    let target = env_file::check(&input.project, &input.worktree)?;
    let value = read_value(vault(), &input.scope, &input.name).ok();
    let removed = match env_file::remove_line(
        &target.root,
        &input.env_name,
        value.as_ref().map(|v| v.as_str()),
    )? {
        env_file::LineChange::Changed => true,
        // The file failed a check since it was written: nothing was touched, and the page shows why.
        env_file::LineChange::Refused(why) => return Err(why),
        env_file::LineChange::LeftAlone | env_file::LineChange::Missing => false,
    };
    if removed {
        let conn = store.lock_conn()?;
        // Only this worktree's record: other `.env` files that hold the same secret stay listed.
        conn.execute(
            "DELETE FROM secret_env_writes WHERE scope = ?1 AND name = ?2 AND worktree = ?3",
            rusqlite::params![
                input.scope,
                input.name,
                env_file::inside_project(&input.project, &input.worktree)?
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit(CHANGED, json!({}));
    Ok(removed)
}

/// The per-install choice about "Always" for programs that can run any code. Off unless the person turned it on.
#[tauri::command(async)]
pub fn secrets_always_for_any_code(store: State<'_, SessionStore>) -> Result<bool, String> {
    Ok(always_for_any_code(&*store.lock_conn()?))
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlwaysSetting {
    pub on: bool,
    /// Turning it off takes back the "Always" grants it had allowed for such programs.
    pub removed_grants: usize,
}

#[tauri::command(async)]
pub fn secrets_set_always_for_any_code<R: tauri::Runtime>(
    app: AppHandle<R>,
    store: State<'_, SessionStore>,
    on: bool,
) -> Result<AlwaysSetting, String> {
    let conn = store.lock_conn()?;
    let removed_grants = set_always_for_any_code(&conn, on)?;
    let _ = app.emit(CHANGED, json!({}));
    Ok(AlwaysSetting {
        on: always_for_any_code(&conn),
        removed_grants,
    })
}

/// A card's scope/label helper: the slug the card will store, so the person sees it before typing.
#[tauri::command(async)]
pub fn secrets_slug(name: String) -> Result<String, String> {
    normalize_name(&name)
}

/// `secrets/index.json` for the export.
#[tauri::command(async)]
pub fn secrets_index(store: State<'_, SessionStore>) -> Result<serde_json::Value, String> {
    index_json(&*store.lock_conn()?)
}

/// Event after any change, so every window hears it.
pub const CHANGED: &str = "hivra:secrets-changed";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_change_event_is_named_once() {
        assert_eq!(CHANGED, "hivra:secrets-changed");
    }
}
