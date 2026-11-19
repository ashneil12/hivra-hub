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
    locate(&lines).map(|(_, summary)| summary)
}

/// The last summary and the line it ends on.
fn locate(lines: &[&str]) -> Found {
    [
        vitest(lines),
        cargo(lines),
        nextest(lines),
        node_test(lines),
        pytest(lines),
        go(lines),
        playwright(lines),
    ]
    .into_iter()
    .flatten()
    .max_by_key(|(at, _)| *at)
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
    // A package path never starts with `[`: nextest's `FAIL [   0.004s] crate test` recap lines are not Go packages.
    let fail_pkg_re = regex(&FAIL_PKG, r"^FAIL\s+[^\s\[]\S*");
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

// ---- SC-7: failing tests, and red / green / inconclusive -------------------------------------------------------------------
//
// `failures` names each failing test with the first lines of its message, for the seven runners above. `classify` is
// the call the run_checks tool and the "no red before the fix" gap both make, after Alonso's rule (the one worth copying
// exactly): red is a summary line with more than zero tests and more than zero failures; green is more than zero tests
// and zero failures; anything else is inconclusive (no summary line, zero tests, a build error before the tests ran). The
// exit code is never an input: only what the runner printed.

/// The most lines of a failing test's message that are kept.
pub const MAX_MESSAGE_LINES: usize = 20;
/// The most failing tests read from one log (the caller keeps fewer).
pub const MAX_FAILURES_READ: usize = 200;
/// A line of a message, a test's name: cut past this many characters.
const MAX_LINE_CHARS: usize = 400;
const MAX_NAME_CHARS: usize = 300;
/// Why a run that decides nothing decides nothing, in plain words.
pub const WHY_NO_SUMMARY: &str = "the output has no test summary line";
pub const WHY_ZERO_TESTS: &str = "the runner ran zero tests";
pub const WHY_BUILD_ERROR: &str = "a build error stopped it before every test ran";

/// One failing test: its name and the first lines of what the runner said about it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Failure {
    pub name: String,
    pub message: String,
}

/// A failure and the line of the log it starts on.
type Seen = (usize, Failure);

/// Every failing test in `output`, in the order the runner printed them, each once. A test a runner names in two places
/// (its progress and its failure block; nextest's FAIL lines and its captured output) is one entry with the longer
/// message. A log with no failing test, a compile error and noise give none.
pub fn failures(output: &str) -> Vec<Failure> {
    let text = clean(output);
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let mut seen: Vec<Seen> = Vec::new();
    seen.extend(vitest_failures(&lines));
    seen.extend(cargo_failures(&lines));
    seen.extend(nextest_failures(&lines));
    seen.extend(pytest_failures(&lines));
    seen.extend(go_failures(&lines));
    seen.extend(node_failures(&lines));
    seen.extend(playwright_failures(&lines));
    seen.sort_by_key(|(at, _)| *at);
    let mut out: Vec<Failure> = Vec::new();
    for (_, failure) in seen {
        match out.iter_mut().find(|known| known.name == failure.name) {
            Some(known) => {
                if failure.message.len() > known.message.len() {
                    known.message = failure.message;
                }
            }
            None => {
                if out.len() < MAX_FAILURES_READ {
                    out.push(failure);
                }
            }
        }
    }
    out
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn name_of(text: &str) -> String {
    cut(text.trim(), MAX_NAME_CHARS)
}

/// A message from the lines a runner printed for one test: the leading and trailing blank lines dropped, at most
/// `MAX_MESSAGE_LINES` lines, each cut at `MAX_LINE_CHARS`. Indentation is kept.
fn message_of<S: AsRef<str>>(lines: &[S]) -> String {
    let mut kept: Vec<String> = lines
        .iter()
        .map(|line| line.as_ref().trim_end())
        .skip_while(|line| line.trim().is_empty())
        .take(MAX_MESSAGE_LINES)
        .map(|line| cut(line, MAX_LINE_CHARS))
        .collect();
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    kept.join("\n")
}

/// The lines with the indentation they all share removed.
fn dedented(lines: &[&str]) -> Vec<String> {
    let common = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                String::new()
            } else {
                // `common` counts bytes of leading white space; a character wider than one byte can put it mid-character.
                line.get(common..)
                    .unwrap_or_else(|| line.trim_start())
                    .to_string()
            }
        })
        .collect()
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// ` FAIL  src/a.test.ts > suite > test`, then the message, up to the `⎯⎯⎯` rule that ends the block.
fn vitest_failures(lines: &[&str]) -> Vec<Seen> {
    static FAIL: OnceLock<Regex> = OnceLock::new();
    static NEXTEST: OnceLock<Regex> = OnceLock::new();
    let fail_re = regex(&FAIL, r"^\s*FAIL {1,}(?:\|[^|]*\| +)?(\S.*?)\s*$");
    // nextest's `FAIL [   0.004s] crate test` is not vitest's.
    let nextest_re = regex(&NEXTEST, r"^\[\s*[\d.]+m?s\]\s");
    let mut out = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        let Some(caps) = fail_re.captures(line) else {
            continue;
        };
        if nextest_re.is_match(&caps[1]) {
            continue;
        }
        let mut body = Vec::new();
        for next in &lines[at + 1..] {
            let bare = next.trim_start();
            if bare.starts_with('⎯')
                || fail_re.is_match(next)
                || bare.starts_with("Test Files ")
                || bare.starts_with("Tests ")
            {
                break;
            }
            body.push(*next);
        }
        out.push((
            at,
            Failure {
                name: name_of(&caps[1]),
                message: message_of(&body),
            },
        ));
        if out.len() >= MAX_FAILURES_READ {
            break;
        }
    }
    out
}

