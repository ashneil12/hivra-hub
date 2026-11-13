//! PT-1: a proof tool's output cut down to what a person acts on: the failures, the surviving mutants, the findings.
//!
//! A run is read from what the tool printed, never from its exit code alone: Stryker exits 0 with survivors when no `break`
//! threshold is set, a test runner that ran zero tests exits 0, and `semgrep --error` exits 1 for a warning. What could
//! not run is never a pass: a tool that didn't start, timed out, was stopped, ran zero tests or hit its own error is
//! `CouldNotRun`; a timeout or an unreachable service is not a failure.
//!
//! Property libraries (fast-check, proptest, Hypothesis) have no runner of their own: their properties run in the project's
//! own tests, so `property` reads those runs through `test_summary` (failures and the summary line).
//!
//! The fixtures in the tests are written from each tool's documented output format. No real tool was run.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::catalogue::Tool;
use super::{Outcome, TestRun};
use crate::firstmate::brief_checks::{Ended, RawRun};
use crate::test_summary::{self, TestOutcome};

/// The most finding lines kept, the longest one, and how much of the output's end is kept as the tail.
pub const LINES_MAX: usize = 30;
pub const LINE_MAX: usize = 300;
pub const TAIL_MAX: usize = 1_200;
/// The most of an output read: its end, where a summary is.
const READ_MAX: usize = 4 * 1024 * 1024;
/// The most semgrep report starts tried when looking for its JSON.
const REPORT_TRIES: usize = 20;

/// What a person reads about one tool's run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Interpreted {
    pub outcome: Outcome,
    /// One plain line: what ran, or why it could not.
    pub detail: String,
    /// The failures, survivors or findings, one plain line each (at most `LINES_MAX`, each at most `LINE_MAX`).
    pub lines: Vec<String>,
    /// The end of what it printed, for a failed run and one that could not run.
    pub tail: Option<String>,
}

// ---- small helpers ---------------------------------------------------------------------------------------------------------

/// A pattern compiled once. Every pattern here is a literal checked by the tests, so a bad one is a bug, not input.
fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a valid trim pattern"))
}

