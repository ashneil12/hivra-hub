//! SC-4: a brief's own runnable checks, its commit stamp and its do-not-touch list (docs/specs/
//! shipping-confidence-gap-spec.md section 4a, "Agree what done means before any code").
//!
//! A brief used to end in free text: its goal was any non-empty sentence, and nothing said which commit it was written
//! against or which files were off limits. Now a brief can carry, beside the person's intent, its spec and its goal:
//!
//! - **check lines** (`checks`): at most 12 of `{what, command, expect}`. What must be true, the command that shows it,
//!   and optionally what the command's output must contain, or `exit N` for the exit code it must end with (the default
//!   is exit 0). The `checks` gate runs them after the project's own checks (`gates::run_round`), each in the worker's
//!   copy through the same runner the project's checks use, and writes each line's result back here.
//! - **a stamp** (`brief_stamp`): the main checkout's HEAD when the brief was written. The worker's brief opens with a
//!   drift rule built on it (`src/features/firstmate/model/briefChecks.ts`).
//! - **a do-not-touch list** (`leave`): paths the worker must not change. `done_check::leave_findings` flags a changed
//!   path under one of them and the round fails in every testing mode except `off`.
//!
//! All three live on the delegation row (`brief_stamp`, `brief_checks`, `brief_leave`), written once when the task
//! starts (`keep`: the first write wins, a retry changes nothing). Only the app sets whether a line passed:
//! `record_results` is called by the gates and is no command and no tool; a line that arrives with a `passes` of its own
//! is refused. The person's quoted request is not on this row and nothing here writes it.
//!
//! A line's verdict (`judge`): the exit code is what it asked for (0 by default) and, when `expect` is text, the output
//! contains it (trimmed, case-sensitive, line endings read as one). A command that couldn't start (the shell couldn't
//! find it, the sandbox refused it), ran past its time or was stopped, and a run whose test summary says zero tests ran,
//! could not run: that is never a pass, and it is not a failure either.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::gates::{CommandEvidence, Outcome, OUTPUT_MAX};
use super::spec_record::{parse_deltas, SpecDelta}; // PT-6

/// The most check lines on one brief.
pub const LINES_MAX: usize = 12;
/// The longest `what`, `command`, `expect` or path, in characters.
pub const TEXT_MAX: usize = 400;
/// The most paths on a do-not-touch list.
pub const LEAVE_MAX: usize = 50;
/// How long one line may run before it is stopped and counts as not run.
pub const LINE_TIMEOUT_SECONDS: u64 = 10 * 60;
/// How long all of a brief's lines may take together. The lines after it are not run, never failed.
pub const LINES_BUDGET: Duration = Duration::from_secs(30 * 60);
/// The most of a run's log read for the zero-tests and `expect` reads (its end).
const LOG_READ_MAX: u64 = 8 * 1024 * 1024;

// ---- the lines ----------------------------------------------------------------------------------------------------------

/// One check line, as the row keeps it. `passes` is null until the gates ran it; only the app sets it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefCheck {
    pub what: String,
    pub command: String,
    #[serde(default)]
    pub expect: Option<String>,
    #[serde(default)]
    pub passes: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ran_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tail: Option<String>,
}

/// What a line's `expect` asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Expect<'a> {
    /// The command ends with this exit code (the default, 0, when `expect` is empty).
    Exit(i32),
    /// The command ends with exit 0 and its output contains this text.
    Text(&'a str),
}

impl BriefCheck {
    pub fn expectation(&self) -> Expect<'_> {
        match self
            .expect
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            None => Expect::Exit(0),
            Some(text) => exit_code_of(text).map_or(Expect::Text(text), Expect::Exit),
        }
    }
}

