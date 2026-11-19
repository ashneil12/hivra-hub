//! SC-7: the `run_checks` tool, the app's side (the tool is in `run_checks/mcp.rs`; `agentAppRunChecks.ts` answers it).
//!
//! A worker (or a first mate) calls it to run "this project's tests for what changed". It replaces the worker rule
//! "never paste test output" with a tool that does the trimming itself: the full output goes to a log file in the app's
//! data folder, and what the caller gets back is the runner's own summary line, each failing test with the first lines of
//! its message, the counts, the log's path and one word, `outcome`:
//!
//! - `red`: a summary line shows more than zero tests and more than zero failures;
//! - `green`: more than zero tests and zero failures;
//! - `inconclusive`: anything else (no summary line, zero tests, a build error before the tests ran, a timeout, a command
//!   that could not start). Never the exit code (`test_summary::classify`).
//!
//! The command comes from the project's own file (`.monocode/project.json`, imported by the person), never from the
//! caller: a declared check or action by its id (or its exact command), else the project's `affected` check or action,
//! else its declared checks for the folders the copy changed, else the `check` action, else a refusal in plain words. It
//! runs in the worker's own checkout through the runner the gates use (`verify_stage::run_check`: its own process group,
//! a timeout, a scrubbed environment, the agent sandbox).
//!
//! Every run is also a fact for the gates, written here by the app and never by the worker: one line in
//! `<app data>/run-checks/<delegation or chat id>/records.jsonl` (`Record`), read by the "no red before the fix" gap
//! (`firstmate::fact_gaps`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::project_file::{ProjectAction, ProjectFile, VerifyCheck};
use crate::test_summary::{self, Classified, Failure, TestOutcome};

pub mod mcp;

/// The most failing tests returned; the rest are counted in `more_failures`.
pub const MAX_FAILURES: usize = 20;
/// The id a project gives its affected-tests command (a verify check, or an action).
pub const AFFECTED_ID: &str = "affected";
/// What a project with no test command is told.
pub const NO_COMMAND: &str =
    "This project declares no test command. Run its tests yourself and say so in your report.";
/// The folder under the app's data folder that holds the logs and the records.
pub const FOLDER: &str = "run-checks";
/// The most of a log read back (its tail, where the summary is).
pub const MAX_LOG_READ: u64 = 16 * 1024 * 1024;
/// The most records read for one owner (the newest).
pub const MAX_RECORDS: usize = 400;
/// The most changed paths a record or the command's environment names.
pub const MAX_PATHS: usize = 300;

/// One command to run: a declared check, or an action of the project's file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub id: String,
    pub name: String,
    pub command: String,
    pub timeout_seconds: u64,
}

/// How a run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ended {
    /// It ran to its end (any exit code: the text decides).
    Finished,
    /// It was stopped after its timeout. Not a verdict.
    TimedOut,
    /// It was stopped before it finished. Not a verdict.
    Stopped,
    /// It could not start, in plain words.
    NotStarted(String),
}

/// What a run printed and how it ended.
#[derive(Clone, Debug)]
pub struct Finished {
    pub output: String,
    pub ended: Ended,
}

/// The part that needs the app (`AppRunner`), or a fake in tests.
pub trait CheckRunner {
    fn run(&self, step: &Step, env: &[(String, String)]) -> Finished;
}

/// What one call asks.
pub struct Request<'a> {
    pub file: &'a ProjectFile,
    /// A check or action id, or a declared command's exact text.
    pub requested: Option<&'a str>,
    /// The paths the copy changed (from git), or the ones the caller named.
    pub changed: Vec<String>,
    /// The delegation id of a worker, else the chat's id. Names the records' folder.
    pub owner: &'a str,
    pub data_dir: &'a Path,
    pub now_ms: u64,
    /// A fingerprint of the copy's files at the start of the run.
    pub fingerprint: String,
}

/// What the caller gets back.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub outcome: TestOutcome,
    /// The runner's own summary line (a one-line count for a runner that prints none).
    pub summary: String,
    pub total: u64,
    pub failed: u64,
    pub failures: Vec<Failure>,
    /// Failing tests past the cap that are not listed. The log has them.
    #[serde(skip_serializing_if = "is_zero")]
    pub more_failures: u64,
    /// The path of the full log.
    pub log: String,
    /// The ids of what ran.
    pub command: String,
    /// Why the run decides nothing, or what to do next. Only when there is something to say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

