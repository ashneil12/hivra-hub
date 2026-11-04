//! Creator mode (WP-34). DeepSeek Harness's Creator mode is the model (MIT, ideas only): a short skill, install
//! through the existing plugin manager, a server that does not run until the person says yes, and a preview that
//! only the current view can see. The scratch folder, preview, keep, undo and discard steps are Hivra's, on top of
//! WP-30 and WP-31.
//!
//! Not vendored: Harness's Creator mode is a Cordis plugin manager and YAML bundles, and Hivra already has the
//! install path it would wrap.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::{Component, Path, PathBuf};
#[cfg(test)]
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::fsutil;
use super::install::{self, InstallResult, RequestedBy};
use super::manifest::{self, load_plugin, Report};
use super::mcp::{self, Transport};
use super::registry::{self, Host, Scope};
use super::source::{InstallSource, Tools};
use super::wiring::passed_env;

const MAX_FILES: usize = 200;
const MAX_FILE_BYTES: usize = 512 * 1024;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
/// Content-Length framing is not what the probe speaks. The reader below is only for its unit test.
#[cfg(test)]
const MAX_FRAME_BYTES: usize = 1024 * 1024;

static CREATOR: Mutex<()> = Mutex::new(());

#[cfg(test)]
static COMMIT_HOOKS: Mutex<BTreeMap<String, Arc<dyn Fn() + Send + Sync>>> =
    Mutex::new(BTreeMap::new());

fn creator_lock() -> std::sync::MutexGuard<'static, ()> {
    CREATOR.lock().unwrap_or_else(|err| err.into_inner())
}

/// Test hook, called before a preview, keep or undo is recorded, and before undo rolls anything back. The session
/// lock is not held, so the hook can try to discard the session. A late result is not recorded.
#[cfg(test)]
pub(crate) fn testing_before_commit(id: &str, hook: Option<Box<dyn Fn() + Send + Sync>>) {
    let mut hooks = COMMIT_HOOKS.lock().unwrap_or_else(|err| err.into_inner());
    match hook {
        Some(hook) => {
            hooks.insert(id.to_string(), Arc::from(hook));
        }
        None => {
            hooks.remove(id);
        }
    }
}

