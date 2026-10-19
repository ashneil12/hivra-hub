//! "Other models" for Claude Code: keys, key checks and a tiny local router.
//!
//! * Keys live in the Keychain under `monocode-hub:model-key` (tests: `monocode-hub-test:model-key`; a dev copy:
//!   `monocode-hub-dev:model-key`, see hub_keychain.rs), one item per custom model. A key goes in from the webview
//!   and never comes back out; only the router reads it, in this process.
//! * `model_key_test` makes one tiny real request to the provider and answers in plain words.
//! * For a session on a custom model, Claude Code starts with `ANTHROPIC_BASE_URL` pointing at a router on
//!   127.0.0.1 (random port) that turns Anthropic Messages (text, streaming, tools) into OpenAI chat completions for
//!   that provider. The model's own key is the auth token, so Claude Code never uses Ash's claude.ai login for it,
//!   and the router refuses anything that looks like a Claude credential. Claude models are never routed.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

pub const KEY_SERVICE: &str = "monocode-hub:model-key";
#[cfg(test)]
pub const TEST_KEY_SERVICE: &str = "monocode-hub-test:model-key";

const KEY_FAILED: &str = "That key didn't work";
const OLLAMA_UP: &str = "Connected, Ollama is running";
const OLLAMA_DOWN: &str = "Can't reach Ollama on this Mac";
/// Stand-in token for Ollama, which needs no key. It still stops Claude Code falling back to the claude.ai login.
const OLLAMA_TOKEN: &str = "monocode-ollama-local";

const PROVIDERS: &[&str] = &["xai", "openrouter", "deepseek", "ollama", "custom"];

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomRoute {
    pub provider: String,
    pub base_url: String,
    pub model_id: String,
    pub custom_model_id: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

/// Variables to set, then variables to remove, for a routed Claude Code session.
pub type RoutedEnv = (Vec<(&'static str, String)>, Vec<&'static str>);

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct KeyTestResult {
    pub ok: bool,
    pub message: String,
}

fn ok(message: impl Into<String>) -> KeyTestResult {
    KeyTestResult {
        ok: true,
        message: message.into(),
    }
}
fn fail(message: impl Into<String>) -> KeyTestResult {
    KeyTestResult {
        ok: false,
        message: message.into(),
    }
}

// ---- the rule: what may be routed -----------------------------------------------------------------------------------

/// True only for a non-Claude model on a known provider. A Claude model, an Anthropic URL, or anything unknown is
/// never routed: those keep Claude Code's normal login (Ash's subscription) and its normal endpoint.
pub fn may_route(route: &CustomRoute) -> bool {
    let model = route.model_id.trim().to_ascii_lowercase();
    let base = route.base_url.trim().to_ascii_lowercase();
    PROVIDERS.contains(&route.provider.as_str())
        && !model.is_empty()
        && !model.starts_with("claude")
        && !model.contains("/claude")
        && !model.starts_with("anthropic")
        && !base.contains("anthropic.com")
        && !base.contains("claude.ai")
        && valid_base_url(&route.provider, &route.base_url)
}

fn is_loopback_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| matches!(h, "localhost" | "127.0.0.1" | "::1" | "[::1]"))
        })
        .unwrap_or(false)
}

/// https anywhere; plain http only for this Mac (a key never crosses the network in the clear).
fn valid_base_url(_provider: &str, url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url.trim()) else {
        return false;
    };
    match parsed.scheme() {
        "https" => true,
        "http" => is_loopback_url(url),
        _ => false,
    }
}

/// A Claude credential (API key or claude.ai OAuth token) is never forwarded anywhere.
pub fn looks_like_claude_credential(token: &str) -> bool {
    token.trim().starts_with("sk-ant-")
}

fn chat_url(provider: &str, base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if provider == "ollama" && !base.ends_with("/v1") {
        format!("{base}/v1/chat/completions")
    } else {
        format!("{base}/chat/completions")
    }
}

/// The token Claude Code is given (and the router expects): the model's own key, or the Ollama stand-in.
pub fn session_token(provider: &str, key: Option<&str>) -> Result<String, String> {
    if provider == "ollama" {
        return Ok(OLLAMA_TOKEN.into());
    }
    match key.map(str::trim) {
        Some(k) if !k.is_empty() && !looks_like_claude_credential(k) => Ok(k.to_string()),
        Some(k) if looks_like_claude_credential(k) => {
            Err("That looks like a Claude key; Other models need the provider's own key.".into())
        }
        _ => Err("No key saved for this model yet. Add it again in Other models.".into()),
    }
}

/// Env for a routed Claude Code session. Set the token explicitly and remove the other credential variables, so the
/// saved claude.ai login is never the active credential for a routed session.
///
/// `context_window` is the model's real window when the provider told us one. Claude Code has never heard of a
/// non-Claude model, so it falls back to assuming 200K: on a 1M model auto-compact would fire about five times too
/// early, and the context meter would read "100%" from the first tool call onward. Naming the window is what makes
/// both honest. `None` leaves the variable out entirely — Claude Code's own assumption beats a number we invented.
pub fn routed_env(
    route: &CustomRoute,
    token: &str,
    port: u16,
    context_window: Option<u64>,
) -> RoutedEnv {
    let m = route.model_id.trim().to_string();
    let mut set = vec![
        ("ANTHROPIC_BASE_URL", format!("http://127.0.0.1:{port}")),
        ("ANTHROPIC_AUTH_TOKEN", token.to_string()),
        ("ANTHROPIC_MODEL", m.clone()),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", m.clone()),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", m.clone()),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", m.clone()),
        ("ANTHROPIC_SMALL_FAST_MODEL", m.clone()),
        ("CLAUDE_CODE_SUBAGENT_MODEL", m),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1".into()),
    ];
    if let Some(pair) = context_window_env(context_window) {
        set.push(pair);
    }
    let remove = vec![
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
    ];
    (set, remove)
}

/// The env pair that tells Claude Code the window, or `None` when the provider never said.
pub fn context_window_env(window: Option<u64>) -> Option<(&'static str, String)> {
    window
        .filter(|w| *w > 0)
        .map(|w| ("CLAUDE_CODE_MAX_CONTEXT_TOKENS", w.to_string()))
}

