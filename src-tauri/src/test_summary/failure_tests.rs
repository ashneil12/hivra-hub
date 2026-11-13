//! SC-7: the failing tests each runner names, and the red / green / inconclusive call. The fixtures are real-shaped
//! output of each runner (`fixtures/`): a pass, a failure, zero tests, and a build error before any test ran.

use super::*;

const VITEST_FAIL: &str = include_str!("fixtures/vitest_fail.txt");
const VITEST_PASS: &str = include_str!("fixtures/vitest_pass.txt");
const VITEST_ZERO: &str = include_str!("fixtures/vitest_zero.txt");
const VITEST_IMPORT_ERROR: &str = include_str!("fixtures/vitest_import_error.txt");
const VITEST_ONE_FILE_NOT_LOADED: &str = include_str!("fixtures/vitest_one_file_not_loaded.txt");
const CARGO_FAIL: &str = include_str!("fixtures/cargo_fail.txt");
const CARGO_PASS: &str = include_str!("fixtures/cargo_pass.txt");
const CARGO_ZERO: &str = include_str!("fixtures/cargo_zero.txt");
const CARGO_COMPILE_ERROR: &str = include_str!("fixtures/cargo_compile_error.txt");
const CARGO_NOCAPTURE_FAIL: &str = include_str!("fixtures/cargo_nocapture_fail.txt");
const NEXTEST_FAIL: &str = include_str!("fixtures/nextest_fail.txt");
const NEXTEST_PASS: &str = include_str!("fixtures/nextest_pass.txt");
const NEXTEST_ZERO: &str = include_str!("fixtures/nextest_zero.txt");
const PYTEST_FAIL: &str = include_str!("fixtures/pytest_fail.txt");
const PYTEST_PASS: &str = include_str!("fixtures/pytest_pass.txt");
const PYTEST_ZERO: &str = include_str!("fixtures/pytest_zero.txt");
const PYTEST_COLLECTION_ERROR: &str = include_str!("fixtures/pytest_collection_error.txt");
const GO_FAIL_VERBOSE: &str = include_str!("fixtures/go_fail_verbose.txt");
const GO_FAIL_QUIET: &str = include_str!("fixtures/go_fail_quiet.txt");
const GO_PASS: &str = include_str!("fixtures/go_pass.txt");
const GO_BUILD_FAILED: &str = include_str!("fixtures/go_build_failed.txt");
const GO_ZERO: &str = include_str!("fixtures/go_zero.txt");
const NODE_TAP_FAIL: &str = include_str!("fixtures/node_tap_fail.txt");
const NODE_SPEC_FAIL: &str = include_str!("fixtures/node_spec_fail.txt");
const NODE_ZERO: &str = include_str!("fixtures/node_zero.txt");
const PLAYWRIGHT_FAIL: &str = include_str!("fixtures/playwright_fail.txt");
const PLAYWRIGHT_PASS: &str = include_str!("fixtures/playwright_pass.txt");
const PLAYWRIGHT_ZERO: &str = include_str!("fixtures/playwright_zero.txt");

fn names(output: &str) -> Vec<String> {
    failures(output).into_iter().map(|f| f.name).collect()
}

fn lines(message: &str) -> Vec<&str> {
    message.lines().collect()
}

// ---- vitest -----------------------------------------------------------------------------------------------------------

#[test]
fn vitest_names_the_failing_test_with_its_message_and_stops_at_the_rule() {
    let found = failures(VITEST_FAIL);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].name, "src/math.test.ts > math > adds");
    let message = lines(&found[0].message);
    assert_eq!(
        message[0],
        "AssertionError: expected 2 to be 3 // Object.is equality"
    );
    assert!(message.contains(&"- Expected"));
    assert!(
        !found[0].message.contains('⎯'),
        "the rule that ends the block is not the message: {}",
        found[0].message
    );
    assert!(
        !found[0].message.contains("Test Files"),
        "{}",
        found[0].message
    );
}

#[test]
fn vitest_pass_and_zero_tests_name_no_failure() {
    assert!(failures(VITEST_PASS).is_empty());
    assert!(failures(VITEST_ZERO).is_empty());
}

