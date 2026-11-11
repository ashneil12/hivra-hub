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

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
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

/// A program the tests can pin that runs no code of its own. Unix keeps `/usr/bin/true`. On Windows that path is not
/// absolute, so pin refuses it; `where.exe` ships with Windows and is not on the run-anything list.
#[cfg(test)]
pub(crate) fn harmless_program() -> &'static str {
    #[cfg(unix)]
    {
        "/usr/bin/true"
    }
    #[cfg(windows)]
    {
        r"C:\Windows\System32\where.exe"
    }
    #[cfg(not(any(unix, windows)))]
    {
        "true"
    }
}

/// A program the tests can pin that can run any code it is handed. Unix keeps a bare `python3` (looked up on the system
/// path). Windows looks bare names up on that same Unix list, so the tests use `find.exe`, which is on the run-anything
/// list and ships with Windows.
#[cfg(test)]
pub(crate) fn code_program() -> &'static str {
    #[cfg(unix)]
    {
        "python3"
    }
    #[cfg(windows)]
    {
        r"C:\Windows\System32\find.exe"
    }
    #[cfg(not(any(unix, windows)))]
    {
        "python3"
    }
}

/// Same as [`code_program`], for a test whose Unix fixture is `node`.
#[cfg(test)]
pub(crate) fn node_program() -> &'static str {
    #[cfg(unix)]
    {
        "node"
    }
    #[cfg(windows)]
    {
        r"C:\Windows\System32\find.exe"
    }
    #[cfg(not(any(unix, windows)))]
    {
        "node"
    }
}

/// curl, which the card says can read a config file. A bare name on Unix. An absolute `curl.exe` on Windows, because a
/// bare name is looked up on the Unix search list there.
#[cfg(test)]
pub(crate) fn curl_program() -> &'static str {
    #[cfg(unix)]
    {
        "curl"
    }
    #[cfg(windows)]
    {
        r"C:\Windows\System32\curl.exe"
    }
    #[cfg(not(any(unix, windows)))]
    {
        "curl"
    }
}

/// The absolute curl a card-text test names. On Unix the question shows this path. On Windows, `curl.exe`.
#[cfg(test)]
pub(crate) fn curl_absolute() -> &'static str {
    #[cfg(unix)]
    {
        "/usr/bin/curl"
    }
    #[cfg(windows)]
    {
        r"C:\Windows\System32\curl.exe"
    }
    #[cfg(not(any(unix, windows)))]
    {
        "curl"
    }
}

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

/// Why a name cannot carry a key, or `None` when it can (fix round 4, N1). A name the program reads for its own behaviour (a
/// loader, a proxy, a key log, a home or config folder, a start-up file, a runtime's options) changes what runs with the
/// key, so only a credential-shaped name is accepted: one that ends like a credential (`_KEY`, `_TOKEN`, `_SECRET`,
/// `_PASSWORD`, `_PAT`, `_PASSPHRASE`, `_CREDENTIALS`) and is none of the behaviour names.
pub fn env_name_refusal(name: &str) -> Option<String> {
    if !valid_env_name(name) {
        return Some(
            "The environment variable's name is capital letters, digits and underscores, like STRIPE_API_KEY.".into(),
        );
    }
    const CREDENTIAL_ENDINGS: [&str; 7] = [
        "_KEY",
        "_TOKEN",
        "_SECRET",
        "_PASSWORD",
        "_PAT",
        "_PASSPHRASE",
        "_CREDENTIALS",
    ];
    const BEHAVIOUR_PREFIXES: [&str; 8] = [
        "DYLD_", "LD_", "NODE_", "PYTHON", "GIT_", "XDG_", "CURL_", "BASH_",
    ];
    const BEHAVIOUR_PARTS: [&str; 7] = [
        "PRELOAD", "PROXY", "OPTIONS", "_HOME", "_DIR", "_PATH", "_FILE",
    ];
    let credential_shaped = CREDENTIAL_ENDINGS
        .iter()
        .any(|ending| name.ends_with(ending));
    let changes_behaviour = BEHAVIOUR_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
        || BEHAVIOUR_PARTS.iter().any(|part| name.contains(part))
        || name == "SSLKEYLOGFILE";
    if credential_shaped && !changes_behaviour {
        return None;
    }
    Some(
        "That name changes how the command runs, so it can't carry a key. Name the key the way a credential is named, like STRIPE_API_KEY."
            .into(),
    )
}

