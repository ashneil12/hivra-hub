//! WP-178 item 3.1: the macOS sandbox profile for agent CLIs. Off by default; on by a setting.
//!
//! When the setting is on, `harness_spawn` starts each agent CLI as `/usr/bin/sandbox-exec -p <profile> <cli> <args…>`
//! (`sandboxed_launch`). The profile is a denylist: everything is allowed except the secret places (SSH keys, GnuPG,
//! cloud logins, keychains) and the shell profiles, which are read from src/shared/security/agentSecretPaths.json, and
//! writes to `.git/hooks` and `.git/config` in any checkout. A denylist leaks everything it does not list; that limit is
//! written in docs/hivra/work/WP-178-agent-os-sandbox.md.
//!
//! Fail closed: before a sandboxed start, `sandbox-exec` runs `/usr/bin/true` under the same profile. If that does not
//! start, the agent does not start. The app never falls back to an unsandboxed start while the setting is on.
//!
//! The switch: `<app data>/settings/agent-sandbox` containing `on`, or the environment `MONOCODE_AGENT_SANDBOX=1`. The
//! environment wins over the file. Off unless one of them says on, and never on outside macOS.

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Deserialize;

pub const ENV_SWITCH: &str = "MONOCODE_AGENT_SANDBOX";
pub const SETTING_FILE: &str = "agent-sandbox";
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
const SECRET_LIST: &str = include_str!("../../src/shared/security/agentSecretPaths.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretList {
    secret_dirs: Vec<String>,
    secret_files: Vec<String>,
    cli_login_files: Vec<String>,
    shell_profiles: Vec<String>,
}

/// The secret places the after-turn check fingerprints (dirs and files, home-relative): the sandbox denies these and
/// also reports on the CLIs' own login files, which the sandbox does not deny (the CLI must read them to log in).
pub struct SecretPlaces {
    pub dirs: Vec<String>,
    pub files: Vec<String>,
}

pub fn secret_places() -> Result<SecretPlaces, String> {
    let list = secret_list()?;
    let mut files = list.secret_files;
    files.extend(list.cli_login_files);
    Ok(SecretPlaces {
        dirs: list.secret_dirs,
        files,
    })
}

fn secret_list() -> Result<SecretList, String> {
    serde_json::from_str(SECRET_LIST)
        .map_err(|e| format!("agent sandbox: the secret list is unreadable: {e}"))
}

fn word_on(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "on" | "true" | "yes"
    )
}

/// On when the environment switch or the setting file says on. The environment wins either way.
pub(crate) fn switched_on(env: Option<&OsStr>, file: Option<&str>) -> bool {
    if let Some(env) = env.and_then(OsStr::to_str) {
        return word_on(env);
    }
    file.is_some_and(word_on)
}

/// Whether agent CLIs start under the sandbox profile: macOS only, and only when the setting says on. Off by default.
pub fn enabled(data_dir: Option<&Path>) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let env = std::env::var_os(ENV_SWITCH);
    let file = data_dir
        .and_then(|dir| std::fs::read_to_string(dir.join("settings").join(SETTING_FILE)).ok());
    switched_on(env.as_deref(), file.as_deref())
}

/// A path as the profile writes it, inside double quotes. A path with a quote, a backslash or a control character is
/// refused rather than escaped, so a profile can never name a different place than the home folder.
fn quote_path(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or_else(|| {
        "agent sandbox: the home folder is not valid text, so the profile cannot name it"
            .to_string()
    })?;
    if text.is_empty()
        || text
            .chars()
            .any(|c| c == '"' || c == '\\' || c.is_control())
    {
        return Err(
            "agent sandbox: the home folder path has a character the profile cannot quote"
                .to_string(),
        );
    }
    Ok(text.to_string())
}

