//! File helpers for the plugin registry: copying a plugin in, directory links on every platform, the Claude Code
//! shim, and removals that only ever touch what the registry made.

use std::path::{Path, PathBuf};

use super::manifest::Manifest;

pub fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The path with links resolved. On Windows a drive path comes back without the verbatim `\\?\` prefix, so it
/// still works once `/`-joined (a plugin's `${PLUGIN_ROOT}/server.js`) and when handed to another program.
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let real = path.canonicalize()?;
    #[cfg(windows)]
    {
        let text = real.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            if rest.as_bytes().get(1) == Some(&b':') {
                return Ok(PathBuf::from(rest));
            }
        }
    }
    Ok(real)
}

/// The path with links resolved when it exists, as given otherwise.
pub fn resolved(path: &Path) -> PathBuf {
    canonical(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
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
    copy_dir(&root, &root, to)
}

fn copy_dir(root: &Path, from: &Path, to: &Path) -> Result<(), String> {
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
            if real == root || from.starts_with(&real) {
                continue; // a link back up the tree
            }
            copy_dir(root, &real, &dest)?;
        } else if real.is_file() {
            std::fs::copy(&real, &dest)
                .map_err(|e| format!("{} couldn't be copied: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// A Claude Code plugin folder that carries only the plugin's skills: `.claude-plugin/plugin.json` and a `skills`
/// link. Claude Code loads it with `--plugin-dir` for one session; nothing else of the plugin (hooks, agents, its own
/// `.mcp.json`) comes along, so the plugin's MCP servers reach Claude only through the app's `--mcp-config`.
pub fn make_claude_shim(dir: &Path, skills: &Path, manifest: &Manifest) -> Result<(), String> {
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
        .and_then(|_| link_dir(skills, &dir.join("skills")));
    if result.is_err() {
        let _ = remove_tree(dir);
    }
    result
}

/// Claude Code wants kebab-case plugin names; Agent Plugins also allows periods.
pub fn claude_plugin_name(name: &str) -> String {
    name.replace('.', "-")
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