#[test]
fn vitest_reds_greens_and_inconclusives() {
    let red = classify(VITEST_FAIL);
    assert_eq!(red.outcome, TestOutcome::Red);
    assert_eq!(red.line, "Tests  1 failed | 2 passed (3)");
    assert_eq!(red.summary.map(|s| (s.total, s.failed)), Some((3, 1)));
    let green = classify(VITEST_PASS);
    assert_eq!(green.outcome, TestOutcome::Green);
    assert_eq!(green.line, "Tests  3 passed (3)");
    let zero = classify(VITEST_ZERO);
    assert_eq!(zero.outcome, TestOutcome::Inconclusive);
    assert_eq!(zero.why, Some(WHY_ZERO_TESTS));
}

#[test]
fn vitest_a_test_file_that_would_not_load_is_never_red_or_green() {
    // The only file that failed could not be read: no test of it ran. The summary says zero tests.
    let alone = classify(VITEST_IMPORT_ERROR);
    assert_eq!(alone.outcome, TestOutcome::Inconclusive);
    // Beside a file that ran and passed, "3 passed" would read green. It is not: one file never ran.
    let beside = classify(VITEST_ONE_FILE_NOT_LOADED);
    assert_eq!(beside.summary.map(|s| (s.total, s.failed)), Some((3, 0)));
    assert_eq!(beside.outcome, TestOutcome::Inconclusive);
    assert_eq!(beside.why, Some(WHY_BUILD_ERROR));
}

// ---- cargo test -------------------------------------------------------------------------------------------------------

#[test]
fn cargo_names_the_failing_test_with_its_panic_and_drops_the_backtrace_hint() {
    let found = failures(CARGO_FAIL);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].name, "tests::subtracts");
    assert_eq!(
        lines(&found[0].message),
        [
            "thread 'tests::subtracts' panicked at src/lib.rs:12:9:",
            "assertion `left == right` failed",
            "  left: 1",
            " right: 2",
        ]
    );
}

#[test]
fn cargo_with_no_captured_output_still_names_the_failing_test() {
    assert_eq!(names(CARGO_NOCAPTURE_FAIL), ["tests::subtracts"]);
}

#[test]
fn cargo_pass_zero_and_compile_error() {
    assert!(failures(CARGO_PASS).is_empty());
    assert_eq!(classify(CARGO_PASS).outcome, TestOutcome::Green);
    assert_eq!(classify(CARGO_FAIL).outcome, TestOutcome::Red);
    let zero = classify(CARGO_ZERO);
    assert_eq!(zero.outcome, TestOutcome::Inconclusive);
    assert_eq!(zero.why, Some(WHY_ZERO_TESTS));
    // A compile error stops cargo before any test: no summary line, no failure, and it is not red.
    assert!(failures(CARGO_COMPILE_ERROR).is_empty());
    let broken = classify(CARGO_COMPILE_ERROR);
    assert_eq!(broken.summary, None);
    assert_eq!(broken.outcome, TestOutcome::Inconclusive);
    assert_eq!(broken.why, Some(WHY_BUILD_ERROR));
}

#[test]
fn cargo_several_binaries_are_summed_in_one_derived_line() {
    let out = format!("{CARGO_PASS}\n{CARGO_FAIL}");
    let got = classify(&out);
    assert_eq!(got.outcome, TestOutcome::Red);
    assert_eq!(got.summary.map(|s| (s.total, s.failed)), Some((4, 1)));
    assert_eq!(got.line, "cargo test: 3 passed, 1 failed, 0 skipped");
}

// ---- cargo nextest ----------------------------------------------------------------------------------------------------

#[test]
fn nextest_names_the_failing_test_once_with_the_message_from_its_stderr() {
    let found = failures(NEXTEST_FAIL);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].name, "tests::subtracts");
    assert_eq!(
        lines(&found[0].message),
        [
            "thread 'tests::subtracts' panicked at src/lib.rs:12:9:",
            "assertion `left == right` failed",
            "  left: 1",
            " right: 2",
        ]
    );
}

#[test]
fn nextest_prints_its_failures_again_after_the_summary_and_that_recap_is_not_go() {
    // `FAIL [   0.004s] foo tests::subtracts` after the Summary line once read as a failed Go package and won as the
    // last summary in the log.
    let got = parse(NEXTEST_FAIL).expect("a summary");
    assert_eq!(got.runner, Runner::Nextest);
    assert_eq!((got.passed, got.failed), (1, 1));
    // A real Go failure line still counts, beside it.
    let go = "FAIL\texample.com/a\t0.1s\n";
    assert_eq!(
        parse(go).map(|s| (s.runner, s.failed)),
        Some((Runner::Go, 1))
    );
}

