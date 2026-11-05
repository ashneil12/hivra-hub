// WP-85. Terminal Claude sessions on this Mac. The plugin connects to 127.0.0.1 only.
// A failure to listen or to install does not stop the app, and it is not a final no.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::instance::{self, Kind};
use crate::session_store::SessionStore;

const MAX_LINE: usize = 1_000_000;
const MAX_TEXT: usize = 100_000;
const SETTING_FILE: &str = "terminal-mirror.json";
const BOOK_FILE: &str = "terminal-mirror-book.json";
const TARGET_FILE: &str = "hivra-mirror.json";
const PLUGIN_NAME: &str = "hivra-mirror";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Setting {
    enabled: bool,
    installed: bool,
    version: u64,
}

struct Host {
    data_dir: PathBuf,
    kind: Kind,
    home: PathBuf,
    app: AppHandle,
}

fn host_slot() -> &'static Mutex<Option<Host>> {
    static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
    HOST.get_or_init(|| Mutex::new(None))
}

fn gate() -> std::sync::MutexGuard<'static, ()> {
    static GATE: Mutex<()> = Mutex::new(());
    GATE.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[derive(Default)]
struct Book {
    revision: u64,
    sessions: Vec<LiveSession>,
    removed: HashSet<String>,
    steers: HashMap<String, VecDeque<Value>>,
}

#[derive(Clone)]
struct LiveSession {
    id: String,
    title: String,
    folder: String,
    state: String,
    blocks: Vec<Value>,
    updated_at: i64,
    permission: Option<Value>,
    transcript: Option<String>,
}

fn book_slot() -> &'static Mutex<Book> {
    static BOOK: OnceLock<Mutex<Book>> = OnceLock::new();
    BOOK.get_or_init(|| Mutex::new(Book::default()))
}

fn lock_book() -> std::sync::MutexGuard<'static, Book> {
    book_slot()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    PathBuf::new()
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn climbs(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn has_claude_dir(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == ".claude")
}

/// The port is written onto the existing running file. A missing file is left missing.
/// A symlink is not followed.
pub(crate) fn publish_mirror(path: &Path, port: u16) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Couldn't publish the port.".into()),
    };
    if meta.file_type().is_symlink() {
        return Err("Couldn't publish the port.".into());
    }
    let text = fs::read_to_string(path).map_err(|_| "Couldn't publish the port.".to_string())?;
    let mut value: Value =
        serde_json::from_str(&text).map_err(|_| "Couldn't publish the port.".to_string())?;
    let Some(obj) = value.as_object_mut() else {
        return Err("Couldn't publish the port.".into());
    };
    obj.insert("mirrorPort".into(), json!(port));
    obj.insert("mirrorHost".into(), json!("127.0.0.1"));
    let bytes =
        serde_json::to_vec_pretty(&value).map_err(|_| "Couldn't publish the port.".to_string())?;
    let again = fs::symlink_metadata(path).map_err(|_| "Couldn't publish the port.".to_string())?;
    if again.file_type().is_symlink() {
        return Err("Couldn't publish the port.".into());
    }
    let tmp = path.with_extension("json.mirror-tmp");
    if is_symlink(&tmp) {
        return Err("Couldn't publish the port.".into());
    }
    fs::write(&tmp, bytes).map_err(|_| "Couldn't publish the port.".to_string())?;
    if is_symlink(path) {
        let _ = fs::remove_file(&tmp);
        return Err("Couldn't publish the port.".into());
    }
    fs::rename(&tmp, path).map_err(|_| "Couldn't publish the port.".to_string())?;
    Ok(())
}

fn parse_setting(text: &str) -> Setting {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Setting::default();
    };
    let Some(obj) = value.as_object() else {
        return Setting::default();
    };
    Setting {
        enabled: obj.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        installed: obj
            .get("installed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        version: obj.get("version").and_then(Value::as_u64).unwrap_or(0),
    }
}

fn read_setting(dir: &Path) -> Setting {
    match fs::read_to_string(dir.join(SETTING_FILE)) {
        Ok(text) => parse_setting(&text),
        Err(_) => Setting::default(),
    }
}

fn write_setting(dir: &Path, setting: &Setting) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|_| "Couldn't save the setting.".to_string())?;
    let path = dir.join(SETTING_FILE);
    if is_symlink(&path) || climbs(&path) {
        return Err("Couldn't save the setting.".into());
    }
    let bytes =
        serde_json::to_vec_pretty(setting).map_err(|_| "Couldn't save the setting.".to_string())?;
    let tmp = dir.join("terminal-mirror.json.tmp");
    if is_symlink(&tmp) {
        return Err("Couldn't save the setting.".into());
    }
    fs::write(&tmp, &bytes).map_err(|_| "Couldn't save the setting.".to_string())?;
    if is_symlink(&path) {
        let _ = fs::remove_file(&tmp);
        return Err("Couldn't save the setting.".into());
    }
    fs::rename(&tmp, &path).map_err(|_| "Couldn't save the setting.".to_string())
}

const ENV_ALLOW: &[&str] = &[
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
];

fn command_env(kind: Kind, home: &Path, inherited: &[(String, String)]) -> Vec<(String, String)> {
    let mut env = Vec::new();
    for (key, value) in inherited {
        if ENV_ALLOW.contains(&key.as_str()) {
            env.push((key.clone(), value.clone()));
        }
    }
    if !env
        .iter()
        .any(|(key, _)| key == "HOME" || key == "USERPROFILE")
    {
        env.push(("HOME".into(), home.to_string_lossy().into_owned()));
    }
    if kind == Kind::Dev {
        env.push((
            "CLAUDE_CONFIG_DIR".into(),
            home.join(instance::DEV_CLAUDE_CONFIG)
                .to_string_lossy()
                .into_owned(),
        ));
    }
    env
}

fn dev_config(home: &Path) -> PathBuf {
    home.join(instance::DEV_CLAUDE_CONFIG)
}

fn dev_target(home: &Path) -> PathBuf {
    dev_config(home).join(TARGET_FILE)
}

/// The target file is only the dev config's own file. A symlink, a `..`, or a `.claude` folder is refused.
fn write_dev_target(home: &Path, data_dir: &Path) -> Result<(), String> {
    let config = dev_config(home);
    if climbs(&config) || has_claude_dir(&config) || is_symlink(&config) {
        return Err("Couldn't save the mirror.".into());
    }
    fs::create_dir_all(&config).map_err(|_| "Couldn't save the mirror.".to_string())?;
    if is_symlink(&config) {
        return Err("Couldn't save the mirror.".into());
    }
    let root =
        crate::fs::canonical(&config).map_err(|_| "Couldn't save the mirror.".to_string())?;
    let home_root =
        crate::fs::canonical(home).map_err(|_| "Couldn't save the mirror.".to_string())?;
    if root != crate::fs::canonical(&config).unwrap_or(root.clone())
        || !root.starts_with(&home_root)
    {
        return Err("Couldn't save the mirror.".into());
    }
    let file = dev_target(home);
    if climbs(&file) || has_claude_dir(&file) || is_symlink(&file) {
        return Err("Couldn't save the mirror.".into());
    }
    let parent = crate::fs::canonical(file.parent().unwrap_or(Path::new(".")))
        .map_err(|_| "Couldn't save the mirror.".to_string())?;
    if parent != root {
        return Err("Couldn't save the mirror.".into());
    }
    let body = serde_json::to_vec_pretty(&json!({ "dataDir": data_dir }))
        .map_err(|_| "Couldn't save the mirror.".to_string())?;
    let tmp = config.join("hivra-mirror.json.tmp");
    if is_symlink(&tmp) {
        return Err("Couldn't save the mirror.".into());
    }
    fs::write(&tmp, body).map_err(|_| "Couldn't save the mirror.".to_string())?;
    if is_symlink(&file) {
        let _ = fs::remove_file(&tmp);
        return Err("Couldn't save the mirror.".into());
    }
    fs::rename(&tmp, &file).map_err(|_| "Couldn't save the mirror.".to_string())
}

