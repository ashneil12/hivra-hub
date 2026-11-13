//! Hivra WP-249: a worker's "done" is a set of claims, and the diff is the truth (docs/hivra/work/WP-249-blind-done-check.md).
//!
//! Before any model reads anything, code compares what the report claims with what the copy actually changed:
//!
//! - **False scope**: the report says only some files were touched, and the diff touches others.
//! - **Scope creep**: a file outside the scope the report or the brief declared, that neither of them names.
//! - **Weakened test**: a test file with fewer asserts than before, a test newly skipped (`#[ignore]` included), or an
//!   existing test whose assertions changed (a changed expected value) when the brief names neither the test nor the file.
//!   A Rust source's `#[cfg(test)]` blocks are test code too (`test_code`).
//! - **Debris**: a leftover file (`.orig`, `.rej`, `.log`, a scratch or debug file) or an added debug print
//!   (`console.log` outside scripts, a `DEBUG` print, `dbg!`, `debugger`, a breakpoint).
//! - **Outward action**: the report says it pushed, opened a pull request, posted, sent or deployed, and the brief holds
//!   no quoted instruction from Ash for it.
//!
//! Any of these refutes the claim on its own. Then the verdict model (WP-40's) reads the list of claims and the diff,
//! never the report's own story, and answers VERIFIED, VERIFIED WITH CAVEATS or REFUTED with a row per claim.
//!
//! The method (claims, the diff as ground truth, re-run or mark unverifiable, hunt the classic frauds, three verdicts)
//! is from fable-method's fable-judge (MIT, https://github.com/Sahir619/fable-method); the code and wording here are
//! Hivra's own. Its fake-work fixture is copied under `fixtures/fable-s7/` with its licence, as the acceptance test.
//! A claimed command is never run from the report's text: a "tests pass" claim is checked against the checks the app
//! itself ran (the `checks` gate), and is unverifiable when it ran none.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

pub mod test_code; // SC-3a: test code inside source files (`#[cfg(test)]`), and the tests in it

/// The most claims read from one report.
const MAX_CLAIMS: usize = 12;
/// The longest claim kept, in characters.
const CLAIM_MAX: usize = 300;
/// The most findings of one kind.
const MAX_PER_KIND: usize = 8;

/// One changed file: its text before the work (none: it is new) and after (none: it is gone). A file too large or not
/// text is held as an empty string, so it still counts as changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangedFile {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClaimKind {
    /// "Done", "fixed", "now handles X correctly".
    Done,
    /// "All tests pass", "checks are green".
    TestsPass,
    /// "Only X and Y were touched".
    OnlyTouched,
    /// "Pushed", "opened a pull request", "posted", "deployed".
    OutwardAction,
}

impl ClaimKind {
    fn word(self) -> &'static str {
        match self {
            ClaimKind::Done => "done",
            ClaimKind::TestsPass => "tests pass",
            ClaimKind::OnlyTouched => "only touched",
            ClaimKind::OutwardAction => "outward action",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub kind: ClaimKind,
    pub text: String,
    /// For `OnlyTouched`: the files it names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum FindingKind {
    FalseScope,
    ScopeCreep,
    WeakenedTest,
    Debris,
    OutwardAction,
    /// SC-4: a changed path on the brief's do-not-touch list.
    DoNotTouch,
}

impl FindingKind {
    pub fn name(self) -> &'static str {
        match self {
            FindingKind::DoNotTouch => "Off-limits change",
            FindingKind::FalseScope => "False scope claim",
            FindingKind::ScopeCreep => "Scope creep",
            FindingKind::WeakenedTest => "Weakened test",
            FindingKind::Debris => "Debris",
            FindingKind::OutwardAction => "Outward action without Ash's word",
        }
    }
}

/// Something the code found in the diff that the report's claims do not survive.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeFinding {
    pub kind: FindingKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub detail: String,
}

impl CodeFinding {
    pub fn line(&self) -> String {
        format!("{}: {}", self.kind.name(), self.detail)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClaimStatus {
    Verified,
    Refuted,
    Unverifiable,
}

impl ClaimStatus {
    pub fn word(self) -> &'static str {
        match self {
            ClaimStatus::Verified => "verified",
            ClaimStatus::Refuted => "refuted",
            ClaimStatus::Unverifiable => "unverifiable",
        }
    }

    pub fn parse(word: &str) -> Option<ClaimStatus> {
        match word.trim().to_ascii_lowercase().as_str() {
            "verified" => Some(ClaimStatus::Verified),
            "refuted" => Some(ClaimStatus::Refuted),
            "unverifiable" => Some(ClaimStatus::Unverifiable),
            _ => None,
        }
    }
}

/// One row of the claims table: what was claimed and what was observed.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRow {
    pub claim: String,
    pub observed: String,
    pub status: ClaimStatus,
}

