//! Which folders an imported chat or automation may keep (docs/PORTABLE.md, "Folders").
//!
//! An export is a file anyone can write. The agent, git, checkpoints and terminals run in a chat's folder, so a crafted
//! or foreign export that names `/`, the home folder or any other folder would point them there. A folder comes in only
//! when it is a real folder on this Mac that sits inside a project this copy already has: the projects in the app's own
//! record, the folders the project rail lists (the window passes them), and the Monos' own folders. Both sides are
//! resolved first, links followed, so a link in a project that points out is refused, and a folder that only shares a
//! project's prefix is not inside it. Otherwise the folder is cleared: the chat opens with none and asks which project to
//! use before it runs anything (src/chat_folder.rs refuses every launch without one).
//!
//! The projects read here are the app's record as it is when the chats come in. The window registers the projects the
//! person ticked first (src/features/portable/model/importPlan.ts), and a project's folder is adopted from the file only
//! when its own tick says so and `refused_project_folder` allows it, so a file can't vouch for its own folders.

use std::cell::OnceCell;
use std::path::{Component, Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use super::Env;

pub(super) struct FolderRules {
    home: Option<PathBuf>,
    /// Project folders, resolved. Never one that is too broad (`too_broad`): it would vouch for everything beneath it.
    projects: Vec<PathBuf>,
    /// Where the Monos keep their own folders. Something inside, never the folder itself.
    mono_roots: Vec<PathBuf>,
    /// Working copies git itself lists for those projects, read when a chat names a worktree.
    worktrees: OnceCell<Vec<PathBuf>>,
}

/// What a chat or automation keeps of the folders its file named.
pub(super) struct Folders {
    pub cwd: String,
    pub worktree: Option<String>,
    /// The folders a chat's own paths must stay inside (its kept folder and kept worktree, resolved).
    pub roots: Vec<PathBuf>,
    /// The file named a folder and it didn't stay.
    pub cleared: bool,
}

impl FolderRules {
    /// `extra` are folders the window knows as projects (the rail's), on top of the app's own project record.
    pub(super) fn load(env: &Env, conn: &Connection, extra: &[String]) -> Self {
        let mut named: Vec<String> = Vec::new();
        if let Some(doc) = crate::local_hub::read_doc(conn, "projects")
            .ok()
            .and_then(|doc| doc.value)
        {
            if let Some(list) = doc.get("projects").and_then(Value::as_array) {
                named.extend(
                    list.iter()
                        .filter_map(|project| project.get("folder").and_then(Value::as_str))
                        .map(str::to_string),
                );
            }
        }
        named.extend(extra.iter().cloned());
        let mut projects: Vec<PathBuf> = Vec::new();
        for folder in named {
            let Some(dir) = resolve(Path::new(&folder), env.home.as_deref()) else {
                continue;
            };
            if too_broad(env, &dir).is_none() && !projects.contains(&dir) {
                projects.push(dir);
            }
        }
        let mono_roots = [env.monos_root.clone(), env.data_dir.join("mono-teams")]
            .iter()
            .filter_map(|root| resolve(root, None))
            .collect();
        Self {
            home: env.home.clone(),
            projects,
            mono_roots,
            worktrees: OnceCell::new(),
        }
    }

    fn resolve(&self, raw: &str) -> Option<PathBuf> {
        resolve(Path::new(raw), self.home.as_deref())
    }

    fn in_a_project(&self, dir: &Path) -> bool {
        self.projects.iter().any(|project| dir.starts_with(project))
            || self
                .mono_roots
                .iter()
                .any(|root| dir != root && dir.starts_with(root))
    }

    /// A working copy sits beside its project more often than inside it, so it also stays when git lists it for one of
    /// the known projects (the list is git's, not the file's).
    fn keeps_worktree(&self, raw: &str) -> Option<PathBuf> {
        let dir = self.resolve(raw)?;
        if self.in_a_project(&dir) {
            return Some(dir);
        }
        let listed = self.worktrees.get_or_init(|| {
            self.projects
                .iter()
                .filter_map(|project| crate::worktrees::list(project).ok())
                .flatten()
                .filter_map(|tree| resolve(Path::new(&tree.path), None))
                .collect()
        });
        listed
            .iter()
            .any(|tree| dir.starts_with(tree))
            .then_some(dir)
    }

    /// What a chat keeps of its folder and its worktree. A worktree is the chat's working copy of its project, so one
    /// with no kept project goes too.
    pub(super) fn vet(&self, cwd: Option<&str>, worktree: Option<&str>) -> Folders {
        fn named(value: Option<&str>) -> Option<&str> {
            value.map(str::trim).filter(|v| !v.is_empty())
        }
        let (cwd, worktree) = (named(cwd), named(worktree));
        let cleared_all = |cleared| Folders {
            cwd: String::new(),
            worktree: None,
            roots: Vec::new(),
            cleared,
        };
        let Some(kept) = cwd.and_then(|raw| self.resolve(raw).filter(|dir| self.in_a_project(dir)))
        else {
            return cleared_all(cwd.is_some() || worktree.is_some());
        };
        let mut roots = vec![kept];
        let mut cleared = false;
        let mut kept_worktree = None;
        if let Some(raw) = worktree {
            match self.keeps_worktree(raw) {
                Some(dir) => {
                    roots.push(dir);
                    kept_worktree = Some(raw.to_string());
                }
                None => cleared = true,
            }
        }
        Folders {
            cwd: cwd.unwrap_or_default().to_string(),
            worktree: kept_worktree,
            roots,
            cleared,
        }
    }

    /// An automation's folder and worktree, written back into its definition. True when one was cleared.
    pub(super) fn vet_automation(&self, definition: &mut Value) -> bool {
        let Some(map) = definition.as_object_mut() else {
            return false;
        };
        let text = |map: &serde_json::Map<String, Value>, key: &str| {
            map.get(key).and_then(Value::as_str).map(str::to_string)
        };
        let kept = self.vet(
            text(map, "cwd").as_deref(),
            text(map, "worktreeCwd").as_deref(),
        );
        if map.contains_key("cwd") {
            map.insert("cwd".into(), Value::String(kept.cwd));
        }
        if map.contains_key("worktreeCwd") {
            map.insert(
                "worktreeCwd".into(),
                Value::String(kept.worktree.unwrap_or_default()),
            );
        }
        kept.cleared
    }

    /// The paths a chat's tool rows (and approvals) name must stay inside the chat's own folders: they feed the
    /// checkpoint calls (`sessionEditPaths`), and a path from a file is no one's choice. Others are dropped. Returns how
    /// many were.
    pub(super) fn confine_tool_paths(&self, blocks: &mut Value, roots: &[PathBuf]) -> usize {
        let mut dropped = 0;
        let Some(list) = blocks.as_array_mut() else {
            return 0;
        };
        for block in list {
            let inside = |raw: &str| self.path_inside(roots, raw);
            let mut confine = |holder: Option<&mut Value>| {
                if let Some(paths) = holder.and_then(|paths| paths.as_array_mut()) {
                    let before = paths.len();
                    paths.retain(|path| path.as_str().is_some_and(&inside));
                    dropped += before - paths.len();
                }
            };
            confine(block.pointer_mut("/tool/paths"));
            confine(block.pointer_mut("/approval/call/paths"));
            if let Some(preview) = block
                .pointer_mut("/tool/preview")
                .and_then(Value::as_object_mut)
            {
                let outside = match preview.get("path") {
                    None | Some(Value::Null) => false,
                    Some(Value::String(raw)) => !inside(raw),
                    Some(_) => true,
                };
                if outside {
                    preview.remove("path");
                    dropped += 1;
                }
            }
        }
        dropped
    }

    /// A path as the chat's agent wrote it (absolute, `~/…`, or relative to the chat's folder), resolved the way a file
    /// would be reached (`..` and links included), is inside one of `roots`. The file need not exist any more.
    fn path_inside(&self, roots: &[PathBuf], raw: &str) -> bool {
        let raw = raw.trim();
        if raw.is_empty() || roots.is_empty() {
            return false;
        }
        let expanded = expand(Path::new(raw), self.home.as_deref());
        let candidates: Vec<PathBuf> = if expanded.is_absolute() {
            vec![expanded]
        } else {
            roots.iter().map(|root| root.join(&expanded)).collect()
        };
        candidates.iter().any(|candidate| {
            reach(candidate)
                .is_some_and(|reached| roots.iter().any(|root| reached.starts_with(root)))
        })
    }
}

/// Why a real folder can never be a project's folder for an import, whatever is ticked or recorded: it holds, or is, a
/// place nobody means to hand an agent whole. The filesystem root, `/Volumes`, the home folder and every folder that
/// holds it, the app's own data folder with every folder that holds it and everything inside it.
fn too_broad(env: &Env, dir: &Path) -> Option<&'static str> {
    if dir.parent().is_none() {
        return Some("it is the top of the disk");
    }
    if dir == Path::new("/Volumes") {
        return Some("it is the folder every disk is mounted in");
    }
    let home = env.home.as_deref().and_then(|home| resolve(home, None));
    if home.is_some_and(|home| home.starts_with(dir)) {
        return Some("it is your home folder, or a folder that holds it");
    }
    if reach(&env.data_dir).is_some_and(|data| data.starts_with(dir) || dir.starts_with(&data)) {
        return Some("it is the app's own data folder, or holds or sits inside it");
    }
    None
}

