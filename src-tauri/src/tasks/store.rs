//! Tasks in the app database. Orbit's parent rules (`apps/server/src/repositories/sub_issues.rs`,
//! `validate_parent_in_tx` and `close_ancestors_in_tx`) translated onto rusqlite: Hivra has no sqlx and no project
//! rows, so a missing or trashed parent is the refusal Orbit used for a trashed project. Rule B (close descendants)
//! is not implemented. The duplicate category is not stored.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::mapping::{self, Placement};

pub(crate) const CHANGED: &str = "tasks://changed";

pub(crate) const TITLE_MAX: usize = 300;
pub(crate) const TEXT_MAX: usize = 12_000;
const PROJECT_MAX: usize = 1_000;
/// Caps the ancestor walk only. The cycle check has no bound: a walk SQLite cannot finish is an error.
const DEPTH_MAX: i64 = 1_000;

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_statuses (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           name TEXT NOT NULL,
           category TEXT NOT NULL,
           position INTEGER NOT NULL,
           color TEXT,
           version INTEGER NOT NULL DEFAULT 1,
           UNIQUE (project_id, name)
         );
         CREATE TABLE IF NOT EXISTS project_task_settings (
           project_id TEXT PRIMARY KEY,
           auto_close_parent INTEGER NOT NULL DEFAULT 1,
           next_number INTEGER NOT NULL DEFAULT 1
         );
         CREATE TABLE IF NOT EXISTS tasks (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           number INTEGER NOT NULL,
           title TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '',
           status_id TEXT NOT NULL,
           priority TEXT NOT NULL DEFAULT 'none',
           labels TEXT NOT NULL DEFAULT '[]',
           parent_id TEXT,
           assignee TEXT,
           due_at INTEGER,
           sort_key TEXT NOT NULL,
           version INTEGER NOT NULL DEFAULT 1,
           source TEXT NOT NULL,
           created_by TEXT NOT NULL,
           delegation_id TEXT UNIQUE,
           needs_you INTEGER NOT NULL DEFAULT 0,
           failed INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           trashed_at INTEGER,
           UNIQUE (project_id, number)
         );
         CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
         CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
         CREATE TABLE IF NOT EXISTS task_comments (
           id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL,
           parent_id TEXT,
           author TEXT NOT NULL,
           body TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           version INTEGER NOT NULL DEFAULT 1
         );
         CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments(task_id);
         CREATE TABLE IF NOT EXISTS task_activity (
           id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL,
           at INTEGER NOT NULL,
           kind TEXT NOT NULL,
           text TEXT NOT NULL,
           delegation_id TEXT
         );
         CREATE TABLE IF NOT EXISTS task_emit (
           id TEXT PRIMARY KEY
         );",
    )?;
    // Comments reach a running worker, and an assigned task wakes its first mate. Both tables live with tasks so a
    // unit test that never opened the rest of the app can still write them.
    crate::steering::ensure_tables(conn)?;
    crate::watcher::ensure_tables(conn)?;
    // WP-71: saved views live in the same database as the tasks they show.
    super::views::ensure_tables(conn)?;
    // WP-250: which tasks each first mate takes by itself.
    super::pickup::ensure_tables(conn)?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actor {
    pub id: String,
    pub project: String,
    pub kind: String,
}

#[derive(Clone, Debug, Default)]
pub enum Set<T> {
    #[default]
    Keep,
    Clear,
    Value(T),
}

#[derive(Clone, Debug, Default)]
pub struct CreateInput {
    pub title: String,
    pub description: String,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub labels: Vec<String>,
    pub parent_id: Option<String>,
    pub assignee: Option<String>,
    pub due_at: Option<i64>,
    pub project: Option<String>,
    pub source: Option<String>,
    /// WP-77: set when a GitHub item must wait for the person. Not a brief.
    pub needs_you: bool,
}

#[derive(Clone, Debug, Default)]
pub struct UpdateInput {
    pub id: String,
    pub version: Option<i64>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub labels: Option<Vec<String>>,
    pub parent: Set<String>,
    pub assignee: Set<String>,
    pub due: Set<i64>,
    pub sort_key: Option<String>,
    pub comment: Option<String>,
    pub trash: bool,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub at: i64,
    pub kind: String,
    pub text: String,
    pub delegation_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub number: i64,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub labels: Vec<String>,
    pub parent_id: Option<String>,
    pub assignee: Option<String>,
    pub due_at: Option<i64>,
    pub sort_key: String,
    pub version: i64,
    pub source: String,
    pub created_by: String,
    pub delegation_id: Option<String>,
    pub needs_you: bool,
    pub failed: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub trashed_at: Option<i64>,
    pub comments: Vec<Comment>,
    pub activity: Vec<Activity>,
    /// The worker's CLI (`sessions.harness`). Empty when this task is not an agent's.
    pub cli: Option<String>,
    /// When the delegation started, while it is still going.
    pub working_since: Option<i64>,
    /// `settled_at` once the delegation is completed, cancelled or failed.
    pub finished_at: Option<i64>,
    /// The worker's own chat (`delegations.child_session`).
    pub chat_id: Option<String>,
    /// Set when the task is a labelled GitHub issue or pull request (WP-77).
    pub github_url: Option<String>,
    pub github_paused: bool,
    pub github_pulls: Vec<GithubPull>,
}

/// A pull request linked to a task, other than the task's own GitHub item.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPull {
    pub title: String,
    pub url: String,
    pub state: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub stale: bool,
    pub task: Task,
    /// Task ids a window should reload, including a parent this write closed.
    pub changed: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SyncRequest {
    pub delegation_id: String,
    pub parent_delegation_id: Option<String>,
    pub project: Option<String>,
    pub title: Option<String>,
    pub brief: Option<String>,
    pub state: String,
    pub follow: Option<String>,
    pub gate: Option<String>,
    pub assignee: String,
    pub created_by: String,
    pub updated_at: i64,
    pub task_id: Option<String>,
}

