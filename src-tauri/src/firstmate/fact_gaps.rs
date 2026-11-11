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

/// What one command actually runs. A name in a sentence or a filename is not a run.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CommandRole {
    /// A lint, a type check or a build. It can fail the turn. It does not cover a package.
    Check,
    /// A test runner. It covers packages and it can fail the turn.
    Test,
}

struct Invocation {
    program: String,
    args: Vec<String>,
    /// A `cd` earlier in the same command, when there was one.
    cwd: Option<String>,
    /// True when this command's output is piped. The pipe's exit status is not the runner's.
    piped: bool,
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
    // Any segment, so an absolute path (`/work/repo/docs/credits.json`) is still docs. `src/docs.ts` is not.
    if segments
        .iter()
        .any(|part| part.eq_ignore_ascii_case("docs"))
    {
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

/// Newlines become `&&` before other control characters are stripped, so a second line stays its own command.
fn command_text(raw: &str) -> String {
    let mut separated = String::new();
    for c in raw.chars() {
        if c == '\n' || c == '\r' {
            separated.push_str(" && ");
        } else if c == '\t' {
            separated.push(' ');
        } else if !c.is_control() {
            separated.push(c);
        }
    }
    one_line(&separated, MAX_COMMAND)
}

fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in text.chars() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                cur.push(c);
            }
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            continue;
        }
        if c.is_whitespace() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn split_statements(command: &str) -> Vec<String> {
    let chars: Vec<char> = command.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            i += 1;
            continue;
        }
        let next = chars.get(i + 1).copied();
        let separator =
            (c == '&' && next == Some('&')) || (c == '|' && next == Some('|')) || c == ';';
        if separator {
            out.push(chars[start..i].iter().collect());
            i += if c == ';' { 1 } else { 2 };
            start = i;
            continue;
        }
        i += 1;
    }
    out.push(chars[start..].iter().collect());
    out
}

fn split_pipes(statement: &str) -> Vec<String> {
    let chars: Vec<char> = statement.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            i += 1;
            continue;
        }
        if c == '|' && chars.get(i + 1).copied() != Some('|') {
            out.push(chars[start..i].iter().collect());
            i += 1;
            start = i;
            continue;
        }
        if c == '|' {
            i += 2;
            continue;
        }
        i += 1;
    }
    out.push(chars[start..].iter().collect());
    out
}

fn program_and_args(tokens: Vec<String>) -> (String, Vec<String>) {
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        if !token.starts_with('-')
            && token.contains('=')
            && !token.contains('/')
            && !token.contains('\\')
        {
            i += 1;
            continue;
        }
        break;
    }
    if i >= tokens.len() {
        return (String::new(), Vec::new());
    }
    (tokens[i].clone(), tokens[i + 1..].to_vec())
}

fn invocations(command: &str) -> Vec<Invocation> {
    let mut cwd: Option<String> = None;
    let mut out = Vec::new();
    for statement in split_statements(command) {
        let stages = split_pipes(&statement);
        let piped = stages.len() > 1;
        let Some(stage) = stages.first() else {
            continue;
        };
        let (program, args) = program_and_args(tokenize(stage));
        if program.is_empty() {
            continue;
        }
        let invocation = Invocation {
            program: program.clone(),
            args,
            cwd: cwd.clone(),
            piped,
        };
        if !piped && program.eq_ignore_ascii_case("cd") {
            if let Some(dir) = invocation.args.first() {
                if !dir.starts_with('-') {
                    cwd = Some(dir.clone());
                }
            }
        }
        out.push(invocation);
    }
    out
}

fn first_positional(args: &[String]) -> Option<&str> {
    args.iter()
        .find(|arg| !arg.starts_with('-'))
        .map(String::as_str)
}

fn npm_role(args: &[String]) -> Option<CommandRole> {
    let script = if args
        .first()
        .is_some_and(|arg| arg.eq_ignore_ascii_case("run"))
    {
        args.get(1)
    } else {
        args.first()
    }?;
    let script = script.to_lowercase();
    if script == "test" || script.ends_with(":test") || script == "check" {
        // `npm run check` is this repo's full check: it runs the tests.
        return Some(CommandRole::Test);
    }
    if script == "lint" || script == "typecheck" || script.ends_with(":check") {
        return Some(CommandRole::Check);
    }
    None
}

fn cargo_role(args: &[String]) -> Option<CommandRole> {
    match first_positional(args).map(str::to_lowercase).as_deref() {
        Some("test" | "nextest") => Some(CommandRole::Test),
        Some("check" | "clippy" | "build") => Some(CommandRole::Check),
        _ => None,
    }
}

fn role_of(invocation: &Invocation) -> Option<CommandRole> {
    let program = invocation.program.to_lowercase();
    let tool = if program == "npx" {
        first_positional(&invocation.args)
            .unwrap_or("")
            .to_lowercase()
    } else {
        program
    };
    match tool.as_str() {
        "vitest" | "jest" | "pytest" | "playwright" | "cypress" => Some(CommandRole::Test),
        "tsc" | "eslint" | "biome" | "ruff" | "mypy" => Some(CommandRole::Check),
        "cargo" => cargo_role(&invocation.args),
        "go" | "swift" => {
            if first_positional(&invocation.args)
                .is_some_and(|arg| arg.eq_ignore_ascii_case("test"))
            {
                Some(CommandRole::Test)
            } else {
                None
            }
        }
        "make" => match first_positional(&invocation.args)
            .map(str::to_lowercase)
            .as_deref()
        {
            Some("test") => Some(CommandRole::Test),
            Some("check" | "verify") => Some(CommandRole::Check),
            _ => None,
        },
        "npm" | "pnpm" | "yarn" | "bun" => npm_role(&invocation.args),
        _ => None,
    }
}