/// What the app's own checks said, for a "tests pass" claim. None: the app ran no checks it can compare.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChecksRun {
    Passed,
    Failed,
    None,
}

fn regex(cell: &'static OnceLock<Regex>, source: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(source).expect("a WP-249 pattern compiles"))
}

fn tests_pass_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r"(?i)\b(?:tests?|checks?|specs?|suites?|build|ci)\b[^.;\n]{0,40}\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|ok)\b",
    )
}

fn only_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r"(?i)\bonly\b[^;\n]*\b(?:touch|chang|modif|edit)\w*|\b(?:touch|chang|modif|edit)\w*\b[^;\n]*\bonly\b|\bnothing else\b",
    )
}

fn done_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r"(?i)^\s*(?:done|fixed|finished|complete[d]?)\b|\b(?:is|are|now|was|were|has been|have been)\s+(?:fixed|done|complete[d]?|implemented|resolved|working)\b|\b(?:i|we)\s+(?:fixed|implemented|resolved|added|completed|finished)\b|\bnow\s+\w+\b[^;\n]*\bcorrectly\b",
    )
}

fn outward_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r"(?i)\b(?:pushed|force-pushed|opened (?:a |the )?(?:pr|pull request)|created (?:a |the )?(?:pr|pull request)|deployed|published|released|posted|emailed|sent (?:an? |the )?(?:email|message|slack|reply|invite))\b",
    )
}

fn file_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r"[A-Za-z0-9_@~-][A-Za-z0-9_./@~-]*\.[A-Za-z0-9]{1,8}\b|[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]*",
    )
}

/// The report's sentences: split on line ends and on `. `, `! `, `? ` and `; `.
fn sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut current = String::new();
        let chars: Vec<char> = line.chars().collect();
        for (index, ch) in chars.iter().enumerate() {
            current.push(*ch);
            let next_is_space = chars.get(index + 1).is_none_or(|next| next.is_whitespace());
            if matches!(ch, '.' | '!' | '?' | ';') && next_is_space {
                push_sentence(&mut out, &current);
                current.clear();
            }
        }
        push_sentence(&mut out, &current);
    }
    out
}

fn push_sentence(out: &mut Vec<String>, text: &str) {
    let text = text
        .trim()
        .trim_start_matches(['-', '*', '>', ' '])
        .trim()
        .trim_end_matches(';')
        .trim();
    if !text.is_empty() {
        out.push(text.chars().take(CLAIM_MAX).collect());
    }
}

/// File names a sentence names. A link is not a file.
fn file_tokens(sentence: &str) -> Vec<String> {
    file_token_re()
        .find_iter(sentence)
        .map(|found| found.as_str().trim_end_matches(['.', ',', ')']).to_string())
        .filter(|token| !token.contains("://") && !token.starts_with("http"))
        .filter(|token| {
            token.contains('/')
                || token
                    .rsplit('.')
                    .next()
                    .is_some_and(|ext| ext.chars().any(|c| c.is_ascii_alphabetic()))
        })
        .collect()
}

