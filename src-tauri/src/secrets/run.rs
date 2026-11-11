//! WP-92: `monocode secret-run --grant-stdin`, one secret into one child's environment, once. The signed grant comes
//! on stdin, so it is never in the process list.
//!
//! The app runs this (`spawn_run`, from `secrets_grant`) after the person approves a run; the grant never leaves Rust.
//! It verifies the signature, refuses an expired grant (60 seconds) and a nonce it has already seen, re-reads the secret
//! (refusing if the version changed or the item is gone), checks that the pinned program still has its approved file
//! identity, checks that no argv element holds the value, then spawns the pinned program with `env_clear()`, a fixed PATH,
//! a home the account cannot write, the allow-list and the one secret, in its own process group, with stdout and stderr captured. It
//! prints one JSON object and nothing else on stdout; the value never appears in it. The child's home is a folder the
//! account cannot write (`/var/empty` when that folder is sealed), not the account's own home and not a folder under the
//! temporary directory.
//!
//! A timeout is `timedOut: true` with the output so far, not a failure. A keychain that won't give the key is "not now,
//! try again", not "wrong secret".

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::json;

use super::scrub;

pub const SUBCOMMAND: &str = "secret-run";
/// `EX_NOPERM`: refused before anything runs.
pub const EXIT_REFUSED: i32 = 77;
/// How long a reader waits for a stream after the child exits.
const READER_GRACE: Duration = Duration::from_secs(5);
/// A store refusal (a person clicking Deny on the system prompt, or a locked store) is "not now", never "wrong key".
pub const KEYCHAIN_DENIED: &str = "Not now. Your keychain didn't give the key. Try again.";

/// The names a child always gets. The secret's own name may not be one of them.
const ALLOWED: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "HOMEDRIVE",
    "HOMEPATH",
];

/// Whether `name` is already in the child's allow-list (case-insensitive on Windows).
pub fn is_allowlisted_env(name: &str) -> bool {
    ALLOWED.iter().any(|allowed| {
        if cfg!(windows) {
            allowed.eq_ignore_ascii_case(name)
        } else {
            *allowed == name
        }
    })
}

/// The child's environment. `PATH` is [`child_path`], never the caller's, and `SHELL` is never passed on (a login shell would
/// read the caller's files). `HOME` is not here: [`execute`] points it at a folder the account cannot write (fix round 5, M3),
/// so the account's own config files (`~/.curlrc`, `~/.gitconfig`) never reach the child. What is left of the allow-list (locale,
/// temporary folder, terminal) is copied from this process. Never `MONOCODE_*`, never the app token, never a model key,
/// never another secret.
pub fn allow_env(secret_env: &str, secret_value: &str) -> Vec<(String, String)> {
    let mut out = vec![("PATH".to_string(), child_path())];
    for key in ALLOWED {
        if matches!(*key, "PATH" | "HOME" | "SHELL") {
            continue;
        }
        if let Some(value) = std::env::var_os(key) {
            out.push(((*key).to_string(), value.to_string_lossy().into_owned()));
        }
    }
    out.push((secret_env.to_string(), secret_value.to_string()));
    out
}

/// The search path a command is looked up on and runs with: fixed, never read from the caller or from `$SHELL`.
pub fn search_path() -> String {
    crate::connectors::launch::safe_path()
}

/// The PATH the child runs with (fix round 5, L3): system folders first, then any other folder on the search path that the
/// account cannot write. Connector launches keep their own order ([`crate::connectors::launch::SAFE_PATH`]). A program in a
/// folder the account can write could be started by name by the approved command, with the key in its environment.
pub fn child_path() -> String {
    let mut kept: Vec<PathBuf> = Vec::new();
    #[cfg(unix)]
    {
        for folder in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            let path = PathBuf::from(folder);
            if path.is_dir()
                && !has_user_writable_component(&path)
                && !kept.iter().any(|have| have == &path)
            {
                kept.push(path);
            }
        }
    }
    for folder in std::env::split_paths(&search_path()) {
        if kept.iter().any(|have| have == &folder) {
            continue;
        }
        if !has_user_writable_component(&folder) {
            kept.push(folder);
        }
    }
    std::env::join_paths(kept)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Whether a folder on the way to `path` is one the account can write, or one with a group or other write bit.
/// Links are resolved first. A path that cannot be resolved counts as writable (fail closed). A link that lives in a
/// folder the account can write counts too, even when its target does not: the link can be pointed somewhere else.
/// This sees a Homebrew library beside the program only when the program itself is under Homebrew. A program in a
/// system folder can still load a Homebrew library this check never walks. Unix only. Windows judges by its own
/// permissions, so this is false there.
#[cfg(unix)]
pub fn has_user_writable_component(path: &Path) -> bool {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    let resolved_writable = match std::fs::canonicalize(path) {
        Ok(resolved) => ancestors_writable(&resolved, uid),
        Err(_) => true,
    };
    resolved_writable || given_path_writable(path, uid)
}

#[cfg(unix)]
fn ancestors_writable(path: &Path, uid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    path.ancestors()
        .filter(|folder| !folder.as_os_str().is_empty())
        .any(|folder| {
            std::fs::symlink_metadata(folder)
                .map(|meta| meta.uid() == uid || meta.mode() & 0o022 != 0)
                .unwrap_or(true)
        })
}

/// The path as it was given, one component at a time, without following links. A missing component counts as writable.
#[cfg(unix)]
fn given_path_writable(path: &Path, uid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    let mut walked = PathBuf::new();
    let mut saw_component = false;
    for component in path.components() {
        saw_component = true;
        walked.push(component);
        match std::fs::symlink_metadata(&walked) {
            Ok(meta) => {
                if meta.uid() == uid || meta.mode() & 0o022 != 0 {
                    return true;
                }
            }
            Err(_) => return true,
        }
    }
    !saw_component
}

