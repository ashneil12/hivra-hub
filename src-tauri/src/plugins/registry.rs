//! The plugin registry (WP-30): which plugins are installed, where they came from, where each is enabled (everywhere
//! or per project), and every contribution each one made, each with a disposer that undoes it. Enable, disable and
//! uninstall run the disposers, so nothing is left behind (DeepSeek Harness's disposer pattern, ideas only).
//!
//! On disk, under the host's root (`<app data>/plugins`):
//!
//! ```text
//! registry.json          this registry (gone again once nothing is installed)
//! lock.json              exactly what is installed: name, version, pinned source, a digest of its files (WP-31)
//! installed/<name>/      the plugin's own files, copied in
//! previous/<name>/       the version an update replaced, kept for one-step rollback (WP-31)
//! pending/<id>/          an install waiting for the person's OK (WP-31, install.rs)
//! data/<name>/           its PLUGIN_DATA folder (Agent Plugins §9.1)
//! claude/<name>/         a Claude Code plugin holding only the skills (`--plugin-dir`, see wiring.rs)
//! ```
//!
//! and, while a plugin is enabled everywhere, one link per skill in the host's `agents_skills` folder
//! (`~/.agents/skills` for the daily app, which Codex and the other `.agents` readers scan).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::fsutil;
use super::manifest::{load_plugin, LoadedPlugin, Report};

const REGISTRY_FILE: &str = "registry.json";
const REGISTRY_VERSION: u32 = 1;

/// Where this copy of the app keeps plugins.
#[derive(Clone, Debug)]
pub struct Host {
    pub root: PathBuf,
    /// The user-wide skills folder skills are linked into while a plugin is enabled everywhere.
    pub agents_skills: PathBuf,
}

impl Host {
    pub fn installed(&self, name: &str) -> PathBuf {
        self.root.join("installed").join(name)
    }
    pub fn data(&self, name: &str) -> PathBuf {
        self.root.join("data").join(name)
    }
    pub fn claude_shim(&self, name: &str) -> PathBuf {
        self.root.join("claude").join(name)
    }
    /// The version an update replaced (WP-31).
    pub fn previous(&self, name: &str) -> PathBuf {
        self.root.join("previous").join(name)
    }
    /// Installs waiting for the person's OK (WP-31).
    pub fn pending(&self) -> PathBuf {
        self.root.join("pending")
    }
    /// Where a swap puts what it replaces until it has finished (WP-31).
    pub fn trash(&self) -> PathBuf {
        self.root.join(".trash")
    }
}

/// The app database beside the plugin folder (`<data>/plugins` → `<data>/monocode.db`).
/// Missing is fine: the activity note does not create it.
pub(crate) fn activity_db(host: &Host) -> PathBuf {
    match host.root.parent() {
        Some(data) => data.join("monocode.db"),
        None => PathBuf::new(),
    }
}

/// Where a plugin came from: a local folder (WP-30), or a git commit or npm version (WP-31, source.rs).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// `local`, `git`, `npm` or `bundled`.
    pub kind: String,
    pub location: String,
    /// The exact commit or version, when the source has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<String>,
    /// The tag a git pin was resolved from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// The plugin's folder inside a git repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The npm registry it came from, when not the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry: Option<String>,
}

