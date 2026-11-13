//! SC-4: a brief's check lines, stamp and do-not-touch list: what is accepted, how one run is judged, what the row keeps,
//! and that only the app ever sets `passes`.

use std::cell::Cell;
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::delegations::{record, RecordInput};
use crate::session_store::SessionStore;

fn line(what: &str, command: &str, expect: Option<&str>) -> BriefCheck {
    BriefCheck {
        what: what.into(),
        command: command.into(),
        expect: expect.map(str::to_string),
        passes: None,
        ran_at: None,
        output_tail: None,
    }
}

fn exited(code: i32, output: &str) -> RawRun {
    RawRun {
        ended: Ended::Exited(Some(code)),
        output: output.into(),
        seconds: 0.2,
    }
}

// ---- the lines ----------------------------------------------------------------------------------------------------------

#[test]
fn a_line_is_what_command_and_an_optional_expect_with_passes_left_null() {
    let lines = parse_lines(&json!([
        { "what": "the route answers", "command": "curl -s localhost:3000/score", "expect": "ok" },
        { "what": "  it builds  ", "command": "  npm run build  " }
    ]))
    .unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].expect.as_deref(), Some("ok"));
    assert_eq!(lines[1].what, "it builds");
    assert_eq!(lines[1].command, "npm run build");
    assert_eq!(lines[1].expect, None);
    assert!(lines
        .iter()
        .all(|l| l.passes.is_none() && l.ran_at.is_none()));
    // No list at all is no lines.
    assert!(parse_lines(&Value::Null).unwrap().is_empty());
    assert!(parse_lines(&json!([])).unwrap().is_empty());
}

#[test]
fn a_line_that_names_passes_or_any_other_field_is_refused() {
    for extra in ["passes", "ranAt", "outputTail", "timeout"] {
        let mut item = json!({ "what": "w", "command": "true" });
        item[extra] = json!(true);
        let refused = parse_lines(&json!([item])).unwrap_err();
        assert!(refused.contains(extra), "{refused}");
        assert!(
            refused.contains("The app records whether a check passed"),
            "{refused}"
        );
    }
}

#[test]
fn bad_shapes_are_refused_in_plain_words() {
    for (value, says) in [
        (json!("true"), "list of check lines"),
        (json!({ "what": "w" }), "list of check lines"),
        (json!(["npm test"]), "{what, command, expect}"),
        (json!([{ "command": "true" }]), "what must be true"),
        (
            json!([{ "what": "   ", "command": "true" }]),
            "what must be true",
        ),
        (json!([{ "what": "w" }]), "the command that shows it"),
        (
            json!([{ "what": "w", "command": "  " }]),
            "the command that shows it",
        ),
        (
            json!([{ "what": 3, "command": "true" }]),
            "what must be text",
        ),
        (
            json!([{ "what": "w", "command": ["a"] }]),
            "command must be text",
        ),
    ] {
        let refused = parse_lines(&value).unwrap_err();
        assert!(refused.contains(says), "{value}: {refused}");
    }
}

#[test]
fn a_command_is_one_line_in_any_line_ending() {
    for command in ["a\nb", "a\r\nb", "a\rb"] {
        let refused = parse_lines(&json!([{ "what": "w", "command": command }])).unwrap_err();
        assert!(refused.contains("command is one line"), "{refused}");
    }
    // The same for expect, which would otherwise break the brief's list line.
    let refused =
        parse_lines(&json!([{ "what": "w", "command": "true", "expect": "a\nb" }])).unwrap_err();
    assert!(refused.contains("expect is one line"), "{refused}");
    // A what that spans lines is read as one line (it is prose).
    let lines = parse_lines(&json!([{ "what": "it\r\n  works", "command": "true" }])).unwrap();
    assert_eq!(lines[0].what, "it works");
}

