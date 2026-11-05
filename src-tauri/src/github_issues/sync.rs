// Translated from Orbit (Apache-2.0), `sync_github_work_item` and the webhook's label match.
// rusqlite, one task per repository and number, no webhook. A labelled pull request still drops
// only its own row in `github_pull_links`: a crew pull request on a different task has to stay, so
// that pull request's merge can complete the issue. See the root NOTICE.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use crate::session_store::SessionStore;
use crate::tasks::store::{self, Actor, CreateInput, Set, UpdateInput};
use crate::watcher::queue::session_ok;

use super::gh::{self, IssuesGh, ItemRead, PullView, Snapshot};
use super::rules::{self, Choice, Reject};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub enabled: bool,
    pub label: String,
    pub repo: Option<String>,
    pub version: i64,
    pub stale: bool,
    pub note: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Assignee {
    pub project: String,
    pub assignee: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub polled: i64,
    pub waiting: i64,
    pub failed: i64,
    #[serde(skip)]
    pub changed: Vec<String>,
}

#[derive(Clone, Debug)]
struct Saved {
    project_id: String,
    enabled: bool,
    label: String,
    repo: Option<String>,
    assignee: Option<String>,
    version: i64,
    idle_streak: i64,
    last_fingerprint: Option<String>,
}

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS github_issue_settings (
           project_id TEXT PRIMARY KEY,
           enabled INTEGER NOT NULL DEFAULT 0,
           label TEXT NOT NULL DEFAULT 'hivra',
           repo TEXT,
           assignee TEXT,
           version INTEGER NOT NULL DEFAULT 0,
           next_poll_at INTEGER,
           idle_streak INTEGER NOT NULL DEFAULT 0,
           last_fingerprint TEXT
         );
         CREATE TABLE IF NOT EXISTS github_issue_links (
           repository TEXT NOT NULL,
           issue_number INTEGER NOT NULL,
           kind TEXT NOT NULL,
           project_id TEXT NOT NULL,
           task_id TEXT NOT NULL UNIQUE,
           sync_paused INTEGER NOT NULL DEFAULT 0,
           pull_state TEXT,
           PRIMARY KEY (repository, issue_number)
         );
         CREATE TABLE IF NOT EXISTS github_pull_links (
           repository TEXT NOT NULL,
           pull_number INTEGER NOT NULL,
           task_id TEXT NOT NULL,
           project_id TEXT NOT NULL,
           title TEXT NOT NULL,
           url TEXT NOT NULL,
           state TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (repository, pull_number, task_id)
         );",
    )
}

fn missing_table(error: &rusqlite::Error) -> bool {
    error.to_string().contains("no such table")
}

fn blank_setting() -> Setting {
    Setting {
        enabled: false,
        label: "hivra".into(),
        repo: None,
        version: 0,
        stale: false,
        note: None,
    }
}

fn project_ok(project: &str) -> Result<String, String> {
    let project = project.trim();
    if project.is_empty() {
        return Err("Name the project.".into());
    }
    if project.chars().count() > 1_000 {
        return Err("That project path is too long.".into());
    }
    Ok(project.to_string())
}

