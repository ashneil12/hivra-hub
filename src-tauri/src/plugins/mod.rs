//! Plugins (WP-30, docs/hivra/plugins/README.md): the open Agent Plugins format plus Hivra's extension folder, a
//! registry where every contribution can be undone, and the wiring that hands skills and MCP servers to each agent
//! CLI's session. Plugins never run code in the app's process: their code runs only as MCP servers (separate
//! processes, through `plugin-mcp`) or, for panels, inside the Pages sandbox.

mod compat;
pub mod defaults;
pub mod desktop;
mod desktop_program;
pub mod discover;
mod fsutil;
pub mod hivra;
mod install;
pub mod manifest;
pub mod mcp;
pub mod registry;
// WP-101: what a staged copy holds, read before the person is asked to install it.
pub mod scan;
mod source;
pub mod verify;
pub mod wiring;
// WP-34: Creator mode, on top of the install path above.
pub mod creator;

#[cfg(test)]
mod creator_tests;
#[cfg(test)]
mod defaults_tests;
#[cfg(test)]
mod desktop_tests;
#[cfg(test)]
mod install_tests;
#[cfg(test)]
mod scan_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod verify_tests;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::Manager;

pub use manifest::{load_plugin, LoadedPlugin, Report};
pub use registry::{Host, Scope};
pub use wiring::run_main;
// WP-33: panels update a local folder through the existing install path.
#[cfg(test)]
pub(crate) use compat::Target;
pub(crate) use install::{update as update_plugin, InstallResult, RequestedBy};
#[cfg(test)]
pub(crate) use source::sha512_integrity;
pub(crate) use source::{pack_exact, real_sha512_pin, InstallSource, Tools};

static MANAGED_SKILLS: OnceLock<PathBuf> = OnceLock::new();

/// The app's plugin host: `<app data>/plugins`. Skills are linked into the user's `~/.agents/skills` for the daily
/// app and for a copy under a temporary HOME; a dev copy on the real HOME keeps them in its own data folder, so Ash's
/// CLIs never see a dev copy's plugins.
pub fn host<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Host, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let root = data.join("plugins");
    let shared = crate::instance::kind() == crate::instance::Kind::Daily
        || crate::instance::isolated_home().is_some();
    let agents_skills = match crate::dirs_home() {
        Some(home) if shared => Path::new(&home).join(".agents").join("skills"),
        _ => root.join("agents-skills"),
    };
    let _ = MANAGED_SKILLS.set(agents_skills.clone());
    Ok(Host {
        root,
        agents_skills,
    })
}

/// The skills folder plugins link into, once the app has worked it out (skills.rs lists it with the other roots).
pub(crate) fn managed_skills_root() -> Option<&'static Path> {
    MANAGED_SKILLS.get().map(PathBuf::as_path)
}

/// No project means everywhere. A project that is given must be a real folder path: an empty string is refused rather
/// than read as "everywhere".
fn scope(project: Option<String>) -> Result<Scope, String> {
    match project {
        None => Ok(Scope::Global),
        Some(project) => {
            let path = crate::fs::expand_home(&project);
            registry::project_key(&path.to_string_lossy())?;
            Ok(Scope::Project(path.to_string_lossy().into_owned()))
        }
    }
}

#[tauri::command(async)]
pub fn plugins_list(app: tauri::AppHandle) -> Result<registry::Registry, String> {
    registry::read(&host(&app)?)
}

/// Read and validate a plugin folder without installing it.
#[tauri::command(async)]
pub fn plugins_inspect(path: String) -> Result<LoadedPlugin, String> {
    load_plugin(&crate::fs::expand_home(&path)).map_err(|e| e.0)
}

#[tauri::command(async)]
pub fn plugins_install_local(
    app: tauri::AppHandle,
    path: String,
) -> Result<registry::Outcome, String> {
    let dir = crate::fs::expand_home(&path);
    registry::install_local(&host(&app)?, &dir, registry::Source::local(&dir))
}

