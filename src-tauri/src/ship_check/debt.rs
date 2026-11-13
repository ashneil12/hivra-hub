//! PT-5: test debt at the ship check.
//!
//! The project's checks may fail on tests that are not anyone's current work: they go on the test debt list (`test_debt`), the
//! check that failed only on them does not read as a plain failure, and one test fixer task sorts them. This module is the ship
//! check's side of that:
//!
//! - `classify_checks`: after the verify stage ran the project's checks, read each failed check's log. A check that failed only on
//!   tests that are quarantined or already named real bugs is not blocked by them; one that failed on tests now on the list reads
//!   "Sorting N tests"; one that failed for any other reason stays failed. A green check takes its tests off the list.
//! - `stage_of`: the "Test debt" step and the findings (a real bug, a quarantine, an expired quarantine).
//! - `follow_up_in` and `claim_fixer_in`: after the run, what is due (a fixer for the tests still to sort; the Needs-you items for a
//!   real bug and for a test that broke five times and caught nothing). The webview asks for each: the one fixer task (never two at
//!   once per project) is claimed by the call that starts it, and each Needs-you item is claimed before it is filed, which is what
//!   makes each once. A ship check run from a card claims nothing.
//!
//! The ship check passes only when the list is empty or every remaining test is a named finding.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{one_line, Outcome, Stage, Step, LINE_MAX};
use crate::test_debt::doc::{Doc, Fixer, FixerClaim, Quarantined, Row};
use crate::test_debt::{fixer, own, store};
use crate::test_summary::{self, TestOutcome};
use crate::verify_stage::{Outcome as V, VerifyRecord};

pub const STEP: &str = "Test debt";
/// The most of a check's log read.
const LOG_MAX: u64 = 4 * 1024 * 1024;
/// The tests named in a step's line.
const NAMED: usize = 3;

/// A named finding on the record: not a block, but never hidden.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// `code-wrong`, `quarantined` or `quarantine-expired`.
    pub kind: String,
    pub test: String,
    pub file: String,
    /// One plain sentence.
    pub line: String,
}

/// The "Test debt" step and what it found.
#[derive(Clone, Debug, Default)]
pub struct DebtStage {
    pub stage: Stage,
    pub findings: Vec<Finding>,
}

/// What `classify_checks` needs from outside.
pub struct ChecksCtx<'a> {
    pub head: &'a str,
    pub now: u64,
    /// A check's log, from its end.
    pub read_log: &'a dyn Fn(&str) -> Option<String>,
    /// The repository's `.rs` files, to find a Rust test's source file.
    pub rust_files: &'a [String],
    /// Every file the repository tracks, so a test that was deleted is not counted as a bug caught.
    pub tracked: &'a [String],
}