#[test]
fn nextest_pass_zero_and_the_runners_own_line() {
    assert!(failures(NEXTEST_PASS).is_empty());
    let red = classify(NEXTEST_FAIL);
    assert_eq!(red.outcome, TestOutcome::Red);
    assert_eq!(
        red.line,
        "Summary [   0.005s] 2 tests run: 1 passed, 1 failed, 0 skipped"
    );
    assert_eq!(classify(NEXTEST_PASS).outcome, TestOutcome::Green);
    let zero = classify(NEXTEST_ZERO);
    assert_eq!(zero.outcome, TestOutcome::Inconclusive);
    assert_eq!(zero.why, Some(WHY_ZERO_TESTS));
}

// ---- pytest -----------------------------------------------------------------------------------------------------------

#[test]
fn pytest_names_the_failing_test_by_node_id_with_its_assertion_lines() {
    let found = failures(PYTEST_FAIL);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].name, "test_math.py::test_subtract");
    assert_eq!(
        lines(&found[0].message),
        [
            "assert 2 == 3",
            "+  where 2 = subtract(3, 1)",
            "test_math.py:6: AssertionError",
        ]
    );
}

#[test]
fn pytest_pass_zero_and_a_collection_error() {
    assert!(failures(PYTEST_PASS).is_empty());
    assert_eq!(classify(PYTEST_PASS).outcome, TestOutcome::Green);
    let red = classify(PYTEST_FAIL);
    assert_eq!(red.outcome, TestOutcome::Red);
    assert_eq!(red.line, "1 failed, 1 passed in 0.03s");
    let zero = classify(PYTEST_ZERO);
    assert_eq!(zero.outcome, TestOutcome::Inconclusive);
    assert_eq!(zero.why, Some(WHY_ZERO_TESTS));
    // "1 error" is read as one failed test by the summary parser. A test file that cannot be imported is not a red test.
    assert!(failures(PYTEST_COLLECTION_ERROR).is_empty());
    let broken = classify(PYTEST_COLLECTION_ERROR);
    assert_eq!(broken.outcome, TestOutcome::Inconclusive);
    assert_eq!(broken.why, Some(WHY_BUILD_ERROR));
}

#[test]
fn pytest_with_no_traceback_uses_the_one_line_reason_of_the_short_summary() {
    let out = "FAILED test_math.py::test_subtract - assert 2 == 3\n= 1 failed in 0.03s =\n";
    let found = failures(out);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "test_math.py::test_subtract");
    assert_eq!(found[0].message, "assert 2 == 3");
}

// ---- go test ----------------------------------------------------------------------------------------------------------

#[test]
fn go_verbose_puts_the_message_before_the_fail_line() {
    let found = failures(GO_FAIL_VERBOSE);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].name, "TestSub");
    assert_eq!(found[0].message, "    sub_test.go:9: Sub(3, 1) = 2, want 3");
}

#[test]
fn go_quiet_puts_the_message_after_and_keeps_subtests_apart() {
    let found = failures(GO_FAIL_QUIET);
    assert_eq!(names(GO_FAIL_QUIET), ["TestSub", "TestSub/negative"]);
    assert_eq!(
        found[0].message, "    sub_test.go:9: Sub(3, 1) = 2, want 3",
        "the parent keeps its own line, not the subtest's"
    );
    assert_eq!(
        found[1].message,
        "        sub_test.go:14: Sub(-1, 1) = 0, want -2"
    );
}

#[test]
fn go_pass_zero_and_a_build_failure() {
    assert!(failures(GO_PASS).is_empty());
    assert_eq!(classify(GO_PASS).outcome, TestOutcome::Green);
    assert_eq!(classify(GO_FAIL_VERBOSE).outcome, TestOutcome::Red);
    assert_eq!(classify(GO_ZERO).outcome, TestOutcome::Inconclusive);
    // The summary parser counts "FAIL pkg [build failed]" as one failed package. It is a compile error, not a red test.
    assert!(failures(GO_BUILD_FAILED).is_empty());
    let broken = classify(GO_BUILD_FAILED);
    assert_eq!(broken.outcome, TestOutcome::Inconclusive);
    assert_eq!(broken.why, Some(WHY_BUILD_ERROR));
}