fn before_commit(id: &str) {
    #[cfg(test)]
    {
        let hook = {
            let hooks = COMMIT_HOOKS.lock().unwrap_or_else(|err| err.into_inner());
            hooks.get(id).cloned()
        };
        if let Some(hook) = hook {
            hook();
        }
    }
    #[cfg(not(test))]
    {
        let _ = id;
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Started,
    Drafted,
    Previewed,
    Kept,
    Undone,
    Discarded,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Drafted => "drafted",
            Self::Previewed => "previewed",
            Self::Kept => "kept",
            Self::Undone => "undone",
            Self::Discarded => "discarded",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    id: String,
    view: String,
    revision: u64,
    phase: Phase,
    plugin: Option<String>,
    expect: String,
    #[serde(default)]
    mcp_approved: bool,
    #[serde(default)]
    pending_install: Option<String>,
    #[serde(default)]
    claim: Option<String>,
    #[serde(default)]
    mcp_note: Option<String>,
    #[serde(default)]
    mcp_tools: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftFile {
    pub path: String,
    pub content: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PanelPreview {
    pub id: String,
    pub title: String,
    pub html: String,
    pub css: String,
    pub js: String,
    pub permissions: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreatorState {
    pub id: String,
    pub view: String,
    pub revision: u64,
    pub phase: String,
    pub plugin: Option<String>,
    pub expect: String,
    pub enabled_globally: bool,
    pub visible_here: bool,
    pub mcp_approved: bool,
    pub mcp_waiting: bool,
    pub script_waiting: bool,
    pub reports: Vec<Report>,
    pub panel: Option<PanelPreview>,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub mcp_tools: Vec<String>,
    pub mcp_note: Option<String>,
}

struct Paths {
    dir: PathBuf,
    scratch: PathBuf,
    file: PathBuf,
}

fn paths(host: &Host, id: &str) -> Result<Paths, String> {
    let parsed = uuid::Uuid::parse_str(id)
        .map_err(|_| "That creator session isn't one Hivra made.".to_string())?;
    let dir = host.root.join("creator").join(parsed.to_string());
    Ok(Paths {
        scratch: dir.join("scratch"),
        file: dir.join("session.json"),
        dir,
    })
}

fn load(host: &Host, id: &str) -> Result<Session, String> {
    let path = paths(host, id)?.file;
    let text = std::fs::read_to_string(&path)
        .map_err(|_| "That creator session isn't one Hivra made.".to_string())?;
    serde_json::from_str(&text).map_err(|_| "That creator session can't be read.".to_string())
}

fn save(host: &Host, session: &Session) -> Result<(), String> {
    let path = paths(host, &session.id)?.file;
    let text = serde_json::to_string_pretty(session).map_err(|err| err.to_string())?;
    fsutil::write_atomic(&path, format!("{text}\n").as_bytes())
}

fn stale() -> String {
    "That draft is out of date. Read it again.".into()
}

fn gone() -> String {
    "That scratch folder is gone.".into()
}

fn busy() -> String {
    "It's already working on that.".into()
}

fn outside() -> String {
    "That path isn't inside the scratch folder.".into()
}

fn check_view(view: &str) -> Result<(), String> {
    if view.is_empty() || view.chars().count() > 64 {
        return Err("That view isn't one Hivra can preview into.".into());
    }
    if !view
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("That view isn't one Hivra can preview into.".into());
    }
    Ok(())
}

fn check_expect(expect: &str) -> Result<(), String> {
    match expect {
        "skill" | "panel" | "persona" | "mono" | "command" => Ok(()),
        _ => {
            Err("Say what to build: a skill, a panel, a persona, a Mono or a slash command.".into())
        }
    }
}

fn plugin_name(session: &Session) -> Result<String, String> {
    let name = session.plugin.as_deref().ok_or("It has no plugin yet.")?;
    if manifest::plugin_name_problem(name).is_some() {
        return Err("That plugin name isn't one Hivra would install.".into());
    }
    Ok(name.to_string())
}

fn new_claim() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn clear_claim(host: &Host, id: &str, claim: &str) {
    let _guard = creator_lock();
    if let Ok(mut session) = load(host, id) {
        release_claim(&mut session, host, claim);
    }
}

/// Drop our claim while the session lock is already held. A discarded session has already cleared it.
fn release_claim(session: &mut Session, host: &Host, claim: &str) {
    if session.claim.as_deref() == Some(claim) {
        session.claim = None;
        let _ = save(host, session);
    }
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// `path` is inside `root` once both exist and links are resolved. A missing path is not inside.
fn strictly_inside(root: &Path, path: &Path) -> bool {
    let Ok(root) = fsutil::canonical(root) else {
        return false;
    };
    let Ok(path) = fsutil::canonical(path) else {
        return false;
    };
    path.starts_with(&root)
}

fn relative_file(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty()
        || rel.contains('\0')
        || rel.contains('\r')
        || rel.contains('\n')
        || rel.contains('\\')
        || rel.contains(':')
        || rel.starts_with('/')
    {
        return Err(outside());
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(outside());
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) if !part.is_empty() => out.push(part),
            _ => return Err(outside()),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(outside());
    }
    Ok(out)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Views {
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    views: BTreeMap<String, Vec<String>>,
}

fn views_path(host: &Host) -> PathBuf {
    host.root.join("creator").join("views.json")
}

fn read_views(host: &Host) -> Result<Views, String> {
    match std::fs::read_to_string(views_path(host)) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Views::default()),
        Err(err) => Err(format!("The view list can't be read: {err}")),
        Ok(text) if text.trim().is_empty() => Ok(Views::default()),
        Ok(text) => {
            serde_json::from_str(&text).map_err(|_| "The view list can't be read.".to_string())
        }
    }
}

fn allow_view(host: &Host, view: &str, name: &str) -> Result<(), String> {
    check_view(view)?;
    if manifest::plugin_name_problem(name).is_some() {
        return Err("That plugin name isn't one Hivra would install.".into());
    }
    let mut views = read_views(host)?;
    let list = views.views.entry(view.to_string()).or_default();
    if !list.iter().any(|item| item == name) {
        list.push(name.to_string());
    }
    views.revision += 1;
    let path = views_path(host);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let text = serde_json::to_string_pretty(&views).map_err(|err| err.to_string())?;
    fsutil::write_atomic(&path, format!("{text}\n").as_bytes())
}

fn view_allows(host: &Host, view: &str, name: &str) -> bool {
    let Ok(views) = read_views(host) else {
        return false;
    };
    views
        .views
        .get(view)
        .is_some_and(|list| list.iter().any(|item| item == name))
}

fn deny_view(host: &Host, view: &str, name: &str) -> Result<(), String> {
    let mut views = read_views(host)?;
    let Some(list) = views.views.get_mut(view) else {
        return Ok(());
    };
    let before = list.len();
    list.retain(|item| item != name);
    if list.len() == before {
        return Ok(());
    }
    if list.is_empty() {
        views.views.remove(view);
    }
    views.revision += 1;
    let text = serde_json::to_string_pretty(&views).map_err(|err| err.to_string())?;
    fsutil::write_atomic(&views_path(host), format!("{text}\n").as_bytes())
}

fn installed_entry(host: &Host, name: &str) -> Option<registry::Entry> {
    registry::read(host)
        .ok()
        .and_then(|registry| registry.plugins.get(name).cloned())
}

fn already_installed(name: &str) -> String {
    format!("\"{name}\" is already installed.")
}

/// A scratch plugin this view may preview. It is not installed. Another view's session is not here.
pub struct ScratchPlugin {
    pub name: String,
    pub root: PathBuf,
}

pub fn scratches_for(host: &Host, view: &str) -> Vec<ScratchPlugin> {
    if check_view(view).is_err() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(host.root.join("creator")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path.join("session.json")) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<Session>(&text) else {
            continue;
        };
        if session.view != view || !matches!(session.phase, Phase::Previewed | Phase::Undone) {
            continue;
        }
        let Some(name) = session.plugin else {
            continue;
        };
        if manifest::plugin_name_problem(&name).is_some() || !view_allows(host, view, &name) {
            continue;
        }
        if installed_entry(host, &name).is_some_and(|entry| entry.enabled.any()) {
            continue;
        }
        let scratch = path.join("scratch");
        if !scratch.is_dir() || is_symlink(&scratch) {
            continue;
        }
        out.push(ScratchPlugin {
            name,
            root: scratch,
        });
    }
    out
}

/// Whether `name` shows in `view`: everywhere once it is kept, and only in the view that previewed it until then.
pub fn visible(host: &Host, view: &str, name: &str) -> bool {
    let Ok(registry) = registry::read(host) else {
        return false;
    };
    if let Some(entry) = registry.plugins.get(name) {
        if entry.enabled.global {
            return true;
        }
        // On for a project: that is not a creator preview, and it is not shown here as one.
        if entry.enabled.any() {
            return false;
        }
    }
    view_allows(host, view, name)
        && scratches_for(host, view)
            .iter()
            .any(|scratch| scratch.name == name)
}

fn read_inside(root: &Path, path: &Path) -> String {
    let Some(path) = manifest::within(root, path).filter(|path| path.is_file()) else {
        return String::new();
    };
    std::fs::read_to_string(path).unwrap_or_default()
}

fn panel_of(loaded: &manifest::LoadedPlugin) -> Option<PanelPreview> {
    let panel = loaded.hivra.panels.first()?;
    let dir = loaded.root.join(&panel.dir);
    Some(PanelPreview {
        id: panel.id.clone(),
        title: panel.title.clone(),
        html: read_inside(&loaded.root, &dir.join("index.html")),
        css: read_inside(&loaded.root, &dir.join("style.css")),
        js: read_inside(&loaded.root, &dir.join("script.js")),
        permissions: panel.permissions.clone(),
    })
}

fn has_expected(loaded: &manifest::LoadedPlugin, expect: &str) -> bool {
    match expect {
        "skill" => !loaded.skills.is_empty(),
        "panel" => !loaded.hivra.panels.is_empty(),
        "persona" => !loaded.hivra.personas.is_empty(),
        "mono" => !loaded.hivra.monos.is_empty(),
        "command" => !loaded.hivra.commands.is_empty(),
        _ => false,
    }
}

fn finish(host: &Host, session: &Session) -> CreatorState {
    let plugin = session
        .plugin
        .clone()
        .filter(|name| manifest::plugin_name_problem(name).is_none());
    let scratch = paths(host, &session.id).ok().map(|paths| paths.scratch);
    let loaded = if session.phase == Phase::Discarded {
        None
    } else {
        scratch
            .as_ref()
            .filter(|path| path.is_dir() && !is_symlink(path))
            .and_then(|path| load_plugin(path).ok())
    };
    let entry = plugin.as_ref().and_then(|name| {
        registry::read(host)
            .ok()
            .and_then(|registry| registry.plugins.get(name).cloned())
    });
    let mcp_servers: Vec<String> = loaded
        .as_ref()
        .map(|loaded| {
            loaded
                .mcp_servers
                .iter()
                .map(|server| server.name.clone())
                .collect()
        })
        .unwrap_or_default();
    let pending = session
        .pending_install
        .as_deref()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .map(|id| host.pending().join(id))
        .is_some_and(|dir| dir.is_dir());
    CreatorState {
        id: session.id.clone(),
        view: session.view.clone(),
        revision: session.revision,
        phase: session.phase.as_str().to_string(),
        plugin: plugin.clone(),
        expect: session.expect.clone(),
        enabled_globally: entry.as_ref().is_some_and(|entry| entry.enabled.global),
        visible_here: plugin
            .as_ref()
            .is_some_and(|name| visible(host, &session.view, name)),
        mcp_approved: session.mcp_approved,
        mcp_waiting: !mcp_servers.is_empty() && !session.mcp_approved,
        script_waiting: pending,
        reports: loaded
            .as_ref()
            .map(|loaded| loaded.reports.clone())
            .unwrap_or_default(),
        panel: loaded.as_ref().and_then(panel_of),
        skills: loaded
            .as_ref()
            .map(|loaded| {
                loaded
                    .skills
                    .iter()
                    .map(|skill| skill.name.clone())
                    .collect()
            })
            .unwrap_or_default(),
        mcp_servers,
        mcp_tools: session.mcp_tools.clone(),
        mcp_note: session.mcp_note.clone(),
    }
}

pub fn load_state(host: &Host, id: &str) -> Result<CreatorState, String> {
    let _guard = creator_lock();
    Ok(finish(host, &load(host, id)?))
}

pub fn start(host: &Host, view: &str, expect: &str) -> Result<CreatorState, String> {
    check_view(view)?;
    check_expect(expect)?;
    let _guard = creator_lock();
    let id = uuid::Uuid::new_v4().to_string();
    let dir = paths(host, &id)?.dir;
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("The scratch folder couldn't be made: {err}"))?;
    let session = Session {
        id,
        view: view.to_string(),
        revision: 1,
        phase: Phase::Started,
        plugin: None,
        expect: expect.to_string(),
        mcp_approved: false,
        pending_install: None,
        claim: None,
        mcp_note: None,
        mcp_tools: Vec::new(),
    };
    save(host, &session)?;
    Ok(finish(host, &session))
}

