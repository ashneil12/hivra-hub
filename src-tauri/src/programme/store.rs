//! Programme rows in the app database. One project, one board. A write names the version it read.

use rusqlite::{params, Connection, ErrorCode, OptionalExtension, Row, TransactionBehavior};
use serde::Serialize;

/// Open rows (queued, building, in review, parked) a programme may hold. Merged and failed rows do not count.
pub(crate) const ROW_MAX: usize = 400;
/// Rows one list call returns at most.
pub(crate) const LIST_MAX: usize = 400;
pub(crate) const NOTE_MAX: usize = 2_000;
const PATH_MAX: usize = 500;
const TITLE_MAX: usize = 300;
const WP_MAX: usize = 40;
const BRANCH_MAX: usize = 200;
const REASON_MAX: usize = 500;
const PROJECT_MAX: usize = 1_000;
const PRIORITY_MAX: i64 = 1_000;

pub const CHANGED: &str = "programme://changed";

/// What a worker hears. A worker does not read or change the programme.
pub const WORKER_REASON: &str =
    "Only the first mate can change the programme. You are a worker here: tell your first mate what to queue, in your report.";

const PARKED_STAYS: &str = "This package stays parked until the person clears it.";
const SECURITY_STAYS: &str =
    "This package is parked for a security check. It stays parked until the person clears it.";
const STALE: &str = "That package changed. Read it again and retry.";
const MISSING: &str = "No package with that id.";
const PERSON_CLEARS: &str = "Parked packages stay parked until the person clears them.";

const COLUMNS: &str = "id, project_id, wp, title, brief_path, branch, status, security_park, priority, notes, park_reason, version, created_at, updated_at, claimed_at, finished_at";

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS programme_packages (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           wp TEXT NOT NULL,
           title TEXT NOT NULL,
           brief_path TEXT NOT NULL,
           branch TEXT NOT NULL,
           status TEXT NOT NULL,
           security_park INTEGER NOT NULL DEFAULT 0,
           priority INTEGER NOT NULL DEFAULT 0,
           notes TEXT NOT NULL DEFAULT '',
           park_reason TEXT,
           version INTEGER NOT NULL DEFAULT 1,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           claimed_at INTEGER,
           finished_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS programme_packages_project
           ON programme_packages(project_id, priority DESC, created_at, id);",
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actor {
    pub id: String,
    pub project: String,
    pub kind: String,
}

#[derive(Clone, Debug)]
pub struct EnqueueInput {
    pub wp: String,
    pub title: String,
    pub brief_path: String,
    pub branch: String,
    pub priority: Option<i64>,
    pub notes: Option<String>,
    pub security_park: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub id: String,
    pub project_id: String,
    pub wp: String,
    pub title: String,
    pub brief_path: String,
    pub branch: String,
    pub status: String,
    pub security_park: bool,
    pub priority: i64,
    pub notes: String,
    pub park_reason: Option<String>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub claimed_at: Option<i64>,
    pub finished_at: Option<i64>,
}

/// The board without merged rows, at most `LIST_MAX`.
pub fn list(conn: &Connection, actor: &Actor) -> Result<Vec<Package>, String> {
    list_with(conn, actor, false, LIST_MAX)
}

/// The board, in priority order. Merged rows come back only when asked; at most `limit` rows.
pub(crate) fn list_with(
    conn: &Connection,
    actor: &Actor,
    include_merged: bool,
    limit: usize,
) -> Result<Vec<Package>, String> {
    allow(actor)?;
    let merged = if include_merged {
        ""
    } else {
        " AND status != 'merged'"
    };
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM programme_packages WHERE project_id = ?1{merged}
             ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?2"
        ))
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![actor.project.as_str(), limit as i64], from_row)
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
}

#[cfg(test)]
pub fn get(conn: &Connection, actor: &Actor, id: &str) -> Result<Package, String> {
    allow(actor)?;
    load(conn, &actor.project, id)?.ok_or_else(|| MISSING.to_string())
}

pub fn enqueue(
    conn: &mut Connection,
    actor: &Actor,
    input: &EnqueueInput,
    now: i64,
) -> Result<Package, String> {
    enqueue_limited(conn, actor, input, now, ROW_MAX)
}

