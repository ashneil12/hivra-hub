//! Hivra WP-92: agents ask for a secret and use it without ever seeing it
//! (docs/hivra/work/WP-92-secret-vault.md).
//!
//! The sentence this module must keep true: **a secret's value exists in the person's keychain and in at most one place
//! they chose with a tap, the environment of one approved command or worker, or a gitignored `.env` in one worktree ,
//! and nowhere else.**
//!
//! - One Keychain item per secret, `monocode-hub:secret:<scope>:<name>`, account `value`, written and read only through
//!   `hub_keychain` (its service guard and its dev prefix apply; no new Keychain code).
//! - Metadata in the app's own database: `secrets`, `secret_grants`, `secret_requests`, `secret_env_writes`. Nothing in
//!   those tables can reconstruct a value.
//! - `secrets_run`, `secrets_request` and `secrets_list` are the agent's tools. No tool returns a value.
//! - A run is one signed grant: one secret into one child's environment, for 60 seconds, once.
//! - The `.env` route is a person's tap only, and only in a worktree the app already knows.

use std::collections::BTreeSet;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub mod commands;
pub mod env_file;
pub mod grant;
pub mod run;
pub mod scrub;
pub mod store;
pub mod worker;

pub use store::Vault;

/// Every vault item's account name.
pub const ACCOUNT: &str = "value";

pub const SCOPE_GLOBAL: &str = "global";
pub const SCOPE_PROJECT: &str = "project.";

/// `secret_requests.state`.
pub const OPEN: &str = "open";
pub const SAVING: &str = "saving";
pub const FILLED: &str = "filled";
pub const DECLINED: &str = "declined";

/// A request left in `saving` for longer than this (a crash between the keychain write and the row update) reopens at
/// startup.
pub const STALE_SAVING_MS: i64 = 5 * 60 * 1000;

pub const NAME_MAX: usize = 64;
pub const VALUE_MIN: usize = 8;
pub const VALUE_MAX: usize = 8192;
pub const LAST4_FROM: usize = 12;
pub const LABEL_MAX: usize = 200;
pub const WHY_MAX: usize = 2_000;
pub const SERVICE_MAX: usize = 120;
pub const GRANT_TTL_MS: i64 = 60 * 1000;
pub const TIMEOUT_DEFAULT: u64 = 120;
pub const TIMEOUT_MAX: u64 = 600;

/// One process-wide write lock: two windows saving the same secret must not interleave a keychain write with a stale
/// row write.
fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

// ---- the value ------------------------------------------------------------------------------------------------------

/// A secret's value. `Debug` prints the name, never the bytes; `Zeroizing` clears the buffer when it drops.
pub struct SecretValue {
    name: String,
    value: Zeroizing<String>,
    /// The secret's scope, for the sentences that name it.
    scope: String,
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretValue({}, scope {})", self.name, self.scope)
    }
}

impl SecretValue {
    /// The bytes, for the one caller that needs them (the Keychain write, the child's environment, a scrub).
    pub fn expose(&self) -> &str {
        &self.value
    }
}

/// Normalize a name to the slug the vault stores. Lower case; spaces and underscores become `-`; ASCII letters, digits
/// and `-` only; 1 to 64 characters; no leading or trailing `-`.
pub fn normalize_name(raw: &str) -> Result<String, String> {
    let lowered = raw.trim().to_lowercase();
    let slug: String = lowered
        .chars()
        .map(|c| if c == ' ' || c == '_' { '-' } else { c })
        .collect();
    let ok = (1..=NAME_MAX).contains(&slug.len())
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(slug)
    } else {
        Err(
            "A key's name is lower-case letters, digits and dashes, 1 to 64 characters, like \
             stripe-api-key."
                .into(),
        )
    }
}

/// Trim trailing CR/LF only (a PEM keeps its internal newlines) and check the bounds. Empty, whitespace-only, too
/// long, or non-text values are refused with a plain sentence that never holds the value.
pub fn validate_value(raw: &str) -> Result<Zeroizing<String>, String> {
    let trimmed = raw.trim_end_matches(['\r', '\n']).to_string();
    if trimmed.trim().is_empty() {
        return Err("That key is empty.".into());
    }
    let length = trimmed.chars().count();
    if length < VALUE_MIN {
        return Err(format!("That key is shorter than {VALUE_MIN} characters."));
    }
    if length > VALUE_MAX {
        return Err(format!("That key is longer than {VALUE_MAX} characters."));
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("That key isn't text.".into());
    }
    Ok(Zeroizing::new(trimmed))
}

/// The last four characters, only when the value has at least 12.
pub fn last4(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < LAST4_FROM {
        return None;
    }
    Some(chars[chars.len() - 4..].iter().collect())
}

fn label_text(raw: Option<&str>, name: &str) -> Result<String, String> {
    let label = raw.unwrap_or("").trim();
    let label = if label.is_empty() { name } else { label };
    if label.chars().count() > LABEL_MAX {
        return Err(format!("That label is longer than {LABEL_MAX} characters."));
    }
    Ok(label.to_string())
}

// ---- scope and service ---------------------------------------------------------------------------------------------

/// The scope of a chat: its project's, or global when it has none.
pub fn scope_for(project: Option<&str>) -> String {
    match project.map(str::trim).filter(|p| !p.is_empty()) {
        Some(project) => format!("{SCOPE_PROJECT}{project}"),
        None => SCOPE_GLOBAL.into(),
    }
}

/// The readable project id in a scope.
pub fn scope_project(scope: &str) -> Option<&str> {
    scope.strip_prefix(SCOPE_PROJECT)
}

/// Where a secret lives, in plain words: "Everywhere", or "Project: <folder name>".
pub fn scope_words(scope: &str) -> String {
    match scope_project(scope) {
        None => "Everywhere".to_string(),
        Some(id) => {
            let name = id
                .rsplit(['/', '\\'])
                .find(|part| !part.is_empty())
                .unwrap_or(id);
            format!("Project: {name}")
        }
    }
}

/// The sentence that says which copy a run uses when a name is saved both everywhere and for a project.
pub const PROJECT_COPY_USED: &str =
    "This project's copy is used; there is also one for everywhere.";

/// Whether a secret lives in a project and the same name is also saved for everywhere (so a run in that project uses
/// the project's copy and the card says so).
pub fn has_global_twin(conn: &Connection, row: &SecretRow) -> bool {
    row.scope != SCOPE_GLOBAL
        && get_secret(conn, SCOPE_GLOBAL, &row.name)
            .ok()
            .flatten()
            .is_some()
}

/// Whether a scope is `global` or `project.<id>`.
pub fn valid_scope(scope: &str) -> bool {
    scope == SCOPE_GLOBAL || scope_project(scope).is_some_and(|p| !p.is_empty())
}

/// The Keychain service. A project id that would break the 120-character guard (or carries anything outside
/// `[A-Za-z0-9_.-]`) becomes a SHA-256 prefix; the row keeps the readable id.
pub fn service(scope: &str, name: &str) -> Result<String, String> {
    let name = normalize_name(name)?;
    if !valid_scope(scope) {
        return Err("That key's scope is unknown.".into());
    }
    let scope_part = match scope_project(scope) {
        None => SCOPE_GLOBAL.to_string(),
        Some(id) => {
            let plain = id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
            let candidate = format!("{SCOPE_PROJECT}{id}");
            if plain && format!("monocode-hub:secret:{candidate}:{name}").len() <= SERVICE_MAX {
                candidate
            } else {
                let digest = Sha256::digest(id.as_bytes());
                let short: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
                format!("{SCOPE_PROJECT}{short}")
            }
        }
    };
    let service = format!("monocode-hub:secret:{scope_part}:{name}");
    if service.len() > SERVICE_MAX {
        return Err("That key's name is too long for the keychain.".into());
    }
    Ok(service)
}

