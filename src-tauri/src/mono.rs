//! Each Mono keeps its files out of every repo: it works in repos with full file access, so a soul kept there could
//! be rewritten outside the app's controlled CLI or by a pull request. The daily app keeps them in one permanent home,
//! `~/agent-memory/monos/` (mono_home.rs: the layout, the one-time move there and the checks on every write); a dev
//! copy keeps its own in its data folder. Only the app writes there; workers are denied edits under it (hubMcp.ts).
//!
//! ```text
//! <monos root>/             ~/agent-memory/monos for the daily app, <app data>/monos for a dev copy
//! ├── MONOS.json            the roster (mono.ts keeps a copy in the WebView as a cache)
//! ├── index.json            from when each project had its own Mono:
//! │                         folder id → the project keys it answered for
//! └── <mono id>/
//!     ├── SOUL.md           who it is; edited by the user or at their request
//!     ├── MEMORY.md         what it has learned; loads into every turn
//!     ├── habits.json       what it does on its own, on a schedule
//!     ├── chats.json        its chat id, and the ones it had before
//!     ├── soul-template.md  the app's soul template as it last took it (soul refresh, soulRefresh.ts)
//!     ├── memory/           topic notes read on demand, and archive.md
//!     └── skills/           how-to notes it wrote for itself, one `<name>.md` each (A7: a worker can read and improve
//!                           the skill it works as; the same path jail as memory/)
//! ```
//!
//! A Mono is not tied to a project, so its folder is named by its own id. One
//! that was a project's Mono passes that project along until its old folder
//! has moved under its id.
//!
//! A Mono that does work of its own, outside any project, has a team (Ash,
//! 20 Oct: "something like coding team should be created for that mono"): a
//! folder its workers run in, beside `monos/` rather than inside it.
//!
//! ```text
//! <app data>/mono-teams/
//! └── <mono id>/            its workers' folder: research, drafts, whatever
//!                           they make; made the first time it delegates
//! ```
//!
//! Not inside `monos/<id>/`: a ship backs up `monos/` (and a team's output can
//! be large), and the Mono's file commands read only its own files there.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::mono_home::{self, CHATS_FILE, ROSTER_FILE, SOUL_TEMPLATE_FILE};

const MONOS_DIR: &str = "monos";
/// Where Monos lived before they had their name; moved on first use.
const LEGACY_DIR: &str = "agents";
const INDEX_FILE: &str = "index.json";
/// Each Mono's own team folder, beside `monos/` (see the module docs).
const TEAMS_DIR: &str = "mono-teams";
const SOUL_FILE: &str = "SOUL.md";
const MEMORY_FILE: &str = "MEMORY.md";
const MEMORY_DIR: &str = "memory";
/// Skill files a Mono keeps for itself, one `<name>.md` each, beside its memory.
const SKILLS_DIR: &str = "skills";
const HABITS_FILE: &str = "habits.json";
/// Colour themes a Mono made, one `<name>.json` each (themeFiles.ts checks them before any is shown).
const THEMES_DIR: &str = "themes";
/// Larger than anything that would load: the soul and memory both have far
/// smaller prompt budgets, this only stops a runaway write.
const FILE_MAX: usize = 256 * 1024;
pub const CONFLICT: &str = "conflict";

/// Serializes index updates, so two Monos opening at once cannot both read
/// the old index and drop each other's entry.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

