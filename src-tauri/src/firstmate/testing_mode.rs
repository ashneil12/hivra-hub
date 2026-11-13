//! SC-3a: which gates a finished task gets, chosen from the project's testing mode and the diff (docs/specs/
//! shipping-confidence-gap-spec.md section 4c, "gates from the diff, not from a flag").
//!
//! Until now a brief with no stored plan ran no gates, so a worker that changed code and said "done" was only as checked
//! as its first mate remembered to ask. Now the gates come from what the copy changed and the project's mode
//! (`delivery::settings::TestingMode`):
//!
//! | Mode | Gates | Findings | Fact gaps | Verdict model | A pass reads |
//! | --- | --- | --- | --- | --- | --- |
//! | `off` | `diff`, `committed` | no | none | no | done, "Not tested" |
//! | `at-ship` (default) | `diff`, `committed` | yes | a failed check, an open to-do | no | done, "Built, not tested yet" |
//! | `light`, code changed | `diff`, `checks`, `committed`, `ratchet`, and the brief's plan | yes | all | yes | done |
//! | `light`, docs only | `diff`, `committed`, and the brief's plan | yes | all | yes | done |
//! | `full` | as `light`, plus the brief's own check lines (SC-4; SC-5 and SC-7 add the rest) | yes | all | yes | done |
//!
//! A task whose copy changed nothing and that stored no plan (a research or answer task) is unaffected in every mode:
//! `as_today`, and it settles as it did before. The person's mode wins over the brief's own plan in `at-ship` and
//! `off`; in `light` and `full` the brief's plan is added to the floor. The routes check is the project's and runs in
//! every mode whatever this says (`gates::run_round`).

use super::fact_gaps;
use super::gates::{GateKind, GatePlan};
use crate::delivery::settings::TestingMode;

/// The note on a task that passed `at-ship`: built, and not tested yet.
pub const NOTE_AT_SHIP: &str = "Built, not tested yet";
/// The note on a task that passed in `off`.
pub const NOTE_OFF: &str = "Not tested";

/// Which of the turn's fact gaps count against the task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactGapFilter {
    /// Every gap (a failed check, a stale check, a pass claim with no run, an open to-do, an untested package).
    All,
    /// Only a check that failed and was not run green again, and an open to-do. The others assume the worker tested.
    FailedCheckAndOpenTodo,
    /// None.
    Nothing,
}

impl FactGapFilter {
    /// The gaps this filter lets through, in their order.
    pub fn keep(self, gaps: Vec<String>) -> Vec<String> {
        match self {
            FactGapFilter::All => gaps,
            // SC-7: "no failing run before the fix" assumes the worker tested, so it is dropped here by name, not only by
            // not being on the list.
            FactGapFilter::FailedCheckAndOpenTodo => gaps
                .into_iter()
                .filter(|gap| {
                    !fact_gaps::is_no_red_gap(gap)
                        && (fact_gaps::is_failed_check_gap(gap)
                            || fact_gaps::is_open_todo_gap(gap))
                })
                .collect(),
            FactGapFilter::Nothing => Vec::new(),
        }
    }
}

/// What `gates_for` chose for one finished task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModePlan {
    pub mode: TestingMode,
    /// No mode applies: the copy changed nothing and no plan was stored. The task settles as it did before.
    pub as_today: bool,
    pub gates: Vec<GateKind>,
    /// Ids of the project's own checks the `checks` gate runs (the brief's, in `light` and `full`).
    pub checks: Vec<String>,
    /// Whether the report is checked against the diff (false scope, scope creep, a weakened test, debris, an outward
    /// action).
    pub run_findings: bool,
    pub fact_gap_filter: FactGapFilter,
    /// Whether the read-only verdict model is asked.
    pub run_verdict: bool,
    /// What a pass says, on the task's row: "Built, not tested yet", "Not tested".
    pub note: Option<&'static str>,
}

impl ModePlan {
    /// The plan `gates::run_round` runs.
    pub fn gate_plan(&self) -> GatePlan {
        GatePlan {
            gates: self.gates.clone(),
            checks: self.checks.clone(),
        }
    }

