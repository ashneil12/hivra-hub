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
}

pub(crate) struct LaunchEnv {
    pub profile: PathBuf,
    pub headless: bool,
    pub own: bool,
    pub visible: bool,
    pub token: String,
    pub name: String,
}

struct SettingsLock(PathBuf);

impl Drop for SettingsLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
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

fn lock_is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.elapsed().ok())
        .is_some_and(|age| age > Duration::from_secs(30))
}

fn lock_settings(dir: &Path) -> Result<SettingsLock, String> {
    std::fs::create_dir_all(dir).map_err(|_| TRY_SETTINGS.to_string())?;
    let path = dir.join("settings.lock");
    for _ in 0..100 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(SettingsLock(path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(&path) {
                    let _ = std::fs::remove_file(&path);
                } else {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
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
    change: impl FnOnce(&mut Settings) -> Result<T, String>,
) -> Result<T, String> {
    let dir = browser_dir(data);
    let lock = lock_settings(&dir)?;
    let path = dir.join("settings.json");
    let mut settings = read_settings(&path);
    let result = change(&mut settings)?;
    settings.revision = settings.revision.saturating_add(1);
    write_settings(&path, &settings)?;
    drop(lock);
    Ok(result)
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
    Ok(LaunchEnv {
        profile,
        headless: !watch,
        own: using_own,
        visible: watch,
        token: format!("hivra-{}", uuid::Uuid::new_v4()),
        name: stored,
    })
}

fn record_drive(data: &Path, drive: &StoredDrive) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(&drive.id).is_err() || drive.token.is_empty() {
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
    if drive.id != id || drive.token.is_empty() {
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

fn remove_if_same(path: &Path, token: &str) {
    if load_drive(path).is_some_and(|drive| drive.token == token) {
        let _ = std::fs::remove_file(path);
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
            Some(drive) if alive(drive.pid) => out.push(drive),
            _ => {
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

#[cfg(unix)]
fn signal(pid: u32, kill: bool) -> Result<(), String> {
    let Some(pid) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let sig = if kill { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        let group = libc::getpgid(pid);
        if group >= 2 && group == pid {
            libc::kill(-group, sig);
        }
        if libc::kill(pid, sig) != 0 && alive(pid as u32) {
            return Err("Couldn't stop that browser. Try again.".into());
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn signal(pid: u32, kill: bool) -> Result<(), String> {
    let Some(pid) = pid_i32(pid) else {
        return Err(NOT_OURS.into());
    };
    let mut command = Command::new("taskkill");
    command.arg("/PID").arg(pid.to_string()).arg("/T");
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

/// Stop one drive. Missing is fine. A process that isn't this session is not signalled.
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
        remove_if_same(&path, &drive.token);
        return Ok(());
    }
    let line = command_line(drive.pid)?;
    if !token_in(&line, &drive.token) {
        remove_if_same(&path, &drive.token);
        return Err(NOT_OURS.into());
    }
    signal(drive.pid, false)?;
    if wait_gone(drive.pid, 1500) {
        remove_if_same(&path, &drive.token);
        return Ok(());
    }
    signal(drive.pid, true)?;
    if wait_gone(drive.pid, 1500) {
        remove_if_same(&path, &drive.token);
        return Ok(());
    }
    Err(NOT_YET.into())
}

pub fn stop_all(data: &Path) -> Result<(), String> {
    let mut pending = None;
    for drive in read_drives(data)? {
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

fn finish_run(command: &mut Command, data: &Path, agent: &str, plan: &LaunchEnv) -> i32 {
    let drive = StoredDrive {
        id: uuid::Uuid::new_v4().to_string(),
        agent_id: agent.to_string(),
        name: plan.name.clone(),
        pid: std::process::id(),
        token: plan.token.clone(),
        visible: plan.visible,
        started_at_ms: now_ms(),
    };
    #[cfg(unix)]
    {
        let path = match record_drive(data, &drive) {
            Ok(path) => path,
            Err(why) => {
                eprintln!("hivra browser: {why}");
                return 78;
            }
        };
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        remove_if_same(&path, &plan.token);
        eprintln!("hivra browser: The browser didn't start. Try again. {error}");
        127
    }
    #[cfg(not(unix))]
    {
        match command.spawn() {
            Ok(mut child) => {
                let mut recorded = drive;
                recorded.pid = child.id();
                let path = match record_drive(data, &recorded) {
                    Ok(path) => path,
                    Err(why) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        eprintln!("hivra browser: {why}");
                        return 78;
                    }
                };
                let code = child
                    .wait()
                    .map(|status| status.code().unwrap_or(1))
                    .unwrap_or(1);
                remove_if_same(&path, &plan.token);
                code
            }
            Err(error) => {
                eprintln!("hivra browser: The browser didn't start. Try again. {error}");
                127
            }
        }
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
    let drive_id = uuid::Uuid::new_v4().to_string();
    record_drive(
        data,
        &StoredDrive {
            id: drive_id.clone(),
            agent_id: id.to_string(),
            name: plan.name,
            pid: child.id(),
            token: plan.token,
            visible: plan.visible,
            started_at_ms: now_ms(),
        },
    )?;
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

#[cfg(test)]
mod tests;
