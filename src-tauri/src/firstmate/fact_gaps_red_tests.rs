//! SC-7: the "no red before the fix" gap (fact_gaps.rs): a bug fix needs a failing run of a new or changed test that
//! happened before the worker's first edit to a file that is not a test. Red, green and inconclusive are decided by
//! `test_summary::classify` (the summary line, never the exit code).

use serde_json::json;

use super::fact_gaps::{
    is_fix_brief, is_no_red_gap, no_red_before_fix, runs_from_value, test_files_in_diff, FactEdit,
    FactRun, FixEvidence, NO_RED_BEFORE_FIX,
};
use crate::run_checks::Record;
use crate::test_summary::TestOutcome;

const VITEST_FAIL: &str = include_str!("../test_summary/fixtures/vitest_fail.txt");
const VITEST_PASS: &str = include_str!("../test_summary/fixtures/vitest_pass.txt");
const VITEST_IMPORT_ERROR: &str = include_str!("../test_summary/fixtures/vitest_import_error.txt");
const CARGO_FAIL: &str = include_str!("../test_summary/fixtures/cargo_fail.txt");
const CARGO_ZERO: &str = include_str!("../test_summary/fixtures/cargo_zero.txt");
const CARGO_COMPILE_ERROR: &str = include_str!("../test_summary/fixtures/cargo_compile_error.txt");

fn run(command: &str, at: f64, output: &str) -> FactRun {
    FactRun {
        command: command.into(),
        at,
        output: output.into(),
    }
}

fn edit(path: &str, at: f64) -> FactEdit {
    FactEdit {
        path: path.into(),
        at,
    }
}

fn evidence(test_files: &[&str], runs: Vec<FactRun>, edits: Vec<FactEdit>) -> FixEvidence {
    FixEvidence {
        test_files: test_files.iter().map(|p| p.to_string()).collect(),
        runs,
        edits,
        ..Default::default()
    }
}

fn record(outcome: TestOutcome, changed: &[&str]) -> Record {
    Record {
        at: 1,
        command: "web".into(),
        outcome,
        total: 3,
        failed: u64::from(outcome == TestOutcome::Red),
        changed_files_fingerprint: "fp".into(),
        changed_files: changed.iter().map(|p| p.to_string()).collect(),
        failing: Vec::new(),
        log: String::new(),
    }
}

// ---- the order: red, then the fix ------------------------------------------------------------------------------------

#[test]
fn a_red_run_of_the_new_test_before_the_first_source_edit_is_enough() {
    let proof = evidence(
        &["src/math.test.ts"],
        vec![
            run("npx vitest run src/math.test.ts", 3.0, VITEST_FAIL),
            run("npx vitest run src/math.test.ts", 7.0, VITEST_PASS),
        ],
        vec![
            edit("src/math.test.ts", 2.0),
            edit("src/math.ts", 5.0),
            edit("src/math.test.ts", 6.0),
        ],
    );
    assert_eq!(no_red_before_fix(&proof), None);
}

