//! Pi and omp transcripts.
//!
//! Translated from backpass (MIT) `src/discovery/adapters/pi.js`.
//! Copyright (c) 2026 Kun Chen. The licence text is beside the TypeScript port.
//! Rewrite reason: the adapter is JavaScript; Hivra's readers are Rust.

use serde_json::Value;

use super::events::{attach_tool_results, content_to_events, text_of, LearnEvent};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiDescriptor {
    pub id: String,
    pub cwd: String,
}

fn line_value(line: &str) -> Option<Value> {
    let line = line.trim_end_matches('\r').trim();
    if line.is_empty() {
        return None;
    }
    serde_json::from_str(line).ok()
}

/// Header is line 1, or line 2 only when this is an omp file and line 1 is a title.
/// A session on line 3 is not a header. A title-led file read as plain Pi is nothing.
pub fn classify_text(text: &str, omp: bool, fallback_id: &str) -> Option<PiDescriptor> {
    let lines: Vec<&str> = text.split('\n').collect();
    let first = lines.first().and_then(|line| line_value(line));
    let entry = match first
        .as_ref()
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
    {
        Some("session") => first,
        Some("title") if omp => lines.get(1).and_then(|line| line_value(line)),
        _ => None,
    }?;
    if entry.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let cwd = entry
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty())?;
    let id = entry
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .unwrap_or(fallback_id);
    Some(PiDescriptor {
        id: id.to_string(),
        cwd: cwd.to_string(),
    })
}

/// Thinking is dropped. An omp `model` field counts only when the file starts with a title.
pub fn read_text(text: &str) -> (Vec<LearnEvent>, Option<String>) {
    let entries: Vec<Value> = text.split('\n').filter_map(line_value).collect();
    let omp = entries
        .first()
        .and_then(|entry| entry.get("type"))
        .and_then(Value::as_str)
        == Some("title");
    let mut events = Vec::new();
    let mut model: Option<String> = None;

    for entry in &entries {
        let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "model_change" {
            let model_id = non_empty(entry.get("modelId"));
            let omp_model = if omp {
                non_empty(entry.get("model"))
            } else {
                None
            };
            if let Some(next) = model_id.or(omp_model) {
                model = Some(next.to_string());
            }
            continue;
        }
        if kind != "message" {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "toolResult" {
            let pending = message
                .get("toolCallId")
                .or_else(|| message.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            events.push(LearnEvent {
                kind: "tool-result".into(),
                role: None,
                text: None,
                name: None,
                input: None,
                result: Some(text_of(message.get("content").unwrap_or(&Value::Null))),
                status: None,
                pending_id: pending,
            });
            continue;
        }
        if role == "user" || role == "assistant" {
            if let Some(content) = message.get("content") {
                content_to_events(role, content, &mut events);
            }
        }
    }

    (attach_tool_results(events), model)
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}