/// `---- tests::name stdout ----` blocks (the panic and what the test printed), and the `failures:` list of names that
/// a run with output not captured prints instead.
fn cargo_failures(lines: &[&str]) -> Vec<Seen> {
    static HEADER: OnceLock<Regex> = OnceLock::new();
    let header_re = regex(&HEADER, r"^---- (\S.*?) (?:stdout|stderr) ----$");
    let mut out = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        if out.len() >= MAX_FAILURES_READ {
            break;
        }
        if let Some(caps) = header_re.captures(line.trim()) {
            let mut body: Vec<&str> = Vec::new();
            for next in &lines[at + 1..] {
                let bare = next.trim();
                if bare == "failures:"
                    || bare.starts_with("test result:")
                    || header_re.is_match(bare)
                {
                    break;
                }
                if bare.starts_with("note: run with `RUST_BACKTRACE") {
                    continue;
                }
                body.push(*next);
            }
            out.push((
                at,
                Failure {
                    name: name_of(&caps[1]),
                    message: message_of(&body),
                },
            ));
        } else if line.trim() == "failures:" {
            // The list: indented names, up to a blank line. The first `failures:` is followed by a blank line.
            for (offset, next) in lines[at + 1..].iter().enumerate() {
                if next.trim().is_empty() || !next.starts_with("    ") {
                    break;
                }
                out.push((
                    at + 1 + offset,
                    Failure {
                        name: name_of(next),
                        message: String::new(),
                    },
                ));
            }
        }
    }
    out
}

/// `FAIL [   0.004s] binary test::name` lines, with the message from the test's `--- STDERR: binary test::name ---`.
fn nextest_failures(lines: &[&str]) -> Vec<Seen> {
    static FAIL: OnceLock<Regex> = OnceLock::new();
    static STDERR: OnceLock<Regex> = OnceLock::new();
    let fail_re = regex(
        &FAIL,
        r"^\s*(?:FAIL|TIMEOUT|ABORT|SIGABRT|SIGSEGV)\s+\[\s*[\d.]+m?s\]\s+(\S+)\s+(\S.*?)\s*$",
    );
    let stderr_re = regex(&STDERR, r"^--- STDERR:\s+(\S+)\s+(\S.*?)\s+---$");
    let mut captured: Vec<(String, String)> = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        let Some(caps) = stderr_re.captures(line.trim()) else {
            continue;
        };
        let mut body: Vec<&str> = Vec::new();
        for next in &lines[at + 1..] {
            let bare = next.trim();
            if bare.starts_with("--- STDERR:")
                || bare.starts_with("--- STDOUT:")
                || bare.starts_with("------------")
                || bare.starts_with("Summary [")
            {
                break;
            }
            if bare.starts_with("note: run with `RUST_BACKTRACE") {
                continue;
            }
            body.push(*next);
        }
        captured.push((name_of(&caps[2]), message_of(&body)));
    }
    let mut out = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        if out.len() >= MAX_FAILURES_READ {
            break;
        }
        let Some(caps) = fail_re.captures(line) else {
            continue;
        };
        let name = name_of(&caps[2]);
        let message = captured
            .iter()
            .find(|(known, _)| *known == name)
            .map(|(_, message)| message.clone())
            .unwrap_or_default();
        out.push((at, Failure { name, message }));
    }
    out
}

