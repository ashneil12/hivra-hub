// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/portless packages/portless/src/routes.ts (Apache-2.0).
// Copyright 2025 Vercel Inc.
// Translated to Rust for Hivra WP-90, with its tests: the mkdir lock, owner-only removal,
// stale-owner pruning and the registry file. TLS, tunnel metadata and hosts-file sync are out.
// WP-139 (portless 0.17.0, packages/portless/src/routes.ts acquireLock): a transient Windows
// EPERM while creating the lock is retried until the lock timeout. Other errors still fail
// at once.

//! The name registry: `<data>/proxy/routes.json`, written under a mkdir lock.
//!
//! Every route names a hostname, the loopback port it reaches and the process that added it.
//! A removal only happens for the process that added the name; a name left by a dead process
//! is pruned, never silently re-pointed at whatever now holds its port.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::labels::valid_hostname;

/// A lock older than this belongs to a process that died and is taken over.
pub const STALE_LOCK: Duration = Duration::from_secs(10);
/// How long to wait for a lock before giving up.
pub const LOCK_TIMEOUT: Duration = Duration::from_secs(15);
/// First delay between lock attempts; it doubles up to `LOCK_RETRY_CAP`.
pub const LOCK_RETRY_BASE: Duration = Duration::from_millis(10);
pub const LOCK_RETRY_CAP: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub hostname: String,
    pub port: u16,
    /// The process that added the name. 0 is a static alias and never dies.
    pub pid: u32,
    /// The stack that published the name. A second stack cannot take it, even in this process.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registered_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteConflict {
    pub hostname: String,
    pub existing_pid: u32,
    /// The name belongs to another stack, which may well be a stack of this same process: the
    /// pid is then no use to a person, so the sentence names the stack instead.
    pub held_by_stack: bool,
}

impl std::fmt::Display for RouteConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.held_by_stack {
            return write!(
                f,
                "{} is already a name used by another stack. Stop that stack, or remove it if its worktree is gone.",
                self.hostname
            );
        }
        write!(
            f,
            "{} is already a name used by a running process ({})",
            self.hostname, self.existing_pid
        )
    }
}

impl std::error::Error for RouteConflict {}

/// Why a name could not be added. Both read as a sentence a person can act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouteError {
    /// Another live process holds the name.
    Conflict(RouteConflict),
    /// The name failed the hostname check, or the list could not be written.
    Refused(String),
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict(conflict) => conflict.fmt(f),
            Self::Refused(text) => text.fmt(f),
        }
    }
}

impl std::error::Error for RouteError {}

#[derive(Clone, Debug)]
pub struct LockPolicy {
    pub stale: Duration,
    pub timeout: Duration,
    pub retry_base: Duration,
    pub retry_cap: Duration,
}

impl Default for LockPolicy {
    fn default() -> Self {
        Self {
            stale: STALE_LOCK,
            timeout: LOCK_TIMEOUT,
            retry_base: LOCK_RETRY_BASE,
            retry_cap: LOCK_RETRY_CAP,
        }
    }
}

#[cfg(test)]
type LockMkdir = std::sync::Arc<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>;

/// Test stand-in for `create_dir` on the lock, including a pretend Windows host.
#[cfg(test)]
#[derive(Clone)]
struct LockSim {
    windows: bool,
    mkdir: LockMkdir,
}

