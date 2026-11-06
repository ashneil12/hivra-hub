//! Autopilot (docs/HUB-PLAN.md phase 3; the autopilot design notes).
//!
//! Ash's switch for "go autopilot until Monday 9:00", for everything (scope `*`) or one project at a time, each with its
//! own end time. While a switch is on, agents take their own recommendation on every call that would have gone to Ash
//! except his red list, and each such call is a row in the Autopilot log. Which calls those are is the webview's job
//! (`src/features/autopilot`); this module keeps what has to outlive the webview:
//! - **Switches** (`autopilot_switches`): one row per scope. The timer thread ends each at its end time (a log row
//!   "ended"), so autopilot never outlives the time Ash gave it, even across a restart.
//! - **Log** (`autopilot_log`): what was decided, by whom, the recommendation taken, when, and in which chat. `dedupe`
//!   makes the same call land once however many times it is reported. Each new row trims it to the newest
//!   [`LOG_KEEP_ROWS`] rows or the last [`LOG_KEEP_MS`], whichever is more.
//! - **Resumes** (`autopilot_resumes`): usage-limit auto-resumes armed for a chat (on by default for Monos, Leads and
//!   the work they delegate; not tied to the switch). A chat's limit is in-memory only, so this row is what brings the
//!   resume back after a crash or relaunch. `attempts` counts auto-resumes without a finished turn in between; past
//!   [`MAX_AUTO_RESUMES`] it stops and the chat waits for Ash.
//! - **Keep-awake**: while any switch is on this process holds an IOPMAssertion (`PreventUserIdleSystemSleep`, what
//!   `caffeinate -i` takes). It is released when the last switch ends or is turned off, and by macOS if the app dies.
//! - **Relaunch after a crash**: while a switch is on, the daily app installs a LaunchAgent that runs
//!   `monocode autopilot-watch <data dir>` every 30 s ([`watch_main`]). It reopens the app only when its process is gone
//!   without a clean exit (a crash or a kill, not ⌘Q and not a Ship), at most [`MAX_RELAUNCHES`] times in
//!   [`RELAUNCH_WINDOW_MS`], and retires itself at the end time. Dev copies and copies under a temporary HOME never
//!   install it. The chats a crash cut off resume through the app's normal auto-continue, whose own crash-loop cap
//!   (WP5) applies; [`Status::relaunched_after_crash`] tells it this start was such a relaunch.
//!
//! Own tables, made by `ensure_tables` (no numbered migration, so upstream's migration numbers can't collide).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::instance;
use crate::session_store::{now_millis, SessionStore};

/// Tauri event after any change to switches, settings, the log or resumes: `{ "what": "switches" | "log" | ... }`.
pub const CHANGED: &str = "monocode:autopilot-changed";
/// The scope of the switch for everything.
pub const EVERYTHING: &str = "*";

/// The longest autopilot Ash can ask for in one go.
pub const MAX_SPAN_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// The shortest: anything sooner is a typo, not a weekend away.
pub const MIN_SPAN_MS: i64 = 60 * 1000;
/// Consecutive auto-resumes of one chat without a finished turn; then it waits for Ash (T3's cap).
pub const MAX_AUTO_RESUMES: i64 = 3;
/// Relaunches after a crash within [`RELAUNCH_WINDOW_MS`]; then the watcher stops and the next start logs it.
pub const MAX_RELAUNCHES: usize = 3;
pub const RELAUNCH_WINDOW_MS: i64 = 30 * 60 * 1000;
/// How often the LaunchAgent runs the watcher.
pub const WATCH_INTERVAL_SECS: u32 = 30;

/// The log keeps its newest [`LOG_KEEP_ROWS`] rows or the last [`LOG_KEEP_MS`], whichever is more; older rows go as new
/// ones come in.
pub const LOG_KEEP_ROWS: i64 = 2_000;
pub const LOG_KEEP_MS: i64 = 90 * 24 * 60 * 60 * 1000;

const TEXT_MAX: usize = 2_000;
const SHORT_MAX: usize = 300;
const LOG_PAGE_MAX: usize = 500;

/// Files under `<data>/autopilot/`.
const DIR: &str = "autopilot";
const WATCH_FILE: &str = "watch.json";
const CLEAN_EXIT_FILE: &str = "clean-exit.json";
const RELAUNCHES_FILE: &str = "relaunches.json";
const WATCH_LOG: &str = "watch.log";

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS autopilot_switches (
           scope TEXT PRIMARY KEY,
           until_ms INTEGER NOT NULL,
           set_by TEXT NOT NULL,
           set_at INTEGER NOT NULL,
           chat_id TEXT,
           said TEXT
         );
         CREATE TABLE IF NOT EXISTS autopilot_log (
           id TEXT PRIMARY KEY,
           at INTEGER NOT NULL,
           kind TEXT NOT NULL,
           outcome TEXT NOT NULL,
           project TEXT,
           chat_id TEXT,
           mono_id TEXT,
           who TEXT,
           what TEXT NOT NULL,
           recommendation TEXT,
           red TEXT,
           detail TEXT,
           dedupe TEXT UNIQUE
         );
         CREATE INDEX IF NOT EXISTS autopilot_log_at ON autopilot_log(at DESC);
         CREATE TABLE IF NOT EXISTS autopilot_resumes (
           session_id TEXT PRIMARY KEY,
           resets_at INTEGER NOT NULL,
           resume_at INTEGER NOT NULL,
           attempts INTEGER NOT NULL DEFAULT 1,
           state TEXT NOT NULL,
           title TEXT,
           armed_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS autopilot_settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
}

// ---- switches ----------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Switch {
    pub scope: String,
    pub until_ms: i64,
    /// `ash` (the hub screen) or `mono:<id>` (a Lead or the leadership team, told by Ash).
    pub set_by: String,
    pub set_at: i64,
    pub chat_id: Option<String>,
    /// Ash's own words, when a Mono switched it for him.
    pub said: Option<String>,
}

