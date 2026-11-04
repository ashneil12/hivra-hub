//! WP-43. One browser profile per agent, under this app's data folder, and a Stop for a browser that is showing.
//!
//! The plugin process (`plugins/browser`) is what talks to the browser. This module only keeps the profile folders,
//! the person's choices, and the drive records Stop needs. A folder the person chose is remembered, never deleted.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

const TRY_SETTINGS: &str = "The browser settings couldn't be saved. Try again.";
const TRY_PROFILE: &str = "The browser profile couldn't be made. Try again.";
const NOT_OURS: &str = "That process isn't this browser session. It was not stopped.";
const NOT_CHECKED: &str = "Couldn't check that process. It was not stopped. Try again.";
const NOT_YET: &str = "It hasn't stopped yet.";
/// The process has exited and has not been reaped. It is not another session.
const DEPARTED: &str = "departed";

/// A profile the Settings list can show. `path` is the folder Playwright uses.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub watch: bool,
    pub own: bool,
    pub path: String,
}

/// A browser that is showing. The process id and the session token stay on disk.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub id: String,
    pub agent_id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Settings {
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    watch: BTreeMap<String, bool>,
    /// Untrusted. Only `{ "path", "chosen": true }` is a real choice; anything else is ignored.
    #[serde(default)]
    own: BTreeMap<String, Value>,
    #[serde(default)]
    names: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct StoredDrive {
    id: String,
    agent_id: String,
    name: String,
    pid: u32,
    token: String,
    visible: bool,
    started_at_ms: u64,
    /// Epoch seconds from `plugins/browser/startTime.mjs`, captured when this session was recorded.
    /// A later process that reused the pid will not match, so Stop does not signal it.
    /// A start string in another form is not a match and is not "gone".
    #[serde(default)]
    process_start: String,
    /// Written by the wrapper only after its browser tree is confirmed gone. Empty when this
    /// drive is the browser itself, and the process leaving is enough.
    #[serde(default)]
    done_path: String,
}

pub(crate) struct LaunchEnv {
    pub profile: PathBuf,
    pub headless: bool,
    pub own: bool,
    pub visible: bool,
    pub token: String,
    pub name: String,
    /// The wrapper writes this file only once its browser tree is confirmed gone.
    pub done: PathBuf,
}

#[cfg(test)]
type SettingsWriteHook = Box<dyn FnMut(&Path)>;

#[cfg(test)]
thread_local! {
    static BEFORE_SETTINGS_WRITE: std::cell::RefCell<Option<SettingsWriteHook>> =
        const { std::cell::RefCell::new(None) };
}

#[derive(Serialize, Deserialize)]
struct LockOwner {
    nonce: String,
    pid: u32,
    started: String,
}

struct SettingsLock {
    path: PathBuf,
    nonce: String,
}

impl Drop for SettingsLock {
    fn drop(&mut self) {
        // A holder that lost the file (another window replaced it) must not delete the new one.
        if read_lock(&self.path).is_some_and(|owner| owner.nonce == self.nonce) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn browser_dir(data: &Path) -> PathBuf {
    data.join("browser")
}

fn profiles_dir(data: &Path) -> PathBuf {
    data.join("browser-profiles")
}

fn drives_dir(data: &Path) -> PathBuf {
    browser_dir(data).join("drives")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// An id safe to join onto the profiles folder: no slash, no `..`, no leading dot.
pub(crate) fn check_agent_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 120
        && !id.starts_with('.')
        && !id.contains("..")
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if ok {
        Ok(())
    } else {
        Err("That browser profile isn't one this app made.".into())
    }
}

fn is_fs_root(path: &Path) -> bool {
    !path
        .components()
        .any(|component| matches!(component, Component::Normal(_)))
}

fn is_home(path: &Path) -> bool {
    dirs::home_dir()
        .and_then(|home| crate::fs::canonical(&home).ok())
        .is_some_and(|home| home == path)
}

fn rejects_folder(chosen: &Path, profiles: &Path) -> Option<&'static str> {
    if is_fs_root(chosen) {
        return Some("That folder is too broad. Choose one inside it.");
    }
    if is_home(chosen) {
        return Some("That folder is your home. Choose a folder inside it.");
    }
    if chosen == profiles || profiles.starts_with(chosen) || chosen.starts_with(profiles) {
        return Some("That folder is already used for browser profiles. Choose a different one.");
    }
    None
}

fn profiles_root(data: &Path) -> Result<PathBuf, String> {
    let dir = profiles_dir(data);
    std::fs::create_dir_all(&dir).map_err(|_| TRY_PROFILE.to_string())?;
    crate::fs::canonical(&dir).map_err(|_| TRY_PROFILE.to_string())
}

fn has_parent_dir(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

/// A stored choice this app is willing to use. A hand-edited value is not.
fn own_text(settings: &Settings, id: &str) -> Option<String> {
    let object = settings.own.get(id)?.as_object()?;
    if !object.get("chosen")?.as_bool()? {
        return None;
    }
    let path = object.get("path")?.as_str()?.trim();
    let path = Path::new(path);
    if path.as_os_str().is_empty() || !path.is_absolute() || has_parent_dir(path) {
        return None;
    }
    Some(path_text(path))
}

fn usable_own(data: &Path, settings: &Settings, id: &str) -> Option<PathBuf> {
    let text = own_text(settings, id)?;
    let path = PathBuf::from(&text);
    if !path.is_dir() {
        return None;
    }
    let canon = crate::fs::canonical(&path).ok()?;
    let profiles = profiles_root(data).ok()?;
    if rejects_folder(&canon, &profiles).is_some() {
        return None;
    }
    Some(canon)
}

fn validate_own(data: &Path, text: &str) -> Result<PathBuf, String> {
    let path = Path::new(text.trim());
    if !path.is_absolute() {
        return Err("Choose a full path.".into());
    }
    if !path.is_dir() {
        return Err("That folder isn't there.".into());
    }
    let canon = crate::fs::canonical(path).map_err(|_| "That folder isn't there.".to_string())?;
    if !canon.is_dir() {
        return Err("That folder isn't there.".into());
    }
    let profiles = profiles_root(data)?;
    if let Some(why) = rejects_folder(&canon, &profiles) {
        return Err(why.into());
    }
    Ok(canon)
}

fn read_lock(path: &Path) -> Option<LockOwner> {
    let text = std::fs::read_to_string(path).ok()?;
    let owner: LockOwner = serde_json::from_str(&text).ok()?;
    if owner.nonce.is_empty() || pid_i32(owner.pid).is_none() {
        return None;
    }
    Some(owner)
}

fn settings_data(dir: &Path) -> &Path {
    dir.parent().unwrap_or(dir)
}

fn lock_data(path: &Path) -> &Path {
    path.parent().and_then(Path::parent).unwrap_or(path)
}

/// Alive, and still the process that took the lock. A reused pid, or a start time we can't
/// match, is not the holder. An empty start time matches nothing: a crash while `ps` failed
/// must not look like every later process. If the start time can't be read now, or the stored
/// text is not epoch seconds, a live pid is treated as the holder so a flaky read doesn't
/// give the lock away.
fn owner_alive(data: &Path, owner: &LockOwner) -> bool {
    if !alive(owner.pid) || owner.started.is_empty() {
        return false;
    }
    match process_start(data, owner.pid) {
        // A clock string and an epoch are not proof that the pid was reused.
        Ok(started) => same_start(&owner.started, &started).unwrap_or(true),
        Err(_) => true,
    }
}

fn lock_aside(path: &Path) -> PathBuf {
    path.with_file_name(format!("settings.lock.dead-{}", uuid::Uuid::new_v4()))
}

fn put_lock_back(path: &Path, aside: &Path) {
    if path.exists() {
        let _ = std::fs::remove_file(aside);
        return;
    }
    if std::fs::rename(aside, path).is_err() {
        let _ = std::fs::remove_file(aside);
    }
}

/// Move a dead holder's lock aside, confirm it is still that lock, then delete the copy.
fn release_dead_lock(path: &Path, nonce: &str) -> bool {
    let aside = lock_aside(path);
    if std::fs::rename(path, &aside).is_err() {
        return false;
    }
    match read_lock(&aside) {
        Some(owner) if owner.nonce == nonce && !owner_alive(lock_data(path), &owner) => {
            let _ = std::fs::remove_file(&aside);
            true
        }
        _ => {
            put_lock_back(path, &aside);
            false
        }
    }
}

/// A lock that isn't ours (a crash, or a hand edit). Never delete one that turns out to be live.
fn release_unreadable_lock(path: &Path) -> bool {
    let aside = lock_aside(path);
    if std::fs::rename(path, &aside).is_err() {
        return false;
    }
    if read_lock(&aside).is_some_and(|owner| owner_alive(lock_data(path), &owner)) {
        put_lock_back(path, &aside);
        return false;
    }
    let _ = std::fs::remove_file(&aside);
    true
}

fn claim_lock(dir: &Path, path: &Path, body: &[u8], nonce: &str) -> std::io::Result<bool> {
    let claim = dir.join(format!("settings.lock.claim-{nonce}"));
    let written = std::fs::File::create(&claim).and_then(|mut file| {
        file.write_all(body)?;
        file.sync_all()
    });
    if let Err(error) = written {
        let _ = std::fs::remove_file(&claim);
        return Err(error);
    }
    match std::fs::hard_link(&claim, path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&claim);
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&claim);
            Ok(false)
        }
        Err(_) => {
            let _ = std::fs::remove_file(&claim);
            match OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(mut file) => {
                    file.write_all(body)?;
                    file.sync_all()?;
                    Ok(true)
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(error) => Err(error),
            }
        }
    }
}

