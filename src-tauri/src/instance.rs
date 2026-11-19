//! Which copy of MonoCode Hub this process is, and one app per data folder (Phase 1b, WP1:
//! `docs/PHASE-1B-DEV-SETUP.md`).
//!
//! **The kind of copy comes from the bundle identifier compiled into it** (`tauri.conf.json` plus any `--config`
//! overlay, so it can't be changed after the build):
//!
//! | identifier                        | kind  | data folder (`~/Library/Application Support/…`) |
//! |-----------------------------------|-------|-------------------------------------------------|
//! | `com.ash.monocode-hub`            | daily | `com.ash.monocode-hub`: Ash's real chats         |
//! | `com.ash.monocode-hub.dev.<slot>` | dev   | `com.ash.monocode-hub.dev.<slot>`                |
//!
//! A slot is 1 to 48 lowercase letters, digits and dashes, not starting or ending with a dash.
//!
//! **Checked at the top of `run()`, before any plugin or data access** (each refusal shows an alert and exits):
//! 1. any other identifier refuses to start (exit 78);
//! 2. a debug build with the daily identifier refuses: "use npm run hub:dev" (exit 78);
//! 3. the daily app runs only from `~/Applications/MonoCode Hub.app`; a daily build anywhere else says "ship it"
//!    (macOS, exit 78).
//!
//! **One app per data folder.** The copy then holds an exclusive SQLite transaction on `<data>/instance-owner.sqlite`
//! for its whole life, taken without a busy wait and retried for 2 s. The OS releases it even after a hard kill, and
//! the file is never deleted. `running.json` beside it names the owner. A second copy shows an alert naming that
//! owner and exits 75. A database written by a newer build is refused with exit 65 (`session_store.rs`).
//!
//! **What a dev copy can't do** ([`Policy`]): import from the live Ash OS (`ash_os_import.rs`: only from a stand-in,
//! never the live service or its key), use the daily Keychain names (`hub_keychain.rs`: `monocode-hub-dev:*`
//! only), give Claude Ash's MCP servers, hooks or `~/.claude` (`harness.rs`: one shared
//! `~/.monocode-hub-dev/claude-config`), or run the orphan reaper, phone access, habits, automations, reminders,
//! auto-resume, the notification prompt or the quick composer's system-wide shortcut.
//!
//! The build stamp (`build.rs`) is embedded as one `MONOCODE-STAMP:{…}` string, so scripts read it from any bundle
//! without launching it. `monocode version --json` and the `app.version` action return it too.
//!
//! Set `MONOCODE_NO_ALERT=1` to get a refusal on stderr only (scripts, tests); the exit code is the same.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, ErrorCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DAILY_IDENTIFIER: &str = "com.ash.monocode-hub";
pub const DEV_IDENTIFIER_PREFIX: &str = "com.ash.monocode-hub.dev.";
/// The daily app's only home, under the home folder.
pub const DAILY_BUNDLE: &str = "Applications/MonoCode Hub.app";
/// Every dev copy shares this Claude Code config folder, under the home folder: one Claude login covers every slot,
/// and a dev copy never resumes Ash's real transcripts in `~/.claude`.
pub const DEV_CLAUDE_CONFIG: &str = ".monocode-hub-dev/claude-config";
/// The lock file in the data folder. Never deleted.
pub const LOCK_FILE: &str = "instance-owner.sqlite";
/// Who holds the lock, beside it.
pub const RUNNING_FILE: &str = "running.json";

/// Another copy owns this data folder (`EX_TEMPFAIL`).
pub const EXIT_IN_USE: i32 = 75;
/// The wrong copy: an unknown identifier, a debug build with the daily identity, or the daily app outside
/// `~/Applications` (`EX_CONFIG`).
pub const EXIT_WRONG_COPY: i32 = 78;
/// The database was written by a newer build (`EX_DATAERR`).
pub const EXIT_NEWER_DATA: i32 = 65;
/// The data folder or its lock file couldn't be opened (`EX_CANTCREAT`).
pub const EXIT_NO_LOCK: i32 = 73;

const LOCK_WAIT: Duration = Duration::from_secs(2);
const LOCK_RETRY: Duration = Duration::from_millis(100);
const STAMP_PREFIX: &str = "MONOCODE-STAMP:";

/// `MONOCODE-STAMP:{"sha","branch","dirty","builtAt"}` from build.rs, kept in the binary as one string.
#[used]
static STAMP_LINE: &str = concat!("MONOCODE-STAMP:", env!("MONOCODE_BUILD_STAMP"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Daily,
    Dev,
}

/// What a copy may do. The daily app may do everything; a dev copy nothing on this list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// The one-time import may read the live Ash OS with its real key (`ash_os_import.rs`). A dev copy imports only
    /// from a stand-in.
    pub live_ash_os: bool,
    /// Keychain items under their own names. A dev copy uses `monocode-hub-dev:*` only.
    pub daily_keychain: bool,
    /// Claude with `~/.claude`, MCP servers and hooks. A dev copy uses the shared dev config with both stripped.
    pub daily_claude: bool,
    pub reap_orphans: bool,
    /// v0.16 phone access: port 38416 and UPnP on the router.
    pub phone_access: bool,
    pub habits: bool,
    /// Scheduled and event runs. A manual "Run now" is the user's own action and stays.
    pub automations: bool,
    pub reminders: bool,
    /// Continue chats a quit or crash cut off.
    pub auto_resume: bool,
    pub notification_prompt: bool,
    /// The quick composer's system-wide shortcut. Only one app can hold it, and the daily app keeps it.
    pub global_shortcut: bool,
    /// The background sweep that deletes the build output of finished worktrees (`worktree_autoclean.rs`). It acts on
    /// the real ~/Worktrees, so only the daily app runs it.
    pub clear_build_output: bool,
}

impl Policy {
    /// A copy under a temporary HOME (a test, a ship drill) keeps to that folder. Its data, Claude config and Ash OS
    /// key all come from HOME already; these are the things that don't, so they go: Keychain items (the login keychain
    /// is the user's, whatever HOME says), the orphan reaper (it would see the real app's agents), phone access, the
    /// notification prompt and the system-wide shortcut.
    pub fn in_isolated_home(self) -> Self {
        Self {
            daily_keychain: false,
            reap_orphans: false,
            phone_access: false,
            notification_prompt: false,
            global_shortcut: false,
            ..self
        }
    }
}

