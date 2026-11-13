//! SC-5: the running checker (docs/specs/shipping-confidence-gap-spec.md section 4d, items 1 to 3).
//!
//! The cheap verdict reads the claims and the diff and runs nothing. The running checker is that same verdict (it reuses
//! `gates::verdict_prompt_with` and `gates::parse_verdict`) with proof added, in two short model calls and no tool access:
//!
//! 1. The app makes a read-only copy of the worker's checkout (`checker_copy`) and re-runs the brief's own check commands
//!    there, through the same sandboxed runner the checks gate uses, keeping each command and the end of its output.
//! 2. Those runs, the claims, the code's findings and the diff go to a model from another family (`checker_family`), which
//!    answers VERIFIED, VERIFIED WITH CAVEATS or REFUTED per claim, or asks for ONE more command with a line
//!    `RUN: <command>`.
//! 3. A command it asks for is checked (`parse_run`), run in the same copy under the same limits, and its output goes back
//!    for the final answer. Anything not accepted is refused and noted; the answer is still asked for.
//!
//! The model never overturns what code saw. A brief check that fails in the copy refutes the task; one that couldn't run, or
//! no command run at all, keeps the answer from reaching VERIFIED. A checker that can't be picked, a copy that can't be made,
//! a call that fails or an answer that can't be read is "could not run" (unsure), never a pass. The record says what the
//! checker exercised and what it did not, in two plain lists, and keeps every command with the end of its output.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::brief_checks::{self, BriefCheck, RawRun};
use super::checker_copy::{CopyHow, ReadOnlyCopy};
use super::checker_family::Pick;
use super::dismissals::{Dismissed, Standing};
use super::done_check::{self, CodeFinding};
use super::gates::{
    self, Answer, CommandEvidence, DoneLabel, GateResult, Outcome, RoundInput, Runners,
    VerdictResult,
};
use super::rounds::RoundHistory;

/// A `RUN:` command is shorter than this many characters.
pub const RUN_LIMIT: usize = 300;
/// The characters a `RUN:` command may not contain: the shell's operators and its escape.
pub const RUN_REFUSED_CHARS: [char; 8] = [';', '|', '&', '>', '<', '$', '`', '\\'];
/// The most diff the running checker reads. The cheap check reads `gates::DIFF_MAX`.
pub const DIFF_MAX: usize = 40_000;
/// One of the checker's model calls. It reads more than the cheap check does, so it gets longer; past it the call is "could
/// not run", never a failure.
pub const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
/// The most lines in each of the two lists, and the longest line.
const LIST_MAX: usize = 10;
const LINE_MAX: usize = 240;

// ---- the RUN line --------------------------------------------------------------------------------------------------------

/// What the checker's reply asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunAsk {
    /// No `RUN:` line: the reply is the final answer.
    None,
    /// A command that passes the rules.
    Accepted {
        command: String,
        /// More than one `RUN:` line: only the first counts.
        extra_ignored: bool,
    },
    /// A command that does not. It is not run, and the checker is told why.
    Refused {
        command: String,
        why: String,
        extra_ignored: bool,
    },
}

/// Why a command is not one the checker may ask for, in plain words. `None`: it may.
pub fn command_refusal(command: &str) -> Option<String> {
    let command = command.trim();
    if command.is_empty() {
        return Some("it named no command".into());
    }
    if command.chars().count() >= RUN_LIMIT {
        return Some(format!("it is {RUN_LIMIT} characters or longer"));
    }
    if let Some(bad) = command.chars().find(|c| RUN_REFUSED_CHARS.contains(c)) {
        return Some(format!(
            "it has `{bad}`, and a command may have none of ; | & > < $ ` or a backslash"
        ));
    }
    if command.chars().any(char::is_control) {
        return Some("it has a control character".into());
    }
    None
}

/// The command a line names after `RUN:`. One pair of backticks round the whole command is a quotation mark a model puts
/// on a command, not a command substitution: it is taken off.
fn unquote(command: &str) -> &str {
    let command = command.trim();
    match command
        .strip_prefix('`')
        .and_then(|rest| rest.strip_suffix('`'))
    {
        Some(inner) if !inner.contains('`') => inner.trim(),
        _ => command,
    }
}