/// All windows share this store. Keep initialization and hash-checked writes
/// serialized so only one caller can save over a version of a file.
static FILES_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize)]
struct AgentIndex {
    #[serde(default)]
    agents: Vec<AgentEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AgentEntry {
    id: String,
    /// Project keys (normalized paths) its project's Mono answered for.
    projects: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFile {
    /// Absent when the file does not exist yet.
    pub text: Option<String>,
    /// Hash of the text, or of "" for a missing file.
    pub hash: String,
    /// When the file last changed (ms since the epoch), so the soul tamper check can match it to the chats that were
    /// running then. Absent for a missing file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFiles {
    pub id: String,
    pub dir: String,
    /// Absent until the app seeds it; the seed needs the user's old settings.
    pub soul: Option<String>,
    pub soul_hash: String,
    pub memory: String,
    pub memory_hash: String,
    pub memory_path: String,
    /// Topic notes under memory/, by name without `.md`; not the archive.
    pub topics: Vec<String>,
    /// Theme files under themes/, by name without `.json`.
    pub themes: Vec<String>,
    /// Skill files under skills/, by name without `.md`.
    pub skills: Vec<String>,
}

/// The files the app reads and writes for an agent, relative to its folder: SOUL.md, MEMORY.md, habits.json,
/// chats.json, soul-template.md, one `memory/<name>.md`, one `themes/<name>.json`, or one `skills/<name>.md`.
/// Nothing nested, nothing hidden, so a path from the agent's CLI can never leave the folder.
fn resolve_file(dir: &Path, relative: &str) -> Result<PathBuf, String> {
    if [
        SOUL_FILE,
        MEMORY_FILE,
        HABITS_FILE,
        CHATS_FILE,
        SOUL_TEMPLATE_FILE,
    ]
    .contains(&relative)
    {
        return Ok(dir.join(relative));
    }
    let (folder, name, ext) = if let Some(rest) = relative.strip_prefix("memory/") {
        (MEMORY_DIR, rest.strip_suffix(".md"), "md")
    } else if let Some(rest) = relative.strip_prefix("themes/") {
        (THEMES_DIR, rest.strip_suffix(".json"), "json")
    } else if let Some(rest) = relative.strip_prefix("skills/") {
        (SKILLS_DIR, rest.strip_suffix(".md"), "md")
    } else {
        return Err(format!("Not an agent file: {relative}"));
    };
    let name = name.ok_or_else(|| format!("Not an agent file: {relative}"))?;
    if !valid_name(name) {
        return Err(format!("Not an agent file: {relative}"));
    }
    Ok(dir.join(folder).join(format!("{name}.{ext}")))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_'))
}

/// File names in `folder` ending in `.ext`, without it, sorted; hidden files and `skip` left out.
fn list_names(dir: &Path, folder: &str, ext: &str, skip: &str) -> Vec<String> {
    let suffix = format!(".{ext}");
    let mut names: Vec<String> = std::fs::read_dir(dir.join(folder))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_file())
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let stem = name.strip_suffix(suffix.as_str())?.to_string();
                    (stem != skip && valid_name(&stem)).then_some(stem)
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn topics(dir: &Path) -> Vec<String> {
    list_names(dir, MEMORY_DIR, "md", "archive")
}

fn themes(dir: &Path) -> Vec<String> {
    list_names(dir, THEMES_DIR, "json", "")
}

fn skills(dir: &Path) -> Vec<String> {
    list_names(dir, SKILLS_DIR, "md", "")
}

/// This copy's `<app data>/monos`, after moving an older `agents/` folder to it.
fn app_monos(data: &Path) -> PathBuf {
    let root = data.join(MONOS_DIR);
    let legacy = data.join(LEGACY_DIR);
    if !root.exists() && legacy.join(INDEX_FILE).is_file() {
        let _ = std::fs::rename(&legacy, &root);
    }
    root
}

/// The root this process settled on: worked out once, so it never switches mid-session.
static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Where this copy's Monos live (mono_home.rs `choose_root`). The daily app's first call copies its Monos from
/// `<app data>/monos` into the permanent home; if that can't be done safely, it keeps using the old folder this
/// session and says why.
pub fn resolved_root(data: &Path) -> PathBuf {
    let mut settled = ROOT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(root) = settled.as_ref() {
        return root.clone();
    }
    let app_root = app_monos(data);
    let override_root = std::env::var_os(mono_home::HOME_ENV).map(PathBuf::from);
    let daily = crate::instance::kind() == crate::instance::Kind::Daily;
    let home = dirs::home_dir();
    let chosen = mono_home::choose_root(daily, home.as_deref(), override_root.as_deref(), data);
    let root = if chosen == app_root {
        app_root
    } else {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".into());
        match mono_home::ensure_home(&chosen, &app_root, &stamp) {
            Ok(mono_home::HomeState::Migrated(moved)) => {
                eprintln!(
                    "Copied {} Monos ({} files) to {}; {} is kept as it was",
                    moved.monos.len(),
                    moved.files.len(),
                    chosen.display(),
                    app_root.display()
                );
                chosen
            }
            Ok(mono_home::HomeState::Ready) => chosen,
            Err(error) => {
                eprintln!("Monos stay in {} this session: {error}", app_root.display());
                app_root
            }
        }
    };
    *settled = Some(root.clone());
    root
}

fn monos_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(resolved_root(&data))
}

/// The folders that are a Mono's own, for what it makes there to show in its chat (`chat_media.rs`): its folder in the
/// Monos' home (`root`, from `resolved_root`), and its team's folder under `data`. Only a valid Mono id names them, so
/// neither can point anywhere else.
pub(crate) fn mono_places(root: &Path, data: &Path, mono: &str) -> Vec<PathBuf> {
    if !valid_id(mono) {
        return Vec::new();
    }
    vec![root.join(mono), data.join(TEAMS_DIR).join(mono)]
}

/// The Monos' roster as the app last saved it (`MONOS.json`), for readers that need to know which projects a Mono
/// works on and which chat is its own (`chat_media.rs`). `None` when there is no file or it cannot be read.
pub(crate) fn roster_value(app: &AppHandle) -> Option<serde_json::Value> {
    let text = roster_load(&monos_root(app).ok()?).ok()?.text?;
    serde_json::from_str(&text).ok()
}

pub fn content_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Write beside the target and rename over it, so a crash mid-write leaves
/// the old file whole. Owner-only, since memory can hold personal details.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;

