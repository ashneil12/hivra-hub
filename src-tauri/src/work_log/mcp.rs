//! The `work_log` tool in `monocode mcp`. One app call: add a line, or read a day or a range.
//! Who may call is decided by the app. A worker is refused there, with a plain reason.

use serde_json::{json, Value};

use crate::mcp_server::{arguments, new_request_id, pick, App};

const FIELDS: [&str; 7] = ["op", "kind", "line", "day", "from", "to", "project"];

pub fn tools() -> Vec<Value> {
    vec![json!({
        "name": "work_log",
        "title": "Work log",
        "description": "Add one line that would still matter in a retro a month from now: outcomes and decisions, not progress chatter. One line each. Feedback is a correction and context is one fact that would matter later. Read one day, or from and to, and leave project out to read every project. A worker reports to its first mate and cannot use this.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "op": { "type": "string", "enum": ["add", "read"] },
                "kind": {
                    "type": "string",
                    "enum": ["outcome", "decision", "feedback", "context"],
                    "description": "For add. outcome, decision, feedback (a correction), or context."
                },
                "line": {
                    "type": "string",
                    "maxLength": 8000,
                    "description": "For add. One plain line."
                },
                "day": {
                    "type": "string",
                    "description": "For read. One local day, like 2026-11-10. Not together with from and to."
                },
                "from": { "type": "string", "description": "For read. The first day of a range, with to." },
                "to": { "type": "string", "description": "For read. The last day of a range, with from." },
                "project": {
                    "type": "string",
                    "maxLength": 500,
                    "description": "For read. Leave it out to read every project."
                }
            },
            "required": ["op"],
            "additionalProperties": false
        },
        "annotations": { "title": "Work log", "destructiveHint": false, "openWorldHint": false }
    })]
}

pub fn call(app: &dyn App, args: &Value) -> Result<Value, String> {
    let object = arguments(args, &FIELDS)?;
    match object.get("op").and_then(Value::as_str) {
        Some("add") => app.call(
            "work_log.add",
            &pick(object, &["kind", "line"]),
            &new_request_id(),
        ),
        Some("read") => app.call(
            "work_log.read",
            &pick(object, &["day", "from", "to", "project"]),
            &new_request_id(),
        ),
        _ => Err("op must be add or read.".into()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Rec(Mutex<Vec<(String, Value)>>);

    impl App for Rec {
        fn call(&self, action: &str, input: &Value, _request_id: &str) -> Result<Value, String> {
            self.0
                .lock()
                .unwrap()
                .push((action.to_string(), input.clone()));
            Ok(json!({ "ok": true }))
        }
    }

    #[test]
    fn the_tool_text_asks_for_a_line_that_would_matter_later() {
        let tool = &tools()[0];
        let description = tool["description"].as_str().unwrap();
        assert!(
            description.contains("retro a month from now"),
            "{description}"
        );
        assert!(
            description.contains("not progress chatter"),
            "{description}"
        );
        assert!(description.contains("One line each"), "{description}");
        assert!(description.contains("cannot use this"), "{description}");
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        assert_eq!(tool["inputSchema"]["required"], json!(["op"]));
    }

    #[test]
    fn add_and_read_are_one_app_call_each_and_a_typo_calls_nothing() {
        let app = Rec(Mutex::new(Vec::new()));
        let added = call(
            &app,
            &json!({ "op": "add", "kind": "feedback", "line": "Ash said keep the CSV." }),
        )
        .unwrap();
        assert_eq!(added["ok"], true);
        let read = call(
            &app,
            &json!({ "op": "read", "from": "2026-11-01", "to": "2026-11-10", "project": "tally" }),
        )
        .unwrap();
        assert_eq!(read["ok"], true);
        assert_eq!(
            app.0.lock().unwrap().as_slice(),
            [
                (
                    "work_log.add".to_string(),
                    json!({ "kind": "feedback", "line": "Ash said keep the CSV." })
                ),
                (
                    "work_log.read".to_string(),
                    json!({ "from": "2026-11-01", "to": "2026-11-10", "project": "tally" })
                ),
            ]
        );
        let before = app.0.lock().unwrap().len();
        assert!(call(
            &app,
            &json!({ "op": "add", "kind": "feedback", "note": "nope" })
        )
        .is_err());
        assert!(call(&app, &json!({ "op": "drop", "line": "nope" })).is_err());
        assert!(call(&app, &json!({})).is_err());
        assert_eq!(app.0.lock().unwrap().len(), before);
    }
}
