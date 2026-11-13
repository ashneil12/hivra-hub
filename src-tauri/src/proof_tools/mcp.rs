//! PT-1: the `proof_tools` tool in `monocode mcp` (mcp_server.rs). Two app calls, `proof_tools.list` and
//! `proof_tools.propose`, answered by src/features/agent-app/model/agentAppProofTools.ts. `list` says which proof tools fit the
//! first mate's project and which the project already has. `propose` puts ONE of the ones it doesn't have to the person, as a
//! Needs-you decision, at most once per project per tool; the app never installs anything itself. Only a first mate's own chat
//! may call it (the app refuses a worker).

use serde_json::{json, Value};

use crate::mcp_server::{arguments, new_request_id, pick, App};

pub const NAMES: [&str; 1] = ["proof_tools"];

const FIELDS: [&str; 3] = ["action", "toolId", "project"];
const LIST_FIELDS: [&str; 1] = ["project"];
const PROPOSE_FIELDS: [&str; 2] = ["project", "toolId"];

/// The tools, as `tools/list` describes them.
pub fn tools() -> Vec<Value> {
    vec![json!({
        "name": "proof_tools",
        "title": "Proof tools",
        "description": "List the proof tools that fit this project and which it has, or propose adding one to the person.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "propose"], "description": "list shows the tools that fit and which the project already has. propose asks the person once whether to add one it doesn't have." },
                "toolId": { "type": "string", "maxLength": 40, "description": "For propose: the id of a tool that list showed the project doesn't have." },
                "project": { "type": "string", "maxLength": 4096, "description": "The project folder or name. Leave it out when you work on one project." }
            },
            "required": ["action"],
            "additionalProperties": false
        },
        "annotations": { "title": "Proof tools", "destructiveHint": false, "openWorldHint": false }
    })]
}

/// Run the tool.
pub fn call(app: &dyn App, args: &Value) -> Result<Value, String> {
    let object = arguments(args, &FIELDS)?;
    let has_tool = match object.get("toolId") {
        None | Some(Value::Null) => false,
        Some(Value::String(id)) if !id.trim().is_empty() && id.chars().count() <= 40 => true,
        Some(_) => return Err("toolId must be a tool id from list, 40 characters at most.".into()),
    };
    match object.get("action").and_then(Value::as_str) {
        Some("list") => {
            if has_tool {
                return Err(
                    "list takes no toolId. Use propose to put one tool to the person.".into(),
                );
            }
            app.call(
                "proof_tools.list",
                &pick(object, &LIST_FIELDS),
                &new_request_id(),
            )
        }
        Some("propose") => {
            if !has_tool {
                return Err(
                    "propose needs a toolId: one of the tools list says the project doesn't have."
                        .into(),
                );
            }
            app.call(
                "proof_tools.propose",
                &pick(object, &PROPOSE_FIELDS),
                &new_request_id(),
            )
        }
        _ => Err("action must be list or propose.".into()),
    }
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
            Ok(json!({ "ok": true }))
        }
    }

    #[test]
    fn the_tool_says_what_it_does_in_one_line_and_has_no_long_dashes() {
        let listed = tools();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["name"], "proof_tools");
        assert_eq!(
            listed[0]["description"],
            "List the proof tools that fit this project and which it has, or propose adding one to the person."
        );
        assert_eq!(listed[0]["inputSchema"]["type"], "object");
        assert_eq!(listed[0]["inputSchema"]["additionalProperties"], false);
        assert_eq!(listed[0]["inputSchema"]["required"], json!(["action"]));
        assert_eq!(
            listed[0]["inputSchema"]["properties"]["action"]["enum"],
            json!(["list", "propose"])
        );
        assert_eq!(
            listed[0]["inputSchema"]["properties"]["toolId"]["maxLength"],
            40
        );
        assert!(NAMES.contains(&"proof_tools"));
        let text = listed[0].to_string();
        assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}'));
    }

    #[test]
    fn list_and_propose_are_one_app_call_each_and_name_only_their_own_fields() {
        let app = Recorder(Mutex::new(Vec::new()));
        call(&app, &json!({ "action": "list" })).unwrap();
        call(&app, &json!({ "action": "list", "project": "tally" })).unwrap();
        call(
            &app,
            &json!({ "action": "propose", "toolId": "fast-check", "project": "tally" }),
        )
        .unwrap();
        call(&app, &json!({ "action": "propose", "toolId": "stryker" })).unwrap();
        assert_eq!(
            app.0.lock().unwrap().as_slice(),
            [
                ("proof_tools.list".to_string(), json!({})),
                (
                    "proof_tools.list".to_string(),
                    json!({ "project": "tally" })
                ),
                (
                    "proof_tools.propose".to_string(),
                    json!({ "project": "tally", "toolId": "fast-check" })
                ),
                (
                    "proof_tools.propose".to_string(),
                    json!({ "toolId": "stryker" })
                ),
            ]
        );
    }

    #[test]
    fn a_typo_a_missing_action_or_the_wrong_fields_call_nothing() {
        let app = Recorder(Mutex::new(Vec::new()));
        let typo = call(&app, &json!({ "action": "list", "projekt": "tally" })).unwrap_err();
        assert!(typo.starts_with("Unknown fields: projekt"), "{typo}");
        assert!(call(&app, &json!(["list"])).is_err());
        assert!(call(&app, &json!({})).is_err());
        assert!(call(
            &app,
            &json!({ "action": "install", "toolId": "fast-check" })
        )
        .is_err());
        assert!(call(&app, &json!({ "action": "propose" })).is_err());
        assert!(call(&app, &json!({ "action": "propose", "toolId": "" })).is_err());
        assert!(call(&app, &json!({ "action": "propose", "toolId": 7 })).is_err());
        let long = "x".repeat(41);
        assert!(call(&app, &json!({ "action": "propose", "toolId": long })).is_err());
        let list_with_tool = call(&app, &json!({ "action": "list", "toolId": "fast-check" }));
        assert!(list_with_tool.is_err());
        assert!(
            app.0.lock().unwrap().is_empty(),
            "a refused call reaches no app"
        );
    }

    #[test]
    fn the_app_actions_are_allowed_to_an_agents_token_and_there_is_no_install_action() {
        assert!(crate::mcp_server::MCP_APP_ACTIONS.contains(&"proof_tools.list"));
        assert!(crate::mcp_server::MCP_APP_ACTIONS.contains(&"proof_tools.propose"));
        assert!(crate::control::app_action_allowed("proof_tools.list"));
        assert!(crate::control::app_action_allowed("proof_tools.propose"));
        // The app never installs a tool: no action does.
        assert!(!crate::control::app_action_allowed("proof_tools.install"));
    }
}
