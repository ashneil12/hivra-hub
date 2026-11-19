//! PT-5: a worker's request to quarantine a red test, in `light` and `full` (in `at-ship` a red test that is not the worker's goes on the
//! test list by itself, and the worker asks for nothing).
//!
//! The worker writes one line in its report: `Quarantine: <test> | <why>`, naming a test its own runs show failing, the way the run printed it
//! (the full id, the name, or `file > name`). The app decides, never the worker:
//!
//! - the test must be one of the failing tests the worker's runs show, and exactly one of them;
//! - not one the task's own change covers (`own`): that one is the worker's to fix;
//! - not a critical test. A test is critical when
//!   1. its file sits under a sensitive path (`firstmate::sensitive`: keys, permissions, the sandbox, billing, migrations, CI,
//!      installers, the project's protected paths and its `docs/hivra/sensitive-paths.json`), or
//!   2. its name or title carries `@critical` (`it("@critical: charges the card", ...)`), or
//!   3. a marker is attached to the line that declares it: `// @critical`, `# @critical`, `/* @critical */`, or the Rust attribute
//!      `#[doc = "critical"]`, directly above it (other comment and attribute lines, and the lines of a call that goes on over
//!      several, may sit between; a blank line or the end of the statement before ends it).
//! - a test whose file can't be told or read, or whose declaration can't be found in it (a generated title, a name too short to look
//!   for), is not known to be anything else, so it is refused too.
//!
//! What the app can't enforce (that the worker made no more than two attempts, or that the test is really flaky) is the brief's to say.
//! A request that is refused, or that names no failing test, is put to the worker as a gap in its round, so it knows; one that is
//! accepted is quarantined for 14 days (`Doc::quarantine_test`) and named, with its end date, by every ship check in `at-ship`.

use std::sync::OnceLock;

use regex::Regex;

use super::divert::Plan;
use super::own::Failing;
use crate::firstmate::sensitive;

/// The most requests read from one report.
pub const REQUESTS_MAX: usize = 10;
const TEST_MAX: usize = 400;
const WHY_MAX: usize = 300;
/// How many comment and attribute lines above a test's line are read for a marker.
const MARKER_LINES: usize = 6;

/// One `Quarantine: <test> | <why>` line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub test: String,
    pub why: String,
}

/// What a report asked for.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Requests {
    pub list: Vec<Request>,
    /// Lines past `REQUESTS_MAX`, not read.
    pub dropped: usize,
}

fn line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?im)^[ \t]*(?:[-+*][ \t]+)?[*_`]{0,2}quarantine[*_`]{0,2}[ \t]*:[ \t]*[*_`]{0,2}[ \t]*(\S.*)$",
        )
        .expect("a quarantine line pattern")
    })
}

fn flat(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The quarantine lines of a report, in order, each test once. Case and markdown emphasis don't matter; neither does a bullet. The
/// brief's own example (`Quarantine: <test> | <why>`) quoted back is not a request.
pub fn parse_requests(report: &str) -> Requests {
    let mut out = Requests::default();
    for caps in line_re().captures_iter(report) {
        let rest = caps[1].trim();
        let (test, why) = match rest.find(" | ") {
            Some(at) => (&rest[..at], &rest[at + 3..]),
            None => (rest, ""),
        };
        let test = cut(flat(test).trim_matches(['`', '*']).trim(), TEST_MAX);
        let why = cut(flat(why).trim_matches(['`', '*']).trim(), WHY_MAX);
        if test.is_empty() || (test.starts_with('<') && test.ends_with('>')) {
            continue;
        }
        if out.list.iter().any(|have| have.test == test) {
            continue;
        }
        if out.list.len() >= REQUESTS_MAX {
            out.dropped += 1;
            continue;
        }
        out.list.push(Request { test, why });
    }
    out
}

/// The failing tests a request could mean: its full id, its name as the run printed it (vitest prints the file first: `src/a.test.ts >
/// suite > works`), that name without its file, or `file > name` / `file::name`.
fn resolve<'a>(test: &str, candidates: &[&'a Failing]) -> Vec<&'a Failing> {
    let want = flat(test);
    let mut hits: Vec<&Failing> = Vec::new();
    for failing in candidates {
        let file = failing.file.replace('\\', "/");
        let bare = failing
            .name
            .strip_prefix(&format!("{file} > "))
            .unwrap_or(&failing.name);
        let forms = [
            flat(&failing.id()),
            flat(&failing.name),
            flat(bare),
            flat(&format!("{file} > {bare}")),
            flat(&format!("{file}::{bare}")),
        ];
        if forms.contains(&want) && !hits.iter().any(|have| have.id() == failing.id()) {
            hits.push(failing);
        }
    }
    hits
}