fn lock_settings(dir: &Path) -> Result<SettingsLock, String> {
    std::fs::create_dir_all(dir).map_err(|_| TRY_SETTINGS.to_string())?;
    let path = dir.join("settings.lock");
    for _ in 0..100 {
        let nonce = uuid::Uuid::new_v4().to_string();
        let started = match process_start(settings_data(dir), std::process::id()) {
            Ok(started) if !started.is_empty() => started,
            _ => return Err(TRY_SETTINGS.into()),
        };
        let body = serde_json::to_vec(&LockOwner {
            nonce: nonce.clone(),
            pid: std::process::id(),
            started,
        })
        .map_err(|error| error.to_string())?;
        match claim_lock(dir, &path, &body, &nonce) {
            Ok(true) => return Ok(SettingsLock { path, nonce }),
            Ok(false) => match read_lock(&path) {
                Some(owner) if owner_alive(settings_data(dir), &owner) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Some(owner) => {
                    let _ = release_dead_lock(&path, &owner.nonce);
                }
                None => {
                    let _ = release_unreadable_lock(&path);
                }
            },
            Err(_) => return Err(TRY_SETTINGS.into()),
        }
    }
    Err("The browser settings are busy. Try again.".into())
}

fn read_settings(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let written = std::fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(text.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()
    });
    if let Err(error) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{TRY_SETTINGS} {error}"));
    }
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("{TRY_SETTINGS} {error}")
    })
}

fn with_settings<T>(
    data: &Path,
    mut change: impl FnMut(&mut Settings) -> Result<T, String>,
) -> Result<T, String> {
    let dir = browser_dir(data);
    let lock = lock_settings(&dir)?;
    let path = dir.join("settings.json");
    for _ in 0..5 {
        if read_lock(&lock.path).is_none_or(|owner| owner.nonce != lock.nonce) {
            return Err("The browser settings are busy. Try again.".into());
        }
        let mut settings = read_settings(&path);
        let seen = settings.revision;
        let result = change(&mut settings)?;
        settings.revision = seen.saturating_add(1);
        #[cfg(test)]
        BEFORE_SETTINGS_WRITE.with(|hook| {
            if let Some(run) = hook.borrow_mut().as_mut() {
                run(&path);
            }
        });
        if read_lock(&lock.path).is_none_or(|owner| owner.nonce != lock.nonce) {
            return Err("The browser settings are busy. Try again.".into());
        }
        if read_settings(&path).revision != seen {
            continue;
        }
        write_settings(&path, &settings)?;
        drop(lock);
        return Ok(result);
    }
    Err("The browser settings are busy. Try again.".into())
}

