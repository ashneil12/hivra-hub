//! Plugins (WP-30, docs/hivra/plugins/README.md): the open Agent Plugins format plus Hivra's extension folder, a
//! registry where every contribution can be undone, and the wiring that hands skills and MCP servers to each agent
//! CLI's session. Plugins never run code in the app's process: their code runs only as MCP servers (separate
//! processes, through `plugin-mcp`) or, for panels, inside the Pages sandbox.

pub mod defaults;
pub mod discover;
mod fsutil;
pub mod hivra;
pub mod manifest;
pub mod mcp;
pub mod registry;
pub mod wiring;

#[cfg(test)]
mod defaults_tests;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::Manager;

pub use manifest::{load_plugin, LoadedPlugin, Report};
pub use registry::{Host, Scope};
pub use wiring::run_main;

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

/// What a session in `cwd` gets from the plugins: Claude Code's `--plugin-dir`s and MCP entries, Codex's MCP entries.
#[tauri::command(async)]
pub fn plugins_session_wiring(
    app: tauri::AppHandle,
    cwd: String,
) -> Result<wiring::Wiring, String> {
    let cli = std::env::current_exe()
        .ok()
        .map(|exe| exe.to_string_lossy().into_owned());
    let cwd = crate::fs::expand_home(&cwd);
    let taken = crate::mcp::names_in_use(&cwd);
    wiring::session_wiring(&host(&app)?, Some(&cwd), cli.as_deref(), &taken)
}