#[test]
fn at_most_twelve_lines_and_four_hundred_characters_each() {
    let many = |n: usize| -> Value {
        Value::Array(
            (0..n)
                .map(|i| json!({ "what": format!("w{i}"), "command": format!("true {i}") }))
                .collect(),
        )
    };
    assert_eq!(parse_lines(&many(12)).unwrap().len(), 12);
    assert!(parse_lines(&many(13)).unwrap_err().contains("at most 12"));
    let long = |n: usize| "é".repeat(n);
    assert!(parse_lines(&json!([{ "what": long(400), "command": "true" }])).is_ok());
    for field in ["what", "command", "expect"] {
        let mut item = json!({ "what": "w", "command": "true", "expect": "x" });
        item[field] = json!(long(401));
        let refused = parse_lines(&json!([item])).unwrap_err();
        assert!(
            refused.contains(field) && refused.contains("400"),
            "{refused}"
        );
    }
}

#[test]
fn a_repeated_line_is_kept_once() {
    let lines = parse_lines(&json!([
        { "what": "builds", "command": "npm run build" },
        { "what": "builds", "command": "npm run build" },
        { "what": "builds", "command": "npm run build", "expect": "exit 0" },
        { "what": "builds again", "command": "npm run build" }
    ]))
    .unwrap();
    assert_eq!(lines.len(), 3);
}

#[test]
fn expect_is_an_exit_code_or_text_and_defaults_to_exit_zero() {
    assert_eq!(line("w", "c", None).expectation(), Expect::Exit(0));
    assert_eq!(line("w", "c", Some("   ")).expectation(), Expect::Exit(0));
    assert_eq!(
        line("w", "c", Some("exit 3")).expectation(),
        Expect::Exit(3)
    );
    assert_eq!(
        line("w", "c", Some("  EXIT   12 ")).expectation(),
        Expect::Exit(12)
    );
    assert_eq!(
        line("w", "c", Some("exit 255")).expectation(),
        Expect::Exit(255)
    );
    for text in [
        "exit 256",
        "exit",
        "exit x",
        "exits 3",
        "exit -1",
        "exit 1 now",
        "the exit 3 path",
    ] {
        assert_eq!(
            line("w", "c", Some(text)).expectation(),
            Expect::Text(text),
            "{text}"
        );
    }
}

// ---- paths --------------------------------------------------------------------------------------------------------------

#[test]
fn a_path_is_read_from_the_projects_root_in_forward_slashes() {
    for (raw, path) in [
        ("src/app.ts", "src/app.ts"),
        ("./src/app.ts", "src/app.ts"),
        ("././src/app.ts", "src/app.ts"),
        ("src\\win\\app.ts", "src/win/app.ts"),
        ("src/", "src"),
        ("src/**", "src"),
        // One path is written one way: doubled slashes and `./` parts don't make another.
        (".//src/app.ts", "src/app.ts"),
        ("src//legacy", "src/legacy"),
        ("src/./legacy/", "src/legacy"),
        ("src\\\\legacy\\.\\a.ts", "src/legacy/a.ts"),
        ("src/**/*.rs", "src/**/*.rs"),
        ("  docs/My Notes/é ü.md  ", "docs/My Notes/é ü.md"),
        ("日本語/ファイル.ts", "日本語/ファイル.ts"),
        ("src/*.rs", "src/*.rs"),
    ] {
        assert_eq!(normal_path(raw).unwrap(), path, "{raw}");
    }
}

#[test]
fn a_path_that_leaves_the_project_or_cannot_be_one_is_refused() {
    for raw in [
        "",
        "   ",
        ".",
        "./",
        "/",
        "**",
        "./:x",
        "/etc/passwd",
        "//server/share",
        "C:\\Users\\x",
        "c:/x",
        "~/x",
        "../x",
        "a/../b",
        "a\\..\\b",
        ":(top)src",
        "src/a\nb",
        "src/a\r\nb",
        "src/\u{7}",
    ] {
        assert!(normal_path(raw).is_err(), "{raw:?}");
    }
    assert!(normal_path(&"a".repeat(401)).is_err());
    assert!(normal_path(&"a".repeat(400)).is_ok());
    // A name that only contains dots is a name, not a way out.
    assert_eq!(normal_path("src/..hidden").unwrap(), "src/..hidden");
}