pub(crate) fn enqueue_limited(
    conn: &mut Connection,
    actor: &Actor,
    input: &EnqueueInput,
    now: i64,
    limit: usize,
) -> Result<Package, String> {
    allow(actor)?;
    let wp = wp_id(&input.wp)?;
    let title = one_line(&input.title, "title", TITLE_MAX)?;
    let brief_path = rel_path(&input.brief_path, "briefPath")?;
    let branch = branch_name(&input.branch)?;
    // A branch nobody queued is refused, including one a Lead names that is not
    // this package's. A merged or failed row may hand its branch to the next package.
    if !branch_for_package(&branch, &wp) && !branch_released(conn, &actor.project, &branch)? {
        return Err("That branch was not made for this package. Nothing was queued.".into());
    }
    let priority = priority_of(input.priority)?;
    let notes = notes_text(input.notes.as_deref().unwrap_or(""))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    if let Some(existing) = open_wp(&tx, &actor.project, &wp)? {
        drop(tx);
        return Ok(existing);
    }
    if open_same_work(&tx, &actor.project, &branch, &brief_path)? {
        return Err("That branch or brief is already on the programme.".into());
    }
    let count: i64 = tx
        .query_row(
            &format!("SELECT COUNT(*) FROM programme_packages WHERE project_id = ?1 AND {OPEN}"),
            params![actor.project.as_str()],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if count >= limit as i64 {
        return Err("This programme is full.".into());
    }
    let id = format!("programme-{}", uuid::Uuid::new_v4().simple());
    tx.execute(
        "INSERT INTO programme_packages (
            id, project_id, wp, title, brief_path, branch, status, security_park, priority, notes,
            park_reason, version, created_at, updated_at, claimed_at, finished_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?8, ?9, NULL, 1, ?10, ?10, NULL, NULL)",
        params![
            id,
            actor.project.as_str(),
            wp,
            title,
            brief_path,
            branch,
            i64::from(input.security_park),
            priority,
            notes,
            now,
        ],
    )
    .map_err(db_err)?;
    let package = load(&tx, &actor.project, &id)?.ok_or_else(|| MISSING.to_string())?;
    tx.commit().map_err(db_err)?;
    Ok(package)
}

pub fn claim(
    conn: &mut Connection,
    actor: &Actor,
    id: &str,
    version: i64,
    now: i64,
) -> Result<Package, String> {
    set_status(conn, actor, id, version, "building", now)
}

pub fn finish(
    conn: &mut Connection,
    actor: &Actor,
    id: &str,
    version: i64,
    status: &str,
    now: i64,
) -> Result<Package, String> {
    if !matches!(status, "pr_open" | "merged" | "failed") {
        return Err("Finish moves a building package to pr_open, merged or failed.".into());
    }
    set_status(conn, actor, id, version, status, now)
}

pub fn set_status(
    conn: &mut Connection,
    actor: &Actor,
    id: &str,
    version: i64,
    status: &str,
    now: i64,
) -> Result<Package, String> {
    allow(actor)?;
    if status == "parked" {
        return Err("Park a package with a reason.".into());
    }
    if !matches!(
        status,
        "queued" | "building" | "pr_open" | "merged" | "failed"
    ) {
        return Err("Status must be queued, building, pr_open, merged or failed.".into());
    }
    let tx = write_tx(conn)?;
    let row = locked(&tx, &actor.project, id, version)?;
    check_transition(&row, status)?;
    if status == "queued" {
        if let Some(open) = open_wp(&tx, &actor.project, &row.wp)? {
            if open.id != row.id {
                return Err("That package is already on the programme.".into());
            }
        }
    }
    let claimed = next_claimed(&row, status, now);
    let finished = finished_after(&row, status, now);
    let n = tx
        .execute(
            "UPDATE programme_packages
             SET status = ?1, version = version + 1, updated_at = ?2, claimed_at = ?3, finished_at = ?4
             WHERE id = ?5 AND project_id = ?6 AND version = ?7",
            params![status, now, claimed, finished, id, actor.project.as_str(), version],
        )
        .map_err(db_err)?;
    if n != 1 {
        return Err(STALE.into());
    }
    let package = load(&tx, &actor.project, id)?.ok_or_else(|| MISSING.to_string())?;
    tx.commit().map_err(db_err)?;
    Ok(package)
}