// ---- the tables ----------------------------------------------------------------------------------------------------

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    ensure_tables_batch(conn)?;
    // A grant now names the program's file identity. A table from before that has no such column, and every grant in it
    // names a bare program name that is never pinned now, so the table is emptied: those runs ask again, once.
    if conn
        .prepare("SELECT identity FROM secret_grants LIMIT 0")
        .is_err()
    {
        conn.execute_batch(
            "ALTER TABLE secret_grants ADD COLUMN identity TEXT NOT NULL DEFAULT '';
             DELETE FROM secret_grants;",
        )?;
    }
    // Fix round 3 (H3): a grant names the exact command it covers. A table from before that is emptied: those grants
    // named only the program, which Always must no longer cover.
    if conn
        .prepare("SELECT fingerprint FROM secret_grants LIMIT 0")
        .is_err()
    {
        conn.execute_batch(
            "ALTER TABLE secret_grants ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
             DELETE FROM secret_grants;",
        )?;
    }
    // Fix round 4 (LOW): a grant is one row per exact command. A table keyed by the program alone let a Once answer for one
    // command overwrite an Always for another, so it is rebuilt with the command in its key and its rows kept.
    let keyed_by_program: bool = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'secret_grants'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|sql| sql.contains("PRIMARY KEY (scope, name, subject_kind, subject_id, executable)"))
        .unwrap_or(false);
    if keyed_by_program {
        let rebuilt = conn.execute_batch(
            "BEGIN;
             ALTER TABLE secret_grants RENAME TO secret_grants_before_round4;
             CREATE TABLE secret_grants (
               scope TEXT NOT NULL,
               name TEXT NOT NULL,
               subject_kind TEXT NOT NULL,
               subject_id TEXT NOT NULL,
               executable TEXT NOT NULL,
               mode TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               identity TEXT NOT NULL DEFAULT '',
               fingerprint TEXT NOT NULL DEFAULT '',
               PRIMARY KEY (scope, name, subject_kind, subject_id, executable, fingerprint)
             );
             INSERT INTO secret_grants (scope, name, subject_kind, subject_id, executable, mode, created_at, identity, fingerprint)
               SELECT scope, name, subject_kind, subject_id, executable, mode, created_at, identity, fingerprint
               FROM secret_grants_before_round4;
             DROP TABLE secret_grants_before_round4;
             COMMIT;",
        );
        if let Err(why) = rebuilt {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(why);
        }
    }
    Ok(())
}

