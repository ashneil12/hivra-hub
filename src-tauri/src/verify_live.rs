//! The fake-Claude test bench's way in (Phase 1b WP5, `scripts/hub-verify-live.mjs`).
//!
//! A **dev copy running under a temporary HOME** that is started with `MONOCODE_VERIFY_LIVE=<plan.json>` reads one
//! plan: the fake Claude CLI to run instead of the installed one (`scripts/fake-claude.mjs` behind a `claude`
//! wrapper), auto-resume switched on so a restart midway is exercised like the daily app's, and a kickoff the window
//! sends once (a Mono on a scratch project, and its first message; or, with `monoId`, an existing Mono such as the
//! built-in Chief of Staff, once it works on that project). Nothing else changes.
//!
//! The daily app never reads it, and neither does a dev copy on the real HOME: both conditions are checked before the
//! file is opened, so a stray variable can't point a real copy at a fake Claude.
//!
//! The real-Claude bench (`scripts/hub-realtest.mjs`, docs/REALTEST.md) adds a `driver` folder: the run drops Ash's
//! scripted actions into `<driver>/inbox/*.json` (a message to the leadership room, to a Lead or a worker, a stop, a
//! snapshot of what the window shows), the window takes them one at a time with [`verify_live_take`] and does each
//! through the same calls Ash's typing and clicks use, then answers with [`verify_live_done`] into `<driver>/done/`.
//! Both commands refuse unless this process has a plan with a driver, so only that dev copy ever has them.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::instance::{Identity, Kind};

pub const PLAN_ENV: &str = "MONOCODE_VERIFY_LIVE";
const PLAN_MAX_BYTES: u64 = 64 * 1024;
const PROMPT_MAX: usize = 20_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Kickoff {
    /// The scratch project the Mono works on (an absolute folder).
    pub project: String,
    pub mono_name: String,
    pub prompt: String,
    /// Open this existing Mono (a built-in team Mono, e.g. `chief-of-staff`) instead of making one: the window waits
    /// until it works on `project`, then sends `prompt` in its chat. `monoName` is then only a label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mono_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub version: u32,
    pub run_id: String,
    /// An absolute path to an executable named `claude` (the configured-binary rules in harness.rs still apply).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_binary: Option<String>,
    #[serde(default)]
    pub auto_resume: bool,
    /// Let this dev copy send `/goal` (a dev copy never does: it runs Claude with hooks off, and the real CLI refuses
    /// it then). Only with `claudeBinary`, so only ever to the fake Claude, which keeps a goal the way 2.1.302 does.
    #[serde(default)]
    pub goals: bool,
    /// How long a worker may be silent before the window marks it stalled (monos/model/workerStall.ts), so the bench
    /// sees a stall in seconds instead of minutes. 1 s to 10 min.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kickoff: Option<Kickoff>,
    /// The real-Claude bench's action folder (absolute, existing): `inbox/` in, `taken/` and `done/` out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
}

fn valid_run_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Parse and check a plan. Every path must be absolute; the kickoff's project must exist.
pub fn parse(text: &str) -> Result<Plan, String> {
    let plan: Plan = serde_json::from_str(text).map_err(|e| format!("verify plan: {e}"))?;
    if plan.version != 1 {
        return Err(format!("verify plan: version {} is not 1", plan.version));
    }
    if !valid_run_id(&plan.run_id) {
        return Err("verify plan: runId must be 1-64 letters, digits, '.', '_' or '-'".into());
    }
    if let Some(binary) = &plan.claude_binary {
        let path = Path::new(binary);
        if !path.is_absolute() || path.file_name().and_then(|name| name.to_str()) != Some("claude")
        {
            return Err(
                "verify plan: claudeBinary must be an absolute path to a file named claude".into(),
            );
        }
    }
    if let Some(driver) = &plan.driver {
        if !Path::new(driver).is_absolute() || !Path::new(driver).is_dir() {
            return Err("verify plan: driver must be an existing absolute folder".into());
        }
    }
    if plan.goals && plan.claude_binary.is_none() {
        return Err(
            "verify plan: goals needs claudeBinary (only the fake Claude gets /goal)".into(),
        );
    }
    if plan
        .stall_ms
        .is_some_and(|ms| !(1_000..=600_000).contains(&ms))
    {
        return Err("verify plan: stallMs must be 1000-600000".into());
    }
    if let Some(kickoff) = &plan.kickoff {
        if !Path::new(&kickoff.project).is_absolute() || !Path::new(&kickoff.project).is_dir() {
            return Err("verify plan: kickoff.project must be an existing absolute folder".into());
        }
        if kickoff.prompt.trim().is_empty() || kickoff.prompt.len() > PROMPT_MAX {
            return Err(format!(
                "verify plan: kickoff.prompt must be 1-{PROMPT_MAX} characters"
            ));
        }
        let name = kickoff.mono_name.trim();
        if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
            return Err("verify plan: kickoff.monoName must be one line of 1-60 characters".into());
        }
        if let Some(id) = &kickoff.mono_id {
            if id.is_empty()
                || id.len() > 64
                || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return Err(
                    "verify plan: kickoff.monoId must be 1-64 letters, digits or '-'".into(),
                );
            }
        }
    }
    Ok(plan)
}