#[test]
fn go_a_panic_is_the_message_of_the_test_that_raised_it() {
    let out = "--- FAIL: TestBoom (0.00s)\npanic: boom [recovered]\n\tpanic: boom\n\ngoroutine 7 [running]:\ntesting.tRunner.func1.2()\nFAIL\texample.com/a\t0.01s\nFAIL\n";
    let found = failures(out);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "TestBoom");
    assert!(found[0].message.starts_with("panic: boom [recovered]"));
    assert!(!found[0].message.contains("FAIL\texample.com"));
}

// ---- node --test ------------------------------------------------------------------------------------------------------

#[test]
fn node_tap_names_the_failing_test_with_its_error_and_not_its_stack() {
    let found = failures(NODE_TAP_FAIL);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].name, "subtracts");
    assert!(found[0].message.contains("2 !== 3"), "{}", found[0].message);
    assert!(
        found[0]
            .message
            .contains("Expected values to be strictly equal:"),
        "{}",
        found[0].message
    );
    assert!(!found[0].message.contains("runInAsyncScope"));
    assert!(!found[0].message.contains("duration_ms"));
}

#[test]
fn node_spec_names_the_failing_test_once_and_drops_its_stack() {
    let found = failures(NODE_SPEC_FAIL);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].name, "subtracts");
    assert_eq!(
        lines(&found[0].message),
        [
            "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
            "",
            "2 !== 3",
        ]
    );
}

#[test]
fn node_red_and_zero() {
    assert_eq!(classify(NODE_TAP_FAIL).outcome, TestOutcome::Red);
    assert_eq!(
        classify(NODE_TAP_FAIL).line,
        "node --test: 1 passed, 1 failed, 0 skipped"
    );
    assert_eq!(classify(NODE_SPEC_FAIL).outcome, TestOutcome::Red);
    let zero = classify(NODE_ZERO);
    assert_eq!(zero.outcome, TestOutcome::Inconclusive);
    assert_eq!(zero.why, Some(WHY_ZERO_TESTS));
    assert!(failures(NODE_ZERO).is_empty());
}

#[test]
fn node_a_parent_suite_that_only_says_a_subtest_failed_is_not_a_failure_of_its_own() {
    let out = "not ok 1 - outer\n  ---\n  duration_ms: 1.0\n  failureType: 'subtestsFailed'\n  error: '1 subtest failed'\n  code: 'ERR_TEST_FAILURE'\n  ...\n# tests 2\n# pass 1\n# fail 1\n";
    assert!(failures(out).is_empty(), "{:?}", failures(out));
}

// ---- Playwright -------------------------------------------------------------------------------------------------------

#[test]
fn playwright_names_the_failing_test_with_its_error_up_to_the_count_line() {
    let found = failures(PLAYWRIGHT_FAIL);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].name, "[chromium] › a.spec.ts:7:5 › breaks");
    let message = lines(&found[0].message);
    assert_eq!(
        message[0],
        "Error: expect(received).toBe(expected) // Object.is equality"
    );
    assert!(message.contains(&"Expected: 3"));
    assert!(
        !found[0].message.contains("1 failed"),
        "{}",
        found[0].message
    );
}

#[test]
fn playwright_pass_zero_and_red() {
    assert!(failures(PLAYWRIGHT_PASS).is_empty());
    assert_eq!(classify(PLAYWRIGHT_PASS).outcome, TestOutcome::Green);
    assert_eq!(classify(PLAYWRIGHT_FAIL).outcome, TestOutcome::Red);
    let zero = classify(PLAYWRIGHT_ZERO);
    assert_eq!(zero.outcome, TestOutcome::Inconclusive);
    assert_eq!(zero.why, Some(WHY_ZERO_TESTS));
}

// ---- the shape of the answer, across runners --------------------------------------------------------------------------

