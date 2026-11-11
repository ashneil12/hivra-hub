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
//!
//! WP-156 adds standing answers on the same table: `standing`, `keys`, `retired_at`, `retired_reason`. An answered
//! row is standing unless Ash turns that off or retires it. The feature itself stays off (`decision_settings`) until
//! it is turned on, and while it is off, asking and answering keep the exact-key behaviour above.

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
         CREATE INDEX IF NOT EXISTS decisions_open ON decisions(state, created_at);
         CREATE TABLE IF NOT EXISTS decision_settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS decision_citations (
           project TEXT NOT NULL,
           decision_key TEXT NOT NULL,
           task_id TEXT NOT NULL,
           cited_at INTEGER NOT NULL,
           PRIMARY KEY (project, decision_key, task_id)
         );",
    )?;
    // Columns added after the first rows. An old store gets the defaults here; a new one takes the same path.
    ensure_decision_columns(conn)
}

fn ensure_decision_columns(conn: &Connection) -> rusqlite::Result<()> {
    for (name, decl) in [
        ("standing", "INTEGER NOT NULL DEFAULT 1"),
        ("keys", "TEXT NOT NULL DEFAULT '[]'"),
        ("retired_at", "INTEGER"),
        ("retired_reason", "TEXT"),
    ] {
        let exists = conn
            .prepare("SELECT 1 FROM pragma_table_info('decisions') WHERE name = ?1")?
            .exists([name])?;
        if !exists {
            conn.execute(
                &format!("ALTER TABLE decisions ADD COLUMN {name} {decl}"),
                [],
            )?;
        }
    }
    Ok(())
}

/// The settings key for WP-156. Only the exact value `on` enables standing answers. Anything else, including a missing
/// row, leaves them off.
const STANDING_SETTING: &str = "standing_answers";

pub fn standing_enabled(conn: &Connection) -> Result<bool, String> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM decision_settings WHERE key = ?1",
            [STANDING_SETTING],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(value.as_deref().map(str::trim) == Some("on"))
}

pub fn set_standing_enabled(conn: &Connection, enabled: bool) -> Result<(), String> {
    conn.execute(
        "INSERT INTO decision_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![STANDING_SETTING, if enabled { "on" } else { "off" }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
    /// Answered rows are standing unless this is turned off. Open rows carry it for when they are answered.
    pub standing: bool,
    /// Short match words. Empty until a later step fills them. Untrusted text is read back as a list or nothing.
    pub keys: Vec<String>,
    pub retired_at: Option<i64>,
    pub retired_reason: Option<String>,
    /// Stable label, `S-<rowid>`. Guidance, not a permission.
    pub standing_id: String,
}

const COLUMNS: &str =
    "project, decision_key, question, options, recommended, asked_by, asked_by_mono, waiting, \
     state, answer, answered_by, answered_at, created_at, updated_at, version, \
     standing, keys, retired_at, retired_reason";
/// `rowid` is not written; it only names the standing answer.
const READ_COLUMNS: &str =
    "project, decision_key, question, options, recommended, asked_by, asked_by_mono, waiting, \
     state, answer, answered_by, answered_at, created_at, updated_at, version, \
     standing, keys, retired_at, retired_reason, rowid";

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
        standing: row.get::<_, i64>(15)? != 0,
        keys: json_list(row.get(16)?),
        retired_at: row.get(17)?,
        retired_reason: row.get(18)?,
        standing_id: format!("S-{}", row.get::<_, i64>(19)?),
    })
}