/// The checkable claims in a report, in order. A sentence that claims nothing checkable (an excuse, a story about
/// what the bug "turned out to be") is left out: the model reads claims, not the report's case for itself.
pub fn claims_of(report: &str) -> Vec<Claim> {
    let mut out: Vec<Claim> = Vec::new();
    for sentence in sentences(report) {
        let kind = if only_re().is_match(&sentence) && !file_tokens(&sentence).is_empty() {
            ClaimKind::OnlyTouched
        } else if outward_re().is_match(&sentence) {
            ClaimKind::OutwardAction
        } else if tests_pass_re().is_match(&sentence) {
            ClaimKind::TestsPass
        } else if done_re().is_match(&sentence) {
            ClaimKind::Done
        } else {
            continue;
        };
        let files = if kind == ClaimKind::OnlyTouched {
            file_tokens(&sentence)
        } else {
            Vec::new()
        };
        if out.iter().any(|claim| claim.text == sentence) {
            continue;
        }
        out.push(Claim {
            kind,
            text: sentence,
            files,
        });
        if out.len() == MAX_CLAIMS {
            break;
        }
    }
    out
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Whether a name from a claim or the brief means this changed path: the same path, its tail, or its file name.
fn names_path(name: &str, path: &str) -> bool {
    let name = name.trim().trim_start_matches("./");
    !name.is_empty()
        && (name == path || path.ends_with(&format!("/{name}")) || basename(path) == basename(name))
}

pub(crate) fn mentions(text: &str, path: &str) -> bool {
    file_tokens(text)
        .iter()
        .any(|token| names_path(token, path))
        || text.contains(path)
}

/// Whether the brief names a test: its name as a whole word (a fn name, or the title of an `it("...")`), so `adds`
/// does not match `addsup`.
fn names_test(brief: &str, name: &str) -> bool {
    if name.trim().is_empty() {
        return false;
    }
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(at) = brief[from..].find(name) {
        let (start, end) = (from + at, from + at + name.len());
        let before_ok = !brief[..start].chars().next_back().is_some_and(word);
        let after_ok = !brief[end..].chars().next().is_some_and(word);
        if before_ok && after_ok {
            return true;
        }
        from = start + brief[start..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// A test file by its name: `test_x.py`, `x_test.go`, `x.test.ts`, `x.spec.js`, a `tests/` folder, Rust `tests.rs`.
pub fn is_test_path(path: &str) -> bool {
    let name = basename(path).to_ascii_lowercase();
    let lower = path.to_ascii_lowercase();
    name.starts_with("test_")
        || name.contains("_test.")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name == "tests.rs"
        || name.ends_with("_tests.rs")
        || lower.starts_with("tests/")
        || lower.contains("/tests/")
        || lower.starts_with("test/")
        || lower.contains("/test/")
        || lower.contains("__tests__/")
}

const ASSERT_MARKS: &[&str] = &[
    "assert",
    "expect(",
    "expect!(",
    "XCTAssert",
    ".should",
    "require.",
    "t.Error",
    "t.Fatal",
];

fn is_assert_line(line: &str) -> bool {
    let line = line.trim_start();
    !line.starts_with("//")
        && !line.starts_with('#')
        && ASSERT_MARKS.iter().any(|mark| line.contains(mark))
}

const SKIP_MARKS: &[&str] = &[
    "@pytest.mark.skip",
    "@unittest.skip",
    "pytest.skip(",
    "it.skip(",
    "test.skip(",
    "describe.skip(",
    "xit(",
    "xdescribe(",
    "it.todo(",
    "test.todo(",
    "#[ignore",
    "t.Skip(",
    "@Disabled",
    "@Ignore",
];

fn count_lines(text: &str, keep: impl Fn(&str) -> bool) -> usize {
    text.lines().filter(|line| keep(line)).count()
}

fn skip_count(text: &str) -> usize {
    count_lines(text, |line| {
        SKIP_MARKS.iter().any(|mark| line.contains(mark))
    })
}

/// The lines `after` has more of than `before` (a multiset difference, so moving a line adds nothing).
fn added_lines<'a>(before: &str, after: &'a str) -> Vec<&'a str> {
    let mut have: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for line in before.lines() {
        *have.entry(line).or_default() += 1;
    }
    let mut out = Vec::new();
    for line in after.lines() {
        match have.get_mut(line) {
            Some(count) if *count > 0 => *count -= 1,
            _ => out.push(line),
        }
    }
    out
}

const DEBRIS_ENDINGS: &[&str] = &[".orig", ".rej", ".bak", ".swp", ".swo", ".tmp", ".log", "~"];

fn debris_file(path: &str) -> bool {
    let name = basename(path).to_ascii_lowercase();
    DEBRIS_ENDINGS.iter().any(|end| name.ends_with(end))
        || name.contains("scratch")
        || name.starts_with("debug_")
        || name.starts_with("debug.")
        || name.starts_with("tmp_")
        || name.starts_with("temp_")
        || name == ".ds_store"
}

/// A folder whose files are command-line scripts, where printing is the job.
fn is_script_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    ["scripts/", "bin/", "cli/", "tools/"]
        .iter()
        .any(|folder| lower.starts_with(folder) || lower.contains(&format!("/{folder}")))
}

const PRINT_CALLS: &[&str] = &[
    "print(",
    "println!(",
    "eprintln!(",
    "console.",
    "fmt.Print",
    "System.out.print",
    "puts ",
    "echo ",
    "printf(",
];

/// A debug line an edit added, in plain words, or none.
fn debug_line(path: &str, line: &str) -> Option<&'static str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("//") || trimmed.starts_with('#') && !trimmed.starts_with("#[") {
        return None;
    }
    if trimmed.contains("dbg!(") {
        return Some("a dbg! call");
    }
    if trimmed.starts_with("debugger") {
        return Some("a debugger statement");
    }
    if trimmed.contains("breakpoint()")
        || trimmed.contains("pdb.set_trace")
        || trimmed.contains("binding.pry")
    {
        return Some("a breakpoint");
    }
    let prints = PRINT_CALLS.iter().any(|call| trimmed.contains(call));
    if prints && trimmed.contains("DEBUG") {
        return Some("a DEBUG print");
    }
    if trimmed.contains("console.log(") && !is_script_path(path) && !is_test_path(path) {
        return Some("a console.log");
    }
    None
}