/// One model's window out of an OpenAI-style `/models` list.
///
/// Providers spell the field differently, and the names are not equivalent: `max_input_tokens` is the prompt window
/// (what Claude Code means by its context window), while `max_context_length` / `max_model_len` / a bare
/// `context_length` are usually the model's *total* window, prompt plus room for the reply. So a name that says
/// "input" wins; the totals are the fallback, since an over-named window only means compacting a little later than
/// the model could. A missing or zero value is `None`: unknown, not zero.
pub fn model_window(list: &Value, model_id: &str) -> Option<u64> {
    const FIELDS: [&str; 6] = [
        "max_input_tokens",
        "input_token_limit",
        "context_length",
        "context_window",
        "max_context_length",
        "max_model_len",
    ];
    let wanted = model_id.trim();
    if wanted.is_empty() {
        return None;
    }
    list["data"].as_array()?.iter().find_map(|m| {
        if m["id"].as_str()? != wanted {
            return None;
        }
        FIELDS
            .iter()
            .find_map(|key| m[*key].as_u64())
            .filter(|n| *n > 0)
    })
}

fn models_url(provider: &str, base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if provider == "ollama" && !base.ends_with("/v1") {
        format!("{base}/v1/models")
    } else {
        format!("{base}/models")
    }
}

/// Ask the provider for the model's real window. Best effort: anything that goes wrong answers `None`.
pub fn context_window_from_models(
    provider: &str,
    base_url: &str,
    model_id: &str,
    key: &str,
) -> Option<u64> {
    if model_id.trim().is_empty() {
        return None;
    }
    let mut request = agent(5).get(&models_url(provider, base_url));
    if provider != "ollama" && !key.trim().is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", key.trim()));
    }
    let body = request.call().ok()?.into_string().ok()?;
    model_window(&serde_json::from_str::<Value>(&body).ok()?, model_id)
}

/// Windows already learned, by route. Only a real answer is kept, so a provider that was unreachable or said nothing
/// is asked again next time instead of being stuck unknown until the app restarts.
static WINDOWS: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());

fn window_key(route: &CustomRoute) -> String {
    format!(
        "{}|{}|{}",
        route.provider,
        route.base_url.trim(),
        route.model_id.trim()
    )
}

fn remembered_window(route: &CustomRoute, key: Option<&str>) -> Option<u64> {
    let name = window_key(route);
    {
        let known = WINDOWS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, window)) = known.iter().find(|(route_name, _)| *route_name == name) {
            return Some(*window);
        }
    }
    let found = context_window_from_models(
        &route.provider,
        &route.base_url,
        &route.model_id,
        key.unwrap_or_default(),
    )?;
    WINDOWS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((name, found));
    Some(found)
}

// ---- keys -------------------------------------------------------------------------------------------------------------

fn check_model_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 120
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        Ok(())
    } else {
        Err("That model id can't be used for a key.".into())
    }
}

pub fn save_key_in(service: &str, custom_model_id: &str, key: &str) -> Result<(), String> {
    check_model_id(custom_model_id)?;
    let key = key.trim();
    if looks_like_claude_credential(key) {
        return Err(
            "That looks like a Claude key; Other models need the provider's own key.".into(),
        );
    }
    crate::hub_keychain::store(service, custom_model_id, key)
}

pub fn read_key_in(service: &str, custom_model_id: &str) -> Result<Option<String>, String> {
    check_model_id(custom_model_id)?;
    crate::hub_keychain::read(service, custom_model_id)
}

#[tauri::command]
pub async fn model_key_save(custom_model_id: String, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_key_in(KEY_SERVICE, &custom_model_id, &key))
        .await
        .map_err(|_| "Couldn't reach the Keychain.".to_string())?
}

/// What removing a model's key means to the UI: deleted, or there was no key to begin with, are both success (true).
/// Only a real Keychain error is a failure, and it comes back as an error the UI shows.
pub fn delete_outcome(result: Result<bool, String>) -> Result<bool, String> {
    result.map(|_deleted_or_missing| true)
}

pub fn delete_key_in(service: &str, custom_model_id: &str) -> Result<bool, String> {
    check_model_id(custom_model_id)?;
    delete_outcome(crate::hub_keychain::delete(service, custom_model_id))
}

#[tauri::command]
pub async fn model_key_delete(custom_model_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || delete_key_in(KEY_SERVICE, &custom_model_id))
        .await
        .map_err(|_| "Couldn't reach the Keychain.".to_string())?
}

// ---- key test ---------------------------------------------------------------------------------------------------------

fn agent(read_secs: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(read_secs))
        .timeout_write(Duration::from_secs(30))
        .build()
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "the provider".into())
}

pub fn test_key(provider: &str, base_url: &str, model_id: &str, key: &str) -> KeyTestResult {
    let model = model_id.trim();
    if !PROVIDERS.contains(&provider) {
        return fail("Pick a provider");
    }
    if !valid_base_url(provider, base_url) {
        return fail("The base URL needs https:// (http:// only for this Mac)");
    }
    if provider == "ollama" {
        return test_ollama(base_url, model);
    }
    if key.trim().is_empty() {
        return fail("Add the key");
    }
    if looks_like_claude_credential(key) {
        return fail("That looks like a Claude key; use the provider's own key");
    }
    if model.is_empty() {
        return fail("Add the model id");
    }
    let url = chat_url(provider, base_url);
    let body = json!({"model": model, "messages": [{"role": "user", "content": "Say ok"}], "max_tokens": 1, "stream": false});
    let result = agent(30)
        .post(&url)
        .set("Authorization", &format!("Bearer {}", key.trim()))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());
    match result {
        Ok(_) => ok(format!("Connected, {model} replied")),
        Err(ureq::Error::Status(401 | 403, _)) => fail(KEY_FAILED),
        Err(ureq::Error::Status(404, _)) => {
            fail(format!("The provider doesn't know the model id {model}"))
        }
        Err(ureq::Error::Status(400 | 422, r)) => {
            let text = r.into_string().unwrap_or_default().to_ascii_lowercase();
            if text.contains("model") {
                fail(format!("The provider doesn't know the model id {model}"))
            } else if text.contains("key") || text.contains("auth") {
                fail(KEY_FAILED)
            } else {
                fail("The provider turned the test down")
            }
        }
        Err(ureq::Error::Status(402, _)) => fail("The key works but the account has no credit"),
        Err(ureq::Error::Status(429, _)) => {
            fail("The key works but the provider is rate-limiting it right now")
        }
        Err(ureq::Error::Status(code, _)) => fail(format!(
            "The provider had a problem (error {code}); try again"
        )),
        Err(ureq::Error::Transport(_)) => fail(format!("Couldn't reach {}", host_of(&url))),
    }
}

fn test_ollama(base_url: &str, model: &str) -> KeyTestResult {
    let base = base_url
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/v1");
    match agent(5).get(&format!("{base}/api/tags")).call() {
        Ok(resp) => {
            if model.is_empty() {
                return ok(OLLAMA_UP);
            }
            let tags: Value = resp
                .into_string()
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(Value::Null);
            let have = tags["models"].as_array().map(|list| {
                list.iter().any(|m| {
                    let name = m["name"].as_str().unwrap_or("");
                    name == model || name.strip_suffix(":latest") == Some(model)
                })
            });
            match have {
                Some(false) => fail(format!(
                    "Ollama is running but doesn't have {model}. Run: ollama pull {model}"
                )),
                _ => ok(OLLAMA_UP),
            }
        }
        Err(_) => fail(OLLAMA_DOWN),
    }
}

