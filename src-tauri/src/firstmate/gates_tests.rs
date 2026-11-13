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
    /// SC-4: how the brief's own commands end, in order; one that runs past the list exits 0 and prints `ok`.
    brief_runs: RefCell<Vec<crate::firstmate::brief_checks::RawRun>>,
    /// SC-4: what ran, in order: `project checks`, then `brief: <command>` for each of the brief's lines.
    events: RefCell<Vec<String>>,
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
        self.events.borrow_mut().push("project checks".into());
        self.checks
            .clone()
            .unwrap_or_else(|| Ok(vec![run("npm test", Outcome::Passed, "14 passed")]))
    }
    fn brief_line(
        &self,
        _checkout: &Path,
        _index: usize,
        line: &crate::firstmate::brief_checks::BriefCheck,
    ) -> crate::firstmate::brief_checks::RawRun {
        self.events
            .borrow_mut()
            .push(format!("brief: {}", line.command));
        let mut scripted = self.brief_runs.borrow_mut();
        if scripted.is_empty() {
            crate::firstmate::brief_checks::RawRun {
                ended: crate::firstmate::brief_checks::Ended::Exited(Some(0)),
                output: "ok".into(),
                seconds: 0.1,
            }
        } else {
            scripted.remove(0)
        }
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
            brief_round: None,
            fix: None,
            history: None,
            test_debt: None,
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
            brief_round: None,
            fix: None,
            history: None,
            test_debt: None,
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
            brief_round: None,
            fix: None,
            history: None,
            test_debt: None,
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
            brief_round: None,
            fix: None,
            history: None,
            test_debt: None,
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
    testing_mode::gates_for(
        mode,
        stored,
        &changed,
        testing_mode::code_changed(&changed),
        false,
    )
}

fn moded_round(
    dir: &Path,
    chosen: &ModePlan,
    fake: &Fake,
    facts: Option<&crate::firstmate::fact_gaps::FactTurn>,
) -> GateRecord {
    moded_round_fixing(dir, chosen, fake, facts, None)
}

/// SC-7: the same round for a bug-fix brief, with what the "no red before the fix" gap reads.
fn moded_round_fixing(
    dir: &Path,
    chosen: &ModePlan,
    fake: &Fake,
    facts: Option<&crate::firstmate::fact_gaps::FactTurn>,
    fix: Option<&crate::firstmate::fact_gaps::FixEvidence>,
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
            brief_round: None,
            fix,
            history: None,
            test_debt: None,
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

// ---- PT-5: test debt, in at-ship only ---------------------------------------------------------------------------------------

/// The same round with the test debt plan `firstmate_run_gates` hands it in `at-ship`.
fn moded_round_debt(
    dir: &Path,
    chosen: &ModePlan,
    facts: Option<&crate::firstmate::fact_gaps::FactTurn>,
    plan: Option<&crate::test_debt::divert::Plan>,
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
            brief_round: None,
            fix: None,
            history: None,
            test_debt: plan,
        },
        &Fake::default(),
    )
}

const VITEST_OTHER: &str = " FAIL  src/other.test.ts > suite > works\nAssertionError: expected 1 to be 2\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";
const VITEST_A: &str = " FAIL  src/a.test.ts > suite > works\nAssertionError: expected 1 to be 2\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";

/// What `firstmate_run_gates` does in `at-ship`: read the task's runs, sort its failing tests, hand `run_round` the plan.
fn debt_plan(
    data: &crate::test_debt::testing::Temp,
    copy: &Path,
    changed: &[&str],
    output: &str,
) -> crate::test_debt::gate::Outcome {
    let changed: Vec<String> = changed.iter().map(|s| (*s).to_string()).collect();
    crate::test_debt::gate::at_ship(&crate::test_debt::gate::Input {
        data_dir: data.path(),
        project: "/projects/tally",
        delegation_id: "d-1",
        task_title: "Add b",
        checkout: copy,
        changed: &changed,
        runs: &[crate::firstmate::fact_gaps::FactRun {
            command: "npm test".into(),
            at: 3.0,
            output: output.into(),
        }],
        now: 5,
    })
    .unwrap()
}

#[test]
fn at_ship_does_not_send_a_task_back_for_a_failed_check_on_tests_that_are_not_its_own() {
    let f = built();
    let chosen = moded(&f.copy, TestingMode::AtShip, None);
    let failed = failed_check_facts();
    // Today (no plan): a failed check sends it back.
    assert_eq!(
        moded_round_debt(&f.copy, &chosen, Some(&failed), None).verdict,
        Verdict::Failed
    );
    // The failing test is another task's: it goes on the list and the task passes.
    let data = crate::test_debt::testing::Temp::new();
    let outcome = debt_plan(&data, &f.copy, &["app.ts"], VITEST_OTHER);
    assert_eq!(outcome.listed, 1);
    let record = moded_round_debt(&f.copy, &chosen, Some(&failed), Some(&outcome.plan));
    assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
    assert_eq!(record.note.as_deref(), Some("Built, not tested yet"));
    let doc = crate::test_debt::store::read(data.path(), "/projects/tally");
    assert_eq!(doc.items.len(), 1);
    assert_eq!(doc.items[0].file, "src/other.test.ts");
    // An open to-do still sends it back: only the failed check for other tasks' tests is let go.
    let mut with_todo = failed_check_facts();
    with_todo.todos = open_todo_facts().todos;
    let record = moded_round_debt(&f.copy, &chosen, Some(&with_todo), Some(&outcome.plan));
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(record.summary.contains("open to-do"), "{}", record.summary);
}

