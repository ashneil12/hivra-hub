//! Which folders an imported chat or automation may keep (docs/PORTABLE.md, "Folders").
//!
//! An export is a file anyone can write. The agent, git, checkpoints and terminals run in a chat's folder, so a crafted
//! or foreign export that names `~/.claude`, `/System/Volumes/Data` or any other folder would point them there. This is
//! an ALLOW-list, not a deny-list of bad places:
//! - a project's folder, or a chat's folder, must be strictly inside this Mac's home folder (both sides resolved, links
//!   followed, so every alias of a place outside it fails), with no hidden part (`.ssh`, `.claude`, `.git`), not in
//!   `~/Library`, and not the memory root or the app's data folder or a folder holding either;
//! - and a chat's folder must sit inside a project this copy has: the app's record, the folders the project rail lists
//!   (each passing the same test), or the folder of a Mono that was already here before the import wrote anything
//!   (`<monos home>/<id>`, `<app data>/mono-teams/<id>`);
//! - and never in a folder this import itself wrote to (the memory it restored).
//!
//! The rules are loaded before the import writes anything (the Monos' folders are a snapshot of what was here), the
//! window registers the projects the person ticked first, and a project's folder is adopted from the file only when its
//! own tick says so and `refused_project_folder` allows it, so a file can't vouch for its own folders.

use std::cell::OnceCell;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::Env;

/// The places no project or chat folder may be, whatever else is true of it.
struct Guard {
    home: Option<PathBuf>,
    /// The memory root and the app's data folder, resolved as far as they exist.
    held: Vec<PathBuf>,
}

impl Guard {
    fn new(env: &Env) -> Self {
        Self {
            home: env.home.as_deref().and_then(|home| resolve(home, None)),
            held: [&env.memory_root, &env.data_dir]
                .into_iter()
                .filter_map(|dir| reach(dir))
                .collect(),
        }
    }

    /// Why a real folder (resolved) can't be a project's or a chat's folder, or Ok.
    fn allowed(&self, dir: &Path) -> Result<(), &'static str> {
        let Some(home) = &self.home else {
            return Err("this Mac's home folder can't be found");
        };
        let Ok(inside) = dir.strip_prefix(home) else {
            return Err("it isn't inside your home folder");
        };
        if inside.as_os_str().is_empty() {
            return Err("it is your home folder");
        }
        if inside.components().next() == Some(Component::Normal("Library".as_ref())) {
            return Err("it is inside your Library folder");
        }
        if inside.components().any(|part| match part {
            Component::Normal(name) => name.to_string_lossy().starts_with('.'),
            _ => true,
        }) {
            return Err("it is, or is inside, a hidden folder");
        }
        if self
            .held
            .iter()
            .any(|held| dir.starts_with(held) || held.starts_with(dir))
        {
            return Err("it is the app's own data or memory folder, or holds or sits inside one");
        }
        Ok(())
    }
}

pub(super) struct FolderRules {
    guard: Guard,
    home: Option<PathBuf>,
    /// Project folders, resolved, each passing `Guard::allowed`.
    projects: Vec<PathBuf>,
    /// The Monos' own folders that existed before the import wrote anything: `<monos home>/<id>` and
    /// `<app data>/mono-teams/<id>`. A chat in one of these is a Mono's chat.
    mono_folders: Vec<PathBuf>,
    monos_home: PathBuf,
    teams_home: PathBuf,
    /// Folders this import wrote into (the memory it restored): no chat may keep one.
    written: Vec<PathBuf>,
    /// Per project: the linked working copies git lists for it (never the main one), when git agrees the project is the
    /// top of its own repository. Read when a chat names a worktree.
    worktrees: OnceCell<Vec<(PathBuf, Vec<PathBuf>)>>,
}

/// What a chat or automation keeps of the folders its file named.
pub(super) struct Folders {
    /// The folder as this Mac resolves it, or blank.
    pub cwd: String,
    pub worktree: Option<String>,
    /// The folders a chat's own paths must stay inside (its kept folder and kept worktree, resolved).
    pub roots: Vec<PathBuf>,
    /// The file named a folder and it didn't stay.
    pub cleared: bool,
    /// What the file named, kept only as an inert note for a re-link offer (nothing runs from it).
    pub named_cwd: Option<String>,
    pub named_worktree: Option<String>,
}

fn plain_id(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn child_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| plain_id(&entry.file_name().to_string_lossy()))
        .filter_map(|entry| resolve(&entry.path(), None))
        .collect()
}