// ---- critical ------------------------------------------------------------------------------------------------------------------

/// Whether `text` carries the tag `@critical` (any case) as a word: `@criticality` and `@critical_path` are other words.
fn has_tag(text: &str) -> bool {
    const TAG: &str = "@critical";
    let lower = text.to_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find(TAG) {
        let end = from + at + TAG.len();
        let next = lower[end..].chars().next();
        if next.is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '-')) {
            return true;
        }
        from = end;
    }
    false
}

/// A marker line: a comment that says `@critical`, or the Rust attribute `#[doc = "critical"]`.
fn is_marker_line(line: &str) -> bool {
    let trimmed = line.trim();
    let compact: String = trimmed
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    if compact == "#[doc=\"critical\"]" {
        return true;
    }
    let comment = ["//", "#", "/*", "*", "--", ";", "<!--"]
        .iter()
        .any(|lead| trimmed.starts_with(lead));
    comment && has_tag(trimmed)
}

/// The last part of a test's name: what its source line is written with. A pytest parameter list (`test_refund[usd]`) is not in the
/// source, so it is cut.
fn leaf(name: &str) -> String {
    let mut leaf = name;
    for sep in [" > ", " \u{203a} ", "::"] {
        if let Some(at) = leaf.rfind(sep) {
            leaf = &leaf[at + sep.len()..];
        }
    }
    let leaf = leaf.trim();
    match leaf.find('[') {
        Some(at) if at >= 2 => leaf[..at].trim().to_string(),
        _ => leaf.to_string(),
    }
}

/// A line that is part of what is written above a declaration: a comment, or an attribute or decorator (`#[test]`, `@pytest.mark.slow`).
/// A blank line or code is not, so a marker belongs to the test right under it and not to the ones after.
fn is_attached(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty()
        && ["//", "#", "/*", "*", "--", ";", "<!--", "@"]
            .iter()
            .any(|lead| trimmed.starts_with(lead))
}

enum Marked {
    Yes,
    No,
    /// No line of the source names the test (a generated title, a name that is too short to look for): it can't be checked.
    NotFound,
}

/// Whether a marker is attached to a line of `source` that names the test. Walking up from that line, through at most `MARKER_LINES`
/// lines, a marker (`is_marker_line`) is found before a blank line or the end of the statement before it (`;`, `}` or `{`); comment and
/// attribute lines, and the lines of a call that goes on over several (`it(`, the title on the next line), are walked through. Any line
/// that names the test counts (a test mentioned twice is critical if either is marked, the stricter reading), but a comment that
/// mentions it does not.
fn marked_above(source: &str, name: &str) -> Marked {
    let leaf = leaf(name);
    if leaf.chars().count() < 2 {
        return Marked::NotFound;
    }
    let lines: Vec<&str> = source.lines().collect();
    let mut found = false;
    for (at, line) in lines.iter().enumerate() {
        if !line.contains(&leaf) || is_attached(line) {
            continue;
        }
        found = true;
        for above in lines[..at].iter().rev().take(MARKER_LINES) {
            if is_marker_line(above) {
                return Marked::Yes;
            }
            let trimmed = above.trim();
            if is_attached(above) {
                continue;
            }
            if trimmed.is_empty()
                || trimmed.ends_with(';')
                || trimmed.ends_with('}')
                || trimmed.ends_with('{')
            {
                break;
            }
        }
    }
    if found {
        Marked::No
    } else {
        Marked::NotFound
    }
}

const BY_PATH: &str = "it sits under a sensitive path";
const BY_NAME: &str = "its name says @critical";
const BY_MARKER: &str = "a marker above it says critical";
const UNKNOWN_FILE: &str = "its file can't be told, so it can't be checked";
const UNREADABLE: &str = "its file can't be read, so it can't be checked";
const NOT_FOUND: &str = "it can't be found in its file, so it can't be checked";