#[cfg(not(unix))]
pub fn has_user_writable_component(_path: &Path) -> bool {
    false
}

/// Windows has no sealed folder like `/var/empty`. A run there still gets a private folder, removed when the run ends.
/// Folder rules do not apply on Windows (a known limit).
#[cfg(not(unix))]
struct RunHome(PathBuf);

#[cfg(not(unix))]
impl RunHome {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "monocode-run-home-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&path)
            .map_err(|_| "Couldn't make an empty home for the command.".to_string())?;
        Ok(Self(path))
    }
}

#[cfg(not(unix))]
impl Drop for RunHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A folder the account cannot write, used as the child's home on Unix. Not created here and never removed.
#[cfg(unix)]
fn sealed_config_home() -> Result<PathBuf, String> {
    let path = PathBuf::from("/var/empty");
    if !path.is_dir() || has_user_writable_component(&path) {
        return Err("Couldn't give the command a home you cannot write, so it wasn't run.".into());
    }
    Ok(path)
}

/// Homes a crashed secret run left under the temporary folder. A symlink is left alone. Anything that does not stay
/// inside the temporary folder after links are resolved is left alone. `/var/empty` is not in that folder and is never
/// deleted.
pub fn remove_leftover_run_homes() {
    let temp = std::env::temp_dir();
    let Ok(temp_canon) = std::fs::canonicalize(&temp) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&temp) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !name.starts_with("monocode-run-home-") {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let Ok(canon) = std::fs::canonicalize(&path) else {
            continue;
        };
        if canon == temp_canon || !canon.starts_with(&temp_canon) {
            continue;
        }
        let _ = std::fs::remove_dir_all(&canon);
    }
}

/// The program's identity: device, inode, size and modification time (Unix), or size and modification time elsewhere. A
/// program replaced in place, even under the same name, changes it. `None` when the path is not a file.
pub fn program_identity(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    // Fix round 3 (M1): a rewrite that keeps the size and restores the modification time still changes the content digest,
    // and the change time records the write itself.
    let digest = content_digest(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(format!(
            "{}:{}:{}:{}:{}:{}:{}",
            meta.dev(),
            meta.ino(),
            meta.len(),
            modified,
            meta.ctime(),
            meta.ctime_nsec(),
            digest
        ))
    }
    #[cfg(not(unix))]
    {
        Some(format!("{}:{}:{}", meta.len(), modified, digest))
    }
}

/// The SHA-256 of a file's bytes, in hex.
fn content_digest(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// Whether a program is a shell, or `env` (which runs one), by its name once a link is followed. The caller passes the
/// canonical path, so a link named `tool` to a shell is refused (fix round 3, M1).
pub fn refuse_shell_program(program: &Path) -> bool {
    let program = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf());
    let base = program
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    base == "env"
        || super::SHELLS
            .iter()
            .any(|shell| shell.strip_suffix(".exe").unwrap_or(shell) == base)
}

/// The card's warning for a program in a folder the person owns: anything running as them can replace it, after the
/// approval, under the same name. `None` for a folder the account does not own (a system folder). Fix round 3, M1.
pub fn program_folder_warning(program: &Path) -> Option<String> {
    // A folder on the way (after links are resolved) counts. This sees a Homebrew library beside the program only when
    // the program itself is under Homebrew. A program in a system folder can still load a Homebrew library this check
    // never walks.
    let folder = program.parent()?;
    has_user_writable_component(program).then(|| {
        format!(
            "{} is in a folder you can write to, so anything that runs as you can replace it.",
            folder.display()
        )
    })
}

/// Where a program may never come from: the project, the run's own folder, a temporary folder, a worktree. The agent can
/// write into every one of them, so a program found there is one it could have planted. `Some(why)` refuses the run.
pub fn program_location_refusal(
    program: &Path,
    project: Option<&str>,
    cwd: Option<&str>,
) -> Option<String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    roots.extend(project.map(PathBuf::from));
    roots.extend(cwd.map(PathBuf::from));
    roots.push(std::env::temp_dir());
    for fixed in [
        "/tmp",
        "/private/tmp",
        "/var/folders",
        "/private/var/folders",
    ] {
        roots.push(PathBuf::from(fixed));
    }
    if let Some(home) = crate::instance::real_home() {
        roots.push(home.join("Worktrees"));
        roots.push(home.join("Projects"));
    }
    // A program that does not exist yet still has a folder: that folder is resolved, so a temporary folder's real path matches.
    let program = std::fs::canonicalize(program).unwrap_or_else(|_| {
        match (
            program
                .parent()
                .and_then(|dir| std::fs::canonicalize(dir).ok()),
            program.file_name(),
        ) {
            (Some(dir), Some(name)) => dir.join(name),
            _ => program.to_path_buf(),
        }
    });
    let inside = roots.iter().any(|root| {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        program.starts_with(&root)
    });
    inside.then(|| {
        "That program sits in a project, a worktree or a temporary folder, so it wasn't run. Install it somewhere else."
            .to_string()
    })
}

