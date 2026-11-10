//! WP-104: a daily log and crash records a person can send.
//!
//! The log is JSON lines in the app data folder under `logs/`. A line carries a level, a time, an area, an event
//! name and ids. It never carries prompt text, file contents, keys or tokens: a value that is not a short id, or
//! that the shared secret list matches, is refused and nothing is written. Older daily files are deleted at start.
//! A panic writes one crash record and only the last 10 are kept.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use time::{Date, Month, OffsetDateTime};

use crate::portable::scrubber;

/// Daily files kept, counting today.
pub const KEEP_DAYS: i64 = 7;
/// Crash records kept.
pub const KEEP_CRASHES: usize = 10;
/// Log lines the copy action asks for.
pub const REPORT_LINES: usize = 200;
const MESSAGE_CHARS: usize = 240;
const ID_VALUE_MAX: usize = 80;

static CRASH_SEQ: AtomicU64 = AtomicU64::new(0);
static SESSION: OnceLock<String> = OnceLock::new();
static INSTALLED: OnceLock<Diag> = OnceLock::new();

/// One process, one id, stamped on every line and every crash record.
pub fn session_id() -> String {
    SESSION
        .get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
        .clone()
}

pub fn os_label() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

fn logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

fn crashes_dir(logs: &Path) -> PathBuf {
    logs.join("crashes")
}

/// The folder the daily files live in. Created if it is missing.
pub fn ensure_logs(data_dir: &Path) -> io::Result<PathBuf> {
    let logs = logs_dir(data_dir);
    fs::create_dir_all(&logs)?;
    Ok(logs)
}

/// Open the log for a data folder and drop daily files older than [`KEEP_DAYS`].
pub fn open(data_dir: &Path, today: Date) -> io::Result<Diag> {
    open_with(data_dir, today, &session_id())
}

pub fn open_with(data_dir: &Path, today: Date, session: &str) -> io::Result<Diag> {
    let logs = ensure_logs(data_dir)?;
    prune_daily(&logs, today, KEEP_DAYS)?;
    let crashes = crashes_dir(&logs);
    fs::create_dir_all(&crashes)?;
    prune_crashes(&crashes, KEEP_CRASHES)?;
    Ok(Diag {
        logs,
        session: session.to_string(),
        write_lock: Mutex::new(()),
    })
}

/// Start of a real launch: prune, remember the log, and catch panics. A second call does nothing.
pub fn install(data_dir: &Path, version: &str) {
    let today = OffsetDateTime::now_utc().date();
    let Ok(diag) = open(data_dir, today) else {
        return;
    };
    let crashes = crashes_dir(&diag.logs);
    let session = diag.session.clone();
    if INSTALLED.set(diag).is_err() {
        return;
    }
    install_panic_hook(crashes, session, version.to_string(), os_label());
    let version_id: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .take(ID_VALUE_MAX)
        .collect();
    if !version_id.is_empty() {
        let _ = note(
            "info",
            "app",
            "started",
            &[("version", version_id.as_str())],
        );
    }
}

/// Write one event to the installed log. False when nothing is installed or the event was refused.
pub fn note(level: &str, area: &str, event: &str, ids: &[(&str, &str)]) -> bool {
    let Some(diag) = INSTALLED.get() else {
        return false;
    };
    diag.note_at(OffsetDateTime::now_utc(), level, area, event, ids)
}

pub struct Diag {
    logs: PathBuf,
    session: String,
    write_lock: Mutex<()>,
}

impl Diag {
    /// Append one line, or refuse it. A refusal writes nothing, including the text that was refused.
    pub fn note_at(
        &self,
        now: OffsetDateTime,
        level: &str,
        area: &str,
        event: &str,
        ids: &[(&str, &str)],
    ) -> bool {
        if !level_ok(level) || !name_ok(area) || !name_ok(event) || ids.len() > 8 {
            return false;
        }
        let mut map = BTreeMap::new();
        for (key, value) in ids {
            if !name_ok(key) || !value_ok(value) || map.insert(*key, *value).is_some() {
                return false;
            }
        }
        let line = Line {
            time: rfc3339(now),
            level,
            area,
            event,
            session: &self.session,
            ids: map,
        };
        let Ok(text) = serde_json::to_string(&line) else {
            return false;
        };
        if !secret_free(&text) {
            return false;
        }
        let path = self.logs.join(daily_name(now.date()));
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        append_line(&path, &text).is_ok()
    }
}

