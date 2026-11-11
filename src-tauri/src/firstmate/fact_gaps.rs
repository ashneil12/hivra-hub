//! WP-145: fact gaps before a worker's done counts.
//!
//! The cases follow AgentMon's Done Gate (codenotary/agentmon-live, Apache-2.0,
//! commit 296502feec4707f6f1a8e8b9383f8fccc3aef2ea): a failed check, a check that
//! went stale after a later edit, a pass claim with no run after the last code
//! edit, an open to-do, and an edited package no test reached. Docs-only edits
//! are not coverage gaps. Hivra's own wording. Not a line-by-line copy.
//!
//! The sentences match `src/features/firstmate/model/factGaps.ts`.
//! `gates` calls this when a worker says done.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const MAX_CHECKS: usize = 40;
const MAX_EDITS: usize = 80;
const MAX_TODOS: usize = 40;
const MAX_ANSWER: usize = 8000;
const MAX_COMMAND: usize = 2000;
const MAX_DISPLAY: usize = 80;
const MAX_PATH: usize = 500;
const MAX_TODO: usize = 160;
const MAX_PACKAGE: usize = 60;

const STALE: &str = "Tests went stale after the last edit.";
const TESTS_CLAIM: &str = "The answer says the tests passed, but no check ran after the last edit.";
const BUILD_CLAIM: &str = "The answer says the build passed, but no check ran after the last edit.";

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FactCheck {
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub at: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FactEdit {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub at: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FactTodo {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub open: bool,
}

/// One turn's facts. Values from a transcript or another agent are untrusted and capped.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FactTurn {
    #[serde(default)]
    pub checks: Vec<FactCheck>,
    #[serde(default)]
    pub edits: Vec<FactEdit>,
    #[serde(default)]
    pub todos: Vec<FactTodo>,
    #[serde(default)]
    pub answer: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassClaim {
    pub tests: bool,
    pub build: bool,
}

struct StoredCheck {
    command: String,
    display: String,
    status: &'static str,
    at: f64,
}

fn check_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|[\s;&|(])(?:npx\s+)?(?:vitest|jest|pytest|playwright|cypress|tsc|eslint|biome|ruff|mypy)\b|(?:^|[\s;&|(])cargo\s+(?:test|check|clippy|nextest)\b|(?:^|[\s;&|(])go\s+test\b|(?:^|[\s;&|(])swift\s+test\b|(?:^|[\s;&|(])make\s+(?:test|check|verify)\b|(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|[\w:-]*:test|[\w:-]*:check)\b",
        )
        .expect("check command pattern")
    })
}

fn test_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|[\s;&|(])(?:npx\s+)?(?:vitest|jest|pytest|playwright|cypress)\b|(?:^|[\s;&|(])cargo\s+(?:test|nextest)\b|(?:^|[\s;&|(])go\s+test\b|(?:^|[\s;&|(])swift\s+test\b|(?:^|[\s;&|(])make\s+test\b|(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|[\w:-]*:test)\b",
        )
        .expect("test command pattern")
    })
}

fn negated_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:not|no|never|didn't|don't|haven't|failed|fail)\b")
            .expect("negation pattern")
    })
}

fn pass_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:pass(?:ed|es|ing)?|green)\b").expect("pass pattern"))
}

fn tests_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\btests?\b").expect("tests pattern"))
}

fn build_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:build|typecheck|type check)\b").expect("build pattern"))
}

fn chars_at_most(value: &str, max: usize) -> bool {
    value.chars().nth(max).is_none()
}

fn take_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn strip_controls(value: &str) -> String {
    value.chars().filter(|c| !c.is_control()).collect()
}

fn one_line(value: &str, max: usize) -> String {
    let stripped = strip_controls(value);
    let line = stripped.split(['\n', '\r']).next().unwrap_or("");
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    take_chars(&collapsed, max)
}

fn segments_of(path: &str) -> Vec<String> {
    strip_controls(path)
        .split(['/', '\\'])
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .map(str::to_string)
        .collect()
}

