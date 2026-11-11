// SPDX-License-Identifier: Apache-2.0
// Hivra WP-86. Design: HumanLayer packages/git-attribution (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// The rules in logic.rs match src/features/attribution.

//! Commit attribution. A crew's git sees a hooks folder in this copy's data
//! directory and stamps the chat and the task. Lines the crew left behind are
//! journaled, and a later commit of those lines is inferred. A person's own
//! commit keeps counts only.

mod git;
pub(crate) mod hooks;
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

/// A timeout is not a final answer. One more try, then the last error stands.
/// Two attempts, not more: each one can wait out git's own timeout, and a crew is waiting.
pub(crate) fn read_with_retry<T>(mut read: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    match read() {
        Ok(value) => Ok(value),
        Err(first) => {
            std::thread::sleep(Duration::from_millis(20));
            read().map_err(|_| first)
        }
    }
}

pub fn lines_before_run(workdir: &Path) -> Result<git::DirtyLines, String> {
    // A truncated read is `Ok`. Retrying it would not see the lines the cap
    // dropped, and treating it as a failure would throw away the lines already stored.
    read_with_retry(|| dirty_hashes(workdir))
}

/// The before-run snapshot, started off the caller's thread. `wait` is the only
/// place that blocks, and only the crew's exit path calls it.
pub struct BeforeRun {
    rx: std::sync::mpsc::Receiver<Option<git::DirtyLines>>,
}

impl BeforeRun {
    pub fn wait(self) -> Option<git::DirtyLines> {
        self.rx.recv().ok().flatten()
    }
}

#[cfg(test)]
thread_local! {
    static JOURNAL_PAUSE_MS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Tests only. The pause is read on the calling thread and slept on the worker,
/// so one slow journal does not stall the other tests.
#[cfg(test)]
pub(crate) fn set_journal_pause_for_test(ms: u64) {
    JOURNAL_PAUSE_MS.with(|cell| cell.set(ms));
}

fn journal_pause() -> Duration {
    #[cfg(test)]
    {
        JOURNAL_PAUSE_MS.with(|cell| Duration::from_millis(cell.get()))
    }
    #[cfg(not(test))]
    {
        Duration::from_millis(0)
    }
}

/// Start the snapshot and return at once. A turn must not wait on git.
///
/// The read runs after this returns. A line written before that read finishes
/// is already in the tree, so it counts as pre-existing and is not journaled.
/// That under-credits the run. It does not credit a line the crew did not write.
pub fn start_before_run(workdir: &Path) -> BeforeRun {
    let workdir = workdir.to_path_buf();
    let pause = journal_pause();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        if !pause.is_zero() {
            std::thread::sleep(pause);
        }
        let _ = tx.send(lines_before_run(&workdir).ok());
    });
    BeforeRun { rx }
}

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

fn has_column(conn: &Connection, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare("PRAGMA table_info(attribution_commits)")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
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
           overlap INTEGER NOT NULL DEFAULT 0,
           logged INTEGER NOT NULL DEFAULT 0,
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
    )?;
    // CREATE TABLE IF NOT EXISTS does not add columns to a table that is already there.
    if !has_column(conn, "overlap")? {
        conn.execute(
            "ALTER TABLE attribution_commits ADD COLUMN overlap INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !has_column(conn, "logged")? {
        conn.execute(
            "ALTER TABLE attribution_commits ADD COLUMN logged INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        // A person's row is never an activity line. A row already in the log must not be
        // written again. Anything still owed stays at 0 so the next write tries once more.
        conn.execute(
            "UPDATE attribution_commits SET logged = 1 WHERE tier = 'person'",
            [],
        )?;
        let activity: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'activity'",
            [],
            |row| row.get(0),
        )?;
        if activity > 0 {
            conn.execute(
                "UPDATE attribution_commits SET logged = 1
                 WHERE logged = 0 AND sha IN (
                   SELECT target FROM activity WHERE kind = 'git.commit'
                 )",
                [],
            )?;
        }
    }
    Ok(())
}

/// What the crew's own git config lookup depends on: where the user's config
/// files are. Other variables are not passed on.
const CREW_CONFIG_ENV: &[&str] = &[
    "HOME",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
];

/// A variable on the crew command, else on this process. A key the crew
/// removes stays unset, so the lookup sees what the crew's git will see.
fn crew_env(cmd: &Command, key: &str) -> Option<String> {
    let mut found = None;
    let mut seen = false;
    for (name, value) in cmd.get_envs() {
        if name.to_str() == Some(key) {
            seen = true;
            found = value.and_then(|value| value.to_str()).map(str::to_string);
        }
    }
    if seen {
        found
    } else {
        std::env::var(key).ok()
    }
}

