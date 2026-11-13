//! SC-5: the round cap and the rethink. Two failed rounds stop the raw findings and run one stronger-model step; the next
//! failure after it goes to the person as one decision; a rethink that can't run hands the work up and is never a verdict.

use std::cell::RefCell;
use std::path::Path;

use super::*;
use crate::delegations::{record, RecordInput};
use crate::firstmate::checker_family::Pick;
use crate::firstmate::done_check::{CodeFinding, FindingKind};
use crate::firstmate::gates::CommandEvidence;
use crate::session_store::SessionStore;

// ---- helpers -------------------------------------------------------------------------------------------------------------

fn round(number: u32, verdict: Verdict, problems: &[&str]) -> GateRecord {
    GateRecord {
        delegation_id: "d-1".into(),
        round: number,
        at: i64::from(number) * 10,
        verdict,
        gates: Vec::new(),
        check: None,
        summary: String::new(),
        label: None,
        findings: problems
            .iter()
            .map(|detail| CodeFinding {
                kind: FindingKind::Debris,
                file: None,
                detail: (*detail).to_string(),
            })
            .collect(),
        claims: Vec::new(),
        tree: None,
        checkout: None,
        testing_mode: None,
        note: None,
        brief_lines: Vec::new(),
        extras: RoundExtras::default(),
    }
}

/// A record as it is stored: it carries the ledger up to itself, with the step the app took after it.
fn stored(mut record: GateRecord, prior: &[GateRecord], step: Option<StepKind>) -> GateRecord {
    let mut ledger = Ledger::carried(prior);
    let mut row = row_of(&record);
    row.step = step;
    ledger.push(row);
    record.extras.ledger = ledger.rows;
    record.extras.next = step.map(|kind| NextStep {
        kind,
        ..NextStep::send_back()
    });
    record
}

struct Scripted {
    pick: Result<Pick, String>,
    replies: RefCell<Vec<Result<String, String>>>,
    asked: RefCell<Vec<(String, String, String)>>,
}

fn opus_checker() -> Pick {
    Pick {
        cli: "claude".into(),
        model: "sonnet".into(),
        strong_model: "opus".into(),
        note: None,
    }
}

impl Scripted {
    fn new(replies: &[Result<&str, &str>]) -> Scripted {
        Scripted {
            pick: Ok(opus_checker()),
            replies: RefCell::new(
                replies
                    .iter()
                    .map(|r| r.map(str::to_string).map_err(str::to_string))
                    .collect(),
            ),
            asked: RefCell::new(Vec::new()),
        }
    }
}