fn display_name(settings: &Settings, id: &str) -> String {
    settings
        .names
        .get(id)
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or(id)
        .to_string()
}

fn remember_name(settings: &mut Settings, id: &str, name: &str) {
    let name: String = name.trim().chars().take(80).collect();
    if !name.is_empty() {
        settings.names.insert(id.to_string(), name);
    }
}

fn profile_row(data: &Path, settings: &Settings, id: &str) -> Profile {
    let stored = own_text(settings, id);
    let path = usable_own(data, settings, id)
        .or_else(|| stored.as_ref().map(PathBuf::from))
        .unwrap_or_else(|| profiles_dir(data).join(id));
    Profile {
        id: id.to_string(),
        name: display_name(settings, id),
        watch: settings.watch.get(id).copied().unwrap_or(false),
        own: stored.is_some(),
        path: path_text(&path),
    }
}

fn inside_profiles(path: &Path, profiles: &Path) -> bool {
    let Ok(path) = crate::fs::canonical(path) else {
        return false;
    };
    let Ok(profiles) = crate::fs::canonical(profiles) else {
        return false;
    };
    path.starts_with(&profiles) && path != profiles
}

/// Real profile folders, plus a chosen folder that has no folder of ours yet.
pub fn list_profiles(data: &Path) -> Result<Vec<Profile>, String> {
    let settings = read_settings(&browser_dir(data).join("settings.json"));
    let profiles = profiles_dir(data);
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    if profiles.is_dir() {
        for entry in std::fs::read_dir(&profiles)
            .map_err(|error| error.to_string())?
            .flatten()
        {
            let Some(id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if check_agent_id(&id).is_err() {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.file_type().is_symlink()
                || !meta.is_dir()
                || !inside_profiles(&entry.path(), &profiles)
            {
                continue;
            }
            seen.insert(id.clone());
            out.push(profile_row(data, &settings, &id));
        }
    }
    for id in settings.own.keys() {
        if seen.contains(id) || check_agent_id(id).is_err() || own_text(&settings, id).is_none() {
            continue;
        }
        out.push(profile_row(data, &settings, id));
    }
    out.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(out)
}

fn ensure_profile_dir(data: &Path, id: &str) -> Result<PathBuf, String> {
    check_agent_id(id)?;
    let profiles = profiles_root(data)?;
    let dir = profiles.join(id);
    std::fs::create_dir_all(&dir).map_err(|_| TRY_PROFILE.to_string())?;
    let made = crate::fs::canonical(&dir).map_err(|_| TRY_PROFILE.to_string())?;
    if !made.starts_with(&profiles) || made == profiles {
        return Err(TRY_PROFILE.into());
    }
    Ok(made)
}

pub fn set_watch(data: &Path, id: &str, watch: bool) -> Result<Vec<Profile>, String> {
    check_agent_id(id)?;
    ensure_profile_dir(data, id)?;
    with_settings(data, |settings| {
        settings.watch.insert(id.to_string(), watch);
        Ok(())
    })?;
    list_profiles(data)
}

pub fn choose_own(data: &Path, id: &str, path: Option<&str>) -> Result<Vec<Profile>, String> {
    check_agent_id(id)?;
    let chosen = match path.map(str::trim).filter(|text| !text.is_empty()) {
        None => None,
        Some(text) => Some(validate_own(data, text)?),
    };
    with_settings(data, |settings| {
        match &chosen {
            Some(folder) => {
                settings.own.insert(
                    id.to_string(),
                    json!({ "path": path_text(folder), "chosen": true }),
                );
            }
            None => {
                settings.own.remove(id);
            }
        }
        Ok(())
    })?;
    list_profiles(data)
}

/// Forget a chosen folder without deleting it. Otherwise remove the folder this app made.
pub fn clear_profile(data: &Path, id: &str) -> Result<Vec<Profile>, String> {
    check_agent_id(id)?;
    let had_own = with_settings(data, |settings| {
        let had = own_text(settings, id).is_some();
        settings.own.remove(id);
        Ok(had)
    })?;
    if !had_own {
        remove_profile_dir(data, id)?;
    }
    list_profiles(data)
}

fn remove_profile_dir(data: &Path, id: &str) -> Result<(), String> {
    check_agent_id(id)?;
    let profiles = profiles_dir(data);
    let entry = profiles.join(id);
    let meta = match std::fs::symlink_metadata(&entry) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("{TRY_PROFILE} {error}")),
    };
    let parent = entry
        .parent()
        .ok_or_else(|| "That profile isn't in the browser profiles folder.".to_string())?;
    let parent = crate::fs::canonical(parent).map_err(|error| error.to_string())?;
    let root = crate::fs::canonical(&profiles).map_err(|error| error.to_string())?;
    if parent != root {
        return Err("That profile isn't in the browser profiles folder.".into());
    }
    if meta.file_type().is_symlink() {
        return std::fs::remove_file(&entry).map_err(|error| error.to_string());
    }
    if meta.is_dir() {
        let canon = crate::fs::canonical(&entry).map_err(|error| error.to_string())?;
        if !canon.starts_with(&root) || canon == root {
            return Err("That profile isn't in the browser profiles folder.".into());
        }
        return std::fs::remove_dir_all(&canon).map_err(|error| error.to_string());
    }
    std::fs::remove_file(&entry).map_err(|error| error.to_string())
}

fn decide(data: &Path, id: &str, name: &str) -> Result<(bool, Option<PathBuf>, String), String> {
    check_agent_id(id)?;
    with_settings(data, |settings| {
        remember_name(settings, id, name);
        let watch = settings.watch.get(id).copied().unwrap_or(false);
        let own = usable_own(data, settings, id);
        let stored = display_name(settings, id);
        Ok((watch, own, stored))
    })
}

