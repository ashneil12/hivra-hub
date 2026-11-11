//! WP-178 item 3.1: the macOS sandbox profile for agent CLIs and project actions. Off by default; on by a setting.
//!
//! When the setting is on, `harness_spawn` starts each agent CLI as `/usr/bin/sandbox-exec -p <profile> <cli> <args…>`
//! (`sandboxed_launch`), and project actions and Setup run as `sandbox-exec -p <profile> /bin/sh -c <command>`
//! (`action_wrap`). The profile is a denylist: everything is allowed except what it names:
//!
//! - the secret places (SSH keys, GnuPG, cloud logins, password stores) and the shell profiles, read and written, and
//!   their real targets when they are links. Keychains are write-only: a read deny there breaks `security`, which a CLI
//!   needs to log in;
//! - the person's global git config (including a link's target and `include.path` files), LaunchAgents and the CLIs'
//!   settings and hooks (`denyWrite` in the shared list);
//! - writes and links to the named checkouts' `.git` (the directory, hooks, config and attributes), including the common
//!   dir of a linked worktree and the repository that contains a subfolder. A temp clone that is not a named checkout
//!   keeps its own `.git`, so `git worktree add` and `git submodule update` still work there;
//! - the whole app data folder (`com.ash.monocode-hub` and a dev copy's), so a gate script or a ship file cannot be planted;
//! - renaming that folder, or a parent of any protected path, up to and including the home folder (unlink of the directory
//!   node only, so a file inside home can still be removed);
//! - running `launchctl`, `open`, `osascript`, `crontab`, `at` and `hdiutil`. `security` is allowed. Creating a login item (`job-creation`), opening
//!   another app (`lsopen`) and sending Apple events are refused even when the program is a copy under another name.
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

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

/// Programs refused by path. `security` is not here: Claude Code logs in through it (review r4, H3). A copy of one of
/// these under another name is not caught by this list; `job-creation` and `lsopen` cover what the copy would do.
const DENIED_PROGRAMS: [&str; 6] = [
    "/bin/launchctl",
    "/usr/bin/open",
    "/usr/bin/osascript",
    "/usr/bin/crontab",
    "/usr/bin/at",
    "/usr/sbin/hdiutil",
];

/// Unlink of the home directory node. A macOS probe checks that `rm` of a file inside home still works; if it does not,
/// this stays false and home itself is not locked.
const LOCK_HOME_NODE: bool = true;

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
    // No data folder means the switch cannot be read. That is on, not off: a missing folder is not a choice to
    // leave agents unwrapped. A file that is simply absent, inside a folder we could open, stays off (`Missing`).
    let file = match data_dir {
        Some(dir) => read_switch_file(dir),
        None => SwitchFile::Unreadable,
    };
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

/// The real target of a place that is a link, when it lives somewhere else. Denying the target too means a write
/// through another name (`~/.gitconfig` into a dotfiles repo) is refused. `ops` is `SECRET_OPS` or `WRITE_OPS`.
fn push_real_target(lines: &mut Vec<String>, home: &Path, name: &str, folder: bool, ops: &str) {
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
        .filter(|t| !t.contains('"') && !t.contains('\\') && !t.contains('\n'))
    {
        push_absolute(lines, text, folder, ops);
    }
}

/// The login home from the password database, not from `HOME`. A profile built for a temporary home still names the
/// real `~/.ssh` and the daily data folder. The paths are not opened.
#[cfg(unix)]
fn passwd_home() -> Option<PathBuf> {
    // SAFETY: getpwuid's pointer is only read to copy the directory string out, before any other libc call.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() {
            return None;
        }
        let dir = (*pw).pw_dir;
        if dir.is_null() {
            return None;
        }
        let text = std::ffi::CStr::from_ptr(dir).to_str().ok()?;
        if text.is_empty() {
            return None;
        }
        Some(PathBuf::from(text))
    }
}

#[cfg(not(unix))]
fn passwd_home() -> Option<PathBuf> {
    None
}

fn same_folder(a: &Path, b: &Path) -> bool {
    match (folder_forms(a), folder_forms(b)) {
        (Ok(left), Ok(right)) => left
            .iter()
            .any(|one| right.iter().any(|other| one == other)),
        _ => false,
    }
}

fn inside_home(home: &Path, path: &Path) -> bool {
    let Ok(home_forms) = folder_forms(home) else {
        return false;
    };
    let Ok(path_forms) = folder_forms(path) else {
        return false;
    };
    path_forms.iter().any(|path| {
        home_forms
            .iter()
            .any(|home| path == home || path.starts_with(&format!("{home}/")))
    })
}

/// Unlink of one directory node, in every spelling. Not a write deny: files inside the directory stay writable.
fn push_unlink_node(
    lines: &mut Vec<String>,
    dir: &Path,
    seen: &mut BTreeSet<String>,
) -> Result<(), String> {
    for form in folder_forms(dir)? {
        if !seen.insert(form.clone()) {
            continue;
        }
        lines.push(format!(
            r#"(deny file-write-unlink (regex #"^{}$"))"#,
            ci_regex(&form)
        ));
    }
    Ok(())
}

/// `start` and each parent, up to home. Home itself is included only when `LOCK_HOME_NODE` is set. A path outside home
/// (an explicit data folder in a temp directory) locks only its own node, never `/tmp` or `/var`.
fn push_ancestor_locks(
    lines: &mut Vec<String>,
    home: &Path,
    start: &Path,
    seen: &mut BTreeSet<String>,
) -> Result<(), String> {
    if !inside_home(home, start) {
        return push_unlink_node(lines, start, seen);
    }
    let mut cur = start.to_path_buf();
    loop {
        let at_home = same_folder(&cur, home);
        if at_home && !LOCK_HOME_NODE {
            break;
        }
        push_unlink_node(lines, &cur, seen)?;
        if at_home {
            break;
        }
        let Some(parent) = cur.parent() else { break };
        if parent.as_os_str().is_empty() || parent == cur {
            break;
        }
        cur = parent.to_path_buf();
    }
    Ok(())
}

/// The directory chain of a home-relative name. A file locks its parents only. A glob locks the prefix before `*`.
fn lock_relative(
    lines: &mut Vec<String>,
    home: &Path,
    relative: &str,
    leaf_is_dir: bool,
    seen: &mut BTreeSet<String>,
) -> Result<(), String> {
    let mut parts: Vec<&str> = relative
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    while parts.last().is_some_and(|part| part.contains('*')) {
        parts.pop();
    }
    if !leaf_is_dir {
        parts.pop();
    }
    if parts.is_empty() {
        if LOCK_HOME_NODE {
            push_unlink_node(lines, home, seen)?;
        }
        return Ok(());
    }
    push_ancestor_locks(lines, home, &home.join(parts.join("/")), seen)
}

/// The agent profile for `home`: git writes denied in `checkouts` (see `profile_scoped`).
#[cfg(test)]
pub fn profile_text(home: &Path) -> Result<String, String> {
    profile_text_for(home, None)
}

/// The agent profile, with no checkout singled out. A temp clone keeps its own `.git`, so `git worktree add` and
/// `git submodule update` still work there. A named checkout is locked by `profile_with_checkouts`.
#[cfg(test)]
pub fn profile_text_for(home: &Path, data_dir: Option<&Path>) -> Result<String, String> {
    profile_with_checkouts(home, data_dir, &[])
}

/// The agent profile. `checkouts` are the trees whose `.git` hooks, config and attributes are write-denied.
pub fn profile_with_checkouts(
    home: &Path,
    data_dir: Option<&Path>,
    checkouts: &[PathBuf],
) -> Result<String, String> {
    profile_scoped(home, data_dir, checkouts, true)
}

/// The profile the app's own git runs under. It has the same denies except `.git`, so `git status` can write the index.
/// A filter git still runs is inside this profile, and cannot reach the secret places or the data folder.
pub fn container_profile(home: &Path, data_dir: Option<&Path>) -> Result<String, String> {
    profile_scoped(home, data_dir, &[], false)
}

