//! WP-250: a first mate says which tasks it takes, and a matching task wakes it by itself.
//!
//! The rule is Up.computer's task-agent trigger (github.com/krl-gr/upcomputer, MIT,
//! `packages/tasks-server/src/agents/TaskAgentService.ts` `startsForTask`): an enabled rule takes a task when its
//! project matches (or the rule names none), the task is not trashed, its status is one of the rule's statuses (none
//! listed means any) and it carries every one of the rule's labels (none listed means none required). Hivra adds:
//! - only a task with no assignee is taken, so a person's own task or one already given out never moves;
//! - a task waiting on the person (`needs_you`) is not a brief yet, and a closed one (done or cancelled) is not work;
//! - every rule names one project and a chat that exists; a rule whose chat is gone takes nothing;
//! - a rule with neither statuses nor labels is refused, because it would take every task;
//! - when two rules match, the oldest rule wins (ties by owner), so the answer never depends on row order.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub(crate) const MAX_STATUSES: usize = 20;
pub(crate) const MAX_LABELS: usize = 20;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickupRule {
    /// The first mate's chat id.
    pub owner_session: String,
    /// The project the rule is limited to. A rule always names one; `None` (an older row) takes nothing.
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub statuses: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: i64,
}

fn default_true() -> bool {
    true
}

/// What a rule looks at on a task.
pub(crate) struct Candidate<'a> {
    pub project: &'a str,
    pub status: &'a str,
    pub labels: &'a [String],
    pub assignee: Option<&'a str>,
    pub trashed: bool,
    pub needs_you: bool,
    /// Done or cancelled.
    pub closed: bool,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_pickup_rules (
           owner_session TEXT PRIMARY KEY,
           project_id TEXT,
           statuses TEXT NOT NULL DEFAULT '[]',
           labels TEXT NOT NULL DEFAULT '[]',
           enabled INTEGER NOT NULL DEFAULT 1,
           created_at INTEGER NOT NULL
         );",
    )
}

fn same(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// The trigger itself. Pure, so the ported cases test it without a database.
pub(crate) fn matches(rule: &PickupRule, task: &Candidate<'_>) -> bool {
    if !rule.enabled || task.trashed || task.needs_you || task.closed {
        return false;
    }
    if task.assignee.map(str::trim).is_some_and(|a| !a.is_empty()) {
        return false;
    }
    if rule.statuses.is_empty() && rule.labels.is_empty() {
        return false;
    }
    let Some(project) = rule
        .project
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    else {
        return false;
    };
    if project != task.project.trim() {
        return false;
    }
    if !rule.statuses.is_empty() && !rule.statuses.iter().any(|s| same(s, task.status)) {
        return false;
    }
    rule.labels
        .iter()
        .all(|wanted| task.labels.iter().any(|have| same(have, wanted)))
}

fn clean_list(values: &[String], max: usize, what: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() || out.iter().any(|v| same(v, value)) {
            continue;
        }
        if value.chars().count() > 60 {
            return Err(format!("A {what} name is too long."));
        }
        out.push(value.to_string());
    }
    if out.len() > max {
        return Err(format!("A rule can list at most {max} {what}s."));
    }
    Ok(out)
}

