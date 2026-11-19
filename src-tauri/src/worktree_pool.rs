//! WP-82: ready worktrees for a crew, driven by a pinned treehouse binary.
//!
//! Treehouse is Go, so it is not vendored. This module shells out to `get
//! --lease --json` and `return --if-lease-id`. When the download fails or the
//! pool is turned off, the caller gets a plain git worktree instead. A full
//! pool is a wait, not a failure.
//!
//! Dev copies and tests pass their own data folder and home. Their pool root
//! stays inside that data folder and is never `~/Worktrees/pool`.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::pinned_tool::{install, Asset, Pin, UreqFetcher};

pub const POOL_FULL_PREFIX: &str = "pool-full: ";
pub const POOL_FULL_NOTE: &str = "Waiting for a free worktree. The pool for this project is full.";
pub const DEFAULT_MAX_TREES: u32 = 6;
pub const TREEHOUSE_VERSION: &str = "3.1.8";

const MAX_TREES_LIMIT: u32 = 32;
const LOCK_STALE: Duration = Duration::from_secs(300);
// A writer holds the lock across the treehouse and git calls. A second writer waits for the file to go, with a
// deadline far past what a loaded machine needs; only then is the pool called full.
const LOCK_WAIT: Duration = Duration::from_secs(30);

/// treehouse v3.1.8. Checksums are the release `checksums.txt` (SHA-256 of each
/// archive). The installer keeps only `treehouse` (`treehouse.exe` on Windows).
pub const TREEHOUSE: Pin = Pin {
    name: "treehouse",
    version: TREEHOUSE_VERSION,
    url_base: "https://github.com/kunchenguid/treehouse/releases/download/v3.1.8/",
    binary: "treehouse",
    assets: &[
        Asset {
            os: "darwin",
            arch: "arm64",
            file_name: "treehouse-v3.1.8-darwin-arm64.tar.gz",
            sha256: "007c55c26e0bd8b672b1a917465f06c3f89d93a66cd171364ffb65743d268601",
        },
        Asset {
            os: "darwin",
            arch: "amd64",
            file_name: "treehouse-v3.1.8-darwin-amd64.tar.gz",
            sha256: "6be7f71cc8c6a1fbf40311af8ee3c45459c72afbab2c93dc2f80a183427bcbeb",
        },
        Asset {
            os: "linux",
            arch: "arm64",
            file_name: "treehouse-v3.1.8-linux-arm64.tar.gz",
            sha256: "3d1c02c8ab13049709ace66be51d99b72fe7b6d0b73d0d0efd90f226e1aa87d1",
        },
        Asset {
            os: "linux",
            arch: "amd64",
            file_name: "treehouse-v3.1.8-linux-amd64.tar.gz",
            sha256: "bd6227d909ba8046263ae5d4e072ccbcf43010cac9d7289b1262126510edfeed",
        },
        Asset {
            os: "windows",
            arch: "arm64",
            file_name: "treehouse-v3.1.8-windows-arm64.zip",
            sha256: "b2e74941a0c03ab59a9a783ce3fafec474523dd41963d5b5d059ccad006aa419",
        },
        Asset {
            os: "windows",
            arch: "amd64",
            file_name: "treehouse-v3.1.8-windows-amd64.zip",
            sha256: "72e7d61886e80e2befa067f5fab1c7ce2afbb49ba79c654cb7f4fc026cbc6b33",
        },
    ],
};

pub fn treehouse_pin() -> &'static Pin {
    &TREEHOUSE
}

#[derive(Clone, Debug)]
pub struct ToolLaunch {
    pub program: PathBuf,
    pub args: Vec<std::ffi::OsString>,
}