/// The denylist profile for `home`. Allow by default; deny reads and writes of the secret places and shell profiles;
/// deny writes to `.git/hooks` and `.git/config` in any checkout (a worktree's git dir is under the main one's `.git`).
pub fn profile_text(home: &Path) -> Result<String, String> {
    let list = secret_list()?;
    let home = quote_path(home)?;
    let mut lines = vec!["(version 1)".to_string(), "(allow default)".to_string()];
    for dir in &list.secret_dirs {
        lines.push(format!(
            r#"(deny file-read* file-write* (subpath "{home}/{dir}"))"#
        ));
    }
    // The CLIs' own login files (cli_login_files) are not denied: the CLI reads them to log in.
    for file in list.secret_files.iter().chain(list.shell_profiles.iter()) {
        lines.push(format!(
            r#"(deny file-read* file-write* (literal "{home}/{file}"))"#
        ));
    }
    lines.push(r#"(deny file-write* (regex #"/\.git/hooks(/|$)"))"#.to_string());
    lines.push(r#"(deny file-write* (regex #"/\.git/config$"))"#.to_string());
    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// Starts `/usr/bin/true` under `profile` through `sandbox_exec`. Fails unless it exits 0, so a profile or launcher that
/// cannot start is caught before an agent is started.
pub fn preflight_with(sandbox_exec: &Path, profile: &str) -> Result<(), String> {
    let output = Command::new(sandbox_exec)
        .args(["-p", profile, "/usr/bin/true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("The agent did not start: the macOS sandbox could not run ({e})."))?;
    if output.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "The agent did not start: the macOS sandbox could not start it, so it does not run without the sandbox. {why}"
    ).trim_end().to_string())
}

/// The program and the leading arguments that start `cli` under the sandbox, after the profile passes its preflight.
pub fn sandboxed_launch(
    cli: &OsStr,
    home: &Path,
    sandbox_exec: &Path,
) -> Result<(OsString, Vec<OsString>), String> {
    let profile = profile_text(home)?;
    preflight_with(sandbox_exec, &profile)?;
    Ok((
        sandbox_exec.as_os_str().to_os_string(),
        vec![
            OsString::from("-p"),
            OsString::from(profile),
            cli.to_os_string(),
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_home(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "agent-sandbox-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn the_switch_is_off_by_default_and_a_setting_file_or_env_turns_it_on() {
        assert!(!switched_on(None, None));
        assert!(switched_on(None, Some("on\n")));
        assert!(!switched_on(None, Some("off")));
        assert!(switched_on(Some(OsStr::new("1")), None));
        assert!(
            !switched_on(Some(OsStr::new("0")), Some("on")),
            "the environment wins over the file"
        );
    }

    #[test]
    fn the_profile_denies_ssh_shell_profiles_and_git_hook_and_config_writes() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        assert!(profile.contains(r#"(deny file-read* file-write* (subpath "/Users/test/.ssh"))"#));
        assert!(profile.contains(r#"(deny file-read* file-write* (literal "/Users/test/.zshrc"))"#));
        assert!(profile.contains(r#"(regex #"/\.git/hooks(/|$)")"#));
        assert!(profile.contains(r#"(regex #"/\.git/config$")"#));
        assert!(
            profile.starts_with("(version 1)\n(allow default)"),
            "a denylist, not a deny-default profile"
        );
    }

    #[test]
    fn the_profile_covers_every_shell_profile_in_the_shared_list() {
        let list: serde_json::Value = serde_json::from_str(SECRET_LIST).unwrap();
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        for file in list["shellProfiles"].as_array().unwrap() {
            let file = file.as_str().unwrap();
            assert!(
                profile.contains(&format!("/Users/test/{file}\"")),
                "missing {file}"
            );
        }
    }

    #[test]
    fn the_cli_own_login_files_are_not_denied_so_the_cli_can_still_log_in() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        assert!(!profile.contains(".claude.json"));
        assert!(!profile.contains(".codex/auth.json"));
    }

    #[test]
    fn a_home_path_the_profile_cannot_quote_is_refused_not_guessed() {
        assert!(profile_text(Path::new("/Users/te\"st")).is_err());
        assert!(profile_text(Path::new("/Users/te\\st")).is_err());
    }

    #[test]
    fn a_sandbox_that_fails_to_start_refuses_the_launch_and_never_runs_unsandboxed() {
        let home = temp_home("fail-closed");
        let refused = sandboxed_launch(OsStr::new("claude"), &home, Path::new("/usr/bin/false"));
        assert!(
            refused.is_err(),
            "a failed sandbox must refuse the start, got {refused:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_switch_off_never_builds_a_sandbox_launch() {
        // Off by default: `enabled` is false with no setting, so harness_spawn keeps the plain command.
        assert!(!enabled(None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_sandboxed_launch_wraps_the_cli_in_sandbox_exec_with_the_profile() {
        let home = temp_home("wrap");
        let (program, prefix) =
            sandboxed_launch(OsStr::new("claude"), &home, Path::new(SANDBOX_EXEC)).unwrap();
        assert_eq!(program, OsString::from(SANDBOX_EXEC));
        assert_eq!(prefix[0], OsString::from("-p"));
        assert_eq!(prefix[2], OsString::from("claude"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_a_read_of_ssh_and_a_write_to_git_hooks_are_refused() {
        use std::process::Stdio;
        let home = temp_home("refuse");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh").join("id_test"), "secret").unwrap();
        let project = home.join("project");
        std::fs::create_dir_all(project.join(".git").join("hooks")).unwrap();
        let profile = profile_text(&home).unwrap();
        let run = |script: String| {
            Command::new(SANDBOX_EXEC)
                .args(["-p", &profile, "/bin/sh", "-c", &script])
                .current_dir(&project)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
        };
        let read_ssh = run(format!("cat '{}/.ssh/id_test'", home.display()));
        assert!(!read_ssh.success(), "reading ~/.ssh must be refused");
        let write_hook = run("echo x > .git/hooks/pre-commit".to_string());
        assert!(!write_hook.success(), "writing .git/hooks must be refused");
        let allowed = run("echo ok > allowed.txt".to_string());
        assert!(
            allowed.success(),
            "a write inside the project outside the list must still work"
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