    let temp = path.with_extension("md.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|e| format!("{}: {e}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // A temporary file left by an older version may have wider permissions.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("{}: {e}", temp.display()))?;
    }
    file.write_all(text.as_bytes())
        .map_err(|e| format!("{}: {e}", temp.display()))?;
    drop(file);
    std::fs::rename(&temp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn modified_ms(path: &Path) -> Option<u64> {
    let at = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(at.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn read_index(root: &Path) -> AgentIndex {
    std::fs::read_to_string(root.join(INDEX_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// The Mono's folder, created with an empty memory on first use. A Mono that
/// was a project's own takes over that project's folder the first time.
fn agent_dir(root: &Path, mono: &str, legacy_project: Option<&str>) -> Result<PathBuf, String> {
    if !valid_id(mono) {
        return Err("Not a Mono id".into());
    }
    std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let mut dir = root.join(mono);
    if !dir.exists() {
        // A Mono renamed in this home: a call still naming the old id (one already on its way when the rename ran)
        // uses the renamed folder, never a new empty one under the old name.
        if let Some(renamed) = mono_home::renamed_to(root, mono).filter(|to| root.join(to).is_dir())
        {
            dir = root.join(renamed);
        }
    }
    if let Some(project) = legacy_project.filter(|project| !project.trim().is_empty()) {
        adopt_legacy_folder(root, &dir, project)?;
    }
    std::fs::create_dir_all(dir.join(MEMORY_DIR)).map_err(|e| format!("{}: {e}", dir.display()))?;
    let memory = dir.join(MEMORY_FILE);
    if !memory.exists() {
        write_atomic(&memory, "")?;
    }
    Ok(dir)
}

/// Moves the folder the project's Mono had to `dir`, once, and drops it from
/// the index so no other Mono can take it too.
fn adopt_legacy_folder(root: &Path, dir: &Path, project: &str) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;
    let mut index = read_index(root);
    let Some(position) = index
        .agents
        .iter()
        .position(|entry| valid_id(&entry.id) && entry.projects.iter().any(|key| key == project))
    else {
        return Ok(());
    };
    let entry = index.agents.remove(position);
    let legacy = root.join(&entry.id);
    if !dir.exists() && legacy.is_dir() && legacy != dir {
        std::fs::rename(&legacy, dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    let path = root.join(INDEX_FILE);
    let temp = root.join("index.json.tmp");
    std::fs::write(&temp, text).map_err(|e| format!("{}: {e}", temp.display()))?;
    std::fs::rename(&temp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

fn load(root: &Path, mono: &str, legacy_project: Option<&str>) -> Result<AgentFiles, String> {
    let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = agent_dir(root, mono, legacy_project)?;
    let soul = read_optional(&dir.join(SOUL_FILE))?;
    let memory_path = dir.join(MEMORY_FILE);
    let memory = read_optional(&memory_path)?.unwrap_or_default();
    Ok(AgentFiles {
        id: mono.to_string(),
        soul_hash: content_hash(soul.as_deref().unwrap_or("")),
        soul,
        memory_hash: content_hash(&memory),
        memory,
        memory_path: memory_path.to_string_lossy().into_owned(),
        topics: topics(&dir),
        themes: themes(&dir),
        skills: skills(&dir),
        dir: dir.to_string_lossy().into_owned(),
    })
}

fn read(
    root: &Path,
    mono: &str,
    legacy_project: Option<&str>,
    relative: &str,
) -> Result<AgentFile, String> {
    let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = agent_dir(root, mono, legacy_project)?;
    let path = resolve_file(&dir, relative)?;
    let text = read_optional(&path)?;
    Ok(AgentFile {
        hash: content_hash(text.as_deref().unwrap_or("")),
        modified_ms: text.as_ref().and_then(|_| modified_ms(&path)),
        text,
    })
}

/// Saves only over the text the editor opened, so the user never overwrites
/// what the agent wrote while they were typing. No hash means overwrite.
fn save(
    root: &Path,
    mono: &str,
    legacy_project: Option<&str>,
    relative: &str,
    text: &str,
    expected_hash: Option<&str>,
) -> Result<String, String> {
    if text.len() > FILE_MAX {
        return Err(format!("{relative} is too large"));
    }
    mono_home::check_write(relative, text)?;
    let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = agent_dir(root, mono, legacy_project)?;
    let path = resolve_file(&dir, relative)?;
    let made = if relative.starts_with("themes/") {
        Some(THEMES_DIR)
    } else if relative.starts_with("skills/") {
        Some(SKILLS_DIR)
    } else {
        None
    };
    if let Some(folder) = made {
        let folder = dir.join(folder);
        std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    }
    if let Some(expected) = expected_hash {
        let current = read_optional(&path)?.unwrap_or_default();
        if content_hash(&current) != expected {
            return Err(CONFLICT.into());
        }
    }
    write_atomic(&path, text)?;
    Ok(content_hash(text))
}

#[tauri::command]
pub async fn mono_load(
    app: AppHandle,
    mono: String,
    legacy_project: Option<String>,
) -> Result<AgentFiles, String> {
    let root = monos_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || load(&root, &mono, legacy_project.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mono_read(
    app: AppHandle,
    mono: String,
    legacy_project: Option<String>,
    path: String,
) -> Result<AgentFile, String> {
    let root = monos_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        read(&root, &mono, legacy_project.as_deref(), &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mono_save(
    app: AppHandle,
    mono: String,
    legacy_project: Option<String>,
    path: String,
    text: String,
    expected_hash: Option<String>,
) -> Result<String, String> {
    let root = monos_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        save(
            &root,
            &mono,
            legacy_project.as_deref(),
            &path,
            &text,
            expected_hash.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeInfo {
    /// The folder every Mono lives in this session.
    pub root: String,
    /// True for the permanent home (`~/agent-memory/monos` or a named override), false for `<app data>/monos`.
    pub permanent: bool,
    /// What the one-time move recorded, once it ran.
    pub migration: Option<serde_json::Value>,
}

fn home_info(root: &Path, data: &Path) -> HomeInfo {
    HomeInfo {
        root: root.to_string_lossy().into_owned(),
        permanent: root != data.join(MONOS_DIR),
        migration: std::fs::read_to_string(root.join(mono_home::MIGRATION_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok()),
    }
}

#[tauri::command]
pub async fn mono_home_info(app: AppHandle) -> Result<HomeInfo, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || home_info(&resolved_root(&data), &data))
        .await
        .map_err(|e| e.to_string())
}

fn roster_load(root: &Path) -> Result<AgentFile, String> {
    let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
    let text = read_optional(&root.join(ROSTER_FILE))?;
    Ok(AgentFile {
        hash: content_hash(text.as_deref().unwrap_or("")),
        modified_ms: None,
        text,
    })
}

/// The roster, checked (every id a Mono id, none twice) and saved over `expected_hash` when one is given.
fn roster_save(root: &Path, text: &str, expected_hash: Option<&str>) -> Result<String, String> {
    if text.len() > FILE_MAX {
        return Err("MONOS.json is too large".into());
    }
    mono_home::check_write(ROSTER_FILE, text)?;
    let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let path = root.join(ROSTER_FILE);
    if let Some(expected) = expected_hash {
        let current = read_optional(&path)?.unwrap_or_default();
        if content_hash(&current) != expected {
            return Err(CONFLICT.into());
        }
    }
    write_atomic(&path, text)?;
    Ok(content_hash(text))
}

#[tauri::command]
pub async fn mono_roster_load(app: AppHandle) -> Result<AgentFile, String> {
    let root = monos_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || roster_load(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mono_roster_save(
    app: AppHandle,
    text: String,
    expected_hash: Option<String>,
) -> Result<String, String> {
    let root = monos_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        roster_save(&root, &text, expected_hash.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonoRenamed {
    pub folder: mono_home::Renamed,
    pub refs: mono_home::RefsRenamed,
}

/// A Mono takes a new id (ash-lead → hub-lead, monoRename.ts): its folder moves, its old soul is kept in memory/, and
/// its rows in the database follow it. The roster and the WebView's own records are the caller's.
#[tauri::command]
pub async fn mono_rename(
    app: AppHandle,
    store: State<'_, crate::session_store::SessionStore>,
    from: String,
    to: String,
) -> Result<MonoRenamed, String> {
    let root = monos_root(&app)?;
    let (from_id, to_id) = (from.clone(), to.clone());
    let folder = tauri::async_runtime::spawn_blocking(move || {
        let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
        mono_home::rename_mono_folder(&root, &from_id, &to_id)
    })
    .await
    .map_err(|e| e.to_string())??;
    let refs = mono_home::rename_refs(&mut *store.lock_conn()?, &from, &to)?;
    Ok(MonoRenamed { folder, refs })
}

/// Where retired Monos' folders go. Hidden from `load` (not a valid id), never deleted by the app.
const ARCHIVE_DIR: &str = ".archive";

/// Retire: move `<root>/<mono>` (its SOUL.md, MEMORY.md, habits and notes) into `<root>/.archive/<mono>-<stamp>`.
/// Returns the archive folder's name. Nothing is deleted.
fn archive(root: &Path, mono: &str, stamp: &str) -> Result<String, String> {
    if !valid_id(mono) || !valid_id(stamp) {
        return Err("Not a Mono id".into());
    }
    let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = root.join(mono);
    let name = format!("{mono}-{stamp}");
    let archive_root = root.join(ARCHIVE_DIR);
    std::fs::create_dir_all(&archive_root)
        .map_err(|e| format!("{}: {e}", archive_root.display()))?;
    let dest = archive_root.join(&name);
    if dest.exists() {
        return Err("That archive already exists".into());
    }
    if dir.is_dir() {
        std::fs::rename(&dir, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    } else {
        // Never opened: an empty archive still records the retirement.
        std::fs::create_dir_all(dest.join(MEMORY_DIR))
            .map_err(|e| format!("{}: {e}", dest.display()))?;
    }
    Ok(name)
}

/// Undo a retirement: move the archive folder back, only if nothing has taken the Mono's place since.
fn unarchive(root: &Path, mono: &str, name: &str) -> Result<(), String> {
    if !valid_id(mono) || !name.starts_with(&format!("{mono}-")) || !valid_id(name) {
        return Err("Not that Mono's archive".into());
    }
    let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
    let from = root.join(ARCHIVE_DIR).join(name);
    let dir = root.join(mono);
    if !from.is_dir() {
        return Err("The archived folder isn't there any more".into());
    }
    if dir.exists() {
        // A fresh empty folder (made by a load since) gives way; anything with content is never overwritten.
        let empty_memory = std::fs::read_to_string(dir.join(MEMORY_FILE))
            .map(|t| t.is_empty())
            .unwrap_or(true);
        let only_defaults = std::fs::read_dir(&dir)
            .map(|it| {
                it.flatten().all(|e| {
                    let n = e.file_name();
                    n == MEMORY_FILE || n == MEMORY_DIR
                })
            })
            .unwrap_or(false)
            && std::fs::read_dir(dir.join(MEMORY_DIR))
                .map(|mut it| it.next().is_none())
                .unwrap_or(true);
        if !(empty_memory && only_defaults) {
            return Err("A Mono with that id has files again, so nothing was moved back".into());
        }
        std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::rename(&from, &dir).map_err(|e| format!("{}: {e}", dir.display()))
}

#[tauri::command]
pub async fn mono_archive(app: AppHandle, mono: String, stamp: String) -> Result<String, String> {
    let root = monos_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || archive(&root, &mono, &stamp))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mono_unarchive(app: AppHandle, mono: String, archive: String) -> Result<(), String> {
    let root = monos_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || unarchive(&root, &mono, &archive))
        .await
        .map_err(|e| e.to_string())?
}

/// A Mono's own team folder under `data`, made on first use. Only a Mono id
/// names it, so it can never point outside `mono-teams/`.
fn team_dir(data: &Path, mono: &str) -> Result<PathBuf, String> {
    if !valid_id(mono) {
        return Err("Not a Mono id".into());
    }
    let dir = data.join(TEAMS_DIR).join(mono);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// The folder a Mono's own team works in (`<app data>/mono-teams/<id>`),
/// created if it isn't there yet. Each copy of the app has its own, since it
/// lives in that copy's data folder.
#[tauri::command]
pub async fn mono_team_dir(app: AppHandle, mono: String) -> Result<String, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        team_dir(&data, &mono).map(|dir| dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests_support {
    use std::path::PathBuf;

    pub fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("mono-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("mono-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// The leftover `ash-lead/` on Ash's Mac (21 Oct): after ash-lead became hub-lead, a read still naming ash-lead
    /// (already on its way when the rename ran) made an empty ash-lead/ beside hub-lead/. Now it reads hub-lead's
    /// folder, a write lands there too, and an empty leftover from before this fix goes on the next rename pass.
    #[test]
    fn a_late_call_with_a_renamed_monos_old_id_never_makes_an_empty_folder() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("ash-lead/memory")).unwrap();
        std::fs::write(
            root.join("ash-lead/SOUL.md"),
            "# Soul\nASH_MONO_ID=ash-lead\n",
        )
        .unwrap();
        std::fs::write(root.join("ash-lead/MEMORY.md"), "- kept\n").unwrap();
        mono_home::rename_mono_folder(&root, "ash-lead", "hub-lead").unwrap();
        let late = load(&root, "ash-lead", None).unwrap();
        assert!(
            !root.join("ash-lead").exists(),
            "no folder under the old id"
        );
        assert_eq!(late.memory, "- kept\n");
        assert!(late.soul.unwrap().contains("ASH_MONO_ID=hub-lead"));
        save(
            &root,
            "ash-lead",
            None,
            "MEMORY.md",
            "- kept\n- late\n",
            None,
        )
        .unwrap();
        assert!(!root.join("ash-lead").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("hub-lead/MEMORY.md")).unwrap(),
            "- kept\n- late\n"
        );
        // A leftover made before this fix (empty memory, empty notes) goes; the renamed Mono is untouched.
        std::fs::create_dir_all(root.join("ash-lead/memory")).unwrap();
        std::fs::write(root.join("ash-lead/MEMORY.md"), "").unwrap();
        let again = mono_home::rename_mono_folder(&root, "ash-lead", "hub-lead").unwrap();
        assert!(!again.moved);
        assert!(!root.join("ash-lead").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("hub-lead/MEMORY.md")).unwrap(),
            "- kept\n- late\n"
        );
        // A leftover that holds anything is never removed.
        std::fs::create_dir_all(root.join("ash-lead")).unwrap();
        std::fs::write(root.join("ash-lead/MEMORY.md"), "- something\n").unwrap();
        assert!(mono_home::rename_mono_folder(&root, "ash-lead", "hub-lead").is_err());
        assert!(root.join("ash-lead/MEMORY.md").is_file());
        // A Mono that was never renamed still gets its folder on first use.
        load(&root, "ed", None).unwrap();
        assert!(root.join("ed/MEMORY.md").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Point 13, item 1: a fact told to Mono A is on disk in A's folder only. A fresh load (what a restart does: the
    /// store keeps nothing in memory) still has it for A, and B and C never see it.
    #[test]
    fn a_memory_fact_survives_a_reload_and_stays_with_its_own_mono() {
        let root = temp_root();
        for mono in ["mono-a", "mono-b", "mono-c"] {
            load(&root, mono, None).unwrap();
        }
        let before = load(&root, "mono-a", None).unwrap();
        let fact = "- 2026-10-15 · the launch is on Friday";
        save(
            &root,
            "mono-a",
            None,
            MEMORY_FILE,
            fact,
            Some(&before.memory_hash),
        )
        .unwrap();
        save(
            &root,
            "mono-a",
            None,
            "memory/launch.md",
            "Friday, 9am",
            None,
        )
        .unwrap();

        // "Restart": nothing cached, read straight back from the same folder on disk.
        let a = load(&root, "mono-a", None).unwrap();
        assert_eq!(a.memory, fact);
        assert_eq!(a.topics, vec!["launch".to_string()]);
        for other in ["mono-b", "mono-c"] {
            let files = load(&root, other, None).unwrap();
            assert_eq!(files.memory, "", "{other} must not see A's memory");
            assert!(
                files.topics.is_empty(),
                "{other} must not see A's topic notes"
            );
            assert_ne!(files.memory_path, a.memory_path);
            assert_eq!(
                read(&root, other, None, "memory/launch.md").unwrap().text,
                None
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Point 13, item 2: rewriting A's SOUL.md (its rules) changes no one else's.
    #[test]
    fn changing_one_monos_rules_leaves_every_other_soul_alone() {
        let root = temp_root();
        let monos = ["mono-a", "mono-b", "mono-c"];
        for mono in monos {
            save(
                &root,
                mono,
                None,
                SOUL_FILE,
                &format!("# Soul\n\n- I am {mono}"),
                None,
            )
            .unwrap();
        }
        let a = load(&root, "mono-a", None).unwrap();
        save(
            &root,
            "mono-a",
            None,
            SOUL_FILE,
            "# Soul\n\n- Always answer in French",
            Some(&a.soul_hash),
        )
        .unwrap();
        assert_eq!(
            load(&root, "mono-a", None).unwrap().soul.as_deref(),
            Some("# Soul\n\n- Always answer in French")
        );
        for mono in ["mono-b", "mono-c"] {
            assert_eq!(
                load(&root, mono, None).unwrap().soul,
                Some(format!("# Soul\n\n- I am {mono}"))
            );
        }
        // A path can never reach another Mono's folder.
        assert!(save(&root, "mono-a", None, "../mono-b/SOUL.md", "x", None).is_err());
        assert!(save(
            &root,
            "mono-a",
            None,
            "memory/../../mono-b/SOUL.md",
            "x",
            None
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retiring_moves_the_folder_into_the_archive_and_undo_brings_it_back() {
        let root = temp_root();
        let a = load(&root, "hivra-lead", None).unwrap();
        save(
            &root,
            "hivra-lead",
            None,
            MEMORY_FILE,
            "- 2026-10-15 · remember this",
            Some(&a.memory_hash),
        )
        .unwrap();
        save(
            &root,
            "hivra-lead",
            None,
            SOUL_FILE,
            "# Soul\n- my rules",
            None,
        )
        .unwrap();
        let name = archive(&root, "hivra-lead", "20261015").unwrap();
        assert!(!root.join("hivra-lead").exists());
        let kept = root.join(ARCHIVE_DIR).join(&name);
        assert_eq!(
            std::fs::read_to_string(kept.join(MEMORY_FILE)).unwrap(),
            "- 2026-10-15 · remember this"
        );
        assert_eq!(
            std::fs::read_to_string(kept.join(SOUL_FILE)).unwrap(),
            "# Soul\n- my rules"
        );
        // something loads the id meanwhile: an empty default folder gives way on Undo
        load(&root, "hivra-lead", None).unwrap();
        unarchive(&root, "hivra-lead", &name).unwrap();
        let back = load(&root, "hivra-lead", None).unwrap();
        assert_eq!(back.memory, "- 2026-10-15 · remember this");
        assert_eq!(back.soul.as_deref(), Some("# Soul\n- my rules"));
        assert!(!kept.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_never_overwrites_a_mono_that_has_files_again() {
        let root = temp_root();
        load(&root, "mono-a", None).unwrap();
        let name = archive(&root, "mono-a", "1").unwrap();
        let fresh = load(&root, "mono-a", None).unwrap();
        save(
            &root,
            "mono-a",
            None,
            MEMORY_FILE,
            "- new",
            Some(&fresh.memory_hash),
        )
        .unwrap();
        assert!(unarchive(&root, "mono-a", &name).is_err());
        assert!(root.join(ARCHIVE_DIR).join(&name).is_dir());
        assert!(unarchive(&root, "mono-b", &name).is_err());
        assert!(archive(&root, "../x", "1").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_monos_team_folder_sits_beside_monos_and_only_a_mono_id_names_it() {
        let data = temp_root();
        let team = team_dir(&data, "cam").unwrap();
        assert_eq!(team, data.join(TEAMS_DIR).join("cam"));
        assert!(team.is_dir());
        // Made once; asking again finds the same folder and keeps what is in it.
        std::fs::write(team.join("notes.md"), "kept").unwrap();
        assert_eq!(team_dir(&data, "cam").unwrap(), team);
        assert_eq!(
            std::fs::read_to_string(team.join("notes.md")).unwrap(),
            "kept"
        );
        // Not under monos/: a ship's backup of monos/ never carries a team's work.
        assert!(!team.starts_with(data.join(MONOS_DIR)));
        assert!(team_dir(&data, "../x").is_err());
        assert!(team_dir(&data, "").is_err());
        assert!(team_dir(&data, "a/b").is_err());
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn creates_one_folder_per_mono_with_empty_memory() {
        let root = temp_root();
        let first = load(&root, "mono-a", None).unwrap();
        let again = load(&root, "mono-a", None).unwrap();
        let other = load(&root, "mono-b", None).unwrap();
        assert_eq!(first.id, "mono-a");
        assert_eq!(first.dir, again.dir);
        assert_ne!(first.dir, other.dir);
        assert_eq!(first.soul, None);
        assert_eq!(first.memory, "");
        assert!(Path::new(&first.dir).join("memory").is_dir());
        assert!(load(&root, "../x", None).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn takes_over_the_folder_its_project_had_once() {
        let root = temp_root();
        let old = root.join("old-id");
        std::fs::create_dir_all(old.join("memory")).unwrap();
        std::fs::write(old.join(MEMORY_FILE), "- kept").unwrap();
        std::fs::write(
            root.join(INDEX_FILE),
            r#"{"agents":[{"id":"old-id","projects":["/code/app"]}]}"#,
        )
        .unwrap();
        let adopted = load(&root, "mono-a", Some("/code/app")).unwrap();
        assert_eq!(adopted.memory, "- kept");
        assert!(!old.exists());
        // Another Mono naming the same project starts fresh.
        let other = load(&root, "mono-b", Some("/code/app")).unwrap();
        assert_eq!(other.memory, "");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_a_changed_file() {
        let root = temp_root();
        let files = load(&root, "m", None).unwrap();
        let hash = save(
            &root,
            "m",
            None,
            MEMORY_FILE,
            "- a",
            Some(&files.memory_hash),
        )
        .unwrap();
        assert_eq!(
            save(
                &root,
                "m",
                None,
                MEMORY_FILE,
                "- b",
                Some(&files.memory_hash)
            ),
            Err(CONFLICT.into())
        );
        save(&root, "m", None, MEMORY_FILE, "- c", Some(&hash)).unwrap();
        save(&root, "m", None, SOUL_FILE, "soul", None).unwrap();
        let loaded = load(&root, "m", None).unwrap();
        assert_eq!(loaded.memory, "- c");
        assert_eq!(loaded.soul.as_deref(), Some("soul"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_files_even_with_a_leftover_public_temp_file() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root();
        let path = root.join(MEMORY_FILE);
        write_atomic(&path, "private memory").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let temp = path.with_extension("md.tmp");
        std::fs::write(&temp, "leftover").unwrap();
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_atomic(&path, "new private memory").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "new private memory"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!temp.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_habit_claims_only_save_over_a_version_once() {
        use std::sync::{Arc, Barrier};

        let root = temp_root();
        let hash = save(&root, "m", None, HABITS_FILE, "[]", None).unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let claims: Vec<_> = (0..8)
            .map(|index| {
                let root = root.clone();
                let hash = hash.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let text = format!("[{{\"claimedBy\":{index}}}]");
                    barrier.wait();
                    let result = save(&root, "m", None, HABITS_FILE, &text, Some(&hash));
                    (text, result)
                })
            })
            .collect();
        let results: Vec<_> = claims
            .into_iter()
            .map(|claim| claim.join().unwrap())
            .collect();
        let winners: Vec<_> = results
            .iter()
            .filter(|(_, result)| result.is_ok())
            .collect();
        assert_eq!(winners.len(), 1);
        for (_, result) in results.iter().filter(|(_, result)| result.is_err()) {
            assert_eq!(result.as_ref().unwrap_err(), CONFLICT);
        }
        let saved = read(&root, "m", None, HABITS_FILE).unwrap();
        assert_eq!(saved.text.as_ref(), Some(&winners[0].0));
        assert_eq!(saved.hash, content_hash(&winners[0].0));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_read_says_when_the_file_last_changed() {
        let root = temp_root();
        assert_eq!(read(&root, "m", None, "SOUL.md").unwrap().modified_ms, None);
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        save(&root, "m", None, "SOUL.md", "# Soul", None).unwrap();
        let at = read(&root, "m", None, "SOUL.md")
            .unwrap()
            .modified_ms
            .unwrap();
        assert!(
            at + 2_000 >= before && at <= before + 60_000,
            "{at} vs {before}"
        );
        let json = serde_json::to_value(read(&root, "m", None, "SOUL.md").unwrap()).unwrap();
        assert!(json.get("modifiedMs").is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_and_writes_topics_inside_the_folder_only() {
        let root = temp_root();
        save(&root, "m", None, "memory/releases.md", "# Releases", None).unwrap();
        save(&root, "m", None, "memory/archive.md", "- old", None).unwrap();
        let loaded = load(&root, "m", None).unwrap();
        assert_eq!(loaded.topics, vec!["releases".to_string()]);
        let topic = read(&root, "m", None, "memory/releases.md").unwrap();
        assert_eq!(topic.text.as_deref(), Some("# Releases"));
        assert_eq!(read(&root, "m", None, "memory/none.md").unwrap().text, None);
        save(&root, "m", None, "habits.json", "[]", None).unwrap();
        for path in [
            "../x.md",
            "memory/../SOUL.md",
            "memory/a/b.md",
            "memory/.hidden.md",
            "notes.md",
        ] {
            assert!(save(&root, "m", None, path, "x", None).is_err(), "{path}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_writes_and_lists_theme_files_inside_the_folder_only() {
        let root = temp_root();
        assert!(load(&root, "m", None).unwrap().themes.is_empty());
        save(
            &root,
            "m",
            None,
            "themes/dusk-blue.json",
            r#"{"name":"Dusk"}"#,
            None,
        )
        .unwrap();
        save(&root, "m", None, "themes/moss.json", "{}", None).unwrap();
        let loaded = load(&root, "m", None).unwrap();
        assert_eq!(
            loaded.themes,
            vec!["dusk-blue".to_string(), "moss".to_string()]
        );
        let theme = read(&root, "m", None, "themes/moss.json").unwrap();
        assert_eq!(theme.text.as_deref(), Some("{}"));
        assert!(save(&root, "m", None, "themes/bad.json", "{not json", None).is_err());
        for path in [
            "themes/../SOUL.md",
            "themes/a/b.json",
            "themes/.hidden.json",
            "themes/moss.md",
            "themes/.json",
        ] {
            assert!(save(&root, "m", None, path, "{}", None).is_err(), "{path}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_writes_and_lists_skill_files_inside_the_folder_only() {
        let root = temp_root();
        assert!(load(&root, "m", None).unwrap().skills.is_empty());
        save(
            &root,
            "m",
            None,
            "skills/release.md",
            "# Release\n\nHow to ship.",
            None,
        )
        .unwrap();
        let loaded = load(&root, "m", None).unwrap();
        assert_eq!(loaded.skills, vec!["release".to_string()]);
        let skill = read(&root, "m", None, "skills/release.md").unwrap();
        assert_eq!(skill.text.as_deref(), Some("# Release\n\nHow to ship."));
        assert!(read(&root, "m", None, "skills/none.md")
            .unwrap()
            .text
            .is_none());
        for path in [
            "skills/../SOUL.md",
            "skills/a/b.md",
            "skills/.hidden.md",
            "skills/release.json",
            "skills/.md",
        ] {
            assert!(save(&root, "m", None, path, "x", None).is_err(), "{path}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn chat_ids_and_the_soul_template_live_in_the_monos_folder_and_are_checked_before_saving() {
        let root = temp_root();
        let chats = r#"{"main":"df9afb39","history":["older"]}"#;
        save(&root, "ada", None, CHATS_FILE, chats, None).unwrap();
        save(&root, "ada", None, SOUL_TEMPLATE_FILE, "# Soul\n", None).unwrap();
        assert_eq!(
            read(&root, "ada", None, CHATS_FILE)
                .unwrap()
                .text
                .as_deref(),
            Some(chats)
        );
        // A broken write is refused and the last good text stays.
        assert!(save(&root, "ada", None, CHATS_FILE, "{", None).is_err());
        assert!(save(&root, "ada", None, HABITS_FILE, "not json", None).is_err());
        assert!(save(&root, "ada", None, SOUL_FILE, "   ", None).is_err());
        assert_eq!(
            read(&root, "ada", None, CHATS_FILE)
                .unwrap()
                .text
                .as_deref(),
            Some(chats)
        );
        // Still nothing outside the folder, and nothing else at its top level.
        for path in [
            "../chats.json",
            "memory/chats.json",
            "MONOS.json",
            "index.json",
        ] {
            assert!(
                save(&root, "ada", None, path, "{}", None).is_err(),
                "{path}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The roster survives the WebView forgetting it: it is a file in the home, saved only over the version read.
    #[test]
    fn the_roster_is_a_checked_file_saved_over_the_version_it_was_read_at() {
        let root = temp_root();
        let empty = roster_load(&root).unwrap();
        assert_eq!(empty.text, None);
        let first = r#"{"version":1,"monos":[{"id":"ada","sessionId":"df9afb39"}]}"#;
        let hash = roster_save(&root, first, Some(&empty.hash)).unwrap();
        assert_eq!(roster_load(&root).unwrap().text.as_deref(), Some(first));
        assert_eq!(
            roster_save(&root, first, Some(&empty.hash)),
            Err(CONFLICT.into())
        );
        assert!(roster_save(&root, r#"{"monos":[{"id":"a"},{"id":"a"}]}"#, None).is_err());
        assert!(roster_save(&root, r#"{"monos":[{"id":"../x"}]}"#, Some(&hash)).is_err());
        assert_eq!(roster_load(&root).unwrap().hash, hash);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_monos_own_places_are_named_by_its_id_alone() {
        let (root, data) = (
            Path::new("/home/me/agent-memory/monos"),
            Path::new("/data/app"),
        );
        assert_eq!(
            mono_places(root, data, "ada"),
            vec![
                PathBuf::from("/home/me/agent-memory/monos/ada"),
                PathBuf::from("/data/app/mono-teams/ada")
            ]
        );
        for bad in ["", "..", "../x", "a/b", "a b", "/etc"] {
            assert!(mono_places(root, data, bad).is_empty(), "{bad:?}");
        }
    }

    #[test]
    fn home_info_says_whether_the_monos_live_in_the_permanent_home() {
        let data = temp_root();
        assert!(!home_info(&data.join(MONOS_DIR), &data).permanent);
        let home = data.join("agent-memory/monos");
        mono_home::ensure_home(&home, &data.join(MONOS_DIR), "1").unwrap();
        let info = home_info(&home, &data);
        assert!(info.permanent);
        assert!(info.migration.is_some());
        std::fs::remove_dir_all(data).unwrap();
    }
}

// The long-chat tree (monoTree.ts, "Keep one long chat"): `memory/tree/` in the Mono's folder, made by the app the
// first time it is read. Only day logs (`main/` and `tree/`, `YYYY-MM-DD.jsonl`, appended to and never rewritten) and
// `view.json` (replaced whole) live there; nothing else can be written through these commands. Workers never get
// them: they are the app's own calls, not tools.

const TREE_DIR: &str = "tree";
const TREE_VIEW: &str = "view.json";
const TREE_OP_MAX: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeFile {
    /// Relative to `memory/tree/`: `main/<day>.jsonl`, `tree/<day>.jsonl` or `view.json`.
    pub path: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeOp {
    pub path: String,
    pub text: String,
    /// Add to the end (day logs), else replace whole (view.json).
    pub append: bool,
}

/// A day log's name: `main/2026-10-21.jsonl` or `tree/2026-10-21.jsonl`.
fn tree_log_path(path: &str) -> bool {
    let Some((stream, file)) = path.split_once('/') else {
        return false;
    };
    let Some(day) = file.strip_suffix(".jsonl") else {
        return false;
    };
    let b = day.as_bytes();
    (stream == "main" || stream == "tree")
        && b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(k, c)| k == 4 || k == 7 || c.is_ascii_digit())
}

fn tree_dir(root: &Path, mono: &str, legacy_project: Option<&str>) -> Result<PathBuf, String> {
    let dir = agent_dir(root, mono, legacy_project)?
        .join(MEMORY_DIR)
        .join(TREE_DIR);
    for stream in ["main", "tree"] {
        let folder = dir.join(stream);
        std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    }
    Ok(dir)
}

fn tree_load(
    root: &Path,
    mono: &str,
    legacy_project: Option<&str>,
) -> Result<Vec<TreeFile>, String> {
    let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = tree_dir(root, mono, legacy_project)?;
    let mut files = Vec::new();
    for stream in ["main", "tree"] {
        let folder = dir.join(stream);
        let mut names: Vec<String> = std::fs::read_dir(&folder)
            .map_err(|e| format!("{}: {e}", folder.display()))?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| tree_log_path(&format!("{stream}/{name}")))
            .collect();
        names.sort();
        for name in names {
            let path = format!("{stream}/{name}");
            if let Some(text) = read_optional(&dir.join(&path))? {
                files.push(TreeFile { path, text });
            }
        }
    }
    if let Some(text) = read_optional(&dir.join(TREE_VIEW))? {
        files.push(TreeFile {
            path: TREE_VIEW.into(),
            text,
        });
    }
    Ok(files)
}

fn tree_write(
    root: &Path,
    mono: &str,
    legacy_project: Option<&str>,
    ops: &[TreeOp],
) -> Result<(), String> {
    use std::io::Write;

    let _guard = FILES_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = tree_dir(root, mono, legacy_project)?;
    for op in ops {
        if op.text.len() > TREE_OP_MAX || op.text.contains('\0') {
            return Err(format!("{} is too large or has a NUL byte", op.path));
        }
        let path = dir.join(&op.path);
        if op.append && tree_log_path(&op.path) {
            let mut options = std::fs::OpenOptions::new();
            options.append(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&path)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            file.write_all(op.text.as_bytes())
                .and_then(|_| file.sync_data())
                .map_err(|e| format!("{}: {e}", path.display()))?;
        } else if !op.append && op.path == TREE_VIEW {
            serde_json::from_str::<serde_json::Value>(&op.text)
                .map_err(|e| format!("view.json isn't valid JSON ({e})"))?;
            write_atomic(&path, &op.text)?;
        } else {
            return Err(format!("{} can't be written in a Mono's tree", op.path));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mono_tree_load(
    app: AppHandle,
    mono: String,
    legacy_project: Option<String>,
) -> Result<Vec<TreeFile>, String> {
    let root = monos_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || tree_load(&root, &mono, legacy_project.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mono_tree_write(
    app: AppHandle,
    mono: String,
    legacy_project: Option<String>,
    ops: Vec<TreeOp>,
) -> Result<(), String> {
    let root = monos_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        tree_write(&root, &mono, legacy_project.as_deref(), &ops)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tree_tests {
    use super::tests_support::temp_root;
    use super::*;

    #[test]
    fn a_tree_is_made_on_first_read_and_takes_only_day_logs_and_its_view() {
        let root = temp_root();
        assert!(tree_load(&root, "mono-a", None).unwrap().is_empty());
        assert!(root.join("mono-a/memory/tree/main").is_dir());
        assert!(root.join("mono-a/memory/tree/tree").is_dir());
        let op = |path: &str, text: &str, append: bool| TreeOp {
            path: path.into(),
            text: text.into(),
            append,
        };
        tree_write(
            &root,
            "mono-a",
            None,
            &[op("main/2026-10-21.jsonl", "{\"a\":1}\n", true)],
        )
        .unwrap();
        tree_write(
            &root,
            "mono-a",
            None,
            &[op("main/2026-10-21.jsonl", "{\"a\":2}\n", true)],
        )
        .unwrap();
        tree_write(
            &root,
            "mono-a",
            None,
            &[op("view.json", "{\"parts\":[]}", false)],
        )
        .unwrap();
        let files = tree_load(&root, "mono-a", None).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "main/2026-10-21.jsonl");
        assert_eq!(files[0].text, "{\"a\":1}\n{\"a\":2}\n");
        assert_eq!(files[1].path, "view.json");
        for bad in [
            op("../MEMORY.md", "x", true),
            op("main/../../SOUL.md", "x", true),
            op("main/notes.jsonl", "x", true),
            op("other/2026-10-21.jsonl", "x", true),
            op("main/2026-10-21.jsonl", "x", false),
            op("view.json", "x", true),
            op("view.json", "not json", false),
        ] {
            assert!(tree_write(&root, "mono-a", None, &[bad]).is_err());
        }
        assert_eq!(
            std::fs::read_to_string(root.join("mono-a/MEMORY.md")).unwrap(),
            ""
        );
        assert!(tree_load(&root, "mono-b", None).unwrap().is_empty());
    }
}
