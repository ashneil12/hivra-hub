//! Crew rules, the attempt ledger and usage-limit holds. A delegation row is not given a new column:
//! `delegations` is positional upstream. Two windows compare-and-swap the revision. A usage-limit note
//! records a hold for display and does not change the row. The app resumes that chat itself.

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
        let draft = RuleDraft {
            labels: rule.labels.clone(),
            paths: rule.paths.clone(),
            cli: rule.cli.clone(),
            model: rule.model.clone(),
            effort: rule.effort.clone(),
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
}

/// How long a grant may go unused before it is pruned. Every judged start of the session refreshes it, so a worker
/// that is still running, resumed or typed into keeps its decision. Sessions have no delete hook in the crew store.
pub const GRANT_IDLE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Saves the decision for a session. A later launch of that session replaces it. Grants idle past `GRANT_IDLE_MS` go.
pub fn save_grant(conn: &Connection, session: &str, grant: &Grant, at: i64) -> Result<(), String> {
    prune_grants(conn, at)?;
    conn.execute(
        "INSERT OR REPLACE INTO crew_grants (session, mono, project, locked_default, granted_at, last_used) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![session, grant.mono, grant.project, grant.locked_default, at],
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
/// project (its folder), or everything. None when no saved scope lists it.
pub(crate) fn never_use_scope(
    conn: &Connection,
    mono: Option<&str>,
    project: Option<&str>,
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
    if let Some(id) = project.map(str::trim).filter(|id| !id.is_empty()) {
        if lists(saved_policy(conn, "project", id)?) {
            return Ok(Some(format!("this project ({id})")));
        }
    }
    if lists(saved_policy(conn, "system", "system")?) {
        return Ok(Some("everything (the system default)".into()));
    }
    Ok(None)
}

pub fn grant_of(conn: &Connection, session: &str) -> Result<Option<Grant>, String> {
    conn.query_row(
        "SELECT mono, project, locked_default FROM crew_grants WHERE session = ?1",
        params![session],
        |row| {
            Ok(Grant {
                mono: row.get(0)?,
                project: row.get(1)?,
                locked_default: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

/// The git common directory of a folder that exists. A linked worktree and its main checkout share one.
fn common_dir(folder: &std::path::Path) -> Option<std::path::PathBuf> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    std::fs::canonicalize(folder.join(raw.trim())).ok()
}

/// The hub project that owns a folder: the one whose git common directory the folder shares (a worktree counts),
/// else the deepest one the folder sits inside. None when no project owns it, so only the system's policy applies.
pub(crate) fn project_owning(conn: &Connection, folder: &str) -> Result<Option<String>, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Ok(None);
    }
    let here = std::path::PathBuf::from(crate::delivery::settings::key(folder));
    let here_common = common_dir(&here);
    let mut statement = conn
        .prepare("SELECT DISTINCT scope_id FROM crew_rule_meta WHERE scope = 'project'")
        .map_err(|error| error.to_string())?;
    let projects = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut inside: Option<(usize, String)> = None;
    for project in projects {
        let project = project.map_err(|error| error.to_string())?;
        let root = std::path::PathBuf::from(&project);
        if let (Some(mine), Some(theirs)) = (&here_common, common_dir(&root)) {
            if *mine == theirs {
                return Ok(Some(project));
            }
        }
        if here.starts_with(&root) {
            let depth = root.components().count();
            if inside.as_ref().is_none_or(|(best, _)| depth > *best) {
                inside = Some((depth, project));
            }
        }
    }
    Ok(inside.map(|(_, project)| project))
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
    text.map(|text| policy_value(Some(text))).transpose()
}

/// The policy in force for a launch: the union of the Mono's, the project's and the system's saved policies.
/// Never use is every scope's list together, so a "For everything" ban reaches every project. The lock is on when any
/// scope sets it. The fallback order is the most specific one saved (Mono, then project, then system).
pub(crate) fn policy_for(
    conn: &Connection,
    mono: Option<&str>,
    project: Option<&str>,
) -> Result<Value, String> {
    let mut scopes = Vec::new();
    if let Some(id) = mono.map(str::trim).filter(|id| !id.is_empty()) {
        scopes.extend(saved_policy(conn, "mono", id)?);
    }
    if let Some(id) = project.map(str::trim).filter(|id| !id.is_empty()) {
        scopes.extend(saved_policy(conn, "project", id)?);
    }
    scopes.push(
        saved_policy(conn, "system", "system")?.unwrap_or_else(|| sanitize_policy(&Value::Null)),
    );
    Ok(union_policy(&scopes))
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
    policy_for(conn, query.mono.as_deref(), query.project.as_deref())
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
    let policy = policy_for(tx, input.mono.as_deref(), input.project.as_deref())?;
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