/// `exit 3` (any case, any spacing) names an exit code; anything else is text.
fn exit_code_of(text: &str) -> Option<i32> {
    let lower = text.trim().to_ascii_lowercase();
    let rest = lower.strip_prefix("exit")?;
    if !rest.starts_with(|c: char| c.is_whitespace()) {
        return None;
    }
    let digits = rest.trim();
    if digits.is_empty() || digits.len() > 3 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse::<i32>().ok().filter(|code| *code <= 255)
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The check lines a brief names, validated. Absent or null is none. A refusal is in plain words the model can act on.
/// Every line comes out with `passes` null: nothing the caller sends can say a line already passed.
pub fn parse_lines(value: &Value) -> Result<Vec<BriefCheck>, String> {
    let items = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) => items,
        _ => return Err("checks must be a list of check lines: {what, command, expect}.".into()),
    };
    if items.len() > LINES_MAX {
        return Err(format!("Give at most {LINES_MAX} check lines."));
    }
    let mut lines: Vec<BriefCheck> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let number = index + 1;
        let Some(object) = item.as_object() else {
            return Err(format!(
                "Check line {number} must be {{what, command, expect}}."
            ));
        };
        if let Some(extra) = object
            .keys()
            .find(|key| !matches!(key.as_str(), "what" | "command" | "expect"))
        {
            return Err(format!(
                "Check line {number} has what, command and expect only; \"{extra}\" isn't one. The app records whether a check passed."
            ));
        }
        let text = |key: &str| -> Result<Option<String>, String> {
            match object.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(text)) => Ok(Some(text.clone())),
                Some(_) => Err(format!("Check line {number}: {key} must be text.")),
            }
        };
        let what = collapse(&text("what")?.unwrap_or_default());
        if what.is_empty() {
            return Err(format!(
                "Check line {number} needs what must be true (what)."
            ));
        }
        let command = text("command")?.unwrap_or_default().trim().to_string();
        if command.is_empty() {
            return Err(format!(
                "Check line {number} needs the command that shows it (command)."
            ));
        }
        if command.contains(['\n', '\r']) {
            return Err(format!(
                "Check line {number}: command is one line. Put several steps in one script, or in several check lines."
            ));
        }
        let expect = match text("expect")? {
            Some(expect) if !expect.trim().is_empty() => {
                if expect.contains(['\n', '\r']) {
                    return Err(format!(
                        "Check line {number}: expect is one line of text the output contains, or exit N."
                    ));
                }
                Some(expect.trim().to_string())
            }
            _ => None,
        };
        for (name, value) in [
            ("what", Some(&what)),
            ("command", Some(&command)),
            ("expect", expect.as_ref()),
        ] {
            if value.is_some_and(|value| value.chars().count() > TEXT_MAX) {
                return Err(format!(
                    "Check line {number}: {name} is longer than {TEXT_MAX} characters."
                ));
            }
        }
        let line = BriefCheck {
            what,
            command,
            expect,
            passes: None,
            ran_at: None,
            output_tail: None,
        };
        let same = |other: &BriefCheck| {
            other.what == line.what && other.command == line.command && other.expect == line.expect
        };
        if !lines.iter().any(same) {
            lines.push(line);
        }
    }
    Ok(lines)
}

// ---- paths --------------------------------------------------------------------------------------------------------------

/// A path a brief names, inside the project: forward slashes, with `./` parts, doubled slashes and a trailing `/` or `/**`
/// taken out, so one path is written one way. A path that leaves the project (absolute, `..`, `~`, a drive), has a
/// control character or is git pathspec magic is refused.
pub fn normal_path(raw: &str) -> Result<String, String> {
    let path = raw.trim().replace('\\', "/");
    if path.chars().any(char::is_control) {
        return Err(format!(
            "\"{}\" has a control character.",
            path.escape_debug()
        ));
    }
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let outside = |shown: &str| {
        format!(
            "\"{shown}\" isn't inside the project. Use a path from the project's root, like src/app.ts."
        )
    };
    if path.starts_with('/') || path.starts_with('~') || drive {
        return Err(outside(&path));
    }
    let mut parts: Vec<&str> = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    if parts.contains(&"..") {
        return Err(format!(
            "\"{}\" leaves the project (..). Use a path from the project's root.",
            parts.join("/")
        ));
    }
    while parts.last() == Some(&"**") {
        parts.pop();
    }
    if parts.is_empty() {
        return Err("Name a file or folder inside the project, not the whole project.".into());
    }
    let joined = parts.join("/");
    if joined.starts_with(':') {
        return Err(outside(&joined));
    }
    if joined.chars().count() > TEXT_MAX {
        return Err(format!("A path is longer than {TEXT_MAX} characters."));
    }
    Ok(joined)
}

/// The do-not-touch list a brief names, validated: at most 50 paths inside the project, repeats dropped.
pub fn parse_leave(value: &Value) -> Result<Vec<String>, String> {
    let items = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) => items,
        _ => return Err("leave must be a list of paths.".into()),
    };
    if items.len() > LEAVE_MAX {
        return Err(format!("Name at most {LEAVE_MAX} paths in leave."));
    }
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Some(raw) = item.as_str() else {
            return Err("leave must be a list of paths.".into());
        };
        let path = normal_path(raw)?;
        if !out.contains(&path) {
            out.push(path);
        }
    }
    Ok(out)
}

