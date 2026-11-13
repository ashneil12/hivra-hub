//! PT-4: the ship check's "End-to-end" step, for a project with a screen.
//!
//! A project has a screen when the Verify plugin's detection says it is a web or mobile app (`plugins::verify::surfaces_of`)
//! or it has Playwright installed. For such a project the ship check runs, in order of preference:
//!
//! 1. the Verify plugin's replay, `npx e2e run --strict-cache`, when the project has `e2e` installed (no model call);
//! 2. else the project's Playwright suite scoped to the range, `npx playwright test --only-changed={base}`.
//!
//! Both go through the same sandboxed runner the proof tools use (`proof_tools::run`), so a command, its time limit and its
//! environment are the ones PT-1 already vets. Honest by construction, like every step here:
//!
//! - a project with a screen and neither route: "could not run", with the finding "No end-to-end check is available for this
//!   project." on the step. Never a pass, so the ship check can't pass and the "ready to ship" hold keeps holding;
//! - a project with no screen: "not run: no screen to test". Not a finding;
//! - a route the person switched off in Settings (PT-2) and no other: "not run: switched off for this project", the person's
//!   own choice, not a finding, and named under "Not tested";
//! - a checkout that isn't what HEAD is, a tool that didn't start, timed out, ran nothing or failed: "could not run" or
//!   "failed", with what it printed.
//!
//! "No testing" (`off`) has no tests at all, so no step.

use std::collections::BTreeSet;
use std::path::Path;

use crate::delivery::settings::TestingMode;
use crate::proof_tools::{
    catalogue,
    detect::{self, Detection, Found},
    Outcome as Ran, Tool, ToolRun,
};

use super::{Outcome, Stage, Step, TAIL_MAX};

/// The step's name, in the record the person reads.
pub(super) const NAME: &str = "End-to-end";
/// The step's detail for a project with no screen. The hold reads it: this one "did not run" is not a failure to run.
pub(super) const NO_SCREEN: &str = "no screen to test";
/// The finding for a project with a screen and no way to run an end-to-end check.
pub(super) const NO_ROUTE: &str = "No end-to-end check is available for this project.";
/// The step's detail when the person switched every end-to-end tool the project has off. Their choice: the hold reads it too.
pub(super) const SWITCHED_OFF: &str = "switched off for this project";

const VERIFY_TOOL: &str = "e2e";
const PLAYWRIGHT_TOOL: &str = "playwright";

/// Whether this testing mode has the step: every mode that tests anything.
pub(super) fn wanted(mode: TestingMode) -> bool {
    mode != TestingMode::Off
}

/// Whether the project has one end-to-end tool, and whether it may be used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Have {
    /// The project doesn't have it.
    Missing,
    /// It has it, and the person switched it off for the project.
    Off,
    /// It has it, and it is on.
    Ready,
}

/// What the project is, as far as this step cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Routes {
    pub screen: bool,
    pub verify: Have,
    pub playwright: Have,
}

/// Reads the project at `root`. `off` is the set of tools the person switched off for it. Only files are read: the two tools'
/// "installed" rules are a package and a config file, never a program.
pub(super) fn routes_in(root: &Path, off: &BTreeSet<String>) -> Routes {
    let facts = detect::Facts::read(root);
    let have = |id: &str| match catalogue::find(id) {
        Some(tool) if detect::eval(&tool.installed, &facts, &detect::NoProbe) => {
            if off.contains(id) {
                Have::Off
            } else {
                Have::Ready
            }
        }
        _ => Have::Missing,
    };
    let verify = have(VERIFY_TOOL);
    let playwright = have(PLAYWRIGHT_TOOL);
    Routes {
        screen: !crate::plugins::verify::surfaces_of(root).is_empty()
            || playwright != Have::Missing,
        verify,
        playwright,
    }
}

/// The tool to run: the Verify plugin's replay when the project has it on, else Playwright. None: there is no route.
fn route_of(routes: &Routes) -> Option<&'static Tool> {
    if routes.verify == Have::Ready {
        catalogue::find(VERIFY_TOOL)
    } else if routes.playwright == Have::Ready {
        catalogue::find(PLAYWRIGHT_TOOL)
    } else {
        None
    }
}

fn not_run(detail: &str, line: Option<String>) -> Stage {
    Stage {
        steps: vec![Step::new(NAME, Outcome::NotRun, detail)],
        not_tested: line.into_iter().collect(),
    }
}

