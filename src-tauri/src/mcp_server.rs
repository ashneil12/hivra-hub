//! `monocode mcp`: the delegate tool (docs/PHASE-2-DESIGN.md, H3).
//!
//! A stdio MCP server that Claude Code starts for a Mono's chat (its `--mcp-config` entry is built in
//! src/features/hub/model/hubMcp.ts). Each tool is one or more app calls (`tasks.*`, answered by
//! src/features/agent-app/model/agentAppTasks.ts over the delegation rows of delegations.rs) on the same loopback
//! connection as `monocode app`, so:
//! - **Who calls** is the app token: control.rs maps it to the chat it was made for, so a model can never act as another
//!   chat, and the app only ever hands a chat its own tasks.
//! - **When**: a call works only inside that chat's active turn; control.rs refuses the token between turns.
//! - **The token** arrives in the environment (`MONOCODE_APP_ENDPOINT` / `MONOCODE_APP_TOKEN`, written as `"${VAR}"` in
//!   the entry and expanded by Claude Code), never in argv, and nothing here prints it.
//! - **Waiting**: control.rs answers one call within 35 s, so a wait is a run of app calls of at most 25 s each until a
//!   task finishes, asks a question, or the wait's own budget (up to 60 minutes) runs out. The entry's `timeout` lets
//!   Claude Code hold the call that long.
//!
//! Stdout carries only JSON-RPC; nothing else may be written to it.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

/// The longest single app call a wait makes; control.rs gives up on a call after 35 s.
pub const SLICE_SECONDS: u64 = 25;
const WAIT_DEFAULT_MINUTES: u64 = 10;
const WAIT_MAX_MINUTES: u64 = 60;
/// Newest first; an unknown version from the client gets the newest.
const PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const NO_CONNECTION: &str = "No MonoCode app connection. These tools work only in a Mono's own chat in MonoCode Hub, during its turn.";

const USAGE: &str = "MonoCode delegate tool: a stdio MCP server (delegate_task, task_status, task_wait, task_cancel, \
task_answer, and pr_watch, pr_unwatch, pr_watches) for a Mono's chat. MonoCode Hub starts it through Claude Code's --mcp-config with MONOCODE_APP_ENDPOINT \
and MONOCODE_APP_TOKEN in its environment. Usage: monocode mcp";

const INSTRUCTIONS: &str = "MonoCode's delegate tool. delegate_task hands a job to a worker chat that shows nested \
under yours and is stored as a task: it reports back to you as a new turn ([MonoCode report]) once you are idle, even \
across restarts. Put Ash's own words and the full context in brief, the Ash OS ask ids it covers in asks, and the \
finish line in goal. After an async delegation, say in one line what you started and end your turn instead of polling. \
task_status reads results (a result read here is not reported again), task_wait blocks until a task finishes or asks \
a question, task_cancel stops a task and everything beneath it, task_answer answers your worker's question. A \
worker's question reaches you as a [MonoCode question] turn (or task_wait returns hasPendingQuestion): answer it from \
the brief or Ash's words; only a real choice goes to Ash, asked in your own chat with your pick. pr_watch has \
MonoCode watch a pull request you opened and wake you only when a required check fails or they all pass, someone else \
comments, the branch conflicts, or it merges: register every pull request, then end your turn instead of polling.";

/// One app call (`monocode app ACTION`), as the app answered it: its result, or why it refused.
pub(crate) trait App: Send + Sync {
    fn call(&self, action: &str, input: &Value, request_id: &str) -> Result<Value, String>;
}

/// Time, so tests can run an hour of waiting in no time.
pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> Duration;
    fn sleep(&self, duration: Duration);
}

struct RealClock(Instant);

impl Clock for RealClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// Both halves of the connection, expanded. Claude Code leaves an unset `${VAR}` as the literal text, so that counts
/// as missing too. The value is only checked, never returned or printed.
fn connection(read: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    for key in ["MONOCODE_APP_ENDPOINT", "MONOCODE_APP_TOKEN"] {
        match read(key) {
            Some(value) if !value.trim().is_empty() && !value.trim_start().starts_with("${") => {}
            _ => return Err(NO_CONNECTION.into()),
        }
    }
    Ok(())
}

/// The app over the connection `monocode app` uses (control_cli::send reads the same environment).
struct LiveApp;

impl App for LiveApp {
    fn call(&self, action: &str, input: &Value, request_id: &str) -> Result<Value, String> {
        connection(|key| std::env::var(key).ok())?;
        let mut retried = false;
        loop {
            let error = match crate::control_cli::send(action, input, request_id, true) {
                Ok(value) if value.get("ok").and_then(Value::as_bool) == Some(true) => {
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(value) => {
                    let error = value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("MonoCode refused the call")
                        .to_string();
                    // The answer was lost, not refused: the app applies a request id at most once, so ask again.
                    (error.starts_with("Control request timed out"), error)
                }
                Err(failure) => (failure.sent, failure.error),
            };
            match error {
                (true, _) if !retried => retried = true,
                (_, error) => return Err(error),
            }
        }
    }
}

pub(crate) fn new_request_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// The tool's arguments: an object with only these keys (a typo is refused, never ignored).
pub(crate) fn arguments<'a>(
    args: &'a Value,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    let Some(object) = args.as_object() else {
        return Err("Arguments must be a JSON object".into());
    };
    let unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !allowed.contains(key))
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "Unknown fields: {}. Allowed: {}",
            unknown.join(", "),
            allowed.join(", ")
        ));
    }
    Ok(object)
}