#[test]
fn a_red_run_after_the_first_source_edit_is_a_gap_whatever_it_shows() {
    let late = evidence(
        &["src/math.test.ts"],
        vec![run("npx vitest run src/math.test.ts", 5.0, VITEST_FAIL)],
        vec![edit("src/math.ts", 2.0), edit("src/math.test.ts", 3.0)],
    );
    assert_eq!(
        no_red_before_fix(&late),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
    // The same run before the edit is fine: the order is the whole rule.
    let early = evidence(
        &["src/math.test.ts"],
        vec![run("npx vitest run src/math.test.ts", 5.0, VITEST_FAIL)],
        vec![edit("src/math.test.ts", 3.0), edit("src/math.ts", 6.0)],
    );
    assert_eq!(no_red_before_fix(&early), None);
}

#[test]
fn the_first_source_edit_counts_from_the_whole_turn_even_when_the_edit_list_was_cut() {
    // The list kept only the last edits, so its first source edit is late; the facts say the real one was early.
    let mut cut = evidence(
        &["src/math.test.ts"],
        vec![run("npx vitest run src/math.test.ts", 30.0, VITEST_FAIL)],
        vec![edit("src/math.test.ts", 2.0), edit("src/math.ts", 40.0)],
    );
    cut.first_code_edit_at = Some(10.0);
    assert_eq!(no_red_before_fix(&cut), Some(NO_RED_BEFORE_FIX.to_string()));
}

#[test]
fn a_documents_edit_is_not_a_source_edit_and_a_test_edit_is_not_either() {
    let proof = evidence(
        &["src/math.test.ts"],
        vec![run("npx vitest run src/math.test.ts", 5.0, VITEST_FAIL)],
        vec![
            edit("docs/notes.md", 1.0),
            edit("src/math.test.ts", 2.0),
            edit("tests/helpers.ts", 3.0),
            edit("src/math.ts", 6.0),
        ],
    );
    assert_eq!(no_red_before_fix(&proof), None);
}

// ---- what counts as red ----------------------------------------------------------------------------------------------

#[test]
fn a_red_from_a_build_error_or_zero_tests_or_a_file_that_would_not_load_does_not_count() {
    for (name, output) in [
        ("compile error", CARGO_COMPILE_ERROR),
        ("zero tests", CARGO_ZERO),
        ("a test file that would not load", VITEST_IMPORT_ERROR),
        ("no summary at all", "npm ERR! Test failed.\n"),
    ] {
        let proof = evidence(
            &["src/math.test.ts"],
            vec![run("npm test", 3.0, output)],
            vec![edit("src/math.test.ts", 2.0), edit("src/math.ts", 5.0)],
        );
        assert_eq!(
            no_red_before_fix(&proof),
            Some(NO_RED_BEFORE_FIX.to_string()),
            "{name}"
        );
    }
}

#[test]
fn a_green_run_only_is_a_gap_and_so_is_no_run_at_all() {
    let green = evidence(
        &["src/math.test.ts"],
        vec![run("npm test", 3.0, VITEST_PASS)],
        vec![edit("src/math.test.ts", 2.0), edit("src/math.ts", 5.0)],
    );
    assert_eq!(
        no_red_before_fix(&green),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
    let none = evidence(
        &["src/math.test.ts"],
        Vec::new(),
        vec![edit("src/math.test.ts", 2.0), edit("src/math.ts", 5.0)],
    );
    assert_eq!(
        no_red_before_fix(&none),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
}

#[test]
fn a_fix_that_adds_or_changes_no_test_file_is_a_gap_because_nothing_could_have_been_red() {
    let proof = evidence(
        &[],
        vec![run("npm test", 3.0, VITEST_FAIL)],
        vec![edit("src/math.ts", 5.0)],
    );
    assert_eq!(
        no_red_before_fix(&proof),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
}

#[test]
fn a_run_with_no_source_edit_in_the_turn_is_before_it() {
    // The worker only wrote the test this turn (the fix was in an earlier round or is still to come).
    let proof = evidence(
        &["src/math.test.ts"],
        vec![run("npm test", 3.0, VITEST_FAIL)],
        vec![edit("src/math.test.ts", 2.0)],
    );
    assert_eq!(no_red_before_fix(&proof), None);
}

// ---- touching a test the diff adds or changes ------------------------------------------------------------------------

#[test]
fn a_red_run_of_some_other_test_does_not_count() {
    // A narrow run that names another file, and whose output names that file only.
    let proof = evidence(
        &["web/new.test.ts"],
        vec![run("npx vitest run src/math.test.ts", 3.0, VITEST_FAIL)],
        vec![edit("web/new.test.ts", 2.0), edit("web/new.ts", 5.0)],
    );
    assert_eq!(
        no_red_before_fix(&proof),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
    // Naming it in the command, or finding it in the output, is touching it.
    let by_command = evidence(
        &["src/math.test.ts"],
        vec![run(
            "npx vitest run src/math.test.ts",
            3.0,
            "Tests  1 failed (1)\n",
        )],
        vec![edit("src/math.test.ts", 2.0), edit("src/math.ts", 5.0)],
    );
    assert_eq!(no_red_before_fix(&by_command), None);
    let by_output = evidence(
        &["src/math.test.ts"],
        vec![run("npx vitest run -t adds", 3.0, VITEST_FAIL)],
        vec![edit("src/math.test.ts", 2.0), edit("src/math.ts", 5.0)],
    );
    assert_eq!(no_red_before_fix(&by_output), None);
    // The file's name alone is enough, and a Windows path reads the same.
    let by_name = evidence(
        &["src\\math.test.ts"],
        vec![run("npm test", 3.0, VITEST_FAIL)],
        vec![edit("src\\math.test.ts", 2.0), edit("src\\math.ts", 5.0)],
    );
    assert_eq!(no_red_before_fix(&by_name), None);
}

#[test]
fn a_whole_suite_run_touches_every_test_that_existed_then_and_not_one_written_after() {
    let existed = evidence(
        &["src/lib_tests.rs"],
        vec![run("cargo test", 3.0, CARGO_FAIL)],
        vec![edit("src/lib_tests.rs", 1.0), edit("src/lib.rs", 5.0)],
    );
    assert_eq!(no_red_before_fix(&existed), None);
    let written_after = evidence(
        &["src/lib_tests.rs"],
        vec![run("cargo test", 3.0, CARGO_FAIL)],
        vec![edit("src/lib.rs", 4.0), edit("src/lib_tests.rs", 6.0)],
    );
    assert_eq!(
        no_red_before_fix(&written_after),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
    // A run with a filter flag is not a whole-suite run, so it must name the file itself.
    let filtered = evidence(
        &["src/lib_tests.rs"],
        vec![run("cargo test -p other --lib", 3.0, CARGO_FAIL)],
        vec![edit("src/lib_tests.rs", 1.0), edit("src/lib.rs", 5.0)],
    );
    assert_eq!(
        no_red_before_fix(&filtered),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
}

// ---- the app's own records of run_checks -----------------------------------------------------------------------------

#[test]
fn a_red_record_made_when_only_tests_had_changed_is_proof_with_no_transcript_at_all() {
    let mut proof = evidence(&["src/math.test.ts"], Vec::new(), Vec::new());
    proof.records = vec![record(TestOutcome::Red, &["src/math.test.ts"])];
    assert_eq!(no_red_before_fix(&proof), None);
    // Documents beside the test do not make the state "after the fix".
    proof.records = vec![record(
        TestOutcome::Red,
        &["src/math.test.ts", "docs/plan.md"],
    )];
    assert_eq!(no_red_before_fix(&proof), None);
}

#[test]
fn a_red_record_made_after_a_source_file_had_changed_is_not_proof() {
    let mut late = evidence(&["src/math.test.ts"], Vec::new(), Vec::new());
    late.records = vec![record(
        TestOutcome::Red,
        &["src/math.test.ts", "src/math.ts"],
    )];
    assert_eq!(
        no_red_before_fix(&late),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
}

#[test]
fn a_green_or_inconclusive_record_is_not_proof_and_neither_is_one_that_saw_no_changed_test() {
    let mut proof = evidence(&["src/math.test.ts"], Vec::new(), Vec::new());
    proof.records = vec![
        record(TestOutcome::Green, &["src/math.test.ts"]),
        record(TestOutcome::Inconclusive, &["src/math.test.ts"]),
        record(TestOutcome::Red, &["src/other.test.ts"]),
        record(TestOutcome::Red, &[]),
    ];
    assert_eq!(
        no_red_before_fix(&proof),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
}

#[test]
fn a_record_whose_list_of_changed_files_was_cut_does_not_prove_the_order() {
    let many: Vec<String> = (0..crate::run_checks::MAX_PATHS)
        .map(|n| format!("src/gen{n}.test.ts"))
        .collect();
    let refs: Vec<&str> = std::iter::once("src/math.test.ts")
        .chain(many.iter().map(String::as_str))
        .take(crate::run_checks::MAX_PATHS)
        .collect();
    let mut cut = evidence(&["src/math.test.ts"], Vec::new(), Vec::new());
    cut.records = vec![record(TestOutcome::Red, &refs)];
    assert_eq!(no_red_before_fix(&cut), Some(NO_RED_BEFORE_FIX.to_string()));
}

#[test]
fn a_red_an_earlier_round_already_showed_stands_in_later_rounds() {
    // The worker's next turn starts a fresh transcript; the round that saw the red is remembered.
    let mut later = evidence(
        &["src/math.test.ts"],
        Vec::new(),
        vec![edit("src/math.ts", 5.0)],
    );
    assert_eq!(
        no_red_before_fix(&later),
        Some(NO_RED_BEFORE_FIX.to_string())
    );
    later.red_seen_before = true;
    assert_eq!(no_red_before_fix(&later), None);
}

// ---- the gap's wording and the filter that drops it ------------------------------------------------------------------

#[test]
fn the_gap_reads_in_plain_words_and_is_recognised_by_them() {
    assert_eq!(
        NO_RED_BEFORE_FIX,
        "No failing run of a new or changed test was seen before the fix."
    );
    assert!(is_no_red_gap(NO_RED_BEFORE_FIX));
    for other in [
        "Tests went stale after the last edit.",
        "A check failed: npm test.",
        "There is still an open to-do: x.",
        "",
    ] {
        assert!(!is_no_red_gap(other), "{other:?}");
    }
}

// ---- which briefs are bug fixes ---------------------------------------------------------------------------------------

#[test]
fn a_fix_is_the_first_mates_word_or_the_briefs_own() {
    // kind: "fix" is enough whatever the words say.
    assert!(is_fix_brief(
        Some("fix"),
        "Add the export",
        "export exists",
        "Add b."
    ));
    for title in [
        "Fix the save bug",
        "Fixes the crash on open",
        "The export is broken",
        "Regression in the sidebar",
        "bugfix: trim the name",
        "Hotfix for the login",
        "Crashing when the folder is empty",
        "FIXED the layout",
    ] {
        assert!(is_fix_brief(None, title, "", ""), "{title}");
    }
    // The goal says it too.
    assert!(is_fix_brief(None, "Save", "the crash is gone", ""));
}

#[test]
fn words_that_only_contain_those_words_are_not_a_fix() {
    for title in [
        "Add a fixture for the tests",
        "Prefix the ids",
        "Suffix handling",
        "Debug logging for the sync",
        "Add the export",
        "Prefixes and bugle calls",
        "Fixture loader",
        "Rename crashlytics",
    ] {
        assert!(!is_fix_brief(None, title, "", ""), "{title}");
    }
    assert!(!is_fix_brief(None, "", "", ""));
    assert!(!is_fix_brief(Some("other"), "Add the export", "", ""));
}

// ---- what the webview sends and what the diff says --------------------------------------------------------------------

#[test]
fn the_runs_and_the_first_source_edit_are_read_from_the_facts_loosely() {
    let value = json!({
        "checks": [],
        "runs": [
            { "command": "npm test", "at": 3, "output": "Tests  1 failed (1)\n" },
            { "command": "", "at": 4, "output": "x" },
            { "command": "npm test", "at": "soon", "output": "x" },
            "junk",
            { "command": "cargo test", "at": 5.5 }
        ],
        "firstCodeEditAt": 9.5
    });
    let (runs, first) = runs_from_value(&value);
    assert_eq!(first, Some(9.5));
    assert_eq!(runs.len(), 2, "{runs:?}");
    assert_eq!(runs[0].command, "npm test");
    assert_eq!(runs[0].at, 3.0);
    assert_eq!(runs[1].command, "cargo test");
    assert_eq!(runs[1].output, "");
    // A bad shape is no runs and no first edit.
    for bad in [
        json!(null),
        json!([]),
        json!({ "runs": 5, "firstCodeEditAt": "x" }),
    ] {
        let (runs, first) = runs_from_value(&bad);
        assert!(runs.is_empty() && first.is_none(), "{bad}");
    }
}

#[test]
fn only_a_test_file_counts_and_a_rust_file_that_gained_tests_is_one() {
    let files = vec![
        ("src/math.ts".to_string(), Some("a".to_string()), Some("b".to_string())),
        ("src/math.test.ts".to_string(), None, Some("it('x')".to_string())),
        ("docs/a.md".to_string(), None, Some("x".to_string())),
        (
            "src/lib.rs".to_string(),
            Some("fn a() {}\n#[cfg(test)]\nmod tests {\n #[test]\n fn one() {}\n}\n".to_string()),
            Some("fn a() {}\n#[cfg(test)]\nmod tests {\n #[test]\n fn one() {}\n #[test]\n fn two() {}\n}\n".to_string()),
        ),
        (
            "src/other.rs".to_string(),
            Some("fn a() {}\n".to_string()),
            Some("fn a() { 1 }\n".to_string()),
        ),
        (
            "src/new.rs".to_string(),
            None,
            Some("fn a() {}\n#[cfg(test)]\nmod tests {\n #[test]\n fn one() {}\n}\n".to_string()),
        ),
        ("tests\\win.ts".to_string(), None, Some("x".to_string())),
    ];
    assert_eq!(
        test_files_in_diff(&files),
        [
            "src/math.test.ts",
            "src/lib.rs",
            "src/new.rs",
            "tests\\win.ts"
        ]
    );
    assert!(test_files_in_diff(&[]).is_empty());
}
