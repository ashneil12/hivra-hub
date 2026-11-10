//! Desktop control (WP-44). The carried plugin is installed switched off. Consent is one document
//! the gate and Settings both edit, with a revision check and a lock, so a late write cannot
//! overwrite a newer decision.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::fsutil;
use super::registry::{self, Host, Outcome, Source};

const MAX_CONSENT: usize = 256 * 1024;
const LOCK_TRIES: u32 = 8;
static LOCK_TOKEN: AtomicU64 = AtomicU64::new(1);
const UNREADABLE: &str = "The consent file can't be read, so it was left as it is.";
const CHANGED: &str = "That list changed. Look again.";
const BUSY: &str = "Desktop consent is busy. Try again.";
const NOT_INSTALLED: &str = "Desktop control isn't installed.";

include!(concat!(env!("OUT_DIR"), "/desktop_control.rs"));

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConsent {
    pub apps: Vec<String>,
    pub refused: Vec<String>,
    #[serde(default)]
    pub visible: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingAsk {
    pub id: String,
    pub project: String,
    pub app: String,
}

/// The consent document. `nextId` is required: a file without it is left untouched.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsentDoc {
    pub revision: u64,
    pub next_id: u64,
    pub projects: BTreeMap<String, ProjectConsent>,
    pub pending: Vec<PendingAsk>,
}

impl ConsentDoc {
    pub fn empty() -> Self {
        Self {
            revision: 0,
            next_id: 1,
            projects: BTreeMap::new(),
            pending: Vec::new(),
        }
    }
}

pub fn consent_path(host: &Host) -> PathBuf {
    host.data("desktop-control").join("consent.json")
}

/// `consent.json.lock`, not `consent.lock` (`with_extension` would drop `.json`).
pub(crate) fn consent_lock(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    match path.parent() {
        Some(parent) if !name.is_empty() => parent.join(format!("{name}.lock")),
        _ => PathBuf::from(format!("{name}.lock")),
    }
}

enum Loaded {
    Missing,
    Doc(ConsentDoc),
    Bad,
}

fn load_consent(path: &Path) -> Loaded {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Loaded::Missing,
        Err(_) => return Loaded::Bad,
    };
    if bytes.len() > MAX_CONSENT {
        return Loaded::Bad;
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return Loaded::Bad;
    };
    let text = text.trim_start_matches('\u{feff}');
    match serde_json::from_str::<ConsentDoc>(text) {
        Ok(doc) if doc.next_id >= 1 => Loaded::Doc(doc),
        _ => Loaded::Bad,
    }
}

pub(crate) fn read_consent(path: &Path) -> Result<ConsentDoc, String> {
    match load_consent(path) {
        Loaded::Missing => Ok(ConsentDoc::empty()),
        Loaded::Doc(doc) => Ok(doc),
        Loaded::Bad => Err(UNREADABLE.into()),
    }
}

fn app_problem(app: &str) -> bool {
    app.is_empty()
        || app != app.trim()
        || app.chars().count() > 256
        || app.chars().any(|c| c == '\0' || c == '\r' || c == '\n')
}

fn project_problem(project: &str) -> bool {
    if project.is_empty() || project.contains('\0') {
        return true;
    }
    let path = Path::new(project);
    if !path.is_absolute() {
        return true;
    }
    path.components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
}

fn validate(doc: &ConsentDoc, expected: u64) -> Result<u64, String> {
    let Some(next_rev) = expected.checked_add(1) else {
        return Err("That consent isn't valid.".into());
    };
    if doc.revision != next_rev || doc.next_id < 1 {
        return Err("That consent isn't valid.".into());
    }
    if doc.projects.len() > 200 || doc.pending.len() > 200 {
        return Err("That consent is too big.".into());
    }
    for (project, record) in &doc.projects {
        if project_problem(project) || record.apps.len() > 200 || record.refused.len() > 200 {
            return Err("That consent isn't valid.".into());
        }
        if record.apps.iter().any(|app| app_problem(app))
            || record.refused.iter().any(|app| app_problem(app))
        {
            return Err("That consent isn't valid.".into());
        }
    }
    for ask in &doc.pending {
        if ask.id.is_empty()
            || ask.id.chars().count() > 64
            || ask.id.chars().any(|c| c == '\0' || c == '\r' || c == '\n')
            || project_problem(&ask.project)
            || app_problem(&ask.app)
        {
            return Err("That consent isn't valid.".into());
        }
    }
    let text = serde_json::to_string(doc).map_err(|_| "That consent isn't valid.".to_string())?;
    if text.len() + 1 > MAX_CONSENT {
        return Err("That consent is too big.".into());
    }
    Ok(next_rev)
}

