//! Shared event folding from backpass src/discovery/adapters/shared.js.
//! Thinking and reasoning are dropped. A tool result folds onto its call.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct LearnEvent {
    pub kind: String,
    pub role: Option<String>,
    pub text: Option<String>,
    pub name: Option<String>,
    pub input: Option<Value>,
    pub result: Option<String>,
    pub status: Option<String>,
    pub pending_id: Option<String>,
}

impl LearnEvent {
    pub fn message(role: &str, text: String) -> Self {
        Self {
            kind: "message".into(),
            role: Some(role.into()),
            text: Some(text),
            name: None,
            input: None,
            result: None,
            status: None,
            pending_id: None,
        }
    }

    pub fn tool(name: String, input: Option<Value>, pending_id: Option<String>) -> Self {
        Self {
            kind: "tool".into(),
            role: None,
            text: None,
            name: Some(name),
            input,
            result: None,
            status: None,
            pending_id,
        }
    }
}

pub fn content_to_events(role: &str, content: &Value, events: &mut Vec<LearnEvent>) {
    if content.is_null() {
        return;
    }
    if let Some(text) = content.as_str() {
        if !text.trim().is_empty() {
            events.push(LearnEvent::message(role, text.to_string()));
        }
        return;
    }
    let Some(blocks) = content.as_array() else {
        if let Some(text) = content.get("text").and_then(Value::as_str) {
            events.push(LearnEvent::message(role, text.to_string()));
        }
        return;
    };
    let mut texts = Vec::new();
    for block in blocks {
        let Some(block) = block.as_object() else {
            if let Some(text) = block.as_str() {
                texts.push(text.to_string());
            }
            continue;
        };
        match block.get("type").and_then(Value::as_str) {
            Some("text" | "input_text" | "output_text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        texts.push(text.to_string());
                    }
                }
            }
            Some("tool_use" | "toolCall") => {
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let input = block
                    .get("input")
                    .cloned()
                    .or_else(|| block.get("arguments").cloned());
                let pending = block
                    .get("id")
                    .or_else(|| block.get("call_id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                events.push(LearnEvent::tool(name, input, pending));
            }
            Some("tool_result" | "toolResult") => {
                let id = block
                    .get("tool_use_id")
                    .or_else(|| block.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                events.push(LearnEvent {
                    kind: "tool-result".into(),
                    role: None,
                    text: None,
                    name: None,
                    input: None,
                    result: Some(value_text(
                        block
                            .get("content")
                            .or_else(|| block.get("output"))
                            .or_else(|| block.get("text")),
                    )),
                    status: Some(
                        if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                            "error".into()
                        } else {
                            "completed".into()
                        },
                    ),
                    pending_id: id,
                });
            }
            Some("thinking" | "reasoning") => {}
            _ => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    texts.push(text.to_string());
                }
            }
        }
    }
    let joined = texts.join("\n");
    let joined = joined.trim();
    if !joined.is_empty() {
        events.push(LearnEvent::message(role, joined.to_string()));
    }
}

fn value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .map(str::to_string)
                    .or_else(|| part.get("text").and_then(Value::as_str).map(str::to_string))
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

pub fn text_of(content: &Value) -> String {
    value_text(Some(content))
}

/// Fold tool results onto the call with the same id, else the last open call.
pub fn attach_tool_results(events: Vec<LearnEvent>) -> Vec<LearnEvent> {
    let mut out = Vec::new();
    let mut by_id: Vec<(String, usize)> = Vec::new();
    for event in events {
        if event.kind == "tool" {
            if let Some(id) = event.pending_id.clone() {
                by_id.push((id, out.len()));
            }
            out.push(event);
            continue;
        }
        if event.kind == "tool-result" {
            let target = event.pending_id.as_ref().and_then(|id| {
                by_id
                    .iter()
                    .rev()
                    .find(|(key, _)| key == id)
                    .map(|(_, index)| *index)
            });
            if let Some(index) = target {
                out[index].result = event.result;
                out[index].status = event.status;
            } else if let Some(last) = out
                .iter_mut()
                .rev()
                .find(|item| item.kind == "tool" && item.result.is_none())
            {
                last.result = event.result;
                last.status = event.status;
            }
            continue;
        }
        out.push(event);
    }
    for event in &mut out {
        event.pending_id = None;
    }
    out
}

pub fn parse_maybe_json(value: &Value) -> Value {
    let Some(text) = value.as_str() else {
        return value.clone();
    };
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string()))
}