/// The line written when the hooks could not be installed. It carries the
/// install's own refusal, which names the check and the OS error and holds no
/// path, environment value or repository text.
pub(crate) fn install_failure_note(error: &str) -> String {
    format!("Attribution: this crew runs without Hivra's commit hooks: {error}")
}

/// Point this crew's git at this repository's hooks folder. The repository's
/// own hooks are resolved once here, and each forwarder carries its path, so a
/// hook-time call never runs git. A bad config count sets nothing. Failure to
/// install does not stop the crew, and is written to stderr.
pub fn apply_crew_env(
    cmd: &mut Command,
    data_dir: &Path,
    workdir: &Path,
    session_id: &str,
    task_id: Option<&str>,
) {
    apply_crew_env_noting(cmd, data_dir, workdir, session_id, task_id, |line| {
        eprintln!("{line}");
    });
}

/// `note` is where the failure line goes, so a test can read it.
pub(crate) fn apply_crew_env_noting(
    cmd: &mut Command,
    data_dir: &Path,
    workdir: &Path,
    session_id: &str,
    task_id: Option<&str>,
    mut note: impl FnMut(String),
) {
    let env: Vec<(String, String)> = CREW_CONFIG_ENV
        .iter()
        .filter_map(|key| crew_env(cmd, key).map(|value| ((*key).to_string(), value)))
        .collect();
    let hooks = match hooks::install_for_repo(data_dir, workdir, &env) {
        Ok(hooks) => hooks,
        Err(error) => {
            // The crew still runs, so this is the only place a real failure
            // (not the one a lost race clears on its own) is ever seen.
            note(install_failure_note(&error));
            return;
        }
    };
    let Some(hooks_path) = hooks.to_str() else {
        return;
    };
    let existing = crew_env(cmd, "GIT_CONFIG_COUNT");
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

/// Hashes to journal for this run, with the repo the after read resolved.
/// `None` skips the run: the before read was truncated, so a line that was
/// already dirty can sit inside the after window and look new. The after read
/// is not started in that case.
pub(crate) fn journal_additions(
    before: &git::DirtyLines,
    after: impl FnOnce() -> Result<git::DirtyLines, String>,
) -> Result<Option<(std::path::PathBuf, Vec<String>)>, String> {
    if before.truncated {
        return Ok(None);
    }
    let after = after()?;
    let mut fresh: Vec<String> = after.hashes.difference(&before.hashes).cloned().collect();
    if fresh.len() > git::MAX_LINES {
        return Err(REFUSAL.into());
    }
    fresh.sort();
    Ok(Some((after.repo, fresh)))
}

/// Journal the lines that appeared while the crew ran. Git runs before the
/// database is locked. A failed read leaves the journal as it was.
/// A truncated before read journals nothing.
pub fn note_run(
    app: &AppHandle,
    session_id: &str,
    workdir: &Path,
    before: &git::DirtyLines,
) -> Result<(), String> {
    if logic::valid_id(session_id).is_none() {
        return Ok(());
    }
    let Some((repo, fresh)) =
        journal_additions(before, || read_with_retry(|| dirty_hashes(workdir)))?
    else {
        return Ok(());
    };
    if fresh.is_empty() {
        return Ok(());
    }
    let Some(store) = app.try_state::<SessionStore>() else {
        return Err(REFUSAL.into());
    };
    remember_lines(&store, &repo, session_id, &fresh)
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

struct StoredCredit {
    row: LedgerRow,
    logged: i64,
}

fn load_row(conn: &Connection, repo: &str, sha: &str) -> Result<Option<StoredCredit>, String> {
    let raw = conn
        .query_row(
            "SELECT tier, chat_id, task_id, agent, file_count, line_count, subject, overlap, logged
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
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((tier, chat, task, agent, files, lines, subject, overlap, logged)) = raw else {
        return Ok(None);
    };
    let Some(tier) = Tier::parse(&tier) else {
        return Err("The stored credit was not readable.".into());
    };
    Ok(Some(StoredCredit {
        row: LedgerRow {
            sha: sha.to_string(),
            tier,
            chat_id: clean_text(chat),
            task_id: clean_text(task),
            agent: clean_text(agent),
            file_count: files.max(0),
            line_count: lines.max(0),
            overlap: overlap.max(0),
            subject: clean_subject(tier, subject),
        },
        logged: if logged == 0 { 0 } else { 1 },
    }))
}

fn save_row(
    conn: &Connection,
    repo: &str,
    incoming: &LedgerRow,
) -> Result<(LedgerRow, Option<Event>), String> {
    let existing = load_row(conn, repo, &incoming.sha)?;
    let merged = logic::merge_ledger(existing.as_ref().map(|stored| &stored.row), incoming);
    // A new person's row is already settled: nothing is owed to the activity log.
    let previous_logged = existing.as_ref().map(|stored| stored.logged).unwrap_or(1);
    let owes_log =
        merged.tier != Tier::Person && merged.chat_id.as_ref().is_some_and(|chat| !chat.is_empty());
    let rank_rose = existing
        .as_ref()
        .is_some_and(|prev| merged.tier.rank() > prev.row.tier.rank());
    // A stronger inferred match names a different chat. The log should say so,
    // and a line that never landed (logged = 0) is tried again.
    let replaced_inference = existing.as_ref().is_some_and(|prev| {
        prev.row.tier == Tier::Inferred
            && merged.tier == Tier::Inferred
            && merged.overlap > prev.row.overlap
            && (merged.chat_id != prev.row.chat_id || merged.task_id != prev.row.task_id)
    });
    let record =
        owes_log && (existing.is_none() || rank_rose || previous_logged == 0 || replaced_inference);
    let logged = if record { 0 } else { previous_logged };
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
           (sha, repo, tier, chat_id, task_id, agent, file_count, line_count, overlap, logged, subject, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(repo, sha) DO UPDATE SET
           tier = excluded.tier,
           chat_id = excluded.chat_id,
           task_id = excluded.task_id,
           agent = excluded.agent,
           file_count = excluded.file_count,
           line_count = excluded.line_count,
           overlap = excluded.overlap,
           logged = excluded.logged,
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
            merged.overlap.max(0),
            logged,
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

/// Mark the credit logged only when the activity row lands. Two windows can both
/// try; the compare-and-swap keeps a single line. A failed insert rolls back, so
/// the next write of the same credit tries again.
fn record_one(conn: &Connection, repo: &str, event: &Event) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            "UPDATE attribution_commits SET logged = 1
             WHERE repo = ?1 AND sha = ?2 AND logged = 0",
            params![repo, event.sha],
        )
        .map_err(|e| {
            let _ = conn.execute_batch("ROLLBACK");
            e.to_string()
        })?;
    if changed == 0 {
        if conn.execute_batch("COMMIT").is_err() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        return Ok(());
    }
    let actor = Who::worker(&event.chat, &event.agent);
    let initiator = if event.tier == Tier::Confirmed {
        Who::worker(&event.chat, &event.agent)
    } else {
        Who::person()
    };
    let summary = logic::commit_line(Some(&event.agent), Some(&event.task_label));
    let link = format!("session:{}", event.chat);
    match activity::record(
        conn,
        "git.commit",
        &actor,
        &initiator,
        repo,
        &event.sha,
        &summary,
        &link,
        now_millis(),
    ) {
        Ok(_) => conn.execute_batch("COMMIT").map_err(|err| {
            let _ = conn.execute_batch("ROLLBACK");
            err.to_string()
        }),
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

fn record_events(store: &SessionStore, repo: &str, events: &[Event]) {
    if events.is_empty() {
        return;
    }
    let Ok(conn) = store.lock_conn() else {
        return;
    };
    for event in events {
        let _ = record_one(&conn, repo, event);
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
        let Some(stored) = load_row(conn, &repo, sha)? else {
            continue;
        };
        let replace = match &best {
            None => true,
            Some(current) => stored.row.tier.rank() > current.tier.rank(),
        };
        if replace && tier == stored.row.tier {
            best = Some(stored.row);
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

pub(crate) fn credits_for_task(
    store: &SessionStore,
    task_id: &str,
    repo: Option<&str>,
) -> Result<Vec<CommitCredit>, String> {
    let Some(task_id) = task_token(task_id) else {
        return Ok(Vec::new());
    };
    let current = rows_for_task(store, task_id)?;
    let Some(repo) = repo.filter(|path| usable_repo(path)) else {
        return Ok(current);
    };
    match refresh(store, Path::new(repo), None) {
        // The refresh writes the newest page. The task's own rows, including a
        // commit older than that page, are what the panel shows.
        Ok(_) => rows_for_task(store, task_id).or(Ok(current)),
        Err(_) => Ok(current),
    }
}

#[tauri::command(async)]
pub fn attribution_for_task(
    store: State<'_, SessionStore>,
    task_id: String,
    repo: Option<String>,
) -> Result<Vec<CommitCredit>, String> {
    credits_for_task(&store, &task_id, repo.as_deref())
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