fn owner_token() -> String {
    let n = LOCK_TOKEN.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{n:x}-{nanos:x}")
}

/// A pid of 0 is not a process. EPERM means it exists and we cannot signal it, so it is alive.
fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        if pid > i32::MAX as u32 {
            return false;
        }
        let rc = unsafe { libc::kill(pid as i32, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let _ = CloseHandle(handle);
            true
        }
    }
}

fn lock_owner(bytes: &[u8]) -> Option<(u32, String)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.split('\n');
    let pid: u32 = lines.next()?.parse().ok()?;
    let token = lines.next()?;
    if pid == 0 || token.is_empty() || token.contains('\0') {
        return None;
    }
    Some((pid, token.to_string()))
}

fn release_owned(lock: &Path, token: &str) {
    let Ok(bytes) = std::fs::read(lock) else {
        return;
    };
    let Some((_, owned)) = lock_owner(&bytes) else {
        return;
    };
    if owned != token {
        return;
    }
    if std::fs::read(lock).ok().as_deref() != Some(bytes.as_slice()) {
        return;
    }
    let _ = std::fs::remove_file(lock);
}

/// A missing lock can be taken. A live owner is never removed. A dead owner is removed only when the
/// bytes are still the ones just read, so a reclaim cannot let two writers in.
fn reclaim_dead(lock: &Path) -> bool {
    let Ok(bytes) = std::fs::read(lock) else {
        return !lock.exists();
    };
    let Some((pid, _)) = lock_owner(&bytes) else {
        return false;
    };
    if process_alive(pid) {
        return false;
    }
    if std::fs::read(lock).ok().as_deref() != Some(bytes.as_slice()) {
        return false;
    }
    std::fs::remove_file(lock).is_ok()
}

fn pending_lock(lock: &Path, token: &str) -> PathBuf {
    let mut name = lock
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(format!(".pending-{}-{token}", std::process::id()));
    match lock.parent() {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

/// One writer. The lock name appears only after the pid and token are written. Age is not a reason to take it.
fn with_consent_lock<T>(
    file: &Path,
    body: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|_| UNREADABLE.to_string())?;
    }
    let lock = consent_lock(file);
    let token = owner_token();
    let record = format!("{}\n{token}\n", std::process::id());
    let pending = pending_lock(&lock, &token);
    for _ in 0..LOCK_TRIES {
        let published = (|| {
            let mut handle = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&pending)?;
            handle.write_all(record.as_bytes())?;
            handle.sync_all()?;
            drop(handle);
            std::fs::hard_link(&pending, &lock)?;
            Ok::<(), std::io::Error>(())
        })();
        let _ = std::fs::remove_file(&pending);
        match published {
            Ok(()) => {
                let result = body();
                release_owned(&lock, &token);
                return result;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if reclaim_dead(&lock) {
                    continue;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return Err(UNREADABLE.into()),
        }
    }
    Err(BUSY.into())
}

pub(crate) fn write_consent(
    path: &Path,
    expected: u64,
    mut consent: ConsentDoc,
) -> Result<ConsentDoc, String> {
    let next_rev = validate(&consent, expected)?;
    with_consent_lock(path, || {
        let previous = match load_consent(path) {
            Loaded::Bad => return Err(UNREADABLE.into()),
            Loaded::Missing if expected != 0 => return Err(CHANGED.into()),
            Loaded::Doc(current) if current.revision != expected => return Err(CHANGED.into()),
            Loaded::Missing => ConsentDoc::empty(),
            Loaded::Doc(current) => current,
        };
        consent.revision = next_rev;
        let text = serde_json::to_string(&consent).map_err(|_| UNREADABLE.to_string())?;
        fsutil::write_atomic(path, format!("{text}\n").as_bytes())?;
        // WP-78: a new allow is a grant. A refusal, or writing the same allows again, is not.
        note_new_allows(path, &previous, &consent);
        Ok(consent)
    })
}

/// `<data>/plugins/data/desktop-control/consent.json` → `<data>/monocode.db`.
/// Any other path is not this app's consent file, so it is not logged.
fn activity_db_from_consent(path: &Path) -> Option<PathBuf> {
    let control = path.parent()?;
    let plugin_data = control.parent()?;
    let plugins = plugin_data.parent()?;
    let app_data = plugins.parent()?;
    if plugins.file_name().and_then(|name| name.to_str()) != Some("plugins") {
        return None;
    }
    if plugin_data.file_name().and_then(|name| name.to_str()) != Some("data") {
        return None;
    }
    Some(app_data.join("monocode.db"))
}

fn note_new_allows(path: &Path, previous: &ConsentDoc, next: &ConsentDoc) {
    let Some(db) = activity_db_from_consent(path) else {
        return;
    };
    let person = crate::activity::Who::person();
    for (project, consent) in &next.projects {
        let before = previous
            .projects
            .get(project)
            .map(|row| row.apps.as_slice())
            .unwrap_or(&[]);
        for app in &consent.apps {
            if before.iter().any(|had| had == app) {
                continue;
            }
            crate::activity::note_db(
                &db,
                crate::activity::PERMISSION_GRANT,
                &person,
                &person,
                project,
                app,
                &format!("Allowed {app}."),
                "",
            );
        }
    }
}

fn installed(host: &Host) -> Result<(), String> {
    if host.installed("desktop-control").is_dir() {
        Ok(())
    } else {
        Err(NOT_INSTALLED.into())
    }
}

pub fn read_for_host(host: &Host) -> Result<ConsentDoc, String> {
    installed(host)?;
    read_consent(&consent_path(host))
}

pub fn write_for_host(
    host: &Host,
    expected: u64,
    consent: ConsentDoc,
) -> Result<ConsentDoc, String> {
    installed(host)?;
    write_consent(&consent_path(host), expected, consent)
}

#[tauri::command(async)]
pub fn desktop_consent_read(app: tauri::AppHandle) -> Result<ConsentDoc, String> {
    read_for_host(&super::host(&app)?)
}

#[tauri::command(async)]
pub fn desktop_consent_write(
    app: tauri::AppHandle,
    expected_revision: u64,
    consent: ConsentDoc,
) -> Result<ConsentDoc, String> {
    write_for_host(&super::host(&app)?, expected_revision, consent)
}

/// A path inside the carried plugin. `..`, `.`, an empty segment and an absolute path are refused.
pub(crate) fn rel_parts(rel: &str) -> Option<Vec<&str>> {
    if rel.is_empty() || rel.contains('\0') || rel.contains(':') {
        return None;
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return None;
    }
    let mut parts = Vec::new();
    for part in rel.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

fn unpack(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
    for (rel, bytes, executable) in FILES {
        let parts = rel_parts(rel).ok_or_else(|| format!("Bad plugin path: {rel}"))?;
        let mut dest = root.to_path_buf();
        for part in parts {
            dest.push(part);
        }
        if !dest.starts_with(root) {
            return Err(format!("Bad plugin path: {rel}"));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&dest, bytes).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if *executable {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest)
                .map_err(|error| error.to_string())?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms).map_err(|error| error.to_string())?;
        }
        #[cfg(not(unix))]
        let _ = executable;
    }
    Ok(())
}

