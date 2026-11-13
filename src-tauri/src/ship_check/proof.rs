//! PT-1: the ship check's "Proof tools" step. In `at-ship` and `full` (never `light`, never `off`) the installed, fitting proof
//! tools run over the check's range (base..head), through the same sandboxed runner as the checks (`proof_tools::run`).
//!
//! One step, "Proof tools". Honest by construction, like every step here: nothing installed is "not run: none available" and
//! is listed under "Not tested" with which tools would fit, never a pass; a tool that could not run (a timeout, zero tests, a
//! service that didn't answer) is "could not run"; a failing property, end-to-end or API run, an error finding or a surviving
//! mutant fails it with the findings listed.

use crate::delivery::settings::TestingMode;
use crate::proof_tools::{detect::Detection, run as proof_run, Outcome as Ran, TestRun, ToolRun};

use super::{Outcome, Stage, Step, TAIL_MAX};

/// The step's name, in the record the person reads.
pub(super) const NAME: &str = "Proof tools";

/// Whether this testing mode has the step at all: `at-ship` and `full`. Never `light` (each task is checked as it lands) and
/// never `off`.
pub(super) fn wanted(mode: TestingMode) -> bool {
    matches!(mode, TestingMode::AtShip | TestingMode::Full)
}

fn names(tools: &[&crate::proof_tools::Tool]) -> String {
    tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// No proof tool is installed: the step did not run, and the lines under "Not tested" say which would fit. Never a pass.
pub(super) fn none_available(detection: &Detection) -> Stage {
    let missing = detection.missing();
    let line = if missing.is_empty() {
        "No proof tool is set up in this project, and none fits what was found in it.".to_string()
    } else {
        format!(
            "No proof tool is set up in this project. These would fit it: {}. A first mate can propose one.",
            names(&missing)
        )
    };
    Stage {
        steps: vec![Step::new(NAME, Outcome::NotRun, "none available")],
        not_tested: vec![line],
    }
}

/// The checkout isn't what HEAD is, so a tool reading the files on disk would test something else.
pub(super) fn not_clean(files: Option<usize>, head: &str) -> Stage {
    let what = match files {
        Some(1) => "the checkout has 1 uncommitted change".to_string(),
        Some(count) => format!("the checkout has {count} uncommitted changes"),
        None => "the checkout's changes couldn't be read".to_string(),
    };
    Stage::one(Step::new(
        NAME,
        Outcome::CouldNotRun,
        format!("{what}, so a tool would test something that is not {head}"),
    ))
}

/// The project's own test runs in this check, which is where a property library's properties run: the project's check steps.
pub(super) fn tests_from(earlier: &[Step]) -> Vec<TestRun> {
    earlier
        .iter()
        .filter(|step| step.name.starts_with("Check: "))
        .map(|step| TestRun {
            outcome: match step.outcome {
                Outcome::Passed => Ran::Passed,
                Outcome::Failed => Ran::Failed,
                Outcome::CouldNotRun => Ran::CouldNotRun,
                Outcome::NotRun => Ran::NotRun,
            },
            output: step.output_tail.clone().unwrap_or_default(),
        })
        .collect()
}

/// The step from what the tools found.
pub(super) fn stage_of(runs: &[ToolRun]) -> Stage {
    let outcome = match proof_run::combine(runs) {
        Ran::Passed => Outcome::Passed,
        Ran::Failed => Outcome::Failed,
        Ran::CouldNotRun => Outcome::CouldNotRun,
        Ran::NotRun => Outcome::NotRun,
    };
    let mut step = Step::new(NAME, outcome, proof_run::summary(runs));
    if matches!(outcome, Outcome::Failed | Outcome::CouldNotRun) {
        let found: Vec<String> = runs
            .iter()
            .filter(|run| matches!(run.outcome, Ran::Failed | Ran::CouldNotRun))
            .flat_map(|run| {
                std::iter::once(format!("{}: {}", run.tool.name, run.detail))
                    .chain(run.lines.iter().map(|line| format!("  {line}")))
            })
            .collect();
        step.output_tail =
            Some(crate::gates::tail(&found.join("\n"), TAIL_MAX)).filter(|t| !t.is_empty());
    }
    let not_tested = runs
        .iter()
        .filter(|run| matches!(run.outcome, Ran::CouldNotRun | Ran::NotRun))
        .map(|run| {
            let word = if run.outcome == Ran::CouldNotRun {
                "could not run"
            } else {
                "had nothing to read in these commits"
            };
            format!("Proof tool {} {word}: {}", run.tool.name, run.detail)
        })
        .collect();
    Stage {
        steps: vec![step],
        not_tested,
    }
}

/// The whole step, as the ship check decides it. `clean` is `Ok` when the checkout is what HEAD is, else how many files differ
/// (none when they couldn't be counted). `detect` and `run` are asked only when the mode has the step and the checkout is
/// clean, so a mode without it never probes a program or starts a tool.
pub(super) fn step(
    mode: TestingMode,
    clean: Result<(), Option<usize>>,
    head: &str,
    detect: impl FnOnce() -> Detection,
    run: impl FnOnce(&Detection) -> Vec<ToolRun>,
) -> Stage {
    if !wanted(mode) {
        return Stage::default();
    }
    if let Err(files) = clean {
        return not_clean(files, head);
    }
    let detection = detect();
    if !detection.has_installed() {
        return none_available(&detection);
    }
    stage_of(&run(&detection))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proof_tools::{catalogue, detect::Found, Stack};

    fn run_of(id: &str, outcome: Ran, detail: &str, lines: &[&str]) -> ToolRun {
        ToolRun {
            tool: catalogue::find(id).unwrap(),
            outcome,
            detail: detail.into(),
            lines: lines.iter().map(|line| line.to_string()).collect(),
            command: None,
            tail: None,
            seconds: 0.0,
        }
    }

    fn found(id: &str, installed: bool) -> Found {
        Found {
            tool: catalogue::find(id).unwrap(),
            installed,
        }
    }

    #[test]
    fn only_at_ship_and_full_have_the_step() {
        assert!(wanted(TestingMode::AtShip));
        assert!(wanted(TestingMode::Full));
        assert!(!wanted(TestingMode::Light));
        assert!(!wanted(TestingMode::Off));
    }

    #[test]
    fn none_available_is_not_run_and_names_what_would_fit_under_not_tested() {
        let detection = Detection {
            stacks: vec![Stack::Node, Stack::Web],
            fitting: vec![found("fast-check", false), found("stryker", false)],
        };
        let stage = none_available(&detection);
        assert_eq!(stage.steps.len(), 1);
        assert_eq!(stage.steps[0].name, "Proof tools");
        assert_eq!(stage.steps[0].outcome, Outcome::NotRun);
        assert_eq!(stage.steps[0].detail, "none available");
        assert_eq!(stage.not_tested.len(), 1);
        assert!(
            stage.not_tested[0].contains("fast-check, StrykerJS"),
            "{}",
            stage.not_tested[0]
        );
        // A step that did not run never makes a record a pass by itself.
        assert_eq!(super::super::aggregate(&stage.steps), Outcome::CouldNotRun);
        let nothing = none_available(&Detection {
            stacks: Vec::new(),
            fitting: Vec::new(),
        });
        assert!(
            nothing.not_tested[0].contains("none fits"),
            "{}",
            nothing.not_tested[0]
        );
    }

    #[test]
    fn a_failing_run_fails_the_step_and_lists_what_it_found() {
        let runs = [
            run_of(
                "fast-check",
                Ran::Passed,
                "its properties run with the project's tests: 25 passed",
                &[],
            ),
            run_of(
                "stryker",
                Ran::Failed,
                "2 mutants survived",
                &[
                    "src/a.ts:5: ConditionalExpression survived",
                    "src/a.ts:9: no test covers it",
                ],
            ),
        ];
        let stage = stage_of(&runs);
        assert_eq!(stage.steps[0].outcome, Outcome::Failed);
        assert!(
            stage.steps[0]
                .detail
                .contains("StrykerJS: 2 mutants survived"),
            "{}",
            stage.steps[0].detail
        );
        let tail = stage.steps[0].output_tail.as_deref().unwrap();
        assert!(
            tail.contains("src/a.ts:5") && tail.contains("src/a.ts:9"),
            "{tail}"
        );
        assert!(stage.not_tested.is_empty());
    }

    #[test]
    fn a_tool_that_could_not_run_makes_the_step_could_not_run_and_is_listed_under_not_tested() {
        let runs = [
            run_of("playwright", Ran::Passed, "3 passed", &[]),
            run_of(
                "schemathesis",
                Ran::CouldNotRun,
                "the service didn't answer at the base URL",
                &[],
            ),
            run_of(
                "stryker",
                Ran::NotRun,
                "no changed line in a source file",
                &[],
            ),
        ];
        let stage = stage_of(&runs);
        assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
        assert_eq!(stage.not_tested.len(), 2);
        assert!(
            stage.not_tested[0].starts_with("Proof tool Schemathesis could not run:"),
            "{:?}",
            stage.not_tested
        );
        assert!(
            stage.not_tested[1].contains("had nothing to read"),
            "{:?}",
            stage.not_tested
        );
    }

    #[test]
    fn every_tool_passing_passes_and_nothing_to_read_is_not_run() {
        let passed = stage_of(&[run_of("playwright", Ran::Passed, "3 passed", &[])]);
        assert_eq!(passed.steps[0].outcome, Outcome::Passed);
        assert!(passed.steps[0].output_tail.is_none());
        let idle = stage_of(&[run_of("stryker", Ran::NotRun, "no changed line", &[])]);
        assert_eq!(idle.steps[0].outcome, Outcome::NotRun);
    }

    #[test]
    fn the_projects_own_check_steps_are_the_test_runs_a_property_is_read_from() {
        let steps = [
            Step::new("Check: Web", Outcome::Passed, "ran and passed"),
            Step::new("Real-app check", Outcome::Passed, "drove it"),
            {
                let mut failed = Step::new("Check: Rust", Outcome::Failed, "failed (exit 1)");
                failed.output_tail = Some("test result: FAILED. 3 passed; 1 failed".into());
                failed
            },
        ];
        let tests = tests_from(&steps);
        assert_eq!(
            tests.len(),
            2,
            "the real-app check is not the project's tests"
        );
        assert_eq!(tests[0].outcome, Ran::Passed);
        assert_eq!(tests[1].outcome, Ran::Failed);
        assert!(tests[1].output.contains("1 failed"));
    }

    #[test]
    fn a_checkout_that_is_not_what_head_is_could_not_run() {
        let stage = not_clean(Some(2), "abc1234");
        assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
        assert!(
            stage.steps[0].detail.contains("2 uncommitted changes"),
            "{}",
            stage.steps[0].detail
        );
        assert!(not_clean(Some(1), "abc").steps[0]
            .detail
            .contains("1 uncommitted change,"));
        assert!(not_clean(None, "abc").steps[0]
            .detail
            .contains("couldn't be read"));
    }
}
