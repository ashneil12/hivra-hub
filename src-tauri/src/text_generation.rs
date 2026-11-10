//! WP-129: one short completion for a title, a commit message, pull request text or a branch name.
//!
//! No tools, no path and no repo writes. The key is read here and never comes back. A timeout or an
//! unreachable provider is a try-again (`kind: "timeout"`), not a crash and not a cleared setting.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::history_import::{classify, AskOutcome, PostResult};
use crate::model_router::{may_route, read_key_in, session_token, CustomRoute, KEY_SERVICE};

/// Commit and pull request prompts carry a patch. This is the ceiling, in characters.
pub const PROMPT_LIMIT: usize = 60_000;
pub const REPLY_LIMIT: usize = 8_000;
pub const MAX_TOKENS: u32 = 1024;
pub const DEADLINE: Duration = Duration::from_secs(45);

const TRY_AGAIN: &str = "The model didn't answer this time. It can be tried again.";

fn refused(reason: &str) -> AskOutcome {
    AskOutcome {
        ok: false,
        text: String::new(),
        kind: "refused".into(),
        reason: reason.into(),
    }
}

fn again() -> AskOutcome {
    AskOutcome {
        ok: false,
        text: String::new(),
        kind: "timeout".into(),
        reason: TRY_AGAIN.into(),
    }
}

fn empty_reply() -> AskOutcome {
    AskOutcome {
        ok: false,
        text: String::new(),
        kind: "empty".into(),
        reason: "The model sent nothing back.".into(),
    }
}

fn cap_reply(text: &str) -> String {
    if text.chars().count() <= REPLY_LIMIT {
        return text.to_string();
    }
    text.chars().take(REPLY_LIMIT).collect()
}

/// One chat completion. There is no `tools` field, so the model is not offered a way to write.
pub fn text_body(model_id: &str, prompt: &str) -> String {
    json!({
        "model": model_id.trim(),
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
        "stream": false,
    })
    .to_string()
}

fn assistant_text(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    match value.pointer("/choices/0/message/content")? {
        Value::String(text) if !text.trim().is_empty() => Some(cap_reply(text)),
        _ => None,
    }
}

fn chat_reply(body: &str) -> PostResult {
    match assistant_text(body) {
        Some(text) => PostResult::Answer(text),
        None => PostResult::Status(200),
    }
}

fn post_chat(url: &str, token: &str, body: &str, deadline: Duration) -> PostResult {
    let agent = ureq::AgentBuilder::new().timeout(deadline).build();
    match agent
        .post(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(body)
    {
        Ok(response) => chat_reply(&response.into_string().unwrap_or_default()),
        Err(ureq::Error::Status(code, _)) => PostResult::Status(code),
        Err(ureq::Error::Transport(_)) => PostResult::Unreachable,
    }
}

/// A saved key of 8 or more characters must not come back in the prompt, the body or the reply.
/// Shorter than that, a substring check hits ordinary words ("model", "max_tokens") and refuses a good ask.
fn holds_token(token: &str, text: &str) -> bool {
    token.len() >= 8 && text.contains(token)
}

/// A base address after parsing: lowercase host, no trailing dot, no userinfo, no query or fragment,
/// and the default port left off. The request is built from these parts, never from the raw string.
#[derive(Clone, Debug, PartialEq, Eq)]
struct NormalUrl {
    scheme: String,
    host: String,
    port: Option<u16>,
    path: String,
}

fn normalize_base(raw: &str) -> Option<NormalUrl> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return None;
    }
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() || host.contains('@') || host.contains('/') || host.contains('\\') {
        return None;
    }
    let path = parsed.path().trim_end_matches('/').to_string();
    if path.split('/').any(|part| part == "." || part == "..") {
        return None;
    }
    Some(NormalUrl {
        scheme: parsed.scheme().to_string(),
        host,
        port: parsed.port(),
        path,
    })
}

