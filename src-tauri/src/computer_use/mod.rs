//! WP-255: computer use, off by default, with a block list for password apps.
//!
//! Ported from Up.computer (MIT, T3 Tools and Kirill Gurianov). The sidecar that reads and drives the apps is
//! open-computer-use (MIT, iFurySt/open-computer-use), installed by the person with npm, never bundled.
//! - `tools.rs`: the tools a chat sees and the exact sidecar arguments each one sends;
//! - `sensitive.rs`: the apps nothing can open (password managers, keychain, wallets, payments, sign-in prompts);
//! - `policy.rs`: whether one call may run;
//! - `store.rs`: the settings file, the activity log, finding the sidecar;
//! - `proxy.rs`: `monocode computer-use`, the MCP server a chat's Claude Code starts.
//!
//! The commands below are Settings > Computer use's; only the webview calls them.

pub mod policy;
pub mod proxy;
pub mod sensitive;
pub mod store;
pub mod tools;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use policy::{ChatMode, Mode, Settings};

/// What Settings shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub settings: Settings,
    /// The file a chat's entry names, so the proxy reads the same settings.
    pub settings_path: String,
    /// The open-computer-use program found, if any.
    pub sidecar: Option<String>,
    /// Only a Mac can be driven today.
    pub supported: bool,
}

/// What Settings can change; the chats' own say goes through `computer_use_set_chat`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub enabled: bool,
    pub mode: Mode,
    #[serde(default)]
    pub allowed_apps: Vec<String>,
    #[serde(default)]
    pub allow_coordinates: bool,
}

const MAX_ALLOWED_APPS: usize = 50;
const MAX_APP_NAME: usize = 120;
const MAX_CHAT_ID: usize = 200;

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn found_sidecar(chosen: Option<&str>) -> Option<PathBuf> {
    let path = std::env::var("PATH").ok();
    store::find_sidecar(chosen, path.as_deref(), dirs::home_dir().as_deref())
}

fn view_of(path: &Path, settings: Settings) -> View {
    let sidecar =
        found_sidecar(settings.sidecar.as_deref()).map(|p| p.to_string_lossy().into_owned());
    View {
        settings,
        settings_path: path.to_string_lossy().into_owned(),
        sidecar,
        supported: cfg!(target_os = "macos"),
    }
}

/// The allowed-apps list as typed: trimmed, no blanks or repeats, capped.
pub(crate) fn clean_apps(apps: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for app in apps {
        let app = app.trim();
        if app.is_empty() || app.chars().count() > MAX_APP_NAME {
            continue;
        }
        if !out.iter().any(|seen| seen.eq_ignore_ascii_case(app)) {
            out.push(app.to_string());
        }
        if out.len() == MAX_ALLOWED_APPS {
            break;
        }
    }
    out
}

/// Settings after a change: the chats' own say is kept, and the sidecar found now is remembered when it is turned on.
pub(crate) fn apply(mut settings: Settings, change: Change, sidecar: Option<PathBuf>) -> Settings {
    settings.enabled = change.enabled;
    settings.mode = change.mode;
    settings.allowed_apps = clean_apps(change.allowed_apps);
    settings.allow_coordinates = change.allow_coordinates;
    if change.enabled {
        if let Some(found) = sidecar {
            settings.sidecar = Some(found.to_string_lossy().into_owned());
        }
    }
    settings
}

pub(crate) fn set_chat(
    mut settings: Settings,
    chat: &str,
    mode: Option<ChatMode>,
) -> Result<Settings, String> {
    let chat = chat.trim();
    if chat.is_empty() || chat.len() > MAX_CHAT_ID {
        return Err("That chat id isn't usable.".into());
    }
    match mode {
        Some(mode) => {
            settings.chats.insert(chat.to_string(), mode);
        }
        None => {
            settings.chats.remove(chat);
        }
    }
    Ok(settings)
}

#[tauri::command]
pub fn computer_use_get(app: tauri::AppHandle) -> Result<View, String> {
    let path = store::settings_path(&data_dir(&app)?);
    Ok(view_of(&path, store::read(&path)))
}

#[tauri::command]
pub fn computer_use_put(app: tauri::AppHandle, change: Change) -> Result<View, String> {
    let path = store::settings_path(&data_dir(&app)?);
    let current = store::read(&path);
    let sidecar = found_sidecar(current.sidecar.as_deref()).or_else(|| found_sidecar(None));
    let next = apply(current, change, sidecar);
    store::write(&path, &next)?;
    Ok(view_of(&path, next))
}

#[tauri::command]
pub fn computer_use_set_chat(
    app: tauri::AppHandle,
    chat: String,
    mode: Option<ChatMode>,
) -> Result<View, String> {
    let path = store::settings_path(&data_dir(&app)?);
    let next = set_chat(store::read(&path), &chat, mode)?;
    store::write(&path, &next)?;
    Ok(view_of(&path, next))
}

