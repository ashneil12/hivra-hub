use super::*;
use crate::test_debt::doc::{Candidate, DecisionKind, Row, QUARANTINE_MS};
use crate::test_debt::testing::Temp;
use crate::verify_stage::StepResult;

const FAIL_OTHER: &str = " FAIL  src/other.test.ts > suite > works\nAssertionError: expected 1 to be 2\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";
const CUT: &str = " FAIL  src/other.test.ts > suite > works\nboom\n Test Files  3 failed (3)\n      Tests  3 failed | 0 passed (3)\n";
const GREEN: &str = " Test Files  3 passed (3)\n      Tests  9 passed (9)\n";

fn cand(file: &str, name: &str) -> Candidate {
    Candidate {
        runner: "vitest".into(),
        file: file.into(),
        name: name.into(),
        failure: "boom".into(),
        command: "unit".into(),
        first_commit: "abc1234".into(),
        delegation_id: "d1".into(),
        task_title: "Add totals".into(),
    }
}

fn verify_step(id: &str, outcome: V, log: Option<&str>) -> StepResult {
    StepResult {
        kind: "check".into(),
        id: id.into(),
        name: id.into(),
        outcome,
        detail: if outcome == V::Failed {
            "failed (exit 1)".into()
        } else {
            "ran".into()
        },
        run_id: None,
        log_path: log.map(str::to_string),
        seconds: 1.0,
    }
}

fn verify_record(steps: Vec<StepResult>) -> VerifyRecord {
    VerifyRecord {
        id: "r".into(),
        project_root: "/p".into(),
        checkout: "/p".into(),
        started_at: 0,
        ended_at: 1,
        outcome: V::Failed,
        summary: String::new(),
        steps,
        gaps: Vec::new(),
        changed_files: Vec::new(),
    }
}

fn stage_for(record: &VerifyRecord) -> Stage {
    super::super::steps_of_verify(record)
}

fn classify(doc: &mut Doc, record: &VerifyRecord, now: u64) -> Stage {
    let mut stage = stage_for(record);
    classify_checks(
        doc,
        &mut stage,
        record,
        &ChecksCtx {
            head: "feedface1234",
            now,
            read_log: &read_log,
            rust_files: &[],
            tracked: &[],
        },
    );
    stage
}

fn write_log(dir: &Temp, name: &str, text: &str) -> String {
    let path = dir.path().join(name);
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().into_owned()
}

// ---- the step and its findings -------------------------------------------------------------------------------------------

#[test]
fn an_empty_list_passes_the_step() {
    let out = stage_of(&Doc::default(), &[], 1);
    assert_eq!(out.stage.steps.len(), 1);
    assert_eq!(out.stage.steps[0].name, STEP);
    assert_eq!(out.stage.steps[0].outcome, Outcome::Passed);
    assert!(out.findings.is_empty());
}

#[test]
fn tests_still_to_sort_read_sorting_n_tests_and_are_not_a_pass() {
    let mut doc = Doc::default();
    doc.note_failure(&cand("a.test.ts", "a"), 1);
    doc.note_failure(&cand("b.test.ts", "b"), 2);
    let out = stage_of(&doc, &[], 3);
    assert_eq!(out.stage.steps[0].outcome, Outcome::CouldNotRun);
    assert_eq!(out.stage.steps[0].detail, "Sorting 2 tests");
    let mut one = Doc::default();
    one.note_failure(&cand("a.test.ts", "a"), 1);
    assert_eq!(
        stage_of(&one, &[], 3).stage.steps[0].detail,
        "Sorting 1 test"
    );
    // Never a pass by aggregate.
    assert_eq!(
        super::super::aggregate(&[
            Step::new("Check: x", Outcome::Passed, "ok"),
            out.stage.steps[0].clone()
        ]),
        Outcome::CouldNotRun
    );
}