impl Source {
    pub fn local(path: &Path) -> Self {
        Self {
            kind: "local".into(),
            location: path.to_string_lossy().into_owned(),
            pin: None,
            tag: None,
            path: None,
            registry: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Enablement {
    pub global: bool,
    /// Project folders it is enabled in (as given; compared resolved).
    pub projects: Vec<String>,
}

impl Enablement {
    pub fn any(&self) -> bool {
        self.global || !self.projects.is_empty()
    }
}

/// One thing a plugin added. Files and links are undone on disk; the rest are records the app reads (sessions'
/// MCP config, panels, personas…), undone by dropping the record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Contribution {
    /// The plugin's copied files.
    Files {
        path: String,
    },
    /// Its PLUGIN_DATA folder.
    Data {
        path: String,
    },
    /// The Claude Code plugin made for its skills.
    ClaudeShim {
        path: String,
    },
    /// A link to one of its skills in the user-wide skills folder.
    SkillLink {
        skill: String,
        path: String,
        target: String,
    },
    Skill {
        name: String,
    },
    McpServer {
        name: String,
    },
    Panel {
        id: String,
    },
    Persona {
        id: String,
    },
    MonoTemplate {
        id: String,
    },
    CrewRules {
        count: usize,
    },
    Command {
        name: String,
    },
}

impl Contribution {
    /// Undo this contribution. Files and links are removed only when they are still what was made: a link someone
    /// re-pointed, or a folder that is no longer where it was, is left alone. A recorded path outside the host's own
    /// folders (a registry edited by hand, say) is refused, never removed.
    pub fn dispose(&self, host: &Host) -> Result<(), String> {
        match self {
            Contribution::Files { path }
            | Contribution::Data { path }
            | Contribution::ClaudeShim { path } => {
                let path = Path::new(path);
                if !strictly_inside(path, &host.root) {
                    return Err(format!(
                        "{} isn't in the plugin folder, so it was left alone.",
                        path.display()
                    ));
                }
                fsutil::remove_tree(path)
            }
            Contribution::SkillLink { path, target, .. } => {
                let path = Path::new(path);
                if path.parent() != Some(host.agents_skills.as_path())
                    || !strictly_inside(path, &host.agents_skills)
                {
                    return Err(format!(
                        "{} isn't in the skills folder, so it was left alone.",
                        path.display()
                    ));
                }
                fsutil::remove_link_if_points_to(path, Path::new(target))
            }
            Contribution::Skill { .. }
            | Contribution::McpServer { .. }
            | Contribution::Panel { .. }
            | Contribution::Persona { .. }
            | Contribution::MonoTemplate { .. }
            | Contribution::CrewRules { .. }
            | Contribution::Command { .. } => Ok(()),
        }
    }

    fn lasts_while_installed(&self) -> bool {
        matches!(self, Contribution::Files { .. } | Contribution::Data { .. })
    }
}

/// `path` lies below `dir` (not `dir` itself) and has no `..` in it.
fn strictly_inside(path: &Path, dir: &Path) -> bool {
    path != dir
        && path.starts_with(dir)
        && !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
}

/// A project folder as the registry keeps it: absolute, links resolved. An empty or relative path is refused, since
/// it would match nothing (or, worse, everything).
pub fn project_key(project: &str) -> Result<String, String> {
    let path = Path::new(project);
    if project.trim().is_empty() || !path.is_absolute() {
        return Err(format!(
            "\"{project}\" isn't a project folder (it needs a full path)."
        ));
    }
    Ok(fsutil::display(&fsutil::resolved(path)))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    pub source: Source,
    pub installed_at_ms: u64,
    #[serde(default)]
    pub enabled: Enablement,
    /// In the order they were made; disposed in reverse.
    #[serde(default)]
    pub contributions: Vec<Contribution>,
    /// A digest of the installed files (`fsutil::tree_digest`), as the lock file records it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    /// The version an update replaced, whose files are in `previous/<name>` (WP-31).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<Box<Snapshot>>,
}

/// What rollback puts back: the replaced version's own facts (its files are in `previous/<name>`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    pub version: Option<String>,
    pub source: Source,
    pub installed_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
}

impl Snapshot {
    pub fn of(entry: &Entry) -> Self {
        Self {
            version: entry.version.clone(),
            source: entry.source.clone(),
            installed_at_ms: entry.installed_at_ms,
            integrity: entry.integrity.clone(),
        }
    }
}

impl Entry {
    /// Whether it is on for a session working in `cwd` (everywhere, or a project folder that holds `cwd`).
    pub fn active_for(&self, cwd: Option<&Path>) -> bool {
        self.enabled.global || cwd.is_some_and(|cwd| self.project_match(cwd))
    }

