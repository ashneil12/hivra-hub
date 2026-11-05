//! WP-77: a project's labelled GitHub issues and pull requests become tasks.
//! Reads only. A dev copy uses the `gh` stand-in and never a real account.

mod gh;
mod rules;
mod sync;

#[cfg(test)]
#[path = "sync_tests.rs"]
mod sync_tests;

pub(crate) use sync::{link_opened_pr, shown, terminal_hold};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::session_store::{now_millis, SessionStore};
use crate::tasks::store;

use gh::CliGh;
use sync::{Assignee, Report, Setting, SettingWrite};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PollProject {
    project: String,
    #[serde(default)]
    assignee: String,
}

fn emit(app: &AppHandle, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let _ = app.emit(store::CHANGED, serde_json::json!({ "ids": ids }));
}

#[tauri::command(async)]
pub fn github_issues_setting_get(
    store: State<'_, SessionStore>,
    project: String,
) -> Result<Setting, String> {
    let conn = store.lock_conn()?;
    sync::get_setting(&conn, &project)
}

#[tauri::command(async)]
pub fn github_issues_setting_set(
    store: State<'_, SessionStore>,
    project: String,
    enabled: bool,
    label: Option<String>,
    repo: Option<String>,
    assignee: Option<String>,
    expected_version: i64,
) -> Result<Setting, String> {
    let mut gh = CliGh;
    sync::save_setting(
        &store,
        &project,
        SettingWrite {
            enabled,
            label: label.as_deref(),
            repo: repo.as_deref(),
            assignee: assignee.as_deref(),
            expected_version,
        },
        &mut gh,
    )
}

#[tauri::command(async)]
pub fn github_issues_poll(
    app: AppHandle,
    store: State<'_, SessionStore>,
    projects: Option<Vec<PollProject>>,
) -> Result<Report, String> {
    let assignees: Vec<Assignee> = projects
        .unwrap_or_default()
        .into_iter()
        .map(|row| Assignee {
            project: row.project,
            assignee: row.assignee,
        })
        .collect();
    let mut gh = CliGh;
    let report = sync::poll(&store, &mut gh, now_millis(), &assignees)?;
    emit(&app, &report.changed);
    Ok(report)
}