/// A list with one real bug (`totals add up`, "tax is ignored") that the person chose to ship with, and one quarantined test.
fn a_bug_shipped_anyway_and_a_quarantined_test() -> Doc {
    let mut doc = Doc::default();
    doc.note_failure(&cand("a.test.ts", "totals add up"), 1);
    doc.note_failure(&cand("b.test.ts", "flaky one"), 2);
    let bug = doc.items[0].id.clone();
    let flaky = doc.items[1].id.clone();
    doc.mark_code_wrong(&bug, "tax is ignored", 3);
    doc.mark_flaky(&flaky, "passed on a re-run", 4);
    let key = Doc::bug_key(&doc.items[0]);
    assert!(doc.ship_bug_anyway(&key, 4));
    doc
}

#[test]
fn a_real_bug_waiting_on_the_person_is_not_a_pass_and_names_the_test() {
    let mut doc = Doc::default();
    doc.note_failure(&cand("a.test.ts", "totals add up"), 1);
    let a = doc.items[0].id.clone();
    doc.mark_code_wrong(&a, "tax is ignored", 3);
    let out = stage_of(&doc, &[], 5);
    let step = &out.stage.steps[0];
    assert_eq!(step.outcome, Outcome::CouldNotRun);
    assert_eq!(
        step.detail,
        "1 test named as a real bug, waiting on you: totals add up"
    );
    // Still a named finding, in the words it always had.
    assert_eq!(out.findings.len(), 1);
    assert_eq!(
        out.findings[0].line,
        "totals add up fails because the code is wrong: tax is ignored"
    );
    // Never a pass by aggregate, with every other step green.
    assert_eq!(
        super::super::aggregate(&[Step::new("Check: x", Outcome::Passed, "ok"), step.clone()]),
        Outcome::CouldNotRun
    );
    // Two of them: counted, and the names are listed.
    doc.note_failure(&cand("b.test.ts", "rounds"), 2);
    let b = doc.items[1].id.clone();
    doc.mark_code_wrong(&b, "rounding is off", 4);
    let two = stage_of(&doc, &[], 5);
    assert_eq!(
        two.stage.steps[0].detail,
        "2 tests named as a real bug, waiting on you: totals add up, rounds"
    );
    // The person's answer is the way through: the step passes and the finding says so.
    let key = Doc::bug_key(&doc.items[0]);
    doc.ship_bug_anyway(&key, 6);
    let one_left = stage_of(&doc, &[], 7);
    assert_eq!(one_left.stage.steps[0].outcome, Outcome::CouldNotRun);
    assert!(one_left.stage.steps[0].detail.contains("rounds"));
    let key = Doc::bug_key(&doc.items[1]);
    doc.ship_bug_anyway(&key, 8);
    let none_left = stage_of(&doc, &[], 9);
    assert_eq!(none_left.stage.steps[0].outcome, Outcome::Passed);
    assert_eq!(none_left.findings.len(), 2, "both are still findings");
}

#[test]
fn tests_still_to_sort_are_said_before_a_bug_that_waits() {
    let mut doc = Doc::default();
    doc.note_failure(&cand("a.test.ts", "bug"), 1);
    doc.note_failure(&cand("b.test.ts", "sort me"), 2);
    let a = doc.items[0].id.clone();
    doc.mark_code_wrong(&a, "x", 3);
    let step = stage_of(&doc, &[], 5).stage.steps[0].clone();
    assert_eq!(
        (step.outcome, step.detail.as_str()),
        (Outcome::CouldNotRun, "Sorting 1 test")
    );
}

#[test]
fn a_remaining_list_of_only_named_findings_passes_and_each_is_visible() {
    // The real bug is one the person chose to ship with; the other test is quarantined.
    let doc = a_bug_shipped_anyway_and_a_quarantined_test();
    let out = stage_of(&doc, &[], 5);
    assert_eq!(out.stage.steps[0].outcome, Outcome::Passed);
    assert!(
        out.stage.steps[0]
            .detail
            .contains("1 test named as a real bug"),
        "{}",
        out.stage.steps[0].detail
    );
    assert!(out.stage.steps[0].detail.contains("1 test quarantined"));
    assert!(
        out.stage.steps[0].detail.contains("shipped anyway"),
        "{}",
        out.stage.steps[0].detail
    );
    let kinds: Vec<&str> = out.findings.iter().map(|f| f.kind.as_str()).collect();
    assert_eq!(kinds, vec!["code-wrong", "quarantined"]);
    assert_eq!(
        out.findings[0].line,
        "totals add up fails because the code is wrong: tax is ignored You chose to ship anyway."
    );
    assert!(
        out.findings[1].line.contains("quarantined until"),
        "{}",
        out.findings[1].line
    );
    assert!(out.findings[1].line.contains("passed on a re-run"));
}