#[derive(Clone, Debug)]
pub struct PoolEnv {
    pub dev: bool,
    pub data_dir: PathBuf,
    pub home: PathBuf,
    /// Set by tests. Production resolves the pinned binary instead.
    pub launch: Option<ToolLaunch>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolPaths {
    pub root: PathBuf,
    pub slots_dir: PathBuf,
    pub template: String,
    pub state_dir: PathBuf,
}

#[derive(Debug)]
pub enum Checkout {
    Slot {
        path: PathBuf,
        /// Recorded in the lease file. Callers give the slot back by path.
        #[allow(dead_code)]
        lease_id: String,
        fresh: bool,
    },
    Full {
        note: String,
    },
    Fallback {
        notice: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PoolSettingsView {
    pub enabled: bool,
    pub interactive: bool,
    pub max_trees: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolSlot {
    pub path: String,
    pub holder: Option<String>,
    pub state: String,
    pub bytes: Option<u64>,
    pub reason: Option<String>,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatus {
    pub slots: Vec<PoolSlot>,
    pub enabled: bool,
    pub interactive: bool,
    pub max_trees: u32,
    pub tool_ready: bool,
    pub notice: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneResult {
    pub preview: bool,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Store {
    #[serde(default = "enabled_default")]
    enabled: bool,
    #[serde(default)]
    interactive: bool,
    #[serde(default)]
    max_trees: BTreeMap<String, u32>,
    #[serde(default)]
    leases: Vec<Lease>,
    #[serde(default)]
    notices: Vec<String>,
}

fn enabled_default() -> bool {
    true
}

impl Default for Store {
    fn default() -> Self {
        Self {
            enabled: true,
            interactive: false,
            max_trees: BTreeMap::new(),
            leases: Vec::new(),
            notices: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Lease {
    path: String,
    lease_id: String,
    holder: String,
    branch: String,
    repo: String,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
struct LeaseJson {
    path: String,
    lease_id: String,
    lease_holder: String,
}

#[derive(Deserialize)]
struct StatusJson {
    path: String,
    status: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    lease_holder: String,
}

pub fn paths_for(env: &PoolEnv) -> Result<PoolPaths, String> {
    let state_dir = env.data_dir.join("worktree-pool");
    let (root, slots_dir) = if env.dev {
        (state_dir.join("state"), state_dir.join("slots"))
    } else {
        let pool = env.home.join("Worktrees").join("pool");
        (pool.clone(), pool)
    };
    if env.dev {
        let real = env.home.join("Worktrees").join("pool");
        if overlaps(&real, &root) || overlaps(&real, &slots_dir) || overlaps(&real, &state_dir) {
            return Err(
                "The worktree pool can't be kept separate from the real one, so this checkout is a plain git worktree."
                    .into(),
            );
        }
    }
    let template = format!(
        "{}{}{{repo}}-{{slot}}",
        slots_dir.display(),
        std::path::MAIN_SEPARATOR
    );
    Ok(PoolPaths {
        root,
        slots_dir,
        template,
        state_dir,
    })
}

fn overlaps(pool: &Path, other: &Path) -> bool {
    component_prefix(other, pool) || component_prefix(pool, other)
}

/// `path` is `prefix` or a directory inside it, compared as spelled. Windows matches ignoring case. This is the text
/// rule the dev-copy guard and the slots folder check need: resolving `/var` to `/private/var` would make two spellings
/// of one folder look unrelated. Lease matching uses `same_path`, which resolves both sides (WP-102 item 5).
fn component_prefix(path: &Path, prefix: &Path) -> bool {
    let path = normalize(path);
    let prefix = normalize(prefix);
    let path: Vec<_> = path.components().collect();
    let prefix: Vec<_> = prefix.components().collect();
    if prefix.is_empty() || prefix.len() > path.len() {
        return false;
    }
    path.iter().zip(&prefix).all(|(left, right)| {
        if cfg!(windows) {
            left.as_os_str().eq_ignore_ascii_case(right.as_os_str())
        } else {
            left == right
        }
    })
}

/// The folder a path really names. A path that isn't there (a slot already removed) is only cleaned, never refused.
fn resolve(path: &Path) -> PathBuf {
    crate::fs::canonical(path).unwrap_or_else(|_| normalize(path))
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path` is a folder inside `dir` (not `dir` itself), by the folders' real identity. A slot reached through a link is
/// still inside the pool; a link that resolves outside it is not.
fn path_in(dir: &Path, path: &Path) -> bool {
    let dir = resolve(dir);
    let path = resolve(path);
    component_prefix(&path, &dir) && path != dir
}

/// WP-91: the folder this copy's pool hands its slots out of, or none when the pool can't be kept apart from the
/// real one (then no checkout is a slot).
pub(crate) fn slots_dir(env: &PoolEnv) -> Option<PathBuf> {
    paths_for(env).ok().map(|paths| paths.slots_dir)
}

/// [`slots_dir`] for the running app.
pub(crate) fn slots_dir_for(app: &AppHandle) -> Option<PathBuf> {
    slots_dir(&env_from_app(app))
}

/// WP-91: whether `path` is a slot of the pool that hands its slots out of `slots_dir`: a folder straight under it,
/// by the folders' real identity. The folder itself, a folder inside a slot, and a link in it that leads to some
/// other folder are not slots.
pub(crate) fn is_slot_in(slots_dir: &Path, path: &Path) -> bool {
    let (dir, path) = (resolve(slots_dir), resolve(path));
    path.parent()
        .is_some_and(|parent| component_prefix(parent, &dir) && component_prefix(&dir, parent))
}

pub fn env_from_app(app: &AppHandle) -> PoolEnv {
    let dev = crate::instance::kind() != crate::instance::Kind::Daily;
    let data_dir = crate::project_file::data_dir(app).unwrap_or_else(|_| {
        std::env::temp_dir().join(format!("monocode-hub-worktree-pool-{}", std::process::id()))
    });
    let home = dirs::home_dir().unwrap_or_else(|| data_dir.clone());
    PoolEnv {
        dev,
        data_dir,
        home,
        launch: None,
    }
}

fn store_path(state_dir: &Path) -> PathBuf {
    state_dir.join("state.json")
}

fn load_store(state_dir: &Path) -> Result<Store, String> {
    let path = store_path(state_dir);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            "The worktree pool's saved state can't be read. Nothing was changed.".into()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(error) => Err(format!(
            "The worktree pool's saved state can't be read ({error}). Nothing was changed."
        )),
    }
}

fn save_store(state_dir: &Path, store: &Store) -> Result<(), String> {
    std::fs::create_dir_all(state_dir).map_err(|error| error.to_string())?;
    let path = store_path(state_dir);
    let part = state_dir.join(format!(".state.{}.part", std::process::id()));
    {
        let mut file = std::fs::File::create(&part).map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, store).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().ok();
    }
    std::fs::rename(&part, &path).map_err(|error| {
        let _ = std::fs::remove_file(&part);
        error.to_string()
    })
}

struct Lock {
    path: PathBuf,
}

impl Lock {
    fn acquire(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let path = dir.join(".pool.lock");
        let deadline = std::time::Instant::now() + LOCK_WAIT;
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_is_stale(&path) {
                        let _ = std::fs::remove_file(&path);
                    } else {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    // Checked on the stale path too: a lock file that can't be removed is not a wait forever.
                    if std::time::Instant::now() >= deadline {
                        return Err(format!("{POOL_FULL_PREFIX}{POOL_FULL_NOTE}"));
                    }
                }
                Err(error) => return Err(error.to_string()),
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

fn notice_once(store: &mut Store, key: &str, text: &str) -> Option<String> {
    if store.notices.iter().any(|seen| seen == key) {
        return None;
    }
    store.notices.push(key.to_string());
    Some(text.to_string())
}

fn repo_key(repo: &Path) -> String {
    crate::fs::canonical(repo)
        .unwrap_or_else(|_| normalize(repo))
        .to_string_lossy()
        .into_owned()
}

fn max_for(store: &Store, repo: &str) -> u32 {
    match store.max_trees.get(repo).copied() {
        Some(value) if (1..=MAX_TREES_LIMIT).contains(&value) => value,
        _ => DEFAULT_MAX_TREES,
    }
}

fn check_holder(holder: &str) -> Result<&str, String> {
    let holder = holder.trim();
    if holder.is_empty()
        || holder.len() > 200
        || holder
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err("The worktree pool needs a plain crew name.".into());
    }
    Ok(holder)
}

fn check_branch(repo: &Path, branch: &str) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || branch.starts_with('@') {
        return Err("Enter a valid branch name".into());
    }
    git(repo, &["check-ref-format", "--branch", branch])?;
    Ok(())
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = crate::git_cmd::child();
    crate::hide_window_console(&mut command);
    let output = command
        .current_dir(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

struct Ran {
    started: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

fn run_tool(env: &PoolEnv, launch: &ToolLaunch, cwd: &Path, args: &[String]) -> Ran {
    let mut command = crate::delivery::child(&launch.program);
    command.args(&launch.args);
    command.args(args);
    command.current_dir(cwd);
    command.env("HOME", &env.home);
    command.env("USERPROFILE", &env.home);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_OPTIONAL_LOCKS", "0");
    let mut command = match pool_sandbox_prefix(&env.data_dir) {
        Ok(prefix) => crate::agent_sandbox::under_wrap(command, prefix.as_deref()),
        Err(_) => std::process::Command::new("/nonexistent/monocode-sandbox-refused"),
    };
    crate::hide_window_console(&mut command);
    match command.output() {
        Ok(output) => Ran {
            started: true,
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        },
        Err(_) => Ran {
            started: false,
            code: 1,
            stdout: String::new(),
            stderr: "The worktree pool couldn't be started.".into(),
        },
    }
}

/// Prefix for the pool tool, or nothing when the sandbox is off.
/// Unit tests stay plain. A profile that cannot be built refuses the start.
fn pool_sandbox_prefix(data_dir: &Path) -> Result<Option<Vec<std::ffi::OsString>>, String> {
    #[cfg(test)]
    {
        let _ = data_dir;
        Ok(None)
    }
    #[cfg(not(test))]
    {
        crate::agent_sandbox::action_wrap(Some(data_dir), &[])
    }
}

fn resolve_launch(env: &PoolEnv) -> Result<ToolLaunch, String> {
    if let Some(launch) = &env.launch {
        if launch.program.as_os_str().is_empty() {
            return Err("This tool's pin isn't set, so it wasn't installed.".into());
        }
        return Ok(launch.clone());
    }
    let binary = install(
        treehouse_pin(),
        &env.data_dir,
        crate::pinned_tool::host_os(),
        crate::pinned_tool::host_arch(),
        &UreqFetcher,
    )?;
    Ok(ToolLaunch {
        program: binary,
        args: Vec::new(),
    })
}

fn fallback_for(error: &str) -> (&'static str, &'static str) {
    // A timeout or a service that did not answer is not a final failure.
    if error.contains("didn't finish") {
        (
            "unavailable",
            "The worktree pool couldn't be downloaded, so this checkout is a plain git worktree.",
        )
    } else {
        (
            "not-installed",
            "The worktree pool isn't installed yet, so this checkout is a plain git worktree.",
        )
    }
}

fn remember_fallback(state_dir: &Path, key: &str, text: &str) -> Result<Option<String>, String> {
    let _lock = Lock::acquire(state_dir)?;
    let mut store = load_store(state_dir)?;
    let notice = notice_once(&mut store, key, text);
    if notice.is_some() {
        save_store(state_dir, &store)?;
    }
    Ok(notice)
}

/// Take a leased slot, or say the pool is full, or say to use a plain worktree.
/// A failure to start the tool is a fallback. A tool that ran and failed for
/// another reason is returned as an error so a second worktree is not created.
pub fn acquire(env: &PoolEnv, repo: &Path, branch: &str, holder: &str) -> Result<Checkout, String> {
    let holder = check_holder(holder)?;
    let branch = branch.trim();
    let paths = match paths_for(env) {
        Ok(paths) => paths,
        Err(reason) => {
            return Ok(Checkout::Fallback {
                notice: Some(reason),
            });
        }
    };
    let launch = match resolve_launch(env) {
        Ok(launch) => launch,
        Err(error) => {
            let (key, text) = fallback_for(&error);
            let notice = remember_fallback(&paths.state_dir, key, text)?;
            return Ok(Checkout::Fallback { notice });
        }
    };
    // A full path that isn't there is a missing tool, not a failed checkout.
    // A bare name such as `node` is left for the shell to find on PATH.
    if launch.program.is_absolute() && !launch.program.exists() {
        let notice = remember_fallback(
            &paths.state_dir,
            "not-installed",
            "The worktree pool isn't installed yet, so this checkout is a plain git worktree.",
        )?;
        return Ok(Checkout::Fallback { notice });
    }
    {
        let _lock = Lock::acquire(&paths.state_dir)?;
        let store = load_store(&paths.state_dir)?;
        if !store.enabled {
            drop(_lock);
            let notice = remember_fallback(
                &paths.state_dir,
                "disabled",
                "The worktree pool is off, so this checkout is a plain git worktree.",
            )?;
            return Ok(Checkout::Fallback { notice });
        }
    }
    check_branch(repo, branch)?;
    let _lock = Lock::acquire(&paths.state_dir)?;
    let mut store = load_store(&paths.state_dir)?;
    let repo_id = repo_key(repo);
    if let Some(lease) = store.leases.iter().find(|lease| {
        lease.holder == holder
            && lease.branch == branch
            && lease.repo == repo_id
            && !lease.path.is_empty()
    }) {
        let path = PathBuf::from(&lease.path);
        if path.is_dir() {
            return Ok(Checkout::Slot {
                path,
                lease_id: lease.lease_id.clone(),
                fresh: false,
            });
        }
    }
    let max = max_for(&store, &repo_id);
    let status = pool_status(env, &launch, repo, &paths)?;
    let free = status.iter().any(|slot| slot.status == "available");
    let occupied = status
        .iter()
        .filter(|slot| slot.status != "available")
        .count();
    let held = store
        .leases
        .iter()
        .filter(|lease| lease.repo == repo_id && Path::new(&lease.path).exists())
        .count();
    if occupied.max(held) >= max as usize && !free {
        return Ok(Checkout::Full {
            note: POOL_FULL_NOTE.into(),
        });
    }
    let args = vec![
        "get".into(),
        "--lease".into(),
        "--json".into(),
        "--lease-holder".into(),
        holder.into(),
        "-b".into(),
        branch.into(),
        "--root".into(),
        paths.root.display().to_string(),
        "--worktree-path".into(),
        paths.template.clone(),
        "--no-fetch".into(),
    ];
    let ran = run_tool(env, &launch, repo, &args);
    if !ran.started {
        drop(_lock);
        let notice = remember_fallback(
            &paths.state_dir,
            "not-installed",
            "The worktree pool isn't installed yet, so this checkout is a plain git worktree.",
        )?;
        return Ok(Checkout::Fallback { notice });
    }
    if ran.code != 0 {
        if ran.stderr.contains("max_trees") {
            return Ok(Checkout::Full {
                note: POOL_FULL_NOTE.into(),
            });
        }
        let detail = ran.stderr.trim();
        return Err(if detail.is_empty() {
            "The worktree pool couldn't hand out a checkout.".into()
        } else {
            detail.to_string()
        });
    }
    let parsed: LeaseJson = serde_json::from_str(ran.stdout.trim()).map_err(|_| {
        "The worktree pool's reply couldn't be read. Nothing else was created.".to_string()
    })?;
    let path = PathBuf::from(&parsed.path);
    if parsed.lease_id.is_empty() || !path_in(&paths.slots_dir, &path) {
        return Err(
            "The worktree pool handed back a path outside its folder, so it was refused.".into(),
        );
    }
    store.leases.retain(|lease| lease.path != parsed.path);
    store.leases.push(Lease {
        path: parsed.path,
        lease_id: parsed.lease_id.clone(),
        holder: if parsed.lease_holder.is_empty() {
            holder.to_string()
        } else {
            parsed.lease_holder
        },
        branch: branch.to_string(),
        repo: repo_id,
        reason: None,
    });
    save_store(&paths.state_dir, &store)?;
    Ok(Checkout::Slot {
        path,
        lease_id: parsed.lease_id,
        fresh: true,
    })
}

fn pool_status(
    env: &PoolEnv,
    launch: &ToolLaunch,
    repo: &Path,
    paths: &PoolPaths,
) -> Result<Vec<StatusJson>, String> {
    let args = vec![
        "status".into(),
        "--json".into(),
        "--root".into(),
        paths.root.display().to_string(),
    ];
    let ran = run_tool(env, launch, repo, &args);
    if !ran.started {
        return Err(ran.stderr);
    }
    if ran.code != 0 {
        let detail = ran.stderr.trim();
        return Err(if detail.is_empty() {
            "The worktree pool couldn't be listed.".into()
        } else {
            detail.to_string()
        });
    }
    let text = ran.stdout.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(text)
        .map_err(|_| "The worktree pool's reply couldn't be read. Nothing else was created.".into())
}

#[derive(Debug, PartialEq, Eq)]
pub enum HandBack {
    Returned,
    /// This path is not one of our leases. The caller removes it the old way.
    NotLeased,
}

/// Give a slot back. Exit 0 clears the lease. A dirty slot or a slot with a
/// process still running stays leased, and the reason is kept. Nothing is deleted.
/// A path we never leased is [`HandBack::NotLeased`] and the tool is not run.
pub fn give_back(env: &PoolEnv, repo: &Path, path: &Path) -> Result<HandBack, String> {
    let paths = paths_for(env)?;
    let _lock = Lock::acquire(&paths.state_dir)?;
    let mut store = load_store(&paths.state_dir)?;
    let Some(index) = store
        .leases
        .iter()
        .position(|lease| same_path(Path::new(&lease.path), path))
    else {
        return Ok(HandBack::NotLeased);
    };
    if !path_in(&paths.slots_dir, path) {
        return Err("That worktree is outside this copy's pool, so it was left in place.".into());
    }
    // WP-87: stop this slot's stack before the slot is returned. A failure keeps the lease.
    if let Err(error) = crate::stacks::stop_for_worktree(&env.data_dir, path) {
        store.leases[index].reason = Some(error.clone());
        save_store(&paths.state_dir, &store)?;
        return Err(error);
    }
    let launch = resolve_launch(env)?;
    let lease_id = store.leases[index].lease_id.clone();
    let lease_path = store.leases[index].path.clone();
    let args = vec![
        "return".into(),
        lease_path.clone(),
        "--if-lease-id".into(),
        lease_id,
        "--root".into(),
        paths.root.display().to_string(),
    ];
    let ran = run_tool(env, &launch, repo, &args);
    if !ran.started || ran.code != 0 {
        let reason = {
            let text = ran.stderr.trim();
            if text.is_empty() {
                "The worktree was left in place.".to_string()
            } else {
                text.to_string()
            }
        };
        store.leases[index].reason = Some(reason.clone());
        save_store(&paths.state_dir, &store)?;
        return Err(reason);
    }
    store
        .leases
        .retain(|lease| !same_path(Path::new(&lease.path), path));
    save_store(&paths.state_dir, &store)?;
    Ok(HandBack::Returned)
}

/// Whether two spellings name the same folder. WP-102 item 5: the lease table used to compare spellings, so a slot
/// reached through a link (macOS `/var` is `/private/var`) or by another letter case lost its lease. Now each side is
/// resolved first, so the folder's real identity decides; when it can't be read (the slot is gone) the spelling still
/// has a say, as before.
fn same_path(left: &Path, right: &Path) -> bool {
    if let (Ok(left), Ok(right)) = (same_identity(left), same_identity(right)) {
        if left == right {
            return true;
        }
    }
    if cfg!(windows) {
        normalize(left)
            .to_string_lossy()
            .eq_ignore_ascii_case(&normalize(right).to_string_lossy())
    } else {
        normalize(left) == normalize(right)
    }
}

/// A folder's real identity: its resolved path, with any trailing separator already gone.
fn same_identity(path: &Path) -> std::io::Result<PathBuf> {
    crate::fs::canonical(path)
}

pub fn leased_protections(data_dir: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let state_dir = data_dir.join("worktree-pool");
    let store = load_store(&state_dir)?;
    let mut out = Vec::new();
    for lease in store.leases {
        let path = PathBuf::from(&lease.path);
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            continue;
        }
        let why = match lease.reason.as_deref().filter(|reason| !reason.is_empty()) {
            Some(reason) => format!("Leased to {}. {reason}", lease.holder),
            None => format!("Leased to {}.", lease.holder),
        };
        out.push((path, why));
    }
    Ok(out)
}

fn display_state(status: &str) -> &'static str {
    match status {
        "available" => "available",
        "dirty" => "dirty",
        "damaged" | "unverified" | "locked" => "quarantined",
        _ => "leased",
    }
}

fn slot_bytes(path: &Path) -> Option<u64> {
    fn walk(path: &Path, left: &mut u32) -> Option<u64> {
        if *left == 0 {
            return None;
        }
        *left -= 1;
        let meta = std::fs::symlink_metadata(path).ok()?;
        if meta.file_type().is_symlink() {
            return Some(0);
        }
        if !meta.is_dir() {
            return Some(meta.len());
        }
        let mut total = 0u64;
        for entry in std::fs::read_dir(path).ok()?.flatten() {
            total = total.saturating_add(walk(&entry.path(), left)?);
        }
        Some(total)
    }
    let mut left = 20_000;
    walk(path, &mut left)
}

pub fn status_for(env: &PoolEnv, repo: &Path) -> Result<PoolStatus, String> {
    let paths = match paths_for(env) {
        Ok(paths) => paths,
        Err(reason) => {
            return Ok(PoolStatus {
                slots: Vec::new(),
                enabled: false,
                interactive: false,
                max_trees: DEFAULT_MAX_TREES,
                tool_ready: false,
                notice: Some(reason),
            });
        }
    };
    let store = load_store(&paths.state_dir)?;
    let repo_id = if repo.as_os_str().is_empty() {
        String::new()
    } else {
        repo_key(repo)
    };
    let settings = PoolSettingsView {
        enabled: store.enabled,
        interactive: store.interactive,
        max_trees: if repo_id.is_empty() {
            DEFAULT_MAX_TREES
        } else {
            max_for(&store, &repo_id)
        },
    };
    let launch = match resolve_launch(env) {
        Ok(launch) => launch,
        Err(error) => {
            let (_, text) = fallback_for(&error);
            return Ok(slots_from_store(&store, settings, false, Some(text.into())));
        }
    };
    if !launch.program.exists() && env.launch.is_some() {
        return Ok(slots_from_store(
            &store,
            settings,
            false,
            Some(
                "The worktree pool isn't installed yet, so this checkout is a plain git worktree."
                    .into(),
            ),
        ));
    }
    if repo.as_os_str().is_empty() || !repo.exists() {
        return Ok(slots_from_store(&store, settings, true, None));
    }
    let listed = pool_status(env, &launch, repo, &paths).unwrap_or_default();
    let mut slots = Vec::new();
    for row in &listed {
        if !path_in(&paths.slots_dir, Path::new(&row.path)) {
            continue;
        }
        let saved = store
            .leases
            .iter()
            .find(|lease| same_path(Path::new(&lease.path), Path::new(&row.path)));
        let holder = saved
            .map(|lease| lease.holder.clone())
            .filter(|holder| !holder.is_empty())
            .or_else(|| {
                if row.lease_holder.is_empty() {
                    None
                } else {
                    Some(row.lease_holder.clone())
                }
            });
        let mut state = display_state(&row.status).to_string();
        if saved.is_some() && state == "available" {
            state = "leased".into();
        }
        slots.push(PoolSlot {
            path: row.path.clone(),
            holder,
            state,
            bytes: slot_bytes(Path::new(&row.path)),
            reason: saved.and_then(|lease| lease.reason.clone()),
            branch: if row.branch.is_empty() {
                saved.map(|lease| lease.branch.clone())
            } else {
                Some(row.branch.clone())
            },
        });
    }
    Ok(PoolStatus {
        slots,
        enabled: settings.enabled,
        interactive: settings.interactive,
        max_trees: settings.max_trees,
        tool_ready: true,
        notice: if !settings.enabled {
            Some("The worktree pool is off, so checkouts are plain git worktrees.".into())
        } else {
            None
        },
    })
}

fn slots_from_store(
    store: &Store,
    settings: PoolSettingsView,
    tool_ready: bool,
    notice: Option<String>,
) -> PoolStatus {
    let slots = store
        .leases
        .iter()
        .map(|lease| PoolSlot {
            path: lease.path.clone(),
            holder: Some(lease.holder.clone()),
            state: if lease
                .reason
                .as_deref()
                .is_some_and(|reason| !reason.is_empty())
            {
                "dirty".into()
            } else {
                "leased".into()
            },
            bytes: slot_bytes(Path::new(&lease.path)),
            reason: lease.reason.clone(),
            branch: Some(lease.branch.clone()),
        })
        .collect();
    PoolStatus {
        slots,
        enabled: settings.enabled,
        interactive: settings.interactive,
        max_trees: settings.max_trees,
        tool_ready,
        notice,
    }
}

pub fn settings_for(env: &PoolEnv, repo: &Path) -> Result<PoolSettingsView, String> {
    let paths = paths_for(env)?;
    let store = load_store(&paths.state_dir)?;
    Ok(PoolSettingsView {
        enabled: store.enabled,
        interactive: store.interactive,
        max_trees: max_for(&store, &repo_key(repo)),
    })
}

pub fn set_settings(
    env: &PoolEnv,
    repo: &Path,
    enabled: bool,
    interactive: bool,
    max_trees: u32,
) -> Result<PoolSettingsView, String> {
    if !(1..=MAX_TREES_LIMIT).contains(&max_trees) {
        return Err(format!(
            "Worktrees per project must be between 1 and {MAX_TREES_LIMIT}."
        ));
    }
    let paths = paths_for(env)?;
    let _lock = Lock::acquire(&paths.state_dir)?;
    let mut store = load_store(&paths.state_dir)?;
    store.enabled = enabled;
    store.interactive = interactive;
    store.max_trees.insert(repo_key(repo), max_trees);
    save_store(&paths.state_dir, &store)?;
    Ok(PoolSettingsView {
        enabled,
        interactive,
        max_trees,
    })
}

pub fn prune(env: &PoolEnv, repo: &Path, yes: bool) -> Result<PruneResult, String> {
    let paths = paths_for(env)?;
    let launch = resolve_launch(env)
        .map_err(|_| "The worktree pool isn't installed, so nothing was removed.".to_string())?;
    let mut args = vec![
        "prune".into(),
        "--root".into(),
        paths.root.display().to_string(),
    ];
    if yes {
        args.push("--yes".into());
    }
    let ran = run_tool(env, &launch, repo, &args);
    if !ran.started || ran.code != 0 {
        return Err(if ran.stderr.trim().is_empty() {
            "Idle worktrees couldn't be listed. Nothing was removed.".into()
        } else {
            ran.stderr.trim().to_string()
        });
    }
    let lines = ran
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    Ok(PruneResult {
        preview: !yes,
        lines,
    })
}

#[tauri::command(async)]
pub async fn worktree_pool_status(app: AppHandle, cwd: String) -> Result<PoolStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        status_for(&env_from_app(&app), &crate::fs::expand_home(&cwd))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn worktree_pool_settings(
    app: AppHandle,
    cwd: String,
) -> Result<PoolSettingsView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings_for(&env_from_app(&app), &crate::fs::expand_home(&cwd))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn worktree_pool_set_settings(
    app: AppHandle,
    cwd: String,
    enabled: bool,
    interactive: bool,
    max_trees: u32,
) -> Result<PoolSettingsView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_settings(
            &env_from_app(&app),
            &crate::fs::expand_home(&cwd),
            enabled,
            interactive,
            max_trees,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn worktree_pool_prune(
    app: AppHandle,
    cwd: String,
    yes: bool,
) -> Result<PruneResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prune(&env_from_app(&app), &crate::fs::expand_home(&cwd), yes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pinned_tool::binary_file_name;

    struct Tmp {
        root: PathBuf,
    }

    impl Tmp {
        fn new() -> Self {
            // Tests run in parallel, and the clock's ticks are coarse enough that two of them can land on the same
            // reading. The counter keeps every test's folder its own, so one test's cleanup can't remove another's.
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "wp82-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            if self.root.starts_with(std::env::temp_dir()) {
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }
    }

    struct Fix {
        tmp: Tmp,
        home: PathBuf,
        data: PathBuf,
        repo: PathBuf,
    }

    impl Fix {
        fn new() -> Self {
            let tmp = Tmp::new();
            let home = tmp.root.join("home café");
            let data = tmp.root.join("data");
            let repo = tmp.root.join("my repo");
            let origin = tmp.root.join("origin.git");
            std::fs::create_dir_all(&home).unwrap();
            std::fs::create_dir_all(&data).unwrap();
            git_ok(&tmp.root, &["init", "--bare", origin.to_str().unwrap()]);
            git_ok(&tmp.root, &["init", "-b", "main", repo.to_str().unwrap()]);
            git_ok(
                &repo,
                &["remote", "add", "origin", origin.to_str().unwrap()],
            );
            std::fs::write(repo.join(".gitignore"), "node_modules/\ntarget/\n").unwrap();
            std::fs::write(repo.join("README"), "hello\n").unwrap();
            git_ok(&repo, &["add", ".gitignore", "README"]);
            git_ok(&repo, &["commit", "-qm", "initial"]);
            let pool = home.join("Worktrees").join("pool");
            std::fs::create_dir_all(&pool).unwrap();
            std::fs::write(pool.join("MARKER"), b"keep").unwrap();
            Self {
                tmp,
                home,
                data,
                repo,
            }
        }

        fn env(&self) -> PoolEnv {
            PoolEnv {
                dev: true,
                data_dir: self.data.clone(),
                home: self.home.clone(),
                launch: Some(standin()),
            }
        }

        fn marker_ok(&self) {
            let pool = self.home.join("Worktrees").join("pool");
            assert_eq!(std::fs::read(pool.join("MARKER")).unwrap(), b"keep");
            assert!(!pool.join(".treehouse").exists());
            let names: Vec<_> = std::fs::read_dir(&pool)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(names, vec!["MARKER".to_string()]);
        }
    }

    fn standin() -> ToolLaunch {
        ToolLaunch {
            program: PathBuf::from("node"),
            args: vec![std::ffi::OsString::from(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/treehouse_standin.mjs"
            ))],
        }
    }

    fn git_ok(cwd: &Path, args: &[&str]) {
        let output = crate::git_cmd::git()
            .current_dir(cwd)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_COUNT", "0")
            .output()
            .unwrap_or_else(|error| panic!("git failed to start: {error}"));
        assert!(
            output.status.success(),
            "git {args:?} -> {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn slot(checkout: Checkout) -> (PathBuf, String) {
        match checkout {
            Checkout::Slot { path, lease_id, .. } => (path, lease_id),
            Checkout::Full { note } => panic!("pool full: {note}"),
            Checkout::Fallback { notice } => panic!("fallback: {notice:?}"),
        }
    }

    fn argv_log(env: &PoolEnv) -> String {
        let path = paths_for(env).unwrap().root.join("argv.log");
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn two_crews_get_different_slots_and_the_real_pool_is_untouched() {
        let fix = Fix::new();
        let env = fix.env();
        let (first, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        let (second, _) = slot(acquire(&env, &fix.repo, "mc/orch-bbbb", "crew-b").unwrap());
        assert_ne!(first, second);
        assert!(first.starts_with(fix.data.join("worktree-pool").join("slots")));
        assert!(second.starts_with(fix.data.join("worktree-pool").join("slots")));
        fix.marker_ok();
    }

    #[test]
    fn return_reuses_the_slot_and_keeps_node_modules_and_target() {
        let fix = Fix::new();
        let env = fix.env();
        let (first, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        std::fs::create_dir_all(first.join("node_modules")).unwrap();
        std::fs::write(first.join("node_modules").join("keep"), b"modules").unwrap();
        std::fs::create_dir_all(first.join("target")).unwrap();
        std::fs::write(first.join("target").join("keep"), b"build").unwrap();
        give_back(&env, &fix.repo, &first).unwrap();
        let (second, _) = slot(acquire(&env, &fix.repo, "mc/orch-cccc", "crew-c").unwrap());
        assert_eq!(normalize(&first), normalize(&second));
        assert_eq!(
            std::fs::read(second.join("node_modules").join("keep")).unwrap(),
            b"modules"
        );
        assert_eq!(
            std::fs::read(second.join("target").join("keep")).unwrap(),
            b"build"
        );
        fix.marker_ok();
    }

    #[test]
    fn returning_a_slot_stops_its_stack_first() {
        let fix = Fix::new();
        let env = fix.env();
        let (path, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        let stacks = fix.data.join("worktree-stacks");
        std::fs::create_dir_all(&stacks).unwrap();
        std::fs::write(stacks.join("stand-in"), b"ok").unwrap();
        crate::stacks::remember_running(&fix.data, &path, "hivra-s0123abcd", true);
        give_back(&env, &fix.repo, &path).unwrap();
        let log = std::fs::read_to_string(stacks.join("log")).unwrap();
        assert!(log.contains("down hivra-s0123abcd"), "{log}");
        assert!(!log.contains("up "), "{log}");
        let again = acquire(&env, &fix.repo, "mc/orch-bbbb", "crew-b").unwrap();
        let (reused, _) = slot(again);
        assert_eq!(normalize(&path), normalize(&reused));
        fix.marker_ok();
    }

    #[test]
    fn a_stack_that_will_not_stop_keeps_the_lease() {
        let fix = Fix::new();
        let env = fix.env();
        let (path, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        let stacks = fix.data.join("worktree-stacks");
        std::fs::create_dir_all(&stacks).unwrap();
        std::fs::write(stacks.join("stand-in"), b"fail").unwrap();
        crate::stacks::remember_running(&fix.data, &path, "hivra-s0123abcd", true);
        let error = give_back(&env, &fix.repo, &path).unwrap_err();
        assert!(error.contains("refused"), "{error}");
        assert!(
            !argv_log(&env).contains("return"),
            "the slot must stay leased"
        );
        let held = leased_protections(&fix.data).unwrap();
        assert!(
            held.iter().any(|(leased, _)| same_path(leased, &path)),
            "{held:?}"
        );
        fix.marker_ok();
    }

    #[test]
    fn a_dirty_slot_stays_leased_and_shows_its_reason() {
        let fix = Fix::new();
        let env = fix.env();
        let (path, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        std::fs::write(path.join("README"), "changed\n").unwrap();
        let error = give_back(&env, &fix.repo, &path).unwrap_err();
        assert!(error.contains("left in place"), "{error}");
        assert!(path.join("README").is_file());
        let protections = leased_protections(&fix.data).unwrap();
        assert!(
            protections
                .iter()
                .any(|(leased, why)| same_path(leased, &path)
                    && why.contains("crew-a")
                    && why.contains("left in place")),
            "{protections:?}"
        );
        let again = give_back(&env, &fix.repo, &path).unwrap_err();
        assert!(again.contains("left in place"), "{again}");
        fix.marker_ok();
    }

    #[test]
    fn a_running_process_keeps_the_lease() {
        let fix = Fix::new();
        let env = fix.env();
        let (path, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        std::fs::write(path.join(".pool-busy"), b"1").unwrap();
        let error = give_back(&env, &fix.repo, &path).unwrap_err();
        assert!(error.contains("process"), "{error}");
        assert_eq!(leased_protections(&fix.data).unwrap().len(), 1);
        fix.marker_ok();
    }

    #[test]
    fn a_full_pool_queues_instead_of_failing() {
        let fix = Fix::new();
        let env = fix.env();
        set_settings(&env, &fix.repo, true, false, 1).unwrap();
        let _first = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        let log_before = argv_log(&env).matches("\"command\":\"get\"").count();
        match acquire(&env, &fix.repo, "mc/orch-bbbb", "crew-b").unwrap() {
            Checkout::Full { note } => {
                assert!(note.contains("Waiting for a free worktree"), "{note}")
            }
            other => panic!("expected a full pool, got {other:?}"),
        }
        assert_eq!(
            argv_log(&env).matches("\"command\":\"get\"").count(),
            log_before
        );
        fix.marker_ok();
    }

    #[test]
    fn the_tools_own_full_message_is_a_wait_and_records_no_lease() {
        let fix = Fix::new();
        let env = fix.env();
        let root = paths_for(&env).unwrap().root;
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("refuse-get.txt"), "refusing: max_trees = 1\n").unwrap();
        match acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap() {
            Checkout::Full { note } => assert!(note.contains("Waiting for a free worktree")),
            other => panic!("expected a full pool, got {other:?}"),
        }
        assert!(leased_protections(&fix.data).unwrap().is_empty());
        fix.marker_ok();
    }

    #[test]
    fn a_missing_tool_falls_back_once_and_does_not_touch_the_pool() {
        let fix = Fix::new();
        let mut env = fix.env();
        env.launch = Some(ToolLaunch {
            program: fix.tmp.root.join("no-such-treehouse"),
            args: Vec::new(),
        });
        match acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap() {
            Checkout::Fallback { notice } => {
                let notice = notice.expect("the reason is said once");
                assert!(notice.contains("isn't installed"), "{notice}");
            }
            other => panic!("expected a fallback, got {other:?}"),
        }
        match acquire(&env, &fix.repo, "mc/orch-bbbb", "crew-b").unwrap() {
            Checkout::Fallback { notice } => assert!(notice.is_none(), "{notice:?}"),
            other => panic!("expected a quiet fallback, got {other:?}"),
        }
        fix.marker_ok();
    }

    #[test]
    fn turning_the_pool_off_falls_back_once() {
        let fix = Fix::new();
        let env = fix.env();
        set_settings(&env, &fix.repo, false, false, 6).unwrap();
        match acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap() {
            Checkout::Fallback { notice } => {
                assert!(notice.unwrap().contains("pool is off"));
            }
            other => panic!("expected a fallback, got {other:?}"),
        }
        match acquire(&env, &fix.repo, "mc/orch-bbbb", "crew-b").unwrap() {
            Checkout::Fallback { notice } => assert!(notice.is_none()),
            other => panic!("expected a quiet fallback, got {other:?}"),
        }
        assert!(!paths_for(&env).unwrap().root.join("argv.log").exists());
        fix.marker_ok();
    }

    #[test]
    fn a_dev_copy_whose_data_sits_in_the_real_pool_does_not_use_it() {
        let fix = Fix::new();
        let mut env = fix.env();
        env.data_dir = fix.home.join("Worktrees").join("pool").join("nested");
        match acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap() {
            Checkout::Fallback { notice } => {
                assert!(notice.unwrap().contains("plain git worktree"));
            }
            other => panic!("expected a fallback, got {other:?}"),
        }
        let pool = fix.home.join("Worktrees").join("pool");
        assert_eq!(std::fs::read(pool.join("MARKER")).unwrap(), b"keep");
        assert!(!pool.join("argv.log").exists());
        assert!(!env.data_dir.exists());
    }

    #[test]
    fn get_does_not_fetch_or_force_and_a_bad_origin_is_left_alone() {
        let fix = Fix::new();
        let env = fix.env();
        git_ok(
            &fix.repo,
            &[
                "remote",
                "set-url",
                "origin",
                "file://not-a-real-origin/nope",
            ],
        );
        let _slot = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        let log = argv_log(&env);
        assert!(log.contains("\"no-fetch\":true"), "{log}");
        assert!(!log.contains("force"), "{log}");
        assert!(log.contains("\"lease\":true"), "{log}");
        assert!(log.contains("crew-a"), "{log}");
        let (path, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        give_back(&env, &fix.repo, &path).unwrap();
        let log = argv_log(&env);
        let return_line = log
            .lines()
            .find(|line| line.contains("\"command\":\"return\""))
            .expect("return was recorded");
        assert!(!return_line.contains("force"), "{return_line}");
        assert!(return_line.contains("if-lease-id"), "{return_line}");
        fix.marker_ok();
    }

    #[test]
    fn paths_for_a_dev_copy_stay_in_the_data_folder() {
        let fix = Fix::new();
        let dev = paths_for(&fix.env()).unwrap();
        assert!(dev.root.starts_with(&fix.data));
        assert!(dev.slots_dir.starts_with(&fix.data));
        assert!(dev.template.contains("{repo}"));
        assert!(dev.template.contains("{slot}"));
        assert!(!dev.template.contains(".."));
        let daily = paths_for(&PoolEnv {
            dev: false,
            data_dir: fix.data.clone(),
            home: fix.home.clone(),
            launch: None,
        })
        .unwrap();
        assert_eq!(daily.root, fix.home.join("Worktrees").join("pool"));
        assert!(
            !daily.root.exists()
                || fix
                    .home
                    .join("Worktrees")
                    .join("pool")
                    .join("MARKER")
                    .exists()
        );
    }

    #[test]
    fn defaults_are_on_interactive_off_and_six_and_garbage_is_not_trusted() {
        let fix = Fix::new();
        let env = fix.env();
        let view = settings_for(&env, &fix.repo).unwrap();
        assert!(view.enabled);
        assert!(!view.interactive);
        assert_eq!(view.max_trees, 6);
        let state = paths_for(&env).unwrap().state_dir;
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("state.json"), b"not json").unwrap();
        let error = settings_for(&env, &fix.repo).unwrap_err();
        assert!(error.contains("can't be read"), "{error}");
        assert!(set_settings(&env, &fix.repo, true, true, 0).is_err());
    }

    #[test]
    fn treehouse_pin_matches_the_v3_1_8_release() {
        let pin = treehouse_pin();
        assert_eq!(pin.name, "treehouse");
        assert_eq!(pin.version, "3.1.8");
        assert_eq!(pin.binary, "treehouse");
        assert_eq!(
            pin.url_base,
            "https://github.com/kunchenguid/treehouse/releases/download/v3.1.8/"
        );
        let want = [
            (
                "darwin",
                "arm64",
                "treehouse-v3.1.8-darwin-arm64.tar.gz",
                "007c55c26e0bd8b672b1a917465f06c3f89d93a66cd171364ffb65743d268601",
            ),
            (
                "darwin",
                "amd64",
                "treehouse-v3.1.8-darwin-amd64.tar.gz",
                "6be7f71cc8c6a1fbf40311af8ee3c45459c72afbab2c93dc2f80a183427bcbeb",
            ),
            (
                "linux",
                "arm64",
                "treehouse-v3.1.8-linux-arm64.tar.gz",
                "3d1c02c8ab13049709ace66be51d99b72fe7b6d0b73d0d0efd90f226e1aa87d1",
            ),
            (
                "linux",
                "amd64",
                "treehouse-v3.1.8-linux-amd64.tar.gz",
                "bd6227d909ba8046263ae5d4e072ccbcf43010cac9d7289b1262126510edfeed",
            ),
            (
                "windows",
                "arm64",
                "treehouse-v3.1.8-windows-arm64.zip",
                "b2e74941a0c03ab59a9a783ce3fafec474523dd41963d5b5d059ccad006aa419",
            ),
            (
                "windows",
                "amd64",
                "treehouse-v3.1.8-windows-amd64.zip",
                "72e7d61886e80e2befa067f5fab1c7ce2afbb49ba79c654cb7f4fc026cbc6b33",
            ),
        ];
        assert_eq!(pin.assets.len(), want.len());
        for asset in pin.assets {
            let row = want
                .iter()
                .find(|row| row.0 == asset.os && row.1 == asset.arch)
                .unwrap_or_else(|| panic!("no asset for {}-{}", asset.os, asset.arch));
            assert_eq!(asset.file_name, row.2);
            assert_eq!(asset.sha256, row.3);
            assert_eq!(asset.sha256.len(), 64);
            let binary = binary_file_name(pin.binary, asset.os);
            if asset.os == "windows" {
                assert_eq!(binary, "treehouse.exe");
            } else {
                assert_eq!(binary, "treehouse");
            }
        }
    }

    #[test]
    fn a_bad_holder_is_refused_before_the_tool_runs() {
        let fix = Fix::new();
        let env = fix.env();
        assert!(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew/a").is_err());
        assert!(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew\na").is_err());
        assert!(!paths_for(&env).unwrap().root.join("argv.log").exists());
    }

    #[test]
    fn prune_previews_before_it_removes_and_never_takes_a_lease() {
        let fix = Fix::new();
        let env = fix.env();
        let (leased, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        let (idle, _) = slot(acquire(&env, &fix.repo, "mc/orch-bbbb", "crew-b").unwrap());
        give_back(&env, &fix.repo, &idle).unwrap();
        let preview = prune(&env, &fix.repo, false).unwrap();
        assert!(preview.preview);
        assert!(
            preview
                .lines
                .iter()
                .any(|line| line.contains(&idle.display().to_string())
                    && line.contains("would remove")),
            "{:?}",
            preview.lines
        );
        assert!(leased.is_dir());
        assert!(idle.is_dir());
        let done = prune(&env, &fix.repo, true).unwrap();
        assert!(!done.preview);
        assert!(leased.is_dir(), "a leased slot must stay");
        assert!(
            !idle.exists(),
            "an idle slot is removed only after the confirm"
        );
        let log = argv_log(&env);
        assert!(!log.contains("include-leased"), "{log}");
        fix.marker_ok();
    }

    // WP-102 item 5: a lease is matched by the folder it names, not the letters it was spelled with. macOS aliases
    // /var to /private/var, so a caller can reach the same slot by another spelling; that is the same worktree.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_spelling_with_a_trailing_slash_is_the_same_slot() {
        let fix = Fix::new();
        let env = fix.env();
        let (leased, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        // A link beside the pool that resolves to the slot's own folder, the way /var resolves to /private/var.
        let alias = fix.tmp.root.join("alias");
        std::os::unix::fs::symlink(&leased, &alias).unwrap();
        let mut spelled = alias.to_string_lossy().into_owned();
        spelled.push(std::path::MAIN_SEPARATOR);
        assert_eq!(
            give_back(&env, &fix.repo, Path::new(&spelled)).unwrap(),
            HandBack::Returned,
            "a symlinked spelling with a trailing slash is the same slot"
        );
        assert!(leased_protections(&fix.data).unwrap().is_empty());
        fix.marker_ok();
    }

    #[cfg(windows)]
    #[test]
    fn a_differently_cased_spelling_is_the_same_slot() {
        let fix = Fix::new();
        let env = fix.env();
        let (leased, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        let spelled = leased.to_string_lossy().to_uppercase();
        assert_eq!(
            give_back(&env, &fix.repo, Path::new(&spelled)).unwrap(),
            HandBack::Returned,
            "a differently cased spelling is the same slot"
        );
        assert!(leased_protections(&fix.data).unwrap().is_empty());
        fix.marker_ok();
    }

    // The other half of the same rule: the repo is keyed by its real folder too, so a second call by another spelling
    // reuses the crew's lease instead of taking a fresh slot.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_repo_spelling_reuses_the_crew_lease() {
        let fix = Fix::new();
        let env = fix.env();
        let (first, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        let alias = fix.tmp.root.join("repo-alias");
        std::os::unix::fs::symlink(&fix.repo, &alias).unwrap();
        let (again, _) = slot(acquire(&env, &alias, "mc/orch-aaaa", "crew-a").unwrap());
        assert_eq!(
            resolve(&first),
            resolve(&again),
            "the same crew and branch get the slot they already hold"
        );
        assert_eq!(
            argv_log(&env).matches("\"command\":\"get\"").count(),
            1,
            "the pool is asked once, not again for the other spelling"
        );
        fix.marker_ok();
    }

    // The other half of the same rule: a slot reached through a link is still inside the pool, so its lease is found
    // there. A link that resolves outside the pool is refused, because the folder really is outside.
    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_pool_is_still_outside_it() {
        let fix = Fix::new();
        let env = fix.env();
        let (leased, _) = slot(acquire(&env, &fix.repo, "mc/orch-aaaa", "crew-a").unwrap());
        let outside = fix.tmp.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep"), b"stay").unwrap();
        let link = fix.tmp.root.join("link-out");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(
            give_back(&env, &fix.repo, &link).unwrap(),
            HandBack::NotLeased,
            "a link to a folder the pool never leased is not a lease"
        );
        assert_eq!(std::fs::read(outside.join("keep")).unwrap(), b"stay");
        assert!(leased.is_dir());
        fix.marker_ok();
    }

    #[test]
    fn give_back_of_the_real_pool_does_not_touch_it() {
        let fix = Fix::new();
        let env = fix.env();
        let outside = fix.home.join("Worktrees").join("pool").join("x");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep"), b"stay").unwrap();
        assert_eq!(
            give_back(&env, &fix.repo, &outside).unwrap(),
            HandBack::NotLeased
        );
        assert_eq!(std::fs::read(outside.join("keep")).unwrap(), b"stay");
        let paths = paths_for(&env).unwrap();
        let leased = serde_json::json!({
            "leases": [{
                "path": outside,
                "lease_id": "abc",
                "holder": "crew-a",
                "branch": "mc/orch-aaaa",
                "repo": "r"
            }]
        });
        std::fs::create_dir_all(&paths.state_dir).unwrap();
        std::fs::write(
            paths.state_dir.join("state.json"),
            serde_json::to_vec(&leased).unwrap(),
        )
        .unwrap();
        let error = give_back(&env, &fix.repo, &outside).unwrap_err();
        assert!(error.contains("outside"), "{error}");
        assert_eq!(std::fs::read(outside.join("keep")).unwrap(), b"stay");
        assert!(!paths.root.join("argv.log").exists());
    }

    // The store's lock is held across the treehouse and git calls, which on a loaded machine can take well over a
    // second. A second writer waits for the file to go; it is not a full pool.
    #[test]
    fn a_slow_writer_is_waited_for_instead_of_reported_as_a_full_pool() {
        let tmp = Tmp::new();
        let state_dir = tmp.root.join("state");
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let writer = {
            let dir = state_dir.clone();
            std::thread::spawn(move || {
                let lock = Lock::acquire(&dir).unwrap();
                held_tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(1500));
                drop(lock);
            })
        };
        held_rx.recv().unwrap();
        let started = std::time::Instant::now();
        let lock = Lock::acquire(&state_dir)
            .expect("a lock held by a slow writer is waited for, not called a full pool");
        assert!(
            started.elapsed() >= Duration::from_millis(1200),
            "the second writer waited"
        );
        drop(lock);
        writer.join().unwrap();
        assert!(!state_dir.join(".pool.lock").exists());
    }
}
