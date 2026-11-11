//! File helpers for the plugin registry: copying a plugin in, directory links on every platform, the Claude Code
//! shim, and removals that only ever touch what the registry made.

use std::path::{Path, PathBuf};

use super::manifest::{Manifest, PluginSkill};

pub fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The path with links resolved, without Windows' verbatim `\\?\` prefix on drive paths (`crate::fs::canonical`), so
/// it still works once `/`-joined (a plugin's `${PLUGIN_ROOT}/server.js`) and when handed to another program.
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    crate::fs::canonical(path)
}

/// The path with links resolved when it exists, as given otherwise.
pub fn resolved(path: &Path) -> PathBuf {
    canonical(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let written = std::fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Remove a folder the registry made (or a file, or a link: never what a link points to). Missing is fine.
pub fn remove_tree(path: &Path) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    let result = if is_link(path, &meta) {
        remove_link(path)
    } else if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| format!("{} couldn't be removed: {e}", path.display()))
}

/// Remove `dir` when it is an empty folder. Returns whether it is gone.
pub fn remove_dir_if_empty(dir: &Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none() && std::fs::remove_dir(dir).is_ok(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

#[cfg(unix)]
fn is_link(_path: &Path, meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

#[cfg(windows)]
fn is_link(path: &Path, meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink() || junction::exists(path).unwrap_or(false)
}

#[cfg(unix)]
fn remove_link(path: &Path) -> std::io::Result<()> {
    std::fs::remove_file(path)
}

#[cfg(windows)]
fn remove_link(path: &Path) -> std::io::Result<()> {
    // A junction is a directory entry: remove_dir drops the link and never touches the target.
    std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path))
}

/// Where a directory link points, if `path` is one.
pub fn link_target(path: &Path) -> Option<PathBuf> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() {
        return std::fs::read_link(path).ok();
    }
    #[cfg(windows)]
    if junction::exists(path).unwrap_or(false) {
        return junction::get_target(path).ok();
    }
    None
}

/// Link `link` to the folder `target` (a symlink; a junction on Windows, which needs no special rights).
pub fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let result = junction::create(target, link);
    result.map_err(|e| format!("{} couldn't be linked: {e}", link.display()))
}

/// Remove `link` only when it is still a link to `target`.
pub fn remove_link_if_points_to(link: &Path, target: &Path) -> Result<(), String> {
    match link_target(link) {
        Some(points) if resolved(&points) == resolved(target) || points == target => {
            remove_link(link).map_err(|e| format!("{} couldn't be removed: {e}", link.display()))
        }
        _ => Ok(()),
    }
}

/// Copy a plugin folder. Files and folders are copied; a link is followed only when it resolves inside the plugin
/// (Agent Plugins §4.1), and copied as what it points to. Anything else is left out.
pub fn copy_plugin_tree(root: &Path, to: &Path) -> Result<(), String> {
    let root = canonical(root).map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::from([root.clone()]);
    copy_dir(&root, &root, to, &mut seen)
}