impl Kind {
    pub fn policy(self) -> Policy {
        let daily = self == Kind::Daily;
        Policy {
            live_ash_os: daily,
            daily_keychain: daily,
            daily_claude: daily,
            reap_orphans: daily,
            phone_access: daily,
            habits: daily,
            automations: daily,
            reminders: daily,
            auto_resume: daily,
            notification_prompt: daily,
            global_shortcut: daily,
            clear_build_output: daily,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Identity {
    pub kind: Kind,
    pub identifier: String,
    pub slot: Option<String>,
}

impl Identity {
    /// The kind table. Anything that isn't the daily identifier or a well-formed dev slot is refused.
    pub fn classify(identifier: &str) -> Result<Self, Refusal> {
        if identifier == DAILY_IDENTIFIER {
            return Ok(Self {
                kind: Kind::Daily,
                identifier: identifier.into(),
                slot: None,
            });
        }
        match identifier.strip_prefix(DEV_IDENTIFIER_PREFIX) {
            Some(slot) if valid_slot(slot) => Ok(Self {
                kind: Kind::Dev,
                identifier: identifier.into(),
                slot: Some(slot.into()),
            }),
            _ => Err(Refusal::UnknownIdentity {
                identifier: identifier.into(),
            }),
        }
    }

    pub fn policy(&self) -> Policy {
        self.kind.policy()
    }
}

fn valid_slot(slot: &str) -> bool {
    (1..=48).contains(&slot.len())
        && !slot.starts_with('-')
        && !slot.ends_with('-')
        && slot
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

static CURRENT: OnceLock<Identity> = OnceLock::new();

/// This process's identity. `run()` sets it before anything else. Elsewhere (unit tests, the CLI subcommands) it is
/// worked out from the same compiled identifier, so every path agrees; an identifier that isn't known gets a dev
/// copy's policy, with everything off.
pub fn current() -> &'static Identity {
    CURRENT.get_or_init(|| {
        let identifier = crate::context().config().identifier.clone();
        Identity::classify(&identifier).unwrap_or(Identity {
            kind: Kind::Dev,
            identifier,
            slot: None,
        })
    })
}

pub fn kind() -> Kind {
    current().kind
}

/// What this copy may do: its kind's policy, minus everything system-wide when it runs under a temporary HOME
/// ([`isolated_home`]).
pub fn policy() -> Policy {
    effective_policy(current())
}

pub fn effective_policy(identity: &Identity) -> Policy {
    let mut policy = identity.policy();
    if isolated_home().is_some() {
        policy = policy.in_isolated_home();
    }
    // The fake-Claude test bench's dev copy resumes cut turns like the daily app, so a restart midway is exercised
    // (src/verify_live.rs: only a dev copy under a temporary HOME has a plan).
    if identity.kind == Kind::Dev && crate::verify_live::plan().is_some_and(|plan| plan.auto_resume)
    {
        policy.auto_resume = true;
    }
    policy
}

/// Rules 1 and 2, first thing in `run()`. Shows an alert and exits when this copy must not start.
pub fn startup(identifier: &str) -> Identity {
    let identity = Identity::classify(identifier).unwrap_or_else(|refusal| refuse(&refusal));
    if let Err(refusal) = check_build(&identity, cfg!(debug_assertions)) {
        refuse(&refusal);
    }
    let _ = CURRENT.set(identity.clone());
    identity
}

/// Rule 2: a debug build never runs as the daily app.
pub fn check_build(identity: &Identity, debug: bool) -> Result<(), Refusal> {
    if debug && identity.kind == Kind::Daily {
        Err(Refusal::DebugDaily)
    } else {
        Ok(())
    }
}

/// Fix round 3 (H4): a subcommand that reads the Keychain (`secret-run`, `connector-run`) runs only from where the daily
/// app runs, the rule `run()` applies. `Some(why)` refuses it; a dev copy passes as it does in `run()`.
pub fn keychain_location_refusal(
    identity: &Identity,
    debug: bool,
    exe: &Path,
    home: &Path,
) -> Option<String> {
    check_location(identity, debug, exe, home)
        .err()
        .map(|refusal| refusal.detail())
}

/// The same check for this process, before a Keychain-reading subcommand reads anything.
pub fn keychain_subcommand_refusal() -> Option<String> {
    let Some(home) = real_home() else {
        return Some("There is no home folder.".into());
    };
    let exe = std::env::current_exe().ok()?;
    keychain_location_refusal(current(), cfg!(debug_assertions), &exe, &home)
}

/// Rule 3: the daily app runs only from `~/Applications/MonoCode Hub.app`.
pub fn check_location(
    identity: &Identity,
    debug: bool,
    exe: &Path,
    home: &Path,
) -> Result<(), Refusal> {
    if identity.kind != Kind::Daily || debug {
        return Ok(());
    }
    let expected = home.join(DAILY_BUNDLE);
    let running_from = bundle_of(exe).unwrap_or_else(|| exe.to_path_buf());
    match (running_from.canonicalize(), expected.canonicalize()) {
        (Ok(running), Ok(daily)) if running == daily => Ok(()),
        _ => Err(Refusal::DailyOutsideApplications {
            running_from,
            expected,
        }),
    }
}

/// `<name>.app/Contents/MacOS/<binary>` is inside `<name>.app`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension()? == "app")
        .then(|| app.to_path_buf())
}

/// Tauri's rule for the data folder (`app_data_dir()`), worked out before the app exists.
pub fn data_dir(identifier: &str) -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join(identifier))
}

static LOCK: OnceLock<Mutex<InstanceLock>> = OnceLock::new();

/// The data folder this copy uses, and whether it holds the folder's lock.
pub struct Claim {
    pub data_dir: PathBuf,
    /// False only on Windows, where a second launch first hands off to the running copy (see [`claim`]).
    pub owner: bool,
}

/// This binary's path with symlinks and `.` resolved, so `./monocode` or a linked folder still names its bundle.
fn this_exe() -> PathBuf {
    std::env::current_exe()
        .map(|exe| exe.canonicalize().unwrap_or(exe))
        .unwrap_or_default()
}

/// Rule 3, then the data folder: take the lock, then record this process in `running.json`. Shows an alert and exits
/// when this copy must not run or another copy owns the folder.
///
/// On Windows a busy lock is tried once, without waiting: tauri-plugin-single-instance, registered first in `run()`,
/// reopens the running copy's window and exits this process before setup. If setup is reached anyway, it waits for
/// the lock there ([`claim_after_handoff`]).
pub fn claim(identity: &Identity, version: &str) -> Claim {
    let exe = this_exe();
    if cfg!(target_os = "macos") {
        let home = dirs::home_dir().unwrap_or_default();
        if let Err(refusal) = check_location(identity, cfg!(debug_assertions), &exe, &home) {
            refuse(&refusal);
        }
    }
    let Some(data) = data_dir(&identity.identifier) else {
        refuse(&Refusal::NoLock {
            data_dir: PathBuf::from(&identity.identifier),
            error: "there is no home folder".into(),
        });
    };
    let wait = if cfg!(windows) {
        Duration::ZERO
    } else {
        LOCK_WAIT
    };
    match take(identity, version, &exe, &data, wait) {
        Ok(()) => Claim {
            data_dir: data,
            owner: true,
        },
        Err(LockError::Busy) if cfg!(windows) => Claim {
            data_dir: data,
            owner: false,
        },
        Err(error) => refuse(&lock_refusal(error, data)),
    }
}

