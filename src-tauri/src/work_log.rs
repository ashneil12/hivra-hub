//! The work log (docs/hivra/work/WP-157-work-log-and-retro.md).
//!
//! One plain line per finished task, decision, correction or note. A delegation
//! that finishes or is sent back, and a decision the person answers, each add
//! their own summary. Rows are inserted and then left alone: a trigger rejects
//! updates and deletes, and a second insert with the same source returns the
//! first row instead of writing over it. Two windows both insert, so neither
//! can overwrite the other.
//!
//! The log is a side record of work that already happened. A caller that writes
//! a line inside its own transaction does it through `best_effort`: the write
//! runs in a savepoint, and a failure rolls back that savepoint alone, so the
//! finished task or the answered decision still commits.

use std::time::Duration;

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;
use time::{OffsetDateTime, UtcOffset};

use crate::portable::scrubber;

/// The longest line kept, in characters. A longer line is cut on a character
/// boundary after secrets are removed, never in the middle of one.
pub(crate) const LINE_CAP: usize = 2_000;

const FIELD_CAP: usize = 500;
const SOURCE_CAP: usize = 500;
/// The furthest a civil timezone sits from UTC, in seconds. Anything wider is
/// treated as UTC so a bad offset cannot invent a day.
const MAX_OFFSET_SECONDS: i64 = 18 * 60 * 60;

const KINDS: [&str; 4] = ["outcome", "decision", "feedback", "context"];
/// A hand line longer than this is refused before it is scrubbed. The stored line is still `LINE_CAP`.
const HAND_INPUT_CAP: usize = 8_000;
/// `from` and `to` may sit this many days apart. A longer read is refused, not cut short.
const READ_SPAN_DAYS: i64 = 366;

const FALLBACK_LINE: &str = "Line left out because it still looked like a secret.";
/// What `scrubber` writes in place of a secret (`secretPatterns.json`). A cut
/// must not end halfway through it.
const SECRET_MARKER: &str = "[secret removed]";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Line {
    pub seq: i64,
    pub project: String,
    pub day: String,
    pub kind: String,
    pub task_id: String,
    pub line: String,
    pub created_at: i64,
    pub source: String,
}

/// A line to append. `offset_seconds` is the person's offset east of UTC;
/// `None` reads the computer's zone for `at_ms`. An empty `source` is a line
/// someone wrote by hand and may repeat. A source that was already stored
/// returns that row and does not change it.
pub(crate) struct NewLine<'a> {
    pub project: &'a str,
    pub kind: &'a str,
    pub task_id: &'a str,
    pub line: &'a str,
    pub at_ms: i64,
    pub offset_seconds: Option<i32>,
    pub source: &'a str,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ReadQuery {
    /// `None` is every project. An empty string is only lines with no project.
    pub project: Option<String>,
    pub kind: Option<String>,
    /// Inclusive, `YYYY-MM-DD` in the local day the row was stored with.
    pub from_day: Option<String>,
    pub to_day: Option<String>,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_log (
           seq INTEGER PRIMARY KEY,
           project TEXT NOT NULL DEFAULT '',
           day TEXT NOT NULL,
           kind TEXT NOT NULL CHECK (kind IN ('outcome', 'decision', 'feedback', 'context')),
           task_id TEXT NOT NULL DEFAULT '',
           line TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           source TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS work_log_by_day
           ON work_log (day, project, created_at, seq);
         CREATE UNIQUE INDEX IF NOT EXISTS work_log_source
           ON work_log (source) WHERE source != '';
         CREATE TRIGGER IF NOT EXISTS work_log_no_update
         BEFORE UPDATE ON work_log
         BEGIN
           SELECT RAISE(ABORT, 'work log is append-only');
         END;
         CREATE TRIGGER IF NOT EXISTS work_log_no_delete
         BEFORE DELETE ON work_log
         BEGIN
           SELECT RAISE(ABORT, 'work log is append-only');
         END;",
    )
}

/// The local calendar day for `at_ms` at `offset_seconds` east of UTC.
pub(crate) fn civil_day(at_ms: i64, offset_seconds: i32) -> Result<String, String> {
    let offset = UtcOffset::from_whole_seconds(sane_offset(i64::from(offset_seconds)))
        .unwrap_or(UtcOffset::UTC);
    let utc = OffsetDateTime::from_unix_timestamp(at_ms.div_euclid(1000))
        .map_err(|_| "That time is not a real day.".to_string())?;
    let date = utc.to_offset(offset).date();
    Ok(format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    ))
}

