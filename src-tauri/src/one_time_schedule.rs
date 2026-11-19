// One prompt, once, at a local date and time (WP-128).
// The open app fires it. A closed app misses it. This module starts no thread and installs nothing.

use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::session_store::{now_millis, validate_id, SessionStore};

pub(crate) const CHANGED: &str = "monocode:one-time-schedules-changed";

const MAX_PROMPT: usize = 100_000;
const MAX_PROJECT: usize = 4096;
const MAX_ID: usize = 80;
/// 10000-01-01T00:00:00Z, in milliseconds. A local time cannot name a later year.
const YEAR_10000_MS: i64 = 253_402_300_800_000;
/// An open app that wakes days later does not fire the run. Six hours still covers a nap.
const LATENESS_GRACE_MS: i64 = 6 * 60 * 60 * 1000;

fn is_false(value: &bool) -> bool {
    !*value
}

fn past_grace(run_at: i64, now: i64) -> bool {
    now.saturating_sub(run_at) > LATENESS_GRACE_MS
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OneTimeStatus {
    Scheduled,
    Fired,
    Missed,
    Cancelled,
    Undeliverable,
}

impl OneTimeStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Fired => "fired",
            Self::Missed => "missed",
            Self::Cancelled => "cancelled",
            Self::Undeliverable => "undeliverable",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OneTimeTarget {
    Chat { session_id: String },
    Project { project_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneTimeClaim {
    pub token: String,
    pub until: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneTimeSchedule {
    pub id: String,
    pub target: OneTimeTarget,
    pub prompt: String,
    pub run_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_text: Option<String>,
    pub status: OneTimeStatus,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noted_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<OneTimeClaim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_session_id: Option<String>,
    /// The prompt was accepted. A later claim marks the run fired and does not send it again.
    #[serde(default, skip_serializing_if = "is_false")]
    pub handed_off: bool,
    /// Missed because the open app woke after the grace window, not because it was closed.
    #[serde(default, skip_serializing_if = "is_false")]
    pub late: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneTimeCreate {
    pub id: String,
    pub target: OneTimeTarget,
    pub prompt: String,
    pub local_text: String,
    pub run_at: i64,
}

/// Set once, after the first reconcile in this process. A later call must not mark a due run missed:
/// the app is open, so the open tick fires it.
pub struct OneTimeClock {
    reconciled: AtomicBool,
}

impl OneTimeClock {
    fn new() -> Self {
        Self {
            reconciled: AtomicBool::new(false),
        }
    }
}

pub fn init(app: &AppHandle) {
    app.manage(OneTimeClock::new());
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS one_time_schedules (
           id TEXT PRIMARY KEY,
           body_json TEXT NOT NULL,
           status TEXT NOT NULL,
           run_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           claim_token TEXT,
           claim_until INTEGER
         );
         CREATE INDEX IF NOT EXISTS one_time_schedules_due_idx
           ON one_time_schedules (status, run_at);",
    )
}

fn schedules_paused() -> bool {
    !crate::instance::policy().automations || crate::ship::holding()
}

fn paused_error() -> String {
    "This copy does not run one-time schedules.".into()
}

fn valid_local_text(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 16 {
        return false;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' {
        return false;
    }
    let Ok(year) = value[0..4].parse::<i32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    let Ok(hour) = value[11..13].parse::<u32>() else {
        return false;
    };
    let Ok(minute) = value[14..16].parse::<u32>() else {
        return false;
    };
    if !(1..=9999).contains(&year) || !(1..=12).contains(&month) || hour > 23 || minute > 59 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    (1..=days[(month - 1) as usize]).contains(&day)
}

fn valid_token(value: &str) -> bool {
    value.len() <= MAX_ID && validate_id(value, "schedule").is_ok()
}

fn validate_target(target: &OneTimeTarget) -> Result<(), String> {
    match target {
        OneTimeTarget::Chat { session_id } => {
            if session_id.len() > MAX_ID {
                return Err("Choose a chat or a project.".into());
            }
            validate_id(session_id, "session")
                .map_err(|_| "Choose a chat or a project.".to_string())
        }
        OneTimeTarget::Project { project_id } => {
            let chars = project_id.chars().count();
            if !(1..=MAX_PROJECT).contains(&chars)
                || project_id.contains('\0')
                || project_id.contains('\n')
                || project_id.contains('\r')
            {
                return Err("Choose a chat or a project.".into());
            }
            Ok(())
        }
    }
}

fn validate_row(row: &OneTimeSchedule) -> bool {
    if row.id.len() > MAX_ID || validate_id(&row.id, "schedule").is_err() {
        return false;
    }
    if validate_target(&row.target).is_err() {
        return false;
    }
    if row.prompt.trim().is_empty()
        || row.prompt.chars().count() > MAX_PROMPT
        || row.prompt.contains('\0')
    {
        return false;
    }
    if row.run_at <= 0 || row.run_at >= YEAR_10000_MS {
        return false;
    }
    if row
        .local_text
        .as_ref()
        .is_some_and(|text| !valid_local_text(text))
    {
        return false;
    }
    if row.created_at < 0 || row.updated_at < 0 {
        return false;
    }
    if row.noted_at.is_some_and(|noted| noted < 0) {
        return false;
    }
    if row
        .started_session_id
        .as_ref()
        .is_some_and(|id| !valid_token(id))
    {
        return false;
    }
    if let Some(claim) = &row.claim {
        if !valid_token(&claim.token) || claim.until <= 0 {
            return false;
        }
    }
    true
}

fn validate_create(input: &OneTimeCreate, now: i64) -> Result<OneTimeSchedule, String> {
    if input.id.len() > MAX_ID {
        return Err("That schedule id is not valid.".into());
    }
    validate_id(&input.id, "schedule").map_err(|_| "That schedule id is not valid.".to_string())?;
    validate_target(&input.target)?;
    if input.prompt.chars().count() > MAX_PROMPT || input.prompt.contains('\0') {
        return Err("Write a prompt first.".into());
    }
    let prompt = input.prompt.trim();
    if prompt.is_empty() {
        return Err("Write a prompt first.".into());
    }
    if !valid_local_text(&input.local_text) {
        return Err("That time is not a real date.".into());
    }
    if input.run_at <= now || input.run_at >= YEAR_10000_MS {
        return Err("Choose a time in the future.".into());
    }
    Ok(OneTimeSchedule {
        id: input.id.clone(),
        target: input.target.clone(),
        prompt: prompt.to_string(),
        run_at: input.run_at,
        local_text: Some(input.local_text.clone()),
        status: OneTimeStatus::Scheduled,
        created_at: now,
        updated_at: now,
        noted_at: None,
        claim: None,
        started_session_id: None,
        handed_off: false,
        late: false,
    })
}

fn body_of(row: &OneTimeSchedule) -> Result<String, String> {
    serde_json::to_string(row).map_err(|error| error.to_string())
}

struct RawRow {
    body_json: String,
    status: String,
    run_at: i64,
    updated_at: i64,
    claim_token: Option<String>,
    claim_until: Option<i64>,
}

fn decode_raw(raw: &RawRow) -> Option<OneTimeSchedule> {
    let row: OneTimeSchedule = serde_json::from_str(&raw.body_json).ok()?;
    if row.status.as_str() != raw.status
        || row.run_at != raw.run_at
        || row.updated_at != raw.updated_at
    {
        return None;
    }
    let token = row.claim.as_ref().map(|claim| claim.token.as_str());
    let until = row.claim.as_ref().map(|claim| claim.until);
    if token != raw.claim_token.as_deref() || until != raw.claim_until {
        return None;
    }
    if !validate_row(&row) {
        return None;
    }
    Some(row)
}

fn map_raw(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawRow> {
    Ok(RawRow {
        body_json: row.get(0)?,
        status: row.get(1)?,
        run_at: row.get(2)?,
        updated_at: row.get(3)?,
        claim_token: row.get(4)?,
        claim_until: row.get(5)?,
    })
}

fn list(conn: &Connection) -> Result<Vec<OneTimeSchedule>, String> {
    let mut statement = conn
        .prepare(
            "SELECT body_json, status, run_at, updated_at, claim_token, claim_until
             FROM one_time_schedules
             ORDER BY run_at, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], map_raw)
        .map_err(|error| error.to_string())?;
    let mut schedules = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        if let Some(schedule) = decode_raw(&raw) {
            schedules.push(schedule);
        }
    }
    Ok(schedules)
}

fn get(conn: &Connection, id: &str) -> Result<Option<OneTimeSchedule>, String> {
    let raw = conn
        .query_row(
            "SELECT body_json, status, run_at, updated_at, claim_token, claim_until
             FROM one_time_schedules WHERE id = ?1",
            [id],
            map_raw,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(raw.as_ref().and_then(decode_raw))
}

fn require(conn: &Connection, id: &str) -> Result<OneTimeSchedule, String> {
    get(conn, id)?.ok_or_else(|| "That schedule is not here.".to_string())
}

fn insert_new(conn: &Connection, row: &OneTimeSchedule) -> Result<(), String> {
    let body = body_of(row)?;
    match conn.execute(
        "INSERT INTO one_time_schedules
           (id, body_json, status, run_at, updated_at, claim_token, claim_until)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)",
        params![
            row.id,
            body,
            row.status.as_str(),
            row.run_at,
            row.updated_at
        ],
    ) {
        Ok(_) => Ok(()),
        Err(error)
            if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) =>
        {
            Err("A schedule with this id already exists.".into())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn changed(conn: &Connection, result: usize) -> bool {
    result == 1 && conn.changes() == 1
}

fn create(conn: &Connection, input: &OneTimeCreate, now: i64) -> Result<OneTimeSchedule, String> {
    let row = validate_create(input, now)?;
    insert_new(conn, &row)?;
    Ok(row)
}

fn cancel(conn: &Connection, id: &str, now: i64) -> Result<OneTimeSchedule, String> {
    validate_id(id, "schedule").map_err(|_| "That schedule id is not valid.".to_string())?;
    let current = require(conn, id)?;
    if current.status != OneTimeStatus::Scheduled {
        return Ok(current);
    }
    if current
        .claim
        .as_ref()
        .is_some_and(|claim| claim.until > now)
    {
        return Ok(current);
    }
    let next = OneTimeSchedule {
        status: OneTimeStatus::Cancelled,
        updated_at: now,
        claim: None,
        ..current.clone()
    };
    let body = body_of(&next)?;
    let result = conn
        .execute(
            "UPDATE one_time_schedules
             SET body_json = ?1, status = 'cancelled', updated_at = ?2,
                 claim_token = NULL, claim_until = NULL
             WHERE id = ?3 AND status = 'scheduled' AND updated_at = ?4
               AND (claim_token IS NULL OR claim_until <= ?5)",
            params![body, now, id, current.updated_at, now],
        )
        .map_err(|error| error.to_string())?;
    if changed(conn, result) {
        Ok(next)
    } else {
        require(conn, id)
    }
}

fn mark_missed(conn: &Connection, now: i64) -> Result<(), String> {
    let due: Vec<OneTimeSchedule> = list(conn)?
        .into_iter()
        .filter(|row| row.status == OneTimeStatus::Scheduled && row.run_at <= now)
        .collect();
    for current in due {
        let next = OneTimeSchedule {
            status: OneTimeStatus::Missed,
            updated_at: now,
            claim: None,
            ..current.clone()
        };
        let body = body_of(&next)?;
        conn.execute(
            "UPDATE one_time_schedules
             SET body_json = ?1, status = 'missed', updated_at = ?2,
                 claim_token = NULL, claim_until = NULL
             WHERE id = ?3 AND status = 'scheduled' AND updated_at = ?4 AND run_at <= ?5",
            params![body, now, current.id, current.updated_at, now],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn miss_closed(
    conn: &Connection,
    now: i64,
    reconciled: &AtomicBool,
) -> Result<Vec<OneTimeSchedule>, String> {
    if reconciled
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        if let Err(error) = mark_missed(conn, now) {
            reconciled.store(false, Ordering::Release);
            return Err(error);
        }
    }
    Ok(list(conn)?
        .into_iter()
        .filter(|row| row.status == OneTimeStatus::Missed && row.noted_at.is_none())
        .collect())
}

fn claim(
    conn: &Connection,
    id: &str,
    expected_updated_at: i64,
    token: &str,
    until: i64,
    now: i64,
) -> Result<Option<OneTimeSchedule>, String> {
    if !valid_token(token) || until <= now {
        return Ok(None);
    }
    let Some(current) = get(conn, id)? else {
        return Ok(None);
    };
    if current.status != OneTimeStatus::Scheduled
        || current.updated_at != expected_updated_at
        || current.run_at > now
        || past_grace(current.run_at, now)
    {
        return Ok(None);
    }
    if current
        .claim
        .as_ref()
        .is_some_and(|claim| claim.until > now)
    {
        return Ok(None);
    }
    let next = OneTimeSchedule {
        updated_at: now,
        claim: Some(OneTimeClaim {
            token: token.to_string(),
            until,
        }),
        ..current
    };
    let body = body_of(&next)?;
    let result = conn
        .execute(
            "UPDATE one_time_schedules
             SET body_json = ?1, updated_at = ?2, claim_token = ?3, claim_until = ?4
             WHERE id = ?5 AND status = 'scheduled' AND updated_at = ?6 AND run_at <= ?7
               AND (?7 - run_at) <= ?8
               AND (claim_token IS NULL OR claim_until <= ?7)",
            params![
                body,
                now,
                token,
                until,
                id,
                expected_updated_at,
                now,
                LATENESS_GRACE_MS
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed(conn, result) {
        Ok(Some(next))
    } else {
        Ok(None)
    }
}

fn remember_session(
    conn: &Connection,
    id: &str,
    token: &str,
    session_id: &str,
    now: i64,
) -> Result<Option<OneTimeSchedule>, String> {
    if !valid_token(session_id) {
        return Ok(None);
    }
    let Some(current) = get(conn, id)? else {
        return Ok(None);
    };
    if current.status != OneTimeStatus::Scheduled
        || current.claim.as_ref().map(|claim| claim.token.as_str()) != Some(token)
    {
        return Ok(None);
    }
    if current
        .started_session_id
        .as_ref()
        .is_some_and(|existing| existing != session_id)
    {
        return Ok(None);
    }
    let next = OneTimeSchedule {
        started_session_id: Some(session_id.to_string()),
        updated_at: now,
        ..current
    };
    let body = body_of(&next)?;
    let result = conn
        .execute(
            "UPDATE one_time_schedules
             SET body_json = ?1, updated_at = ?2
             WHERE id = ?3 AND status = 'scheduled' AND claim_token = ?4",
            params![body, now, id, token],
        )
        .map_err(|error| error.to_string())?;
    if changed(conn, result) {
        Ok(Some(next))
    } else {
        Ok(None)
    }
}

fn ack_fired(
    conn: &Connection,
    id: &str,
    token: &str,
    now: i64,
) -> Result<Option<OneTimeSchedule>, String> {
    let Some(current) = get(conn, id)? else {
        return Ok(None);
    };
    if current.status != OneTimeStatus::Scheduled
        || current.claim.as_ref().map(|claim| claim.token.as_str()) != Some(token)
        || current.run_at > now
    {
        return Ok(None);
    }
    let next = OneTimeSchedule {
        status: OneTimeStatus::Fired,
        updated_at: now,
        claim: None,
        ..current
    };
    let body = body_of(&next)?;
    let result = conn
        .execute(
            "UPDATE one_time_schedules
             SET body_json = ?1, status = 'fired', updated_at = ?2,
                 claim_token = NULL, claim_until = NULL
             WHERE id = ?3 AND status = 'scheduled' AND claim_token = ?4 AND run_at <= ?5",
            params![body, now, id, token, now],
        )
        .map_err(|error| error.to_string())?;
    if changed(conn, result) {
        Ok(Some(next))
    } else {
        Ok(None)
    }
}

fn release(
    conn: &Connection,
    id: &str,
    token: &str,
    now: i64,
) -> Result<Option<OneTimeSchedule>, String> {
    let Some(current) = get(conn, id)? else {
        return Ok(None);
    };
    if current.status != OneTimeStatus::Scheduled
        || current.claim.as_ref().map(|claim| claim.token.as_str()) != Some(token)
    {
        return Ok(None);
    }
    let next = OneTimeSchedule {
        updated_at: now,
        claim: None,
        ..current
    };
    let body = body_of(&next)?;
    let result = conn
        .execute(
            "UPDATE one_time_schedules
             SET body_json = ?1, updated_at = ?2, claim_token = NULL, claim_until = NULL
             WHERE id = ?3 AND status = 'scheduled' AND claim_token = ?4",
            params![body, now, id, token],
        )
        .map_err(|error| error.to_string())?;
    if changed(conn, result) {
        Ok(Some(next))
    } else {
        Ok(None)
    }
}

fn mark_handed_off(
    conn: &Connection,
    id: &str,
    token: &str,
    now: i64,
) -> Result<Option<OneTimeSchedule>, String> {
    let Some(current) = get(conn, id)? else {
        return Ok(None);
    };
    if current.status != OneTimeStatus::Scheduled
        || current.claim.as_ref().map(|claim| claim.token.as_str()) != Some(token)
    {
        return Ok(None);
    }
    let next = OneTimeSchedule {
        handed_off: true,
        updated_at: now,
        ..current
    };
    let body = body_of(&next)?;
    let result = conn
        .execute(
            "UPDATE one_time_schedules
             SET body_json = ?1, updated_at = ?2
             WHERE id = ?3 AND status = 'scheduled' AND claim_token = ?4",
            params![body, now, id, token],
        )
        .map_err(|error| error.to_string())?;
    if changed(conn, result) {
        Ok(Some(next))
    } else {
        Ok(None)
    }
}

fn mark_undeliverable(
    conn: &Connection,
    id: &str,
    token: &str,
    now: i64,
) -> Result<Option<OneTimeSchedule>, String> {
    let Some(current) = get(conn, id)? else {
        return Ok(None);
    };
    if current.status != OneTimeStatus::Scheduled
        || current.claim.as_ref().map(|claim| claim.token.as_str()) != Some(token)
    {
        return Ok(None);
    }
    let next = OneTimeSchedule {
        status: OneTimeStatus::Undeliverable,
        updated_at: now,
        claim: None,
        ..current
    };
    let body = body_of(&next)?;
    let result = conn
        .execute(
            "UPDATE one_time_schedules
             SET body_json = ?1, status = 'undeliverable', updated_at = ?2,
                 claim_token = NULL, claim_until = NULL
             WHERE id = ?3 AND status = 'scheduled' AND claim_token = ?4",
            params![body, now, id, token],
        )
        .map_err(|error| error.to_string())?;
    if changed(conn, result) {
        Ok(Some(next))
    } else {
        Ok(None)
    }
}

fn mark_late(conn: &Connection, id: &str, now: i64) -> Result<Option<OneTimeSchedule>, String> {
    let Some(current) = get(conn, id)? else {
        return Ok(None);
    };
    if current.status != OneTimeStatus::Scheduled || !past_grace(current.run_at, now) {
        return Ok(None);
    }
    if current
        .claim
        .as_ref()
        .is_some_and(|claim| claim.until > now)
    {
        return Ok(None);
    }
    let next = OneTimeSchedule {
        status: OneTimeStatus::Missed,
        updated_at: now,
        claim: None,
        late: true,
        ..current
    };
    let body = body_of(&next)?;
    let result = conn
        .execute(
            "UPDATE one_time_schedules
             SET body_json = ?1, status = 'missed', updated_at = ?2,
                 claim_token = NULL, claim_until = NULL
             WHERE id = ?3 AND status = 'scheduled' AND updated_at = ?4
               AND (claim_token IS NULL OR claim_until <= ?5)
               AND (?5 - run_at) > ?6",
            params![body, now, id, current.updated_at, now, LATENESS_GRACE_MS],
        )
        .map_err(|error| error.to_string())?;
    if changed(conn, result) {
        Ok(Some(next))
    } else {
        Ok(None)
    }
}

fn note(conn: &Connection, id: &str, now: i64) -> Result<(), String> {
    let Some(current) = get(conn, id)? else {
        return Ok(());
    };
    if current.noted_at.is_some()
        || (current.status != OneTimeStatus::Missed
            && current.status != OneTimeStatus::Undeliverable)
    {
        return Ok(());
    }
    let next = OneTimeSchedule {
        noted_at: Some(now),
        updated_at: now,
        ..current
    };
    let body = body_of(&next)?;
    conn.execute(
        "UPDATE one_time_schedules
         SET body_json = ?1, updated_at = ?2
         WHERE id = ?3 AND status IN ('missed', 'undeliverable') AND updated_at = ?4",
        params![body, now, id, current.updated_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit(CHANGED, ());
}

#[tauri::command(async)]
pub fn one_time_schedules_list(
    store: State<'_, SessionStore>,
) -> Result<Vec<OneTimeSchedule>, String> {
    let conn = store.lock_conn()?;
    list(&conn)
}

#[tauri::command(async)]
pub fn one_time_schedules_create(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: OneTimeCreate,
) -> Result<OneTimeSchedule, String> {
    let now = now_millis();
    let conn = store.lock_conn()?;
    let saved = create(&conn, &input, now)?;
    drop(conn);
    emit_changed(&app);
    Ok(saved)
}

#[tauri::command(async)]
pub fn one_time_schedules_cancel(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
) -> Result<OneTimeSchedule, String> {
    let now = now_millis();
    let conn = store.lock_conn()?;
    let saved = cancel(&conn, &id, now)?;
    drop(conn);
    emit_changed(&app);
    Ok(saved)
}

#[tauri::command(async)]
pub fn one_time_schedules_miss_closed(
    app: AppHandle,
    store: State<'_, SessionStore>,
    clock: State<'_, OneTimeClock>,
) -> Result<Vec<OneTimeSchedule>, String> {
    let now = now_millis();
    let conn = store.lock_conn()?;
    let rows = miss_closed(&conn, now, &clock.reconciled)?;
    drop(conn);
    // The list is open in this process, so it can show a run that just became missed.
    emit_changed(&app);
    Ok(rows)
}

#[tauri::command(async)]
pub fn one_time_schedules_claim(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    expected_updated_at: i64,
    token: String,
    until: i64,
) -> Result<Option<OneTimeSchedule>, String> {
    if schedules_paused() {
        return Err(paused_error());
    }
    let now = now_millis();
    let conn = store.lock_conn()?;
    let saved = claim(&conn, &id, expected_updated_at, &token, until, now)?;
    drop(conn);
    if saved.is_some() {
        emit_changed(&app);
    }
    Ok(saved)
}

#[tauri::command(async)]
pub fn one_time_schedules_remember_session(
    store: State<'_, SessionStore>,
    id: String,
    token: String,
    session_id: String,
) -> Result<Option<OneTimeSchedule>, String> {
    if schedules_paused() {
        return Err(paused_error());
    }
    let now = now_millis();
    let conn = store.lock_conn()?;
    remember_session(&conn, &id, &token, &session_id, now)
}

#[tauri::command(async)]
pub fn one_time_schedules_ack_fired(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    token: String,
) -> Result<Option<OneTimeSchedule>, String> {
    if schedules_paused() {
        return Err(paused_error());
    }
    let now = now_millis();
    let conn = store.lock_conn()?;
    let saved = ack_fired(&conn, &id, &token, now)?;
    drop(conn);
    if saved.is_some() {
        emit_changed(&app);
    }
    Ok(saved)
}

#[tauri::command(async)]
pub fn one_time_schedules_release(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    token: String,
) -> Result<Option<OneTimeSchedule>, String> {
    if schedules_paused() {
        return Err(paused_error());
    }
    let now = now_millis();
    let conn = store.lock_conn()?;
    let saved = release(&conn, &id, &token, now)?;
    drop(conn);
    if saved.is_some() {
        emit_changed(&app);
    }
    Ok(saved)
}

#[tauri::command(async)]
pub fn one_time_schedules_mark_handed_off(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    token: String,
) -> Result<Option<OneTimeSchedule>, String> {
    let now = now_millis();
    let conn = store.lock_conn()?;
    let saved = mark_handed_off(&conn, &id, &token, now)?;
    drop(conn);
    if saved.is_some() {
        emit_changed(&app);
    }
    Ok(saved)
}

#[tauri::command(async)]
pub fn one_time_schedules_mark_undeliverable(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    token: String,
) -> Result<Option<OneTimeSchedule>, String> {
    let now = now_millis();
    let conn = store.lock_conn()?;
    let saved = mark_undeliverable(&conn, &id, &token, now)?;
    drop(conn);
    if saved.is_some() {
        emit_changed(&app);
    }
    Ok(saved)
}

#[tauri::command(async)]
pub fn one_time_schedules_mark_late(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
) -> Result<Option<OneTimeSchedule>, String> {
    let now = now_millis();
    let conn = store.lock_conn()?;
    let saved = mark_late(&conn, &id, now)?;
    drop(conn);
    if saved.is_some() {
        emit_changed(&app);
    }
    Ok(saved)
}

#[tauri::command(async)]
pub fn one_time_schedules_note(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    let now = now_millis();
    let conn = store.lock_conn()?;
    note(&conn, &id, now)?;
    drop(conn);
    emit_changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    fn sample(id: &str, run_at: i64) -> OneTimeCreate {
        OneTimeCreate {
            id: id.into(),
            target: OneTimeTarget::Chat {
                session_id: "chat-1".into(),
            },
            prompt: "Check the build".into(),
            local_text: "2026-11-09T09:30".into(),
            run_at,
        }
    }

    fn remove_test_db(path: &Path) {
        let Ok(temp) = crate::fs::canonical(std::env::temp_dir()) else {
            return;
        };
        let mut candidates = vec![path.to_path_buf()];
        for suffix in ["-wal", "-shm"] {
            candidates.push(Path::new(&format!("{}{suffix}", path.display())).to_path_buf());
        }
        for candidate in candidates {
            let Ok(file) = crate::fs::canonical(&candidate) else {
                continue;
            };
            let name = file
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if file.starts_with(&temp) && name.starts_with("hivra-one-time-") {
                let _ = std::fs::remove_file(&file);
            }
        }
    }

    #[test]
    fn persists_across_a_reopen_including_unicode_spaces_and_crlf() {
        let path =
            std::env::temp_dir().join(format!("hivra-one-time-{}.sqlite", uuid::Uuid::new_v4()));
        let saved = {
            let conn = Connection::open(&path).unwrap();
            ensure_tables(&conn).unwrap();
            let input = OneTimeCreate {
                id: "sched-1".into(),
                target: OneTimeTarget::Project {
                    project_id: "C:\\Work\\My Project\\项目".into(),
                },
                prompt: "Line one\r\nline two".into(),
                local_text: "2026-11-09T09:30".into(),
                run_at: 2_000,
            };
            let saved = create(&conn, &input, 1_000).unwrap();
            conn.execute(
                "INSERT INTO one_time_schedules
                   (id, body_json, status, run_at, updated_at, claim_token, claim_until)
                 VALUES ('junk', '{', 'scheduled', 1, 1, NULL, NULL)",
                [],
            )
            .unwrap();
            saved
        };
        let conn = Connection::open(&path).unwrap();
        ensure_tables(&conn).unwrap();
        assert_eq!(list(&conn).unwrap(), vec![saved]);
        remove_test_db(&path);
    }

    #[test]
    fn rejects_an_empty_prompt_a_bad_date_and_a_past_time() {
        let conn = memory();
        let mut input = sample("sched-1", 2_000);
        input.prompt = "   ".into();
        assert!(create(&conn, &input, 1_000).unwrap_err().contains("prompt"));
        input.prompt = "Hi".into();
        input.local_text = "2026-02-31T12:00".into();
        assert!(create(&conn, &input, 1_000).unwrap_err().contains("date"));
        input.local_text = "2026-11-09T09:30".into();
        input.run_at = 500;
        assert!(create(&conn, &input, 1_000).unwrap_err().contains("future"));
        assert!(!valid_local_text("not-a-time"));
        assert!(valid_local_text("2026-11-09T09:30"));
    }

    #[test]
    fn fires_once_and_a_late_ack_does_not_fire_again() {
        let conn = memory();
        let row = create(&conn, &sample("sched-1", 2_000), 1_000).unwrap();
        let claimed = claim(&conn, "sched-1", row.updated_at, "token-a", 3_000, 2_000)
            .unwrap()
            .unwrap();
        assert_eq!(claimed.claim.unwrap().token, "token-a");
        release(&conn, "sched-1", "token-a", 2_001).unwrap();
        let replacement = &list(&conn).unwrap()[0];
        let next = claim(
            &conn,
            "sched-1",
            replacement.updated_at,
            "token-b",
            5_000,
            2_002,
        )
        .unwrap()
        .unwrap();
        assert!(ack_fired(&conn, "sched-1", "token-a", 2_003)
            .unwrap()
            .is_none());
        assert_eq!(next.status, OneTimeStatus::Scheduled);
        let fired = ack_fired(&conn, "sched-1", "token-b", 2_004)
            .unwrap()
            .unwrap();
        assert_eq!(fired.status, OneTimeStatus::Fired);
        assert!(fired.claim.is_none());
    }

    #[test]
    fn a_live_claim_blocks_a_second_one_and_an_expired_claim_can_be_replaced() {
        let conn = memory();
        let row = create(&conn, &sample("sched-1", 2_000), 1_000).unwrap();
        claim(&conn, "sched-1", row.updated_at, "token-a", 9_000, 2_000).unwrap();
        let held = list(&conn).unwrap();
        assert!(claim(
            &conn,
            "sched-1",
            held[0].updated_at,
            "token-b",
            9_000,
            2_100
        )
        .unwrap()
        .is_none());
        let replaced = claim(
            &conn,
            "sched-1",
            held[0].updated_at,
            "token-b",
            12_000,
            9_000,
        )
        .unwrap()
        .unwrap();
        assert_eq!(replaced.claim.unwrap().token, "token-b");
    }

    #[test]
    fn release_keeps_the_started_chat() {
        let conn = memory();
        let row = create(&conn, &sample("sched-1", 2_000), 1_000).unwrap();
        claim(&conn, "sched-1", row.updated_at, "token-a", 4_000, 2_000).unwrap();
        let saved = remember_session(&conn, "sched-1", "token-a", "new-chat", 2_100)
            .unwrap()
            .unwrap();
        assert_eq!(saved.started_session_id.as_deref(), Some("new-chat"));
        let released = release(&conn, "sched-1", "token-a", 2_200)
            .unwrap()
            .unwrap();
        assert_eq!(released.status, OneTimeStatus::Scheduled);
        assert!(released.claim.is_none());
        assert_eq!(released.started_session_id.as_deref(), Some("new-chat"));
        assert!(
            remember_session(&conn, "sched-1", "token-a", "other", 2_300)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn cancels_a_scheduled_run_and_leaves_a_fired_or_missed_run_alone() {
        let conn = memory();
        create(&conn, &sample("sched-1", 2_000), 1_000).unwrap();
        assert_eq!(
            cancel(&conn, "sched-1", 1_100).unwrap().status,
            OneTimeStatus::Cancelled
        );
        assert_eq!(
            cancel(&conn, "sched-1", 1_200).unwrap().status,
            OneTimeStatus::Cancelled
        );

        let row = create(&conn, &sample("sched-2", 2_000), 1_000).unwrap();
        claim(&conn, "sched-2", row.updated_at, "token-a", 4_000, 2_000).unwrap();
        ack_fired(&conn, "sched-2", "token-a", 2_100).unwrap();
        assert_eq!(
            cancel(&conn, "sched-2", 2_200).unwrap().status,
            OneTimeStatus::Fired
        );
    }

    #[test]
    fn a_new_process_marks_a_due_run_missed_and_the_same_process_does_not() {
        let conn = memory();
        create(&conn, &sample("sched-1", 5_000), 1_000).unwrap();
        let clock = AtomicBool::new(false);
        let early = miss_closed(&conn, 1_000, &clock).unwrap();
        assert!(early.is_empty());
        assert_eq!(list(&conn).unwrap()[0].status, OneTimeStatus::Scheduled);

        let still = miss_closed(&conn, 6_000, &clock).unwrap();
        assert!(still.is_empty());
        assert_eq!(list(&conn).unwrap()[0].status, OneTimeStatus::Scheduled);

        let restarted = AtomicBool::new(false);
        let missed = miss_closed(&conn, 6_000, &restarted).unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(missed[0].status, OneTimeStatus::Missed);
        assert_eq!(list(&conn).unwrap()[0].status, OneTimeStatus::Missed);

        note(&conn, "sched-1", 6_100).unwrap();
        assert!(miss_closed(&conn, 6_200, &restarted).unwrap().is_empty());
        assert_eq!(
            cancel(&conn, "sched-1", 6_300).unwrap().status,
            OneTimeStatus::Missed
        );
    }

    #[test]
    fn cancel_does_not_succeed_while_a_claim_is_live() {
        let conn = memory();
        let row = create(&conn, &sample("sched-1", 2_000), 1_000).unwrap();
        claim(&conn, "sched-1", row.updated_at, "token-a", 9_000, 2_000).unwrap();
        let during = cancel(&conn, "sched-1", 2_100).unwrap();
        assert_eq!(during.status, OneTimeStatus::Scheduled);
        assert_eq!(during.claim.unwrap().token, "token-a");
        let after = cancel(&conn, "sched-1", 9_000).unwrap();
        assert_eq!(after.status, OneTimeStatus::Cancelled);
        assert!(after.claim.is_none());
    }

    #[test]
    fn a_days_late_claim_does_not_start_the_run() {
        let conn = memory();
        let row = create(&conn, &sample("sched-1", 2_000), 1_000).unwrap();
        let later = 2_000 + 2 * 24 * 60 * 60 * 1000;
        let claimed = claim(
            &conn,
            "sched-1",
            row.updated_at,
            "token-a",
            later + 1_000,
            later,
        )
        .unwrap();
        assert!(claimed.is_none());
        assert_eq!(list(&conn).unwrap()[0].status, OneTimeStatus::Scheduled);
    }

    #[test]
    fn skips_a_body_that_does_not_parse() {
        let conn = memory();
        let saved = create(&conn, &sample("sched-1", 2_000), 1_000).unwrap();
        conn.execute(
            "INSERT INTO one_time_schedules
               (id, body_json, status, run_at, updated_at, claim_token, claim_until)
             VALUES ('junk', '{\"status\":\"nope\"}', 'scheduled', 1, 1, NULL, NULL)",
            [],
        )
        .unwrap();
        assert_eq!(list(&conn).unwrap(), vec![saved]);
    }
}
