//! PT-5: the test fixer task. The brief is built here, by code, from the list; the report's decisions are read here too.
//!
//! The fixer is a normal worker task owned by the project's first mate, on its own checkout, in the background. For each test on its
//! brief it decides, with evidence, one of three:
//! - "code is wrong": a real bug. It does not change the test and reports it with the failing test as proof. The app names it as a
//!   finding on the ship check record and puts one Needs-you item to the person.
//! - "test is out of date": the behaviour changed on purpose. It rewrites the test and cites the brief or commit that changed it. A
//!   rewrite that only loosens an assertion with no cited change is refused by the test guard like any other: the fixer is not
//!   exempt, and the citation is how the brief names the test.
//! - "flaky": it passes on a re-run. It runs it again with `run_checks` and changes nothing. The app quarantines the test for 14 days, but
//!   only when its own record of the fixer's runs shows that green run after the test was listed, and never a critical test: that stays
//!   on the list as a finding that waits for the person.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use super::doc::{Doc, Item, CRITICAL_NOTE, NO_GREEN_NOTE};
use super::own;

/// The most tests one fixer brief carries. A task brief is capped (30,000 characters), and a fixer that is given more than it can
/// read decides none of them well. The rest wait for the next ship check's fixer: they stay on the list.
pub const BRIEF_ITEMS_MAX: usize = 12;
/// The commit lines shown per test.
const COMMITS_MAX: usize = 12;
const COMMIT_LINE_MAX: usize = 160;
/// The files whose history is read per test (the test and the files it covers).
const FILES_MAX: usize = 6;

pub const TITLE_WORDS: &str = "Sort failing tests";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    CodeWrong,
    OutOfDate,
    Flaky,
}

/// One decision the fixer's report states.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reported {
    /// The test's number in the brief (1-based).
    pub number: usize,
    pub kind: Kind,
    /// The one line after the decision: why, with the evidence it cites.
    pub line: String,
}

fn decision_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?im)^\s*(?:[-+]\s*)?decision\s*#?\s*(\d{1,3})\s*[:|.)\-]\s*(code is wrong|test is out of date|out of date|flaky)\b\s*(?:[|:\u{2013}\u{2014}\-]\s*)?(.*)$",
        )
        .expect("a decision pattern")
    })
}

/// The decisions a report states, one per test (the last line for a number wins). A line of prose that mentions "out of date" is
/// not one: only `Decision <n>: <kind> | <why>`, in any case, with or without markdown emphasis, a bullet or a dash.
pub fn parse_report(report: &str) -> Vec<Reported> {
    let plain: String = report
        .chars()
        .filter(|c| !matches!(c, '*' | '`' | '_'))
        .collect::<String>()
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut out: Vec<Reported> = Vec::new();
    for caps in decision_re().captures_iter(&plain) {
        let Ok(number) = caps[1].parse::<usize>() else {
            continue;
        };
        if number == 0 {
            continue;
        }
        let kind = match caps[2].to_lowercase().as_str() {
            "code is wrong" => Kind::CodeWrong,
            "flaky" => Kind::Flaky,
            _ => Kind::OutOfDate,
        };
        let line: String = caps[3]
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(300)
            .collect();
        // The brief's own example lines (`Decision 1: code is wrong | <one line: why ...>`) quoted back are not decisions.
        if line.starts_with('<') && line.ends_with('>') {
            continue;
        }
        out.retain(|earlier| earlier.number != number);
        out.push(Reported { number, kind, line });
    }
    out
}

/// What the app knows about a listed test that the fixer's report can't say for itself. The report is the fixer's word; a quarantine is
/// only for a test that is not critical and whose own runs show it passing.
pub struct Proof<'a> {
    /// Whether the test is critical: under a sensitive path, marked critical, or not able to be checked (`quarantine::critical_reason`).
    pub critical: &'a dyn Fn(&Item) -> bool,
    /// Whether the fixer's own `run_checks` records show the test's command green after the test was listed.
    pub green_after_listed: &'a dyn Fn(&Item) -> bool,
}

/// What applying a report did, in test ids.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Applied {
    pub code_wrong: Vec<String>,
    pub flaky: Vec<String>,
    /// Called flaky, but critical: kept on the list as a finding that waits for the person (never quarantined).
    pub critical: Vec<String>,
    /// Called flaky with no green run of its own to show for it: still on the list, undecided.
    pub unproven: Vec<String>,
    pub out_of_date: Vec<String>,
    /// Decisions for a number the brief did not have, or for a test no longer on the list.
    pub ignored: usize,
    /// Tests on the brief that the report did not decide.
    pub undecided: Vec<String>,
}

