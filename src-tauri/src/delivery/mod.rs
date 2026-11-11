//! Hivra WP-12: how finished work arrives in a project, and the one function that decides whether anything may merge
//! (docs/hivra/SPEC.md section 4 step 7, docs/hivra/work/WP-12-delivery.md).
//!
//! - `settings`: per project, the delivery mode (local, PR, checked PR) and the "merge without asking" switch
//!   (firstmate's `yolo`, off by default). No mode stored: checked PR when the project has a GitHub remote and `gh` is
//!   signed in, otherwise local.
//! - `deliver`: a finished worker's change, by the project's mode: landed with `land.rs`, or its branch pushed and a pull
//!   request opened whose body carries the brief and the worker's report. Each delivery is a row (`work_deliveries`).
//! - `merge`: the one merge path. It refuses red or pending checks, refuses while a decision on that work is open, asks
//!   the person unless the switch is on, and logs every merge with who allowed it (`delivery_merges`).
//! - `teardown`: a worktree whose work hasn't landed or merged is never removed.
//! - `events`: what `pr_watch` reads (CI red, CI green, merged, closed), kept in `delivery_events` for WP-11's
//!   classifier, and the checked-PR state machine it drives (green: ready; first red: one fix round with the log;
//!   second red: failed).
//!
//! The modes, `yolo` and "red is never merged" are firstmate's (kunchenguid/firstmate, MIT: `AGENTS.md` section 7,
//! `bin/fm-pr-merge.sh`, `bin/fm-teardown.sh`). The behaviour is ported; the contract sentences are vendored in
//! `src/features/firstmate/vendor/firstmate-contract.md`. Rewrite: the shell is GitHub `gh` plus `land.rs`, not
//! fm-pr-merge.sh.

pub mod deliver;
pub mod events;
pub mod github;
pub mod merge;
pub mod protected;
pub mod review;
pub mod settings;
pub mod teardown;

use rusqlite::Connection;
use tauri::State;

use crate::session_store::{now_millis, SessionStore};

/// What a git or `gh` child may see. Anything else in this process (tokens, agent variables) stays here.
pub(crate) const CHILD_ENV: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "USERNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSH_AUTH_SOCK",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "GIT_SSL_CAINFO",
    "GIT_EXEC_PATH",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "PATHEXT",
    "COMSPEC",
];