fn is_docs_path(path: &str) -> bool {
    let segments = segments_of(path);
    if segments.is_empty() {
        return false;
    }
    if segments[0].eq_ignore_ascii_case("docs") {
        return true;
    }
    let base = segments[segments.len() - 1].to_lowercase();
    let (stem, ext) = match base.rfind('.') {
        Some(dot) => (&base[..dot], &base[dot + 1..]),
        None => (base.as_str(), ""),
    };
    const DOC_EXT: &[&str] = &["md", "mdx", "rst", "adoc", "txt"];
    const DOC_NAME: &[&str] = &[
        "readme",
        "license",
        "licence",
        "notice",
        "changelog",
        "contributing",
        "authors",
    ];
    DOC_EXT.contains(&ext) || DOC_NAME.contains(&stem)
}

fn valid_package(name: &str) -> Option<String> {
    let cleaned = strip_controls(name).trim().to_string();
    if cleaned.is_empty() || !chars_at_most(&cleaned, MAX_PACKAGE) {
        return None;
    }
    if cleaned == "." || cleaned == ".." || cleaned.contains('/') || cleaned.contains('\\') {
        return None;
    }
    let ok = cleaned
        .chars()
        .all(|c| c.is_alphanumeric() || c == '.' || c == '_' || c == '-');
    if ok {
        Some(cleaned)
    } else {
        None
    }
}

fn package_of(path: &str) -> Option<String> {
    let segments = segments_of(path);
    if segments.len() < 2 {
        return None;
    }
    for i in 0..segments.len() - 1 {
        let dir = segments[i].to_lowercase();
        if dir == "packages" || dir == "crates" || dir == "apps" {
            return valid_package(&segments[i + 1]);
        }
    }
    for i in 0..segments.len().saturating_sub(2) {
        if segments[i].eq_ignore_ascii_case("src")
            && segments[i + 1].eq_ignore_ascii_case("features")
        {
            return valid_package(&segments[i + 2]);
        }
    }
    valid_package(&segments[segments.len() - 2])
}

fn command_tokens(command: &str) -> Vec<String> {
    command
        .split_whitespace()
        .map(|token| token.trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|token| !token.is_empty())
        .collect()
}

fn looks_like_path(token: &str) -> bool {
    (token.contains('/') || token.contains('\\')) && !token.starts_with('-')
}

fn path_tokens(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in command_tokens(command) {
        if let Some(rest) = token.strip_prefix('-') {
            if let Some(value) = rest.split_once('=').map(|(_, value)| value) {
                if looks_like_path(value) {
                    out.push(value.to_string());
                }
            }
            continue;
        }
        if looks_like_path(&token) {
            out.push(token);
        }
    }
    out
}

fn named_packages(command: &str) -> Vec<String> {
    let tokens = command_tokens(command);
    let mut out = Vec::new();
    for (i, token) in tokens.iter().enumerate() {
        if token == "-p" || token == "--package" {
            if let Some(next) = tokens.get(i + 1) {
                if !next.starts_with('-') {
                    out.push(next.clone());
                }
            }
        } else if let Some(value) = token
            .strip_prefix("-p=")
            .or_else(|| token.strip_prefix("--package="))
        {
            out.push(value.to_string());
        }
    }
    out
}

fn test_reaches(command: &str, pkg: &str) -> bool {
    if !test_re().is_match(command) {
        return false;
    }
    let named = named_packages(command);
    let paths = path_tokens(command);
    if named.is_empty() && paths.is_empty() {
        return true;
    }
    if named.iter().any(|name| name == pkg) {
        return true;
    }
    paths
        .iter()
        .any(|path| package_of(path).as_deref() == Some(pkg))
}

fn status_word(status: &str) -> Option<&'static str> {
    match status {
        "passed" => Some("passed"),
        "failed" => Some("failed"),
        "running" => Some("running"),
        _ => None,
    }
}

fn sanitize_check(raw: &FactCheck) -> Option<StoredCheck> {
    let status = status_word(&raw.status)?;
    if !raw.at.is_finite() {
        return None;
    }
    let command = one_line(&raw.command, MAX_COMMAND);
    if command.is_empty() || !check_re().is_match(&command) {
        return None;
    }
    let display = take_chars(&command, MAX_DISPLAY).trim_end().to_string();
    Some(StoredCheck {
        command,
        display,
        status,
        at: raw.at,
    })
}

