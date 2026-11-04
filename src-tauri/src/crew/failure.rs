//! Translated from Puppetmaster puppetmaster/failure.py (MIT).
//! Copyright (c) 2026 Cary
//!
//! Python became Rust. Traceback frames are not the failure, a bare "auth" or
//! "login" is not a signed-out CLI, 401 and 429 need a boundary, a worker's own
//! JSON is not a diagnosis, and "blocked by upstream provider" is a server error.
//!
//! The live path uses `failure_kind`. The adapter entry points are the rest of the
//! translation; `crew::tests` calls them, and that module is not part of the lib target.

#![allow(dead_code)]

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

pub const NOT_AUTHENTICATED: &str = "not_authenticated";
pub const MISSING_CLI: &str = "missing_cli";
pub const RATE_LIMIT: &str = "rate_limit";
pub const BILLING_OR_QUOTA: &str = "billing_or_quota";
pub const MODEL_UNAVAILABLE: &str = "model_unavailable";
pub const APPROVAL_DENIED: &str = "approval_denied";
pub const SANDBOX_DENIED: &str = "sandbox_denied";
pub const TIMEOUT: &str = "timeout";
pub const NETWORK_ERROR: &str = "network_error";
pub const SERVER_ERROR: &str = "server_error";
pub const CONTEXT_LENGTH_EXCEEDED: &str = "context_length_exceeded";
pub const PERMISSION_DENIED: &str = "permission_denied";
pub const FORBIDDEN: &str = "forbidden";
pub const OPENAI_SERVER_ERROR: &str = "openai_server_error";
pub const SDK_NOT_INSTALLED: &str = "sdk_not_installed";
pub const RUN_STATUS_ERROR: &str = "run_status_error";
pub const UNKNOWN: &str = "unknown";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Account,
    Usage,
    Again,
    Task,
}

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("static regex")
}

fn auth_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        pattern(
            r"(?i)\b(?:auth|authentication|authorization|login|log in|sign in|token|api[ _-]key)[ _-]?(?:error|failed|failure|required|expired|revoked|invalid|missing)\b|\b(?:please |re-?)(?:authenticate|log ?in|sign ?in)\b|\b(?:invalid|incorrect|missing|no)[ _-](?:api[ _-]key|token|credentials?)\b|\binvalid authentication\b|\b(?:login|account|provider|credentials?) verification (?:failed|required)\b",
        )
    })
}

fn traceback_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| pattern(r#"^\s*File "[^"\n]*", line \d+(?:, in [^\n]*)?$"#))
}

fn node_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| pattern(r"^\s+at .+:\d+:\d+\)?$"))
}

fn code_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| pattern(r"^[a-z_]+$"))
}

fn session_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| pattern(r"(?m)^session_id: "))
}

fn camel_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| pattern(r"(?P<pre>[a-z0-9])(?P<up>[A-Z])"))
}

fn without_traceback_frames(text: &str) -> String {
    let mut kept = Vec::new();
    let mut in_frame = false;
    for line in text.split('\n') {
        if traceback_re().is_match(line) {
            in_frame = true;
            continue;
        }
        if in_frame && line.starts_with("    ") {
            continue;
        }
        in_frame = false;
        if node_re().is_match(line) {
            continue;
        }
        kept.push(line);
    }
    kept.join("\n")
}