impl FolderRules {
    /// `record` and `extra` are folders that vouch for chats: the app's own project record (read by the caller) and the
    /// folders the window lists as projects (the rail's). Each must pass the same test as a chat's folder.
    pub(super) fn load(env: &Env, record: &[String], extra: &[String]) -> Self {
        let guard = Guard::new(env);
        let mut projects: Vec<PathBuf> = Vec::new();
        for folder in record.iter().chain(extra) {
            let Some(dir) = resolve(Path::new(folder), env.home.as_deref()) else {
                continue;
            };
            if guard.allowed(&dir).is_ok() && !projects.contains(&dir) {
                projects.push(dir);
            }
        }
        let monos_home = resolve(&env.monos_root, None).unwrap_or_else(|| env.monos_root.clone());
        let teams_home = reach(&env.data_dir.join("mono-teams"))
            .unwrap_or_else(|| env.data_dir.join("mono-teams"));
        let mono_folders = child_dirs(&monos_home)
            .into_iter()
            .chain(child_dirs(&teams_home))
            .collect();
        Self {
            home: guard.home.clone(),
            guard,
            projects,
            mono_folders,
            monos_home,
            teams_home,
            written: Vec::new(),
            worktrees: OnceCell::new(),
        }
    }

    /// Folders the import wrote into so far (memory files, a restored history).
    pub(super) fn note_written(&mut self, dirs: &[PathBuf]) {
        self.written
            .extend(dirs.iter().filter_map(|dir| reach(dir)));
    }

    fn resolve(&self, raw: &str) -> Option<PathBuf> {
        resolve(Path::new(raw), self.home.as_deref())
    }

    fn written_to(&self, dir: &Path) -> bool {
        self.written
            .iter()
            .any(|written| dir.starts_with(written) || written.starts_with(dir))
    }

    /// The Mono folder this one is: `<monos home>/<id>` or `<app data>/mono-teams/<id>`, one that was already here.
    fn mono_folder_of(&self, dir: &Path) -> Option<&PathBuf> {
        self.mono_folders.iter().find(|mono| dir.starts_with(mono))
    }

    /// A file written on another Mac names that Mac's `…/mono-teams/<id>` or `…/monos/<id>`; the same Mono's folder here
    /// is the one meant, when it was here already.
    fn remap_mono(&self, raw: &str) -> Option<PathBuf> {
        let mut parts = Path::new(raw.trim()).components().rev();
        let Some(Component::Normal(id)) = parts.next() else {
            return None;
        };
        let Some(Component::Normal(kind)) = parts.next() else {
            return None;
        };
        let id = id.to_string_lossy();
        if !plain_id(&id) {
            return None;
        }
        let home = match kind.to_string_lossy().as_ref() {
            "mono-teams" => &self.teams_home,
            "monos" => &self.monos_home,
            _ => return None,
        };
        let dir = resolve(&home.join(id.as_ref()), None)?;
        self.mono_folders.contains(&dir).then_some(dir)
    }

    /// The folder stays when it is a real folder that passes the allow-list and sits inside a known project, or is a
    /// Mono's own folder from before the import. Returns it as this Mac resolves it, and the project that holds it.
    fn judge(&self, raw: &str) -> Option<(PathBuf, Option<PathBuf>)> {
        if let Some(dir) = self.remap_mono(raw) {
            return (!self.written_to(&dir)).then_some((dir, None));
        }
        let dir = self.resolve(raw)?;
        if self.written_to(&dir) {
            return None;
        }
        if let Some(mono) = self.mono_folder_of(&dir) {
            // Inside a Mono's folder: nothing hidden below it.
            let hidden = dir.strip_prefix(mono).ok()?.components().any(|part| {
                matches!(part, Component::Normal(name) if name.to_string_lossy().starts_with('.'))
            });
            return (!hidden).then_some((dir, None));
        }
        self.guard.allowed(&dir).ok()?;
        let project = self
            .projects
            .iter()
            .filter(|project| dir.starts_with(project))
            .max_by_key(|project| project.components().count())?;
        Some((dir.clone(), Some(project.clone())))
    }

    /// A linked working copy git lists for this project. The main entry is skipped (it is the project's own folder, or
    /// a parent repository's), and the project must be the top of its own repository: a plain project inside a repo that
    /// holds a bigger folder (a dotfiles repo at `~`) is not vouched for by that repo's worktree list.
    fn linked_worktrees(&self, project: &Path) -> &[PathBuf] {
        let all = self.worktrees.get_or_init(|| {
            self.projects
                .iter()
                .filter_map(|project| {
                    let top = crate::fs::git_cmd()
                        .arg("-C")
                        .arg(project)
                        .args(["rev-parse", "--show-toplevel"])
                        .output()
                        .ok()
                        .filter(|out| out.status.success())
                        .and_then(|out| {
                            resolve(Path::new(String::from_utf8_lossy(&out.stdout).trim()), None)
                        })?;
                    if &top != project {
                        return None;
                    }
                    let linked = crate::worktrees::list(project)
                        .ok()?
                        .into_iter()
                        .filter(|tree| !tree.is_main)
                        .filter_map(|tree| resolve(Path::new(&tree.path), None))
                        .collect();
                    Some((project.clone(), linked))
                })
                .collect()
        });
        all.iter()
            .find(|(owner, _)| owner == project)
            .map(|(_, trees)| trees.as_slice())
            .unwrap_or(&[])
    }