fn load(conn: &Connection, project: &str) -> Result<Option<Saved>, String> {
    conn.query_row(
        "SELECT project_id, enabled, label, repo, assignee, version, idle_streak, last_fingerprint
         FROM github_issue_settings WHERE project_id = ?1",
        [project],
        |row| {
            Ok(Saved {
                project_id: row.get(0)?,
                enabled: row.get::<_, i64>(1)? != 0,
                label: row.get(2)?,
                repo: row.get(3)?,
                assignee: row.get(4)?,
                version: row.get(5)?,
                idle_streak: row.get(6)?,
                last_fingerprint: row.get(7)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn view_of(saved: &Saved) -> Setting {
    Setting {
        enabled: saved.enabled,
        label: saved.label.clone(),
        repo: saved.repo.clone(),
        version: saved.version,
        stale: false,
        note: None,
    }
}

pub fn get_setting(conn: &Connection, project: &str) -> Result<Setting, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let project = project_ok(project)?;
    Ok(load(conn, &project)?
        .map(|saved| view_of(&saved))
        .unwrap_or_else(blank_setting))
}

/// What the person asked to save. An omitted label keeps the stored one, or `hivra` on a first save.
#[derive(Clone, Copy)]
pub struct SettingWrite<'a> {
    pub enabled: bool,
    pub label: Option<&'a str>,
    pub repo: Option<&'a str>,
    pub assignee: Option<&'a str>,
    pub expected_version: i64,
}

pub fn set_setting(
    conn: &mut Connection,
    project: &str,
    write: SettingWrite<'_>,
    gh: &mut dyn IssuesGh,
) -> Result<Setting, String> {
    let SettingWrite {
        enabled,
        label,
        repo,
        assignee,
        expected_version,
    } = write;
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let project = project_ok(project)?;
    let current = load(conn, &project)?;
    let version = current.as_ref().map(|row| row.version).unwrap_or(0);
    if version != expected_version {
        let mut setting = current.as_ref().map(view_of).unwrap_or_else(blank_setting);
        setting.stale = true;
        setting.note = Some("That changed. Showing the latest.".into());
        return Ok(setting);
    }
    let label = match label.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => rules::label_ok(value)?,
        None => current
            .as_ref()
            .map(|row| row.label.clone())
            .unwrap_or_else(|| "hivra".into()),
    };
    rules::label_ok(&label)?;
    let repo = if let Some(repo) = repo.map(str::trim).filter(|value| !value.is_empty()) {
        Some(rules::repo_ok(repo)?)
    } else if enabled {
        match current.as_ref().and_then(|row| row.repo.clone()) {
            Some(repo) => Some(repo),
            None => {
                let json = gh.view_repo(&project)?;
                Some(gh::parse_repo(&json)?)
            }
        }
    } else {
        current.as_ref().and_then(|row| row.repo.clone())
    };
    if enabled && repo.is_none() {
        return Err("Couldn't read this project's GitHub repo.".into());
    }
    let assignee = assignee
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if session_ok(value) {
                Ok(value.to_string())
            } else {
                Err("That chat can't take a task.".to_string())
            }
        })
        .transpose()?
        .or_else(|| current.as_ref().and_then(|row| row.assignee.clone()));
    let next = version + 1;
    conn.execute(
        "INSERT INTO github_issue_settings (
           project_id, enabled, label, repo, assignee, version, next_poll_at, idle_streak, last_fingerprint
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 0, NULL)
         ON CONFLICT(project_id) DO UPDATE SET
           enabled = excluded.enabled,
           label = excluded.label,
           repo = excluded.repo,
           assignee = COALESCE(excluded.assignee, github_issue_settings.assignee),
           version = excluded.version,
           next_poll_at = NULL,
           idle_streak = 0,
           last_fingerprint = NULL
         WHERE github_issue_settings.version = ?7",
        params![project, i64::from(enabled), label, repo, assignee, next, version],
    )
    .map_err(|e| e.to_string())?;
    let saved = load(conn, &project)?.ok_or_else(|| "The setting didn't save.".to_string())?;
    if saved.version != next {
        let mut setting = view_of(&saved);
        setting.stale = true;
        setting.note = Some("That changed. Showing the latest.".into());
        return Ok(setting);
    }
    Ok(view_of(&saved))
}

/// Whether turning the setting on has to ask `gh` for the repo. A stale write does not:
/// the read would hold nothing the save can use. A bad label fails here, before `gh`.
fn repo_lookup_needed(
    conn: &Connection,
    project: &str,
    write: &SettingWrite<'_>,
) -> Result<bool, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let project = project_ok(project)?;
    let current = load(conn, &project)?;
    let version = current.as_ref().map(|row| row.version).unwrap_or(0);
    if version != write.expected_version {
        return Ok(false);
    }
    let label = match write.label.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => rules::label_ok(value)?,
        None => current
            .as_ref()
            .map(|row| row.label.clone())
            .unwrap_or_else(|| "hivra".into()),
    };
    rules::label_ok(&label)?;
    if write
        .repo
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return Ok(false);
    }
    if !write.enabled {
        return Ok(false);
    }
    Ok(current.as_ref().and_then(|row| row.repo.clone()).is_none())
}