#[test]
fn a_message_is_cut_to_twenty_lines_and_a_long_line_is_cut() {
    let mut out = String::from("---- tests::big stdout ----\n");
    for n in 0..40 {
        out.push_str(&format!("line {n}\n"));
    }
    out.push_str(&"x".repeat(2000));
    out.push_str("\n\nfailures:\n    tests::big\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n");
    let found = failures(&out);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].message.lines().count(), MAX_MESSAGE_LINES);
    assert_eq!(found[0].message.lines().next(), Some("line 0"));
    let long = format!(
        "---- tests::wide stdout ----\n{}\n\nfailures:\n    tests::wide\n",
        "y".repeat(2000)
    );
    let wide = failures(&long);
    assert!(wide[0].message.chars().count() < 1000, "a line is cut");
}

#[test]
fn failures_from_two_runners_in_one_log_come_in_the_order_printed() {
    let out = format!("{VITEST_FAIL}\n{CARGO_FAIL}");
    assert_eq!(
        names(&out),
        ["src/math.test.ts > math > adds", "tests::subtracts"]
    );
}

#[test]
fn the_same_test_named_twice_is_listed_once() {
    // vitest prints a failing test in its progress and in the failed-tests block; nextest prints FAIL lines twice.
    let out = format!("{NEXTEST_FAIL}\n        FAIL [   0.004s] foo tests::subtracts\n");
    assert_eq!(names(&out), ["tests::subtracts"]);
}

#[test]
fn a_passing_log_a_blank_log_and_noise_name_nothing() {
    assert!(failures("").is_empty());
    assert!(failures("   Compiling foo v0.1.0\n    Finished in 1s\n").is_empty());
    assert!(failures("FAIL\n").is_empty());
}

#[test]
fn colour_codes_and_crlf_do_not_change_what_is_named() {
    let coloured = VITEST_FAIL.replace(" FAIL ", "\u{1b}[41m FAIL \u{1b}[49m");
    assert_eq!(names(&coloured), ["src/math.test.ts > math > adds"]);
    let crlf = CARGO_FAIL.replace('\n', "\r\n");
    assert_eq!(names(&crlf), ["tests::subtracts"]);
    assert_eq!(classify(&crlf).outcome, TestOutcome::Red);
}

#[test]
fn many_failures_are_capped_while_reading() {
    let mut out = String::new();
    for n in 0..500 {
        out.push_str(&format!("---- t::case{n} stdout ----\nboom\n\n"));
    }
    out.push_str("failures:\n");
    assert_eq!(failures(&out).len(), MAX_FAILURES_READ);
}

// ---- the call: never from the exit code, and a build error after a summary ------------------------------------------

#[test]
fn a_build_error_after_the_last_summary_means_the_run_did_not_finish() {
    // `npm run check` ran vitest green, and then the next step could not compile.
    let out = format!("{VITEST_PASS}\n   Compiling foo v0.1.0\nerror: could not compile `foo` (lib) due to 1 previous error\n");
    let got = classify(&out);
    assert_eq!(got.summary.map(|s| s.passed), Some(3));
    assert_eq!(got.outcome, TestOutcome::Inconclusive);
    assert_eq!(got.why, Some(WHY_BUILD_ERROR));
}

#[test]
fn an_assertion_message_that_mentions_an_error_before_the_summary_does_not_veto_a_red() {
    let out = "---- tests::parses stdout ----\nthread 'tests::parses' panicked at src/lib.rs:3:5:\nunexpected: error[E0425]: cannot find value\n\nfailures:\n    tests::parses\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
    assert_eq!(classify(out).outcome, TestOutcome::Red);
}

#[test]
fn no_summary_line_is_inconclusive_with_its_reason() {
    for out in ["", "all good\n", "$ eslint .\n✔ no problems\n"] {
        let got = classify(out);
        assert_eq!(got.outcome, TestOutcome::Inconclusive, "{out:?}");
        assert_eq!(got.summary, None);
        assert_eq!(got.why, Some(WHY_NO_SUMMARY), "{out:?}");
        assert_eq!(got.line, "");
    }
}

#[test]
fn only_what_the_runner_printed_decides_a_failed_line_with_no_counts_is_not_red() {
    // An exit code is not an input: text that says a command "failed" without a runner summary is inconclusive.
    let got = classify("npm ERR! code ELIFECYCLE\nnpm ERR! Test failed.\n");
    assert_eq!(got.outcome, TestOutcome::Inconclusive);
}