pub fn park(
    conn: &mut Connection,
    actor: &Actor,
    id: &str,
    version: i64,
    reason: &str,
    security: bool,
    now: i64,
) -> Result<Package, String> {
    allow(actor)?;
    let reason = one_line(reason, "reason", REASON_MAX)?;
    let tx = write_tx(conn)?;
    let row = locked(&tx, &actor.project, id, version)?;
    if row.status == "merged" {
        return Err("This package is already merged.".into());
    }
    let same_reason = row.park_reason.as_deref() == Some(reason.as_str());
    if row.status == "parked" && same_reason && (!security || row.security_park) {
        drop(tx);
        return Ok(row);
    }
    let n = tx
        .execute(
            "UPDATE programme_packages
             SET status = 'parked', park_reason = ?1,
                 security_park = CASE WHEN ?2 = 1 THEN 1 ELSE security_park END,
                 version = version + 1, updated_at = ?3
             WHERE id = ?4 AND project_id = ?5 AND version = ?6 AND status != 'merged'",
            params![
                reason,
                i64::from(security),
                now,
                id,
                actor.project.as_str(),
                version
            ],
        )
        .map_err(db_err)?;
    if n != 1 {
        return Err(STALE.into());
    }
    let package = load(&tx, &actor.project, id)?.ok_or_else(|| MISSING.to_string())?;
    tx.commit().map_err(db_err)?;
    Ok(package)
}

/// The person puts a parked package back on the queue. A first mate cannot.
pub fn clear_park(
    conn: &mut Connection,
    actor: &Actor,
    id: &str,
    version: i64,
    now: i64,
) -> Result<Package, String> {
    allow(actor)?;
    if actor.kind != "person" {
        return Err(PERSON_CLEARS.into());
    }
    let tx = write_tx(conn)?;
    let row = locked(&tx, &actor.project, id, version)?;
    if row.status != "parked" && !row.security_park {
        return Err("This package is not parked.".into());
    }
    let back = if row.status == "parked" {
        "queued"
    } else {
        row.status.as_str()
    };
    let reset_times = i64::from(row.status == "parked");
    let n = tx
        .execute(
            "UPDATE programme_packages
             SET status = ?1, security_park = 0, park_reason = NULL, version = version + 1, updated_at = ?2,
                 claimed_at = CASE WHEN ?3 = 1 THEN NULL ELSE claimed_at END,
                 finished_at = CASE WHEN ?3 = 1 THEN NULL ELSE finished_at END
             WHERE id = ?4 AND project_id = ?5 AND version = ?6",
            params![back, now, reset_times, id, actor.project.as_str(), version],
        )
        .map_err(db_err)?;
    if n != 1 {
        return Err(STALE.into());
    }
    let package = load(&tx, &actor.project, id)?.ok_or_else(|| MISSING.to_string())?;
    tx.commit().map_err(db_err)?;
    Ok(package)
}

fn allow(actor: &Actor) -> Result<(), String> {
    match actor.kind.as_str() {
        "person" | "first-mate" => {}
        "worker" => return Err(WORKER_REASON.into()),
        _ => return Err("Only the first mate can change the programme.".into()),
    }
    if actor.id.trim().is_empty() || actor.project.trim().is_empty() {
        return Err("Name the project this programme belongs to.".into());
    }
    if actor.project.chars().count() > PROJECT_MAX || actor.project.chars().any(|c| c == '\0') {
        return Err("Name the project this programme belongs to.".into());
    }
    Ok(())
}

fn check_transition(row: &Package, to: &str) -> Result<(), String> {
    if row.status == "parked" {
        return Err(PARKED_STAYS.into());
    }
    if row.status == "merged" {
        return Err("This package is already merged.".into());
    }
    if row.security_park && to == "building" {
        return Err(SECURITY_STAYS.into());
    }
    let ok = matches!(
        (row.status.as_str(), to),
        ("queued", "building")
            | ("queued", "failed")
            | ("building", "pr_open")
            | ("building", "merged")
            | ("building", "failed")
            | ("pr_open", "merged")
            | ("pr_open", "failed")
            | ("failed", "queued")
    );
    if ok {
        return Ok(());
    }
    Err(format!(
        "This package cannot move from {} to {}.",
        word(&row.status),
        word(to)
    ))
}

