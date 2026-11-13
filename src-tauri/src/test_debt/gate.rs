//! PT-5: a finished task's gate, in `at-ship` mode: read the failing tests its runs and `run_checks` records show, put the ones that
//! are not its own on the project's test debt list, take off the list what its runs show green, and hand `firstmate::gates` the
//! plan (`divert::Plan`) that drops or adds the failed-check gaps. Light and Full never come here: they test each task.
//!
//! Also here: reading the test fixer's report when its task passes (`fixer_report`).

use std::path::Path;

use crate::firstmate::fact_gaps::FactRun;
use crate::run_checks::{self, Record, AFFECTED_ID};
use crate::test_summary::{self, TestOutcome};

use super::divert::{self, Evidence, Plan};
use super::doc::{Candidate, Doc, Item, Noted};
use super::{fixer, own, store};

/// The most tracked files listed. A repository with more is not read well enough to say whose a failing test is, so a task in it is
/// judged as it was before the list existed: nothing is diverted and every failed check counts.
const TRACKED_MAX: usize = 200_000;
/// The most of a log or a source file read.
const READ_MAX: u64 = 2 * 1024 * 1024;

pub struct Input<'a> {
    pub data_dir: &'a Path,
    /// The project's main checkout, as the ship check names it.
    pub project: &'a str,
    pub delegation_id: &'a str,
    pub task_title: &'a str,
    /// The task's own copy.
    pub checkout: &'a Path,
    /// The paths the copy changed, checkout-relative.
    pub changed: &'a [String],
    /// The transcript's test runs.
    pub runs: &'a [FactRun],
    pub now: u64,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub plan: Plan,
    /// Tests that joined the list this time.
    pub listed: usize,
    /// Tests that did not, because the list is full.
    #[cfg_attr(not(test), allow(dead_code))]
    // the plan already says what it means (no gap is let off); the tests read the count
    pub full: usize,
    /// Tests that left the list: they ran green.
    pub cleared: usize,
}