    fn project_match(&self, cwd: &Path) -> bool {
        if !cwd.is_absolute() {
            return false;
        }
        let cwd = fsutil::resolved(cwd);
        self.enabled.projects.iter().any(|project| {
            let project = Path::new(project);
            project.is_absolute() && cwd.starts_with(fsutil::resolved(project))
        })
    }

    pub fn mcp_servers(&self) -> impl Iterator<Item = &str> {
        self.contributions.iter().filter_map(|c| match c {
            Contribution::McpServer { name } => Some(name.as_str()),
            _ => None,
        })
    }

    pub fn skills(&self) -> impl Iterator<Item = &str> {
        self.contributions.iter().filter_map(|c| match c {
            Contribution::Skill { name } => Some(name.as_str()),
            _ => None,
        })
    }

    pub fn claude_shim(&self) -> Option<&str> {
        self.contributions.iter().find_map(|c| match c {
            Contribution::ClaudeShim { path } => Some(path.as_str()),
            _ => None,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u32,
    pub plugins: BTreeMap<String, Entry>,
    /// Folders the registry made outside its root (the user-wide skills folder when it didn't exist), removed again
    /// once empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub created_dirs: Vec<String>,
}

/// What an operation did, plus anything skipped on the way.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub entry: Option<Entry>,
    pub reports: Vec<Report>,
}

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Held for any read-change-write of the registry (install.rs takes it too).
pub(super) fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

const LOCK_FILE: &str = "lock.json";

/// The lock file: exactly what is installed, nothing that changes on its own (no times, no switches), so two installs
/// of the same thing write the same bytes.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockFile {
    pub version: u32,
    pub plugins: BTreeMap<String, Locked>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Locked {
    #[serde(default)]
    pub version: Option<String>,
    pub source: Source,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
}

pub fn read_lock(host: &Host) -> Result<LockFile, String> {
    match std::fs::read_to_string(host.root.join(LOCK_FILE)) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("lock.json can't be read: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LockFile {
            version: REGISTRY_VERSION,
            ..LockFile::default()
        }),
        Err(e) => Err(format!("lock.json can't be read: {e}")),
    }
}

pub fn read(host: &Host) -> Result<Registry, String> {
    let path = host.root.join(REGISTRY_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let registry: Registry = serde_json::from_str(&text)
                .map_err(|e| format!("The plugin registry can't be read: {e}"))?;
            if registry.version > REGISTRY_VERSION {
                return Err("The plugin registry was written by a newer Hivra.".into());
            }
            Ok(registry)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Registry {
            version: REGISTRY_VERSION,
            ..Registry::default()
        }),
        Err(e) => Err(format!("The plugin registry can't be read: {e}")),
    }
}