/// The status names an agent sends (`pr_open`, not a phrase), so an error says the same word the tool takes.
fn word(status: &str) -> &str {
    match status {
        "queued" => "queued",
        "building" => "building",
        "pr_open" => "pr_open",
        "merged" => "merged",
        "parked" => "parked",
        "failed" => "failed",
        _ => "unknown",
    }
}

fn next_claimed(row: &Package, to: &str, now: i64) -> Option<i64> {
    match to {
        "building" => Some(now),
        "queued" => None,
        _ => row.claimed_at,
    }
}

fn finished_after(row: &Package, to: &str, now: i64) -> Option<i64> {
    if matches!(to, "merged" | "failed") {
        Some(now)
    } else if to == "queued" {
        None
    } else {
        row.finished_at
    }
}

fn write_tx(conn: &mut Connection) -> Result<rusqlite::Transaction<'_>, String> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)
}

fn locked(conn: &Connection, project: &str, id: &str, version: i64) -> Result<Package, String> {
    let row = load(conn, project, id)?.ok_or_else(|| MISSING.to_string())?;
    if row.version != version {
        return Err(STALE.into());
    }
    Ok(row)
}

fn load(conn: &Connection, project: &str, id: &str) -> Result<Option<Package>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM programme_packages WHERE id = ?1 AND project_id = ?2"),
        params![id, project],
        from_row,
    )
    .optional()
    .map_err(db_err)
}

/// The statuses that still need the programme. Merged rows are done; failed rows can be queued again.
const OPEN: &str = "status IN ('queued', 'building', 'pr_open', 'parked')";

/// The open row for this package. The id is compared without case, so `wp-9` cannot sidestep a parked `WP-9`.
fn open_wp(conn: &Connection, project: &str, wp: &str) -> Result<Option<Package>, String> {
    conn.query_row(
        &format!(
            "SELECT {COLUMNS} FROM programme_packages
             WHERE project_id = ?1 AND wp = ?2 COLLATE NOCASE AND {OPEN}
             ORDER BY created_at ASC, id ASC LIMIT 1"
        ),
        params![project, wp],
        from_row,
    )
    .optional()
    .map_err(db_err)
}

/// An open or parked row already has this branch or this brief.
fn open_same_work(
    conn: &Connection,
    project: &str,
    branch: &str,
    brief_path: &str,
) -> Result<bool, String> {
    conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM programme_packages
             WHERE project_id = ?1 AND (branch = ?2 COLLATE NOCASE OR brief_path = ?3 COLLATE NOCASE) AND {OPEN})"
        ),
        params![project, branch, brief_path],
        |row| row.get::<_, i64>(0),
    )
    .map(|found| found != 0)
    .map_err(db_err)
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Package> {
    Ok(Package {
        id: row.get(0)?,
        project_id: row.get(1)?,
        wp: row.get(2)?,
        title: row.get(3)?,
        brief_path: row.get(4)?,
        branch: row.get(5)?,
        status: row.get(6)?,
        security_park: row.get::<_, i64>(7)? != 0,
        priority: row.get(8)?,
        notes: row.get(9)?,
        park_reason: row.get(10)?,
        version: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        claimed_at: row.get(14)?,
        finished_at: row.get(15)?,
    })
}

fn db_err(error: rusqlite::Error) -> String {
    match &error {
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == ErrorCode::DatabaseBusy || code.code == ErrorCode::DatabaseLocked =>
        {
            "The programme is busy. Try again.".into()
        }
        _ => error.to_string(),
    }
}

fn wp_id(value: &str) -> Result<String, String> {
    let text = value.trim();
    if text.is_empty() {
        return Err("wp is required.".into());
    }
    if text.chars().count() > WP_MAX {
        return Err("wp is too long.".into());
    }
    let ok = text
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok || text.starts_with('.') {
        return Err("wp must be a short package id.".into());
    }
    Ok(text.to_string())
}

