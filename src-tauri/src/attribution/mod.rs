// SPDX-License-Identifier: Apache-2.0
// Hivra WP-86. Design: HumanLayer packages/git-attribution (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// The rules in logic.rs match src/features/attribution.

//! Commit attribution. A crew's git sees a hooks folder in this copy's data
//! directory and stamps the chat and the task. Lines the crew left behind are
//! journaled, and a later commit of those lines is inferred. A person's own
//! commit keeps counts only.

mod git;
mod hooks;
mod logic;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::activity::{self, Who};
use crate::portable::scrubber;
use crate::session_store::{now_millis, SessionStore};

use logic::{LedgerRow, Tier};

pub use git::dirty_hashes;

const REFUSAL: &str = "git didn't answer";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCredit {
    pub sha: String,
    pub tier: String,
    pub agent: Option<String>,
    pub task_id: Option<String>,
    pub task_title: Option<String>,
    pub chat_id: Option<String>,
    pub file_count: i64,
    pub line_count: i64,
    pub subject: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrTaskOut {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreditOut {
    pub agents: Vec<String>,
    pub tasks: Vec<PrTaskOut>,
}

struct TaskHit {
    id: String,
    assignee: Option<String>,
}

struct Event {
    tier: Tier,
    chat: String,
    agent: String,
    task_label: String,
    sha: String,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS attribution_commits (
           sha TEXT NOT NULL,
           repo TEXT NOT NULL,
           tier TEXT NOT NULL CHECK (tier IN ('confirmed', 'inferred', 'person')),
           chat_id TEXT,
           task_id TEXT,
           agent TEXT,
           file_count INTEGER NOT NULL,
           line_count INTEGER NOT NULL,
           subject TEXT,
           at INTEGER NOT NULL,
           PRIMARY KEY (repo, sha)
         );
         CREATE INDEX IF NOT EXISTS attribution_commits_task ON attribution_commits(task_id);
         CREATE TABLE IF NOT EXISTS attribution_journal (
           line_hash TEXT NOT NULL,
           chat_id TEXT NOT NULL,
           task_id TEXT NOT NULL DEFAULT '',
           agent TEXT,
           repo TEXT NOT NULL,
           run_id TEXT NOT NULL,
           at INTEGER NOT NULL,
           PRIMARY KEY (repo, line_hash, chat_id, task_id)
         );",
    )
}

/// Point this crew's git at the hooks folder. A bad config count sets nothing.
/// Failure to install does not stop the crew: the caller ignores the result.
pub fn apply_crew_env(cmd: &mut Command, data_dir: &Path, session_id: &str, task_id: Option<&str>) {
    let Ok(hooks) = hooks::install_hooks(data_dir) else {
        return;
    };
    let Some(hooks_path) = hooks.to_str() else {
        return;
    };
    let existing = std::env::var("GIT_CONFIG_COUNT").ok();
    let Some((count, key, value_name)) = logic::git_config_env(existing.as_deref(), hooks_path)
    else {
        return;
    };
    cmd.env("GIT_CONFIG_COUNT", count);
    cmd.env(key, "core.hooksPath");
    cmd.env(value_name, hooks_path);
    if let Some(chat) = logic::valid_id(session_id) {
        cmd.env("HIVRA_CHAT", chat);
    }
    if let Some(task) = task_id.and_then(logic::valid_id) {
        cmd.env("HIVRA_TASK", task);
    }
}

pub fn task_id_for_session(
    store: &SessionStore,
    session_id: &str,
) -> Result<Option<String>, String> {
    if logic::valid_id(session_id).is_none() {
        return Ok(None);
    }
    let conn = store.lock_conn()?;
    Ok(lookup_task(&conn, session_id)?.map(|task| task.id))
}

/// Journal the lines that appeared while the crew ran. Git runs before the
/// database is locked. A failed read leaves the journal as it was.
pub fn note_run(
    app: &AppHandle,
    session_id: &str,
    workdir: &Path,
    before: &HashSet<String>,
) -> Result<(), String> {
    if logic::valid_id(session_id).is_none() {
        return Ok(());
    }
    let after = dirty_hashes(workdir)?;
    let mut fresh: Vec<String> = after.hashes.difference(before).cloned().collect();
    if fresh.is_empty() {
        return Ok(());
    }
    if fresh.len() > git::MAX_LINES {
        return Err(REFUSAL.into());
    }
    fresh.sort();
    let Some(store) = app.try_state::<SessionStore>() else {
        return Err(REFUSAL.into());
    };
    remember_lines(&store, &after.repo, session_id, &fresh)
}

pub(crate) fn remember_lines(
    store: &SessionStore,
    repo: &Path,
    chat: &str,
    hashes: &[String],
) -> Result<(), String> {
    let Some(chat) = logic::valid_id(chat) else {
        return Ok(());
    };
    let repo = crate::fs::canonical(repo).map_err(|_| REFUSAL.to_string())?;
    let repo_key = path_key(&repo)?;
    let conn = store.lock_conn()?;
    let task = lookup_task(&conn, chat)?;
    let at = now_millis();
    let run_id = format!("{chat}-{at}-{}", std::process::id());
    let task_id = task.as_ref().map(|hit| hit.id.clone()).unwrap_or_default();
    let agent = clean_text(task.and_then(|hit| hit.assignee));
    for hash in hashes {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO attribution_journal
               (line_hash, chat_id, task_id, agent, repo, run_id, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![hash, chat, task_id, agent, repo_key, run_id, at],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn lookup_task(conn: &Connection, chat: &str) -> Result<Option<TaskHit>, String> {
    let sql = "SELECT t.id, t.assignee
               FROM tasks t
               JOIN delegations d ON d.id = t.delegation_id
               WHERE d.child_session = ?1 AND t.trashed_at IS NULL
               ORDER BY t.updated_at DESC
               LIMIT 1";
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(err) if missing_table(&err) => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    let mut rows = stmt.query([chat]).map_err(|e| e.to_string())?;
    let Some(row) = rows.next().map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let id: String = row.get(0).map_err(|e| e.to_string())?;
    let assignee: Option<String> = row.get(1).map_err(|e| e.to_string())?;
    if id.is_empty() {
        return Ok(None);
    }
    Ok(Some(TaskHit {
        id,
        assignee: clean_text(assignee),
    }))
}

fn missing_table(err: &rusqlite::Error) -> bool {
    err.to_string().contains("no such table")
}

fn path_key(path: &Path) -> Result<String, String> {
    path.to_str()
        .filter(|text| !text.is_empty() && !text.contains('\0'))
        .map(str::to_string)
        .ok_or_else(|| REFUSAL.into())
}

fn usable_repo(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\0')
        && !path.chars().any(|c| c.is_control())
}

fn clean_text(value: Option<String>) -> Option<String> {
    let value = value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())?;
    if scrubber().has_secret(&value) {
        None
    } else {
        Some(value)
    }
}

fn clean_subject(tier: Tier, subject: Option<String>) -> Option<String> {
    if tier == Tier::Person {
        return None;
    }
    clean_text(subject)
}

fn task_title(conn: &Connection, task_id: Option<&str>) -> Option<String> {
    let id = task_id.map(str::trim).filter(|text| !text.is_empty())?;
    let title = conn.query_row(
        "SELECT title FROM tasks WHERE id = ?1 AND trashed_at IS NULL",
        [id],
        |row| row.get::<_, String>(0),
    );
    match title {
        Ok(title) => clean_text(Some(title)).or_else(|| Some(id.to_string())),
        Err(_) => Some(id.to_string()),
    }
}

fn activity_task(title: &Option<String>) -> String {
    title
        .clone()
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "a task".into())
}

fn load_row(conn: &Connection, repo: &str, sha: &str) -> Result<Option<LedgerRow>, String> {
    let raw = conn
        .query_row(
            "SELECT tier, chat_id, task_id, agent, file_count, line_count, subject
             FROM attribution_commits WHERE repo = ?1 AND sha = ?2",
            params![repo, sha],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((tier, chat, task, agent, files, lines, subject)) = raw else {
        return Ok(None);
    };
    let Some(tier) = Tier::parse(&tier) else {
        return Err("The stored credit was not readable.".into());
    };
    Ok(Some(LedgerRow {
        sha: sha.to_string(),
        tier,
        chat_id: clean_text(chat),
        task_id: clean_text(task),
        agent: clean_text(agent),
        file_count: files.max(0),
        line_count: lines.max(0),
        subject: clean_subject(tier, subject),
    }))
}

fn save_row(
    conn: &Connection,
    repo: &str,
    incoming: &LedgerRow,
) -> Result<(LedgerRow, Option<Event>), String> {
    let existing = load_row(conn, repo, &incoming.sha)?;
    let merged = logic::merge_ledger(existing.as_ref(), incoming);
    let record = match &existing {
        None => merged.tier != Tier::Person,
        Some(prev) => merged.tier.rank() > prev.tier.rank(),
    };
    let (chat, task, agent, subject) = if merged.tier == Tier::Person {
        (None, None, None, None)
    } else {
        (
            merged.chat_id.clone(),
            merged.task_id.clone(),
            merged.agent.clone(),
            merged.subject.clone(),
        )
    };
    conn.execute(
        "INSERT INTO attribution_commits
           (sha, repo, tier, chat_id, task_id, agent, file_count, line_count, subject, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(repo, sha) DO UPDATE SET
           tier = excluded.tier,
           chat_id = excluded.chat_id,
           task_id = excluded.task_id,
           agent = excluded.agent,
           file_count = excluded.file_count,
           line_count = excluded.line_count,
           subject = excluded.subject",
        params![
            merged.sha,
            repo,
            merged.tier.as_str(),
            chat,
            task,
            agent,
            merged.file_count.max(0),
            merged.line_count.max(0),
            subject,
            now_millis(),
        ],
    )
    .map_err(|e| e.to_string())?;
    if !record {
        return Ok((merged, None));
    }
    let Some(chat_id) = merged.chat_id.clone().filter(|text| !text.is_empty()) else {
        return Ok((merged, None));
    };
    let title = task_title(conn, merged.task_id.as_deref());
    let event = Event {
        tier: merged.tier,
        chat: chat_id,
        agent: merged.agent.clone().unwrap_or_else(|| "an agent".into()),
        task_label: activity_task(&title),
        sha: merged.sha.clone(),
    };
    Ok((merged, Some(event)))
}

fn to_credit(conn: &Connection, row: &LedgerRow) -> CommitCredit {
    let person = row.tier == Tier::Person;
    let task_id = if person { None } else { row.task_id.clone() };
    CommitCredit {
        sha: row.sha.clone(),
        tier: row.tier.as_str().to_string(),
        agent: if person { None } else { row.agent.clone() },
        task_title: if person {
            None
        } else {
            task_title(conn, task_id.as_deref())
        },
        task_id,
        chat_id: if person { None } else { row.chat_id.clone() },
        file_count: row.file_count.max(0),
        line_count: row.line_count.max(0),
        subject: if person { None } else { row.subject.clone() },
    }
}

fn agent_hint(
    conn: &Connection,
    cache: &mut HashMap<String, Option<String>>,
    chat: &str,
) -> Result<Option<String>, String> {
    if let Some(found) = cache.get(chat) {
        return Ok(found.clone());
    }
    let agent = lookup_task(conn, chat)?.and_then(|hit| hit.assignee);
    cache.insert(chat.to_string(), agent.clone());
    Ok(agent)
}

fn write_commits(
    conn: &Connection,
    repo: &str,
    commits: &[logic::CommitView],
    journal: &[logic::JournalLine],
) -> Result<(Vec<CommitCredit>, Vec<Event>), String> {
    let mut credits = Vec::new();
    let mut events = Vec::new();
    let mut cache = HashMap::new();
    for commit in commits {
        let mut row = logic::attribute_commit(commit, journal, None);
        if row.agent.is_none() {
            if let Some(chat) = row.chat_id.clone() {
                row.agent = agent_hint(conn, &mut cache, &chat)?;
            }
        }
        row.agent = clean_text(row.agent);
        row.subject = clean_subject(row.tier, row.subject);
        row.chat_id = clean_text(row.chat_id);
        row.task_id = clean_text(row.task_id);
        let (stored, event) = save_row(conn, repo, &row)?;
        if let Some(event) = event {
            events.push(event);
        }
        credits.push(to_credit(conn, &stored));
    }
    Ok((credits, events))
}

fn load_journal(conn: &Connection, repo: &str) -> Result<Vec<logic::JournalLine>, String> {
    let mut stmt = conn
        .prepare("SELECT line_hash, chat_id, task_id, agent, at FROM attribution_journal WHERE repo = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([repo], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut journal = Vec::new();
    for row in rows {
        let (hash, chat, task, agent, at) = row.map_err(|e| e.to_string())?;
        if hash.len() != 64 || chat.is_empty() {
            continue;
        }
        journal.push(logic::JournalLine {
            hash,
            chat_id: chat,
            task_id: if task.is_empty() { None } else { Some(task) },
            agent: clean_text(agent),
            at,
        });
    }
    Ok(journal)
}

fn finish_write(
    conn: &Connection,
    repo: &str,
    commits: &[logic::CommitView],
    journal: &[logic::JournalLine],
) -> Result<(Vec<CommitCredit>, Vec<Event>), String> {
    let _ = conn.busy_timeout(Duration::from_secs(5));
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    match write_commits(conn, repo, commits, journal) {
        Ok(saved) => {
            if let Err(err) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(err.to_string());
            }
            Ok(saved)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

fn record_events(store: &SessionStore, repo: &str, events: &[Event]) {
    let Ok(conn) = store.lock_conn() else {
        return;
    };
    for event in events {
        let actor = Who::worker(&event.chat, &event.agent);
        let initiator = if event.tier == Tier::Confirmed {
            Who::worker(&event.chat, &event.agent)
        } else {
            Who::person()
        };
        let summary = logic::commit_line(Some(&event.agent), Some(&event.task_label));
        let link = format!("session:{}", event.chat);
        let _ = activity::record(
            &conn,
            "git.commit",
            &actor,
            &initiator,
            repo,
            &event.sha,
            &summary,
            &link,
            now_millis(),
        );
    }
}

/// Read git first. The database changes only after every read has succeeded.
pub(crate) fn refresh(
    store: &SessionStore,
    workdir: &Path,
    only: Option<&[String]>,
) -> Result<Vec<CommitCredit>, String> {
    let repo = git::toplevel(workdir)?;
    let repo_key = path_key(&repo)?;
    let shas = match only {
        Some(list) => list
            .iter()
            .filter(|sha| logic::valid_sha(sha))
            .take(200)
            .cloned()
            .collect::<Vec<_>>(),
        None => git::recent_shas(&repo, 50)?,
    };
    let mut commits = Vec::new();
    for sha in &shas {
        match git::read_commit(&repo, sha) {
            Ok(commit) => commits.push(commit),
            Err(git::GitFail::Rejected) => continue,
            Err(git::GitFail::Unavailable) => return Err(REFUSAL.into()),
        }
    }
    let conn = store.lock_conn()?;
    let journal = load_journal(&conn, &repo_key)?;
    let (credits, events) = finish_write(&conn, &repo_key, &commits, &journal)?;
    drop(conn);
    record_events(store, &repo_key, &events);
    Ok(credits)
}

#[cfg(test)]
pub(crate) fn store_credit(
    store: &SessionStore,
    repo: &str,
    mut row: LedgerRow,
) -> Result<(), String> {
    row.agent = clean_text(row.agent);
    row.subject = clean_subject(row.tier, row.subject);
    row.chat_id = if row.tier == Tier::Person {
        None
    } else {
        clean_text(row.chat_id)
    };
    row.task_id = if row.tier == Tier::Person {
        None
    } else {
        clean_text(row.task_id)
    };
    let conn = store.lock_conn()?;
    let _ = conn.busy_timeout(Duration::from_secs(5));
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let saved = save_row(&conn, repo, &row);
    let events = match saved {
        Ok((_, event)) => {
            if let Err(err) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(err.to_string());
            }
            event.into_iter().collect::<Vec<_>>()
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(err);
        }
    };
    drop(conn);
    record_events(store, repo, &events);
    Ok(())
}

fn rows_for_task(store: &SessionStore, task_id: &str) -> Result<Vec<CommitCredit>, String> {
    let conn = store.lock_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT sha FROM attribution_commits
             WHERE task_id = ?1
             ORDER BY at DESC
             LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let shas = stmt
        .query_map([task_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let mut credits = Vec::new();
    for sha in shas {
        if let Some(row) = load_any(&conn, &sha)? {
            if row.task_id.as_deref() == Some(task_id) && row.tier != Tier::Person {
                credits.push(to_credit(&conn, &row));
            }
        }
    }
    Ok(credits)
}

fn load_any(conn: &Connection, sha: &str) -> Result<Option<LedgerRow>, String> {
    let mut stmt = conn
        .prepare("SELECT repo, tier FROM attribution_commits WHERE sha = ?1")
        .map_err(|e| e.to_string())?;
    let pairs = stmt
        .query_map([sha], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let mut best: Option<LedgerRow> = None;
    for (repo, tier_text) in pairs {
        let Some(tier) = Tier::parse(&tier_text) else {
            continue;
        };
        let Some(row) = load_row(conn, &repo, sha)? else {
            continue;
        };
        let replace = match &best {
            None => true,
            Some(current) => row.tier.rank() > current.tier.rank(),
        };
        if replace && tier == row.tier {
            best = Some(row);
        }
    }
    Ok(best)
}

fn credit_for_shas(store: &SessionStore, shas: &[String]) -> Result<PrCreditOut, String> {
    let conn = store.lock_conn()?;
    let mut rows = Vec::new();
    let mut titles = HashMap::new();
    for sha in shas {
        let Some(row) = load_any(&conn, sha)? else {
            continue;
        };
        if let Some(task) = row.task_id.clone() {
            if let Some(title) = task_title(&conn, Some(&task)) {
                titles.insert(task, title);
            }
        }
        rows.push(row);
    }
    Ok(pr_out(&rows, &titles))
}

fn pr_out(rows: &[LedgerRow], titles: &HashMap<String, String>) -> PrCreditOut {
    let credit = logic::attribute_pull_request(rows, titles);
    PrCreditOut {
        agents: credit.agents,
        tasks: credit
            .tasks
            .into_iter()
            .map(|task| PrTaskOut {
                id: task.id,
                title: task.title,
            })
            .collect(),
    }
}

fn clean_shas(shas: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for sha in shas {
        if !logic::valid_sha(sha) || !seen.insert(sha.clone()) {
            continue;
        }
        out.push(sha.clone());
        if out.len() == 200 {
            break;
        }
    }
    out
}

fn task_token(task_id: &str) -> Option<&str> {
    let task_id = task_id.trim();
    if task_id.is_empty()
        || task_id.chars().count() > 200
        || task_id.chars().any(|c| c.is_control())
    {
        None
    } else {
        Some(task_id)
    }
}

#[tauri::command(async)]
pub fn attribution_for_task(
    store: State<'_, SessionStore>,
    task_id: String,
    repo: Option<String>,
) -> Result<Vec<CommitCredit>, String> {
    let Some(task_id) = task_token(&task_id) else {
        return Ok(Vec::new());
    };
    let current = rows_for_task(&store, task_id)?;
    let Some(repo) = repo.filter(|path| usable_repo(path)) else {
        return Ok(current);
    };
    match refresh(&store, Path::new(&repo), None) {
        Ok(rows) => Ok(rows
            .into_iter()
            .filter(|row| row.task_id.as_deref() == Some(task_id))
            .collect()),
        Err(_) => Ok(current),
    }
}

#[tauri::command(async)]
pub fn attribution_for_commits(
    store: State<'_, SessionStore>,
    repo: String,
    shas: Vec<String>,
) -> Result<PrCreditOut, String> {
    let shas = clean_shas(&shas);
    let current = credit_for_shas(&store, &shas)?;
    if shas.is_empty() || !usable_repo(&repo) {
        return Ok(current);
    }
    match refresh(&store, Path::new(&repo), Some(&shas)) {
        Ok(_) => credit_for_shas(&store, &shas),
        Err(_) => Ok(current),
    }
}
