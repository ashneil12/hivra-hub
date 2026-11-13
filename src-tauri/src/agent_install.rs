//! Installs a coding agent's CLI from Settings > Providers > Agent CLIs.
//!
//! The webview names a harness id, never a command: the command comes from the fixed list below (each tool's own
//! official installer). It runs through the login shell with the same PATH the app uses to find CLIs, in its own
//! process group so Cancel reaches everything it started, with its output sent to the window line by line as
//! `agent-install` events. One install runs per harness at a time, and the app stops them all when it exits.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub const EVENT: &str = "agent-install";
const MAX_LINE_CHARS: usize = 2000;
const STOP_GRACE: Duration = Duration::from_secs(3);

/// The official installer for each harness the app can install by itself. Harnesses missing here (fx, hermes,
/// antigravity) get a link to their install page instead.
/// Every curl here starts with `-q`, so it reads no ~/.curlrc or ~/.config/curlrc (SC-8c; the agent sandbox also
/// write-denies those files). The installers these scripts fetch may run curl again without it.
pub fn install_command(harness: &str) -> Option<&'static str> {
    Some(match harness {
        "claude" => "curl -q -fsSL https://claude.ai/install.sh | bash",
        "codex" => "npm install -g @openai/codex",
        "cursor" => "curl -q https://cursor.com/install -fsS | bash",
        "grok" => "curl -q -fsSL https://x.ai/cli/install.sh | bash",
        // v1 on purpose: the app's OpenCode adapter speaks 1.x; opencode.ai/v2/install replaces it with v2.
        "opencode" => "curl -q -fsSL https://opencode.ai/install | bash",
        "pi" => "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
        "omp" => "curl -q -fsSL https://omp.sh/install | sh",
        "devin" => "curl -q -fsSL https://cli.devin.ai/install.sh | bash",
        _ => return None,
    })
}

/// A running install: its process group id, and whether Cancel was pressed.
type Running = (i32, Arc<Mutex<bool>>);

#[derive(Default)]
pub struct AgentInstalls {
    /// harness id -> the running install
    running: Mutex<HashMap<String, Running>>,
}

impl AgentInstalls {
    pub fn new() -> Self {
        Self::default()
    }

    fn cancel(&self, harness: &str) -> bool {
        let entry = self.running.lock().unwrap().get(harness).cloned();
        let Some((pgid, cancelled)) = entry else {
            return false;
        };
        *cancelled.lock().unwrap() = true;
        if pgid > 0 {
            stop_group(pgid);
        }
        true
    }

    pub fn stop_all(&self) {
        let entries: Vec<_> = self.running.lock().unwrap().values().cloned().collect();
        for (pgid, cancelled) in entries {
            *cancelled.lock().unwrap() = true;
            if pgid > 0 {
                signal_group(pgid, true);
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub exit_code: Option<i32>,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallLine<'a> {
    harness: &'a str,
    line: &'a str,
}

#[cfg(unix)]
fn signal_group(pgid: i32, kill: bool) {
    let signal = if kill { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        libc::kill(-pgid, signal);
    }
}

#[cfg(not(unix))]
fn signal_group(_pgid: i32, _kill: bool) {}

/// TERM the whole group, then KILL whatever is left after a short grace.
fn stop_group(pgid: i32) {
    signal_group(pgid, false);
    std::thread::spawn(move || {
        std::thread::sleep(STOP_GRACE);
        signal_group(pgid, true);
    });
}

/// The last carriage-return segment of a line: installers redraw progress bars with `\r`.
fn clean_line(raw: &str) -> String {
    let line = raw
        .trim_end_matches(['\r', '\n'])
        .rsplit('\r')
        .next()
        .unwrap_or_default();
    // Drop ANSI escapes (colours, cursor moves) an installer prints despite NO_COLOR.
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out.chars().take(MAX_LINE_CHARS).collect()
}

fn pump(
    app: AppHandle,
    harness: String,
    stream: impl Read + Send + 'static,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = clean_line(&String::from_utf8_lossy(&buf));
                    if line.trim().is_empty() {
                        continue;
                    }
                    let _ = app.emit(
                        EVENT,
                        InstallLine {
                            harness: &harness,
                            line: &line,
                        },
                    );
                }
            }
        }
    })
}

