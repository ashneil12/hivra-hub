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
    /// Open this existing Mono instead of making one: the window waits until it works on `project`, then sends
    /// `prompt` in its chat. `monoName` is then only a label.
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
    /// The bench's Claude Code runs on DeepSeek through the local gateway launcher (scripts/hub-realtest.mjs
    /// `--deepseek-sub`): no Claude sign-in holds its workers back, as when Ash's CLI path is `claude-deepseek`.
    /// Only with `claudeBinary`.
    #[serde(default)]
    pub deepseek: bool,
    /// The bench's Claude Code runs on some other launcher of Ash's (`--agents grok-sub`, `--agents openrouter-sub`).
    /// No Claude sign-in holds workers, and models are not rewritten to DeepSeek. Only with `claudeBinary`.
    #[serde(default)]
    pub launcher: bool,
    /// Old plans set this for a launcher this app no longer runs. Parsed so those plans still start, then ignored.
    #[serde(default, rename = "grok", skip_serializing)]
    pub retired_bridge: bool,
    /// How long a worker may be silent before the window marks it stalled (monos/model/workerStall.ts), so the bench
    /// sees a stall in seconds instead of minutes. 1 s to 10 min.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kickoff: Option<Kickoff>,
    /// The real-Claude bench's action folder (absolute, existing): `inbox/` in, `taken/` and `done/` out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
    /// Hub projects this copy's local store starts with (`{id, name, folder}`), added once (WP-04: the bench's projects
    /// used to come from the Ash OS stub).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<Value>,
    /// An absolute path to a JSON list of Ash's messages the bench sends mid-run (`[{id, monoId, prompt, ...}]`);
    /// the window reads it with [`verify_live_messages`] and sends each once. A missing file is an empty list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<String>,
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
    if plan.deepseek && plan.claude_binary.is_none() {
        return Err(
            "verify plan: deepseek needs claudeBinary (the bench's Claude on the launcher)".into(),
        );
    }
    if plan.launcher && plan.claude_binary.is_none() {
        return Err(
            "verify plan: launcher needs claudeBinary (the bench's Claude on the launcher)".into(),
        );
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
    if plan.projects.len() > 50
        || plan.projects.iter().any(|project| {
            !project
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(valid_run_id)
                || !project.get("name").is_some_and(Value::is_string)
        })
    {
        return Err("verify plan: projects must be at most 50 {id, name, folder?}".into());
    }
    if plan
        .messages
        .as_ref()
        .is_some_and(|path| !Path::new(path).is_absolute())
    {
        return Err("verify plan: messages must be an absolute path".into());
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

/// Collapse `.` and `..` without touching the filesystem. A relative path, or one that climbs past the root, is none:
/// it is not the plan's wrapper, whatever PATH would make of it.
fn lexical_absolute(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            other => out.push(other),
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn provider_label(provider: Option<&str>, command: &str) -> String {
    if let Some(name) = provider.map(str::trim).filter(|name| !name.is_empty()) {
        return name.to_string();
    }
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("that CLI")
        .to_string()
}

/// A bench starts no agent CLI except the wrapper path the plan names. No plan: unchanged. The decision is the path
/// itself, not PATH and not the file's name.
pub fn provider_start_allowed(
    plan: Option<&Plan>,
    provider: Option<&str>,
    command: &str,
) -> Result<(), String> {
    let Some(plan) = plan else {
        return Ok(());
    };
    let allowed = plan.claude_binary.as_deref().and_then(lexical_absolute);
    if allowed.is_some() && lexical_absolute(command) == allowed {
        return Ok(());
    }
    Err(format!(
        "This bench only starts the run's own Claude wrapper. It won't start {}.",
        provider_label(provider, command)
    ))
}

/// `<isolated home>/tmp`. Never the real home, and never `/`. A missing real home is still refused when `home` is
/// inside it; the caller only uses this once the process is already on an isolated home.
pub fn run_temp_dir(home: &Path, real_home: Option<&Path>) -> Option<PathBuf> {
    if home.as_os_str().is_empty() || home == Path::new("/") {
        return None;
    }
    if real_home.is_some_and(|real| home == real || home.starts_with(real)) {
        return None;
    }
    Some(home.join("tmp"))
}

/// Point this bench's process at [`run_temp_dir`]. A failed create leaves the variables alone, so they are not aimed
/// at a directory that isn't there. No plan, or the daily app: nothing changes.
pub fn install_run_tmpdir() {
    if plan().is_none() {
        return;
    }
    let Some(home) = crate::instance::isolated_home() else {
        return;
    };
    let Some(dir) = run_temp_dir(home, crate::instance::real_home().as_deref()) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    for key in ["TMPDIR", "TMP", "TEMP", "CLAUDE_TMPDIR"] {
        std::env::set_var(key, &dir);
    }
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
    if plan.deepseek {
        info["deepseek"] = Value::Bool(true);
    }
    if plan.launcher {
        info["launcher"] = Value::Bool(true);
    }
    if !plan.projects.is_empty() {
        info["projects"] = Value::Array(plan.projects.clone());
    }
    info
}

const MESSAGES_MAX_BYTES: u64 = 1024 * 1024;

/// The bench's mid-run messages from `path`: a JSON list, empty when the file isn't there yet.
pub fn messages_from(path: &Path) -> Result<Vec<Value>, String> {
    match std::fs::metadata(path) {
        Err(_) => return Ok(Vec::new()),
        Ok(meta) if meta.len() > MESSAGES_MAX_BYTES => {
            return Err("verify messages: the file is too large".into())
        }
        Ok(_) => {}
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("verify messages: {e}"))?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(list)) => Ok(list.into_iter().filter(Value::is_object).collect()),
        _ => Err("verify messages: not a JSON list".into()),
    }
}

/// The fake-Claude bench: Ash's messages to send mid-run (the plan's `messages` file), or none without one.
#[tauri::command]
pub fn verify_live_messages() -> Result<Vec<Value>, String> {
    match plan().and_then(|plan| plan.messages.as_ref()) {
        Some(path) => messages_from(Path::new(path)),
        None => Ok(Vec::new()),
    }
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

/// The real-Claude bench (r98, B5): Ash's Quit, the very path the app menu's "Quit Hivra" takes
/// ([`crate::window::request_quit`]: the windows save, a busy chat still asks). Only a copy with a driver.
#[tauri::command]
pub fn verify_live_quit(app: tauri::AppHandle) -> Result<(), String> {
    driver_dir()?;
    crate::window::request_quit(&app);
    Ok(())
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

    /// An absolute path to a file named claude on this platform (`/tmp/...` isn't absolute on Windows).
    fn claude_path() -> String {
        std::env::temp_dir()
            .join("run")
            .join("bin")
            .join("claude")
            .to_string_lossy()
            .into_owned()
    }

    /// A plan written with `/tmp/run/bin/claude`, with [`claude_path`] in its place.
    fn with_claude(text: &str) -> String {
        text.replace(
            r#""/tmp/run/bin/claude""#,
            &serde_json::to_string(&claude_path()).unwrap(),
        )
    }

    /// `path` as it goes between a JSON string's quotes.
    fn json_text(path: &Path) -> String {
        let quoted = serde_json::to_string(&path.to_string_lossy()).unwrap();
        quoted[1..quoted.len() - 1].to_string()
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
    fn an_old_plan_that_names_the_retired_bridge_still_runs_as_plain_claude() {
        let plan = parse(&with_claude(
            r#"{"version":1,"runId":"a","claudeBinary":"/tmp/run/bin/claude","grok":true}"#,
        ))
        .unwrap();
        assert!(plan.retired_bridge);
        assert!(window_info(&plan).get("grok").is_none());
        assert!(!plan.deepseek);
    }

    #[test]
    fn a_bench_on_the_deepseek_bridge_says_so_to_the_window() {
        let plan = parse(&with_claude(
            r#"{"version":1,"runId":"a","claudeBinary":"/tmp/run/bin/claude","deepseek":true}"#,
        ))
        .unwrap();
        assert!(plan.deepseek);
        assert_eq!(window_info(&plan)["deepseek"], true);
        assert!(window_info(&plan).get("grok").is_none());
        assert!(parse(r#"{"version":1,"runId":"a","deepseek":true}"#)
            .unwrap_err()
            .contains("deepseek"));
    }

    #[test]
    fn a_bench_on_a_gateway_launcher_says_so_without_calling_it_deepseek() {
        let plan = parse(&with_claude(
            r#"{"version":1,"runId":"a","claudeBinary":"/tmp/run/bin/claude","launcher":true}"#,
        ))
        .unwrap();
        assert!(plan.launcher);
        assert!(!plan.deepseek);
        assert!(!plan.retired_bridge);
        assert_eq!(window_info(&plan)["launcher"], true);
        assert!(window_info(&plan).get("deepseek").is_none());
        assert!(window_info(&plan).get("grok").is_none());
        assert!(parse(r#"{"version":1,"runId":"a","launcher":true}"#)
            .unwrap_err()
            .contains("launcher"));
    }

    #[test]
    fn parses_a_plan_and_refuses_a_bad_one() {
        // Paths go into the JSON escaped: a Windows path's backslashes aren't JSON escapes.
        let project = json_text(&std::env::temp_dir());
        let claude = serde_json::to_string(&claude_path()).unwrap();
        let good = format!(
            r#"{{"version":1,"runId":"20261019-a1","claudeBinary":{claude},"autoResume":true,
               "kickoff":{{"project":"{project}","monoName":"Verify Lead","prompt":"VERIFY-LEAD-KICKOFF"}}}}"#
        );
        let plan = parse(&good).unwrap();
        assert!(plan.auto_resume);
        assert!(!plan.goals);
        assert!(window_info(&plan).get("goals").is_none());
        let goals = parse(&with_claude(
            r#"{"version":1,"runId":"a","claudeBinary":"/tmp/run/bin/claude","goals":true}"#,
        ))
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

        // An existing Mono, named by its id, instead of a new one.
        let team = parse(&format!(
            r#"{{"version":1,"runId":"20261019-a1-tree","kickoff":{{"project":"{project}","monoName":"Chief of Staff",
               "monoId":"ada","prompt":"VERIFY-TREE-KICKOFF"}}}}"#
        ))
        .unwrap();
        assert_eq!(
            team.kickoff.as_ref().unwrap().mono_id.as_deref(),
            Some("ada")
        );
        assert_eq!(window_info(&team)["kickoff"]["monoId"], "ada");

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
            r#"{{"version":1,"runId":"a","driver":"{}"}}"#,
            json_text(&root)
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

    #[test]
    fn projects_and_messages_come_from_the_plan() {
        // An absolute path on every platform ("/tmp/m.json" isn't one on Windows).
        let messages = std::env::temp_dir().join("m.json");
        let plan = parse(
            &serde_json::json!({
                "version": 1,
                "runId": "r1",
                "projects": [{"id": "verify-tree", "name": "Verify tree", "folder": "/tmp/x"}],
                "messages": messages,
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(window_info(&plan)["projects"][0]["id"], "verify-tree");
        assert!(parse(r#"{"version":1,"runId":"r1","messages":"rel.json"}"#).is_err());
        assert!(parse(r#"{"version":1,"runId":"r1","projects":[{"name":"no id"}]}"#).is_err());
        let dir = std::env::temp_dir().join(format!("verify-messages-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("messages.json");
        assert!(messages_from(&file).unwrap().is_empty());
        std::fs::write(&file, r#"[{"id":"m1","monoId":"ed","prompt":"hi"}, 3]"#).unwrap();
        let list = messages_from(&file).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "m1");
        std::fs::write(&file, "{}").unwrap();
        assert!(messages_from(&file).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn plan_naming(binary: &str) -> Plan {
        parse(
            &serde_json::json!({
                "version": 1,
                "runId": "a",
                "claudeBinary": binary,
            })
            .to_string(),
        )
        .unwrap()
    }

    fn foreign(provider: &str) -> String {
        std::env::temp_dir()
            .join("not-the-wrapper")
            .join(provider)
            .to_string_lossy()
            .into_owned()
    }

    macro_rules! refuses_provider {
        ($name:ident, $provider:literal) => {
            #[test]
            fn $name() {
                let plan = plan_naming(&claude_path());
                let command = foreign($provider);
                let refused =
                    provider_start_allowed(Some(&plan), Some($provider), &command).unwrap_err();
                // The exact words: src/features/crew/model/benchCli.ts refuses the same start in the window.
                assert_eq!(
                    refused,
                    format!(
                        "This bench only starts the run's own Claude wrapper. It won't start {}.",
                        $provider
                    )
                );
                assert!(provider_start_allowed(None, Some($provider), &command).is_ok());
            }
        };
    }

    refuses_provider!(a_bench_refuses_to_start_claude_except_the_wrapper, "claude");
    refuses_provider!(a_bench_refuses_to_start_codex, "codex");
    refuses_provider!(a_bench_refuses_to_start_cursor, "cursor");
    refuses_provider!(a_bench_refuses_to_start_grok, "grok");
    refuses_provider!(a_bench_refuses_to_start_opencode, "opencode");
    refuses_provider!(a_bench_refuses_to_start_pi, "pi");
    refuses_provider!(a_bench_refuses_to_start_omp, "omp");
    refuses_provider!(a_bench_refuses_to_start_fx, "fx");
    refuses_provider!(a_bench_refuses_to_start_hermes, "hermes");
    refuses_provider!(a_bench_refuses_to_start_antigravity, "antigravity");
    refuses_provider!(a_bench_refuses_to_start_devin, "devin");

    #[test]
    fn a_bench_allows_only_the_plans_wrapper_path() {
        let wrapper = claude_path();
        let plan = plan_naming(&wrapper);
        assert!(provider_start_allowed(Some(&plan), Some("claude"), &wrapper).is_ok());
        let other = std::env::temp_dir().join("other").join("claude");
        assert!(
            provider_start_allowed(Some(&plan), Some("claude"), &other.to_string_lossy()).is_err()
        );
        let path = PathBuf::from(&wrapper);
        let run = path.parent().unwrap().parent().unwrap();
        let dotted = run.join("bin").join("..").join("bin").join("claude");
        assert!(
            provider_start_allowed(Some(&plan), Some("claude"), &dotted.to_string_lossy()).is_ok()
        );
        let escaped = run.join("..").join("elsewhere").join("claude");
        assert!(
            provider_start_allowed(Some(&plan), Some("claude"), &escaped.to_string_lossy())
                .is_err()
        );
        assert!(provider_start_allowed(Some(&plan), Some("codex"), "codex").is_err());
        assert!(provider_start_allowed(None, Some("codex"), "codex").is_ok());
        let bare = parse(r#"{"version":1,"runId":"a"}"#).unwrap();
        assert!(provider_start_allowed(Some(&bare), Some("claude"), &wrapper).is_err());
    }

    #[test]
    fn a_bench_temp_dir_stays_inside_the_isolated_home() {
        let home = Path::new("/tmp/bench/home");
        let real = Path::new("/Users/ash");
        assert_eq!(run_temp_dir(home, Some(real)), Some(home.join("tmp")));
        assert!(run_temp_dir(real, Some(real)).is_none());
        assert!(run_temp_dir(Path::new("/Users/ash/Library"), Some(real)).is_none());
        assert!(run_temp_dir(Path::new("/"), Some(real)).is_none());
        assert!(run_temp_dir(Path::new(""), Some(real)).is_none());
        assert!(run_temp_dir(Path::new("/Users/ash-evil/home"), Some(real)).is_some());
    }
}