/// The command a reply asks for. A line is a request when it starts `RUN:` (any case, any list marker or indent before it).
/// Only the first request counts; a second is ignored and noted.
pub fn parse_run(reply: &str) -> RunAsk {
    let mut found: Vec<&str> = Vec::new();
    for line in reply.lines() {
        let line = line.trim().trim_start_matches(['-', '*', '>', ' ']).trim();
        let Some(head) = line.get(..4) else {
            continue;
        };
        if head.eq_ignore_ascii_case("run:") {
            found.push(&line[4..]);
        }
    }
    let Some(first) = found.first() else {
        return RunAsk::None;
    };
    let command = unquote(first).to_string();
    let extra_ignored = found.len() > 1;
    match command_refusal(&command) {
        None => RunAsk::Accepted {
            command,
            extra_ignored,
        },
        Some(why) => RunAsk::Refused {
            command,
            why,
            extra_ignored,
        },
    }
}

// ---- the record ----------------------------------------------------------------------------------------------------------

/// What became of the checker's one extra command.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunLine {
    /// What it asked for, as written.
    pub asked: String,
    /// Why it was refused. None: it was run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
    /// A second `RUN:` line was in the reply and was left out.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub extra_ignored: bool,
}

#[cfg(test)]
#[path = "checker_tests.rs"]
mod tests;

/// The running checker's part of a round's evidence.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckerRecord {
    /// Who checked: `Codex`, `Claude (opus)`.
    pub checker: String,
    /// "Checked by the same family: only Claude is signed in." Present only when the family rule couldn't be kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family_note: Option<String>,
    /// Whether it gave an answer. False: it could not run, and `why_not` says why.
    pub ran: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why_not: Option<String>,
    /// How the copy was made and what kept it read-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard: Option<String>,
    /// Every command that ran in the copy, with the end of its output: the brief's lines, then the checker's own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<CommandEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_line: Option<RunLine>,
    /// What it exercised and what it did not: two plain lists.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exercised: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_exercised: Vec<String>,
    /// How many model calls it took (one or two).
    pub calls: u8,
}

impl CheckerRecord {
    fn new(pick: Option<&Pick>) -> CheckerRecord {
        CheckerRecord {
            checker: pick.map(Pick::label).unwrap_or_default(),
            family_note: pick.and_then(|pick| pick.note.clone()),
            ..CheckerRecord::default()
        }
    }
}

/// What the running checker gave back to the round.
#[derive(Clone, Debug, PartialEq)]
pub struct Checked {
    pub verdict: VerdictResult,
    pub record: CheckerRecord,
    /// What became of each dismissed finding the checker was told about, by the number the worker used.
    pub standing: Vec<(usize, Standing)>,
}

fn could_not_run(
    pick: Option<&Pick>,
    why: impl Into<String>,
    mut record: CheckerRecord,
) -> Checked {
    let why = why.into();
    if record.checker.is_empty() {
        record = CheckerRecord {
            checker: pick.map(Pick::label).unwrap_or_default(),
            family_note: pick.and_then(|pick| pick.note.clone()),
            ..record
        };
    }
    record.ran = false;
    record.why_not = Some(why.clone());
    // Whatever the app ran, nothing read the claims or the diff.
    push_unique(
        &mut record.not_exercised,
        "The claims and the diff were not judged: the running checker could not run.".into(),
    );
    Checked {
        verdict: VerdictResult {
            answer: Answer::Unsure,
            why: format!("the running checker could not run ({why})"),
            said: String::new(),
            label: None,
            claims: Vec::new(),
            frauds: Vec::new(),
        },
        record,
        standing: Vec::new(),
    }
}

fn clip(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text.chars().take(max).collect()
}

