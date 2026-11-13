use std::cell::RefCell;

use super::*;
use crate::test_summary::TestOutcome;

const VITEST_FAIL: &str = include_str!("../test_summary/fixtures/vitest_fail.txt");
const VITEST_PASS: &str = include_str!("../test_summary/fixtures/vitest_pass.txt");
const CARGO_FAIL: &str = include_str!("../test_summary/fixtures/cargo_fail.txt");
const CARGO_PASS: &str = include_str!("../test_summary/fixtures/cargo_pass.txt");
const CARGO_ZERO: &str = include_str!("../test_summary/fixtures/cargo_zero.txt");
const CARGO_COMPILE_ERROR: &str = include_str!("../test_summary/fixtures/cargo_compile_error.txt");

fn file(json: &str) -> ProjectFile {
    crate::project_file::parse(json).expect("a project file")
}

/// A project with two folders' checks and a `check` action beside a dev server.
const PROJECT: &str = r#"{
  "version": 1,
  "actions": [
    { "id": "check", "name": "Check", "command": "npm run check" },
    { "id": "dev", "name": "Dev server", "command": "npm run dev", "longRunning": true }
  ],
  "verify": { "checks": [
    { "id": "web", "name": "Web tests", "command": "npx vitest run", "dir": "web" },
    { "id": "api", "name": "API tests", "command": "cargo test", "dir": "api", "timeoutSeconds": 600 }
  ] }
}"#;

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| p.to_string()).collect()
}

fn ids(steps: Vec<Step>) -> Vec<String> {
    steps.into_iter().map(|s| s.id).collect()
}

/// A folder under the system temp folder, removed when it goes out of scope.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Scratch {
        let dir = std::env::temp_dir().join(format!("run-checks-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Answers each run with the next canned output and remembers what it was asked.
struct Fake {
    answers: RefCell<Vec<Finished>>,
    asked: RefCell<Vec<(Step, Vec<(String, String)>)>>,
}

impl Fake {
    fn saying(outputs: &[&str]) -> Fake {
        Fake {
            answers: RefCell::new(
                outputs
                    .iter()
                    .map(|text| Finished {
                        output: text.to_string(),
                        ended: Ended::Finished,
                    })
                    .collect(),
            ),
            asked: RefCell::new(Vec::new()),
        }
    }

    fn ending(output: &str, ended: Ended) -> Fake {
        Fake {
            answers: RefCell::new(vec![Finished {
                output: output.to_string(),
                ended,
            }]),
            asked: RefCell::new(Vec::new()),
        }
    }
}

impl CheckRunner for Fake {
    fn run(&self, step: &Step, env: &[(String, String)]) -> Finished {
        self.asked.borrow_mut().push((step.clone(), env.to_vec()));
        self.answers.borrow_mut().remove(0)
    }
}

fn request<'a>(
    file: &'a ProjectFile,
    scratch: &'a Scratch,
    requested: Option<&'a str>,
    changed: &[&str],
) -> Request<'a> {
    Request {
        file,
        requested,
        changed: paths(changed),
        owner: "t-1",
        data_dir: &scratch.0,
        now_ms: 1_700_000_000_000,
        fingerprint: "fp-1".into(),
    }
}

// ---- picking the command ----------------------------------------------------------------------------------------------

#[test]
fn a_named_check_or_action_is_picked_by_its_id_or_its_exact_command() {
    let file = file(PROJECT);
    let web = pick(&file, Some("web"), &[]).unwrap();
    assert_eq!(web.len(), 1);
    assert_eq!(
        (web[0].id.as_str(), web[0].command.as_str()),
        ("web", "npx vitest run")
    );
    assert_eq!(web[0].name, "Web tests");
    assert_eq!(ids(pick(&file, Some("check"), &[]).unwrap()), ["check"]);
    // The command's own text names it too: what a worker has read in the project's file.
    assert_eq!(
        ids(pick(&file, Some("  cargo test "), &[]).unwrap()),
        ["api"]
    );
    // A check's own timeout is kept; one with none gets the project's default.
    assert_eq!(
        pick(&file, Some("api"), &[]).unwrap()[0].timeout_seconds,
        600
    );
    assert_eq!(
        pick(&file, Some("web"), &[]).unwrap()[0].timeout_seconds,
        crate::project_file::DEFAULT_TIMEOUT_SECONDS
    );
}