#[test]
fn an_expired_quarantine_is_listed_once_as_a_finding_and_the_test_blocks_again() {
    let dir = Temp::new();
    store::update(dir.path(), "/p", |doc| {
        doc.note_failure(&cand("a.test.ts", "flaky one"), 1);
        let id = doc.items[0].id.clone();
        doc.mark_flaky(&id, "re-run passed", 100);
    })
    .unwrap();
    let before = stage_in(dir.path(), "/p", 100 + QUARANTINE_MS - 1);
    assert_eq!(before.findings.len(), 1);
    assert_eq!(before.findings[0].kind, "quarantined");
    let after = stage_in(dir.path(), "/p", 100 + QUARANTINE_MS);
    assert_eq!(after.findings.len(), 1);
    assert_eq!(after.findings[0].kind, "quarantine-expired");
    assert!(after.findings[0].line.contains("is back"));
    assert_eq!(
        after.stage.steps[0].outcome,
        Outcome::Passed,
        "an expired entry is a finding, not a block"
    );
    let later = stage_in(dir.path(), "/p", 100 + QUARANTINE_MS + 5);
    assert!(later.findings.is_empty(), "listed once");
    // It is no longer quarantined: a failure joins the list again.
    let mut doc = store::read(dir.path(), "/p");
    assert_eq!(
        doc.note_failure(&cand("a.test.ts", "flaky one"), 100 + QUARANTINE_MS + 6),
        crate::test_debt::doc::Noted::Added
    );
}

#[test]
fn a_list_that_cannot_be_written_is_never_a_pass() {
    let dir = Temp::new();
    let path = store::path_of(dir.path(), "/p");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        format!("{{\"version\": {}}}", crate::test_debt::doc::VERSION + 1),
    )
    .unwrap();
    let out = stage_in(dir.path(), "/p", 1);
    assert_eq!(out.stage.steps[0].outcome, Outcome::CouldNotRun);
}

// ---- reading the project's checks ---------------------------------------------------------------------------------------

#[test]
fn a_check_that_failed_on_tests_now_on_the_list_reads_sorting_not_failed() {
    let dir = Temp::new();
    let log = write_log(&dir, "unit.log", FAIL_OTHER);
    let record = verify_record(vec![verify_step("unit", V::Failed, Some(&log))]);
    let mut doc = Doc::default();
    let stage = classify(&mut doc, &record, 10);
    assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
    assert!(
        stage.steps[0].detail.starts_with("Sorting 1 test: "),
        "{}",
        stage.steps[0].detail
    );
    assert_eq!(doc.items.len(), 1);
    let item = &doc.items[0];
    assert_eq!(
        (item.command.as_str(), item.task_title.as_str()),
        ("unit", "Ship check")
    );
    assert_eq!(item.first_commit, "feedface1234");
    assert_eq!(item.file, "src/other.test.ts");
}

#[test]
fn a_check_that_failed_only_on_quarantined_or_named_tests_does_not_block() {
    let dir = Temp::new();
    let log = write_log(&dir, "unit.log", FAIL_OTHER);
    let record = verify_record(vec![verify_step("unit", V::Failed, Some(&log))]);
    // Quarantined: it still ran and reported, and it does not block or join the list.
    let mut doc = Doc::default();
    doc.note_failure(
        &cand("src/other.test.ts", "src/other.test.ts > suite > works"),
        1,
    );
    let id = doc.items[0].id.clone();
    doc.mark_flaky(&id, "x", 2);
    let stage = classify(&mut doc, &record, 3);
    assert_eq!(stage.steps[0].outcome, Outcome::Passed);
    assert!(
        stage.steps[0].detail.contains("do not block"),
        "{}",
        stage.steps[0].detail
    );
    assert!(doc.items.is_empty());
    // A named real bug the person chose to ship with, failing again, does not block either.
    let mut doc = Doc::default();
    doc.note_failure(
        &cand("src/other.test.ts", "src/other.test.ts > suite > works"),
        1,
    );
    let id = doc.items[0].id.clone();
    assert!(doc.mark_code_wrong(&id, "real", 2));
    let key = Doc::bug_key(&doc.items[0]);
    assert!(doc.ship_bug_anyway(&key, 2));
    let stage = classify(&mut doc, &record, 3);
    assert_eq!(stage.steps[0].outcome, Outcome::Passed);
    assert_eq!(doc.items[0].seen_count, 2);
}