pub fn draft(
    host: &Host,
    id: &str,
    revision: u64,
    files: &[DraftFile],
) -> Result<CreatorState, String> {
    let _guard = creator_lock();
    let mut session = load(host, id)?;
    if session.revision != revision {
        return Err(stale());
    }
    if session.phase == Phase::Discarded {
        return Err(gone());
    }
    if session.claim.is_some() {
        return Err(busy());
    }
    if !matches!(session.phase, Phase::Started | Phase::Drafted) {
        return Err("It's already installed. Discard it first.".into());
    }
    if files.is_empty() {
        return Err("There's nothing to write.".into());
    }
    if files.len() > MAX_FILES {
        return Err("That's too many files.".into());
    }
    let paths = paths(host, id)?;
    if is_symlink(&paths.scratch) {
        return Err("The scratch folder isn't a real folder.".into());
    }
    let staging = paths.dir.join("staging");
    if let Err(err) = write_staging(&staging, files) {
        let _ = fsutil::remove_tree(&staging);
        return Err(err);
    }
    let loaded = match load_plugin(&staging) {
        Ok(loaded) => loaded,
        Err(err) => {
            let _ = fsutil::remove_tree(&staging);
            return Err(err.0);
        }
    };
    if !has_expected(&loaded, &session.expect) {
        let _ = fsutil::remove_tree(&staging);
        return Err(format!("That draft has no {}.", session.expect));
    }
    if let Err(err) = swap_scratch(&paths.dir, &staging, &paths.scratch) {
        let _ = fsutil::remove_tree(&staging);
        return Err(err);
    }
    session.phase = Phase::Drafted;
    session.plugin = Some(loaded.manifest.name);
    // A new draft is a new server. The earlier OK does not cover it.
    session.mcp_approved = false;
    session.mcp_note = None;
    session.mcp_tools.clear();
    session.revision += 1;
    save(host, &session)?;
    Ok(finish(host, &session))
}