fn sane_offset(seconds: i64) -> i32 {
    if (-MAX_OFFSET_SECONDS..=MAX_OFFSET_SECONDS).contains(&seconds) {
        i32::try_from(seconds).unwrap_or(0)
    } else {
        0
    }
}

/// The computer's offset east of UTC at `unix_secs`, or 0 when the zone
/// cannot be read. The instant matters: a summer stamp and a winter stamp
/// can differ where the zone keeps daylight time.
pub(crate) fn local_offset_seconds(unix_secs: i64) -> i32 {
    local_offset_seconds_at(unix_secs)
}

#[cfg(unix)]
fn local_offset_seconds_at(unix_secs: i64) -> i32 {
    // `time_t` is 64-bit on the desktops this app ships. A value that does not
    // fit makes `localtime_r` fail, and the offset falls back to UTC.
    let stamp = unix_secs as libc::time_t;
    let mut civil: libc::tm = unsafe { std::mem::zeroed() };
    // Safety: `civil` is owned here. `localtime_r` only writes into it and does
    // not share a static buffer with other threads, unlike `localtime`.
    let ptr = unsafe { libc::localtime_r(&stamp, &mut civil) };
    if ptr.is_null() {
        return 0;
    }
    sane_offset(civil.tm_gmtoff)
}

#[cfg(windows)]
fn local_offset_seconds_at(unix_secs: i64) -> i32 {
    use time::Month;
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::Time::SystemTimeToTzSpecificLocalTime;

    let Ok(utc) = OffsetDateTime::from_unix_timestamp(unix_secs) else {
        return 0;
    };
    let Ok(year) = u16::try_from(utc.year()) else {
        return 0;
    };
    let utc_time = SYSTEMTIME {
        wYear: year,
        wMonth: u16::from(u8::from(utc.month())),
        wDayOfWeek: 0,
        wDay: u16::from(utc.day()),
        wHour: u16::from(utc.hour()),
        wMinute: u16::from(utc.minute()),
        wSecond: u16::from(utc.second()),
        wMilliseconds: 0,
    };
    let mut local_time = SYSTEMTIME::default();
    // Safety: both SYSTEMTIME values are owned by this function. A null zone
    // selects the computer's zone and the daylight rule for this date.
    let ok =
        unsafe { SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc_time, &mut local_time) };
    if ok == 0 {
        return 0;
    }
    let Ok(month) = u8::try_from(local_time.wMonth) else {
        return 0;
    };
    let Ok(month) = Month::try_from(month) else {
        return 0;
    };
    let Ok(day) = u8::try_from(local_time.wDay) else {
        return 0;
    };
    let Ok(date) = time::Date::from_calendar_date(i32::from(local_time.wYear), month, day) else {
        return 0;
    };
    let (Ok(hour), Ok(minute), Ok(second)) = (
        u8::try_from(local_time.wHour),
        u8::try_from(local_time.wMinute),
        u8::try_from(local_time.wSecond),
    ) else {
        return 0;
    };
    let Ok(clock) = time::Time::from_hms(hour, minute, second) else {
        return 0;
    };
    // The local clock read as UTC, minus the real UTC instant, is the offset.
    let local_as_utc = OffsetDateTime::new_utc(date, clock);
    sane_offset(local_as_utc.unix_timestamp() - utc.unix_timestamp())
}

pub(crate) fn append(conn: &Connection, input: &NewLine<'_>) -> Result<Line, String> {
    if !KINDS.contains(&input.kind) {
        return Err("Work log lines are an outcome, a decision, feedback or context.".into());
    }
    let project = clean_field(input.project, FIELD_CAP);
    let task_id = clean_field(input.task_id, FIELD_CAP);
    let line = clean_line(input.line)?;
    let source = clean_source(input.source)?;
    let offset = input
        .offset_seconds
        .unwrap_or_else(|| local_offset_seconds(input.at_ms.div_euclid(1000)));
    let day = civil_day(input.at_ms, offset)?;
    let sql = "INSERT INTO work_log (project, day, kind, task_id, line, created_at, source)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";
    let mut busy: u32 = 0;
    loop {
        match conn.execute(
            sql,
            params![project, day, input.kind, task_id, line, input.at_ms, source],
        ) {
            Ok(_) => return read_seq(conn, conn.last_insert_rowid()),
            Err(err) if is_busy(&err) && busy < 3 => {
                busy += 1;
                std::thread::sleep(Duration::from_millis(20 * u64::from(busy)));
            }
            Err(err) if is_unique(&err) && !source.is_empty() => {
                return read_source(conn, &source);
            }
            Err(err) => return Err(err.to_string()),
        }
    }
}