pub(super) fn write(host: &Host, registry: &mut Registry) -> Result<(), String> {
    registry.version = REGISTRY_VERSION;
    // Only folders on the way to the skills folder were ever recorded; anything else is dropped, not removed.
    let skills = host.agents_skills.clone();
    registry.created_dirs.retain(|dir| {
        let dir = Path::new(dir);
        skills.starts_with(dir) && !fsutil::remove_dir_if_empty(dir)
    });
    for sub in [
        "installed",
        "data",
        "claude",
        "agents-skills",
        "previous",
        "pending",
        ".trash",
    ] {
        fsutil::remove_dir_if_empty(&host.root.join(sub));
    }
    let path = host.root.join(REGISTRY_FILE);
    let lock_path = host.root.join(LOCK_FILE);
    let remove = |path: &Path| match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    };
    if registry.plugins.is_empty() {
        remove(&lock_path)?;
    }
    if registry.plugins.is_empty() && registry.created_dirs.is_empty() {
        return remove(&path);
    }
    std::fs::create_dir_all(&host.root).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    fsutil::write_atomic(&path, text.as_bytes())?;
    if registry.plugins.is_empty() {
        return Ok(());
    }
    let lock = LockFile {
        version: REGISTRY_VERSION,
        plugins: registry
            .plugins
            .values()
            .map(|entry| {
                (
                    entry.name.clone(),
                    Locked {
                        version: entry.version.clone(),
                        source: entry.source.clone(),
                        integrity: entry.integrity.clone(),
                    },
                )
            })
            .collect(),
    };
    let text = serde_json::to_string_pretty(&lock).map_err(|e| e.to_string())?;
    fsutil::write_atomic(&lock_path, format!("{text}\n").as_bytes())
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Copy a plugin folder in and register it, switched off. The folder is validated first; nothing is written unless
/// it loads, and a failure part way removes what was made.
pub fn install_local(host: &Host, source_dir: &Path, source: Source) -> Result<Outcome, String> {
    let _guard = lock();
    let checked = load_plugin(source_dir).map_err(|e| e.0)?;
    let name = checked.manifest.name.clone();
    if read(host)?.plugins.contains_key(&name) {
        return Err(format!("\"{name}\" is already installed."));
    }
    let staging = host
        .root
        .join("installed")
        .join(format!(".staging-{}", uuid::Uuid::new_v4()));
    // WP-101: a folder picked by hand gets the same read as a downloaded one, and the own-folder scan runs before the
    // copy so a link out of the plugin is refused with a reason rather than silently left out of the copy.
    let links = super::scan::scan_source(&checked.root, &staging);
    if links
        .iter()
        .any(|f| f.severity == super::scan::Severity::Block)
    {
        let blocked = super::scan::ScanResult {
            blocked: true,
            findings: links,
            ..super::scan::ScanResult::default()
        };
        return Err(format!(
            "\"{name}\" didn't pass the install check: {}",
            super::scan::blocking_reason(&blocked)
        ));
    }
    if let Err(why) = fsutil::copy_plugin_tree(&checked.root, &staging) {
        let _ = fsutil::remove_tree(&staging);
        return Err(why);
    }
    let scanned = super::scan::scan_untrusted(&staging);
    if scanned.blocked {
        let _ = fsutil::remove_tree(&staging);
        return Err(format!(
            "\"{name}\" didn't pass the install check: {}",
            super::scan::blocking_reason(&scanned)
        ));
    }
    match install_staged(host, &staging, source) {
        Ok(outcome) => {
            // WP-78: the files are in place. The person asked; the app put them there.
            crate::activity::note_db(
                &activity_db(host),
                crate::activity::PLUGIN_INSTALL,
                &crate::activity::Who::app(),
                &crate::activity::Who::person(),
                "",
                &name,
                &format!("Installed {name}."),
                "",
            );
            Ok(outcome)
        }
        Err(why) => Err(why),
    }
}

