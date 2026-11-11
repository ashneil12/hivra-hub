//! Per project: how finished work arrives, and whether merging needs the person's word. Stored in the app's own
//! database, keyed by the project's folder.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::github::{signed_in, Github};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// Land the change into the project with `land.rs`; nothing is pushed.
    Local,
    /// Push the worker's branch and open a pull request carrying the brief and the worker's evidence.
    Pr,
    /// As `Pr`, but ready only once its checks are green; a red check sends the worker one fix round with the log.
    CheckedPr,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Local => "local",
            Mode::Pr => "pr",
            Mode::CheckedPr => "checked-pr",
        }
    }

    pub fn parse(text: &str) -> Option<Mode> {
        match text {
            "local" => Some(Mode::Local),
            "pr" => Some(Mode::Pr),
            "checked-pr" => Some(Mode::CheckedPr),
            _ => None,
        }
    }

    pub fn pushes(self) -> bool {
        !matches!(self, Mode::Local)
    }
}

/// What the person chose for a project; nothing chosen means the default.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub project: String,
    pub mode: Option<Mode>,
    pub merge_without_asking: bool,
    /// When true, merge without asking still needs the person's word if the diff touches a protected path.
    /// Off until the project turns it on.
    pub protect_paths: bool,
    /// Also protect these paths, on top of the built-in list. Adding is the only change.
    pub protected_extra: Vec<String>,
    /// When this row was written. None when the project has no row yet: a later write passes it back so a stale
    /// window can't overwrite a newer choice.
    pub updated_at: Option<i64>,
}

/// What the project can do: a GitHub remote, and `gh` signed in.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// `owner/name` of the project's GitHub remote (`origin` first).
    pub github_repo: Option<String>,
    /// The remote's name.
    pub remote: Option<String>,
    pub gh_signed_in: bool,
}

/// The settings in force for a project.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
    pub project: String,
    pub mode: Mode,
    /// Whether `mode` is the default rather than the person's choice.
    pub defaulted: bool,
    pub merge_without_asking: bool,
    pub protect_paths: bool,
    /// Also protect these paths.
    pub protected_extra: Vec<String>,
    pub probe: Probe,
    /// Why the chosen mode can't run now, in words (a PR mode with no GitHub remote, or `gh` signed out).
    pub blocked: Option<String>,
    /// The stored row's `updated_at`, for the next write. None when nothing is stored.
    pub updated_at: Option<i64>,
}

/// The name of a project's extra protected paths. The built-in list is not edited from here.
pub const PROTECTED_EXTRA_LABEL: &str = "Also protect these paths";

const MAX_EXTRA_PATHS: usize = 100;
const MAX_EXTRA_LEN: usize = 200;

/// A project folder as one key: its canonical path where it exists, otherwise the same path with
/// `.` and `..` folded out, so two windows naming one folder land on one row.
pub fn key(project: &str) -> String {
    let trimmed = project.trim();
    let expanded = crate::fs::expand_home(trimmed);
    match crate::fs::canonical(&expanded) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(_) => lexical(&expanded),
    }
}

fn lexical(path: &std::path::Path) -> String {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            // `..` folds out a real segment. It does not walk off a root, and a `..` that escapes a
            // relative path stays, so `../a` and `a` are not the same key.
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::ParentDir) | None => out.push(".."),
                // `.` is never stored, and `..` does not walk off a root.
                Some(Component::CurDir | Component::RootDir | Component::Prefix(_)) => {}
            },
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

pub fn get(conn: &Connection, project: &str) -> Result<Stored, String> {
    let project = key(project);
    let found = conn
        .query_row(
            "SELECT mode, merge_without_asking, protect_paths, protected_extra, updated_at
             FROM delivery_settings WHERE project = ?1",
            [&project],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match found {
        Some((mode, yolo, protect, extra, updated_at)) => Stored {
            project,
            mode: mode.as_deref().and_then(Mode::parse),
            merge_without_asking: yolo != 0,
            protect_paths: protect != 0,
            protected_extra: parse_extra(&extra),
            updated_at: Some(updated_at),
        },
        None => Stored {
            project,
            ..Stored::default()
        },
    })
}