/// Applies the decisions to the list. `ids` are the test ids in the order the brief numbered them.
pub fn apply_report(
    doc: &mut Doc,
    ids: &[String],
    reported: &[Reported],
    now: u64,
    proof: &Proof,
) -> Applied {
    let mut applied = Applied::default();
    let mut decided: Vec<&str> = Vec::new();
    for item in reported {
        let Some(id) = item.number.checked_sub(1).and_then(|at| ids.get(at)) else {
            applied.ignored += 1;
            continue;
        };
        let line = if item.line.is_empty() {
            "the fixer gave no reason"
        } else {
            item.line.as_str()
        };
        if item.kind == Kind::Flaky {
            // The fixer's word is not enough for a quarantine (it switches a test off for 14 days). A test that is not on the list any
            // more is not looked at: it went green while the fixer worked.
            if let Some(listed) = doc.items.iter().find(|listed| &listed.id == id).cloned() {
                if (proof.critical)(&listed) {
                    // A critical test is never quarantined: it stays on the list as a finding and waits for the person.
                    if doc.mark_code_wrong(id, CRITICAL_NOTE, now) {
                        decided.push(id.as_str());
                        applied.critical.push(id.clone());
                    }
                    continue;
                }
                if !(proof.green_after_listed)(&listed) {
                    // No green run of its own to show: it is not sorted, and the next fixer is told why it is back.
                    doc.note_unproven(id, NO_GREEN_NOTE);
                    applied.unproven.push(id.clone());
                    continue;
                }
            }
        }
        let landed = match item.kind {
            Kind::CodeWrong => doc.mark_code_wrong(id, line, now),
            Kind::Flaky => doc.mark_flaky(id, line, now),
            // Rewritten: it leaves the list when its test runs green.
            Kind::OutOfDate => doc.items.iter().any(|listed| &listed.id == id),
        };
        if !landed {
            applied.ignored += 1;
            continue;
        }
        decided.push(id.as_str());
        match item.kind {
            Kind::CodeWrong => applied.code_wrong.push(id.clone()),
            Kind::Flaky => applied.flaky.push(id.clone()),
            Kind::OutOfDate => applied.out_of_date.push(id.clone()),
        }
    }
    applied.undecided = ids
        .iter()
        .filter(|id| !decided.contains(&id.as_str()))
        .filter(|id| doc.items.iter().any(|listed| &listed.id == *id))
        .cloned()
        .collect();
    applied
}