/// One run, kept for the gates.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Epoch milliseconds.
    pub at: u64,
    pub command: String,
    pub outcome: TestOutcome,
    pub total: u64,
    pub failed: u64,
    /// The copy's files, by content, when the run started (`firstmate::gates::tree_fingerprint`).
    pub changed_files_fingerprint: String,
    /// The paths the copy had changed when the run started: what the run could have seen.
    #[serde(default)]
    pub changed_files: Vec<String>,
    /// The failing tests' names (at most `MAX_FAILURES`).
    #[serde(default)]
    pub failing: Vec<String>,
    pub log: String,
}

// ---- picking the command ----------------------------------------------------------------------------------------------

fn step_of_check(check: &VerifyCheck) -> Step {
    Step {
        id: check.id.clone(),
        name: check.name.clone(),
        command: check.command.clone(),
        timeout_seconds: check.timeout_seconds(),
    }
}

/// An action is a test command unless it runs until stopped (a dev server).
fn step_of_action(action: &ProjectAction) -> Option<Step> {
    let timeout_seconds = action.timeout_seconds()?;
    Some(Step {
        id: action.id.clone(),
        name: action.name.clone(),
        command: action.command.clone(),
        timeout_seconds,
    })
}

/// A check or an action by its id, checks first.
fn by_id(file: &ProjectFile, id: &str) -> Option<Step> {
    file.verify
        .checks
        .iter()
        .find(|check| check.id == id)
        .map(step_of_check)
        .or_else(|| {
            file.actions
                .iter()
                .find(|action| action.id == id)
                .and_then(step_of_action)
        })
}

/// What the project declares: by id, or by the exact text of a declared command.
fn declared(file: &ProjectFile, want: &str) -> Option<Step> {
    by_id(file, want)
        .or_else(|| {
            file.verify
                .checks
                .iter()
                .find(|check| check.command.trim() == want)
                .map(step_of_check)
        })
        .or_else(|| {
            file.actions
                .iter()
                .find(|action| action.command.trim() == want)
                .and_then(step_of_action)
        })
}

/// The ids a caller may name, for the refusal that tells it.
fn declared_ids(file: &ProjectFile) -> Vec<String> {
    let mut ids: Vec<String> = file.verify.checks.iter().map(|c| c.id.clone()).collect();
    ids.extend(
        file.actions
            .iter()
            .filter(|action| step_of_action(action).is_some())
            .map(|action| action.id.clone()),
    );
    ids.dedup();
    ids
}

/// A caller's words, shown back to it: one line, no control characters, short.
fn shown(text: &str) -> String {
    let line: String = text.chars().filter(|c| !c.is_control()).take(80).collect();
    line.trim().to_string()
}

/// The commands to run: the one asked for when the project declares it, else its affected-tests command, else its
/// declared checks for the folders `changed` names (all of them when none matches), else its `check` action. A
/// project with none of these is refused in plain words. Nothing a caller types is ever run: only what the project's
/// own file declares.
pub fn pick(
    file: &ProjectFile,
    requested: Option<&str>,
    changed: &[String],
) -> Result<Vec<Step>, String> {
    if let Some(want) = requested.map(str::trim).filter(|want| !want.is_empty()) {
        return match declared(file, want) {
            Some(step) => Ok(vec![step]),
            None => {
                let ids = declared_ids(file);
                Err(if ids.is_empty() {
                    NO_COMMAND.to_string()
                } else {
                    format!(
                        "This project declares no test command called \"{}\". Its checks are: {}.",
                        shown(want),
                        ids.join(", ")
                    )
                })
            }
        };
    }
    if let Some(step) = by_id(file, AFFECTED_ID) {
        return Ok(vec![step]);
    }
    if !file.verify.checks.is_empty() {
        let touched: Vec<&VerifyCheck> = file
            .verify
            .checks
            .iter()
            .filter(|check| {
                changed.iter().any(|path| {
                    crate::verify_stage::in_folder(&path.replace('\\', "/"), check.dir())
                })
            })
            .collect();
        let chosen: Vec<&VerifyCheck> = if touched.is_empty() {
            file.verify.checks.iter().collect()
        } else {
            touched
        };
        return Ok(chosen.into_iter().map(step_of_check).collect());
    }
    file.actions
        .iter()
        .find(|action| action.id == "check")
        .and_then(step_of_action)
        .map(|step| vec![step])
        .ok_or_else(|| NO_COMMAND.to_string())
}

// ---- the folder: logs and records -------------------------------------------------------------------------------------