/// Move a staged copy (already validated, inside the plugin folder) into place and register it, switched off. The
/// caller holds `lock()`. On failure nothing is left: the staged copy is removed too.
pub(super) fn install_staged(
    host: &Host,
    staging: &Path,
    source: Source,
) -> Result<Outcome, String> {
    let undo = |paths: &[&Path]| {
        for path in paths {
            let _ = fsutil::remove_tree(path);
        }
    };
    let checked = match load_plugin(staging) {
        Ok(checked) => checked,
        Err(why) => {
            undo(&[staging]);
            return Err(why.0);
        }
    };
    let name = checked.manifest.name.clone();
    let mut registry = match read(host) {
        Ok(registry) => registry,
        Err(why) => {
            undo(&[staging]);
            return Err(why);
        }
    };
    if registry.plugins.contains_key(&name) {
        undo(&[staging]);
        return Err(format!("\"{name}\" is already installed."));
    }
    let target = host.installed(&name);
    if std::fs::symlink_metadata(&target).is_ok() {
        // Not in the registry, so an install that stopped part way left it: it is the registry's own to clear.
        if let Err(why) = fsutil::remove_tree(&target) {
            undo(&[staging]);
            return Err(format!(
                "An unfinished install of \"{name}\" is in the way and couldn't be cleared: {why}"
            ));
        }
    }
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::rename(staging, &target) {
        undo(&[staging]);
        return Err(format!("The plugin couldn't be put in place: {e}"));
    }
    let loaded = match load_plugin(&target) {
        Ok(loaded) => loaded,
        Err(why) => {
            undo(&[&target]);
            return Err(why.0);
        }
    };
    let data = host.data(&name);
    if let Err(e) = std::fs::create_dir_all(&data) {
        undo(&[&target]);
        return Err(format!("The plugin's data folder couldn't be made: {e}"));
    }
    let entry = Entry {
        name: name.clone(),
        version: loaded.manifest.version.clone(),
        source,
        installed_at_ms: now_ms(),
        enabled: Enablement::default(),
        integrity: Some(fsutil::tree_digest(&target)),
        previous: None,
        contributions: vec![
            Contribution::Files {
                path: fsutil::display(&target),
            },
            Contribution::Data {
                path: fsutil::display(&data),
            },
        ],
    };
    registry.plugins.insert(name.clone(), entry.clone());
    if let Err(why) = write(host, &mut registry) {
        undo(&[&target, &data]);
        return Err(why);
    }
    Ok(Outcome {
        entry: Some(entry),
        reports: loaded.reports,
    })
}

/// Everywhere, or one project folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Global,
    Project(String),
}

pub fn enable(host: &Host, name: &str, scope: &Scope) -> Result<Outcome, String> {
    let _guard = lock();
    let mut registry = read(host)?;
    let entry = registry
        .plugins
        .get(name)
        .cloned()
        .ok_or_else(|| format!("\"{name}\" isn't installed."))?;
    let loaded = load_plugin(&host.installed(name)).map_err(|e| e.0)?;
    let mut entry = entry;
    let mut reports = loaded.reports.clone();
    let was_active = entry.enabled.any();
    let was_global = entry.enabled.global;
    match scope {
        Scope::Global => entry.enabled.global = true,
        Scope::Project(project) => {
            let project = project_key(project)?;
            if !entry.enabled.projects.contains(&project) {
                entry.enabled.projects.push(project);
            }
        }
    }
    let mut made = Vec::new();
    let result = (|| -> Result<(), String> {
        if !was_active {
            made.extend(activate(host, &loaded)?);
        }
        if entry.enabled.global && !was_global {
            made.extend(link_skills(
                host,
                &loaded,
                &mut registry.created_dirs,
                &mut reports,
            )?);
        }
        Ok(())
    })();
    if let Err(why) = result {
        dispose_all(host, made.iter().rev());
        let _ = write(host, &mut registry);
        return Err(why);
    }
    let before = registry.plugins.get(name).cloned();
    let mut updated = entry.clone();
    updated.contributions.extend(made.iter().cloned());
    registry.plugins.insert(name.to_string(), updated.clone());
    if let Err(why) = write(host, &mut registry) {
        // Nothing recorded them, so nothing may be left: undo what was just made.
        dispose_all(host, made.iter().rev());
        if let Some(before) = before {
            registry.plugins.insert(name.to_string(), before);
        }
        let _ = write(host, &mut registry);
        return Err(why);
    }
    let entry = updated;
    Ok(Outcome {
        entry: Some(entry),
        reports,
    })
}

