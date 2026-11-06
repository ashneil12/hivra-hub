// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/portless packages/portless/src/routes.ts (Apache-2.0).
// Copyright 2025 Vercel Inc.
// Translated to Rust for Hivra WP-90, with its tests: the mkdir lock, owner-only removal,
// stale-owner pruning and the registry file. TLS, tunnel metadata and hosts-file sync are out.

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registered_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteConflict {
    pub hostname: String,
    pub existing_pid: u32,
}

impl std::fmt::Display for RouteConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
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

#[derive(Clone, Debug)]
pub struct RouteStore {
    dir: PathBuf,
    policy: LockPolicy,
}

impl RouteStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            policy: LockPolicy::default(),
        }
    }

    /// Tests only: shorten the waits. Production always uses [`RouteStore::new`].
    #[cfg(test)]
    pub fn with_policy(dir: impl Into<PathBuf>, policy: LockPolicy) -> Self {
        Self {
            dir: dir.into(),
            policy,
        }
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
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(LockGuard { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_is_stale(&path, self.policy.stale) {
                        let _ = std::fs::remove_dir_all(&path);
                        continue;
                    }
                }
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
    pub fn add_route(
        &self,
        hostname: &str,
        port: u16,
        pid: u32,
        force: bool,
    ) -> Result<(), RouteError> {
        let hostname = hostname.to_ascii_lowercase();
        if !valid_hostname(&hostname) || port == 0 {
            return Err(RouteError::Refused(format!(
                "{hostname:?} is not a name this app publishes"
            )));
        }
        let _lock = self.acquire_lock().map_err(RouteError::Refused)?;
        let routes = self.load_routes_raw().map_err(RouteError::Refused)?;
        if let Some(existing) = routes.iter().find(|route| route.hostname == hostname) {
            let alive = existing.pid == 0 || process_alive(existing.pid);
            // A dead owner's name is taken over with `force`; a live owner's never is. Hivra
            // leaves the other process alone rather than signalling it as portless does.
            if existing.pid != pid && alive {
                return Err(RouteError::Conflict(RouteConflict {
                    hostname,
                    existing_pid: existing.pid,
                }));
            }
            if existing.pid != pid && !force {
                return Err(RouteError::Conflict(RouteConflict {
                    hostname,
                    existing_pid: existing.pid,
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
            registered_at: Some(now_ms()),
        });
        self.save(&next).map_err(RouteError::Refused)
    }

    /// Remove a name, but only while `owner_pid` still owns it. Passing `None` removes it
    /// unconditionally; the stack code always passes the pid that added it.
    pub fn remove_route(&self, hostname: &str, owner_pid: Option<u32>) -> Result<(), String> {
        let hostname = hostname.to_ascii_lowercase();
        let _lock = self.acquire_lock()?;
        let routes = self.load_routes_raw()?;
        let next: Vec<Route> = routes
            .into_iter()
            .filter(|route| {
                route.hostname != hostname || owner_pid.is_some_and(|pid| route.pid != pid)
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

    pub fn write_port(&self, port: u16) -> Result<(), String> {
        self.ensure_dir()?;
        std::fs::write(self.port_path(), format!("{port}\n"))
            .map_err(|error| format!("The proxy port can't be written: {error}"))
    }

    pub fn read_port(&self) -> Option<u16> {
        let text = std::fs::read_to_string(self.port_path()).ok()?;
        text.trim().parse::<u16>().ok().filter(|port| *port != 0)
    }

    pub fn write_pid(&self) -> Result<(), String> {
        self.ensure_dir()?;
        std::fs::write(self.pid_path(), format!("{}\n", std::process::id()))
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
    Some(Route {
        hostname,
        port: port as u16,
        pid: u32::try_from(pid).ok()?,
        registered_at: value.get("registeredAt").and_then(|at| at.as_u64()),
    })
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
}
