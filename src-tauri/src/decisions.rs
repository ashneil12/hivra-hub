//! Hivra WP-14: decisions, the questions only the person can answer (docs/hivra/SPEC.md section 4,
//! docs/hivra/work/WP-14-steering-decisions.md; AgentOS's decision gate with stable keys).
//!
//! - **One question, one key.** A first mate asks through one tool, `ask_person(key, question, options, recommended)`.
//!   The decision is stored once under `(project, decision_key)`; asking again with the same key changes nothing about
//!   it (not the question, not the options), it only adds the asker's tasks that wait on it, and an answered key gives
//!   back the answer at once.
//! - **Questions go up one level.** Only the chat the person talks to (a first mate at the top of its work) may ask the
//!   person. A worker, or a first mate working for another first mate, is turned back with a plain reason: its question
//!   goes to its own first mate (`task_cannot` or its report), which answers it or asks the person itself.
//! - **Answering releases the work.** The person's answer (the Inbox, WP-15, or chat) is stored, and in the same step
//!   every delegation still open that waits on it gets a steering message with the answer (steering.rs), as does the
//!   first mate that asked. The rows' questions go back to their first mate, so they read as working again.
//!
//! Own table, made by `ensure_tables` (no numbered migration, so upstream's migration numbers can't collide).

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::delegations;
use crate::firstmate::status::{QUESTION_FOR_FIRST_MATE, QUESTION_FOR_PERSON};
use crate::session_store::{now_millis, SessionStore};
use crate::steering::{self, SteerInput, SteerMessage};

/// Tauri event after any change: `{keys}`.
pub const CHANGED: &str = "hivra:decisions-changed";

pub const OPEN: &str = "open";
pub const ANSWERED: &str = "answered";

const KEY_MAX: usize = 120;
const QUESTION_MAX: usize = 2_000;
const OPTION_MAX: usize = 200;
const OPTIONS_MIN: usize = 2;
const OPTIONS_MAX: usize = 6;
const ANSWER_MAX: usize = 2_000;
const WAITING_MAX: usize = 20;

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS decisions (
           project TEXT NOT NULL DEFAULT '',
           decision_key TEXT NOT NULL,
           question TEXT NOT NULL,
           options TEXT NOT NULL DEFAULT '[]',
           recommended TEXT,
           asked_by TEXT NOT NULL,
           asked_by_mono TEXT,
           waiting TEXT NOT NULL DEFAULT '[]',
           state TEXT NOT NULL,
           answer TEXT,
           answered_by TEXT,
           answered_at INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           version INTEGER NOT NULL DEFAULT 1,
           PRIMARY KEY (project, decision_key)
         );
         CREATE INDEX IF NOT EXISTS decisions_open ON decisions(state, created_at);",
    )
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub project: String,
    pub decision_key: String,
    pub question: String,
    pub options: Vec<String>,
    pub recommended: Option<String>,
    /// The first mate's chat that asked.
    pub asked_by: String,
    pub asked_by_mono: Option<String>,
    /// The delegation ids waiting on the answer.
    pub waiting: Vec<String>,
    pub state: String,
    pub answer: Option<String>,
    pub answered_by: Option<String>,
    pub answered_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: i64,
}

const COLUMNS: &str =
    "project, decision_key, question, options, recommended, asked_by, asked_by_mono, waiting, \
     state, answer, answered_by, answered_at, created_at, updated_at, version";

fn json_list(text: String) -> Vec<String> {
    serde_json::from_str(&text).unwrap_or_default()
}

fn from_row(row: &Row) -> rusqlite::Result<Decision> {
    Ok(Decision {
        project: row.get(0)?,
        decision_key: row.get(1)?,
        question: row.get(2)?,
        options: json_list(row.get(3)?),
        recommended: row.get(4)?,
        asked_by: row.get(5)?,
        asked_by_mono: row.get(6)?,
        waiting: json_list(row.get(7)?),
        state: row.get(8)?,
        answer: row.get(9)?,
        answered_by: row.get(10)?,
        answered_at: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        version: row.get(14)?,
    })
}

