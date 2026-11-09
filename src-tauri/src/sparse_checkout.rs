//! WP-118: an optional sparse checkout for a new worktree, off unless this project asks.
//!
//! Missing, empty and unreadable settings stay off. Only projects that are on are
//! stored. A second window has to send the value it last saw; a stale write is
//! refused and the file is left as it was. Nothing here downloads gion or runs an
//! installer. The pin stays unset until a release asset is checksummed, and a new
//! worktree then refuses instead of falling back to git.

use std::collections::BTreeSet;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const DIR_NAME: &str = "sparse-checkout";
const FILE_NAME: &str = "settings.json";
const LOCK_NAME: &str = ".sparse-checkout.lock";
const LOCK_WAIT: Duration = Duration::from_millis(1500);
const LOCK_STALE: Duration = Duration::from_secs(30);

pub const NOT_FOUND: &str = "This project folder can't be found.";
pub const CONFLICT: &str = "This setting changed in another window. Look again, then change it.";
pub const UNREADABLE: &str = "The saved setting can't be read. Nothing was changed.";
pub const LINK_REFUSED: &str = "The sparse checkout setting is a link, so it was refused.";
pub const OUTSIDE: &str = "Refusing to write the sparse checkout setting outside its folder.";
pub const BUSY: &str = "This setting is busy in another window. Try again.";
pub const CANT_SAVE: &str = "The sparse checkout setting can't be saved.";
pub const PIN_UNSET: &str = "The pin for gion isn't set, so a sparse checkout was not created.";
pub const SPARSE_NOTICE: &str = "This checkout is sparse. Git does not see it as a worktree, so actions on it stay on the pinned tool.";
pub const NOT_CREATED: &str = "The sparse checkout was not created.";

const MARKER_NAME: &str = ".gion-workspace.json";
/// Names the test double reads. A real gion does not. Forwarded only when set, never logged.
const STANDIN_ENV: &[&str] = &[
    "GION_STANDIN_LOG",
    "GION_STANDIN_FAIL",
    "GION_STANDIN_ENV_LOG",
    "GION_STANDIN_LINK",
];

/// How a test starts the stand-in. Production leaves this empty until a checksum exists.
#[derive(Clone, Debug)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<std::ffi::OsString>,
}

/// Where this copy of the app keeps its own settings. A dev copy has its own data folder.
#[derive(Clone, Debug)]
pub struct SparseEnv {
    pub data_dir: PathBuf,
    /// Home the tool may see. The same home git already uses. Tests point it at a scratch folder.
    pub home: PathBuf,
    pub launch: Option<Launch>,
}

impl SparseEnv {
    pub fn new(data_dir: PathBuf) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| data_dir.clone());
        Self {
            data_dir,
            home,
            launch: None,
        }
    }
}

pub fn env_from_app(app: &AppHandle) -> SparseEnv {
    let data_dir = crate::project_file::data_dir(app).unwrap_or_else(|_| {
        std::env::temp_dir().join(format!(
            "monocode-hub-sparse-checkout-{}",
            std::process::id()
        ))
    });
    SparseEnv::new(data_dir)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SparseSettings {
    pub enabled: bool,
    /// False when the file is there but isn't usable JSON. The switch still reads as off.
    pub readable: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileBody {
    enabled: BTreeSet<String>,
}

enum Saved {
    Missing,
    Ready(BTreeSet<String>),
    Unreadable,
}

struct Place {
    data: PathBuf,
    state: PathBuf,
    file: PathBuf,
    lock_path: PathBuf,
}

/// True only when this project was saved as on. Any problem reading the file is off,
/// so a bad file cannot turn a new worktree sparse.
pub fn enabled_for(env: &SparseEnv, repo: &Path) -> bool {
    let Ok(key) = project_key(repo) else {
        return false;
    };
    let Ok(place) = place(env) else {
        return false;
    };
    match load(&place) {
        Ok(Saved::Ready(keys)) => keys.contains(&key),
        _ => false,
    }
}

pub fn settings_for(env: &SparseEnv, repo: &Path) -> Result<SparseSettings, String> {
    let key = project_key(repo)?;
    let place = place(env)?;
    match load(&place)? {
        Saved::Missing => Ok(view(false, true)),
        Saved::Ready(keys) => Ok(view(keys.contains(&key), true)),
        Saved::Unreadable => Ok(view(false, false)),
    }
}

/// `previous` is the on/off value the caller last read for this project. The file
/// changes only when that still matches. The same value again does not rewrite it.
pub fn set_enabled(
    env: &SparseEnv,
    repo: &Path,
    enabled: bool,
    previous: bool,
) -> Result<SparseSettings, String> {
    let key = project_key(repo)?;
    let place = place(env)?;
    let _lock = Lock::acquire(&place)?;
    apply(&place, &key, enabled, previous)
}

fn apply(
    place: &Place,
    key: &str,
    enabled: bool,
    previous: bool,
) -> Result<SparseSettings, String> {
    let saved = load(place)?;
    let current = match &saved {
        Saved::Missing => false,
        Saved::Ready(keys) => keys.contains(key),
        Saved::Unreadable => {
            if previous {
                return Err(UNREADABLE.to_string());
            }
            false
        }
    };
    if current != previous {
        return Err(CONFLICT.to_string());
    }
    if current == enabled {
        let readable = !matches!(saved, Saved::Unreadable);
        return Ok(view(enabled, readable));
    }
    let mut keys = match saved {
        Saved::Ready(keys) => keys,
        _ => BTreeSet::new(),
    };
    if enabled {
        keys.insert(key.to_string());
        create_state(place)?;
        write_file(place, &keys)?;
    } else {
        keys.remove(key);
        if keys.is_empty() {
            remove_settings(place)?;
        } else {
            create_state(place)?;
            write_file(place, &keys)?;
        }
    }
    Ok(view(enabled, true))
}

fn view(enabled: bool, readable: bool) -> SparseSettings {
    SparseSettings { enabled, readable }
}

fn project_key(path: &Path) -> Result<String, String> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(NOT_FOUND.to_string());
    }
    let canon = crate::fs::canonical(path).map_err(|_| NOT_FOUND.to_string())?;
    if !canon.is_dir() {
        return Err(NOT_FOUND.to_string());
    }
    canon
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| NOT_FOUND.to_string())
}

