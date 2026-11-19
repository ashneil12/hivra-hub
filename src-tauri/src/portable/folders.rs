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
    /// The folders of the Monos the app knows (seated here): `<monos home>/<id>` and `<app data>/mono-teams/<id>`, the
    /// ones that exist. A chat in one of these is that Mono's chat. Never built from what is on disk: a folder a file
    /// made (`monos/evil`) is no Mono's.
    mono_folders: Vec<PathBuf>,
    monos_home: PathBuf,
    teams_home: PathBuf,
    /// The folders where an import wrote something a CLI reads as instructions (CLAUDE.md, AGENTS.md, a settings file,
    /// anything in a hidden folder): a chat can't keep one of them, or a folder below one.
    instruction_holders: Vec<PathBuf>,
    memory_root: PathBuf,
    /// The projects the file names: its id and folder, and this Mac's folder for it when there is one.
    folder_map: Vec<ProjectMapping>,
    /// Per project: the linked working copies git lists for it (never the main one), when git agrees the project is the
    /// top of its own repository. Read when a chat names a worktree.
    worktrees: OnceCell<Vec<(PathBuf, Vec<PathBuf>)>>,
}

/// A project the file names: its id and folder, and this Mac's folder for the same id (blank when it has none here yet).
#[derive(Clone, Debug)]
pub(super) struct ProjectMapping {
    pub id: String,
    pub from: String,
    pub to: String,
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
    /// What the file named (mapped to this Mac's own folder by project or Mono id when it can be), kept only as an
    /// inert note for a re-link offer: nothing runs from it.
    pub named_cwd: Option<String>,
    pub named_worktree: Option<String>,
    /// The named folder has something this import wrote that a CLI would read as instructions: never offered back.
    pub named_blocked: bool,
    /// The project the named folder belonged to in the file, and the path below its folder: lets a relink map it through
    /// the project record as it is then (the project may only get its folder here later).
    pub named_project: Option<(String, String)>,
    /// The project (or Mono) folder the kept folder sits in: what "Relink all" groups by.
    pub group: Option<String>,
}

/// How a name is compared wherever two spellings may be one file: NFKD (U+017F, the long s, and the compatibility forms
/// become their plain letters), then upper- and lower-cased (a case-insensitive disk keeps one file under every case),
/// with trailing dots and spaces dropped (Windows reads `AGENTS.md.` as `AGENTS.md`). The one rule every name check in
/// the portable code uses, and the rule the shared agent-config list follows.
pub(super) fn fold_name(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let decomposed: String = name.nfkd().collect();
    decomposed
        .to_uppercase()
        .to_lowercase()
        .replace('\u{17F}', "s")
        .trim_end_matches(['.', ' '])
        .to_string()
}

/// Files a CLI reads as instructions, rules, settings or tool servers from the folder it starts in and the folders above
/// it (Claude Code, Codex, Gemini, OpenCode, Cursor, Windsurf, Cline, Copilot, Qwen, Hermes, Grok, Crush, AGENT.md). A
/// deny-list, used only to decide where a written file is read from: what an import may write is an allow-list
/// (`memory_note_file`). Compared folded (`fold_name`). SOUL.md is left out on purpose: a Mono's own soul is restored
/// under that name, and holding it would break soul restore.
pub(super) fn instruction_file(name: &str) -> bool {
    matches!(
        fold_name(name).as_str(),
        "claude.md"
            | "claude.local.md"
            | "agents.md"
            | "agent.md"
            | "agents.override.md"
            | "gemini.md"
            | "qwen.md"
            | "codex.md"
            | "hermes.md"
            | "grok.md"
            | "crush.md"
            | "copilot-instructions.md"
            | "settings.json"
            | "settings.local.json"
            | "mcp.json"
            | ".mcp.json"
            | "opencode.json"
            | "opencode.jsonc"
            | "config.toml"
            | "hooks.json"
            | ".cursorrules"
            | ".windsurfrules"
            | ".clinerules"
            | ".aider.conf.yml"
    )
}

/// A file a memory import may write anywhere: a note (`.md`), never a file a CLI reads as instructions, nothing in a
/// hidden folder. `relative` is the path inside the memory folder.
pub(super) fn memory_note_file(relative: &Path) -> bool {
    let notes = relative
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
    let plain_names = relative.components().all(|part| match part {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            !name.starts_with('.') && !instruction_file(&name)
        }
        _ => false,
    });
    notes && plain_names
}

fn note_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_'))
}