/// What a tool call's `checks` and `leave` must satisfy before it reaches the app: its check lines (the entries that are
/// not a plain project-check name) and its do-not-touch paths, validated as `keep` will validate them. A line that names
/// `passes`, or anything but what, command and expect, is refused here, so no tool call can say a line passed.
pub fn refuse_bad_brief(checks: Option<&Value>, leave: Option<&Value>) -> Result<(), String> {
    match checks {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => {
            let lines: Vec<Value> = items
                .iter()
                .filter(|item| !item.is_string())
                .cloned()
                .collect();
            parse_lines(&Value::Array(lines))?;
        }
        Some(_) => return Err("checks must be a list.".into()),
    }
    parse_leave(leave.unwrap_or(&Value::Null))?;
    Ok(())
}

/// Whether a changed path (as git prints it) is on the list entry: the path itself, anything under it, or a match for
/// an entry with `*` or `?`. Case is ignored: the checkouts this runs on (macOS, Windows) don't tell `Src` from `src`.
pub fn under(entry: &str, path: &str) -> bool {
    let entry = entry.replace('\\', "/").to_lowercase();
    let path = path.replace('\\', "/").to_lowercase();
    let entry = entry.trim_start_matches("./").trim_end_matches('/');
    if entry.is_empty() {
        return false;
    }
    if entry.contains(['*', '?']) {
        return crate::verify_stage::glob_matches(entry, &path)
            || crate::verify_stage::glob_matches(&format!("{entry}/**"), &path);
    }
    path == entry || path.starts_with(&format!("{entry}/"))
}

// ---- the row ------------------------------------------------------------------------------------------------------------

/// What a delegation row keeps of its brief.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefState {
    /// The main checkout's HEAD when the brief was written.
    pub stamp: Option<String>,
    pub checks: Vec<BriefCheck>,
    pub leave: Vec<String>,
    /// Why the stored lines couldn't be read. The row's text is untrusted: a damaged one is never read as "no checks".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks_unreadable: Option<String>,
    /// Why the stored do-not-touch list couldn't be read: never read as an empty list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leave_unreadable: Option<String>,
    /// PT-6: the spec parts the brief asked for (spec_record.rs). Empty for a brief with none.
    pub spec: Vec<SpecDelta>,
    /// PT-6: why the stored spec parts couldn't be read: never read as a brief with none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_unreadable: Option<String>,
}

fn read_state(
    stamp: Option<String>,
    checks: Option<String>,
    leave: Option<String>,
    spec: Option<String>,
) -> BriefState {
    let mut state = BriefState {
        stamp: stamp.filter(|stamp| valid_stamp(stamp)),
        ..BriefState::default()
    };
    // A stored text that is empty or damaged is never "none": `keep` always writes `[]` for none, and null is a row from
    // before. `from_str` refuses an empty text.
    if let Some(text) = checks {
        match serde_json::from_str::<Vec<BriefCheck>>(&text) {
            Ok(lines) if lines.len() <= LINES_MAX && lines.iter().all(sound) => {
                state.checks = lines
            }
            _ => state.checks_unreadable = Some("the brief's own checks couldn't be read".into()),
        }
    }
    if let Some(text) = leave {
        match serde_json::from_str::<Vec<String>>(&text) {
            Ok(list)
                if list.len() <= LEAVE_MAX && list.iter().all(|path| normal_path(path).is_ok()) =>
            {
                state.leave = list
            }
            _ => {
                state.leave_unreadable =
                    Some("the brief's do-not-touch list couldn't be read".into())
            }
        }
    }
    // PT-6: null is a brief with no spec part (`keep` writes null for none); a text that doesn't parse as spec parts, through
    // the same validation a call goes through, is never read as none.
    if let Some(text) = spec {
        match serde_json::from_str::<Value>(&text)
            .map_err(|e| e.to_string())
            .and_then(|value| parse_deltas(&value))
        {
            Ok(list) => state.spec = list,
            Err(_) => {
                state.spec_unreadable = Some("the brief's spec parts couldn't be read".into())
            }
        }
    }
    state
}

/// A stored line that would still pass the checks it passed when it was written.
fn sound(line: &BriefCheck) -> bool {
    !line.what.trim().is_empty()
        && !line.command.trim().is_empty()
        && !line.command.contains(['\n', '\r'])
        && line.what.chars().count() <= TEXT_MAX
        && line.command.chars().count() <= TEXT_MAX
}