/// The tests the next fixer is given: undecided, oldest first, at most `BRIEF_ITEMS_MAX`. A test the app sent back (a flaky decision
/// with no green run to show, `NO_GREEN_NOTE`) waits behind the ones not yet tried: a test that can't be proven (it failed in a run no
/// `run_checks` step can repeat) would otherwise come first at every ship check and crowd the newer ones out.
pub fn pick(doc: &Doc) -> Vec<Item> {
    let mut items: Vec<Item> = doc.undecided().cloned().collect();
    items.sort_by(|a, b| {
        a.note
            .trim()
            .is_empty()
            .cmp(&b.note.trim().is_empty())
            .reverse()
            .then_with(|| a.first_seen_at.cmp(&b.first_seen_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    items.truncate(BRIEF_ITEMS_MAX);
    items
}

/// A date as `YYYY-MM-DD` (UTC) from epoch milliseconds.
pub fn date_of(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}

/// A commit id read from disk, as far as a git command line may take it.
fn commit_arg(text: &str) -> Option<&str> {
    let text = text.trim();
    ((7..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit())).then_some(text)
}

/// The files whose history says what changed around a test: the test's own file and the files it covers (the same folder, the
/// same name; a Rust source file's `tests.rs`). At most `FILES_MAX`, as the repository tracks them.
pub fn history_files(item: &Item, tracked: &[String]) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    let file = own::norm(&item.file);
    if file.is_empty() {
        return files;
    }
    files.push(file.clone());
    for path in tracked {
        let norm = own::norm(path);
        if norm == file || files.contains(&norm) {
            continue;
        }
        let rust_pair = file.ends_with(".rs") && norm.ends_with(".rs") && {
            let stem = file.trim_end_matches(".rs");
            norm == format!("{stem}/tests.rs")
                || norm == format!("{stem}_tests.rs")
                || norm == format!("{stem}/mod.rs")
        };
        if rust_pair || own::covers(&file, &norm) {
            files.push(norm);
        }
        if files.len() >= FILES_MAX {
            break;
        }
    }
    files
}

/// `git log --oneline <first>..HEAD -- <files>`, as plain lines. Never fails the brief: what couldn't be read is said instead.
pub fn commits_since(main: &Path, first: &str, files: &[String]) -> Vec<String> {
    let Some(first) = commit_arg(first) else {
        return vec!["(no first failing commit is known for this test)".to_string()];
    };
    if files.is_empty() {
        return vec!["(the test's file is not known, so its history was not read)".to_string()];
    }
    let range = format!("{first}..HEAD");
    // The paths are literal: a name with `*` or `[` in it is that file, not a pattern.
    let mut args: Vec<&str> = vec![
        "--literal-pathspecs",
        "log",
        "--oneline",
        "--no-color",
        "-n",
        "30",
        &range,
        "--",
    ];
    args.extend(files.iter().map(String::as_str));
    match crate::firstmate::gates::git(main, &args) {
        Ok((true, out, _)) => {
            let lines: Vec<String> = String::from_utf8_lossy(&out)
                .lines()
                .map(|line| line.chars().take(COMMIT_LINE_MAX).collect::<String>())
                .filter(|line| !line.trim().is_empty())
                .collect();
            if lines.is_empty() {
                vec!["(no commit has touched these files since)".to_string()]
            } else {
                lines
            }
        }
        _ => vec![format!(
            "(git could not read the commits since {}: it may not be in this repository any more)",
            &first[..first.len().min(7)]
        )],
    }
}

/// The task the ship check puts to the first mate: its title, its brief and its definition of done, and the ids in the order the
/// brief numbered them (the report's `Decision <n>` lines are matched with them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub title: String,
    pub brief: String,
    pub goal: String,
    pub ids: Vec<String>,
}

const RULES: &str = "This project sorts failing tests at ship. The tests below failed in earlier tasks and were not those tasks' own. You are the test fixer: decide each one with evidence, and change a test only where the rules below say you may.\n\nFor each test, decide one of three, and say which in your report:\n1. code is wrong: the test is right and the code has a real bug. Do not change the test. Report it as a finding with the failing test as proof.\n2. test is out of date: the behaviour changed on purpose. Rewrite the test to the current intended behaviour, and cite the brief or the commit that changed it in your report. A rewrite that only loosens an assertion with no cited behaviour change is refused by the test guard, so cite it.\n3. flaky: it passes on a re-run. Run it again with run_checks (the check that failed it, or the project's affected check with the test's file in paths) and see it pass, and do not change the test. The app quarantines a flaky test for 14 days, and it still runs and reports, but only when the app's own record shows that green run after the test was listed: with none, the test stays on the list for the next ship check. A critical test (under a sensitive path, or marked critical) is never quarantined: it goes to the person whatever you saw, so say what you saw.\n\nNever delete, skip or weaken a test. Your own rewritten tests must pass: run them with run_checks before you report. Do not fix the code for a \"code is wrong\" test: report it, and your first mate decides.\n\nEnd your report with one line per test, in exactly this form (the number is the test's number below):\nDecision 1: code is wrong | <one line: why, naming the failing test>\nDecision 2: test is out of date | <one line: what changed on purpose, with the commit or brief>\nDecision 3: flaky | <one line: how you saw it pass on a re-run>\n";

/// The most characters of a brief. The delegation keeps a task's brief to 12,000 characters (`delegations.rs` `BRIEF_MAX`), and the
/// test guard looks for a rewritten test's name in that kept copy: a test named past the cut would read as unnamed. So the brief is
/// built to fit, and the tests that do not fit wait for the next ship check's fixer.
pub const BRIEF_CHARS_MAX: usize = 11_500;
/// What the header (the count and the number waiting) may add after the rules.
const HEADER_RESERVE: usize = 140;

/// One test's part of the brief. `failure_max` cuts its failure text (the first test of a brief is always given room).
fn block(number: usize, item: &Item, commits: &[String], failure_max: usize) -> String {
    let mut text = format!("\n### {number}. {}\n", item.name);
    if !item.file.is_empty() {
        text.push_str(&format!("File: {}\n", item.file));
    }
    text.push_str(&format!("Runner: {}\n", item.runner));
    let task = if item.task_title.trim().is_empty() {
        "an earlier task".to_string()
    } else {
        format!("the task \"{}\"", item.task_title.trim())
    };
    text.push_str(&format!(
        "First failed: {} in {task}, first seen {}; seen {} time{}.\n",
        if item.first_commit.is_empty() {
            "(unknown commit)"
        } else {
            item.first_commit.as_str()
        },
        date_of(item.first_seen_at),
        item.seen_count,
        if item.seen_count == 1 { "" } else { "s" }
    ));
    if !item.note.trim().is_empty() {
        // An earlier fixer's decision the app did not accept (`NO_GREEN_NOTE`): why this test is back.
        text.push_str(&format!("Last time: {}\n", item.note.trim()));
    }
    text.push_str("Failure:\n");
    let failure = item.failure.trim();
    if failure.chars().count() > failure_max {
        let cut: String = failure
            .chars()
            .take(failure_max.saturating_sub(1))
            .collect();
        text.push_str(&cut);
        text.push('…');
    } else {
        text.push_str(failure);
    }
    text.push('\n');
    text.push_str(&format!(
        "Commits since it first failed (git log --oneline {}..HEAD -- <the test's file and the files it covers>):\n",
        if item.first_commit.is_empty() { "<first>" } else { item.first_commit.as_str() }
    ));
    for line in commits.iter().take(COMMITS_MAX + 1) {
        text.push_str(&format!("  {line}\n"));
    }
    text
}

/// The brief, built from the list. `commits` is the history of one test's files since it first failed, from `commits_since`. It holds
/// as many of the oldest undecided tests as fit in `BRIEF_CHARS_MAX` (never more than `BRIEF_ITEMS_MAX`, never none): the rest are
/// said to wait.
pub fn build(doc: &Doc, commits: &dyn Fn(&Item) -> Vec<String>) -> Option<Request> {
    let candidates = pick(doc);
    if candidates.is_empty() {
        return None;
    }
    let budget = BRIEF_CHARS_MAX.saturating_sub(RULES.chars().count() + HEADER_RESERVE);
    let mut used = 0usize;
    let mut items: Vec<&Item> = Vec::new();
    let mut blocks: Vec<String> = Vec::new();
    for item in &candidates {
        let history = commits(item);
        let number = items.len() + 1;
        let mut text = block(number, item, &history, super::doc::FAILURE_MAX);
        if items.is_empty() {
            // The first test is always briefed: give its failure text only what is left when the rest of it is as long as it can be.
            let mut room = super::doc::FAILURE_MAX;
            while text.chars().count() > budget && room > 200 {
                room /= 2;
                text = block(number, item, &history, room);
            }
        } else if used + text.chars().count() > budget {
            break;
        }
        used += text.chars().count();
        items.push(item);
        blocks.push(text);
    }
    let waiting = doc.undecided().count().saturating_sub(items.len());
    let mut brief = String::from(RULES);
    brief.push_str(&format!("\n## Tests to sort ({})\n", items.len()));
    if waiting > 0 {
        brief.push_str(&format!(
            "{waiting} more wait for the next ship check; they are not on this list.\n"
        ));
    }
    for text in blocks {
        brief.push_str(&text);
    }
    Some(Request {
        title: format!("{TITLE_WORDS} ({})", items.len()),
        brief,
        goal: "Every test on the brief has a decision in your report, and every test you rewrote passes when run."
            .to_string(),
        ids: items.iter().map(|item| item.id.clone()).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_debt::doc::{Candidate, DecisionKind};

    fn listed(doc: &mut Doc, file: &str, name: &str, at: u64) -> String {
        doc.note_failure(
            &Candidate {
                runner: "vitest".into(),
                file: file.into(),
                name: name.into(),
                failure: format!("{name} failed: expected 1 to be 2"),
                command: "affected".into(),
                first_commit: "abc1234".into(),
                delegation_id: "d1".into(),
                task_title: "Add totals".into(),
            },
            at,
        );
        doc.items.last().unwrap().id.clone()
    }

    /// `apply_report` with the two things the app knows said by closures: whether a test is critical, and whether it has a green run.
    fn apply_with(
        doc: &mut Doc,
        ids: &[String],
        reported: &[Reported],
        now: u64,
        critical: &dyn Fn(&Item) -> bool,
        green: &dyn Fn(&Item) -> bool,
    ) -> Applied {
        apply_report(
            doc,
            ids,
            reported,
            now,
            &Proof {
                critical,
                green_after_listed: green,
            },
        )
    }

    /// A test that is not critical and has a green run, as every test was before the app asked.
    fn proven(doc: &mut Doc, ids: &[String], reported: &[Reported], now: u64) -> Applied {
        apply_with(doc, ids, reported, now, &|_| false, &|_| true)
    }

    #[test]
    fn the_three_decisions_are_read_from_a_report() {
        let report = "Done.\n\nDecision 1: code is wrong | totals ignore tax: src/a.test.ts fails on the real value\nDecision 2: test is out of date | the brief for totals changed the rounding (commit 9f3c2a1)\nDecision 3: flaky | passed on a re-run, twice\n";
        let got = parse_report(report);
        assert_eq!(got.len(), 3);
        assert_eq!((got[0].number, got[0].kind), (1, Kind::CodeWrong));
        assert_eq!(
            got[0].line,
            "totals ignore tax: src/a.test.ts fails on the real value"
        );
        assert_eq!((got[1].number, got[1].kind), (2, Kind::OutOfDate));
        assert!(got[1].line.contains("9f3c2a1"));
        assert_eq!((got[2].number, got[2].kind), (3, Kind::Flaky));
    }

    #[test]
    fn a_report_with_markdown_bullets_case_and_crlf_is_read_the_same() {
        let report = "- **Decision 1:** Code is wrong | real bug\r\n* `Decision 2`: TEST IS OUT OF DATE - rounding changed\r\n- decision #3 - flaky: passed on re-run\r\n";
        let got = parse_report(report);
        assert_eq!(
            got.iter().map(|r| (r.number, r.kind)).collect::<Vec<_>>(),
            vec![(1, Kind::CodeWrong), (2, Kind::OutOfDate), (3, Kind::Flaky)]
        );
        assert_eq!(got[1].line, "rounding changed");
        assert_eq!(got[2].line, "passed on re-run");
    }

    #[test]
    fn prose_that_mentions_a_decision_is_not_a_decision() {
        let report = "I decided the test is out of date and the other one is flaky.\nThe decision 2 was hard.\nDecisions: all done\nDecision 0: flaky | nope\nDecision x: flaky | nope\n";
        assert!(parse_report(report).is_empty());
    }

    #[test]
    fn a_number_stated_twice_keeps_the_last_and_a_missing_reason_is_empty() {
        let got = parse_report("Decision 1: flaky | first\nDecision 1: code is wrong\n");
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].kind, got[0].line.as_str()), (Kind::CodeWrong, ""));
    }

    #[test]
    fn a_very_long_reason_is_cut_and_a_huge_report_is_read_without_trouble() {
        let long = "x".repeat(5_000);
        let got = parse_report(&format!("Decision 1: flaky | {long}\n"));
        assert_eq!(got[0].line.chars().count(), 300);
        let big = "noise\n".repeat(200_000);
        assert!(parse_report(&big).is_empty());
    }

    #[test]
    fn code_is_wrong_names_the_test_a_real_bug_flaky_quarantines_it_and_out_of_date_waits_for_green(
    ) {
        let mut doc = Doc::default();
        let a = listed(&mut doc, "a.test.ts", "a", 1);
        let b = listed(&mut doc, "b.test.ts", "b", 2);
        let c = listed(&mut doc, "c.test.ts", "c", 3);
        let ids = vec![a.clone(), b.clone(), c.clone()];
        let report = parse_report("Decision 1: code is wrong | bug\nDecision 2: flaky | re-run passed\nDecision 3: test is out of date | rounding, commit abc1234\n");
        let applied = proven(&mut doc, &ids, &report, 100);
        assert_eq!(applied.code_wrong, vec![a.clone()]);
        assert_eq!(applied.flaky, vec![b.clone()]);
        assert_eq!(applied.out_of_date, vec![c.clone()]);
        assert!(applied.undecided.is_empty());
        let named = doc.items.iter().find(|i| i.id == a).unwrap();
        assert_eq!(
            named.decision.as_ref().unwrap().kind,
            DecisionKind::CodeWrong
        );
        assert!(doc.items.iter().all(|i| i.id != b), "flaky leaves the list");
        assert!(doc.quarantined(&b, 101), "and is quarantined");
        assert!(
            doc.items.iter().any(|i| i.id == c),
            "out of date stays until it runs green"
        );
        assert!(doc
            .items
            .iter()
            .find(|i| i.id == c)
            .unwrap()
            .decision
            .is_none());
    }

    #[test]
    fn a_decision_for_a_number_the_brief_did_not_have_or_a_test_already_gone_is_ignored() {
        let mut doc = Doc::default();
        let a = listed(&mut doc, "a.test.ts", "a", 1);
        let report = parse_report("Decision 1: flaky | x\nDecision 9: code is wrong | y\n");
        doc.items.clear(); // it went green while the fixer worked
        let applied = proven(&mut doc, &[a], &report, 5);
        assert_eq!(applied.ignored, 2);
        assert!(applied.code_wrong.is_empty() && applied.flaky.is_empty());
        assert!(
            doc.quarantine.is_empty(),
            "nothing is quarantined for a test that was not on the list"
        );
    }

    #[test]
    fn a_test_the_report_did_not_decide_stays_undecided_for_the_next_ship_check() {
        let mut doc = Doc::default();
        let a = listed(&mut doc, "a.test.ts", "a", 1);
        let b = listed(&mut doc, "b.test.ts", "b", 2);
        let report = parse_report("Decision 1: flaky | x\n");
        let applied = proven(&mut doc, &[a, b.clone()], &report, 5);
        assert_eq!(applied.undecided, vec![b]);
    }

    #[test]
    fn a_critical_test_called_flaky_stays_on_the_list_as_a_real_bug_with_a_note_and_is_never_quarantined(
    ) {
        let mut doc = Doc::default();
        let a = listed(&mut doc, "src/auth/login.test.ts", "logs in", 1);
        let b = listed(&mut doc, "src/b.test.ts", "adds", 2);
        let ids = vec![a.clone(), b.clone()];
        let report = parse_report("Decision 1: flaky | passed twice\nDecision 2: flaky | passed\n");
        // `a` is critical and has a green run: critical wins. `b` is neither.
        let applied = apply_with(
            &mut doc,
            &ids,
            &report,
            100,
            &|item| item.file.contains("/auth/"),
            &|_| true,
        );
        assert_eq!(applied.critical, vec![a.clone()]);
        assert_eq!(applied.flaky, vec![b.clone()]);
        assert!(applied.undecided.is_empty());
        let item = doc.items.iter().find(|i| i.id == a).expect("it stays");
        let decision = item.decision.as_ref().expect("named");
        assert_eq!(decision.kind, DecisionKind::CodeWrong);
        assert_eq!(decision.line, CRITICAL_NOTE);
        assert_eq!(
            item.bug_words(),
            "logs in is a critical test that failed. A critical test can't be quarantined; it waits for you."
        );
        assert_eq!(doc.real_bugs().count(), 1, "surfaced like a real bug");
        assert!(!doc.quarantined(&a, 101), "never quarantined");
        assert!(doc.quarantined(&b, 101), "the other one is");
        // A real bug's words are unchanged.
        let mut bug = Doc::default();
        let id = listed(&mut bug, "src/c.test.ts", "totals", 1);
        bug.mark_code_wrong(&id, "the total ignores tax", 2);
        assert_eq!(
            bug.items[0].bug_words(),
            "totals fails because the code is wrong: the total ignores tax"
        );
    }

    #[test]
    fn a_flaky_decision_with_no_green_run_leaves_the_test_undecided_with_a_note_for_the_next_fixer()
    {
        let mut doc = Doc::default();
        let a = listed(&mut doc, "src/a.test.ts", "a", 1);
        let b = listed(&mut doc, "src/b.test.ts", "b", 2);
        let ids = vec![a.clone(), b.clone()];
        let report =
            parse_report("Decision 1: flaky | passed, I think\nDecision 2: flaky | passed twice\n");
        let applied = apply_with(&mut doc, &ids, &report, 100, &|_| false, &|item| {
            item.file == "src/b.test.ts"
        });
        assert_eq!(applied.unproven, vec![a.clone()]);
        assert_eq!(applied.flaky, vec![b.clone()]);
        assert_eq!(applied.undecided, vec![a.clone()]);
        let item = doc.items.iter().find(|i| i.id == a).expect("it stays");
        assert!(item.decision.is_none());
        assert_eq!(item.note, NO_GREEN_NOTE);
        assert!(!doc.quarantined(&a, 101));
        assert!(doc.quarantined(&b, 101));
        // The next fixer is told, in its brief, why it is back.
        let request = build(&doc, &|_| Vec::new()).unwrap();
        assert!(request.brief.contains(NO_GREEN_NOTE), "{}", request.brief);
        assert_eq!(request.ids, vec![a]);
    }

    #[test]
    fn a_test_sent_back_for_want_of_a_green_run_is_briefed_after_the_ones_not_yet_tried() {
        let mut doc = Doc::default();
        let oldest = listed(&mut doc, "src/a.test.ts", "a", 1);
        let newer = listed(&mut doc, "src/b.test.ts", "b", 2);
        let newest = listed(&mut doc, "src/c.test.ts", "c", 3);
        doc.note_unproven(&oldest, NO_GREEN_NOTE);
        let order: Vec<String> = pick(&doc).into_iter().map(|item| item.id).collect();
        assert_eq!(order, vec![newer.clone(), newest.clone(), oldest.clone()]);
        // With more than a brief holds, the ones that already came back wait their turn instead of crowding the new ones out.
        for n in 0..BRIEF_ITEMS_MAX {
            listed(&mut doc, "src/d.test.ts", &format!("d{n}"), 10 + n as u64);
        }
        let picked: Vec<String> = pick(&doc).into_iter().map(|item| item.id).collect();
        assert_eq!(picked.len(), BRIEF_ITEMS_MAX);
        assert!(!picked.contains(&oldest), "{picked:?}");
        assert!(picked.contains(&newer) && picked.contains(&newest));
    }

    #[test]
    fn the_proof_only_gates_a_flaky_decision_and_a_test_that_is_gone_is_not_looked_at() {
        let mut doc = Doc::default();
        let a = listed(&mut doc, "src/a.test.ts", "a", 1);
        let b = listed(&mut doc, "src/b.test.ts", "b", 2);
        let c = listed(&mut doc, "src/c.test.ts", "c", 3);
        let ids = vec![a.clone(), b.clone(), c.clone()];
        let report = parse_report(
            "Decision 1: code is wrong | bug\nDecision 2: test is out of date | rounding, commit abc1234\nDecision 3: flaky | passed\n",
        );
        doc.items.retain(|item| item.id != c); // it went green while the fixer worked
        let looked = std::cell::Cell::new(0);
        let asked = |_: &Item| {
            looked.set(looked.get() + 1);
            true
        };
        let applied = apply_with(&mut doc, &ids, &report, 100, &asked, &asked);
        assert_eq!(applied.code_wrong, vec![a]);
        assert_eq!(applied.out_of_date, vec![b]);
        assert_eq!(applied.ignored, 1);
        assert!(applied.critical.is_empty() && applied.unproven.is_empty());
        assert_eq!(
            looked.get(),
            0,
            "nothing was asked about a test that is not on the list"
        );
    }

    #[test]
    fn the_brief_tells_the_fixer_a_flaky_test_needs_a_green_run_of_its_own_and_a_critical_one_is_never_quarantined(
    ) {
        let mut doc = Doc::default();
        listed(&mut doc, "src/a.test.ts", "adds up", 1);
        let brief = build(&doc, &|_| Vec::new()).unwrap().brief;
        for needle in [
            "Run it again with run_checks",
            "only when the app's own record shows that green run after the test was listed",
            "stays on the list for the next ship check",
            "A critical test",
            "never quarantined",
        ] {
            assert!(brief.contains(needle), "the brief lacks {needle:?}");
        }
    }

    #[test]
    fn the_brief_lists_each_test_with_its_failure_and_its_commits_and_states_the_three_rules() {
        let mut doc = Doc::default();
        listed(&mut doc, "src/a.test.ts", "adds up", 86_400_000 * 3);
        listed(&mut doc, "src/b.test.ts", "subtracts", 86_400_000 * 5);
        let request = build(&doc, &|item| vec![format!("c0ffee1 touched {}", item.file)]).unwrap();
        assert_eq!(request.title, "Sort failing tests (2)");
        assert_eq!(request.ids.len(), 2);
        let brief = &request.brief;
        for needle in [
            "code is wrong",
            "test is out of date",
            "flaky",
            "Never delete, skip or weaken a test",
            "Your own rewritten tests must pass",
            "Decision 1: code is wrong |",
            "### 1. adds up",
            "File: src/a.test.ts",
            "adds up failed: expected 1 to be 2",
            "c0ffee1 touched src/a.test.ts",
            "### 2. subtracts",
            "git log --oneline abc1234..HEAD",
            "1970-01-04",
        ] {
            assert!(brief.contains(needle), "{needle} is missing from:\n{brief}");
        }
        assert!(brief.chars().count() <= BRIEF_CHARS_MAX);
    }

    #[test]
    fn a_brief_never_outgrows_the_copy_the_delegation_keeps_and_the_tests_that_do_not_fit_wait() {
        let mut doc = Doc::default();
        for n in 0..12 {
            let mut c = Candidate {
                runner: "vitest".into(),
                file: "src/a.test.ts".into(),
                name: format!("a test with a long name number {n:02}"),
                failure: format!("{n} failed: {}", "boom ".repeat(400)),
                command: "affected".into(),
                first_commit: "abc1234".into(),
                delegation_id: "d1".into(),
                task_title: "Add totals".into(),
            };
            c.failure.truncate(1_500);
            doc.note_failure(&c, 100 + n);
        }
        let commits = |_: &Item| {
            (0..20)
                .map(|n| format!("c0ffee{n} {}", "x".repeat(150)))
                .collect::<Vec<_>>()
        };
        let request = build(&doc, &commits).unwrap();
        assert!(
            request.brief.chars().count() <= BRIEF_CHARS_MAX,
            "{}",
            request.brief.chars().count()
        );
        assert!(
            request.ids.len() < 12 && !request.ids.is_empty(),
            "{}",
            request.ids.len()
        );
        // Every test in the kept copy of the brief (its first 12,000 characters) is named there, and the rest are said to wait.
        let kept: String = request.brief.chars().take(12_000).collect();
        for (n, _) in request.ids.iter().enumerate() {
            assert!(
                kept.contains(&format!("### {}. a test with a long name", n + 1)),
                "test {n} is past the cut"
            );
        }
        let waiting = 12 - request.ids.len();
        assert!(
            request
                .brief
                .contains(&format!("{waiting} more wait for the next ship check")),
            "{}",
            &request.brief[..800]
        );
        assert_eq!(
            request.title,
            format!("Sort failing tests ({})", request.ids.len())
        );
    }

    #[test]
    fn the_first_test_is_always_briefed_even_when_its_evidence_is_as_long_as_it_can_be() {
        let mut doc = Doc::default();
        let mut c = Candidate {
            runner: "vitest".into(),
            file: "src/a.test.ts".into(),
            name: "a huge one".into(),
            failure: "z".repeat(1_500),
            ..Candidate::default()
        };
        doc.note_failure(&c, 1);
        c.name = "second".into();
        doc.note_failure(&c, 2);
        let commits = |_: &Item| {
            (0..40)
                .map(|n| format!("c0ffee{n} {}", "y".repeat(400)))
                .collect::<Vec<_>>()
        };
        let request = build(&doc, &commits).unwrap();
        assert_eq!(request.ids.len(), 1, "the second does not fit");
        assert!(request.brief.contains("### 1. a huge one"));
        assert!(
            request.brief.chars().count() <= BRIEF_CHARS_MAX + 2_500,
            "bounded"
        );
    }

    #[test]
    fn the_briefs_own_example_lines_quoted_back_are_not_decisions() {
        let report = "I will follow this form:\nDecision 1: code is wrong | <one line: why, naming the failing test>\nDecision 2: test is out of date | <one line: what changed on purpose, with the commit or brief>\nDecision 3: flaky | passed twice on a re-run\n";
        let got = parse_report(report);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].number, got[0].kind), (3, Kind::Flaky));
    }

    #[test]
    fn the_brief_never_loosens_the_weakened_test_rule_for_the_fixer() {
        let mut doc = Doc::default();
        listed(&mut doc, "src/a.test.ts", "adds up", 1);
        let brief = build(&doc, &|_| Vec::new()).unwrap().brief;
        assert!(brief.contains("refused by the test guard"));
        assert!(!brief.to_lowercase().contains("you may delete"));
        assert!(!brief.to_lowercase().contains("skip it"));
    }

    #[test]
    fn only_undecided_tests_are_briefed_oldest_first_and_at_most_twelve() {
        let mut doc = Doc::default();
        for n in 0..15 {
            listed(&mut doc, "a.test.ts", &format!("t{n:02}"), 100 + n);
        }
        let named = doc.items[0].id.clone();
        doc.mark_code_wrong(&named, "real", 200);
        let request = build(&doc, &|_| Vec::new()).unwrap();
        assert_eq!(request.ids.len(), BRIEF_ITEMS_MAX);
        assert!(
            !request.ids.contains(&named),
            "a test already named a real bug is not briefed again"
        );
        assert!(
            request
                .brief
                .contains("2 more wait for the next ship check"),
            "{}",
            request.brief
        );
        assert!(request.brief.contains("### 1. t01"));
    }

    #[test]
    fn an_empty_list_has_no_fixer() {
        assert!(build(&Doc::default(), &|_| Vec::new()).is_none());
        let mut doc = Doc::default();
        let id = listed(&mut doc, "a.test.ts", "a", 1);
        doc.mark_code_wrong(&id, "x", 2);
        assert!(
            build(&doc, &|_| Vec::new()).is_none(),
            "a named bug is not sorted again"
        );
    }

    #[test]
    fn dates_are_read_from_epoch_milliseconds() {
        assert_eq!(date_of(0), "1970-01-01");
        assert_eq!(date_of(951_782_400_000), "2000-02-29");
        assert_eq!(date_of(1_794_528_000_000), "2026-11-13");
    }

    #[test]
    fn history_files_are_the_test_and_what_it_covers_and_a_rust_sources_tests_file() {
        let tracked = vec![
            "src/a.ts".to_string(),
            "src/a.test.ts".to_string(),
            "src/b.ts".to_string(),
            "src-tauri/src/x/y.rs".to_string(),
            "src-tauri/src/x/y/tests.rs".to_string(),
            "src-tauri/src/x/z.rs".to_string(),
        ];
        let item = |file: &str| Item {
            file: file.into(),
            ..Item::default()
        };
        assert_eq!(
            history_files(&item("src/a.test.ts"), &tracked),
            vec!["src/a.test.ts", "src/a.ts"]
        );
        assert_eq!(
            history_files(&item("src-tauri/src/x/y.rs"), &tracked),
            vec!["src-tauri/src/x/y.rs", "src-tauri/src/x/y/tests.rs"]
        );
        assert!(history_files(&item(""), &tracked).is_empty());
    }

    #[test]
    fn a_commit_that_is_not_hex_never_reaches_git() {
        let dir = crate::test_debt::testing::Temp::new();
        for bad in [
            "",
            "--output=x",
            "HEAD",
            "abc",
            "abc1234; rm -rf",
            "zzzzzzz",
        ] {
            let lines = commits_since(dir.path(), bad, &["a.ts".to_string()]);
            assert_eq!(
                lines,
                vec!["(no first failing commit is known for this test)".to_string()],
                "{bad}"
            );
        }
        let none = commits_since(dir.path(), "abc1234", &[]);
        assert!(none[0].contains("not known"));
    }
}
