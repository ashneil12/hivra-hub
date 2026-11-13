//! PT-6: `spec_start` in `monocode mcp` (mcp_server.rs): "Write this project's spec of record from what it already has: its
//! README, docs and the briefs of landed tasks. Only when the person asks."
//!
//! One app call, `tasks.specStart`, answered by src/features/agent-app/model/agentAppTasks.ts: it reads the landed briefs of the
//! project from the delegation rows (`spec_record::landed_briefs`), builds ONE worker brief and delegates it like any task, so it
//! lands the way any task does (gates, checks, the first mate's acceptance). Nothing here runs on its own: the tool is the only
//! way in, and a project's spec is written only when its first mate calls it because the person asked.

use serde_json::{json, Value};

use crate::mcp_server::{arguments, new_request_id, pick, valid_request_id, App};

pub const NAMES: [&str; 1] = ["spec_start"];

/// What the app action takes. `clientRequestId` only names the call, so a retry never starts a second worker.
const FIELDS: [&str; 1] = ["project"];

/// The tool, as `tools/list` describes it.
pub fn tools() -> Vec<Value> {
    vec![json!({
        "name": "spec_start",
        "title": "Write the project's spec of record",
        "description": "Write this project's spec of record from what it already has: its README, docs and the briefs of landed tasks. Only when the person asks; never on your own, and never for a project that has one. It hands ONE worker the job of drafting the spec (an index and one file per area under docs/spec/, each section the person's intent, the laws and the acceptance checks in plain words, taken from what the project already says and never invented), and that worker lands like any task: you read its report and accept it as you would any. Once a project has a spec, every delegate_task that changes behaviour carries the section it changes in spec. Keep the same clientRequestId when retrying so no second worker starts.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": { "type": "string", "description": "The hub project id, folder path or name. Omit when you have one project." },
                "clientRequestId": { "type": "string", "description": "Letters, digits, - and _. The same id on a retry never starts a second worker." }
            },
            "additionalProperties": false
        },
        "annotations": { "title": "Write the project's spec of record", "destructiveHint": false, "openWorldHint": false }
    })]
}

/// Run the tool.
pub fn call(app: &dyn App, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "spec_start" => {
            let mut allowed = FIELDS.to_vec();
            allowed.push("clientRequestId");
            let object = arguments(args, &allowed)?;
            let request_id =
                match object.get("clientRequestId") {
                    None => new_request_id(),
                    Some(Value::String(id)) if valid_request_id(id) => id.clone(),
                    _ => return Err(
                        "clientRequestId must be letters, digits, - and _ (up to 100 characters)"
                            .into(),
                    ),
                };
            app.call("tasks.specStart", &pick(object, &FIELDS), &request_id)
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Recorder(Mutex<Vec<(String, Value, String)>>);

    impl App for Recorder {
        fn call(&self, action: &str, input: &Value, request_id: &str) -> Result<Value, String> {
            self.0
                .lock()
                .unwrap()
                .push((action.into(), input.clone(), request_id.into()));
            Ok(json!({ "taskId": "t-1" }))
        }
    }

    #[test]
    fn nothing_reaches_the_app_until_the_tool_is_called_and_then_it_is_one_call() {
        let app = Recorder(Mutex::new(Vec::new()));
        // Listing the tool, reading its schema and an unknown name call nothing.
        assert_eq!(tools().len(), 1);
        assert!(call(&app, "spec_stop", &json!({})).is_err());
        assert!(app.0.lock().unwrap().is_empty());
        // One call, one app call, under the caller's request id, naming only its own field.
        call(
            &app,
            "spec_start",
            &json!({ "project": "vg-game", "clientRequestId": "spec-1" }),
        )
        .unwrap();
        let calls = app.0.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "tasks.specStart");
        assert_eq!(calls[0].1, json!({ "project": "vg-game" }));
        assert_eq!(calls[0].2, "spec-1");
    }

    #[test]
    fn a_call_with_no_request_id_gets_a_fresh_one_and_a_bad_call_is_refused_before_the_app() {
        let app = Recorder(Mutex::new(Vec::new()));
        call(&app, "spec_start", &json!({})).unwrap();
        call(&app, "spec_start", &json!({})).unwrap();
        {
            let calls = app.0.lock().unwrap();
            assert!(valid_request_id(&calls[0].2));
            assert_ne!(calls[0].2, calls[1].2);
            assert_eq!(calls[0].1, json!({}));
        }
        app.0.lock().unwrap().clear();
        let typo = call(&app, "spec_start", &json!({ "folder": "/x" })).unwrap_err();
        assert!(typo.starts_with("Unknown fields: folder"), "{typo}");
        assert!(call(
            &app,
            "spec_start",
            &json!({ "clientRequestId": "has spaces" })
        )
        .unwrap_err()
        .contains("clientRequestId must be letters"));
        assert!(call(&app, "spec_start", &json!({ "clientRequestId": 7 })).is_err());
        assert!(call(&app, "spec_start", &json!(["x"])).is_err());
        // A review's request id belongs to the app's review launcher, as for every delegating tool.
        let review = format!("{}6162", crate::delivery::review::REQUEST_PREFIX);
        assert!(call(&app, "spec_start", &json!({ "clientRequestId": review })).is_err());
        assert!(
            app.0.lock().unwrap().is_empty(),
            "none of them reached the app"
        );
    }

    #[test]
    fn the_app_action_is_one_an_agents_token_may_name() {
        // The control server refuses any action an agent's token doesn't list, so the tool would never reach the app without it.
        assert!(crate::control::app_action_allowed("tasks.specStart"));
        assert!(crate::mcp_server::MCP_APP_ACTIONS.contains(&"tasks.specStart"));
    }

    #[test]
    fn the_tool_is_closed_and_says_when_it_may_be_used() {
        let listed = tools();
        assert!(NAMES.contains(&listed[0]["name"].as_str().unwrap()));
        let schema = &listed[0]["inputSchema"];
        assert_eq!(schema["additionalProperties"], false);
        let mut keys: Vec<&String> = schema["properties"].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["clientRequestId", "project"]);
        let text = listed[0]["description"].as_str().unwrap();
        assert!(text.starts_with("Write this project's spec of record from what it already has: its README, docs and the briefs of landed tasks. Only when the person asks"));
        assert!(text.contains("ONE worker"), "{text}");
        // Plain words: no dash a person might see.
        assert!(
            !listed[0].to_string().contains('\u{2014}')
                && !listed[0].to_string().contains('\u{2013}')
        );
    }
}