/// The folder name for an owner: the id itself when it is plain letters, digits, `-` and `_`, else a name made from its
/// hash. An id comes from a chat or another agent, so it never names a path itself.
fn owner_name(owner: &str) -> String {
    use sha2::{Digest, Sha256};
    let plain = !owner.is_empty()
        && owner.len() <= 100
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if plain {
        return owner.to_string();
    }
    let digest = Sha256::digest(owner.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("h~{hex}")
}

/// Where one owner's logs and records live: `<app data>/run-checks/<delegation or chat id>/`.
pub fn owner_dir(data_dir: &Path, owner: &str) -> PathBuf {
    data_dir.join(FOLDER).join(owner_name(owner))
}

const RECORDS_FILE: &str = "records.jsonl";
const RED_SEEN_FILE: &str = "red-seen";
/// The most of a records file read: its end, where the newest records are.
const MAX_RECORDS_READ: u64 = 4 * 1024 * 1024;
/// The logs kept per owner; older ones are removed when a run adds a new one.
pub const KEEP_LOGS: usize = 40;

/// A file's text, lossy; only its last `max` bytes when it is longer, without the line that cut starts in.
fn read_tail(path: &Path, max: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let cut = len > max;
    if cut {
        file.seek(SeekFrom::Start(len - max)).ok()?;
    }
    let mut bytes = Vec::new();
    file.take(max).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Some(if cut {
        text.split_once('\n')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default()
    } else {
        text
    })
}

/// Whether `name` is a log this module made: 13 digits, an optional `-N`, then `.log`.
fn is_log_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".log").filter(|stem| stem.is_ascii()) else {
        return false;
    };
    let (digits, rest) = stem.split_at(stem.len().min(13));
    digits.len() == 13
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (rest.is_empty()
            || rest
                .strip_prefix('-')
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
}

/// Removes the oldest logs of one owner beyond the newest `keep`. Only plain files this module named, listed from the
/// owner's own folder: a link, a folder or any other file there is left alone.
fn prune_logs(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let plain = entry.file_type().ok()?.is_file();
            (plain && is_log_name(&name) && entry.path().parent() == Some(dir))
                .then(|| (name, entry.path()))
        })
        .collect();
    logs.sort();
    let extra = logs.len().saturating_sub(keep);
    for (_, path) in logs.into_iter().take(extra) {
        let _ = std::fs::remove_file(path);
    }
}

/// The records of one owner, oldest first, at most the newest `MAX_RECORDS`. A line that does not read as a record
/// (another build's, a torn write, a hand edit) is skipped, and a list longer than it should be is cut.
pub fn records(data_dir: &Path, owner: &str) -> Vec<Record> {
    let Some(text) = read_tail(
        &owner_dir(data_dir, owner).join(RECORDS_FILE),
        MAX_RECORDS_READ,
    ) else {
        return Vec::new();
    };
    let mut kept: Vec<Record> = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Record>(line.trim()).ok())
        .map(|mut record| {
            record.changed_files.truncate(MAX_PATHS);
            record.failing.truncate(MAX_FAILURES);
            record
        })
        .collect();
    if kept.len() > MAX_RECORDS {
        kept.drain(..kept.len() - MAX_RECORDS);
    }
    kept
}

fn append_record(data_dir: &Path, owner: &str, record: &Record) -> Result<(), String> {
    use std::io::Write;
    let dir = owner_dir(data_dir, owner);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    line.push('\n');
    // One write of one whole line: two windows appending never mix their lines.
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(RECORDS_FILE))
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// Whether a round of this task already showed the failing run a bug fix needs (the gate wrote the mark).
pub fn red_seen(data_dir: &Path, owner: &str) -> bool {
    owner_dir(data_dir, owner).join(RED_SEEN_FILE).is_file()
}

/// The gate saw the failing run: a later round, whose transcript starts fresh, need not see it again.
pub fn mark_red_seen(data_dir: &Path, owner: &str) -> Result<(), String> {
    let dir = owner_dir(data_dir, owner);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(RED_SEEN_FILE), b"1").map_err(|e| e.to_string())
}

/// A new log file for this run: `<timestamp>.log`, and `<timestamp>-2.log` when two runs share a millisecond.
fn create_log(dir: &Path, now_ms: u64) -> Result<(PathBuf, std::fs::File), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for attempt in 1..=1000u32 {
        let name = if attempt == 1 {
            format!("{now_ms:013}.log")
        } else {
            format!("{now_ms:013}-{attempt}.log")
        };
        let path = dir.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("too many logs in one millisecond".into())
}

// ---- running it -------------------------------------------------------------------------------------------------------

/// The changed paths a caller may name or git reports, cleaned: no blank, no control character (a line break would end
/// one path and start another in the command's environment), at most `MAX_PATHS`.
fn clean_paths(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| {
            !path.trim().is_empty() && path.len() <= 1024 && !path.chars().any(char::is_control)
        })
        .take(MAX_PATHS)
        .cloned()
        .collect()
}

