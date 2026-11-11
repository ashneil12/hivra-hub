//! WP-178 item 3.1: the macOS sandbox profile for agent CLIs and project actions. Off by default; on by a setting.
//!
//! When the setting is on, `harness_spawn` starts each agent CLI as `/usr/bin/sandbox-exec -p <profile> <cli> <args…>`
//! (`sandboxed_launch`), and project actions and Setup run as `sandbox-exec -p <profile> /bin/sh -c <command>`
//! (`action_wrap`). The profile is a denylist: everything is allowed except what it names:
//!
//! - the secret places (SSH keys, GnuPG, cloud logins, keychains, password stores) and the shell profiles, read and
//!   written, and their real targets when they are links;
//! - the person's global git config, LaunchAgents and the CLIs' settings and hooks (`denyWrite` in the shared list);
//! - writes and links to `.git`, `.git/hooks`, `.git/config` and submodule hooks or config;
//! - the app's own switch folder and `monocode.db` (so a sandboxed agent cannot turn the sandbox off for the next start);
//! - running `launchctl`, `open`, `osascript` and `security`, and sending Apple events.
//!
//! The lists come from `src/shared/security/agentConfigPaths.json`, the same file the after-turn check reads. The CLIs'
//! own login files are listed as reported places only: the profile never denies them, because the CLI reads them to log
//! in. A denylist leaks everything it does not list: a copy of one of those programs under another name still runs, and
//! so does anything outside the lists. docs/hivra/work/WP-178-agent-os-sandbox.md has the full list of what is not stopped.
//!
//! Matching is ASCII case-insensitive (APFS is case-insensitive by default). The NFKC and long-s rules of the after-turn
//! check are not in the profile; the probes in the WP doc record what APFS folds here.
//!
//! Fail closed: before a sandboxed start, `sandbox-exec` runs `/usr/bin/true` under the same profile, and a start-up
//! self-check proves the profile refuses known reads and writes in a temporary home. If either fails, nothing starts.
//! The app never falls back to an unsandboxed start while the setting is on. Each refused start is written to the
//! activity log (`note_refusal`).
//!
//! The switch: `<app data>/settings/agent-sandbox` containing `on`, or the environment `MONOCODE_AGENT_SANDBOX=1`. The
//! environment can only turn the sandbox on: `0`, empty or `off` has no opinion and the file decides. A missing file is
//! off. A file that cannot be read, or that says neither on nor off, is on: a guess never turns the sandbox off.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::AppHandle;

use crate::activity::{self, Who};
use crate::delivery::protected::{home_secrets, protected_globs, HomeSecrets};
use crate::project_file;

pub const ENV_SWITCH: &str = "MONOCODE_AGENT_SANDBOX";
pub const SETTING_FILE: &str = "agent-sandbox";
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The daily app's data folder under home. A dev copy's folder (`com.ash.monocode-hub.dev.<slot>`) matches the same rule.
const APP_DATA_UNDER_HOME: &str = "Library/Application Support/com.ash.monocode-hub";

/// The programs an agent must not run: they reach the Keychain, login items, the browser or other apps' windows.
const DENIED_PROGRAMS: [&str; 4] = [
    "/bin/launchctl",
    "/usr/bin/open",
    "/usr/bin/osascript",
    "/usr/bin/security",
];

/// What a secret place is denied: read, write and link (a hard link is a second name for the same file).
const SECRET_OPS: &str = "file-read* file-write* file-link";
/// What a protected write is denied: write and link.
const WRITE_OPS: &str = "file-write* file-link";

/// What the switch file says, as read.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SwitchFile {
    Missing,
    Unreadable,
    Text(String),
}

pub(crate) fn read_switch_file(data_dir: &Path) -> SwitchFile {
    match std::fs::read_to_string(data_dir.join("settings").join(SETTING_FILE)) {
        Ok(text) => SwitchFile::Text(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => SwitchFile::Missing,
        Err(_) => SwitchFile::Unreadable,
    }
}

fn word_on(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "on" | "true" | "yes"
    )
}

fn word_off(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "0" | "off" | "false" | "no"
    )
}

/// The switch, decided. The environment can only turn the sandbox on; anything that does not say on has no opinion. A
/// missing file is off; a file that cannot be read, or says neither on nor off, is on.
pub(crate) fn decide(env: Option<&OsStr>, file: SwitchFile) -> bool {
    if env.and_then(OsStr::to_str).is_some_and(word_on) {
        return true;
    }
    match file {
        SwitchFile::Missing => false,
        SwitchFile::Unreadable => true,
        SwitchFile::Text(text) => !word_off(&text),
    }
}

/// The switch from its two sources, for tests that hold the file's text directly.
#[cfg(test)]
pub(crate) fn switched_on(env: Option<&OsStr>, file: Option<&str>) -> bool {
    decide(
        env,
        file.map_or(SwitchFile::Missing, |text| {
            SwitchFile::Text(text.to_string())
        }),
    )
}