pub fn get(conn: &Connection, project: &str, key: &str) -> Result<Option<Decision>, String> {
    conn.query_row(
        &format!("SELECT {READ_COLUMNS} FROM decisions WHERE project = ?1 AND decision_key = ?2"),
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
        let sql = format!("SELECT {READ_COLUMNS} FROM decisions WHERE {filter}");
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
            "INSERT INTO decisions ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
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
            if d.standing { 1 } else { 0 },
            json!(d.keys).to_string(),
            d.retired_at,
            d.retired_reason,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn key_like(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > KEY_MAX
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':' | b'/'))
    {
        return Err(format!(
            "key must be a stable name for the question, like \"retention-policy\": letters, digits, - _ . : / and at \
             most {KEY_MAX} characters"
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
    /// Short match words. Invalid ones are dropped. Empty: words are taken from the question.
    #[serde(default)]
    pub keys: Vec<String>,
    /// Ask again even when a standing answer matches. Needs `reason` when one does.
    #[serde(default)]
    pub force: bool,
    /// Why the standing answer does not apply. Required with `force` when one matches.
    #[serde(default)]
    pub reason: Option<String>,
}

fn skip_false(value: &bool) -> bool {
    !*value
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
    /// True when a standing answer was reused instead of opening a new decision.
    #[serde(default, skip_serializing_if = "skip_false")]
    pub matched: bool,
    /// The standing answer's id, only when `matched`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standing_id: Option<String>,
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

const KEY_WORD_MAX: usize = 40;
const KEY_WORDS_MAX: usize = 12;
const MATCH_SHARED: usize = 2;

fn is_stop(word: &str) -> bool {
    matches!(
        word,
        "the"
            | "and"
            | "for"
            | "are"
            | "but"
            | "not"
            | "you"
            | "your"
            | "our"
            | "this"
            | "that"
            | "with"
            | "from"
            | "into"
            | "about"
            | "than"
            | "then"
            | "what"
            | "when"
            | "where"
            | "which"
            | "who"
            | "how"
            | "why"
            | "does"
            | "did"
            | "has"
            | "have"
            | "had"
            | "was"
            | "were"
            | "been"
            | "being"
            | "should"
            | "would"
            | "could"
            | "please"
            | "just"
            | "also"
            | "they"
            | "them"
            | "their"
            | "its"
            | "can"
            | "will"
            | "shall"
            | "may"
    )
}

fn stem(word: &str) -> String {
    let cut = if word.len() > 5 && word.ends_with("ing") {
        &word[..word.len() - 3]
    } else if word.len() > 4 && word.ends_with("ed") {
        &word[..word.len() - 2]
    } else if word.len() > 4 && word.ends_with('s') && !word.ends_with("ss") {
        &word[..word.len() - 1]
    } else {
        word
    };
    if cut.len() > 4 && cut.ends_with('e') {
        cut[..cut.len() - 1].to_string()
    } else {
        cut.to_string()
    }
}

/// Alphanumeric words, lower case, short words and stop words dropped, lightly stemmed. Order is kept.
fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let push = |out: &mut Vec<String>, raw: &str| {
        if raw.len() < 3 || is_stop(raw) {
            return;
        }
        let stemmed = stem(raw);
        if stemmed.len() < 3 || out.iter().any(|have| have == &stemmed) {
            return;
        }
        out.push(stemmed);
    };
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            current.push(c.to_ascii_lowercase());
        } else if !current.is_empty() {
            push(&mut out, &current);
            current.clear();
        }
    }
    if !current.is_empty() {
        push(&mut out, &current);
    }
    out
}

fn accept_keys(raw: &[String], question: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in raw {
        let word = word.trim().to_lowercase();
        let length = word.chars().count();
        if !(2..=KEY_WORD_MAX).contains(&length)
            || !word.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || out.contains(&word)
        {
            continue;
        }
        out.push(word);
        if out.len() >= KEY_WORDS_MAX {
            return out;
        }
    }
    if !out.is_empty() {
        return out;
    }
    for word in words(question) {
        if out.len() >= KEY_WORDS_MAX {
            break;
        }
        out.push(word);
    }
    out
}

fn query_words(question: &str, keys: &[String]) -> Vec<String> {
    let mut out = words(question);
    for key in keys {
        for word in words(key) {
            if !out.contains(&word) {
                out.push(word);
            }
        }
    }
    out
}

/// `shared / shorter >= 0.6`, compared as integers so a tie stays exact.
fn scores_match(shared: usize, left: usize, right: usize) -> bool {
    let shorter = left.min(right);
    shorter > 0 && shared >= MATCH_SHARED && shared * 5 >= shorter * 3
}

fn better_score(shared: usize, shorter: usize, best_shared: usize, best_shorter: usize) -> bool {
    shared * best_shorter > best_shared * shorter
}

fn best_match(
    conn: &Connection,
    project: &str,
    question: &str,
    keys: &[String],
) -> Result<Option<Decision>, String> {
    let query = query_words(question, keys);
    if query.len() < MATCH_SHARED {
        return Ok(None);
    }
    let sql = format!(
        "SELECT {READ_COLUMNS} FROM decisions
         WHERE project = ?1 AND state = ?2 AND standing != 0 AND retired_at IS NULL AND answer IS NOT NULL
         ORDER BY answered_at DESC, rowid DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project, ANSWERED], from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut best: Option<(Decision, usize, usize)> = None;
    for row in rows {
        let theirs = query_words(&row.question, &row.keys);
        let shared = query.iter().filter(|word| theirs.contains(word)).count();
        let shorter = query.len().min(theirs.len());
        if !scores_match(shared, query.len(), theirs.len()) {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((_, best_shared, best_shorter)) => {
                better_score(shared, shorter, *best_shared, *best_shorter)
            }
        };
        if replace {
            best = Some((row, shared, shorter));
        }
    }
    Ok(best.map(|(row, _, _)| row))
}

fn cite(
    conn: &Connection,
    project: &str,
    key: &str,
    task_id: &str,
    now: i64,
) -> Result<(), String> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO decision_citations (project, decision_key, task_id, cited_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (project, decision_key, task_id) DO NOTHING",
        params![project, key, task_id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn citations_for(
    conn: &Connection,
    project: &str,
    key: &str,
) -> Result<Vec<StandingCitation>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT task_id, cited_at FROM decision_citations
             WHERE project = ?1 AND decision_key = ?2 ORDER BY cited_at, task_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project, key], |row| {
            Ok(StandingCitation {
                task_id: row.get(0)?,
                cited_at: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
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
    // The same key stays one decision, even when standing answers are on and even with force.
    // A different key can reuse an active answer while the setting is on.
    if existing.is_none() && standing_enabled(&tx)? {
        if let Some(hit) = best_match(&tx, &project, &question, &input.keys)? {
            if !input.force {
                let mut released = Vec::new();
                let mut cited = task_ids.clone();
                if cited.is_empty() {
                    cited.push(asked_by.clone());
                }
                for id in &task_ids {
                    if let Some(message) = release_one(&tx, &hit, id, now)? {
                        released.push(message);
                    }
                }
                for id in &cited {
                    cite(&tx, &hit.project, &hit.decision_key, id, now)?;
                }
                let standing_id = hit.standing_id.clone();
                tx.commit().map_err(|e| e.to_string())?;
                return Ok(AskOutcome {
                    decision: hit,
                    created: false,
                    added: Vec::new(),
                    released,
                    matched: true,
                    standing_id: Some(standing_id),
                });
            }
            // A match that should not apply still needs a one-line reason, or nothing is opened.
            plain(input.reason.as_deref().unwrap_or(""), "The reason", 300)?;
        }
    }
    let created = existing.is_none();
    let store_keys = created && standing_enabled(&tx)?;
    // Taken before `question` moves into the new row. A repeat of the same key keeps the stored words.
    let stored_keys = if store_keys {
        accept_keys(&input.keys, &question)
    } else {
        Vec::new()
    };
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
        standing: true,
        keys: stored_keys,
        retired_at: None,
        retired_reason: None,
        standing_id: String::new(),
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
        // Re-read so the standing id is the stored row, not a guess, and a lost race is visible.
        decision =
            get(&tx, &project, &key)?.ok_or_else(|| "The decision was not stored".to_string())?;
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
        matched: false,
        standing_id: None,
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

/// WP-144: the questions a fresh-eyes review puts to the person (the review itself, and a brief that could not start).
fn is_review_key(key: &str) -> bool {
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
pub fn person_only(key: &str, by: Option<&str>) -> Option<String> {
    let review = is_review_key(key);
    if !key.starts_with("irreversible/") && !review {
        return None;
    }
    match by.map(str::trim).filter(|word| !word.is_empty()) {
        None | Some("user") | Some("person") => None,
        Some(APP_CLOSER) if review => None,
        Some(other) if review => Some(format!(
            "Only the person answers a fresh-eyes review; {other} cannot. It waits in the Inbox until they do."
        )),
        Some(other) => Some(format!(
            "Only the person answers an irreversible step; {other} cannot. It waits in Needs until they do."
        )),
    }
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
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut decision) = get(&tx, project.trim(), key.trim())? else {
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
    // so autopilot holds it, but that is a screen away; this refuses it at the store, whatever path asked.
    if let Some(refusal) = person_only(decision.decision_key.trim(), by.as_deref()) {
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StandingCitation {
    pub task_id: String,
    pub cited_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetireOutcome {
    /// False when there is no such decision, or it was already retired.
    pub applied: bool,
    pub decision: Option<Decision>,
    /// Tasks that relied on it. Empty until a citation is recorded.
    pub relied: Vec<StandingCitation>,
}

/// Retire one standing answer. The row stays, with the reason. A second retire changes nothing.
/// Two windows: the write lands only if the version still matches and it is not already retired.
pub fn retire(
    conn: &mut Connection,
    project: &str,
    key: &str,
    reason: &str,
    now: i64,
) -> Result<RetireOutcome, String> {
    let reason = plain(reason, "The reason", 300)?;
    let project = project.trim();
    let key = key.trim();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut decision) = get(&tx, project, key)? else {
        return Ok(RetireOutcome {
            applied: false,
            decision: None,
            relied: Vec::new(),
        });
    };
    if decision.retired_at.is_some() {
        let relied = citations_for(&tx, project, key)?;
        return Ok(RetireOutcome {
            applied: false,
            decision: Some(decision),
            relied,
        });
    }
    let version = decision.version;
    decision.retired_at = Some(now);
    decision.retired_reason = Some(reason);
    decision.updated_at = now;
    decision.version += 1;
    let changed = tx
        .execute(
            "UPDATE decisions SET retired_at = ?1, retired_reason = ?2, updated_at = ?3, version = ?4
             WHERE project = ?5 AND decision_key = ?6 AND version = ?7 AND retired_at IS NULL",
            params![
                decision.retired_at,
                decision.retired_reason,
                decision.updated_at,
                decision.version,
                decision.project,
                decision.decision_key,
                version,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        let current = get(&tx, project, key)?;
        let relied = if current.is_some() {
            citations_for(&tx, project, key)?
        } else {
            Vec::new()
        };
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(RetireOutcome {
            applied: false,
            decision: current,
            relied,
        });
    }
    let relied = citations_for(&tx, project, key)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(RetireOutcome {
        applied: true,
        decision: Some(decision),
        relied,
    })
}

/// Turn reuse on or off for one answer. Missing key: nothing to change.
pub fn set_standing(
    conn: &mut Connection,
    project: &str,
    key: &str,
    standing: bool,
    now: i64,
) -> Result<Option<Decision>, String> {
    let project = project.trim();
    let key = key.trim();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(mut decision) = get(&tx, project, key)? else {
        return Ok(None);
    };
    if decision.standing == standing {
        return Ok(Some(decision));
    }
    let version = decision.version;
    decision.standing = standing;
    decision.updated_at = now;
    decision.version += 1;
    let changed = tx
        .execute(
            "UPDATE decisions SET standing = ?1, updated_at = ?2, version = ?3
             WHERE project = ?4 AND decision_key = ?5 AND version = ?6",
            params![
                if standing { 1 } else { 0 },
                decision.updated_at,
                decision.version,
                decision.project,
                decision.decision_key,
                version,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        let current = get(&tx, project, key)?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(current);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(decision))
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StandingRow {
    pub project: String,
    pub decision_key: String,
    pub question: String,
    pub answer: String,
    pub standing_id: String,
    pub uses: i64,
}

/// Active standing answers for one project, newest first, with how many tasks relied on each.
/// Empty when standing answers are off, the project is blank, or nothing active is stored.
pub fn standing_rows(conn: &Connection, project: &str) -> Result<Vec<StandingRow>, String> {
    let project = project.trim();
    if project.is_empty() || !standing_enabled(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT decision_key, question, answer, rowid,
                    (SELECT COUNT(*) FROM decision_citations c
                     WHERE c.project = decisions.project AND c.decision_key = decisions.decision_key)
             FROM decisions
             WHERE project = ?1 AND state = ?2 AND standing != 0 AND retired_at IS NULL
               AND answer IS NOT NULL
             ORDER BY answered_at DESC, rowid DESC
             LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project, ANSWERED], |row| {
            Ok(StandingRow {
                project: project.to_string(),
                decision_key: row.get(0)?,
                question: row.get(1)?,
                answer: row.get(2)?,
                standing_id: format!("S-{}", row.get::<_, i64>(3)?),
                uses: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Newest active answers for one project, for a first mate's brief. Empty when standing answers are off, the project
/// is blank, or nothing active is stored. Guidance, not permission.
const STANDING_ROWS: usize = 20;
const STANDING_CHARS: usize = 4_000;
const STANDING_HEADER: &str = "\
Standing answers
These are guidance, not permission. They do not approve a tool call, a merge, or a new action.";

fn one_line(value: &str) -> String {
    let flat = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        "(empty)".to_string()
    } else {
        flat
    }
}

pub fn standing_block(conn: &Connection, project: &str) -> Result<String, String> {
    let project = project.trim();
    if project.is_empty() || !standing_enabled(conn)? {
        return Ok(String::new());
    }
    let sql = format!(
        "SELECT {READ_COLUMNS} FROM decisions
         WHERE project = ?1 AND state = ?2 AND standing != 0 AND retired_at IS NULL AND answer IS NOT NULL
         ORDER BY answered_at DESC, rowid DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project, ANSWERED], from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut body = Vec::new();
    let mut size = STANDING_HEADER.chars().count();
    for row in rows {
        if body.len() >= STANDING_ROWS {
            break;
        }
        let line = format!(
            "{}: {} -> {}",
            row.standing_id,
            one_line(&row.question),
            one_line(row.answer.as_deref().unwrap_or(""))
        );
        let extra = 1 + line.chars().count();
        if size + extra > STANDING_CHARS {
            if body.is_empty() {
                let room = STANDING_CHARS.saturating_sub(size + 1);
                let cut: String = line.chars().take(room).collect();
                if !cut.is_empty() {
                    body.push(cut);
                }
            }
            break;
        }
        size += extra;
        body.push(line);
    }
    if body.is_empty() {
        return Ok(String::new());
    }
    Ok(format!("{STANDING_HEADER}\n{}", body.join("\n")))
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
    // WP-81: an answer on a check's question goes back to the check. Nothing is answered for the person.
    if key.starts_with("gate/") {
        let _ = crate::delivery_gate::forward_answer(&store, &key, &answer);
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

#[tauri::command(async)]
pub fn decisions_standing_enabled(store: State<'_, SessionStore>) -> Result<bool, String> {
    standing_enabled(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn decisions_standing_brief(
    store: State<'_, SessionStore>,
    project: String,
) -> Result<String, String> {
    standing_block(&*store.lock_conn()?, &project)
}

#[tauri::command(async)]
pub fn decisions_set_standing_enabled(
    app: AppHandle,
    store: State<'_, SessionStore>,
    enabled: bool,
) -> Result<bool, String> {
    let conn = store.lock_conn()?;
    set_standing_enabled(&conn, enabled)?;
    let on = standing_enabled(&conn)?;
    drop(conn);
    let _ = app.emit(CHANGED, json!({ "keys": [] }));
    Ok(on)
}

#[tauri::command(async)]
pub fn decisions_standing_list(
    store: State<'_, SessionStore>,
    project: Option<String>,
) -> Result<Vec<StandingRow>, String> {
    standing_rows(&*store.lock_conn()?, project.as_deref().unwrap_or(""))
}

#[tauri::command(async)]
pub fn decisions_retire(
    app: AppHandle,
    store: State<'_, SessionStore>,
    project: Option<String>,
    key: String,
    reason: String,
) -> Result<RetireOutcome, String> {
    let outcome = retire(
        &mut *store.lock_conn()?,
        project.as_deref().unwrap_or(""),
        &key,
        &reason,
        now_millis(),
    )?;
    if outcome.applied {
        announce(&app, outcome.decision.as_ref(), &[]);
    }
    Ok(outcome)
}

#[tauri::command(async)]
pub fn decisions_set_standing(
    app: AppHandle,
    store: State<'_, SessionStore>,
    project: Option<String>,
    key: String,
    standing: bool,
) -> Result<Option<Decision>, String> {
    let outcome = set_standing(
        &mut *store.lock_conn()?,
        project.as_deref().unwrap_or(""),
        &key,
        standing,
        now_millis(),
    )?;
    if let Some(decision) = outcome.as_ref() {
        announce(&app, Some(decision), &[]);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests;
