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
//! | `full` | as `light`, plus the brief's own check lines (SC-4; SC-7 adds the real-app recipe) | yes | all | yes | done |
//!
//! SC-5: the verdict model is either the cheap one-turn read-only check or the running checker (a model from another
//! family that re-runs the brief's check lines in a read-only copy: `Checker`). The running checker reads a finished
//! task's claims in `full` when code changed, and in `light` and `at-ship` when the diff touches a protected or security
//! path (`risky`). Never in `off`. Everything else keeps today's cheap check, or none where the mode runs none.
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
            FactGapFilter::FailedCheckAndOpenTodo => gaps
                .into_iter()
                .filter(|gap| {
                    fact_gaps::is_failed_check_gap(gap) || fact_gaps::is_open_todo_gap(gap)
                })
                .collect(),
            FactGapFilter::Nothing => Vec::new(),
        }
    }
}

/// SC-5: which model reads a finished task's claims.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Checker {
    /// No verdict model: the mode passes on its gates alone, or the task changed nothing.
    #[default]
    None,
    /// Today's one-turn read-only check on the cheap model.
    Cheap,
    /// SC-5: re-runs the brief's check commands in a read-only copy and asks a model from another family.
    Running,
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
    /// Whether a verdict model is asked (`checker` is not `None`).
    pub run_verdict: bool,
    /// SC-5: which one.
    pub checker: Checker,
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
}

/// Whether any changed path is code: anything git sees that is not a document (markdown, text, a `docs/` folder).
pub fn code_changed(changed: &[String]) -> bool {
    changed.iter().any(|path| !fact_gaps::is_docs_path(path))
}

/// SC-5: whether any changed path is one the project protects (its own extra list and the built-in one, the floor's own
/// rule: `delivery::protected`) or a security path (`delivery::merge::security_paths`, the list the cross-builder review
/// reads). A protected list that can't be loaded holds every path, as the floor does: a change it can't judge is risky.
/// Paths are untrusted text: spaces, unicode, `..` and Windows separators are the floor's to read.
pub fn touches_risky_path(changed: &[String], protected_extra: &[String]) -> bool {
    use crate::delivery::{merge, protected};
    let shared = protected::shared_list().ok();
    if !protected::protected_hits(shared, changed, protected_extra).is_empty() {
        return true;
    }
    let security = merge::security_paths();
    changed.iter().any(|path| {
        security
            .iter()
            .any(|pattern| merge::glob_match(pattern, &path.replace('\\', "/")))
    })
}

