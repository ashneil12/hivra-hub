//! Hivra WP-171: delegate_tasks in `monocode mcp` (mcp_server.rs), the multi-part form of delegate_task. One call carries
//! every task of a plan and, on each, what it owns, provides, requires and checks. It is one `tasks.fanout` app call,
//! answered by src/features/agent-app/model/agentAppTasks.ts: the contract is checked there before anything starts, and
//! each task then goes through the same delegation a single delegate_task does. There is no mode and no setting for it.

use serde_json::{json, Value};

use crate::mcp_server::{arguments, new_request_id, pick, valid_request_id, App};

pub const NAMES: [&str; 1] = ["delegate_tasks"];

/// What the app action takes. `clientRequestId` only names the call, so a retry never starts a task twice.
const FIELDS: [&str; 2] = ["intent", "tasks"];

/// One task's schema, built apart: a literal with the tool around it passes json!'s recursion limit.
fn task_schema() -> Value {
    let text = |description: &str| json!({ "type": "string", "description": description });
    let names = |description: &str, max: u64| json!({ "type": "array", "items": { "type": "string" }, "maxItems": max, "description": description });
    let provide = json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["file", "symbol", "id", "endpoint", "env", "flag", "other"] },
            "name": text("The literal name another task will require, exactly: a path for a file, otherwise the symbol, id, route, variable or flag as it will be written."),
            "in": text("The one file it will appear in (not a pattern). Leave out for a file (its name is its path), or when the task owns or declares the file."),
            "shape": text("One line on what it is: a signature or a return shape. It is shown to the tasks that rely on it.")
        },
        "required": ["kind", "name"],
        "additionalProperties": false
    });
    json!({
        "type": "object",
        "properties": {
            "name": text("A short name for this task in the plan: letters, digits, - and _ (like api). Other tasks do not use it: they require what this one provides."),
            "brief": text("The spec: only the build instructions this part needs, what it may change, what stays out of scope, and the checks to run."),
            "goal": text("The definition of done: the condition that finishes this part, as a check someone can run."),
            "title": text("A short job name, like \"Add the score route\". Defaults to the brief's first line."),
            "intent": text("Only when this task has its own ask of the person; otherwise the plan's intent is used."),
            "owns": names("Paths (or a folder, or folder/**) only this task writes, inside the project. No two tasks own the same path.", 30),
            "provides": { "type": "array", "items": provide, "maxItems": 64, "description": "What this task must produce for the others, under exactly these names. A name that is not a file needs somewhere to look: in, a file it owns, or a file it declares in files." },
            "requires": names("Names (as another task provides them) this task relies on. It waits until the task that provides each is done, its checks passed, and what it provided is on disk. A name nothing provides is refused.", 64),
            "checks": names("Ids of the project's own checks this task must pass; each runs on its work before it counts as done, and one that did not run is not a pass.", 20),
            "files": names("Other project files or folders this task changes, beyond what it owns.", 30),
            "project": text("The hub project id, folder path or name. Omit when you have one project."),
            "model": text("Usually omit it."),
            "effort": text("The model's effort setting, when it has one."),
            "heavy": { "type": "boolean", "description": "True when the task runs heavy tests (full suites, e2e, builds)." },
            "hard": { "type": "boolean", "description": "True when the task is hard (subtle, high-risk, or wide)." },
            "scope": names("The files or areas this task covers, as you see them.", 50),
            "asks": names("The Ash OS ask ids (a_...) this task covers.", 50),
            "gates": { "type": "array", "items": { "type": "string", "enum": ["diff", "checks", "committed", "ratchet", "routes"] }, "description": "Which checks must pass before this task is done, as for delegate_task." },
            "code": { "type": "boolean", "description": "True when the task changes code: it always gets the diff and checks gates." }
        },
        "required": ["name", "brief", "goal"],
        "additionalProperties": false
    })
}