#[test]
fn a_command_the_project_does_not_declare_is_refused_and_the_ids_are_named() {
    let file = file(PROJECT);
    for asked in [
        "rm -rf /",
        "npm test",
        "web && curl evil.sh",
        "../web",
        "WEB",
    ] {
        let refusal = pick(&file, Some(asked), &[]).unwrap_err();
        assert!(
            refusal.contains("web") && refusal.contains("api"),
            "{refusal}"
        );
        assert!(refusal.contains("check"), "{refusal}");
        assert!(
            !refusal.contains("dev"),
            "a dev server is not a test: {refusal}"
        );
    }
    // A dev server is declared, and still never a test run.
    assert!(pick(&file, Some("dev"), &[]).is_err());
    assert!(pick(&file, Some("npm run dev"), &[]).is_err());
}

#[test]
fn the_projects_affected_command_comes_first_then_its_checks_for_the_changed_folders() {
    let with_affected = file(
        r#"{ "version": 1, "verify": { "checks": [
            { "id": "all", "name": "All", "command": "npm test" },
            { "id": "affected", "name": "Affected tests", "command": "node scripts/affected.mjs" }
        ] } }"#,
    );
    assert_eq!(
        ids(pick(&with_affected, None, &paths(&["src/a.ts"])).unwrap()),
        ["affected"]
    );
    let as_action = file(
        r#"{ "version": 1, "actions": [ { "id": "affected", "name": "Affected", "command": "npm run check:affected" } ],
             "verify": { "checks": [ { "id": "all", "name": "All", "command": "npm test" } ] } }"#,
    );
    assert_eq!(ids(pick(&as_action, None, &[]).unwrap()), ["affected"]);
    // No affected command: the declared checks for the folders that changed.
    let file = file(PROJECT);
    assert_eq!(
        ids(pick(&file, None, &paths(&["web/src/a.ts"])).unwrap()),
        ["web"]
    );
    assert_eq!(
        ids(pick(&file, None, &paths(&["api/src/lib.rs", "web/x.ts"])).unwrap()),
        ["web", "api"]
    );
}

#[test]
fn with_no_folder_matched_every_declared_check_runs_and_a_check_action_is_the_last_resort() {
    let file = file(PROJECT);
    assert_eq!(ids(pick(&file, None, &[]).unwrap()), ["web", "api"]);
    assert_eq!(
        ids(pick(&file, None, &paths(&["docs/readme.md"])).unwrap()),
        ["web", "api"]
    );
    let only_action = file_of(
        r#"{ "version": 1, "actions": [ { "id": "check", "name": "Check", "command": "npm run check" } ] }"#,
    );
    assert_eq!(ids(pick(&only_action, None, &[]).unwrap()), ["check"]);
}

fn file_of(json: &str) -> ProjectFile {
    file(json)
}

