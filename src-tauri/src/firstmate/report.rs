//! Hivra WP-10: the worker's typed final report (docs/hivra/SPEC.md section 4, "Verify" and "Report").
//!
//! Every worker ends with a `## Report` block in one shape (the worker rules in agentAppTasks.ts ask for it):
//!
//! ```text
//! ## Report
//! Summary: what changed, in a sentence or two
//! Files changed:
//! - src/a.ts
//! Checks:
//! - npm test: passed (14 passed)
//! Evidence:
//! - https://github.com/owner/repo/pull/7
//! Open questions:
//! - none
//! ```
//!
//! It is parsed when the row settles and kept on the row as JSON. A worker's opinion of its own work (its self-review, or
//! an "evidence" line that is only a claim, like "it works now") is kept under `selfAssessment`, and never counts as
//! evidence: evidence is a link, a file, a commit, or a check with its result. Nothing here decides whether the work is
//! done; the gates do (status.rs).

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

const FIELD_MAX: usize = 1_000;
const LIST_MAX: usize = 50;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CheckOutcome {
    Passed,
    Failed,
    NotRun,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub command: String,
    pub outcome: CheckOutcome,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerReport {
    pub summary: Option<String>,
    pub files_changed: Vec<String>,
    pub checks: Vec<CheckRun>,
    /// Links, files, commits: things someone else can look at.
    pub evidence: Vec<String>,
    pub open_questions: Vec<String>,
    /// What the worker thinks of its own work. Recorded, never evidence.
    pub self_assessment: Vec<String>,
    /// The parts the report left out (`summary`, `files`, `checks`, `evidence`, `questions`), or `report` when there was
    /// no `## Report` block at all.
    pub missing: Vec<String>,
}

impl WorkerReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
}

fn heading() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$").unwrap())
}

fn check_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(.+?)\s*(?::|—|–|\s-|=>|->)\s*(passed|passes|pass|ok|green|succeeded|failed|fails|fail|red|errored|not run|skipped|didn't run|did not run)\b[\s:,.;-]*(.*)$",
        )
        .unwrap()
    })
}

fn evidence_like() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // A URL, a commit, or something that reads as a path or file (a slash, or a name with an extension) and is not a
    // sentence.
    RE.get_or_init(|| {
        Regex::new(r"(?i)(https?://\S+|\b[0-9a-f]{7,40}\b|^`?[\w.@~-]*[/\\][^\s]*`?(\s|$)|^`?[\w-]+\.[a-z0-9]{1,8}`?(:\d+)?(\s|$))")
            .unwrap()
    })
}

fn cap(value: &str) -> String {
    value.trim().chars().take(FIELD_MAX).collect()
}

fn is_none_word(value: &str) -> bool {
    let v = value.trim().trim_end_matches('.').to_ascii_lowercase();
    matches!(
        v.as_str(),
        "" | "none" | "nothing" | "n/a" | "na" | "no" | "-" | "no questions" | "none yet"
    )
}

/// A bullet's text without its marker (`- `, `* `, `1. `).
fn bullet(line: &str) -> String {
    let t = line.trim();
    let t = t
        .strip_prefix("- ")
        .or_else(|| t.strip_prefix("* "))
        .or_else(|| t.strip_prefix("• "))
        .unwrap_or(t);
    let t = match t.find(". ") {
        Some(i) if i > 0 && i <= 3 && t[..i].chars().all(|c| c.is_ascii_digit()) => &t[i + 2..],
        _ => t,
    };
    t.trim().to_string()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Summary,
    Files,
    Checks,
    Evidence,
    Questions,
}

fn field_of(line: &str) -> Option<(Field, String)> {
    let t = line.trim().trim_start_matches(['-', '*']).trim();
    let t = t.trim_start_matches("**");
    let (label, rest) = t.split_once(':')?;
    let label = label
        .trim()
        .trim_end_matches("**")
        .trim()
        .to_ascii_lowercase();
    let field = match label.as_str() {
        "summary" => Field::Summary,
        "files changed" | "files" | "changed files" => Field::Files,
        "checks" | "checks run" | "tests" => Field::Checks,
        "evidence" | "evidence links" => Field::Evidence,
        "open questions" | "questions" => Field::Questions,
        _ => return None,
    };
    Some((
        field,
        rest.trim().trim_start_matches("**").trim().to_string(),
    ))
}