fn switch_from(row: &Row<'_>) -> rusqlite::Result<Switch> {
    Ok(Switch {
        scope: row.get("scope")?,
        until_ms: row.get("until_ms")?,
        set_by: row.get("set_by")?,
        set_at: row.get("set_at")?,
        chat_id: row.get("chat_id")?,
        said: row.get("said")?,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetInput {
    /// `*` or hub project ids.
    pub scopes: Vec<String>,
    pub until_ms: i64,
    pub by: String,
    pub chat_id: Option<String>,
    pub said: Option<String>,
    /// Ash's whole message that `said` quotes (a Mono switching it for him): the log row keeps it.
    #[serde(default)]
    pub turn: Option<String>,
    /// Who it reads as in the log ("Ash", "Chief of Staff").
    pub who: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OffInput {
    /// The scopes to end; empty or missing ends every switch.
    #[serde(default)]
    pub scopes: Vec<String>,
    pub by: String,
    pub chat_id: Option<String>,
    pub said: Option<String>,
    pub who: Option<String>,
}

fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn clip_opt(text: Option<String>, max: usize) -> Option<String> {
    text.map(|t| clip(&t, max)).filter(|t| !t.is_empty())
}

fn valid_scope(scope: &str) -> bool {
    scope == EVERYTHING
        || (!scope.is_empty()
            && scope.len() <= 128
            && scope
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'))
}

/// Every switch still on at `now`.
pub fn active_switches(conn: &Connection, now: i64) -> rusqlite::Result<Vec<Switch>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM autopilot_switches WHERE until_ms > ?1 ORDER BY scope = '*' DESC, scope",
    )?;
    let rows = stmt.query_map([now], switch_from)?;
    rows.collect()
}

/// Turn autopilot on (or move its end time) for each scope. Returns the switches now on.
pub fn set_switches(conn: &Connection, input: &SetInput, now: i64) -> Result<Vec<Switch>, String> {
    let span = input.until_ms - now;
    if span < MIN_SPAN_MS {
        return Err("The end time has to be at least a minute from now".into());
    }
    if span > MAX_SPAN_MS {
        return Err("Autopilot runs for at most 14 days at a time".into());
    }
    let mut scopes: Vec<String> = input.scopes.iter().map(|s| s.trim().to_string()).collect();
    scopes.sort();
    scopes.dedup();
    if scopes.is_empty() {
        return Err("Say what autopilot is for: everything or a project".into());
    }
    if let Some(bad) = scopes.iter().find(|s| !valid_scope(s)) {
        return Err(format!("Not a project id: {bad}"));
    }
    let by = clip(&input.by, SHORT_MAX);
    if by.is_empty() {
        return Err("Say who turned it on".into());
    }
    let said = clip_opt(input.said.clone(), TEXT_MAX);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for scope in &scopes {
        tx.execute(
            "INSERT INTO autopilot_switches (scope, until_ms, set_by, set_at, chat_id, said)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(scope) DO UPDATE SET until_ms = excluded.until_ms, set_by = excluded.set_by,
               set_at = excluded.set_at, chat_id = excluded.chat_id, said = excluded.said",
            params![scope, input.until_ms, by, now, input.chat_id, said],
        )
        .map_err(|e| e.to_string())?;
    }
    add_log_in(
        &tx,
        &LogInput {
            kind: "switch".into(),
            outcome: "on".into(),
            project: (scopes.len() == 1 && scopes[0] != EVERYTHING).then(|| scopes[0].clone()),
            chat_id: input.chat_id.clone(),
            mono_id: by.strip_prefix("mono:").map(str::to_string),
            who: input.who.clone().or_else(|| Some(by.clone())),
            what: format!("Autopilot on for {}", scope_phrase(&scopes)),
            recommendation: None,
            red: None,
            detail: clip_opt(input.turn.clone(), TEXT_MAX).or_else(|| said.clone()),
            dedupe: None,
        },
        now,
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    active_switches(conn, now).map_err(|e| e.to_string())
}

/// End switches early. Returns the ones that were on and are now off.
pub fn remove_switches(
    conn: &Connection,
    input: &OffInput,
    now: i64,
) -> Result<Vec<Switch>, String> {
    let active = active_switches(conn, now).map_err(|e| e.to_string())?;
    let ending: Vec<Switch> = active
        .into_iter()
        .filter(|s| input.scopes.is_empty() || input.scopes.iter().any(|x| x.trim() == s.scope))
        .collect();
    if ending.is_empty() {
        return Ok(ending);
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for switch in &ending {
        tx.execute(
            "DELETE FROM autopilot_switches WHERE scope = ?1",
            [&switch.scope],
        )
        .map_err(|e| e.to_string())?;
    }
    let scopes: Vec<String> = ending.iter().map(|s| s.scope.clone()).collect();
    let by = clip(&input.by, SHORT_MAX);
    add_log_in(
        &tx,
        &LogInput {
            kind: "switch".into(),
            outcome: "off".into(),
            project: (scopes.len() == 1 && scopes[0] != EVERYTHING).then(|| scopes[0].clone()),
            chat_id: input.chat_id.clone(),
            mono_id: by.strip_prefix("mono:").map(str::to_string),
            who: input.who.clone().or_else(|| Some(by.clone())),
            what: format!("Autopilot off for {}", scope_phrase(&scopes)),
            recommendation: None,
            red: None,
            detail: clip_opt(input.said.clone(), TEXT_MAX),
            dedupe: None,
        },
        now,
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ending)
}

/// End every switch whose time has come, with one log row each. Returns them.
pub fn expire(conn: &Connection, now: i64) -> rusqlite::Result<Vec<Switch>> {
    let mut stmt = conn.prepare("SELECT * FROM autopilot_switches WHERE until_ms <= ?1")?;
    let ended: Vec<Switch> = stmt
        .query_map([now], switch_from)?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    if ended.is_empty() {
        return Ok(ended);
    }
    let tx = conn.unchecked_transaction()?;
    for switch in &ended {
        tx.execute(
            "DELETE FROM autopilot_switches WHERE scope = ?1 AND until_ms <= ?2",
            params![switch.scope, now],
        )?;
        add_log_in(
            &tx,
            &LogInput {
                kind: "switch".into(),
                outcome: "ended".into(),
                project: (switch.scope != EVERYTHING).then(|| switch.scope.clone()),
                chat_id: None,
                mono_id: None,
                who: Some("Autopilot".into()),
                what: format!(
                    "Autopilot ended for {} at its end time",
                    scope_phrase(std::slice::from_ref(&switch.scope))
                ),
                recommendation: None,
                red: None,
                detail: None,
                // One "ended" row per switch, even if two threads see it at once.
                dedupe: Some(format!("ended:{}:{}", switch.scope, switch.until_ms)),
            },
            now,
        )?;
    }
    tx.commit()?;
    Ok(ended)
}

/// When the next switch ends, if any is on.
pub fn next_end(switches: &[Switch]) -> Option<i64> {
    switches.iter().map(|s| s.until_ms).min()
}

/// The time the watcher stays loaded: the last end time of any switch.
pub fn last_end(switches: &[Switch]) -> Option<i64> {
    switches.iter().map(|s| s.until_ms).max()
}

fn scope_phrase(scopes: &[String]) -> String {
    if scopes.iter().any(|s| s == EVERYTHING) {
        "everything".into()
    } else {
        scopes.join(", ")
    }
}

// ---- log ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub at: i64,
    /// `decision` (app autopilot.decide), `question` (a chat's question), `approval`, `switch`, `resume`, `relaunch`.
    pub kind: String,
    /// `taken`, `held` (red list: it waits for Ash), `handed_back`, `on`, `off`, `ended`, `armed`, `resumed`,
    /// `gave_up`, `relaunched`.
    pub outcome: String,
    pub project: Option<String>,
    pub chat_id: Option<String>,
    pub mono_id: Option<String>,
    pub who: Option<String>,
    pub what: String,
    pub recommendation: Option<String>,
    pub red: Option<String>,
    pub detail: Option<String>,
}

fn entry_from(row: &Row<'_>) -> rusqlite::Result<LogEntry> {
    Ok(LogEntry {
        id: row.get("id")?,
        at: row.get("at")?,
        kind: row.get("kind")?,
        outcome: row.get("outcome")?,
        project: row.get("project")?,
        chat_id: row.get("chat_id")?,
        mono_id: row.get("mono_id")?,
        who: row.get("who")?,
        what: row.get("what")?,
        recommendation: row.get("recommendation")?,
        red: row.get("red")?,
        detail: row.get("detail")?,
    })
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogInput {
    pub kind: String,
    pub outcome: String,
    pub project: Option<String>,
    pub chat_id: Option<String>,
    pub mono_id: Option<String>,
    pub who: Option<String>,
    pub what: String,
    pub recommendation: Option<String>,
    pub red: Option<String>,
    pub detail: Option<String>,
    /// A key for "this call": a second report of the same call adds nothing.
    pub dedupe: Option<String>,
}

const KINDS: [&str; 6] = [
    "decision", "question", "approval", "switch", "resume", "relaunch",
];
const OUTCOMES: [&str; 11] = [
    "taken",
    "held",
    "handed_back",
    "on",
    "off",
    "ended",
    "armed",
    "resumed",
    "gave_up",
    "relaunched",
    "cancelled",
];

fn add_log_in(conn: &Connection, input: &LogInput, now: i64) -> rusqlite::Result<Option<LogEntry>> {
    let id = format!("ap-{}", uuid::Uuid::new_v4().simple());
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO autopilot_log
           (id, at, kind, outcome, project, chat_id, mono_id, who, what, recommendation, red, detail, dedupe)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            now,
            input.kind,
            input.outcome,
            clip_opt(input.project.clone(), SHORT_MAX),
            clip_opt(input.chat_id.clone(), SHORT_MAX),
            clip_opt(input.mono_id.clone(), SHORT_MAX),
            clip_opt(input.who.clone(), SHORT_MAX),
            clip(&input.what, TEXT_MAX),
            clip_opt(input.recommendation.clone(), TEXT_MAX),
            clip_opt(input.red.clone(), SHORT_MAX),
            clip_opt(input.detail.clone(), TEXT_MAX),
            clip_opt(input.dedupe.clone(), SHORT_MAX),
        ],
    )?;
    if inserted == 0 {
        return Ok(None);
    }
    prune_log(conn, now)?;
    conn.query_row(
        "SELECT * FROM autopilot_log WHERE id = ?1",
        [&id],
        entry_from,
    )
    .optional()
}

/// Rows older than [`LOG_KEEP_MS`] that aren't among the newest [`LOG_KEEP_ROWS`] go.
fn prune_log(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM autopilot_log WHERE at < ?1 AND rowid NOT IN
           (SELECT rowid FROM autopilot_log ORDER BY at DESC, rowid DESC LIMIT ?2)",
        params![now - LOG_KEEP_MS, LOG_KEEP_ROWS],
    )
}

/// One log row. `None` when `dedupe` says this call is already in the log.
pub fn add_log(conn: &Connection, input: &LogInput, now: i64) -> Result<Option<LogEntry>, String> {
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(format!("Unknown autopilot log kind: {}", input.kind));
    }
    if !OUTCOMES.contains(&input.outcome.as_str()) {
        return Err(format!("Unknown autopilot outcome: {}", input.outcome));
    }
    if input.what.trim().is_empty() {
        return Err("A log row says what was decided".into());
    }
    add_log_in(conn, input, now).map_err(|e| e.to_string())
}

/// Newest first; `before` pages back.
pub fn list_log(
    conn: &Connection,
    limit: usize,
    before: Option<i64>,
) -> rusqlite::Result<Vec<LogEntry>> {
    let limit = limit.clamp(1, LOG_PAGE_MAX) as i64;
    let mut stmt = conn.prepare(
        "SELECT * FROM autopilot_log WHERE at < ?1 ORDER BY at DESC, rowid DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![before.unwrap_or(i64::MAX), limit], entry_from)?;
    rows.collect()
}

fn unseen_count(conn: &Connection, since: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT count(*) FROM autopilot_log WHERE at > ?1 AND kind IN ('decision', 'question', 'approval')",
        [since],
        |row| row.get(0),
    )
}

// ---- settings ----------------------------------------------------------------------------------------------------------

/// Auto-resume at a usage-limit reset: on by default for agents' chats, with a per-project override.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoResume {
    pub default: bool,
    #[serde(default)]
    pub projects: BTreeMap<String, bool>,
}

impl Default for AutoResume {
    fn default() -> Self {
        Self {
            default: true,
            projects: BTreeMap::new(),
        }
    }
}

fn setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM autopilot_settings WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
}

fn put_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO autopilot_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
}

