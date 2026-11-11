//! WP-178 item 3.1: the macOS sandbox profile for agent CLIs. Off by default; on by a setting.
//!
//! When the setting is on, `harness_spawn` starts each agent CLI as `/usr/bin/sandbox-exec -p <profile> <cli> <args…>`
//! (`sandboxed_launch`). The profile is a denylist: everything is allowed except the secret places (SSH keys, GnuPG,
//! cloud logins, keychains, password stores) and the shell profiles, and writes to `.git/hooks` and `.git/config` in any
//! checkout. The secret places and shell profiles come from the shared list `src/shared/security/agentConfigPaths.json`
//! (its `homeSecrets` section), the same file the after-turn check reads. The CLIs' own login files are in that section
//! too, but only as reported places: the profile never denies them, because the CLI reads them to log in. A denylist
//! leaks everything it does not list; that limit is written in docs/hivra/work/WP-178-agent-os-sandbox.md.
//!
//! Matching is case-insensitive for ASCII (APFS is case-insensitive by default, so `~/.SSH` is `~/.ssh`). The NFKC and
//! long-s rules of the after-turn check are not in the profile: macOS does not map those names onto the same folder.
//!
//! Fail closed: before a sandboxed start, `sandbox-exec` runs `/usr/bin/true` under the same profile. If that does not
//! start, the agent does not start. The app never falls back to an unsandboxed start while the setting is on. Each refusal
//! to start is written to the activity log (`note_refusal`).
//!
//! The switch: `<app data>/settings/agent-sandbox` containing `on`, or the environment `MONOCODE_AGENT_SANDBOX=1`. The
//! environment wins over the file. Off unless one of them says on, and never on outside macOS. Settings > General has the
//! toggle, which writes the file.

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::AppHandle;

use crate::activity::{self, Who};
use crate::delivery::protected::{home_secrets, HomeSecrets};
use crate::project_file;

pub const ENV_SWITCH: &str = "MONOCODE_AGENT_SANDBOX";
pub const SETTING_FILE: &str = "agent-sandbox";
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The secret places the after-turn check fingerprints (dirs and files, home-relative). The sandbox denies the secret
/// dirs and files, and the CLIs' own login files are reported here and never denied.
pub struct SecretPlaces {
    pub dirs: Vec<String>,
    pub files: Vec<String>,
}

pub fn secret_places() -> Result<SecretPlaces, String> {
    let list = home_secrets()?;
    let mut files = list.files.clone();
    files.extend(list.cli_login_files.iter().cloned());
    Ok(SecretPlaces {
        dirs: list.dirs.clone(),
        files,
    })
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

/// What the Settings toggle shows. `set_by_environment` means the environment decides, so the file cannot change it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub set_by_environment: bool,
}

pub fn status(data_dir: Option<&Path>) -> Status {
    Status {
        supported: cfg!(target_os = "macos"),
        enabled: enabled(data_dir),
        set_by_environment: std::env::var_os(ENV_SWITCH).is_some(),
    }
}

