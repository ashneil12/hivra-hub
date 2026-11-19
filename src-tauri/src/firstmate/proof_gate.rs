//! PT-1: the "Proof tools" gate (`GateKind::ProofTools`). In `full`, for a code diff, when the project already has at least one
//! proof tool that fits it (`testing_mode::gates_for_with`), this runs the installed, fitting ones over the change through
//! the same sandboxed runner the checks use (`Runners::proof_tools`) and reads what they found.
//!
//! - A failing property, end-to-end or API run, an error finding from a pattern scanner, or a surviving mutant fails it. The
//!   survivors are listed (the first mate may accept the task with a reason, as for any gate).
//! - A tool that could not run (it didn't start, timed out, ran zero tests, the service didn't answer) makes the gate "could
//!   not run". Never a pass.
//! - Tools that had nothing to read in this change (no changed line in a file they read) add no result at all: neither a pass nor
//!   a problem. No installed tool means the gate was never added.
//!
//! A property library (fast-check, proptest, Hypothesis) has no runner of its own; its properties are part of the project's own
//! tests, so they are read from this round's `checks` gate rather than run a second time.

use super::brief_checks::BriefRound;
use super::gates::{
    CommandEvidence, GateKind, GateResult, Outcome, RoundInput, Runners, OUTPUT_MAX,
};
use crate::proof_tools::{self, run as proof_run, TestRun, ToolRun};

/// The most findings named in the gate's own line (the evidence has them all, capped).
const NAMED_MAX: usize = 5;

fn test_outcome(outcome: Outcome) -> proof_tools::Outcome {
    match outcome {
        Outcome::Passed => proof_tools::Outcome::Passed,
        Outcome::Failed => proof_tools::Outcome::Failed,
        Outcome::NotRun | Outcome::Held => proof_tools::Outcome::NotRun,
    }
}

/// This round's runs of the project's own tests: what the `checks` gate ran, less the brief's own check lines (those are a
/// worker's commands, not the project's tests). No checks gate in the round is no test run.
pub(super) fn test_runs(brief: Option<&BriefRound>, done: &[GateResult]) -> Vec<TestRun> {
    let Some(checks) = done.iter().find(|gate| gate.gate == GateKind::Checks) else {
        return Vec::new();
    };
    checks
        .evidence
        .iter()
        .filter(|run| {
            !brief.is_some_and(|brief| brief.lines.iter().any(|line| line.command == run.command))
        })
        .map(|run| TestRun {
            outcome: test_outcome(run.outcome),
            output: run.output.clone(),
        })
        .collect()
}

fn evidence_outcome(outcome: proof_tools::Outcome) -> Outcome {
    match outcome {
        proof_tools::Outcome::Passed => Outcome::Passed,
        proof_tools::Outcome::Failed => Outcome::Failed,
        proof_tools::Outcome::CouldNotRun | proof_tools::Outcome::NotRun => Outcome::NotRun,
    }
}

/// One tool's run as the gate's evidence: its command (or "the project's own tests"), what it found and the end of what it
/// printed when it failed or could not run.
pub(crate) fn evidence(run: &ToolRun) -> CommandEvidence {
    let mut output = run.detail.clone();
    for line in &run.lines {
        output.push('\n');
        output.push_str(line);
    }
    // The end of what it printed stays with a run that failed or could not run, so a refused write in the checker's read-only
    // copy is still read as one (`checker::trusted_in`).
    if let Some(tail) = run.tail.as_deref() {
        output.push('\n');
        output.push_str(tail);
    }
    CommandEvidence {
        command: format!(
            "{}: {}",
            run.tool.name,
            run.command.as_deref().unwrap_or("the project's own tests")
        ),
        outcome: evidence_outcome(run.outcome),
        exit_code: None,
        output: crate::gates::tail(&output, OUTPUT_MAX),
        seconds: run.seconds,
    }
}