/// The `FAILURES` section's blocks and the short summary's `FAILED path::name - reason` lines. A test that could not be
/// imported (`ERROR collecting`) is an error of the run, not a failing test: it is not here.
fn pytest_failures(lines: &[&str]) -> Vec<Seen> {
    static SECTION: OnceLock<Regex> = OnceLock::new();
    static HEADER: OnceLock<Regex> = OnceLock::new();
    static RULE: OnceLock<Regex> = OnceLock::new();
    static SHORT: OnceLock<Regex> = OnceLock::new();
    static LOCATION: OnceLock<Regex> = OnceLock::new();
    let section_re = regex(&SECTION, r"^=+ FAILURES =+$");
    let header_re = regex(&HEADER, r"^_{2,} (\S.*?) _{2,}$");
    let rule_re = regex(&RULE, r"^=+ .* =+$");
    let short_re = regex(&SHORT, r"^FAILED (\S.*?)(?: - (.*))?$");
    let location_re = regex(&LOCATION, r"^\S+:\d+: \w+");
    // (header name, line, message)
    let mut blocks: Vec<(String, usize, String)> = Vec::new();
    if let Some(start) = lines
        .iter()
        .position(|line| section_re.is_match(line.trim()))
    {
        let mut at = start + 1;
        while at < lines.len() && !rule_re.is_match(lines[at].trim()) {
            let Some(caps) = header_re.captures(lines[at].trim()) else {
                at += 1;
                continue;
            };
            let header = name_of(&caps[1]);
            let from = at;
            let mut body: Vec<&str> = Vec::new();
            at += 1;
            while at < lines.len()
                && !header_re.is_match(lines[at].trim())
                && !rule_re.is_match(lines[at].trim())
            {
                body.push(lines[at]);
                at += 1;
            }
            let mut said: Vec<String> = body
                .iter()
                .filter(|line| {
                    line.starts_with('E') && (line.len() == 1 || line[1..].starts_with([' ', '\t']))
                })
                .map(|line| line[1..].trim().to_string())
                .collect();
            if said.is_empty() {
                said = body
                    .iter()
                    .map(|line| line.trim_end().to_string())
                    .collect();
            } else if let Some(place) = body
                .iter()
                .rev()
                .find(|line| location_re.is_match(line.trim()))
            {
                said.push(place.trim().to_string());
            }
            blocks.push((header, from, message_of(&said)));
        }
    }
    let mut out = Vec::new();
    let mut used = vec![false; blocks.len()];
    for (at, line) in lines.iter().enumerate() {
        let Some(caps) = short_re.captures(line.trim()) else {
            continue;
        };
        let id = caps[1].trim();
        if !(id.contains("::") || id.contains(".py")) {
            continue;
        }
        let last = id.rsplit("::").next().unwrap_or(id);
        let block = blocks
            .iter()
            .enumerate()
            .find(|(index, (header, _, _))| !used[*index] && header == last);
        let (message, place) = match block {
            Some((index, (_, from, message))) => {
                used[index] = true;
                (message.clone(), *from)
            }
            None => (message_of(&[caps.get(2).map_or("", |m| m.as_str())]), at),
        };
        out.push((
            place,
            Failure {
                name: name_of(id),
                message,
            },
        ));
    }
    for (index, (header, from, message)) in blocks.into_iter().enumerate() {
        if !used[index] {
            out.push((
                from,
                Failure {
                    name: header,
                    message,
                },
            ));
        }
    }
    out.truncate(MAX_FAILURES_READ);
    out
}

