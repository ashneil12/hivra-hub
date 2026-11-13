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
            mode: None,
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
fn the_ratchet_does_not_count_an_ignored_rust_test_as_a_test() {
    assert_eq!(count_tests("a.rs", "#[test]\n#[ignore]\nfn a() {}\n"), 0);
    assert_eq!(
        count_tests(
            "a.rs",
            "#[test]\n#[ignore = \"slow\"]\nfn a() {}\n#[test]\nfn b() {}\n"
        ),
        1
    );
    let f = fixture("ratchet-ignore");
    // The project already holds two Rust tests when the copy starts from it.
    std::fs::write(
        f.project.join("lib.rs"),
        "#[test]\nfn one() {}\n#[test]\nfn two() {}\n",
    )
    .unwrap();
    sh(&f.project, &["add", "-A"]);
    sh(&f.project, &["commit", "-q", "-m", "tests"]);
    sh(&f.copy, &["merge", "-q", "main"]);
    let fake = Fake::default();
    let p = plan(&[GateKind::Ratchet]);
    let untouched = round(&f.copy, &p, &fake);
    assert_eq!(gate(&untouched, GateKind::Ratchet).outcome, Outcome::Passed);
    // Ignoring one is a test lost, though its line is still there.
    std::fs::write(
        f.copy.join("lib.rs"),
        "#[test]\nfn one() {}\n#[test]\n#[ignore]\nfn two() {}\n",
    )
    .unwrap();
    let record = round(&f.copy, &p, &fake);
    let ratchet = gate(&record, GateKind::Ratchet);
    assert_eq!(ratchet.outcome, Outcome::Failed, "{}", ratchet.detail);
    assert!(ratchet.detail.contains("2 → 1"), "{}", ratchet.detail);
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
            mode: None,
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
            mode: None,
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
    // SC-3a: an accept names its reason first (see `accepting_an_unsure_result_needs_a_reason...`), so this one does,
    // and what it checks is still that someone else's accept is refused.
    assert!(decide(
        &mut conn,
        "someone-else",
        &row.id,
        true,
        Some("the diff is right"),
        4
    )
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
            mode: None,
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

// ---- SC-3a: zero tests is could-not-run, in every mode ----------------------------------------------------------------

#[test]
fn a_checks_step_that_ran_zero_tests_could_not_run_and_is_never_a_pass() {
    let f = fixture("zero");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    let p = plan(&[GateKind::Checks]);
    for said in [
        " No test files found, exiting with code 1",
        "      Tests  no tests\n",
        "      Tests  3 skipped (3)\n",
        "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 0.00s",
        "     Starting 0 tests across 1 binary (5 skipped)\n",
        "# tests 0\n# pass 0\n# fail 0\n# skipped 0\n",
        "============ no tests ran in 0.01s ============",
        "collected 0 items\n",
        "?   \texample.com/a\t[no test files]\n",
        "Error: No tests found.\n",
    ] {
        let fake = Fake {
            checks: Some(Ok(vec![run("npm test", Outcome::Passed, said)])),
            ..Default::default()
        };
        let record = round(&f.copy, &p, &fake);
        let checks = gate(&record, GateKind::Checks);
        assert_eq!(checks.outcome, Outcome::NotRun, "{said:?}");
        assert!(checks.detail.contains("ran zero tests"), "{}", checks.detail);
        assert!(checks.detail.contains("npm test"), "{}", checks.detail);
        assert_eq!(checks.evidence[0].outcome, Outcome::NotRun, "{said:?}");
        assert_eq!(record.verdict, Verdict::Unsure, "{said:?}");
        assert!(record.summary.contains("ran zero tests"), "{}", record.summary);
        assert!(
            fake.prompts.borrow().is_empty(),
            "a check that couldn't run does not ask the model"
        );
    }
}

#[test]
fn a_step_with_no_test_summary_or_a_real_run_keeps_todays_rule() {
    let f = fixture("zero-keeps");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    let p = plan(&[GateKind::Checks]);
    let check = |steps: Vec<CommandEvidence>| {
        let fake = Fake {
            checks: Some(Ok(steps)),
            ..Default::default()
        };
        round(&f.copy, &p, &fake)
    };
    // A build or a lint step prints no summary: it passes on its exit code, as before.
    let build = check(vec![run("npm run build", Outcome::Passed, "Done in 2s")]);
    assert_eq!(gate(&build, GateKind::Checks).outcome, Outcome::Passed);
    assert_eq!(build.verdict, Verdict::Passed);
    // A real run passes.
    let real = check(vec![run(
        "npm test",
        Outcome::Passed,
        "      Tests  3 passed (3)\n",
    )]);
    assert_eq!(gate(&real, GateKind::Checks).outcome, Outcome::Passed);
    // A failing step stays failed, whatever it printed.
    let failed = check(vec![run(
        "npm test",
        Outcome::Failed,
        "No test files found, exiting with code 1",
    )]);
    assert_eq!(gate(&failed, GateKind::Checks).outcome, Outcome::Failed);
    // A step that could not run stays as it was, with its own words.
    let not_run = check(vec![run(
        "Real path",
        Outcome::NotRun,
        "the dev copy couldn't start",
    )]);
    assert_eq!(gate(&not_run, GateKind::Checks).outcome, Outcome::NotRun);
    assert!(!gate(&not_run, GateKind::Checks)
        .detail
        .contains("zero tests"));
    // One empty test step among passing ones is the whole gate not run, and only that step is named.
    let mixed = check(vec![
        run("npm run build", Outcome::Passed, "Done in 2s"),
        run("npm test", Outcome::Passed, "No test files found"),
    ]);
    let mixed_checks = gate(&mixed, GateKind::Checks);
    assert_eq!(mixed_checks.outcome, Outcome::NotRun);
    assert!(
        mixed_checks.detail.contains("npm test"),
        "{}",
        mixed_checks.detail
    );
    assert!(
        !mixed_checks.detail.contains("npm run build"),
        "{}",
        mixed_checks.detail
    );
    assert_eq!(mixed_checks.evidence[0].outcome, Outcome::Passed);
}

#[test]
fn a_cut_log_is_not_read_for_a_count_because_its_empty_doc_tests_line_would_say_zero() {
    let f = fixture("zero-tail");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    // `gates::tail` marks a cut with a leading ellipsis. What follows it is the end of a longer log.
    let cut = "…ed in 0.3s\n\nDoc-tests tally\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s";
    let fake = Fake {
        checks: Some(Ok(vec![run("cargo test", Outcome::Passed, cut)])),
        ..Default::default()
    };
    let record = round(&f.copy, &plan(&[GateKind::Checks]), &fake);
    assert_eq!(gate(&record, GateKind::Checks).outcome, Outcome::Passed);
}

fn log_file(name: &str, text: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "hivra-gates-log-{name}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("step.log");
    std::fs::write(&path, text).unwrap();
    (dir, path)
}

fn step(name: &str, log: &Path) -> crate::verify_stage::StepResult {
    crate::verify_stage::StepResult {
        kind: "check".into(),
        id: "check".into(),
        name: name.into(),
        outcome: crate::verify_stage::Outcome::Passed,
        detail: "passed".into(),
        run_id: None,
        log_path: Some(log.to_string_lossy().into_owned()),
        seconds: 0.5,
    }
}

#[test]
fn a_step_log_is_read_whole_so_empty_doc_tests_at_its_end_do_not_make_it_zero() {
    let f = fixture("zero-log");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    // 500 tests ran in the library; the log is far longer than the evidence tail, which ends on the empty doc-tests.
    let noise = "   Compiling dep v1.0.0\n".repeat(400);
    let log = format!(
        "{noise}running 500 tests\ntest result: ok. 500 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 4.2s\n{noise}   Doc-tests tally\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"
    );
    let (dir, path) = log_file("many", &log);
    let evidence = step_evidence(step("Rust checks", &path));
    assert_eq!(evidence.outcome, Outcome::Passed);
    assert!(evidence.output.len() <= OUTPUT_MAX + 4);
    let fake = Fake {
        checks: Some(Ok(vec![evidence])),
        ..Default::default()
    };
    let record = round(&f.copy, &plan(&[GateKind::Checks]), &fake);
    assert_eq!(gate(&record, GateKind::Checks).outcome, Outcome::Passed);
    let _ = std::fs::remove_dir_all(dir);

    // The same log with nothing run anywhere is zero.
    let empty = format!(
        "{noise}running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n{noise}   Doc-tests tally\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"
    );
    let (dir, path) = log_file("none", &empty);
    let evidence = step_evidence(step("Rust checks", &path));
    assert_eq!(evidence.outcome, Outcome::NotRun);
    assert_eq!(evidence.exit_code, Some(0), "it did exit cleanly");
    assert!(
        evidence.output.starts_with("ran zero tests"),
        "{}",
        evidence.output
    );
    assert!(
        evidence.output.contains("cargo test"),
        "the runner is named"
    );
    let fake = Fake {
        checks: Some(Ok(vec![evidence])),
        ..Default::default()
    };
    let record = round(&f.copy, &plan(&[GateKind::Checks]), &fake);
    let checks = gate(&record, GateKind::Checks);
    assert_eq!(checks.outcome, Outcome::NotRun);
    assert!(checks.detail.contains("Rust checks"), "{}", checks.detail);
    assert!(
        checks.detail.contains("ran zero tests"),
        "{}",
        checks.detail
    );
    let _ = std::fs::remove_dir_all(dir);

    // A step that failed keeps its own word, and a build log with no summary passes.
    let (dir, path) = log_file(
        "build",
        "   Compiling tally v0.1.0\n    Finished dev in 2.1s\n",
    );
    assert_eq!(step_evidence(step("Build", &path)).outcome, Outcome::Passed);
    let mut failed = step("Tests", &path);
    failed.outcome = crate::verify_stage::Outcome::Failed;
    failed.detail = "failed (exit 1)".into();
    assert_eq!(step_evidence(failed).outcome, Outcome::Failed);
    let _ = std::fs::remove_dir_all(dir);
}

// ---- SC-3a: accepting an unsure result needs a reason ---------------------------------------------------------------------

#[test]
fn accepting_an_unsure_result_needs_a_reason_and_the_reason_stays_on_the_row() {
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
    for blank in [None, Some(""), Some("   "), Some("\n\t ")] {
        assert_eq!(
            decide(&mut conn, "lead-1", &row.id, true, blank, 4).unwrap_err(),
            "Say why you accept it without a pass (reason), in one plain line.",
            "{blank:?}"
        );
    }
    // Nothing was written: it is still unsure, and still its first mate's to decide.
    let still = crate::delegations::get(&conn, &row.id).unwrap().unwrap();
    assert_eq!(still.gate_verdict.as_deref(), Some(GateVerdict::UNSURE));
    let accepted = decide(
        &mut conn,
        "lead-1",
        &row.id,
        true,
        Some("  the diff is right  "),
        5,
    )
    .unwrap()
    .row
    .unwrap();
    assert_eq!(accepted.status, Status::Done);
    assert_eq!(
        accepted.status_notice.as_deref(),
        Some("Accepted without a pass: the diff is right"),
        "the reason shows on the row"
    );
    // Refusing still needs its reason, as before.
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
    assert!(decide(&mut conn, "lead-1", &row.id, false, Some(" "), 4)
        .unwrap_err()
        .contains("Say why it isn't done"));
}

// ---- SC-3a: gates chosen from the diff, by the project's mode -------------------------------------------------------------

use crate::delivery::settings::TestingMode;
use crate::firstmate::testing_mode::{self, ModePlan};

/// The mode's plan for what the copy changed so far, chosen the way `firstmate_run_gates` chooses it.
fn moded(dir: &Path, mode: TestingMode, stored: Option<&GatePlan>) -> ModePlan {
    let changed = Repo::open(dir).changed().unwrap();
    testing_mode::gates_for(mode, stored, &changed, testing_mode::code_changed(&changed))
}

fn moded_round(
    dir: &Path,
    chosen: &ModePlan,
    fake: &Fake,
    facts: Option<&crate::firstmate::fact_gaps::FactTurn>,
) -> GateRecord {
    run_round(
        &RoundInput {
            delegation_id: "d-1",
            round: 1,
            checkout: dir,
            plan: &chosen.gate_plan(),
            brief: "Add a b export to app.ts.",
            done_when: "app.ts exports b",
            report: "## Report\nSummary: it was harder than it looked. I added b to app.ts.",
            now: 1,
            gate_owns_checks: false,
            facts,
            mode: Some(chosen),
        },
        fake,
    )
}

fn kinds(record: &GateRecord) -> Vec<GateKind> {
    record.gates.iter().map(|g| g.gate).collect()
}

/// The copy with `app.ts` changed and committed.
fn built() -> Fixture {
    let f = fixture("mode");
    std::fs::write(f.copy.join("app.ts"), "export const b = 2;\n").unwrap();
    sh(&f.copy, &["add", "-A"]);
    sh(&f.copy, &["commit", "-q", "-m", "work"]);
    f
}

fn failed_check_facts() -> crate::firstmate::fact_gaps::FactTurn {
    use crate::firstmate::fact_gaps::{FactCheck, FactTurn};
    FactTurn {
        checks: vec![FactCheck {
            command: "npm test".into(),
            status: "failed".into(),
            at: 3.0,
        }],
        ..Default::default()
    }
}

fn open_todo_facts() -> crate::firstmate::fact_gaps::FactTurn {
    use crate::firstmate::fact_gaps::{FactTodo, FactTurn};
    FactTurn {
        todos: vec![FactTodo {
            text: "wire the button".into(),
            open: true,
        }],
        ..Default::default()
    }
}

#[test]
fn at_ship_passes_a_built_task_without_checks_or_the_model_and_says_so() {
    let f = built();
    let fake = Fake::default();
    let chosen = moded(&f.copy, TestingMode::AtShip, None);
    let record = moded_round(&f.copy, &chosen, &fake, None);
    assert_eq!(kinds(&record), vec![GateKind::Diff, GateKind::Committed]);
    assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
    assert!(record.check.is_none(), "no verdict model in this mode");
    assert!(fake.prompts.borrow().is_empty());
    assert_eq!(record.note.as_deref(), Some("Built, not tested yet"));
    assert_eq!(record.testing_mode.as_deref(), Some("at-ship"));
    assert_eq!(record.label, None, "nothing was verified");
    assert_eq!(
        record.summary.lines().next(),
        Some("Built, not tested yet"),
        "the first line is what the task's row shows: {}",
        record.summary
    );
    assert!(record.summary.contains("Change made"), "{}", record.summary);
    // The note and the mode are on the record as the webview reads it.
    let json = serde_json::to_value(&record).unwrap();
    assert_eq!(json["note"], "Built, not tested yet");
    assert_eq!(json["testingMode"], "at-ship");
}

#[test]
fn at_ship_ignores_the_briefs_own_plan_and_never_asks_the_checks() {
    let f = built();
    let fake = Fake {
        // If the checks gate ran it would fail, and the round would fail with it.
        checks: Some(Ok(vec![run("npm test", Outcome::Failed, "1 failed")])),
        ..Default::default()
    };
    let stored = GatePlan {
        gates: vec![GateKind::Diff, GateKind::Checks, GateKind::Ratchet],
        checks: vec!["unit".into()],
    };
    let chosen = moded(&f.copy, TestingMode::AtShip, Some(&stored));
    let record = moded_round(&f.copy, &chosen, &fake, None);
    assert_eq!(kinds(&record), vec![GateKind::Diff, GateKind::Committed]);
    assert_eq!(record.verdict, Verdict::Passed);
}

#[test]
fn at_ship_still_catches_the_obvious_slips() {
    // Debris left in the diff is a finding in at-ship...
    let f = built();
    std::fs::write(f.copy.join("debug.log"), "scratch\n").unwrap();
    sh(&f.copy, &["add", "-A"]);
    sh(&f.copy, &["commit", "-q", "-m", "more"]);
    let fake = Fake::default();
    let chosen = moded(&f.copy, TestingMode::AtShip, None);
    let record = moded_round(&f.copy, &chosen, &fake, None);
    assert_eq!(record.verdict, Verdict::Failed, "{}", record.summary);
    assert!(!record.findings.is_empty());
    assert!(record.summary.contains("debug.log"), "{}", record.summary);
    // The mode is on the record; the note belongs to a pass, and this isn't one.
    assert_eq!(record.testing_mode.as_deref(), Some("at-ship"));
    assert_eq!(record.note, None);
    // ...and so is work left uncommitted.
    let f = built();
    std::fs::write(f.copy.join("later.ts"), "export const l = 1;\n").unwrap();
    let chosen = moded(&f.copy, TestingMode::AtShip, None);
    let record = moded_round(&f.copy, &chosen, &Fake::default(), None);
    assert_eq!(record.verdict, Verdict::Failed);
    assert_eq!(gate(&record, GateKind::Committed).outcome, Outcome::Failed);
}

#[test]
fn off_runs_only_the_change_and_commit_gates() {
    let f = built();
    std::fs::write(f.copy.join("debug.log"), "scratch\n").unwrap();
    sh(&f.copy, &["add", "-A"]);
    sh(&f.copy, &["commit", "-q", "-m", "more"]);
    let fake = Fake::default();
    let chosen = moded(&f.copy, TestingMode::Off, None);
    // Not even a leftover file or a failed check in the turn holds it back.
    let facts = failed_check_facts();
    let record = moded_round(&f.copy, &chosen, &fake, Some(&facts));
    assert_eq!(kinds(&record), vec![GateKind::Diff, GateKind::Committed]);
    assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
    assert!(record.findings.is_empty());
    assert!(fake.prompts.borrow().is_empty());
    assert_eq!(record.note.as_deref(), Some("Not tested"));
    assert_eq!(record.testing_mode.as_deref(), Some("off"));
    assert_eq!(record.summary.lines().next(), Some("Not tested"));
    // Uncommitted work and a change that isn't there still fail.
    std::fs::write(f.copy.join("later.ts"), "export const l = 1;\n").unwrap();
    let chosen = moded(&f.copy, TestingMode::Off, None);
    assert_eq!(
        moded_round(&f.copy, &chosen, &fake, None).verdict,
        Verdict::Failed
    );
    let untouched = fixture("off-empty");
    let stored = plan(&[GateKind::Diff]);
    let chosen = moded(&untouched.copy, TestingMode::Off, Some(&stored));
    let record = moded_round(&untouched.copy, &chosen, &fake, None);
    assert_eq!(gate(&record, GateKind::Diff).outcome, Outcome::Failed);
    assert_eq!(record.verdict, Verdict::Failed);
}

#[test]
fn at_ship_counts_a_failed_check_and_an_open_todo_but_not_the_gaps_that_assume_testing() {
    let f = built();
    let chosen = moded(&f.copy, TestingMode::AtShip, None);
    // A check that went stale after the last edit is not held against it here.
    let stale = stale_facts();
    let record = moded_round(&f.copy, &chosen, &Fake::default(), Some(&stale));
    assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
    // A failed check is.
    let failed = failed_check_facts();
    let record = moded_round(&f.copy, &chosen, &Fake::default(), Some(&failed));
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(
        record
            .summary
            .starts_with("Sent back: a check failed this turn (npm test)."),
        "{}",
        record.summary
    );
    // So is an open to-do.
    let todo = open_todo_facts();
    let record = moded_round(&f.copy, &chosen, &Fake::default(), Some(&todo));
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(record.summary.contains("open to-do"), "{}", record.summary);
    // In light, the stale check counts too.
    let light = moded(&f.copy, TestingMode::Light, None);
    let record = moded_round(&f.copy, &light, &Fake::default(), Some(&stale));
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(record.summary.contains("went stale"), "{}", record.summary);
}

#[test]
fn light_runs_the_checks_the_ratchet_and_the_model_for_changed_code() {
    let f = built();
    let fake = Fake::default();
    let chosen = moded(&f.copy, TestingMode::Light, None);
    let record = moded_round(&f.copy, &chosen, &fake, None);
    assert_eq!(
        kinds(&record),
        vec![
            GateKind::Diff,
            GateKind::Checks,
            GateKind::Committed,
            GateKind::Ratchet
        ]
    );
    assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
    assert_eq!(
        fake.prompts.borrow().len(),
        1,
        "the quick review reads the diff"
    );
    assert_eq!(record.note, None);
    assert_eq!(record.testing_mode.as_deref(), Some("light"));
    assert!(record.label.is_some());
    assert!(record
        .summary
        .contains("the quick check says the brief was met"));
    // Full is light for now.
    let full = moded(&f.copy, TestingMode::Full, None);
    let record = moded_round(&f.copy, &full, &Fake::default(), None);
    assert_eq!(record.testing_mode.as_deref(), Some("full"));
    assert_eq!(record.verdict, Verdict::Passed);
}

#[test]
fn light_with_a_failing_or_empty_test_run_is_not_a_pass() {
    let f = built();
    let chosen = moded(&f.copy, TestingMode::Light, None);
    let failing = Fake {
        checks: Some(Ok(vec![run("npm test", Outcome::Failed, "1 failed")])),
        ..Default::default()
    };
    assert_eq!(
        moded_round(&f.copy, &chosen, &failing, None).verdict,
        Verdict::Failed
    );
    let empty = Fake {
        checks: Some(Ok(vec![run(
            "npm test",
            Outcome::Passed,
            "No test files found",
        )])),
        ..Default::default()
    };
    let record = moded_round(&f.copy, &chosen, &empty, None);
    assert_eq!(record.verdict, Verdict::Unsure);
    assert!(empty.prompts.borrow().is_empty());
}

#[test]
fn light_honours_the_briefs_named_checks_and_gates() {
    struct Named(RefCell<Vec<Vec<String>>>);
    impl Runners for Named {
        fn checks(
            &self,
            _checkout: &Path,
            named: &[String],
            _changed: &[String],
        ) -> Result<Vec<CommandEvidence>, String> {
            self.0.borrow_mut().push(named.to_vec());
            Ok(vec![run("lint", Outcome::Passed, "ok")])
        }
        fn routes(&self, _checkout: &Path) -> Option<CommandEvidence> {
            None
        }
        fn verdict(&self, _prompt: &str) -> Result<String, String> {
            Ok(r#"{"verdict":"met","why":"ok"}"#.into())
        }
    }
    let f = built();
    let stored = GatePlan {
        gates: vec![GateKind::Checks, GateKind::Routes],
        checks: vec!["unit".into()],
    };
    let chosen = moded(&f.copy, TestingMode::Light, Some(&stored));
    let named = Named(RefCell::new(Vec::new()));
    let record = run_round(
        &RoundInput {
            delegation_id: "d-1",
            round: 1,
            checkout: &f.copy,
            plan: &chosen.gate_plan(),
            brief: "Add a b export to app.ts.",
            done_when: "app.ts exports b",
            report: "Done.",
            now: 1,
            gate_owns_checks: false,
            facts: None,
            mode: Some(&chosen),
        },
        &named,
    );
    assert_eq!(named.0.borrow().as_slice(), &[vec!["unit".to_string()]]);
    // The brief named `routes` and this project has none: that gate could not run, as it always has.
    assert!(kinds(&record).contains(&GateKind::Routes));
    assert_eq!(gate(&record, GateKind::Routes).outcome, Outcome::NotRun);
    assert_eq!(record.verdict, Verdict::Unsure);
}

#[test]
fn light_with_docs_only_runs_no_checks_but_still_reviews() {
    let f = fixture("docs-only");
    std::fs::create_dir_all(f.copy.join("docs")).unwrap();
    std::fs::write(f.copy.join("docs").join("guide.md"), "# Guide\n").unwrap();
    sh(&f.copy, &["add", "-A"]);
    sh(&f.copy, &["commit", "-q", "-m", "docs"]);
    let fake = Fake::default();
    let chosen = moded(&f.copy, TestingMode::Light, None);
    let record = moded_round(&f.copy, &chosen, &fake, None);
    assert_eq!(kinds(&record), vec![GateKind::Diff, GateKind::Committed]);
    assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
    assert_eq!(fake.prompts.borrow().len(), 1);
    // At ship, a docs change is checked the same way as code: for slips.
    let at_ship = moded(&f.copy, TestingMode::AtShip, None);
    assert_eq!(
        moded_round(&f.copy, &at_ship, &Fake::default(), None)
            .note
            .as_deref(),
        Some("Built, not tested yet")
    );
}

#[test]
fn the_routes_check_runs_in_every_mode() {
    for mode in TestingMode::ALL {
        let f = built();
        let chosen = moded(&f.copy, mode, None);
        let failing = Fake {
            routes: Some(run(
                "Routes check",
                Outcome::Failed,
                "DELETE /x answers 404",
            )),
            ..Default::default()
        };
        let record = moded_round(&f.copy, &chosen, &failing, None);
        assert_eq!(
            gate(&record, GateKind::Routes).outcome,
            Outcome::Failed,
            "{mode:?}"
        );
        assert_eq!(record.verdict, Verdict::Failed, "{mode:?}");
        let passing = Fake {
            routes: Some(run("Routes check", Outcome::Passed, "ok")),
            ..Default::default()
        };
        let record = moded_round(&f.copy, &chosen, &passing, None);
        assert_eq!(
            gate(&record, GateKind::Routes).outcome,
            Outcome::Passed,
            "{mode:?}"
        );
    }
}

#[test]
fn a_copy_that_is_not_a_checkout_is_not_a_pass_in_any_mode() {
    let dir = std::env::temp_dir().join(format!(
        "hivra-gates-nogit-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    for mode in TestingMode::ALL {
        // The diff couldn't be read, so the caller runs the gates as if code changed.
        let chosen = testing_mode::gates_for(mode, None, &[], true);
        let record = moded_round(&dir, &chosen, &Fake::default(), None);
        assert_eq!(
            gate(&record, GateKind::Diff).outcome,
            Outcome::NotRun,
            "{mode:?}"
        );
        assert_eq!(record.verdict, Verdict::Unsure, "{mode:?}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_record_from_before_the_modes_still_reads() {
    let old = serde_json::json!({
        "delegationId": "d-1", "round": 1, "at": 1, "verdict": "passed",
        "gates": [], "check": null, "summary": "Change made passed; the quick check says the brief was met."
    });
    let record: GateRecord = serde_json::from_value(old).unwrap();
    assert_eq!(record.testing_mode, None);
    assert_eq!(record.note, None);
    // And one without a mode writes neither field.
    let json = serde_json::to_value(&record).unwrap();
    assert!(json.get("testingMode").is_none());
    assert!(json.get("note").is_none());
}

// ---- SC-3a: a pass reads Done with its note, never a bare Done ---------------------------------------------------------

#[test]
fn a_task_that_passed_without_being_tested_reads_done_with_that_said() {
    use crate::firstmate::status::Status;
    for (summary, notice) in [
        (
            "Built, not tested yet\nChange made, Work committed passed.",
            Some("Built, not tested yet"),
        ),
        ("Not tested\nChange made passed.", Some("Not tested")),
        (
            "Change made, Project checks passed; the quick check says the brief was met.",
            None,
        ),
        // Only the exact note counts: a line that merely starts with it is not one.
        ("Built, not tested yet or so\nChange made passed.", None),
        ("", None),
    ] {
        let mut conn = store();
        let row = record_row(&mut conn);
        crate::delegations::set_gate_verdict(
            &mut conn,
            &row.id,
            GateVerdict::PASSED,
            summary,
            None,
            2,
        )
        .unwrap();
        let settled = settle_done(&mut conn, &row);
        assert_eq!(settled.status, Status::Done, "{summary:?}");
        assert_eq!(settled.status_notice.as_deref(), notice, "{summary:?}");
    }
}
