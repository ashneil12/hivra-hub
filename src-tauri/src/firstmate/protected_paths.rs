//! WP-178 items 3.3 and 3.4: fingerprints for the report-only after-turn check on first-mate turns.
//!
//! Git status cannot see `.git/hooks` or `.git/config` (checkout_guard.rs), so the check takes their fingerprints itself:
//! a content hash for each hook and for the config. The secret places (SSH keys, cloud logins, keychains; the list in
//! src/shared/security/agentSecretPaths.json) are fingerprinted by size and modified time only, never by content, so
//! the check never reads a key. The TypeScript side (protectedPaths.ts) names what changed. Nothing is blocked here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use crate::agent_sandbox::secret_places;

/// Files bigger than this are fingerprinted by size and time rather than read, so a huge file cannot stall a turn.
const MAX_HASHED_BYTES: u64 = 1_048_576;
/// A bound on the secret-place walk, so a folder with a very large tree cannot stall a turn.
const MAX_SECRET_ENTRIES: usize = 500;

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The git dir of a checkout (its common dir, so a worktree's hooks are the repo's), or None when `cwd` is not a repo.
fn common_git_dir(cwd: &Path) -> Option<PathBuf> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--git-common-dir"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return None;
    }
    let path = PathBuf::from(text);
    Some(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
}

fn stat_value(meta: &std::fs::Metadata) -> String {
    let secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("size:{}:mtime:{secs}", meta.len())
}

/// A git file, by content hash; a huge file by size and time (it is still caught when it changes).
fn fingerprint_file(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    if meta.len() > MAX_HASHED_BYTES {
        return Some(stat_value(&meta));
    }
    std::fs::read(path).ok().map(|bytes| sha256_hex(&bytes))
}

/// Hook files directly in `dir` (git hooks are flat), keyed `.git/hooks/<name>`.
fn hook_fingerprints(dir: &Path, out: &mut BTreeMap<String, String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();
    for name in names.into_iter().take(MAX_SECRET_ENTRIES) {
        if let Some(value) = fingerprint_file(&dir.join(&name)) {
            out.insert(format!(".git/hooks/{name}"), value);
        }
    }
}

/// A secret place by size and time only, keyed `~/<relative path>`. Walks at most two folders deep.
fn secret_stat(dir: &Path, key: &str, depth: u8, out: &mut BTreeMap<String, String>) {
    if out.len() >= MAX_SECRET_ENTRIES {
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(dir) else {
        return;
    };
    if meta.is_file() {
        out.insert(key.to_string(), stat_value(&meta));
        return;
    }
    if !meta.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();
    for name in names {
        let child = dir.join(&name);
        let child_key = format!("{key}/{name}");
        if depth > 0 {
            secret_stat(&child, &child_key, depth - 1, out);
        } else if let Ok(child_meta) = std::fs::symlink_metadata(&child) {
            if child_meta.is_file() {
                out.insert(child_key, stat_value(&child_meta));
            }
        }
    }
}

/// The fingerprints for one turn: the checkout's hooks and config (content), and the secret places (size and time).
pub fn fingerprints(cwd: &Path, home: Option<&Path>) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    if let Some(git) = common_git_dir(cwd) {
        hook_fingerprints(&git.join("hooks"), &mut out);
        if let Some(config) = fingerprint_file(&git.join("config")) {
            out.insert(".git/config".to_string(), config);
        }
    }
    if let Some(home) = home {
        let places = secret_places()?;
        for dir in &places.dirs {
            secret_stat(&home.join(dir), &format!("~/{dir}"), 2, &mut out);
        }
        for file in &places.files {
            if let Some(meta) = std::fs::symlink_metadata(home.join(file))
                .ok()
                .filter(|m| m.is_file())
            {
                out.insert(format!("~/{file}"), stat_value(&meta));
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn firstmate_protected_fingerprints(
    cwd: String,
) -> Result<BTreeMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        fingerprints(Path::new(&cwd), home.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "protected-paths-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    fn git_repo(tag: &str) -> PathBuf {
        let repo = temp_dir(tag);
        let status = std::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(&repo)
            .status()
            .unwrap();
        assert!(status.success());
        std::fs::create_dir_all(repo.join(".git").join("hooks")).unwrap();
        repo
    }

    #[test]
    fn a_changed_git_hook_is_fingerprinted_under_the_checkout_key() {
        let repo = git_repo("hook");
        let hook = repo.join(".git").join("hooks").join("pre-commit");
        std::fs::write(&hook, "echo one\n").unwrap();
        let before = fingerprints(&repo, None).unwrap();
        std::fs::write(&hook, "echo two\n").unwrap();
        let after = fingerprints(&repo, None).unwrap();
        assert!(
            before.contains_key(".git/hooks/pre-commit"),
            "keys: {:?}",
            before.keys()
        );
        assert_ne!(
            before.get(".git/hooks/pre-commit"),
            after.get(".git/hooks/pre-commit")
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_changed_git_config_is_fingerprinted_under_the_checkout_key() {
        let repo = git_repo("config");
        std::fs::write(repo.join(".git").join("config"), "[core]\n").unwrap();
        let before = fingerprints(&repo, None).unwrap();
        std::fs::write(
            repo.join(".git").join("config"),
            "[core]\n\tfsmonitor = evil\n",
        )
        .unwrap();
        let after = fingerprints(&repo, None).unwrap();
        assert_ne!(before.get(".git/config"), after.get(".git/config"));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_secret_place_is_fingerprinted_by_size_and_time_never_by_content() {
        let home = temp_dir("secret");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        let key = home.join(".ssh").join("id_ed25519");
        std::fs::write(&key, "PRIVATE-KEY-BODY").unwrap();
        let before = fingerprints(&home, Some(&home)).unwrap();
        std::fs::write(&key, "PRIVATE-KEY-BODY-CHANGED-LENGTH").unwrap();
        let after = fingerprints(&home, Some(&home)).unwrap();
        assert!(
            before.contains_key("~/.ssh/id_ed25519"),
            "keys: {:?}",
            before.keys()
        );
        assert_ne!(
            before.get("~/.ssh/id_ed25519"),
            after.get("~/.ssh/id_ed25519")
        );
        assert!(
            !before.values().any(|v| v.contains("PRIVATE-KEY")),
            "a fingerprint must never carry the key's content"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_folder_that_is_not_a_git_checkout_has_no_git_keys() {
        let plain = temp_dir("plain");
        let found = fingerprints(&plain, None).unwrap();
        assert!(
            found.keys().all(|k| !k.starts_with(".git/")),
            "keys: {:?}",
            found.keys()
        );
        let _ = std::fs::remove_dir_all(&plain);
    }
}
