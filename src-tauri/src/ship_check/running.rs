//! PT-4: the ship check's "Review" step as the running checker.
//!
//! The one-turn review reads the combined diff and the tasks' briefs and runs nothing. The running checker (SC-5,
//! `firstmate::checker`) reads the same and adds proof: the app re-runs the check lines the tasks' briefs named on a read-only
//! copy of HEAD (`checker_copy`), through the same sandboxed runner the checks use, and a model from another family than the
//! worker's (`checker_family`) reads the claims, the diff and what those runs printed. It may ask for ONE more command, which
//! is run in the same copy under the same limits.
//!
//! Which review a ship check gets is the app's own "When the checker runs" setting (`checker_when::ship_review_runs`), never a
//! project's file. Nothing here lets the model overturn what the app saw:
//!
//! - a brief check that fails in the copy fails the review, whatever the model said;
//! - a command that could not run, or none run at all, keeps the answer from a clean pass: "with caveats", and the lines say
//!   what was not exercised;
//! - no checker to pick, a copy that can't be made, a call that fails or an answer that can't be read is "could not run".
//!   Never a pass.

use std::path::Path;

use crate::firstmate::brief_checks::{self, BriefCheck};
use crate::firstmate::checker::{self, RunAsk};
use crate::firstmate::gates::{CommandEvidence, Outcome as Ran, Runners};

use super::{one_line, review_prompt, review_step, short, Brief, Outcome, Range, Stage, Step};
use super::{DETAIL_MAX, LINE_MAX, REVIEW};

/// The most distinct check lines re-run for one ship check, across every task in the range.
pub(super) const LINES_MAX: usize = 24;

const PROTOCOL: &str = "You are the running checker for a ship check. You run nothing yourself. The app has already re-run the check \
commands the tasks' briefs named, in a read-only copy of the project at the commit being checked, and kept their exact output \
(above): trust that output over any claim. You may ask the app for ONE more command. To do that, reply with a single line \
`RUN: <command>` and nothing else: one line, under 300 characters, none of ; | & > < $ ` or a backslash, run in the read-only \
copy (nothing can be written there) with the same time limit. Anything else is refused. You then get its exact output and give \
the final answer. If you need no command, give the final answer now. The final answer is the one line of JSON above with two \
more keys: \"exercised\": [plain lines on what you ran or checked] and \"not_exercised\": [plain lines on what you did not or \
could not check].";

/// What the running review reads.
pub(super) struct Input<'a> {
    pub range: &'a Range,
    pub briefs: &'a [Brief],
    pub diff: &'a str,
    /// The project's main checkout at HEAD (the copy is made from it).
    pub main: &'a Path,
    /// The check lines the tasks' briefs named, in task order.
    pub lines: Vec<BriefCheck>,
    /// The titles of tasks whose stored lines couldn't be read. Their lines are never taken to be none.
    pub unreadable: Vec<String>,
    pub now: i64,
}

fn could_not_run(why: impl AsRef<str>) -> Stage {
    Stage::one(Step::new(
        REVIEW,
        Outcome::CouldNotRun,
        format!("the running checker could not run: {}", why.as_ref()),
    ))
}

/// The distinct lines to re-run: the same command with the same expectation asked by two tasks is one run, and no more than
/// `LINES_MAX` are run. The second number is how many were left out.
pub(super) fn distinct(lines: &[BriefCheck]) -> (Vec<BriefCheck>, usize) {
    let mut kept: Vec<BriefCheck> = Vec::new();
    let mut left_out = 0;
    for line in lines {
        if kept
            .iter()
            .any(|seen| seen.command == line.command && seen.expect == line.expect)
        {
            continue;
        }
        if kept.len() >= LINES_MAX {
            left_out += 1;
            continue;
        }
        kept.push(line.clone());
    }
    (kept, left_out)
}

