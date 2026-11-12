//! "Other models" for Claude Code: keys, key checks and a tiny local router.
//!
//! * Keys live in the Keychain under `monocode-hub:model-key` (tests: `monocode-hub-test:model-key`; a dev copy:
//!   `monocode-hub-dev:model-key`, see hub_keychain.rs), one item per custom model. A key goes in from the webview
//!   and never comes back out; only the router reads it, in this process.
//! * `model_key_test` asks the model to call one tool and answers in plain words. The key is not in the answer.
//! * For a session on a custom model, Claude Code starts with `ANTHROPIC_BASE_URL` pointing at a router on
//!   127.0.0.1 (random port) that turns Anthropic Messages (text, streaming, tools) into OpenAI chat completions for
//!   that provider. The model's own key is the auth token, so Claude Code never uses Ash's claude.ai login for it,
//!   and the router refuses anything that looks like a Claude credential. Claude models are never routed.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const KEY_SERVICE: &str = "monocode-hub:model-key";
#[cfg(test)]
pub const TEST_KEY_SERVICE: &str = "monocode-hub-test:model-key";

const KEY_FAILED: &str = "That key didn't work";
const TOOLS_YES: &str = "This model can use tools.";
const TOOLS_NO: &str = "This model answers, but it cannot use tools, so Claude Code cannot use it.";
const ENDPOINT_DOWN: &str = "Couldn't reach that endpoint.";
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
        ("CLAUDE_CODE_SUBAGENT_MODEL", m.clone()),
        ("CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL", m),
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
    let mut request = agent_no_redirects(5).get(&models_url(provider, base_url));
    if provider != "ollama" && !key.trim().is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", key.trim()));
    }
    let response = request.call().ok()?;
    if response.status() >= 300 {
        return None;
    }
    let body = response.into_string().ok()?;
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

/// Save a key under its account. With a route whose address is usable, the item also keeps that provider and
/// address (WP-129), so the key can only be sent back to it. Without one the plain key is stored, which is unbound.
pub fn save_key_in(
    service: &str,
    custom_model_id: &str,
    key: &str,
    route: Option<&CustomRoute>,
) -> Result<(), String> {
    save_key_with(
        service,
        custom_model_id,
        key,
        route,
        &crate::hub_keychain::store,
    )
}

/// `save_key_in` with the Keychain write passed in (tests use a fake). A saved key replaces the account's routers
/// (WP-129 L1): the old key's router tokens stop working.
pub(crate) fn save_key_with(
    service: &str,
    custom_model_id: &str,
    key: &str,
    route: Option<&CustomRoute>,
    store: &dyn Fn(&str, &str, &str) -> Result<(), String>,
) -> Result<(), String> {
    check_model_id(custom_model_id)?;
    let key = key.trim();
    if looks_like_claude_credential(key) {
        return Err(
            "That looks like a Claude key; Other models need the provider's own key.".into(),
        );
    }
    let item = crate::key_binding::item_for_save(key, route, custom_model_id);
    store(service, custom_model_id, &item)?;
    stop_routers_for(custom_model_id);
    Ok(())
}

/// The raw Keychain item for an account. Only `key_binding` reads it, and only through `bound_key`.
pub(crate) fn read_key_in(service: &str, custom_model_id: &str) -> Result<Option<String>, String> {
    check_model_id(custom_model_id)?;
    crate::hub_keychain::read(service, custom_model_id)
}

#[tauri::command]
pub async fn model_key_save(
    custom_model_id: String,
    key: String,
    provider: Option<String>,
    model_id: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // WP-129: the address saved with the key is the only host it may be sent to, and it lives in the same
        // Keychain item. A new key replaces the old item, so it never keeps the old key's host. A missing or bad
        // address does not undo the save: Other models still use the key, and short text will not.
        let route = match (provider, model_id, base_url) {
            (Some(provider), Some(model_id), Some(base_url)) => Some(CustomRoute {
                provider,
                base_url,
                model_id,
                custom_model_id: custom_model_id.clone(),
                reasoning_effort: None,
            }),
            _ => None,
        };
        save_key_in(KEY_SERVICE, &custom_model_id, &key, route.as_ref())
    })
    .await
    .map_err(|_| "Couldn't reach the Keychain.".to_string())?
}

/// What removing a model's key means to the UI: deleted, or there was no key to begin with, are both success (true).
/// Only a real Keychain error is a failure, and it comes back as an error the UI shows.
pub fn delete_outcome(result: Result<bool, String>) -> Result<bool, String> {
    result.map(|_deleted_or_missing| true)
}

pub fn delete_key_in(service: &str, custom_model_id: &str) -> Result<bool, String> {
    delete_key_with(service, custom_model_id, &crate::hub_keychain::delete)
}

/// `delete_key_in` with the Keychain delete passed in (tests use a fake). A deleted key stops the account's routers
/// (WP-129 L1).
pub(crate) fn delete_key_with(
    service: &str,
    custom_model_id: &str,
    delete: &dyn Fn(&str, &str) -> Result<bool, String>,
) -> Result<bool, String> {
    check_model_id(custom_model_id)?;
    // The address is inside the item, so deleting the item deletes it too.
    let result = delete_outcome(delete(service, custom_model_id));
    if result.is_ok() {
        stop_routers_for(custom_model_id);
    }
    result
}

/// The address a key was saved with, for the Other models list and the memory picker (WP-129). An address is not
/// a secret, so it may go to the webview; the key never does. `None` for a key saved without a usable address.
pub fn address_in(service: &str, custom_model_id: &str) -> Result<Option<String>, String> {
    check_model_id(custom_model_id)?;
    let read = |account: &str| read_key_in(service, account);
    Ok(crate::key_binding::read_sealed(&read, custom_model_id)?
        .map(|sealed| sealed.binding.base_url))
}

#[tauri::command]
pub async fn model_key_address(custom_model_id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || address_in(KEY_SERVICE, &custom_model_id))
        .await
        .map_err(|_| "Couldn't reach the Keychain.".to_string())?
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
        .redirects(0)
        .build()
}

/// For a call that carries a key to one address: a redirect is not followed, so the key is never offered to the
/// address the provider named. A 3xx answer comes back as a response, and the caller treats it as a failure.
fn agent_no_redirects(read_secs: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(read_secs))
        .timeout_write(Duration::from_secs(30))
        .redirects(0)
        .build()
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "the provider".into())
}

/// What is wrong with the request itself, before anything is sent. Ollama is left to its caller: an empty model
/// there is a tags check, and a named model is a tool check. The same sentences as `test_key` has always used.
fn refuse_before_request(
    provider: &str,
    base_url: &str,
    model: &str,
    key: &str,
) -> Option<KeyTestResult> {
    if !PROVIDERS.contains(&provider) {
        return Some(fail("Pick a provider"));
    }
    if !valid_base_url(provider, base_url) {
        return Some(fail(
            "The base URL needs https:// (http:// only for this Mac)",
        ));
    }
    if provider == "ollama" {
        return None;
    }
    if key.trim().is_empty() {
        return Some(fail("Add the key"));
    }
    if looks_like_claude_credential(key) {
        return Some(fail(
            "That looks like a Claude key; use the provider's own key",
        ));
    }
    if model.is_empty() {
        return Some(fail("Add the model id"));
    }
    None
}