fn profile_scoped(
    home: &Path,
    data_dir: Option<&Path>,
    checkouts: &[PathBuf],
    deny_git: bool,
) -> Result<String, String> {
    let list = home_secrets()?;
    let forms = folder_forms(home)?;
    let mut seen = BTreeSet::new();
    let mut lines = vec!["(version 1)".to_string(), "(allow default)".to_string()];
    push_secret_places(&mut lines, home, &forms, list, &mut seen)?;
    push_protected_writes(&mut lines, home, &forms, &mut seen)?;
    push_app_data(&mut lines, home, &forms, &mut seen)?;
    if let Some(data) = data_dir {
        push_explicit_data(&mut lines, data)?;
        push_ancestor_locks(&mut lines, home, data, &mut seen)?;
    }
    push_foreign_real_home(&mut lines, home)?;
    push_tool_places(&mut lines, home);
    push_cron_tables(&mut lines);
    push_docker_sockets(&mut lines, home)?;
    if deny_git {
        push_git_writes(&mut lines, checkouts)?;
    }
    for program in DENIED_PROGRAMS {
        lines.push(format!(
            r#"(deny process-exec (regex #"^{}$"))"#,
            ci_regex(program)
        ));
    }
    lines.push("(deny appleevent-send)".to_string());
    lines.push("(deny job-creation)".to_string());
    lines.push("(deny lsopen)".to_string());
    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// When this profile's home is not the login home, also deny the real `~/.ssh` and the daily data folder. The files are
/// not opened: only the password database's home directory string is used.
fn push_foreign_real_home(lines: &mut Vec<String>, home: &Path) -> Result<(), String> {
    let Some(real) = passwd_home() else {
        return Ok(());
    };
    if same_folder(&real, home) {
        return Ok(());
    }
    let Ok(real_text) = quote_path(&real) else {
        return Ok(());
    };
    push_absolute(lines, &format!("{real_text}/.ssh"), true, SECRET_OPS);
    let data = format!("{real_text}/{APP_DATA_UNDER_HOME}");
    lines.push(format!(
        r#"(deny {WRITE_OPS} (regex #"^{}[^/]*(/|$)"))"#,
        ci_regex(&data)
    ));
    // Renaming a parent of those two (or the real home itself) would move the protected folder out from under the
    // write deny. Unlink of the directory node only, the same lock the profile home already has.
    let mut seen = BTreeSet::new();
    push_ancestor_locks(lines, &real, &real.join(".ssh"), &mut seen)?;
    push_ancestor_locks(lines, &real, &real.join(APP_DATA_UNDER_HOME), &mut seen)?;
    Ok(())
}

/// Keychains are write-only. Everything else in the secret list is read and write. A shell profile may be a glob
/// (`.config/fish/conf.d/**`); that one is denied as a pattern, not as a literal file name.
fn push_secret_places(
    lines: &mut Vec<String>,
    home: &Path,
    forms: &[String],
    list: &HomeSecrets,
    seen: &mut BTreeSet<String>,
) -> Result<(), String> {
    for dir in &list.dirs {
        let ops = if dir == "Library/Keychains" {
            WRITE_OPS
        } else {
            SECRET_OPS
        };
        push_home_entry(lines, forms, dir, true, ops);
        push_real_target(lines, home, dir, true, ops);
        lock_relative(lines, home, dir, true, seen)?;
    }
    for file in &list.files {
        push_home_entry(lines, forms, file, false, SECRET_OPS);
        push_real_target(lines, home, file, false, SECRET_OPS);
        lock_relative(lines, home, file, false, seen)?;
    }
    for file in &list.shell_profiles {
        if file.contains('*') {
            for form in forms {
                lines.push(format!(
                    r#"(deny {SECRET_OPS} (regex #"^{}/{}$"))"#,
                    ci_regex(form),
                    glob_regex(file)
                ));
            }
            lock_relative(lines, home, file, true, seen)?;
        } else {
            push_home_entry(lines, forms, file, false, SECRET_OPS);
            push_real_target(lines, home, file, false, SECRET_OPS);
            lock_relative(lines, home, file, false, seen)?;
        }
    }
    Ok(())
}

/// The shared list's `denyWrite` globs under home. A glob with no `*` is one file: a link's target is denied too, and
/// `~/.gitconfig`'s `include.path` files are denied. Reads stay allowed.
fn push_protected_writes(
    lines: &mut Vec<String>,
    home: &Path,
    forms: &[String],
    seen: &mut BTreeSet<String>,
) -> Result<(), String> {
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
        if relative.contains('*') {
            let concrete = relative
                .split('/')
                .take_while(|part| !part.contains('*'))
                .collect::<Vec<_>>()
                .join("/");
            if !concrete.is_empty() {
                push_real_target(lines, home, &concrete, true, WRITE_OPS);
            }
            lock_relative(lines, home, relative, true, seen)?;
        } else {
            push_real_target(lines, home, relative, false, WRITE_OPS);
            if relative == ".gitconfig" {
                push_gitconfig_includes(lines, home);
            }
            lock_relative(lines, home, relative, false, seen)?;
        }
    }
    Ok(())
}

/// `include.path` and `includeIf.*.path` from a gitconfig, as write denies, following nested includes. The files are
/// read as text; git is not run. Eight levels is the cap, and a file already seen (by its real path) is not read again.
fn push_gitconfig_includes(lines: &mut Vec<String>, home: &Path) {
    let mut seen = BTreeSet::new();
    walk_gitconfig_includes(lines, home, &home.join(".gitconfig"), 0, &mut seen);
}

const GITCONFIG_INCLUDE_DEPTH: usize = 8;