fn write_staging(staging: &Path, files: &[DraftFile]) -> Result<(), String> {
    let _ = fsutil::remove_tree(staging);
    std::fs::create_dir_all(staging)
        .map_err(|err| format!("The scratch folder couldn't be made: {err}"))?;
    let staging_root = fsutil::canonical(staging).map_err(|err| err.to_string())?;
    let mut seen = BTreeSet::new();
    let mut total = 0usize;
    for file in files {
        let rel = relative_file(&file.path)?;
        let key = rel.to_string_lossy().into_owned();
        if !seen.insert(key) {
            let _ = fsutil::remove_tree(staging);
            return Err("That file is listed twice.".into());
        }
        if file.content.len() > MAX_FILE_BYTES {
            let _ = fsutil::remove_tree(staging);
            return Err("That file is too big.".into());
        }
        total += file.content.len();
        if total > MAX_TOTAL_BYTES {
            let _ = fsutil::remove_tree(staging);
            return Err("That's too much to write.".into());
        }
        let dest = staging.join(&rel);
        let parent = dest.parent().ok_or_else(outside)?;
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        let parent = fsutil::canonical(parent).map_err(|err| err.to_string())?;
        if !parent.starts_with(&staging_root) {
            let _ = fsutil::remove_tree(staging);
            return Err(outside());
        }
        if let Err(err) = std::fs::write(&dest, file.content.as_bytes()) {
            let _ = fsutil::remove_tree(staging);
            return Err(err.to_string());
        }
    }
    Ok(())
}

fn swap_scratch(session_dir: &Path, staging: &Path, scratch: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(scratch).is_ok() {
        if is_symlink(scratch) {
            return Err("The scratch folder isn't a real folder.".into());
        }
        let session = fsutil::canonical(session_dir).map_err(|err| err.to_string())?;
        let parent = fsutil::canonical(scratch.parent().ok_or_else(outside)?)
            .map_err(|err| err.to_string())?;
        if parent != session {
            return Err("The scratch folder isn't inside this session.".into());
        }
        fsutil::remove_tree(scratch)?;
    }
    std::fs::rename(staging, scratch).map_err(|err| format!("The draft couldn't be saved: {err}"))
}

pub fn preview(host: &Host, id: &str, revision: u64) -> Result<CreatorState, String> {
    let (name, view, claim) = {
        let _guard = creator_lock();
        let mut session = load(host, id)?;
        if session.revision != revision {
            return Err(stale());
        }
        if session.phase == Phase::Discarded {
            return Err(gone());
        }
        if matches!(session.phase, Phase::Previewed | Phase::Undone) {
            return Ok(finish(host, &session));
        }
        if session.phase != Phase::Drafted {
            return Err("Draft it first.".into());
        }
        if session.claim.is_some() {
            return Err(busy());
        }
        let name = plugin_name(&session)?;
        let scratch = paths(host, id)?.scratch;
        if !scratch.is_dir() || is_symlink(&scratch) {
            return Err("The scratch folder is missing.".into());
        }
        // A preview stays in the scratch folder. It does not install, so it makes no data folder and no store entry.
        if installed_entry(host, &name).is_some() {
            return Err(already_installed(&name));
        }
        let claim = new_claim();
        session.claim = Some(claim.clone());
        save(host, &session)?;
        (name, session.view, claim)
    };
    before_commit(id);
    let _guard = creator_lock();
    let mut session = load(host, id)?;
    let still = session.claim.as_deref() == Some(claim.as_str())
        && session.phase != Phase::Discarded
        && session.revision == revision;
    if !still {
        release_claim(&mut session, host, claim.as_str());
        return Err(if session.phase == Phase::Discarded {
            gone()
        } else {
            stale()
        });
    }
    if installed_entry(host, &name).is_some() {
        release_claim(&mut session, host, claim.as_str());
        return Err(already_installed(&name));
    }
    if let Err(why) = allow_view(host, &view, &name) {
        session.claim = None;
        let _ = save(host, &session);
        return Err(why);
    }
    session.phase = Phase::Previewed;
    session.claim = None;
    session.revision += 1;
    save(host, &session)?;
    Ok(finish(host, &session))
}

enum KeepPlan {
    Done(Box<CreatorState>),
    Update {
        name: String,
        scratch: PathBuf,
        claim: String,
    },
    Enable {
        name: String,
        claim: String,
    },
}