fn remove_dev_target(home: &Path) -> Result<(), String> {
    let file = dev_target(home);
    if !file.exists() && !is_symlink(&file) {
        return Ok(());
    }
    if climbs(&file) || has_claude_dir(&file) || is_symlink(&file) {
        return Err("Couldn't remove the mirror.".into());
    }
    let config = dev_config(home);
    let root =
        crate::fs::canonical(&config).map_err(|_| "Couldn't remove the mirror.".to_string())?;
    let parent = crate::fs::canonical(file.parent().unwrap_or(Path::new(".")))
        .map_err(|_| "Couldn't remove the mirror.".to_string())?;
    if parent != root {
        return Err("Couldn't remove the mirror.".into());
    }
    fs::remove_file(&file).map_err(|_| "Couldn't remove the mirror.".to_string())
}

#[derive(Clone, Copy)]
enum RunError {
    Start,
    Timeout,
}

impl RunError {
    fn message(self) -> &'static str {
        match self {
            RunError::Start => "Couldn't run claude.",
            RunError::Timeout => "The install didn't finish.",
        }
    }
}

trait Runner {
    fn run(&self, program: &str, args: &[String], env: &[(String, String)])
        -> Result<(), RunError>;
}

struct ClaudeRunner;

impl Runner for ClaudeRunner {
    fn run(
        &self,
        program: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<(), RunError> {
        if program != "claude" {
            return Err(RunError::Start);
        }
        let mut cmd = std::process::Command::new(program);
        cmd.env_clear();
        for (key, value) in env {
            if ENV_ALLOW.contains(&key.as_str()) || (key == "CLAUDE_CONFIG_DIR") {
                cmd.env(key, value);
            }
        }
        cmd.args(args);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        let mut child = cmd.spawn().map_err(|_| RunError::Start)?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(_)) => return Err(RunError::Start),
                Ok(None) if started.elapsed() > Duration::from_secs(30) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RunError::Timeout);
                }
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => return Err(RunError::Start),
            }
        }
    }
}

struct SetOutcome {
    setting: Setting,
    stale: bool,
    retry: bool,
    note: Option<String>,
}

fn plugin_ready(dir: &Path) -> bool {
    dir.join("hooks").join("hooks.json").is_file()
}

fn source_plugin_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/hivra-mirror")
}

/// A shipped app keeps the plugin next to its resources. The source tree is only the dev fallback.
fn bundle_plugin_dirs(exe: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(folder) = exe.parent() {
        if let Some(contents) = folder.parent() {
            dirs.push(contents.join("Resources").join(PLUGIN_NAME));
        }
        dirs.push(folder.join(PLUGIN_NAME));
        dirs.push(folder.join("resources").join(PLUGIN_NAME));
    }
    dirs
}

fn pick_plugin_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|dir| plugin_ready(dir)).cloned()
}

fn resolved_plugin_dir() -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(dir) = std::env::var("HIVRA_MIRROR_PLUGIN") {
        if !dir.is_empty() {
            candidates.push(PathBuf::from(dir));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        candidates.extend(bundle_plugin_dirs(&exe));
    }
    candidates.push(source_plugin_dir());
    pick_plugin_dir(&candidates).unwrap_or_else(source_plugin_dir)
}

#[allow(clippy::too_many_arguments)]
fn apply_set(
    dir: &Path,
    kind: Kind,
    home: &Path,
    data_dir: &Path,
    enabled: bool,
    expected: u64,
    plugin_dir: &Path,
    inherited: &[(String, String)],
    runner: &dyn Runner,
) -> SetOutcome {
    let _guard = gate();
    let current = read_setting(dir);
    if expected != current.version {
        return SetOutcome {
            setting: current,
            stale: true,
            retry: true,
            note: None,
        };
    }
    let previous = current.clone();
    let env = command_env(kind, home, inherited);
    let finish = |next: Setting, ran_install: bool| -> SetOutcome {
        if ran_install && kind == Kind::Dev {
            if let Err(error) = write_dev_target(home, data_dir) {
                return SetOutcome {
                    setting: previous.clone(),
                    stale: false,
                    retry: true,
                    note: Some(error),
                };
            }
        }
        if !enabled && kind == Kind::Dev {
            if let Err(error) = remove_dev_target(home) {
                return SetOutcome {
                    setting: previous.clone(),
                    stale: false,
                    retry: true,
                    note: Some(error),
                };
            }
        }
        match write_setting(dir, &next) {
            Ok(()) => SetOutcome {
                setting: next,
                stale: false,
                retry: false,
                note: None,
            },
            Err(error) => SetOutcome {
                setting: previous.clone(),
                stale: false,
                retry: true,
                note: Some(error),
            },
        }
    };
    if enabled && current.enabled && current.installed {
        return SetOutcome {
            setting: current,
            stale: false,
            retry: false,
            note: None,
        };
    }
    if !enabled && !current.enabled && !current.installed {
        return SetOutcome {
            setting: current,
            stale: false,
            retry: false,
            note: None,
        };
    }
    if enabled && current.installed {
        return finish(
            Setting {
                enabled: true,
                installed: true,
                version: current.version + 1,
            },
            false,
        );
    }
    if !plugin_ready(plugin_dir) {
        return SetOutcome {
            setting: current,
            stale: false,
            retry: true,
            note: Some("The install didn't finish.".into()),
        };
    }
    let args = if enabled {
        vec![
            "plugin".into(),
            "install".into(),
            plugin_dir.to_string_lossy().into_owned(),
        ]
    } else {
        vec!["plugin".into(), "uninstall".into(), PLUGIN_NAME.into()]
    };
    if let Err(error) = runner.run("claude", &args, &env) {
        return SetOutcome {
            setting: current,
            stale: false,
            retry: true,
            note: Some(error.message().into()),
        };
    }
    let next = if enabled {
        Setting {
            enabled: true,
            installed: true,
            version: current.version + 1,
        }
    } else {
        Setting {
            enabled: false,
            installed: false,
            version: current.version + 1,
        }
    };
    finish(next, enabled)
}

fn clean_chars(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .take(max)
        .collect()
}

fn clean_id(value: &str) -> String {
    clean_chars(value, 200).trim().to_string()
}

fn clean_state(value: Option<&str>, default: &str) -> String {
    match value {
        Some(state @ ("running" | "idle" | "waiting" | "stopped")) => state.to_string(),
        _ => default.to_string(),
    }
}

fn clean_block(value: &Value) -> Option<Value> {
    let id = clean_id(value.get("id")?.as_str()?);
    if id.is_empty() {
        return None;
    }
    let role = value.get("role")?.as_str()?;
    if !matches!(role, "user" | "assistant" | "tool" | "approval") {
        return None;
    }
    let text = clean_chars(
        value.get("text").and_then(Value::as_str).unwrap_or(""),
        MAX_TEXT,
    );
    if text.trim().is_empty() {
        return None;
    }
    let mut block = json!({ "id": id, "role": role, "text": text });
    if let Some(tool) = value.get("tool").filter(|tool| tool.is_object()) {
        if tool.to_string().len() <= MAX_TEXT {
            block["tool"] = tool.clone();
        }
    }
    if let Some(approval) = value
        .get("approval")
        .filter(|approval| approval.is_object())
    {
        block["approval"] = approval.clone();
    }
    Some(block)
}

fn session_mut<'a>(book: &'a mut Book, id: &str) -> Option<&'a mut LiveSession> {
    book.sessions.iter_mut().find(|session| session.id == id)
}

