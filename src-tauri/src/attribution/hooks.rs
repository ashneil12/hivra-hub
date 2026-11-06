// SPDX-License-Identifier: Apache-2.0
// Hivra WP-86. One hooks folder per repository, kept in this copy's data
// folder. A dev copy has its own data folder, so it never writes the daily
// app's hooks.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};

const SCRIPT: &str = include_str!("hook.sh");
const REFUSAL: &str = "The hooks folder isn't inside this copy's data.";
const GIT_REFUSAL: &str = "git didn't answer";
/// The line in hook.sh where the repository's own prepare-commit-msg path is
/// baked in. The frontend mirror replaces the same line.
const REAL_HOOK_LINE: &str = "real_hook=''";
/// The line in hook.sh that says what makes the repository's own hook runnable.
/// Unix uses the executable bit; Windows has none, so an existing file counts,
/// as it does for git. The frontend mirror replaces the same line.
const HOOK_TEST_LINE: &str = "hook_test='-x'";

const PREPARE: &str = "prepare-commit-msg";

/// These three must never be files in the crew folder.
/// push-to-checkout: its presence makes receive-pack hand over the worktree
/// update, so a forwarder that exits 0 moves the ref and leaves the files stale
/// when receive.denyCurrentBranch is updateInstead.
/// proc-receive: git runs it only when that feature is configured, and it must
/// speak the pkt-line protocol. Exiting 0 does not.
/// fsmonitor-watchman: git never runs that name from the hooks directory.
const NEVER_FORWARD: &[&str] = &["fsmonitor-watchman", "proc-receive", "push-to-checkout"];

/// What `git config` reads to find the repository's own hooks. These are the
/// only variables handed to the lookup, so the crew's GIT_CONFIG_* entries
/// (which point at this folder) never hide the real value.
const CONFIG_ENV: &[&str] = &[
    "HOME",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
];

const GIT_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) fn hook_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    if !matches!(chars.next(), Some(c) if c.is_ascii_lowercase()) {
        return false;
    }
    (2..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn contained(root: &Path, child: &Path) -> bool {
    child.starts_with(root) && child != root
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn ensure_child(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel == "." || rel == ".." {
        return Err(REFUSAL.into());
    }
    let next = root.join(rel);
    if !contained(root, &next) {
        return Err(REFUSAL.into());
    }
    match std::fs::symlink_metadata(&next) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(REFUSAL.into()),
        Ok(meta) if !meta.is_dir() => return Err(REFUSAL.into()),
        Ok(_) => {}
        Err(_) => match std::fs::create_dir(&next) {
            Ok(()) => {}
            // The other crew made the folder between the check and the create.
            Err(_) => {
                let meta = std::fs::symlink_metadata(&next).map_err(|_| REFUSAL.to_string())?;
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err(REFUSAL.into());
                }
            }
        },
    }
    let canon = crate::fs::canonical(&next).map_err(|_| REFUSAL.to_string())?;
    if !contained(root, &canon) {
        return Err(REFUSAL.into());
    }
    Ok(canon)
}

static HOOK_TMP: AtomicU64 = AtomicU64::new(0);

/// The temp names `hook_temp` makes. A hook name can never look like one: it
/// starts with a lowercase letter and holds no dot.
const TEMP_PREFIX: &str = ".prepare-commit-msg.";
const TEMP_SUFFIX: &str = ".tmp";

/// How long a temp file has to sit untouched before it counts as a crashed
/// crew's leftover. Two crews can install into one folder at the same time, so
/// a fresh temp file belongs to whoever is writing it right now.
pub(crate) const TEMP_GRACE: Duration = Duration::from_secs(60);

/// A fresh path for every install. Two crews in one process must not share a file.
pub(crate) fn hook_temp(dir: &Path) -> PathBuf {
    let n = HOOK_TMP.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(
        "{TEMP_PREFIX}{}.{n}{TEMP_SUFFIX}",
        std::process::id()
    ))
}