/// The decision a key names: as stored, or else under its folded form (a spelling that differs only in case or width).
/// Rows written before the fold are found by their exact key, so they stay answerable as they were.
fn find(conn: &Connection, project: &str, key: &str) -> Result<Option<Decision>, String> {
    if let Some(found) = get(conn, project, key)? {
        return Ok(Some(found));
    }
    let folded = fold_key(key);
    if folded == key {
        return Ok(None);
    }
    get(conn, project, &folded)
}

pub fn get(conn: &Connection, project: &str, key: &str) -> Result<Option<Decision>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM decisions WHERE project = ?1 AND decision_key = ?2"),
        [project, key],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every open decision, oldest first (the Inbox), and the newest answered ones after them.
pub fn list(conn: &Connection, answered: usize) -> Result<Vec<Decision>, String> {
    let mut out = Vec::new();
    for (filter, limit) in [
        ("state = 'open' ORDER BY created_at, rowid LIMIT 200", 200),
        (
            "state = 'answered' ORDER BY answered_at DESC, rowid DESC LIMIT ?1",
            answered.min(100),
        ),
    ] {
        let sql = format!("SELECT {COLUMNS} FROM decisions WHERE {filter}");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = if filter.contains("?1") {
            stmt.query_map([limit as i64], from_row)
        } else {
            stmt.query_map([], from_row)
        }
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
        out.extend(rows);
    }
    Ok(out)
}

fn save(conn: &Connection, d: &Decision) -> Result<(), String> {
    conn.execute(
        &format!(
            "INSERT INTO decisions ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT (project, decision_key) DO UPDATE SET waiting = excluded.waiting, state = excluded.state,
               answer = excluded.answer, answered_by = excluded.answered_by, answered_at = excluded.answered_at,
               updated_at = excluded.updated_at, version = excluded.version"
        ),
        params![
            d.project,
            d.decision_key,
            d.question,
            json!(d.options).to_string(),
            d.recommended,
            d.asked_by,
            d.asked_by_mono,
            json!(d.waiting).to_string(),
            d.state,
            d.answer,
            d.answered_by,
            d.answered_at,
            d.created_at,
            d.updated_at,
            d.version,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// WP-172: a restart decision of a fan-out names its plan, its task and the request id that was stopped (up to 100,
/// 40 and 100 characters), then a 16-character owner tag, with the prefix and separators: 272 at most.
const FANOUT_AGAIN_KEY_MAX: usize = 300;

fn key_max(value: &str) -> usize {
    if is_again_key(value) {
        FANOUT_AGAIN_KEY_MAX
    } else {
        KEY_MAX
    }
}

fn key_like(value: &str) -> Result<String, String> {
    let value = value.trim();
    let max = key_max(value);
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':' | b'/'))
    {
        return Err(format!(
            "key must be a stable name for the question, like \"retention-policy\": letters, digits, - _ . : / and at \
             most {max} characters"
        ));
    }
    Ok(value.to_string())
}

fn plain(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} is empty"));
    }
    let length = value.chars().count();
    if length > max {
        return Err(format!(
            "{label} is {length} characters; it holds at most {max}. Shorten it rather than leave part out."
        ));
    }
    Ok(value.to_string())
}