fn apply_event(book: &mut Book, event: &Value, now: i64) {
    let kind = event.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind == "gone" {
        let id = clean_id(
            event
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_else(|| event.get("sessionId").and_then(Value::as_str).unwrap_or("")),
        );
        remove_session(book, &id);
        return;
    }
    if kind == "session" {
        let id = clean_id(event.get("id").and_then(Value::as_str).unwrap_or(""));
        if id.is_empty() || book.removed.contains(&id) {
            return;
        }
        let title = {
            let title = clean_chars(
                event.get("title").and_then(Value::as_str).unwrap_or(""),
                200,
            );
            if title.trim().is_empty() {
                "Terminal".into()
            } else {
                title.trim().to_string()
            }
        };
        let folder = clean_chars(
            event.get("folder").and_then(Value::as_str).unwrap_or(""),
            2000,
        )
        .trim()
        .to_string();
        let state = clean_state(event.get("state").and_then(Value::as_str), "running");
        let transcript = event
            .get("transcript")
            .and_then(Value::as_str)
            .map(clean_chars_path)
            .filter(|path| !path.is_empty());
        if let Some(session) = session_mut(book, &id) {
            session.title = title;
            session.folder = folder;
            session.state = state;
            session.updated_at = now;
            if transcript.is_some() {
                session.transcript = transcript;
            }
            return;
        }
        book.sessions.push(LiveSession {
            id,
            title,
            folder,
            state,
            blocks: Vec::new(),
            updated_at: now,
            permission: None,
            transcript,
        });
        return;
    }
    let session_id = clean_id(event.get("sessionId").and_then(Value::as_str).unwrap_or(""));
    if session_id.is_empty() || book.removed.contains(&session_id) {
        return;
    }
    if kind == "status" {
        if let Some(session) = session_mut(book, &session_id) {
            session.state = clean_state(event.get("state").and_then(Value::as_str), "running");
            session.updated_at = now;
        }
        return;
    }
    if kind != "block" {
        return;
    }
    let Some(block) = event.get("block").and_then(clean_block) else {
        return;
    };
    let state = event
        .get("state")
        .and_then(Value::as_str)
        .map(|value| clean_state(Some(value), "running"));
    let permission = event.get("permission").and_then(|value| {
        let request_id = clean_id(value.get("requestId").and_then(Value::as_str).unwrap_or(""));
        if request_id.is_empty() {
            return None;
        }
        let tool = clean_chars(
            value.get("tool").and_then(Value::as_str).unwrap_or("Tool"),
            200,
        );
        Some(json!({ "requestId": request_id, "tool": tool }))
    });
    let block_id = block["id"].as_str().unwrap_or("").to_string();
    if let Some(session) = session_mut(book, &session_id) {
        if let Some(existing) = session
            .blocks
            .iter_mut()
            .find(|item| item["id"].as_str() == Some(block_id.as_str()))
        {
            *existing = block;
        } else {
            session.blocks.push(block);
        }
        if let Some(state) = state {
            session.state = state;
        }
        if permission.is_some() {
            session.state = "waiting".into();
            session.permission = permission;
        }
        session.updated_at = now;
        return;
    }
    book.sessions.push(LiveSession {
        id: session_id,
        title: "Terminal".into(),
        folder: String::new(),
        state: if permission.is_some() {
            "waiting".into()
        } else {
            state.unwrap_or_else(|| "running".into())
        },
        blocks: vec![block],
        updated_at: now,
        permission,
        transcript: None,
    });
}

fn clean_chars_path(value: &str) -> String {
    let cleaned = clean_id(value);
    if cleaned.is_empty()
        || Path::new(&cleaned)
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        String::new()
    } else {
        cleaned
    }
}

fn remove_session(book: &mut Book, id: &str) {
    if id.is_empty() || book.removed.contains(id) {
        return;
    }
    book.removed.insert(id.to_string());
    book.sessions.retain(|session| session.id != id);
    book.steers.remove(id);
}

fn steer_kind(steer: &Value) -> Option<&str> {
    steer.get("kind").and_then(Value::as_str)
}

fn steer_request(steer: &Value) -> &str {
    steer.get("requestId").and_then(Value::as_str).unwrap_or("")
}

fn pop_where(book: &mut Book, id: &str, pred: impl Fn(&Value) -> bool) -> Option<Value> {
    let queue = book.steers.get_mut(id)?;
    let index = queue.iter().position(pred)?;
    let steer = queue.remove(index)?;
    if queue.is_empty() {
        book.steers.remove(id);
    }
    Some(steer)
}

fn stamp(mut steer: Value, id: &str) -> Value {
    if let Some(obj) = steer.as_object_mut() {
        obj.insert("sessionId".into(), json!(id));
    }
    steer
}

/// A permission answer is only for the prompt that asked. An older answer is dropped, not applied to the next one.
fn take_permission(book: &mut Book, id: &str, request_id: &str) -> Option<Value> {
    if id.is_empty() || request_id.is_empty() {
        return None;
    }
    if let Some(queue) = book.steers.get_mut(id) {
        queue.retain(|steer| {
            steer_kind(steer) != Some("permission") || steer_request(steer) == request_id
        });
        if queue.is_empty() {
            book.steers.remove(id);
        }
    }
    pop_where(book, id, |steer| {
        steer_kind(steer) == Some("permission") && steer_request(steer) == request_id
    })
    .map(|steer| stamp(steer, id))
}

fn permission_request_id(event: &Value) -> String {
    event
        .get("permission")
        .and_then(|value| value.get("requestId"))
        .and_then(Value::as_str)
        .map(clean_id)
        .unwrap_or_default()
}

fn handle_line(book: &mut Book, line: &str, now: i64) -> (String, Vec<Value>) {
    if line.len() > MAX_LINE {
        return (ack(&[]), Vec::new());
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return (ack(&[]), Vec::new());
    };
    if value.get("type").and_then(Value::as_str) == Some("wait") {
        let id = clean_id(value.get("sessionId").and_then(Value::as_str).unwrap_or(""));
        let request_id = clean_id(value.get("requestId").and_then(Value::as_str).unwrap_or(""));
        // A wait must not drop a different prompt's answer. The hook is still asking for this one.
        let Some(steer) = pop_where(book, &id, |steer| {
            steer_kind(steer) == Some("permission") && steer_request(steer) == request_id
        }) else {
            return (ack(&[]), Vec::new());
        };
        let steer = stamp(steer, &id);
        return (ack(std::slice::from_ref(&steer)), vec![steer]);
    }
    if value.get("type").and_then(Value::as_str) != Some("events") {
        return (ack(&[]), Vec::new());
    }
    let hook = value
        .get("hook")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let deliver_reply = hook.contains("stop") || hook.contains("userprompt");
    let events = value
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut steers = Vec::new();
    let mut replied = HashSet::new();
    for event in &events {
        let session_id = clean_id(
            event
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| event.get("id").and_then(Value::as_str).unwrap_or("")),
        );
        let wants_permission = event.get("permission").is_some()
            || event.get("kind").and_then(Value::as_str) == Some("block")
                && event
                    .get("block")
                    .and_then(|block| block.get("role"))
                    .and_then(Value::as_str)
                    == Some("approval");
        apply_event(book, event, now);
        if wants_permission {
            if let Some(steer) = take_permission(book, &session_id, &permission_request_id(event)) {
                steers.push(steer);
            }
        }
        if deliver_reply && !session_id.is_empty() && replied.insert(session_id.clone()) {
            if let Some(steer) = pop_where(book, &session_id, |steer| {
                steer_kind(steer) == Some("reply")
            }) {
                steers.push(stamp(steer, &session_id));
            }
        }
    }
    (ack(&steers), steers)
}

fn ack(steers: &[Value]) -> String {
    format!("{}\n", json!({ "ok": true, "steers": steers }))
}

fn restore_steers(book: &mut Book, id: &str, steers: Vec<Value>) {
    let queue = book.steers.entry(id.to_string()).or_default();
    for steer in steers.into_iter().rev() {
        queue.push_front(steer);
    }
}

fn restore_taken(book: &mut Book, steers: Vec<Value>) {
    let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();
    for steer in steers {
        let id = steer
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        if let Some((_, group)) = grouped.iter_mut().find(|(key, _)| key == &id) {
            group.push(steer);
        } else {
            grouped.push((id, vec![steer]));
        }
    }
    for (id, group) in grouped {
        restore_steers(book, &id, group);
    }
}

fn list_value(book: &Book) -> Value {
    Value::Array(
        book.sessions
            .iter()
            .map(|session| {
                json!({
                    "id": session.id,
                    "title": session.title,
                    "folder": session.folder,
                    "state": session.state,
                    "blocks": session.blocks,
                    "updatedAt": session.updated_at,
                    "pendingPermission": session.permission,
                })
            })
            .collect(),
    )
}

fn import_key(home: &Path, transcript: &Path) -> Option<String> {
    if climbs(transcript) {
        return None;
    }
    let root = home.join(".claude").join("projects");
    let rel = transcript.strip_prefix(&root).ok()?;
    if rel.as_os_str().is_empty()
        || rel
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let text = crate::fs::path_to_js(rel);
    if text.is_empty() || text.split('/').any(|part| part == ".." || part.is_empty()) {
        return None;
    }
    Some(format!("claude_code:{text}"))
}