fn names(list: &[String]) -> String {
    let shown: Vec<String> = list
        .iter()
        .take(NAMED)
        .map(|n| n.chars().take(80).collect())
        .collect();
    let more = list.len().saturating_sub(NAMED);
    if more > 0 {
        format!("{} and {more} more", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

fn tests_word(n: usize) -> String {
    if n == 1 {
        "1 test".to_string()
    } else {
        format!("{n} tests")
    }
}

/// Reads each check the verify stage ran. `stage.steps[i]` is `record.steps[i]` (`steps_of_verify` keeps their order).
pub fn classify_checks(doc: &mut Doc, stage: &mut Stage, record: &VerifyRecord, ctx: &ChecksCtx) {
    for (index, step) in record.steps.iter().enumerate() {
        if step.kind != "check" {
            continue;
        }
        let Some(mapped) = stage.steps.get_mut(index) else {
            continue;
        };
        match step.outcome {
            V::Passed => {
                // The same check ran green; and so did its runner's tests, as far as the log says, which takes off what an earlier
                // task's scoped `affected` run listed. A test whose file is gone is not a bug caught.
                let runner = step
                    .log_path
                    .as_deref()
                    .and_then(|path| (ctx.read_log)(path))
                    .filter(|log| test_summary::failures(log).is_empty())
                    .and_then(|log| {
                        let classified = test_summary::classify(&log);
                        (classified.outcome == TestOutcome::Green)
                            .then_some(classified.summary)
                            .flatten()
                            .map(|summary| own::runner_word(summary.runner))
                    });
                doc.remove_green_with(
                    |item| {
                        item.command == step.id
                            || (runner == Some(item.runner.as_str())
                                && item.command == crate::run_checks::AFFECTED_ID)
                    },
                    |item| {
                        item.file.is_empty()
                            || ctx
                                .tracked
                                .iter()
                                .any(|path| own::norm(path) == own::norm(&item.file))
                            || ctx.tracked.is_empty()
                    },
                );
            }
            V::Failed => {
                // Only a check that ran and failed on its exit status: one that was stopped, timed out or never finished failed for
                // more than its tests. A log that also holds a build error or a type error did not fail on tests alone either.
                if !step.detail.starts_with("failed") {
                    continue;
                }
                let Some(log) = step
                    .log_path
                    .as_deref()
                    .and_then(|path| (ctx.read_log)(path))
                else {
                    continue;
                };
                if test_summary::has_build_error(&log) {
                    continue;
                }
                let classified = test_summary::classify(&log);
                let (TestOutcome::Red, Some(summary)) = (classified.outcome, classified.summary)
                else {
                    continue;
                };
                let named = test_summary::failures(&log);
                // Every failing test must be named, or the failure is not shown to be only tests: it stays a failure.
                if named.is_empty() || (named.len() as u64) < summary.failed {
                    continue;
                }
                let failing =
                    own::from_failures(Some(summary.runner), &step.id, &named, ctx.rust_files);
                let mut sorting: Vec<String> = Vec::new();
                let mut not_blocking = 0usize;
                let mut unlisted = false;
                for f in failing {
                    let id = f.id();
                    if doc.quarantined(&id, ctx.now) {
                        not_blocking += 1;
                        continue;
                    }
                    let named_bug = doc
                        .items
                        .iter()
                        .any(|item| item.id == id && item.decision.is_some());
                    let noted = doc.note_failure(
                        &crate::test_debt::doc::Candidate {
                            runner: f.runner.clone(),
                            file: f.file.clone(),
                            name: f.name.clone(),
                            failure: f.message.clone(),
                            command: step.id.clone(),
                            first_commit: ctx.head.to_string(),
                            delegation_id: String::new(),
                            task_title: "Ship check".to_string(),
                        },
                        ctx.now,
                    );
                    if named_bug {
                        not_blocking += 1;
                    } else if noted == crate::test_debt::doc::Noted::Full {
                        unlisted = true;
                    } else {
                        sorting.push(f.name.clone());
                    }
                }
                if unlisted {
                    // The list is full: say what happened, as a plain failure.
                    continue;
                }
                if sorting.is_empty() {
                    mapped.outcome = Outcome::Passed;
                    mapped.detail = one_line(
                        &format!(
                            "{} failed, all of them quarantined or named real bugs, so they do not block",
                            tests_word(not_blocking)
                        ),
                        LINE_MAX,
                    );
                } else {
                    mapped.outcome = Outcome::CouldNotRun;
                    mapped.detail = one_line(
                        &format!("Sorting {}: {}", tests_word(sorting.len()), names(&sorting)),
                        LINE_MAX,
                    );
                }
            }
            V::CouldNotExercise | V::NotRun => {}
        }
    }
}

/// The "Test debt" step and the findings, from the list as it is now. `expired` are the quarantine entries that came back since
/// the last check (listed once).
pub fn stage_of(doc: &Doc, expired: &[Quarantined], now: u64) -> DebtStage {
    let waiting = doc.undecided().count();
    let bugs: Vec<_> = doc.real_bugs().collect();
    let quarantined: Vec<&Quarantined> =
        doc.quarantine.iter().filter(|q| now < q.ends_at).collect();
    let mut findings: Vec<Finding> = Vec::new();
    for item in &bugs {
        let line = item
            .decision
            .as_ref()
            .map(|d| d.line.clone())
            .unwrap_or_default();
        findings.push(Finding {
            kind: "code-wrong".into(),
            test: item.name.clone(),
            file: item.file.clone(),
            line: one_line(
                &format!(
                    "{} fails because the code is wrong: {}",
                    item.name,
                    if line.is_empty() {
                        "see the fixer's report"
                    } else {
                        line.as_str()
                    }
                ),
                LINE_MAX,
            ),
        });
    }
    for q in &quarantined {
        findings.push(Finding {
            kind: "quarantined".into(),
            test: q.name.clone(),
            file: q.file.clone(),
            line: one_line(
                &format!(
                    "{} is flaky and quarantined until {}: {}",
                    q.name,
                    fixer::date_of(q.ends_at),
                    q.reason
                ),
                LINE_MAX,
            ),
        });
    }
    for q in expired {
        findings.push(Finding {
            kind: "quarantine-expired".into(),
            test: q.name.clone(),
            file: q.file.clone(),
            line: one_line(
                &format!(
                    "{} was quarantined until {} and is back: it runs and can block again",
                    q.name,
                    fixer::date_of(q.ends_at)
                ),
                LINE_MAX,
            ),
        });
    }
    let step = if waiting > 0 {
        Step::new(
            STEP,
            Outcome::CouldNotRun,
            format!("Sorting {}", tests_word(waiting)),
        )
    } else if bugs.is_empty() && quarantined.is_empty() {
        Step::new(
            STEP,
            Outcome::Passed,
            "no failing tests are waiting to be sorted",
        )
    } else {
        let mut parts: Vec<String> = Vec::new();
        if !bugs.is_empty() {
            parts.push(format!("{} named as a real bug", tests_word(bugs.len())));
        }
        if !quarantined.is_empty() {
            parts.push(format!("{} quarantined", tests_word(quarantined.len())));
        }
        Step::new(
            STEP,
            Outcome::Passed,
            format!(
                "nothing is waiting to be sorted; {} (listed as findings)",
                parts.join(", ")
            ),
        )
    };
    DebtStage {
        stage: Stage::one(step),
        findings,
    }
}

/// The step and findings for a project, taking the expired quarantine entries off the document in the same write. A document that
/// can't be read or written is never a pass.
pub fn stage_in(dir: &Path, project: &str, now: u64) -> DebtStage {
    match store::update(dir, project, |doc| {
        let expired = doc.take_expired(now);
        (expired, doc.clone())
    }) {
        Ok((expired, doc)) => stage_of(&doc, &expired, now),
        Err(why) => DebtStage {
            stage: Stage::one(Step::new(
                STEP,
                Outcome::CouldNotRun,
                format!("the list of failing tests could not be read: {why}"),
            )),
            findings: Vec::new(),
        },
    }
}

// ---- after the run: the fixer, and what to put to the person ----------------------------------------------------------------

/// The one test fixer task to start. The webview starts it as a normal worker task, through the same path as `delegate_task`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixerRequest {
    /// The request id it starts under: a retry is the same task.
    pub token: String,
    pub title: String,
    pub brief: String,
    pub goal: String,
    pub count: usize,
}

/// A real bug to put to the person, once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugAsk {
    pub key: String,
    pub test: String,
    pub file: String,
    pub line: String,
}

/// A test that broke too often and caught nothing: rewrite it or delete it, put to the person once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalAsk {
    pub id: String,
    pub test: String,
    pub broke: u32,
}

