//! WP-129: one short completion for a title, a commit message, pull request text or a branch name.
//!
//! No tools, no path and no repo writes. The key is read here and never comes back. A timeout or an
//! unreachable provider is a try-again (`kind: "timeout"`), not a crash and not a cleared setting.

use std::time::Duration;

use serde_json::{json, Value};

use crate::history_import::{classify, completions_url, AskOutcome, PostResult};
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

/// Ask, and turn the reply into text or a plain error. `post` is the only way out; it is given a URL,
/// a token and a body, never a path.
pub fn text_complete(
    route: &CustomRoute,
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
    let token = match session_token(&route.provider, key) {
        Ok(token) => token,
        Err(_) => return refused("That model can't be used for this."),
    };
    if holds_token(&token, prompt) {
        return refused("That text contained a secret, so it was not sent.");
    }
    let url = completions_url(&route.provider, &route.base_url);
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
#[tauri::command]
pub async fn text_generation_ask(route: CustomRoute, prompt: String) -> Result<AskOutcome, String> {
    if !may_route(&route) {
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
        text_complete(&route, &prompt, key.as_deref(), |url, token, body| {
            post_chat(url, token, body, DEADLINE)
        })
    })
    .await
    .map_err(|_| "The model call didn't finish.".to_string())
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
        let blank = text_complete(&xai(), "Say hi", Some("k"), |_, _, _| {
            PostResult::Answer("  \n".into())
        });
        assert_eq!(blank.kind, "empty");
        assert!(blank.text.is_empty());
        let shape = text_complete(&xai(), "Say hi", Some("k"), |_, _, _| {
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
            let outcome = text_complete(&xai(), &prompt, Some("k"), |_, _, _| {
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
            let outcome = text_complete(&route, "Say hi", Some("k"), |_, _, _| {
                called = true;
                PostResult::Unreachable
            });
            assert!(!called);
            assert_eq!(outcome.kind, "refused");
        }
        let mut called = false;
        let missing = text_complete(&xai(), "Say hi", None, |_, _, _| {
            called = true;
            PostResult::Unreachable
        });
        assert!(!called);
        assert_eq!(missing.kind, "refused");
        let mut called = false;
        let claude = text_complete(&xai(), "Say hi", Some(claude_key), |_, _, _| {
            called = true;
            PostResult::Unreachable
        });
        assert!(!called);
        assert_eq!(claude.kind, "refused");
        assert!(!claude.reason.contains("sk-ant"));
        assert!(!claude.text.contains("sk-ant"));

        let mut called = false;
        let edge = text_complete(&xai(), &"é".repeat(PROMPT_LIMIT), Some("k"), |_, _, _| {
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
            let outcome = text_complete(&xai(), "Say hi", Some("k"), |_, _, _| {
                PostResult::Status(code)
            });
            assert!(!outcome.ok);
            assert_eq!(outcome.kind, "timeout", "{code}");
            assert!(outcome.reason.contains("tried again"), "{code}");
            assert!(outcome.text.is_empty());
        }
        let down = text_complete(&xai(), "Say hi", Some("k"), |_, _, _| {
            PostResult::Unreachable
        });
        assert_eq!(down.kind, "timeout");
        assert!(down.reason.contains("tried again"));
        for code in [400_u16, 401, 403, 404] {
            let outcome = text_complete(&xai(), "Say hi", Some("k"), |_, _, _| {
                PostResult::Status(code)
            });
            assert_eq!(outcome.kind, "refused", "{code}");
        }
    }

    #[test]
    fn the_token_is_not_in_the_body_or_the_outcome() {
        let key = "provider-key-12345678";
        let mut called = false;
        let leaked_prompt = text_complete(&xai(), key, Some(key), |_, _, _| {
            called = true;
            PostResult::Answer("no".into())
        });
        assert!(!called);
        assert_eq!(leaked_prompt.kind, "refused");
        assert!(!leaked_prompt.reason.contains(key));
        assert!(!leaked_prompt.text.contains(key));

        let echoed = text_complete(&xai(), "Say hi", Some(key), |url, token, body| {
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

        let answer = text_complete(&xai(), "Say hi", Some(key), |_, token, body| {
            assert_eq!(token, key);
            assert!(!body.contains(key));
            PostResult::Answer("A title".into())
        });
        assert!(answer.ok);
        assert_eq!(answer.text, "A title");
        assert!(!answer.text.contains(key));
        assert!(!answer.reason.contains(key));

        let secret = "sk-ant-api03-abcdefghijklmnopqrst";
        let hidden = text_complete(&xai(), "Say hi", Some(key), |_, _, _| {
            PostResult::Answer(format!("see {secret}"))
        });
        assert_eq!(hidden.kind, "timeout");
        assert!(!hidden.text.contains("sk-ant"));
        assert!(!hidden.reason.contains("sk-ant"));
    }

    #[test]
    fn ollama_needs_no_key_and_still_gets_no_tools() {
        let local = route("ollama", "http://localhost:11434", "llama3.2");
        let outcome = text_complete(&local, "Say hi", None, |url, token, body| {
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
}