/// Save a setting without holding the database lock across `gh repo view`.
pub fn save_setting(
    store: &SessionStore,
    project: &str,
    write: SettingWrite<'_>,
    gh: &mut dyn IssuesGh,
) -> Result<Setting, String> {
    let project = project.trim();
    let needs = {
        let conn = store.lock_conn()?;
        repo_lookup_needed(&conn, project, &write)?
    };
    let fetched = if needs {
        let json = gh.view_repo(project)?;
        Some(gh::parse_repo(&json)?)
    } else {
        None
    };
    let write = SettingWrite {
        repo: fetched.as_deref().or(write.repo),
        ..write
    };
    let mut conn = store.lock_conn()?;
    set_setting(&mut conn, project, write, gh)
}

/// The pull request the crew opened, linked to its task. A failure here must not fail the open.
pub fn link_opened_pr(
    conn: &Connection,
    delegation_id: &str,
    repo: &str,
    number: i64,
    url: Option<&str>,
    now: i64,
) -> Result<(), String> {
    if delegation_id.trim().is_empty() || number <= 0 {
        return Ok(());
    }
    let Ok(repo) = rules::repo_ok(repo) else {
        return Ok(());
    };
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let found: Option<(String, String, String)> = conn
        .query_row(
            "SELECT id, project_id, title FROM tasks WHERE delegation_id = ?1 AND trashed_at IS NULL",
            [delegation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((task_id, project_id, title)) = found else {
        return Ok(());
    };
    let url = url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| rules::work_url(&repo, "pull_request", number))
        .unwrap_or_default();
    conn.execute(
        "INSERT INTO github_pull_links (
           repository, pull_number, task_id, project_id, title, url, state, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7)
         ON CONFLICT(repository, pull_number, task_id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           updated_at = excluded.updated_at
         WHERE github_pull_links.state != 'merged'",
        params![repo, number, task_id, project_id, title, url, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn poll(
    store: &SessionStore,
    gh: &mut dyn IssuesGh,
    now: i64,
    assignees: &[Assignee],
) -> Result<Report, String> {
    let mut report = Report::default();
    {
        let conn = store.lock_conn()?;
        ensure_tables(&conn).map_err(|e| e.to_string())?;
        note_assignees(&conn, assignees, now, &mut report.changed)?;
    }
    let due = {
        let conn = store.lock_conn()?;
        due_projects(&conn, now)?
    };
    for project in due {
        let claimed = {
            let conn = store.lock_conn()?;
            claim(&conn, &project, now)?
        };
        if !claimed {
            report.waiting += 1;
            continue;
        }
        let Some(saved) = ({
            let conn = store.lock_conn()?;
            load(&conn, &project)?
        }) else {
            continue;
        };
        if !saved.enabled {
            continue;
        }
        let Some(repo) = saved.repo.clone() else {
            continue;
        };
        match read_labelled(gh, &saved.label, &repo) {
            Ok(board) => {
                let pulls = {
                    let conn = store.lock_conn()?;
                    open_pulls(&conn, &repo)?
                };
                let mut views = Vec::new();
                for number in pulls {
                    let Ok(json) = gh.view_pr(&repo, number) else {
                        continue;
                    };
                    if let Ok(view) = gh::parse_pull_view(&json, number) {
                        views.push(view);
                    }
                }
                let mut conn = store.lock_conn()?;
                let changed = apply(
                    &mut conn,
                    &saved,
                    &board.issues,
                    &board.prs,
                    &views,
                    board.truncated,
                    now,
                )?;
                report.changed.extend(changed);
                report.polled += 1;
            }
            Err(_) => {
                // A timeout or a dead `gh` is not a final failure: the setting stays on, links stay.
                report.failed += 1;
            }
        }
    }
    Ok(report)
}

fn note_assignees(
    conn: &Connection,
    assignees: &[Assignee],
    now: i64,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    for row in assignees {
        let Ok(project) = project_ok(&row.project) else {
            continue;
        };
        let assignee = row.assignee.trim();
        if !session_ok(assignee) {
            continue;
        }
        conn.execute(
            "UPDATE github_issue_settings SET assignee = ?2
             WHERE project_id = ?1 AND IFNULL(assignee, '') != ?2",
            params![project, assignee],
        )
        .map_err(|e| e.to_string())?;
        fill_assignee(conn, &project, assignee, now, changed)?;
    }
    Ok(())
}

fn fill_assignee(
    conn: &Connection,
    project: &str,
    assignee: &str,
    now: i64,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, version FROM tasks
             WHERE project_id = ?1 AND source = 'github' AND assignee IS NULL AND trashed_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (id, version) in rows {
        let written = assign_unlinked(conn, project, &id, version, assignee, now)?;
        if !written.stale {
            push(changed, &id);
        }
    }
    Ok(())
}

/// Assignee and its wake commit together. A poll that is already inside a transaction just writes.
fn assign_unlinked(
    conn: &Connection,
    project: &str,
    id: &str,
    version: i64,
    assignee: &str,
    now: i64,
) -> Result<store::Written, String> {
    let write = |conn: &Connection| {
        store::update_in(
            conn,
            &person(project),
            &UpdateInput {
                id: id.to_string(),
                version: Some(version),
                assignee: Set::Value(assignee.to_string()),
                ..Default::default()
            },
            now,
        )
    };
    if !conn.is_autocommit() {
        return write(conn);
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    match write(conn) {
        Ok(written) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(written)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn due_projects(conn: &Connection, now: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT project_id FROM github_issue_settings
             WHERE enabled = 1 AND (next_poll_at IS NULL OR next_poll_at <= ?1)
             ORDER BY project_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([now], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn claim(conn: &Connection, project: &str, now: i64) -> Result<bool, String> {
    let until = now.saturating_add(rules::MIN_POLL_MS);
    let updated = conn
        .execute(
            "UPDATE github_issue_settings SET next_poll_at = ?3
             WHERE project_id = ?1 AND enabled = 1 AND (next_poll_at IS NULL OR next_poll_at <= ?2)",
            params![project, now, until],
        )
        .map_err(|e| e.to_string())?;
    Ok(updated == 1)
}

struct Board {
    issues: Vec<ItemRead>,
    prs: Vec<ItemRead>,
    /// The page came back full, so a linked number that is missing may still be labelled.
    truncated: bool,
}

fn read_labelled(gh: &mut dyn IssuesGh, label: &str, repo: &str) -> Result<Board, String> {
    let issues = gh.list("issue", repo, &rules::search_query("issue", label)?)?;
    let prs = gh.list("pr", repo, &rules::search_query("pull_request", label)?)?;
    let issues = gh::parse_list(&issues, "issue")?;
    let prs = gh::parse_list(&prs, "pr")?;
    let truncated = issues.len() >= gh::LIST_LIMIT || prs.len() >= gh::LIST_LIMIT;
    Ok(Board {
        issues,
        prs,
        truncated,
    })
}

fn open_pulls(conn: &Connection, repo: &str) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT pull_number FROM github_pull_links
             WHERE repository = ?1 AND state != 'merged' ORDER BY pull_number",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([repo], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

struct Link {
    task_id: String,
    kind: String,
    project_id: String,
    pull_state: Option<String>,
}

fn find_link(conn: &Connection, repo: &str, number: i64) -> Result<Option<Link>, String> {
    conn.query_row(
        "SELECT task_id, kind, project_id, pull_state FROM github_issue_links
         WHERE repository = ?1 AND issue_number = ?2",
        params![repo, number],
        |row| {
            Ok(Link {
                task_id: row.get(0)?,
                kind: row.get(1)?,
                project_id: row.get(2)?,
                pull_state: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn enabled_projects(conn: &Connection, repo: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT project_id, label FROM github_issue_settings WHERE enabled = 1 AND repo = ?1 ORDER BY project_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([repo], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn person(project: &str) -> Actor {
    Actor {
        id: "github".into(),
        project: project.into(),
        kind: "person".into(),
    }
}

fn push(changed: &mut Vec<String>, id: &str) {
    if !changed.iter().any(|kept| kept == id) {
        changed.push(id.to_string());
    }
}

fn apply(
    conn: &mut Connection,
    read: &Saved,
    issues: &[ItemRead],
    prs: &[ItemRead],
    views: &[PullView],
    truncated: bool,
    now: i64,
) -> Result<Vec<String>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(current) = load(&tx, &read.project_id)? else {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(Vec::new());
    };
    // The read is stale: the setting changed while `gh` was out. Don't write tasks from it.
    if !current.enabled
        || current.label != read.label
        || current.repo != read.repo
        || current.version != read.version
    {
        tx.execute(
            "UPDATE github_issue_settings SET next_poll_at = ?2 WHERE project_id = ?1",
            params![read.project_id, now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(Vec::new());
    }
    let repo = current.repo.clone().unwrap_or_default();
    let projects = enabled_projects(&tx, &repo)?;
    let mut changed = Vec::new();
    let mut seen = HashSet::new();
    let mut hold = HashSet::new();
    let mut synced = Vec::new();
    for item in issues.iter().chain(prs.iter()) {
        match item {
            ItemRead::Ignored => {}
            ItemRead::Unreadable(row) => {
                // A row we could not read is not "label removed". Hold it so the task stays.
                if let (Some(number), false) = (row.number, row.kind.is_empty()) {
                    hold.insert((row.kind.clone(), number));
                }
            }
            ItemRead::Item(snapshot) => {
                synced.push(snapshot.clone());
                consider(
                    &tx,
                    &current,
                    snapshot,
                    &projects,
                    now,
                    &mut Marks {
                        seen: &mut seen,
                        hold: &mut hold,
                        changed: &mut changed,
                    },
                )?;
            }
        }
    }
    // A full page is not the whole board. Pausing whatever fell off would mark a
    // still-labelled issue as if the label had been removed.
    if !truncated {
        pause_missing(&tx, &current.project_id, &repo, &seen, &hold, &mut changed)?;
    }
    apply_pulls(&tx, &repo, views, now, &mut changed)?;
    let fingerprint = fingerprint_of(&synced, views);
    let unchanged = current.last_fingerprint.as_deref() == Some(fingerprint.as_str());
    let streak = if unchanged {
        current.idle_streak.saturating_add(1)
    } else {
        0
    };
    let next = now.saturating_add(rules::gap_after(streak));
    tx.execute(
        "UPDATE github_issue_settings SET next_poll_at = ?2, idle_streak = ?3, last_fingerprint = ?4
         WHERE project_id = ?1",
        params![current.project_id, next, streak, fingerprint],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

struct Marks<'a> {
    seen: &'a mut HashSet<(String, i64)>,
    hold: &'a mut HashSet<(String, i64)>,
    changed: &'a mut Vec<String>,
}

fn consider(
    conn: &Connection,
    setting: &Saved,
    item: &Snapshot,
    projects: &[(String, String)],
    now: i64,
    marks: &mut Marks<'_>,
) -> Result<(), String> {
    let key = (item.kind.clone(), item.number);
    let ours = item.labels.iter().any(|label| label == &setting.label);
    if !ours {
        return Ok(());
    }
    let matched: Vec<&str> = projects
        .iter()
        .filter(|(_, label)| item.labels.iter().any(|got| got == label))
        .map(|(project, _)| project.as_str())
        .collect();
    if rules::chosen_project(&matched) != Choice::One(setting.project_id.as_str()) {
        // Ambiguous, or no longer ours alone: leave the task where it is.
        marks.seen.insert(key);
        return Ok(());
    }
    match rules::accept_text(&item.title, &item.description) {
        Err(Reject::EmptyTitle | Reject::TitleTooLong | Reject::DescriptionTooLong) => {
            marks.hold.insert(key);
            Ok(())
        }
        Ok((title, description)) => {
            marks.seen.insert(key);
            sync_item(
                conn,
                setting,
                item,
                &title,
                &description,
                now,
                marks.changed,
            )
        }
    }
}

fn sync_item(
    conn: &Connection,
    setting: &Saved,
    item: &Snapshot,
    title: &str,
    description: &str,
    now: i64,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    let repo = setting.repo.clone().unwrap_or_default();
    if let Some(link) = find_link(conn, &repo, item.number)? {
        let task = task_row(conn, &link.task_id)?;
        let Some(task) = task else {
            conn.execute(
                "DELETE FROM github_issue_links WHERE task_id = ?1",
                [&link.task_id],
            )
            .map_err(|e| e.to_string())?;
            return create_linked(conn, setting, item, title, description, now, changed);
        };
        if task.project_id != setting.project_id
            || link.project_id != setting.project_id
            || link.kind != item.kind
        {
            return Ok(());
        }
        let was_deleted = task.trashed_at.is_some();
        let changed_state = rules::state_changed(link.pull_state.as_deref(), &item.state);
        let status_id = if changed_state || was_deleted {
            status_for(conn, &setting.project_id, &item.kind, &item.state)?
                .unwrap_or(task.status_id.clone())
        } else {
            task.status_id.clone()
        };
        let updated = conn
            .execute(
                "UPDATE tasks SET title = ?2, description = ?3, status_id = ?4, trashed_at = NULL,
                   updated_at = ?5, version = version + 1
                 WHERE id = ?1 AND (trashed_at IS NOT NULL OR title != ?2 OR description != ?3 OR status_id != ?4)",
                params![task.id, title, description, status_id, now],
            )
            .map_err(|e| e.to_string())?;
        let mut parent = task.parent_id.clone();
        if was_deleted {
            if let Some(parent_id) = &parent {
                if !parent_live(conn, parent_id)? {
                    conn.execute(
                        "UPDATE tasks SET parent_id = NULL WHERE id = ?1",
                        [&task.id],
                    )
                    .map_err(|e| e.to_string())?;
                    parent = None;
                }
            }
        }
        if updated > 0 {
            push(changed, &task.id);
            if closed_status(conn, &status_id)? {
                if let Some(parent_id) = &parent {
                    store::close_ancestors(conn, parent_id, now, changed, false)?;
                }
            }
        }
        conn.execute(
            "UPDATE github_issue_links SET sync_paused = 0, pull_state = ?1, project_id = ?2
             WHERE repository = ?3 AND issue_number = ?4",
            params![item.state, setting.project_id, repo, item.number],
        )
        .map_err(|e| e.to_string())?;
        drop_own_pull_link(conn, &repo, item)?;
        return Ok(());
    }
    create_linked(conn, setting, item, title, description, now, changed)
}

fn task_row(conn: &Connection, id: &str) -> Result<Option<TaskBits>, String> {
    conn.query_row(
        "SELECT id, project_id, status_id, parent_id, trashed_at FROM tasks WHERE id = ?1",
        [id],
        |row| {
            Ok(TaskBits {
                id: row.get(0)?,
                project_id: row.get(1)?,
                status_id: row.get(2)?,
                parent_id: row.get(3)?,
                trashed_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

struct TaskBits {
    id: String,
    project_id: String,
    status_id: String,
    parent_id: Option<String>,
    trashed_at: Option<i64>,
}

fn parent_live(conn: &Connection, id: &str) -> Result<bool, String> {
    let trashed: Option<Option<i64>> = conn
        .query_row("SELECT trashed_at FROM tasks WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(matches!(trashed, Some(None)))
}

fn status_for(
    conn: &Connection,
    project: &str,
    kind: &str,
    state: &str,
) -> Result<Option<String>, String> {
    let name = rules::status_name(rules::status_category(kind, state));
    conn.query_row(
        "SELECT id FROM task_statuses WHERE project_id = ?1 AND name = ?2",
        params![project, name],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn closed_status(conn: &Connection, status_id: &str) -> Result<bool, String> {
    let category: Option<String> = conn
        .query_row(
            "SELECT category FROM task_statuses WHERE id = ?1",
            [status_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(matches!(
        category.as_deref(),
        Some("completed" | "cancelled")
    ))
}

fn drop_own_pull_link(conn: &Connection, repo: &str, item: &Snapshot) -> Result<(), String> {
    if item.kind != "pull_request" {
        return Ok(());
    }
    if let Some(link) = find_link(conn, repo, item.number)? {
        conn.execute(
            "DELETE FROM github_pull_links WHERE repository = ?1 AND pull_number = ?2 AND task_id = ?3",
            params![repo, item.number, link.task_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn create_linked(
    conn: &Connection,
    setting: &Saved,
    item: &Snapshot,
    title: &str,
    description: &str,
    now: i64,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    let repo = setting.repo.clone().unwrap_or_default();
    let status = rules::status_name(rules::status_category(&item.kind, &item.state));
    let assignee = setting.assignee.clone().filter(|value| session_ok(value));
    let written = store::create_in(
        conn,
        &person(&setting.project_id),
        &CreateInput {
            title: title.to_string(),
            description: description.to_string(),
            status: Some(status.to_string()),
            labels: vec!["GitHub".into()],
            assignee,
            source: Some("github".into()),
            ..Default::default()
        },
        now,
    )?;
    let task_id = written.task.id;
    conn.execute(
        "INSERT INTO github_issue_links (
           repository, issue_number, kind, project_id, task_id, sync_paused, pull_state
         ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        params![
            repo,
            item.number,
            item.kind,
            setting.project_id,
            task_id,
            item.state
        ],
    )
    .map_err(|e| e.to_string())?;
    drop_own_pull_link(conn, &repo, item)?;
    for id in written.changed {
        push(changed, &id);
    }
    Ok(())
}

fn pause_missing(
    conn: &Connection,
    project: &str,
    repo: &str,
    seen: &HashSet<(String, i64)>,
    hold: &HashSet<(String, i64)>,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT issue_number, kind, task_id FROM github_issue_links
             WHERE project_id = ?1 AND repository = ?2 AND sync_paused = 0",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project, repo], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (number, _kind, task_id) in rows {
        // GitHub shares one number between an issue and a pull request, so a
        // kind mismatch is the same item. Pausing it would look like the label left.
        let present = |set: &HashSet<(String, i64)>| set.iter().any(|(_, n)| *n == number);
        if present(seen) || present(hold) {
            continue;
        }
        let paused = conn
            .execute(
                "UPDATE github_issue_links SET sync_paused = 1
                 WHERE repository = ?1 AND issue_number = ?2 AND project_id = ?3 AND sync_paused = 0",
                params![repo, number, project],
            )
            .map_err(|e| e.to_string())?;
        if paused > 0 {
            push(changed, &task_id);
        }
    }
    Ok(())
}

fn apply_pulls(
    conn: &Connection,
    repo: &str,
    views: &[PullView],
    now: i64,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    for view in views {
        let mut stmt = conn
            .prepare(
                "SELECT task_id, project_id FROM github_pull_links
                 WHERE repository = ?1 AND pull_number = ?2 AND state != 'merged'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![repo, view.number], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        for (task_id, project_id) in rows {
            let title = if view.title.is_empty() {
                "Pull request".to_string()
            } else {
                view.title.clone()
            };
            conn.execute(
                "UPDATE github_pull_links SET state = ?3, title = ?4, url = ?5, updated_at = ?6
                 WHERE repository = ?1 AND pull_number = ?2 AND task_id = ?7",
                params![repo, view.number, view.state, title, view.url, now, task_id],
            )
            .map_err(|e| e.to_string())?;
            // A merged crew pull request completes the task. Closed unmerged does not.
            // The issue can stay open, so a later poll sees no state change and will not
            // close this parent. Rule A runs here, while the child has just become Done.
            if view.state == "merged" {
                if let Some(status_id) = status_for(conn, &project_id, "issue", "closed")? {
                    let updated = conn
                        .execute(
                            "UPDATE tasks SET status_id = ?2, updated_at = ?3, version = version + 1
                             WHERE id = ?1 AND trashed_at IS NULL AND status_id != ?2",
                            params![task_id, status_id, now],
                        )
                        .map_err(|e| e.to_string())?;
                    if updated > 0 {
                        push(changed, &task_id);
                    }
                }
                if let Some(task) = task_row(conn, &task_id)? {
                    if task.trashed_at.is_none() && closed_status(conn, &task.status_id)? {
                        if let Some(parent_id) = task.parent_id {
                            store::close_ancestors(conn, &parent_id, now, changed, false)?;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn fingerprint_of(items: &[Snapshot], views: &[PullView]) -> String {
    let mut items = items.to_vec();
    items.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then(a.number.cmp(&b.number))
            .then(a.title.cmp(&b.title))
    });
    let mut out = String::new();
    for item in items {
        let mut labels = item.labels.clone();
        labels.sort();
        out.push_str(&item.kind);
        out.push('\t');
        out.push_str(&item.number.to_string());
        out.push('\t');
        out.push_str(&item.state);
        out.push('\t');
        out.push_str(&item.title);
        out.push('\t');
        out.push_str(&item.description);
        out.push('\t');
        out.push_str(&labels.join(","));
        out.push('\n');
    }
    let mut views = views.to_vec();
    views.sort_by_key(|view| view.number);
    for view in views {
        out.push_str(&format!("pull\t{}\t{}\n", view.number, view.state));
    }
    out
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShownPull {
    pub title: String,
    pub url: String,
    pub state: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    pub url: Option<String>,
    pub paused: bool,
    pub pulls: Vec<ShownPull>,
}

pub fn shown(conn: &Connection, task_id: &str) -> Result<Shown, String> {
    let link = match conn.query_row(
        "SELECT repository, issue_number, kind, sync_paused FROM github_issue_links WHERE task_id = ?1",
        [task_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)),
    ) {
        Ok(row) => Some(row),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(error) if missing_table(&error) => return Ok(Shown { url: None, paused: false, pulls: Vec::new() }),
        Err(error) => return Err(error.to_string()),
    };
    let (url, paused) = match link {
        Some((repo, number, kind, paused)) => (rules::work_url(&repo, &kind, number), paused != 0),
        None => (None, false),
    };
    let pulls = match pull_rows(conn, task_id, url.as_deref()) {
        Ok(rows) => rows,
        Err(error) if error.contains("no such table") => Vec::new(),
        Err(error) => return Err(error),
    };
    Ok(Shown { url, paused, pulls })
}

fn pull_rows(
    conn: &Connection,
    task_id: &str,
    source: Option<&str>,
) -> Result<Vec<ShownPull>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT title, url, state FROM github_pull_links WHERE task_id = ?1 ORDER BY pull_number, url",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([task_id], |row| {
            Ok(ShownPull {
                title: row.get(0)?,
                url: row.get(1)?,
                state: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|row| Some(row.url.as_str()) != source)
        .collect())
}

/// GitHub has already closed this task, so a running delegation must not move it back.
pub fn terminal_hold(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let link = match conn.query_row(
        "SELECT kind, pull_state, sync_paused FROM github_issue_links WHERE task_id = ?1",
        [task_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    ) {
        Ok(row) => Some(row),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(error) if missing_table(&error) => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if let Some((kind, state, paused)) = link {
        if paused == 0 {
            if let Some(state) = state {
                let category = rules::status_category(&kind, &state);
                if category == "completed" || category == "cancelled" {
                    return Ok(true);
                }
            }
        }
    }
    let merged: i64 = match conn.query_row(
        "SELECT COUNT(*) FROM github_pull_links WHERE task_id = ?1 AND state = 'merged'",
        [task_id],
        |row| row.get(0),
    ) {
        Ok(count) => count,
        Err(error) if missing_table(&error) => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    Ok(merged > 0)
}