fn shell_command(script: &str) -> Command {
    // The user's login shell, so npm, Homebrew and their profile resolve the way a terminal would.
    let shell = if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else {
        std::env::var("SHELL")
            .ok()
            .filter(|s| s.ends_with("/bash") || s.ends_with("/zsh"))
            .unwrap_or_else(|| "/bin/sh".into())
    };
    let mut command = Command::new(shell);
    command.arg("-lc").arg(script);
    command
}

fn run_install(
    app: &AppHandle,
    installs: &AgentInstalls,
    harness: &str,
) -> Result<InstallResult, String> {
    if cfg!(windows) {
        return Err(
            "Installing from the app isn't available on Windows yet. Use the install page.".into(),
        );
    }
    let script =
        install_command(harness).ok_or_else(|| format!("No installer is known for {harness}."))?;

    // Reserve the slot before anything starts, so a second press can't start a second installer.
    let cancelled = Arc::new(Mutex::new(false));
    {
        let mut running = installs.running.lock().unwrap();
        if running.contains_key(harness) {
            return Err("An install is already running for this tool.".into());
        }
        running.insert(harness.to_string(), (0, cancelled.clone()));
    }

    let mut command = shell_command(script);
    crate::hide_window_console(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", crate::harness::gui_search_path())
        .env("NO_COLOR", "1")
        .env("CI", "1");
    // An installer is not an agent: none of the app's control endpoints go to it.
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_some_and(|name| {
            name.starts_with("MONOCODE_APP_") || name.starts_with("MONOCODE_CONTROL_")
        }) {
            command.env_remove(&name);
        }
    }
    if let Some(home) = dirs_home() {
        command.current_dir(home);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            installs.running.lock().unwrap().remove(harness);
            return Err(format!("Could not start the installer: {error}"));
        }
    };
    let pgid = child.id() as i32;
    installs
        .running
        .lock()
        .unwrap()
        .insert(harness.to_string(), (pgid, cancelled.clone()));
    // Cancel pressed while it was starting.
    if *cancelled.lock().unwrap() {
        stop_group(pgid);
    }

    let _ = app.emit(
        EVENT,
        InstallLine {
            harness,
            line: &format!("$ {script}"),
        },
    );
    let out = child
        .stdout
        .take()
        .map(|s| pump(app.clone(), harness.to_string(), s));
    let err = child
        .stderr
        .take()
        .map(|s| pump(app.clone(), harness.to_string(), s));
    let status = child.wait();
    // The group may keep a pipe open after the shell exits; end it so the readers finish.
    signal_group(pgid, true);
    for reader in [out, err].into_iter().flatten() {
        let _ = reader.join();
    }
    installs.running.lock().unwrap().remove(harness);

    let cancelled = *cancelled.lock().unwrap();
    let status = status.map_err(|error| format!("The installer stopped unexpectedly: {error}"))?;
    Ok(InstallResult {
        exit_code: status.code(),
        cancelled,
    })
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

#[tauri::command(async)]
pub async fn agent_cli_install(app: AppHandle, harness: String) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let installs = app.state::<AgentInstalls>();
        run_install(&app, &installs, &harness)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn agent_cli_install_cancel(installs: State<'_, AgentInstalls>, harness: String) -> bool {
    installs.cancel(&harness)
}

/// SC-8c: every curl in the fixed installer list ignores the person's curl config (`-q` must be its first argument).
#[cfg(test)]
mod sc8c_tests {
    #[test]
    fn every_installer_curl_starts_with_q() {
        for harness in [
            "claude", "codex", "cursor", "grok", "opencode", "pi", "omp", "devin",
        ] {
            let command = super::install_command(harness).expect(harness);
            for (at, _) in command.match_indices("curl ") {
                assert!(
                    command[at..].starts_with("curl -q "),
                    "{harness}: {command}"
                );
            }
            assert!(
                !command.contains("wget"),
                "{harness}: a wget would need --no-config: {command}"
            );
        }
    }
}
