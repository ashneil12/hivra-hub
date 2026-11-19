//! SC-3b: the `ship_check` tool in `monocode mcp` (mcp_server.rs). One app call, `ship_check.run`, answered by
//! src/features/agent-app/model/agentAppShipCheck.ts: it runs `ship_check::run` for the first mate's project and answers
//! with the outcome and what it tested and did not. Only a first mate's own chat may call it (the app refuses a worker).
//! The run can take many minutes, so its reply waits as long as `finish`'s does (`control_cli::reply_seconds`).

use serde_json::{json, Value};

use crate::mcp_server::{arguments, new_request_id, pick, App};

pub const NAMES: [&str; 1] = ["ship_check"];

const FIELDS: [&str; 1] = ["project"];

/// The tools, as `tools/list` describes them.
pub fn tools() -> Vec<Value> {
    vec![json!({
        "name": "ship_check",
        "title": "Run the ship check",
        "description": "Run the ship check for this project: every check, the real-app check and a review over everything landed since the last passed ship check.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": { "type": "string", "maxLength": 4096, "description": "The project folder or name. Leave it out when you work on one project." }
            },
            "additionalProperties": false
        },
        "annotations": { "title": "Run the ship check", "destructiveHint": false, "openWorldHint": false }
    })]
}

/// Run the tool.
pub fn call(app: &dyn App, args: &Value) -> Result<Value, String> {
    let object = arguments(args, &FIELDS)?;
    app.call("ship_check.run", &pick(object, &FIELDS), &new_request_id())
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
            Ok(json!({ "outcome": "passed" }))
        }
    }

    #[test]
    fn the_tool_says_what_the_ship_check_covers() {
        let listed = tools();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["name"], "ship_check");
        assert_eq!(
            listed[0]["description"],
            "Run the ship check for this project: every check, the real-app check and a review over everything landed since the last passed ship check."
        );
        assert_eq!(listed[0]["inputSchema"]["additionalProperties"], false);
        assert!(NAMES.contains(&"ship_check"));
        let text = listed[0].to_string();
        assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}'));
    }

    #[test]
    fn a_call_is_one_app_call_and_a_typo_calls_nothing() {
        let app = Recorder(Mutex::new(Vec::new()));
        call(&app, &json!({})).unwrap();
        call(&app, &json!({ "project": "tally" })).unwrap();
        assert_eq!(
            app.0.lock().unwrap().as_slice(),
            [
                ("ship_check.run".to_string(), json!({})),
                ("ship_check.run".to_string(), json!({ "project": "tally" })),
            ]
        );
        let error = call(&app, &json!({ "projekt": "tally" })).unwrap_err();
        assert!(error.starts_with("Unknown fields: projekt"), "{error}");
        assert!(call(&app, &json!(["tally"])).is_err());
        assert_eq!(app.0.lock().unwrap().len(), 2);
    }
}