/// Whether agent CLIs and project actions start under the sandbox: macOS only, and only when the switch says on.
pub fn enabled(data_dir: Option<&Path>) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let env = std::env::var_os(ENV_SWITCH);
    let file = data_dir.map_or(SwitchFile::Missing, read_switch_file);
    decide(env.as_deref(), file)
}

/// What the Settings toggle shows. `set_by_environment` means the environment says on, so the file cannot turn it off.
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
        set_by_environment: std::env::var_os(ENV_SWITCH)
            .and_then(|value| value.into_string().ok())
            .is_some_and(|value| word_on(&value)),
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

/// A refused start under the sandbox, in the activity log (WP-78). The target is the chat; the reason is the start's own
/// error, shortened. Nothing here reads a secret.
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

/// The Settings switch. It writes the same file `enabled` reads; the environment still wins when it says on.
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

/// A glob relative to home (`.claude/hooks/**`) as a regex: `**` any depth, `*` one segment, the rest literal.
fn glob_regex(glob: &str) -> String {
    glob.split('/')
        .map(|segment| match segment {
            "**" => ".*".to_string(),
            "*" => "[^/]*".to_string(),
            other => ci_regex(other),
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The spellings of a folder the profile must match: as given (no trailing slash), the canonical path when the folder
/// exists, and the `/private` form of the macOS links `/var`, `/tmp` and `/etc`. The kernel checks the resolved path.
fn folder_forms(folder: &Path) -> Result<Vec<String>, String> {
    let mut given = quote_path(folder)?;
    while given.len() > 1 && given.ends_with('/') {
        given.pop();
    }
    let mut forms = vec![given.clone()];
    if let Ok(real) = std::fs::canonicalize(folder) {
        let real = quote_path(&real)?;
        if !forms.contains(&real) {
            forms.push(real);
        }
    }
    for top in ["/var", "/tmp", "/etc"] {
        if given == top || given.starts_with(&format!("{top}/")) {
            let private = format!("/private{given}");
            if !forms.contains(&private) {
                forms.push(private);
            }
        }
    }
    Ok(forms)
}

/// One deny line for a home-relative name (a folder and everything in it, or one file), in every spelling of home.
fn push_home_entry(lines: &mut Vec<String>, forms: &[String], name: &str, folder: bool, ops: &str) {
    let tail = if folder { "(/|$)" } else { "$" };
    for form in forms {
        lines.push(format!(
            r#"(deny {ops} (regex #"^{}/{}{tail}"))"#,
            ci_regex(form),
            ci_regex(name)
        ));
    }
}

/// One deny line for an absolute path that a link resolves to.
fn push_absolute(lines: &mut Vec<String>, path: &str, folder: bool, ops: &str) {
    let tail = if folder { "(/|$)" } else { "$" };
    lines.push(format!(
        r#"(deny {ops} (regex #"^{}{tail}"))"#,
        ci_regex(path)
    ));
}

/// The real target of a secret place that is a link, when it lives somewhere else. Denying the target too means a write
/// through another name (`~/.zshrc` into a dotfiles repo) is refused.
fn push_real_target(lines: &mut Vec<String>, home: &Path, name: &str, folder: bool) {
    let lexical = home.join(name);
    if std::fs::symlink_metadata(&lexical).is_err() {
        return;
    }
    let Ok(real) = std::fs::canonicalize(&lexical) else {
        return;
    };
    if real == lexical {
        return;
    }
    if let Some(text) = real
        .to_str()
        .filter(|t| !t.contains('"') && !t.contains('\\'))
    {
        push_absolute(lines, text, folder, SECRET_OPS);
    }
}

/// The profile for `home`, with the app's own data folders under home protected (see `profile_text_for`).
#[cfg(test)]
pub fn profile_text(home: &Path) -> Result<String, String> {
    profile_text_for(home, None)
}

/// The denylist profile for `home`. Allow by default. Denies, in order: the secret places and shell profiles (every
/// spelling of home, and their real targets), the protected writes from the shared list, the app's switch folder and
/// `monocode.db` (the default data folder under home and any dev copy's, plus `data_dir` when given), the git writes and
/// links, the denied programs, and Apple events.
pub fn profile_text_for(home: &Path, data_dir: Option<&Path>) -> Result<String, String> {
    let list = home_secrets()?;
    let forms = folder_forms(home)?;
    let mut lines = vec!["(version 1)".to_string(), "(allow default)".to_string()];
    push_secret_places(&mut lines, home, &forms, list);
    push_protected_writes(&mut lines, &forms)?;
    push_app_data(&mut lines, &forms);
    if let Some(data) = data_dir {
        push_explicit_data(&mut lines, data)?;
    }
    push_git_writes(&mut lines);
    for program in DENIED_PROGRAMS {
        lines.push(format!(
            r#"(deny process-exec (regex #"^{}$"))"#,
            ci_regex(program)
        ));
    }
    lines.push("(deny appleevent-send)".to_string());
    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// The secret places and shell profiles. `cli_login_files` is deliberately not here: the CLI reads its own login file to
/// log in, so it is reported by the after-turn check and never denied.
fn push_secret_places(lines: &mut Vec<String>, home: &Path, forms: &[String], list: &HomeSecrets) {
    for dir in &list.dirs {
        push_home_entry(lines, forms, dir, true, SECRET_OPS);
        push_real_target(lines, home, dir, true);
    }
    for file in list.files.iter().chain(list.shell_profiles.iter()) {
        push_home_entry(lines, forms, file, false, SECRET_OPS);
        push_real_target(lines, home, file, false);
    }
}

/// The shared list's `denyWrite` globs under home: the person's global git config, LaunchAgents, and the CLIs' settings
/// and hooks. Reads stay allowed; only a write or a link is refused.
fn push_protected_writes(lines: &mut Vec<String>, forms: &[String]) -> Result<(), String> {
    for glob in protected_globs()?.iter().filter(|glob| glob.deny_write) {
        let Some(relative) = glob.pattern.strip_prefix("~/") else {
            continue;
        };
        for form in forms {
            lines.push(format!(
                r#"(deny {WRITE_OPS} (regex #"^{}/{}$"))"#,
                ci_regex(form),
                glob_regex(relative)
            ));
        }
    }
    Ok(())
}

/// The app's switch folder and `monocode.db` under home, in the daily folder and any dev copy's folder (their names share
/// the prefix). Agent processes may not write them.
fn push_app_data(lines: &mut Vec<String>, forms: &[String]) {
    for form in forms {
        let app = format!("{}/{}", ci_regex(form), ci_regex(APP_DATA_UNDER_HOME));
        lines.push(format!(
            r#"(deny {WRITE_OPS} (regex #"^{app}[^/]*/settings(/|$)"))"#
        ));
        lines.push(format!(
            r#"(deny {WRITE_OPS} (regex #"^{app}[^/]*/monocode\.db(-wal|-shm|-journal)?$"))"#
        ));
    }
}

/// The switch folder and `monocode.db` of a data folder that is not under home (a test's, or a moved one).
fn push_explicit_data(lines: &mut Vec<String>, data: &Path) -> Result<(), String> {
    for form in folder_forms(data)? {
        let base = ci_regex(&form);
        lines.push(format!(
            r#"(deny {WRITE_OPS} (regex #"^{base}/settings(/|$)"))"#
        ));
        lines.push(format!(
            r#"(deny {WRITE_OPS} (regex #"^{base}/monocode\.db(-wal|-shm|-journal)?$"))"#
        ));
    }
    Ok(())
}

/// Writes and links to `.git` itself (a linked worktree's `.git` file redirects git to a folder the agent wrote, and
/// `mv .git` takes the repository away), to `.git/hooks`, `.git/config`, and a submodule's hooks and config.
fn push_git_writes(lines: &mut Vec<String>) {
    lines.push(format!(
        r#"(deny {WRITE_OPS} (regex #"/{}$"))"#,
        ci_regex(".git")
    ));
    lines.push(format!(
        r#"(deny {WRITE_OPS} (regex #"/{}(/|$)"))"#,
        ci_regex(".git/hooks")
    ));
    lines.push(format!(
        r#"(deny {WRITE_OPS} (regex #"/{}$"))"#,
        ci_regex(".git/config")
    ));
    lines.push(format!(
        r#"(deny {WRITE_OPS} (regex #"/{}/[^/]+/(hooks(/|$)|config$)"))"#,
        ci_regex(".git/modules")
    ));
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
    )
    .trim_end()
    .to_string())
}

/// Proves the profile refuses what it names, once per process, in a temporary home: a read of a secret folder, a read
/// through a link to a secret, a write to the switch file and to `monocode.db`, and running `security`. An ordinary
/// write in the same folder must still succeed, so a profile that refuses everything does not pass.
pub fn self_check(sandbox_exec: &Path) -> Result<(), String> {
    static CHECKED: OnceLock<Result<(), String>> = OnceLock::new();
    // Only the real launcher's answer is kept for the process. Any other launcher (a test's stand-in) is checked afresh,
    // so one stand-in's refusal can never stand in for the real sandbox.
    if sandbox_exec != Path::new(SANDBOX_EXEC) {
        return run_self_check(sandbox_exec);
    }
    CHECKED.get_or_init(|| run_self_check(sandbox_exec)).clone()
}

fn run_self_check(sandbox_exec: &Path) -> Result<(), String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = std::env::temp_dir().join(format!(
        "agent-sandbox-self-check-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&base).map_err(|e| format!("agent sandbox self-check: {e}"))?;
    let result = self_check_in(sandbox_exec, &base);
    let _ = std::fs::remove_dir_all(&base);
    result
}

fn self_check_in(sandbox_exec: &Path, base: &Path) -> Result<(), String> {
    let base = std::fs::canonicalize(base).map_err(|e| format!("agent sandbox self-check: {e}"))?;
    let home = base.join("home");
    let data = home.join(APP_DATA_UNDER_HOME);
    let io = |e: std::io::Error| format!("agent sandbox self-check: {e}");
    std::fs::create_dir_all(home.join(".ssh")).map_err(io)?;
    std::fs::create_dir_all(home.join("dotfiles")).map_err(io)?;
    std::fs::create_dir_all(data.join("settings")).map_err(io)?;
    std::fs::write(home.join(".ssh").join("probe"), "probe").map_err(io)?;
    std::fs::write(home.join("dotfiles").join("zshrc"), "export A=1\n").map_err(io)?;
    std::os::unix::fs::symlink(home.join("dotfiles").join("zshrc"), home.join(".zshrc"))
        .map_err(io)?;
    std::fs::write(data.join("settings").join(SETTING_FILE), "on\n").map_err(io)?;
    std::fs::write(data.join("monocode.db"), "db").map_err(io)?;
    let profile = profile_text_for(&home, Some(&data))?;

    let run = |script: String| -> bool {
        Command::new(sandbox_exec)
            .args(["-p", &profile, "/bin/sh", "-c", &script])
            .current_dir(&base)
            .env("HOME", &home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    };
    let must_refuse = [
        (
            "a read of ~/.ssh",
            format!("cat '{}/.ssh/probe'", home.display()),
        ),
        (
            "a read through the ~/.zshrc link",
            format!("cat '{}/.zshrc'", home.display()),
        ),
        (
            "a write to the switch file",
            format!("echo off > '{}/settings/{SETTING_FILE}'", data.display()),
        ),
        (
            "a write to monocode.db",
            format!("echo x >> '{}/monocode.db'", data.display()),
        ),
        (
            "running /usr/bin/security",
            "/usr/bin/security -h".to_string(),
        ),
    ];
    for (what, script) in must_refuse {
        if run(script) {
            return Err(format!(
                "agent sandbox self-check failed: the profile allowed {what}, so no agent starts sandboxed"
            ));
        }
    }
    if !run(format!("echo ok > '{}/ok.txt'", base.display())) {
        return Err(
            "agent sandbox self-check failed: the profile refused an ordinary write, so no agent starts sandboxed"
                .to_string(),
        );
    }
    Ok(())
}

/// The program and the leading arguments that start `cli` under the sandbox, after the profile passes its preflight and
/// the self-check.
pub fn sandboxed_launch(
    cli: &OsStr,
    home: &Path,
    data_dir: Option<&Path>,
    sandbox_exec: &Path,
) -> Result<(OsString, Vec<OsString>), String> {
    let profile = profile_text_for(home, data_dir)?;
    self_check(sandbox_exec)?;
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

/// How a project action starts when the sandbox is on: `sandbox-exec -p <profile>` in front of its shell. Off, nothing.
pub fn action_wrap(data_dir: Option<&Path>) -> Result<Option<Vec<OsString>>, String> {
    if !enabled(data_dir) {
        return Ok(None);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
        "The action did not start: HOME is not set, so the macOS sandbox cannot be built."
            .to_string()
    })?;
    let profile = profile_text_for(&home, data_dir)?;
    self_check(Path::new(SANDBOX_EXEC))?;
    preflight_with(Path::new(SANDBOX_EXEC), &profile)?;
    Ok(Some(vec![
        OsString::from(SANDBOX_EXEC),
        OsString::from("-p"),
        OsString::from(profile),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The places named before the shared list held them (the old `agentSecretPaths.json`). Each must still be denied,
    /// so a drop from the shared list turns this red.
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

    /// Whether the profile's deny lines refuse `op` on `path`, evaluated with the `regex` crate (the patterns use only
    /// `^ $ [] () | \.`, which mean the same in SBPL's regex engine).
    fn denies(profile: &str, op: &str, path: &str) -> bool {
        profile.lines().any(|line| {
            let line = line.trim();
            if !line.starts_with("(deny ") || !line.contains(op) {
                return false;
            }
            let Some(start) = line.find("(regex #\"") else {
                return false;
            };
            let rest = &line[start + "(regex #\"".len()..];
            let Some(end) = rest.find("\"))") else {
                return false;
            };
            regex::Regex::new(&rest[..end]).is_ok_and(|re| re.is_match(path))
        })
    }

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
    fn the_switch_is_off_by_default_and_a_file_or_env_turns_it_on() {
        assert!(!switched_on(None, None));
        assert!(switched_on(None, Some("on\n")));
        assert!(!switched_on(None, Some("off")));
        assert!(switched_on(Some(OsStr::new("1")), None));
    }

    #[test]
    fn the_environment_can_only_tighten_never_turn_the_sandbox_off() {
        assert!(
            switched_on(Some(OsStr::new("0")), Some("on\n")),
            "MONOCODE_AGENT_SANDBOX=0 turns off a sandbox Ash switched on"
        );
        assert!(switched_on(Some(OsStr::new("off")), Some("on")));
        assert!(switched_on(Some(OsStr::new("")), Some("on")));
        assert!(
            !switched_on(Some(OsStr::new("0")), None),
            "a zero env with no file has no opinion"
        );
    }

    #[test]
    fn an_unreadable_or_garbled_switch_file_reads_on() {
        assert!(
            decide(None, SwitchFile::Unreadable),
            "a file that cannot be read is on"
        );
        assert!(
            decide(None, SwitchFile::Text("maybe".to_string())),
            "a garbled file is on"
        );
        assert!(
            decide(None, SwitchFile::Text(String::new())),
            "an empty file is on"
        );
        assert!(!decide(None, SwitchFile::Text("off".to_string())));
        assert!(!decide(None, SwitchFile::Missing));
    }

    #[test]
    fn the_toggle_writes_the_file_the_switch_reads() {
        let data = temp_home("toggle");
        write_setting(&data, true).unwrap();
        assert!(
            decide(None, read_switch_file(&data)),
            "on is read back as on"
        );
        write_setting(&data, false).unwrap();
        assert!(
            !decide(None, read_switch_file(&data)),
            "off is read back as off"
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn the_profile_denies_ssh_shell_profiles_and_git_writes() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        assert!(denies(
            &profile,
            "file-read*",
            "/Users/test/.ssh/id_ed25519"
        ));
        assert!(denies(&profile, "file-write*", "/Users/test/.zshrc"));
        assert!(denies(
            &profile,
            "file-write*",
            "/Users/test/proj/.git/hooks/pre-commit"
        ));
        assert!(denies(
            &profile,
            "file-write*",
            "/Users/test/proj/.git/config"
        ));
        assert!(
            denies(&profile, "file-write*", "/Users/test/proj/.git"),
            "mv .git is a write to .git"
        );
        assert!(
            denies(&profile, "file-link", "/Users/test/.ssh/id_ed25519"),
            "a hard link is denied"
        );
        assert!(denies(
            &profile,
            "file-write*",
            "/Users/test/proj/.git/modules/x/hooks/pre-push"
        ));
        assert!(
            profile.starts_with("(version 1)\n(allow default)"),
            "a denylist, not a deny-default profile"
        );
    }

    #[test]
    fn the_profile_covers_every_previously_listed_secret_place() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        for dir in PREVIOUSLY_LISTED_DIRS {
            assert!(
                denies(&profile, "file-read*", &format!("/Users/test/{dir}/inside")),
                "the profile no longer denies the folder {dir}"
            );
        }
        for file in PREVIOUSLY_LISTED_FILES
            .iter()
            .chain(PREVIOUSLY_LISTED_SHELL_PROFILES)
        {
            assert!(
                denies(&profile, "file-read*", &format!("/Users/test/{file}")),
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
            assert!(
                !denies(&profile, "file-read*", &format!("/Users/test/{file}")),
                "{file} is denied for reads"
            );
            assert!(
                !denies(&profile, "file-write*", &format!("/Users/test/{file}")),
                "{file} is denied for writes"
            );
        }
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
    fn the_person_global_git_config_and_launch_agents_cannot_be_written() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        for path in [
            "/Users/test/.gitconfig",
            "/Users/test/.config/git/config",
            "/Users/test/Library/LaunchAgents/com.x.plist",
            "/Users/test/.claude/settings.json",
            "/Users/test/.claude/settings.local.json",
            "/Users/test/.codex/config.toml",
            "/Users/test/.claude/hooks/on-stop.sh",
        ] {
            assert!(denies(&profile, "file-write*", path), "{path} is writable");
        }
    }

    #[test]
    fn the_app_switch_and_database_cannot_be_written_by_an_agent() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        let switch =
            "/Users/test/Library/Application Support/com.ash.monocode-hub/settings/agent-sandbox";
        assert!(
            denies(&profile, "file-write*", switch),
            "a sandboxed agent can write {switch}"
        );
        assert!(denies(
            &profile,
            "file-write*",
            "/Users/test/Library/Application Support/com.ash.monocode-hub/monocode.db"
        ));
        assert!(denies(
            &profile,
            "file-write*",
            "/Users/test/Library/Application Support/com.ash.monocode-hub.dev.slot/settings/agent-sandbox"
        ));
    }

    #[test]
    fn the_denied_programs_and_apple_events_are_refused() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        for program in [
            "/bin/launchctl",
            "/usr/bin/open",
            "/usr/bin/osascript",
            "/usr/bin/security",
        ] {
            assert!(
                denies(&profile, "process-exec", program),
                "{program} may run"
            );
        }
        assert!(profile.contains("(deny appleevent-send)"));
    }

    #[test]
    fn a_non_canonical_home_still_denies_the_resolved_ssh_path() {
        let trailing = profile_text(Path::new("/Users/test/")).unwrap();
        assert!(
            denies(&trailing, "file-read*", "/Users/test/.ssh/id_ed25519"),
            "HOME=/Users/test/ denies nothing"
        );
        let var = profile_text(Path::new("/var/folders/ab/T/home")).unwrap();
        assert!(
            denies(
                &var,
                "file-read*",
                "/private/var/folders/ab/T/home/.ssh/id_ed25519"
            ),
            "a /var HOME misses the /private/var path the sandbox matches"
        );
    }

    #[test]
    fn a_home_path_the_profile_cannot_quote_is_refused_not_guessed() {
        assert!(profile_text(Path::new("/Users/te\"st")).is_err());
        assert!(profile_text(Path::new("/Users/te\\st")).is_err());
    }

    #[test]
    fn a_sandbox_that_fails_to_start_refuses_the_launch_and_never_runs_unsandboxed() {
        let home = temp_home("fail-closed");
        let refused = sandboxed_launch(
            OsStr::new("claude"),
            &home,
            None,
            Path::new("/usr/bin/false"),
        );
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
        assert!(
            !enabled(None),
            "off by default: no data folder, no environment switch"
        );
        assert!(matches!(action_wrap(None), Ok(None)));
    }

    #[cfg(target_os = "macos")]
    fn run_under(profile: &str, cwd: &Path, home: &Path, script: &str) -> bool {
        Command::new(SANDBOX_EXEC)
            .args(["-p", profile, "/bin/sh", "-c", script])
            .current_dir(cwd)
            .env("HOME", home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_sandboxed_launch_wraps_the_cli_in_sandbox_exec_with_the_profile() {
        let home = temp_home("wrap");
        let (program, prefix) =
            sandboxed_launch(OsStr::new("claude"), &home, None, Path::new(SANDBOX_EXEC)).unwrap();
        assert_eq!(program, OsString::from(SANDBOX_EXEC));
        assert_eq!(prefix[0], OsString::from("-p"));
        assert_eq!(prefix[2], OsString::from("claude"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_self_check_passes_on_this_mac() {
        assert_eq!(
            run_self_check(Path::new(SANDBOX_EXEC)),
            Ok(()),
            "the start-up self-check passes under sandbox-exec"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_a_read_of_ssh_and_a_write_to_git_hooks_are_refused() {
        let home = temp_home("refuse");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh").join("id_test"), "secret").unwrap();
        let project = home.join("project");
        std::fs::create_dir_all(project.join(".git").join("hooks")).unwrap();
        let data = home.join(APP_DATA_UNDER_HOME);
        std::fs::create_dir_all(data.join("settings")).unwrap();
        let profile = profile_text_for(&home, Some(&data)).unwrap();
        assert!(!run_under(
            &profile,
            &project,
            &home,
            &format!("cat '{}/.ssh/id_test'", home.display())
        ));
        assert!(!run_under(
            &profile,
            &project,
            &home,
            "echo x > .git/hooks/pre-commit"
        ));
        assert!(!run_under(
            &profile,
            &project,
            &home,
            "mv .git .gitx && mv .gitx .git"
        ));
        assert!(
            run_under(&profile, &project, &home, "echo ok > allowed.txt"),
            "a write outside the list works"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_a_differently_cased_ssh_folder_is_refused_too() {
        let home = temp_home("case");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh").join("id_case"), "secret").unwrap();
        let data = home.join(APP_DATA_UNDER_HOME);
        std::fs::create_dir_all(&data).unwrap();
        let profile = profile_text_for(&home, Some(&data)).unwrap();
        // On a case-insensitive volume (APFS by default) `.SSH` is the same folder, so the read must be refused. On a
        // case-sensitive volume the name does not resolve, and the test returns instead of passing silently.
        if home.join(".SSH").join("id_case").exists() {
            assert!(!run_under(
                &profile,
                &home,
                &home,
                &format!("/bin/cat '{}/.SSH/id_case'", home.display())
            ));
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_the_switch_file_and_security_cannot_be_used() {
        let home = temp_home("switch");
        let data = home.join(APP_DATA_UNDER_HOME);
        std::fs::create_dir_all(data.join("settings")).unwrap();
        std::fs::write(data.join("settings").join(SETTING_FILE), "on\n").unwrap();
        let profile = profile_text_for(&home, Some(&data)).unwrap();
        assert!(!run_under(
            &profile,
            &home,
            &home,
            &format!("echo off > '{}/settings/{SETTING_FILE}'", data.display())
        ));
        assert!(!run_under(&profile, &home, &home, "/usr/bin/security -h"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_a_write_through_a_link_to_a_secret_target_is_refused() {
        let home = temp_home("link");
        let dotfiles = home.join("dotfiles");
        std::fs::create_dir_all(&dotfiles).unwrap();
        std::fs::write(dotfiles.join("zshrc"), "export A=1\n").unwrap();
        std::os::unix::fs::symlink(dotfiles.join("zshrc"), home.join(".zshrc")).unwrap();
        let data = home.join(APP_DATA_UNDER_HOME);
        std::fs::create_dir_all(&data).unwrap();
        let profile = profile_text_for(&home, Some(&data)).unwrap();
        assert!(!run_under(
            &profile,
            &home,
            &home,
            &format!("echo x >> '{}/.zshrc'", home.display())
        ));
        assert!(
            !run_under(
                &profile,
                &home,
                &home,
                &format!("echo x >> '{}/dotfiles/zshrc'", home.display())
            ),
            "the link's real target is denied too"
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}

/// Review r3 repro tests for PR #208. Each states a property the profile should hold and is red at 4417a9621. The
/// evaluator reads `regex`, `literal` and `subpath` filters, and takes any `file-write…` operation (a rename is checked
/// as a write on the source and the target, never on the files inside a renamed folder).
#[cfg(test)]
mod review_r3_repro {
    use super::*;

    fn filter_matches(line: &str, path: &str) -> bool {
        if let Some(start) = line.find("(regex #\"") {
            let rest = &line[start + "(regex #\"".len()..];
            return rest.find("\")").is_some_and(|end| {
                regex::Regex::new(&rest[..end]).is_ok_and(|re| re.is_match(path))
            });
        }
        for (open, subpath) in [("(literal \"", false), ("(subpath \"", true)] {
            if let Some(start) = line.find(open) {
                let rest = &line[start + open.len()..];
                let Some(end) = rest.find('"') else {
                    return false;
                };
                let named = &rest[..end];
                return path == named
                    || (subpath && path.starts_with(&format!("{}/", named.trim_end_matches('/'))));
            }
        }
        false
    }

    /// Whether some deny line names a `file-write…` operation for `path`.
    fn denies_write(profile: &str, path: &str) -> bool {
        profile.lines().any(|line| {
            let line = line.trim();
            line.starts_with("(deny ") && line.contains("file-write") && filter_matches(line, path)
        })
    }

    const HOME: &str = "/Users/test";

    /// HIGH-1 is still open: `mv "~/Library/Application Support/com.ash.monocode-hub" …x` is a write to the folder
    /// itself, which no rule names. The switch file then reads Missing, which is off, for the very next start.
    #[test]
    fn renaming_the_data_folder_or_a_parent_of_it_is_refused() {
        let profile = profile_text(Path::new(HOME)).unwrap();
        for path in [
            "/Users/test/Library/Application Support/com.ash.monocode-hub",
            "/Users/test/Library/Application Support/com.ash.monocode-hub.dev.slot",
            "/Users/test/Library/Application Support",
            "/Users/test/Library",
        ] {
            assert!(
                denies_write(&profile, path),
                "{path} can be renamed away, so the switch reads missing (off) at the next start"
            );
        }
    }

    /// The `denyWrite` globs under home name only what is inside a folder. Renaming the folder (or a parent) out, editing
    /// it and renaming it back is never matched: a LaunchAgent, a global git config, a Claude hook.
    #[test]
    fn renaming_a_protected_folder_or_its_parent_is_refused() {
        let profile = profile_text(Path::new(HOME)).unwrap();
        for path in [
            "/Users/test/Library/LaunchAgents",
            "/Users/test/.config/git",
            "/Users/test/.config/opencode",
            "/Users/test/.config",
            "/Users/test/.claude",
            "/Users/test/.claude/hooks",
        ] {
            assert!(
                denies_write(&profile, path),
                "{path} can be renamed, edited outside the rule and renamed back"
            );
        }
    }

    /// The app runs what its data folder says, outside the profile: a worker gate (`gates/<project>.json` and its
    /// script, run when a delegated worker reports done) and a ship record (`ship/current.json`, run at the next start).
    #[test]
    fn the_rest_of_the_data_folder_cannot_be_written() {
        let profile = profile_text(Path::new(HOME)).unwrap();
        let data = "/Users/test/Library/Application Support/com.ash.monocode-hub";
        for name in [
            "gates/proj.json",
            "gates/check.mjs",
            "ship/current.json",
            "ship/planted/state.json",
            "ship/planted/runner.mjs",
        ] {
            let path = format!("{data}/{name}");
            assert!(
                denies_write(&profile, &path),
                "{path} is writable, and the app runs what it names outside the sandbox"
            );
        }
    }

    /// `.git/commondir` (and a linked worktree's `commondir`) tells git where the config is. The profile denies
    /// `.git/config` but not these, so the agent points git at a config it wrote (see checkout_guard's r3 repro).
    #[test]
    fn a_git_common_dir_redirect_cannot_be_written() {
        let profile = profile_text(Path::new(HOME)).unwrap();
        for path in [
            "/Users/test/proj/.git/commondir",
            "/Users/test/proj/.git/worktrees/wt/commondir",
            "/Users/test/proj/.git/worktrees/wt/config.worktree",
        ] {
            assert!(
                denies_write(&profile, path),
                "{path} is writable: git reads the repository config from wherever it points"
            );
        }
    }

    /// r2 MED-2 was fixed for the secret places only: their real targets are denied when they are links. The `denyWrite`
    /// globs are not resolved, so a `~/.gitconfig` or `~/.claude/settings.json` kept in a dotfiles folder (a link, as
    /// dotfile managers make them) is written through its real path.
    #[cfg(unix)]
    #[test]
    fn a_linked_global_git_config_or_claude_settings_is_denied_at_its_real_path() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let home =
            std::env::temp_dir().join(format!("sbx-r3-links-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(home.join("dotfiles")).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let home = std::fs::canonicalize(&home).unwrap();
        std::fs::write(home.join("dotfiles/gitconfig"), "[user]\n").unwrap();
        std::fs::write(home.join("dotfiles/claude-settings.json"), "{}\n").unwrap();
        std::os::unix::fs::symlink(home.join("dotfiles/gitconfig"), home.join(".gitconfig"))
            .unwrap();
        std::os::unix::fs::symlink(
            home.join("dotfiles/claude-settings.json"),
            home.join(".claude/settings.json"),
        )
        .unwrap();
        let profile = profile_text(&home).unwrap();
        let targets = [
            home.join("dotfiles/gitconfig"),
            home.join("dotfiles/claude-settings.json"),
        ];
        let _ = std::fs::remove_dir_all(&home);
        for target in targets {
            let target = target.to_string_lossy().to_string();
            assert!(
                denies_write(&profile, &target),
                "{target} (the real file behind a protected link) is writable"
            );
        }
    }

    /// L2: a submodule's git dir is `.git/modules/<name>`, and a name is its path (`vendor/lib`), so it often has a
    /// slash; nested submodules sit under `.git/modules/<a>/modules/<b>`. The profile allows one segment only.
    #[test]
    fn a_submodule_with_a_slash_in_its_name_has_its_hooks_and_config_denied() {
        let profile = profile_text(Path::new(HOME)).unwrap();
        for path in [
            "/Users/test/proj/.git/modules/vendor/lib/hooks/pre-commit",
            "/Users/test/proj/.git/modules/vendor/lib/config",
            "/Users/test/proj/.git/modules/a/modules/b/hooks/pre-commit",
        ] {
            assert!(denies_write(&profile, path), "{path} is writable");
        }
    }

    #[cfg(target_os = "macos")]
    fn temp_home(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("sbx-r3-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    /// The same as `renaming_the_data_folder_or_a_parent_of_it_is_refused`, under the real `sandbox-exec`.
    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_renaming_the_data_folder_does_not_turn_the_sandbox_off() {
        let home = temp_home("rename");
        let data = home.join(APP_DATA_UNDER_HOME);
        std::fs::create_dir_all(data.join("settings")).unwrap();
        std::fs::write(data.join("settings").join(SETTING_FILE), "on\n").unwrap();
        let profile = profile_text_for(&home, Some(&data)).unwrap();
        let moved = Command::new(SANDBOX_EXEC)
            .args(["-p", &profile, "/bin/mv"])
            .arg(&data)
            .arg(home.join("Library/Application Support/elsewhere"))
            .env("HOME", &home)
            .status()
            .unwrap()
            .success();
        let on = decide(None, read_switch_file(&data));
        let _ = std::fs::remove_dir_all(&home);
        assert!(!moved, "a sandboxed mv renamed the data folder away");
        assert!(on, "after the rename the switch reads off");
    }

    /// The exec denies are by path. A copy of launchctl runs under the profile, and a job it submits starts outside
    /// the sandbox. This only runs `version`; it submits nothing.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_copied_launchctl_is_refused_too() {
        let home = temp_home("copy");
        let copy = home.join("lc");
        std::fs::copy("/bin/launchctl", &copy).unwrap();
        let profile = profile_text(&home).unwrap();
        let ran = Command::new(SANDBOX_EXEC)
            .args(["-p", &profile])
            .arg(&copy)
            .arg("version")
            .env("HOME", &home)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        let _ = std::fs::remove_dir_all(&home);
        assert!(!ran, "a copy of /bin/launchctl ran under the profile");
    }

    /// Functional: Claude Code on macOS reads its sign-in with `security find-generic-password -a $USER -w -s "Claude
    /// Code-credentials"` (cli.js 2.1.42). With `/usr/bin/security` denied, a sandboxed Claude has no login.
    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_claude_code_can_still_run_security_for_its_sign_in() {
        let home = temp_home("security");
        let profile = profile_text(&home).unwrap();
        let status = Command::new(SANDBOX_EXEC)
            .args([
                "-p",
                &profile,
                "/bin/sh",
                "-c",
                "/usr/bin/security -h >/dev/null 2>&1; test $? -ne 126",
            ])
            .env("HOME", &home)
            .status()
            .unwrap();
        let _ = std::fs::remove_dir_all(&home);
        assert!(
            status.success(),
            "Claude Code's sign-in path (/usr/bin/security) is refused under the profile"
        );
    }
}