pub(crate) fn launch_env(data: &Path, id: &str, name: &str) -> Result<LaunchEnv, String> {
    let (watch, own, stored) = decide(data, id, name)?;
    // A folder the person chose is the profile. The in-app folder is only made when there isn't one.
    let (profile, using_own) = match own {
        Some(folder) => (folder, true),
        None => (ensure_profile_dir(data, id)?, false),
    };
    let token = format!("hivra-{}", uuid::Uuid::new_v4());
    let done = drives_dir(data).join(format!("{token}.gone"));
    Ok(LaunchEnv {
        profile,
        headless: !watch,
        own: using_own,
        visible: watch,
        token,
        name: stored,
        done,
    })
}

/// The token `launch_env` mints: `hivra-` plus one lowercase version-4 uuid. Anything else is not a session.
fn minted_token(token: &str) -> bool {
    let Some(rest) = token.strip_prefix("hivra-") else {
        return false;
    };
    let Ok(id) = uuid::Uuid::parse_str(rest) else {
        return false;
    };
    id.get_version_num() == 4 && id.hyphenated().to_string() == rest
}

fn record_drive(data: &Path, drive: &StoredDrive) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(&drive.id).is_err() || !minted_token(&drive.token) {
        return Err("The browser session couldn't be recorded. Try again.".into());
    }
    let dir = drives_dir(data);
    std::fs::create_dir_all(&dir)
        .map_err(|_| "The browser session couldn't be recorded. Try again.".to_string())?;
    let path = dir.join(format!("{}.json", drive.id));
    let bytes = serde_json::to_vec_pretty(drive).map_err(|error| error.to_string())?;
    // A complete file, then a link that fails if this drive is already recorded. Readers never see a half-written one.
    let tmp = dir.join(format!(".{}.tmp-{}", drive.id, std::process::id()));
    let written = std::fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(&bytes)?;
        file.sync_all()
    });
    if let Err(error) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "The browser session couldn't be recorded. Try again. {error}"
        ));
    }
    match std::fs::hard_link(&tmp, &path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&tmp);
            Ok(path)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&tmp);
            Err("The browser session couldn't be recorded. Try again.".into())
        }
        Err(_) => {
            let created = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .and_then(|mut file| {
                    file.write_all(&bytes)?;
                    file.sync_all()
                });
            let _ = std::fs::remove_file(&tmp);
            created.map(|_| path).map_err(|error| {
                format!("The browser session couldn't be recorded. Try again. {error}")
            })
        }
    }
}

fn load_drive(path: &Path) -> Option<StoredDrive> {
    let id = path.file_stem()?.to_str()?;
    if uuid::Uuid::parse_str(id).is_err() {
        return None;
    }
    let drive: StoredDrive = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    if drive.id != id || !minted_token(&drive.token) {
        return None;
    }
    Some(drive)
}

fn drive_path(data: &Path, id: &str) -> Option<PathBuf> {
    if uuid::Uuid::parse_str(id).is_err() {
        return None;
    }
    Some(drives_dir(data).join(format!("{id}.json")))
}

fn tracked_tree(data: &Path, token: &str) -> Option<PathBuf> {
    if !minted_token(token) {
        return None;
    }
    Some(drives_dir(data).join(format!("{token}.tree")))
}

fn remove_tracked_tree(dir: &Path, token: &str) {
    if minted_token(token) {
        let _ = std::fs::remove_file(dir.join(format!("{token}.tree")));
    }
}

fn remove_if_same(path: &Path, token: &str) {
    if load_drive(path).is_some_and(|drive| drive.token == token) {
        let _ = std::fs::remove_file(path);
        if let Some(dir) = path.parent() {
            remove_tracked_tree(dir, token);
        }
    }
}

fn as_drive(drive: StoredDrive) -> Drive {
    Drive {
        id: drive.id,
        agent_id: drive.agent_id,
        name: drive.name,
    }
}

fn read_drives(data: &Path) -> Result<Vec<StoredDrive>, String> {
    let dir = drives_dir(data);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        match load_drive(&path) {
            // A dead wrapper that never wrote its done file still owns a browser.
            // Listing drives must not forget it.
            Some(drive) if alive(drive.pid) || owed_browser(data, &drive) => out.push(drive),
            Some(drive) => {
                if tree_confirmed(data, &drive) {
                    if let Some(dir) = path.parent() {
                        remove_tracked_tree(dir, &drive.token);
                    }
                }
                let _ = std::fs::remove_file(&path);
            }
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(out)
}

pub fn visible_drives(data: &Path) -> Result<Vec<Drive>, String> {
    Ok(read_drives(data)?
        .into_iter()
        .filter(|drive| drive.visible)
        .map(as_drive)
        .collect())
}

fn allow_path(command: &mut Command) {
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    command.stdin(Stdio::null());
}

fn token_in(line: &str, token: &str) -> bool {
    !token.is_empty() && line.split_whitespace().any(|word| word == token)
}

fn pid_i32(pid: u32) -> Option<i32> {
    i32::try_from(pid).ok().filter(|pid| *pid >= 2)
}

#[cfg(unix)]
fn reap(pid: u32) {
    let Some(pid) = pid_i32(pid) else { return };
    unsafe {
        let mut status = 0;
        libc::waitpid(pid, &mut status, libc::WNOHANG);
    }
}

#[cfg(not(unix))]
fn reap(_pid: u32) {}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    let Some(pid) = pid_i32(pid) else {
        return false;
    };
    reap(pid as u32);
    // A zombie still answers kill(0). The app is not its parent, so waitpid cannot reap it.
    // It has already exited. It is not a live session.
    if is_zombie(pid as u32) {
        return false;
    }
    unsafe {
        if libc::kill(pid, 0) == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

#[cfg(not(unix))]
fn alive(pid: u32) -> bool {
    if pid_i32(pid).is_none() {
        return false;
    }
    let mut command = Command::new("tasklist");
    command.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]);
    allow_path(&mut command);
    command
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
        .unwrap_or(true)
}