/// What a ship check run says follows from the list. It only says what is due: the fixer slot is claimed by the call that starts the
/// task (`claim_fixer_in`), so a ship check run from a card, which starts nothing, claims nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Follow {
    /// The list has tests still to sort.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub fixer_due: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bugs: Vec<BugAsk>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub proposals: Vec<ProposalAsk>,
}

impl Follow {
    pub fn is_empty(&self) -> bool {
        !self.fixer_due && self.bugs.is_empty() && self.proposals.is_empty()
    }
}

/// What is due after a ship check: a fixer for the tests still to sort, the real bugs not yet put to the person, and the tests that
/// broke five times and caught nothing. Reads only: nothing is claimed here.
pub fn follow_up_in(dir: &Path, project: &str) -> Follow {
    let doc = store::read(dir, project);
    let mut follow = Follow {
        fixer_due: doc.undecided().next().is_some(),
        ..Follow::default()
    };
    for item in doc.bugs_to_file() {
        follow.bugs.push(BugAsk {
            key: Doc::bug_key(item),
            test: item.name.clone(),
            file: item.file.clone(),
            line: item
                .decision
                .as_ref()
                .map(|d| d.line.clone())
                .unwrap_or_default(),
        });
    }
    for due in doc.proposals_due() {
        follow.proposals.push(ProposalAsk {
            id: due.id,
            test: due.name,
            broke: due.broke,
        });
    }
    follow
}

