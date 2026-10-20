//! Hub plugin: the one door from the webview to Ash OS.
//!
//! The webview never sees Ash OS's key. This module reads the service's token
//! file in Rust on every call (the service writes a new token each time it
//! starts), sends only `ash-hub-*` actions to 127.0.0.1, and hands the answers
//! back. `hub_events_open` keeps one change feed open (server-sent events) and
//! re-emits each change as a Tauri event, reconnecting with a backoff.
//!
//! Not in this module on purpose: the Mac Keychain commands (a later unit).
//!
//! Dev override (for running against the stub in scripts/hub-stub-server.mjs):
//! `MONOCODE_HUB_PORT` and `MONOCODE_HUB_TOKEN_FILE`. The host is always
//! 127.0.0.1, so a changed variable can never send the key off this Mac.
//!
//! A dev copy (src/instance.rs) never reaches the live Ash OS: its bridge is off unless both variables point at the
//! stub or the read-only proxy (scripts/hub-live-proxy.mjs), and it refuses port 18767 and the live key file.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Runtime};

/// Tauri event for one change from the feed. Payload: `{seq, kind, ref, topics, at, project?}`.
pub const EVENT_CHANGE: &str = "hub:event";
/// Tauri event for the feed's connection state. Payload: `{connected, latest?, reset?, message?}`.
pub const EVENT_STATE: &str = "hub:state";

const DEFAULT_PORT: u16 = 18767;
const TOKEN_SUBPATH: &str = ".local/share/exo-cc-studio/token";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const CALL_TIMEOUT_BASE: Duration = Duration::from_secs(15);
const MAX_BODY: usize = 1_000_000;
const MAX_ANSWER: u64 = 8_000_000;
/// The service pings every 15 s while quiet; silence for this long means the connection is dead.
const FEED_SILENCE: Duration = Duration::from_secs(40);
const FEED_SECONDS: u32 = 300;

/// A failure, in plain words. `kind` lets the screen tell "Ash OS isn't running" from "the call was refused".
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HubError {
    pub kind: &'static str,
    pub message: String,
}

impl HubError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    fn down() -> Self {
        Self::new("unreachable", "Ash OS isn't running.")
    }
}

/// Where Ash OS is and where its key lives.
#[derive(Debug, Clone)]
pub struct Endpoint {
    port: u16,
    token_path: PathBuf,
}

const DEV_OFF: &str = "This dev copy stays off the live Ash OS. To see the hub, start the stub \
     (node scripts/hub-stub-server.mjs) or the read-only proxy (node scripts/hub-live-proxy.mjs) and set \
     MONOCODE_HUB_PORT and MONOCODE_HUB_TOKEN_FILE.";

impl Endpoint {
    pub fn from_env() -> Result<Self, HubError> {
        Self::resolve(
            crate::instance::policy().live_ash_os,
            std::env::var("MONOCODE_HUB_PORT").ok(),
            std::env::var_os("MONOCODE_HUB_TOKEN_FILE").map(PathBuf::from),
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from),
        )
    }

    /// `live`: whether this copy may use the live Ash OS (the daily app). A dev copy needs both overrides, and never
    /// gets the live port or the live key file.
    fn resolve(
        live: bool,
        port: Option<String>,
        token_file: Option<PathBuf>,
        home: Option<PathBuf>,
    ) -> Result<Self, HubError> {
        let port = port
            .map(|raw| {
                raw.trim()
                    .parse::<u16>()
                    .map_err(|_| HubError::new("error", "MONOCODE_HUB_PORT is not a port number."))
            })
            .transpose()?;
        let live_key = home.map(|home| home.join(TOKEN_SUBPATH));
        if !live {
            let (Some(port), Some(token_path)) = (port, token_file) else {
                return Err(HubError::new("unreachable", DEV_OFF));
            };
            if port == DEFAULT_PORT {
                return Err(HubError::new(
                    "refused",
                    "A dev copy never talks to the live Ash OS on port 18767.",
                ));
            }
            if live_key.is_some_and(|key| same_file(&key, &token_path)) {
                return Err(HubError::new(
                    "refused",
                    "A dev copy never reads the live Ash OS key.",
                ));
            }
            return Ok(Self { port, token_path });
        }
        let token_path = match token_file.or(live_key) {
            Some(path) => path,
            None => {
                return Err(HubError::new(
                    "unreachable",
                    "Ash OS isn't set up on this Mac.",
                ))
            }
        };
        Ok(Self {
            port: port.unwrap_or(DEFAULT_PORT),
            token_path,
        })
    }

    #[cfg(test)]
    pub(crate) fn local(port: u16, token_path: PathBuf) -> Self {
        Self { port, token_path }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }

    /// Read on every call: Ash OS writes a new key each time it starts. Never logged, never returned.
    fn token(&self) -> Result<String, HubError> {
        match std::fs::read_to_string(&self.token_path) {
            Ok(raw) if !raw.trim().is_empty() => Ok(raw.trim().to_string()),
            Ok(_) => Err(HubError::down()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(HubError::new(
                "unreachable",
                "Ash OS isn't set up on this Mac.",
            )),
            Err(_) => Err(HubError::new("error", "Couldn't read Ash OS's key file.")),
        }
    }
}