#[tauri::command]
pub fn computer_use_activity(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> Result<Vec<store::Activity>, String> {
    let path = store::settings_path(&data_dir(&app)?);
    Ok(store::recent(
        &store::activity_path(&path),
        limit.unwrap_or(50).min(500),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub ok: bool,
    pub output: String,
}

/// `open-computer-use doctor`: checks Accessibility and Screen Recording, and opens its own setup window when one is
/// missing, which is where macOS asks Ash for them.
#[tauri::command]
pub async fn computer_use_check(app: tauri::AppHandle) -> Result<Check, String> {
    let path = store::settings_path(&data_dir(&app)?);
    let settings = store::read(&path);
    let Some(program) = found_sidecar(settings.sidecar.as_deref()).or_else(|| found_sidecar(None))
    else {
        return Ok(Check {
            ok: false,
            output:
                "open-computer-use isn't installed. Install it with: npm i -g open-computer-use"
                    .into(),
        });
    };
    // SC-8: the sidecar is a program an agent could otherwise replace (an npm global or a home bin folder). Name it to
    // the agent sandbox so its file and package are write-denied in every agent profile built from now on.
    crate::agent_sandbox::note_configured_cli(&program);
    tauri::async_runtime::spawn_blocking(move || run_doctor(&program, Duration::from_secs(60)))
        .await
        .map_err(|e| e.to_string())
}

fn run_doctor(program: &Path, limit: Duration) -> Check {
    let mut command = Command::new(program);
    command
        .arg("doctor")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = program.parent() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs = vec![dir.to_path_buf()];
        dirs.extend(std::env::split_paths(&path));
        if let Ok(joined) = std::env::join_paths(dirs) {
            command.env("PATH", joined);
        }
    }
    // SC-8: the check runs under the agent sandbox when it is on, like the verdict gate's Claude Code: the program is one
    // an agent could have replaced, and the app runs it. The sandbox only denies writes to protected places, so the
    // check's own permission prompts and setup window still work. Tests do not wrap: it would read the daily data folder.
    #[cfg(not(test))]
    {
        let data = crate::instance::data_dir(&crate::instance::current().identifier);
        match crate::agent_sandbox::action_wrap(data.as_deref(), &[]) {
            Ok(prefix) => command = crate::agent_sandbox::under_wrap(command, prefix.as_deref()),
            Err(error) => {
                return Check {
                    ok: false,
                    output: error,
                }
            }
        }
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Check {
                ok: false,
                output: format!("Couldn't start open-computer-use: {e}"),
            }
        }
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(200)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Check {
                    ok: false,
                    output: "open-computer-use's check didn't finish. Finish its setup window, then check again.".into(),
                };
            }
        }
    }
    match child.wait_with_output() {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            Check {
                ok: out.status.success(),
                output: text.chars().take(4000).collect(),
            }
        }
        Err(e) => Check {
            ok: false,
            output: e.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_apps_list_is_cleaned() {
        let apps = clean_apps(vec![
            " Notes ".into(),
            "".into(),
            "notes".into(),
            "Safari".into(),
            "x".repeat(121),
        ]);
        assert_eq!(apps, vec!["Notes".to_string(), "Safari".to_string()]);
        assert_eq!(
            clean_apps((0..80).map(|n| format!("App {n}")).collect()).len(),
            MAX_ALLOWED_APPS
        );
    }

    #[test]
    fn a_change_keeps_the_chats_and_remembers_the_sidecar_only_when_on() {
        let mut settings = Settings::default();
        settings.chats.insert("c".into(), ChatMode::Deny);
        let change = |enabled| Change {
            enabled,
            mode: Mode::Control,
            allowed_apps: vec![],
            allow_coordinates: false,
        };
        let off = apply(
            settings.clone(),
            change(false),
            Some(PathBuf::from("/bin/ocu")),
        );
        assert_eq!(off.sidecar, None);
        let on = apply(settings, change(true), Some(PathBuf::from("/bin/ocu")));
        assert_eq!(on.sidecar.as_deref(), Some("/bin/ocu"));
        assert_eq!(on.chats.get("c"), Some(&ChatMode::Deny));
        assert_eq!(on.mode, Mode::Control);
    }

    #[test]
    fn a_chat_gets_its_own_say_and_can_hand_it_back() {
        let settings =
            set_chat(Settings::default(), "chat-1", Some(ChatMode::ObserveOnly)).unwrap();
        assert_eq!(settings.chats.get("chat-1"), Some(&ChatMode::ObserveOnly));
        let settings = set_chat(settings, "chat-1", None).unwrap();
        assert!(settings.chats.is_empty());
        assert!(set_chat(Settings::default(), "  ", Some(ChatMode::Deny)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_check_runs_doctor_and_stops_one_that_hangs() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("hivra-wp255-doctor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("ok");
        std::fs::write(&ok, "#!/bin/sh\n[ \"$1\" = doctor ] && echo all good\n").unwrap();
        let slow = dir.join("slow");
        std::fs::write(&slow, "#!/bin/sh\nsleep 30\n").unwrap();
        for p in [&ok, &slow] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let check = run_doctor(&ok, Duration::from_secs(10));
        assert!(check.ok);
        assert!(check.output.contains("all good"));
        let check = run_doctor(&slow, Duration::from_millis(300));
        assert!(!check.ok);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