/// What a Mono's folder may be given by an import, by the names `mono.rs` itself uses: `MEMORY.md` at the Monos home,
/// `<id>/SOUL.md`, `<id>/MEMORY.md`, `<id>/soul-template.md`, and notes (`.md`) under `<id>/memory/` or `<id>/skills/`,
/// nested as deep as the folder goes. `relative` is the path inside the Monos home.
pub(super) fn mono_folder_file(relative: &Path) -> bool {
    let parts: Vec<String> = relative
        .components()
        .map(|part| match part {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Option<_>>()
        .unwrap_or_default();
    match parts.as_slice() {
        [file] => file == "MEMORY.md",
        [id, file] => {
            plain_id(id) && matches!(file.as_str(), "SOUL.md" | "MEMORY.md" | "soul-template.md")
        }
        [id, dir, rest @ ..] => match rest.split_last() {
            Some((last, folders)) => {
                plain_id(id)
                    && matches!(dir.as_str(), "memory" | "skills")
                    && folders.iter().all(|folder| note_name(folder))
                    && memory_note_file(Path::new(last))
                    && note_name(last)
            }
            None => false,
        },
        _ => false,
    }
}

/// A file a CLI reads as instructions, rules or settings, at a plain path (no hidden part, in any folder): a memory import
/// keeps such a file beside its original for Ash to review, never under its own name. `relative` is inside the memory
/// folder.
pub(super) fn instruction_file_at(relative: &Path) -> bool {
    let plain_path = relative.components().all(|part| match part {
        Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
        _ => false,
    });
    plain_path
        && relative
            .file_name()
            .is_some_and(|name| instruction_file(&name.to_string_lossy()))
}

/// An instruction file inside the Monos home that an import may hold beside its original for review. Only a Mono's own
/// place takes one: the id folder (`<id>/CLAUDE.md`) and the `memory` and `skills` notes under it, nested as deep as the
/// folder goes. Anywhere else (the Monos home itself, another depth, a hidden folder) it is refused. `relative` is inside
/// the Monos home.
pub(super) fn instruction_file_for_review(relative: &Path) -> bool {
    let parts: Vec<String> = relative
        .components()
        .map(|part| match part {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Option<_>>()
        .unwrap_or_default();
    let Some((file, folders)) = parts.split_last() else {
        return false;
    };
    if !instruction_file(file) {
        return false;
    }
    match folders {
        [] => false,
        [id] => plain_id(id),
        [id, dir, rest @ ..] => {
            plain_id(id)
                && matches!(dir.as_str(), "memory" | "skills")
                && rest.iter().all(|folder| note_name(folder))
        }
    }
}

/// A hidden entry a folder may hold without a CLI reading instructions from it (compared folded): git's own files,
/// `.gitignore`, the Finder's `.DS_Store`, and the environment and virtualenv files of a project. Only a plain ASCII name
/// with no trailing dot or space counts: on Windows `.git.` is git's folder, so any other spelling is held back.
fn harmless_hidden(name: &str) -> bool {
    if !name.is_ascii() || name.ends_with(['.', ' ']) {
        return false;
    }
    let key = fold_name(name);
    matches!(
        key.as_str(),
        ".git" | ".gitignore" | ".ds_store" | ".env" | ".venv"
    ) || key.starts_with(".env.")
}

fn plain_id(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl FolderRules {
    /// `record` and `extra` are folders that vouch for chats: the app's own project record (read by the caller) and the
    /// folders the window lists as projects (the rail's). Each must pass the same test as a chat's folder.
    pub(super) fn load(
        env: &Env,
        record: &[String],
        extra: &[String],
        known_monos: &[String],
        folder_map: &[ProjectMapping],
    ) -> Self {
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
        let mono_folders = known_monos
            .iter()
            .filter(|id| plain_id(id))
            .flat_map(|id| [monos_home.join(id), teams_home.join(id)])
            .filter_map(|dir| resolve(&dir, None))
            .collect();
        Self {
            home: guard.home.clone(),
            guard,
            projects,
            mono_folders,
            monos_home,
            teams_home,
            instruction_holders: Vec::new(),
            memory_root: reach(&env.memory_root).unwrap_or_else(|| env.memory_root.clone()),
            folder_map: folder_map.to_vec(),
            worktrees: OnceCell::new(),
        }
    }

    /// Files the import wrote so far (memory files, a restored history): where each is read as instructions from.
    pub(super) fn note_written(&mut self, files: &[PathBuf]) {
        for file in files.iter().filter_map(|file| reach(file)) {
            if let Some(holder) = self.instruction_holder(&file) {
                self.instruction_holders.push(holder);
            }
        }
    }

    /// The folder a CLI reads this written file from, when it reads it as instructions: the folder holding it for a file
    /// named like one (CLAUDE.md, AGENTS.override.md ...), and for anything in a hidden folder below the memory root
    /// (`lead/.claude/hooks/x.json`) the folder that holds the deepest such hidden folder. A note is read from nowhere.
    fn instruction_holder(&self, file: &Path) -> Option<PathBuf> {
        let parent = file.parent()?;
        let name = file.file_name()?.to_string_lossy().into_owned();
        // The shallowest hidden folder below the memory root (a slot's own hidden parent isn't one): a CLI started in the
        // folder that holds it reads everything inside it.
        let mut outer = None;
        if let Ok(below) = parent.strip_prefix(&self.memory_root) {
            let mut walked = self.memory_root.clone();
            for part in below.components() {
                let hidden =
                    matches!(part, Component::Normal(n) if n.to_string_lossy().starts_with('.'));
                if hidden && outer.is_none() {
                    outer = Some(walked.clone());
                }
                walked.push(part.as_os_str());
            }
        }
        outer.or_else(|| instruction_file(&name).then(|| parent.to_path_buf()))
    }

    fn resolve(&self, raw: &str) -> Option<PathBuf> {
        resolve(Path::new(raw), self.home.as_deref())
    }

    /// An instruction file this import wrote sits in this folder or above it (so a CLI started here would read it).
    /// Notes written beside it, and folders that merely hold a written file further down, don't count.
    fn reads_written_instructions(&self, dir: &Path) -> bool {
        self.instruction_holders
            .iter()
            .any(|holder| dir.starts_with(holder))
    }

    /// A project's folder in the file that can stand for a project: a full path with at least three parts (so never `/`,
    /// `/Users`, a home folder or anything shallower than one), and not this Mac's own home folder.
    fn plausible_from(&self, from: &str) -> bool {
        let path = Path::new(from.trim());
        // Rooted, not `is_absolute`: the folder is the other computer's, so on Windows a Mac's `/Users/...` (no drive)
        // is still a full path there. It only ever matches the start of a file's folder; what it maps to is checked here.
        path.has_root()
            && path
                .components()
                .filter(|part| matches!(part, Component::Normal(_)))
                .count()
                >= 3
            && self.home.as_deref() != Some(path)
    }

    /// The project a file's folder belongs to: its id, the file's folder for it, and the path below that folder. The
    /// project whose folder is the deepest match; only that project's pair ever applies to the folder.
    fn project_of(&self, raw: &str) -> Option<(&ProjectMapping, PathBuf)> {
        let raw = Path::new(raw.trim());
        self.folder_map
            .iter()
            .filter(|pair| self.plausible_from(&pair.from))
            .filter_map(|pair| {
                let rest = raw.strip_prefix(Path::new(pair.from.trim())).ok()?;
                Some((pair, rest.to_path_buf()))
            })
            .max_by_key(|(pair, _)| Path::new(pair.from.trim()).components().count())
    }

    /// This Mac's folder for the project a file's folder belongs to, by project id, when it has one here.
    fn remap_project(&self, raw: &str) -> Option<String> {
        let (pair, rest) = self.project_of(raw)?;
        (!pair.to.trim().is_empty()).then(|| {
            PathBuf::from(pair.to.trim())
                .join(rest)
                .to_string_lossy()
                .into_owned()
        })
    }

    /// What this Mac makes of a folder a file named: its Mono's or its project's own folder for that id, else as written.
    fn mapped(&self, raw: &str) -> String {
        self.remap_mono(raw)
            .map(|dir| dir.to_string_lossy().into_owned())
            .or_else(|| self.remap_project(raw))
            .unwrap_or_else(|| raw.to_string())
    }

    /// This folder is a Mono's own.
    pub(super) fn is_mono_folder(&self, dir: &Path) -> bool {
        self.mono_folders.iter().any(|mono| mono == dir)
    }

    /// Whether a folder may be offered back, judged from disk when a re-link is offered: held back when a file a CLI
    /// reads as instructions sits in this folder or in a folder above it up to its Mono's folder (inclusive), when any
    /// hidden entry sits there that is not on the short list of harmless ones (`harmless_hidden`, compared lowercased,
    /// so `.agents`, `.Claude` and any other tool's folder count), or when any entry there is a link.
    pub(super) fn instructions_on_disk(&self, dir: &Path, top: &Path) -> bool {
        let mut here = Some(dir);
        while let Some(folder) = here {
            if let Ok(entries) = std::fs::read_dir(folder) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    // A link could point anywhere, and an unreadable entry is not known to be harmless.
                    let link = entry.file_type().map_or(true, |kind| kind.is_symlink());
                    let hidden_unknown = name.starts_with('.') && !harmless_hidden(&name);
                    if instruction_file(&name) || hidden_unknown || link {
                        return true;
                    }
                }
            }
            if folder == top || !folder.starts_with(top) {
                break;
            }
            here = folder.parent();
        }
        false
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
    fn judge(&self, raw: &str) -> Option<(PathBuf, Option<PathBuf>, PathBuf)> {
        if let Some(dir) = self.remap_mono(raw) {
            return (!self.reads_written_instructions(&dir)).then(|| (dir.clone(), None, dir));
        }
        let mapped = self.remap_project(raw);
        let dir = self.resolve(mapped.as_deref().unwrap_or(raw))?;
        if self.reads_written_instructions(&dir) {
            return None;
        }
        if let Some(mono) = self.mono_folder_of(&dir) {
            // Inside a Mono's folder: nothing hidden below it.
            let hidden = dir.strip_prefix(mono).ok()?.components().any(|part| {
                matches!(part, Component::Normal(name) if name.to_string_lossy().starts_with('.'))
            });
            return (!hidden).then(|| (dir.clone(), None, mono.clone()));
        }
        self.guard.allowed(&dir).ok()?;
        let project = self
            .projects
            .iter()
            .filter(|project| dir.starts_with(project))
            .max_by_key(|project| project.components().count())?;
        Some((dir.clone(), Some(project.clone()), project.clone()))
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
        if self.reads_written_instructions(&dir) {
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
            named_cwd: cwd.map(|raw| self.mapped(raw)),
            named_worktree: worktree.map(str::to_string),
            named_blocked: cwd.is_some_and(|raw| self.names_written_instructions(raw)),
            named_project: cwd.and_then(|raw| {
                self.project_of(raw)
                    .map(|(pair, rest)| (pair.id.clone(), rest.to_string_lossy().into_owned()))
            }),
            group: None,
        };
        let Some((kept, project, group)) = cwd.and_then(|raw| self.judge(raw)) else {
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
            named_cwd: cleared.then(|| cwd.map(|raw| self.mapped(raw))).flatten(),
            named_worktree: cleared.then(|| worktree.map(str::to_string)).flatten(),
            named_blocked: false,
            named_project: None,
            group: Some(group.to_string_lossy().into_owned()),
        }
    }

    /// The folder a file named is one where this import wrote something a CLI would read as instructions.
    fn names_written_instructions(&self, raw: &str) -> bool {
        let target = self.mapped(raw);
        let expanded = expand(Path::new(&target), self.home.as_deref());
        expanded.is_absolute()
            && reach(&expanded).is_some_and(|dir| self.reads_written_instructions(&dir))
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

    /// The paths a chat's tool rows and approvals name must stay inside the chat's own folders: they feed the checkpoint
    /// calls (`sessionEditPaths`), and a path from a file is no one's choice. Only tool blocks are touched (a block's
    /// `tool`, and an approval's `call`), wherever the block sits (side threads included); inside them every `paths` list
    /// and `preview.path` is confined whatever its depth (agent steps), and a `paths` that isn't a list is dropped. Any
    /// other `paths` key is not ours to touch. Returns how many paths were dropped.
    pub(super) fn confine_tool_paths(&self, blocks: &mut Value, roots: &[PathBuf]) -> usize {
        let mut dropped = 0;
        self.confine_blocks(blocks, roots, &mut dropped);
        dropped
    }

    fn confine_blocks(&self, value: &mut Value, roots: &[PathBuf], dropped: &mut usize) {
        match value {
            Value::Array(items) => items
                .iter_mut()
                .for_each(|item| self.confine_blocks(item, roots, dropped)),
            Value::Object(map) => {
                if let Some(tool) = map.get_mut("tool") {
                    self.confine_within(tool, roots, dropped);
                }
                if let Some(call) = map
                    .get_mut("approval")
                    .and_then(|approval| approval.get_mut("call"))
                {
                    self.confine_within(call, roots, dropped);
                }
                for (key, item) in map.iter_mut() {
                    if key != "tool" && key != "approval" {
                        self.confine_blocks(item, roots, dropped);
                    }
                }
            }
            _ => {}
        }
    }

    /// Inside a tool or an approval's call: every `paths` and `preview.path`, at any depth.
    fn confine_within(&self, value: &mut Value, roots: &[PathBuf], dropped: &mut usize) {
        match value {
            Value::Array(items) => items
                .iter_mut()
                .for_each(|item| self.confine_within(item, roots, dropped)),
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
                    .for_each(|item| self.confine_within(item, roots, dropped));
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
