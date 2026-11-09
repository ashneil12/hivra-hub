//! WP-103: the cheap memory tier. One bounded completion for the memory curator with a model the person added under
//! Other models, and its key from the same Keychain item every other model call uses (`monocode-hub:model-key`).
//!
//! The key goes in and never comes back to the webview. The call has a whole-request deadline and a hard cap on the
//! reply, and any failure is a "try again later" for the caller, never a crash and never a key in a log.

use std::time::Duration;

use serde_json::json;

use crate::history_import::{classify, completions_url, AskOutcome, PostResult};
use crate::model_router::{
    may_route, read_key_in, session_token, CustomRoute, KeyTestResult, KEY_SERVICE,
};

/// The curator's prompt is one turn plus the facts; anything longer is not this turn.
pub const PROMPT_LIMIT: usize = 20_000;
/// The reply is one JSON object. A provider that ignores max_tokens is cut here, and the caller drops it as unreadable.
pub const REPLY_LIMIT: usize = 4_000;
pub const MAX_TOKENS: u32 = 400;
pub const DEADLINE: Duration = Duration::from_secs(20);

fn refused(reason: &str) -> AskOutcome {
    AskOutcome {
        ok: false,
        text: String::new(),
        kind: "refused".into(),
        reason: reason.into(),
    }
}

fn unfinished(kind: &str, reason: &str) -> AskOutcome {
    AskOutcome {
        ok: false,
        text: String::new(),
        kind: kind.into(),
        reason: reason.into(),
    }
}

pub fn cheap_body(model_id: &str, prompt: &str) -> String {
    json!({
        "model": model_id.trim(),
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
        "stream": false,
    })
    .to_string()
}

pub fn cap_reply(text: &str) -> String {
    if text.chars().count() <= REPLY_LIMIT {
        return text.to_string();
    }
    text.chars().take(REPLY_LIMIT).collect()
}

/// The answer to keep, when it can be read at all: a body with no choices is a shape the caller can't use.
fn assistant_text(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    match value.pointer("/choices/0/message/content")? {
        serde_json::Value::String(text) if !text.trim().is_empty() => Some(cap_reply(text)),
        _ => None,
    }
}

pub fn post_chat(url: &str, token: &str, body: &str, deadline: Duration) -> PostResult {
    let agent = ureq::AgentBuilder::new().timeout(deadline).build();
    match agent
        .post(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(body)
    {
        Ok(response) => match assistant_text(&response.into_string().unwrap_or_default()) {
            Some(text) => PostResult::Answer(text),
            None => PostResult::Status(200),
        },
        Err(ureq::Error::Status(code, _)) => PostResult::Status(code),
        Err(ureq::Error::Transport(_)) => PostResult::Unreachable,
    }
}

/// What the cheap tier asks, and what comes back. A secret never leaves, a long turn is never sent, and only the
/// routers' own models are ever called.
pub fn cheap_complete(
    route: &CustomRoute,
    prompt: &str,
    key: Option<&str>,
    post: impl FnOnce(&str, &str, &str) -> PostResult,
) -> AskOutcome {
    if crate::portable::scrubber().has_secret(prompt) {
        return refused("That chat contained a secret, so it was not sent.");
    }
    if prompt.chars().count() > PROMPT_LIMIT {
        return refused("That chat is too long to send.");
    }
    if !may_route(route) {
        return refused("That model can't be used for this.");
    }
    let token = match session_token(&route.provider, key) {
        Ok(token) => token,
        Err(reason) => return refused(&reason),
    };
    let url = completions_url(&route.provider, &route.base_url);
    let body = cheap_body(&route.model_id, prompt);
    match post(&url, &token, &body) {
        PostResult::Answer(text) => AskOutcome {
            ok: true,
            text: cap_reply(&text),
            kind: "ok".into(),
            reason: String::new(),
        },
        PostResult::Status(200) => unfinished(
            "unreachable",
            "The model answered in a shape that couldn't be read.",
        ),
        PostResult::Status(code) => {
            let kind = classify(code);
            if kind == "retryable" {
                unfinished(
                    "retryable",
                    "The model didn't answer this time. It can be tried again.",
                )
            } else {
                refused("That model turned this down.")
            }
        }
        PostResult::Unreachable => unfinished(
            "timeout",
            "The model didn't answer this time. It can be tried again.",
        ),
    }
}

fn key_for(route: &CustomRoute) -> Result<Option<String>, String> {
    if route.provider == "ollama" {
        return Ok(None);
    }
    read_key_in(KEY_SERVICE, &route.custom_model_id)
}

#[tauri::command]
pub async fn memory_cheap_ask(route: CustomRoute, prompt: String) -> Result<AskOutcome, String> {
    if !may_route(&route) {
        return Ok(refused("That model can't be used for this."));
    }
    let key = match key_for(&route) {
        Ok(key) => key,
        Err(_) => return Ok(refused("Couldn't reach the Keychain.")),
    };
    if key.is_none() && route.provider != "ollama" {
        return Ok(refused(
            "No key is saved for that model. Add it under Other models first.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        cheap_complete(&route, &prompt, key.as_deref(), |url, token, body| {
            post_chat(url, token, body, DEADLINE)
        })
    })
    .await
    .map_err(|_| "The model call didn't finish.".to_string())
}