/// Why a test is critical, or `None` when nothing says it is. `patterns` are the project's sensitive patterns
/// (`sensitive::patterns_for`); `read_file` reads a tracked file's text.
pub fn critical_reason(
    file: &str,
    name: &str,
    patterns: &[String],
    read_file: &dyn Fn(&str) -> Option<String>,
) -> Option<&'static str> {
    if has_tag(name) {
        return Some(BY_NAME);
    }
    if file.trim().is_empty() {
        return Some(UNKNOWN_FILE);
    }
    if !sensitive::sensitive_hit(&[file.to_string()], patterns).is_empty() {
        return Some(BY_PATH);
    }
    match read_file(file) {
        Some(source) => match marked_above(&source, name) {
            Marked::Yes => Some(BY_MARKER),
            Marked::No => None,
            Marked::NotFound => Some(NOT_FOUND),
        },
        None => Some(UNREADABLE),
    }
}

// ---- the decision ----------------------------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Quarantine it for 14 days.
    Quarantine(Box<Failing>),
    /// Already quarantined: nothing to do.
    Already,
    /// Not applied, with the sentence the worker is told.
    Refused(String),
}

fn shown(name: &str) -> String {
    cut(&flat(name), 80)
}

/// What to do with one request, from what the worker's runs show failing (`plan` is `divert::plan_quarantine_only` over them).
/// `repo_path` turns the file a runner printed (Playwright prints it relative to its test folder) into the repository path the sensitive
/// patterns are matched against.
pub fn decide(
    request: &Request,
    plan: &Plan,
    patterns: &[String],
    repo_path: &dyn Fn(&str) -> String,
    read_file: &dyn Fn(&str) -> Option<String>,
) -> Verdict {
    let all: Vec<&Failing> = plan
        .own
        .iter()
        .chain(plan.foreign.iter())
        .chain(plan.quarantined.iter())
        .collect();
    let hits = resolve(&request.test, &all);
    let [failing] = hits.as_slice() else {
        let why = if hits.is_empty() {
            "is not one of the failing tests your runs show. Use its name as the test run printed it."
        } else {
            "could mean more than one failing test. Use its full name."
        };
        return Verdict::Refused(format!(
            "Quarantine not applied: {} {why}",
            shown(&request.test)
        ));
    };
    let id = failing.id();
    if plan.own.iter().any(|own| own.id() == id) {
        return Verdict::Refused(format!(
            "Quarantine refused: {} is a test your change covers, so it is yours to fix.",
            shown(&failing.name)
        ));
    }
    let file = repo_path(&failing.file);
    if let Some(why) = critical_reason(&file, &failing.name, patterns, read_file) {
        return Verdict::Refused(format!(
            "Quarantine refused: {} is a critical test ({why}). A critical test is read-only for a worker: ask your first mate.",
            shown(&failing.name)
        ));
    }
    if plan.quarantined.iter().any(|have| have.id() == id) {
        return Verdict::Already;
    }
    Verdict::Quarantine(Box::new((*failing).clone()))
}