/// Windows, in setup: no running copy took over this launch, so wait for the lock like any other platform.
pub fn claim_after_handoff(identity: &Identity, version: &str, data: &Path) {
    if let Err(error) = take(identity, version, &this_exe(), data, LOCK_WAIT) {
        refuse(&lock_refusal(error, data.to_path_buf()));
    }
}

fn lock_refusal(error: LockError, data: PathBuf) -> Refusal {
    match error {
        LockError::Busy => Refusal::InUse {
            owner: read_running(&data),
            data_dir: data,
        },
        LockError::Failed(error) => Refusal::NoLock {
            data_dir: data,
            error,
        },
    }
}

/// Take the lock, record this process beside it and keep the lock for the rest of the process.
fn take(
    identity: &Identity,
    version: &str,
    exe: &Path,
    data: &Path,
    wait: Duration,
) -> Result<(), LockError> {
    let lock = InstanceLock::acquire(data, wait)?;
    let record = RunningRecord::for_this_process(identity, version, exe);
    if let Err(error) = write_running(data, &record) {
        eprintln!("monocode: couldn't write {RUNNING_FILE}: {error}");
    }
    if let Err(unused) = LOCK.set(Mutex::new(lock)) {
        // Never released early, even if this ran twice.
        std::mem::forget(unused);
    }
    Ok(())
}

/// The app's own file commands refuse the lock file. Closing any handle to a file drops this process's POSIX locks
/// on it, and SQLite's lock is one, so opening, copying or replacing the file from inside the app would let a second
/// copy in. Deleting or renaming it would do the same from any process. A link to it is refused too: the name asked
/// for and the file it resolves to are both checked.
pub fn guard_lock_file(path: &Path) -> Result<(), String> {
    let named_lock = |path: &Path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == LOCK_FILE || name == format!("{LOCK_FILE}-journal"))
    };
    let is_lock =
        named_lock(path) || std::fs::canonicalize(path).is_ok_and(|real| named_lock(&real));
    if is_lock {
        Err(format!(
            "{} is MonoCode Hub's instance lock. The app won't open, copy, move or remove it.",
            path.display()
        ))
    } else {
        Ok(())
    }
}

/// A dev copy's whole process (its sessions, its terminals and every file lookup) uses the shared dev Claude config.
/// Called from `run()` before any thread starts.
pub fn apply_dev_environment(identity: &Identity) -> Result<(), String> {
    let Some(dir) = dev_claude_config_dir_in(identity.kind, home())? else {
        return Ok(());
    };
    std::env::set_var("CLAUDE_CONFIG_DIR", &dir);
    std::env::set_var("CLAUDE_SECURESTORAGE_CONFIG_DIR", &dir);
    // A bench's children write under the isolated home, not the shared temp dirs.
    crate::verify_live::install_run_tmpdir();
    Ok(())
}

/// A dev copy's Claude Code config folder (created on first use); `None` in the daily app.
pub fn dev_claude_config_dir() -> Result<Option<PathBuf>, String> {
    dev_claude_config_dir_in(kind(), home())
}

fn home() -> Option<PathBuf> {
    crate::dirs_home().map(PathBuf::from)
}

fn dev_claude_config_dir_in(kind: Kind, home: Option<PathBuf>) -> Result<Option<PathBuf>, String> {
    if kind != Kind::Dev {
        return Ok(None);
    }
    let dir = home
        .ok_or("There is no home folder for the dev Claude config.")?
        .join(DEV_CLAUDE_CONFIG);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Couldn't create {}: {error}", dir.display()))?;
    Ok(Some(dir))
}

// ---- a temporary HOME ------------------------------------------------------------------------------------------------

static ISOLATED_HOME: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The temporary HOME this process runs under when HOME isn't the user's own home folder (a test, a ship drill), or
/// `None` for a normal launch.
pub fn isolated_home() -> Option<&'static Path> {
    ISOLATED_HOME
        .get_or_init(|| {
            detect_isolated_home(std::env::var_os("HOME").map(PathBuf::from), real_home())
        })
        .as_deref()
}

fn detect_isolated_home(home: Option<PathBuf>, real: Option<PathBuf>) -> Option<PathBuf> {
    let home = home.filter(|home| !home.as_os_str().is_empty())?;
    let real = real?;
    let same = match (home.canonicalize(), real.canonicalize()) {
        (Ok(home), Ok(real)) => home == real,
        _ => home == real,
    };
    (!same).then_some(home)
}

/// The user's home folder from the user database: what Cocoa uses, whatever HOME says.
#[cfg(unix)]
pub fn real_home() -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let mut record: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut record,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() || record.pw_dir.is_null() {
        return None;
    }
    let dir = unsafe { std::ffi::CStr::from_ptr(record.pw_dir) };
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())))
}

/// The user's profile folder from Windows itself (the Profile known folder), whatever HOME or USERPROFILE say.
#[cfg(not(unix))]
pub fn real_home() -> Option<PathBuf> {
    dirs::home_dir().filter(|home| home.is_absolute())
}

/// First thing in `run()`. Cocoa ignores HOME: the webview's storage, caches, saved window state and preferences live
/// under the home folder from the user database. A copy under a temporary HOME would put them in the real home,
/// beside the daily app's own (same identifier), so `CFFIXED_USER_HOME` points Cocoa at HOME as well. The copy
/// refuses to start (exit 78) if Cocoa still names another folder.
pub fn isolate_home() {
    let Some(home) = isolated_home() else {
        return;
    };
    std::env::set_var("CFFIXED_USER_HOME", home);
    #[cfg(target_os = "macos")]
    {
        let cocoa = PathBuf::from(objc2_foundation::NSHomeDirectory().to_string());
        if cocoa.canonicalize().ok() != home.canonicalize().ok() {
            refuse(&Refusal::HomeNotIsolated {
                home: home.to_path_buf(),
                cocoa,
            });
        }
    }
}

// ---- the lock --------------------------------------------------------------------------------------------------------

/// An exclusive SQLite transaction on `<data>/instance-owner.sqlite`, held while this value lives (for the app: the
/// whole process). SQLite's own file locks make a second holder, in this process or another, busy.
pub struct InstanceLock {
    _conn: Connection,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LockError {
    Busy,
    Failed(String),
}

impl InstanceLock {
    /// Take the lock, retrying a busy one every 100 ms until `wait` has passed. Never a SQLite busy wait.
    pub fn acquire(dir: &Path, wait: Duration) -> Result<Self, LockError> {
        std::fs::create_dir_all(dir).map_err(|e| LockError::Failed(e.to_string()))?;
        Self::acquire_file(&dir.join(LOCK_FILE), wait)
    }