/// `--- FAIL: TestName (0.00s)`, with its message after it (`go test`) or, under `-v`, between its `=== RUN` line and
/// it. A subtest is its own entry and not part of its parent's message. A panic is its test's message.
fn go_failures(lines: &[&str]) -> Vec<Seen> {
    static HEADER: OnceLock<Regex> = OnceLock::new();
    static ANY: OnceLock<Regex> = OnceLock::new();
    let header_re = regex(&HEADER, r"^\s*--- FAIL: (\S+) \(");
    let any_re = regex(&ANY, r"^\s*--- (?:PASS|FAIL|SKIP): ");
    let mut out = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        if out.len() >= MAX_FAILURES_READ {
            break;
        }
        let Some(caps) = header_re.captures(line) else {
            continue;
        };
        let name = caps[1].to_string();
        let level = indent_of(line);
        let mut body: Vec<&str> = Vec::new();
        let mut skipping: Option<usize> = None;
        for next in &lines[at + 1..] {
            if next.trim().is_empty() {
                body.push("");
                continue;
            }
            let here = indent_of(next);
            if here <= level {
                break;
            }
            if any_re.is_match(next) {
                skipping = Some(here);
                continue;
            }
            if let Some(nested) = skipping {
                if here > nested {
                    continue;
                }
                skipping = None;
            }
            body.push(*next);
        }
        if body.iter().all(|line| line.is_empty()) {
            // `go test -v` prints what the test logged before its FAIL line, after its `=== RUN` line.
            let ran = (0..at).rev().find(|&j| {
                let bare = lines[j].trim();
                bare.starts_with("=== RUN") && bare.split_whitespace().last() == Some(name.as_str())
            });
            if let Some(ran) = ran {
                body = lines[ran + 1..at]
                    .iter()
                    .copied()
                    .filter(|line| line.starts_with(char::is_whitespace) && !any_re.is_match(line))
                    .collect();
            }
        }
        if body.iter().all(|line| line.is_empty())
            && lines
                .get(at + 1)
                .is_some_and(|next| next.starts_with("panic:"))
        {
            body = lines[at + 1..]
                .iter()
                .copied()
                .take_while(|line| {
                    !(line.starts_with("FAIL")
                        || line.starts_with("exit status")
                        || line.starts_with("ok ")
                        || line.starts_with("=== ")
                        || any_re.is_match(line))
                })
                .collect();
        }
        out.push((
            at,
            Failure {
                name: name_of(&name),
                message: message_of(&body),
            },
        ));
    }
    out
}