/// The program, found on the fixed search path ourselves so a caller's PATH can never choose a different binary.
pub fn resolve_program(program: &str, path: &str) -> Option<PathBuf> {
    if program.contains('/') || (cfg!(windows) && program.contains('\\')) {
        let path = PathBuf::from(program);
        return path.is_file().then_some(path);
    }
    let names: Vec<String> = if cfg!(windows) && Path::new(program).extension().is_none() {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| format!("{program}.{ext}"))
            .collect()
    } else {
        vec![program.to_string()]
    };
    std::env::split_paths(path).find_map(|dir| {
        names
            .iter()
            .map(|name| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

/// The largest grant read from stdin: a signed payload and its signature, in base64, is a few hundred bytes.
pub const GRANT_MAX: usize = 16 * 1024;

/// `secret-run --grant-stdin`: the signed grant comes on stdin, never as an argument, so it is not in the process list
/// (`ps`, Activity Monitor) for the life of the run.
fn parse_grant(args: &[String]) -> Result<(), String> {
    match args {
        [flag] if flag == "--grant-stdin" => Ok(()),
        [flag, ..] if flag == "--grant" => Err(
            "The grant comes on stdin, not as an argument: monocode secret-run --grant-stdin"
                .to_string(),
        ),
        _ => Err(
            "usage: monocode secret-run --grant-stdin (the grant is read from stdin)".to_string(),
        ),
    }
}

/// The grant, read from stdin: trimmed, not empty, no longer than [`GRANT_MAX`].
fn read_grant(reader: impl Read) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader
        .take(GRANT_MAX as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Couldn't read the grant.".to_string())?;
    if bytes.len() > GRANT_MAX {
        return Err("That grant is too long.".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "That grant isn't text.".to_string())?;
    let text = text.trim();
    if text.is_empty() {
        return Err("No grant was given.".into());
    }
    Ok(text.to_string())
}

/// What one stream becomes, plus whether either was cut.
pub struct Streams {
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

fn read_stream(mut stream: impl Read + Send + 'static) -> mpsc::Receiver<std::io::Result<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stream.read_to_end(&mut bytes);
        let _ = tx.send(Ok(bytes));
    });
    rx
}

/// A stream's bytes, or `None` when its reader did not finish within the grace (a child the command left behind still
/// holds the pipe open). `None` is not an empty stream: the answer says the output could not be read.
fn collect(rx: mpsc::Receiver<std::io::Result<Vec<u8>>>, grace: Duration) -> Option<Vec<u8>> {
    match rx.recv_timeout(grace) {
        Ok(Ok(bytes)) => Some(bytes),
        _ => None,
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    // The child is its own group leader (`process_group(0)`), so the negative pid reaches every process it started.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_group(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(any(unix, windows)))]
fn kill_group(_: u32) {}

/// Where nonce files live (the copy's own data folder).
pub fn data_dir() -> Result<PathBuf, String> {
    crate::instance::data_dir(&crate::instance::current().identifier)
        .ok_or_else(|| "There is no home folder.".to_string())
}

/// One row's version and label, from the app's own database. Read-only: nothing here writes a secret.
fn db_secret(data: &Path, scope: &str, name: &str) -> Result<Option<super::SecretRow>, String> {
    let path = data.join("monocode.db");
    if !path.is_file() {
        return Ok(None);
    }
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| "Couldn't check your keys.".to_string())?;
    let _ = conn.busy_timeout(Duration::from_secs(5));
    super::get_secret(&conn, scope, name)
}

fn write_run(
    payload: &super::grant::Payload,
    executable: &str,
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: i64,
) {
    // Best effort: a run never fails because its log row could not be written, and the row never holds a value.
    let Some(path) = crate::instance::data_dir(&crate::instance::current().identifier) else {
        return;
    };
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        path.join("monocode.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
    ) else {
        return;
    };
    let _ = conn.busy_timeout(Duration::from_secs(5));
    let _ = super::record_run(
        &conn,
        &payload.scope,
        &payload.name,
        &payload.subject,
        executable,
        exit_code,
        timed_out,
        duration_ms,
        super::grant::now_millis(),
    );
    let _ = super::touch_used(
        &conn,
        &payload.scope,
        &payload.name,
        super::grant::now_millis(),
    );
}

/// Refuse, in one JSON object on stdout, and say why in plain words.
fn refuse(message: &str) -> i32 {
    println!("{}", json!({ "error": message }));
    EXIT_REFUSED
}

/// What the model is told when a stream could not be read in time.
pub const OUTPUT_UNREAD: &str = "The output could not be read in time.";

/// One run's result, before it is printed.
#[derive(Debug)]
pub struct Outcome {
    pub exit_code: Option<i32>,
    pub stdout: scrub::Scrubbed,
    pub stderr: scrub::Scrubbed,
    pub timed_out: bool,
    /// A stream could not be read within the grace after the command ended. The command may have printed an answer;
    /// an empty `stdout` here is not the same as a silent run.
    pub unread: bool,
}

impl Outcome {
    /// The one JSON object `secret-run` prints. The value never appears in it: both streams are scrubbed.
    pub fn to_json(&self) -> serde_json::Value {
        let mut out = json!({
            "exitCode": self.exit_code,
            "stdout": self.stdout.text,
            "stderr": self.stderr.text,
            "timedOut": self.timed_out,
            "truncated": self.stdout.truncated || self.stderr.truncated,
            "outputUnread": self.unread,
        });
        if self.unread {
            out["note"] = json!(OUTPUT_UNREAD);
        }
        out
    }
}

/// Run the command in the grant. The caller has verified the grant and re-read the value; everything here refuses
/// before a spawn if anything about the run is unsafe.
pub fn execute(
    payload: &super::grant::Payload,
    value: &str,
    data: &Path,
) -> Result<Outcome, String> {
    execute_with_grace(payload, value, data, READER_GRACE)
}

/// [`execute`] with the time a stream reader is given after the command ends (the tests shorten it).
pub fn execute_with_grace(
    payload: &super::grant::Payload,
    value: &str,
    data: &Path,
    grace: Duration,
) -> Result<Outcome, String> {
    let budget = Duration::from_secs(payload.timeout_seconds.clamp(1, super::TIMEOUT_MAX));
    execute_controlled(payload, value, data, grace, budget, &AtomicBool::new(false))
}

/// [`execute_with_grace`] with the budget and a stop given by the caller. Setting `stop` ends the command's group as if its
/// budget had run out, and the answer says `timedOut`. The tests use it, so the timeout no longer races the wall clock
/// (fix round 4).
pub fn execute_controlled(
    payload: &super::grant::Payload,
    value: &str,
    data: &Path,
    grace: Duration,
    budget: Duration,
    stop: &AtomicBool,
) -> Result<Outcome, String> {
    if payload.command.iter().any(|arg| arg.contains(value)) {
        return Err(
            "That command already holds the key in its own words, so it wasn't run. Name the key through the environment instead."
                .to_string(),
        );
    }
    if let Some(why) = super::env_name_refusal(&payload.env) {
        return Err(why);
    }
    if is_allowlisted_env(&payload.env) {
        return Err("That run asked for a name the command already has.".to_string());
    }
    // The program was pinned when it was approved: an absolute path and its file identity, both inside the signed payload.
    // Anything else (a bare name, a relative path, a file replaced since) is refused before a spawn.
    let executable = payload.command.first().cloned().unwrap_or_default();
    let program = Path::new(&executable);
    if !program.is_absolute() || payload.program_identity.is_empty() {
        return Err(
            "The program wasn't pinned when it was approved, so it wasn't run. Ask again.".into(),
        );
    }
    if program_identity(program).as_deref() != Some(payload.program_identity.as_str()) {
        return Err(
            "The program changed since it was approved, so it wasn't run. Ask again.".into(),
        );
    }
    // Round 5 (M3): the child's home is a folder the account cannot write. A private folder under the temporary
    // directory is writable by anything running as the account while the command starts. Unix uses `/var/empty` and
    // points wget's config at `/dev/null`. That folder is not created here and not removed. Windows keeps a private
    // folder; its folder rules do not apply.
    #[cfg(unix)]
    let home = sealed_config_home()?;
    #[cfg(not(unix))]
    let run_home = RunHome::new()?;
    #[cfg(not(unix))]
    let home = run_home.0.clone();
    let home_text = home.to_string_lossy().into_owned();
    let mut env = allow_env(&payload.env, value);
    env.push(("HOME".to_string(), home_text.clone()));
    env.push(("CURL_HOME".to_string(), home_text.clone()));
    env.push(("XDG_CONFIG_HOME".to_string(), home_text));
    #[cfg(unix)]
    env.push(("WGETRC".to_string(), "/dev/null".to_string()));
    let needles = scrub::needles(value);
    let mut command = Command::new(program);
    command
        .args(&payload.command[1..])
        .env_clear()
        .envs(env.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = payload.cwd.as_deref() {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = command
        .spawn()
        .map_err(|_| format!("Couldn't start {executable}."))?;
    // Fix round 3 (M1): the file is checked again once it has started. A swap in the gap before the spawn is seen here,
    // and the run is stopped; the gap itself is a known limit (see the vault doc).
    if program_identity(program).as_deref() != Some(payload.program_identity.as_str()) {
        kill_group(child.id());
        let _ = child.wait();
        return Err("The program changed as it started, so the run was stopped. Ask again.".into());
    }
    let stdout = read_stream(child.stdout.take().expect("stdout is piped"));
    let stderr = read_stream(child.stderr.take().expect("stderr is piped"));
    let started = Instant::now();
    // The budget travels inside the signed grant; the cap is applied again in the caller as a backstop.
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if stop.load(Ordering::SeqCst) || started.elapsed() >= budget => {
                timed_out = true;
                kill_group(child.id());
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                kill_group(child.id());
                break None;
            }
        }
    };
    // Fix round 3 (H3, the process group): a background child the command left behind keeps the key only until the group
    // is ended, and that is now also when the command ends, not only on a timeout or an error.
    #[cfg(unix)]
    kill_group(child.id());
    let duration_ms = started.elapsed().as_millis() as i64;
    let out_bytes = collect(stdout, grace);
    let err_bytes = collect(stderr, grace);
    let unread = out_bytes.is_none() || err_bytes.is_none();
    let out = scrub::stream(&out_bytes.unwrap_or_default(), &needles);
    let err = scrub::stream(&err_bytes.unwrap_or_default(), &needles);
    let exit_code = status.and_then(|status| status.code());
    write_run(payload, &executable, exit_code, timed_out, duration_ms);
    let _ = data;
    Ok(Outcome {
        exit_code,
        stdout: out,
        stderr: err,
        timed_out,
        unread,
    })
}

/// The app's own spend of one signed grant: `secret-run --grant-stdin` from this same program, with a cleared environment
/// that holds only the fixed PATH and the account's home. The grant goes on stdin, never in an argument or the environment.
/// The one JSON answer comes back; a refusal is its words. The grant never leaves Rust.
pub fn spawn_run(exe: &Path, grant: &str) -> Result<serde_json::Value, String> {
    use std::io::Write;
    let mut command = Command::new(exe);
    command
        .arg(SUBCOMMAND)
        .arg("--grant-stdin")
        .env_clear()
        .env("PATH", search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(home) = crate::instance::real_home() {
        command.env("HOME", home);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Couldn't start the approved command.".to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        // Dropped at the end of the block: the child sees the end of its input.
        stdin
            .write_all(grant.as_bytes())
            .map_err(|_| "Couldn't start the approved command.".to_string())?;
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "Couldn't start the approved command.".to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|_| "The approved command didn't answer.".to_string())?;
    if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(error.to_string());
    }
    Ok(value)
}

pub fn run_main(args: &[String]) -> i32 {
    let grant = match parse_grant(args).and_then(|()| read_grant(std::io::stdin())) {
        Ok(grant) => grant,
        Err(why) => {
            eprintln!("monocode {SUBCOMMAND}: {why}");
            return refuse(&why);
        }
    };
    let Ok(data) = data_dir() else {
        return refuse("There is no home folder.");
    };
    let payload = match super::grant::check(
        super::store::active(),
        &grant,
        &super::grant::nonce_dir(&data),
        super::grant::now_millis(),
    ) {
        Ok(payload) => payload,
        Err(why) => return refuse(&why),
    };
    // Re-read the metadata: the secret may have been deleted or rotated since the grant was signed.
    let row = match db_secret(&data, &payload.scope, &payload.name) {
        Ok(Some(row)) => row,
        Ok(None) => return refuse("That secret was deleted. Ask for it again."),
        Err(why) => return refuse(&why),
    };
    if row.version != payload.version {
        return refuse("That secret changed, ask again.");
    }
    let value = match super::read_value(super::store::active(), &payload.scope, &payload.name) {
        Ok(value) => value,
        Err(_) => return refuse(KEYCHAIN_DENIED),
    };
    let outcome = match execute(&payload, &value, &data) {
        Ok(outcome) => outcome,
        Err(why) => return refuse(&why),
    };
    println!("{}", outcome.to_json());
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allow_list_holds_no_app_token_model_key_or_other_secret() {
        let env = allow_env("STRIPE_API_KEY", "sk_live_abcdefgh");
        for (key, _) in &env {
            assert!(!key.starts_with("MONOCODE_"), "{key}");
            assert!(!key.contains("MODEL"), "{key}");
            assert!(!key.contains("TOKEN"), "{key}");
        }
        assert!(env.iter().any(|(key, _)| key == "PATH"));
        assert!(env
            .iter()
            .any(|(key, value)| key == "STRIPE_API_KEY" && value == "sk_live_abcdefgh"));
        // Exactly one secret: the one named.
        let count = env
            .iter()
            .filter(|(key, value)| *value == "sk_live_abcdefgh" && key != "PATH")
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn a_secret_may_not_take_one_of_the_allowed_names() {
        assert!(is_allowlisted_env("PATH"));
        assert!(is_allowlisted_env("HOME"));
        assert!(is_allowlisted_env("TMPDIR"));
        assert!(!is_allowlisted_env("STRIPE_API_KEY"));
        assert!(!is_allowlisted_env("MONOCODE_APP_TOKEN"));
    }

    #[test]
    fn the_program_is_resolved_on_the_allow_list_path_never_the_callers() {
        let tmp = std::env::temp_dir().join(format!("mc-run-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let program = tmp.join("fixture-command");
        std::fs::write(&program, b"#!/bin/sh\necho hi\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = crate::fs::path_to_js(&tmp);
        assert_eq!(
            resolve_program("fixture-command", &path),
            Some(program.clone())
        );
        assert_eq!(resolve_program("definitely-not-here", &path), None);
        assert_eq!(
            resolve_program(&crate::fs::path_to_js(&program), ""),
            Some(program.clone())
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // Changed for fix round 1 (item K): this test pinned `--grant <base64>`, which put the whole grant in the process
    // list. The only form now is `--grant-stdin`, and the old one is refused.
    #[test]
    fn the_grant_comes_on_stdin_and_never_as_an_argument() {
        assert_eq!(parse_grant(&args(&["--grant-stdin"])), Ok(()));
        let err = parse_grant(&args(&["--grant", "abc"])).unwrap_err();
        assert!(err.contains("stdin"), "{err}");
        assert!(parse_grant(&args(&[])).is_err());
        assert!(parse_grant(&args(&["--grant-stdin", "extra"])).is_err());
        assert!(parse_grant(&args(&["--other", "abc"])).is_err());
    }

    #[test]
    fn a_grant_read_from_stdin_is_trimmed_and_bounded() {
        assert_eq!(
            read_grant(std::io::Cursor::new(b"  abc123==\n".to_vec())).unwrap(),
            "abc123=="
        );
        assert!(read_grant(std::io::Cursor::new(Vec::new())).is_err());
        assert!(read_grant(std::io::Cursor::new(b"   \n".to_vec())).is_err());
        assert!(read_grant(std::io::Cursor::new(vec![b'a'; GRANT_MAX + 1])).is_err());
        assert_eq!(
            read_grant(std::io::Cursor::new(vec![b'a'; GRANT_MAX]))
                .unwrap()
                .len(),
            GRANT_MAX
        );
        assert!(read_grant(std::io::Cursor::new(vec![0xff, 0xfe])).is_err());
    }

    #[cfg(unix)]
    fn fixture(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn run_payload(command: Vec<String>) -> super::super::grant::Payload {
        let identity = program_identity(Path::new(&command[0])).unwrap_or_default();
        super::super::grant::Payload {
            scope: "global".into(),
            name: "stripe-api-key".into(),
            version: 1,
            subject: "mono-1".into(),
            env: "STRIPE_API_KEY".into(),
            command,
            cwd: None,
            nonce: "0011223344556677".into(),
            expires_at: super::super::grant::now_millis() + 60_000,
            timeout_seconds: 5,
            program_identity: identity,
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_printing_fixture_sees_the_value_without_the_key() {
        let tmp = std::env::temp_dir().join(format!("mc-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = fixture(
            &tmp,
            "print-key",
            "#!/bin/sh\nprintf 'the key is %s\\n' \"$STRIPE_API_KEY\"\n",
        );
        let payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        let outcome = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        assert!(!outcome.stdout.text.contains("sk_live_abcdefgh"));
        assert!(outcome.stdout.text.contains(scrub::MARKER));
        assert!(!outcome.stderr.text.contains("sk_live_abcdefgh"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn a_non_zero_exit_returns_its_output_and_code() {
        let tmp = std::env::temp_dir().join(format!("mc-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = fixture(
            &tmp,
            "fail",
            "#!/bin/sh\necho to-stdout\necho to-stderr >&2\nexit 3\n",
        );
        let payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        let outcome = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap();
        assert_eq!(outcome.exit_code, Some(3));
        assert!(outcome.stdout.text.contains("to-stdout"));
        assert!(outcome.stderr.text.contains("to-stderr"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn a_timeout_kills_the_group_and_reports_timed_out() {
        let tmp = std::env::temp_dir().join(format!("mc-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        // Fix round 4 (test rewrite): no wall-clock race. The command prints, starts a background sleep and writes its pid,
        // then says READY. The test ends the run by the stop (the same as a budget running out) once READY is there, so
        // the outcome does not depend on how fast the machine is.
        let ready = tmp.join("READY");
        let pidfile = tmp.join("pid");
        let script = fixture(
            &tmp,
            "slow",
            &format!(
                "#!/bin/sh\necho before-sleep\nsleep 30 &\necho $! > '{}'\n: > '{}'\nwait\necho after-sleep\n",
                pidfile.display(),
                ready.display()
            ),
        );
        let payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let stop_for_run = std::sync::Arc::clone(&stop);
        let folder = tmp.clone();
        let handle = std::thread::spawn(move || {
            execute_controlled(
                &payload,
                "sk_live_abcdefgh",
                &folder,
                READER_GRACE,
                Duration::from_secs(600),
                &stop_for_run,
            )
        });
        let waited = Instant::now();
        while !ready.exists() {
            assert!(
                waited.elapsed() < Duration::from_secs(20),
                "the command never started"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        stop.store(true, Ordering::SeqCst);
        let outcome = handle.join().unwrap().unwrap();
        assert!(outcome.timed_out);
        assert!(outcome.stdout.text.contains("before-sleep"));
        assert!(!outcome.stdout.text.contains("after-sleep"));
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // The background child is ended with its group. A reaper may take a moment, so poll briefly.
        let mut gone = false;
        for _ in 0..100 {
            // SAFETY: signal 0 only checks that the pid exists; nothing is sent.
            if unsafe { libc::kill(pid, 0) } != 0 {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gone, "the background child {pid} survived the group kill");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn a_path_with_spaces_and_unicode_and_a_cwd_work() {
        let tmp = std::env::temp_dir().join(format!("mc-exec-{}", uuid::Uuid::new_v4()));
        let spaced = tmp.join("a folder ünïcode");
        std::fs::create_dir_all(&spaced).unwrap();
        let script = fixture(&spaced, "where", "#!/bin/sh\npwd\n");
        let mut payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        payload.cwd = Some(crate::fs::path_to_js(
            &crate::fs::canonical(&spaced).unwrap(),
        ));
        let outcome = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.stdout.text.contains("ünïcode"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn crlf_and_invalid_utf8_survive_lossily_in_the_json() {
        let tmp = std::env::temp_dir().join(format!("mc-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = fixture(
            &tmp,
            "bytes",
            "#!/bin/sh\nprintf 'a\\r\\nb\\377\\376c\\n'\n",
        );
        let payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        let outcome = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap();
        assert!(outcome.stdout.text.starts_with("a\r\n"));
        assert!(outcome.stdout.text.contains('c'));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn an_argv_that_holds_the_value_is_refused_before_a_spawn() {
        let tmp = std::env::temp_dir().join(format!("mc-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let payload = run_payload(vec!["echo".into(), "sk_live_abcdefgh".into()]);
        let err = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap_err();
        assert!(err.contains("already holds the key"), "{err}");
        assert!(!err.contains("sk_live_abcdefgh"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[cfg(unix)]
    #[test]
    fn the_value_is_never_in_the_printed_json() {
        // What `run_main` prints is `outcome.to_json()` (run.rs), and it is built from a real child that printed the
        // value on both streams. The printed text must hold neither the value nor a fragment of it.
        let tmp = std::env::temp_dir().join(format!("mc-printed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = fixture(
            &tmp,
            "print-key-twice",
            "#!/bin/sh\nprintf 'out %s\\n' \"$STRIPE_API_KEY\"\nprintf 'err %s\\n' \"$STRIPE_API_KEY\" >&2\n",
        );
        let payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        let outcome = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        let printed = outcome.to_json().to_string();
        assert!(!printed.contains("sk_live_abcdefgh"), "{printed}");
        assert!(!printed.contains("sk_live"), "{printed}");
        assert!(printed.contains(scrub::MARKER), "{printed}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ---- fix round 1, item J: output that could not be read in time is not a silent run ----------------------------

    #[cfg(unix)]
    fn payload_for(command: &[&str]) -> super::super::grant::Payload {
        super::super::grant::Payload {
            program_identity: program_identity(Path::new(command[0])).unwrap_or_default(),
            scope: "global".into(),
            name: "stripe-api-key".into(),
            version: 1,
            subject: "Tally".into(),
            env: "STRIPE_API_KEY".into(),
            command: command.iter().map(|word| word.to_string()).collect(),
            cwd: None,
            nonce: "n".into(),
            expires_at: i64::MAX,
            timeout_seconds: 30,
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_stream_that_stays_open_after_the_command_exits_is_reported_as_unread() {
        let data = std::env::temp_dir();
        // Fix round 4 (test rewrite): the old test raced the shell's exit against the child's setsid. Here a FIFO makes the
        // order fixed: the background perl moves itself into its own session and writes its pid into the FIFO before the
        // shell reads it and exits. So the group kill cannot reach it, and it holds the output pipe past the grace.
        let tmp = std::env::temp_dir().join(format!("mc-unread-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let fifo = tmp.join("handshake");
        let pidfile = tmp.join("pid");
        let fifo_c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a FIFO at a path this test made; the pointer lives only for the call.
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        let fifo_s = fifo.to_string_lossy().into_owned();
        let pid_s = pidfile.to_string_lossy().into_owned();
        let script = "/usr/bin/perl -e 'use POSIX; setsid(); open(my $h, \">\", $ARGV[0]) or die; print $h $$; close $h; sleep 30' \"$1\" & read pid < \"$1\"; echo \"$pid\" > \"$2\"; echo started";
        let payload = payload_for(&["/bin/sh", "-c", script, "sh", &fifo_s, &pid_s]);
        let outcome = execute_with_grace(
            &payload,
            "sk_live_abcdefgh",
            &data,
            Duration::from_millis(250),
        )
        .unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        assert!(
            outcome.unread,
            "the answer must say the output was not read"
        );
        assert!(!outcome.timed_out);
        let printed = outcome.to_json();
        assert_eq!(printed["outputUnread"], true);
        assert_eq!(printed["note"], "The output could not be read in time.");
        // Stop the session the test left running, then clear its folder.
        if let Ok(text) = std::fs::read_to_string(&pidfile) {
            if let Ok(pid) = text.trim().parse::<i32>() {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        // A silent run is a different thing: no output, and nothing unread.
        let silent = execute_with_grace(
            &payload_for(&["/bin/sh", "-c", "exit 0"]),
            "sk_live_abcdefgh",
            &data,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(silent.exit_code, Some(0));
        assert!(!silent.unread);
        let printed = silent.to_json();
        assert_eq!(printed["outputUnread"], false);
        assert!(printed.get("note").is_none());
        assert_eq!(printed["stdout"], "");
    }

    // ---- fix round 2 (C1, H1): the child's environment and the program are pinned, and the grant is spent in Rust --------

    #[test]
    fn the_child_env_takes_no_path_or_shell_from_the_caller() {
        // The caller's PATH and SHELL are whatever this test process has; the child must get the fixed search path.
        let env = allow_env("STRIPE_API_KEY", "sk_live_abcdefgh");
        let get = |key: &str| {
            env.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(get("PATH").as_deref(), Some(child_path().as_str()));
        assert!(get("SHELL").is_none(), "SHELL is never passed on");
        // Fix round 4 (N2): the account's home is never passed on. The run gives its own empty home (execute).
        assert!(
            get("HOME").is_none(),
            "HOME is the run's own, not the account's"
        );
    }

    #[test]
    fn a_program_in_the_project_a_worktree_or_a_temp_folder_is_refused() {
        let project = "/Users/example/Projects/app";
        assert!(program_location_refusal(
            Path::new("/Users/example/Projects/app/node_modules/.bin/gh"),
            Some(project),
            None
        )
        .is_some());
        let worktree = crate::instance::real_home()
            .unwrap_or_else(|| PathBuf::from("/Users/example"))
            .join("Worktrees/hivra-x/bin/stripe");
        assert!(program_location_refusal(&worktree, None, None).is_some());
        assert!(
            program_location_refusal(&std::env::temp_dir().join("planted-stripe"), None, None)
                .is_some()
        );
        assert!(program_location_refusal(
            Path::new("/opt/homebrew/bin/stripe"),
            Some(project),
            None
        )
        .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_program_replaced_after_approval_is_refused_before_it_runs() {
        let tmp = std::env::temp_dir().join(format!("mc-swap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = tmp.join("tool");
        std::fs::write(&script, "#!/bin/sh\necho first\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        // The same name, a different file: the approved identity no longer matches.
        std::fs::write(&script, "#!/bin/sh\necho second-and-longer\n").unwrap();
        let err = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap_err();
        assert!(err.contains("changed since it was approved"), "{err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn a_bare_or_relative_program_is_refused_because_nothing_was_pinned() {
        let tmp = std::env::temp_dir();
        for command in [vec!["stripe".to_string()], vec!["./stripe".to_string()]] {
            let payload = run_payload(command);
            let mut unpinned = payload.clone();
            unpinned.program_identity = String::new();
            let err = execute(&unpinned, "sk_live_abcdefgh", &tmp).unwrap_err();
            assert!(err.contains("wasn't pinned"), "{err}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn spawning_the_grant_reads_the_runners_answer_and_its_refusal() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("mc-spawn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = |name: &str, body: &str| {
            let path = dir.join(name);
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        // The fixture reads its whole stdin first, as `secret-run` does, so the grant write never races its exit.
        let ok = script(
            "ok",
            "#!/bin/sh\ncat >/dev/null\nprintf '{\"exitCode\":0,\"stdout\":\"fine\"}'\n",
        );
        let answer = spawn_run(&ok, "grant").unwrap();
        assert_eq!(answer["stdout"], "fine");
        let refused = script(
            "no",
            "#!/bin/sh\ncat >/dev/null\nprintf '{\"error\":\"That grant is damaged.\"}'\n",
        );
        assert_eq!(
            spawn_run(&refused, "grant").unwrap_err(),
            "That grant is damaged."
        );
        let silent = script("silent", "#!/bin/sh\ncat >/dev/null\nprintf 'not json'\n");
        assert!(spawn_run(&silent, "grant").is_err());
        // The child's PATH is the fixed one, whatever this process has.
        let path_probe = script(
            "path",
            "#!/bin/sh\ncat >/dev/null\nprintf '{\"stdout\":\"%s\"}' \"$PATH\"\n",
        );
        assert_eq!(
            spawn_run(&path_probe, "grant").unwrap()["stdout"],
            search_path()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- fix round 3 (M1, the process group): content and change time in the identity; shells by canonical path; a
    // warning for a program in a folder the person writes to; the group is killed when the main child exits too.

    #[cfg(unix)]
    #[test]
    fn a_same_size_rewrite_with_the_old_modification_time_changes_the_identity() {
        let tmp = std::env::temp_dir().join(format!("mc-id-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("tool");
        std::fs::write(&file, "#!/bin/sh\necho aaaa\n").unwrap();
        let before_mtime = std::fs::metadata(&file).unwrap().modified().unwrap();
        let before = program_identity(&file).unwrap();
        std::fs::write(&file, "#!/bin/sh\necho bbbb\n").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(before_mtime)
            .unwrap();
        assert_ne!(program_identity(&file).unwrap(), before);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_reached_through_a_link_is_refused_by_its_canonical_path() {
        let tmp = std::env::temp_dir().join(format!("mc-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let link = tmp.join("tool");
        std::os::unix::fs::symlink("/bin/sh", &link).unwrap();
        assert!(refuse_shell_program(&link), "a link to a shell is a shell");
        assert!(!refuse_shell_program(Path::new("/usr/bin/true")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn a_program_in_a_folder_the_person_writes_to_gets_a_warning() {
        let tmp = std::env::temp_dir().join(format!("mc-warn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("tool");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        let warning = program_folder_warning(&file)
            .expect("a folder the person owns can be written by anyone who runs as them");
        assert!(warning.contains("can write"), "{warning}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn a_background_child_is_killed_when_the_command_exits() {
        let tmp = std::env::temp_dir().join(format!("mc-bg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = fixture(&tmp, "bg", "#!/bin/sh\nsleep 30 &\necho $!\n");
        let payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        let outcome = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap();
        let pid: i32 = outcome
            .stdout
            .text
            .trim()
            .parse()
            .expect("the background pid");
        // The reaper may take a moment; poll briefly. A live background child is the failure.
        let mut alive = true;
        for _ in 0..40 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                alive = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !alive,
            "the background child kept the key after the command exited"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // The child never reads the account's own home. Round 5 points HOME at a folder the account cannot write, and does
    // not remove that folder.

    #[cfg(unix)]
    #[test]
    fn the_child_does_not_get_the_accounts_home_or_a_temporary_one() {
        let tmp = std::env::temp_dir().join(format!("mc-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = fixture(
            &tmp,
            "where-home",
            "#!/bin/sh\necho \"home=$HOME\"\necho \"curl=$CURL_HOME\"\necho \"xdg=$XDG_CONFIG_HOME\"\necho \"entries=$(ls -A \"$HOME\" | wc -l | tr -d ' ')\"\n",
        );
        let payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        let outcome = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap();
        let line = |key: &str| {
            outcome
                .stdout
                .text
                .lines()
                .find_map(|text| text.strip_prefix(&format!("{key}=")))
                .unwrap_or("")
                .to_string()
        };
        let home = line("home");
        assert!(!home.is_empty(), "{}", outcome.stdout.text);
        if let Some(real) = crate::instance::real_home() {
            assert_ne!(
                home,
                real.to_string_lossy(),
                "the child must not get the account's home"
            );
        }
        assert_eq!(line("curl"), home, "CURL_HOME must name the run's own home");
        assert_eq!(
            line("xdg"),
            home,
            "XDG_CONFIG_HOME must name the run's own home"
        );
        assert!(
            !Path::new(&home).starts_with(std::env::temp_dir()),
            "the home must not be under the temporary folder: {home}"
        );
        assert!(
            Path::new(&home).is_dir(),
            "the sealed home is not deleted after the run"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Round 5 (M3): the child's home is a folder the account cannot write, not a directory under the temporary folder.
    #[cfg(unix)]
    #[test]
    fn the_childs_home_is_a_folder_the_account_cannot_write() {
        let tmp = std::env::temp_dir().join(format!("mc-sealed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = fixture(
            &tmp,
            "sealed-home",
            "#!/bin/sh\necho \"home=$HOME\"\necho \"curl=$CURL_HOME\"\necho \"xdg=$XDG_CONFIG_HOME\"\necho \"wgetrc=$WGETRC\"\nif touch \"$HOME/planted\" 2>/dev/null; then echo writable=yes; else echo writable=no; fi\n",
        );
        let payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        let outcome = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap();
        let line = |key: &str| {
            outcome
                .stdout
                .text
                .lines()
                .find_map(|text| text.strip_prefix(&format!("{key}=")))
                .unwrap_or("")
                .to_string()
        };
        let home = line("home");
        let temp = std::env::temp_dir();
        assert!(
            !Path::new(&home).starts_with(&temp),
            "the home must not be under the temporary folder: {home}"
        );
        assert!(!home.contains("monocode-run-home"), "{home}");
        assert_eq!(line("curl"), home);
        assert_eq!(line("xdg"), home);
        assert_eq!(line("wgetrc"), "/dev/null");
        assert_eq!(line("writable"), "no", "{}", outcome.stdout.text);
        assert!(Path::new(&home).is_dir(), "the sealed home is not deleted");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ---- fix round 4, N3: a folder the account can write is never on the child's PATH, so a planted helper there
    // cannot be started by name with the key in its environment.

    /// Whether a folder on the way to `path` (the path itself included) is one the account can write, or one with a group
    /// or other write bit. Written here, from the file system, not taken from the code under test.
    #[cfg(unix)]
    fn writable_on_the_way(path: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        path.ancestors()
            .filter(|folder| !folder.as_os_str().is_empty())
            .any(|folder| {
                std::fs::metadata(folder)
                    .map(|meta| meta.uid() == uid || meta.mode() & 0o022 != 0)
                    .unwrap_or(false)
            })
    }

    #[cfg(unix)]
    #[test]
    fn no_folder_the_account_can_write_is_on_the_childs_path() {
        let env = allow_env("STRIPE_API_KEY", "sk_live_abcdefgh");
        let path = env
            .iter()
            .find(|(name, _)| name == "PATH")
            .map(|(_, value)| value.clone())
            .expect("the child has a PATH");
        for folder in std::env::split_paths(&path) {
            assert!(
                !writable_on_the_way(&folder),
                "{} is on the child's PATH and the account can write to it",
                folder.display()
            );
        }
    }
}