/// Only `ash-hub-<name>` is ever sent: lowercase words joined by dashes.
pub fn check_action(action: &str) -> Result<(), HubError> {
    let rest = action.strip_prefix("ash-hub-").unwrap_or("");
    let tidy = !rest.is_empty()
        && rest.len() <= 56
        && !rest.starts_with('-')
        && !rest.ends_with('-')
        && !rest.contains("--")
        && rest
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if tidy {
        Ok(())
    } else {
        Err(HubError::new(
            "refused",
            "The app may only make ash-hub calls.",
        ))
    }
}

fn agent(read: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(read)
        .timeout_write(Duration::from_secs(10))
        .build()
}

/// How long a call may take: a base, plus the seconds the call itself says it will wait.
fn call_timeout(payload: &Value) -> Duration {
    let wait = ["timeout", "wait"]
        .iter()
        .filter_map(|k| payload.get(*k).and_then(Value::as_f64))
        .fold(0.0_f64, f64::max)
        .clamp(0.0, 30.0);
    CALL_TIMEOUT_BASE + Duration::from_secs_f64(wait)
}

fn transport_error(error: ureq::Transport) -> HubError {
    use std::error::Error as _;
    let timed_out = error
        .source()
        .and_then(|s| s.downcast_ref::<std::io::Error>())
        .map(|e| {
            matches!(
                e.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            )
        })
        .unwrap_or(false);
    if timed_out {
        HubError::new("timeout", "Ash OS took too long to answer.")
    } else {
        HubError::down()
    }
}

fn status_error(code: u16, response: ureq::Response) -> HubError {
    let said = serde_json::from_reader::<_, Value>(response.into_reader().take(64_000))
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string));
    match code {
        401 => HubError::new(
            "unauthorized",
            "Ash OS didn't accept the app's key. Restart Ash OS.",
        ),
        403 => HubError::new(
            "refused",
            said.unwrap_or_else(|| "Ash OS refused the call.".into()),
        ),
        _ => HubError::new(
            "error",
            said.unwrap_or_else(|| format!("Ash OS answered with an error ({code}).")),
        ),
    }
}

/// One call to Ash OS and its `result`. Blocking.
pub fn call_blocking(endpoint: &Endpoint, action: &str, payload: Value) -> Result<Value, HubError> {
    check_action(action)?;
    let payload = match payload {
        Value::Null => json!({}),
        Value::Object(_) => payload,
        _ => return Err(HubError::new("error", "A hub call takes an object.")),
    };
    let body = serde_json::to_vec(&payload)
        .map_err(|_| HubError::new("error", "Couldn't read the call."))?;
    if body.len() > MAX_BODY {
        return Err(HubError::new("error", "That call is too large."));
    }
    let agent = agent(call_timeout(&payload));
    let url = endpoint.url(&format!("/api/{action}"));
    let send = || -> Result<Result<ureq::Response, ureq::Error>, HubError> {
        // Read the key on every try: a key that changed under us (Ash OS restarted) gets one more go, below.
        let token = endpoint.token()?;
        Ok(agent
            .post(&url)
            .set("Authorization", &format!("Bearer {token}"))
            .set("Content-Type", "application/json")
            .send_bytes(&body))
    };
    let mut result = send()?;
    if matches!(result, Err(ureq::Error::Status(401, _))) {
        result = send()?;
    }
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(code, response)) => return Err(status_error(code, response)),
        Err(ureq::Error::Transport(t)) => return Err(transport_error(t)),
    };
    let mut raw = Vec::new();
    response
        .into_reader()
        .take(MAX_ANSWER)
        .read_to_end(&mut raw)
        .map_err(|_| HubError::new("error", "Ash OS's answer was cut short."))?;
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|_| HubError::new("error", "Ash OS gave an answer the app couldn't read."))?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    } else {
        let said = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Ash OS refused the call.");
        Err(HubError::new("error", said))
    }
}

/// Whether Ash OS answers this copy right now: one cheap read. Ship's trial uses it to tell a build that broke the
/// bridge from one that didn't (`ship.rs`).
pub fn probe() -> Result<(), HubError> {
    let endpoint = Endpoint::from_env()?;
    call_blocking(&endpoint, "ash-hub-projects", json!({})).map(|_| ())
}

// ---- the change feed -----------------------------------------------------------------------------------------------

/// What the feed said, ready to emit.
#[derive(Debug, Clone, PartialEq)]
pub enum FeedMsg {
    State(Value),
    Change(Value),
}

/// Reads server-sent events line by line: `id:`, `event:` and `data:` fields, a blank line ends one event.
#[derive(Default)]
pub struct SseParser {
    event: String,
    data: String,
}

