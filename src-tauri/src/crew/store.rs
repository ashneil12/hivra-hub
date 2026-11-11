//! Crew rules, the attempt ledger and usage-limit holds. A delegation row is not given a new column:
//! `delegations` is positional upstream. Two windows compare-and-swap the revision. A usage-limit note
//! records a hold for display and does not change the row. The app resumes that chat itself.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::budget::normalize_failure_policy;
use super::failure::is_account_class;
use super::reroute::{decide, Attempt, Decision, FailureInput};
use super::resolve::{
    default_cli_except, resolve_route, role_model, CatalogModel, Pick, Presence, Route,
    RouteDefaults,
};
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
           task_ceiling_usd REAL,
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
    )?;
    // A table made before a rule could carry a ceiling gets the column. Creating it twice is fine.
    let has_ceiling = conn
        .prepare("SELECT 1 FROM pragma_table_info('crew_rules') WHERE name = 'task_ceiling_usd'")?
        .exists([])?;
    if !has_ceiling {
        conn.execute_batch("ALTER TABLE crew_rules ADD COLUMN task_ceiling_usd REAL;")?;
    }
    Ok(())
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
    /// WP-176. Dollars. Missing means this rule sets no task ceiling.
    #[serde(default)]
    pub task_ceiling_usd: Option<f64>,
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
    /// WP-21: rules stored on the Mono. When any survive the checks, they are this Mono's rules.
    #[serde(default)]
    pub mono_rules: Vec<Rule>,
    /// WP-89: the Mono, project and system defaults, and the app's usual model and effort.
    #[serde(default)]
    pub defaults: Option<RouteDefaults>,
    /// WP-89: models each CLI offers. Empty means no catalog, so a model stays a free string.
    #[serde(default)]
    pub catalog: std::collections::BTreeMap<String, Vec<CatalogModel>>,
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

/// A usage limit on a row that is still open. The row is not settled, and the text of the failure is not stored.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseQuery {
    pub delegation_id: String,
    #[serde(default)]
    pub resets_at: Option<i64>,
    pub current: Pick,
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

/// Rules carried on a Mono are untrusted. A broken one is dropped, and the source is the person's.
fn carried_mono_rules(rules: &[Rule]) -> Vec<Rule> {
    let mut out = Vec::new();
    for rule in rules {
        if rule.task_ceiling_micros == Some(i64::MIN) {
            continue;
        }
        let draft = RuleDraft {
            labels: rule.labels.clone(),
            paths: rule.paths.clone(),
            cli: rule.cli.clone(),
            model: rule.model.clone(),
            effort: rule.effort.clone(),
            task_ceiling_usd: rule
                .task_ceiling_micros
                .filter(|micros| *micros > 0)
                .map(|micros| micros as f64 / 1_000_000.0),
        };
        let Ok(clean) = prepare_rule(&draft) else {
            continue;
        };
        out.push(clean);
        if out.len() == MAX_RULES {
            break;
        }
    }
    out
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
        task_ceiling_micros: None,
        source: "person".into(),
    };
    // The ceiling stays out of this check. A rule still has to name a cli, model or effort.
    rules::validate_rule(&rule)?;
    let task_ceiling_micros = match draft.task_ceiling_usd {
        None => None,
        Some(usd) => Some(
            rules::ceiling_micros(usd).ok_or("The task ceiling has to be a positive amount.")?,
        ),
    };
    Ok(Rule {
        task_ceiling_micros,
        ..rule
    })
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
    ceiling: Option<f64>,
) -> Option<Rule> {
    let draft = RuleDraft {
        labels: strings_from_json(labels)?,
        paths: strings_from_json(paths)?,
        cli,
        model,
        effort,
        task_ceiling_usd: ceiling,
    };
    prepare_rule(&draft).ok()
}