fn place(env: &SparseEnv) -> Result<Place, String> {
    let data = crate::fs::canonical(&env.data_dir).map_err(|_| CANT_SAVE.to_string())?;
    if !data.is_dir() {
        return Err(CANT_SAVE.to_string());
    }
    let state = data.join(DIR_NAME);
    Ok(Place {
        file: state.join(FILE_NAME),
        lock_path: data.join(LOCK_NAME),
        data,
        state,
    })
}

fn is_link(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        junction::exists(path).unwrap_or(false)
    }
    #[cfg(not(windows))]
    false
}

fn ensure_state(place: &Place) -> Result<(), String> {
    if is_link(&place.state) || is_link(&place.file) || is_link(&place.lock_path) {
        return Err(LINK_REFUSED.to_string());
    }
    if place.state.exists() {
        state_is_inside(place)?;
    }
    Ok(())
}

fn state_is_inside(place: &Place) -> Result<(), String> {
    let real = crate::fs::canonical(&place.state).map_err(|_| OUTSIDE.to_string())?;
    if real.parent() != Some(place.data.as_path()) || real.file_name() != Some(DIR_NAME.as_ref()) {
        return Err(OUTSIDE.to_string());
    }
    Ok(())
}

fn create_state(place: &Place) -> Result<(), String> {
    ensure_state(place)?;
    if place.state.exists() {
        if !place.state.is_dir() {
            return Err(CANT_SAVE.to_string());
        }
        return Ok(());
    }
    std::fs::create_dir(&place.state).map_err(|_| CANT_SAVE.to_string())?;
    if is_link(&place.state) {
        return Err(LINK_REFUSED.to_string());
    }
    state_is_inside(place)
}

fn load(place: &Place) -> Result<Saved, String> {
    ensure_state(place)?;
    if is_link(&place.file) {
        return Err(LINK_REFUSED.to_string());
    }
    if !place.file.exists() {
        return Ok(Saved::Missing);
    }
    let bytes = match std::fs::read(&place.file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Saved::Missing),
        Err(_) => return Ok(Saved::Unreadable),
    };
    match serde_json::from_slice::<FileBody>(&bytes) {
        Ok(body) => Ok(Saved::Ready(body.enabled)),
        Err(_) => Ok(Saved::Unreadable),
    }
}

fn encode(keys: &BTreeSet<String>) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(&FileBody {
        enabled: keys.clone(),
    })
    .map_err(|_| CANT_SAVE.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn inside_state(place: &Place, path: &Path) -> bool {
    let Ok(real) = crate::fs::canonical(path) else {
        return false;
    };
    real.parent() == Some(place.state.as_path())
}

fn write_file(place: &Place, keys: &BTreeSet<String>) -> Result<(), String> {
    if is_link(&place.state) || is_link(&place.file) {
        return Err(LINK_REFUSED.to_string());
    }
    state_is_inside(place)?;
    let bytes = encode(keys)?;
    if std::fs::read(&place.file).ok().as_ref() == Some(&bytes) {
        return Ok(());
    }
    let part = place
        .state
        .join(format!(".settings.{}.part", std::process::id()));
    if part.parent() != Some(place.state.as_path()) || is_link(&part) {
        return Err(OUTSIDE.to_string());
    }
    if part.exists() {
        if !inside_state(place, &part) {
            return Err(OUTSIDE.to_string());
        }
        std::fs::remove_file(&part).map_err(|_| CANT_SAVE.to_string())?;
    }
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .map_err(|_| CANT_SAVE.to_string())?;
        file.write_all(&bytes).map_err(|_| CANT_SAVE.to_string())?;
        file.sync_all().ok();
    }
    if !inside_state(place, &part) {
        return Err(OUTSIDE.to_string());
    }
    std::fs::rename(&part, &place.file).map_err(|error| {
        let _ = std::fs::remove_file(&part);
        error.to_string()
    })?;
    if is_link(&place.file) || !inside_state(place, &place.file) {
        return Err(OUTSIDE.to_string());
    }
    Ok(())
}

