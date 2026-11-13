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
//! | `full` | as `light`, plus the brief's own check lines (SC-4; SC-7 adds the real-app recipe) and, for a code diff, the proof tools the project already has (PT-1: `proof-tools`) | yes | all | yes | done |
//!
//! PT-5: in `at-ship` the "a check failed" gap is for the task's own tests only. A failing test the task did not write and does not
//! cover goes on the project's test debt list (`crate::test_debt`) and the task is not sent back for it; the list is sorted once, at
//! the ship check. The weakened, deleted and skipped test findings stay in force in every mode that runs findings. `light` and `full`
//! test each task, so a failed check there is always the task's to fix.
//!
//! PT-5: a change to a sensitive path (`firstmate::sensitive`: keys, permissions, the sandbox, billing, migrations, CI, installers, the
//! project's protected paths and its `docs/hivra/sensitive-paths.json`) is always checked in full: in `at-ship`, `light` and `full` it
//! gets the `light`/`full` gates, the brief's own lines, the proof tools and the running checker (`ModePlan::sensitive`), whatever the
//! "When the checker runs" rule says. "No testing" stays no testing.
//!
//! SC-5: the verdict model is either the cheap one-turn read-only check or the running checker (a model from another
//! family that re-runs the brief's check lines in a read-only copy: `Checker`). PT-4: which tasks get the running checker is
//! the app's "When the checker runs" setting (`checker_when`). By default (it follows the mode) it reads a finished task's
//! claims in `full` when code changed, and in `light` and `at-ship` when the diff touches a protected or security path
//! (`risky`); "Every code change" gives it to every code diff in those three modes; "Only risky changes" to a risky one
//! only; "Off" never. Never in `off` (No testing), whatever the setting says. Everything else keeps the cheap check, or none
//! where the mode runs none.
//!
//! A task whose copy changed nothing and that stored no plan (a research or answer task) is unaffected in every mode:
//! `as_today`, and it settles as it did before. The person's mode wins over the brief's own plan in `at-ship` and
//! `off`; in `light` and `full` the brief's plan is added to the floor. The routes check is the project's and runs in
//! every mode whatever this says (`gates::run_round`).

use super::checker_when::{self, WhenRule};
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
                        && (fact_gaps::is_failed_check_gap(gap) || fact_gaps::is_open_todo_gap(gap))
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
    /// PT-5: the diff touches a sensitive path (`firstmate::sensitive`) in a mode that tests at all. The task is tested as a `full` one
    /// is, whatever the mode: every check, the brief's own lines, the proof tools, and the running checker. Never true in `off`.
    pub sensitive: bool,
}

impl ModePlan {
    /// The plan `gates::run_round` runs.
    pub fn gate_plan(&self) -> GatePlan {
        GatePlan {
            gates: self.gates.clone(),
            checks: self.checks.clone(),
        }
    }

    /// Whether this task is tested when it finishes (`light` and `full`, and any task of a mode that tests that touches a sensitive
    /// path), rather than at the ship check or not at all. The brief's own check lines run only for these.
    pub fn tests_each_task(&self) -> bool {
        matches!(self.mode, TestingMode::Light | TestingMode::Full) || self.sensitive
    }

    /// Whether the proof tools are part of this task's checks: `full`, and a sensitive change in any mode that tests.
    pub fn full_proof(&self) -> bool {
        self.mode == TestingMode::Full || self.sensitive
    }

