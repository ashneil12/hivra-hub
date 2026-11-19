// Copyright coollabsio and the Orbit contributors
// SPDX-License-Identifier: Apache-2.0
// Source: https://github.com/coollabsio/orbit crates/platform/src/backup.rs
//
// Schedule, the backup folder, and the commands Settings uses (WP-75). The snapshot
// layout and checks are in snapshot.rs; bringing one item or everything back is restore.rs.

mod reader;
mod restore;
mod snapshot;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::Digest;
use tauri::{AppHandle, Manager, State};

use snapshot::{BackupError, Roots};

pub use restore::{finish_pending, restored_title};

#[cfg(test)]
mod tests;

const SETTINGS_FILE: &str = "backup-settings.json";
const STATE_FILE: &str = "backup-state.json";
const HOUR_MILLIS: i64 = 60 * 60 * 1000;
const DAY_MILLIS: i64 = 24 * HOUR_MILLIS;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Schedule {
    Off,
    Hourly,
    Daily,
}

impl Schedule {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "off" => Some(Self::Off),
            "hourly" => Some(Self::Hourly),
            "daily" => Some(Self::Daily),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Hourly => "hourly",
            Self::Daily => "daily",
        }
    }
}

/// Off never. Hourly and daily are due when there has never been a good backup, or when that long has passed since
/// the last one. A failed attempt does not count: the caller leaves the last-good time alone.
pub fn due(schedule: Schedule, last_good: Option<i64>, now: i64) -> bool {
    let elapsed = |last: i64, gap: i64| now.saturating_sub(last) >= gap;
    match (schedule, last_good) {
        (Schedule::Off, _) => false,
        (Schedule::Hourly, None) => true,
        (Schedule::Hourly, Some(last)) => elapsed(last, HOUR_MILLIS),
        (Schedule::Daily, None) => true,
        (Schedule::Daily, Some(last)) => elapsed(last, DAY_MILLIS),
    }
}