impl SseParser {
    /// Feed one line (without its newline). Returns `(event name, data)` when a blank line completes an event.
    pub fn line(&mut self, line: &str) -> Option<(String, String)> {
        if line.is_empty() {
            let name = std::mem::take(&mut self.event);
            let data = std::mem::take(&mut self.data);
            return if name.is_empty() && data.is_empty() {
                None
            } else {
                Some((name, data))
            };
        }
        if line.starts_with(':') {
            return None; // a ping
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event = value.to_string(),
            "data" => {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(value);
            }
            _ => {}
        }
        None
    }
}

/// 1 s, 2 s, 4 s, 8 s, then every 15 s.
pub fn backoff(attempt: u32) -> Duration {
    let secs = 1u64 << attempt.saturating_sub(1).min(4);
    Duration::from_secs(secs.min(15))
}

/// Open the feed once and pass what it says on until it ends or `keep_going` says stop. `cursor` follows the last
/// event seen, so a reconnect picks up where this left off.
pub fn stream_once(
    endpoint: &Endpoint,
    cursor: &mut u64,
    keep_going: &dyn Fn() -> bool,
    on_msg: &mut dyn FnMut(FeedMsg),
    max_seconds: u32,
) -> Result<(), HubError> {
    let token = endpoint.token()?;
    let url = endpoint.url(&format!(
        "/api/ash-hub-events?after={}&stream=1&max_seconds={}",
        cursor, max_seconds
    ));
    let response = match agent(FEED_SILENCE)
        .get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "text/event-stream")
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::Status(code, response)) => return Err(status_error(code, response)),
        Err(ureq::Error::Transport(t)) => return Err(transport_error(t)),
    };
    let mut parser = SseParser::default();
    let mut lines = BufReader::new(response.into_reader()).lines();
    while keep_going() {
        let line = match lines.next() {
            Some(Ok(line)) => line,
            Some(Err(_)) => return Err(HubError::new("timeout", "The live feed went quiet.")),
            None => return Ok(()), // the service ended the stream (its time limit): reconnect
        };
        let Some((name, data)) = parser.line(line.trim_end_matches('\r')) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        match name.as_str() {
            "hello" => {
                let latest = value
                    .get("latest")
                    .and_then(Value::as_u64)
                    .unwrap_or(*cursor);
                let reset = value.get("reset").and_then(Value::as_bool).unwrap_or(false);
                if reset {
                    *cursor = latest;
                }
                on_msg(FeedMsg::State(
                    json!({ "connected": true, "latest": latest, "reset": reset }),
                ));
            }
            "hub" => {
                if let Some(seq) = value.get("seq").and_then(Value::as_u64) {
                    *cursor = (*cursor).max(seq);
                }
                on_msg(FeedMsg::Change(value));
            }
            _ => {}
        }
    }
    Ok(())
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// One feed for the whole app, however many windows ask for it. Events go out to every window, so a second window
/// shares the running feed instead of replacing it, and the feed stops when the last one has closed.
#[derive(Default)]
struct Feed {
    openers: usize,
    last_state: Option<Value>,
}

static FEED: Mutex<Feed> = Mutex::new(Feed {
    openers: 0,
    last_state: None,
});

impl Feed {
    /// Someone opened the feed. True when it has to be started (nobody had it open).
    fn open(&mut self) -> bool {
        self.openers += 1;
        self.openers == 1
    }
    /// Someone closed the feed. True when it has to be stopped (nobody has it open any more).
    fn close(&mut self) -> bool {
        if self.openers == 0 {
            return false;
        }
        self.openers -= 1;
        if self.openers == 0 {
            self.last_state = None;
            return true;
        }
        false
    }
}

fn feed() -> std::sync::MutexGuard<'static, Feed> {
    FEED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn pause(total: Duration, still_current: &dyn Fn() -> bool) {
    let mut left = total;
    let step = Duration::from_millis(200);
    while left > Duration::ZERO && still_current() {
        let now = left.min(step);
        std::thread::sleep(now);
        left -= now;
    }
}

/// Run the feed until `still_current` says another open or a close replaced it.
fn run_feed(
    endpoint: Endpoint,
    mut cursor: u64,
    still_current: &dyn Fn() -> bool,
    on_msg: &mut dyn FnMut(FeedMsg),
) {
    let mut attempt: u32 = 0;
    while still_current() {
        let mut connected = false;
        let result = stream_once(
            &endpoint,
            &mut cursor,
            still_current,
            &mut |msg| {
                if matches!(msg, FeedMsg::State(_)) {
                    connected = true;
                }
                on_msg(msg);
            },
            FEED_SECONDS,
        );
        if !still_current() {
            return;
        }
        if connected {
            attempt = 0;
        }
        match result {
            Ok(()) => pause(Duration::from_millis(250), still_current),
            Err(error) => {
                attempt += 1;
                on_msg(FeedMsg::State(
                    json!({ "connected": false, "message": error.message, "kind": error.kind }),
                ));
                pause(backoff(attempt), still_current);
            }
        }
    }
}