struct Row {
    id: String,
    project_id: String,
    number: i64,
    title: String,
    description: String,
    status_id: String,
    priority: String,
    labels: String,
    parent_id: Option<String>,
    assignee: Option<String>,
    due_at: Option<i64>,
    sort_key: String,
    version: i64,
    source: String,
    created_by: String,
    delegation_id: Option<String>,
    needs_you: i64,
    failed: i64,
    created_at: i64,
    updated_at: i64,
    trashed_at: Option<i64>,
}

const COLS: &str = "id, project_id, number, title, description, status_id, priority, labels, parent_id, assignee, \
     due_at, sort_key, version, source, created_by, delegation_id, needs_you, failed, created_at, updated_at, trashed_at";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: row.get(0)?,
        project_id: row.get(1)?,
        number: row.get(2)?,
        title: row.get(3)?,
        description: row.get(4)?,
        status_id: row.get(5)?,
        priority: row.get(6)?,
        labels: row.get(7)?,
        parent_id: row.get(8)?,
        assignee: row.get(9)?,
        due_at: row.get(10)?,
        sort_key: row.get(11)?,
        version: row.get(12)?,
        source: row.get(13)?,
        created_by: row.get(14)?,
        delegation_id: row.get(15)?,
        needs_you: row.get(16)?,
        failed: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        trashed_at: row.get(20)?,
    })
}