/// Whether an environment variable name is one the vault may set: `[A-Z_][A-Z0-9_]{0,63}`.
pub fn valid_env_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_uppercase() || bytes[0] == b'_')
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

// ---- the tables ----------------------------------------------------------------------------------------------------

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS secrets (
           scope TEXT NOT NULL,
           name TEXT NOT NULL,
           label TEXT NOT NULL,
           last4 TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           last_used_at INTEGER,
           version INTEGER NOT NULL DEFAULT 1,
           PRIMARY KEY (scope, name)
         );
         CREATE TABLE IF NOT EXISTS secret_grants (
           scope TEXT NOT NULL,
           name TEXT NOT NULL,
           subject_kind TEXT NOT NULL,
           subject_id TEXT NOT NULL,
           executable TEXT NOT NULL,
           mode TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           PRIMARY KEY (scope, name, subject_kind, subject_id, executable)
         );
         CREATE TABLE IF NOT EXISTS secret_requests (
           id TEXT PRIMARY KEY,
           chat TEXT NOT NULL,
           mono TEXT,
           project TEXT,
           scope TEXT NOT NULL,
           name TEXT NOT NULL,
           why TEXT NOT NULL,
           state TEXT NOT NULL,
           answer_token TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS secret_requests_open ON secret_requests(state, created_at);
         CREATE TABLE IF NOT EXISTS secret_env_writes (
           scope TEXT NOT NULL,
           name TEXT NOT NULL,
           worktree TEXT NOT NULL,
           env_name TEXT NOT NULL,
           written_at INTEGER NOT NULL,
           PRIMARY KEY (scope, name, worktree)
         );
         CREATE TABLE IF NOT EXISTS secret_settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
}

// ---- rows -----------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRow {
    pub scope: String,
    pub name: String,
    pub label: String,
    pub last4: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub version: i64,
    /// Filled by [`handles`]: `mono:<id>` and `project:<id>` for every live grant, sorted.
    #[serde(default)]
    pub approved: Vec<String>,
    /// Filled by [`handles`]: the executables with a live grant, sorted.
    #[serde(default)]
    pub executables: Vec<String>,
    /// Filled by [`handles`]: the worktrees whose `.env` holds it.
    #[serde(default)]
    pub env_files: Vec<String>,
    /// A secret imported from an export: metadata only, no value until the person adds it.
    #[serde(default)]
    pub needs_value: bool,
}

const SECRET_COLUMNS: &str =
    "scope, name, label, last4, created_at, updated_at, last_used_at, version";

