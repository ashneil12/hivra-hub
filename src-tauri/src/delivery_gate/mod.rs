//! Hivra WP-81: a local check before a crew's branch goes to GitHub.
//!
//! The no-mistakes binary is pinned (see `pinned_tool`), not ported: it is Go. Hivra starts
//! `daemon run --root` itself and stops that process on quit. It never runs `daemon start`, which
//! would install a login item. Every child gets `NM_TEST_START_DAEMON=1` so a race cannot install
//! one either. Dev copies use their own home and never a real git remote.

#[cfg(test)]
mod tests;

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::decisions::{self, AskInput};
use crate::delegations::{self, Delegation};
use crate::pr_watch::eval::Change;
use crate::session_store::{now_millis, SessionStore};

const INTENT_MAX: usize = 49_122;
const STALE: &str = "That setting changed in another window. Look again, then set it.";
const TRY_AGAIN: &str = "That didn't go through. Try again.";
const NOT_STARTED: &str = "The check couldn't be started. Try again.";
const STOPPED: &str = "The check was stopped because the app quit. It can be tried again.";

#[cfg(test)]
thread_local! {
    static FORCE_DEV: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
    static TEST_DATA: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn force_dev(on: Option<bool>) {
    FORCE_DEV.with(|cell| cell.set(on));
}

#[cfg(test)]
pub(crate) fn set_test_data_dir(dir: Option<PathBuf>) {
    TEST_DATA.with(|cell| *cell.borrow_mut() = dir);
}

/// A dev copy, or a test that asked to be treated as one. The daily app never reads
/// `MONOCODE_NO_MISTAKES`.
pub(crate) fn dev_copy() -> bool {
    #[cfg(test)]
    if let Some(forced) = FORCE_DEV.with(|cell| cell.get()) {
        return forced;
    }
    crate::instance::kind() == crate::instance::Kind::Dev
}

pub(crate) fn data_dir() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(dir) = TEST_DATA.with(|cell| cell.borrow().clone()) {
        return Ok(dir);
    }
    let identifier = crate::instance::current().identifier.clone();
    crate::instance::data_dir(&identifier)
        .ok_or_else(|| "Hivra has no data folder for the check.".to_string())
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS gate_settings (
           project TEXT PRIMARY KEY,
           enabled INTEGER NOT NULL DEFAULT 0,
           note TEXT,
           version INTEGER NOT NULL DEFAULT 1,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS gate_runs (
           id TEXT PRIMARY KEY,
           delegation_id TEXT,
           project TEXT NOT NULL,
           checkout TEXT,
           state TEXT NOT NULL,
           step TEXT,
           run_id TEXT,
           finding TEXT,
           finding_id TEXT,
           decision_key TEXT,
           pr_url TEXT,
           pr_repo TEXT,
           pr_number INTEGER,
           responded TEXT,
           detail TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           version INTEGER NOT NULL DEFAULT 1
         );
         CREATE TABLE IF NOT EXISTS gate_activity (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           kind TEXT NOT NULL,
           actor TEXT NOT NULL,
           initiator TEXT,
           project TEXT,
           target TEXT,
           summary TEXT NOT NULL,
           link TEXT,
           created_at INTEGER NOT NULL
         );",
    )
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingView {
    pub enabled: bool,
    pub version: i64,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub delegation_id: Option<String>,
    pub line: String,
    pub finding: Option<String>,
    pub decision_key: Option<String>,
    pub pr_url: Option<String>,
    pub state: String,
}

pub struct FillInput {
    pub project: String,
    pub checkout: PathBuf,
    pub delegation_id: Option<String>,
    pub goal: Option<String>,
    pub brief: Option<String>,
    pub title: String,
    pub body: String,
    pub owner_session: Option<String>,
    pub child_session: Option<String>,
    pub branch: String,
    pub now: i64,
}

pub struct FillResult {
    pub state: String,
    pub url: Option<String>,
    pub repo: Option<String>,
    pub number: Option<u64>,
    pub detail: Option<String>,
}

struct SettingRow {
    enabled: bool,
    note: Option<String>,
    version: i64,
}

fn project_key(project: &str) -> Result<String, String> {
    let key = crate::delivery::settings::key(project);
    if key.trim().is_empty() {
        return Err("Which project? Its folder is needed.".into());
    }
    Ok(key)
}

fn read_setting(conn: &Connection, project: &str) -> Result<Option<SettingRow>, String> {
    conn.query_row(
        "SELECT enabled, note, version FROM gate_settings WHERE project = ?1",
        [project],
        |row| {
            Ok(SettingRow {
                enabled: row.get::<_, i64>(0)? != 0,
                note: row.get(1)?,
                version: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// A code brief on a project whose delivery gate is on. WP-40 does not run that brief's checks.
/// no-mistakes runs them once, at delivery, and the task records that layer.
pub fn owns_project_checks(conn: &Connection, project: &str, delegation_id: &str) -> bool {
    if !enabled(conn, project).unwrap_or(false) {
        return false;
    }
    crate::firstmate::gates::plan_of(conn, delegation_id)
        .ok()
        .flatten()
        .is_some_and(|plan| {
            plan.gates
                .contains(&crate::firstmate::gates::GateKind::Checks)
        })
}

pub fn enabled(conn: &Connection, project: &str) -> Result<bool, String> {
    let key = project_key(project)?;
    Ok(read_setting(conn, &key)?.is_some_and(|row| row.enabled))
}

pub fn setting(conn: &Connection, project: &str) -> Result<SettingView, String> {
    let key = project_key(project)?;
    Ok(match read_setting(conn, &key)? {
        Some(row) => SettingView {
            enabled: row.enabled,
            version: row.version,
            note: row.note,
        },
        None => SettingView {
            enabled: false,
            version: 0,
            note: None,
        },
    })
}

fn changed_elsewhere(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn write_setting(
    conn: &Connection,
    project: &str,
    on: bool,
    note: Option<&str>,
    expected: i64,
    now: i64,
) -> Result<(), String> {
    let existing = read_setting(conn, project)?;
    let current = existing.as_ref().map(|row| row.version).unwrap_or(0);
    if current != expected {
        return Err(STALE.into());
    }
    let wrote = if existing.is_none() {
        conn.execute(
            "INSERT INTO gate_settings (project, enabled, note, version, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4)",
            params![project, on as i64, note, now],
        )
    } else {
        conn.execute(
            "UPDATE gate_settings SET enabled = ?2, note = ?3, version = version + 1, updated_at = ?4
             WHERE project = ?1 AND version = ?5",
            params![project, on as i64, note, now, expected],
        )
    };
    match wrote {
        Ok(0) => Err(STALE.into()),
        Ok(_) => Ok(()),
        Err(error) if changed_elsewhere(&error) => Err(STALE.into()),
        Err(error) => Err(error.to_string()),
    }
}

/// The socket path no-mistakes uses, and how long this system allows it to be.
pub fn socket_limit_for(os: &str) -> Option<usize> {
    match os {
        "macos" | "darwin" => Some(103),
        "linux" => Some(107),
        "windows" => None,
        _ => Some(103),
    }
}

pub fn socket_path(nm_home: &Path) -> PathBuf {
    nm_home.join("socket")
}

pub fn path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        path.to_string_lossy().into_owned().into_bytes()
    }
}

pub fn check_socket(nm_home: &Path, os: &str) -> Result<(), String> {
    let Some(limit) = socket_limit_for(os) else {
        return Ok(());
    };
    let path = socket_path(nm_home);
    let bytes = path_bytes(&path);
    if bytes.len() > limit {
        return Err(format!(
            "The check's socket path is {} bytes, and this system allows {limit}: {}",
            bytes.len(),
            path.display()
        ));
    }
    Ok(())
}

pub fn host_os_family() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        "windows" => "windows",
        _ => "macos",
    }
}

/// `~/Worktrees/pool` is the person's pool. Hivra never writes a check's pool there.
pub fn is_real_pool(path: &Path) -> bool {
    let parts: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    match parts.as_slice() {
        [.., parent, name] => parent == "Worktrees" && name == "pool",
        _ => false,
    }
}

pub fn agents_for(harness: Option<&str>) -> [&'static str; 2] {
    if harness.unwrap_or("").to_ascii_lowercase().contains("grok") {
        ["grok", "claude"]
    } else {
        ["claude", "grok"]
    }
}

fn yaml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Writes this home's `config.yaml`. The pool is `<home>/pool`, never the person's worktree pool.
pub fn write_config(nm_home: &Path, harness: Option<&str>) -> Result<(), String> {
    let pool = nm_home.join("pool");
    if is_real_pool(&pool) {
        return Err("A check never uses the real worktree pool.".into());
    }
    std::fs::create_dir_all(&pool).map_err(|e| e.to_string())?;
    let [first, second] = agents_for(harness);
    let body = format!(
        "agent:\n  - {}\n  - {}\nworktree_roots:\n  - {}\n",
        yaml_quote(first),
        yaml_quote(second),
        yaml_quote(&pool.to_string_lossy())
    );
    atomic_write(&nm_home.join("config.yaml"), body.as_bytes())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The check's home isn't a usable folder.".to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "The check's home isn't a usable folder.".to_string())?;
    let part = parent.join(format!(".{}.part", name.to_string_lossy()));
    if part.parent() != Some(parent) || path.parent() != Some(parent) {
        return Err("Refusing to write outside the check's home.".into());
    }
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let write = (|| {
        std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&part, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if write.is_err() && part.parent() == Some(parent) {
        let _ = std::fs::remove_file(&part);
    }
    write
}

pub fn intent_text(goal: Option<&str>, brief: Option<&str>) -> String {
    fn clean(value: &str) -> String {
        scrub(value).replace("\r\n", "\n").replace('\r', "\n")
    }
    let goal = goal
        .map(clean)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let brief = brief
        .map(clean)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let mut parts = Vec::new();
    if let Some(goal) = goal {
        parts.push(goal);
    }
    if let Some(brief) = brief {
        if parts.iter().all(|part| part != &brief) {
            parts.push(brief);
        }
    }
    let mut text = if parts.is_empty() {
        "Deliver the crew's finished work.".to_string()
    } else {
        parts.join("\n\n")
    };
    if text.len() > INTENT_MAX {
        let mut end = INTENT_MAX;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// A remote Hivra must not name from a dev copy. `file:` and a local path are not real.
/// `git@`, `user@host:path`, and any other `://` are.
pub fn real_remote(url: &str) -> bool {
    let url = url.trim();
    if url.is_empty() {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("file:") {
        return false;
    }
    if lower.contains("://") {
        return true;
    }
    if let Some((user, rest)) = url.split_once('@') {
        if !user.is_empty()
            && !user.contains(['/', '\\', ':'])
            && rest.contains(':')
            && !rest.starts_with(':')
        {
            return true;
        }
    }
    false
}

pub fn refuse_real_remotes(dev: bool, urls: &[String]) -> Result<(), String> {
    if !dev {
        return Ok(());
    }
    if let Some(url) = urls.iter().find(|url| real_remote(url)) {
        return Err(format!("A dev copy never uses a real remote ({url})."));
    }
    Ok(())
}

pub fn daemon_args(nm_home: &Path) -> Vec<String> {
    vec![
        "daemon".into(),
        "run".into(),
        "--root".into(),
        nm_home.to_string_lossy().into_owned(),
    ]
}

pub fn checking_line(step: &str) -> String {
    match step.trim().to_ascii_lowercase().as_str() {
        "test" | "tests" => "checking: tests".into(),
        "document" | "docs" | "doc" => "checking: docs".into(),
        "pr" | "pull request" => "checking: the pull request".into(),
        "" => "checking: the work".into(),
        other => format!("checking: {other}"),
    }
}

pub fn parse_status(text: &str) -> String {
    let text = text.trim().trim_start_matches('\u{feff}');
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(step) = value.get("step").and_then(|step| step.as_str()) {
            return step.trim().to_string();
        }
    }
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line
            .strip_prefix("step:")
            .or_else(|| line.strip_prefix("checking:"))
        {
            return rest.trim().to_string();
        }
    }
    String::new()
}

/// Check failures are no-mistakes' to repair. A remark or a conflict still wakes Hivra.
pub fn wake_changes(changes: &[Change], through_gate: bool) -> Vec<Change> {
    if !through_gate {
        return changes.to_vec();
    }
    changes
        .iter()
        .filter(|change| {
            !matches!(
                change,
                Change::ChecksFailed(_) | Change::ChecksPassed { .. }
            )
        })
        .cloned()
        .collect()
}

/// The token shapes a command's last lines must not carry. WP-102: OpenMausBot's shared/redact.ts (Apache-2.0) named
/// the gaps this list had; the patterns here are written from each token's documented shape. `code=` is not a prefix but
/// a query value, so it is handled apart from this list.
static SECRET_SHAPES: OnceLock<regex::Regex> = OnceLock::new();

fn secret_shapes() -> &'static regex::Regex {
    SECRET_SHAPES.get_or_init(|| {
        // One alternation, most specific first, so the marker lands in the same place either way.
        regex::Regex::new(concat!(
            r"(?:\bghp_|\bgithub_pat_|\bsk-|\bBearer\s",
            r"|\bgl(?:pat|dt|rtr?)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*",
            r"|\bpypi-AgE[A-Za-z0-9_-]{40,}",
            r"|\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}",
            r"|\bxapp-[A-Za-z0-9-]{20,}",
            r"|\bwhsec_[A-Za-z0-9_-]{20,}",
            r"|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b)",
        ))
        .expect("the scrubber's shapes compile")
    })
}

fn scrub(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut index = 0;
    // A private key's body goes; its header and footer stay, so a reader knows what it was.
    let mut in_key_body = false;
    while index < bytes.len() {
        let rest = &text[index..];
        let line_end = rest.find('\n').map_or(rest.len(), |at| at + 1);
        let line = &rest[..line_end];
        if in_key_body {
            if rest.starts_with("-----END ") {
                in_key_body = false;
            } else {
                // The body's shape goes, its line breaks stay, so the header and footer keep their places.
                if line.ends_with("\r\n") {
                    out.push_str("\r\n");
                } else if line.ends_with('\n') {
                    out.push('\n');
                }
                index += line_end;
                continue;
            }
        } else if rest.starts_with("-----BEGIN ") && line.contains("PRIVATE KEY-----") {
            // The header goes whole, before the body flag would make the rest of its line look like body.
            in_key_body = true;
            out.push_str(line);
            index += line_end;
            continue;
        }
        if let Some(found) = secret_shapes().find(rest) {
            if found.start() == 0 {
                out.push_str("[redacted]");
                index += found.end();
                while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
                    index += 1;
                }
                continue;
            }
        }
        // `code=` in a query string is a sign-in code: it goes when it is long enough to be one, and prose stays.
        if let Some(value) = rest.strip_prefix("code=") {
            let end = value
                .find(|c: char| c.is_ascii_whitespace() || c == '&' || c == '"' || c == '\'')
                .unwrap_or(value.len());
            let token = &value[..end];
            if token.len() >= 8
                && token.chars().any(|c| c.is_ascii_digit())
                && token.chars().any(|c| c.is_ascii_alphabetic())
            {
                out.push_str("code=[redacted]");
                index += "code=".len() + end;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap_or('\0');
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn nm_home_at(data: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let root = crate::fs::canonical(data).map_err(|e| e.to_string())?;
    let home = root.join("nm");
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let home = crate::fs::canonical(&home).map_err(|e| e.to_string())?;
    if !home.starts_with(&root) {
        return Err("Refusing to write outside Hivra's data folder.".into());
    }
    let meta = std::fs::symlink_metadata(&home).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("The check's home is a link, so it was refused.".into());
    }
    Ok(home)
}

/// The stand-in, and only on a dev copy. A daily copy ignores `MONOCODE_NO_MISTAKES`.
fn stand_in_program() -> Option<PathBuf> {
    if !dev_copy() {
        return None;
    }
    std::env::var_os("MONOCODE_NO_MISTAKES")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

fn tool_program(data: &Path) -> Result<PathBuf, String> {
    if let Some(path) = stand_in_program() {
        return Ok(path);
    }
    crate::pinned_tool::install(
        &crate::pinned_tool::NO_MISTAKES,
        data,
        crate::pinned_tool::host_os(),
        crate::pinned_tool::host_arch(),
        &crate::pinned_tool::UreqFetcher,
    )
}

fn tool_command(program: &Path, nm_home: &Path) -> Command {
    let mut command = crate::delivery::child(program);
    command.env("NM_HOME", nm_home);
    command.env("NM_TEST_START_DAEMON", "1");
    command.env("NO_MISTAKES_NO_UPDATE_CHECK", "1");
    command.env("NO_MISTAKES_TELEMETRY", "0");
    command.stdin(Stdio::null());
    command
}

/// Keys a check's child may see. Values are not logged.
pub fn tool_env_keys() -> Vec<String> {
    let mut keys: Vec<String> = crate::delivery::CHILD_ENV
        .iter()
        .filter(|key| std::env::var_os(key).is_some())
        .map(|key| (*key).to_string())
        .collect();
    keys.push("PATH".into());
    keys.push("NM_HOME".into());
    keys.push("NM_TEST_START_DAEMON".into());
    keys.push("NO_MISTAKES_NO_UPDATE_CHECK".into());
    keys.push("NO_MISTAKES_TELEMETRY".into());
    keys.sort();
    keys.dedup();
    keys
}

struct ScriptedRun {
    outcome: String,
    run_id: String,
    step: String,
    finding: String,
    finding_id: String,
    pr_url: Option<String>,
    pr_repo: Option<String>,
    pr_number: Option<u64>,
}

struct Script {
    log: Option<PathBuf>,
    run: Option<ScriptedRun>,
    status: String,
    init: String,
    respond: String,
}

fn is_stand_in(path: &Path) -> bool {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut buf = [0u8; 16];
    let read = file.read(&mut buf).unwrap_or(0);
    buf[..read].starts_with(b"#!hivra-stand-in")
}

fn load_script(path: &Path) -> Result<Script, String> {
    let text = std::fs::read_to_string(path).map_err(|_| NOT_STARTED.to_string())?;
    let mut script = Script {
        log: None,
        run: None,
        status: String::new(),
        init: String::new(),
        respond: String::new(),
    };
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with("#!") || line.starts_with('#') && !line.contains('=')
        {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "log" => {
                let log = PathBuf::from(value.trim());
                if !log.is_absolute() || log.components().any(|c| matches!(c, Component::ParentDir))
                {
                    return Err("The stand-in's log path isn't usable.".into());
                }
                script.log = Some(log);
            }
            "run" => {
                let value = serde_json::from_str::<serde_json::Value>(value.trim())
                    .map_err(|_| NOT_STARTED.to_string())?;
                script.run = Some(ScriptedRun {
                    outcome: value
                        .get("outcome")
                        .and_then(|v| v.as_str())
                        .unwrap_or("running")
                        .to_string(),
                    run_id: value
                        .get("runId")
                        .or_else(|| value.get("run_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    step: value
                        .get("step")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    finding: value
                        .get("finding")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    finding_id: value
                        .get("findingId")
                        .or_else(|| value.get("finding_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    pr_url: value
                        .get("prUrl")
                        .or_else(|| value.get("pr_url"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    pr_repo: value
                        .get("prRepo")
                        .or_else(|| value.get("pr_repo"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    pr_number: value
                        .get("prNumber")
                        .or_else(|| value.get("pr_number"))
                        .and_then(|v| v.as_u64()),
                });
            }
            "status" => script.status = value.trim().to_string(),
            "init" => script.init = value.trim().to_string(),
            "respond" => script.respond = value.trim().to_string(),
            _ => {}
        }
    }
    Ok(script)
}

fn log_call(script: &Script, args: &[String]) {
    let Some(path) = &script.log else {
        return;
    };
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return;
    }
    let line = serde_json::json!({
        "args": args,
        "env": tool_env_keys(),
    });
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(file) => file,
        Err(_) => return,
    };
    use std::io::Write;
    let _ = writeln!(file, "{line}");
}

struct ToolDone {
    stdout: String,
    run: Option<ScriptedRun>,
}

fn invoke(
    program: &Path,
    nm_home: &Path,
    args: &[String],
    dir: Option<&Path>,
) -> Result<ToolDone, String> {
    if is_stand_in(program) {
        let script = load_script(program)?;
        log_call(&script, args);
        let stdout = match (
            args.first().map(String::as_str),
            args.get(1).map(String::as_str),
        ) {
            (Some("init"), _) => script.init.clone(),
            (Some("daemon"), _) => String::new(),
            (Some("axi"), Some("status")) => script.status.clone(),
            (Some("axi"), Some("respond")) => script.respond.clone(),
            (Some("axi"), Some("run")) => String::new(),
            _ => return Err(NOT_STARTED.into()),
        };
        let run = if args.first().map(String::as_str) == Some("axi")
            && args.get(1).map(String::as_str) == Some("run")
        {
            script.run
        } else {
            None
        };
        return Ok(ToolDone { stdout, run });
    }
    let mut command = tool_command(program, nm_home);
    command.args(args);
    if let Some(dir) = dir {
        command.current_dir(dir);
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // `axi run` can take minutes. Start it and keep the child so quit can stop it.
    // A timeout is not a final failure: the row stays "checking" until the run is read.
    if args.first().map(String::as_str) == Some("axi")
        && args.get(1).map(String::as_str) == Some("run")
    {
        let child = command.spawn().map_err(|_| NOT_STARTED.to_string())?;
        live()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(LiveChild {
                child,
                db: None,
                row_id: None,
            });
        return Ok(ToolDone {
            stdout: String::new(),
            run: None,
        });
    }
    let output = command.output().map_err(|_| NOT_STARTED.to_string())?;
    if !output.status.success() {
        return Err(TRY_AGAIN.into());
    }
    Ok(ToolDone {
        stdout: scrub(&String::from_utf8_lossy(&output.stdout)),
        run: None,
    })
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::delivery::child("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|_| TRY_AGAIN.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(scrub(&String::from_utf8_lossy(&output.stderr))
            .trim()
            .to_string())
    }
}

fn remote_urls(dir: &Path) -> Vec<String> {
    let Ok(text) = git(dir, &["remote", "-v"]) else {
        return Vec::new();
    };
    let mut urls = Vec::new();
    for line in text.lines() {
        let Some((_, rest)) = line.split_once('\t').or_else(|| line.split_once(' ')) else {
            continue;
        };
        let url = rest.split_whitespace().next().unwrap_or(rest).trim();
        if !url.is_empty() && !urls.iter().any(|have| have == url) {
            urls.push(url.to_string());
        }
    }
    urls
}

fn remove_gate_remote(dir: &Path) -> Result<(), String> {
    match git(dir, &["remote", "remove", "no-mistakes"]) {
        Ok(_) => Ok(()),
        Err(error) if error.to_ascii_lowercase().contains("no such remote") => Ok(()),
        Err(_) => Err(TRY_AGAIN.into()),
    }
}

struct LiveChild {
    child: Child,
    db: Option<PathBuf>,
    row_id: Option<String>,
}

fn live() -> &'static Mutex<Vec<LiveChild>> {
    static LIVE: OnceLock<Mutex<Vec<LiveChild>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Starts `daemon run --root` when the tool is a real binary, and never `daemon start`.
pub fn ensure_daemon(program: &Path, nm_home: &Path) -> Result<(), String> {
    if is_stand_in(program) {
        invoke(program, nm_home, &daemon_args(nm_home), None)?;
        return Ok(());
    }
    let mut guard = live().lock().unwrap_or_else(|err| err.into_inner());
    guard.retain_mut(|live| !matches!(live.child.try_wait(), Ok(Some(_))));
    let mut command = tool_command(program, nm_home);
    command.args(daemon_args(nm_home));
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());
    let child = command.spawn().map_err(|_| NOT_STARTED.to_string())?;
    guard.push(LiveChild {
        child,
        db: None,
        row_id: None,
    });
    Ok(())
}

fn mark_stopped(conn: &Connection, row_id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE gate_runs SET state = 'stopped', detail = ?2, updated_at = ?3
         WHERE id = ?1 AND state = 'checking'",
        params![row_id, STOPPED, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stops every daemon and check Hivra started. A killed check is not a final failure.
pub fn stop_daemons() {
    let mut guard = live().lock().unwrap_or_else(|err| err.into_inner());
    let now = now_millis();
    for mut item in guard.drain(..) {
        let _ = item.child.kill();
        let _ = item.child.wait();
        if let (Some(db), Some(row)) = (item.db, item.row_id) {
            if let Ok(conn) = Connection::open(db) {
                let _ = conn.busy_timeout(Duration::from_secs(2));
                let _ = mark_stopped(&conn, &row, now);
            }
        }
    }
}

fn session_harness(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT harness FROM sessions WHERE id = ?1", [id], |row| {
        row.get::<_, Option<String>>(0)
    })
    .optional()
    .ok()
    .flatten()
    .flatten()
}

struct Activity<'a> {
    kind: &'a str,
    initiator: Option<&'a str>,
    project: &'a str,
    target: Option<&'a str>,
    summary: &'a str,
    link: Option<&'a str>,
    now: i64,
}

/// The project's check command is the gate's Test step (`.no-mistakes.yaml`). Named check ids, when
/// the brief has them, are kept in the record so the handoff is not a silent skip.
fn record_check_layer(conn: &Connection, input: &FillInput, project: &str) -> Result<(), String> {
    let Some(id) = input.delegation_id.as_deref() else {
        return Ok(());
    };
    if !owns_project_checks(conn, project, id) {
        return Ok(());
    }
    let named = crate::firstmate::gates::plan_of(conn, id)
        .ok()
        .flatten()
        .map(|plan| plan.checks)
        .unwrap_or_default();
    let summary = if named.is_empty() {
        "The no-mistakes layer ran the project's checks (npm run check).".to_string()
    } else {
        format!(
            "The no-mistakes layer ran the project's checks (npm run check): {}.",
            named.join(", ")
        )
    };
    record_activity(
        conn,
        Activity {
            kind: "gate.checks",
            initiator: input.owner_session.as_deref(),
            project,
            target: Some(id),
            summary: &summary,
            link: None,
            now: input.now,
        },
    )
}

fn record_activity(conn: &Connection, activity: Activity<'_>) -> Result<(), String> {
    conn.execute(
        "INSERT INTO gate_activity (kind, actor, initiator, project, target, summary, link, created_at)
         VALUES (?1, 'gate', ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            activity.kind,
            activity.initiator,
            activity.project,
            activity.target,
            scrub(activity.summary),
            activity.link.map(scrub),
            activity.now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

struct RunRow {
    id: String,
    delegation_id: Option<String>,
    project: String,
    state: String,
    step: Option<String>,
    run_id: Option<String>,
    finding: Option<String>,
    finding_id: Option<String>,
    decision_key: Option<String>,
    pr_url: Option<String>,
    responded: Option<String>,
    detail: Option<String>,
}

fn run_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    Ok(RunRow {
        id: row.get(0)?,
        delegation_id: row.get(1)?,
        project: row.get(2)?,
        state: row.get(3)?,
        step: row.get(4)?,
        run_id: row.get(5)?,
        finding: row.get(6)?,
        finding_id: row.get(7)?,
        decision_key: row.get(8)?,
        pr_url: row.get(9)?,
        responded: row.get(12)?,
        detail: row.get(13)?,
    })
}

const RUN_COLS: &str = "id, delegation_id, project, state, step, run_id, finding, finding_id, \
     decision_key, pr_url, pr_repo, pr_number, responded, detail";

fn question_for(finding: &str) -> String {
    let finding = scrub(finding);
    let finding = finding.trim();
    if finding.is_empty() {
        "The check needs a decision before this can go to GitHub.".into()
    } else {
        format!("The check needs a decision: {finding}")
    }
}

fn delegation_of(conn: &Connection, id: &str) -> Option<Delegation> {
    delegations::get(conn, id).ok().flatten()
}

fn ask_decision(
    conn: &mut Connection,
    input: &FillInput,
    project: &str,
    run_id: &str,
    finding: &str,
    now: i64,
) -> Result<String, String> {
    let key = format!("gate/{run_id}");
    let question = question_for(finding);
    let mut asked_by = input
        .owner_session
        .clone()
        .filter(|session| !session.trim().is_empty())
        .unwrap_or_else(|| "gate".into());
    if decisions::check_may_ask(conn, &asked_by).is_err() {
        asked_by = "gate".into();
    }
    let mut task_ids = Vec::new();
    if asked_by != "gate" {
        if let Some(id) = &input.delegation_id {
            if let Some(row) = delegation_of(conn, id) {
                if row.owner_session == asked_by
                    && matches!(
                        row.state.as_str(),
                        delegations::RUNNING | delegations::QUESTION
                    )
                {
                    task_ids.push(row.id);
                }
            }
        }
    }
    let attempt = decisions::ask(
        conn,
        AskInput {
            asked_by: asked_by.clone(),
            asked_by_mono: None,
            project: Some(project.to_string()),
            key: key.clone(),
            question: question.clone(),
            options: vec!["Approve".into(), "Fix".into(), "Skip".into()],
            recommended: None,
            task_ids: task_ids.clone(),
        },
        now,
    );
    if attempt.is_err() && !task_ids.is_empty() {
        decisions::ask(
            conn,
            AskInput {
                asked_by,
                asked_by_mono: None,
                project: Some(project.to_string()),
                key,
                question,
                options: vec!["Approve".into(), "Fix".into(), "Skip".into()],
                recommended: None,
                task_ids: Vec::new(),
            },
            now,
        )?;
    } else {
        attempt?;
    }
    Ok(format!("gate/{run_id}"))
}

fn apply_scripted(
    conn: &mut Connection,
    input: &FillInput,
    project: &str,
    row_id: &str,
    scripted: &ScriptedRun,
    now: i64,
) -> Result<FillResult, String> {
    let run_id = if scripted.run_id.trim().is_empty() {
        row_id.to_string()
    } else {
        scrub(&scripted.run_id)
    };
    let step = scrub(&scripted.step);
    let finding = scrub(&scripted.finding);
    let outcome = scripted.outcome.trim().to_ascii_lowercase();
    record_activity(
        conn,
        Activity {
            kind: "gate.started",
            initiator: input.owner_session.as_deref(),
            project,
            target: input.delegation_id.as_deref(),
            summary: &format!("The check started on {}.", input.branch),
            link: None,
            now,
        },
    )?;
    match outcome.as_str() {
        "parked" => {
            let decision_key = ask_decision(conn, input, project, &run_id, &finding, now)?;
            conn.execute(
                "UPDATE gate_runs SET state = 'parked', step = ?2, run_id = ?3, finding = ?4, finding_id = ?5,
                 decision_key = ?6, detail = ?7, updated_at = ?8 WHERE id = ?1 AND state = 'checking'",
                params![row_id, step, run_id, finding, scripted.finding_id, decision_key, question_for(&finding), now],
            )
            .map_err(|e| e.to_string())?;
            record_activity(
                conn,
                Activity {
                    kind: "gate.parked",
                    initiator: input.owner_session.as_deref(),
                    project,
                    target: Some(&decision_key),
                    summary: &question_for(&finding),
                    link: None,
                    now,
                },
            )?;
            Ok(FillResult {
                state: "parked".into(),
                url: None,
                repo: None,
                number: None,
                detail: Some(question_for(&finding)),
            })
        }
        "passed" => {
            conn.execute(
                "UPDATE gate_runs SET state = 'passed', step = ?2, run_id = ?3, pr_url = ?4, pr_repo = ?5,
                 pr_number = ?6, detail = ?7, updated_at = ?8 WHERE id = ?1 AND state = 'checking'",
                params![
                    row_id,
                    step,
                    run_id,
                    scripted.pr_url,
                    scripted.pr_repo,
                    scripted.pr_number.map(|n| n as i64),
                    "The check passed.",
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
            record_activity(
                conn,
                Activity {
                    kind: "gate.passed",
                    initiator: input.owner_session.as_deref(),
                    project,
                    target: input.delegation_id.as_deref(),
                    summary: "The check passed.",
                    link: scripted.pr_url.as_deref(),
                    now,
                },
            )?;
            if scripted.pr_url.is_some() {
                record_activity(
                    conn,
                    Activity {
                        kind: "gate.pr-opened",
                        initiator: input.owner_session.as_deref(),
                        project,
                        target: input.delegation_id.as_deref(),
                        summary: "A pull request was opened.",
                        link: scripted.pr_url.as_deref(),
                        now,
                    },
                )?;
            }
            Ok(FillResult {
                state: "passed".into(),
                url: scripted.pr_url.clone(),
                repo: scripted.pr_repo.clone(),
                number: scripted.pr_number,
                detail: Some("The check passed.".into()),
            })
        }
        "retry" | "error" => {
            conn.execute(
                "UPDATE gate_runs SET step = ?2, run_id = ?3, detail = ?4, updated_at = ?5
                 WHERE id = ?1 AND state = 'checking'",
                params![row_id, step, run_id, TRY_AGAIN, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(FillResult {
                state: "checking".into(),
                url: None,
                repo: None,
                number: None,
                detail: Some(TRY_AGAIN.into()),
            })
        }
        _ => {
            let line = checking_line(if step.is_empty() { "the work" } else { &step });
            conn.execute(
                "UPDATE gate_runs SET step = ?2, run_id = ?3, detail = ?4, updated_at = ?5
                 WHERE id = ?1 AND state = 'checking'",
                params![row_id, step, run_id, line, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(FillResult {
                state: "checking".into(),
                url: None,
                repo: None,
                number: None,
                detail: Some(line),
            })
        }
    }
}

fn insert_run(conn: &Connection, input: &FillInput, project: &str, id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO gate_runs (
            id, delegation_id, project, checkout, state, created_at, updated_at, version
         ) VALUES (?1, ?2, ?3, ?4, 'checking', ?5, ?5, 1)",
        params![
            id,
            input.delegation_id,
            project,
            input.checkout.to_string_lossy().to_string(),
            input.now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Runs the check instead of pushing. A dev copy is refused before the tool is started when any
/// remote is a real one.
pub fn fill(store: &SessionStore, input: FillInput) -> Result<FillResult, String> {
    let project = project_key(&input.project)?;
    let data = data_dir()?;
    let home = nm_home_at(&data)?;
    check_socket(&home, host_os_family())?;
    let program = tool_program(&data)?;
    let mut urls = remote_urls(Path::new(&project));
    urls.extend(remote_urls(&input.checkout));
    refuse_real_remotes(dev_copy(), &urls)?;
    let harness = {
        let conn = store.lock_conn()?;
        input
            .child_session
            .as_deref()
            .and_then(|id| session_harness(&conn, id))
    };
    write_config(&home, harness.as_deref())?;
    ensure_daemon(&program, &home)?;
    let intent = intent_text(input.goal.as_deref(), input.brief.as_deref());
    let safe_branch: String = input
        .branch
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let body_file = home.join(format!("pr-body-{safe_branch}.md"));
    if body_file.parent() != Some(home.as_path()) {
        return Err("Refusing to write outside the check's home.".into());
    }
    std::fs::write(&body_file, &input.body).map_err(|e| e.to_string())?;
    let args = vec![
        "axi".into(),
        "run".into(),
        "--yes".into(),
        "--intent".into(),
        intent,
        "--pr-title".into(),
        input.title.clone(),
        "--pr-body-file".into(),
        body_file.to_string_lossy().into_owned(),
    ];
    let row_id = format!("gr_{}", uuid::Uuid::new_v4().simple());
    {
        let conn = store.lock_conn()?;
        insert_run(&conn, &input, &project, &row_id)?;
    }
    let done = invoke(&program, &home, &args, Some(&input.checkout))?;
    {
        let conn = store.lock_conn()?;
        record_check_layer(&conn, &input, &project)?;
    }
    let Some(scripted) = done.run else {
        return Ok(FillResult {
            state: "checking".into(),
            url: None,
            repo: None,
            number: None,
            detail: Some(checking_line(&parse_status(&done.stdout))),
        });
    };
    let mut conn = store.lock_conn()?;
    apply_scripted(&mut conn, &input, &project, &row_id, &scripted, input.now)
}

pub fn set_enabled(
    store: &SessionStore,
    project: &str,
    on: bool,
    expected_version: i64,
    now: i64,
) -> Result<SettingView, String> {
    let project = project_key(project)?;
    {
        let conn = store.lock_conn()?;
        let current = read_setting(&conn, &project)?
            .map(|row| row.version)
            .unwrap_or(0);
        if current != expected_version {
            return Err(STALE.into());
        }
    }
    let data = data_dir()?;
    let home = nm_home_at(&data)?;
    let note = if on {
        check_socket(&home, host_os_family())?;
        let program = tool_program(&data)?;
        let urls = remote_urls(Path::new(&project));
        refuse_real_remotes(dev_copy(), &urls)?;
        write_config(&home, None)?;
        ensure_daemon(&program, &home)?;
        let done = invoke(&program, &home, &["init".into()], Some(Path::new(&project)))?;
        let text = scrub(&done.stdout);
        let text = text.trim();
        if text.is_empty() {
            Some("Turned the check on.".to_string())
        } else {
            Some(text.to_string())
        }
    } else {
        remove_gate_remote(Path::new(&project))?;
        Some("Removed the no-mistakes remote.".to_string())
    };
    {
        let conn = store.lock_conn()?;
        write_setting(&conn, &project, on, note.as_deref(), expected_version, now)?;
    }
    let conn = store.lock_conn()?;
    setting(&conn, &project)
}

fn action_of(answer: &str) -> Result<&'static str, String> {
    match answer.trim().to_ascii_lowercase().as_str() {
        "approve" => Ok("approve"),
        "fix" => Ok("fix"),
        "skip" => Ok("skip"),
        _ => Err("The answer has to be approve, fix or skip.".into()),
    }
}

fn run_by_key(conn: &Connection, key: &str) -> Result<Option<RunRow>, String> {
    conn.query_row(
        &format!("SELECT {RUN_COLS} FROM gate_runs WHERE decision_key = ?1 ORDER BY created_at DESC LIMIT 1"),
        [key],
        run_from,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Sends an answer the person already gave. A second send of the same answer does nothing.
/// A tool that doesn't answer is not final: it can be tried again.
pub fn forward_answer(store: &SessionStore, key: &str, answer: &str) -> Result<(), String> {
    if !crate::decisions::fold_key(key).starts_with("gate/") {
        return Ok(());
    }
    let action = action_of(answer)?;
    let data = data_dir()?;
    let home = nm_home_at(&data)?;
    let (run_id, finding_id, project) = {
        let conn = store.lock_conn()?;
        let Some(run) = run_by_key(&conn, key)? else {
            return Ok(());
        };
        if run.responded.as_deref() == Some(action) {
            return Ok(());
        }
        let claimed = conn
            .execute(
                "UPDATE gate_runs SET responded = 'sending', updated_at = ?2
                 WHERE decision_key = ?1 AND (responded IS NULL OR responded = 'retry')",
                params![key, now_millis()],
            )
            .map_err(|e| e.to_string())?;
        if claimed == 0 {
            return Ok(());
        }
        (
            run.run_id.unwrap_or_default(),
            run.finding_id.unwrap_or_default(),
            run.project,
        )
    };
    let program = match tool_program(&data) {
        Ok(program) => program,
        Err(_) => {
            let conn = store.lock_conn()?;
            let _ = conn.execute(
                "UPDATE gate_runs SET responded = 'retry', detail = ?2, updated_at = ?3 WHERE decision_key = ?1",
                params![key, TRY_AGAIN, now_millis()],
            );
            return Err(TRY_AGAIN.into());
        }
    };
    let mut args = vec![
        "axi".into(),
        "respond".into(),
        "--run".into(),
        run_id,
        "--action".into(),
        action.into(),
        "--wait".into(),
        "0".into(),
    ];
    if action == "fix" {
        args.push("--findings".into());
        args.push(finding_id);
    }
    match invoke(&program, &home, &args, Some(Path::new(&project))) {
        Ok(_) => {
            let conn = store.lock_conn()?;
            conn.execute(
                "UPDATE gate_runs SET responded = ?2, updated_at = ?3 WHERE decision_key = ?1 AND responded = 'sending'",
                params![key, action, now_millis()],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(_) => {
            let conn = store.lock_conn()?;
            let _ = conn.execute(
                "UPDATE gate_runs SET responded = 'retry', detail = ?2, updated_at = ?3 WHERE decision_key = ?1",
                params![key, TRY_AGAIN, now_millis()],
            );
            Err(TRY_AGAIN.into())
        }
    }
}

pub fn cards(conn: &Connection, project: &str) -> Result<Vec<Card>, String> {
    let project = project_key(project)?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT {RUN_COLS} FROM gate_runs WHERE project = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 20"
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([project], run_from)
        .map_err(|e| e.to_string())?;
    let mut cards = Vec::new();
    for row in rows {
        let row = row.map_err(|e| e.to_string())?;
        let step = row.step.unwrap_or_default();
        let line = match row.state.as_str() {
            "parked" => row
                .finding
                .clone()
                .filter(|finding| !finding.trim().is_empty())
                .unwrap_or_else(|| {
                    "The check needs a decision before this can go to GitHub.".into()
                }),
            "passed" => "The check passed.".into(),
            "stopped" => row.detail.clone().unwrap_or_else(|| STOPPED.into()),
            "checking" if step.is_empty() => row
                .detail
                .clone()
                .filter(|detail| !detail.is_empty())
                .unwrap_or_else(|| checking_line("")),
            _ => checking_line(&step),
        };
        cards.push(Card {
            id: row.id,
            delegation_id: row.delegation_id,
            line,
            finding: row.finding,
            decision_key: row.decision_key,
            pr_url: row.pr_url,
            state: row.state,
        });
    }
    Ok(cards)
}

#[tauri::command(async)]
pub fn gate_setting_get(
    store: State<'_, SessionStore>,
    project: String,
) -> Result<SettingView, String> {
    setting(&*store.lock_conn()?, &project)
}

#[tauri::command(async)]
pub fn gate_setting_set(
    store: State<'_, SessionStore>,
    project: String,
    enabled: bool,
    expected_version: i64,
) -> Result<SettingView, String> {
    set_enabled(&store, &project, enabled, expected_version, now_millis())
}

#[tauri::command(async)]
pub fn gate_cards(store: State<'_, SessionStore>, project: String) -> Result<Vec<Card>, String> {
    cards(&*store.lock_conn()?, &project)
}

#[tauri::command(async)]
pub fn gate_respond(
    store: State<'_, SessionStore>,
    decision_key: String,
    answer: String,
) -> Result<(), String> {
    let project = {
        let conn = store.lock_conn()?;
        run_by_key(&conn, &decision_key)?.map(|run| run.project)
    };
    if let Some(project) = project {
        let _ = decisions::answer(
            &mut *store.lock_conn()?,
            &project,
            &decision_key,
            &answer,
            Some("person".into()),
            now_millis(),
        );
    }
    forward_answer(&store, &decision_key, &answer)
}
