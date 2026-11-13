//! Delegations: the hub's durable record of work a Mono handed to another session (docs/PHASE-2-DESIGN.md, H2).
//!
//! Every monitored `sessions.start` / `sessions.send` from a Mono writes one row here before the child starts. The row
//! is the truth; the webview's in-memory completion batches are only a cache. So the report the Mono is owed survives a
//! restart, a crash, an install from inside the app or a usage-limit resume, and the Mono gets exactly one report for
//! each generation of the work.
//!
//! - **State**: `running`, `question` (the worker asked its owner something; H4), then `completed`, `failed` or
//!   `cancelled`. `settle` finishes a row atomically, only from running or question, and only for its current
//!   generation, so a late or repeated settle changes nothing.
//! - **Delivery** of the report: `pending` → `queued` (it waits in the owner's queue) → `delivered` (it went to the owner
//!   as a turn) → `acknowledged` (the owner read the result; H3's task_status). `disposed` (Stop, the owner gone) is
//!   final. A repeated or backwards move changes nothing.
//! - **Resumed turns** (auto-continue, a usage-limit resume, a later message in an interrupted child) re-attach to the
//!   child's row and bump its generation, so their report has a new receipt (`mono-completion-<requestId>-g<n>`).
//! - **The tree**: `parent_id` is the open delegation the owner itself is working for, `root_id` the top of that chain.
//! - **Followed briefs** (`follow`: `queue`, `steer`, `lead`): a brief sent to a chat that was busy (queued behind its
//!   work, or steered into it) or a leadership Mono's brief to a project Lead's long-running chat. The app reports these
//!   by watching the child chat (monos/model/followedBriefs.ts), not from a launch's own callback, so they never take
//!   the child over from earlier rows, a plain record never cancels them, and a resumed turn never re-attaches to them.
//! - **Stalls** (H4 stuck workers): a running row whose worker went quiet, loops on the same step, or stopped without
//!   reporting is marked stalled (`stall_kind` `quiet`, `loop` or `idle`, a plain reason, and since when) by the app's
//!   watcher (monos/model/workerStall.ts). A stall is not a state: the row stays `running` (Ash OS knows five states), and
//!   any move of the row (a question, a settle, a resumed turn, a Stop, a take-over) clears it. Activity again clears it
//!   too. It is copied to Ash OS with the row (`stalled`) and logged (`stalled` / `unstalled`).
//! - **Blocked** (D5, declared by the agents themselves): a Lead — or the worker on its own row — says it cannot finish,
//!   with a plain reason (`task_cannot`, `stall_kind` `blocked`). Unlike a judged stall it is not re-judged and activity
//!   does not clear it: it stands until the row moves (a settle, a Stop, a retried generation). It lands on the row as
//!   Needs you at once, and a Lead's "done" claim is checked against it.
//! - **No mirror** (21 Oct): rows live here only. Every change still bumps `version`; the old `mirrored_version` and
//!   `mirror_error` columns stay for older stores, unused. Reports still arrive after a restart: they are owed rows here.
//!
//! Own tables, made by `ensure_tables` (no numbered migration, so upstream's migration numbers can't collide).

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::session_store::{now_millis, SessionStore};

/// Tauri event after any change: `{ids}`.
pub const CHANGED: &str = "monocode:delegations-changed";

pub const RUNNING: &str = "running";
pub const QUESTION: &str = "question";
pub const COMPLETED: &str = "completed";
pub const FAILED: &str = "failed";
pub const CANCELLED: &str = "cancelled";

pub const PENDING: &str = "pending";
pub const QUEUED: &str = "queued";
pub const DELIVERED: &str = "delivered";
pub const ACKNOWLEDGED: &str = "acknowledged";
pub const DISPOSED: &str = "disposed";

const RESULT_MAX: usize = 12_000;
const BRIEF_MAX: usize = 12_000;
const TITLE_MAX: usize = 300;
const GOAL_MAX: usize = 1_000;
const ERROR_MAX: usize = 2_000;
const QUESTION_MAX: usize = 2_000;
const LOG_MAX: usize = 50;
const ASKS_MAX: usize = 50;
/// A worker's self-review is three lines, not a second report (workerReview.ts has the same limits).
const REVIEW_FIELD_MAX: usize = 1_000;
const REVIEW_TOTAL_MAX: usize = 4_000;

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS delegations (
           id TEXT PRIMARY KEY,
           owner_session TEXT NOT NULL,
           owner_mono TEXT,
           batch_id TEXT,
           parent_id TEXT,
           root_id TEXT NOT NULL,
           child_session TEXT NOT NULL,
           request_id TEXT NOT NULL,
           generation INTEGER NOT NULL DEFAULT 1,
           project TEXT,
           title TEXT,
           brief TEXT,
           goal TEXT,
           ask_ids TEXT NOT NULL DEFAULT '[]',
           state TEXT NOT NULL,
           error_class TEXT,
           error TEXT,
           retryable INTEGER,
           resets_at INTEGER,
           result TEXT,
           pending_question TEXT,
           delivery TEXT NOT NULL,
           delivery_message TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           settled_at INTEGER,
           log TEXT NOT NULL DEFAULT '[]',
           review_required INTEGER NOT NULL DEFAULT 0,
           self_review TEXT,
           version INTEGER NOT NULL DEFAULT 1,
           mirrored_version INTEGER NOT NULL DEFAULT 0,
           mirror_error TEXT,
           UNIQUE (owner_session, request_id)
         );
         CREATE INDEX IF NOT EXISTS delegations_child ON delegations(child_session, created_at);
         CREATE INDEX IF NOT EXISTS delegations_open ON delegations(state, delivery);
         CREATE INDEX IF NOT EXISTS delegations_root ON delegations(root_id, created_at);
         CREATE INDEX IF NOT EXISTS delegations_message ON delegations(delivery_message)
           WHERE delivery_message IS NOT NULL;
         CREATE TABLE IF NOT EXISTS delegation_chat_binds (
           provider_session TEXT PRIMARY KEY,
           chat_id TEXT NOT NULL,
           mono_id TEXT,
           role TEXT,
           delegation_id TEXT,
           bound_at INTEGER NOT NULL,
           version INTEGER NOT NULL DEFAULT 1,
           mirrored_version INTEGER NOT NULL DEFAULT 0,
           mirror_error TEXT
         );",
    )?;
    // Added after the first rows were written: older stores get the column here.
    let has_follow = conn
        .prepare("SELECT 1 FROM pragma_table_info('delegations') WHERE name = 'follow'")?
        .exists([])?;
    if !has_follow {
        conn.execute_batch("ALTER TABLE delegations ADD COLUMN follow TEXT;")?;
    }
    let has_stall = conn
        .prepare("SELECT 1 FROM pragma_table_info('delegations') WHERE name = 'stall_kind'")?
        .exists([])?;
    if !has_stall {
        conn.execute_batch(
            "ALTER TABLE delegations ADD COLUMN stall_kind TEXT;
             ALTER TABLE delegations ADD COLUMN stall_reason TEXT;
             ALTER TABLE delegations ADD COLUMN stalled_at INTEGER;",
        )?;
    }
    let has_review = conn
        .prepare("SELECT 1 FROM pragma_table_info('delegations') WHERE name = 'self_review'")?
        .exists([])?;
    if !has_review {
        conn.execute_batch(
            "ALTER TABLE delegations ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE delegations ADD COLUMN self_review TEXT;",
        )?;
    }
    // Hivra WP-10 (firstmate/): who an open question waits on, the completion gates' verdict and the worker's typed report.
    let has_contract = conn
        .prepare("SELECT 1 FROM pragma_table_info('delegations') WHERE name = 'question_owner'")?
        .exists([])?;
    if !has_contract {
        conn.execute_batch(
            "ALTER TABLE delegations ADD COLUMN question_owner TEXT;
             ALTER TABLE delegations ADD COLUMN gate_verdict TEXT;
             ALTER TABLE delegations ADD COLUMN report TEXT;",
        )?;
    }
    // WP-176 round 4: the redo link, kept apart from the row so a later save of the row cannot drop it.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS delegation_redos (
           new_id TEXT PRIMARY KEY,
           old_id TEXT NOT NULL,
           owner_session TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );",
    )?;
    // WP-42: when this run started. The log only keeps 50 lines, so a resume time stored there can be trimmed
    // before settle, and older proof would be attached as this run's.
    let has_run_started = conn
        .prepare("SELECT 1 FROM pragma_table_info('delegations') WHERE name = 'run_started_at'")?
        .exists([])?;
    if !has_run_started {
        conn.execute_batch("ALTER TABLE delegations ADD COLUMN run_started_at INTEGER;")?;
    }
    // A row a memory or chat import wrote: history from another copy, which lends no folder (chat_media). Older stores
    // get the column here, with every existing row unmarked.
    let has_imported = conn
        .prepare("SELECT 1 FROM pragma_table_info('delegations') WHERE name = 'imported'")?
        .exists([])?;
    if !has_imported {
        conn.execute_batch(
            "ALTER TABLE delegations ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    // SC-4 (firstmate/brief_checks.rs): the commit the brief was written against, its own runnable check lines (JSON,
    // each with `passes` that only the gates set) and its do-not-touch list (JSON). All null on a row from before.
    let has_brief = conn
        .prepare("SELECT 1 FROM pragma_table_info('delegations') WHERE name = 'brief_checks'")?
        .exists([])?;
    if !has_brief {
        conn.execute_batch(
            "ALTER TABLE delegations ADD COLUMN brief_stamp TEXT;
             ALTER TABLE delegations ADD COLUMN brief_checks TEXT;
             ALTER TABLE delegations ADD COLUMN brief_leave TEXT;",
        )?;
    }
    Ok(())
}

/// One delegation, as the webview and the tests see it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    pub id: String,
    pub owner_session: String,
    pub owner_mono: Option<String>,
    pub batch_id: Option<String>,
    pub parent_id: Option<String>,
    pub root_id: String,
    pub child_session: String,
    pub request_id: String,
    pub generation: i64,
    pub project: Option<String>,
    pub title: Option<String>,
    pub brief: Option<String>,
    pub goal: Option<String>,
    pub ask_ids: Vec<String>,
    pub state: String,
    pub error_class: Option<String>,
    pub error: Option<String>,
    pub retryable: Option<bool>,
    pub resets_at: Option<i64>,
    pub result: Option<String>,
    pub pending_question: Option<String>,
    pub delivery: String,
    pub delivery_message: Option<String>,
    pub created_at: i64,
    /// When this run started, epoch ms. Set when the row is recorded, when it resumes, and when a refused launch is
    /// retried. A row from before this column (NULL) uses the latest "resumed" or "retried" line, else `created_at`,
    /// and that is what a later save writes. Evidence uses this, not the log: `note` only keeps the newest 50 lines.
    pub run_started_at: i64,
    pub updated_at: i64,
    pub settled_at: Option<i64>,
    pub log: Vec<Value>,
    /// Whether its report must carry a self-review before it can be marked done: a delegated worker's always does.
    pub review_required: bool,
    /// The accepted self-review, as JSON: what the worker checked, how, and what is still unsure.
    pub self_review: Option<String>,
    pub version: i64,
    pub mirrored_version: i64,
    pub mirror_error: Option<String>,
    /// `queue`, `steer` or `lead` for a followed brief (see the module docs); none for a launch's own report.
    pub follow: Option<String>,
    /// A running row's stall (module docs): `quiet`, `loop`, `idle` or `blocked` (the agent said it cannot finish); none
    /// while it moves.
    pub stall_kind: Option<String>,
    pub stall_reason: Option<String>,
    /// Since when it has been stuck this way (its last activity, or the start of the loop), epoch ms.
    pub stalled_at: Option<i64>,
    /// WP-10: who the open question waits on, `first-mate` (none) or `person` (firstmate/status.rs).
    pub question_owner: Option<String>,
    /// WP-10: the completion gates' verdict (`pending`, `passed`, `failed`, `unsure`); none when no gates apply. Written by
    /// WP-40 (`set_gate_verdict`).
    pub gate_verdict: Option<String>,
    /// WP-10: the worker's typed final report, as JSON (firstmate/report.rs), parsed from its result when it settles.
    pub report: Option<String>,
    /// WP-10: the one status shown anywhere (firstmate/status.rs), kept in step with the row on every change.
    pub status: crate::firstmate::status::Status,
    pub status_notice: Option<String>,
}

impl Delegation {
    fn is_open(&self) -> bool {
        self.state == RUNNING || self.state == QUESTION
    }

    /// The row moved (a question, a settle, a resumed turn, a Stop): whatever stall it had is over.
    fn unstall(&mut self) {
        self.stall_kind = None;
        self.stall_reason = None;
        self.stalled_at = None;
    }

    /// The newest event in the row's history.
    fn last_event(&self) -> Option<&str> {
        self.log
            .last()
            .and_then(|entry| entry.get("event"))
            .and_then(Value::as_str)
    }

    /// One line of the row's history, stamped with who acted. The newest 50 are kept.
    fn note(&mut self, now: i64, by: &str, event: &str, extra: Value) {
        let mut entry = json!({ "at": now, "by": by, "event": event });
        if let (Some(entry), Value::Object(extra)) = (entry.as_object_mut(), extra) {
            entry.extend(extra);
        }
        self.log.push(entry);
        if self.log.len() > LOG_MAX {
            let extra = self.log.len() - LOG_MAX;
            self.log.drain(..extra);
        }
    }

    /// A change worth copying: a new version for the outbox.
    fn touch(&mut self, now: i64) {
        self.updated_at = now;
        self.version += 1;
        self.refresh_status();
    }

    /// WP-10: the shown status follows the row (firstmate/status.rs is the only place it is computed).
    fn refresh_status(&mut self) {
        let derived = crate::firstmate::status::status_of(self);
        self.status = derived.status;
        self.status_notice = derived.notice;
    }
}

const COLUMNS: &str = "id, owner_session, owner_mono, batch_id, parent_id, root_id, child_session, request_id, \
     generation, project, title, brief, goal, ask_ids, state, error_class, error, retryable, resets_at, result, \
     pending_question, delivery, delivery_message, created_at, updated_at, settled_at, log, version, \
     mirrored_version, mirror_error, follow, stall_kind, stall_reason, stalled_at, review_required, self_review, question_owner, gate_verdict, report, \
     run_started_at";

/// The newest line that starts a run. An old row has no `run_started_at`, and `created_at` would be the wrong run.
fn latest_new_run_at(log: &[Value]) -> Option<i64> {
    log.iter()
        .filter_map(|entry| match entry.get("event").and_then(Value::as_str) {
            Some("resumed" | "retried") => entry.get("at").and_then(Value::as_i64),
            _ => None,
        })
        .max()
}

fn from_row(row: &Row) -> rusqlite::Result<Delegation> {
    let asks: String = row.get(13)?;
    let log_text: String = row.get(26)?;
    let log: Vec<Value> = serde_json::from_str(&log_text).unwrap_or_default();
    let created_at: i64 = row.get(23)?;
    let stored_start: Option<i64> = row.get(39)?;
    let run_started_at =
        stored_start.unwrap_or_else(|| latest_new_run_at(&log).unwrap_or(created_at));
    Ok(Delegation {
        id: row.get(0)?,
        owner_session: row.get(1)?,
        owner_mono: row.get(2)?,
        batch_id: row.get(3)?,
        parent_id: row.get(4)?,
        root_id: row.get(5)?,
        child_session: row.get(6)?,
        request_id: row.get(7)?,
        generation: row.get(8)?,
        project: row.get(9)?,
        title: row.get(10)?,
        brief: row.get(11)?,
        goal: row.get(12)?,
        ask_ids: serde_json::from_str(&asks).unwrap_or_default(),
        state: row.get(14)?,
        error_class: row.get(15)?,
        error: row.get(16)?,
        retryable: row.get::<_, Option<i64>>(17)?.map(|v| v != 0),
        resets_at: row.get(18)?,
        result: row.get(19)?,
        pending_question: row.get(20)?,
        delivery: row.get(21)?,
        delivery_message: row.get(22)?,
        created_at,
        run_started_at,
        updated_at: row.get(24)?,
        settled_at: row.get(25)?,
        log,
        version: row.get(27)?,
        mirrored_version: row.get(28)?,
        mirror_error: row.get(29)?,
        follow: row.get(30)?,
        stall_kind: row.get(31)?,
        stall_reason: row.get(32)?,
        stalled_at: row.get(33)?,
        review_required: row.get::<_, i64>(34)? != 0,
        self_review: row.get(35)?,
        question_owner: row.get(36)?,
        gate_verdict: row.get(37)?,
        report: row.get(38)?,
        status: crate::firstmate::status::Status::Working,
        status_notice: None,
    }
    .with_status())
}