/// The tail of the output with colour codes removed and every line break one `\n`.
fn clean(output: &str) -> String {
    static ANSI: OnceLock<Regex> = OnceLock::new();
    let mut start = output.len().saturating_sub(READ_MAX);
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

/// `text` trimmed and cut to `max` characters, with an ellipsis when it was cut.
fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("{n} {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// `1 warning or note`, `3 warnings or notes`.
fn notes(n: usize) -> String {
    if n == 1 {
        "1 warning or note".to_string()
    } else {
        format!("{n} warnings or notes")
    }
}

/// The finding lines, each cut, and no more than `LINES_MAX` of them (the last says how many more there were).
fn capped(lines: Vec<String>) -> Vec<String> {
    let total = lines.len();
    let keep = if total > LINES_MAX {
        LINES_MAX - 1
    } else {
        LINES_MAX
    };
    let mut out: Vec<String> = lines
        .into_iter()
        .take(keep)
        .map(|line| cut(&line, LINE_MAX))
        .collect();
    if total > LINES_MAX {
        out.push(format!("… and {} more", total - keep));
    }
    out
}

/// The last `TAIL_MAX` characters of the output, or nothing when it printed nothing.
fn tail_of(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let count = text.chars().count();
    if count <= TAIL_MAX {
        return Some(text.to_string());
    }
    let kept: String = text.chars().skip(count - (TAIL_MAX - 1)).collect();
    Some(format!("…{}", kept.trim_start()))
}

/// The last `n` lines that say something, each cut.
fn last_lines(text: &str, n: usize) -> Vec<String> {
    let mut lines: Vec<String> = text
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(n)
        .map(|line| cut(line, LINE_MAX))
        .collect();
    lines.reverse();
    lines
}

fn push_unique(list: &mut Vec<String>, line: String) {
    if !list.contains(&line) {
        list.push(line);
    }
}

/// A finished reading. The tail is kept only for a run that failed or could not run.
fn done(outcome: Outcome, detail: impl AsRef<str>, lines: Vec<String>, text: &str) -> Interpreted {
    let tail = if matches!(outcome, Outcome::Failed | Outcome::CouldNotRun) {
        tail_of(text)
    } else {
        None
    };
    Interpreted {
        outcome,
        detail: cut(detail.as_ref(), LINE_MAX),
        lines: capped(lines),
        tail,
    }
}

/// A failing test as one line: its name, what it said first and, for a property test, the seed and the counterexample
/// (what a worker needs to reproduce it).
fn failure_line(failure: &test_summary::Failure, property: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut message = failure
        .message
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    if let Some(first) = message.next() {
        parts.push(first.to_string());
    }
    if property {
        let mut extras = 0;
        for line in message {
            let lower = line.to_lowercase();
            if (lower.contains("counterexample") || lower.contains("seed:")) && extras < 2 {
                parts.push(line.to_string());
                extras += 1;
            }
        }
    }
    let name = failure.name.trim();
    if parts.is_empty() {
        name.to_string()
    } else {
        format!("{name}: {}", parts.join("; "))
    }
}

// ---- the entry points ------------------------------------------------------------------------------------------------------

/// A tool's own run read: how it ended and what it printed. A tool with a second command (`runAlso`) has its outputs
/// joined by the caller, with the first ending that wasn't clean.
pub fn interpret(tool: &Tool, run: &RawRun) -> Interpreted {
    let text = clean(&run.output);
    let could_not = |detail: &str| done(Outcome::CouldNotRun, detail, Vec::new(), &text);
    let code = match &run.ended {
        Ended::Exited(Some(code @ (126 | 127))) => {
            let why = if *code == 127 {
                "command not found"
            } else {
                "not allowed to run"
            };
            return could_not(&format!("the shell couldn't start it (exit {code}: {why})"));
        }
        Ended::Exited(Some(code)) => *code,
        Ended::Exited(None) => return could_not("it ended without an exit code"),
        Ended::NotStarted(why) => return could_not(&format!("it didn't start: {why}")),
        Ended::TimedOut => return could_not("it ran past its time limit, so it didn't finish"),
        Ended::Stopped => return could_not("it was stopped before it finished"),
        Ended::Unfinished => return could_not("it didn't finish"),
    };
    match tool.id.as_str() {
        "stryker" => stryker(code, &text),
        "cargo-mutants" => cargo_mutants(code, &text),
        "mutmut" => mutmut(code, &text),
        "playwright" => playwright(code, &text),
        "e2e" => e2e(code, &text),
        "schemathesis" => schemathesis(code, &text),
        "ast-grep" => ast_grep(code, &text),
        "semgrep" => semgrep(code, &text),
        _ => generic(code, &text),
    }
}

/// A property library's properties, read from the project's own test runs of this round. Zero tests, no summary and a run
/// that didn't happen are "could not run", never a pass.
pub fn property(_tool: &Tool, tests: &[TestRun]) -> Interpreted {
    if tests.is_empty() {
        return done(
            Outcome::CouldNotRun,
            "the project's own tests didn't run, so its properties weren't checked",
            Vec::new(),
            "",
        );
    }
    let combined = tests
        .iter()
        .map(|test| clean(&test.output))
        .collect::<Vec<_>>()
        .join("\n");
    if tests.iter().any(|test| test.outcome == Outcome::Failed) {
        let lines: Vec<String> = test_summary::failures(&combined)
            .iter()
            .map(|failure| failure_line(failure, true))
            .collect();
        let detail = if lines.is_empty() {
            "the project's own tests failed, and they run its properties".to_string()
        } else {
            format!(
                "{} in the project's own tests, which run its properties",
                plural(lines.len(), "failing test")
            )
        };
        return done(Outcome::Failed, detail, lines, &combined);
    }
    if tests.iter().any(|test| test.outcome != Outcome::Passed) {
        return done(
            Outcome::CouldNotRun,
            "the project's own tests couldn't run, so its properties weren't checked",
            Vec::new(),
            &combined,
        );
    }
    let (mut total, mut passed, mut skipped, mut any) = (0u64, 0u64, 0u64, false);
    for test in tests {
        if let Some(summary) = test_summary::parse(&test.output) {
            any = true;
            total += summary.total;
            passed += summary.passed;
            skipped += summary.skipped;
        }
    }
    if !any && tests.iter().all(|test| test.output.trim().is_empty()) {
        // The ship check keeps a passed check step's outcome and not its log (a step that ran zero tests was already made "could
        // not run" by the verify stage). Outcomes are all there is to read, and every one passed.
        return done(
            Outcome::Passed,
            "its properties run with the project's checks, which passed",
            Vec::new(),
            "",
        );
    }
    if !any {
        return done(
            Outcome::CouldNotRun,
            "the project's tests printed no test summary, so its properties weren't checked",
            Vec::new(),
            &combined,
        );
    }
    if total == 0 {
        return done(
            Outcome::CouldNotRun,
            "the project's tests ran zero tests, so its properties weren't checked",
            Vec::new(),
            &combined,
        );
    }
    let skipped_note = if skipped > 0 {
        format!(", {skipped} skipped")
    } else {
        String::new()
    };
    done(
        Outcome::Passed,
        format!("its properties run with the project's tests: {passed} passed{skipped_note}"),
        Vec::new(),
        &combined,
    )
}

// ---- no tool of its own ----------------------------------------------------------------------------------------------------

/// Any other tool: exit 0 passes, anything else fails with the end of what it said.
fn generic(code: i32, text: &str) -> Interpreted {
    if code == 0 {
        done(Outcome::Passed, "ran and passed", Vec::new(), text)
    } else {
        done(
            Outcome::Failed,
            format!("it failed (exit {code})"),
            last_lines(text, 10),
            text,
        )
    }
}

// ---- StrykerJS -------------------------------------------------------------------------------------------------------------

/// Each `#12. [Survived] Mutator` block of the clear-text report: where, which mutator and the changed line.
fn stryker_survivors(text: &str) -> Vec<String> {
    static HEAD: OnceLock<Regex> = OnceLock::new();
    static AT: OnceLock<Regex> = OnceLock::new();
    let head = regex(&HEAD, r"^#\d+\.\s*\[(Survived|NoCoverage)\]\s+(\S+)");
    let at = regex(&AT, r"^(.+?):(\d+):(\d+)$");
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let mut out: Vec<String> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(caps) = head.captures(line) else {
            continue;
        };
        let uncovered = &caps[1] == "NoCoverage";
        let mutator = &caps[2];
        let located = lines.get(index + 1).and_then(|next| at.captures(next));
        let place = match &located {
            Some(place) => format!("{}:{}", &place[1], &place[2]),
            None => "(an unknown place)".to_string(),
        };
        let (mut old, mut new) = (String::new(), String::new());
        let from = index + if located.is_some() { 2 } else { 1 };
        for next in lines.iter().skip(from) {
            if next.contains('|') {
                break;
            }
            if let Some(rest) = next.strip_prefix('-') {
                if old.is_empty() {
                    old = rest.trim().to_string();
                }
            } else if let Some(rest) = next.strip_prefix('+') {
                if new.is_empty() {
                    new = rest.trim().to_string();
                }
            } else {
                break;
            }
        }
        let change = match (old.is_empty(), new.is_empty()) {
            (false, false) => format!(" (-{} / +{})", cut(&old, 60), cut(&new, 60)),
            (false, true) => format!(" (-{})", cut(&old, 60)),
            (true, false) => format!(" (+{})", cut(&new, 60)),
            (true, true) => String::new(),
        };
        out.push(if uncovered {
            format!("{place}: {mutator}: no test covers it{change}")
        } else {
            format!("{place}: {mutator} survived{change}")
        });
    }
    out
}

/// The `All files` row of the clear-text table: how many mutants were tested, and how many were not caught.
fn stryker_table(text: &str) -> Option<(usize, usize)> {
    static ROW: OnceLock<Regex> = OnceLock::new();
    let row = regex(
        &ROW,
        r"(?m)^\s*All files\s*\|\s*(?:[\d.]+|n/a)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)",
    );
    let caps = row.captures(text)?;
    let n = |at: usize| caps[at].parse::<usize>().unwrap_or(0);
    let (killed, timeout, survived, uncovered) = (n(1), n(2), n(3), n(4));
    Some((
        killed + timeout + survived + uncovered,
        survived + uncovered,
    ))
}

fn stryker(code: i32, text: &str) -> Interpreted {
    static NONE: OnceLock<Regex> = OnceLock::new();
    static SCORE: OnceLock<Regex> = OnceLock::new();
    let none = regex(
        &NONE,
        r"(?i)no mutants? (?:were )?(?:found|generated)|found 0 mutants?|with 0 mutants?\b|0 mutants? (?:were )?(?:found|generated)",
    );
    let score = regex(&SCORE, r"(?i)mutation score");
    let survivors = stryker_survivors(text);
    let table = stryker_table(text);
    // The exit code is not trusted: without a `break` threshold Stryker exits 0 with survivors.
    if !survivors.is_empty() {
        return done(
            Outcome::Failed,
            format!(
                "{} survived: the tests didn't notice the code being changed there",
                plural(survivors.len(), "mutant")
            ),
            survivors,
            text,
        );
    }
    if let Some((_, uncaught)) = table.filter(|(_, uncaught)| *uncaught > 0) {
        return done(
            Outcome::Failed,
            format!(
                "{} survived (the report didn't name them)",
                plural(uncaught, "mutant")
            ),
            Vec::new(),
            text,
        );
    }
    if none.is_match(text) || table.is_some_and(|(tested, _)| tested == 0) {
        return done(
            Outcome::NotRun,
            "no mutants in the changed lines",
            Vec::new(),
            text,
        );
    }
    let reported = table.is_some() || score.is_match(text);
    if code == 0 && reported {
        let detail = match table {
            Some((tested, _)) => format!("{} tested, none survived", plural(tested, "mutant")),
            None => "no mutant survived".to_string(),
        };
        return done(Outcome::Passed, detail, Vec::new(), text);
    }
    if code == 0 {
        return done(
            Outcome::CouldNotRun,
            "it printed no mutation report",
            Vec::new(),
            text,
        );
    }
    done(
        Outcome::CouldNotRun,
        format!("it stopped with an error (exit {code}) before it reported on any mutant"),
        Vec::new(),
        text,
    )
}

// ---- cargo-mutants ---------------------------------------------------------------------------------------------------------

/// The missed mutants: `MISSED path:line:col: description in 0.4s build + 0.3s test` lines of the run, or, when there are
/// none, the bare `path:line:col: replace ...` lines of `mutants.out/missed.txt`.
fn missed_mutants(text: &str) -> Vec<String> {
    static MISSED: OnceLock<Regex> = OnceLock::new();
    static TIMING: OnceLock<Regex> = OnceLock::new();
    static BARE: OnceLock<Regex> = OnceLock::new();
    let missed = regex(&MISSED, r"^MISSED\s+(\S+?):(\d+)(?::\d+)?:\s+(\S.*)$");
    let timing = regex(
        &TIMING,
        r"\s+in\s+[\d.]+s(?:\s+build\s*\+\s*[\d.]+s\s+test)?\s*$",
    );
    let bare = regex(&BARE, r"^(\S+?):(\d+):\d+:\s+((?:replace|delete)\s.*)$");
    let mut out: Vec<String> = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(caps) = missed.captures(line) {
            let description = timing.replace(&caps[3], "").trim().to_string();
            push_unique(
                &mut out,
                format!("{}:{}: {description}", &caps[1], &caps[2]),
            );
        }
    }
    if out.is_empty() {
        for line in text.lines().map(str::trim) {
            if let Some(caps) = bare.captures(line) {
                let description = timing.replace(&caps[3], "").trim().to_string();
                push_unique(
                    &mut out,
                    format!("{}:{}: {description}", &caps[1], &caps[2]),
                );
            }
        }
    }
    out
}