/// What one command's run says, with the words for an inconclusive one.
struct Part {
    step: Step,
    finished: Finished,
    classified: Classified,
    note: Option<String>,
}

fn part_of(step: &Step, finished: Finished) -> Part {
    let classified = match finished.ended {
        Ended::Finished => test_summary::classify(&finished.output),
        // A run that did not finish decides nothing, whatever it printed so far.
        _ => Classified {
            outcome: TestOutcome::Inconclusive,
            summary: None,
            line: String::new(),
            why: None,
        },
    };
    let note = match &finished.ended {
        Ended::TimedOut => Some(format!(
            "{} ran past its {} seconds and was stopped. That is not a pass or a failure: run it again, or run a narrower check.",
            step.name, step.timeout_seconds
        )),
        Ended::Stopped => Some(format!(
            "{} was stopped before it finished. That is not a pass or a failure: run it again.",
            step.name
        )),
        Ended::NotStarted(why) => Some(format!("{} could not start: {}", step.name, shown(why))),
        Ended::Finished => classified
            .why
            .map(|why| format!("{}: inconclusive, {why}.", step.name)),
    };
    Part {
        step: step.clone(),
        finished,
        classified,
        note,
    }
}

/// One outcome for the call: red when any command is red; inconclusive when any could not say (it did not finish, ran
/// zero tests, hit a build error); green when at least one is green and none of that; else inconclusive. A command with
/// no test summary at all (a type check, a lint) neither vetoes a green nor makes one.
fn combine(parts: &[Part]) -> TestOutcome {
    if parts
        .iter()
        .any(|part| part.classified.outcome == TestOutcome::Red)
    {
        return TestOutcome::Red;
    }
    let blocked = parts.iter().any(|part| {
        part.finished.ended != Ended::Finished
            || matches!(
                part.classified.why,
                Some(test_summary::WHY_ZERO_TESTS) | Some(test_summary::WHY_BUILD_ERROR)
            )
    });
    let green = parts
        .iter()
        .any(|part| part.classified.outcome == TestOutcome::Green);
    if green && !blocked {
        TestOutcome::Green
    } else {
        TestOutcome::Inconclusive
    }
}

