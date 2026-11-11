//! Hivra WP-13: which CLI, model and effort a task uses, and what to do when the account can't take it.
//! The same rules live in `src/features/crew` for Settings.
//!
//! Nothing here starts a CLI or makes a network call. A usage limit is only noted. The app resumes that
//! chat. The store takes the signed-in list it is given. Settings and an empty route list read the
//! account files the CLIs already wrote.

mod budget;
pub(crate) mod failure; // WP-180a: automations maps a run's error class through sanitize_class.
pub(crate) mod gate;
mod pick;
mod policy;
mod reroute;
pub(crate) mod resolve;
mod rules;
mod store;

#[cfg(test)]
mod review_141d_tests;
#[cfg(test)]
mod review_r10_lead_tests;
#[cfg(test)]
mod review_r10_tests;
#[cfg(test)]
mod review_r11_tests;
#[cfg(test)]
mod review_r12_lead_tests;
#[cfg(test)]
mod review_r12_tests;
#[cfg(test)]
mod review_r247_r1_tests;
#[cfg(test)]
mod review_r247_r2_tests;
#[cfg(test)]
mod tests;

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::session_store::{now_millis, SessionStore};

pub(crate) use store::ensure_tables;

use resolve::Presence;
use rules::Rule;
use store::{FailureQuery, RouteQuery, RuleDraft, StoredRules};

use crate::plugins::hivra::CREW_CLIS;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RulesResponse {
    rules: Vec<Rule>,
    plugins: Vec<Rule>,
    revision: i64,
    budget: Option<serde_json::Value>,
    /// Installed and signed-in CLIs, from the files the CLIs already wrote. Nothing is asked over the network.
    signed_in: Vec<Presence>,
    /// WP-141: always use my default, never use, and the fallback order.
    policy: serde_json::Value,
    /// WP-141: false when this scope has no policy of its own, so `policy` is the one it inherits.
    policy_own: bool,
    /// Round 6: the saved policy does not parse; Ash's explicit save replaces it.
    policy_unreadable: bool,
}

fn response(stored: StoredRules, plugins: Vec<Rule>, signed_in: Vec<Presence>) -> RulesResponse {
    RulesResponse {
        rules: stored.rules,
        plugins,
        revision: stored.revision,
        budget: stored.budget,
        signed_in,
        policy: stored.policy,
        policy_own: stored.policy_own,
        policy_unreadable: stored.policy_unreadable,
    }
}

/// One row per crew CLI. `installed` and `signed_in` are handed in so a test does not depend on this machine.
pub(crate) fn crew_presence(
    installed: impl Fn(&str) -> bool,
    signed_in: impl Fn(&str) -> bool,
) -> Vec<Presence> {
    CREW_CLIS
        .iter()
        .map(|cli| Presence {
            cli: (*cli).to_string(),
            installed: installed(cli),
            signed_in: signed_in(cli),
        })
        .collect()
}

/// An empty list means "look it up". A caller that already named who is here is left as it said.
pub(crate) fn fill_present(present: &mut Vec<Presence>, live: Vec<Presence>) {
    if present.is_empty() {
        *present = live;
    }
}

fn cli_installed(cli: &str) -> bool {
    match cli {
        "claude" => crate::harness::harness_resolve_claude().is_ok(),
        "codex" => crate::harness::harness_resolve_codex().is_ok(),
        "cursor" => crate::harness::harness_resolve_cursor().is_ok(),
        "opencode" => crate::harness::harness_resolve_opencode().is_ok(),
        "pi" => crate::harness::harness_resolve_pi().is_ok(),
        "omp" => crate::harness::harness_resolve_omp().is_ok(),
        "fx" => crate::harness::harness_resolve_fx().is_ok(),
        "grok" => crate::harness::harness_resolve_grok().is_ok(),
        "hermes" => crate::harness::harness_resolve_hermes().is_ok(),
        "devin" => crate::harness::harness_resolve_devin().is_ok(),
        "antigravity" => crate::harness::harness_resolve_antigravity().is_ok(),
        _ => false,
    }
}

/// Claude in a dev copy is that copy's config folder. A failure to find it is "not signed in", never the daily file.
fn claude_signed_in(app: &tauri::AppHandle) -> bool {
    match crate::harness::provider_account_dir(app, "claude", None) {
        Ok(dir) => crate::account_identity::cached_signed_in("claude", dir.as_deref()),
        Err(_) => false,
    }
}

pub(crate) fn live_presence(app: &tauri::AppHandle) -> Vec<Presence> {
    crew_presence(cli_installed, |cli| {
        if cli == "claude" {
            claude_signed_in(app)
        } else {
            crate::account_identity::cached_signed_in(cli, None)
        }
    })
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
    Ok(response(
        stored,
        plugin_rules(&app, project.as_deref()),
        live_presence(&app),
    ))
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
    Ok(response(
        stored,
        plugin_rules(&app, project.as_deref()),
        live_presence(&app),
    ))
}