const SAVEPOINT: &str = "work_log_write";

/// Run one journal write inside a savepoint on the caller's open transaction. When `write` fails, only the
/// savepoint is rolled back: whatever the caller wrote before it stays, and the transaction can still commit.
pub(crate) fn in_savepoint<T>(
    conn: &Connection,
    write: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    conn.execute_batch(&format!("SAVEPOINT {SAVEPOINT}"))
        .map_err(|e| e.to_string())?;
    let outcome = write(conn).and_then(|value| {
        conn.execute_batch(&format!("RELEASE {SAVEPOINT}"))
            .map(|()| value)
            .map_err(|e| e.to_string())
    });
    if outcome.is_err() {
        // Back out this savepoint only, then drop it so the transaction is as it was before the write.
        let _ = conn.execute_batch(&format!("ROLLBACK TO {SAVEPOINT}; RELEASE {SAVEPOINT}"));
    }
    outcome
}

/// The journal is a side record of work that already happened, so a journal write must never fail that work.
/// Runs `write` in a savepoint. A failure is rolled back, logged as one warning line naming `what` was left
/// out, and answered with `None`, and the caller carries on and commits its own transaction.
pub(crate) fn best_effort<T>(
    conn: &Connection,
    what: &str,
    write: impl FnOnce(&Connection) -> Result<T, String>,
) -> Option<T> {
    match in_savepoint(conn, write) {
        Ok(value) => Some(value),
        Err(why) => {
            eprintln!("Work log: the {what} line was not written ({why}).");
            None
        }
    }
}