#[tauri::command(async)]
pub fn plugins_enable(
    app: tauri::AppHandle,
    name: String,
    project: Option<String>,
) -> Result<registry::Outcome, String> {
    registry::enable(&host(&app)?, &name, &scope(project)?)
}

#[tauri::command(async)]
pub fn plugins_disable(
    app: tauri::AppHandle,
    name: String,
    project: Option<String>,
) -> Result<registry::Outcome, String> {
    registry::disable(&host(&app)?, &name, &scope(project)?)
}

#[tauri::command(async)]
pub fn plugins_uninstall(app: tauri::AppHandle, name: String) -> Result<registry::Outcome, String> {
    registry::uninstall(&host(&app)?, &name)
}

/// Install a pinned source. An agent's request, or anything that would run a command, waits for the person's OK.
#[tauri::command(async)]
pub fn plugins_install(
    app: tauri::AppHandle,
    source: source::InstallSource,
    requested_by: Option<install::RequestedBy>,
    project: Option<String>,
) -> Result<install::InstallResult, String> {
    let host = host(&app)?;
    let by = requested_by.unwrap_or_default();
    // No folder keeps the original path, which leaves the plugin off. A folder is stored with the request and
    // turned on once the install lands, including one that waits for the Inbox.
    if project.is_none() {
        install::install(&host, &source::Tools::app(), &source, by)
    } else {
        install::install_for(&host, &source::Tools::app(), &source, by, project)
    }
}

/// Update an installed plugin to another pinned version. The installed one stays until the new one validates.
#[tauri::command(async)]
pub fn plugins_update(
    app: tauri::AppHandle,
    name: String,
    source: source::InstallSource,
    requested_by: Option<install::RequestedBy>,
) -> Result<install::InstallResult, String> {
    install::update(
        &host(&app)?,
        &source::Tools::app(),
        &name,
        &source,
        requested_by.unwrap_or_default(),
    )
}

/// The person said yes to a waiting install.
#[tauri::command(async)]
pub fn plugins_approve(
    app: tauri::AppHandle,
    id: String,
) -> Result<install::InstallResult, String> {
    install::approve(&host(&app)?, &source::Tools::app(), &id)
}

/// The person said no. Nothing was installed.
#[tauri::command(async)]
pub fn plugins_decline(app: tauri::AppHandle, id: String) -> Result<(), String> {
    install::decline(&host(&app)?, &id)
}

/// Installs and updates waiting for the person's OK, oldest first.
#[tauri::command(async)]
pub fn plugins_pending(app: tauri::AppHandle) -> Result<Vec<install::PendingRequest>, String> {
    Ok(install::pending(&host(&app)?))
}

/// Go back to the version the last update replaced.
#[tauri::command(async)]
pub fn plugins_rollback(app: tauri::AppHandle, name: String) -> Result<registry::Outcome, String> {
    install::rollback(&host(&app)?, &name)
}

/// What a session in `cwd` gets from the plugins: Claude Code's `--plugin-dir`s and MCP entries, Codex's MCP entries.
#[tauri::command(async)]
pub fn plugins_session_wiring(
    app: tauri::AppHandle,
    cwd: String,
    agent_id: Option<String>,
    agent_name: Option<String>,
) -> Result<wiring::Wiring, String> {
    let cli = std::env::current_exe()
        .ok()
        .map(|exe| exe.to_string_lossy().into_owned());
    let cwd = crate::fs::expand_home(&cwd);
    // WP-101 fix round 2: the person's own server names, reported with the wiring so a call can be checked against the
    // name Claude Code reads rather than the one a config spells.
    let taken = crate::mcp::names_in_use(&cwd);
    // WP-43: a chat passes its agent so the browser plugin gets that profile. Other plugins ignore it.
    let name = agent_name.unwrap_or_else(|| "This chat".into());
    let agent = agent_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(|id| wiring::SessionAgent {
            id,
            name: name.as_str(),
        });
    wiring::session_wiring_for(
        &host(&app)?,
        Some(&cwd),
        cli.as_deref(),
        &taken,
        agent.as_ref(),
    )
}