/// Why a project folder named by an export can't be adopted as the project's code folder, or None when it can. The
/// preview shows the reason and the import asks again at the moment it registers (the webview calls this through
/// `portable_project_folder_checks`), so a tick never overrides it.
pub(super) fn refused_project_folder(env: &Env, raw: &str) -> Option<String> {
    let Some(dir) = resolve(Path::new(raw.trim()), env.home.as_deref()) else {
        return Some("it isn't a folder on this Mac".to_string());
    };
    too_broad(env, &dir).map(|why| format!("{why}, so it can't be a project's folder"))
}

/// `~` and `~/…` are this Mac's home folder.
fn expand(path: &Path, home: Option<&Path>) -> PathBuf {
    let Some(home) = home else {
        return path.to_path_buf();
    };
    let mut parts = path.components();
    match parts.next() {
        Some(Component::Normal(first)) if first == "~" => home.join(parts.as_path()),
        _ => path.to_path_buf(),
    }
}

/// A real folder on this Mac, as a full path with links followed. A relative path is refused (it would be read against
/// whatever folder the app runs in), and so is a path that isn't a folder.
fn resolve(path: &Path, home: Option<&Path>) -> Option<PathBuf> {
    if path.as_os_str().is_empty() {
        return None;
    }
    let expanded = expand(path, home);
    if !expanded.is_absolute() {
        return None;
    }
    let real = crate::fs::canonical(expanded).ok()?;
    real.is_dir().then_some(real)
}

/// Where a path leads: `.` and `..` resolved, then the nearest part that exists with its links followed, then the rest.
/// None when `..` would climb above the root.
fn reach(path: &Path) -> Option<PathBuf> {
    let mut lexical = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                if !lexical.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            other => lexical.push(other.as_os_str()),
        }
    }
    let mut rest = Vec::new();
    let mut base = lexical.as_path();
    loop {
        if let Ok(real) = crate::fs::canonical(base) {
            return Some(rest.iter().rev().fold(real, |acc, part| acc.join(part)));
        }
        let name = base.file_name()?;
        rest.push(name.to_os_string());
        base = base.parent()?;
    }
}