/// A full or short commit id: 7 to 64 hex digits.
pub fn valid_stamp(stamp: &str) -> bool {
    (7..=64).contains(&stamp.len()) && stamp.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn state_of(conn: &Connection, id: &str) -> Result<BriefState, String> {
    type Stored = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Stored> = conn
        .query_row(
            "SELECT brief_stamp, brief_checks, brief_leave, brief_spec FROM delegations WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(
        row.map_or_else(BriefState::default, |(stamp, checks, leave, spec)| {
            read_state(stamp, checks, leave, spec)
        }),
    )
}

/// What the webview hands over once a task has started. Nothing in it can say a line passed.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepInput {
    #[serde(default)]
    pub stamp: Option<String>,
    #[serde(default)]
    pub checks: Value,
    #[serde(default)]
    pub leave: Value,
    /// PT-6: the brief's spec parts. Validated by `parse_deltas`, like the rest.
    #[serde(default)]
    pub spec: Value,
}

/// Keeps a started task's brief lines, stamp and do-not-touch list. The first keep wins: a retry of the same delegation
/// (or a second window) changes nothing, so results already recorded are never blanked. `Ok(true)`: this call wrote them.
pub fn keep(conn: &Connection, id: &str, input: &KeepInput) -> Result<bool, String> {
    let stamp = match input.stamp.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(stamp) if valid_stamp(stamp) => Some(stamp.to_ascii_lowercase()),
        Some(_) => return Err("The stamp isn't a commit id.".into()),
    };
    let lines = parse_lines(&input.checks)?;
    let leave = parse_leave(&input.leave)?;
    let spec = parse_deltas(&input.spec)?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM delegations WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("No task with that id.".into());
    }
    let changed = conn
        .execute(
            "UPDATE delegations SET brief_stamp = ?2, brief_checks = ?3, brief_leave = ?4, brief_spec = ?5
             WHERE id = ?1 AND brief_checks IS NULL",
            params![
                id,
                stamp,
                serde_json::to_string(&lines).map_err(|e| e.to_string())?,
                serde_json::to_string(&leave).map_err(|e| e.to_string())?,
                // PT-6: null for a brief with no spec part.
                if spec.is_empty() {
                    None
                } else {
                    Some(serde_json::to_string(&spec).map_err(|e| e.to_string())?)
                },
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// One line's result from a round, to be written back to the row.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineResult {
    pub what: String,
    pub command: String,
    #[serde(default)]
    pub expect: Option<String>,
    /// Null: it could not run.
    pub passes: Option<bool>,
    pub ran_at: i64,
    pub output_tail: String,
}

/// Writes a round's results onto the row's lines (the gates call this; it is no command and no tool). A result lands on
/// the line with the same what, command and expect, and only when it is not older than the result already there, so a
/// late round never overwrites a newer one. The write is checked against the text it was made from and made again when
/// another writer got in between. Returns how many lines it changed.
pub fn record_results(
    conn: &Connection,
    id: &str,
    results: &[LineResult],
) -> Result<usize, String> {
    if results.is_empty() {
        return Ok(0);
    }
    for _ in 0..3 {
        let stored: Option<String> = conn
            .query_row(
                "SELECT brief_checks FROM delegations WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        let Some(stored) = stored else {
            return Ok(0);
        };
        let mut lines: Vec<BriefCheck> = serde_json::from_str(&stored)
            .map_err(|_| "the brief's own checks couldn't be read".to_string())?;
        let mut applied = 0;
        for result in results {
            let Some(line) = lines.iter_mut().find(|line| {
                line.what == result.what
                    && line.command == result.command
                    && line.expect == result.expect
            }) else {
                continue;
            };
            if line.ran_at.is_some_and(|at| at > result.ran_at) {
                continue;
            }
            line.passes = result.passes;
            line.ran_at = Some(result.ran_at);
            line.output_tail = Some(crate::gates::tail(&result.output_tail, OUTPUT_MAX));
            applied += 1;
        }
        if applied == 0 {
            return Ok(0);
        }
        let next = serde_json::to_string(&lines).map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE delegations SET brief_checks = ?3 WHERE id = ?1 AND brief_checks = ?2",
                params![id, stored, next],
            )
            .map_err(|e| e.to_string())?;
        if changed == 1 {
            return Ok(applied);
        }
    }
    Err(
        "The brief's checks were changed while their results were written; run the checks again."
            .into(),
    )
}

// ---- the stamp ------------------------------------------------------------------------------------------------------------