#[test]
fn the_do_not_touch_list_is_at_most_fifty_paths_without_repeats() {
    assert_eq!(
        parse_leave(&json!(["src/a.ts", "./src/a.ts", "src\\a.ts", "docs"])).unwrap(),
        vec!["src/a.ts".to_string(), "docs".to_string()]
    );
    assert!(parse_leave(&Value::Null).unwrap().is_empty());
    let many = |n: usize| Value::Array((0..n).map(|i| json!(format!("p{i}"))).collect());
    assert_eq!(parse_leave(&many(50)).unwrap().len(), 50);
    assert!(parse_leave(&many(51)).unwrap_err().contains("at most 50"));
    assert!(parse_leave(&json!("src")).is_err());
    assert!(parse_leave(&json!([3])).is_err());
    assert!(parse_leave(&json!(["../x"])).is_err());
}

#[test]
fn a_changed_path_is_under_an_entry_by_name_folder_or_pattern() {
    assert!(under("src/app.ts", "src/app.ts"));
    assert!(under("src", "src/app.ts"));
    assert!(under("src/api", "src/api/score/route.ts"));
    assert!(
        !under("src/app", "src/application.ts"),
        "a prefix of the name is not a folder"
    );
    assert!(!under("src/app.ts", "src/app.tsx"));
    assert!(!under("src", "other/src/app.ts"));
    // Case, separators and a leading ./ do not hide a path.
    assert!(under("SRC/App.ts", "src/app.ts"));
    assert!(under("src\\api", "src/api/x.ts"));
    assert!(under("./src", "src/x.ts"));
    assert!(under("docs/My Notes", "docs/My Notes/é ü.md"));
    // Patterns.
    assert!(under("src/*.rs", "src/lib.rs"));
    assert!(!under("src/*.rs", "src/a/lib.rs"));
    assert!(under("src/**/*.rs", "src/a/b/lib.rs"));
    assert!(
        under("tests/*", "tests/x/y.ts"),
        "a pattern names the folders it matches too"
    );
    assert!(!under("", "src/x.ts"));
}

// ---- judging one run ------------------------------------------------------------------------------------------------------

#[test]
fn exit_zero_passes_and_any_other_exit_fails_by_default() {
    let l = line("it builds", "npm run build", None);
    let passed = judge(&l, &exited(0, "built"));
    assert_eq!(passed.outcome, Outcome::Passed);
    assert_eq!(passed.passes, Some(true));
    assert_eq!(passed.evidence.command, "npm run build");
    assert_eq!(passed.evidence.exit_code, Some(0));
    let failed = judge(&l, &exited(1, "error TS2322"));
    assert_eq!(failed.outcome, Outcome::Failed);
    assert_eq!(failed.passes, Some(false));
    assert!(
        failed.detail.contains("exited 1") && failed.detail.contains("wanted exit 0"),
        "{}",
        failed.detail
    );
    assert!(failed.evidence.output.contains("error TS2322"));
}

#[test]
fn exit_n_passes_only_on_that_exit_code() {
    let l = line("the old test fails first", "npm test", Some("exit 1"));
    assert_eq!(judge(&l, &exited(1, "1 failed")).outcome, Outcome::Passed);
    let zero = judge(&l, &exited(0, "all passed"));
    assert_eq!(
        zero.outcome,
        Outcome::Failed,
        "exit 0 is not the exit the line asked for"
    );
    assert!(zero.detail.contains("wanted exit 1"), "{}", zero.detail);
    assert_eq!(judge(&l, &exited(2, "boom")).outcome, Outcome::Failed);
}

#[test]
fn text_must_be_in_the_output_and_the_exit_must_still_be_zero() {
    let l = line("it answers", "curl localhost", Some("\"ok\": true"));
    assert_eq!(
        judge(&l, &exited(0, "{\"ok\": true}\n")).outcome,
        Outcome::Passed
    );
    let missing = judge(&l, &exited(0, "{\"ok\": false}"));
    assert_eq!(missing.outcome, Outcome::Failed);
    assert!(
        missing.detail.contains("didn't contain"),
        "{}",
        missing.detail
    );
    assert_eq!(missing.passes, Some(false));
    // Text in the output does not rescue a failed exit.
    assert_eq!(
        judge(&l, &exited(7, "{\"ok\": true}")).outcome,
        Outcome::Failed
    );
}