pub(crate) fn pick(object: &Map<String, Value>, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| {
                object
                    .get(*key)
                    .map(|value| (key.to_string(), value.clone()))
            })
            .collect(),
    )
}

fn wait_budget(value: Option<&Value>) -> Result<Duration, String> {
    let minutes = match value {
        None => WAIT_DEFAULT_MINUTES,
        Some(value) => value
            .as_u64()
            .filter(|minutes| (1..=WAIT_MAX_MINUTES).contains(minutes))
            .ok_or_else(|| {
                format!("timeoutMinutes must be a whole number from 1 to {WAIT_MAX_MINUTES}")
            })?,
    };
    Ok(Duration::from_secs(minutes * 60))
}

/// What one tool call may use.
pub(crate) struct Call<'a> {
    pub app: &'a dyn App,
    pub clock: &'a dyn Clock,
    /// Claude Code cancelled the call (the user stopped the turn).
    pub cancelled: &'a AtomicBool,
    /// Seconds waited so far and the wait's budget, for progress notifications.
    pub progress: &'a mut dyn FnMut(u64, u64),
}

/// The tools, as `tools/list` describes them.
fn tools() -> Value {
    let task_ids = json!({
        "type": "array",
        "items": { "type": "string" },
        "maxItems": 20,
        "description": "Task ids (t-...) from delegate_task. Omit for your tasks still running or owed."
    });
    let wait_minutes = json!({
        "type": "integer",
        "minimum": 1,
        "maximum": WAIT_MAX_MINUTES,
        "default": WAIT_DEFAULT_MINUTES,
        "description": "How long to wait at most. It only ends the wait; the task keeps running."
    });
    let mut tools = json!([
        {
            "name": "delegate_task",
            "title": "Delegate a task",
            "description": "Hand one job to a worker: a new chat nested under yours, started with only this brief (it does not see your conversation). The task is stored, survives app restarts, and reports back to you as a new turn once you are idle. Record Ash's asks first (ash_record) and pass their ids in asks; they move to working. Use mode async (the default) for real work: say in one line what you started, then end your turn; do not poll or do the work yourself. Use mode wait only for a short job whose result you need in this turn: it blocks until the task finishes, asks a question, or timeoutMinutes pass (waitTimedOut; the task keeps running and still reports). isolation worktree gives the worker its own git worktree from your project's current commit (uncommitted edits are not copied). Keep the same clientRequestId when retrying the same delegation so it never starts twice.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "brief": { "type": "string", "description": "The whole job: Ash's own words quoted, the context, the checkout, what it may change, the checks to run and the result and evidence you expect back." },
                    "title": { "type": "string", "description": "A short job name, like \"Fix the save bug\". Defaults to the brief's first line." },
                    "asks": { "type": "array", "items": { "type": "string" }, "maxItems": 50, "description": "The Ash OS ask ids (a_...) this job covers." },
                    "goal": { "type": "string", "description": "Done when: the condition that finishes the job." },
                    "project": { "type": "string", "description": "The hub project id, folder path or name. Omit when you have one project." },
                    "model": { "type": "string", "description": "A model id (claude:sonnet-5) or family (sonnet). Inherits yours by default." },
                    "effort": { "type": "string", "description": "The model's effort setting, when it has one." },
                    "isolation": { "type": "string", "enum": ["shared", "worktree"], "default": "shared" },
                    "mode": { "type": "string", "enum": ["async", "wait"], "default": "async" },
                    "timeoutMinutes": wait_minutes.clone(),
                    "clientRequestId": { "type": "string", "description": "Letters, digits, - and _. The same id on a retry never starts a second worker." },
                    "lead": { "type": "string", "description": "Leadership team only: brief a project's Lead instead of starting a worker (its id, or the project's id or name). The brief goes into the Lead's own long-running chat; the Lead delegates to its workers and its final report comes back to you (and to the project's Leadership room) as a new turn." },
                    "whenBusy": { "type": "string", "enum": ["queue", "steer"], "default": "queue", "description": "With lead: if the Lead is mid-turn, queue the brief behind its current work (default) or steer it into that work." }
                },
                "required": ["brief"],
                "additionalProperties": false
            },
            "annotations": { "title": "Delegate a task", "destructiveHint": true, "openWorldHint": true }
        },
        {
            "name": "task_status",
            "title": "Read your tasks",
            "description": "Your delegated tasks: status (running, question, completed, failed, cancelled), activity, last active time, the result or the provider's reason for a failure, a worker's pending question, and counts of the tasks it delegated in turn. Reading a finished result marks it read, so no report turn follows for it.",
            "inputSchema": {
                "type": "object",
                "properties": { "taskIds": task_ids.clone() },
                "additionalProperties": false
            },
            "annotations": { "title": "Read your tasks", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true }
        },
        {
            "name": "task_wait",
            "title": "Wait for your tasks",
            "description": "Block until one of your running tasks finishes or asks a question, or timeoutMinutes pass. Returns status only (read results with task_status). Prefer ending your turn: finished tasks report back on their own.",
            "inputSchema": {
                "type": "object",
                "properties": { "taskIds": task_ids, "timeoutMinutes": wait_minutes },
                "additionalProperties": false
            },
            "annotations": { "title": "Wait for your tasks", "readOnlyHint": true, "idempotentHint": true }
        },
        {
            "name": "task_cancel",
            "title": "Cancel a task",
            "description": "Stop one of your tasks and everything it delegated in turn: each worker's turn is stopped, depth first, and the reports still owed are dropped. stopFailed lists any worker that would not stop. A finished task keeps its result.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "reason": { "type": "string", "description": "Why, for the task's record." }
                },
                "required": ["taskId"],
                "additionalProperties": false
            },
            "annotations": { "title": "Cancel a task", "destructiveHint": true }
        },
        {
            "name": "task_answer",
            "title": "Answer your worker",
            "description": "Answer the open question of one of your tasks' workers (task_status shows it with its requestId, question ids and option ids), or skip it. Answer from the brief or Ash's words; a real choice goes to Ash once, with your recommendation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "requestId": { "type": "integer", "minimum": 0 },
                    "answers": { "type": "object", "additionalProperties": { "type": "array", "items": { "type": "string" } }, "description": "{\"<questionId>\": [\"<optionId>\"]}" },
                    "skip": { "type": "boolean" }
                },
                "required": ["taskId", "requestId"],
                "additionalProperties": false
            },
            "annotations": { "title": "Answer your worker", "destructiveHint": false }
        }
    ]);
    if let Value::Array(list) = &mut tools {
        list.extend(crate::pr_watch::mcp::tools());
    }
    tools
}