#[test]
fn a_project_with_no_test_command_is_refused_in_plain_words() {
    let nothing = file(r#"{ "version": 1 }"#);
    assert_eq!(pick(&nothing, None, &[]).unwrap_err(), NO_COMMAND);
    assert_eq!(
        NO_COMMAND,
        "This project declares no test command. Run its tests yourself and say so in your report."
    );
    let only_a_server = file(
        r#"{ "version": 1, "actions": [ { "id": "dev", "name": "Dev", "command": "npm run dev", "longRunning": true } ] }"#,
    );
    assert_eq!(pick(&only_a_server, None, &[]).unwrap_err(), NO_COMMAND);
    // A blank request is no request.
    assert_eq!(
        ids(pick(&file(PROJECT), Some("   "), &[]).unwrap()),
        ["web", "api"]
    );
}

// ---- the report -------------------------------------------------------------------------------------------------------

#[test]
fn a_red_run_returns_only_the_summary_the_failures_the_counts_and_the_log_path() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let runner = Fake::saying(&[VITEST_FAIL]);
    let report = run_with(
        &request(&file, &scratch, Some("web"), &["web/a.ts"]),
        &runner,
    )
    .unwrap();
    assert_eq!(report.outcome, TestOutcome::Red);
    assert_eq!(report.summary, "Tests  1 failed | 2 passed (3)");
    assert_eq!((report.total, report.failed), (3, 1));
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].name, "src/math.test.ts > math > adds");
    assert!(report.failures[0]
        .message
        .starts_with("AssertionError: expected 2 to be 3"));
    assert_eq!(report.command, "web");
    assert_eq!(report.note, None);
    // The whole output is in the log, which sits under the app's data folder.
    let log = PathBuf::from(&report.log);
    assert!(
        log.starts_with(scratch.0.join(FOLDER).join("t-1")),
        "{log:?}"
    );
    assert_eq!(log.extension().and_then(|e| e.to_str()), Some("log"));
    assert_eq!(std::fs::read_to_string(&log).unwrap(), VITEST_FAIL);
    // What the caller reads is only those fields: not the output, not an exit code.
    let sent = serde_json::to_value(&report).unwrap();
    let mut keys: Vec<&str> = sent
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["command", "failed", "failures", "log", "outcome", "summary", "total"]
    );
    assert_eq!(sent["outcome"], "red");
    assert!(
        !sent.to_string().contains("RUN  v2.1.8"),
        "no output is sent"
    );
}

#[test]
fn a_green_run_names_no_failure() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let runner = Fake::saying(&[CARGO_PASS]);
    let report = run_with(&request(&file, &scratch, Some("api"), &[]), &runner).unwrap();
    assert_eq!(report.outcome, TestOutcome::Green);
    assert_eq!((report.total, report.failed), (2, 0));
    assert!(report.failures.is_empty());
    assert_eq!(report.summary, "cargo test: 2 passed, 0 failed, 0 skipped");
}

#[test]
fn zero_tests_and_a_build_error_before_the_tests_are_inconclusive_and_say_why() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let zero = run_with(
        &request(&file, &scratch, Some("api"), &[]),
        &Fake::saying(&[CARGO_ZERO]),
    )
    .unwrap();
    assert_eq!(zero.outcome, TestOutcome::Inconclusive);
    assert_eq!(zero.total, 0);
    assert!(
        zero.note.as_deref().unwrap_or("").contains("zero tests"),
        "{zero:?}"
    );
    let broken = run_with(
        &request(&file, &scratch, Some("api"), &[]),
        &Fake::saying(&[CARGO_COMPILE_ERROR]),
    )
    .unwrap();
    assert_eq!(broken.outcome, TestOutcome::Inconclusive);
    assert_eq!(broken.summary, "");
    assert!(broken.failures.is_empty());
    assert!(
        broken.note.as_deref().unwrap_or("").contains("build error"),
        "{broken:?}"
    );
    let silent = run_with(
        &request(&file, &scratch, Some("api"), &[]),
        &Fake::saying(&["added 3 packages\n"]),
    )
    .unwrap();
    assert_eq!(silent.outcome, TestOutcome::Inconclusive);
    assert!(
        silent.note.as_deref().unwrap_or("").contains("summary"),
        "{silent:?}"
    );
}

#[test]
fn a_timeout_a_stop_or_a_run_that_could_not_start_is_not_a_verdict_even_with_red_output() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    for (ended, word) in [
        (Ended::TimedOut, "ran past"),
        (Ended::Stopped, "stopped"),
        (
            Ended::NotStarted("npx isn't installed".into()),
            "npx isn't installed",
        ),
    ] {
        let report = run_with(
            &request(&file, &scratch, Some("web"), &[]),
            &Fake::ending(VITEST_FAIL, ended),
        )
        .unwrap();
        assert_eq!(report.outcome, TestOutcome::Inconclusive, "{word}");
        assert!(
            report.note.as_deref().unwrap_or("").contains(word),
            "{report:?}"
        );
        assert!(!report.log.is_empty(), "a log is kept even then");
    }
    // A timeout leaves a record that says so: the gates must not read it as green or red.
    let kept = records(&scratch.0, "t-1");
    assert_eq!(kept.len(), 3);
    assert!(kept.iter().all(|r| r.outcome == TestOutcome::Inconclusive));
}