fn counts_as_check(command: &str, status: &str) -> bool {
    invocations(command).into_iter().any(|invocation| {
        role_of(&invocation).is_some() && (status == "failed" || !invocation.piped)
    })
}

fn is_test_command(command: &str) -> bool {
    invocations(command)
        .iter()
        .any(|invocation| !invocation.piped && role_of(invocation) == Some(CommandRole::Test))
}

fn looks_like_path(token: &str) -> bool {
    (token.contains('/') || token.contains('\\')) && !token.starts_with('-')
}

fn path_tokens(tokens: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for token in tokens {
        if let Some(rest) = token.strip_prefix('-') {
            if let Some(value) = rest.split_once('=').map(|(_, value)| value) {
                if looks_like_path(value) {
                    out.push(value.to_string());
                }
            }
            continue;
        }
        if looks_like_path(token) {
            out.push(token.clone());
        }
    }
    out
}

fn named_packages(tokens: &[String]) -> Vec<String> {
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

fn parent_dir(path: &str) -> Option<String> {
    let segments = segments_of(path);
    if segments.len() < 2 {
        return None;
    }
    Some(segments[..segments.len() - 1].join("/"))
}

fn manifest_dir(args: &[String]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(value) = arg.strip_prefix("--manifest-path=") {
            return parent_dir(value);
        }
        if arg == "--manifest-path" {
            return args.get(i + 1).and_then(|path| parent_dir(path));
        }
        i += 1;
    }
    None
}

fn path_under(root: &str, path: &str) -> bool {
    let root_segs = segments_of(root);
    let path_segs = segments_of(path);
    if root_segs.is_empty() || path_segs.len() <= root_segs.len() {
        return false;
    }
    root_segs
        .iter()
        .zip(path_segs.iter())
        .all(|(root_part, path_part)| root_part.eq_ignore_ascii_case(path_part))
}

/// `crates/<name>`, `packages/<name>` or `apps/<name>`, when the path is inside one.
fn workspace_member(path: &str) -> Option<String> {
    let segments = segments_of(path);
    for i in 0..segments.len().saturating_sub(1) {
        let dir = segments[i].to_lowercase();
        if dir == "crates" || dir == "packages" || dir == "apps" {
            return valid_package(&segments[i + 1]);
        }
    }
    None
}

/// The crate root of a `cargo test`, from `--manifest-path` or an earlier `cd`. None for any other command.
fn cargo_root(invocation: &Invocation) -> Option<String> {
    if !invocation.program.eq_ignore_ascii_case("cargo") {
        return None;
    }
    let sub = invocation.args.first()?.to_lowercase();
    if sub != "test" && sub != "nextest" {
        return None;
    }
    manifest_dir(&invocation.args).or_else(|| invocation.cwd.clone())
}

fn cargo_root_covers(invocation: &Invocation, root: &str, edited: &str) -> bool {
    if !path_under(root, edited) {
        return false;
    }
    // A file under crates/, packages/ or apps/ is its own package. A bare cargo test does not cover it
    // unless `-p` names it. The crate at the manifest root (this repo's `src-tauri/src`) is not one of those.
    if let Some(member) = workspace_member(edited) {
        return named_packages(&invocation.args)
            .iter()
            .any(|name| name == &member);
    }
    true
}

fn invocation_reaches(invocation: &Invocation, pkg: &str, edited: &str) -> bool {
    if invocation.piped || role_of(invocation) != Some(CommandRole::Test) {
        return false;
    }
    if let Some(root) = cargo_root(invocation) {
        return cargo_root_covers(invocation, &root, edited);
    }
    let named = named_packages(&invocation.args);
    let paths = path_tokens(&invocation.args);
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

fn test_reaches(command: &str, pkg: &str, edited: &str) -> bool {
    invocations(command)
        .iter()
        .any(|invocation| invocation_reaches(invocation, pkg, edited))
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
    let command = command_text(&raw.command);
    if command.is_empty() || !counts_as_check(&command, status) {
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
        checks: keep_last(turn.checks.iter().filter_map(sanitize_check), MAX_CHECKS),
        edits: keep_last(turn.edits.iter().filter_map(sanitize_edit), MAX_EDITS),
        todos: turn
            .todos
            .iter()
            .filter_map(sanitize_todo)
            .take(MAX_TODOS)
            .collect(),
        answer: clean_answer(&turn.answer),
    }
}

fn keep_last<T>(items: impl IntoIterator<Item = T>, max: usize) -> Vec<T> {
    let mut items: Vec<T> = items.into_iter().collect();
    if items.len() > max {
        let extra = items.len() - max;
        items.drain(..extra);
    }
    items
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
        .filter(|check| is_test_command(&check.command))
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
                && test_reaches(&check.command, &pkg, &edit.path)
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