/// The review as the running checker. `runners` is the app's (or a test's stand-in): its checker pick, its read-only copy and
/// its model.
pub(super) fn run(input: &Input, runners: &dyn Runners) -> Stage {
    let head = short(&input.range.head).to_string();
    let Some(first) = input.briefs.first() else {
        // No task landed in the range: nothing to check against, exactly as the one-turn review says.
        return review_step(input.range, input.briefs, input.diff, &|_| {
            Err(String::new())
        });
    };
    // The worker's family is the first task's: a range of tasks has no one worker, and a different family from the first is
    // the checker the rule can promise.
    let pick = match runners.checker_pick(&first.id) {
        Ok(pick) => pick,
        Err(why) => return could_not_run(why),
    };
    let copy = match runners.read_only_copy(input.main) {
        Ok(copy) => copy,
        Err(why) => {
            return could_not_run(format!(
                "a read-only copy of {head} couldn't be made: {why}"
            ))
        }
    };
    let how = copy.how();

    // 1. The briefs' own check lines, re-run in the copy.
    let (lines, left_out) = distinct(&input.lines);
    let ran = brief_checks::run_lines(
        &lines,
        input.now,
        brief_checks::LINES_BUDGET,
        &mut |index, line| {
            runners.copy_run(
                &copy,
                &format!("ship-{index}"),
                &line.what,
                &line.command,
                brief_checks::LINE_TIMEOUT_SECONDS,
            )
        },
    );
    let mut commands: Vec<CommandEvidence> = ran
        .into_iter()
        .map(|(judged, _)| checker::trusted_in(how, judged.evidence))
        .collect();
    let brief_count = commands.len();

    // 2. The first call: the review's own prompt, what the app re-ran, and the protocol.
    let prompt_one = format!(
        "{}\n\n## Commands the app re-ran in a read-only copy of {head}\n{}\n\n{PROTOCOL}",
        review_prompt(input.range, input.briefs, input.diff),
        checker::commands_text(&commands, !lines.is_empty()),
    );
    let first_said = match runners.checker_model(&prompt_one, &pick.cli, &pick.model) {
        Ok(said) => said,
        Err(why) => return could_not_run(format!("its call failed: {why}")),
    };
    let mut calls = 1u8;

    // 3. The one extra command, if it asked and it may.
    let ask = checker::parse_run(&first_said);
    let said = match &ask {
        RunAsk::None => first_said.clone(),
        RunAsk::Accepted { command, .. } => {
            let raw = runners.copy_run(
                &copy,
                "extra",
                "the checker's own command",
                command,
                brief_checks::LINE_TIMEOUT_SECONDS,
            );
            let evidence = checker::evidence_of("the checker's own command", command, &raw, how);
            commands.push(evidence.clone());
            calls = 2;
            match runners.checker_model(
                &checker::second_prompt(&prompt_one, &first_said, &ask, Some(&evidence)),
                &pick.cli,
                &pick.model,
            ) {
                Ok(said) => said,
                Err(why) => return could_not_run(format!("its second call failed: {why}")),
            }
        }
        RunAsk::Refused { .. } => {
            calls = 2;
            match runners.checker_model(
                &checker::second_prompt(&prompt_one, &first_said, &ask, None),
                &pick.cli,
                &pick.model,
            ) {
                Ok(said) => said,
                Err(why) => return could_not_run(format!("its second call failed: {why}")),
            }
        }
    };

    // 4. The answer, read as the one-turn review's is, then held to what the app saw.
    let mut stage = review_step(input.range, input.briefs, input.diff, &|_| Ok(said.clone()));
    let extras = checker::parse_extras(&said);
    let ran_any = commands.iter().any(|run| run.outcome != Ran::NotRun);
    let not_run = commands.iter().any(|run| run.outcome == Ran::NotRun);
    let failed: Vec<&CommandEvidence> = commands
        .iter()
        .take(brief_count)
        .filter(|run| run.outcome == Ran::Failed)
        .collect();
    if let Some(step) = stage.steps.first_mut() {
        if !failed.is_empty() {
            // A brief check that fails where the app ran it is the app's word, and the model can't talk it away.
            let mut found: Vec<String> = failed
                .iter()
                .map(|run| {
                    format!(
                        "A brief check fails in the read-only copy: `{}`{}.",
                        one_line(&run.command, 120),
                        run.exit_code
                            .map(|code| format!(" (exit {code})"))
                            .unwrap_or_default()
                    )
                })
                .collect();
            if let Some(said) = step.output_tail.take() {
                found.push(said);
            }
            step.outcome = Outcome::Failed;
            step.detail = format!("{} brief check(s) fail in the read-only copy", failed.len());
            step.output_tail = Some(found.join("\n"));
        } else if step.outcome == Outcome::Passed
            && (not_run || !ran_any)
            && !step.detail.starts_with("with caveats")
        {
            step.detail = format!("with caveats: {}", step.detail);
        }
        let family = pick
            .note
            .as_deref()
            .map(|note| format!(" {note}"))
            .unwrap_or_default();
        step.detail = one_line(
            &format!(
                "Checked by {} on a read-only copy of {head} ({} check command{} re-run, {calls} model call{}).{family} {}",
                pick.label(),
                commands.len(),
                if commands.len() == 1 { "" } else { "s" },
                if calls == 1 { "" } else { "s" },
                step.detail
            ),
            DETAIL_MAX,
        );
    }

    // What was not exercised: the app's own words first, then the checker's.
    let push = |stage: &mut Stage, line: String| {
        let line = one_line(&line, LINE_MAX);
        if !line.is_empty() && !stage.not_tested.contains(&line) {
            stage.not_tested.push(line);
        }
    };
    for title in &input.unreadable {
        push(
            &mut stage,
            format!("The check lines of \"{title}\" couldn't be read, so none were re-run for it."),
        );
    }
    if left_out > 0 {
        push(
            &mut stage,
            format!(
                "{left_out} more check line{} were not re-run: the checker re-runs at most {LINES_MAX}.",
                if left_out == 1 { "" } else { "s" }
            ),
        );
    }
    if lines.is_empty() && input.unreadable.is_empty() {
        push(
            &mut stage,
            "No task's brief named a check command, so the checker ran nothing in the copy.".into(),
        );
    }
    for run in commands.iter().filter(|run| run.outcome == Ran::NotRun) {
        push(&mut stage, checker::exercised_line(run));
    }
    for line in extras.not_exercised {
        push(&mut stage, line);
    }
    stage
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::firstmate::brief_checks::{Ended, RawRun};
    use crate::firstmate::checker_copy::{CopyHow, ReadOnlyCopy};
    use crate::firstmate::checker_family::Pick;
    use crate::firstmate::gates::Runners;

    /// A scripted app: the checker it picks, whether it can make a copy, how each command ends and what the model says.
    struct Lab {
        pick: Result<Pick, String>,
        copy: Result<CopyHow, String>,
        replies: RefCell<Vec<Result<String, String>>>,
        asked: RefCell<Vec<(String, String, String)>>,
        ran: RefCell<Vec<(String, String)>>,
        runs: RefCell<Vec<RawRun>>,
        cheap_asked: RefCell<u32>,
        picked_for: RefCell<Vec<String>>,
    }

    impl Lab {
        fn new() -> Lab {
            Lab {
                pick: Ok(codex()),
                copy: Ok(CopyHow::Clone),
                replies: RefCell::new(Vec::new()),
                asked: RefCell::new(Vec::new()),
                ran: RefCell::new(Vec::new()),
                runs: RefCell::new(Vec::new()),
                cheap_asked: RefCell::new(0),
                picked_for: RefCell::new(Vec::new()),
            }
        }
        fn says(self, replies: &[&str]) -> Lab {
            *self.replies.borrow_mut() = replies.iter().map(|r| Ok((*r).to_string())).collect();
            self
        }
        fn then_runs(self, runs: Vec<RawRun>) -> Lab {
            *self.runs.borrow_mut() = runs;
            self
        }
    }

    fn codex() -> Pick {
        Pick {
            cli: "codex".into(),
            model: String::new(),
            strong_model: String::new(),
            note: None,
        }
    }

    impl Runners for Lab {
        fn checks(
            &self,
            _checkout: &Path,
            _named: &[String],
            _changed: &[String],
        ) -> Result<Vec<CommandEvidence>, String> {
            Ok(Vec::new())
        }
        fn routes(&self, _checkout: &Path) -> Option<CommandEvidence> {
            None
        }
        fn verdict(&self, _prompt: &str) -> Result<String, String> {
            *self.cheap_asked.borrow_mut() += 1;
            Err("the one-turn review is not scripted".into())
        }
        fn checker_pick(&self, delegation_id: &str) -> Result<Pick, String> {
            self.picked_for.borrow_mut().push(delegation_id.into());
            self.pick.clone()
        }
        fn read_only_copy(&self, _checkout: &Path) -> Result<ReadOnlyCopy, String> {
            self.copy.clone().map(ReadOnlyCopy::stand_in)
        }
        fn copy_run(
            &self,
            _copy: &ReadOnlyCopy,
            id: &str,
            _what: &str,
            command: &str,
            _timeout_seconds: u64,
        ) -> RawRun {
            self.ran.borrow_mut().push((id.into(), command.into()));
            let mut runs = self.runs.borrow_mut();
            if runs.is_empty() {
                exit(0, "ok")
            } else {
                runs.remove(0)
            }
        }
        fn checker_model(&self, prompt: &str, cli: &str, model: &str) -> Result<String, String> {
            self.asked
                .borrow_mut()
                .push((prompt.into(), cli.into(), model.into()));
            let mut replies = self.replies.borrow_mut();
            if replies.is_empty() {
                Err("no reply scripted".into())
            } else {
                replies.remove(0)
            }
        }
    }

    fn exit(code: i32, output: &str) -> RawRun {
        RawRun {
            ended: Ended::Exited(Some(code)),
            output: output.into(),
            seconds: 0.2,
        }
    }

    fn line(what: &str, command: &str) -> BriefCheck {
        BriefCheck {
            what: what.into(),
            command: command.into(),
            expect: None,
            passes: None,
            ran_at: None,
            output_tail: None,
        }
    }

    fn range() -> Range {
        Range {
            head: "0123456789abcdef0123456789abcdef01234567".into(),
            base: Some("fedcba9876543210fedcba9876543210fedcba98".into()),
            commits: 3,
            since_ms: 0,
            until_ms: 10,
        }
    }

    fn briefs() -> Vec<Brief> {
        vec![
            Brief {
                id: "t-one".into(),
                title: "Fix the save".into(),
                brief: "Fix the save bug".into(),
                goal: "Saving works".into(),
            },
            Brief {
                id: "t-two".into(),
                title: "Add the export".into(),
                brief: "Add export".into(),
                goal: "Export works".into(),
            },
        ]
    }

    const VERIFIED: &str = r#"{"verdict":"verified","why":"the diff shows both","claims":[{"claim":"Saving works","observed":"the fix is there","status":"verified"},{"claim":"Export works","observed":"the export is there","status":"verified"}],"frauds":[],"exercised":["Read the diff"],"not_exercised":["The export on a large file"]}"#;
    const REFUTED: &str = r#"{"verdict":"refuted","why":"the export is missing","claims":[{"claim":"Export works","observed":"nothing","status":"refuted"}],"frauds":[]}"#;

    fn go(lab: &Lab, lines: Vec<BriefCheck>) -> Stage {
        let range = range();
        let briefs = briefs();
        run(
            &Input {
                range: &range,
                briefs: &briefs,
                diff: "diff --git a/a b/a\n+x\n",
                main: Path::new("/work/app"),
                lines,
                unreadable: Vec::new(),
                now: 5,
            },
            lab,
        )
    }

    #[test]
    fn the_briefs_check_lines_are_re_run_in_the_copy_and_another_family_reads_the_proof() {
        let lab = Lab::new().says(&[VERIFIED]);
        let stage = go(
            &lab,
            vec![
                line("saving", "npm test -- save"),
                line("exporting", "npm test -- export"),
            ],
        );
        // Both commands ran in the copy, then the model was asked once, on the other family, and the cheap review never ran.
        let ran: Vec<String> = lab.ran.borrow().iter().map(|(_, c)| c.clone()).collect();
        assert_eq!(ran, ["npm test -- save", "npm test -- export"]);
        let asked = lab.asked.borrow();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].1, "codex");
        assert!(asked[0].0.contains("npm test -- save"), "{}", asked[0].0);
        assert!(
            asked[0].0.contains("Fix the save"),
            "the review's own briefs"
        );
        assert!(asked[0]
            .0
            .contains("Commands the app re-ran in a read-only copy of 0123456"));
        assert_eq!(*lab.cheap_asked.borrow(), 0);
        // The checker is picked for the first task's worker.
        assert_eq!(*lab.picked_for.borrow(), ["t-one"]);
        assert_eq!(stage.steps.len(), 1);
        assert_eq!(stage.steps[0].name, "Review");
        assert_eq!(stage.steps[0].outcome, Outcome::Passed);
        let detail = &stage.steps[0].detail;
        assert!(
            detail.starts_with("Checked by Codex on a read-only copy of 0123456"),
            "{detail}"
        );
        assert!(
            detail.contains("2 check commands re-run, 1 model call)"),
            "{detail}"
        );
        // What the checker said it did not exercise is under "Not tested".
        assert!(stage
            .not_tested
            .iter()
            .any(|l| l.contains("export on a large file")));
    }

    #[test]
    fn a_brief_check_that_fails_in_the_copy_fails_the_review_whatever_the_model_says() {
        let lab = Lab::new()
            .says(&[VERIFIED])
            .then_runs(vec![exit(0, "ok"), exit(1, "1 failed: export")]);
        let stage = go(
            &lab,
            vec![
                line("saving", "npm test -- save"),
                line("exporting", "npm test -- export"),
            ],
        );
        assert_eq!(stage.steps[0].outcome, Outcome::Failed);
        assert!(stage.steps[0]
            .detail
            .contains("1 brief check(s) fail in the read-only copy"));
        let tail = stage.steps[0].output_tail.as_deref().unwrap();
        assert!(tail.contains("`npm test -- export` (exit 1)"), "{tail}");
    }

    #[test]
    fn the_models_own_refusal_still_fails_the_review() {
        let lab = Lab::new().says(&[REFUTED]);
        let stage = go(&lab, vec![line("saving", "npm test")]);
        assert_eq!(stage.steps[0].outcome, Outcome::Failed);
        assert!(stage.steps[0].detail.contains("the export is missing"));
    }

    #[test]
    fn no_command_run_or_one_that_could_not_run_is_a_pass_with_caveats_never_clean() {
        // No task named a check line.
        let none = Lab::new().says(&[VERIFIED]);
        let stage = go(&none, Vec::new());
        assert_eq!(stage.steps[0].outcome, Outcome::Passed);
        assert!(
            stage.steps[0].detail.contains("with caveats:"),
            "{}",
            stage.steps[0].detail
        );
        assert!(stage
            .not_tested
            .iter()
            .any(|l| l.contains("named a check command")));
        // A command that never started.
        let stuck = Lab::new()
            .says(&[VERIFIED])
            .then_runs(vec![RawRun::not_started("the sandbox refused it")]);
        let stage = go(&stuck, vec![line("saving", "npm test")]);
        assert_eq!(stage.steps[0].outcome, Outcome::Passed);
        assert!(
            stage.steps[0].detail.contains("with caveats:"),
            "{}",
            stage.steps[0].detail
        );
        assert!(
            stage.not_tested.iter().any(|l| l.contains("could not run")),
            "{:?}",
            stage.not_tested
        );
    }

    #[test]
    fn a_failure_in_a_worktree_copy_with_no_installed_dependencies_proves_nothing() {
        let mut lab = Lab::new()
            .says(&[VERIFIED])
            .then_runs(vec![exit(1, "sh: vitest: not found")]);
        lab.copy = Ok(CopyHow::Worktree);
        let stage = go(&lab, vec![line("saving", "npm test")]);
        assert_ne!(stage.steps[0].outcome, Outcome::Failed);
        assert!(
            stage.not_tested.iter().any(|l| l.contains("could not run")),
            "{:?}",
            stage.not_tested
        );
    }

    #[test]
    fn one_more_command_is_run_in_the_copy_and_the_second_call_gets_its_output() {
        let lab = Lab::new()
            .says(&["RUN: npm run lint", VERIFIED])
            .then_runs(vec![exit(0, "ok"), exit(0, "lint clean")]);
        let stage = go(&lab, vec![line("saving", "npm test")]);
        assert_eq!(lab.asked.borrow().len(), 2);
        assert!(lab.asked.borrow()[1].0.contains("lint clean"));
        let ids: Vec<String> = lab.ran.borrow().iter().map(|(id, _)| id.clone()).collect();
        assert_eq!(ids, ["ship-0", "extra"]);
        assert!(
            stage.steps[0]
                .detail
                .contains("2 check commands re-run, 2 model calls)"),
            "{}",
            stage.steps[0].detail
        );
        // A command the rules refuse is not run, and the checker is still asked for its answer.
        let refused = Lab::new().says(&["RUN: rm -rf / ; echo", VERIFIED]);
        let stage = go(&refused, vec![line("saving", "npm test")]);
        assert_eq!(
            refused.ran.borrow().len(),
            1,
            "only the brief's own line ran"
        );
        assert_eq!(refused.asked.borrow().len(), 2);
        assert_eq!(stage.steps[0].outcome, Outcome::Passed);
    }

    #[test]
    fn no_checker_no_copy_no_answer_or_a_garbled_one_could_not_run_and_is_never_a_pass() {
        let mut no_checker = Lab::new();
        no_checker.pick = Err(
            "No checker is available: Claude, Codex or Grok must be installed and signed in."
                .into(),
        );
        let stage = go(&no_checker, vec![line("a", "b")]);
        assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
        assert!(stage.steps[0].detail.contains("No checker is available"));
        assert!(
            no_checker.ran.borrow().is_empty(),
            "nothing ran without a checker"
        );

        let mut no_copy = Lab::new();
        no_copy.copy = Err("the disk is full".into());
        let stage = go(&no_copy, vec![line("a", "b")]);
        assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
        assert!(stage.steps[0]
            .detail
            .contains("read-only copy of 0123456 couldn't be made"));

        let no_answer = Lab::new();
        let stage = go(&no_answer, vec![line("a", "b")]);
        assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
        assert!(stage.steps[0].detail.contains("its call failed"));

        let garbled = Lab::new().says(&["I think it looks fine."]);
        let stage = go(&garbled, vec![line("a", "b")]);
        assert_eq!(
            stage.steps[0].outcome,
            Outcome::CouldNotRun,
            "{:?}",
            stage.steps[0]
        );

        let second_fails = Lab::new().says(&["RUN: npm test"]);
        let stage = go(&second_fails, vec![line("a", "b")]);
        assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
        assert!(stage.steps[0].detail.contains("second call failed"));
    }

    #[test]
    fn a_verified_answer_that_names_problems_is_not_trusted() {
        let lab = Lab::new().says(&[
            r#"{"verdict":"verified","why":"fine","claims":[{"claim":"x","observed":"y","status":"verified"}],"frauds":["Weakened test: a.test.ts"]}"#,
        ]);
        let stage = go(&lab, vec![line("a", "b")]);
        assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
    }

    #[test]
    fn the_same_command_from_two_tasks_runs_once_and_the_cap_says_what_it_left_out() {
        let (kept, left_out) = distinct(&[
            line("saving", "npm test"),
            line("exporting", "npm test"),
            BriefCheck {
                expect: Some("3 passed".into()),
                ..line("exporting", "npm test")
            },
        ]);
        assert_eq!(
            kept.len(),
            2,
            "the same command with another expectation is another check"
        );
        assert_eq!(left_out, 0);
        let many: Vec<BriefCheck> = (0..30)
            .map(|n| line("n", &format!("npm run check-{n}")))
            .collect();
        let (kept, left_out) = distinct(&many);
        assert_eq!(kept.len(), LINES_MAX);
        assert_eq!(left_out, 6);
        let lab = Lab::new().says(&[VERIFIED]);
        let stage = go(&lab, many);
        assert_eq!(lab.ran.borrow().len(), LINES_MAX);
        assert!(
            stage
                .not_tested
                .iter()
                .any(|l| l.contains("6 more check lines were not re-run")),
            "{:?}",
            stage.not_tested
        );
    }

    #[test]
    fn a_task_whose_lines_could_not_be_read_is_named_never_taken_to_have_none() {
        let lab = Lab::new().says(&[VERIFIED]);
        let range = range();
        let briefs = briefs();
        let stage = run(
            &Input {
                range: &range,
                briefs: &briefs,
                diff: "",
                main: Path::new("/work/app"),
                lines: Vec::new(),
                unreadable: vec!["Fix the save".into()],
                now: 5,
            },
            &lab,
        );
        assert!(
            stage
                .not_tested
                .iter()
                .any(|l| l.contains("\"Fix the save\" couldn't be read")),
            "{:?}",
            stage.not_tested
        );
        assert!(
            !stage
                .not_tested
                .iter()
                .any(|l| l.contains("named a check command")),
            "it is not 'no task named one'"
        );
    }

    #[test]
    fn the_family_note_travels_with_the_verdict_when_only_one_family_is_signed_in() {
        let mut lab = Lab::new().says(&[VERIFIED]);
        lab.pick = Ok(Pick {
            cli: "claude".into(),
            model: "opus".into(),
            strong_model: "opus".into(),
            note: Some("Checked by the same family: only Claude is signed in.".into()),
        });
        let stage = go(&lab, vec![line("a", "b")]);
        assert!(
            stage.steps[0]
                .detail
                .contains("Checked by the same family: only Claude is signed in."),
            "{}",
            stage.steps[0].detail
        );
        assert!(stage.steps[0]
            .detail
            .starts_with("Checked by Claude (opus)"));
    }

    #[test]
    fn no_task_in_the_range_is_not_run_and_asks_nothing() {
        let lab = Lab::new();
        let range = range();
        let stage = run(
            &Input {
                range: &range,
                briefs: &[],
                diff: "",
                main: Path::new("/work/app"),
                lines: Vec::new(),
                unreadable: Vec::new(),
                now: 5,
            },
            &lab,
        );
        assert_eq!(stage.steps[0].outcome, Outcome::NotRun);
        assert!(lab.asked.borrow().is_empty());
        assert!(lab.picked_for.borrow().is_empty());
    }
}