#[test]
fn text_is_trimmed_case_sensitive_and_reads_line_endings_as_one() {
    let l = line("w", "c", Some("  Server started  "));
    assert_eq!(
        judge(&l, &exited(0, "...\nServer started\n")).outcome,
        Outcome::Passed
    );
    assert_eq!(
        judge(&l, &exited(0, "server started")).outcome,
        Outcome::Failed,
        "case matters"
    );
    // The tail of a CRLF log and a CR-only progress line.
    let two = line("w", "c", Some("a"));
    assert_eq!(
        judge(&two, &exited(0, "x\r\na\r\n")).outcome,
        Outcome::Passed
    );
    // `expect` read as text with unicode.
    let accent = line("w", "c", Some("café ✓"));
    assert_eq!(
        judge(&accent, &exited(0, "ok: café ✓ done")).outcome,
        Outcome::Passed
    );
}

#[test]
fn a_command_that_could_not_start_is_not_run_and_never_a_pass() {
    let l = line("w", "nosuchtool --x", None);
    for (run, says) in [
        (
            exited(127, "sh: nosuchtool: command not found"),
            "command not found",
        ),
        (
            exited(126, "sh: ./x: Permission denied"),
            "not allowed to run",
        ),
        (
            RawRun::not_started("the sandbox refused it"),
            "the sandbox refused it",
        ),
        (
            RawRun {
                ended: Ended::TimedOut,
                output: "partial".into(),
                seconds: 600.0,
            },
            "time limit",
        ),
        (
            RawRun {
                ended: Ended::Stopped,
                output: String::new(),
                seconds: 1.0,
            },
            "stopped",
        ),
        (
            RawRun {
                ended: Ended::Unfinished,
                output: String::new(),
                seconds: 1.0,
            },
            "didn't finish",
        ),
        (
            RawRun {
                ended: Ended::Exited(None),
                output: String::new(),
                seconds: 1.0,
            },
            "without an exit code",
        ),
    ] {
        let judged = judge(&l, &run);
        assert_eq!(judged.outcome, Outcome::NotRun, "{says}");
        assert_eq!(
            judged.passes, None,
            "could not run is neither pass nor fail: {says}"
        );
        assert!(
            judged.detail.contains("couldn't run") && judged.detail.contains(says),
            "{}",
            judged.detail
        );
        assert!(
            !judged.evidence.output.is_empty(),
            "the evidence says why: {says}"
        );
    }
    // Asking for exit 127 or 126 does not turn "the shell couldn't start it" into a pass.
    for code in [126, 127] {
        let asked = line("w", "no-such-tool", Some(&format!("exit {code}")));
        let judged = judge(&asked, &exited(code, "sh: no-such-tool: command not found"));
        assert_eq!(judged.outcome, Outcome::NotRun, "exit {code}");
        assert_eq!(judged.passes, None, "exit {code}");
    }
}