// ---- commands ------------------------------------------------------------------------------------------------------

/// `hub_call(action, payload)`: one `ash-hub-*` call; the answer's `result`.
#[tauri::command]
async fn hub_call(action: String, payload: Option<Value>) -> Result<Value, HubError> {
    let endpoint = Endpoint::from_env()?;
    tauri::async_runtime::spawn_blocking(move || {
        call_blocking(&endpoint, &action, payload.unwrap_or(Value::Null))
    })
    .await
    .map_err(|_| HubError::new("error", "The call was interrupted."))?
}

/// `hub_events_open(after)`: start the live feed (or join the one already running). Changes arrive as `hub:event`, the
/// connection as `hub:state`.
#[tauri::command]
fn hub_events_open<R: Runtime>(app: AppHandle<R>, after: Option<u64>) -> Result<(), HubError> {
    let endpoint = Endpoint::from_env()?;
    let start = feed().open();
    if !start {
        // The feed is already running for another window: tell this one how it stands.
        if let Some(last) = feed().last_state.clone() {
            let _ = app.emit(EVENT_STATE, last);
        }
        return Ok(());
    }
    let mine = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let spawned = std::thread::Builder::new()
        .name("hub-feed".into())
        .spawn(move || {
            let current = move || GENERATION.load(Ordering::SeqCst) == mine;
            let mut emit = |msg: FeedMsg| {
                if !current() {
                    return;
                }
                let _ = match msg {
                    FeedMsg::State(v) => {
                        feed().last_state = Some(v.clone());
                        app.emit(EVENT_STATE, v)
                    }
                    FeedMsg::Change(v) => app.emit(EVENT_CHANGE, v),
                };
            };
            run_feed(endpoint, after.unwrap_or(0), &current, &mut emit);
        });
    if spawned.is_err() {
        feed().close();
        return Err(HubError::new("error", "Couldn't start the live feed."));
    }
    Ok(())
}