/// A project with a screen and no end-to-end tool: a finding, and the step could not run.
fn no_route() -> Stage {
    let mut step = Step::new(NAME, Outcome::CouldNotRun, NO_ROUTE);
    step.output_tail = Some(NO_ROUTE.to_string());
    Stage::one(step)
}

/// The checkout isn't what HEAD is, so a tool reading the files on disk would test something else.
fn not_clean(files: Option<usize>, head: &str) -> Stage {
    let what = match files {
        Some(1) => "the checkout has 1 uncommitted change".to_string(),
        Some(count) => format!("the checkout has {count} uncommitted changes"),
        None => "the checkout's changes couldn't be read".to_string(),
    };
    Stage::one(Step::new(
        NAME,
        Outcome::CouldNotRun,
        format!("{what}, so the end-to-end run would test something that is not {head}"),
    ))
}

/// One run of the chosen tool as the step. A run that had nothing to do is "could not run" here: for a project with a screen
/// "nothing was exercised" must never read as a pass or as neutral.
fn stage_of(run: &ToolRun) -> Stage {
    let (outcome, detail) = match run.outcome {
        Ran::Passed => (Outcome::Passed, run.detail.clone()),
        Ran::Failed => (Outcome::Failed, run.detail.clone()),
        Ran::CouldNotRun => (Outcome::CouldNotRun, run.detail.clone()),
        Ran::NotRun => (
            Outcome::CouldNotRun,
            format!("it had nothing to run for these commits ({})", run.detail),
        ),
    };
    let mut step = Step::new(NAME, outcome, format!("{}: {detail}", run.tool.name));
    step.command = run.command.clone();
    if matches!(outcome, Outcome::Failed | Outcome::CouldNotRun) {
        let found: Vec<String> = std::iter::once(format!("{}: {detail}", run.tool.name))
            .chain(run.lines.iter().map(|line| format!("  {line}")))
            .collect();
        let mut text = found.join("\n");
        if let Some(tail) = run.tail.as_deref().filter(|tail| !tail.trim().is_empty()) {
            text.push('\n');
            text.push_str(tail);
        }
        step.output_tail = Some(crate::gates::tail(&text, TAIL_MAX)).filter(|t| !t.is_empty());
    }
    Stage::one(step)
}

