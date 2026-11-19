//! WP-129: one short completion for a title, a commit message, pull request text or a branch name.
//!
//! No tools, no path and no repo writes. The key is read here and never comes back. A timeout or an
//! unreachable provider is a try-again (`kind: "timeout"`), not a crash and not a cleared setting.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};

use crate::history_import::{classify, AskOutcome, PostResult};
use crate::key_binding::{
    base_string, cleaned, from_json, host_for_url, normalize_base, read_sealed, safe_account,
    to_json, write_atomic, NormalUrl,
};
use crate::model_router::{may_route, session_token, CustomRoute};

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

/// The key goes to the one URL it was bound to. A redirect is not followed, whatever the code is: the
/// answer is the status, and the key is not offered to the address the provider named.
fn post_chat(url: &str, token: &str, body: &str, deadline: Duration) -> PostResult {
    let agent = ureq::AgentBuilder::new()
        .timeout(deadline)
        .redirects(0)
        .build();
    match agent
        .post(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(body)
    {
        Ok(response) if response.status() >= 300 => PostResult::Status(response.status()),
        Ok(response) => chat_reply(&response.into_string().unwrap_or_default()),
        Err(ureq::Error::Status(code, _)) => PostResult::Status(code),
        Err(ureq::Error::Transport(_)) => PostResult::Unreachable,
    }
}

/// The shortest key short text will use. Real provider keys are longer.
const MIN_KEY_CHARS: usize = 8;

/// A key must not come back in the prompt, the body or the reply. A shorter key is refused before this
/// runs, because a substring check on a few characters hits ordinary words ("model", "max_tokens").
fn holds_token(token: &str, text: &str) -> bool {
    token.chars().count() >= MIN_KEY_CHARS && text.contains(token)
}

/// A name that holds a secret: pass, password, pwd, secret, token, api key and the like, in snake,
/// kebab, dotted, camel or upper case. Whole words only, so `bypass` and `compass` are not names.
/// `tokens` is left out on purpose: `max_tokens` is a count.
fn secret_name(name: &str) -> (bool, bool) {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut after_lower = false;
    for c in name.chars() {
        if matches!(c, '_' | '-' | '.') {
            words.push(std::mem::take(&mut current));
            after_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && after_lower {
            words.push(std::mem::take(&mut current));
        }
        current.push(c.to_ascii_lowercase());
        after_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
    }
    words.push(current);
    let ends = |word: &str, tails: &[&str]| tails.iter().any(|tail| word.ends_with(tail));
    let password = words.iter().any(|word| {
        matches!(word.as_str(), "pass" | "pwd" | "passphrase")
            || ends(word, &["password", "passwd"])
    });
    let other = words.iter().any(|word| {
        ends(
            word,
            &[
                "secret",
                "secrets",
                "token",
                "apikey",
                "credential",
                "credentials",
            ],
        )
    }) || words.windows(2).any(|pair| {
        matches!(
            (pair[0].as_str(), pair[1].as_str()),
            (
                "api" | "access" | "private" | "secret" | "auth" | "signing",
                "key"
            ) | ("client", "secret")
        )
    });
    (password || other, password)
}

/// Words that follow a secret-looking name without being a secret: a type, a flag or an empty value.
fn plain_word(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "true"
            | "false"
            | "null"
            | "none"
            | "nil"
            | "undefined"
            | "string"
            | "str"
            | "number"
            | "int"
            | "integer"
            | "bool"
            | "boolean"
            | "any"
            | "unknown"
            | "object"
            | "void"
            | "required"
            | "optional"
            | "empty"
            // Passing a variable along, or a placeholder: `token: secret`, `password=password`.
            | "pass"
            | "pwd"
            | "password"
            | "passwd"
            | "secret"
            | "token"
            | "key"
            | "apikey"
    )
}

/// A value written after a secret-looking name: a letter, digit or anything else, 4 or more
/// characters, that is not an expression, a reference or a type. This path only. The shared scrubber
/// wants a digit and 16 characters, and it must not change for the other places that use it.
fn assigned_secret(line: &str) -> bool {
    static ASSIGN: OnceLock<Regex> = OnceLock::new();
    static CHAIN: OnceLock<Regex> = OnceLock::new();
    let assign = ASSIGN.get_or_init(|| {
        Regex::new(
            r#"([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*(?:=>|:=|[:=])\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'`,;&]+))"#,
        )
        .expect("the assignment pattern compiles")
    });
    let chain = CHAIN.get_or_init(|| {
        Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$")
            .expect("the reference pattern compiles")
    });
    assign.captures_iter(line).any(|caps| {
        let (named, password) = secret_name(&caps[1]);
        let Some(value) = caps.get(2).or(caps.get(3)).or(caps.get(4)) else {
            return false;
        };
        let value = value.as_str();
        // A quoted string can hold more assignments, as in a link's query: `url = "https://x/?token=..."`.
        if value.len() < line.len() && value.contains(['=', ':']) && assigned_secret(value) {
            return true;
        }
        // A bare value with more code after it is the start of an expression: `token = match f(x) {`.
        let quoted = caps.get(2).is_some() || caps.get(3).is_some();
        let rest = caps.get(0).map_or("", |all| line[all.end()..].trim_start());
        let more_code = !quoted
            && !rest.is_empty()
            && !rest.starts_with(['#', '/', ';', ',', '}', ')', ']', '&', '"', '\'', '`']);
        let expression = more_code
            || value.contains(['(', ')', '{', '}', '[', ']', '<', '>', '$', '|', '\\'])
            || value.starts_with('=');
        named
            && value.chars().count() >= 4
            && !expression
            && !plain_word(value)
            && !chain.is_match(value)
            // A number is a secret only after a password name. `token_ttl = 3600` is not one.
            && (password || value.chars().any(|c| c.is_ascii_alphabetic()))
    })
}

/// A secret in the prompt. Commit and pull request asks carry a patch, where a line starts with + or -,
/// and the shared scrubber does not see a name that follows that character. So each line is checked again
/// with one leading + or - removed, and a value after a secret-looking name counts without a digit.
/// One hit refuses the whole ask.
fn prompt_has_secret(prompt: &str) -> bool {
    let scrubber = crate::portable::scrubber();
    if scrubber.has_secret(prompt) {
        return true;
    }
    prompt.lines().any(|line| {
        let body = line.strip_prefix(['+', '-']).unwrap_or(line);
        scrubber.has_secret(body) || assigned_secret(body)
    })
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

/// Named providers go only to the one host `import_destination_allowed` already names, on the default
/// port. Ollama is http on this Mac. Custom is https.
fn host_allowed(provider: &str, url: &NormalUrl) -> bool {
    match provider {
        "xai" | "openrouter" | "deepseek" | "ollama" => {
            if provider != "ollama" && url.port.is_some() {
                return false;
            }
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

/// The completions URL for this ask, or nothing.
///
/// The caller's route must be the saved short-text route. The address must be one this provider may use
/// (a named provider's one host, or https for custom). A key (every provider but Ollama) must also have
/// the provider, model and address that were stored when it was saved, and the caller's must equal them.
/// A key with nothing stored is not sent anywhere: nothing says which host it belongs to.
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
    let given_url = normalize_base(&given.base_url)?;
    if given_url != normalize_base(&saved.base_url)? || !host_allowed(&given.provider, &given_url) {
        return None;
    }
    if given.provider == "ollama" {
        // No key is read for Ollama. A named account, when there is one, must still be a plain name.
        if !given.custom_model_id.is_empty() && !safe_account(&given.custom_model_id) {
            return None;
        }
    } else {
        if !safe_account(&given.custom_model_id) {
            return None;
        }
        let bound = models
            .iter()
            .find(|model| model.custom_model_id == given.custom_model_id)?;
        if bound.provider != given.provider
            || !same_model(&bound.model_id, &given.model_id)
            || normalize_base(&bound.base_url)? != given_url
        {
            return None;
        }
    }
    Some(completions_from(&given.provider, &given_url))
}

/// This copy's short-text folder: the saved route. Missing when there is no data folder yet.
pub fn store_dir() -> Option<PathBuf> {
    let id = crate::instance::current().identifier.clone();
    crate::instance::data_dir(&id).map(|dir| dir.join("text-generation"))
}

fn read_route(dir: &Path) -> Option<CustomRoute> {
    from_json(&fs::read_to_string(dir.join("route.json")).ok()?)
}

/// Remember which saved model short text uses. A key's address must already be the one stored with
/// that key, and a named provider must be its one known host.
pub fn remember_route(
    dir: &Path,
    read_item: crate::key_binding::ItemReader,
    route: &CustomRoute,
) -> Result<(), ()> {
    let url = normalize_base(&route.base_url).ok_or(())?;
    let clean = cleaned(route, &url);
    let models: Vec<CustomRoute> = read_sealed(read_item, &clean.custom_model_id)
        .ok()
        .flatten()
        .map(|sealed| sealed.binding)
        .into_iter()
        .collect();
    if !may_route(&clean) || bound_completions_url(&clean, &clean, &models).is_none() {
        return Err(());
    }
    fs::create_dir_all(dir).map_err(|_| ())?;
    let root = crate::fs::canonical(dir).map_err(|_| ())?;
    let path = root.join("route.json");
    write_atomic(&root, &path, &to_json(&clean).ok_or(())?)
}

/// Drop the saved short-text route. The addresses stored with keys stay until the key is deleted.
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
    if prompt_has_secret(prompt) {
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
    // A key shorter than this cannot be told apart from a word in the prompt or the reply, so
    // `holds_token` cannot guard it. It is refused for this call, not sent.
    if token.chars().count() < MIN_KEY_CHARS {
        return refused(
            "That key is too short to use here. Save the provider's full key under Other models.",
        );
    }
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

/// The whole ask against the store folder: `dir` holds the saved short-text route. The key comes from the model's
/// Keychain item, and is used only when the route matches the saved route and the address stored with the key.
/// `read_item` and `post` are the Keychain and the network; tests stand in for both.
pub fn ask_in(
    dir: &Path,
    read_item: crate::key_binding::ItemReader,
    route: &CustomRoute,
    prompt: &str,
    post: impl FnOnce(&str, &str, &str) -> PostResult,
) -> AskOutcome {
    let not_this = || refused("That model can't be used for this.");
    if !may_route(route) {
        return not_this();
    }
    let Some(saved) = read_route(dir) else {
        return not_this();
    };
    let sealed = if route.provider == "ollama" {
        None
    } else {
        match read_sealed(read_item, &route.custom_model_id) {
            Ok(sealed) => sealed,
            Err(_) => return refused("Couldn't reach the Keychain."),
        }
    };
    let models: Vec<CustomRoute> = sealed.iter().map(|s| s.binding.clone()).collect();
    if bound_completions_url(route, &saved, &models).is_none() {
        return not_this();
    }
    let key = sealed.map(|s| s.key);
    if key.is_none() && route.provider != "ollama" {
        return refused("No key is saved for that model. Add it under Other models.");
    }
    text_complete(route, &saved, &models, prompt, key.as_deref(), post)
}

/// One short reply. The arguments are the route and the prompt: there is no path to write.
#[tauri::command]
pub async fn text_generation_ask(route: CustomRoute, prompt: String) -> Result<AskOutcome, String> {
    let Some(dir) = store_dir() else {
        return Ok(refused("That model can't be used for this."));
    };
    tauri::async_runtime::spawn_blocking(move || {
        ask_in(
            &dir,
            &crate::key_binding::keychain_item,
            &route,
            &prompt,
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
    tauri::async_runtime::spawn_blocking(move || {
        remember_route(&dir, &crate::key_binding::keychain_item, &route)
    })
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

    /// The model-key Keychain for these tests, by account. `bind` seals a key for a route as Other models does;
    /// `read` counts its reads.
    #[derive(Default)]
    struct Keys {
        items: std::cell::RefCell<Vec<(String, String)>>,
        reads: std::cell::Cell<usize>,
    }

    impl Keys {
        fn bind(&self, route: &CustomRoute) {
            let item = crate::key_binding::sealed_item(route, "test-key1234");
            let mut items = self.items.borrow_mut();
            items.retain(|(account, _)| *account != route.custom_model_id);
            items.push((route.custom_model_id.clone(), item));
        }

        fn read(&self, account: &str) -> Result<Option<String>, String> {
            self.reads.set(self.reads.get() + 1);
            Ok(self
                .items
                .borrow()
                .iter()
                .find(|(a, _)| a == account)
                .map(|(_, item)| item.clone()))
        }

        fn stored(&self, account: &str) -> Vec<CustomRoute> {
            crate::key_binding::read_sealed(&|a| self.read(a), account)
                .ok()
                .flatten()
                .map(|sealed| sealed.binding)
                .into_iter()
                .collect()
        }
    }

    fn completions_for(dir: &Path, hosts: &Keys, given: &CustomRoute) -> Option<String> {
        let saved = read_route(dir)?;
        bound_completions_url(given, &saved, &hosts.stored(&given.custom_model_id))
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
        let blank = ask(&xai(), "Say hi", Some("test-key1"), |_, _, _| {
            PostResult::Answer("  \n".into())
        });
        assert_eq!(blank.kind, "empty");
        assert!(blank.text.is_empty());
        let shape = ask(&xai(), "Say hi", Some("test-key1"), |_, _, _| {
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
            let outcome = ask(&xai(), &prompt, Some("test-key1"), |_, _, _| {
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
            let outcome = ask(&route, "Say hi", Some("test-key1"), |_, _, _| {
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
        let edge = ask(
            &xai(),
            &"é".repeat(PROMPT_LIMIT),
            Some("test-key1"),
            |_, _, _| {
                called = true;
                PostResult::Answer("ok".into())
            },
        );
        assert!(called);
        assert!(edge.ok);
        assert_eq!(edge.text, "ok");
    }

    /// A commit or pull request ask carries a patch.
    fn patch(lines: &[&str]) -> String {
        let mut out = String::from(
            "Write a commit message.\n\ndiff --git a/app/config b/app/config\n--- a/app/config\n+++ b/app/config\n@@ -1,3 +1,4 @@\n",
        );
        for line in lines {
            out.push_str(line);
            out.push('\n');
        }
        out
    }

    fn sent(prompt: &str) -> bool {
        let mut called = false;
        let outcome = ask(&xai(), prompt, Some("test-key1234"), |_, _, _| {
            called = true;
            PostResult::Answer("A title".into())
        });
        if !called {
            assert_eq!(outcome.kind, "refused", "{prompt}");
            assert!(outcome.text.is_empty());
            assert!(outcome.reason.contains("secret"), "{}", outcome.reason);
        }
        called
    }

    #[test]
    fn a_secret_on_an_added_or_removed_diff_line_refuses_the_whole_ask() {
        for line in [
            "+DB_PASSWORD=correcthorsebatterystaple",
            "+SMTP_PASS=hunter",
            "-DB_PASSWORD=correcthorsebatterystaple",
            " DB_PASSWORD=correcthorsebatterystaple",
            "+export SMTP_PASS=hunter",
            "+  \"password\": \"hunter\"",
            "+  dbPassword: 'hunter'",
            "+smtp.pass = \"hunter\"",
            "+API_KEY=abcdefghij",
            "+client_secret: \"correct horse battery\"",
            "+url = \"https://api.example/v1?token=abcdefgh&x=1\"",
            "+  'password' => 'hunter',",
            "+DB_PASSWORD=12345678",
            "+AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
        ] {
            assert!(
                !sent(&patch(&["+let ok = 1;", line, "+let more = 2;"])),
                "{line}"
            );
        }
        // The same line outside a patch is refused too.
        assert!(!sent("SMTP_PASS=hunter"));
        assert!(!sent("my notes\nDB_PASSWORD=correcthorsebatterystaple"));
    }

    #[test]
    fn a_clean_diff_still_sends() {
        // The shared scrubber already refuses a long value after `password:` or `token:` (for example
        // `password: Option<String>`), so lines like that are not here. These are the ones this path must not
        // start refusing: names that only look like secrets, and values that are not literals.
        let clean = patch(&[
            "-const limit = 10;",
            "+const limit = 20;",
            "+max_tokens: 1024",
            "+  password: string;",
            "+let token = next();",
            "+if token == expected {",
            "+let bypass = true;",
            "+    passed: 12,",
            "+let secret = \"\";",
            "+login(user, password=None)",
            "+token_limit = 100",
            "+password: {{ db_password }}",
            "+let key = \"abc\";",
            "+let compass = north;",
            "+--- a note about a dashed line",
        ]);
        assert!(sent(&clean));
        assert!(sent("Write a title for: add a retry to the upload"));
    }

    #[test]
    fn a_secret_in_a_header_or_a_comment_line_is_still_refused() {
        // A known token shape is found on a diff line, with the leading character removed or not.
        let token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        assert!(!sent(&patch(&[&format!("+{token}")])));
        assert!(!sent(&patch(&[&format!("-{token}")])));
        assert!(!sent(&patch(&[&format!("+// {token}")])));
    }

    #[test]
    fn a_key_shorter_than_eight_characters_is_not_used() {
        // A short key cannot be told apart from a word in the reply, so it is refused, not sent.
        for key in ["k", "hunter", "1234567", " abc ", "\u{4e2d}\u{6587}", ""] {
            let mut called = false;
            let outcome = ask(&xai(), "Say hi", Some(key), |_, _, _| {
                called = true;
                PostResult::Answer("A title".into())
            });
            assert!(!called, "{key:?}");
            assert_eq!(outcome.kind, "refused", "{key:?}");
            assert!(outcome.text.is_empty());
            if !key.trim().is_empty() {
                assert_eq!(
                    outcome.reason,
                    "That key is too short to use here. Save the provider's full key under Other models."
                );
                // The sentence never echoes the key. (A single letter would match the word "key".)
                if key.trim().chars().count() > 2 {
                    assert!(!outcome.reason.contains(key.trim()));
                }
            }
        }
        // Eight characters is the floor, and Ollama has no key to check.
        let mut called = false;
        let edge = ask(&xai(), "Say hi", Some("12345678"), |_, _, _| {
            called = true;
            PostResult::Answer("A title".into())
        });
        assert!(called && edge.ok);
        let local = route("ollama", "http://localhost:11434", "llama3.2");
        assert!(
            ask(&local, "Say hi", None, |_, _, _| PostResult::Answer(
                "x".into()
            ))
            .ok
        );
    }

    #[test]
    fn a_timeout_or_a_busy_provider_can_be_tried_again() {
        for code in [408_u16, 429, 500, 599] {
            let outcome = ask(&xai(), "Say hi", Some("test-key1"), |_, _, _| {
                PostResult::Status(code)
            });
            assert!(!outcome.ok);
            assert_eq!(outcome.kind, "timeout", "{code}");
            assert!(outcome.reason.contains("tried again"), "{code}");
            assert!(outcome.text.is_empty());
        }
        let down = ask(&xai(), "Say hi", Some("test-key1"), |_, _, _| {
            PostResult::Unreachable
        });
        assert_eq!(down.kind, "timeout");
        assert!(down.reason.contains("tried again"));
        for code in [400_u16, 401, 403, 404] {
            let outcome = ask(&xai(), "Say hi", Some("test-key1"), |_, _, _| {
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
    fn a_key_with_no_stored_host_is_not_sent() {
        // A key saved before its host was stored has no binding. Nothing says which host it is for.
        let routes = [
            xai(),
            route("openrouter", "https://openrouter.ai/api/v1", "m"),
            route("deepseek", "https://api.deepseek.com/v1", "m"),
        ];
        for given in &routes {
            quiet(given, given, &[]);
            // Another account's binding is not this account's.
            let other = with_account(given.clone(), "other-key");
            quiet(given, given, std::slice::from_ref(&other));
        }
    }

    #[test]
    fn a_key_stays_with_the_provider_it_was_saved_for() {
        let custom = with_account(route("custom", "https://llm.example/v1", "m"), "acct-1");
        let openrouter = with_account(
            route("openrouter", "https://openrouter.ai/api/v1", "m"),
            "acct-2",
        );
        let models = [custom, openrouter];
        // The account is a custom model's. It is asked for as xAI, whose host is a real one.
        let as_xai = with_account(route("xai", "https://api.x.ai/v1", "m"), "acct-1");
        quiet(&as_xai, &as_xai, &models);
        // An OpenRouter key is not sent to xAI or DeepSeek either.
        let or_as_xai = with_account(route("xai", "https://api.x.ai/v1", "m"), "acct-2");
        quiet(&or_as_xai, &or_as_xai, &models);
        let or_as_deepseek = with_account(
            route("deepseek", "https://api.deepseek.com/v1", "m"),
            "acct-2",
        );
        quiet(&or_as_deepseek, &or_as_deepseek, &models);
        // A key saved for OpenRouter is not a custom model's, whatever address the caller gives it.
        let as_custom = with_account(route("custom", "https://api.x.ai/v1", "m"), "acct-2");
        quiet(&as_custom, &as_custom, &models);
        // Another model id for the same account is not the saved model either.
        let other_model = with_account(route("custom", "https://llm.example/v1", "m2"), "acct-1");
        quiet(&other_model, &other_model, &models);
    }

    #[test]
    fn a_named_provider_on_another_port_is_not_called() {
        for (provider, base) in [
            ("xai", "https://api.x.ai:8443/v1"),
            ("openrouter", "https://openrouter.ai:8443/api/v1"),
            ("deepseek", "https://api.deepseek.com:444/v1"),
        ] {
            let given = route(provider, base, "m");
            quiet_same(&given);
        }
    }

    #[test]
    fn a_look_alike_host_is_not_called() {
        let saved = xai();
        let models = std::slice::from_ref(&saved);
        for base in [
            "https://api.x.ai.evil.example/v1",
            "https://api.x.ai.evil.example./v1",
            "https://api-x.ai/v1",
            "https://xapi.x.ai/v1",
            "https://x.ai/v1",
            // Cyrillic a, and a full-width i. Neither is the ASCII host once parsed.
            "https://\u{0430}pi.x.ai/v1",
            "https://api.x.a\u{FF49}.evil.example/v1",
            "https://evil.example\\@api.x.ai/v1",
            "https://evil.example/https://api.x.ai/v1",
            "https://evil.example#@api.x.ai/v1",
            "https://evil.example?@api.x.ai/v1",
            "https://api.x.ai@evil.example/v1",
            "https://api.x.ai:443@evil.example/v1",
            "https://api.x.ai%2eevil.example/v1",
            "https://[::1]/v1",
            "https://203.0.113.7/v1",
        ] {
            let given = route("xai", base, "grok-3");
            quiet(&given, &saved, models);
            quiet(&given, &given, std::slice::from_ref(&given));
        }
    }

    #[test]
    fn a_custom_address_that_is_not_the_saved_one_is_not_called() {
        let saved = with_account(route("custom", "https://llm.example/v1", "m"), "custom-1");
        let models = [saved.clone()];
        for base in [
            "https://llm.example.evil.example/v1",
            "https://llm.example@evil.example/v1",
            "https://llm.example:pw@evil.example/v1",
            // Userinfo is refused even when the host after it is the saved one.
            "https://user@llm.example/v1",
            "https://user:pw@llm.example/v1",
            "https://evil.example\\@llm.example/v1",
            "http://llm.example/v1",
            "https://llm.example/v1?x=1",
            "https://llm.example/v1#x",
            "https://llm.example/v1/../v2",
            "https://llm.example/v1/%2e%2e/v2",
            "https://llm.example/v10",
            "https://llm.example/V1",
            "https://llm.example/",
            "https://llm.example",
            "https://sub.llm.example/v1",
            "https://llm.example:444/v1",
            "https://evil.example/v1",
        ] {
            let given = with_account(route("custom", base, "m"), "custom-1");
            quiet(&given, &saved, &models);
            // The saved route agreeing with the caller is not enough: the address stored with the key wins.
            quiet(&given, &given, &models);
        }
    }

    #[test]
    fn a_redirect_is_not_followed() {
        let key = "provider-key-12345678";
        for code in [301_u16, 302, 303, 307, 308] {
            let (out, seen, followed) = crate::key_binding::redirect_probe(code, |base| {
                post_chat(
                    &format!("{base}/v1/chat/completions"),
                    key,
                    "{}",
                    Duration::from_secs(5),
                )
            });
            assert!(
                seen.contains(&format!("authorization: bearer {key}")),
                "{seen}"
            );
            assert_eq!(out, PostResult::Status(code), "{code}");
            assert!(!followed, "{code}: the redirect was followed");
        }
    }

    /// The short-text folder, and an empty Keychain for the model keys.
    fn temp_store(name: &str) -> (PathBuf, Keys) {
        let dir = std::env::temp_dir().join(format!("wp129-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        (dir, Keys::default())
    }

    /// Runs the whole command path on temporary stores, with the Keychain and the network stood in.
    /// Returns the outcome, how many times the key was read and the URL that was posted, if any.
    fn run_ask(
        dir: &Path,
        keys: &Keys,
        given: &CustomRoute,
    ) -> (AskOutcome, usize, Option<String>) {
        keys.reads.set(0);
        let mut posted = None;
        let outcome = ask_in(dir, &|a| keys.read(a), given, "Say hi", |url, _, _| {
            posted = Some(url.to_string());
            PostResult::Answer("A title".into())
        });
        (outcome, keys.reads.get(), posted)
    }

    #[test]
    fn the_key_is_read_only_for_the_saved_route_on_its_own_host() {
        let (dir, hosts) = temp_store("ask");
        let saved = with_account(xai(), "text-key");
        // Nothing saved yet: nothing is read and nothing is sent.
        let (outcome, reads, posted) = run_ask(&dir, &hosts, &saved);
        assert_eq!((outcome.kind.as_str(), reads, posted), ("refused", 0, None));

        hosts.bind(&saved);
        // A key is bound, but no short-text route is saved yet.
        let (outcome, reads, posted) = run_ask(&dir, &hosts, &saved);
        assert_eq!((outcome.kind.as_str(), reads, posted), ("refused", 0, None));

        remember_route(&dir, &|a| hosts.read(a), &saved).unwrap();
        let (outcome, reads, posted) = run_ask(&dir, &hosts, &saved);
        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(reads, 1);
        assert_eq!(
            posted.as_deref(),
            Some("https://api.x.ai/v1/chat/completions")
        );

        for base in [
            "https://evil.example/v1",
            "https://api.x.ai@evil.example/v1",
            "https://api.x.ai:8443/v1",
            "http://api.x.ai/v1",
        ] {
            let mut given = saved.clone();
            given.base_url = base.into();
            let (outcome, _, posted) = run_ask(&dir, &hosts, &given);
            assert_eq!((outcome.kind.as_str(), posted), ("refused", None), "{base}");
        }
        // Another saved model's account name, a different model and a different provider.
        let other_account = with_account(xai(), "other-key");
        let mut other_model = saved.clone();
        other_model.model_id = "grok-4".into();
        let mut other_provider = saved.clone();
        other_provider.provider = "openrouter".into();
        other_provider.base_url = "https://openrouter.ai/api/v1".into();
        for given in [other_account, other_model, other_provider] {
            let (outcome, _, posted) = run_ask(&dir, &hosts, &given);
            assert_eq!(
                (outcome.kind.as_str(), posted),
                ("refused", None),
                "{given:?}"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_keychain_or_a_missing_key_sends_nothing() {
        let (dir, hosts) = temp_store("keyless");
        let saved = with_account(xai(), "text-key");
        hosts.bind(&saved);
        remember_route(&dir, &|a| hosts.read(a), &saved).unwrap();
        // The Keychain fails, then has no item for the account: nothing is sent either way.
        let failing = |_: &str| -> Result<Option<String>, String> { Err("denied".into()) };
        let empty = |_: &str| -> Result<Option<String>, String> { Ok(None) };
        for read in [
            &failing as &dyn Fn(&str) -> Result<Option<String>, String>,
            &empty,
        ] {
            let mut called = false;
            let outcome = ask_in(&dir, read, &saved, "Say hi", |_, _, _| {
                called = true;
                PostResult::Unreachable
            });
            assert!(!called);
            assert_eq!(outcome.kind, "refused");
            assert!(!outcome.reason.contains("denied"));
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_proxy_address_is_stored_for_other_commands_but_short_text_refuses_it() {
        // A person may point a named provider at a proxy. The binding keeps that address, and short text
        // still sends only to the provider's own host.
        let (dir, hosts) = temp_store("proxy");
        let proxied = with_account(
            route("xai", "https://proxy.example/v1", "grok-3"),
            "text-key",
        );
        hosts.bind(&proxied);
        assert!(remember_route(&dir, &|a| hosts.read(a), &proxied).is_err());
        assert!(!dir.join("route.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn plain_http_custom_is_stored_but_short_text_refuses_it() {
        let (dir, hosts) = temp_store("httpcustom");
        let local = with_account(route("custom", "http://127.0.0.1:9/v1", "m"), "custom-http");
        hosts.bind(&local);
        assert!(remember_route(&dir, &|a| hosts.read(a), &local).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_saved_route_on_disk_keeps_the_key_on_its_host() {
        let (dir, hosts) = temp_store("disk");
        let custom = with_account(route("custom", "https://llm.example/v1", "m"), "custom-1");
        let other = with_account(xai(), "other-key");
        let text = with_account(route("xai", "https://API.X.AI./v1", "grok-3"), "text-key");
        let text_saved = with_account(xai(), "text-key");
        hosts.bind(&custom);
        hosts.bind(&other);
        hosts.bind(&text_saved);
        assert!(hosts.read("custom-1").unwrap().is_some());
        assert!(hosts.read("other-key").unwrap().is_some());
        remember_route(&dir, &|a| hosts.read(a), &text).unwrap();
        let raw = fs::read_to_string(dir.join("route.json")).unwrap();
        assert!(raw.contains("https://api.x.ai/v1"), "{raw}");
        assert!(!raw.contains("API"), "{raw}");
        assert!(!raw.contains("x.ai."), "{raw}");
        assert_eq!(
            completions_for(&dir, &hosts, &text_saved).as_deref(),
            Some("https://api.x.ai/v1/chat/completions")
        );
        let mut shifted = text_saved.clone();
        shifted.base_url = "https://api.x.ai:8443/v1".into();
        assert!(completions_for(&dir, &hosts, &shifted).is_none());
        assert!(completions_for(&dir, &hosts, &other).is_none());

        remember_route(&dir, &|a| hosts.read(a), &custom).unwrap();
        assert_eq!(
            completions_for(&dir, &hosts, &custom).as_deref(),
            Some("https://llm.example/v1/chat/completions")
        );
        let mut custom_port = custom.clone();
        custom_port.base_url = "https://llm.example:8443/v1".into();
        assert!(completions_for(&dir, &hosts, &custom_port).is_none());
        let mut custom_path = custom.clone();
        custom_path.base_url = "https://llm.example/v1/extra".into();
        assert!(completions_for(&dir, &hosts, &custom_path).is_none());
        assert!(completions_for(&dir, &hosts, &other).is_none());

        let before = fs::read_to_string(dir.join("route.json")).unwrap();
        assert!(remember_route(
            &dir,
            &|a| hosts.read(a),
            &with_account(
                route("xai", "https://api.x.ai@evil.example/v1", "grok-3"),
                "text-key"
            )
        )
        .is_err());
        assert!(remember_route(
            &dir,
            &|a| hosts.read(a),
            &with_account(route("xai", "http://127.0.0.1:9/v1", "grok-3"), "text-key")
        )
        .is_err());
        assert_eq!(fs::read_to_string(dir.join("route.json")).unwrap(), before);

        *hosts.items.borrow_mut() = vec![("custom-1".to_string(), "{".to_string())];
        assert!(
            completions_for(&dir, &hosts, &custom).is_none(),
            "corrupt json is missing"
        );
        fs::write(dir.join("route.json"), "{").unwrap();
        assert!(completions_for(&dir, &hosts, &text_saved).is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