fn bounded(text: &str, needle: &str) -> bool {
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(at) = text[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        let before_ok = start == 0 || !is_wordish(bytes[start - 1]);
        let after_ok = end >= bytes.len() || !is_wordish(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn is_wordish(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.'
}

fn has(text: &str, part: &str) -> bool {
    text.contains(part)
}

fn classify_lowered(lowered: &str, adapter: &str) -> &'static str {
    if adapter == "cursor" {
        if has(lowered, "cannot find package")
            || (has(lowered, "@cursor/sdk") && has(lowered, "not found"))
        {
            return SDK_NOT_INSTALLED;
        }
        if has(lowered, "forbidden-model")
            || (has(lowered, "forbidden") && has(lowered, "model"))
            || (has(lowered, "not permitted") && has(lowered, "model"))
            || (has(lowered, "not allowed") && has(lowered, "model"))
            || (has(lowered, "unavailable") && has(lowered, "model"))
            || (has(lowered, "unknown") && has(lowered, "model"))
        {
            return MODEL_UNAVAILABLE;
        }
        if has(lowered, "status") && has(lowered, "error") {
            return RUN_STATUS_ERROR;
        }
    }
    if adapter == "claude-code" {
        if has(lowered, "not_found_error") || has(lowered, "permission_error") {
            return MODEL_UNAVAILABLE;
        }
        if (has(lowered, "permission") && has(lowered, "model"))
            || (has(lowered, "not allowed") && has(lowered, "model"))
            || (has(lowered, "denied") && has(lowered, "model"))
        {
            return MODEL_UNAVAILABLE;
        }
        if has(lowered, "permission") || has(lowered, "not allowed") || has(lowered, "denied") {
            return PERMISSION_DENIED;
        }
    }
    if adapter == "codex" && has(lowered, "spend cap") {
        return BILLING_OR_QUOTA;
    }
    if adapter == "hermes" {
        if has(lowered, "no such file or directory") && has(lowered, "hermes") {
            return MISSING_CLI;
        }
        if has(lowered, "no provider")
            || has(lowered, "provider credentials")
            || has(lowered, "no inference provider is configured")
            || has(lowered, "no api key found for provider")
            || has(lowered, "provider resolution failed")
        {
            return NOT_AUTHENTICATED;
        }
    }
    if adapter == "antigravity" {
        if has(lowered, "not recognized as a known model")
            || has(lowered, "invalid model selection")
            || has(lowered, "requires --effort")
            || has(lowered, "invalid effort")
        {
            return MODEL_UNAVAILABLE;
        }
        if has(lowered, "not authenticated")
            || has(lowered, "please authenticate")
            || has(lowered, "login to")
            || has(lowered, "oauth")
        {
            return NOT_AUTHENTICATED;
        }
        if has(lowered, "high demand")
            || has(lowered, "error 503")
            || has(lowered, "status: unavailable")
        {
            return RATE_LIMIT;
        }
        if has(lowered, "jetski:")
            || has(lowered, "headless mode cannot prompt")
            || has(lowered, "user denied permission")
        {
            return PERMISSION_DENIED;
        }
    }
    if has(lowered, "command not found") {
        return MISSING_CLI;
    }
    if has(lowered, "not logged in")
        || has(lowered, "codex login")
        || has(lowered, "missing bearer")
        || has(lowered, "unauthorized")
        || bounded(lowered, "401")
    {
        return NOT_AUTHENTICATED;
    }
    if has(lowered, "not authenticated")
        || has(lowered, "please login")
        || has(lowered, "hermes login")
        || has(lowered, "missing credentials")
        || has(lowered, "cursor_api_key")
    {
        return NOT_AUTHENTICATED;
    }
    if auth_re().is_match(lowered) {
        return NOT_AUTHENTICATED;
    }
    if has(lowered, "context length")
        || has(lowered, "maximum context")
        || has(lowered, "context window")
    {
        return CONTEXT_LENGTH_EXCEEDED;
    }
    if has(lowered, "rate limit") || bounded(lowered, "429") {
        return RATE_LIMIT;
    }
    if has(lowered, "billing") || has(lowered, "quota") || has(lowered, "credit") {
        return BILLING_OR_QUOTA;
    }
    if has(lowered, "model_not_found")
        || (has(lowered, "model")
            && (has(lowered, "unavailable")
                || has(lowered, "not found")
                || has(lowered, "invalid")
                || has(lowered, "does not exist")
                || has(lowered, "not supported")
                || has(lowered, "404")))
    {
        return MODEL_UNAVAILABLE;
    }
    if has(lowered, "approval") && (has(lowered, "denied") || has(lowered, "rejected")) {
        return APPROVAL_DENIED;
    }
    if has(lowered, "sandbox") && (has(lowered, "denied") || has(lowered, "blocked")) {
        return SANDBOX_DENIED;
    }
    if has(lowered, "timeout") || has(lowered, "timed out") {
        return TIMEOUT;
    }
    if has(lowered, "network") || has(lowered, "dns") || has(lowered, "connect") {
        return NETWORK_ERROR;
    }
    UNKNOWN
}

pub fn classify_adapter_failure(adapter: &str, output: &str) -> &'static str {
    let cleaned = without_traceback_frames(output);
    classify_lowered(&cleaned.to_lowercase(), adapter)
}

fn error_text(value: &Value) -> String {
    let value = if let Value::Object(object) = value {
        object
            .get("message")
            .or_else(|| object.get("type"))
            .unwrap_or(&Value::Null)
    } else {
        value
    };
    let Some(text) = value.as_str() else {
        return String::new();
    };
    if code_re().is_match(text) {
        text.replace('_', " ")
    } else {
        text.to_string()
    }
}

pub fn json_output_diagnostic(
    stdout: &str,
    diagnosis: impl Fn(&serde_json::Map<String, Value>) -> Vec<String>,
) -> String {
    let mut lines = Vec::new();
    for raw in stdout.split('\n') {
        if !raw.trim_start().starts_with('{') {
            lines.push(raw.to_string());
            continue;
        }
        let Ok(Value::Object(event)) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        for part in diagnosis(&event) {
            if !part.is_empty() {
                lines.push(part);
            }
        }
    }
    lines.join("\n")
}

pub fn claude_code_diagnosis(event: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut parts = vec![event.get("error").map(error_text).unwrap_or_default()];
    if event.get("type").and_then(Value::as_str) == Some("result")
        && event.get("is_error").and_then(Value::as_bool) == Some(true)
    {
        if let Some(subtype) = event.get("subtype").and_then(Value::as_str) {
            parts.push(subtype.to_string());
        }
        if let Some(result) = event.get("result").and_then(Value::as_str) {
            parts.push(result.to_string());
        }
        if let Some(Value::Array(errors)) = event.get("errors") {
            parts.extend(errors.iter().map(error_text));
        }
    }
    parts
}

pub fn classify_fx_failure(stderr: &str, result: Option<&Value>) -> Option<&'static str> {
    let object = result.and_then(Value::as_object);
    let error = object.and_then(|row| row.get("error"));
    if object
        .and_then(|row| row.get("auth_failure"))
        .is_some_and(Value::is_object)
        || error.and_then(Value::as_str) == Some("MissingCredentials")
    {
        return Some(NOT_AUTHENTICATED);
    }
    let code = error
        .and_then(Value::as_str)
        .map(|text| camel_re().replace_all(text, "$pre $up").to_lowercase())
        .unwrap_or_default();
    let joined = [stderr, code.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let failure = classify_adapter_failure("fx", &joined);
    if failure == UNKNOWN {
        None
    } else {
        Some(failure)
    }
}

pub fn hermes_diagnostic(stdout: &str, stderr: &str) -> String {
    if session_re().is_match(stderr) {
        stderr.to_string()
    } else {
        format!("{stderr}\n{stdout}")
    }
}

fn upstream_block(message: &str) -> bool {
    let msg = message.to_lowercase();
    msg.contains("blocked by upstream provider") || msg.contains("request blocked by upstream")
}

pub fn classify_provider_failure(reason: &str, http_status: Option<i64>, body: &str) -> String {
    let mut status = http_status;
    if status.is_none() {
        if let Some(rest) = reason.strip_prefix("http_status:") {
            if let Ok(parsed) = rest.parse::<i64>() {
                status = Some(parsed);
            }
        }
    }
    if upstream_block(body) || upstream_block(reason) {
        return SERVER_ERROR.into();
    }
    match status {
        Some(401) => return NOT_AUTHENTICATED.into(),
        Some(402) => return BILLING_OR_QUOTA.into(),
        Some(403) => return FORBIDDEN.into(),
        Some(404) => return MODEL_UNAVAILABLE.into(),
        Some(429) => return RATE_LIMIT.into(),
        Some(status) if (500..600).contains(&status) => return SERVER_ERROR.into(),
        Some(status) if (400..500).contains(&status) => {
            let failure = classify_adapter_failure("openai", body);
            if failure != UNKNOWN {
                return failure.into();
            }
        }
        _ => {}
    }
    match reason {
        "not_authenticated" => NOT_AUTHENTICATED,
        "timeout" => TIMEOUT,
        "network_error" => NETWORK_ERROR,
        "malformed_response" => "malformed_response",
        "openai_server_error" | "server_error" => SERVER_ERROR,
        "unsupported_model" => MODEL_UNAVAILABLE,
        "" => UNKNOWN,
        other => return other.to_string(),
    }
    .to_string()
}

pub fn classify_openai_failure(body: &str, http_status: Option<i64>) -> String {
    match http_status {
        Some(401) => NOT_AUTHENTICATED.into(),
        Some(403) => FORBIDDEN.into(),
        Some(404) => MODEL_UNAVAILABLE.into(),
        Some(429) => RATE_LIMIT.into(),
        Some(status) if (500..600).contains(&status) => OPENAI_SERVER_ERROR.into(),
        _ => classify_adapter_failure("openai", body).into(),
    }
}

pub fn sanitize_class(value: Option<&str>) -> String {
    value
        .unwrap_or("")
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')
        .take(40)
        .collect()
}

pub(crate) fn is_account_class(value: &str) -> bool {
    let class = sanitize_class(Some(value));
    ACCOUNT.contains(&class.as_str())
}

const ACCOUNT: &[&str] = &[
    "quota",
    "billing",
    BILLING_OR_QUOTA,
    "credit",
    "credits",
    "out_of_credits",
    RATE_LIMIT,
    "ratelimit",
    "rate_limited",
    "auth",
    NOT_AUTHENTICATED,
    "unauthenticated",
    "login",
    "unauthorized",
    MISSING_CLI,
    "cli_missing",
    "command_not_found",
    SDK_NOT_INSTALLED,
];

const AGAIN: &[&str] = &[
    TIMEOUT,
    "timed_out",
    "network",
    NETWORK_ERROR,
    "unreachable",
    "dns",
    "overloaded",
    SERVER_ERROR,
    OPENAI_SERVER_ERROR,
];

pub fn failure_kind(error_class: Option<&str>, text: Option<&str>) -> Kind {
    let class = sanitize_class(error_class);
    if class == "usage_limit" {
        return Kind::Usage;
    }
    if ACCOUNT.contains(&class.as_str()) {
        return Kind::Account;
    }
    if AGAIN.contains(&class.as_str()) {
        return Kind::Again;
    }
    if class.is_empty() || class == "provider_error" || class == "unknown" {
        let Some(text) = text.filter(|text| !text.is_empty()) else {
            return if class == "provider_error" {
                Kind::Again
            } else {
                Kind::Task
            };
        };
        let found = classify_adapter_failure("", text);
        if found == UNKNOWN {
            return if class == "provider_error" {
                Kind::Again
            } else {
                Kind::Task
            };
        }
        return failure_kind(Some(found), None);
    }
    Kind::Task
}