#[test]
fn failures_are_capped_at_twenty_each_cut_and_the_rest_counted() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let mut output = String::new();
    for n in 0..25 {
        output.push_str(&format!("---- t::case{n} stdout ----\nboom {n}\n\n"));
    }
    output.push_str("failures:\n");
    for n in 0..25 {
        output.push_str(&format!("    t::case{n}\n"));
    }
    output.push_str("\ntest result: FAILED. 0 passed; 25 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n");
    let report = run_with(
        &request(&file, &scratch, Some("api"), &[]),
        &Fake::saying(&[&output]),
    )
    .unwrap();
    assert_eq!(report.outcome, TestOutcome::Red);
    assert_eq!(report.failed, 25);
    assert_eq!(report.failures.len(), MAX_FAILURES);
    assert_eq!(report.more_failures, 5);
    assert_eq!(report.failures[0].name, "t::case0");
    // The record names the same twenty.
    assert_eq!(records(&scratch.0, "t-1")[0].failing.len(), MAX_FAILURES);
}

// ---- the record the gates read ----------------------------------------------------------------------------------------

#[test]
fn every_run_is_recorded_for_the_gates() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let first = run_with(
        &request(&file, &scratch, Some("web"), &["web/a.test.ts", "web/a.ts"]),
        &Fake::saying(&[VITEST_FAIL]),
    )
    .unwrap();
    let mut later = request(&file, &scratch, Some("web"), &["web/a.ts"]);
    later.now_ms += 5_000;
    later.fingerprint = "fp-2".into();
    run_with(&later, &Fake::saying(&[VITEST_PASS])).unwrap();
    let kept = records(&scratch.0, "t-1");
    assert_eq!(kept.len(), 2);
    assert_eq!(
        kept[0],
        Record {
            at: 1_700_000_000_000,
            command: "web".into(),
            outcome: TestOutcome::Red,
            total: 3,
            failed: 1,
            changed_files_fingerprint: "fp-1".into(),
            changed_files: paths(&["web/a.test.ts", "web/a.ts"]),
            failing: vec!["src/math.test.ts > math > adds".into()],
            log: first.log.clone(),
        }
    );
    assert_eq!(kept[1].at, 1_700_000_005_000);
    assert_eq!(kept[1].outcome, TestOutcome::Green);
    assert_eq!(kept[1].changed_files_fingerprint, "fp-2");
    // Another chat's records are not this one's.
    assert!(records(&scratch.0, "t-2").is_empty());
}