/// Claims the project's one fixer slot and builds the task: the brief, from the list. `None` when no test waits, or a fixer already
/// holds the project (its task is open, or its start is still on its way). `row_of` says what the delegation rows say about the
/// holder. The claim is made under the document's lock: two ship checks at once, or two windows, never both get a task.
pub fn claim_fixer_in(
    dir: &Path,
    project: &str,
    main: &Path,
    head: &str,
    now: u64,
    row_of: &dyn Fn(Option<&Fixer>) -> Row,
) -> Option<FixerRequest> {
    let doc = store::read(dir, project);
    doc.undecided().next()?;
    let seen_token = doc.fixer.as_ref().map(|f| f.token.clone());
    let row = row_of(doc.fixer.as_ref());
    if doc.fixer_held(row, now) {
        return None;
    }
    let tracked = tracked_files(main);
    let request = fixer::build(&doc, &|item| {
        fixer::commits_since(
            main,
            &item.first_commit,
            &fixer::history_files(item, &tracked),
        )
    })?;
    let token = format!("test-fixer-{}-{now}", &head[..head.len().min(7)]);
    let claimed = store::update(dir, project, |doc| {
        // Only if nothing moved since it was read: the same holder (or none) and the same tests first in line.
        if doc.fixer.as_ref().map(|f| f.token.clone()) != seen_token {
            return false;
        }
        // The brief holds the first of these that fit, so the same tests are still first in line when it starts with them.
        let same: Vec<String> = fixer::pick(doc).into_iter().map(|item| item.id).collect();
        if !same.starts_with(&request.ids) {
            return false;
        }
        matches!(
            doc.claim_fixer(&token, head, request.ids.clone(), row, now),
            FixerClaim::Claimed
        )
    })
    .unwrap_or(false);
    claimed.then_some(FixerRequest {
        token,
        title: request.title,
        brief: request.brief,
        goal: request.goal,
        count: request.ids.len(),
    })
}