/// Whether this copy may read a plan at all: a dev copy, under a temporary HOME.
pub fn allowed(identity: &Identity, isolated_home: Option<&Path>) -> bool {
    identity.kind == Kind::Dev && isolated_home.is_some()
}

fn read(path: &Path) -> Result<Plan, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("verify plan: {e}"))?;
    if metadata.len() > PLAN_MAX_BYTES {
        return Err("verify plan: the file is too large".into());
    }
    parse(&std::fs::read_to_string(path).map_err(|e| format!("verify plan: {e}"))?)
}

static PLAN: OnceLock<Option<Plan>> = OnceLock::new();

/// This process's plan, or none (the daily app, a dev copy on the real HOME, no variable, or a plan that doesn't
/// parse: that one is reported on stderr and ignored).
pub fn plan() -> Option<&'static Plan> {
    PLAN.get_or_init(|| {
        let path = std::env::var_os(PLAN_ENV).map(PathBuf::from)?;
        if !allowed(crate::instance::current(), crate::instance::isolated_home()) {
            eprintln!(
                "monocode: {PLAN_ENV} ignored: only a dev copy under a temporary HOME reads it"
            );
            return None;
        }
        match read(&path) {
            Ok(plan) => Some(plan),
            Err(error) => {
                eprintln!("monocode: {error}");
                None
            }
        }
    })
    .as_ref()
}

/// The plan as the window sees it (`window.__MONOCODE_APP__.verify`).
pub fn window_info(plan: &Plan) -> Value {
    let mut info = serde_json::json!({
        "runId": plan.run_id,
        "kickoff": plan.kickoff,
    });
    if plan.goals {
        info["goals"] = Value::Bool(true);
    }
    if let Some(ms) = plan.stall_ms {
        info["stallMs"] = Value::from(ms);
    }
    if plan.driver.is_some() {
        info["driver"] = Value::Bool(true);
    }
    info
}

const ACTION_MAX_BYTES: u64 = 256 * 1024;

fn valid_action_id(id: &str) -> bool {
    valid_run_id(id)
}

/// The next action file in `<driver>/inbox` (by name), moved to `<driver>/taken` and parsed; `None` when the inbox is
/// empty. A file that isn't JSON is moved aside and answered with `{"id","error"}` so the run hears about it.
pub fn take_from(driver: &Path) -> Result<Option<Value>, String> {
    let inbox = driver.join("inbox");
    let taken = driver.join("taken");
    let mut names: Vec<String> = match std::fs::read_dir(&inbox) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .filter(|name| name.ends_with(".json") && !name.starts_with('.'))
            .collect(),
        Err(_) => return Ok(None),
    };
    names.sort();
    let Some(name) = names.into_iter().next() else {
        return Ok(None);
    };
    std::fs::create_dir_all(&taken).map_err(|e| format!("verify driver: {e}"))?;
    let from = inbox.join(&name);
    let to = taken.join(&name);
    std::fs::rename(&from, &to).map_err(|e| format!("verify driver: {e}"))?;
    let size = std::fs::metadata(&to).map(|m| m.len()).unwrap_or(0);
    let stem = name.trim_end_matches(".json").to_string();
    if size > ACTION_MAX_BYTES {
        return Ok(Some(
            serde_json::json!({ "id": stem, "error": "action file too large" }),
        ));
    }
    let text = std::fs::read_to_string(&to).map_err(|e| format!("verify driver: {e}"))?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(mut action)) => {
            action
                .entry("id")
                .or_insert_with(|| Value::String(stem.clone()));
            Ok(Some(Value::Object(action)))
        }
        _ => Ok(Some(
            serde_json::json!({ "id": stem, "error": "action is not a JSON object" }),
        )),
    }
}

