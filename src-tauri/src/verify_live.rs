//! The fake-Claude test bench's way in (Phase 1b WP5, `scripts/hub-verify-live.mjs`).
//!
//! A **dev copy running under a temporary HOME** that is started with `MONOCODE_VERIFY_LIVE=<plan.json>` reads one
//! plan: the fake Claude CLI to run instead of the installed one (`scripts/fake-claude.mjs` behind a `claude`
//! wrapper), auto-resume switched on so a restart midway is exercised like the daily app's, and a kickoff the window
//! sends once (a Mono on a scratch project, and its first message). Nothing else changes.
//!
//! The daily app never reads it, and neither does a dev copy on the real HOME: both conditions are checked before the
//! file is opened, so a stray variable can't point a real copy at a fake Claude.

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kickoff: Option<Kickoff>,
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
    serde_json::json!({
        "runId": plan.run_id,
        "kickoff": plan.kickoff,
    })
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
        assert_eq!(plan.kickoff.as_ref().unwrap().mono_name, "Verify Lead");
        assert_eq!(window_info(&plan)["runId"], "20261019-a1");

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
            (r#"{"version":1,"runId":"a","extra":1}"#.to_string(), "unknown field"),
        ];
        for (text, expected) in cases {
            let error = parse(&text).unwrap_err();
            assert!(error.contains(expected), "{text}: {error}");
        }
    }
}