fn one_line(value: &str, name: &str, max: usize) -> Result<String, String> {
    let text = value.trim();
    if text.is_empty() {
        return Err(format!("{name} is required."));
    }
    if text.chars().any(|c| matches!(c, '\0' | '\n' | '\r')) {
        return Err(format!("{name} must be one line."));
    }
    if text.chars().count() > max {
        return Err(format!("{name} is too long."));
    }
    Ok(text.to_string())
}

fn notes_text(value: &str) -> Result<String, String> {
    if value.chars().any(|c| c == '\0') {
        return Err("notes must not contain a null.".into());
    }
    let text = value.replace("\r\n", "\n").replace('\r', "\n");
    if text.chars().count() > NOTE_MAX {
        return Err(format!("notes must be under {NOTE_MAX} characters."));
    }
    Ok(text)
}

fn rel_path(value: &str, name: &str) -> Result<String, String> {
    let text = value.trim();
    if text.is_empty() {
        return Err(format!("{name} is required."));
    }
    if text.chars().count() > PATH_MAX {
        return Err(format!("{name} is too long."));
    }
    if text.chars().any(|c| matches!(c, '\0' | '\n' | '\r')) {
        return Err(format!("{name} must be one line."));
    }
    if text.starts_with('/') || text.starts_with('\\') {
        return Err(format!("{name} must be a relative path."));
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(format!("{name} must be a relative path."));
    }
    if text
        .split(['/', '\\'])
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(format!("{name} must stay inside the project."));
    }
    Ok(text.to_string())
}

/// True when a merged or failed row in this project already used this branch.
fn branch_released(conn: &Connection, project: &str, branch: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM programme_packages
         WHERE project_id = ?1 AND branch = ?2 COLLATE NOCASE
         AND status IN ('merged', 'failed'))",
        params![project, branch],
        |row| row.get::<_, i64>(0),
    )
    .map(|found| found != 0)
    .map_err(db_err)
}

/// The branch is this package's worktree branch: it starts with `wp/` and either a
/// path segment is the package id (`wp/WP-162`, `wp/WP-A`) or a token is the id
/// without its `WP-` prefix (`wp/162` for `WP-162`, `wp/153b-quarantine-rewrite`
/// for `WP-153b`), compared ignoring case. `wp/162b-update` is not `WP-162`,
/// and `wp/90` is not `WP-9`.
pub(crate) fn branch_for_package(branch: &str, wp: &str) -> bool {
    let branch = branch.trim();
    let wp = wp.trim();
    if wp.is_empty() || branch.len() < 4 {
        return false;
    }
    let Some(prefix) = branch.get(..3) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("wp/") {
        return false;
    }
    if branch
        .split('/')
        .any(|segment| segment.eq_ignore_ascii_case(wp))
    {
        return true;
    }
    let Some(token) = package_token(wp) else {
        return false;
    };
    branch
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| part.eq_ignore_ascii_case(token))
}

/// The package id with a leading `WP-` removed. `WP-153b` is `153b`.
fn package_token(wp: &str) -> Option<&str> {
    let rest = if wp.len() >= 3 && wp.as_bytes()[..3].eq_ignore_ascii_case(b"wp-") {
        &wp[3..]
    } else {
        wp
    };
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

fn branch_name(value: &str) -> Result<String, String> {
    let text = value.trim();
    if text.is_empty() {
        return Err("branch is required.".into());
    }
    if text.chars().count() > BRANCH_MAX {
        return Err("branch is too long.".into());
    }
    if text.chars().any(|c| c.is_control() || c.is_whitespace())
        || text.contains("..")
        || text.contains('\\')
        || text.contains(':')
    {
        return Err("branch must be a branch name.".into());
    }
    Ok(text.to_string())
}

fn priority_of(value: Option<i64>) -> Result<i64, String> {
    let number = value.unwrap_or(0);
    if !(-PRIORITY_MAX..=PRIORITY_MAX).contains(&number) {
        return Err("priority must be a whole number from -1000 to 1000.".into());
    }
    Ok(number)
}