fn named(runs: &[&ToolRun]) -> String {
    runs.iter()
        .map(|run| {
            let mut text = format!("{}: {}", run.tool.name, run.detail.trim_end_matches('.'));
            let found: Vec<&str> = run
                .lines
                .iter()
                .take(NAMED_MAX)
                .map(String::as_str)
                .collect();
            if !found.is_empty() {
                text.push_str(&format!(" ({})", found.join("; ")));
            }
            text
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// The gate's result from the tools' runs, or none when no tool had anything to read in this change.
pub(super) fn result_of(runs: &[ToolRun]) -> Option<GateResult> {
    let outcome = proof_run::combine(runs);
    let of = |wanted: proof_tools::Outcome| -> Vec<&ToolRun> {
        runs.iter().filter(|run| run.outcome == wanted).collect()
    };
    let (gate_outcome, detail) = match outcome {
        proof_tools::Outcome::NotRun => return None,
        proof_tools::Outcome::Failed => (
            Outcome::Failed,
            format!(
                "A proof tool found a problem. {}.",
                named(&of(proof_tools::Outcome::Failed))
            ),
        ),
        proof_tools::Outcome::CouldNotRun => (
            Outcome::NotRun,
            format!(
                "It couldn't run: {}.",
                named(&of(proof_tools::Outcome::CouldNotRun))
            ),
        ),
        proof_tools::Outcome::Passed => (
            Outcome::Passed,
            format!(
                "{} proof tool(s) ran and passed. {}.",
                of(proof_tools::Outcome::Passed).len(),
                named(&of(proof_tools::Outcome::Passed))
            ),
        ),
    };
    Some(GateResult {
        gate: GateKind::ProofTools,
        outcome: gate_outcome,
        detail,
        evidence: runs
            .iter()
            .filter(|run| run.outcome != proof_tools::Outcome::NotRun)
            .map(evidence)
            .collect(),
    })
}

/// Runs the gate. `done` are the gates already run in this round (the checks gate is among them).
pub(super) fn run(
    input: &RoundInput,
    runners: &dyn Runners,
    done: &[GateResult],
) -> Option<GateResult> {
    let tests = test_runs(input.brief_round, done);
    match runners.proof_tools(input.checkout, &tests) {
        Err(why) => Some(GateResult {
            gate: GateKind::ProofTools,
            outcome: Outcome::NotRun,
            detail: format!("It couldn't run: {why}."),
            evidence: Vec::new(),
        }),
        // None installed when it ran (the gate was added from an earlier read): nothing ran, and nothing reads as a pass.
        Ok(runs) if runs.is_empty() => None,
        Ok(runs) => result_of(&runs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proof_tools::catalogue;

    fn tool_run(id: &str, outcome: proof_tools::Outcome, detail: &str, lines: &[&str]) -> ToolRun {
        ToolRun {
            tool: catalogue::find(id).expect("in the catalogue"),
            outcome,
            detail: detail.to_string(),
            lines: lines.iter().map(|line| line.to_string()).collect(),
            command: Some("npx --no-install stryker run".into()),
            tail: None,
            seconds: 1.0,
        }
    }

    fn checks_gate(outcome: Outcome, commands: &[(&str, Outcome, &str)]) -> GateResult {
        GateResult {
            gate: GateKind::Checks,
            outcome,
            detail: "ran".into(),
            evidence: commands
                .iter()
                .map(|(command, outcome, output)| CommandEvidence {
                    command: command.to_string(),
                    outcome: *outcome,
                    exit_code: None,
                    output: output.to_string(),
                    seconds: 0.0,
                })
                .collect(),
        }
    }

    #[test]
    fn surviving_mutants_fail_the_gate_and_are_listed() {
        let runs = [tool_run(
            "stryker",
            proof_tools::Outcome::Failed,
            "2 mutants survived",
            &[
                "src/a.ts:5: ConditionalExpression survived (-if (a > b) / +if (true))",
                "src/a.ts:9: no test covers it",
            ],
        )];
        let result = result_of(&runs).expect("a result");
        assert_eq!(result.gate, GateKind::ProofTools);
        assert_eq!(result.outcome, Outcome::Failed);
        assert!(
            result.detail.contains("StrykerJS: 2 mutants survived"),
            "{}",
            result.detail
        );
        assert!(result.detail.contains("src/a.ts:5"), "{}", result.detail);
        assert_eq!(result.evidence.len(), 1);
        assert_eq!(result.evidence[0].outcome, Outcome::Failed);
        assert!(
            result.evidence[0].output.contains("src/a.ts:9"),
            "{}",
            result.evidence[0].output
        );
        assert_eq!(GateKind::ProofTools.name(), "Proof tools");
    }

    #[test]
    fn a_tool_that_could_not_run_is_could_not_run_never_a_pass() {
        let runs = [
            tool_run(
                "fast-check",
                proof_tools::Outcome::Passed,
                "its properties run with the project's tests: 25 passed",
                &[],
            ),
            tool_run(
                "stryker",
                proof_tools::Outcome::CouldNotRun,
                "it ran past its time limit",
                &[],
            ),
        ];
        let result = result_of(&runs).expect("a result");
        assert_eq!(result.outcome, Outcome::NotRun);
        assert!(
            result.detail.starts_with("It couldn't run:"),
            "{}",
            result.detail
        );
        assert!(result.detail.contains("time limit"), "{}", result.detail);
    }

    #[test]
    fn every_tool_passing_passes_and_nothing_to_read_adds_no_result() {
        let passed = [tool_run(
            "playwright",
            proof_tools::Outcome::Passed,
            "3 passed",
            &[],
        )];
        assert_eq!(result_of(&passed).unwrap().outcome, Outcome::Passed);
        let nothing = [tool_run(
            "stryker",
            proof_tools::Outcome::NotRun,
            "no changed line it reads",
            &[],
        )];
        assert_eq!(
            result_of(&nothing),
            None,
            "nothing to read is neither a pass nor a problem"
        );
        assert_eq!(result_of(&[]), None);
    }

    #[test]
    fn the_project_tests_a_property_is_read_from_leave_out_the_briefs_own_check_lines() {
        let brief = BriefRound {
            lines: vec![super::super::brief_checks::BriefCheck {
                what: "lint".into(),
                command: "npm run lint".into(),
                expect: None,
                passes: None,
                ran_at: None,
                output_tail: None,
            }],
            leave: Vec::new(),
            checks_unreadable: None,
            leave_unreadable: None,
            ..BriefRound::default()
        };
        let done = [checks_gate(
            Outcome::Failed,
            &[
                ("npm test", Outcome::Passed, "Tests  4 passed (4)"),
                ("npm run lint", Outcome::Failed, "lint error"),
            ],
        )];
        let tests = test_runs(Some(&brief), &done);
        assert_eq!(
            tests.len(),
            1,
            "the brief's own line is not the project's tests"
        );
        assert_eq!(tests[0].outcome, proof_tools::Outcome::Passed);
        assert!(
            test_runs(Some(&brief), &[]).is_empty(),
            "no checks gate is no test run"
        );
        let held = [checks_gate(
            Outcome::Held,
            &[("npm test", Outcome::Held, "")],
        )];
        assert_eq!(
            test_runs(None, &held)[0].outcome,
            proof_tools::Outcome::NotRun
        );
    }

    struct Fake {
        result: Result<Vec<ToolRun>, String>,
        seen: std::sync::Mutex<Vec<usize>>,
    }

    impl Runners for Fake {
        fn checks(
            &self,
            _: &std::path::Path,
            _: &[String],
            _: &[String],
        ) -> Result<Vec<CommandEvidence>, String> {
            Err("not used".into())
        }
        fn routes(&self, _: &std::path::Path) -> Option<CommandEvidence> {
            None
        }
        fn verdict(&self, _: &str) -> Result<String, String> {
            Err("not used".into())
        }
        fn proof_tools(
            &self,
            _: &std::path::Path,
            tests: &[TestRun],
        ) -> Result<Vec<ToolRun>, String> {
            self.seen.lock().unwrap().push(tests.len());
            self.result.clone()
        }
    }

    fn input<'a>(
        dir: &'a std::path::Path,
        plan: &'a super::super::gates::GatePlan,
    ) -> RoundInput<'a> {
        RoundInput {
            delegation_id: "t-1",
            round: 1,
            checkout: dir,
            plan,
            brief: "",
            done_when: "",
            report: "",
            now: 0,
            gate_owns_checks: false,
            facts: None,
            mode: None,
            brief_round: None,
            fix: None,
            history: None,
            test_debt: None,
        }
    }

    #[test]
    fn the_gate_hands_the_projects_test_runs_to_the_runner_and_a_runner_that_cant_is_could_not_run()
    {
        let dir = std::env::temp_dir();
        let plan = super::super::gates::GatePlan::default();
        let done = [checks_gate(
            Outcome::Passed,
            &[("npm test", Outcome::Passed, "Tests  4 passed (4)")],
        )];
        let fake = Fake {
            result: Ok(vec![tool_run(
                "fast-check",
                proof_tools::Outcome::Passed,
                "ok",
                &[],
            )]),
            seen: Default::default(),
        };
        let result = run(&input(&dir, &plan), &fake, &done).unwrap();
        assert_eq!(result.outcome, Outcome::Passed);
        assert_eq!(*fake.seen.lock().unwrap(), vec![1]);
        let cant = Fake {
            result: Err("this build can't run proof tools".into()),
            seen: Default::default(),
        };
        let result = run(&input(&dir, &plan), &cant, &done).unwrap();
        assert_eq!(result.outcome, Outcome::NotRun);
        assert!(
            result.detail.contains("can't run proof tools"),
            "{}",
            result.detail
        );
        let none = Fake {
            result: Ok(Vec::new()),
            seen: Default::default(),
        };
        assert_eq!(
            run(&input(&dir, &plan), &none, &done),
            None,
            "no tool installed is never a pass"
        );
    }
}