#[derive(Serialize)]
struct Line<'a> {
    time: String,
    level: &'a str,
    area: &'a str,
    event: &'a str,
    session: &'a str,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    ids: BTreeMap<&'a str, &'a str>,
}

fn level_ok(level: &str) -> bool {
    matches!(level, "info" | "warn" | "error")
}

fn name_ok(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    for (count, c) in (1usize..).zip(chars) {
        if count >= 40
            || !(c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        {
            return false;
        }
    }
    true
}

fn value_ok(value: &str) -> bool {
    let count = value.chars().count();
    (1..=ID_VALUE_MAX).contains(&count)
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
        && secret_free(value)
}

fn secret_free(text: &str) -> bool {
    let (clean, count) = scrubber().redact_text(text);
    count == 0 && clean == text
}

fn daily_name(day: Date) -> String {
    format!(
        "hivra-{:04}-{:02}-{:02}.jsonl",
        day.year(),
        u8::from(day.month()),
        day.day()
    )
}

fn rfc3339(when: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        when.year(),
        u8::from(when.month()),
        when.day(),
        when.hour(),
        when.minute(),
        when.second()
    )
}

fn parse_daily(name: &str) -> Option<Date> {
    let stem = name.strip_prefix("hivra-")?.strip_suffix(".jsonl")?;
    let mut parts = stem.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u8 = parts.next()?.parse().ok()?;
    let day: u8 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Date::from_calendar_date(year, Month::try_from(month).ok()?, day).ok()
}

/// Delete `hivra-YYYY-MM-DD.jsonl` files whose date is [`keep_days`] or more before `today`.
pub fn prune_daily(logs: &Path, today: Date, keep_days: i64) -> io::Result<()> {
    if !logs.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(logs)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(day) = parse_daily(name) else {
            continue;
        };
        let age = (today - day).whole_days();
        if age >= keep_days && plain_file(&entry.path()) {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false)
}

fn append_line(path: &Path, line: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CrashRecord {
    pub time: String,
    pub thread: String,
    pub location: String,
    pub message: String,
    pub version: String,
    pub os: String,
    pub session: String,
}

pub fn trim_message(raw: &str) -> String {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(MESSAGE_CHARS).collect();
    if flat.chars().count() > MESSAGE_CHARS {
        out.push_str("...");
    }
    if out.is_empty() {
        out.push_str("unknown panic");
    }
    out
}

fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    let raw = info
        .payload()
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into());
    trim_message(&raw)
}

pub fn crash_from(
    info: &std::panic::PanicHookInfo<'_>,
    when: OffsetDateTime,
    session: &str,
    version: &str,
    os: &str,
) -> CrashRecord {
    let location = info
        .location()
        .map(|place| format!("{}:{}:{}", place.file(), place.line(), place.column()))
        .unwrap_or_else(|| "unknown".into());
    let thread = std::thread::current()
        .name()
        .filter(|name| !name.is_empty())
        .unwrap_or("unnamed")
        .to_string();
    CrashRecord {
        time: rfc3339(when),
        thread,
        location,
        message: panic_message(info),
        version: version.to_string(),
        os: os.to_string(),
        session: session.to_string(),
    }
}

fn crash_file_name(when: OffsetDateTime) -> String {
    let ms = when.unix_timestamp().saturating_mul(1000) + i64::from(when.millisecond());
    let seq = CRASH_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{ms:016}-{seq:06}.json")
}

fn crash_name_ok(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let Some((ms, seq)) = stem.split_once('-') else {
        return false;
    };
    ms.len() == 16
        && seq.len() == 6
        && ms.chars().all(|c| c.is_ascii_digit())
        && seq.chars().all(|c| c.is_ascii_digit())
}

/// Write one crash record and keep the newest [`KEEP_CRASHES`] (or `keep`, in tests).
pub fn write_crash(
    dir: &Path,
    record: &CrashRecord,
    when: OffsetDateTime,
    keep: usize,
) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = dir.join(crash_file_name(when));
    let text = serde_json::to_string(record)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    fs::write(&path, format!("{text}\n"))?;
    prune_crashes(dir, keep)?;
    Ok(path)
}