pub fn test_key(provider: &str, base_url: &str, model_id: &str, key: &str) -> KeyTestResult {
    let model = model_id.trim();
    if let Some(refused) = refuse_before_request(provider, base_url, model, key) {
        return refused;
    }
    if provider == "ollama" {
        return test_ollama(base_url, model);
    }
    let url = chat_url(provider, base_url);
    let body = json!({"model": model, "messages": [{"role": "user", "content": "Say ok"}], "max_tokens": 1, "stream": false});
    let result = agent_no_redirects(30)
        .post(&url)
        .set("Authorization", &format!("Bearer {}", key.trim()))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());
    match result {
        Ok(response) if response.status() >= 300 => fail(
            "That address answered with a redirect, and the key isn't sent on to another address",
        ),
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
    match agent_no_redirects(5)
        .get(&format!("{base}/api/tags"))
        .call()
    {
        Ok(resp) if resp.status() >= 300 => fail(OLLAMA_DOWN),
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

fn probe_agent(read: Duration) -> ureq::Agent {
    let capped = if read.is_zero() {
        Duration::from_millis(1)
    } else {
        read
    };
    ureq::AgentBuilder::new()
        .timeout_connect(capped.min(Duration::from_secs(10)))
        .timeout_read(capped)
        .timeout_write(capped.min(Duration::from_secs(30)))
        .redirects(0)
        .build()
}

fn post_chat(
    agent: &ureq::Agent,
    url: &str,
    key: &str,
    body: &Value,
) -> Result<ureq::Response, Box<ureq::Error>> {
    agent
        .post(url)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(Box::new)
}

/// At most 64KB, then dropped. A provider can echo the key; it must not be kept or logged.
fn response_text(resp: ureq::Response) -> String {
    let mut buf = Vec::new();
    let _ = resp.into_reader().take(64 * 1024).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

fn tool_probe_body(model: &str) -> Value {
    json!({
        "model": model,
        "messages": [{"role": "user", "content": "Call the ping tool."}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "ping",
                "description": "Confirm you can use tools.",
                "parameters": {"type": "object", "properties": {}}
            }
        }],
        "tool_choice": "required",
        "max_tokens": 64,
        "stream": false
    })
}

fn plain_probe_body(model: &str) -> Value {
    json!({"model": model, "messages": [{"role": "user", "content": "Say ok"}], "max_tokens": 1, "stream": false})
}

fn call_name(name: Option<&str>) -> bool {
    name.is_some_and(|text| !text.trim().is_empty())
}

fn call_has_name(call: &Value) -> bool {
    call_name(call["function"]["name"].as_str()) || call_name(call["name"].as_str())
}

/// A real tool call: a non-empty name in `tool_calls`, or the older `function_call`. An empty list is not one,
/// even when `finish_reason` says `tool_calls`.
fn called_a_tool(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    let message = &value["choices"][0]["message"];
    if message["tool_calls"]
        .as_array()
        .is_some_and(|calls| calls.iter().any(call_has_name))
    {
        return true;
    }
    call_name(message["function_call"]["name"].as_str())
}

fn tool_or_not(text: &str) -> KeyTestResult {
    if called_a_tool(text) {
        ok(TOOLS_YES)
    } else {
        fail(TOOLS_NO)
    }
}

fn unknown_model(model: &str) -> KeyTestResult {
    fail(format!("The provider doesn't know the model id {model}"))
}

fn status_result(status: u16, model: &str) -> KeyTestResult {
    match status {
        401 | 403 => fail(KEY_FAILED),
        404 => unknown_model(model),
        400 | 422 => fail("The provider turned the test down"),
        402 => fail("The key works but the account has no credit"),
        429 => fail("The key works but the provider is rate-limiting it right now"),
        code => fail(format!(
            "The provider had a problem (error {code}); try again"
        )),
    }
}

/// A 2xx is the model's answer. ureq returns a redirect as `Ok` when none are followed, and that is not an answer.
fn read_answer(resp: ureq::Response, model: &str) -> Result<KeyTestResult, (u16, KeyTestResult)> {
    let status = resp.status();
    let text = response_text(resp);
    if (200..300).contains(&status) {
        Ok(tool_or_not(&text))
    } else {
        Err((status, status_result(status, model)))
    }
}

/// The tools request was rejected. One plain request decides whether the model answers at all.
/// A timeout or a dropped connection here is not "no tools": the endpoint did not answer.
fn plain_followup(agent: &ureq::Agent, url: &str, key: &str, model: &str) -> KeyTestResult {
    match post_chat(agent, url, key, &plain_probe_body(model)) {
        Ok(resp) => read_answer(resp, model).unwrap_or_else(|(_, result)| result),
        Err(err) => match *err {
            ureq::Error::Status(401 | 403, _) => fail(KEY_FAILED),
            ureq::Error::Status(404, _) => unknown_model(model),
            ureq::Error::Status(402, _) => fail("The key works but the account has no credit"),
            ureq::Error::Status(429, _) => {
                fail("The key works but the provider is rate-limiting it right now")
            }
            ureq::Error::Transport(_) => fail(ENDPOINT_DOWN),
            ureq::Error::Status(_, _) => fail("The provider turned the test down"),
        },
    }
}

fn probe_tools(provider: &str, base_url: &str, model_id: &str, key: &str) -> KeyTestResult {
    probe_tools_in(provider, base_url, model_id, key, Duration::from_secs(30))
}

fn probe_tools_in(
    provider: &str,
    base_url: &str,
    model_id: &str,
    key: &str,
    read: Duration,
) -> KeyTestResult {
    let model = model_id.trim();
    if let Some(refused) = refuse_before_request(provider, base_url, model, key) {
        return refused;
    }
    if provider == "ollama" && model.is_empty() {
        return test_ollama(base_url, model);
    }
    // A Claude credential is never sent, including to a local Ollama that was given one by mistake.
    if looks_like_claude_credential(key) {
        return fail("That looks like a Claude key; use the provider's own key");
    }
    let bearer = if key.trim().is_empty() {
        OLLAMA_TOKEN
    } else {
        key.trim()
    };
    let url = chat_url(provider, base_url);
    let http = probe_agent(read);
    match post_chat(&http, &url, bearer, &tool_probe_body(model)) {
        Ok(resp) => match read_answer(resp, model) {
            Ok(answer) => answer,
            // The server rejected the tool request. One plain request sees whether it answers at all.
            Err((400 | 422, _)) => plain_followup(&http, &url, bearer, model),
            Err((_, result)) => result,
        },
        Err(err) => match *err {
            ureq::Error::Status(401 | 403, _) => fail(KEY_FAILED),
            ureq::Error::Status(404, _) => unknown_model(model),
            ureq::Error::Status(400 | 422, resp) => {
                let _ = response_text(resp);
                plain_followup(&http, &url, bearer, model)
            }
            ureq::Error::Status(402, _) => fail("The key works but the account has no credit"),
            ureq::Error::Status(429, _) => {
                fail("The key works but the provider is rate-limiting it right now")
            }
            ureq::Error::Status(code, _) => fail(format!(
                "The provider had a problem (error {code}); try again"
            )),
            ureq::Error::Transport(_) => fail(ENDPOINT_DOWN),
        },
    }
}

/// Asks the model to call one tool. The key is sent to that endpoint and is not part of the answer.
/// A cheap-memory check still uses `test_key`: that one only needs a reply, not tools.
#[tauri::command]
pub async fn model_key_test(
    provider: String,
    base_url: String,
    model_id: String,
    key: String,
) -> Result<KeyTestResult, String> {
    tauri::async_runtime::spawn_blocking(move || probe_tools(&provider, &base_url, &model_id, &key))
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
/// The window lookup for a route the webview gave. A model's key is read, and the provider asked, only when the
/// route has the provider and the address stored with the key (WP-129). Anything else is "unknown". Ollama has
/// no key, so it passes through. `read_key` and `lookup` are the Keychain and the network; tests stand in for both.
pub fn context_window_in(
    route: &CustomRoute,
    read_item: crate::key_binding::ItemReader,
    lookup: impl FnOnce(&CustomRoute, Option<&str>) -> Option<u64>,
) -> Option<u64> {
    let (route, key) = crate::key_binding::bound_key(route, read_item).ok()??;
    lookup(&route, key.as_deref())
}

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
        // No key is not an error for a window lookup: the answer is simply unknown.
        Ok(context_window_in(
            &route,
            &crate::key_binding::keychain_item,
            remembered_window,
        ))
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

/// One router. `upstream` is the key (or the Ollama stand-in) the router sends to the provider; `token` is the random
/// token the child process is given instead of the key. The child never sees the key.
struct Running {
    port: u16,
    upstream: String,
    route: CustomRoute,
    /// One token per live session (WP-129 L2). A session's token leaves this set when the session ends.
    tokens: Arc<Mutex<HashSet<String>>>,
    /// Set when the account's key is deleted or replaced (L1): the accept loop exits and takes no more connections.
    stop: Arc<AtomicBool>,
}

/// One routed session's router token. The router takes it until this is dropped, which is when the session's
/// stdout ends, so a token never outlives its session (WP-129 L2). Not Debug: the token is a credential.
pub struct SessionToken {
    token: String,
    tokens: Arc<Mutex<HashSet<String>>>,
}

impl SessionToken {
    pub fn value(&self) -> &str {
        &self.token
    }
}

impl Drop for SessionToken {
    fn drop(&mut self) {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.token);
    }
}

/// Test helper: a session token tied to no router.
#[cfg(test)]
pub(crate) fn test_session_token(token: &str) -> SessionToken {
    SessionToken {
        token: token.to_string(),
        tokens: Arc::new(Mutex::new(HashSet::new())),
    }
}

/// A random token for one router (256 bits from the OS). Useless anywhere but that router.
fn new_child_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

static ROUTERS: Mutex<Vec<Running>> = Mutex::new(Vec::new());

/// The router for this route and upstream key, started on first use (127.0.0.1, random port). Returns its port and
/// the token the child must send to it.
pub fn ensure_router(route: &CustomRoute, upstream: &str) -> Result<(u16, SessionToken), String> {
    if !may_route(route) {
        return Err("This model isn't routed: Claude models always use your Claude login.".into());
    }
    let mut routers = ROUTERS.lock().unwrap_or_else(|e| e.into_inner());
    let index = match routers
        .iter()
        .position(|r| &r.route == route && r.upstream == upstream)
    {
        Some(index) => index,
        None => {
            let tokens = Arc::new(Mutex::new(HashSet::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let port = start_router_with(
                route.clone(),
                upstream.to_string(),
                tokens.clone(),
                stop.clone(),
            )?;
            routers.push(Running {
                port,
                upstream: upstream.to_string(),
                route: route.clone(),
                tokens,
                stop,
            });
            routers.len() - 1
        }
    };
    let running = &routers[index];
    let token = new_child_token();
    running
        .tokens
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(token.clone());
    let session = SessionToken {
        token,
        tokens: running.tokens.clone(),
    };
    Ok((running.port, session))
}

/// Stops the routers of one account (its key was deleted or replaced, WP-129 L1): their tokens stop working, and their
/// accept loops exit. Routers of other accounts are kept.
fn stop_routers_for(custom_model_id: &str) {
    let mut routers = ROUTERS.lock().unwrap_or_else(|e| e.into_inner());
    routers.retain(|r| {
        if r.route.custom_model_id != custom_model_id {
            return true;
        }
        r.stop.store(true, Ordering::SeqCst);
        r.tokens.lock().unwrap_or_else(|e| e.into_inner()).clear();
        // One connection wakes the accept loop, which then sees the stop flag and returns.
        let _ = TcpStream::connect(("127.0.0.1", r.port));
        false
    });
}

/// A router that takes one fixed token (the tests' form). Routed sessions use `ensure_router`.
#[cfg(test)]
pub fn start_router(route: CustomRoute, upstream: String, token: String) -> Result<u16, String> {
    let tokens = Arc::new(Mutex::new(HashSet::from([token])));
    start_router_with(route, upstream, tokens, Arc::new(AtomicBool::new(false)))
}

fn start_router_with(
    route: CustomRoute,
    upstream: String,
    tokens: Arc<Mutex<HashSet<String>>>,
    stop: Arc<AtomicBool>,
) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Couldn't start the model router.".to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::Builder::new()
        .name(format!("model-router-{port}"))
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let route = route.clone();
                let tokens = tokens.clone();
                let upstream = upstream.clone();
                let _ = std::thread::Builder::new().spawn(move || {
                    let _ = handle(stream, &route, &tokens, &upstream);
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

/// The key as it can appear in an upstream error: as it is, and as JSON writes it (a quote or backslash escaped, a
/// slash escaped as `\/` or as `/`).
fn key_forms(token: &str) -> Vec<String> {
    let mut forms = vec![token.to_string()];
    let json = serde_json::to_string(token).unwrap_or_default();
    let json = json
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(&json)
        .to_string();
    for form in [
        json.replace('/', "\\/"),
        json.replace('/', "\\u002f"),
        json.clone(),
    ] {
        if !forms.contains(&form) {
            forms.push(form);
        }
    }
    forms
}

/// Redacts the key from an upstream error before it goes back to Claude Code. Every spelling of the key is replaced
/// first, then the text is cut to 400 characters, then any prefix of a key that the cut split off the end is dropped
/// (the start of a key the upstream sent in full would otherwise be left behind).
fn scrub(text: &str, token: &str) -> String {
    if token.len() < 4 {
        return text.chars().take(400).collect();
    }
    let forms = key_forms(token);
    let mut replaced = text.to_string();
    for form in &forms {
        replaced = replaced.replace(form.as_str(), "***");
    }
    let mut t: String = replaced.chars().take(400).collect();
    for form in &forms {
        let cut = (1..form.len())
            .rev()
            .find(|&k| form.is_char_boundary(k) && t.ends_with(&form[..k]));
        if let Some(k) = cut {
            t.truncate(t.len() - k);
        }
    }
    t
}

/// Accepts a request that carries one of the live session tokens (WP-129 L2). A Claude login is refused as before.
fn authorize_any(
    headers: &HashMap<String, String>,
    live: &[String],
) -> Result<(), (u16, &'static str)> {
    if live
        .iter()
        .any(|token| !token.is_empty() && authorize(headers, token).is_ok())
    {
        return Ok(());
    }
    if looks_like_claude_credential(&incoming_token(headers).unwrap_or_default()) {
        return Err((403, "The model router never forwards a Claude login."));
    }
    Err((
        401,
        "This router only serves the session it was started for.",
    ))
}

fn handle(
    mut stream: TcpStream,
    route: &CustomRoute,
    tokens: &Mutex<HashSet<String>>,
    upstream: &str,
) -> std::io::Result<()> {
    let req = read_request(&mut stream)?;
    let live: Vec<String> = tokens
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .cloned()
        .collect();
    if let Err((status, message)) = authorize_any(&req.headers, &live) {
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
        "/v1/messages" => forward(&mut stream, route, upstream, &body),
        // "Connect any model to any harness": agents that speak the OpenAI API themselves (Codex, OpenCode, Hermes)
        // use the same router. Nothing is translated: the body goes to the provider as it came, on the saved model,
        // with the session token swapped for the key.
        "/v1/chat/completions" | "/v1/responses" => {
            passthrough(&mut stream, route, upstream, path, &body)
        }
        _ => respond(
            &mut stream,
            404,
            &anthropic_error("not_found_error", "Not here."),
        ),
    }
}

/// Levels a model refused, by route (window_key) and level, for as long as the app runs. Every custom model offers
/// every level unless Ash narrows it, but not every provider or model takes the field: xAI, for one, answers 400 for
/// a model without reasoning control, and some providers take only some levels. Once refused, later requests for that
/// model at that level leave it out at once. Kept per level, so one refused level never silently drops another.
static REFUSES_EFFORT: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn refuses_effort(route: &CustomRoute, effort: &str) -> bool {
    let name = window_key(route);
    REFUSES_EFFORT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|(n, e)| *n == name && e == effort)
}

fn remember_refuses_effort(route: &CustomRoute, effort: &str) {
    let name = window_key(route);
    let mut known = REFUSES_EFFORT.lock().unwrap_or_else(|e| e.into_inner());
    if !known.iter().any(|(n, e)| *n == name && e == effort) {
        known.push((name, effort.to_string()));
    }
    drop(known);
    announce_refusal(EffortRefusal {
        custom_model_id: route.custom_model_id.clone(),
        provider: route.provider.clone(),
        base_url: route.base_url.trim().to_string(),
        model_id: route.model_id.trim().to_string(),
        effort: effort.to_string(),
    });
}

/// What the webview hears when a provider refused a level: the chat says so in one line, and the model picker marks
/// that level as not supported for that model (a quietly dropped level would be a control that looks live but isn't).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EffortRefusal {
    pub custom_model_id: String,
    pub provider: String,
    pub base_url: String,
    pub model_id: String,
    pub effort: String,
}

/// The webview event carrying an `EffortRefusal` (customModels.ts listens for it).
pub const EFFORT_REFUSED_EVENT: &str = "model-router://effort-refused";

type RefusalListener = Box<dyn Fn(&EffortRefusal) + Send + Sync>;
static REFUSAL_LISTENERS: Mutex<Vec<RefusalListener>> = Mutex::new(Vec::new());

/// Hear every refusal from now on. The app adds one that emits `EFFORT_REFUSED_EVENT`; tests add their own.
pub fn on_effort_refused(listener: impl Fn(&EffortRefusal) + Send + Sync + 'static) {
    REFUSAL_LISTENERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(Box::new(listener));
}

/// Once per app run: refusals reach the webview as `EFFORT_REFUSED_EVENT`.
pub fn announce_refusals_to<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    static WIRED: std::sync::Once = std::sync::Once::new();
    let app = app.clone();
    WIRED.call_once(move || {
        on_effort_refused(move |refusal| {
            use tauri::Emitter;
            let _ = app.emit(EFFORT_REFUSED_EVENT, refusal);
        });
    });
}

fn announce_refusal(refusal: EffortRefusal) {
    for listener in REFUSAL_LISTENERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
    {
        listener(&refusal);
    }
}

/// A 400/422 whose text names the reasoning effort field (`reasoning_effort`, `reasoningEffort`, "reasoning effort").
pub fn is_effort_refusal(code: u16, text: &str) -> bool {
    if code != 400 && code != 422 {
        return false;
    }
    let flat: String = text
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    flat.contains("reasoningeffort")
}

fn forward(
    stream: &mut TcpStream,
    route: &CustomRoute,
    key: &str,
    body: &Value,
) -> std::io::Result<()> {
    let model = route.model_id.trim();
    let mut upstream_body = to_openai(body, model);
    let mut sent_effort: Option<&str> = None;
    if let Some(effort) = &route.reasoning_effort {
        if ["none", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&effort.as_str())
            && !refuses_effort(route, effort)
        {
            upstream_body["reasoning_effort"] = json!(effort);
            sent_effort = Some(effort.as_str());
        }
    }
    let streaming = body["stream"] == true;
    // ureq's own error type; it is matched on right here, never passed further up.
    #[allow(clippy::result_large_err)]
    let send = |payload: &Value| {
        let mut request = agent(600)
            .post(&chat_url(&route.provider, &route.base_url))
            .set("Content-Type", "application/json");
        if route.provider != "ollama" {
            request = request.set("Authorization", &format!("Bearer {key}"));
        }
        request.send_string(&payload.to_string())
    };
    let mut result = send(&upstream_body);
    let mut retried_without = false;
    // Refused for the effort field alone: say it once more without it, and stop sending that level for this model.
    if let Some(effort) = sent_effort {
        if let Err(ureq::Error::Status(code, r)) = result {
            let text = r.into_string().unwrap_or_default();
            if is_effort_refusal(code, &text) {
                // Said before the retry's answer goes back, so the webview hears it ahead of the reply it explains.
                remember_refuses_effort(route, effort);
                if let Some(fields) = upstream_body.as_object_mut() {
                    fields.remove("reasoning_effort");
                }
                retried_without = true;
                result = send(&upstream_body);
            } else {
                record_receipt(route, sent_effort, false, code);
                let text = scrub(&text, key);
                return respond_upstream_error(stream, route, code, &text);
            }
        }
    }
    let resp = match result {
        Ok(r) => {
            record_receipt(route, sent_effort, retried_without, r.status());
            r
        }
        Err(ureq::Error::Status(code, r)) => {
            record_receipt(route, sent_effort, retried_without, code);
            let text = scrub(&r.into_string().unwrap_or_default(), key);
            return respond_upstream_error(stream, route, code, &text);
        }
        Err(ureq::Error::Transport(_)) => {
            record_receipt(route, sent_effort, retried_without, 0);
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
    forward_answer(stream, resp, model, streaming)
}

/// The provider address for an OpenAI-style path the router passes through.
fn passthrough_url(provider: &str, base: &str, path: &str) -> String {
    match path {
        "/v1/responses" => {
            let base = base.trim().trim_end_matches('/');
            if provider == "ollama" && !base.ends_with("/v1") {
                format!("{base}/v1/responses")
            } else {
                format!("{base}/responses")
            }
        }
        _ => chat_url(provider, base),
    }
}

/// Fields a provider reads to run another model than `model` (OpenRouter's fallback list and routing). Dropped, so the
/// saved key only ever runs the saved model.
const OTHER_MODEL_FIELDS: [&str; 4] = ["models", "route", "provider", "plugins"];

/// The body sent on: the caller's own, always on the saved model (the key is saved for that route alone).
pub fn passthrough_body(body: &Value, model_id: &str) -> Value {
    let mut out = body.clone();
    if let Some(fields) = out.as_object_mut() {
        for field in OTHER_MODEL_FIELDS {
            fields.remove(field);
        }
        fields.insert("model".into(), json!(model_id.trim()));
    }
    out
}

fn passthrough(
    stream: &mut TcpStream,
    route: &CustomRoute,
    key: &str,
    path: &str,
    body: &Value,
) -> std::io::Result<()> {
    let payload = passthrough_body(body, &route.model_id);
    let mut request = agent(600)
        .post(&passthrough_url(&route.provider, &route.base_url, path))
        .set("Content-Type", "application/json");
    if route.provider != "ollama" {
        request = request.set("Authorization", &format!("Bearer {key}"));
    }
    let resp = match request.send_string(&payload.to_string()) {
        Ok(resp) => {
            record_receipt(route, None, false, resp.status());
            resp
        }
        Err(ureq::Error::Status(code, r)) => {
            record_receipt(route, None, false, code);
            let text = scrub(&r.into_string().unwrap_or_default(), key);
            return respond(
                stream,
                code,
                &json!({"error": {"message": format!("{} said: {text}", host_of(&route.base_url)), "code": code}}),
            );
        }
        Err(ureq::Error::Transport(_)) => {
            record_receipt(route, None, false, 0);
            return respond(
                stream,
                502,
                &json!({"error": {"message": format!("Couldn't reach {}", host_of(&route.base_url))}}),
            );
        }
    };
    // Redirects are never followed (the key stays on the saved address), and one is not passed on as a success.
    if !(200..300).contains(&resp.status()) {
        return respond(
            stream,
            502,
            &json!({"error": {"message": format!("{} answered with a redirect", host_of(&route.base_url))}}),
        );
    }
    let content_type = resp
        .header("content-type")
        .unwrap_or("application/json")
        .replace(['\r', '\n'], "");
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
    )?;
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 8192];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        stream.write_all(&buf[..n])?;
        stream.flush()?;
    }
    Ok(())
}

/// Where each routed request leaves a one-line receipt (E1, 22 Oct: show that the chosen effort reaches the
/// provider). Only what was asked of whom and the answer's status: never the key, a header or any message text.
const RECEIPTS_MAX_BYTES: u64 = 256 * 1024;

fn receipts_path() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("MONOCODE_ROUTER_RECEIPTS") {
        return Some(path.into());
    }
    if cfg!(test) {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    Some(std::path::Path::new(&home).join("Library/Logs/MonoCode Hub/model-router.jsonl"))
}

/// The receipt's line: `sent_effort` is what went out with the request that answered (none after a retry without it).
fn receipt_line(
    route: &CustomRoute,
    sent_effort: Option<&str>,
    retried_without: bool,
    status: u16,
) -> Value {
    json!({
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "provider": route.provider,
        "host": host_of(&route.base_url),
        "model": route.model_id.trim(),
        "chosenEffort": route.reasoning_effort,
        "sentEffort": if retried_without { None } else { sent_effort },
        "retriedWithoutEffort": retried_without,
        "status": status,
    })
}

fn record_receipt(
    route: &CustomRoute,
    sent_effort: Option<&str>,
    retried_without: bool,
    status: u16,
) {
    let Some(path) = receipts_path() else { return };
    let line = receipt_line(route, sent_effort, retried_without, status).to_string();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Small and recent: past the cap the file starts again.
    let fresh = std::fs::metadata(&path)
        .map(|m| m.len() > RECEIPTS_MAX_BYTES)
        .unwrap_or(false);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(!fresh)
        .write(true)
        .truncate(fresh)
        .open(&path);
    if let Ok(mut file) = file {
        let _ = writeln!(file, "{line}");
    }
}

fn respond_upstream_error(
    stream: &mut TcpStream,
    route: &CustomRoute,
    code: u16,
    text: &str,
) -> std::io::Result<()> {
    let kind = match code {
        401 | 403 => "authentication_error",
        429 => "rate_limit_error",
        400 | 404 | 422 => "invalid_request_error",
        _ => "api_error",
    };
    respond(
        stream,
        code,
        &anthropic_error(kind, &format!("{} said: {text}", host_of(&route.base_url))),
    )
}

fn forward_answer(
    stream: &mut TcpStream,
    resp: ureq::Response,
    model: &str,
    streaming: bool,
) -> std::io::Result<()> {
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
pub fn prepare_routed_session(route: &CustomRoute) -> Result<(RoutedEnv, SessionToken), String> {
    prepare_routed_session_in(route, &crate::key_binding::keychain_item)
}

/// `prepare_routed_session` without asking the provider for the model's window: no network call at start. For Pi
/// and Oh My Pi, which get every saved model at each start (src/pi_routes.rs) and assume a window themselves.
pub fn prepare_routed_session_quick(
    route: &CustomRoute,
) -> Result<(RoutedEnv, SessionToken), String> {
    prepare_routed_session_with(route, &crate::key_binding::keychain_item, false)
}

/// The routed session for `route`, with the key read through `read_key`. The key is read only for the provider and
/// address stored with it (WP-129), and the router is started at that stored address, never the caller's.
pub(crate) fn prepare_routed_session_in(
    route: &CustomRoute,
    read_item: crate::key_binding::ItemReader,
) -> Result<(RoutedEnv, SessionToken), String> {
    prepare_routed_session_with(route, read_item, true)
}

fn prepare_routed_session_with(
    route: &CustomRoute,
    read_item: crate::key_binding::ItemReader,
    ask_window: bool,
) -> Result<(RoutedEnv, SessionToken), String> {
    if !may_route(route) {
        return Err("This model isn't routed: Claude models always use your Claude login.".into());
    }
    // The route is the stored one, rebuilt from its parsed address. A key with nothing stored, or a route that
    // names another provider or address, gets no session at all.
    let Some((route, key)) = crate::key_binding::bound_key(route, read_item)? else {
        return Err(crate::key_binding::NOT_STORED_FOR_THIS.into());
    };
    // The key is the router's upstream credential and never leaves this process: the child is given a random
    // token that only the router accepts (WP-129).
    let upstream = session_token(&route.provider, key.as_deref())?;
    let (port, session) = ensure_router(&route, &upstream)?;
    // The provider's own window for this model, asked once per route. Nothing here may fail the spawn: a session on
    // an assumed-200K window is still a working session.
    let window = if ask_window {
        remembered_window(&route, key.as_deref())
    } else {
        None
    };
    Ok((routed_env(&route, session.value(), port, window), session))
}

// ---- quick pick: one short completion for a room's auto responder (WP-22) -----------------------------------------------

/// The longest a quick pick may take, whatever the caller asks: the room falls back to its lead after 1.5 s anyway.
const QUICK_PICK_MAX_MS: u64 = 1_500;

/// The request a quick pick sends: a tiny, deterministic chat completion.
pub fn quick_pick_body(model_id: &str, system: &str, prompt: &str) -> Value {
    json!({
        "model": model_id.trim(),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 80,
        "temperature": 0,
        "stream": false
    })
}

/// One short completion from a model Ash configured (never a Claude model, never a CLI session), with a hard
/// deadline for the whole request. The room's auto responder reads the answer; any error means "the lead answers".
pub fn quick_complete(
    route: &CustomRoute,
    key: Option<&str>,
    system: &str,
    prompt: &str,
    timeout_ms: u64,
) -> Result<String, String> {
    if !may_route(route) {
        return Err("That model can't be used for a quick pick.".into());
    }
    let token = session_token(&route.provider, key)?;
    let deadline = Duration::from_millis(timeout_ms.clamp(1, QUICK_PICK_MAX_MS));
    let body = quick_pick_body(&route.model_id, system, prompt);
    // The key goes to this one URL. A redirect is not followed, so the key is never offered to the address
    // the provider named, and any 3xx answer is an error here.
    let response = ureq::AgentBuilder::new()
        .timeout(deadline)
        .redirects(0)
        .build()
        .post(&chat_url(&route.provider, &route.base_url))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("The quick model answered with error {code}."),
            ureq::Error::Transport(_) => "The quick model didn't answer in time.".to_string(),
        })?;
    if response.status() >= 300 {
        return Err(format!(
            "The quick model answered with error {}.",
            response.status()
        ));
    }
    let value: Value = response
        .into_string()
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| "The quick model's answer couldn't be read.".to_string())?;
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "The quick model gave no text.".to_string())
}