#[test]
fn the_runners_own_header_is_not_output_so_the_echoed_command_cannot_meet_an_expect() {
    let header = "$ test -f dist/app.js || true\n# in /work/tally (the build exists)\n\n";
    assert_eq!(
        without_run_header(&format!("{header}real output\n")),
        "real output\n"
    );
    assert_eq!(without_run_header(header), "");
    // No header, or a "$ " that is the command's own first line with no blank line after: left as it is.
    assert_eq!(without_run_header("plain output\n"), "plain output\n");
    assert_eq!(
        without_run_header("$ looks like a prompt\nand nothing after"),
        "$ looks like a prompt\nand nothing after"
    );
    // The file is not there, the command still exits 0, and `dist/app.js` is only in the echo.
    let dir = std::env::temp_dir().join(format!(
        "hivra-briefcheck-log-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("run.log");
    std::fs::write(&log, header).unwrap();
    let read = read_log(&log);
    assert_eq!(read, "");
    let l = line(
        "the build exists",
        "test -f dist/app.js || true",
        Some("dist/app.js"),
    );
    assert_eq!(judge(&l, &exited(0, &read)).outcome, Outcome::Failed);
    // The same log with the path really printed passes.
    std::fs::write(&log, format!("{header}dist/app.js\n")).unwrap();
    assert_eq!(
        judge(&l, &exited(0, &read_log(&log))).outcome,
        Outcome::Passed
    );
    // A log cut to its end (past 8 MB) has no header to take out, so nothing of the output is taken.
    let big = format!("$ x\n\n{}", "y".repeat(LOG_READ_MAX as usize + 10));
    std::fs::write(&log, &big).unwrap();
    let cut = read_log(&log);
    assert_eq!(cut.len(), LOG_READ_MAX as usize);
    assert!(cut.chars().all(|c| c == 'y'));
    // A log that can't be read is nothing, never a panic.
    assert_eq!(read_log(&dir.join("missing.log")), "");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_run_that_executed_zero_tests_could_not_run() {
    let l = line("the new test passes", "cargo test brand_new", None);
    for said in [
        "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 0.00s",
        " No test files found, exiting with code 1",
        "collected 0 items\n",
    ] {
        let judged = judge(&l, &exited(0, said));
        assert_eq!(judged.outcome, Outcome::NotRun, "{said:?}");
        assert_eq!(judged.passes, None);
        assert!(judged.detail.contains("ran zero tests"), "{}", judged.detail);
        assert!(judged.evidence.output.starts_with("ran zero tests"), "{}", judged.evidence.output);
    }
    // Tests that did run are a pass; so is output that is no test report at all.
    assert_eq!(
        judge(&l, &exited(0, "running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.1s")).outcome,
        Outcome::Passed
    );
    assert_eq!(judge(&l, &exited(0, "all good")).outcome, Outcome::Passed);
    // A failing exit stays a failure, whatever the summary says.
    assert_eq!(judge(&l, &exited(1, "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s")).outcome, Outcome::Failed);
}

#[test]
fn the_kept_output_is_the_end_of_the_run_and_two_thousand_characters_at_most() {
    let long = format!("{}END", "x".repeat(5_000));
    let judged = judge(&line("w", "c", None), &exited(0, &long));
    assert!(judged.evidence.output.ends_with("END"));
    assert!(judged.evidence.output.chars().count() <= OUTPUT_MAX + 1);
}

// ---- running the lines ----------------------------------------------------------------------------------------------------

#[test]
fn every_line_runs_in_order_and_each_result_carries_the_rounds_time() {
    let lines = vec![
        line("builds", "npm run build", None),
        line("answers", "curl x", Some("ok")),
        line("missing", "nosuch", None),
    ];
    let seen = Cell::new(0usize);
    let results = run_lines(&lines, 77, Duration::from_secs(60), &mut |index, l| {
        assert_eq!(index, seen.get(), "in order");
        seen.set(seen.get() + 1);
        match l.command.as_str() {
            "npm run build" => exited(0, "built"),
            "curl x" => exited(0, "nope"),
            _ => exited(127, "not found"),
        }
    });
    assert_eq!(seen.get(), 3);
    let passes: Vec<Option<bool>> = results.iter().map(|(_, r)| r.passes).collect();
    assert_eq!(passes, vec![Some(true), Some(false), None]);
    assert!(results.iter().all(|(_, r)| r.ran_at == 77));
    assert_eq!(results[1].1.expect.as_deref(), Some("ok"));
}

#[test]
fn lines_after_the_budget_are_not_run_and_never_failed() {
    let lines = vec![line("a", "a", None), line("b", "b", None)];
    let ran = Cell::new(0);
    let results = run_lines(&lines, 1, Duration::ZERO, &mut |_, _| {
        ran.set(ran.get() + 1);
        std::thread::sleep(Duration::from_millis(5));
        exited(0, "")
    });
    // The first line starts (the budget counts from the start) and spends it; the second does not run.
    assert_eq!(results.len(), 2);
    assert_eq!(results[1].0.outcome, Outcome::NotRun);
    assert!(
        results[1].0.detail.contains("ran out"),
        "{}",
        results[1].0.detail
    );
    assert_eq!(results[1].1.passes, None);
    assert!(ran.get() <= 1);
}

// ---- the row --------------------------------------------------------------------------------------------------------------

fn store_with_task() -> (SessionStore, String) {
    let store = SessionStore::open_in_memory().unwrap();
    let id = {
        let mut conn = store.lock_conn().unwrap();
        record(
            &mut conn,
            RecordInput {
                owner_session: "lead".into(),
                request_id: "r1".into(),
                child_session: "w1".into(),
                title: Some("Add the route".into()),
                brief: Some("Add the score route".into()),
                ..Default::default()
            },
            1,
        )
        .unwrap()
        .id
    };
    (store, id)
}

fn kept(checks: Value, leave: Value, stamp: Option<&str>) -> KeepInput {
    KeepInput {
        stamp: stamp.map(str::to_string),
        checks,
        leave,
    }
}

const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

#[test]
fn the_first_keep_writes_the_stamp_lines_and_list_and_a_retry_changes_nothing() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    assert_eq!(state_of(&conn, &id).unwrap(), BriefState::default());
    let first = kept(
        json!([{ "what": "it builds", "command": "npm run build" }]),
        json!(["src/legacy", "./docs/"]),
        Some(SHA),
    );
    assert!(keep(&conn, &id, &first).unwrap());
    let state = state_of(&conn, &id).unwrap();
    assert_eq!(state.stamp.as_deref(), Some(SHA));
    assert_eq!(state.checks.len(), 1);
    assert_eq!(state.checks[0].passes, None);
    assert_eq!(
        state.leave,
        vec!["src/legacy".to_string(), "docs".to_string()]
    );
    assert_eq!(
        (&state.checks_unreadable, &state.leave_unreadable),
        (&None, &None)
    );
    // A retry under the same request, with a newer HEAD and other lines, keeps the first.
    let again = kept(
        json!([{ "what": "other", "command": "other" }]),
        json!(["src"]),
        Some("fedcba9876543210fedcba9876543210fedcba98"),
    );
    assert!(!keep(&conn, &id, &again).unwrap());
    assert_eq!(state_of(&conn, &id).unwrap(), state);
}

#[test]
fn a_keep_with_no_lines_still_marks_the_brief_as_kept() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    assert!(keep(&conn, &id, &kept(Value::Null, Value::Null, None)).unwrap());
    // A later keep with lines can't add checks a brief never carried.
    let later = kept(
        json!([{ "what": "w", "command": "c" }]),
        Value::Null,
        Some(SHA),
    );
    assert!(!keep(&conn, &id, &later).unwrap());
    assert_eq!(state_of(&conn, &id).unwrap(), BriefState::default());
}

#[test]
fn a_keep_that_names_passes_or_a_bad_stamp_or_task_writes_nothing() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    let sneaky = kept(
        json!([{ "what": "w", "command": "c", "passes": true }]),
        Value::Null,
        Some(SHA),
    );
    assert!(keep(&conn, &id, &sneaky).unwrap_err().contains("passes"));
    assert!(keep(&conn, &id, &kept(Value::Null, json!(["../x"]), None)).is_err());
    assert!(keep(
        &conn,
        &id,
        &kept(Value::Null, Value::Null, Some("not-a-sha"))
    )
    .is_err());
    assert!(keep(&conn, &id, &kept(Value::Null, Value::Null, Some("abc"))).is_err());
    assert!(keep(&conn, "d-nope", &kept(Value::Null, Value::Null, None))
        .unwrap_err()
        .contains("No task"));
    // Nothing above wrote anything: the first honest keep still lands.
    assert!(keep(
        &conn,
        &id,
        &kept(
            json!([{ "what": "w", "command": "c" }]),
            Value::Null,
            Some(SHA)
        )
    )
    .unwrap());
}