#[tauri::command]
pub async fn model_key_test(
    provider: String,
    base_url: String,
    model_id: String,
    key: String,
) -> Result<KeyTestResult, String> {
    tauri::async_runtime::spawn_blocking(move || test_key(&provider, &base_url, &model_id, &key))
        .await
        .map_err(|_| "The check didn't finish.".to_string())
}

/// The provider's own context window for a saved route, for the context meter.
///
/// The meter needs BOTH halves to draw a ring, and only the level arrives in the stream mid-turn: Claude Code
/// sends the window on the turn's `result`, which lands at the end. Without this the ring cannot render while a
/// turn is running, and a session that is resumed after a quit shows a stale frozen level. Remembered per route,
/// so this is one provider call per model per run. Answers `None` when the provider has no such field — an
/// unknown window must stay unknown rather than becoming a number we invented.
#[tauri::command]
pub async fn model_context_window(
    provider: String,
    base_url: String,
    model_id: String,
    custom_model_id: String,
) -> Result<Option<u64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let route = CustomRoute {
            provider,
            base_url,
            model_id,
            custom_model_id,
            reasoning_effort: None,
        };
        if !may_route(&route) {
            return Ok(None);
        }
        let key = if route.provider == "ollama" {
            None
        } else {
            // No key is not an error for a window lookup: the answer is simply unknown.
            read_key_in(KEY_SERVICE, &route.custom_model_id).unwrap_or_default()
        };
        Ok(remembered_window(&route, key.as_deref()))
    })
    .await
    .map_err(|_| "The window lookup didn't finish.".to_string())?
}

// ---- translation: Anthropic Messages -> OpenAI chat completions -------------------------------------------------------

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| {
                if p["type"] == "text" {
                    p["text"].as_str().map(str::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub fn to_openai(req: &Value, model_id: &str) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    let system = text_of(&req["system"]);
    if !system.is_empty() {
        messages.push(json!({"role": "system", "content": system}));
    }
    for msg in req["messages"].as_array().into_iter().flatten() {
        let role = msg["role"].as_str().unwrap_or("user");
        let content = &msg["content"];
        if let Value::String(s) = content {
            messages.push(json!({"role": role, "content": s}));
            continue;
        }
        let blocks = content.as_array().cloned().unwrap_or_default();
        if role == "assistant" {
            let mut text = String::new();
            let mut calls = Vec::new();
            for b in &blocks {
                match b["type"].as_str() {
                    Some("text") => text.push_str(b["text"].as_str().unwrap_or("")),
                    Some("tool_use") => calls.push(json!({
                        "id": b["id"],
                        "type": "function",
                        "function": {"name": b["name"], "arguments": b["input"].to_string()},
                    })),
                    _ => {} // thinking and redacted_thinking stay on the Anthropic side
                }
            }
            let mut out = json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { Value::String(text) }});
            if !calls.is_empty() {
                out["tool_calls"] = Value::Array(calls);
            }
            messages.push(out);
        } else {
            let mut parts: Vec<Value> = Vec::new();
            for b in &blocks {
                match b["type"].as_str() {
                    Some("tool_result") => {
                        let mut text = text_of(&b["content"]);
                        if b["is_error"] == true {
                            text = format!("Error: {text}");
                        }
                        messages.push(json!({"role": "tool", "tool_call_id": b["tool_use_id"], "content": text}));
                    }
                    Some("text") => parts.push(json!({"type": "text", "text": b["text"]})),
                    Some("image") => {
                        let src = &b["source"];
                        let url = if src["type"] == "base64" {
                            format!(
                                "data:{};base64,{}",
                                src["media_type"].as_str().unwrap_or("image/png"),
                                src["data"].as_str().unwrap_or("")
                            )
                        } else {
                            src["url"].as_str().unwrap_or("").to_string()
                        };
                        parts.push(json!({"type": "image_url", "image_url": {"url": url}}));
                    }
                    _ => {}
                }
            }
            if !parts.is_empty() {
                let only_text = parts.iter().all(|p| p["type"] == "text");
                let content = if only_text {
                    Value::String(
                        parts
                            .iter()
                            .filter_map(|p| p["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    )
                } else {
                    Value::Array(parts)
                };
                messages.push(json!({"role": "user", "content": content}));
            }
        }
    }
    let mut out = json!({"model": model_id, "messages": messages});
    if let Some(n) = req["max_tokens"].as_u64() {
        out["max_tokens"] = json!(n);
    }
    for k in ["temperature", "top_p"] {
        if !req[k].is_null() {
            out[k] = req[k].clone();
        }
    }
    if let Some(stop) = req["stop_sequences"].as_array() {
        out["stop"] = Value::Array(stop.clone());
    }
    let tools: Vec<Value> = req["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t.get("input_schema").is_some())
        .map(|t| json!({"type": "function", "function": {"name": t["name"], "description": t["description"].as_str().unwrap_or(""), "parameters": t["input_schema"]}}))
        .collect();
    if !tools.is_empty() {
        out["tools"] = Value::Array(tools);
        match req["tool_choice"]["type"].as_str() {
            Some("any") => out["tool_choice"] = json!("required"),
            Some("none") => out["tool_choice"] = json!("none"),
            Some("tool") => {
                out["tool_choice"] =
                    json!({"type": "function", "function": {"name": req["tool_choice"]["name"]}})
            }
            Some("auto") => out["tool_choice"] = json!("auto"),
            _ => {}
        }
    }
    if req["stream"] == true {
        out["stream"] = json!(true);
        out["stream_options"] = json!({"include_usage": true});
    }
    out
}

fn stop_reason(finish: Option<&str>) -> &'static str {
    match finish {
        Some("length") => "max_tokens",
        Some("tool_calls") | Some("function_call") => "tool_use",
        _ => "end_turn",
    }
}

fn message_id() -> String {
    format!("msg_{}", uuid::Uuid::new_v4().simple())
}

pub fn from_openai(resp: &Value, model_id: &str) -> Value {
    let choice = &resp["choices"][0];
    let msg = &choice["message"];
    let mut content = Vec::new();
    if let Some(t) = msg["content"].as_str().filter(|t| !t.is_empty()) {
        content.push(json!({"type": "text", "text": t}));
    }
    for call in msg["tool_calls"].as_array().into_iter().flatten() {
        let args = call["function"]["arguments"].as_str().unwrap_or("{}");
        let input: Value = serde_json::from_str(args).unwrap_or_else(|_| json!({}));
        content.push(json!({"type": "tool_use", "id": call["id"], "name": call["function"]["name"], "input": input}));
    }
    let has_tools = content.iter().any(|c| c["type"] == "tool_use");
    let finish = choice["finish_reason"].as_str();
    json!({
        "id": message_id(),
        "type": "message",
        "role": "assistant",
        "model": model_id,
        "content": content,
        "stop_reason": if has_tools { "tool_use" } else { stop_reason(finish) },
        "stop_sequence": null,
        "usage": {
            "input_tokens": resp["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
            "output_tokens": resp["usage"]["completion_tokens"].as_u64().unwrap_or(0),
        },
    })
}

fn sse(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

#[derive(PartialEq)]
enum Block {
    None,
    Text,
    Tool(u64),
}

/// Turns an OpenAI chat-completions stream into Anthropic Messages stream events, one chunk at a time.
pub struct StreamTranslator {
    model: String,
    started: bool,
    finished: bool,
    index: i64,
    block: Block,
    finish: Option<String>,
    saw_tool: bool,
    input_tokens: u64,
    output_tokens: u64,
}

impl StreamTranslator {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.into(),
            started: false,
            finished: false,
            index: -1,
            block: Block::None,
            finish: None,
            saw_tool: false,
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    fn start(&mut self, out: &mut Vec<String>) {
        if !self.started {
            self.started = true;
            out.push(sse("message_start", json!({"type": "message_start", "message": {
                "id": message_id(), "type": "message", "role": "assistant", "model": self.model, "content": [],
                "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": self.input_tokens, "output_tokens": 0}}})));
        }
    }

    fn close_block(&mut self, out: &mut Vec<String>) {
        if self.block != Block::None {
            out.push(sse(
                "content_block_stop",
                json!({"type": "content_block_stop", "index": self.index}),
            ));
            self.block = Block::None;
        }
    }

    /// Feed one `data:` payload (without the prefix). Returns the Anthropic events to send.
    pub fn feed(&mut self, data: &str) -> Vec<String> {
        let mut out = Vec::new();
        let data = data.trim();
        if data == "[DONE]" {
            return self.finish();
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            return out;
        };
        if let Some(n) = chunk["usage"]["prompt_tokens"].as_u64() {
            self.input_tokens = n;
        }
        if let Some(n) = chunk["usage"]["completion_tokens"].as_u64() {
            self.output_tokens = n;
        }
        self.start(&mut out);
        let choice = &chunk["choices"][0];
        let delta = &choice["delta"];
        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            if self.block != Block::Text {
                self.close_block(&mut out);
                self.index += 1;
                self.block = Block::Text;
                out.push(sse("content_block_start", json!({"type": "content_block_start", "index": self.index, "content_block": {"type": "text", "text": ""}})));
            }
            out.push(sse("content_block_delta", json!({"type": "content_block_delta", "index": self.index, "delta": {"type": "text_delta", "text": text}})));
        }
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            let i = call["index"].as_u64().unwrap_or(0);
            if self.block != Block::Tool(i) {
                self.close_block(&mut out);
                self.index += 1;
                self.block = Block::Tool(i);
                self.saw_tool = true;
                let id = call["id"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("toolu_{}", uuid::Uuid::new_v4().simple()));
                out.push(sse("content_block_start", json!({"type": "content_block_start", "index": self.index,
                    "content_block": {"type": "tool_use", "id": id, "name": call["function"]["name"].as_str().unwrap_or(""), "input": {}}})));
            }
            if let Some(args) = call["function"]["arguments"]
                .as_str()
                .filter(|a| !a.is_empty())
            {
                out.push(sse("content_block_delta", json!({"type": "content_block_delta", "index": self.index, "delta": {"type": "input_json_delta", "partial_json": args}})));
            }
        }
        if let Some(f) = choice["finish_reason"].as_str() {
            self.finish = Some(f.to_string());
        }
        out
    }

    /// Close the message. Safe to call twice; the second call sends nothing.
    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        self.finished = true;
        self.start(&mut out);
        self.close_block(&mut out);
        let reason = if self.saw_tool {
            "tool_use"
        } else {
            stop_reason(self.finish.as_deref())
        };
        out.push(sse(
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": reason, "stop_sequence": null},
            "usage": {"input_tokens": self.input_tokens, "output_tokens": self.output_tokens}}),
        ));
        out.push(sse("message_stop", json!({"type": "message_stop"})));
        out
    }
}