/// The quick pick for a route the webview gave. A model's key is read, and a request made, only when the
/// route has the provider and the address that were stored when the key was saved (WP-129). Ollama has no
/// key, so it passes through. `read_key` and `send` are the Keychain and the network; tests stand in for both.
pub fn quick_pick_in(
    route: &CustomRoute,
    read_item: crate::key_binding::ItemReader,
    send: impl FnOnce(&CustomRoute, Option<&str>) -> Result<String, String>,
) -> Result<String, String> {
    if !may_route(route) {
        return Err("That model can't be used for a quick pick.".into());
    }
    let Some((route, key)) = crate::key_binding::bound_key(route, read_item)? else {
        return Err(crate::key_binding::NOT_STORED_FOR_THIS.into());
    };
    send(&route, key.as_deref())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn model_quick_pick(
    provider: String,
    base_url: String,
    model_id: String,
    custom_model_id: String,
    system: String,
    prompt: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let route = CustomRoute {
            provider,
            base_url,
            model_id,
            custom_model_id,
            reasoning_effort: None,
        };
        quick_pick_in(&route, &crate::key_binding::keychain_item, |bound, key| {
            quick_complete(
                bound,
                key,
                &system,
                &prompt,
                timeout_ms.unwrap_or(QUICK_PICK_MAX_MS),
            )
        })
    })
    .await
    .map_err(|_| "The quick pick didn't finish.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The model-key Keychain for these tests: one sealed item per saved route, holding `TEST_KEY`.
    fn keychain_with(saved: &[CustomRoute]) -> impl Fn(&str) -> Result<Option<String>, String> {
        crate::key_binding::fake_keychain(
            saved
                .iter()
                .map(|r| {
                    (
                        r.custom_model_id.clone(),
                        crate::key_binding::sealed_item(r, TEST_KEY),
                    )
                })
                .collect(),
        )
    }

    const TEST_KEY: &str = "test-key1234";

    /// The addresses a key must never be sent to when it was saved for `https://llm.example/v1`.
    const WRONG_ADDRESSES: &[&str] = &[
        "https://evil.example/v1",
        "https://llm.example@evil.example/v1",
        "https://user@llm.example/v1",
        "https://user:pw@llm.example/v1",
        "https://llm.example.evil.example/v1",
        "https://evil.example\\@llm.example/v1",
        "https://llm.example:8443/v1",
        "https://llm.example/v1/extra",
        "https://llm.example/v1?x=1",
        "https://llm.example/v1#x",
        "http://llm.example/v1",
        "https://sub.llm.example/v1",
    ];

    fn stored_route() -> CustomRoute {
        let mut saved = route("custom", "https://llm.example/v1", "grok-fast");
        saved.custom_model_id = "custom-1".into();
        saved
    }

    #[test]
    fn a_quick_pick_gets_the_key_only_for_the_address_stored_with_it() {
        let saved = stored_route();
        let store = keychain_with(std::slice::from_ref(&saved));
        let run = |given: &CustomRoute| {
            let sent = std::cell::RefCell::new(None);
            let out = quick_pick_in(given, &store, |r, key| {
                *sent.borrow_mut() = Some((r.base_url.clone(), key.map(str::to_string)));
                Ok("picked".to_string())
            });
            (out, sent.into_inner())
        };
        // The address it was saved with, written another way, goes to the saved address.
        let mut same = saved.clone();
        same.base_url = "https://LLM.Example./v1/".into();
        let (out, sent) = run(&same);
        assert_eq!(out, Ok("picked".to_string()));
        assert_eq!(
            sent,
            Some((
                "https://llm.example/v1".to_string(),
                Some(TEST_KEY.to_string())
            ))
        );
        for base in WRONG_ADDRESSES {
            let mut given = saved.clone();
            given.base_url = (*base).into();
            let (out, sent) = run(&given);
            assert!(out.is_err(), "{base}: {out:?}");
            assert_eq!(sent, None, "{base}");
        }
        // Another account, another provider, and a key with nothing stored at all.
        let mut other_account = saved.clone();
        other_account.custom_model_id = "custom-2".into();
        let mut other_provider = saved.clone();
        other_provider.provider = "openrouter".into();
        let unsaved = route("xai", "https://api.x.ai/v1", "grok-4-fast");
        for given in [other_account, other_provider, unsaved] {
            let (out, sent) = run(&given);
            assert!(out.is_err(), "{given:?}");
            assert_eq!(sent, None, "{given:?}");
        }
        // A plain key (saved with no address) is unbound and is never sent.
        let plain = |_: &str| Ok(Some(TEST_KEY.to_string()));
        let out = quick_pick_in(&saved, &plain, |_, _| Ok("sent".to_string()));
        assert_eq!(
            out,
            Err(crate::key_binding::NOT_STORED_FOR_THIS.to_string())
        );
    }

    #[test]
    fn a_context_window_gets_the_key_only_for_the_address_stored_with_it() {
        let saved = stored_route();
        let store = keychain_with(std::slice::from_ref(&saved));
        let run = |given: &CustomRoute| {
            let looked = std::cell::RefCell::new(None);
            let out = context_window_in(given, &store, |r, key| {
                *looked.borrow_mut() = Some((r.base_url.clone(), key.map(str::to_string)));
                Some(1_000_000)
            });
            (out, looked.into_inner())
        };
        let mut same = saved.clone();
        same.base_url = "https://LLM.Example./v1/".into();
        let (out, looked) = run(&same);
        assert_eq!(out, Some(1_000_000));
        assert_eq!(
            looked,
            Some((
                "https://llm.example/v1".to_string(),
                Some(TEST_KEY.to_string())
            ))
        );
        for base in WRONG_ADDRESSES {
            let mut given = saved.clone();
            given.base_url = (*base).into();
            let (out, looked) = run(&given);
            assert_eq!((out, looked), (None, None), "{base}");
        }
        let mut other_account = saved.clone();
        other_account.custom_model_id = "custom-2".into();
        let unsaved = route("xai", "https://api.x.ai/v1", "grok-4-fast");
        for given in [other_account, unsaved] {
            let (out, looked) = run(&given);
            assert_eq!((out, looked), (None, None), "{given:?}");
        }
        // Ollama needs no key.
        let local = route("ollama", "http://localhost:11434", "llama3.2");
        let out = context_window_in(&local, &|_: &str| panic!("Ollama has no key"), |_, key| {
            assert_eq!(key, None);
            Some(8192)
        });
        assert_eq!(out, Some(8192));
    }

    #[test]
    fn a_window_lookup_and_a_key_test_do_not_follow_a_redirect() {
        for code in [301_u16, 302, 303, 307, 308] {
            let (out, seen, followed) = crate::key_binding::redirect_probe(code, |base| {
                context_window_from_models("custom", &format!("{base}/v1"), "m", "fake-key-1234")
            });
            assert!(seen.starts_with("get "), "{seen}");
            assert!(
                seen.contains("authorization: bearer fake-key-1234"),
                "{seen}"
            );
            assert_eq!((out, followed), (None, false), "{code}");

            let (out, seen, followed) = crate::key_binding::redirect_probe(code, |base| {
                test_key("custom", &format!("{base}/v1"), "m", "fake-key-1234")
            });
            assert!(
                seen.contains("authorization: bearer fake-key-1234"),
                "{seen}"
            );
            assert!(!out.ok, "{code}: {out:?}");
            assert!(out.message.contains("redirect"), "{}", out.message);
            assert!(!followed, "{code}: the redirect was followed");

            // Ollama has no key, and a redirect still does not make it look up.
            let (out, _, followed) = crate::key_binding::redirect_probe(code, |base| {
                test_key("ollama", base, "llama3.2", "")
            });
            assert_eq!(
                (out.ok, out.message.as_str(), followed),
                (false, OLLAMA_DOWN, false)
            );
        }
    }

    #[test]
    fn a_quick_pick_with_no_stored_key_sends_nothing_and_claude_is_never_routed() {
        let none = |_: &str| Ok(None);
        let saved = stored_route();
        assert_eq!(
            quick_pick_in(&saved, &none, |_, _| Ok(String::new())),
            Err(crate::key_binding::NOT_STORED_FOR_THIS.to_string())
        );
        let local = route("ollama", "http://localhost:11434", "llama3.2");
        assert_eq!(
            quick_pick_in(&local, &|_: &str| panic!("Ollama has no key"), |_, key| {
                assert_eq!(key, None);
                Ok("ok".to_string())
            }),
            Ok("ok".to_string())
        );
        let claude = route("custom", "https://llm.example/v1", "claude-sonnet");
        assert_eq!(
            quick_pick_in(&claude, &none, |_, _| Ok(String::new())),
            Err("That model can't be used for a quick pick.".to_string())
        );
    }

    #[test]
    fn a_quick_pick_does_not_follow_a_redirect() {
        for code in [301_u16, 302, 303, 307, 308] {
            let (out, seen, followed) = crate::key_binding::redirect_probe(code, |base| {
                let r = route("custom", &format!("{base}/v1"), "fake-model");
                quick_complete(&r, Some("fake-key-1234"), "s", "p", 1_500)
            });
            assert!(
                seen.contains("authorization: bearer fake-key-1234"),
                "{seen}"
            );
            assert_eq!(
                out,
                Err(format!("The quick model answered with error {code}.")),
                "{code}"
            );
            assert!(!followed, "{code}: the redirect was followed");
        }
    }

    #[test]
    fn a_quick_pick_never_uses_a_claude_model_and_sends_a_tiny_request() {
        let claude = route("custom", "https://example.com/v1", "claude-sonnet");
        assert!(quick_complete(&claude, Some("k"), "s", "p", 500).is_err());
        let body = quick_pick_body(" grok-4-fast ", "sys", "who?");
        assert_eq!(body["model"], "grok-4-fast");
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "who?");
    }

    #[test]
    fn a_quick_pick_reads_the_answer_over_the_real_http_path() {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = upstream.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = upstream.accept().unwrap();
            let _ = read_request(&mut s).unwrap();
            let text = r#"{"choices":[{"message":{"role":"assistant","content":"{\"pick\":[\"ed\"],\"confidence\":0.9}"}}]}"#;
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len());
        });
        let r = route(
            "custom",
            &format!("http://127.0.0.1:{port}/v1"),
            "fake-model",
        );
        let out = quick_complete(&r, Some("fake-key"), "s", "p", 1_500).unwrap();
        assert!(out.contains("ed"));
    }

    #[test]
    fn a_quick_pick_gives_up_at_its_deadline() {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = upstream.local_addr().unwrap().port();
        std::thread::spawn(move || {
            // Accept and never answer.
            let (s, _) = upstream.accept().unwrap();
            std::thread::sleep(Duration::from_secs(5));
            drop(s);
        });
        let r = route(
            "custom",
            &format!("http://127.0.0.1:{port}/v1"),
            "fake-model",
        );
        let started = std::time::Instant::now();
        // Asked for longer than the cap: the cap holds.
        assert!(quick_complete(&r, Some("fake-key"), "s", "p", 60_000).is_err());
        assert!(started.elapsed() < Duration::from_millis(2_500));
    }

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

    /// WP-129: a routed Claude Code session reads a key only for the provider and address stored with it. The
    /// caller's route cannot point a saved key at another address, another provider or another account.
    #[test]
    fn a_routed_session_gets_the_key_only_for_the_address_stored_with_it() {
        let stored = CustomRoute {
            provider: "custom".into(),
            base_url: "https://llm.example/v1".into(),
            model_id: "grok-4".into(),
            custom_model_id: "routed-acct".into(),
            reasoning_effort: None,
        };
        let key = "sk-routed-0123456789";
        let store = crate::key_binding::fake_keychain(vec![(
            "routed-acct".to_string(),
            crate::key_binding::sealed_item(&stored, key),
        )]);
        let attempt = |given: &CustomRoute| prepare_routed_session_in(given, &store).is_ok();
        for address in WRONG_ADDRESSES {
            let given = CustomRoute {
                base_url: (*address).into(),
                ..stored.clone()
            };
            assert!(!attempt(&given), "{address}");
        }
        let other_account = CustomRoute {
            custom_model_id: "routed-other".into(),
            ..stored.clone()
        };
        assert!(!attempt(&other_account));
        let other_provider = CustomRoute {
            provider: "openrouter".into(),
            ..stored.clone()
        };
        assert!(!attempt(&other_provider));
        // The bound route gets a session. The child's token is not the key, and the key is in no variable.
        let ((set, _), _) = prepare_routed_session_in(&stored, &store).unwrap();
        assert!(set.iter().all(|(_, value)| !value.contains(key)));
        // Nothing stored at all: no session, and no key is sent.
        assert!(prepare_routed_session_in(&stored, &|_: &str| Ok(None)).is_err());
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
        assert!(save_key_in(TEST_KEY_SERVICE, "x1", "sk-ant-api03-zzz", None).is_err());
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
        // The key goes through `bound_key`, like a routed session: the stored item is sealed JSON, never a Bearer.
        let caller = CustomRoute {
            provider: "custom".into(),
            base_url,
            model_id: model_id.clone(),
            custom_model_id: custom_model_id.clone(),
            reasoning_effort: None,
        };
        let Ok(Some((bound, key))) =
            crate::key_binding::bound_key(&caller, &crate::key_binding::keychain_item)
        else {
            println!("[real-window] no key saved for {custom_model_id} at this address");
            return;
        };
        let window = context_window_from_models(
            "custom",
            &bound.base_url,
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
        let port = start_router(r, "fake-key-123".into(), "child-token-123".into()).unwrap();
        let resp = agent(10)
            .post(&format!("http://127.0.0.1:{port}/v1/messages?beta=true"))
            .set("Authorization", "Bearer child-token-123")
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

    /// "Connect any model to any harness": an OpenAI-style agent goes through the router untranslated, on the saved
    /// model and the saved key, and gets the provider's own bytes back.
    #[test]
    fn the_passthrough_only_runs_the_saved_model() {
        let body = json!({
            "model": "anthropic/claude-x",
            "models": ["anthropic/claude-x"],
            "route": "fallback",
            "provider": {"order": ["anthropic"]},
            "plugins": [],
            "messages": [{"role": "user", "content": "hi"}],
        });
        let out = passthrough_body(&body, " x-ai/grok-4 ");
        assert_eq!(out["model"], "x-ai/grok-4");
        for field in ["models", "route", "provider", "plugins"] {
            assert!(out.get(field).is_none(), "{field}");
        }
        assert_eq!(out["messages"][0]["content"], "hi");
    }

    #[test]
    fn the_router_passes_openai_requests_through_on_the_saved_model() {
        for path in ["/v1/responses", "/v1/chat/completions"] {
            let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
            let up_port = upstream.local_addr().unwrap().port();
            let seen = std::sync::Arc::new(Mutex::new(String::new()));
            let seen2 = seen.clone();
            std::thread::spawn(move || {
                let (mut s, _) = upstream.accept().unwrap();
                let req = read_request(&mut s).unwrap();
                *seen2.lock().unwrap() = format!(
                    "{}|{}|{}",
                    req.path,
                    req.headers
                        .get("authorization")
                        .cloned()
                        .unwrap_or_default(),
                    String::from_utf8_lossy(&req.body)
                );
                let body = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"pong\"}\n\n";
                write!(s, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            });
            let r = route(
                "custom",
                &format!("http://127.0.0.1:{up_port}/v1"),
                "saved-model",
            );
            let port = start_router(r, "fake-key-456".into(), "child-token-456".into()).unwrap();
            let resp = agent(10)
                .post(&format!("http://127.0.0.1:{port}{path}"))
                .set("Authorization", "Bearer child-token-456")
                .send_string(
                    &json!({"model": "something-else", "stream": true, "input": "ping"})
                        .to_string(),
                )
                .unwrap();
            assert_eq!(resp.header("content-type"), Some("text/event-stream"));
            let text = resp.into_string().unwrap();
            assert!(text.contains("\"delta\":\"pong\""), "{text}");
            let seen = seen.lock().unwrap().clone();
            let expected_path = path.trim_start_matches("/v1");
            assert!(
                seen.starts_with(&format!("/v1{expected_path}|Bearer fake-key-456|")),
                "{seen}"
            );
            assert!(
                seen.contains("\"model\":\"saved-model\"") && seen.contains("\"input\":\"ping\""),
                "{seen}"
            );
            assert!(!seen.contains("child-token"));
            // A wrong token never reaches the provider.
            let refused = agent(5)
                .post(&format!("http://127.0.0.1:{port}{path}"))
                .set("Authorization", "Bearer not-the-token")
                .send_string("{}");
            assert!(matches!(
                refused,
                Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _))
            ));
        }
    }

    /// A fake provider that refuses `reasoning_effort` the way xAI does for a model without reasoning control, and
    /// answers normally without it. Returns its port and every request body it saw, in order.
    fn effort_refusing_provider(
        refusal: &'static str,
    ) -> (u16, std::sync::Arc<Mutex<Vec<String>>>) {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = upstream.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for s in upstream.incoming() {
                let mut s = s.unwrap();
                let req = read_request(&mut s).unwrap();
                let body = String::from_utf8_lossy(&req.body).to_string();
                log.lock().unwrap().push(body.clone());
                let (status, answer) = if body.contains("reasoning_effort") {
                    ("400 Bad Request", refusal.to_string())
                } else {
                    (
                        "200 OK",
                        json!({"choices": [{"message": {"content": "pong"}, "finish_reason": "stop"}]})
                            .to_string(),
                    )
                };
                write!(
                    s,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                )
                .unwrap();
            }
        });
        (port, seen)
    }

    fn ask(router: u16) -> Result<String, u16> {
        match agent(10)
            .post(&format!("http://127.0.0.1:{router}/v1/messages"))
            .set("Authorization", "Bearer child-token-123")
            .send_string(&json!({"model": "x", "max_tokens": 5, "messages": [{"role": "user", "content": "ping"}]}).to_string())
        {
            Ok(r) => Ok(r.into_string().unwrap()),
            Err(ureq::Error::Status(code, _)) => Err(code),
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn a_model_that_refuses_reasoning_effort_is_asked_again_without_it_and_remembered() {
        let (up, seen) = effort_refusing_provider(
            r#"{"code":"Client specified an invalid argument","error":"Model grok-4.6 does not support parameter reasoningEffort."}"#,
        );
        let mut r = route("xai", &format!("http://127.0.0.1:{up}/v1"), "grok-4.6");
        r.reasoning_effort = Some("medium".into());
        let router =
            start_router(r.clone(), "fake-key-123".into(), "child-token-123".into()).unwrap();

        // The chat gets its answer, not the provider's 400.
        let first = ask(router).expect("the retry without the effort field answers");
        assert!(first.contains("pong"), "{first}");
        {
            let bodies = seen.lock().unwrap();
            assert_eq!(bodies.len(), 2, "one refused try, one retry: {bodies:?}");
            assert!(bodies[0].contains("\"reasoning_effort\":\"medium\""));
            assert!(!bodies[1].contains("reasoning_effort"));
        }

        // Later messages for the same model skip the field straight away, through any router for that model.
        let again = start_router(r, "fake-key-123".into(), "child-token-123".into()).unwrap();
        assert!(ask(router).unwrap().contains("pong"));
        assert!(ask(again).unwrap().contains("pong"));
        let bodies = seen.lock().unwrap();
        assert_eq!(bodies.len(), 4, "no more refused tries: {bodies:?}");
        assert!(bodies[2..].iter().all(|b| !b.contains("reasoning_effort")));
    }

    #[test]
    fn a_refusal_is_remembered_per_level_and_announced_once_with_the_model_it_belongs_to() {
        let heard = std::sync::Arc::new(Mutex::new(Vec::<EffortRefusal>::new()));
        let log = heard.clone();
        on_effort_refused(move |r| {
            if r.model_id == "grok-per-level" {
                log.lock().unwrap().push(r.clone());
            }
        });
        let (up, seen) = effort_refusing_provider(
            r#"{"error":"Model grok-per-level does not support parameter reasoningEffort."}"#,
        );
        let base = format!("http://127.0.0.1:{up}/v1");
        let mut medium = route("xai", &base, "grok-per-level");
        medium.custom_model_id = "xai-perlevel".into();
        medium.reasoning_effort = Some("medium".into());
        let mut high = medium.clone();
        high.reasoning_effort = Some("high".into());

        let at_medium = start_router(
            medium.clone(),
            "fake-key-123".into(),
            "child-token-123".into(),
        )
        .unwrap();
        assert!(ask(at_medium).unwrap().contains("pong"));
        assert!(ask(at_medium).unwrap().contains("pong"));
        // Medium was refused once and then skipped; High is still tried, because it may well be accepted.
        let at_high = start_router(high, "fake-key-123".into(), "child-token-123".into()).unwrap();
        assert!(ask(at_high).unwrap().contains("pong"));
        let bodies = seen.lock().unwrap().clone();
        assert_eq!(bodies.len(), 5, "{bodies:?}");
        assert!(bodies[0].contains("\"reasoning_effort\":\"medium\""));
        assert!(!bodies[1].contains("reasoning_effort"));
        assert!(
            !bodies[2].contains("reasoning_effort"),
            "medium is remembered"
        );
        assert!(bodies[3].contains("\"reasoning_effort\":\"high\""));
        assert!(!bodies[4].contains("reasoning_effort"));

        // The webview hears each refusal once, with the model and level, and never the key.
        let heard = heard.lock().unwrap().clone();
        assert_eq!(
            heard.iter().map(|r| r.effort.as_str()).collect::<Vec<_>>(),
            ["medium", "high"]
        );
        assert_eq!(heard[0].custom_model_id, "xai-perlevel");
        assert_eq!(heard[0].provider, "xai");
        assert!(!serde_json::to_string(&heard[0])
            .unwrap()
            .contains("fake-key"));
    }

    /// E1 (22 Oct): each routed request leaves a receipt of the effort it carried, with no key or message text.
    #[test]
    fn a_receipt_says_which_effort_reached_the_provider_and_never_holds_the_key() {
        let mut r = route("deepseek", "https://api.deepseek.com/v1", "deepseek-chat");
        r.reasoning_effort = Some("high".into());
        let sent = receipt_line(&r, Some("high"), false, 200);
        assert_eq!(sent["provider"], "deepseek");
        assert_eq!(sent["host"], "api.deepseek.com");
        assert_eq!(sent["model"], "deepseek-chat");
        assert_eq!(sent["chosenEffort"], "high");
        assert_eq!(sent["sentEffort"], "high");
        assert_eq!(sent["status"], 200);
        let retried = receipt_line(&r, Some("high"), true, 200);
        assert_eq!(retried["sentEffort"], Value::Null);
        assert_eq!(retried["retriedWithoutEffort"], true);
        assert_eq!(
            sent.as_object().unwrap().len(),
            8,
            "at, provider, host, model, chosenEffort, sentEffort, retriedWithoutEffort, status"
        );
    }

    #[test]
    fn other_refusals_are_not_retried_and_other_models_still_get_their_effort() {
        // A 400 about something else goes back to Claude Code as it was, after one try.
        let (up, seen) =
            effort_refusing_provider(r#"{"error":{"message":"Your prompt is too long."}}"#);
        let mut r = route(
            "deepseek",
            &format!("http://127.0.0.1:{up}/v1"),
            "deepseek-chat",
        );
        r.reasoning_effort = Some("high".into());
        let router = start_router(r, "fake-key-123".into(), "child-token-123".into()).unwrap();
        assert_eq!(ask(router), Err(400));
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(ask(router), Err(400));
        assert!(
            seen.lock().unwrap()[1].contains("\"reasoning_effort\":\"high\""),
            "not remembered as refusing effort"
        );

        assert!(is_effort_refusal(400, "unknown field `reasoning_effort`"));
        assert!(is_effort_refusal(
            422,
            "Reasoning effort is not supported for this model"
        ));
        assert!(!is_effort_refusal(500, "reasoning_effort"));
        assert!(!is_effort_refusal(400, "max_tokens too large"));
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
        assert!(save_key_in(TEST_KEY_SERVICE, "x1", "sk-ant-api03-x", None)
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
        save_key_in(TEST_KEY_SERVICE, &id, "not-a-real-key", None).unwrap();
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
        let upstream = session_token("ollama", None).unwrap();
        let token = "child-token-123".to_string();
        let port = start_router(r.clone(), upstream, token.clone()).unwrap();
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
        // Through `bound_key` and `ensure_router`, as a routed session does: the child gets a session token, never the key.
        let caller = CustomRoute {
            provider: "custom".into(),
            base_url,
            model_id: model_id.clone(),
            custom_model_id: custom_model_id.clone(),
            reasoning_effort: None,
        };
        let Some((r, key)) =
            crate::key_binding::bound_key(&caller, &crate::key_binding::keychain_item).unwrap()
        else {
            println!("[live-route] no key saved for {custom_model_id} at this address");
            return;
        };
        let upstream = session_token("custom", key.as_deref()).unwrap();
        let (port, session) = ensure_router(&r, &upstream).unwrap();
        let token = session.value().to_string();
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

    const SECRET: &str = "sk-test-SECRETKEY";

    #[derive(Debug)]
    struct Hit {
        path: String,
        auth: String,
        body: String,
    }

    struct Local {
        port: u16,
        hits: std::sync::Arc<Mutex<Vec<Hit>>>,
        done: std::sync::Arc<std::sync::atomic::AtomicBool>,
        join: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for Local {
        fn drop(&mut self) {
            self.done.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(handle) = self.join.take() {
                let _ = handle.join();
            }
        }
    }

    /// Serves `replies` in order, then holds the connection until dropped. Records every request.
    fn local(replies: Vec<String>) -> Local {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = std::sync::Arc::new(Mutex::new(Vec::new()));
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hits2 = hits.clone();
        let done2 = done.clone();
        let join = std::thread::spawn(move || {
            let mut left = replies;
            let started = std::time::Instant::now();
            while !done2.load(std::sync::atomic::Ordering::Relaxed)
                && started.elapsed() < Duration::from_secs(8)
            {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let Ok(req) = read_request(&mut stream) else {
                            continue;
                        };
                        hits2.lock().unwrap().push(Hit {
                            path: req.path,
                            auth: req
                                .headers
                                .get("authorization")
                                .cloned()
                                .unwrap_or_default(),
                            body: String::from_utf8_lossy(&req.body).into_owned(),
                        });
                        if left.is_empty() {
                            while !done2.load(std::sync::atomic::Ordering::Relaxed) {
                                std::thread::sleep(Duration::from_millis(5));
                            }
                            break;
                        }
                        let answer = left.remove(0);
                        let _ = stream.write_all(answer.as_bytes());
                    }
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::Interrupted =>
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Local {
            port,
            hits,
            done,
            join: Some(join),
        }
    }

    fn http(status: u16, reason: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn base_of(port: u16) -> String {
        format!("http://127.0.0.1:{port}/v1")
    }

    fn no_secret(result: &KeyTestResult) {
        let dumped = serde_json::to_string(result).unwrap();
        assert!(!dumped.contains(SECRET), "{dumped}");
        assert!(!result.message.contains("127.0.0.1"), "{}", result.message);
    }

    #[test]
    fn tool_probe_says_when_the_model_calls_the_tool() {
        let body = json!({
            "choices": [{
                "message": {
                    "content": Value::Null,
                    "tool_calls": [{
                        "id": "1",
                        "type": "function",
                        "function": { "name": "ping", "arguments": format!(r#"{{"k":"{SECRET}"}}"#) }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        })
        .to_string();
        let server = local(vec![http(200, "OK", &body)]);
        let result = probe_tools_in(
            "custom",
            &base_of(server.port),
            "m",
            SECRET,
            Duration::from_secs(2),
        );
        assert!(result.ok);
        assert_eq!(result.message, "This model can use tools.");
        no_secret(&result);
        let hits = server.hits.lock().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].auth, format!("Bearer {SECRET}"));
        assert!(
            hits[0].path.ends_with("/chat/completions"),
            "{}",
            hits[0].path
        );
        assert!(hits[0].body.contains("\"tool_choice\":\"required\""));
        assert!(hits[0].body.contains("\"name\":\"ping\""));
    }

    #[test]
    fn tool_probe_accepts_a_legacy_function_call_and_rejects_an_empty_list() {
        assert!(called_a_tool(
            r#"{"choices":[{"message":{"function_call":{"name":"ping","arguments":"{}"}}}]}"#
        ));
        assert!(!called_a_tool(
            r#"{"choices":[{"message":{"tool_calls":[]},"finish_reason":"tool_calls"}]}"#
        ));
        assert!(!called_a_tool(
            r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":"  "}}]}}]}"#
        ));
        assert!(!called_a_tool("not-json"));
        let server = local(vec![http(200, "OK", "not-json")]);
        let result = probe_tools_in(
            "custom",
            &base_of(server.port),
            "m",
            SECRET,
            Duration::from_secs(2),
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "This model answers, but it cannot use tools, so Claude Code cannot use it."
        );
        no_secret(&result);
    }

    #[test]
    fn tool_probe_says_when_the_model_answers_without_tools() {
        let body = format!(
            r#"{{"choices":[{{"message":{{"content":"hello {SECRET}"}},"finish_reason":"stop"}}]}}"#
        );
        let server = local(vec![http(200, "OK", &body)]);
        let result = probe_tools_in(
            "custom",
            &base_of(server.port),
            "m",
            SECRET,
            Duration::from_secs(2),
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "This model answers, but it cannot use tools, so Claude Code cannot use it."
        );
        no_secret(&result);
    }

    #[test]
    fn tool_probe_follows_a_rejected_tools_request_with_one_plain_request() {
        let leaked = format!(r#"{{"error":{{"message":"no tools {SECRET}"}}}}"#);
        let answer = r#"{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}"#;
        let server = local(vec![
            http(400, "Bad Request", &leaked),
            http(200, "OK", answer),
        ]);
        let result = probe_tools_in(
            "custom",
            &base_of(server.port),
            "m",
            SECRET,
            Duration::from_secs(2),
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "This model answers, but it cannot use tools, so Claude Code cannot use it."
        );
        no_secret(&result);
        let hits = server.hits.lock().unwrap();
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(hits[0].body.contains("\"tools\""));
        assert!(!hits[1].body.contains("\"tools\""), "{}", hits[1].body);
        assert!(!hits[1].body.contains("tool_choice"), "{}", hits[1].body);
    }

    #[test]
    fn tool_probe_a_dead_followup_is_not_stored_as_no_tools() {
        let server = local(vec![http(400, "Bad Request", r#"{"error":"no"}"#)]);
        let started = std::time::Instant::now();
        let result = probe_tools_in(
            "custom",
            &base_of(server.port),
            "m",
            SECRET,
            Duration::from_millis(400),
        );
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "a hang is not a 30s wait"
        );
        assert!(!result.ok);
        assert_eq!(result.message, "Couldn't reach that endpoint.");
        assert_ne!(
            result.message,
            "This model answers, but it cannot use tools, so Claude Code cannot use it."
        );
        no_secret(&result);
        assert_eq!(server.hits.lock().unwrap().len(), 2);
    }

    #[test]
    fn tool_probe_says_when_the_endpoint_is_down_or_slow() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let refused = probe_tools_in(
            "custom",
            &base_of(port),
            "m",
            SECRET,
            Duration::from_millis(400),
        );
        assert!(!refused.ok);
        assert_eq!(refused.message, "Couldn't reach that endpoint.");
        no_secret(&refused);

        let server = local(vec![]);
        let started = std::time::Instant::now();
        let hung = probe_tools_in(
            "custom",
            &base_of(server.port),
            "m",
            SECRET,
            Duration::from_millis(400),
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(hung.message, "Couldn't reach that endpoint.");
        no_secret(&hung);
        let hits = server.hits.lock().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].auth, format!("Bearer {SECRET}"));
    }

    #[test]
    fn tool_probe_a_bad_key_is_not_a_missing_tool() {
        let server = local(vec![http(
            401,
            "Unauthorized",
            &format!(r#"{{"error":"{SECRET}"}}"#),
        )]);
        let result = probe_tools_in(
            "custom",
            &base_of(server.port),
            "m",
            SECRET,
            Duration::from_secs(2),
        );
        assert!(!result.ok);
        assert_eq!(result.message, "That key didn't work");
        no_secret(&result);
        assert_eq!(server.hits.lock().unwrap().len(), 1);
    }

    #[test]
    fn tool_probe_does_not_follow_a_redirect_with_the_key() {
        let redirect = "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let server = local(vec![redirect.to_string()]);
        let result = probe_tools_in(
            "custom",
            &base_of(server.port),
            "m",
            SECRET,
            Duration::from_secs(2),
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "The provider had a problem (error 302); try again"
        );
        no_secret(&result);
        assert_eq!(
            server.hits.lock().unwrap().len(),
            1,
            "the key must not be sent on"
        );
    }

    #[test]
    fn tool_probe_an_unknown_model_keeps_the_old_sentence() {
        let server = local(vec![http(404, "Not Found", r#"{"error":"missing"}"#)]);
        let result = probe_tools_in(
            "custom",
            &base_of(server.port),
            "missing-model",
            SECRET,
            Duration::from_secs(2),
        );
        assert_eq!(
            result.message,
            "The provider doesn't know the model id missing-model"
        );
        no_secret(&result);
    }

    #[test]
    fn tool_probe_refuses_a_bad_request_before_any_call() {
        let quick = Duration::from_millis(200);
        assert_eq!(
            probe_tools_in("xai", "https://api.x.ai/v1", "grok-4", "", quick).message,
            "Add the key"
        );
        assert!(probe_tools_in(
            "xai",
            "https://api.x.ai/v1",
            "grok-4",
            "sk-ant-api03-x",
            quick
        )
        .message
        .contains("looks like a Claude key"));
        assert_eq!(
            probe_tools_in("nope", "https://api.x.ai/v1", "m", "k", quick).message,
            "Pick a provider"
        );
        assert!(
            probe_tools_in("custom", "http://example.com/v1", "m", "k", quick)
                .message
                .contains("https://")
        );
        assert_eq!(
            probe_tools_in("custom", "https://example.com/v1", "", "k", quick).message,
            "Add the model id"
        );
        assert!(probe_tools_in(
            "ollama",
            "http://127.0.0.1:9",
            "llama",
            "sk-ant-api03-x",
            quick
        )
        .message
        .contains("looks like a Claude key"));
    }

    #[test]
    fn tool_probe_ollama_without_a_model_only_checks_tags() {
        let tags = r#"{"models":[]}"#;
        let server = local(vec![http(200, "OK", tags)]);
        let result = probe_tools_in(
            "ollama",
            &format!("http://127.0.0.1:{}", server.port),
            "",
            SECRET,
            Duration::from_secs(2),
        );
        assert!(result.ok);
        assert_eq!(result.message, "Connected, Ollama is running");
        no_secret(&result);
        let hits = server.hits.lock().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "/api/tags");
        assert!(!hits[0].auth.contains(SECRET));
    }

    #[test]
    fn tool_probe_ollama_with_a_model_asks_for_a_tool_and_sends_no_user_key() {
        let body = r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":"ping"}}]}}]}"#;
        let server = local(vec![http(200, "OK", body)]);
        let result = probe_tools_in(
            "ollama",
            &format!("http://127.0.0.1:{}", server.port),
            "llama3.2",
            "",
            Duration::from_secs(2),
        );
        assert_eq!(result.message, "This model can use tools.");
        let hits = server.hits.lock().unwrap();
        assert!(
            hits[0].path.ends_with("/chat/completions"),
            "{}",
            hits[0].path
        );
        assert_eq!(hits[0].auth, "Bearer monocode-ollama-local");
        assert!(!hits[0].body.contains(SECRET));
    }

    /// WP-129 M2 (lead review, 11 Nov): an upstream error goes back to Claude Code scrubbed of the key. The text was cut
    /// to 400 characters before the key was replaced, so a key straddling the cut left its start behind; a key written
    /// the JSON way (quotes, backslashes, escaped slashes) was never replaced at all.
    #[test]
    fn an_upstream_error_never_shows_the_key_at_the_400_character_cut() {
        const KEY: &str = "sk-live-0123456789abcdefghijklmnopqrstuvwxyz";
        let no_key_start = |out: &str| {
            for k in 4..=KEY.len() {
                assert!(
                    !out.ends_with(&KEY[..k]),
                    "a key prefix of {k} characters is left at the cut: {out}"
                );
            }
            assert!(!out.contains(&KEY[..8]), "{out}");
        };

        // 370 characters of padding, then the whole key: it straddles the 400-character cut.
        let straddling = format!("{}{KEY}tail", "x".repeat(370));
        let out = scrub(&straddling, KEY);
        no_key_start(&out);
        assert!(out.chars().count() <= 400, "{}", out.chars().count());

        // The cut lands inside a key the upstream itself sent (no whole key left to replace).
        let cut_inside = format!("{}{}", "x".repeat(397), &KEY[..11]);
        let out = scrub(&cut_inside, KEY);
        no_key_start(&out);
        assert_eq!(out, "x".repeat(397));

        // A key written the JSON way: a quote and a backslash escaped, the slash written as \/ or as /.
        const JSON_KEY: &str = "sk-json\"quote\\slash/part";
        let body = r#"{"error":{"message":"bad key sk-json\"quote\\slash/part, sk-json\"quote\\slash\/part, sk-json\"quote\\slash/part"}}"#;
        let out = scrub(body, JSON_KEY);
        assert!(!out.contains("sk-json"), "{out}");
        assert!(!out.contains("quote"), "{out}");
        assert!(out.contains("***"), "{out}");
    }

    /// WP-129 L2 (lead review, 11 Nov): each routed session has its own router token, and it stops working when that
    /// session ends. Two sessions on one router must not share a token.
    #[test]
    fn each_routed_session_has_its_own_router_token() {
        let server = local(vec![
            http(
                200,
                "OK",
                r#"{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}"#
            );
            4
        ]);
        let r = CustomRoute {
            provider: "custom".into(),
            base_url: base_of(server.port),
            model_id: "m".into(),
            custom_model_id: "l2-sessions-test".into(),
            reasoning_effort: None,
        };
        let (port_a, token_a) = ensure_router(&r, "l2-upstream-key").unwrap();
        let (port_b, token_b) = ensure_router(&r, "l2-upstream-key").unwrap();
        assert_eq!(port_a, port_b);
        assert_ne!(
            token_a.value(),
            token_b.value(),
            "two sessions were given the same router token"
        );
        // Each session's token works on the shared router until that session ends.
        assert_eq!(router_status(port_a, token_a.value()), 200);
        assert_eq!(router_status(port_b, token_b.value()), 200);
        let ended = token_a.value().to_string();
        drop(token_a);
        assert_eq!(
            router_status(port_a, &ended),
            401,
            "an ended session's token still works"
        );
        assert_eq!(
            router_status(port_b, token_b.value()),
            200,
            "ending one session stopped the other"
        );
    }

    /// Sends one request to a router with `token`: the status it answers with, or None when nothing listens there any
    /// more (a stopped router closes its port).
    fn router_answer(port: u16, token: &str) -> Option<u16> {
        let body = r#"{"model":"m","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}"#;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
        write!(
            stream,
            "POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nx-api-key: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).ok()?;
        line.split_whitespace().nth(1)?.parse().ok()
    }

    fn router_status(port: u16, token: &str) -> u16 {
        router_answer(port, token).expect("the router is not listening")
    }

    /// WP-129 L1 (lead review, 11 Nov): deleting or replacing a model's key stops that account's routers, so a token
    /// from before the change stops working. Another account's router keeps running.
    #[test]
    fn deleting_or_replacing_a_key_stops_its_routers() {
        let answer = r#"{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}"#;
        let server = local(vec![http(200, "OK", answer); 8]);
        let route_for = |id: &str| CustomRoute {
            provider: "custom".into(),
            base_url: base_of(server.port),
            model_id: "m".into(),
            custom_model_id: id.into(),
            reasoning_effort: None,
        };
        let deleted = route_for("l1-deleted");
        let replaced = route_for("l1-replaced");
        let kept = route_for("l1-kept");
        let (port_d, token_d) = ensure_router(&deleted, "l1-key-a").unwrap();
        let (port_r, token_r) = ensure_router(&replaced, "l1-key-b").unwrap();
        let (port_k, token_k) = ensure_router(&kept, "l1-key-c").unwrap();
        let (token_d, token_r, token_k) = (
            token_d.value().to_string(),
            token_r.value().to_string(),
            token_k.value().to_string(),
        );
        assert_eq!(router_status(port_d, &token_d), 200);
        assert_eq!(router_status(port_r, &token_r), 200);
        assert_eq!(router_status(port_k, &token_k), 200);

        assert_eq!(
            delete_key_with(KEY_SERVICE, "l1-deleted", &|_: &str, _: &str| Ok(true)),
            Ok(true)
        );
        save_key_with(
            KEY_SERVICE,
            "l1-replaced",
            "a-new-key-1234",
            None,
            &|_: &str, _: &str, _: &str| Ok(()),
        )
        .unwrap();

        for (port, token, what) in [
            (port_d, &token_d, "a deleted key's"),
            (port_r, &token_r, "a replaced key's"),
        ] {
            let answer = router_answer(port, token);
            assert!(
                matches!(answer, None | Some(401)),
                "{what} router still takes its old token: {answer:?}"
            );
        }
        assert_eq!(
            router_status(port_k, &token_k),
            200,
            "another account's router was stopped too"
        );
    }

    /// WP-129 (coordinator follow-up): a routed child's environment holds no form of the bound key. Not the key as it
    /// is, not its base64 or hex, and not in any variable the builder sets. Built through the real routed-session path
    /// (`prepare_routed_session_in`) from a sealed item, then every variable is checked.
    #[test]
    fn a_routed_child_environment_holds_no_form_of_the_key() {
        use base64::Engine;
        let stored = CustomRoute {
            provider: "custom".into(),
            base_url: "https://llm.example/v1".into(),
            model_id: "grok-4".into(),
            custom_model_id: "env-acct".into(),
            reasoning_effort: None,
        };
        let key = "sk-env-fixture-0123456789abcdef";
        let store = crate::key_binding::fake_keychain(vec![(
            "env-acct".to_string(),
            crate::key_binding::sealed_item(&stored, key),
        )]);
        let ((set, _), session) = prepare_routed_session_in(&stored, &store).unwrap();
        let forms = [
            key.to_string(),
            base64::engine::general_purpose::STANDARD.encode(key),
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(key),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key),
            key.bytes().map(|b| format!("{b:02x}")).collect::<String>(),
            key.bytes().map(|b| format!("{b:02X}")).collect::<String>(),
        ];
        assert!(!set.is_empty());
        for (name, value) in &set {
            for form in &forms {
                assert!(
                    !value.contains(form.as_str()),
                    "{name} holds a form of the key: {form}"
                );
            }
        }
        assert_ne!(session.value(), key, "the session token is the key");
    }
}