fn tracked_files(checkout: &Path) -> Vec<String> {
    match crate::firstmate::gates::git(checkout, &["ls-files", "-z"]) {
        Ok((true, out, _)) => String::from_utf8_lossy(&out)
            .split('\0')
            .filter(|path| !path.is_empty())
            .take(TRACKED_MAX)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn head_of(checkout: &Path) -> String {
    match crate::firstmate::gates::git(checkout, &["rev-parse", "--verify", "-q", "HEAD"]) {
        Ok((true, out, _)) => {
            let text = String::from_utf8_lossy(&out).trim().to_string();
            if (7..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit()) {
                text
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// Whether `path` is a plain file and not a link, checked before it is opened: opening a committed link to a pipe would wait on it
/// for ever.
pub(crate) fn plain_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

/// A file's text, lossy, at most `READ_MAX` bytes of its start.
fn read_text(path: &Path) -> Option<String> {
    use std::io::Read;
    if !plain_file(path) {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(READ_MAX).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// A log's text, from its end (the summary is there). Only a plain file inside the owner's own folder: a record is read from disk,
/// so the path it names is not taken on its word.
fn read_log(owner_dir: &Path, log: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = Path::new(log);
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
        || path.parent() != Some(owner_dir)
    {
        return None;
    }
    if !plain_file(path) {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if meta.len() > READ_MAX {
        file.seek(SeekFrom::Start(meta.len() - READ_MAX)).ok()?;
    }
    let mut bytes = Vec::new();
    file.take(READ_MAX).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// A run that went green, and what it covered.
struct Green {
    command: String,
    /// A `run_checks` record's time (epoch ms) and the files its run was scoped to; none for a transcript's run.
    record: Option<(u64, Vec<String>)>,
}

fn greens(records: &[Record], runs: &[FactRun]) -> Vec<Green> {
    let mut out = Vec::new();
    let mut last: Vec<&Record> = Vec::new();
    for record in records {
        last.retain(|earlier| earlier.command != record.command);
        last.push(record);
    }
    for record in last {
        if record.outcome == TestOutcome::Green {
            out.push(Green {
                command: record.command.clone(),
                record: Some((record.at, record.changed_files.clone())),
            });
        }
    }
    let mut latest: Vec<&FactRun> = Vec::new();
    for run in runs {
        latest.retain(|earlier| earlier.command.trim() != run.command.trim());
        latest.push(run);
    }
    for run in latest {
        // Green by its last summary, and no failure named anywhere in the output: a green line after a red one is not a green run.
        if test_summary::classify(&run.output).outcome == TestOutcome::Green
            && test_summary::failures(&run.output).is_empty()
        {
            out.push(Green {
                command: run.command.trim().to_string(),
                record: None,
            });
        }
    }
    out
}

/// Whether a green run shows this listed test passing: the same command ran green after the test first failed, and (for the
/// project's scoped `affected` run) its changed files include the test's file or a file the test covers. Never on a guess.
fn covers(green: &Green, item: &Item) -> bool {
    match &green.record {
        None => !item.command.is_empty() && item.command.trim() == green.command,
        Some((at, scope)) => {
            if *at <= item.first_seen_at {
                return false;
            }
            if green.command == AFFECTED_ID {
                !item.file.is_empty()
                    && scope.iter().any(|path| {
                        own::same_file(&item.file, path) || own::covers(&item.file, path)
                    })
            } else {
                !item.command.is_empty() && item.command == green.command
            }
        }
    }
}

/// Reads one finished task's evidence, updates the project's list, and returns the plan the gate applies. An error from the disk
/// comes back: the caller then leaves the round as it was (the task fails for what it fails for today), it never guesses.
pub fn at_ship(input: &Input) -> Result<Outcome, String> {
    let tracked = tracked_files(input.checkout);
    if tracked.len() >= TRACKED_MAX {
        return Ok(Outcome::default());
    }
    let head = head_of(input.checkout);
    let owner_dir = run_checks::owner_dir(input.data_dir, input.delegation_id);
    let records = run_checks::records(input.data_dir, input.delegation_id);
    let before = store::read(input.data_dir, input.project);
    let now = input.now;
    let quarantined = |id: &str| before.quarantined(id, now);
    let read_file = |path: &str| -> Option<String> {
        // Only a file the repository tracks, read from the task's own copy.
        let tracked_path = own::resolve_tracked(path, &tracked)?;
        read_text(&input.checkout.join(tracked_path))
    };
    let read_log_of = |log: &str| read_log(&owner_dir, log);
    let plan = divert::plan(&Evidence {
        runs: input.runs,
        records: &records,
        changed: input.changed,
        tracked: &tracked,
        read_log: &read_log_of,
        read_file: &read_file,
        quarantined: &quarantined,
    });
    let green = greens(&records, input.runs);
    let foreign = plan.foreign.clone();
    let (listed, full, cleared) = store::update(input.data_dir, input.project, |doc| {
        let mut listed = 0;
        let mut full = 0;
        for f in &foreign {
            let noted = doc.note_failure(
                &Candidate {
                    runner: f.runner.clone(),
                    file: f.file.clone(),
                    name: f.name.clone(),
                    failure: f.message.clone(),
                    command: f.command.clone(),
                    first_commit: head.clone(),
                    delegation_id: input.delegation_id.to_string(),
                    task_title: input.task_title.to_string(),
                },
                now,
            );
            match noted {
                Noted::Added => listed += 1,
                Noted::Full => full += 1,
                Noted::Seen | Noted::Quarantined => {}
            }
        }
        // A command that went green because its test was deleted fixed nothing: the item leaves, and no bug is credited as caught.
        let tracked_now: std::collections::HashSet<String> =
            tracked.iter().map(|p| own::norm(p)).collect();
        let cleared = doc
            .remove_green_with(
                |item| green.iter().any(|g| covers(g, item)),
                |item| {
                    item.file.is_empty()
                        || tracked_now.contains(&own::norm(&item.file))
                        || tracked_now.is_empty()
                },
            )
            .len();
        (listed, full, cleared)
    })?;
    let mut plan = plan;
    if full > 0 {
        // The list is full: a failure that could not be listed is not let off, so the task fails for it as it did before.
        plan.clear_gaps.clear();
    }
    Ok(Outcome {
        plan,
        listed,
        full,
        cleared,
    })
}

/// The test fixer's report, once its task has passed its gate: its `Decision <n>` lines are applied to the list and the slot is
/// freed. Nothing happens for any other task. Returns what was applied, or `None` when this task is not the fixer.
pub fn fixer_report(
    data_dir: &Path,
    project: &str,
    child_session: &str,
    report: &str,
    now: u64,
) -> Result<Option<fixer::Applied>, String> {
    // Cheap first: most tasks are not the fixer, and nothing is written for them.
    let doc = store::read(data_dir, project);
    if !doc.is_fixer(child_session) {
        return Ok(None);
    }
    let reported = fixer::parse_report(report);
    store::update(data_dir, project, |doc: &mut Doc| {
        let held = doc.fixer_done(child_session)?;
        Some(fixer::apply_report(doc, &held.items, &reported, now))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_debt::doc::DecisionKind;
    use crate::test_debt::testing::Temp;

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    /// A repository with a few tracked files, one commit.
    fn repo() -> Temp {
        let dir = Temp::new();
        git(dir.path(), &["init", "-q"]);
        for file in [
            "src/a.ts",
            "src/a.test.ts",
            "src/other.test.ts",
            "src/feature.ts",
        ] {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "export {}\n").unwrap();
        }
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-q", "-m", "first"]);
        dir
    }

    const FAIL_OTHER: &str = " FAIL  src/other.test.ts > suite > works\nAssertionError: expected 1 to be 2\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";
    const FAIL_A: &str = " FAIL  src/a.test.ts > suite > works\nAssertionError: expected 1 to be 2\n\u{23af}\u{23af}\u{23af}\u{23af}\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";
    const GREEN: &str = " Test Files  3 passed (3)\n      Tests  9 passed (9)\n";

    fn run(command: &str, output: &str) -> FactRun {
        FactRun {
            command: command.into(),
            at: 1.0,
            output: output.into(),
        }
    }

    fn go(
        data: &Temp,
        checkout: &Temp,
        changed: &[&str],
        runs: &[FactRun],
        title: &str,
        now: u64,
    ) -> Outcome {
        let changed: Vec<String> = changed.iter().map(|s| (*s).to_string()).collect();
        at_ship(&Input {
            data_dir: data.path(),
            project: "/projects/tally",
            delegation_id: "d1",
            task_title: title,
            checkout: checkout.path(),
            changed: &changed,
            runs,
            now,
        })
        .unwrap()
    }

    #[test]
    fn a_failing_test_that_is_not_the_tasks_own_joins_the_list_with_its_commit_and_task() {
        let (data, checkout) = (Temp::new(), repo());
        let out = go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "Add totals",
            1_000,
        );
        assert_eq!(out.listed, 1);
        let doc = store::read(data.path(), "/projects/tally");
        assert_eq!(doc.items.len(), 1);
        let item = &doc.items[0];
        assert_eq!(item.file, "src/other.test.ts");
        assert_eq!(item.task_title, "Add totals");
        assert_eq!(item.delegation_id, "d1");
        assert!(
            item.first_commit.len() >= 7,
            "the worker copy's HEAD: {}",
            item.first_commit
        );
        assert!(item.failure.contains("AssertionError"));
        assert_eq!(item.command, "npx vitest run");
        // The task is not failed for it: its gap is dropped.
        assert_eq!(out.plan.clear_gaps.len(), 1);
    }

    #[test]
    fn a_task_that_changed_src_a_ts_is_not_let_off_for_a_failing_a_test_ts() {
        let (data, checkout) = (Temp::new(), repo());
        let out = go(
            &data,
            &checkout,
            &["src/a.ts"],
            &[run("npx vitest run", FAIL_A)],
            "Edit a",
            1_000,
        );
        assert_eq!(out.plan.own.len(), 1);
        assert!(
            out.plan.clear_gaps.is_empty(),
            "the failed-check gap stays: the round fails"
        );
        assert_eq!(out.listed, 0);
        assert!(
            store::read(data.path(), "/projects/tally").items.is_empty(),
            "its own test is never listed"
        );
    }

    #[test]
    fn the_same_failure_seen_by_a_second_task_is_one_item_seen_twice() {
        let (data, checkout) = (Temp::new(), repo());
        go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "First",
            1_000,
        );
        let again = go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "Second",
            2_000,
        );
        assert_eq!(again.listed, 0);
        let doc = store::read(data.path(), "/projects/tally");
        assert_eq!(doc.items.len(), 1);
        assert_eq!(doc.items[0].seen_count, 2);
        assert_eq!(
            doc.items[0].task_title, "First",
            "the first sighting is kept"
        );
    }

    #[test]
    fn a_green_run_of_the_same_command_takes_the_test_off_the_list() {
        let (data, checkout) = (Temp::new(), repo());
        go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "First",
            1_000,
        );
        let out = go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", GREEN)],
            "Second",
            2_000,
        );
        assert_eq!(out.cleared, 1);
        assert!(store::read(data.path(), "/projects/tally").items.is_empty());
        // A green run of another command proves nothing about it.
        go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "Third",
            3_000,
        );
        let out = go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run src/elsewhere.test.ts", GREEN)],
            "Fourth",
            4_000,
        );
        assert_eq!(out.cleared, 0);
        assert_eq!(store::read(data.path(), "/projects/tally").items.len(), 1);
    }

    #[test]
    fn a_quarantined_test_is_neither_listed_nor_a_reason_to_send_the_task_back() {
        let (data, checkout) = (Temp::new(), repo());
        go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "First",
            1_000,
        );
        store::update(data.path(), "/projects/tally", |doc| {
            let id = doc.items[0].id.clone();
            doc.mark_flaky(&id, "passes on a re-run", 1_500);
        })
        .unwrap();
        let out = go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "Second",
            2_000,
        );
        assert_eq!(out.plan.quarantined.len(), 1);
        assert_eq!(out.plan.clear_gaps.len(), 1);
        assert!(store::read(data.path(), "/projects/tally").items.is_empty());
    }

    #[test]
    fn a_run_checks_record_with_a_foreign_failure_lists_it_and_one_with_an_own_failure_fails_the_round(
    ) {
        let (data, checkout) = (Temp::new(), repo());
        let dir = run_checks::owner_dir(data.path(), "d1");
        std::fs::create_dir_all(&dir).unwrap();
        let record = |failing: &str, at: u64| Record {
            at,
            command: "affected".into(),
            outcome: TestOutcome::Red,
            total: 3,
            failed: 1,
            changed_files_fingerprint: String::new(),
            changed_files: vec!["src/a.ts".into()],
            failing: vec![failing.into()],
            log: String::new(),
        };
        let line =
            serde_json::to_string(&record("src/other.test.ts > suite > works", 500)).unwrap();
        std::fs::write(dir.join("records.jsonl"), format!("{line}\n")).unwrap();
        let out = go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[],
            "Edit feature",
            1_000,
        );
        assert_eq!(out.listed, 1);
        assert!(out.plan.add_gaps.is_empty());
        // Now the same record is the task's own: it changed src/a.ts and src/a.test.ts failed.
        let own_line =
            serde_json::to_string(&record("src/a.test.ts > suite > works", 600)).unwrap();
        std::fs::write(dir.join("records.jsonl"), format!("{own_line}\n")).unwrap();
        let out = go(&data, &checkout, &["src/a.ts"], &[], "Edit a", 2_000);
        assert_eq!(out.plan.add_gaps.len(), 1);
        assert_eq!(
            store::read(data.path(), "/projects/tally").items.len(),
            1,
            "only the foreign one is listed"
        );
    }

    #[test]
    fn a_green_summary_after_a_red_one_in_the_same_output_clears_nothing() {
        let (data, checkout) = (Temp::new(), repo());
        go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "First",
            1_000,
        );
        let chained = format!("{FAIL_OTHER}{GREEN}");
        let out = go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", &chained)],
            "Second",
            2_000,
        );
        assert_eq!(
            out.cleared, 0,
            "a red line in the output is not a green run"
        );
        assert_eq!(store::read(data.path(), "/projects/tally").items.len(), 1);
    }

    #[test]
    fn a_full_list_lets_no_failure_off_so_the_task_fails_for_it_as_before() {
        let (data, checkout) = (Temp::new(), repo());
        store::update(data.path(), "/projects/tally", |doc| {
            for n in 0..crate::test_debt::doc::ITEMS_MAX {
                doc.note_failure(
                    &Candidate {
                        runner: "vitest".into(),
                        file: "src/old.test.ts".into(),
                        name: format!("old {n}"),
                        ..Candidate::default()
                    },
                    1,
                );
            }
        })
        .unwrap();
        let out = go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "Task",
            1_000,
        );
        assert_eq!(out.full, 1);
        assert_eq!(out.listed, 0);
        assert!(
            out.plan.clear_gaps.is_empty(),
            "a failure that could not be listed is not let off"
        );
    }

    #[test]
    fn a_green_run_because_the_test_was_deleted_is_not_a_bug_caught() {
        let (data, checkout) = (Temp::new(), repo());
        go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "First",
            1_000,
        );
        store::update(data.path(), "/projects/tally", |doc| {
            let id = doc.items[0].id.clone();
            doc.mark_code_wrong(&id, "real", 1_100);
        })
        .unwrap();
        // The test file is deleted and committed, and the command goes green.
        git(checkout.path(), &["rm", "-q", "src/other.test.ts"]);
        git(checkout.path(), &["commit", "-q", "-m", "drop it"]);
        let out = go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", GREEN)],
            "Second",
            2_000,
        );
        assert_eq!(out.cleared, 1);
        let doc = store::read(data.path(), "/projects/tally");
        assert!(doc.items.is_empty());
        assert_eq!(doc.score[0].caught, 0, "a deleted test caught nothing");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_never_opened_as_a_file() {
        let dir = Temp::new();
        let target = dir.path().join("real.txt");
        std::fs::write(&target, "x").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(plain_file(&target));
        assert!(!plain_file(&link));
        assert!(!plain_file(&dir.path().join("missing")));
        assert!(!plain_file(dir.path()), "a folder is not a file");
        assert!(read_text(&link).is_none());
    }

    #[test]
    fn a_log_outside_the_tasks_own_folder_is_never_read() {
        let owner = Path::new("/data/run-checks/d1");
        assert!(read_log(owner, "/etc/passwd").is_none());
        assert!(read_log(owner, "/data/run-checks/d1/../d2/x.log").is_none());
        assert!(read_log(owner, "/data/run-checks/d2/x.log").is_none());
    }

    #[test]
    fn a_checkout_that_is_not_a_repository_still_works_with_no_tracked_files() {
        let (data, plain) = (Temp::new(), Temp::new());
        let out = go(
            &data,
            &plain,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "Task",
            1_000,
        );
        // The test file's path is as the runner printed it, so it is still sorted: foreign here.
        assert_eq!(out.listed, 1);
        assert_eq!(
            store::read(data.path(), "/projects/tally").items[0].first_commit,
            ""
        );
    }

    #[test]
    fn the_fixers_report_is_applied_once_and_only_for_the_fixer() {
        let (data, checkout) = (Temp::new(), repo());
        go(
            &data,
            &checkout,
            &["src/feature.ts"],
            &[run("npx vitest run", FAIL_OTHER)],
            "First",
            1_000,
        );
        let id = store::read(data.path(), "/projects/tally").items[0]
            .id
            .clone();
        store::update(data.path(), "/projects/tally", |doc| {
            doc.claim_fixer(
                "tok",
                "h",
                vec![id.clone()],
                crate::test_debt::doc::Row::Missing,
                1_100,
            );
            doc.fixer_started("tok", "app-1-tok");
        })
        .unwrap();
        // Another task's report changes nothing.
        let other = fixer_report(
            data.path(),
            "/projects/tally",
            "app-1-other",
            "Decision 1: flaky | x",
            1_200,
        )
        .unwrap();
        assert!(other.is_none());
        assert_eq!(store::read(data.path(), "/projects/tally").items.len(), 1);
        let applied = fixer_report(
            data.path(),
            "/projects/tally",
            "app-1-tok",
            "Decision 1: code is wrong | the total ignores tax: src/other.test.ts fails",
            1_300,
        )
        .unwrap()
        .expect("the fixer's report");
        assert_eq!(applied.code_wrong, vec![id.clone()]);
        let doc = store::read(data.path(), "/projects/tally");
        assert_eq!(
            doc.items[0].decision.as_ref().unwrap().kind,
            DecisionKind::CodeWrong
        );
        assert!(doc.fixer.is_none(), "the slot is free");
        // A second reading of the same report applies nothing.
        let again = fixer_report(
            data.path(),
            "/projects/tally",
            "app-1-tok",
            "Decision 1: flaky | x",
            1_400,
        )
        .unwrap();
        assert!(again.is_none());
    }
}