    /// The same lock on any file: Ship's `runner.lock` uses it too (`ship.rs`, `scripts/hub-ship-runner.mjs`).
    pub fn acquire_file(path: &Path, wait: Duration) -> Result<Self, LockError> {
        let failed = |error: &dyn std::fmt::Display| LockError::Failed(error.to_string());
        let conn = Connection::open(path).map_err(|e| failed(&e))?;
        conn.busy_timeout(Duration::ZERO).map_err(|e| failed(&e))?;
        let deadline = Instant::now() + wait;
        loop {
            match conn.execute_batch("BEGIN EXCLUSIVE") {
                Ok(()) => return Ok(Self { _conn: conn }),
                Err(error) if is_busy(&error) => {
                    if Instant::now() >= deadline {
                        return Err(LockError::Busy);
                    }
                    std::thread::sleep(LOCK_RETRY);
                }
                Err(error) => return Err(failed(&error)),
            }
        }
    }
}

fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

/// `running.json`: the process that holds the lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningRecord {
    pub pid: u32,
    /// When the process started, in ms since 1970. On macOS it comes from the kernel, so pid and start time together
    /// name exactly one process.
    pub start_time: u64,
    pub kind: Kind,
    pub identifier: String,
    pub slot: Option<String>,
    pub version: String,
    pub sha: String,
    pub branch: String,
    pub dirty: bool,
    pub bundle_path: String,
}

impl RunningRecord {
    fn for_this_process(identity: &Identity, version: &str, exe: &Path) -> Self {
        let pid = std::process::id();
        let stamp = stamp();
        Self {
            pid,
            start_time: process_start_ms(pid).unwrap_or_else(now_ms),
            kind: identity.kind,
            identifier: identity.identifier.clone(),
            slot: identity.slot.clone(),
            version: version.into(),
            sha: stamp.sha,
            branch: stamp.branch,
            dirty: stamp.dirty,
            bundle_path: bundle_of(exe)
                .unwrap_or_else(|| exe.to_path_buf())
                .to_string_lossy()
                .into_owned(),
        }
    }
}

/// Written next to the lock, atomically.
pub fn write_running(dir: &Path, record: &RunningRecord) -> std::io::Result<()> {
    let temporary = dir.join(format!(".{RUNNING_FILE}.{}", std::process::id()));
    std::fs::write(&temporary, serde_json::to_vec_pretty(record)?)?;
    std::fs::rename(&temporary, dir.join(RUNNING_FILE))
}

/// Whatever the owner wrote, read loosely: another build may write more or fewer fields.
pub fn read_running(dir: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(dir.join(RUNNING_FILE)).ok()?).ok()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
pub(crate) fn process_start_ms(pid: u32) -> Option<u64> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (read == size).then(|| info.pbi_start_tvsec * 1000 + info.pbi_start_tvusec / 1000)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn process_start_ms(_pid: u32) -> Option<u64> {
    None
}

// ---- refusals --------------------------------------------------------------------------------------------------------

/// Why this copy won't run. Each one is an alert and an exit code.
#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    UnknownIdentity {
        identifier: String,
    },
    DebugDaily,
    DailyOutsideApplications {
        running_from: PathBuf,
        expected: PathBuf,
    },
    InUse {
        data_dir: PathBuf,
        owner: Option<Value>,
    },
    NoLock {
        data_dir: PathBuf,
        error: String,
    },
    NewerDatabase {
        data_dir: PathBuf,
        found: i64,
        supported: i64,
    },
    /// A dev copy that can't set up its own Claude folder would fall back to `~/.claude`.
    DevSetup {
        error: String,
    },
    /// Under a temporary HOME, Cocoa still names the real home: the webview would share the daily app's storage.
    HomeNotIsolated {
        home: PathBuf,
        cocoa: PathBuf,
    },
}

impl Refusal {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::UnknownIdentity { .. }
            | Self::DebugDaily
            | Self::DailyOutsideApplications { .. }
            | Self::HomeNotIsolated { .. } => EXIT_WRONG_COPY,
            Self::InUse { .. } => EXIT_IN_USE,
            Self::NoLock { .. } | Self::DevSetup { .. } => EXIT_NO_LOCK,
            Self::NewerDatabase { .. } => EXIT_NEWER_DATA,
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            Self::UnknownIdentity { .. } => "This copy of MonoCode Hub has no known identity",
            Self::DebugDaily => "Use npm run hub:dev",
            Self::DailyOutsideApplications { .. } => "Ship this build instead of opening it here",
            Self::InUse { .. } => "MonoCode Hub is already open",
            Self::NoLock { .. } => "MonoCode Hub couldn't claim its data folder",
            Self::NewerDatabase { .. } => "This build is older than its data",
            Self::DevSetup { .. } => "This dev copy couldn't set up its own Claude folder",
            Self::HomeNotIsolated { .. } => "This copy couldn't keep to its temporary home folder",
        }
    }

    pub fn detail(&self) -> String {
        match self {
            Self::UnknownIdentity { identifier } => format!(
                "It was built with the identifier \"{identifier}\", which is neither the daily app \
                 ({DAILY_IDENTIFIER}) nor a dev copy ({DEV_IDENTIFIER_PREFIX}<slot>). Build the daily app with \
                 npm run hub:build, or run a dev copy with npm run hub:dev."
            ),
            Self::DebugDaily => format!(
                "This is a debug build with the daily identity ({DAILY_IDENTIFIER}), so it would open Ash's real \
                 chats. npm run hub:dev runs a dev copy instead, with its own data folder."
            ),
            Self::DailyOutsideApplications {
                running_from,
                expected,
            } => format!(
                "This build carries the daily identity ({DAILY_IDENTIFIER}) but is running from {}. The daily app \
                 only runs from {}. Ship it there (npm run hub:ship) instead of opening it here.",
                running_from.display(),
                expected.display()
            ),
            Self::InUse { data_dir, owner } => format!(
                "{} owns the data folder {}. Only one copy may use a data folder at a time: switch to that one, \
                 or quit it first.",
                owner
                    .as_ref()
                    .map(describe_owner)
                    .unwrap_or_else(|| "Another copy of MonoCode Hub".into()),
                data_dir.display()
            ),
            Self::NoLock { data_dir, error } => format!(
                "Couldn't take the lock in {}: {error}.",
                data_dir.display()
            ),
            Self::NewerDatabase {
                data_dir,
                found,
                supported,
            } => format!(
                "The database in {} was written by a newer build (schema {found}; this build knows up to \
                 {supported}). Open the newer app instead: this one would misread it.",
                data_dir.display()
            ),
            Self::DevSetup { error } => format!(
                "{error}. A dev copy doesn't run without it: its Claude sessions, terminals and file lookups would \
                 use ~/.claude instead."
            ),
            Self::HomeNotIsolated { home, cocoa } => format!(
                "HOME is {}, but macOS still names {} as the home folder, so the window's storage, caches and \
                 preferences would be shared with the app that lives there. Start it with CFFIXED_USER_HOME set to \
                 HOME as well.",
                home.display(),
                cocoa.display()
            ),
        }
    }
}

