//! Crew rules, the attempt ledger and usage-limit holds. A delegation row is not given a new column:
//! `delegations` is positional upstream. Two windows compare-and-swap the revision, and a hold is claimed
//! before a resume, so a late tick cannot reopen a row the other window already took.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::budget::normalize_failure_policy;
use super::reroute::{decide, Attempt, Decision, FailureInput};
use super::resolve::{resolve_route, Pick, Presence, Route};
use super::rules::{self, Rule};

const MAX_RULES: usize = 40;
const MAX_ITEMS: usize = 32;
const MAX_ITEM: usize = 200;
const CONFLICT: &str = "Someone else saved these rules. Reload and try again.";

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS crew_rule_meta (
           scope TEXT NOT NULL,
           scope_id TEXT NOT NULL,
           budget TEXT,
           revision INTEGER NOT NULL,
           PRIMARY KEY (scope, scope_id)
         );
         CREATE TABLE IF NOT EXISTS crew_rules (
           scope TEXT NOT NULL,
           scope_id TEXT NOT NULL,
           position INTEGER NOT NULL,
           labels TEXT NOT NULL,
           paths TEXT NOT NULL,
           cli TEXT,
           model TEXT,
           effort TEXT,
           PRIMARY KEY (scope, scope_id, position)
         );
         CREATE TABLE IF NOT EXISTS crew_attempts (
           delegation_id TEXT NOT NULL,
           n INTEGER NOT NULL,
           at INTEGER NOT NULL,
           cli TEXT,
           model TEXT,
           effort TEXT,
           error_class TEXT NOT NULL,
           outcome TEXT NOT NULL,
           to_cli TEXT,
           PRIMARY KEY (delegation_id, n)
         );
         CREATE TABLE IF NOT EXISTS crew_holds (
           delegation_id TEXT PRIMARY KEY,
           hold TEXT NOT NULL,
           resume_at INTEGER NOT NULL,
           child_session TEXT NOT NULL,
           cli TEXT,
           model TEXT,
           effort TEXT,
           claim INTEGER NOT NULL DEFAULT 0
         );",
    )
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDraft {
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub cli: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRules {
    pub rules: Vec<Rule>,
    pub revision: i64,
    pub budget: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteQuery {
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default, rename = "override")]
    pub override_pick: Option<Pick>,
    #[serde(default)]
    pub brief: Option<Pick>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub mono: Option<String>,
    #[serde(default)]
    pub present: Vec<Presence>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureQuery {
    pub delegation_id: String,
    #[serde(default)]
    pub error_class: Option<String>,
    /// Classified when the row's class is missing, unknown or a generic provider error. Never stored.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub resets_at: Option<i64>,
    pub current: Pick,
    #[serde(default)]
    pub present: Vec<Presence>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub mono: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailureResult {
    pub action: String,
    pub to: Option<String>,
    pub until: Option<i64>,
    pub reason: String,
    pub applied: bool,
}

fn scope_key(scope: &str, raw: &str) -> Result<(String, String), String> {
    match scope {
        "project" => {
            let id = crate::delivery::settings::key(raw);
            if id.trim().is_empty() {
                return Err("Which project? Its folder is needed.".into());
            }
            Ok(("project".into(), id))
        }
        "mono" => {
            let id = raw.trim();
            let ok = !id.is_empty()
                && id.len() <= 64
                && !id.contains("..")
                && !id.contains(['/', '\\'])
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            if !ok {
                return Err("Name the Mono with letters, numbers, - and _.".into());
            }
            Ok(("mono".into(), id.to_string()))
        }
        _ => Err("Rules belong to a project or a Mono.".into()),
    }
}

fn blank(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn clean_labels(values: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for value in values {
        let text = rules::norm_label(value);
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > MAX_ITEM {
            return Err("A label is too long.".into());
        }
        if out.contains(&text) {
            continue;
        }
        if out.len() == MAX_ITEMS {
            return Err("A rule has too many labels.".into());
        }
        out.push(text);
    }
    Ok(out)
}

fn clean_paths(values: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for value in values {
        let text = value
            .replace("\r\n", "\n")
            .replace(['\r', '\n'], "")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > MAX_ITEM {
            return Err("A path is too long.".into());
        }
        if rules::path_segments(&text).is_none() {
            return Err("A path can't contain ..".into());
        }
        if out.contains(&text) {
            continue;
        }
        if out.len() == MAX_ITEMS {
            return Err("A rule has too many paths.".into());
        }
        out.push(text);
    }
    Ok(out)
}

fn prepare_rule(draft: &RuleDraft) -> Result<Rule, String> {
    let model = match draft
        .model
        .as_ref()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
    {
        Some(text) if text.chars().count() > 200 || text.contains(['\r', '\n']) => {
            return Err("The model has to be one line.".into());
        }
        Some(text) => Some(text.to_string()),
        None => None,
    };
    let rule = Rule {
        labels: clean_labels(&draft.labels)?,
        paths: clean_paths(&draft.paths)?,
        cli: blank(&draft.cli),
        model,
        effort: blank(&draft.effort),
        source: "person".into(),
    };
    rules::validate_rule(&rule)?;
    Ok(rule)
}

fn strings_from_json(text: &str) -> Option<Vec<String>> {
    let value: Value = serde_json::from_str(text).ok()?;
    let items = value.as_array()?;
    let mut out = Vec::new();
    for item in items {
        let text = item.as_str()?.to_string();
        out.push(text);
    }
    Some(out)
}

/// A row written by an older or other window is untrusted. A broken one is skipped.
fn rule_from_stored(
    labels: &str,
    paths: &str,
    cli: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Option<Rule> {
    let draft = RuleDraft {
        labels: strings_from_json(labels)?,
        paths: strings_from_json(paths)?,
        cli,
        model,
        effort,
    };
    prepare_rule(&draft).ok()
}

fn read_rules(conn: &Connection, scope: &str, scope_id: &str) -> Result<Vec<Rule>, String> {
    let mut statement = conn
        .prepare(
            "SELECT labels, paths, cli, model, effort FROM crew_rules
             WHERE scope = ?1 AND scope_id = ?2 ORDER BY position",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![scope, scope_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (labels, paths, cli, model, effort) = row.map_err(|e| e.to_string())?;
        if let Some(rule) = rule_from_stored(&labels, &paths, cli, model, effort) {
            out.push(rule);
        }
    }
    Ok(out)
}

fn meta(conn: &Connection, scope: &str, scope_id: &str) -> Result<(i64, Option<String>), String> {
    conn.query_row(
        "SELECT revision, budget FROM crew_rule_meta WHERE scope = ?1 AND scope_id = ?2",
        params![scope, scope_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
    )
    .optional()
    .map(|found| found.unwrap_or((0, None)))
    .map_err(|e| e.to_string())
}

fn parse_budget(text: Option<String>) -> Option<Value> {
    text.and_then(|text| serde_json::from_str(&text).ok())
}

fn load_optional(conn: &Connection, scope: &str, raw: &str) -> Result<Vec<Rule>, String> {
    let Ok((scope, id)) = scope_key(scope, raw) else {
        return Ok(Vec::new());
    };
    read_rules(conn, &scope, &id)
}

pub fn get_rules(conn: &Connection, scope: &str, scope_id: &str) -> Result<StoredRules, String> {
    let (scope, scope_id) = scope_key(scope, scope_id)?;
    let rules = read_rules(conn, &scope, &scope_id)?;
    let (revision, budget) = meta(conn, &scope, &scope_id)?;
    Ok(StoredRules {
        rules,
        revision,
        budget: parse_budget(budget),
    })
}

fn constraint(error: &rusqlite::Error) -> bool {
    matches!(error, rusqlite::Error::SqliteFailure(err, _) if err.code == rusqlite::ErrorCode::ConstraintViolation)
}

fn write_rules(tx: &Connection, scope: &str, scope_id: &str, rules: &[Rule]) -> Result<(), String> {
    tx.execute(
        "DELETE FROM crew_rules WHERE scope = ?1 AND scope_id = ?2",
        params![scope, scope_id],
    )
    .map_err(|e| e.to_string())?;
    for (position, rule) in rules.iter().enumerate() {
        let labels = serde_json::to_string(&rule.labels).unwrap_or_else(|_| "[]".into());
        let paths = serde_json::to_string(&rule.paths).unwrap_or_else(|_| "[]".into());
        tx.execute(
            "INSERT INTO crew_rules (scope, scope_id, position, labels, paths, cli, model, effort)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                scope,
                scope_id,
                position as i64,
                labels,
                paths,
                rule.cli,
                rule.model,
                rule.effort
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `budget` of `None` leaves the stored budget alone. A present value is checked first; garbage is refused.
pub fn set_rules(
    conn: &mut Connection,
    scope: &str,
    scope_id: &str,
    drafts: &[RuleDraft],
    expected: i64,
    budget: Option<&Value>,
) -> Result<StoredRules, String> {
    let (scope, scope_id) = scope_key(scope, scope_id)?;
    if drafts.len() > MAX_RULES {
        return Err("Keep it to 40 rules.".into());
    }
    let mut rules = Vec::with_capacity(drafts.len());
    for draft in drafts {
        rules.push(prepare_rule(draft)?);
    }
    let budget_text = match budget {
        None => None,
        Some(value) => {
            normalize_failure_policy(value)?;
            Some(value.to_string())
        }
    };
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let (current, _) = meta(&tx, &scope, &scope_id)?;
    if current != expected {
        return Err(CONFLICT.into());
    }
    write_rules(&tx, &scope, &scope_id, &rules)?;
    let next = expected + 1;
    let wrote = if current == 0 {
        tx.execute(
            "INSERT INTO crew_rule_meta (scope, scope_id, budget, revision) VALUES (?1, ?2, ?3, ?4)",
            params![scope, scope_id, budget_text, next],
        )
    } else if budget.is_some() {
        tx.execute(
            "UPDATE crew_rule_meta SET revision = ?3, budget = ?4 WHERE scope = ?1 AND scope_id = ?2 AND revision = ?5",
            params![scope, scope_id, next, budget_text, expected],
        )
    } else {
        tx.execute(
            "UPDATE crew_rule_meta SET revision = ?3 WHERE scope = ?1 AND scope_id = ?2 AND revision = ?4",
            params![scope, scope_id, next, expected],
        )
    };
    match wrote {
        Ok(0) => return Err(CONFLICT.into()),
        Ok(_) => {}
        Err(error) if constraint(&error) => return Err(CONFLICT.into()),
        Err(error) => return Err(error.to_string()),
    }
    tx.commit().map_err(|e| e.to_string())?;
    get_rules(conn, &scope, &scope_id)
}

pub fn route(conn: &Connection, query: &RouteQuery, plugins: &[Rule]) -> Result<Route, String> {
    let mono = match query
        .mono
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => load_optional(conn, "mono", id)?,
        None => Vec::new(),
    };
    let project = match query
        .project
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => load_optional(conn, "project", id)?,
        None => Vec::new(),
    };
    let merged = rules::merge_rules(&mono, &project, plugins);
    Ok(resolve_route(
        &query.labels,
        &query.paths,
        query.override_pick.as_ref(),
        query.brief.as_ref(),
        &merged,
        &query.present,
    ))
}

fn read_attempts(conn: &Connection, id: &str) -> Result<Vec<Attempt>, String> {
    let mut statement = conn
        .prepare(
            "SELECT at, cli, model, effort, error_class, outcome, to_cli FROM crew_attempts
             WHERE delegation_id = ?1 ORDER BY n",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![id], |row| {
            Ok(Attempt {
                at: row.get(0)?,
                cli: row.get(1)?,
                model: row.get(2)?,
                effort: row.get(3)?,
                error_class: row.get(4)?,
                outcome: row.get(5)?,
                to: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Mono budget when that Mono has one, else the project's, else nothing (the decider uses 2).
fn budget_for(
    conn: &Connection,
    mono: Option<&str>,
    project: Option<&str>,
) -> Result<Option<Value>, String> {
    for (scope, raw) in [("mono", mono), ("project", project)] {
        let Some(raw) = raw.map(str::trim).filter(|id| !id.is_empty()) else {
            continue;
        };
        let Ok((scope, id)) = scope_key(scope, raw) else {
            continue;
        };
        let (_, text) = meta(conn, &scope, &id)?;
        if text.is_some() {
            return Ok(parse_budget(text));
        }
    }
    Ok(None)
}

fn append_attempt(conn: &Connection, id: &str, attempt: &Attempt) -> Result<(), String> {
    conn.execute(
        "INSERT INTO crew_attempts (delegation_id, n, at, cli, model, effort, error_class, outcome, to_cli)
         VALUES (?1, COALESCE((SELECT MAX(n) FROM crew_attempts WHERE delegation_id = ?1), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, attempt.at, attempt.cli, attempt.model, attempt.effort, attempt.error_class, attempt.outcome, attempt.to],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn write_hold(
    conn: &Connection,
    id: &str,
    child: &str,
    at: i64,
    current: &Pick,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO crew_holds (delegation_id, hold, resume_at, child_session, cli, model, effort, claim)
         VALUES (?1, 'paused', ?2, ?3, ?4, ?5, ?6, 0)
         ON CONFLICT(delegation_id) DO UPDATE SET
           hold = 'paused', resume_at = excluded.resume_at, child_session = excluded.child_session,
           cli = excluded.cli, model = excluded.model, effort = excluded.effort, claim = 0",
        params![id, at, child, current.cli, current.model, current.effort],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn delete_hold(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM crew_holds WHERE delegation_id = ?1",
        params![id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn result_of(decision: &Decision, applied: bool) -> FailureResult {
    FailureResult {
        action: decision.action.clone(),
        to: decision.to.clone(),
        until: decision.until,
        reason: decision.reason.clone(),
        applied,
    }
}

fn refused(reason: &str) -> FailureResult {
    FailureResult {
        action: "first-mate".into(),
        to: None,
        until: None,
        reason: reason.into(),
        applied: false,
    }
}

struct OpenFailure {
    decision: Decision,
    /// `resume` still has to reopen the row, after this transaction commits.
    resume: bool,
}

fn record_failure(
    tx: &Connection,
    input: &FailureQuery,
    now: i64,
) -> Result<Result<OpenFailure, FailureResult>, String> {
    let Some(row) = crate::delegations::get(tx, &input.delegation_id)? else {
        let ledger = Vec::new();
        let decision = decide(&FailureInput {
            error_class: input.error_class.as_deref(),
            text: input.text.as_deref(),
            resets_at: input.resets_at,
            now,
            current: &input.current,
            present: &input.present,
            ledger: &ledger,
            budget: None,
        });
        return Ok(Err(result_of(&decision, false)));
    };
    if row.state == crate::delegations::CANCELLED || row.delivery == crate::delegations::DISPOSED {
        return Ok(Err(refused("the task was cancelled")));
    }
    if row.state != crate::delegations::FAILED {
        return Ok(Err(refused("the task is not failed")));
    }
    let ledger = read_attempts(tx, &row.id)?;
    let budget = budget_for(tx, input.mono.as_deref(), input.project.as_deref())?;
    let decision = decide(&FailureInput {
        error_class: row.error_class.as_deref(),
        text: input.text.as_deref(),
        resets_at: row.resets_at.or(input.resets_at),
        now,
        current: &input.current,
        present: &input.present,
        ledger: &ledger,
        budget: budget.as_ref(),
    });
    let resume = decision.action == "resume";
    if resume {
        write_hold(tx, &row.id, &row.child_session, now, &input.current)?;
    } else if decision.action == "pause" {
        append_attempt(tx, &row.id, &decision.attempt)?;
        write_hold(
            tx,
            &row.id,
            &row.child_session,
            decision.until.unwrap_or(now),
            &input.current,
        )?;
    } else {
        append_attempt(tx, &row.id, &decision.attempt)?;
        delete_hold(tx, &row.id)?;
    }
    Ok(Ok(OpenFailure { decision, resume }))
}

pub fn on_failure(
    conn: &mut Connection,
    input: &FailureQuery,
    now: i64,
) -> Result<FailureResult, String> {
    let opened = {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let opened = record_failure(&tx, input, now)?;
        if opened.is_ok() {
            tx.commit().map_err(|e| e.to_string())?;
        }
        opened
    };
    let OpenFailure { decision, resume } = match opened {
        Ok(opened) => opened,
        Err(result) => return Ok(result),
    };
    if !resume {
        return Ok(result_of(&decision, true));
    }
    resume_due(conn, now)?;
    let after = crate::delegations::get(conn, &input.delegation_id)?;
    let applied = after.is_some_and(|row| row.state == crate::delegations::RUNNING);
    Ok(result_of(&decision, applied))
}

struct Hold {
    id: String,
    claim: i64,
    child: String,
    cli: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

fn due_holds(conn: &Connection, now: i64) -> Result<Vec<Hold>, String> {
    let mut statement = conn
        .prepare(
            "SELECT delegation_id, claim, child_session, cli, model, effort FROM crew_holds
             WHERE resume_at <= ?1 AND hold IN ('paused', 'taken')
             ORDER BY resume_at, delegation_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![now], |row| {
            Ok(Hold {
                id: row.get(0)?,
                claim: row.get(1)?,
                child: row.get(2)?,
                cli: row.get(3)?,
                model: row.get(4)?,
                effort: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn claim_hold(conn: &Connection, hold: &Hold) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE crew_holds SET hold = 'taken', claim = claim + 1
             WHERE delegation_id = ?1 AND claim = ?2 AND hold IN ('paused', 'taken')",
            params![hold.id, hold.claim],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

fn release_hold(conn: &Connection, id: &str, claim: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE crew_holds SET hold = 'paused' WHERE delegation_id = ?1 AND claim = ?2",
        params![id, claim],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn finished(row: &crate::delegations::Delegation) -> bool {
    row.state == crate::delegations::CANCELLED
        || row.state == crate::delegations::COMPLETED
        || row.state == crate::delegations::RUNNING
        || row.state == crate::delegations::QUESTION
        || row.delivery == crate::delegations::DISPOSED
}

fn resumed_attempt(hold: &Hold, now: i64) -> Attempt {
    Attempt {
        at: now,
        cli: hold.cli.clone(),
        model: hold.model.clone(),
        effort: hold.effort.clone(),
        error_class: "usage_limit".into(),
        outcome: "resumed".into(),
        to: None,
    }
}

/// Reopen holds whose reset time has come. A cancelled, disposed, finished or already-running row is not reopened.
/// One resume that fails to write goes back to paused; the tick itself is not failed for that.
pub(crate) fn resume_due(conn: &mut Connection, now: i64) -> Result<usize, String> {
    let holds = due_holds(conn, now)?;
    let mut resumed = 0;
    for hold in holds {
        if !claim_hold(conn, &hold)? {
            continue;
        }
        let claimed = hold.claim + 1;
        let row = crate::delegations::get(conn, &hold.id)?;
        let reopen = row
            .as_ref()
            .is_some_and(|row| row.state == crate::delegations::FAILED && !finished(row));
        if !reopen {
            delete_hold(conn, &hold.id)?;
            continue;
        }
        match crate::delegations::reattach(conn, &hold.child, true, Some("crew".into()), now) {
            Ok(Some(_)) => {
                append_attempt(conn, &hold.id, &resumed_attempt(&hold, now))?;
                delete_hold(conn, &hold.id)?;
                resumed += 1;
            }
            Ok(None) => delete_hold(conn, &hold.id)?,
            Err(_) => release_hold(conn, &hold.id, claimed)?,
        }
    }
    Ok(resumed)
}