impl Runners for Scripted {
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
        panic!("the cheap check is not the rethink");
    }
    fn checker_pick(&self, _delegation_id: &str) -> Result<Pick, String> {
        self.pick.clone()
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

fn plan(this: &GateRecord, prior: &[GateRecord], runners: &Scripted) -> Planned {
    plan_next(
        this,
        prior,
        "d-1",
        "Fix the save bug on mission two.",
        "Saving works on mission two",
        "diff --git a/save.ts b/save.ts\n+  retries(3);\n",
        runners,
    )
}

const REWRITE: &str = "REWRITE\nRule: Never change a test to make it pass.\nFix the save bug in save.ts only. Leave the tests as they are.\nDone when: the existing tests pass unchanged.";

// ---- what happens after a failed round -------------------------------------------------------------------------------------

#[test]
fn the_step_after_a_failed_round_comes_from_how_many_failed_and_whether_a_rethink_answered() {
    // (failed rounds so far, this one included; a rethink already answered) -> what happens
    for (failed, rethought, want) in [
        (1, false, Step::SendBack),
        (2, false, Step::Rethink),
        (3, false, Step::Rethink),
        (5, false, Step::Rethink),
        // Any failure after a rethink goes to the person, however few rounds came before.
        (1, true, Step::Person),
        (2, true, Step::Person),
        (3, true, Step::Person),
        (7, true, Step::Person),
    ] {
        assert_eq!(
            next_step(failed, rethought),
            want,
            "{failed} failed, rethought {rethought}"
        );
    }
    assert_eq!(FAILED_BEFORE_RETHINK, 2);
}

#[test]
fn the_first_failure_sends_the_findings_back_and_asks_no_model() {
    let runners = Scripted::new(&[]);
    let planned = plan(
        &round(1, Verdict::Failed, &["a.log left behind"]),
        &[],
        &runners,
    );
    assert_eq!(planned.next.as_ref().unwrap().kind, StepKind::SendBack);
    assert!(runners.asked.borrow().is_empty());
    assert_eq!(planned.ledger.failed(), 1);
    assert_eq!(planned.ledger.rows[0].step, Some(StepKind::SendBack));
}

#[test]
fn after_two_failed_rounds_the_third_round_is_a_rethink_on_the_strongest_model_reading_both_rounds_and_the_diff(
) {
    let first = stored(
        round(1, Verdict::Failed, &["a test was weakened"]),
        &[],
        Some(StepKind::SendBack),
    );
    let runners = Scripted::new(&[Ok(REWRITE)]);
    let second = round(
        2,
        Verdict::Failed,
        &["a test was weakened again", "b.log left behind"],
    );
    let planned = plan(&second, std::slice::from_ref(&first), &runners);
    let next = planned.next.unwrap();
    // The step asked the checker's CLI on its strongest model, not the model the checks run on.
    let asked = runners.asked.borrow();
    assert_eq!(asked.len(), 1);
    assert_eq!(
        (asked[0].1.as_str(), asked[0].2.as_str()),
        ("claude", "opus")
    );
    // It read the brief, the definition of done, both rounds' findings and the diff.
    let prompt = &asked[0].0;
    assert!(prompt.contains("## Brief\nFix the save bug on mission two."));
    assert!(prompt.contains("## Definition of done\nSaving works on mission two"));
    assert!(prompt.contains("Round 1:\n- Debris: a test was weakened"));
    assert!(prompt
        .contains("Round 2:\n- Debris: a test was weakened again\n- Debris: b.log left behind"));
    assert!(prompt.contains("## Diff\ndiff --git a/save.ts"));
    assert!(prompt.contains("REWRITE") && prompt.contains("UP"));
    // REWRITE: the one rule is its first line, and the app sends the new brief to the worker as the next round.
    assert_eq!(next.kind, StepKind::Rewrite);
    assert_eq!(
        next.rule.as_deref(),
        Some("Never change a test to make it pass.")
    );
    assert!(next.text.starts_with("[MonoCode check]"));
    assert!(next
        .text
        .contains("Rule: Never change a test to make it pass."));
    assert!(next.text.contains("Leave the tests as they are."));
    assert_eq!(next.by.as_deref(), Some("Claude (the strongest model)"));
    // The ledger holds both failed rounds and says what was done after each.
    assert_eq!(planned.ledger.failed(), 2);
    assert_eq!(
        planned
            .ledger
            .rows
            .iter()
            .map(|r| r.step)
            .collect::<Vec<_>>(),
        vec![Some(StepKind::SendBack), Some(StepKind::Rewrite)]
    );
    assert!(planned.ledger.rethought());
}

#[test]
fn a_rethink_that_says_up_hands_the_work_to_the_first_mate_with_two_lines() {
    let first = stored(
        round(1, Verdict::Failed, &["x"]),
        &[],
        Some(StepKind::SendBack),
    );
    let runners = Scripted::new(&[Ok(
        "UP\nThe brief asks for two things that can't both hold.\nI suggest you pick one and brief it again.\nA third line that is dropped.",
    )]);
    let planned = plan(&round(2, Verdict::Failed, &["y"]), &[first], &runners);
    let next = planned.next.unwrap();
    assert_eq!(next.kind, StepKind::Up);
    assert!(next
        .text
        .contains("The brief asks for two things that can't both hold."));
    assert!(next
        .text
        .contains("I suggest you pick one and brief it again."));
    assert!(!next.text.contains("third line"));
    assert_eq!(next.rule, None);
    assert_eq!(planned.ledger.rows.last().unwrap().step, Some(StepKind::Up));
}

#[test]
fn a_rethink_that_cannot_run_hands_the_work_up_with_the_findings_it_is_never_a_verdict() {
    let first = stored(
        round(1, Verdict::Failed, &["a test was weakened"]),
        &[],
        Some(StepKind::SendBack),
    );
    let second = round(2, Verdict::Failed, &["a test was weakened again"]);
    for (label, runners) in [
        // The model can't be reached, or runs past its time.
        (
            "unreachable",
            Scripted::new(&[Err("it ran past 300 seconds")]),
        ),
        // It answered with something that is neither word.
        (
            "neither word",
            Scripted::new(&[Ok("I would say the worker should try harder.")]),
        ),
        ("empty", Scripted::new(&[Ok("")])),
        (
            "a word and nothing after it",
            Scripted::new(&[Ok("REWRITE")]),
        ),
        ("up and nothing after it", Scripted::new(&[Ok("UP\n\n")])),
        // No checker is signed in at all.
        (
            "no checker",
            Scripted {
                pick: Err("No checker is available.".into()),
                ..Scripted::new(&[])
            },
        ),
    ] {
        let planned = plan(&second, std::slice::from_ref(&first), &runners);
        let next = planned.next.unwrap_or_else(|| panic!("{label}: no step"));
        assert_eq!(next.kind, StepKind::Up, "{label}");
        // The first mate is told what the rounds kept finding, and that the rethink could not run.
        assert!(
            next.text.contains("the rethink step couldn't run"),
            "{label}: {}",
            next.text
        );
        assert!(
            next.text.contains("a test was weakened again"),
            "{label}: {}",
            next.text
        );
        // It counts as a rethink: the next failure goes to the person.
        assert!(planned.ledger.rethought(), "{label}");
    }
}

#[test]
fn the_next_failure_after_a_rethink_goes_to_the_person_and_asks_no_model() {
    let one = stored(
        round(1, Verdict::Failed, &["x"]),
        &[],
        Some(StepKind::SendBack),
    );
    let two = stored(
        round(2, Verdict::Failed, &["y"]),
        std::slice::from_ref(&one),
        Some(StepKind::Rewrite),
    );
    let runners = Scripted::new(&[]);
    let planned = plan(
        &round(3, Verdict::Failed, &["the rule is broken again"]),
        &[one, two],
        &runners,
    );
    assert_eq!(planned.next.unwrap().kind, StepKind::Person);
    assert!(
        runners.asked.borrow().is_empty(),
        "the person is asked, not a model"
    );
    assert_eq!(planned.ledger.failed(), 3);
    // After a hand-up the next failure goes to the person too, with only one failed round before it.
    let up = stored(round(2, Verdict::Failed, &["z"]), &[], Some(StepKind::Up));
    let planned = plan(&round(3, Verdict::Failed, &["z again"]), &[up], &runners);
    assert_eq!(planned.next.unwrap().kind, StepKind::Person);
}

#[test]
fn a_pass_and_an_unsure_round_plan_nothing_and_an_unsure_round_is_not_a_failed_one() {
    let runners = Scripted::new(&[]);
    let one = stored(
        round(1, Verdict::Failed, &["x"]),
        &[],
        Some(StepKind::SendBack),
    );
    let passed = plan(
        &round(2, Verdict::Passed, &[]),
        std::slice::from_ref(&one),
        &runners,
    );
    assert!(passed.next.is_none());
    let unsure = plan(
        &round(2, Verdict::Unsure, &[]),
        std::slice::from_ref(&one),
        &runners,
    );
    assert!(unsure.next.is_none());
    assert_eq!(
        unsure.ledger.failed(),
        1,
        "an unsure round never used a fix round"
    );
    // So the next failure after an unsure round is the task's second failed round, not its third.
    let two = stored(
        round(2, Verdict::Unsure, &[]),
        std::slice::from_ref(&one),
        None,
    );
    let planned = plan(
        &round(3, Verdict::Failed, &["x again"]),
        &[one, two],
        &runners,
    );
    assert_eq!(planned.ledger.failed(), 2);
    assert!(
        runners.asked.borrow().len() == 1,
        "the second failed round is the rethink"
    );
}

// ---- the ledger ------------------------------------------------------------------------------------------------------------

#[test]
fn the_ledger_is_carried_on_the_newest_record_and_rebuilt_for_a_task_from_before_it() {
    let one = stored(
        round(1, Verdict::Failed, &["x"]),
        &[],
        Some(StepKind::SendBack),
    );
    let two = stored(
        round(2, Verdict::Failed, &["y"]),
        std::slice::from_ref(&one),
        Some(StepKind::Rewrite),
    );
    let carried = Ledger::carried(&[one.clone(), two.clone()]);
    assert_eq!(carried.rows.len(), 2);
    assert_eq!(carried.rows[1].step, Some(StepKind::Rewrite));
    // Records written before SC-5 have no ledger: their failures still count, read off the records.
    let old = [
        round(1, Verdict::Failed, &["old"]),
        round(2, Verdict::Failed, &["older"]),
    ];
    let rebuilt = Ledger::carried(&old);
    assert_eq!(rebuilt.failed(), 2);
    assert!(!rebuilt.rethought());
    assert_eq!(rebuilt.rows[0].problems, vec!["Debris: old"]);
    assert_eq!(Ledger::carried(&[]).rows.len(), 0);
}

#[test]
fn a_round_two_windows_both_ran_is_one_round_in_the_ledger() {
    let mut ledger = Ledger::default();
    ledger.push(row_of(&round(1, Verdict::Failed, &["x"])));
    ledger.push(row_of(&round(1, Verdict::Failed, &["x"])));
    ledger.push(row_of(&round(2, Verdict::Failed, &["y"])));
    ledger.push(row_of(&round(2, Verdict::Failed, &["y2"])));
    assert_eq!(ledger.rows.len(), 2);
    assert_eq!(ledger.failed(), 2);
    // The later write of a round replaces the earlier one.
    assert_eq!(ledger.rows[1].problems, vec!["Debris: y2"]);
    // Out of order is put in order.
    let mut late = Ledger::default();
    late.push(row_of(&round(3, Verdict::Failed, &[])));
    late.push(row_of(&round(1, Verdict::Failed, &[])));
    assert_eq!(
        late.rows.iter().map(|r| r.round).collect::<Vec<_>>(),
        vec![1, 3]
    );
}

#[test]
fn the_ledger_keeps_only_the_newest_rows_and_each_row_a_bounded_list_of_short_lines() {
    let mut ledger = Ledger::default();
    for n in 1..=20 {
        ledger.push(row_of(&round(n, Verdict::Failed, &[])));
    }
    assert_eq!(ledger.rows.len(), 8);
    assert_eq!(ledger.rows[0].round, 13);
    let long = "x".repeat(1_000);
    let problems: Vec<String> = (0..20).map(|n| format!("{n} {long}")).collect();
    let refs: Vec<&str> = problems.iter().map(String::as_str).collect();
    let row = row_of(&round(1, Verdict::Failed, &refs));
    assert_eq!(row.problems.len(), 8);
    assert!(row.problems.iter().all(|p| p.chars().count() <= 240));
}

#[test]
fn the_history_a_round_reads_is_the_last_failed_rounds_findings_and_the_rule_a_rewrite_named() {
    let one = stored(
        round(1, Verdict::Failed, &["first"]),
        &[],
        Some(StepKind::SendBack),
    );
    let mut two = stored(
        round(2, Verdict::Failed, &["second", "third"]),
        std::slice::from_ref(&one),
        Some(StepKind::Rewrite),
    );
    two.extras.next = Some(NextStep {
        kind: StepKind::Rewrite,
        rule: Some("Never edit a test".into()),
        ..NextStep::send_back()
    });
    let records = [one, two];
    let history = Ledger::carried(&records).history(&records);
    assert_eq!(
        history.last_problems,
        vec!["Debris: second", "Debris: third"]
    );
    assert_eq!(history.rule.as_deref(), Some("Never edit a test"));
    assert_eq!(Ledger::default().history(&[]), RoundHistory::default());
}

// ---- reading the rethink's answer ------------------------------------------------------------------------------------------

#[test]
fn the_rethinks_answer_is_rewrite_or_up_on_its_first_line_in_any_dress() {
    let rewrite = |said: &str| match parse_rethink(said) {
        Some(Rethink::Rewrite { rule, brief }) => (rule, brief),
        other => panic!("{said:?}: {other:?}"),
    };
    let (rule, brief) = rewrite("REWRITE\nRule: Keep the tests as they are.\nDo the work.");
    assert_eq!(rule, "Keep the tests as they are.");
    assert!(
        brief.starts_with("Rule: Keep the tests as they are.") && brief.contains("Do the work.")
    );
    for dressed in [
        "**REWRITE**\nKeep the tests.\nmore",
        "# Rewrite\n\nKeep the tests.\nmore",
        "`REWRITE`:\nKeep the tests.\nmore",
        "\n\n  rewrite:\nKeep the tests.\nmore",
        "REWRITE: Keep the tests.\nmore",
        "REWRITE - Keep the tests.\r\nmore\r\n",
    ] {
        assert_eq!(rewrite(dressed).0, "Keep the tests.", "{dressed:?}");
    }
    let up = |said: &str| match parse_rethink(said) {
        Some(Rethink::Up { summary }) => summary,
        other => panic!("{said:?}: {other:?}"),
    };
    assert_eq!(up("UP\nOne.\nTwo."), "One.\nTwo.");
    assert_eq!(up("up: One.\nTwo.\nThree."), "One.\nTwo.");
    assert_eq!(up("**UP**\n- One.\n- Two."), "One.\nTwo.");
    // A line is cut short, not trusted.
    let long = "y".repeat(1_000);
    assert_eq!(up(&format!("UP\n{long}")).chars().count(), 300);
}

#[test]
fn anything_that_is_not_clearly_one_of_the_two_words_with_something_after_it_is_no_answer() {
    for said in [
        "",
        "   \n  ",
        "Maybe REWRITE it.",
        "Upon reflection the brief is fine.",
        "REWRITING the brief\nRule: x",
        "UPDATE\nsomething",
        "REWRITE",
        "REWRITE\n\n  \n",
        "UP\n",
        "UP: ",
        "NO",
        "{\"answer\": \"REWRITE\"}",
    ] {
        assert_eq!(parse_rethink(said), None, "{said:?}");
    }
}

// ---- the person's decision -------------------------------------------------------------------------------------------------

fn lead_and_worker(store: &SessionStore, project: Option<&str>) -> crate::delegations::Delegation {
    record(
        &mut store.lock_conn().unwrap(),
        RecordInput {
            owner_session: "lead".into(),
            request_id: "r1".into(),
            child_session: "worker".into(),
            title: Some("Fix the save bug".into()),
            brief: Some("Fix the save bug on mission two".into()),
            project: project.map(str::to_string),
            ..Default::default()
        },
        1,
    )
    .unwrap()
}

fn three_failed() -> Ledger {
    let mut ledger = Ledger::default();
    for (n, step) in [
        (1, StepKind::SendBack),
        (2, StepKind::Rewrite),
        (3, StepKind::Person),
    ] {
        let mut row = row_of(&round(n, Verdict::Failed, &["the rule is broken again"]));
        row.step = Some(step);
        ledger.push(row);
    }
    ledger
}

#[test]
fn a_failure_after_the_rethink_raises_one_decision_with_the_three_choices() {
    let store = SessionStore::open_in_memory().unwrap();
    let row = lead_and_worker(&store, Some("tally"));
    let ledger = three_failed();
    let next = raise_decision(&mut store.lock_conn().unwrap(), &row, 3, &ledger, 5);
    assert_eq!(next.kind, StepKind::Person);
    let key = next.decision.clone().expect("the decision was filed");
    assert_eq!(key, format!("checker/{}/r3", row.id));
    let conn = store.lock_conn().unwrap();
    let decision = crate::decisions::get(&conn, "tally", &key)
        .unwrap()
        .expect("stored");
    assert_eq!(decision.state, crate::decisions::OPEN);
    // One question: what keeps failing. Three choices, in the person's words.
    assert!(decision.question.contains("Fix the save bug"));
    assert!(decision.question.contains("failed the checker 3 times"));
    assert!(decision.question.contains("the rule is broken again"));
    assert!(decision.question.ends_with("What should happen?"));
    assert_eq!(
        decision.options,
        vec!["Send it back once more", "Accept it as it is", "Stop it"]
    );
    // The first mate asked, so it is the one to hear the person's answer; and it is told to wait for it.
    assert_eq!(decision.asked_by, "lead");
    assert!(next.text.contains("Needs you"));
    assert!(next.text.contains("Don't accept or refuse it yet"));
}

#[test]
fn the_same_round_asked_twice_is_one_decision_and_a_later_round_is_a_new_one() {
    let store = SessionStore::open_in_memory().unwrap();
    let row = lead_and_worker(&store, Some("tally"));
    let ledger = three_failed();
    let a = raise_decision(&mut store.lock_conn().unwrap(), &row, 3, &ledger, 5);
    let b = raise_decision(&mut store.lock_conn().unwrap(), &row, 3, &ledger, 6);
    assert_eq!(a.decision, b.decision);
    let later = raise_decision(&mut store.lock_conn().unwrap(), &row, 4, &ledger, 7);
    assert_ne!(later.decision, a.decision);
    let count: i64 = store
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM decisions WHERE decision_key LIKE 'checker/%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 2,
        "one decision per failed round past the rethink, never two for one"
    );
}