    /// SC-7: whether a bug-fix brief must show a failing run of its test before the fix. Only the tasks that are tested when they
    /// finish ask it: `at-ship` and `off` assume the worker tested, and test at the ship check or not at all (a sensitive change is
    /// tested like a `full` one).
    pub fn needs_red_before_fix(&self) -> bool {
        self.tests_each_task()
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
/// stricter check runs and says it couldn't rather than skip. With the default rule a risky change gets the running checker in
/// `at-ship` and `light`; `full` gives it to every code diff; `off` never (PT-4: the rule below can change that).
///
/// PT-1: `proof_tools` is whether the project already has an installed proof tool that fits it (`proof_tools::detect`). Only in
/// `full`, for a code diff, it adds the `proof-tools` gate. None installed: the gate is not added (it is optional), and nothing
/// reads as a pass.
///
/// PT-4: `when` is the app's "When the checker runs" rule (`checker_when`), read with the mode. It decides which tasks get the
/// running checker (`checker_when::task_checker`); `FollowMode`, the default, is what this did before it existed.
pub fn gates_for_with(
    mode: TestingMode,
    plan: Option<&GatePlan>,
    changed: &[String],
    code_changed: bool,
    risky: bool,
    sensitive: bool,
    proof_tools: bool,
    when: WhenRule,
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
            sensitive: false,
        };
    }
    // PT-5: a sensitive change (keys, permissions, the sandbox, billing, migrations, CI, installers) is always checked in full, in
    // every mode that tests at all, even `at-ship`. "No testing" is the person's own choice not to test, and it stands.
    let sensitive = sensitive && mode != TestingMode::Off;
    // The brief's plan joins the floor in `light` and `full`. In `at-ship` and `off` the person's mode wins and the
    // plan is ignored: the person chose not to test each task, and a brief must not turn that back on.
    // PT-4: which model reads the claims comes from the rule and the mode in one place (`checker_when::task_checker`); "No
    // testing" is never a checker. PT-5: a sensitive change always gets the running checker, whatever the rule says.
    let checker = if sensitive {
        Checker::Running
    } else {
        checker_when::task_checker(when, mode, code_changed, risky)
    };
    let (mut gates, checks, run_findings, fact_gap_filter, note) = match mode {
        TestingMode::Off => (
            vec![GateKind::Diff, GateKind::Committed],
            Vec::new(),
            false,
            FactGapFilter::Nothing,
            Some(NOTE_OFF),
        ),
        // SC-5: a change the running checker reads is tested as far as it could be, so a pass no longer says "Built, not
        // tested yet". Any other task in this mode only has to build.
        TestingMode::AtShip if !sensitive => (
            vec![GateKind::Diff, GateKind::Committed],
            Vec::new(),
            true,
            FactGapFilter::FailedCheckAndOpenTodo,
            if checker == Checker::Running {
                None
            } else {
                Some(NOTE_AT_SHIP)
            },
        ),
        // SC-4: the brief's own check lines run inside the `checks` gate this adds for a code diff (`gates::with_brief_lines`),
        // in `light` and in `full`. SC-5: the running checker reads a risky diff in `light`, and any code diff in `full`;
        // the cheap read-only check stays for the rest. SC-7 adds the real-app recipe to `full`.
        // PT-5: a sensitive change in `at-ship` is tested like these, and gets the proof tools like `full` does.
        TestingMode::AtShip | TestingMode::Light | TestingMode::Full => {
            let mut gates = vec![GateKind::Diff, GateKind::Committed];
            if code_changed {
                gates.extend([GateKind::Checks, GateKind::Ratchet]);
            }
            let named = plan.map(|plan| plan.checks.clone()).unwrap_or_default();
            gates.extend(plan.map(|plan| plan.gates.clone()).unwrap_or_default());
            // PT-1: the tools the project already has, in `full` (and for a sensitive change) only, for a code diff.
            if (mode == TestingMode::Full || sensitive) && code_changed && proof_tools {
                gates.push(GateKind::ProofTools);
            }
            (gates, named, true, FactGapFilter::All, None)
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
        sensitive,
    }
}

/// Whether the `proof-tools` gate is wanted for this task (`gates_for_with`'s `proof_tools`): `full` (or, PT-5, a sensitive change in
/// a mode that tests), a code diff, and a proof tool the project has that is not switched off. `detect` is asked only then, so a task
/// in any other mode never probes a program. PT-2: it must be a detection that already leaves out the tools the person switched off
/// (`proof_tools::detect_folder_in_use`), so a project whose every tool is off gets no gate at all, the same as one that has none.
pub fn proof_gate_wanted_for(
    mode: TestingMode,
    sensitive: bool,
    code_changed: bool,
    detect: impl FnOnce() -> crate::proof_tools::detect::Detection,
) -> bool {
    (mode == TestingMode::Full || (sensitive && mode != TestingMode::Off))
        && code_changed
        && detect().has_installed()
}

/// `proof_gate_wanted_for` for a change that is not sensitive. What the tests that pre-date PT-5 call.
#[cfg(test)]
pub fn proof_gate_wanted(
    mode: TestingMode,
    code_changed: bool,
    detect: impl FnOnce() -> crate::proof_tools::detect::Detection,
) -> bool {
    proof_gate_wanted_for(mode, false, code_changed, detect)
}

/// The gates, findings, fact gaps and verdict a finished task gets, for a project with no proof tool and the default checker
/// rule (`gates_for_with`), for a change that is not sensitive. What the tests that pre-date proof tools and the rule call.
#[cfg(test)]
pub fn gates_for(
    mode: TestingMode,
    plan: Option<&GatePlan>,
    changed: &[String],
    code_changed: bool,
    risky: bool,
) -> ModePlan {
    gates_for_with(
        mode,
        plan,
        changed,
        code_changed,
        risky,
        false,
        false,
        WhenRule::FollowMode,
    )
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

    // ---- PT-1: the proof tools gate ------------------------------------------------------------------------------------

    fn with_proof(
        mode: TestingMode,
        stored: Option<&GatePlan>,
        changed: &[&str],
        proof: bool,
    ) -> ModePlan {
        let changed = paths(changed);
        gates_for_with(
            mode,
            stored,
            &changed,
            code_changed(&changed),
            false,
            false,
            proof,
            WhenRule::FollowMode,
        )
    }

    // ---- PT-4: "When the checker runs" ---------------------------------------------------------------------------------

    fn when_pick(mode: TestingMode, when: WhenRule, changed: &[&str], risky: bool) -> ModePlan {
        let changed = paths(changed);
        gates_for_with(
            mode,
            None,
            &changed,
            code_changed(&changed),
            risky,
            false,
            false,
            when,
        )
    }

    #[test]
    fn the_rule_decides_the_checker_of_each_mode_through_gates_for_with() {
        use Checker::{Cheap, None as NoChecker, Running};
        // (mode, rule, changed, risky) -> checker. Unset is the default, "follow the testing mode".
        let cases: &[(TestingMode, WhenRule, &[&str], bool, Checker)] = &[
            // The default keeps today's behaviour in every mode.
            (
                TestingMode::AtShip,
                WhenRule::default(),
                &["src/a.ts"],
                false,
                NoChecker,
            ),
            (
                TestingMode::AtShip,
                WhenRule::default(),
                &["src/a.ts"],
                true,
                Running,
            ),
            (
                TestingMode::Light,
                WhenRule::default(),
                &["src/a.ts"],
                false,
                Cheap,
            ),
            (
                TestingMode::Light,
                WhenRule::default(),
                &["src/a.ts"],
                true,
                Running,
            ),
            (
                TestingMode::Full,
                WhenRule::default(),
                &["src/a.ts"],
                false,
                Running,
            ),
            (
                TestingMode::Full,
                WhenRule::default(),
                &["docs/a.md"],
                false,
                Cheap,
            ),
            // Every code change: the checker in every mode but "No testing".
            (
                TestingMode::AtShip,
                WhenRule::EveryCodeChange,
                &["src/a.ts"],
                false,
                Running,
            ),
            (
                TestingMode::Light,
                WhenRule::EveryCodeChange,
                &["src/a.ts"],
                false,
                Running,
            ),
            (
                TestingMode::Full,
                WhenRule::EveryCodeChange,
                &["src/a.ts"],
                false,
                Running,
            ),
            (
                TestingMode::AtShip,
                WhenRule::EveryCodeChange,
                &["docs/a.md"],
                false,
                NoChecker,
            ),
            (
                TestingMode::Off,
                WhenRule::EveryCodeChange,
                &["src/a.ts"],
                true,
                NoChecker,
            ),
            // Only risky changes: a risky change, and nothing else, in every mode.
            (
                TestingMode::Full,
                WhenRule::RiskyOnly,
                &["src/a.ts"],
                false,
                Cheap,
            ),
            (
                TestingMode::Full,
                WhenRule::RiskyOnly,
                &["src/a.ts"],
                true,
                Running,
            ),
            (
                TestingMode::Light,
                WhenRule::RiskyOnly,
                &["src/a.ts"],
                false,
                Cheap,
            ),
            (
                TestingMode::AtShip,
                WhenRule::RiskyOnly,
                &["src/a.ts"],
                true,
                Running,
            ),
            // Off: the cheap one-turn check only.
            (TestingMode::Full, WhenRule::Off, &["src/a.ts"], true, Cheap),
            (
                TestingMode::Light,
                WhenRule::Off,
                &["src/a.ts"],
                false,
                Cheap,
            ),
            (
                TestingMode::AtShip,
                WhenRule::Off,
                &["src/a.ts"],
                false,
                NoChecker,
            ),
            (
                TestingMode::AtShip,
                WhenRule::Off,
                &["src/a.ts"],
                true,
                Cheap,
            ),
        ];
        for (mode, when, changed, risky, expected) in cases {
            let chosen = when_pick(*mode, *when, changed, *risky);
            assert_eq!(
                chosen.checker, *expected,
                "{mode:?} {when:?} {changed:?} risky={risky}"
            );
            assert_eq!(chosen.run_verdict, *expected != NoChecker);
        }
    }

    #[test]
    fn a_task_the_checker_reads_in_test_at_ship_no_longer_says_built_not_tested_yet() {
        let plain = when_pick(
            TestingMode::AtShip,
            WhenRule::EveryCodeChange,
            &["docs/a.md"],
            false,
        );
        assert_eq!(plain.note, Some(NOTE_AT_SHIP));
        let read = when_pick(
            TestingMode::AtShip,
            WhenRule::EveryCodeChange,
            &["src/a.ts"],
            false,
        );
        assert_eq!(read.checker, Checker::Running);
        assert_eq!(read.note, None);
        // Off reads a risky change cheaply, which is not the running checker's proof: the note stays.
        let cheap = when_pick(TestingMode::AtShip, WhenRule::Off, &["src/a.ts"], true);
        assert_eq!(cheap.checker, Checker::Cheap);
        assert_eq!(cheap.note, Some(NOTE_AT_SHIP));
    }

    #[test]
    fn no_testing_runs_no_checker_and_no_verdict_whatever_the_rule_says() {
        for when in WhenRule::ALL {
            for risky in [false, true] {
                let chosen = when_pick(TestingMode::Off, when, &["src/a.ts"], risky);
                assert_eq!(chosen.checker, Checker::None, "{when:?} risky={risky}");
                assert!(!chosen.run_verdict);
                assert_eq!(chosen.note, Some(NOTE_OFF));
            }
        }
    }

    #[test]
    fn the_proof_tools_gate_is_added_only_in_full_for_a_code_diff_with_an_installed_tool() {
        let chosen = with_proof(TestingMode::Full, None, &["src/app.ts"], true);
        assert_eq!(
            chosen.gates,
            vec![Diff, Checks, Committed, Ratchet, GateKind::ProofTools],
            "it sorts last, after the gates it reads"
        );
        // The brief's own plan (routes) joins the floor, and the proof tools still come last.
        let stored = plan(&[Routes], &[]);
        let with_routes = with_proof(TestingMode::Full, Some(&stored), &["src/app.ts"], true);
        assert_eq!(with_routes.gates.last(), Some(&GateKind::ProofTools));
        assert!(with_routes.gates.contains(&Routes));
    }

    #[test]
    fn no_installed_tool_means_no_gate_and_nothing_reads_as_a_pass() {
        let chosen = with_proof(TestingMode::Full, None, &["src/app.ts"], false);
        assert!(!chosen.gates.contains(&GateKind::ProofTools));
        // It is exactly the gates `gates_for` always chose.
        assert_eq!(chosen, pick(TestingMode::Full, None, &["src/app.ts"]));
    }

    #[test]
    fn no_other_mode_and_no_docs_only_change_gets_the_proof_tools_gate() {
        for mode in [TestingMode::Off, TestingMode::AtShip, TestingMode::Light] {
            let chosen = with_proof(mode, None, &["src/app.ts"], true);
            assert!(!chosen.gates.contains(&GateKind::ProofTools), "{mode:?}");
            assert_eq!(chosen, pick(mode, None, &["src/app.ts"]), "{mode:?}");
        }
        let docs = with_proof(TestingMode::Full, None, &["docs/a.md"], true);
        assert!(
            !docs.gates.contains(&GateKind::ProofTools),
            "docs only is not a code diff"
        );
        let nothing = with_proof(TestingMode::Full, None, &[], true);
        assert!(
            nothing.as_today && nothing.gates.is_empty(),
            "a research task is left as it is"
        );
    }

    // ---- PT-2: a tool the person switched off is not a tool the gate has -----------------------------------------------

    /// A project with fast-check and StrykerJS in it, removed when it goes.
    struct Project(std::path::PathBuf);

    impl Project {
        fn new() -> Project {
            let base =
                std::env::temp_dir().join(format!("hivra pt2 gate {}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(base.join("scratch")).unwrap();
            std::fs::create_dir_all(base.join("proj")).unwrap();
            std::fs::write(
                base.join("proj/package.json"),
                r#"{"devDependencies":{"fast-check":"4","@stryker-mutator/core":"10.1.1"}}"#,
            )
            .unwrap();
            Project(base)
        }
    }

    impl Drop for Project {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Whether the Full gate wants proof tools for a code diff, deciding by the app's own `detect_in` with these tools off.
    fn wanted_with_off(project: &Project, mode: TestingMode, off: &[&str]) -> bool {
        use crate::proof_tools::{run, switch::test_env::OffEnv};
        let env = OffEnv::new(off, project.0.join("scratch"));
        proof_gate_wanted(mode, true, || run::detect_in(&project.0.join("proj"), &env))
    }

    #[test]
    fn the_gate_is_wanted_while_one_installed_tool_is_on_and_not_when_every_one_is_switched_off() {
        let project = Project::new();
        assert!(wanted_with_off(&project, TestingMode::Full, &[]));
        assert!(wanted_with_off(&project, TestingMode::Full, &["stryker"]));
        assert!(!wanted_with_off(
            &project,
            TestingMode::Full,
            &["stryker", "fast-check"]
        ));
        // The gates that follow: all off is exactly the gates a project with no tool gets.
        let all_off = wanted_with_off(&project, TestingMode::Full, &["stryker", "fast-check"]);
        let chosen = with_proof(TestingMode::Full, None, &["src/app.ts"], all_off);
        assert!(!chosen.gates.contains(&GateKind::ProofTools));
        assert_eq!(chosen, pick(TestingMode::Full, None, &["src/app.ts"]));
        let some_on = wanted_with_off(&project, TestingMode::Full, &["stryker"]);
        assert!(
            with_proof(TestingMode::Full, None, &["src/app.ts"], some_on)
                .gates
                .contains(&GateKind::ProofTools)
        );
    }

    #[test]
    fn only_full_for_a_code_diff_asks_what_the_project_has() {
        let asked = std::cell::Cell::new(0);
        let ask = || {
            asked.set(asked.get() + 1);
            crate::proof_tools::detect::Detection {
                stacks: Vec::new(),
                fitting: Vec::new(),
                off: Vec::new(),
            }
        };
        for mode in [TestingMode::Off, TestingMode::AtShip, TestingMode::Light] {
            assert!(!proof_gate_wanted(mode, true, ask));
        }
        assert!(!proof_gate_wanted(TestingMode::Full, false, ask));
        assert_eq!(asked.get(), 0, "no program is probed for those");
        assert!(!proof_gate_wanted(TestingMode::Full, true, ask));
        assert_eq!(asked.get(), 1);
    }

    #[test]
    fn a_brief_cannot_name_the_proof_tools_gate_and_it_serialises_by_its_name() {
        assert_eq!(GateKind::parse("proof-tools"), None);
        assert_eq!(
            serde_json::to_string(&GateKind::ProofTools).unwrap(),
            "\"proof-tools\""
        );
    }

    // ---- PT-5: a sensitive change is always checked in full -----------------------------------------------------------

    fn sens_pick(
        mode: TestingMode,
        stored: Option<&GatePlan>,
        changed: &[&str],
        proof: bool,
        when: WhenRule,
    ) -> ModePlan {
        let changed = paths(changed);
        gates_for_with(
            mode,
            stored,
            &changed,
            code_changed(&changed),
            false,
            true,
            proof,
            when,
        )
    }

    #[test]
    fn a_sensitive_change_gets_the_full_checks_and_the_running_checker_in_every_mode_that_tests() {
        let stored = plan(&[Routes], &["unit"]);
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            let chosen = sens_pick(
                mode,
                Some(&stored),
                &["src/features/auth/login.ts"],
                true,
                WhenRule::FollowMode,
            );
            assert!(chosen.sensitive, "{mode:?}");
            assert_eq!(
                chosen.gates,
                vec![
                    Diff,
                    Checks,
                    Committed,
                    Ratchet,
                    Routes,
                    GateKind::ProofTools
                ],
                "{mode:?}: the project's checks, the ratchet, the brief's plan and the proof tools"
            );
            assert_eq!(chosen.checks, vec!["unit".to_string()], "{mode:?}");
            assert!(chosen.run_findings, "{mode:?}");
            assert_eq!(chosen.fact_gap_filter, FactGapFilter::All, "{mode:?}");
            assert_eq!(chosen.checker, Checker::Running, "{mode:?}");
            assert!(chosen.run_verdict, "{mode:?}");
            assert_eq!(
                chosen.note, None,
                "{mode:?}: it was tested, so no 'not tested yet'"
            );
            assert!(chosen.tests_each_task(), "{mode:?}");
            assert!(chosen.full_proof(), "{mode:?}");
            assert!(chosen.needs_red_before_fix(), "{mode:?}");
        }
    }

    #[test]
    fn test_at_ship_without_a_sensitive_change_stays_exactly_what_it_was() {
        let plain = gates_for_with(
            TestingMode::AtShip,
            None,
            &paths(&["src/app.ts"]),
            true,
            false,
            false,
            true,
            WhenRule::FollowMode,
        );
        assert!(!plain.sensitive);
        assert_eq!(plain.gates, vec![Diff, Committed]);
        assert_eq!(plain.checker, Checker::None);
        assert_eq!(plain.note, Some(NOTE_AT_SHIP));
        assert_eq!(plain.fact_gap_filter, FactGapFilter::FailedCheckAndOpenTodo);
        assert!(!plain.tests_each_task());
        assert!(!plain.full_proof());
        assert!(!plain.needs_red_before_fix());
        // The same change, sensitive, is a different plan: that is the whole feature.
        let sensitive = sens_pick(
            TestingMode::AtShip,
            None,
            &["src/app.ts"],
            true,
            WhenRule::FollowMode,
        );
        assert_ne!(sensitive, plain);
    }

    #[test]
    fn no_testing_stays_no_testing_whatever_the_diff_touches() {
        for when in WhenRule::ALL {
            let chosen = sens_pick(TestingMode::Off, None, &["src/auth/login.ts"], true, when);
            assert!(!chosen.sensitive, "{when:?}");
            assert_eq!(chosen.gates, vec![Diff, Committed], "{when:?}");
            assert_eq!(chosen.checker, Checker::None, "{when:?}");
            assert!(!chosen.run_verdict, "{when:?}");
            assert!(!chosen.run_findings, "{when:?}");
            assert_eq!(chosen.note, Some(NOTE_OFF), "{when:?}");
            assert!(
                !chosen.tests_each_task() && !chosen.full_proof(),
                "{when:?}"
            );
        }
    }

    #[test]
    fn the_checker_rule_cannot_switch_off_the_checker_for_a_sensitive_change() {
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            for when in WhenRule::ALL {
                let chosen = sens_pick(mode, None, &["src/billing/plan.ts"], false, when);
                assert_eq!(chosen.checker, Checker::Running, "{mode:?} {when:?}");
            }
        }
    }

    #[test]
    fn a_sensitive_change_that_is_only_documents_gets_the_checker_but_no_code_checks() {
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            let chosen = sens_pick(
                mode,
                None,
                &["docs/billing/pricing.md"],
                true,
                WhenRule::FollowMode,
            );
            assert_eq!(chosen.gates, vec![Diff, Committed], "{mode:?}");
            assert_eq!(chosen.checker, Checker::Running, "{mode:?}");
            assert!(chosen.sensitive, "{mode:?}");
        }
    }

    #[test]
    fn a_sensitive_change_with_no_installed_proof_tool_gets_no_proof_gate() {
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            let chosen = sens_pick(
                mode,
                None,
                &["src/auth/login.ts"],
                false,
                WhenRule::FollowMode,
            );
            assert!(!chosen.gates.contains(&GateKind::ProofTools), "{mode:?}");
            assert_eq!(
                chosen.gates,
                vec![Diff, Checks, Committed, Ratchet],
                "{mode:?}"
            );
        }
    }