// ---- the router -------------------------------------------------------------------------------------------------------

struct Running {
    port: u16,
    token: String,
    route: CustomRoute,
}

static ROUTERS: Mutex<Vec<Running>> = Mutex::new(Vec::new());

/// The router for this route and token, started on first use (127.0.0.1, random port). Returns its port.
pub fn ensure_router(route: &CustomRoute, token: &str) -> Result<u16, String> {
    if !may_route(route) {
        return Err("This model isn't routed: Claude models always use your Claude login.".into());
    }
    let mut routers = ROUTERS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = routers
        .iter()
        .find(|r| &r.route == route && r.token == token)
    {
        return Ok(r.port);
    }
    let port = start_router(route.clone(), token.to_string())?;
    routers.push(Running {
        port,
        token: token.to_string(),
        route: route.clone(),
    });
    Ok(port)
}

pub fn start_router(route: CustomRoute, token: String) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Couldn't start the model router.".to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::Builder::new()
        .name(format!("model-router-{port}"))
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let route = route.clone();
                let token = token.clone();
                let _ = std::thread::Builder::new().spawn(move || {
                    let _ = handle(stream, &route, &token);
                });
            }
        })
        .map_err(|_| "Couldn't start the model router.".to_string())?;
    Ok(port)
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(60)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > 64 * 1024 * 1024 {
        return Err(std::io::Error::other("too large"));
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len())?;
    stream.flush()
}

fn anthropic_error(kind: &str, message: &str) -> Value {
    json!({"type": "error", "error": {"type": kind, "message": message}})
}

fn incoming_token(headers: &HashMap<String, String>) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .map(str::to_string)
        .or_else(|| headers.get("x-api-key").cloned())
}

/// Whether the caller may use this router. A Claude credential is always refused (never forwarded upstream).
pub fn authorize(
    headers: &HashMap<String, String>,
    expected: &str,
) -> Result<(), (u16, &'static str)> {
    let got = incoming_token(headers).unwrap_or_default();
    if looks_like_claude_credential(&got) {
        return Err((403, "The model router never forwards a Claude login."));
    }
    let same = got.len() == expected.len()
        && got
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;
    if !same {
        return Err((
            401,
            "This router only serves the session it was started for.",
        ));
    }
    Ok(())
}

fn scrub(text: &str, token: &str) -> String {
    let mut t: String = text.chars().take(400).collect();
    if token.len() >= 4 {
        t = t.replace(token, "***");
    }
    t
}