const DELEGATE_APP_FIELDS: [&str; 10] = [
    "brief",
    "title",
    "asks",
    "goal",
    "project",
    "model",
    "effort",
    "isolation",
    "lead",
    "whenBusy",
];

/// Run one tool. An error is the reason the model reads (a refusal from the app comes through word for word).
pub(crate) fn call_tool(call: &mut Call, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "delegate_task" => delegate(call, args),
        "task_status" => {
            let object = arguments(args, &["taskIds"])?;
            call.app.call(
                "tasks.status",
                &pick(object, &["taskIds"]),
                &new_request_id(),
            )
        }
        "task_wait" => wait(call, args),
        "task_cancel" => {
            let object = arguments(args, &["taskId", "reason"])?;
            call.app.call(
                "tasks.cancel",
                &pick(object, &["taskId", "reason"]),
                &new_request_id(),
            )
        }
        "task_answer" => {
            let fields = ["taskId", "requestId", "answers", "skip"];
            let object = arguments(args, &fields)?;
            call.app
                .call("tasks.answer", &pick(object, &fields), &new_request_id())
        }
        name if crate::pr_watch::mcp::NAMES.contains(&name) => {
            crate::pr_watch::mcp::call(call.app, name, args)
        }
        _ => Err(format!(
            "Unknown tool: {name}. Use delegate_task, task_status, task_wait, task_cancel, task_answer, pr_watch, \
             pr_unwatch or pr_watches."
        )),
    }
}

fn delegate(call: &mut Call, args: &Value) -> Result<Value, String> {
    let mut allowed = DELEGATE_APP_FIELDS.to_vec();
    allowed.extend(["mode", "timeoutMinutes", "clientRequestId"]);
    let object = arguments(args, &allowed)?;
    let wait_mode = match object.get("mode").map(|mode| mode.as_str()) {
        None | Some(Some("async")) => false,
        Some(Some("wait")) => true,
        _ => return Err("mode must be async or wait".into()),
    };
    let budget = wait_budget(object.get("timeoutMinutes"))?;
    let request_id = match object.get("clientRequestId") {
        None => new_request_id(),
        Some(Value::String(id)) if valid_request_id(id) => id.clone(),
        _ => {
            return Err(
                "clientRequestId must be letters, digits, - and _ (up to 100 characters)".into(),
            )
        }
    };
    let started = call.app.call(
        "tasks.delegate",
        &pick(object, &DELEGATE_APP_FIELDS),
        &request_id,
    )?;
    let mut out = json!({
        "taskId": started.get("taskId").cloned().unwrap_or(Value::Null),
        "childSessionId": started.get("childSessionId").cloned().unwrap_or(Value::Null),
        "status": started.get("status").cloned().unwrap_or_else(|| json!("running")),
        "hasPendingQuestion": false,
        "waitTimedOut": false,
    });
    // A Lead brief says how it went in (started, queued behind the Lead's work, or steered into it) and to whom.
    for key in ["delivery", "lead"] {
        if let Some(value) = started.get(key) {
            out[key] = value.clone();
        }
    }
    let task = started.get("taskId").and_then(Value::as_str);
    let Some(task) = task.filter(|_| wait_mode) else {
        out["note"] = match started.get("note") {
            Some(note) => note.clone(),
            None => json!("Started. Its report comes back to you as a new turn once you are idle: tell Ash in one line what you started and end your turn."),
        };
        return Ok(out);
    };
    let ids = vec![task.to_string()];
    let (last, timed_out) = wait_slices(call, &ids, budget)?;
    if timed_out {
        out["waitTimedOut"] = json!(true);
        if let Some(status) = status_of(&last, task) {
            out["status"] = status;
        }
        out["note"] = json!("Still running. It keeps working and reports back as a new turn once you are idle; end your turn, or check it later with task_status.");
        return Ok(out);
    }
    // Reading the result here counts as receiving it, so no report turn follows for it.
    let status = call.app.call(
        "tasks.status",
        &json!({ "taskIds": ids }),
        &new_request_id(),
    )?;
    if let Some(Value::Object(task)) = status
        .get("tasks")
        .and_then(Value::as_array)
        .and_then(|tasks| tasks.first())
    {
        for (key, value) in task {
            if key != "taskId" && key != "childSessionId" {
                out[key.as_str()] = value.clone();
            }
        }
    }
    Ok(out)
}