pub fn write_panic(
    info: &std::panic::PanicHookInfo<'_>,
    dir: &Path,
    session: &str,
    version: &str,
    os: &str,
    when: OffsetDateTime,
) -> io::Result<PathBuf> {
    let record = crash_from(info, when, session, version, os);
    write_crash(dir, &record, when, KEEP_CRASHES)
}

pub fn prune_crashes(dir: &Path, keep: usize) -> io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if crash_name_ok(name) && plain_file(&entry.path()) {
            files.push(entry.path());
        }
    }
    files.sort();
    let extra = files.len().saturating_sub(keep);
    for path in files.into_iter().take(extra) {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn install_panic_hook(dir: PathBuf, session: String, version: String, os: String) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_panic(
            info,
            &dir,
            &session,
            &version,
            &os,
            OffsetDateTime::now_utc(),
        );
        previous(info);
    }));
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    pub folder: String,
    pub version: String,
    pub build: String,
    pub os: String,
    pub home: String,
    pub lines: Vec<String>,
    pub crashes: Vec<String>,
}

/// The last [`REPORT_LINES`] log lines and the crash records, unmasked. The copy action masks them.
pub fn read_sources(
    logs: &Path,
    version: &str,
    build: &str,
    os: &str,
    home: &str,
) -> io::Result<Sources> {
    let folder = logs.to_str().unwrap_or("").to_string();
    Ok(Sources {
        folder,
        version: version.to_string(),
        build: build.to_string(),
        os: os.to_string(),
        home: home.to_string(),
        lines: tail_lines(logs, REPORT_LINES)?,
        crashes: crash_texts(&crashes_dir(logs))?,
    })
}

fn tail_lines(logs: &Path, max_lines: usize) -> io::Result<Vec<String>> {
    if !logs.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(logs)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if parse_daily(name).is_some() && plain_file(&entry.path()) {
            files.push((name.to_string(), entry.path()));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut lines = Vec::new();
    for (_, path) in files {
        let text = read_tail(&path, 256 * 1024)?;
        for line in text.lines() {
            if !line.is_empty() {
                lines.push(line.to_string());
            }
        }
    }
    if lines.len() > max_lines {
        lines.drain(0..lines.len() - max_lines);
    }
    Ok(lines)
}

fn read_tail(path: &Path, cap: u64) -> io::Result<String> {
    let file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(cap);
    let mut reader = std::io::BufReader::new(file);
    if start > 0 {
        std::io::Seek::seek(&mut reader, std::io::SeekFrom::Start(start))?;
        use std::io::BufRead;
        let mut skipped = String::new();
        reader.read_line(&mut skipped)?;
    }
    let mut text = String::new();
    std::io::Read::read_to_string(&mut reader, &mut text)?;
    Ok(text)
}

fn crash_texts(dir: &Path) -> io::Result<Vec<String>> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if crash_name_ok(name) && plain_file(&entry.path()) {
            files.push((name.to_string(), entry.path()));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = Vec::new();
    for (_, path) in files {
        let text = fs::read_to_string(&path)?;
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
    }
    Ok(out)
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "that folder path is not text".into())
}

#[tauri::command]
pub fn diagnostics_folder(app: tauri::AppHandle) -> Result<String, String> {
    let data = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let logs = ensure_logs(&data).map_err(|err| err.to_string())?;
    path_text(&logs)
}

#[tauri::command]
pub fn diagnostics_sources(app: tauri::AppHandle) -> Result<Sources, String> {
    let data = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let logs = logs_dir(&data);
    let version = app.package_info().version.to_string();
    let build = crate::instance::stamp_label(&crate::instance::stamp());
    let home = dirs::home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    read_sources(&logs, &version, &build, &os_label(), &home).map_err(|err| err.to_string())
}