pub fn auto_resume(conn: &Connection) -> rusqlite::Result<AutoResume> {
    Ok(setting(conn, "autoResume")?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoResumeInput {
    /// Set the default for every project.
    pub default: Option<bool>,
    /// Set one project's override; `value: None` clears it back to the default.
    pub project: Option<String>,
    pub value: Option<bool>,
}

pub fn set_auto_resume(conn: &Connection, input: &AutoResumeInput) -> Result<AutoResume, String> {
    let mut current = auto_resume(conn).map_err(|e| e.to_string())?;
    if let Some(default) = input.default {
        current.default = default;
    }
    if let Some(project) = input.project.as_deref().map(str::trim) {
        if !valid_scope(project) || project == EVERYTHING {
            return Err(format!("Not a project id: {project}"));
        }
        match input.value {
            Some(value) => {
                current.projects.insert(project.to_string(), value);
            }
            None => {
                current.projects.remove(project);
            }
        }
    }
    let raw = serde_json::to_string(&current).map_err(|e| e.to_string())?;
    put_setting(conn, "autoResume", &raw).map_err(|e| e.to_string())?;
    Ok(current)
}

fn last_seen(conn: &Connection) -> rusqlite::Result<i64> {
    Ok(setting(conn, "logSeenAt")?
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(0))
}

// ---- resumes -----------------------------------------------------------------------------------------------------------

pub const ARMED: &str = "armed";
pub const RESUMED: &str = "resumed";
pub const GAVE_UP: &str = "gave_up";
pub const CANCELLED: &str = "cancelled";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    pub session_id: String,
    pub resets_at: i64,
    pub resume_at: i64,
    pub attempts: i64,
    pub state: String,
    pub title: Option<String>,
    pub armed_at: i64,
    pub updated_at: i64,
}

fn resume_from(row: &Row<'_>) -> rusqlite::Result<Resume> {
    Ok(Resume {
        session_id: row.get("session_id")?,
        resets_at: row.get("resets_at")?,
        resume_at: row.get("resume_at")?,
        attempts: row.get("attempts")?,
        state: row.get("state")?,
        title: row.get("title")?,
        armed_at: row.get("armed_at")?,
        updated_at: row.get("updated_at")?,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmInput {
    pub session_id: String,
    pub resets_at: i64,
    pub resume_at: i64,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArmResult {
    pub armed: bool,
    pub resume: Option<Resume>,
    /// Why it wasn't armed, in plain words.
    pub reason: Option<String>,
}

fn get_resume(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<Resume>> {
    conn.query_row(
        "SELECT * FROM autopilot_resumes WHERE session_id = ?1",
        [session_id],
        resume_from,
    )
    .optional()
}

/// Arm a chat's resume at its limit's reset. The same limit armed twice is one arming; a new limit after a resume that
/// never finished a turn is one more attempt, and past [`MAX_AUTO_RESUMES`] the chat waits for Ash.
pub fn arm_resume(conn: &Connection, input: &ArmInput, now: i64) -> Result<ArmResult, String> {
    crate::session_store::validate_id(&input.session_id, "session id")?;
    // T3's guard: a reset already in the past can't start a retry loop.
    if input.resets_at <= now {
        return Ok(ArmResult {
            armed: false,
            resume: None,
            reason: Some("The reset time has already passed".into()),
        });
    }
    let resume_at = input.resume_at.max(input.resets_at);
    let existing = get_resume(conn, &input.session_id).map_err(|e| e.to_string())?;
    let attempts = match &existing {
        None => 1,
        Some(row) if row.state == CANCELLED => 1,
        Some(row) if row.state == ARMED && row.resets_at == input.resets_at => {
            return Ok(ArmResult {
                armed: true,
                resume: Some(row.clone()),
                reason: None,
            })
        }
        Some(row) if row.state == GAVE_UP => {
            return Ok(ArmResult {
                armed: false,
                resume: Some(row.clone()),
                reason: Some(format!(
                    "It stopped at a usage limit {} times in a row; it waits for you now",
                    row.attempts
                )),
            })
        }
        Some(row) => row.attempts + 1,
    };
    let state = if attempts > MAX_AUTO_RESUMES {
        GAVE_UP
    } else {
        ARMED
    };
    conn.execute(
        "INSERT INTO autopilot_resumes (session_id, resets_at, resume_at, attempts, state, title, armed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(session_id) DO UPDATE SET resets_at = excluded.resets_at, resume_at = excluded.resume_at,
           attempts = excluded.attempts, state = excluded.state, title = COALESCE(excluded.title, title),
           armed_at = excluded.armed_at, updated_at = excluded.updated_at",
        params![
            input.session_id,
            input.resets_at,
            resume_at,
            attempts.min(MAX_AUTO_RESUMES + 1),
            state,
            clip_opt(input.title.clone(), SHORT_MAX),
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    let row = get_resume(conn, &input.session_id).map_err(|e| e.to_string())?;
    Ok(if state == GAVE_UP {
        ArmResult {
            armed: false,
            resume: row,
            reason: Some(format!(
                "It stopped at a usage limit {MAX_AUTO_RESUMES} times in a row; it waits for you now"
            )),
        }
    } else {
        ArmResult {
            armed: true,
            resume: row,
            reason: None,
        }
    })
}

/// `resumed` (the continue went out), `cancelled` (a newer message or Ash beat it), `finished` (a turn finished after
/// the resume: the row goes and the attempt count starts again).
pub fn settle_resume(
    conn: &Connection,
    session_id: &str,
    outcome: &str,
    now: i64,
) -> Result<Option<Resume>, String> {
    match outcome {
        "finished" => {
            conn.execute(
                "DELETE FROM autopilot_resumes WHERE session_id = ?1",
                [session_id],
            )
            .map_err(|e| e.to_string())?;
            Ok(None)
        }
        RESUMED | CANCELLED => {
            conn.execute(
                "UPDATE autopilot_resumes SET state = ?2, updated_at = ?3 WHERE session_id = ?1",
                params![session_id, outcome, now],
            )
            .map_err(|e| e.to_string())?;
            get_resume(conn, session_id).map_err(|e| e.to_string())
        }
        other => Err(format!("Unknown resume outcome: {other}")),
    }
}

/// Every resume still owed or in progress (cancelled rows are history).
pub fn open_resumes(conn: &Connection) -> rusqlite::Result<Vec<Resume>> {
    let mut stmt = conn
        .prepare("SELECT * FROM autopilot_resumes WHERE state != 'cancelled' ORDER BY resume_at")?;
    let rows = stmt.query_map([], resume_from)?;
    rows.collect()
}

// ---- keep-awake --------------------------------------------------------------------------------------------------------

/// Something that keeps the Mac from idle sleep while held. Tests use a fake that counts.
pub trait Wake: Send {
    fn hold(&mut self, reason: &str) -> Result<(), String>;
    fn release(&mut self);
    fn held(&self) -> bool;
    fn supported(&self) -> bool {
        true
    }
}

/// No power management here (other platforms).
#[derive(Default)]
pub struct NoWake;

impl Wake for NoWake {
    fn hold(&mut self, _reason: &str) -> Result<(), String> {
        Err("Keeping the computer awake isn't supported here".into())
    }
    fn release(&mut self) {}
    fn held(&self) -> bool {
        false
    }
    fn supported(&self) -> bool {
        false
    }
}

#[cfg(target_os = "macos")]
mod power {
    use std::ffi::{c_void, CString};
    use std::os::raw::c_char;

    type CfStringRef = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CfStringRef,
            level: u32,
            name: CfStringRef,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    const UTF8: u32 = 0x0800_0100;
    const LEVEL_ON: u32 = 255;
    /// What `caffeinate -i` takes: no idle system sleep; the display may still sleep.
    const TYPE: &str = "PreventUserIdleSystemSleep";

    struct CfString(CfStringRef);
    impl CfString {
        fn new(text: &str) -> Option<Self> {
            let c = CString::new(text.replace('\0', " ")).ok()?;
            let raw = unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) };
            (!raw.is_null()).then_some(Self(raw))
        }
    }
    impl Drop for CfString {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }

    /// An IOPMAssertion held by this process. macOS drops it with the process, so a crash never leaves the Mac awake.
    #[derive(Default)]
    pub struct PowerAssertion {
        id: Option<u32>,
    }

    impl super::Wake for PowerAssertion {
        fn hold(&mut self, reason: &str) -> Result<(), String> {
            if self.id.is_some() {
                return Ok(());
            }
            let kind = CfString::new(TYPE).ok_or("Couldn't name the power assertion")?;
            let name = CfString::new(reason).ok_or("Couldn't name the power assertion")?;
            let mut id: u32 = 0;
            let result = unsafe { IOPMAssertionCreateWithName(kind.0, LEVEL_ON, name.0, &mut id) };
            if result != 0 {
                return Err(format!("macOS refused the power assertion ({result:#x})"));
            }
            self.id = Some(id);
            Ok(())
        }

        fn release(&mut self) {
            if let Some(id) = self.id.take() {
                unsafe { IOPMAssertionRelease(id) };
            }
        }

        fn held(&self) -> bool {
            self.id.is_some()
        }
    }

    impl Drop for PowerAssertion {
        fn drop(&mut self) {
            super::Wake::release(self);
        }
    }
}

fn platform_wake() -> Box<dyn Wake> {
    #[cfg(target_os = "macos")]
    {
        Box::new(power::PowerAssertion::default())
    }
    #[cfg(not(target_os = "macos"))]
    {
        // WP-09: Windows SetThreadExecutionState, Linux systemd-inhibit. Anything else stays NoWake.
        crate::platform::wake::current()
    }
}

/// The name macOS shows for the assertion (`pmset -g assertions`).
pub fn wake_reason(switches: &[Switch]) -> String {
    format!(
        "MonoCode Hub autopilot ({})",
        scope_phrase(&switches.iter().map(|s| s.scope.clone()).collect::<Vec<_>>())
    )
}

/// Hold while anything is on, release when nothing is. Returns whether it is held, and why not when it should be.
pub fn sync_wake(wake: &mut dyn Wake, switches: &[Switch]) -> Result<bool, String> {
    if switches.is_empty() {
        wake.release();
        return Ok(false);
    }
    wake.hold(&wake_reason(switches))?;
    Ok(wake.held())
}

// ---- relaunch after a crash --------------------------------------------------------------------------------------------

/// Where the watcher's LaunchAgent lives and what it runs.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentPlan {
    pub label: String,
    pub domain: String,
    pub plist: PathBuf,
    pub program: PathBuf,
    pub data_dir: PathBuf,
    pub home: PathBuf,
}

/// Whether this copy may relaunch itself, and why not.
pub fn relaunch_support(
    kind: instance::Kind,
    isolated_home: bool,
    macos: bool,
) -> Result<(), &'static str> {
    if !macos {
        return Err("Relaunch after a crash works on macOS only.");
    }
    if kind == instance::Kind::Dev {
        return Err("Dev copies don't relaunch themselves.");
    }
    if isolated_home {
        return Err("Off under a temporary HOME.");
    }
    Ok(())
}

pub fn agent_label(identifier: &str) -> String {
    format!("{identifier}.autopilot-watch")
}

fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The LaunchAgent: run the watcher now and every [`WATCH_INTERVAL_SECS`]. It never keeps the app alive itself
/// (no KeepAlive on the app): the watcher decides, so a ⌘Q or a Ship is never undone.
pub fn agent_plist(plan: &AgentPlan) -> String {
    let log = plan.data_dir.join(DIR).join(WATCH_LOG);
    let args = [
        plan.program.to_string_lossy().into_owned(),
        "autopilot-watch".to_string(),
        plan.data_dir.to_string_lossy().into_owned(),
    ]
    .iter()
    .map(|arg| format!("    <string>{}</string>", xml(arg)))
    .collect::<Vec<_>>()
    .join("\n");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>{home}</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>{home}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>{interval}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        label = xml(&plan.label),
        home = xml(&plan.home.to_string_lossy()),
        interval = WATCH_INTERVAL_SECS,
        log = xml(&log.to_string_lossy()),
    )
}

/// launchctl, behind a seam so tests never touch the real user's launchd.
pub trait Launchd: Send + Sync {
    fn bootstrap(&self, domain: &str, plist: &Path) -> Result<(), String>;
    fn bootout(&self, domain: &str, label: &str);
    /// Whether launchd has the label loaded now.
    fn loaded(&self, domain: &str, label: &str) -> bool;
}

pub struct SystemLaunchd;

impl Launchd for SystemLaunchd {
    fn bootstrap(&self, domain: &str, plist: &Path) -> Result<(), String> {
        let output = Command::new("/bin/launchctl")
            .args(["bootstrap", domain])
            .arg(plist)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        // 17 / 37: already loaded, which is what we want.
        if output.status.success() || matches!(output.status.code(), Some(17) | Some(37)) {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    fn bootout(&self, domain: &str, label: &str) {
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", &format!("{domain}/{label}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    fn loaded(&self, domain: &str, label: &str) -> bool {
        Command::new("/bin/launchctl")
            .args(["print", &format!("{domain}/{label}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}

/// What the watcher reads: when to retire, and how.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchFile {
    pub until_ms: i64,
    pub label: String,
    pub domain: String,
    pub plist: PathBuf,
}

/// Put the watcher in place (or move its end time). Idempotent.
pub fn install_agent(launchd: &dyn Launchd, plan: &AgentPlan, until_ms: i64) -> Result<(), String> {
    let dir = plan.data_dir.join(DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_json(
        &dir.join(WATCH_FILE),
        &WatchFile {
            until_ms,
            label: plan.label.clone(),
            domain: plan.domain.clone(),
            plist: plan.plist.clone(),
        },
    )?;
    let text = agent_plist(plan);
    let current = std::fs::read_to_string(&plan.plist).ok();
    if current.as_deref() != Some(text.as_str()) {
        if let Some(parent) = plan.plist.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // A changed watcher: the old one comes out before the new one goes in.
        if launchd.loaded(&plan.domain, &plan.label) {
            launchd.bootout(&plan.domain, &plan.label);
        }
        std::fs::write(&plan.plist, text).map_err(|e| e.to_string())?;
    } else if launchd.loaded(&plan.domain, &plan.label) {
        // The same watcher, already loaded: only its end time moved (the watch file). Bootstrapping a loaded label
        // fails (5 on current macOS, 17 or 37 on older ones), so it isn't tried.
        return Ok(());
    }
    match launchd.bootstrap(&plan.domain, &plan.plist) {
        Ok(()) => Ok(()),
        // Loaded after all (another sync got there first): what we want.
        Err(_) if launchd.loaded(&plan.domain, &plan.label) => Ok(()),
        Err(error) => Err(error),
    }
}

/// Take the watcher away. Safe to call when it isn't there. The files go first, whatever launchd says (without its watch
/// file the watcher does nothing; without its plist it doesn't come back at login; and a watcher retiring itself is
/// stopped by its own bootout); it is gone only once launchd no longer has it loaded and both files are gone.
pub fn remove_agent(
    launchd: &dyn Launchd,
    label: &str,
    domain: &str,
    plist: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let mut problems = Vec::new();
    for file in [plist.to_path_buf(), data_dir.join(DIR).join(WATCH_FILE)] {
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => problems.push(format!("{}: {error}", file.display())),
        }
    }
    launchd.bootout(domain, label);
    if launchd.loaded(domain, label) {
        problems.push(format!("launchd still has {label} loaded"));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let temporary = path.with_extension(format!("json.{}", std::process::id()));
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The marker a normal quit leaves: the watcher never reopens an app that was quit on purpose (⌘Q, a Ship).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanExit {
    pub pid: u32,
    pub at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Relaunches {
    #[serde(default)]
    pub at: Vec<i64>,
    /// The watcher stopped trying at this time (too many crashes in a row).
    pub gave_up_at: Option<i64>,
    /// The newest relaunch or give-up the app has already logged.
    #[serde(default)]
    pub logged_through: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WatchInput {
    pub until_ms: i64,
    /// The process `running.json` names is alive.
    pub app_alive: bool,
    /// That process left a clean-exit marker.
    pub clean_exit: bool,
    pub ship_in_progress: bool,
    pub relaunches: Relaunches,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    /// Nothing to do, and why.
    Idle(&'static str),
    Relaunch,
    /// Too many crashes in a row: stop, and say so once.
    GiveUp,
    /// Autopilot is over: take the LaunchAgent away.
    Retire,
}

pub fn watch_verdict(input: &WatchInput, now: i64) -> Verdict {
    if input.until_ms <= now {
        return Verdict::Retire;
    }
    if input.app_alive {
        return Verdict::Idle("running");
    }
    if input.ship_in_progress {
        return Verdict::Idle("a ship is replacing the app");
    }
    if input.clean_exit {
        return Verdict::Idle("quit on purpose");
    }
    let recent = input
        .relaunches
        .at
        .iter()
        .filter(|at| now - **at < RELAUNCH_WINDOW_MS)
        .count();
    if recent >= MAX_RELAUNCHES {
        return match input.relaunches.gave_up_at {
            Some(at) if input.relaunches.at.iter().all(|r| *r <= at) => Verdict::Idle("gave up"),
            _ => Verdict::GiveUp,
        };
    }
    Verdict::Relaunch
}

/// A ship that has a state but no receipt is still swapping the app (src/ship.rs): leave the app to it.
fn ship_in_progress(data_dir: &Path, now: i64) -> bool {
    let Ok(entries) = std::fs::read_dir(data_dir.join(crate::ship::SHIP_DIR)) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let dir = entry.path();
        let state = dir.join(crate::ship::STATE);
        let fresh = std::fs::metadata(&state)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .is_some_and(|m| now - (m.as_millis() as i64) < 60 * 60 * 1000);
        fresh && !dir.join(crate::ship::RECEIPT).exists()
    })
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        pid > 0 && unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
    }
    #[cfg(windows)]
    {
        windows_pid_alive(pid)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

/// `OpenProcess` + `GetExitCodeProcess`. A process that has already exited is not alive.
/// Exit code 259 is `STILL_ACTIVE`; a process that really exited with 259 looks alive,
/// and that collision is accepted. Pid 0 is not a process.
#[cfg(windows)]
fn windows_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        let _ = CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

/// `monocode autopilot-watch <data dir>`: what the LaunchAgent runs. No window, no database; it reads the files the app
/// writes and reopens the app only after a crash.
pub fn watch_main(args: &[String]) -> i32 {
    let Some(data_dir) = args.first().map(PathBuf::from) else {
        eprintln!("usage: monocode autopilot-watch <data dir>");
        return 64;
    };
    let now = now_millis();
    let dir = data_dir.join(DIR);
    let Some(watch) = read_json::<WatchFile>(&dir.join(WATCH_FILE)) else {
        // Nothing to watch for: the app took autopilot away and this run raced it.
        return 0;
    };
    let running = instance::read_running(&data_dir);
    let pid = running
        .as_ref()
        .and_then(|r| r.get("pid"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let bundle = running
        .as_ref()
        .and_then(|r| r.get("bundlePath"))
        .and_then(Value::as_str)
        .map(PathBuf::from);
    // pid and start time together name one process; a reused pid isn't the app.
    let started = running
        .as_ref()
        .and_then(|r| r.get("startTime"))
        .and_then(Value::as_u64);
    let alive = pid_alive(pid)
        && match (started, instance::process_start_ms(pid)) {
            (Some(recorded), Some(actual)) => recorded.abs_diff(actual) < 2_000,
            _ => true,
        };
    let clean = read_json::<CleanExit>(&dir.join(CLEAN_EXIT_FILE));
    let mut relaunches = read_json::<Relaunches>(&dir.join(RELAUNCHES_FILE)).unwrap_or_default();
    let input = WatchInput {
        until_ms: watch.until_ms,
        app_alive: alive,
        clean_exit: clean.is_some_and(|c| c.pid == pid),
        ship_in_progress: ship_in_progress(&data_dir, now),
        relaunches: relaunches.clone(),
    };
    match watch_verdict(&input, now) {
        Verdict::Idle(_) => 0,
        Verdict::Retire => {
            println!("autopilot-watch: autopilot ended; removing {}", watch.label);
            // macOS takes the LaunchAgent out. Everywhere else, the task or the unit.
            #[cfg(target_os = "macos")]
            let removed = remove_agent(
                &SystemLaunchd,
                &watch.label,
                &watch.domain,
                &watch.plist,
                &data_dir,
            );
            #[cfg(not(target_os = "macos"))]
            let removed = crate::platform::relaunch::remove(&watch.label, &watch.plist, &data_dir);
            if let Err(error) = removed {
                eprintln!("autopilot-watch: {error}");
            }
            0
        }
        Verdict::GiveUp => {
            println!("autopilot-watch: {MAX_RELAUNCHES} crashes in a row; not reopening again");
            relaunches.gave_up_at = Some(now);
            let _ = write_json(&dir.join(RELAUNCHES_FILE), &relaunches);
            0
        }
        Verdict::Relaunch => {
            let Some(bundle) =
                bundle.filter(|b| b.extension().is_some_and(|e| e == "app") && b.exists())
            else {
                eprintln!("autopilot-watch: running.json names no app to reopen");
                return 1;
            };
            relaunches.at.retain(|at| now - *at < RELAUNCH_WINDOW_MS);
            relaunches.at.push(now);
            let _ = write_json(&dir.join(RELAUNCHES_FILE), &relaunches);
            println!(
                "autopilot-watch: the app stopped without quitting; reopening {}",
                bundle.display()
            );
            // macOS stays on Launch Services. Windows and Linux run the bundle binary
            // (`monocode.exe` where the build produced one).
            #[cfg(target_os = "macos")]
            {
                match Command::new("/usr/bin/open").arg(&bundle).status() {
                    Ok(status) if status.success() => 0,
                    Ok(status) => status.code().unwrap_or(1),
                    Err(error) => {
                        eprintln!("autopilot-watch: open failed: {error}");
                        1
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                match crate::platform::ship::spawn_app(&bundle) {
                    Ok(()) => 0,
                    Err(error) => {
                        eprintln!("autopilot-watch: open failed: {error}");
                        1
                    }
                }
            }
        }
    }
}

// ---- the running app ---------------------------------------------------------------------------------------------------

/// What the hub screen shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub switches: Vec<Switch>,
    pub awake: AwakeStatus,
    pub relaunch: RelaunchStatus,
    pub auto_resume: AutoResume,
    pub log_seen_at: i64,
    /// Decisions logged since Ash last looked.
    pub unseen: i64,
    /// This start was the watcher reopening the app after a crash (for WP5's crash-loop cap and the resume note).
    pub relaunched_after_crash: bool,
    pub now: i64,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AwakeStatus {
    pub supported: bool,
    pub held: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelaunchStatus {
    pub supported: bool,
    /// The watcher is in place.
    pub installed: bool,
    /// Why it isn't, in plain words.
    pub reason: Option<String>,
}

/// One per app: the assertion, the watcher plan and the timer's wake-up.
pub struct Autopilot {
    wake: Mutex<Box<dyn Wake>>,
    awake_error: Mutex<Option<String>>,
    relaunch: Result<AgentPlan, String>,
    installed: Mutex<bool>,
    #[cfg(target_os = "macos")]
    launchd: Box<dyn Launchd>,
    signal: Arc<(Mutex<u64>, Condvar)>,
    relaunched_after_crash: bool,
}

impl Autopilot {
    fn poke(&self) {
        let (lock, cvar) = &*self.signal;
        if let Ok(mut generation) = lock.lock() {
            *generation = generation.wrapping_add(1);
            cvar.notify_all();
        }
    }
}

fn launch_domain() -> String {
    #[cfg(unix)]
    {
        let uid = unsafe { libc::getuid() };
        let gui = Command::new("/bin/launchctl")
            .args(["print", &format!("gui/{uid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if gui {
            format!("gui/{uid}")
        } else {
            format!("user/{uid}")
        }
    }
    #[cfg(not(unix))]
    {
        String::new()
    }
}

fn plan_for(identity: &instance::Identity, data_dir: &Path) -> Result<AgentPlan, String> {
    relaunch_support(
        identity.kind,
        instance::isolated_home().is_some(),
        // WP-09: the same decision on Windows and Linux. On macOS this is still true.
        cfg!(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux"
        )),
    )
    .map_err(str::to_string)?;
    let home = dirs::home_dir().ok_or("No home folder")?;
    let program = std::env::current_exe().map_err(|e| e.to_string())?;
    let label = agent_label(&identity.identifier);
    Ok(AgentPlan {
        plist: crate::platform::relaunch::agent_file(&home, &label),
        label,
        domain: launch_domain(),
        program,
        data_dir: data_dir.to_path_buf(),
        home,
    })
}

/// At start: log what the watcher did while the app was down, and say whether this start is its relaunch.
fn note_relaunches(conn: &Connection, data_dir: &Path, now: i64) -> bool {
    let path = data_dir.join(DIR).join(RELAUNCHES_FILE);
    let Some(mut relaunches) = read_json::<Relaunches>(&path) else {
        return false;
    };
    let newest = relaunches.at.iter().copied().max().unwrap_or(0);
    let mut relaunched = false;
    if newest > relaunches.logged_through {
        relaunched = now - newest < 5 * 60 * 1000;
        let _ = add_log(
            conn,
            &LogInput {
                kind: "relaunch".into(),
                outcome: "relaunched".into(),
                who: Some("Autopilot".into()),
                what: "Reopened MonoCode Hub after it stopped without quitting".into(),
                dedupe: Some(format!("relaunch:{newest}")),
                ..LogInput::default()
            },
            newest,
        );
        relaunches.logged_through = newest;
    }
    if let Some(at) = relaunches
        .gave_up_at
        .filter(|at| *at > relaunches.logged_through)
    {
        let _ = add_log(
            conn,
            &LogInput {
                kind: "relaunch".into(),
                outcome: "gave_up".into(),
                who: Some("Autopilot".into()),
                what: format!(
                    "Stopped reopening the app after {MAX_RELAUNCHES} crashes in {} minutes",
                    RELAUNCH_WINDOW_MS / 60_000
                ),
                dedupe: Some(format!("relaunch-gave-up:{at}")),
                ..LogInput::default()
            },
            at,
        );
        relaunches.logged_through = relaunches.logged_through.max(at);
    }
    let _ = write_json(&path, &relaunches);
    relaunched
}

/// Bring the assertion and the watcher in line with the switches. Called after every change and by the timer.
fn sync(app: &AppHandle, what: &str) {
    let Some(state) = app.try_state::<Autopilot>() else {
        return;
    };
    let store = app.state::<SessionStore>();
    let now = now_millis();
    let switches = match store.lock_conn() {
        Ok(conn) => {
            if let Ok(ended) = expire(&conn, now) {
                if !ended.is_empty() {
                    let _ = app.emit(CHANGED, json!({ "what": "log" }));
                }
            }
            active_switches(&conn, now).unwrap_or_default()
        }
        Err(_) => return,
    };
    if let Ok(mut wake) = state.wake.lock() {
        let result = sync_wake(wake.as_mut(), &switches);
        if let Ok(mut error) = state.awake_error.lock() {
            *error = result.err();
        }
    }
    if let (Ok(plan), Ok(mut installed)) = (&state.relaunch, state.installed.lock()) {
        // WP-09: macOS keeps launchd. Windows and Linux install their own watcher.
        #[cfg(target_os = "macos")]
        sync_agent(
            state.launchd.as_ref(),
            plan,
            &mut installed,
            last_end(&switches),
        );
        #[cfg(not(target_os = "macos"))]
        crate::platform::relaunch::sync_watcher(
            &plan.label,
            &plan.program,
            &plan.data_dir,
            &plan.plist,
            &plan.domain,
            &mut installed,
            last_end(&switches),
        );
    }
    state.poke();
    let _ = app.emit(CHANGED, json!({ "what": what }));
}

/// The relaunch watcher in line with the switches: in place until `until` while one is on, gone when none is.
/// `installed` says it may be in place. Only a removal that worked clears it, so a failed install never hides a watcher
/// that is still loaded from an earlier one, and switching off always takes it away; a half-done install (its plist
/// written) is taken away too.
#[cfg(target_os = "macos")]
fn sync_agent(launchd: &dyn Launchd, plan: &AgentPlan, installed: &mut bool, until: Option<i64>) {
    match until {
        Some(until) => match install_agent(launchd, plan, until) {
            Ok(()) => *installed = true,
            Err(error) => {
                eprintln!("Autopilot: couldn't install the relaunch watcher: {error}");
                if launchd.loaded(&plan.domain, &plan.label) {
                    *installed = true;
                }
            }
        },
        None if *installed || plan.plist.exists() => match remove_agent(
            launchd,
            &plan.label,
            &plan.domain,
            &plan.plist,
            &plan.data_dir,
        ) {
            Ok(()) => *installed = false,
            Err(error) => {
                eprintln!("Autopilot: couldn't remove the relaunch watcher (tried again): {error}");
                *installed = true;
            }
        },
        None => {}
    }
}

/// Ends each switch at its end time, even if no window is open.
fn spawn_timer(app: AppHandle, signal: Arc<(Mutex<u64>, Condvar)>) {
    let spawned = std::thread::Builder::new()
        .name("autopilot-timer".into())
        .spawn(move || loop {
            let now = now_millis();
            let next = app
                .state::<SessionStore>()
                .lock_conn()
                .ok()
                .and_then(|conn| active_switches(&conn, now).ok())
                .and_then(|switches| next_end(&switches));
            // Wake at the next end time, and at least every minute: timers drift while the Mac sleeps.
            let wait = next
                .map(|until| (until - now).clamp(0, 60_000) as u64)
                .unwrap_or(60_000);
            let (lock, cvar) = &*signal;
            if let Ok(generation) = lock.lock() {
                let seen = *generation;
                let _ = cvar.wait_timeout_while(
                    generation,
                    Duration::from_millis(wait.max(250)),
                    |g| *g == seen,
                );
            }
            // A watcher still on the books with nothing on (its removal failed) is tried again each minute.
            let removal_due = next.is_none()
                && app
                    .try_state::<Autopilot>()
                    .is_some_and(|state| state.installed.lock().is_ok_and(|i| *i));
            if next.is_some_and(|until| until <= now_millis()) || removal_due {
                sync(&app, "switches");
            }
        });
    if let Err(error) = spawned {
        eprintln!("Could not start the autopilot timer: {error}");
    }
}

pub(crate) fn init(app: &AppHandle, identity: &instance::Identity, data_dir: PathBuf) {
    let now = now_millis();
    let relaunched = app
        .state::<SessionStore>()
        .lock_conn()
        .map(|conn| note_relaunches(&conn, &data_dir, now))
        .unwrap_or(false);
    // A fresh start of the app is never a clean exit any more.
    let _ = std::fs::remove_file(data_dir.join(DIR).join(CLEAN_EXIT_FILE));
    let relaunch = plan_for(identity, &data_dir);
    // A watcher left from an earlier run (autopilot ended while the app was closed) is cleaned up by the first sync.
    let installed = relaunch.as_ref().is_ok_and(|plan| plan.plist.exists());
    let signal = Arc::new((Mutex::new(0u64), Condvar::new()));
    app.manage(Autopilot {
        wake: Mutex::new(platform_wake()),
        awake_error: Mutex::new(None),
        relaunch,
        installed: Mutex::new(installed),
        #[cfg(target_os = "macos")]
        launchd: Box::new(SystemLaunchd),
        signal: signal.clone(),
        relaunched_after_crash: relaunched,
    });
    sync(app, "boot");
    spawn_timer(app.clone(), signal);
}

/// A normal quit: tell the watcher not to reopen this process.
pub(crate) fn on_exit(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let dir = data_dir.join(DIR);
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = write_json(
            &dir.join(CLEAN_EXIT_FILE),
            &CleanExit {
                pid: std::process::id(),
                at: now_millis(),
            },
        );
    }
}

fn status(app: &AppHandle, conn: &Connection) -> Result<Status, String> {
    let now = now_millis();
    let switches = active_switches(conn, now).map_err(|e| e.to_string())?;
    let seen = last_seen(conn).map_err(|e| e.to_string())?;
    let (awake, relaunch, relaunched) = match app.try_state::<Autopilot>() {
        Some(state) => {
            let wake = state.wake.lock().map_err(|_| "Autopilot is locked")?;
            let installed = *state.installed.lock().map_err(|_| "Autopilot is locked")?;
            (
                AwakeStatus {
                    supported: wake.supported(),
                    held: wake.held(),
                    error: state.awake_error.lock().ok().and_then(|e| e.clone()),
                },
                match &state.relaunch {
                    Ok(_) => RelaunchStatus {
                        supported: true,
                        installed,
                        reason: None,
                    },
                    Err(reason) => RelaunchStatus {
                        supported: false,
                        installed: false,
                        reason: Some(reason.clone()),
                    },
                },
                state.relaunched_after_crash,
            )
        }
        None => (AwakeStatus::default(), RelaunchStatus::default(), false),
    };
    Ok(Status {
        switches,
        awake,
        relaunch,
        auto_resume: auto_resume(conn).map_err(|e| e.to_string())?,
        log_seen_at: seen,
        unseen: unseen_count(conn, seen).map_err(|e| e.to_string())?,
        relaunched_after_crash: relaunched,
        now,
    })
}

// ---- Tauri commands ----------------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub fn autopilot_status(app: AppHandle, store: State<'_, SessionStore>) -> Result<Status, String> {
    let conn = store.lock_conn()?;
    status(&app, &conn)
}

#[tauri::command(async)]
pub fn autopilot_set(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: SetInput,
) -> Result<Status, String> {
    {
        let conn = store.lock_conn()?;
        set_switches(&conn, &input, now_millis())?;
    }
    sync(&app, "switches");
    let conn = store.lock_conn()?;
    status(&app, &conn)
}

#[tauri::command(async)]
pub fn autopilot_off(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: OffInput,
) -> Result<Status, String> {
    {
        let conn = store.lock_conn()?;
        remove_switches(&conn, &input, now_millis())?;
    }
    sync(&app, "switches");
    let conn = store.lock_conn()?;
    status(&app, &conn)
}

#[tauri::command(async)]
pub fn autopilot_log_add(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: LogInput,
) -> Result<Option<LogEntry>, String> {
    let entry = add_log(&*store.lock_conn()?, &input, now_millis())?;
    if entry.is_some() {
        let _ = app.emit(CHANGED, json!({ "what": "log" }));
    }
    Ok(entry)
}

#[tauri::command(async)]
pub fn autopilot_log_list(
    store: State<'_, SessionStore>,
    limit: Option<usize>,
    before: Option<i64>,
) -> Result<Vec<LogEntry>, String> {
    list_log(&*store.lock_conn()?, limit.unwrap_or(200), before).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn autopilot_log_seen(
    app: AppHandle,
    store: State<'_, SessionStore>,
    at: i64,
) -> Result<(), String> {
    let conn = store.lock_conn()?;
    let at = at
        .min(now_millis())
        .max(last_seen(&conn).map_err(|e| e.to_string())?);
    put_setting(&conn, "logSeenAt", &at.to_string()).map_err(|e| e.to_string())?;
    let _ = app.emit(CHANGED, json!({ "what": "seen" }));
    Ok(())
}

#[tauri::command(async)]
pub fn autopilot_auto_resume_set(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: AutoResumeInput,
) -> Result<AutoResume, String> {
    let value = set_auto_resume(&*store.lock_conn()?, &input)?;
    let _ = app.emit(CHANGED, json!({ "what": "settings" }));
    Ok(value)
}

#[tauri::command(async)]
pub fn autopilot_resume_arm(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: ArmInput,
) -> Result<ArmResult, String> {
    let result = arm_resume(&*store.lock_conn()?, &input, now_millis())?;
    let _ = app.emit(CHANGED, json!({ "what": "resumes" }));
    Ok(result)
}

#[tauri::command(async)]
pub fn autopilot_resume_settle(
    app: AppHandle,
    store: State<'_, SessionStore>,
    session_id: String,
    outcome: String,
) -> Result<Option<Resume>, String> {
    let row = settle_resume(&*store.lock_conn()?, &session_id, &outcome, now_millis())?;
    let _ = app.emit(CHANGED, json!({ "what": "resumes" }));
    Ok(row)
}

#[tauri::command(async)]
pub fn autopilot_resumes(store: State<'_, SessionStore>) -> Result<Vec<Resume>, String> {
    open_resumes(&*store.lock_conn()?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[cfg(windows)]
    #[test]
    fn the_running_process_is_alive_and_pid_zero_is_not() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
    }

    const HOUR: i64 = 60 * 60 * 1000;
    const T0: i64 = 1_760_000_000_000;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    fn set(scopes: &[&str], until: i64) -> SetInput {
        SetInput {
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            until_ms: until,
            by: "ash".into(),
            chat_id: None,
            said: None,
            turn: None,
            who: Some("Ash".into()),
        }
    }

    #[test]
    fn a_switch_is_on_until_its_end_time_and_then_ends_with_a_log_row() {
        let c = conn();
        let on = set_switches(&c, &set(&["*"], T0 + 48 * HOUR), T0).unwrap();
        assert_eq!(on.len(), 1);
        assert_eq!(on[0].scope, "*");
        assert_eq!(active_switches(&c, T0 + 47 * HOUR).unwrap().len(), 1);
        assert!(expire(&c, T0 + 47 * HOUR).unwrap().is_empty());
        let ended = expire(&c, T0 + 48 * HOUR).unwrap();
        assert_eq!(ended.len(), 1);
        assert!(active_switches(&c, T0 + 48 * HOUR).unwrap().is_empty());
        let log = list_log(&c, 10, None).unwrap();
        assert_eq!(log[0].outcome, "ended");
        assert_eq!(log[1].outcome, "on");
        assert_eq!(log[1].what, "Autopilot on for everything");
        // A second sweep at the same moment logs nothing more.
        assert!(expire(&c, T0 + 48 * HOUR).unwrap().is_empty());
        assert_eq!(list_log(&c, 10, None).unwrap().len(), 2);
    }

    #[test]
    fn per_project_switches_keep_their_own_end_times() {
        let c = conn();
        set_switches(&c, &set(&["hivra"], T0 + 2 * HOUR), T0).unwrap();
        set_switches(&c, &set(&["vg-game"], T0 + 5 * HOUR), T0).unwrap();
        let on = active_switches(&c, T0).unwrap();
        assert_eq!(
            on.iter().map(|s| s.scope.as_str()).collect::<Vec<_>>(),
            ["hivra", "vg-game"]
        );
        assert_eq!(next_end(&on), Some(T0 + 2 * HOUR));
        assert_eq!(last_end(&on), Some(T0 + 5 * HOUR));
        expire(&c, T0 + 3 * HOUR).unwrap();
        let on = active_switches(&c, T0 + 3 * HOUR).unwrap();
        assert_eq!(on.len(), 1);
        assert_eq!(on[0].scope, "vg-game");
        // Setting a scope again moves its end time rather than adding a row.
        set_switches(&c, &set(&["vg-game"], T0 + 9 * HOUR), T0 + 3 * HOUR).unwrap();
        assert_eq!(
            active_switches(&c, T0 + 3 * HOUR).unwrap()[0].until_ms,
            T0 + 9 * HOUR
        );
    }

    #[test]
    fn end_times_outside_a_minute_to_fourteen_days_are_refused() {
        let c = conn();
        assert!(set_switches(&c, &set(&["*"], T0 + 30_000), T0).is_err());
        assert!(set_switches(&c, &set(&["*"], T0 + 15 * 24 * HOUR), T0).is_err());
        assert!(set_switches(&c, &set(&[], T0 + HOUR), T0).is_err());
        assert!(set_switches(&c, &set(&["no spaces"], T0 + HOUR), T0).is_err());
        assert!(active_switches(&c, T0).unwrap().is_empty());
        assert!(list_log(&c, 10, None).unwrap().is_empty());
    }

    #[test]
    fn turning_off_ends_the_named_scopes_or_all_of_them() {
        let c = conn();
        set_switches(&c, &set(&["*", "hivra"], T0 + HOUR), T0).unwrap();
        let off = OffInput {
            scopes: vec!["hivra".into()],
            by: "ash".into(),
            chat_id: None,
            said: None,
            who: None,
        };
        assert_eq!(remove_switches(&c, &off, T0).unwrap().len(), 1);
        assert_eq!(active_switches(&c, T0).unwrap().len(), 1);
        let all = OffInput {
            scopes: vec![],
            ..off
        };
        assert_eq!(remove_switches(&c, &all, T0).unwrap().len(), 1);
        assert!(active_switches(&c, T0).unwrap().is_empty());
        // Nothing on: nothing logged.
        assert!(remove_switches(&c, &all, T0).unwrap().is_empty());
        let outcomes: Vec<String> = list_log(&c, 10, None)
            .unwrap()
            .into_iter()
            .map(|e| e.outcome)
            .collect();
        assert_eq!(outcomes, ["off", "off", "on"]);
    }

    #[test]
    fn a_mono_switching_it_records_ashs_words_and_its_chat() {
        let c = conn();
        let input = SetInput {
            by: "mono:ada".into(),
            chat_id: Some("s-cos".into()),
            said: Some("go autopilot until monday 9".into()),
            who: Some("Chief of Staff".into()),
            ..set(&["*"], T0 + 50 * HOUR)
        };
        let on = set_switches(&c, &input, T0).unwrap();
        assert_eq!(on[0].set_by, "mono:ada");
        assert_eq!(on[0].said.as_deref(), Some("go autopilot until monday 9"));
        let log = &list_log(&c, 1, None).unwrap()[0];
        assert_eq!(log.mono_id.as_deref(), Some("ada"));
        assert_eq!(log.chat_id.as_deref(), Some("s-cos"));
        assert_eq!(log.who.as_deref(), Some("Chief of Staff"));
        assert_eq!(log.detail.as_deref(), Some("go autopilot until monday 9"));
        // With his whole message, the log keeps that; the switch keeps the quote.
        let input = SetInput {
            turn: Some("I'm off. Go autopilot until Monday 9, back then".into()),
            ..input
        };
        let on = set_switches(&c, &input, T0).unwrap();
        assert_eq!(on[0].said.as_deref(), Some("go autopilot until monday 9"));
        let log = &list_log(&c, 1, None).unwrap()[0];
        assert_eq!(
            log.detail.as_deref(),
            Some("I'm off. Go autopilot until Monday 9, back then")
        );
    }

    fn decision(dedupe: &str) -> LogInput {
        LogInput {
            kind: "decision".into(),
            outcome: "taken".into(),
            project: Some("hivra".into()),
            chat_id: Some("s1".into()),
            mono_id: Some("hivra-lead".into()),
            who: Some("Hivra lead".into()),
            what: "Split the fix into two PRs?".into(),
            recommendation: Some("Yes, two PRs".into()),
            dedupe: Some(dedupe.into()),
            ..LogInput::default()
        }
    }

    fn old_rows(c: &Connection, count: usize, at: i64) {
        let tx = c.unchecked_transaction().unwrap();
        for i in 0..count {
            tx.execute(
                "INSERT INTO autopilot_log (id, at, kind, outcome, what) VALUES (?1, ?2, 'decision', 'taken', 'old call')",
                params![format!("old-{at}-{i}"), at + i as i64],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }

    fn rows(c: &Connection) -> i64 {
        c.query_row("SELECT count(*) FROM autopilot_log", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn the_log_keeps_its_newest_2000_rows_or_90_days_whichever_is_more() {
        const DAY: i64 = 24 * HOUR;
        let c = conn();
        // 2,100 rows from 100 days ago: a new row trims them to the newest 2,000 (the new one included).
        old_rows(&c, 2_100, T0 - 100 * DAY);
        let fresh = add_log(&c, &decision("d:new"), T0).unwrap().unwrap();
        assert_eq!(rows(&c), 2_000);
        assert_eq!(list_log(&c, 1, None).unwrap()[0].id, fresh.id);
        let oldest: i64 = c
            .query_row("SELECT min(at) FROM autopilot_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(oldest, T0 - 100 * DAY + 101);
        // Rows from the last 90 days stay, however many there are.
        let c = conn();
        old_rows(&c, 2_100, T0 - 10 * DAY);
        old_rows(&c, 50, T0 - 100 * DAY);
        add_log(&c, &decision("d:new"), T0).unwrap();
        assert_eq!(rows(&c), 2_101);
    }

    #[test]
    fn log_rows_say_what_who_the_recommendation_when_and_which_chat_once() {
        let c = conn();
        let entry = add_log(&c, &decision("d:1"), T0).unwrap().unwrap();
        assert_eq!(entry.at, T0);
        assert_eq!(entry.chat_id.as_deref(), Some("s1"));
        assert_eq!(entry.recommendation.as_deref(), Some("Yes, two PRs"));
        assert!(add_log(&c, &decision("d:1"), T0 + 5).unwrap().is_none());
        assert!(add_log(&c, &decision("d:2"), T0 + 5).unwrap().is_some());
        assert_eq!(list_log(&c, 10, None).unwrap().len(), 2);
        assert_eq!(list_log(&c, 10, Some(T0 + 5)).unwrap().len(), 1);
        assert_eq!(unseen_count(&c, T0 - 1).unwrap(), 2);
        assert_eq!(unseen_count(&c, T0).unwrap(), 1);
        let bad = LogInput {
            kind: "nope".into(),
            ..decision("d:3")
        };
        assert!(add_log(&c, &bad, T0).is_err());
        let held = LogInput {
            outcome: "held".into(),
            red: Some("money".into()),
            ..decision("d:4")
        };
        assert_eq!(
            add_log(&c, &held, T0).unwrap().unwrap().red.as_deref(),
            Some("money")
        );
    }

    #[test]
    fn auto_resume_defaults_on_with_per_project_overrides() {
        let c = conn();
        assert_eq!(auto_resume(&c).unwrap(), AutoResume::default());
        let off = set_auto_resume(
            &c,
            &AutoResumeInput {
                default: None,
                project: Some("vg-game".into()),
                value: Some(false),
            },
        )
        .unwrap();
        assert!(off.default);
        assert_eq!(off.projects.get("vg-game"), Some(&false));
        let cleared = set_auto_resume(
            &c,
            &AutoResumeInput {
                default: Some(false),
                project: Some("vg-game".into()),
                value: None,
            },
        )
        .unwrap();
        assert!(!cleared.default);
        assert!(cleared.projects.is_empty());
        assert!(set_auto_resume(
            &c,
            &AutoResumeInput {
                default: None,
                project: Some("*".into()),
                value: Some(true)
            }
        )
        .is_err());
    }

    fn arm(session: &str, resets: i64) -> ArmInput {
        ArmInput {
            session_id: session.into(),
            resets_at: resets,
            resume_at: resets + 45_000,
            title: Some("EXO lead".into()),
        }
    }

    #[test]
    fn resumes_arm_once_per_limit_and_stop_after_three_tries_in_a_row() {
        let c = conn();
        // A reset already past never arms (T3's guard against a retry loop).
        assert!(!arm_resume(&c, &arm("s1", T0 - 1), T0).unwrap().armed);
        let first = arm_resume(&c, &arm("s1", T0 + HOUR), T0).unwrap();
        assert!(first.armed);
        assert_eq!(first.resume.as_ref().unwrap().attempts, 1);
        assert_eq!(first.resume.as_ref().unwrap().resume_at, T0 + HOUR + 45_000);
        // The same limit seen again is the same arming.
        assert_eq!(
            arm_resume(&c, &arm("s1", T0 + HOUR), T0 + 10)
                .unwrap()
                .resume
                .unwrap()
                .attempts,
            1
        );
        // Resumed, then limited again before any turn finished: attempt two, then three, then it waits for Ash.
        settle_resume(&c, "s1", RESUMED, T0 + HOUR).unwrap();
        assert_eq!(
            arm_resume(&c, &arm("s1", T0 + 6 * HOUR), T0 + HOUR)
                .unwrap()
                .resume
                .unwrap()
                .attempts,
            2
        );
        settle_resume(&c, "s1", RESUMED, T0 + 6 * HOUR).unwrap();
        assert_eq!(
            arm_resume(&c, &arm("s1", T0 + 11 * HOUR), T0 + 6 * HOUR)
                .unwrap()
                .resume
                .unwrap()
                .attempts,
            3
        );
        settle_resume(&c, "s1", RESUMED, T0 + 11 * HOUR).unwrap();
        let fourth = arm_resume(&c, &arm("s1", T0 + 16 * HOUR), T0 + 11 * HOUR).unwrap();
        assert!(!fourth.armed);
        assert_eq!(fourth.resume.unwrap().state, GAVE_UP);
        assert!(
            !arm_resume(&c, &arm("s1", T0 + 21 * HOUR), T0 + 16 * HOUR)
                .unwrap()
                .armed
        );
        // A finished turn clears it: the next limit starts counting again.
        settle_resume(&c, "s1", "finished", T0 + 17 * HOUR).unwrap();
        assert_eq!(
            arm_resume(&c, &arm("s1", T0 + 22 * HOUR), T0 + 17 * HOUR)
                .unwrap()
                .resume
                .unwrap()
                .attempts,
            1
        );
    }

    #[test]
    fn a_cancelled_resume_is_history_and_open_resumes_survive_for_the_next_start() {
        let c = conn();
        arm_resume(&c, &arm("s1", T0 + HOUR), T0).unwrap();
        arm_resume(&c, &arm("s2", T0 + 2 * HOUR), T0).unwrap();
        settle_resume(&c, "s2", CANCELLED, T0 + 5).unwrap();
        let open = open_resumes(&c).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].session_id, "s1");
        // A new limit after a cancel starts at one.
        assert_eq!(
            arm_resume(&c, &arm("s2", T0 + 3 * HOUR), T0 + 6)
                .unwrap()
                .resume
                .unwrap()
                .attempts,
            1
        );
        assert!(settle_resume(&c, "s1", "bogus", T0).is_err());
    }

    #[derive(Default, Clone)]
    struct FakeWake {
        holds: Arc<AtomicUsize>,
        releases: Arc<AtomicUsize>,
        on: Arc<Mutex<bool>>,
    }

    impl Wake for FakeWake {
        fn hold(&mut self, _reason: &str) -> Result<(), String> {
            let mut on = self.on.lock().unwrap();
            if !*on {
                self.holds.fetch_add(1, Ordering::SeqCst);
                *on = true;
            }
            Ok(())
        }
        fn release(&mut self) {
            let mut on = self.on.lock().unwrap();
            if *on {
                self.releases.fetch_add(1, Ordering::SeqCst);
                *on = false;
            }
        }
        fn held(&self) -> bool {
            *self.on.lock().unwrap()
        }
    }

    #[test]
    fn the_mac_stays_awake_exactly_while_a_switch_is_on() {
        let c = conn();
        let mut wake = FakeWake::default();
        assert!(!sync_wake(&mut wake, &active_switches(&c, T0).unwrap()).unwrap());
        assert_eq!(wake.holds.load(Ordering::SeqCst), 0);
        set_switches(&c, &set(&["*"], T0 + 2 * HOUR), T0).unwrap();
        assert!(sync_wake(&mut wake, &active_switches(&c, T0).unwrap()).unwrap());
        // A second switch, or another sync, doesn't take a second assertion.
        set_switches(&c, &set(&["hivra"], T0 + 3 * HOUR), T0).unwrap();
        sync_wake(&mut wake, &active_switches(&c, T0).unwrap()).unwrap();
        assert_eq!(wake.holds.load(Ordering::SeqCst), 1);
        // The first end time passes: still one switch on, still held.
        expire(&c, T0 + 2 * HOUR).unwrap();
        assert!(sync_wake(&mut wake, &active_switches(&c, T0 + 2 * HOUR).unwrap()).unwrap());
        assert_eq!(wake.releases.load(Ordering::SeqCst), 0);
        // The last one ends: released, once.
        expire(&c, T0 + 3 * HOUR).unwrap();
        assert!(!sync_wake(&mut wake, &active_switches(&c, T0 + 3 * HOUR).unwrap()).unwrap());
        sync_wake(&mut wake, &[]).unwrap();
        assert_eq!(wake.releases.load(Ordering::SeqCst), 1);
        // Turned on again, then off by hand.
        set_switches(&c, &set(&["*"], T0 + 9 * HOUR), T0 + 4 * HOUR).unwrap();
        sync_wake(&mut wake, &active_switches(&c, T0 + 4 * HOUR).unwrap()).unwrap();
        let off = OffInput {
            scopes: vec![],
            by: "ash".into(),
            chat_id: None,
            said: None,
            who: None,
        };
        remove_switches(&c, &off, T0 + 4 * HOUR).unwrap();
        sync_wake(&mut wake, &active_switches(&c, T0 + 4 * HOUR).unwrap()).unwrap();
        assert_eq!(wake.holds.load(Ordering::SeqCst), 2);
        assert_eq!(wake.releases.load(Ordering::SeqCst), 2);
        assert_eq!(
            wake_reason(&[Switch {
                scope: "*".into(),
                until_ms: 0,
                set_by: "ash".into(),
                set_at: 0,
                chat_id: None,
                said: None
            }]),
            "MonoCode Hub autopilot (everything)"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_real_power_assertion_is_taken_and_given_back() {
        let mut wake = power::PowerAssertion::default();
        wake.hold("MonoCode Hub autopilot test").unwrap();
        assert!(wake.held());
        wake.hold("again").unwrap();
        wake.release();
        assert!(!wake.held());
        wake.release();
    }

    #[test]
    fn only_the_daily_app_on_a_mac_relaunches_itself() {
        assert!(relaunch_support(instance::Kind::Daily, false, true).is_ok());
        assert_eq!(
            relaunch_support(instance::Kind::Dev, false, true),
            Err("Dev copies don't relaunch themselves.")
        );
        assert!(relaunch_support(instance::Kind::Daily, true, true).is_err());
        assert!(relaunch_support(instance::Kind::Daily, false, false).is_err());
        assert_eq!(
            agent_label("com.ash.monocode-hub"),
            "com.ash.monocode-hub.autopilot-watch"
        );
    }

    fn plan(dir: &Path) -> AgentPlan {
        AgentPlan {
            label: "com.ash.monocode-hub.autopilot-watch".into(),
            domain: "gui/501".into(),
            plist: dir.join("LaunchAgents/com.ash.monocode-hub.autopilot-watch.plist"),
            program: PathBuf::from(
                "/Users/ash/Applications/MonoCode Hub.app/Contents/MacOS/monocode",
            ),
            data_dir: dir.join("data & more"),
            home: PathBuf::from("/Users/ash"),
        }
    }

    #[test]
    fn the_watcher_plist_runs_the_app_binary_every_30_seconds_and_never_keeps_the_app_alive() {
        let dir = std::env::temp_dir().join(format!("ap-plist-{}", uuid::Uuid::new_v4()));
        let text = agent_plist(&plan(&dir));
        assert!(text.contains("<string>com.ash.monocode-hub.autopilot-watch</string>"));
        assert!(text.contains(
            "<string>/Users/ash/Applications/MonoCode Hub.app/Contents/MacOS/monocode</string>"
        ));
        assert!(text.contains("<string>autopilot-watch</string>"));
        assert!(text.contains("data &amp; more"));
        assert!(text.contains("<key>StartInterval</key>\n  <integer>30</integer>"));
        assert!(text.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(!text.contains("KeepAlive"));
    }

    /// launchd as current macOS behaves: bootstrapping a label that is already loaded fails with 5.
    #[cfg(target_os = "macos")]
    #[derive(Default)]
    struct FakeLaunchd {
        calls: Mutex<Vec<String>>,
        loaded: Mutex<bool>,
        /// bootstrap fails without loading anything.
        broken: Mutex<bool>,
        /// bootout leaves it loaded.
        stuck: Mutex<bool>,
    }

    #[cfg(target_os = "macos")]
    impl FakeLaunchd {
        fn is_loaded(&self) -> bool {
            *self.loaded.lock().unwrap()
        }
    }

    #[cfg(target_os = "macos")]
    impl Launchd for FakeLaunchd {
        fn bootstrap(&self, domain: &str, plist: &Path) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("bootstrap {domain} {}", plist.display()));
            let mut loaded = self.loaded.lock().unwrap();
            if *self.broken.lock().unwrap() || *loaded {
                return Err("Bootstrap failed: 5: Input/output error".into());
            }
            *loaded = true;
            Ok(())
        }
        fn bootout(&self, domain: &str, label: &str) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("bootout {domain}/{label}"));
            if !*self.stuck.lock().unwrap() {
                *self.loaded.lock().unwrap() = false;
            }
        }
        fn loaded(&self, _domain: &str, _label: &str) -> bool {
            self.is_loaded()
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn switching_off_removes_the_watcher_even_after_a_later_install_failed_on_a_loaded_label() {
        let dir = std::env::temp_dir().join(format!("ap-sync-{}", uuid::Uuid::new_v4()));
        let plan = plan(&dir);
        let launchd = FakeLaunchd::default();
        let mut installed = false;
        sync_agent(&launchd, &plan, &mut installed, Some(T0 + HOUR));
        assert!(installed && launchd.is_loaded());
        // A new end time: the label is loaded, which a second bootstrap can't take (exit 5).
        sync_agent(&launchd, &plan, &mut installed, Some(T0 + 2 * HOUR));
        assert!(installed);
        let watch: WatchFile = read_json(&plan.data_dir.join(DIR).join(WATCH_FILE)).unwrap();
        assert_eq!(watch.until_ms, T0 + 2 * HOUR);
        // Autopilot off: the watcher goes, launchd and files.
        sync_agent(&launchd, &plan, &mut installed, None);
        assert!(!installed);
        assert!(!launchd.is_loaded());
        assert!(!plan.plist.exists());
        assert!(!plan.data_dir.join(DIR).join(WATCH_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_removal_that_fails_keeps_the_watcher_on_the_books_until_one_works() {
        let dir = std::env::temp_dir().join(format!("ap-stuck-{}", uuid::Uuid::new_v4()));
        let plan = plan(&dir);
        let launchd = FakeLaunchd::default();
        let mut installed = false;
        sync_agent(&launchd, &plan, &mut installed, Some(T0 + HOUR));
        *launchd.stuck.lock().unwrap() = true;
        sync_agent(&launchd, &plan, &mut installed, None);
        assert!(installed, "still loaded, so still on the books");
        // Without its watch file the watcher does nothing meanwhile.
        assert!(!plan.data_dir.join(DIR).join(WATCH_FILE).exists());
        *launchd.stuck.lock().unwrap() = false;
        sync_agent(&launchd, &plan, &mut installed, None);
        assert!(!installed && !launchd.is_loaded());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_half_done_install_is_cleaned_up_when_autopilot_ends() {
        let dir = std::env::temp_dir().join(format!("ap-half-{}", uuid::Uuid::new_v4()));
        let plan = plan(&dir);
        let launchd = FakeLaunchd::default();
        *launchd.broken.lock().unwrap() = true;
        let mut installed = false;
        sync_agent(&launchd, &plan, &mut installed, Some(T0 + HOUR));
        assert!(!installed);
        assert!(plan.plist.exists());
        sync_agent(&launchd, &plan, &mut installed, None);
        assert!(!plan.plist.exists());
        assert!(!plan.data_dir.join(DIR).join(WATCH_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn installing_and_removing_the_watcher_writes_and_clears_its_files() {
        let dir = std::env::temp_dir().join(format!("ap-agent-{}", uuid::Uuid::new_v4()));
        let plan = plan(&dir);
        let launchd = FakeLaunchd::default();
        install_agent(&launchd, &plan, T0 + HOUR).unwrap();
        assert!(plan.plist.exists());
        let watch: WatchFile = read_json(&plan.data_dir.join(DIR).join(WATCH_FILE)).unwrap();
        assert_eq!(watch.until_ms, T0 + HOUR);
        // Moving the end time rewrites only the watch file; the plist is unchanged, so launchd isn't restarted.
        install_agent(&launchd, &plan, T0 + 2 * HOUR).unwrap();
        let watch: WatchFile = read_json(&plan.data_dir.join(DIR).join(WATCH_FILE)).unwrap();
        assert_eq!(watch.until_ms, T0 + 2 * HOUR);
        assert!(!launchd
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.starts_with("bootout")));
        remove_agent(
            &launchd,
            &plan.label,
            &plan.domain,
            &plan.plist,
            &plan.data_dir,
        )
        .unwrap();
        assert!(!launchd.is_loaded());
        assert!(!plan.plist.exists());
        assert!(!plan.data_dir.join(DIR).join(WATCH_FILE).exists());
        assert_eq!(
            launchd.calls.lock().unwrap().last().unwrap(),
            "bootout gui/501/com.ash.monocode-hub.autopilot-watch"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn watch(alive: bool, clean: bool) -> WatchInput {
        WatchInput {
            until_ms: T0 + HOUR,
            app_alive: alive,
            clean_exit: clean,
            ship_in_progress: false,
            relaunches: Relaunches::default(),
        }
    }

    #[test]
    fn the_watcher_reopens_the_app_only_after_a_crash() {
        assert_eq!(
            watch_verdict(&watch(true, false), T0),
            Verdict::Idle("running")
        );
        assert_eq!(
            watch_verdict(&watch(false, true), T0),
            Verdict::Idle("quit on purpose")
        );
        assert_eq!(watch_verdict(&watch(false, false), T0), Verdict::Relaunch);
        let shipping = WatchInput {
            ship_in_progress: true,
            ..watch(false, false)
        };
        assert_eq!(
            watch_verdict(&shipping, T0),
            Verdict::Idle("a ship is replacing the app")
        );
        // Autopilot over: retire, whatever the app is doing.
        assert_eq!(
            watch_verdict(&watch(true, false), T0 + HOUR),
            Verdict::Retire
        );
    }

    #[test]
    fn the_watcher_stops_after_three_relaunches_in_half_an_hour_and_says_so_once() {
        let mut input = watch(false, false);
        input.relaunches.at = vec![T0 - 20 * 60_000, T0 - 10 * 60_000, T0 - 60_000];
        assert_eq!(watch_verdict(&input, T0), Verdict::GiveUp);
        input.relaunches.gave_up_at = Some(T0);
        assert_eq!(watch_verdict(&input, T0 + 30_000), Verdict::Idle("gave up"));
        // Old relaunches age out of the window: it may try again.
        assert_eq!(watch_verdict(&input, T0 + 40 * 60_000), Verdict::Relaunch);
    }

    #[test]
    fn the_watcher_main_retires_when_autopilot_is_over_and_ignores_a_missing_watch_file() {
        let dir = std::env::temp_dir().join(format!("ap-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(DIR)).unwrap();
        // No watch file: nothing to do.
        assert_eq!(watch_main(&[dir.to_string_lossy().into_owned()]), 0);
        assert_eq!(watch_main(&[]), 64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_start_after_a_relaunch_logs_it_once() {
        let c = conn();
        let dir = std::env::temp_dir().join(format!("ap-relaunch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(DIR)).unwrap();
        assert!(!note_relaunches(&c, &dir, T0));
        write_json(
            &dir.join(DIR).join(RELAUNCHES_FILE),
            &Relaunches {
                at: vec![T0 - 30_000],
                gave_up_at: None,
                logged_through: 0,
            },
        )
        .unwrap();
        assert!(note_relaunches(&c, &dir, T0));
        assert!(!note_relaunches(&c, &dir, T0 + 1_000));
        let log = list_log(&c, 10, None).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].outcome, "relaunched");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
