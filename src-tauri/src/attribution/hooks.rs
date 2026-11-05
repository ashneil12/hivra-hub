// SPDX-License-Identifier: Apache-2.0
// Hivra WP-86. The hooks folder lives in this copy's data folder. A dev copy
// has its own data folder, so it never writes the daily app's hooks.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const SCRIPT: &str = include_str!("hook.sh");
const REFUSAL: &str = "The hooks folder isn't inside this copy's data.";

/// Every name githooks(5) documents, except three that must not be files here.
/// One missing name from this list is a repository hook that never runs while
/// a crew's git is pointed at this folder.
/// push-to-checkout: its presence makes receive-pack hand over the worktree
/// update, so a forwarder that exits 0 moves the ref and leaves the files stale
/// when receive.denyCurrentBranch is updateInstead.
/// proc-receive: git runs it only when that feature is configured, and it must
/// speak the pkt-line protocol. Exiting 0 does not.
/// fsmonitor-watchman: git never runs that name from the hooks directory.
const HOOK_NAMES: &[&str] = &[
    "applypatch-msg",
    "commit-msg",
    "p4-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
    "p4-prepare-changelist",
    "post-applypatch",
    "post-checkout",
    "post-commit",
    "post-index-change",
    "post-merge",
    "post-receive",
    "post-rewrite",
    "post-update",
    "pre-applypatch",
    "pre-auto-gc",
    "pre-commit",
    "pre-merge-commit",
    "pre-push",
    "pre-rebase",
    "pre-receive",
    "prepare-commit-msg",
    "reference-transaction",
    "sendemail-validate",
    "update",
];

fn hook_name_ok(name: &str) -> bool {
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

/// A fresh path for every install. Two crews in one process must not share a file.
pub(crate) fn hook_temp(dir: &Path) -> PathBuf {
    let n = HOOK_TMP.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(
        ".prepare-commit-msg.{}.{n}.tmp",
        std::process::id()
    ))
}

fn script_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    Some(text.replace("\r\n", "\n"))
}

/// Publish the hook. A lost rename is not a failure when the installed file is
/// already this script: the other crew got there first. Only our temp file is removed.
fn publish_hook(root: &Path, dir: &Path, dest: &Path, script: &str) -> Result<(), String> {
    for attempt in 0..8 {
        let tmp = hook_temp(dir);
        if !contained(root, &tmp) {
            return Err(REFUSAL.into());
        }
        if std::fs::symlink_metadata(&tmp).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(REFUSAL.into());
        }
        if std::fs::write(&tmp, script.as_bytes()).is_err() {
            return Err(REFUSAL.into());
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

/// Install a forwarder for every git hook under `data_dir/attribution/hooks`.
/// The path is refused unless it stays inside the data directory. A symlink is
/// refused rather than followed. Matching bytes are not rewritten. One failed
/// file fails the install, so git is not pointed at a half-written folder.
pub fn install_hooks(data_dir: &Path) -> Result<PathBuf, String> {
    let root = crate::fs::canonical(data_dir).map_err(|_| REFUSAL.to_string())?;
    if !root.is_dir() {
        return Err(REFUSAL.into());
    }
    let attribution = ensure_child(&root, "attribution")?;
    let dir = ensure_child(&attribution, "hooks")?;
    if !contained(&root, &dir) {
        return Err(REFUSAL.into());
    }
    let script = SCRIPT.replace("\r\n", "\n");
    for name in HOOK_NAMES {
        install_one(&root, &dir, name, &script)?;
    }
    Ok(dir)
}