fn changed_elsewhere() -> String {
    "Those delivery settings changed in another window. Look again, then set them.".into()
}

fn constraint(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

/// Writes the choice. `expected_updated_at` is the `updated_at` last read (none when there was no row). A write that
/// isn't based on that row is refused, so two windows can't overwrite each other.
pub fn set(
    conn: &Connection,
    project: &str,
    mode: Option<Mode>,
    merge_without_asking: bool,
    expected_updated_at: Option<i64>,
    now: i64,
) -> Result<Stored, String> {
    let project = key(project);
    if project.is_empty() {
        return Err("Which project? Its folder is needed.".into());
    }
    let existing = get(conn, &project)?;
    if existing.updated_at != expected_updated_at {
        return Err(changed_elsewhere());
    }
    let mode_text = mode.map(Mode::as_str);
    let yolo = merge_without_asking as i64;
    let wrote = if expected_updated_at.is_none() {
        conn.execute(
            "INSERT INTO delivery_settings (project, mode, merge_without_asking, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![project, mode_text, yolo, now],
        )
    } else {
        conn.execute(
            "UPDATE delivery_settings SET mode = ?2, merge_without_asking = ?3, updated_at = ?4
             WHERE project = ?1 AND updated_at = ?5",
            params![project, mode_text, yolo, now, expected_updated_at],
        )
    };
    match wrote {
        Ok(0) => Err(changed_elsewhere()),
        Ok(_) => get(conn, &project),
        Err(error) if constraint(&error) => Err(changed_elsewhere()),
        Err(error) => Err(error.to_string()),
    }
}

/// Turns the protected-path floor on or off for one project. The built-in list is not stored, so this cannot shrink it.
pub fn set_protect_paths(
    conn: &Connection,
    project: &str,
    on: bool,
    expected_updated_at: Option<i64>,
    now: i64,
) -> Result<Stored, String> {
    let project = key(project);
    if project.is_empty() {
        return Err("Which project? Its folder is needed.".into());
    }
    let existing = get(conn, &project)?;
    if existing.updated_at != expected_updated_at {
        return Err(changed_elsewhere());
    }
    let flag = i64::from(on);
    let wrote = if expected_updated_at.is_none() {
        conn.execute(
            "INSERT INTO delivery_settings
                (project, mode, merge_without_asking, protect_paths, protected_extra, updated_at)
             VALUES (?1, NULL, 0, ?2, '[]', ?3)",
            params![project, flag, now],
        )
    } else {
        conn.execute(
            "UPDATE delivery_settings SET protect_paths = ?2, updated_at = ?3
             WHERE project = ?1 AND updated_at = ?4",
            params![project, flag, now, expected_updated_at],
        )
    };
    wrote_row(wrote, conn, &project)
}

/// Adds paths to the project's extra list. A path already there stays, and nothing already stored is removed.
/// A pattern that can match no file (`*`, `?`, `[`, `..`, a leading slash, a drive letter) is refused, and so is the
/// whole write. A blank, over-long or control-character entry is skipped.
pub fn add_protected_paths(
    conn: &Connection,
    project: &str,
    paths: &[String],
    expected_updated_at: Option<i64>,
    now: i64,
) -> Result<Stored, String> {
    let project = key(project);
    if project.is_empty() {
        return Err("Which project? Its folder is needed.".into());
    }
    let existing = get(conn, &project)?;
    if existing.updated_at != expected_updated_at {
        return Err(changed_elsewhere());
    }
    // A pattern that can never match is refused with its reason, and nothing is written.
    for path in paths {
        super::protected::check_extra(path)?;
    }
    let mut extra = existing.protected_extra.clone();
    let mut fresh = Vec::new();
    for path in paths {
        let Some(clean) = clean_extra(path) else {
            continue;
        };
        if extra.iter().any(|have| have == &clean) || fresh.iter().any(|have| have == &clean) {
            continue;
        }
        fresh.push(clean);
    }
    if fresh.is_empty() {
        return Ok(existing);
    }
    if extra.len() + fresh.len() > MAX_EXTRA_PATHS {
        return Err(format!(
            "{PROTECTED_EXTRA_LABEL} can hold {MAX_EXTRA_PATHS} paths."
        ));
    }
    extra.extend(fresh);
    let json = serde_json::to_string(&extra).map_err(|error| error.to_string())?;
    let wrote = if expected_updated_at.is_none() {
        conn.execute(
            "INSERT INTO delivery_settings
                (project, mode, merge_without_asking, protect_paths, protected_extra, updated_at)
             VALUES (?1, NULL, 0, 0, ?2, ?3)",
            params![project, json, now],
        )
    } else {
        conn.execute(
            "UPDATE delivery_settings SET protected_extra = ?2, updated_at = ?3
             WHERE project = ?1 AND updated_at = ?4",
            params![project, json, now, expected_updated_at],
        )
    };
    wrote_row(wrote, conn, &project)
}

fn wrote_row(
    wrote: rusqlite::Result<usize>,
    conn: &Connection,
    project: &str,
) -> Result<Stored, String> {
    match wrote {
        Ok(0) => Err(changed_elsewhere()),
        Ok(_) => get(conn, project),
        Err(error) if constraint(&error) => Err(changed_elsewhere()),
        Err(error) => Err(error.to_string()),
    }
}

/// A stored extra list is untrusted. Bad JSON, blanks and over-long entries are dropped.
/// Dropping them does not turn the built-in floor off.
fn parse_extra(raw: &str) -> Vec<String> {
    let Ok(values) = serde_json::from_str::<Vec<String>>(raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for value in values {
        let Some(clean) = clean_extra(&value) else {
            continue;
        };
        if out.iter().any(|have| have == &clean) {
            continue;
        }
        if out.len() >= MAX_EXTRA_PATHS {
            break;
        }
        out.push(clean);
    }
    out
}

fn clean_extra(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_EXTRA_LEN {
        return None;
    }
    if trimmed.chars().any(char::is_control) {
        return None;
    }
    Some(trimmed.to_string())
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::git_cmd::child()
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The project's GitHub remote: `origin` when it is one, else the first remote that is.
pub fn github_remote(project: &Path) -> Option<(String, String)> {
    let config = git(project, &["config", "--get-regexp", r"^remote\..*\.url$"])?;
    let mut found: Vec<(String, String)> = config
        .lines()
        .filter_map(|line| {
            let (k, url) = line.split_once(' ')?;
            let name = k.strip_prefix("remote.")?.strip_suffix(".url")?;
            let repo = crate::pr_watch::checkout::github_repo_of(url)?;
            Some((name.to_string(), repo))
        })
        .collect();
    found.sort_by_key(|(name, _)| name != "origin");
    found.into_iter().next()
}

pub fn probe(project: &Path, gh: &dyn Github) -> Probe {
    let remote = github_remote(project);
    Probe {
        gh_signed_in: remote.is_some() && signed_in(gh),
        github_repo: remote.as_ref().map(|(_, repo)| repo.clone()),
        remote: remote.map(|(name, _)| name),
    }
}

/// The default: checked PR when the project has a GitHub remote and `gh` is signed in, otherwise local.
pub fn default_mode(probe: &Probe) -> Mode {
    if probe.github_repo.is_some() && probe.gh_signed_in {
        Mode::CheckedPr
    } else {
        Mode::Local
    }
}

pub fn effective(stored: Stored, probe: &Probe) -> Effective {
    let (mode, defaulted) = match stored.mode {
        Some(mode) => (mode, false),
        None => (default_mode(probe), true),
    };
    let blocked = if !mode.pushes() {
        None
    } else if probe.github_repo.is_none() {
        Some("This project has no GitHub remote, so a pull request can't be opened.".into())
    } else if !probe.gh_signed_in {
        Some("gh isn't signed in to GitHub (run `gh auth login`), so a pull request can't be opened.".into())
    } else {
        None
    };
    Effective {
        project: stored.project,
        mode,
        defaulted,
        merge_without_asking: stored.merge_without_asking,
        protect_paths: stored.protect_paths,
        protected_extra: stored.protected_extra,
        probe: probe.clone(),
        blocked,
        updated_at: stored.updated_at,
    }
}
