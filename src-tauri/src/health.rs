//! WP-104: machine facts for the Settings health list.
//!
//! The sentences live in the webview. This only reports what the machine did: git through the app's
//! existing git command, free space, a read-only `PRAGMA quick_check` (once per launch), whether the data folder can be
//! written, whether the plugins folder can be read, the last backup the app recorded, and one tiny
//! request when a local model is configured. A timeout is reported as a timeout, not as a failure.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::portable::scrubber;

const GATEWAY_TIMEOUT: Duration = Duration::from_secs(5);
const GATEWAY_URL_MAX: usize = 2_000;
static PROBE_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFact {
    pub state: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayFact {
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthFacts {
    pub git: GitFact,
    pub disk_free_bytes: Option<u64>,
    pub database: String,
    pub data_writable: bool,
    pub plugins: String,
    pub last_backup_at: Option<i64>,
    pub gateway: Option<GatewayFact>,
}

pub(crate) trait Port {
    fn git(&self) -> GitFact;
    fn free_bytes(&self, path: &Path) -> Option<u64>;
    fn probe(&self, url: &str, timeout: Duration) -> GatewayFact;
}

struct RealPort;

impl Port for RealPort {
    fn git(&self) -> GitFact {
        read_git()
    }

    fn free_bytes(&self, path: &Path) -> Option<u64> {
        free_bytes(path)
    }

    fn probe(&self, url: &str, timeout: Duration) -> GatewayFact {
        probe_url(url, timeout)
    }
}

#[tauri::command]
pub async fn health_facts(
    app: AppHandle,
    gateway_url: Option<String>,
) -> Result<HealthFacts, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Couldn't check this Mac just now.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        collect(&data, gateway_url.as_deref(), GATEWAY_TIMEOUT, &RealPort)
    })
    .await
    .map_err(|_| "Couldn't check this Mac just now.".to_string())
}

pub(crate) fn collect(
    data_dir: &Path,
    gateway_url: Option<&str>,
    timeout: Duration,
    port: &dyn Port,
) -> HealthFacts {
    HealthFacts {
        git: sanitize_git(port.git()),
        disk_free_bytes: port.free_bytes(data_dir),
        database: database_state(&data_dir.join("monocode.db")).to_string(),
        data_writable: data_writable(data_dir),
        plugins: plugins_state(&data_dir.join("plugins")).to_string(),
        last_backup_at: crate::backups::last_good_at(data_dir),
        gateway: gateway_fact(gateway_url, timeout, port),
    }
}

fn gateway_fact(
    gateway_url: Option<&str>,
    timeout: Duration,
    port: &dyn Port,
) -> Option<GatewayFact> {
    let raw = gateway_url.map(str::trim).filter(|url| !url.is_empty())?;
    Some(match accept_gateway(raw) {
        Some(url) => port.probe(&url, timeout),
        None => GatewayFact {
            state: "refused".into(),
        },
    })
}

/// http or https, with a host and no password in the address. Anything else is refused and not requested.
fn accept_gateway(raw: &str) -> Option<String> {
    if raw.len() > GATEWAY_URL_MAX {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    let scheme = url.scheme() == "http" || url.scheme() == "https";
    let host = url.host_str().is_some_and(|host| !host.is_empty());
    let bare = url.username().is_empty() && url.password().is_none();
    (scheme && host && bare).then(|| url.to_string())
}

fn sanitize_git(fact: GitFact) -> GitFact {
    match fact.state.as_str() {
        "missing" => GitFact {
            state: "missing".into(),
            version: None,
        },
        "ok" => GitFact {
            state: "ok".into(),
            version: fact.version.as_deref().and_then(clean_version),
        },
        _ => GitFact {
            state: "unread".into(),
            version: None,
        },
    }
}

fn clean_version(raw: &str) -> Option<String> {
    let line = raw.lines().next()?.trim();
    if line.is_empty() || line.chars().count() > 80 || line.chars().any(char::is_control) {
        return None;
    }
    let (_, secrets) = scrubber().redact_text(line);
    (secrets == 0).then(|| line.to_string())
}

fn read_git() -> GitFact {
    let output = match crate::fs::git_cmd().arg("--version").output() {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return GitFact {
                state: "missing".into(),
                version: None,
            };
        }
        Err(_) => {
            return GitFact {
                state: "unread".into(),
                version: None,
            }
        }
    };
    if !output.status.success() {
        return GitFact {
            state: "unread".into(),
            version: None,
        };
    }
    GitFact {
        state: "ok".into(),
        version: Some(String::from_utf8_lossy(&output.stdout).into_owned()),
    }
}