/// A command's outcome as one plain line for the two lists.
pub(crate) fn exercised_line(run: &CommandEvidence) -> String {
    match (run.outcome, run.exit_code) {
        (Outcome::Passed, _) => format!("Ran `{}`: it passed.", clip(&run.command, 120)),
        (Outcome::Failed, Some(code)) => {
            format!(
                "Ran `{}`: it failed (exit {code}).",
                clip(&run.command, 120)
            )
        }
        (Outcome::Failed, None) => format!("Ran `{}`: it failed.", clip(&run.command, 120)),
        _ => format!(
            "`{}` could not run: {}",
            clip(&run.command, 120),
            clip(run.output.lines().next().unwrap_or("it did not start"), 120)
        ),
    }
}

// ---- the prompt ----------------------------------------------------------------------------------------------------------

/// What the checker is told besides the claims: the commands the app ran, the findings the worker dismissed, and the rule a
/// rethink named.
struct Told<'a> {
    commands: &'a [CommandEvidence],
    brief_has_lines: bool,
    dismissed: &'a [Dismissed],
    history: Option<&'a RoundHistory>,
}

const PROTOCOL: &str = "You are the running checker. The app has already re-run the brief's own check commands in a read-only copy of \
the worker's checkout and kept their exact output (below): trust that output over any claim. You may ask for ONE more command. To do \
that, reply with a single line `RUN: <command>` and nothing else: one line, under 300 characters, none of ; | & > < $ ` or a \
backslash, run in the read-only copy (nothing can be written there) with the same time limit. Anything else is refused. You then get \
its exact output and give the final answer. If you need no command, give the final answer now. The final answer is the one line of \
JSON above with two more keys: \"exercised\": [plain lines on what you ran or checked] and \"not_exercised\": [plain lines on what \
you did not or could not check].";

pub(crate) fn commands_text(commands: &[CommandEvidence], brief_has_lines: bool) -> String {
    if commands.is_empty() {
        return if brief_has_lines {
            "- none ran".into()
        } else {
            "- none: the brief named no check commands".into()
        };
    }
    commands
        .iter()
        .enumerate()
        .map(|(index, run)| {
            let how = match (run.outcome, run.exit_code) {
                (Outcome::Passed, _) => "passed".to_string(),
                (Outcome::Failed, Some(code)) => format!("failed (exit {code})"),
                (Outcome::Failed, None) => "failed".to_string(),
                _ => "could not run".to_string(),
            };
            let fence = if run.output.contains("```") {
                "~~~~"
            } else {
                "```"
            };
            format!(
                "{}. `{}`: {how}\n{fence}text\n{}\n{fence}",
                index + 1,
                run.command,
                run.output.trim_end()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn dismissed_text(dismissed: &[Dismissed]) -> String {
    if dismissed.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = dismissed.iter().map(Dismissed::line).collect();
    format!(
        "\n\n## Findings the worker dismissed\nEach is let go unless you re-confirm it with a command. If a command (one above, or \
         your own) shows it still holds, list it as {{\"dismissed\": [{{\"number\": N, \"stands\": true, \"why\": \"one line naming the \
         command and what it showed\"}}]}} in your answer; a finding you leave out is let go.\n{}",
        lines.join("\n")
    )
}

/// The first call's prompt: the cheap check's own prompt (same rules, claims, findings and diff) with the proof and the
/// protocol added.
fn first_prompt(
    input: &RoundInput,
    diff: &str,
    gates: &[GateResult],
    claims: &[done_check::Claim],
    findings: &[CodeFinding],
    told: &Told,
) -> String {
    let base = gates::verdict_prompt_with(
        &gates::running_rules(),
        input,
        diff,
        gates,
        claims,
        findings,
    );
    let mut text = format!(
        "{base}\n\n## Commands the app re-ran in a read-only copy of the worker's checkout\n{}\n\n{PROTOCOL}",
        commands_text(told.commands, told.brief_has_lines)
    );
    if let Some(rule) = told.history.and_then(|history| history.rule.as_deref()) {
        text.push_str(&format!(
            "\n\nThe brief was rewritten after two failed rounds around this one rule, which the work should now keep: {rule}"
        ));
    }
    text.push_str(&dismissed_text(told.dismissed));
    text
}

/// The second call's prompt: the first, what the checker said, and either the command's output or why it was refused.
pub(crate) fn second_prompt(
    first: &str,
    said: &str,
    ask: &RunAsk,
    run: Option<&CommandEvidence>,
) -> String {
    let outcome = match (ask, run) {
        (RunAsk::Accepted { command, .. }, Some(run)) => format!(
            "## The command you asked for, run in the read-only copy\n`{command}`: {}\n```text\n{}\n```",
            match (run.outcome, run.exit_code) {
                (Outcome::Passed, _) => "exited 0".to_string(),
                (Outcome::Failed, Some(code)) => format!("exited {code}"),
                _ => "could not run".to_string(),
            },
            run.output.trim_end()
        ),
        (RunAsk::Refused { command, why, .. }, _) => format!(
            "## The command you asked for was refused\n`{command}` was not run: {why}. Answer from what you have."
        ),
        _ => String::new(),
    };
    let ignored = matches!(
        ask,
        RunAsk::Accepted {
            extra_ignored: true,
            ..
        } | RunAsk::Refused {
            extra_ignored: true,
            ..
        }
    );
    let note = if ignored {
        "\nOnly the first RUN line counts; the others were left out."
    } else {
        ""
    };
    format!(
        "{first}\n\n## Your reply\n{}\n\n{outcome}{note}\n\nNow give the final answer: the one line of JSON and nothing else.",
        gates::head_of(said.trim(), 1_000)
    )
}

// ---- the answer ------------------------------------------------------------------------------------------------------------

/// What the checker said beyond the cheap check's verdict.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Extras {
    pub exercised: Vec<String>,
    pub not_exercised: Vec<String>,
    /// `(finding number, stands, why)` for each dismissed finding it answered.
    pub dismissed: Vec<(usize, bool, String)>,
}

fn lines_of(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|line| clip(line, LINE_MAX))
                .filter(|line| !line.is_empty())
                .take(LIST_MAX)
                .collect()
        })
        .unwrap_or_default()
}

