//! Grok transcripts.
//!
//! Translated from backpass (MIT) `src/discovery/adapters/grok.js`.
//! Copyright (c) 2026 Kun Chen. The licence text is beside the TypeScript port.
//! Rewrite reason: the adapter is JavaScript; Hivra's readers are Rust.

use std::fs;
use std::path::Path;

use serde_json::Value;

use super::events::{
    attach_tool_results, content_to_events, parse_maybe_json, text_of, LearnEvent,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrokDescriptor {
    pub id: String,
    pub cwd: String,
    pub model: Option<String>,
    pub remotes: Vec<String>,
}

pub fn classify_dir(dir: &Path) -> Option<GrokDescriptor> {
    let summary = fs::read_to_string(dir.join("summary.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let cwd = summary
        .as_ref()
        .and_then(|value| value.get("info"))
        .and_then(|info| info.get("cwd"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            dir.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| name.to_str())
                .and_then(|encoded| percent_decode(encoded).ok())
        })?;
    if cwd.is_empty() {
        return None;
    }
    let id = summary
        .as_ref()
        .and_then(|value| value.get("info"))
        .and_then(|info| info.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| {
            dir.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })?;
    let model = summary
        .as_ref()
        .and_then(|value| value.get("current_model_id"))
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let remotes = summary
        .as_ref()
        .and_then(|value| value.get("git_remotes"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(GrokDescriptor {
        id,
        cwd,
        model,
        remotes,
    })
}

pub fn read_text(text: &str) -> (Vec<LearnEvent>, Option<String>) {
    let mut events = Vec::new();
    let mut model = None;
    for line in text.split('\n') {
        let Some(entry) = line_value(line) else {
            continue;
        };
        match entry.get("type").and_then(Value::as_str).unwrap_or("") {
            "user" => {
                if let Some(content) = entry.get("content") {
                    content_to_events("user", content, &mut events);
                }
            }
            "assistant" => {
                if model.is_none() {
                    model = entry
                        .get("model_id")
                        .and_then(Value::as_str)
                        .filter(|model| !model.is_empty())
                        .map(str::to_string);
                }
                if let Some(content) = entry.get("content") {
                    content_to_events("assistant", content, &mut events);
                }
                if let Some(calls) = entry.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        let name = call
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let input = call
                            .get("arguments")
                            .or_else(|| call.get("input"))
                            .map(parse_maybe_json);
                        let pending = call.get("id").and_then(Value::as_str).map(str::to_string);
                        events.push(LearnEvent::tool(name, input, pending));
                    }
                }
            }
            "tool_result" => {
                let pending = entry
                    .get("tool_call_id")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let result = match entry.get("content") {
                    Some(Value::String(text)) => text.clone(),
                    Some(other) => text_of(other),
                    None => String::new(),
                };
                events.push(LearnEvent {
                    kind: "tool-result".into(),
                    role: None,
                    text: None,
                    name: None,
                    input: None,
                    result: Some(result),
                    status: None,
                    pending_id: pending,
                });
            }
            _ => {}
        }
    }
    (attach_tool_results(events), model)
}

fn line_value(line: &str) -> Option<Value> {
    let line = line.trim_end_matches('\r').trim();
    if line.is_empty() {
        return None;
    }
    serde_json::from_str(line).ok()
}

fn percent_decode(input: &str) -> Result<String, ()> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(|_| ())?;
            let value = u8::from_str_radix(hex, 16).map_err(|_| ())?;
            out.push(value);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).map_err(|_| ())
}
