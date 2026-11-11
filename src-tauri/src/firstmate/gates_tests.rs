//! Hivra WP-40: each gate passing and failing, a gate that can't run never passing, and the verdict check met, not met
//! and unsure with a fake model.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use super::*;

fn sh(dir: &Path, args: &[&str]) {
    let out = crate::git_cmd::git()
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A project with one commit and a worker copy of it in `<project>-worktrees/w1`.
struct Fixture {
    root: PathBuf,
    project: PathBuf,
    copy: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fixture(name: &str) -> Fixture {
    let root = std::env::temp_dir().join(format!(
        "hivra-gates-{name}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let project = root.join("tally");
    std::fs::create_dir_all(&project).unwrap();
    sh(&project, &["init", "-q", "-b", "main"]);
    std::fs::write(project.join("app.ts"), "export const a = 1;\n").unwrap();
    std::fs::write(
        project.join("app.test.ts"),
        "it(\"one\", () => {});\nit(\"two\", () => {});\ntest(\"three\", () => {});\n",
    )
    .unwrap();
    sh(&project, &["add", "-A"]);
    sh(&project, &["commit", "-q", "-m", "start"]);
    let copy = root.join("tally-worktrees").join("w1");
    sh(
        &project,
        &["worktree", "add", "-q", "-b", "w1", copy.to_str().unwrap()],
    );
    let copy = crate::fs::canonical(&copy).unwrap();
    Fixture {
        root,
        project,
        copy,
    }
}

/// Fake runners: checks and routes answer what the test says; the model's replies are scripted and its prompts kept.
#[derive(Default)]
struct Fake {
    checks: Option<Result<Vec<CommandEvidence>, String>>,
    routes: Option<CommandEvidence>,
    replies: RefCell<Vec<Result<String, String>>>,
    prompts: RefCell<Vec<String>>,
}

fn run(command: &str, outcome: Outcome, output: &str) -> CommandEvidence {
    CommandEvidence {
        command: command.into(),
        outcome,
        exit_code: match outcome {
            Outcome::Passed => Some(0),
            Outcome::Failed => Some(1),
            Outcome::NotRun | Outcome::Held => None,
        },
        output: output.into(),
        seconds: 0.1,
    }
}

impl Runners for Fake {
    fn checks(
        &self,
        _checkout: &Path,
        _named: &[String],
        _changed: &[String],
    ) -> Result<Vec<CommandEvidence>, String> {
        self.checks
            .clone()
            .unwrap_or_else(|| Ok(vec![run("npm test", Outcome::Passed, "14 passed")]))
    }
    fn routes(&self, _checkout: &Path) -> Option<CommandEvidence> {
        self.routes.clone()
    }
    fn verdict(&self, prompt: &str) -> Result<String, String> {
        self.prompts.borrow_mut().push(prompt.to_string());
        let mut replies = self.replies.borrow_mut();
        if replies.is_empty() {
            Ok(r#"{"verdict":"met","why":"the diff does what the brief asks"}"#.into())
        } else {
            replies.remove(0)
        }
    }
}

fn plan(gates: &[GateKind]) -> GatePlan {
    GatePlan {
        gates: gates.to_vec(),
        checks: Vec::new(),
    }
}

fn round(dir: &Path, plan: &GatePlan, fake: &Fake) -> GateRecord {
    run_round(
        &RoundInput {
            delegation_id: "d-1",
            round: 1,
            checkout: dir,
            plan,
            brief: "Add a b export to app.ts.",
            done_when: "app.ts exports b",
            report: "## Report\nSummary: it was harder than it looked. I added b to app.ts.",
            now: 1,
            gate_owns_checks: false,
            facts: None,
        },
        fake,
    )
}

fn gate(record: &GateRecord, kind: GateKind) -> &GateResult {
    record
        .gates
        .iter()
        .find(|g| g.gate == kind)
        .unwrap_or_else(|| panic!("no {kind:?} in {record:?}"))
}

// ---- the plan ---------------------------------------------------------------------------------------------------------

#[test]
fn a_code_brief_always_gets_diff_and_checks_and_unknown_gates_are_refused() {
    let none = resolve_plan(&PlanInput::default(), &["committed".into()]).unwrap();
    assert!(
        none.gates.is_empty(),
        "a brief that isn't code gets no gates"
    );
    let code = resolve_plan(
        &PlanInput {
            code: true,
            ..Default::default()
        },
        &["committed".into(), "ratchet".into()],
    )
    .unwrap();
    assert_eq!(
        code.gates,
        vec![
            GateKind::Diff,
            GateKind::Checks,
            GateKind::Committed,
            GateKind::Ratchet
        ],
        "a code brief naming none gets the project's defaults on top"
    );
    let named = resolve_plan(
        &PlanInput {
            gates: Some(vec!["ratchet".into()]),
            ..Default::default()
        },
        &["committed".into()],
    )
    .unwrap();
    assert_eq!(
        named.gates,
        vec![GateKind::Diff, GateKind::Checks, GateKind::Ratchet],
        "named gates replace the defaults, and diff and checks still come with them"
    );
    let routes_only = resolve_plan(
        &PlanInput {
            gates: Some(vec!["routes".into()]),
            ..Default::default()
        },
        &[],
    )
    .unwrap();
    assert_eq!(routes_only.gates, vec![GateKind::Routes]);
    let err = resolve_plan(
        &PlanInput {
            gates: Some(vec!["vibes".into()]),
            ..Default::default()
        },
        &[],
    )
    .unwrap_err();
    assert!(err.contains("isn't a gate"), "{err}");
}

// ---- each gate ----------------------------------------------------------------------------------------------------------

#[test]
fn diff_fails_with_no_change_and_passes_with_one_committed_or_not() {
    let f = fixture("diff");
    let fake = Fake::default();
    let p = plan(&[GateKind::Diff]);
    let record = round(&f.copy, &p, &fake);
    assert_eq!(gate(&record, GateKind::Diff).outcome, Outcome::Failed);
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(
        record.summary.contains("Nothing changed"),
        "{}",
        record.summary
    );
    assert!(
        fake.prompts.borrow().is_empty(),
        "a failed gate never asks the model"
    );

    std::fs::write(f.copy.join("new.ts"), "export const n = 1;\n").unwrap();
    let record = round(&f.copy, &p, &fake);
    assert_eq!(gate(&record, GateKind::Diff).outcome, Outcome::Passed);
    assert!(gate(&record, GateKind::Diff).detail.contains("new.ts"));

    // Committed work counts too: the copy is compared with where it left the project.
    sh(&f.copy, &["add", "-A"]);
    sh(&f.copy, &["commit", "-q", "-m", "work"]);
    let record = round(&f.copy, &p, &fake);
    assert_eq!(gate(&record, GateKind::Diff).outcome, Outcome::Passed);
    assert_eq!(record.verdict, Verdict::Passed);
}

#[test]
fn committed_fails_on_leftovers_and_passes_once_committed() {
    let f = fixture("committed");
    let fake = Fake::default();
    let p = plan(&[GateKind::Committed]);
    std::fs::write(f.copy.join("app.ts"), "export const a = 2;\n").unwrap();
    let record = round(&f.copy, &p, &fake);
    let committed = gate(&record, GateKind::Committed);
    assert_eq!(committed.outcome, Outcome::Failed);
    assert!(committed.detail.contains("app.ts"), "{}", committed.detail);
    sh(&f.copy, &["commit", "-qam", "work"]);
    let record = round(&f.copy, &p, &fake);
    assert_eq!(gate(&record, GateKind::Committed).outcome, Outcome::Passed);
}

#[test]
fn ratchet_fails_when_tests_go_and_passes_when_they_grow() {
    let f = fixture("ratchet");
    let fake = Fake::default();
    let p = plan(&[GateKind::Ratchet]);
    std::fs::write(f.copy.join("app.test.ts"), "it(\"one\", () => {});\n").unwrap();
    let record = round(&f.copy, &p, &fake);
    let ratchet = gate(&record, GateKind::Ratchet);
    assert_eq!(ratchet.outcome, Outcome::Failed);
    assert!(ratchet.detail.contains("3 → 1"), "{}", ratchet.detail);
    assert!(record.summary.contains("fewer tests"));

    std::fs::write(
        f.copy.join("app.test.ts"),
        "it(\"one\", () => {});\nit(\"two\", () => {});\ntest(\"three\", () => {});\nit(\"four\", () => {});\n",
    )
    .unwrap();
    let record = round(&f.copy, &p, &fake);
    assert_eq!(gate(&record, GateKind::Ratchet).outcome, Outcome::Passed);
}

#[test]
fn tests_are_counted_by_kind() {
    assert_eq!(
        count_tests("a.rs", "#[test]\nfn a() {}\n    #[tokio::test]\n"),
        2
    );
    assert_eq!(
        count_tests(
            "a.ts",
            "it('a', f)\n  test.each([1])('b', f)\nit.skip('c', f)\nconst it = 1\n"
        ),
        2
    );
    assert_eq!(
        count_tests(
            "a.py",
            "def test_a():\nasync def test_b():\ndef helper():\n"
        ),
        2
    );
    assert_eq!(count_tests("a_test.go", "func TestA(t *testing.T) {}\n"), 1);
    assert_eq!(count_tests("README.md", "it('a')\n"), 0);
}

#[test]
fn checks_pass_fail_and_never_pass_when_they_cannot_run() {
    let f = fixture("checks");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    let p = plan(&[GateKind::Checks]);

    let passed = round(&f.copy, &p, &Fake::default());
    assert_eq!(gate(&passed, GateKind::Checks).outcome, Outcome::Passed);
    assert_eq!(passed.verdict, Verdict::Passed);
    assert_eq!(
        gate(&passed, GateKind::Checks).evidence[0].exit_code,
        Some(0)
    );

    let failing = Fake {
        checks: Some(Ok(vec![
            run("Web checks", Outcome::Passed, "ok"),
            run("Rust checks", Outcome::Failed, "test tally::sum ... FAILED"),
        ])),
        ..Default::default()
    };
    let failed = round(&f.copy, &p, &failing);
    assert_eq!(gate(&failed, GateKind::Checks).outcome, Outcome::Failed);
    assert_eq!(failed.verdict, Verdict::Failed);
    assert!(
        failed.summary.contains("Rust checks failed"),
        "{}",
        failed.summary
    );
    assert!(
        failed.summary.contains("tally::sum ... FAILED"),
        "the output goes back in words"
    );

    let none = Fake {
        checks: Some(Err("this project declares no checks".into())),
        ..Default::default()
    };
    let not_run = round(&f.copy, &p, &none);
    assert_eq!(gate(&not_run, GateKind::Checks).outcome, Outcome::NotRun);
    assert_eq!(
        not_run.verdict,
        Verdict::Unsure,
        "a gate that couldn't run is never a pass"
    );
    assert!(
        none.prompts.borrow().is_empty(),
        "nor is the model asked over it"
    );

    let half = Fake {
        checks: Some(Ok(vec![
            run("Web checks", Outcome::Passed, "ok"),
            run("Real path", Outcome::NotRun, "the dev copy couldn't start"),
        ])),
        ..Default::default()
    };
    let half = round(&f.copy, &p, &half);
    assert_eq!(gate(&half, GateKind::Checks).outcome, Outcome::NotRun);
    assert_eq!(half.verdict, Verdict::Unsure);
}

#[test]
fn the_routes_check_runs_whenever_the_project_has_one() {
    let f = fixture("routes");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    // Not named by the brief, still run: it is the project's, never the brief's to leave out.
    let failing = Fake {
        routes: Some(run(
            "Routes check",
            Outcome::Failed,
            "DELETE /tallies/:id is not signed off",
        )),
        ..Default::default()
    };
    let record = round(&f.copy, &plan(&[GateKind::Diff]), &failing);
    assert_eq!(gate(&record, GateKind::Routes).outcome, Outcome::Failed);
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(record.summary.contains("not signed off"));

    let passing = Fake {
        routes: Some(run("Routes check", Outcome::Passed, "")),
        ..Default::default()
    };
    let record = round(&f.copy, &plan(&[GateKind::Diff]), &passing);
    assert_eq!(gate(&record, GateKind::Routes).outcome, Outcome::Passed);
    assert_eq!(record.verdict, Verdict::Passed);

    // Named, but the project has none: not run, so not passed.
    let record = round(&f.copy, &plan(&[GateKind::Routes]), &Fake::default());
    assert_eq!(gate(&record, GateKind::Routes).outcome, Outcome::NotRun);
    assert_eq!(record.verdict, Verdict::Unsure);
}

#[test]
fn git_gates_in_a_folder_that_is_not_a_checkout_are_not_run() {
    let dir = std::env::temp_dir().join(format!("hivra-gates-plain-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let fake = Fake::default();
    let record = round(
        &dir,
        &plan(&[GateKind::Diff, GateKind::Committed, GateKind::Ratchet]),
        &fake,
    );
    for kind in [GateKind::Diff, GateKind::Committed, GateKind::Ratchet] {
        assert_eq!(gate(&record, kind).outcome, Outcome::NotRun, "{kind:?}");
    }
    assert_eq!(record.verdict, Verdict::Unsure);
    assert!(fake.prompts.borrow().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- the verdict check --------------------------------------------------------------------------------------------------

#[test]
fn the_verdict_check_met_not_met_and_unsure() {
    let f = fixture("verdict");
    std::fs::write(
        f.copy.join("app.ts"),
        "export const a = 1;\nexport const b = 2;\n",
    )
    .unwrap();
    let p = plan(&[GateKind::Diff, GateKind::Checks]);

    let met = Fake::default();
    let record = round(&f.copy, &p, &met);
    assert_eq!(record.verdict, Verdict::Passed);
    assert_eq!(record.check.as_ref().unwrap().answer, Answer::Met);
    let prompt = met.prompts.borrow()[0].clone();
    assert!(
        prompt.contains("app.ts exports b"),
        "the definition of done"
    );
    assert!(prompt.contains("+export const b = 2;"), "the diff");
    assert!(prompt.contains("[done] I added b to app.ts."), "the claims");
    assert!(
        !prompt.contains("harder than it looked"),
        "never the report's own story"
    );
    assert!(
        prompt.contains("Project checks: passed"),
        "what the app ran"
    );

    let not_met = Fake {
        replies: RefCell::new(vec![Ok(
            "Sure.\n{\"verdict\": \"not-met\", \"why\": \"b is exported but the brief also asked for a test\"}".into(),
        )]),
        ..Default::default()
    };
    let record = round(&f.copy, &p, &not_met);
    assert_eq!(
        record.verdict,
        Verdict::Failed,
        "not met counts as a failed gate"
    );
    assert!(
        record.summary.contains("also asked for a test"),
        "{}",
        record.summary
    );

    let unsure = Fake {
        replies: RefCell::new(vec![Ok(
            r#"{"verdict":"unsure","why":"the diff is cut short"}"#.into(),
        )]),
        ..Default::default()
    };
    let record = round(&f.copy, &p, &unsure);
    assert_eq!(
        record.verdict,
        Verdict::Unsure,
        "unsure goes to the first mate"
    );
    assert!(record.summary.contains("cut short"));

    for reply in [
        Ok("I think it's fine".to_string()),
        Err("no login".to_string()),
    ] {
        let odd = Fake {
            replies: RefCell::new(vec![reply]),
            ..Default::default()
        };
        assert_eq!(
            round(&f.copy, &p, &odd).verdict,
            Verdict::Unsure,
            "an unreadable or missing answer is never met"
        );
    }
}

#[test]
fn verdict_replies_are_read_strictly() {
    assert_eq!(
        parse_verdict(r#"{"verdict":"met","why":"ok"}"#).answer,
        Answer::Met
    );
    assert_eq!(
        parse_verdict(r#"{"verdict":"Not met","why":"x"}"#).answer,
        Answer::NotMet
    );
    assert_eq!(
        parse_verdict(r#"{"verdict":"not_met"}"#).answer,
        Answer::NotMet
    );
    assert_eq!(
        parse_verdict(r#"{"verdict":"probably"}"#).answer,
        Answer::Unsure
    );
    assert_eq!(parse_verdict("met").answer, Answer::Unsure);
    assert_eq!(parse_verdict("").answer, Answer::Unsure);
}

#[test]
fn a_brief_without_a_definition_of_done_is_unsure() {
    let f = fixture("nodone");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    let fake = Fake::default();
    let record = run_round(
        &RoundInput {
            delegation_id: "d-1",
            round: 1,
            checkout: &f.copy,
            plan: &plan(&[GateKind::Diff]),
            brief: "b",
            done_when: "  ",
            report: "",
            now: 1,
            gate_owns_checks: false,
            facts: None,
        },
        &fake,
    );
    assert_eq!(record.verdict, Verdict::Unsure);
    assert!(fake.prompts.borrow().is_empty());
    let _ = &f.project;
}

fn stale_facts() -> crate::firstmate::fact_gaps::FactTurn {
    crate::firstmate::fact_gaps::FactTurn {
        checks: vec![crate::firstmate::fact_gaps::FactCheck {
            command: "npm test".into(),
            status: "passed".into(),
            at: 1.0,
        }],
        edits: vec![crate::firstmate::fact_gaps::FactEdit {
            path: "src/features/crew/row.ts".into(),
            at: 2.0,
        }],
        ..Default::default()
    }
}

#[test]
fn fact_gaps_fail_the_claim_without_asking_the_model() {
    let f = fixture("stale");
    let facts = stale_facts();
    let fake = Fake::default();
    let record = run_round(
        &RoundInput {
            delegation_id: "d-1",
            round: 1,
            checkout: &f.copy,
            plan: &plan(&[]),
            brief: "Add a row.",
            done_when: "the row is there",
            report: "Done.",
            now: 1,
            gate_owns_checks: false,
            facts: Some(&facts),
        },
        &fake,
    );
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(record.check.is_none(), "a fact gap does not ask the model");
    assert!(fake.prompts.borrow().is_empty());
    assert_eq!(
        record.summary, "Sent back: tests went stale after the last edit.",
        "the first line is the reason a person sees"
    );
    let _ = &f.project;
}

#[test]
fn a_planless_turn_fails_on_fact_gaps_and_stays_quiet_when_there_are_none() {
    let failed = fact_only_record("d-1", 2, 9, &stale_facts(), None).expect("a gap");
    assert_eq!(failed.verdict, Verdict::Failed);
    assert!(failed.check.is_none());
    assert!(
        failed.gates.is_empty(),
        "no plan means no routes check here"
    );
    assert_eq!(
        failed.summary,
        "Sent back: tests went stale after the last edit."
    );
    assert!(fact_only_record(
        "d-1",
        2,
        9,
        &crate::firstmate::fact_gaps::FactTurn::default(),
        None,
    )
    .is_none());
    // A docs edit after a passing test is not a gap, so the routes check stays in the webview.
    let docs = crate::firstmate::fact_gaps::FactTurn {
        checks: vec![crate::firstmate::fact_gaps::FactCheck {
            command: "npm test".into(),
            status: "passed".into(),
            at: 1.0,
        }],
        edits: vec![crate::firstmate::fact_gaps::FactEdit {
            path: "docs/readme.md".into(),
            at: 2.0,
        }],
        ..Default::default()
    };
    assert!(fact_only_record("d-1", 2, 9, &docs, None).is_none());
}

// ---- evidence and the row -----------------------------------------------------------------------------------------------

fn store() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::delegations::ensure_tables(&conn).unwrap();
    conn
}

fn record_row(conn: &mut Connection) -> crate::delegations::Delegation {
    let input: crate::delegations::RecordInput = serde_json::from_value(serde_json::json!({
        "ownerSession": "lead-1",
        "childSession": "worker-1",
        "requestId": "r-1",
        "brief": "Add b",
        "goal": "app.ts exports b",
        "reviewRequired": false
    }))
    .unwrap();
    crate::delegations::record(conn, input, 1).unwrap()
}

fn settle_done(
    conn: &mut Connection,
    row: &crate::delegations::Delegation,
) -> crate::delegations::Delegation {
    let input: crate::delegations::SettleInput = serde_json::from_value(serde_json::json!({
        "id": row.id,
        "generation": row.generation,
        "state": "completed",
        "result": "done"
    }))
    .unwrap();
    crate::delegations::settle(conn, input, 3)
        .unwrap()
        .row
        .unwrap()
}

#[test]
fn done_only_when_every_gate_passed_and_the_brief_was_met() {
    use crate::firstmate::status::Status;
    for (verdict, shown) in [
        (Verdict::Passed, Status::Done),
        (Verdict::Failed, Status::Failed),
        (Verdict::Unsure, Status::Working),
    ] {
        let mut conn = store();
        let row = record_row(&mut conn);
        let pending = crate::delegations::set_gate_verdict(
            &mut conn,
            &row.id,
            GateVerdict::PENDING,
            "checks are running",
            None,
            2,
        )
        .unwrap();
        assert!(pending.applied);
        let applied = crate::delegations::set_gate_verdict(
            &mut conn,
            &row.id,
            verdict.stored(),
            "summary",
            None,
            2,
        )
        .unwrap();
        assert!(applied.applied);
        let settled = settle_done(&mut conn, &row);
        assert_eq!(settled.status, shown, "{verdict:?}");
        assert!(settled
            .log
            .iter()
            .any(|e| e.get("event").and_then(Value::as_str) == Some("gates")));
    }
}

#[test]
fn only_its_first_mate_decides_an_unsure_one_and_only_once() {
    use crate::firstmate::status::Status;
    let mut conn = store();
    let row = record_row(&mut conn);
    crate::delegations::set_gate_verdict(
        &mut conn,
        &row.id,
        GateVerdict::UNSURE,
        "unsure",
        None,
        2,
    )
    .unwrap();
    let row = settle_done(&mut conn, &row);
    assert_eq!(row.status, Status::Working);
    // A finished row's verdict can't be rewritten by the app's own run.
    let late =
        crate::delegations::set_gate_verdict(&mut conn, &row.id, GateVerdict::PASSED, "x", None, 4)
            .unwrap();
    assert!(!late.applied);
    assert!(decide(&mut conn, "someone-else", &row.id, true, None, 4)
        .unwrap_err()
        .contains("isn't one of yours"));
    assert!(decide(&mut conn, "lead-1", &row.id, false, None, 4)
        .unwrap_err()
        .contains("Say why"));
    let accepted = decide(
        &mut conn,
        "lead-1",
        &row.id,
        true,
        Some("the diff is right"),
        4,
    )
    .unwrap();
    assert_eq!(accepted.row.unwrap().status, Status::Done);
    assert!(
        decide(&mut conn, "lead-1", &row.id, false, Some("no"), 5).is_err(),
        "once"
    );

    let mut conn = store();
    let row = record_row(&mut conn);
    crate::delegations::set_gate_verdict(
        &mut conn,
        &row.id,
        GateVerdict::UNSURE,
        "unsure",
        None,
        2,
    )
    .unwrap();
    let row = settle_done(&mut conn, &row);
    let refused = decide(
        &mut conn,
        "lead-1",
        &row.id,
        false,
        Some("b isn't tested"),
        4,
    )
    .unwrap();
    assert_eq!(refused.row.unwrap().status, Status::Failed);
}

#[test]
fn plans_and_rounds_are_kept_beside_the_row() {
    let conn = store();
    assert_eq!(plan_of(&conn, "d-1").unwrap(), None);
    let p = plan(&[GateKind::Diff, GateKind::Checks]);
    save_plan(&conn, "d-1", &p, 1).unwrap();
    assert_eq!(plan_of(&conn, "d-1").unwrap(), Some(p.clone()));
    assert_eq!(next_round(&conn, "d-1").unwrap(), 1);
    let f = fixture("store");
    let mut record = round(&f.copy, &p, &Fake::default());
    for n in 1..=8 {
        record.round = n;
        push_record(&conn, &record).unwrap();
    }
    let kept = records_of(&conn, "d-1").unwrap();
    assert_eq!(kept.len(), 6);
    assert_eq!(kept.last().unwrap().round, 8);
    assert_eq!(next_round(&conn, "d-1").unwrap(), 9);
}

#[test]
fn evidence_reads_as_markdown_with_commands_codes_and_failing_output() {
    let f = fixture("md");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    let failing = Fake {
        checks: Some(Ok(vec![run(
            "Project checks",
            Outcome::Failed,
            "1 failed\n```oops```",
        )])),
        ..Default::default()
    };
    let record = round(
        &f.copy,
        &plan(&[GateKind::Diff, GateKind::Checks]),
        &failing,
    );
    let md = evidence_markdown(&record);
    assert!(md.contains("**Gates (round 1): failed**"), "{md}");
    assert!(md.contains("`Project checks` (exit 1)"), "{md}");
    assert!(
        md.contains("~~~~text\n1 failed"),
        "a fence that can't be closed by the output: {md}"
    );
    assert!(md.contains("- Change made — passed"), "{md}");
}

#[cfg(unix)]
#[test]
fn the_claude_verdict_call_sends_the_prompt_on_stdin_with_no_tools() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("hivra-verdict-cli-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("claude");
    let seen = dir.join("seen");
    std::fs::write(
        &bin,
        format!(
            "#!/bin/sh\necho \"$@\" > '{0}.args'\ncat > '{0}.stdin'\necho '{{\"verdict\":\"met\",\"why\":\"ok\"}}'\n",
            seen.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Another test thread can fork while this script is still open for writing. Until that child execs, starting the
    // script fails with "Text file busy" (ETXTBSY), so try again for a moment instead of failing on that race.
    let mut tries = 0;
    let said = loop {
        match claude_verdict(
            bin.to_str().unwrap(),
            "haiku",
            "the prompt",
            Duration::from_secs(10),
        ) {
            Err(why) if why.contains("Text file busy") && tries < 50 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            other => break other.unwrap(),
        }
    };
    assert_eq!(parse_verdict(&said).answer, Answer::Met);
    let args = std::fs::read_to_string(dir.join("seen.args")).unwrap();
    assert!(args.contains("-p --model haiku"), "{args}");
    assert!(
        args.contains("--tools  --strict-mcp-config"),
        "no tools, no MCP servers: {args}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("seen.stdin")).unwrap(),
        "the prompt"
    );

    std::fs::write(&bin, "#!/bin/sh\nexit 3\n").unwrap();
    assert!(
        claude_verdict(bin.to_str().unwrap(), "haiku", "p", Duration::from_secs(10))
            .unwrap_err()
            .contains("exited with 3")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- review round 1 (PR #232): failing repro --------------------------------------------------------------------------

// HIGH: a plan-less worker sent back for a fact gap and then fixed keeps the first round's "failed" verdict.
// `firstmate_run_gates` returns `None` for a plan-less turn with no gap before it writes anything, so nothing replaces
// the stored failure; the delivered row shows Failed ("Sent back: ...") and `task_accept` can't fix it (unsure only).
#[test]
fn r1_a_planless_turn_fixed_after_a_send_back_does_not_stay_failed() {
    use crate::firstmate::fact_gaps::{done_gaps, FactCheck, FactEdit, FactTurn};
    use crate::firstmate::status::Status;
    let mut conn = store();
    let row = record_row(&mut conn);
    // Round 1, as the command does it: no stored plan, a fact gap, the fact-only record's verdict on the row.
    let first = fact_only_record(&row.id, 1, 2, &stale_facts(), None).expect("a gap");
    let applied = crate::delegations::set_gate_verdict(
        &mut conn,
        &row.id,
        first.verdict.stored(),
        &first.summary,
        None,
        2,
    )
    .unwrap();
    assert!(applied.applied);
    // Round 2: the worker reran the test after its edit. No plan and no gap, so the command returns before it writes,
    // the routes check passes in the webview, and the report is delivered as completed.
    let fixed = FactTurn {
        checks: vec![
            FactCheck {
                command: "npm test".into(),
                status: "passed".into(),
                at: 1.0,
            },
            FactCheck {
                command: "npm test".into(),
                status: "passed".into(),
                at: 3.0,
            },
        ],
        edits: vec![FactEdit {
            path: "src/features/crew/row.ts".into(),
            at: 2.0,
        }],
        ..Default::default()
    };
    assert!(done_gaps(&fixed).is_empty());
    assert!(fact_only_record(&row.id, 2, 4, &fixed, None).is_none());
    let settled = settle_done(&mut conn, &row);
    assert_eq!(
        settled.status,
        Status::Done,
        "delivered work still shows {:?}: {:?}",
        settled.status,
        settled.status_notice
    );
}

// ---- review round 2 (PR #232): failing repro --------------------------------------------------------------------------

// MED: the r1 fix clears a send-back whenever a completed report is settled, in `delegations::settle`. A report that is
// settled without a gate run (a resumed turn, a boot settle, a followed brief) clears it too. Here the app's own project
// checks failed beside a fact gap; nothing ran them again, and the delivered row shows Done. On main it stays Failed.
#[test]
fn r2_a_completed_settle_does_not_clear_a_failed_plan_gate_nothing_reran() {
    use crate::firstmate::status::Status;
    let f = fixture("r2-plan");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    let mut conn = store();
    let row = record_row(&mut conn);
    let p = plan(&[GateKind::Diff, GateKind::Checks]);
    save_plan(&conn, &row.id, &p, 1).unwrap();
    let failing = Fake {
        checks: Some(Ok(vec![run("Project checks", Outcome::Failed, "1 failed")])),
        ..Default::default()
    };
    let facts = stale_facts();
    let record = run_round(
        &RoundInput {
            delegation_id: &row.id,
            round: 1,
            checkout: &f.copy,
            plan: &p,
            brief: "Add b",
            done_when: "app.ts exports b",
            report: "Done.",
            now: 2,
            gate_owns_checks: false,
            facts: Some(&facts),
        },
        &failing,
    );
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(
        record.summary.starts_with("Sent back:"),
        "{}",
        record.summary
    );
    let applied = crate::delegations::set_gate_verdict(
        &mut conn,
        &row.id,
        record.verdict.stored(),
        &record.summary,
        None,
        2,
    )
    .unwrap();
    assert!(applied.applied);
    let settled = settle_done(&mut conn, &row);
    assert_eq!(
        settled.status,
        Status::Failed,
        "a failed project check nothing reran shows {:?}",
        settled.status
    );
    let _ = &f.project;
}

// The command decides a plan-less turn through `planless_facts`. Missing facts are not a clean turn:
// a send-back stays, and the row is not marked pending. A present turn with no gap still clears.
#[test]
fn a_missing_fact_turn_does_not_clear_a_send_back() {
    use crate::firstmate::fact_gaps::{FactCheck, FactEdit, FactTurn};
    assert_eq!(planless_facts(None, None), PlanlessFacts::Keep);
    let fixed = FactTurn {
        checks: vec![
            FactCheck {
                command: "npm test".into(),
                status: "passed".into(),
                at: 1.0,
            },
            FactCheck {
                command: "npm test".into(),
                status: "passed".into(),
                at: 3.0,
            },
        ],
        edits: vec![FactEdit {
            path: "src/features/crew/row.ts".into(),
            at: 2.0,
        }],
        ..Default::default()
    };
    assert_eq!(planless_facts(Some(&fixed), None), PlanlessFacts::Clear);
    assert_eq!(
        planless_facts(Some(&stale_facts()), None),
        PlanlessFacts::Gaps
    );
}