    /// SC-7: whether a bug-fix brief must show a failing run of its test before the fix. Only the modes that test each
    /// task ask it: `at-ship` and `off` assume the worker tested, and test at the ship check or not at all.
    pub fn needs_red_before_fix(&self) -> bool {
        matches!(self.mode, TestingMode::Light | TestingMode::Full)
    }
}

/// Whether any changed path is code: anything git sees that is not a document (markdown, text, a `docs/` folder).
pub fn code_changed(changed: &[String]) -> bool {
    changed.iter().any(|path| !fact_gaps::is_docs_path(path))
}

/// The gates, findings, fact gaps and verdict a finished task gets. Pure: `plan` is the brief's stored plan, `changed`
/// the paths the copy changed since it started, and `code_changed` whether any is code (pass `true` when the diff
/// couldn't be read, so the gates run and say so rather than skip).
pub fn gates_for(
    mode: TestingMode,
    plan: Option<&GatePlan>,
    changed: &[String],
    code_changed: bool,
) -> ModePlan {
    // A research or answer task: nothing changed and the brief asked for no gates. It settles as it did before.
    if changed.is_empty() && !code_changed && plan.is_none() {
        return ModePlan {
            mode,
            as_today: true,
            gates: Vec::new(),
            checks: Vec::new(),
            run_findings: false,
            fact_gap_filter: FactGapFilter::All,
            run_verdict: false,
            note: None,
        };
    }
    // The brief's plan joins the floor in `light` and `full`. In `at-ship` and `off` the person's mode wins and the
    // plan is ignored: the person chose not to test each task, and a brief must not turn that back on.
    let (mut gates, checks, run_findings, fact_gap_filter, run_verdict, note) = match mode {
        TestingMode::Off => (
            vec![GateKind::Diff, GateKind::Committed],
            Vec::new(),
            false,
            FactGapFilter::Nothing,
            false,
            Some(NOTE_OFF),
        ),
        TestingMode::AtShip => (
            vec![GateKind::Diff, GateKind::Committed],
            Vec::new(),
            true,
            FactGapFilter::FailedCheckAndOpenTodo,
            false,
            Some(NOTE_AT_SHIP),
        ),
        // SC-4: the brief's own check lines run inside the `checks` gate this adds for a code diff (`gates::with_brief_lines`),
        // in `light` and in `full`. SC-5/SC-7: `full` adds the real-app recipe and the running checker here; until those
        // land it is `light` plus the lines.
        TestingMode::Light | TestingMode::Full => {
            let mut gates = vec![GateKind::Diff, GateKind::Committed];
            if code_changed {
                gates.extend([GateKind::Checks, GateKind::Ratchet]);
            }
            let named = plan.map(|plan| plan.checks.clone()).unwrap_or_default();
            gates.extend(plan.map(|plan| plan.gates.clone()).unwrap_or_default());
            (gates, named, true, FactGapFilter::All, true, None)
        }
    };
    gates.sort();
    gates.dedup();
    let mut checks = checks;
    checks.dedup();
    ModePlan {
        mode,
        as_today: false,
        gates,
        checks,
        run_findings,
        fact_gap_filter,
        run_verdict,
        note,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firstmate::fact_gaps::{FactCheck, FactEdit, FactTodo, FactTurn};
    use GateKind::{Checks, Committed, Diff, Ratchet, Routes};

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|p| p.to_string()).collect()
    }

    fn plan(gates: &[GateKind], checks: &[&str]) -> GatePlan {
        GatePlan {
            gates: gates.to_vec(),
            checks: paths(checks),
        }
    }

    fn pick(mode: TestingMode, stored: Option<&GatePlan>, changed: &[&str]) -> ModePlan {
        let changed = paths(changed);
        gates_for(mode, stored, &changed, code_changed(&changed))
    }

    // ---- a task that changed nothing and stored no plan -------------------------------------------------------------

    #[test]
    fn an_empty_diff_with_no_plan_is_left_as_it_is_in_every_mode() {
        for mode in TestingMode::ALL {
            let chosen = pick(mode, None, &[]);
            assert!(chosen.as_today, "{mode:?}");
            assert!(chosen.gates.is_empty(), "{mode:?}");
            assert_eq!(chosen.note, None, "{mode:?}");
        }
    }

    #[test]
    fn an_empty_diff_with_a_stored_plan_still_gets_gates_so_nothing_changed_is_caught() {
        let stored = plan(&[Diff, Checks], &[]);
        let at_ship = pick(TestingMode::AtShip, Some(&stored), &[]);
        assert!(!at_ship.as_today);
        assert_eq!(at_ship.gates, vec![Diff, Committed]);
        let light = pick(TestingMode::Light, Some(&stored), &[]);
        assert!(!light.as_today);
        assert_eq!(light.gates, vec![Diff, Checks, Committed]);
        let off = pick(TestingMode::Off, Some(&stored), &[]);
        assert_eq!(off.gates, vec![Diff, Committed]);
    }

    #[test]
    fn a_diff_that_could_not_be_read_runs_the_gates_so_they_can_say_so() {
        // The caller passes code_changed = true with no paths.
        let chosen = gates_for(TestingMode::AtShip, None, &[], true);
        assert!(!chosen.as_today);
        assert_eq!(chosen.gates, vec![Diff, Committed]);
    }

    // ---- code changed, by mode --------------------------------------------------------------------------------------

    #[test]
    fn off_runs_only_the_change_and_commit_gates_and_asks_nothing_else() {
        let chosen = pick(TestingMode::Off, None, &["src/app.ts"]);
        assert_eq!(chosen.mode, TestingMode::Off);
        assert!(!chosen.as_today);
        assert_eq!(chosen.gates, vec![Diff, Committed]);
        assert!(chosen.checks.is_empty());
        assert!(!chosen.run_findings);
        assert_eq!(chosen.fact_gap_filter, FactGapFilter::Nothing);
        assert!(!chosen.run_verdict);
        assert_eq!(chosen.note, Some("Not tested"));
    }

    #[test]
    fn at_ship_checks_for_slips_only_and_says_it_did_not_test() {
        let chosen = pick(TestingMode::AtShip, None, &["src/app.ts", "docs/a.md"]);
        assert_eq!(chosen.gates, vec![Diff, Committed]);
        assert!(chosen.run_findings);
        assert_eq!(
            chosen.fact_gap_filter,
            FactGapFilter::FailedCheckAndOpenTodo
        );
        assert!(!chosen.run_verdict);
        assert_eq!(chosen.note, Some("Built, not tested yet"));
    }

    #[test]
    fn at_ship_ignores_the_briefs_own_plan_because_the_persons_mode_wins() {
        let stored = plan(&[Diff, Checks, Ratchet, Routes], &["unit", "lint"]);
        let chosen = pick(TestingMode::AtShip, Some(&stored), &["src/app.ts"]);
        assert_eq!(chosen.gates, vec![Diff, Committed]);
        assert!(chosen.checks.is_empty());
        let off = pick(TestingMode::Off, Some(&stored), &["src/app.ts"]);
        assert_eq!(off.gates, vec![Diff, Committed]);
        assert!(off.checks.is_empty());
    }

    #[test]
    fn light_with_code_changed_runs_the_floor_and_the_briefs_plan_and_every_check() {
        let chosen = pick(TestingMode::Light, None, &["src/app.ts"]);
        assert_eq!(chosen.gates, vec![Diff, Checks, Committed, Ratchet]);
        assert!(chosen.checks.is_empty());
        assert!(chosen.run_findings);
        assert_eq!(chosen.fact_gap_filter, FactGapFilter::All);
        assert!(chosen.run_verdict);
        assert_eq!(chosen.note, None);
    }

    #[test]
    fn light_adds_the_briefs_plan_and_honours_its_named_checks() {
        let stored = plan(&[Diff, Checks, Routes], &["unit"]);
        let chosen = pick(TestingMode::Light, Some(&stored), &["src/app.ts"]);
        assert_eq!(chosen.gates, vec![Diff, Checks, Committed, Ratchet, Routes]);
        assert_eq!(chosen.checks, vec!["unit".to_string()]);
        // Sorted and with no repeats, however the plan lists them.
        let messy = plan(&[Ratchet, Diff, Ratchet, Checks], &["a", "a"]);
        let chosen = pick(TestingMode::Light, Some(&messy), &["src/app.ts"]);
        assert_eq!(chosen.gates, vec![Diff, Checks, Committed, Ratchet]);
    }

    #[test]
    fn light_with_docs_only_skips_the_checks_and_keeps_the_review() {
        let chosen = pick(
            TestingMode::Light,
            None,
            &["README.md", "docs/guide.md", "notes.txt"],
        );
        assert_eq!(chosen.gates, vec![Diff, Committed]);
        assert!(chosen.run_findings);
        assert_eq!(chosen.fact_gap_filter, FactGapFilter::All);
        assert!(chosen.run_verdict);
        assert_eq!(chosen.note, None);
        // The brief's plan is still honoured.
        let stored = plan(&[Checks], &["links"]);
        let chosen = pick(TestingMode::Light, Some(&stored), &["docs/guide.md"]);
        assert_eq!(chosen.gates, vec![Diff, Checks, Committed]);
        assert_eq!(chosen.checks, vec!["links".to_string()]);
    }

    #[test]
    fn full_is_light_for_now() {
        for (changed, stored) in [
            (vec!["src/app.ts"], None),
            (vec!["docs/a.md"], None),
            (vec!["src/app.ts"], Some(plan(&[Diff, Checks], &["unit"]))),
        ] {
            let light = pick(TestingMode::Light, stored.as_ref(), &changed);
            let full = pick(TestingMode::Full, stored.as_ref(), &changed);
            assert_eq!(full.mode, TestingMode::Full);
            assert_eq!(
                (
                    full.gates,
                    full.checks,
                    full.run_findings,
                    full.fact_gap_filter,
                    full.run_verdict,
                    full.note
                ),
                (
                    light.gates,
                    light.checks,
                    light.run_findings,
                    light.fact_gap_filter,
                    light.run_verdict,
                    light.note
                )
            );
        }
    }

    #[test]
    fn the_gate_plan_is_what_the_round_runs() {
        let stored = plan(&[Diff, Checks], &["unit"]);
        let chosen = pick(TestingMode::Light, Some(&stored), &["src/app.ts"]);
        assert_eq!(chosen.gate_plan().gates, chosen.gates);
        assert_eq!(chosen.gate_plan().checks, chosen.checks);
    }

    // ---- what counts as code ----------------------------------------------------------------------------------------

    #[test]
    fn documents_are_not_code_and_everything_else_is() {
        assert!(!code_changed(&[]));
        assert!(!code_changed(&paths(&[
            "README.md",
            "docs/a.rs",
            "CHANGELOG",
            "notes.TXT",
            "guide.mdx"
        ])));
        assert!(code_changed(&paths(&["README.md", "src/a.rs"])));
        assert!(code_changed(&paths(&["package.json"])));
        assert!(code_changed(&paths(&["Cargo.lock"])));
        assert!(code_changed(&paths(&[".github/workflows/ci.yml"])));
        // A docs folder inside source is code; a Windows path, spaces and unicode are read as paths.
        assert!(code_changed(&paths(&["src/docs/render.ts"])));
        assert!(!code_changed(&paths(&["docs\\guide.md", "My Notes/é.md"])));
        assert!(code_changed(&paths(&["src\\app.ts"])));
    }

    // ---- the fact-gap filter ----------------------------------------------------------------------------------------

    fn every_kind_of_gap() -> Vec<String> {
        // A failed check, a package edited after its last run (stale), a pass claim with no run after the edit, two
        // open to-dos.
        let turn = FactTurn {
            checks: vec![
                FactCheck {
                    command: "npm test".into(),
                    status: "passed".into(),
                    at: 1.0,
                },
                FactCheck {
                    command: "cargo test".into(),
                    status: "failed".into(),
                    at: 2.0,
                },
            ],
            edits: vec![FactEdit {
                path: "src/app.ts".into(),
                at: 3.0,
            }],
            todos: vec![
                FactTodo {
                    text: "wire the button".into(),
                    open: true,
                },
                FactTodo {
                    text: "rename the file".into(),
                    open: true,
                },
            ],
            answer: "All tests pass.".into(),
        };
        fact_gaps::done_gaps(&turn)
    }

    #[test]
    fn at_ship_keeps_a_failed_check_and_an_open_todo_and_drops_the_rest() {
        let gaps = every_kind_of_gap();
        assert!(
            gaps.iter().any(|g| fact_gaps::is_failed_check_gap(g)),
            "{gaps:?}"
        );
        assert!(
            gaps.iter().any(|g| fact_gaps::is_open_todo_gap(g)),
            "{gaps:?}"
        );
        assert!(
            gaps.len() > 2,
            "the turn should have other gaps too: {gaps:?}"
        );
        let kept = FactGapFilter::FailedCheckAndOpenTodo.keep(gaps.clone());
        assert_eq!(kept.len(), 2, "{kept:?}");
        assert!(fact_gaps::is_failed_check_gap(&kept[0]));
        assert!(fact_gaps::is_open_todo_gap(&kept[1]));
        assert!(kept.iter().all(|gap| gaps.contains(gap)));
    }

    #[test]
    fn a_single_open_todo_is_kept_the_same_way() {
        let turn = FactTurn {
            todos: vec![FactTodo {
                text: "wire the button".into(),
                open: true,
            }],
            ..FactTurn::default()
        };
        let kept = FactGapFilter::FailedCheckAndOpenTodo.keep(fact_gaps::done_gaps(&turn));
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(fact_gaps::is_open_todo_gap(&kept[0]));
    }

    #[test]
    fn all_keeps_everything_in_order_and_nothing_keeps_nothing() {
        let gaps = every_kind_of_gap();
        assert_eq!(FactGapFilter::All.keep(gaps.clone()), gaps);
        assert!(FactGapFilter::Nothing.keep(gaps).is_empty());
        assert!(FactGapFilter::FailedCheckAndOpenTodo
            .keep(Vec::new())
            .is_empty());
    }

    // ---- SC-7: the red-before-the-fix gap -----------------------------------------------------------------------------

    #[test]
    fn at_ship_and_off_drop_the_no_red_gap_because_they_assume_the_worker_tested() {
        let gaps = vec![
            fact_gaps::NO_RED_BEFORE_FIX.to_string(),
            "There is still an open to-do: x.".to_string(),
        ];
        assert_eq!(
            FactGapFilter::FailedCheckAndOpenTodo.keep(gaps.clone()),
            vec![gaps[1].clone()]
        );
        assert!(FactGapFilter::Nothing.keep(gaps.clone()).is_empty());
        // Light and full keep every gap, this one too.
        assert_eq!(FactGapFilter::All.keep(gaps.clone()), gaps);
        assert!(fact_gaps::is_no_red_gap(&gaps[0]));
        assert!(!fact_gaps::is_failed_check_gap(&gaps[0]));
        assert!(!fact_gaps::is_open_todo_gap(&gaps[0]));
    }

    #[test]
    fn only_light_and_full_ask_a_fix_for_its_red_run() {
        for mode in TestingMode::ALL {
            let chosen = pick(mode, None, &["src/app.ts"]);
            let expected = matches!(mode, TestingMode::Light | TestingMode::Full);
            assert_eq!(chosen.needs_red_before_fix(), expected, "{mode:?}");
            assert_eq!(
                chosen.fact_gap_filter == FactGapFilter::All,
                expected,
                "{mode:?}: the mode that asks for it is the one that keeps every gap"
            );
        }
    }

    #[test]
    fn other_sentences_are_never_mistaken_for_those_two() {
        for gap in [
            "Tests went stale after the last edit.",
            "The answer says the tests passed, but no check ran after the last edit.",
            "The answer says the build passed, but no check ran after the last edit.",
            "A piped or masked run does not count.",
            "No test reached src.",
            "",
            "A check failed",
            "There is still an open question",
        ] {
            assert!(!fact_gaps::is_failed_check_gap(gap), "{gap:?}");
            assert!(!fact_gaps::is_open_todo_gap(gap), "{gap:?}");
        }
    }
}