/// "Test this model" on the Memory screen: the saved key, one tiny request, and the same plain words Other models
/// shows for a key test.
#[tauri::command]
pub async fn memory_cheap_test(route: CustomRoute) -> Result<KeyTestResult, String> {
    let key = match key_for(&route) {
        Ok(key) => key,
        Err(_) => {
            return Ok(KeyTestResult {
                ok: false,
                message: "Couldn't reach the Keychain.".into(),
            })
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::model_router::test_key(
            &route.provider,
            &route.base_url,
            &route.model_id,
            key.as_deref().unwrap_or(""),
        )
    })
    .await
    .map_err(|_| "The check didn't finish.".to_string())
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
    fn the_request_is_small_and_asks_for_one_short_answer() {
        let body: serde_json::Value =
            serde_json::from_str(&cheap_body(" grok-fast ", "a prompt")).unwrap();
        assert_eq!(body["model"], "grok-fast");
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][0]["content"], "a prompt");
    }

    #[test]
    fn a_long_reply_is_cut_and_a_short_one_is_kept() {
        assert_eq!(cap_reply("short"), "short");
        let long = "é".repeat(REPLY_LIMIT + 10);
        assert_eq!(cap_reply(&long).chars().count(), REPLY_LIMIT);
    }

    #[test]
    fn a_claude_model_a_plain_http_address_and_a_secret_are_all_refused() {
        let ok = route("xai", "https://api.x.ai/v1", "grok-fast");
        let claude = route("xai", "https://api.x.ai/v1", "claude-sonnet-5");
        let plain = route("custom", "http://example.com/v1", "grok-fast");
        let secret = format!("my key is {}", "sk-ant-api03-abcdefghijklmnopqrst");
        for outcome in [
            cheap_complete(&claude, "p", Some("k"), |_, _, _| PostResult::Unreachable),
            cheap_complete(&plain, "p", Some("k"), |_, _, _| PostResult::Unreachable),
            cheap_complete(&ok, &secret, Some("k"), |_, _, _| PostResult::Unreachable),
            cheap_complete(&ok, &"x".repeat(PROMPT_LIMIT + 1), Some("k"), |_, _, _| {
                PostResult::Unreachable
            }),
            cheap_complete(&ok, "p", None, |_, _, _| PostResult::Unreachable),
            cheap_complete(&ok, "p", Some("sk-ant-oat01-x"), |_, _, _| {
                PostResult::Unreachable
            }),
        ] {
            assert!(!outcome.ok, "{outcome:?}");
            assert_eq!(outcome.kind, "refused", "{outcome:?}");
            assert!(!outcome.reason.contains("sk-ant"), "{outcome:?}");
        }
    }

    #[test]
    fn a_rate_limit_unreachable_and_a_bad_shape_are_not_final_failures() {
        let ok = route("xai", "https://api.x.ai/v1", "grok-fast");
        let limited = cheap_complete(&ok, "p", Some("k"), |_, _, _| PostResult::Status(429));
        assert_eq!((limited.ok, limited.kind.as_str()), (false, "retryable"));
        let down = cheap_complete(&ok, "p", Some("k"), |_, _, _| PostResult::Unreachable);
        assert_eq!((down.ok, down.kind.as_str()), (false, "timeout"));
        let shape = cheap_complete(&ok, "p", Some("k"), |_, _, _| PostResult::Status(200));
        assert_eq!((shape.ok, shape.kind.as_str()), (false, "unreachable"));
        let refused = cheap_complete(&ok, "p", Some("k"), |_, _, _| PostResult::Status(401));
        assert_eq!((refused.ok, refused.kind.as_str()), (false, "refused"));
    }

    #[test]
    fn a_reply_is_capped_and_the_body_goes_to_its_own_door() {
        let ok = route("xai", "https://api.x.ai/v1", "grok-fast");
        let long = format!(
            r#"{{"choices":[{{"message":{{"content":"{}"}}}}]}}"#,
            "y".repeat(REPLY_LIMIT + 50)
        );
        let answer = cheap_complete(&ok, "p", Some("k"), |url, token, body| {
            assert_eq!(url, "https://api.x.ai/v1/chat/completions");
            assert_eq!(token, "k");
            assert!(body.contains("\"model\":\"grok-fast\""));
            PostResult::Answer(long.clone())
        });
        assert!(answer.ok);
        assert_eq!(answer.text.chars().count(), REPLY_LIMIT);
    }

    #[test]
    fn a_real_call_gives_up_at_the_deadline() {
        use std::io::Write;
        use std::net::TcpListener;
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = upstream.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = upstream.accept().unwrap();
            let mut buf = [0u8; 1024];
            use std::io::Read;
            let _ = s.read(&mut buf);
            std::thread::sleep(Duration::from_secs(3));
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
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
}