/// The files the repository tracks (at most 200,000), for finding a test's source file and for telling a deleted test from a passing one.
pub fn tracked_files(main: &Path) -> Vec<String> {
    match crate::firstmate::gates::git(main, &["ls-files", "-z"]) {
        Ok((true, out, _)) => String::from_utf8_lossy(&out)
            .split('\0')
            .filter(|path| !path.is_empty())
            .take(200_000)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// A check's log, from its end, at most `LOG_MAX` bytes. A plain file only.
pub fn read_log(path: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    // A plain file, never a link: a link to a pipe would be waited on for ever.
    if !crate::test_debt::gate::plain_file(Path::new(path)) {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if meta.len() > LOG_MAX {
        file.seek(SeekFrom::Start(meta.len() - LOG_MAX)).ok()?;
    }
    let mut bytes = Vec::new();
    file.take(LOG_MAX).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// What the delegation rows say about the fixer that holds the project: open while its task works (or asks), settled once it ended,
/// missing while its start is still on its way. A store that can't be read is "open": a second fixer is never started on a guess.
pub fn fixer_row(app: &tauri::AppHandle, fixer: Option<&Fixer>) -> Row {
    use tauri::Manager;
    let Some(fixer) = fixer else {
        return Row::Settled;
    };
    let store = app.state::<crate::session_store::SessionStore>();
    let rows = match store.lock_conn().and_then(|conn| {
        crate::delegations::recent(&conn, (fixer.claimed_at as i64).saturating_sub(60_000))
    }) {
        Ok(rows) => rows,
        // The rows can't be read: never start a second fixer on a guess.
        Err(_) => return Row::Open,
    };
    row_of(&rows, fixer)
}

/// What the delegation rows say about the fixer's task, found by the child session recorded when it started, or (when that was not
/// recorded: it finished first, or the recording failed) by the request id it started under: `app-<chat>-<token>`.
///
/// Open while the task works or asks, while its report is still owed, and while it has finished but its gates have not said yet (a
/// row that reads completed with no verdict, or a pending one): its decisions are applied when that verdict passes, and a second
/// fixer started in that window would take the slot and drop them.
pub fn row_of(rows: &[crate::delegations::Delegation], fixer: &Fixer) -> Row {
    use crate::delegations::{COMPLETED, PENDING, QUESTION, RUNNING};
    let suffix = format!("-{}", fixer.token);
    let mut seen = false;
    for row in rows {
        let known = !fixer.child_session.is_empty() && row.child_session == fixer.child_session;
        if !known && !row.child_session.ends_with(&suffix) {
            continue;
        }
        seen = true;
        let working = row.state == RUNNING || row.state == QUESTION;
        let owed = row.delivery == PENDING || row.delivery == "queued";
        let gating =
            row.state == COMPLETED && matches!(row.gate_verdict.as_deref(), None | Some("pending"));
        if working || owed || gating {
            return Row::Open;
        }
    }
    if seen {
        Row::Settled
    } else {
        Row::Missing
    }
}

/// Whether no failing test waits to be sorted for this project now. A list that can't be read is not quiet: never a pass on a guess.
pub fn quiet_in(data: &Path, project: &str) -> bool {
    match store::read_checked(data, project) {
        Ok(doc) => doc.undecided().next().is_none(),
        Err(_) => false,
    }
}

/// A record returned for a range nothing landed in is the earlier one, as it was: it must not read as passed over a list that has
/// tests waiting to be sorted now (or one that can't be read). The copy handed back changes, never what is on disk.
pub fn hold_if_waiting(record: &mut super::ShipCheckRecord, data: &Path, project: &str) {
    if record.outcome != Outcome::Passed {
        return;
    }
    let line = match store::read_checked(data, project) {
        Ok(doc) => {
            let waiting = doc.undecided().count();
            if waiting == 0 {
                return;
            }
            format!("Sorting {}", tests_word(waiting))
        }
        Err(why) => why,
    };
    record.outcome = Outcome::CouldNotRun;
    record
        .steps
        .push(Step::new(STEP, Outcome::CouldNotRun, &line));
    record
        .not_tested
        .push(one_line(&format!("{STEP} could not run: {line}"), LINE_MAX));
}

/// Whether the project tests "at ship": the only mode the list is for. In `light` and `full` every task is tested and a failing test
/// is the task's to fix; `off` tests nothing. The ship check reads the list only here.
pub fn is_at_ship(app: &tauri::AppHandle, main: &Path) -> bool {
    use tauri::Manager;
    match app
        .state::<crate::session_store::SessionStore>()
        .lock_conn()
    {
        Ok(conn) => {
            crate::delivery::settings::testing_mode_for(&conn, &crate::fs::path_to_js(main))
                == crate::delivery::settings::TestingMode::AtShip
        }
        // A store that can't be read gets the default, as every other reader of the mode does.
        Err(_) => {
            crate::delivery::settings::TestingMode::default()
                == crate::delivery::settings::TestingMode::AtShip
        }
    }
}

#[cfg(test)]
mod tests;