/// The HEAD of the project's main checkout (not the worker's copy), when `folder` is in a git project. `None` when it
/// can't be read: the brief then has no drift rule rather than a made-up stamp.
pub fn head_of_main_checkout(folder: &Path) -> Option<String> {
    let main = crate::project_file::main_checkout(folder).ok()?;
    let mut cmd = crate::git_cmd::git();
    cmd.arg("-C")
        .arg(&main)
        .args(["rev-parse", "--verify", "-q", "HEAD"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null());
    crate::hide_window_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let head = String::from_utf8_lossy(&out.stdout).trim().to_string();
    valid_stamp(&head).then_some(head)
}

/// What a round reads of the brief: the lines to run, the do-not-touch list, and why either couldn't be read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BriefRound {
    pub lines: Vec<BriefCheck>,
    pub leave: Vec<String>,
    pub checks_unreadable: Option<String>,
    pub leave_unreadable: Option<String>,
    /// PT-6: the spec parts the done check holds the worker's copy to.
    pub spec: Vec<SpecDelta>,
    pub spec_unreadable: Option<String>,
}

impl From<&BriefState> for BriefRound {
    fn from(state: &BriefState) -> BriefRound {
        BriefRound {
            lines: state.checks.clone(),
            leave: state.leave.clone(),
            checks_unreadable: state.checks_unreadable.clone(),
            leave_unreadable: state.leave_unreadable.clone(),
            spec: state.spec.clone(),
            spec_unreadable: state.spec_unreadable.clone(),
        }
    }
}

// ---- running a line -------------------------------------------------------------------------------------------------------

/// How one run of a command ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ended {
    /// It ended by itself: the exit code, or none when a signal ended it.
    Exited(Option<i32>),
    /// It ran past its time limit and was stopped.
    TimedOut,
    /// It was stopped before it finished.
    Stopped,
    /// It had not finished when the runner gave up waiting.
    Unfinished,
    /// It never started (no checkout, the sandbox refused it, the runner was busy).
    NotStarted(String),
}

/// What the runner saw of one command: how it ended and what it printed (the end of the log).
#[derive(Clone, Debug, PartialEq)]
pub struct RawRun {
    pub ended: Ended,
    pub output: String,
    pub seconds: f64,
}

impl RawRun {
    pub fn not_started(why: impl Into<String>) -> RawRun {
        RawRun {
            ended: Ended::NotStarted(why.into()),
            output: String::new(),
            seconds: 0.0,
        }
    }
}

/// A run's log without the runner's own header. The action runner opens every log with `$ <command>`, `# in <folder>
/// (<name>)` and a blank line; none of that is output, and a line's `expect` must not be met by the command's echo.
pub fn without_run_header(log: &str) -> &str {
    match log.strip_prefix("$ ") {
        Some(rest) => rest.split_once("\n\n").map_or(log, |(_, after)| after),
        None => log,
    }
}

/// The end of a run's log (at most 8 MB of it) without the runner's header, or nothing when it can't be read.
pub fn read_log(path: &Path) -> String {
    let read = || -> std::io::Result<String> {
        let mut file = std::fs::File::open(path)?;
        let len = file.metadata()?.len();
        if len > LOG_READ_MAX {
            file.seek(SeekFrom::Start(len - LOG_READ_MAX))?;
        }
        let mut bytes = Vec::new();
        file.take(LOG_READ_MAX).read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        // A log cut to its end has no header left to take out.
        Ok(if len > LOG_READ_MAX {
            text
        } else {
            without_run_header(&text).to_string()
        })
    };
    read().unwrap_or_default()
}

/// A line's verdict on one run.
#[derive(Clone, Debug, PartialEq)]
pub struct Judged {
    pub outcome: Outcome,
    /// True or false when it ran; null when it could not run.
    pub passes: Option<bool>,
    /// One plain sentence on the line, for the gate's summary.
    pub detail: String,
    pub evidence: CommandEvidence,
}