fn result(what: &str, command: &str, passes: Option<bool>, at: i64, tail: &str) -> LineResult {
    LineResult {
        what: what.into(),
        command: command.into(),
        expect: None,
        passes,
        ran_at: at,
        output_tail: tail.into(),
    }
}

#[test]
fn results_land_on_their_lines_with_passes_ran_at_and_a_two_thousand_character_tail() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    keep(
        &conn,
        &id,
        &kept(
            json!([{ "what": "builds", "command": "npm run build" }, { "what": "answers", "command": "curl x" }]),
            Value::Null,
            Some(SHA),
        ),
    )
    .unwrap();
    let long = format!("{}END", "y".repeat(5_000));
    let applied = record_results(
        &conn,
        &id,
        &[
            result("builds", "npm run build", Some(true), 10, "built"),
            result("answers", "curl x", Some(false), 10, &long),
            result("not a line", "nothing", Some(true), 10, "x"),
        ],
    )
    .unwrap();
    assert_eq!(applied, 2);
    let state = state_of(&conn, &id).unwrap();
    assert_eq!(state.checks[0].passes, Some(true));
    assert_eq!(state.checks[0].ran_at, Some(10));
    assert_eq!(state.checks[0].output_tail.as_deref(), Some("built"));
    assert_eq!(state.checks[1].passes, Some(false));
    let tail = state.checks[1].output_tail.clone().unwrap();
    assert!(
        tail.ends_with("END") && tail.chars().count() <= OUTPUT_MAX + 1,
        "{}",
        tail.len()
    );
    assert_eq!(
        state.stamp.as_deref(),
        Some(SHA),
        "the stamp and the list are untouched"
    );
}