/// Marks the transcript so a later history import skips it. A miss is not a failure of the mirror.
pub(crate) fn mark_imported(
    history_dir: &Path,
    home: &Path,
    transcript: &Path,
) -> Result<(), String> {
    let Some(key) = import_key(home, transcript) else {
        return Ok(());
    };
    for _ in 0..5 {
        let loaded = crate::history_import::load_state(history_dir)?;
        let mut state = loaded.state;
        let already = state
            .get("entries")
            .and_then(|entries| entries.get(&key))
            .and_then(|entry| entry.get("status"))
            .and_then(Value::as_str)
            == Some("submitted");
        if already {
            return Ok(());
        }
        match state.get_mut("entries").and_then(Value::as_object_mut) {
            Some(entries) => {
                entries.insert(
                    key.clone(),
                    json!({ "status": "submitted", "timestamp": 0, "error": null }),
                );
            }
            None => {
                state = json!({ "entries": { key.clone(): { "status": "submitted", "timestamp": 0, "error": null } } });
            }
        }
        if crate::history_import::cas_state(history_dir, loaded.revision, state)? {
            return Ok(());
        }
    }
    Err("Couldn't mark the chat.".into())
}

fn queue_steer(book: &mut Book, id: &str, steer: Value) -> Result<(), String> {
    if id.is_empty()
        || book.removed.contains(id)
        || !book.sessions.iter().any(|session| session.id == id)
    {
        return Err("That session is gone.".into());
    }
    let queue = book.steers.entry(id.to_string()).or_default();
    if queue.len() >= 20 {
        return Err("That didn't go through. Try again.".into());
    }
    queue.push_back(steer);
    Ok(())
}

fn attach_task(
    conn: &rusqlite::Connection,
    book: &Book,
    session_id: &str,
    task_id: &str,
    now: i64,
) -> Result<Vec<String>, String> {
    let task_id = task_id.trim().to_string();
    if task_id.is_empty() || book.removed.contains(session_id) {
        return Err("That task isn't there.".into());
    }
    let Some(session) = book
        .sessions
        .iter()
        .find(|session| session.id == session_id)
    else {
        return Err("That session is gone.".into());
    };
    let trashed: Option<i64> = match conn.query_row(
        "SELECT trashed_at FROM tasks WHERE id = ?1",
        [task_id.as_str()],
        |row| row.get(0),
    ) {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Err("That task isn't there.".into()),
        Err(error) => return Err(error.to_string()),
    };
    if trashed.is_some() {
        return Err("That task isn't there.".into());
    }
    let activity_id = format!("mirror-{task_id}-{session_id}");
    let text = format!("Terminal session {} ({})", session.title, session.folder);
    conn.execute(
        "INSERT OR IGNORE INTO task_activity (id, task_id, at, kind, text, delegation_id) VALUES (?1, ?2, ?3, 'terminal', ?4, NULL)",
        rusqlite::params![activity_id, task_id, now, text],
    )
    .map_err(|error| error.to_string())?;
    Ok(vec![task_id])
}

fn setting_value(outcome: &SetOutcome) -> Value {
    json!({
        "enabled": outcome.setting.enabled,
        "installed": outcome.setting.installed,
        "version": outcome.setting.version,
        "stale": outcome.stale,
        "retry": outcome.retry,
        "note": outcome.note,
        "preview": [
            "Plugin hivra-mirror",
            "Hooks: SessionStart, UserPromptSubmit, PostToolUse, PermissionRequest, Stop",
            "Connects only to this Hivra on this Mac",
            "No login and no token",
            "Stays off in sessions Hivra started",
        ],
    })
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("terminal-mirror://changed", json!({}));
}

pub fn init(app: AppHandle, data_dir: PathBuf, kind: Kind) {
    {
        let mut book = lock_book();
        if book.revision == 0
            && book.sessions.is_empty()
            && book.steers.is_empty()
            && book.removed.is_empty()
        {
            if let Ok(loaded) = open_book(&data_dir) {
                *book = loaded;
            }
        }
    }
    let home = home_dir();
    if let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) {
        if let Ok(addr) = listener.local_addr() {
            let _ = publish_mirror(&data_dir.join(instance::RUNNING_FILE), addr.port());
        }
        let _ = listener.set_nonblocking(true);
        let app_thread = app.clone();
        let data_thread = data_dir.clone();
        let home_thread = home.clone();
        let _ = thread::Builder::new()
            .name("terminal-mirror".into())
            .spawn(move || {
                serve(listener, app_thread, data_thread, home_thread);
            });
    }
    if let Ok(mut slot) = host_slot().lock() {
        *slot = Some(Host {
            data_dir,
            kind,
            home,
            app,
        });
    }
}

fn serve(listener: TcpListener, app: AppHandle, data_dir: PathBuf, home: PathBuf) {
    loop {
        match listener.accept() {
            Ok((stream, addr)) => {
                if !is_loopback(addr.ip()) {
                    continue;
                }
                let app = app.clone();
                let data_dir = data_dir.clone();
                let home = home.clone();
                let _ = thread::Builder::new()
                    .name("terminal-mirror-conn".into())
                    .spawn(move || {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            let _ = handle_conn(stream, &app, &data_dir, &home);
                        }));
                    });
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50))
            }
            Err(_) => thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn is_loopback(ip: IpAddr) -> bool {
    ip.is_loopback()
}

fn book_file_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

enum ReadBook {
    Missing,
    Bad,
    Ready(Book),
}

fn book_path(dir: &Path) -> PathBuf {
    dir.join(BOOK_FILE)
}

fn session_json(session: &LiveSession) -> Value {
    json!({
        "id": session.id,
        "title": session.title,
        "folder": session.folder,
        "state": session.state,
        "blocks": session.blocks,
        "updatedAt": session.updated_at,
        "permission": session.permission,
        "transcript": session.transcript,
    })
}

fn steer_json(steers: &HashMap<String, VecDeque<Value>>) -> Value {
    let mut map = serde_json::Map::new();
    for (id, queue) in steers {
        let kept: Vec<&Value> = queue
            .iter()
            .filter(|steer| matches!(steer_kind(steer), Some("reply" | "stop" | "permission")))
            .take(20)
            .collect();
        if !kept.is_empty() {
            map.insert(
                id.clone(),
                Value::Array(kept.into_iter().cloned().collect()),
            );
        }
    }
    Value::Object(map)
}

fn parse_book(text: &str) -> Option<Book> {
    let value: Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    if !obj.get("sessions").map(Value::is_array).unwrap_or(true) {
        return None;
    }
    let mut book = Book {
        revision: obj.get("revision").and_then(Value::as_u64).unwrap_or(0),
        ..Book::default()
    };
    for item in obj
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = clean_id(item.get("id").and_then(Value::as_str).unwrap_or(""));
        if id.is_empty() || book.removed.contains(&id) {
            continue;
        }
        let session = LiveSession {
            id: id.clone(),
            title: {
                let title = clean_chars(item.get("title").and_then(Value::as_str).unwrap_or(""), 200);
                if title.trim().is_empty() {
                    "Terminal".into()
                } else {
                    title.trim().to_string()
                }
            },
            folder: clean_chars(item.get("folder").and_then(Value::as_str).unwrap_or(""), 2000)
                .trim()
                .to_string(),
            state: clean_state(item.get("state").and_then(Value::as_str), "running"),
            blocks: item
                .get("blocks")
                .and_then(Value::as_array)
                .map(|blocks| blocks.iter().filter_map(clean_block).collect())
                .unwrap_or_default(),
            updated_at: item.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
            permission: item.get("permission").and_then(|value| {
                let request_id = clean_id(value.get("requestId").and_then(Value::as_str).unwrap_or(""));
                if request_id.is_empty() {
                    None
                } else {
                    Some(json!({
                        "requestId": request_id,
                        "tool": clean_chars(value.get("tool").and_then(Value::as_str).unwrap_or("Tool"), 200),
                    }))
                }
            }),
            transcript: item
                .get("transcript")
                .and_then(Value::as_str)
                .map(clean_chars_path)
                .filter(|path| !path.is_empty()),
        };
        if let Some(existing) = book.sessions.iter_mut().find(|kept| kept.id == session.id) {
            if session.updated_at >= existing.updated_at {
                *existing = session;
            }
        } else {
            book.sessions.push(session);
        }
    }
    for id in obj
        .get("removed")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = clean_id(id.as_str().unwrap_or(""));
        if !id.is_empty() {
            remove_session(&mut book, &id);
        }
    }
    if let Some(map) = obj.get("steers").and_then(Value::as_object) {
        for (id, queue) in map {
            let id = clean_id(id);
            if id.is_empty() || book.removed.contains(&id) {
                continue;
            }
            let Some(items) = queue.as_array() else {
                continue;
            };
            for steer in items.iter().take(20) {
                if !matches!(steer_kind(steer), Some("reply" | "stop" | "permission")) {
                    continue;
                }
                book.steers
                    .entry(id.clone())
                    .or_default()
                    .push_back(steer.clone());
            }
        }
    }
    Some(book)
}

