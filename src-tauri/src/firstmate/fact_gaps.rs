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
use std::path::{Path, PathBuf};
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
const MASKED: &str = "A piped or masked run does not count.";
/// A workspace manifest or a member manifest bigger than this is not read.
const MAX_TOML_BYTES: u64 = 256 * 1024;
const MAX_WORKSPACE_MEMBERS: usize = 200;
const MAX_WORKSPACE_WALK: usize = 12;

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
    /// A pass is judged from `masked`, which also covers `;` and `||`. This stays so the two can be told apart.
    #[allow(dead_code)]
    piped: bool,
    /// True when a pass of this command is not the runner's own status.
    /// A pipe without `pipefail`, or any `;` or `||` after the runner, masks it. `&&` does not.
    masked: bool,
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

/// `docs` at the checkout root, including an absolute path whose `docs` segment is not inside source.
/// A folder named docs under `src` or `features` is code. `src/docs.ts` is a filename, not that folder.
fn docs_at_checkout_root(segments: &[String]) -> bool {
    const INTERIOR: &[&str] = &[
        "src", "crates", "packages", "apps", "features", "lib", "app", "test", "tests", "host",
        "scripts",
    ];
    if segments
        .first()
        .is_some_and(|part| part.eq_ignore_ascii_case("docs"))
    {
        return true;
    }
    let Some(at) = segments
        .iter()
        .position(|part| part.eq_ignore_ascii_case("docs"))
    else {
        return false;
    };
    !segments[..at]
        .iter()
        .any(|part| INTERIOR.iter().any(|name| part.eq_ignore_ascii_case(name)))
}

/// SC-3a: a check that failed and was not run green again. `failure_gaps` makes this sentence.
pub(crate) fn is_failed_check_gap(gap: &str) -> bool {
    gap.starts_with("A check failed this turn (")
}

/// SC-3a: an open to-do. `gaps_before_coverage` makes these sentences.
pub(crate) fn is_open_todo_gap(gap: &str) -> bool {
    gap.starts_with("There is still an open to-do: ")
        || (gap.starts_with("There are still ") && gap.ends_with(" open to-dos."))
}