/// TAP's `not ok N - name` with its YAML block, and the spec reporter's `✖ name (0.7ms)` with the "failing tests"
/// section's message. A parent suite that only says a subtest failed is not a failure of its own.
fn node_failures(lines: &[&str]) -> Vec<Seen> {
    static TAP: OnceLock<Regex> = OnceLock::new();
    static SPEC: OnceLock<Regex> = OnceLock::new();
    static KEY: OnceLock<Regex> = OnceLock::new();
    let tap_re = regex(&TAP, r"^(\s*)not ok \d+ - (.+?)(?: # (SKIP|TODO).*)?$");
    let spec_re = regex(&SPEC, r"^\s*✖ (.+?) \([\d.]+m?s\)$");
    let key_re = regex(&KEY, r"^(\w+):(?: (.*))?$");
    let mut out: Vec<Seen> = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        if out.len() >= MAX_FAILURES_READ {
            break;
        }
        if let Some(caps) = tap_re.captures(line) {
            if caps.get(3).is_some() {
                continue;
            }
            let base = caps[1].len() + 2;
            let mut block: Vec<&str> = Vec::new();
            let mut open = lines.get(at + 1).is_some_and(|next| next.trim() == "---");
            for next in lines.iter().skip(at + 2) {
                if !open || next.trim() == "..." {
                    break;
                }
                block.push(*next);
            }
            open = open && !block.is_empty();
            let mut said: Vec<String> = Vec::new();
            let mut parent = false;
            let mut expected = None;
            let mut actual = None;
            let mut index = 0;
            while open && index < block.len() {
                let row = block[index];
                index += 1;
                if indent_of(row) != base {
                    continue;
                }
                let Some(key) = key_re.captures(row.trim()) else {
                    continue;
                };
                let value = key.get(2).map_or("", |m| m.as_str()).trim();
                if &key[1] == "failureType" && value.contains("subtestsFailed") {
                    parent = true;
                }
                let mut text: Vec<&str> = Vec::new();
                if value.starts_with('|') {
                    while index < block.len()
                        && (block[index].trim().is_empty() || indent_of(block[index]) > base)
                    {
                        text.push(block[index]);
                        index += 1;
                    }
                }
                match &key[1] {
                    "error" if value.starts_with('|') => said.extend(dedented(&text)),
                    "error" => said.push(value.trim_matches(['\'', '"']).to_string()),
                    "expected" => expected = Some(value.to_string()),
                    "actual" => actual = Some(value.to_string()),
                    _ => {}
                }
            }
            if parent {
                continue;
            }
            if let Some(expected) = expected {
                said.push(format!("expected: {expected}"));
            }
            if let Some(actual) = actual {
                said.push(format!("actual: {actual}"));
            }
            out.push((
                at,
                Failure {
                    name: name_of(&caps[2]),
                    message: message_of(&said),
                },
            ));
        } else if let Some(caps) = spec_re.captures(line) {
            // After the "failing tests" heading the entry carries its message; before it, only its name.
            let reported = lines[..at]
                .iter()
                .any(|before| before.trim() == "✖ failing tests:");
            let mut body: Vec<&str> = Vec::new();
            if reported {
                for next in &lines[at + 1..] {
                    let bare = next.trim_start();
                    if bare.starts_with("test at ") || bare.starts_with("✖ ") {
                        break;
                    }
                    if bare.starts_with("at ") {
                        continue;
                    }
                    body.push(*next);
                }
            }
            out.push((
                at,
                Failure {
                    name: name_of(&caps[1]),
                    message: message_of(&dedented(&body)),
                },
            ));
        }
    }
    out
}

/// `  1) [chromium] › a.spec.ts:7:5 › name ───`, then the error, up to the next one or the counts.
fn playwright_failures(lines: &[&str]) -> Vec<Seen> {
    static HEADER: OnceLock<Regex> = OnceLock::new();
    static COUNT: OnceLock<Regex> = OnceLock::new();
    let header_re = regex(&HEADER, r"^\s*\d+\) (\S.*›.*?)(?:\s+─+)?\s*$");
    let count_re = regex(
        &COUNT,
        r"^\s*\d+ (?:failed|passed|flaky|skipped|interrupted|did not run)\b",
    );
    let mut out = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        if out.len() >= MAX_FAILURES_READ {
            break;
        }
        let Some(caps) = header_re.captures(line) else {
            continue;
        };
        let mut body: Vec<&str> = Vec::new();
        for next in &lines[at + 1..] {
            if header_re.is_match(next)
                || count_re.is_match(next)
                || next.trim_start().starts_with("Serving HTML report")
                || next.trim_start().starts_with("To open last HTML report")
            {
                break;
            }
            body.push(*next);
        }
        let first = body
            .iter()
            .position(|line| !line.trim().is_empty())
            .unwrap_or(body.len());
        out.push((
            at,
            Failure {
                name: name_of(&caps[1]),
                message: message_of(&dedented(&body[first..])),
            },
        ));
    }
    out
}

/// Red, green, or neither.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestOutcome {
    /// A summary line with more than zero tests and more than zero failures.
    Red,
    /// A summary line with more than zero tests and zero failures, and nothing that says part of it did not run.
    Green,
    /// No summary line, zero tests, a build error before the tests ran, a test file that would not load.
    Inconclusive,
}

/// What `classify` made of a log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classified {
    pub outcome: TestOutcome,
    /// The counts of the last summary, when the log has one.
    pub summary: Option<Summary>,
    /// The runner's own summary line (cargo, go, node and Playwright print several, so theirs is a count line); empty
    /// when there is none.
    pub line: String,
    /// Why an inconclusive run is inconclusive.
    pub why: Option<&'static str>,
}

/// What stops a run before its tests: a compile error, a type error, a module that is not there, a test file that would
/// not import. Matched at the start of a line, so a test's own message that quotes one is not one.
fn build_error(line: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = regex(
        &RE,
        r"^(?:error(?:\[E\d+\])?: could not compile|error\[E\d+\]:|error TS\d+:|.*\[(?:build|setup) failed\]|SyntaxError:|ModuleNotFoundError|ImportError while|Error: Cannot find module|Error: Failed to resolve import|.*ERROR collecting |.*errors? during collection)",
    );
    re.is_match(line)
}