fn read_book(dir: &Path) -> Result<ReadBook, String> {
    let path = book_path(dir);
    if climbs(&path) {
        return Err("Couldn't read the sessions.".into());
    }
    match fs::symlink_metadata(&path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(ReadBook::Missing),
        Err(_) => return Err("Couldn't read the sessions.".into()),
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("Couldn't read the sessions.".into())
        }
        Ok(_) => {}
    }
    let text = fs::read_to_string(&path).map_err(|_| "Couldn't read the sessions.".to_string())?;
    match parse_book(&text) {
        Some(book) => Ok(ReadBook::Ready(book)),
        None => Ok(ReadBook::Bad),
    }
}

fn quarantine_book(dir: &Path) {
    let path = book_path(dir);
    let bad = dir.join("terminal-mirror-book.json.bad");
    if is_symlink(&path) || is_symlink(&bad) || bad.exists() {
        return;
    }
    let _ = fs::rename(&path, &bad);
}

/// A bad file is set aside and the list starts empty. A symlink is not followed.
fn open_book(dir: &Path) -> Result<Book, String> {
    match read_book(dir)? {
        ReadBook::Ready(book) => Ok(book),
        ReadBook::Missing => Ok(Book::default()),
        ReadBook::Bad => {
            quarantine_book(dir);
            Ok(Book::default())
        }
    }
}

fn write_book_file(dir: &Path, book: &Book, revision: u64) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|_| "Couldn't save the sessions.".to_string())?;
    let path = book_path(dir);
    if is_symlink(&path) || climbs(&path) || is_symlink(dir) {
        return Err("Couldn't save the sessions.".into());
    }
    let stored = json!({
        "revision": revision,
        "sessions": book.sessions.iter().map(session_json).collect::<Vec<_>>(),
        "removed": book.removed.iter().collect::<Vec<_>>(),
        "steers": steer_json(&book.steers),
    });
    let bytes = serde_json::to_vec_pretty(&stored)
        .map_err(|_| "Couldn't save the sessions.".to_string())?;
    let tmp = dir.join("terminal-mirror-book.json.tmp");
    if is_symlink(&tmp) {
        return Err("Couldn't save the sessions.".into());
    }
    fs::write(&tmp, &bytes).map_err(|_| "Couldn't save the sessions.".to_string())?;
    if is_symlink(&path) {
        let _ = fs::remove_file(&tmp);
        return Err("Couldn't save the sessions.".into());
    }
    fs::rename(&tmp, &path).map_err(|_| "Couldn't save the sessions.".to_string())
}

/// Writes only when `book.revision` is still the file's revision. A miss means someone else wrote; try again.
fn save_book(dir: &Path, book: &mut Book) -> Result<bool, String> {
    let _guard = book_file_lock();
    let current = match read_book(dir)? {
        ReadBook::Ready(loaded) => loaded.revision,
        ReadBook::Missing => 0,
        // A corrupt file is set aside. It is not overwritten in place, and it is not treated as the latest revision.
        ReadBook::Bad => {
            quarantine_book(dir);
            0
        }
    };
    if current != book.revision {
        return Ok(false);
    }
    let next = book.revision.saturating_add(1);
    write_book_file(dir, book, next)?;
    book.revision = next;
    Ok(true)
}

fn merge_disk_into(book: &mut Book, extra: &Book) {
    for id in &extra.removed {
        remove_session(book, id);
    }
    for session in &extra.sessions {
        if book.removed.contains(&session.id) {
            continue;
        }
        if let Some(existing) = session_mut(book, &session.id) {
            if session.updated_at > existing.updated_at {
                *existing = session.clone();
            }
        } else {
            book.sessions.push(session.clone());
        }
    }
    for (id, queue) in &extra.steers {
        if book.removed.contains(id) {
            continue;
        }
        let dest = book.steers.entry(id.clone()).or_default();
        for steer in queue {
            if dest.len() >= 20 {
                break;
            }
            if !dest.iter().any(|kept| kept == steer) {
                dest.push_back(steer.clone());
            }
        }
    }
}

fn commit_mirror(
    data_dir: &Path,
    home: &Path,
    history_dir: &Path,
    book: &mut Book,
) -> Result<(), String> {
    for _ in 0..5 {
        match save_book(data_dir, book) {
            Ok(true) => {
                for session in &book.sessions {
                    if let Some(transcript) = &session.transcript {
                        mark_imported(history_dir, home, Path::new(transcript))?;
                    }
                }
                return Ok(());
            }
            Ok(false) => {
                let disk = open_book(data_dir)?;
                let revision = disk.revision;
                merge_disk_into(book, &disk);
                book.revision = revision;
            }
            Err(error) => return Err(error),
        }
    }
    Err("Couldn't save the sessions.".into())
}

/// One session from a second writer. A lost race reloads and tries again, so neither write is dropped.
#[cfg(test)]
fn merge_saved(dir: &Path, extra: &Book) -> Result<(), String> {
    for _ in 0..8 {
        let mut book = open_book(dir)?;
        merge_disk_into(&mut book, extra);
        if save_book(dir, &mut book)? {
            return Ok(());
        }
    }
    Err("Couldn't save the sessions.".into())
}

fn handle_conn(
    mut stream: TcpStream,
    app: &AppHandle,
    data_dir: &Path,
    home: &Path,
) -> Result<(), ()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let Ok(peer) = stream.peer_addr() else {
        return Err(());
    };
    if !is_loopback(peer.ip()) {
        return Err(());
    }
    let Some(line) = read_line(&mut stream) else {
        return Err(());
    };
    let now = crate::session_store::now_millis();
    let kind = serde_json::from_str::<Value>(&line)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let (response, steers) = {
        let mut book = lock_book();
        let (response, steers) = handle_line(&mut book, &line, now);
        // A reply or a session update is kept only after this write. The transcript is marked
        // imported inside that write, so a failed save still leaves the file for history.
        if kind == "events" || !steers.is_empty() {
            let _ = commit_mirror(data_dir, home, &data_dir.join("history-import"), &mut book);
        }
        (response, steers)
    };
    if stream.write_all(response.as_bytes()).is_err() {
        if !steers.is_empty() {
            let mut book = lock_book();
            restore_taken(&mut book, steers);
            let _ = commit_mirror(data_dir, home, &data_dir.join("history-import"), &mut book);
        }
        return Err(());
    }
    if !(kind == "wait" && steers.is_empty()) {
        emit_changed(app);
    }
    Ok(())
}