pub fn default_schedule(dev: bool) -> Schedule {
    if dev {
        Schedule::Off
    } else {
        Schedule::Daily
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupsStatus {
    pub schedule: String,
    pub folder: String,
    pub folder_is_default: bool,
    pub last_good: Option<BackupInfo>,
    pub dev: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupItemView {
    pub kind: String,
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SettingsFile {
    schedule: String,
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StateFile {
    #[serde(default)]
    last_good: Option<BackupInfo>,
}

#[derive(Clone, Debug)]
struct Settings {
    schedule: Schedule,
    folder: Option<PathBuf>,
}

pub fn init(data_dir: PathBuf) {
    std::thread::Builder::new()
        .name("hivra-backups".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15 * 60));
            if let Err(error) = scheduled_tick(&data_dir) {
                eprintln!("backup: {error}");
            }
        })
        .ok();
}

fn scheduled_tick(data_dir: &Path) -> Result<(), String> {
    let roots = roots_for(data_dir);
    let settings = load_settings(&roots);
    let state = load_state(data_dir);
    if !due(
        settings.schedule,
        state.last_good.as_ref().map(|good| good.created_at),
        snapshot::now_millis(),
    ) {
        return Ok(());
    }
    let root = chosen_root(&roots, &settings).map_err(|error| error.to_string())?;
    match run_backup(&roots, &root) {
        Ok(_) => Ok(()),
        Err(BackupError::Busy) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn run_backup(roots: &Roots, backup_root: &Path) -> Result<snapshot::Snapshot, BackupError> {
    let _lock = try_lock(backup_root)?;
    let snapshot = snapshot::create(roots, backup_root)?;
    if let Err(error) = snapshot::apply_retention(backup_root, snapshot::now_millis()) {
        eprintln!("backup: retention skipped: {error}");
    }
    record_last_good(&roots.data_dir, &snapshot.id, snapshot.manifest.created_at)?;
    Ok(snapshot)
}

pub(crate) fn roots_for(data_dir: &Path) -> Roots {
    let dev = crate::instance::kind() == crate::instance::Kind::Dev;
    let home = crate::dirs_home().map(PathBuf::from);
    let configured = std::env::var_os("MONOCODE_HUB_MEMORY_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let memory_root = configured.unwrap_or_else(|| {
        if dev {
            data_dir.join("agent-memory")
        } else {
            home.clone().unwrap_or_default().join("agent-memory")
        }
    });
    let mut protected = Vec::new();
    if dev {
        if let Some(home) = &home {
            protected.push(home.join("agent-memory"));
            protected.push(home.join("Library/Application Support/com.ash.monocode-hub"));
            protected.push(home.join(".claude"));
        }
    }
    Roots {
        monos_root: crate::mono::resolved_root(data_dir),
        db_path: data_dir.join("monocode.db"),
        notes_root: data_dir.join("note-assets"),
        docs_root: data_dir.join("docs"),
        daily_data_dir: crate::instance::data_dir(crate::instance::DAILY_IDENTIFIER),
        data_dir: data_dir.to_path_buf(),
        memory_root,
        dev,
        protected,
    }
}

/// The folders a restore may write. Paths in `pending-restore.json` are not used: that file is untrusted.
/// `resolved_root` is not called here. It caches one folder for the process and can copy Monos into the home directory.
pub(crate) fn derived_roots(data_dir: &Path) -> Roots {
    let dev = crate::instance::kind() == crate::instance::Kind::Dev;
    let home = crate::dirs_home().map(PathBuf::from);
    let configured = std::env::var_os("MONOCODE_HUB_MEMORY_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let memory_root = configured.unwrap_or_else(|| {
        if dev {
            data_dir.join("agent-memory")
        } else {
            home.clone().unwrap_or_default().join("agent-memory")
        }
    });
    let mut protected = Vec::new();
    if dev {
        if let Some(home) = &home {
            protected.push(home.join("agent-memory"));
            protected.push(home.join("Library/Application Support/com.ash.monocode-hub"));
            protected.push(home.join(".claude"));
        }
    }
    let override_root = std::env::var_os(crate::mono_home::HOME_ENV)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    Roots {
        monos_root: crate::mono_home::choose_root(
            !dev,
            home.as_deref(),
            override_root.as_deref(),
            data_dir,
        ),
        db_path: data_dir.join("monocode.db"),
        notes_root: data_dir.join("note-assets"),
        docs_root: data_dir.join("docs"),
        daily_data_dir: crate::instance::data_dir(crate::instance::DAILY_IDENTIFIER),
        data_dir: data_dir.to_path_buf(),
        memory_root,
        dev,
        protected,
    }
}

fn chosen_root(roots: &Roots, settings: &Settings) -> Result<PathBuf, BackupError> {
    match &settings.folder {
        Some(folder) => match snapshot::confine(roots, folder) {
            Ok(path) => Ok(path),
            Err(_) if roots.dev => {
                snapshot::confine(roots, &snapshot::default_backup_root(&roots.data_dir))
            }
            Err(error) => Err(error),
        },
        None => snapshot::confine(roots, &snapshot::default_backup_root(&roots.data_dir)),
    }
}

struct SettingsSnapshot {
    settings: Settings,
    existed: bool,
    hash: String,
}

fn snapshot_settings(roots: &Roots) -> SettingsSnapshot {
    let path = roots.data_dir.join(SETTINGS_FILE);
    match fs::read(&path) {
        Ok(bytes) => SettingsSnapshot {
            settings: parse_settings(&bytes, roots.dev),
            existed: true,
            hash: format!("{:x}", sha2::Sha256::digest(&bytes)),
        },
        Err(_) => SettingsSnapshot {
            settings: Settings {
                schedule: default_schedule(roots.dev),
                folder: None,
            },
            existed: false,
            hash: format!("{:x}", sha2::Sha256::digest(b"")),
        },
    }
}

fn parse_settings(bytes: &[u8], dev: bool) -> Settings {
    let Ok(file) = serde_json::from_slice::<SettingsFile>(bytes) else {
        return Settings {
            schedule: default_schedule(dev),
            folder: None,
        };
    };
    let schedule = Schedule::parse(&file.schedule).unwrap_or_else(|| default_schedule(dev));
    let folder = file.folder.and_then(|folder| {
        let path = PathBuf::from(folder);
        (!path.as_os_str().is_empty() && path.is_absolute()).then_some(path)
    });
    Settings { schedule, folder }
}

fn load_settings(roots: &Roots) -> Settings {
    snapshot_settings(roots).settings
}

fn load_state(data_dir: &Path) -> StateFile {
    let Ok(bytes) = fs::read(data_dir.join(STATE_FILE)) else {
        return StateFile { last_good: None };
    };
    serde_json::from_slice(&bytes).unwrap_or(StateFile { last_good: None })
}

/// WP-104: the time of the last good backup this app recorded. A missing, empty or unreadable file is none.
pub(crate) fn last_good_at(data_dir: &Path) -> Option<i64> {
    load_state(data_dir)
        .last_good
        .map(|good| good.created_at)
        .filter(|at| *at > 0)
}

fn record_last_good(data_dir: &Path, id: &str, created_at: i64) -> Result<(), BackupError> {
    let path = data_dir.join(STATE_FILE);
    for _ in 0..2 {
        let existed = path.is_file();
        let original = if existed {
            fs::read(&path).map_err(|source| io_error(&path, source))?
        } else {
            Vec::new()
        };
        let hash = format!("{:x}", sha2::Sha256::digest(&original));
        let mut state: StateFile = if original.is_empty() {
            StateFile { last_good: None }
        } else {
            serde_json::from_slice(&original).unwrap_or(StateFile { last_good: None })
        };
        if state
            .last_good
            .as_ref()
            .is_some_and(|good| good.created_at > created_at)
        {
            return Ok(());
        }
        state.last_good = Some(BackupInfo {
            id: id.to_owned(),
            created_at,
        });
        let bytes = serde_json::to_vec_pretty(&state)
            .map_err(|error| BackupError::InvalidSnapshot(error.to_string()))?;
        if restore::replace_if_unchanged(&path, existed, &hash, &bytes)? {
            return Ok(());
        }
    }
    Err(BackupError::RosterChanged)
}

fn save_settings(
    roots: &Roots,
    settings: &Settings,
    existed: bool,
    expected: &str,
) -> Result<(), BackupError> {
    let path = roots.data_dir.join(SETTINGS_FILE);
    let file = SettingsFile {
        schedule: settings.schedule.as_str().to_owned(),
        folder: settings
            .folder
            .as_ref()
            .map(|folder| folder.to_string_lossy().into_owned()),
    };
    let bytes = serde_json::to_vec_pretty(&file)
        .map_err(|error| BackupError::InvalidSnapshot(error.to_string()))?;
    if !restore::replace_if_unchanged(&path, existed, expected, &bytes)? {
        return Err(BackupError::Conflict);
    }
    Ok(())
}

struct BackupLock {
    path: PathBuf,
}

impl Drop for BackupLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn try_lock(root: &Path) -> Result<BackupLock, BackupError> {
    fs::create_dir_all(root).map_err(|source| io_error(root, source))?;
    let path = root.join(".lock");
    match write_lock(&path) {
        Ok(()) => Ok(BackupLock { path }),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if lock_is_stale(&path) {
                let _ = fs::remove_file(&path);
                match write_lock(&path) {
                    Ok(()) => Ok(BackupLock { path }),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        Err(BackupError::Busy)
                    }
                    Err(source) => Err(io_error(&path, source)),
                }
            } else {
                Err(BackupError::Busy)
            }
        }
        Err(source) => Err(io_error(&path, source)),
    }
}