#[test]
fn a_late_result_never_overwrites_a_newer_one_and_a_retry_keep_never_blanks_results() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    let first = kept(
        json!([{ "what": "builds", "command": "npm run build" }]),
        Value::Null,
        Some(SHA),
    );
    keep(&conn, &id, &first).unwrap();
    record_results(
        &conn,
        &id,
        &[result(
            "builds",
            "npm run build",
            Some(true),
            20,
            "second round",
        )],
    )
    .unwrap();
    // A slower window finishes the first round after the second.
    let late = record_results(
        &conn,
        &id,
        &[result(
            "builds",
            "npm run build",
            Some(false),
            10,
            "first round",
        )],
    )
    .unwrap();
    assert_eq!(late, 0);
    let state = state_of(&conn, &id).unwrap();
    assert_eq!(state.checks[0].passes, Some(true));
    assert_eq!(state.checks[0].output_tail.as_deref(), Some("second round"));
    // The delegation is sent again under the same request: the recorded result stays.
    assert!(!keep(&conn, &id, &first).unwrap());
    assert_eq!(state_of(&conn, &id).unwrap().checks[0].passes, Some(true));
    // The same round time may be written again (a retry of the same round).
    assert_eq!(
        record_results(
            &conn,
            &id,
            &[result("builds", "npm run build", None, 20, "could not run")]
        )
        .unwrap(),
        1
    );
    assert_eq!(state_of(&conn, &id).unwrap().checks[0].passes, None);
}

#[test]
fn results_for_a_task_with_no_lines_or_no_row_change_nothing() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    let r = [result("w", "c", Some(true), 1, "")];
    assert_eq!(record_results(&conn, &id, &r).unwrap(), 0, "no keep yet");
    keep(&conn, &id, &kept(Value::Null, Value::Null, None)).unwrap();
    assert_eq!(record_results(&conn, &id, &r).unwrap(), 0, "no lines");
    assert_eq!(record_results(&conn, "d-nope", &r).unwrap(), 0);
    assert_eq!(record_results(&conn, &id, &[]).unwrap(), 0);
}

