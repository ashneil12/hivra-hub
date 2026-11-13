//! SC-7: the `run_checks` tool in `monocode mcp` (mcp_server.rs). One app call, `run_checks.run`, answered by
//! src/features/agent-app/model/agentAppRunChecks.ts: it runs the project's tests for what changed in the caller's own
//! checkout (`run_checks::run_with`) and answers with the summary line, the failing tests and the path of the full log.
//! A worker may call it, and so may a first mate. The run can take as long as the project's own check (its reply waits as
//! long as `ship_check`'s: `control_cli::reply_seconds`).

use serde_json::{json, Value};

use crate::mcp_server::{arguments, new_request_id, pick, App};

pub const NAMES: [&str; 1] = ["run_checks"];

const FIELDS: [&str; 3] = ["command", "paths", "project"];

/// The words the tool is described with. A worker reads this one.
pub const DESCRIPTION: &str = "Run this project's tests for what you changed. Returns the summary line, each failing test with its message, and the path of the full log. Use it instead of running the test command yourself.";

/// The tools, as `tools/list` describes them.
pub fn tools() -> Vec<Value> {
    vec![json!({
        "name": "run_checks",
        "title": "Run this project's tests",
        "description": DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": { "type": "string", "maxLength": 400, "description": "One of the project's declared check ids (or its action ids). Leave it out to run the project's affected tests, or its checks for the folders you changed." },
                "paths": { "type": "array", "items": { "type": "string", "maxLength": 1024 }, "maxItems": 200, "description": "The files you changed, when you want only the checks for their folders. Leave it out and the app reads them from your copy." },
                "project": { "type": "string", "maxLength": 4096, "description": "A first mate only: the project folder or name. Leave it out when you work on one project." }
            },
            "additionalProperties": false
        },
        "annotations": { "title": "Run this project's tests", "destructiveHint": false, "openWorldHint": false }
    })]
}

/// Run the tool.
pub fn call(app: &dyn App, args: &Value) -> Result<Value, String> {
    let object = arguments(args, &FIELDS)?;
    if let Some(command) = object.get("command") {
        if !command.is_string() {
            return Err("command must be one check id".into());
        }
    }
    if let Some(paths) = object.get("paths") {
        let ok = paths
            .as_array()
            .is_some_and(|list| list.iter().all(Value::is_string));
        if !ok {
            return Err("paths must be a list of file paths".into());
        }
    }
    app.call("run_checks.run", &pick(object, &FIELDS), &new_request_id())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Recorder(Mutex<Vec<(String, Value)>>);

    impl App for Recorder {
        fn call(&self, action: &str, input: &Value, _request_id: &str) -> Result<Value, String> {
            self.0
                .lock()
                .unwrap()
                .push((action.to_string(), input.clone()));
            Ok(json!({ "outcome": "green" }))
        }
    }

    #[test]
    fn the_tool_says_what_it_returns_and_asks_the_worker_to_use_it() {
        let listed = tools();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["name"], "run_checks");
        assert_eq!(
            listed[0]["description"],
            "Run this project's tests for what you changed. Returns the summary line, each failing test with its message, and the path of the full log. Use it instead of running the test command yourself."
        );
        assert_eq!(listed[0]["inputSchema"]["additionalProperties"], false);
        let props = listed[0]["inputSchema"]["properties"].as_object().unwrap();
        assert!(props.contains_key("command") && props.contains_key("paths"));
        assert!(NAMES.contains(&"run_checks"));
        let text = listed[0].to_string();
        assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}'));
    }

    #[test]
    fn a_call_is_one_app_call_and_a_typo_or_a_wrong_type_calls_nothing() {
        let app = Recorder(Mutex::new(Vec::new()));
        call(&app, &json!({})).unwrap();
        call(
            &app,
            &json!({ "command": "unit", "paths": ["src/a.ts", "src/é b.ts"] }),
        )
        .unwrap();
        assert_eq!(
            app.0.lock().unwrap().as_slice(),
            [
                ("run_checks.run".to_string(), json!({})),
                (
                    "run_checks.run".to_string(),
                    json!({ "command": "unit", "paths": ["src/a.ts", "src/é b.ts"] })
                ),
            ]
        );
        let error = call(&app, &json!({ "comand": "unit" })).unwrap_err();
        assert!(error.starts_with("Unknown fields: comand"), "{error}");
        assert!(call(&app, &json!({ "command": ["unit"] })).is_err());
        assert!(call(&app, &json!({ "paths": "src/a.ts" })).is_err());
        assert!(call(&app, &json!({ "paths": [1] })).is_err());
        assert!(call(&app, &json!(["unit"])).is_err());
        assert_eq!(app.0.lock().unwrap().len(), 2);
    }
}