fn sanitize_edit(raw: &FactEdit) -> Option<FactEdit> {
    if !raw.at.is_finite() {
        return None;
    }
    let path = strip_controls(&raw.path).trim().to_string();
    if path.is_empty() || !chars_at_most(&path, MAX_PATH) {
        return None;
    }
    Some(FactEdit { path, at: raw.at })
}

fn sanitize_todo(raw: &FactTodo) -> Option<FactTodo> {
    let text = one_line(&raw.text, MAX_TODO);
    if text.is_empty() {
        return None;
    }
    Some(FactTodo {
        text,
        open: raw.open,
    })
}

fn clean_answer(answer: &str) -> String {
    let kept: String = answer
        .chars()
        .filter(|c| *c == '\n' || *c == '\r' || *c == '\t' || !c.is_control())
        .collect();
    take_chars(&kept, MAX_ANSWER)
}

struct CleanTurn {
    checks: Vec<StoredCheck>,
    edits: Vec<FactEdit>,
    todos: Vec<FactTodo>,
    answer: String,
}

fn sanitize(turn: &FactTurn) -> CleanTurn {
    CleanTurn {
        checks: turn
            .checks
            .iter()
            .filter_map(sanitize_check)
            .take(MAX_CHECKS)
            .collect(),
        edits: turn
            .edits
            .iter()
            .filter_map(sanitize_edit)
            .take(MAX_EDITS)
            .collect(),
        todos: turn
            .todos
            .iter()
            .filter_map(sanitize_todo)
            .take(MAX_TODOS)
            .collect(),
        answer: clean_answer(&turn.answer),
    }
}

fn last_code_at(edits: &[FactEdit]) -> Option<f64> {
    edits
        .iter()
        .filter(|edit| !is_docs_path(&edit.path))
        .map(|edit| edit.at)
        .max_by(f64::total_cmp)
}

fn claims_word(line: &str, what: &Regex) -> bool {
    !negated_re().is_match(line) && what.is_match(line) && pass_re().is_match(line)
}

/// A tests or build pass the answer states, one line at a time. A denial on the same line cancels that line.
pub fn claim_of(answer: &str) -> Option<PassClaim> {
    let text = clean_answer(answer);
    let mut tests = false;
    let mut build = false;
    for raw in text.split(['\n', '\r']) {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if claims_word(line, tests_re()) {
            tests = true;
        }
        if claims_word(line, build_re()) {
            build = true;
        }
    }
    if !tests && !build {
        return None;
    }
    Some(PassClaim { tests, build })
}

fn failure_gaps(checks: &[StoredCheck]) -> Vec<String> {
    let mut order = Vec::new();
    let mut last: HashMap<String, usize> = HashMap::new();
    for (index, check) in checks.iter().enumerate() {
        if !last.contains_key(&check.display) {
            order.push(check.display.clone());
        }
        last.insert(check.display.clone(), index);
    }
    let mut gaps = Vec::new();
    for key in order {
        let Some(index) = last.get(&key) else {
            continue;
        };
        let check = &checks[*index];
        if check.status == "failed" {
            gaps.push(format!("A check failed this turn ({}).", check.display));
        }
    }
    gaps
}

fn is_stale(checks: &[StoredCheck], edits: &[FactEdit]) -> bool {
    let Some(last) = last_code_at(edits) else {
        return false;
    };
    let tests: Vec<&StoredCheck> = checks
        .iter()
        .filter(|check| test_re().is_match(&check.command))
        .collect();
    let passed_before = tests
        .iter()
        .any(|check| check.status == "passed" && check.at <= last);
    let finished_after = tests
        .iter()
        .any(|check| (check.status == "passed" || check.status == "failed") && check.at > last);
    passed_before && !finished_after
}

fn claim_has_evidence(checks: &[StoredCheck], edits: &[FactEdit]) -> bool {
    match last_code_at(edits) {
        None => checks.iter().any(|check| check.status == "passed"),
        Some(last) => checks
            .iter()
            .any(|check| (check.status == "passed" || check.status == "failed") && check.at > last),
    }
}