/// The whole log: a single command's own output, or each command's under its name.
fn log_text(parts: &[Part]) -> String {
    if let [only] = parts {
        return only.finished.output.clone();
    }
    parts
        .iter()
        .map(|part| {
            format!(
                "=== {} ({}) ===\n{}\n",
                part.step.name, part.step.command, part.finished.output
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Run it, keep the log and the record, and say what happened. A refusal (nothing to run) makes no folder, no log and no
/// record. A log or record that cannot be written is said in the note and never fails the run.
pub fn run_with(request: &Request, runner: &dyn CheckRunner) -> Result<Report, String> {
    let changed = clean_paths(&request.changed);
    let steps = pick(request.file, request.requested, &changed)?;
    let env = vec![("MONOCODE_CHANGED_FILES".to_string(), changed.join("\n"))];
    let parts: Vec<Part> = steps
        .iter()
        .map(|step| part_of(step, runner.run(step, &env)))
        .collect();
    let outcome = combine(&parts);

    let mut failures: Vec<Failure> = parts
        .iter()
        .flat_map(|part| test_summary::failures(&part.finished.output))
        .collect();
    let more_failures = failures.len().saturating_sub(MAX_FAILURES) as u64;
    failures.truncate(MAX_FAILURES);
    let summary_lines: Vec<&str> = parts
        .iter()
        .map(|part| part.classified.line.as_str())
        .filter(|line| !line.is_empty())
        .collect();
    let (total, failed) = parts
        .iter()
        .filter_map(|part| part.classified.summary)
        .fold((0, 0), |(total, failed), s| {
            (total + s.total, failed + s.failed)
        });
    let mut notes: Vec<String> = parts.iter().filter_map(|part| part.note.clone()).collect();

    let dir = owner_dir(request.data_dir, request.owner);
    let log = match create_log(&dir, request.now_ms).and_then(|(path, mut file)| {
        use std::io::Write;
        file.write_all(log_text(&parts).as_bytes())
            .map(|_| path)
            .map_err(|e| e.to_string())
    }) {
        Ok(path) => {
            prune_logs(&dir, KEEP_LOGS);
            path.to_string_lossy().to_string()
        }
        Err(why) => {
            notes.push(format!(
                "The full log could not be saved ({}).",
                shown(&why)
            ));
            String::new()
        }
    };

    let command = parts
        .iter()
        .map(|part| part.step.id.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let record = Record {
        at: request.now_ms,
        command: command.clone(),
        outcome,
        total,
        failed,
        changed_files_fingerprint: request.fingerprint.clone(),
        changed_files: changed,
        failing: failures.iter().map(|f| f.name.clone()).collect(),
        log: log.clone(),
    };
    if let Err(why) = append_record(request.data_dir, request.owner, &record) {
        notes.push(format!("This run could not be recorded ({}).", shown(&why)));
    }
    Ok(Report {
        outcome,
        summary: summary_lines.join(" | "),
        total,
        failed,
        failures,
        more_failures,
        log,
        command,
        note: (!notes.is_empty()).then(|| notes.join(" ")),
    })
}

// ---- the app's side ---------------------------------------------------------------------------------------------------

/// The real runner: the same one the gates use (`verify_stage::run_check_in`), in the caller's own checkout. Its log is
/// read back (its tail, when it is huge) as the run's output.
pub struct AppRunner<'a> {
    pub app: &'a tauri::AppHandle,
    pub main: &'a Path,
    pub checkout: &'a Path,
}

/// The tail of a log file, lossy, with a line saying so when it was cut.
fn read_log(path: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut cut = false;
    if len > MAX_LOG_READ && file.seek(SeekFrom::Start(len - MAX_LOG_READ)).is_ok() {
        cut = true;
    }
    let mut bytes = Vec::new();
    let _ = file.take(MAX_LOG_READ).read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes);
    if cut {
        format!(
            "[The log was cut to its last {} MiB; the whole log is {}]\n{text}",
            MAX_LOG_READ / (1024 * 1024),
            path.to_string_lossy()
        )
    } else {
        text.into_owned()
    }
}

impl CheckRunner for AppRunner<'_> {
    fn run(&self, step: &Step, env: &[(String, String)]) -> Finished {
        use crate::project_actions::RunStatus;
        let (result, status) = crate::verify_stage::run_check_in(
            self.app,
            self.main,
            self.checkout,
            &step.id,
            &step.name,
            &step.command,
            step.timeout_seconds,
            env.to_vec(),
        );
        let output = result
            .log_path
            .as_deref()
            .map(|path| read_log(Path::new(path)))
            .unwrap_or_default();
        let ended = match status {
            Some(RunStatus::Succeeded) | Some(RunStatus::Failed) => Ended::Finished,
            Some(RunStatus::TimedOut) => Ended::TimedOut,
            Some(RunStatus::Stopped) | Some(RunStatus::Running) => Ended::Stopped,
            None => Ended::NotStarted(result.detail),
        };
        Finished { output, ended }
    }
}

/// What the webview sends (`agentAppRunChecks.ts`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    /// The caller's own checkout: a worker's copy, or the project a first mate works in.
    pub cwd: String,
    /// The delegation id of a worker, else the chat's id.
    pub owner: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
}

/// Run the project's tests in the caller's checkout (`run_checks.run`).
#[tauri::command(async)]
pub async fn run_checks_run(app: tauri::AppHandle, input: RunInput) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::fs::expand_home(&input.cwd);
        let (main, checkout) = crate::project_actions::checkout_of_project(&cwd)?;
        let data = crate::project_file::data_dir(&app)?;
        let Some(file) = crate::project_file::trusted_file(&data, &main) else {
            return Err(
                if crate::project_file::read_main_file(&main)
                    == crate::project_file::FileState::Missing
                {
                    NO_COMMAND.to_string()
                } else {
                    format!(
                        "This project's .monocode/project.json isn't imported yet (Settings > Worktrees). {NO_COMMAND}"
                    )
                },
            );
        };
        // What the copy changed: the paths the caller named, else what git sees. A copy git can't read has none, and
        // the project's checks all run.
        let changed =
            crate::verify_stage::changed_files(&checkout, &input.paths).unwrap_or_default();
        // A refusal costs nothing: the fingerprint below reads every file of the copy.
        pick(&file, input.command.as_deref(), &clean_paths(&changed))?;
        let fingerprint =
            crate::firstmate::gates::tree_fingerprint(&checkout).unwrap_or_default();
        let runner = AppRunner {
            app: &app,
            main: &main,
            checkout: &checkout,
        };
        run_with(
            &Request {
                file: &file,
                requested: input.command.as_deref(),
                changed,
                owner: &input.owner,
                data_dir: &data,
                now_ms: crate::session_store::now_millis().max(0) as u64,
                fingerprint,
            },
            &runner,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