#[cfg(test)]
impl std::fmt::Debug for LockSim {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LockSim")
            .field("windows", &self.windows)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct RouteStore {
    dir: PathBuf,
    policy: LockPolicy,
    #[cfg(test)]
    lock_sim: Option<LockSim>,
}

impl RouteStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            policy: LockPolicy::default(),
            #[cfg(test)]
            lock_sim: None,
        }
    }

    /// Tests only: shorten the waits. Production always uses [`RouteStore::new`].
    #[cfg(test)]
    pub fn with_policy(dir: impl Into<PathBuf>, policy: LockPolicy) -> Self {
        Self {
            dir: dir.into(),
            policy,
            lock_sim: None,
        }
    }

    /// Tests only: pretend this host is Windows, and replace the lock `create_dir`.
    #[cfg(test)]
    fn with_lock_sim(
        mut self,
        windows: bool,
        mkdir: impl Fn(&Path) -> std::io::Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.lock_sim = Some(LockSim {
            windows,
            mkdir: std::sync::Arc::new(mkdir),
        });
        self
    }

    pub fn routes_path(&self) -> PathBuf {
        self.dir.join("routes.json")
    }

    fn lock_path(&self) -> PathBuf {
        self.dir.join("routes.lock")
    }

    pub fn pid_path(&self) -> PathBuf {
        self.dir.join("proxy.pid")
    }

    pub fn port_path(&self) -> PathBuf {
        self.dir.join("proxy.port")
    }

    fn ensure_dir(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|error| format!("The proxy folder can't be made: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o755));
        }
        Ok(())
    }

    fn acquire_lock(&self) -> Result<LockGuard, String> {
        self.ensure_dir()?;
        let path = self.lock_path();
        let started = std::time::Instant::now();
        let mut delay = self.policy.retry_base;
        loop {
            match self.try_make_lock(&path) {
                Ok(()) => return Ok(LockGuard { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_is_stale(&path, self.policy.stale) {
                        let _ = std::fs::remove_dir_all(&path);
                        continue;
                    }
                }
                // A Windows indexer can return EPERM for a moment. Wait, as for a live lock.
                // The same error on Unix is a real refusal and fails just below.
                Err(error) if self.retry_windows_lock_error(&error) => {}
                Err(error) => {
                    return Err(format!(
                        "The name list is busy, so nothing changed: {error}"
                    ))
                }
            }
            if started.elapsed() >= self.policy.timeout {
                return Err("The name list is busy, so nothing changed.".into());
            }
            std::thread::sleep(delay);
            delay = (delay * 2)
                .min(self.policy.retry_cap)
                .max(self.policy.retry_base);
        }
    }

    fn try_make_lock(&self, path: &Path) -> std::io::Result<()> {
        #[cfg(test)]
        if let Some(sim) = &self.lock_sim {
            return (sim.mkdir)(path);
        }
        std::fs::create_dir(path)
    }

    fn host_reports_windows(&self) -> bool {
        #[cfg(test)]
        if let Some(sim) = &self.lock_sim {
            return sim.windows;
        }
        cfg!(windows)
    }

    /// Portless retries `EPERM` on Windows only. Rust surfaces that as `PermissionDenied`,
    /// and sometimes as raw os error 1.
    fn retry_windows_lock_error(&self, error: &std::io::Error) -> bool {
        self.host_reports_windows() && is_windows_lock_eperm(error)
    }

    fn save(&self, routes: &[Route]) -> Result<(), String> {
        self.ensure_dir()?;
        let bytes = serde_json::to_vec_pretty(routes)
            .map_err(|error| format!("The name list can't be written: {error}"))?;
        let tmp = tmp_name(&self.dir);
        {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .map_err(|error| format!("The name list can't be written: {error}"))?;
            file.write_all(&bytes)
                .and_then(|()| file.write_all(b"\n"))
                .and_then(|()| file.sync_all())
                .map_err(|error| format!("The name list can't be written: {error}"))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644));
        }
        std::fs::rename(&tmp, self.routes_path()).map_err(|error| {
            let _ = std::fs::remove_file(&tmp);
            format!("The name list can't be written: {error}")
        })
    }

    /// Every route whose owner is still alive, or whose owner is this process.
    pub fn load_routes(&self) -> Vec<Route> {
        self.load_routes_persist(false).unwrap_or_default()
    }

    fn load_routes_persist(&self, persist_cleanup: bool) -> Result<Vec<Route>, String> {
        let raw = self.load_routes_raw()?;
        let alive: Vec<Route> = raw
            .into_iter()
            .filter(|route| route.pid == 0 || process_alive(route.pid))
            .collect();
        if persist_cleanup {
            // The caller holds the lock, so this write cannot race another writer.
            let _ = self.save(&alive);
        }
        Ok(alive)
    }

    pub fn load_routes_raw(&self) -> Result<Vec<Route>, String> {
        let path = self.routes_path();
        let bytes = match std::fs::read(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(format!("The name list can't be read: {error}"));
            }
            Ok(bytes) => bytes,
        };
        if bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
            return Ok(Vec::new());
        }
        let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            // A corrupted file reads as an empty list, and the next write replaces it.
            Err(_) => return Ok(Vec::new()),
        };
        let Some(items) = parsed.as_array() else {
            return Ok(Vec::new());
        };
        Ok(items.iter().filter_map(route_from_value).collect())
    }

    /// Register a name. `force` replaces an entry whose owner is dead; it never signals a live
    /// process (portless kills it; Hivra leaves the other process alone and reports the clash).
    ///
    /// Stacks pass a stack id through [`Self::add_route_owned`]. This remains for a name that
    /// has no stack, and for the tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn add_route(
        &self,
        hostname: &str,
        port: u16,
        pid: u32,
        force: bool,
    ) -> Result<(), RouteError> {
        self.add_route_owned(hostname, port, pid, force, None)
    }

    /// Register a name for one stack. A hostname another stack id already holds is refused,
    /// even when this process owns both and `force` is set: two projects must not share a name.
    pub fn add_route_owned(
        &self,
        hostname: &str,
        port: u16,
        pid: u32,
        force: bool,
        stack_id: Option<&str>,
    ) -> Result<(), RouteError> {
        let hostname = hostname.to_ascii_lowercase();
        if !valid_hostname(&hostname) || port == 0 {
            return Err(RouteError::Refused(format!(
                "{hostname:?} is not a name this app publishes"
            )));
        }
        let stack_id = stack_id
            .map(str::trim)
            .filter(|id| valid_route_stack_id(id))
            .map(str::to_string);
        let _lock = self.acquire_lock().map_err(RouteError::Refused)?;
        let routes = self.load_routes_raw().map_err(RouteError::Refused)?;
        if let Some(existing) = routes.iter().find(|route| route.hostname == hostname) {
            // Same pid is not the same stack: this process publishes every stack's names.
            // A name a stack holds is refused to anyone who is not that stack, including a
            // caller that brings no stack id and `force`.
            if let Some(held) = existing.stack_id.as_deref() {
                if stack_id.as_deref() != Some(held) {
                    return Err(RouteError::Conflict(RouteConflict {
                        hostname,
                        existing_pid: existing.pid,
                        held_by_stack: true,
                    }));
                }
            }
            let alive = existing.pid == 0 || process_alive(existing.pid);
            // A dead owner's name is taken over with `force`; a live owner's never is. Hivra
            // leaves the other process alone rather than signalling it as portless does.
            if existing.pid != pid && alive {
                return Err(RouteError::Conflict(RouteConflict {
                    hostname,
                    existing_pid: existing.pid,
                    held_by_stack: false,
                }));
            }
            if existing.pid != pid && !force {
                return Err(RouteError::Conflict(RouteConflict {
                    hostname,
                    existing_pid: existing.pid,
                    held_by_stack: false,
                }));
            }
        }
        let mut next: Vec<Route> = routes
            .into_iter()
            .filter(|route| route.hostname != hostname)
            .collect();
        next.push(Route {
            hostname,
            port,
            pid,
            stack_id,
            registered_at: Some(now_ms()),
        });
        self.save(&next).map_err(RouteError::Refused)
    }

    /// Remove a name, but only while `owner_pid` still owns it. Passing `None` removes it
    /// unconditionally. A name a stack holds is not removed by this call: see
    /// [`Self::remove_route_owned`].
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn remove_route(&self, hostname: &str, owner_pid: Option<u32>) -> Result<(), String> {
        self.remove_route_owned(hostname, owner_pid, None)
    }

    /// Remove a name for one stack. A name another stack holds stays, even when this process
    /// added it: every stack's names are added under this app's pid, so the pid alone cannot say
    /// whose name it is. A name that records no stack is removed as before.
    pub fn remove_route_owned(
        &self,
        hostname: &str,
        owner_pid: Option<u32>,
        stack_id: Option<&str>,
    ) -> Result<(), String> {
        let hostname = hostname.to_ascii_lowercase();
        let _lock = self.acquire_lock()?;
        let routes = self.load_routes_raw()?;
        let next: Vec<Route> = routes
            .into_iter()
            .filter(|route| {
                route.hostname != hostname
                    || owner_pid.is_some_and(|pid| route.pid != pid)
                    || route
                        .stack_id
                        .as_deref()
                        .is_some_and(|held| stack_id != Some(held))
            })
            .collect();
        self.save(&next)
    }

    /// Remove every name whose owner is dead. Returns what went.
    pub fn prune_stale_routes(&self) -> Result<Vec<Route>, String> {
        let _lock = self.acquire_lock()?;
        let routes = self.load_routes_raw()?;
        let mut alive = Vec::with_capacity(routes.len());
        let mut stale = Vec::new();
        for route in routes {
            if route.pid == 0 || process_alive(route.pid) {
                alive.push(route);
            } else {
                stale.push(route);
            }
        }
        if !stale.is_empty() {
            self.save(&alive)?;
        }
        Ok(stale)
    }

    /// The route a request's `Host` names, or none. No wildcard and no default route.
    pub fn route_for_host(&self, host: &str) -> Option<Route> {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        self.load_routes()
            .into_iter()
            .find(|route| route.hostname == host)
    }

    /// A reader (another copy looking for the daily proxy's port) never sees the file empty:
    /// the new text is written beside it and moved over it. Nothing is written when the
    /// file already says this.
    pub fn write_port(&self, port: u16) -> Result<(), String> {
        if self.read_port() == Some(port) {
            return Ok(());
        }
        self.write_small(&self.port_path(), &format!("{port}\n"))
            .map_err(|error| format!("The proxy port can't be written: {error}"))
    }

    /// Write a short file so a reader sees the old text or the new text, never an empty file.
    fn write_small(&self, path: &Path, text: &str) -> Result<(), String> {
        self.ensure_dir()?;
        let tmp = tmp_name(&self.dir);
        std::fs::write(&tmp, text).map_err(|error| error.to_string())?;
        std::fs::rename(&tmp, path).map_err(|error| {
            let _ = std::fs::remove_file(&tmp);
            error.to_string()
        })
    }

    pub fn read_port(&self) -> Option<u16> {
        let text = std::fs::read_to_string(self.port_path()).ok()?;
        text.trim().parse::<u16>().ok().filter(|port| *port != 0)
    }

    pub fn write_pid(&self) -> Result<(), String> {
        self.write_small(&self.pid_path(), &format!("{}\n", std::process::id()))
            .map_err(|error| format!("The proxy pid can't be written: {error}"))
    }
}