fn handle(mut stream: TcpStream, route: &CustomRoute, token: &str) -> std::io::Result<()> {
    let req = read_request(&mut stream)?;
    if let Err((status, message)) = authorize(&req.headers, token) {
        return respond(
            &mut stream,
            status,
            &anthropic_error("authentication_error", message),
        );
    }
    let path = req.path.split('?').next().unwrap_or("");
    if req.method != "POST" {
        return respond(
            &mut stream,
            404,
            &anthropic_error("not_found_error", "Not here."),
        );
    }
    let Ok(body) = serde_json::from_slice::<Value>(&req.body) else {
        return respond(
            &mut stream,
            400,
            &anthropic_error("invalid_request_error", "The request wasn't JSON."),
        );
    };
    match path {
        "/v1/messages/count_tokens" => {
            // No portable token counter across providers: a rough 4-chars-per-token estimate is enough for Claude Code.
            let n = (body.to_string().len() / 4) as u64;
            respond(&mut stream, 200, &json!({"input_tokens": n}))
        }
        "/v1/messages" => forward(&mut stream, route, token, &body),
        _ => respond(
            &mut stream,
            404,
            &anthropic_error("not_found_error", "Not here."),
        ),
    }
}

fn forward(
    stream: &mut TcpStream,
    route: &CustomRoute,
    token: &str,
    body: &Value,
) -> std::io::Result<()> {
    let model = route.model_id.trim();
    let mut upstream_body = to_openai(body, model);
    if let Some(effort) = &route.reasoning_effort {
        if ["none", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&effort.as_str()) {
            upstream_body["reasoning_effort"] = json!(effort);
        }
    }
    let streaming = body["stream"] == true;
    let mut request = agent(600)
        .post(&chat_url(&route.provider, &route.base_url))
        .set("Content-Type", "application/json");
    if route.provider != "ollama" {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    let resp = match request.send_string(&upstream_body.to_string()) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let text = scrub(&r.into_string().unwrap_or_default(), token);
            let kind = match code {
                401 | 403 => "authentication_error",
                429 => "rate_limit_error",
                400 | 404 | 422 => "invalid_request_error",
                _ => "api_error",
            };
            return respond(
                stream,
                code,
                &anthropic_error(kind, &format!("{} said: {text}", host_of(&route.base_url))),
            );
        }
        Err(ureq::Error::Transport(_)) => {
            return respond(
                stream,
                502,
                &anthropic_error(
                    "api_error",
                    &format!("Couldn't reach {}", host_of(&route.base_url)),
                ),
            );
        }
    };
    if !streaming {
        let parsed: Value = resp
            .into_string()
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        return respond(stream, 200, &from_openai(&parsed, model));
    }
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n")?;
    let mut tr = StreamTranslator::new(model);
    let reader = BufReader::new(resp.into_reader());
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if let Some(data) = line.strip_prefix("data:") {
            for ev in tr.feed(data) {
                stream.write_all(ev.as_bytes())?;
            }
            stream.flush()?;
        }
    }
    for ev in tr.finish() {
        stream.write_all(ev.as_bytes())?;
    }
    stream.flush()
}