#[test]
fn a_refused_call_runs_and_records_nothing() {
    let scratch = Scratch::new();
    let nothing = file(r#"{ "version": 1 }"#);
    let runner = Fake::saying(&[]);
    let refusal = run_with(&request(&nothing, &scratch, None, &[]), &runner).unwrap_err();
    assert_eq!(refusal, NO_COMMAND);
    assert!(runner.asked.borrow().is_empty());
    assert!(records(&scratch.0, "t-1").is_empty());
    assert!(
        !scratch.0.join(FOLDER).exists(),
        "no folder is made for a refusal"
    );
}

#[test]
fn bad_lines_in_the_record_file_are_skipped_and_only_the_newest_are_read() {
    let scratch = Scratch::new();
    let dir = owner_dir(&scratch.0, "t-1");
    std::fs::create_dir_all(&dir).unwrap();
    let good = |n: u64| {
        serde_json::to_string(&Record {
            at: n,
            command: "web".into(),
            outcome: TestOutcome::Green,
            total: 1,
            failed: 0,
            changed_files_fingerprint: "x".into(),
            changed_files: Vec::new(),
            failing: Vec::new(),
            log: String::new(),
        })
        .unwrap()
    };
    let mut text = String::from("not json\n\n{\"at\": \"soon\"}\n");
    for n in 0..(MAX_RECORDS as u64 + 10) {
        text.push_str(&good(n));
        text.push('\n');
    }
    text.push_str("{\"at\": 5, \"command\": \"web\", \"outcome\": \"maybe\", \"total\": 1, \"failed\": 0, \"changedFilesFingerprint\": \"x\", \"log\": \"\"}\n");
    text.push_str("{ torn");
    std::fs::write(dir.join("records.jsonl"), text).unwrap();
    let kept = records(&scratch.0, "t-1");
    assert_eq!(kept.len(), MAX_RECORDS);
    assert_eq!(kept.last().map(|r| r.at), Some(MAX_RECORDS as u64 + 9));
    assert!(kept.windows(2).all(|pair| pair[0].at < pair[1].at));
    // No file at all is no records.
    assert!(records(&scratch.0, "nobody").is_empty());
}

#[test]
fn an_owner_id_cannot_leave_the_runs_folder_and_two_owners_never_share_one() {
    let scratch = Scratch::new();
    let root = scratch.0.join(FOLDER);
    let mut seen = std::collections::HashSet::new();
    for owner in [
        "t-1",
        "../../escape",
        "a/b",
        "a\\b",
        "..",
        ".",
        "",
        "C:\\Windows",
        "spaced name é",
        "t-1 ",
        &"x".repeat(500),
    ] {
        let dir = owner_dir(&scratch.0, owner);
        assert_eq!(dir.parent(), Some(root.as_path()), "{owner:?} -> {dir:?}");
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            !name.is_empty() && name != "." && name != "..",
            "{owner:?} -> {name:?}"
        );
        assert!(!name.contains(['/', '\\']), "{owner:?} -> {name:?}");
        assert!(name.len() <= 120, "{owner:?} -> {name:?}");
        assert!(seen.insert(name), "{owner:?} shares a folder");
    }
    // A plain id is its own folder name, so a person can find it.
    assert_eq!(
        owner_dir(&scratch.0, "t-1")
            .file_name()
            .unwrap()
            .to_string_lossy(),
        "t-1"
    );
    // The escaping owner's run is kept inside the folder.
    let file = file(PROJECT);
    let mut ask = request(&file, &scratch, Some("web"), &[]);
    ask.owner = "../../escape";
    let report = run_with(&ask, &Fake::saying(&[VITEST_PASS])).unwrap();
    assert!(PathBuf::from(&report.log).starts_with(&root));
    assert_eq!(records(&scratch.0, "../../escape").len(), 1);
}

#[test]
fn two_runs_in_the_same_millisecond_keep_two_logs() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let a = run_with(
        &request(&file, &scratch, Some("web"), &[]),
        &Fake::saying(&[VITEST_PASS]),
    )
    .unwrap();
    let b = run_with(
        &request(&file, &scratch, Some("web"), &[]),
        &Fake::saying(&[VITEST_FAIL]),
    )
    .unwrap();
    assert_ne!(a.log, b.log);
    assert_eq!(std::fs::read_to_string(&a.log).unwrap(), VITEST_PASS);
    assert_eq!(std::fs::read_to_string(&b.log).unwrap(), VITEST_FAIL);
}

// ---- several commands, and what the command is given -----------------------------------------------------------------

#[test]
fn several_checks_run_in_order_into_one_log_and_the_worst_outcome_wins() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let runner = Fake::saying(&[VITEST_PASS, CARGO_FAIL]);
    let report = run_with(
        &request(&file, &scratch, None, &["web/a.ts", "api/lib.rs"]),
        &runner,
    )
    .unwrap();
    let asked: Vec<String> = runner
        .asked
        .borrow()
        .iter()
        .map(|(s, _)| s.id.clone())
        .collect();
    assert_eq!(asked, ["web", "api"]);
    assert_eq!(report.outcome, TestOutcome::Red);
    assert_eq!((report.total, report.failed), (5, 1));
    assert_eq!(report.command, "web, api");
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].name, "tests::subtracts");
    assert!(
        report.summary.contains("Tests  3 passed (3)"),
        "{}",
        report.summary
    );
    assert!(report.summary.contains("test result") || report.summary.contains("cargo test"));
    let log = std::fs::read_to_string(&report.log).unwrap();
    assert!(log.contains("Web tests") && log.contains("API tests"));
    assert!(log.contains("RUN  v2.1.8") && log.contains("tests::subtracts"));
    // One record for the call, not one per step.
    assert_eq!(records(&scratch.0, "t-1").len(), 1);
}