#[test]
fn a_row_whose_text_was_damaged_is_unreadable_never_no_checks() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    for (checks, leave) in [
        ("{not json", "[]"),
        // Emptied or blanked text is damage: `keep` always writes `[]` for none, and a row from before is null.
        ("", "[]"),
        ("   ", "[]"),
        ("[]", ""),
        ("[]", " \n"),
        ("[{\"what\":\"\",\"command\":\"c\"}]", "[]"),
        ("[{\"what\":\"w\",\"command\":\"a\\nb\"}]", "[]"),
        ("[]", "{\"x\":1}"),
        ("[]", "[\"../escape\"]"),
        ("[]", "[\"/abs\"]"),
    ] {
        conn.execute(
            "UPDATE delegations SET brief_checks = ?2, brief_leave = ?3 WHERE id = ?1",
            params![id, checks, leave],
        )
        .unwrap();
        let state = state_of(&conn, &id).unwrap();
        // Each damaged column says so, and the one that is fine says nothing.
        let damaged_checks = checks != "[]";
        assert_eq!(
            state.checks_unreadable.is_some(),
            damaged_checks,
            "{checks} {leave}"
        );
        assert_eq!(
            state.leave_unreadable.is_some(),
            !damaged_checks,
            "{checks} {leave}"
        );
        assert!(
            state.checks.is_empty() && state.leave.is_empty(),
            "damage is never read as lines or paths"
        );
    }
    // More lines than a brief may carry is damage too.
    let many = serde_json::to_string(&vec![line("w", "c", None); LINES_MAX + 1]).unwrap();
    conn.execute(
        "UPDATE delegations SET brief_checks = ?2, brief_leave = NULL WHERE id = ?1",
        params![id, many],
    )
    .unwrap();
    assert!(state_of(&conn, &id).unwrap().checks_unreadable.is_some());
    // A damaged stamp is dropped, and says nothing is wrong with the lines.
    conn.execute(
        "UPDATE delegations SET brief_stamp = 'zzz', brief_checks = '[]' WHERE id = ?1",
        params![id],
    )
    .unwrap();
    let state = state_of(&conn, &id).unwrap();
    assert_eq!(
        (state.stamp, state.checks_unreadable, state.leave_unreadable),
        (None, None, None)
    );
}

#[test]
fn a_save_of_the_row_keeps_the_brief_columns() {
    // The row's own moves (settle, gate verdicts) rewrite the row; they must not drop the brief.
    let (store, id) = store_with_task();
    let mut conn = store.lock_conn().unwrap();
    keep(
        &conn,
        &id,
        &kept(
            json!([{ "what": "w", "command": "c" }]),
            json!(["src"]),
            Some(SHA),
        ),
    )
    .unwrap();
    crate::delegations::set_gate_verdict(&mut conn, &id, "failed", "no", None, 5).unwrap();
    let state = state_of(&conn, &id).unwrap();
    assert_eq!(
        (
            state.checks.len(),
            state.leave.len(),
            state.stamp.as_deref()
        ),
        (1, 1, Some(SHA))
    );
}

// ---- who may write passes ---------------------------------------------------------------------------------------------------

#[test]
fn no_command_or_tool_can_write_a_results_row() {
    // `record_results` is called by the gates only. The commands the webview can invoke are the ones lib.rs lists; of this
    // module they may keep a brief and read its stamp, and nothing else.
    let lib = include_str!("../lib.rs");
    let listed: Vec<&str> = lib
        .lines()
        .map(str::trim)
        .filter(|line| line.contains("brief_checks::"))
        .collect();
    assert_eq!(
        listed,
        vec![
            "firstmate::brief_checks::firstmate_brief_keep,",
            "firstmate::brief_checks::firstmate_brief_stamp,",
        ],
        "{listed:?}"
    );
    let source = include_str!("brief_checks.rs");
    let at = source.find("pub fn record_results").unwrap();
    let before = &source[..at];
    let attribute_zone = before.rsplit("\n\n").next().unwrap_or("");
    assert!(
        !attribute_zone.contains("tauri::command"),
        "{attribute_zone}"
    );
    // The one command that takes lines parses them with `parse_lines`, which leaves passes null and refuses a passes.
    let command = source.find("pub fn firstmate_brief_keep").unwrap();
    assert!(
        source[command..].contains("keep(&"),
        "the command goes through keep"
    );
}