fn open_todos(todos: &[FactTodo]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut open = Vec::new();
    for todo in todos {
        if !todo.open || !seen.insert(todo.text.clone()) {
            continue;
        }
        open.push(todo.text.clone());
    }
    open
}

/// Edited packages no finished test reached. Docs-only edits are skipped.
pub fn coverage_gaps(turn: &FactTurn) -> Vec<String> {
    let clean = sanitize(turn);
    let mut seen = HashSet::new();
    let mut gaps = Vec::new();
    for edit in &clean.edits {
        if is_docs_path(&edit.path) {
            continue;
        }
        let Some(pkg) = package_of(&edit.path) else {
            continue;
        };
        if !seen.insert(pkg.clone()) {
            continue;
        }
        let reached = clean.checks.iter().any(|check| {
            (check.status == "passed" || check.status == "failed")
                && test_reaches(&check.command, &pkg)
        });
        if !reached {
            gaps.push(format!("No test reached {pkg}."));
        }
    }
    gaps
}

/// Every fact gap in this turn, in a stable order. Empty when the facts support done.
pub fn done_gaps(turn: &FactTurn) -> Vec<String> {
    let clean = sanitize(turn);
    let mut gaps = failure_gaps(&clean.checks);
    if is_stale(&clean.checks, &clean.edits) {
        gaps.push(STALE.to_string());
    }
    if let Some(claim) = claim_of(&clean.answer) {
        if !claim_has_evidence(&clean.checks, &clean.edits) {
            if claim.tests {
                gaps.push(TESTS_CLAIM.to_string());
            }
            if claim.build {
                gaps.push(BUILD_CLAIM.to_string());
            }
        }
    }
    let open = open_todos(&clean.todos);
    if open.len() == 1 {
        gaps.push(format!("There is still an open to-do: {}.", open[0]));
    } else if open.len() > 1 {
        gaps.push(format!("There are still {} open to-dos.", open.len()));
    }
    gaps.extend(coverage_gaps(turn));
    gaps
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let mut out: String = first.to_lowercase().collect();
            out.push_str(chars.as_str());
            out
        }
    }
}

/// The first line a person sees. One gap keeps its sentence. More than one counts the rest.
pub fn sent_back_reason(gaps: &[String]) -> String {
    let Some(first) = gaps.first() else {
        return String::new();
    };
    let lead = lower_first(first);
    if gaps.len() == 1 {
        format!("Sent back: {lead}")
    } else {
        format!("Sent back: {lead} Also {} more.", gaps.len() - 1)
    }
}