#[test]
fn a_check_that_failed_on_a_real_bug_still_waiting_on_the_person_is_not_a_pass() {
    let dir = Temp::new();
    let log = write_log(&dir, "unit.log", FAIL_OTHER);
    let record = verify_record(vec![verify_step("unit", V::Failed, Some(&log))]);
    let mut doc = Doc::default();
    doc.note_failure(
        &cand("src/other.test.ts", "src/other.test.ts > suite > works"),
        1,
    );
    let id = doc.items[0].id.clone();
    assert!(doc.mark_code_wrong(&id, "real", 2));
    let stage = classify(&mut doc, &record, 3);
    assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
    assert!(
        stage.steps[0]
            .detail
            .starts_with("1 test named as a real bug, waiting on you: "),
        "{}",
        stage.steps[0].detail
    );
    assert_eq!(doc.items[0].seen_count, 2, "it is still the same item");
    assert_eq!(doc.items[0].ship_anyway_at, None);
    // A bug the person shipped anyway, then a green run: the item and its override both leave.
    let green = write_log(&dir, "green.log", GREEN);
    let passed = verify_record(vec![verify_step("unit", V::Passed, Some(&green))]);
    let key = Doc::bug_key(&doc.items[0]);
    assert!(doc.ship_bug_anyway(&key, 4));
    classify(&mut doc, &passed, 5);
    assert!(doc.items.is_empty(), "a passing test leaves the list");
}

#[test]
fn a_check_whose_failures_are_not_all_named_stays_failed() {
    let dir = Temp::new();
    let cut = write_log(&dir, "cut.log", CUT);
    let record = verify_record(vec![verify_step("unit", V::Failed, Some(&cut))]);
    let mut doc = Doc::default();
    let stage = classify(&mut doc, &record, 1);
    assert_eq!(
        stage.steps[0].outcome,
        Outcome::Failed,
        "3 failed, 1 named: not shown to be only tests"
    );
    assert!(doc.items.is_empty());
    // A build error, no log, an unreadable log: still a failure.
    let broken = write_log(
        &dir,
        "broken.log",
        "error[E0432]: unresolved import\nerror: could not compile `x`\n",
    );
    for log in [Some(broken.as_str()), None, Some("/no/such/log")] {
        let record = verify_record(vec![verify_step("unit", V::Failed, log)]);
        let stage = classify(&mut Doc::default(), &record, 1);
        assert_eq!(stage.steps[0].outcome, Outcome::Failed);
    }
}

#[test]
fn a_green_check_takes_the_tests_it_failed_off_the_list_and_no_other() {
    let dir = Temp::new();
    let log = write_log(&dir, "unit.log", GREEN);
    let mut doc = Doc::default();
    doc.note_failure(&cand("a.test.ts", "a"), 1); // failed under "unit"
                                                  // Another runner's test, listed by a scoped run: this vitest check says nothing about it.
    let mut elsewhere = cand("b.test.ts", "b");
    elsewhere.command = "affected".into();
    elsewhere.runner = "go".into();
    doc.note_failure(&elsewhere, 1);
    let record = verify_record(vec![verify_step("unit", V::Passed, Some(&log))]);
    let stage = classify(&mut doc, &record, 5);
    assert_eq!(stage.steps[0].outcome, Outcome::Passed);
    assert_eq!(doc.items.len(), 1);
    assert_eq!(doc.items[0].name, "b");
}