fn cargo_mutants(code: i32, text: &str) -> Interpreted {
    static ZERO: OnceLock<Regex> = OnceLock::new();
    static TESTED: OnceLock<Regex> = OnceLock::new();
    let zero = regex(&ZERO, r"(?i)found 0 mutants|no mutants (?:to test|found)");
    let tested = regex(&TESTED, r"(?m)^(\d+ mutants? tested.*)$");
    let missed = missed_mutants(text);
    if !missed.is_empty() {
        return done(
            Outcome::Failed,
            format!(
                "{} missed: the tests still passed when the code was changed there",
                plural(missed.len(), "mutant")
            ),
            missed,
            text,
        );
    }
    match code {
        0 if zero.is_match(text) => done(
            Outcome::NotRun,
            "no mutants in the changed lines",
            Vec::new(),
            text,
        ),
        0 => {
            let detail = tested
                .captures(text)
                .map(|caps| caps[1].trim().to_string())
                .unwrap_or_else(|| "no mutant was missed".to_string());
            done(Outcome::Passed, detail, Vec::new(), text)
        }
        2 => done(
            Outcome::Failed,
            "mutants were missed, but the output didn't name them",
            Vec::new(),
            text,
        ),
        3 => done(
            Outcome::CouldNotRun,
            "some mutants timed out, so the tests weren't shown to catch them",
            Vec::new(),
            text,
        ),
        4 => done(
            Outcome::CouldNotRun,
            "the project's tests failed before any mutant was planted",
            Vec::new(),
            text,
        ),
        1 => done(
            Outcome::CouldNotRun,
            "it couldn't start (a usage error)",
            Vec::new(),
            text,
        ),
        other => done(
            Outcome::CouldNotRun,
            format!("it stopped with an error (exit {other})"),
            Vec::new(),
            text,
        ),
    }
}

// ---- mutmut ----------------------------------------------------------------------------------------------------------------

fn mutmut(code: i32, text: &str) -> Interpreted {
    static SURVIVED: OnceLock<Regex> = OnceLock::new();
    static ZERO: OnceLock<Regex> = OnceLock::new();
    let survived = regex(&SURVIVED, r"^(\S+):\s*survived\s*$");
    let zero = regex(&ZERO, r"(?i)\bno mutants?\b|(?m)(?:^|\s)0/0(?:\s|$)");
    let mut names: Vec<String> = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(caps) = survived.captures(line) {
            push_unique(&mut names, caps[1].to_string());
        }
    }
    if !names.is_empty() {
        let lines: Vec<String> = names
            .iter()
            .map(|name| format!("{name}: survived (run mutmut show {name} to see the change)"))
            .collect();
        return done(
            Outcome::Failed,
            format!(
                "{} survived: the tests didn't notice the code being changed there",
                plural(names.len(), "mutant")
            ),
            lines,
            text,
        );
    }
    if zero.is_match(text) {
        return done(
            Outcome::NotRun,
            "no mutants in the changed code",
            Vec::new(),
            text,
        );
    }
    if code == 0 {
        return done(Outcome::Passed, "no mutant survived", Vec::new(), text);
    }
    done(
        Outcome::CouldNotRun,
        format!("it stopped with an error (exit {code}) before it reported on any mutant"),
        Vec::new(),
        text,
    )
}

// ---- Playwright and e2e ----------------------------------------------------------------------------------------------------

fn playwright(code: i32, text: &str) -> Interpreted {
    let found = test_summary::classify(text);
    let summary = if found.line.is_empty() {
        String::new()
    } else {
        format!(": {}", found.line)
    };
    match found.outcome {
        TestOutcome::Red => {
            let lines: Vec<String> = test_summary::failures(text)
                .iter()
                .map(|failure| failure_line(failure, false))
                .collect();
            done(
                Outcome::Failed,
                format!("some browser tests failed{summary}"),
                lines,
                text,
            )
        }
        TestOutcome::Green if code != 0 => done(
            Outcome::CouldNotRun,
            format!(
                "its tests passed but it ended with exit {code}, so it wasn't a clean run{summary}"
            ),
            Vec::new(),
            text,
        ),
        TestOutcome::Green => done(
            Outcome::Passed,
            format!("the browser tests passed{summary}"),
            Vec::new(),
            text,
        ),
        TestOutcome::Inconclusive => done(
            Outcome::CouldNotRun,
            found.why.unwrap_or("its output has no test result"),
            Vec::new(),
            text,
        ),
    }
}

fn e2e(code: i32, text: &str) -> Interpreted {
    if code == 0 {
        return done(
            Outcome::Passed,
            "the plain-English tests replayed and passed with no model call",
            Vec::new(),
            text,
        );
    }
    let lower = text.to_lowercase();
    let detail = if lower.contains("stale") || lower.contains("cache") || lower.contains("strict") {
        "a recording is stale or missing, so the strict replay failed (no model call was made)"
            .to_string()
    } else {
        format!("its tests failed (exit {code})")
    };
    done(Outcome::Failed, detail, last_lines(text, 10), text)
}

// ---- Schemathesis ----------------------------------------------------------------------------------------------------------

