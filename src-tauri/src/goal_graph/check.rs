// WP-91: the finish line. A run's goal is one command that can fail, run once in the lead's checkout before any
// worker starts (the baseline) and again in the integrated checkout at the end (the run verdict).
//
// The command goes through the same action runner as the project's own checks (project_actions.rs, via
// verify_stage.rs's recipe), so it is a child process in its own group with the credential scrub, a timeout and a
// log. A value from a proposal is untrusted: lengths and types are checked here and the command is passed through
// as one argument, never built by joining strings into a shell.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use super::{CheckOutcome, CheckRun, Refusal};
use crate::project_file::ProjectAction;

/// The most of a check's output that is kept on the run record.
pub const OUTPUT_MAX: usize = 4_000;
/// The command itself, and what it may expect.
const COMMAND_MAX: usize = 1_000;
const EXPECT_TEXT_MAX: usize = 200;
const DEFAULT_TIMEOUT_SECONDS: u64 = 600;
const MIN_TIMEOUT_SECONDS: u64 = 5;
const MAX_TIMEOUT_SECONDS: u64 = 3_600;

/// The finish line: the command, the exit code it must give, and optionally text it must print.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSpec {
    pub command: String,
    /// The exit code that counts as met. The project's own checks use 0; a red-proof check can name another.
    pub expect_exit: i32,
    /// Text the output must hold, when the exit code alone is not the whole finish line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_text: Option<String>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

impl CheckSpec {
    pub fn timeout(&self) -> u64 {
        self.timeout_seconds
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
            .clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
    }

    /// One line naming the command, for the card and the lead's prompt.
    pub fn line(&self) -> String {
        match &self.expect_text {
            Some(text) => format!(
                "{} (exit {}, printing {text:?})",
                self.command, self.expect_exit
            ),
            None => format!("{} (exit {})", self.command, self.expect_exit),
        }
    }
}

fn one_line(value: &str) -> bool {
    !value.contains('\n') && !value.contains('\r')
}

fn has_control(value: &str) -> bool {
    value
        .chars()
        .any(|c| c.is_control() && c != '\t' && c != '\n' && c != '\r')
}

/// The finish-line check out of a proposal. A missing or empty command, an exit code that is not a whole number in
/// range, and text that is too long or spans lines are all refused in plain words.
pub fn parse_spec(value: &Value) -> Result<CheckSpec, Refusal> {
    let Some(object) = value.as_object() else {
        return Err(Refusal::new(
            "invalid_check",
            "A run needs a finish-line check: give it a command that fails until the work is done.",
        ));
    };
    let command = object.get("command").and_then(Value::as_str).unwrap_or("");
    if command.trim().is_empty() {
        return Err(Refusal::new(
            "invalid_check",
            "The finish-line check needs a command; there is nothing to run.",
        ));
    }
    if command.trim().len() > COMMAND_MAX || has_control(command) || !one_line(command) {
        return Err(Refusal::new(
            "invalid_check",
            format!(
                "Keep the finish-line check's command under {COMMAND_MAX} characters, on one line."
            ),
        ));
    }
    let expect_exit =
        match object.get("expectExit") {
            None | Some(Value::Null) => 0,
            Some(Value::Number(number)) => match number.as_i64() {
                Some(code) if (-255..=255).contains(&code) => code as i32,
                _ => return Err(Refusal::new(
                    "invalid_check",
                    "The exit code the check expects must be a whole number between -255 and 255.",
                )),
            },
            Some(_) => {
                return Err(Refusal::new(
                    "invalid_check",
                    "The exit code the check expects must be a whole number between -255 and 255.",
                ))
            }
        };
    let expect_text = match object.get("expectText") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let text = text.trim().to_string();
            if text.is_empty() {
                None
            } else if text.len() > EXPECT_TEXT_MAX || !one_line(&text) || has_control(&text) {
                return Err(Refusal::new(
                    "invalid_check",
                    format!("Keep the text the check must print under {EXPECT_TEXT_MAX} characters, on one line."),
                ));
            } else {
                Some(text)
            }
        }
        Some(_) => {
            return Err(Refusal::new(
                "invalid_check",
                "The text the check must print has to be text.",
            ))
        }
    };
    let timeout_seconds = match object.get("timeoutSeconds") {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) => match number.as_u64() {
            Some(seconds) => Some(seconds),
            None => {
                return Err(Refusal::new(
                    "invalid_check",
                    "The check's timeout is a whole number of seconds.",
                ))
            }
        },
        Some(_) => {
            return Err(Refusal::new(
                "invalid_check",
                "The check's timeout is a whole number of seconds.",
            ))
        }
    };
    Ok(CheckSpec {
        command: command.trim().to_string(),
        expect_exit,
        expect_text,
        timeout_seconds,
    })
}