fn parse_check(line: &str) -> CheckRun {
    let line = line.trim();
    match check_line().captures(line) {
        Some(c) => {
            let word = c[2].to_ascii_lowercase();
            let outcome = match word.as_str() {
                "passed" | "passes" | "pass" | "ok" | "green" | "succeeded" => CheckOutcome::Passed,
                "failed" | "fails" | "fail" | "red" | "errored" => CheckOutcome::Failed,
                _ => CheckOutcome::NotRun,
            };
            let detail = c[3]
                .trim()
                .trim_start_matches('(')
                .trim_end_matches(')')
                .trim();
            CheckRun {
                command: cap(c[1].trim().trim_matches('`')),
                outcome,
                detail: (!detail.is_empty()).then(|| cap(detail)),
            }
        }
        // A check with no result named did not prove anything.
        None => CheckRun {
            command: cap(line.trim_matches('`')),
            outcome: CheckOutcome::NotRun,
            detail: Some("no result given".into()),
        },
    }
}

/// The self-review block (workerReview.ts): the worker's own view, kept as its assessment.
fn self_review(lines: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in lines {
        if let Some(c) = heading().captures(line) {
            inside = c[1].trim().eq_ignore_ascii_case("self-review");
            continue;
        }
        if inside && !line.trim().is_empty() {
            out.push(cap(line));
        }
    }
    out.truncate(LIST_MAX);
    out
}

/// The report in a worker's final words. Parsing never fails: what is missing is listed in `missing`.
pub fn parse(text: &str) -> WorkerReport {
    let lines: Vec<&str> = text.lines().collect();
    let mut report = WorkerReport {
        self_assessment: self_review(&lines),
        ..WorkerReport::default()
    };
    // The last `## Report` block, so a quoted example earlier in the text doesn't win.
    let start = lines.iter().rposition(|line| {
        heading()
            .captures(line)
            .is_some_and(|c| c[1].trim().eq_ignore_ascii_case("report"))
    });
    let Some(start) = start else {
        report.missing = vec!["report".into()];
        return report;
    };
    let mut current: Option<Field> = None;
    let mut summary = Vec::new();
    let mut saw = Vec::new();
    for line in &lines[start + 1..] {
        if heading().is_match(line) {
            break;
        }
        if let Some((field, rest)) = field_of(line) {
            current = Some(field);
            saw.push(field);
            if !rest.is_empty() {
                take(&mut report, &mut summary, field, &rest);
            }
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        if let Some(field) = current {
            take(&mut report, &mut summary, field, line);
        }
    }
    if !summary.is_empty() {
        report.summary = Some(cap(&summary.join(" ")));
    }
    for list in [
        &mut report.files_changed,
        &mut report.evidence,
        &mut report.open_questions,
        &mut report.self_assessment,
    ] {
        list.truncate(LIST_MAX);
    }
    report.checks.truncate(LIST_MAX);
    for (field, name) in [
        (Field::Summary, "summary"),
        (Field::Files, "files"),
        (Field::Checks, "checks"),
        (Field::Evidence, "evidence"),
        (Field::Questions, "questions"),
    ] {
        let empty = match field {
            Field::Summary => report.summary.is_none(),
            _ => !saw.contains(&field),
        };
        if empty {
            report.missing.push(name.into());
        }
    }
    report
}

fn take(report: &mut WorkerReport, summary: &mut Vec<String>, field: Field, line: &str) {
    let item = bullet(line);
    if field == Field::Summary {
        summary.push(item);
        return;
    }
    if is_none_word(&item) {
        return;
    }
    match field {
        Field::Files => report.files_changed.push(cap(item.trim_matches('`'))),
        Field::Checks => report.checks.push(parse_check(&item)),
        Field::Evidence => {
            if evidence_like().is_match(&item) {
                report.evidence.push(cap(&item));
            } else {
                // "It works now", "looks good": the worker's view, not something anyone can check.
                report.self_assessment.push(cap(&item));
            }
        }
        Field::Questions => report.open_questions.push(cap(&item)),
        Field::Summary => {}
    }
}