/// `hub_events_close()`: this window no longer needs the feed; it stops when no window does.
#[tauri::command]
fn hub_events_close() {
    if feed().close() {
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
}

/// The `ash-os` MCP server entry from Claude Code's own user config (`~/.claude.json`, `mcpServers["ash-os"]`): its
/// command, args and env, nothing else from that file. A project Lead's session reuses it with its identity added.
pub fn ash_os_server_from(config: &Value) -> Option<Value> {
    let entry = config.get("mcpServers")?.get("ash-os")?;
    let command = entry.get("command")?.as_str()?;
    let mut out = json!({ "command": command });
    if let Some(args) = entry.get("args").filter(|a| a.is_array()) {
        out["args"] = args.clone();
    }
    if let Some(env) = entry.get("env").and_then(Value::as_object) {
        // Each value goes in as a reference the child's environment fills (ash_os_child_env), never as itself.
        let env: serde_json::Map<String, Value> = env
            .iter()
            .map(|(key, value)| {
                let value = match ash_os_env_var(key, value) {
                    Some(var) => Value::String(format!("${{{var}}}")),
                    None => value.clone(),
                };
                (key.clone(), value)
            })
            .collect();
        out["env"] = Value::Object(env);
    }
    Some(out)
}

/// Where a hub Claude child keeps one of the ash-os entry's own env values: the entry the webview gets (and puts in
/// that chat's `--mcp-config`, which `ps` shows) says `"${MONOCODE_ASH_OS_<KEY>}"`, and Claude Code fills it from its
/// environment (as it does for the delegate tool's token). A value that is itself a `${...}` reference, or a key that
/// can't be a variable's name, stays as it is.
fn ash_os_env_var(key: &str, value: &Value) -> Option<String> {
    let value = value.as_str()?;
    let name_ok = !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    (name_ok && !value.contains("${")).then(|| format!("MONOCODE_ASH_OS_{key}"))
}

/// The variables a hub Claude child's environment gets for the references `ash_os_server_from` wrote.
pub fn ash_os_child_env(config: &Value) -> Vec<(String, String)> {
    let Some(env) = config
        .get("mcpServers")
        .and_then(|servers| servers.get("ash-os"))
        .and_then(|entry| entry.get("env"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    env.iter()
        .filter_map(|(key, value)| Some((ash_os_env_var(key, value)?, value.as_str()?.to_string())))
        .collect()
}

/// Claude Code's own config (`~/.claude.json`), only where this copy may use Ash's ash-os (never a dev copy).
fn live_claude_config() -> Option<Value> {
    if !crate::instance::policy().live_ash_os {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    let raw = std::fs::read_to_string(PathBuf::from(home).join(".claude.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// For `harness_spawn`: the ash-os values a hub Claude child's environment holds (none in a dev copy).
pub fn live_ash_os_child_env() -> Vec<(String, String)> {
    live_claude_config()
        .map(|config| ash_os_child_env(&config))
        .unwrap_or_default()
}

/// Two spellings of one file: the live key reached through a symlink or `..` is still the live key.
fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// `hub_ash_os_mcp()`: Ash's ash-os MCP entry (its env values as references), or null when Claude Code has none.
/// Always null in a dev copy.
#[tauri::command]
fn hub_ash_os_mcp() -> Option<Value> {
    ash_os_server_from(&live_claude_config()?)
}

/// The plugin. Registered in `lib.rs` with one `.plugin(hub::init())`; its permissions come from `build.rs`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("hub")
        .invoke_handler(tauri::generate_handler![
            hub_call,
            hub_events_open,
            hub_events_close,
            hub_ash_os_mcp,
            crate::hub_keychain::connector_login_store,
            crate::hub_keychain::connector_login_exists,
            crate::hub_keychain::connector_login_delete,
            crate::connectors::commands::connectors_state,
            crate::connectors::commands::connector_save_login,
            crate::connectors::commands::connector_turn_on,
            crate::connectors::commands::connector_save_google_client,
            crate::connectors::commands::connector_forget_google_client,
            crate::connectors::commands::connector_oauth,
            crate::connectors::commands::connector_oauth_cancel,
            crate::connectors::commands::connector_sign_out,
            crate::connectors::commands::connector_test,
            crate::connectors::commands::connector_set_allow,
            crate::connectors::commands::connector_set_mono,
            crate::connectors::commands::connectors_set_composio,
            crate::model_router::model_key_save,
            crate::model_router::model_key_test,
            crate::model_router::model_key_delete,
            crate::model_router::model_context_window
        ])
        // The main window is always shown at a usable size, whatever a later startup step does (launch_guard.rs).
        .on_event(|app, event| match event {
            tauri::RunEvent::Ready => crate::launch_guard::start(app.clone()),
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Focused(true),
                ..
            } => {
                if let Some(window) = tauri::Manager::get_webview_window(app, label) {
                    crate::launch_guard::check(app, &window, "focused");
                }
            }
            _ => {}
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;

    const SECRET: &str = "secret-token-for-tests-only";

    fn token_file(content: &str) -> (tempfile_dir::Dir, PathBuf) {
        let dir = tempfile_dir::Dir::new();
        let path = dir.path().join("token");
        std::fs::write(&path, content).unwrap();
        (dir, path)
    }

    /// A throwaway directory without a new dependency.
    mod tempfile_dir {
        use std::path::{Path, PathBuf};
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!("hub-test-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    /// Reads one request (head and body) and answers it with `reply`; returns the head it saw.
    fn serve_once(reply: impl Into<String>) -> (u16, mpsc::Receiver<String>) {
        let reply: String = reply.into();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let seen = read_request(&mut stream);
            let _ = stream.write_all(reply.as_bytes());
            let _ = tx.send(seen);
        });
        (port, rx)
    }

    fn read_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut seen = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            let n = stream.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            seen.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&seen).to_string();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let want = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if body.len() >= want {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&seen).to_string()
    }

    /// A complete HTTP answer with a JSON body and the right length.
    fn http_json(status: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    fn ok_answer() -> String {
        http_json(
            "200 OK",
            "{\"ok\":true,\"result\":{\"projects\":[],\"a\":1}}",
        )
    }

    #[test]
    fn the_daily_app_uses_the_live_ash_os_unless_told_otherwise() {
        let home = PathBuf::from("/Users/someone");
        let live = Endpoint::resolve(true, None, None, Some(home.clone())).unwrap();
        assert_eq!(live.port, DEFAULT_PORT);
        assert_eq!(live.token_path, home.join(TOKEN_SUBPATH));
        let stub = Endpoint::resolve(
            true,
            Some(" 18868 ".into()),
            Some("/tmp/stub/token".into()),
            Some(home),
        )
        .unwrap();
        assert_eq!(
            (stub.port, stub.token_path),
            (18868, PathBuf::from("/tmp/stub/token"))
        );
        assert_eq!(
            Endpoint::resolve(true, Some("x".into()), None, None)
                .unwrap_err()
                .kind,
            "error"
        );
    }

    #[test]
    fn a_dev_copy_never_reaches_the_live_ash_os() {
        let dir = tempfile_dir::Dir::new();
        let home = dir.path().to_path_buf();
        let live_key = home.join(TOKEN_SUBPATH);
        std::fs::create_dir_all(live_key.parent().unwrap()).unwrap();
        std::fs::write(&live_key, SECRET).unwrap();
        let stub_key = dir.path().join("stub-token");
        std::fs::write(&stub_key, "stub").unwrap();

        // Off by default: no port, no key file, or only one of them.
        for (port, key) in [
            (None, None),
            (Some("18868"), None),
            (None, Some(stub_key.clone())),
        ] {
            let error = Endpoint::resolve(false, port.map(str::to_string), key, Some(home.clone()))
                .expect_err("a dev copy without a stub is off");
            assert_eq!(error.kind, "unreachable");
            assert!(error.message.contains("dev copy"), "{}", error.message);
        }
        // Never the live port, even with a stub key.
        let error = Endpoint::resolve(
            false,
            Some("18767".into()),
            Some(stub_key.clone()),
            Some(home.clone()),
        )
        .err()
        .unwrap();
        assert_eq!(error.kind, "refused");
        // Never the live key, however it is spelled.
        for spelling in [
            live_key.clone(),
            home.join(".local/share/exo-cc-studio/../exo-cc-studio/token"),
        ] {
            let error = Endpoint::resolve(
                false,
                Some("18868".into()),
                Some(spelling),
                Some(home.clone()),
            )
            .err()
            .unwrap();
            assert_eq!(error.kind, "refused");
        }
        // A stub or the read-only proxy on another port, with its own key: allowed.
        let stub = Endpoint::resolve(
            false,
            Some("18868".into()),
            Some(stub_key.clone()),
            Some(home),
        )
        .unwrap();
        assert_eq!((stub.port, stub.token_path), (18868, stub_key));
    }

    #[test]
    fn only_ash_hub_actions_pass() {
        for ok in [
            "ash-hub-projects",
            "ash-hub-needs",
            "ash-hub-mono-project-add",
            "ash-hub-events",
        ] {
            assert!(check_action(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "ash-hub-",
            "ash-hub",
            "ash-answer",
            "ash-hub--x",
            "ash-hub-x-",
            "ash-hub-X",
            "ash-hub-a/b",
            "ash-hub-a b",
            "ash-hub-..",
            "ash-hub-a?b=c",
            "/api/ash-hub-needs",
            "http://evil/ash-hub-needs",
            "ash-hub-\n",
        ] {
            assert!(check_action(bad).is_err(), "{bad:?}");
        }
        assert!(check_action(&format!("ash-hub-{}", "a".repeat(57))).is_err());
    }

    #[test]
    fn a_call_sends_the_key_and_the_right_host_and_returns_the_result() {
        let (_dir, path) = token_file(&format!("{SECRET}\n"));
        let (port, seen) = serve_once(ok_answer());
        let endpoint = Endpoint::local(port, path);
        let result = call_blocking(
            &endpoint,
            "ash-hub-projects",
            json!({ "include_archived": false }),
        )
        .unwrap();
        assert_eq!(result, json!({ "projects": [], "a": 1 }));
        let head = seen.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            head.starts_with("POST /api/ash-hub-projects HTTP/1.1"),
            "{head}"
        );
        assert!(
            head.contains(&format!("Authorization: Bearer {SECRET}")),
            "{head}"
        );
        assert!(
            head.to_ascii_lowercase()
                .contains(&format!("host: 127.0.0.1:{port}")),
            "{head}"
        );
        assert!(!head.to_ascii_lowercase().contains("origin:"), "{head}");
        assert!(head.ends_with("{\"include_archived\":false}"), "{head}");
    }

    #[test]
    fn a_refused_action_never_reaches_the_network() {
        let (_dir, path) = token_file(SECRET);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let endpoint = Endpoint::local(port, path);
        let error = call_blocking(&endpoint, "ash-answer", json!({})).unwrap_err();
        assert_eq!(error.kind, "refused");
        assert!(listener.accept().is_err(), "nothing should have connected");
    }

    #[test]
    fn the_service_saying_no_comes_back_as_its_own_plain_words() {
        let (_dir, path) = token_file(SECRET);
        let (port, _seen) = serve_once(http_json(
            "400 Bad Request",
            "{\"ok\":false,\"error\":\"Nothing here is called that\"}",
        ));
        let error = call_blocking(
            &Endpoint::local(port, path),
            "ash-hub-needs",
            json!({ "project": "x" }),
        )
        .unwrap_err();
        assert_eq!(error, HubError::new("error", "Nothing here is called that"));
    }

    #[test]
    fn a_refused_key_is_unauthorized_and_never_echoes_the_key() {
        let (_dir, path) = token_file(SECRET);
        // two connections: the first call, then the one retry with a freshly read key
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                read_request(&mut stream);
                let _ = stream.write_all(
                    http_json(
                        "401 Unauthorized",
                        "{\"ok\":false,\"error\":\"Studio authorization required\"}",
                    )
                    .as_bytes(),
                );
            }
        });
        let error =
            call_blocking(&Endpoint::local(port, path), "ash-hub-projects", json!({})).unwrap_err();
        assert_eq!(error.kind, "unauthorized");
        assert!(!error.message.contains(SECRET));
    }

    #[test]
    fn the_key_is_read_again_on_every_call() {
        let (_dir, path) = token_file("first-key");
        let (port, seen) = serve_once(ok_answer());
        let endpoint = Endpoint::local(port, path.clone());
        call_blocking(&endpoint, "ash-hub-projects", json!({})).unwrap();
        assert!(seen.recv().unwrap().contains("Bearer first-key"));
        std::fs::write(&path, "second-key").unwrap();
        let (port2, seen2) = serve_once(ok_answer());
        call_blocking(&Endpoint::local(port2, path), "ash-hub-projects", json!({})).unwrap();
        assert!(seen2.recv().unwrap().contains("Bearer second-key"));
    }

    #[test]
    fn nothing_listening_is_ash_os_is_not_running() {
        let (_dir, path) = token_file(SECRET);
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let error =
            call_blocking(&Endpoint::local(port, path), "ash-hub-projects", json!({})).unwrap_err();
        assert_eq!(error, HubError::down());
    }

    #[test]
    fn a_missing_key_file_is_not_set_up_and_a_blank_one_is_not_running() {
        let dir = tempfile_dir::Dir::new();
        let missing = Endpoint::local(1, dir.path().join("nope"));
        assert_eq!(
            call_blocking(&missing, "ash-hub-projects", json!({}))
                .unwrap_err()
                .kind,
            "unreachable"
        );
        let blank = dir.path().join("blank");
        std::fs::write(&blank, "  \n").unwrap();
        assert_eq!(
            call_blocking(&Endpoint::local(1, blank), "ash-hub-projects", json!({}))
                .unwrap_err()
                .kind,
            "unreachable"
        );
    }

    #[test]
    fn a_silent_service_times_out_instead_of_hanging() {
        let (_dir, path) = token_file(SECRET);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_secs(4)); // accepts and never answers
        });
        let endpoint = Endpoint::local(port, path);
        // exercise the same code with a short read timeout
        let started = std::time::Instant::now();
        let url = endpoint.url("/api/ash-hub-projects");
        let result = agent(Duration::from_millis(300))
            .post(&url)
            .send_bytes(b"{}");
        assert!(matches!(result, Err(ureq::Error::Transport(_))));
        let error = match result {
            Err(ureq::Error::Transport(t)) => transport_error(t),
            _ => unreachable!(),
        };
        assert_eq!(error.kind, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_call_may_wait_as_long_as_it_says_it_will() {
        assert_eq!(call_timeout(&json!({})), CALL_TIMEOUT_BASE);
        assert_eq!(
            call_timeout(&json!({ "timeout": 20 })),
            CALL_TIMEOUT_BASE + Duration::from_secs(20)
        );
        assert_eq!(
            call_timeout(&json!({ "wait": 4 })),
            CALL_TIMEOUT_BASE + Duration::from_secs(4)
        );
        assert_eq!(
            call_timeout(&json!({ "timeout": 9999 })),
            CALL_TIMEOUT_BASE + Duration::from_secs(30)
        );
    }

    #[test]
    fn a_call_takes_an_object_only() {
        let (_dir, path) = token_file(SECRET);
        let error =
            call_blocking(&Endpoint::local(1, path), "ash-hub-needs", json!([1, 2])).unwrap_err();
        assert_eq!(error.kind, "error");
    }

    #[test]
    fn the_parser_reads_events_and_skips_pings() {
        let mut p = SseParser::default();
        let mut out = Vec::new();
        for line in [
            "event: hello",
            "data: {\"latest\": 7}",
            "",
            ": ping",
            "",
            "id: 8",
            "event: hub",
            "data: {\"seq\": 8}",
            "",
            "data: {\"a\":",
            "data: 1}",
            "",
        ] {
            if let Some(e) = p.line(line) {
                out.push(e);
            }
        }
        assert_eq!(
            out,
            vec![
                ("hello".to_string(), "{\"latest\": 7}".to_string()),
                ("hub".to_string(), "{\"seq\": 8}".to_string()),
                (String::new(), "{\"a\":\n1}".to_string()),
            ]
        );
    }

    #[test]
    fn the_backoff_climbs_then_holds_at_fifteen_seconds() {
        let secs: Vec<u64> = (1..=8).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 15, 15, 15, 15]);
        assert_eq!(backoff(0).as_secs(), 1);
    }

    #[test]
    fn the_feed_says_hello_passes_changes_on_and_keeps_its_place() {
        let (_dir, path) = token_file(SECRET);
        let stream_body = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
event: hello\ndata: {\"latest\": 4, \"reset\": false}\n\n\
: ping\n\n\
id: 5\nevent: hub\ndata: {\"seq\": 5, \"kind\": \"hub.need.opened\", \"ref\": \"q1\", \"topics\": [\"needs\"]}\n\n\
id: 6\nevent: hub\ndata: {\"seq\": 6, \"kind\": \"hub.need.done\", \"ref\": \"q1\", \"topics\": [\"needs\"]}\n\n";
        let (port, seen) = serve_once(stream_body);
        let endpoint = Endpoint::local(port, path);
        let mut cursor = 4;
        let mut got = Vec::new();
        stream_once(&endpoint, &mut cursor, &|| true, &mut |m| got.push(m), 5).unwrap();
        assert_eq!(cursor, 6);
        assert_eq!(got.len(), 3);
        assert!(matches!(&got[0], FeedMsg::State(v) if v["connected"] == true && v["latest"] == 4));
        assert!(matches!(&got[2], FeedMsg::Change(v) if v["kind"] == "hub.need.done"));
        let head = seen.recv().unwrap();
        assert!(
            head.starts_with("GET /api/ash-hub-events?after=4&stream=1&max_seconds=5 HTTP/1.1"),
            "{head}"
        );
        assert!(head.contains(&format!("Bearer {SECRET}")));
    }

    #[test]
    fn a_reset_moves_the_feed_to_the_services_own_number() {
        let (_dir, path) = token_file(SECRET);
        let body = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: hello\ndata: {\"latest\": 2, \"reset\": true}\n\n";
        let (port, _seen) = serve_once(body);
        let mut cursor = 900;
        let mut got = Vec::new();
        stream_once(
            &Endpoint::local(port, path),
            &mut cursor,
            &|| true,
            &mut |m| got.push(m),
            5,
        )
        .unwrap();
        assert_eq!(cursor, 2);
        assert!(matches!(&got[0], FeedMsg::State(v) if v["reset"] == true));
    }

    #[test]
    fn a_feed_refused_with_401_reports_it_so_the_loop_can_back_off() {
        let (_dir, path) = token_file(SECRET);
        let (port, _seen) = serve_once(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        let mut cursor = 0;
        let error = stream_once(
            &Endpoint::local(port, path),
            &mut cursor,
            &|| true,
            &mut |_| {},
            5,
        )
        .unwrap_err();
        assert_eq!(error.kind, "unauthorized");
    }

    #[test]
    fn only_the_ash_os_entry_is_taken_from_claude_codes_config() {
        let config = json!({
            "oauthAccount": { "emailAddress": "someone@example.com" },
            "mcpServers": {
                "ash-os": { "type": "stdio", "command": "/opt/homebrew/bin/python3", "args": ["/x/bin/ash-os-mcp"], "env": {} },
                "other": { "command": "secret-thing", "env": { "TOKEN": "nope" } }
            }
        });
        let entry = ash_os_server_from(&config).unwrap();
        assert_eq!(
            entry,
            json!({ "command": "/opt/homebrew/bin/python3", "args": ["/x/bin/ash-os-mcp"], "env": {} })
        );
        assert!(!entry.to_string().contains("someone@example.com"));
        assert!(!entry.to_string().contains("nope"));
        assert_eq!(ash_os_server_from(&json!({ "mcpServers": {} })), None);
        assert_eq!(ash_os_server_from(&json!({})), None);
    }

    #[test]
    fn the_ash_os_entrys_own_env_reaches_the_child_by_reference_never_in_argv() {
        let config = json!({
            "mcpServers": {
                "ash-os": {
                    "command": "ash-os-mcp",
                    "env": {
                        "ASHOS_TOKEN": "s3cret-value",
                        "ASHOS_HOME": "${HOME}/.ashos",
                        "bad key": "kept as it is",
                        "RETRIES": 3
                    }
                }
            }
        });
        let entry = ash_os_server_from(&config).unwrap();
        assert_eq!(
            entry["env"],
            json!({
                "ASHOS_TOKEN": "${MONOCODE_ASH_OS_ASHOS_TOKEN}",
                "ASHOS_HOME": "${HOME}/.ashos",
                "bad key": "kept as it is",
                "RETRIES": 3
            })
        );
        assert!(!entry.to_string().contains("s3cret-value"));
        assert_eq!(
            ash_os_child_env(&config),
            vec![(
                "MONOCODE_ASH_OS_ASHOS_TOKEN".to_string(),
                "s3cret-value".to_string()
            )]
        );
        assert!(ash_os_child_env(&json!({})).is_empty());
    }

    #[test]
    fn two_windows_share_one_feed_which_stops_when_the_last_one_closes() {
        let mut feed = Feed::default();
        assert!(feed.open(), "the first window starts the feed");
        assert!(!feed.open(), "the second joins it");
        assert!(
            !feed.close(),
            "one window closing leaves it running for the other"
        );
        assert!(feed.close(), "the last one closing stops it");
        assert!(!feed.close(), "closing too often is harmless");
        assert!(feed.open(), "and it can start again");
    }

    #[test]
    fn closing_stops_a_running_feed_without_a_connection() {
        let (_dir, path) = token_file(SECRET);
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let endpoint = Endpoint::local(port, path);
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let states = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = states.clone();
        let handle = thread::spawn(move || {
            run_feed(endpoint, 0, &|| !flag.load(Ordering::SeqCst), &mut |m| {
                sink.lock().unwrap().push(m)
            });
        });
        thread::sleep(Duration::from_millis(500));
        stop.store(true, Ordering::SeqCst);
        handle.join().unwrap();
        let seen = states.lock().unwrap();
        assert!(!seen.is_empty());
        assert!(seen
            .iter()
            .all(|m| matches!(m, FeedMsg::State(v) if v["connected"] == false)));
    }
}