/// Write an action's answer as `<driver>/done/<id>.json` (whole, through a temporary name).
pub fn done_into(driver: &Path, id: &str, result: &Value) -> Result<(), String> {
    if !valid_action_id(id) {
        return Err("verify driver: bad action id".into());
    }
    let done = driver.join("done");
    std::fs::create_dir_all(&done).map_err(|e| format!("verify driver: {e}"))?;
    let tmp = done.join(format!(".{id}.tmp"));
    let text = serde_json::to_string_pretty(result).map_err(|e| format!("verify driver: {e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("verify driver: {e}"))?;
    std::fs::rename(&tmp, done.join(format!("{id}.json")))
        .map_err(|e| format!("verify driver: {e}"))
}

fn driver_dir() -> Result<PathBuf, String> {
    plan()
        .and_then(|plan| plan.driver.as_ref())
        .map(PathBuf::from)
        .ok_or_else(|| "verify driver: this copy has no driver".into())
}

/// The real-Claude bench: the window's next scripted action, or null.
#[tauri::command]
pub fn verify_live_take() -> Result<Option<Value>, String> {
    take_from(&driver_dir()?)
}

/// The real-Claude bench: the window's answer to an action.
#[tauri::command]
pub fn verify_live_done(id: String, result: Value) -> Result<(), String> {
    done_into(&driver_dir()?, &id, &result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(kind: Kind) -> Identity {
        Identity {
            kind,
            identifier: match kind {
                Kind::Daily => crate::instance::DAILY_IDENTIFIER.into(),
                Kind::Dev => format!("{}verify", crate::instance::DEV_IDENTIFIER_PREFIX),
            },
            slot: (kind == Kind::Dev).then(|| "verify".into()),
        }
    }

    #[test]
    fn only_a_dev_copy_under_a_temporary_home_reads_a_plan() {
        let temp = Path::new("/tmp/verify-home");
        assert!(allowed(&identity(Kind::Dev), Some(temp)));
        assert!(!allowed(&identity(Kind::Dev), None));
        assert!(!allowed(&identity(Kind::Daily), Some(temp)));
        assert!(!allowed(&identity(Kind::Daily), None));
    }

    #[test]
    fn parses_a_plan_and_refuses_a_bad_one() {
        let project = std::env::temp_dir();
        let project = project.to_str().unwrap();
        let good = format!(
            r#"{{"version":1,"runId":"20261019-a1","claudeBinary":"/tmp/run/bin/claude","autoResume":true,
               "kickoff":{{"project":"{project}","monoName":"Verify Lead","prompt":"VERIFY-LEAD-KICKOFF"}}}}"#
        );
        let plan = parse(&good).unwrap();
        assert!(plan.auto_resume);
        assert!(!plan.goals);
        assert!(window_info(&plan).get("goals").is_none());
        let goals =
            parse(r#"{"version":1,"runId":"a","claudeBinary":"/tmp/run/bin/claude","goals":true}"#)
                .unwrap();
        assert!(goals.goals);
        assert_eq!(window_info(&goals)["goals"], true);
        assert!(window_info(&plan).get("stallMs").is_none());
        let stall = parse(r#"{"version":1,"runId":"a","stallMs":10000}"#).unwrap();
        assert_eq!(window_info(&stall)["stallMs"], 10_000);
        assert_eq!(plan.kickoff.as_ref().unwrap().mono_name, "Verify Lead");
        assert_eq!(window_info(&plan)["runId"], "20261019-a1");
        assert_eq!(plan.kickoff.as_ref().unwrap().mono_id, None);
        assert!(window_info(&plan)["kickoff"].get("monoId").is_none());

        // An existing Mono (the built-in Chief of Staff) instead of a new one.
        let team = parse(&format!(
            r#"{{"version":1,"runId":"20261019-a1-tree","kickoff":{{"project":"{project}","monoName":"Chief of Staff",
               "monoId":"chief-of-staff","prompt":"VERIFY-TREE-KICKOFF"}}}}"#
        ))
        .unwrap();
        assert_eq!(
            team.kickoff.as_ref().unwrap().mono_id.as_deref(),
            Some("chief-of-staff")
        );
        assert_eq!(window_info(&team)["kickoff"]["monoId"], "chief-of-staff");

        let cases = [
            (r#"{"version":2,"runId":"a"}"#.to_string(), "version"),
            (r#"{"version":1,"runId":"a b"}"#.to_string(), "runId"),
            (
                r#"{"version":1,"runId":"a","claudeBinary":"claude"}"#.to_string(),
                "claudeBinary",
            ),
            (
                r#"{"version":1,"runId":"a","claudeBinary":"/usr/bin/true"}"#.to_string(),
                "claudeBinary",
            ),
            (
                r#"{"version":1,"runId":"a","kickoff":{"project":"/no/such/folder","monoName":"x","prompt":"y"}}"#
                    .to_string(),
                "project",
            ),
            (
                format!(r#"{{"version":1,"runId":"a","kickoff":{{"project":"{project}","monoName":"x","prompt":"  "}}}}"#),
                "prompt",
            ),
            (
                format!(r#"{{"version":1,"runId":"a","kickoff":{{"project":"{project}","monoName":"x","prompt":"y","monoId":"no such/id"}}}}"#),
                "monoId",
            ),
            (r#"{"version":1,"runId":"a","goals":true}"#.to_string(), "goals"),
            (r#"{"version":1,"runId":"a","stallMs":5}"#.to_string(), "stallMs"),
            (
                r#"{"version":1,"runId":"a","driver":"/no/such/folder"}"#.to_string(),
                "driver",
            ),
            (r#"{"version":1,"runId":"a","extra":1}"#.to_string(), "unknown field"),
        ];
        for (text, expected) in cases {
            let error = parse(&text).unwrap_err();
            assert!(error.contains(expected), "{text}: {error}");
        }
    }

    #[test]
    fn a_driver_folder_hands_over_actions_in_order_and_takes_answers() {
        let root = std::env::temp_dir().join(format!("verify-driver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("inbox")).unwrap();
        let driver = root.to_str().unwrap().to_string();
        let plan = parse(&format!(
            r#"{{"version":1,"runId":"a","driver":"{driver}"}}"#
        ))
        .unwrap();
        assert_eq!(plan.driver.as_deref(), Some(driver.as_str()));
        assert_eq!(window_info(&plan)["driver"], true);
        assert!(window_info(&parse(r#"{"version":1,"runId":"a"}"#).unwrap())
            .get("driver")
            .is_none());

        assert_eq!(take_from(&root).unwrap(), None);
        std::fs::write(root.join("inbox/002-b.json"), r#"{"op":"snapshot"}"#).unwrap();
        std::fs::write(
            root.join("inbox/001-a.json"),
            r#"{"id":"first","op":"send"}"#,
        )
        .unwrap();
        std::fs::write(root.join("inbox/003-c.json"), "not json").unwrap();
        let first = take_from(&root).unwrap().unwrap();
        assert_eq!(first["id"], "first");
        let second = take_from(&root).unwrap().unwrap();
        assert_eq!(second["id"], "002-b");
        assert_eq!(second["op"], "snapshot");
        let third = take_from(&root).unwrap().unwrap();
        assert!(third["error"].as_str().unwrap().contains("JSON"));
        assert_eq!(take_from(&root).unwrap(), None);
        assert!(root.join("taken/001-a.json").is_file());

        done_into(&root, "first", &serde_json::json!({"ok": true})).unwrap();
        let answer: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("done/first.json")).unwrap())
                .unwrap();
        assert_eq!(answer["ok"], true);
        assert!(done_into(&root, "../escape", &Value::Null).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