    #[test]
    fn a_diff_that_could_not_be_read_and_is_treated_as_sensitive_is_checked_in_full_in_test_at_ship(
    ) {
        // The caller passes code_changed = true, risky = true, sensitive = true and no paths.
        let chosen = gates_for_with(
            TestingMode::AtShip,
            None,
            &[],
            true,
            true,
            true,
            false,
            WhenRule::FollowMode,
        );
        assert!(!chosen.as_today);
        assert_eq!(chosen.gates, vec![Diff, Checks, Committed, Ratchet]);
        assert_eq!(chosen.checker, Checker::Running);
    }

    #[test]
    fn a_task_that_changed_nothing_is_left_alone_even_if_called_sensitive() {
        let chosen = gates_for_with(
            TestingMode::AtShip,
            None,
            &[],
            false,
            false,
            true,
            true,
            WhenRule::FollowMode,
        );
        assert!(chosen.as_today);
        assert!(!chosen.sensitive);
        assert!(chosen.gates.is_empty());
    }

    #[test]
    fn the_proof_gate_is_wanted_for_a_sensitive_change_in_a_mode_that_tests_and_never_in_no_testing(
    ) {
        use crate::proof_tools::{run, switch::test_env::OffEnv};
        let project = Project::new();
        let wanted = |mode: TestingMode, sensitive: bool, code: bool| {
            let env = OffEnv::new(&[], project.0.join("scratch"));
            proof_gate_wanted_for(mode, sensitive, code, || {
                run::detect_in(&project.0.join("proj"), &env)
            })
        };
        // Full always; the others only when the change is sensitive.
        assert!(wanted(TestingMode::Full, false, true));
        assert!(wanted(TestingMode::Full, true, true));
        for mode in [TestingMode::AtShip, TestingMode::Light] {
            assert!(!wanted(mode, false, true), "{mode:?}");
            assert!(wanted(mode, true, true), "{mode:?}");
            assert!(!wanted(mode, true, false), "{mode:?}: docs only");
        }
        assert!(!wanted(TestingMode::Off, true, true));
        // A program is probed only when the answer can matter.
        let asked = std::cell::Cell::new(0);
        let ask = || {
            asked.set(asked.get() + 1);
            crate::proof_tools::detect::Detection {
                stacks: Vec::new(),
                fitting: Vec::new(),
                off: Vec::new(),
            }
        };
        assert!(!proof_gate_wanted_for(TestingMode::Off, true, true, ask));
        assert!(!proof_gate_wanted_for(
            TestingMode::AtShip,
            false,
            true,
            ask
        ));
        assert!(!proof_gate_wanted_for(TestingMode::Light, true, false, ask));
        assert_eq!(asked.get(), 0);
    }

    #[test]
    fn the_briefs_own_lines_run_for_a_sensitive_change_in_every_mode_that_tests() {
        for mode in TestingMode::ALL {
            let chosen = sens_pick(mode, None, &["src/auth/x.ts"], false, WhenRule::FollowMode);
            let want = mode != TestingMode::Off;
            assert_eq!(chosen.tests_each_task(), want, "{mode:?}");
            assert_eq!(chosen.sensitive, want, "{mode:?}");
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