/// Save (or replace) one first mate's rule. A rule that would take every task is refused.
pub(crate) fn put(conn: &Connection, rule: &PickupRule, now: i64) -> Result<PickupRule, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let owner = rule.owner_session.trim();
    if owner == "person" || !crate::watcher::queue::session_ok(owner) || !chat_exists(conn, owner) {
        return Err("Pick a first mate from the list.".into());
    }
    let statuses = clean_list(&rule.statuses, MAX_STATUSES, "status")?;
    let labels = clean_list(&rule.labels, MAX_LABELS, "label")?;
    if statuses.is_empty() && labels.is_empty() {
        return Err(
            "Pick at least one status or label, or this first mate would take every task.".into(),
        );
    }
    let Some(project) = rule
        .project
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
    else {
        return Err("A rule works in one project.".into());
    };
    // A rule keeps the time it was first made, so editing it never moves it behind a newer rule.
    let created_at: i64 = conn
        .query_row(
            "SELECT created_at FROM task_pickup_rules WHERE owner_session = ?1",
            [owner],
            |row| row.get(0),
        )
        .unwrap_or(now);
    conn.execute(
        "INSERT INTO task_pickup_rules (owner_session, project_id, statuses, labels, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(owner_session) DO UPDATE SET project_id = excluded.project_id,
           statuses = excluded.statuses, labels = excluded.labels, enabled = excluded.enabled",
        params![
            owner,
            project,
            serde_json::to_string(&statuses).map_err(|e| e.to_string())?,
            serde_json::to_string(&labels).map_err(|e| e.to_string())?,
            i64::from(rule.enabled),
            created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(PickupRule {
        owner_session: owner.to_string(),
        project: Some(project),
        statuses,
        labels,
        enabled: rule.enabled,
        created_at,
    })
}

pub(crate) fn remove(conn: &Connection, owner: &str) -> Result<(), String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM task_pickup_rules WHERE owner_session = ?1",
        [owner.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Every rule, oldest first (the order a match is decided in).
pub(crate) fn all(conn: &Connection) -> Result<Vec<PickupRule>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT owner_session, project_id, statuses, labels, enabled, created_at
             FROM task_pickup_rules ORDER BY created_at, owner_session",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let statuses: String = row.get(2)?;
            let labels: String = row.get(3)?;
            Ok(PickupRule {
                owner_session: row.get(0)?,
                project: row.get(1)?,
                statuses: serde_json::from_str(&statuses).unwrap_or_default(),
                labels: serde_json::from_str(&labels).unwrap_or_default(),
                enabled: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string());
    rows
}

/// Whether a chat with this id is in the app's store. A deleted chat's rule takes nothing.
fn chat_exists(conn: &Connection, id: &str) -> bool {
    conn.query_row("SELECT 1 FROM sessions WHERE id = ?1", [id], |_| Ok(()))
        .is_ok()
}

/// The first mate that takes this task, if any.
pub(crate) fn taker(conn: &Connection, task: &Candidate<'_>) -> Result<Option<String>, String> {
    Ok(all(conn)?
        .into_iter()
        .find(|rule| matches(rule, task) && chat_exists(conn, &rule.owner_session))
        .map(|rule| rule.owner_session))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(statuses: &[&str], labels: &[&str]) -> PickupRule {
        PickupRule {
            owner_session: "mate-1".into(),
            project: Some("app".into()),
            statuses: statuses.iter().map(|s| s.to_string()).collect(),
            labels: labels.iter().map(|s| s.to_string()).collect(),
            enabled: true,
            created_at: 1,
        }
    }

    fn task<'a>(status: &'a str, labels: &'a [String]) -> Candidate<'a> {
        Candidate {
            project: "app",
            status,
            labels,
            assignee: None,
            trashed: false,
            needs_you: false,
            closed: false,
        }
    }

    fn labels(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    // Ported from Up.computer's TaskTriggerSemantics.test.ts (MIT): statuses are any-of, labels are all-of, empty
    // lists mean "any" and "none required".
    #[test]
    fn statuses_are_any_of_and_labels_all_of() {
        let both = labels(&["bug", "ui"]);
        let one = labels(&["bug"]);
        assert!(matches(
            &rule(&["Todo", "Backlog"], &[]),
            &task("todo", &one)
        ));
        assert!(!matches(&rule(&["Todo"], &[]), &task("In progress", &one)));
        assert!(matches(&rule(&[], &["bug", "ui"]), &task("Done", &both)));
        assert!(!matches(&rule(&[], &["bug", "ui"]), &task("Todo", &one)));
        assert!(matches(&rule(&["Todo"], &["bug"]), &task("Todo", &both)));
    }

    #[test]
    fn a_rule_with_nothing_to_match_takes_nothing() {
        let none = labels(&[]);
        assert!(!matches(&rule(&[], &[]), &task("Todo", &none)));
    }

    #[test]
    fn never_takes_an_assigned_trashed_or_waiting_task() {
        let one = labels(&["bug"]);
        let r = rule(&["Todo"], &[]);
        let mut t = task("Todo", &one);
        t.assignee = Some("person");
        assert!(!matches(&r, &t));
        let mut t = task("Todo", &one);
        t.trashed = true;
        assert!(!matches(&r, &t));
        let mut t = task("Todo", &one);
        t.needs_you = true;
        assert!(!matches(&r, &t));
        // A labels-only rule never takes a done or cancelled task.
        let mut t = task("Cancelled", &one);
        t.closed = true;
        assert!(!matches(&rule(&[], &["bug"]), &t));
        let mut off = r.clone();
        off.enabled = false;
        assert!(!matches(&off, &task("Todo", &one)));
    }

    #[test]
    fn a_rule_takes_only_from_its_own_project() {
        let one = labels(&["bug"]);
        let mut t = task("Todo", &one);
        t.project = "other";
        assert!(!matches(&rule(&["Todo"], &[]), &t));
        // An older row that names no project takes from none.
        let mut any = rule(&["Todo"], &[]);
        any.project = None;
        assert!(!matches(&any, &t));
        assert!(!matches(&any, &task("Todo", &one)));
    }
}