/// True for the names `hook_temp` makes: `.prepare-commit-msg.<pid>.<n>.tmp`.
/// `hook_name_ok` never accepts a name that starts with a dot, so a file with
/// one of these names is only ever a temp file.
pub(crate) fn is_hook_temp(name: &str) -> bool {
    name.strip_prefix(TEMP_PREFIX)
        .and_then(|rest| rest.strip_suffix(TEMP_SUFFIX))
        .and_then(|middle| middle.split_once('.'))
        .is_some_and(|(pid, n)| {
            !pid.is_empty()
                && !n.is_empty()
                && pid.bytes().all(|byte| byte.is_ascii_digit())
                && n.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// Old enough that no crew can still be writing it. A time that can't be read,
/// or sits in the future, is treated as fresh: leaving a stray temp file is
/// harmless, removing a live one breaks its crew's install.
fn temp_is_stale(meta: &std::fs::Metadata) -> bool {
    meta.modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > TEMP_GRACE)
}

fn script_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    Some(text.replace("\r\n", "\n"))
}

/// Publish the hook. A lost rename is not a failure when the installed file is
/// already this script: the other crew got there first. Only our temp file is removed.
fn publish_hook(root: &Path, dir: &Path, dest: &Path, script: &str) -> Result<(), String> {
    publish_hook_with(root, dir, dest, script, hook_temp)
}

/// `next_temp` is a parameter so a test can make one attempt's write fail.
pub(crate) fn publish_hook_with(
    root: &Path,
    dir: &Path,
    dest: &Path,
    script: &str,
    mut next_temp: impl FnMut(&Path) -> PathBuf,
) -> Result<(), String> {
    for attempt in 0..8 {
        let tmp = next_temp(dir);
        if !contained(root, &tmp) {
            return Err(REFUSAL.into());
        }
        if std::fs::symlink_metadata(&tmp).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(REFUSAL.into());
        }
        if std::fs::write(&tmp, script.as_bytes()).is_err() {
            // Not final. Windows can refuse the write while another crew holds
            // or is deleting the file, so the next attempt writes a new temp
            // name instead of failing the whole install.
            let _ = std::fs::remove_file(&tmp);
            if attempt + 1 < 8 {
                std::thread::sleep(Duration::from_millis(2));
            }
            continue;
        }
        if std::fs::rename(&tmp, dest).is_ok() {
            return Ok(());
        }
        let _ = std::fs::remove_file(&tmp);
        if script_text(dest).as_deref() == Some(script) {
            return Ok(());
        }
        if attempt + 1 < 8 {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    if script_text(dest).as_deref() == Some(script) {
        Ok(())
    } else {
        Err(REFUSAL.into())
    }
}

fn install_one(root: &Path, dir: &Path, name: &str, script: &str) -> Result<(), String> {
    if !hook_name_ok(name) {
        return Err(REFUSAL.into());
    }
    let dest = dir.join(name);
    if !contained(root, &dest) {
        return Err(REFUSAL.into());
    }
    if let Ok(meta) = std::fs::symlink_metadata(&dest) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(REFUSAL.into());
        }
        let installed = crate::fs::canonical(&dest).map_err(|_| REFUSAL.to_string())?;
        if !contained(root, &installed) {
            return Err(REFUSAL.into());
        }
    }
    let same = std::fs::read(&dest)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .is_some_and(|current| current.replace("\r\n", "\n") == script);
    if !same {
        publish_hook(root, dir, &dest, script)?;
    }
    mark_executable(&dest).map_err(|_| REFUSAL.to_string())?;
    let installed = crate::fs::canonical(&dest).map_err(|_| REFUSAL.to_string())?;
    if !contained(root, &installed) {
        return Err(REFUSAL.into());
    }
    Ok(())
}

/// The value a config variable has for the crew: its own override first, then
/// this process. The crew's GIT_CONFIG_* entries are never read here.
fn config_value(env: &[(String, String)], key: &str) -> Option<String> {
    if let Some((_, value)) = env.iter().rev().find(|(name, _)| name == key) {
        return Some(value.clone());
    }
    std::env::var(key).ok()
}

fn git(
    workdir: &Path,
    env: &[(String, String)],
    args: &[&str],
) -> Result<String, super::git::GitFail> {
    let mut cmd = crate::delivery::child("git");
    cmd.arg("--no-pager").arg("-C").arg(workdir).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    for key in CONFIG_ENV {
        if let Some(value) = config_value(env, key) {
            cmd.env(key, value);
        }
    }
    super::git::run_limited(cmd, GIT_TIMEOUT)
}

fn first_line(raw: &str) -> String {
    raw.lines().next().unwrap_or("").trim().to_string()
}

/// The two paths rev-parse prints, made absolute. A relative common dir is
/// relative to the directory git ran in.
fn two_paths(out: &str, workdir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let mut lines = out.lines().map(str::trim).filter(|line| !line.is_empty());
    let common = lines.next().ok_or_else(|| GIT_REFUSAL.to_string())?;
    let top = lines.next().ok_or_else(|| GIT_REFUSAL.to_string())?;
    let absolute = |text: &str| {
        let path = Path::new(text);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            workdir.join(path)
        }
    };
    Ok((absolute(common), absolute(top)))
}

