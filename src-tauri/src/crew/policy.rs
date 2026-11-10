//! WP-141: the person's lock, never-use list and fallback order.
//! A value from disk is untrusted. A broken field is dropped, and a newline is not joined into another id.

use serde_json::{json, Value};

use crate::plugins::hivra::CREW_CLIS;

const MAX_IDS: usize = 32;
const MAX_ID: usize = 64;

fn is_cli(value: &str) -> bool {
    CREW_CLIS.contains(&value)
}

/// The CLI id a typed name stands for: its id or its label, in any letter case ("Codex", "Claude Code").
/// None when it names no CLI. A typed name that is not mapped would be stored and never match a route.
pub(crate) fn cli_id_of(text: &str) -> Option<&'static str> {
    let key = text.trim().to_ascii_lowercase();
    CREW_CLIS
        .iter()
        .copied()
        .find(|cli| key == *cli || key == crate::crew::resolve::cli_label(cli).to_ascii_lowercase())
}

fn clean_id(value: &str, cli_only: bool) -> Option<String> {
    if value.chars().any(|ch| ch == '\n' || ch == '\r') {
        return None;
    }
    let text = value.trim();
    if let Some(cli) = cli_id_of(text) {
        return Some(cli.to_string());
    }
    if text.is_empty()
        || text.chars().count() > MAX_ID
        || text.contains("..")
        || text.contains('/')
        || text.contains('\\')
    {
        return None;
    }
    let cli = is_cli(text);
    if cli_only && !cli {
        return None;
    }
    if !cli
        && !text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Some(text.to_string())
}

fn clean_ids(value: Option<&Value>, cli_only: bool) -> Vec<String> {
    let Some(list) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let cap = if cli_only { CREW_CLIS.len() } else { MAX_IDS };
    let mut out = Vec::new();
    for item in list {
        let Some(text) = item.as_str() else { continue };
        let Some(id) = clean_id(text, cli_only) else {
            continue;
        };
        if out.contains(&id) {
            continue;
        }
        out.push(id);
        if out.len() == cap {
            break;
        }
    }
    out
}

/// Only `true` turns the lock on. Unknown fields are dropped.
pub(crate) fn sanitize_policy(value: &Value) -> Value {
    let obj = value.as_object();
    let lock = obj
        .and_then(|row| row.get("lockDefault"))
        .and_then(Value::as_bool)
        == Some(true);
    json!({
        "lockDefault": lock,
        "neverUse": clean_ids(obj.and_then(|row| row.get("neverUse")), false),
        "fallback": clean_ids(obj.and_then(|row| row.get("fallback")), true),
    })
}