pub fn keep(host: &Host, tools: &Tools, id: &str, revision: u64) -> Result<CreatorState, String> {
    let plan = {
        let _guard = creator_lock();
        let mut session = load(host, id)?;
        if session.revision != revision {
            return Err(stale());
        }
        if session.phase == Phase::Discarded {
            return Err(gone());
        }
        if session.phase == Phase::Kept {
            return Ok(finish(host, &session));
        }
        if !matches!(session.phase, Phase::Previewed | Phase::Undone) {
            return Err("Preview it first.".into());
        }
        if session.claim.is_some() {
            return Err(busy());
        }
        let name = plugin_name(&session)?;
        if mcp_present(&paths(host, id)?.scratch) && !session.mcp_approved {
            return Ok(finish(host, &session));
        }
        if let Some(pending) = session.pending_install.clone() {
            plan_pending(host, &mut session, &name, &pending)?
        } else {
            let scratch = paths(host, id)?.scratch;
            if !scratch.is_dir() || is_symlink(&scratch) {
                return Err("The scratch folder is missing.".into());
            }
            if installed_entry(host, &name).is_some() {
                return Err(already_installed(&name));
            }
            let claim = new_claim();
            session.claim = Some(claim.clone());
            save(host, &session)?;
            KeepPlan::Update {
                name,
                scratch,
                claim,
            }
        }
    };
    match plan {
        KeepPlan::Done(state) => Ok(*state),
        KeepPlan::Enable { name, claim } => enable_kept(host, id, revision, &claim, &name),
        KeepPlan::Update {
            name,
            scratch,
            claim,
        } => keep_update(host, tools, id, revision, &name, &scratch, &claim),
    }
}

/// Called while the session lock is held. A pending install that was approved becomes an enable plan; one that is
/// still waiting, or was declined, finishes here.
fn plan_pending(
    host: &Host,
    session: &mut Session,
    name: &str,
    pending: &str,
) -> Result<KeepPlan, String> {
    if uuid::Uuid::parse_str(pending).is_err() {
        session.pending_install = None;
        session.revision += 1;
        save(host, session)?;
        return Err("That request isn't waiting any more.".into());
    }
    if host.pending().join(pending).is_dir() {
        return Ok(KeepPlan::Done(Box::new(finish(host, session))));
    }
    // A first install has no previous snapshot once it is approved. Declined means it is not installed at all.
    if installed_entry(host, name).is_none() {
        session.pending_install = None;
        session.revision += 1;
        save(host, session)?;
        return Err("The install was declined.".into());
    }
    session.pending_install = None;
    let claim = new_claim();
    session.claim = Some(claim.clone());
    save(host, session)?;
    Ok(KeepPlan::Enable {
        name: name.to_string(),
        claim,
    })
}

fn keep_update(
    host: &Host,
    tools: &Tools,
    id: &str,
    revision: u64,
    name: &str,
    scratch: &Path,
    claim: &str,
) -> Result<CreatorState, String> {
    let source = InstallSource::Local {
        path: scratch.to_string_lossy().into_owned(),
    };
    let updated = match install::install(host, tools, &source, RequestedBy::person()) {
        Ok(result) => result,
        Err(why) => {
            clear_claim(host, id, claim);
            return Err(why);
        }
    };
    match updated {
        InstallResult::Waiting { request } => {
            let _guard = creator_lock();
            let mut session = load(host, id)?;
            let still = session.claim.as_deref() == Some(claim)
                && session.phase != Phase::Discarded
                && session.revision == revision;
            if !still {
                let _ = install::decline(host, &request.id);
                release_claim(&mut session, host, claim);
                return Err(if session.phase == Phase::Discarded {
                    gone()
                } else {
                    stale()
                });
            }
            session.pending_install = Some(request.id);
            session.claim = None;
            session.revision += 1;
            save(host, &session)?;
            Ok(finish(host, &session))
        }
        InstallResult::Installed { .. } => {
            before_commit(id);
            enable_kept(host, id, revision, claim, name)
        }
    }
}

fn mcp_present(scratch: &Path) -> bool {
    load_plugin(scratch)
        .map(|loaded| !loaded.mcp_servers.is_empty())
        .unwrap_or(false)
}

fn enable_kept(
    host: &Host,
    id: &str,
    revision: u64,
    claim: &str,
    name: &str,
) -> Result<CreatorState, String> {
    {
        let _guard = creator_lock();
        let session = load(host, id)?;
        let still = session.claim.as_deref() == Some(claim)
            && session.phase != Phase::Discarded
            && session.revision == revision;
        if !still {
            take_back(host, name);
            let mut session = session;
            release_claim(&mut session, host, claim);
            return Err(if session.phase == Phase::Discarded {
                gone()
            } else {
                stale()
            });
        }
    }
    if let Err(why) = registry::enable(host, name, &Scope::Global) {
        take_back(host, name);
        clear_claim(host, id, claim);
        return Err(why);
    }
    let _guard = creator_lock();
    let mut session = load(host, id)?;
    let still = session.claim.as_deref() == Some(claim)
        && session.phase != Phase::Discarded
        && session.revision == revision;
    if !still {
        let _ = registry::disable(host, name, &Scope::Global);
        take_back(host, name);
        release_claim(&mut session, host, claim);
        return Err(if session.phase == Phase::Discarded {
            gone()
        } else {
            stale()
        });
    }
    session.phase = Phase::Kept;
    session.claim = None;
    session.pending_install = None;
    session.revision += 1;
    save(host, &session)?;
    Ok(finish(host, &session))
}

/// Put a keep back. A first install (no earlier version) is removed. An update goes back to the version it replaced.
fn take_back(host: &Host, name: &str) {
    let _ = undo_install(host, name);
}

fn undo_install(host: &Host, name: &str) -> Result<(), String> {
    let previous = installed_entry(host, name).and_then(|entry| entry.previous);
    if previous.is_some() {
        install::rollback(host, name)?;
        registry::disable(host, name, &Scope::Global)?;
        return Ok(());
    }
    if installed_entry(host, name).is_some() {
        registry::uninstall(host, name)?;
    }
    Ok(())
}