fn secret_from_row(row: &Row) -> rusqlite::Result<SecretRow> {
    Ok(SecretRow {
        scope: row.get(0)?,
        name: row.get(1)?,
        label: row.get(2)?,
        last4: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        last_used_at: row.get(6)?,
        version: row.get(7)?,
        approved: Vec::new(),
        executables: Vec::new(),
        env_files: Vec::new(),
        needs_value: false,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRow {
    pub scope: String,
    pub name: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub executable: String,
    pub mode: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRow {
    pub id: String,
    pub chat: String,
    pub mono: Option<String>,
    pub project: Option<String>,
    pub scope: String,
    pub name: String,
    pub why: String,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvWriteRow {
    pub scope: String,
    pub name: String,
    pub worktree: String,
    pub env_name: String,
    pub written_at: i64,
}

pub fn get_secret(conn: &Connection, scope: &str, name: &str) -> Result<Option<SecretRow>, String> {
    conn.query_row(
        &format!("SELECT {SECRET_COLUMNS} FROM secrets WHERE scope = ?1 AND name = ?2"),
        params![scope, name],
        secret_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every secret, oldest label first.
pub fn list_secrets(conn: &Connection) -> Result<Vec<SecretRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SECRET_COLUMNS} FROM secrets ORDER BY scope, name"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], secret_from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The chat's project scope first, then global. If both exist the project's wins.
pub fn resolve(
    conn: &Connection,
    project: Option<&str>,
    name: &str,
) -> Result<Option<SecretRow>, String> {
    let name = normalize_name(name)?;
    if let Some(project) = project.map(str::trim).filter(|p| !p.is_empty()) {
        if let Some(row) = get_secret(conn, &scope_for(Some(project)), &name)? {
            return Ok(Some(row));
        }
    }
    get_secret(conn, SCOPE_GLOBAL, &name)
}

/// The handles every listing returns: no value, ever.
///
/// A row with `version = 0` came from an import and has no value yet; asking the Keychain per row would show the
/// system prompt on every listing, so the row itself carries the answer.
pub fn handles(conn: &Connection) -> Result<Vec<SecretRow>, String> {
    let mut rows = list_secrets(conn)?;
    for row in &mut rows {
        row.approved = grants_for(conn, &row.scope, &row.name)?
            .into_iter()
            .map(|g| match g.subject_kind.as_str() {
                "project" => format!("project:{}", g.subject_id),
                _ => format!("mono:{}", g.subject_id),
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        row.executables = grants_for(conn, &row.scope, &row.name)?
            .into_iter()
            .map(|g| g.executable)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        row.env_files = env_writes_for(conn, &row.scope, &row.name)?
            .into_iter()
            .map(|w| w.worktree)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        row.needs_value = row.version == 0;
    }
    Ok(rows)
}

// ---- saving, renaming, rotating, deleting ---------------------------------------------------------------------------

fn write_row(conn: &Connection, row: &SecretRow, expected: Option<i64>) -> Result<(), String> {
    match expected {
        None => {
            let changed = conn
                .execute(
                    &format!(
                        "INSERT INTO secrets ({SECRET_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                         ON CONFLICT (scope, name) DO NOTHING"
                    ),
                    params![
                        row.scope,
                        row.name,
                        row.label,
                        row.last4,
                        row.created_at,
                        row.updated_at,
                        row.last_used_at,
                        row.version
                    ],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("That key was saved in another window. Try again.".into());
            }
            Ok(())
        }
        Some(version) => {
            let changed = conn
                .execute(
                    "UPDATE secrets SET label = ?3, last4 = ?4, updated_at = ?5, version = ?6
                     WHERE scope = ?1 AND name = ?2 AND version = ?7",
                    params![
                        row.scope,
                        row.name,
                        row.label,
                        row.last4,
                        row.updated_at,
                        row.version,
                        version
                    ],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("That key changed in another window. Try again.".into());
            }
            Ok(())
        }
    }
}

/// Save a value: the row's claim first (compare-and-swap on `version`), then the Keychain. The claim goes first so a
/// lost race never leaves the store holding a value under a version nobody approved; a refused store write puts the
/// claim back, so no row ever names a value the store does not hold.
pub fn save_value(
    vault: &dyn Vault,
    conn: &Connection,
    scope: &str,
    name: &str,
    label: Option<&str>,
    value: &str,
    now: i64,
) -> Result<SecretRow, String> {
    let _guard = write_lock();
    save_value_locked(vault, conn, scope, name, label, value, now)
}

/// `save_value` with the write lock already held.
fn save_value_locked(
    vault: &dyn Vault,
    conn: &Connection,
    scope: &str,
    name: &str,
    label: Option<&str>,
    value: &str,
    now: i64,
) -> Result<SecretRow, String> {
    let name = normalize_name(name)?;
    if !valid_scope(scope) {
        return Err("That key's scope is unknown.".into());
    }
    let value = SecretValue {
        name: name.clone(),
        value: validate_value(value)?,
        scope: scope.to_string(),
    };
    let label = label_text(label, &name)?;
    let service = service(scope, &name)?;
    let existing = get_secret(conn, scope, &name)?;
    let row = SecretRow {
        scope: scope.to_string(),
        name: name.clone(),
        label,
        last4: last4(value.expose()),
        created_at: existing.as_ref().map(|r| r.created_at).unwrap_or(now),
        updated_at: now,
        last_used_at: existing.as_ref().and_then(|r| r.last_used_at),
        version: existing.as_ref().map(|r| r.version + 1).unwrap_or(1),
        approved: Vec::new(),
        executables: Vec::new(),
        env_files: Vec::new(),
        needs_value: false,
    };
    write_row(conn, &row, existing.as_ref().map(|r| r.version))?;
    if let Err(why) = vault.write(&service, ACCOUNT, value.expose()) {
        unclaim_row(conn, &row, existing.as_ref())?;
        return Err(why);
    }
    Ok(row)
}

/// Put a claimed row back as it was, after the store refused the value. The version is the compare-and-swap, so a row
/// something else has changed since is left alone.
fn unclaim_row(
    conn: &Connection,
    claimed: &SecretRow,
    before: Option<&SecretRow>,
) -> Result<(), String> {
    match before {
        None => conn.execute(
            "DELETE FROM secrets WHERE scope = ?1 AND name = ?2 AND version = ?3",
            params![claimed.scope, claimed.name, claimed.version],
        ),
        Some(before) => conn.execute(
            "UPDATE secrets SET label = ?3, last4 = ?4, updated_at = ?5, version = ?6
             WHERE scope = ?1 AND name = ?2 AND version = ?7",
            params![
                claimed.scope,
                claimed.name,
                before.label,
                before.last4,
                before.updated_at,
                before.version,
                claimed.version
            ],
        ),
    }
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Rename changes the label only: the slug stays, so every agent and grant that names it keeps working.
pub fn rename(
    conn: &Connection,
    scope: &str,
    name: &str,
    label: &str,
    expected: i64,
    now: i64,
) -> Result<SecretRow, String> {
    let _guard = write_lock();
    let name = normalize_name(name)?;
    let label = label_text(Some(label), &name)?;
    let mut row = get_secret(conn, scope, &name)?
        .ok_or_else(|| "That key isn't here any more.".to_string())?;
    if row.version != expected {
        return Err("That key changed in another window. Try again.".into());
    }
    row.label = label;
    row.updated_at = now;
    row.version += 1;
    write_row(conn, &row, Some(expected))?;
    Ok(row)
}

/// Rotate writes a new value to the same item and bumps `version`; grants stay in place. A run whose grant names the
/// old version is refused. A row deleted while the rotate was in flight stays deleted: rotate never recreates one.
pub fn rotate(
    vault: &dyn Vault,
    conn: &Connection,
    scope: &str,
    name: &str,
    value: &str,
    now: i64,
) -> Result<SecretRow, String> {
    let _guard = write_lock();
    let name = normalize_name(name)?;
    let label = get_secret(conn, scope, &name)?
        .ok_or_else(|| "That key isn't here any more.".to_string())?
        .label;
    save_value_locked(vault, conn, scope, &name, Some(&label), value, now)
}

/// Marque a secret as used, on its own, never touching `version`.
pub fn touch_used(conn: &Connection, scope: &str, name: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE secrets SET last_used_at = ?3 WHERE scope = ?1 AND name = ?2",
        params![scope, name, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A `.env` the app left exactly as it was, and why, in plain words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedFile {
    pub worktree: String,
    pub why: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub removed_grants: usize,
    pub removed_env_lines: Vec<String>,
    /// `.env` lines the app left as they were, and why (the file no longer passes the checks, or the line was edited by
    /// hand). The key is gone from Hivra either way.
    pub env_left: Vec<RefusedFile>,
    /// The store refused to remove the item. Nothing in Hivra names it any more, but the value is still in the
    /// person's keychain and they have to remove it themselves.
    pub keychain_kept: bool,
}

/// Revoke: the row, every grant and every `.env` record first, in one transaction, then the `.env` lines that still
/// hold its value, then the keychain item. Anything that fails part way leaves nothing in Hivra that could name a
/// value it can no longer read.
pub fn delete(
    vault: &dyn Vault,
    conn: &Connection,
    scope: &str,
    name: &str,
) -> Result<DeleteReport, String> {
    let _guard = write_lock();
    let name = normalize_name(name)?;
    let service = service(scope, &name)?;
    // Read before any state changes: the lines can only be matched by the value itself.
    let value = vault.read(&service, ACCOUNT)?;
    let writes = env_writes_for(conn, scope, &name)?;
    let mut report = DeleteReport::default();
    {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        report.removed_grants = tx
            .execute(
                "DELETE FROM secret_grants WHERE scope = ?1 AND name = ?2",
                params![scope, name],
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM secret_env_writes WHERE scope = ?1 AND name = ?2",
            params![scope, name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM secrets WHERE scope = ?1 AND name = ?2",
            params![scope, name],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    // A file that will not come clean is reported and the delete goes on: the keychain item must not outlive its row.
    for write in writes {
        let left = |why: &str| RefusedFile {
            worktree: write.worktree.clone(),
            why: why.to_string(),
        };
        match env_file::remove_line(
            std::path::Path::new(&write.worktree),
            &write.env_name,
            value.as_deref(),
        ) {
            Ok(env_file::LineChange::Changed) => {
                report.removed_env_lines.push(write.worktree.clone())
            }
            Ok(env_file::LineChange::Refused(why)) => report.env_left.push(left(&why)),
            Ok(env_file::LineChange::LeftAlone) => report
                .env_left
                .push(left("That line was edited by hand, so it was left.")),
            Ok(env_file::LineChange::Missing) => {}
            Err(why) => report.env_left.push(left(&why)),
        }
    }
    match vault.remove(&service, ACCOUNT) {
        Ok(_) => {}
        Err(_) => report.keychain_kept = true,
    }
    Ok(report)
}

/// The one command that returns a value. The page clears it when the row closes; nothing else may call this.
pub fn reveal(vault: &dyn Vault, scope: &str, name: &str) -> Result<String, String> {
    let service = service(scope, name)?;
    vault
        .read(&service, ACCOUNT)?
        .ok_or_else(|| "That key isn't in your keychain any more.".to_string())
}

/// The secrets a check has to look for, by (scope, name), read from the database. This is the part that needs the store's
/// lock; reading the values does not, so callers take the names under the lock, let it go, then call [`needles_for`].
pub fn known_names(conn: &Connection, scope: Option<&str>) -> Vec<(String, String)> {
    let rows = match scope {
        Some(scope) => list_secrets(conn)
            .map(|rows| rows.into_iter().filter(|row| row.scope == scope).collect())
            .unwrap_or_default(),
        None => list_secrets(conn).unwrap_or_default(),
    };
    rows.into_iter().map(|row| (row.scope, row.name)).collect()
}

/// Every needle of the named values, longest first. A value that can't be read is skipped: text can't hold it. This is a
/// round trip to the Keychain (and may show the system prompt) per name, so it never runs inside the store's lock.
pub fn needles_for(vault: &dyn Vault, names: &[(String, String)]) -> Vec<String> {
    let mut needles = Vec::new();
    for (scope, name) in names {
        let Ok(service) = service(scope, name) else {
            continue;
        };
        let Ok(Some(value)) = vault.read(&service, ACCOUNT) else {
            continue;
        };
        needles.extend(scrub::needles(&Zeroizing::new(value)));
    }
    needles.sort_by_key(|needle| std::cmp::Reverse(needle.len()));
    needles.dedup();
    needles
}

/// [`known_names`] then [`needles_for`], for a caller that holds nothing a Keychain prompt could stall.
pub fn known_needles(vault: &dyn Vault, conn: &Connection, scope: Option<&str>) -> Vec<String> {
    needles_for(vault, &known_names(conn, scope))
}

/// Whether text holds any listed value, whatever its shape. Used by the memory save and the export.
pub fn holds_known_value(
    vault: &dyn Vault,
    conn: &Connection,
    scope: Option<&str>,
    text: &str,
) -> bool {
    known_needles(vault, conn, scope)
        .iter()
        .any(|needle| scrub::holds(text, needle))
}

/// Every listed value in `text` replaced with the marker, then the shared pattern list. The export's exact-value pass.
pub fn redact_known_values(
    vault: &dyn Vault,
    conn: &Connection,
    scope: Option<&str>,
    text: &str,
) -> String {
    scrub::mask(text, &known_needles(vault, conn, scope))
}

// ---- requests -------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestInput {
    /// The asking chat's session id.
    pub chat: String,
    #[serde(default)]
    pub mono: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    pub name: String,
    pub why: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOutcome {
    /// A handle, when the name already resolves: no card is shown.
    pub secret: Option<SecretRow>,
    pub request: Option<RequestRow>,
}

pub fn get_request(conn: &Connection, id: &str) -> Result<Option<RequestRow>, String> {
    conn.query_row(
        "SELECT id, chat, mono, project, scope, name, why, state, created_at, updated_at
         FROM secret_requests WHERE id = ?1",
        [id],
        |row| {
            Ok(RequestRow {
                id: row.get(0)?,
                chat: row.get(1)?,
                mono: row.get(2)?,
                project: row.get(3)?,
                scope: row.get(4)?,
                name: row.get(5)?,
                why: row.get(6)?,
                state: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every request a person must still answer, oldest first.
pub fn list_requests(conn: &Connection) -> Result<Vec<RequestRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, chat, mono, project, scope, name, why, state, created_at, updated_at
             FROM secret_requests WHERE state IN ('open', 'saving') ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RequestRow {
                id: row.get(0)?,
                chat: row.get(1)?,
                mono: row.get(2)?,
                project: row.get(3)?,
                scope: row.get(4)?,
                name: row.get(5)?,
                why: row.get(6)?,
                state: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Create an `open` request, or return the handle when the name already resolves.
pub fn open_request(
    vault: &dyn Vault,
    conn: &Connection,
    input: RequestInput,
    now: i64,
) -> Result<RequestOutcome, String> {
    let _guard = write_lock();
    // A worker's first mate asks: the same plain reason ask_person gives.
    crate::decisions::check_may_ask(conn, input.chat.trim())?;
    let name = normalize_name(&input.name)?;
    let why = input.why.trim();
    if why.is_empty() {
        return Err("Say why you need it, so the person knows what it is for.".into());
    }
    if why.chars().count() > WHY_MAX {
        return Err(format!("The reason is longer than {WHY_MAX} characters."));
    }
    let project = input
        .project
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let scope = match input.scope.as_deref() {
        Some(scope) if scope == SCOPE_GLOBAL => {
            if project.is_some() {
                return Err("A chat with a project asks in the project, not globally.".into());
            }
            SCOPE_GLOBAL.to_string()
        }
        Some(scope) if valid_scope(scope) => scope.to_string(),
        Some(_) => return Err("That key's scope is unknown.".into()),
        None => scope_for(project.as_deref()),
    };
    if let Some(row) = resolve(conn, project.as_deref(), &name)? {
        return Ok(RequestOutcome {
            secret: Some(row),
            request: None,
        });
    }
    // One open request per chat, scope and name: asking again changes nothing.
    let existing: Option<RequestRow> = conn
        .query_row(
            "SELECT id, chat, mono, project, scope, name, why, state, created_at, updated_at
             FROM secret_requests WHERE chat = ?1 AND scope = ?2 AND name = ?3 AND state IN ('open','saving')
             LIMIT 1",
            params![input.chat, scope, name],
            |row| {
                Ok(RequestRow {
                    id: row.get(0)?,
                    chat: row.get(1)?,
                    mono: row.get(2)?,
                    project: row.get(3)?,
                    scope: row.get(4)?,
                    name: row.get(5)?,
                    why: row.get(6)?,
                    state: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(row) = existing {
        return Ok(RequestOutcome {
            secret: None,
            request: Some(row),
        });
    }
    let row = RequestRow {
        id: uuid::Uuid::new_v4().to_string(),
        chat: input.chat,
        mono: input.mono,
        project,
        scope,
        name,
        why: why.to_string(),
        state: OPEN.into(),
        created_at: now,
        updated_at: now,
    };
    conn.execute(
        "INSERT INTO secret_requests (id, chat, mono, project, scope, name, why, state, answer_token,
           created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?9)",
        params![
            row.id,
            row.chat,
            row.mono,
            row.project,
            row.scope,
            row.name,
            row.why,
            row.state,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    let _ = vault;
    Ok(RequestOutcome {
        secret: None,
        request: Some(row),
    })
}

/// Move `open → saving` with a token. The loser of a two-window race is told it was already saved.
pub fn begin_save(conn: &Connection, id: &str, now: i64) -> Result<(RequestRow, String), String> {
    let _guard = write_lock();
    let row = get_request(conn, id)?.ok_or_else(|| "That card is no longer open.".to_string())?;
    if row.state != OPEN {
        return Err("That key was already saved.".into());
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let changed = conn
        .execute(
            "UPDATE secret_requests SET state = 'saving', answer_token = ?2, updated_at = ?3
             WHERE id = ?1 AND state = 'open'",
            params![id, token, now],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That key was already saved.".into());
    }
    let mut row = row;
    row.state = SAVING.into();
    row.updated_at = now;
    Ok((row, token))
}

/// The card's Save. Takes the request's token first (the compare-and-swap), then writes the value, and returns only the
/// handle. Taking it first means a lost race never changes the keychain; if the value write then fails, the request is
/// put back to `saving` so the card's Save can be tried again.
pub fn finish_save(
    vault: &dyn Vault,
    conn: &Connection,
    id: &str,
    token: &str,
    label: Option<&str>,
    value: &str,
    now: i64,
) -> Result<SecretRow, String> {
    let _guard = write_lock();
    let row = get_request(conn, id)?.ok_or_else(|| "That card is no longer open.".to_string())?;
    if row.state != SAVING {
        return Err("That key was already saved.".into());
    }
    let changed = conn
        .execute(
            "UPDATE secret_requests SET state = 'filled', answer_token = NULL, updated_at = ?3
             WHERE id = ?1 AND state = 'saving' AND answer_token = ?2",
            params![id, token, now],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That key was already saved.".into());
    }
    match save_value_locked(vault, conn, &row.scope, &row.name, label, value, now) {
        Ok(saved) => Ok(saved),
        Err(why) => {
            // The card still holds the token, so its next Save must be able to try again.
            let _ = conn.execute(
                "UPDATE secret_requests SET state = 'saving', answer_token = ?2, updated_at = ?3
                 WHERE id = ?1 AND state = 'filled'",
                params![id, token, now],
            );
            Err(why)
        }
    }
}

fn same_token(conn: &Connection, id: &str, token: &str) -> Result<bool, String> {
    let stored: Option<Option<String>> = conn
        .query_row(
            "SELECT answer_token FROM secret_requests WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(stored.flatten().as_deref() == Some(token))
}

/// "Not now": the Mono gets a plain note and the card closes.
pub fn decline(conn: &Connection, id: &str, token: Option<&str>, now: i64) -> Result<(), String> {
    let _guard = write_lock();
    let row = get_request(conn, id)?.ok_or_else(|| "That card is no longer open.".to_string())?;
    if row.state == DECLINED || row.state == FILLED {
        return Ok(());
    }
    if let Some(token) = token {
        if !same_token(conn, id, token)? {
            return Err("That key was already saved.".into());
        }
    }
    conn.execute(
        "UPDATE secret_requests SET state = 'declined', answer_token = NULL, updated_at = ?2
         WHERE id = ?1 AND state IN ('open', 'saving')",
        params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A request left `saving` for more than five minutes goes back to `open`, at startup.
pub fn reopen_stale(conn: &Connection, now: i64) -> Result<usize, String> {
    let cutoff = now.saturating_sub(STALE_SAVING_MS);
    conn.execute(
        "UPDATE secret_requests SET state = 'open', answer_token = NULL, updated_at = ?1
         WHERE state = 'saving' AND updated_at < ?2",
        params![now, cutoff],
    )
    .map_err(|e| e.to_string())
}

// ---- grants ---------------------------------------------------------------------------------------------------------

pub fn grants_for(conn: &Connection, scope: &str, name: &str) -> Result<Vec<GrantRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT scope, name, subject_kind, subject_id, executable, mode, created_at
             FROM secret_grants WHERE scope = ?1 AND name = ?2 ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![scope, name], |row| {
            Ok(GrantRow {
                scope: row.get(0)?,
                name: row.get(1)?,
                subject_kind: row.get(2)?,
                subject_id: row.get(3)?,
                executable: row.get(4)?,
                mode: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Which grant covers this run: the Mono's own first, then its project's.
pub fn find_grant(
    conn: &Connection,
    scope: &str,
    name: &str,
    mono: Option<&str>,
    project: Option<&str>,
    executable: &str,
) -> Result<Option<GrantRow>, String> {
    if let Some(mono) = mono {
        if let Some(grant) = grants_for(conn, scope, name)?.into_iter().find(|g| {
            g.subject_kind == "mono" && g.subject_id == mono && g.executable == executable
        }) {
            return Ok(Some(grant));
        }
    }
    if let Some(project) = project {
        if let Some(grant) = grants_for(conn, scope, name)?.into_iter().find(|g| {
            g.subject_kind == "project" && g.subject_id == project && g.executable == executable
        }) {
            return Ok(Some(grant));
        }
    }
    Ok(None)
}

// A grant is seven fields; naming each at the call reads better than a builder for the handful of callers.
#[allow(clippy::too_many_arguments)]
pub fn put_grant(
    conn: &Connection,
    scope: &str,
    name: &str,
    subject_kind: &str,
    subject_id: &str,
    executable: &str,
    mode: &str,
    now: i64,
) -> Result<(), String> {
    // The one place an `always` grant is written: a program that can run any code only gets one when the person has
    // turned that on for this install. Checked here, so no caller (and no webview) can go around it.
    if mode == "always" && runs_any_code(executable) && !always_for_any_code(conn) {
        return Err(ALWAYS_REFUSED.into());
    }
    conn.execute(
        "INSERT INTO secret_grants (scope, name, subject_kind, subject_id, executable, mode, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (scope, name, subject_kind, subject_id, executable)
         DO UPDATE SET mode = excluded.mode, created_at = excluded.created_at",
        params![scope, name, subject_kind, subject_id, executable, mode, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A `once` grant is deleted by compare-and-swap, so two runs racing it cannot both spend it.
pub fn spend_once(
    conn: &Connection,
    scope: &str,
    name: &str,
    mono: &str,
    executable: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "DELETE FROM secret_grants WHERE scope = ?1 AND name = ?2 AND subject_kind = 'mono'
             AND subject_id = ?3 AND executable = ?4 AND mode = 'once'",
            params![scope, name, mono, executable],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

pub fn revoke_grant(
    conn: &Connection,
    scope: &str,
    name: &str,
    subject_kind: &str,
    subject_id: &str,
    executable: Option<&str>,
) -> Result<usize, String> {
    let changed = match executable {
        Some(executable) => conn.execute(
            "DELETE FROM secret_grants WHERE scope = ?1 AND name = ?2 AND subject_kind = ?3
             AND subject_id = ?4 AND executable = ?5",
            params![scope, name, subject_kind, subject_id, executable],
        ),
        None => conn.execute(
            "DELETE FROM secret_grants WHERE scope = ?1 AND name = ?2 AND subject_kind = ?3
             AND subject_id = ?4",
            params![scope, name, subject_kind, subject_id],
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(changed)
}

// ---- .env records ---------------------------------------------------------------------------------------------------

pub fn env_writes_for(
    conn: &Connection,
    scope: &str,
    name: &str,
) -> Result<Vec<EnvWriteRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT scope, name, worktree, env_name, written_at FROM secret_env_writes
             WHERE scope = ?1 AND name = ?2 ORDER BY written_at, worktree",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![scope, name], |row| {
            Ok(EnvWriteRow {
                scope: row.get(0)?,
                name: row.get(1)?,
                worktree: row.get(2)?,
                env_name: row.get(3)?,
                written_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn record_env_write(
    conn: &Connection,
    scope: &str,
    name: &str,
    worktree: &str,
    env_name: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO secret_env_writes (scope, name, worktree, env_name, written_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (scope, name, worktree)
         DO UPDATE SET env_name = excluded.env_name, written_at = excluded.written_at",
        params![scope, name, worktree, env_name, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- export --------------------------------------------------------------------------------------------------------

/// The export index: metadata only, never a value.
pub fn index_json(conn: &Connection) -> Result<Value, String> {
    let rows = list_secrets(conn)?;
    Ok(json!({
        "secrets": rows.into_iter().map(|row| json!({
            "name": row.name,
            "scope": row.scope,
            "label": row.label,
            "last4": row.last4,
            "createdAt": row.created_at,
        })).collect::<Vec<_>>()
    }))
}

/// The most rows one import takes: an export is untrusted input, and a page that lists a million keys is not a vault.
pub const IMPORT_MAX: usize = 1_000;
/// The longest scope an import takes (`project.` and a folder path).
const IMPORT_SCOPE_MAX: usize = 1_000;

/// An imported label: control characters taken out, cut to the bound a save has, the name when nothing is left.
fn imported_label(raw: Option<&str>, name: &str) -> String {
    let cleaned: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(LABEL_MAX)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        name.to_string()
    } else {
        cleaned.to_string()
    }
}

/// An imported last four: exactly four characters (a value shorter than twelve has none), no control character.
fn imported_last4(raw: Option<&str>) -> Option<String> {
    raw.filter(|text| text.chars().count() == 4 && !text.chars().any(char::is_control))
        .map(str::to_string)
}

/// Import creates rows in a "needs its value" state with no grants and no `.env` records. Every field is untrusted: at
/// most [`IMPORT_MAX`] rows, a name that normalizes, a label no longer than a saved one, a last four of four characters.
pub fn import_index(conn: &Connection, index: &Value, now: i64) -> Result<usize, String> {
    let Some(list) = index.get("secrets").and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut added = 0;
    for item in list {
        if added >= IMPORT_MAX {
            break;
        }
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Ok(name) = normalize_name(name) else {
            continue;
        };
        // A scope that is there but is not one is skipped, never widened to `global`; no scope at all is global.
        let scope = match item.get("scope") {
            None | Some(Value::Null) => SCOPE_GLOBAL.to_string(),
            Some(Value::String(scope)) if valid_scope(scope) && scope.len() <= IMPORT_SCOPE_MAX => {
                scope.clone()
            }
            Some(_) => continue,
        };
        if get_secret(conn, &scope, &name)?.is_some() {
            continue;
        }
        let label = imported_label(item.get("label").and_then(Value::as_str), &name);
        let last4 = imported_last4(item.get("last4").and_then(Value::as_str));
        conn.execute(
            "INSERT INTO secrets (scope, name, label, last4, created_at, updated_at, last_used_at, version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL, 0)
             ON CONFLICT (scope, name) DO NOTHING",
            params![scope, name, label, last4, now],
        )
        .map_err(|e| e.to_string())?;
        added += 1;
    }
    Ok(added)
}

/// Whether the person has added a value for an imported row.
pub fn has_value(vault: &dyn Vault, scope: &str, name: &str) -> Result<bool, String> {
    Ok(vault
        .read(&service(scope, name)?, ACCOUNT)?
        .is_some_and(|value| !value.is_empty()))
}

/// The value for a grant's service, re-read at run time.
pub fn read_value(vault: &dyn Vault, scope: &str, name: &str) -> Result<Zeroizing<String>, String> {
    let service = service(scope, name)?;
    match vault.read(&service, ACCOUNT)? {
        Some(value) => Ok(Zeroizing::new(value)),
        None => Err("That secret was deleted. Ask for it again.".into()),
    }
}

// ---- the run --------------------------------------------------------------------------------------------------------

/// What the webview passes to `secrets_grant`, and what `secrets.run` checked before it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    /// The asking chat's session id.
    pub chat: String,
    #[serde(default)]
    pub mono: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    pub name: String,
    pub env: String,
    pub command: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

/// Refused before any grant: a shell line rather than an argv is exactly what this route exists to stop.
pub const SHELLS: [&str; 14] = [
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "csh",
    "tcsh",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
];

/// `env` is a wrapper too: it would run anything with the secret in its environment.
pub fn executable_of(command: &[String]) -> Result<String, String> {
    let first = command
        .first()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Give the command to run, as a list of words.".to_string())?;
    if command.iter().any(|arg| arg.contains('\0')) {
        return Err("That command has a control character in it.".into());
    }
    let base = first
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(first)
        .to_ascii_lowercase();
    if SHELLS.contains(&base.as_str()) || base == "env" || base == "env.exe" {
        return Err(
            "Give the command itself, not a shell. Put each word in the list; a shell line could hide the key."
                .into(),
        );
    }
    if first.split([' ', '\t']).count() > 1 {
        return Err(
            "That looks like a whole command line in one word. Put each word in the list instead."
                .into(),
        );
    }
    Ok(first.to_string())
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state")]
pub enum RunOutcome {
    /// No secret of that name in scope: call `secrets.request`.
    #[serde(rename = "missing")]
    Missing { name: String, scope: String },
    /// The person hasn't approved this executable yet (or hasn't answered).
    #[serde(rename = "waiting")]
    Waiting {
        #[serde(rename = "decisionKey")]
        decision_key: String,
        name: String,
        scope: String,
    },
    /// The person said no.
    #[serde(rename = "denied")]
    Denied {
        #[serde(rename = "decisionKey")]
        decision_key: String,
        name: String,
    },
    /// The run may start.
    #[serde(rename = "granted")]
    Granted {
        grant: String,
        scope: String,
        name: String,
        version: i64,
        env: String,
        #[serde(rename = "timeoutSeconds")]
        timeout_seconds: u64,
    },
}

fn decision_key(name: &str, executable: &str) -> String {
    let safe: String = format!("secret/{name}/{executable}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/') {
                c
            } else {
                '-'
            }
        })
        .collect();
    safe.chars().take(120).collect()
}

/// The approval options. "Always for this project" only exists when the chat has a project, and the two "Always"
/// answers only exist when the program is not one that can run any code (or the person has turned that on).
pub fn approval_options(has_project: bool, always_allowed: bool) -> Vec<String> {
    let mut options = vec!["Once".to_string()];
    if always_allowed {
        options.push("Always for this Mono".to_string());
        if has_project {
            options.push("Always for this project".into());
        }
    }
    options.push("No".into());
    options
}

/// Whether the card may offer "Always" for this program: any program, unless it can run any code and the person has not
/// turned the choice on.
pub fn always_allowed_for(conn: &Connection, executable: &str) -> bool {
    !runs_any_code(executable) || always_for_any_code(conn)
}

// ---- programs that can run any code, and the person's choice about them ------------------------------------------------

/// Programs that run whatever code they are handed (WP-92 step 10): approving one with the key in its environment is
/// approving arbitrary code. Matched by basename, `.exe` ignored.
pub const RUN_ANYTHING: [&str; 26] = [
    "python",
    "python3",
    "node",
    "deno",
    "bun",
    "ruby",
    "perl",
    "php",
    "make",
    "xargs",
    "awk",
    "sed",
    "find",
    "osascript",
    "npx",
    "npm",
    "pnpm",
    "yarn",
    "uv",
    "uvx",
    "cargo",
    "go",
    "java",
    "lua",
    "rscript",
    "swift",
];

/// The line the card carries for such a program while "Always" is not allowed.
pub const RUN_ANYTHING_NOTE: &str = "This can run any code, so it asks every time.";

/// The warning that sits beside the setting and under the "Always" buttons.
pub const ALWAYS_WARNING: &str =
    "'Always' lets an agent use this key for anything, without asking you. Leave this off unless you are sure.";

/// What a refused "Always" says.
pub const ALWAYS_REFUSED: &str = "This can run any code, so it asks every time. To allow Always for programs like this, turn on \"Let me choose 'Always' for programs that can run any code\" on the Secrets page.";

/// The program a path names: the part after the last `/` or `\`.
pub fn program_base(executable: &str) -> &str {
    executable.rsplit(['/', '\\']).next().unwrap_or(executable)
}

/// Whether this program can run any code it is handed. The basename is compared in lower case with `.exe` (and the
/// Windows `.cmd` and `.bat` wrappers) and a trailing version (`python3.12`) taken off.
pub fn runs_any_code(executable: &str) -> bool {
    let mut name = program_base(executable.trim()).to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat"] {
        if let Some(stripped) = name.strip_suffix(ext) {
            name = stripped.to_string();
            break;
        }
    }
    let bare = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.' || c == '-');
    RUN_ANYTHING.contains(&name.as_str()) || (!bare.is_empty() && RUN_ANYTHING.contains(&bare))
}

const SETTING_ALWAYS_ANY_CODE: &str = "always_for_any_code";

/// The person's per-install choice: may "Always" be picked for a program that can run any code. Off unless the row says
/// exactly `1`; a store that cannot be read is off too.
pub fn always_for_any_code(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT value FROM secret_settings WHERE key = ?1",
        params![SETTING_ALWAYS_ANY_CODE],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .as_deref()
        == Some("1")
}

/// Turn the choice on or off. Turning it off also takes back every "Always" it had allowed for a program that can run
/// any code, so "off" means those programs ask every time again; the number taken back is returned.
pub fn set_always_for_any_code(conn: &Connection, on: bool) -> Result<usize, String> {
    conn.execute(
        "INSERT INTO secret_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![SETTING_ALWAYS_ANY_CODE, if on { "1" } else { "0" }],
    )
    .map_err(|e| e.to_string())?;
    if on {
        return Ok(0);
    }
    let mut stmt = conn
        .prepare(
            "SELECT scope, name, subject_kind, subject_id, executable FROM secret_grants WHERE mode = 'always'",
        )
        .map_err(|e| e.to_string())?;
    let always: Vec<(String, String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut removed = 0;
    for (scope, name, kind, subject, executable) in always {
        if !runs_any_code(&executable) {
            continue;
        }
        removed += conn
            .execute(
                "DELETE FROM secret_grants WHERE scope = ?1 AND name = ?2 AND subject_kind = ?3
                 AND subject_id = ?4 AND executable = ?5 AND mode = 'always'",
                params![scope, name, kind, subject, executable],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

/// The most the card shows of a command line. A command that cannot be shown whole is not asked about.
pub const COMMAND_LINE_MAX: usize = 1_400;

/// A name shown on a card with every control character written out, so nothing in it can start a line of its own.
fn escape_controls(text: &str) -> String {
    let mut shown = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\n' => shown.push_str("\\n"),
            '\r' => shown.push_str("\\r"),
            '\t' => shown.push_str("\\t"),
            c if c.is_control() => shown.push_str(&format!("\\x{:02x}", c as u32)),
            c => shown.push(c),
        }
    }
    shown
}

/// One word of a command as the card shows it: control characters written out, and a word with a space, a quote or a
/// shell character in single quotes, so the words stay apart and no argument can start a line of its own.
fn display_word(word: &str) -> String {
    let shown = escape_controls(word);
    let plain = !shown.is_empty()
        && !shown.chars().any(|c| {
            c.is_whitespace()
                || matches!(
                    c,
                    '\'' | '"'
                        | '\\'
                        | '$'
                        | '`'
                        | '!'
                        | ';'
                        | '&'
                        | '|'
                        | '<'
                        | '>'
                        | '('
                        | ')'
                        | '*'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                        | '~'
                        | '#'
                )
        });
    if plain {
        shown
    } else {
        format!("'{}'", shown.replace('\'', "'\\''"))
    }
}

/// The whole command as the card shows it.
pub fn display_command(command: &[String]) -> String {
    command
        .iter()
        .map(|word| display_word(word))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The words on a secret run's card: who asks to run what, the exact command, and (for a program that can run any code)
/// why it is asked every time or what "Always" would mean. The first line is the title the Inbox shows; the others sit
/// under it. Never the value.
pub fn run_question(
    mono: &str,
    label: &str,
    whose: &str,
    command: &[String],
    always_allowed: bool,
    runs_any: bool,
) -> Result<String, String> {
    let executable = command.first().map(String::as_str).unwrap_or("");
    // Every name that goes on a line of the card is written out first: a program, a label or a Mono's name with a line
    // break in it must not be able to forge a line (a warning, or a different command).
    let program = escape_controls(program_base(executable));
    let (mono, label, whose) = (
        escape_controls(mono),
        escape_controls(label),
        escape_controls(whose),
    );
    let line = display_command(command);
    if line.chars().count() > COMMAND_LINE_MAX {
        return Err(
            "That command is too long to show on the approval card, so it wasn't run. Put the long part in a file and pass the file's path instead."
                .into(),
        );
    }
    let mut text = format!(
        "Let {mono} run `{program}` with {label}?\nThe program is {program}.\nKey: {label}, saved for {whose}\nCommand: {line}"
    );
    if runs_any && !always_allowed {
        text.push('\n');
        text.push_str(RUN_ANYTHING_NOTE);
    }
    if runs_any && always_allowed {
        text.push_str("\nWarning: ");
        text.push_str(ALWAYS_WARNING);
    }
    Ok(text)
}

/// One first-use approval: what the card asks, and for whom.
pub struct Approval {
    pub chat: String,
    pub mono: Option<String>,
    pub project: Option<String>,
    pub scope: String,
    pub name: String,
    pub executable: String,
    pub question: String,
    pub options: Vec<String>,
    pub recommended: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApprovalOutcome {
    /// The person hasn't answered the card yet (or a racing run spent the once grant first).
    Waiting { decision_key: String },
    /// The person said no.
    Denied { decision_key: String },
    /// A live grant covers this run.
    Granted,
}

/// The grant check shared by one command and one worker: the Mono's own first, then its project's, then the person's
/// card. An answer becomes the grant and the answered card is cleared, so revoking a grant asks again.
///
/// Only the person's own answer counts. A row answered any other way (a chat forwarding an `ask_person` answer, or a
/// write that got past them) is treated as not answered: nothing is granted and nothing is deleted.
pub fn ensure_grant(
    conn: &mut Connection,
    input: Approval,
    now: i64,
) -> Result<ApprovalOutcome, String> {
    if find_grant(
        conn,
        &input.scope,
        &input.name,
        input.mono.as_deref(),
        input.project.as_deref(),
        &input.executable,
    )?
    .is_some()
    {
        return Ok(ApprovalOutcome::Granted);
    }
    let project = input.project.as_deref().unwrap_or("");
    let key = decision_key(&input.name, &input.executable);
    let decision = crate::decisions::get(conn, project, &key)?;
    // The card is put up for one Mono's run (or one worker's), and only that Mono may spend its answer.
    let asked_for = input
        .mono
        .as_deref()
        .ok_or_else(|| "Which Mono is asking?".to_string())?;
    let answered_by_person_for_this_mono = decision.as_ref().is_some_and(|decision| {
        decision.state == crate::decisions::ANSWERED
            && crate::decisions::answered_by_person(decision.answered_by.as_deref())
            && match decision.asked_by_mono.as_deref() {
                Some(mono) => mono == asked_for,
                None => true,
            }
    });
    match decision.filter(|_| answered_by_person_for_this_mono) {
        Some(decision) => {
            let answer = decision.answer.clone().unwrap_or_default();
            if answer == "No" {
                return Ok(ApprovalOutcome::Denied { decision_key: key });
            }
            let mono = asked_for;
            let granted = (|| -> Result<bool, String> {
                if answer == "Always for this project" {
                    if let Some(project) = input.project.as_deref() {
                        put_grant(
                            conn,
                            &input.scope,
                            &input.name,
                            "project",
                            project,
                            &input.executable,
                            "always",
                            now,
                        )?;
                    }
                } else if answer == "Always for this Mono" {
                    put_grant(
                        conn,
                        &input.scope,
                        &input.name,
                        "mono",
                        mono,
                        &input.executable,
                        "always",
                        now,
                    )?;
                } else {
                    // "Once": it is spent here. Two racing runs cannot both spend it.
                    put_grant(
                        conn,
                        &input.scope,
                        &input.name,
                        "mono",
                        mono,
                        &input.executable,
                        "once",
                        now,
                    )?;
                    if !spend_once(conn, &input.scope, &input.name, mono, &input.executable)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            })();
            match granted {
                Ok(true) => {}
                Ok(false) => return Ok(ApprovalOutcome::Waiting { decision_key: key }),
                Err(why) => {
                    if why == ALWAYS_REFUSED {
                        // An "Always" the person's setting does not allow grants nothing and is not kept: the next run
                        // is asked again, on the card that offers what is allowed.
                        let _ = conn.execute(
                            "DELETE FROM decisions WHERE project = ?1 AND decision_key = ?2",
                            params![project, key],
                        );
                    }
                    return Err(why);
                }
            }
            // The answer has become a grant: clear the card so the next run (after a revoke, or a second once) asks
            // again. A "No" stays answered, so the person is not asked over and over.
            let _ = conn.execute(
                "DELETE FROM decisions WHERE project = ?1 AND decision_key = ?2",
                params![project, key],
            );
            Ok(ApprovalOutcome::Granted)
        }
        _ => {
            // The person is asked through the same decision store the Inbox already shows.
            let outcome = crate::decisions::ask(
                conn,
                crate::decisions::AskInput {
                    asked_by: input.chat.clone(),
                    asked_by_mono: input.mono.clone(),
                    project: input.project.clone(),
                    key: key.clone(),
                    question: input.question.clone(),
                    options: input.options.clone(),
                    recommended: Some(input.recommended.clone()),
                    task_ids: Vec::new(),
                },
                now,
            )?;
            if !outcome.created {
                // Still waiting on the person: the card shows what is being asked now, not an older command line.
                crate::decisions::refresh_open(
                    conn,
                    project,
                    &key,
                    &input.question,
                    &input.options,
                    Some(&input.recommended),
                    input.mono.as_deref(),
                    now,
                )?;
            }
            Ok(ApprovalOutcome::Waiting { decision_key: key })
        }
    }
}

/// Check everything, then either ask the person, refuse, or sign one grant.
pub fn prepare_run(
    vault: &dyn Vault,
    conn: &mut Connection,
    request: RunRequest,
    now: i64,
) -> Result<RunOutcome, String> {
    let chat = request.chat.trim();
    if chat.is_empty() {
        return Err("Which chat is asking?".into());
    }
    // A worker cannot ask for itself: its first mate asks, approves and decides what it gets (WP-92 step 6).
    crate::decisions::check_may_ask(conn, chat)?;
    let name = normalize_name(&request.name)?;
    let project = request
        .project
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    // 2. a secret resolves in scope: the chat's project first, then global.
    let Some(row) = resolve(conn, project.as_deref(), &name)? else {
        return Ok(RunOutcome::Missing {
            name,
            scope: scope_for(project.as_deref()),
        });
    };
    let value = match vault.read(&service(&row.scope, &row.name)?, ACCOUNT)? {
        Some(value) if !value.is_empty() => Zeroizing::new(value),
        _ => {
            return Ok(RunOutcome::Missing {
                name: row.name,
                scope: row.scope,
            })
        }
    };
    // The command: argv only, never a shell.
    let executable = executable_of(&request.command)?;
    // The card puts the whole command line in a database row, so a command that holds the value never gets that far.
    if request
        .command
        .iter()
        .any(|arg| arg.contains(value.as_str()))
    {
        return Err(
            "That command already holds the key in its own words, so it wasn't run. Name the key through the environment instead."
                .into(),
        );
    }
    if !valid_env_name(&request.env) {
        return Err(
            "The environment variable's name is capital letters, digits and underscores, like STRIPE_API_KEY."
                .into(),
        );
    }
    if run::is_allowlisted_env(&request.env) {
        return Err(format!(
            "{} is one of the names the command already gets. Pick a name of its own.",
            request.env
        ));
    }
    // 5. cwd resolves inside the current project; no project means no cwd.
    let cwd = match request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        None => None,
        Some(cwd) => {
            let Some(project) = project.as_deref() else {
                return Err("A run outside a project has no folder to run in.".into());
            };
            Some(env_file::inside_project(project, cwd)?)
        }
    };
    let timeout_seconds = match request.timeout_seconds {
        None | Some(0) => TIMEOUT_DEFAULT,
        Some(seconds) => seconds.min(TIMEOUT_MAX),
    };
    // 3. a live grant for this Mono (then its project), or ask the person first, on a card that shows the whole command.
    let always_allowed = always_allowed_for(conn, &executable);
    // Which copy this run uses, in plain words: where the key lives, and that a project's copy beats the global one.
    let whose = if has_global_twin(conn, &row) {
        format!("{}. {PROJECT_COPY_USED}", scope_words(&row.scope))
    } else {
        scope_words(&row.scope)
    };
    let question = run_question(
        request.mono.as_deref().unwrap_or("this Mono"),
        &row.label,
        &whose,
        &request.command,
        always_allowed,
        runs_any_code(&executable),
    )?;
    match ensure_grant(
        conn,
        Approval {
            chat: chat.to_string(),
            mono: request.mono.clone(),
            project: project.clone(),
            scope: row.scope.clone(),
            name: row.name.clone(),
            executable: executable.clone(),
            question,
            options: approval_options(project.is_some(), always_allowed),
            recommended: "Once".into(),
        },
        now,
    )? {
        ApprovalOutcome::Waiting { decision_key } => {
            return Ok(RunOutcome::Waiting {
                decision_key,
                name: row.name,
                scope: row.scope,
            })
        }
        ApprovalOutcome::Denied { decision_key } => {
            return Ok(RunOutcome::Denied {
                decision_key,
                name: row.name,
            })
        }
        ApprovalOutcome::Granted => {}
    }
    // 6. The version the grant names is the one just read.
    let payload = grant::Payload {
        scope: row.scope.clone(),
        name: row.name.clone(),
        version: row.version,
        subject: request.mono.unwrap_or_else(|| chat.to_string()),
        env: request.env.clone(),
        command: request.command.clone(),
        cwd,
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        expires_at: now + GRANT_TTL_MS,
        timeout_seconds,
    };
    let grant = grant::sign_payload(vault, &payload)?;
    Ok(RunOutcome::Granted {
        grant,
        scope: row.scope,
        name: row.name,
        version: row.version,
        env: payload.env,
        timeout_seconds,
    })
}

/// One activity row per run: the name, scope, Mono, executable, exit code and duration. Never the grant, never the
/// value.
#[allow(clippy::too_many_arguments)]
pub fn record_run(
    conn: &Connection,
    scope: &str,
    name: &str,
    mono: &str,
    executable: &str,
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: i64,
    at: i64,
) -> Result<(), String> {
    let summary = format!(
        "{} ran `{}` with {} ({}): {}",
        mono,
        executable,
        name,
        scope_words(scope),
        if timed_out {
            format!("timed out after {}s", duration_ms / 1000)
        } else {
            format!(
                "exit {}",
                exit_code.map(|c| c.to_string()).unwrap_or("none".into())
            )
        }
    );
    crate::activity::record(
        conn,
        "secret.run",
        &crate::activity::Who::mono(mono, mono),
        &crate::activity::Who::mono(mono, mono),
        "",
        name,
        &summary,
        "",
        at,
    )
    .map(|_| ())
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod approval_tests;
#[cfg(test)]
mod security_tests;
#[cfg(test)]
mod tests;