#[test]
fn a_step_that_prints_no_summary_does_not_veto_a_green_but_a_build_error_or_zero_tests_does() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    // A type check beside the tests: no summary line of its own.
    let lint_then_green = run_with(
        &request(&file, &scratch, None, &["web/a.ts", "api/lib.rs"]),
        &Fake::saying(&["tsc: no errors\n", CARGO_PASS]),
    )
    .unwrap();
    assert_eq!(lint_then_green.outcome, TestOutcome::Green);
    let broken = run_with(
        &request(&file, &scratch, None, &["web/a.ts", "api/lib.rs"]),
        &Fake::saying(&[VITEST_PASS, CARGO_COMPILE_ERROR]),
    )
    .unwrap();
    assert_eq!(broken.outcome, TestOutcome::Inconclusive);
    let zero = run_with(
        &request(&file, &scratch, None, &["web/a.ts", "api/lib.rs"]),
        &Fake::saying(&[VITEST_PASS, CARGO_ZERO]),
    )
    .unwrap();
    assert_eq!(zero.outcome, TestOutcome::Inconclusive);
    // None of the steps printing a summary at all is inconclusive.
    let silent = run_with(
        &request(&file, &scratch, None, &["web/a.ts", "api/lib.rs"]),
        &Fake::saying(&["ok\n", "ok\n"]),
    )
    .unwrap();
    assert_eq!(silent.outcome, TestOutcome::Inconclusive);
}

#[test]
fn the_command_is_given_the_changed_paths_and_nothing_else_of_the_callers() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let runner = Fake::saying(&[VITEST_PASS]);
    let changed = ["web/a b.ts", "web/é.ts", "web\\win.ts", "bad\nname.ts"];
    run_with(&request(&file, &scratch, Some("web"), &changed), &runner).unwrap();
    let asked = runner.asked.borrow();
    let env = &asked[0].1;
    assert_eq!(env.len(), 1, "{env:?}");
    assert_eq!(env[0].0, "MONOCODE_CHANGED_FILES");
    // One path a line; a path with a line break in it can't be one line, so it is left out.
    assert_eq!(env[0].1, "web/a b.ts\nweb/é.ts\nweb\\win.ts");
}

#[test]
fn a_long_list_of_changed_paths_is_cut_in_the_record_and_the_environment() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let many: Vec<String> = (0..MAX_PATHS + 50)
        .map(|n| format!("web/f{n}.ts"))
        .collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    let runner = Fake::saying(&[VITEST_PASS]);
    run_with(&request(&file, &scratch, Some("web"), &refs), &runner).unwrap();
    assert_eq!(records(&scratch.0, "t-1")[0].changed_files.len(), MAX_PATHS);
    assert_eq!(runner.asked.borrow()[0].1[0].1.lines().count(), MAX_PATHS);
}

// ---- keeping the folder small, and what is read back -------------------------------------------------------------------