#[test]
fn a_task_that_changed_src_a_ts_is_failed_for_a_failing_a_test_ts_and_it_is_not_put_on_the_list() {
    let f = built();
    let chosen = moded(&f.copy, TestingMode::AtShip, None);
    let failed = failed_check_facts();
    let data = crate::test_debt::testing::Temp::new();
    let outcome = debt_plan(&data, &f.copy, &["src/a.ts"], VITEST_A);
    assert_eq!(outcome.plan.own.len(), 1);
    assert_eq!(outcome.listed, 0);
    let record = moded_round_debt(&f.copy, &chosen, Some(&failed), Some(&outcome.plan));
    assert_eq!(record.verdict, Verdict::Failed, "{}", record.summary);
    assert!(
        record
            .summary
            .starts_with("Sent back: a check failed this turn (npm test)."),
        "{}",
        record.summary
    );
    assert!(
        crate::test_debt::store::read(data.path(), "/projects/tally")
            .items
            .is_empty(),
        "its own failing test is never a debt"
    );
}

#[test]
fn a_red_run_checks_run_on_the_tasks_own_tests_sends_it_back_in_at_ship() {
    let f = built();
    let chosen = moded(&f.copy, TestingMode::AtShip, None);
    let plan = crate::test_debt::divert::Plan {
        add_gaps: vec![
            "A check failed this turn (run_checks affected): src/a.test.ts > suite > works.".into(),
        ],
        ..Default::default()
    };
    // No transcript check failed at all: the app's own record is what fails the round, with or without a turn's facts.
    let record = moded_round_debt(&f.copy, &chosen, None, Some(&plan));
    let clean = crate::firstmate::fact_gaps::FactTurn::default();
    let record_with_turn = moded_round_debt(&f.copy, &chosen, Some(&clean), Some(&plan));
    for r in [&record, &record_with_turn] {
        assert_eq!(r.verdict, Verdict::Failed, "{}", r.summary);
        assert!(r.summary.contains("run_checks affected"), "{}", r.summary);
    }
}

#[test]
fn the_weakened_and_deleted_test_findings_stay_in_force_whatever_the_plan_says() {
    let f = built();
    // A task that skipped a test (the fixture's `app.test.ts` has three): the findings run in at-ship, and a plan that clears a failed
    // check does not touch them. The list is not a way to get a skipped, weakened or deleted test past the guard.
    std::fs::write(
        f.copy.join("app.test.ts"),
        "it.skip(\"one\", () => {});\nit(\"two\", () => {});\ntest(\"three\", () => {});\n",
    )
    .unwrap();
    sh(&f.copy, &["add", "-A"]);
    sh(&f.copy, &["commit", "-q", "-m", "skip a test"]);
    let chosen = moded(&f.copy, TestingMode::AtShip, None);
    assert!(chosen.run_findings, "findings run in at-ship");
    let plan = crate::test_debt::divert::Plan {
        clear_gaps: vec![crate::firstmate::fact_gaps::failed_check_gap_for(
            "npm test",
        )],
        ..Default::default()
    };
    let record = moded_round_debt(&f.copy, &chosen, Some(&failed_check_facts()), Some(&plan));
    assert_eq!(record.verdict, Verdict::Failed, "{}", record.summary);
    assert!(
        record
            .findings
            .iter()
            .any(|finding| finding.kind == done_check::FindingKind::WeakenedTest),
        "{:?}",
        record.findings
    );
    let without = moded_round_debt(&f.copy, &chosen, Some(&failed_check_facts()), None);
    assert_eq!(record.findings.len(), without.findings.len());
}

#[test]
fn light_and_full_never_use_the_list() {
    let f = built();
    let failed = failed_check_facts();
    for mode in [TestingMode::Light, TestingMode::Full] {
        let chosen = moded(&f.copy, mode, None);
        assert!(
            !crate::test_debt::applies(chosen.mode, chosen.as_today),
            "{mode:?}"
        );
        // With no plan, as `firstmate_run_gates` leaves it there, the failed check is the task's to fix.
        let record = moded_round_debt(&f.copy, &chosen, Some(&failed), None);
        assert_eq!(
            record.verdict,
            Verdict::Failed,
            "{mode:?}: {}",
            record.summary
        );
    }
    let chosen = moded(&f.copy, TestingMode::AtShip, None);
    assert!(crate::test_debt::applies(chosen.mode, chosen.as_today));
}

const VITEST_APP: &str = " FAIL  app.test.ts > suite > two\nAssertionError: expected 1 to be 2\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";
const VITEST_APP_CRITICAL: &str = " FAIL  app.test.ts > suite > @critical works\nAssertionError: expected 1 to be 2\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";

/// What `firstmate_run_gates` does in `light` and `full`: read the task's runs and its report's `Quarantine:` lines, hand `run_round` the plan.
fn quarantine_plan(
    data: &crate::test_debt::testing::Temp,
    copy: &Path,
    output: &str,
    report: &str,
) -> crate::test_debt::gate::Outcome {
    crate::test_debt::gate::quarantine(
        &crate::test_debt::gate::Input {
            data_dir: data.path(),
            project: "/projects/tally",
            delegation_id: "d-1",
            task_title: "Add b",
            checkout: copy,
            changed: &["other.ts".to_string()],
            runs: &[crate::firstmate::fact_gaps::FactRun {
                command: "npm test".into(),
                at: 3.0,
                output: output.into(),
            }],
            now: 5,
        },
        report,
        &[],
        true,
    )
    .unwrap()
}