pub(crate) fn is_docs_path(path: &str) -> bool {
    let segments = segments_of(path);
    if segments.is_empty() {
        return false;
    }
    if docs_at_checkout_root(&segments) {
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

/// A line break is its own command, joined with `;`. `&&` would hide a failure on the line above.
/// A CRLF pair is one break, not two.
fn command_text(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut separated = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\r' || c == '\n' {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            separated.push_str(" ; ");
            i += 1;
            continue;
        }
        if c == '\t' {
            separated.push(' ');
        } else if !c.is_control() {
            separated.push(c);
        }
        i += 1;
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Join {
    And,
    Or,
    Semi,
}

struct Piece {
    text: String,
    /// The separator after this piece. None on the last piece.
    after: Option<Join>,
}

fn split_statements(command: &str) -> Vec<Piece> {
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
        let join = if c == '&' && next == Some('&') {
            Some(Join::And)
        } else if c == '|' && next == Some('|') {
            Some(Join::Or)
        } else if c == ';' {
            Some(Join::Semi)
        } else {
            None
        };
        if let Some(join) = join {
            out.push(Piece {
                text: chars[start..i].iter().collect(),
                after: Some(join),
            });
            i += if join == Join::Semi { 1 } else { 2 };
            start = i;
            continue;
        }
        i += 1;
    }
    out.push(Piece {
        text: chars[start..].iter().collect(),
        after: None,
    });
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

/// `set -o pipefail` and `set -euo pipefail` turn the pipe's status into the runner's.
/// `set +o pipefail` turns that off. Anything else leaves the current setting.
fn pipefail_change(statement: &str) -> Option<bool> {
    let tokens = tokenize(statement.trim());
    if tokens.first().is_none_or(|word| word != "set") {
        return None;
    }
    let rest = &tokens[1..];
    if rest.len() >= 2 && rest[0] == "+o" && rest[1] == "pipefail" {
        return Some(false);
    }
    if rest.len() >= 2 && rest[0] == "-o" && rest[1] == "pipefail" {
        return Some(true);
    }
    let enables = rest.iter().any(|token| token == "pipefail")
        && rest.iter().any(|token| {
            let Some(flags) = token.strip_prefix('-') else {
                return false;
            };
            !flags.is_empty() && !token.starts_with("--") && flags.contains('o')
        });
    if enables {
        Some(true)
    } else {
        None
    }
}

fn pipefail_before(pieces: &[Piece]) -> Vec<bool> {
    let mut on = false;
    let mut before = Vec::with_capacity(pieces.len());
    for piece in pieces {
        before.push(on);
        if let Some(next) = pipefail_change(&piece.text) {
            on = next;
        }
    }
    before
}

/// A pass counts only when every separator after the runner is `&&` (or there is none).
fn separators_after_are_and(pieces: &[Piece], index: usize) -> bool {
    pieces[index..]
        .iter()
        .all(|piece| piece.after.is_none() || piece.after == Some(Join::And))
}

fn invocations(command: &str) -> Vec<Invocation> {
    let pieces = split_statements(command);
    let pipefail = pipefail_before(&pieces);
    let mut cwd: Option<String> = None;
    let mut out = Vec::new();
    for (index, piece) in pieces.iter().enumerate() {
        let stages = split_pipes(&piece.text);
        let piped = stages.len() > 1;
        let Some(stage) = stages.first() else {
            continue;
        };
        let (program, args) = program_and_args(tokenize(stage));
        if program.is_empty() {
            continue;
        }
        let pipe_masks = piped && !pipefail[index];
        let tail_masks = !separators_after_are_and(&pieces, index);
        let invocation = Invocation {
            program: program.clone(),
            args,
            cwd: cwd.clone(),
            piped,
            masked: pipe_masks || tail_masks,
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
    // `npm run check` is this repo's full check. `check:web` and `check:rust` are the same family.
    // `native:check` is not: only a script named `check` or starting with `check:` runs the tests.
    if script == "test"
        || script.ends_with(":test")
        || script == "check"
        || script.starts_with("check:")
    {
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

/// A runner that compiles, prints a version, or lists tests did not run them.
fn runs_no_tests(args: &[String]) -> bool {
    args.iter().any(|arg| {
        let name = arg.split_once('=').map(|(flag, _)| flag).unwrap_or(arg);
        matches!(
            name,
            "--no-run"
                | "--version"
                | "-V"
                | "--listTests"
                | "--list-tests"
                | "--showConfig"
                | "--show-config"
                | "--collect-only"
                | "--help"
                | "-h"
        )
    })
}

fn role_of(invocation: &Invocation) -> Option<CommandRole> {
    let role = command_role(invocation)?;
    if role == CommandRole::Test && runs_no_tests(&invocation.args) {
        return Some(CommandRole::Check);
    }
    Some(role)
}

fn command_role(invocation: &Invocation) -> Option<CommandRole> {
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
    if status_word(status).is_none() {
        return false;
    }
    // A masked pass is kept so the send-back can say why it does not count. It is not evidence.
    invocations(command)
        .into_iter()
        .any(|invocation| role_of(&invocation).is_some())
}

fn is_test_command(command: &str) -> bool {
    invocations(command)
        .iter()
        .any(|invocation| !invocation.masked && role_of(invocation) == Some(CommandRole::Test))
}

/// The command names a test runner, and every one of those runs is masked.
fn command_masks_a_pass(command: &str) -> bool {
    let mut saw_test = false;
    let mut saw_real = false;
    for invocation in invocations(command) {
        if role_of(&invocation) != Some(CommandRole::Test) {
            continue;
        }
        saw_test = true;
        if !invocation.masked {
            saw_real = true;
        }
    }
    saw_test && !saw_real
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

/// The root is a run of path segments, with at least one segment after it.
/// A relative root (`src-tauri`) matches an absolute edit (`/work/repo/src-tauri/src/a.rs`).
fn path_under(root: &str, path: &str) -> bool {
    let root_segs = segments_of(root);
    let path_segs = segments_of(path);
    let width = root_segs.len();
    if width == 0 || path_segs.len() <= width {
        return false;
    }
    path_segs.windows(width).enumerate().any(|(index, window)| {
        index + width < path_segs.len()
            && window
                .iter()
                .zip(root_segs.iter())
                .all(|(path_part, root_part)| path_part.eq_ignore_ascii_case(root_part))
    })
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

fn invocation_reaches(
    invocation: &Invocation,
    pkg: &str,
    edited: &str,
    packages: &HashMap<String, String>,
) -> bool {
    if invocation.masked || role_of(invocation) != Some(CommandRole::Test) {
        return false;
    }
    if let Some(root) = cargo_root(invocation) {
        return cargo_root_covers(invocation, &root, edited);
    }
    let named = named_packages(&invocation.args);
    let paths = path_tokens(&invocation.args);
    // No paths and no `-p` is a project-wide run. It reaches every package.
    if named.is_empty() && paths.is_empty() {
        return true;
    }
    if named.iter().any(|name| name == pkg) {
        return true;
    }
    if paths
        .iter()
        .any(|path| package_of(path).as_deref() == Some(pkg))
    {
        return true;
    }
    // `-p monocode` names the package in Cargo.toml, whose folder is `src-tauri`, not `firstmate`.
    named.iter().any(|name| {
        packages
            .get(name)
            .is_some_and(|folder| path_under(folder, edited))
    })
}

fn test_reaches(
    command: &str,
    pkg: &str,
    edited: &str,
    packages: &HashMap<String, String>,
) -> bool {
    invocations(command)
        .iter()
        .any(|invocation| invocation_reaches(invocation, pkg, edited, packages))
}

fn member_path_is_safe(rel: &str) -> bool {
    if rel.is_empty()
        || rel.contains('\0')
        || rel.contains('*')
        || rel.contains('?')
        || rel.starts_with('/')
        || rel.starts_with('\\')
    {
        return false;
    }
    if rel.as_bytes().get(1) == Some(&b':') {
        return false;
    }
    !rel.split(['/', '\\'])
        .any(|part| part.is_empty() || part == "." || part == "..")
}

fn read_inside(root: &Path, path: &Path) -> Option<String> {
    let canon = crate::fs::canonical(path).ok()?;
    if !canon.starts_with(root) {
        return None;
    }
    let meta = std::fs::metadata(&canon).ok()?;
    if !meta.is_file() || meta.len() > MAX_TOML_BYTES {
        return None;
    }
    std::fs::read_to_string(&canon).ok()
}

fn toml_has_members(text: &str) -> bool {
    toml::from_str::<toml::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("workspace")
                .and_then(|workspace| workspace.get("members"))
                .and_then(|members| members.as_array())
                .map(|members| !members.is_empty())
        })
        .unwrap_or(false)
}

/// Walk up from the process folder to a Cargo.toml that lists workspace members.
/// Used when a unit test has no checkout. A worker's checkout is never discovered this way.
fn discover_workspace_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    for _ in 0..MAX_WORKSPACE_WALK {
        if dir.join("Cargo.toml").is_file() {
            if let Ok(root) = crate::fs::canonical(&dir) {
                if let Some(text) = read_inside(&root, &root.join("Cargo.toml")) {
                    if toml_has_members(&text) {
                        return Some(root);
                    }
                }
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Package name to member folder, from the checkout's workspace Cargo.toml.
/// A bad, huge, or escaping manifest is an empty map, and `-p` then matches the folder name only.
fn workspace_packages(checkout: Option<&Path>) -> Option<HashMap<String, String>> {
    let root = match checkout {
        Some(path) => crate::fs::canonical(path).ok()?,
        None => discover_workspace_root()?,
    };
    let text = read_inside(&root, &root.join("Cargo.toml"))?;
    let value = toml::from_str::<toml::Value>(&text).ok()?;
    let members = value
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(|members| members.as_array())?;
    let mut map = HashMap::new();
    for member in members.iter().take(MAX_WORKSPACE_MEMBERS) {
        let Some(rel) = member.as_str() else {
            continue;
        };
        if !member_path_is_safe(rel) {
            continue;
        }
        let Some(body) = read_inside(&root, &root.join(rel).join("Cargo.toml")) else {
            continue;
        };
        let Ok(parsed) = toml::from_str::<toml::Value>(&body) else {
            continue;
        };
        let Some(name) = parsed
            .get("package")
            .and_then(|package| package.get("name"))
            .and_then(|name| name.as_str())
        else {
            continue;
        };
        let Some(valid) = valid_package(name) else {
            continue;
        };
        map.entry(valid).or_insert_with(|| rel.replace('\\', "/"));
    }
    Some(map).filter(|map| !map.is_empty())
}

fn workspace_or_empty(checkout: Option<&Path>) -> HashMap<String, String> {
    workspace_packages(checkout).unwrap_or_default()
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
        checks: keep_last(
            latest_per_command(turn.checks.iter().filter_map(sanitize_check)),
            MAX_CHECKS,
        ),
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

/// Only the latest run of each command decides anything (`failure_gaps` reads the last one per display, and a later
/// run of the same command is always the fresher one), so repeats collapse before the cap. Forty quick type checks are
/// then one entry and cannot push an earlier failing test out. Order is the order of each command's latest run.
fn latest_per_command(items: impl IntoIterator<Item = StoredCheck>) -> Vec<StoredCheck> {
    let items: Vec<StoredCheck> = items.into_iter().collect();
    let mut last: HashMap<&str, usize> = HashMap::new();
    for (index, check) in items.iter().enumerate() {
        last.insert(check.display.as_str(), index);
    }
    let keep: std::collections::HashSet<usize> = last.into_values().collect();
    items
        .into_iter()
        .enumerate()
        .filter(|(index, _)| keep.contains(index))
        .map(|(_, check)| check)
        .collect()
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

struct PackageEdit {
    pkg: String,
    path: String,
    at: f64,
}

/// First-seen order. The time and path are that package's last edit that is not docs.
fn package_edits(edits: &[FactEdit]) -> Vec<PackageEdit> {
    let mut order = Vec::new();
    let mut latest: HashMap<String, PackageEdit> = HashMap::new();
    for edit in edits {
        if is_docs_path(&edit.path) {
            continue;
        }
        let Some(pkg) = package_of(&edit.path) else {
            continue;
        };
        let replace = match latest.get(&pkg) {
            None => true,
            Some(prev) => edit.at >= prev.at,
        };
        if !replace {
            continue;
        }
        if !latest.contains_key(&pkg) {
            order.push(pkg.clone());
        }
        latest.insert(
            pkg.clone(),
            PackageEdit {
                pkg,
                path: edit.path.clone(),
                at: edit.at,
            },
        );
    }
    order
        .into_iter()
        .filter_map(|pkg| latest.remove(&pkg))
        .collect()
}

fn test_reaches_check(
    check: &StoredCheck,
    target: &PackageEdit,
    packages: &HashMap<String, String>,
) -> bool {
    is_test_command(&check.command)
        && test_reaches(&check.command, &target.pkg, &target.path, packages)
}

fn finished_after_edit(
    check: &StoredCheck,
    target: &PackageEdit,
    packages: &HashMap<String, String>,
) -> bool {
    (check.status == "passed" || check.status == "failed")
        && check.at > target.at
        && test_reaches_check(check, target, packages)
}

fn package_is_stale(
    checks: &[StoredCheck],
    target: &PackageEdit,
    packages: &HashMap<String, String>,
) -> bool {
    let mut passed_before = false;
    let mut finished_after = false;
    for check in checks {
        if !test_reaches_check(check, target, packages) {
            continue;
        }
        if check.status == "passed" && check.at <= target.at {
            passed_before = true;
        }
        if (check.status == "passed" || check.status == "failed") && check.at > target.at {
            finished_after = true;
        }
    }
    passed_before && !finished_after
}

/// A file with no package. A later test still clears it: nothing names which package that test was for.
/// Docs do not count.
fn bare_edit_is_stale(checks: &[StoredCheck], edits: &[FactEdit]) -> bool {
    let mut last: Option<f64> = None;
    for edit in edits {
        if is_docs_path(&edit.path) || package_of(&edit.path).is_some() {
            continue;
        }
        last = Some(match last {
            Some(at) if at > edit.at => at,
            _ => edit.at,
        });
    }
    let Some(last) = last else {
        return false;
    };
    let passed_before = checks.iter().any(|check| {
        is_test_command(&check.command) && check.status == "passed" && check.at <= last
    });
    let finished_after = checks.iter().any(|check| {
        is_test_command(&check.command)
            && (check.status == "passed" || check.status == "failed")
            && check.at > last
    });
    passed_before && !finished_after
}

fn stale_packages(
    checks: &[StoredCheck],
    edits: &[FactEdit],
    packages: &HashMap<String, String>,
) -> HashSet<String> {
    let mut stale = HashSet::new();
    for target in package_edits(edits) {
        if package_is_stale(checks, &target, packages) {
            stale.insert(target.pkg);
        }
    }
    stale
}

fn counts_as_evidence(check: &StoredCheck) -> bool {
    match check.status {
        "failed" => true,
        "passed" => !command_masks_a_pass(&check.command),
        _ => false,
    }
}

fn claim_has_evidence(checks: &[StoredCheck], edits: &[FactEdit]) -> bool {
    match last_code_at(edits) {
        None => checks
            .iter()
            .any(|check| check.status == "passed" && !command_masks_a_pass(&check.command)),
        Some(last) => checks
            .iter()
            .any(|check| counts_as_evidence(check) && check.at > last),
    }
}

fn masked_pass_stands_in(checks: &[StoredCheck]) -> bool {
    let mut saw_masked = false;
    let mut saw_real = false;
    for check in checks {
        if check.status != "passed" {
            continue;
        }
        if is_test_command(&check.command) {
            saw_real = true;
        } else if command_masks_a_pass(&check.command) {
            saw_masked = true;
        }
    }
    saw_masked && !saw_real
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

fn coverage_with(turn: &FactTurn, packages: &HashMap<String, String>) -> Vec<String> {
    let clean = sanitize(turn);
    let mut gaps = Vec::new();
    for target in package_edits(&clean.edits) {
        let reached = clean
            .checks
            .iter()
            .any(|check| finished_after_edit(check, &target, packages));
        if !reached {
            let pkg = target.pkg;
            gaps.push(format!("No test reached {pkg}."));
        }
    }
    gaps
}

/// Edited packages no test finished after that package's last edit. Docs-only edits are skipped.
pub fn coverage_gaps(turn: &FactTurn) -> Vec<String> {
    coverage_with(turn, &workspace_or_empty(None))
}

/// A package that already went stale does not also get "no test reached". The stale sentence is that fact.
fn without_stale_packages(gaps: Vec<String>, stale_pkgs: &HashSet<String>) -> Vec<String> {
    gaps.into_iter()
        .filter(|gap| {
            !gap.strip_prefix("No test reached ")
                .and_then(|rest| rest.strip_suffix('.'))
                .is_some_and(|name| stale_pkgs.contains(name))
        })
        .collect()
}

fn gaps_before_coverage(
    turn: &FactTurn,
    packages: &HashMap<String, String>,
) -> (Vec<String>, HashSet<String>) {
    let clean = sanitize(turn);
    let mut gaps = failure_gaps(&clean.checks);
    if masked_pass_stands_in(&clean.checks) {
        gaps.push(MASKED.to_string());
    }
    let stale_pkgs = stale_packages(&clean.checks, &clean.edits, packages);
    if !stale_pkgs.is_empty() || bare_edit_is_stale(&clean.checks, &clean.edits) {
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
    (gaps, stale_pkgs)
}

fn done_gaps_with(turn: &FactTurn, packages: &HashMap<String, String>) -> Vec<String> {
    let (mut gaps, stale_pkgs) = gaps_before_coverage(turn, packages);
    gaps.extend(without_stale_packages(
        coverage_with(turn, packages),
        &stale_pkgs,
    ));
    gaps
}

/// Every fact gap in this turn, in a stable order. Empty when the facts support done.
/// `checkout` is the worker's project. None discovers a workspace from the process folder (unit tests).
pub(crate) fn done_gaps_in(turn: &FactTurn, checkout: Option<&Path>) -> Vec<String> {
    // No checkout is the unit-test entry, which is `done_gaps` itself.
    let Some(checkout) = checkout else {
        return done_gaps(turn);
    };
    done_gaps_with(turn, &workspace_or_empty(Some(checkout)))
}

/// Every fact gap in this turn, in a stable order. Empty when the facts support done.
pub fn done_gaps(turn: &FactTurn) -> Vec<String> {
    let packages = workspace_or_empty(None);
    let (mut gaps, stale_pkgs) = gaps_before_coverage(turn, &packages);
    gaps.extend(without_stale_packages(coverage_gaps(turn), &stale_pkgs));
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

/// Review round 2 (PR #232): failing repros. Each test states what the gate should do.
#[cfg(test)]
mod review_r2 {
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

    // HIGH (r1 HIGH-2 still open): Claude's Edit tool records an absolute path. The repo's own cargo test, run with
    // `--manifest-path src-tauri/Cargo.toml` or after `cd src-tauri`, reaches that file, but the cargo root is only
    // compared with a relative path, so the module is "not reached" and the identical retry fails delivery.
    #[test]
    fn r2_the_repos_own_cargo_test_reaches_an_edited_module_at_its_absolute_path() {
        let edited = "/Users/ash/Worktrees/hub-x/src-tauri/src/firstmate/gates.rs";
        for command in [
            "cargo test --manifest-path src-tauri/Cargo.toml -p monocode --lib firstmate",
            "cargo test --manifest-path src-tauri/Cargo.toml",
            "cd src-tauri && cargo test -p monocode",
        ] {
            let gaps = done_gaps(&facts(
                vec![check(command, "passed", 2.0)],
                vec![edit(edited, 1.0)],
                "",
            ));
            assert!(gaps.is_empty(), "{command}: {gaps:?}");
        }
    }

    // HIGH (r1 HIGH-2 still open): this repo has a workspace Cargo.toml at its root, so `cargo test -p monocode` there
    // runs the src-tauri crate. `-p monocode` is compared with the folder name ("firstmate"), so it never reaches.
    #[test]
    fn r2_cargo_test_p_monocode_from_the_workspace_root_reaches_src_tauri() {
        for edited in [
            "src-tauri/src/firstmate/gates.rs",
            "/Users/ash/Worktrees/hub-x/src-tauri/src/firstmate/gates.rs",
        ] {
            let gaps = done_gaps(&facts(
                vec![check(
                    "cargo test -p monocode --lib firstmate",
                    "passed",
                    2.0,
                )],
                vec![edit(edited, 1.0)],
                "",
            ));
            assert!(gaps.is_empty(), "{edited}: {gaps:?}");
        }
    }

    // MED (r1 MED, general form): only a pipe is read as masking the runner's exit status. `;`, `||` and a second
    // line run after the test, so the command's status is theirs, and a failing suite reads as a pass.
    #[test]
    fn r2_a_test_whose_exit_status_is_masked_is_not_evidence_of_a_pass() {
        for masked in [
            "npm test || true",
            "npx vitest run; echo \"exit $?\"",
            "npm test; exit 0",
            "npm test\necho done",
        ] {
            let gaps = done_gaps(&facts(
                vec![check(masked, "passed", 2.0)],
                vec![edit("src/features/crew/row.ts", 1.0)],
                "All tests passed.",
            ));
            assert!(!gaps.is_empty(), "{masked:?} was taken as a pass");
        }
    }

    // MED: the r1 docs fix matches `docs` as any segment, so code in a folder named docs (this repo's own
    // src/features/docs) is docs: an edit after the last test never makes it stale and no test has to reach it.
    #[test]
    fn r2_code_in_a_folder_named_docs_is_still_code() {
        for path in [
            "src/features/docs/gateway.ts",
            "/Users/ash/Worktrees/hub-x/src/features/docs/gateway.ts",
        ] {
            let gaps = done_gaps(&facts(
                vec![check("npx vitest run", "passed", 1.0)],
                vec![edit(path, 2.0)],
                "",
            ));
            assert_eq!(gaps, vec![STALE.to_string()], "{path}");
        }
    }

    // MED: a runner that runs no test (compile only, a version or a listing) counts as a passing test run.
    #[test]
    fn r2_a_runner_that_runs_no_tests_is_not_a_test_run() {
        for fake in [
            "cargo test --no-run",
            "npx vitest --version",
            "npx jest --listTests",
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

    // LOW: keeping the latest 40 checks lets 40 quick type checks push a failing test out, so the failure is gone.
    #[test]
    fn r2_a_flood_of_later_checks_does_not_hide_a_failing_test() {
        let mut checks = vec![check("npm test", "failed", 2.0)];
        checks.extend((0..40).map(|i| check("npx tsc --noEmit", "passed", 3.0 + i as f64)));
        checks.push(check(
            "npx vitest run src/features/crew/other.test.ts",
            "passed",
            50.0,
        ));
        let gaps = done_gaps(&facts(
            checks,
            vec![edit("src/features/crew/row.ts", 1.0)],
            "",
        ));
        assert!(
            gaps.iter()
                .any(|gap| gap.starts_with("A check failed this turn")),
            "{gaps:?}"
        );
    }
}

/// The same rules as review_r2, for the cases a single example does not pin down.
#[cfg(test)]
mod whole_class {
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

    fn gaps_for(command: &str) -> Vec<String> {
        done_gaps(&FactTurn {
            checks: vec![check(command, "passed", 2.0)],
            edits: vec![edit("src/features/crew/row.ts", 1.0)],
            todos: vec![],
            answer: String::new(),
        })
    }

    #[test]
    fn a_pipe_with_pipefail_counts_as_a_pass() {
        for command in [
            "set -o pipefail && npm test | tail -20",
            "set -euo pipefail && npm test | tail -20",
        ] {
            assert!(gaps_for(command).is_empty(), "{command}");
        }
    }

    #[test]
    fn turning_pipefail_off_does_not_make_a_pipe_a_pass() {
        let gaps = gaps_for("set -o pipefail && set +o pipefail && npm test | tail -20");
        assert!(gaps.iter().any(|gap| gap == MASKED), "{gaps:?}");
    }

    #[test]
    fn a_test_joined_by_and_and_still_counts() {
        assert!(gaps_for("npm test && echo done").is_empty());
    }

    #[test]
    fn a_crlf_line_break_is_one_separator_and_masks_the_test() {
        let gaps = done_gaps(&FactTurn {
            checks: vec![check("npm test\r\necho done", "passed", 2.0)],
            edits: vec![edit("src/features/crew/row.ts", 1.0)],
            todos: vec![],
            answer: "All tests passed.".into(),
        });
        assert!(gaps.iter().any(|gap| gap == MASKED), "{gaps:?}");
    }

    #[test]
    fn check_scripts_reach_the_edited_package() {
        for command in [
            "npm run check:rust",
            "npm run check:web",
            "npm run check:scripts",
        ] {
            assert!(gaps_for(command).is_empty(), "{command}");
        }
    }

    #[test]
    fn native_check_is_not_a_test_run() {
        let gaps = done_gaps(&FactTurn {
            checks: vec![
                check("npx vitest run", "passed", 1.0),
                check("npm run native:check", "passed", 3.0),
            ],
            edits: vec![edit("src/features/crew/row.ts", 2.0)],
            todos: vec![],
            answer: String::new(),
        });
        assert_eq!(gaps, vec![STALE.to_string()], "{gaps:?}");
    }
}

/// A test covers a package only after that package's last edit. A later test of
/// another package does not clear stale.
#[cfg(test)]
mod review_leftovers {
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

    fn turn(checks: Vec<FactCheck>, edits: Vec<FactEdit>) -> FactTurn {
        FactTurn {
            checks,
            edits,
            todos: vec![],
            answer: String::new(),
        }
    }

    #[test]
    fn a_test_before_the_packages_last_edit_does_not_cover_it() {
        let early = coverage_gaps(&turn(
            vec![check("npm test", "passed", 1.0)],
            vec![edit("packages/web/src/app.ts", 2.0)],
        ));
        assert_eq!(early, vec!["No test reached web."]);
        let failed = coverage_gaps(&turn(
            vec![check("npm test", "failed", 1.0)],
            vec![edit("packages/web/src/app.ts", 2.0)],
        ));
        assert_eq!(failed, vec!["No test reached web."]);
        let not_the_last = coverage_gaps(&turn(
            vec![check("npm test", "passed", 2.0)],
            vec![
                edit("packages/web/src/app.ts", 1.0),
                edit("packages/web/src/later.ts", 3.0),
            ],
        ));
        assert_eq!(not_the_last, vec!["No test reached web."]);
        let after = coverage_gaps(&turn(
            vec![check("npm test", "passed", 4.0)],
            vec![
                edit("packages/web/src/app.ts", 1.0),
                edit("packages/web/src/later.ts", 3.0),
            ],
        ));
        assert!(after.is_empty());
        let stale = done_gaps(&turn(
            vec![check("npm test", "passed", 1.0)],
            vec![edit("packages/web/src/app.ts", 2.0)],
        ));
        assert_eq!(stale, vec![STALE.to_string()]);
        let failed_turn = done_gaps(&turn(
            vec![check("npm test", "failed", 1.0)],
            vec![edit("packages/web/src/app.ts", 2.0)],
        ));
        assert_eq!(
            failed_turn,
            vec![
                "A check failed this turn (npm test).".to_string(),
                "No test reached web.".to_string(),
            ]
        );
    }

    #[test]
    fn a_later_test_of_another_package_does_not_clear_stale() {
        let other = done_gaps(&turn(
            vec![
                check("npm test", "passed", 1.0),
                check(
                    "npx vitest run src/features/crew/row.test.ts",
                    "passed",
                    3.0,
                ),
            ],
            vec![edit("packages/web/src/app.ts", 2.0)],
        ));
        assert_eq!(other, vec![STALE.to_string()]);
        let named = done_gaps(&turn(
            vec![
                check("cargo test -p web", "passed", 1.0),
                check("cargo test -p crew", "failed", 3.0),
            ],
            vec![edit("crates/web/src/lib.rs", 2.0)],
        ));
        assert_eq!(
            named,
            vec![
                "A check failed this turn (cargo test -p crew).".to_string(),
                STALE.to_string(),
            ]
        );
        let one_of_two = done_gaps(&turn(
            vec![
                check("npm test", "passed", 1.0),
                check(
                    "npx vitest run src/features/crew/row.test.ts",
                    "passed",
                    4.0,
                ),
            ],
            vec![
                edit("packages/web/src/app.ts", 2.0),
                edit("src/features/crew/row.ts", 3.0),
            ],
        ));
        assert_eq!(one_of_two, vec![STALE.to_string()]);
        let same = done_gaps(&turn(
            vec![
                check("npm test", "passed", 1.0),
                check(
                    "npx vitest run src/features/crew/row.test.ts",
                    "passed",
                    3.0,
                ),
            ],
            vec![edit("src/features/crew/row.ts", 2.0)],
        ));
        assert!(same.is_empty(), "{same:?}");
        let docs = done_gaps(&turn(
            vec![check(
                "npx vitest run src/features/crew/row.test.ts",
                "passed",
                2.0,
            )],
            vec![
                edit("src/features/crew/row.ts", 1.0),
                edit("docs/guide.md", 3.0),
            ],
        ));
        assert!(docs.is_empty(), "{docs:?}");
        let bare = done_gaps(&turn(
            vec![check("npm test", "passed", 1.0)],
            vec![edit("row.ts", 2.0)],
        ));
        assert_eq!(bare, vec![STALE.to_string()]);
        let bare_cleared = done_gaps(&turn(
            vec![
                check("npm test", "passed", 1.0),
                check(
                    "npx vitest run src/features/crew/row.test.ts",
                    "passed",
                    3.0,
                ),
            ],
            vec![edit("row.ts", 2.0)],
        ));
        assert!(bare_cleared.is_empty(), "{bare_cleared:?}");
    }
}