/// The two lists and the dismissals in the checker's answer. The same reading as `gates::parse_verdict`: anything that is
/// not clearly one of them is left out, never guessed.
pub fn parse_extras(said: &str) -> Extras {
    let Some(value) = gates::json_of(said) else {
        return Extras::default();
    };
    let dismissed = value
        .get("dismissed")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let number = usize::try_from(row.get("number")?.as_u64()?).ok()?;
                    let stands = row.get("stands")?.as_bool()?;
                    let why = clip(
                        row.get("why").and_then(Value::as_str).unwrap_or(""),
                        LINE_MAX,
                    );
                    Some((number, stands, why))
                })
                .take(20)
                .collect()
        })
        .unwrap_or_default();
    Extras {
        exercised: lines_of(value.get("exercised")),
        not_exercised: lines_of(value.get("not_exercised").or(value.get("notExercised"))),
        dismissed,
    }
}

/// What a command prints when the read-only copy refused one of its writes (a build's `target/`, a lock file, a cache).
const WRITE_REFUSALS: [&str; 5] = [
    "operation not permitted",
    "permission denied",
    "read-only file system",
    "eperm",
    "eacces",
];

/// Whether a failed command's output shows the copy refused a write. Such a failure says nothing about the work.
fn write_refused(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    WRITE_REFUSALS.iter().any(|word| lower.contains(word))
}

/// A failure in the copy proves nothing about the work, and is "could not run", never a refutation, when it shows the copy
/// refused a write (either kind of copy: the copy is read-only on purpose), or when the copy is a worktree with none of the
/// worker's installed dependencies or build output. "Could not run" never counts as a pass.
pub(crate) fn trusted_in(how: CopyHow, mut evidence: CommandEvidence) -> CommandEvidence {
    if evidence.outcome == Outcome::Failed && write_refused(&evidence.output) {
        evidence.outcome = Outcome::NotRun;
        evidence.output = format!(
            "It could not write inside the read-only copy, so it did not really run and this proves nothing about the work.\n{}",
            evidence.output
        );
        return evidence;
    }
    if how == CopyHow::Worktree && evidence.outcome == Outcome::Failed {
        evidence.outcome = Outcome::NotRun;
        evidence.output = format!(
            "It failed in a copy that has none of the worker's installed dependencies or build output, so this proves nothing about the work.\n{}",
            evidence.output
        );
    }
    evidence
}

