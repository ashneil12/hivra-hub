//! SC-3a: reads the summary line a test runner prints, so a step that ran zero tests is never read as a pass.
//!
//! `parse` takes the whole output of a check and answers with the counts of the LAST runner summary in it, or `None`
//! when nothing in it looks like one (a build or a lint step). Seven runners are read: vitest, cargo test, cargo
//! nextest, `node --test`, pytest, go test and Playwright. Colour codes and CRLF are stripped first.
//!
//! `total` is the number of tests that ran (passed + failed). Skipped, ignored, todo and deselected tests are counted
//! apart and are not in it, so a run where every test was skipped has `total == 0`: nothing was tested.
//!
//! Two runners print one line per binary or package, so their lines are summed: cargo test (every `test result:` line
//! of the run: the last one is usually the doc-tests, which run none) and go test (one line per package; without
//! `-v` Go does not print counts, so each package that ran tests counts as one: a lower bound, never zero).
//!
//! Later packages reuse this module (the checks gate here; the checker and the ship pass elsewhere).

use std::sync::OnceLock;

use regex::Regex;

/// The most output read. A longer log is read from its end, where the summary is. (A cargo run summed over a larger
/// log than this would miss its early binaries, but a log this long has failed or run far more than zero tests.)
const MAX_SCAN: usize = 8 * 1024 * 1024;

/// The test runners whose summaries are read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Runner {
    Vitest,
    Cargo,
    Nextest,
    NodeTest,
    Pytest,
    Go,
    Playwright,
}

impl Runner {
    /// The runner's name in a sentence.
    pub fn name(self) -> &'static str {
        match self {
            Runner::Vitest => "vitest",
            Runner::Cargo => "cargo test",
            Runner::Nextest => "cargo nextest",
            Runner::NodeTest => "node --test",
            Runner::Pytest => "pytest",
            Runner::Go => "go test",
            Runner::Playwright => "Playwright",
        }
    }
}

/// What a runner said about a run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Summary {
    pub runner: Runner,
    /// Tests that ran: `passed + failed`. Skipped ones are not in it.
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
    /// Skipped, ignored, todo and deselected tests.
    pub skipped: u64,
}

/// A summary and the line it was read from, so the last one in the log can win.
type Found = Option<(usize, Summary)>;

/// The counts of the last runner summary in `output`, or `None` when there is none.
pub fn parse(output: &str) -> Option<Summary> {
    let text = clean(output);
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    [
        vitest(&lines),
        cargo(&lines),
        nextest(&lines),
        node_test(&lines),
        pytest(&lines),
        go(&lines),
        playwright(&lines),
    ]
    .into_iter()
    .flatten()
    .max_by_key(|(at, _)| *at)
    .map(|(_, summary)| summary)
}

/// The tail of the output with colour codes removed and every line break one `\n`.
fn clean(output: &str) -> String {
    let mut start = output.len().saturating_sub(MAX_SCAN);
    while !output.is_char_boundary(start) {
        start += 1;
    }
    let plain = regex(
        &ANSI,
        r"\x1b\[[0-9;?:]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)",
    )
    .replace_all(&output[start..], "");
    plain.replace("\r\n", "\n").replace('\r', "\n")
}

static ANSI: OnceLock<Regex> = OnceLock::new();

/// A pattern compiled once. Every pattern here is a literal checked by the tests, so a bad one is a bug, not input.
fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a valid test-summary pattern"))
}

fn number(text: &str) -> u64 {
    text.parse().unwrap_or(0)
}

fn summary(runner: Runner, passed: u64, failed: u64, skipped: u64) -> Summary {
    Summary {
        runner,
        total: passed + failed,
        passed,
        failed,
        skipped,
    }
}

