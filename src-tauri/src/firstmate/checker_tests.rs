//! SC-5: the running checker. The RUN line's rules, and the two-call flow with a fake model and a fake runner: no real CLI,
//! no real copy. What the checker must never do is the point: pass what it could not check, run a command it was not allowed
//! to, or let its own word overturn what the app saw.

use std::cell::RefCell;
use std::path::Path;

use super::*;
use crate::firstmate::brief_checks::{BriefRound, Ended};
use crate::firstmate::checker_copy::CopyHow;
use crate::firstmate::dismissals::{Dismissed, Ground, Standing};
use crate::firstmate::gates::{GateKind, GatePlan};
use crate::firstmate::testing_mode::{self, ModePlan};

// ---- the RUN line --------------------------------------------------------------------------------------------------------

#[test]
fn a_plain_command_is_allowed() {
    for command in [
        "npm test -- --run src/a.test.ts",
        "git diff --stat",
        "cargo test --manifest-path src-tauri/Cargo.toml --lib firstmate::",
        "ls -la src",
        "grep -rn 'TODO' src",
        "node scripts/check.mjs --strict",
        // A path with a space or unicode, and a Windows separator, are ordinary characters.
        "cat \"My Notes/\u{e9}tude.txt\"",
    ] {
        assert_eq!(command_refusal(command), None, "{command}");
    }
}

#[test]
fn a_shell_operator_or_an_escape_is_refused_and_says_which() {
    for (bad, command) in [
        (';', "npm test; rm -rf /"),
        ('|', "cat a | sh"),
        ('&', "npm test && curl x"),
        ('&', "sleep 100 &"),
        ('>', "echo x > a.txt"),
        ('<', "sh < script"),
        ('$', "echo $HOME"),
        ('$', "echo $(whoami)"),
        ('`', "echo `whoami`"),
        ('\\', "echo a\\nb"),
    ] {
        let why = command_refusal(command).unwrap_or_else(|| panic!("{command:?} was allowed"));
        assert!(why.contains(bad), "{command:?}: {why}");
    }
}

#[test]
fn a_command_under_three_hundred_characters_is_allowed_and_three_hundred_is_not() {
    let under = format!("echo {}", "a".repeat(RUN_LIMIT - 1 - 5));
    assert_eq!(under.chars().count(), RUN_LIMIT - 1);
    assert_eq!(command_refusal(&under), None);
    let over = format!("echo {}", "a".repeat(RUN_LIMIT - 5));
    assert_eq!(over.chars().count(), RUN_LIMIT);
    assert!(command_refusal(&over).unwrap().contains("300"));
    // Characters are counted, not bytes: 299 two-byte characters are under.
    assert_eq!(command_refusal(&"\u{e9}".repeat(RUN_LIMIT - 1)), None);
}

#[test]
fn an_empty_command_or_one_with_a_control_character_is_refused() {
    assert!(command_refusal("").is_some());
    assert!(command_refusal("   ").is_some());
    assert!(command_refusal("ls\u{0}").is_some());
    assert!(command_refusal("ls\r-la").is_some());
    assert!(command_refusal("ls\t-la").is_some());
}

#[test]
fn a_reply_with_no_run_line_asks_for_nothing() {
    for reply in [
        "",
        "{\"verdict\": \"verified\"}",
        "I would run npm test, but I can't.",
        // The word has to start the line and be followed by its colon.
        "Please RUN: this later",
        "running: npm test",
        "RUN npm test",
        "{\"why\": \"RUN: npm test\"}",
    ] {
        assert_eq!(parse_run(reply), RunAsk::None, "{reply:?}");
    }
}

#[test]
fn one_run_line_is_taken_with_its_marks_and_case_and_line_ends() {
    let accepted = |command: &str| RunAsk::Accepted {
        command: command.into(),
        extra_ignored: false,
    };
    assert_eq!(parse_run("RUN: npm test"), accepted("npm test"));
    assert_eq!(parse_run("run: npm test"), accepted("npm test"));
    assert_eq!(parse_run("  - RUN:   npm test  "), accepted("npm test"));
    assert_eq!(parse_run("> * RUN: git log -1"), accepted("git log -1"));
    assert_eq!(
        parse_run("I need one more.\r\nRUN: ls src\r\n"),
        accepted("ls src")
    );
    // A whole command in one pair of backticks is a quotation mark, not a substitution.
    assert_eq!(parse_run("RUN: `npm test`"), accepted("npm test"));
    // A backtick inside the command is a substitution, and is refused.
    assert!(matches!(
        parse_run("RUN: echo `whoami`"),
        RunAsk::Refused { .. }
    ));
    assert!(matches!(
        parse_run("RUN: `echo `whoami``"),
        RunAsk::Refused { .. }
    ));
}

#[test]
fn only_the_first_of_two_run_lines_counts_and_a_refused_first_is_not_replaced_by_the_second() {
    assert_eq!(
        parse_run("RUN: npm test\nRUN: git log"),
        RunAsk::Accepted {
            command: "npm test".into(),
            extra_ignored: true
        }
    );
    match parse_run("RUN: npm test; rm x\nRUN: git log") {
        RunAsk::Refused {
            command,
            why,
            extra_ignored,
        } => {
            assert_eq!(command, "npm test; rm x");
            assert!(why.contains(';'));
            assert!(extra_ignored);
        }
        other => panic!("{other:?}"),
    }
    match parse_run("RUN:") {
        RunAsk::Refused { why, .. } => assert!(why.contains("no command")),
        other => panic!("{other:?}"),
    }
}