/// "The daily app (pid 812, hub/next @ 09141d8, from /Users/ash/Applications/MonoCode Hub.app)".
pub fn describe_owner(owner: &Value) -> String {
    let text = |key: &str| owner.get(key).and_then(Value::as_str).unwrap_or("");
    let who = match text("kind") {
        "daily" => "The daily app".to_string(),
        "dev" => match owner.get("slot").and_then(Value::as_str) {
            Some(slot) => format!("Dev copy {slot}"),
            None => "A dev copy".into(),
        },
        _ => "Another copy of MonoCode Hub".into(),
    };
    let mut facts = Vec::new();
    if let Some(pid) = owner.get("pid").and_then(Value::as_u64) {
        facts.push(format!("pid {pid}"));
    }
    if !text("sha").is_empty() {
        let dirty = owner.get("dirty").and_then(Value::as_bool) == Some(true);
        facts.push(format!(
            "{} @ {}{}",
            text("branch"),
            short_sha(text("sha")),
            if dirty { "-dirty" } else { "" }
        ));
    }
    if !text("bundlePath").is_empty() {
        facts.push(format!("from {}", text("bundlePath")));
    }
    if facts.is_empty() {
        who
    } else {
        format!("{who} ({})", facts.join(", "))
    }
}

/// Explain, show an alert (unless `MONOCODE_NO_ALERT` is set), and exit with the refusal's code.
pub fn refuse(refusal: &Refusal) -> ! {
    eprintln!("monocode: {}. {}", refusal.title(), refusal.detail());
    if std::env::var_os("MONOCODE_NO_ALERT").is_none() {
        alert(refusal.title(), &refusal.detail());
    }
    std::process::exit(refusal.exit_code());
}

#[cfg(target_os = "macos")]
fn alert(title: &str, detail: &str) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertStyle, NSApplication, NSApplicationActivationPolicy};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Critical);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(detail));
    alert.addButtonWithTitle(&NSString::from_str("OK"));
    alert.runModal();
}

#[cfg(not(target_os = "macos"))]
fn alert(_title: &str, _detail: &str) {}

// ---- the build stamp -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub sha: String,
    pub branch: String,
    pub dirty: bool,
    pub built_at: String,
}

/// `MONOCODE-STAMP:{…}` to a stamp.
pub fn parse_stamp(line: &str) -> Option<Stamp> {
    serde_json::from_str(line.strip_prefix(STAMP_PREFIX)?).ok()
}

/// This binary's stamp.
pub fn stamp() -> Stamp {
    parse_stamp(STAMP_LINE).unwrap_or_else(|| Stamp {
        sha: "unknown".into(),
        branch: "unknown".into(),
        dirty: true,
        built_at: String::new(),
    })
}

pub fn short_sha(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// "hub/1b-identity @ 09141d8", with "-dirty" when the build had uncommitted changes.
pub fn stamp_label(stamp: &Stamp) -> String {
    format!(
        "{} @ {}{}",
        stamp.branch,
        short_sha(&stamp.sha),
        if stamp.dirty { "-dirty" } else { "" }
    )
}

/// A dev copy's window title: "Hivra Dev - <branch> @ <sha>".
pub fn dev_window_title(stamp: &Stamp) -> String {
    format!(
        "{} Dev - {}",
        crate::display_name::DISPLAY_NAME,
        stamp_label(stamp)
    )
}

/// What the webview, `monocode version --json` and the `app.version` action report.
pub fn app_info(identity: &Identity, product: &str, version: &str) -> Value {
    json!({
        "product": product,
        "version": version,
        "identifier": identity.identifier,
        "kind": identity.kind,
        "slot": identity.slot,
        "stamp": stamp(),
        "schemaVersion": crate::session_store::SCHEMA_VERSION,
        "policy": effective_policy(identity),
        "isolatedHome": isolated_home(),
        "verify": crate::verify_live::plan().map(crate::verify_live::window_info),
    })
}

/// Hands `app_info` to every window as `window.__MONOCODE_APP__` before the page's own scripts run.
pub fn plugin<R: tauri::Runtime>(info: &Value) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("instance")
        .js_init_script(init_script(info))
        .build()
}

fn init_script(info: &Value) -> String {
    format!("window.__MONOCODE_APP__ = Object.freeze({info});")
}

// ---- monocode version / monocode healthcheck -------------------------------------------------------------------------

/// The product name, version and identity compiled into this binary.
fn compiled() -> (Identity, Option<Identity>, String, String) {
    let context = crate::context();
    let identifier = context.config().identifier.clone();
    let known = Identity::classify(&identifier).ok();
    let identity = known.clone().unwrap_or(Identity {
        kind: Kind::Dev,
        identifier,
        slot: None,
    });
    let product = context
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "MonoCode Hub".into());
    (
        identity,
        known,
        product,
        context.package_info().version.to_string(),
    )
}

/// `monocode version [--json]`: this binary's identity and build stamp. No window, no data access.
pub fn version_main(args: &[String]) -> i32 {
    let (identity, known, product, version) = compiled();
    let mut info = app_info(&identity, &product, &version);
    if known.is_none() {
        info["kind"] = json!("unknown");
    }
    if args.iter().any(|arg| arg == "--json") {
        println!("{info}");
    } else {
        let stamp = stamp();
        let kind = match (&known, &identity.slot) {
            (None, _) => "unknown identity".to_string(),
            (Some(_), Some(slot)) => format!("dev copy {slot}"),
            (Some(_), None) => "daily".to_string(),
        };
        println!(
            "{product} {version} ({kind}, {}) {}, built {}",
            identity.identifier,
            stamp_label(&stamp),
            stamp.built_at
        );
    }
    0
}

/// `monocode healthcheck [--json] [--db PATH] [--keep]`: copy the live database (opened read-only, copied with
/// VACUUM INTO), migrate the copy as this build would, check it, then delete the copy. No window.
///
/// Exit 0 when the copy migrates and checks clean (or there is no database yet), 65 when the database is newer than
/// this build, 1 on any other failure, 2 on bad arguments.
pub fn healthcheck_main(args: &[String]) -> i32 {
    let mut db: Option<PathBuf> = None;
    let mut keep = false;
    let mut json_out = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--db" => match iter.next() {
                Some(path) => db = Some(PathBuf::from(path)),
                None => return usage("--db needs a path"),
            },
            "--keep" => keep = true,
            "--json" => json_out = true,
            other => return usage(&format!("unknown argument {other}")),
        }
    }
    let (identity, _, _, _) = compiled();
    let Some(live) = db.or_else(|| data_dir(&identity.identifier).map(|d| d.join("monocode.db")))
    else {
        return usage("no home folder; pass --db");
    };
    let (code, report) = healthcheck(&live, keep);
    if json_out {
        println!("{report}");
    } else if code == 0 {
        println!("healthcheck ok: {report}");
    } else {
        eprintln!("healthcheck failed: {report}");
    }
    code
}