/// `Tests  1 failed | 2 passed (3)`, `Tests  no tests`, `No test files found`.
fn vitest(lines: &[&str]) -> Found {
    static LINE: OnceLock<Regex> = OnceLock::new();
    static COUNT: OnceLock<Regex> = OnceLock::new();
    let line_re = regex(&LINE, r"^Tests\s+(.+)$");
    let count_re = regex(&COUNT, r"(\d+)\s+(passed|failed|skipped|todo)\b");
    let mut found = None;
    for (at, line) in lines.iter().enumerate() {
        if line.starts_with("No test files found") {
            found = Some((at, summary(Runner::Vitest, 0, 0, 0)));
            continue;
        }
        let Some(body) = line_re.captures(line).map(|caps| caps[1].to_string()) else {
            continue;
        };
        if body == "no tests" {
            found = Some((at, summary(Runner::Vitest, 0, 0, 0)));
            continue;
        }
        // Vitest ends the line with the total in brackets. Another tool's "Tests ..." line has none.
        if !body.ends_with(')') {
            continue;
        }
        let (mut passed, mut failed, mut skipped) = (0, 0, 0);
        let mut any = false;
        for caps in count_re.captures_iter(&body) {
            any = true;
            let n = number(&caps[1]);
            match &caps[2] {
                "passed" => passed += n,
                "failed" => failed += n,
                _ => skipped += n,
            }
        }
        if any {
            found = Some((at, summary(Runner::Vitest, passed, failed, skipped)));
        }
    }
    found
}

/// Every `test result: ok. 2 passed; 0 failed; 1 ignored; ...` line, added up.
fn cargo(lines: &[&str]) -> Found {
    static LINE: OnceLock<Regex> = OnceLock::new();
    let line_re = regex(
        &LINE,
        r"^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;",
    );
    let (mut passed, mut failed, mut skipped) = (0, 0, 0);
    let mut last = None;
    for (at, line) in lines.iter().enumerate() {
        if let Some(caps) = line_re.captures(line) {
            passed += number(&caps[1]);
            failed += number(&caps[2]);
            skipped += number(&caps[3]);
            last = Some(at);
        }
    }
    last.map(|at| (at, summary(Runner::Cargo, passed, failed, skipped)))
}

/// `Summary [ 1.2s] 12 tests run: 12 passed, 1 skipped`, and `Starting 0 tests ...` or `error: no tests to run` when
/// nothing started.
fn nextest(lines: &[&str]) -> Found {
    static SUMMARY: OnceLock<Regex> = OnceLock::new();
    static COUNT: OnceLock<Regex> = OnceLock::new();
    static STARTING: OnceLock<Regex> = OnceLock::new();
    let summary_re = regex(
        &SUMMARY,
        r"^Summary\s+\[\s*[\d.]+m?s\]\s+\d+\s+tests?\s+run:\s*(.*)$",
    );
    let count_re = regex(&COUNT, r"(\d+)\s+(passed|failed|timed out|skipped)");
    let starting_re = regex(
        &STARTING,
        r"^Starting\s+0\s+tests?\b(?:.*?\((\d+)\s+skipped\))?",
    );
    let mut found = None;
    for (at, line) in lines.iter().enumerate() {
        if let Some(caps) = summary_re.captures(line) {
            let (mut passed, mut failed, mut skipped) = (0, 0, 0);
            for count in count_re.captures_iter(&caps[1]) {
                let n = number(&count[1]);
                match &count[2] {
                    "passed" => passed += n,
                    "skipped" => skipped += n,
                    _ => failed += n,
                }
            }
            found = Some((at, summary(Runner::Nextest, passed, failed, skipped)));
        } else if let Some(caps) = starting_re.captures(line) {
            let skipped = caps.get(1).map_or(0, |m| number(m.as_str()));
            found = Some((at, summary(Runner::Nextest, 0, 0, skipped)));
        } else if line.starts_with("error: no tests to run") {
            found = Some((at, summary(Runner::Nextest, 0, 0, 0)));
        }
    }
    found
}

/// The block that starts at the last `# tests N` (or `ℹ tests N`) line: `pass`, `fail`, `cancelled`, `skipped`, `todo`.
fn node_test(lines: &[&str]) -> Found {
    static LINE: OnceLock<Regex> = OnceLock::new();
    let line_re = regex(
        &LINE,
        r"^(?:#|ℹ|i)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)$",
    );
    let at = lines.iter().rposition(|line| {
        line_re
            .captures(line)
            .is_some_and(|caps| &caps[1] == "tests")
    })?;
    let tests = line_re
        .captures(lines[at])
        .map_or(0, |caps| number(&caps[2]));
    let (mut passed, mut failed, mut skipped, mut cancelled, mut todo) = (0, 0, 0, 0, 0);
    let mut counted = false;
    for line in &lines[at + 1..] {
        let Some(caps) = line_re.captures(line) else {
            continue;
        };
        let n = number(&caps[2]);
        match &caps[1] {
            "pass" => {
                passed = n;
                counted = true;
            }
            "fail" => {
                failed = n;
                counted = true;
            }
            "cancelled" => cancelled = n,
            "skipped" => skipped = n,
            "todo" => todo = n,
            _ => {}
        }
    }
    let skipped = skipped + todo;
    let found = if counted {
        summary(Runner::NodeTest, passed, failed + cancelled, skipped)
    } else {
        // No pass or fail line: what ran is what was counted, less what was skipped.
        summary(
            Runner::NodeTest,
            tests.saturating_sub(skipped + cancelled),
            cancelled,
            skipped,
        )
    };
    Some((at, found))
}