pub fn undo(host: &Host, id: &str, revision: u64) -> Result<CreatorState, String> {
    let (name, claim) = {
        let _guard = creator_lock();
        let mut session = load(host, id)?;
        if session.revision != revision {
            return Err(stale());
        }
        if session.phase == Phase::Discarded {
            return Err(gone());
        }
        if session.phase != Phase::Kept {
            return Err("There's nothing to undo.".into());
        }
        if session.claim.is_some() {
            return Err(busy());
        }
        let name = plugin_name(&session)?;
        let claim = new_claim();
        session.claim = Some(claim.clone());
        save(host, &session)?;
        (name, claim)
    };
    // Check it is still kept before any rollback. The hook can try to discard; that must not clear this claim.
    before_commit(id);
    {
        let _guard = creator_lock();
        let mut session = load(host, id)?;
        let still = session.claim.as_deref() == Some(claim.as_str())
            && session.phase == Phase::Kept
            && session.revision == revision;
        if !still {
            release_claim(&mut session, host, claim.as_str());
            return Err(if session.phase == Phase::Discarded {
                gone()
            } else {
                stale()
            });
        }
    }
    if let Err(why) = undo_install(host, &name) {
        clear_claim(host, id, &claim);
        return Err(why);
    }
    let _guard = creator_lock();
    let mut session = load(host, id)?;
    let still = session.claim.as_deref() == Some(claim.as_str())
        && session.phase == Phase::Kept
        && session.revision == revision;
    if !still {
        release_claim(&mut session, host, claim.as_str());
        return Err(if session.phase == Phase::Discarded {
            gone()
        } else {
            stale()
        });
    }
    session.phase = Phase::Undone;
    session.claim = None;
    session.revision += 1;
    save(host, &session)?;
    Ok(finish(host, &session))
}

pub fn discard(host: &Host, id: &str, revision: u64) -> Result<CreatorState, String> {
    let _guard = creator_lock();
    let mut session = load(host, id)?;
    if session.revision != revision {
        return Err(stale());
    }
    if session.phase == Phase::Discarded {
        return Err("The scratch folder is already gone.".into());
    }
    // Undo rolls a keep back. Discard only removes the scratch folder, so it is refused while the plugin is on.
    // An undo in progress holds the claim: do not clear it and do not delete the folder.
    if session.phase == Phase::Kept {
        return Err(if session.claim.is_some() {
            busy()
        } else {
            "Undo it first.".into()
        });
    }
    let paths = paths(host, id)?;
    let root = fsutil::canonical(&host.root).map_err(|err| err.to_string())?;
    let parent = paths.scratch.parent().ok_or_else(outside)?;
    let parent = fsutil::canonical(parent)
        .map_err(|_| "The scratch folder isn't inside this session.".to_string())?;
    if !parent.starts_with(&root) {
        return Err("The scratch folder isn't inside this session.".into());
    }
    // The scratch path is derived from the session id, never from a path stored in the session file.
    // remove_tree drops a symlink and does not follow it.
    if let Some(name) = session.plugin.clone() {
        if manifest::plugin_name_problem(&name).is_none() {
            let _ = deny_view(host, &session.view, &name);
        }
    }
    fsutil::remove_tree(&paths.scratch)?;
    session.phase = Phase::Discarded;
    session.claim = None;
    session.revision += 1;
    save(host, &session)?;
    Ok(finish(host, &session))
}

pub fn approve_mcp(host: &Host, id: &str, revision: u64) -> Result<CreatorState, String> {
    let _guard = creator_lock();
    let mut session = load(host, id)?;
    if session.revision != revision {
        return Err(stale());
    }
    if session.phase == Phase::Discarded {
        return Err(gone());
    }
    if session.claim.is_some() {
        return Err(busy());
    }
    let fresh = !session.mcp_approved;
    session.mcp_approved = true;
    session.revision += 1;
    save(host, &session)?;
    if fresh {
        // WP-78: the person allowed this creator session's MCP server. A second yes is not a new grant.
        let target = session
            .plugin
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| session.id.clone());
        crate::activity::note_db(
            &super::registry::activity_db(host),
            crate::activity::PERMISSION_GRANT,
            &crate::activity::Who::person(),
            &crate::activity::Who::first_mate(session.id.clone(), ""),
            "",
            &target,
            "Allowed the plugin's MCP server.",
            "",
        );
    }
    Ok(finish(host, &session))
}