/// One command run in the copy, as evidence. Its outcome is the exit code (0 passes).
pub(crate) fn evidence_of(
    what: &str,
    command: &str,
    raw: &RawRun,
    how: CopyHow,
) -> CommandEvidence {
    let judged = brief_checks::judge(
        &BriefCheck {
            what: what.to_string(),
            command: command.to_string(),
            expect: None,
            passes: None,
            ran_at: None,
            output_tail: None,
        },
        raw,
    );
    trusted_in(how, judged.evidence)
}

/// Runs the running checker for one round. `diff` is the worker's diff as the checker reads it.
#[allow(clippy::too_many_arguments)]
pub fn run(
    input: &RoundInput,
    diff: &str,
    gates: &[GateResult],
    claims: &[done_check::Claim],
    findings: &[CodeFinding],
    dismissed: &[Dismissed],
    history: Option<&RoundHistory>,
    runners: &dyn Runners,
) -> Checked {
    let empty = CheckerRecord::default();
    if input.done_when.trim().is_empty() {
        return could_not_run(
            None,
            "the brief has no definition of done to check against",
            empty,
        );
    }
    let pick = match runners.checker_pick(input.delegation_id) {
        Ok(pick) => pick,
        Err(why) => return could_not_run(None, why, empty),
    };
    let mut record = CheckerRecord::new(Some(&pick));
    let copy: ReadOnlyCopy = match runners.read_only_copy(input.checkout) {
        Ok(copy) => copy,
        Err(why) => {
            return could_not_run(
                Some(&pick),
                format!("a read-only copy of the worker's checkout couldn't be made: {why}"),
                record,
            )
        }
    };
    record.copy = Some(copy.how().word().to_string());
    record.guard = Some(copy.guard.word().to_string());
    let how = copy.how();

    // 1. The brief's own check commands, re-run in the copy.
    let mut commands: Vec<CommandEvidence> = Vec::new();
    let mut brief_has_lines = false;
    if let Some(brief) = input.brief_round {
        if let Some(why) = &brief.checks_unreadable {
            record.not_exercised.push(clip(
                &format!("The brief's own checks couldn't be read, so none were re-run ({why})."),
                LINE_MAX,
            ));
        } else {
            brief_has_lines = !brief.lines.is_empty();
            let ran = brief_checks::run_lines(
                &brief.lines,
                input.now,
                brief_checks::LINES_BUDGET,
                &mut |index, line| {
                    runners.copy_run(
                        &copy,
                        &format!("brief-{index}"),
                        &line.what,
                        &line.command,
                        brief_checks::LINE_TIMEOUT_SECONDS,
                    )
                },
            );
            for (judged, _) in ran {
                commands.push(trusted_in(how, judged.evidence));
            }
        }
    }

    // PT-1: in `full`, a task that changed the interface also has the project's end-to-end tests replayed in the copy (e2e's
    // strict-cache replay, Playwright's changed tests) when the project already has them. They come after the brief's own
    // commands (`brief_line_count` counts those first), and a write the copy refuses stays "did not run" (`trusted_in`).
    if input
        .mode
        .is_some_and(|mode| mode.mode == crate::delivery::settings::TestingMode::Full)
    {
        for run in runners.proof_replay(input.checkout, &copy) {
            commands.push(trusted_in(how, super::proof_gate::evidence(&run)));
        }
    }

    // 2. The first call.
    let told = Told {
        commands: &commands,
        brief_has_lines,
        dismissed,
        history,
    };
    let prompt_one = first_prompt(input, diff, gates, claims, findings, &told);
    let first = match runners.checker_model(&prompt_one, &pick.cli, &pick.model) {
        Ok(said) => said,
        Err(why) => {
            record.commands = commands;
            sort_commands(&mut record);
            return could_not_run(Some(&pick), format!("its call failed: {why}"), record);
        }
    };
    record.calls = 1;

    // 3. The one extra command, if it asked and it may.
    let ask = parse_run(&first);
    let said = match &ask {
        RunAsk::None => first.clone(),
        RunAsk::Accepted {
            command,
            extra_ignored,
        } => {
            let raw = runners.copy_run(
                &copy,
                "extra",
                "the checker's own command",
                command,
                brief_checks::LINE_TIMEOUT_SECONDS,
            );
            let evidence = evidence_of("the checker's own command", command, &raw, how);
            record.run_line = Some(RunLine {
                asked: command.clone(),
                refused: None,
                extra_ignored: *extra_ignored,
            });
            commands.push(evidence.clone());
            record.calls = 2;
            match runners.checker_model(
                &second_prompt(&prompt_one, &first, &ask, Some(&evidence)),
                &pick.cli,
                &pick.model,
            ) {
                Ok(said) => said,
                Err(why) => {
                    record.commands = commands;
                    sort_commands(&mut record);
                    return could_not_run(
                        Some(&pick),
                        format!("its second call failed: {why}"),
                        record,
                    );
                }
            }
        }
        RunAsk::Refused {
            command,
            why,
            extra_ignored,
        } => {
            record.run_line = Some(RunLine {
                asked: clip(command, RUN_LIMIT),
                refused: Some(why.clone()),
                extra_ignored: *extra_ignored,
            });
            record.calls = 2;
            match runners.checker_model(
                &second_prompt(&prompt_one, &first, &ask, None),
                &pick.cli,
                &pick.model,
            ) {
                Ok(said) => said,
                Err(why) => {
                    record.commands = commands;
                    sort_commands(&mut record);
                    return could_not_run(
                        Some(&pick),
                        format!("its second call failed: {why}"),
                        record,
                    );
                }
            }
        }
    };

    // 4. The answer, read the way the cheap check's is, then held to what the app saw.
    let mut verdict = gates::parse_verdict(&said);
    let extras = parse_extras(&said);
    // An answer it could not give, or that could not be read, is "could not run": never a pass.
    record.ran = verdict.answer != Answer::Unsure;
    if !record.ran {
        record.why_not = Some(verdict.why.clone());
    }
    let ran_any = commands.iter().any(|run| run.outcome != Outcome::NotRun);
    let failed: Vec<&CommandEvidence> = commands
        .iter()
        .take(brief_line_count(input))
        .filter(|run| run.outcome == Outcome::Failed)
        .collect();
    let not_run = commands.iter().any(|run| run.outcome == Outcome::NotRun);
    // A brief check that fails where the app ran it is the app's word, and the model can't talk it away.
    if !failed.is_empty() {
        for run in &failed {
            verdict.frauds.push(clip(
                &format!(
                    "A brief check fails in the read-only copy: `{}`{}.",
                    clip(&run.command, 120),
                    run.exit_code
                        .map(|code| format!(" (exit {code})"))
                        .unwrap_or_default()
                ),
                300,
            ));
        }
        verdict.answer = Answer::NotMet;
        verdict.label = Some(DoneLabel::Refuted);
        verdict.why = format!(
            "{} brief check(s) fail in the read-only copy.",
            failed.len()
        );
    } else if verdict.answer == Answer::Met
        && (not_run || !ran_any)
        && matches!(verdict.label, Some(DoneLabel::Verified) | None)
    {
        // A command that could not run, or none run at all, keeps a claim from being VERIFIED: it is VERIFIED WITH CAVEATS.
        verdict.label = Some(DoneLabel::VerifiedWithCaveats);
    }

    // What it exercised and what it did not: the app's own words first, then the checker's.
    record.commands = commands;
    sort_commands(&mut record);
    if !ran_any
        && record
            .run_line
            .as_ref()
            .is_none_or(|line| line.refused.is_some())
    {
        push_unique(
            &mut record.not_exercised,
            "No command was run in the copy: the brief named no check commands, or none could run, and the checker's own was not run."
                .to_string(),
        );
    }
    for line in extras.exercised {
        push_unique(&mut record.exercised, line);
    }
    for line in extras.not_exercised {
        push_unique(&mut record.not_exercised, line);
    }
    record.exercised.truncate(LIST_MAX);
    record.not_exercised.truncate(LIST_MAX);

    // The findings the worker dismissed: let go unless a command backed the checker's word that one still holds.
    let standing = dismissed
        .iter()
        .map(|dismissal| {
            let answer = extras
                .dismissed
                .iter()
                .find(|(number, _, _)| *number == dismissal.number);
            let standing = match answer {
                Some((_, true, why)) if ran_any => Standing::Stands {
                    proof: if why.is_empty() {
                        "the checker re-confirmed it with a command".to_string()
                    } else {
                        why.clone()
                    },
                },
                _ => Standing::Dismissed,
            };
            (dismissal.number, standing)
        })
        .collect();
    Checked {
        verdict,
        record,
        standing,
    }
}