pub(crate) fn list(conn: &Connection, query: &ReadQuery) -> Result<Vec<Line>, String> {
    if let Some(kind) = &query.kind {
        if !KINDS.contains(&kind.as_str()) {
            return Err("Work log lines are an outcome, a decision, feedback or context.".into());
        }
    }
    if let Some(day) = &query.from_day {
        check_day(day)?;
    }
    if let Some(day) = &query.to_day {
        check_day(day)?;
    }
    if let (Some(from), Some(to)) = (&query.from_day, &query.to_day) {
        if from > to {
            return Err("The end day is before the start day.".into());
        }
    }
    let mut stmt = conn
        .prepare(
            "SELECT seq, project, day, kind, task_id, line, created_at, source
             FROM work_log
             WHERE (?1 IS NULL OR project = ?1)
               AND (?2 IS NULL OR kind = ?2)
               AND (?3 IS NULL OR day >= ?3)
               AND (?4 IS NULL OR day <= ?4)
             ORDER BY day ASC, created_at ASC, seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![
                query.project.as_deref(),
                query.kind.as_deref(),
                query.from_day.as_deref(),
                query.to_day.as_deref(),
            ],
            from_row,
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// How many times this task was sent back. Counted from stored sources, so a
/// line written by the other window is included and nothing is read and then
/// overwritten.
pub(crate) fn sent_back_count(conn: &Connection, task_id: &str) -> Result<i64, String> {
    // A connection that has delegations but has not been migrated yet (a test store) still gets the table.
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let task_id = clean_field(task_id, FIELD_CAP);
    conn.query_row(
        "SELECT COUNT(*) FROM work_log
         WHERE task_id = ?1 AND kind = 'outcome' AND instr(source, ':sent-back') > 0",
        [task_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// A stable id for one finish of one delegation. A source that would be too
/// long, or that looks like a secret, is stored as a hash instead.
pub(crate) fn delegation_source(id: &str, ending: &str, n: i64) -> String {
    let raw = format!("delegation:{id}:{ending}:{n}");
    let label = if ending == "sent-back" {
        "delegation:sent-back"
    } else {
        "delegation"
    };
    stable_source(label, &raw)
}

pub(crate) fn decision_source(project: &str, key: &str) -> String {
    stable_source("decision", &format!("decision:{project}:{key}"))
}

pub(crate) struct FinishedWork<'a> {
    pub project: &'a str,
    pub task_id: &'a str,
    pub task: &'a str,
    pub delivered: &'a str,
    pub problem: &'a str,
    /// `done`, `failed`, or `sent back`.
    pub ending: &'a str,
    pub rework: i64,
    pub queued_at: i64,
    pub at_ms: i64,
    pub source: &'a str,
}

/// One outcome summary. The same source returns the first row unchanged.
pub(crate) fn record_outcome(conn: &Connection, work: &FinishedWork<'_>) -> Result<Line, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let line = outcome_text(work)?;
    append(
        conn,
        &NewLine {
            project: work.project,
            kind: "outcome",
            task_id: work.task_id,
            line: &line,
            at_ms: work.at_ms,
            offset_seconds: None,
            source: work.source,
        },
    )
}

/// One decision summary. The same project and key return the first row.
pub(crate) fn record_decision(
    conn: &Connection,
    project: &str,
    key: &str,
    question: &str,
    answer: &str,
    at_ms: i64,
) -> Result<Line, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let question = snippet(question, 800);
    let answer = snippet(answer, 800);
    let line = if question.is_empty() && answer.is_empty() {
        "Decided, with the question and the answer left out.".to_string()
    } else if question.is_empty() {
        format!("Decided. Answer: {answer}.")
    } else if answer.is_empty() {
        format!("Decided: {question}.")
    } else {
        format!("Decided: {question} Answer: {answer}.")
    };
    let source = decision_source(project, key);
    append(
        conn,
        &NewLine {
            project,
            kind: "decision",
            task_id: key,
            line: &line,
            at_ms,
            offset_seconds: None,
            source: &source,
        },
    )
}

/// One standing-answer match. The source names the asker, the standing id and the time, so a later match is its own line
/// and does not collapse into the decision's first summary.
pub(crate) fn record_standing_match(
    conn: &Connection,
    project: &str,
    standing_id: &str,
    asker: &str,
    question: &str,
    at_ms: i64,
) -> Result<Line, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let standing_id = snippet(standing_id, 40);
    let asker = snippet(asker, 120);
    let question = snippet(question, 300);
    let line =
        format!("Standing answer {standing_id} matched a question from {asker}: {question}.");
    let source = stable_source(
        "standing-match",
        &format!("standing-match:{project}:{standing_id}:{asker}:{at_ms}:{question}"),
    );
    append(
        conn,
        &NewLine {
            project,
            kind: "decision",
            task_id: "",
            line: &line,
            at_ms,
            offset_seconds: None,
            source: &source,
        },
    )
}

/// One line a first mate wrote. The same chat, project, day, kind and line return the first row.
/// The source is derived here, so a caller cannot choose an id that collides with a finished task.
pub(crate) fn add_hand(
    conn: &Connection,
    session: &str,
    project: &str,
    kind: &str,
    line: &str,
    at_ms: i64,
) -> Result<Line, String> {
    let session = session.trim();
    if session.is_empty()
        || session.chars().count() > 256
        || session
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("There's no chat for this line.".into());
    }
    if line.chars().count() > HAND_INPUT_CAP {
        return Err("A work log line is one line, not a page.".into());
    }
    if !KINDS.contains(&kind) {
        return Err("Work log lines are an outcome, a decision, feedback or context.".into());
    }
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let project = clean_field(project, FIELD_CAP);
    let cleaned = clean_line(line)?;
    let offset = local_offset_seconds(at_ms.div_euclid(1000));
    let day = civil_day(at_ms, offset)?;
    let source = stable_source(
        "mate",
        &format!("mate:{session}:{project}:{day}:{kind}:{cleaned}"),
    );
    append(
        conn,
        &NewLine {
            project: &project,
            kind,
            task_id: "",
            line: &cleaned,
            at_ms,
            offset_seconds: Some(offset),
            source: &source,
        },
    )
}

/// What a first mate asked to read: one day, or `from` and `to` at most a year apart.
pub(crate) fn read_span(
    conn: &Connection,
    project: Option<&str>,
    day: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Line>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let project = if let Some(raw) = project {
        if raw.trim().is_empty() {
            return Err("Name a project, or leave it out to read every project.".into());
        }
        // A name a secret was removed from, or one past the field cap, is not a filter.
        // Matching the leftover marker would read the wrong rows.
        let cleaned = clean_field(raw, FIELD_CAP);
        if cleaned.is_empty() || cleaned != collapse(raw) {
            return Err("That project name could not be used.".into());
        }
        Some(cleaned)
    } else {
        None
    };
    let (from_day, to_day) = match (day, from, to) {
        (Some(day), None, None) => {
            parse_day(day)?;
            (Some(day.to_string()), Some(day.to_string()))
        }
        (None, Some(from), Some(to)) => {
            let start = parse_day(from)?;
            let end = parse_day(to)?;
            if start > end {
                return Err("The end day is before the start day.".into());
            }
            if (end - start).whole_days() > READ_SPAN_DAYS {
                return Err("Read one day, or a range of at most a year.".into());
            }
            (Some(from.to_string()), Some(to.to_string()))
        }
        (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
            return Err("Give a day, or from and to, not both.".into());
        }
        _ => return Err("Say which day to read, or from and to.".into()),
    };
    list(
        conn,
        &ReadQuery {
            project,
            kind: None,
            from_day,
            to_day,
        },
    )
}

/// The fields a first mate is shown. The source stays in the table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShownLine {
    pub project: String,
    pub day: String,
    pub kind: String,
    pub task_id: String,
    pub line: String,
}