/// The tools, as `tools/list` describes them.
pub fn tools() -> Vec<Value> {
    vec![json!({
        "name": "delegate_tasks",
        "title": "Delegate a multi-part ask",
        "description": "Hand a multi-part ask to workers in one call, when the parts depend on each other or share names (a route one part writes and another calls, a file one part makes and another reads). Each task says what it owns, provides, requires and checks; the app writes that contract into every worker's brief, so the names are agreed once instead of paraphrased in each. Everything is checked before any worker starts: a requirement nothing provides, a provide nobody could check, two owners of one path, a bad brief, more than 8 tasks. Tasks that need nothing start together; a task that requires a name waits, and starts by itself once the task that provides it is done, its declared checks passed and what it provided is on disk. If a provider fails, was stopped or did not deliver, what waits on it is held, not run anyway: task_status says what landed and what did not start, and you decide (task_cancel what is held, then send it again once the missing part is redone). Each task is otherwise an ordinary delegate_task (its own worker, checkout, gates and report). A single part, or parts that need nothing from each other, can use delegate_task. Keep the same clientRequestId when retrying so no task starts twice.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "intent": { "type": "string", "description": "Ash's own ask, in his words, with the context needed to read it. Shared by every task that does not bring its own. The app also quotes his original request in each brief." },
                "tasks": { "type": "array", "minItems": 1, "maxItems": 8, "items": task_schema(), "description": "The parts, in the order you want them started. A task that needs another is held until it is delivered, whatever its place." },
                "clientRequestId": { "type": "string", "description": "Letters, digits, - and _. The same id on a retry never starts a task twice." }
            },
            "required": ["tasks"],
            "additionalProperties": false
        },
        "annotations": { "title": "Delegate a multi-part ask", "destructiveHint": true, "openWorldHint": true }
    })]
}

/// Run the tool.
pub fn call(app: &dyn App, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "delegate_tasks" => {
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
            app.call("tasks.fanout", &pick(object, &FIELDS), &request_id)
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
            Ok(json!({ "ok": action }))
        }
    }

    fn plan() -> Value {
        json!({
            "intent": "Ash: a score board",
            "tasks": [
                { "name": "api", "brief": "Add /api/score", "goal": "it answers",
                  "provides": [{ "kind": "endpoint", "name": "/api/score", "in": "src/api/score.ts" }] },
                { "name": "board", "brief": "Show it", "goal": "it shows", "requires": ["/api/score"] }
            ]
        })
    }

    #[test]
    fn the_whole_plan_is_one_app_call_under_the_callers_request_id() {
        let app = Recorder(Mutex::new(Vec::new()));
        let mut args = plan();
        args["clientRequestId"] = json!("plan-1");
        call(&app, "delegate_tasks", &args).unwrap();
        let calls = app.0.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "tasks.fanout");
        assert_eq!(calls[0].1, plan());
        assert_eq!(calls[0].2, "plan-1");
    }

    #[test]
    fn a_call_with_no_request_id_gets_a_fresh_one() {
        let app = Recorder(Mutex::new(Vec::new()));
        call(&app, "delegate_tasks", &plan()).unwrap();
        call(&app, "delegate_tasks", &plan()).unwrap();
        let calls = app.0.lock().unwrap();
        assert!(valid_request_id(&calls[0].2));
        assert_ne!(calls[0].2, calls[1].2);
    }

    #[test]
    fn a_typo_or_a_bad_request_id_is_refused_before_the_app_is_called() {
        let app = Recorder(Mutex::new(Vec::new()));
        let mut typo = plan();
        typo["task"] = json!([]);
        let error = call(&app, "delegate_tasks", &typo).unwrap_err();
        assert!(error.starts_with("Unknown fields: task"), "{error}");
        let mut bad = plan();
        bad["clientRequestId"] = json!("has spaces");
        assert!(call(&app, "delegate_tasks", &bad)
            .unwrap_err()
            .contains("clientRequestId must be letters"));
        assert!(call(&app, "delegate_tasks", &json!(["tasks"])).is_err());
        assert!(app.0.lock().unwrap().is_empty());
    }

    #[test]
    fn the_schema_is_closed_and_names_every_field_the_app_reads() {
        let listed = tools();
        assert_eq!(listed.len(), 1);
        assert!(NAMES.contains(&listed[0]["name"].as_str().unwrap()));
        let schema = &listed[0]["inputSchema"];
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["tasks"]));
        assert_eq!(schema["properties"]["tasks"]["maxItems"], 8);
        let task = &schema["properties"]["tasks"]["items"];
        assert_eq!(task["additionalProperties"], false);
        assert_eq!(task["required"], json!(["name", "brief", "goal"]));
        for field in ["owns", "provides", "requires", "checks", "files"] {
            assert!(task["properties"][field].is_object(), "{field}");
        }
        assert_eq!(
            task["properties"]["provides"]["items"]["properties"]["kind"]["enum"],
            json!(["file", "symbol", "id", "endpoint", "env", "flag", "other"])
        );
        assert_eq!(
            task["properties"]["provides"]["items"]["additionalProperties"],
            false
        );
        // No dash a person might see, and no switch: it is how a multi-part ask goes out, not a mode.
        let text = listed[0].to_string();
        assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}'));
        assert!(text
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .all(|word| word != "mode"));
    }
}