// Only the unix free-space reader calls this; Windows keeps it for the shared test.
#[cfg_attr(not(unix), allow(dead_code))]
fn blocks_to_bytes(avail: u64, frsize: u64) -> Option<u64> {
    avail.checked_mul(frsize)
}

#[cfg(unix)]
fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let mut bytes = path.as_os_str().as_bytes().to_vec();
    if bytes.contains(&0) {
        return None;
    }
    bytes.push(0);
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let rc = unsafe { libc::statvfs(bytes.as_ptr().cast(), stat.as_mut_ptr()) };
    if rc != 0 {
        return None;
    }
    let stat = unsafe { stat.assume_init() };
    let avail = count_to_u64(stat.f_bavail)?;
    let frsize = count_to_u64(stat.f_frsize)?;
    blocks_to_bytes(avail, frsize)
}

#[cfg(unix)]
fn count_to_u64(value: impl TryInto<u64>) -> Option<u64> {
    value.try_into().ok()
}

#[cfg(windows)]
fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut free = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free)
}

fn database_state(path: &Path) -> &'static str {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => "ok",
        Err(_) => "unread",
        Ok(meta) if meta.file_type().is_symlink() => "unread",
        Ok(meta) if !meta.is_file() => "problem",
        Ok(_) => quick_checks().state(path, quick_check),
    }
}

/// `PRAGMA quick_check` reads the whole file, and Settings asks for the health list on every open and every refresh.
/// It runs once per launch for a file. Only an answer is kept ("ok" or "problem"): a check that couldn't be read
/// (busy, locked, a moment's I/O error) is not final and is tried again next time. The lock is held while it runs,
/// so two windows opening Settings together still run it once.
struct QuickChecks {
    seen: Mutex<HashMap<PathBuf, &'static str>>,
}

impl QuickChecks {
    fn new() -> Self {
        Self {
            seen: Mutex::new(HashMap::new()),
        }
    }

    fn state(&self, path: &Path, run: impl FnOnce(&Path) -> &'static str) -> &'static str {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&state) = seen.get(path) {
            return state;
        }
        let state = run(path);
        if matches!(state, "ok" | "problem") {
            seen.insert(path.to_path_buf(), state);
        }
        state
    }
}

fn quick_checks() -> &'static QuickChecks {
    static CHECKS: OnceLock<QuickChecks> = OnceLock::new();
    CHECKS.get_or_init(QuickChecks::new)
}

fn quick_check(path: &Path) -> &'static str {
    let flags =
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = match rusqlite::Connection::open_with_flags(path, flags) {
        Ok(conn) => conn,
        Err(_) => return "unread",
    };
    let _ = conn.busy_timeout(Duration::from_millis(200));
    match conn.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0)) {
        Ok(value) if value == "ok" => "ok",
        Ok(_) => "problem",
        Err(rusqlite::Error::QueryReturnedMoreThanOneRow) => "problem",
        Err(_) => "unread",
    }
}

fn data_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(probe_name());
    let created = OpenOptions::new().write(true).create_new(true).open(&probe);
    if created.is_err() {
        return false;
    }
    drop(created);
    let _ = remove_inside(dir, &probe);
    true
}

fn probe_name() -> String {
    let seq = PROBE_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!(".health-probe-{}-{seq}-{nanos}", std::process::id())
}

fn remove_inside(root: &Path, path: &Path) -> io::Result<()> {
    let root = crate::fs::canonical(root)?;
    let target = crate::fs::canonical(path)?;
    if target == root || !target.starts_with(&root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "outside the data folder",
        ));
    }
    fs::remove_file(target)
}