/// A request id for the steering message that releases one waiter (stable, so a retried answer never sends twice).
fn release_request(key: &str, target: &str) -> String {
    let safe: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("decision-{safe}-{target}")
        .chars()
        .take(300)
        .collect()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskInput {
    /// The asking chat.
    pub asked_by: String,
    #[serde(default)]
    pub asked_by_mono: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    pub key: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub recommended: Option<String>,
    /// The asker's own tasks that wait on the answer.
    #[serde(default)]
    pub task_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOutcome {
    pub decision: Decision,
    /// False when the key was already asked: nothing about the question changed.
    pub created: bool,
    /// Tasks that joined this time.
    pub added: Vec<String>,
    /// For an answered key, the messages that released the tasks that joined now.
    pub released: Vec<SteerMessage>,
}

/// Turns back a chat that isn't at the top of its work: its question is its own first mate's to take.
pub fn check_may_ask(conn: &Connection, session: &str) -> Result<(), String> {
    if delegations::depth_above(conn, session)? > 0 {
        return Err(
            "You are working for a first mate, so your question goes to it, not to the person: say what you need in one \
             line with task_cannot (or in your report), with your recommendation. Your first mate answers it or asks \
             the person itself."
                .into(),
        );
    }
    Ok(())
}

/// What a waiting task is told when the person answers.
fn release_text(d: &Decision) -> String {
    format!(
        "The person answered \"{}\": {}\nCarry on from this answer; it outranks anything in your brief that disagrees.",
        d.question,
        d.answer.as_deref().unwrap_or("")
    )
}

fn owner_text(d: &Decision, released: usize) -> String {
    let tasks = match released {
        0 => String::new(),
        1 => " One waiting task has it and carries on.".into(),
        n => format!(" {n} waiting tasks have it and carry on."),
    };
    format!(
        "The person answered your question \"{}\" (key {}): {}.{tasks} This is the app's note, not a new message.",
        d.question,
        d.decision_key,
        d.answer.as_deref().unwrap_or("")
    )
}

fn release_one(
    conn: &Connection,
    d: &Decision,
    delegation_id: &str,
    now: i64,
) -> Result<Option<SteerMessage>, String> {
    let Some(row) = delegations::get(conn, delegation_id)? else {
        return Ok(None);
    };
    if !matches!(
        row.state.as_str(),
        delegations::RUNNING | delegations::QUESTION
    ) {
        return Ok(None);
    }
    steering::record(
        conn,
        SteerInput {
            owner_session: d.asked_by.clone(),
            child_session: row.child_session.clone(),
            delegation_id: Some(row.id.clone()),
            request_id: release_request(&d.decision_key, &row.id),
            text: release_text(d),
            mode: Some("auto".into()),
            source: Some("decision".into()),
            decision_key: Some(d.decision_key.clone()),
        },
        now,
    )
    .map(Some)
}

/// Move the waiting rows' open questions to `owner` (the person while the decision is open, the first mate after).
fn move_questions(conn: &mut Connection, ids: &[String], owner: &str, now: i64) -> Vec<String> {
    let mut moved = Vec::new();
    for id in ids {
        let Ok(Some(row)) = delegations::get(conn, id) else {
            continue;
        };
        if row.state != delegations::QUESTION {
            continue;
        }
        if let Ok(change) = delegations::set_question_owner(
            conn,
            id,
            row.generation,
            owner,
            Some("decisions".into()),
            now,
        ) {
            if change.applied {
                moved.push(id.clone());
            }
        }
    }
    moved
}

pub fn ask(conn: &mut Connection, input: AskInput, now: i64) -> Result<AskOutcome, String> {
    let asked_by = input.asked_by.trim().to_string();
    if asked_by.is_empty() {
        return Err("Invalid asking session".into());
    }
    check_may_ask(conn, &asked_by)?;
    let project = input.project.unwrap_or_default().trim().to_string();
    let key = key_like(&input.key)?;
    let question = plain(&input.question, "The question", QUESTION_MAX)?;
    let mut options = Vec::new();
    for option in &input.options {
        let option = plain(option, "An option", OPTION_MAX)?;
        if options.contains(&option) {
            return Err(format!("The option \"{option}\" is there twice"));
        }
        options.push(option);
    }
    if options.len() < OPTIONS_MIN || options.len() > OPTIONS_MAX {
        return Err(format!(
            "Give {OPTIONS_MIN} to {OPTIONS_MAX} options; a question with one answer isn't a decision."
        ));
    }
    let recommended = match input.recommended.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(pick) if options.iter().any(|o| o == pick) => Some(pick.to_string()),
        Some(pick) => {
            return Err(format!(
                "recommended \"{pick}\" isn't one of the options; name one of them exactly"
            ))
        }
    };
    // The asker's own open tasks only.
    let mut task_ids: Vec<String> = Vec::new();
    for id in &input.task_ids {
        let id = id.trim();
        let row = delegations::get(conn, id)?
            .filter(|row| row.owner_session == asked_by)
            .ok_or_else(|| format!("Task {id} isn't one of your tasks"))?;
        if !matches!(
            row.state.as_str(),
            delegations::RUNNING | delegations::QUESTION
        ) {
            return Err(format!(
                "Task {id} is no longer running; nothing waits on it"
            ));
        }
        if !task_ids.contains(&row.id) {
            task_ids.push(row.id);
        }
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let existing = get(&tx, &project, &key)?;
    let created = existing.is_none();
    let mut decision = existing.unwrap_or_else(|| Decision {
        project: project.clone(),
        decision_key: key.clone(),
        question,
        options,
        recommended,
        asked_by: asked_by.clone(),
        asked_by_mono: input.asked_by_mono.clone(),
        waiting: Vec::new(),
        state: OPEN.into(),
        answer: None,
        answered_by: None,
        answered_at: None,
        created_at: now,
        updated_at: now,
        version: 0,
    });
    let added: Vec<String> = task_ids
        .into_iter()
        .filter(|id| !decision.waiting.contains(id))
        .collect();
    if decision.waiting.len() + added.len() > WAITING_MAX {
        return Err(format!(
            "{WAITING_MAX} tasks already wait on this decision; that is the most one holds."
        ));
    }
    let mut released = Vec::new();
    if decision.state == ANSWERED {
        // Already answered: the tasks that join now get the answer straight away.
        for id in &added {
            if let Some(message) = release_one(&tx, &decision, id, now)? {
                released.push(message);
            }
        }
    }
    if created || !added.is_empty() {
        decision.waiting.extend(added.iter().cloned());
        decision.updated_at = now;
        decision.version += 1;
        save(&tx, &decision)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    if decision.state == OPEN {
        move_questions(conn, &added, QUESTION_FOR_PERSON, now);
    }
    Ok(AskOutcome {
        decision,
        created,
        added,
        released,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerOutcome {
    /// False when it was already answered (or there is no such decision): nothing changed.
    pub applied: bool,
    pub decision: Option<Decision>,
    /// The steering messages that carry the answer: one per waiting task still open, then one to the asker (unless the
    /// answer came from the asker's own chat).
    pub released: Vec<SteerMessage>,
    /// The waiting delegations the answer went to.
    pub released_tasks: Vec<String>,
}

/// What the app says it is when it closes a fresh-eyes question itself (a brief taken back, replaced, or accepted as a
/// clean review). It tells no one: the chat that asked did the thing, or the person allowed it.
pub const APP_CLOSER: &str = "app:fresh-eyes";

/// Invisible characters: Unicode general category Cf (format) and the other default-ignorable code points. A spelling
/// that differs only by them looks the same on screen, so the fold drops them. Mirrored in TS by the `\p{Cf}` and
/// `\p{Default_Ignorable_Code_Point}` classes in `foldDecisionKey`.
fn is_ignorable(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD
            | 0x034F
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x08E2
            | 0x115F..=0x1160
            | 0x17B4..=0x17B5
            | 0x180B..=0x180F
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x206F
            | 0x3164
            | 0xFE00..=0xFE0F
            | 0xFEFF
            | 0xFFA0
            | 0xFFF0..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0000..=0xE0FFF
    )
}

/// The one form every decision-key prefix check reads: NFKC (so fullwidth and other compatibility spellings become
/// their plain form), invisible characters dropped, trimmed (any Unicode white space, as `str::trim` takes it),
/// lower-case. A chat can ask or answer under any spelling, so a check on the raw key is a check on the wrong string.
/// Mirrored in TS by `foldDecisionKey` (src/features/hub/model/decisionKey.ts).
pub fn fold_key(key: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let folded: String = key.nfkc().filter(|c| !is_ignorable(*c)).collect();
    folded.trim().to_lowercase()
}

/// WP-144: the questions a fresh-eyes review puts to the person (the review itself, and a brief that could not start).
fn is_review_key(key: &str) -> bool {
    let key = fold_key(key);
    key.starts_with("fresh-eyes/") || key.starts_with("fresh-eyes-start/")
}

/// WP-91: the decision keys only the person may answer, whatever path asked.
///
/// An irreversible step of an orchestration run is parked under `irreversible/<lead>/<task>`. A person answers it in
/// the app (`by` absent or `"user"`); a chat answering on a first mate's behalf (`chat:<session>`) and autopilot both
/// count as a machine, and are refused here rather than trusted to hold it.
///
/// WP-144: so is a fresh-eyes review (`fresh-eyes/...`) and the question that its approved brief could not start
/// (`fresh-eyes-start/...`). A chat answering `ask_person` on its own review's key would take the question out of the
/// person's Inbox, and the review ignores its answer anyway. The app itself may close them (`app:fresh-eyes`).
///
/// WP-172: so is the decision that starts a stopped fan-out task again (`fanout-again/<plan>/<task>/<stopped request id>`).
/// A stopped worker runs again only on Ash's yes, so an agent's `ask_person` answer (a chat, whatever the words) is refused
/// here, and the app's own closers are not a way round it.
pub fn person_only(key: &str, by: Option<&str>) -> Option<String> {
    let review = is_review_key(key);
    let again = is_again_key(key);
    if !fold_key(key).starts_with("irreversible/") && !review && !again {
        return None;
    }
    match by.map(str::trim).filter(|word| !word.is_empty()) {
        None | Some("user") | Some("person") => None,
        Some(APP_CLOSER) if review => None,
        Some(other) if review => Some(format!(
            "Only the person answers a fresh-eyes review; {other} cannot. It waits in the Inbox until they do."
        )),
        Some(other) if again => Some(format!(
            "Only the person answers whether a stopped task starts again; {other} cannot. It waits in Needs until they do."
        )),
        Some(other) => Some(format!(
            "Only the person answers an irreversible step; {other} cannot. It waits in Needs until they do."
        )),
    }
}

/// WP-172: the decision keys that start a stopped fan-out task again.
pub fn is_again_key(key: &str) -> bool {
    fold_key(key).starts_with("fanout-again/")
}

pub fn answer(
    conn: &mut Connection,
    project: &str,
    key: &str,
    answer: &str,
    by: Option<String>,
    now: i64,
) -> Result<AnswerOutcome, String> {
    let answer = plain(answer, "The answer", ANSWER_MAX)?;
    // The key as asked, before any lookup: a chat's spelling of a person-only key is refused even when no such
    // decision exists, so nothing about the lookup can turn a refusal into a quiet no-op or a bypass.
    if let Some(refusal) = person_only(key, by.as_deref()) {
        return Err(refusal);
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut decision) = find(&tx, project.trim(), key.trim())? else {
        return Ok(AnswerOutcome {
            applied: false,
            decision: None,
            released: Vec::new(),
            released_tasks: Vec::new(),
        });
    };
    if decision.state != OPEN {
        return Ok(AnswerOutcome {
            applied: false,
            decision: Some(decision),
            released: Vec::new(),
            released_tasks: Vec::new(),
        });
    }
    // WP-91: an irreversible step is the person's to answer, and nobody else's. The webview puts it on its red list
    // so autopilot holds it, but that is a screen away; this refuses it at the store, whatever path asked. It reads the
    // stored key, so a decision stored in any case is checked as the person-only key it is.
    if let Some(refusal) = person_only(&decision.decision_key, by.as_deref()) {
        return Err(refusal);
    }
    decision.state = ANSWERED.into();
    decision.answer = Some(answer);
    decision.answered_by = Some(
        by.map(|b| b.trim().chars().take(120).collect::<String>())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "person".into()),
    );
    decision.answered_at = Some(now);
    decision.updated_at = now;
    decision.version += 1;
    save(&tx, &decision)?;
    let mut released = Vec::new();
    let mut released_tasks = Vec::new();
    for id in decision.waiting.clone() {
        if let Some(message) = release_one(&tx, &decision, &id, now)? {
            released_tasks.push(id);
            released.push(message);
        }
    }
    // The asker hears the answer, unless the person gave it in the asker's own chat: it recorded it itself.
    let from_asker =
        decision.answered_by.as_deref() == Some(format!("chat:{}", decision.asked_by).as_str());
    // The app closing a review's question (a brief taken back, replaced, or accepted as clean) has nothing to tell.
    let from_app = decision.answered_by.as_deref() == Some(APP_CLOSER);
    if !from_asker && !from_app {
        released.push(steering::record(
            &tx,
            SteerInput {
                owner_session: decision.asked_by.clone(),
                child_session: decision.asked_by.clone(),
                delegation_id: None,
                request_id: release_request(&decision.decision_key, "asker"),
                text: owner_text(&decision, released_tasks.len()),
                mode: Some("queue".into()),
                source: Some("decision".into()),
                decision_key: Some(decision.decision_key.clone()),
            },
            now,
        )?);
    }
    // WP-157: one summary of the question and the answer. A second answer never reaches here. The line is written in
    // a savepoint: a journal that cannot be written is logged and skipped, and the answer still lands.
    crate::work_log::best_effort(&tx, "decision", |conn| {
        crate::work_log::record_decision(
            conn,
            &decision.project,
            &decision.decision_key,
            &decision.question,
            decision.answer.as_deref().unwrap_or(""),
            decision.answered_at.unwrap_or(now),
        )
    });
    tx.commit().map_err(|e| e.to_string())?;
    move_questions(conn, &released_tasks, QUESTION_FOR_FIRST_MATE, now);
    Ok(AnswerOutcome {
        applied: true,
        decision: Some(decision),
        released,
        released_tasks,
    })
}

fn announce(app: &AppHandle, decision: Option<&Decision>, released: &[SteerMessage]) {
    if let Some(d) = decision {
        let _ = app.emit(CHANGED, json!({ "keys": [d.decision_key] }));
    }
    steering::changed(app, &released.iter().collect::<Vec<_>>());
    let _ = app.emit(delegations::CHANGED, json!({ "ids": [] }));
    crate::tasks::emit_for_delegations(app); // WP-70
}

#[tauri::command(async)]
pub fn decisions_ask(
    app: AppHandle,
    store: State<'_, SessionStore>,
    input: AskInput,
) -> Result<AskOutcome, String> {
    let outcome = ask(&mut *store.lock_conn()?, input, now_millis())?;
    if outcome.created || !outcome.added.is_empty() {
        announce(&app, Some(&outcome.decision), &outcome.released);
    }
    Ok(outcome)
}

#[tauri::command(async)]
pub fn decisions_answer(
    app: AppHandle,
    store: State<'_, SessionStore>,
    project: Option<String>,
    key: String,
    answer: String,
    by: Option<String>,
) -> Result<AnswerOutcome, String> {
    let outcome = self::answer(
        &mut *store.lock_conn()?,
        project.as_deref().unwrap_or(""),
        &key,
        &answer,
        by,
        now_millis(),
    )?;
    // WP-81: an answer on a check's question goes back to the check. Nothing is answered for the person. It goes back
    // under the stored key, the one the check's run was parked under, whatever case the answer was typed in.
    if let Some(stored) = outcome.decision.as_ref().map(|d| d.decision_key.clone()) {
        if fold_key(&stored).starts_with("gate/") {
            let _ = crate::delivery_gate::forward_answer(&store, &stored, &answer);
        }
    }
    if outcome.applied {
        announce(&app, outcome.decision.as_ref(), &outcome.released);
    }
    Ok(outcome)
}

#[tauri::command(async)]
pub fn decisions_list(
    store: State<'_, SessionStore>,
    answered: Option<usize>,
) -> Result<Vec<Decision>, String> {
    list(&*store.lock_conn()?, answered.unwrap_or(20))
}

#[cfg(test)]
mod tests;