/// The whole step, as the ship check decides it. `clean` is `Ok` when the checkout is what HEAD is, else how many files differ
/// (none when they couldn't be counted). `routes` is read first (files only); `run` is asked only when there is a screen, a
/// route and a clean checkout, so a project without one never starts a tool.
pub(super) fn step(
    mode: TestingMode,
    clean: Result<(), Option<usize>>,
    head: &str,
    routes: impl FnOnce() -> Routes,
    run: impl FnOnce(&'static Tool) -> Option<ToolRun>,
) -> Stage {
    if !wanted(mode) {
        return Stage::default();
    }
    let routes = routes();
    if !routes.screen {
        return not_run(NO_SCREEN, None);
    }
    let Some(tool) = route_of(&routes) else {
        // The person's own switch is a choice, not a missing tool: named under "Not tested", never a finding.
        if routes.verify == Have::Off || routes.playwright == Have::Off {
            return not_run(
                SWITCHED_OFF,
                Some(
                    "The end-to-end tools this project has are switched off for it. Turn one on in Settings, under Proof tools, to run it."
                        .to_string(),
                ),
            );
        }
        return no_route();
    };
    if let Err(files) = clean {
        return not_clean(files, head);
    }
    match run(tool) {
        Some(ran) => stage_of(&ran),
        None => Stage::one(Step::new(
            NAME,
            Outcome::CouldNotRun,
            format!("{} did not run", tool.name),
        )),
    }
}

/// Whether a saved step is the end-to-end step reading as "passed for this version": it passed, or it did not apply (no screen)
/// or the person switched its tools off. Anything else (a failure, a run that could not happen, a screen with no check, a
/// step that did not run for another reason) is not. The "ready to ship" hold reads this through `passed_for_in`.
pub(super) fn step_holds(step: &Step) -> bool {
    step.name != NAME
        || match step.outcome {
            Outcome::Passed => true,
            Outcome::NotRun => step.detail == NO_SCREEN || step.detail == SWITCHED_OFF,
            Outcome::Failed | Outcome::CouldNotRun => false,
        }
}

/// The tool run for `tool` (a test seam: the `Detection` the shared runner takes, holding only the chosen tool).
pub(super) fn only(tool: &'static Tool) -> Detection {
    Detection {
        stacks: Vec::new(),
        fitting: vec![Found {
            tool,
            installed: true,
        }],
        off: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn run_of(id: &str, outcome: Ran, detail: &str, lines: &[&str]) -> ToolRun {
        ToolRun {
            tool: catalogue::find(id).unwrap(),
            outcome,
            detail: detail.into(),
            lines: lines.iter().map(|line| line.to_string()).collect(),
            command: catalogue::find(id).unwrap().run.clone(),
            tail: None,
            seconds: 0.0,
        }
    }

    fn routes(screen: bool, verify: Have, playwright: Have) -> Routes {
        Routes {
            screen,
            verify,
            playwright,
        }
    }

    /// Runs the step with the given routes and a runner that records which tool it was asked for.
    fn go(
        mode: TestingMode,
        clean: Result<(), Option<usize>>,
        routes: Routes,
        ran: Option<ToolRun>,
    ) -> (Stage, Vec<String>) {
        let asked = std::cell::RefCell::new(Vec::new());
        let stage = step(
            mode,
            clean,
            "abc1234",
            || routes,
            |tool| {
                asked.borrow_mut().push(tool.id.clone());
                ran
            },
        );
        (stage, asked.into_inner())
    }

    #[test]
    fn the_verify_replay_is_preferred_when_the_project_has_it() {
        let (stage, asked) = go(
            TestingMode::AtShip,
            Ok(()),
            routes(true, Have::Ready, Have::Ready),
            Some(run_of(
                "e2e",
                Ran::Passed,
                "the plain-English tests replayed and passed with no model call",
                &[],
            )),
        );
        assert_eq!(asked, ["e2e"], "Playwright is only the fallback");
        assert_eq!(stage.steps.len(), 1);
        assert_eq!(stage.steps[0].name, "End-to-end");
        assert_eq!(stage.steps[0].outcome, Outcome::Passed);
        assert_eq!(
            stage.steps[0].command.as_deref(),
            Some("npx e2e run --strict-cache")
        );
        assert!(
            stage.steps[0].detail.starts_with("e2e: "),
            "{}",
            stage.steps[0].detail
        );
    }

    #[test]
    fn playwright_scoped_to_the_range_is_the_fallback() {
        for verify in [Have::Missing, Have::Off] {
            let (stage, asked) = go(
                TestingMode::Light,
                Ok(()),
                routes(true, verify, Have::Ready),
                Some(run_of("playwright", Ran::Passed, "3 passed", &[])),
            );
            assert_eq!(asked, ["playwright"], "{verify:?}");
            assert_eq!(stage.steps[0].outcome, Outcome::Passed);
            assert_eq!(
                stage.steps[0].command.as_deref(),
                Some("npx playwright test --only-changed={base}")
            );
        }
    }

    #[test]
    fn a_screen_with_no_route_is_a_visible_finding_and_could_not_run_never_a_pass() {
        let (stage, asked) = go(
            TestingMode::AtShip,
            Ok(()),
            routes(true, Have::Missing, Have::Missing),
            None,
        );
        assert!(asked.is_empty(), "nothing is started");
        assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
        assert_eq!(
            stage.steps[0].detail,
            "No end-to-end check is available for this project."
        );
        // The finding is on the step the person opens, not only in a list.
        assert_eq!(
            stage.steps[0].output_tail.as_deref(),
            Some("No end-to-end check is available for this project.")
        );
        assert_eq!(super::super::aggregate(&stage.steps), Outcome::CouldNotRun);
        // Even beside a step that passed, the whole check is not a pass.
        let mut all = vec![Step::new("Project checks", Outcome::Passed, "ran")];
        all.extend(stage.steps);
        assert_eq!(super::super::aggregate(&all), Outcome::CouldNotRun);
    }

    #[test]
    fn a_project_with_no_screen_did_not_run_and_that_is_not_a_finding() {
        let (stage, asked) = go(
            TestingMode::AtShip,
            Err(Some(3)),
            routes(false, Have::Missing, Have::Missing),
            None,
        );
        assert!(asked.is_empty());
        assert_eq!(stage.steps[0].outcome, Outcome::NotRun);
        assert_eq!(stage.steps[0].detail, "no screen to test");
        assert!(stage.steps[0].output_tail.is_none(), "not a finding");
        // A step that did not apply never stops a pass that the other steps earned.
        let all = vec![
            Step::new("Project checks", Outcome::Passed, "ran"),
            stage.steps[0].clone(),
        ];
        assert_eq!(super::super::aggregate(&all), Outcome::Passed);
        assert!(step_holds(&stage.steps[0]));
    }

    #[test]
    fn a_route_the_person_switched_off_is_their_choice_not_a_finding() {
        let (stage, asked) = go(
            TestingMode::AtShip,
            Ok(()),
            routes(true, Have::Off, Have::Off),
            None,
        );
        assert!(asked.is_empty());
        assert_eq!(stage.steps[0].outcome, Outcome::NotRun);
        assert_eq!(stage.steps[0].detail, "switched off for this project");
        assert!(stage.steps[0].output_tail.is_none());
        assert_eq!(stage.not_tested.len(), 1);
        assert!(
            stage.not_tested[0].contains("switched off"),
            "{:?}",
            stage.not_tested
        );
        assert!(step_holds(&stage.steps[0]));
        // One tool off and the other missing is the same: the person's switch, not a missing check.
        let (mixed, _) = go(
            TestingMode::AtShip,
            Ok(()),
            routes(true, Have::Off, Have::Missing),
            None,
        );
        assert_eq!(mixed.steps[0].detail, "switched off for this project");
    }

    #[test]
    fn a_failing_or_stalled_run_fails_or_could_not_run_with_what_it_printed() {
        let (failed, _) = go(
            TestingMode::AtShip,
            Ok(()),
            routes(true, Have::Ready, Have::Missing),
            Some(run_of(
                "e2e",
                Ran::Failed,
                "its tests failed (exit 1)",
                &["Checkout flow: step 3 failed"],
            )),
        );
        assert_eq!(failed.steps[0].outcome, Outcome::Failed);
        assert!(failed.steps[0]
            .output_tail
            .as_deref()
            .unwrap()
            .contains("Checkout flow: step 3 failed"));
        assert!(!step_holds(&failed.steps[0]));

        let (stalled, _) = go(
            TestingMode::AtShip,
            Ok(()),
            routes(true, Have::Missing, Have::Ready),
            Some(run_of(
                "playwright",
                Ran::CouldNotRun,
                "there is no earlier revision to compare the change with",
                &[],
            )),
        );
        assert_eq!(stalled.steps[0].outcome, Outcome::CouldNotRun);
        assert!(!step_holds(&stalled.steps[0]));
        assert_eq!(
            super::super::aggregate(&stalled.steps),
            Outcome::CouldNotRun
        );
    }

    #[test]
    fn a_run_with_nothing_to_do_on_a_screen_is_could_not_run_never_neutral() {
        let (stage, _) = go(
            TestingMode::AtShip,
            Ok(()),
            routes(true, Have::Missing, Have::Ready),
            Some(run_of("playwright", Ran::NotRun, "no changed test", &[])),
        );
        assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
        assert!(
            stage.steps[0].detail.contains("nothing to run"),
            "{}",
            stage.steps[0].detail
        );
    }

    #[test]
    fn a_checkout_that_is_not_what_head_is_could_not_run_and_starts_nothing() {
        for (files, word) in [
            (Some(1), "1 uncommitted change,"),
            (Some(4), "4 uncommitted changes"),
            (None, "couldn't be read"),
        ] {
            let (stage, asked) = go(
                TestingMode::AtShip,
                Err(files),
                routes(true, Have::Ready, Have::Ready),
                None,
            );
            assert!(asked.is_empty());
            assert_eq!(stage.steps[0].outcome, Outcome::CouldNotRun);
            assert!(
                stage.steps[0].detail.contains(word),
                "{}",
                stage.steps[0].detail
            );
        }
    }

    #[test]
    fn no_testing_has_no_step_and_reads_nothing() {
        let read = Cell::new(false);
        let stage = step(
            TestingMode::Off,
            Ok(()),
            "abc1234",
            || {
                read.set(true);
                routes(true, Have::Ready, Have::Ready)
            },
            |_| None,
        );
        assert!(stage.steps.is_empty());
        assert!(
            !read.get(),
            "a mode without the step never reads the project"
        );
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            assert!(wanted(mode), "{mode:?}");
        }
    }

    #[test]
    fn a_saved_step_holds_only_when_it_passed_or_did_not_apply() {
        let held = |outcome, detail: &str| step_holds(&Step::new(NAME, outcome, detail));
        assert!(held(Outcome::Passed, "e2e: replayed"));
        assert!(held(Outcome::NotRun, "no screen to test"));
        assert!(held(Outcome::NotRun, "switched off for this project"));
        assert!(!held(Outcome::NotRun, "something else did not run"));
        assert!(!held(Outcome::Failed, "e2e: failed"));
        assert!(!held(Outcome::CouldNotRun, NO_ROUTE));
        // Any other step is none of this rule's business, and a record from before this step has none.
        assert!(step_holds(&Step::new("Review", Outcome::Passed, "ok")));
        assert!(step_holds(&Step::new(
            "Proof tools",
            Outcome::NotRun,
            "none available"
        )));
    }

    // ---- reading the project -----------------------------------------------------------------------------------------

    struct Tmp(std::path::PathBuf);

    impl Tmp {
        fn new(files: &[(&str, &str)]) -> Tmp {
            let dir = std::env::temp_dir().join(format!("hivra pt4 e2e {}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            for (name, text) in files {
                let path = dir.join(name);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, text).unwrap();
            }
            Tmp(dir)
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn off(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn a_web_app_has_a_screen_and_a_project_with_neither_surface_nor_playwright_does_not() {
        let web = Tmp::new(&[(
            "package.json",
            r#"{"dependencies":{"vite":"6","react":"19"}}"#,
        )]);
        let found = routes_in(&web.0, &off(&[]));
        assert!(found.screen);
        assert_eq!(
            (found.verify, found.playwright),
            (Have::Missing, Have::Missing)
        );

        let library = Tmp::new(&[("package.json", r#"{"dependencies":{"left-pad":"1"}}"#)]);
        assert!(!routes_in(&library.0, &off(&[])).screen);
        let empty = Tmp::new(&[]);
        assert!(!routes_in(&empty.0, &off(&[])).screen);
    }

    #[test]
    fn a_desktop_shell_is_not_a_screen_unless_it_has_playwright() {
        let shell = Tmp::new(&[
            (
                "package.json",
                r#"{"dependencies":{"vite":"6","@tauri-apps/api":"2"}}"#,
            ),
            ("src-tauri/tauri.conf.json", "{}"),
        ]);
        assert!(!routes_in(&shell.0, &off(&[])).screen);
        let with_playwright = Tmp::new(&[
            (
                "package.json",
                r#"{"devDependencies":{"@playwright/test":"1.65.0"}}"#,
            ),
            ("playwright.config.ts", "export default {};\n"),
            ("src-tauri/tauri.conf.json", "{}"),
        ]);
        let found = routes_in(&with_playwright.0, &off(&[]));
        assert!(found.screen, "Playwright installed is a screen");
        assert_eq!(found.playwright, Have::Ready);
    }

    #[test]
    fn both_routes_are_read_from_the_project_and_the_switch_turns_one_off() {
        let both = Tmp::new(&[
            (
                "package.json",
                r#"{"dependencies":{"vite":"6"},"devDependencies":{"e2e":"0.23.0","@playwright/test":"1.65.0"}}"#,
            ),
            ("e2e.config.ts", "export default {};\n"),
            ("playwright.config.ts", "export default {};\n"),
        ]);
        let on = routes_in(&both.0, &off(&[]));
        assert_eq!((on.verify, on.playwright), (Have::Ready, Have::Ready));
        assert_eq!(route_of(&on).unwrap().id, "e2e");
        let verify_off = routes_in(&both.0, &off(&["e2e"]));
        assert_eq!(
            (verify_off.verify, verify_off.playwright),
            (Have::Off, Have::Ready)
        );
        assert_eq!(route_of(&verify_off).unwrap().id, "playwright");
        let all_off = routes_in(&both.0, &off(&["e2e", "playwright"]));
        assert!(route_of(&all_off).is_none());
        // The package alone is not "installed": it needs its config or a spec file too.
        let package_only = Tmp::new(&[(
            "package.json",
            r#"{"dependencies":{"vite":"6"},"devDependencies":{"e2e":"0.23.0"}}"#,
        )]);
        assert_eq!(routes_in(&package_only.0, &off(&[])).verify, Have::Missing);
    }

    #[test]
    fn the_shared_runner_is_handed_only_the_chosen_tool() {
        let detection = only(catalogue::find("playwright").unwrap());
        assert_eq!(detection.installed().len(), 1);
        assert_eq!(detection.installed()[0].id, "playwright");
        assert!(detection.off.is_empty());
    }
}