fn write_lock(path: &Path) -> Result<(), std::io::Error> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let body = format!(
        "{{\"pid\":{},\"at\":{}}}",
        std::process::id(),
        snapshot::now_millis()
    );
    file.write_all(body.as_bytes())?;
    file.sync_all()
}

fn lock_is_stale(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return true;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return true;
    };
    let pid = value
        .get("pid")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    #[cfg(unix)]
    {
        !process_alive(pid)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        let at = value
            .get("at")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        snapshot::now_millis().saturating_sub(at) > 2 * DAY_MILLIS
    }
}

#[cfg(unix)]
fn process_alive(pid: u64) -> bool {
    let pid = match i32::try_from(pid) {
        Ok(pid) if pid > 0 => pid,
        _ => return false,
    };
    // SAFETY: signal 0 checks that the process exists; it does not deliver a signal.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn io_error(path: &Path, source: std::io::Error) -> BackupError {
    BackupError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn backups_status(app: AppHandle) -> Result<BackupsStatus, String> {
    let roots = roots_for(&data_dir(&app)?);
    let settings = load_settings(&roots);
    let folder_is_default = settings.folder.is_none();
    let folder = chosen_root(&roots, &settings)
        .unwrap_or_else(|_| snapshot::default_backup_root(&roots.data_dir));
    let state = load_state(&roots.data_dir);
    Ok(BackupsStatus {
        schedule: settings.schedule.as_str().to_owned(),
        folder: folder.to_string_lossy().into_owned(),
        folder_is_default,
        last_good: state.last_good,
        dev: roots.dev,
    })
}

#[tauri::command]
pub fn backups_set_schedule(app: AppHandle, schedule: String) -> Result<(), String> {
    let roots = roots_for(&data_dir(&app)?);
    let parsed =
        Schedule::parse(&schedule).ok_or_else(|| "Schedule is off, hourly or daily.".to_owned())?;
    let loaded = snapshot_settings(&roots);
    let mut settings = loaded.settings;
    settings.schedule = parsed;
    save_settings(&roots, &settings, loaded.existed, &loaded.hash)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn backups_set_folder(app: AppHandle, folder: Option<String>) -> Result<(), String> {
    let roots = roots_for(&data_dir(&app)?);
    let loaded = snapshot_settings(&roots);
    let mut settings = loaded.settings;
    settings.folder = match folder {
        None => None,
        Some(folder) => {
            let path = PathBuf::from(&folder);
            if !path.is_absolute() {
                return Err("Choose a folder with its full path.".into());
            }
            snapshot::confine(&roots, &path).map_err(|error| error.to_string())?;
            Some(path)
        }
    };
    save_settings(&roots, &settings, loaded.existed, &loaded.hash)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn backups_create(app: AppHandle) -> Result<BackupInfo, String> {
    let roots = roots_for(&data_dir(&app)?);
    let settings = load_settings(&roots);
    let root = chosen_root(&roots, &settings).map_err(|error| error.to_string())?;
    let snapshot = run_backup(&roots, &root).map_err(|error| error.to_string())?;
    Ok(BackupInfo {
        id: snapshot.id,
        created_at: snapshot.manifest.created_at,
    })
}

#[tauri::command]
pub fn backups_list(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let roots = roots_for(&data_dir(&app)?);
    let settings = load_settings(&roots);
    let root = chosen_root(&roots, &settings).map_err(|error| error.to_string())?;
    let snapshots = snapshot::list(&root).map_err(|error| error.to_string())?;
    Ok(snapshots
        .into_iter()
        .map(|snapshot| BackupInfo {
            id: snapshot.id,
            created_at: snapshot.manifest.created_at,
        })
        .collect())
}

#[tauri::command(async)]
pub fn backups_items(app: AppHandle, id: String) -> Result<Vec<BackupItemView>, String> {
    let snapshot = open_snapshot(&app, &id)?;
    let items = restore::items(&snapshot).map_err(|error| error.to_string())?;
    Ok(items
        .into_iter()
        .map(|item| BackupItemView {
            kind: item.kind,
            id: item.id,
            title: item.title,
        })
        .collect())
}

#[tauri::command(async)]
pub fn backups_restore_item(
    app: AppHandle,
    store: State<'_, crate::session_store::SessionStore>,
    id: String,
    kind: String,
    item_id: String,
) -> Result<BackupItemView, String> {
    let roots = roots_for(&data_dir(&app)?);
    let snapshot = open_snapshot(&app, &id)?;
    let conn = store.lock_conn()?;
    let item = restore::restore_item(&roots, &conn, &snapshot, &kind, &item_id)
        .map_err(|error| error.to_string())?;
    Ok(BackupItemView {
        kind: item.kind,
        id: item.id,
        title: item.title,
    })
}

#[tauri::command(async)]
pub fn backups_restore_all(app: AppHandle, id: String) -> Result<(), String> {
    let roots = roots_for(&data_dir(&app)?);
    let snapshot = open_snapshot(&app, &id)?;
    restore::arm_full_restore(&roots, &snapshot, spawn_helper)?;
    crate::window::confirm_quit(app);
    Ok(())
}

fn open_snapshot(app: &AppHandle, id: &str) -> Result<snapshot::Snapshot, String> {
    let roots = roots_for(&data_dir(app)?);
    let settings = load_settings(&roots);
    let root = chosen_root(&roots, &settings).map_err(|error| error.to_string())?;
    let snapshot = snapshot::find(&root, id).map_err(|error| error.to_string())?;
    snapshot::verify_dir(&snapshot.path).map_err(|error| error.to_string())
}

fn spawn_helper(data_dir: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new(exe);
    command
        .arg("backup-restore")
        .arg(data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env_clear();
    for (key, value) in allow_env() {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(DETACHED_PROCESS);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn allow_env() -> Vec<(String, String)> {
    const KEYS: &[&str] = &[
        "HOME",
        "PATH",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SHELL",
        "SYSTEMROOT",
        "WINDIR",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "PROGRAMDATA",
    ];
    KEYS.iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| ((*key).to_owned(), value))
        })
        .collect()
}

/// Wait until this copy has left its data folder, put the staged backup back, and open the app again.
pub fn restore_helper_main(args: &[String]) -> i32 {
    let Some(data) = args.first() else {
        return 2;
    };
    let data = PathBuf::from(data);
    if !data.is_absolute() || !restore::pending_path(&data).is_file() {
        return 0;
    }
    match crate::instance::InstanceLock::acquire(&data, Duration::from_secs(45)) {
        Ok(lock) => {
            let outcome = finish_pending(&data);
            drop(lock);
            match outcome {
                Ok(true) => {
                    let _ = spawn_app();
                    0
                }
                Ok(false) => 0,
                Err(error) => {
                    eprintln!("backup: restore didn't finish: {error}");
                    1
                }
            }
        }
        Err(crate::instance::LockError::Busy) => 0,
        Err(crate::instance::LockError::Failed(error)) => {
            eprintln!("backup: couldn't take the data folder: {error}");
            1
        }
    }
}

fn spawn_app() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new(exe);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env_clear();
    for (key, value) in allow_env() {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(DETACHED_PROCESS);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}