#[test]
fn in_light_and_full_a_quarantined_test_no_longer_sends_a_task_back_for_a_failed_check() {
    let f = built();
    let failed = failed_check_facts();
    let data = crate::test_debt::testing::Temp::new();
    let outcome = quarantine_plan(
        &data,
        &f.copy,
        VITEST_APP,
        "Done.\nQuarantine: suite > two | flaky, passes on a re-run\n",
    );
    assert_eq!(outcome.quarantined, 1, "{:?}", outcome.plan.add_gaps);
    for mode in [TestingMode::Light, TestingMode::Full] {
        let chosen = moded(&f.copy, mode, None);
        // Without the quarantine the failed check is the task's to fix, as it always was.
        assert_eq!(
            moded_round_debt(&f.copy, &chosen, Some(&failed), None).verdict,
            Verdict::Failed,
            "{mode:?}"
        );
        let record = moded_round_debt(&f.copy, &chosen, Some(&failed), Some(&outcome.plan));
        // Not sent back for the failed check. (In `full` the running checker can't run in this fixture, so that round reads "unsure"
        // rather than passed; light has the cheap check and passes.)
        assert_ne!(
            record.verdict,
            Verdict::Failed,
            "{mode:?}: {}",
            record.summary
        );
        assert!(
            !record.summary.to_lowercase().contains("check failed"),
            "{mode:?}: {}",
            record.summary
        );
        if mode == TestingMode::Light {
            assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
        }
        // The rest of the round is as it was: the gates ran, and nothing was put on the list.
        assert!(!record.gates.is_empty(), "{mode:?}");
    }
    let doc = crate::test_debt::store::read(data.path(), "/projects/tally");
    assert!(doc.items.is_empty());
    assert_eq!(doc.quarantine.len(), 1);
    // An open to-do still sends it back.
    let mut with_todo = failed_check_facts();
    with_todo.todos = open_todo_facts().todos;
    let chosen = moded(&f.copy, TestingMode::Light, None);
    let record = moded_round_debt(&f.copy, &chosen, Some(&with_todo), Some(&outcome.plan));
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(record.summary.contains("open to-do"), "{}", record.summary);
}

#[test]
fn in_light_and_full_a_quarantine_request_for_a_critical_test_is_refused_and_fails_the_round() {
    let f = built();
    let data = crate::test_debt::testing::Temp::new();
    let outcome = quarantine_plan(
        &data,
        &f.copy,
        VITEST_APP_CRITICAL,
        "Done.\nQuarantine: suite > @critical works | flaky\n",
    );
    assert_eq!(outcome.quarantined, 0);
    assert!(
        crate::test_debt::store::read(data.path(), "/projects/tally")
            .quarantine
            .is_empty(),
        "nothing was quarantined"
    );
    // The check did not even fail in the transcript: the refusal alone sends the task back, and says why.
    let clean = crate::firstmate::fact_gaps::FactTurn::default();
    for mode in [TestingMode::Light, TestingMode::Full] {
        let chosen = moded(&f.copy, mode, None);
        let record = moded_round_debt(&f.copy, &chosen, Some(&clean), Some(&outcome.plan));
        assert_eq!(
            record.verdict,
            Verdict::Failed,
            "{mode:?}: {}",
            record.summary
        );
        assert!(
            record.summary.to_lowercase().contains("quarantine refused"),
            "{mode:?}: {}",
            record.summary
        );
        assert!(
            record.summary.contains("ask your first mate"),
            "{}",
            record.summary
        );
    }
}