#[cfg(unix)]
fn command_line(pid: u32) -> Result<String, String> {
    let Some(pid) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let mut command = Command::new("ps");
    command.args(["-ww", "-p", &pid.to_string(), "-o", "command="]);
    allow_path(&mut command);
    let out = command.output().map_err(|_| NOT_CHECKED.to_string())?;
    if !out.status.success() {
        return Err(NOT_CHECKED.into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(not(unix))]
fn command_line(pid: u32) -> Result<String, String> {
    let Some(pid) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine"),
    ]);
    allow_path(&mut command);
    let out = command.output().map_err(|_| NOT_CHECKED.to_string())?;
    if !out.status.success() {
        return Err(NOT_CHECKED.into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn helper_file(path: &Path) -> bool {
    path.is_file() && path.file_name().is_some_and(|name| name == "startTime.mjs")
}

/// The wrapper and Stop both run this file. The installed copy wins, so a shipped
/// app does not depend on the tree it was built from. Tests fall back to that tree.
fn start_helper(data: &Path) -> Result<PathBuf, String> {
    let installed = data
        .join("plugins")
        .join("installed")
        .join("browser")
        .join("startTime.mjs");
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/browser/startTime.mjs");
    let path = if helper_file(&installed) {
        installed
    } else if helper_file(&bundled) {
        bundled
    } else {
        return Err(NOT_CHECKED.into());
    };
    let path = crate::fs::canonical(&path).map_err(|_| NOT_CHECKED.to_string())?;
    if !helper_file(&path) {
        return Err(NOT_CHECKED.into());
    }
    Ok(path)
}

fn is_epoch(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// `Ok(true)` is the same start. `Ok(false)` is a confirmed different process: both
/// values are epoch seconds and they differ. Any other pair is not comparable, and
/// that must not be reported as gone.
fn same_start(recorded: &str, now: &str) -> Result<bool, String> {
    let recorded = recorded.trim();
    let now = now.trim();
    if recorded.is_empty() || now.is_empty() {
        return Err(NOT_CHECKED.into());
    }
    if recorded == now {
        return Ok(true);
    }
    if is_epoch(recorded) && is_epoch(now) {
        return Ok(false);
    }
    Err(NOT_CHECKED.into())
}

/// Epoch seconds, via the same helper the wrapper uses. A missing helper or a
/// non-numeric reply is "couldn't check", not a start time.
fn process_start(data: &Path, pid: u32) -> Result<String, String> {
    let Some(pid) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let helper = start_helper(data)?;
    let mut command = Command::new("node");
    command.arg(&helper).arg(pid.to_string());
    allow_path(&mut command);
    let out = command.output().map_err(|_| NOT_CHECKED.to_string())?;
    if !out.status.success() {
        return Err(NOT_CHECKED.into());
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !is_epoch(&text) {
        return Err(NOT_CHECKED.into());
    }
    Ok(text)
}

#[cfg(unix)]
fn list_group(pid: u32) -> Result<Vec<u32>, String> {
    let Some(raw) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let group = unsafe { libc::getpgid(raw) };
    if group < 2 || group != raw {
        return Ok(vec![pid]);
    }
    let mut command = Command::new("ps");
    command.args(["-g", &group.to_string(), "-o", "pid="]);
    allow_path(&mut command);
    let out = command.output().map_err(|_| NOT_CHECKED.to_string())?;
    if !out.status.success() {
        return Err(NOT_CHECKED.into());
    }
    let mut pids = Vec::new();
    for word in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        if let Ok(id) = word.parse::<u32>() {
            if pid_i32(id).is_some() {
                pids.push(id);
            }
        }
    }
    if pids.is_empty() {
        pids.push(pid);
    }
    Ok(pids)
}

#[cfg(not(unix))]
fn list_group(pid: u32) -> Result<Vec<u32>, String> {
    let Some(raw) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!("(Get-CimInstance Win32_Process -Filter \"ParentProcessId={raw}\").ProcessId"),
    ]);
    allow_path(&mut command);
    let Ok(out) = command.output() else {
        return Ok(vec![pid]);
    };
    if !out.status.success() {
        return Ok(vec![pid]);
    }
    let mut pids = vec![pid];
    for word in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        if let Ok(id) = word.parse::<u32>() {
            if pid_i32(id).is_some() && id != pid {
                pids.push(id);
            }
        }
    }
    Ok(pids)
}

/// The session, plus its group only when every member's command line carries this token.
fn targets_for(pid: u32, token: &str) -> Vec<u32> {
    let Ok(group) = list_group(pid) else {
        return vec![pid];
    };
    if group.len() <= 1 {
        return vec![pid];
    }
    let ours = group.iter().copied().all(|member| {
        command_line(member)
            .ok()
            .is_some_and(|line| token_in(&line, token))
    });
    if ours {
        group
    } else {
        vec![pid]
    }
}

#[cfg(unix)]
fn process_state(pid: u32) -> Result<String, String> {
    let Some(pid) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let mut command = Command::new("ps");
    command.args(["-p", &pid.to_string(), "-o", "state="]);
    allow_path(&mut command);
    let out = command.output().map_err(|_| NOT_CHECKED.to_string())?;
    if !out.status.success() {
        return Err(NOT_CHECKED.into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(unix)]
fn is_zombie(pid: u32) -> bool {
    process_state(pid)
        .ok()
        .is_some_and(|state| state.starts_with('Z'))
}

#[cfg(not(unix))]
fn is_zombie(_pid: u32) -> bool {
    false
}

fn defunct_line(line: &str) -> bool {
    let text = line.trim();
    text.contains("<defunct>") || text.contains("(defunct)")
}

fn confirm_session(data: &Path, pid: u32, token: &str, started: &str) -> Result<(), String> {
    if !minted_token(token) {
        return Err(NOT_OURS.into());
    }
    if is_zombie(pid) {
        return Err(DEPARTED.into());
    }
    let line = command_line(pid)?;
    if defunct_line(&line) {
        return Err(DEPARTED.into());
    }
    if line.trim().is_empty() {
        return Err(NOT_CHECKED.into());
    }
    if !token_in(&line, token) {
        return Err(NOT_OURS.into());
    }
    if started.is_empty() {
        return Err(NOT_OURS.into());
    }
    let now = process_start(data, pid)?;
    match same_start(started, &now) {
        Ok(true) => Ok(()),
        Ok(false) => Err(NOT_OURS.into()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn kill_one(pid: u32, kill: bool) -> Result<(), String> {
    let Some(pid) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let sig = if kill { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        if libc::kill(pid, sig) != 0 && alive(pid as u32) {
            return Err("Couldn't stop that browser. Try again.".into());
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn kill_one(pid: u32, kill: bool) -> Result<(), String> {
    let Some(pid) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let mut command = Command::new("taskkill");
    command.arg("/PID").arg(pid.to_string());
    if kill {
        command.arg("/F");
    }
    allow_path(&mut command);
    let out = command
        .output()
        .map_err(|_| "Couldn't stop that browser. Try again.".to_string())?;
    if out.status.success() || !alive(pid as u32) {
        Ok(())
    } else {
        Err("Couldn't stop that browser. Try again.".into())
    }
}

/// Re-check the session, then signal only pids that still carry the token. Never a whole group
/// unless every member is this browser.
fn signal(data: &Path, pid: u32, token: &str, started: &str, kill: bool) -> Result<(), String> {
    confirm_session(data, pid, token, started)?;
    let targets = targets_for(pid, token);
    for target in &targets {
        if *target == pid {
            confirm_session(data, *target, token, started)?;
        } else {
            let line = command_line(*target)?;
            if !token_in(&line, token) {
                return Err(NOT_OURS.into());
            }
        }
        kill_one(*target, kill)?;
    }
    Ok(())
}

fn wait_gone(pid: u32, ms: u64) -> bool {
    let start = std::time::Instant::now();
    loop {
        if !alive(pid) {
            return true;
        }
        if start.elapsed() >= Duration::from_millis(ms) {
            return !alive(pid);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn done_file(data: &Path, token: &str) -> Option<PathBuf> {
    if !minted_token(token) {
        return None;
    }
    Some(drives_dir(data).join(format!("{token}.gone")))
}

/// A wrapper records a done file and Stop trusts it only at that exact path.
fn tree_confirmed(data: &Path, drive: &StoredDrive) -> bool {
    if drive.done_path.is_empty() {
        return true;
    }
    let Some(expected) = done_file(data, &drive.token) else {
        return false;
    };
    Path::new(&drive.done_path) == expected.as_path() && expected.is_file()
}

/// The wrapper has a browser to account for, and has not confirmed it is gone.
fn owed_browser(data: &Path, drive: &StoredDrive) -> bool {
    !drive.done_path.is_empty() && !tree_confirmed(data, drive)
}

fn finish_gone(data: &Path, path: &Path, drive: &StoredDrive) -> Result<(), String> {
    if !tree_confirmed(data, drive) {
        return Err(NOT_YET.into());
    }
    remove_if_same(path, &drive.token);
    Ok(())
}

struct TrackedPid {
    pid: u32,
    started: String,
}

fn load_tree(data: &Path, token: &str) -> Result<Vec<TrackedPid>, String> {
    let Some(path) = tracked_tree(data, token) else {
        return Err(NOT_CHECKED.into());
    };
    let text = std::fs::read_to_string(&path).map_err(|_| NOT_CHECKED.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|_| NOT_CHECKED.to_string())?;
    let Some(rows) = value.as_array() else {
        return Err(NOT_CHECKED.into());
    };
    let mut out = Vec::new();
    for item in rows {
        let Some(pid) = item
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
        else {
            return Err(NOT_CHECKED.into());
        };
        if pid_i32(pid).is_none() {
            return Err(NOT_CHECKED.into());
        }
        let started = item
            .get("started")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        out.push(TrackedPid { pid, started });
    }
    Ok(out)
}

/// `Ok(true)` means that recorded process is gone. `Ok(false)` means it is still the same one.
fn recorded_gone(data: &Path, pid: u32, started: &str) -> Result<bool, String> {
    if !alive(pid) {
        return Ok(true);
    }
    if started.is_empty() {
        return Err(NOT_CHECKED.into());
    }
    let now = process_start(data, pid)?;
    match same_start(started, &now) {
        Ok(true) => Ok(false),
        Ok(false) => Ok(true),
        Err(error) => Err(error),
    }
}

fn stop_tracked(data: &Path, row: &TrackedPid) -> Result<(), String> {
    if recorded_gone(data, row.pid, &row.started)? {
        return Ok(());
    }
    kill_one(row.pid, false)?;
    if wait_gone(row.pid, 1500) {
        return Ok(());
    }
    if recorded_gone(data, row.pid, &row.started)? {
        return Ok(());
    }
    kill_one(row.pid, true)?;
    if wait_gone(row.pid, 1500) || recorded_gone(data, row.pid, &row.started)? {
        return Ok(());
    }
    Err(NOT_YET.into())
}

fn stop_recorded_tree(data: &Path, path: &Path, drive: &StoredDrive) -> Result<(), String> {
    let rows = load_tree(data, &drive.token)?;
    for row in &rows {
        stop_tracked(data, row)?;
    }
    remove_if_same(path, &drive.token);
    Ok(())
}

fn finish_or_tree(data: &Path, path: &Path, drive: &StoredDrive) -> Result<(), String> {
    if tree_confirmed(data, drive) {
        return finish_gone(data, path, drive);
    }
    stop_recorded_tree(data, path, drive)
}

/// Stop one drive. Missing is fine. A process that isn't this session is not signalled.
/// Success means the recorded process is gone and, when a wrapper owns the tree, that it
/// confirmed the browser itself has gone.
pub fn stop(data: &Path, id: &str) -> Result<(), String> {
    let Some(path) = drive_path(data, id) else {
        return Err("That browser session isn't one this app started.".into());
    };
    let Some(drive) = load_drive(&path) else {
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        return Ok(());
    };
    if pid_i32(drive.pid).is_none() {
        remove_if_same(&path, &drive.token);
        return Err(NOT_OURS.into());
    }
    if !alive(drive.pid) {
        return finish_or_tree(data, &path, &drive);
    }
    match confirm_session(data, drive.pid, &drive.token, &drive.process_start) {
        Ok(()) => {}
        Err(error) if error == NOT_CHECKED => return Err(error),
        Err(error) if error == DEPARTED => return finish_or_tree(data, &path, &drive),
        Err(error) => {
            remove_if_same(&path, &drive.token);
            return Err(error);
        }
    }
    if let Err(error) = signal(data, drive.pid, &drive.token, &drive.process_start, false) {
        if error == DEPARTED {
            return finish_or_tree(data, &path, &drive);
        }
        if error != NOT_CHECKED && error != NOT_OURS {
            return Err(error);
        }
        if error == NOT_OURS {
            remove_if_same(&path, &drive.token);
        }
        return Err(error);
    }
    if wait_gone(drive.pid, 1500) {
        return finish_or_tree(data, &path, &drive);
    }
    if let Err(error) = signal(data, drive.pid, &drive.token, &drive.process_start, true) {
        if error == DEPARTED || !alive(drive.pid) {
            return finish_or_tree(data, &path, &drive);
        }
        return Err(error);
    }
    if wait_gone(drive.pid, 1500) {
        return finish_or_tree(data, &path, &drive);
    }
    Err(NOT_YET.into())
}

pub fn stop_all(data: &Path) -> Result<(), String> {
    let mut pending = None;
    for drive in read_drives(data)?.into_iter().filter(|drive| drive.visible) {
        if let Err(error) = stop(data, &drive.id) {
            pending.get_or_insert(error);
        }
    }
    match pending {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    let mut found = None;
    let mut iter = args.iter();
    while let Some(item) = iter.next() {
        if item == flag {
            found = iter.next().cloned();
        }
    }
    found
}

fn apply_env(command: &mut Command, plan: &LaunchEnv) {
    command.env("HIVRA_BROWSER_PROFILE", &plan.profile);
    command.env(
        "HIVRA_BROWSER_HEADLESS",
        if plan.headless { "1" } else { "0" },
    );
    command.env(
        "HIVRA_BROWSER_OWN_PROFILE",
        if plan.own { "1" } else { "0" },
    );
    command.env("HIVRA_BROWSER_SESSION", &plan.token);
    command.env("HIVRA_BROWSER_DONE", &plan.done);
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

/// `monocode plugin-mcp` for the browser plugin. Exit 78 when it can't start.
pub fn run(args: &[String]) -> i32 {
    let mut command = match crate::plugins::wiring::prepare_launch(args) {
        Ok(command) => command,
        Err(why) => {
            eprintln!("hivra browser: {why}");
            return 78;
        }
    };
    let Some(agent) = arg_value(args, "--agent") else {
        eprintln!("hivra browser: The browser needs an agent.");
        return 78;
    };
    if let Err(why) = check_agent_id(&agent) {
        eprintln!("hivra browser: {why}");
        return 78;
    }
    let name = arg_value(args, "--agent-name").unwrap_or_else(|| "This chat".into());
    let Some(root) = arg_value(args, "--root") else {
        eprintln!("hivra browser: The browser profile couldn't be made. Try again.");
        return 78;
    };
    let Some(data) = Path::new(&root).parent().map(Path::to_path_buf) else {
        eprintln!("hivra browser: The browser profile couldn't be made. Try again.");
        return 78;
    };
    let plan = match launch_env(&data, &agent, &name) {
        Ok(plan) => plan,
        Err(why) => {
            eprintln!("hivra browser: {why}");
            return 78;
        }
    };
    apply_env(&mut command, &plan);
    command.arg(&plan.token);
    finish_run(&mut command, &data, &agent, &plan)
}

#[cfg(unix)]
static FORWARD_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[cfg(unix)]
extern "C" fn forward_stop(sig: libc::c_int) {
    let pid = FORWARD_PID.load(std::sync::atomic::Ordering::Relaxed);
    if pid > 1 {
        unsafe {
            libc::kill(pid, sig);
        }
    }
}

/// SIGTERM to this process must reach the wrapper. The handler only records a pid and
/// signals it: both are safe to do from a signal. The wait in `finish_run` then returns
/// and the drive record is removed.
#[cfg(unix)]
fn arm_forward(pid: u32) {
    let Ok(pid) = i32::try_from(pid) else {
        return;
    };
    if pid < 2 {
        return;
    }
    FORWARD_PID.store(pid, std::sync::atomic::Ordering::Relaxed);
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = forward_stop as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        let _ = libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
        let _ = libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
    }
}

fn end_child(mut child: std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// The token has to be on the child's command line before we record it. A short wait is not a
/// final failure: `ps` can lag the spawn. If it never appears, the child is stopped and not recorded.
fn wait_for_token(pid: u32, token: &str) -> Result<(), String> {
    let start = std::time::Instant::now();
    loop {
        if is_zombie(pid) {
            return Err("The browser exited before it could be checked.".into());
        }
        match command_line(pid) {
            Ok(line) if token_in(&line, token) => return Ok(()),
            Ok(line) if defunct_line(&line) => {
                return Err("The browser exited before it could be checked.".into());
            }
            Ok(_) if start.elapsed() >= Duration::from_millis(500) => return Err(NOT_OURS.into()),
            Err(error) if start.elapsed() >= Duration::from_millis(500) => return Err(error),
            _ => {}
        }
        if !alive(pid) {
            return Err("The browser exited before it could be checked.".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Spawn the browser and record that child's pid, not this process. `exec` would record us, then
/// Stop could miss the token and delete the drive before the browser existed.
pub(crate) fn spawn_recorded(
    command: &mut Command,
    data: &Path,
    agent: &str,
    plan: &LaunchEnv,
) -> Result<(std::process::Child, PathBuf), i32> {
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("hivra browser: The browser didn't start. Try again. {error}");
            return Err(127);
        }
    };
    let pid = child.id();
    if let Err(error) = wait_for_token(pid, &plan.token) {
        end_child(child);
        eprintln!("hivra browser: The browser didn't start. Try again. {error}");
        return Err(78);
    }
    let started = match process_start(data, pid) {
        Ok(started) => started,
        Err(error) => {
            end_child(child);
            eprintln!("hivra browser: The browser didn't start. Try again. {error}");
            return Err(78);
        }
    };
    // Check again immediately before the record. A process that replaced itself no longer
    // carries the token, and Stop must not be left pointing at it.
    match command_line(pid) {
        Ok(line) if token_in(&line, &plan.token) => {}
        Ok(line) if defunct_line(&line) || is_zombie(pid) => {
            end_child(child);
            eprintln!("hivra browser: The browser exited before it could be checked.");
            return Err(78);
        }
        Ok(_) => {
            end_child(child);
            eprintln!("hivra browser: The browser didn't start. Try again. {NOT_OURS}");
            return Err(78);
        }
        Err(error) => {
            end_child(child);
            eprintln!("hivra browser: The browser didn't start. Try again. {error}");
            return Err(78);
        }
    }
    let drive = StoredDrive {
        id: uuid::Uuid::new_v4().to_string(),
        agent_id: agent.to_string(),
        name: plan.name.clone(),
        pid,
        token: plan.token.clone(),
        visible: plan.visible,
        started_at_ms: now_ms(),
        process_start: started,
        done_path: path_text(&plan.done),
    };
    match record_drive(data, &drive) {
        Ok(path) => Ok((child, path)),
        Err(why) => {
            end_child(child);
            eprintln!("hivra browser: {why}");
            Err(78)
        }
    }
}

fn finish_run(command: &mut Command, data: &Path, agent: &str, plan: &LaunchEnv) -> i32 {
    match spawn_recorded(command, data, agent, plan) {
        Ok((mut child, path)) => {
            // The child inherited stdin. Drop ours so we don't keep the pipe open after it exits.
            // A signal here is forwarded, not handled by dying, so the wrapper can take its
            // browser with it before this wait returns.
            #[cfg(unix)]
            {
                arm_forward(child.id());
                let _ = unsafe { libc::close(0) };
            }
            let code = child
                .wait()
                .map(|status| status.code().unwrap_or(1))
                .unwrap_or(1);
            match load_drive(&path) {
                Some(drive) if tree_confirmed(data, &drive) => remove_if_same(&path, &plan.token),
                Some(drive) => {
                    let _ = stop_recorded_tree(data, &path, &drive);
                }
                None => {}
            }
            code
        }
        Err(code) => code,
    }
}

#[cfg(all(test, unix))]
pub(crate) struct Running {
    pub id: String,
    data: PathBuf,
    child: std::process::Child,
}

#[cfg(all(test, unix))]
impl Drop for Running {
    fn drop(&mut self) {
        let _ = stop(&self.data, &self.id);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(all(test, unix))]
pub(crate) fn start_session(
    data: &Path,
    id: &str,
    name: &str,
    ignore_term: bool,
) -> Result<Running, String> {
    let plan = launch_env(data, id, name)?;
    let script = if ignore_term {
        "trap '' TERM; while true; do sleep 1; done"
    } else {
        "while true; do sleep 1; done"
    };
    let mut command = Command::new("sh");
    command.args(["-c", script, "hivra-browser", &plan.token]);
    allow_path(&mut command);
    command.stdout(Stdio::null()).stderr(Stdio::null());
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("The test browser didn't start. Try again. {error}"))?;
    let started = match process_start(data, child.id()) {
        Ok(started) => started,
        Err(error) => {
            end_child(child);
            return Err(error);
        }
    };
    let drive_id = uuid::Uuid::new_v4().to_string();
    if let Err(error) = record_drive(
        data,
        &StoredDrive {
            id: drive_id.clone(),
            agent_id: id.to_string(),
            name: plan.name,
            pid: child.id(),
            token: plan.token,
            visible: plan.visible,
            started_at_ms: now_ms(),
            process_start: started,
            done_path: String::new(),
        },
    ) {
        end_child(child);
        return Err(error);
    }
    Ok(Running {
        id: drive_id,
        data: data.to_path_buf(),
        child,
    })
}

#[tauri::command(async)]
pub fn browser_profiles(app: tauri::AppHandle) -> Result<Vec<Profile>, String> {
    list_profiles(&app_data(&app)?)
}

#[tauri::command(async)]
pub fn browser_clear(app: tauri::AppHandle, agent_id: String) -> Result<Vec<Profile>, String> {
    let data = app_data(&app)?;
    clear_profile(&data, &agent_id)
}

#[tauri::command(async)]
pub fn browser_watch(
    app: tauri::AppHandle,
    agent_id: String,
    watch: bool,
) -> Result<Vec<Profile>, String> {
    set_watch(&app_data(&app)?, &agent_id, watch)
}

#[tauri::command(async)]
pub fn browser_choose_own(
    app: tauri::AppHandle,
    agent_id: String,
    path: Option<String>,
) -> Result<Vec<Profile>, String> {
    let trimmed = path
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    choose_own(&app_data(&app)?, &agent_id, trimmed)
}

#[tauri::command(async)]
pub fn browser_drives(app: tauri::AppHandle) -> Result<Vec<Drive>, String> {
    visible_drives(&app_data(&app)?)
}

#[tauri::command(async)]
pub fn browser_stop(app: tauri::AppHandle, id: String) -> Result<(), String> {
    stop(&app_data(&app)?, &id)
}

#[tauri::command(async)]
pub fn browser_stop_all(app: tauri::AppHandle) -> Result<(), String> {
    stop_all(&app_data(&app)?)
}

/// Which browser the engine drives. Chrome when it is installed, and a plain line when it is not.
#[tauri::command(async)]
pub fn browser_engine() -> engine::EngineRow {
    engine::engine_row(engine::chrome_look())
}

/// Download Chromium into the plugin's data folder. This does not use the person's Chrome profile.
#[tauri::command(async)]
pub fn browser_get_browser(app: tauri::AppHandle) -> Result<(), String> {
    let host = crate::plugins::host(&app)?;
    engine::get_browser(&host.data("browser"))
}

pub(crate) mod engine;

#[cfg(test)]
mod tests;