fn plugins_state(dir: &Path) -> &'static str {
    match fs::symlink_metadata(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => "missing",
        Err(_) => "unreadable",
        Ok(meta) if meta.file_type().is_symlink() => "unreadable",
        Ok(meta) if !meta.is_dir() => "unreadable",
        Ok(_) => match fs::read_dir(dir) {
            Ok(_) => "readable",
            Err(_) => "unreadable",
        },
    }
}

fn probe_url(url: &str, timeout: Duration) -> GatewayFact {
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .redirects(0)
        .build();
    let state = match agent.get(url).call() {
        Ok(response) => {
            discard(response);
            "answered"
        }
        Err(ureq::Error::Status(_, response)) => {
            discard(response);
            "answered"
        }
        Err(error) if is_timeout(&error) => "timedOut",
        Err(_) => "down",
    };
    GatewayFact {
        state: state.to_string(),
    }
}

fn discard(response: ureq::Response) {
    let mut buf = [0u8; 1];
    let _ = response.into_reader().take(1).read(&mut buf);
}

fn is_timeout(err: &ureq::Error) -> bool {
    if err.kind() != ureq::ErrorKind::Io {
        return false;
    }
    let mut source = std::error::Error::source(err);
    while let Some(current) = source {
        if let Some(io_error) = current.downcast_ref::<io::Error>() {
            return matches!(
                io_error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ) || io_error
                .to_string()
                .to_ascii_lowercase()
                .contains("timeout");
        }
        if current.to_string().to_ascii_lowercase().contains("timeout") {
            return true;
        }
        source = std::error::Error::source(current);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        git: GitFact,
        free: Option<u64>,
        probe_state: String,
        probes: Mutex<Vec<String>>,
    }

    impl Port for Fake {
        fn git(&self) -> GitFact {
            self.git.clone()
        }

        fn free_bytes(&self, _path: &Path) -> Option<u64> {
            self.free
        }

        fn probe(&self, url: &str, _timeout: Duration) -> GatewayFact {
            self.probes
                .lock()
                .expect("probe lock")
                .push(url.to_string());
            GatewayFact {
                state: self.probe_state.clone(),
            }
        }
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivra-health-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        let Ok(root) = crate::fs::canonical(dir) else {
            return;
        };
        let Ok(parent) = crate::fs::canonical(std::env::temp_dir()) else {
            return;
        };
        if root.starts_with(&parent) && root != parent {
            let _ = fs::remove_dir_all(root);
        }
    }

    fn fake(git: GitFact) -> Fake {
        Fake {
            git,
            free: Some(3 * 1024 * 1024 * 1024),
            probe_state: "answered".into(),
            probes: Mutex::new(Vec::new()),
        }
    }

    #[test]
    fn blocks_overflow_is_not_a_number() {
        assert_eq!(blocks_to_bytes(4, 512), Some(2048));
        assert_eq!(blocks_to_bytes(u64::MAX, 2), None);
        assert_eq!(blocks_to_bytes(0, 4096), Some(0));
    }

    #[test]
    fn a_secret_in_the_version_is_dropped() {
        let dir = temp();
        let port = fake(GitFact {
            state: "ok".into(),
            version: Some("sk-ant-api03-abcdefghijklmnopqrstuvwxyz".into()),
        });
        let facts = collect(&dir, None, Duration::from_millis(1), &port);
        assert_eq!(facts.git.state, "ok");
        assert_eq!(facts.git.version, None);
        let json = serde_json::to_string(&facts).unwrap();
        assert!(!json.contains("sk-ant"));
        cleanup(&dir);
    }

    #[test]
    fn a_control_character_or_a_long_line_is_dropped() {
        let dir = temp();
        let noisy = fake(GitFact {
            state: "ok".into(),
            version: Some("git version 2\u{0007}".into()),
        });
        assert_eq!(
            collect(&dir, None, Duration::from_millis(1), &noisy)
                .git
                .version,
            None
        );
        let long = fake(GitFact {
            state: "ok".into(),
            version: Some(format!("git version {}", "1".repeat(80))),
        });
        assert_eq!(
            collect(&dir, None, Duration::from_millis(1), &long)
                .git
                .version,
            None
        );
        let blank = fake(GitFact {
            state: "ok".into(),
            version: Some("  \nmore".into()),
        });
        assert_eq!(
            collect(&dir, None, Duration::from_millis(1), &blank)
                .git
                .version,
            None
        );
        cleanup(&dir);
    }

    #[test]
    fn an_odd_git_state_is_unread() {
        let dir = temp();
        let port = fake(GitFact {
            state: "yes".into(),
            version: Some("git version 1".into()),
        });
        let facts = collect(&dir, None, Duration::from_millis(1), &port);
        assert_eq!(facts.git.state, "unread");
        assert_eq!(facts.git.version, None);
        cleanup(&dir);
    }

    #[test]
    fn no_address_means_no_request() {
        let dir = temp();
        let port = fake(GitFact {
            state: "missing".into(),
            version: None,
        });
        let facts = collect(&dir, None, Duration::from_millis(1), &port);
        assert!(facts.gateway.is_none());
        assert!(port.probes.lock().unwrap().is_empty());
        let blank = collect(&dir, Some("   "), Duration::from_millis(1), &port);
        assert!(blank.gateway.is_none());
        assert!(port.probes.lock().unwrap().is_empty());
        cleanup(&dir);
    }

    #[test]
    fn a_bad_address_is_refused_without_a_request() {
        let dir = temp();
        let port = fake(GitFact {
            state: "missing".into(),
            version: None,
        });
        for raw in [
            "file:///etc/passwd",
            "http://user:secret@127.0.0.1/",
            "http://user@127.0.0.1/",
            "javascript:alert(1)",
            "http://",
            "http:///",
            "not a url",
            &"http://127.0.0.1/".repeat(400),
        ] {
            let facts = collect(&dir, Some(raw), Duration::from_millis(1), &port);
            assert_eq!(facts.gateway.unwrap().state, "refused", "{raw}");
        }
        assert!(port.probes.lock().unwrap().is_empty());
        cleanup(&dir);
    }

    #[test]
    fn a_local_address_is_probed_and_not_returned() {
        let dir = temp();
        let port = fake(GitFact {
            state: "ok".into(),
            version: Some("git version 2.1\nextra".into()),
        });
        let facts = collect(
            &dir,
            Some("http://127.0.0.1:9/secret-token-value"),
            Duration::from_millis(1),
            &port,
        );
        assert_eq!(facts.gateway.as_ref().unwrap().state, "answered");
        assert_eq!(facts.git.version.as_deref(), Some("git version 2.1"));
        let seen = port.probes.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].contains("secret-token-value"));
        let json = serde_json::to_string(&facts).unwrap();
        assert!(!json.contains("secret-token-value"));
        cleanup(&dir);
    }

    #[test]
    fn an_ipv6_address_is_allowed() {
        let dir = temp();
        let port = fake(GitFact {
            state: "missing".into(),
            version: None,
        });
        let facts = collect(
            &dir,
            Some("http://[::1]:9/"),
            Duration::from_millis(1),
            &port,
        );
        assert_eq!(facts.gateway.unwrap().state, "answered");
        assert_eq!(port.probes.lock().unwrap().len(), 1);
        cleanup(&dir);
    }

    #[test]
    fn the_data_folder_probe_is_removed_and_a_sibling_stays() {
        let dir = temp().join("héllo 日本語");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.txt"), "keep").unwrap();
        assert!(data_writable(&dir));
        assert_eq!(fs::read_to_string(dir.join("notes.txt")).unwrap(), "keep");
        let left = fs::read_dir(&dir).unwrap().any(|entry| {
            entry.ok().is_some_and(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".health-probe")
            })
        });
        assert!(!left);
        cleanup(dir.parent().unwrap());
    }

    #[test]
    fn two_checks_at_once_leave_no_probe_behind() {
        let dir = temp();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let dir = dir.clone();
                scope.spawn(move || assert!(data_writable(&dir)));
            }
        });
        let left = fs::read_dir(&dir).unwrap().any(|entry| {
            entry.ok().is_some_and(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".health-probe")
            })
        });
        assert!(!left);
        cleanup(&dir);
    }

    #[test]
    fn a_missing_data_folder_is_not_writable_and_is_not_created() {
        let dir = temp().join("absent");
        assert!(!data_writable(&dir));
        assert!(!dir.exists());
        cleanup(dir.parent().unwrap());
    }

    #[test]
    fn deleting_escapes_the_folder_is_refused() {
        let root = temp();
        let outside = temp();
        let file = outside.join("keep.txt");
        fs::write(&file, "safe").unwrap();
        let error = remove_inside(&root, &file).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read_to_string(&file).unwrap(), "safe");
        cleanup(&root);
        cleanup(&outside);
    }

    #[test]
    fn plugins_missing_readable_and_a_file() {
        let dir = temp();
        assert_eq!(plugins_state(&dir.join("plugins")), "missing");
        let plugins = dir.join("plugins");
        fs::create_dir(&plugins).unwrap();
        assert_eq!(plugins_state(&plugins), "readable");
        let file = dir.join("not-a-folder");
        fs::write(&file, "x").unwrap();
        assert_eq!(plugins_state(&file), "unreadable");
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_plugins_symlink_is_not_followed() {
        let dir = temp();
        let outside = dir.join("outside");
        fs::create_dir(&outside).unwrap();
        let plugins = dir.join("plugins");
        std::os::unix::fs::symlink(&outside, &plugins).unwrap();
        assert_eq!(plugins_state(&plugins), "unreadable");
        cleanup(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_plugins_symlink_is_not_followed() {
        let dir = temp();
        let outside = dir.join("outside");
        fs::create_dir(&outside).unwrap();
        let plugins = dir.join("plugins");
        if std::os::windows::fs::symlink_dir(&outside, &plugins).is_ok() {
            assert_eq!(plugins_state(&plugins), "unreadable");
        }
        cleanup(&dir);
    }

    #[test]
    fn a_missing_database_is_fine_and_a_real_one_checks_out() {
        let dir = temp();
        assert_eq!(database_state(&dir.join("monocode.db")), "ok");
        let db = dir.join("monocode.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER);").unwrap();
        drop(conn);
        assert_eq!(database_state(&db), "ok");
        cleanup(&dir);
    }

    #[test]
    fn the_database_is_checked_once_per_launch_however_often_settings_opens() {
        let dir = temp();
        let db = dir.join("monocode.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER);").unwrap();
        drop(conn);
        let checks = QuickChecks::new();
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let run = |path: &Path| {
            runs.fetch_add(1, Ordering::SeqCst);
            quick_check(path)
        };
        for _ in 0..5 {
            assert_eq!(checks.state(&db, run), "ok");
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        // Another file is its own check.
        let other = dir.join("other.db");
        rusqlite::Connection::open(&other).unwrap();
        assert_eq!(checks.state(&other, run), "ok");
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        cleanup(&dir);
    }

    #[test]
    fn a_problem_is_remembered_for_the_launch_too() {
        let checks = QuickChecks::new();
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let run = |_: &Path| {
            runs.fetch_add(1, Ordering::SeqCst);
            "problem"
        };
        let path = Path::new("monocode.db");
        assert_eq!(checks.state(path, run), "problem");
        assert_eq!(checks.state(path, run), "problem");
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_check_that_could_not_be_read_is_not_final_and_runs_again() {
        let checks = QuickChecks::new();
        let answers = Mutex::new(vec!["ok", "unread", "unread"]);
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let run = |_: &Path| {
            runs.fetch_add(1, Ordering::SeqCst);
            answers.lock().unwrap().pop().unwrap()
        };
        let path = Path::new("monocode.db");
        assert_eq!(checks.state(path, run), "unread");
        assert_eq!(checks.state(path, run), "unread");
        assert_eq!(checks.state(path, run), "ok");
        assert_eq!(checks.state(path, run), "ok");
        assert_eq!(runs.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn two_windows_opening_settings_together_check_once() {
        let checks = QuickChecks::new();
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let run = |_: &Path| {
            runs.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(60));
            "ok"
        };
        std::thread::scope(|scope| {
            for _ in 0..6 {
                scope.spawn(|| assert_eq!(checks.state(Path::new("monocode.db"), run), "ok"));
            }
        });
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn collect_asks_the_launch_check_not_the_file_every_time() {
        let dir = temp();
        let db = dir.join("monocode.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER);").unwrap();
        drop(conn);
        let port = fake(GitFact {
            state: "missing".into(),
            version: None,
        });
        assert_eq!(
            collect(&dir, None, Duration::from_millis(1), &port).database,
            "ok"
        );
        // Damage the file after the first look. The same launch does not read it again.
        fs::write(&db, "this is not a database any more").unwrap();
        assert_eq!(
            collect(&dir, None, Duration::from_millis(1), &port).database,
            "ok"
        );
        cleanup(&dir);
    }

    #[test]
    fn a_database_that_is_not_a_file_is_a_problem_and_garbage_is_not_ok() {
        let dir = temp();
        let folder = dir.join("monocode.db");
        fs::create_dir(&folder).unwrap();
        assert_eq!(database_state(&folder), "problem");
        let junk = dir.join("junk.db");
        fs::write(&junk, "this is not a database").unwrap();
        assert_ne!(database_state(&junk), "ok");
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_database_symlink_is_not_followed() {
        let dir = temp();
        let real = dir.join("real.db");
        let conn = rusqlite::Connection::open(&real).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER);").unwrap();
        drop(conn);
        let link = dir.join("monocode.db");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(database_state(&link), "unread");
        cleanup(&dir);
    }

    #[test]
    fn the_last_backup_time_is_read_and_a_bad_file_is_none() {
        let dir = temp();
        assert_eq!(crate::backups::last_good_at(&dir), None);
        fs::write(
            dir.join("backup-state.json"),
            b"{\r\n  \"last_good\": {\r\n    \"id\": \"/Users/ada/secret\",\r\n    \"createdAt\": 50\r\n  }\r\n}",
        )
        .unwrap();
        assert_eq!(crate::backups::last_good_at(&dir), Some(50));
        let facts = collect(
            &dir,
            None,
            Duration::from_millis(1),
            &fake(GitFact {
                state: "missing".into(),
                version: None,
            }),
        );
        assert_eq!(facts.last_backup_at, Some(50));
        assert!(!serde_json::to_string(&facts)
            .unwrap()
            .contains("/Users/ada"));
        for raw in [
            "",
            "{",
            "[]",
            r#"{"last_good":{"id":"a","createdAt":0}}"#,
            r#"{"last_good":{"id":"a","createdAt":-5}}"#,
        ] {
            fs::write(dir.join("backup-state.json"), raw).unwrap();
            assert_eq!(crate::backups::last_good_at(&dir), None, "{raw}");
        }
        fs::write(dir.join("notes.txt"), "keep").unwrap();
        assert_eq!(crate::backups::last_good_at(&dir), None);
        assert_eq!(fs::read_to_string(dir.join("notes.txt")).unwrap(), "keep");
        cleanup(&dir);
    }

    #[test]
    fn a_closed_port_is_down_and_a_silent_port_times_out() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let refused = listener.local_addr().unwrap();
        drop(listener);
        let down = probe_url(&format!("http://{refused}/"), Duration::from_secs(2));
        assert_eq!(down.state, "down");

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let held = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                match listener.accept() {
                    Ok((sock, _)) => {
                        std::thread::sleep(Duration::from_millis(1500));
                        drop(sock);
                        return;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() > deadline {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        });
        let slow = probe_url(&format!("http://{held}/"), Duration::from_millis(300));
        assert_eq!(slow.state, "timedOut");
        server.join().unwrap();
    }

    #[test]
    fn free_space_of_a_real_folder_is_a_number() {
        let dir = temp();
        let free = free_bytes(&dir).expect("stat");
        assert!(free > 0);
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_plugins_folder_is_not_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp();
        let plugins = dir.join("plugins");
        fs::create_dir(&plugins).unwrap();
        let mut locked = fs::metadata(&plugins).unwrap().permissions();
        locked.set_mode(0o0);
        fs::set_permissions(&plugins, locked).unwrap();
        let state = plugins_state(&plugins);
        let mut open = fs::metadata(&plugins).unwrap().permissions();
        open.set_mode(0o700);
        fs::set_permissions(&plugins, open).unwrap();
        if fs::read_dir(&plugins).is_err() {
            assert_eq!(state, "unreadable");
        }
        cleanup(&dir);
    }
}