#[test]
fn a_sensitive_change_in_test_at_ship_is_checked_in_full_but_keeps_the_list_for_tests_that_are_not_its_own(
) {
    let f = built();
    let failed = failed_check_facts();
    let changed = vec!["src/auth/login.ts".to_string()];
    let chosen = crate::firstmate::testing_mode::gates_for_with(
        TestingMode::AtShip,
        None,
        &changed,
        true,
        false,
        true,
        false,
        crate::firstmate::checker_when::WhenRule::FollowMode,
    );
    assert!(chosen.sensitive);
    // Its worker was told a red test that isn't its own goes on the list, so it still does; and the quarantine path is not its.
    assert!(crate::test_debt::applies(chosen.mode, chosen.as_today));
    assert!(!crate::test_debt::reads_quarantine(&chosen));
    // The project's checks ran, which Test at ship does not do for an ordinary change.
    let record = moded_round_debt(&f.copy, &chosen, None, None);
    assert!(
        record
            .gates
            .iter()
            .any(|gate| gate.gate == GateKind::Checks),
        "{:?}",
        kinds(&record)
    );
    let ordinary = moded(&f.copy, TestingMode::AtShip, None);
    let plain = moded_round_debt(&f.copy, &ordinary, None, None);
    assert!(plain.gates.iter().all(|gate| gate.gate != GateKind::Checks));
    // Another task's failing test goes on the list and does not send it back...
    let data = crate::test_debt::testing::Temp::new();
    let other = debt_plan(&data, &f.copy, &["app.ts"], VITEST_OTHER);
    assert_eq!(other.listed, 1);
    let record = moded_round_debt(&f.copy, &chosen, Some(&failed), Some(&other.plan));
    assert_ne!(record.verdict, Verdict::Failed, "{}", record.summary);
    // ...and its own failing test still does.
    let own_data = crate::test_debt::testing::Temp::new();
    let own = debt_plan(&own_data, &f.copy, &["src/a.ts"], VITEST_A);
    assert_eq!(own.plan.own.len(), 1);
    let record = moded_round_debt(&f.copy, &chosen, Some(&failed), Some(&own.plan));
    assert_eq!(record.verdict, Verdict::Failed, "{}", record.summary);
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
    // SC-5: full reads a code diff with the running checker, not the quick review. A runner that has no checker leaves the
    // round unsure and says so: the task is never passed on a check that could not run.
    let full = moded(&f.copy, TestingMode::Full, None);
    let fake = Fake::default();
    let record = moded_round(&f.copy, &full, &fake, None);
    assert_eq!(record.testing_mode.as_deref(), Some("full"));
    assert_eq!(record.verdict, Verdict::Unsure);
    assert!(
        record.summary.contains("could not run"),
        "{}",
        record.summary
    );
    assert!(
        fake.prompts.borrow().is_empty(),
        "the quick review is not asked in its place"
    );
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
            brief_round: None,
            fix: None,
            history: None,
            test_debt: None,
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
        let chosen = testing_mode::gates_for(mode, None, &[], true, false);
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

// ---- SC-4: the brief's own check lines and do-not-touch list -------------------------------------------------------------

use crate::firstmate::brief_checks::{self, BriefCheck, BriefRound, Ended, RawRun};

fn line(what: &str, command: &str, expect: Option<&str>) -> BriefCheck {
    BriefCheck {
        what: what.into(),
        command: command.into(),
        expect: expect.map(str::to_string),
        passes: None,
        ran_at: None,
        output_tail: None,
    }
}

fn ends(code: i32, output: &str) -> RawRun {
    RawRun {
        ended: Ended::Exited(Some(code)),
        output: output.into(),
        seconds: 0.2,
    }
}

fn briefed(lines: Vec<BriefCheck>, leave: &[&str]) -> BriefRound {
    BriefRound {
        lines,
        leave: leave.iter().map(|p| p.to_string()).collect(),
        checks_unreadable: None,
        leave_unreadable: None,
    }
}

/// A round of `mode` over the copy with the brief's lines and list, `gate_owns_checks` as asked.
fn brief_round_in(
    dir: &Path,
    mode: TestingMode,
    stored: Option<&GatePlan>,
    brief: &BriefRound,
    fake: &Fake,
    gate_owns_checks: bool,
) -> GateRecord {
    let chosen = moded(dir, mode, stored);
    run_round(
        &RoundInput {
            delegation_id: "d-1",
            round: 1,
            checkout: dir,
            plan: &chosen.gate_plan(),
            brief: "Add a b export to app.ts.",
            done_when: "app.ts exports b",
            report: "## Report\nSummary: added b to app.ts.",
            now: 42,
            gate_owns_checks,
            facts: None,
            mode: Some(&chosen),
            brief_round: Some(brief),
            fix: None,
            history: None,
            test_debt: None,
        },
        fake,
    )
}

fn brief_round(dir: &Path, mode: TestingMode, brief: &BriefRound, fake: &Fake) -> GateRecord {
    brief_round_in(dir, mode, None, brief, fake, false)
}

fn two_lines() -> Vec<BriefCheck> {
    vec![
        line("it builds", "npm run build", None),
        line("the route answers", "curl localhost:3000/score", Some("ok")),
    ]
}

#[test]
fn light_runs_the_briefs_lines_after_the_projects_checks_and_shows_them_as_evidence() {
    let f = built();
    let fake = Fake::default();
    let record = brief_round(
        &f.copy,
        TestingMode::Light,
        &briefed(two_lines(), &[]),
        &fake,
    );
    assert_eq!(
        fake.events.borrow().as_slice(),
        &[
            "project checks",
            "brief: npm run build",
            "brief: curl localhost:3000/score"
        ],
        "the project's checks first, then each line in order"
    );
    let checks = gate(&record, GateKind::Checks);
    assert_eq!(checks.outcome, Outcome::Passed, "{}", checks.detail);
    let commands: Vec<&str> = checks.evidence.iter().map(|e| e.command.as_str()).collect();
    assert_eq!(
        commands,
        ["npm test", "npm run build", "curl localhost:3000/score"]
    );
    assert!(
        checks.detail.contains("2 brief check(s) ran and passed"),
        "{}",
        checks.detail
    );
    assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
    // The results are carried for the row.
    assert_eq!(record.brief_lines.len(), 2);
    assert!(record
        .brief_lines
        .iter()
        .all(|r| r.passes == Some(true) && r.ran_at == 42));
    // And they are not kept twice in the round's stored evidence.
    assert!(serde_json::to_value(&record)
        .unwrap()
        .get("briefLines")
        .is_none());
}

#[test]
fn full_runs_them_for_a_code_diff_even_when_the_brief_named_no_gates() {
    let f = built();
    let fake = Fake::default();
    // No stored plan at all: the diff is code, so `full` gives the round the checks gate, and the lines run in it.
    let record = brief_round(
        &f.copy,
        TestingMode::Full,
        &briefed(two_lines(), &[]),
        &fake,
    );
    assert_eq!(fake.events.borrow().len(), 3);
    assert_eq!(gate(&record, GateKind::Checks).evidence.len(), 3);
    assert_eq!(record.testing_mode.as_deref(), Some("full"));
}

#[test]
fn at_ship_and_off_never_run_the_briefs_lines() {
    for mode in [TestingMode::AtShip, TestingMode::Off] {
        let f = built();
        let fake = Fake::default();
        let stored = GatePlan {
            gates: vec![GateKind::Diff, GateKind::Checks],
            checks: Vec::new(),
        };
        let record = brief_round_in(
            &f.copy,
            mode,
            Some(&stored),
            &briefed(two_lines(), &[]),
            &fake,
            false,
        );
        assert!(fake.events.borrow().is_empty(), "{mode:?}: nothing ran");
        assert!(record.brief_lines.is_empty(), "{mode:?}");
        assert_eq!(
            record.verdict,
            Verdict::Passed,
            "{mode:?}: {}",
            record.summary
        );
    }
}

#[test]
fn a_docs_only_change_still_runs_the_briefs_lines_on_a_gate_that_says_the_projects_checks_did_not()
{
    let f = fixture("brief-docs");
    std::fs::create_dir_all(f.copy.join("docs")).unwrap();
    std::fs::write(f.copy.join("docs/notes.md"), "# notes\n").unwrap();
    sh(&f.copy, &["add", "-A"]);
    sh(&f.copy, &["commit", "-q", "-m", "docs"]);
    // No code changed, so the round has no project checks gate. The lines are the proof the brief asked for: they run.
    let fake = Fake::default();
    let record = brief_round(
        &f.copy,
        TestingMode::Light,
        &briefed(two_lines(), &[]),
        &fake,
    );
    assert_eq!(
        fake.events.borrow().as_slice(),
        &["brief: npm run build", "brief: curl localhost:3000/score"],
        "the project's checks did not run, the lines did"
    );
    let checks = gate(&record, GateKind::Checks);
    assert_eq!(checks.outcome, Outcome::Passed, "{}", checks.detail);
    assert!(
        checks
            .detail
            .contains("The project's checks didn't run for this change"),
        "{}",
        checks.detail
    );
    assert_eq!(checks.evidence.len(), 2);
    assert_eq!(record.brief_lines.len(), 2);
    // A failing line fails the round here too, and the other modes still run none of them.
    let failing = Fake {
        brief_runs: RefCell::new(vec![ends(1, "boom")]),
        ..Default::default()
    };
    let record = brief_round(
        &f.copy,
        TestingMode::Light,
        &briefed(two_lines(), &[]),
        &failing,
    );
    assert_eq!(record.verdict, Verdict::Failed, "{}", record.summary);
    for mode in [TestingMode::AtShip, TestingMode::Off] {
        let quiet = Fake::default();
        brief_round(&f.copy, mode, &briefed(two_lines(), &[]), &quiet);
        assert!(quiet.events.borrow().is_empty(), "{mode:?}");
    }
    // Lines that can't be read are not read as none on that gate either.
    let mut damaged = briefed(Vec::new(), &[]);
    damaged.checks_unreadable = Some("the brief's own checks couldn't be read".into());
    let record = brief_round(&f.copy, TestingMode::Light, &damaged, &Fake::default());
    assert_eq!(gate(&record, GateKind::Checks).outcome, Outcome::NotRun);
    assert_eq!(record.verdict, Verdict::Unsure, "{}", record.summary);
    // A "tests pass" claim is not verified by lines alone.
    let said = Fake::default();
    let claimed = run_round(
        &RoundInput {
            delegation_id: "d-1",
            round: 1,
            checkout: &f.copy,
            plan: &moded(&f.copy, TestingMode::Light, None).gate_plan(),
            brief: "Write the notes.",
            done_when: "the notes exist",
            report: "All tests pass.",
            now: 1,
            gate_owns_checks: false,
            facts: None,
            mode: Some(&moded(&f.copy, TestingMode::Light, None)),
            brief_round: Some(&briefed(two_lines(), &[])),
            fix: None,
            history: None,
            test_debt: None,
        },
        &said,
    );
    assert!(
        !claimed.claims.iter().any(|row| row
            .observed
            .contains("the app ran the project's checks itself: they passed")),
        "{:?}",
        claimed.claims
    );
}

#[test]
fn moving_a_file_out_of_a_do_not_touch_folder_is_still_a_change_to_it() {
    let f = fixture("leave-rename");
    std::fs::create_dir_all(f.project.join("src/legacy")).unwrap();
    std::fs::write(
        f.project.join("src/legacy/a.ts"),
        "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    )
    .unwrap();
    sh(&f.project, &["add", "-A"]);
    sh(&f.project, &["commit", "-q", "-m", "legacy"]);
    sh(&f.copy, &["merge", "-q", "main"]);
    std::fs::create_dir_all(f.copy.join("src/new")).unwrap();
    sh(&f.copy, &["mv", "src/legacy/a.ts", "src/new/a.ts"]);
    sh(&f.copy, &["commit", "-q", "-m", "move it"]);
    // With rename detection the diff names only where it went. The do-not-touch list reads the exact change.
    let repo = Repo::open(&f.copy);
    assert_eq!(repo.changed().unwrap(), vec!["src/new/a.ts".to_string()]);
    let exact = repo.changed_exact().unwrap();
    assert!(exact.contains(&"src/legacy/a.ts".to_string()), "{exact:?}");
    let record = brief_round(
        &f.copy,
        TestingMode::AtShip,
        &briefed(Vec::new(), &["src/legacy"]),
        &Fake::default(),
    );
    let paths: Vec<&str> = record
        .findings
        .iter()
        .filter(|finding| finding.kind == done_check::FindingKind::DoNotTouch)
        .filter_map(|finding| finding.file.as_deref())
        .collect();
    assert_eq!(paths, ["src/legacy/a.ts"]);
    assert_eq!(record.verdict, Verdict::Failed, "{}", record.summary);
    // The folder it moved to is not on the list.
    let record = brief_round(
        &f.copy,
        TestingMode::AtShip,
        &briefed(Vec::new(), &["src/other"]),
        &Fake::default(),
    );
    assert!(record
        .findings
        .iter()
        .all(|finding| finding.kind != done_check::FindingKind::DoNotTouch));
}

#[test]
fn an_exit_that_is_not_the_one_asked_for_fails_the_round_without_asking_the_model() {
    let f = built();
    let fake = Fake {
        brief_runs: RefCell::new(vec![ends(2, "error TS2322: bad type")]),
        ..Default::default()
    };
    let record = brief_round(
        &f.copy,
        TestingMode::Light,
        &briefed(two_lines(), &[]),
        &fake,
    );
    let checks = gate(&record, GateKind::Checks);
    assert_eq!(checks.outcome, Outcome::Failed);
    assert_eq!(record.verdict, Verdict::Failed);
    assert!(record.summary.contains("it builds"), "{}", record.summary);
    assert!(record.summary.contains("exited 2"), "{}", record.summary);
    assert!(
        record.summary.contains("error TS2322"),
        "the output is in the summary: {}",
        record.summary
    );
    assert_eq!(record.brief_lines[0].passes, Some(false));
    assert_eq!(
        record.brief_lines[1].passes,
        Some(true),
        "the next line still ran"
    );
    assert!(fake.prompts.borrow().is_empty());
}

#[test]
fn text_the_output_does_not_contain_fails_and_exit_n_passes_on_that_exit() {
    let f = built();
    let fake = Fake {
        brief_runs: RefCell::new(vec![ends(0, "built"), ends(0, "{\"status\": \"down\"}")]),
        ..Default::default()
    };
    let record = brief_round(
        &f.copy,
        TestingMode::Light,
        &briefed(two_lines(), &[]),
        &fake,
    );
    assert_eq!(gate(&record, GateKind::Checks).outcome, Outcome::Failed);
    assert!(
        record.summary.contains("didn't contain"),
        "{}",
        record.summary
    );
    assert_eq!(record.brief_lines[1].passes, Some(false));
    // A line that asks for exit 1 and gets it.
    let fake = Fake {
        brief_runs: RefCell::new(vec![ends(1, "1 failed")]),
        ..Default::default()
    };
    let red = vec![line(
        "the old test fails first",
        "npm test -- old",
        Some("exit 1"),
    )];
    let record = brief_round(&f.copy, TestingMode::Light, &briefed(red, &[]), &fake);
    assert_eq!(
        gate(&record, GateKind::Checks).outcome,
        Outcome::Passed,
        "{}",
        record.summary
    );
}

#[test]
fn a_missing_command_could_not_run_and_the_round_is_unsure_never_passed() {
    let f = built();
    let fake = Fake {
        brief_runs: RefCell::new(vec![
            ends(127, "sh: nosuchtool: command not found"),
            ends(0, "ok"),
        ]),
        ..Default::default()
    };
    let record = brief_round(
        &f.copy,
        TestingMode::Light,
        &briefed(two_lines(), &[]),
        &fake,
    );
    let checks = gate(&record, GateKind::Checks);
    assert_eq!(checks.outcome, Outcome::NotRun, "{}", checks.detail);
    assert!(checks.detail.contains("couldn't run"), "{}", checks.detail);
    assert_eq!(checks.evidence[1].outcome, Outcome::NotRun);
    assert_eq!(record.verdict, Verdict::Unsure, "{}", record.summary);
    assert_eq!(
        record.brief_lines[0].passes, None,
        "neither a pass nor a failure"
    );
    assert!(fake.prompts.borrow().is_empty());
    // A runner that can't start anything at all (the default) is the same.
    struct Blind;
    impl Runners for Blind {
        fn checks(
            &self,
            _c: &Path,
            _n: &[String],
            _ch: &[String],
        ) -> Result<Vec<CommandEvidence>, String> {
            Ok(vec![run("npm test", Outcome::Passed, "14 passed")])
        }
        fn routes(&self, _c: &Path) -> Option<CommandEvidence> {
            None
        }
        fn verdict(&self, _p: &str) -> Result<String, String> {
            Ok(r#"{"verdict":"met","why":"ok"}"#.into())
        }
    }
    let chosen = moded(&f.copy, TestingMode::Light, None);
    let blind = run_round(
        &RoundInput {
            delegation_id: "d-1",
            round: 1,
            checkout: &f.copy,
            plan: &chosen.gate_plan(),
            brief: "Add b",
            done_when: "b",
            report: "Done.",
            now: 1,
            gate_owns_checks: false,
            facts: None,
            mode: Some(&chosen),
            brief_round: Some(&briefed(two_lines(), &[])),
            fix: None,
            history: None,
            test_debt: None,
        },
        &Blind,
    );
    assert_eq!(gate(&blind, GateKind::Checks).outcome, Outcome::NotRun);
    assert_eq!(blind.verdict, Verdict::Unsure);
}

#[test]
fn a_line_that_ran_zero_tests_could_not_run() {
    let f = built();
    let zero = "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 0.00s";
    let fake = Fake {
        brief_runs: RefCell::new(vec![ends(0, zero)]),
        ..Default::default()
    };
    let one = vec![line("the new test passes", "cargo test brand_new", None)];
    let record = brief_round(&f.copy, TestingMode::Light, &briefed(one, &[]), &fake);
    let checks = gate(&record, GateKind::Checks);
    assert_eq!(checks.outcome, Outcome::NotRun);
    assert!(
        checks.detail.contains("ran zero tests"),
        "{}",
        checks.detail
    );
    assert_eq!(record.verdict, Verdict::Unsure);
    assert_eq!(record.brief_lines[0].passes, None);
}

#[test]
fn the_lines_run_even_when_the_delivery_gate_holds_the_projects_checks() {
    let f = built();
    let fake = Fake::default();
    let record = brief_round_in(
        &f.copy,
        TestingMode::Light,
        None,
        &briefed(two_lines(), &[]),
        &fake,
        true,
    );
    // The project's own checks went to no-mistakes; the brief's lines are the brief's, and ran.
    assert_eq!(
        fake.events.borrow().as_slice(),
        &["brief: npm run build", "brief: curl localhost:3000/score"]
    );
    let checks = gate(&record, GateKind::Checks);
    assert_eq!(checks.outcome, Outcome::Passed, "{}", checks.detail);
    assert_eq!(checks.evidence.len(), 2);
    // A line that fails is still a failure there.
    let fake = Fake {
        brief_runs: RefCell::new(vec![ends(1, "no")]),
        ..Default::default()
    };
    let record = brief_round_in(
        &f.copy,
        TestingMode::Light,
        None,
        &briefed(two_lines(), &[]),
        &fake,
        true,
    );
    assert_eq!(gate(&record, GateKind::Checks).outcome, Outcome::Failed);
}

#[test]
fn lines_that_cannot_be_read_are_not_read_as_no_lines() {
    let f = built();
    let fake = Fake::default();
    let mut damaged = briefed(Vec::new(), &[]);
    damaged.checks_unreadable = Some("the brief's own checks couldn't be read".into());
    let record = brief_round(&f.copy, TestingMode::Light, &damaged, &fake);
    let checks = gate(&record, GateKind::Checks);
    assert_eq!(checks.outcome, Outcome::NotRun);
    assert!(
        checks.detail.contains("couldn't be read"),
        "{}",
        checks.detail
    );
    assert_eq!(record.verdict, Verdict::Unsure);
}

#[test]
fn a_brief_with_no_lines_runs_the_round_exactly_as_it_was() {
    let f = built();
    let fake = Fake::default();
    let with_none = brief_round(
        &f.copy,
        TestingMode::Light,
        &briefed(Vec::new(), &[]),
        &fake,
    );
    assert_eq!(fake.events.borrow().as_slice(), &["project checks"]);
    assert_eq!(gate(&with_none, GateKind::Checks).evidence.len(), 1);
    assert_eq!(with_none.verdict, Verdict::Passed);
}

#[test]
fn each_lines_result_lands_on_the_delegation_row_with_passes_set_by_the_gates() {
    let f = built();
    let mut conn = store();
    let row = record_row(&mut conn);
    brief_checks::keep(
        &conn,
        &row.id,
        &brief_checks::KeepInput {
            stamp: Some("0123456789abcdef0123456789abcdef01234567".into()),
            checks: serde_json::json!([
                { "what": "it builds", "command": "npm run build" },
                { "what": "the route answers", "command": "curl localhost:3000/score", "expect": "ok" }
            ]),
            leave: serde_json::Value::Null,
        },
    )
    .unwrap();
    // The round reads the lines from the row, runs them, and its results are written back.
    let state = brief_checks::state_of(&conn, &row.id).unwrap();
    assert!(
        state.checks.iter().all(|l| l.passes.is_none()),
        "nothing has passed yet"
    );
    let fake = Fake {
        brief_runs: RefCell::new(vec![ends(0, "built"), ends(0, "{\"status\": \"down\"}")]),
        ..Default::default()
    };
    let record = brief_round(
        &f.copy,
        TestingMode::Light,
        &BriefRound::from(&state),
        &fake,
    );
    brief_checks::record_results(&conn, &row.id, &record.brief_lines).unwrap();
    let after = brief_checks::state_of(&conn, &row.id).unwrap();
    assert_eq!(after.checks[0].passes, Some(true));
    assert_eq!(after.checks[1].passes, Some(false));
    assert_eq!(after.checks[0].ran_at, Some(42));
    assert!(after.checks[1]
        .output_tail
        .as_deref()
        .unwrap()
        .contains("\"status\": \"down\""));
    assert_eq!(
        after.stamp.as_deref(),
        Some("0123456789abcdef0123456789abcdef01234567")
    );
    // The row still reads as it did: its own save didn't drop them.
    crate::delegations::set_gate_verdict(&mut conn, &row.id, "failed", "no", None, 5).unwrap();
    assert_eq!(
        brief_checks::state_of(&conn, &row.id).unwrap().checks[1].passes,
        Some(false)
    );
}

#[test]
fn a_changed_path_on_the_do_not_touch_list_fails_the_round_in_every_mode_but_off() {
    let f = built();
    for (mode, fails) in [
        (TestingMode::AtShip, true),
        (TestingMode::Light, true),
        (TestingMode::Full, true),
        (TestingMode::Off, false),
    ] {
        let fake = Fake::default();
        let record = brief_round(&f.copy, mode, &briefed(Vec::new(), &["app.ts"]), &fake);
        let found: Vec<&done_check::CodeFinding> = record
            .findings
            .iter()
            .filter(|finding| finding.kind == done_check::FindingKind::DoNotTouch)
            .collect();
        if fails {
            assert_eq!(
                record.verdict,
                Verdict::Failed,
                "{mode:?}: {}",
                record.summary
            );
            assert_eq!(found.len(), 1, "{mode:?}");
            assert_eq!(
                found[0].detail,
                "app.ts is on the brief's do-not-touch list."
            );
            assert!(
                record.summary.contains("do-not-touch"),
                "{mode:?}: {}",
                record.summary
            );
            assert!(
                !record.summary.contains("the report's claims don't match"),
                "{}",
                record.summary
            );
        } else {
            assert!(found.is_empty(), "{mode:?}");
            assert_eq!(
                record.verdict,
                Verdict::Passed,
                "{mode:?}: {}",
                record.summary
            );
        }
    }
}

#[test]
fn a_do_not_touch_folder_catches_any_file_under_it_and_a_sibling_is_left_alone() {
    let f = fixture("leave-folder");
    std::fs::create_dir_all(f.copy.join("src/legacy")).unwrap();
    std::fs::create_dir_all(f.copy.join("src/new")).unwrap();
    std::fs::write(f.copy.join("src/legacy/old.ts"), "export const o = 1;\n").unwrap();
    std::fs::write(f.copy.join("src/new/fresh.ts"), "export const n = 1;\n").unwrap();
    sh(&f.copy, &["add", "-A"]);
    sh(&f.copy, &["commit", "-q", "-m", "work"]);
    let fake = Fake::default();
    let record = brief_round(
        &f.copy,
        TestingMode::AtShip,
        &briefed(Vec::new(), &["src/legacy"]),
        &fake,
    );
    let paths: Vec<&str> = record
        .findings
        .iter()
        .filter_map(|finding| finding.file.as_deref())
        .collect();
    assert!(paths.contains(&"src/legacy/old.ts"), "{paths:?}");
    assert!(!paths.contains(&"src/new/fresh.ts"), "{paths:?}");
    assert_eq!(record.verdict, Verdict::Failed);
}

#[test]
fn a_do_not_touch_list_that_cannot_be_read_leaves_the_round_unsure() {
    let f = built();
    let fake = Fake::default();
    let mut damaged = briefed(Vec::new(), &[]);
    damaged.leave_unreadable = Some("the brief's do-not-touch list couldn't be read".into());
    let record = brief_round(&f.copy, TestingMode::Light, &damaged, &fake);
    assert_eq!(record.verdict, Verdict::Unsure, "{}", record.summary);
    assert!(
        record
            .summary
            .contains("do-not-touch list couldn't be read"),
        "{}",
        record.summary
    );
    // `off` runs no findings, so it does not look.
    let record = brief_round(&f.copy, TestingMode::Off, &damaged, &Fake::default());
    assert_eq!(record.verdict, Verdict::Passed);
}

// ---- SC-7: a bug fix needs a red run first ----------------------------------------------------------------------------

mod sc7_fix {
    use super::*;
    use crate::firstmate::fact_gaps::{FactEdit, FactRun, FixEvidence, NO_RED_BEFORE_FIX};

    const RED: &str = include_str!("../test_summary/fixtures/vitest_fail.txt");

    /// A fix whose test file is `app.test.ts`: red first when `red_first`, else the red comes after the source edit.
    fn evidence(red_first: bool) -> FixEvidence {
        let (red_at, code_at) = if red_first { (3.0, 5.0) } else { (6.0, 2.0) };
        FixEvidence {
            test_files: vec!["app.test.ts".into()],
            runs: vec![FactRun {
                command: "npx vitest run app.test.ts".into(),
                at: red_at,
                output: RED.replace("src/math.test.ts", "app.test.ts"),
            }],
            edits: vec![
                FactEdit {
                    path: "app.test.ts".into(),
                    at: 1.0,
                },
                FactEdit {
                    path: "app.ts".into(),
                    at: code_at,
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn in_light_a_fix_with_no_red_first_fails_the_round_and_the_model_is_not_asked() {
        let f = built();
        let fake = Fake::default();
        let chosen = moded(&f.copy, TestingMode::Light, None);
        let proof = evidence(false);
        let record = moded_round_fixing(&f.copy, &chosen, &fake, None, Some(&proof));
        assert_eq!(record.verdict, Verdict::Failed, "{}", record.summary);
        // One gap reads as the send-back line, which lowers the first letter of the sentence.
        assert_eq!(
            record.summary.lines().next(),
            Some("Sent back: no failing run of a new or changed test was seen before the fix.")
        );
        assert!(
            fake.prompts.borrow().is_empty(),
            "a fact gap does not ask the model"
        );
    }

    #[test]
    fn in_full_the_same_fix_fails_the_same_way() {
        let f = built();
        let chosen = moded(&f.copy, TestingMode::Full, None);
        let proof = evidence(false);
        let record = moded_round_fixing(&f.copy, &chosen, &Fake::default(), None, Some(&proof));
        assert_eq!(record.verdict, Verdict::Failed);
        assert_eq!(
            record.summary.lines().next(),
            Some("Sent back: no failing run of a new or changed test was seen before the fix.")
        );
    }

    #[test]
    fn a_red_run_before_the_fix_passes_the_round() {
        let f = built();
        let chosen = moded(&f.copy, TestingMode::Light, None);
        let proof = evidence(true);
        let record = moded_round_fixing(&f.copy, &chosen, &Fake::default(), None, Some(&proof));
        assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
        assert!(!record.summary.contains(NO_RED_BEFORE_FIX));
    }

    #[test]
    fn at_ship_and_off_assume_the_worker_tested_so_the_gap_is_dropped() {
        let f = built();
        for mode in [TestingMode::AtShip, TestingMode::Off] {
            let chosen = moded(&f.copy, mode, None);
            let proof = evidence(false);
            let record = moded_round_fixing(&f.copy, &chosen, &Fake::default(), None, Some(&proof));
            assert_eq!(
                record.verdict,
                Verdict::Passed,
                "{mode:?}: {}",
                record.summary
            );
            assert!(!record.summary.contains(NO_RED_BEFORE_FIX), "{mode:?}");
        }
    }

    #[test]
    fn a_brief_that_is_not_a_fix_carries_no_evidence_and_is_never_held_to_it() {
        let f = built();
        let chosen = moded(&f.copy, TestingMode::Light, None);
        let record = moded_round_fixing(&f.copy, &chosen, &Fake::default(), None, None);
        assert_eq!(record.verdict, Verdict::Passed, "{}", record.summary);
    }

    fn memory() -> rusqlite::Connection {
        rusqlite::Connection::open_in_memory().unwrap()
    }

    #[test]
    fn a_fix_kind_is_kept_beside_the_plan_and_a_later_save_without_one_clears_it() {
        let conn = memory();
        let stored = plan(&[GateKind::Diff, GateKind::Checks]);
        save_plan_with_kind(&conn, "d-1", &stored, Some("fix"), 1).unwrap();
        assert_eq!(plan_of(&conn, "d-1").unwrap(), Some(stored.clone()));
        assert_eq!(kind_of(&conn, "d-1").as_deref(), Some("fix"));
        assert_eq!(kind_of(&conn, "d-2"), None, "another task has none");
        save_plan_with_kind(&conn, "d-1", &stored, None, 2).unwrap();
        assert_eq!(kind_of(&conn, "d-1"), None);
        assert_eq!(plan_of(&conn, "d-1").unwrap(), Some(stored));
        // A plan saved the old way has no kind, and no table at all is no kind.
        save_plan(&conn, "d-3", &plan(&[GateKind::Diff]), 3).unwrap();
        assert_eq!(kind_of(&conn, "d-3"), None);
        assert_eq!(kind_of(&memory(), "d-1"), None);
    }

    #[test]
    fn a_fix_alone_is_a_plan_with_no_gates_and_the_kind_survives_a_bad_row() {
        let conn = memory();
        save_plan_with_kind(&conn, "d-1", &GatePlan::default(), Some("fix"), 1).unwrap();
        assert_eq!(kind_of(&conn, "d-1").as_deref(), Some("fix"));
        // A row another build wrote with a kind this one doesn't know reads as no kind, never an error.
        ensure_table(&conn).unwrap();
        conn.execute(
            "INSERT INTO firstmate_gates (delegation_id, plan, records, updated_at) VALUES ('d-2', '{\"gates\":[],\"kind\":\"feature\"}', '[]', 1)",
            [],
        )
        .unwrap();
        assert_eq!(kind_of(&conn, "d-2"), None);
        conn.execute(
            "INSERT INTO firstmate_gates (delegation_id, plan, records, updated_at) VALUES ('d-3', 'not json', '[]', 1)",
            [],
        )
        .unwrap();
        assert_eq!(kind_of(&conn, "d-3"), None);
    }

    #[test]
    fn the_kind_a_brief_may_name_is_fix_and_nothing_else() {
        assert_eq!(check_kind(None), Ok(None));
        assert_eq!(check_kind(Some("fix")), Ok(Some("fix")));
        assert_eq!(check_kind(Some("  Fix ")), Ok(Some("fix")));
        assert_eq!(check_kind(Some("")), Ok(None));
        let refused = check_kind(Some("feature")).unwrap_err();
        assert!(refused.contains("fix"), "{refused}");
    }

    #[test]
    fn the_gap_sits_beside_the_other_fact_gaps_and_does_not_hide_them() {
        let f = built();
        let chosen = moded(&f.copy, TestingMode::Light, None);
        let stale = stale_facts();
        let proof = evidence(false);
        let record = moded_round_fixing(
            &f.copy,
            &chosen,
            &Fake::default(),
            Some(&stale),
            Some(&proof),
        );
        assert_eq!(record.verdict, Verdict::Failed);
        assert!(record.summary.contains("went stale"), "{}", record.summary);
        assert!(
            record.summary.contains(NO_RED_BEFORE_FIX),
            "{}",
            record.summary
        );
    }
}