/// A child process with an allow-listed environment and a fixed PATH. Callers add their own
/// `GIT_*` / `GH_*` switches.
pub(crate) fn child(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command.env_clear();
    for key in CHILD_ENV {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env("PATH", crate::connectors::launch::safe_path());
    command
}

/// Tauri event: `{ids}` of deliveries whose state changed.
pub const CHANGED: &str = "hivra:deliveries-changed";

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS delivery_settings (
           project TEXT PRIMARY KEY,
           mode TEXT,
           merge_without_asking INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS work_deliveries (
           id TEXT PRIMARY KEY,
           delegation_id TEXT,
           project TEXT NOT NULL,
           checkout TEXT,
           mode TEXT NOT NULL,
           state TEXT NOT NULL,
           repo TEXT,
           number INTEGER,
           url TEXT,
           branch TEXT,
           fix_rounds INTEGER NOT NULL DEFAULT 0,
           detail TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS work_deliveries_pr ON work_deliveries (repo, number);
         CREATE TABLE IF NOT EXISTS delivery_merge_approvals (
           repo TEXT NOT NULL,
           number INTEGER NOT NULL,
           head_sha TEXT NOT NULL,
           approved_by TEXT NOT NULL,
           approved_at INTEGER NOT NULL,
           PRIMARY KEY (repo, number, head_sha)
         );
         CREATE TABLE IF NOT EXISTS delivery_merges (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           repo TEXT NOT NULL,
           number INTEGER NOT NULL,
           head_sha TEXT,
           outcome TEXT NOT NULL,
           allowed_by TEXT,
           caller TEXT NOT NULL,
           reason TEXT,
           at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS delivery_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           repo TEXT NOT NULL,
           number INTEGER NOT NULL,
           kind TEXT NOT NULL,
           head_sha TEXT,
           detail TEXT,
           delivery_id TEXT,
           created_at INTEGER NOT NULL,
           consumed_at INTEGER
         );",
    )?;
    // WP-81: 1 when the pull request was opened by the local check, so Hivra does not send its own fix crew.
    let has_gate: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('work_deliveries') WHERE name = 'gate')",
        [],
        |row| row.get(0),
    )?;
    if !has_gate {
        conn.execute(
            "ALTER TABLE work_deliveries ADD COLUMN gate INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    // WP-158: the protected-path floor is off until the project turns it on. Extra paths only add.
    let has_floor: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('delivery_settings') WHERE name = 'protect_paths')",
        [],
        |row| row.get(0),
    )?;
    if !has_floor {
        conn.execute(
            "ALTER TABLE delivery_settings ADD COLUMN protect_paths INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let has_extra: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('delivery_settings') WHERE name = 'protected_extra')",
        [],
        |row| row.get(0),
    )?;
    if !has_extra {
        conn.execute(
            "ALTER TABLE delivery_settings ADD COLUMN protected_extra TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    // WP-203: the builder that did the work, recorded by the app at delivery. The security review's author.
    let has_author = conn
        .prepare("SELECT 1 FROM pragma_table_info('work_deliveries') WHERE name = 'author'")?
        .exists([])?;
    if !has_author {
        conn.execute("ALTER TABLE work_deliveries ADD COLUMN author TEXT", [])?;
    }
    review::ensure_table(conn)?;
    Ok(())
}

// ---- commands ----------------------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub fn delivery_settings_get(
    store: State<'_, SessionStore>,
    project: String,
) -> Result<settings::Effective, String> {
    let stored = settings::get(&*store.lock_conn()?, &project)?;
    Ok(settings::effective(
        stored,
        &settings::probe(std::path::Path::new(&project), &github::CliGithub),
    ))
}

#[tauri::command(async)]
pub fn delivery_settings_set(
    store: State<'_, SessionStore>,
    project: String,
    mode: Option<settings::Mode>,
    merge_without_asking: bool,
    expected_updated_at: Option<i64>,
) -> Result<settings::Stored, String> {
    settings::set(
        &*store.lock_conn()?,
        &project,
        mode,
        merge_without_asking,
        expected_updated_at,
        now_millis(),
    )
}

/// Turns the protected-path floor on or off for one project. It stays off until then.
/// The built-in list is not stored, so this cannot shrink it.
#[tauri::command(async)]
pub fn delivery_protect_paths_set(
    store: State<'_, SessionStore>,
    project: String,
    on: bool,
    expected_updated_at: Option<i64>,
) -> Result<settings::Stored, String> {
    settings::set_protect_paths(
        &*store.lock_conn()?,
        &project,
        on,
        expected_updated_at,
        now_millis(),
    )
}

/// Adds paths under "Also protect these paths". A path already there stays, and none are removed.
#[tauri::command(async)]
pub fn delivery_protected_paths_add(
    store: State<'_, SessionStore>,
    project: String,
    paths: Vec<String>,
    expected_updated_at: Option<i64>,
) -> Result<settings::Stored, String> {
    settings::add_protected_paths(
        &*store.lock_conn()?,
        &project,
        &paths,
        expected_updated_at,
        now_millis(),
    )
}

#[tauri::command(async)]
pub fn delivery_list(
    store: State<'_, SessionStore>,
    project: Option<String>,
) -> Result<Vec<deliver::Delivery>, String> {
    deliver::list(&*store.lock_conn()?, project.as_deref())
}

#[tauri::command(async)]
pub fn delivery_deliver(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    input: deliver::DeliverInput,
) -> Result<deliver::Delivery, String> {
    let mut delivered = deliver::deliver(&store, &github::CliGithub, input, now_millis())?;
    // A delivered pull request is watched for its first mate, so CI and the merge come back as wakes and events.
    if let (Some(repo), Some(number)) = (delivered.repo.clone(), delivered.number) {
        let owner = deliver::owner_of(&*store.lock_conn()?, &delivered)?;
        if let Some(owner) = owner {
            let watched = crate::pr_watch::add(
                &store,
                &crate::pr_watch::github::CliGh,
                crate::pr_watch::AddInput {
                    owner_session: owner,
                    repo,
                    number,
                    worktree: delivered.checkout.clone(),
                    projects: vec![crate::pr_watch::Project {
                        folder: delivered.project.clone(),
                        hub_id: None,
                    }],
                    ..Default::default()
                },
                now_millis(),
            );
            match watched {
                Ok(_) => {
                    crate::pr_watch::nudge();
                    // The registration read may already have settled a checked PR (green, or its one fix round).
                    if let Ok(Some(fresh)) = deliver::get(&*store.lock_conn()?, &delivered.id) {
                        delivered = fresh;
                    }
                }
                Err(error) => {
                    let note = format!("The pull request is open, but it isn't watched: {error}");
                    let conn = store.lock_conn()?;
                    deliver::set_state(
                        &conn,
                        &delivered.id,
                        &delivered.state,
                        0,
                        Some(&note),
                        now_millis(),
                    )?;
                    delivered.detail = Some(note);
                }
            }
        }
    }
    deliver::announce(&app, &[delivered.id.clone()]);
    Ok(delivered)
}

/// The fix round's message for a delivery whose checks went red: the failing checks and their logs.
#[tauri::command(async)]
pub fn delivery_fix_ask(store: State<'_, SessionStore>, id: String) -> Result<String, String> {
    let found = deliver::get(&*store.lock_conn()?, &id)?;
    let delivery = found.ok_or_else(|| "No such delivery.".to_string())?;
    let (Some(repo), Some(number)) = (delivery.repo, delivery.number) else {
        return Err("That delivery has no pull request.".into());
    };
    events::fix_ask(&github::CliGithub, &repo, number)
}

/// The person's tap: they allow this pull request, at this head, to merge. Only the app's own screens call this; an
/// agent's merge asks and waits for it.
#[tauri::command(async)]
pub fn delivery_merge_approve(
    store: State<'_, SessionStore>,
    repo: String,
    number: u64,
    head_sha: String,
) -> Result<(), String> {
    merge::approve(
        &*store.lock_conn()?,
        &repo,
        number,
        &head_sha,
        "person",
        now_millis(),
    )
}

#[tauri::command(async)]
pub fn delivery_merge(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    input: merge::MergeRequest,
) -> Result<merge::MergeOutcome, String> {
    // The installed and signed-in CLIs, so a security review can be started to a builder other than the author.
    let present = crate::crew::live_presence(&app);
    merge::merge_with(&store, &github::CliGithub, input, now_millis(), &present)
}

#[tauri::command(async)]
pub fn delivery_merges(
    store: State<'_, SessionStore>,
    repo: String,
    number: u64,
) -> Result<Vec<merge::LoggedMerge>, String> {
    merge::log(&*store.lock_conn()?, &repo, number)
}

/// WP-11's classifier reads these; `consume` marks them taken.
#[tauri::command(async)]
pub fn delivery_events_open(store: State<'_, SessionStore>) -> Result<Vec<events::Event>, String> {
    events::open(&*store.lock_conn()?)
}

#[tauri::command(async)]
pub fn delivery_events_consume(
    store: State<'_, SessionStore>,
    ids: Vec<i64>,
) -> Result<usize, String> {
    events::consume(&*store.lock_conn()?, &ids, now_millis())
}

#[cfg(test)]
mod review_227_r6_tests;
#[cfg(test)]
mod tests;