/// The gates, findings, fact gaps and verdict a finished task gets. Pure: `plan` is the brief's stored plan, `changed`
/// the paths the copy changed since it started, and `code_changed` whether any is code (pass `true` when the diff
/// couldn't be read, so the gates run and say so rather than skip).
/// SC-5: `risky` is whether the diff touches a path the project protects (its own list and the built-in one) or a security
/// path (`delivery::merge::security_paths`; `touches_risky_path`). Pass `true` too when the diff couldn't be read, so the
/// stricter check runs and says it couldn't rather than skip. A risky change gets the running checker in `at-ship` and
/// `light`; `full` gives it to every code diff; `off` never.
pub fn gates_for(
    mode: TestingMode,
    plan: Option<&GatePlan>,
    changed: &[String],
    code_changed: bool,
    risky: bool,
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
            checker: Checker::None,
            note: None,
        };
    }
    // The brief's plan joins the floor in `light` and `full`. In `at-ship` and `off` the person's mode wins and the
    // plan is ignored: the person chose not to test each task, and a brief must not turn that back on.
    let (mut gates, checks, run_findings, fact_gap_filter, checker, note) = match mode {
        TestingMode::Off => (
            vec![GateKind::Diff, GateKind::Committed],
            Vec::new(),
            false,
            FactGapFilter::Nothing,
            Checker::None,
            Some(NOTE_OFF),
        ),
        // SC-5: a risky change is read by the running checker even here. It tested the task as far as it could, so a pass
        // no longer says "Built, not tested yet".
        TestingMode::AtShip => (
            vec![GateKind::Diff, GateKind::Committed],
            Vec::new(),
            true,
            FactGapFilter::FailedCheckAndOpenTodo,
            if risky {
                Checker::Running
            } else {
                Checker::None
            },
            if risky { None } else { Some(NOTE_AT_SHIP) },
        ),
        // SC-4: the brief's own check lines run inside the `checks` gate this adds for a code diff (`gates::with_brief_lines`),
        // in `light` and in `full`. SC-5: the running checker reads a risky diff in `light`, and any code diff in `full`;
        // the cheap read-only check stays for the rest. SC-7 adds the real-app recipe to `full`.
        TestingMode::Light | TestingMode::Full => {
            let mut gates = vec![GateKind::Diff, GateKind::Committed];
            if code_changed {
                gates.extend([GateKind::Checks, GateKind::Ratchet]);
            }
            let named = plan.map(|plan| plan.checks.clone()).unwrap_or_default();
            gates.extend(plan.map(|plan| plan.gates.clone()).unwrap_or_default());
            let running = risky || (mode == TestingMode::Full && code_changed);
            let checker = if running {
                Checker::Running
            } else {
                Checker::Cheap
            };
            (gates, named, true, FactGapFilter::All, checker, None)
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
        run_verdict: checker != Checker::None,
        checker,
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
        gates_for(mode, stored, &changed, code_changed(&changed), false)
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
        let chosen = gates_for(TestingMode::AtShip, None, &[], true, false);
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
    fn full_runs_the_same_gates_as_light_and_differs_only_in_who_reads_the_claims() {
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

    // ---- SC-5: who reads the claims -----------------------------------------------------------------------------------

    fn risky_pick(mode: TestingMode, changed: &[&str], risky: bool) -> ModePlan {
        let changed = paths(changed);
        gates_for(mode, None, &changed, code_changed(&changed), risky)
    }

    #[test]
    fn the_running_checker_applies_by_mode_and_diff() {
        use Checker::{Cheap, None as NoChecker, Running};
        // (mode, what changed, touches a protected or security path) -> who reads the claims.
        let table: [(TestingMode, &[&str], bool, Checker); 16] = [
            // off: never, whatever the diff.
            (TestingMode::Off, &["src/app.ts"], false, NoChecker),
            (TestingMode::Off, &["src/app.ts"], true, NoChecker),
            (TestingMode::Off, &["docs/a.md"], true, NoChecker),
            // at-ship: no model today; a risky diff gets the running checker.
            (TestingMode::AtShip, &["src/app.ts"], false, NoChecker),
            (TestingMode::AtShip, &["docs/a.md"], false, NoChecker),
            (TestingMode::AtShip, &["src/app.ts"], true, Running),
            (TestingMode::AtShip, &["docs/a.md"], true, Running),
            // light: today's cheap check; a risky diff, code or not, gets the running checker.
            (TestingMode::Light, &["src/app.ts"], false, Cheap),
            (TestingMode::Light, &["docs/a.md"], false, Cheap),
            (TestingMode::Light, &["src/app.ts"], true, Running),
            (TestingMode::Light, &["docs/a.md"], true, Running),
            // full: every code diff; a docs-only diff keeps the cheap check unless it is risky.
            (TestingMode::Full, &["src/app.ts"], false, Running),
            (
                TestingMode::Full,
                &["src/app.ts", "docs/a.md"],
                false,
                Running,
            ),
            (TestingMode::Full, &["docs/a.md"], false, Cheap),
            (TestingMode::Full, &["docs/a.md"], true, Running),
            (TestingMode::Full, &["src/app.ts"], true, Running),
        ];
        for (mode, changed, risky, want) in table {
            let chosen = risky_pick(mode, changed, risky);
            assert_eq!(chosen.checker, want, "{mode:?} {changed:?} risky={risky}");
            assert_eq!(
                chosen.run_verdict,
                want != NoChecker,
                "{mode:?} {changed:?} risky={risky}: a verdict model is asked exactly when there is a checker"
            );
        }
    }

    #[test]
    fn a_task_that_changed_nothing_and_stored_no_plan_gets_no_checker_in_any_mode() {
        for mode in TestingMode::ALL {
            for risky in [false, true] {
                let chosen = gates_for(mode, None, &[], false, risky);
                assert!(chosen.as_today, "{mode:?}");
                assert_eq!(chosen.checker, Checker::None, "{mode:?}");
                assert!(!chosen.run_verdict);
            }
        }
    }

    #[test]
    fn a_diff_that_could_not_be_read_gets_the_stricter_check_when_the_caller_says_risky() {
        // The caller passes code_changed = true and risky = true with no paths.
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            let chosen = gates_for(mode, None, &[], true, true);
            assert_eq!(chosen.checker, Checker::Running, "{mode:?}");
        }
        assert_eq!(
            gates_for(TestingMode::Off, None, &[], true, true).checker,
            Checker::None
        );
    }

    #[test]
    fn a_risky_diff_in_at_ship_keeps_at_ships_gates_and_findings_and_loses_only_the_untested_note()
    {
        let plain = risky_pick(TestingMode::AtShip, &["src/app.ts"], false);
        let risky = risky_pick(TestingMode::AtShip, &["src/app.ts"], true);
        // The person's mode still wins on the gates, the findings and the fact gaps.
        assert_eq!(risky.gates, plain.gates);
        assert_eq!(risky.gates, vec![Diff, Committed]);
        assert!(risky.run_findings);
        assert_eq!(risky.fact_gap_filter, FactGapFilter::FailedCheckAndOpenTodo);
        // It was tested as far as the checker could, so a pass does not read "Built, not tested yet".
        assert_eq!(plain.note, Some(NOTE_AT_SHIP));
        assert_eq!(risky.note, None);
    }

    #[test]
    fn a_risky_diff_in_light_keeps_lights_gates() {
        let plain = risky_pick(TestingMode::Light, &["src/app.ts"], false);
        let risky = risky_pick(TestingMode::Light, &["src/app.ts"], true);
        assert_eq!(risky.gates, plain.gates);
        assert_eq!(risky.checks, plain.checks);
        assert_eq!(risky.fact_gap_filter, plain.fact_gap_filter);
        assert_eq!(risky.note, plain.note);
        assert_eq!(plain.checker, Checker::Cheap);
        assert_eq!(risky.checker, Checker::Running);
    }

    #[test]
    fn protected_paths_and_security_paths_are_risky_and_ordinary_code_is_not() {
        let risky =
            |changed: &[&str], extra: &[&str]| touches_risky_path(&paths(changed), &paths(extra));
        // The built-in protected list.
        assert!(risky(&[".github/workflows/ci.yml"], &[]));
        assert!(risky(&["src/app.ts", "AGENTS.md"], &[]));
        assert!(risky(&["infra/main.tf"], &[]));
        // A security path (the cross-builder review's list), which is not on the built-in list.
        assert!(risky(&["src-tauri/src/firstmate/mcp.rs"], &[]));
        assert!(risky(&["src-tauri/src/delegations.rs"], &[]));
        assert!(risky(&["src/features/mobile/model/pair.ts"], &[]));
        // Ordinary code and documents are not.
        assert!(!risky(&["src/features/tally/model/sum.ts"], &[]));
        assert!(!risky(&["README.md", "docs/guide.md"], &[]));
        assert!(!risky(&[], &[]));
    }

    #[test]
    fn the_projects_own_protected_list_adds_and_never_removes() {
        let changed = ["billing/charge.ts"];
        assert!(!touches_risky_path(&paths(&changed), &[]));
        assert!(touches_risky_path(&paths(&changed), &paths(&["billing/"])));
        // An extra can't shrink the built-in list.
        assert!(touches_risky_path(
            &paths(&[".github/workflows/ci.yml"]),
            &paths(&["billing/"])
        ));
    }

    #[test]
    fn windows_separators_case_and_odd_paths_are_read_as_paths() {
        let risky = |changed: &[&str]| touches_risky_path(&paths(changed), &[]);
        assert!(risky(&["src-tauri\\src\\delegations.rs"]));
        assert!(risky(&[".github\\workflows\\ci.yml"]));
        assert!(risky(&["Src-Tauri/SRC/Delegations.rs"]));
        // A `..` segment is untrusted: the floor holds it rather than judge where it leads.
        assert!(risky(&["src/../.github/workflows/ci.yml"]));
        // Spaces and unicode are ordinary names.
        assert!(!risky(&["My Notes/\u{e9}tude.ts"]));
        assert!(risky(&["My Notes/.github/workflows/x.yml"]));
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