pub fn probe_mcp(
    host: &Host,
    id: &str,
    revision: u64,
    timeout: Duration,
) -> Result<CreatorState, String> {
    let prepared = {
        let _guard = creator_lock();
        let mut session = load(host, id)?;
        if session.revision != revision {
            return Err(stale());
        }
        if session.phase == Phase::Discarded {
            return Err(gone());
        }
        if session.claim.is_some() {
            return Err(busy());
        }
        let paths = paths(host, id)?;
        let scratch = paths.scratch;
        let session_dir = paths.dir;
        if !session.mcp_approved {
            return Ok(finish(host, &session));
        }
        if !scratch.is_dir() || is_symlink(&scratch) {
            return Err("The scratch folder is missing.".into());
        }
        let loaded = load_plugin(&scratch).map_err(|err| err.0)?;
        let Some(server) = loaded.mcp_servers.first().cloned() else {
            session.mcp_note = Some("It has no MCP server.".into());
            session.revision += 1;
            save(host, &session)?;
            return Ok(finish(host, &session));
        };
        match &server.transport {
            Transport::Stdio { command, args, .. }
                if command.starts_with("./")
                    || (is_probe_interpreter(command)
                        && args.iter().any(|arg| arg.starts_with("./"))) => {}
            Transport::Stdio { .. } => {
                session.mcp_note =
                    Some("It isn't a program inside the plugin, so it wasn't started.".into());
                session.revision += 1;
                save(host, &session)?;
                return Ok(finish(host, &session));
            }
            Transport::StreamableHttp { .. } | Transport::Sse { .. } => {
                session.mcp_note = Some("A web server isn't started from here.".into());
                session.revision += 1;
                save(host, &session)?;
                return Ok(finish(host, &session));
            }
        }
        let claim = new_claim();
        session.claim = Some(claim.clone());
        save(host, &session)?;
        (loaded.root, session_dir, server, claim)
    };
    let (root, session_dir, server, claim) = prepared;
    let talked = talk(&root, &session_dir, &server, timeout);
    let _guard = creator_lock();
    let mut session = load(host, id)?;
    let still = session.claim.as_deref() == Some(claim.as_str())
        && session.revision == revision
        && session.phase != Phase::Discarded;
    if !still {
        release_claim(&mut session, host, claim.as_str());
        return Err(if session.phase == Phase::Discarded {
            gone()
        } else {
            stale()
        });
    }
    match talked {
        Talk::Tools(tools) => {
            session.mcp_tools = tools;
            session.mcp_note = None;
        }
        Talk::TimedOut => {
            session.mcp_note = Some("It timed out. It wasn't marked as failed.".into());
        }
        Talk::Note(note) => {
            session.mcp_note = Some(note);
        }
    }
    session.claim = None;
    session.revision += 1;
    save(host, &session)?;
    Ok(finish(host, &session))
}

enum Talk {
    Tools(Vec<String>),
    TimedOut,
    Note(String),
}

/// `node`, `python3`, `uv`, `deno` and `bun` may run a script. Anything else has to be a `./` program.
fn is_probe_interpreter(command: &str) -> bool {
    matches!(command, "node" | "python3" | "uv" | "deno" | "bun")
}

/// An interpreter may run only a `./` script inside the plugin, checked by WP-42's `absolute_plugin_args`.
/// A flag is allowed. Any other argument is not, including a path that function would otherwise leave unchanged.
fn interpreter_launch_args(root: &Path, args: &[String]) -> Result<Vec<String>, ()> {
    let mut saw_script = false;
    for arg in args {
        if arg.starts_with("./") {
            saw_script = true;
        } else if arg.starts_with('-')
            && !arg.contains('/')
            && !arg.contains('\\')
            && !arg.contains("..")
        {
            // A flag, not a path.
        } else {
            return Err(());
        }
    }
    if !saw_script {
        return Err(());
    }
    super::verify::absolute_plugin_args(args, root).map_err(|_| ())
}

fn talk(root: &Path, session_dir: &Path, server: &mcp::McpServer, timeout: Duration) -> Talk {
    // probe-data lives beside the scratch folder, so Keep does not install it.
    let data = session_dir.join("probe-data");
    if std::fs::create_dir_all(&data).is_err() {
        return Talk::Note("It didn't start.".into());
    }
    let plan = match mcp::launch_plan(root, &data, server) {
        Ok(plan) => plan,
        Err(_) => return Talk::Note("It didn't start.".into()),
    };
    let Transport::Stdio { command, .. } = &server.transport else {
        return Talk::Note("A web server isn't started from here.".into());
    };
    let (program, launch_args) = if command.starts_with("./") {
        let Ok(program) = fsutil::canonical(&plan.program) else {
            return Talk::Note("It didn't start.".into());
        };
        if !strictly_inside(root, &program) {
            return Talk::Note(
                "It isn't a program inside the plugin, so it wasn't started.".into(),
            );
        }
        (program, plan.args.clone())
    } else if is_probe_interpreter(command) {
        let Ok(launch_args) = interpreter_launch_args(root, &plan.args) else {
            return Talk::Note(
                "It isn't a program inside the plugin, so it wasn't started.".into(),
            );
        };
        match crate::connectors::launch::find_on_path(command) {
            Some(found) => (found, launch_args),
            None => return Talk::Note("It didn't start.".into()),
        }
    } else {
        return Talk::Note("It isn't a program inside the plugin, so it wasn't started.".into());
    };
    let mut command = std::process::Command::new(&program);
    command
        .args(&launch_args)
        .current_dir(&plan.cwd)
        .env_clear()
        .envs(passed_env(std::env::vars_os()))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    for (key, value) in &plan.env {
        command.env(key, value);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return Talk::Note("It didn't start.".into()),
    };
    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child);
        return Talk::Note("It didn't start.".into());
    };
    let Some(mut stdin) = child.stdin.take() else {
        stop_child(&mut child);
        return Talk::Note("It didn't start.".into());
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            let sent = match line {
                Ok(line) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(line) {
                        Ok(value) => sender.send(Ok(value)),
                        Err(_) => sender.send(Err("the reply wasn't JSON".to_string())),
                    }
                }
                Err(_) => sender.send(Err("it closed the connection".to_string())),
            };
            if sent.is_err() {
                break;
            }
        }
    });
    let init = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "hivra-creator", "version": "0" }
        }
    });
    if write_line(&mut stdin, &init).is_err() {
        stop_child(&mut child);
        return Talk::Note("It didn't start.".into());
    }
    let started = match wait_for_id(&receiver, &mut child, timeout, 1) {
        Ok(reply) => reply,
        Err(true) => return Talk::TimedOut,
        Err(false) => return Talk::Note("It didn't answer tools/list.".into()),
    };
    if let Some(error) = started.pointer("/error/message").and_then(Value::as_str) {
        stop_child(&mut child);
        return Talk::Note(error.to_string());
    }
    let note = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    let list = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    if write_line(&mut stdin, &note).is_err() || write_line(&mut stdin, &list).is_err() {
        stop_child(&mut child);
        return Talk::Note("It didn't answer tools/list.".into());
    }
    let reply = match wait_for_id(&receiver, &mut child, timeout, 2) {
        Ok(reply) => reply,
        Err(true) => return Talk::TimedOut,
        Err(false) => return Talk::Note("It didn't answer tools/list.".into()),
    };
    stop_child(&mut child);
    if let Some(error) = reply.pointer("/error/message").and_then(Value::as_str) {
        return Talk::Note(error.to_string());
    }
    match tool_names(&reply) {
        Some(names) => Talk::Tools(names),
        None => Talk::Note("It didn't answer tools/list.".into()),
    }
}