/// The sentence for lines past the cap.
pub fn dropped_sentence(dropped: usize) -> String {
    format!(
        "Quarantine not applied: only the first {REQUESTS_MAX} quarantine lines are read, and {dropped} more came after them."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failing(file: &str, name: &str) -> Failing {
        Failing {
            runner: "vitest".into(),
            file: file.into(),
            name: name.into(),
            message: String::new(),
            command: "npx vitest run".into(),
        }
    }

    fn plan_of(own: &[Failing], foreign: &[Failing], quarantined: &[Failing]) -> Plan {
        Plan {
            own: own.to_vec(),
            foreign: foreign.to_vec(),
            quarantined: quarantined.to_vec(),
            ..Plan::default()
        }
    }

    fn no_files(_: &str) -> Option<String> {
        None
    }

    fn patterns() -> Vec<String> {
        sensitive::built_in_patterns()
    }

    fn plain(_: &str) -> Option<String> {
        Some("it(\"works\", () => {});\n".into())
    }

    /// A source with one `it(...)` line for the last part of each name, so the declarations can be found.
    fn source_with(names: &[&str]) -> String {
        names
            .iter()
            .map(|name| format!("it(\"{}\", () => {{}});\n", leaf(name)))
            .collect()
    }

    /// `decide` with the file a runner printed taken as the repository path (what most runners print).
    fn decide(
        request: &Request,
        plan: &Plan,
        patterns: &[String],
        read_file: &dyn Fn(&str) -> Option<String>,
    ) -> Verdict {
        super::decide(request, plan, patterns, &|file| file.to_string(), read_file)
    }

    // ---- the line -------------------------------------------------------------------------------------------------------------

    #[test]
    fn a_quarantine_line_names_a_test_and_why() {
        let got = parse_requests(
            "Done.\n\nQuarantine: src/other.test.ts > suite > works | flaky, passes on a re-run\n",
        );
        assert_eq!(
            got.list,
            vec![Request {
                test: "src/other.test.ts > suite > works".into(),
                why: "flaky, passes on a re-run".into()
            }]
        );
        assert_eq!(got.dropped, 0);
    }

    #[test]
    fn the_line_is_read_in_any_case_with_a_bullet_markdown_and_windows_line_ends() {
        let report = "- **Quarantine:** `suite > a` | one\r\n* quarantine : suite > b | two\r\n  QUARANTINE: suite > c\r\n+ `Quarantine`: suite > d | four\r\n__Quarantine__: suite > e | five\r\n";
        let got = parse_requests(report);
        let tests: Vec<&str> = got.list.iter().map(|r| r.test.as_str()).collect();
        assert_eq!(
            tests,
            [
                "suite > a",
                "suite > b",
                "suite > c",
                "suite > d",
                "suite > e"
            ]
        );
        assert_eq!(got.list[0].why, "one");
        assert_eq!(got.list[2].why, "");
    }

    #[test]
    fn prose_that_mentions_a_quarantine_is_not_a_request() {
        for report in [
            "I would quarantine the other test but did not.",
            "Quarantined: suite > a | no",
            "No quarantine: needed",
            "see the Quarantine section",
            "x Quarantine: suite > a | no",
            "",
            "Quarantine:",
            "Quarantine:    ",
        ] {
            assert!(parse_requests(report).list.is_empty(), "{report:?}");
        }
    }

    #[test]
    fn the_briefs_own_example_quoted_back_is_not_a_request() {
        let got = parse_requests("Quarantine: <test> | <why>\nQuarantine: <a test> | because\n");
        assert!(got.list.is_empty(), "{got:?}");
    }

    #[test]
    fn a_test_asked_for_twice_counts_once_and_a_name_with_underscores_is_kept() {
        let got = parse_requests(
            "Quarantine: tests::my_flaky_test | a\nQuarantine: tests::my_flaky_test | b\nQuarantine:   tests::my_flaky_test   | c\n",
        );
        assert_eq!(got.list.len(), 1);
        assert_eq!(got.list[0].test, "tests::my_flaky_test");
        assert_eq!(got.list[0].why, "a");
    }

    #[test]
    fn long_text_is_cut_and_only_the_first_ten_requests_are_read() {
        let long = "x".repeat(2_000);
        let got = parse_requests(&format!("Quarantine: {long} | {long}\n"));
        assert_eq!(got.list[0].test.chars().count(), TEST_MAX);
        assert_eq!(got.list[0].why.chars().count(), WHY_MAX);
        let many: String = (0..REQUESTS_MAX + 3)
            .map(|n| format!("Quarantine: suite > t{n} | why\n"))
            .collect();
        let got = parse_requests(&many);
        assert_eq!(got.list.len(), REQUESTS_MAX);
        assert_eq!(got.dropped, 3);
        assert!(dropped_sentence(3).contains("only the first 10"));
    }

    // ---- critical -------------------------------------------------------------------------------------------------------------

    #[test]
    fn a_test_under_a_sensitive_path_is_critical() {
        for file in [
            "src/features/auth/login.test.ts",
            "src-tauri/src/sandbox/profile_tests.rs",
            "server/billing/plan.test.ts",
            "db/migrations/001.test.ts",
            "SRC\\Auth\\Login.test.ts",
        ] {
            assert_eq!(
                critical_reason(file, "works", &patterns(), &plain),
                Some(BY_PATH),
                "{file}"
            );
        }
        assert_eq!(
            critical_reason("src/tally/sum.test.ts", "works", &patterns(), &plain),
            None
        );
        // The project's own patterns count too.
        let own = vec!["**/ledger/**".to_string()];
        assert_eq!(
            critical_reason("src/ledger/sum.test.ts", "works", &own, &plain),
            Some(BY_PATH)
        );
    }

    #[test]
    fn a_name_or_title_with_the_critical_tag_is_critical_as_a_word_only() {
        for name in [
            "suite > @critical charges the card",
            "suite > charges the card @CRITICAL",
            "payments::tests::refunds @critical",
            "[chromium] \u{203a} a.spec.ts:7:5 \u{203a} @critical: login",
        ] {
            assert_eq!(
                critical_reason("src/a.test.ts", name, &patterns(), &plain),
                Some(BY_NAME),
                "{name}"
            );
        }
        let others = [
            "suite > @criticality of x",
            "suite > @critical_path",
            "suite > @critical-ish",
            "suite > not critical at all",
            "suite > critical",
        ];
        let source = source_with(&others);
        let read = |_: &str| Some(source.clone());
        for name in others {
            assert_eq!(
                critical_reason("src/a.test.ts", name, &patterns(), &read),
                None,
                "{name}"
            );
        }
    }

    #[test]
    fn a_marker_above_a_call_that_goes_on_over_several_lines_still_counts() {
        let src = "// @critical\nit(\n  \"charges the card\",\n  async () => {},\n);\n\nit(\n  \"shows a receipt\",\n  async () => {},\n);\n";
        let read = |_: &str| Some(src.to_string());
        let critical = |name: &str| critical_reason("src/pay.test.ts", name, &patterns(), &read);
        assert_eq!(critical("pay > charges the card"), Some(BY_MARKER));
        assert_eq!(critical("pay > shows a receipt"), None);
        // A decorator in between is walked through too.
        let py = "# @critical\n@pytest.mark.slow\ndef test_refund():\n    pass\n\n@pytest.mark.slow\ndef test_receipt():\n    pass\n";
        let read = |_: &str| Some(py.to_string());
        assert_eq!(
            critical_reason(
                "t/test_pay.py",
                "t/test_pay.py::test_refund",
                &patterns(),
                &read
            ),
            Some(BY_MARKER)
        );
        assert_eq!(
            critical_reason(
                "t/test_pay.py",
                "t/test_pay.py::test_receipt",
                &patterns(),
                &read
            ),
            None
        );
        // A parameter list is not in the source: `test_refund[usd]` is looked for as `test_refund`.
        assert_eq!(
            critical_reason(
                "t/test_pay.py",
                "t/test_pay.py::test_refund[usd]",
                &patterns(),
                &read
            ),
            Some(BY_MARKER)
        );
    }

    #[test]
    fn a_test_that_cannot_be_found_in_its_file_is_refused_not_waved_through() {
        // A generated title, a renamed test, a name too short to look for: nothing to check a marker on.
        let read = |_: &str| Some("it.each([1, 2])(\"charges %i\", () => {});\n".to_string());
        for name in [
            "pay > charges 1",
            "pay > charges 2",
            "pay > gone",
            "pay > x",
        ] {
            assert_eq!(
                critical_reason("src/pay.test.ts", name, &patterns(), &read),
                Some(NOT_FOUND),
                "{name}"
            );
        }
        // A name that is in a comment only is not found either.
        let read = |_: &str| Some("// charges the card\nit(\"x\", () => {});\n".to_string());
        assert_eq!(
            critical_reason(
                "src/pay.test.ts",
                "pay > charges the card",
                &patterns(),
                &read
            ),
            Some(NOT_FOUND)
        );
    }

    #[test]
    fn the_path_a_runner_printed_is_resolved_before_the_sensitive_patterns_are_read() {
        // Playwright prints a path relative to its test folder: `checkout.spec.ts`, which is `tests/billing/checkout.spec.ts`.
        let printed = failing(
            "checkout.spec.ts",
            "[chromium] \u{203a} checkout.spec.ts:7:5 \u{203a} pays",
        );
        let plan = plan_of(&[], std::slice::from_ref(&printed), &[]);
        let source = "test('pays', async () => {});\n";
        let read = |_: &str| Some(source.to_string());
        let request = ask("[chromium] \u{203a} checkout.spec.ts:7:5 \u{203a} pays");
        // Taken as printed it is not under a sensitive path, and nothing marks it: it would be quarantined.
        assert!(matches!(
            super::decide(&request, &plan, &patterns(), &|f| f.to_string(), &read),
            Verdict::Quarantine(_)
        ));
        // Resolved to the repository path, it is.
        let got = super::decide(
            &request,
            &plan,
            &patterns(),
            &|f| format!("tests/billing/{f}"),
            &read,
        );
        assert!(
            matches!(&got, Verdict::Refused(s) if s.contains("it sits under a sensitive path")),
            "{got:?}"
        );
    }

    #[test]
    fn a_marker_line_just_above_the_test_makes_it_critical() {
        let ts = "describe(\"pay\", () => {\n  // @critical\n  it(\"charges the card\", () => {});\n  it(\"shows a receipt\", () => {});\n});\n";
        let read = |_: &str| Some(ts.to_string());
        let critical = |name: &str| critical_reason("src/pay.test.ts", name, &patterns(), &read);
        assert_eq!(critical("pay > charges the card"), Some(BY_MARKER));
        // The marker belongs to the test right under it, not to the one after.
        assert_eq!(critical("pay > shows a receipt"), None);
        let rust = "#[test]\n#[doc = \"critical\"]\nfn refunds_in_full() {}\n\n#[test]\nfn rounds_cents() {}\n";
        let read = |_: &str| Some(rust.to_string());
        let critical = |name: &str| critical_reason("src/pay.rs", name, &patterns(), &read);
        assert_eq!(critical("pay::tests::refunds_in_full"), Some(BY_MARKER));
        assert_eq!(critical("pay::tests::rounds_cents"), None);
        let py = "# @critical\n# why: money\ndef test_refund():\n    pass\n";
        let read = |_: &str| Some(py.to_string());
        assert_eq!(
            critical_reason("tests/test_pay.py", "test_refund", &patterns(), &read),
            Some(BY_MARKER)
        );
        let block = "/* @critical */\ntest('pays', () => {});\n/*\n * @criticality\n */\ntest('shows', () => {});\n";
        let read = |_: &str| Some(block.to_string());
        assert_eq!(
            critical_reason("a.test.js", "pays", &patterns(), &read),
            Some(BY_MARKER)
        );
        assert_eq!(
            critical_reason("a.test.js", "shows", &patterns(), &read),
            None
        );
    }

    #[test]
    fn a_marker_that_is_not_a_comment_or_the_attribute_is_not_a_marker() {
        let src = "const tag = \"@critical\";\nit(\"works\", () => {});\n\n\n\n// @critical\n\n\n\n\nit(\"far away\", () => {});\n";
        let read = |_: &str| Some(src.to_string());
        assert_eq!(
            critical_reason("a.test.ts", "works", &patterns(), &read),
            None
        );
        assert_eq!(
            critical_reason("a.test.ts", "far away", &patterns(), &read),
            None
        );
    }

    #[test]
    fn a_test_whose_file_is_unknown_or_unreadable_is_refused_not_waved_through() {
        assert_eq!(
            critical_reason("", "works", &patterns(), &plain),
            Some(UNKNOWN_FILE)
        );
        assert_eq!(
            critical_reason("  ", "works", &patterns(), &plain),
            Some(UNKNOWN_FILE)
        );
        assert_eq!(
            critical_reason("src/a.test.ts", "works", &patterns(), &no_files),
            Some(UNREADABLE)
        );
        // Nothing to go on is not "critical" for a name with no file to read either, but the name is read first.
        assert_eq!(
            critical_reason("", "@critical x", &patterns(), &no_files),
            Some(BY_NAME)
        );
    }

    // ---- the decision ---------------------------------------------------------------------------------------------------------

    fn ask(test: &str) -> Request {
        Request {
            test: test.into(),
            why: "flaky".into(),
        }
    }

    #[test]
    fn a_failing_test_that_is_not_the_workers_and_not_critical_is_quarantined() {
        let other = failing("src/other.test.ts", "suite > works");
        let plan = plan_of(&[], std::slice::from_ref(&other), &[]);
        for way in [
            other.id(),
            "suite > works".to_string(),
            "src/other.test.ts > suite > works".to_string(),
            "src/other.test.ts::suite > works".to_string(),
            "  suite  >   works ".to_string(),
        ] {
            assert_eq!(
                decide(&ask(&way), &plan, &patterns(), &plain),
                Verdict::Quarantine(Box::new(other.clone())),
                "{way:?}"
            );
        }
    }

    #[test]
    fn a_test_is_named_the_way_the_run_printed_it_with_or_without_its_file() {
        // Vitest prints the file first, so that is the name the app holds.
        let printed = failing("src/other.test.ts", "src/other.test.ts > suite > works");
        let plan = plan_of(&[], std::slice::from_ref(&printed), &[]);
        for way in [
            "src/other.test.ts > suite > works",
            "suite > works",
            "src/other.test.ts::suite > works",
            "src\\other.test.ts > suite > works",
        ] {
            let got = decide(&ask(way), &plan, &patterns(), &plain);
            // The backslash form is not one the run prints: it is not taken for the test.
            if way.contains('\\') {
                assert!(matches!(got, Verdict::Refused(_)), "{way:?}");
            } else {
                assert_eq!(
                    got,
                    Verdict::Quarantine(Box::new(printed.clone())),
                    "{way:?}"
                );
            }
        }
        // A part of a name is not the name.
        assert!(matches!(
            decide(&ask("works"), &plan, &patterns(), &plain),
            Verdict::Refused(_)
        ));
    }

    #[test]
    fn a_test_the_workers_change_covers_is_refused_and_is_never_quarantined() {
        let mine = failing("src/a.test.ts", "suite > works");
        let plan = plan_of(std::slice::from_ref(&mine), &[], &[]);
        let got = decide(&ask("suite > works"), &plan, &patterns(), &plain);
        let Verdict::Refused(sentence) = got else {
            panic!("{got:?}");
        };
        assert!(
            sentence.starts_with("Quarantine refused: suite > works is a test your change covers"),
            "{sentence}"
        );
        // Even one that is already quarantined: a quarantine never excuses the task's own test.
        let plan = plan_of(
            std::slice::from_ref(&mine),
            &[],
            std::slice::from_ref(&mine),
        );
        assert!(matches!(
            decide(&ask("suite > works"), &plan, &patterns(), &plain),
            Verdict::Refused(_)
        ));
    }

    #[test]
    fn a_critical_test_is_refused_and_the_worker_is_told_why_and_whom_to_ask() {
        let auth = failing("src/features/auth/login.test.ts", "suite > logs in");
        let plan = plan_of(&[], &[auth], &[]);
        let got = decide(&ask("suite > logs in"), &plan, &patterns(), &plain);
        let Verdict::Refused(sentence) = got else {
            panic!("{got:?}");
        };
        assert_eq!(
            sentence,
            "Quarantine refused: suite > logs in is a critical test (it sits under a sensitive path). A critical test is read-only for a worker: ask your first mate."
        );
        // The same for a tagged name, and for a test already quarantined that is critical.
        let tagged = failing("src/a.test.ts", "suite > @critical pays");
        let plan = plan_of(&[], &[], &[tagged]);
        assert!(matches!(
            decide(&ask("suite > @critical pays"), &plan, &patterns(), &plain),
            Verdict::Refused(_)
        ));
    }

    #[test]
    fn a_test_already_quarantined_is_left_as_it_is() {
        let q = failing("src/other.test.ts", "suite > works");
        let plan = plan_of(&[], &[], &[q]);
        assert_eq!(
            decide(&ask("suite > works"), &plan, &patterns(), &plain),
            Verdict::Already
        );
    }

    #[test]
    fn a_name_that_matches_no_failing_test_or_two_is_not_applied_and_says_so() {
        let one = failing("src/a.test.ts", "suite > works");
        let two = failing("src/b.test.ts", "suite > works");
        let plan = plan_of(&[], &[one, two], &[]);
        let got = decide(&ask("suite > works"), &plan, &patterns(), &plain);
        assert!(
            matches!(&got, Verdict::Refused(s) if s.contains("could mean more than one failing test")),
            "{got:?}"
        );
        // A full name picks one.
        assert!(matches!(
            decide(
                &ask("src/a.test.ts > suite > works"),
                &plan,
                &patterns(),
                &plain
            ),
            Verdict::Quarantine(_)
        ));
        let got = decide(&ask("suite > passes"), &plan, &patterns(), &plain);
        assert!(
            matches!(&got, Verdict::Refused(s) if s.contains("is not one of the failing tests your runs show")),
            "{got:?}"
        );
        // Nothing failing at all: nothing to quarantine.
        assert!(matches!(
            decide(&ask("suite > works"), &Plan::default(), &patterns(), &plain),
            Verdict::Refused(_)
        ));
    }

    #[test]
    fn a_long_test_name_is_cut_in_the_sentence_a_worker_reads() {
        let long = "x".repeat(300);
        let plan = plan_of(&[], &[failing("src/features/auth/a.test.ts", &long)], &[]);
        let Verdict::Refused(sentence) = decide(&ask(&long), &plan, &patterns(), &plain) else {
            panic!("refused");
        };
        assert!(
            sentence.chars().count() < 260,
            "{}",
            sentence.chars().count()
        );
    }
}