/// PT-5: whether any line of the output is one that stops a run before its tests (a compile error, a type error, a module that is not
/// there). A run that printed one beside a red test summary did not fail on its tests alone.
pub(crate) fn has_build_error(output: &str) -> bool {
    let text = clean(output);
    text.lines().map(str::trim).any(build_error)
}

/// The runner's summary line for a summary found at `at`.
fn summary_line(summary: &Summary, lines: &[&str], at: usize) -> String {
    match summary.runner {
        Runner::Vitest | Runner::Nextest => lines.get(at).copied().unwrap_or("").to_string(),
        Runner::Pytest => lines
            .get(at)
            .map(|line| {
                line.trim_matches(|c: char| c == '=' || c == ' ')
                    .to_string()
            })
            .unwrap_or_default(),
        runner => format!(
            "{}: {} passed, {} failed, {} skipped",
            runner.name(),
            summary.passed,
            summary.failed,
            summary.skipped
        ),
    }
}

/// Vitest's `Test Files  1 failed | 2 passed (3)`: how many files failed. A file that would not load runs no tests, so
/// the `Tests` line can say "3 passed" beside it.
fn vitest_files_failed(lines: &[&str]) -> u64 {
    static LINE: OnceLock<Regex> = OnceLock::new();
    static FAILED: OnceLock<Regex> = OnceLock::new();
    let line_re = regex(&LINE, r"^Test Files\s+(.+)$");
    let failed_re = regex(&FAILED, r"(\d+)\s+failed\b");
    lines
        .iter()
        .filter_map(|line| line_re.captures(line))
        .filter_map(|caps| failed_re.captures(&caps[1]).map(|n| number(&n[1])))
        .next_back()
        .unwrap_or(0)
}

/// Red, green or inconclusive, from what the runner printed. Never from an exit code.
pub fn classify(output: &str) -> Classified {
    let text = clean(output);
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let inconclusive = |why: &'static str, summary: Option<Summary>, line: String| Classified {
        outcome: TestOutcome::Inconclusive,
        summary,
        line,
        why: Some(why),
    };
    let Some((at, found)) = locate(&lines) else {
        let why = if lines.iter().any(|line| build_error(line)) {
            WHY_BUILD_ERROR
        } else {
            WHY_NO_SUMMARY
        };
        return inconclusive(why, None, String::new());
    };
    let line = summary_line(&found, &lines, at);
    if found.total == 0 {
        return inconclusive(WHY_ZERO_TESTS, Some(found), line);
    }
    if found.failed > 0 {
        // Go counts "FAIL pkg [build failed]" as a failed package, and pytest counts a collection error as an error: both
        // are a run that stopped before its tests, not a red test.
        let go_build = found.runner == Runner::Go
            && lines
                .iter()
                .any(|l| l.contains("[build failed]") || l.contains("[setup failed]"))
            && !lines.iter().any(|l| l.starts_with("--- FAIL:"));
        let pytest_collection = found.runner == Runner::Pytest
            && lines
                .iter()
                .any(|l| l.contains("ERROR collecting ") || l.contains("during collection"));
        if go_build || pytest_collection {
            return inconclusive(WHY_BUILD_ERROR, Some(found), line);
        }
        return Classified {
            outcome: TestOutcome::Red,
            summary: Some(found),
            line,
            why: None,
        };
    }
    // Nothing failed, and a green is only a green when everything ran: no build error after the summary (a later step of
    // the same command that could not compile) and, for vitest, no test file that failed to load.
    let later_error = lines[at + 1..].iter().any(|l| build_error(l));
    let unloaded = found.runner == Runner::Vitest && vitest_files_failed(&lines) > 0;
    if later_error || unloaded {
        return inconclusive(WHY_BUILD_ERROR, Some(found), line);
    }
    Classified {
        outcome: TestOutcome::Green,
        summary: Some(found),
        line,
        why: None,
    }
}

#[cfg(test)]
mod failure_tests;

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