/// `Err(true)` is a timeout. `Err(false)` is any other miss. Lines for another id are skipped. The child is stopped
/// on a timeout.
fn wait_for_id(
    receiver: &std::sync::mpsc::Receiver<Result<Value, String>>,
    child: &mut std::process::Child,
    timeout: Duration,
    id: i64,
) -> Result<Value, bool> {
    let deadline = std::time::Instant::now() + timeout;
    let wanted = serde_json::json!(id);
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            stop_child(child);
            return Err(true);
        }
        match receiver.recv_timeout(left) {
            Ok(Ok(value)) if value.get("id") == Some(&wanted) => return Ok(value),
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => {
                stop_child(child);
                return Err(false);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                stop_child(child);
                return Err(true);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                stop_child(child);
                return Err(false);
            }
        }
    }
}

fn stop_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// One JSON-RPC message, newline-delimited, which is what MCP stdio speaks.
fn write_line(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    writeln!(writer, "{message}").map_err(|err| err.to_string())?;
    writer.flush().map_err(|err| err.to_string())
}

/// One JSON-RPC frame, Content-Length framed. A length over 1 MiB is refused before it is read.
/// The probe speaks newline JSON. This stays so a huge length is still refused in the unit test.
#[cfg(test)]
pub(crate) fn read_frame(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut len = None;
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|_| "the reply was cut off".to_string())?;
        if read == 0 {
            return Err("it closed the connection".into());
        }
        if line.len() > 8192 {
            return Err("the reply was cut off".into());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                len = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| "the reply was cut off".to_string())?,
                );
            }
        }
    }
    let len = len.ok_or("the reply was cut off")?;
    if len > MAX_FRAME_BYTES {
        return Err("the reply is too big".into());
    }
    let mut buf = vec![0; len];
    std::io::Read::read_exact(reader, &mut buf).map_err(|_| "the reply was cut off".to_string())?;
    serde_json::from_slice(&buf).map_err(|_| "the reply wasn't JSON".to_string())
}

fn tool_names(value: &Value) -> Option<Vec<String>> {
    let tools = value.get("result")?.get("tools")?.as_array()?;
    Some(
        tools
            .iter()
            .filter_map(|tool| tool.get("name")?.as_str().map(str::to_string))
            .collect(),
    )
}

fn probe_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(timeout_ms.unwrap_or(5_000).clamp(1, 30_000))
}

#[tauri::command(async)]
pub fn creator_start(
    app: tauri::AppHandle,
    view: String,
    expect: String,
) -> Result<CreatorState, String> {
    start(&super::host(&app)?, &view, &expect)
}

#[tauri::command(async)]
pub fn creator_draft(
    app: tauri::AppHandle,
    id: String,
    revision: u64,
    files: Vec<DraftFile>,
) -> Result<CreatorState, String> {
    draft(&super::host(&app)?, &id, revision, &files)
}

#[tauri::command(async)]
pub fn creator_check(app: tauri::AppHandle, id: String) -> Result<CreatorState, String> {
    load_state(&super::host(&app)?, &id)
}

#[tauri::command(async)]
pub fn creator_preview(
    app: tauri::AppHandle,
    id: String,
    revision: u64,
) -> Result<CreatorState, String> {
    preview(&super::host(&app)?, &id, revision)
}

#[tauri::command(async)]
pub fn creator_keep(
    app: tauri::AppHandle,
    id: String,
    revision: u64,
) -> Result<CreatorState, String> {
    keep(&super::host(&app)?, &Tools::app(), &id, revision)
}

#[tauri::command(async)]
pub fn creator_undo(
    app: tauri::AppHandle,
    id: String,
    revision: u64,
) -> Result<CreatorState, String> {
    undo(&super::host(&app)?, &id, revision)
}

#[tauri::command(async)]
pub fn creator_discard(
    app: tauri::AppHandle,
    id: String,
    revision: u64,
) -> Result<CreatorState, String> {
    discard(&super::host(&app)?, &id, revision)
}

#[tauri::command(async)]
pub fn creator_approve_mcp(
    app: tauri::AppHandle,
    id: String,
    revision: u64,
) -> Result<CreatorState, String> {
    approve_mcp(&super::host(&app)?, &id, revision)
}

#[tauri::command(async)]
pub fn creator_probe_mcp(
    app: tauri::AppHandle,
    id: String,
    revision: u64,
    timeout_ms: Option<u64>,
) -> Result<CreatorState, String> {
    probe_mcp(
        &super::host(&app)?,
        &id,
        revision,
        probe_timeout(timeout_ms),
    )
}

#[tauri::command(async)]
pub fn creator_state(app: tauri::AppHandle, id: String) -> Result<CreatorState, String> {
    load_state(&super::host(&app)?, &id)
}