fn read_rules(conn: &Connection, scope: &str, scope_id: &str) -> Result<Vec<Rule>, String> {
    let mut statement = conn
        .prepare(
            "SELECT labels, paths, cli, model, effort, task_ceiling_usd FROM crew_rules
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
                row.get::<_, Option<f64>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (labels, paths, cli, model, effort, ceiling) = row.map_err(|e| e.to_string())?;
        if let Some(rule) = rule_from_stored(&labels, &paths, cli, model, effort, ceiling) {
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
            "INSERT INTO crew_rules (scope, scope_id, position, labels, paths, cli, model, effort, task_ceiling_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                scope,
                scope_id,
                position as i64,
                labels,
                paths,
                rule.cli,
                rule.model,
                rule.effort,
                rule.task_ceiling_micros
                    .filter(|micros| *micros > 0)
                    .map(|micros| micros as f64 / 1_000_000.0)
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

/// Far enough ahead that a real attempt is outside the cool-down. The command passes `now` to `route_at`.
#[cfg(test)]
pub fn route(conn: &Connection, query: &RouteQuery, plugins: &[Rule]) -> Result<Route, String> {
    route_at(conn, query, plugins, i64::MAX)
}

const COOL_MS: i64 = 30 * 60 * 1000;

fn cooled_clis(conn: &Connection, now: i64) -> Result<Vec<String>, String> {
    let since = now.saturating_sub(COOL_MS);
    let mut statement = conn
        .prepare("SELECT cli, error_class FROM crew_attempts WHERE at >= ?1 AND cli IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![since], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut cooled = Vec::new();
    for row in rows {
        let (cli, class) = row.map_err(|e| e.to_string())?;
        let Some(cli) = cli.filter(|cli| !cli.is_empty()) else {
            continue;
        };
        if !is_account_class(&class) || cooled.iter().any(|have| have == &cli) {
            continue;
        }
        cooled.push(cli);
    }
    Ok(cooled)
}

pub fn route_at(
    conn: &Connection,
    query: &RouteQuery,
    plugins: &[Rule],
    now: i64,
) -> Result<Route, String> {
    let stored = match query
        .mono
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => load_optional(conn, "mono", id)?,
        None => Vec::new(),
    };
    // WP-21: rules stored on the Mono beat a copy in the crew table, then the project's, then plugins'.
    let carried = carried_mono_rules(&query.mono_rules);
    let mono = if carried.is_empty() { stored } else { carried };
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
    let mut route = resolve_route(
        &query.labels,
        &query.paths,
        query.override_pick.as_ref(),
        query.brief.as_ref(),
        &merged,
        &query.present,
        query.defaults.as_ref(),
        &query.catalog,
    );
    let cooled = cooled_clis(conn, now)?;
    if route.cli_from != "override" {
        if let Some(cli) = route.cli.clone() {
            if cooled.iter().any(|have| have == &cli) {
                let next = default_cli_except(&query.present, &cooled);
                route.cli_from = if next.is_some() {
                    "default".into()
                } else {
                    "none".into()
                };
                route.cli = next;
                let (plan_model, plan_effort) = role_model("plan", &route);
                let (verdict_model, verdict_effort) = role_model("verdict", &route);
                route.plan_model = plan_model;
                route.plan_effort = plan_effort;
                route.verdict_model = verdict_model;
                route.verdict_effort = verdict_effort;
            }
        }
    }
    Ok(route)
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

fn record_failure(
    tx: &Connection,
    input: &FailureQuery,
    now: i64,
) -> Result<Result<Decision, FailureResult>, String> {
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
    if decision.action == "resume" {
        return Ok(Err(result_of(&decision, false)));
    }
    if decision.action == "pause" {
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
    Ok(Ok(decision))
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
    match opened {
        Ok(decision) => Ok(result_of(&decision, true)),
        Err(result) => Ok(result),
    }
}

fn row_is_open(row: &crate::delegations::Delegation) -> bool {
    (row.state == crate::delegations::RUNNING || row.state == crate::delegations::QUESTION)
        && row.delivery != crate::delegations::DISPOSED
}

fn not_open(until: Option<i64>) -> FailureResult {
    FailureResult {
        action: "pause".into(),
        to: None,
        until,
        reason: "the task is not open".into(),
        applied: false,
    }
}

/// Record a usage-limit pause on a row that is still open. The delegation row is not changed.
pub fn note_pause(
    conn: &mut Connection,
    input: &PauseQuery,
    now: i64,
) -> Result<FailureResult, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let Some(row) = crate::delegations::get(&tx, &input.delegation_id)? else {
        return Ok(not_open(input.resets_at));
    };
    if !row_is_open(&row) {
        return Ok(not_open(input.resets_at));
    }
    append_attempt(
        &tx,
        &row.id,
        &Attempt {
            at: now,
            cli: input.current.cli.clone(),
            model: input.current.model.clone(),
            effort: input.current.effort.clone(),
            error_class: "usage_limit".into(),
            outcome: "paused".into(),
            to: None,
        },
    )?;
    if let Some(at) = input.resets_at {
        write_hold(&tx, &row.id, &row.child_session, at, &input.current)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(FailureResult {
        action: "pause".into(),
        to: None,
        until: input.resets_at,
        reason: "waiting for a usage limit to reset".into(),
        applied: true,
    })
}