fn usage(error: &str) -> i32 {
    eprintln!(
        "monocode healthcheck: {error}\nusage: monocode healthcheck [--json] [--db PATH] [--keep]"
    );
    2
}

/// The app's own database health, for the harness care loop (`monos/model/harnessCare.ts`, board H1/H3): copy the live
/// database with VACUUM INTO, migrate the copy as this build would and check it, exactly as `monocode healthcheck`
/// does — the live file is only ever read. It never alerts or exits: the report is the answer, and a failure is
/// something care tells Ash about.
#[tauri::command]
pub async fn db_health() -> Value {
    tauri::async_runtime::spawn_blocking(|| {
        let (identity, _, _, _) = compiled();
        let Some(live) = data_dir(&identity.identifier).map(|dir| dir.join("monocode.db")) else {
            return json!({ "ok": false, "error": "no home folder" });
        };
        let (code, report) = healthcheck(&live, false);
        json!({ "ok": code == 0, "code": code, "report": report })
    })
    .await
    .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() }))
}

fn healthcheck(live: &Path, keep: bool) -> (i32, Value) {
    use crate::session_store::{self, OpenError};

    let database = live.to_string_lossy().into_owned();
    if !live.exists() {
        return (
            0,
            json!({ "ok": true, "database": database, "exists": false }),
        );
    }
    let dir = std::env::temp_dir().join(format!(
        "monocode-healthcheck-{}-{}",
        std::process::id(),
        now_ms()
    ));
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return (
            1,
            json!({ "ok": false, "database": database, "error": error.to_string() }),
        );
    }
    let copy = dir.join("monocode.db");
    let result = session_store::healthcheck(live, &copy);
    if !keep {
        let _ = std::fs::remove_dir_all(&dir);
    }
    let copy_field = keep.then(|| copy.to_string_lossy().into_owned());
    match result {
        Ok(report) => {
            let ok = report.integrity == "ok";
            let mut value = json!({ "ok": ok, "database": database });
            if let (Value::Object(map), Ok(Value::Object(fields))) =
                (&mut value, serde_json::to_value(&report))
            {
                map.extend(fields);
            }
            if let Some(copy) = copy_field {
                value["copy"] = json!(copy);
            }
            (if ok { 0 } else { 1 }, value)
        }
        Err(OpenError::Newer(newer)) => (
            EXIT_NEWER_DATA,
            json!({
                "ok": false,
                "database": database,
                "refused": "newer-schema",
                "schemaFound": newer.found,
                "buildSchema": newer.supported,
            }),
        ),
        Err(OpenError::Other(error)) => (
            1,
            json!({ "ok": false, "database": database, "error": error }),
        ),
    }
}