/// WP-141: the lock, the never-use list and the fallback order. The same revision as the rules.
#[tauri::command(async)]
pub fn crew_policy_set(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    scope: String,
    scope_id: String,
    policy: serde_json::Value,
    revision: i64,
    project: Option<String>,
) -> Result<RulesResponse, String> {
    let stored = store::set_policy(
        &mut *store.lock_conn()?,
        &scope,
        &scope_id,
        &policy,
        revision,
    )?;
    Ok(response(
        stored,
        plugin_rules(&app, project.as_deref()),
        live_presence(&app),
    ))
}

#[tauri::command(async)]
pub fn crew_route(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    mut query: RouteQuery,
) -> Result<resolve::Route, String> {
    fill_present(&mut query.present, live_presence(&app));
    let plugins = plugin_rules(&app, query.project.as_deref());
    store::route_at(&*store.lock_conn()?, &query, &plugins, now_millis())
}

/// WP-141: the first mate's pick across CLIs and Monos, with its reason. Reads only.
#[tauri::command(async)]
pub fn crew_pick(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    mut request: store::PickRequest,
) -> Result<pick::MatePick, String> {
    fill_present(&mut request.route.present, live_presence(&app));
    let plugins = plugin_rules(&app, request.route.project.as_deref());
    store::pick_at(&*store.lock_conn()?, &request, &plugins, now_millis())
}

/// WP-141: the gate a worker or session launch passes before its process starts. Refuses with one plain line. A
/// launch that passes is recorded for its session, so the spawn that follows is judged against the same default.
#[tauri::command(async)]
pub fn crew_launch_check(
    store: State<'_, SessionStore>,
    input: gate::LaunchCheck,
    session_id: Option<String>,
    parent_session: Option<String>,
) -> Result<(), String> {
    let conn = store.lock_conn()?;
    let parent = parent_session
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(parent) = parent {
        gate::check_launch_with(&conn, &input, Some(parent))?;
    } else {
        gate::check_launch(&conn, &input)?;
    }
    match session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(session) => match parent {
            Some(parent) => gate::record_grant_with(&conn, session, &input, Some(parent)),
            None => gate::record_grant(&conn, session, &input),
        },
        None => Ok(()),
    }
}

/// WP-141: the one-time ticket `harness_spawn` requires for an agent session's process. Judged at the spawn itself.
#[tauri::command(async)]
pub fn crew_spawn_ticket(
    store: State<'_, SessionStore>,
    session_id: String,
    cli: String,
    folder: String,
) -> Result<String, String> {
    gate::issue_ticket(&*store.lock_conn()?, &session_id, &cli, &folder)
}

/// Round 6: the OpenCode 2.x bind. The service start and the session create happen only after this consumes the ticket
/// `crew_spawn_ticket` minted for the same session, CLI and folder.
#[tauri::command(async)]
pub fn crew_bind_v2_session(
    store: State<'_, SessionStore>,
    session_id: String,
    cli: String,
    folder: String,
    ticket: Option<String>,
) -> Result<(), String> {
    gate::bind_v2_session(
        &*store.lock_conn()?,
        &session_id,
        &cli,
        &folder,
        ticket.as_deref(),
    )
}

/// WP-141: whether any saved crew policy, in any scope, has the lock on. A chat's default change is refused then.
#[tauri::command(async)]
pub fn crew_any_lock(store: State<'_, SessionStore>) -> Result<bool, String> {
    store::any_lock(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn crew_note_pause(
    store: State<'_, SessionStore>,
    input: store::PauseQuery,
) -> Result<store::FailureResult, String> {
    store::note_pause(&mut *store.lock_conn()?, &input, now_millis())
}

#[tauri::command(async)]
pub fn crew_on_failure(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    mut input: FailureQuery,
) -> Result<store::FailureResult, String> {
    fill_present(&mut input.present, live_presence(&app));
    store::on_failure(&mut *store.lock_conn()?, &input, now_millis())
}

/// Round 9 (LOW-3): the saved projects that own a folder, for the Lead's policy read.
/// Round 11: `roots` are hub project folders that have no crew row yet, so a worker default there still applies.
#[tauri::command(async)]
pub fn crew_projects_owning(
    store: State<'_, SessionStore>,
    folder: String,
    roots: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let roots = roots.unwrap_or_default();
    let conn = store.lock_conn()?;
    // No hub roots is the fail-closed read: a place that cannot be decided refuses the read.
    if roots.is_empty() {
        return store::projects_owning(&conn, &folder);
    }
    store::projects_owning_for(
        &conn,
        &folder,
        &store::OwningQuery {
            roots: &roots,
            cli: None,
            agent: false,
            locked_default: None,
        },
    )
}
