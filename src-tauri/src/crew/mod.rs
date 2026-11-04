//! Hivra WP-13: which CLI, model and effort a task uses, and the move to the next worker when the
//! account can't take it. The same rules live in `src/features/crew` for Settings. This side is the
//! one the watcher tick runs, so a usage limit resumes without a person sitting here.
//!
//! Nothing here starts a CLI or makes a network call. Which CLIs are signed in is handed in.

mod budget;
mod failure;
mod reroute;
mod resolve;
mod rules;
mod store;

#[cfg(test)]
mod tests;

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::session_store::{now_millis, SessionStore};

pub(crate) use store::{ensure_tables, resume_due};

use resolve::Presence;
use rules::Rule;
use store::{FailureQuery, RouteQuery, RuleDraft, StoredRules};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RulesResponse {
    rules: Vec<Rule>,
    plugins: Vec<Rule>,
    revision: i64,
    budget: Option<serde_json::Value>,
    /// Empty: a live sign-in check would use the network. The route command takes the list it is given.
    signed_in: Vec<Presence>,
}

fn response(stored: StoredRules, plugins: Vec<Rule>) -> RulesResponse {
    RulesResponse {
        rules: stored.rules,
        plugins,
        revision: stored.revision,
        budget: stored.budget,
        signed_in: Vec::new(),
    }
}

/// Enabled plugins' `hivra/crew-rules.json`, in registry name order. A missing registry or a broken file adds nothing.
fn plugin_rules(app: &tauri::AppHandle, project: Option<&str>) -> Vec<Rule> {
    let Ok(host) = crate::plugins::host(app) else {
        return Vec::new();
    };
    let Ok(registry) = crate::plugins::registry::read(&host) else {
        return Vec::new();
    };
    let cwd = project_cwd(project);
    let mut rules = Vec::new();
    for (name, entry) in &registry.plugins {
        if !entry.active_for(cwd.as_deref()) {
            continue;
        }
        push_plugin(&host, name, &mut rules);
    }
    rules
}

fn project_cwd(project: Option<&str>) -> Option<PathBuf> {
    let project = project?.trim();
    if project.is_empty() {
        return None;
    }
    Some(crate::fs::expand_home(project))
}

fn push_plugin(host: &crate::plugins::Host, name: &str, rules: &mut Vec<Rule>) {
    let mut reports = Vec::new();
    let loaded = crate::plugins::hivra::load(&host.installed(name), &mut reports);
    for rule in loaded.crew_rules {
        rules.push(rules::from_plugin(rule, name));
    }
}

#[tauri::command(async)]
pub fn crew_rules_get(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    scope: String,
    scope_id: String,
    project: Option<String>,
) -> Result<RulesResponse, String> {
    let stored = store::get_rules(&*store.lock_conn()?, &scope, &scope_id)?;
    Ok(response(stored, plugin_rules(&app, project.as_deref())))
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // one field per invoke argument, same names as the page sends
pub fn crew_rules_set(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    scope: String,
    scope_id: String,
    rules: Vec<RuleDraft>,
    revision: i64,
    budget: Option<serde_json::Value>,
    project: Option<String>,
) -> Result<RulesResponse, String> {
    let stored = store::set_rules(
        &mut *store.lock_conn()?,
        &scope,
        &scope_id,
        &rules,
        revision,
        budget.as_ref(),
    )?;
    Ok(response(stored, plugin_rules(&app, project.as_deref())))
}

#[tauri::command(async)]
pub fn crew_route(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    query: RouteQuery,
) -> Result<resolve::Route, String> {
    let plugins = plugin_rules(&app, query.project.as_deref());
    store::route(&*store.lock_conn()?, &query, &plugins)
}

#[tauri::command(async)]
pub fn crew_on_failure(
    store: State<'_, SessionStore>,
    input: FailureQuery,
) -> Result<store::FailureResult, String> {
    store::on_failure(&mut *store.lock_conn()?, &input, now_millis())
}