fn read_line(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= MAX_LINE {
            return None;
        }
        match stream.read(&mut byte) {
            Ok(0) => return None,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => buf.push(byte[0]),
            Err(_) => return None,
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn with_host<T>(f: impl FnOnce(&Host) -> T) -> Result<T, String> {
    let slot = host_slot()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let Some(host) = slot.as_ref() else {
        return Err("That didn't go through. Try again.".into());
    };
    Ok(f(host))
}

#[tauri::command]
pub fn terminal_mirror_status() -> Value {
    let Ok(value) = with_host(|host| {
        let setting = read_setting(&host.data_dir);
        setting_value(&SetOutcome {
            setting,
            stale: false,
            retry: false,
            note: None,
        })
    }) else {
        return setting_value(&SetOutcome {
            setting: Setting::default(),
            stale: false,
            retry: false,
            note: None,
        });
    };
    value
}

#[tauri::command]
pub fn terminal_mirror_set(enabled: bool, expected_version: u64) -> Result<Value, String> {
    with_host(|host| {
        let inherited = inherited_env();
        let outcome = apply_set(
            &host.data_dir,
            host.kind,
            &host.home,
            &host.data_dir,
            enabled,
            expected_version,
            &resolved_plugin_dir(),
            &inherited,
            &ClaudeRunner,
        );
        if outcome.stale {
            return Ok(setting_value(&outcome));
        }
        if outcome.retry {
            return Err(outcome
                .note
                .unwrap_or_else(|| "That didn't go through. Try again.".into()));
        }
        emit_changed(&host.app);
        Ok(setting_value(&outcome))
    })?
}

fn inherited_env() -> Vec<(String, String)> {
    ENV_ALLOW
        .iter()
        .filter_map(|key| {
            let value = std::env::var(key).ok()?;
            Some(((*key).to_string(), value))
        })
        .collect()
}

#[tauri::command]
pub fn terminal_mirror_list() -> Value {
    list_value(&lock_book())
}

#[tauri::command]
pub fn terminal_mirror_steer(
    id: String,
    action: String,
    text: Option<String>,
    allow: Option<bool>,
    request_id: Option<String>,
) -> Result<(), String> {
    let id = clean_id(&id);
    let steer = match action.as_str() {
        "reply" => {
            let text = clean_chars(text.as_deref().unwrap_or(""), MAX_TEXT);
            if text.trim().is_empty() {
                return Err("Write a reply first.".into());
            }
            json!({ "kind": "reply", "text": text })
        }
        "stop" => json!({ "kind": "stop" }),
        "permission" => {
            let request_id = clean_id(request_id.as_deref().unwrap_or(""));
            let Some(allow) = allow else {
                return Err("That didn't go through. Try again.".into());
            };
            if request_id.is_empty() {
                return Err("That prompt is gone.".into());
            }
            json!({ "kind": "permission", "requestId": request_id, "allow": allow })
        }
        _ => return Err("That didn't go through. Try again.".into()),
    };
    {
        let mut book = lock_book();
        queue_steer(&mut book, &id, steer)?;
    }
    if let Ok(slot) = host_slot().lock() {
        if let Some(host) = slot.as_ref() {
            emit_changed(&host.app);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_mirror_attach(
    app: AppHandle,
    store: State<'_, SessionStore>,
    session_id: String,
    task_id: String,
) -> Result<(), String> {
    let session_id = clean_id(&session_id);
    let conn = store.lock_conn()?;
    let book = lock_book();
    let changed = attach_task(
        &conn,
        &book,
        &session_id,
        &task_id,
        crate::session_store::now_millis(),
    )?;
    drop(book);
    drop(conn);
    let _ = app.emit(crate::tasks::store::CHANGED, json!({ "ids": changed }));
    if let Ok(slot) = host_slot().lock() {
        if let Some(host) = slot.as_ref() {
            emit_changed(&host.app);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn scratch(name: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hivra-mirror-{}-{}-{}",
            name,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Rec {
        runs: AtomicUsize,
        env: Mutex<Vec<(String, String)>>,
        args: Mutex<Vec<String>>,
        fail: Mutex<Option<RunError>>,
    }

    impl Rec {
        fn ok() -> Self {
            Self {
                runs: AtomicUsize::new(0),
                env: Mutex::new(Vec::new()),
                args: Mutex::new(Vec::new()),
                fail: Mutex::new(None),
            }
        }
    }

    impl Runner for Rec {
        fn run(
            &self,
            program: &str,
            args: &[String],
            env: &[(String, String)],
        ) -> Result<(), RunError> {
            assert_eq!(program, "claude");
            self.runs.fetch_add(1, Ordering::SeqCst);
            *self.env.lock().unwrap() = env.to_vec();
            *self.args.lock().unwrap() = args.to_vec();
            thread::sleep(Duration::from_millis(40));
            match *self.fail.lock().unwrap() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
    }

    fn plugin(dir: &Path) {
        fs::create_dir_all(dir.join("hooks")).unwrap();
        fs::write(dir.join("hooks").join("hooks.json"), "{}").unwrap();
    }

    #[test]
    fn off_by_default_and_a_bad_file_stays_off() {
        let dir = scratch("off");
        assert_eq!(read_setting(&dir), Setting::default());
        fs::write(dir.join(SETTING_FILE), "not json").unwrap();
        assert_eq!(read_setting(&dir), Setting::default());
        fs::write(dir.join(SETTING_FILE), "[]").unwrap();
        assert_eq!(read_setting(&dir), Setting::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_runs_once_and_a_stale_version_does_not_run_it() {
        let dir = scratch("once");
        let home = scratch("once-home");
        let plugin_dir = scratch("once-plugin");
        plugin(&plugin_dir);
        let runner = Rec::ok();
        let first = apply_set(
            &dir,
            Kind::Daily,
            &home,
            &dir,
            true,
            0,
            &plugin_dir,
            &[
                ("PATH".into(), "/usr/bin".into()),
                ("ANTHROPIC_API_KEY".into(), "sk-ant-secret".into()),
            ],
            &runner,
        );
        assert!(!first.retry);
        assert!(first.setting.enabled && first.setting.installed);
        assert_eq!(runner.runs.load(Ordering::SeqCst), 1);
        assert_eq!(
            runner.args.lock().unwrap().as_slice(),
            ["plugin", "install", plugin_dir.to_string_lossy().as_ref()]
        );
        assert!(runner
            .env
            .lock()
            .unwrap()
            .iter()
            .all(|(key, _)| key != "ANTHROPIC_API_KEY"));
        assert!(runner
            .env
            .lock()
            .unwrap()
            .iter()
            .all(|(key, _)| key != "CLAUDE_CONFIG_DIR"));
        let second = apply_set(
            &dir,
            Kind::Daily,
            &home,
            &dir,
            true,
            first.setting.version,
            &plugin_dir,
            &[],
            &runner,
        );
        assert!(second.note.is_none());
        assert_eq!(runner.runs.load(Ordering::SeqCst), 1);
        let stale = apply_set(
            &dir,
            Kind::Daily,
            &home,
            &dir,
            false,
            0,
            &plugin_dir,
            &[],
            &runner,
        );
        assert!(stale.stale);
        assert_eq!(runner.runs.load(Ordering::SeqCst), 1);
        assert!(stale.setting.enabled);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&plugin_dir);
    }

    #[test]
    fn two_threads_install_once() {
        let dir = scratch("threads");
        let home = scratch("threads-home");
        let plugin_dir = scratch("threads-plugin");
        plugin(&plugin_dir);
        let runner = Arc::new(Rec::ok());
        let mut handles = Vec::new();
        for _ in 0..2 {
            let runner = Arc::clone(&runner);
            let dir = dir.clone();
            let home = home.clone();
            let plugin_dir = plugin_dir.clone();
            handles.push(thread::spawn(move || {
                apply_set(
                    &dir,
                    Kind::Daily,
                    &home,
                    &dir,
                    true,
                    0,
                    &plugin_dir,
                    &[],
                    runner.as_ref(),
                )
            }));
        }
        let outcomes: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(runner.runs.load(Ordering::SeqCst), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| outcome.setting.installed)
                .count(),
            2
        );
        assert!(outcomes
            .iter()
            .any(|outcome| outcome.stale || outcome.setting.version == 1));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&plugin_dir);
    }

    #[test]
    fn a_failed_install_can_be_tried_again() {
        let dir = scratch("fail");
        let home = scratch("fail-home");
        let plugin_dir = scratch("fail-plugin");
        plugin(&plugin_dir);
        let runner = Rec::ok();
        *runner.fail.lock().unwrap() = Some(RunError::Timeout);
        let failed = apply_set(
            &dir,
            Kind::Daily,
            &home,
            &dir,
            true,
            0,
            &plugin_dir,
            &[],
            &runner,
        );
        assert!(failed.retry);
        assert_eq!(failed.note.as_deref(), Some("The install didn't finish."));
        assert_eq!(failed.setting, Setting::default());
        *runner.fail.lock().unwrap() = Some(RunError::Start);
        let again = apply_set(
            &dir,
            Kind::Daily,
            &home,
            &dir,
            true,
            0,
            &plugin_dir,
            &[],
            &runner,
        );
        assert_eq!(again.note.as_deref(), Some("Couldn't run claude."));
        assert!(!again.setting.enabled);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&plugin_dir);
    }

    #[test]
    fn a_dev_copy_never_points_at_the_person_claude_config() {
        let dir = scratch("dev");
        let home = scratch("dev-home");
        let plugin_dir = scratch("dev-plugin");
        plugin(&plugin_dir);
        let runner = Rec::ok();
        let outcome = apply_set(
            &dir,
            Kind::Dev,
            &home,
            &dir,
            true,
            0,
            &plugin_dir,
            &[
                ("PATH".into(), "/bin".into()),
                ("ANTHROPIC_API_KEY".into(), "secret".into()),
            ],
            &runner,
        );
        assert!(outcome.setting.enabled, "{:?}", outcome.note);
        let env = runner.env.lock().unwrap().clone();
        let config = env
            .iter()
            .find(|(key, _)| key == "CLAUDE_CONFIG_DIR")
            .map(|(_, value)| value.clone());
        let config = config.expect("dev config");
        assert_eq!(
            PathBuf::from(&config),
            home.join(instance::DEV_CLAUDE_CONFIG)
        );
        assert!(!has_claude_dir(Path::new(&config)));
        assert!(!config.contains("settings.json"));
        assert!(env.iter().all(|(key, _)| key != "ANTHROPIC_API_KEY"));
        assert!(dev_target(&home).is_file());
        assert!(!home.join(".claude").exists());
        let off = apply_set(
            &dir,
            Kind::Dev,
            &home,
            &dir,
            false,
            outcome.setting.version,
            &plugin_dir,
            &[],
            &runner,
        );
        assert!(!off.setting.enabled, "{:?}", off.note);
        assert!(!dev_target(&home).exists());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&plugin_dir);
    }

    #[test]
    fn publish_keeps_the_running_file_and_refuses_a_missing_one() {
        let dir = scratch("port");
        let path = dir.join("running.json");
        assert!(publish_mirror(&path, 9).is_ok());
        assert!(!path.exists());
        fs::write(&path, r#"{"pid":4,"kind":"dev","slot":"wp-85"}"#).unwrap();
        publish_mirror(&path, 4311).unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["pid"], 4);
        assert_eq!(value["slot"], "wp-85");
        assert_eq!(value["mirrorPort"], 4311);
        assert_eq!(value["mirrorHost"], "127.0.0.1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn publish_refuses_a_symlink() {
        use std::os::unix::fs::symlink;
        let dir = scratch("link");
        let real = dir.join("real.json");
        fs::write(&real, r#"{"pid":1}"#).unwrap();
        let link = dir.join("running.json");
        symlink(&real, &link).unwrap();
        assert!(publish_mirror(&link, 9).is_err());
        let value: Value = serde_json::from_str(&fs::read_to_string(&real).unwrap()).unwrap();
        assert!(value.get("mirrorPort").is_none());
        let home = scratch("link-home");
        let outside = scratch("link-out");
        fs::create_dir_all(home.join(".monocode-hub-dev")).unwrap();
        symlink(&outside, home.join(instance::DEV_CLAUDE_CONFIG)).unwrap();
        assert!(write_dev_target(&home, &home).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn events_update_drop_and_ignore_what_they_should() {
        let mut book = Book::default();
        apply_event(
            &mut book,
            &json!({"kind":"session","id":"s","folder":"/work/nöte","title":"Notes","state":"nope"}),
            1,
        );
        assert_eq!(book.sessions[0].state, "running");
        apply_event(
            &mut book,
            &json!({"kind":"block","sessionId":"s","block":{"id":"nul","role":"assistant","text":"a\u{0}b"}}),
            2,
        );
        assert_eq!(book.sessions[0].blocks[0]["text"], "ab");
        apply_event(
            &mut book,
            &json!({"kind":"block","sessionId":"s","block":{"id":"b","role":"assistant","text":"one\u{0}"}}),
            2,
        );
        apply_event(
            &mut book,
            &json!({"kind":"block","sessionId":"s","block":{"id":"b","role":"assistant","text":"two"}}),
            3,
        );
        assert_eq!(book.sessions[0].blocks.len(), 2);
        assert_eq!(book.sessions[0].blocks[1]["text"], "two");
        apply_event(
            &mut book,
            &json!({"kind":"block","sessionId":"s","block":{"id":"empty","role":"user","text":"  "}}),
            4,
        );
        apply_event(
            &mut book,
            &json!({"kind":"block","sessionId":"s","block":{"id":"bad","role":"nope","text":"x"}}),
            4,
        );
        assert_eq!(book.sessions[0].blocks.len(), 2);
        remove_session(&mut book, "s");
        apply_event(
            &mut book,
            &json!({"kind":"block","sessionId":"s","block":{"id":"late","role":"user","text":"too late"}}),
            5,
        );
        assert!(book.sessions.is_empty());
        let (line, _) = handle_line(&mut book, "not json", 6);
        assert!(line.contains("\"ok\":true"));
        assert!(book.sessions.is_empty());
        apply_event(
            &mut book,
            &json!({"kind":"session","id":"p","folder":"/work","title":"Ask"}),
            7,
        );
        queue_steer(&mut book, "p", json!({"kind":"reply","text":"later"})).unwrap();
        queue_steer(
            &mut book,
            "p",
            json!({"kind":"permission","requestId":"ask-1","allow":true}),
        )
        .unwrap();
        let (line, taken) = handle_line(
            &mut book,
            &json!({"type":"events","events":[{"kind":"block","sessionId":"p","block":{"id":"ask","role":"approval","text":"Allow Bash?"},"permission":{"requestId":"ask-1","tool":"Bash"}}]}).to_string(),
            8,
        );
        assert!(line.contains("ask-1"));
        assert_eq!(book.steers.get("p").map(|queue| queue.len()), Some(1));
        restore_taken(&mut book, taken);
        assert_eq!(book.steers.get("p").map(|queue| queue.len()), Some(2));
        assert!(book.steers["p"]
            .iter()
            .any(|steer| steer["kind"] == "permission"));
        assert!(book.steers["p"]
            .iter()
            .any(|steer| steer["kind"] == "reply"));
    }

    #[test]
    fn a_permission_answer_matches_its_prompt_and_a_reply_leaves_on_the_next_turn() {
        let mut book = Book::default();
        apply_event(
            &mut book,
            &json!({"kind":"session","id":"p","folder":"/work","title":"Ask"}),
            1,
        );
        queue_steer(&mut book, "p", json!({"kind":"reply","text":"later"})).unwrap();
        queue_steer(
            &mut book,
            "p",
            json!({"kind":"permission","requestId":"ask-1","allow":true}),
        )
        .unwrap();
        queue_steer(
            &mut book,
            "p",
            json!({"kind":"permission","requestId":"ask-2","allow":false}),
        )
        .unwrap();
        let (waiting, _) = handle_line(
            &mut book,
            &json!({"type":"wait","sessionId":"p","requestId":"ask-1"}).to_string(),
            2,
        );
        assert!(
            waiting.contains("ask-1"),
            "the prompt that asked is the one that gets the answer"
        );
        assert!(!waiting.contains("ask-2"));
        let (line, _) = handle_line(
            &mut book,
            &json!({"type":"events","hook":"PermissionRequest","events":[{"kind":"block","sessionId":"p","block":{"id":"ask","role":"approval","text":"Allow Bash?"},"permission":{"requestId":"ask-2","tool":"Bash"}}]}).to_string(),
            3,
        );
        assert!(line.contains("ask-2"));
        assert!(
            !line.contains("ask-1"),
            "a different prompt must not take this answer"
        );
        let (stop_line, taken) = handle_line(
            &mut book,
            &json!({"type":"events","hook":"Stop","events":[{"kind":"status","sessionId":"p","state":"idle"}]}).to_string(),
            4,
        );
        assert!(
            stop_line.contains("later"),
            "a reply queued for the next turn has to leave with that turn"
        );
        assert!(taken.iter().any(|steer| steer["kind"] == "reply"));
        assert!(book
            .steers
            .get("p")
            .map(|queue| queue.is_empty())
            .unwrap_or(true));
    }

    #[test]
    fn attach_is_once_and_a_missing_task_fails() {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let actor = crate::tasks::store::Actor {
            id: "ash".into(),
            project: "proj".into(),
            kind: "person".into(),
        };
        let written = crate::tasks::store::create(
            &mut conn,
            &actor,
            &crate::tasks::store::CreateInput {
                title: "Notes".into(),
                project: Some("proj".into()),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        let mut book = Book::default();
        apply_event(
            &mut book,
            &json!({"kind":"session","id":"s","folder":"/work/my notes","title":"Notes"}),
            1,
        );
        let ids = attach_task(&conn, &book, "s", &written.task.id, 2).unwrap();
        assert_eq!(ids, vec![written.task.id.clone()]);
        attach_task(&conn, &book, "s", &written.task.id, 3).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_activity WHERE task_id = ?1",
                [written.task.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let text: String = conn
            .query_row(
                "SELECT text FROM task_activity WHERE task_id = ?1",
                [written.task.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(text, "Terminal session Notes (/work/my notes)");
        assert!(attach_task(&conn, &book, "s", "missing", 4).is_err());
        remove_session(&mut book, "s");
        assert!(attach_task(&conn, &book, "s", &written.task.id, 5).is_err());
    }

    #[test]
    fn a_marked_transcript_is_skipped_and_a_climb_is_not_used() {
        let home = scratch("mark-home");
        let history = scratch("mark-history");
        let transcript = home
            .join(".claude")
            .join("projects")
            .join("nöte")
            .join("chat.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        fs::write(&transcript, "{}\n").unwrap();
        mark_imported(&history, &home, &transcript).unwrap();
        let loaded = crate::history_import::load_state(&history).unwrap();
        let key = import_key(&home, &transcript).unwrap();
        assert!(key.starts_with("claude_code:"));
        assert_eq!(loaded.state["entries"][&key]["status"], "submitted");
        let other = home
            .join(".claude")
            .join("projects")
            .join("..")
            .join("secret.jsonl");
        mark_imported(&history, &home, &other).unwrap();
        let loaded = crate::history_import::load_state(&history).unwrap();
        let entries = loaded.state["entries"].as_object().unwrap();
        assert_eq!(entries.len(), 1);
        let dev = home
            .join(".monocode-hub-dev")
            .join("claude-config")
            .join("projects")
            .join("chat.jsonl");
        mark_imported(&history, &home, &dev).unwrap();
        assert_eq!(
            crate::history_import::load_state(&history).unwrap().state["entries"]
                .as_object()
                .unwrap()
                .len(),
            1
        );

        let history_a = scratch("mark-a");
        let history_b = history_a.clone();
        let home_a = home.clone();
        let home_b = home.clone();
        let first = transcript.clone();
        let second = home.join(".claude").join("projects").join("other.jsonl");
        fs::write(&second, "{}\n").unwrap();
        thread::scope(|scope| {
            scope.spawn(|| mark_imported(&history_a, &home_a, &first).unwrap());
            scope.spawn(|| mark_imported(&history_b, &home_b, &second).unwrap());
        });
        let loaded = crate::history_import::load_state(&history_a).unwrap();
        let entries = loaded.state["entries"].as_object().unwrap();
        assert!(entries.contains_key(&import_key(&home, &first).unwrap()));
        assert!(entries.contains_key(&import_key(&home, &second).unwrap()));
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&history);
        let _ = fs::remove_dir_all(&history_a);
    }

    fn transcript_file(home: &Path) -> PathBuf {
        let path = home
            .join(".claude")
            .join("projects")
            .join("n")
            .join("c.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{}\n").unwrap();
        let text = path.to_string_lossy().into_owned();
        assert!(
            text.chars().count() <= 200,
            "the transcript path has to fit in the book"
        );
        path
    }

    fn session_book(id: &str, transcript: Option<String>) -> Book {
        let mut book = Book::default();
        apply_event(
            &mut book,
            &json!({"kind":"session","id":id,"folder":"/work","title":"Notes"}),
            1,
        );
        if let Some(path) = transcript {
            book.sessions[0].transcript = Some(path);
        }
        book
    }

    #[test]
    fn a_saved_session_is_still_there_and_a_failed_save_is_not_marked() {
        let dir = scratch("saved");
        let home = scratch("saved-home");
        let history = dir.join("history-import");
        let transcript = transcript_file(&home);
        let mut book = session_book("s", Some(transcript.to_string_lossy().into_owned()));
        commit_mirror(&dir, &home, &history, &mut book).unwrap();
        let loaded = open_book(&dir).unwrap();
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].id, "s");
        assert_eq!(loaded.sessions[0].title, "Notes");
        assert_eq!(loaded.revision, 1);
        let key = import_key(&home, &transcript).unwrap();
        let state = crate::history_import::load_state(&history).unwrap();
        assert_eq!(state.state["entries"][&key]["status"], "submitted");

        let blocked = scratch("blocked");
        let not_dir = blocked.join("file");
        fs::write(&not_dir, "x").unwrap();
        let missed = scratch("blocked-hist");
        let mut again = session_book("s", Some(transcript.to_string_lossy().into_owned()));
        assert!(commit_mirror(&not_dir, &home, &missed, &mut again).is_err());
        let entries = crate::history_import::load_state(&missed).unwrap();
        assert!(entries.state["entries"].as_object().unwrap().is_empty());

        let bad = scratch("bad-book");
        fs::write(book_path(&bad), "nope").unwrap();
        let emptied = open_book(&bad).unwrap();
        assert!(emptied.sessions.is_empty());
        assert!(bad.join("terminal-mirror-book.json.bad").is_file());
        assert!(!book_path(&bad).exists());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&blocked);
        let _ = fs::remove_dir_all(&missed);
        let _ = fs::remove_dir_all(&bad);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_book_is_not_followed() {
        use std::os::unix::fs::symlink;
        let dir = scratch("link-book");
        let real = scratch("link-real");
        fs::write(real.join("secret"), "keep").unwrap();
        symlink(real.join("secret"), book_path(&dir)).unwrap();
        let mut book = session_book("s", None);
        assert!(save_book(&dir, &mut book).is_err());
        assert_eq!(fs::read_to_string(real.join("secret")).unwrap(), "keep");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&real);
    }

    #[test]
    fn two_saves_keep_both_sessions() {
        let dir = scratch("both");
        let mut left = session_book("a", None);
        queue_steer(&mut left, "a", json!({"kind":"reply","text":"later"})).unwrap();
        let right = session_book("b", None);
        thread::scope(|scope| {
            let dir_a = dir.clone();
            let dir_b = dir.clone();
            scope.spawn(move || merge_saved(&dir_a, &left).unwrap());
            scope.spawn(move || merge_saved(&dir_b, &right).unwrap());
        });
        let loaded = open_book(&dir).unwrap();
        let ids: Vec<&str> = loaded
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect();
        assert!(ids.contains(&"a"), "{ids:?}");
        assert!(ids.contains(&"b"), "{ids:?}");
        let queued = loaded.steers.get("a").map(|queue| queue.len()).unwrap_or(0);
        assert_eq!(queued, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_shipped_bundle_is_used_when_the_source_tree_is_gone() {
        let root = scratch("bundle");
        let resources = root.join("Contents").join("Resources").join(PLUGIN_NAME);
        plugin(&resources);
        let exe = root.join("Contents").join("MacOS").join("monocode");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        let missing = root.join("no-such-plugin");
        assert!(pick_plugin_dir(std::slice::from_ref(&missing)).is_none());
        assert_eq!(
            pick_plugin_dir(&[missing, resources.clone()]).as_deref(),
            Some(resources.as_path())
        );
        let env_dir = scratch("env-plugin");
        plugin(&env_dir);
        assert_eq!(
            pick_plugin_dir(&[env_dir.clone(), resources.clone()]).as_deref(),
            Some(env_dir.as_path())
        );
        assert!(bundle_plugin_dirs(&exe).iter().any(|dir| dir == &resources));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&env_dir);
    }
}