    /// A worktree stays when it is inside the chat's own project, or is a linked working copy git lists for that
    /// project, and passes the allow-list itself.
    fn keeps_worktree(&self, raw: &str, project: &Path) -> Option<PathBuf> {
        let dir = self.resolve(raw)?;
        self.guard.allowed(&dir).ok()?;
        if self.written_to(&dir) {
            return None;
        }
        let ok = dir.starts_with(project)
            || self
                .linked_worktrees(project)
                .iter()
                .any(|tree| dir.starts_with(tree));
        ok.then_some(dir)
    }

    /// What a chat keeps of its folder and its worktree. A worktree is the chat's working copy of its project, so one
    /// with no kept project goes too, and a Mono's folder has none.
    pub(super) fn vet(&self, cwd: Option<&str>, worktree: Option<&str>) -> Folders {
        fn named(value: Option<&str>) -> Option<&str> {
            value.map(str::trim).filter(|v| !v.is_empty())
        }
        let (cwd, worktree) = (named(cwd), named(worktree));
        let none = |cleared| Folders {
            cwd: String::new(),
            worktree: None,
            roots: Vec::new(),
            cleared,
            named_cwd: cwd.map(str::to_string),
            named_worktree: worktree.map(str::to_string),
        };
        let Some((kept, project)) = cwd.and_then(|raw| self.judge(raw)) else {
            return none(cwd.is_some() || worktree.is_some());
        };
        let mut roots = vec![kept.clone()];
        let mut kept_worktree = None;
        let mut cleared = false;
        if let Some(raw) = worktree {
            match project.as_deref().and_then(|p| self.keeps_worktree(raw, p)) {
                Some(dir) => {
                    kept_worktree = Some(dir.to_string_lossy().into_owned());
                    roots.push(dir);
                }
                None => cleared = true,
            }
        }
        Folders {
            cwd: kept.to_string_lossy().into_owned(),
            worktree: kept_worktree,
            roots,
            cleared,
            named_cwd: cleared.then(|| cwd.map(str::to_string)).flatten(),
            named_worktree: cleared.then(|| worktree.map(str::to_string)).flatten(),
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

    /// The paths a chat's tool rows (and approvals, side threads and agent steps) name must stay inside the chat's own
    /// folders: they feed the checkpoint calls (`sessionEditPaths`), and a path from a file is no one's choice. Every
    /// `paths` list and every `preview.path` anywhere in the blocks is confined, whatever its depth; a `paths` that
    /// isn't a list is dropped. Returns how many paths were dropped.
    pub(super) fn confine_tool_paths(&self, blocks: &mut Value, roots: &[PathBuf]) -> usize {
        let mut dropped = 0;
        self.confine_walk(blocks, roots, &mut dropped);
        dropped
    }

    fn confine_walk(&self, value: &mut Value, roots: &[PathBuf], dropped: &mut usize) {
        match value {
            Value::Array(items) => items
                .iter_mut()
                .for_each(|item| self.confine_walk(item, roots, dropped)),
            Value::Object(map) => {
                match map.get_mut("paths") {
                    Some(Value::Array(paths)) => {
                        let before = paths.len();
                        paths.retain(|path| {
                            path.as_str()
                                .is_some_and(|raw| self.path_inside(roots, raw))
                        });
                        *dropped += before - paths.len();
                    }
                    Some(_) => {
                        map.remove("paths");
                        *dropped += 1;
                    }
                    None => {}
                }
                if let Some(Value::Object(preview)) = map.get_mut("preview") {
                    let outside = match preview.get("path") {
                        None | Some(Value::Null) => false,
                        Some(Value::String(raw)) => !self.path_inside(roots, raw),
                        Some(_) => true,
                    };
                    if outside {
                        preview.remove("path");
                        *dropped += 1;
                    }
                }
                map.values_mut()
                    .for_each(|item| self.confine_walk(item, roots, dropped));
            }
            _ => {}
        }
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

/// Why a project folder named by an export can't be adopted as the project's code folder, or None when it can. The
/// preview shows the reason and the import asks again as it registers (the webview calls this through
/// `portable_project_folder_checks`), so a tick never overrides it. It must pass the allow-list (strictly inside the
/// home folder, nothing hidden, not Library, memory or app data) and be a git repository: a folder nobody has put under
/// git is refused, not warned about, because only a repository says where a project begins.
pub(super) fn refused_project_folder(env: &Env, raw: &str) -> Option<String> {
    let Some(dir) = resolve(Path::new(raw.trim()), env.home.as_deref()) else {
        return Some("it isn't a folder on this Mac".to_string());
    };
    if let Err(why) = Guard::new(env).allowed(&dir) {
        return Some(format!("{why}, so it can't be a project's folder"));
    }
    if !dir.join(".git").exists() {
        return Some("it isn't a git repository, so it can't be a project's folder".to_string());
    }
    None
}