/// `3 passed, 1 failed in 0.1s` (with or without the `=====` rule), `no tests ran in 0.01s`, `collected 0 items`.
fn pytest(lines: &[&str]) -> Found {
    static DURATION: OnceLock<Regex> = OnceLock::new();
    static PART: OnceLock<Regex> = OnceLock::new();
    static COLLECTED: OnceLock<Regex> = OnceLock::new();
    let duration_re = regex(&DURATION, r"^[\d.]+s(?: \(\d+:\d{2}:\d{2}\))?$");
    let part_re = regex(
        &PART,
        r"^(\d+) (passed|failed|skipped|deselected|xfailed|xpassed|warnings?|errors?|rerun)$",
    );
    let collected_re = regex(&COLLECTED, r"(?:^|\s)collected 0 items?\b");
    let mut found = None;
    for (at, line) in lines.iter().enumerate() {
        let bare = line.trim_matches(|c: char| c == '=' || c == ' ');
        if let Some(rest) = bare.strip_prefix("no tests ran in ") {
            if duration_re.is_match(rest) {
                found = Some((at, summary(Runner::Pytest, 0, 0, 0)));
                continue;
            }
        }
        if let Some((counts, duration)) = bare.rsplit_once(" in ") {
            if duration_re.is_match(duration) {
                let parts: Vec<_> = counts
                    .split(", ")
                    .map(|part| part_re.captures(part))
                    .collect();
                if !parts.is_empty() && parts.iter().all(Option::is_some) {
                    let (mut passed, mut failed, mut skipped) = (0, 0, 0);
                    for caps in parts.into_iter().flatten() {
                        let n = number(&caps[1]);
                        match &caps[2] {
                            "passed" | "xfailed" | "xpassed" => passed += n,
                            "failed" | "error" | "errors" => failed += n,
                            "skipped" | "deselected" => skipped += n,
                            _ => {}
                        }
                    }
                    found = Some((at, summary(Runner::Pytest, passed, failed, skipped)));
                    continue;
                }
            }
        }
        if collected_re.is_match(line) {
            found = Some((at, summary(Runner::Pytest, 0, 0, 0)));
        }
    }
    found
}

/// `ok  pkg 0.1s`, `ok  pkg (cached)`, `?   pkg [no test files]`, `FAIL pkg`, and `--- PASS/FAIL/SKIP` lines.
fn go(lines: &[&str]) -> Found {
    static OK: OnceLock<Regex> = OnceLock::new();
    static NO_FILES: OnceLock<Regex> = OnceLock::new();
    static FAIL_PKG: OnceLock<Regex> = OnceLock::new();
    static CASE: OnceLock<Regex> = OnceLock::new();
    let ok_re = regex(&OK, r"^ok\s+\S+\s+(?:\(cached\)|\d+(?:\.\d+)?s)(\s.*)?$");
    let no_files_re = regex(&NO_FILES, r"^\?\s+\S+\s+\[no test files\]");
    let fail_pkg_re = regex(&FAIL_PKG, r"^FAIL\s+\S+");
    let case_re = regex(&CASE, r"^--- (PASS|FAIL|SKIP): ");
    let (mut cases_passed, mut cases_failed, mut skipped) = (0, 0, 0);
    let (mut ran, mut failed_pkgs) = (0, 0);
    let mut last = None;
    for (at, line) in lines.iter().enumerate() {
        if let Some(caps) = ok_re.captures(line) {
            if !caps
                .get(1)
                .is_some_and(|rest| rest.as_str().contains("[no tests to run]"))
            {
                ran += 1;
            }
            last = Some(at);
        } else if no_files_re.is_match(line) {
            last = Some(at);
        } else if fail_pkg_re.is_match(line) {
            failed_pkgs += 1;
            last = Some(at);
        } else if let Some(caps) = case_re.captures(line) {
            match &caps[1] {
                "PASS" => cases_passed += 1,
                "FAIL" => cases_failed += 1,
                _ => skipped += 1,
            }
            last = Some(at);
        } else if *line == "FAIL" {
            last = Some(at);
        }
    }
    // Without `-v` Go prints no counts: each package that ran tests is one, at least.
    let passed = if cases_passed > 0 { cases_passed } else { ran };
    let failed = if cases_failed > 0 {
        cases_failed
    } else {
        failed_pkgs
    };
    last.map(|at| (at, summary(Runner::Go, passed, failed, skipped)))
}