// ---- the flow ------------------------------------------------------------------------------------------------------------

/// A fake model and a fake runner: what the checker is told is kept, and what it asked for is scripted.
struct Lab {
    pick: Result<Pick, String>,
    copy: Result<CopyHow, String>,
    replies: RefCell<Vec<Result<String, String>>>,
    /// `(prompt, cli, model)` of each model call.
    asked: RefCell<Vec<(String, String, String)>>,
    /// `(run id, command)` of each command run in the copy.
    ran: RefCell<Vec<(String, String)>>,
    /// How the commands end, in order; one past the list exits 0 and prints `ok`.
    runs: RefCell<Vec<RawRun>>,
    copies_made: RefCell<u32>,
    /// How often the cheap check was asked: never, when the running checker runs.
    cheap_asked: RefCell<u32>,
    /// PT-1: the end-to-end replay the project's proof tools give back, and how often it was asked for.
    replay: RefCell<Vec<crate::proof_tools::ToolRun>>,
    replayed: RefCell<u32>,
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
            copies_made: RefCell::new(0),
            cheap_asked: RefCell::new(0),
            replay: RefCell::new(Vec::new()),
            replayed: RefCell::new(0),
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
        Err("the cheap check is not scripted".into())
    }
    fn checker_pick(&self, _delegation_id: &str) -> Result<Pick, String> {
        self.pick.clone()
    }
    fn read_only_copy(&self, _checkout: &Path) -> Result<ReadOnlyCopy, String> {
        *self.copies_made.borrow_mut() += 1;
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
            RawRun {
                ended: Ended::Exited(Some(0)),
                output: "ok".into(),
                seconds: 0.1,
            }
        } else {
            runs.remove(0)
        }
    }
    fn proof_replay(
        &self,
        _checkout: &Path,
        _copy: &ReadOnlyCopy,
    ) -> Vec<crate::proof_tools::ToolRun> {
        *self.replayed.borrow_mut() += 1;
        self.replay.borrow().clone()
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

fn briefed(lines: Vec<BriefCheck>) -> BriefRound {
    BriefRound {
        lines,
        ..BriefRound::default()
    }
}

const VERIFIED: &str = r#"{"verdict":"verified","why":"the brief's checks pass and the diff does what it asks","claims":[{"claim":"Done.","observed":"the diff adds b","status":"verified"},{"claim":"I added b to app.ts.","observed":"the diff shows export const b","status":"verified"}],"frauds":[],"exercised":["Ran the unit tests"],"not_exercised":["Did not open the app"]}"#;

/// One round, as the checker sees it: the checker is asked with the cheap check's own prompt plus the proof.
fn check(
    brief: &BriefRound,
    history: Option<&RoundHistory>,
    dismissed: &[Dismissed],
    lab: &Lab,
) -> Checked {
    let plan = GatePlan {
        gates: vec![GateKind::Diff],
        checks: Vec::new(),
    };
    let input = RoundInput {
        delegation_id: "d-1",
        round: 2,
        checkout: Path::new("/work/tally"),
        plan: &plan,
        brief: "Add a b export to app.ts.",
        done_when: "app.ts exports b",
        report: "Done. I added b to app.ts.",
        now: 7,
        gate_owns_checks: false,
        facts: None,
        mode: None,
        brief_round: Some(brief),
        fix: None,
        history,
    };
    let claims = done_check::claims_of(input.report);
    run(
        &input,
        "diff --git a/app.ts b/app.ts\n+export const b = 2;\n",
        &[],
        &claims,
        &[],
        dismissed,
        history,
        lab,
    )
}

#[test]
fn it_re_runs_the_briefs_checks_in_the_copy_and_asks_once_when_it_needs_nothing_more() {
    let lab = Lab::new()
        .says(&[VERIFIED])
        .then_runs(vec![exit(0, "14 passed"), exit(0, "lint clean")]);
    let brief = briefed(vec![
        line("unit tests", "npm test"),
        line("lint", "npm run lint"),
    ]);
    let got = check(&brief, None, &[], &lab);
    // The brief's own commands ran in the copy, in order, under ids of their own.
    assert_eq!(
        *lab.ran.borrow(),
        vec![
            ("brief-0".to_string(), "npm test".to_string()),
            ("brief-1".to_string(), "npm run lint".to_string())
        ]
    );
    // One model call, to the checker the family rule picked, with the cheap check's prompt plus the proof.
    let asked = lab.asked.borrow();
    assert_eq!(asked.len(), 1);
    assert_eq!((asked[0].1.as_str(), asked[0].2.as_str()), ("codex", ""));
    let prompt = &asked[0].0;
    assert!(prompt.contains("## Brief\nAdd a b export to app.ts."));
    assert!(prompt.contains("## Definition of done\napp.ts exports b"));
    assert!(prompt.contains("## The worker's claims"));
    assert!(prompt.contains("## Diff\ndiff --git"));
    assert!(prompt.contains("## Commands the app re-ran in a read-only copy"));
    assert!(prompt.contains("`npm test`: passed"));
    assert!(prompt.contains("14 passed"));
    assert!(prompt.contains("RUN: <command>"));
    // The rule that said it could run nothing is gone, and the cheap check's other rules are kept.
    assert!(!prompt.contains("you can run nothing"));
    assert!(prompt.contains("a claim is not evidence"));
    // It is verified: every command passed and ran.
    assert_eq!(got.verdict.answer, Answer::Met);
    assert_eq!(got.verdict.label, Some(DoneLabel::Verified));
    assert!(got.record.ran);
    assert_eq!(got.record.calls, 1);
    assert_eq!(got.record.checker, "Codex");
    // The record keeps every command with the end of its output, and two plain lists.
    assert_eq!(got.record.commands.len(), 2);
    assert_eq!(got.record.commands[0].command, "npm test");
    assert_eq!(got.record.commands[0].output, "14 passed");
    assert_eq!(got.record.commands[0].outcome, Outcome::Passed);
    assert!(got
        .record
        .exercised
        .iter()
        .any(|l| l.contains("Ran `npm test`")));
    assert!(got
        .record
        .exercised
        .contains(&"Ran the unit tests".to_string()));
    assert!(got
        .record
        .not_exercised
        .contains(&"Did not open the app".to_string()));
    assert_eq!(*lab.copies_made.borrow(), 1);
}

#[test]
fn it_may_ask_for_one_more_command_which_runs_in_the_same_copy_and_goes_back_for_the_final_answer()
{
    let lab = Lab::new()
        .says(&[
            "I want to see the log.\nRUN: git log -1 --oneline",
            VERIFIED,
        ])
        .then_runs(vec![exit(0, "14 passed"), exit(0, "abc123 add b")]);
    let got = check(
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        &[],
        &lab,
    );
    assert_eq!(
        *lab.ran.borrow(),
        vec![
            ("brief-0".to_string(), "npm test".to_string()),
            ("extra".to_string(), "git log -1 --oneline".to_string())
        ]
    );
    let asked = lab.asked.borrow();
    assert_eq!(asked.len(), 2, "two calls, never more");
    // The second call has the first's prompt, what it said, and the command's exact output.
    let second = &asked[1].0;
    assert!(second.contains(&asked[0].0));
    assert!(second.contains("## Your reply"));
    assert!(second.contains("RUN: git log -1 --oneline"));
    assert!(second.contains("## The command you asked for, run in the read-only copy"));
    assert!(second.contains("abc123 add b"));
    assert!(second.contains("Now give the final answer"));
    assert_eq!(got.record.calls, 2);
    assert_eq!(
        got.record.run_line,
        Some(RunLine {
            asked: "git log -1 --oneline".into(),
            refused: None,
            extra_ignored: false
        })
    );
    // Its command is on the record beside the brief's.
    assert_eq!(got.record.commands.len(), 2);
    assert_eq!(got.record.commands[1].command, "git log -1 --oneline");
    assert_eq!(got.verdict.answer, Answer::Met);
}

#[test]
fn a_command_with_an_operator_is_refused_not_run_and_noted_and_the_answer_is_still_asked_for() {
    let lab = Lab::new().says(&["RUN: npm test && curl http://x", VERIFIED]);
    let got = check(
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        &[],
        &lab,
    );
    // Only the brief's own line ran: the refused command never reached the copy.
    assert_eq!(lab.ran.borrow().len(), 1);
    assert_eq!(lab.ran.borrow()[0].0, "brief-0");
    let asked = lab.asked.borrow();
    assert_eq!(asked.len(), 2);
    assert!(asked[1]
        .0
        .contains("## The command you asked for was refused"));
    assert!(asked[1].0.contains("was not run"));
    let run_line = got.record.run_line.expect("the refusal is on the record");
    assert!(run_line.refused.unwrap().contains('&'));
    assert_eq!(run_line.asked, "npm test && curl http://x");
    assert_eq!(got.record.commands.len(), 1);
    assert_eq!(got.verdict.answer, Answer::Met);
}

#[test]
fn two_run_lines_run_only_the_first_and_say_the_other_was_left_out() {
    let lab = Lab::new().says(&["RUN: git status --short\nRUN: git log", VERIFIED]);
    let got = check(&briefed(Vec::new()), None, &[], &lab);
    assert_eq!(
        *lab.ran.borrow(),
        vec![("extra".to_string(), "git status --short".to_string())]
    );
    assert!(got.record.run_line.unwrap().extra_ignored);
    assert!(lab.asked.borrow()[1]
        .0
        .contains("Only the first RUN line counts"));
}

#[test]
fn a_model_that_cannot_be_reached_is_could_not_run_and_never_a_pass() {
    let lab = Lab::new().then_runs(vec![exit(0, "14 passed")]);
    // No reply scripted: the call fails.
    let got = check(
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        &[],
        &lab,
    );
    assert_eq!(got.verdict.answer, Answer::Unsure);
    assert!(
        got.verdict.why.contains("could not run"),
        "{}",
        got.verdict.why
    );
    assert!(!got.record.ran);
    assert!(got
        .record
        .why_not
        .as_deref()
        .unwrap()
        .contains("its call failed"));
    // What ran before the call is still on the record.
    assert_eq!(got.record.commands.len(), 1);
    assert!(!got.record.not_exercised.is_empty());
}

#[test]
fn a_second_call_that_fails_is_could_not_run_too() {
    let lab = Lab::new();
    *lab.replies.borrow_mut() = vec![Ok("RUN: ls".into()), Err("it ran past 300 seconds".into())];
    let got = check(&briefed(Vec::new()), None, &[], &lab);
    assert_eq!(got.verdict.answer, Answer::Unsure);
    assert!(got
        .record
        .why_not
        .as_deref()
        .unwrap()
        .contains("second call failed"));
    assert_eq!(got.record.calls, 2);
    // The command it asked for ran, and is kept.
    assert_eq!(got.record.commands.len(), 1);
}

#[test]
fn an_answer_that_cannot_be_read_or_that_is_unsure_is_could_not_run_never_a_pass() {
    for reply in [
        "I think it is fine.",
        "",
        "{\"verdict\":\"unsure\",\"why\":\"I can't tell\"}",
        "{\"verdict\":\"fine\"}",
    ] {
        let lab = Lab::new().says(&[reply]);
        let got = check(&briefed(vec![line("t", "npm test")]), None, &[], &lab);
        assert_eq!(got.verdict.answer, Answer::Unsure, "{reply:?}");
        assert!(!got.record.ran, "{reply:?}");
        assert!(got.record.why_not.is_some(), "{reply:?}");
        assert_ne!(got.verdict.label, Some(DoneLabel::Verified));
    }
}

#[test]
fn a_brief_check_that_fails_in_the_copy_refutes_the_task_whatever_the_model_says() {
    let lab = Lab::new()
        .says(&[VERIFIED])
        .then_runs(vec![exit(1, "1 failed: sum is wrong")]);
    let got = check(
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        &[],
        &lab,
    );
    assert_eq!(got.verdict.answer, Answer::NotMet);
    assert_eq!(got.verdict.label, Some(DoneLabel::Refuted));
    assert!(
        got.verdict
            .frauds
            .iter()
            .any(|f| f.contains("A brief check fails in the read-only copy")
                && f.contains("npm test"))
    );
    assert_eq!(got.record.commands[0].outcome, Outcome::Failed);
    assert!(got
        .record
        .exercised
        .iter()
        .any(|l| l.contains("it failed (exit 1)")));
}

#[test]
fn a_command_that_could_not_run_keeps_it_from_being_verified() {
    let lab = Lab::new()
        .says(&[VERIFIED])
        .then_runs(vec![RawRun::not_started("the sandbox refused it")]);
    let got = check(
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        &[],
        &lab,
    );
    assert_eq!(got.verdict.answer, Answer::Met);
    assert_eq!(got.verdict.label, Some(DoneLabel::VerifiedWithCaveats));
    assert!(got
        .record
        .not_exercised
        .iter()
        .any(|l| l.contains("`npm test` could not run")));
}

#[test]
fn a_command_that_wrote_where_it_may_not_is_not_run_rather_than_passed() {
    // A build into a read-only tree fails with a permission error: the shell's "couldn't start" codes are not a verdict.
    let lab = Lab::new()
        .says(&[VERIFIED])
        .then_runs(vec![exit(127, "npm: command not found")]);
    let got = check(
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        &[],
        &lab,
    );
    assert_eq!(got.record.commands[0].outcome, Outcome::NotRun);
    assert_ne!(got.verdict.label, Some(DoneLabel::Verified));
}

#[test]
fn a_task_with_no_check_commands_is_never_verified_and_the_record_says_nothing_ran() {
    let lab = Lab::new().says(&[VERIFIED]);
    let got = check(&briefed(Vec::new()), None, &[], &lab);
    assert_eq!(got.verdict.answer, Answer::Met);
    assert_eq!(got.verdict.label, Some(DoneLabel::VerifiedWithCaveats));
    assert!(got.record.commands.is_empty());
    assert!(got
        .record
        .not_exercised
        .iter()
        .any(|l| l.starts_with("No command was run")));
    let prompt = &lab.asked.borrow()[0].0;
    assert!(prompt.contains("the brief named no check commands"));
}

#[test]
fn a_failure_in_a_copy_with_no_installed_dependencies_proves_nothing_about_the_work() {
    let lab = Lab {
        copy: Ok(CopyHow::Worktree),
        ..Lab::new()
    }
    .says(&[VERIFIED])
    .then_runs(vec![exit(1, "sh: vitest: not found")]);
    let got = check(
        &briefed(vec![line("unit tests", "npx vitest run")]),
        None,
        &[],
        &lab,
    );
    assert_eq!(got.record.commands[0].outcome, Outcome::NotRun);
    assert!(got.record.commands[0]
        .output
        .contains("none of the worker's installed dependencies"));
    // Not refuted by a copy that could not have passed, and not verified either.
    assert_eq!(got.verdict.answer, Answer::Met);
    assert_eq!(got.verdict.label, Some(DoneLabel::VerifiedWithCaveats));
}

#[test]
fn no_checker_a_copy_that_cannot_be_made_and_a_brief_with_no_definition_of_done_are_could_not_run()
{
    // No checker is signed in.
    let lab = Lab {
        pick: Err(
            "No checker is available: Claude, Codex or Grok must be installed and signed in."
                .into(),
        ),
        ..Lab::new()
    };
    let got = check(&briefed(Vec::new()), None, &[], &lab);
    assert_eq!(got.verdict.answer, Answer::Unsure);
    assert!(got.verdict.why.contains("No checker is available"));
    assert_eq!(
        *lab.copies_made.borrow(),
        0,
        "no copy is made for a checker that is not there"
    );
    assert!(lab.asked.borrow().is_empty());
    // The copy can't be made.
    let lab = Lab {
        copy: Err("the disk is full".into()),
        ..Lab::new()
    };
    let got = check(&briefed(Vec::new()), None, &[], &lab);
    assert_eq!(got.verdict.answer, Answer::Unsure);
    assert!(
        got.verdict.why.contains("read-only copy"),
        "{}",
        got.verdict.why
    );
    assert!(got.verdict.why.contains("the disk is full"));
    assert!(lab.ran.borrow().is_empty());
    assert!(lab.asked.borrow().is_empty());
    // The brief has no definition of done: nothing is made, and nothing is asked.
    let lab = Lab::new();
    let plan = GatePlan {
        gates: Vec::new(),
        checks: Vec::new(),
    };
    let got = run(
        &RoundInput {
            delegation_id: "d-1",
            round: 1,
            checkout: Path::new("/work"),
            plan: &plan,
            brief: "x",
            done_when: "  ",
            report: "Done.",
            now: 1,
            gate_owns_checks: false,
            facts: None,
            mode: None,
            brief_round: None,
            fix: None,
            history: None,
        },
        "",
        &[],
        &[],
        &[],
        &[],
        None,
        &lab,
    );
    assert_eq!(got.verdict.answer, Answer::Unsure);
    assert_eq!(*lab.copies_made.borrow(), 0);
    assert!(lab.asked.borrow().is_empty());
}

#[test]
fn the_row_says_when_the_checker_is_the_same_family() {
    let lab = Lab {
        pick: Ok(Pick {
            cli: "claude".into(),
            model: "opus".into(),
            strong_model: "opus".into(),
            note: Some("Checked by the same family: only Claude is signed in.".into()),
        }),
        ..Lab::new()
    }
    .says(&[VERIFIED]);
    let got = check(&briefed(vec![line("t", "npm test")]), None, &[], &lab);
    assert_eq!(got.record.checker, "Claude (opus)");
    assert_eq!(
        got.record.family_note.as_deref(),
        Some("Checked by the same family: only Claude is signed in.")
    );
    let markdown = evidence_lines(&got.record);
    assert!(markdown.contains("Running checker (Claude (opus))"));
    assert!(markdown.contains("Checked by the same family: only Claude is signed in."));
    assert!(markdown.contains("What I exercised:"));
    assert!(markdown.contains("What I did not:"));
    // The model it is asked on is the one the pick named.
    assert_eq!(lab.asked.borrow()[0].1, "claude");
    assert_eq!(lab.asked.borrow()[0].2, "opus");
}

#[test]
fn a_claim_the_checker_marks_refuted_refutes_the_task_even_when_it_says_verified() {
    let lab = Lab::new().says(&[r#"{"verdict":"verified","why":"fine","claims":[{"claim":"it exports b","observed":"it does not","status":"refuted"}]}"#]);
    let got = check(&briefed(vec![line("t", "npm test")]), None, &[], &lab);
    assert_eq!(got.verdict.answer, Answer::NotMet);
    assert_eq!(got.verdict.label, Some(DoneLabel::Refuted));
}

// ---- dismissed findings --------------------------------------------------------------------------------------------------

fn dismissed(number: usize, finding: &str) -> Dismissed {
    Dismissed {
        number,
        finding: finding.into(),
        ground: Ground::NoBasis,
        why: "a.log is ignored by git".into(),
        standing: Standing::NotRechecked,
    }
}

#[test]
fn the_checker_is_told_about_a_dismissed_finding_and_lets_it_go_unless_it_re_confirms_it_with_a_command(
) {
    let one = dismissed(1, "Debris: a.log");
    // It says the finding stands, and a command ran: it stands.
    let lab = Lab::new().says(&[r#"{"verdict":"refuted","why":"still there","dismissed":[{"number":1,"stands":true,"why":"git ls-files lists a.log"}]}"#]);
    let got = check(
        &briefed(vec![line("t", "git ls-files")]),
        None,
        std::slice::from_ref(&one),
        &lab,
    );
    assert_eq!(
        got.standing,
        vec![(
            1,
            Standing::Stands {
                proof: "git ls-files lists a.log".into()
            }
        )]
    );
    // It was told which finding and on what ground.
    let prompt = &lab.asked.borrow()[0].0;
    assert!(prompt.contains("## Findings the worker dismissed"));
    assert!(prompt.contains("Finding 1"));
    assert!(prompt.contains("Debris: a.log"));
    assert!(prompt.contains("[no-basis]"));
    assert!(prompt.contains("re-confirm it with a command"));

    // It says it stands but ran nothing: a word with no command behind it lets the finding go.
    let lab = Lab::new().says(&[r#"{"verdict":"verified","why":"ok","dismissed":[{"number":1,"stands":true,"why":"I just think so"}]}"#]);
    let got = check(&briefed(Vec::new()), None, std::slice::from_ref(&one), &lab);
    assert_eq!(got.standing, vec![(1, Standing::Dismissed)]);

    // It says it does not stand, or says nothing about it: let go.
    for reply in [
        r#"{"verdict":"verified","why":"ok","dismissed":[{"number":1,"stands":false,"why":"it is ignored"}]}"#,
        r#"{"verdict":"verified","why":"ok"}"#,
        r#"{"verdict":"verified","why":"ok","dismissed":[{"number":9,"stands":true,"why":"another"}]}"#,
    ] {
        let lab = Lab::new().says(&[reply]);
        let got = check(
            &briefed(vec![line("t", "npm test")]),
            None,
            std::slice::from_ref(&one),
            &lab,
        );
        assert_eq!(got.standing, vec![(1, Standing::Dismissed)], "{reply}");
    }
}

#[test]
fn the_rule_a_rewrite_named_is_in_the_prompt() {
    let history = RoundHistory {
        last_problems: Vec::new(),
        rule: Some("Never edit a test to make it pass".into()),
    };
    let lab = Lab::new().says(&[VERIFIED]);
    check(&briefed(Vec::new()), Some(&history), &[], &lab);
    let prompt = &lab.asked.borrow()[0].0;
    assert!(prompt.contains("rewritten after two failed rounds"));
    assert!(prompt.contains("Never edit a test to make it pass"));
}

// ---- the round, with the checker in it ---------------------------------------------------------------------------------------

/// A mode that runs no gate of its own and none of the brief's lines (`at-ship`, where only a risky diff gets the running
/// checker), so the checker is the only thing that judges and the one that runs the lines.
fn mode(checker: testing_mode::Checker) -> ModePlan {
    ModePlan {
        mode: crate::delivery::settings::TestingMode::AtShip,
        as_today: false,
        gates: Vec::new(),
        checks: Vec::new(),
        run_findings: true,
        fact_gap_filter: testing_mode::FactGapFilter::All,
        run_verdict: checker != testing_mode::Checker::None,
        checker,
        note: None,
    }
}

fn round_with(
    mode: &ModePlan,
    brief: &BriefRound,
    history: Option<&RoundHistory>,
    report: &str,
    lab: &Lab,
) -> gates::GateRecord {
    let plan = mode.gate_plan();
    gates::run_round(
        &RoundInput {
            delegation_id: "d-1",
            round: 2,
            checkout: Path::new("/no/such/checkout"),
            plan: &plan,
            brief: "Add a b export to app.ts.",
            done_when: "app.ts exports b",
            report,
            now: 7,
            gate_owns_checks: false,
            facts: None,
            mode: Some(mode),
            brief_round: Some(brief),
            fix: None,
            history,
        },
        lab,
    )
}

#[test]
fn a_round_in_full_mode_passes_only_through_the_running_checker_and_never_asks_the_cheap_one() {
    let lab = Lab::new()
        .says(&[VERIFIED])
        .then_runs(vec![exit(0, "14 passed")]);
    let record = round_with(
        &mode(testing_mode::Checker::Running),
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        "Done. I added b to app.ts.",
        &lab,
    );
    assert_eq!(*lab.cheap_asked.borrow(), 0);
    assert_eq!(record.verdict, gates::Verdict::Passed);
    assert_eq!(record.label, Some(DoneLabel::Verified));
    let checker = record
        .extras
        .checker
        .as_ref()
        .expect("the checker's part is on the record");
    assert!(checker.ran);
    assert_eq!(checker.commands.len(), 1);
    assert_eq!(checker.checker, "Codex");
    // The two lists and every command are in the evidence a PR or the Crew tab shows.
    let markdown = gates::evidence_markdown(&record);
    assert!(markdown.contains("Running checker (Codex)"));
    assert!(markdown.contains("What I exercised:"));
    assert!(markdown.contains("`npm test` (exit 0)"));
}

#[test]
fn the_tasks_row_says_so_when_the_checker_is_the_same_family() {
    let note = "Checked by the same family: only Claude is signed in.";
    let lab = Lab {
        pick: Ok(Pick {
            cli: "claude".into(),
            model: "opus".into(),
            strong_model: "opus".into(),
            note: Some(note.into()),
        }),
        ..Lab::new()
    }
    .says(&[VERIFIED]);
    let record = round_with(
        &mode(testing_mode::Checker::Running),
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        "Done. I added b to app.ts.",
        &lab,
    );
    assert_eq!(record.verdict, gates::Verdict::Passed);
    let lines: Vec<&str> = record.summary.lines().collect();
    // The verdict stays the first line, which is what the card shows; the note is on the next.
    assert!(!lines[0].contains("same family"), "{}", record.summary);
    assert!(lines.contains(&note), "{}", record.summary);
    // A different family says nothing.
    let lab = Lab::new().says(&[VERIFIED]);
    let record = round_with(
        &mode(testing_mode::Checker::Running),
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        "Done. I added b to app.ts.",
        &lab,
    );
    assert!(!record.summary.contains("same family"));
}

#[test]
fn a_running_checker_that_cannot_run_leaves_the_round_unsure_and_never_passed() {
    for lab in [
        // No model answers.
        Lab::new(),
        // No checker is signed in.
        Lab {
            pick: Err("No checker is available.".into()),
            ..Lab::new()
        },
        // No copy can be made.
        Lab {
            copy: Err("no space".into()),
            ..Lab::new()
        },
    ] {
        let record = round_with(
            &mode(testing_mode::Checker::Running),
            &briefed(vec![line("unit tests", "npm test")]),
            None,
            "Done. I added b to app.ts.",
            &lab,
        );
        assert_eq!(record.verdict, gates::Verdict::Unsure);
        assert_ne!(record.label, Some(DoneLabel::Verified));
        assert!(!record.extras.checker.as_ref().unwrap().ran);
        assert!(
            record.summary.contains("could not run"),
            "{}",
            record.summary
        );
    }
}

#[test]
fn a_failed_round_numbers_its_findings_and_tells_the_worker_how_to_dismiss_one() {
    let lab = Lab::new().says(&[
        r#"{"verdict":"refuted","why":"b is not exported","claims":[],"frauds":["Missing export: app.ts does not export b","Debris: a.log"]}"#,
    ]);
    let record = round_with(
        &mode(testing_mode::Checker::Running),
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        "Done. I added b to app.ts.",
        &lab,
    );
    assert_eq!(record.verdict, gates::Verdict::Failed);
    assert_eq!(
        record.problems(),
        vec!["Missing export: app.ts does not export b", "Debris: a.log"]
    );
    assert!(record.summary.contains(
        "Findings, numbered:\n1. Missing export: app.ts does not export b\n2. Debris: a.log"
    ));
    assert!(record
        .summary
        .contains("Dismiss <number>: <ground> - <one line why>"));
    // A pass has no list to number.
    let lab = Lab::new().says(&[VERIFIED]);
    let record = round_with(
        &mode(testing_mode::Checker::Running),
        &briefed(vec![line("unit tests", "npm test")]),
        None,
        "Done.",
        &lab,
    );
    assert!(!record.summary.contains("Findings, numbered"));
}

#[test]
fn a_dismissed_finding_is_let_go_by_a_running_checker_unless_it_re_confirms_it_with_a_command() {
    let history = RoundHistory {
        last_problems: vec![
            "Missing export: app.ts does not export b".into(),
            "Debris: a.log".into(),
        ],
        rule: None,
    };
    let report = "Done. I added b.\nDismiss 2: no-basis - a.log is in .gitignore\nDismiss 7: no-basis - there is no seventh\nDismiss 1: because - I disagree";
    // The checker lets it go: the round passes, and the record shows the dismissal and its ground.
    let lab = Lab::new().says(&[VERIFIED]);
    let record = round_with(
        &mode(testing_mode::Checker::Running),
        &briefed(vec![line("unit tests", "npm test")]),
        Some(&history),
        report,
        &lab,
    );
    assert_eq!(record.verdict, gates::Verdict::Passed);
    assert_eq!(record.extras.dismissed.len(), 1);
    assert_eq!(record.extras.dismissed[0].number, 2);
    assert_eq!(record.extras.dismissed[0].finding, "Debris: a.log");
    assert_eq!(record.extras.dismissed[0].ground, Ground::NoBasis);
    assert_eq!(record.extras.dismissed[0].standing, Standing::Dismissed);
    let markdown = gates::evidence_markdown(&record);
    assert!(
        markdown.contains("Finding 2 (dismissed): Debris: a.log [no-basis] a.log is in .gitignore")
    );
    // The checker was told about it.
    assert!(lab.asked.borrow()[0].0.contains("Finding 2"));
    // The checker re-confirms it with a command that ran: it stands, and the round fails.
    let lab = Lab::new().says(&[
        r#"{"verdict":"verified","why":"fine","dismissed":[{"number":2,"stands":true,"why":"git ls-files lists a.log"}]}"#,
    ]);
    let record = round_with(
        &mode(testing_mode::Checker::Running),
        &briefed(vec![line("tracked files", "git ls-files")]),
        Some(&history),
        report,
        &lab,
    );
    assert!(matches!(
        record.extras.dismissed[0].standing,
        Standing::Stands { .. }
    ));
    assert_eq!(record.verdict, gates::Verdict::Failed);
    assert!(record.problems().contains(&"Debris: a.log".to_string()));
}

#[test]
fn a_dismissal_changes_nothing_where_no_running_checker_looked() {
    let history = RoundHistory {
        last_problems: vec!["Debris: a.log".into()],
        rule: None,
    };
    let lab = Lab::new();
    let record = round_with(
        &mode(testing_mode::Checker::Cheap),
        &briefed(Vec::new()),
        Some(&history),
        "Done.\nDismiss 1: no-basis - it is ignored",
        &lab,
    );
    // It is on the record, and it says nobody re-checked it.
    assert_eq!(record.extras.dismissed.len(), 1);
    assert_eq!(record.extras.dismissed[0].standing, Standing::NotRechecked);
    assert!(record.extras.checker.is_none());
    assert!(gates::evidence_markdown(&record).contains("nothing re-checked it, so it stands"));
    assert_eq!(
        *lab.cheap_asked.borrow(),
        1,
        "the cheap check ran, not the running one"
    );
    assert!(lab.asked.borrow().is_empty());
}

// ---- the answer's extras -------------------------------------------------------------------------------------------------

#[test]
fn the_two_lists_and_the_dismissals_are_read_and_anything_else_is_left_out() {
    let extras = parse_extras(
        r#"Here you go: {"verdict":"verified","exercised":["Ran npm test","",7,"  Read   the diff  "],"not_exercised":["Did not open the app"],"dismissed":[{"number":2,"stands":true,"why":"saw it"},{"number":"3","stands":true},{"number":4},{"number":-1,"stands":true}]}"#,
    );
    assert_eq!(extras.exercised, vec!["Ran npm test", "Read the diff"]);
    assert_eq!(extras.not_exercised, vec!["Did not open the app"]);
    assert_eq!(extras.dismissed, vec![(2, true, "saw it".to_string())]);
    assert_eq!(parse_extras("no json here"), Extras::default());
    assert_eq!(parse_extras("{\"verdict\": 5}"), Extras::default());
    // The lists are bounded, line by line and in length.
    let many: Vec<String> = (0..30).map(|n| format!("\"line {n}\"")).collect();
    let long = "x".repeat(1_000);
    let big = parse_extras(&format!(
        "{{\"exercised\": [{}], \"not_exercised\": [\"{long}\"]}}",
        many.join(",")
    ));
    assert_eq!(big.exercised.len(), 10);
    assert_eq!(big.not_exercised[0].chars().count(), 240);
}

// ---- a write the read-only copy refused is not a refutation (lead's review, HIGH) ----------------------------------------

fn exited(code: i32, output: &str) -> RawRun {
    RawRun {
        ended: Ended::Exited(Some(code)),
        output: output.to_string(),
        seconds: 1.0,
    }
}

#[test]
fn a_cargo_build_the_clone_refused_to_write_is_not_run_and_not_refuted() {
    let raw = exited(
        101,
        "error: failed to open: /tmp/copy/target/debug/.cargo-lock\n\nCaused by:\n  Permission denied (os error 13)",
    );
    let evidence = evidence_of("the tests pass", "cargo test", &raw, CopyHow::Clone);
    assert_eq!(evidence.outcome, Outcome::NotRun, "{}", evidence.output);
    assert!(evidence
        .output
        .contains("could not write inside the read-only copy"));
    for refusal in [
        "Operation not permitted",
        "Read-only file system",
        "EACCES: permission denied, mkdir",
        "EPERM",
    ] {
        let evidence = evidence_of("x", "npm test", &exited(1, refusal), CopyHow::Clone);
        assert_eq!(evidence.outcome, Outcome::NotRun, "{refusal}");
    }
}

#[test]
fn a_plain_assertion_failure_in_the_clone_is_still_failed() {
    let raw = exited(
        101,
        "test math::adds ... FAILED\nassertion `left == right` failed\n  left: 3\n right: 4\ntest result: FAILED. 0 passed; 1 failed",
    );
    let evidence = evidence_of("the tests pass", "cargo test", &raw, CopyHow::Clone);
    assert_eq!(evidence.outcome, Outcome::Failed);
}

// ---- PT-1: a UI task's end-to-end replay in the copy -----------------------------------------------------------------------

fn e2e_replay(
    outcome: crate::proof_tools::Outcome,
    detail: &str,
    tail: Option<&str>,
) -> crate::proof_tools::ToolRun {
    crate::proof_tools::ToolRun {
        tool: crate::proof_tools::catalogue::find("e2e").expect("e2e is in the catalogue"),
        outcome,
        detail: detail.into(),
        lines: Vec::new(),
        command: Some("npx --no-install e2e run --strict-cache".into()),
        tail: tail.map(str::to_string),
        seconds: 1.0,
    }
}

/// One round with a testing mode, the way the gates hand it to the checker.
fn check_in(mode: Option<&ModePlan>, lab: &Lab) -> Checked {
    let plan = GatePlan {
        gates: vec![GateKind::Diff],
        checks: Vec::new(),
    };
    let brief = briefed(Vec::new());
    let input = RoundInput {
        delegation_id: "d-1",
        round: 1,
        checkout: Path::new("/work/tally"),
        plan: &plan,
        brief: "Change the button.",
        done_when: "the button says Save",
        report: "Done. I changed the button.",
        now: 7,
        gate_owns_checks: false,
        facts: None,
        mode,
        brief_round: Some(&brief),
        fix: None,
        history: None,
    };
    let claims = done_check::claims_of(input.report);
    run(
        &input,
        "diff --git a/src/App.tsx b/src/App.tsx\n+Save\n",
        &[],
        &claims,
        &[],
        &[],
        None,
        lab,
    )
}

fn mode_plan(mode: crate::delivery::settings::TestingMode) -> ModePlan {
    let changed = vec!["src/App.tsx".to_string()];
    testing_mode::gates_for(mode, None, &changed, true, false)
}

#[test]
fn in_full_the_projects_end_to_end_replay_runs_in_the_copy_and_is_kept_with_the_other_commands() {
    use crate::delivery::settings::TestingMode;
    let lab = Lab::new().says(&[VERIFIED]);
    *lab.replay.borrow_mut() = vec![e2e_replay(
        crate::proof_tools::Outcome::Passed,
        "replayed 3 steps",
        None,
    )];
    let got = check_in(Some(&mode_plan(TestingMode::Full)), &lab);
    assert_eq!(*lab.replayed.borrow(), 1, "the replay was asked for once");
    let replay = got
        .record
        .commands
        .iter()
        .find(|run| {
            run.command
                .starts_with("e2e: npx --no-install e2e run --strict-cache")
        })
        .unwrap_or_else(|| {
            panic!(
                "the replay is a command of the record: {:?}",
                got.record.commands
            )
        });
    assert_eq!(replay.outcome, Outcome::Passed);
}

#[test]
fn a_replay_the_copy_would_not_let_write_stays_did_not_run_and_is_not_a_refutation() {
    use crate::delivery::settings::TestingMode;
    let lab = Lab::new().says(&[VERIFIED]);
    *lab.replay.borrow_mut() = vec![e2e_replay(
        crate::proof_tools::Outcome::Failed,
        "1 step failed",
        Some("EACCES: permission denied, open '.e2e/cache/run.json'"),
    )];
    let got = check_in(Some(&mode_plan(TestingMode::Full)), &lab);
    let replay = got
        .record
        .commands
        .iter()
        .find(|run| run.command.starts_with("e2e:"))
        .expect("the replay is kept");
    assert_eq!(replay.outcome, Outcome::NotRun, "{}", replay.output);
    assert!(
        replay
            .output
            .contains("could not write inside the read-only copy"),
        "{}",
        replay.output
    );
    assert_ne!(
        got.verdict.answer,
        Answer::NotMet,
        "a refused write proves nothing about the work"
    );
}

#[test]
fn outside_full_the_checker_replays_nothing() {
    use crate::delivery::settings::TestingMode;
    for mode in [
        Some(mode_plan(TestingMode::Light)),
        Some(mode_plan(TestingMode::AtShip)),
        None,
    ] {
        let lab = Lab::new().says(&[VERIFIED]);
        *lab.replay.borrow_mut() = vec![e2e_replay(
            crate::proof_tools::Outcome::Passed,
            "replayed",
            None,
        )];
        let got = check_in(mode.as_ref(), &lab);
        assert_eq!(*lab.replayed.borrow(), 0, "{mode:?}");
        assert!(
            got.record
                .commands
                .iter()
                .all(|run| !run.command.starts_with("e2e:")),
            "{mode:?}"
        );
    }
}
