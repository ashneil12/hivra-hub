use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::session_store::{now_millis, validate_id, SessionStore};

pub(crate) const CHANGED: &str = "monocode:automations-changed";

const MAX_NAME: usize = 200;
const MAX_PROMPT: usize = 1_000_000;
const MAX_TRIGGERS: usize = 20;
const MAX_RUNS_PER_AUTOMATION: i64 = 100;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    id: String,
    name: String,
    prompt: String,
    harness: String,
    model: String,
    #[serde(default)]
    model_settings: HashMap<String, String>,
    cwd: String,
    workspace_mode: String,
    #[serde(default)]
    worktree_cwd: String,
    #[serde(default)]
    session_folder_id: String,
    reuse_session: bool,
    runtime_mode: String,
    #[serde(default = "default_trigger_kind")]
    trigger_kind: String,
    #[serde(default)]
    trigger_event: String,
    schedule_kind: String,
    minute: i64,
    time: String,
    day_of_week: i64,
    #[serde(default)]
    triggers: Option<Vec<AutomationTrigger>>,
    missed_run_grace_minutes: i64,
    enabled: bool,
    next_run_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_session_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpsert {
    id: String,
    name: String,
    prompt: String,
    harness: String,
    model: String,
    #[serde(default)]
    model_settings: HashMap<String, String>,
    cwd: String,
    workspace_mode: String,
    #[serde(default)]
    worktree_cwd: String,
    #[serde(default)]
    session_folder_id: String,
    #[serde(default)]
    reuse_session: bool,
    runtime_mode: String,
    #[serde(default = "default_trigger_kind")]
    trigger_kind: String,
    #[serde(default)]
    trigger_event: String,
    schedule_kind: String,
    minute: i64,
    time: String,
    day_of_week: i64,
    #[serde(default)]
    triggers: Option<Vec<AutomationTrigger>>,
    missed_run_grace_minutes: i64,
    #[serde(default = "default_true")]
    enabled: bool,
    next_run_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    id: String,
    automation_id: String,
    trigger: String,
    scheduled_for: i64,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<i64>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTrigger {
    #[serde(default)]
    id: String,
    kind: String,
    #[serde(default)]
    event: String,
    #[serde(default = "default_schedule_kind")]
    schedule_kind: String,
    #[serde(default)]
    minute: i64,
    #[serde(default = "default_time")]
    time: String,
    #[serde(default = "default_day_of_week")]
    day_of_week: i64,
    #[serde(default)]
    repos: Vec<String>,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    branch: String,
    #[serde(default = "default_actor")]
    actor: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueAutomationRun {
    automation: Automation,
    run: AutomationRun,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationEventClaim {
    event_key: String,
    event_kind: String,
    event: String,
    scheduled_for: i64,
    prompt: String,
}

fn default_true() -> bool {
    true
}

fn default_trigger_kind() -> String {
    "time".into()
}

fn default_schedule_kind() -> String {
    "weekdays".into()
}

fn default_time() -> String {
    "09:00".into()
}

fn default_day_of_week() -> i64 {
    1
}

fn default_actor() -> String {
    "anyone".into()
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS automations (
           id TEXT PRIMARY KEY,
           definition_json TEXT NOT NULL,
           enabled INTEGER NOT NULL,
           next_run_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS automations_due_idx
           ON automations (enabled, next_run_at);
         CREATE TABLE IF NOT EXISTS automation_runs (
           id TEXT PRIMARY KEY,
           automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
           created_at INTEGER NOT NULL,
           run_json TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS automation_runs_history_idx
           ON automation_runs (automation_id, created_at DESC);
         CREATE TABLE IF NOT EXISTS automation_event_claims (
           automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
           event_key TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           PRIMARY KEY (automation_id, event_key)
         );",
    )?;

    // Backfill claims from pre-ledger run history. Invalid legacy rows should not
    // prevent the session store from opening.
    let mut statement =
        conn.prepare("SELECT automation_id, created_at, run_json FROM automation_runs")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut claims = Vec::new();
    for row in rows {
        let (automation_id, created_at, raw) = row?;
        if let Ok(run) = serde_json::from_str::<AutomationRun>(&raw) {
            if let Some(event_key) = run.event_key {
                claims.push((automation_id, event_key, created_at));
            }
        }
    }
    drop(statement);
    for (automation_id, event_key, created_at) in claims {
        conn.execute(
            "INSERT OR IGNORE INTO automation_event_claims
             (automation_id, event_key, created_at) VALUES (?1, ?2, ?3)",
            params![automation_id, event_key, created_at],
        )?;
    }
    Ok(())
}

fn validate_upsert(input: &AutomationUpsert, now: i64) -> Result<(), String> {
    validate_id(&input.id, "automation")?;
    if input.name.trim().is_empty() || input.name.len() > MAX_NAME {
        return Err("Automation name is required and must be under 200 characters.".into());
    }
    if input.prompt.trim().is_empty() || input.prompt.len() > MAX_PROMPT {
        return Err("Automation prompt is required.".into());
    }
    if input.cwd.trim().is_empty() {
        return Err("Choose a project for this automation.".into());
    }
    if !matches!(
        input.workspace_mode.as_str(),
        "current" | "worktree" | "existing"
    ) {
        return Err("Invalid automation workspace mode.".into());
    }
    if input.workspace_mode == "existing" {
        let path = input.worktree_cwd.trim();
        if path.is_empty() || path.len() > 1_000 {
            return Err("Choose an existing worktree for this automation.".into());
        }
    }
    if input.session_folder_id.len() > 80 {
        return Err("Invalid automation session folder.".into());
    }
    if !matches!(
        input.runtime_mode.as_str(),
        "supervised" | "auto-accept-edits" | "auto" | "full-access"
    ) {
        return Err("Invalid automation run mode.".into());
    }
    if !matches!(
        input.trigger_kind.as_str(),
        "time" | "github" | "linear" | "jira" | "gitlab" | "azuredevops"
    ) {
        return Err("Invalid automation trigger.".into());
    }
    if input.trigger_event.len() > 200 {
        return Err("Invalid automation trigger event.".into());
    }
    if !matches!(
        input.schedule_kind.as_str(),
        "hourly" | "daily" | "weekdays" | "weekly"
    ) {
        return Err("Invalid automation schedule.".into());
    }
    if !(0..=59).contains(&input.minute)
        || !(0..=6).contains(&input.day_of_week)
        || !valid_time(&input.time)
    {
        return Err("Invalid automation time.".into());
    }
    if !(0..=43_200).contains(&input.missed_run_grace_minutes) {
        return Err("Invalid missed-run grace period.".into());
    }
    if input.next_run_at <= now {
        return Err("The next automation run must be in the future.".into());
    }
    if let Some(triggers) = &input.triggers {
        if triggers.len() > MAX_TRIGGERS {
            return Err("Too many automation triggers.".into());
        }
        for trigger in triggers {
            validate_trigger(trigger)?;
        }
    }
    Ok(())
}

fn validate_trigger(trigger: &AutomationTrigger) -> Result<(), String> {
    if !matches!(
        trigger.kind.as_str(),
        "time" | "github" | "linear" | "jira" | "gitlab" | "azuredevops"
    ) {
        return Err("Invalid automation trigger.".into());
    }
    if trigger.event.len() > 200
        || trigger.repo.len() > 400
        || trigger.branch.len() > 400
        || trigger.actor.len() > 200
        || trigger.repos.len() > 50
        || trigger.repos.iter().any(|repo| repo.len() > 400)
    {
        return Err("Invalid automation trigger event.".into());
    }
    if !matches!(
        trigger.schedule_kind.as_str(),
        "hourly" | "daily" | "weekdays" | "weekly"
    ) {
        return Err("Invalid automation schedule.".into());
    }
    if !(0..=59).contains(&trigger.minute)
        || !(0..=6).contains(&trigger.day_of_week)
        || !valid_time(&trigger.time)
    {
        return Err("Invalid automation time.".into());
    }
    Ok(())
}

fn hydrate_triggers(automation: &mut Automation) {
    if automation.triggers.is_some() {
        return;
    }
    automation.triggers = Some(vec![legacy_trigger(automation)]);
}

fn legacy_trigger(automation: &Automation) -> AutomationTrigger {
    trigger_from_fields(
        &automation.id,
        &automation.trigger_kind,
        &automation.trigger_event,
        &automation.schedule_kind,
        automation.minute,
        &automation.time,
        automation.day_of_week,
    )
}

fn has_time_trigger(automation: &Automation) -> bool {
    match &automation.triggers {
        Some(triggers) => triggers.iter().any(|trigger| trigger.kind == "time"),
        None => automation.trigger_kind == "time",
    }
}

fn normalize_triggers(input: &AutomationUpsert) -> Vec<AutomationTrigger> {
    let mut triggers = input.triggers.clone().unwrap_or_else(|| {
        vec![trigger_from_fields(
            &input.id,
            &input.trigger_kind,
            &input.trigger_event,
            &input.schedule_kind,
            input.minute,
            &input.time,
            input.day_of_week,
        )]
    });
    for trigger in &mut triggers {
        if trigger.id.trim().is_empty() {
            trigger.id = Uuid::new_v4().to_string();
        }
        trigger.event = trigger.event.trim().to_string();
        trigger.repo = trigger.repo.trim().to_string();
        trigger.branch = trigger.branch.trim().to_string();
        trigger.actor = trigger.actor.trim().to_string();
        if trigger.actor.is_empty() {
            trigger.actor = default_actor();
        }
        trigger.repos = trigger
            .repos
            .iter()
            .map(|repo| repo.trim().to_string())
            .filter(|repo| !repo.is_empty())
            .collect();
    }
    triggers
}

fn trigger_from_fields(
    id: &str,
    kind: &str,
    event: &str,
    schedule_kind: &str,
    minute: i64,
    time: &str,
    day_of_week: i64,
) -> AutomationTrigger {
    AutomationTrigger {
        id: format!("{id}:legacy"),
        kind: kind.to_string(),
        event: if event.is_empty() {
            schedule_kind.to_string()
        } else {
            event.to_string()
        },
        schedule_kind: schedule_kind.to_string(),
        minute,
        time: time.to_string(),
        day_of_week,
        repos: Vec::new(),
        repo: String::new(),
        branch: String::new(),
        actor: default_actor(),
    }
}

fn parse_automation(value: String) -> Result<Automation, String> {
    let mut automation: Automation =
        serde_json::from_str(&value).map_err(|error| error.to_string())?;
    hydrate_triggers(&mut automation);
    Ok(automation)
}

fn valid_time(value: &str) -> bool {
    let Some((hour, minute)) = value.split_once(':') else {
        return false;
    };
    hour.len() == 2
        && minute.len() == 2
        && hour.parse::<u8>().is_ok_and(|value| value < 24)
        && minute.parse::<u8>().is_ok_and(|value| value < 60)
}

fn list(conn: &Connection) -> Result<Vec<Automation>, String> {
    let mut statement = conn
        .prepare("SELECT definition_json FROM automations ORDER BY updated_at DESC, id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let value = row.map_err(|error| error.to_string())?;
        parse_automation(value)
    })
    .collect()
}

fn get(conn: &Connection, id: &str) -> Result<Option<Automation>, String> {
    let raw = conn
        .query_row(
            "SELECT definition_json FROM automations WHERE id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    raw.map(parse_automation).transpose()
}

fn write_automation(conn: &Connection, automation: &Automation) -> Result<(), String> {
    let raw = serde_json::to_string(automation).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           definition_json = excluded.definition_json,
           enabled = excluded.enabled,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at",
        params![
            automation.id,
            raw,
            automation.enabled,
            automation.next_run_at,
            automation.updated_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn write_run(conn: &Connection, run: &AutomationRun) -> Result<(), String> {
    let raw = serde_json::to_string(run).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO automation_runs (id, automation_id, created_at, run_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET run_json = excluded.run_json",
        params![run.id, run.automation_id, run.created_at, raw],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn new_run(
    automation_id: &str,
    trigger: &str,
    scheduled_for: i64,
    now: i64,
    prompt: &str,
) -> AutomationRun {
    AutomationRun {
        id: Uuid::new_v4().to_string(),
        automation_id: automation_id.to_string(),
        trigger: trigger.to_string(),
        scheduled_for,
        created_at: now,
        started_at: None,
        completed_at: None,
        status: "pending".into(),
        session_id: None,
        error: None,
        event_key: None,
        event_kind: None,
        event: None,
        prompt: Some(prompt.to_string()),
    }
}

fn new_event_run(
    automation_id: &str,
    event_key: &str,
    event_kind: &str,
    event: &str,
    scheduled_for: i64,
    now: i64,
    prompt: &str,
) -> AutomationRun {
    let mut run = new_run(automation_id, "event", scheduled_for, now, prompt);
    run.event_key = Some(event_key.to_string());
    run.event_kind = Some(event_kind.to_string());
    run.event = Some(event.to_string());
    run
}

fn validate_event_key(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 400
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'/' | b'.')
        })
    {
        return Err("Invalid automation event key.".into());
    }
    Ok(())
}

fn has_event_trigger(automation: &Automation, kind: &str, event: &str) -> bool {
    match &automation.triggers {
        Some(triggers) => triggers
            .iter()
            .any(|trigger| trigger.kind == kind && trigger.event == event),
        None => automation.trigger_kind == kind && automation.trigger_event == event,
    }
}

fn list_runs(conn: &Connection, automation_id: &str) -> Result<Vec<AutomationRun>, String> {
    let mut statement = conn
        .prepare(
            "SELECT run_json FROM automation_runs WHERE automation_id = ?1
             ORDER BY created_at DESC LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([automation_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let value = row.map_err(|error| error.to_string())?;
        serde_json::from_str(&value).map_err(|error| error.to_string())
    })
    .collect()
}

fn trim_history(conn: &Connection, automation_id: &str) -> Result<(), String> {
    let mut statement = conn
        .prepare(
            "SELECT id, run_json FROM automation_runs WHERE automation_id = ?1
             ORDER BY created_at DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([automation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut delete_ids = Vec::new();
    for (index, row) in rows.enumerate() {
        let (id, raw) = row.map_err(|error| error.to_string())?;
        if index < MAX_RUNS_PER_AUTOMATION as usize {
            continue;
        }
        let run: AutomationRun = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        if is_final_status(&run.status) {
            delete_ids.push(id);
        }
    }
    drop(statement);
    for id in delete_ids {
        conn.execute("DELETE FROM automation_runs WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn apply_run_summary(automation: &mut Automation, run: &AutomationRun) {
    if automation
        .last_run_at
        .is_none_or(|last_run_at| run.created_at >= last_run_at)
    {
        automation.last_run_at = Some(run.created_at);
        automation.last_run_status = Some(run.status.clone());
        automation.last_run_error = run.error.clone();
        if run.session_id.is_some() {
            automation.last_session_id = run.session_id.clone();
        }
    }
}

#[tauri::command(async)]
pub fn automations_list(store: State<'_, SessionStore>) -> Result<Vec<Automation>, String> {
    let conn = store.lock_conn()?;
    list(&conn)
}

#[tauri::command(async)]
pub fn automations_upsert(
    app: AppHandle,
    store: State<'_, SessionStore>,
    automation: AutomationUpsert,
) -> Result<Automation, String> {
    let now = now_millis();
    validate_upsert(&automation, now)?;
    let triggers = Some(normalize_triggers(&automation));
    let conn = store.lock_conn()?;
    let previous = get(&conn, &automation.id)?;
    let created_at = previous
        .as_ref()
        .map(|value| value.created_at)
        .unwrap_or(now);
    let worktree_cwd = if automation.workspace_mode == "existing" {
        automation.worktree_cwd.trim().to_string()
    } else {
        String::new()
    };
    let saved = Automation {
        id: automation.id,
        name: automation.name.trim().to_string(),
        prompt: automation.prompt,
        harness: automation.harness,
        model: automation.model,
        model_settings: automation.model_settings,
        cwd: automation.cwd,
        workspace_mode: automation.workspace_mode,
        worktree_cwd,
        session_folder_id: automation.session_folder_id.trim().to_string(),
        reuse_session: automation.reuse_session,
        runtime_mode: automation.runtime_mode,
        trigger_kind: automation.trigger_kind,
        trigger_event: automation.trigger_event.trim().to_string(),
        schedule_kind: automation.schedule_kind,
        minute: automation.minute,
        time: automation.time,
        day_of_week: automation.day_of_week,
        triggers,
        missed_run_grace_minutes: automation.missed_run_grace_minutes,
        enabled: automation.enabled,
        next_run_at: automation.next_run_at,
        last_run_at: previous.as_ref().and_then(|value| value.last_run_at),
        last_run_status: previous
            .as_ref()
            .and_then(|value| value.last_run_status.clone()),
        last_run_error: previous
            .as_ref()
            .and_then(|value| value.last_run_error.clone()),
        last_session_id: previous.and_then(|value| value.last_session_id),
        created_at,
        updated_at: now,
    };
    write_automation(&conn, &saved)?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(saved)
}

#[tauri::command(async)]
pub fn automations_delete(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    validate_id(&id, "automation")?;
    let conn = store.lock_conn()?;
    conn.execute("DELETE FROM automations WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(())
}

#[tauri::command(async)]
pub fn automation_runs_list(
    store: State<'_, SessionStore>,
    automation_id: String,
) -> Result<Vec<AutomationRun>, String> {
    validate_id(&automation_id, "automation")?;
    let conn = store.lock_conn()?;
    let mut runs = list_runs(&conn, &automation_id)?;
    // Launch prompts can be large and are only needed by restart recovery, not
    // by the run-history surface.
    for run in &mut runs {
        run.prompt = None;
    }
    Ok(runs)
}

struct RecoveredRuns {
    due: Vec<DueAutomationRun>,
    changed: bool,
    /// WP-180a: true once a restart wrote a new activity line.
    noted: bool,
}

/// The body of `automation_runs_recover`, without the app handle, so a test can
/// drive it. A pending event run with no prompt becomes failed.
fn recover_stored_runs(
    conn: &mut Connection,
    started_before: i64,
    now: i64,
) -> Result<RecoveredRuns, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut statement = tx
        .prepare(
            "SELECT run_json FROM automation_runs WHERE created_at <= ?1
             ORDER BY created_at, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([started_before], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut runs = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        runs.push(serde_json::from_str::<AutomationRun>(&raw).map_err(|error| error.to_string())?);
    }
    drop(statement);

    let mut due = Vec::new();
    let mut changed = false;
    let mut noted = false;
    let mut changed_automation_ids = Vec::new();
    for mut run in runs {
        if run.status != "pending" && run.status != "running" {
            continue;
        }
        let Some(mut automation) = get(&tx, &run.automation_id)? else {
            continue;
        };
        if run.status == "running" {
            run.status = "cancelled".into();
            run.completed_at = Some(now);
            run.error = Some("Interrupted when MonoCode last stopped.".into());
            apply_run_summary(&mut automation, &run);
            write_run(&tx, &run)?;
            write_automation(&tx, &automation)?;
            changed_automation_ids.push(run.automation_id.clone());
            changed = true;
            continue;
        }
        if run.trigger == "event"
            && run
                .prompt
                .as_deref()
                .is_none_or(|prompt| prompt.trim().is_empty())
        {
            let previous_status = run.status.clone();
            run.status = "failed".into();
            run.completed_at = Some(now);
            run.error = Some("The Inbox event prompt was not available after restart.".into());
            apply_run_summary(&mut automation, &run);
            write_run(&tx, &run)?;
            write_automation(&tx, &automation)?;
            if note_run_activity(&tx, &automation, &previous_status, &run, None, now) {
                noted = true;
            }
            changed_automation_ids.push(run.automation_id.clone());
            changed = true;
            continue;
        }
        due.push(DueAutomationRun { automation, run });
    }
    changed_automation_ids.sort();
    changed_automation_ids.dedup();
    for automation_id in changed_automation_ids {
        trim_history(&tx, &automation_id)?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(RecoveredRuns {
        due,
        changed,
        noted,
    })
}

#[tauri::command(async)]
pub fn automation_runs_recover(
    app: AppHandle,
    store: State<'_, SessionStore>,
    started_before: i64,
    now: i64,
) -> Result<Vec<DueAutomationRun>, String> {
    // A dev copy never runs automations on its own (src/instance.rs); its runs stay as they are.
    if !crate::instance::policy().automations {
        return Ok(Vec::new());
    }
    // A build on trial runs none until it commits (src/ship.rs). An error, not an empty list: the window retries
    // recovery later instead of remembering that there was nothing to recover.
    if crate::ship::holding() {
        return Err("This build is on trial; automations wait until it commits.".into());
    }
    let mut conn = store.lock_conn()?;
    let recovered = recover_stored_runs(&mut conn, started_before, now)?;
    drop(conn);
    if recovered.changed || !recovered.due.is_empty() {
        let _ = app.emit(CHANGED, ());
    }
    // WP-180a: the runs screen hears the activity log's own event.
    if recovered.noted {
        let _ = app.emit(crate::activity::CHANGED, ());
    }
    Ok(recovered.due)
}

#[tauri::command(async)]
pub fn automation_run_now(
    app: AppHandle,
    store: State<'_, SessionStore>,
    automation_id: String,
    now: i64,
) -> Result<AutomationRun, String> {
    validate_id(&automation_id, "automation")?;
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut automation =
        get(&tx, &automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    let run = new_run(&automation_id, "manual", now, now, &automation.prompt);
    automation.last_run_at = Some(now);
    automation.last_run_status = Some(run.status.clone());
    automation.last_run_error = None;
    write_run(&tx, &run)?;
    write_automation(&tx, &automation)?;
    trim_history(&tx, &automation_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(run)
}

#[tauri::command(async)]
pub fn automations_claim_due(
    app: AppHandle,
    store: State<'_, SessionStore>,
    automation_id: String,
    expected_next_run_at: i64,
    next_run_at: i64,
    now: i64,
) -> Result<Option<DueAutomationRun>, String> {
    validate_id(&automation_id, "automation")?;
    if next_run_at <= expected_next_run_at {
        return Err("The following automation occurrence must advance the schedule.".into());
    }
    // A dev copy never runs a scheduled automation (src/instance.rs). "Run now" is the user's own action and stays.
    // A build on trial holds them until it commits (src/ship.rs); the occurrence stays due.
    if !crate::instance::policy().automations || crate::ship::holding() {
        return Ok(None);
    }
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let current = get(&tx, &automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    if !has_time_trigger(&current) {
        tx.rollback().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let claimed = tx
        .execute(
            "UPDATE automations SET next_run_at = ?1
             WHERE id = ?2 AND enabled = 1 AND next_run_at = ?3 AND next_run_at <= ?4",
            params![next_run_at, automation_id, expected_next_run_at, now],
        )
        .map_err(|error| error.to_string())?;
    if claimed == 0 {
        tx.rollback().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let mut automation =
        get(&tx, &automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    automation.next_run_at = next_run_at;
    let mut run = new_run(
        &automation_id,
        "scheduled",
        expected_next_run_at,
        now,
        &automation.prompt,
    );
    let grace_ms = automation.missed_run_grace_minutes.saturating_mul(60_000);
    let missed = now.saturating_sub(expected_next_run_at);
    let dispatch = missed <= grace_ms;
    if !dispatch {
        run.status = "skipped".into();
        run.completed_at = Some(now);
        run.error = Some("Missed the scheduled run beyond its grace period.".into());
    }
    automation.last_run_at = Some(now);
    automation.last_run_status = Some(run.status.clone());
    automation.last_run_error = run.error.clone();
    write_run(&tx, &run)?;
    write_automation(&tx, &automation)?;
    trim_history(&tx, &automation_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(Some(DueAutomationRun { automation, run }))
}

#[tauri::command(async)]
pub fn automations_claim_event(
    app: AppHandle,
    store: State<'_, SessionStore>,
    automation_id: String,
    claim: AutomationEventClaim,
    now: i64,
) -> Result<Option<DueAutomationRun>, String> {
    validate_id(&automation_id, "automation")?;
    validate_event_key(&claim.event_key)?;
    if !matches!(
        claim.event_kind.as_str(),
        "github" | "linear" | "jira" | "gitlab" | "azuredevops"
    ) {
        return Err("Invalid automation trigger.".into());
    }
    if claim.event.is_empty() || claim.event.len() > 200 {
        return Err("Invalid automation trigger event.".into());
    }
    if claim.prompt.trim().is_empty() || claim.prompt.len() > MAX_PROMPT + 10_000 {
        return Err("Invalid automation run prompt.".into());
    }
    // A dev copy never runs an automation from an Inbox event (src/instance.rs), and a build on trial holds them.
    if !crate::instance::policy().automations || crate::ship::holding() {
        return Ok(None);
    }
    let scheduled_for = if claim.scheduled_for > 0 {
        claim.scheduled_for
    } else {
        now
    };
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut automation =
        get(&tx, &automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    if !automation.enabled || !has_event_trigger(&automation, &claim.event_kind, &claim.event) {
        tx.rollback().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let claimed = tx
        .execute(
            "INSERT OR IGNORE INTO automation_event_claims
             (automation_id, event_key, created_at) VALUES (?1, ?2, ?3)",
            params![automation_id, claim.event_key, now],
        )
        .map_err(|error| error.to_string())?;
    if claimed == 0 {
        tx.rollback().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let run = new_event_run(
        &automation_id,
        &claim.event_key,
        &claim.event_kind,
        &claim.event,
        scheduled_for,
        now,
        &claim.prompt,
    );
    automation.last_run_at = Some(now);
    automation.last_run_status = Some(run.status.clone());
    automation.last_run_error = None;
    write_run(&tx, &run)?;
    write_automation(&tx, &automation)?;
    trim_history(&tx, &automation_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(Some(DueAutomationRun { automation, run }))
}

/// An automation run's status, and the only moves between them. A run starts `pending`, goes `running` when its session
/// takes the prompt, and ends `succeeded`, `failed`, `cancelled` or `skipped`. An ended run stays as it ended: a late or
/// repeated update from the webview (a settle that lands after the run was cancelled, a launch error caught after the
/// turn already settled) changes nothing. Before this, `automation_run_update` wrote whatever status it was given, so a
/// cancelled run could become succeeded and a succeeded one failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

impl RunStatus {
    fn parse(status: &str) -> Option<Self> {
        Some(match status {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            "skipped" => Self::Skipped,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    fn is_final(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Skipped | Self::Cancelled
        )
    }

    /// Repeating the same status is allowed (it refreshes the session and error); a run never goes back to pending and
    /// never leaves an end.
    fn can_move_to(self, next: Self) -> bool {
        if self == next {
            return true;
        }
        match self {
            Self::Pending => true,
            Self::Running => next != Self::Pending,
            _ => false,
        }
    }
}

/// True for a status a run ends in. An unknown status (a record from a newer build) is not one.
fn is_final_status(status: &str) -> bool {
    RunStatus::parse(status).is_some_and(RunStatus::is_final)
}

struct StoredRunUpdate {
    run: AutomationRun,
    /// WP-180a: true once a new activity line was written for this update.
    noted: bool,
}

const AUTOMATION_STARTED: &str = "automation.started";
const AUTOMATION_COMPLETED: &str = "automation.completed";
const AUTOMATION_FAILED: &str = "automation.failed";

fn activity_kind_for_status(status: &str) -> Option<&'static str> {
    match status {
        "running" => Some(AUTOMATION_STARTED),
        "succeeded" => Some(AUTOMATION_COMPLETED),
        "failed" => Some(AUTOMATION_FAILED),
        _ => None,
    }
}

/// `failureLine(error, errorClass)`. A class `crew::failure` already knows
/// becomes one sentence. Anything else is the first line of the error, with
/// secrets removed. The automation prompt is never read here.
pub(crate) fn failure_line(error: Option<&str>, error_class: Option<&str>) -> String {
    let class = crate::crew::failure::sanitize_class(error_class);
    if let Some(sentence) = failure_sentence(&class) {
        return sentence.to_string();
    }
    // Scrub the whole error first, so a key that spans a line break cannot
    // leave its header on the line that is kept.
    let scrubbed = crate::portable::scrubber()
        .redact_text(error.unwrap_or(""))
        .0;
    let first = first_line(&scrubbed).trim();
    if first.is_empty() {
        "the run failed".to_string()
    } else {
        crate::activity::bounded_text(first, 240)
    }
}

fn failure_sentence(class: &str) -> Option<&'static str> {
    match class {
        "auth" | "not_authenticated" | "unauthenticated" | "login" | "unauthorized" => {
            Some("the Claude login has expired")
        }
        "usage" | "usage_limit" | "rate_limit" | "ratelimit" | "rate_limited" => {
            Some("the usage limit has been reached")
        }
        "billing" | "billing_or_quota" | "quota" | "credit" | "credits" | "out_of_credits" => {
            Some("the account has a billing problem")
        }
        "missing_cli" | "cli_missing" | "command_not_found" | "sdk_not_installed" => {
            Some("the agent CLI is missing")
        }
        _ => None,
    }
}

fn first_line(text: &str) -> &str {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}', '\u{0085}'])
        .next()
        .unwrap_or("")
}

fn clock_phrase(time: &str) -> Option<String> {
    if !valid_time(time) {
        return None;
    }
    let (hour, minute) = time.split_once(':')?;
    let hour: u8 = hour.parse().ok()?;
    Some(format!("{hour}:{minute}"))
}

/// What started a run, in plain words. Never the prompt.
/// The map uses the same phrases (`src/features/automations/model/mapLayout.ts`).
fn started_by(automation: &Automation, run: &AutomationRun) -> String {
    if run.trigger == "manual" {
        return "you".to_string();
    }
    if run.trigger == "event" {
        return event_cause(automation, run);
    }
    schedule_cause(automation, run)
}

/// The time trigger whose clock is the local time of `scheduled_for`. An hourly
/// trigger matches its minute only when no exact clock does. No match is just
/// "the schedule".
fn schedule_cause(automation: &Automation, run: &AutomationRun) -> String {
    let triggers = automation.triggers.as_deref().unwrap_or(&[]);
    let (hour, minute) = local_clock(run.scheduled_for);
    if let Some(trigger) = triggers.iter().find(|trigger| {
        trigger.kind == "time"
            && trigger.schedule_kind != "hourly"
            && trigger_clock(trigger) == Some((hour, minute))
    }) {
        return match clock_phrase(&trigger.time) {
            Some(clock) => format!("the {clock} schedule"),
            None => "the schedule".to_string(),
        };
    }
    if triggers.iter().any(|trigger| {
        trigger.kind == "time"
            && trigger.schedule_kind == "hourly"
            && trigger.minute == i64::from(minute)
    }) {
        return "the hourly schedule".to_string();
    }
    "the schedule".to_string()
}

fn local_clock(scheduled_for_ms: i64) -> (u8, u8) {
    let secs = scheduled_for_ms.div_euclid(1000);
    let offset = i64::from(crate::work_log::local_offset_seconds(secs));
    let day = (secs + offset).rem_euclid(86_400);
    let hour = u8::try_from(day / 3600).unwrap_or(0);
    let minute = u8::try_from((day % 3600) / 60).unwrap_or(0);
    (hour, minute)
}

fn trigger_clock(trigger: &AutomationTrigger) -> Option<(u8, u8)> {
    if !valid_time(&trigger.time) {
        return None;
    }
    let (hour, minute) = trigger.time.split_once(':')?;
    Some((hour.parse().ok()?, minute.parse().ok()?))
}

fn event_cause(automation: &Automation, run: &AutomationRun) -> String {
    let event = run.event.as_deref().unwrap_or("");
    let noun = match event {
        "issue_opened" | "issue_created" => "a new issue",
        "pull_request_opened" | "pull_request_appeared" | "draft_opened" => "a new pull request",
        "merge_request_opened" => "a new merge request",
        "work_item_appeared" => "a new work item",
        _ => "an event",
    };
    match event_repo(automation, run) {
        Some(repo) => format!("{noun} in {repo}"),
        None => noun.to_string(),
    }
}

fn event_repo(automation: &Automation, run: &AutomationRun) -> Option<String> {
    if let Some(repo) = repo_from_event_key(run.event_key.as_deref().unwrap_or("")) {
        // The key lowercases the repo. The map draws the trigger's spelling.
        return Some(repo_spelling(automation, run, &repo));
    }
    trigger_repo(automation, run)
}

/// The trigger repo for a run whose key names no repo (Linear, Jira). The
/// first non-empty repo, in the same order the map draws them.
fn trigger_repo(automation: &Automation, run: &AutomationRun) -> Option<String> {
    let kind = run.event_kind.as_deref().unwrap_or("");
    let event = run.event.as_deref().unwrap_or("");
    let triggers = automation.triggers.as_ref()?;
    let trigger = triggers
        .iter()
        .find(|trigger| trigger.kind == kind && (event.is_empty() || trigger.event == event))?;
    map_repo_spellings(trigger).into_iter().next()
}

/// `automationEventKey` lowercases the repo and turns every other character
/// into `_`. Use the matching trigger's spelling, which is what the map draws.
/// A repo that is not on that trigger stays as the key wrote it. A different
/// trigger's spelling is not borrowed.
fn repo_spelling(automation: &Automation, run: &AutomationRun, key_repo: &str) -> String {
    let want = event_key_repo_token(key_repo);
    if want.is_empty() {
        return key_repo.to_string();
    }
    let kind = run.event_kind.as_deref().unwrap_or("");
    let event = run.event.as_deref().unwrap_or("");
    let Some(triggers) = automation.triggers.as_ref() else {
        return key_repo.to_string();
    };
    for trigger in triggers {
        if trigger.kind != kind || (!event.is_empty() && trigger.event != event) {
            continue;
        }
        for repo in map_repo_spellings(trigger) {
            if event_key_repo_token(&repo) == want {
                return repo;
            }
        }
    }
    key_repo.to_string()
}

/// `repo` first, then `repos`. The map uses this order and keeps the first spelling.
fn map_repo_spellings(trigger: &AutomationTrigger) -> Vec<String> {
    let mut out = Vec::new();
    for value in
        std::iter::once(trigger.repo.as_str()).chain(trigger.repos.iter().map(String::as_str))
    {
        let repo = value.trim();
        if repo.is_empty() || out.iter().any(|seen| seen == repo) {
            continue;
        }
        out.push(repo.to_string());
    }
    out
}

/// Same folding as `automationEventKey`: lower case, then any character outside
/// the key's set becomes `_`.
fn event_key_repo_token(repo: &str) -> String {
    let mut out = String::new();
    for c in repo.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.' | '/') {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    out
}

/// `github:issue:owner/repo:12`. A key with no `owner/name` has no repo.
fn repo_from_event_key(key: &str) -> Option<String> {
    let parts: Vec<&str> = key.split(':').collect();
    if parts.len() < 4 {
        return None;
    }
    let repo = parts[2..parts.len() - 1].join(":");
    let repo = repo.trim();
    if repo.is_empty() || !repo.contains('/') {
        None
    } else {
        Some(repo.to_string())
    }
}

fn run_activity_summary(
    automation: &Automation,
    run: &AutomationRun,
    error_class: Option<&str>,
) -> String {
    let name = automation.name.trim();
    let name = if name.is_empty() { "Automation" } else { name };
    let cause = started_by(automation, run);
    match run.status.as_str() {
        "running" => format!("{name}. Started by {cause}."),
        "succeeded" => format!("{name}. Finished. Started by {cause}."),
        "failed" => {
            let reason = failure_line(run.error.as_deref(), error_class);
            format!("{name}. Failed: {reason}. Started by {cause}.")
        }
        _ => String::new(),
    }
}

fn activity_line_exists(conn: &Connection, kind: &str, target: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM activity WHERE kind = ?1 AND target = ?2 LIMIT 1",
        [kind, target],
        |_| Ok(true),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(false)
}

/// One line per run and status. A retry, or a line already stored for this
/// run, writes nothing. The prompt is not copied into the line.
fn note_run_activity(
    conn: &Connection,
    automation: &Automation,
    previous_status: &str,
    run: &AutomationRun,
    error_class: Option<&str>,
    now: i64,
) -> bool {
    let Some(kind) = activity_kind_for_status(&run.status) else {
        return false;
    };
    if activity_kind_for_status(previous_status) == Some(kind) {
        return false;
    }
    let target = format!("{}/{}", run.automation_id, run.id);
    if activity_line_exists(conn, kind, &target) {
        return false;
    }
    let summary = run_activity_summary(automation, run, error_class);
    if summary.is_empty() {
        return false;
    }
    let link = run
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| format!("session:{id}"))
        .unwrap_or_default();
    crate::activity::note(
        conn,
        kind,
        &crate::activity::Who::app(),
        &crate::activity::Who::app(),
        automation.cwd.trim(),
        &target,
        &summary,
        &link,
        now,
    );
    activity_line_exists(conn, kind, &target)
}

/// The body of `automation_run_update`, without the app handle, so a test can
/// drive it. A retried status writes no second activity line.
#[allow(clippy::too_many_arguments)]
fn update_stored_run(
    conn: &mut Connection,
    run_id: &str,
    status: &str,
    session_id: Option<String>,
    error: Option<String>,
    error_class: Option<&str>,
    now: i64,
) -> Result<StoredRunUpdate, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let raw = tx
        .query_row(
            "SELECT run_json FROM automation_runs WHERE id = ?1",
            [run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Automation run not found.".to_string())?;
    let mut run: AutomationRun = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let next =
        RunStatus::parse(status).ok_or_else(|| "Invalid automation run status.".to_string())?;
    // A stored status this build doesn't know is left alone, as an ended one is.
    let movable = RunStatus::parse(&run.status).is_some_and(|current| current.can_move_to(next));
    if !movable {
        return Ok(StoredRunUpdate { run, noted: false });
    }
    let previous_status = run.status.clone();
    run.status = status.to_string();
    if next == RunStatus::Running && run.started_at.is_none() {
        run.started_at = Some(now);
    }
    if next.is_final() {
        run.completed_at = Some(now);
    }
    if session_id.is_some() {
        run.session_id = session_id;
    }
    run.error = error.filter(|value| !value.trim().is_empty());
    let mut automation =
        get(&tx, &run.automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    apply_run_summary(&mut automation, &run);
    write_run(&tx, &run)?;
    write_automation(&tx, &automation)?;
    // WP-180a: one activity line when a run starts, finishes or fails.
    let noted = note_run_activity(&tx, &automation, &previous_status, &run, error_class, now);
    trim_history(&tx, &run.automation_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(StoredRunUpdate { run, noted })
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn automation_run_update(
    app: AppHandle,
    store: State<'_, SessionStore>,
    run_id: String,
    status: String,
    session_id: Option<String>,
    error: Option<String>,
    error_class: Option<String>,
    now: i64,
) -> Result<AutomationRun, String> {
    validate_id(&run_id, "automation run")?;
    if let Some(session_id) = session_id.as_deref() {
        validate_id(session_id, "session")?;
    }
    if RunStatus::parse(&status).is_none() {
        return Err("Invalid automation run status.".into());
    }
    let mut conn = store.lock_conn()?;
    let updated = update_stored_run(
        &mut conn,
        &run_id,
        &status,
        session_id,
        error,
        error_class.as_deref(),
        now,
    )?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    // WP-180a: the runs screen hears the activity log's own event.
    if updated.noted {
        let _ = app.emit(crate::activity::CHANGED, ());
    }
    Ok(updated.run)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_time_fields() {
        assert!(valid_time("09:30"));
        assert!(valid_time("23:59"));
        assert!(!valid_time("24:00"));
        assert!(!valid_time("9:30"));
    }

    #[test]
    fn existing_automations_default_to_time_triggers() {
        let automation = Automation {
            id: "automation-id".into(),
            name: "Audit".into(),
            prompt: "Review the repository".into(),
            harness: "codex".into(),
            model: "model".into(),
            model_settings: HashMap::new(),
            cwd: "/tmp".into(),
            workspace_mode: "worktree".into(),
            worktree_cwd: String::new(),
            session_folder_id: String::new(),
            reuse_session: false,
            runtime_mode: "auto".into(),
            trigger_kind: "github".into(),
            trigger_event: "pull_request_opened".into(),
            schedule_kind: "weekdays".into(),
            minute: 0,
            time: "09:00".into(),
            day_of_week: 1,
            triggers: None,
            missed_run_grace_minutes: 720,
            enabled: true,
            next_run_at: 1,
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            last_session_id: None,
            created_at: 1,
            updated_at: 1,
        };
        let mut stored = serde_json::to_value(automation).unwrap();
        stored
            .as_object_mut()
            .unwrap()
            .remove("triggerKind")
            .unwrap();
        stored
            .as_object_mut()
            .unwrap()
            .remove("triggerEvent")
            .unwrap();

        let restored: Automation = serde_json::from_value(stored).unwrap();
        assert_eq!(restored.trigger_kind, "time");
        assert!(restored.trigger_event.is_empty());
    }

    #[test]
    fn missing_triggers_hydrate_from_legacy_fields() {
        let automation = Automation {
            id: "automation-id".into(),
            name: "Audit".into(),
            prompt: "Review the repository".into(),
            harness: "codex".into(),
            model: "model".into(),
            model_settings: HashMap::new(),
            cwd: "/tmp".into(),
            workspace_mode: "worktree".into(),
            worktree_cwd: String::new(),
            session_folder_id: String::new(),
            reuse_session: false,
            runtime_mode: "auto".into(),
            trigger_kind: "gitlab".into(),
            trigger_event: "merge_request_opened".into(),
            schedule_kind: "weekdays".into(),
            minute: 0,
            time: "09:00".into(),
            day_of_week: 1,
            triggers: None,
            missed_run_grace_minutes: 720,
            enabled: true,
            next_run_at: 1,
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            last_session_id: None,
            created_at: 1,
            updated_at: 1,
        };
        let mut stored = serde_json::to_value(&automation).unwrap();
        stored.as_object_mut().unwrap().remove("triggers");
        let mut restored: Automation = serde_json::from_value(stored).unwrap();
        assert!(restored.triggers.is_none());
        hydrate_triggers(&mut restored);
        let triggers = restored.triggers.as_ref().unwrap();
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].kind, "gitlab");
        assert_eq!(triggers[0].event, "merge_request_opened");
    }

    #[test]
    fn empty_triggers_stay_empty() {
        let mut restored: Automation = serde_json::from_value(serde_json::json!({
            "id": "automation-id",
            "name": "Audit",
            "prompt": "Review the repository",
            "harness": "codex",
            "model": "model",
            "cwd": "/tmp",
            "workspaceMode": "worktree",
            "reuseSession": false,
            "runtimeMode": "auto",
            "triggerKind": "time",
            "triggerEvent": "",
            "scheduleKind": "weekdays",
            "minute": 0,
            "time": "09:00",
            "dayOfWeek": 1,
            "triggers": [],
            "missedRunGraceMinutes": 720,
            "enabled": true,
            "nextRunAt": 1,
            "createdAt": 1,
            "updatedAt": 1
        }))
        .unwrap();
        hydrate_triggers(&mut restored);
        assert!(restored.triggers.as_ref().unwrap().is_empty());
    }

    #[test]
    fn trims_run_history_to_the_configured_limit() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at)
             VALUES ('automation-id', '{}', 1, 1, 1)",
            [],
        )
        .unwrap();
        for index in 0..=MAX_RUNS_PER_AUTOMATION {
            let run = AutomationRun {
                id: format!("run-{index}"),
                automation_id: "automation-id".into(),
                trigger: "manual".into(),
                scheduled_for: index,
                created_at: index,
                started_at: None,
                completed_at: Some(index),
                status: "succeeded".into(),
                session_id: None,
                error: None,
                event_key: None,
                event_kind: None,
                event: None,
                prompt: Some("Run the automation".into()),
            };
            write_run(&conn, &run).unwrap();
        }

        trim_history(&conn, "automation-id").unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automation_runs WHERE automation_id = 'automation-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, MAX_RUNS_PER_AUTOMATION);
    }

    #[test]
    fn trim_history_preserves_nonterminal_runs() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at)
             VALUES ('automation-id', '{}', 1, 1, 1)",
            [],
        )
        .unwrap();
        for index in 0..=MAX_RUNS_PER_AUTOMATION {
            let run = AutomationRun {
                id: format!("run-{index}"),
                automation_id: "automation-id".into(),
                trigger: "manual".into(),
                scheduled_for: index,
                created_at: index,
                started_at: None,
                completed_at: None,
                status: "pending".into(),
                session_id: None,
                error: None,
                event_key: None,
                event_kind: None,
                event: None,
                prompt: Some("Run the automation".into()),
            };
            write_run(&conn, &run).unwrap();
        }

        trim_history(&conn, "automation-id").unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automation_runs WHERE automation_id = 'automation-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, MAX_RUNS_PER_AUTOMATION + 1);
    }

    #[test]
    fn accepts_inbox_event_keys() {
        assert!(validate_event_key("github:pr:acme/web:12").is_ok());
        assert!(validate_event_key("linear:issue:eng-12").is_ok());
        assert!(validate_event_key("jira:issue:10042").is_ok());
        assert!(validate_event_key("azuredevops:pr:acme/web:12").is_ok());
        assert!(validate_event_key("").is_err());
        assert!(validate_event_key("github:pr:acme web:12").is_err());
    }

    #[test]
    fn accepts_jira_triggers() {
        let trigger = trigger_from_fields(
            "jira-trigger",
            "jira",
            "issue_created",
            "weekdays",
            0,
            "09:00",
            1,
        );
        assert!(validate_trigger(&trigger).is_ok());
    }

    #[test]
    fn accepts_azure_devops_triggers() {
        let trigger = trigger_from_fields(
            "trigger-id",
            "azuredevops",
            "pull_request_appeared",
            "weekdays",
            0,
            "09:00",
            1,
        );
        assert!(validate_trigger(&trigger).is_ok());
    }

    #[test]
    fn claims_each_event_key_once() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at)
             VALUES ('automation-id', '{}', 1, 1, 1)",
            [],
        )
        .unwrap();
        let claim = || {
            conn.execute(
                "INSERT OR IGNORE INTO automation_event_claims
                 (automation_id, event_key, created_at) VALUES (?1, ?2, ?3)",
                params!["automation-id", "github:pr:acme/web:12", 1],
            )
            .unwrap()
        };

        assert_eq!(claim(), 1);
        assert_eq!(claim(), 0);
    }

    struct ActivitySeen {
        kind: String,
        summary: String,
        link: String,
        target: String,
    }

    fn stored_automation(id: &str, name: &str, prompt: &str) -> Automation {
        Automation {
            id: id.into(),
            name: name.into(),
            prompt: prompt.into(),
            harness: "claude".into(),
            model: "model".into(),
            model_settings: HashMap::new(),
            cwd: "/work/project".into(),
            workspace_mode: "current".into(),
            worktree_cwd: String::new(),
            session_folder_id: String::new(),
            reuse_session: false,
            runtime_mode: "auto".into(),
            trigger_kind: "time".into(),
            trigger_event: String::new(),
            schedule_kind: "weekdays".into(),
            minute: 0,
            time: "09:00".into(),
            day_of_week: 1,
            triggers: None,
            missed_run_grace_minutes: 720,
            enabled: true,
            next_run_at: 1,
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            last_session_id: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn stored_run(id: &str, automation_id: &str) -> AutomationRun {
        AutomationRun {
            id: id.into(),
            automation_id: automation_id.into(),
            trigger: "scheduled".into(),
            scheduled_for: at_local_clock(9, 0),
            created_at: 1,
            started_at: None,
            completed_at: None,
            status: "pending".into(),
            session_id: None,
            error: None,
            event_key: None,
            event_kind: None,
            event: None,
            prompt: Some("PROMPT_SHOULD_NOT_LEAK".into()),
        }
    }

    fn activity_rows(conn: &Connection) -> Vec<ActivitySeen> {
        let mut statement = conn
            .prepare("SELECT kind, summary, link, target FROM activity ORDER BY seq ASC")
            .unwrap();
        statement
            .query_map([], |row| {
                Ok(ActivitySeen {
                    kind: row.get(0)?,
                    summary: row.get(1)?,
                    link: row.get(2)?,
                    target: row.get(3)?,
                })
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    fn stored_status(conn: &Connection, run_id: &str) -> String {
        let raw: String = conn
            .query_row(
                "SELECT run_json FROM automation_runs WHERE id = ?1",
                [run_id],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str::<AutomationRun>(&raw).unwrap().status
    }

    /// An ended run stays as it ended, and a run never goes back to pending. Before the status moves were explicit, a
    /// late settle overwrote a cancelled run with succeeded, and a launch error caught after the turn settled turned a
    /// succeeded run into failed.
    #[test]
    fn an_ended_run_keeps_its_end() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let automation = stored_automation("nightly", "Nightly", "prompt");
        write_automation(&conn, &automation).unwrap();
        let update = |conn: &mut Connection, id: &str, status: &str| {
            update_stored_run(conn, id, status, None, None, None, 1_700_000_000_000).unwrap()
        };

        write_run(&conn, &stored_run("run-cancelled", "nightly")).unwrap();
        update(&mut conn, "run-cancelled", "running");
        update(&mut conn, "run-cancelled", "cancelled");
        let late = update(&mut conn, "run-cancelled", "succeeded");
        assert_eq!(late.run.status, "cancelled");
        assert!(!late.noted);
        assert_eq!(stored_status(&conn, "run-cancelled"), "cancelled");

        write_run(&conn, &stored_run("run-succeeded", "nightly")).unwrap();
        update(&mut conn, "run-succeeded", "running");
        update(&mut conn, "run-succeeded", "succeeded");
        update(&mut conn, "run-succeeded", "failed");
        assert_eq!(stored_status(&conn, "run-succeeded"), "succeeded");

        write_run(&conn, &stored_run("run-back", "nightly")).unwrap();
        update(&mut conn, "run-back", "running");
        update(&mut conn, "run-back", "pending");
        assert_eq!(stored_status(&conn, "run-back"), "running");

        // A run may end straight from pending (a launch that failed before its turn), and a repeat is still allowed.
        write_run(&conn, &stored_run("run-early", "nightly")).unwrap();
        update(&mut conn, "run-early", "failed");
        update(&mut conn, "run-early", "failed");
        assert_eq!(stored_status(&conn, "run-early"), "failed");

        assert!(update_stored_run(&mut conn, "run-early", "done", None, None, None, 1).is_err());
    }

    #[test]
    fn run_status_moves() {
        use RunStatus::*;
        let all = [Pending, Running, Succeeded, Failed, Skipped, Cancelled];
        for from in all {
            for to in all {
                let expected = from == to || from == Pending || (from == Running && to != Pending);
                assert_eq!(from.can_move_to(to), expected, "{from:?} -> {to:?}");
            }
        }
        assert!(!is_final_status("running"));
        assert!(is_final_status("skipped"));
        assert!(!is_final_status("from-a-newer-build"));
    }

    /// A finished run and a failed run each write one activity line. Repeating
    /// the same `automation_run_update` writes no second line. Today, before the
    /// hook, both updates write nothing.
    #[test]
    fn finished_and_failed_runs_write_one_activity_line() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let automation =
            stored_automation("morning-audit", "Morning audit", "PROMPT_SHOULD_NOT_LEAK");
        write_automation(&conn, &automation).unwrap();
        write_run(&conn, &stored_run("run-finished", "morning-audit")).unwrap();
        let secret = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
        update_stored_run(
            &mut conn,
            "run-finished",
            "succeeded",
            Some("session-1".into()),
            None,
            None,
            1_700_000_000_000,
        )
        .unwrap();
        update_stored_run(
            &mut conn,
            "run-finished",
            "succeeded",
            Some("session-1".into()),
            None,
            None,
            1_700_000_000_001,
        )
        .unwrap();
        write_run(&conn, &stored_run("run-failed", "morning-audit")).unwrap();
        update_stored_run(
            &mut conn,
            "run-failed",
            "failed",
            None,
            Some(format!("login failed\n{secret}")),
            Some("not_authenticated"),
            1_700_000_000_002,
        )
        .unwrap();
        update_stored_run(
            &mut conn,
            "run-failed",
            "failed",
            None,
            Some(format!("login failed again\n{secret}")),
            Some("not_authenticated"),
            1_700_000_000_003,
        )
        .unwrap();

        let rows = activity_rows(&conn);
        assert_eq!(
            rows.len(),
            2,
            "a finished run and a failed run write one line each, and a retry writes no second"
        );
        let finished = rows
            .iter()
            .find(|row| row.kind == "automation.completed")
            .expect("finished line");
        assert!(finished.summary.contains("Morning audit"));
        assert!(finished.summary.contains("Finished"));
        assert!(finished.summary.contains("the 9:00 schedule"));
        assert!(!finished.summary.contains("PROMPT_SHOULD_NOT_LEAK"));
        assert_eq!(finished.link, "session:session-1");
        assert_eq!(finished.target, "morning-audit/run-finished");
        let failed = rows
            .iter()
            .find(|row| row.kind == "automation.failed")
            .expect("failed line");
        assert!(failed.summary.contains("Morning audit"));
        assert!(failed
            .summary
            .contains("Failed: the Claude login has expired"));
        assert!(failed.summary.contains("the 9:00 schedule"));
        assert!(!failed.summary.contains("PROMPT_SHOULD_NOT_LEAK"));
        assert!(!failed.summary.contains(secret));
        assert!(!failed.summary.contains("sk-ant-"));
        assert_eq!(failed.target, "morning-audit/run-failed");
    }

    #[test]
    fn failure_line_maps_known_classes_and_scrubs_an_unknown_error() {
        let secret = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
        for class in [
            "auth",
            "not_authenticated",
            "Not_Authenticated",
            "unauthenticated",
            "login",
            "unauthorized",
        ] {
            let line = failure_line(Some(&format!("nope\n{secret}")), Some(class));
            assert_eq!(line, "the Claude login has expired", "{class}");
            assert!(!line.contains(secret));
        }
        for class in [
            "usage",
            "usage_limit",
            "rate_limit",
            "ratelimit",
            "rate_limited",
        ] {
            assert_eq!(
                failure_line(Some("nope"), Some(class)),
                "the usage limit has been reached",
                "{class}"
            );
        }
        for class in [
            "billing",
            "billing_or_quota",
            "quota",
            "credit",
            "credits",
            "out_of_credits",
        ] {
            assert_eq!(
                failure_line(Some("nope"), Some(class)),
                "the account has a billing problem",
                "{class}"
            );
        }
        for class in [
            "missing_cli",
            "cli_missing",
            "command_not_found",
            "sdk_not_installed",
        ] {
            assert_eq!(
                failure_line(Some("nope"), Some(class)),
                "the agent CLI is missing",
                "{class}"
            );
        }

        let first = failure_line(Some(&format!("disk full\r\n{secret}")), Some("other"));
        assert_eq!(first, "disk full");
        assert!(!first.contains(secret));
        assert!(!first.contains("sk-ant-"));

        let scrubbed = failure_line(Some(&format!("broke {secret} badly")), None);
        assert!(scrubbed.contains("[secret removed]"));
        assert!(!scrubbed.contains(secret));
        assert!(!scrubbed.contains("sk-ant-"));

        let second_line = failure_line(Some(&format!("ok\n{secret}")), None);
        assert_eq!(second_line, "ok");
        assert!(!second_line.contains("sk-ant-"));

        assert_eq!(failure_line(Some(""), None), "the run failed");
        assert_eq!(failure_line(None, None), "the run failed");
        assert_eq!(
            failure_line(Some("\nsecret on the next line"), None),
            "the run failed"
        );
    }

    fn open_run(id: &str) -> (crate::session_store::SessionStore, Automation) {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let automation = stored_automation(id, "Morning audit", "PROMPT_SHOULD_NOT_LEAK");
        {
            let conn = store.lock_conn().unwrap();
            write_automation(&conn, &automation).unwrap();
        }
        (store, automation)
    }

    fn finish(
        conn: &mut Connection,
        run_id: &str,
        status: &str,
        error: Option<String>,
        error_class: Option<&str>,
    ) {
        update_stored_run(
            conn,
            run_id,
            status,
            None,
            error,
            error_class,
            1_700_000_000_000,
        )
        .unwrap();
    }

    #[test]
    fn a_started_run_writes_one_line_and_a_retry_does_not() {
        let (store, _) = open_run("morning-audit");
        let mut conn = store.lock_conn().unwrap();
        write_run(&conn, &stored_run("run-start", "morning-audit")).unwrap();
        finish(&mut conn, "run-start", "running", None, None);
        finish(&mut conn, "run-start", "running", None, None);
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "automation.started");
        assert!(rows[0].summary.contains("Morning audit"));
        assert!(rows[0].summary.contains("Started by the 9:00 schedule"));
        assert!(!rows[0].summary.contains("PROMPT_SHOULD_NOT_LEAK"));
        assert_eq!(rows[0].target, "morning-audit/run-start");
    }

    #[test]
    fn starting_then_finishing_writes_two_lines_and_neither_twice() {
        let (store, _) = open_run("morning-audit");
        let mut conn = store.lock_conn().unwrap();
        write_run(&conn, &stored_run("run-both", "morning-audit")).unwrap();
        finish(&mut conn, "run-both", "running", None, None);
        finish(&mut conn, "run-both", "running", None, None);
        finish(&mut conn, "run-both", "succeeded", None, None);
        finish(&mut conn, "run-both", "succeeded", None, None);
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, "automation.started");
        assert_eq!(rows[1].kind, "automation.completed");
    }

    #[test]
    fn skipped_cancelled_and_pending_write_nothing() {
        let (store, _) = open_run("morning-audit");
        let mut conn = store.lock_conn().unwrap();
        for (id, status) in [
            ("run-skip", "skipped"),
            ("run-cancel", "cancelled"),
            ("run-wait", "pending"),
        ] {
            write_run(&conn, &stored_run(id, "morning-audit")).unwrap();
            finish(&mut conn, id, status, None, None);
            finish(&mut conn, id, status, None, None);
        }
        assert!(activity_rows(&conn).is_empty());
    }

    #[test]
    fn a_line_already_stored_for_the_run_is_not_repeated() {
        let (store, _) = open_run("morning-audit");
        let mut conn = store.lock_conn().unwrap();
        write_run(&conn, &stored_run("run-finished", "morning-audit")).unwrap();
        crate::activity::record(
            &conn,
            "automation.completed",
            &crate::activity::Who::app(),
            &crate::activity::Who::app(),
            "/work/project",
            "morning-audit/run-finished",
            "Morning audit. Finished. Started by the 9:00 schedule.",
            "",
            1_700_000_000_000,
        )
        .unwrap();
        finish(&mut conn, "run-finished", "succeeded", None, None);
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "automation.completed");
    }

    #[test]
    fn a_manual_run_says_you_started_it() {
        let (store, _) = open_run("morning-audit");
        let mut conn = store.lock_conn().unwrap();
        let mut run = stored_run("run-hand", "morning-audit");
        run.trigger = "manual".into();
        write_run(&conn, &run).unwrap();
        finish(&mut conn, "run-hand", "running", None, None);
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].summary.contains("Started by you."));
        assert!(!rows[0].summary.contains("PROMPT_SHOULD_NOT_LEAK"));
    }

    #[test]
    fn an_hourly_schedule_and_a_blank_name_stay_plain() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let mut automation = stored_automation("hourly", "   ", "PROMPT_SHOULD_NOT_LEAK");
        automation.schedule_kind = "hourly".into();
        let mut conn = store.lock_conn().unwrap();
        write_automation(&conn, &automation).unwrap();
        write_run(&conn, &stored_run("run-hour", "hourly")).unwrap();
        finish(&mut conn, "run-hour", "running", None, None);
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].summary.starts_with("Automation."));
        assert!(rows[0].summary.contains("the hourly schedule"));
        assert!(!rows[0].summary.contains("PROMPT_SHOULD_NOT_LEAK"));
    }

    #[test]
    fn an_event_run_names_the_change_and_the_repo() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let mut automation = stored_automation("inbox", "Inbox watch", "PROMPT_SHOULD_NOT_LEAK");
        automation.triggers = Some(vec![
            AutomationTrigger {
                id: "issues".into(),
                kind: "github".into(),
                event: "issue_opened".into(),
                schedule_kind: "weekdays".into(),
                minute: 0,
                time: "09:00".into(),
                day_of_week: 1,
                repos: vec!["owner/repo".into()],
                repo: String::new(),
                branch: String::new(),
                actor: "app".into(),
            },
            AutomationTrigger {
                id: "mrs".into(),
                kind: "gitlab".into(),
                event: "merge_request_opened".into(),
                schedule_kind: "weekdays".into(),
                minute: 0,
                time: "09:00".into(),
                day_of_week: 1,
                repos: Vec::new(),
                repo: "group/project".into(),
                branch: String::new(),
                actor: "app".into(),
            },
        ]);
        let mut conn = store.lock_conn().unwrap();
        write_automation(&conn, &automation).unwrap();

        let mut issue = stored_run("run-issue", "inbox");
        issue.trigger = "event".into();
        issue.event_kind = Some("github".into());
        issue.event = Some("issue_opened".into());
        issue.event_key = Some("github:issue:owner/repo:12".into());
        write_run(&conn, &issue).unwrap();

        let mut request = stored_run("run-mr", "inbox");
        request.trigger = "event".into();
        request.event_kind = Some("gitlab".into());
        request.event = Some("merge_request_opened".into());
        request.event_key = Some("gitlab:pr:group/project:4".into());
        write_run(&conn, &request).unwrap();

        let mut linear = stored_run("run-linear", "inbox");
        linear.trigger = "event".into();
        linear.event_kind = Some("linear".into());
        linear.event = Some("issue_created".into());
        linear.event_key = Some("linear:issue:abc".into());
        write_run(&conn, &linear).unwrap();

        finish(&mut conn, "run-issue", "running", None, None);
        finish(&mut conn, "run-mr", "running", None, None);
        finish(&mut conn, "run-linear", "running", None, None);
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 3);
        assert!(rows[0].summary.contains("a new issue in owner/repo"));
        assert!(rows[1]
            .summary
            .contains("a new merge request in group/project"));
        assert!(rows[2].summary.contains("a new issue"));
        assert!(!rows[2].summary.contains(" in "));
        for row in &rows {
            assert!(!row.summary.contains("PROMPT_SHOULD_NOT_LEAK"));
        }
    }

    #[test]
    fn a_secret_in_the_name_or_the_error_does_not_reach_the_line() {
        let secret = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let automation = stored_automation(
            "leaky",
            &format!("Audit {secret}"),
            "PROMPT_SHOULD_NOT_LEAK",
        );
        let mut conn = store.lock_conn().unwrap();
        write_automation(&conn, &automation).unwrap();
        write_run(&conn, &stored_run("run-name", "leaky")).unwrap();
        finish(&mut conn, "run-name", "succeeded", None, None);

        write_run(&conn, &stored_run("run-error", "leaky")).unwrap();
        finish(
            &mut conn,
            "run-error",
            "failed",
            Some(format!("{secret} on the first line\nmore {secret}")),
            None,
        );
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 2);
        for row in &rows {
            assert!(!row.summary.contains(secret), "{}", row.summary);
            assert!(!row.summary.contains("sk-ant-"), "{}", row.summary);
            assert!(row.summary.contains("[secret removed]"));
            assert!(!row.summary.contains("PROMPT_SHOULD_NOT_LEAK"));
            assert!(!row.summary.contains("more "));
        }
    }

    /// Local millis for a clock on 15 Jan 2024. The offset is read twice so a
    /// daylight boundary does not land on the wrong hour.
    fn at_local_clock(hour: u8, minute: u8) -> i64 {
        use time::{Date, Month, PrimitiveDateTime, Time};
        let date = Date::from_calendar_date(2024, Month::January, 15).expect("date");
        let clock = Time::from_hms(hour, minute, 0).expect("clock");
        let naive = PrimitiveDateTime::new(date, clock)
            .assume_utc()
            .unix_timestamp();
        for shift in [0_i64, -3600, 3600, -7200, 7200] {
            let offset = i64::from(crate::work_log::local_offset_seconds(naive + shift));
            let utc = naive - offset;
            if i64::from(crate::work_log::local_offset_seconds(utc)) != offset {
                continue;
            }
            let day_seconds = (utc + offset).rem_euclid(86_400);
            if day_seconds / 3600 == i64::from(hour)
                && (day_seconds % 3600) / 60 == i64::from(minute)
            {
                return utc * 1000;
            }
        }
        panic!("no local instant for {hour:02}:{minute:02}");
    }

    fn time_trigger(id: &str, time: &str) -> AutomationTrigger {
        AutomationTrigger {
            id: id.into(),
            kind: "time".into(),
            event: "weekdays".into(),
            schedule_kind: "weekdays".into(),
            minute: 0,
            time: time.into(),
            day_of_week: 1,
            repos: Vec::new(),
            repo: String::new(),
            branch: String::new(),
            actor: "app".into(),
        }
    }

    fn event_trigger(
        id: &str,
        kind: &str,
        event: &str,
        repo: &str,
        repos: &[&str],
    ) -> AutomationTrigger {
        AutomationTrigger {
            id: id.into(),
            kind: kind.into(),
            event: event.into(),
            schedule_kind: "weekdays".into(),
            minute: 0,
            time: "09:00".into(),
            day_of_week: 1,
            repos: repos.iter().map(|repo| (*repo).to_string()).collect(),
            repo: repo.into(),
            branch: String::new(),
            actor: "app".into(),
        }
    }

    /// Two repos on one GitHub trigger: the line names the repo in the event
    /// key, not the first repo on the trigger. Linear and Jira keys have no
    /// repo, so those lines keep the trigger repo.
    #[test]
    fn an_event_run_names_the_repo_in_the_key() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let mut automation = stored_automation("inbox", "Inbox watch", "PROMPT_SHOULD_NOT_LEAK");
        automation.triggers = Some(vec![
            event_trigger(
                "issues",
                "github",
                "issue_opened",
                "",
                &["acme/web", "acme/api"],
            ),
            event_trigger("linear", "linear", "issue_created", "team/board", &[]),
            event_trigger("jira", "jira", "issue_created", "jira-project", &[]),
        ]);
        let mut conn = store.lock_conn().unwrap();
        write_automation(&conn, &automation).unwrap();

        let mut issue = stored_run("run-api", "inbox");
        issue.trigger = "event".into();
        issue.event_kind = Some("github".into());
        issue.event = Some("issue_opened".into());
        issue.event_key = Some("github:issue:acme/api:12".into());
        write_run(&conn, &issue).unwrap();

        let mut linear = stored_run("run-linear", "inbox");
        linear.trigger = "event".into();
        linear.event_kind = Some("linear".into());
        linear.event = Some("issue_created".into());
        linear.event_key = Some("linear:issue:abc".into());
        write_run(&conn, &linear).unwrap();

        let mut jira = stored_run("run-jira", "inbox");
        jira.trigger = "event".into();
        jira.event_kind = Some("jira".into());
        jira.event = Some("issue_created".into());
        jira.event_key = Some("jira:issue:abc-1".into());
        write_run(&conn, &jira).unwrap();

        finish(&mut conn, "run-api", "running", None, None);
        finish(&mut conn, "run-linear", "running", None, None);
        finish(&mut conn, "run-jira", "running", None, None);
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 3);
        assert!(
            rows[0].summary.contains("a new issue in acme/api"),
            "{}",
            rows[0].summary
        );
        assert!(!rows[0].summary.contains("acme/web"), "{}", rows[0].summary);
        assert!(rows[1].summary.contains("a new issue in team/board"));
        assert!(rows[2].summary.contains("a new issue in jira-project"));
        for row in &rows {
            assert!(!row.summary.contains("PROMPT_SHOULD_NOT_LEAK"));
        }
    }

    /// The event key lowercases the repo and turns a space into `_`. The line
    /// uses the spelling the map draws from the trigger, and does not borrow a
    /// spelling from a different trigger.
    #[test]
    fn an_event_run_keeps_the_map_repo_spelling() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let mut automation = stored_automation("inbox", "Inbox watch", "PROMPT_SHOULD_NOT_LEAK");
        automation.triggers = Some(vec![
            event_trigger(
                "issues",
                "github",
                "issue_opened",
                "Acme/API",
                &["acme/api"],
            ),
            event_trigger(
                "spaced",
                "github",
                "pull_request_opened",
                "",
                &["Acme/Web App"],
            ),
            event_trigger(
                "other-kind",
                "gitlab",
                "merge_request_opened",
                "Other/Repo",
                &[],
            ),
        ]);
        let mut conn = store.lock_conn().unwrap();
        write_automation(&conn, &automation).unwrap();

        let mut issue = stored_run("run-api", "inbox");
        issue.trigger = "event".into();
        issue.event_kind = Some("github".into());
        issue.event = Some("issue_opened".into());
        issue.event_key = Some("github:issue:acme/api:12".into());
        write_run(&conn, &issue).unwrap();

        let mut request = stored_run("run-pr", "inbox");
        request.trigger = "event".into();
        request.event_kind = Some("github".into());
        request.event = Some("pull_request_opened".into());
        request.event_key = Some("github:pr:acme/web_app:9".into());
        write_run(&conn, &request).unwrap();

        let mut unmatched = stored_run("run-other", "inbox");
        unmatched.trigger = "event".into();
        unmatched.event_kind = Some("github".into());
        unmatched.event = Some("issue_opened".into());
        unmatched.event_key = Some("github:issue:other/repo:1".into());
        write_run(&conn, &unmatched).unwrap();

        finish(&mut conn, "run-api", "running", None, None);
        finish(&mut conn, "run-pr", "running", None, None);
        finish(&mut conn, "run-other", "running", None, None);
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 3);
        assert!(
            rows[0].summary.contains("a new issue in Acme/API"),
            "{}",
            rows[0].summary
        );
        assert!(!rows[0].summary.contains("acme/api"), "{}", rows[0].summary);
        assert!(
            rows[1]
                .summary
                .contains("a new pull request in Acme/Web App"),
            "{}",
            rows[1].summary
        );
        assert!(
            !rows[1].summary.contains("acme/web_app"),
            "{}",
            rows[1].summary
        );
        assert!(
            rows[2].summary.contains("a new issue in other/repo"),
            "{}",
            rows[2].summary
        );
        assert!(
            !rows[2].summary.contains("Other/Repo"),
            "{}",
            rows[2].summary
        );
        for row in &rows {
            assert!(!row.summary.contains("PROMPT_SHOULD_NOT_LEAK"));
        }
    }

    /// Two clocks: the line names the one whose time matches `scheduled_for`.
    /// A time that matches neither clock says "the schedule".
    #[test]
    fn a_schedule_run_names_the_clock_that_fired() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let mut automation = stored_automation("bells", "Bells", "PROMPT_SHOULD_NOT_LEAK");
        automation.triggers = Some(vec![
            time_trigger("nine", "09:00"),
            time_trigger("six", "18:00"),
        ]);
        let mut conn = store.lock_conn().unwrap();
        write_automation(&conn, &automation).unwrap();

        let mut morning = stored_run("run-nine", "bells");
        morning.scheduled_for = at_local_clock(9, 0);
        write_run(&conn, &morning).unwrap();
        let mut evening = stored_run("run-six", "bells");
        evening.scheduled_for = at_local_clock(18, 0);
        write_run(&conn, &evening).unwrap();
        let mut noon = stored_run("run-noon", "bells");
        noon.scheduled_for = at_local_clock(12, 30);
        write_run(&conn, &noon).unwrap();

        finish(&mut conn, "run-nine", "running", None, None);
        finish(&mut conn, "run-six", "running", None, None);
        finish(&mut conn, "run-noon", "running", None, None);
        let rows = activity_rows(&conn);
        assert_eq!(rows.len(), 3);
        assert!(
            rows[0].summary.contains("the 9:00 schedule"),
            "{}",
            rows[0].summary
        );
        assert!(!rows[0].summary.contains("18:00"), "{}", rows[0].summary);
        assert!(
            rows[1].summary.contains("the 18:00 schedule"),
            "{}",
            rows[1].summary
        );
        assert!(!rows[1].summary.contains("9:00"), "{}", rows[1].summary);
        assert!(
            rows[2].summary.contains("the schedule"),
            "{}",
            rows[2].summary
        );
        assert!(!rows[2].summary.contains("9:00"), "{}", rows[2].summary);
        assert!(!rows[2].summary.contains("18:00"), "{}", rows[2].summary);
        for row in &rows {
            assert!(!row.summary.contains("PROMPT_SHOULD_NOT_LEAK"));
        }
    }

    /// A pending event run whose prompt is empty fails on restart and writes
    /// one failed line. A running run that is cancelled writes nothing new.
    #[test]
    fn a_restarted_event_run_with_no_prompt_writes_a_failed_line() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let automation = stored_automation("inbox", "Inbox watch", "PROMPT_SHOULD_NOT_LEAK");
        let mut conn = store.lock_conn().unwrap();
        write_automation(&conn, &automation).unwrap();

        let mut pending = stored_run("run-empty", "inbox");
        pending.trigger = "event".into();
        pending.event_kind = Some("github".into());
        pending.event = Some("issue_opened".into());
        pending.event_key = Some("github:issue:acme/api:12".into());
        pending.prompt = Some(String::new());
        pending.created_at = 10;
        write_run(&conn, &pending).unwrap();

        let mut running = stored_run("run-cut", "inbox");
        running.status = "running".into();
        running.created_at = 11;
        write_run(&conn, &running).unwrap();

        let recovered = recover_stored_runs(&mut conn, 100, 1_700_000_000_000).unwrap();
        assert!(recovered.due.is_empty());
        recover_stored_runs(&mut conn, 100, 1_700_000_000_001).unwrap();

        let raw: String = conn
            .query_row(
                "SELECT run_json FROM automation_runs WHERE id = ?1",
                ["run-empty"],
                |row| row.get(0),
            )
            .unwrap();
        let stored: AutomationRun = serde_json::from_str(&raw).unwrap();
        assert_eq!(stored.status, "failed");

        let rows = activity_rows(&conn);
        assert_eq!(
            rows.len(),
            1,
            "the restart writes one line and a repeat writes no second"
        );
        assert_eq!(rows[0].kind, "automation.failed");
        assert!(rows[0]
            .summary
            .contains("The Inbox event prompt was not available after restart."));
        assert!(!rows[0].summary.contains("PROMPT_SHOULD_NOT_LEAK"));
        assert_eq!(rows[0].target, "inbox/run-empty");
    }

    #[test]
    fn failure_line_stops_at_a_unicode_break_and_scrubs_a_whole_key() {
        let line = failure_line(Some("disk full\u{2028}not a token but private"), None);
        assert_eq!(line, "disk full");
        assert!(!line.contains("private"));
        assert_eq!(
            failure_line(Some("disk full\u{2029}rest of it"), None),
            "disk full"
        );
        assert_eq!(
            failure_line(Some("disk full\u{0085}rest of it"), None),
            "disk full"
        );

        let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
        let scrubbed = failure_line(Some(pem), None);
        assert!(
            !scrubbed.contains("BEGIN"),
            "a private key must not leave its header: {scrubbed}"
        );
        assert!(!scrubbed.contains("OPENSSH"));
        assert!(scrubbed.contains("[secret removed]"));
    }
}