/// How many of the commands are the brief's own: they come first.
fn brief_line_count(input: &RoundInput) -> usize {
    input
        .brief_round
        .filter(|brief| brief.checks_unreadable.is_none())
        .map(|brief| brief.lines.len())
        .unwrap_or(0)
}

/// The app's own words on each command that ran: a command that ran is exercised, one that could not run is not.
fn sort_commands(record: &mut CheckerRecord) {
    let lines: Vec<(bool, String)> = record
        .commands
        .iter()
        .map(|run| {
            (
                matches!(run.outcome, Outcome::Passed | Outcome::Failed),
                exercised_line(run),
            )
        })
        .collect();
    for (ran, line) in lines {
        if ran {
            push_unique(&mut record.exercised, line);
        } else {
            push_unique(&mut record.not_exercised, line);
        }
    }
}

fn push_unique(list: &mut Vec<String>, line: String) {
    if !line.is_empty() && !list.contains(&line) {
        list.push(line);
    }
}

/// The record as Markdown lines for a PR body and the Crew tab: who checked, what it exercised and what it did not, and
/// each command with the end of its output.
pub fn evidence_lines(record: &CheckerRecord) -> String {
    let mut out = String::new();
    let who = if record.checker.is_empty() {
        "the running checker".to_string()
    } else {
        record.checker.clone()
    };
    if record.ran {
        out.push_str(&format!("- Running checker ({who})\n"));
    } else {
        out.push_str(&format!(
            "- Running checker ({who}) could not run: {}\n",
            record.why_not.as_deref().unwrap_or("it gave no answer")
        ));
    }
    if let Some(note) = &record.family_note {
        out.push_str(&format!("  - {note}\n"));
    }
    if let (Some(copy), Some(guard)) = (&record.copy, &record.guard) {
        out.push_str(&format!("  - Ran in {copy}, read-only by {guard}.\n"));
    }
    if let Some(line) = &record.run_line {
        match &line.refused {
            None => out.push_str(&format!(
                "  - It asked for one more command: `{}`.\n",
                line.asked
            )),
            Some(why) => out.push_str(&format!(
                "  - It asked for `{}`, which was refused: {why}.\n",
                line.asked
            )),
        }
        if line.extra_ignored {
            out.push_str("  - A second RUN line was left out.\n");
        }
    }
    if !record.exercised.is_empty() {
        out.push_str("  - What I exercised:\n");
        for line in &record.exercised {
            out.push_str(&format!("    - {line}\n"));
        }
    }
    if !record.not_exercised.is_empty() {
        out.push_str("  - What I did not:\n");
        for line in &record.not_exercised {
            out.push_str(&format!("    - {line}\n"));
        }
    }
    for run in &record.commands {
        let code = run
            .exit_code
            .map(|code| format!("exit {code}"))
            .unwrap_or_else(|| "no exit code".into());
        out.push_str(&format!("  - `{}` ({code})\n", run.command));
        if !run.output.is_empty() {
            let fence = if run.output.contains("```") {
                "~~~~"
            } else {
                "```"
            };
            out.push_str(&format!("\n{fence}text\n{}\n{fence}\n\n", run.output));
        }
    }
    out
}
