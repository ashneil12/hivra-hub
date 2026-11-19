//! PT-5: test debt, sorted once at ship.
//!
//! In a project that tests "at ship", a failing test that is not the task's own must not hold the task up: it goes on a list,
//! and the list is sorted in one batch when the ship check runs, by one "test fixer" task.
//!
//! - `doc`: the per-project document (the list, the quarantine, the per-test score) and every rule that changes it.
//! - `store`: that document on disk: atomic writes, one lock, read defensively.
//! - `own`: whose failing test is it (the rule a task can't use to hide a failure in its own tests).
//! - `divert`: what a finished task's failing tests mean for its round: in `at-ship` the ones that are not its own go to the list; in
//!   `light` and `full` only a quarantined one is let off.
//! - `quarantine`: a worker's `Quarantine: <test> | <why>` line in `light` and `full`, and the rule that a critical test is never
//!   quarantined by a worker.

pub mod commands;
pub mod divert;
pub mod doc;
pub mod fixer;
pub mod gate;
pub mod own;
pub mod quarantine;
pub mod store;
pub mod summary;

/// The event the webview hears when a project's list changes (the crew tab's line reads again).
pub const CHANGED: &str = "test-debt://changed";

/// Whether a finished task's failing tests go through the test debt list: only in `at-ship`, and only for a task that changed something
/// (a task that changed nothing keeps the round it always had). `light` and `full` test each task, so a failing test there is the
/// task's to fix, and `off` tests nothing: none of the three ever comes here.
pub fn applies(mode: crate::delivery::settings::TestingMode, as_today: bool) -> bool {
    mode == crate::delivery::settings::TestingMode::AtShip && !as_today
}

/// Whether this task reads the project's quarantine instead of the list (`gate::quarantine`): `light` and `full` test each task, so its
/// failing tests are its own to fix, except a quarantined one that is not its own. A sensitive change in `at-ship` is checked in full
/// but keeps the list: its worker was told a red test that isn't its own goes there, and its own failing tests still fail it.
pub fn reads_quarantine(plan: &crate::firstmate::testing_mode::ModePlan) -> bool {
    !plan.as_today
        && matches!(
            plan.mode,
            crate::delivery::settings::TestingMode::Light
                | crate::delivery::settings::TestingMode::Full
        )
}

/// Whether a passed task's report is read for the test fixer's decisions: in `at-ship`, whatever the task changed (a fixer that only
/// reports "code is wrong" or "flaky" changes nothing at all).
pub fn reads_fixer_report(mode: crate::delivery::settings::TestingMode) -> bool {
    mode == crate::delivery::settings::TestingMode::AtShip
}

#[cfg(test)]
mod tests {
    use super::{applies, reads_fixer_report};
    use crate::delivery::settings::TestingMode;

    #[test]
    fn a_fixers_report_is_read_in_at_ship_whatever_it_changed() {
        assert!(reads_fixer_report(TestingMode::AtShip));
        for mode in [TestingMode::Light, TestingMode::Full, TestingMode::Off] {
            assert!(!reads_fixer_report(mode), "{mode:?}");
        }
    }

    fn plan(
        mode: TestingMode,
        sensitive: bool,
        as_today: bool,
    ) -> crate::firstmate::testing_mode::ModePlan {
        use crate::firstmate::testing_mode::{Checker, FactGapFilter, ModePlan};
        ModePlan {
            mode,
            as_today,
            gates: Vec::new(),
            checks: Vec::new(),
            run_findings: true,
            fact_gap_filter: FactGapFilter::All,
            run_verdict: false,
            checker: Checker::None,
            note: None,
            sensitive,
        }
    }

    #[test]
    fn a_task_goes_to_the_list_in_at_ship_and_reads_the_quarantine_in_light_and_full_sensitive_or_not(
    ) {
        use super::reads_quarantine;
        for mode in TestingMode::ALL {
            for sensitive in [false, true] {
                // `sensitive` is only ever set in a mode that tests, as `gates_for_with` sets it.
                let sensitive = sensitive && mode != TestingMode::Off;
                let chosen = plan(mode, sensitive, false);
                assert_eq!(
                    applies(chosen.mode, chosen.as_today),
                    mode == TestingMode::AtShip,
                    "{mode:?} sensitive={sensitive}"
                );
                assert_eq!(
                    reads_quarantine(&chosen),
                    matches!(mode, TestingMode::Light | TestingMode::Full),
                    "{mode:?} sensitive={sensitive}"
                );
                // One way or neither: a task never both lists a failure and reads a quarantine for it.
                assert!(
                    !(applies(chosen.mode, chosen.as_today) && reads_quarantine(&chosen)),
                    "{mode:?}"
                );
                // A task that changed nothing keeps its round.
                let nothing = plan(mode, false, true);
                assert!(
                    !applies(nothing.mode, nothing.as_today) && !reads_quarantine(&nothing),
                    "{mode:?}"
                );
            }
        }
    }

    #[test]
    fn the_list_is_for_at_ship_only() {
        assert!(applies(TestingMode::AtShip, false));
        for mode in [TestingMode::Light, TestingMode::Full, TestingMode::Off] {
            assert!(!applies(mode, false), "{mode:?}");
        }
        assert!(
            !applies(TestingMode::AtShip, true),
            "a task that changed nothing keeps its round"
        );
    }
}

/// A temporary folder for a test, removed when it goes out of scope.
#[cfg(test)]
pub(crate) mod testing {
    use std::path::{Path, PathBuf};

    pub struct Temp(PathBuf);

    impl Temp {
        pub fn new() -> Temp {
            let path = std::env::temp_dir().join(format!("test-debt-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("a temp folder");
            Temp(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