/// `seen` holds every real folder copied so far, so links between folders (siblings included) can't loop.
fn copy_dir(
    root: &Path,
    from: &Path,
    to: &Path,
    seen: &mut std::collections::HashSet<PathBuf>,
) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("{} couldn't be made: {e}", to.display()))?;
    let entries =
        std::fs::read_dir(from).map_err(|e| format!("{} can't be read: {e}", from.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let Ok(real) = canonical(&path) else {
            continue;
        };
        if !real.starts_with(root) {
            continue;
        }
        let dest = to.join(&name);
        if real.is_dir() {
            if !seen.insert(real.clone()) {
                continue; // a folder already copied: a link back up the tree or across to a sibling
            }
            copy_dir(root, &real, &dest, seen)?;
        } else if real.is_file() {
            std::fs::copy(&real, &dest)
                .map_err(|e| format!("{} couldn't be copied: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// A Claude Code plugin folder that carries only the plugin's checked skills: `.claude-plugin/plugin.json` and a
/// `skills` folder with one link per skill that loaded (a skipped skill, say one with `hooks`, is not linked). Claude
/// Code loads it with `--plugin-dir` for one session; nothing else of the plugin (hooks, agents, its own `.mcp.json`)
/// comes along, so the plugin's MCP servers reach Claude only through the app's `--mcp-config`.
pub fn make_claude_shim(
    dir: &Path,
    root: &Path,
    skills: &[PluginSkill],
    manifest: &Manifest,
) -> Result<(), String> {
    remove_tree(dir)?;
    let meta = dir.join(".claude-plugin");
    std::fs::create_dir_all(&meta)
        .map_err(|e| format!("{} couldn't be made: {e}", meta.display()))?;
    let mut json = serde_json::json!({ "name": claude_plugin_name(&manifest.name) });
    if let Some(version) = &manifest.version {
        json["version"] = version.clone().into();
    }
    if let Some(description) = &manifest.description {
        json["description"] = description.clone().into();
    }
    let result = std::fs::write(meta.join("plugin.json"), json.to_string())
        .map_err(|e| e.to_string())
        .and_then(|_| std::fs::create_dir_all(dir.join("skills")).map_err(|e| e.to_string()))
        .and_then(|_| {
            skills.iter().try_for_each(|skill| {
                link_dir(
                    &root.join(&skill.dir),
                    &dir.join("skills").join(&skill.name),
                )
            })
        });
    if result.is_err() {
        let _ = remove_tree(dir);
    }
    result
}

/// Claude Code wants kebab-case plugin names; Agent Plugins also allows periods.
pub fn claude_plugin_name(name: &str) -> String {
    name.replace('.', "-")
}

/// The mode bits that decide what a file is (WP-101 fix round 2, item H(a)): a script that can be run is not the same
/// file as one that cannot. Any executable bit counts, for the owner, its group or anyone else, since each of them is
/// a way to run the file; they survive a copy the way the bytes do, so two copies of the same plugin still hash the
/// same wherever they sit. On Windows there is no executable bit, and nothing to read.
#[cfg(unix)]
fn mode_bits(meta: &std::fs::Metadata) -> u8 {
    use std::os::unix::fs::PermissionsExt;
    (meta.permissions().mode() & 0o111) as u8
}

#[cfg(windows)]
fn mode_bits(_meta: &std::fs::Metadata) -> u8 {
    0
}

/// A digest of everything in an installed plugin folder (WP-31's lock file): each path, its kind, each file's
/// executable bits and bytes (or a link's target), in sorted order, as `sha256-<hex>`. Two copies of the same plugin
/// give the same digest wherever they sit. A file that can't be read is hashed as unreadable, never as empty, so a
/// copy that hides a file behind a permission can't pass for one that holds nothing there (item H(b)).
pub fn tree_digest(dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let is_dir = std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir())
                && link_target(&path).is_none();
            out.push((rel, path.clone()));
            if is_dir {
                walk(base, &path, out);
            }
        }
    }
    let mut paths = Vec::new();
    walk(dir, dir, &mut paths);
    paths.sort();
    let mut hash = Sha256::new();
    for (rel, path) in paths {
        hash.update(rel.as_bytes());
        hash.update([0]);
        if let Some(target) = link_target(&path) {
            hash.update(b"l");
            hash.update(target.to_string_lossy().replace('\\', "/").as_bytes());
        } else if path.is_dir() {
            hash.update(b"d");
        } else {
            hash.update(b"f");
            match std::fs::symlink_metadata(&path) {
                Ok(meta) => hash.update([mode_bits(&meta)]),
                Err(_) => hash.update([0]),
            }
            match std::fs::read(&path) {
                Ok(bytes) => {
                    hash.update(b"r");
                    hash.update(bytes);
                }
                // Unreadable is its own case, not the empty file it would otherwise look like.
                Err(_) => hash.update(b"u"),
            }
        }
        hash.update([0]);
    }
    let digest = hash.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256-{hex}")
}

/// Every path under `dirs` (relative, sorted, with a marker for links) — what a test compares before and after.
#[cfg(test)]
pub fn tree(dirs: &[&Path]) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if link_target(&path).is_some() {
                out.push(format!("{rel} -> link"));
            } else if meta.is_dir() {
                out.push(format!("{rel}/"));
                walk(base, &path, out);
            } else {
                out.push(rel);
            }
        }
    }
    let mut out = Vec::new();
    for dir in dirs {
        out.push(format!("[{}]", dir.display()));
        walk(dir, dir, &mut out);
    }
    out.sort();
    out
}