/// What `harness_spawn` applies for a Claude Code session on a custom model.
pub fn prepare_routed_session(route: &CustomRoute) -> Result<RoutedEnv, String> {
    if !may_route(route) {
        return Err("This model isn't routed: Claude models always use your Claude login.".into());
    }
    let key = if route.provider == "ollama" {
        None
    } else {
        read_key_in(KEY_SERVICE, &route.custom_model_id)?
    };
    let token = session_token(&route.provider, key.as_deref())?;
    let port = ensure_router(route, &token)?;
    // The provider's own window for this model, asked once per route. Nothing here may fail the spawn: a session on
    // an assumed-200K window is still a working session.
    let window = remembered_window(route, key.as_deref());
    Ok(routed_env(route, &token, port, window))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(provider: &str, base: &str, model: &str) -> CustomRoute {
        CustomRoute {
            provider: provider.into(),
            base_url: base.into(),
            model_id: model.into(),
            custom_model_id: "xai-test1".into(),
            reasoning_effort: None,
        }
    }

    #[test]
    fn claude_models_and_the_sub_are_never_routed() {
        for m in [
            "claude-sonnet-5",
            "Claude-Opus-5-5",
            "anthropic/claude-3",
            "openrouter/claude-x",
            "anthropic.claude",
        ] {
            assert!(
                !may_route(&route("openrouter", "https://openrouter.ai/api/v1", m)),
                "{m} must not be routed"
            );
        }
        assert!(!may_route(&route(
            "custom",
            "https://api.anthropic.com/v1",
            "grok-4"
        )));
        assert!(!may_route(&route(
            "anthropic",
            "https://api.x.ai/v1",
            "grok-4"
        )));
        assert!(
            !may_route(&route("custom", "http://example.com/v1", "grok-4")),
            "plain http only on this Mac"
        );
        assert!(may_route(&route("xai", "https://api.x.ai/v1", "grok-4")));
        assert!(may_route(&route(
            "ollama",
            "http://localhost:11434",
            "llama3.2"
        )));
        assert!(
            ensure_router(&route("xai", "https://api.x.ai/v1", "claude-sonnet-5"), "k").is_err()
        );
        assert!(
            prepare_routed_session(&route("xai", "https://api.x.ai/v1", "claude-sonnet-5"))
                .is_err()
        );
    }

    #[test]
    fn a_routed_session_never_falls_back_to_the_claude_login() {
        let (set, remove) = routed_env(
            &route("xai", "https://api.x.ai/v1", "grok-4"),
            "xai-fake",
            4321,
            None,
        );
        let get = |k: &str| set.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert_eq!(
            get("ANTHROPIC_BASE_URL").as_deref(),
            Some("http://127.0.0.1:4321")
        );
        assert_eq!(get("ANTHROPIC_AUTH_TOKEN").as_deref(), Some("xai-fake"));
        assert_eq!(get("ANTHROPIC_MODEL").as_deref(), Some("grok-4"));
        assert!(
            remove.contains(&"ANTHROPIC_API_KEY") && remove.contains(&"CLAUDE_CODE_OAUTH_TOKEN")
        );
        assert!(
            session_token("xai", Some("sk-ant-oat01-abc")).is_err(),
            "a Claude login is never the token"
        );
        assert!(session_token("xai", None).is_err());
        assert_eq!(session_token("ollama", None).unwrap(), OLLAMA_TOKEN);
        let mut h = HashMap::new();
        h.insert(
            "authorization".to_string(),
            "Bearer sk-ant-oat01-xyz".to_string(),
        );
        assert_eq!(authorize(&h, "sk-ant-oat01-xyz").unwrap_err().0, 403);
        h.insert("authorization".to_string(), "Bearer wrong".to_string());
        assert_eq!(authorize(&h, "xai-fake").unwrap_err().0, 401);
        h.insert("authorization".to_string(), "Bearer xai-fake".to_string());
        assert!(authorize(&h, "xai-fake").is_ok());
        assert!(save_key_in(TEST_KEY_SERVICE, "x1", "sk-ant-api03-zzz").is_err());
    }

    /// The window a routed model really has comes from the provider's own list, under whatever name it uses; an
    /// unknown window must stay unknown rather than being invented, since Claude Code's 200K assumption beats a
    /// made-up number.
    #[test]
    fn a_model_window_is_read_from_the_providers_own_list() {
        let list = json!({"object": "list", "data": [
            {"id": "deepseek-ai/DeepSeek-V4.1-Flash", "context_length": 1048576},
            {"id": "other-model", "context_window": 8192},
            {"id": "nameless-window", "max_model_len": 32768},
            {"id": "no-window-at-all"},
            {"id": "zero-window", "context_length": 0}
        ]});
        assert_eq!(
            model_window(&list, "deepseek-ai/DeepSeek-V4.1-Flash"),
            Some(1048576)
        );
        assert_eq!(model_window(&list, "other-model"), Some(8192));
        assert_eq!(model_window(&list, "nameless-window"), Some(32768));
        assert_eq!(model_window(&list, "no-window-at-all"), None);
        assert_eq!(model_window(&list, "zero-window"), None);
        assert_eq!(model_window(&list, "not-in-the-list"), None);
        assert_eq!(model_window(&list, "  "), None);
        assert_eq!(model_window(&json!({"data": "not a list"}), "x"), None);

        // The prompt window wins over a total: `max_input_tokens` is what Claude Code means by its context window.
        let both = json!({"data": [
            {"id": "m", "max_input_tokens": 200000, "context_length": 262144, "max_model_len": 262144}
        ]});
        assert_eq!(model_window(&both, "m"), Some(200000));

        let (name, value) = context_window_env(Some(1048576)).unwrap();
        assert_eq!(
            (name, value.as_str()),
            ("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "1048576")
        );
        assert_eq!(context_window_env(None), None);
        assert_eq!(
            context_window_env(Some(0)),
            None,
            "a zero window is no window"
        );

        // The routed session carries the window through, and leaves the variable out when nobody told us one.
        let r = route("custom", "https://lighthouse.dphn.ai/run/text-v/v1", "m");
        let (set, _) = routed_env(&r, "k", 4321, Some(262144));
        assert!(set
            .iter()
            .any(|(n, v)| *n == "CLAUDE_CODE_MAX_CONTEXT_TOKENS" && v == "262144"));
        let (set, _) = routed_env(&r, "k", 4321, None);
        assert!(!set
            .iter()
            .any(|(n, _)| *n == "CLAUDE_CODE_MAX_CONTEXT_TOKENS"));
    }

    /// End to end: a fake provider that answers `/models` with a window, so the whole path — URL, auth header,
    /// parsing — is the one a real provider goes through.
    #[test]
    fn the_window_is_asked_for_over_the_real_http_path() {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let up_port = upstream.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(Mutex::new(String::new()));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            let (mut s, _) = upstream.accept().unwrap();
            let req = read_request(&mut s).unwrap();
            *seen2.lock().unwrap() = req.path.clone();
            let text = r#"{"object":"list","data":[{"id":"fake-model","context_length":1048576}]}"#;
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len());
        });
        assert_eq!(
            context_window_from_models(
                "custom",
                &format!("http://127.0.0.1:{up_port}/v1"),
                "fake-model",
                "fake-key"
            ),
            Some(1048576)
        );
        assert_eq!(*seen.lock().unwrap(), "/v1/models");
    }

    /// Opt-in proof against a real routed provider. Give it a saved custom model id:
    /// `MONOCODE_REAL_WINDOW=custom-mva0kfwr1s1b MONOCODE_REAL_BASE=https://lighthouse.dphn.ai/run/text-v/v1
    ///  MONOCODE_REAL_MODEL=deepseek-ai/DeepSeek-V4.1-Flash cargo test real_window -- --nocapture`
    #[test]
    fn real_window_reads_the_live_provider() {
        let Ok(custom_model_id) = std::env::var("MONOCODE_REAL_WINDOW") else {
            return;
        };
        let (Ok(base_url), Ok(model_id)) = (
            std::env::var("MONOCODE_REAL_BASE"),
            std::env::var("MONOCODE_REAL_MODEL"),
        ) else {
            println!("[real-window] set MONOCODE_REAL_BASE and MONOCODE_REAL_MODEL too");
            return;
        };
        let Ok(key) = read_key_in(KEY_SERVICE, &custom_model_id) else {
            println!("[real-window] no key saved for {custom_model_id}");
            return;
        };
        let window = context_window_from_models(
            "custom",
            &base_url,
            &model_id,
            key.as_deref().unwrap_or_default(),
        );
        println!("[real-window] {model_id} -> {window:?}");
        assert!(window.is_some_and(|w| w > 200_000), "read {window:?}");
    }

    #[test]
    fn text_request_and_response_translate() {
        let req = json!({"model": "claude-sonnet-5", "max_tokens": 100, "system": [{"type": "text", "text": "Be brief"}],
            "messages": [{"role": "user", "content": [{"type": "text", "text": "Hi"}]}], "thinking": {"type": "enabled"}});
        let out = to_openai(&req, "grok-4");
        assert_eq!(out["model"], "grok-4");
        assert_eq!(
            out["messages"][0],
            json!({"role": "system", "content": "Be brief"})
        );
        assert_eq!(out["messages"][1], json!({"role": "user", "content": "Hi"}));
        assert_eq!(out["max_tokens"], 100);
        assert!(out.get("thinking").is_none() && out.get("stream").is_none());
        let resp = json!({"choices": [{"message": {"role": "assistant", "content": "Hello"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 1}});
        let a = from_openai(&resp, "grok-4");
        assert_eq!(a["content"], json!([{"type": "text", "text": "Hello"}]));
        assert_eq!(a["stop_reason"], "end_turn");
        assert_eq!(a["usage"]["input_tokens"], 5);
    }

    #[test]
    fn tool_calls_translate_both_ways() {
        let req = json!({"max_tokens": 50, "tools": [{"name": "Read", "description": "read a file", "input_schema": {"type": "object"}}],
        "tool_choice": {"type": "any"},
        "messages": [
            {"role": "user", "content": "read a.txt"},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "Sure"}, {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "a.txt"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "hello"}]}, {"type": "text", "text": "now summarise"}]}
        ]});
        let out = to_openai(&req, "grok-4");
        assert_eq!(out["tools"][0]["function"]["name"], "Read");
        assert_eq!(
            out["tools"][0]["function"]["parameters"],
            json!({"type": "object"})
        );
        assert_eq!(out["tool_choice"], "required");
        let m = out["messages"].as_array().unwrap();
        assert_eq!(m[1]["content"], "Sure");
        assert_eq!(m[1]["tool_calls"][0]["id"], "t1");
        assert_eq!(
            m[1]["tool_calls"][0]["function"]["arguments"],
            "{\"path\":\"a.txt\"}"
        );
        assert_eq!(
            m[2],
            json!({"role": "tool", "tool_call_id": "t1", "content": "hello"})
        );
        assert_eq!(m[3], json!({"role": "user", "content": "now summarise"}));
        let resp = json!({"choices": [{"message": {"content": null, "tool_calls": [{"id": "c9", "type": "function", "function": {"name": "Read", "arguments": "{\"path\":\"b\"}"}}]}, "finish_reason": "tool_calls"}]});
        let a = from_openai(&resp, "grok-4");
        assert_eq!(
            a["content"][0],
            json!({"type": "tool_use", "id": "c9", "name": "Read", "input": {"path": "b"}})
        );
        assert_eq!(a["stop_reason"], "tool_use");
    }

    fn events(all: &[String]) -> Vec<Value> {
        all.iter()
            .map(|e| serde_json::from_str(e.split("data: ").nth(1).unwrap().trim()).unwrap())
            .collect()
    }

    #[test]
    fn streaming_text_and_tools_translate() {
        let mut tr = StreamTranslator::new("grok-4");
        let mut all = Vec::new();
        for d in [
            r#"{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#,
            r#"{"choices":[{"delta":{"content":"lo"}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pa"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":1}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}"#,
            "[DONE]",
        ] {
            all.extend(tr.feed(d));
        }
        assert!(
            tr.finish().is_empty(),
            "finish after [DONE] sends nothing more"
        );
        let ev = events(&all);
        let types: Vec<&str> = ev.iter().map(|e| e["type"].as_str().unwrap()).collect();
        assert_eq!(
            types,
            [
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop"
            ]
        );
        assert_eq!(ev[1]["content_block"]["type"], "text");
        assert_eq!(ev[2]["delta"]["text"], "Hel");
        assert_eq!(ev[5]["index"], 1);
        assert_eq!(
            ev[5]["content_block"],
            json!({"type": "tool_use", "id": "c1", "name": "Read", "input": {}})
        );
        let json_parts: String = ev[6..8]
            .iter()
            .map(|e| e["delta"]["partial_json"].as_str().unwrap())
            .collect();
        assert_eq!(json_parts, "{\"path\":1}");
        assert_eq!(ev[9]["delta"]["stop_reason"], "tool_use");
        assert_eq!(ev[9]["usage"]["output_tokens"], 4);
    }

    /// End to end through the real router against a fake OpenAI-compatible server on this machine.
    #[test]
    fn the_router_streams_through_to_an_openai_server() {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let up_port = upstream.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(Mutex::new(String::new()));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            let (mut s, _) = upstream.accept().unwrap();
            let req = read_request(&mut s).unwrap();
            *seen2.lock().unwrap() = format!(
                "{}|{}",
                req.headers
                    .get("authorization")
                    .cloned()
                    .unwrap_or_default(),
                String::from_utf8_lossy(&req.body)
            );
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
            write!(s, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        });
        let mut r = route(
            "custom",
            &format!("http://127.0.0.1:{up_port}/v1"),
            "fake-model",
        );
        r.reasoning_effort = Some("high".into());
        let port = start_router(r, "fake-key-123".into()).unwrap();
        let resp = agent(10)
            .post(&format!("http://127.0.0.1:{port}/v1/messages?beta=true"))
            .set("Authorization", "Bearer fake-key-123")
            .send_string(&json!({"model": "x", "max_tokens": 5, "stream": true, "messages": [{"role": "user", "content": "ping"}]}).to_string())
            .unwrap();
        let text = resp.into_string().unwrap();
        assert!(text.contains("\"text\":\"pong\""), "{text}");
        assert!(text.contains("event: message_stop"));
        let seen = seen.lock().unwrap().clone();
        assert!(seen.starts_with("Bearer fake-key-123|"));
        assert!(seen.contains("\"model\":\"fake-model\"") && seen.contains("\"stream\":true"));
        assert!(seen.contains("\"reasoning_effort\":\"high\""), "{seen}");
        // a Claude login is refused before anything goes upstream
        let refused = agent(5)
            .post(&format!("http://127.0.0.1:{port}/v1/messages"))
            .set("Authorization", "Bearer sk-ant-oat01-nope")
            .send_string("{}");
        assert!(matches!(refused, Err(ureq::Error::Status(403, _))));
    }

    #[test]
    fn a_fake_key_check_fails_cleanly_without_network_for_bad_input() {
        // The frontend matches this exact phrase (CLAUDE_KEY_ERROR in customModels.ts); keep the wording.
        const CLAUDE_KEY_ERROR: &str = "looks like a Claude key";
        assert!(
            test_key("xai", "https://api.x.ai/v1", "grok-4", "sk-ant-api03-x")
                .message
                .contains(CLAUDE_KEY_ERROR)
        );
        assert!(session_token("xai", Some("sk-ant-oat01-x"))
            .unwrap_err()
            .contains(CLAUDE_KEY_ERROR));
        assert!(save_key_in(TEST_KEY_SERVICE, "x1", "sk-ant-api03-x")
            .unwrap_err()
            .contains(CLAUDE_KEY_ERROR));
        assert_eq!(
            test_key("xai", "https://api.x.ai/v1", "grok-4", "").message,
            "Add the key"
        );
        assert!(!test_key("custom", "http://example.com/v1", "m", "k").ok);
        assert!(!test_key("xai", "https://api.x.ai/v1", "grok-4", "sk-ant-api03-x").ok);
    }

    /// Real Keychain round trip with a dummy key under `monocode-hub-test:model-key`, deleted at the end.
    /// Opt-in: `MONOCODE_KEYCHAIN_PROOF=1 cargo test model_router -- --nocapture`
    #[test]
    fn a_missing_key_counts_as_removed_and_only_a_real_error_fails() {
        assert_eq!(delete_outcome(Ok(true)), Ok(true), "deleted");
        assert_eq!(
            delete_outcome(Ok(false)),
            Ok(true),
            "no key found is a success"
        );
        assert!(delete_outcome(Err("The Keychain didn't remove the login.".into())).is_err());
        assert!(delete_key_in(TEST_KEY_SERVICE, "bad id/..").is_err());
    }

    #[test]
    fn a_dummy_model_key_round_trips_the_keychain() {
        if std::env::var("MONOCODE_KEYCHAIN_PROOF").as_deref() != Ok("1") {
            return;
        }
        let id = format!("proof-{}", std::process::id());
        save_key_in(TEST_KEY_SERVICE, &id, "not-a-real-key").unwrap();
        assert_eq!(
            read_key_in(TEST_KEY_SERVICE, &id).unwrap().as_deref(),
            Some("not-a-real-key")
        );
        assert!(delete_key_in(TEST_KEY_SERVICE, &id).unwrap());
        assert_eq!(read_key_in(TEST_KEY_SERVICE, &id).unwrap(), None);
        // deleting again finds no key, which still counts as removed
        assert!(delete_key_in(TEST_KEY_SERVICE, &id).unwrap());
        println!("[model-key proof] stored, read back, deleted {TEST_KEY_SERVICE} / {id}");
    }

    /// Opt-in live checks: `MONOCODE_LIVE_KEY_TEST=1 cargo test model_router::tests::live -- --nocapture`
    #[test]
    fn live_key_checks() {
        if std::env::var("MONOCODE_LIVE_KEY_TEST").as_deref() != Ok("1") {
            return;
        }
        let r = test_key(
            "xai",
            "https://api.x.ai/v1",
            "grok-4",
            "xai-this-is-a-fake-key",
        );
        println!("[live] xai fake key -> ok={} message={:?}", r.ok, r.message);
        assert!(!r.ok);
        let o = test_key("ollama", "http://localhost:11434", "", "");
        println!("[live] ollama -> ok={} message={:?}", o.ok, o.message);
    }

    /// Opt-in, real Claude Code through the router to a local Ollama model, with a throwaway CLAUDE_CONFIG_DIR so
    /// nothing in ~/.claude is read or written: `MONOCODE_LIVE_CLAUDE=qwen2.5:3b cargo test live_claude -- --nocapture`
    #[test]
    fn live_claude_code_through_the_router() {
        let Ok(model) = std::env::var("MONOCODE_LIVE_CLAUDE") else {
            return;
        };
        let r = route("ollama", "http://localhost:11434", &model);
        let token = session_token("ollama", None).unwrap();
        let port = start_router(r.clone(), token.clone()).unwrap();
        let (set, remove) = routed_env(&r, &token, port, None);
        let dir =
            std::env::temp_dir().join(format!("monocode-router-proof-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cmd = std::process::Command::new("claude");
        cmd.args([
            "-p",
            "Reply with exactly one word: pong",
            "--output-format",
            "text",
            "--model",
            &model,
        ])
        .current_dir(&dir) // a small model may call tools: any file lands in the throwaway dir
        .env("CLAUDE_CONFIG_DIR", &dir)
        .env("CLAUDE_SECURESTORAGE_CONFIG_DIR", &dir);
        for k in remove {
            cmd.env_remove(k);
        }
        for (k, v) in set {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        println!(
            "[live-claude] exit {} stdout {:?} stderr {:?}",
            out.status,
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(400)
                .collect::<String>()
        );
        assert!(out.status.success());
    }

    /// Opt-in, real Claude Code through the router to the real routed provider, checking the two things Ash saw:
    /// the window Claude Code believes, and whether a tool-calling turn reports a whole-turn total as its level.
    /// Needs the model's key saved (add it once in the app).
    ///
    /// `MONOCODE_LIVE_ROUTE=custom-mva0kfwr1s1b MONOCODE_REAL_BASE=https://lighthouse.dphn.ai/run/text-v/v1
    ///  MONOCODE_REAL_MODEL=deepseek-ai/DeepSeek-V4.1-Flash cargo test live_routed_window -- --nocapture`
    #[test]
    fn live_routed_session_reports_the_real_window() {
        let Ok(custom_model_id) = std::env::var("MONOCODE_LIVE_ROUTE") else {
            return;
        };
        let (Ok(base_url), Ok(model_id)) = (
            std::env::var("MONOCODE_REAL_BASE"),
            std::env::var("MONOCODE_REAL_MODEL"),
        ) else {
            println!("[live-route] set MONOCODE_REAL_BASE and MONOCODE_REAL_MODEL too");
            return;
        };
        let r = route("custom", &base_url, &model_id);
        let key = read_key_in(KEY_SERVICE, &custom_model_id).unwrap();
        let token = session_token("custom", key.as_deref()).unwrap();
        let port = start_router(r.clone(), token.clone()).unwrap();
        let window = remembered_window(&r, key.as_deref());
        println!("[live-route] window from the provider: {window:?}");
        assert_eq!(window, Some(1048576));

        // Told the window: Claude Code believes it.
        let with = one_routed_turn(&r, &token, port, window, &model_id);
        println!(
            "[live-route] num_turns={:?} contextWindow={:?} iterations={:?}",
            with.0, with.1, with.2
        );
        assert_eq!(
            with.1,
            Some(1048576),
            "Claude Code must be told the real window, not its 200K assumption"
        );
        // The control: with no window named — exactly the code path before this fix — Claude Code is back to
        // assuming 200K. This is what proves the 1M above comes from the variable and nothing else.
        let without = one_routed_turn(&r, &token, port, None, &model_id);
        println!("[live-route] control: contextWindow={:?}", without.1);
        assert_eq!(
            without.1,
            Some(200000),
            "without the window named, Claude Code's own assumption is 200K"
        );
    }

    /// One real Claude Code turn through the router. Answers `(num_turns, contextWindow, iterations)`.
    fn one_routed_turn(
        r: &CustomRoute,
        token: &str,
        port: u16,
        window: Option<u64>,
        model_id: &str,
    ) -> (Option<u64>, Option<u64>, Value) {
        let (set, remove) = routed_env(r, token, port, window);
        let dir = std::env::temp_dir().join(format!(
            "monocode-live-route-{}-{window:?}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cmd = std::process::Command::new("claude");
        cmd.args([
            "-p",
            "Read the file package.json and tell me the version field, one line.",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            model_id,
        ])
        .current_dir("/Users/ash/Worktrees/monocode-hub-context-fix")
        .env("CLAUDE_CONFIG_DIR", &dir)
        .env("CLAUDE_SECURESTORAGE_CONFIG_DIR", &dir);
        for k in remove {
            cmd.env_remove(k);
        }
        for (k, v) in set {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(out.status.success());
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let result = stdout
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find(|v| v["type"] == "result")
            .expect("a result line");
        let window_seen = result["modelUsage"]
            .as_object()
            .and_then(|m| m.values().next().cloned())
            .and_then(|e| e["contextWindow"].as_u64());
        (
            result["num_turns"].as_u64(),
            window_seen,
            result["usage"]["iterations"].clone(),
        )
    }
}