fn shown(row: &Line) -> ShownLine {
    ShownLine {
        project: row.project.clone(),
        day: row.day.clone(),
        kind: row.kind.clone(),
        task_id: row.task_id.clone(),
        line: row.line.clone(),
    }
}

/// WP-157: a first mate adds one judgment line. The app action checks who is calling.
#[tauri::command(async)]
pub fn work_log_add(
    store: State<'_, crate::session_store::SessionStore>,
    session: String,
    project: String,
    kind: String,
    line: String,
) -> Result<ShownLine, String> {
    let conn = store.lock_conn()?;
    let row = add_hand(
        &conn,
        &session,
        &project,
        &kind,
        &line,
        crate::session_store::now_millis(),
    )?;
    Ok(shown(&row))
}

/// WP-157: a first mate reads one day, or a from and to range.
#[tauri::command(async)]
pub fn work_log_read(
    store: State<'_, crate::session_store::SessionStore>,
    project: Option<String>,
    day: Option<String>,
    from: Option<String>,
    to: Option<String>,
) -> Result<Vec<ShownLine>, String> {
    let conn = store.lock_conn()?;
    let rows = read_span(
        &conn,
        project.as_deref(),
        day.as_deref(),
        from.as_deref(),
        to.as_deref(),
    )?;
    Ok(rows.iter().map(shown).collect())
}

fn outcome_text(work: &FinishedWork<'_>) -> Result<String, String> {
    let lead = match work.ending {
        "done" => "Done",
        "failed" => "Failed",
        "sent back" => "Sent back",
        _ => return Err("A finished task is done, failed, or sent back.".to_string()),
    };
    let task = snippet(work.task, 200);
    let task = if task.is_empty() {
        "Untitled task".to_string()
    } else {
        task
    };
    let delivered = snippet(work.delivered, 400);
    let problem = snippet(work.problem, 400);
    let mut line = format!("{lead}: {task}.");
    if delivered.is_empty() {
        line.push_str(" Delivered nothing.");
    } else {
        line.push_str(&format!(" Delivered: {delivered}."));
    }
    if !problem.is_empty() {
        line.push_str(&format!(" It failed: {problem}."));
    }
    line.push(' ');
    line.push_str(&rework_words(work.rework));
    line.push(' ');
    line.push_str(&span_words(elapsed_ms(work.queued_at, work.at_ms)));
    Ok(line)
}

fn rework_words(rework: i64) -> String {
    match rework {
        i64::MIN..=0 => "No rework.".to_string(),
        1 => "Reworked once.".to_string(),
        n => format!("Reworked {n} times."),
    }
}

fn elapsed_ms(queued_at: i64, at_ms: i64) -> i64 {
    match at_ms.checked_sub(queued_at) {
        Some(ms) if ms > 0 => ms,
        _ => 0,
    }
}

/// How long the work had been queued, in plain words. `ms` is never negative.
fn span_words(ms: i64) -> String {
    if ms < 60_000 {
        return "Under a minute from queued.".to_string();
    }
    let minutes = ms / 60_000;
    let days = minutes / (24 * 60);
    let hours = (minutes / 60) % 24;
    let mins = minutes % 60;
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(unit(days, "day", "days"));
    }
    if hours > 0 {
        parts.push(unit(hours, "hour", "hours"));
    }
    if mins > 0 {
        parts.push(unit(mins, "minute", "minutes"));
    }
    format!("{} from queued.", parts.join(" "))
}