fn schemathesis(code: i32, text: &str) -> Interpreted {
    static DOWN: OnceLock<Regex> = OnceLock::new();
    static SECTION: OnceLock<Regex> = OnceLock::new();
    static OPERATION: OnceLock<Regex> = OnceLock::new();
    let down = regex(
        &DOWN,
        r"(?i)connection refused|failed to establish a new connection|name or service not known|nodename nor servname|temporary failure in name resolution|max retries exceeded|timed out connecting|connect ?timeout|connection timed out|cannot connect|unable to connect",
    );
    let section = regex(&SECTION, r"^=+\s*FAILURES\s*=+$");
    let operation = regex(&OPERATION, r"^_{3,}\s*(\S.*?)\s*_{3,}$");
    if code == 0 {
        return done(
            Outcome::Passed,
            "no failure for the generated requests",
            Vec::new(),
            text,
        );
    }
    // An unreachable service is not a failure of the API: it was never tested.
    if down.is_match(text) {
        return done(
            Outcome::CouldNotRun,
            "the service didn't answer at the base URL, so the API wasn't tested",
            Vec::new(),
            text,
        );
    }
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let mut found: Vec<(String, Option<String>)> = Vec::new();
    if let Some(start) = lines.iter().position(|line| section.is_match(line)) {
        for line in lines.iter().skip(start + 1) {
            if line.starts_with("===") && line.ends_with("===") {
                break;
            }
            if let Some(caps) = operation.captures(line) {
                found.push((caps[1].to_string(), None));
            } else if let (Some(rest), Some((_, finding))) =
                (line.strip_prefix("- "), found.last_mut())
            {
                if finding.is_none() {
                    *finding = Some(rest.trim().to_string());
                }
            }
        }
    }
    if found.is_empty() {
        return done(
            Outcome::CouldNotRun,
            format!("it stopped with an error (exit {code}) before it reported a failure"),
            Vec::new(),
            text,
        );
    }
    let lines: Vec<String> = found
        .iter()
        .map(|(operation, finding)| match finding {
            Some(finding) => format!("{operation}: {finding}"),
            None => operation.clone(),
        })
        .collect();
    done(
        Outcome::Failed,
        format!(
            "{} failed for the generated requests",
            plural(lines.len(), "operation")
        ),
        lines,
        text,
    )
}

// ---- ast-grep and Semgrep --------------------------------------------------------------------------------------------------

struct Finding {
    rule: String,
    path: String,
    line: Option<u64>,
    message: String,
    severity: String,
}

impl Finding {
    fn rank(&self) -> u8 {
        match self.severity.as_str() {
            "error" => 0,
            "warning" => 1,
            _ => 2,
        }
    }

    fn text(&self) -> String {
        let place = match self.line {
            Some(line) => format!("{}:{line}", self.path),
            None => self.path.clone(),
        };
        if self.message.is_empty() {
            format!("{} {place}", self.rule)
        } else {
            format!("{} {place}: {}", self.rule, self.message)
        }
    }
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

/// One line of `ast-grep scan --json=stream`.
fn ast_finding(line: &str) -> Option<Finding> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    let path = object.get("file")?.as_str()?.to_string();
    let text_of = |key: &str| object.get(key).and_then(Value::as_str);
    Some(Finding {
        rule: text_of("ruleId").unwrap_or("rule").to_string(),
        path,
        // ast-grep counts lines from 0.
        line: object
            .get("range")
            .and_then(|range| range.get("start"))
            .and_then(|start| start.get("line"))
            .and_then(Value::as_u64)
            .map(|line| line + 1),
        message: first_line(text_of("message").unwrap_or("")),
        severity: text_of("severity").unwrap_or("hint").to_lowercase(),
    })
}

fn ast_grep(code: i32, text: &str) -> Interpreted {
    static TEST_FAIL: OnceLock<Regex> = OnceLock::new();
    let test_fail = regex(
        &TEST_FAIL,
        r"\b(?:FAILED|FAIL|NOISY|MISSING)\b|(?i:\.\.\.\s*(?:failed|noisy|missing)\b)",
    );
    let mut findings: Vec<Finding> = Vec::new();
    let mut other: Vec<String> = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        // A line that isn't a finding (the text `ast-grep test` prints, a warning) is kept as text, never an error.
        match line.starts_with('{').then(|| ast_finding(line)).flatten() {
            Some(finding) => findings.push(finding),
            None => other.push(line.to_string()),
        }
    }
    findings.sort_by_key(Finding::rank);
    let errors = findings
        .iter()
        .filter(|finding| finding.severity == "error")
        .count();
    let others = findings.len() - errors;
    let lines: Vec<String> = findings.iter().map(Finding::text).collect();
    if errors > 0 {
        return done(
            Outcome::Failed,
            format!(
                "{} in the changed files{}",
                plural(errors, "error finding"),
                if others > 0 {
                    format!(" (and {} to look at)", notes(others))
                } else {
                    String::new()
                }
            ),
            lines,
            text,
        );
    }
    if code != 0 {
        // No error finding but a bad exit: the rules' own tests (`ast-grep test`), or the tool itself.
        let failing: Vec<String> = other
            .iter()
            .filter(|line| test_fail.is_match(line))
            .cloned()
            .collect();
        if !failing.is_empty() {
            return done(Outcome::Failed, "a rule's own test failed", failing, text);
        }
        return done(
            Outcome::CouldNotRun,
            format!("it stopped with an error (exit {code}) and reported no finding"),
            Vec::new(),
            text,
        );
    }
    let detail = if findings.is_empty() {
        "scanned with no findings".to_string()
    } else {
        format!("no errors ({} to look at)", notes(findings.len()))
    };
    done(Outcome::Passed, detail, lines, text)
}

/// The JSON report semgrep printed: tried from each line that starts with `{`, because progress text may surround it.
fn semgrep_report(text: &str) -> Option<Value> {
    let mut tried = 0;
    for (at, _) in text.match_indices('{') {
        if at != 0 && text.as_bytes()[at - 1] != b'\n' {
            continue;
        }
        tried += 1;
        if tried > REPORT_TRIES {
            break;
        }
        let mut stream = serde_json::Deserializer::from_str(&text[at..]).into_iter::<Value>();
        if let Some(Ok(value)) = stream.next() {
            if value.get("results").is_some() || value.get("errors").is_some() {
                return Some(value);
            }
        }
    }
    None
}

/// The last two dotted parts of a rule id (`rules.python.lang.audit.eval-injection` is `audit.eval-injection`).
fn short_rule(id: &str) -> String {
    let parts: Vec<&str> = id.split('.').collect();
    if parts.len() <= 2 {
        id.to_string()
    } else {
        parts[parts.len() - 2..].join(".")
    }
}