/// Remove the unpack folder only when it is a real directory under the temp folder, and not the temp folder itself.
fn remove_staging(staging: &Path) -> Result<(), String> {
    let temp = fsutil::canonical(&std::env::temp_dir()).map_err(|error| error.to_string())?;
    let meta = match std::fs::symlink_metadata(staging) {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if meta.file_type().is_symlink() {
        return Err("Refusing to remove a linked staging folder.".into());
    }
    let real = fsutil::canonical(staging).map_err(|error| error.to_string())?;
    if real == temp || !real.starts_with(&temp) {
        return Err("Refusing to remove a folder outside the temp directory.".into());
    }
    let name = real
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if !name.starts_with("hivra-desktop-") {
        return Err("Refusing to remove an unexpected folder.".into());
    }
    fsutil::remove_tree(&real)
}

pub fn install_bundled(host: &Host) -> Result<Outcome, String> {
    let staging = std::env::temp_dir().join(format!("hivra-desktop-{}", uuid::Uuid::new_v4()));
    if let Err(why) = unpack(&staging) {
        let _ = remove_staging(&staging);
        return Err(why);
    }
    let installed = registry::install_local(
        host,
        &staging,
        Source {
            kind: "bundled".into(),
            location: "desktop-control".into(),
            pin: Some("1.2.0".into()),
            tag: None,
            path: None,
            registry: None,
        },
    );
    let removed = remove_staging(&staging);
    match (installed, removed) {
        (Ok(outcome), Ok(())) => Ok(outcome),
        (Err(why), _) => Err(why),
        (Ok(_), Err(why)) => Err(why),
    }
}

#[tauri::command(async)]
pub fn desktop_control_install(app: tauri::AppHandle) -> Result<Outcome, String> {
    install_bundled(&super::host(&app)?)
}

/// WP-44: download the pinned program into the plugin data folder. The package's scripts are not run.
#[tauri::command(async)]
pub fn desktop_control_fetch(app: tauri::AppHandle) -> Result<(), String> {
    let host = super::host(&app)?;
    super::desktop_program::fetch_for_host(
        &host,
        &super::desktop_program::platform_key(),
        super::desktop_program::download_tarball,
    )
}