/// What is stored on the gate and sent back to the worker.
pub fn fact_summary(gaps: &[String]) -> String {
    if gaps.is_empty() {
        return String::new();
    }
    let head = sent_back_reason(gaps);
    if gaps.len() == 1 {
        return head;
    }
    let mut out = head;
    out.push('\n');
    out.push_str(&gaps.join("\n"));
    out
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn number_field(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// Reads a facts payload that may be incomplete. A bad entry is dropped. This never fails the caller.
pub fn fact_turn_from_value(value: &Value) -> FactTurn {
    let Some(obj) = value.as_object() else {
        return FactTurn::default();
    };
    let checks = obj.get("checks").and_then(Value::as_array).map(|rows| {
        rows.iter()
            .map(|row| FactCheck {
                command: string_field(row, "command"),
                status: string_field(row, "status"),
                at: number_field(row, "at"),
            })
            .collect()
    });
    let edits = obj.get("edits").and_then(Value::as_array).map(|rows| {
        rows.iter()
            .map(|row| FactEdit {
                path: string_field(row, "path"),
                at: number_field(row, "at"),
            })
            .collect()
    });
    let todos = obj.get("todos").and_then(Value::as_array).map(|rows| {
        rows.iter()
            .map(|row| FactTodo {
                text: string_field(row, "text"),
                open: row.get("open").and_then(Value::as_bool).unwrap_or(false),
            })
            .collect()
    });
    FactTurn {
        checks: checks.unwrap_or_default(),
        edits: edits.unwrap_or_default(),
        todos: todos.unwrap_or_default(),
        answer: obj
            .get("answer")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(command: &str, status: &str, at: f64) -> FactCheck {
        FactCheck {
            command: command.to_string(),
            status: status.to_string(),
            at,
        }
    }

    fn edit(path: &str, at: f64) -> FactEdit {
        FactEdit {
            path: path.to_string(),
            at,
        }
    }

    fn todo(text: &str, open: bool) -> FactTodo {
        FactTodo {
            text: text.to_string(),
            open,
        }
    }

    fn turn(
        checks: Vec<FactCheck>,
        edits: Vec<FactEdit>,
        todos: Vec<FactTodo>,
        answer: &str,
    ) -> FactTurn {
        FactTurn {
            checks,
            edits,
            todos,
            answer: answer.to_string(),
        }
    }

    fn words(gaps: Vec<String>) -> Vec<String> {
        gaps
    }

    #[test]
    fn failed_check_and_a_later_pass() {
        let failed = done_gaps(&turn(
            vec![check("npm test", "failed", 1.0)],
            vec![],
            vec![],
            "",
        ));
        assert_eq!(words(failed), vec!["A check failed this turn (npm test)."]);
        let cleared = done_gaps(&turn(
            vec![
                check("npm test", "failed", 1.0),
                check("npm test", "passed", 2.0),
            ],
            vec![],
            vec![],
            "",
        ));
        assert!(cleared.is_empty());
    }

    #[test]
    fn running_is_not_a_failure_or_evidence() {
        let gaps = done_gaps(&turn(
            vec![check("npm test", "running", 1.0)],
            vec![edit("src/features/crew/row.ts", 2.0)],
            vec![],
            "The tests passed.",
        ));
        assert_eq!(
            gaps,
            vec![
                "The answer says the tests passed, but no check ran after the last edit."
                    .to_string(),
                "No test reached crew.".to_string(),
            ]
        );
    }

    #[test]
    fn stale_after_a_later_edit() {
        let gaps = done_gaps(&turn(
            vec![check("npx vitest run", "passed", 1.0)],
            vec![edit("src/features/crew/row.ts", 2.0)],
            vec![],
            "",
        ));
        assert_eq!(gaps, vec![STALE.to_string()]);
    }

    #[test]
    fn a_later_failure_is_not_stale_and_no_pass_is_not_stale() {
        let failed = done_gaps(&turn(
            vec![
                check("npx vitest run", "passed", 1.0),
                check("npx vitest run", "failed", 3.0),
            ],
            vec![edit("src/a.ts", 2.0)],
            vec![],
            "",
        ));
        assert_eq!(failed, vec!["A check failed this turn (npx vitest run)."]);
        let uncovered = done_gaps(&turn(
            vec![],
            vec![edit("src/features/crew/row.ts", 1.0)],
            vec![],
            "",
        ));
        assert_eq!(uncovered, vec!["No test reached crew."]);
    }

    #[test]
    fn a_docs_edit_does_not_make_a_test_stale() {
        let gaps = done_gaps(&turn(
            vec![check("npm test", "passed", 2.0)],
            vec![edit("src/a.ts", 1.0), edit("docs/guide.md", 3.0)],
            vec![],
            "",
        ));
        assert!(gaps.is_empty());
    }

    #[test]
    fn a_pass_claim_needs_a_check_after_the_edit() {
        let gaps = done_gaps(&turn(
            vec![check("npm test", "passed", 1.0)],
            vec![edit("src/a.ts", 2.0)],
            vec![],
            "12 tests passed.\nThe build passed.",
        ));
        assert!(gaps.contains(&TESTS_CLAIM.to_string()));
        assert!(gaps.contains(&BUILD_CLAIM.to_string()));
        assert!(claim_of("tests failed").is_none());
        assert!(claim_of("not all tests passed").is_none());
        assert_eq!(
            claim_of("the typecheck passed"),
            Some(PassClaim {
                tests: false,
                build: true
            })
        );
    }

    #[test]
    fn a_passing_check_counts_when_nothing_but_docs_changed() {
        let gaps = done_gaps(&turn(
            vec![check("npm test", "passed", 1.0)],
            vec![edit("docs/guide.md", 4.0)],
            vec![],
            "The tests passed.",
        ));
        assert!(gaps.is_empty());
    }

    #[test]
    fn open_todos() {
        let one = done_gaps(&turn(
            vec![],
            vec![],
            vec![todo("write the note", true)],
            "",
        ));
        assert_eq!(one, vec!["There is still an open to-do: write the note."]);
        let many = done_gaps(&turn(
            vec![],
            vec![],
            vec![
                todo("write the note", true),
                todo("write the note", true),
                todo("ship it", false),
                todo("ask Ash", true),
            ],
            "",
        ));
        assert_eq!(many, vec!["There are still 2 open to-dos."]);
    }

    #[test]
    fn uncovered_package_and_a_named_package_that_only_went_stale() {
        let uncovered = coverage_gaps(&turn(
            vec![check(
                "npx vitest run src/features/gates/a.test.ts",
                "passed",
                2.0,
            )],
            vec![edit("src/features/crew/row.ts", 1.0)],
            vec![],
            "",
        ));
        assert_eq!(uncovered, vec!["No test reached crew."]);
        let named = done_gaps(&turn(
            vec![check("cargo test -p crew", "passed", 1.0)],
            vec![edit("crates/crew/src/lib.rs", 2.0)],
            vec![],
            "",
        ));
        assert_eq!(named, vec![STALE.to_string()]);
    }

    #[test]
    fn a_project_wide_test_reaches_every_package() {
        let gaps = done_gaps(&turn(
            vec![check("npm test", "passed", 1.0)],
            vec![edit("packages/web/src/app.ts", 2.0)],
            vec![],
            "",
        ));
        assert_eq!(gaps, vec![STALE.to_string()]);
    }

    #[test]
    fn docs_only_edits_are_not_coverage_gaps() {
        let coverage = coverage_gaps(&turn(
            vec![],
            vec![
                edit("docs/guide.md", 1.0),
                edit("README.md", 2.0),
                edit("src/features/crew/README.md", 3.0),
            ],
            vec![],
            "",
        ));
        assert!(coverage.is_empty());
        let gaps = done_gaps(&turn(
            vec![check("npm test", "failed", 1.0)],
            vec![edit("docs/guide.md", 2.0)],
            vec![todo("fix the doc", true)],
            "The tests passed.",
        ));
        assert_eq!(
            gaps,
            vec![
                "A check failed this turn (npm test).".to_string(),
                TESTS_CLAIM.to_string(),
                "There is still an open to-do: fix the doc.".to_string(),
            ]
        );
    }

    #[test]
    fn code_named_docs_and_a_bare_filename() {
        assert_eq!(
            done_gaps(&turn(vec![], vec![edit("src/docs.ts", 1.0)], vec![], "")),
            vec!["No test reached src."]
        );
        assert!(done_gaps(&turn(vec![], vec![edit("row.ts", 1.0)], vec![], "")).is_empty());
    }

    #[test]
    fn windows_separators_and_dot_dot_segments() {
        assert_eq!(
            coverage_gaps(&turn(
                vec![],
                vec![edit("src\\features\\crew\\row.ts", 1.0)],
                vec![],
                ""
            )),
            vec!["No test reached crew."]
        );
        assert_eq!(
            coverage_gaps(&turn(
                vec![],
                vec![edit("packages/web/../other/a.ts", 1.0)],
                vec![],
                ""
            )),
            vec!["No test reached web."]
        );
    }

    #[test]
    fn empty_input_and_commands_that_are_not_checks() {
        assert!(done_gaps(&FactTurn::default()).is_empty());
        assert!(done_gaps(&turn(
            vec![check("git status", "failed", 1.0)],
            vec![],
            vec![],
            ""
        ))
        .is_empty());
        assert!(done_gaps(&turn(
            vec![check("npm test", "nope", 1.0)],
            vec![],
            vec![],
            ""
        ))
        .is_empty());
    }

    #[test]
    fn caps_checks_and_edits() {
        let checks = (0..41)
            .map(|at| check(&format!("npm test {at}"), "failed", at as f64))
            .collect();
        assert_eq!(done_gaps(&turn(checks, vec![], vec![], "")).len(), 40);
        let edits = (0..81)
            .map(|at| edit(&format!("src/pkg{at}/a.ts"), at as f64))
            .collect();
        assert_eq!(coverage_gaps(&turn(vec![], edits, vec![], "")).len(), 80);
    }

    #[test]
    fn sent_back_wording() {
        assert_eq!(
            sent_back_reason(&[STALE.to_string()]),
            "Sent back: tests went stale after the last edit."
        );
        assert_eq!(
            sent_back_reason(&[STALE.to_string(), "No test reached crew.".to_string()]),
            "Sent back: tests went stale after the last edit. Also 1 more."
        );
        assert_eq!(
            fact_summary(&[STALE.to_string()]),
            "Sent back: tests went stale after the last edit."
        );
        assert_eq!(
            fact_summary(&[
                "A check failed this turn (npm test).".to_string(),
                "No test reached crew.".to_string(),
            ]),
            "Sent back: a check failed this turn (npm test). Also 1 more.\nA check failed this turn (npm test).\nNo test reached crew."
        );
        assert!(sent_back_reason(&[]).is_empty());
    }

    #[test]
    fn a_bad_payload_drops_the_bad_entry() {
        let value = serde_json::json!({
            "checks": [{"command": "npm test", "status": "failed"}, "nope", {"command": "git status", "status": "failed", "at": 1}],
            "answer": "The tests passed."
        });
        let gaps = done_gaps(&fact_turn_from_value(&value));
        assert_eq!(gaps, vec![TESTS_CLAIM.to_string()]);
    }
}

/// Review round 1 (PR #232): failing repros. Each test states what the gate should do.
#[cfg(test)]
mod review_r1 {
    use super::*;

    fn check(command: &str, status: &str, at: f64) -> FactCheck {
        FactCheck {
            command: command.to_string(),
            status: status.to_string(),
            at,
        }
    }

    fn edit(path: &str, at: f64) -> FactEdit {
        FactEdit {
            path: path.to_string(),
            at,
        }
    }

    fn facts(checks: Vec<FactCheck>, edits: Vec<FactEdit>, answer: &str) -> FactTurn {
        FactTurn {
            checks,
            edits,
            todos: vec![],
            answer: answer.to_string(),
        }
    }

    // HIGH: this repo's documented Rust test command never reaches an edited module, so verified work is sent back
    // and, on the identical retry, delivery fails.
    #[test]
    fn r1_the_repos_own_cargo_test_reaches_an_edited_rust_module() {
        let gaps = done_gaps(&facts(
            vec![check(
                "cargo test --manifest-path src-tauri/Cargo.toml -p monocode --lib firstmate",
                "passed",
                2.0,
            )],
            vec![edit("src-tauri/src/firstmate/gates.rs", 1.0)],
            "",
        ));
        assert!(gaps.is_empty(), "{gaps:?}");
        let root = done_gaps(&facts(
            vec![check(
                "cd src-tauri && cargo test -p monocode",
                "passed",
                2.0,
            )],
            vec![edit("src-tauri/src/delegations.rs", 1.0)],
            "",
        ));
        assert!(root.is_empty(), "{root:?}");
    }

    // HIGH: `npm run check` (AGENTS.md: run it before calling anything done) runs vitest and cargo test, but is not a
    // test run here, so every edited package is "not reached".
    #[test]
    fn r1_npm_run_check_reaches_the_edited_package() {
        let gaps = done_gaps(&facts(
            vec![check("npm run check", "passed", 2.0)],
            vec![edit("src/features/crew/row.ts", 1.0)],
            "",
        ));
        assert!(gaps.is_empty(), "{gaps:?}");
    }

    // HIGH: the caps keep the oldest entries. Past 80 edits the last edit is dropped, so a stale test is not seen.
    #[test]
    fn r1_a_turn_past_the_edit_cap_still_sees_its_last_edit() {
        let mut edits: Vec<FactEdit> = (0..80)
            .map(|at| edit("src/features/crew/row.ts", at as f64))
            .collect();
        edits.push(edit("src/features/crew/row.ts", 200.0));
        let gaps = done_gaps(&facts(
            vec![check("npx vitest run", "passed", 100.0)],
            edits,
            "",
        ));
        assert!(gaps.contains(&STALE.to_string()), "{gaps:?}");
    }

    // HIGH: past 40 checks every later run is dropped, so a fresh test after the last edit is never seen and a
    // correct worker is refused twice (delivery failed).
    #[test]
    fn r1_a_turn_past_the_check_cap_still_sees_its_last_test() {
        let mut checks: Vec<FactCheck> = (0..40)
            .map(|at| check("npx tsc --noEmit", "passed", at as f64))
            .collect();
        checks.push(check("npx vitest run", "passed", 60.0));
        let gaps = done_gaps(&facts(
            checks,
            vec![edit("src/features/crew/row.ts", 50.0)],
            "",
        ));
        assert!(gaps.is_empty(), "{gaps:?}");
    }

    // MED: a command that only names a runner counts as a passing, project-wide test run.
    #[test]
    fn r1_reading_a_vitest_config_or_echoing_npm_test_is_not_a_test_run() {
        for fake in [
            "cat vitest.config.ts",
            "echo npm test",
            "git commit -m \"fix row, ran npm test\"",
        ] {
            let gaps = done_gaps(&facts(
                vec![
                    check("npx vitest run", "passed", 1.0),
                    check(fake, "passed", 3.0),
                ],
                vec![edit("src/features/crew/row.ts", 2.0)],
                "",
            ));
            assert_eq!(gaps, vec![STALE.to_string()], "{fake}");
        }
    }

    // MED: the exit status of `| tail` hides a failing suite; it should not back a pass claim.
    #[test]
    fn r1_a_test_piped_into_tail_is_not_evidence_of_a_pass() {
        let gaps = done_gaps(&facts(
            vec![check("npm test 2>&1 | tail -20", "passed", 2.0)],
            vec![edit("src/features/crew/row.ts", 1.0)],
            "All tests passed.",
        ));
        assert!(!gaps.is_empty(), "a masked exit status was taken as a pass");
    }

    // MED: `one_line` strips the newline before it splits, so a multi-line command is glued into one word and a
    // failing check vanishes.
    #[test]
    fn r1_a_multi_line_failing_check_is_still_a_failure() {
        let gaps = done_gaps(&facts(
            vec![
                check("npm test", "passed", 1.0),
                check("cd src-tauri\ncargo test", "failed", 2.0),
            ],
            vec![edit("src/features/crew/row.ts", 0.0)],
            "",
        ));
        assert!(
            gaps.iter()
                .any(|gap| gap.starts_with("A check failed this turn")),
            "{gaps:?}"
        );
    }

    // LOW: a failing build is not a check, so it never fails the claim.
    #[test]
    fn r1_a_failing_build_is_a_failed_check() {
        let gaps = done_gaps(&facts(
            vec![
                check("npm test", "passed", 2.0),
                check(
                    "cargo build --manifest-path src-tauri/Cargo.toml",
                    "failed",
                    3.0,
                ),
            ],
            vec![edit("src/features/crew/row.ts", 1.0)],
            "",
        ));
        assert!(
            gaps.iter()
                .any(|gap| gap.starts_with("A check failed this turn")),
            "{gaps:?}"
        );
    }

    // MED: Claude's edit paths are absolute, so the `docs/` rule (first segment) never matches and a non-Markdown
    // file under docs/ is code: a stale test and a coverage gap.
    #[test]
    fn r1_a_docs_folder_edit_with_an_absolute_path_is_still_docs() {
        let gaps = done_gaps(&facts(
            vec![check("npm test", "passed", 1.0)],
            vec![edit(
                "/Users/ash/Worktrees/hub-x/docs/hivra/credits.json",
                2.0,
            )],
            "",
        ));
        assert!(gaps.is_empty(), "{gaps:?}");
    }
}