fn expand_tilde(value: &str, home: Option<&str>) -> Option<String> {
    if value == "~" {
        return home.map(str::to_string);
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.map(|home| format!("{home}/{rest}"));
    }
    Some(value.to_string())
}

fn windows_slash(text: &str) -> String {
    #[cfg(windows)]
    {
        text.replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        text.to_string()
    }
}

/// A POSIX shell word for a path. Git runs hooks with sh on every platform.
fn shell_quote(text: &str) -> Option<String> {
    if text.contains('\0') {
        return None;
    }
    Some(format!("'{}'", windows_slash(text).replace('\'', "'\\''")))
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

fn folder_key(common: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(common.as_bytes());
    hex(&hasher.finalize())
}

struct Resolved {
    common: PathBuf,
    real_hooks: PathBuf,
}

/// Resolve the repository's own hooks once, at crew spawn. The crew's own
/// core.hooksPath override is not in the environment here, so a husky-style
/// path in local, global or system config is what the lookup returns.
fn resolve(workdir: &Path, env: &[(String, String)]) -> Result<Resolved, String> {
    let (common, toplevel) = match git(
        workdir,
        env,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--show-toplevel",
        ],
    ) {
        Ok(out) => two_paths(&out, workdir)?,
        Err(super::git::GitFail::Rejected) => {
            // A git older than 2.31 has no --path-format.
            let out = git(
                workdir,
                env,
                &["rev-parse", "--git-common-dir", "--show-toplevel"],
            )
            .map_err(|_| GIT_REFUSAL.to_string())?;
            two_paths(&out, workdir)?
        }
        Err(super::git::GitFail::Unavailable) => return Err(GIT_REFUSAL.into()),
    };
    let common = crate::fs::canonical(&common).map_err(|_| GIT_REFUSAL.to_string())?;
    let toplevel = crate::fs::canonical(&toplevel).map_err(|_| GIT_REFUSAL.to_string())?;
    let configured = match git(workdir, env, &["config", "--get", "core.hooksPath"]) {
        Ok(out) => Some(first_line(&out)),
        Err(super::git::GitFail::Rejected) => None,
        // A timeout is not "nothing is set": guessing would skip the
        // repository's own hooks, so the crew runs without an override instead.
        Err(super::git::GitFail::Unavailable) => return Err(GIT_REFUSAL.into()),
    };
    let real_hooks = match configured.filter(|value| !value.is_empty()) {
        Some(value) => {
            let home = config_value(env, "HOME");
            let expanded =
                expand_tilde(&value, home.as_deref()).ok_or_else(|| GIT_REFUSAL.to_string())?;
            let path = PathBuf::from(expanded);
            if path.is_absolute() {
                path
            } else {
                toplevel.join(path)
            }
        }
        None => common.join("hooks"),
    };
    let real_hooks = crate::fs::canonical(&real_hooks).unwrap_or(real_hooks);
    Ok(Resolved { common, real_hooks })
}

#[cfg(unix)]
fn hook_runnable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn hook_runnable(meta: &std::fs::Metadata) -> bool {
    meta.is_file()
}

struct RealHook {
    name: String,
    path: String,
}

/// The hooks the repository itself would run right now. Symlinks are followed,
/// as git follows them. A name that cannot be baked into a shell word is not
/// guessed at: the whole install fails, so the crew runs with its own config.
fn real_hooks(dir: &Path) -> Result<Vec<RealHook>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // No hooks folder, or one that cannot be read: the repository has no hooks.
        Err(_) => return Ok(Vec::new()),
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !hook_name_ok(name) || NEVER_FORWARD.contains(&name) {
            continue;
        }
        let path = dir.join(name);
        match std::fs::metadata(&path) {
            Ok(meta) if hook_runnable(&meta) => {}
            _ => continue,
        }
        let path = crate::fs::canonical(&path)
            .unwrap_or(path)
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| REFUSAL.to_string())?;
        found.push(RealHook {
            name: name.to_string(),
            path,
        });
    }
    Ok(found)
}

/// What makes the repository's own hook runnable. Git for Windows has no
/// executable bit, so a hook file that exists is one git runs.
fn hook_test() -> &'static str {
    if cfg!(windows) {
        "-f"
    } else {
        "-x"
    }
}

fn prepare_script(real: Option<&str>) -> Result<String, String> {
    let template = SCRIPT.replace("\r\n", "\n");
    if !template.contains(REAL_HOOK_LINE) || !template.contains(HOOK_TEST_LINE) {
        return Err(REFUSAL.into());
    }
    let template = template.replacen(HOOK_TEST_LINE, &format!("hook_test='{}'", hook_test()), 1);
    let Some(real) = real else {
        return Ok(template);
    };
    let quoted = shell_quote(real).ok_or_else(|| REFUSAL.to_string())?;
    Ok(template.replacen(REAL_HOOK_LINE, &format!("real_hook={quoted}"), 1))
}