impl Delegation {
    fn with_status(mut self) -> Self {
        self.refresh_status();
        self
    }
}

fn query(
    conn: &Connection,
    filter: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Delegation>, String> {
    let sql = format!("SELECT {COLUMNS} FROM delegations {filter}");
    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(args, from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub(crate) fn get(conn: &Connection, id: &str) -> Result<Option<Delegation>, String> {
    Ok(query(conn, "WHERE id = ?1", &[&id])?.into_iter().next())
}

fn insert(conn: &Connection, d: &Delegation) -> Result<(), String> {
    conn.execute(
        &format!(
            "INSERT INTO delegations ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, \
             ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, \
             ?35, ?36, ?37, ?38, ?39, ?40)"
        ),
        params![
            d.id,
            d.owner_session,
            d.owner_mono,
            d.batch_id,
            d.parent_id,
            d.root_id,
            d.child_session,
            d.request_id,
            d.generation,
            d.project,
            d.title,
            d.brief,
            d.goal,
            serde_json::to_string(&d.ask_ids).unwrap_or_else(|_| "[]".into()),
            d.state,
            d.error_class,
            d.error,
            d.retryable.map(i64::from),
            d.resets_at,
            d.result,
            d.pending_question,
            d.delivery,
            d.delivery_message,
            d.created_at,
            d.updated_at,
            d.settled_at,
            serde_json::to_string(&d.log).unwrap_or_else(|_| "[]".into()),
            d.version,
            d.mirrored_version,
            d.mirror_error,
            d.follow,
            d.stall_kind,
            d.stall_reason,
            d.stalled_at,
            i64::from(d.review_required),
            d.self_review,
            d.question_owner,
            d.gate_verdict,
            d.report,
            d.run_started_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Writes back everything a move can change. The outbox's own columns are left alone.
fn save_row(conn: &Connection, d: &Delegation) -> Result<(), String> {
    // WP-10: every move refreshes the shown status (touch); a move that forgot would show a stale one.
    debug_assert_eq!(
        (d.status, d.status_notice.clone()),
        {
            let derived = crate::firstmate::status::status_of(d);
            (derived.status, derived.notice)
        },
        "a delegation was saved with a stale status"
    );
    conn.execute(
        "UPDATE delegations SET generation = ?2, state = ?3, error_class = ?4, error = ?5, retryable = ?6,
           resets_at = ?7, result = ?8, pending_question = ?9, delivery = ?10, delivery_message = ?11,
           updated_at = ?12, settled_at = ?13, log = ?14, version = ?15, stall_kind = ?16, stall_reason = ?17,
           stalled_at = ?18, review_required = ?19, self_review = ?20, question_owner = ?21, gate_verdict = ?22,
           report = ?23, run_started_at = ?24
         WHERE id = ?1",
        params![
            d.id,
            d.generation,
            d.state,
            d.error_class,
            d.error,
            d.retryable.map(i64::from),
            d.resets_at,
            d.result,
            d.pending_question,
            d.delivery,
            d.delivery_message,
            d.updated_at,
            d.settled_at,
            serde_json::to_string(&d.log).unwrap_or_else(|_| "[]".into()),
            d.version,
            d.stall_kind,
            d.stall_reason,
            d.stalled_at,
            i64::from(d.review_required),
            d.self_review,
            d.question_owner,
            d.gate_verdict,
            d.report,
            d.run_started_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The row, then the task that follows it. A retry that names a person's task must not file one first.
fn save(conn: &Connection, d: &Delegation) -> Result<(), String> {
    save_row(conn, d)?;
    // WP-70: the task follows this work. Agents never set that status themselves.
    crate::tasks::sync::on_delegation(conn, d, None)?;
    Ok(())
}

// ---- input checks ------------------------------------------------------------------------------------------------------

fn cap(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn text(value: Option<String>, max: usize) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(|v| cap(&v, max))
}

fn id_like(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(format!("Invalid {label}"));
    }
    Ok(value.to_string())
}

fn session_id(value: &str, label: &str) -> Result<String, String> {
    id_like(value, label, 256)
}

/// Who acted, for the row's log: `app` unless the caller says (`owner:<session>`, `boot`, `user`).
fn actor(by: Option<String>) -> String {
    text(by, 120).unwrap_or_else(|| "app".into())
}

fn error_class(value: Option<String>) -> Option<String> {
    value
        .map(|v| {
            v.to_ascii_lowercase()
                .chars()
                .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')
                .take(40)
                .collect::<String>()
        })
        .filter(|v| !v.is_empty())
}

/// MonoCode's own Mono id rule, the one the studio checks (ashos/hub.py MONO_ID).
fn mono_id_ok(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The studio's ask id rule (ashos/hub.py ASK_ID): one bad id refuses the whole copy, so it is refused here first.
fn ask_id_ok(value: &str) -> bool {
    value.strip_prefix("a_").is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 40 && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// A worker's self-review (workerReview.ts), checked again here: what it checked, how, and what is still unsure, each a
/// line or two. Returned as the exact JSON the webview reads back, so stored keys are never the caller's own.
fn review_json(value: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = text(value, REVIEW_TOTAL_MAX * 2) else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| {
        "The self-review isn't in the shape the app records: it needs checked, how and unsure as text.".to_string()
    })?;
    let mut kept = serde_json::Map::new();
    let mut total = 0;
    for key in ["checked", "how", "unsure"] {
        let part = parsed
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if part.is_empty() || part.chars().count() > REVIEW_FIELD_MAX {
            return Err(
                "The self-review needs checked, how and unsure, each a sentence or two."
                    .to_string(),
            );
        }
        total += part.chars().count();
        kept.insert(key.into(), json!(part));
    }
    if total > REVIEW_TOTAL_MAX {
        return Err("The self-review is too long: keep it to a sentence or two per line.".into());
    }
    Ok(Some(Value::Object(kept).to_string()))
}

// ---- the commands' logic, on a plain connection ------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordInput {
    pub owner_session: String,
    #[serde(default)]
    pub owner_mono: Option<String>,
    #[serde(default)]
    pub batch_id: Option<String>,
    pub request_id: String,
    pub child_session: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub brief: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub ask_ids: Vec<String>,
    #[serde(default)]
    pub by: Option<String>,
    /// A followed brief: `queue`, `steer` or `lead` (module docs).
    #[serde(default)]
    pub follow: Option<String>,
    /// The open row the owner works for, when the app knows better than "the newest" (a Lead with several briefs
    /// open). Used only if it is open and names the owner as its child.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// A delegated worker's report must carry a self-review; its settle is refused as done without one (workerReview.ts).
    #[serde(default)]
    pub review_required: bool,
    /// WP-70: the person's task this work picks up. Absent, a task is created with the delegation.
    #[serde(default)]
    pub task_id: Option<String>,
    /// WP-203: set only by the app's review launcher (delivery/review.rs). Skipped by serde, so no JSON from a caller can
    /// set it: with it false, the review owner and the review request ids are refused.
    #[serde(skip)]
    pub review_launch: bool,
    /// WP-141: why the crew picked this CLI or Mono, one plain line. Kept on the "recorded" line as `why`.
    #[serde(default)]
    pub pick_reason: Option<String>,
    /// WP-176 round 5: the owner's row this one redoes. The link is written in the same transaction as the row, so it
    /// exists before the chat's first turn is judged. Refused when that row is not the owner's.
    #[serde(default)]
    pub redoes: Option<String>,
}

/// WP-141: a pick reason as one plain line of at most 240 characters. Empty is none.
fn pick_reason(value: Option<String>) -> Option<String> {
    let line = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    (!line.is_empty()).then(|| cap(&line, 240))
}

const FOLLOWS: [&str; 3] = ["queue", "steer", "lead"];

fn by_request(conn: &Connection, owner: &str, request: &str) -> Result<Option<Delegation>, String> {
    Ok(query(
        conn,
        "WHERE owner_session = ?1 AND request_id = ?2",
        &[&owner, &request],
    )?
    .into_iter()
    .next())
}

fn open_for_child(conn: &Connection, child: &str) -> Result<Vec<Delegation>, String> {
    query(
        conn,
        "WHERE child_session = ?1 AND state IN ('running', 'question') ORDER BY created_at DESC, rowid DESC",
        &[&child],
    )
}

/// Keeps the redo link from `new_id` to the owner's `old_id` row. A link that is already kept is left as it is, so a
/// retry cannot swap the parent. A parent that is not the owner's is refused.
fn link_redo(
    conn: &Connection,
    owner: &str,
    new_id: &str,
    old_id: &str,
    now: i64,
) -> Result<(), String> {
    let parent_is_owners = get(conn, old_id)?
        .map(|old| old.owner_session == owner)
        .unwrap_or(false);
    if !parent_is_owners {
        return Err("the task this one redoes is not one of yours".into());
    }
    conn.execute(
        "INSERT OR IGNORE INTO delegation_redos (new_id, old_id, owner_session, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![new_id, old_id, owner, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Record a delegation before its child starts. The same owner and request id return the row already there (a launch
/// retried with its receipt revives a refused one). An older open row for the same child is cancelled: the new request
/// takes the session over, and its owner already knows.
pub fn record(conn: &mut Connection, input: RecordInput, now: i64) -> Result<Delegation, String> {
    let owner = session_id(&input.owner_session, "owner session")?;
    let child = session_id(&input.child_session, "child session")?;
    let request = id_like(&input.request_id, "request id", 400)?;
    let asks: Vec<String> = input
        .ask_ids
        .iter()
        .map(|a| a.trim().to_string())
        .collect::<Vec<_>>();
    if asks.len() > ASKS_MAX || !asks.iter().all(|a| ask_id_ok(a)) {
        return Err("ask ids must be up to 50 ask ids (a_...)".into());
    }
    let follow = input
        .follow
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty());
    if let Some(f) = follow.as_deref() {
        if !FOLLOWS.contains(&f) {
            return Err("follow must be queue, steer or lead".into());
        }
    }
    // WP-203: the review owner and its request ids belong to the app's launcher. A caller can't claim either, and the
    // launcher's own record must name both.
    let review_owner = owner == crate::delivery::review::OWNER;
    let review_request = request.starts_with(crate::delivery::review::REQUEST_PREFIX);
    if (review_owner || review_request) && !(input.review_launch && review_owner && review_request)
    {
        return Err(
            "security reviews are started by the app's review launcher, not by a caller".into(),
        );
    }
    let by = actor(input.by);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if let Some(mut existing) = by_request(&tx, &owner, &request)? {
        let refused = existing.last_event() == Some("refused");
        if refused && existing.state == CANCELLED {
            existing.state = RUNNING.into();
            existing.delivery = PENDING.into();
            existing.delivery_message = None;
            existing.error = None;
            existing.settled_at = None;
            existing.run_started_at = now;
            existing.note(now, &by, "retried", json!({}));
            existing.touch(now);
            // The link below is the only task write. save() would file a task first, and the person's task would be refused.
            save_row(&tx, &existing)?;
        }
        // WP-70: a retried record still has a task.
        crate::tasks::sync::on_delegation(&tx, &existing, input.task_id.as_deref())?;
        if let Some(old) = input.redoes.as_deref() {
            link_redo(&tx, &owner, &existing.id, old, now)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(existing);
    }
    // A followed brief waits its turn (or joins the work) instead of taking the child over, and a plain request only
    // takes over plain rows: a Lead's open briefs stay open.
    let take_over = if follow.is_some() {
        Vec::new()
    } else {
        open_for_child(&tx, &child)?
            .into_iter()
            .filter(|d| d.follow.is_none())
            .collect()
    };
    for mut older in take_over {
        older.state = CANCELLED.into();
        older.error = Some("A later request to that session took it over.".into());
        // A question it was waiting on is nobody's now: the session works for the later request.
        older.pending_question = None;
        older.unstall();
        older.settled_at = Some(now);
        if older.owner_session == owner && older.delivery != DISPOSED {
            older.delivery = DISPOSED.into();
        }
        older.note(now, &by, "superseded", json!({ "by_request": request }));
        older.touch(now);
        save(&tx, &older)?;
    }
    // The owner is itself a worker when an open delegation names it as the child: that one is the parent (the one the
    // app names, when it is open and really the owner's; else the newest).
    let open_above = open_for_child(&tx, &owner)?;
    let named =
        text(input.parent_id, 200).and_then(|id| open_above.iter().find(|p| p.id == id).cloned());
    let parent = named.or_else(|| open_above.into_iter().next());
    let id = format!("t-{}", uuid::Uuid::new_v4());
    let mut row = Delegation {
        root_id: parent
            .as_ref()
            .map(|p| p.root_id.clone())
            .unwrap_or_else(|| id.clone()),
        parent_id: parent.map(|p| p.id),
        id,
        owner_session: owner,
        owner_mono: text(input.owner_mono, 64).filter(|m| mono_id_ok(m)),
        batch_id: text(input.batch_id, 200),
        child_session: child,
        request_id: request,
        generation: 1,
        project: text(input.project, 1_000),
        title: text(input.title, TITLE_MAX),
        brief: text(input.brief, BRIEF_MAX),
        goal: text(input.goal, GOAL_MAX),
        ask_ids: asks,
        state: RUNNING.into(),
        error_class: None,
        error: None,
        retryable: None,
        resets_at: None,
        result: None,
        pending_question: None,
        delivery: PENDING.into(),
        delivery_message: None,
        created_at: now,
        run_started_at: now,
        updated_at: now,
        settled_at: None,
        log: Vec::new(),
        review_required: input.review_required,
        self_review: None,
        version: 1,
        mirrored_version: 0,
        mirror_error: None,
        follow: follow.clone(),
        stall_kind: None,
        stall_reason: None,
        stalled_at: None,
        question_owner: None,
        gate_verdict: None,
        report: None,
        status: crate::firstmate::status::Status::Working,
        status_notice: None,
    };
    let mut recorded = follow
        .map(|f| json!({ "follow": f }))
        .unwrap_or_else(|| json!({}));
    if let (Some(why), Some(extra)) = (pick_reason(input.pick_reason), recorded.as_object_mut()) {
        extra.insert("why".into(), json!(why));
    }
    row.note(now, &by, "recorded", recorded);
    row.refresh_status();
    insert(&tx, &row)?;
    // WP-70: the brief's task, or the person's task this work picks up.
    crate::tasks::sync::on_delegation(&tx, &row, input.task_id.as_deref())?;
    if let Some(old) = input.redoes.as_deref() {
        link_redo(&tx, &row.owner_session, &row.id, old, now)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(row)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleInput {
    pub id: String,
    pub generation: i64,
    pub state: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_class: Option<String>,
    #[serde(default)]
    pub retryable: Option<bool>,
    #[serde(default)]
    pub resets_at: Option<i64>,
    #[serde(default)]
    pub by: Option<String>,
    /// The accepted self-review, as JSON (workerReview.ts): a row that requires one is not marked done without it.
    #[serde(default)]
    pub self_review: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub applied: bool,
    pub row: Option<Delegation>,
}

/// Finish a row: only from running or question, only for its current generation, in one step. Anything else (a
/// repeated settle, a stale generation, an unknown row) changes nothing and says so.
pub fn settle(conn: &mut Connection, input: SettleInput, now: i64) -> Result<Change, String> {
    if ![COMPLETED, FAILED, CANCELLED].contains(&input.state.as_str()) {
        return Err("state must be completed, failed or cancelled".into());
    }
    // WP-42: collect this run's .e2e files before the write transaction, so the walk doesn't hold the database.
    let staged = stage_evidence(conn, &input);
    let review = review_json(input.self_review)?;
    let by = actor(input.by);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut row) = get(&tx, &input.id)? else {
        return Ok(Change {
            applied: false,
            row: None,
        });
    };
    if !row.is_open() || row.generation != input.generation {
        return Ok(Change {
            applied: false,
            row: Some(row),
        });
    }
    // The app downgrades a report without a self-review to failed (delegations.ts); this refuses a "done" that would
    // carry the checks missing, so no other caller can slip one past it.
    if row.review_required && input.state == COMPLETED && review.is_none() {
        return Err("This task needs the worker's self-review before it can be marked done: what it checked, how, and what is still unsure.".into());
    }
    if review.is_some() {
        row.self_review = review;
    }
    row.state = input.state.clone();
    row.result = text(input.result, RESULT_MAX);
    row.error = text(input.error, ERROR_MAX);
    row.error_class = error_class(input.error_class);
    row.retryable = input.retryable;
    row.resets_at = input.resets_at;
    row.pending_question = None;
    row.question_owner = None;
    row.unstall();
    row.settled_at = Some(now);
    // WP-10: the worker's final report in its typed shape (firstmate/report.rs), kept beside its words.
    row.report = row.result.as_deref().map(|result| {
        let mut report = crate::firstmate::report::parse(result);
        // WP-42: proof under the worker's .e2e/ from this run only. A missing folder, or a folder that moved
        // while the files were read, changes nothing.
        if let Some(staged) = &staged {
            if child_folder(&tx, &row.child_session).as_ref() == Some(&staged.folder) {
                crate::plugins::verify::append_evidence(&mut report, staged.files.clone());
            }
        }
        report.to_json()
    });
    let mut detail = json!({ "state": row.state, "generation": row.generation });
    if let Some(class) = &row.error_class {
        detail["error_class"] = json!(class);
    }
    row.note(now, &by, "settled", detail);
    // A plan-less fix round writes no new verdict when the facts are clean, so the first round's
    // send-back would still be on the row when the report is delivered. A completed delivery clears
    // that failure. A verdict that is not a send-back stays as it is. The log keeps the reason.
    // A resumed turn, a boot settle, or a followed brief delivers without running the gates again.
    // That must not clear a send-back on a row that has a plan. A plan-less fix still clears here.
    if row.state == COMPLETED
        && row.gate_verdict.as_deref() == Some(crate::firstmate::status::GateVerdict::FAILED)
        && crate::firstmate::status::sent_back_on(&row)
        && crate::firstmate::gates::plan_of(&tx, &row.id)?.is_none()
    {
        row.gate_verdict = Some(crate::firstmate::status::GateVerdict::PASSED.into());
    }
    row.touch(now);
    save(&tx, &row)?;
    // WP-203: a completed security review is recorded here, by the app, from this row's result. No other path writes it.
    if row.owner_session == crate::delivery::review::OWNER
        && row
            .request_id
            .starts_with(crate::delivery::review::REQUEST_PREFIX)
        && row.state == COMPLETED
    {
        crate::delivery::review::record_settled(
            &tx,
            &row.id,
            &row.request_id,
            row.result.as_deref(),
            now,
        )?;
    }
    // WP-157: one summary line. Cancelled work is not an outcome. A repeated settle never reaches here. The line is
    // written in a savepoint: a journal that cannot be written is logged and skipped, and the task is still done.
    if row.state == COMPLETED || row.state == FAILED {
        crate::work_log::best_effort(&tx, "finished task", |conn| record_work_outcome(conn, &row));
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Change {
        applied: true,
        row: Some(row),
    })
}

/// The work log line for a delegation that just finished. Rework is send-backs already stored, plus each resumed
/// generation after the first. The source keeps a retry of this same finish from writing a second line.
fn record_work_outcome(conn: &Connection, row: &Delegation) -> Result<(), String> {
    let ending = if row.state == COMPLETED {
        "done"
    } else {
        "failed"
    };
    let rework = crate::work_log::sent_back_count(conn, &row.id)?
        .saturating_add(row.generation.saturating_sub(1));
    let source = crate::work_log::delegation_source(&row.id, ending, row.generation);
    let task = row
        .title
        .as_deref()
        .or(row.goal.as_deref())
        .or(row.brief.as_deref())
        .unwrap_or("");
    crate::work_log::record_outcome(
        conn,
        &crate::work_log::FinishedWork {
            project: row.project.as_deref().unwrap_or(""),
            task_id: &row.id,
            task,
            delivered: row.result.as_deref().unwrap_or(""),
            problem: if ending == "failed" {
                row.error.as_deref().unwrap_or("")
            } else {
                ""
            },
            ending,
            rework,
            queued_at: row.created_at,
            at_ms: row.settled_at.unwrap_or(row.updated_at),
            source: &source,
        },
    )?;
    Ok(())
}

/// WP-157: the checks sent this work back for another try. A repeat of the same try returns the first line. A task
/// that is already finished, or already gone, changes nothing: a late result is not a new outcome.
pub(crate) fn sent_back(
    conn: &mut Connection,
    id: &str,
    rework: i64,
    report: &str,
    now: i64,
) -> Result<Option<crate::work_log::Line>, String> {
    if !(1..=100).contains(&rework) {
        return Err("Rework has to be from 1 to 100.".into());
    }
    let id = id.trim();
    if id.is_empty() {
        return Err("There's no task with that id.".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(row) = get(&tx, id)? else {
        return Ok(None);
    };
    if !row.is_open() {
        return Ok(None);
    }
    let shown = crate::work_log::sent_back_count(&tx, &row.id)?
        .saturating_add(row.generation.saturating_sub(1))
        .saturating_add(1);
    let source = crate::work_log::delegation_source(&row.id, "sent-back", rework);
    let task = row
        .title
        .as_deref()
        .or(row.goal.as_deref())
        .or(row.brief.as_deref())
        .unwrap_or("");
    let line = crate::work_log::record_outcome(
        &tx,
        &crate::work_log::FinishedWork {
            project: row.project.as_deref().unwrap_or(""),
            task_id: &row.id,
            task,
            delivered: report,
            problem: "",
            ending: "sent back",
            rework: shown,
            queued_at: row.created_at,
            at_ms: now,
            source: &source,
        },
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(line))
}

struct StagedProof {
    folder: std::path::PathBuf,
    files: Vec<String>,
}

/// When this run started. Stored on the row at create and again on resume, so a log that has been trimmed to its
/// newest 50 lines cannot move the cutoff back to `created_at`.
fn run_started_ms(row: &Delegation) -> i64 {
    row.run_started_at
}

/// Read this run's proof before `settle` takes its write transaction. A row that will not be written, or a session
/// with no folder, reads nothing.
fn stage_evidence(conn: &Connection, input: &SettleInput) -> Option<StagedProof> {
    if input
        .result
        .as_ref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        return None;
    }
    let row = get(conn, &input.id).ok()??;
    if !row.is_open() || row.generation != input.generation {
        return None;
    }
    let folder = child_folder(conn, &row.child_session)?;
    let files = crate::plugins::verify::evidence_files(&folder, run_started_ms(&row));
    Some(StagedProof { folder, files })
}

/// The folder a worker's proof lives in: its worktree when it has one, otherwise the session folder. A missing row,
/// a missing column, or a path that isn't there adds nothing. It never fails the settle.
fn child_folder(conn: &Connection, session_id: &str) -> Option<std::path::PathBuf> {
    let (cwd, worktree): (String, Option<String>) = conn
        .query_row(
            "SELECT cwd, worktree_cwd FROM sessions WHERE id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    let chosen = worktree
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(cwd);
    let path = crate::fs::canonical(crate::fs::expand_home(chosen.trim())).ok()?;
    path.is_dir().then_some(path)
}

/// A new turn in a delegated child picks its row back up. An open row (its turn was cut off by a quit or crash) always
/// does; a failed or cancelled one only for a resumed turn (`resume`: auto-continue, a usage-limit resume), and never
/// one whose report was thrown away, or a followed brief (the app reports those by watching the chat). The generation
/// goes up, so the next report has its own receipt.
pub fn reattach(
    conn: &mut Connection,
    child_session: &str,
    resume: bool,
    by: Option<String>,
    now: i64,
) -> Result<Option<Delegation>, String> {
    let child = session_id(child_session, "child session")?;
    let by = actor(by);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    // The child's newest delegation, never an older one behind it (that one is another request's, maybe another
    // owner's). A refused launch never reached the child, so it is looked past.
    let latest = query(
        &tx,
        "WHERE child_session = ?1 AND follow IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 20",
        &[&child],
    )?
    .into_iter()
    .find(|row| row.last_event() != Some("refused"));
    let Some(mut row) = latest else {
        return Ok(None);
    };
    // Its report was thrown away: nothing comes back.
    if row.delivery == DISPOSED {
        return Ok(None);
    }
    // A later request took the child over: that row is over for good.
    let superseded = row
        .log
        .iter()
        .any(|entry| entry.get("event").and_then(Value::as_str) == Some("superseded"));
    let reopen = resume && !superseded && (row.state == FAILED || row.state == CANCELLED);
    if !row.is_open() && !reopen {
        return Ok(None);
    }
    let was = row.state.clone();
    row.generation += 1;
    row.run_started_at = now;
    row.unstall();
    if reopen {
        row.state = RUNNING.into();
        row.result = None;
        row.error = None;
        row.error_class = None;
        row.retryable = None;
        row.resets_at = None;
        row.settled_at = None;
        row.delivery = PENDING.into();
        row.delivery_message = None;
    }
    row.note(
        now,
        &by,
        "resumed",
        json!({ "generation": row.generation, "was": was }),
    );
    row.touch(now);
    save(&tx, &row)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(row))
}

/// A worker's question to its owner (H4): running → question with the question, or back to running once answered
/// (`question` empty). Only an open row moves. The app writes through `set_question_with`, which logs a detail too.
#[cfg(test)]
pub fn set_question(
    conn: &mut Connection,
    id: &str,
    question: Option<String>,
    by: Option<String>,
    now: i64,
) -> Result<Change, String> {
    set_question_with(conn, id, question, by, None, now)
}

/// What a question's log line may carry (H4): the question's request id, and for an answer what it was (`answers`, or
/// `skipped`). Anything else is dropped, and the whole detail is capped.
fn question_detail(detail: Option<Value>) -> Value {
    let Some(Value::Object(detail)) = detail else {
        return json!({});
    };
    let mut kept = serde_json::Map::new();
    for key in ["requestId", "answers", "skipped"] {
        if let Some(value) = detail.get(key) {
            kept.insert(key.into(), value.clone());
        }
    }
    let kept = Value::Object(kept);
    if kept.to_string().len() > QUESTION_MAX {
        return json!({ "requestId": detail.get("requestId").cloned().unwrap_or(Value::Null) });
    }
    kept
}

/// `set_question` with a detail for the row's log: who asked or answered is `by`; the first answer is the one logged,
/// since a repeated answer to a row already running changes nothing.
pub fn set_question_with(
    conn: &mut Connection,
    id: &str,
    question: Option<String>,
    by: Option<String>,
    detail: Option<Value>,
    now: i64,
) -> Result<Change, String> {
    let by = actor(by);
    let question = text(question, QUESTION_MAX);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut row) = get(&tx, id)? else {
        return Ok(Change {
            applied: false,
            row: None,
        });
    };
    let next = if question.is_some() {
        QUESTION
    } else {
        RUNNING
    };
    if !row.is_open() || (row.state == next && row.pending_question == question) {
        return Ok(Change {
            applied: false,
            row: Some(row),
        });
    }
    row.state = next.into();
    row.unstall();
    let event = if question.is_some() {
        "asked"
    } else {
        "answered"
    };
    row.pending_question = question;
    // WP-10: a new question (or its answer) goes to the first mate first; it passes one on with set_question_owner.
    row.question_owner = None;
    row.note(now, &by, event, question_detail(detail));
    row.touch(now);
    save(&tx, &row)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Change {
        applied: true,
        row: Some(row),
    })
}

const STALL_KINDS: [&str; 4] = ["quiet", "loop", "idle", "blocked"];
const STALL_REASON_MAX: usize = 300;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StallInput {
    pub id: String,
    /// The turn the watcher judged: a stall never lands on a newer one.
    pub generation: i64,
    /// `quiet`, `loop`, `idle` or `blocked`; none clears the stall (it moves again).
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    /// Since when it has been stuck this way, epoch ms; never later than now.
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub by: Option<String>,
}

/// Mark a running row stalled, or clear its stall (module docs). Only a running row of this generation moves; the same
/// kind again changes nothing (the watcher looks every half minute), so the outbox copies one change per stall.
pub fn set_stall(conn: &mut Connection, input: StallInput, now: i64) -> Result<Change, String> {
    let kind = text(input.kind, 20);
    if let Some(kind) = kind.as_deref() {
        if !STALL_KINDS.contains(&kind) {
            return Err("a stall is quiet, loop, idle or blocked".into());
        }
    }
    let by = actor(input.by);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut row) = get(&tx, &input.id)? else {
        return Ok(Change {
            applied: false,
            row: None,
        });
    };
    // The same stall again is a no-op; the same kind with a new reason (the hourly check's second stuck hour) is not.
    let reason = text(input.reason, STALL_REASON_MAX);
    let same = row.stall_kind == kind && (kind.is_none() || row.stall_reason == reason);
    if row.state != RUNNING || row.generation != input.generation || same {
        return Ok(Change {
            applied: false,
            row: Some(row),
        });
    }
    match kind {
        Some(kind) => {
            row.note(
                now,
                &by,
                "stalled",
                json!({ "kind": kind, "reason": reason, "generation": row.generation }),
            );
            row.stalled_at = Some(
                input
                    .since
                    .unwrap_or(now)
                    .clamp(row.created_at.min(now), now),
            );
            row.stall_kind = Some(kind);
            row.stall_reason = reason;
        }
        None => {
            row.note(
                now,
                &by,
                "unstalled",
                json!({ "was": row.stall_kind, "generation": row.generation }),
            );
            row.unstall();
        }
    }
    row.touch(now);
    save(&tx, &row)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Change {
        applied: true,
        row: Some(row),
    })
}

fn delivery_rank(delivery: &str) -> Option<u8> {
    match delivery {
        PENDING => Some(0),
        QUEUED => Some(1),
        DELIVERED => Some(2),
        ACKNOWLEDGED => Some(3),
        _ => None,
    }
}

/// Whether `row` may move to `wanted` (with `message` for queued): forward only, never out of disposed, and a report
/// only moves once the work has finished. Re-queuing under a new message id (boot recovery) is the one same-state move.
fn delivery_move(row: &Delegation, wanted: &str, message: Option<&str>) -> bool {
    delivery_step(
        &row.delivery,
        wanted,
        !row.is_open(),
        message.is_some() && row.delivery_message.as_deref() != message,
    )
}

/// The delivery ladder on its own (Hivra WP-11: the watcher's wake queue, watcher/queue.rs, moves the same way). A
/// move goes forward only, never out of disposed, and only once there is something to deliver (`ready`); re-queuing
/// under a new message id (`requeue`, boot recovery) is the one same-state move.
pub(crate) fn delivery_step(current: &str, wanted: &str, ready: bool, requeue: bool) -> bool {
    if current == DISPOSED {
        return false;
    }
    if wanted == DISPOSED {
        return true;
    }
    if !ready {
        return false;
    }
    if wanted == QUEUED && current == QUEUED {
        return requeue;
    }
    match (delivery_rank(current), delivery_rank(wanted)) {
        (Some(now), Some(next)) => next > now,
        _ => false,
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryInput {
    /// Rows by id...
    #[serde(default)]
    pub ids: Vec<String>,
    /// ...and/or every row a report message carries (`delivery_message`).
    #[serde(default)]
    pub message_id: Option<String>,
    pub delivery: String,
    /// The report message a queued row now waits in.
    #[serde(default)]
    pub queued_message: Option<String>,
    #[serde(default)]
    pub by: Option<String>,
}

/// Move the report's delivery. Returns the rows that changed; a repeated, backwards or post-dispose move is a no-op.
pub fn set_delivery(
    conn: &mut Connection,
    input: DeliveryInput,
    now: i64,
) -> Result<Vec<Delegation>, String> {
    let wanted = input.delivery.as_str();
    if delivery_rank(wanted).is_none() && wanted != DISPOSED {
        return Err("delivery must be pending, queued, delivered, acknowledged or disposed".into());
    }
    let message = text(input.queued_message, 300);
    if wanted == QUEUED && message.is_none() {
        return Err("a queued report names the message it waits in".into());
    }
    let by = actor(input.by);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for id in &input.ids {
        if let Some(row) = get(&tx, id)? {
            if seen.insert(row.id.clone()) {
                rows.push(row);
            }
        }
    }
    if let Some(message_id) = text(input.message_id, 300) {
        for row in query(&tx, "WHERE delivery_message = ?1", &[&message_id])? {
            if seen.insert(row.id.clone()) {
                rows.push(row);
            }
        }
    }
    let mut changed = Vec::new();
    for mut row in rows {
        if !delivery_move(&row, wanted, message.as_deref()) {
            continue;
        }
        let was = row.delivery.clone();
        row.delivery = wanted.into();
        if wanted == QUEUED {
            row.delivery_message = message.clone();
        }
        row.note(
            now,
            &by,
            "delivery",
            json!({ "delivery": wanted, "was": was, "generation": row.generation }),
        );
        row.touch(now);
        save(&tx, &row)?;
        changed.push(row);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

/// Stop what is still owed: an open row becomes cancelled (with the reason) and the report is thrown away. A finished
/// row only has its report thrown away. Used for the owner's Stop on a child and, later, `task_cancel` (H4).
pub fn cancel(
    conn: &mut Connection,
    ids: &[String],
    reason: Option<String>,
    by: Option<String>,
    now: i64,
) -> Result<Vec<Delegation>, String> {
    let by = actor(by);
    let reason = text(reason, ERROR_MAX);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut changed = Vec::new();
    for id in ids {
        let Some(mut row) = get(&tx, id)? else {
            continue;
        };
        let open = row.is_open();
        // Only what is still owed: a report already delivered (or read) stays on the record as it was.
        if !open && row.delivery != PENDING && row.delivery != QUEUED {
            continue;
        }
        if open {
            row.state = CANCELLED.into();
            row.error = reason
                .clone()
                .or_else(|| Some("Stopped by its owner.".into()));
            row.pending_question = None;
            row.unstall();
            row.settled_at = Some(now);
        }
        row.delivery = DISPOSED.into();
        row.note(now, &by, "cancelled", json!({ "was_open": open }));
        row.touch(now);
        save(&tx, &row)?;
        changed.push(row);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

/// A chat that redid another: its child session and the session it took over from (WP-176 round 4).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedoLink {
    pub child: String,
    pub parent: String,
}

/// Every redo link, for the spend gate: a redo counts against the ceiling of the chat it redid.
pub fn redo_links(conn: &Connection) -> Result<Vec<RedoLink>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT new_row.child_session, old_row.child_session
               FROM delegation_redos link
               JOIN delegations new_row ON new_row.id = link.new_id
               JOIN delegations old_row ON old_row.id = link.old_id
              ORDER BY link.created_at, link.new_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RedoLink {
                child: row.get(0)?,
                parent: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The owner retried or split one of its tasks (delegate_task `redoes`): `task` is the new task that takes it on. Kept
/// in the row's log, so its card can say what the Lead did after a restart too; several in one go are a split.
pub fn note_redo(
    conn: &mut Connection,
    owner_session: &str,
    id: &str,
    task: &str,
    now: i64,
) -> Result<Change, String> {
    let owner = session_id(owner_session, "owner session")?;
    let task = id_like(task, "task", 128)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut row) = get(&tx, id)?.filter(|row| row.owner_session == owner) else {
        return Err("no task of yours has that id".into());
    };
    if row.id == task {
        return Err("a task can't redo itself".into());
    }
    // The link is kept only for a new task that is the owner's: its chat then continues this one's spend ceiling
    // (redo_links). A name that is not a task of the owner's is still noted in the log, as before, with no link.
    if get(&tx, &task)?
        .filter(|new| new.owner_session == owner)
        .is_some()
    {
        tx.execute(
            "INSERT OR IGNORE INTO delegation_redos (new_id, old_id, owner_session, created_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![task, row.id, owner, now],
        )
        .map_err(|e| e.to_string())?;
    }
    row.note(
        now,
        &format!("owner:{owner}"),
        "lead_redo",
        json!({ "task": task }),
    );
    row.touch(now);
    save(&tx, &row)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Change {
        applied: true,
        row: Some(row),
    })
}

/// A launch the CLI refused: nothing ran and the calling turn already heard why, so no report is owed. A retry with
/// the same receipt revives it (`record`).
pub fn refuse(
    conn: &mut Connection,
    id: &str,
    by: Option<String>,
    now: i64,
) -> Result<Change, String> {
    let by = actor(by);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut row) = get(&tx, id)? else {
        return Ok(Change {
            applied: false,
            row: None,
        });
    };
    if row.state != RUNNING || row.generation != 1 {
        return Ok(Change {
            applied: false,
            row: Some(row),
        });
    }
    row.state = CANCELLED.into();
    row.unstall();
    row.error = Some("The launch was refused.".into());
    row.settled_at = Some(now);
    row.delivery = DISPOSED.into();
    row.note(now, &by, "refused", json!({}));
    row.touch(now);
    save(&tx, &row)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Change {
        applied: true,
        row: Some(row),
    })
}

/// Which of these report messages already reached the owner's transcript (a Mono's own transcript or a plain
/// session's blocks). Boot recovery asks before it queues a report again, whatever part of the chat is loaded.
pub fn reports_seen(
    conn: &Connection,
    owner_session: &str,
    message_ids: &[String],
) -> Result<Vec<String>, String> {
    let owner = session_id(owner_session, "owner session")?;
    let mut seen = Vec::new();
    for id in message_ids.iter().take(20) {
        let found: bool = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM mono_blocks
                                 WHERE session_id = ?1 AND is_user = 1
                                   AND json_extract(block_json, '$.appRequestId') = ?2)
                     OR EXISTS (SELECT 1 FROM sessions, json_each(sessions.blocks_json)
                                 WHERE sessions.id = ?1
                                   AND json_extract(json_each.value, '$.appRequestId') = ?2)",
                params![owner, id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if found {
            seen.push(id.clone());
        }
    }
    Ok(seen)
}

/// What boot recovery looks at: work still running, and reports still owed.
pub fn list_open(conn: &Connection) -> Result<Vec<Delegation>, String> {
    query(
        conn,
        "WHERE state IN ('running', 'question') OR delivery IN ('pending', 'queued')
         ORDER BY created_at, rowid",
        &[],
    )
}

/// Every row's chat and whether the row shows as done (`firstmate::status::is_done`), oldest first, without loading the
/// rows' text: the worktree clean-up reads the newest row per chat to see whether a worker's task was accepted.
pub(crate) fn acceptance(conn: &Connection) -> Result<Vec<(String, bool)>, String> {
    let mut statement = conn
        .prepare(
            "SELECT child_session, state, gate_verdict FROM delegations ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(child, state, gate)| {
            let done = crate::firstmate::status::is_done(&state, gate.as_deref());
            (child, done)
        })
        .collect())
}

/// SC-3b: the tasks that finished and show as done (`firstmate::status::is_done`) between `from` and `to` (epoch ms, by
/// when they settled), NEWEST first, at most `ACCEPTED_WINDOW_MAX` (a window with more keeps the newest, which are the
/// ones the newest commits hold). `keep` says whether a row's project is the one the caller wants: it reads the project
/// text as stored, so the caller compares it the way it compares paths. A followed brief is a message to a Lead, not a
/// task, and never counts. The ship check reads their briefs as the definition of done for the commits between two ship
/// checks. Only the light columns are read for every row in the window; the text of a brief is loaded for the ones kept.
pub fn accepted_in_window(
    conn: &Connection,
    from: i64,
    to: i64,
    mut keep: impl FnMut(&str) -> bool,
) -> Result<Vec<Delegation>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, project, state, gate_verdict FROM delegations
             WHERE follow IS NULL AND state = 'completed' AND project IS NOT NULL
               AND settled_at IS NOT NULL AND settled_at >= ?1 AND settled_at <= ?2
             ORDER BY settled_at DESC, rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([from, to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (id, project, state, gate) in rows {
        if out.len() >= ACCEPTED_WINDOW_MAX {
            break;
        }
        if !crate::firstmate::status::is_done(&state, gate.as_deref()) || !keep(&project) {
            continue;
        }
        if let Some(row) = get(conn, &id)? {
            out.push(row);
        }
    }
    Ok(out)
}

/// The most tasks `accepted_in_window` returns.
pub const ACCEPTED_WINDOW_MAX: usize = 200;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedQuery {
    pub owner_session: String,
    /// Rows by id...
    #[serde(default)]
    pub ids: Vec<String>,
    /// ...and/or by the request that recorded them.
    #[serde(default)]
    pub request_ids: Vec<String>,
}

const OWNED_MAX: usize = 20;

/// The rows one chat owns, for its task tools (H3): by id or request, or (neither) the ones still running and the ones
/// whose report it is still owed, newest first. Another chat's row is never returned, so a model can't read or move
/// work it didn't delegate even when it knows the id.
pub fn owned(conn: &Connection, input: OwnedQuery) -> Result<Vec<Delegation>, String> {
    let owner = session_id(&input.owner_session, "owner session")?;
    if input.ids.is_empty() && input.request_ids.is_empty() {
        return query(
            conn,
            "WHERE owner_session = ?1 AND (state IN ('running', 'question') OR delivery IN ('pending', 'queued'))
             ORDER BY created_at DESC, rowid DESC LIMIT ?2",
            &[&owner, &(OWNED_MAX as i64)],
        );
    }
    if input.ids.len() + input.request_ids.len() > OWNED_MAX {
        return Err(format!("At most {OWNED_MAX} tasks at once"));
    }
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for id in &input.ids {
        if let Some(row) = get(conn, id.trim())?.filter(|row| row.owner_session == owner) {
            if seen.insert(row.id.clone()) {
                rows.push(row);
            }
        }
    }
    for request in &input.request_ids {
        if let Some(row) = by_request(conn, &owner, request.trim())? {
            if seen.insert(row.id.clone()) {
                rows.push(row);
            }
        }
    }
    Ok(rows)
}

/// SC-7: the most rows `of_owner` reads.
const OF_OWNER_MAX: i64 = 200;

/// SC-7: every row one chat owns, in any state, oldest first, the newest `OF_OWNER_MAX` of them. The hold on a first mate's
/// "done" reads what is still open among them (firstmate/open_work.rs). Only that chat's rows: a blank id is refused.
pub fn of_owner(conn: &Connection, owner_session: &str) -> Result<Vec<Delegation>, String> {
    let owner = session_id(owner_session, "owner session")?;
    let mut rows = query(
        conn,
        "WHERE owner_session = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
        &[&owner, &OF_OWNER_MAX],
    )?;
    rows.reverse();
    Ok(rows)
}

/// The followed-brief rows (any state) behind briefs waiting in one chat's queue, by their request ids: the app checks
/// a waiting brief against its row before it goes in, so one cancelled meanwhile (task_cancel, a cascade Stop) never
/// does, even when the queue that still held it was saved before the cancel.
pub fn followed_into(
    conn: &Connection,
    child: &str,
    request_ids: &[String],
) -> Result<Vec<Delegation>, String> {
    let child = session_id(child, "child session")?;
    if request_ids.len() > OWNED_MAX {
        return Err(format!("At most {OWNED_MAX} briefs at once"));
    }
    let mut rows = Vec::new();
    for request in request_ids {
        rows.extend(query(
            conn,
            "WHERE child_session = ?1 AND request_id = ?2 AND follow IS NOT NULL",
            &[&child, &request.trim()],
        )?);
    }
    Ok(rows)
}

/// The whole delegation tree a row belongs to, oldest first.
pub fn tree(conn: &Connection, id: &str) -> Result<Vec<Delegation>, String> {
    let Some(row) = get(conn, id)? else {
        return Ok(Vec::new());
    };
    query(
        conn,
        "WHERE root_id = ?1 ORDER BY created_at, rowid",
        &[&row.root_id],
    )
}

const RECENT_MAX: i64 = 200;

/// What the delegation tree in the app shows (H4: child chats under the Mono that started them, a Lead's "Waiting on
/// N"): every row still running or owed, and the ones that changed since `since` (epoch ms), newest first.
pub fn recent(conn: &Connection, since: i64) -> Result<Vec<Delegation>, String> {
    query(
        conn,
        "WHERE state IN ('running', 'question') OR delivery IN ('pending', 'queued') OR updated_at >= ?1
         ORDER BY created_at DESC, rowid DESC LIMIT ?2",
        &[&since, &RECENT_MAX],
    )
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatBindInput {
    pub provider_session: String,
    pub chat_id: String,
    #[serde(default)]
    pub mono_id: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub delegation_id: Option<String>,
}

/// Which hub chat (and Mono, role, delegation) a Claude Code session belongs to, for the studio's `hub_chats`. Written
/// on every provider bind; only a real change gets a new version.
pub fn bind_chat(conn: &mut Connection, input: ChatBindInput, now: i64) -> Result<bool, String> {
    let provider = input.provider_session.trim().to_string();
    if provider.is_empty()
        || provider.len() > 128
        || !provider
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    {
        return Err("Invalid provider session".into());
    }
    let chat = session_id(&input.chat_id, "chat id")?;
    let mono = text(input.mono_id, 64).filter(|m| mono_id_ok(m));
    let role = text(input.role, 20)
        .filter(|r| ["lead", "mono", "worker", "checker"].contains(&r.as_str()));
    let delegation = text(input.delegation_id, 128);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let current = tx
        .query_row(
            "SELECT chat_id, mono_id, role, delegation_id FROM delegation_chat_binds WHERE provider_session = ?1",
            [&provider],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if current.as_ref() == Some(&(chat.clone(), mono.clone(), role.clone(), delegation.clone())) {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO delegation_chat_binds (provider_session, chat_id, mono_id, role, delegation_id, bound_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(provider_session) DO UPDATE SET chat_id = excluded.chat_id, mono_id = excluded.mono_id,
           role = excluded.role, delegation_id = excluded.delegation_id, bound_at = excluded.bound_at,
           version = delegation_chat_binds.version + 1, mirror_error = NULL",
        params![provider, chat, mono, role, delegation, now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

// ---- Tauri commands ----------------------------------------------------------------------------------------------------

// ---- Hivra WP-10: the first mate contract's additions (firstmate/) -------------------------------------------------

/// How many delegations sit above a chat: 0 for a chat nobody briefed (a first mate the person talks to), 1 for a worker
/// or a first mate briefed by one, and so on. It follows the open rows that name the chat as their child, then each
/// row's `parent_id` up to its root; the deepest chain counts.
pub fn depth_above(conn: &Connection, session: &str) -> Result<usize, String> {
    let mut deepest = 0;
    for row in open_for_child(conn, session)? {
        let mut depth = 1;
        let mut seen = HashSet::from([row.id.clone()]);
        let mut parent = row.parent_id.clone();
        while let Some(id) = parent {
            // A broken or looping chain stops counting; it can't grow without end.
            if !seen.insert(id.clone()) || depth > 16 {
                break;
            }
            match get(conn, &id)? {
                Some(above) => {
                    depth += 1;
                    parent = above.parent_id;
                }
                None => break,
            }
        }
        deepest = deepest.max(depth);
    }
    Ok(deepest)
}

/// A first mate passes its worker's open question on to the person (`person`), or takes it back (`first-mate`). Only
/// an open question of this generation moves.
pub fn set_question_owner(
    conn: &mut Connection,
    id: &str,
    generation: i64,
    owner: &str,
    by: Option<String>,
    now: i64,
) -> Result<Change, String> {
    use crate::firstmate::status::{QUESTION_FOR_FIRST_MATE, QUESTION_FOR_PERSON};
    let owner = match owner {
        QUESTION_FOR_PERSON => Some(QUESTION_FOR_PERSON.to_string()),
        QUESTION_FOR_FIRST_MATE => None,
        _ => return Err("a question is for the person or the first mate".into()),
    };
    let by = actor(by);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut row) = get(&tx, id)? else {
        return Ok(Change {
            applied: false,
            row: None,
        });
    };
    if row.state != QUESTION || row.generation != generation || row.question_owner == owner {
        return Ok(Change {
            applied: false,
            row: Some(row),
        });
    }
    row.note(
        now,
        &by,
        "question-owner",
        json!({ "for": owner.as_deref().unwrap_or(QUESTION_FOR_FIRST_MATE) }),
    );
    row.question_owner = owner;
    row.touch(now);
    save(&tx, &row)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Change {
        applied: true,
        row: Some(row),
    })
}

/// Hivra WP-40 (firstmate/gates.rs): the completion gates' verdict on the row, with one line of its history. While the
/// worker is still open (the gates run before its report settles), or, with `decided_by_owner`, only on a finished
/// row whose verdict is `unsure` and only by the chat that owns it (its first mate decides).
pub fn set_gate_verdict(
    conn: &mut Connection,
    id: &str,
    verdict: &str,
    summary: &str,
    decided_by_owner: Option<&str>,
    now: i64,
) -> Result<Change, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut row) = get(&tx, id)? else {
        return Ok(Change {
            applied: false,
            row: None,
        });
    };
    let allowed = match decided_by_owner {
        None => row.is_open(),
        Some(owner) => {
            row.owner_session == owner
                && row.state == COMPLETED
                && row.gate_verdict.as_deref()
                    == Some(crate::firstmate::status::GateVerdict::UNSURE)
        }
    };
    if !allowed {
        return Ok(Change {
            applied: false,
            row: Some(row),
        });
    }
    let by = match decided_by_owner {
        Some(owner) => format!("owner:{owner}"),
        None => "app:gates".to_string(),
    };
    row.note(
        now,
        &by,
        "gates",
        json!({ "verdict": verdict, "summary": cap(summary, 500) }),
    );
    row.gate_verdict = Some(verdict.to_string());
    row.touch(now);
    save(&tx, &row)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Change {
        applied: true,
        row: Some(row),
    })
}

fn changed(app: &AppHandle, rows: &[&Delegation]) {
    if rows.is_empty() {
        return;
    }
    let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    let _ = app.emit(CHANGED, json!({ "ids": ids }));
    // WP-70: tell every window the tasks this work moved.
    crate::tasks::emit_for_delegations(app);
}

#[tauri::command(async)]
pub fn delegations_record(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: RecordInput,
) -> Result<Delegation, String> {
    let row = record(&mut *store.lock_conn()?, input, now_millis())?;
    changed(&app, &[&row]);
    Ok(row)
}

#[tauri::command(async)]
pub fn delegations_settle(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: SettleInput,
) -> Result<Change, String> {
    let change = settle(&mut *store.lock_conn()?, input, now_millis())?;
    if let (true, Some(row)) = (change.applied, &change.row) {
        changed(&app, &[row]);
    }
    Ok(change)
}

/// WP-157: one work log line when checks send this work back.
#[tauri::command(async)]
pub fn delegations_sent_back(
    store: State<'_, SessionStore>,
    id: String,
    rework: i64,
    report: Option<String>,
) -> Result<bool, String> {
    Ok(sent_back(
        &mut *store.lock_conn()?,
        &id,
        rework,
        report.as_deref().unwrap_or(""),
        now_millis(),
    )?
    .is_some())
}

#[tauri::command(async)]
pub fn delegations_reattach(
    app: AppHandle,
    store: State<'_, SessionStore>,
    child_session: String,
    resume: bool,
    by: Option<String>,
) -> Result<Option<Delegation>, String> {
    let row = reattach(
        &mut *store.lock_conn()?,
        &child_session,
        resume,
        by,
        now_millis(),
    )?;
    if let Some(row) = &row {
        changed(&app, &[row]);
    }
    Ok(row)
}

#[tauri::command(async)]
pub fn delegations_set_question(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    question: Option<String>,
    by: Option<String>,
    detail: Option<Value>,
) -> Result<Change, String> {
    let change = set_question_with(
        &mut *store.lock_conn()?,
        &id,
        question,
        by,
        detail,
        now_millis(),
    )?;
    if let (true, Some(row)) = (change.applied, &change.row) {
        changed(&app, &[row]);
    }
    Ok(change)
}

#[tauri::command(async)]
pub fn delegations_set_stall(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: StallInput,
) -> Result<Change, String> {
    let change = set_stall(&mut *store.lock_conn()?, input, now_millis())?;
    if let (true, Some(row)) = (change.applied, &change.row) {
        changed(&app, &[row]);
    }
    Ok(change)
}

#[tauri::command(async)]
pub fn delegations_set_delivery(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: DeliveryInput,
) -> Result<Vec<Delegation>, String> {
    let rows = set_delivery(&mut *store.lock_conn()?, input, now_millis())?;
    changed(&app, &rows.iter().collect::<Vec<_>>());
    Ok(rows)
}

#[tauri::command(async)]
pub fn delegations_cancel(
    app: AppHandle,
    store: State<'_, SessionStore>,
    ids: Vec<String>,
    reason: Option<String>,
    by: Option<String>,
) -> Result<Vec<Delegation>, String> {
    let rows = cancel(&mut *store.lock_conn()?, &ids, reason, by, now_millis())?;
    changed(&app, &rows.iter().collect::<Vec<_>>());
    Ok(rows)
}

#[tauri::command(async)]
pub fn delegations_note_redo(
    app: AppHandle,
    store: State<'_, SessionStore>,
    owner_session: String,
    id: String,
    task: String,
) -> Result<Change, String> {
    let change = note_redo(
        &mut *store.lock_conn()?,
        &owner_session,
        &id,
        &task,
        now_millis(),
    )?;
    if let Some(row) = &change.row {
        changed(&app, &[row]);
    }
    Ok(change)
}

#[tauri::command(async)]
pub fn delegations_refuse(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
    by: Option<String>,
) -> Result<Change, String> {
    let change = refuse(&mut *store.lock_conn()?, &id, by, now_millis())?;
    if let (true, Some(row)) = (change.applied, &change.row) {
        changed(&app, &[row]);
    }
    Ok(change)
}

#[tauri::command(async)]
pub fn delegations_list_open(store: State<'_, SessionStore>) -> Result<Vec<Delegation>, String> {
    list_open(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn delegations_reports_seen(
    store: State<'_, SessionStore>,
    owner_session: String,
    message_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    reports_seen(&*store.lock_conn()?, &owner_session, &message_ids)
}

#[tauri::command(async)]
pub fn delegations_owned(
    store: State<'_, SessionStore>,
    input: OwnedQuery,
) -> Result<Vec<Delegation>, String> {
    owned(&*store.lock_conn()?, input)
}

#[tauri::command(async)]
pub fn delegations_followed_into(
    store: State<'_, SessionStore>,
    child_session: String,
    request_ids: Vec<String>,
) -> Result<Vec<Delegation>, String> {
    followed_into(&*store.lock_conn()?, &child_session, &request_ids)
}

#[tauri::command(async)]
pub fn delegations_tree(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<Vec<Delegation>, String> {
    tree(&*store.lock_conn()?, &id)
}

#[tauri::command(async)]
pub fn delegations_recent(
    store: State<'_, SessionStore>,
    since: i64,
) -> Result<Vec<Delegation>, String> {
    recent(&*store.lock_conn()?, since)
}

#[tauri::command(async)]
pub fn delegations_bind_chat(
    store: State<'_, SessionStore>,
    input: ChatBindInput,
) -> Result<bool, String> {
    bind_chat(&mut *store.lock_conn()?, input, now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SessionStore {
        SessionStore::open_in_memory().unwrap()
    }

    fn launch(owner: &str, request: &str, child: &str) -> RecordInput {
        RecordInput {
            owner_session: owner.into(),
            owner_mono: Some("vg-game-lead".into()),
            batch_id: Some("turn-1".into()),
            request_id: request.into(),
            child_session: child.into(),
            project: Some("/Users/ash/Projects/vg-game".into()),
            title: Some("Fix the save bug".into()),
            brief: Some("Fix the save bug on mission two".into()),
            ..Default::default()
        }
    }

    fn finish(id: &str, generation: i64, state: &str, result: &str) -> SettleInput {
        SettleInput {
            id: id.into(),
            generation,
            state: state.into(),
            result: Some(result.into()),
            ..Default::default()
        }
    }

    fn deliver(ids: &[&str], delivery: &str, message: Option<&str>) -> DeliveryInput {
        DeliveryInput {
            ids: ids.iter().map(|id| id.to_string()).collect(),
            delivery: delivery.into(),
            queued_message: message.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn a_pick_reason_is_kept_on_the_recorded_line_as_one_plain_line() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let mut input = launch("mono-exo", "app-mono-exo-why", "app-mono-exo-why");
        input.pick_reason = Some(
            "  Grok is on Never use, so it was skipped.\nBuilder role prefers Codex.  ".into(),
        );
        let row = record(&mut conn, input, 10).unwrap();
        let why = row.log[0].get("why").and_then(Value::as_str);
        assert_eq!(
            why,
            Some("Grok is on Never use, so it was skipped. Builder role prefers Codex.")
        );
        let mut long = launch("mono-exo", "app-mono-exo-long", "app-mono-exo-long");
        long.pick_reason = Some("x".repeat(400));
        let row = record(&mut conn, long, 11).unwrap();
        let kept = row.log[0].get("why").and_then(Value::as_str).unwrap_or("");
        assert!(kept.chars().count() <= 240, "a reason is capped");
        let mut blank = launch("mono-exo", "app-mono-exo-blank", "app-mono-exo-blank");
        blank.pick_reason = Some("   ".into());
        let row = record(&mut conn, blank, 12).unwrap();
        assert!(
            row.log[0].get("why").is_none(),
            "an empty reason is not written"
        );
    }

    #[test]
    fn a_recorded_delegation_is_running_owed_and_idempotent_by_request() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(
            &mut conn,
            launch("mono-exo", "app-mono-exo-a", "app-mono-exo-a"),
            10,
        )
        .unwrap();
        assert_eq!(
            (
                row.state.as_str(),
                row.delivery.as_str(),
                row.generation,
                row.version
            ),
            (RUNNING, PENDING, 1, 1)
        );
        assert_eq!(
            row.root_id, row.id,
            "a delegation from a top-level chat is its own root"
        );
        assert!(row.id.starts_with("t-"));
        let again = record(
            &mut conn,
            launch("mono-exo", "app-mono-exo-a", "app-mono-exo-a"),
            11,
        )
        .unwrap();
        assert_eq!(again, row, "the same request records nothing new");
        assert_eq!(list_open(&conn).unwrap().len(), 1);
    }

    #[test]
    fn record_refuses_bad_ids_and_asks_the_studio_would_refuse() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        assert!(record(&mut conn, launch("mono exo", "r", "c"), 1).is_err());
        assert!(record(&mut conn, launch("mono", "r", "c/../x"), 1).is_err());
        let mut asks = launch("mono", "r", "c");
        asks.ask_ids = vec!["a_good1".into(), "not-an-ask".into()];
        assert!(record(&mut conn, asks, 1).is_err());
        let mut ok = launch("mono", "r", "c");
        ok.ask_ids = vec!["a_good1".into()];
        assert_eq!(record(&mut conn, ok, 1).unwrap().ask_ids, vec!["a_good1"]);
    }

    #[test]
    fn settle_is_atomic_only_from_running_or_question_and_only_for_the_current_generation() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        let stale = settle(&mut conn, finish(&row.id, 2, COMPLETED, "late"), 11).unwrap();
        assert!(
            !stale.applied,
            "another generation's settle changes nothing"
        );
        let done = settle(&mut conn, finish(&row.id, 1, COMPLETED, "Fixed it"), 12).unwrap();
        assert!(done.applied);
        let done = done.row.unwrap();
        assert_eq!(
            (
                done.state.as_str(),
                done.result.as_deref(),
                done.settled_at,
                done.version
            ),
            (COMPLETED, Some("Fixed it"), Some(12), 2)
        );
        let twice = settle(&mut conn, finish(&row.id, 1, FAILED, "again"), 13).unwrap();
        assert!(!twice.applied, "a settled row stays settled");
        assert_eq!(twice.row.unwrap().state, COMPLETED);
        assert!(settle(&mut conn, finish(&row.id, 1, "running", ""), 14).is_err());
        assert!(
            !settle(&mut conn, finish("t-missing", 1, COMPLETED, ""), 14)
                .unwrap()
                .applied
        );
    }

    #[test]
    fn a_question_is_open_and_can_still_be_settled() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        let asked =
            set_question(&mut conn, &row.id, Some("Which branch?".into()), None, 11).unwrap();
        assert_eq!(asked.row.as_ref().unwrap().state, QUESTION);
        assert!(
            !set_question(&mut conn, &row.id, Some("Which branch?".into()), None, 12)
                .unwrap()
                .applied
        );
        let answered =
            set_question(&mut conn, &row.id, None, Some("owner:mono".into()), 13).unwrap();
        assert_eq!(answered.row.as_ref().unwrap().state, RUNNING);
        set_question(&mut conn, &row.id, Some("Merge?".into()), None, 14).unwrap();
        let settled = settle(&mut conn, finish(&row.id, 1, FAILED, ""), 15).unwrap();
        assert!(settled.applied);
        assert_eq!(settled.row.unwrap().pending_question, None);
        assert!(
            !set_question(&mut conn, &row.id, Some("late".into()), None, 16)
                .unwrap()
                .applied
        );
    }

    #[test]
    fn a_worker_report_is_not_marked_done_without_its_self_review() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let mut input = launch("mono", "req", "child");
        input.review_required = true;
        let row = record(&mut conn, input, 10).unwrap();
        assert!(row.review_required);
        // Refused, so the row stays open for the call that carries what it checked.
        let refused = settle(&mut conn, finish(&row.id, 1, COMPLETED, "all green"), 11);
        assert!(refused.unwrap_err().contains("self-review"));
        assert_eq!(get(&conn, &row.id).unwrap().unwrap().state, RUNNING);
        let done = settle(
            &mut conn,
            SettleInput {
                self_review: Some(
                    r#"{"checked":"the save bug","how":"ran mission two","unsure":"nothing","extra":"dropped"}"#
                        .into(),
                ),
                ..finish(&row.id, 1, COMPLETED, "all green")
            },
            12,
        )
        .unwrap();
        let done = done.row.unwrap();
        assert_eq!(done.state, COMPLETED);
        // Stored as the three lines the app reads back, whatever else the caller sent.
        assert_eq!(
            done.self_review.as_deref(),
            Some(r#"{"checked":"the save bug","how":"ran mission two","unsure":"nothing"}"#)
        );
        assert_eq!(
            get(&conn, &row.id).unwrap().unwrap().self_review,
            done.self_review
        );
    }

    #[test]
    fn a_self_review_with_a_line_missing_is_refused() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let mut input = launch("mono", "req", "child");
        input.review_required = true;
        let row = record(&mut conn, input, 10).unwrap();
        let empty = settle(
            &mut conn,
            SettleInput {
                self_review: Some(
                    r#"{"checked":"the save bug","how":"ran it","unsure":"  "}"#.into(),
                ),
                ..finish(&row.id, 1, COMPLETED, "done")
            },
            11,
        );
        assert!(empty.is_err());
        // A failed settle never needs one: a worker that did not finish has nothing to review.
        let failed = settle(
            &mut conn,
            SettleInput {
                self_review: Some("not json".into()),
                ..finish(&row.id, 1, FAILED, "")
            },
            12,
        );
        assert!(failed.is_err());
        assert!(
            settle(&mut conn, finish(&row.id, 1, FAILED, ""), 13)
                .unwrap()
                .applied
        );
    }

    #[test]
    fn errors_keep_the_provider_failure_and_are_capped() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        let failed = settle(
            &mut conn,
            SettleInput {
                id: row.id.clone(),
                generation: 1,
                state: FAILED.into(),
                result: Some("x".repeat(20_000)),
                error: Some("failed: billing refused".into()),
                error_class: Some("Billing!".into()),
                retryable: Some(false),
                resets_at: Some(99),
                by: None,
                self_review: None,
            },
            11,
        )
        .unwrap()
        .row
        .unwrap();
        assert_eq!(failed.error_class.as_deref(), Some("billing"));
        assert_eq!(failed.retryable, Some(false));
        assert_eq!(failed.resets_at, Some(99));
        assert_eq!(failed.result.unwrap().chars().count(), RESULT_MAX);
        let log = failed.log.last().unwrap();
        assert_eq!(log["event"], "settled");
        assert_eq!(log["error_class"], "billing");
    }

    #[test]
    fn delivery_moves_forward_once_and_disposed_is_final() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        assert!(
            set_delivery(&mut conn, deliver(&[&row.id], QUEUED, Some("m1")), 11)
                .unwrap()
                .is_empty(),
            "nothing is reported before the work finishes"
        );
        settle(&mut conn, finish(&row.id, 1, COMPLETED, "ok"), 12).unwrap();
        assert_eq!(
            set_delivery(&mut conn, deliver(&[&row.id], QUEUED, Some("m1")), 13)
                .unwrap()
                .len(),
            1
        );
        assert!(
            set_delivery(&mut conn, deliver(&[&row.id], QUEUED, Some("m1")), 14)
                .unwrap()
                .is_empty()
        );
        let by_message = DeliveryInput {
            message_id: Some("m1".into()),
            delivery: DELIVERED.into(),
            ..Default::default()
        };
        assert_eq!(
            set_delivery(&mut conn, by_message, 15).unwrap()[0].delivery,
            DELIVERED
        );
        assert!(
            set_delivery(&mut conn, deliver(&[&row.id], QUEUED, Some("m2")), 16)
                .unwrap()
                .is_empty()
        );
        assert!(
            set_delivery(&mut conn, deliver(&[&row.id], PENDING, None), 16)
                .unwrap()
                .is_empty()
        );
        assert!(set_delivery(&mut conn, deliver(&[&row.id], "lost", None), 16).is_err());
        assert!(set_delivery(&mut conn, deliver(&[&row.id], QUEUED, None), 16).is_err());
        assert!(
            list_open(&conn).unwrap().is_empty(),
            "a delivered report is no longer owed"
        );
    }

    /// T3's "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops"
    /// (DelegatedCompletionDelivery.test.ts, MIT): a second read-ack changes nothing, a dispose after it is final,
    /// and an ack after the dispose leaves it disposed.
    #[test]
    fn a_duplicate_read_ack_and_an_ack_after_dispose_are_no_ops() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        settle(&mut conn, finish(&row.id, 1, COMPLETED, "ok"), 11).unwrap();
        set_delivery(&mut conn, deliver(&[&row.id], QUEUED, Some("m")), 12).unwrap();
        set_delivery(&mut conn, deliver(&[&row.id], DELIVERED, None), 13).unwrap();
        let first = set_delivery(&mut conn, deliver(&[&row.id], ACKNOWLEDGED, None), 14).unwrap();
        assert_eq!(first[0].delivery, ACKNOWLEDGED);
        let after_first = get(&conn, &row.id).unwrap().unwrap();
        assert!(
            set_delivery(&mut conn, deliver(&[&row.id], ACKNOWLEDGED, None), 15)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            get(&conn, &row.id).unwrap().unwrap(),
            after_first,
            "the second ack left no trace"
        );
        let disposed = set_delivery(&mut conn, deliver(&[&row.id], DISPOSED, None), 16).unwrap();
        assert_eq!(disposed[0].delivery, DISPOSED);
        assert!(
            set_delivery(&mut conn, deliver(&[&row.id], DISPOSED, None), 17)
                .unwrap()
                .is_empty()
        );
        assert!(
            set_delivery(&mut conn, deliver(&[&row.id], ACKNOWLEDGED, None), 18)
                .unwrap()
                .is_empty()
        );
        assert_eq!(get(&conn, &row.id).unwrap().unwrap().delivery, DISPOSED);
    }

    /// T3's owner Stop: the owner stops the child, its report is thrown away and no later settle revives it.
    #[test]
    fn the_owners_stop_cancels_the_work_and_drops_the_report_for_good() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        let stopped = cancel(
            &mut conn,
            std::slice::from_ref(&row.id),
            None,
            Some("owner:mono".into()),
            11,
        )
        .unwrap();
        assert_eq!(
            (stopped[0].state.as_str(), stopped[0].delivery.as_str()),
            (CANCELLED, DISPOSED)
        );
        assert!(
            !settle(&mut conn, finish(&row.id, 1, COMPLETED, "late"), 12)
                .unwrap()
                .applied
        );
        assert!(
            reattach(&mut conn, "child", true, None, 13)
                .unwrap()
                .is_none(),
            "a thrown-away report never comes back"
        );
        assert!(list_open(&conn).unwrap().is_empty());
        assert!(
            cancel(&mut conn, std::slice::from_ref(&row.id), None, None, 14)
                .unwrap()
                .is_empty()
        );
    }

    /// T3's "holds a restart-cancelled child for its continuation's result": a child cut off by a quit stays running,
    /// its resumed turn re-attaches with a new generation and that turn's settle is the one that counts.
    #[test]
    fn a_resumed_turn_reattaches_and_bumps_the_generation() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        let resumed = reattach(&mut conn, "child", true, Some("boot".into()), 11)
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                resumed.id.as_str(),
                resumed.generation,
                resumed.state.as_str()
            ),
            (row.id.as_str(), 2, RUNNING)
        );
        assert!(
            !settle(&mut conn, finish(&row.id, 1, CANCELLED, ""), 12)
                .unwrap()
                .applied,
            "the cut turn's settle is stale"
        );
        let done = settle(
            &mut conn,
            finish(&row.id, 2, COMPLETED, "Finished after the restart."),
            13,
        )
        .unwrap();
        assert_eq!(
            done.row.unwrap().result.as_deref(),
            Some("Finished after the restart.")
        );
        assert!(
            reattach(&mut conn, "child", true, None, 14)
                .unwrap()
                .is_none(),
            "a completed row is done"
        );
        assert!(reattach(&mut conn, "someone-else", true, None, 14)
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_usage_limit_failure_reopens_only_for_a_resume() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        let mut limit = finish(&row.id, 1, FAILED, "");
        limit.error_class = Some("usage_limit".into());
        settle(&mut conn, limit, 11).unwrap();
        set_delivery(
            &mut conn,
            deliver(&[&row.id], QUEUED, Some("mono-completion-req-g1")),
            12,
        )
        .unwrap();
        set_delivery(&mut conn, deliver(&[&row.id], DELIVERED, None), 13).unwrap();
        assert!(
            reattach(&mut conn, "child", false, None, 14)
                .unwrap()
                .is_none(),
            "a plain message is the user's own"
        );
        let reopened = reattach(&mut conn, "child", true, None, 15)
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                reopened.generation,
                reopened.state.as_str(),
                reopened.delivery.as_str(),
                reopened.error_class.as_deref()
            ),
            (2, RUNNING, PENDING, None)
        );
        assert_eq!(
            reopened.delivery_message, None,
            "the next report gets its own receipt"
        );
    }

    /// A takes the child, B takes it over, B's report is thrown away: a resumed turn in the child is B's work, not A's.
    #[test]
    fn a_resume_never_reopens_another_owners_older_delegation() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let first = record(&mut conn, launch("mono-a", "req-a", "child"), 10).unwrap();
        let second = record(&mut conn, launch("mono-b", "req-b", "child"), 11).unwrap();
        let before = get(&conn, &first.id).unwrap().unwrap();
        assert_eq!(before.state, CANCELLED);
        settle(&mut conn, finish(&second.id, 1, COMPLETED, "done"), 12).unwrap();
        // B throws its report away.
        cancel(
            &mut conn,
            std::slice::from_ref(&second.id),
            None,
            Some("owner:mono-b".into()),
            13,
        )
        .unwrap();
        assert_eq!(
            reattach(&mut conn, "child", true, None, 14).unwrap(),
            None,
            "the newest delegation's report was thrown away: nothing comes back"
        );
        let after = get(&conn, &first.id).unwrap().unwrap();
        assert_eq!(
            (
                after.state.as_str(),
                after.delivery.as_str(),
                after.generation
            ),
            (CANCELLED, before.delivery.as_str(), before.generation),
            "A's superseded row is untouched"
        );
    }

    /// B's takeover was refused (nothing ran), so the newest real row is A's, which B's request superseded: it stays
    /// ended.
    #[test]
    fn a_superseded_delegation_is_never_reopened() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let first = record(&mut conn, launch("mono-a", "req-a", "child"), 10).unwrap();
        let second = record(&mut conn, launch("mono-b", "req-b", "child"), 11).unwrap();
        assert!(refuse(&mut conn, &second.id, None, 12).unwrap().applied);
        assert_eq!(reattach(&mut conn, "child", true, None, 13).unwrap(), None);
        assert_eq!(get(&conn, &first.id).unwrap().unwrap().state, CANCELLED);
    }

    /// A refused launch never ran, so it doesn't hide the work before it: a usage-limit resume still reopens that.
    #[test]
    fn a_refused_launch_does_not_hide_the_row_before_it() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        let mut limit = finish(&row.id, 1, FAILED, "");
        limit.error_class = Some("usage_limit".into());
        settle(&mut conn, limit, 11).unwrap();
        let refused = record(&mut conn, launch("mono", "req-2", "child"), 12).unwrap();
        assert!(refuse(&mut conn, &refused.id, None, 13).unwrap().applied);
        let reopened = reattach(&mut conn, "child", true, None, 14)
            .unwrap()
            .unwrap();
        assert_eq!(
            (reopened.id.as_str(), reopened.state.as_str()),
            (row.id.as_str(), RUNNING)
        );
    }

    /// The same owner and request id get the row already there back, even one the owner cancelled, so a restart that
    /// wants a worker of its own must send a new request id (WP-172: fanoutCheckpoint.ts resume, confirm).
    #[test]
    fn a_cancelled_request_comes_back_as_the_same_row_so_a_restart_needs_a_new_request_id() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let first = record(&mut conn, launch("mono", "req-x", "child-x"), 10).unwrap();
        cancel(&mut conn, std::slice::from_ref(&first.id), None, None, 11).unwrap();
        let again = record(&mut conn, launch("mono", "req-x", "child-x"), 12).unwrap();
        assert_eq!(
            (again.id.as_str(), again.state.as_str()),
            (first.id.as_str(), CANCELLED)
        );
        let restarted = record(&mut conn, launch("mono", "req-x-r2", "child-x"), 13).unwrap();
        assert_ne!(restarted.id, first.id);
        assert_eq!(restarted.state, RUNNING);
    }

    /// A worker waiting on its owner's answer is taken over by a later request: the question is no longer anyone's.
    #[test]
    fn a_row_taken_over_drops_its_waiting_question() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let first = record(&mut conn, launch("mono-a", "req-a", "child"), 10).unwrap();
        assert!(
            set_question(
                &mut conn,
                &first.id,
                Some("Which save slot?".into()),
                None,
                11
            )
            .unwrap()
            .applied
        );
        record(&mut conn, launch("mono-b", "req-b", "child"), 12).unwrap();
        let taken = get(&conn, &first.id).unwrap().unwrap();
        assert_eq!(
            (taken.state.as_str(), taken.pending_question),
            (CANCELLED, None)
        );
    }

    #[test]
    fn a_later_request_to_the_same_child_takes_over_an_open_one() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let first = record(&mut conn, launch("mono", "req-1", "child"), 10).unwrap();
        let second = record(&mut conn, launch("mono", "req-2", "child"), 11).unwrap();
        let first = get(&conn, &first.id).unwrap().unwrap();
        assert_eq!(
            (first.state.as_str(), first.delivery.as_str()),
            (CANCELLED, DISPOSED)
        );
        assert_eq!(
            reattach(&mut conn, "child", false, None, 12)
                .unwrap()
                .unwrap()
                .id,
            second.id
        );
    }

    #[test]
    fn a_refused_launch_owes_nothing_and_a_retry_with_its_receipt_revives_it() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        assert!(refuse(&mut conn, &row.id, None, 11).unwrap().applied);
        assert!(list_open(&conn).unwrap().is_empty());
        let retried = record(&mut conn, launch("mono", "req", "child"), 12).unwrap();
        assert_eq!(
            (
                retried.id.as_str(),
                retried.state.as_str(),
                retried.delivery.as_str()
            ),
            (row.id.as_str(), RUNNING, PENDING)
        );
        settle(&mut conn, finish(&row.id, 1, COMPLETED, "ok"), 13).unwrap();
        assert!(!refuse(&mut conn, &row.id, None, 14).unwrap().applied);
    }

    #[test]
    fn the_tree_links_a_workers_own_delegations_to_its_owner() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let top = record(&mut conn, launch("lead", "r1", "worker"), 10).unwrap();
        let mid = record(&mut conn, launch("worker", "r2", "helper"), 11).unwrap();
        let leaf = record(&mut conn, launch("helper", "r3", "leaf"), 12).unwrap();
        assert_eq!(mid.parent_id.as_deref(), Some(top.id.as_str()));
        assert_eq!(
            (leaf.parent_id.as_deref(), leaf.root_id.as_str()),
            (Some(mid.id.as_str()), top.id.as_str())
        );
        let ids: Vec<String> = tree(&conn, &leaf.id)
            .unwrap()
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(ids, vec![top.id.clone(), mid.id, leaf.id]);
        assert!(tree(&conn, "t-none").unwrap().is_empty());
        let other = record(&mut conn, launch("lead", "r9", "other"), 13).unwrap();
        assert_eq!(
            other.root_id, other.id,
            "another top-level delegation starts its own tree"
        );
    }

    fn followed(owner: &str, request: &str, child: &str, follow: &str) -> RecordInput {
        RecordInput {
            follow: Some(follow.into()),
            ..launch(owner, request, child)
        }
    }

    #[test]
    fn a_followed_brief_waits_its_turn_and_a_plain_request_never_cancels_one() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        // The child is busy with an earlier plain request; a brief queued behind it leaves that one running.
        let earlier = record(&mut conn, launch("cos", "r1", "lead-chat"), 10).unwrap();
        let queued = record(&mut conn, followed("pm", "r2", "lead-chat", "queue"), 11).unwrap();
        assert_eq!(queued.follow.as_deref(), Some("queue"));
        assert_eq!(get(&conn, &earlier.id).unwrap().unwrap().state, RUNNING);
        assert_eq!(queued.log[0]["follow"], json!("queue"));
        // A Lead's two briefs from two leadership Monos are both open.
        let lead_a = record(
            &mut conn,
            followed("cos", "lead-a", "lead-chat", "lead"),
            12,
        )
        .unwrap();
        let lead_b = record(&mut conn, followed("pm", "lead-b", "lead-chat", "lead"), 13).unwrap();
        // A later plain request takes over the plain row only.
        record(&mut conn, launch("ed", "r3", "lead-chat"), 14).unwrap();
        assert_eq!(get(&conn, &earlier.id).unwrap().unwrap().state, CANCELLED);
        for id in [&queued.id, &lead_a.id, &lead_b.id] {
            assert_eq!(get(&conn, id).unwrap().unwrap().state, RUNNING, "{id}");
        }
        // A resumed turn in that chat never re-attaches to a followed brief: the app watches those itself.
        let resumed = reattach(&mut conn, "lead-chat", true, None, 15)
            .unwrap()
            .unwrap();
        assert!(resumed.follow.is_none());
        assert!(
            record(&mut conn, followed("cos", "bad", "lead-chat", "later"), 16)
                .unwrap_err()
                .contains("follow must be")
        );
    }

    #[test]
    fn a_waiting_briefs_row_is_found_by_its_chat_and_request_in_any_state() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let kept = record(
            &mut conn,
            followed("cos", "lead-a", "lead-chat", "lead"),
            10,
        )
        .unwrap();
        let dropped = record(
            &mut conn,
            followed("cos", "lead-b", "lead-chat", "lead"),
            11,
        )
        .unwrap();
        // A plain launch's row into the same chat is not a brief that waits in its queue.
        record(&mut conn, launch("ed", "r1", "lead-chat"), 12).unwrap();
        cancel(
            &mut conn,
            std::slice::from_ref(&dropped.id),
            Some("Verify: cancelled".into()),
            Some("owner:cos".into()),
            13,
        )
        .unwrap();
        let ids = |rows: Vec<Delegation>| {
            rows.into_iter()
                .map(|row| (row.request_id, row.state))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(followed_into(
                &conn,
                "lead-chat",
                &["lead-a".into(), "lead-b".into(), "r1".into()]
            )
            .unwrap()),
            vec![
                ("lead-a".to_string(), RUNNING.to_string()),
                ("lead-b".to_string(), CANCELLED.to_string())
            ]
        );
        assert!(followed_into(&conn, "other-chat", &["lead-a".into()])
            .unwrap()
            .is_empty());
        assert_eq!(kept.state, RUNNING);
        let many: Vec<String> = (0..=OWNED_MAX).map(|n| format!("r{n}")).collect();
        assert!(followed_into(&conn, "lead-chat", &many).is_err());
    }

    #[test]
    fn a_leads_worker_goes_under_the_brief_the_app_names() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        // Two briefs open on the Lead's chat; the newest is still waiting in its queue.
        let working = record(
            &mut conn,
            followed("cos", "lead-a", "lead-chat", "lead"),
            10,
        )
        .unwrap();
        let waiting = record(&mut conn, followed("pm", "lead-b", "lead-chat", "lead"), 11).unwrap();
        let worker = record(
            &mut conn,
            RecordInput {
                parent_id: Some(working.id.clone()),
                ..launch("lead-chat", "w1", "worker")
            },
            12,
        )
        .unwrap();
        assert_eq!(
            (worker.parent_id.as_deref(), worker.root_id.as_str()),
            (Some(working.id.as_str()), working.id.as_str())
        );
        // A parent that isn't open above the owner is ignored: the newest open one is used.
        let fallback = record(
            &mut conn,
            RecordInput {
                parent_id: Some("t-not-mine".into()),
                ..launch("lead-chat", "w2", "worker-2")
            },
            13,
        )
        .unwrap();
        assert_eq!(fallback.parent_id.as_deref(), Some(waiting.id.as_str()));
        // The Lead-under-leadership rows are one tree (H4's cascade Stop walks it).
        let ids: Vec<String> = tree(&conn, &worker.id)
            .unwrap()
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(ids, vec![working.id.clone(), worker.id.clone()]);
    }

    fn stall(id: &str, generation: i64, kind: Option<&str>, since: i64) -> StallInput {
        StallInput {
            id: id.into(),
            generation,
            kind: kind.map(str::to_string),
            reason: kind.map(|k| format!("went {k}")),
            since: Some(since),
            by: Some("watch".into()),
        }
    }

    fn events(row: &Delegation) -> Vec<String> {
        row.log
            .iter()
            .filter_map(|entry| {
                entry
                    .get("event")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect()
    }

    #[test]
    fn a_running_worker_stalls_once_per_kind_and_clears_when_it_moves_again() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("lead", "r1", "worker"), 10).unwrap();

        let stalled = set_stall(&mut conn, stall(&row.id, 1, Some("quiet"), 400), 700).unwrap();
        assert!(stalled.applied);
        let stalled = stalled.row.unwrap();
        assert_eq!(stalled.stall_kind.as_deref(), Some("quiet"));
        assert_eq!(stalled.stall_reason.as_deref(), Some("went quiet"));
        // Since when it has been stuck this way (its last activity), not when the watcher noticed.
        assert_eq!(stalled.stalled_at, Some(400));
        assert_eq!(stalled.state, RUNNING);
        assert!(stalled.version > row.version, "a stall is copied to Ash OS");
        assert_eq!(events(&stalled).last().map(String::as_str), Some("stalled"));

        // The same stall again (the watcher ticks every half minute) changes nothing.
        let again = set_stall(&mut conn, stall(&row.id, 1, Some("quiet"), 650), 760).unwrap();
        assert!(!again.applied);
        assert_eq!(again.row.unwrap().stalled_at, Some(400));

        // Another kind of stall replaces it; a stall time in the future is the moment it was written.
        let looping = set_stall(&mut conn, stall(&row.id, 1, Some("loop"), 9_999), 800).unwrap();
        assert!(looping.applied);
        let looping = looping.row.unwrap();
        assert_eq!(looping.stall_kind.as_deref(), Some("loop"));
        assert_eq!(looping.stalled_at, Some(800));

        // Activity again: cleared, once.
        let moving = set_stall(&mut conn, stall(&row.id, 1, None, 0), 900).unwrap();
        assert!(moving.applied);
        let moving = moving.row.unwrap();
        assert_eq!(
            (
                moving.stall_kind.as_deref(),
                moving.stall_reason.as_deref(),
                moving.stalled_at
            ),
            (None, None, None)
        );
        assert_eq!(
            events(&moving).last().map(String::as_str),
            Some("unstalled")
        );
        assert!(
            !set_stall(&mut conn, stall(&row.id, 1, None, 0), 950)
                .unwrap()
                .applied
        );

        // It survives a read back from the store.
        set_stall(&mut conn, stall(&row.id, 1, Some("idle"), 960), 1_000).unwrap();
        let stored = get(&conn, &row.id).unwrap().unwrap();
        assert_eq!(stored.stall_kind.as_deref(), Some("idle"));
        assert_eq!(stored.stalled_at, Some(960));
    }

    // D5: the agent's own word that it cannot finish (task_cannot) is a stall of a fourth kind, `blocked`. It is not a
    // state either: the row stays running, and it stands (the watcher never clears it) until the row itself moves.
    #[test]
    fn a_declared_block_is_a_stall_until_the_row_moves() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("lead", "r1", "worker"), 10).unwrap();
        let block = StallInput {
            id: row.id.clone(),
            generation: 1,
            kind: Some("blocked".into()),
            reason: Some("The staging deploy key is not on this machine".into()),
            since: Some(400),
            by: Some("self:worker".into()),
        };
        let applied = set_stall(&mut conn, block.clone(), 700).unwrap();
        assert!(applied.applied);
        let blocked = applied.row.unwrap();
        assert_eq!(blocked.stall_kind.as_deref(), Some("blocked"));
        assert_eq!(
            blocked.stall_reason.as_deref(),
            Some("The staging deploy key is not on this machine")
        );
        assert_eq!(blocked.state, RUNNING);
        assert_eq!(events(&blocked).last().map(String::as_str), Some("stalled"));
        // Saying it again changes nothing.
        assert!(!set_stall(&mut conn, block, 760).unwrap().applied);
        // It survives a read back from the store, and only the row moving clears it.
        assert_eq!(
            get(&conn, &row.id).unwrap().unwrap().stall_kind.as_deref(),
            Some("blocked")
        );
        let moved = set_stall(&mut conn, stall(&row.id, 1, None, 0), 900).unwrap();
        assert_eq!(moved.row.unwrap().stall_kind, None);
        // Any other word is refused, and the list names the fourth kind.
        let error = set_stall(&mut conn, stall(&row.id, 1, Some("frozen"), 0), 950).unwrap_err();
        assert_eq!(error, "a stall is quiet, loop, idle or blocked");
    }

    #[test]
    fn a_lead_redo_is_kept_on_its_own_task_only() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("lead", "r1", "worker"), 10).unwrap();
        let noted = note_redo(&mut conn, "lead", &row.id, "t-new", 500).unwrap();
        assert!(noted.applied);
        let noted = noted.row.unwrap();
        assert!(
            noted.version > row.version,
            "the action is copied to Ash OS"
        );
        let entry = noted.log.last().unwrap();
        assert_eq!(entry["event"], "lead_redo");
        assert_eq!(entry["task"], "t-new");
        assert_eq!(entry["by"], "owner:lead");
        assert_eq!(entry["at"], 500);
        // It survives a read back from the store (an app restart).
        let stored = get(&conn, &row.id).unwrap().unwrap();
        assert_eq!(stored.log.last().unwrap()["event"], "lead_redo");
        // Another chat's task, or itself: refused.
        assert!(note_redo(&mut conn, "someone-else", &row.id, "t-new", 600).is_err());
        assert!(note_redo(&mut conn, "lead", &row.id, &row.id, 600).is_err());
    }

    #[test]
    fn a_redo_is_linked_in_its_own_record_and_refused_without_its_parent() {
        // Round 5 HIGH-1: the link is written with the new row, so the chat's first turn already sees it. A parent that
        // is not the owner's refuses the record, and a retried record cannot move the link to another parent.
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let old = record(&mut conn, launch("lead", "r1", "worker-old"), 10).unwrap();
        let other = record(&mut conn, launch("lead", "r9", "worker-other"), 11).unwrap();
        let redo = RecordInput {
            redoes: Some(old.id.clone()),
            ..launch("lead", "r2", "worker-new")
        };
        let created = record(&mut conn, redo.clone(), 20).unwrap();
        assert_eq!(
            redo_links(&conn).unwrap(),
            vec![RedoLink {
                child: "worker-new".into(),
                parent: "worker-old".into()
            }],
            "linked by the record itself, before any turn"
        );
        // A retry of the same request, naming another parent, keeps the first link.
        let retry = RecordInput {
            redoes: Some(other.id.clone()),
            ..launch("lead", "r2", "worker-new")
        };
        record(&mut conn, retry, 25).unwrap();
        assert_eq!(redo_links(&conn).unwrap().len(), 1);
        assert_eq!(redo_links(&conn).unwrap()[0].parent, "worker-old");
        // A parent of someone else's is refused, and no row is created for it.
        let stranger = RecordInput {
            redoes: Some(old.id.clone()),
            ..launch("someone-else", "r3", "worker-x")
        };
        assert!(record(&mut conn, stranger, 30).is_err());
        assert!(get(&conn, &created.id).unwrap().is_some());
        assert!(query(&conn, "WHERE request_id = ?1", &[&"r3"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_redo_links_its_new_chat_to_the_one_it_redid() {
        // Round 4 M-1: the redo the owner names is kept on the new chat's row, so the spend gate can count the redo
        // against its parent's ceiling after a restart. Through the real record and redo path.
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let old = record(&mut conn, launch("lead", "r1", "worker-old"), 10).unwrap();
        let new = record(&mut conn, launch("lead", "r2", "worker-new"), 20).unwrap();
        assert!(redo_links(&conn).unwrap().is_empty(), "no redo, no link");
        note_redo(&mut conn, "lead", &old.id, &new.id, 30).unwrap();
        assert_eq!(
            redo_links(&conn).unwrap(),
            vec![RedoLink {
                child: "worker-new".into(),
                parent: "worker-old".into()
            }]
        );
        // A task of someone else's is refused, and links nothing.
        assert!(note_redo(&mut conn, "someone-else", &old.id, &new.id, 40).is_err());
        assert_eq!(redo_links(&conn).unwrap().len(), 1);
    }

    #[test]
    fn the_same_stall_with_a_new_reason_is_written() {
        // The hourly progress check's second stuck hour: still a loop, but its line says what changed.
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("lead", "r1", "worker"), 10).unwrap();
        let first = set_stall(&mut conn, stall(&row.id, 1, Some("loop"), 100), 100).unwrap();
        assert!(first.applied);
        let mut later = stall(&row.id, 1, Some("loop"), 100);
        later.reason = Some("No real progress for 2 hours".into());
        let second = set_stall(&mut conn, later, 200).unwrap();
        assert!(second.applied);
        let second = second.row.unwrap();
        assert_eq!(
            second.stall_reason.as_deref(),
            Some("No real progress for 2 hours")
        );
        assert_eq!(second.stalled_at, Some(100));
        let mut again = stall(&row.id, 1, Some("loop"), 100);
        again.reason = Some("No real progress for 2 hours".into());
        assert!(!set_stall(&mut conn, again, 230).unwrap().applied);
    }

    #[test]
    fn only_a_running_row_of_this_generation_stalls() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("lead", "r1", "worker"), 10).unwrap();
        assert!(
            set_stall(&mut conn, stall(&row.id, 2, Some("quiet"), 5), 20)
                .unwrap()
                .row
                .unwrap()
                .stall_kind
                .is_none()
        );
        assert!(set_stall(&mut conn, stall(&row.id, 1, Some("asleep"), 5), 20).is_err());
        assert!(
            !set_stall(&mut conn, stall("t-missing", 1, Some("quiet"), 5), 20)
                .unwrap()
                .applied
        );
        // Asking its Lead is not a stall: that worker waits on an answer.
        set_question(&mut conn, &row.id, Some("Which branch?".into()), None, 30).unwrap();
        assert!(
            !set_stall(&mut conn, stall(&row.id, 1, Some("quiet"), 5), 40)
                .unwrap()
                .applied
        );
        set_question(&mut conn, &row.id, None, None, 50).unwrap();
        settle(&mut conn, finish(&row.id, 1, FAILED, ""), 60).unwrap();
        assert!(
            !set_stall(&mut conn, stall(&row.id, 1, Some("quiet"), 5), 70)
                .unwrap()
                .applied
        );
    }

    #[test]
    fn every_move_of_the_row_clears_its_stall() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let clear = |row: &Delegation| {
            assert_eq!(
                (row.stall_kind.as_deref(), row.stalled_at),
                (None, None),
                "{:?}",
                row.log
            );
        };
        // A question.
        let asked = record(&mut conn, launch("lead", "r1", "w1"), 10).unwrap();
        set_stall(&mut conn, stall(&asked.id, 1, Some("quiet"), 5), 20).unwrap();
        clear(
            &set_question(&mut conn, &asked.id, Some("Which?".into()), None, 30)
                .unwrap()
                .row
                .unwrap(),
        );
        clear(&get(&conn, &asked.id).unwrap().unwrap());
        // A settle.
        let settled = record(&mut conn, launch("lead", "r2", "w2"), 10).unwrap();
        set_stall(&mut conn, stall(&settled.id, 1, Some("loop"), 5), 20).unwrap();
        clear(
            &settle(&mut conn, finish(&settled.id, 1, COMPLETED, "done"), 30)
                .unwrap()
                .row
                .unwrap(),
        );
        // A resumed turn (a new generation).
        let resumed = record(&mut conn, launch("lead", "r3", "w3"), 10).unwrap();
        set_stall(&mut conn, stall(&resumed.id, 1, Some("idle"), 5), 20).unwrap();
        let again = reattach(&mut conn, "w3", true, None, 30).unwrap().unwrap();
        assert_eq!(again.generation, 2);
        clear(&again);
        // A Stop.
        let stopped = record(&mut conn, launch("lead", "r4", "w4"), 10).unwrap();
        set_stall(&mut conn, stall(&stopped.id, 1, Some("quiet"), 5), 20).unwrap();
        clear(&cancel(&mut conn, std::slice::from_ref(&stopped.id), None, None, 30).unwrap()[0]);
        // A later request that takes the chat over.
        let older = record(&mut conn, launch("lead", "r5", "w5"), 10).unwrap();
        set_stall(&mut conn, stall(&older.id, 1, Some("quiet"), 5), 20).unwrap();
        record(&mut conn, launch("lead", "r6", "w5"), 30).unwrap();
        clear(&get(&conn, &older.id).unwrap().unwrap());
    }

    #[test]
    fn an_older_store_gets_the_stall_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE delegations (id TEXT PRIMARY KEY, owner_session TEXT NOT NULL, owner_mono TEXT, batch_id TEXT,
               parent_id TEXT, root_id TEXT NOT NULL, child_session TEXT NOT NULL, request_id TEXT NOT NULL,
               generation INTEGER NOT NULL DEFAULT 1, project TEXT, title TEXT, brief TEXT, goal TEXT,
               ask_ids TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, error_class TEXT, error TEXT, retryable INTEGER,
               resets_at INTEGER, result TEXT, pending_question TEXT, delivery TEXT NOT NULL, delivery_message TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER,
               log TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
               mirrored_version INTEGER NOT NULL DEFAULT 0, mirror_error TEXT, follow TEXT,
               UNIQUE (owner_session, request_id));",
        )
        .unwrap();
        ensure_tables(&conn).unwrap();
        ensure_tables(&conn).unwrap();
        let mut conn = conn;
        let row = record(&mut conn, launch("lead", "r1", "worker"), 1).unwrap();
        set_stall(&mut conn, stall(&row.id, 1, Some("quiet"), 1), 2).unwrap();
        assert_eq!(
            get(&conn, &row.id).unwrap().unwrap().stall_kind.as_deref(),
            Some("quiet")
        );
    }

    #[test]
    fn an_older_store_gets_the_follow_column() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE delegations (id TEXT PRIMARY KEY, owner_session TEXT NOT NULL, owner_mono TEXT, batch_id TEXT,
               parent_id TEXT, root_id TEXT NOT NULL, child_session TEXT NOT NULL, request_id TEXT NOT NULL,
               generation INTEGER NOT NULL DEFAULT 1, project TEXT, title TEXT, brief TEXT, goal TEXT,
               ask_ids TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, error_class TEXT, error TEXT, retryable INTEGER,
               resets_at INTEGER, result TEXT, pending_question TEXT, delivery TEXT NOT NULL, delivery_message TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER,
               log TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
               mirrored_version INTEGER NOT NULL DEFAULT 0, mirror_error TEXT, UNIQUE (owner_session, request_id));",
        )
        .unwrap();
        ensure_tables(&conn).unwrap();
        ensure_tables(&conn).unwrap();
        let mut conn = conn;
        let row = record(&mut conn, followed("cos", "r", "lead-chat", "lead"), 1).unwrap();
        assert_eq!(
            get(&conn, &row.id).unwrap().unwrap().follow.as_deref(),
            Some("lead")
        );
    }

    #[test]
    fn an_older_store_gets_the_brief_columns_once_and_keeps_its_rows() {
        // SC-4: brief_stamp, brief_checks and brief_leave are added to a store from before, and a second pass adds nothing.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE delegations (id TEXT PRIMARY KEY, owner_session TEXT NOT NULL, owner_mono TEXT, batch_id TEXT,
               parent_id TEXT, root_id TEXT NOT NULL, child_session TEXT NOT NULL, request_id TEXT NOT NULL,
               generation INTEGER NOT NULL DEFAULT 1, project TEXT, title TEXT, brief TEXT, goal TEXT,
               ask_ids TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, error_class TEXT, error TEXT, retryable INTEGER,
               resets_at INTEGER, result TEXT, pending_question TEXT, delivery TEXT NOT NULL, delivery_message TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER,
               log TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
               mirrored_version INTEGER NOT NULL DEFAULT 0, mirror_error TEXT, UNIQUE (owner_session, request_id));
             INSERT INTO delegations (id, owner_session, root_id, child_session, request_id, state, delivery, created_at, updated_at)
               VALUES ('d-old', 'lead', 'd-old', 'w', 'r', 'running', 'pending', 1, 1);",
        )
        .unwrap();
        ensure_tables(&conn).unwrap();
        ensure_tables(&conn).unwrap();
        let (stamp, checks, leave): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT brief_stamp, brief_checks, brief_leave FROM delegations WHERE id = 'd-old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((stamp, checks, leave), (None, None, None));
        // A row from before reads as a brief with no lines, no list and no stamp.
        let state = crate::firstmate::brief_checks::state_of(&conn, "d-old").unwrap();
        assert_eq!(state, crate::firstmate::brief_checks::BriefState::default());
    }

    #[test]
    fn a_question_and_its_first_answer_are_logged_with_who_and_what() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("lead", "r1", "worker"), 10).unwrap();
        set_question_with(
            &mut conn,
            &row.id,
            Some("Which branch? [main | next]".into()),
            Some("worker:worker".into()),
            Some(json!({ "requestId": 3, "secret": "dropped" })),
            11,
        )
        .unwrap();
        let first = set_question_with(
            &mut conn,
            &row.id,
            None,
            Some("owner:lead".into()),
            Some(json!({ "requestId": 3, "answers": { "q1": ["main"] } })),
            12,
        )
        .unwrap();
        assert!(first.applied);
        // A second answer to the same question (Ash in the worker's chat, a retry) finds it running: not logged.
        let second = set_question_with(
            &mut conn,
            &row.id,
            None,
            Some("chat:worker".into()),
            Some(json!({ "requestId": 3, "skipped": true })),
            13,
        )
        .unwrap();
        assert!(!second.applied);
        let log = get(&conn, &row.id).unwrap().unwrap().log;
        let asked = log.iter().find(|e| e["event"] == "asked").unwrap();
        assert_eq!(asked["by"], "worker:worker");
        assert_eq!(asked["requestId"], 3);
        assert!(asked.get("secret").is_none());
        let answered: Vec<&Value> = log.iter().filter(|e| e["event"] == "answered").collect();
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0]["by"], "owner:lead");
        assert_eq!(answered[0]["answers"], json!({ "q1": ["main"] }));
        // An oversized answer keeps only its request id.
        set_question(&mut conn, &row.id, Some("Again?".into()), None, 14).unwrap();
        set_question_with(
            &mut conn,
            &row.id,
            None,
            None,
            Some(json!({ "requestId": 4, "answers": { "q": ["x".repeat(5_000)] } })),
            15,
        )
        .unwrap();
        let last = get(&conn, &row.id).unwrap().unwrap().log.pop().unwrap();
        assert_eq!(last["requestId"], 4);
        assert!(last.get("answers").is_none());
    }

    #[test]
    fn recent_lists_what_is_open_or_owed_and_what_changed_since() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let old = record(&mut conn, launch("lead", "r1", "a"), 10).unwrap();
        settle(&mut conn, finish(&old.id, 1, COMPLETED, "done"), 11).unwrap();
        set_delivery(
            &mut conn,
            DeliveryInput {
                ids: vec![old.id.clone()],
                delivery: ACKNOWLEDGED.into(),
                ..Default::default()
            },
            12,
        )
        .unwrap();
        let fresh = record(&mut conn, launch("lead", "r2", "b"), 20).unwrap();
        let owed = record(&mut conn, launch("lead", "r3", "c"), 21).unwrap();
        settle(&mut conn, finish(&owed.id, 1, FAILED, ""), 22).unwrap();
        let ids = |since| -> Vec<String> {
            recent(&conn, since)
                .unwrap()
                .into_iter()
                .map(|d| d.id)
                .collect()
        };
        assert_eq!(ids(100), vec![owed.id.clone(), fresh.id.clone()]);
        assert_eq!(ids(0), vec![owed.id, fresh.id, old.id]);
    }

    #[test]
    fn the_log_keeps_the_newest_fifty_entries_with_who_acted() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        for at in 0..60 {
            reattach(
                &mut conn,
                "child",
                false,
                Some(format!("tester-{at}")),
                100 + at,
            )
            .unwrap();
        }
        let row = get(&conn, &row.id).unwrap().unwrap();
        assert_eq!(row.log.len(), LOG_MAX);
        assert_eq!(row.log.last().unwrap()["by"], "tester-59");
        assert_eq!(row.generation, 61);
    }

    #[test]
    fn a_chat_bind_gets_a_new_version_only_when_it_changes() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let bind = |mono: Option<&str>| ChatBindInput {
            provider_session: "7f1c-claude".into(),
            chat_id: "mono-exo".into(),
            mono_id: mono.map(str::to_string),
            role: Some("lead".into()),
            delegation_id: None,
        };
        assert!(bind_chat(&mut conn, bind(Some("vg-game-lead")), 1).unwrap());
        assert!(!bind_chat(&mut conn, bind(Some("vg-game-lead")), 2).unwrap());
        assert!(bind_chat(&mut conn, bind(Some("ed")), 3).unwrap());
        assert!(bind_chat(
            &mut conn,
            ChatBindInput {
                provider_session: "bad id!".into(),
                ..bind(None)
            },
            4
        )
        .is_err());
        let version: i64 = conn
            .query_row("SELECT version FROM delegation_chat_binds", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 2);
    }

    #[test]
    fn the_checker_binds_with_its_own_role() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let input = |role: &str| ChatBindInput {
            provider_session: format!("claude-{role}"),
            chat_id: "mono-checker".into(),
            mono_id: Some("checker".into()),
            role: Some(role.into()),
            delegation_id: None,
        };
        assert!(bind_chat(&mut conn, input("checker"), 1).unwrap());
        assert!(bind_chat(&mut conn, input("boss"), 2).unwrap());
        let roles: Vec<Option<String>> = conn
            .prepare("SELECT role FROM delegation_chat_binds ORDER BY provider_session")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(roles, vec![None, Some("checker".into())]);
    }

    #[test]
    fn a_chat_reads_only_its_own_rows_by_id_by_request_or_what_is_still_owed() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let mine = record(&mut conn, launch("mono-exo", "app-mono-exo-a", "c-a"), 10).unwrap();
        let done = record(&mut conn, launch("mono-exo", "app-mono-exo-b", "c-b"), 11).unwrap();
        let read = record(&mut conn, launch("mono-exo", "app-mono-exo-c", "c-c"), 12).unwrap();
        let theirs = record(
            &mut conn,
            launch("mono-hivra", "app-mono-hivra-a", "c-h"),
            13,
        )
        .unwrap();
        settle(&mut conn, finish(&done.id, 1, COMPLETED, "ok"), 14).unwrap();
        settle(&mut conn, finish(&read.id, 1, COMPLETED, "ok"), 15).unwrap();
        set_delivery(&mut conn, deliver(&[&read.id], ACKNOWLEDGED, None), 16).unwrap();
        let query = |ids: &[&str], requests: &[&str]| OwnedQuery {
            owner_session: "mono-exo".into(),
            ids: ids.iter().map(|id| id.to_string()).collect(),
            request_ids: requests.iter().map(|id| id.to_string()).collect(),
        };
        let ids = |rows: Vec<Delegation>| rows.into_iter().map(|row| row.id).collect::<Vec<_>>();
        assert_eq!(
            ids(owned(&conn, query(&[], &[])).unwrap()),
            vec![done.id.clone(), mine.id.clone()],
            "running and owed, newest first; a read result and another chat's row are left out"
        );
        assert_eq!(
            ids(owned(&conn, query(&[&read.id, &theirs.id, "t-missing"], &[])).unwrap()),
            vec![read.id.clone()],
            "another chat's row is never returned, even by its id"
        );
        assert_eq!(
            ids(owned(&conn, query(&[], &["app-mono-exo-a", "app-mono-hivra-a"])).unwrap()),
            vec![mine.id.clone()]
        );
        assert!(owned(
            &conn,
            OwnedQuery {
                owner_session: "bad owner!".into(),
                ..Default::default()
            }
        )
        .is_err());
        let many: Vec<String> = (0..21).map(|n| format!("t-{n}")).collect();
        assert!(owned(
            &conn,
            OwnedQuery {
                owner_session: "mono-exo".into(),
                ids: many,
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn a_report_is_seen_in_a_monos_transcript_or_a_plain_sessions_blocks() {
        let store = store();
        let conn = store.lock_conn().unwrap();
        for id in ["mono-exo", "plain"] {
            conn.execute(
                "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
                 VALUES (?1, '/p', 'claude', '', 'supervised', 't', 1, 1)",
                [id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO mono_transcripts (session_id) VALUES ('mono-exo')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO mono_blocks (session_id, seq, block_id, block_json, search_text, is_user, is_draft)
             VALUES ('mono-exo', 1, 'b1', ?1, '', 1, 0)",
            [json!({"id": "b1", "role": "user", "appRequestId": "mono-completion-r1-g1"}).to_string()],
        )
        .unwrap();
        conn.execute(
            "UPDATE sessions SET blocks_json = ?1 WHERE id = 'plain'",
            [
                json!([{"id": "b2", "role": "user", "appRequestId": "mono-completion-r2-g2"}])
                    .to_string(),
            ],
        )
        .unwrap();
        let ids = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            reports_seen(
                &conn,
                "mono-exo",
                &ids(&["mono-completion-r1-g1", "mono-completion-r1-g2"])
            )
            .unwrap(),
            ids(&["mono-completion-r1-g1"])
        );
        assert_eq!(
            reports_seen(&conn, "plain", &ids(&["mono-completion-r2-g2"])).unwrap(),
            ids(&["mono-completion-r2-g2"])
        );
        assert!(
            reports_seen(&conn, "plain", &ids(&["mono-completion-r1-g1"]))
                .unwrap()
                .is_empty()
        );
        assert!(reports_seen(&conn, "bad id", &ids(&["x"])).is_err());
    }

    #[test]
    fn cancel_leaves_a_delivered_report_on_the_record() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let row = record(&mut conn, launch("mono", "req", "child"), 10).unwrap();
        settle(&mut conn, finish(&row.id, 1, COMPLETED, "ok"), 11).unwrap();
        set_delivery(&mut conn, deliver(&[&row.id], QUEUED, Some("m")), 12).unwrap();
        set_delivery(&mut conn, deliver(&[&row.id], DELIVERED, None), 13).unwrap();
        assert!(
            cancel(&mut conn, std::slice::from_ref(&row.id), None, None, 14)
                .unwrap()
                .is_empty()
        );
        assert_eq!(get(&conn, &row.id).unwrap().unwrap().delivery, DELIVERED);
    }
}

/// WP-203: a cancelled or failed review row becomes a new attempt. It runs again under a new generation, so a settle
/// from the old attempt is refused as stale. Only the app's review row can be reopened here.
pub(crate) fn reopen_review(
    conn: &mut Connection,
    id: &str,
    now: i64,
) -> Result<Delegation, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut row = get(&tx, id)?.ok_or("no such review")?;
    if row.owner_session != crate::delivery::review::OWNER {
        return Err("only the app's review can be reopened".into());
    }
    if row.state == CANCELLED || row.state == FAILED {
        row.state = RUNNING.into();
        row.generation += 1;
        row.delivery = PENDING.into();
        row.delivery_message = None;
        row.error = None;
        row.error_class = None;
        row.result = None;
        row.settled_at = None;
        row.run_started_at = now;
        row.note(
            now,
            "app",
            "retried",
            json!({ "generation": row.generation }),
        );
        row.touch(now);
        save_row(&tx, &row)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(row)
}

/// WP-203: the review owner is the app's alone, on every entry that records a delegation or lists one for a caller.
#[cfg(test)]
mod review_guard_tests {
    use super::*;
    use crate::delivery::review::{request_id, OWNER};

    fn store() -> SessionStore {
        SessionStore::open_in_memory().unwrap()
    }

    fn input(owner: &str, request: &str) -> RecordInput {
        RecordInput {
            owner_session: owner.into(),
            request_id: request.into(),
            child_session: "child-1".into(),
            ..Default::default()
        }
    }

    fn launcher(request: &str) -> RecordInput {
        RecordInput {
            review_launch: true,
            ..input(OWNER, request)
        }
    }

    const HEAD: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";

    // Entry: the record command (delegations_record). delegate_task, delegate_tasks, the MCP tools and the control
    // socket's tasks.* actions all reach it through the app's TypeScript layer, with the caller's own session as owner.
    #[test]
    fn a_caller_cannot_record_under_the_review_owner() {
        let s = store();
        let mut conn = s.lock_conn().unwrap();
        let err = record(&mut conn, input(OWNER, "agent-request-1"), 10).unwrap_err();
        assert!(err.contains("review launcher"), "{err}");
    }

    #[test]
    fn a_caller_cannot_record_a_review_request_under_its_own_owner() {
        let s = store();
        let mut conn = s.lock_conn().unwrap();
        let id = request_id("acme/web", 7, HEAD, "claude");
        assert!(record(&mut conn, input("claude-session", &id), 10).is_err());
    }

    // Entry: the command's JSON. A caller can't claim the launcher's flag.
    #[test]
    fn the_launcher_flag_cannot_come_from_json() {
        let parsed: RecordInput = serde_json::from_value(json!({
            "ownerSession": OWNER,
            "requestId": request_id("acme/web", 7, HEAD, "claude"),
            "childSession": "child-1",
            "reviewLaunch": true,
        }))
        .unwrap();
        assert!(!parsed.review_launch);
        let s = store();
        let mut conn = s.lock_conn().unwrap();
        assert!(record(&mut conn, parsed, 10).is_err());
    }

    #[test]
    fn the_launcher_records_its_own_review_and_no_one_else_can() {
        let s = store();
        let mut conn = s.lock_conn().unwrap();
        let id = request_id("acme/web", 7, HEAD, "claude");
        let row = record(&mut conn, launcher(&id), 10).unwrap();
        assert_eq!(row.owner_session, OWNER);
        // The launcher's flag names a review request only: it can't record an ordinary request under the review owner.
        assert!(record(&mut conn, launcher("ordinary-request"), 11).is_err());
    }

    // Entry: the listing a caller reads for its own rows (owned). A review row never appears under a caller's session.
    #[test]
    fn a_callers_listing_never_shows_a_review_row() {
        let s = store();
        let mut conn = s.lock_conn().unwrap();
        let id = request_id("acme/web", 7, HEAD, "claude");
        record(&mut conn, launcher(&id), 10).unwrap();
        let listed = owned(
            &conn,
            OwnedQuery {
                owner_session: "claude-session".into(),
                ids: Vec::new(),
                request_ids: vec![id.clone()],
            },
        )
        .unwrap();
        assert!(
            listed.is_empty(),
            "a caller listed a review row: {listed:?}"
        );
        let by_owner = owned(
            &conn,
            OwnedQuery {
                owner_session: OWNER.into(),
                ids: Vec::new(),
                request_ids: vec![id],
            },
        )
        .unwrap();
        assert_eq!(by_owner.len(), 1, "the app still sees its own review row");
    }
}
