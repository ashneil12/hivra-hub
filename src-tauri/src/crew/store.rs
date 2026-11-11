//! Crew rules, the attempt ledger and usage-limit holds. A delegation row is not given a new column:
//! `delegations` is positional upstream. Two windows compare-and-swap the revision. A usage-limit note
//! records a hold for display and does not change the row. The app resumes that chat itself.

use std::io::Read;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::budget::normalize_failure_policy;
use super::failure::is_account_class;
use super::pick;
use super::policy::sanitize_policy;
use super::reroute::{decide, Attempt, Decision, FailureInput};
use super::resolve::{
    default_cli_except, resolve_route, role_model, CatalogModel, Pick, Presence, Route,
    RouteDefaults, Skipped,
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
         CREATE TABLE IF NOT EXISTS crew_grants (
           session TEXT PRIMARY KEY,
           mono TEXT,
           project TEXT,
           locked_default TEXT,
           granted_at INTEGER NOT NULL,
           last_used INTEGER NOT NULL DEFAULT 0
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
    // WP-141: older stores grew this table before the policy column. An older build never reads it.
    let has_policy = conn
        .prepare("SELECT 1 FROM pragma_table_info('crew_rule_meta') WHERE name = 'policy'")?
        .exists([])?;
    if !has_policy {
        conn.execute_batch("ALTER TABLE crew_rule_meta ADD COLUMN policy TEXT;")?;
    }
    // A table made before a rule could carry a ceiling gets the column. Creating it twice is fine.
    let has_ceiling = conn
        .prepare("SELECT 1 FROM pragma_table_info('crew_rules') WHERE name = 'task_ceiling_usd'")?
        .exists([])?;
    if !has_ceiling {
        conn.execute_batch("ALTER TABLE crew_rules ADD COLUMN task_ceiling_usd REAL;")?;
    }
    // Projects in force when a grant was saved. An older grant has none; the launch reads its folder again.
    let has_projects = conn
        .prepare("SELECT 1 FROM pragma_table_info('crew_grants') WHERE name = 'projects'")?
        .exists([])?;
    if !has_projects {
        conn.execute_batch("ALTER TABLE crew_grants ADD COLUMN projects TEXT;")?;
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
    /// WP-141. Always an object: lockDefault, neverUse, fallback. For a project with no policy of its own, the system's.
    pub policy: Value,
    /// WP-141: false when this scope has no policy saved, so `policy` is the one it inherits.
    pub policy_own: bool,
    /// Round 6: the scope's saved policy does not parse. `policy` is then the empty one, shown so Ash can save over it;
    /// a launch still refuses (the policy is read there), so nothing runs on a policy nobody can see.
    pub policy_unreadable: bool,
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
        // WP-141: the defaults that are not for one project or one Mono.
        "system" => {
            if raw.trim() != "system" {
                return Err("The whole-app settings have one place.".into());
            }
            Ok(("system".into(), "system".into()))
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

fn meta(
    conn: &Connection,
    scope: &str,
    scope_id: &str,
) -> Result<(i64, Option<String>, Option<String>), String> {
    conn.query_row(
        "SELECT revision, budget, policy FROM crew_rule_meta WHERE scope = ?1 AND scope_id = ?2",
        params![scope, scope_id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        },
    )
    .optional()
    .map(|found| found.unwrap_or((0, None, None)))
    .map_err(|e| e.to_string())
}

/// A stored policy that doesn't parse is an error, never an empty policy: an empty one would drop every Never use.
fn policy_value(text: Option<String>) -> Result<Value, String> {
    let Some(text) = text else {
        return Ok(sanitize_policy(&Value::Null));
    };
    let parsed = serde_json::from_str::<Value>(&text)
        .map_err(|_| "A saved crew policy is unreadable, so it can't be applied. Save it again in Crew Defaults.".to_string())?;
    Ok(sanitize_policy(&parsed))
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
    let (revision, budget, policy) = meta(conn, &scope, &scope_id)?;
    let policy_own = policy.is_some();
    // Round 6: an unreadable saved policy still loads (empty, flagged) so Ash can save over it.
    let policy_unreadable = policy_own && policy_value(policy.clone()).is_err();
    // A project with no policy of its own shows the system's, the one a route in it actually uses.
    let policy = if policy_unreadable {
        sanitize_policy(&Value::Null)
    } else if policy_own || scope != "project" {
        policy_value(policy)?
    } else {
        saved_policy(conn, "system", "system")?.unwrap_or_else(|| sanitize_policy(&Value::Null))
    };
    Ok(StoredRules {
        rules,
        revision,
        budget: parse_budget(budget),
        policy,
        policy_own,
        policy_unreadable,
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
    let (current, _, _) = meta(&tx, &scope, &scope_id)?;
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

/// The lock and lists. A save does not touch the rules or the budget. A stale revision does not write.
pub fn set_policy(
    conn: &mut Connection,
    scope: &str,
    scope_id: &str,
    policy: &Value,
    expected: i64,
) -> Result<StoredRules, String> {
    let (scope, scope_id) = scope_key(scope, scope_id)?;
    let text = sanitize_policy(policy).to_string();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let (current, _, _) = meta(&tx, &scope, &scope_id)?;
    if current != expected {
        return Err(CONFLICT.into());
    }
    let next = expected + 1;
    let wrote = if current == 0 {
        tx.execute(
            "INSERT INTO crew_rule_meta (scope, scope_id, budget, revision, policy) VALUES (?1, ?2, NULL, ?3, ?4)",
            params![scope, scope_id, next, text],
        )
    } else {
        tx.execute(
            "UPDATE crew_rule_meta SET revision = ?3, policy = ?4 WHERE scope = ?1 AND scope_id = ?2 AND revision = ?5",
            params![scope, scope_id, next, text, expected],
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

/// The gate's decision for one session, saved so a restart, a resumed worker or Ash typing into a worker still finds it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grant {
    pub mono: Option<String>,
    pub project: Option<String>,
    pub locked_default: Option<String>,
    /// Project ids in force when the grant was saved, plus any the parent session already held.
    pub projects: Vec<String>,
}

/// How long a grant may go unused before it is pruned. Every judged start of the session refreshes it, so a worker
/// that is still running, resumed or typed into keeps its decision. Sessions have no delete hook in the crew store.
pub const GRANT_IDLE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Saves the decision for a session. A later launch of that session replaces it. Grants idle past `GRANT_IDLE_MS` go.
pub fn save_grant(conn: &Connection, session: &str, grant: &Grant, at: i64) -> Result<(), String> {
    prune_grants(conn, at)?;
    let projects = serde_json::to_string(&grant.projects).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT OR REPLACE INTO crew_grants (session, mono, project, locked_default, granted_at, last_used, projects) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        params![session, grant.mono, grant.project, grant.locked_default, at, projects],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// Marks a session's grant as used at `at`, so the idle rule counts from its last judged start.
pub fn touch_grant(conn: &Connection, session: &str, at: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE crew_grants SET last_used = ?2 WHERE session = ?1",
        params![session, at],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// Drops every grant unused since before `now - GRANT_IDLE_MS`. Returns how many went.
pub fn prune_grants(conn: &Connection, now: i64) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM crew_grants WHERE last_used < ?1",
        params![now.saturating_sub(GRANT_IDLE_MS)],
    )
    .map_err(|error| error.to_string())
}

/// Where the Never use list that holds `cli` lives, in words a person can find in Crew Defaults: this Mono, this
/// project (its folder), or everything. None when no saved scope lists it. `projects` are every project in force.
pub(crate) fn never_use_scope(
    conn: &Connection,
    mono: Option<&str>,
    projects: &[String],
    cli: &str,
) -> Result<Option<String>, String> {
    let lists = |policy: Option<Value>| {
        policy
            .and_then(|policy| policy.get("neverUse").cloned())
            .and_then(|list| list.as_array().cloned())
            .is_some_and(|list| list.iter().any(|id| id.as_str() == Some(cli)))
    };
    if let Some(id) = mono.map(str::trim).filter(|id| !id.is_empty()) {
        if lists(saved_policy(conn, "mono", id)?) {
            return Ok(Some("this Mono".into()));
        }
    }
    for id in projects {
        if lists(saved_policy(conn, "project", id)?) {
            return Ok(Some(format!("this project ({id})")));
        }
    }
    if lists(saved_policy(conn, "system", "system")?) {
        return Ok(Some("everything (the system default)".into()));
    }
    Ok(None)
}

/// Project ids saved on a grant. Missing, blank or not a list of strings is none: a grant is untrusted data.
fn grant_projects(text: Option<String>) -> Vec<String> {
    let Some(text) = text.filter(|text| !text.trim().is_empty()) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(rows) = value.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .take(64)
        .map(str::to_string)
        .collect()
}

pub fn grant_of(conn: &Connection, session: &str) -> Result<Option<Grant>, String> {
    conn.query_row(
        "SELECT mono, project, locked_default, projects FROM crew_grants WHERE session = ?1",
        params![session],
        |row| {
            Ok(Grant {
                mono: row.get(0)?,
                project: row.get(1)?,
                locked_default: row.get(2)?,
                projects: grant_projects(row.get(3)?),
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

/// The one form every crew folder comparison uses, on every OS. It is the canonical path when the folder exists, with
/// the Windows verbatim prefix removed (the crate's `fs::canonical`), separators as `/`, and a drive letter (or a
/// network path) in lower case. These are the rules of the TS `pathKey` in src/shared/lib/paths.ts. A folder that does
/// not exist keeps its spelling, in the same form.
pub(crate) fn path_key(path: &str) -> String {
    let canonical = crate::fs::canonical(path)
        .map(|found| found.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
    path_key_of_text(&canonical)
}

/// The text rules of `path_key`, with no filesystem access, so a test can check them on every OS.
pub(crate) fn path_key_of_text(text: &str) -> String {
    let unprefixed = match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!("//{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(text).to_string(),
    };
    let mut out: String = unprefixed
        .chars()
        .map(|c| if c == '\\' { '/' } else { c })
        .collect();
    while out.len() > 1 && out.ends_with('/') && !out.ends_with(":/") {
        out.pop();
    }
    let bytes = out.as_bytes();
    let drive = bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic();
    if drive || out.starts_with("//") {
        out = out.to_lowercase();
    }
    out
}

/// Whether `path` is `prefix` or sits inside it, comparing whole components. An empty prefix holds everything.
fn key_within(path: &str, prefix: &str) -> bool {
    let prefix = prefix.trim_end_matches('/');
    prefix.is_empty() || path == prefix || path.starts_with(&format!("{prefix}/"))
}

/// Whether a project rooted at `root` owns `folder`, when both sit in one checkout. `folder_top` and `root_top` are the
/// top-level folders of their checkouts (in `path_key` form). The folder's part of its checkout must sit inside the
/// project's part of its checkout, so a package project maps to its package in every worktree. When either path is not
/// inside its checkout the place cannot be decided, and that is an error: the judgment refuses rather than read no owner.
pub(crate) fn owns_within_checkout(
    folder: &str,
    folder_top: &str,
    root: &str,
    root_top: &str,
) -> Result<bool, String> {
    let undecided = || {
        "The crew policy could not be read, so nothing was started (a folder's place in its git checkout could not be decided)."
            .to_string()
    };
    if !key_within(folder, folder_top) || !key_within(root, root_top) {
        return Err(undecided());
    }
    let relative = |path: &str, top: &str| -> String {
        path[top.trim_end_matches('/').len()..]
            .trim_start_matches('/')
            .to_string()
    };
    Ok(key_within(
        &relative(folder, folder_top),
        &relative(root, root_top),
    ))
}

/// A checkout's git common directory, in `path_key` form. The top-level folder is not taken from git.
#[derive(Clone, Debug, PartialEq)]
struct Checkout {
    common: String,
}

/// The `.git` entry (a folder, or a file in a linked worktree) of the nearest ancestor that has one. None means no git
/// here, so no git command runs for the folder at all.
fn git_entry(folder: &std::path::Path) -> Option<std::path::PathBuf> {
    folder
        .ancestors()
        .map(|dir| dir.join(".git"))
        .find(|entry| entry.exists())
}

/// How much of a git file is read. A `.git` file and a `commondir` or `gitdir` file are a path, a few dozen bytes.
/// Anything larger is not treated as one, and a fifo is never opened.
const GIT_FILE_CAP: u64 = 8192;

/// A regular file, or a symlink to one, no bigger than `GIT_FILE_CAP`. A fifo, a directory or a huge file is None.
/// On Unix the name is opened with `O_NONBLOCK` and the handle is checked, so a fifo swapped in after a stat cannot
/// stall the read. A symlink is followed: a git dir file may be a link to a regular file.
pub(crate) fn read_git_file(path: &std::path::Path) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
            .ok()?;
        let meta = file.metadata().ok()?;
        if !meta.is_file() || meta.len() > GIT_FILE_CAP {
            return None;
        }
        // A regular file does not wait for a writer. Clearing the flag lets a read wait for the disk.
        if !clear_git_nonblocking(&file) {
            return None;
        }
        let mut buf = vec![0u8; meta.len() as usize];
        file.read_exact(&mut buf).ok()?;
        String::from_utf8(buf).ok()
    }
    #[cfg(not(unix))]
    {
        let listed = std::fs::symlink_metadata(path).ok()?;
        let meta = if listed.file_type().is_symlink() {
            std::fs::metadata(path).ok()?
        } else {
            listed
        };
        if !meta.is_file() || meta.len() > GIT_FILE_CAP {
            return None;
        }
        let mut file = std::fs::File::open(path).ok()?;
        let mut buf = vec![0u8; meta.len() as usize];
        file.read_exact(&mut buf).ok()?;
        String::from_utf8(buf).ok()
    }
}

/// Clears `O_NONBLOCK` on a descriptor this process just opened.
#[cfg(unix)]
fn clear_git_nonblocking(file: &std::fs::File) -> bool {
    use std::os::fd::AsRawFd;
    // SAFETY: F_GETFL and F_SETFL on a descriptor this process owns. Only O_NONBLOCK is cleared.
    unsafe {
        let flags = libc::fcntl(file.as_raw_fd(), libc::F_GETFL);
        flags >= 0 && libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) >= 0
    }
}

fn meta_of(path: &std::path::Path) -> Option<std::fs::Metadata> {
    let listed = std::fs::symlink_metadata(path).ok()?;
    if listed.file_type().is_symlink() {
        std::fs::metadata(path).ok()
    } else {
        Some(listed)
    }
}

/// A git common directory, as git itself accepts one: `HEAD` is a file, and `objects` and `refs` are directories.
fn git_admin_ok(dir: &std::path::Path) -> bool {
    meta_of(&dir.join("HEAD")).is_some_and(|meta| meta.is_file())
        && meta_of(&dir.join("objects")).is_some_and(|meta| meta.is_dir())
        && meta_of(&dir.join("refs")).is_some_and(|meta| meta.is_dir())
}

/// The git common directory a `.git` entry names, read from its files alone. A directory that is already a git admin
/// (HEAD, objects, refs) is its own common directory. Git writes `commondir` only in a linked worktree's admin
/// directory, which is not itself an admin, so a `commondir` file beside a real admin is not followed. A file holds
/// `gitdir: <path>`, and that directory's `commondir` file, when present and the directory is not an admin, names the
/// common directory. The common directory must be a real git dir. A `commondir` that is present but not a readable
/// file is None: the directory is not then treated as its own common directory. None for a fifo or anything else that
/// is not a file or a directory, and that entry is never opened.
fn common_dir(entry: &std::path::Path) -> Option<std::path::PathBuf> {
    let meta = meta_of(entry)?;
    if !meta.is_file() && !meta.is_dir() {
        return None;
    }
    let dir = if meta.is_dir() {
        entry.to_path_buf()
    } else {
        let text = read_git_file(entry)?;
        let target = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?;
        let target = std::path::Path::new(target.trim());
        if target.as_os_str().is_empty() {
            return None;
        }
        if target.is_absolute() {
            target.to_path_buf()
        } else {
            entry.parent()?.join(target)
        }
    };
    // A real admin is the common dir. Following `commondir` here would let a worker point the project at a repo they
    // made, or pad the file past the read cap so the real admin is skipped.
    // A `.git` file's admin dir that sits in the named common's `worktrees/` is a linked worktree even when a worker
    // added `objects/` and `refs/` to it, so its `commondir` is still followed.
    let common = if meta.is_dir() && git_admin_ok(&dir) {
        dir
    } else if std::fs::symlink_metadata(dir.join("commondir")).is_ok() {
        let text = read_git_file(&dir.join("commondir"))?;
        let relative = std::path::Path::new(text.trim());
        if relative.as_os_str().is_empty() {
            return None;
        }
        let named = if relative.is_absolute() {
            relative.to_path_buf()
        } else {
            dir.join(relative)
        };
        if git_admin_ok(&dir) && !worktree_admin_of(&dir, &named) {
            dir
        } else {
            named
        }
    } else {
        dir
    };
    if !git_admin_ok(&common) {
        return None;
    }
    Some(crate::fs::canonical(&common).unwrap_or(common))
}

/// The main checkout's top-level folder, when the common directory is a `.git` folder. A bare repository has none.
fn main_checkout_top(common: &std::path::Path) -> Option<String> {
    if common.file_name().and_then(|name| name.to_str()) != Some(".git") {
        return None;
    }
    let parent = common.parent()?;
    parent.is_dir().then(|| path_key(&parent.to_string_lossy()))
}

/// One linked worktree this common directory has registered. Read once per common directory per judgment.
#[derive(Clone)]
struct Registered {
    /// The canonical path of the `.git` entry the registration names, when that path exists on disk.
    named: Option<std::path::PathBuf>,
    /// The parent of that canonical path, when it is a directory. A name that is not on disk is not a checkout: a worker
    /// can write the name.
    top: Option<String>,
}

/// Holds the registration list for one common directory so a judgment reads `worktrees/` once.
struct RegOnce {
    key: Option<String>,
    rows: Vec<Registered>,
}

/// The most checkouts kept in the cache. The oldest goes first when a new one is put in.
pub(crate) const CHECKOUT_CACHE_MAX: usize = 512;

/// Puts `value` under `key`, replacing an entry for the same key and dropping the oldest entries past `max`.
pub(crate) fn bounded_put<V>(
    entries: &mut Vec<(std::path::PathBuf, V)>,
    key: std::path::PathBuf,
    value: V,
    max: usize,
) {
    entries.retain(|(seen, _)| *seen != key);
    while entries.len() >= max.max(1) {
        entries.remove(0);
    }
    entries.push((key, value));
}

type CheckoutEntry = (
    std::path::PathBuf,
    (Option<std::time::SystemTime>, Checkout),
);
static CHECKOUTS: std::sync::Mutex<Vec<CheckoutEntry>> = std::sync::Mutex::new(Vec::new());

/// The common directory of the checkout a folder is in, or None when it is not in one. A `.git` entry that git cannot
/// read is an error, so the judgment that needs it fails closed. The result is cached per folder, bounded, and keyed by
/// that `.git` entry's modified time, so a checkout that changes is read again. Git runs with the C locale. Git is asked
/// for the common directory only: `core.worktree` changes `--show-toplevel`, so the checkout top is never taken from git.
fn checkout_of(folder: &std::path::Path) -> Result<Option<Checkout>, String> {
    let unreadable = || {
        format!(
            "The git folder of {} could not be read, so nothing was started.",
            folder.display()
        )
    };
    if !folder.exists() {
        return Ok(None);
    }
    let Some(entry) = git_entry(folder) else {
        return Ok(None);
    };
    // A fifo or anything else that is not a file or a directory is not a git dir. Git is not run, and the entry is
    // not opened, so one project's fifo cannot stall the judgment that holds the session store.
    let meta = match meta_of(&entry) {
        Some(meta) if meta.is_file() || meta.is_dir() => meta,
        _ => return Err(unreadable()),
    };
    let stamp = meta.modified().ok();
    if let Ok(cache) = CHECKOUTS.lock() {
        if let Some((_, (seen, found))) = cache.iter().find(|(key, _)| key == folder) {
            if *seen == stamp {
                return Ok(Some(found.clone()));
            }
        }
    }
    let mut command = crate::fs::git_cmd();
    command
        .arg("-C")
        .arg(folder)
        .args(["rev-parse", "--git-common-dir"])
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = match crate::pr_watch::bounded::run(command, std::time::Duration::from_secs(5)) {
        Ok(ran) => ran,
        Err(_) => return Err(unreadable()),
    };
    if !output.status.success() {
        return Err(unreadable());
    }
    let text = output.stdout;
    let Some(common) = text.lines().next() else {
        return Err(unreadable());
    };
    let found = Checkout {
        common: path_key(&folder.join(common.trim()).to_string_lossy()),
    };
    if let Ok(mut cache) = CHECKOUTS.lock() {
        bounded_put(
            &mut cache,
            folder.to_path_buf(),
            (stamp, found.clone()),
            CHECKOUT_CACHE_MAX,
        );
    }
    Ok(Some(found))
}

/// Where a candidate project sits relative to the folder being judged.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Place {
    /// It owns the folder.
    Yes,
    /// It does not.
    No,
    /// Its git dir cannot be read, and neither can the folder's, so the answer is not known.
    Undecided,
}

/// What a caller wants from the owning-project read. `cli` None (or blank) fails closed when a place is undecided.
/// `agent` is an `app-` session, or the launch gate, where the lock can change the answer. `locked_default` is the CLI
/// the lock already granted. That CLI is allowed even when a doubtful project's lock might apply.
pub(crate) struct OwningQuery<'a> {
    pub roots: &'a [String],
    pub cli: Option<&'a str>,
    pub agent: bool,
    pub locked_default: Option<&'a str>,
}

/// The folder's own `.git` cannot be read as a repository. A folder with no `.git` is not unreadable.
fn folder_unreadable(folder_key: &str) -> bool {
    let Some(entry) = git_entry(std::path::Path::new(folder_key)) else {
        return false;
    };
    if common_dir(&entry).is_some() {
        return false;
    }
    !matches!(checkout_of(std::path::Path::new(folder_key)), Ok(Some(_)))
}

fn same_key(left: &std::path::Path, right: &std::path::Path) -> bool {
    path_key(&left.to_string_lossy()) == path_key(&right.to_string_lossy())
}

/// A path written in a git file, absolute or relative to the file that names it.
fn resolve_git_path(base_file: &std::path::Path, raw: &str) -> Option<std::path::PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let path = std::path::Path::new(raw);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_file.parent()?.join(path)
    };
    Some(crate::fs::canonical(&resolved).unwrap_or(resolved))
}

/// The linked worktrees registered on `common`, from `worktrees/*/gitdir`. The top is the parent of the canonical path,
/// and only when that path exists. A name a worker wrote for a path that is not on disk is not a checkout.
fn read_registrations(common: &std::path::Path) -> Vec<Registered> {
    let Ok(read) = std::fs::read_dir(common.join("worktrees")) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for entry in read.flatten() {
        let gitdir = entry.path().join("gitdir");
        let Some(text) = read_git_file(&gitdir) else {
            continue;
        };
        let Some(resolved) = resolve_git_path(&gitdir, text.lines().next().unwrap_or("")) else {
            continue;
        };
        if std::fs::symlink_metadata(&resolved).is_err() {
            continue;
        }
        let top = resolved
            .parent()
            .filter(|top| top.is_dir())
            .map(|top| path_key(&top.to_string_lossy()));
        rows.push(Registered {
            named: Some(resolved),
            top,
        });
    }
    rows
}

/// The registrations of `common`, read from disk at most once for this judgment.
fn cached_regs(cache: &mut RegOnce, common: &std::path::Path) -> Vec<Registered> {
    let key = path_key(&common.to_string_lossy());
    if cache.key.as_deref() != Some(key.as_str()) {
        cache.rows = read_registrations(common);
        cache.key = Some(key);
    }
    cache.rows.clone()
}

/// Whether a registration names this `.git` entry. The named path is the canonical one, so a symlink does not move it.
fn names_entry(regs: &[Registered], entry: &std::path::Path) -> bool {
    let want = path_key(&entry.to_string_lossy());
    regs.iter().any(|row| {
        row.named
            .as_ref()
            .is_some_and(|named| path_key(&named.to_string_lossy()) == want)
    })
}

/// `Some(true)` when `entry` is the main checkout of `common` or a worktree it has registered. `Some(false)` when
/// `entry` is a checkout of `common` but neither of those: its registration is gone, and the main checkout must not
/// stand in for it. `None` when `entry` is not a readable checkout of this common (garbage, or another repository).
fn known_checkout(
    common: &std::path::Path,
    entry: &std::path::Path,
    regs: &[Registered],
) -> Option<bool> {
    let found = common_dir(entry)?;
    if !same_key(&found, common) {
        return None;
    }
    if same_key(entry, common) || names_entry(regs, entry) {
        return Some(true);
    }
    // A main checkout whose `.git` is a file pointing straight at this common dir (a separate git dir).
    let Some(text) = read_git_file(entry) else {
        return Some(false);
    };
    let Some(target) = text.lines().find_map(|line| line.strip_prefix("gitdir:")) else {
        return Some(false);
    };
    let Some(resolved) = resolve_git_path(entry, target) else {
        return Some(false);
    };
    Some(same_key(&resolved, common))
}

/// What sits above the checkout that owns `entry`. An unreadable `.git` is not skipped: walking past it would trust a
/// repository a worker made underneath.
enum Enclosing {
    Found(Vec<std::path::PathBuf>),
    /// A `.git` above the checkout exists, but its common directory cannot be read.
    Unreadable,
    None,
}

/// Every git common directory above the checkout that owns `entry`, nearest first. A repository a worker made between
/// the project and its real checkout does not hide the real one.
fn enclosing_common(entry: &std::path::Path) -> Enclosing {
    let Some(checkout) = entry.parent() else {
        return Enclosing::None;
    };
    let mut found = Vec::new();
    for dir in checkout.ancestors().skip(1) {
        let candidate = dir.join(".git");
        if !candidate.exists() {
            continue;
        }
        match common_dir(&candidate) {
            Some(common) => found.push(common),
            None => return Enclosing::Unreadable,
        }
    }
    if found.is_empty() {
        Enclosing::None
    } else {
        Enclosing::Found(found)
    }
}

/// Yes from any enclosing checkout is Yes, then Undecided from any is Undecided, else No.
fn place_enclosing(
    folder_key: &str,
    root_id: &str,
    outers: &[std::path::PathBuf],
    skip: Option<&std::path::Path>,
    cache: &mut RegOnce,
) -> Place {
    let mut undecided = false;
    for outer in outers {
        if skip.is_some_and(|inner| same_key(inner, outer)) {
            continue;
        }
        match place_inside_common(folder_key, root_id, outer, cache) {
            Place::Yes => return Place::Yes,
            Place::Undecided => undecided = true,
            Place::No => {}
        }
    }
    if undecided {
        Place::Undecided
    } else {
        Place::No
    }
}

/// True when `admin` is `<common>/worktrees/<id>`, one level under `worktrees`, not `worktrees` itself.
fn worktree_admin_of(admin: &std::path::Path, common: &std::path::Path) -> bool {
    let base = path_key(&common.join("worktrees").to_string_lossy());
    let admin_key = path_key(&admin.to_string_lossy());
    if !key_within(&admin_key, &base) || admin_key == base {
        return false;
    }
    let rest = admin_key[base.len()..].trim_start_matches('/');
    !rest.is_empty() && !rest.contains('/')
}

/// The checkout top of a `.git` file that points straight at `common` (a separate git dir, not a linked worktree).
fn checkout_file_top(common: &std::path::Path, root_key: &str) -> Option<String> {
    let entry = git_entry(std::path::Path::new(root_key))?;
    let text = read_git_file(&entry)?;
    let target = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?;
    let resolved = resolve_git_path(&entry, target)?;
    if !same_key(&resolved, common) {
        return None;
    }
    let top = entry.parent()?;
    top.is_dir().then(|| path_key(&top.to_string_lossy()))
}

/// The checkout top of `folder` when its own `.git` file names a linked worktree of `common`. The registration
/// back-pointer is not read: git does not need it to work in the worktree, and a worker can empty it. A file that
/// points at the main git dir, rather than at `worktrees/<id>`, is not a checkout top.
fn folder_checkout_top(folder_key: &str, common: &std::path::Path) -> Option<String> {
    let entry = git_entry(std::path::Path::new(folder_key))?;
    let text = read_git_file(&entry)?;
    let target = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?;
    let admin = resolve_git_path(&entry, target)?;
    if !worktree_admin_of(&admin, common) {
        return None;
    }
    let found = common_dir(&entry)?;
    if !same_key(&found, common) {
        return None;
    }
    let top = entry.parent()?;
    top.is_dir().then(|| path_key(&top.to_string_lossy()))
}

/// The `.git` file still has the shape of a linked worktree (`gitdir:` with a `worktrees` component).
fn linked_worktree_shape(entry: &std::path::Path) -> bool {
    let Some(text) = read_git_file(entry) else {
        return false;
    };
    text.lines().any(|line| {
        let Some(rest) = line.strip_prefix("gitdir:") else {
            return false;
        };
        rest.trim()
            .split(['/', '\\'])
            .any(|part| part == "worktrees")
    })
}

/// The `gitdir:` path is a worktree admin of `common`.
fn shape_under_common(entry: &std::path::Path, common: &std::path::Path) -> bool {
    let Some(text) = read_git_file(entry) else {
        return false;
    };
    let Some(rest) = text.lines().find_map(|line| line.strip_prefix("gitdir:")) else {
        return false;
    };
    let Some(admin) = resolve_git_path(entry, rest) else {
        return false;
    };
    worktree_admin_of(&admin, common)
}

/// The root's git dir cannot be read. The root's top is judged through the enclosing checkout. An enclosing `.git`
/// that cannot be read is undecided, not skipped. With nothing above the root, the folder's own common dir (from its
/// files, not from git) keeps the place when it still registers the root, or when the root's `.git` still has the
/// shape of a linked worktree of that common. A folder in another repository, or a folder with no git, stays unowned.
fn place_unreadable_root(folder_key: &str, root_key: &str, cache: &mut RegOnce) -> Place {
    let Some(entry) = git_entry(std::path::Path::new(root_key)) else {
        return if folder_unreadable(folder_key) {
            Place::Undecided
        } else {
            Place::No
        };
    };
    match enclosing_common(&entry) {
        Enclosing::Unreadable => Place::Undecided,
        Enclosing::Found(outers) => {
            let placed = place_enclosing(folder_key, root_key, &outers, None, cache);
            if placed == Place::No && folder_unreadable(folder_key) {
                Place::Undecided
            } else {
                placed
            }
        }
        Enclosing::None => place_with_no_enclosing(folder_key, root_key, &entry, cache),
    }
}

/// Nothing encloses the unreadable root. Fail closed when this folder's repository still lists it, or when the root's
/// `.git` still looks like one of that repository's linked worktrees. Anything else is not owned.
fn place_with_no_enclosing(
    folder_key: &str,
    root_key: &str,
    entry: &std::path::Path,
    cache: &mut RegOnce,
) -> Place {
    let folder_entry = git_entry(std::path::Path::new(folder_key));
    if let Some(common) = folder_entry.as_ref().and_then(|item| common_dir(item)) {
        let regs = cached_regs(cache, &common);
        if names_entry(&regs, entry) {
            let placed = place_inside_common(folder_key, root_key, &common, cache);
            return if placed == Place::No {
                Place::Undecided
            } else {
                placed
            };
        }
        if linked_worktree_shape(entry) && shape_under_common(entry, &common) {
            return Place::Undecided;
        }
    }
    if folder_unreadable(folder_key) {
        Place::Undecided
    } else {
        Place::No
    }
}

/// Membership from git, used when the project's files do not name a common directory (a bare repo, or a broken one).
/// The common dir git reads for the root is what decides. The folder's own `.git` is not, and neither is a top git
/// would report from `core.worktree`.
fn place_by_git(folder_key: &str, root_key: &str, cache: &mut RegOnce) -> Place {
    let theirs = match checkout_of(std::path::Path::new(root_key)) {
        Ok(Some(checkout)) => checkout,
        Ok(None) | Err(_) => return place_unreadable_root(folder_key, root_key, cache),
    };
    let placed = place_inside_common(
        folder_key,
        root_key,
        std::path::Path::new(&theirs.common),
        cache,
    );
    if placed == Place::No && folder_unreadable(folder_key) {
        return Place::Undecided;
    }
    placed
}

/// Checkouts of this common dir. The main checkout when its git dir is named `.git`. Otherwise the parent of a `.git`
/// file that points straight at this common (a separate git dir). Then every registered worktree whose named path
/// exists, and the folder's own checkout when its `.git` file names a linked worktree of this common. Git is not asked
/// for a top.
fn checkout_tops(
    common: &std::path::Path,
    root_key: &str,
    folder_key: &str,
    regs: &[Registered],
) -> Vec<String> {
    let mut tops = Vec::new();
    if let Some(main) = main_checkout_top(common) {
        tops.push(main);
    } else if let Some(top) = checkout_file_top(common, root_key) {
        tops.push(top);
    }
    for top in regs.iter().filter_map(|row| row.top.clone()) {
        if !tops.iter().any(|have| have == &top) {
            tops.push(top);
        }
    }
    if let Some(top) = folder_checkout_top(folder_key, common) {
        if !tops.iter().any(|have| have == &top) {
            tops.push(top);
        }
    }
    tops
}

/// Membership from the project's side. The project's top is the longest checkout that contains the project, ignoring a
/// top a worker registered between the main checkout and the project unless that registration's `.git` file points
/// back at this common. The folder is owned when any top that contains it maps into that project. A checkout of this
/// common that is neither the main `.git` nor a registered worktree is undecided, so a broken registration is not
/// measured from the main checkout. The registrations are the list already read for this common.
fn place_inside_common(
    folder_key: &str,
    root_id: &str,
    common: &std::path::Path,
    cache: &mut RegOnce,
) -> Place {
    let root_key = path_key(root_id);
    let regs = cached_regs(cache, common);
    if let Some(entry) = git_entry(std::path::Path::new(&root_key)) {
        if known_checkout(common, &entry, &regs) == Some(false) {
            return Place::Undecided;
        }
    }
    let tops = checkout_tops(common, &root_key, folder_key, &regs);
    // Every top that contains the project measures it: a top a worker registered between the main checkout and the
    // project cannot replace the main checkout's measure, only add to it.
    let project_tops: Vec<&String> = tops
        .iter()
        .filter(|top| key_within(&root_key, top))
        .collect();
    if project_tops.is_empty() {
        return Place::Undecided;
    }
    let mut saw_folder = false;
    let mut undecided = false;
    for top in &tops {
        if !key_within(folder_key, top) {
            continue;
        }
        saw_folder = true;
        for project_top in &project_tops {
            match owns_within_checkout(folder_key, top, &root_key, project_top) {
                Ok(true) => return Place::Yes,
                Ok(false) => {}
                Err(_) => undecided = true,
            }
        }
    }
    if !saw_folder {
        // A folder whose own git still names this repository is a checkout of it, even when its registration or admin
        // dir was moved out of the tops.
        return if folder_names_common(folder_key, common) {
            Place::Undecided
        } else {
            Place::No
        };
    }
    if undecided {
        Place::Undecided
    } else {
        Place::No
    }
}

/// The folder's `.git` names `common`, read from its files or, failing that, from git.
fn folder_names_common(folder_key: &str, common: &std::path::Path) -> bool {
    let Some(entry) = git_entry(std::path::Path::new(folder_key)) else {
        return false;
    };
    if common_dir(&entry).is_some_and(|found| same_key(&found, common)) {
        return true;
    }
    matches!(checkout_of(std::path::Path::new(folder_key)), Ok(Some(found)) if found.common == path_key(&common.to_string_lossy()))
}

fn place_project(folder_key: &str, root_id: &str) -> Place {
    let root_key = path_key(root_id);
    if root_key.is_empty() {
        return Place::No;
    }
    // A folder inside the project's own folder is owned before any git read, so a fifo `.git` on the project does
    // not stall a launch inside it.
    if key_within(folder_key, &root_key) {
        return Place::Yes;
    }
    let Some(entry) = git_entry(std::path::Path::new(&root_key)) else {
        return Place::No;
    };
    let mut cache = RegOnce {
        key: None,
        rows: Vec::new(),
    };
    let direct = if let Some(common) = common_dir(&entry) {
        place_inside_common(folder_key, root_id, &common, &mut cache)
    } else {
        place_by_git(folder_key, &root_key, &mut cache)
    };
    if direct == Place::Yes {
        return Place::Yes;
    }
    // A repository made above the project, or an enclosing checkout the project's own `.git` hides. Yes from either
    // side is Yes. An enclosing `.git` that cannot be read is doubt, not a reason to trust the inner repository.
    match enclosing_common(&entry) {
        Enclosing::Found(outers) => {
            let inner = common_dir(&entry);
            match place_enclosing(folder_key, root_id, &outers, inner.as_deref(), &mut cache) {
                Place::Yes => Place::Yes,
                Place::Undecided => Place::Undecided,
                Place::No => direct,
            }
        }
        Enclosing::Unreadable => Place::Undecided,
        Enclosing::None => direct,
    }
}

/// Saved project ids, then any hub root that is not already one of them (the crew row's spelling wins).
fn candidate_ids(conn: &Connection, roots: &[String]) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT DISTINCT scope_id FROM crew_rule_meta WHERE scope = 'project'")
        .map_err(|error| error.to_string())?;
    let mut ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|error| error.to_string())?;
    for root in roots {
        let root = root.trim();
        if root.is_empty() {
            continue;
        }
        let key = path_key(root);
        if key.is_empty() || ids.iter().any(|id| path_key(id) == key) {
            continue;
        }
        ids.push(root.to_string());
    }
    Ok(ids)
}

/// An undecided place refuses when the caller did not name a CLI, or when one of those projects' own saved policy
/// would change the answer: the CLI is on its Never use list, or its lock is on and this is an agent launch.
fn doubtful_refuses(
    conn: &Connection,
    ids: &[String],
    query: &OwningQuery,
) -> Result<bool, String> {
    let Some(cli) = query.cli.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(true);
    };
    for id in ids {
        let Some(policy) = saved_policy(conn, "project", id)? else {
            continue;
        };
        if listed_never_use(&policy).iter().any(|banned| banned == cli) {
            return Ok(true);
        }
        if query.agent && policy.get("lockDefault").and_then(Value::as_bool) == Some(true) {
            // The CLI this launch was already granted is allowed either way. Any other CLI is still refused.
            let granted = query
                .locked_default
                .map(str::trim)
                .filter(|id| !id.is_empty());
            if granted != Some(cli) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn specific_first(ids: &mut [String]) {
    ids.sort_by(|left, right| {
        let left_key = path_key(left);
        let right_key = path_key(right);
        right_key
            .len()
            .cmp(&left_key.len())
            .then_with(|| left_key.cmp(&right_key))
    });
}

/// Every hub project that owns a folder. A project owns a folder when the folder is inside the project's folder, or
/// when the project's git dir (its main checkout and its registered worktrees) contains the folder. The folder's own
/// `.git` is not what decides that. A place that cannot be read refuses only when a doubtful project's own policy
/// could change the answer for this CLI. Callers that pass no CLI fail closed.
pub(crate) fn projects_owning_for(
    conn: &Connection,
    folder: &str,
    query: &OwningQuery,
) -> Result<Vec<String>, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Ok(Vec::new());
    }
    let here = path_key(&crate::delivery::settings::key(folder));
    let mut owners = Vec::new();
    let mut doubtful = Vec::new();
    for id in candidate_ids(conn, query.roots)? {
        match place_project(&here, &id) {
            Place::Yes => owners.push(owner_spelling(query.roots, id)),
            Place::No => {}
            Place::Undecided => doubtful.push(id),
        }
    }
    if !doubtful.is_empty() && doubtful_refuses(conn, &doubtful, query)? {
        return Err(
            "The crew policy could not be read, so nothing was started (a folder's place in its git checkout could not be decided)."
                .to_string(),
        );
    }
    specific_first(&mut owners);
    Ok(owners)
}

/// When the caller passed a hub root for this project, the owner comes back in that root's spelling. The webview maps
/// an owner to its hub project by the text it sent.
fn owner_spelling(roots: &[String], id: String) -> String {
    let key = path_key(&id);
    roots
        .iter()
        .find(|root| path_key(root.trim()) == key)
        .map(|root| root.trim().to_string())
        .unwrap_or(id)
}

pub(crate) fn projects_owning(conn: &Connection, folder: &str) -> Result<Vec<String>, String> {
    projects_owning_for(
        conn,
        folder,
        &OwningQuery {
            roots: &[],
            cli: None,
            agent: false,
            locked_default: None,
        },
    )
}

/// Every project that owns one of the folders, each once. The same refusal rule as `projects_owning_for`.
pub(crate) fn projects_owning_all_for(
    conn: &Connection,
    folders: &[String],
    query: &OwningQuery,
) -> Result<Vec<String>, String> {
    let mut projects: Vec<String> = Vec::new();
    for folder in folders {
        for owner in projects_owning_for(conn, folder, query)? {
            if !projects
                .iter()
                .any(|have| path_key(have) == path_key(&owner))
            {
                projects.push(owner);
            }
        }
    }
    specific_first(&mut projects);
    Ok(projects)
}

/// Every project that owns one of the folders, each once. A place that cannot be read refuses the read.
pub(crate) fn projects_owning_all(
    conn: &Connection,
    folders: &[String],
) -> Result<Vec<String>, String> {
    projects_owning_all_for(
        conn,
        folders,
        &OwningQuery {
            roots: &[],
            cli: None,
            agent: false,
            locked_default: None,
        },
    )
}

pub(crate) fn policy_for_all(
    conn: &Connection,
    mono: Option<&str>,
    projects: &[String],
) -> Result<Value, String> {
    let mut scopes = Vec::new();
    if let Some(id) = mono.map(str::trim).filter(|id| !id.is_empty()) {
        scopes.extend(saved_policy(conn, "mono", id)?);
    }
    for id in projects {
        scopes.extend(saved_policy(conn, "project", id)?);
    }
    scopes.push(
        saved_policy(conn, "system", "system")?.unwrap_or_else(|| sanitize_policy(&Value::Null)),
    );
    Ok(union_policy(&scopes))
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

/// A saved policy is the column, not a missing row. No column means this scope has nothing to apply.
fn saved_policy(conn: &Connection, scope: &str, raw: &str) -> Result<Option<Value>, String> {
    let Ok((scope, id)) = scope_key(scope, raw) else {
        return Ok(None);
    };
    let (_, _, text) = meta(conn, &scope, &id)?;
    // Round 9 (LOW-1): a project saved before its folder existed is stored under the spelling it had then. Once the
    // folder exists the same spelling is found again here, so the saved row still applies.
    let text = match text {
        Some(text) => Some(text),
        None if scope == "project" && raw.trim() != id => meta(conn, &scope, raw.trim())?.2,
        None => None,
    };
    text.map(|text| policy_value(Some(text))).transpose()
}

/// Whether any saved policy, in any scope, has the lock on.
pub fn any_lock(conn: &Connection) -> Result<bool, String> {
    let mut statement = conn
        .prepare("SELECT policy FROM crew_rule_meta WHERE policy IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let text = row.map_err(|e| e.to_string())?;
        if policy_value(Some(text))?
            .get("lockDefault")
            .and_then(Value::as_bool)
            == Some(true)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// One policy from several scopes: Never use is the union, the lock is on when any scope sets it, and the fallback
/// order is the first non-empty one (the scopes come most specific first).
fn union_policy(scopes: &[Value]) -> Value {
    let lock = scopes
        .iter()
        .any(|policy| policy.get("lockDefault").and_then(Value::as_bool) == Some(true));
    let mut never: Vec<String> = Vec::new();
    for policy in scopes {
        for id in listed_never_use(policy) {
            if !never.contains(&id) {
                never.push(id);
            }
        }
    }
    let fallback = scopes
        .iter()
        .map(|policy| {
            policy
                .get("fallback")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .find(|list| !list.is_empty())
        .unwrap_or_default();
    json!({ "lockDefault": lock, "neverUse": never, "fallback": fallback })
}

fn policy_in_force(conn: &Connection, query: &RouteQuery) -> Result<Value, String> {
    // Round 7: the route reads the policy of every project that owns its folder, as a launch does.
    let folders: Vec<String> = query.project.iter().cloned().collect();
    let projects = projects_owning_all(conn, &folders)?;
    policy_for_all(conn, query.mono.as_deref(), &projects)
}

/// The rules in force for a query: the Mono's (carried, else stored), then the project's, then the system's, then plugins'.
fn merged_rules(
    conn: &Connection,
    query: &RouteQuery,
    plugins: &[Rule],
) -> Result<Vec<Rule>, String> {
    let stored = match query
        .mono
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => load_optional(conn, "mono", id)?,
        None => Vec::new(),
    };
    // WP-21: rules stored on the Mono beat a copy in the crew table, then the project's, then the
    // system's (the screen saves role rows there when there is no project), then plugins'.
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
    let system = load_optional(conn, "system", "system")?;
    Ok(rules::merge_rules(&mono, &project, &system, plugins))
}

pub fn route_at(
    conn: &Connection,
    query: &RouteQuery,
    plugins: &[Rule],
    now: i64,
) -> Result<Route, String> {
    let merged = merged_rules(conn, query, plugins)?;
    let policy = policy_in_force(conn, query)?;
    let lock = policy.get("lockDefault").and_then(Value::as_bool) == Some(true);
    let never = listed_never_use(&policy);
    let mut route = resolve_route(
        &query.labels,
        &query.paths,
        query.override_pick.as_ref(),
        query.brief.as_ref(),
        &merged,
        &query.present,
        query.defaults.as_ref(),
        &query.catalog,
        Some(&policy),
    );
    route.never = never.clone();
    route.lock = lock;
    let cooled = cooled_clis(conn, now)?;
    if route.cli_from != "override" {
        if let Some(cli) = route.cli.clone() {
            if cooled.iter().any(|have| have == &cli) {
                // WP-141: the lock means this CLI stays. An empty policy still moves to the next signed-in CLI.
                if lock {
                    route.skipped.push(Skipped {
                        field: "cli".into(),
                        from: route.cli_from.clone(),
                        value: cli,
                        reason: "Always use my default is on, so another CLI was not used.".into(),
                    });
                } else {
                    let next = default_cli_except(&query.present, &cooled, &never);
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
    }
    Ok(route)
}

/// The Never use list a policy names, as the resolver reads it.
fn listed_never_use(policy: &Value) -> Vec<String> {
    policy
        .get("neverUse")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// WP-141: a Mono the first mate may hand the brief to (a Lead it can brief), as the webview names it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickMono {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub depth: i64,
}

/// WP-141: what the first mate's pick asks. The route fields are the same as `crew_route`'s.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickRequest {
    #[serde(flatten)]
    pub route: RouteQuery,
    #[serde(default)]
    pub monos: Vec<PickMono>,
    /// The Mono leading this chat. It is not a candidate for its own brief.
    #[serde(default)]
    pub lead_mono_id: Option<String>,
    /// How deep this chat sits. Depth 2 or more refuses another Mono.
    #[serde(default)]
    pub depth: i64,
    /// CLI or Mono ids already at the project worker cap.
    #[serde(default)]
    pub at_cap: Vec<String>,
    /// A Mono the first mate asks for. Dropped, like a CLI override, when Always use my default is on.
    #[serde(default)]
    pub mono_override: Option<String>,
}

fn ask_of(pick: Option<&Pick>, mono: Option<&String>) -> Option<pick::Ask> {
    if pick.is_none() && mono.is_none() {
        return None;
    }
    Some(pick::Ask {
        cli: pick.and_then(|row| row.cli.clone()),
        model: pick.and_then(|row| row.model.clone()),
        effort: pick.and_then(|row| row.effort.clone()),
        mono_id: mono.cloned(),
    })
}

/// WP-141: the first mate's pick, from the stored rules and policy, who is signed in and who is cooling down after an
/// account failure. The same resolver as `route_at`; nothing is written.
pub fn pick_at(
    conn: &Connection,
    request: &PickRequest,
    plugins: &[Rule],
    now: i64,
) -> Result<pick::MatePick, String> {
    let query = &request.route;
    let rules = merged_rules(conn, query, plugins)?;
    let policy = policy_in_force(conn, query)?;
    let paused_clis = cooled_clis(conn, now)?;
    let monos = request
        .monos
        .iter()
        .map(|mono| pick::MonoCandidate {
            id: mono.id.clone(),
            name: mono.name.clone(),
            role: mono.role.clone(),
            depth: mono.depth,
        })
        .collect();
    Ok(pick::pick_mate(&pick::PickQuery {
        labels: query.labels.clone(),
        paths: query.paths.clone(),
        rules,
        present: query.present.clone(),
        policy: Some(policy),
        defaults: query.defaults.clone(),
        catalog: query.catalog.clone(),
        monos,
        lead_mono_id: request.lead_mono_id.clone(),
        depth: request.depth,
        paused_clis,
        at_cap: request.at_cap.clone(),
        override_pick: ask_of(query.override_pick.as_ref(), request.mono_override.as_ref()),
        brief: ask_of(query.brief.as_ref(), None),
    }))
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
        let (_, text, _) = meta(conn, &scope, &id)?;
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

fn write_decision(tx: &Connection, id: &str, decision: &Decision) -> Result<(), String> {
    for skip in &decision.skipped {
        append_attempt(tx, id, skip)?;
    }
    append_attempt(tx, id, &decision.attempt)
}

fn record_failure(
    tx: &Connection,
    input: &FailureQuery,
    now: i64,
) -> Result<Result<Decision, FailureResult>, String> {
    let folders: Vec<String> = input.project.iter().cloned().collect();
    let projects = projects_owning_all(tx, &folders)?;
    let policy = policy_for_all(tx, input.mono.as_deref(), &projects)?;
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
            policy: Some(&policy),
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
        policy: Some(&policy),
    });
    if decision.action == "resume" {
        return Ok(Err(result_of(&decision, false)));
    }
    if decision.action == "pause" {
        write_decision(tx, &row.id, &decision)?;
        write_hold(
            tx,
            &row.id,
            &row.child_session,
            decision.until.unwrap_or(now),
            &input.current,
        )?;
    } else {
        write_decision(tx, &row.id, &decision)?;
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
        reason: "Waiting for a usage limit to reset".into(),
        applied: true,
    })
}