fn forwarder_script(real: &str) -> Result<String, String> {
    let quoted = shell_quote(real).ok_or_else(|| REFUSAL.to_string())?;
    Ok(format!(
        "#!/bin/sh\n\
         # SPDX-License-Identifier: Apache-2.0\n\
         # Hivra WP-86. Runs the repository's own hook, whose path was resolved when\n\
         # the crew started. A hook added or changed during the run is picked up on\n\
         # the next run.\n\
         real_hook={quoted}\n\
         if [ {test} \"$real_hook\" ]; then\n\
         \texec \"$real_hook\" \"$@\"\n\
         fi\n\
         exit 0\n",
        test = hook_test()
    ))
}

/// Remove forwarders for hooks the repository no longer has, and temp files a
/// failed publish left behind. Only regular files and links inside the folder
/// are touched; removing a link removes the link, never what it points at.
/// Another crew installing into the same folder right now keeps its temp file.
pub(crate) fn prune(root: &Path, dir: &Path, keep: &BTreeSet<String>) -> Result<(), String> {
    prune_with(root, dir, keep, |path| std::fs::remove_file(path))
}

/// `remove` is a parameter so a test can make one removal fail the way Windows
/// fails it, without needing a Windows machine to hold a file open.
pub(crate) fn prune_with(
    root: &Path,
    dir: &Path,
    keep: &BTreeSet<String>,
    mut remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|_| REFUSAL.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !contained(root, &path) {
            return Err(REFUSAL.into());
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if keep.contains(name) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            continue;
        }
        let temp = is_hook_temp(name);
        if temp && !temp_is_stale(&meta) {
            continue;
        }
        match remove(&path) {
            Ok(()) => {}
            // The other crew renamed or removed it since the listing.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            // A temp file is disposable, so never fail an install over one. On
            // Windows a file another process holds open refuses removal with
            // ERROR_SHARING_VIOLATION (os error 32), which Rust does not map to
            // PermissionDenied (only ERROR_ACCESS_DENIED, os error 5, is
            // mapped), and a file already marked for deletion gives
            // ERROR_ACCESS_DENIED. Both mean the same thing here: another crew
            // owns that name and ours is not needed.
            Err(_) if temp => {}
            // A real hook file that will not go is a refusal: git would keep
            // running a forwarder for a hook the repository no longer has.
            Err(_) => return Err(REFUSAL.into()),
        }
    }
    Ok(())
}

/// Regenerate the folder for this repository: prepare-commit-msg, plus a
/// forwarder for each hook git would run at spawn (the executable bit on Unix,
/// existence on Windows). Every file
/// is published atomically, one at a time, and the path is refused unless it
/// stays inside the data directory. One failed file fails the install, so git
/// is not pointed at a half-written folder; the crew then runs with no
/// override and the repository's own hooks still apply.
pub fn install_for_repo(
    data_dir: &Path,
    workdir: &Path,
    env: &[(String, String)],
) -> Result<PathBuf, String> {
    let root = crate::fs::canonical(data_dir).map_err(|_| REFUSAL.to_string())?;
    if !root.is_dir() {
        return Err(REFUSAL.into());
    }
    let resolved = super::read_with_retry(|| resolve(workdir, env))?;
    let common = resolved
        .common
        .to_str()
        .ok_or_else(|| REFUSAL.to_string())?;
    let attribution = ensure_child(&root, "attribution")?;
    let hooks_root = ensure_child(&attribution, "hooks")?;
    let dir = ensure_child(&hooks_root, &folder_key(common))?;
    if !contained(&root, &dir) {
        return Err(REFUSAL.into());
    }
    let found = real_hooks(&resolved.real_hooks)?;
    let prepare = found.iter().find(|hook| hook.name == PREPARE);
    install_one(
        &root,
        &dir,
        PREPARE,
        &prepare_script(prepare.map(|hook| hook.path.as_str()))?,
    )?;
    let mut keep = BTreeSet::new();
    keep.insert(PREPARE.to_string());
    for hook in &found {
        if hook.name == PREPARE {
            continue;
        }
        install_one(&root, &dir, &hook.name, &forwarder_script(&hook.path)?)?;
        keep.insert(hook.name.clone());
    }
    prune(&root, &dir, &keep)?;
    Ok(dir)
}