/// The contributions a plugin makes while it is on anywhere.
pub(super) fn activate(host: &Host, loaded: &LoadedPlugin) -> Result<Vec<Contribution>, String> {
    let name = &loaded.manifest.name;
    let mut made = Vec::new();
    if !loaded.skills.is_empty() {
        let shim = host.claude_shim(name);
        fsutil::make_claude_shim(&shim, &loaded.root, &loaded.skills, &loaded.manifest)?;
        made.push(Contribution::ClaudeShim {
            path: fsutil::display(&shim),
        });
    }
    made.extend(loaded.skills.iter().map(|s| Contribution::Skill {
        name: s.name.clone(),
    }));
    made.extend(loaded.mcp_servers.iter().map(|s| Contribution::McpServer {
        name: s.name.clone(),
    }));
    let hivra = &loaded.hivra;
    made.extend(
        hivra
            .panels
            .iter()
            .map(|p| Contribution::Panel { id: p.id.clone() }),
    );
    made.extend(
        hivra
            .personas
            .iter()
            .map(|p| Contribution::Persona { id: p.id.clone() }),
    );
    made.extend(
        hivra
            .monos
            .iter()
            .map(|m| Contribution::MonoTemplate { id: m.id.clone() }),
    );
    if !hivra.crew_rules.is_empty() {
        made.push(Contribution::CrewRules {
            count: hivra.crew_rules.len(),
        });
    }
    made.extend(hivra.commands.iter().map(|c| Contribution::Command {
        name: c.name.clone(),
    }));
    Ok(made)
}

/// Link each skill into the user-wide skills folder. A name already taken there by something else is skipped and
/// reported, never replaced.
pub(super) fn link_skills(
    host: &Host,
    loaded: &LoadedPlugin,
    created: &mut Vec<String>,
    reports: &mut Vec<Report>,
) -> Result<Vec<Contribution>, String> {
    if loaded.skills.is_empty() {
        return Ok(Vec::new());
    }
    if !host.agents_skills.exists() {
        // Remember every folder made on the way (deepest first), so each goes again once empty.
        let missing: Vec<PathBuf> = host
            .agents_skills
            .ancestors()
            .take_while(|dir| !dir.exists())
            .map(Path::to_path_buf)
            .collect();
        std::fs::create_dir_all(&host.agents_skills)
            .map_err(|e| format!("The skills folder couldn't be made: {e}"))?;
        for dir in missing {
            let dir = fsutil::display(&dir);
            if !created.contains(&dir) {
                created.push(dir);
            }
        }
    }
    let mut made = Vec::new();
    for skill in &loaded.skills {
        let target = loaded.root.join(&skill.dir);
        let link = host.agents_skills.join(&skill.name);
        if std::fs::symlink_metadata(&link).is_ok() {
            reports.push(Report::new(
                &skill.dir,
                format!(
                    "Not linked for other agents: {} already has a skill called \"{}\".",
                    host.agents_skills.display(),
                    skill.name
                ),
            ));
            continue;
        }
        if let Err(why) = fsutil::link_dir(&target, &link) {
            dispose_all(host, made.iter().rev());
            return Err(why);
        }
        made.push(Contribution::SkillLink {
            skill: skill.name.clone(),
            path: fsutil::display(&link),
            target: fsutil::display(&target),
        });
    }
    Ok(made)
}

pub(super) fn dispose_all<'a>(
    host: &Host,
    contributions: impl Iterator<Item = &'a Contribution>,
) -> Vec<String> {
    contributions
        .filter_map(|c| c.dispose(host).err())
        .collect()
}

pub fn disable(host: &Host, name: &str, scope: &Scope) -> Result<Outcome, String> {
    let _guard = lock();
    let mut registry = read(host)?;
    let mut entry = registry
        .plugins
        .get(name)
        .cloned()
        .ok_or_else(|| format!("\"{name}\" isn't installed."))?;
    match scope {
        Scope::Global => entry.enabled.global = false,
        Scope::Project(project) => {
            let project = project_key(project)?;
            entry.enabled.projects.retain(|p| {
                p != &project && fsutil::display(&fsutil::resolved(Path::new(p))) != project
            });
        }
    }
    let failures = retire(host, &mut entry);
    registry.plugins.insert(name.to_string(), entry.clone());
    write(host, &mut registry)?;
    if !failures.is_empty() {
        return Err(format!(
            "Some of it couldn't be undone: {}",
            failures.join("; ")
        ));
    }
    Ok(Outcome {
        entry: Some(entry),
        reports: Vec::new(),
    })
}