fn route_from_value(value: &serde_json::Value) -> Option<Route> {
    let hostname = value.get("hostname")?.as_str()?.to_ascii_lowercase();
    let port = value.get("port")?.as_u64()?;
    let pid = value.get("pid")?.as_u64()?;
    if !valid_hostname(&hostname) || !(1..=u16::MAX as u64).contains(&port) {
        return None;
    }
    let stack_id = value
        .get("stackId")
        .and_then(|id| id.as_str())
        .map(str::trim)
        .filter(|id| valid_route_stack_id(id))
        .map(str::to_string);
    Some(Route {
        hostname,
        port: port as u16,
        pid: u32::try_from(pid).ok()?,
        stack_id,
        registered_at: value.get("registeredAt").and_then(|at| at.as_u64()),
    })
}

/// A stack id this app made: `s` plus lowercase hex. Anything else read from disk is ignored.
fn valid_route_stack_id(id: &str) -> bool {
    let Some(hex) = id.strip_prefix('s') else {
        return false;
    };
    (8..=64).contains(&hex.len())
        && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        && !hex.bytes().any(|byte| byte.is_ascii_uppercase())
}

fn is_windows_lock_eperm(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(1)
}

fn lock_is_stale(path: &Path, stale: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > stale)
}

struct LockGuard {
    path: PathBuf,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn tmp_name(dir: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|age| age.as_nanos())
        .unwrap_or(0);
    dir.join(format!(".routes.{}.{stamp}.{n}.tmp", std::process::id()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|age| age.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether `pid` names a process that is still running. `EPERM` counts as alive: the process
/// exists and belongs to someone else.
pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return true;
    }
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks for the process; it sends nothing.
        let rc = unsafe { libc::kill(pid, 0) };
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
        // SAFETY: the handle is closed before returning.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            false
        } else {
            unsafe { CloseHandle(handle) };
            true
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hivra-proxy-routes-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn dead_pid() -> u32 {
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        let _ = child.wait();
        pid
    }

    #[test]
    fn two_names_coexist() {
        let dir = temp_dir("coexist");
        let store = RouteStore::new(&dir);
        store
            .add_route("shop-a.localhost", 4001, std::process::id(), false)
            .unwrap();
        store
            .add_route("shop-b.localhost", 4002, std::process::id(), false)
            .unwrap();
        let routes = store.load_routes_raw().unwrap();
        assert_eq!(routes.len(), 2);
        assert_eq!(store.route_for_host("shop-a.localhost").unwrap().port, 4001);
        assert_eq!(
            store.route_for_host("SHOP-B.LOCALHOST.").unwrap().port,
            4002
        );
        assert!(store.route_for_host("shop-c.localhost").is_none());
    }

    #[test]
    fn a_removal_with_the_wrong_owner_is_refused_and_the_right_one_works() {
        let dir = temp_dir("owner");
        let store = RouteStore::new(&dir);
        store
            .add_route("shop-a.localhost", 4001, 11, false)
            .unwrap();
        store.remove_route("shop-a.localhost", Some(22)).unwrap();
        // The entry is still on disk: the wrong owner removed nothing.
        assert_eq!(store.load_routes_raw().unwrap().len(), 1);
        store.remove_route("shop-a.localhost", Some(11)).unwrap();
        assert!(store.load_routes_raw().unwrap().is_empty());
    }

    #[test]
    fn a_dead_owners_name_is_pruned_and_force_may_replace_it() {
        let dir = temp_dir("stale");
        let store = RouteStore::new(&dir);
        let gone = dead_pid();
        store
            .add_route("shop-a.localhost", 4001, gone, false)
            .unwrap();
        // A dead owner's name no longer routes.
        assert!(store.route_for_host("shop-a.localhost").is_none());
        let stale = store.prune_stale_routes().unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].pid, gone);
        // Force replaces a name a dead process left behind.
        store
            .add_route("shop-a.localhost", 4001, gone, false)
            .unwrap();
        store
            .add_route("shop-a.localhost", 4002, std::process::id(), true)
            .unwrap();
        assert_eq!(store.route_for_host("shop-a.localhost").unwrap().port, 4002);
    }

    #[test]
    fn a_live_owner_is_never_taken_over_even_with_force() {
        let dir = temp_dir("live");
        let store = RouteStore::new(&dir);
        store
            .add_route("shop-a.localhost", 4001, std::process::id(), false)
            .unwrap();
        let other = RouteError::Conflict(RouteConflict {
            hostname: "shop-a.localhost".into(),
            existing_pid: std::process::id(),
            held_by_stack: false,
        });
        assert_eq!(
            store
                .add_route("shop-a.localhost", 4002, std::process::id() + 1, true)
                .unwrap_err(),
            other
        );
        assert_eq!(store.route_for_host("shop-a.localhost").unwrap().port, 4001);
    }

    #[test]
    fn a_name_another_stack_holds_is_refused_even_with_force_and_the_same_pid() {
        let dir = temp_dir("stack-clash");
        let store = RouteStore::new(&dir);
        let pid = std::process::id();
        store
            .add_route_owned(
                "github-shop-a.localhost",
                22011,
                pid,
                true,
                Some("s01234567"),
            )
            .unwrap();
        let err = store
            .add_route_owned(
                "github-shop-a.localhost",
                22021,
                pid,
                true,
                Some("s89abcdef"),
            )
            .unwrap_err();
        assert!(matches!(err, RouteError::Conflict(_)), "{err}");
        // The sentence names the stack, not this process's own pid.
        assert!(err.to_string().contains("another stack"), "{err}");
        assert!(!err.to_string().contains(&pid.to_string()), "{err}");
        // No stack id at all is not a way past the refusal.
        let err = store
            .add_route("github-shop-a.localhost", 22022, pid, true)
            .unwrap_err();
        assert!(matches!(err, RouteError::Conflict(_)), "{err}");
        assert_eq!(
            store
                .route_for_host("github-shop-a.localhost")
                .unwrap()
                .port,
            22011
        );
        // Nor is it a way to take the name down: only the stack that holds it removes it.
        store
            .remove_route_owned("github-shop-a.localhost", Some(pid), Some("s89abcdef"))
            .unwrap();
        store
            .remove_route("github-shop-a.localhost", Some(pid))
            .unwrap();
        assert_eq!(
            store
                .route_for_host("github-shop-a.localhost")
                .unwrap()
                .port,
            22011
        );
        // The stack that holds the name may restate it.
        store
            .add_route_owned(
                "github-shop-a.localhost",
                22012,
                pid,
                true,
                Some("s01234567"),
            )
            .unwrap();
        assert_eq!(
            store
                .route_for_host("github-shop-a.localhost")
                .unwrap()
                .port,
            22012
        );
        store
            .remove_route_owned("github-shop-a.localhost", Some(pid), Some("s01234567"))
            .unwrap();
        assert!(store.route_for_host("github-shop-a.localhost").is_none());
        // A stack id read from disk that is not one this app makes is not an identity.
        let raw =
            r#"[{"hostname":"github-shop-a.localhost","port":22012,"pid":1,"stackId":"../x"}]"#;
        std::fs::write(store.routes_path(), raw).unwrap();
        let loaded = store.load_routes_raw().unwrap();
        assert_eq!(loaded[0].stack_id, None, "{loaded:?}");
    }

    #[test]
    fn a_lock_held_past_the_stale_threshold_is_taken_over() {
        let dir = temp_dir("lock");
        let store = RouteStore::with_policy(
            &dir,
            LockPolicy {
                stale: Duration::from_millis(20),
                timeout: Duration::from_secs(2),
                retry_base: Duration::from_millis(5),
                retry_cap: Duration::from_millis(20),
            },
        );
        store.ensure_dir().unwrap();
        std::fs::create_dir(store.lock_path()).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        store
            .add_route("shop-a.localhost", 4001, std::process::id(), false)
            .unwrap();
        assert!(store.route_for_host("shop-a.localhost").is_some());
        assert!(!store.lock_path().exists());
    }

    #[test]
    fn two_writers_never_lose_an_update() {
        let dir = temp_dir("writers");
        let store = RouteStore::new(&dir);
        let mut hands = Vec::new();
        for writer in 0..2 {
            let store = store.clone();
            hands.push(std::thread::spawn(move || {
                for item in 0..25 {
                    let name = format!("shop-{writer}-{item}.localhost");
                    store
                        .add_route(&name, 5000, std::process::id(), false)
                        .unwrap();
                }
            }));
        }
        for hand in hands {
            hand.join().unwrap();
        }
        assert_eq!(store.load_routes_raw().unwrap().len(), 50);
    }

    #[test]
    fn a_name_that_is_not_a_hostname_or_a_corrupt_file_is_refused_safely() {
        let dir = temp_dir("bad");
        let store = RouteStore::new(&dir);
        for bad in ["a b.localhost", "café.localhost", "../x.localhost", ""] {
            assert!(store.add_route(bad, 4001, 1, false).is_err(), "{bad:?}");
        }
        std::fs::write(store.routes_path(), b"{not json").unwrap();
        assert!(store.load_routes_raw().unwrap().is_empty());
        assert!(store.route_for_host("shop-a.localhost").is_none());
    }

    fn short_lock() -> LockPolicy {
        LockPolicy {
            stale: Duration::from_secs(10),
            timeout: Duration::from_secs(2),
            retry_base: Duration::from_millis(20),
            retry_cap: Duration::from_millis(40),
        }
    }

    #[test]
    fn a_windows_eperm_on_the_lock_is_retried_and_then_the_name_is_saved() {
        let sample = std::io::Error::from_raw_os_error(1);
        assert!(
            sample.kind() == std::io::ErrorKind::PermissionDenied
                || sample.raw_os_error() == Some(1),
            "raw os error 1 is not a Windows EPERM stand-in here: {sample:?}"
        );
        let dir = temp_dir("win-eperm");
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&attempts);
        let store = RouteStore::with_policy(&dir, short_lock()).with_lock_sim(true, move |path| {
            let n = seen.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                Err(std::io::Error::from_raw_os_error(1))
            } else {
                std::fs::create_dir(path)
            }
        });
        let started = std::time::Instant::now();
        store
            .add_route("shop-a.localhost", 4001, std::process::id(), false)
            .unwrap();
        assert!(
            started.elapsed() >= Duration::from_millis(15),
            "EPERM did not wait out the lock backoff"
        );
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "EPERM was not retried once"
        );
        assert_eq!(store.route_for_host("shop-a.localhost").unwrap().port, 4001);
        assert!(!store.lock_path().exists());
    }

    #[test]
    fn a_unix_eperm_on_the_lock_fails_without_a_retry() {
        let dir = temp_dir("unix-eperm");
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&attempts);
        let store =
            RouteStore::with_policy(&dir, short_lock()).with_lock_sim(false, move |_path| {
                seen.fetch_add(1, Ordering::SeqCst);
                Err(std::io::Error::from_raw_os_error(1))
            });
        let error = store
            .add_route("shop-a.localhost", 4001, std::process::id(), false)
            .unwrap_err();
        assert_eq!(attempts.load(Ordering::SeqCst), 1, "unix EPERM was retried");
        assert!(error.to_string().contains("nothing changed"), "{error}");
        assert!(store.route_for_host("shop-a.localhost").is_none());
    }

    #[test]
    fn a_windows_lock_error_that_is_not_eperm_fails_at_once() {
        let dir = temp_dir("win-other");
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&attempts);
        let store = RouteStore::with_policy(&dir, short_lock()).with_lock_sim(true, move |_path| {
            seen.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "missing parent",
            ))
        });
        let error = store
            .add_route("shop-a.localhost", 4001, std::process::id(), false)
            .unwrap_err();
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "a non-EPERM error was retried"
        );
        assert!(error.to_string().contains("nothing changed"), "{error}");
        assert!(store.route_for_host("shop-a.localhost").is_none());
    }
}