fn status_of(wait: &Value, task: &str) -> Option<Value> {
    wait.get("tasks")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("taskId").and_then(Value::as_str) == Some(task))?
        .get("status")
        .cloned()
}

fn running_ids(wait: &Value) -> Vec<String> {
    wait.get("tasks")
        .and_then(Value::as_array)
        .map(|tasks| {
            tasks
                .iter()
                .filter(|task| task.get("status").and_then(Value::as_str) == Some("running"))
                .filter_map(|task| {
                    task.get("taskId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A wait answer with news: a task left running (finished or asking), or nothing runs any more.
fn settled(wait: &Value) -> bool {
    wait.get("settled")
        .and_then(Value::as_array)
        .is_some_and(|ids| !ids.is_empty())
        || wait.get("running").and_then(Value::as_u64) == Some(0)
}

fn wait(call: &mut Call, args: &Value) -> Result<Value, String> {
    let object = arguments(args, &["taskIds", "timeoutMinutes"])?;
    let budget = wait_budget(object.get("timeoutMinutes"))?;
    let mut snapshot = json!({ "timeoutSeconds": 0 });
    if let Some(ids) = object.get("taskIds") {
        snapshot["taskIds"] = ids.clone();
    }
    // Only the tasks running now: one that already finished must not end every wait at once.
    let now = call.app.call("tasks.wait", &snapshot, &new_request_id())?;
    let running = running_ids(&now);
    if running.is_empty() {
        return Ok(with_timed_out(now, false));
    }
    let (last, timed_out) = wait_slices(call, &running, budget)?;
    if object.get("taskIds").is_none() {
        return Ok(with_timed_out(last, timed_out));
    }
    // Everything that was asked about, as it stands now.
    let all = call.app.call("tasks.wait", &snapshot, &new_request_id())?;
    Ok(with_timed_out(
        json!({
            "tasks": all.get("tasks").cloned().unwrap_or_else(|| json!([])),
            "settled": last.get("settled").cloned().unwrap_or_else(|| json!([])),
            "running": all.get("running").cloned().unwrap_or(Value::Null),
        }),
        timed_out,
    ))
}

fn with_timed_out(mut wait: Value, timed_out: bool) -> Value {
    if let Value::Object(object) = &mut wait {
        object.insert("timedOut".into(), json!(timed_out));
    }
    wait
}

/// Wait on `ids` in app calls of at most 25 s until one settles or `budget` runs out (`true`: it ran out).
pub(crate) fn wait_slices(
    call: &mut Call,
    ids: &[String],
    budget: Duration,
) -> Result<(Value, bool), String> {
    let start = call.clock.now();
    let mut last = json!({ "tasks": [], "settled": [], "running": ids.len() });
    loop {
        if call.cancelled.load(Ordering::SeqCst) {
            return Err("Cancelled.".into());
        }
        let spent = call.clock.now().saturating_sub(start);
        let left = budget.saturating_sub(spent);
        if left < Duration::from_secs(1) {
            return Ok((last, true));
        }
        let seconds = left.as_secs().min(SLICE_SECONDS);
        let began = call.clock.now();
        last = call.app.call(
            "tasks.wait",
            &json!({ "taskIds": ids, "timeoutSeconds": seconds }),
            &new_request_id(),
        )?;
        if settled(&last) {
            return Ok((last, false));
        }
        let waited = call.clock.now().saturating_sub(start);
        (call.progress)(waited.as_secs(), budget.as_secs());
        // An answer that came back early without news never turns this into a busy loop.
        if call.clock.now().saturating_sub(began) < Duration::from_secs(1) {
            call.clock.sleep(Duration::from_secs(1));
        }
    }
}

fn reply(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn failure(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Everything but `tools/call` and cancellation, answered at once. None for a notification.
fn respond(message: &Value) -> Option<Value> {
    let id = message.get("id").cloned().filter(|id| !id.is_null())?;
    // A response to a request of ours (none are sent) needs no answer.
    let method = message.get("method").and_then(Value::as_str)?;
    Some(match method {
        "initialize" => {
            let asked = message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("");
            let version = PROTOCOLS
                .iter()
                .find(|known| **known == asked)
                .copied()
                .unwrap_or(PROTOCOLS[0]);
            reply(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "monocode", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => reply(id, json!({})),
        "tools/list" => reply(id, json!({ "tools": tools() })),
        _ => failure(id, -32601, &format!("Method not found: {method}")),
    })
}

fn tool_result(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": value.to_string() }],
            "isError": false,
        }),
        Err(error) => json!({
            "content": [{ "type": "text", "text": error }],
            "isError": true,
        }),
    }
}

fn write_line<W: Write>(out: &Mutex<W>, message: &Value) {
    if let Ok(mut out) = out.lock() {
        let _ = writeln!(out, "{message}");
        let _ = out.flush();
    }
}

type Calls = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

/// Serve JSON-RPC lines from `input` until it closes. Tool calls run on their own threads when `spawn` (a wait must
/// not hold up a status read); the tests run them in line.
pub(crate) fn serve<R, W>(
    input: R,
    out: Arc<Mutex<W>>,
    app: Arc<dyn App>,
    clock: Arc<dyn Clock>,
    spawn: bool,
) where
    R: BufRead,
    W: Write + Send + 'static,
{
    let calls: Calls = Arc::default();
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            write_line(&out, &failure(Value::Null, -32700, "Parse error"));
            continue;
        };
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned().filter(|id| !id.is_null());
        match (method, id) {
            (Some("tools/call"), Some(id)) => {
                let key = id.to_string();
                let flag = Arc::new(AtomicBool::new(false));
                if let Ok(mut calls) = calls.lock() {
                    calls.insert(key.clone(), flag.clone());
                }
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                let (out, app, clock, calls) =
                    (out.clone(), app.clone(), clock.clone(), calls.clone());
                let job = move || {
                    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                    let args = params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let token = params
                        .pointer("/_meta/progressToken")
                        .cloned()
                        .filter(|token| !token.is_null());
                    let progress_out = out.clone();
                    let mut progress = move |done: u64, total: u64| {
                        if let Some(token) = &token {
                            write_line(
                                &progress_out,
                                &json!({
                                    "jsonrpc": "2.0",
                                    "method": "notifications/progress",
                                    "params": {
                                        "progressToken": token,
                                        "progress": done,
                                        "total": total,
                                        "message": "Waiting on delegated work",
                                    },
                                }),
                            );
                        }
                    };
                    let outcome = call_tool(
                        &mut Call {
                            app: app.as_ref(),
                            clock: clock.as_ref(),
                            cancelled: &flag,
                            progress: &mut progress,
                        },
                        name,
                        &args,
                    );
                    if let Ok(mut calls) = calls.lock() {
                        calls.remove(&key);
                    }
                    write_line(&out, &reply(id, tool_result(outcome)));
                };
                if spawn {
                    std::thread::spawn(job);
                } else {
                    job();
                }
            }
            (Some("notifications/cancelled"), None) => {
                if let Some(request) = message.pointer("/params/requestId") {
                    if let Some(flag) = calls
                        .lock()
                        .ok()
                        .and_then(|calls| calls.get(&request.to_string()).cloned())
                    {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
            }
            _ => {
                if let Some(response) = respond(&message) {
                    write_line(&out, &response);
                }
            }
        }
    }
    // Stdin closed: Claude Code is gone. Stop any wait still running.
    let open: Vec<Arc<AtomicBool>> = match calls.lock() {
        Ok(calls) => calls.values().cloned().collect(),
        Err(_) => Vec::new(),
    };
    for flag in open {
        flag.store(true, Ordering::SeqCst);
    }
}

/// `monocode mcp`.
pub fn run(args: Vec<String>) -> i32 {
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
    {
        println!("{USAGE}");
        return 0;
    }
    if !args.is_empty() {
        eprintln!("{USAGE}");
        return 2;
    }
    serve(
        std::io::stdin().lock(),
        Arc::new(Mutex::new(std::io::stdout())),
        Arc::new(LiveApp),
        Arc::new(RealClock(Instant::now())),
        true,
    );
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    type Responder = dyn Fn(&str, &Value, usize) -> Result<Value, String> + Send + Sync;

    /// The app, as a script: each call is recorded, and a wait takes the time it asked for on the fake clock.
    struct FakeApp {
        calls: Mutex<Vec<(String, Value, String)>>,
        respond: Box<Responder>,
        clock: Arc<FakeClock>,
        waits_take_time: bool,
    }

    impl FakeApp {
        fn new(
            clock: Arc<FakeClock>,
            respond: impl Fn(&str, &Value, usize) -> Result<Value, String> + Send + Sync + 'static,
        ) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                respond: Box::new(respond),
                clock,
                waits_take_time: true,
            }
        }
        fn actions(&self) -> Vec<String> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|c| c.0.clone())
                .collect()
        }
        fn waits(&self) -> Vec<u64> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.0 == "tasks.wait")
                .map(|c| c.1["timeoutSeconds"].as_u64().unwrap())
                .collect()
        }
    }

    impl App for FakeApp {
        fn call(&self, action: &str, input: &Value, request_id: &str) -> Result<Value, String> {
            let n = {
                let mut calls = self.calls.lock().unwrap();
                calls.push((action.into(), input.clone(), request_id.into()));
                calls.len()
            };
            let result = (self.respond)(action, input, n);
            if action == "tasks.wait" && self.waits_take_time {
                let seconds = input["timeoutSeconds"].as_u64().unwrap_or(0);
                // A wait with news returns early; one without takes its whole slice.
                if !result.as_ref().map(settled).unwrap_or(true) {
                    self.clock.sleep(Duration::from_secs(seconds));
                }
            }
            result
        }
    }

    #[derive(Default)]
    struct FakeClock(Mutex<Duration>);

    impl Clock for FakeClock {
        fn now(&self) -> Duration {
            *self.0.lock().unwrap()
        }
        fn sleep(&self, duration: Duration) {
            *self.0.lock().unwrap() += duration;
        }
    }

    fn running(ids: &[&str]) -> Value {
        json!({
            "tasks": ids.iter().map(|id| json!({ "taskId": id, "status": "running" })).collect::<Vec<_>>(),
            "settled": [],
            "running": ids.len(),
            "timedOut": true,
        })
    }

    fn run_tool(
        app: &FakeApp,
        name: &str,
        args: Value,
    ) -> (Result<Value, String>, Vec<(u64, u64)>) {
        let cancelled = AtomicBool::new(false);
        let mut seen = Vec::new();
        let mut progress = |done: u64, total: u64| seen.push((done, total));
        let outcome = call_tool(
            &mut Call {
                app,
                clock: app.clock.as_ref(),
                cancelled: &cancelled,
                progress: &mut progress,
            },
            name,
            &args,
        );
        (outcome, seen)
    }

    #[test]
    fn it_answers_initialize_and_lists_the_tools() {
        let clock = Arc::new(FakeClock::default());
        let app = Arc::new(FakeApp::new(clock.clone(), |_, _, _| Ok(json!({}))));
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        let input = [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claude-code","version":"2"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"ping"}),
            json!({"jsonrpc":"2.0","id":4,"method":"resources/list"}),
            json!({"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
            + "\nnot json\n";
        serve(input.as_bytes(), out.clone(), app.clone(), clock, false);
        let lines: Vec<Value> = String::from_utf8(out.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 6, "a notification gets no answer: {lines:?}");
        assert_eq!(lines[0]["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(lines[0]["result"]["serverInfo"]["name"], "monocode");
        let names: Vec<&str> = lines[1]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "delegate_task",
                "task_status",
                "task_wait",
                "task_cancel",
                "task_answer",
                "pr_watch",
                "pr_unwatch",
                "pr_watches"
            ]
        );
        for tool in lines[1]["result"]["tools"].as_array().unwrap() {
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
        assert_eq!(lines[2]["result"], json!({}));
        assert_eq!(lines[3]["error"]["code"], -32601);
        assert_eq!(lines[4]["result"]["protocolVersion"], PROTOCOLS[0]);
        assert_eq!(lines[5]["error"]["code"], -32700);
        assert!(app.actions().is_empty(), "listing tools calls nothing");
    }

    #[test]
    fn an_async_delegation_is_one_app_call_with_the_client_request_id() {
        let clock = Arc::new(FakeClock::default());
        let app = FakeApp::new(clock, |action, _, _| {
            assert_eq!(action, "tasks.delegate");
            Ok(json!({ "taskId": "t-1", "childSessionId": "app-mono-exo-r1", "status": "running" }))
        });
        let (outcome, _) = run_tool(
            &app,
            "delegate_task",
            json!({
                "brief": "Fix the save bug",
                "asks": ["a_1"],
                "goal": "Saving works after a restart",
                "isolation": "worktree",
                "clientRequestId": "r1",
            }),
        );
        let out = outcome.unwrap();
        assert_eq!(out["taskId"], "t-1");
        assert_eq!(out["childSessionId"], "app-mono-exo-r1");
        assert_eq!(out["waitTimedOut"], false);
        assert!(out["note"].as_str().unwrap().contains("end your turn"));
        let calls = app.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].2, "r1", "the client's id is the app's request id");
        assert_eq!(
            calls[0].1,
            json!({
                "brief": "Fix the save bug",
                "asks": ["a_1"],
                "goal": "Saving works after a restart",
                "isolation": "worktree",
            }),
            "mode, timeoutMinutes and clientRequestId stay in the tool"
        );
    }

    #[test]
    fn a_lead_brief_passes_lead_and_when_busy_and_says_how_it_went_in() {
        let clock = Arc::new(FakeClock::default());
        let app = FakeApp::new(clock, |action, input, _| {
            assert_eq!(action, "tasks.delegate");
            assert_eq!(input["lead"], "hub", "the app resolves the Lead");
            assert_eq!(input["whenBusy"], "steer");
            Ok(json!({
                "taskId": "t-9",
                "childSessionId": "lead-chat",
                "status": "running",
                "delivery": "queued",
                "lead": "MonoCode Hub lead",
                "note": "Queued behind MonoCode Hub lead's current work."
            }))
        });
        let (outcome, _) = run_tool(
            &app,
            "delegate_task",
            json!({ "brief": "Ship the room", "lead": "hub", "whenBusy": "steer", "clientRequestId": "b1" }),
        );
        let out = outcome.unwrap();
        assert_eq!(
            (&out["taskId"], &out["delivery"], &out["lead"]),
            (&json!("t-9"), &json!("queued"), &json!("MonoCode Hub lead"))
        );
        assert_eq!(
            out["note"],
            "Queued behind MonoCode Hub lead's current work."
        );
    }

    #[test]
    fn a_wait_mode_delegation_waits_in_25_second_slices_then_reads_the_result_once() {
        let clock = Arc::new(FakeClock::default());
        let app = FakeApp::new(clock.clone(), |action, input, n| match action {
            "tasks.delegate" => {
                Ok(json!({ "taskId": "t-1", "childSessionId": "c", "status": "running" }))
            }
            "tasks.wait" if n < 4 => {
                assert_eq!(input["taskIds"], json!(["t-1"]));
                Ok(running(&["t-1"]))
            }
            "tasks.wait" => Ok(json!({
                "tasks": [{ "taskId": "t-1", "status": "completed" }],
                "settled": ["t-1"],
                "running": 0,
            })),
            "tasks.status" => {
                assert_eq!(input, &json!({ "taskIds": ["t-1"] }));
                Ok(
                    json!({ "tasks": [{ "taskId": "t-1", "childSessionId": "c", "status": "completed", "result": "Fixed: saves survive a restart", "hasPendingQuestion": false }] }),
                )
            }
            other => Err(format!("unexpected {other}")),
        });
        let (outcome, progress) = run_tool(
            &app,
            "delegate_task",
            json!({ "brief": "Fix it", "mode": "wait", "timeoutMinutes": 5 }),
        );
        let out = outcome.unwrap();
        assert_eq!(
            app.actions(),
            [
                "tasks.delegate",
                "tasks.wait",
                "tasks.wait",
                "tasks.wait",
                "tasks.status"
            ]
        );
        assert_eq!(app.waits(), [25, 25, 25]);
        assert_eq!(out["status"], "completed");
        assert_eq!(out["result"], "Fixed: saves survive a restart");
        assert_eq!(out["waitTimedOut"], false);
        assert_eq!(out["taskId"], "t-1");
        assert_eq!(progress, [(25, 300), (50, 300)]);
        assert_eq!(clock.now(), Duration::from_secs(50));
    }

    #[test]
    fn a_wait_runs_out_its_budget_in_slices_of_at_most_25_seconds() {
        let clock = Arc::new(FakeClock::default());
        let app = FakeApp::new(clock.clone(), |action, input, _| {
            assert_eq!(action, "tasks.wait");
            assert!(input["timeoutSeconds"].as_u64().unwrap() <= SLICE_SECONDS);
            Ok(running(&["t-1", "t-2"]))
        });
        let (outcome, _) = run_tool(&app, "task_wait", json!({ "timeoutMinutes": 1 }));
        let out = outcome.unwrap();
        assert_eq!(out["timedOut"], true);
        assert_eq!(
            app.waits(),
            [0, 25, 25, 10],
            "a snapshot, then 60 s in slices"
        );
        assert_eq!(clock.now(), Duration::from_secs(60));
        let budget = wait_budget(Some(&json!(60))).unwrap();
        assert_eq!(budget, Duration::from_secs(3600));
        assert!(wait_budget(Some(&json!(61))).is_err());
        assert!(wait_budget(Some(&json!(0))).is_err());
        assert_eq!(wait_budget(None).unwrap(), Duration::from_secs(600));
    }

    #[test]
    fn a_wait_ends_as_soon_as_a_task_asks_a_question_and_reports_every_task_asked_about() {
        let clock = Arc::new(FakeClock::default());
        let app = FakeApp::new(clock, |_, input, n| {
            Ok(match n {
                // The snapshot: t-done already finished, so only t-1 is waited on.
                1 => json!({
                    "tasks": [{ "taskId": "t-1", "status": "running" }, { "taskId": "t-done", "status": "completed" }],
                    "settled": ["t-done"], "running": 1,
                }),
                2 => {
                    assert_eq!(input["taskIds"], json!(["t-1"]));
                    running(&["t-1"])
                }
                3 => {
                    json!({ "tasks": [{ "taskId": "t-1", "status": "question", "hasPendingQuestion": true }], "settled": ["t-1"], "running": 0 })
                }
                _ => json!({
                    "tasks": [{ "taskId": "t-1", "status": "question" }, { "taskId": "t-done", "status": "completed" }],
                    "settled": ["t-1", "t-done"], "running": 0,
                }),
            })
        });
        let (outcome, _) = run_tool(&app, "task_wait", json!({ "taskIds": ["t-1", "t-done"] }));
        let out = outcome.unwrap();
        assert_eq!(app.waits(), [0, 25, 25, 0]);
        assert_eq!(out["timedOut"], false);
        assert_eq!(out["settled"], json!(["t-1"]));
        assert_eq!(out["tasks"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_wait_with_nothing_running_returns_at_once() {
        let clock = Arc::new(FakeClock::default());
        let app = FakeApp::new(clock.clone(), |_, _, _| {
            Ok(json!({ "tasks": [], "settled": [], "running": 0 }))
        });
        let (outcome, _) = run_tool(&app, "task_wait", json!({}));
        assert_eq!(outcome.unwrap()["timedOut"], false);
        assert_eq!(app.waits(), [0]);
        assert_eq!(clock.now(), Duration::ZERO);
    }

    #[test]
    fn a_refusal_from_the_app_is_the_tool_error_and_ends_the_wait() {
        const INACTIVE: &str = "MonoCode app access is inactive. Use /operator once in this thread to enable it, then call the CLI during an active agent turn. Retrying this request now will not enable access.";
        let clock = Arc::new(FakeClock::default());
        let app = FakeApp::new(clock, |action, _, n| match (action, n) {
            ("tasks.delegate", _) => Ok(json!({ "taskId": "t-1", "childSessionId": "c" })),
            ("tasks.wait", 2) => Ok(running(&["t-1"])),
            _ => Err(INACTIVE.into()),
        });
        let (outcome, _) = run_tool(
            &app,
            "delegate_task",
            json!({ "brief": "x", "mode": "wait" }),
        );
        assert_eq!(outcome.unwrap_err(), INACTIVE);
        assert_eq!(
            app.actions(),
            ["tasks.delegate", "tasks.wait", "tasks.wait"]
        );
        // Through the protocol, a refusal is a tool result marked as an error, not a protocol failure.
        let result = tool_result(Err("Only a Mono's own chat can delegate tasks.".into()));
        assert_eq!(result["isError"], true);
        assert_eq!(
            result["content"][0]["text"],
            "Only a Mono's own chat can delegate tasks."
        );
    }

    #[test]
    fn bad_arguments_are_refused_before_anything_is_called() {
        let clock = Arc::new(FakeClock::default());
        let app = FakeApp::new(clock, |_, _, _| Ok(json!({})));
        for (tool, args) in [
            ("delegate_task", json!({ "brief": "x", "prompt": "y" })),
            ("delegate_task", json!({ "brief": "x", "mode": "sync" })),
            (
                "delegate_task",
                json!({ "brief": "x", "timeoutMinutes": 61 }),
            ),
            (
                "delegate_task",
                json!({ "brief": "x", "clientRequestId": "bad id" }),
            ),
            ("delegate_task", json!(["brief"])),
            ("task_status", json!({ "taskId": "t-1" })),
            ("task_wait", json!({ "timeoutMinutes": "5" })),
            ("task_cancel", json!({ "taskId": "t-1", "cascade": true })),
            ("task_answer", json!({ "taskId": "t-1", "answer": "yes" })),
            ("sessions_start", json!({})),
        ] {
            let (outcome, _) = run_tool(&app, tool, args.clone());
            assert!(outcome.is_err(), "{tool} {args}");
        }
        assert!(app.actions().is_empty());
    }

    #[test]
    fn a_cancelled_call_stops_waiting() {
        let clock = Arc::new(FakeClock::default());
        let app = FakeApp::new(clock.clone(), |_, _, _| Ok(running(&["t-1"])));
        let cancelled = AtomicBool::new(false);
        let mut slices = 0;
        let mut progress = |_: u64, _: u64| {
            slices += 1;
            if slices == 2 {
                cancelled.store(true, Ordering::SeqCst);
            }
        };
        let outcome = wait_slices(
            &mut Call {
                app: &app,
                clock: clock.as_ref(),
                cancelled: &cancelled,
                progress: &mut progress,
            },
            &["t-1".into()],
            Duration::from_secs(3600),
        );
        assert_eq!(outcome.unwrap_err(), "Cancelled.");
        assert_eq!(app.waits(), [25, 25]);
    }

    #[test]
    fn an_early_answer_without_news_never_becomes_a_busy_loop() {
        let clock = Arc::new(FakeClock::default());
        let mut app = FakeApp::new(clock.clone(), |_, _, _| Ok(running(&["t-1"])));
        app.waits_take_time = false;
        let (outcome, _) = run_tool(&app, "task_wait", json!({ "timeoutMinutes": 1 }));
        assert_eq!(outcome.unwrap()["timedOut"], true);
        assert!(app.waits().len() <= 61, "{} calls", app.waits().len());
    }

    #[test]
    fn the_connection_must_be_expanded_and_its_token_is_never_echoed() {
        let env = |token: Option<&'static str>| {
            move |key: &str| match key {
                "MONOCODE_APP_ENDPOINT" => Some("127.0.0.1:4000".to_string()),
                _ => token.map(str::to_string),
            }
        };
        assert!(connection(env(Some("abc123secret"))).is_ok());
        for token in [None, Some(""), Some("${MONOCODE_APP_TOKEN}")] {
            let error = connection(env(token)).unwrap_err();
            assert_eq!(error, NO_CONNECTION);
            assert!(!error.contains("abc123secret"));
        }
    }

    #[test]
    fn a_progress_token_gets_progress_notifications_while_a_tool_waits() {
        let clock = Arc::new(FakeClock::default());
        let app = Arc::new(FakeApp::new(clock.clone(), |_, _, n| {
            Ok(if n < 3 {
                running(&["t-1"])
            } else {
                json!({ "tasks": [{ "taskId": "t-1", "status": "completed" }], "settled": ["t-1"], "running": 0 })
            })
        }));
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        let call = json!({"jsonrpc":"2.0","id":"c1","method":"tools/call","params":{"name":"task_wait","arguments":{},"_meta":{"progressToken":"p1"}}});
        serve(
            format!("{call}\n").as_bytes(),
            out.clone(),
            app,
            clock,
            false,
        );
        let lines: Vec<Value> = String::from_utf8(out.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines[0]["method"], "notifications/progress");
        assert_eq!(lines[0]["params"]["progressToken"], "p1");
        let last = lines.last().unwrap();
        assert_eq!(last["id"], "c1");
        assert_eq!(last["result"]["isError"], false);
        let text: Value =
            serde_json::from_str(last["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text["settled"], json!(["t-1"]));
    }
}