fn lines_of(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Judges one run against its line: the exit code (0 unless `expect` says `exit N`) and, for text, the output. See the
/// module notes for what could not run.
pub fn judge(line: &BriefCheck, run: &RawRun) -> Judged {
    let want = line.expectation();
    let output = lines_of(&run.output);
    let wanted_exit = match want {
        Expect::Exit(code) => code,
        Expect::Text(_) => 0,
    };
    let (outcome, exit_code, reason) = match &run.ended {
        Ended::NotStarted(why) => (Outcome::NotRun, None, format!("it didn't start: {why}")),
        Ended::TimedOut => (
            Outcome::NotRun,
            None,
            "it ran past its time limit".to_string(),
        ),
        Ended::Stopped => (
            Outcome::NotRun,
            None,
            "it was stopped before it finished".to_string(),
        ),
        Ended::Unfinished => (Outcome::NotRun, None, "it didn't finish".to_string()),
        Ended::Exited(None) => (
            Outcome::NotRun,
            None,
            "it ended without an exit code".to_string(),
        ),
        // The shell's own "can't run that": not found, or not allowed to run. Never a pass, whatever exit the line asked
        // for: a command that could not start proves nothing.
        Ended::Exited(Some(code @ (126 | 127))) => (
            Outcome::NotRun,
            Some(*code),
            format!(
                "the shell couldn't start it (exit {code}: {})",
                if *code == 127 {
                    "command not found"
                } else {
                    "not allowed to run"
                }
            ),
        ),
        Ended::Exited(Some(code)) if *code != wanted_exit => (
            Outcome::Failed,
            Some(*code),
            format!("it exited {code}, and the line wanted exit {wanted_exit}"),
        ),
        Ended::Exited(Some(code)) => match super::gates::zero_tests_note(&output) {
            Some(note) => (Outcome::NotRun, Some(*code), note),
            None => match want {
                Expect::Text(text) if !lines_of(&output).trim().contains(lines_of(text).trim()) => {
                    (
                        Outcome::Failed,
                        Some(*code),
                        format!("its output didn't contain \"{}\"", clip(text, 80)),
                    )
                }
                _ => (Outcome::Passed, Some(*code), String::new()),
            },
        },
    };
    let detail = match outcome {
        Outcome::Passed => format!("{}: passed.", line.what),
        Outcome::Failed => format!("{}: failed ({reason}).", line.what),
        _ => format!("{}: couldn't run ({reason}).", line.what),
    };
    let mut shown = crate::gates::tail(&output, OUTPUT_MAX);
    if outcome == Outcome::NotRun && shown.is_empty() {
        shown = reason.clone();
    } else if outcome == Outcome::NotRun && matches!(run.ended, Ended::Exited(_)) {
        shown = format!("{reason}\n{shown}");
    }
    Judged {
        passes: match outcome {
            Outcome::Passed => Some(true),
            Outcome::Failed => Some(false),
            _ => None,
        },
        outcome,
        detail,
        evidence: CommandEvidence {
            command: line.command.clone(),
            outcome,
            exit_code,
            output: shown,
            seconds: run.seconds,
        },
    }
}

fn clip(text: &str, max: usize) -> String {
    let text: String = text.chars().take(max).collect();
    text.replace('"', "'")
}

/// Runs a brief's lines in order through `runner` and judges each. After `budget` is spent the rest are not run (never
/// failed). Each result carries `now`, the time the round started.
pub fn run_lines(
    lines: &[BriefCheck],
    now: i64,
    budget: Duration,
    runner: &mut dyn FnMut(usize, &BriefCheck) -> RawRun,
) -> Vec<(Judged, LineResult)> {
    let started = Instant::now();
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let run = if started.elapsed() > budget {
                RawRun::not_started("the time for this brief's checks ran out")
            } else {
                runner(index, line)
            };
            let judged = judge(line, &run);
            let result = LineResult {
                what: line.what.clone(),
                command: line.command.clone(),
                expect: line.expect.clone(),
                passes: judged.passes,
                ran_at: now,
                output_tail: judged.evidence.output.clone(),
            };
            (judged, result)
        })
        .collect()
}

// ---- commands -------------------------------------------------------------------------------------------------------------

use tauri::State;

use crate::session_store::SessionStore;

/// The stamp for a brief about to be written: the HEAD of the project's main checkout. None when `folder` is no git
/// project or git can't say; the brief then carries no drift rule.
#[tauri::command(async)]
pub fn firstmate_brief_stamp(folder: String) -> Option<String> {
    head_of_main_checkout(&crate::fs::expand_home(&folder))
}

/// Keeps a started task's brief lines, stamp and do-not-touch list (the first keep wins; see `keep`). The one way the
/// webview writes any of it, and it never writes a result.
#[tauri::command(async)]
pub fn firstmate_brief_keep(
    store: State<'_, SessionStore>,
    id: String,
    input: KeepInput,
) -> Result<bool, String> {
    keep(&*store.lock_conn()?, &id, &input)
}

#[cfg(test)]
#[path = "brief_checks_tests.rs"]
mod tests;