/// How a finished run reads against what the check expected.
///
/// A run that could not start, or that ran out of time, is `notRun`: an unreachable service or a timeout is never a
/// final failure and never a pass.
pub fn outcome_of(
    status: crate::project_actions::RunStatus,
    exit_code: Option<i32>,
    output: &str,
    spec: &CheckSpec,
) -> (CheckOutcome, String) {
    use crate::project_actions::RunStatus;
    match status {
        RunStatus::Succeeded | RunStatus::Failed => {
            // A run the app could not start (or one killed before it could say) has no exit code. It did not fail the
            // finish line: it never tried it.
            let Some(code) = exit_code else {
                return (
                    CheckOutcome::NotRun,
                    "could not start or did not finish, so it never said how it ended".to_string(),
                );
            };
            if code != spec.expect_exit {
                return (
                    CheckOutcome::Failed,
                    format!("exited {code}, not {}", spec.expect_exit),
                );
            }
            if let Some(text) = &spec.expect_text {
                if !output.contains(text.as_str()) {
                    return (
                        CheckOutcome::Failed,
                        format!("exited {} but never printed {text:?}", spec.expect_exit),
                    );
                }
            }
            (
                CheckOutcome::Passed,
                format!("exited {} as expected", spec.expect_exit),
            )
        }
        RunStatus::TimedOut => (
            CheckOutcome::NotRun,
            "did not finish before its timeout".to_string(),
        ),
        RunStatus::Stopped => (CheckOutcome::NotRun, "was stopped early".to_string()),
        RunStatus::Running => (CheckOutcome::NotRun, "did not finish".to_string()),
    }
}