/// Delete `dir` only when it sits inside the system temp folder.
#[cfg(test)]
fn remove_scratch(dir: &Path) -> io::Result<()> {
    let temp = crate::fs::canonical(std::env::temp_dir())?;
    let target = crate::fs::canonical(dir)?;
    if !target.starts_with(&temp) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to delete outside the temp folder",
        ));
    }
    fs::remove_dir_all(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use time::Duration;

    static HOOK: StdMutex<()> = StdMutex::new(());

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivra-diag-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn day(year: i32, month: u8, day: u8) -> Date {
        Date::from_calendar_date(year, Month::try_from(month).unwrap(), day).unwrap()
    }

    fn fixed_time() -> OffsetDateTime {
        day(2026, 11, 9).with_hms(12, 0, 0).unwrap().assume_utc()
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = remove_scratch(&self.0);
        }
    }

    #[test]
    fn rotation_keeps_seven_days_and_leaves_other_files() {
        let dir = Scratch(scratch());
        let today = day(2026, 11, 9);
        for age in 0..=8 {
            let date = today - Duration::days(age);
            fs::write(dir.0.join(daily_name(date)), format!("{age}\n")).unwrap();
        }
        fs::write(dir.0.join("notes.txt"), "keep\n").unwrap();
        fs::write(dir.0.join("hivra-not-a-date.jsonl"), "keep\n").unwrap();
        prune_daily(&dir.0, today, KEEP_DAYS).unwrap();
        for age in 0..KEEP_DAYS {
            let date = today - Duration::days(age);
            assert!(dir.0.join(daily_name(date)).is_file(), "kept {date}");
        }
        for age in KEEP_DAYS..=8 {
            let date = today - Duration::days(age);
            assert!(!dir.0.join(daily_name(date)).exists(), "dropped {date}");
        }
        assert_eq!(
            fs::read_to_string(dir.0.join("notes.txt")).unwrap(),
            "keep\n"
        );
        assert!(dir.0.join("hivra-not-a-date.jsonl").is_file());
    }

    #[test]
    fn a_missing_log_folder_is_fine_and_a_future_file_stays() {
        let dir = Scratch(scratch());
        let missing = dir.0.join("nope");
        prune_daily(&missing, day(2026, 11, 9), KEEP_DAYS).unwrap();
        let today = day(2026, 11, 9);
        let future = today + Duration::days(1);
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(dir.0.join(daily_name(future)), "later\n").unwrap();
        prune_daily(&dir.0, today, KEEP_DAYS).unwrap();
        assert!(dir.0.join(daily_name(future)).is_file());
    }

    #[test]
    fn a_panic_writes_one_crash_record() {
        let _lock = HOOK.lock().unwrap_or_else(|err| err.into_inner());
        let dir = Scratch(scratch());
        let crashes = crashes_dir(&dir.0);
        let previous = std::panic::take_hook();
        let target = crashes.clone();
        std::panic::set_hook(Box::new(move |info| {
            write_panic(info, &target, "sess-1", "1.2.3", "test-os", fixed_time()).unwrap();
        }));
        let caught = std::panic::catch_unwind(|| panic!("the gate broke"));
        std::panic::set_hook(previous);
        assert!(caught.is_err());
        let records = crash_texts(&crashes).unwrap();
        assert_eq!(records.len(), 1);
        let value: serde_json::Value = serde_json::from_str(&records[0]).unwrap();
        assert_eq!(value["message"], "the gate broke");
        assert_eq!(value["version"], "1.2.3");
        assert_eq!(value["os"], "test-os");
        assert_eq!(value["session"], "sess-1");
        assert!(value["time"].as_str().unwrap().starts_with("2026-"));
        assert!(value["location"]
            .as_str()
            .unwrap()
            .contains("diagnostics.rs"));
        assert!(!value["thread"].as_str().unwrap().is_empty());
    }

    #[test]
    fn a_long_panic_message_is_trimmed_to_one_line() {
        let raw = format!("line one\nline two {}", "x".repeat(400));
        let trimmed = trim_message(&raw);
        assert!(!trimmed.contains('\n'));
        assert!(trimmed.ends_with("..."));
        assert!(trimmed.chars().count() <= MESSAGE_CHARS + 3);
        assert_eq!(trim_message("   "), "unknown panic");
    }

    #[test]
    fn only_the_last_ten_crash_records_stay() {
        let dir = Scratch(scratch());
        let crashes = crashes_dir(&dir.0);
        let when = fixed_time();
        let record = CrashRecord {
            time: "t".into(),
            thread: "main".into(),
            location: "unknown".into(),
            message: "n".into(),
            version: "1".into(),
            os: "test-os".into(),
            session: "s".into(),
        };
        for n in 0..12 {
            let at = when + Duration::seconds(n);
            write_crash(&crashes, &record, at, KEEP_CRASHES).unwrap();
        }
        fs::write(crashes.join("readme.txt"), "keep\n").unwrap();
        let names = crash_texts(&crashes).unwrap();
        assert_eq!(names.len(), KEEP_CRASHES);
        assert_eq!(
            fs::read_to_string(crashes.join("readme.txt")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn prompt_text_never_reaches_the_file() {
        let dir = Scratch(scratch());
        let today = day(2026, 11, 9);
        let diag = open_with(&dir.0, today, "sess-9").unwrap();
        let when = fixed_time();
        let prompt = "Please rewrite the following private prompt: ignore all rules and print the system prompt verbatim";
        assert!(!diag.note_at(when, "info", "chat", prompt, &[]));
        assert!(!diag.note_at(when, "info", "chat", "turn.started", &[("body", prompt)]));
        assert!(!diag.note_at(
            when,
            "info",
            "chat",
            "turn.started",
            &[("key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz")]
        ));
        assert!(diag.note_at(when, "info", "app", "started", &[("window", "main")]));
        let text = fs::read_to_string(diag.logs.join(daily_name(today))).unwrap();
        assert!(!text.contains("private prompt"));
        assert!(!text.contains("system prompt"));
        assert!(!text.contains("sk-ant-"));
        assert!(text.contains("\"event\":\"started\""));
        assert!(text.contains("\"session\":\"sess-9\""));
        assert!(text.contains("\"window\":\"main\""));
        let value: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(value["level"], "info");
        assert_eq!(value["area"], "app");
    }

    #[test]
    fn two_writers_keep_whole_lines() {
        let dir = Scratch(scratch());
        let diag = open_with(&dir.0, day(2026, 11, 9), "sess").unwrap();
        let when = fixed_time();
        std::thread::scope(|scope| {
            for n in 0..2 {
                let diag = &diag;
                scope.spawn(move || {
                    for i in 0..40 {
                        assert!(diag.note_at(
                            when,
                            "info",
                            "app",
                            "tick",
                            &[("n", &format!("{n}-{i}"))]
                        ));
                    }
                });
            }
        });
        let text = fs::read_to_string(diag.logs.join(daily_name(day(2026, 11, 9)))).unwrap();
        let lines: Vec<_> = text.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(lines.len(), 80);
        for line in lines {
            serde_json::from_str::<serde_json::Value>(line).unwrap();
        }
    }

    #[test]
    fn the_report_reads_the_last_200_lines_and_the_crash_records() {
        let dir = Scratch(scratch());
        let logs = ensure_logs(&dir.0).unwrap();
        let mut body = String::new();
        for n in 0..250 {
            body.push_str(&format!("{{\"n\":{n}}}\n"));
        }
        fs::write(logs.join(daily_name(day(2026, 11, 9))), body).unwrap();
        let record = CrashRecord {
            time: "t".into(),
            thread: "main".into(),
            location: "here".into(),
            message: "broke".into(),
            version: "1".into(),
            os: "test-os".into(),
            session: "s".into(),
        };
        write_crash(&crashes_dir(&logs), &record, fixed_time(), KEEP_CRASHES).unwrap();
        let sources = read_sources(&logs, "1.2.3", "main @ abc", "test-os", "/Users/ada").unwrap();
        assert_eq!(sources.lines.len(), REPORT_LINES);
        assert!(sources.lines[0].contains("\"n\":50"));
        assert!(sources.lines.last().unwrap().contains("\"n\":249"));
        assert_eq!(sources.crashes.len(), 1);
        assert!(sources.crashes[0].contains("broke"));
        assert_eq!(sources.home, "/Users/ada");
        assert_eq!(sources.version, "1.2.3");
    }

    #[test]
    fn scratch_outside_temp_is_refused() {
        let err = remove_scratch(Path::new("/")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_log_is_left_out_of_the_report() {
        use std::os::unix::fs::symlink;
        let dir = Scratch(scratch());
        let logs = ensure_logs(&dir.0).unwrap();
        let outside = dir.0.join("outside.jsonl");
        fs::write(&outside, "secret prompt text that must not be read\n").unwrap();
        symlink(&outside, logs.join(daily_name(day(2026, 11, 9)))).unwrap();
        let sources = read_sources(&logs, "1", "b", "os", "").unwrap();
        assert!(sources.lines.is_empty());
        let joined = sources.lines.join("\n");
        assert!(!joined.contains("secret prompt"));
    }
}