fn host_for_url(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn base_string(url: &NormalUrl) -> String {
    let port = url.port.map(|port| format!(":{port}")).unwrap_or_default();
    format!(
        "{}://{}{}{}",
        url.scheme,
        host_for_url(&url.host),
        port,
        url.path
    )
}

/// `http://localhost:11434` becomes `http://localhost:11434/v1/chat/completions`. A base that already
/// ends in `/v1` only gains `/chat/completions`.
fn completions_from(provider: &str, url: &NormalUrl) -> String {
    let mut path = url.path.clone();
    if provider == "ollama" && !path.ends_with("/v1") {
        path = if path.is_empty() {
            "/v1".to_string()
        } else {
            format!("{path}/v1")
        };
    }
    path = format!("{path}/chat/completions");
    let port = url.port.map(|port| format!(":{port}")).unwrap_or_default();
    format!(
        "{}://{}{}{}",
        url.scheme,
        host_for_url(&url.host),
        port,
        path
    )
}

/// Named providers go only to the one host `import_destination_allowed` already names. Custom is
/// https, and plain http is only Ollama on this Mac.
fn scheme_allowed(provider: &str, url: &NormalUrl) -> bool {
    match provider {
        "xai" | "openrouter" | "deepseek" | "ollama" => {
            let route = CustomRoute {
                provider: provider.to_string(),
                base_url: base_string(url),
                model_id: "m".to_string(),
                custom_model_id: "a".to_string(),
                reasoning_effort: None,
            };
            crate::history_import::import_destination_allowed(&route)
        }
        "custom" => url.scheme == "https",
        _ => false,
    }
}

fn same_model(left: &str, right: &str) -> bool {
    left.trim() == right.trim()
}

/// The completions URL for this ask, or nothing when the caller's route is not the saved one or
/// the host is not the one that key is for.
pub fn bound_completions_url(
    given: &CustomRoute,
    saved: &CustomRoute,
    models: &[CustomRoute],
) -> Option<String> {
    if given.provider != saved.provider || given.custom_model_id != saved.custom_model_id {
        return None;
    }
    if !same_model(&given.model_id, &saved.model_id) {
        return None;
    }
    if given.provider != "ollama" && !safe_account(&given.custom_model_id) {
        return None;
    }
    if given.provider == "ollama"
        && !given.custom_model_id.is_empty()
        && !safe_account(&given.custom_model_id)
    {
        return None;
    }
    let given_url = normalize_base(&given.base_url)?;
    let saved_url = normalize_base(&saved.base_url)?;
    if given_url != saved_url || !scheme_allowed(&given.provider, &given_url) {
        return None;
    }
    if given.provider == "custom" {
        let model = models
            .iter()
            .find(|model| model.custom_model_id == given.custom_model_id)?;
        if model.provider != "custom" || !same_model(&model.model_id, &given.model_id) {
            return None;
        }
        let bound = normalize_base(&model.base_url)?;
        if bound != given_url {
            return None;
        }
    } else if let Some(model) = models
        .iter()
        .find(|model| model.custom_model_id == given.custom_model_id)
    {
        if model.provider != given.provider || !same_model(&model.model_id, &given.model_id) {
            return None;
        }
        let bound = normalize_base(&model.base_url)?;
        if bound != given_url {
            return None;
        }
    }
    Some(completions_from(&given.provider, &given_url))
}

fn safe_account(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id.len() <= 120
        && !id.contains("..")
        && !id.contains('/')
        && !id.contains('\\')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredRoute {
    provider: String,
    base_url: String,
    model_id: String,
    custom_model_id: String,
}

fn cleaned(route: &CustomRoute, url: &NormalUrl) -> CustomRoute {
    CustomRoute {
        provider: route.provider.clone(),
        base_url: base_string(url),
        model_id: route.model_id.trim().to_string(),
        custom_model_id: route.custom_model_id.clone(),
        reasoning_effort: None,
    }
}

fn stored_from(route: &CustomRoute) -> StoredRoute {
    StoredRoute {
        provider: route.provider.clone(),
        base_url: route.base_url.clone(),
        model_id: route.model_id.clone(),
        custom_model_id: route.custom_model_id.clone(),
    }
}

fn route_from_stored(stored: StoredRoute) -> Option<CustomRoute> {
    if !matches!(
        stored.provider.as_str(),
        "xai" | "openrouter" | "deepseek" | "ollama" | "custom"
    ) {
        return None;
    }
    normalize_base(&stored.base_url)?;
    if stored.provider != "ollama" && !safe_account(&stored.custom_model_id) {
        return None;
    }
    if stored.provider == "ollama"
        && !stored.custom_model_id.is_empty()
        && !safe_account(&stored.custom_model_id)
    {
        return None;
    }
    Some(CustomRoute {
        provider: stored.provider,
        base_url: stored.base_url,
        model_id: stored.model_id,
        custom_model_id: stored.custom_model_id,
        reasoning_effort: None,
    })
}

fn parse_stored(text: &str) -> Option<CustomRoute> {
    if text.len() > 4_096 {
        return None;
    }
    route_from_stored(serde_json::from_str(text).ok()?)
}

/// This copy's short-text folder. Missing when there is no data folder yet.
pub fn store_dir() -> Option<PathBuf> {
    let id = crate::instance::current().identifier.clone();
    crate::instance::data_dir(&id).map(|dir| dir.join("text-generation"))
}

fn write_atomic(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), ()> {
    let root = crate::fs::canonical(root).map_err(|_| ())?;
    let parent = crate::fs::canonical(path.parent().ok_or(())?).map_err(|_| ())?;
    if !parent.starts_with(&root) {
        return Err(());
    }
    let name = path.file_name().and_then(|name| name.to_str()).ok_or(())?;
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(());
    }
    let path = parent.join(name);
    if path.parent() != Some(parent.as_path()) {
        return Err(());
    }
    let tmp = parent.join(format!("{name}.tmp"));
    fs::write(&tmp, bytes).map_err(|_| ())?;
    if fs::rename(&tmp, &path).is_err() {
        if path.starts_with(&root) {
            let _ = fs::remove_file(&path);
        }
        fs::rename(&tmp, &path).map_err(|_| ())?;
    }
    Ok(())
}

fn read_route(dir: &Path) -> Option<CustomRoute> {
    let text = fs::read_to_string(dir.join("route.json")).ok()?;
    parse_stored(&text)
}

fn read_models(dir: &Path) -> Vec<CustomRoute> {
    let root = dir.join("models");
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= 500 {
            break;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !safe_account(&name) {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Some(route) = parse_stored(&text) else {
            continue;
        };
        if route.custom_model_id == name {
            out.push(route);
        }
    }
    out
}

fn model_file(dir: &Path, account: &str) -> Option<PathBuf> {
    if !safe_account(account) {
        return None;
    }
    let root = dir.join("models");
    fs::create_dir_all(&root).ok()?;
    let root = crate::fs::canonical(&root).ok()?;
    let path = root.join(account);
    if path.parent()? != root {
        return None;
    }
    Some(path)
}

/// Remember the address that belongs to this key. Called only when the key itself is saved.
pub fn record_model_binding(dir: &Path, route: &CustomRoute) -> Result<(), ()> {
    let url = normalize_base(&route.base_url).ok_or(())?;
    if !scheme_allowed(&route.provider, &url) || route.model_id.trim().is_empty() {
        return Err(());
    }
    let clean = cleaned(route, &url);
    let path = model_file(dir, &clean.custom_model_id).ok_or(())?;
    let root = path.parent().ok_or(())?;
    let bytes = serde_json::to_vec(&stored_from(&clean)).map_err(|_| ())?;
    write_atomic(root, &path, &bytes)
}

/// Remember which saved model short text uses. A custom address must already be the one stored
/// with that key. A named provider must be its one known host.
pub fn remember_route(dir: &Path, route: &CustomRoute) -> Result<(), ()> {
    let url = normalize_base(&route.base_url).ok_or(())?;
    let clean = cleaned(route, &url);
    if !may_route(&clean) || bound_completions_url(&clean, &clean, &read_models(dir)).is_none() {
        return Err(());
    }
    fs::create_dir_all(dir).map_err(|_| ())?;
    let root = crate::fs::canonical(dir).map_err(|_| ())?;
    let path = root.join("route.json");
    let bytes = serde_json::to_vec(&stored_from(&clean)).map_err(|_| ())?;
    write_atomic(&root, &path, &bytes)
}

/// Drop the saved short-text route. Model bindings stay until the key is deleted.
pub fn forget_route(dir: &Path) -> Result<(), ()> {
    let path = dir.join("route.json");
    if !path.exists() {
        return Ok(());
    }
    let root = crate::fs::canonical(dir).map_err(|_| ())?;
    let path = root.join("route.json");
    if path.parent() != Some(root.as_path()) {
        return Err(());
    }
    fs::remove_file(path).map_err(|_| ())
}

/// Drop the address stored for one key, and only that file.
pub fn remove_model_binding(dir: &Path, account: &str) {
    if !safe_account(account) {
        return;
    }
    let root = dir.join("models");
    if !root.is_dir() {
        return;
    }
    let Ok(root) = crate::fs::canonical(&root) else {
        return;
    };
    let path = root.join(account);
    if path.parent() != Some(root.as_path()) {
        return;
    }
    let _ = fs::remove_file(path);
}

/// Ask, and turn the reply into text or a plain error. `post` is the only way out; it is given a URL,
/// a token and a body, never a path. The URL is the saved route's, rebuilt from its parsed parts.
pub fn text_complete(
    route: &CustomRoute,
    saved: &CustomRoute,
    models: &[CustomRoute],
    prompt: &str,
    key: Option<&str>,
    post: impl FnOnce(&str, &str, &str) -> PostResult,
) -> AskOutcome {
    if prompt.trim().is_empty() {
        return refused("There was nothing to send.");
    }
    if crate::portable::scrubber().has_secret(prompt) {
        return refused("That text contained a secret, so it was not sent.");
    }
    if prompt.chars().count() > PROMPT_LIMIT {
        return refused("That text is too long to send.");
    }
    if !may_route(route) {
        return refused("That model can't be used for this.");
    }
    let url = match bound_completions_url(route, saved, models) {
        Some(url) => url,
        None => return refused("That model can't be used for this."),
    };
    let token = match session_token(&route.provider, key) {
        Ok(token) => token,
        Err(_) => return refused("That model can't be used for this."),
    };
    if holds_token(&token, prompt) {
        return refused("That text contained a secret, so it was not sent.");
    }
    let body = text_body(&route.model_id, prompt);
    if holds_token(&token, &body) {
        return refused("That text contained a secret, so it was not sent.");
    }
    let outcome = match post(&url, &token, &body) {
        PostResult::Answer(text) => {
            if text.trim().is_empty() {
                empty_reply()
            } else if crate::portable::scrubber().has_secret(&text) || holds_token(&token, &text) {
                again()
            } else {
                AskOutcome {
                    ok: true,
                    text: cap_reply(&text),
                    kind: "ok".into(),
                    reason: String::new(),
                }
            }
        }
        PostResult::Status(200) => AskOutcome {
            ok: false,
            text: String::new(),
            kind: "empty".into(),
            reason: "The model answered in a shape that couldn't be read.".into(),
        },
        PostResult::Status(code) if classify(code) == "retryable" => again(),
        PostResult::Status(_) => refused("That model turned this down."),
        PostResult::Unreachable => again(),
    };
    if holds_token(&token, &outcome.text) || holds_token(&token, &outcome.reason) {
        return again();
    }
    outcome
}

fn key_for(route: &CustomRoute) -> Result<Option<String>, String> {
    if route.provider == "ollama" {
        return Ok(None);
    }
    read_key_in(KEY_SERVICE, &route.custom_model_id)
}

/// One short reply. The arguments are the route and the prompt: there is no path to write.
/// The key is read only after the route matches the saved one, so a different account is never loaded.
#[tauri::command]
pub async fn text_generation_ask(route: CustomRoute, prompt: String) -> Result<AskOutcome, String> {
    if !may_route(&route) {
        return Ok(refused("That model can't be used for this."));
    }
    let Some(dir) = store_dir() else {
        return Ok(refused("That model can't be used for this."));
    };
    let Some(saved) = read_route(&dir) else {
        return Ok(refused("That model can't be used for this."));
    };
    let models = read_models(&dir);
    if bound_completions_url(&route, &saved, &models).is_none() {
        return Ok(refused("That model can't be used for this."));
    }
    let key = match key_for(&route) {
        Ok(key) => key,
        Err(_) => return Ok(refused("Couldn't reach the Keychain.")),
    };
    if key.is_none() && route.provider != "ollama" {
        return Ok(refused(
            "No key is saved for that model. Add it under Other models.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        text_complete(
            &route,
            &saved,
            &models,
            &prompt,
            key.as_deref(),
            |url, token, body| post_chat(url, token, body, DEADLINE),
        )
    })
    .await
    .map_err(|_| "The model call didn't finish.".to_string())
}

/// Save the short-text route. The address is checked here; the caller does not choose a host.
#[tauri::command]
pub async fn text_generation_remember(route: CustomRoute) -> Result<(), String> {
    let Some(dir) = store_dir() else {
        return Err("That model can't be used for this.".to_string());
    };
    tauri::async_runtime::spawn_blocking(move || remember_route(&dir, &route))
        .await
        .map_err(|_| "That model can't be used for this.".to_string())?
        .map_err(|()| "That model can't be used for this.".to_string())
}

/// Go back to the coding agent for short text.
#[tauri::command]
pub async fn text_generation_forget() -> Result<(), String> {
    let Some(dir) = store_dir() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || forget_route(&dir))
        .await
        .map_err(|_| "That model can't be used for this.".to_string())?
        .map_err(|()| "That model can't be used for this.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(provider: &str, base: &str, model: &str) -> CustomRoute {
        CustomRoute {
            provider: provider.into(),
            base_url: base.into(),
            model_id: model.into(),
            custom_model_id: "text-test".into(),
            reasoning_effort: None,
        }
    }

    fn xai() -> CustomRoute {
        route("xai", "https://api.x.ai/v1", "grok-3")
    }

    /// The route stands in for the saved route and for its own key binding.
    fn ask(
        route: &CustomRoute,
        prompt: &str,
        key: Option<&str>,
        post: impl FnOnce(&str, &str, &str) -> PostResult,
    ) -> AskOutcome {
        text_complete(route, route, std::slice::from_ref(route), prompt, key, post)
    }

    fn with_account(mut route: CustomRoute, account: &str) -> CustomRoute {
        route.custom_model_id = account.into();
        route
    }

    fn quiet(given: &CustomRoute, saved: &CustomRoute, models: &[CustomRoute]) {
        let mut called = false;
        let outcome = text_complete(
            given,
            saved,
            models,
            "Say hi",
            Some("test-key1"),
            |_, _, _| {
                called = true;
                PostResult::Unreachable
            },
        );
        assert!(!called, "{}", given.base_url);
        assert_eq!(outcome.kind, "refused");
        assert!(outcome.text.is_empty());
        assert!(!outcome.reason.contains("test-key1"));
        assert!(!outcome.reason.contains("http"));
    }

    fn quiet_same(given: &CustomRoute) {
        quiet(given, given, std::slice::from_ref(given));
    }

    fn completions_for(dir: &Path, given: &CustomRoute) -> Option<String> {
        let saved = read_route(dir)?;
        bound_completions_url(given, &saved, &read_models(dir))
    }

    #[test]
    fn the_body_is_one_completion_and_names_no_tool_or_path() {
        let body: Value = serde_json::from_str(&text_body(" grok-3 ", "Say hi")).unwrap();
        assert_eq!(body["model"], "grok-3");
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "Say hi");
        assert_eq!(body["messages"].as_array().map(Vec::len), Some(1));
        for key in ["tools", "functions", "cwd", "path", "file"] {
            assert!(body.get(key).is_none(), "{key}");
        }
    }

    #[test]
    fn a_long_reply_is_cut_and_an_unreadable_one_is_empty() {
        let long = "é".repeat(REPLY_LIMIT + 10);
        let raw = json!({ "choices": [{ "message": { "content": long } }] }).to_string();
        match chat_reply(&raw) {
            PostResult::Answer(text) => assert_eq!(text.chars().count(), REPLY_LIMIT),
            other => panic!("expected text, got {other:?}"),
        }
        assert_eq!(chat_reply(r#"{"choices":[]}"#), PostResult::Status(200));
        assert_eq!(chat_reply("not json"), PostResult::Status(200));
        assert_eq!(
            chat_reply(r#"{"choices":[{"message":{"content":"  "}}]}"#),
            PostResult::Status(200)
        );
        let blank = ask(&xai(), "Say hi", Some("k"), |_, _, _| {
            PostResult::Answer("  \n".into())
        });
        assert_eq!(blank.kind, "empty");
        assert!(blank.text.is_empty());
        let shape = ask(&xai(), "Say hi", Some("k"), |_, _, _| {
            PostResult::Status(200)
        });
        assert_eq!(shape.kind, "empty");
        assert!(shape.text.is_empty());
    }

    #[test]
    fn a_secret_a_long_prompt_and_a_blocked_model_are_not_sent() {
        let secret = format!("note {}", "sk-ant-api03-abcdefghijklmnopqrst");
        let claude_key = "sk-ant-oat01-abcdefghijklmnopqrst";
        let cases = [secret, " ".into(), "é".repeat(PROMPT_LIMIT + 1)];
        for prompt in cases {
            let mut called = false;
            let outcome = ask(&xai(), &prompt, Some("k"), |_, _, _| {
                called = true;
                PostResult::Unreachable
            });
            assert!(!called);
            assert_eq!(outcome.kind, "refused");
            assert!(outcome.text.is_empty());
            assert!(!outcome.reason.contains("sk-ant"));
        }
        let blocked = [
            route("xai", "https://api.x.ai/v1", "claude-haiku"),
            route("custom", "http://evil.example/v1", "grok-3"),
            route("xai", "https://api.anthropic.com/v1", "grok-3"),
        ];
        for route in blocked {
            let mut called = false;
            let outcome = ask(&route, "Say hi", Some("k"), |_, _, _| {
                called = true;
                PostResult::Unreachable
            });
            assert!(!called);
            assert_eq!(outcome.kind, "refused");
        }
        let mut called = false;
        let missing = ask(&xai(), "Say hi", None, |_, _, _| {
            called = true;
            PostResult::Unreachable
        });
        assert!(!called);
        assert_eq!(missing.kind, "refused");
        let mut called = false;
        let claude = ask(&xai(), "Say hi", Some(claude_key), |_, _, _| {
            called = true;
            PostResult::Unreachable
        });
        assert!(!called);
        assert_eq!(claude.kind, "refused");
        assert!(!claude.reason.contains("sk-ant"));
        assert!(!claude.text.contains("sk-ant"));

        let mut called = false;
        let edge = ask(&xai(), &"é".repeat(PROMPT_LIMIT), Some("k"), |_, _, _| {
            called = true;
            PostResult::Answer("ok".into())
        });
        assert!(called);
        assert!(edge.ok);
        assert_eq!(edge.text, "ok");
    }

    #[test]
    fn a_timeout_or_a_busy_provider_can_be_tried_again() {
        for code in [408_u16, 429, 500, 599] {
            let outcome = ask(&xai(), "Say hi", Some("k"), |_, _, _| {
                PostResult::Status(code)
            });
            assert!(!outcome.ok);
            assert_eq!(outcome.kind, "timeout", "{code}");
            assert!(outcome.reason.contains("tried again"), "{code}");
            assert!(outcome.text.is_empty());
        }
        let down = ask(&xai(), "Say hi", Some("k"), |_, _, _| {
            PostResult::Unreachable
        });
        assert_eq!(down.kind, "timeout");
        assert!(down.reason.contains("tried again"));
        for code in [400_u16, 401, 403, 404] {
            let outcome = ask(&xai(), "Say hi", Some("k"), |_, _, _| {
                PostResult::Status(code)
            });
            assert_eq!(outcome.kind, "refused", "{code}");
        }
    }

    #[test]
    fn the_token_is_not_in_the_body_or_the_outcome() {
        let key = "provider-key-12345678";
        let mut called = false;
        let leaked_prompt = ask(&xai(), key, Some(key), |_, _, _| {
            called = true;
            PostResult::Answer("no".into())
        });
        assert!(!called);
        assert_eq!(leaked_prompt.kind, "refused");
        assert!(!leaked_prompt.reason.contains(key));
        assert!(!leaked_prompt.text.contains(key));

        let echoed = ask(&xai(), "Say hi", Some(key), |url, token, body| {
            assert_eq!(url, "https://api.x.ai/v1/chat/completions");
            assert_eq!(token, key);
            assert!(!body.contains(key));
            assert!(serde_json::from_str::<Value>(body)
                .unwrap()
                .get("tools")
                .is_none());
            PostResult::Answer(format!("here {key}"))
        });
        assert!(!echoed.ok);
        assert!(echoed.text.is_empty());
        assert!(!echoed.reason.contains(key));

        let answer = ask(&xai(), "Say hi", Some(key), |_, token, body| {
            assert_eq!(token, key);
            assert!(!body.contains(key));
            PostResult::Answer("A title".into())
        });
        assert!(answer.ok);
        assert_eq!(answer.text, "A title");
        assert!(!answer.text.contains(key));
        assert!(!answer.reason.contains(key));

        let secret = "sk-ant-api03-abcdefghijklmnopqrst";
        let hidden = ask(&xai(), "Say hi", Some(key), |_, _, _| {
            PostResult::Answer(format!("see {secret}"))
        });
        assert_eq!(hidden.kind, "timeout");
        assert!(!hidden.text.contains("sk-ant"));
        assert!(!hidden.reason.contains("sk-ant"));
    }

    #[test]
    fn ollama_needs_no_key_and_still_gets_no_tools() {
        let local = route("ollama", "http://localhost:11434", "llama3.2");
        let outcome = ask(&local, "Say hi", None, |url, token, body| {
            assert_eq!(url, "http://localhost:11434/v1/chat/completions");
            assert_eq!(token, "monocode-ollama-local");
            assert!(serde_json::from_str::<Value>(body)
                .unwrap()
                .get("tools")
                .is_none());
            PostResult::Answer("local".into())
        });
        assert_eq!(
            (outcome.ok, outcome.text.as_str(), outcome.kind.as_str()),
            (true, "local", "ok")
        );
    }

    #[test]
    fn a_real_call_gives_up_at_the_deadline() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = upstream.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            std::thread::sleep(Duration::from_secs(3));
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        });
        let started = std::time::Instant::now();
        let out = post_chat(
            &format!("http://127.0.0.1:{port}/v1/chat/completions"),
            "k",
            "{}",
            Duration::from_millis(300),
        );
        assert_eq!(out, PostResult::Unreachable);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_different_host_is_not_called() {
        let saved = xai();
        let evil = route("xai", "https://evil.example/v1", "grok-3");
        let suffix = route("xai", "https://api.x.ai.evil.example/v1", "grok-3");
        assert!(may_route(&evil) && may_route(&suffix));
        quiet(&evil, &saved, std::slice::from_ref(&saved));
        quiet(&suffix, &saved, std::slice::from_ref(&saved));
        // A saved route that was itself pointed at the other host still does not send.
        quiet_same(&evil);
        quiet_same(&suffix);
    }

    #[test]
    fn userinfo_query_and_fragment_are_not_called() {
        let saved = xai();
        for base in [
            "https://api.x.ai@evil.example/v1",
            "https://user:pass@api.x.ai/v1",
            "https://:secret@api.x.ai/v1",
            "https://api.x.ai/v1?token=1",
            "https://api.x.ai/v1#frag",
        ] {
            let given = route("xai", base, "grok-3");
            assert!(may_route(&given), "{base}");
            quiet(&given, &saved, std::slice::from_ref(&saved));
        }
    }

    #[test]
    fn plain_http_is_only_ollama_on_this_mac() {
        let loopback = route("xai", "http://127.0.0.1:9/v1", "grok-3");
        assert!(
            may_route(&loopback),
            "loopback http is allowed before the host check"
        );
        quiet_same(&loopback);
        let clear = route("xai", "http://api.x.ai/v1", "grok-3");
        assert!(!may_route(&clear));
        quiet_same(&clear);
        let public = route("ollama", "https://evil.example:11434", "llama3.2");
        assert!(may_route(&public));
        quiet_same(&public);
        let https_loop = route("ollama", "https://127.0.0.1:11434", "llama3.2");
        assert!(may_route(&https_loop));
        quiet_same(&https_loop);
    }

    #[test]
    fn a_trailing_dot_or_different_case_still_posts_to_the_real_host() {
        let cases = [
            (
                "xai",
                "https://API.X.AI./v1",
                "https://api.x.ai/v1",
                "grok-3",
                "https://api.x.ai/v1/chat/completions",
            ),
            (
                "xai",
                "https://api.x.ai:443/v1",
                "https://api.x.ai/v1",
                "grok-3",
                "https://api.x.ai/v1/chat/completions",
            ),
            (
                "openrouter",
                "https://OpenRouter.ai./api/v1",
                "https://openrouter.ai/api/v1",
                "m",
                "https://openrouter.ai/api/v1/chat/completions",
            ),
            (
                "deepseek",
                "https://API.DeepSeek.com./v1/",
                "https://api.deepseek.com/v1",
                "m",
                "https://api.deepseek.com/v1/chat/completions",
            ),
            (
                "ollama",
                "http://LOCALHOST:11434",
                "http://localhost:11434",
                "llama3.2",
                "http://localhost:11434/v1/chat/completions",
            ),
            (
                "ollama",
                "http://[::1]:11434",
                "http://[::1]:11434",
                "llama3.2",
                "http://[::1]:11434/v1/chat/completions",
            ),
        ];
        for (provider, given_base, saved_base, model, expect) in cases {
            let given = route(provider, given_base, model);
            let saved = route(provider, saved_base, model);
            let outcome = text_complete(
                &given,
                &saved,
                std::slice::from_ref(&saved),
                "Say hi",
                Some("test-key1"),
                |url, _, _| {
                    assert_eq!(url, expect, "{given_base}");
                    assert!(!url.contains("API") && !url.ends_with('.') && !url.contains(":443"));
                    PostResult::Answer("ok".into())
                },
            );
            assert!(outcome.ok, "{given_base}");
            assert_eq!(outcome.text, "ok");
        }
        let saved = with_account(route("custom", "https://llm.example/v1", "m"), "custom-1");
        let given = with_account(route("custom", "https://LLM.Example./v1/", "m"), "custom-1");
        let outcome = text_complete(
            &given,
            &saved,
            std::slice::from_ref(&saved),
            "Say hi",
            Some("test-key1"),
            |url, _, _| {
                assert_eq!(url, "https://llm.example/v1/chat/completions");
                PostResult::Answer("ok".into())
            },
        );
        assert!(outcome.ok);
    }

    #[test]
    fn another_saved_accounts_key_is_not_used() {
        let saved = with_account(xai(), "text-key");
        let other = with_account(xai(), "other-key");
        let models = [saved.clone(), other.clone()];
        quiet(&other, &saved, &models);
    }

    #[test]
    fn a_custom_address_must_match_the_saved_one() {
        let saved = with_account(route("custom", "https://llm.example/v1", "m"), "custom-1");
        let models = [saved.clone()];
        let mut port = saved.clone();
        port.base_url = "https://llm.example:8443/v1".into();
        quiet(&port, &saved, &models);
        let mut extra = saved.clone();
        extra.base_url = "https://llm.example/v1/extra".into();
        quiet(&extra, &saved, &models);
        // The route file agreeing with the caller is not enough. The address stored with the key wins.
        quiet(&port, &port, &models);
        quiet(&extra, &extra, &models);
    }

    #[test]
    fn the_saved_route_on_disk_keeps_the_key_on_its_host() {
        let dir = std::env::temp_dir().join(format!("wp129-disk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let custom = with_account(route("custom", "https://llm.example/v1", "m"), "custom-1");
        let other = with_account(xai(), "other-key");
        let text = with_account(route("xai", "https://API.X.AI./v1", "grok-3"), "text-key");
        let text_saved = with_account(xai(), "text-key");
        record_model_binding(&dir, &custom).unwrap();
        record_model_binding(&dir, &other).unwrap();
        record_model_binding(&dir, &text_saved).unwrap();
        assert!(record_model_binding(
            &dir,
            &with_account(route("custom", "http://127.0.0.1:9/v1", "m"), "custom-http")
        )
        .is_err());
        assert!(!dir.join("models").join("custom-http").exists());
        assert!(dir.join("models").join("custom-1").is_file());
        assert!(dir.join("models").join("other-key").is_file());
        remember_route(&dir, &text).unwrap();
        let raw = fs::read_to_string(dir.join("route.json")).unwrap();
        assert!(raw.contains("https://api.x.ai/v1"), "{raw}");
        assert!(!raw.contains("API"), "{raw}");
        assert!(!raw.contains("x.ai."), "{raw}");
        assert_eq!(
            completions_for(&dir, &text_saved).as_deref(),
            Some("https://api.x.ai/v1/chat/completions")
        );
        let mut shifted = text_saved.clone();
        shifted.base_url = "https://api.x.ai:8443/v1".into();
        assert!(completions_for(&dir, &shifted).is_none());
        assert!(completions_for(&dir, &other).is_none());

        remember_route(&dir, &custom).unwrap();
        assert_eq!(
            completions_for(&dir, &custom).as_deref(),
            Some("https://llm.example/v1/chat/completions")
        );
        let mut custom_port = custom.clone();
        custom_port.base_url = "https://llm.example:8443/v1".into();
        assert!(completions_for(&dir, &custom_port).is_none());
        let mut custom_path = custom.clone();
        custom_path.base_url = "https://llm.example/v1/extra".into();
        assert!(completions_for(&dir, &custom_path).is_none());
        assert!(completions_for(&dir, &other).is_none());

        let before = fs::read_to_string(dir.join("route.json")).unwrap();
        assert!(remember_route(
            &dir,
            &with_account(
                route("xai", "https://api.x.ai@evil.example/v1", "grok-3"),
                "text-key"
            )
        )
        .is_err());
        assert!(remember_route(
            &dir,
            &with_account(route("xai", "http://127.0.0.1:9/v1", "grok-3"), "text-key")
        )
        .is_err());
        assert_eq!(fs::read_to_string(dir.join("route.json")).unwrap(), before);

        fs::write(dir.join("models").join("custom-1"), "{").unwrap();
        assert!(
            completions_for(&dir, &custom).is_none(),
            "corrupt json is missing"
        );
        fs::write(dir.join("route.json"), "{").unwrap();
        assert!(completions_for(&dir, &text_saved).is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