fn semgrep(code: i32, text: &str) -> Interpreted {
    let Some(report) = semgrep_report(text) else {
        let why = if code == 0 {
            "it printed no report".to_string()
        } else {
            format!("it stopped with an error (exit {code}) and printed no report")
        };
        return done(Outcome::CouldNotRun, why, Vec::new(), text);
    };
    let mut findings: Vec<Finding> = Vec::new();
    for result in report
        .get("results")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let extra = result.get("extra");
        let at = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or("").to_string();
        findings.push(Finding {
            rule: short_rule(&at(result.get("check_id"))),
            path: at(result.get("path")),
            line: result
                .get("start")
                .and_then(|start| start.get("line"))
                .and_then(Value::as_u64),
            message: first_line(&at(extra.and_then(|extra| extra.get("message")))),
            severity: at(extra.and_then(|extra| extra.get("severity"))).to_lowercase(),
        });
    }
    findings.sort_by_key(Finding::rank);
    let errors = findings
        .iter()
        .filter(|finding| finding.severity == "error")
        .count();
    let others = findings.len() - errors;
    let lines: Vec<String> = findings.iter().map(Finding::text).collect();
    let reported: Vec<String> = report
        .get("errors")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|error| {
            ["message", "long_msg", "short_msg"]
                .iter()
                .find_map(|key| error.get(*key).and_then(Value::as_str))
                .map(first_line)
                .unwrap_or_else(|| "an error".to_string())
        })
        .collect();
    if errors > 0 {
        let more = if reported.is_empty() {
            String::new()
        } else {
            format!(" (it also reported {})", plural(reported.len(), "error"))
        };
        return done(
            Outcome::Failed,
            format!(
                "{} in the changed code{more}",
                plural(errors, "error finding")
            ),
            lines,
            text,
        );
    }
    if !reported.is_empty() {
        return done(
            Outcome::CouldNotRun,
            format!(
                "semgrep reported {}, so some code may not have been scanned: {}",
                plural(reported.len(), "error"),
                reported[0]
            ),
            lines,
            text,
        );
    }
    if code >= 2 {
        return done(
            Outcome::CouldNotRun,
            format!("it stopped with an error (exit {code})"),
            lines,
            text,
        );
    }
    let detail = if others == 0 {
        "scanned with no findings".to_string()
    } else {
        format!("no error findings ({} to look at)", notes(others))
    };
    done(Outcome::Passed, detail, lines, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proof_tools::catalogue;

    // The fixtures below are written from each tool's documented output format. No real tool was run.

    fn tool(id: &str) -> &'static Tool {
        catalogue::find(id).unwrap_or_else(|| panic!("{id} is in the catalogue"))
    }

    fn exited(code: i32, output: &str) -> RawRun {
        RawRun {
            ended: Ended::Exited(Some(code)),
            output: output.to_string(),
            seconds: 0.0,
        }
    }

    fn read(id: &str, code: i32, output: &str) -> Interpreted {
        interpret(tool(id), &exited(code, output))
    }

    fn passed(output: &str) -> TestRun {
        TestRun {
            outcome: Outcome::Passed,
            output: output.to_string(),
        }
    }

    // ---- a run that didn't run ------------------------------------------------------------------------------------------------

    #[test]
    fn a_run_that_didnt_start_timed_out_or_was_stopped_could_not_run_and_is_never_a_failure() {
        let cases = [
            (
                Ended::NotStarted("the sandbox refused it".into()),
                "it didn't start: the sandbox refused it",
            ),
            (Ended::TimedOut, "it ran past its time limit"),
            (Ended::Stopped, "it was stopped"),
            (Ended::Unfinished, "it didn't finish"),
            (Ended::Exited(None), "without an exit code"),
            (Ended::Exited(Some(127)), "command not found"),
            (Ended::Exited(Some(126)), "not allowed to run"),
        ];
        for id in [
            "stryker",
            "cargo-mutants",
            "mutmut",
            "playwright",
            "e2e",
            "schemathesis",
            "ast-grep",
            "semgrep",
        ] {
            for (ended, words) in &cases {
                let run = RawRun {
                    ended: ended.clone(),
                    output: "MISSED src/a.rs:1:1: replace a with b\nsome output".into(),
                    seconds: 0.0,
                };
                let got = interpret(tool(id), &run);
                assert_eq!(got.outcome, Outcome::CouldNotRun, "{id} {ended:?}");
                assert!(got.detail.contains(*words), "{id}: {}", got.detail);
                assert!(
                    got.lines.is_empty(),
                    "{id}: a run that did not run lists no findings"
                );
                assert!(got.tail.is_some(), "{id}");
            }
        }
    }

    #[test]
    fn an_unknown_tool_passes_on_exit_zero_and_fails_with_the_last_lines_otherwise() {
        let mut other = tool("e2e").clone();
        other.id = "something-new".into();
        let ok = interpret(&other, &exited(0, "fine"));
        assert_eq!(ok.outcome, Outcome::Passed);
        assert_eq!(ok.tail, None);
        let bad = interpret(&other, &exited(1, "one\n\ntwo\nthree\n"));
        assert_eq!(bad.outcome, Outcome::Failed);
        assert_eq!(bad.lines, ["one", "two", "three"]);
        assert!(bad.detail.contains("exit 1"));
    }

    // ---- property libraries ---------------------------------------------------------------------------------------------------

    const FAST_CHECK_FAILURE: &str = "\
 RUN  v2.1.8 /repo

 ❯ src/a.test.ts (2 tests | 1 failed) 12ms
   × sum is commutative 8ms
     → Property failed after 3 tests
 FAIL  src/a.test.ts > sum is commutative
