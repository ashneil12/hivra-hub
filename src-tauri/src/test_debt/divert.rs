//! PT-5: what a finished task's failing tests mean for its round, in `at-ship` mode. Pure: the caller reads the transcript's
//! test runs, the app's own `run_checks` records and the logs, and this says which failures are the task's own (they fail the
//! round, as a failed check always did), which are another task's or an old break (they go to the test debt list, and the task is
//! not sent back for them) and which are quarantined (reported, never blocking).
//!
//! Two sources of failing tests, both the app's own reading, never the worker's word:
//! - the transcript's test runs (`FactRun`: the command and the end of its output), whose latest run of each command decides;
//! - the `run_checks` records, whose latest record of each command decides unless a later green run covers it.
//!
//! A failed-check gap (`A check failed this turn (<command>).`) is dropped only when the run's red output names every failing test
//! and none is the task's own. A run whose output was cut before it named them all keeps its gap: the unknown goes the old way.
//! A failure that is not a test at all (a build error, a lint) is not here: its gap stays whatever this says.

use std::collections::HashSet;

use crate::firstmate::fact_gaps::{self, FactRun};
use crate::run_checks::{Record, AFFECTED_ID};
use crate::test_summary::{self, Failure, TestOutcome};

use super::own::{self, Failing};

pub struct Evidence<'a> {
    pub runs: &'a [FactRun],
    /// The app's own record of each `run_checks` run, oldest first.
    pub records: &'a [Record],
    /// The paths the task's copy changed, checkout-relative.
    pub changed: &'a [String],
    /// The repository's tracked files.
    pub tracked: &'a [String],
    /// A record's log, when it is still there.
    pub read_log: &'a dyn Fn(&str) -> Option<String>,
    /// A tracked file's text.
    pub read_file: &'a dyn Fn(&str) -> Option<String>,
    /// Whether a test id is quarantined right now.
    pub quarantined: &'a dyn Fn(&str) -> bool,
}

#[derive(Debug, Default)]
pub struct Plan {
    /// The task's own failing tests: they fail the round.
    pub own: Vec<Failing>,
    /// Another task's or an old break: they go to the list.
    pub foreign: Vec<Failing>,
    /// Quarantined: reported, never blocking, never listed.
    pub quarantined: Vec<Failing>,
    /// Failed-check gap sentences to drop: the run failed only on tests that are not the task's own.
    pub clear_gaps: Vec<String>,
    /// Gap sentences to add: a `run_checks` run that ended red on the task's own tests, or on tests that could not all be read.
    pub add_gaps: Vec<String>,
}

/// The runs a gap could name: the latest of each command, in the order they were last run.
fn latest_runs(runs: &[FactRun]) -> Vec<&FactRun> {
    let mut kept: Vec<&FactRun> = Vec::new();
    for run in runs {
        kept.retain(|earlier| earlier.command.trim() != run.command.trim());
        kept.push(run);
    }
    kept
}

/// Whether a green run looked at everything a red one did: the project's `affected` command runs only the tests for the files it was
/// given, so a later green run of it covers an earlier red one only when its files include all of the earlier run's.
fn covers_scope(green: &Record, red: &Record) -> bool {
    red.changed_files.iter().all(|path| {
        let path = own::norm(path);
        green
            .changed_files
            .iter()
            .any(|other| own::norm(other) == path)
    })
}

/// The records that are still red. Per command, in the order they were run: a red run is live until a later green run of the same
/// command covers it (a green `affected` run only when it covered the same files); a run that decided nothing (a timeout, no
/// summary) is no evidence either way and neither clears a red run nor makes one. A green run of a different command never does: it
/// may have looked at other tests altogether.
fn live_red(records: &[Record]) -> Vec<&Record> {
    let mut commands: Vec<&str> = Vec::new();
    for record in records {
        if !commands.contains(&record.command.as_str()) {
            commands.push(record.command.as_str());
        }
    }
    let mut live = Vec::new();
    for command in commands {
        let mut red: Option<&Record> = None;
        for record in records.iter().filter(|r| r.command == command) {
            match record.outcome {
                TestOutcome::Red => red = Some(record),
                TestOutcome::Green => {
                    if let Some(earlier) = red {
                        if command != AFFECTED_ID || covers_scope(record, earlier) {
                            red = None;
                        }
                    }
                }
                TestOutcome::Inconclusive => {}
            }
        }
        live.extend(red);
    }
    live
}