#[test]
fn a_check_that_was_stopped_or_has_a_build_error_beside_its_red_tests_stays_failed() {
    let dir = Temp::new();
    let log = write_log(&dir, "unit.log", FAIL_OTHER);
    // Stopped after its timeout: it failed for more than its tests.
    let mut timed_out = verify_step("unit", V::Failed, Some(&log));
    timed_out.detail = "was stopped after its timeout".into();
    let stage = classify(&mut Doc::default(), &verify_record(vec![timed_out]), 1);
    assert_eq!(stage.steps[0].outcome, Outcome::Failed);
    let mut stopped = verify_step("unit", V::Failed, Some(&log));
    stopped.detail = "was stopped before it finished".into();
    assert_eq!(
        classify(&mut Doc::default(), &verify_record(vec![stopped]), 1).steps[0].outcome,
        Outcome::Failed
    );
    // A type error before a red test run: the check failed on more than its tests.
    let mixed = write_log(
        &dir,
        "mixed.log",
        &format!("error TS2304: Cannot find name 'x'.\n{FAIL_OTHER}"),
    );
    let mut doc = Doc::default();
    let stage = classify(
        &mut doc,
        &verify_record(vec![verify_step("unit", V::Failed, Some(&mixed))]),
        1,
    );
    assert_eq!(stage.steps[0].outcome, Outcome::Failed);
    assert!(
        doc.items.is_empty(),
        "nothing is listed from a log that is not only tests"
    );
}

#[test]
fn a_green_check_takes_off_what_a_scoped_run_listed_for_the_same_runner_and_credits_no_deleted_test(
) {
    let dir = Temp::new();
    let log = write_log(&dir, "unit.log", GREEN);
    let mut doc = Doc::default();
    let mut scoped = cand("src/a.test.ts", "scoped");
    scoped.command = "affected".into();
    doc.note_failure(&scoped, 1);
    let mut other_runner = cand("pkg/a_test.go", "TestOther");
    other_runner.runner = "go".into();
    other_runner.command = "affected".into();
    doc.note_failure(&other_runner, 1);
    let mut gone = cand("src/gone.test.ts", "gone");
    gone.command = "affected".into();
    doc.note_failure(&gone, 1);
    let gone_id = doc
        .items
        .iter()
        .find(|i| i.name == "gone")
        .unwrap()
        .id
        .clone();
    doc.mark_code_wrong(&gone_id, "real", 2);
    let record = verify_record(vec![verify_step("unit", V::Passed, Some(&log))]);
    let mut stage = stage_for(&record);
    classify_checks(
        &mut doc,
        &mut stage,
        &record,
        &ChecksCtx {
            head: "feedface1234",
            now: 5,
            read_log: &read_log,
            rust_files: &[],
            // `src/gone.test.ts` is no longer tracked.
            tracked: &["src/a.test.ts".to_string(), "pkg/a_test.go".to_string()],
        },
    );
    assert_eq!(
        doc.items.len(),
        1,
        "only the other runner's test is left: {:?}",
        doc.items
    );
    assert_eq!(doc.items[0].name, "TestOther");
    let gone_score = doc.score.iter().find(|s| s.id == gone_id).unwrap();
    assert_eq!(gone_score.caught, 0, "a deleted test caught nothing");
}

#[test]
fn a_green_check_whose_log_shows_a_failure_clears_only_by_its_own_command() {
    let dir = Temp::new();
    let log = write_log(&dir, "unit.log", &format!("{FAIL_OTHER}{GREEN}"));
    let mut doc = Doc::default();
    let mut scoped = cand("src/a.test.ts", "scoped");
    scoped.command = "affected".into();
    doc.note_failure(&scoped, 1);
    let record = verify_record(vec![verify_step("unit", V::Passed, Some(&log))]);
    classify(&mut doc, &record, 5);
    assert_eq!(
        doc.items.len(),
        1,
        "a red line in the log is not evidence the scoped test passed"
    );
}

// ---- which row is the fixer's ---------------------------------------------------------------------------------------------

mod rows {
    use super::*;
    use crate::delegations::{record, Delegation, RecordInput};
    use crate::session_store::SessionStore;