#[test]
fn a_task_with_no_project_has_nowhere_to_file_a_decision_and_the_first_mate_is_told_to_ask() {
    let store = SessionStore::open_in_memory().unwrap();
    let row = lead_and_worker(&store, None);
    let next = raise_decision(&mut store.lock_conn().unwrap(), &row, 3, &three_failed(), 5);
    assert_eq!(next.kind, StepKind::Person);
    assert_eq!(next.decision, None);
    assert!(next.text.contains("no project"));
    assert!(next.text.contains("ask the person yourself"));
    assert!(next
        .text
        .contains("don't accept or refuse it before they answer"));
    let blank = lead_and_worker_blank(&store);
    let next = raise_decision(
        &mut store.lock_conn().unwrap(),
        &blank,
        3,
        &three_failed(),
        5,
    );
    assert_eq!(next.decision, None);
}

fn lead_and_worker_blank(store: &SessionStore) -> crate::delegations::Delegation {
    record(
        &mut store.lock_conn().unwrap(),
        RecordInput {
            owner_session: "lead2".into(),
            request_id: "r2".into(),
            child_session: "worker2".into(),
            project: Some("   ".into()),
            ..Default::default()
        },
        2,
    )
    .unwrap()
}

#[test]
fn a_chat_below_a_first_mate_cannot_ask_so_the_gate_files_the_decision_for_it() {
    let store = SessionStore::open_in_memory().unwrap();
    // mono -> lead -> worker: the lead is itself a worker of the mono, so it can't put a question to the person.
    record(
        &mut store.lock_conn().unwrap(),
        RecordInput {
            owner_session: "mono".into(),
            request_id: "r0".into(),
            child_session: "lead".into(),
            ..Default::default()
        },
        1,
    )
    .unwrap();
    let row = lead_and_worker(&store, Some("tally"));
    let next = raise_decision(&mut store.lock_conn().unwrap(), &row, 3, &three_failed(), 5);
    let key = next.decision.expect("filed all the same");
    let decision = crate::decisions::get(&store.lock_conn().unwrap(), "tally", &key)
        .unwrap()
        .unwrap();
    assert_eq!(decision.asked_by, "gate");
}