fn rust_files(tracked: &[String]) -> Vec<String> {
    tracked
        .iter()
        .filter(|path| path.ends_with(".rs"))
        .cloned()
        .collect()
}

/// The failing tests a record names: from its log when the log is still there and names at least as many as the record counted,
/// else from the names the record kept (at most 20).
fn failing_of_record(record: &Record, e: &Evidence, rust: &[String]) -> (Vec<Failing>, bool) {
    if !record.log.is_empty() {
        if let Some(log) = (e.read_log)(&record.log) {
            let named = test_summary::failures(&log);
            if !named.is_empty() && named.len() as u64 >= record.failed {
                let runner = test_summary::parse(&log).map(|summary| summary.runner);
                return (
                    own::from_failures(runner, &record.command, &named, rust),
                    true,
                );
            }
        }
    }
    let named: Vec<Failure> = record
        .failing
        .iter()
        .map(|name| Failure {
            name: name.clone(),
            message: String::new(),
        })
        .collect();
    let complete = !named.is_empty() && named.len() as u64 >= record.failed;
    (
        own::from_failures(None, &record.command, &named, rust),
        complete,
    )
}

fn names(list: &[&Failing]) -> String {
    let shown: Vec<String> = list
        .iter()
        .take(3)
        .map(|f| f.name.chars().take(80).collect::<String>())
        .collect();
    let more = list.len().saturating_sub(3);
    if more > 0 {
        format!("{} and {more} more", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

pub fn plan(e: &Evidence) -> Plan {
    let rust = rust_files(e.tracked);
    let mut plan = Plan::default();
    let mut seen: HashSet<String> = HashSet::new();

    // Sorts one run's failing tests. Returns the ones that are the task's own (also when an earlier source already named them).
    let mut sort = |failing: Vec<Failing>, plan: &mut Plan| -> Vec<Failing> {
        let mut mine = Vec::new();
        for f in failing {
            let is_own = own::is_own(&f, e.changed, e.tracked, e.read_file);
            let first = seen.insert(f.id());
            if is_own {
                // A quarantine never excuses a test the task itself changed or covers: its failure is a signal.
                mine.push(f.clone());
                if first {
                    plan.own.push(f);
                }
            } else if (e.quarantined)(&f.id()) {
                if first {
                    plan.quarantined.push(f);
                }
            } else if first {
                plan.foreign.push(f);
            }
        }
        mine
    };

    // A gap is dropped only when EVERY run that makes that sentence is eligible: two long commands that share their first 80
    // characters read as one sentence, and one of them being fine must not clear the other's gap.
    let mut eligible: Vec<String> = Vec::new();
    let mut keep: HashSet<String> = HashSet::new();
    for run in latest_runs(e.runs) {
        let sentence = fact_gaps::failed_check_gap_for(&run.command);
        let classified = test_summary::classify(&run.output);
        // Failures are read whatever the last summary line says: output that ran two runners, or a green summary after a red one,
        // still names what failed.
        let named = test_summary::failures(&run.output);
        let red = classified.outcome == TestOutcome::Red;
        let summary = classified.summary;
        if !red && named.is_empty() {
            // Green, or not a test failure at all (a build error, a lint): whatever gap this command has stays.
            keep.insert(sentence);
            continue;
        }
        let failing = own::from_failures(summary.map(|s| s.runner), &run.command, &named, &rust);
        let complete =
            red && summary.is_some_and(|s| !named.is_empty() && named.len() as u64 >= s.failed);
        let mine = sort(failing, &mut plan);
        if !mine.is_empty() {
            // The task's own failing test fails the round even when the fact layer saw no failed check (a run that exited 0, or
            // whose status it could not read): the gap is made here.
            plan.add_gaps.push(sentence.clone());
            keep.insert(sentence);
        } else if complete {
            eligible.push(sentence);
        } else {
            keep.insert(sentence);
        }
    }
    for sentence in eligible {
        if !keep.contains(&sentence) && !plan.clear_gaps.contains(&sentence) {
            plan.clear_gaps.push(sentence);
        }
    }

    for record in live_red(e.records) {
        let (failing, complete) = failing_of_record(record, e, &rust);
        let mine = sort(failing, &mut plan);
        if !mine.is_empty() || !complete {
            let detail = if mine.is_empty() {
                "some of the failing tests could not be read".to_string()
            } else {
                names(&mine.iter().collect::<Vec<_>>())
            };
            plan.add_gaps.push(format!(
                "A check failed this turn (run_checks {}): {detail}.",
                record.command
            ));
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAIL_OTHER: &str = " FAIL  src/other.test.ts > suite > works\nAssertionError: expected 1 to be 2\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";
    const FAIL_A: &str = " FAIL  src/a.test.ts > suite > works\nAssertionError: expected 1 to be 2\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";
    const FAIL_BOTH: &str = " FAIL  src/a.test.ts > suite > works\nAssertionError: nope\n\u{23af}\u{23af}\u{23af}\u{23af}\n FAIL  src/other.test.ts > suite > works\nAssertionError: nope\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  2 failed (2)\n      Tests  2 failed | 1 passed (3)\n";
    const GREEN: &str = " Test Files  3 passed (3)\n      Tests  9 passed (9)\n";

    fn run(command: &str, output: &str, at: f64) -> FactRun {
        FactRun {
            command: command.into(),
            at,
            output: output.into(),
        }
    }

    fn record(command: &str, outcome: TestOutcome, failing: &[&str], at: u64) -> Record {
        Record {
            at,
            command: command.into(),
            outcome,
            total: 3,
            failed: failing.len() as u64,
            changed_files_fingerprint: String::new(),
            changed_files: Vec::new(),
            failing: failing.iter().map(|s| (*s).to_string()).collect(),
            log: String::new(),
        }
    }

    fn plan_of(
        runs: &[FactRun],
        records: &[Record],
        changed: &[&str],
        quarantined: &[&str],
    ) -> Plan {
        let changed: Vec<String> = changed.iter().map(|s| (*s).to_string()).collect();
        let quarantined: Vec<String> = quarantined.iter().map(|s| (*s).to_string()).collect();
        plan(&Evidence {
            runs,
            records,
            changed: &changed,
            tracked: &[],
            read_log: &|_| None,
            read_file: &|_| None,
            quarantined: &|id| quarantined.iter().any(|q| id.contains(q.as_str())),
        })
    }

    #[test]
    fn a_failure_in_a_test_the_task_did_not_touch_goes_to_the_list_and_its_gap_is_dropped() {
        let runs = [run("npx vitest run", FAIL_OTHER, 1.0)];
        let p = plan_of(&runs, &[], &["src/feature.ts"], &[]);
        assert!(p.own.is_empty());
        assert_eq!(p.foreign.len(), 1);
        assert_eq!(p.foreign[0].file, "src/other.test.ts");
        assert_eq!(
            p.clear_gaps,
            vec![fact_gaps::failed_check_gap_for("npx vitest run")]
        );
        assert!(p.add_gaps.is_empty());
    }

    #[test]
    fn a_task_cannot_hide_a_failure_in_its_own_tests_behind_the_list() {
        // It changed src/a.ts and src/a.test.ts fails: the round still fails and the test is not listed.
        let runs = [run("npx vitest run", FAIL_A, 1.0)];
        let p = plan_of(&runs, &[], &["src/a.ts"], &[]);
        assert_eq!(p.own.len(), 1);
        assert_eq!(p.own[0].file, "src/a.test.ts");
        assert!(
            p.foreign.is_empty(),
            "its own test is never put on the list"
        );
        assert!(p.clear_gaps.is_empty(), "the failed-check gap stays");
        // The same through a run_checks record.
        let records = [record(
            "affected",
            TestOutcome::Red,
            &["src/a.test.ts > suite > works"],
            5,
        )];
        let p = plan_of(&[], &records, &["src/a.ts"], &[]);
        assert_eq!(p.own.len(), 1);
        assert!(p.foreign.is_empty());
        assert_eq!(p.add_gaps.len(), 1);
        assert!(p.add_gaps[0].starts_with("A check failed this turn (run_checks affected)"));
        assert!(
            p.add_gaps[0].contains("src/a.test.ts > suite > works"),
            "{}",
            p.add_gaps[0]
        );
    }

    #[test]
    fn a_run_with_an_own_failure_and_a_foreign_one_keeps_its_gap_and_still_lists_the_foreign_one() {
        let runs = [run("npx vitest run", FAIL_BOTH, 1.0)];
        let p = plan_of(&runs, &[], &["src/a.ts"], &[]);
        assert_eq!(p.own.len(), 1);
        assert_eq!(p.foreign.len(), 1);
        assert!(p.clear_gaps.is_empty());
    }

    #[test]
    fn a_run_whose_output_was_cut_before_it_named_every_failure_keeps_its_gap() {
        // The summary says 3 failed; the kept output names one.
        let cut = " FAIL  src/other.test.ts > suite > works\nboom\n Test Files  3 failed (3)\n      Tests  3 failed | 0 passed (3)\n";
        let p = plan_of(
            &[run("npx vitest run", cut, 1.0)],
            &[],
            &["src/feature.ts"],
            &[],
        );
        assert!(p.clear_gaps.is_empty(), "the unknown goes the old way");
        assert_eq!(p.foreign.len(), 1, "what was named is still listed");
    }

    #[test]
    fn only_the_latest_run_of_a_command_counts() {
        let runs = [
            run("npx vitest run", FAIL_OTHER, 1.0),
            run("npx vitest run", GREEN, 2.0),
        ];
        let p = plan_of(&runs, &[], &["src/feature.ts"], &[]);
        assert!(p.foreign.is_empty() && p.own.is_empty() && p.clear_gaps.is_empty());
    }

    #[test]
    fn a_failure_that_is_not_a_test_leaves_its_gap_alone() {
        let build_error = "error[E0432]: unresolved import\nerror: could not compile `x`\n";
        let p = plan_of(
            &[run("cargo test", build_error, 1.0)],
            &[],
            &["src/a.rs"],
            &[],
        );
        assert!(p.clear_gaps.is_empty() && p.foreign.is_empty() && p.own.is_empty());
    }

    #[test]
    fn a_quarantined_foreign_test_is_reported_not_listed_and_does_not_block() {
        let runs = [run("npx vitest run", FAIL_OTHER, 1.0)];
        let p = plan_of(&runs, &[], &["src/feature.ts"], &["src/other.test.ts"]);
        assert!(p.foreign.is_empty());
        assert_eq!(p.quarantined.len(), 1);
        assert_eq!(p.clear_gaps.len(), 1, "it does not block");
    }

    #[test]
    fn a_quarantine_never_excuses_a_test_the_task_itself_changed() {
        let runs = [run("npx vitest run", FAIL_A, 1.0)];
        let p = plan_of(&runs, &[], &["src/a.test.ts"], &["src/a.test.ts"]);
        assert_eq!(p.own.len(), 1);
        assert!(p.quarantined.is_empty());
        assert!(p.clear_gaps.is_empty());
    }

    #[test]
    fn a_foreign_failure_in_a_run_checks_record_goes_to_the_list_and_adds_no_gap() {
        let records = [record(
            "affected",
            TestOutcome::Red,
            &["src/other.test.ts > suite > works"],
            5,
        )];
        let p = plan_of(&[], &records, &["src/feature.ts"], &[]);
        assert_eq!(p.foreign.len(), 1);
        assert!(p.own.is_empty() && p.add_gaps.is_empty());
    }

    fn scoped(mut r: Record, files: &[&str]) -> Record {
        r.changed_files = files.iter().map(|s| (*s).to_string()).collect();
        r
    }

    #[test]
    fn a_red_record_a_later_green_run_of_the_same_command_covers_is_not_a_failure() {
        let red = scoped(
            record(
                "affected",
                TestOutcome::Red,
                &["src/a.test.ts > suite > works"],
                5,
            ),
            &["src/a.ts"],
        );
        // The same command, run again over at least the same files, and green.
        let same = [
            red.clone(),
            scoped(
                record("affected", TestOutcome::Green, &[], 9),
                &["src/a.ts", "src/b.ts"],
            ),
        ];
        let p = plan_of(&[], &same, &["src/a.ts"], &[]);
        assert!(p.own.is_empty() && p.add_gaps.is_empty() && p.foreign.is_empty());
        // A declared check that is not the scoped one needs no scope: it ran the same suite.
        let check = [
            record(
                "check",
                TestOutcome::Red,
                &["src/a.test.ts > suite > works"],
                5,
            ),
            record("check", TestOutcome::Green, &[], 9),
        ];
        let p = plan_of(&[], &check, &["src/a.ts"], &[]);
        assert!(p.own.is_empty() && p.add_gaps.is_empty());
    }

    #[test]
    fn a_green_run_that_did_not_look_at_the_same_tests_does_not_clear_a_red_one() {
        let red = scoped(
            record(
                "affected",
                TestOutcome::Red,
                &["src/a.test.ts > suite > works"],
                5,
            ),
            &["src/a.ts"],
        );
        // `affected` run again over other files: it never ran a.test.ts.
        let elsewhere = [
            red.clone(),
            scoped(
                record("affected", TestOutcome::Green, &[], 9),
                &["src/feature.ts"],
            ),
        ];
        let p = plan_of(&[], &elsewhere, &["src/a.ts"], &[]);
        assert_eq!(p.own.len(), 1, "the task's own failing test is still red");
        assert_eq!(p.add_gaps.len(), 1);
        // Another command's green run proves nothing about this one.
        let other = [red.clone(), record("check", TestOutcome::Green, &[], 9)];
        assert_eq!(plan_of(&[], &other, &["src/a.ts"], &[]).own.len(), 1);
        // And a run that decided nothing (a timeout, no summary) neither clears a red one nor is one.
        let timed_out = [red, record("affected", TestOutcome::Inconclusive, &[], 9)];
        assert_eq!(plan_of(&[], &timed_out, &["src/a.ts"], &[]).own.len(), 1);
        let only_inconclusive = [record("affected", TestOutcome::Inconclusive, &[], 9)];
        assert!(plan_of(&[], &only_inconclusive, &["src/a.ts"], &[])
            .add_gaps
            .is_empty());
    }

    #[test]
    fn the_tasks_own_failing_test_makes_its_gap_even_when_the_fact_layer_saw_no_failed_check() {
        // The run's status was read as passed (or not read), but its output is red on the task's own test.
        let runs = [run("npx vitest run", FAIL_A, 1.0)];
        let p = plan_of(&runs, &[], &["src/a.ts"], &[]);
        assert_eq!(
            p.add_gaps,
            vec![fact_gaps::failed_check_gap_for("npx vitest run")]
        );
        assert!(p.clear_gaps.is_empty());
    }

    #[test]
    fn a_green_summary_after_a_red_one_in_the_same_output_does_not_hide_the_failure() {
        // Two runs chained in one command: the last summary is green, an own test failed in the first.
        let chained = format!("{FAIL_A}{GREEN}");
        let runs = [run(
            "npx vitest run src/a.test.ts ; npx vitest run src/b.test.ts",
            &chained,
            1.0,
        )];
        let p = plan_of(&runs, &[], &["src/a.ts"], &[]);
        assert_eq!(p.own.len(), 1);
        assert_eq!(p.add_gaps.len(), 1);
        // A foreign failure in it is still listed, but its gap is not cleared: the output cannot be trusted to name everything.
        let chained = format!("{FAIL_OTHER}{GREEN}");
        let runs = [run(
            "npx vitest run src/other.test.ts ; npx vitest run src/b.test.ts",
            &chained,
            1.0,
        )];
        let p = plan_of(&runs, &[], &["src/feature.ts"], &[]);
        assert_eq!(p.foreign.len(), 1);
        assert!(p.clear_gaps.is_empty());
    }

    #[test]
    fn two_long_commands_that_read_as_one_gap_do_not_clear_each_others() {
        let prefix = "npx vitest run --reporter=verbose --testTimeout=20000 --retry=0 --bail=0 --no-coverage ";
        let a = format!("{prefix}src/a.test.ts");
        let b = format!("{prefix}src/other.test.ts");
        assert_eq!(
            fact_gaps::failed_check_gap_for(&a),
            fact_gaps::failed_check_gap_for(&b),
            "the display is cut at 80"
        );
        // `a` fails on the task's own test, `b` on another task's: the one sentence must stay.
        let runs = [run(&a, FAIL_A, 1.0), run(&b, FAIL_OTHER, 2.0)];
        let p = plan_of(&runs, &[], &["src/a.ts"], &[]);
        assert!(p.clear_gaps.is_empty(), "{:?}", p.clear_gaps);
        assert_eq!(p.own.len(), 1);
    }

    #[test]
    fn a_red_record_whose_failing_tests_cannot_all_be_read_fails_the_round_rather_than_guess() {
        let mut r = record(
            "affected",
            TestOutcome::Red,
            &["src/other.test.ts > suite > works"],
            5,
        );
        r.failed = 25; // 20 names kept at most, and the log is gone
        let p = plan_of(&[], &[r], &["src/feature.ts"], &[]);
        assert_eq!(p.add_gaps.len(), 1);
        assert!(
            p.add_gaps[0].contains("could not be read"),
            "{}",
            p.add_gaps[0]
        );
    }

    #[test]
    fn a_test_seen_by_two_sources_is_sorted_once() {
        let runs = [run("npx vitest run", FAIL_OTHER, 1.0)];
        let records = [record(
            "affected",
            TestOutcome::Red,
            &["src/other.test.ts > suite > works"],
            5,
        )];
        let p = plan_of(&runs, &records, &["src/feature.ts"], &[]);
        assert_eq!(p.foreign.len(), 1);
    }

    #[test]
    fn the_gap_it_drops_is_the_sentence_the_fact_layer_makes() {
        let command = "npx vitest run src/other.test.ts";
        let turn = fact_gaps::FactTurn {
            checks: vec![fact_gaps::FactCheck {
                command: command.into(),
                status: "failed".into(),
                at: 3.0,
            }],
            ..Default::default()
        };
        let gaps = fact_gaps::done_gaps_in(&turn, None);
        assert!(
            gaps.contains(&fact_gaps::failed_check_gap_for(command)),
            "{gaps:?}"
        );
    }

    #[test]
    fn nothing_to_read_is_an_empty_plan() {
        let p = plan_of(&[], &[], &[], &[]);
        assert!(
            p.own.is_empty()
                && p.foreign.is_empty()
                && p.clear_gaps.is_empty()
                && p.add_gaps.is_empty()
        );
    }
}