fn remove_settings(place: &Place) -> Result<(), String> {
    if is_link(&place.file) {
        return Err(LINK_REFUSED.to_string());
    }
    if !place.file.exists() {
        return Ok(());
    }
    if !inside_state(place, &place.file) {
        return Err(OUTSIDE.to_string());
    }
    std::fs::remove_file(&place.file).map_err(|_| CANT_SAVE.to_string())
}

struct Lock {
    path: PathBuf,
}

impl Lock {
    fn acquire(place: &Place) -> Result<Self, String> {
        if is_link(&place.lock_path) || is_link(&place.state) {
            return Err(LINK_REFUSED.to_string());
        }
        let deadline = std::time::Instant::now() + LOCK_WAIT;
        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&place.lock_path)
            {
                Ok(_) => {
                    return Ok(Self {
                        path: place.lock_path.clone(),
                    })
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    if is_link(&place.lock_path) {
                        return Err(LINK_REFUSED.to_string());
                    }
                    if lock_is_stale(&place.lock_path) {
                        let _ = std::fs::remove_file(&place.lock_path);
                    } else if std::time::Instant::now() >= deadline {
                        return Err(BUSY.to_string());
                    } else {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                }
                Err(_) => return Err(CANT_SAVE.to_string()),
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn lock_is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > LOCK_STALE)
}

#[tauri::command(async)]
pub async fn sparse_checkout_settings(
    app: AppHandle,
    cwd: String,
) -> Result<SparseSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings_for(&env_from_app(&app), &crate::fs::expand_home(&cwd))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn sparse_checkout_set(
    app: AppHandle,
    cwd: String,
    enabled: bool,
    previous: bool,
) -> Result<SparseSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_enabled(
            &env_from_app(&app),
            &crate::fs::expand_home(&cwd),
            enabled,
            previous,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `Ok(None)` when this project is off: nothing is spawned. `Ok(Some)` when the tool
/// made the checkout. `Err` when it is on and the tool cannot, including an unset pin.
/// Callers must not use git after `Err`.
pub fn open_if_enabled(
    env: &SparseEnv,
    root: &Path,
    branch: &str,
    base: &str,
    existing: bool,
) -> Result<Option<crate::worktrees::Worktree>, String> {
    if !enabled_for(env, root) {
        return Ok(None);
    }
    let plan = crate::worktrees::plan_new(root, branch, base, existing)?;
    let Some(launch) = env.launch.as_ref() else {
        return Err(PIN_UNSET.to_string());
    };
    if launch.program.as_os_str().is_empty() {
        return Err(PIN_UNSET.to_string());
    }
    if plan.path == plan.main || plan.path.starts_with(&plan.main) {
        return Err("Refusing to rewrite the main checkout.".to_string());
    }
    let repo = project_key(root)?;
    let dest = crate::fs::path_to_js(&plan.path);
    let ran = run_tool(
        env,
        launch,
        root,
        &[
            "create".to_string(),
            "--repo".to_string(),
            repo,
            "--dest".to_string(),
            dest,
            "--branch".to_string(),
            plan.branch.clone(),
            "--commit".to_string(),
            plan.commit.clone(),
        ],
    );
    if !ran.ok {
        cleanup_failed(&plan.parent, &plan.path);
        return Err(ran.message());
    }
    if let Ok(trees) = crate::worktrees::list(root) {
        if let Some(tree) = trees
            .into_iter()
            .find(|tree| crate::worktrees::same_path(Path::new(&tree.path), &plan.path))
        {
            return Ok(Some(tree));
        }
    }
    match slot_tree(&plan.main, &plan.path) {
        Some(tree) => Ok(Some(tree)),
        None => {
            cleanup_failed(&plan.parent, &plan.path);
            Err(NOT_CREATED.to_string())
        }
    }
}

/// Print one relative path from the checkout's repo. Nothing else is copied in.
/// The create tests call this. There is no separate read command.
#[allow(dead_code)]
pub fn read_path(env: &SparseEnv, dest: &Path, relative: &str) -> Result<String, String> {
    let launch = env.launch.as_ref().ok_or(PIN_UNSET)?;
    let ran = run_tool(
        env,
        launch,
        dest,
        &[
            "read".to_string(),
            "--dest".to_string(),
            crate::fs::path_to_js(dest),
            "--path".to_string(),
            relative.to_string(),
        ],
    );
    if ran.ok {
        Ok(ran.stdout)
    } else {
        Err(ran.message())
    }
}

/// Sparse checkouts git does not list, beside this repo's main checkout.
pub fn unlisted_slots(main: &Path) -> Vec<crate::worktrees::Worktree> {
    let parent = crate::worktrees::default_root(main);
    let Ok(entries) = std::fs::read_dir(&parent) else {
        return Vec::new();
    };
    let mut slots = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if is_link(&path) {
            continue;
        }
        if let Some(tree) = slot_tree(main, &path) {
            slots.push(tree);
        }
    }
    slots.sort_by(|left, right| left.path.cmp(&right.path));
    slots
}

/// Delete a failed create only when the record is inside the worktree folder.
fn cleanup_failed(parent: &Path, dest: &Path) {
    if !marked_child(parent, dest) {
        return;
    }
    remove_contained(dest);
}

fn marked_child(parent: &Path, dest: &Path) -> bool {
    if is_link(dest) {
        return false;
    }
    let marker = dest.join(MARKER_NAME);
    if is_link(&marker) || !marker.is_file() {
        return false;
    }
    direct_child(parent, dest)
}

fn slot_tree(main: &Path, path: &Path) -> Option<crate::worktrees::Worktree> {
    if is_link(path) {
        return None;
    }
    let marker_path = path.join(MARKER_NAME);
    if is_link(&marker_path) || !marker_path.is_file() {
        return None;
    }
    let main_key = project_key(main).ok()?;
    let bytes = std::fs::read(&marker_path).ok()?;
    let marker: Marker = serde_json::from_slice(&bytes).ok()?;
    let repo = crate::fs::canonical(Path::new(&marker.repo)).ok()?;
    if repo.to_str() != Some(main_key.as_str()) {
        return None;
    }
    if marker.branch.is_empty()
        || marker.branch.starts_with('-')
        || marker.branch.starts_with('@')
        || marker.commit.is_empty()
    {
        return None;
    }
    let parent = crate::worktrees::default_root(main);
    if !direct_child(&parent, path) {
        return None;
    }
    let main_canon = crate::fs::canonical(main).ok()?;
    let path_canon = crate::fs::canonical(path).ok()?;
    if same_dir(&path_canon, &main_canon) {
        return None;
    }
    Some(crate::worktrees::Worktree {
        path: crate::fs::path_to_js(&path_canon),
        branch: Some(marker.branch),
        head: marker.commit,
        is_main: false,
        sparse_notice: Some(SPARSE_NOTICE.to_string()),
        ..crate::worktrees::Worktree::default()
    })
}

#[derive(Deserialize)]
struct Marker {
    repo: String,
    branch: String,
    commit: String,
}

struct Ran {
    ok: bool,
    stdout: String,
    stderr: String,
}

impl Ran {
    fn message(&self) -> String {
        let text = scrub(self.stderr.trim());
        if text.is_empty() {
            NOT_CREATED.to_string()
        } else {
            text
        }
    }
}

fn run_tool(env: &SparseEnv, launch: &Launch, cwd: &Path, args: &[String]) -> Ran {
    let mut command = crate::delivery::child(&launch.program);
    crate::hide_window_console(&mut command);
    command.args(&launch.args);
    command.args(args);
    if cwd.is_dir() {
        command.current_dir(cwd);
    }
    command.env("HOME", &env.home);
    command.env("USERPROFILE", &env.home);
    command.env("GIT_TERMINAL_PROMPT", "0");
    for key in STANDIN_ENV {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    match command.output() {
        Ok(output) => Ran {
            ok: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Err(error) => Ran {
            ok: false,
            stdout: String::new(),
            stderr: format!("The sparse tool could not be started ({error})."),
        },
    }
}

/// Hide credentials a tool might print. The placeholder is fixed so a log cannot rebuild the value.
pub fn scrub(text: &str) -> String {
    scrub_tokens(&scrub_userinfo(text))
}

fn scrub_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let scheme = &rest[..at];
        let scheme_start = scheme
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-'))
            .map(|index| {
                index
                    + scheme[index..]
                        .chars()
                        .next()
                        .map(|c| c.len_utf8())
                        .unwrap_or(1)
            })
            .unwrap_or(0);
        let name = &scheme[scheme_start..];
        let scheme_ok = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-');
        let auth_start = at + 3;
        let authority = &rest[auth_start..];
        let end = authority
            .find(['/', '?', '#', ' ', '\t', '\r', '\n'])
            .unwrap_or(authority.len());
        let authority = &authority[..end];
        if scheme_ok {
            if let Some(at_sign) = authority.rfind('@') {
                if authority[..at_sign].contains(':') {
                    out.push_str(&rest[..auth_start]);
                    out.push_str("[hidden]");
                    rest = &rest[auth_start + at_sign..];
                    continue;
                }
            }
        }
        let ch = rest.chars().next().unwrap_or(' ');
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    out.push_str(rest);
    out
}

fn scrub_tokens(text: &str) -> String {
    const PREFIXES: &[&str] = &[
        "github_pat_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "glpat-",
    ];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("Bearer ") {
            if let Some(len) = token_body(after) {
                out.push_str("[hidden]");
                rest = &after[len..];
                continue;
            }
        }
        if let Some(after) = PREFIXES.iter().find_map(|prefix| rest.strip_prefix(prefix)) {
            if let Some(len) = token_body(after) {
                out.push_str("[hidden]");
                rest = &after[len..];
                continue;
            }
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    out
}

fn token_body(text: &str) -> Option<usize> {
    let len: usize = text
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .map(char::len_utf8)
        .sum();
    if len == 0 {
        None
    } else {
        Some(len)
    }
}

fn direct_child(parent: &Path, path: &Path) -> bool {
    let Ok(parent) = crate::fs::canonical(parent) else {
        return false;
    };
    let Ok(path) = crate::fs::canonical(path) else {
        return false;
    };
    match path.parent() {
        Some(got) => same_dir(got, &parent),
        None => false,
    }
}

fn same_dir(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn remove_contained(path: &Path) {
    if is_link(path) {
        let _ = std::fs::remove_file(path);
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                remove_contained(&entry.path());
            }
        }
        let _ = std::fs::remove_dir(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Barrier};

    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "hivra-sparse-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn env(&self) -> SparseEnv {
            let data = self.root.join("data");
            std::fs::create_dir_all(&data).unwrap();
            let mut env = SparseEnv::new(data);
            env.home = self.root.join("home");
            std::fs::create_dir_all(&env.home).unwrap();
            env
        }

        fn repo(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            remove_tree(&self.root);
        }
    }

    fn remove_tree(path: &Path) {
        if is_link(path) {
            let _ = std::fs::remove_file(path);
            return;
        }
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            return;
        };
        if meta.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    remove_tree(&entry.path());
                }
            }
            let _ = std::fs::remove_dir(path);
        } else {
            let _ = std::fs::remove_file(path);
        }
    }

    fn settings_file(env: &SparseEnv) -> PathBuf {
        env.data_dir.join(DIR_NAME).join(FILE_NAME)
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) {
        junction::create(target, link).unwrap();
    }

    #[test]
    fn missing_file_reads_as_off_and_turning_off_creates_nothing() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        assert!(!enabled_for(&env, &repo));
        assert_eq!(settings_for(&env, &repo).unwrap(), view(false, true));
        set_enabled(&env, &repo, false, false).unwrap();
        assert!(!env.data_dir.join(DIR_NAME).exists());
        assert!(!settings_file(&env).exists());
        assert!(!env.data_dir.join(LOCK_NAME).exists());
    }

    #[test]
    fn turning_on_stores_only_that_project_and_the_same_value_does_not_rewrite() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo name");
        let nested = scratch.repo("repo name").join("项目");
        std::fs::create_dir_all(&nested).unwrap();
        set_enabled(&env, &repo, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
        assert!(!enabled_for(&env, &nested));
        let path = settings_file(&env);
        let before = std::fs::read(&path).unwrap();
        let stamp = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(stamp)
            .unwrap();
        set_enabled(&env, &repo, true, true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), stamp);
    }

    #[test]
    fn dotted_paths_are_one_key_and_a_missing_folder_is_refused() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let via = repo.join("..").join("repo");
        set_enabled(&env, &via, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
        assert!(enabled_for(&env, &via));
        let missing = scratch.root.join("nope");
        let saved = std::fs::read(settings_file(&env)).unwrap();
        assert_eq!(
            set_enabled(&env, &missing, true, false).unwrap_err(),
            NOT_FOUND
        );
        assert_eq!(std::fs::read(settings_file(&env)).unwrap(), saved);
        let file = scratch.root.join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            set_enabled(&env, &file, true, false).unwrap_err(),
            NOT_FOUND
        );
        assert_eq!(
            set_enabled(&env, Path::new("repo"), true, false).unwrap_err(),
            NOT_FOUND
        );
        assert_eq!(
            set_enabled(&env, Path::new(""), true, false).unwrap_err(),
            NOT_FOUND
        );
    }

    #[test]
    fn a_stale_previous_does_not_overwrite_and_two_projects_do_not_clash() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let first = scratch.repo("one");
        let second = scratch.repo("two");
        set_enabled(&env, &first, true, false).unwrap();
        assert_eq!(
            set_enabled(&env, &first, false, false).unwrap_err(),
            CONFLICT
        );
        assert!(enabled_for(&env, &first));
        set_enabled(&env, &second, true, false).unwrap();
        assert!(enabled_for(&env, &first));
        assert!(enabled_for(&env, &second));
        set_enabled(&env, &first, false, true).unwrap();
        assert!(!enabled_for(&env, &first));
        assert!(enabled_for(&env, &second));
        assert!(settings_file(&env).exists());
        set_enabled(&env, &second, false, true).unwrap();
        assert!(!settings_file(&env).exists());
    }

    #[test]
    fn corrupt_json_reads_as_off_and_a_true_previous_leaves_the_bytes() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let dir = env.data_dir.join(DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, b"{").unwrap();
        assert!(!enabled_for(&env, &repo));
        assert_eq!(settings_for(&env, &repo).unwrap(), view(false, false));
        assert_eq!(
            set_enabled(&env, &repo, true, true).unwrap_err(),
            UNREADABLE
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
        set_enabled(&env, &repo, false, false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
        set_enabled(&env, &repo, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
        assert_eq!(settings_for(&env, &repo).unwrap(), view(true, true));
    }

    #[test]
    fn odd_files_read_as_off() {
        let cases: &[&[u8]] = &[
            b"",
            b"[]",
            br#"{"enabled":true}"#,
            br#"{"enabled":[],"extra":1}"#,
            b"not json",
        ];
        for bytes in cases {
            let scratch = Scratch::new();
            let env = scratch.env();
            let repo = scratch.repo("repo");
            let dir = env.data_dir.join(DIR_NAME);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(FILE_NAME), *bytes).unwrap();
            assert!(!enabled_for(&env, &repo), "{bytes:?}");
            assert!(!settings_for(&env, &repo).unwrap().readable);
        }
    }

    #[test]
    fn crlf_and_duplicate_keys_still_read() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        set_enabled(&env, &repo, true, false).unwrap();
        let key = serde_json::to_string(&project_key(&repo).unwrap()).unwrap();
        let raw = format!("{{\"enabled\":[{key},{key}]}}\r\n");
        std::fs::write(settings_file(&env), raw).unwrap();
        assert!(enabled_for(&env, &repo));
        assert!(settings_for(&env, &repo).unwrap().readable);
    }

    #[test]
    fn a_busy_lock_is_not_a_final_failure() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let lock = env.data_dir.join(LOCK_NAME);
        File::create(&lock).unwrap();
        assert_eq!(set_enabled(&env, &repo, true, false).unwrap_err(), BUSY);
        assert!(!settings_file(&env).exists());
        std::fs::remove_file(&lock).unwrap();
        set_enabled(&env, &repo, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
    }

    #[test]
    fn a_stale_lock_is_replaced() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let lock = env.data_dir.join(LOCK_NAME);
        File::create(&lock).unwrap();
        File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(10))
            .unwrap();
        set_enabled(&env, &repo, true, false).unwrap();
        assert!(enabled_for(&env, &repo));
        assert!(!lock.exists());
    }

    #[test]
    fn two_windows_cannot_both_win() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let barrier = Arc::new(Barrier::new(2));
        let left = {
            let barrier = Arc::clone(&barrier);
            let env_dir = env.data_dir.clone();
            let repo = repo.clone();
            std::thread::spawn(move || {
                barrier.wait();
                set_enabled(&SparseEnv::new(env_dir), &repo, true, false)
            })
        };
        let right = {
            let env_dir = env.data_dir.clone();
            let repo = repo.clone();
            std::thread::spawn(move || {
                barrier.wait();
                set_enabled(&SparseEnv::new(env_dir), &repo, true, false)
            })
        };
        let results = [left.join().unwrap(), right.join().unwrap()];
        let ok = results.iter().filter(|result| result.is_ok()).count();
        let conflict = results
            .iter()
            .filter(|result| result.as_ref().err().map(String::as_str) == Some(CONFLICT))
            .count();
        assert_eq!(ok, 1, "{results:?}");
        assert_eq!(conflict, 1, "{results:?}");
        assert!(enabled_for(&env, &repo));
    }

    #[test]
    fn a_linked_state_folder_is_refused_and_its_target_is_left_alone() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let outside = scratch.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let marker = outside.join("keep.txt");
        std::fs::write(&marker, b"keep").unwrap();
        link_dir(&outside, &env.data_dir.join(DIR_NAME));
        assert!(!enabled_for(&env, &repo));
        assert_eq!(
            set_enabled(&env, &repo, true, false).unwrap_err(),
            LINK_REFUSED
        );
        assert_eq!(std::fs::read(&marker).unwrap(), b"keep");
        assert!(!outside.join(FILE_NAME).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_settings_file_is_not_followed() {
        let scratch = Scratch::new();
        let env = scratch.env();
        let repo = scratch.repo("repo");
        let outside = scratch.root.join("secret.json");
        let key = project_key(&repo).unwrap();
        let body = format!("{{\"enabled\":[\"{key}\"]}}\n");
        std::fs::write(&outside, &body).unwrap();
        let dir = env.data_dir.join(DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(FILE_NAME)).unwrap();
        assert!(!enabled_for(&env, &repo));
        assert_eq!(settings_for(&env, &repo).unwrap_err(), LINK_REFUSED);
        assert_eq!(
            set_enabled(&env, &repo, false, false).unwrap_err(),
            LINK_REFUSED
        );
        assert_eq!(std::fs::read(&outside).unwrap(), body.as_bytes());
    }

    fn git_ok(root: &Path, args: &[&str]) {
        crate::fs::git_checked(root, args)
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"));
    }

    fn git_repo(scratch: &Scratch) -> PathBuf {
        let repo = scratch.repo("repo name");
        git_ok(&repo, &["init", "-b", "main"]);
        std::fs::write(repo.join("keep.txt"), b"keep-this\n").unwrap();
        std::fs::write(repo.join("bulky.bin"), vec![7u8; 64]).unwrap();
        git_ok(&repo, &["add", "keep.txt", "bulky.bin"]);
        git_ok(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "files",
            ],
        );
        repo
    }

    fn standin() -> Launch {
        Launch {
            program: PathBuf::from("node"),
            args: vec![std::ffi::OsString::from(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/gion_standin.mjs"
            ))],
        }
    }

    fn with_tool(env: &SparseEnv) -> SparseEnv {
        let mut env = env.clone();
        env.launch = Some(standin());
        env
    }

    static TOOL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct ToolVars {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl ToolVars {
        fn set(
            log: &Path,
            fail: Option<&str>,
            env_log: Option<&Path>,
            link: bool,
            probe: bool,
        ) -> Self {
            let lock = TOOL_LOCK.lock().unwrap_or_else(|err| err.into_inner());
            std::env::set_var("GION_STANDIN_LOG", log);
            match fail {
                Some(value) => std::env::set_var("GION_STANDIN_FAIL", value),
                None => std::env::remove_var("GION_STANDIN_FAIL"),
            }
            match env_log {
                Some(path) => std::env::set_var("GION_STANDIN_ENV_LOG", path),
                None => std::env::remove_var("GION_STANDIN_ENV_LOG"),
            }
            if link {
                std::env::set_var("GION_STANDIN_LINK", "1");
            } else {
                std::env::remove_var("GION_STANDIN_LINK");
            }
            if probe {
                std::env::set_var("HIVRA_SPARSE_PROBE", "not-a-token");
            } else {
                std::env::remove_var("HIVRA_SPARSE_PROBE");
            }
            Self { _lock: lock }
        }
    }

    impl Drop for ToolVars {
        fn drop(&mut self) {
            for key in [
                "GION_STANDIN_LOG",
                "GION_STANDIN_FAIL",
                "GION_STANDIN_ENV_LOG",
                "GION_STANDIN_LINK",
                "HIVRA_SPARSE_PROBE",
            ] {
                std::env::remove_var(key);
            }
        }
    }

    fn only_main(repo: &Path) {
        let listed = crate::worktrees::list(repo).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_main);
    }

    #[test]
    fn scrub_hides_tokens_and_leaves_ordinary_text() {
        assert_eq!(scrub("ghp_EXAMPLETOKEN1234567890"), "[hidden]");
        assert_eq!(scrub("github_pat_abcDEF123"), "[hidden]");
        assert_eq!(
            scrub("gho_abc ghu_def ghs_ghi ghr_jkl"),
            "[hidden] [hidden] [hidden] [hidden]"
        );
        assert_eq!(scrub("glpat-abc_def-1"), "[hidden]");
        let bearer = scrub("Bearer ghp_abc");
        assert!(!bearer.contains("ghp_"), "a bearer token stayed visible");
        let url = scrub("https://user:s3cret@github.com/a");
        assert!(!url.contains("s3cret"), "a url password stayed visible");
        assert!(url.contains("[hidden]"));
        assert_eq!(scrub("https://github.com/a"), "https://github.com/a");
        assert_eq!(scrub("the pin isn't set"), "the pin isn't set");
        assert_eq!(scrub("ghp_"), "ghp_");
    }

    #[test]
    fn off_never_calls_the_tool_and_git_copies_both_files() {
        let scratch = Scratch::new();
        let repo = git_repo(&scratch);
        let env = with_tool(&scratch.env());
        let log = scratch.root.join("tool.log");
        let _vars = ToolVars::set(&log, None, None, false, false);
        assert!(open_if_enabled(&env, &repo, "plain", "HEAD", false)
            .unwrap()
            .is_none());
        assert!(!log.exists());
        let tree = crate::worktrees::create(&repo, "plain", "HEAD", false).unwrap();
        assert!(tree.sparse_notice.is_none());
        let path = PathBuf::from(&tree.path);
        assert_eq!(
            std::fs::read(path.join("keep.txt")).unwrap(),
            b"keep-this\n"
        );
        assert_eq!(std::fs::read(path.join("bulky.bin")).unwrap().len(), 64);
        assert!(!log.exists());
    }

    #[test]
    fn on_reads_one_path_and_leaves_bulky_files_out() {
        let scratch = Scratch::new();
        let repo = git_repo(&scratch);
        std::fs::write(repo.join("uncommitted.bin"), b"nope").unwrap();
        let env = with_tool(&scratch.env());
        set_enabled(&env, &repo, true, false).unwrap();
        let log = scratch.root.join("tool.log");
        let _vars = ToolVars::set(&log, None, None, false, false);
        let opened = open_if_enabled(&env, &repo, "sparse-one", "HEAD", false)
            .unwrap()
            .unwrap();
        assert_eq!(opened.sparse_notice.as_deref(), Some(SPARSE_NOTICE));
        assert_eq!(opened.branch.as_deref(), Some("sparse-one"));
        assert!(opened.dirty.is_none());
        let dest = PathBuf::from(&opened.path);
        assert!(!dest.join("keep.txt").exists());
        assert!(!dest.join("bulky.bin").exists());
        assert!(!dest.join("uncommitted.bin").exists());
        assert!(dest.join(MARKER_NAME).is_file());
        assert_eq!(read_path(&env, &dest, "keep.txt").unwrap(), "keep-this\n");
        assert!(!dest.join("bulky.bin").exists());
        assert!(read_path(&env, &dest, "../keep.txt").is_err());
        assert!(read_path(&env, &dest, "/keep.txt").is_err());
        assert!(read_path(&env, &dest, "sub\\keep.txt").is_err());
        assert_eq!(
            std::fs::read(repo.join("keep.txt")).unwrap(),
            b"keep-this\n"
        );
        assert!(repo.join("bulky.bin").is_file());
        only_main(&repo);
        let slots = unlisted_slots(&repo);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].sparse_notice.as_deref(), Some(SPARSE_NOTICE));
        let foreign = crate::worktrees::default_root(&repo).join("foreign");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(
            foreign.join(MARKER_NAME),
            b"{\"repo\":\"/elsewhere\",\"branch\":\"foreign\",\"commit\":\"abc\"}\n",
        )
        .unwrap();
        assert_eq!(unlisted_slots(&repo).len(), 1);
        let before = std::fs::read_to_string(&log).unwrap();
        assert!(before.contains("create"));
        let again = open_if_enabled(&env, &repo, "sparse-one", "HEAD", false).unwrap_err();
        assert!(again.contains("already exists"));
        assert_eq!(std::fs::read_to_string(&log).unwrap(), before);
    }

    #[test]
    fn refusals_do_not_call_the_tool() {
        let scratch = Scratch::new();
        let repo = git_repo(&scratch);
        let env = with_tool(&scratch.env());
        set_enabled(&env, &repo, true, false).unwrap();
        let log = scratch.root.join("tool.log");
        let _vars = ToolVars::set(&log, None, None, false, false);
        assert_eq!(
            open_if_enabled(&env, &repo, "-nope", "HEAD", false).unwrap_err(),
            "Enter a valid branch name"
        );
        assert_eq!(
            open_if_enabled(&env, &repo, "", "HEAD", false).unwrap_err(),
            "Enter a valid branch name"
        );
        assert_eq!(
            open_if_enabled(&env, &repo, "@{-1}", "HEAD", false).unwrap_err(),
            "Enter a valid branch name"
        );
        crate::worktrees::create(&repo, "taken", "HEAD", false).unwrap();
        assert_eq!(
            open_if_enabled(&env, &repo, "taken", "HEAD", false).unwrap_err(),
            "This branch already has a working copy. Select it from the picker."
        );
        assert!(!log.exists());
        assert_eq!(crate::worktrees::list(&repo).unwrap().len(), 2);
    }

    #[test]
    fn a_failed_tool_does_not_fall_back_to_git() {
        let scratch = Scratch::new();
        let repo = git_repo(&scratch);
        let env = with_tool(&scratch.env());
        set_enabled(&env, &repo, true, false).unwrap();
        let log = scratch.root.join("tool.log");
        let _vars = ToolVars::set(&log, Some("1"), None, false, false);
        let err = open_if_enabled(&env, &repo, "broken", "HEAD", false).unwrap_err();
        assert!(!err.contains("ghp_"), "tool output leaked a token prefix");
        assert!(err.contains("[hidden]"));
        let dest = crate::worktrees::default_root(&repo).join("broken");
        assert!(!dest.exists());
        only_main(&repo);
        assert!(std::fs::read(repo.join("bulky.bin")).unwrap().len() == 64);
    }

    #[test]
    fn a_failure_without_a_record_leaves_the_folder() {
        let scratch = Scratch::new();
        let repo = git_repo(&scratch);
        let env = with_tool(&scratch.env());
        set_enabled(&env, &repo, true, false).unwrap();
        let log = scratch.root.join("tool.log");
        let _vars = ToolVars::set(&log, Some("nomarker"), None, false, false);
        let err = open_if_enabled(&env, &repo, "partial", "HEAD", false).unwrap_err();
        assert_eq!(err, "stopped");
        let dest = crate::worktrees::default_root(&repo).join("partial");
        assert!(dest.is_dir());
        assert!(!dest.join(MARKER_NAME).exists());
        only_main(&repo);
    }

    #[test]
    fn an_unset_pin_creates_nothing() {
        let scratch = Scratch::new();
        let repo = git_repo(&scratch);
        let env = scratch.env();
        set_enabled(&env, &repo, true, false).unwrap();
        let log = scratch.root.join("tool.log");
        let _vars = ToolVars::set(&log, None, None, false, false);
        assert_eq!(
            open_if_enabled(&env, &repo, "missing-pin", "HEAD", false).unwrap_err(),
            PIN_UNSET
        );
        assert!(!crate::worktrees::default_root(&repo)
            .join("missing-pin")
            .exists());
        assert!(!log.exists());
        assert!(!env.data_dir.join("tools").exists());
        only_main(&repo);
    }

    #[test]
    fn the_tool_sees_home_and_not_an_unlisted_variable() {
        let scratch = Scratch::new();
        let repo = git_repo(&scratch);
        let env = with_tool(&scratch.env());
        set_enabled(&env, &repo, true, false).unwrap();
        let log = scratch.root.join("tool.log");
        let keys = scratch.root.join("env.keys");
        let _vars = ToolVars::set(&log, None, Some(&keys), false, true);
        open_if_enabled(&env, &repo, "env-check", "HEAD", false)
            .unwrap()
            .unwrap();
        let text = std::fs::read_to_string(&keys).unwrap();
        assert!(
            text.lines().any(|line| line == "HOME"),
            "home was not passed"
        );
        assert!(
            text.lines().all(|line| line != "HIVRA_SPARSE_PROBE"),
            "an unlisted variable was passed"
        );
        assert!(
            text.lines().all(|line| !line.contains('=')
                && !line.contains("not-a-token")
                && !line.contains("ghp_")),
            "env log is not keys only"
        );
    }

    #[test]
    fn a_git_worktree_from_the_tool_has_no_sparse_notice() {
        let scratch = Scratch::new();
        let repo = git_repo(&scratch);
        let env = with_tool(&scratch.env());
        set_enabled(&env, &repo, true, false).unwrap();
        let log = scratch.root.join("tool.log");
        let _vars = ToolVars::set(&log, None, None, true, false);
        let opened = open_if_enabled(&env, &repo, "linked", "HEAD", false)
            .unwrap()
            .unwrap();
        assert!(opened.sparse_notice.is_none());
        let dest = PathBuf::from(&opened.path);
        assert_eq!(
            std::fs::read(dest.join("keep.txt")).unwrap(),
            b"keep-this\n"
        );
        assert_eq!(std::fs::read(dest.join("bulky.bin")).unwrap().len(), 64);
        let listed = crate::worktrees::list(&repo).unwrap();
        assert!(listed
            .iter()
            .any(|tree| crate::worktrees::same_path(Path::new(&tree.path), &dest)));
    }
}