/// The end of what a check printed, capped.
pub fn capped(tail: &[String]) -> String {
    let mut out = String::new();
    for line in tail {
        if out.len() + line.len() + 1 > OUTPUT_MAX {
            let room = OUTPUT_MAX.saturating_sub(out.len());
            let mut end = room;
            while end > 0 && !line.is_char_boundary(end) {
                end -= 1;
            }
            out.push_str(&line[..end]);
            out.push('…');
            return out;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out
}

fn action_for(spec: &CheckSpec) -> ProjectAction {
    ProjectAction {
        id: "goal-check".to_string(),
        name: "The run's finish line".to_string(),
        command: spec.command.clone(),
        description: Some("WP-91 finish-line check".into()),
        icon: Some("check".into()),
        run_on_worktree_create: false,
        hold: false,
        long_running: false,
        timeout_seconds: Some(spec.timeout()),
        confirm: None,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Run the check once in `cwd`. `Err` only when the run could not be started at all, in plain words; a command that
/// exists but fails is a `CheckRun` whose outcome says so.
pub fn run(app: &AppHandle, cwd: &str, spec: &CheckSpec) -> Result<CheckRun, String> {
    use tauri::Manager;
    let (main, checkout) =
        crate::project_actions::checkout_of_project(&crate::fs::expand_home(cwd))?;
    let runs = app.state::<crate::project_actions::ActionRuns>();
    // WP-178 (review r2 HIGH-2): a check command comes from a proposal, so it runs under the sandbox while it is on.
    let data = crate::project_file::data_dir(app)?;
    let wrap = crate::agent_sandbox::action_wrap(Some(&data))?;
    let record = crate::project_actions::start_command(
        &runs,
        &main,
        &checkout,
        &action_for(spec),
        "verify",
        &data.join("action-runs"),
        Some(crate::harness::cached_gui_search_path()),
        Vec::new(),
        // A command from a proposal is untrusted, so it starts from an allow-listed environment: PATH, HOME and the
        // locale, plus the project variables the runner sets. Never the app's own secrets.
        true,
        Some(crate::project_actions::emitter(app)),
        wrap,
    )?;
    let limit = Duration::from_secs(spec.timeout()) + Duration::from_secs(30);
    let finished = runs
        .wait(&record.id, limit)
        .ok_or("the check disappeared before it finished")?;
    let output = capped(&finished.tail);
    let (outcome, detail) = outcome_of(finished.status, finished.exit_code, &output, spec);
    Ok(CheckRun {
        outcome,
        exit_code: finished.exit_code,
        output: if output.is_empty() {
            detail
        } else {
            format!("{detail}\n{output}")
        },
        layer: "app".to_string(),
        at: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_actions::RunStatus;
    use serde_json::json;

    fn spec() -> CheckSpec {
        CheckSpec {
            command: "npm test".into(),
            expect_exit: 0,
            expect_text: None,
            timeout_seconds: None,
        }
    }

    #[test]
    fn a_missing_or_empty_command_is_refused() {
        for value in [
            json!({}),
            json!({ "command": "" }),
            json!({ "command": "   " }),
        ] {
            let refused = parse_spec(&value).unwrap_err();
            assert_eq!(refused.reason, "invalid_check");
            assert!(refused.message().contains("nothing to run"));
        }
        assert!(parse_spec(&json!("npm test")).is_err());
        assert!(parse_spec(&json!({ "command": 7 })).is_err());
    }

    #[test]
    fn an_over_long_or_multiline_command_is_refused() {
        let long = "x".repeat(COMMAND_MAX + 1);
        assert!(parse_spec(&json!({ "command": long })).is_err());
        assert!(parse_spec(&json!({ "command": "npm test\nrm -rf /" })).is_err());
        let spec = parse_spec(&json!({ "command": "  npm test  " })).unwrap();
        assert_eq!(spec.command, "npm test");
    }

    #[test]
    fn the_expected_exit_code_must_be_a_whole_number_in_range() {
        assert_eq!(
            parse_spec(&json!({ "command": "x" })).unwrap().expect_exit,
            0
        );
        assert_eq!(
            parse_spec(&json!({ "command": "x", "expectExit": 2 }))
                .unwrap()
                .expect_exit,
            2
        );
        assert_eq!(
            parse_spec(&json!({ "command": "x", "expectExit": -1 }))
                .unwrap()
                .expect_exit,
            -1
        );
        for bad in [json!("0"), json!(1.5), json!(900), json!(-900)] {
            assert!(parse_spec(&json!({ "command": "x", "expectExit": bad })).is_err());
        }
    }

    #[test]
    fn expected_text_must_be_one_short_line() {
        assert_eq!(
            parse_spec(&json!({ "command": "x", "expectText": " all good " }))
                .unwrap()
                .expect_text,
            Some("all good".to_string())
        );
        assert_eq!(
            parse_spec(&json!({ "command": "x", "expectText": "  " }))
                .unwrap()
                .expect_text,
            None
        );
        assert!(parse_spec(&json!({ "command": "x", "expectText": "a\nb" })).is_err());
        assert!(parse_spec(
            &json!({ "command": "x", "expectText": "x".repeat(EXPECT_TEXT_MAX + 1) })
        )
        .is_err());
        assert!(parse_spec(&json!({ "command": "x", "expectText": 5 })).is_err());
    }

    #[test]
    fn the_timeout_is_bounded() {
        assert_eq!(spec().timeout(), DEFAULT_TIMEOUT_SECONDS);
        assert_eq!(
            parse_spec(&json!({ "command": "x", "timeoutSeconds": 1 }))
                .unwrap()
                .timeout(),
            MIN_TIMEOUT_SECONDS
        );
        assert_eq!(
            parse_spec(&json!({ "command": "x", "timeoutSeconds": 100_000 }))
                .unwrap()
                .timeout(),
            MAX_TIMEOUT_SECONDS
        );
        assert!(parse_spec(&json!({ "command": "x", "timeoutSeconds": -3 })).is_err());
        assert!(parse_spec(&json!({ "command": "x", "timeoutSeconds": "60" })).is_err());
    }

    #[test]
    fn the_expected_exit_code_and_text_decide_the_outcome() {
        let spec = spec();
        assert_eq!(
            outcome_of(RunStatus::Failed, Some(1), "", &spec).0,
            CheckOutcome::Failed
        );
        assert_eq!(
            outcome_of(RunStatus::Succeeded, Some(0), "", &spec).0,
            CheckOutcome::Passed
        );
        let mut red_proof = spec.clone();
        red_proof.expect_exit = 1;
        assert_eq!(
            outcome_of(RunStatus::Failed, Some(1), "", &red_proof).0,
            CheckOutcome::Passed
        );
        let mut printed = spec.clone();
        printed.expect_text = Some("0 failing".into());
        assert_eq!(
            outcome_of(
                RunStatus::Succeeded,
                Some(0),
                "12 passing, 0 failing",
                &printed
            )
            .0,
            CheckOutcome::Passed
        );
        assert_eq!(
            outcome_of(RunStatus::Succeeded, Some(0), "12 passing", &printed).0,
            CheckOutcome::Failed
        );
    }

    #[test]
    fn a_timeout_or_a_stopped_run_is_never_a_pass_and_never_a_final_failure() {
        for status in [RunStatus::TimedOut, RunStatus::Stopped, RunStatus::Running] {
            let (outcome, _) = outcome_of(status, Some(0), "", &spec());
            assert_eq!(outcome, CheckOutcome::NotRun, "{status:?}");
        }
    }

    #[test]
    fn a_command_that_could_not_start_is_not_run_never_a_failure() {
        // The runner records a spawn failure as `Failed` with no exit code (`ActionRuns::start`). Nothing ran, so
        // the finish line was never tried: that is `notRun`, so the baseline is refused instead of reading as red.
        for status in [RunStatus::Failed, RunStatus::Succeeded] {
            let (outcome, detail) = outcome_of(status, None, "", &spec());
            assert_eq!(outcome, CheckOutcome::NotRun, "{status:?}");
            assert!(detail.contains("never said how it ended"), "{detail}");
        }
    }

    #[test]
    fn output_is_capped_on_a_character_boundary() {
        let long = vec!["é".repeat(OUTPUT_MAX).to_string()];
        let text = capped(&long);
        assert!(text.len() <= OUTPUT_MAX + 4);
        assert!(text.ends_with('…'));
        assert!(!text.is_empty());
        assert!(std::str::from_utf8(text.as_bytes()).is_ok());
        assert_eq!(capped(&["a".into(), "b".into()]), "a\nb");
        assert_eq!(capped(&[]), "");
    }
}