#[test]
fn logs_past_the_newest_forty_are_removed_and_nothing_else_in_the_folder_is() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let dir = owner_dir(&scratch.0, "t-1");
    std::fs::create_dir_all(&dir).unwrap();
    for n in 1..=45u64 {
        std::fs::write(dir.join(format!("{n:013}.log")), "old").unwrap();
    }
    // Not logs this module made: another file, a folder with a log's name, a name with another shape, a unicode name.
    std::fs::write(dir.join("notes.txt"), "keep").unwrap();
    std::fs::write(dir.join("records.jsonl"), "").unwrap();
    std::fs::create_dir_all(dir.join(format!("{:013}.log", 99u64))).unwrap();
    std::fs::write(dir.join("123.log"), "keep").unwrap();
    std::fs::write(dir.join("é-00000000001.log"), "keep").unwrap();
    let report = run_with(
        &request(&file, &scratch, Some("web"), &[]),
        &Fake::saying(&[VITEST_PASS]),
    )
    .unwrap();
    let mut logs: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| is_log_name(name))
        .collect();
    logs.sort();
    assert_eq!(logs.len(), KEEP_LOGS, "{logs:?}");
    // The newest are kept: the run just made, and the 39 before it.
    assert!(logs.contains(&"1700000000000.log".to_string()));
    assert!(PathBuf::from(&report.log).is_file());
    assert!(!dir.join(format!("{:013}.log", 1u64)).exists());
    assert!(dir.join(format!("{:013}.log", 45u64)).exists());
    // 45 old logs and the new one is 46: the 6 oldest go.
    assert!(dir.join(format!("{:013}.log", 7u64)).exists());
    assert!(!dir.join(format!("{:013}.log", 6u64)).exists());
    for kept in ["notes.txt", "records.jsonl", "123.log", "é-00000000001.log"] {
        assert!(dir.join(kept).exists(), "{kept}");
    }
    assert!(dir.join(format!("{:013}.log", 99u64)).is_dir());
}

#[test]
fn only_the_logs_this_module_names_are_logs() {
    for yes in [
        "1700000000000.log",
        "0000000000001.log",
        "1700000000000-2.log",
        "1700000000000-123.log",
    ] {
        assert!(is_log_name(yes), "{yes}");
    }
    for no in [
        "",
        ".log",
        "1700000000000",
        "170000000000.log",
        "17000000000000.log",
        "1700000000000-.log",
        "1700000000000-x.log",
        "1700000000000_2.log",
        "abc0000000000.log",
        "é700000000000.log",
        "records.jsonl",
        "1700000000000.log.bak",
    ] {
        assert!(!is_log_name(no), "{no}");
    }
}

#[test]
fn a_huge_records_file_is_read_from_its_end_without_its_cut_line() {
    let scratch = Scratch::new();
    let dir = owner_dir(&scratch.0, "t-1");
    std::fs::create_dir_all(&dir).unwrap();
    let good = serde_json::to_string(&Record {
        at: 7,
        command: "web".into(),
        outcome: TestOutcome::Red,
        total: 2,
        failed: 1,
        changed_files_fingerprint: "x".into(),
        changed_files: Vec::new(),
        failing: Vec::new(),
        log: String::new(),
    })
    .unwrap();
    // More than the cap of old text with no line break, then two good lines.
    let mut text = "x".repeat(5 * 1024 * 1024);
    text.push('\n');
    text.push_str(&good);
    text.push('\n');
    text.push_str(&good);
    text.push('\n');
    std::fs::write(dir.join("records.jsonl"), text).unwrap();
    let kept = records(&scratch.0, "t-1");
    assert_eq!(kept.len(), 2);
    assert!(kept
        .iter()
        .all(|r| r.at == 7 && r.outcome == TestOutcome::Red));
}

#[test]
fn the_red_seen_mark_is_one_owners_and_is_written_once_it_is_seen() {
    let scratch = Scratch::new();
    assert!(!red_seen(&scratch.0, "t-1"));
    mark_red_seen(&scratch.0, "t-1").unwrap();
    mark_red_seen(&scratch.0, "t-1").unwrap();
    assert!(red_seen(&scratch.0, "t-1"));
    assert!(!red_seen(&scratch.0, "t-2"));
    // An id that would climb out of the folder is its own mark, inside it.
    mark_red_seen(&scratch.0, "../../escape").unwrap();
    assert!(red_seen(&scratch.0, "../../escape"));
    assert!(!scratch.0.parent().unwrap().join("escape").exists());
}

#[test]
fn a_log_over_the_read_cap_keeps_the_tail_where_the_summary_is() {
    let scratch = Scratch::new();
    let file = file(PROJECT);
    let noise = "x".repeat(MAX_LOG_READ as usize + 100);
    let output = format!("{noise}\n{VITEST_PASS}");
    let report = run_with(
        &request(&file, &scratch, Some("web"), &[]),
        &Fake::saying(&[&output]),
    )
    .unwrap();
    assert_eq!(report.outcome, TestOutcome::Green);
}