fn ensure_tables_batch(conn: &Connection) -> rusqlite::Result<()> {
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
           identity TEXT NOT NULL DEFAULT '',
           fingerprint TEXT NOT NULL DEFAULT '',
           PRIMARY KEY (scope, name, subject_kind, subject_id, executable, fingerprint)
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
         );
         CREATE TABLE IF NOT EXISTS secret_card_bindings (
           project TEXT NOT NULL,
           decision_key TEXT NOT NULL,
           fingerprint TEXT NOT NULL,
           PRIMARY KEY (project, decision_key)
         );
         CREATE TABLE IF NOT EXISTS secret_card_epochs (
           project TEXT NOT NULL,
           decision_key TEXT NOT NULL,
           high_water INTEGER NOT NULL,
           PRIMARY KEY (project, decision_key)
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
    /// The program's file identity the grant was given for (empty for a worker's grant, which names no file).
    pub identity: String,
    /// The exact command the grant covers (arguments, environment name, folder, timeout): another command asks again.
    pub fingerprint: String,
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
pub fn needles_for(vault: &dyn Vault, names: &[(String, String)]) -> Result<Vec<String>, String> {
    let mut needles = Vec::new();
    for (scope, name) in names {
        let service = service(scope, name)?;
        // No item means there is no value to hide. A read that fails is not "no value": the caller must not go on.
        if let Some(value) = vault.read(&service, ACCOUNT)? {
            needles.extend(scrub::needles(&Zeroizing::new(value)));
        }
    }
    needles.sort_by_key(|needle| std::cmp::Reverse(needle.len()));
    needles.dedup();
    Ok(needles)
}

/// [`known_names`] then [`needles_for`], for a caller that holds nothing a Keychain prompt could stall.
pub fn known_needles(
    vault: &dyn Vault,
    conn: &Connection,
    scope: Option<&str>,
) -> Result<Vec<String>, String> {
    needles_for(vault, &known_names(conn, scope))
}

/// Whether text holds any listed value, whatever its shape. Used by the memory save and the export.
pub fn holds_known_value(
    vault: &dyn Vault,
    conn: &Connection,
    scope: Option<&str>,
    text: &str,
) -> bool {
    match known_needles(vault, conn, scope) {
        Ok(needles) => needles.iter().any(|needle| scrub::holds(text, needle)),
        // Unknown is treated as held: the save or the export refuses rather than writing a value it could not check.
        Err(_) => true,
    }
}

/// Every listed value in `text` replaced with the marker, then the shared pattern list. The export's exact-value pass.
pub fn redact_known_values(
    vault: &dyn Vault,
    conn: &Connection,
    scope: Option<&str>,
    text: &str,
) -> String {
    match known_needles(vault, conn, scope) {
        Ok(needles) => scrub::mask(text, &needles),
        // The whole text is withheld when the values cannot be read to hide them.
        Err(_) => scrub::MARKER.to_string(),
    }
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
            "SELECT scope, name, subject_kind, subject_id, executable, mode, created_at, identity, fingerprint
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
                identity: row.get(7)?,
                fingerprint: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Which grant covers this run: the Mono's own first, then its project's. The program must be the same file (its
/// identity), not only the same name.
#[allow(clippy::too_many_arguments)]
pub fn find_grant(
    conn: &Connection,
    scope: &str,
    name: &str,
    mono: Option<&str>,
    project: Option<&str>,
    executable: &str,
    identity: &str,
    fingerprint: &str,
) -> Result<Option<GrantRow>, String> {
    let same = |g: &GrantRow| {
        g.mode != "always"
            && g.executable == executable
            && g.identity == identity
            && g.fingerprint == fingerprint
    };
    if let Some(mono) = mono {
        if let Some(grant) = grants_for(conn, scope, name)?
            .into_iter()
            .find(|g| g.subject_kind == "mono" && g.subject_id == mono && same(g))
        {
            return Ok(Some(grant));
        }
    }
    if let Some(project) = project {
        if let Some(grant) = grants_for(conn, scope, name)?
            .into_iter()
            .find(|g| g.subject_kind == "project" && g.subject_id == project && same(g))
        {
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
    identity: &str,
    fingerprint: &str,
    mode: &str,
    now: i64,
) -> Result<(), String> {
    // Round 5: Always is not written for any program. A program that can run any code keeps its own sentence, so an
    // older test still sees why that kind of program asks every time. Everything else, including a worker, is told
    // that Always is not offered.
    if mode == "always" {
        if !executable.starts_with("worker:") && runs_any_for(executable) {
            return Err(ALWAYS_REFUSED.into());
        }
        return Err(ALWAYS_NOT_OFFERED.into());
    }
    conn.execute(
        "INSERT INTO secret_grants (scope, name, subject_kind, subject_id, executable, mode, created_at, identity, fingerprint)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (scope, name, subject_kind, subject_id, executable, fingerprint)
         DO UPDATE SET mode = excluded.mode, created_at = excluded.created_at, identity = excluded.identity",
        params![scope, name, subject_kind, subject_id, executable, mode, now, identity, fingerprint],
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
    identity: &str,
    fingerprint: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "DELETE FROM secret_grants WHERE scope = ?1 AND name = ?2 AND subject_kind = 'mono'
             AND subject_id = ?3 AND executable = ?4 AND identity = ?5 AND fingerprint = ?6 AND mode = 'once'",
            params![scope, name, mono, executable, identity, fingerprint],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// The next version number for one secret card. The counter survives the card being deleted, so a version that was
/// already shown is never issued again (fix round 6). A gap is fine. A repeat is not.
///
/// The first number for a key that already has a decision is one past that decision's version, so an install from
/// before this counter does not reissue a version the person has already seen.
pub(crate) fn alloc_card_version(
    conn: &Connection,
    project: &str,
    key: &str,
) -> Result<i64, String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS secret_card_epochs (
           project TEXT NOT NULL,
           decision_key TEXT NOT NULL,
           high_water INTEGER NOT NULL,
           PRIMARY KEY (project, decision_key)
         );",
    )
    .map_err(|e| e.to_string())?;
    let current: i64 = conn
        .query_row(
            "SELECT version FROM decisions WHERE project = ?1 AND decision_key = ?2",
            params![project, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    let seed = current.max(0) + 1;
    conn.execute(
        "INSERT INTO secret_card_epochs (project, decision_key, high_water) VALUES (?1, ?2, ?3)
         ON CONFLICT (project, decision_key) DO UPDATE SET high_water = high_water + 1",
        params![project, key, seed],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT high_water FROM secret_card_epochs WHERE project = ?1 AND decision_key = ?2",
        params![project, key],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
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

/// Pin the program a run will start: its canonical absolute path and its file identity. A bare name is looked up once, on
/// the fixed search path (never a caller's PATH); a relative path is refused, since it means whatever the run's folder
/// holds; a program in the project, the run's folder, a temporary folder or a worktree is refused, since the agent can
/// write there.
pub fn pin_program(
    word: &str,
    project: Option<&str>,
    cwd: Option<&str>,
) -> Result<(String, String), String> {
    // The word is written out before it is echoed: a name with a line break must not reach a message as a line.
    let not_installed = || format!("{} isn't installed on this Mac.", escape_program(word));
    let found = if std::path::Path::new(word).is_absolute() {
        std::path::PathBuf::from(word)
    } else if word.contains('/') || word.contains('\\') {
        return Err(
            "Give the program's full path, or just its name. A relative path could be anything in the folder it runs in."
                .into(),
        );
    } else {
        run::resolve_program(word, &run::search_path()).ok_or_else(not_installed)?
    };
    let canonical = std::fs::canonicalize(&found).map_err(|_| not_installed())?;
    if run::refuse_shell_program(&canonical) {
        return Err(
            "Give the command itself, not a shell. A link to a shell is a shell, so it wasn't run."
                .into(),
        );
    }
    if let Some(why) = run::program_location_refusal(&canonical, project, cwd) {
        return Err(why);
    }
    let identity = run::program_identity(&canonical)
        .ok_or_else(|| format!("{} isn't a program file.", escape_program(word)))?;
    Ok((canonical.to_string_lossy().into_owned(), identity))
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
        /// Never serialised: the grant is spent by `secrets_grant` in Rust and does not reach the webview.
        #[serde(skip_serializing)]
        grant: String,
        scope: String,
        name: String,
        version: i64,
        env: String,
        #[serde(rename = "timeoutSeconds")]
        timeout_seconds: u64,
    },
}

/// The card's key: the name and a digest of the exact thing approved (the pinned program, its identity, its arguments,
/// environment, folder and timeout, or a worker's CLI). A different file, argument or environment is a different card.
pub fn decision_key(name: &str, fingerprint: &str) -> String {
    let digest: String = Sha256::digest(fingerprint.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("secret/{name}/{digest}")
}

/// The fingerprint of one command run, for [`decision_key`]: everything the person approved on the card.
pub fn run_fingerprint(
    executable: &str,
    identity: &str,
    env: &str,
    cwd: Option<&str>,
    command: &[String],
    timeout_seconds: u64,
) -> String {
    json!([
        "run",
        executable,
        identity,
        env,
        cwd,
        command,
        timeout_seconds
    ])
    .to_string()
}

/// The approval options. Round 5: a secret card is Once and No only. Always is not offered, whatever the project or
/// the program. The two flags stay so callers do not change.
pub fn approval_options(has_project: bool, always_allowed: bool) -> Vec<String> {
    let _ = (has_project, always_allowed);
    vec!["Once".to_string(), "No".to_string()]
}

/// Programs that run no code of their own. Round 5 does not offer Always for any of them. `curl` and `wget` were on
/// this list and can read a config file or run a helper the card does not show (`curl -K`, `--variable name@file`,
/// `--engine`, `wget --use-askpass`). An app-built curl that forces `-q` and only a few literal arguments could offer
/// Always later. That form is not built, and "use my own config" is not offered.
pub const ALWAYS_OFFERED_FOR: &[&str] = &[
    "true", "false", "echo", "printf", "cat", "ls", "head", "tail", "wc", "grep", "diff", "cmp",
    "stat", "date", "sleep", "curl", "wget", "whoami", "uname", "pwd",
];

/// What a refused "Always" says. Always is not offered for any program.
pub const ALWAYS_NOT_OFFERED: &str = "Always is not offered. This one asks every time.";

/// Whether the card may offer "Always". Round 5: never. The list stays so a later curl form has a place to start.
pub fn always_allowed_for(_conn: &Connection, _executable: &str) -> bool {
    false
}

/// The card says this when the program is curl, wget, or lives under Homebrew. Those can read a config file or run a
/// helper the card does not show.
pub const CONFIG_READER_NOTE: &str = "This program can read config files and run helpers.";

fn reads_config_or_helpers(executable: &str) -> bool {
    let mut base = program_base(executable).to_ascii_lowercase();
    if let Some(stripped) = base.strip_suffix(".exe") {
        base = stripped.to_string();
    }
    if base == "curl" || base == "wget" {
        return true;
    }
    let raw = std::path::Path::new(executable);
    let resolved = std::fs::canonicalize(raw).unwrap_or_else(|_| raw.to_path_buf());
    const ROOTS: &[&str] = &[
        "/opt/homebrew/",
        "/usr/local/Homebrew/",
        "/usr/local/Cellar/",
        "/home/linuxbrew/.linuxbrew/",
    ];
    [raw.to_path_buf(), resolved].iter().any(|path| {
        let text = path.to_string_lossy();
        ROOTS.iter().any(|root| text.starts_with(root))
    })
}

// ---- programs that can run any code, and the person's choice about them ------------------------------------------------

/// Programs that run whatever code they are handed (WP-92 step 10): approving one with the key in its environment is
/// approving arbitrary code. Matched by basename, `.exe` ignored.
pub const RUN_ANYTHING: &[&str] = &[
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
    "git",
    "gh",
    "ssh",
    "scp",
    "rsync",
    "docker",
    "podman",
    "kubectl",
    "tar",
    "busybox",
    "mksh",
    "nu",
    "xonsh",
    "env",
    "command",
    "exec",
    "nohup",
    "timeout",
    "gtimeout",
    "nice",
    "time",
    "stdbuf",
    "setsid",
    "sudo",
    "doas",
    "xcrun",
    "arch",
    "caffeinate",
    "pip",
    "pip3",
    "brew",
    "gem",
    "composer",
    "poetry",
    "pipx",
    "conda",
    "bundle",
    "rake",
    "cmake",
    "ninja",
    "gradle",
    "mvn",
    "bazel",
    "xcodebuild",
    "dotnet",
    "tsx",
    "ts-node",
    "bunx",
    "pnpx",
    "vim",
    "vi",
    "nvim",
    "nano",
    "emacs",
    "code",
    "less",
    "more",
    "man",
    "claude",
    "codex",
    "devin",
    "hermes",
    "cursor",
    "grok",
    "pi",
    "omp",
    "fx",
    "antigravity",
    "opencode",
    "aider",
    "goose",
    "gemini",
    "copilot",
    "amp",
    "sqlite3",
    "jq",
    "psql",
    "m4",
    "script",
    "lldb",
    "gsed",
    "gfind",
    "gxargs",
    "genv",
    "gnohup",
    "terraform",
    "pytest",
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "csh",
    "tcsh",
    // Fix round 4 (N4): the programs the probe found judged as plain programs. Each one runs code it is handed or a file
    // it names. Matched in lower case, so the R interpreter is `r`.
    "tclsh",
    "expect",
    "wish",
    "dc",
    "zip",
    "sandbox-exec",
    "taskpolicy",
    "ssh-agent",
    "screen",
    "tmux",
    "ex",
    "view",
    "erb",
    "irb",
    "pydoc3",
    "r",
    "gmake",
    "gawk",
    "nawk",
    "just",
    "task",
    "tofu",
    "pulumi",
    "helm",
    "hyperfine",
    "watch",
    "watchexec",
    "parallel",
    "mise",
    "direnv",
    "julia",
    "elixir",
    "racket",
    "sbcl",
    "mysql",
    "elvish",
    "yash",
    "sftp",
    "launchctl",
    "automator",
    "gdb",
    "nix",
    "nix-shell",
    "volta",
    "corepack",
    "pdm",
    "hatch",
    "tox",
    "nox",
    "runghc",
    "ocaml",
    "scala",
    "kotlin",
    "groovy",
    "erl",
    "escript",
    "guile",
    "clojure",
    "lein",
    "sbt",
    "flock",
    "chroot",
    "su",
    "watchman",
    "turbo",
    "nx",
    "zx",
];

/// The line the card carries for such a program while "Always" is not allowed.
pub const RUN_ANYTHING_NOTE: &str = "This can run any code, so it asks every time.";

/// The warning that sits beside the setting and under the "Always" buttons.
pub const ALWAYS_WARNING: &str =
    "'Always' lets an agent use this key for anything, without asking you. Leave this off unless you are sure.";

/// What a refused "Always" says.
pub const ALWAYS_REFUSED: &str = "This can run any code, so it asks every time.";

/// Whether a program can run any code it is handed, judged by its typed word and by its canonical path. A script is judged
/// by the interpreter on its `#!` line (`npx` pins to a JavaScript file that runs `node`; a `#!/bin/sh` script is a shell).
pub fn runs_any_for(executable: &str) -> bool {
    if runs_any_code(executable) {
        return true;
    }
    // Fix round 4 (N4): every script with a `#!` line runs code. Reading its interpreter line was not enough: `env` takes
    // options and assignments (`-S`, `-u X`, `A=1`), and a `#!` may name another script. A script is run-anything.
    has_shebang(std::path::Path::new(executable))
}

/// Whether the file starts with `#!`, read from its first two bytes. A file that cannot be read is not a script.
fn has_shebang(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut head))
        .is_ok()
        && &head == b"#!"
}

/// The program a path names: the part after the last `/` or `\`.
pub fn program_base(executable: &str) -> &str {
    executable.rsplit(['/', '\\']).next().unwrap_or(executable)
}

/// Whether this program can run any code it is handed. The basename is compared in lower case with `.exe` (and the
/// Windows `.cmd` and `.bat` wrappers) and a trailing version (`python3.12`) taken off.
pub fn runs_any_code(executable: &str) -> bool {
    let mut name = program_base(executable.trim()).to_ascii_lowercase();
    // Fix round 4 (LOW): a Windows batch file or PowerShell script is run by its interpreter, so it runs code whatever it is
    // called. Judged here, not by a list.
    if [".cmd", ".bat", ".ps1"]
        .iter()
        .any(|ext| name.ends_with(ext))
    {
        return true;
    }
    for ext in [".exe"] {
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
        // Fix round 4 (LOW): judged as the grant writer judges it, so a script's Always is taken back too.
        if !runs_any_for(&executable) {
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

/// Characters that show nothing or change the order of what follows (bidi overrides and isolates, zero-width spaces and
/// joiners, the byte order mark, soft hyphens), so a card written with them can read as a different command.
fn is_invisible(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD
            | 0x061C
            | 0x200B..=0x200F
            | 0x2028..=0x202E
            | 0x2060..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
    )
}

/// A name shown on a card with every control and invisible character written out, so nothing in it can start a line or
/// hide or reorder the text around it.
fn escape_controls(text: &str) -> String {
    let mut shown = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\n' => shown.push_str("\\n"),
            '\r' => shown.push_str("\\r"),
            '\t' => shown.push_str("\\t"),
            c if c.is_control() || is_invisible(c) => {
                shown.push_str(&format!("\\u{{{:x}}}", c as u32))
            }
            c => shown.push(c),
        }
    }
    shown
}

/// A program or a command word on a card: ASCII only. A letter from another alphabet that looks like one of ours is
/// written out (`\u{430}`), so a look-alike program name cannot pass for the one it imitates.
fn escape_program(text: &str) -> String {
    let mut shown = String::with_capacity(text.len());
    for c in escape_controls(text).chars() {
        if c.is_ascii() {
            shown.push(c);
        } else {
            shown.push_str(&format!("\\u{{{:x}}}", c as u32));
        }
    }
    shown
}

/// One word of a command as the card shows it: control characters written out, and a word with a space, a quote or a
/// shell character in single quotes, so the words stay apart and no argument can start a line of its own.
fn display_word(word: &str) -> String {
    let shown = escape_program(word);
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
#[allow(clippy::too_many_arguments)]
pub fn run_question(
    mono: &str,
    label: &str,
    whose: &str,
    command: &[String],
    always_allowed: bool,
    runs_any: bool,
    env: &str,
    folder: Option<&str>,
) -> Result<String, String> {
    let executable = command.first().map(String::as_str).unwrap_or("");
    // Every name that goes on a line of the card is written out first: a program, a label or a Mono's name with a line
    // break in it must not be able to forge a line (a warning, or a different command). The program is shown as its full
    // path, the file the person is approving.
    let program = escape_program(executable);
    let (mono, label, whose) = (
        escape_controls(mono),
        escape_controls(label),
        escape_controls(whose),
    );
    // Fix round 4 (N1): the environment name and the folder are on the card, so the person sees what the key is put under
    // and where the command runs.
    let env = escape_controls(env);
    let folder = match folder {
        Some(folder) => escape_controls(folder),
        None => "none (the command's home is a folder you cannot write)".to_string(),
    };
    let line = display_command(command);
    if line.chars().count() > COMMAND_LINE_MAX {
        return Err(
            "That command is too long to show on the approval card, so it wasn't run. Put the long part in a file and pass the file's path instead."
                .into(),
        );
    }
    let mut text = format!(
        "Let {mono} run `{program}` with {label}?\nThe program is {program}.\nFolder: {folder}\nEnvironment variable: {env}\nKey: {label}, saved for {whose}\nCommand: {line}\nWhile it runs, any program running as you can read this command's environment, so the key is visible to it."
    );
    if always_allowed {
        // Fix round 3 (H3): "Always" is for this exact command, not the program at large.
        text.push_str("\n'Always' covers this exact command only: the same program, arguments, environment name and folder.");
    }
    if runs_any && !always_allowed {
        text.push('\n');
        text.push_str(RUN_ANYTHING_NOTE);
    }
    if runs_any && always_allowed {
        text.push_str("\nWarning: ");
        text.push_str(ALWAYS_WARNING);
    }
    if reads_config_or_helpers(executable) {
        text.push('\n');
        text.push_str(CONFIG_READER_NOTE);
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
    /// The pinned program's file identity (empty for a worker's grant, which names no file).
    pub identity: String,
    /// What the card's key is made of: the program file (and its identity), so one card per program as before.
    pub key_source: String,
    /// The exact command the card shows. An answer approves only this fingerprint; another command asks again.
    pub fingerprint: String,
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
/// A stored grant is spent in the same transaction that finds it. Only a Mono `once` grant counts, and only if this
/// call deletes it. Anything else found here (a mode this code does not write) grants nothing. A crash cannot leave
/// the row for a later run: the delete commits with the check, or not at all.
fn take_stored_once(
    conn: &mut Connection,
    input: &Approval,
) -> Result<Option<ApprovalOutcome>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let found = find_grant(
        &tx,
        &input.scope,
        &input.name,
        input.mono.as_deref(),
        input.project.as_deref(),
        &input.executable,
        &input.identity,
        &input.fingerprint,
    )?;
    let Some(grant) = found else {
        drop(tx);
        return Ok(None);
    };
    let key = decision_key(&input.name, &input.key_source);
    if grant.mode != "once" || grant.subject_kind != "mono" {
        drop(tx);
        return Ok(Some(ApprovalOutcome::Waiting { decision_key: key }));
    }
    let Some(mono) = input.mono.as_deref() else {
        drop(tx);
        return Err("Which Mono is asking?".into());
    };
    let spent = spend_once(
        &tx,
        &input.scope,
        &input.name,
        mono,
        &input.executable,
        &input.identity,
        &input.fingerprint,
    )?;
    if !spent {
        drop(tx);
        return Ok(Some(ApprovalOutcome::Waiting { decision_key: key }));
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(ApprovalOutcome::Granted))
}

pub fn ensure_grant(
    conn: &mut Connection,
    input: Approval,
    now: i64,
) -> Result<ApprovalOutcome, String> {
    if let Some(outcome) = take_stored_once(conn, &input)? {
        return Ok(outcome);
    }
    let project = input.project.as_deref().unwrap_or("");
    let key = decision_key(&input.name, &input.key_source);
    let decision = crate::decisions::get(conn, project, &key)?;
    // The command the card was last written for. An answer approves that command only (the M1 check before any grant).
    let bound = binding_of(conn, project, &key)?;
    let same_command = bound.as_deref() == Some(input.fingerprint.as_str());
    // The card is put up for one Mono's run (or one worker's), and only that Mono may spend its answer.
    let asked_for = input
        .mono
        .as_deref()
        .ok_or_else(|| "Which Mono is asking?".to_string())?;
    let answered_by_person_for_this_mono = decision.as_ref().is_some_and(|decision| {
        decision.state == crate::decisions::ANSWERED
            // Fix round 4 (LOW): a secret card's answer is the person's own (the Inbox or the card), never the Needs sheet's.
            && crate::decisions::secret_answered_by_person(decision.answered_by.as_deref())
            && match decision.asked_by_mono.as_deref() {
                Some(mono) => mono == asked_for,
                None => true,
            }
    });
    let answered = decision
        .as_ref()
        .is_some_and(|_| answered_by_person_for_this_mono);
    // "No" holds for the program, whatever command it was for.
    if answered && decision.as_ref().and_then(|d| d.answer.as_deref()) == Some("No") {
        return Ok(ApprovalOutcome::Denied { decision_key: key });
    }
    match decision.filter(|_| answered_by_person_for_this_mono && same_command) {
        Some(decision) => {
            let answer = decision.answer.clone().unwrap_or_default();
            if answer == "No" {
                return Ok(ApprovalOutcome::Denied { decision_key: key });
            }
            // Only the exact word "Once" grants. "no", or any other words, refuse and write no grant.
            if answer != "Once"
                && answer != "Always for this project"
                && answer != "Always for this Mono"
            {
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
                            &input.identity,
                            &input.fingerprint,
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
                        &input.identity,
                        &input.fingerprint,
                        "always",
                        now,
                    )?;
                } else {
                    // "Once", written and spent in one transaction. A stop between the two rolls the grant back, so it
                    // cannot let every later run through.
                    let tx = conn
                        .transaction_with_behavior(TransactionBehavior::Immediate)
                        .map_err(|e| e.to_string())?;
                    put_grant(
                        &tx,
                        &input.scope,
                        &input.name,
                        "mono",
                        mono,
                        &input.executable,
                        &input.identity,
                        &input.fingerprint,
                        "once",
                        now,
                    )?;
                    let spent = spend_once(
                        &tx,
                        &input.scope,
                        &input.name,
                        mono,
                        &input.executable,
                        &input.identity,
                        &input.fingerprint,
                    )?;
                    if !spent {
                        drop(tx);
                        return Ok(false);
                    }
                    tx.commit().map_err(|e| e.to_string())?;
                }
                Ok(true)
            })();
            match granted {
                Ok(true) => {}
                Ok(false) => return Ok(ApprovalOutcome::Waiting { decision_key: key }),
                Err(why) => {
                    if why == ALWAYS_REFUSED || why == ALWAYS_NOT_OFFERED {
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
            let _ = conn.execute(
                "DELETE FROM secret_card_bindings WHERE project = ?1 AND decision_key = ?2",
                params![project, key],
            );
            Ok(ApprovalOutcome::Granted)
        }
        _ => {
            if answered {
                // Answered for another command of this program: that answer is not this command's. It is cleared, and this
                // command asks on a fresh card.
                conn.execute(
                    "DELETE FROM decisions WHERE project = ?1 AND decision_key = ?2",
                    params![project, key],
                )
                .map_err(|e| e.to_string())?;
            }
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
                    // A secret card is never a standing answer. No match words, and it does not force past one.
                    keys: Vec::new(),
                    force: false,
                    reason: None,
                },
                now,
            )?;
            // Fix round 4 (LOW): a card another Mono asked is not this run's to rewrite or rebind. Its words and its binding
            // stay as they are, so that Mono's answer still covers its own command.
            if !outcome.created
                && outcome.decision.asked_by_mono.as_deref() != input.mono.as_deref()
            {
                return Ok(ApprovalOutcome::Waiting { decision_key: key });
            }
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
            bind_card(conn, project, &key, &input.fingerprint)?;
            Ok(ApprovalOutcome::Waiting { decision_key: key })
        }
    }
}

/// The command a card was last written for.
fn binding_of(conn: &Connection, project: &str, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT fingerprint FROM secret_card_bindings WHERE project = ?1 AND decision_key = ?2",
        params![project, key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn bind_card(
    conn: &mut Connection,
    project: &str,
    key: &str,
    fingerprint: &str,
) -> Result<(), String> {
    // Fix round 4 (N1): a card bound to another command is a new version of that card. An answer given on the words the
    // person read carries that version, so it cannot be spent on a command they did not read.
    // Fix round 6: the new version comes from the key's counter, which is not deleted with the card, so a spent card's
    // version is never the next card's version. The binding moves only when that version move lands.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if binding_of(&tx, project, key)?.as_deref() != Some(fingerprint) {
        let old: Option<i64> = tx
            .query_row(
                "SELECT version FROM decisions WHERE project = ?1 AND decision_key = ?2",
                params![project, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(old) = old {
            let next = alloc_card_version(&tx, project, key)?;
            let changed = tx
                .execute(
                    "UPDATE decisions SET version = ?3 WHERE project = ?1 AND decision_key = ?2 AND version = ?4",
                    params![project, key, next, old],
                )
                .map_err(|e| e.to_string())?;
            if changed != 1 {
                return Err("The card changed while it was being bound. Try again.".into());
            }
        }
    }
    tx.execute(
        "INSERT INTO secret_card_bindings (project, decision_key, fingerprint) VALUES (?1, ?2, ?3)
         ON CONFLICT (project, decision_key) DO UPDATE SET fingerprint = excluded.fingerprint",
        params![project, key, fingerprint],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
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
    if let Some(why) = env_name_refusal(&request.env) {
        return Err(why);
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
    // The program is pinned before anyone is asked: its absolute path and its file identity. What the person approves is
    // this file and this exact command, and the grant row and the signed payload carry the same pair, so a program
    // swapped on the same name (or found on a caller's PATH) is not the one that was approved.
    let (program, identity) = pin_program(&executable, project.as_deref(), cwd.as_deref())?;
    let mut command = request.command.clone();
    command[0] = program.clone();
    let fingerprint = run_fingerprint(
        &program,
        &identity,
        &request.env,
        cwd.as_deref(),
        &command,
        timeout_seconds,
    );
    // 3. a live grant for this Mono (then its project), or ask the person first, on a card that shows the whole command.
    // Judged by the typed word as well as the canonical path: a name that runs code is that program, wherever it resolves.
    let runs_any = runs_any_code(&executable) || runs_any_for(&program);
    // Fix round 4 (N4, N7): Always comes from the short list, or from the person's choice for a program that runs code, and
    // never for a program in a folder the account can write.
    let always_allowed = always_allowed_for(conn, &program);
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
        &command,
        always_allowed,
        runs_any,
        &request.env,
        cwd.as_deref(),
    )?;
    // A program in a folder the person writes to can be replaced by anything running as them: the card says so.
    let question = match crate::secrets::run::program_folder_warning(std::path::Path::new(&program))
    {
        Some(warning) => format!("{question}\n{warning}"),
        None => question,
    };
    match ensure_grant(
        conn,
        Approval {
            chat: chat.to_string(),
            mono: request.mono.clone(),
            project: project.clone(),
            scope: row.scope.clone(),
            name: row.name.clone(),
            executable: program.clone(),
            identity: identity.clone(),
            // Fix round 4 (N1): the environment name is part of the card's key, so another name is another approval.
            key_source: format!("{program}\u{0}{identity}\u{0}{}", request.env),
            fingerprint,
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
        command,
        cwd,
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        expires_at: now + GRANT_TTL_MS,
        timeout_seconds,
        program_identity: identity,
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
mod r4_repro_tests;
#[cfg(test)]
mod r5_repro_tests;
#[cfg(test)]
mod security_tests;
#[cfg(test)]
mod tests;
