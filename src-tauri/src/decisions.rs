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
//! WP-156 adds standing answers on the same table: `standing`, `keys`, `retired_at`, `retired_reason`, `reuse_stopped`,
//! `force_reason`. An answer stands only after Ash ticks it in the Inbox. A chat's own answer never stands. The feature
//! itself stays off (`decision_settings`) until it is turned on, and while it is off, asking and answering keep the
//! exact-key behaviour above.

use std::sync::OnceLock;

use regex::Regex;
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

fn column_missing(conn: &Connection, table: &str, name: &str) -> rusqlite::Result<bool> {
    Ok(!conn
        .prepare(&format!(
            "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
        ))?
        .exists([name])?)
}

fn ensure_decision_columns(conn: &Connection) -> rusqlite::Result<()> {
    for (name, decl) in [
        ("standing", "INTEGER NOT NULL DEFAULT 0"),
        ("keys", "TEXT NOT NULL DEFAULT '[]'"),
        ("retired_at", "INTEGER"),
        ("retired_reason", "TEXT"),
        ("reuse_stopped", "INTEGER NOT NULL DEFAULT 0"),
        ("force_reason", "TEXT"),
    ] {
        if column_missing(conn, "decisions", name)? {
            conn.execute(
                &format!("ALTER TABLE decisions ADD COLUMN {name} {decl}"),
                [],
            )?;
        }
    }
    for (name, decl) in [
        ("asked_by", "TEXT NOT NULL DEFAULT ''"),
        ("question", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if column_missing(conn, "decision_citations", name)? {
            conn.execute(
                &format!("ALTER TABLE decision_citations ADD COLUMN {name} {decl}"),
                [],
            )?;
        }
    }
    // Once, on a store that already had answers: none of them were ticked, so none of them stand.
    let marked: bool = conn
        .prepare("SELECT 1 FROM decision_settings WHERE key = 'standing_defaults_off'")?
        .exists([])?;
    if !marked {
        conn.execute("UPDATE decisions SET standing = 0", [])?;
        conn.execute(
            "INSERT INTO decision_settings (key, value) VALUES ('standing_defaults_off', 'done')",
            [],
        )?;
    }
    Ok(())
}

/// WP-156: keys that never take part in standing answers, neither as a match nor as guidance. The person alone answers
/// an irreversible step, a fresh-eyes review and a stopped fan-out's restart; a delivery gate's approval belongs to the
/// gate, not to an old answer; a secret is never reused. A key that is not listed here is an ordinary question.
pub fn standing_eligible(key: &str) -> bool {
    // Keys keep the case they were typed in (`key_like`), so a protected prefix is matched in any case.
    let key = key.trim().to_ascii_lowercase();
    ![
        "irreversible/",
        "fresh-eyes",
        "gate/",
        "secret/",
        "fanout-again/",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
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
    /// True only after the person ticks reuse on this answer. Answering does not set it.
    pub standing: bool,
    /// Short match words. Empty until a later step fills them. Untrusted text is read back as a list or nothing.
    pub keys: Vec<String>,
    pub retired_at: Option<i64>,
    pub retired_reason: Option<String>,
    /// The person turned reuse off after it had been on. The same key is asked again instead of releasing the old answer.
    pub reuse_stopped: bool,
    /// Why a later question was opened anyway, when a standing answer matched and force was set.
    pub force_reason: Option<String>,
    /// Stable label, `S-<rowid>`. Guidance, not a permission.
    pub standing_id: String,
}

const COLUMNS: &str =
    "project, decision_key, question, options, recommended, asked_by, asked_by_mono, waiting, \
     state, answer, answered_by, answered_at, created_at, updated_at, version, \
     standing, keys, retired_at, retired_reason, reuse_stopped, force_reason";
/// `rowid` is not written; it only names the standing answer.
const READ_COLUMNS: &str =
    "project, decision_key, question, options, recommended, asked_by, asked_by_mono, waiting, \
     state, answer, answered_by, answered_at, created_at, updated_at, version, \
     standing, keys, retired_at, retired_reason, reuse_stopped, force_reason, rowid";

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
        reuse_stopped: row.get::<_, i64>(19)? != 0,
        force_reason: row.get(20)?,
        standing_id: format!("S-{}", row.get::<_, i64>(21)?),
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
            "INSERT INTO decisions ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
             ON CONFLICT (project, decision_key) DO UPDATE SET waiting = excluded.waiting, state = excluded.state,
               answer = excluded.answer, answered_by = excluded.answered_by, answered_at = excluded.answered_at,
               standing = excluded.standing, updated_at = excluded.updated_at, version = excluded.version"
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
            if d.reuse_stopped { 1 } else { 0 },
            d.force_reason,
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
fn release_request(key: &str, target: &str, version: i64) -> String {
    let safe: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // The version is part of the id so a reopened question can be answered again. The same id cannot be sent twice.
    format!("decision-{safe}-v{version}-{target}")
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

/// What a waiting task is told when the person answers the same question.
fn release_text(d: &Decision) -> String {
    format!(
        "The person answered \"{}\": {}\nCarry on from this answer; it outranks anything in your brief that disagrees.",
        d.question,
        d.answer.as_deref().unwrap_or("")
    )
}

/// What a waiting task is told when a different question reused a standing answer. Guidance, not permission.
fn match_release_text(d: &Decision) -> String {
    format!(
        "A standing answer {} to a similar question: guidance, not permission. Similar question: \"{}\". Answer: {}.",
        d.standing_id,
        one_line(&d.question),
        one_line(d.answer.as_deref().unwrap_or(""))
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
    text: &str,
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
            // The task's own owner, not whoever first asked the stored question.
            owner_session: row.owner_session.clone(),
            child_session: row.child_session.clone(),
            delegation_id: Some(row.id.clone()),
            request_id: release_request(&d.decision_key, &row.id, d.version),
            text: text.to_string(),
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

/// Jaccard over the union, at least two shared words, and at least two fifths of the union. The asker's own keys are not
/// part of its question: only the words in the question itself are.
fn scores_match(shared: usize, union: usize) -> bool {
    union > 0 && shared >= MATCH_SHARED && shared * 5 >= union * 2
}

fn better_score(shared: usize, union: usize, best_shared: usize, best_union: usize) -> bool {
    shared * best_union > best_shared * union
}

fn red_lines() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        // The same list as looksRedLine in chatQuestions.ts. A false alarm only means this question is asked, not reused.
        const RAW: &[&str] = &[
            r"(?i)\b(?:money|payments?|payouts?|billing|invoices?|refunds?|charg(?:e|es|ed|ing)\s+(?:the\s+|their\s+|his\s+)?(?:card|customer|user)s?|stripe|wallets?|transfer\w*\s+(?:the\s+)?(?:funds|money|usdc|eth|tokens?)|withdraw\w*|crypto|tokenomics|token\s+(?:sale|launch|price|marketing)|pric(?:e|es|ing)\s+(?:change|increase|cut|plan)s?)\b",
            r"(?i)\b(?:delet|wip|purg|drop|destroy|truncat|eras)\w*\s+(?:\S+\s+){0,3}?(?:data|databases?|db|tables?|records?|rows|accounts?|users?|backups?|volumes?|buckets?|disks?|vms?|servers?|instances?|history|chats|conversations|e-?mails?|branch(?:es)?)\b|\brm\s+-rf\b",
            r"(?i)\b(?:prod|production|live\s+site|go(?:es|ing)?\s+live|promot(?:e|es|ed|ing)\s+(?:it|this|the|to)|proxmox|pve\d*)\b",
            r"(?i)\b(?:all|every|mass|bulk)\s+(?:the\s+)?(?:users?|customers?|accounts?|instances?|vms?|boxes|servers?|hosts?|subscribers?)\b|\bfleet\b",
            r"(?i)\b(?:e-?mail|message|notify|dm|text)\w*\s+(?:\S+\s+){0,3}?(?:customers?|users?|subscribers?|everyone|the\s+list)\b|\b(?:newsletter|broadcast|announce\w*|tweet\w*|product\s+hunt|public\s+launch|launch\s+publicly|publish\w*)\b|\bpost\s+(?:it\s+)?(?:on|to)\s+(?:x|twitter|reddit|linkedin|hacker\s+news|hn|discord)\b",
            r"(?i)\b(?:secrets?|credentials?|passwords?|api[\s-]keys?|private\s+keys?|irreversibl\w*|can'?t\s+be\s+undone|force[\s-]push\w*|rewrite\s+(?:the\s+)?(?:git\s+)?history)\b",
        ];
        RAW.iter()
            .map(|pattern| Regex::new(pattern).expect("red line pattern"))
            .collect()
    })
}

/// Ash's red list, ported from `looksRedLine`. A hit is never matched and never ticked for reuse.
fn looks_red_line(text: &str) -> bool {
    red_lines().iter().any(|pattern| pattern.is_match(text))
}

fn person_answered(by: Option<&str>) -> bool {
    matches!(by.map(str::trim), Some("user") | Some("person"))
}

/// The standing answers Ash can see: ticked, from the person, not a protected key, not a red line, newest twenty.
fn visible_standing(conn: &Connection, project: &str) -> Result<Vec<Decision>, String> {
    let project = project.trim();
    if project.is_empty() || !standing_enabled(conn)? {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {READ_COLUMNS} FROM decisions
         WHERE project = ?1 AND state = ?2 AND standing != 0 AND retired_at IS NULL AND answer IS NOT NULL
           AND answered_by IN ('user', 'person')
         ORDER BY answered_at DESC, rowid DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project, ANSWERED], from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        if out.len() >= STANDING_ROWS {
            break;
        }
        if !standing_eligible(&row.decision_key) {
            continue;
        }
        if looks_red_line(&row.question) || looks_red_line(row.answer.as_deref().unwrap_or("")) {
            continue;
        }
        out.push(row);
    }
    Ok(out)
}

fn best_match(
    conn: &Connection,
    project: &str,
    question: &str,
) -> Result<Option<Decision>, String> {
    if looks_red_line(question) {
        return Ok(None);
    }
    let query = words(question);
    if query.len() < MATCH_SHARED {
        return Ok(None);
    }
    let rows = visible_standing(conn, project)?;
    let mut best: Option<(Decision, usize, usize)> = None;
    for row in rows {
        let theirs = query_words(&row.question, &row.keys);
        let shared = query.iter().filter(|word| theirs.contains(word)).count();
        let union = query.len() + theirs.len() - shared;
        if !scores_match(shared, union) {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((_, best_shared, best_union)) => {
                better_score(shared, union, *best_shared, *best_union)
            }
        };
        if replace {
            best = Some((row, shared, union));
        }
    }
    Ok(best.map(|(row, _, _)| row))
}

fn cite(
    conn: &Connection,
    project: &str,
    key: &str,
    task_id: &str,
    asked_by: &str,
    question: &str,
    now: i64,
) -> Result<(), String> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Ok(());
    }
    let question = one_line(question);
    let question: String = question.chars().take(300).collect();
    conn.execute(
        "INSERT INTO decision_citations (project, decision_key, task_id, cited_at, asked_by, question)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (project, decision_key, task_id) DO NOTHING",
        params![project, key, task_id, now, asked_by.trim(), question],
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
            "SELECT task_id, cited_at, asked_by, question FROM decision_citations
             WHERE project = ?1 AND decision_key = ?2 ORDER BY cited_at, task_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project, key], |row| {
            Ok(StandingCitation {
                task_id: row.get(0)?,
                cited_at: row.get(1)?,
                asked_by: row.get(2)?,
                question: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

struct Reopen<'a> {
    question: &'a str,
    options: &'a [String],
    recommended: &'a Option<String>,
    keys: &'a [String],
    added: &'a [String],
}

/// The same key of a retired or stopped answer is an open question again. The old answer is not handed out.
fn reopen_row(
    conn: &Connection,
    row: &Decision,
    next: Reopen<'_>,
    now: i64,
) -> Result<Decision, String> {
    let mut waiting = row.waiting.clone();
    waiting.extend(next.added.iter().cloned());
    let version = row.version + 1;
    let changed = conn
        .execute(
            "UPDATE decisions SET question = ?1, options = ?2, recommended = ?3, waiting = ?4,
                state = ?5, answer = NULL, answered_by = NULL, answered_at = NULL,
                standing = 0, reuse_stopped = 0, retired_at = NULL, retired_reason = NULL,
                keys = ?6, force_reason = NULL, updated_at = ?7, version = ?8
             WHERE project = ?9 AND decision_key = ?10 AND version = ?11
               AND state = ?12 AND (retired_at IS NOT NULL OR reuse_stopped != 0)",
            params![
                next.question,
                json!(next.options).to_string(),
                next.recommended,
                json!(waiting).to_string(),
                OPEN,
                json!(next.keys).to_string(),
                now,
                version,
                row.project,
                row.decision_key,
                row.version,
                ANSWERED,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That question changed while it was reopened. Ask again.".into());
    }
    get(conn, &row.project, &row.decision_key)?
        .ok_or_else(|| "The decision was not stored".to_string())
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
    let eligible = standing_eligible(&key);
    let enabled = standing_enabled(&tx)?;
    let mut forced_reason: Option<String> = None;
    // The same key stays one decision, even when standing answers are on and even with force.
    // A different key can reuse a ticked answer while the setting is on. The asker's keys are not part of the match.
    if existing.is_none() && eligible && enabled && !looks_red_line(&question) {
        if let Some(hit) = best_match(&tx, &project, &question)? {
            if !input.force {
                let mut released = Vec::new();
                let mut cited = task_ids.clone();
                if cited.is_empty() {
                    cited.push(asked_by.clone());
                }
                let text = match_release_text(&hit);
                for id in &task_ids {
                    if let Some(message) = release_one(&tx, &hit, id, &text, now)? {
                        released.push(message);
                    }
                }
                for id in &cited {
                    cite(
                        &tx,
                        &hit.project,
                        &hit.decision_key,
                        id,
                        &asked_by,
                        &question,
                        now,
                    )?;
                }
                let standing_id = hit.standing_id.clone();
                crate::work_log::best_effort(&tx, "standing match", |conn| {
                    crate::work_log::record_standing_match(
                        conn,
                        &hit.project,
                        &standing_id,
                        &asked_by,
                        &question,
                        now,
                    )
                });
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
            forced_reason = Some(plain(
                input.reason.as_deref().unwrap_or(""),
                "The reason",
                300,
            )?);
        }
    }
    // A retired answer, or one whose reuse was stopped, is asked again instead of being handed out.
    if let Some(row) = existing.as_ref() {
        if row.state == ANSWERED && (row.retired_at.is_some() || row.reuse_stopped) {
            let added: Vec<String> = task_ids
                .iter()
                .filter(|id| !row.waiting.contains(id))
                .cloned()
                .collect();
            if row.waiting.len() + added.len() > WAITING_MAX {
                return Err(format!(
                    "{WAITING_MAX} tasks already wait on this decision; that is the most one holds."
                ));
            }
            let keys = if eligible && enabled {
                accept_keys(&input.keys, &question)
            } else {
                row.keys.clone()
            };
            let decision = reopen_row(
                &tx,
                row,
                Reopen {
                    question: &question,
                    options: &options,
                    recommended: &recommended,
                    keys: &keys,
                    added: &added,
                },
                now,
            )?;
            tx.commit().map_err(|e| e.to_string())?;
            move_questions(conn, &added, QUESTION_FOR_PERSON, now);
            return Ok(AskOutcome {
                decision,
                created: false,
                added,
                released: Vec::new(),
                matched: false,
                standing_id: None,
            });
        }
    }
    let created = existing.is_none();
    let store_keys = created && eligible && enabled;
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
        standing: false,
        keys: stored_keys,
        retired_at: None,
        retired_reason: None,
        reuse_stopped: false,
        force_reason: forced_reason,
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
            if let Some(message) = release_one(&tx, &decision, id, &release_text(&decision), now)? {
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
///
/// WP-81: so is a delivery check (`gate/<run>`). Approving it tells the check to send the work on, so a chat that knows
/// the run id must not answer it, whatever the spelling. The app's own closers are not a way round it either.
pub fn person_only(key: &str, by: Option<&str>) -> Option<String> {
    let review = is_review_key(key);
    let again = is_again_key(key);
    let gate = is_gate_key(key);
    if !fold_key(key).starts_with("irreversible/") && !review && !again && !gate {
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
        Some(other) if gate => Some(format!(
            "Only the person answers the check; {other} cannot. It waits in Needs until they do."
        )),
        Some(other) => Some(format!(
            "Only the person answers an irreversible step; {other} cannot. It waits in Needs until they do."
        )),
    }
}

/// WP-81: a delivery check parked under `gate/<run>`. Read through `fold_key`, like the other person-only prefixes.
pub fn is_gate_key(key: &str) -> bool {
    fold_key(key).starts_with("gate/")
}

/// The person, as an answer is recorded: nobody named, or the words the app uses for them.
fn from_person(by: Option<&str>) -> bool {
    matches!(
        by.map(str::trim).filter(|word| !word.is_empty()),
        None | Some("user") | Some("person")
    )
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
    // An answer does not stand until the person ticks it. A chat's answer never can.
    decision.standing = false;
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
        if let Some(message) = release_one(&tx, &decision, &id, &release_text(&decision), now)? {
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
                request_id: release_request(&decision.decision_key, "asker", decision.version),
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
    /// The chat that relied on it. Empty on a citation stored before this was kept.
    pub asked_by: String,
    /// The question that relied on it, one line. Empty on a citation stored before this was kept.
    pub question: String,
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

/// Turn reuse on or off for one answer. Only the person's own answer can be turned on, and never a red line, a protected
/// key, or a retired row. Turning it off after it was on stops the same key from being handed out again. Missing key:
/// nothing to change. A row already in the requested state is left as it is, but turning on still checks the rules, so a
/// flag forced on in the database cannot be confirmed.
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
    if standing {
        if decision.retired_at.is_some() {
            return Err("A retired answer is not reused. Ask the question again.".into());
        }
        if decision.state != ANSWERED || decision.answer.as_deref().unwrap_or("").trim().is_empty()
        {
            return Err("Only an answered question can be reused.".into());
        }
        if !person_answered(decision.answered_by.as_deref()) {
            return Err("Only an answer from the person can be reused.".into());
        }
        if !standing_eligible(&decision.decision_key) {
            return Err("This kind of question is never reused.".into());
        }
        if looks_red_line(&decision.question)
            || looks_red_line(decision.answer.as_deref().unwrap_or(""))
        {
            return Err(
                "A question on a red line is never reused. The person answers that one.".into(),
            );
        }
    }
    if decision.standing == standing {
        return Ok(Some(decision));
    }
    let version = decision.version;
    decision.standing = standing;
    // Off after it was on: the same key is asked again. On: a previous stop is cleared.
    decision.reuse_stopped = !standing;
    decision.updated_at = now;
    decision.version += 1;
    let changed = tx
        .execute(
            "UPDATE decisions SET standing = ?1, reuse_stopped = ?2, updated_at = ?3, version = ?4
             WHERE project = ?5 AND decision_key = ?6 AND version = ?7",
            params![
                if standing { 1 } else { 0 },
                if decision.reuse_stopped { 1 } else { 0 },
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
/// The same twenty the brief shows: ticked, from the person, not a red line. Empty when standing answers are off.
pub fn standing_rows(conn: &Connection, project: &str) -> Result<Vec<StandingRow>, String> {
    let rows = visible_standing(conn, project)?;
    let mut out = Vec::new();
    for row in rows {
        let uses = citations_for(conn, &row.project, &row.decision_key)?.len() as i64;
        out.push(StandingRow {
            project: row.project,
            decision_key: row.decision_key,
            question: row.question,
            answer: row.answer.unwrap_or_default(),
            standing_id: row.standing_id,
            uses,
        });
    }
    Ok(out)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReuseRow {
    pub project: String,
    pub decision_key: String,
    pub question: String,
    pub answer: String,
    pub standing_id: String,
    pub uses: i64,
    /// False until the person ticks reuse. The Inbox lists both, so an old answer is not reused by surprise.
    pub standing: bool,
}

/// Recent answers from the person that could be reused, ticked or not. Protected keys and red lines are left out.
/// The setting does not hide this list: it is how the person chooses, before or after standing answers are on.
pub fn reuse_rows(conn: &Connection, project: &str) -> Result<Vec<ReuseRow>, String> {
    let project = project.trim();
    if project.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {READ_COLUMNS} FROM decisions
         WHERE project = ?1 AND state = ?2 AND retired_at IS NULL AND answer IS NOT NULL
           AND answered_by IN ('user', 'person')
         ORDER BY answered_at DESC, rowid DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project, ANSWERED], from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        if out.len() >= STANDING_ROWS {
            break;
        }
        if !standing_eligible(&row.decision_key) {
            continue;
        }
        if looks_red_line(&row.question) || looks_red_line(row.answer.as_deref().unwrap_or("")) {
            continue;
        }
        let uses = citations_for(conn, &row.project, &row.decision_key)?.len() as i64;
        out.push(ReuseRow {
            project: row.project,
            decision_key: row.decision_key,
            question: row.question,
            answer: row.answer.unwrap_or_default(),
            standing_id: row.standing_id,
            uses,
            standing: row.standing,
        });
    }
    Ok(out)
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

/// A question or an answer is untrusted. Flatten it, and keep it from closing the brief's fence.
fn fence_safe(value: &str) -> String {
    one_line(value).replace('<', "&lt;").replace('>', "&gt;")
}

fn standing_line(row: &Decision) -> String {
    let line = format!(
        "{}: asked by a chat: {} Ash's answer: {}",
        row.standing_id,
        fence_safe(&row.question),
        fence_safe(row.answer.as_deref().unwrap_or(""))
    );
    line.chars().take(300).collect()
}

pub fn standing_block(conn: &Connection, project: &str) -> Result<String, String> {
    let rows = visible_standing(conn, project)?;
    let mut body = Vec::new();
    let mut size = STANDING_HEADER.chars().count();
    for row in rows {
        let line = standing_line(&row);
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
    if outcome.created || !outcome.added.is_empty() || outcome.matched {
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
    let outcome = answer_and_relay(
        &store,
        project.as_deref().unwrap_or(""),
        &key,
        &answer,
        by,
        now_millis(),
    )?;
    if outcome.applied {
        announce(&app, outcome.decision.as_ref(), &outcome.released);
    }
    Ok(outcome)
}

/// What `decisions_answer` does with the store, without the window announce, so a test can run the same path.
pub(crate) fn answer_and_relay(
    store: &SessionStore,
    project: &str,
    key: &str,
    answer_text: &str,
    by: Option<String>,
    now: i64,
) -> Result<AnswerOutcome, String> {
    let outcome = answer(&mut *store.lock_conn()?, project, key, answer_text, by, now)?;
    relay_gate_answer(store, &outcome, answer_text);
    Ok(outcome)
}

/// WP-81: a check hears an answer only when this one just landed and the person gave it.
/// The key and the project are the stored decision's, not the spelling the caller typed.
pub(crate) fn relay_gate_answer(store: &SessionStore, outcome: &AnswerOutcome, answer: &str) {
    if !outcome.applied {
        return;
    }
    let Some(decision) = outcome.decision.as_ref() else {
        return;
    };
    if !from_person(decision.answered_by.as_deref()) || !is_gate_key(&decision.decision_key) {
        return;
    }
    let _ = crate::delivery_gate::forward_answer(
        store,
        &decision.project,
        &decision.decision_key,
        answer,
    );
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

/// WP-156: the Inbox list behind "Reuse for similar questions". The webview calls this. No agent tool does.
#[tauri::command(async)]
pub fn decisions_reuse_list(
    store: State<'_, SessionStore>,
    project: Option<String>,
) -> Result<Vec<ReuseRow>, String> {
    reuse_rows(&*store.lock_conn()?, project.as_deref().unwrap_or(""))
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