fn walk_gitconfig_includes(
    lines: &mut Vec<String>,
    home: &Path,
    path: &Path,
    depth: usize,
    seen: &mut BTreeSet<PathBuf>,
) {
    if depth >= GITCONFIG_INCLUDE_DEPTH {
        return;
    }
    let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !seen.insert(key) {
        return;
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for include in gitconfig_include_paths(&text) {
        let resolved = resolve_include(home, path, &include);
        deny_file_and_target(lines, &resolved);
        walk_gitconfig_includes(lines, home, &resolved, depth + 1, seen);
    }
}

fn gitconfig_include_paths(text: &str) -> Vec<String> {
    let mut include = false;
    let mut out = Vec::new();
    for raw in text.split(['\n', '\r']) {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(head) = line.strip_prefix('[') {
            let name = head
                .trim_end_matches(']')
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            include = name == "include" || name == "includeif";
            continue;
        }
        if !include {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("path") {
            let value = value.trim().trim_matches('"').trim();
            if !value.is_empty() {
                out.push(value.to_string());
            }
        }
    }
    out
}

fn resolve_include(home: &Path, gitconfig: &Path, value: &str) -> PathBuf {
    let prefix = gitconfig.parent().unwrap_or(home);
    let value = value.replace("%(prefix)", &prefix.to_string_lossy());
    if value == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home.join(rest);
    }
    let path = Path::new(&value);
    if path.is_absolute() {
        return path.to_path_buf();
    }
    prefix.join(path)
}

fn deny_file_and_target(lines: &mut Vec<String>, path: &Path) {
    let Some(text) = path
        .to_str()
        .filter(|t| !t.is_empty() && !t.contains('"') && !t.contains('\\') && !t.contains('\n'))
    else {
        return;
    };
    push_absolute(lines, text, false, WRITE_OPS);
    if let Ok(real) = std::fs::canonicalize(path) {
        if real != path {
            if let Some(text) = real
                .to_str()
                .filter(|t| !t.contains('"') && !t.contains('\\') && !t.contains('\n'))
            {
                push_absolute(lines, text, false, WRITE_OPS);
            }
        }
    }
}

/// The whole app data folder under home, daily and dev copy (`com.ash.monocode-hub` plus anything after it in the same
/// segment). Nothing inside it is carved out: an agent must not plant a gate, a ship file or a project file there.
fn push_app_data(
    lines: &mut Vec<String>,
    home: &Path,
    forms: &[String],
    seen: &mut BTreeSet<String>,
) -> Result<(), String> {
    for form in forms {
        let app = format!("{}/{}", ci_regex(form), ci_regex(APP_DATA_UNDER_HOME));
        lines.push(format!(r#"(deny {WRITE_OPS} (regex #"^{app}[^/]*(/|$)"))"#));
    }
    lock_relative(lines, home, APP_DATA_UNDER_HOME, true, seen)
}

/// The whole of a data folder that is not the one under home (a test's, or a moved one).
fn push_explicit_data(lines: &mut Vec<String>, data: &Path) -> Result<(), String> {
    for form in folder_forms(data)? {
        let base = ci_regex(&form);
        lines.push(format!(r#"(deny {WRITE_OPS} (regex #"^{base}(/|$)"))"#));
    }
    Ok(())
}

/// Folders an agent must not replace, because the app later runs a program from them outside the sandbox: the login
/// PATH's `gh`, `git`, `git-lfs`, `node` and `docker` (the file and, when it is a link, its target), plus the tool
/// directories themselves. `/usr/bin` is not one of those directories.
const TOOL_BINARIES: [&str; 5] = ["gh", "git", "git-lfs", "node", "docker"];
const TOOL_DIRS: [&str; 4] = [
    "/opt/homebrew/bin",
    "/opt/homebrew/Cellar",
    "/usr/local/Cellar",
    "/usr/local/Homebrew",
];

fn push_tool_places(lines: &mut Vec<String>, home: &Path) {
    if let Ok(forms) = folder_forms(home) {
        push_home_entry(lines, &forms, ".local/bin", true, WRITE_OPS);
        push_home_entry(lines, &forms, ".cargo/bin", true, WRITE_OPS);
        push_home_entry(lines, &forms, ".cargo/env", false, WRITE_OPS);
        push_home_entry(
            lines,
            &forms,
            "Applications/MonoCode Hub.app",
            true,
            WRITE_OPS,
        );
    }
    for dir in TOOL_DIRS {
        push_absolute(lines, dir, true, WRITE_OPS);
    }
    for name in TOOL_BINARIES {
        let Some(path) = tool_on_path(name) else {
            continue;
        };
        deny_file_and_target(lines, &path);
    }
}

/// `crontab` is setuid, so a copy of it cannot write the table, but the real one can. Denying the table folders closes
/// that even if the program deny is missed. `/var/at` is named as well as `/private/var/at`: the profile matches the
/// path it is given, and the two spellings are not always the same string.
fn push_cron_tables(lines: &mut Vec<String>) {
    for dir in ["/private/var/at", "/var/at", "/usr/lib/cron"] {
        push_absolute(lines, dir, true, WRITE_OPS);
    }
}

/// The Docker socket is how a sandboxed agent starts a container the app did not ask for. A subpath covers the
/// per-user socket under `~/.docker/run`; the two system sockets are named literally.
fn push_docker_sockets(lines: &mut Vec<String>, home: &Path) -> Result<(), String> {
    let home_text = quote_path(home)?;
    lines.push(format!(
        r#"(deny network-outbound (remote unix-socket (subpath "{home_text}/.docker/run")))"#
    ));
    for sock in ["/var/run/docker.sock", "/private/var/run/docker.sock"] {
        lines.push(format!(
            r#"(deny network-outbound (remote unix-socket (literal "{sock}")))"#
        ));
    }
    Ok(())
}

/// The first `name` on `PATH`. Not run: only `metadata`, so a directory that is not executable is still named.
fn tool_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if std::fs::symlink_metadata(&candidate).is_ok() {
            return Some(candidate);
        }
    }
    None
}

/// Writes and links for each named checkout's repository, not only `<checkout>/.git`. A folder inside a repo locks
/// that repo's `.git`. A linked worktree's `.git` file is read, the git dir it names is locked, and so is the common
/// dir that file's `commondir` points at (where the config, hooks and attributes actually live). A checkout that does
/// not exist yet still locks the lexical `<checkout>/.git`. A temp clone that was not named is not locked.
fn push_git_writes(lines: &mut Vec<String>, checkouts: &[PathBuf]) -> Result<(), String> {
    for checkout in checkouts {
        let root = repo_root(checkout);
        deny_one_git(lines, &root.join(".git"))?;
        if let Some(gitdir) = read_gitdir(&root) {
            deny_one_git(lines, &gitdir)?;
            if let Some(common) = read_commondir(&gitdir) {
                deny_one_git(lines, &common)?;
            }
        }
    }
    Ok(())
}

/// The checkout, or the first parent that has a `.git` file or directory. Missing paths stay as given.
fn repo_root(start: &Path) -> PathBuf {
    let mut cur = start.to_path_buf();
    loop {
        if std::fs::symlink_metadata(cur.join(".git")).is_ok() {
            return cur;
        }
        let Some(parent) = cur.parent() else {
            return start.to_path_buf();
        };
        if parent.as_os_str().is_empty() || parent == cur {
            return start.to_path_buf();
        }
        cur = parent.to_path_buf();
    }
}

fn deny_one_git(lines: &mut Vec<String>, git: &Path) -> Result<(), String> {
    for form in folder_forms(git)? {
        let base = ci_regex(&form);
        lines.push(format!(r#"(deny {WRITE_OPS} (regex #"^{base}$"))"#));
        for suffix in [
            "/hooks",
            "/config",
            "/commondir",
            "/gitdir",
            "/config.worktree",
            "/info/attributes",
        ] {
            let tail = if suffix == "/hooks" { "(/|$)" } else { "$" };
            lines.push(format!(
                r#"(deny {WRITE_OPS} (regex #"^{base}{}{tail}"))"#,
                ci_regex(suffix)
            ));
        }
        let modules = ci_regex("/modules");
        lines.push(format!(
            r#"(deny {WRITE_OPS} (regex #"^{base}{modules}/.*/{}(/|$)"))"#,
            ci_regex("hooks")
        ));
        lines.push(format!(
            r#"(deny {WRITE_OPS} (regex #"^{base}{modules}/.*/{}$"))"#,
            ci_regex("config")
        ));
        let worktrees = ci_regex("/worktrees");
        for name in ["gitdir", "commondir", "config.worktree"] {
            lines.push(format!(
                r#"(deny {WRITE_OPS} (regex #"^{base}{worktrees}/.*/{}$"))"#,
                ci_regex(name)
            ));
        }
    }
    Ok(())
}

/// The git dir a worktree's `.git` file names, when it is a short text file. A directory `.git` has no separate dir.
fn read_gitdir(checkout: &Path) -> Option<PathBuf> {
    let dot = checkout.join(".git");
    let meta = std::fs::symlink_metadata(&dot).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let rest = text.lines().next()?.trim().strip_prefix("gitdir:")?.trim();
    if rest.is_empty() || rest.contains('\0') {
        return None;
    }
    let raw = Path::new(rest);
    let joined;
    let path = if raw.is_absolute() {
        raw
    } else {
        joined = checkout.join(raw);
        &joined
    };
    Some(normalize_lexical(path))
}

/// The common git dir a linked worktree's git dir names in `commondir` (often `../..`). Read as text; git is not run.
fn read_commondir(gitdir: &Path) -> Option<PathBuf> {
    let path = gitdir.join("commondir");
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    let rest = text.lines().next()?.trim();
    if rest.is_empty() || rest.contains('\0') {
        return None;
    }
    let raw = Path::new(rest);
    let joined;
    let path = if raw.is_absolute() {
        raw
    } else {
        joined = gitdir.join(raw);
        &joined
    };
    Some(normalize_lexical(path))
}

/// Collapse `.` and `..` without touching the disk. A `..` above the root is dropped.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
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
/// through a link to a secret, a write to the switch file and to `monocode.db`, and a rename of the data folder. An ordinary
/// write in the same folder must still succeed, so a profile that refuses everything does not pass.
///
/// Off macOS there is no sandbox to prove, so the check fails and nothing starts sandboxed.
#[cfg(not(target_os = "macos"))]
pub fn self_check(_sandbox_exec: &Path) -> Result<(), String> {
    Err("agent sandbox self-check failed: the sandbox is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn self_check(sandbox_exec: &Path) -> Result<(), String> {
    static CHECKED: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    // Only the real launcher's answer is kept for the process. Any other launcher (a test's stand-in) is checked afresh,
    // so one stand-in's refusal can never stand in for the real sandbox.
    if sandbox_exec != Path::new(SANDBOX_EXEC) {
        return run_self_check(sandbox_exec);
    }
    CHECKED.get_or_init(|| run_self_check(sandbox_exec)).clone()
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
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
    let profile = profile_with_checkouts(&home, Some(&data), &[])?;

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
            "a rename of the data folder",
            format!("mv '{d}' '{d}-off'", d = data.display()),
        ),
        (
            "a write of a gate file",
            format!(
                "mkdir -p '{d}/gates' && echo x > '{d}/gates/p.json'",
                d = data.display()
            ),
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
    if !run(format!("echo ok > '{}/note.txt'", home.display())) {
        return Err(
            "agent sandbox self-check failed: the profile refused an ordinary write in the home folder, so no agent starts sandboxed"
                .to_string(),
        );
    }
    Ok(())
}

/// Put `prefix` (`sandbox-exec -p <profile>`) in front of `command`. The program, arguments, working directory and
/// explicit environment are kept, so a later check can still see the real program on the command line. Callers set the
/// process group after this: the group leader has to be `sandbox-exec`, not the program it starts.
pub fn under_wrap(command: Command, prefix: Option<&[OsString]>) -> Command {
    let Some(prefix) = prefix.filter(|prefix| !prefix.is_empty()) else {
        return command;
    };
    let program = command.get_program().to_os_string();
    let args: Vec<OsString> = command.get_args().map(|arg| arg.to_os_string()).collect();
    let dir = command.get_current_dir().map(|dir| dir.to_path_buf());
    let envs: Vec<(OsString, Option<OsString>)> = command
        .get_envs()
        .map(|(key, value)| (key.to_os_string(), value.map(|value| value.to_os_string())))
        .collect();
    let mut wrapped = Command::new(&prefix[0]);
    if prefix.len() > 1 {
        wrapped.args(&prefix[1..]);
    }
    wrapped.arg(program).args(args);
    if let Some(dir) = dir {
        wrapped.current_dir(dir);
    }
    for (key, value) in envs {
        match value {
            Some(value) => {
                wrapped.env(key, value);
            }
            None => {
                wrapped.env_remove(key);
            }
        }
    }
    wrapped
}

/// The program and the leading arguments that start `cli` under the sandbox, after the profile passes its preflight and
/// the self-check.
pub fn sandboxed_launch(
    cli: &OsStr,
    home: &Path,
    data_dir: Option<&Path>,
    checkouts: &[PathBuf],
    sandbox_exec: &Path,
) -> Result<(OsString, Vec<OsString>), String> {
    let profile = profile_with_checkouts(home, data_dir, checkouts)?;
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

/// Ship and Run dev slot are Ash's own actions. They are not wrapped: Ship runs `launchctl`, and both are not an
/// agent's command. Matched on the action id, with the button name as a backstop.
pub fn skips_agent_sandbox(id: &str, name: &str) -> bool {
    let id = id.trim().to_ascii_lowercase();
    let name = name.trim().to_ascii_lowercase();
    matches!(id.as_str(), "ship" | "dev") || matches!(name.as_str(), "ship" | "run dev slot")
}

/// Whether this start skips the sandbox. Only Ash's own tap (`trigger == "app"`) skips Ship and Run dev slot.
/// An agent naming those actions is wrapped.
pub fn skip_action_sandbox(id: &str, name: &str, trigger: &str) -> bool {
    trigger == "app" && skips_agent_sandbox(id, name)
}

/// While the sandbox is on, an agent must not start a stack: Compose runs in the app, not inside the action wrap.
pub fn agent_stack_refused(sandbox_on: bool, trigger: &str, has_stack: bool) -> bool {
    sandbox_on && trigger != "app" && has_stack
}

/// How a project action starts when the sandbox is on: `sandbox-exec -p <profile>` in front of its shell. Off, nothing.
/// `checkouts` scope the `.git` write denies. An empty list denies no `.git` path.
pub fn action_wrap(
    data_dir: Option<&Path>,
    checkouts: &[PathBuf],
) -> Result<Option<Vec<OsString>>, String> {
    if !enabled(data_dir) {
        return Ok(None);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
        "The action did not start: HOME is not set, so the macOS sandbox cannot be built."
            .to_string()
    })?;
    let profile = profile_with_checkouts(&home, data_dir, checkouts)?;
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
    use std::ffi::OsStr;
    #[cfg(target_os = "macos")]
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    #[cfg(target_os = "macos")]
    use std::process::{Command, Stdio};

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
        assert!(
            denies(&profile, "file-link", "/Users/test/.ssh/id_ed25519"),
            "a hard link is denied"
        );
        let scoped = profile_with_checkouts(
            Path::new("/Users/test"),
            None,
            &[PathBuf::from("/Users/test/proj")],
        )
        .unwrap();
        assert!(denies(
            &scoped,
            "file-write*",
            "/Users/test/proj/.git/hooks/pre-commit"
        ));
        assert!(denies(
            &scoped,
            "file-write*",
            "/Users/test/proj/.git/config"
        ));
        assert!(
            denies(&scoped, "file-write*", "/Users/test/proj/.git"),
            "mv .git is a write to .git"
        );
        assert!(denies(
            &scoped,
            "file-write*",
            "/Users/test/proj/.git/info/attributes"
        ));
        assert!(denies(
            &scoped,
            "file-write*",
            "/Users/test/proj/.git/commondir"
        ));
        assert!(denies(
            &scoped,
            "file-write*",
            "/Users/test/proj/.git/modules/x/hooks/pre-push"
        ));
        assert!(
            denies(
                &scoped,
                "file-write*",
                "/Users/test/proj/.git/modules/group/name/hooks/pre-commit"
            ),
            "a nested submodule hook is writable"
        );
        assert!(
            denies(
                &scoped,
                "file-write*",
                "/Users/test/proj/.git/modules/vendor/lib/config"
            ),
            "a submodule whose name contains a slash is writable"
        );
        assert!(
            !denies(&scoped, "file-write*", "/tmp/other/.git/hooks/pre-commit"),
            "a checkout that was not named is denied"
        );
        assert!(
            profile.starts_with("(version 1)\n(allow default)"),
            "a denylist, not a deny-default profile"
        );
    }

    #[test]
    fn the_profile_covers_every_previously_listed_secret_place() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        for dir in PREVIOUSLY_LISTED_DIRS {
            if *dir == "Library/Keychains" {
                assert!(
                    !denies(&profile, "file-read*", &format!("/Users/test/{dir}/inside")),
                    "keychains are read-denied, so security cannot log a CLI in"
                );
                assert!(
                    denies(
                        &profile,
                        "file-write*",
                        &format!("/Users/test/{dir}/inside")
                    ),
                    "keychains can be written"
                );
                continue;
            }
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
        for program in ["/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript"] {
            assert!(
                denies(&profile, "process-exec", program),
                "{program} may run"
            );
        }
        assert!(
            !denies(&profile, "process-exec", "/usr/bin/security"),
            "security is blocked"
        );
        assert!(profile.contains("(deny appleevent-send)"));
        assert!(profile.contains("(deny job-creation)"));
        assert!(profile.contains("(deny lsopen)"));
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
            &[],
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
        // No data folder means the switch file cannot be read. On macOS that is on (fail closed). Off macOS there is
        // no sandbox, so it stays off. A file that is simply missing, inside a folder we could open, is still off,
        // unless the environment already says on.
        if cfg!(target_os = "macos") {
            assert!(
                enabled(None),
                "a missing data folder is unreadable, so the sandbox is on"
            );
        } else {
            assert!(!enabled(None), "off macOS the sandbox is never on");
        }
        let data = temp_home("switch-missing");
        let env_on = std::env::var_os(ENV_SWITCH)
            .and_then(|value| value.into_string().ok())
            .is_some_and(|value| word_on(&value));
        if !env_on {
            assert!(
                !enabled(Some(&data)),
                "a missing switch file in a folder we could open is off"
            );
        }
        let _ = std::fs::remove_dir_all(&data);
        // action_wrap(None) on macOS would try to sandbox the real home. Only the off-macOS path is asserted here.
        if !cfg!(target_os = "macos") {
            assert!(matches!(action_wrap(None, &[]), Ok(None)));
        }
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
        let (program, prefix) = sandboxed_launch(
            OsStr::new("claude"),
            &home,
            None,
            &[],
            Path::new(SANDBOX_EXEC),
        )
        .unwrap();
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
        let profile =
            profile_with_checkouts(&home, Some(&data), std::slice::from_ref(&project)).unwrap();
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
        let profile = profile_with_checkouts(&home, Some(&data), &[]).unwrap();
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
        let profile = profile_with_checkouts(&home, Some(&data), &[]).unwrap();
        assert!(!run_under(
            &profile,
            &home,
            &home,
            &format!("echo off > '{}/settings/{SETTING_FILE}'", data.display())
        ));
        // `security error 0` prints "No error" and exits 1 on this macOS, so the exit code cannot prove it ran.
        // A blocked exec produces no such line.
        let security = Command::new(SANDBOX_EXEC)
            .args(["-p", &profile, "/usr/bin/security", "error", "0"])
            .current_dir(&home)
            .env("HOME", &home)
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&security.stdout).contains("No error"),
            "security did not run, so a CLI cannot log in"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A tracked hook (`core.hooksPath=.husky`, the way Husky ships one) runs inside the `git commit` that the sandboxed
    /// CLI starts. Under the profile it is refused the write to the switch file. The same hook without the sandbox writes
    /// it, so the control shows the test can see a write.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_tracked_hook_under_a_sandboxed_commit_cannot_write_the_switch_file() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("hook-commit");
        let data = home.join(APP_DATA_UNDER_HOME);
        std::fs::create_dir_all(data.join("settings")).unwrap();
        let switch = data.join("settings").join(SETTING_FILE);
        let repo = home.join("repo");
        std::fs::create_dir_all(repo.join(".husky")).unwrap();
        let result = home.join("hook-result");
        let hook = repo.join(".husky").join("pre-commit");
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\nif echo off > '{s}' 2>/dev/null; then echo wrote > '{r}'; else echo refused > '{r}'; fi\nexit 0\n",
                s = switch.display(),
                r = result.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        // An empty global config, so these probes do not open the real ~/.gitconfig.
        let empty = home.join("empty-gitconfig");
        std::fs::write(&empty, "").unwrap();
        let git = |args: &[&str]| {
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(&repo)
                    .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                    .args(args)
                    .env("HOME", &home)
                    .env("GIT_CONFIG_GLOBAL", &empty)
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .status()
                    .unwrap()
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&["config", "core.hooksPath", ".husky"]);
        let commit = ["commit", "-q", "--allow-empty", "-m", "crew"];
        let profile =
            profile_with_checkouts(&home, Some(&data), std::slice::from_ref(&repo)).unwrap();

        // Sandboxed: the commit and its hook run under the profile.
        std::fs::write(&switch, "on\n").unwrap();
        let sandboxed = Command::new(SANDBOX_EXEC)
            .args(["-p", &profile, "git", "-C"])
            .arg(&repo)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(commit)
            .env("HOME", &home)
            .env("GIT_CONFIG_GLOBAL", &empty)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap();
        assert!(sandboxed.success(), "the sandboxed commit still lands");
        assert_eq!(
            std::fs::read_to_string(&result).unwrap().trim(),
            "refused",
            "the hook wrote the switch"
        );
        assert_eq!(std::fs::read_to_string(&switch).unwrap(), "on\n");

        // Control: the same hook without the sandbox writes the switch, so a refusal above is a real refusal.
        git(&["commit", "-q", "--allow-empty", "-m", "control"]);
        assert_eq!(
            std::fs::read_to_string(&result).unwrap().trim(),
            "wrote",
            "the control hook could not write"
        );
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
        let profile = profile_with_checkouts(&home, Some(&data), &[]).unwrap();
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

    /// Review r4 (H1): renaming the data folder, or a parent of it, must be refused. A write anywhere in the data
    /// folder (a gate script, a ship state file) must be refused too. Red until the profile locks those paths.
    #[test]
    fn the_data_folder_cannot_be_renamed_and_nothing_inside_it_can_be_written() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        let data = "/Users/test/Library/Application Support/com.ash.monocode-hub";
        assert!(
            denies(&profile, "file-write-unlink", data),
            "mv of the data folder is allowed"
        );
        assert!(
            denies(
                &profile,
                "file-write-unlink",
                "/Users/test/Library/Application Support"
            ),
            "mv of Application Support is allowed"
        );
        assert!(
            denies(&profile, "file-write-unlink", "/Users/test/Library"),
            "mv of Library is allowed"
        );
        assert!(
            denies(&profile, "file-write*", &format!("{data}/gates/proj.json")),
            "a gate file in the data folder is writable"
        );
        assert!(
            denies(
                &profile,
                "file-write*",
                &format!("{data}/ship/current.json")
            ),
            "ship state in the data folder is writable"
        );
        assert!(
            denies(
                &profile,
                "file-write*",
                "/Users/test/Library/Application Support/com.ash.monocode-hub.dev.slot/project-files.json"
            ),
            "a dev copy's project file is writable"
        );
    }

    /// Review r4 (H1): a write deny on `~/Library/LaunchAgents/foo` does not stop `mv ~/Library` or `mv ~/.config`.
    #[test]
    fn renaming_a_parent_cannot_move_a_protected_path_out_of_the_profile() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        for path in [
            "/Users/test/Library/LaunchAgents",
            "/Users/test/.config",
            "/Users/test/.config/git",
            "/Users/test/.claude",
            "/Users/test/.claude/hooks",
        ] {
            assert!(
                denies(&profile, "file-write-unlink", path),
                "{path} can be renamed aside"
            );
        }
    }

    /// Review r4 (H1, H3): `security` stays runnable so a CLI can log in. Login items and Launch Services opens are
    /// refused by operation, not only by the program's path.
    #[test]
    fn security_stays_allowed_and_job_creation_and_lsopen_are_refused() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        assert!(
            !denies(&profile, "process-exec", "/usr/bin/security"),
            "the security tool is blocked, so a CLI cannot log in"
        );
        assert!(profile.contains("(deny job-creation)"));
        assert!(profile.contains("(deny lsopen)"));
        assert!(profile.contains("(deny appleevent-send)"));
    }

    /// Review r4 (H3): a read deny on the keychains folder breaks `security`. Writes stay denied.
    #[test]
    fn keychains_can_be_read_and_cannot_be_written() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        let path = "/Users/test/Library/Keychains/login.keychain-db";
        assert!(
            !denies(&profile, "file-read*", path),
            "a read of the keychains folder is denied"
        );
        assert!(
            denies(&profile, "file-write*", path),
            "a write into the keychains folder is allowed"
        );
    }

    /// Review r4 (M3): `.git` denies must not apply to every repository on disk, or `git init` in a temp folder fails.
    #[test]
    fn a_profile_with_no_checkout_does_not_deny_every_git_directory() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        assert!(
            !denies(&profile, "file-write*", "/tmp/clone/.git"),
            "a temp clone's .git is denied"
        );
        assert!(
            !denies(&profile, "file-write*", "/tmp/clone/.git/config"),
            "a temp clone's git config is denied"
        );
        assert!(
            !denies(&profile, "file-write*", "/tmp/clone/.git/hooks/pre-commit"),
            "a temp clone's hooks are denied"
        );
    }

    /// Review r4 (LOW): the shell profiles the list missed.
    #[test]
    fn the_extra_shell_profiles_are_denied() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        for path in [
            "/Users/test/.zlogout",
            "/Users/test/.bash_login",
            "/Users/test/.config/fish/conf.d/extra.fish",
        ] {
            assert!(denies(&profile, "file-read*", path), "{path} can be read");
            assert!(
                denies(&profile, "file-write*", path),
                "{path} can be written"
            );
        }
    }

    /// Review r4 (M2): a linked `~/.gitconfig`, and a file it includes, are denied at the real path.
    #[cfg(unix)]
    #[test]
    fn a_linked_gitconfig_and_its_include_cannot_be_written() {
        let home = temp_home("gitconfig-link");
        let dot = home.join("dotfiles");
        std::fs::create_dir_all(&dot).unwrap();
        std::fs::write(
            dot.join("gitconfig"),
            "[include]\n\tpath = ~/dotfiles/extra\n",
        )
        .unwrap();
        std::fs::write(dot.join("extra"), "[user]\n\tname = t\n").unwrap();
        std::os::unix::fs::symlink(dot.join("gitconfig"), home.join(".gitconfig")).unwrap();
        let profile = profile_text(&home).unwrap();
        let real = std::fs::canonicalize(dot.join("gitconfig")).unwrap();
        let extra = std::fs::canonicalize(dot.join("extra")).unwrap();
        assert!(
            denies(&profile, "file-write*", real.to_str().unwrap()),
            "the gitconfig link target is writable"
        );
        assert!(
            denies(&profile, "file-write*", extra.to_str().unwrap()),
            "the included gitconfig is writable"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn ship_and_run_dev_slot_are_not_wrapped_and_setup_is() {
        assert!(skips_agent_sandbox("ship", "Ship"));
        assert!(skips_agent_sandbox("dev", "Run dev slot"));
        assert!(skips_agent_sandbox("other", "Ship"));
        assert!(skips_agent_sandbox("other", "  run dev slot  "));
        assert!(!skips_agent_sandbox("setup", "Setup"));
        assert!(!skips_agent_sandbox("check", "Check"));
    }

    /// H-A: an agent can call `app actions.run` for dev or ship. Only Ash's tap skips the wrap.
    #[test]
    fn an_agent_does_not_skip_the_sandbox_for_dev_or_ship() {
        assert!(
            !skip_action_sandbox("dev", "Run dev slot", "agent"),
            "an agent's dev action must be wrapped"
        );
        assert!(
            !skip_action_sandbox("ship", "Ship", "mono"),
            "an agent's ship action must be wrapped"
        );
        assert!(skip_action_sandbox("dev", "Run dev slot", "app"));
        assert!(skip_action_sandbox("ship", "Ship", "app"));
        assert!(!skip_action_sandbox("setup", "Setup", "app"));
        assert!(!skip_action_sandbox("check", "Check", "agent"));
        assert!(
            agent_stack_refused(true, "agent", true),
            "an agent's stack starts Compose in the app, outside the wrap"
        );
        assert!(!agent_stack_refused(true, "app", true));
        assert!(!agent_stack_refused(false, "agent", true));
        assert!(!agent_stack_refused(true, "agent", false));
    }

    /// Nested `include.path` / `includeIf.path`, with `%(prefix)` meaning the directory of the file that included it.
    /// A cycle stops, and the ninth nested file is not read.
    #[test]
    fn a_nested_gitconfig_include_follows_prefix_and_stops_at_the_cap() {
        let home = temp_home("gitconfig-nest");
        let nested = home.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            home.join(".gitconfig"),
            "[include]\n\tpath = %(prefix)/.gitconfig\n\tpath = %(prefix)/nested/1\n[includeIf \"gitdir:/nowhere/\"]\n\tpath = %(prefix)/nested/from-if\n",
        )
        .unwrap();
        for n in 1..=9 {
            let next = n + 1;
            std::fs::write(
                nested.join(n.to_string()),
                format!("[include]\n\tpath = %(prefix)/{next}\n"),
            )
            .unwrap();
        }
        std::fs::write(nested.join("from-if"), "# leaf\n").unwrap();
        let profile = profile_text(&home).unwrap();
        let home_s = home.to_str().unwrap();
        assert!(denies(
            &profile,
            "file-write*",
            &format!("{home_s}/nested/1")
        ));
        assert!(denies(
            &profile,
            "file-write*",
            &format!("{home_s}/nested/from-if")
        ));
        assert!(
            denies(&profile, "file-write*", &format!("{home_s}/nested/8")),
            "%(prefix) was not followed down to the last file the cap still reads"
        );
        assert!(
            !denies(&profile, "file-write*", &format!("{home_s}/nested/9")),
            "the include walk read past its cap"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Tool directories and the installed app are write-denied. `/usr/bin` is not. crontab, at and hdiutil cannot be
    /// executed, and the cron tables and Docker sockets are named.
    #[test]
    fn tool_dirs_cron_docker_and_the_installed_app_are_denied() {
        let profile = profile_text(Path::new("/Users/test")).unwrap();
        for path in [
            "/opt/homebrew/bin/brew",
            "/opt/homebrew/Cellar/git/1",
            "/usr/local/Cellar/x",
            "/usr/local/Homebrew/bin/brew",
            "/Users/test/.local/bin/gh",
            "/Users/test/.cargo/bin/cargo",
            "/Users/test/.cargo/env",
            "/Users/test/Applications/MonoCode Hub.app/Contents/MacOS/monocode",
            "/private/var/at/tabs/test",
            "/usr/lib/cron/tabs/test",
        ] {
            assert!(denies(&profile, "file-write*", path), "{path}");
        }
        assert!(
            !denies(&profile, "file-write*", "/usr/bin/true"),
            "/usr/bin itself was write-denied"
        );
        assert!(denies(&profile, "process-exec", "/usr/bin/crontab"));
        assert!(denies(&profile, "process-exec", "/usr/bin/at"));
        assert!(denies(&profile, "process-exec", "/usr/sbin/hdiutil"));
        assert!(profile.contains(
            "(deny network-outbound (remote unix-socket (subpath \"/Users/test/.docker/run\")))"
        ));
        assert!(profile.contains(
            "(deny network-outbound (remote unix-socket (literal \"/var/run/docker.sock\")))"
        ));
        assert!(profile.contains(
            "(deny network-outbound (remote unix-socket (literal \"/private/var/run/docker.sock\")))"
        ));
    }

    #[test]
    fn an_explicit_checkout_is_denied_even_under_tmp_and_the_container_denies_no_git_dir() {
        let named =
            profile_with_checkouts(Path::new("/Users/test"), None, &[PathBuf::from("/tmp/job")])
                .unwrap();
        assert!(denies(
            &named,
            "file-write*",
            "/tmp/job/.git/hooks/pre-commit"
        ));
        let container = container_profile(Path::new("/Users/test"), None).unwrap();
        assert!(
            !denies(&container, "file-write*", "/tmp/job/.git/index"),
            "the container profile denies the index, so git status cannot run"
        );
        assert!(
            !denies(&container, "file-write*", "/tmp/job/.git/hooks/pre-commit"),
            "the container profile denies .git"
        );
        assert!(denies(
            &container,
            "file-read*",
            "/Users/test/.ssh/id_ed25519"
        ));
        assert!(container.contains("(deny job-creation)"));
        assert!(container.contains("(deny lsopen)"));
    }

    /// Review r4 (LOW): a profile built for a temporary home still names the login home's `.ssh` and the daily data
    /// folder. The files are not opened.
    #[cfg(unix)]
    #[test]
    fn a_profile_for_a_temporary_home_still_denies_the_login_ssh_folder() {
        let Some(real) = passwd_home() else {
            return;
        };
        let home = temp_home("foreign-home");
        if same_folder(&real, &home) {
            let _ = std::fs::remove_dir_all(&home);
            return;
        }
        let profile = profile_text(&home).unwrap();
        let ssh = real.join(".ssh").join("id_ed25519");
        assert!(
            denies(&profile, "file-read*", ssh.to_str().unwrap()),
            "the login .ssh folder is readable from a temporary home"
        );
        let db = real.join(APP_DATA_UNDER_HOME).join("monocode.db");
        assert!(
            denies(&profile, "file-write*", db.to_str().unwrap()),
            "the daily data folder is writable from a temporary home"
        );
        assert!(
            denies(&profile, "file-write-unlink", real.to_str().unwrap()),
            "the login home directory itself can be renamed"
        );
        let library = real.join("Library");
        assert!(
            denies(&profile, "file-write-unlink", library.to_str().unwrap()),
            "a parent of the daily data folder can be renamed"
        );
        let loose = real.join("not-a-protected-file");
        assert!(
            !denies(&profile, "file-write*", loose.to_str().unwrap()),
            "files in the login home were write-denied, not only the directory node"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn removing_a_file_in_home_still_works_when_the_home_node_is_locked() {
        let home = temp_home("rm-home");
        std::fs::write(home.join("note.txt"), "x").unwrap();
        let data = home.join(APP_DATA_UNDER_HOME);
        std::fs::create_dir_all(&data).unwrap();
        let profile = profile_with_checkouts(&home, Some(&data), &[]).unwrap();
        assert!(
            run_under(&profile, &home, &home, "rm note.txt"),
            "unlink of the home folder also blocked rm of a file in it, so home itself must not be locked"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// H-F: crontab, at and hdiutil are refused by the sandbox, not merely missing. The trace line is only on this
    /// probe's copy of the profile, so a denial is on stderr. Nothing is installed and no image is attached.
    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_crontab_at_and_hdiutil_are_denied() {
        let home = temp_home("cron-probe");
        let profile = profile_text(&home).unwrap();
        let traced = profile.replacen("(version 1)\n", "(version 1)\n(debug deny)\n", 1);
        let dmg = home.join("no-such-image.dmg");
        let mount = home.join("mount");
        std::fs::create_dir_all(&mount).unwrap();
        let dmg_s = dmg.to_string_lossy().into_owned();
        let mount_s = mount.to_string_lossy().into_owned();
        let probes: [(&str, Vec<&str>); 3] = [
            ("/usr/bin/crontab", vec!["-l"]),
            ("/usr/bin/at", vec!["-l"]),
            (
                "/usr/sbin/hdiutil",
                vec!["attach", &dmg_s, "-mountpoint", &mount_s],
            ),
        ];
        for (program, args) in probes {
            let output = Command::new(SANDBOX_EXEC)
                .arg("-p")
                .arg(&traced)
                .arg(program)
                .args(&args)
                .current_dir(&home)
                .env("HOME", &home)
                .stdin(Stdio::null())
                .output()
                .unwrap();
            let err = String::from_utf8_lossy(&output.stderr);
            let text = format!("{err}\n{}", String::from_utf8_lossy(&output.stdout));
            let lower = text.to_ascii_lowercase();
            assert!(
                !output.status.success(),
                "{program} ran under the sandbox: {text}"
            );
            assert!(
                lower.contains("sandbox") || lower.contains("deny"),
                "{program} failed without a sandbox denial on stderr: {text}"
            );
        }
        assert!(
            mount.read_dir().unwrap().next().is_none(),
            "hdiutil attached an image onto the probe mount"
        );
        assert!(
            run_under(&profile, &home, &home, "echo ok > allowed.txt"),
            "a write in the temporary home was refused"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("allowed.txt")).unwrap(),
            "ok\n"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// macOS normally refuses a sandbox inside a sandbox. Codex's own sandbox is why those chats skip the outer wrap.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_sandbox_inside_the_profile_is_refused() {
        let home = temp_home("nest");
        let profile = profile_text(&home).unwrap();
        let inner = "(version 1)\n(allow default)\n";
        let script = format!("{SANDBOX_EXEC} -p '{inner}' /usr/bin/true");
        assert!(
            !run_under(&profile, &home, &home, &script),
            "macOS allowed a sandbox inside the sandbox, so a Codex chat must keep the outer wrap"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A copy of launchctl is not named by the program list. `job-creation` is what stops it. The label is removed again
    /// even if the deny fails, so a probe cannot leave a job behind.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_copied_launchctl_cannot_create_a_job() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("job");
        let copy = home.join("launchctl-copy");
        std::fs::copy("/bin/launchctl", &copy).unwrap();
        std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o755)).unwrap();
        let plist = home.join("probe.plist");
        let label = format!("com.monocode.wp178.probe.{}", std::process::id());
        std::fs::write(
            &plist,
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{label}</string>
<key>ProgramArguments</key><array><string>/usr/bin/true</string></array>
<key>RunAtLoad</key><false/>
</dict></plist>
"#
            ),
        )
        .unwrap();
        let uid = unsafe { libc::getuid() };
        let domain = format!("gui/{uid}");
        struct Remove(String);
        impl Drop for Remove {
            fn drop(&mut self) {
                let _ = Command::new("/bin/launchctl")
                    .args(["bootout", &self.0])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        let _guard = Remove(format!("{domain}/{label}"));
        let profile = profile_text(&home).unwrap();
        let submitted = run_under(
            &profile,
            &home,
            &home,
            &format!(
                "'{}' bootstrap '{domain}' '{}'",
                copy.display(),
                plist.display()
            ),
        );
        let _ = std::fs::remove_dir_all(&home);
        assert!(!submitted, "a launchd job was created under the profile");
    }

    /// A read of a throwaway keychain works under the profile (keychains are write-only). An extra read deny blocks it.
    /// The login keychain is never opened. The search list is compared by path only, and the throwaway keychain is
    /// deleted both with the temporary home and without, so it cannot stay on the real search list.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_throwaway_keychain_stays_readable_until_reads_are_denied() {
        fn listed() -> Vec<String> {
            let text = Command::new("/usr/bin/security")
                .arg("list-keychains")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
                .unwrap_or_default();
            text.lines()
                .map(|line| line.trim().trim_matches('"').to_string())
                .filter(|line| !line.is_empty())
                .collect()
        }
        let before = listed();
        let home = temp_home("keychain");
        let file = home
            .join("Library")
            .join("Keychains")
            .join("probe.keychain-db");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let path = file.to_string_lossy().into_owned();
        struct Cleanup {
            path: String,
            home: PathBuf,
            before: Vec<String>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for with_home in [true, false] {
                    let mut cmd = Command::new("/usr/bin/security");
                    cmd.args(["delete-keychain", &self.path]);
                    if with_home {
                        cmd.env("HOME", &self.home);
                    }
                    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
                }
                let text = Command::new("/usr/bin/security")
                    .arg("list-keychains")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .output()
                    .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
                    .unwrap_or_default();
                for extra in text.lines() {
                    let extra = extra.trim().trim_matches('"');
                    if extra.is_empty() || self.before.iter().any(|one| one == extra) {
                        continue;
                    }
                    if extra.starts_with(self.home.to_str().unwrap_or("")) {
                        let _ = Command::new("/usr/bin/security")
                            .args(["delete-keychain", extra])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                    }
                }
                let _ = std::fs::remove_dir_all(&self.home);
            }
        }
        let cleanup = Cleanup {
            path: path.clone(),
            home: home.clone(),
            before: before.clone(),
        };
        let created = Command::new("/usr/bin/security")
            .args(["create-keychain", "-p", "probe-password", &path])
            .env("HOME", &home)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        assert!(created, "could not create a throwaway keychain");
        let _ = Command::new("/usr/bin/security")
            .args(["unlock-keychain", "-p", "probe-password", &path])
            .env("HOME", &home)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let added = Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-a",
                "probe",
                "-s",
                "wp178-probe",
                "-w",
                "probe-secret",
                &path,
            ])
            .env("HOME", &home)
            .output()
            .unwrap();
        assert!(
            added.status.success(),
            "could not store an item in the throwaway keychain: {}",
            String::from_utf8_lossy(&added.stderr)
        );
        let find = format!(
            "/usr/bin/security find-generic-password -a probe -s wp178-probe '{path}' >/dev/null"
        );
        let profile = profile_text(&home).unwrap();
        assert!(
            run_under(&profile, &home, &home, &find),
            "a write-only keychain deny blocked a read, so the probe has to be re-checked"
        );
        let denied = format!(
            "{profile}(deny file-read* (regex #\"^{}$\"))\n",
            super::ci_regex(&path)
        );
        assert!(
            !run_under(&denied, &home, &home, &find),
            "a read deny on the throwaway keychain did not block find-generic-password"
        );
        drop(cleanup);
        let after = listed();
        let same = before.len() == after.len()
            && before
                .iter()
                .all(|one| after.iter().any(|other| other == one));
        assert!(same, "the throwaway keychain stayed on the search list");
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
        let profile =
            profile_with_checkouts(Path::new(HOME), None, &[PathBuf::from("/Users/test/proj")])
                .unwrap();
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
        let profile =
            profile_with_checkouts(Path::new(HOME), None, &[PathBuf::from("/Users/test/proj")])
                .unwrap();
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

/// Review r4 repro tests for PR #208 (WP-178). Each states a property the profile should hold and is red at 5eedc0d75.
/// The evaluator is the r3 one: `regex`, `literal` and `subpath` filters, any `file-write…` operation.
#[cfg(all(test, unix))]
mod review_r4_repro {
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

    fn denies_write(profile: &str, path: &str) -> bool {
        profile.lines().any(|line| {
            let line = line.trim();
            line.starts_with("(deny ") && line.contains("file-write") && filter_matches(line, path)
        })
    }

    const HOME: &str = "/Users/test";

    fn scratch(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("sbx-r4-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = crate::git_cmd::git()
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    /// HIGH: an agent working in a linked worktree (how Hivra runs workers) is given the worktree as its checkout, and
    /// `push_git_writes` locks `<main>/.git/worktrees/<name>` only. Git reads a linked worktree's config, hooks and
    /// `info/attributes` from the COMMON dir, `<main>/.git`, which no rule names. The agent writes a hook there (Ash's
    /// Git panel commit runs it outside the sandbox) or a `filter.x.clean` in `<main>/.git/config` plus
    /// `info/attributes` (the Git panel's automatic `git diff --numstat` runs it outside the sandbox; see the fs repro).
    #[test]
    fn an_agent_in_a_linked_worktree_cannot_write_the_main_repositorys_config_hooks_or_attributes()
    {
        let root = scratch("linked");
        let main = root.join("main");
        let wt = root.join("wt");
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q"]);
        std::fs::write(main.join("a.txt"), "a\n").unwrap();
        git(&main, &["add", "a.txt"]);
        git(&main, &["commit", "-q", "-m", "a"]);
        git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        let profile =
            profile_with_checkouts(Path::new(HOME), None, std::slice::from_ref(&wt)).unwrap();
        let common = main.join(".git");
        let _ = std::fs::remove_dir_all(&root);
        for name in ["config", "hooks/pre-commit", "info/attributes"] {
            let path = common.join(name).to_string_lossy().to_string();
            assert!(
                denies_write(&profile, &path),
                "{path} is writable by an agent in the linked worktree, and git reads it for that worktree"
            );
        }
    }

    /// HIGH: a chat whose folder is inside a repository (a subproject of a monorepo) names that folder as its checkout.
    /// `<folder>/.git` does not exist, so the rules lock a path that is not there and the repository's real `.git` is
    /// open.
    #[test]
    fn an_agent_whose_folder_is_inside_a_repository_cannot_write_that_repositorys_hooks_or_config()
    {
        let root = scratch("subdir");
        let sub = root.join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        git(&root, &["init", "-q"]);
        let profile =
            profile_with_checkouts(Path::new(HOME), None, std::slice::from_ref(&sub)).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        for name in ["config", "hooks/pre-commit", "info/attributes"] {
            let path = root.join(".git").join(name).to_string_lossy().to_string();
            assert!(
                denies_write(&profile, &path),
                "{path} is writable by an agent working in {}",
                sub.display()
            );
        }
    }

    /// HIGH (needs a macOS probe): `crontab` is setuid and is not a denied program; under `(allow default)` the
    /// sandboxed crontab writes the user's cron table, and cron runs the job later outside the sandbox (the same escape
    /// as a launchd job, without launchctl). A copy of crontab loses setuid, so denying the table's folder is enough.
    #[test]
    fn the_cron_tables_cannot_be_written() {
        let profile = profile_text(Path::new(HOME)).unwrap();
        for path in ["/private/var/at/tabs/test", "/usr/lib/cron/tabs/test"] {
            assert!(
                denies_write(&profile, path),
                "{path} is writable, so a sandboxed crontab installs a job cron runs outside the sandbox"
            );
        }
    }

    /// HIGH: the daily app is `~/Applications/MonoCode Hub.app`, owned by the person, and no rule names it. A sandboxed
    /// agent builds its own bundle (this repo builds one) and renames it into place, or edits the bundle in place; at the
    /// next start the daily app is the agent's code, outside every sandbox. macOS App Management does not stop it: the
    /// responsible process is MonoCode Hub itself. Ship is the only supported way a build reaches that folder.
    #[test]
    fn the_installed_daily_app_cannot_be_written_or_moved() {
        let profile = profile_text(Path::new(HOME)).unwrap();
        for path in [
            "/Users/test/Applications/MonoCode Hub.app",
            "/Users/test/Applications/MonoCode Hub.app/Contents/MacOS/monocode",
            "/Users/test/Applications/MonoCode Hub.app/Contents/Info.plist",
        ] {
            assert!(
                denies_write(&profile, path),
                "{path} is writable, so the next start of the daily app runs what the agent put there"
            );
        }
    }

    /// MED (functional, r3 M3 still partly open): the "unscoped" redirect rules match every repository on disk,
    /// including a temporary one. `git worktree add` writes `.git/worktrees/<n>/commondir` and `git submodule update`
    /// writes `.git/modules/<name>/config`, so both fail in any repo an agent clones under `$TMPDIR` (and this repo's
    /// own tests that add worktrees fail under the wrapped Check action).
    #[test]
    fn git_worktree_add_and_submodules_still_work_in_a_temporary_clone() {
        let profile = profile_text(Path::new(HOME)).unwrap();
        for path in [
            "/private/var/folders/ab/xyz/T/clone/.git/worktrees/wt/commondir",
            "/private/var/folders/ab/xyz/T/clone/.git/modules/vendor/lib/config",
        ] {
            assert!(
                !denies_write(&profile, path),
                "{path} is denied, so git worktree add / git submodule update fail in a temporary clone"
            );
        }
    }
}

/// Review r5 repro tests for PR #208 (WP-178). Each is red at a5bc60a97. The evaluator is the r4 one.
///
/// The sandbox checks a rename against the path of the node that moves (the r4 data-folder lock and its macOS
/// self-check rely on that), not against the paths of what is inside it. `deny_one_git` names `<git>/hooks`,
/// `<git>/config` and so on by path, and nothing locks the checkout folder above `.git` or the folders inside `.git`
/// that hold a denied file. So an agent moves the subtree, writes the file under its new name, and moves it back.
#[cfg(all(test, unix))]
mod review_r5_repro {
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

    /// A deny that covers moving `path` away: `file-write*` or `file-write-unlink` on that exact node.
    fn denies_moving(profile: &str, path: &str) -> bool {
        profile.lines().any(|line| {
            let line = line.trim();
            line.starts_with("(deny ")
                && (line.contains("file-write*") || line.contains("file-write-unlink"))
                && filter_matches(line, path)
        })
    }

    fn scratch(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("sbx-r5-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = crate::git_cmd::git()
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    /// HIGH (H-C still open): `mv ~/Projects/proj ~/Projects/p2; echo … > ~/Projects/p2/.git/hooks/pre-commit;
    /// mv ~/Projects/p2 ~/Projects/proj`. No rule matches `~/Projects/p2/.git/hooks/…`, and the two renames move
    /// nodes no rule names. Ash's next Commit in the Git panel runs that hook through `git_with_hooks`, outside the
    /// sandbox. For a linked worktree the same goes for the main checkout that holds the common dir.
    #[test]
    fn an_agent_cannot_move_its_checkout_or_a_parent_to_reach_the_hooks() {
        let home = scratch("home");
        let proj = home.join("Projects").join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        git(&proj, &["init", "-q"]);
        let profile = profile_with_checkouts(&home, None, std::slice::from_ref(&proj)).unwrap();
        let _ = std::fs::remove_dir_all(&home);
        for node in [proj.clone(), home.join("Projects")] {
            let path = node.to_string_lossy().to_string();
            assert!(
                denies_moving(&profile, &path),
                "{path} can be renamed by the agent; its .git/hooks and .git/config are then writable under the new name"
            );
        }
    }

    /// HIGH (H-C still open): the folders inside `.git` that hold a denied file can be moved too.
    /// `mv .git/worktrees .git/w; echo /tmp/evil > .git/w/<wt>/commondir; mv .git/w .git/worktrees` points a linked
    /// worktree at a git dir whose config and hooks the agent wrote. `.git/modules` (a submodule's hooks) and
    /// `.git/info` (`attributes`) work the same way.
    #[test]
    fn an_agent_cannot_move_the_folders_inside_git_that_hold_a_denied_file() {
        let root = scratch("inner");
        let main = root.join("main");
        let wt = root.join("wt");
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q"]);
        std::fs::write(main.join("a.txt"), "a\n").unwrap();
        git(&main, &["add", "a.txt"]);
        git(&main, &["commit", "-q", "-m", "a"]);
        git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        let profile =
            profile_with_checkouts(Path::new("/Users/test"), None, std::slice::from_ref(&wt))
                .unwrap();
        let common = main.join(".git");
        let _ = std::fs::remove_dir_all(&root);
        for name in ["worktrees", "worktrees/wt", "modules", "info"] {
            let path = common.join(name).to_string_lossy().to_string();
            assert!(
                denies_moving(&profile, &path),
                "{path} can be renamed by the agent, and a denied file inside it is then writable under the new name"
            );
        }
    }

    /// HIGH (question c, H-C still open): the harness names only the chat's own folder. Every other project the app
    /// knows keeps an open `.git`: an agent in project A writes project B's `.git/hooks/pre-commit` (or `core.hooksPath`
    /// in B's `.git/config`), and Ash's next Commit, Push or Pull in B's Git panel runs it outside the sandbox. The
    /// round-4 fix asked for each known project checkout's repository to be resolved and locked. The seam does not
    /// exist yet, so this reads the spawn: it must pass more than the chat's own folder.
    #[test]
    fn a_sandboxed_spawn_locks_every_known_projects_git_not_only_the_chats_own() {
        let source = include_str!("harness.rs");
        let call = source
            .find("crate::agent_sandbox::sandboxed_launch(")
            .expect("harness_spawn calls sandboxed_launch");
        let args = &source[call..call + 600];
        assert!(
            !args.contains("std::slice::from_ref(&workdir)"),
            "harness_spawn names only the chat's folder, so every other project's .git hooks and config stay writable"
        );
    }

    /// Probe on the Mac; HIGH if red (H-F partly open). `hdiutil` is refused by path only. `DENIED_PROGRAMS` says a
    /// copy under another name is covered by `job-creation` and `lsopen`, which is true for launchctl and open but not
    /// for hdiutil: a copy keeps Apple's signature, and the attach is done by the disk image service, not by the
    /// sandboxed process, so the data folder's write deny is never asked. An image mounted over `<data>/settings`
    /// makes the next spawn read `off` from the switch file (or one over `~/Library/LaunchAgents` adds a login job).
    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_a_copied_hdiutil_cannot_mount_over_the_data_folder() {
        let root = scratch("hdi");
        let home = root.join("home");
        let data = root.join("data");
        let settings = data.join("settings");
        let src = root.join("src");
        for dir in [&home, &settings, &src] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(settings.join(SETTING_FILE), "on\n").unwrap();
        std::fs::write(src.join(SETTING_FILE), "off\n").unwrap();
        let image = root.join("img.dmg");
        // Made outside the sandbox to keep the probe short; the agent can make it inside with the same copy.
        let made = std::process::Command::new("/usr/sbin/hdiutil")
            .args(["create", "-quiet", "-fs", "HFS+", "-srcfolder"])
            .arg(&src)
            .arg(&image)
            .status()
            .unwrap();
        assert!(made.success(), "hdiutil create");
        let copy = home.join("h");
        std::fs::copy("/usr/sbin/hdiutil", &copy).unwrap();
        let profile = profile_text_for(&home, Some(&data)).unwrap();
        let _ = std::process::Command::new(SANDBOX_EXEC)
            .args(["-p", &profile])
            .arg(&copy)
            .args(["attach", "-quiet", "-nobrowse", "-mountpoint"])
            .arg(&settings)
            .arg(&image)
            .env("HOME", &home)
            .status()
            .unwrap();
        let seen = std::fs::read_to_string(settings.join(SETTING_FILE)).unwrap_or_default();
        let _ = std::process::Command::new("/usr/sbin/hdiutil")
            .args(["detach", "-quiet", "-force"])
            .arg(&settings)
            .status();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(
            seen.trim(),
            "on",
            "a copied hdiutil mounted an image over the data folder's settings, so the switch reads off"
        );
    }

    /// macOS probe of the first test: the move, the write and the move back, under the real profile.
    #[cfg(target_os = "macos")]
    #[test]
    fn under_the_real_profile_moving_the_checkout_does_not_open_its_hooks() {
        let home = scratch("mvhome");
        let proj = home.join("Projects").join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        git(&proj, &["init", "-q"]);
        let profile = profile_with_checkouts(&home, None, std::slice::from_ref(&proj)).unwrap();
        let script = "cd \"$HOME/Projects\" && mv proj p2 && mkdir -p p2/.git/hooks && \
                      printf '#!/bin/sh\\ntouch /tmp/ran\\n' > p2/.git/hooks/pre-commit && mv p2 proj";
        let _ = std::process::Command::new(SANDBOX_EXEC)
            .args(["-p", &profile, "/bin/sh", "-c", script])
            .env("HOME", &home)
            .status()
            .unwrap();
        let planted = proj.join(".git").join("hooks").join("pre-commit").exists()
            || home
                .join("Projects")
                .join("p2")
                .join(".git")
                .join("hooks")
                .join("pre-commit")
                .exists();
        let _ = std::fs::remove_dir_all(&home);
        assert!(
            !planted,
            "a hook was written into the named checkout by moving it, writing, and moving it back"
        );
    }
}