fn cap(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn parse_labels(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn priority_read(raw: &str) -> String {
    match raw {
        "none" | "low" | "medium" | "high" | "urgent" => raw.to_string(),
        _ => "none".to_string(),
    }
}

fn source_read(raw: &str) -> String {
    match raw {
        "person" | "agent" | "github" => raw.to_string(),
        _ => "person".to_string(),
    }
}

fn category_read(raw: &str) -> &str {
    match raw {
        "unstarted" | "started" | "completed" | "cancelled" => raw,
        _ => "unstarted",
    }
}

fn closed(category: &str) -> bool {
    matches!(category_read(category), "completed" | "cancelled")
}

fn new_id(prefix: &str) -> String {
    let id = uuid::Uuid::new_v4().simple();
    format!("{prefix}-{id}")
}

pub(crate) fn actor_ok(actor: &Actor, creating: bool) -> Result<(), String> {
    if actor.id.trim().is_empty() {
        return Err("Say who is asking.".into());
    }
    if actor.kind != "person" && actor.kind != "agent" {
        return Err("Unknown kind.".into());
    }
    if actor.project.trim().is_empty() {
        return Err(if creating {
            "Name the project this task belongs to.".into()
        } else {
            "Name the project.".into()
        });
    }
    Ok(())
}

fn check_priority(value: &str) -> Result<(), String> {
    if matches!(value, "none" | "low" | "medium" | "high" | "urgent") {
        Ok(())
    } else {
        Err("Unknown priority.".into())
    }
}

fn check_source(value: &str) -> Result<(), String> {
    if matches!(value, "person" | "agent" | "github") {
        Ok(())
    } else {
        Err("Unknown source.".into())
    }
}

fn clean_labels(labels: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for label in labels {
        let label = label.trim();
        if label.is_empty() {
            continue;
        }
        if label.chars().count() > 80 {
            return Err("A label is too long.".into());
        }
        if !out.iter().any(|kept: &String| kept == label) {
            out.push(label.to_string());
        }
        if out.len() > 50 {
            return Err("Too many labels.".into());
        }
    }
    Ok(out)
}

fn title_ok(value: &str) -> Result<String, String> {
    let title = value.trim();
    if title.is_empty() {
        return Err("The title is empty.".into());
    }
    if title.chars().count() > TITLE_MAX {
        return Err("The title is too long.".into());
    }
    Ok(title.to_string())
}

fn description_ok(value: &str) -> Result<String, String> {
    if value.chars().count() > TEXT_MAX {
        return Err("The description is too long.".into());
    }
    Ok(value.to_string())
}

fn load(conn: &Connection, id: &str) -> Result<Option<Row>, String> {
    conn.query_row(
        &format!("SELECT {COLS} FROM tasks WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn load_in_project(conn: &Connection, actor: &Actor, id: &str) -> Result<Row, String> {
    match load(conn, id)? {
        Some(row) if row.project_id == actor.project => Ok(row),
        _ => Err("No task with that id.".into()),
    }
}

fn status_named(conn: &Connection, project: &str, name: &str) -> Result<(String, String), String> {
    conn.query_row(
        "SELECT id, category FROM task_statuses WHERE project_id = ?1 AND name = ?2",
        params![project, name],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("No status called {name}."))
}

fn status_name(conn: &Connection, id: &str) -> Result<String, String> {
    Ok(conn
        .query_row(
            "SELECT name FROM task_statuses WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "Backlog".to_string()))
}

fn category_of(conn: &Connection, status_id: &str) -> Result<String, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT category FROM task_statuses WHERE id = ?1",
            [status_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(category_read(raw.as_deref().unwrap_or("unstarted")).to_string())
}

fn ensure_workflow(conn: &Connection, project: &str) -> Result<(), String> {
    let seeded = [
        ("Backlog", "unstarted", 0_i64),
        ("Todo", "unstarted", 1),
        ("In progress", "started", 0),
        ("In review", "started", 1),
        ("Done", "completed", 0),
        ("Cancelled", "cancelled", 0),
    ];
    for (name, category, position) in seeded {
        conn.execute(
            "INSERT OR IGNORE INTO task_statuses (id, project_id, name, category, position, color, version)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, 1)",
            params![new_id("ts"), project, name, category, position],
        )
        .map_err(|e| e.to_string())?;
    }
    // INSERT OR IGNORE so a project that turned auto-close off is not switched back on.
    conn.execute(
        "INSERT OR IGNORE INTO project_task_settings (project_id, auto_close_parent, next_number) VALUES (?1, 1, 1)",
        [project],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn alloc_number(conn: &Connection, project: &str) -> Result<i64, String> {
    ensure_workflow(conn, project)?;
    let number: i64 = conn
        .query_row(
            "SELECT next_number FROM project_task_settings WHERE project_id = ?1",
            [project],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE project_task_settings SET next_number = next_number + 1 WHERE project_id = ?1",
        [project],
    )
    .map_err(|e| e.to_string())?;
    Ok(number)
}

fn project_of(input: Option<&str>, actor: &Actor) -> Result<String, String> {
    let named = input.map(str::trim).filter(|p| !p.is_empty());
    if actor.kind == "agent" {
        if named.is_some_and(|p| p != actor.project) {
            return Err("That project isn't this chat's.".into());
        }
        return Ok(cap(actor.project.trim(), PROJECT_MAX));
    }
    Ok(cap(named.unwrap_or(actor.project.trim()), PROJECT_MAX))
}

/// A parent must be a live task in the same project, and not this task or one of its descendants.
fn validate_parent(
    conn: &Connection,
    project: &str,
    task_id: Option<&str>,
    parent_id: &str,
) -> Result<(), String> {
    if task_id == Some(parent_id) {
        return Err("A task can't be a sub-task of itself or of its own sub-tasks.".into());
    }
    let parent: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT project_id, trashed_at FROM tasks WHERE id = ?1",
            [parent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((parent_project, trashed)) = parent else {
        return Err("That parent task isn't available anymore.".into());
    };
    if trashed.is_some() || parent_project != project {
        return Err("That parent task isn't available anymore.".into());
    }
    let Some(task_id) = task_id else {
        return Ok(());
    };
    // UNION, not UNION ALL, so a repeated id stops the walk. A walk SQLite cannot finish is an error, not a free pass.
    let cycle: i64 = conn
        .query_row(
            "WITH RECURSIVE chain(id) AS (
               SELECT ?1
               UNION
               SELECT tasks.parent_id FROM tasks
               JOIN chain ON tasks.id = chain.id
               WHERE tasks.parent_id IS NOT NULL
             )
             SELECT EXISTS (SELECT 1 FROM chain WHERE id = ?2)",
            params![parent_id, task_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if cycle != 0 {
        return Err("A task can't be a sub-task of itself or of its own sub-tasks.".into());
    }
    Ok(())
}

fn comments_of(conn: &Connection, task_id: &str) -> Result<Vec<Comment>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, author, body, created_at FROM task_comments WHERE task_id = ?1 ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([task_id], |row| {
            Ok(Comment {
                id: row.get(0)?,
                author: row.get(1)?,
                body: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn missing_table(error: &rusqlite::Error) -> bool {
    error.to_string().contains("no such table")
}

fn work_activity(conn: &Connection, delegation_id: &str) -> Result<Vec<Activity>, String> {
    let raw = conn.query_row(
        "SELECT log FROM delegations WHERE id = ?1",
        [delegation_id],
        |row| row.get::<_, String>(0),
    );
    let raw = match raw {
        Ok(raw) => raw,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(Vec::new()),
        Err(error) if missing_table(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str(&raw) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(at) = item.get("at").and_then(serde_json::Value::as_i64) else {
            continue;
        };
        let Some(text) = item.get("event").and_then(serde_json::Value::as_str) else {
            continue;
        };
        out.push(Activity {
            id: format!("log-{delegation_id}-{index}"),
            at,
            kind: "work".into(),
            text: text.to_string(),
            delegation_id: Some(delegation_id.to_string()),
        });
    }
    Ok(out)
}

fn activity_of(conn: &Connection, row: &Row) -> Result<Vec<Activity>, String> {
    let mut stmt = conn
        .prepare("SELECT id, at, kind, text, delegation_id FROM task_activity WHERE task_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut out = stmt
        .query_map([&row.id], |row| {
            Ok(Activity {
                id: row.get(0)?,
                at: row.get(1)?,
                kind: row.get(2)?,
                text: row.get(3)?,
                delegation_id: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if let Some(delegation_id) = &row.delegation_id {
        out.extend(work_activity(conn, delegation_id)?);
    }
    out.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
    Ok(out)
}

struct Work {
    cli: Option<String>,
    working_since: Option<i64>,
    finished_at: Option<i64>,
    chat_id: Option<String>,
}

/// CLI, working time and the worker chat. A missing delegations table, or no row, is empty rather than a failure.
fn work_of(conn: &Connection, delegation_id: Option<&str>) -> Result<Work, String> {
    let empty = Work {
        cli: None,
        working_since: None,
        finished_at: None,
        chat_id: None,
    };
    let Some(id) = delegation_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(empty);
    };
    let raw = conn.query_row(
        "SELECT d.state, d.created_at, d.settled_at, d.child_session, s.harness
         FROM delegations d LEFT JOIN sessions s ON s.id = d.child_session
         WHERE d.id = ?1",
        [id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        },
    );
    let (state, created_at, settled_at, child, harness) = match raw {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(empty),
        Err(error) if missing_table(&error) => return Ok(empty),
        Err(error) => return Err(error.to_string()),
    };
    let finished = matches!(state.as_str(), "completed" | "cancelled" | "failed");
    let cli = harness
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let chat = child.trim();
    Ok(Work {
        cli,
        working_since: if finished { None } else { Some(created_at) },
        finished_at: if finished { settled_at } else { None },
        chat_id: if chat.is_empty() {
            None
        } else {
            Some(chat.to_string())
        },
    })
}

fn present(conn: &Connection, row: &Row, full: bool) -> Result<Task, String> {
    let work = work_of(conn, row.delegation_id.as_deref())?;
    let github = crate::github_issues::shown(conn, &row.id)?;
    Ok(Task {
        id: row.id.clone(),
        project_id: row.project_id.clone(),
        number: row.number,
        title: row.title.clone(),
        description: row.description.clone(),
        status: status_name(conn, &row.status_id)?,
        priority: priority_read(&row.priority),
        labels: parse_labels(&row.labels),
        parent_id: row.parent_id.clone(),
        assignee: row.assignee.clone(),
        due_at: row.due_at,
        sort_key: row.sort_key.clone(),
        version: row.version,
        source: source_read(&row.source),
        created_by: row.created_by.clone(),
        delegation_id: row.delegation_id.clone(),
        needs_you: row.needs_you != 0,
        failed: row.failed != 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
        trashed_at: row.trashed_at,
        comments: if full {
            comments_of(conn, &row.id)?
        } else {
            Vec::new()
        },
        activity: if full {
            activity_of(conn, row)?
        } else {
            Vec::new()
        },
        cli: work.cli,
        working_since: work.working_since,
        finished_at: work.finished_at,
        chat_id: work.chat_id,
        github_url: github.url,
        github_paused: github.paused,
        github_pulls: github
            .pulls
            .into_iter()
            .map(|pull| GithubPull {
                title: pull.title,
                url: pull.url,
                state: pull.state,
            })
            .collect(),
    })
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusRow {
    /// The status name. `tasks_update` looks a status up by name, so the board sends this back as `status`.
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub category: String,
    pub position: i64,
    pub color: String,
}

/// Statuses for this project only. Another project's workflow is not a column here.
pub fn statuses(conn: &Connection, actor: &Actor) -> Result<Vec<StatusRow>, String> {
    actor_ok(actor, false)?;
    let project = actor.project.trim();
    ensure_workflow(conn, project)?;
    let mut stmt = conn
        .prepare(
            "SELECT project_id, name, category, position, color FROM task_statuses WHERE project_id = ?1 ORDER BY position, name",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![project], |row| {
            let name: String = row.get(1)?;
            Ok(StatusRow {
                id: name.clone(),
                project_id: row.get(0)?,
                name,
                category: row.get(2)?,
                position: row.get(3)?,
                color: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn note_change(
    conn: &Connection,
    id: &str,
    changed: &mut Vec<String>,
    outbox: bool,
) -> Result<(), String> {
    if !changed.iter().any(|kept| kept == id) {
        changed.push(id.to_string());
    }
    if outbox {
        conn.execute("INSERT OR IGNORE INTO task_emit (id) VALUES (?1)", [id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn auto_close_on(conn: &Connection, project: &str) -> Result<bool, String> {
    let flag: Option<i64> = conn
        .query_row(
            "SELECT auto_close_parent FROM project_task_settings WHERE project_id = ?1",
            [project],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(flag.unwrap_or(1) != 0)
}

fn child_counts(conn: &Connection, parent_id: &str) -> Result<(i64, i64, i64), String> {
    conn.query_row(
        "SELECT COUNT(*),
            COALESCE(SUM(CASE WHEN task_statuses.category NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN task_statuses.category = 'completed' THEN 1 ELSE 0 END), 0)
         FROM tasks JOIN task_statuses ON task_statuses.id = tasks.status_id
         WHERE tasks.parent_id = ?1 AND tasks.trashed_at IS NULL",
        [parent_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .map_err(|e| e.to_string())
}

/// Rule A, walking upward. An open parent closes when every live child is closed and at least one is completed.
pub(crate) fn close_ancestors(
    conn: &Connection,
    start: &str,
    now: i64,
    changed: &mut Vec<String>,
    outbox: bool,
) -> Result<(), String> {
    let mut parent_id = start.to_string();
    for _ in 0..DEPTH_MAX {
        let Some(parent) = load(conn, &parent_id)? else {
            return Ok(());
        };
        if parent.trashed_at.is_some() {
            return Ok(());
        }
        let category = category_of(conn, &parent.status_id)?;
        if !auto_close_on(conn, &parent.project_id)? || closed(&category) {
            return Ok(());
        }
        let (total, open, completed) = child_counts(conn, &parent.id)?;
        if total == 0 || open > 0 || completed == 0 {
            return Ok(());
        }
        let (target, _) = status_named(conn, &parent.project_id, "Done")?;
        let updated = conn
            .execute(
                "UPDATE tasks SET status_id = ?2, version = version + 1, updated_at = ?3
                 WHERE id = ?1 AND trashed_at IS NULL",
                params![parent.id, target, now],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO task_activity (id, task_id, at, kind, text, delegation_id) VALUES (?1, ?2, ?3, 'work', 'sub_issues_done', NULL)",
            params![new_id("a"), parent.id, now],
        )
        .map_err(|e| e.to_string())?;
        note_change(conn, &parent.id, changed, outbox)?;
        match parent.parent_id {
            Some(next) => parent_id = next,
            None => return Ok(()),
        }
    }
    Ok(())
}

fn trash_subtree(
    conn: &Connection,
    parent_id: &str,
    now: i64,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "WITH RECURSIVE sub(id) AS (
               SELECT id FROM tasks WHERE parent_id = ?1
               UNION
               SELECT tasks.id FROM tasks JOIN sub ON tasks.parent_id = sub.id
             )
             SELECT id FROM sub",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([parent_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for id in ids {
        let updated = conn
            .execute(
                "UPDATE tasks SET trashed_at = ?2, version = version + 1, updated_at = ?2
                 WHERE id = ?1 AND trashed_at IS NULL",
                params![id, now],
            )
            .map_err(|e| e.to_string())?;
        if updated == 1 {
            changed.push(id);
        }
    }
    Ok(())
}

/// WP-77: a GitHub task's brief keeps the issue text in a data frame. Any other task is the short line.
fn pickup_text(source: &str, number: i64, title: &str, description: &str) -> String {
    if source == "github" {
        crate::github_issues::brief::pickup(number, title, description)
    } else {
        format!("pick up task #{number}")
    }
}

fn wake(conn: &Connection, owner: &str, key: &str, text: &str, now: i64) -> Result<(), String> {
    if owner == "person" || !crate::watcher::queue::session_ok(owner) {
        return Ok(());
    }
    // One wake per assignee. A later assignee still hears it; the same one does not hear it twice.
    let already: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM firstmate_wakes WHERE owner_session = ?1 AND key = ?2",
            params![owner, key],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if already > 0 {
        return Ok(());
    }
    crate::watcher::queue::add_in(
        conn,
        crate::watcher::queue::WakeInput {
            owner_session: owner.to_string(),
            kind: "note".into(),
            key: key.to_string(),
            text: text.to_string(),
            ..Default::default()
        },
        now,
    )?;
    Ok(())
}

/// WP-250: an unassigned task that a first mate's pickup rule matches is given to that first mate, noted in the task's
/// activity, and wakes it once (the same wake key as a person's assignment, so it is never heard twice).
fn pick_up_by_rule(
    conn: &Connection,
    id: &str,
    now: i64,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    let Some(row) = load(conn, id)? else {
        return Ok(());
    };
    if row.assignee.is_some() || row.delegation_id.is_some() {
        return Ok(());
    }
    let status = status_name(conn, &row.status_id)?;
    let labels = parse_labels(&row.labels);
    let candidate = super::pickup::Candidate {
        project: &row.project_id,
        status: &status,
        labels: &labels,
        assignee: row.assignee.as_deref(),
        trashed: row.trashed_at.is_some(),
        needs_you: row.needs_you != 0,
    };
    let Some(owner) = super::pickup::taker(conn, &candidate)? else {
        return Ok(());
    };
    let updated = conn
        .execute(
            "UPDATE tasks SET assignee = ?1, version = version + 1, updated_at = ?2
             WHERE id = ?3 AND assignee IS NULL",
            params![owner, now, row.id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO task_activity (id, task_id, at, kind, text, delegation_id) VALUES (?1, ?2, ?3, 'pickup', ?4, NULL)",
        params![new_id("act"), row.id, now, "Picked up by rule"],
    )
    .map_err(|e| e.to_string())?;
    if !changed.iter().any(|c| c == &row.id) {
        changed.push(row.id.clone());
    }
    wake(
        conn,
        &owner,
        &format!("task-pickup:{}", row.id),
        &pickup_text(
            &source_read(&row.source),
            row.number,
            &row.title,
            &row.description,
        ),
        now,
    )
}

fn delegation_parties(conn: &Connection, id: &str) -> Result<Option<(String, String)>, String> {
    match conn.query_row(
        "SELECT owner_session, child_session FROM delegations WHERE id = ?1",
        [id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ) {
        Ok(pair) => Ok(Some(pair)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) if missing_table(&error) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn comment_text(body: &str, number: i64, delegated: bool) -> Result<String, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("The comment is empty.".into());
    }
    if delegated {
        let prefixed = format!(
            "Comment on task #{number} (this is a comment on the task, not a new instruction):\n{body}"
        );
        if prefixed.chars().count() > crate::steering::TEXT_MAX {
            return Err("That comment is too long to send on.".into());
        }
    } else if body.chars().count() > crate::steering::TEXT_MAX {
        return Err("The comment is too long.".into());
    }
    Ok(body.to_string())
}

fn add_comment(
    conn: &Connection,
    row: &Row,
    author: &str,
    body: &str,
    now: i64,
) -> Result<(), String> {
    let parties = row
        .delegation_id
        .as_deref()
        .map(|id| delegation_parties(conn, id))
        .transpose()?
        .flatten();
    let body = comment_text(body, row.number, parties.is_some())?;
    let id = new_id("c");
    conn.execute(
        "INSERT INTO task_comments (id, task_id, parent_id, author, body, created_at, version)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, 1)",
        params![id, row.id, author, body, now],
    )
    .map_err(|e| e.to_string())?;
    if let Some((owner, child)) = parties {
        let prefixed = format!(
            "Comment on task #{} (this is a comment on the task, not a new instruction):\n{body}",
            row.number
        );
        crate::steering::record(
            conn,
            crate::steering::SteerInput {
                owner_session: owner.clone(),
                child_session: child,
                delegation_id: row.delegation_id.clone(),
                request_id: id.clone(),
                text: prefixed,
                mode: Some("auto".into()),
                source: Some("first-mate".into()),
                decision_key: None,
            },
            now,
        )?;
        let number = row.number;
        wake(
            conn,
            &owner,
            &format!("task-comment:{id}"),
            &format!("A comment on task #{number}"),
            now,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn author_fields(
    row: &Row,
    next_title: &str,
    next_description: &str,
    next_priority: &str,
    next_labels: &[String],
    next_parent: &Option<String>,
    next_assignee: &Option<String>,
    next_due: Option<i64>,
    next_sort: &str,
) -> bool {
    next_title != row.title
        || next_description != row.description
        || next_priority != priority_read(&row.priority)
        || next_labels != parse_labels(&row.labels).as_slice()
        || next_parent != &row.parent_id
        || next_assignee != &row.assignee
        || next_due != row.due_at
        || next_sort != row.sort_key
}

#[allow(clippy::too_many_arguments)]
fn check_agent_edit(
    actor: &Actor,
    row: &Row,
    next_title: &str,
    next_description: &str,
    next_priority: &str,
    next_labels: &[String],
    next_parent: &Option<String>,
    next_assignee: &Option<String>,
    next_due: Option<i64>,
    next_sort: &str,
    status_changed: bool,
    trash: bool,
    source: &Option<String>,
) -> Result<(), String> {
    if actor.kind != "agent" {
        return Ok(());
    }
    if trash {
        return Err("An agent doesn't trash a task.".into());
    }
    if source.is_some() {
        return Err("An agent can't set where a task came from.".into());
    }
    if author_fields(
        row,
        next_title,
        next_description,
        next_priority,
        next_labels,
        next_parent,
        next_assignee,
        next_due,
        next_sort,
    ) && row.created_by != actor.id
    {
        return Err("You can comment, or change the status. The wording is the author's.".into());
    }
    if status_changed && row.delegation_id.is_some() {
        return Err("This task follows its work.".into());
    }
    Ok(())
}

fn apply_set<T: Clone>(current: &Option<T>, update: &Set<T>) -> Option<T> {
    match update {
        Set::Keep => current.clone(),
        Set::Clear => None,
        Set::Value(value) => Some(value.clone()),
    }
}

pub fn list(conn: &Connection, actor: &Actor) -> Result<Vec<Task>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    actor_ok(actor, false)?;
    ensure_workflow(conn, actor.project.trim())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLS} FROM tasks WHERE project_id = ?1 AND trashed_at IS NULL ORDER BY sort_key, number"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([actor.project.trim()], from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.iter().map(|row| present(conn, row, false)).collect()
}

pub fn get(conn: &Connection, actor: &Actor, id: &str) -> Result<Task, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    actor_ok(actor, false)?;
    let row = load_in_project(conn, actor, id)?;
    present(conn, &row, true)
}

fn insert_row(conn: &Connection, row: &Row) -> Result<(), String> {
    conn.execute(
        "INSERT INTO tasks (
           id, project_id, number, title, description, status_id, priority, labels, parent_id, assignee, due_at,
           sort_key, version, source, created_by, delegation_id, needs_you, failed, created_at, updated_at, trashed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            row.id, row.project_id, row.number, row.title, row.description, row.status_id, row.priority, row.labels,
            row.parent_id, row.assignee, row.due_at, row.sort_key, row.version, row.source, row.created_by,
            row.delegation_id, row.needs_you, row.failed, row.created_at, row.updated_at, row.trashed_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn create_in(
    conn: &Connection,
    actor: &Actor,
    input: &CreateInput,
    now: i64,
) -> Result<Written, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    actor_ok(actor, true)?;
    let project = project_of(input.project.as_deref(), actor)?;
    ensure_workflow(conn, &project)?;
    if actor.kind == "agent" && input.source.is_some() {
        return Err("An agent can't set where a task came from.".into());
    }
    let status_name = match (actor.kind.as_str(), input.status.as_deref()) {
        ("agent", Some(name)) if mapping::mapped(name) => {
            return Err("This status follows the work. Agents don't set it.".into());
        }
        (_, Some(name)) => name,
        _ => "Backlog",
    };
    let (status_id, _) = status_named(conn, &project, status_name)?;
    let title = title_ok(&input.title)?;
    let description = description_ok(&input.description)?;
    let priority = input.priority.as_deref().unwrap_or("none");
    check_priority(priority)?;
    let labels = clean_labels(&input.labels)?;
    if let Some(parent) = input
        .parent_id
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        validate_parent(conn, &project, None, parent)?;
    }
    let source = if actor.kind == "agent" {
        "agent".to_string()
    } else {
        let source = input.source.clone().unwrap_or_else(|| "person".into());
        check_source(&source)?;
        source
    };
    let number = alloc_number(conn, &project)?;
    let parent_id = input
        .parent_id
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    let assignee = input
        .assignee
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(str::to_string);
    let id = new_id("task");
    let row = Row {
        id: id.clone(),
        project_id: project,
        number,
        title,
        description,
        status_id,
        priority: priority.to_string(),
        labels: serde_json::to_string(&labels).map_err(|e| e.to_string())?,
        parent_id: parent_id.clone(),
        assignee: assignee.clone(),
        due_at: input.due_at,
        sort_key: format!("{number:08}"),
        version: 1,
        source,
        created_by: actor.id.trim().to_string(),
        delegation_id: None,
        needs_you: i64::from(input.needs_you),
        failed: 0,
        created_at: now,
        updated_at: now,
        trashed_at: None,
    };
    insert_row(conn, &row)?;
    let mut changed = vec![id];
    if closed(&category_of(conn, &row.status_id)?) {
        if let Some(parent) = &parent_id {
            close_ancestors(conn, parent, now, &mut changed, false)?;
        }
    }
    // WP-77: a GitHub task that is waiting on the person is not a brief.
    if actor.kind == "person" && !input.needs_you {
        if let Some(assignee) = &assignee {
            let id = &row.id;
            wake(
                conn,
                assignee,
                &format!("task-pickup:{id}"),
                &pickup_text(&row.source, number, &row.title, &row.description),
                now,
            )?;
        }
    }
    pick_up_by_rule(conn, &row.id, now, &mut changed)?;
    let stored = load(conn, &row.id)?.ok_or_else(|| "No task with that id.".to_string())?;
    Ok(Written {
        stale: false,
        task: present(conn, &stored, true)?,
        changed,
    })
}

pub fn create(
    conn: &mut Connection,
    actor: &Actor,
    input: &CreateInput,
    now: i64,
) -> Result<Written, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let written = create_in(&tx, actor, input, now)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(written)
}

pub(crate) fn update_in(
    conn: &Connection,
    actor: &Actor,
    input: &UpdateInput,
    now: i64,
) -> Result<Written, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    actor_ok(actor, true)?;
    let row = load_in_project(conn, actor, input.id.trim())?;
    if row.trashed_at.is_some() {
        return Err("That task isn't available anymore.".into());
    }
    let next_title = match &input.title {
        Some(title) => title_ok(title)?,
        None => row.title.clone(),
    };
    let next_description = match &input.description {
        Some(description) => description_ok(description)?,
        None => row.description.clone(),
    };
    // WP-77: GitHub owns the title and description of a linked task.
    if source_read(&row.source) == "github"
        && (next_title != row.title || next_description != row.description)
    {
        return Err("GitHub controls this task's title and description.".into());
    }
    let next_priority = match &input.priority {
        Some(priority) => {
            check_priority(priority)?;
            priority.clone()
        }
        None => priority_read(&row.priority),
    };
    let next_labels = match &input.labels {
        Some(labels) => clean_labels(labels)?,
        None => parse_labels(&row.labels),
    };
    let next_parent = match &input.parent {
        Set::Keep => row.parent_id.clone(),
        Set::Clear => None,
        Set::Value(parent) => {
            let parent = parent.trim();
            if parent.is_empty() {
                None
            } else {
                validate_parent(conn, &row.project_id, Some(&row.id), parent)?;
                Some(parent.to_string())
            }
        }
    };
    let next_assignee = match &input.assignee {
        Set::Keep => row.assignee.clone(),
        Set::Clear => None,
        Set::Value(assignee) => {
            let assignee = assignee.trim();
            if assignee.is_empty() {
                None
            } else {
                Some(assignee.to_string())
            }
        }
    };
    let next_due = apply_set(&row.due_at, &input.due);
    let next_sort = match &input.sort_key {
        Some(key) => {
            let key = key.trim();
            if key.is_empty() {
                row.sort_key.clone()
            } else {
                cap(key, 200)
            }
        }
        None => row.sort_key.clone(),
    };
    let next_source = match &input.source {
        Some(source) => {
            check_source(source)?;
            source.clone()
        }
        None => source_read(&row.source),
    };
    let next_status_id = match &input.status {
        Some(name) => status_named(conn, &row.project_id, name)?.0,
        None => row.status_id.clone(),
    };
    let status_changed = next_status_id != row.status_id;
    check_agent_edit(
        actor,
        &row,
        &next_title,
        &next_description,
        &next_priority,
        &next_labels,
        &next_parent,
        &next_assignee,
        next_due,
        &next_sort,
        status_changed,
        input.trash,
        &input.source,
    )?;
    let parent_changed = next_parent != row.parent_id;
    let assignee_changed = next_assignee != row.assignee;
    let fields_changed = author_fields(
        &row,
        &next_title,
        &next_description,
        &next_priority,
        &next_labels,
        &next_parent,
        &next_assignee,
        next_due,
        &next_sort,
    ) || status_changed
        || next_source != source_read(&row.source)
        || input.trash;
    let mut changed = Vec::new();
    if fields_changed {
        let Some(version) = input.version else {
            return Err("Say which version you read.".into());
        };
        let trashed_at = if input.trash {
            Some(now)
        } else {
            row.trashed_at
        };
        let updated = conn
            .execute(
                "UPDATE tasks SET title = ?2, description = ?3, status_id = ?4, priority = ?5, labels = ?6,
                   parent_id = ?7, assignee = ?8, due_at = ?9, sort_key = ?10, source = ?11, trashed_at = ?12,
                   updated_at = ?13, version = version + 1
                 WHERE id = ?1 AND version = ?14",
                params![
                    row.id, next_title, next_description, next_status_id, next_priority,
                    serde_json::to_string(&next_labels).map_err(|e| e.to_string())?,
                    next_parent, next_assignee, next_due, next_sort, next_source, trashed_at, now, version,
                ],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            let current =
                load(conn, &row.id)?.ok_or_else(|| "No task with that id.".to_string())?;
            return Ok(Written {
                stale: true,
                task: present(conn, &current, true)?,
                changed,
            });
        }
        changed.push(row.id.clone());
        if input.trash {
            trash_subtree(conn, &row.id, now, &mut changed)?;
            if let Some(parent) = &row.parent_id {
                close_ancestors(conn, parent, now, &mut changed, false)?;
            }
        } else {
            let was_closed = closed(&category_of(conn, &row.status_id)?);
            let now_closed = closed(&category_of(conn, &next_status_id)?);
            if now_closed {
                if let Some(parent) = &next_parent {
                    close_ancestors(conn, parent, now, &mut changed, false)?;
                }
            }
            if was_closed && parent_changed {
                if let Some(old) = &row.parent_id {
                    close_ancestors(conn, old, now, &mut changed, false)?;
                }
            }
        }
    }
    // A stale field write returned above, so a comment here belongs to a write that was kept.
    if let Some(comment) = &input.comment {
        let fresh = load(conn, &row.id)?.ok_or_else(|| "No task with that id.".to_string())?;
        add_comment(conn, &fresh, actor.id.trim(), comment, now)?;
        if !changed.iter().any(|id| id == &row.id) {
            changed.push(row.id.clone());
        }
    }
    if actor.kind == "person" && assignee_changed {
        if let Some(assignee) = &next_assignee {
            // WP-77: the person picking up a GitHub task ends the hold.
            if source_read(&row.source) == "github" {
                conn.execute(
                    "UPDATE tasks SET needs_you = 0 WHERE id = ?1 AND needs_you != 0",
                    [&row.id],
                )
                .map_err(|e| e.to_string())?;
            }
            let id = &row.id;
            let number = row.number;
            wake(
                conn,
                assignee,
                &format!("task-pickup:{id}"),
                &pickup_text(
                    &source_read(&row.source),
                    number,
                    &next_title,
                    &next_description,
                ),
                now,
            )?;
        }
    }
    // A write that sets or clears the assignee is the person's own choice; a rule never undoes it.
    if !input.trash && matches!(input.assignee, Set::Keep) {
        pick_up_by_rule(conn, &row.id, now, &mut changed)?;
    }
    let stored = load(conn, &row.id)?.ok_or_else(|| "No task with that id.".to_string())?;
    Ok(Written {
        stale: false,
        task: present(conn, &stored, true)?,
        changed,
    })
}

pub fn update(
    conn: &mut Connection,
    actor: &Actor,
    input: &UpdateInput,
    now: i64,
) -> Result<Written, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let written = update_in(&tx, actor, input, now)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(written)
}

fn placement_of(req: &SyncRequest) -> Placement {
    mapping::place(mapping::phase_of(
        &req.state,
        req.follow.as_deref(),
        req.gate.as_deref(),
    ))
}

fn sync_title(title: Option<&str>, brief: Option<&str>) -> String {
    let chosen = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .or_else(|| {
            brief.and_then(|text| {
                let line = text.split(['\n', '\r']).next().unwrap_or("").trim();
                if line.is_empty() {
                    None
                } else {
                    Some(line.to_string())
                }
            })
        });
    cap(chosen.as_deref().unwrap_or("Untitled"), TITLE_MAX)
}

fn sync_project(project: Option<&str>) -> String {
    let trimmed = project.unwrap_or("").trim();
    cap(
        if trimmed.is_empty() { "none" } else { trimmed },
        PROJECT_MAX,
    )
}

fn parent_of_delegation(
    conn: &Connection,
    project: &str,
    parent_delegation: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(parent_delegation) = parent_delegation else {
        return Ok(None);
    };
    let found: Option<(String, String, Option<i64>)> = conn
        .query_row(
            "SELECT id, project_id, trashed_at FROM tasks WHERE delegation_id = ?1",
            [parent_delegation],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(found.and_then(|(id, parent_project, trashed)| {
        if trashed.is_some() || parent_project != project {
            None
        } else {
            Some(id)
        }
    }))
}

fn apply_placement(
    conn: &Connection,
    row: &Row,
    req: &SyncRequest,
    placement: Placement,
    now: i64,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    let (mut status_id, mut category) = status_named(conn, &row.project_id, placement.status)?;
    // WP-77: a merged pull request, or a GitHub state that already closed the task, is not undone by a running delegation.
    if crate::github_issues::terminal_hold(conn, &row.id)? && !closed(&category) {
        status_id = row.status_id.clone();
        category = category_of(conn, &row.status_id)?;
    }
    let needs = i64::from(placement.needs_you);
    let failed = i64::from(placement.failed);
    let link_new = row.delegation_id.as_deref() != Some(req.delegation_id.as_str());
    if !link_new && row.status_id == status_id && row.needs_you == needs && row.failed == failed {
        return Ok(());
    }
    conn.execute(
        "UPDATE tasks SET status_id = ?2, needs_you = ?3, failed = ?4, delegation_id = ?5,
           version = version + 1, updated_at = ?6 WHERE id = ?1",
        params![row.id, status_id, needs, failed, req.delegation_id, now],
    )
    .map_err(|e| e.to_string())?;
    note_change(conn, &row.id, changed, true)?;
    if closed(&category) {
        if let Some(parent) = &row.parent_id {
            close_ancestors(conn, parent, now, changed, true)?;
        }
    }
    Ok(())
}

fn link_existing(
    conn: &Connection,
    req: &SyncRequest,
    now: i64,
    changed: &mut Vec<String>,
) -> Result<(), String> {
    let Some(task_id) = req.task_id.as_deref() else {
        return Ok(());
    };
    let Some(row) = load(conn, task_id)? else {
        return Err("No task with that id.".into());
    };
    if row.trashed_at.is_some() {
        return Err("That task isn't available anymore.".into());
    }
    if sync_project(req.project.as_deref()) != row.project_id {
        return Err("That task is in another project.".into());
    }
    let holder: Option<String> = conn
        .query_row(
            "SELECT id FROM tasks WHERE delegation_id = ?1",
            [&req.delegation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if holder.is_some_and(|id| id != row.id) {
        return Err("This work already has a task.".into());
    }
    if row
        .delegation_id
        .as_ref()
        .is_some_and(|id| id != &req.delegation_id)
    {
        return Err("That task already follows other work.".into());
    }
    ensure_workflow(conn, &row.project_id)?;
    apply_placement(conn, &row, req, placement_of(req), now, changed)
}

fn sync_in(conn: &Connection, req: &SyncRequest) -> Result<(), String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let now = req.updated_at;
    let mut changed = Vec::new();
    if req.task_id.is_some() {
        return link_existing(conn, req, now, &mut changed);
    }
    if let Some(existing) = conn
        .query_row(
            "SELECT id FROM tasks WHERE delegation_id = ?1",
            [&req.delegation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        let row = load(conn, &existing)?.ok_or_else(|| "No task with that id.".to_string())?;
        ensure_workflow(conn, &row.project_id)?;
        return apply_placement(conn, &row, req, placement_of(req), now, &mut changed);
    }
    let project = sync_project(req.project.as_deref());
    ensure_workflow(conn, &project)?;
    let placement = placement_of(req);
    let (status_id, category) = status_named(conn, &project, placement.status)?;
    let number = alloc_number(conn, &project)?;
    let parent_id = parent_of_delegation(conn, &project, req.parent_delegation_id.as_deref())?;
    let brief = req.brief.as_deref().unwrap_or("");
    let row = Row {
        id: new_id("task"),
        project_id: project,
        number,
        title: sync_title(req.title.as_deref(), req.brief.as_deref()),
        description: cap(brief, TEXT_MAX),
        status_id,
        priority: "none".into(),
        labels: "[]".into(),
        parent_id,
        assignee: {
            let assignee = req.assignee.trim();
            if assignee.is_empty() {
                None
            } else {
                Some(cap(assignee, 256))
            }
        },
        due_at: None,
        sort_key: format!("{number:08}"),
        version: 1,
        source: "agent".into(),
        created_by: cap(req.created_by.trim(), 256),
        delegation_id: Some(req.delegation_id.clone()),
        needs_you: i64::from(placement.needs_you),
        failed: i64::from(placement.failed),
        created_at: now,
        updated_at: now,
        trashed_at: None,
    };
    insert_row(conn, &row)?;
    note_change(conn, &row.id, &mut changed, true)?;
    if closed(&category) {
        if let Some(parent) = &row.parent_id {
            close_ancestors(conn, parent, now, &mut changed, true)?;
        }
    }
    Ok(())
}

pub fn sync_delegation(conn: &Connection, req: &SyncRequest) -> Result<(), String> {
    // `save` holds `&Connection` inside the caller's transaction. Begin only when nothing is open, so this never nests.
    if conn.is_autocommit() {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = sync_in(conn, req);
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    } else {
        sync_in(conn, req)
    }
}

/// Task ids changed since the last drain. Missing tables are nothing to say, not a failure of the delegation write.
pub fn drain_emits(conn: &mut Connection) -> Result<Vec<String>, String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'task_emit'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(Vec::new());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare("SELECT id FROM task_emit")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    if !ids.is_empty() {
        tx.execute("DELETE FROM task_emit", [])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ids)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