fn unit(n: i64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

fn snippet(raw: &str, max_chars: usize) -> String {
    let (redacted, _) = scrubber().redact_text(raw);
    cap_text(&collapse(&redacted), max_chars)
}

fn stable_source(label: &str, raw: &str) -> String {
    let collapsed = collapse(raw);
    if !collapsed.is_empty()
        && collapsed.chars().count() <= SOURCE_CAP
        && !scrubber().has_secret(&collapsed)
    {
        return collapsed;
    }
    let digest = Sha256::digest(raw.as_bytes());
    format!("{label}:{}", hex_bytes(digest.as_slice()))
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn check_day(day: &str) -> Result<(), String> {
    parse_day(day).map(|_| ())
}

fn parse_day(day: &str) -> Result<time::Date, String> {
    let err = "The day should look like 2026-11-10.";
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(err.into());
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return Err(err.into());
    }
    let year: i32 = day[0..4].parse().map_err(|_| err.to_string())?;
    let month: u8 = day[5..7].parse().map_err(|_| err.to_string())?;
    let day_of_month: u8 = day[8..10].parse().map_err(|_| err.to_string())?;
    let month = time::Month::try_from(month).map_err(|_| err.to_string())?;
    time::Date::from_calendar_date(year, month, day_of_month).map_err(|_| err.to_string())
}

fn clean_line(raw: &str) -> Result<String, String> {
    let (redacted, _) = scrubber().redact_text(raw);
    let text = collapse(&redacted);
    if text.is_empty() {
        return Err("A work log line needs words.".into());
    }
    let bounded = cap_text(&text, LINE_CAP);
    if bounded.is_empty() || scrubber().has_secret(&bounded) {
        return Ok(FALLBACK_LINE.to_string());
    }
    Ok(bounded)
}

fn clean_field(raw: &str, max_chars: usize) -> String {
    let (redacted, _) = scrubber().redact_text(raw);
    let bounded = cap_text(&collapse(&redacted), max_chars);
    if bounded.is_empty() || scrubber().has_secret(&bounded) {
        String::new()
    } else {
        bounded
    }
}

fn clean_source(raw: &str) -> Result<String, String> {
    if raw.chars().count() > SOURCE_CAP {
        return Err("The work log source is too long.".into());
    }
    if scrubber().has_secret(raw) {
        return Err("The work log source looked like a secret, so it was not kept.".into());
    }
    Ok(collapse(raw))
}

fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\0' => {}
            '\r' | '\n' | '\t' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first `max_chars` characters. If that would end halfway through a
/// secret marker, the marker is left out instead of stored in pieces.
fn cap_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut bounded: String = text.chars().take(max_chars).collect();
    if let Some(start) = bounded.rfind('[') {
        let tail = &bounded[start..];
        if SECRET_MARKER.starts_with(tail) && tail.len() < SECRET_MARKER.len() {
            bounded.truncate(start);
            bounded = bounded.trim_end().to_string();
        }
    }
    bounded
}

fn is_busy(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::DatabaseBusy
                || code.code == rusqlite::ErrorCode::DatabaseLocked
    )
}

fn is_unique(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::SqliteFailure(code, Some(message)) => {
            code.extended_code == 2067 || message.contains("UNIQUE")
        }
        rusqlite::Error::SqliteFailure(code, None) => code.extended_code == 2067,
        _ => false,
    }
}

fn read_seq(conn: &Connection, seq: i64) -> Result<Line, String> {
    conn.query_row(
        "SELECT seq, project, day, kind, task_id, line, created_at, source
         FROM work_log WHERE seq = ?1",
        [seq],
        from_row,
    )
    .map_err(|e| e.to_string())
}

fn read_source(conn: &Connection, source: &str) -> Result<Line, String> {
    conn.query_row(
        "SELECT seq, project, day, kind, task_id, line, created_at, source
         FROM work_log WHERE source = ?1",
        [source],
        from_row,
    )
    .map_err(|_| "The work log line could not be written.".to_string())
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Line> {
    Ok(Line {
        seq: row.get(0)?,
        project: row.get(1)?,
        day: row.get(2)?,
        kind: row.get(3)?,
        task_id: row.get(4)?,
        line: row.get(5)?,
        created_at: row.get(6)?,
        source: row.get(7)?,
    })
}

pub(crate) mod mcp;

#[cfg(test)]
mod tests;