#[cfg(test)]
pub(crate) fn find_stamp(bytes: &[u8]) -> Option<Stamp> {
    let marker = b"MONOCODE-STAMP:{";
    let mut from = 0;
    while let Some(at) = bytes[from..]
        .windows(marker.len())
        .position(|window| window == marker)
    {
        let start = from + at + STAMP_PREFIX.len();
        for end in start..bytes.len().min(start + 4096) {
            if bytes[end] == b'}' {
                if let Ok(stamp) = serde_json::from_slice::<Stamp>(&bytes[start..=end]) {
                    return Some(stamp);
                }
            }
        }
        from = start;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("monocode-instance-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn dev(slot: &str) -> String {
        format!("{DEV_IDENTIFIER_PREFIX}{slot}")
    }

    #[test]
    fn the_kind_comes_from_the_identifier_and_anything_else_is_refused() {
        let daily = Identity::classify("com.ash.monocode-hub").unwrap();
        assert_eq!((daily.kind, daily.slot), (Kind::Daily, None));

        for slot in [
            "hub-1b-identity",
            "monocode-hub-next",
            "a",
            "x9",
            "wt-a1b2",
            &"a".repeat(48),
        ] {
            let copy = Identity::classify(&dev(slot)).unwrap();
            assert_eq!(copy.kind, Kind::Dev, "{slot}");
            assert_eq!(copy.slot.as_deref(), Some(slot));
        }

        for refused in [
            String::new(),
            "com.monocode.desktop".into(),
            "com.ash.monocode-hub.sandbox".into(),
            "com.ash.monocode-hub.dev".into(),
            "com.ash.monocode-hub.devx".into(),
            " com.ash.monocode-hub".into(),
            "com.ash.monocode-hub ".into(),
            "COM.ASH.MONOCODE-HUB".into(),
            "com.ash.monocode-hub-proof".into(),
            dev(""),
            dev("Upper"),
            dev("a.b"),
            dev("a_b"),
            dev("a/b"),
            dev("-a"),
            dev("a-"),
            dev(&"a".repeat(49)),
        ] {
            let refusal = Identity::classify(&refused).unwrap_err();
            assert!(
                matches!(refusal, Refusal::UnknownIdentity { .. }),
                "{refused:?}"
            );
            assert_eq!(refusal.exit_code(), EXIT_WRONG_COPY);
        }
    }

    #[test]
    fn a_dev_copy_has_every_switch_off_and_the_daily_app_every_switch_on() {
        let daily = serde_json::to_value(Kind::Daily.policy()).unwrap();
        let dev = serde_json::to_value(Kind::Dev.policy()).unwrap();
        let (daily, dev) = (daily.as_object().unwrap(), dev.as_object().unwrap());
        assert!(dev.len() >= 10);
        for (name, value) in dev {
            assert_eq!(value, &json!(false), "a dev copy must not have {name}");
            assert_eq!(daily[name], json!(true), "the daily app keeps {name}");
        }
    }

    #[test]
    fn a_debug_build_never_runs_as_the_daily_app() {
        let daily = Identity::classify(DAILY_IDENTIFIER).unwrap();
        let copy = Identity::classify(&dev("wt")).unwrap();
        let refusal = check_build(&daily, true).unwrap_err();
        assert_eq!(refusal, Refusal::DebugDaily);
        assert_eq!(refusal.exit_code(), EXIT_WRONG_COPY);
        assert!(refusal.title().contains("npm run hub:dev"));
        assert!(check_build(&daily, false).is_ok());
        assert!(check_build(&copy, true).is_ok());
        assert!(check_build(&copy, false).is_ok());
    }

    #[test]
    fn the_daily_app_runs_only_from_applications() {
        let home = TempDir::new("home");
        let daily_exe = home.0.join(DAILY_BUNDLE).join("Contents/MacOS/monocode");
        let built_exe = home.0.join(
            "Worktrees/wt/target/release/bundle/macos/MonoCode Hub.app/Contents/MacOS/monocode",
        );
        for exe in [&daily_exe, &built_exe] {
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            std::fs::write(exe, b"binary").unwrap();
        }
        let daily = Identity::classify(DAILY_IDENTIFIER).unwrap();
        let copy = Identity::classify(&dev("wt")).unwrap();

        assert!(check_location(&daily, false, &daily_exe, &home.0).is_ok());
        let refusal = check_location(&daily, false, &built_exe, &home.0).unwrap_err();
        assert_eq!(refusal.exit_code(), EXIT_WRONG_COPY);
        assert!(
            refusal.detail().contains("Ship it there"),
            "{}",
            refusal.detail()
        );
        assert!(refusal.detail().contains("target/release"));
        // A bare binary is not a bundle at all.
        let bare = home.0.join("monocode");
        std::fs::write(&bare, b"binary").unwrap();
        assert!(check_location(&daily, false, &bare, &home.0).is_err());
        // Reached through a symlink, the installed app is still the installed app.
        #[cfg(unix)]
        {
            let link = home.0.join("link.app");
            std::os::unix::fs::symlink(home.0.join(DAILY_BUNDLE), &link).unwrap();
            assert!(check_location(
                &daily,
                false,
                &link.join("Contents/MacOS/monocode"),
                &home.0
            )
            .is_ok());
        }
        // A dev copy runs from anywhere; a debug daily build was already refused by rule 2.
        assert!(check_location(&copy, false, &built_exe, &home.0).is_ok());
        assert!(check_location(&daily, true, &built_exe, &home.0).is_ok());
    }

    #[test]
    fn bundle_of_finds_the_app_around_its_binary() {
        assert_eq!(
            bundle_of(Path::new("/A/MonoCode Hub.app/Contents/MacOS/monocode")),
            Some(PathBuf::from("/A/MonoCode Hub.app"))
        );
        assert_eq!(bundle_of(Path::new("/A/target/debug/monocode")), None);
        assert_eq!(bundle_of(Path::new("/A/x/Contents/MacOS/monocode")), None);
    }

    #[test]
    fn a_second_lock_is_busy_and_free_again_once_the_first_is_dropped() {
        let data = TempDir::new("lock");
        let first = InstanceLock::acquire(&data.0, Duration::ZERO).expect("first lock");
        assert!(data.0.join(LOCK_FILE).is_file());

        let started = Instant::now();
        let second = InstanceLock::acquire(&data.0, Duration::from_millis(300));
        assert_eq!(second.err(), Some(LockError::Busy));
        assert!(
            started.elapsed() >= Duration::from_millis(300),
            "a busy lock is retried for the whole wait"
        );

        drop(first);
        let again = InstanceLock::acquire(&data.0, Duration::ZERO);
        assert!(again.is_ok(), "dropping the holder frees the lock");
        assert!(
            data.0.join(LOCK_FILE).is_file(),
            "the lock file is never deleted"
        );
    }

    #[test]
    fn a_second_copy_is_told_who_owns_the_folder() {
        let data = TempDir::new("owner");
        let identity = Identity::classify(DAILY_IDENTIFIER).unwrap();
        let exe = PathBuf::from("/Users/ash/Applications/MonoCode Hub.app/Contents/MacOS/monocode");
        let record = RunningRecord::for_this_process(&identity, "0.16.0", &exe);
        assert_eq!(record.pid, std::process::id());
        assert!(record.start_time > 0);
        assert!(record.start_time <= now_ms());
        assert_eq!(
            record.bundle_path,
            "/Users/ash/Applications/MonoCode Hub.app"
        );
        write_running(&data.0, &record).unwrap();

        let owner = read_running(&data.0).unwrap();
        for field in ["pid", "startTime", "kind", "sha", "branch", "bundlePath"] {
            assert!(owner.get(field).is_some(), "running.json has {field}");
        }
        let refusal = Refusal::InUse {
            data_dir: data.0.clone(),
            owner: Some(owner),
        };
        assert_eq!(refusal.exit_code(), EXIT_IN_USE);
        let detail = refusal.detail();
        assert!(detail.starts_with("The daily app (pid "), "{detail}");
        assert!(detail.contains(&format!("pid {}", std::process::id())));
        assert!(detail.contains("from /Users/ash/Applications/MonoCode Hub.app"));
        assert!(detail.contains(&stamp_label(&stamp())));

        let unknown = Refusal::InUse {
            data_dir: data.0.clone(),
            owner: None,
        };
        assert!(unknown
            .detail()
            .starts_with("Another copy of MonoCode Hub owns"));
        assert!(
            describe_owner(&json!({"kind": "dev", "slot": "wt-a", "pid": 7}))
                .starts_with("Dev copy wt-a (pid 7")
        );
    }

    #[test]
    fn the_apps_own_file_commands_refuse_the_lock_file() {
        for lock in [
            "/Users/a/Library/Application Support/com.ash.monocode-hub/instance-owner.sqlite",
            "/x/instance-owner.sqlite-journal",
        ] {
            let error = guard_lock_file(Path::new(lock)).unwrap_err();
            assert!(error.contains("instance lock"), "{error}");
        }
        for fine in [
            "/x/running.json",
            "/x/monocode.db",
            "/x/instance-owner.sqlite.txt",
            "/x/instance-owner.sqlite/inside",
            "/",
        ] {
            assert!(guard_lock_file(Path::new(fine)).is_ok(), "{fine}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_the_lock_file_is_refused_too() {
        let dir = std::env::temp_dir().join(format!("monocode-lock-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let lock = dir.join(LOCK_FILE);
        std::fs::write(&lock, b"").unwrap();
        std::fs::write(dir.join("notes.txt"), b"").unwrap();
        let link = dir.join("innocent.txt");
        std::os::unix::fs::symlink(&lock, &link).unwrap();
        let chained = dir.join("also-innocent.md");
        std::os::unix::fs::symlink(&link, &chained).unwrap();
        for path in [&link, &chained] {
            let error = guard_lock_file(path).unwrap_err();
            assert!(error.contains("instance lock"), "{error}");
        }
        assert!(guard_lock_file(&dir.join("notes.txt")).is_ok());
        assert!(guard_lock_file(&dir.join("not-there-yet.txt")).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_refusal_has_its_exit_code() {
        assert_eq!(
            Refusal::DevSetup {
                error: "no home".into()
            }
            .exit_code(),
            EXIT_NO_LOCK
        );
        let dir = PathBuf::from("/tmp/x");
        assert_eq!(
            Refusal::NewerDatabase {
                data_dir: dir.clone(),
                found: 20,
                supported: 19
            }
            .exit_code(),
            EXIT_NEWER_DATA
        );
        assert_eq!(
            Refusal::NoLock {
                data_dir: dir,
                error: "x".into()
            }
            .exit_code(),
            EXIT_NO_LOCK
        );
        assert_eq!(EXIT_IN_USE, 75);
    }

    #[test]
    fn the_embedded_stamp_parses_and_can_be_found_in_a_binary() {
        let parsed = parse_stamp(STAMP_LINE).expect("build.rs writes a stamp this build can read");
        assert!(
            parsed.sha == "unknown"
                || (parsed.sha.len() == 40 && parsed.sha.bytes().all(|b| b.is_ascii_hexdigit())),
            "{parsed:?}"
        );
        assert!(!parsed.branch.is_empty());
        let at = parsed.built_at.as_bytes();
        assert_eq!(at.len(), 20, "{}", parsed.built_at);
        assert_eq!((at[4], at[10], at[19]), (b'-', b'T', b'Z'));
        assert_eq!(stamp(), parsed);

        let line = r#"MONOCODE-STAMP:{"sha":"0123456789abcdef0123456789abcdef01234567","branch":"hub/x}y","dirty":true,"builtAt":"2026-10-19T21:04:05Z"}"#;
        let expected = Stamp {
            sha: "0123456789abcdef0123456789abcdef01234567".into(),
            branch: "hub/x}y".into(),
            dirty: true,
            built_at: "2026-10-19T21:04:05Z".into(),
        };
        assert_eq!(parse_stamp(line), Some(expected.clone()));
        assert_eq!(parse_stamp(&line["MONOCODE-STAMP:".len()..]), None);
        assert_eq!(parse_stamp("MONOCODE-STAMP:{not json"), None);

        let mut binary = vec![0u8, 1, 2, 0xff];
        binary.extend_from_slice(b"MONOCODE-STAMP:"); // the prefix on its own, as other code may hold it
        binary.extend_from_slice(&[0, 7]);
        binary.extend_from_slice(line.as_bytes());
        binary.extend_from_slice(&[b'}', 0, 0xfe]);
        assert_eq!(find_stamp(&binary), Some(expected));
        assert_eq!(find_stamp(b"no stamp in here"), None);
        assert_eq!(
            stamp_label(&parse_stamp(line).unwrap()),
            "hub/x}y @ 0123456-dirty"
        );
        assert_eq!(
            dev_window_title(&parse_stamp(line).unwrap()),
            "Hivra Dev - hub/x}y @ 0123456-dirty"
        );
    }

    #[test]
    fn the_webview_and_version_report_the_identity_stamp_and_policy() {
        let copy = Identity::classify(&dev("wt-a")).unwrap();
        let info = app_info(&copy, "MonoCode Hub Dev", "0.16.0");
        assert_eq!(info["kind"], "dev");
        assert_eq!(info["slot"], "wt-a");
        assert_eq!(info["identifier"], dev("wt-a"));
        assert_eq!(info["stamp"]["sha"], json!(stamp().sha));
        assert_eq!(info["schemaVersion"], crate::session_store::SCHEMA_VERSION);
        assert_eq!(info["policy"]["habits"], false);
        let script = init_script(&info);
        assert!(script.starts_with("window.__MONOCODE_APP__ = Object.freeze({"));
        assert!(script.ends_with("});"));
    }

    #[test]
    fn tests_see_the_identity_compiled_from_tauri_conf() {
        // `cargo test` builds with src-tauri/tauri.conf.json alone: the daily identity.
        assert_eq!(current().identifier, DAILY_IDENTIFIER);
        assert_eq!(kind(), Kind::Daily);
    }

    #[test]
    fn a_temporary_home_is_told_apart_from_the_real_one() {
        let temp = TempDir::new("home-a");
        let real = TempDir::new("home-b");
        assert_eq!(
            detect_isolated_home(Some(temp.0.clone()), Some(real.0.clone())),
            Some(temp.0.clone())
        );
        assert_eq!(
            detect_isolated_home(Some(real.0.clone()), Some(real.0.clone())),
            None
        );
        // The same folder by another spelling (a symlink, /tmp vs /private/tmp) is still the real home.
        #[cfg(unix)]
        {
            let link = temp.0.join("link-to-real");
            std::os::unix::fs::symlink(&real.0, &link).unwrap();
            assert_eq!(detect_isolated_home(Some(link), Some(real.0.clone())), None);
        }
        assert_eq!(detect_isolated_home(None, Some(real.0.clone())), None);
        assert_eq!(
            detect_isolated_home(Some(PathBuf::new()), Some(real.0.clone())),
            None
        );
        // This test process runs with the real HOME.
        assert_eq!(isolated_home(), None);
        assert!(real_home().is_some_and(|home| home.is_absolute()));
    }

    #[test]
    fn a_daily_copy_under_a_temporary_home_keeps_off_system_wide_things() {
        let isolated = Kind::Daily.policy().in_isolated_home();
        for off in [
            isolated.daily_keychain,
            isolated.reap_orphans,
            isolated.phone_access,
            isolated.notification_prompt,
            isolated.global_shortcut,
        ] {
            assert!(!off);
        }
        // Its own data under that HOME still behaves like the daily app's.
        assert!(
            isolated.habits && isolated.automations && isolated.auto_resume && isolated.live_ash_os
        );
        let dev = Kind::Dev.policy();
        assert_eq!(
            dev.in_isolated_home(),
            dev,
            "a dev copy has all of it off already"
        );
    }

    #[test]
    fn only_a_dev_copy_gets_the_shared_claude_config() {
        let home = TempDir::new("claude");
        assert_eq!(
            dev_claude_config_dir_in(Kind::Daily, Some(home.0.clone())).unwrap(),
            None
        );
        let dir = dev_claude_config_dir_in(Kind::Dev, Some(home.0.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(dir, home.0.join(".monocode-hub-dev/claude-config"));
        assert!(dir.is_dir(), "created on first use");
        assert!(dev_claude_config_dir_in(Kind::Dev, None).is_err());
    }
}

#[cfg(test)]
mod keychain_location_tests {
    use super::*;

    // Fix round 3, H4: a subcommand that reads the Keychain runs only from where the daily app lives, as `run()` does.
    #[test]
    fn a_keychain_subcommand_refuses_the_daily_identity_outside_applications() {
        let home = std::env::temp_dir().join(format!("mc-kc-{}", uuid::Uuid::new_v4()));
        let installed = home.join(DAILY_BUNDLE).join("Contents/MacOS/monocode");
        let elsewhere = home.join("Worktrees/wt/target/release/monocode");
        for exe in [&installed, &elsewhere] {
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            std::fs::write(exe, b"binary").unwrap();
        }
        let daily = Identity::classify(DAILY_IDENTIFIER).unwrap();
        assert!(keychain_location_refusal(&daily, false, &installed, &home).is_none());
        assert!(keychain_location_refusal(&daily, false, &elsewhere, &home).is_some());
        let _ = std::fs::remove_dir_all(&home);
    }
}