// ---- what the person and the first mate read -------------------------------------------------------------------------------

#[test]
fn the_messages_say_what_happened_in_plain_words_and_cut_what_is_long() {
    let message = rewrite_message("Rule: Keep the tests.\nDo it.");
    assert!(message.starts_with("[MonoCode check]"));
    assert!(message.contains("it is the first line below"));
    assert!(message.contains("can't be edited to pass"));
    assert!(message.ends_with("Rule: Keep the tests.\nDo it."));
    assert!(up_message("One.\nTwo.", 2).contains("failed this task 2 times"));
    let long = "w".repeat(5_000);
    let question = person_question(&long, &three_failed());
    assert!(
        question.chars().count() < 800,
        "{}",
        question.chars().count()
    );
    assert!(person_note(&long).chars().count() < 400);
    assert_eq!(decision_key("d-1", 3), "checker/d-1/r3");
    assert_eq!(
        PERSON_OPTIONS,
        ["Send it back once more", "Accept it as it is", "Stop it"]
    );
    // A task with no written finding still reads plainly.
    let mut bare = Ledger::default();
    bare.push(row_of(&round(1, Verdict::Failed, &[])));
    bare.push(row_of(&round(2, Verdict::Failed, &[])));
    assert!(up_by_code(&bare, "no model").contains("no finding was written"));
    assert!(person_question("T", &bare).contains("the checker gave no written finding"));
}