fn list_names(paths: &[&str]) -> String {
    match paths {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The scope a text declares with "only": the files it names, or none when it declares none.
fn declared_scope(text: &str) -> Option<Vec<String>> {
    let named: Vec<String> = sentences(text)
        .into_iter()
        .filter(|sentence| only_re().is_match(sentence))
        .flat_map(|sentence| file_tokens(&sentence))
        .collect();
    (!named.is_empty()).then_some(named)
}

/// Quoted words from Ash in a brief: a quoted span, or a line that names Ash. An action counts as his only when one of
/// these names it.
fn owner_words(brief: &str) -> Vec<String> {
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    let quoted = regex(&QUOTED, r#""[^"\n]{3,}"|“[^”\n]{3,}”|'[^'\n]{8,}'"#);
    let mut out: Vec<String> = quoted
        .find_iter(brief)
        .map(|found| found.as_str().to_string())
        .collect();
    for line in brief.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('>') || line.contains("Ash") {
            out.push(line.to_string());
        }
    }
    out
}

/// The words of each kind of outward action (a push, a pull request, a release, a message). Each group is one kind: a
/// claim is covered only when Ash's quoted words name every kind it claims.
const ACTION_STEMS: &[&[&str]] = &[
    &["push ", "push.", "push,", "pushed", "pushing"],
    &["pull request", " pr ", " pr.", " pr,", "pr #"],
    &["deploy", "release", "publish"],
    &["post", "send", "email", "slack", "reply"],
];

fn action_stems(sentence: &str) -> Vec<&'static [&'static str]> {
    let lower = format!(" {} ", sentence.to_ascii_lowercase());
    ACTION_STEMS
        .iter()
        .copied()
        .filter(|stems| stems.iter().any(|stem| lower.contains(stem)))
        .collect()
}

/// SC-4: a changed path under one of the brief's do-not-touch entries is a finding of its own, one per path, whatever
/// the report or the brief's text says about it (a brief that names the file in its spec doesn't make it fair game).
/// An entry names a file, a folder (everything under it) or a pattern; case and separators are not a way round it.
pub fn leave_findings(leave: &[String], files: &[ChangedFile]) -> Vec<CodeFinding> {
    files
        .iter()
        .filter(|file| {
            leave
                .iter()
                .any(|entry| super::brief_checks::under(entry, &file.path))
        })
        .map(|file| CodeFinding {
            kind: FindingKind::DoNotTouch,
            file: Some(file.path.clone()),
            detail: format!("{} is on the brief's do-not-touch list.", file.path),
        })
        .take(MAX_PER_KIND)
        .collect()
}

/// The code's own findings, before any model: the report's claims against the diff.
pub fn code_findings(
    brief: &str,
    report: &str,
    claims: &[Claim],
    files: &[ChangedFile],
) -> Vec<CodeFinding> {
    let mut out: Vec<CodeFinding> = Vec::new();
    let changed: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    let debris: BTreeSet<&str> = files
        .iter()
        .filter(|file| file.before.is_none() && file.after.is_some() && debris_file(&file.path))
        .map(|file| file.path.as_str())
        .collect();

    // False scope: "only X and Y were touched" against the diff's file list.
    let mut claimed_scope: Vec<String> = Vec::new();
    for claim in claims
        .iter()
        .filter(|claim| claim.kind == ClaimKind::OnlyTouched)
    {
        claimed_scope.extend(claim.files.iter().cloned());
        let extra: Vec<&str> = changed
            .iter()
            .copied()
            .filter(|path| !claim.files.iter().any(|name| names_path(name, path)))
            .collect();
        if !extra.is_empty() {
            out.push(CodeFinding {
                kind: FindingKind::FalseScope,
                file: None,
                detail: format!(
                    "the report says only {} changed, but the diff also changes {}.",
                    list_names(&claim.files.iter().map(String::as_str).collect::<Vec<_>>()),
                    list_names(&extra)
                ),
            });
        }
    }

    // Scope creep: outside the declared scope (the report's, else the brief's), and named by neither.
    let scope = if claimed_scope.is_empty() {
        declared_scope(brief)
    } else {
        Some(claimed_scope)
    };
    if let Some(scope) = scope {
        for path in &changed {
            if debris.contains(path)
                || scope.iter().any(|name| names_path(name, path))
                || mentions(brief, path)
                || mentions(report, path)
            {
                continue;
            }
            out.push(CodeFinding {
                kind: FindingKind::ScopeCreep,
                file: Some(path.to_string()),
                detail: format!("{path} changed, but neither the brief nor the report names it."),
            });
        }
    }

    // Weakened tests: fewer asserts than before, a test newly skipped (`#[ignore]` included), or an existing test whose
    // assertions changed without the brief naming it. SC-3a: a Rust source file's `#[cfg(test)]` blocks are test code,
    // and so is a file another source declares as its tests (`#[cfg(test)] #[path = "x.rs"] mod tests;`).
    let mut declared: BTreeSet<String> = BTreeSet::new();
    for file in files.iter().filter(|file| file.path.ends_with(".rs")) {
        for text in [file.before.as_deref(), file.after.as_deref()]
            .into_iter()
            .flatten()
        {
            declared.extend(test_code::declared_test_files(&file.path, text));
        }
    }
    let is_test_file =
        |path: &str| is_test_path(path) || declared.contains(&path.replace('\\', "/"));
    // The asserts in test files this change adds. Tests moved out of a source file's block land in them.
    let new_test_asserts: usize = files
        .iter()
        .filter(|file| file.before.is_none() && is_test_file(&file.path))
        .filter_map(|file| file.after.as_deref())
        .map(|text| count_lines(text, is_assert_line))
        .sum();
    for file in files {
        let whole = is_test_file(&file.path);
        if !whole && !file.path.ends_with(".rs") {
            continue;
        }
        let Some(before_text) = file.before.as_deref() else {
            continue;
        };
        let (before, after) = if whole {
            (
                before_text.to_string(),
                file.after.clone().unwrap_or_default(),
            )
        } else {
            // A source file deleted with its tests is the code going, not a test being weakened.
            let Some(after_text) = file.after.as_deref() else {
                continue;
            };
            let blocks = test_code::rust_test_blocks(before_text);
            // No test block before: nothing to weaken.
            if blocks.is_empty() {
                continue;
            }
            (blocks, test_code::rust_test_blocks(after_text))
        };
        let (was, now) = (
            count_lines(&before, is_assert_line),
            count_lines(&after, is_assert_line),
        );
        let moved = if whole { 0 } else { new_test_asserts };
        if file.after.is_none() && was > 0 {
            out.push(CodeFinding {
                kind: FindingKind::WeakenedTest,
                file: Some(file.path.clone()),
                detail: format!("{} was deleted with its {was} asserts.", file.path),
            });
        } else if now < was && was - now > moved {
            out.push(CodeFinding {
                kind: FindingKind::WeakenedTest,
                file: Some(file.path.clone()),
                detail: format!("{} has {now} asserts where it had {was}.", file.path),
            });
        }
        if skip_count(&after) > skip_count(&before) {
            out.push(CodeFinding {
                kind: FindingKind::WeakenedTest,
                file: Some(file.path.clone()),
                detail: format!("{} skips a test it ran before.", file.path),
            });
        }
        // An existing test now asserts something else. Fine when the brief names the test or the file.
        for name in test_code::changed_assertions(&file.path, &before, &after) {
            if mentions(brief, &file.path) || names_test(brief, &name) {
                continue;
            }
            out.push(CodeFinding {
                kind: FindingKind::WeakenedTest,
                file: Some(file.path.clone()),
                detail: format!(
                    "{}: the test {name} changed what it checks; the brief does not name it.",
                    file.path
                ),
            });
        }
    }

    // Debris: a leftover file, or a debug line an edit added.
    for path in &debris {
        out.push(CodeFinding {
            kind: FindingKind::Debris,
            file: Some(path.to_string()),
            detail: format!("{path} is a new scratch, backup or log file."),
        });
    }
    for file in files {
        let Some(after) = file.after.as_deref() else {
            continue;
        };
        if debris.contains(file.path.as_str()) {
            continue;
        }
        let before = file.before.as_deref().unwrap_or("");
        let mut seen = BTreeSet::new();
        for line in added_lines(before, after) {
            if let Some(what) = debug_line(&file.path, line) {
                if seen.insert(what) {
                    out.push(CodeFinding {
                        kind: FindingKind::Debris,
                        file: Some(file.path.clone()),
                        detail: format!("{} adds {what}.", file.path),
                    });
                }
            }
        }
    }

    // Outward actions: claimed, with no quoted word from Ash in the brief that names them.
    let words: Vec<String> = owner_words(brief)
        .into_iter()
        .map(|text| format!(" {} ", text.to_ascii_lowercase()))
        .collect();
    for claim in claims
        .iter()
        .filter(|claim| claim.kind == ClaimKind::OutwardAction)
    {
        let stems = action_stems(&claim.text);
        let covered = !stems.is_empty()
            && stems.iter().all(|stems| {
                words
                    .iter()
                    .any(|said| stems.iter().any(|stem| said.contains(stem)))
            });
        if !covered {
            out.push(CodeFinding {
                kind: FindingKind::OutwardAction,
                file: None,
                detail: format!(
                    "the report says \"{}\", and the brief quotes no word from Ash asking for it.",
                    claim.text.chars().take(120).collect::<String>()
                ),
            });
        }
    }

    // Keep the list short enough to read: at most a few of each kind.
    let mut kept: Vec<CodeFinding> = Vec::new();
    for finding in out {
        if kept.iter().filter(|have| have.kind == finding.kind).count() < MAX_PER_KIND
            && !kept.contains(&finding)
        {
            kept.push(finding);
        }
    }
    kept
}

/// The code's row for each claim. A claim code cannot settle is left for the model, marked unverifiable here.
pub fn code_rows(claims: &[Claim], findings: &[CodeFinding], checks: ChecksRun) -> Vec<ClaimRow> {
    claims
        .iter()
        .map(|claim| {
            let (observed, status) = match claim.kind {
                ClaimKind::OnlyTouched => match findings
                    .iter()
                    .find(|finding| finding.kind == FindingKind::FalseScope)
                {
                    Some(finding) => (finding.detail.clone(), ClaimStatus::Refuted),
                    None => (
                        "the diff changes only the files it names".to_string(),
                        ClaimStatus::Verified,
                    ),
                },
                ClaimKind::TestsPass => match checks {
                    ChecksRun::Passed => (
                        "the app ran the project's checks itself: they passed".to_string(),
                        ClaimStatus::Verified,
                    ),
                    ChecksRun::Failed => (
                        "the app ran the project's checks itself: they failed".to_string(),
                        ClaimStatus::Refuted,
                    ),
                    ChecksRun::None => (
                        "the app ran no checks it could compare, and never runs a command from a report".to_string(),
                        ClaimStatus::Unverifiable,
                    ),
                },
                ClaimKind::OutwardAction => match findings
                    .iter()
                    .find(|finding| finding.kind == FindingKind::OutwardAction)
                {
                    Some(_) => (
                        "the brief quotes no word from Ash asking for it".to_string(),
                        ClaimStatus::Refuted,
                    ),
                    None => (
                        "the brief quotes Ash asking for it; the action itself is not visible in the diff".to_string(),
                        ClaimStatus::Unverifiable,
                    ),
                },
                ClaimKind::Done => (
                    "for the check model to judge against the diff".to_string(),
                    ClaimStatus::Unverifiable,
                ),
            };
            ClaimRow {
                claim: claim.text.clone(),
                observed,
                status,
            }
        })
        .collect()
}

/// The claims as the verdict model reads them: numbered, typed, with nothing else from the report.
pub fn claims_text(claims: &[Claim]) -> String {
    if claims.is_empty() {
        return "(the report makes no checkable claim; judge the diff against the definition of done)".into();
    }
    claims
        .iter()
        .enumerate()
        .map(|(index, claim)| format!("{}. [{}] {}", index + 1, claim.kind.word(), claim.text))
        .collect::<Vec<_>>()
        .join("\n")
}

/// What the code found, for the model and the summary.
pub fn findings_text(findings: &[CodeFinding]) -> String {
    if findings.is_empty() {
        return "- none".into();
    }
    findings
        .iter()
        .map(|finding| format!("- {}", finding.line()))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
#[path = "done_check_tests.rs"]
mod tests;
