//! WP-92: `monocode secret-run --grant-stdin`, one secret into one child's environment, once. The signed grant comes
//! on stdin, so it is never in the process list.
//!
//! The MCP server runs this after `secrets.run` returns a signed grant. It verifies the signature, refuses an expired
//! grant (60 seconds) and a nonce it has already seen, re-reads the secret (refusing if the version changed or the item
//! is gone), checks that no argv element holds the value, then spawns the command with `env_clear()` and an allow-list
//! plus the one secret, its own process group, and stdout and stderr captured. It prints one JSON object and nothing
//! else on stdout; the value never appears in it.
//!
//! A timeout is `timedOut: true` with the output so far, not a failure. A keychain that won't give the key is "not now,
//! try again", not "wrong secret".

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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

/// The child's environment: the allow-list from this process, plus the one secret. Never `MONOCODE_*`, never the app
/// token, never a model key, never another secret.
pub fn allow_env(secret_env: &str, secret_value: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let path = crate::harness::login_shell_path()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(crate::harness::cached_gui_search_path);
    out.push(("PATH".to_string(), path));
    for key in ALLOWED {
        if *key == "PATH" {
            continue;
        }
        if let Some(value) = std::env::var_os(key) {
            out.push(((*key).to_string(), value.to_string_lossy().into_owned()));
        }
    }
    out.push((secret_env.to_string(), secret_value.to_string()));
    out
}

/// The program, found on the allow-list PATH ourselves so a caller's PATH can never choose a different binary.
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
    if payload.command.iter().any(|arg| arg.contains(value)) {
        return Err(
            "That command already holds the key in its own words, so it wasn't run. Name the key through the environment instead."
                .to_string(),
        );
    }
    if !super::valid_env_name(&payload.env) || is_allowlisted_env(&payload.env) {
        return Err("That run asked for a name the command already has.".to_string());
    }
    let env = allow_env(&payload.env, value);
    let path = env
        .iter()
        .find(|(key, _)| key == "PATH")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let executable = payload.command.first().cloned().unwrap_or_default();
    let Some(program) = resolve_program(&executable, &path) else {
        return Err(format!("{executable} isn't installed on this Mac."));
    };
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
    let stdout = read_stream(child.stdout.take().expect("stdout is piped"));
    let stderr = read_stream(child.stderr.take().expect("stderr is piped"));
    let started = Instant::now();
    // The budget travels inside the signed grant; the cap is applied again here as a backstop.
    let budget = Duration::from_secs(payload.timeout_seconds.clamp(1, super::TIMEOUT_MAX));
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= budget => {
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
        let script = fixture(
            &tmp,
            "slow",
            "#!/bin/sh\necho before-sleep\nsleep 30\necho after-sleep\n",
        );
        let mut payload = run_payload(vec![crate::fs::path_to_js(&script)]);
        // Long enough that a loaded machine still gets the shell to print its first line before the budget ends.
        payload.timeout_seconds = 3;
        let outcome = execute(&payload, "sk_live_abcdefgh", &tmp).unwrap();
        assert!(outcome.timed_out);
        assert!(outcome.stdout.text.contains("before-sleep"));
        assert!(!outcome.stdout.text.contains("after-sleep"));
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

    fn payload_for(command: &[&str]) -> super::super::grant::Payload {
        super::super::grant::Payload {
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
        // `sh` exits at once, but the `sleep` it started keeps the output pipe open past the reader's grace.
        let payload = payload_for(&["sh", "-c", "sleep 4 & echo started"]);
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
        // A silent run is a different thing: no output, and nothing unread.
        let silent = execute_with_grace(
            &payload_for(&["sh", "-c", "exit 0"]),
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
}