    fn row_with(state: &str, delivery: &str, verdict: Option<&str>, child: &str) -> Delegation {
        let store = SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let mut row = record(
            &mut conn,
            RecordInput {
                owner_session: "chat-1".into(),
                request_id: "r1".into(),
                child_session: "app-chat-1-test-fixer-0123456-99".into(),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        row.state = state.into();
        row.delivery = delivery.into();
        row.gate_verdict = verdict.map(str::to_string);
        row.child_session = child.into();
        row
    }

    fn fixer(child: &str) -> Fixer {
        Fixer {
            token: "test-fixer-0123456-99".into(),
            child_session: child.into(),
            claimed_at: 1,
            head: "h".into(),
            items: Vec::new(),
        }
    }

    const CHILD: &str = "app-chat-1-test-fixer-0123456-99";

    #[test]
    fn a_task_that_works_asks_or_is_owed_is_open() {
        for (state, delivery) in [
            ("running", "none"),
            ("question", "none"),
            ("completed", "pending"),
            ("completed", "queued"),
        ] {
            let rows = [row_with(state, delivery, Some("passed"), CHILD)];
            assert_eq!(
                row_of(&rows, &fixer(CHILD)),
                Row::Open,
                "{state}/{delivery}"
            );
        }
    }

    #[test]
    fn a_task_that_finished_but_whose_gates_have_not_said_yet_still_holds_the_slot() {
        for verdict in [None, Some("pending")] {
            let rows = [row_with("completed", "delivered", verdict, CHILD)];
            assert_eq!(row_of(&rows, &fixer(CHILD)), Row::Open, "{verdict:?}");
        }
    }

    #[test]
    fn a_task_that_ended_and_was_reported_is_settled() {
        for (state, verdict) in [
            ("completed", Some("passed")),
            ("completed", Some("failed")),
            ("completed", Some("unsure")),
            ("failed", None),
            ("cancelled", None),
        ] {
            let rows = [row_with(state, "delivered", verdict, CHILD)];
            assert_eq!(
                row_of(&rows, &fixer(CHILD)),
                Row::Settled,
                "{state}/{verdict:?}"
            );
        }
    }

    #[test]
    fn a_fixer_whose_child_session_was_never_recorded_is_still_found_by_its_request_id() {
        let rows = [row_with("running", "none", None, CHILD)];
        assert_eq!(row_of(&rows, &fixer("")), Row::Open);
        // Another task, or another request, is not it.
        let other = [row_with(
            "running",
            "none",
            None,
            "app-chat-1-something-else",
        )];
        assert_eq!(row_of(&other, &fixer("")), Row::Missing);
        assert_eq!(row_of(&[], &fixer(CHILD)), Row::Missing);
    }
}

#[test]
fn a_real_app_step_and_a_step_that_could_not_run_are_left_alone() {
    let mut doc = Doc::default();
    let mut real = verify_step("real", V::Failed, None);
    real.kind = "realPath".into();
    let record = verify_record(vec![real, verify_step("lint", V::CouldNotExercise, None)]);
    let before = stage_for(&record);
    let after = classify(&mut doc, &record, 1);
    assert_eq!(before.steps, after.steps);
}

// ---- after the run: the one fixer, and what to put to the person ------------------------------------------------------------

/// What is due after a ship check (reads only).
fn due(dir: &Temp) -> Follow {
    follow_up_in(dir.path(), "/p")
}

/// The call that starts the fixer: it claims the slot and builds the task. `row` is what the delegation rows say of the holder.
fn claim(dir: &Temp, now: u64, row: Row) -> Option<FixerRequest> {
    claim_fixer_in(
        dir.path(),
        "/p",
        dir.path(),
        "0123456789abcdef",
        now,
        &|_| row,
    )
}

fn list_one(dir: &Temp, name: &str) {
    store::update(dir.path(), "/p", |doc| {
        doc.note_failure(&cand("src/a.test.ts", name), 1);
    })
    .unwrap();
}

#[test]
fn an_empty_list_starts_no_fixer() {
    let dir = Temp::new();
    assert!(due(&dir).is_empty());
    assert!(claim(&dir, 10, Row::Missing).is_none());
    assert!(store::read(dir.path(), "/p").fixer.is_none());
}

#[test]
fn a_ship_check_run_claims_nothing_it_only_says_a_fixer_is_due() {
    let dir = Temp::new();
    list_one(&dir, "adds up");
    let out = due(&dir);
    assert!(out.fixer_due);
    assert!(
        store::read(dir.path(), "/p").fixer.is_none(),
        "a card's run starts nothing, so it holds nothing"
    );
    let json = serde_json::to_value(&out).unwrap();
    assert_eq!(json["fixerDue"], true);
    // Nothing due serialises to nothing at all.
    assert_eq!(
        serde_json::to_value(Follow::default()).unwrap(),
        serde_json::json!({})
    );
}

#[test]
fn a_list_starts_one_fixer_and_a_second_ship_check_starts_none() {
    let dir = Temp::new();
    list_one(&dir, "adds up");
    let request = claim(&dir, 10, Row::Missing).expect("the first ship check starts the fixer");
    assert_eq!(request.count, 1);
    assert!(request.title.starts_with("Sort failing tests"));
    assert!(request.brief.contains("adds up"));
    assert!(
        request.token.starts_with("test-fixer-0123456-"),
        "{}",
        request.token
    );
    // A second ship check while the start is on its way, or while the task works, starts nothing.
    assert!(claim(&dir, 20, Row::Missing).is_none());
    store::update(dir.path(), "/p", |doc| {
        doc.fixer_started(&request.token, "app-1-fixer")
    })
    .unwrap();
    assert!(claim(&dir, 30, Row::Open).is_none());
    // The list still says tests wait: the person's one line reads "Sorting".
    assert!(due(&dir).fixer_due);
}

#[test]
fn two_ship_checks_at_once_start_one_fixer_between_them() {
    let dir = Temp::new();
    store::update(dir.path(), "/q", |doc| {
        doc.note_failure(&cand("src/a.test.ts", "adds up"), 1);
    })
    .unwrap();
    let racers: Vec<_> = (0..6)
        .map(|n| {
            let path = dir.path().to_path_buf();
            std::thread::spawn(move || {
                claim_fixer_in(&path, "/q", &path, "0123456789abcdef", 100 + n, &|_| {
                    Row::Missing
                })
            })
        })
        .collect();
    let started = racers
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .filter(Option::is_some)
        .count();
    assert_eq!(started, 1, "the claim is made under the list's lock");
}

#[test]
fn once_the_fixer_settled_the_next_ship_check_may_start_another_for_what_is_left() {
    let dir = Temp::new();
    list_one(&dir, "adds up");
    let first = claim(&dir, 10, Row::Missing).unwrap();
    store::update(dir.path(), "/p", |doc| {
        doc.fixer_started(&first.token, "app-1-fixer")
    })
    .unwrap();
    // It ended without deciding: the test is still on the list.
    let next = claim(&dir, 50, Row::Settled).expect("the next fixer");
    assert_ne!(next.token, first.token);
}

#[test]
fn a_test_already_named_a_real_bug_is_not_sent_to_a_fixer_again() {
    let dir = Temp::new();
    list_one(&dir, "adds up");
    store::update(dir.path(), "/p", |doc| {
        let id = doc.items[0].id.clone();
        doc.mark_code_wrong(&id, "tax is ignored", 2);
    })
    .unwrap();
    let out = due(&dir);
    assert!(!out.fixer_due, "nothing is left to sort");
    assert!(claim(&dir, 10, Row::Missing).is_none());
    assert_eq!(out.bugs.len(), 1);
    assert_eq!(out.bugs[0].test, "adds up");
    assert_eq!(out.bugs[0].line, "tax is ignored");
}

#[test]
fn a_real_bug_and_a_test_that_broke_five_times_are_put_to_the_person_until_claimed() {
    let dir = Temp::new();
    store::update(dir.path(), "/p", |doc| {
        for round in 0..5 {
            doc.note_failure(&cand("a.test.ts", "brittle"), round);
            doc.remove_green(|_| true);
        }
    })
    .unwrap();
    let out = due(&dir);
    assert_eq!(out.proposals.len(), 1);
    assert_eq!(out.proposals[0].broke, 5);
    let id = out.proposals[0].id.clone();
    store::update(dir.path(), "/p", |doc| assert!(doc.claim_proposal(&id, 11))).unwrap();
    assert!(due(&dir).proposals.is_empty(), "asked once");
    let _ = DecisionKind::Flaky;
}

#[test]
fn a_record_nothing_landed_for_does_not_read_as_passed_over_a_list_with_tests_to_sort() {
    let dir = Temp::new();
    let mut record = super::super::ShipCheckRecord {
        project: "/p".into(),
        head: "a".repeat(40),
        base: None,
        commits_covered: 1,
        at: 1,
        outcome: Outcome::Passed,
        note: None,
        steps: vec![Step::new("Check: x", Outcome::Passed, "ok")],
        tested: Vec::new(),
        not_tested: Vec::new(),
        findings: Vec::new(),
    };
    hold_if_waiting(&mut record, dir.path(), "/p");
    assert_eq!(record.outcome, Outcome::Passed, "nothing waiting");
    list_one(&dir, "adds up");
    hold_if_waiting(&mut record, dir.path(), "/p");
    assert_eq!(record.outcome, Outcome::CouldNotRun);
    assert_eq!(record.steps.last().unwrap().detail, "Sorting 1 test");
    assert!(!quiet_in(dir.path(), "/p"));
}

fn a_passed_record() -> super::super::ShipCheckRecord {
    super::super::ShipCheckRecord {
        project: "/p".into(),
        head: "a".repeat(40),
        base: None,
        commits_covered: 1,
        at: 1,
        outcome: Outcome::Passed,
        note: None,
        steps: vec![Step::new("Check: x", Outcome::Passed, "ok")],
        tested: Vec::new(),
        not_tested: Vec::new(),
        findings: Vec::new(),
    }
}

#[test]
fn a_saved_pass_over_a_real_bug_that_waits_on_the_person_reads_as_held_until_they_answer() {
    // The fixer names the bug after the ship check passed: the pass must not stand over it.
    let dir = Temp::new();
    list_one(&dir, "adds up");
    store::update(dir.path(), "/p", |doc| {
        let id = doc.items[0].id.clone();
        doc.mark_code_wrong(&id, "tax is ignored", 2);
    })
    .unwrap();
    assert!(!quiet_in(dir.path(), "/p"), "a bug that waits is not quiet");
    let mut record = a_passed_record();
    hold_if_waiting(&mut record, dir.path(), "/p");
    assert_eq!(record.outcome, Outcome::CouldNotRun);
    let step = record.steps.last().unwrap();
    assert_eq!(step.name, STEP);
    assert_eq!(
        step.detail,
        "1 test named as a real bug, waiting on you: adds up"
    );
    assert!(record
        .not_tested
        .iter()
        .any(|line| line.contains("waiting on you")));
    // Their answer lets it stand again: the pass is theirs to give.
    store::update(dir.path(), "/p", |doc| {
        let key = Doc::bug_key(&doc.items[0]);
        assert!(doc.ship_bug_anyway(&key, 9));
    })
    .unwrap();
    assert!(quiet_in(dir.path(), "/p"));
    let mut again = a_passed_record();
    hold_if_waiting(&mut again, dir.path(), "/p");
    assert_eq!(again.outcome, Outcome::Passed);
    assert_eq!(again.steps.len(), 1, "nothing was added");
}

#[test]
fn a_list_that_cannot_be_read_is_still_not_quiet_with_a_bug_in_it() {
    let dir = Temp::new();
    let path = store::path_of(dir.path(), "/p");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        format!("{{\"version\": {}}}", crate::test_debt::doc::VERSION + 1),
    )
    .unwrap();
    assert!(!quiet_in(dir.path(), "/p"));
    let mut record = a_passed_record();
    hold_if_waiting(&mut record, dir.path(), "/p");
    assert_eq!(record.outcome, Outcome::CouldNotRun);
}