/// `3 passed (5.0s)`, `1 failed`, `2 skipped`, `1 flaky` after the last `Running N tests`, and `Error: No tests found`.
fn playwright(lines: &[&str]) -> Found {
    static RUNNING: OnceLock<Regex> = OnceLock::new();
    static COUNT: OnceLock<Regex> = OnceLock::new();
    let running_re = regex(
        &RUNNING,
        r"^Running\s+\d+\s+tests?\s+using\s+\d+\s+workers?",
    );
    let count_re = regex(
        &COUNT,
        r"^(\d+)\s+(passed|failed|flaky|skipped|interrupted|did not run)(?:\s+\([^)]*\))?$",
    );
    let mut found = None;
    for (at, line) in lines.iter().enumerate() {
        if line.starts_with("Error: No tests found") {
            found = Some((at, summary(Runner::Playwright, 0, 0, 0)));
        }
    }
    let from = lines
        .iter()
        .rposition(|line| running_re.is_match(line))
        .unwrap_or(0);
    let (mut passed, mut failed, mut skipped) = (0, 0, 0);
    let mut last = None;
    for (at, line) in lines.iter().enumerate().skip(from) {
        let Some(caps) = count_re.captures(line) else {
            continue;
        };
        let n = number(&caps[1]);
        match &caps[2] {
            "passed" | "flaky" => passed += n,
            "failed" | "interrupted" => failed += n,
            _ => skipped += n,
        }
        last = Some(at);
    }
    match last {
        Some(at) if found.is_none_or(|(seen, _)| at > seen) => {
            Some((at, summary(Runner::Playwright, passed, failed, skipped)))
        }
        _ => found,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sum(runner: Runner, passed: u64, failed: u64, skipped: u64) -> Summary {
        Summary {
            runner,
            total: passed + failed,
            passed,
            failed,
            skipped,
        }
    }

    // ---- vitest ----------------------------------------------------------------------------------------------------

    #[test]
    fn vitest_all_passed() {
        let out = " RUN  v2.1.8 /repo\n\n ✓ src/a.test.ts (3 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Start at  10:00:00\n   Duration  1.02s\n";
        assert_eq!(parse(out), Some(sum(Runner::Vitest, 3, 0, 0)));
    }

    #[test]
    fn vitest_with_a_failure() {
        let out = " Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";
        assert_eq!(parse(out), Some(sum(Runner::Vitest, 2, 1, 0)));
    }

    #[test]
    fn vitest_skipped_and_todo_are_not_tests_that_ran() {
        let out = "      Tests  2 passed | 1 skipped | 1 todo (4)\n";
        assert_eq!(parse(out), Some(sum(Runner::Vitest, 2, 0, 2)));
        let only_skipped = "      Tests  3 skipped (3)\n";
        assert_eq!(parse(only_skipped), Some(sum(Runner::Vitest, 0, 0, 3)));
    }

    #[test]
    fn vitest_with_no_tests_is_zero() {
        let found = "No test files found, exiting with code 1\n";
        assert_eq!(parse(found).map(|s| s.total), Some(0));
        assert_eq!(parse(found).map(|s| s.runner), Some(Runner::Vitest));
        let none = " Test Files  1 passed (1)\n      Tests  no tests\n";
        assert_eq!(parse(none).map(|s| s.total), Some(0));
    }

    #[test]
    fn vitest_in_colour() {
        let out = "\u{1b}[2m Test Files \u{1b}[22m \u{1b}[1m\u{1b}[32m1 passed\u{1b}[39m\u{1b}[22m\u{1b}[90m (1)\u{1b}[39m\n\u{1b}[2m      Tests \u{1b}[22m \u{1b}[1m\u{1b}[32m3 passed\u{1b}[39m\u{1b}[22m\u{1b}[90m (3)\u{1b}[39m\n";
        assert_eq!(parse(out), Some(sum(Runner::Vitest, 3, 0, 0)));
    }

    // ---- cargo test ------------------------------------------------------------------------------------------------

    #[test]
    fn cargo_sums_every_test_result_line_and_the_empty_doc_tests_do_not_make_it_zero() {
        let out = "running 2 tests\ntest a ... ok\ntest b ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n   Doc-tests foo\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
        assert_eq!(parse(out), Some(sum(Runner::Cargo, 2, 0, 0)));
    }

    #[test]
    fn cargo_sums_binaries_and_counts_ignored_as_skipped() {
        let out = "test result: ok. 4 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.1s\ntest result: FAILED. 6 passed; 1 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.2s\n";
        assert_eq!(parse(out), Some(sum(Runner::Cargo, 10, 1, 1)));
    }

    #[test]
    fn cargo_with_nothing_run_is_zero() {
        let none = "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 0.00s\n";
        assert_eq!(parse(none), Some(sum(Runner::Cargo, 0, 0, 0)));
        let ignored = "test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
        assert_eq!(parse(ignored), Some(sum(Runner::Cargo, 0, 0, 1)));
        assert_eq!(parse(ignored).map(|s| s.total), Some(0));
    }

    #[test]
    fn cargo_in_colour() {
        let out = "test result: \u{1b}[32mok\u{1b}[0m. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
        assert_eq!(parse(out), Some(sum(Runner::Cargo, 2, 0, 0)));
    }

    // ---- cargo nextest ---------------------------------------------------------------------------------------------

    #[test]
    fn nextest_pass_and_fail() {
        let pass = "     Starting 12 tests across 3 binaries (2 skipped)\n     Summary [   1.2s] 12 tests run: 12 passed, 1 skipped\n";
        assert_eq!(parse(pass), Some(sum(Runner::Nextest, 12, 0, 1)));
        let fail = "     Summary [   0.5s] 12 tests run: 10 passed (1 slow), 2 failed, 1 skipped\n";
        assert_eq!(parse(fail), Some(sum(Runner::Nextest, 10, 2, 1)));
    }

    #[test]
    fn nextest_starting_zero_tests_is_zero() {
        let out = "     Starting 0 tests across 1 binary (5 skipped)\n";
        assert_eq!(
            parse(out).map(|s| (s.runner, s.total)),
            Some((Runner::Nextest, 0))
        );
        let none = "error: no tests to run\n";
        assert_eq!(parse(none).map(|s| s.total), Some(0));
        let summary = "     Summary [   0.001s] 0 tests run: 0 passed, 5 skipped\n";
        assert_eq!(parse(summary), Some(sum(Runner::Nextest, 0, 0, 5)));
    }

    // ---- node --test -----------------------------------------------------------------------------------------------

    #[test]
    fn node_test_tap_pass_and_fail() {
        let pass = "TAP version 13\nok 1 - a\n1..1\n# tests 3\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 50.2\n";
        assert_eq!(parse(pass), Some(sum(Runner::NodeTest, 3, 0, 0)));
        let fail =
            "# tests 4\n# suites 0\n# pass 3\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n";
        assert_eq!(parse(fail), Some(sum(Runner::NodeTest, 3, 1, 0)));
    }

    #[test]
    fn node_test_zero_skipped_and_spec_style() {
        let zero =
            "# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
        assert_eq!(parse(zero), Some(sum(Runner::NodeTest, 0, 0, 0)));
        let lone = "# tests 0\n";
        assert_eq!(parse(lone).map(|s| s.total), Some(0));
        let skipped = "# tests 5\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 2\n# todo 0\n";
        assert_eq!(parse(skipped), Some(sum(Runner::NodeTest, 3, 0, 2)));
        let spec = "ℹ tests 4\nℹ suites 0\nℹ pass 3\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 12.1\n";
        assert_eq!(parse(spec), Some(sum(Runner::NodeTest, 3, 1, 0)));
        let spec_in_colour = "\u{1b}[34mℹ tests 3\u{1b}[39m\n\u{1b}[34mℹ pass 3\u{1b}[39m\n\u{1b}[34mℹ fail 0\u{1b}[39m\n";
        assert_eq!(parse(spec_in_colour), Some(sum(Runner::NodeTest, 3, 0, 0)));
    }

    #[test]
    fn node_test_reads_the_last_block_of_a_log_that_ran_it_twice() {
        let out = "# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# tests 0\n# pass 0\n# fail 0\n# skipped 0\n";
        assert_eq!(parse(out), Some(sum(Runner::NodeTest, 0, 0, 0)));
    }

    // ---- pytest ----------------------------------------------------------------------------------------------------

    #[test]
    fn pytest_pass_fail_and_quiet() {
        let pass = "============================= test session starts ==============================\ncollected 3 items\n\na.py ...                                                                [100%]\n\n============================== 3 passed in 0.12s ===============================\n";
        assert_eq!(parse(pass), Some(sum(Runner::Pytest, 3, 0, 0)));
        let fail =
            "=========================== 1 failed, 2 passed in 0.10s ===========================\n";
        assert_eq!(parse(fail), Some(sum(Runner::Pytest, 2, 1, 0)));
        let quiet = "3 passed in 0.12s\n";
        assert_eq!(parse(quiet), Some(sum(Runner::Pytest, 3, 0, 0)));
        let extras = "==== 3 passed, 1 skipped, 2 warnings in 1.23s (0:00:01) ====\n";
        assert_eq!(parse(extras), Some(sum(Runner::Pytest, 3, 0, 1)));
        let errors = "= 1 failed, 1 error in 0.2s =\n";
        assert_eq!(parse(errors), Some(sum(Runner::Pytest, 0, 2, 0)));
    }

    #[test]
    fn pytest_with_nothing_run_is_zero() {
        let none =
            "============================ no tests ran in 0.01s =============================\n";
        assert_eq!(parse(none), Some(sum(Runner::Pytest, 0, 0, 0)));
        let collected = "collected 0 items\n\n============================ no tests ran in 0.00s =============================\n";
        assert_eq!(parse(collected).map(|s| s.total), Some(0));
        let collected_only = "collecting ... collected 0 items\n";
        assert_eq!(parse(collected_only).map(|s| s.total), Some(0));
        let deselected = "===== 5 deselected in 0.01s =====\n";
        assert_eq!(parse(deselected), Some(sum(Runner::Pytest, 0, 0, 5)));
    }

    #[test]
    fn pytest_collected_some_with_no_summary_is_unknown_and_other_lines_are_not_summaries() {
        assert_eq!(parse("collected 5 items\n"), None);
        assert_eq!(parse("12 files changed in 0.5s\n"), None);
    }

    // ---- go test ---------------------------------------------------------------------------------------------------

    #[test]
    fn go_ok_packages_ran_tests_and_cached_ones_too() {
        let out = "ok  \texample.com/a\t0.012s\nok  \texample.com/b\t(cached)\n";
        let got = parse(out).expect("go summary");
        assert_eq!(got.runner, Runner::Go);
        assert_eq!((got.passed, got.failed), (2, 0));
        assert!(got.total > 0);
    }

    #[test]
    fn go_verbose_counts_pass_fail_and_skip_lines_including_subtests() {
        let out = "=== RUN   TestA\n=== RUN   TestA/sub\n    --- PASS: TestA/sub (0.00s)\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\n=== RUN   TestC\n--- SKIP: TestC (0.00s)\nFAIL\nFAIL\texample.com/a\t0.012s\nFAIL\n";
        assert_eq!(parse(out), Some(sum(Runner::Go, 2, 1, 1)));
    }

    #[test]
    fn go_with_no_test_files_or_no_tests_to_run_is_zero() {
        let none = "?   \texample.com/a\t[no test files]\n";
        assert_eq!(parse(none), Some(sum(Runner::Go, 0, 0, 0)));
        let to_run = "ok  \texample.com/a\t0.002s [no tests to run]\n";
        assert_eq!(parse(to_run).map(|s| s.total), Some(0));
        let mixed = "?   \texample.com/x\t[no test files]\nok  \texample.com/y\t0.1s\n";
        assert!(parse(mixed).is_some_and(|s| s.total > 0));
    }

    #[test]
    fn go_build_failure_is_a_failed_package() {
        let out = "FAIL\texample.com/a [build failed]\nFAIL\n";
        let got = parse(out).expect("go summary");
        assert_eq!(got.failed, 1);
        assert_eq!(got.total, 1);
    }

    // ---- Playwright ------------------------------------------------------------------------------------------------

    #[test]
    fn playwright_pass_fail_skipped_and_flaky() {
        let pass = "Running 3 tests using 1 worker\n\n  3 passed (5.0s)\n";
        assert_eq!(parse(pass), Some(sum(Runner::Playwright, 3, 0, 0)));
        let fail = "Running 3 tests using 2 workers\n\n  1 failed\n    [chromium] › a.spec.ts:3:5 › it works ─────\n  2 passed (3.2s)\n";
        assert_eq!(parse(fail), Some(sum(Runner::Playwright, 2, 1, 0)));
        let skipped = "  2 skipped\n  1 passed (1.2s)\n";
        assert_eq!(parse(skipped), Some(sum(Runner::Playwright, 1, 0, 2)));
        let flaky = "  1 flaky\n    [webkit] › a.spec.ts:3:5 › x\n  2 passed (3s)\n";
        assert_eq!(parse(flaky), Some(sum(Runner::Playwright, 3, 0, 0)));
        let didnt = "  1 did not run\n  1 passed (1.1m)\n";
        assert_eq!(parse(didnt), Some(sum(Runner::Playwright, 1, 0, 1)));
    }

    #[test]
    fn playwright_with_no_tests_is_zero() {
        let none = "Error: No tests found.\n\nMake sure that arguments are regular expressions matching test files.\n";
        assert_eq!(
            parse(none).map(|s| (s.runner, s.total)),
            Some((Runner::Playwright, 0))
        );
        let skipped_only = "Running 2 tests using 1 worker\n\n  2 skipped\n";
        assert_eq!(parse(skipped_only), Some(sum(Runner::Playwright, 0, 0, 2)));
    }

    #[test]
    fn playwright_reads_the_last_run_of_a_log_that_ran_it_twice() {
        let out = "Running 5 tests using 1 worker\n  1 failed\n  4 passed (2s)\n\nRunning 1 test using 1 worker\n  1 passed (1s)\n";
        assert_eq!(parse(out), Some(sum(Runner::Playwright, 1, 0, 0)));
    }

    // ---- across runners, and the shape of the output ---------------------------------------------------------------

    #[test]
    fn a_log_with_no_summary_is_none() {
        assert_eq!(parse(""), None);
        assert_eq!(
            parse("   Compiling foo v0.1.0\n    Finished dev [unoptimized] target(s) in 1.2s\n"),
            None
        );
        assert_eq!(parse("$ eslint .\n✔ no problems\n"), None);
        assert_eq!(parse("\u{1b}[32mDone in 3.4s\u{1b}[0m\n"), None);
    }

    #[test]
    fn the_last_summary_in_the_log_wins_over_an_earlier_runner() {
        let vitest_then_cargo = "      Tests  2 passed (2)\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
        assert_eq!(parse(vitest_then_cargo), Some(sum(Runner::Cargo, 0, 0, 0)));
        let cargo_then_vitest = "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n      Tests  2 passed (2)\n";
        assert_eq!(parse(cargo_then_vitest), Some(sum(Runner::Vitest, 2, 0, 0)));
    }

    #[test]
    fn crlf_and_carriage_return_redraws_are_lines() {
        let crlf = "Test Files  1 passed (1)\r\n      Tests  3 passed (3)\r\n";
        assert_eq!(parse(crlf), Some(sum(Runner::Vitest, 3, 0, 0)));
        let redraw = "running...\r      Tests  3 passed (3)\r\n";
        assert_eq!(parse(redraw), Some(sum(Runner::Vitest, 3, 0, 0)));
    }

    #[test]
    fn a_very_long_log_is_read_from_its_end() {
        let noise = "x".repeat(MAX_SCAN + 10_000);
        let out = format!("{noise}\n      Tests  1 passed (1)\n");
        assert_eq!(parse(&out), Some(sum(Runner::Vitest, 1, 0, 0)));
        // A cut in the middle of a multi-byte character must not panic.
        let wide = "é".repeat(MAX_SCAN);
        let out = format!("{wide}\n      Tests  1 passed (1)\n");
        assert_eq!(parse(&out), Some(sum(Runner::Vitest, 1, 0, 0)));
    }

    #[test]
    fn a_runners_name_reads_in_a_sentence() {
        assert_eq!(Runner::Cargo.name(), "cargo test");
        assert_eq!(Runner::Vitest.name(), "vitest");
    }
}