/// Writes the setting file the way `enabled` reads it: `on` or `off`, replaced in one rename.
pub fn write_setting(data_dir: &Path, on: bool) -> Result<(), String> {
    let dir = data_dir.join("settings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(SETTING_FILE);
    let temp = dir.join(format!("{SETTING_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, if on { "on\n" } else { "off\n" }).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        error.to_string()
    })
}

/// A refusal to start under the sandbox, in the activity log (WP-78). The target is the chat; the reason is the start's
/// own error, shortened. Nothing here reads a secret.
pub fn note_refusal(data_dir: &Path, session_id: &str, reason: &str) {
    let summary = format!(
        "The agent did not start in the macOS sandbox. {}",
        activity::bounded_text(reason.trim(), 300)
    );
    activity::note_db(
        &data_dir.join("monocode.db"),
        activity::SANDBOX_REFUSE,
        &Who::app(),
        &Who::app(),
        "",
        session_id,
        &summary,
        "",
    );
}

#[tauri::command(async)]
pub fn agent_sandbox_status(app: AppHandle) -> Result<Status, String> {
    let data_dir = project_file::data_dir(&app)?;
    Ok(status(Some(&data_dir)))
}

/// The Settings switch. It writes the same file `enabled` reads; the environment still wins when it is set.
#[tauri::command(async)]
pub fn agent_sandbox_set(app: AppHandle, enabled: bool) -> Result<Status, String> {
    if !cfg!(target_os = "macos") {
        return Err("The agent sandbox is only offered on macOS.".to_string());
    }
    let data_dir = project_file::data_dir(&app)?;
    write_setting(&data_dir, enabled)?;
    Ok(status(Some(&data_dir)))
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

/// A name as a case-insensitive regex for the profile: `.ssh` is `\.[sS][sS][hH]`, and `/` stays a path separator. Only
/// ASCII letters fold; regex-special characters are escaped and every other character matches as itself.
fn ci_regex(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphabetic() {
            out.push('[');
            out.push(c.to_ascii_lowercase());
            out.push(c.to_ascii_uppercase());
            out.push(']');
        } else if ".^$*+?()[]{}|\\".contains(c) {
            out.push('\\');
            out.push(c);
        } else {
            out.push(c);
        }
    }
    out
}

/// One deny line for a home-relative name: a folder (and everything in it) or a single file.
fn deny_line(home_regex: &str, name: &str, folder: bool) -> String {
    let tail = if folder { "(/|$)" } else { "$" };
    format!(
        r#"(deny file-read* file-write* (regex #"^{home_regex}/{}{tail}"))"#,
        ci_regex(name)
    )
}

/// The denylist profile for `home`. Allow by default; deny reads and writes of the secret places and shell profiles
/// (from the shared list); deny writes to `.git/hooks` and `.git/config` in any checkout (a worktree's git dir is under
/// the main one's `.git`).
pub fn profile_text(home: &Path) -> Result<String, String> {
    let list = home_secrets()?;
    let home = ci_regex(&quote_path(home)?);
    let mut lines = vec!["(version 1)".to_string(), "(allow default)".to_string()];
    push_denies(&mut lines, &home, list);
    lines.push(r#"(deny file-write* (regex #"/\.git/hooks(/|$)"))"#.to_string());
    lines.push(r#"(deny file-write* (regex #"/\.git/config$"))"#.to_string());
    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// The home-relative denies. `cli_login_files` is deliberately not read here: the CLI reads its own login file to log in.
fn push_denies(lines: &mut Vec<String>, home_regex: &str, list: &HomeSecrets) {
    for dir in &list.dirs {
        lines.push(deny_line(home_regex, dir, true));
    }
    for file in list.files.iter().chain(list.shell_profiles.iter()) {
        lines.push(deny_line(home_regex, file, false));
    }
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

    /// The places this file named before the shared list held them (the old `agentSecretPaths.json`). Each one must
    /// still be denied, so a drop from the shared list turns this red.
    const PREVIOUSLY_LISTED_DIRS: &[&str] = &[
        ".ssh",
        ".gnupg",
        ".aws",
        ".kube",
        ".docker",
        ".password-store",
        ".azure",
        ".config/gh",
        ".config/gcloud",
        ".config/rclone",
        ".config/wrangler",
        ".config/doctl",
        ".config/stripe",
        ".config/sops",
        "Library/Keychains",
    ];
    const PREVIOUSLY_LISTED_FILES: &[&str] = &[".netrc", ".npmrc", ".pypirc", ".git-credentials"];
    const PREVIOUSLY_LISTED_SHELL_PROFILES: &[&str] = &[
        ".zshrc",
        ".zprofile",
        ".zshenv",
        ".zlogin",
        ".bashrc",
        ".bash_profile",
        ".profile",
        ".config/fish/config.fish",
    ];
    const PREVIOUSLY_LISTED_CLI_LOGIN_FILES: &[&str] = &[
        ".claude.json",
        ".claude/.credentials.json",
        ".codex/auth.json",
    ];

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
    fn the_toggle_writes_the_file_the_switch_reads() {
        let data = temp_home("toggle");
        write_setting(&data, true).unwrap();
        let text = std::fs::read_to_string(data.join("settings").join(SETTING_FILE)).unwrap();
        assert!(switched_on(None, Some(&text)), "on is read back as on");
        write_setting(&data, false).unwrap();
        let text = std::fs::read_to_string(data.join("settings").join(SETTING_FILE)).unwrap();
        assert!(!switched_on(None, Some(&text)), "off is read back as off");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn the_profile_denies_ssh_shell_profiles_and_git_hook_and_config_writes() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        let home = ci_regex("/Users/test");
        assert!(profile.contains(&deny_line(&home, ".ssh", true)));
        assert!(profile.contains(&deny_line(&home, ".zshrc", false)));
        assert!(profile.contains(r#"(regex #"/\.git/hooks(/|$)")"#));
        assert!(profile.contains(r#"(regex #"/\.git/config$")"#));
        assert!(
            profile.starts_with("(version 1)\n(allow default)"),
            "a denylist, not a deny-default profile"
        );
    }

    #[test]
    fn the_profile_covers_every_previously_listed_secret_place() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        let home = ci_regex("/Users/test");
        for dir in PREVIOUSLY_LISTED_DIRS {
            assert!(
                profile.contains(&deny_line(&home, dir, true)),
                "the profile no longer denies the folder {dir}"
            );
        }
        for file in PREVIOUSLY_LISTED_FILES
            .iter()
            .chain(PREVIOUSLY_LISTED_SHELL_PROFILES)
        {
            assert!(
                profile.contains(&deny_line(&home, file, false)),
                "the profile no longer denies {file}"
            );
        }
    }

    #[test]
    fn the_cli_own_login_files_are_reported_and_never_denied_so_the_cli_can_still_log_in() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        let list = home_secrets().unwrap();
        for file in PREVIOUSLY_LISTED_CLI_LOGIN_FILES {
            assert!(
                list.cli_login_files.iter().any(|name| name == file),
                "{file} is still reported"
            );
            assert!(!profile.contains(&ci_regex(file)), "{file} is denied");
        }
        // The shared list's folder rules hold `.claude` and `.codex` at any depth for the delivery floor. The sandbox
        // reads only homeSecrets, so neither folder can reach the profile.
        assert!(!profile.contains("claude"), "no Claude folder in the profile");
        assert!(!profile.contains("codex"), "no Codex folder in the profile");
        assert!(!profile.contains("auth"), "no auth file in the profile");
    }

    #[test]
    fn the_secret_list_keeps_the_login_files_apart_from_the_denied_places() {
        let list = home_secrets().unwrap();
        for file in &list.cli_login_files {
            assert!(!list.dirs.contains(file) && !list.files.contains(file));
            assert!(!list.shell_profiles.contains(file));
        }
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
    fn a_refusal_to_start_is_written_to_the_activity_log() {
        let data = temp_home("refusal-row");
        let conn = rusqlite::Connection::open(data.join("monocode.db")).unwrap();
        crate::activity::ensure_tables(&conn).unwrap();
        drop(conn);
        note_refusal(&data, "chat-1", "The macOS sandbox could not start it.");
        let conn = rusqlite::Connection::open(data.join("monocode.db")).unwrap();
        let page = crate::activity::list(
            &conn,
            &crate::activity::ListQuery::default(),
            crate::session_store::now_millis(),
        )
        .unwrap();
        let rows = page.entries;
        assert_eq!(rows.len(), 1, "one refusal, one row");
        assert_eq!(rows[0].kind, crate::activity::SANDBOX_REFUSE);
        assert_eq!(rows[0].target, "chat-1");
        let _ = std::fs::remove_dir_all(&data);
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

    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_a_differently_cased_ssh_folder_is_refused_too() {
        use std::process::Stdio;
        let home = temp_home("case");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh").join("id_case"), "secret").unwrap();
        let profile = profile_text(&home).unwrap();
        // On a case-insensitive volume (APFS by default) `.SSH` is the same folder, so the read must be refused. On a
        // case-sensitive volume the name does not resolve, and the test says so instead of passing silently.
        if !home.join(".SSH").join("id_case").exists() {
            eprintln!("skipped: this volume is case-sensitive");
            let _ = std::fs::remove_dir_all(&home);
            return;
        }
        let read = Command::new(SANDBOX_EXEC)
            .args([
                "-p",
                &profile,
                "/bin/cat",
                &format!("{}/.SSH/id_case", home.display()),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!read.success(), "reading ~/.SSH must be refused");
        let _ = std::fs::remove_dir_all(&home);
    }
}