Error: Property failed after 3 tests
{ seed: 123, path: \"2:0\", endOnFailure: true }
Counterexample: [0,-1]
Shrunk 2 time(s)
Got error: AssertionError: expected -1 to be 1

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
";

    #[test]
    fn a_failing_fast_check_property_names_the_test_the_seed_and_the_counterexample() {
        let got = property(
            tool("fast-check"),
            &[TestRun {
                outcome: Outcome::Failed,
                output: FAST_CHECK_FAILURE.into(),
            }],
        );
        assert_eq!(got.outcome, Outcome::Failed);
        let line = got
            .lines
            .iter()
            .find(|line| line.starts_with("src/a.test.ts > sum is commutative"))
            .unwrap_or_else(|| panic!("the failing test is listed: {:?}", got.lines));
        assert!(
            line.starts_with(
                "src/a.test.ts > sum is commutative: Error: Property failed after 3 tests"
            ),
            "{line}"
        );
        assert!(line.contains("seed: 123"), "{line}");
        assert!(line.contains("Counterexample: [0,-1]"), "{line}");
        assert!(got.detail.contains("failing test"), "{}", got.detail);
        assert!(got
            .tail
            .as_deref()
            .is_some_and(|tail| tail.contains("Counterexample")));
    }

    #[test]
    fn a_property_run_that_passed_says_how_many_tests_carried_it() {
        let ok = property(
            tool("proptest"),
            &[passed(
                " Test Files  1 passed (1)\n      Tests  25 passed (25)\n",
            )],
        );
        assert_eq!(ok.outcome, Outcome::Passed);
        assert_eq!(
            ok.detail,
            "its properties run with the project's tests: 25 passed"
        );
        assert_eq!(ok.tail, None);
        let two = property(
            tool("proptest"),
            &[
                passed("test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s\n"),
                passed(" Tests  4 passed (4)\n"),
            ],
        );
        assert_eq!(two.outcome, Outcome::Passed);
        assert!(
            two.detail.contains("4 passed") || two.detail.contains("7 passed"),
            "{}",
            two.detail
        );
    }

    #[test]
    fn zero_tests_no_summary_and_a_run_that_did_not_happen_are_never_a_pass_for_a_property_library()
    {
        let zero = property(
            tool("hypothesis"),
            &[passed(" Test Files  1 passed (1)\n      Tests  no tests\n")],
        );
        assert_eq!(zero.outcome, Outcome::CouldNotRun);
        assert!(zero.detail.contains("zero tests"), "{}", zero.detail);
        let silent = property(tool("hypothesis"), &[passed("everything is fine\n")]);
        assert_eq!(silent.outcome, Outcome::CouldNotRun);
        assert!(
            silent.detail.contains("no test summary"),
            "{}",
            silent.detail
        );
        let none = property(tool("hypothesis"), &[]);
        assert_eq!(none.outcome, Outcome::CouldNotRun);
        assert!(none.detail.contains("didn't run"), "{}", none.detail);
        // The ship check hands over only outcomes (a passed step keeps no log): every one passed is a pass, but a run that
        // printed something with no summary is not.
        let outcomes_only = property(tool("proptest"), &[passed(""), passed("  ")]);
        assert_eq!(outcomes_only.outcome, Outcome::Passed);
        let mixed = property(
            tool("proptest"),
            &[passed(""), passed("everything is fine\n")],
        );
        assert_eq!(mixed.outcome, Outcome::CouldNotRun);
        for not_run in [Outcome::NotRun, Outcome::CouldNotRun] {
            let got = property(
                tool("fast-check"),
                &[TestRun {
                    outcome: not_run,
                    output: "Tests  3 passed (3)".into(),
                }],
            );
            assert_eq!(got.outcome, Outcome::CouldNotRun);
        }
        // A failed run with no readable failure is still a failure, and says so.
        let broken = property(
            tool("fast-check"),
            &[TestRun {
                outcome: Outcome::Failed,
                output: "something went wrong".into(),
            }],
        );
        assert_eq!(broken.outcome, Outcome::Failed);
        assert!(broken.lines.is_empty() && broken.detail.contains("failed"));
    }

    // ---- StrykerJS ------------------------------------------------------------------------------------------------------------

    const STRYKER_SURVIVORS: &str = "\
10:41:12 (1234) INFO ProjectReader Found 1 of 2 file(s) to be mutated.
#1. [Survived] ArithmeticOperator
src/math.ts:3:10
-   return a + b;
+   return a - b;
Tests ran:
    math.spec.ts: adds
#2. [NoCoverage] ConditionalExpression
src/math.ts:8:7
-   if (x > 0) {
+   if (true) {

----------|---------|----------|-----------|------------|----------|---------|
File      | % score | # killed | # timeout | # survived | # no cov | # error |
----------|---------|----------|-----------|------------|----------|---------|
All files |   50.00 |        2 |         0 |          1 |        1 |       0 |
 math.ts  |   50.00 |        2 |         0 |          1 |        1 |       0 |
----------|---------|----------|-----------|------------|----------|---------|
10:41:20 (1234) INFO MutationTestExecutor Done in 8 seconds.
";

    #[test]
    fn stryker_survivors_are_listed_by_place_and_mutation_even_when_it_exits_zero() {
        // Without a `break` threshold Stryker exits 0 with survivors: the exit code is not trusted.
        let got = read("stryker", 0, STRYKER_SURVIVORS);
        assert_eq!(got.outcome, Outcome::Failed);
        assert_eq!(
            got.lines,
            [
                "src/math.ts:3: ArithmeticOperator survived (-return a + b; / +return a - b;)",
                "src/math.ts:8: ConditionalExpression: no test covers it (-if (x > 0) { / +if (true) {)"
            ]
        );
        assert!(
            got.detail.starts_with("2 mutants survived"),
            "{}",
            got.detail
        );
        assert!(got.tail.is_some());
    }

    #[test]
    fn stryker_with_no_survivors_and_a_report_passes_and_counts_the_mutants() {
        let report = "\
----------|---------|----------|-----------|------------|----------|---------|
File      | % score | # killed | # timeout | # survived | # no cov | # error |
All files |  100.00 |        3 |         1 |          0 |        0 |       0 |
";
        let got = read("stryker", 0, report);
        assert_eq!(got.outcome, Outcome::Passed);
        assert_eq!(got.detail, "4 mutants tested, none survived");
        let by_score = read("stryker", 0, "Final mutation score of 100.00 %\n");
        assert_eq!(by_score.outcome, Outcome::Passed);
    }

    #[test]
    fn stryker_that_found_no_mutants_or_printed_no_report_did_not_pass() {
        assert_eq!(
            read("stryker", 0, "No mutants were found.\n").outcome,
            Outcome::NotRun
        );
        assert_eq!(
            read("stryker", 0, "All files | n/a | 0 | 0 | 0 | 0 | 0 |\n").outcome,
            Outcome::NotRun
        );
        let silent = read("stryker", 0, "Done.\n");
        assert_eq!(silent.outcome, Outcome::CouldNotRun);
        let broken = read(
            "stryker",
            1,
            "Error: Could not find a stryker.config file\n",
        );
        assert_eq!(broken.outcome, Outcome::CouldNotRun);
        assert!(broken.detail.contains("exit 1"), "{}", broken.detail);
        // A table that counts survivors the reporter didn't name is still a failure.
        let counted = read("stryker", 0, "All files | 50.00 | 2 | 0 | 2 | 0 | 0 |\n");
        assert_eq!(counted.outcome, Outcome::Failed);
        assert!(
            counted.detail.contains("2 mutants survived"),
            "{}",
            counted.detail
        );
    }

    // ---- cargo-mutants --------------------------------------------------------------------------------------------------------

    const MISSED_LIST: &str = "\
Found 4 mutants to test
ok       Unmutated baseline skipped
 INFO Auto-set test timeout to 20s
MISSED   src/lib.rs:5:5: replace add -> i32 with 0 in 0.4s build + 0.3s test
caught   src/lib.rs:5:5: replace add -> i32 with 1 in 0.3s build + 0.3s test
MISSED   src/lib.rs:9:9: replace + with - in sub in 0.4s build + 0.3s test
caught   src/lib.rs:12:5: delete ! in check in 0.3s build + 0.3s test
4 mutants tested in 3s: 2 missed, 2 caught
";

    #[test]
    fn a_cargo_mutants_missed_list_is_one_line_per_planted_bug_nobody_caught() {
        let got = read("cargo-mutants", 2, MISSED_LIST);
        assert_eq!(got.outcome, Outcome::Failed);
        assert_eq!(
            got.lines,
            [
                "src/lib.rs:5: replace add -> i32 with 0",
                "src/lib.rs:9: replace + with - in sub"
            ]
        );
        assert!(got.detail.starts_with("2 mutants missed"), "{}", got.detail);
    }

    #[test]
    fn cargo_mutants_output_with_colour_and_crlf_reads_the_same() {
        let coloured = MISSED_LIST
            .replace("MISSED  ", "\x1b[1;31mMISSED\x1b[0m  ")
            .replace('\n', "\r\n");
        assert_eq!(
            read("cargo-mutants", 2, &coloured).lines,
            read("cargo-mutants", 2, MISSED_LIST).lines
        );
    }

    #[test]
    fn the_bare_lines_of_missed_txt_are_read_when_the_run_has_no_missed_lines() {
        let file = "src/lib.rs:5:5: replace add -> i32 with 0\nsrc/lib.rs:9:9: delete ! in check\nsrc/lib.rs:7:1: error: something else\n";
        let got = read("cargo-mutants", 2, file);
        assert_eq!(got.outcome, Outcome::Failed);
        assert_eq!(
            got.lines,
            [
                "src/lib.rs:5: replace add -> i32 with 0",
                "src/lib.rs:9: delete ! in check"
            ]
        );
        // Exit 2 and nothing named: still a failure.
        let unnamed = read("cargo-mutants", 2, "something\n");
        assert_eq!(unnamed.outcome, Outcome::Failed);
        assert!(unnamed.lines.is_empty());
    }

    #[test]
    fn cargo_mutants_exit_codes_zero_three_four_one_and_no_mutants() {
        let ok = read(
            "cargo-mutants",
            0,
            "Found 3 mutants to test\n3 mutants tested in 3s: 3 caught\n",
        );
        assert_eq!(ok.outcome, Outcome::Passed);
        assert_eq!(ok.detail, "3 mutants tested in 3s: 3 caught");
        assert_eq!(
            read("cargo-mutants", 0, "Found 0 mutants to test\n").outcome,
            Outcome::NotRun
        );
        assert_eq!(
            read("cargo-mutants", 0, "No mutants to test\n").outcome,
            Outcome::NotRun
        );
        let timeouts = read(
            "cargo-mutants",
            3,
            "TIMEOUT   src/lib.rs:5:5: replace x with y in 20s\n",
        );
        assert_eq!(timeouts.outcome, Outcome::CouldNotRun);
        assert!(timeouts.detail.contains("timed out"), "{}", timeouts.detail);
        for (code, words) in [(4, "before any mutant"), (1, "usage error"), (9, "exit 9")] {
            let got = read("cargo-mutants", code, "error\n");
            assert_eq!(got.outcome, Outcome::CouldNotRun, "{code}");
            assert!(got.detail.contains(words), "{}", got.detail);
        }
        // A mutant that was missed beside a timeout is still a failure.
        let both = read("cargo-mutants", 3, MISSED_LIST);
        assert_eq!(both.outcome, Outcome::Failed);
    }

    // ---- mutmut ---------------------------------------------------------------------------------------------------------------

    #[test]
    fn mutmut_survivors_are_named_with_how_to_see_the_change() {
        let out = "\
⠙ 30/30  🎉 22 🫥 0  ⏰ 0  🤔 0  🙁 8  🔇 0
    pkg.x_add__mutmut_1: survived
    pkg.x_add__mutmut_2: survived
    pkg.x_add__mutmut_1: survived
    pkg.x_sub__mutmut_1: no tests
";
        let got = read("mutmut", 0, out);
        assert_eq!(got.outcome, Outcome::Failed);
        assert_eq!(
            got.lines,
            [
                "pkg.x_add__mutmut_1: survived (run mutmut show pkg.x_add__mutmut_1 to see the change)",
                "pkg.x_add__mutmut_2: survived (run mutmut show pkg.x_add__mutmut_2 to see the change)"
            ]
        );
        assert!(
            got.detail.starts_with("2 mutants survived"),
            "{}",
            got.detail
        );
    }

    #[test]
    fn mutmut_with_none_surviving_passes_and_with_no_mutants_did_not_run() {
        assert_eq!(
            read("mutmut", 0, "⠙ 12/12  🎉 12 🫥 0  ⏰ 0  🤔 0  🙁 0  🔇 0\n").outcome,
            Outcome::Passed
        );
        assert_eq!(
            read("mutmut", 0, "⠙ 0/0  🎉 0 🫥 0  ⏰ 0  🤔 0  🙁 0\n").outcome,
            Outcome::NotRun
        );
        let broken = read(
            "mutmut",
            1,
            "Traceback (most recent call last):\nValueError: no config\n",
        );
        assert_eq!(broken.outcome, Outcome::CouldNotRun);
    }

    // ---- Playwright and e2e ---------------------------------------------------------------------------------------------------

    #[test]
    fn a_failing_playwright_run_lists_the_failing_tests_and_the_summary() {
        let out = "\
Running 3 tests using 1 worker

  1) [chromium] › a.spec.ts:7:5 › login works ──────────────

    Error: expect(received).toBeVisible()

  1 failed
    [chromium] › a.spec.ts:7:5 › login works
  2 passed (4.1s)
";
        let got = read("playwright", 1, out);
        assert_eq!(got.outcome, Outcome::Failed);
        assert_eq!(
            got.lines,
            ["[chromium] › a.spec.ts:7:5 › login works: Error: expect(received).toBeVisible()"]
        );
        assert!(
            got.detail
                .contains("Playwright: 2 passed, 1 failed, 0 skipped"),
            "{}",
            got.detail
        );
    }

    #[test]
    fn a_playwright_run_that_passed_passed_and_one_that_ran_no_tests_could_not_run() {
        let green = "Running 2 tests using 1 worker\n  2 passed (3.0s)\n";
        let ok = read("playwright", 0, green);
        assert_eq!(ok.outcome, Outcome::Passed);
        assert!(ok.detail.contains("2 passed"), "{}", ok.detail);
        // Green output with a bad exit code was not a clean run.
        assert_eq!(read("playwright", 1, green).outcome, Outcome::CouldNotRun);
        let none = read("playwright", 1, "Error: No tests found\n");
        assert_eq!(none.outcome, Outcome::CouldNotRun);
        assert_eq!(none.detail, test_summary::WHY_ZERO_TESTS);
        let silent = read("playwright", 0, "done\n");
        assert_eq!(silent.outcome, Outcome::CouldNotRun);
        assert_eq!(silent.detail, test_summary::WHY_NO_SUMMARY);
    }

    #[test]
    fn an_e2e_replay_passes_on_exit_zero_and_a_stale_recording_fails_with_no_model_call() {
        let ok = read("e2e", 0, "3 passed\n");
        assert_eq!(ok.outcome, Outcome::Passed);
        assert!(ok.detail.contains("no model call"), "{}", ok.detail);
        let stale = read(
            "e2e",
            1,
            "login flow\n  step 2: no recording matches, and --strict-cache forbids a model call\n1 failed\n",
        );
        assert_eq!(stale.outcome, Outcome::Failed);
        assert!(
            stale.detail.contains("stale or missing"),
            "{}",
            stale.detail
        );
        assert_eq!(stale.lines.last().map(String::as_str), Some("1 failed"));
        let plain = read("e2e", 1, "the button was not found\n");
        assert!(plain.detail.contains("exit 1"), "{}", plain.detail);
    }

    // ---- Schemathesis ---------------------------------------------------------------------------------------------------------

    #[test]
    fn schemathesis_failures_are_one_line_per_operation_with_the_first_finding() {
        let out = "\
========================== Schemathesis test session starts ==========================
================================ FAILURES ================================
_________________________ GET /users/{id} _________________________
1. Test Case ID: AbCd

- Server error

[500] Internal Server Error:

    `{\"error\":\"boom\"}`

Reproduce with:

    curl -X GET http://127.0.0.1:8000/users/0

_________________________ POST /orders _________________________
1. Test Case ID: EfGh

- Undocumented HTTP status code
- Response violates schema

=============================== SUMMARY ===============================
- Server error
";
        let got = read("schemathesis", 1, out);
        assert_eq!(got.outcome, Outcome::Failed);
        assert_eq!(
            got.lines,
            [
                "GET /users/{id}: Server error",
                "POST /orders: Undocumented HTTP status code"
            ]
        );
        assert!(
            got.detail.starts_with("2 operations failed"),
            "{}",
            got.detail
        );
    }

    #[test]
    fn an_unreachable_service_is_could_not_run_not_a_failure_and_a_clean_run_passes() {
        let down = "requests.exceptions.ConnectionError: HTTPConnectionPool(host='127.0.0.1', port=8000): Max retries exceeded with url: /users (Caused by NewConnectionError: Failed to establish a new connection: [Errno 111] Connection refused)\n";
        let got = read("schemathesis", 1, down);
        assert_eq!(got.outcome, Outcome::CouldNotRun);
        assert!(got.detail.contains("didn't answer"), "{}", got.detail);
        assert_eq!(
            read("schemathesis", 0, "all good\n").outcome,
            Outcome::Passed
        );
        let tool_error = read("schemathesis", 2, "Error: Invalid schema\n");
        assert_eq!(tool_error.outcome, Outcome::CouldNotRun);
        assert!(
            tool_error.detail.contains("exit 2"),
            "{}",
            tool_error.detail
        );
    }

    // ---- ast-grep and Semgrep -------------------------------------------------------------------------------------------------

    fn ast_json(rule: &str, severity: &str, line: u64, message: &str) -> String {
        format!(
            "{{\"text\":\"console.log(x)\",\"range\":{{\"byteOffset\":{{\"start\":10,\"end\":27}},\"start\":{{\"line\":{line},\"column\":0}},\"end\":{{\"line\":{line},\"column\":17}}}},\"file\":\"src/a.ts\",\"lines\":\"console.log(x);\",\"language\":\"TypeScript\",\"ruleId\":\"{rule}\",\"severity\":\"{severity}\",\"note\":null,\"message\":\"{message}\"}}"
        )
    }

    #[test]
    fn an_ast_grep_error_finding_fails_with_rule_place_and_message_and_warnings_do_not() {
        let out = format!(
            "{}\n{}\n",
            ast_json("prefer-const", "warning", 4, "Use const"),
            ast_json("no-console", "error", 2, "Remove console.log\\nsecond line")
        );
        let got = read("ast-grep", 1, &out);
        assert_eq!(got.outcome, Outcome::Failed);
        // Errors first, line numbers from 1, only the first line of a message.
        assert_eq!(
            got.lines,
            [
                "no-console src/a.ts:3: Remove console.log",
                "prefer-const src/a.ts:5: Use const"
            ]
        );
        assert!(
            got.detail
                .starts_with("1 error finding in the changed files"),
            "{}",
            got.detail
        );
        let warned = read(
            "ast-grep",
            0,
            &format!("{}\n", ast_json("prefer-const", "warning", 4, "Use const")),
        );
        assert_eq!(warned.outcome, Outcome::Passed);
        assert_eq!(warned.lines.len(), 1);
        assert_eq!(read("ast-grep", 0, "").outcome, Outcome::Passed);
        assert_eq!(read("ast-grep", 0, "").detail, "scanned with no findings");
    }

    #[test]
    fn ast_grep_rule_test_failures_and_a_tool_error_are_told_apart() {
        let tests = "Running 2 tests\ntest no-console ... ok\ntest no-eval ... FAILED\nTest Summary: 1 passed, 1 failed\n";
        let got = read("ast-grep", 1, tests);
        assert_eq!(got.outcome, Outcome::Failed);
        assert_eq!(got.lines, ["test no-eval ... FAILED"]);
        let broken = read("ast-grep", 1, "Error: cannot read sgconfig.yml\n");
        assert_eq!(broken.outcome, Outcome::CouldNotRun);
        // Text that isn't JSON is kept as text, and a clean run with it still passes.
        assert_eq!(
            read("ast-grep", 0, "test x ... ok\n{not json\n").outcome,
            Outcome::Passed
        );
    }

    const SEMGREP_REPORT: &str = "\
Scanning 2 files with 12 Code rules:
{\"version\":\"1.185.0\",\"results\":[{\"check_id\":\"rules.python.lang.security.audit.eval-injection\",\"path\":\"app/x.py\",\"start\":{\"line\":12,\"col\":1,\"offset\":0},\"end\":{\"line\":12,\"col\":10,\"offset\":9},\"extra\":{\"message\":\"Avoid eval on user input.\",\"severity\":\"ERROR\",\"lines\":\"eval(x)\"}},{\"check_id\":\"rules.style.todo\",\"path\":\"app/y.py\",\"start\":{\"line\":3,\"col\":1},\"extra\":{\"message\":\"A todo.\",\"severity\":\"WARNING\"}}],\"errors\":[],\"paths\":{\"scanned\":[\"app/x.py\"]}}
";

    #[test]
    fn a_semgrep_error_finding_fails_with_a_short_rule_id_and_a_warning_only_lists() {
        let got = read("semgrep", 1, SEMGREP_REPORT);
        assert_eq!(got.outcome, Outcome::Failed);
        assert_eq!(
            got.lines,
            [
                "audit.eval-injection app/x.py:12: Avoid eval on user input.",
                "style.todo app/y.py:3: A todo."
            ]
        );
        assert!(
            got.detail
                .starts_with("1 error finding in the changed code"),
            "{}",
            got.detail
        );
        let warning_only =
            SEMGREP_REPORT.replace("\"severity\":\"ERROR\"", "\"severity\":\"WARNING\"");
        let listed = read("semgrep", 1, &warning_only);
        assert_eq!(listed.outcome, Outcome::Passed);
        assert_eq!(listed.lines.len(), 2);
        assert!(
            listed.detail.contains("2 warnings or notes"),
            "{}",
            listed.detail
        );
        let clean = read("semgrep", 0, "{\"results\":[],\"errors\":[]}\n");
        assert_eq!(clean.outcome, Outcome::Passed);
        assert_eq!(clean.detail, "scanned with no findings");
    }

    #[test]
    fn semgrep_errors_with_no_error_finding_and_an_unreadable_report_could_not_run() {
        let errors = "{\"results\":[],\"errors\":[{\"code\":3,\"level\":\"warn\",\"type\":\"Syntax error\",\"message\":\"Syntax error at line a.py:3:\\n `)` was unexpected\"}]}\n";
        let got = read("semgrep", 2, errors);
        assert_eq!(got.outcome, Outcome::CouldNotRun);
        assert!(
            got.detail.contains("Syntax error at line a.py:3"),
            "{}",
            got.detail
        );
        let garbage = read("semgrep", 2, "boom\n");
        assert_eq!(garbage.outcome, Outcome::CouldNotRun);
        assert!(garbage.detail.contains("exit 2"), "{}", garbage.detail);
        let silent = read("semgrep", 0, "ran fine\n");
        assert_eq!(silent.outcome, Outcome::CouldNotRun);
        assert_eq!(
            read("semgrep", 3, "{\"results\":[],\"errors\":[]}").outcome,
            Outcome::CouldNotRun
        );
    }

    // ---- limits ---------------------------------------------------------------------------------------------------------------

    #[test]
    fn lines_are_cut_and_capped_and_the_tail_is_the_end_of_the_output() {
        let long_rule = "r".repeat(1_000);
        let one = format!("{}\n", ast_json(&long_rule, "error", 1, "m"));
        let got = read("ast-grep", 1, &one);
        assert_eq!(got.lines.len(), 1);
        assert!(
            got.lines[0].chars().count() <= LINE_MAX,
            "{}",
            got.lines[0].chars().count()
        );
        assert!(got.lines[0].ends_with('…'));
        let many: String = (0..45)
            .map(|n| format!("{}\n", ast_json("no-console", "error", n, &format!("m{n}"))))
            .collect();
        let capped_run = read("ast-grep", 1, &many);
        assert_eq!(capped_run.lines.len(), LINES_MAX);
        assert_eq!(
            capped_run.lines.last().map(String::as_str),
            Some("… and 16 more")
        );
        let big = format!("{}END", "x".repeat(5_000));
        let tail = read("e2e", 1, &big).tail.unwrap();
        assert!(tail.chars().count() <= TAIL_MAX, "{}", tail.chars().count());
        assert!(tail.ends_with("END") && tail.starts_with('…'));
        // A passed run keeps no tail.
        assert_eq!(read("e2e", 0, &big).tail, None);
    }

    #[test]
    fn colour_codes_and_crlf_never_reach_a_reading() {
        let out =
            "\x1b[31mMISSED\x1b[0m   src/lib.rs:5:5: replace a -> i32 with 0 in 0.4s\r\n\x1b[2K";
        let got = read("cargo-mutants", 2, out);
        assert_eq!(got.lines, ["src/lib.rs:5: replace a -> i32 with 0"]);
        let tail = got.tail.unwrap();
        assert!(!tail.contains('\x1b') && !tail.contains('\r'), "{tail:?}");
    }
}