/// Dispose what no longer applies: the skill links once it is off everywhere, the rest once it is off in every
/// scope. Returns what couldn't be undone (those stay recorded so a retry can finish them).
pub(super) fn retire(host: &Host, entry: &mut Entry) -> Vec<String> {
    let global = entry.enabled.global;
    let any = entry.enabled.any();
    let mut failures = Vec::new();
    let mut kept = Vec::new();
    for contribution in std::mem::take(&mut entry.contributions).into_iter().rev() {
        let goes = match contribution {
            Contribution::SkillLink { .. } => !global,
            ref other if other.lasts_while_installed() => false,
            _ => !any,
        };
        if goes {
            if let Err(why) = contribution.dispose(host) {
                failures.push(why);
                kept.push(contribution);
            }
        } else {
            kept.push(contribution);
        }
    }
    kept.reverse();
    entry.contributions = kept;
    failures
}

pub fn uninstall(host: &Host, name: &str) -> Result<Outcome, String> {
    let _guard = lock();
    let mut registry = read(host)?;
    let mut entry = registry
        .plugins
        .remove(name)
        .ok_or_else(|| format!("\"{name}\" isn't installed."))?;
    entry.enabled = Enablement::default();
    let mut failures = retire(host, &mut entry);
    failures.extend(dispose_all(host, entry.contributions.iter().rev()));
    // The version an update replaced goes with it (WP-31).
    if let Err(why) = fsutil::remove_tree(&host.previous(name)) {
        failures.push(why);
    } else {
        entry.previous = None;
    }
    if failures.is_empty() {
        write(host, &mut registry)?;
        // WP-78: only when everything came out. A leftover keeps the plugin listed and writes nothing.
        crate::activity::note_db(
            &activity_db(host),
            crate::activity::PLUGIN_REMOVE,
            &crate::activity::Who::app(),
            &crate::activity::Who::person(),
            "",
            name,
            &format!("Removed {name}."),
            "",
        );
        return Ok(Outcome {
            entry: None,
            reports: Vec::new(),
        });
    }
    // Keep it listed, off, so the leftovers stay known and a second uninstall can finish them.
    registry.plugins.insert(name.to_string(), entry);
    write(host, &mut registry)?;
    Err(format!(
        "Some of it couldn't be removed: {}",
        failures.join("; ")
    ))
}

/// Codex and the other `.agents/skills` readers load a linked skill straight from the plugin's folder, so a skill that
/// stopped passing the check since the plugin was switched on is unlinked when the next session's wiring is built
/// (WP-31, the #10 review): those agents stop seeing it, as Claude's session does. Returns the skills unlinked.
pub(super) fn unlink_skills(
    host: &Host,
    name: &str,
    skills: &[&str],
) -> Result<Vec<String>, String> {
    let _guard = lock();
    let mut registry = read(host)?;
    let Some(entry) = registry.plugins.get_mut(name) else {
        return Ok(Vec::new());
    };
    let mut unlinked = Vec::new();
    let mut failures = Vec::new();
    entry.contributions.retain(|c| match c {
        Contribution::SkillLink { skill, .. } if skills.contains(&skill.as_str()) => {
            match c.dispose(host) {
                Ok(()) => {
                    unlinked.push(skill.clone());
                    false
                }
                Err(why) => {
                    failures.push(why);
                    true
                }
            }
        }
        _ => true,
    });
    if !unlinked.is_empty() {
        write(host, &mut registry)?;
    }
    match failures.is_empty() {
        true => Ok(unlinked),
        false => Err(failures.join("; ")),
    }
}
