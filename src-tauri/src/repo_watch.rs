//! Project pin list (WP-166). The file is `.hivra/repo-pins.json` inside the
//! project. A missing file is an empty list. Two windows save with a revision,
//! so a stale write is refused and the caller reads again.

use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};

use crate::portable::scrubber;

const MAX_BYTES: usize = 1_000_000;

fn gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

fn home_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?:/Users/|/home/)[^\s"'<>]+|[A-Za-z]:[/\\]Users[/\\][^\s"'<>]+"#).unwrap()
    })
}

fn hide_home(text: &str) -> String {
    home_re().replace_all(text, "a local path").into_owned()
}

fn hide_homes(value: &mut Value) {
    match value {
        Value::String(text) => *text = hide_home(text),
        Value::Array(items) => {
            for item in items {
                hide_homes(item);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                hide_homes(item);
            }
        }
        _ => {}
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn canonical_dir(project: &Path) -> Result<PathBuf, String> {
    if project.as_os_str().is_empty() {
        return Err("That folder is not a project.".into());
    }
    let canon =
        crate::fs::canonical(project).map_err(|_| "That folder is not a project.".to_string())?;
    if !canon.is_dir() || canon.parent().is_none() {
        return Err("That folder is not a project.".into());
    }
    Ok(canon)
}

/// The pin file, after proving it cannot leave the project. A link is refused.
pub fn pins_path(project: &Path) -> Result<PathBuf, String> {
    let root = canonical_dir(project)?;
    let folder = root.join(".hivra");
    if is_symlink(&folder) {
        let target = crate::fs::canonical(&folder)
            .map_err(|_| "The pin folder is not inside the project.".to_string())?;
        if !target.starts_with(&root) {
            return Err("The pin folder is not inside the project.".into());
        }
    }
    let file = folder.join("repo-pins.json");
    if is_symlink(&file) {
        return Err("The pin file is a link. It was left alone.".into());
    }
    if !file.starts_with(&root) {
        return Err("The pin file is not inside the project.".into());
    }
    Ok(file)
}

fn empty_doc(revision: u64) -> String {
    format!("{{\"revision\":{revision},\"enqueueDrafts\":false,\"pins\":[]}}\n")
}

fn read_revision(text: &str) -> u64 {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return value.get("revision").and_then(Value::as_u64).unwrap_or(0);
    }
    // A half-written file still names its revision, so the next save is not stuck at 0.
    static RE: OnceLock<Regex> = OnceLock::new();
    let revision = RE.get_or_init(|| Regex::new(r#""revision"\s*:\s*(\d+)"#).unwrap());
    revision
        .captures(text)
        .and_then(|cap| cap.get(1))
        .and_then(|found| found.as_str().parse().ok())
        .unwrap_or(0)
}

fn prepare(body: &str, revision: u64) -> Result<Vec<u8>, String> {
    if body.len() > MAX_BYTES {
        return Err("That pin list is too large.".into());
    }
    let mut value: Value =
        serde_json::from_str(body).map_err(|_| "That pin list could not be read.".to_string())?;
    if !value.is_object() {
        return Err("That pin list could not be read.".into());
    }
    scrubber().redact_value(&mut value);
    hide_homes(&mut value);
    let Some(map) = value.as_object_mut() else {
        return Err("That pin list could not be read.".into());
    };
    map.insert("revision".into(), json!(revision));
    if map.get("enqueueDrafts").and_then(Value::as_bool) != Some(true) {
        map.insert("enqueueDrafts".into(), json!(false));
    }
    if !map.get("pins").is_some_and(Value::is_array) {
        map.insert("pins".into(), json!([]));
    }
    let mut bytes = serde_json::to_vec_pretty(&value)
        .map_err(|_| "Could not save the pin list.".to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn load(project: &Path) -> Result<String, String> {
    let _hold = gate().lock().unwrap_or_else(|error| error.into_inner());
    let path = pins_path(project)?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(empty_doc(0)),
        Err(_) => return Err("Could not read the pin list.".into()),
    };
    let revision = read_revision(&text);
    match prepare(&text, revision) {
        Ok(bytes) => {
            String::from_utf8(bytes).map_err(|_| "Could not read the pin list.".to_string())
        }
        Err(_) => Ok(empty_doc(revision)),
    }
}

pub fn cas(project: &Path, expected: u64, body: &str) -> Result<bool, String> {
    let _hold = gate().lock().unwrap_or_else(|error| error.into_inner());
    let path = pins_path(project)?;
    let current = match fs::read_to_string(&path) {
        Ok(text) => read_revision(&text),
        Err(error) if error.kind() == ErrorKind::NotFound => 0,
        Err(_) => return Err("Could not read the pin list.".into()),
    };
    if current != expected {
        return Ok(false);
    }
    let bytes = prepare(body, expected.saturating_add(1))?;
    atomic_write(&path, &bytes, "pin list")?;
    Ok(true)
}

fn save_error(noun: &str, this_time: bool) -> String {
    if this_time {
        format!("Could not save the {noun} this time.")
    } else {
        format!("Could not save the {noun}.")
    }
}

fn atomic_write(path: &Path, bytes: &[u8], noun: &str) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err(save_error(noun, false));
    };
    if is_symlink(parent) {
        return Err("The pin folder is a link. It was left alone.".into());
    }
    fs::create_dir_all(parent).map_err(|_| save_error(noun, false))?;
    let tmp = path.with_extension("json.tmp");
    if tmp.parent() != Some(parent) || is_symlink(&tmp) {
        return Err(save_error(noun, false));
    }
    if let Err(error) = fs::write(&tmp, bytes) {
        let _ = remove_inside(parent, &tmp);
        return Err(save_error(noun, error.kind() == ErrorKind::TimedOut));
    }
    replace_file(&tmp, path, noun)
}

fn remove_inside(parent: &Path, path: &Path) -> Result<(), ()> {
    if path.parent() != Some(parent) || is_symlink(path) {
        return Err(());
    }
    fs::remove_file(path).map_err(|_| ())
}

fn replace_file(from: &Path, to: &Path, noun: &str) -> Result<(), String> {
    let Some(parent) = to.parent() else {
        return Err(save_error(noun, false));
    };
    if from.parent() != Some(parent) {
        return Err(save_error(noun, false));
    }
    if !to.exists() {
        return fs::rename(from, to).map_err(|_| save_error(noun, false));
    }
    let backup = to.with_extension("json.bak");
    if backup.parent() != Some(parent) {
        return Err(save_error(noun, false));
    }
    if backup.exists() && !is_symlink(&backup) {
        let _ = fs::remove_file(&backup);
    }
    fs::rename(to, &backup).map_err(|_| save_error(noun, false))?;
    match fs::rename(from, to) {
        Ok(()) => {
            if !is_symlink(&backup) {
                let _ = fs::remove_file(&backup);
            }
            Ok(())
        }
        Err(_) => {
            if !to.exists() && !is_symlink(&backup) {
                let _ = fs::rename(&backup, to);
            }
            Err(save_error(noun, false))
        }
    }
}

#[tauri::command(async)]
pub fn repo_watch_load(project: String) -> Result<String, String> {
    load(Path::new(&project))
}

#[tauri::command(async)]
pub fn repo_watch_cas(project: String, expected: u64, body: String) -> Result<bool, String> {
    cas(Path::new(&project), expected, &body)
}

fn drafts_path(project: &Path) -> Result<PathBuf, String> {
    let root = canonical_dir(project)?;
    let folder = root.join(".hivra");
    if is_symlink(&folder) {
        let target = crate::fs::canonical(&folder)
            .map_err(|_| "The draft folder is not inside the project.".to_string())?;
        if !target.starts_with(&root) {
            return Err("The draft folder is not inside the project.".into());
        }
    }
    let file = folder.join("repo-watch-drafts.json");
    if is_symlink(&file) {
        return Err("The draft file is a link. It was left alone.".into());
    }
    if !file.starts_with(&root) {
        return Err("The draft file is not inside the project.".into());
    }
    Ok(file)
}

fn empty_drafts(revision: u64) -> String {
    format!("{{\"revision\":{revision},\"drafts\":[],\"seen\":[]}}\n")
}

fn prepare_drafts(body: &str, revision: u64) -> Result<Vec<u8>, String> {
    if body.len() > MAX_BYTES {
        return Err("That draft list is too large.".into());
    }
    let mut value: Value =
        serde_json::from_str(body).map_err(|_| "That draft list could not be read.".to_string())?;
    if !value.is_object() {
        return Err("That draft list could not be read.".into());
    }
    scrubber().redact_value(&mut value);
    hide_homes(&mut value);
    let Some(map) = value.as_object_mut() else {
        return Err("That draft list could not be read.".into());
    };
    map.insert("revision".into(), json!(revision));
    if !map.get("drafts").is_some_and(Value::is_array) {
        map.insert("drafts".into(), json!([]));
    }
    if !map.get("seen").is_some_and(Value::is_array) {
        map.insert("seen".into(), json!([]));
    }
    let mut bytes = serde_json::to_vec_pretty(&value)
        .map_err(|_| "Could not save the draft list.".to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn load_drafts(project: &Path) -> Result<String, String> {
    let _hold = gate().lock().unwrap_or_else(|error| error.into_inner());
    let path = drafts_path(project)?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(empty_drafts(0)),
        Err(_) => return Err("Could not read the draft list.".into()),
    };
    let revision = read_revision(&text);
    match prepare_drafts(&text, revision) {
        Ok(bytes) => {
            String::from_utf8(bytes).map_err(|_| "Could not read the draft list.".to_string())
        }
        Err(_) => Ok(empty_drafts(revision)),
    }
}

pub fn cas_drafts(project: &Path, expected: u64, body: &str) -> Result<bool, String> {
    let _hold = gate().lock().unwrap_or_else(|error| error.into_inner());
    let path = drafts_path(project)?;
    let current = match fs::read_to_string(&path) {
        Ok(text) => read_revision(&text),
        Err(error) if error.kind() == ErrorKind::NotFound => 0,
        Err(_) => return Err("Could not read the draft list.".into()),
    };
    if current != expected {
        return Ok(false);
    }
    let bytes = prepare_drafts(body, expected.saturating_add(1))?;
    atomic_write(&path, &bytes, "draft list")?;
    Ok(true)
}

#[tauri::command(async)]
pub fn repo_watch_drafts_load(project: String) -> Result<String, String> {
    load_drafts(Path::new(&project))
}

#[tauri::command(async)]
pub fn repo_watch_drafts_cas(project: String, expected: u64, body: String) -> Result<bool, String> {
    cas_drafts(Path::new(&project), expected, &body)
}

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

const ENV_KEYS: &[&str] = &[
    "HOME",
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

/// gh and git only. PATH is the one we were given, never a token from the environment.
pub fn passed_env(source: &[(&str, &str)], path: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for key in ENV_KEYS {
        if let Some((_, value)) = source.iter().find(|(name, _)| name == key) {
            out.push(((*key).to_string(), (*value).to_string()));
        }
    }
    out.push(("PATH".into(), path.into()));
    out.push(("GH_PROMPT_DISABLED".into(), "1".into()));
    out.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
    out.push(("NO_COLOR".into(), "1".into()));
    out
}

pub fn allow_program(program: &str) -> bool {
    program == "gh" || program == "git"
}

pub struct RunOutput {
    pub started: bool,
    pub timed_out: bool,
    pub success: bool,
    pub stdout: String,
}

pub trait CommandRunner {
    fn run(&mut self, program: &str, args: &[String], env: &[(String, String)]) -> RunOutput;
}

fn not_started() -> RunOutput {
    RunOutput {
        started: false,
        timed_out: false,
        success: false,
        stdout: String::new(),
    }
}

struct ProcessRunner;

impl CommandRunner for ProcessRunner {
    fn run(&mut self, program: &str, args: &[String], env: &[(String, String)]) -> RunOutput {
        if !allow_program(program) {
            return not_started();
        }
        let mut command = Command::new(program);
        command.env_clear();
        for (key, value) in env {
            command.env(key, value);
        }
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::hide_window_console(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => return not_started(),
        };
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() > FETCH_TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return RunOutput {
                        started: true,
                        timed_out: true,
                        success: false,
                        stdout: String::new(),
                    };
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => {
                    return RunOutput {
                        started: true,
                        timed_out: false,
                        success: false,
                        stdout: String::new(),
                    }
                }
            }
        };
        let mut stdout = String::new();
        if let Some(mut pipe) = child.stdout.take() {
            let _ = pipe.read_to_string(&mut stdout);
        }
        RunOutput {
            started: true,
            timed_out: false,
            success: status.success(),
            stdout,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchBodies {
    pub rejected: bool,
    pub started: bool,
    pub timed_out: bool,
    pub unreachable: bool,
    pub repo_status: u16,
    pub repo_body: String,
    pub compare_status: u16,
    pub compare_body: String,
    pub release_status: u16,
    pub release_body: String,
    pub release_missing: bool,
    pub release_unchecked: bool,
    pub remote_head: String,
}

fn blank_fetch() -> FetchBodies {
    FetchBodies {
        rejected: false,
        started: false,
        timed_out: false,
        unreachable: false,
        repo_status: 0,
        repo_body: String::new(),
        compare_status: 0,
        compare_body: String::new(),
        release_status: 0,
        release_body: String::new(),
        release_missing: false,
        release_unchecked: false,
        remote_head: String::new(),
    }
}

fn clean_body(text: &str) -> String {
    let (redacted, _) = scrubber().redact_text(text);
    hide_home(&redacted)
}

fn safe_slug(part: &str) -> bool {
    let bytes = part.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && part != "."
        && part != ".."
        && !part.starts_with('.')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn github_slug(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://github.com/")?;
    if rest.contains(['?', '#', '\\', '@']) {
        return None;
    }
    let mut parts = rest.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !safe_slug(owner) || !safe_slug(repo) {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

fn pin_ok(pin: &str) -> bool {
    let bytes = pin.as_bytes();
    (7..=40).contains(&bytes.len()) && bytes.iter().all(|byte| byte.is_ascii_hexdigit())
}

fn compare_ref(branch: &str) -> String {
    if branch.is_empty()
        || branch.contains("..")
        || branch.contains([' ', '?', '#', '\\'])
        || !branch
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '/' | '-'))
    {
        return "HEAD".into();
    }
    branch.to_string()
}

fn default_branch(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return "HEAD".into();
    };
    compare_ref(
        value
            .get("default_branch")
            .and_then(Value::as_str)
            .unwrap_or("HEAD"),
    )
}

fn first_sha(text: &str) -> String {
    let Some(word) = text.split_whitespace().next() else {
        return String::new();
    };
    if (7..=40).contains(&word.len()) && word.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        word.to_ascii_lowercase()
    } else {
        String::new()
    }
}

/// One public compare. A timeout drops the output. A bad address does not run a command.
pub fn check_pin(
    url: &str,
    pin: &str,
    runner: &mut dyn CommandRunner,
    source: &[(&str, &str)],
    path: &str,
) -> FetchBodies {
    let Some((owner, repo)) = github_slug(url) else {
        let mut body = blank_fetch();
        body.rejected = true;
        return body;
    };
    if !pin_ok(pin) {
        let mut body = blank_fetch();
        body.started = true;
        return body;
    }
    let env = passed_env(source, path);
    let repo_args = vec![
        "api".into(),
        "--hostname".into(),
        "github.com".into(),
        format!("repos/{owner}/{repo}"),
    ];
    let repo_out = runner.run("gh", &repo_args, &env);
    if repo_out.timed_out {
        let mut body = blank_fetch();
        body.started = true;
        body.timed_out = true;
        return body;
    }
    if !repo_out.started {
        let remote = runner.run(
            "git",
            &[
                "ls-remote".into(),
                format!("https://github.com/{owner}/{repo}.git"),
                "HEAD".into(),
            ],
            &env,
        );
        let mut body = blank_fetch();
        body.timed_out = remote.timed_out;
        body.unreachable = !remote.timed_out && (!remote.started || !remote.success);
        if remote.success && !remote.timed_out {
            body.remote_head = first_sha(&remote.stdout);
        }
        return body;
    }
    if !repo_out.success {
        let mut body = blank_fetch();
        body.started = true;
        body.unreachable = true;
        return body;
    }
    let branch = default_branch(&repo_out.stdout);
    let compare_out = runner.run(
        "gh",
        &[
            "api".into(),
            "--hostname".into(),
            "github.com".into(),
            format!("repos/{owner}/{repo}/compare/{pin}...{branch}"),
        ],
        &env,
    );
    if compare_out.timed_out {
        let mut body = blank_fetch();
        body.started = true;
        body.timed_out = true;
        return body;
    }
    let release_out = runner.run(
        "gh",
        &[
            "api".into(),
            "--hostname".into(),
            "github.com".into(),
            format!("repos/{owner}/{repo}/releases/latest"),
        ],
        &env,
    );
    let mut body = blank_fetch();
    body.started = true;
    body.repo_status = 200;
    body.repo_body = clean_body(&repo_out.stdout);
    if compare_out.success {
        body.compare_status = 200;
        body.compare_body = clean_body(&compare_out.stdout);
    } else {
        body.unreachable = true;
    }
    if release_out.timed_out {
        body.release_unchecked = true;
    } else if release_out.success {
        body.release_status = 200;
        body.release_body = clean_body(&release_out.stdout);
    } else if release_out.stdout.contains("Not Found") {
        body.release_missing = true;
        body.release_status = 404;
    } else {
        body.release_unchecked = true;
    }
    body
}

pub fn write_summary(project: &Path, markdown: &str) -> Result<(), String> {
    let _hold = gate().lock().unwrap_or_else(|error| error.into_inner());
    let root = canonical_dir(project)?;
    let folder = root.join(".hivra");
    if is_symlink(&folder) {
        let target = crate::fs::canonical(&folder)
            .map_err(|_| "The summary folder is not inside the project.".to_string())?;
        if !target.starts_with(&root) {
            return Err("The summary folder is not inside the project.".into());
        }
    }
    let file = folder.join("repo-watch-changes.md");
    if is_symlink(&file) || !file.starts_with(&root) {
        return Err("The summary file is a link. It was left alone.".into());
    }
    let clean = clean_body(markdown);
    if clean.len() > MAX_BYTES {
        return Err("That summary is too large.".into());
    }
    atomic_write(&file, clean.as_bytes(), "summary").map_err(|error| {
        if error.contains("this time") {
            "Could not write the summary this time.".into()
        } else if error.contains("link") {
            error
        } else {
            "Could not write the summary.".into()
        }
    })
}

#[tauri::command(async)]
pub fn repo_watch_fetch(url: String, pin_sha: String) -> FetchBodies {
    let source: Vec<(String, String)> = std::env::vars().collect();
    let pairs: Vec<(&str, &str)> = source
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    check_pin(
        &url,
        &pin_sha,
        &mut ProcessRunner,
        &pairs,
        &crate::harness::cached_gui_search_path(),
    )
}

#[tauri::command(async)]
pub fn repo_watch_write_summary(project: String, body: String) -> Result<(), String> {
    write_summary(Path::new(&project), &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Tmp {
        path: PathBuf,
    }

    impl Tmp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "hivra-wp166-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    const PLANTED: &str = "ghp_PLANTED0123456789abcdefghijklmnopqrstu";

    #[test]
    fn a_missing_file_is_an_empty_list() {
        let tmp = Tmp::new();
        let project = tmp.path.join("My Project");
        fs::create_dir_all(&project).unwrap();
        let text = load(&project).unwrap();
        assert!(text.contains("\"pins\": []") || text.contains("\"pins\":[]"));
        assert!(text.contains("\"revision\": 0") || text.contains("\"revision\":0"));
        assert!(!project.join(".hivra").exists());
        assert!(!text.contains(&tmp.path.display().to_string()));
    }

    #[test]
    fn the_second_window_does_not_overwrite() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        let body = r#"{"enqueueDrafts":false,"pins":[{"url":"https://github.com/acme/web","licence":"MIT","pinSha":"abc1234","notes":"door"}]}"#;
        assert!(cas(&project, 0, body).unwrap());
        assert!(!cas(&project, 0, body).unwrap());
        assert!(cas(&project, 1, body).unwrap());
        let text = fs::read_to_string(project.join(".hivra").join("repo-pins.json")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["revision"], 2);
        assert_eq!(value["pins"][0]["url"], "https://github.com/acme/web");
    }

    #[test]
    fn a_token_and_a_home_path_are_not_stored() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        let body = format!(
            r#"{{"pins":[{{"url":"https://github.com/acme/web","notes":"see {PLANTED} /Users/example/notes"}}]}}"#
        );
        assert!(cas(&project, 0, &body).unwrap());
        let text = fs::read_to_string(project.join(".hivra").join("repo-pins.json")).unwrap();
        assert!(!text.contains(PLANTED));
        assert!(!text.contains("/Users/example"));
        assert!(text.contains("[secret removed]"));
        assert!(text.contains("a local path"));
    }

    #[test]
    fn only_a_real_true_keeps_drafts() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        assert!(cas(&project, 0, r#"{"enqueueDrafts":"yes","pins":[]}"#).unwrap());
        let off = fs::read_to_string(project.join(".hivra").join("repo-pins.json")).unwrap();
        assert!(off.contains("\"enqueueDrafts\": false"));
        assert!(cas(&project, 1, r#"{"enqueueDrafts":true,"pins":[]}"#).unwrap());
        let on = fs::read_to_string(project.join(".hivra").join("repo-pins.json")).unwrap();
        assert!(on.contains("\"enqueueDrafts\": true"));
    }

    #[test]
    fn load_does_not_rewrite_the_file() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        let body = r#"{"pins":[{"url":"https://github.com/acme/web","licence":"MIT","pinSha":"abc1234","notes":""}]}"#;
        assert!(cas(&project, 0, body).unwrap());
        let path = project.join(".hivra").join("repo-pins.json");
        let before = fs::read(&path).unwrap();
        let shown = load(&project).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(shown.contains("acme/web"));
    }

    #[test]
    fn a_broken_file_keeps_its_revision_and_drops_the_rows() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        let folder = project.join(".hivra");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("repo-pins.json"), "{\"revision\":4,\"pins\":").unwrap();
        let text = load(&project).unwrap();
        assert!(text.contains('4'));
        assert!(text.contains("[]"));
    }

    #[test]
    fn a_path_that_is_not_a_folder_is_refused() {
        let tmp = Tmp::new();
        let file = tmp.path.join("not-a-dir");
        fs::write(&file, "x").unwrap();
        let err = cas(&file, 0, r#"{"pins":[]}"#).unwrap_err();
        assert_eq!(err, "That folder is not a project.");
        assert!(!err.contains(&tmp.path.display().to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_outside_the_project_is_not_written() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        let outside = tmp.path.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, project.join(".hivra")).unwrap();
        let err = cas(&project, 0, r#"{"pins":[]}"#).unwrap_err();
        assert!(err.contains("not inside"));
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_skips_the_symlink_case() {
        // Creating a symlink here needs extra privileges. The path jail still
        // refuses a folder that is not a project, which is covered above.
    }

    struct RecordedCall {
        program: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    }

    struct Fake {
        calls: Vec<RecordedCall>,
        script: Vec<RunOutput>,
    }

    impl CommandRunner for Fake {
        fn run(&mut self, program: &str, args: &[String], env: &[(String, String)]) -> RunOutput {
            self.calls.push(RecordedCall {
                program: program.to_string(),
                args: args.to_vec(),
                env: env.to_vec(),
            });
            self.script.pop().unwrap_or_else(not_started)
        }
    }

    fn source() -> Vec<(&'static str, &'static str)> {
        vec![
            ("HOME", "/tmp/home"),
            ("PATH", "/should/not/pass"),
            ("GH_TOKEN", PLANTED),
            ("GITHUB_TOKEN", PLANTED),
        ]
    }

    #[test]
    fn the_child_env_has_no_token() {
        let env = passed_env(&source(), "/usr/bin");
        assert!(env.iter().all(|(key, value)| key != "GH_TOKEN"
            && key != "GITHUB_TOKEN"
            && !value.contains(PLANTED)));
        assert!(env
            .iter()
            .any(|(key, value)| key == "PATH" && value == "/usr/bin"));
        assert!(env
            .iter()
            .any(|(key, value)| key == "GIT_TERMINAL_PROMPT" && value == "0"));
        assert!(!allow_program("bash"));
        assert!(allow_program("gh") && allow_program("git"));
    }

    #[test]
    fn a_bad_address_runs_no_command() {
        let mut fake = Fake {
            calls: vec![],
            script: vec![],
        };
        let body = check_pin(
            "https://github.com/acme/../secret",
            "abc1234",
            &mut fake,
            &source(),
            "/usr/bin",
        );
        assert!(body.rejected);
        assert!(fake.calls.is_empty());
    }

    #[test]
    fn a_timeout_drops_the_output() {
        let mut fake = Fake {
            calls: vec![],
            script: vec![RunOutput {
                started: true,
                timed_out: true,
                success: false,
                stdout: format!("see {PLANTED} /Users/example/notes"),
            }],
        };
        let body = check_pin(
            "https://github.com/acme/web",
            "abc1234",
            &mut fake,
            &source(),
            "/usr/bin",
        );
        assert!(body.timed_out);
        assert!(body.repo_body.is_empty());
        assert!(!format!("{body:?}").contains(PLANTED));
    }

    #[test]
    fn gh_missing_falls_back_to_git_and_a_release_404_is_not_a_failure() {
        let mut fake = Fake {
            calls: vec![],
            script: vec![
                RunOutput {
                    started: true,
                    timed_out: false,
                    success: false,
                    stdout: "{\"message\":\"Not Found\"}".into(),
                },
                RunOutput {
                    started: true,
                    timed_out: false,
                    success: true,
                    stdout: "{\"ahead_by\":0,\"commits\":[]}".into(),
                },
                RunOutput {
                    started: true,
                    timed_out: false,
                    success: true,
                    stdout: "{\"default_branch\":\"release/1\"}".into(),
                },
                RunOutput {
                    started: false,
                    timed_out: false,
                    success: false,
                    stdout: String::new(),
                },
            ],
        };
        let fell = check_pin(
            "https://github.com/acme/web",
            "abc1234",
            &mut fake,
            &source(),
            "/usr/bin",
        );
        assert!(!fell.started);
        assert_eq!(fake.calls.len(), 2);
        assert_eq!(fake.calls[1].program, "git");
        assert_eq!(fake.calls[1].args[0], "ls-remote");
        assert!(fake.calls[1].args[1].ends_with("acme/web.git"));
        assert!(fake.calls[1]
            .env
            .iter()
            .all(|(key, _)| key != "GH_TOKEN" && key != "GITHUB_TOKEN"));

        let mut fake = Fake {
            calls: vec![],
            script: vec![
                RunOutput {
                    started: true,
                    timed_out: false,
                    success: false,
                    stdout: "{\"message\":\"Not Found\"}".into(),
                },
                RunOutput {
                    started: true,
                    timed_out: false,
                    success: true,
                    stdout: "{\"ahead_by\":2,\"commits\":[]}".into(),
                },
                RunOutput {
                    started: true,
                    timed_out: false,
                    success: true,
                    stdout: "{\"default_branch\":\"my branch\"}".into(),
                },
            ],
        };
        let body = check_pin(
            "https://github.com/acme/web",
            "abc1234",
            &mut fake,
            &source(),
            "/usr/bin",
        );
        assert_eq!(body.compare_status, 200);
        assert!(body.release_missing);
        assert!(!body.unreachable);
        let compare = &fake.calls[1].args[3];
        assert!(compare.contains("abc1234...HEAD"), "{compare}");
        assert!(!body.compare_body.contains(PLANTED));
    }

    #[test]
    fn the_summary_file_drops_a_token_and_refuses_a_link() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        write_summary(&project, &format!("see {PLANTED} in /Users/example/notes")).unwrap();
        let text =
            fs::read_to_string(project.join(".hivra").join("repo-watch-changes.md")).unwrap();
        assert!(!text.contains(PLANTED));
        assert!(!text.contains("/Users/example"));
        assert!(text.contains("[secret removed]"));
        assert!(text.contains("a local path"));
    }

    #[cfg(unix)]
    #[test]
    fn a_summary_link_is_left_alone() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        let outside = tmp.path.join("outside.md");
        fs::create_dir_all(project.join(".hivra")).unwrap();
        fs::write(&outside, "keep").unwrap();
        symlink(
            &outside,
            project.join(".hivra").join("repo-watch-changes.md"),
        )
        .unwrap();
        let err = write_summary(&project, "hello").unwrap_err();
        assert!(err.contains("link"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");
    }

    #[cfg(windows)]
    #[test]
    fn windows_skips_the_summary_link() {
        // Creating a symlink here needs extra privileges.
    }

    #[test]
    fn a_draft_list_drops_a_token_and_refuses_a_stale_save() {
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        fs::create_dir_all(&project).unwrap();
        let missing = load_drafts(&project).unwrap();
        assert!(missing.contains("\"revision\":0"));
        assert!(missing.contains("\"drafts\":[]"));
        let body = format!(
            "{{\"revision\":0,\"drafts\":[{{\"title\":\"see {PLANTED} in /Users/example/notes\"}}],\"seen\":[]}}"
        );
        assert!(cas_drafts(&project, 0, &body).unwrap());
        let text =
            fs::read_to_string(project.join(".hivra").join("repo-watch-drafts.json")).unwrap();
        assert!(!text.contains(PLANTED));
        assert!(!text.contains("/Users/example"));
        assert!(text.contains("[secret removed]"));
        assert!(text.contains("a local path"));
        assert!(!cas_drafts(&project, 0, &body).unwrap());
        let kept =
            fs::read_to_string(project.join(".hivra").join("repo-watch-drafts.json")).unwrap();
        assert_eq!(kept, text);
    }

    #[cfg(unix)]
    #[test]
    fn a_draft_link_is_left_alone() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let project = tmp.path.join("proj");
        let outside = tmp.path.join("outside.json");
        fs::create_dir_all(project.join(".hivra")).unwrap();
        fs::write(&outside, "keep").unwrap();
        symlink(
            &outside,
            project.join(".hivra").join("repo-watch-drafts.json"),
        )
        .unwrap();
        let err = cas_drafts(&project, 0, r#"{"drafts":[]}"#).unwrap_err();
        assert!(err.contains("link"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");
    }

    #[cfg(windows)]
    #[test]
    fn windows_skips_the_draft_link() {
        // Creating a symlink here needs extra privileges.
    }
}
