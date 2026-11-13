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

/// SC-3a: how hard a project's tasks are tested before they count as done. The gates read it when a worker says done
/// (`firstmate::testing_mode`). The default is `AtShip`: tasks only have to build, and tests and review run in one bulk
/// pass when the person ships.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TestingMode {
    /// Tasks are checked for obvious slips only; tests and review run once, at ship.
    #[default]
    AtShip,
    /// Every task that changes code runs the project's tests and gets a quick review.
    Light,
    /// Light, plus the task's own checks, the real-app check and a second reviewer.
    Full,
    /// Tasks are not tested or reviewed.
    Off,
}

impl TestingMode {
    /// The four modes, in the order a person is shown them.
    pub const ALL: [TestingMode; 4] = [
        TestingMode::AtShip,
        TestingMode::Light,
        TestingMode::Full,
        TestingMode::Off,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TestingMode::AtShip => "at-ship",
            TestingMode::Light => "light",
            TestingMode::Full => "full",
            TestingMode::Off => "off",
        }
    }

    pub fn parse(text: &str) -> Option<TestingMode> {
        match text {
            "at-ship" => Some(TestingMode::AtShip),
            "light" => Some(TestingMode::Light),
            "full" => Some(TestingMode::Full),
            "off" => Some(TestingMode::Off),
            _ => None,
        }
    }

    /// The name a person reads. The webview shows the same words (`TestingModeSetting`).
    pub fn label(self) -> &'static str {
        match self {
            TestingMode::AtShip => "Test at ship",
            TestingMode::Light => "Light tests each task",
            TestingMode::Full => "Full checks each task",
            TestingMode::Off => "No testing",
        }
    }

    /// One line under the name.
    pub fn description(self) -> &'static str {
        match self {
            TestingMode::AtShip => {
                "Tasks are checked for obvious slips only; tests and review run once, when you ship."
            }
            TestingMode::Light => {
                "Every task that changes code runs the project's tests and gets a quick review."
            }
            TestingMode::Full => {
                "Light, plus the task's own checks, the real-app check and a second reviewer."
            }
            TestingMode::Off => "Tasks are not tested or reviewed.",
        }
    }
}

/// What the person chose for a project; nothing chosen means the default.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub project: String,
    pub mode: Option<Mode>,
    pub merge_without_asking: bool,
    /// SC-3a: the person's testing choice. None means they haven't chosen: `TestingMode::AtShip`.
    pub testing_mode: Option<TestingMode>,
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
    /// SC-3a: how hard this project's tasks are tested (`TestingMode::AtShip` until the person picks).
    pub testing_mode: TestingMode,
    /// Whether `testing_mode` is the default rather than the person's choice.
    pub testing_defaulted: bool,
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
            "SELECT mode, merge_without_asking, protect_paths, protected_extra, updated_at, testing_mode
             FROM delivery_settings WHERE project = ?1",
            [&project],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match found {
        Some((mode, yolo, protect, extra, updated_at, testing)) => Stored {
            project,
            mode: mode.as_deref().and_then(Mode::parse),
            merge_without_asking: yolo != 0,
            // A stored word this build doesn't know (a newer build wrote it) is untrusted: the default.
            testing_mode: testing.as_deref().and_then(TestingMode::parse),
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

/// SC-3a: sets how hard the project's tasks are tested. The same compare-and-swap rule as `set`: `expected_updated_at`
/// is the `updated_at` last read (none when there was no row), and a write that isn't based on that row is refused.
pub fn set_testing_mode(
    conn: &Connection,
    project: &str,
    mode: TestingMode,
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
    let word = mode.as_str();
    let wrote = if expected_updated_at.is_none() {
        conn.execute(
            "INSERT INTO delivery_settings
                (project, mode, merge_without_asking, testing_mode, updated_at)
             VALUES (?1, NULL, 0, ?2, ?3)",
            params![project, word, now],
        )
    } else {
        conn.execute(
            "UPDATE delivery_settings SET testing_mode = ?2, updated_at = ?3
             WHERE project = ?1 AND updated_at = ?4",
            params![project, word, now, expected_updated_at],
        )
    };
    wrote_row(wrote, conn, &project)
}

/// SC-3a: the testing mode the gates use for a project. A project with no row, a word this build doesn't know or a
/// database that can't be read all give the default (`TestingMode::AtShip`), never a stricter or looser surprise.
pub fn testing_mode_for(conn: &Connection, project: &str) -> TestingMode {
    get(conn, project)
        .ok()
        .and_then(|stored| stored.testing_mode)
        .unwrap_or_default()
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
        testing_defaulted: stored.testing_mode.is_none(),
        testing_mode: stored.testing_mode.unwrap_or_default(),
        protect_paths: stored.protect_paths,
        protected_extra: stored.protected_extra,
        probe: probe.clone(),
        blocked,
        updated_at: stored.updated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::ensure_tables(&conn).unwrap();
        conn
    }

    const STALE: &str =
        "Those delivery settings changed in another window. Look again, then set them.";

    #[test]
    fn a_project_with_no_choice_tests_at_ship() {
        let conn = conn();
        let stored = get(&conn, "/work/app").unwrap();
        assert_eq!(stored.testing_mode, None);
        assert_eq!(stored.updated_at, None);
        assert_eq!(testing_mode_for(&conn, "/work/app"), TestingMode::AtShip);
        let effective = effective(stored, &Probe::default());
        assert_eq!(effective.testing_mode, TestingMode::AtShip);
        assert!(effective.testing_defaulted);
    }

    #[test]
    fn a_choice_round_trips_and_stops_reading_as_the_default() {
        let conn = conn();
        let first = set_testing_mode(&conn, "/work/app", TestingMode::Light, None, 10).unwrap();
        assert_eq!(first.testing_mode, Some(TestingMode::Light));
        assert_eq!(first.updated_at, Some(10));
        assert_eq!(testing_mode_for(&conn, "/work/app"), TestingMode::Light);
        let shown = effective(get(&conn, "/work/app").unwrap(), &Probe::default());
        assert_eq!(shown.testing_mode, TestingMode::Light);
        assert!(!shown.testing_defaulted);
        // Picking the default again is still a choice.
        let again =
            set_testing_mode(&conn, "/work/app", TestingMode::AtShip, Some(10), 20).unwrap();
        assert_eq!(again.testing_mode, Some(TestingMode::AtShip));
        assert!(!effective(again, &Probe::default()).testing_defaulted);
        for mode in TestingMode::ALL {
            let at = get(&conn, "/work/app").unwrap().updated_at;
            let now = at.unwrap() + 1;
            let stored = set_testing_mode(&conn, "/work/app", mode, at, now).unwrap();
            assert_eq!(stored.testing_mode, Some(mode));
            assert_eq!(testing_mode_for(&conn, "/work/app"), mode);
        }
    }

    #[test]
    fn a_stale_window_is_refused_with_the_same_plain_message() {
        let conn = conn();
        set_testing_mode(&conn, "/work/app", TestingMode::Light, None, 10).unwrap();
        // A window that saw no row (None) and one that saw an older row both lose.
        assert_eq!(
            set_testing_mode(&conn, "/work/app", TestingMode::Full, None, 20).unwrap_err(),
            STALE
        );
        assert_eq!(
            set_testing_mode(&conn, "/work/app", TestingMode::Full, Some(5), 20).unwrap_err(),
            STALE
        );
        assert_eq!(testing_mode_for(&conn, "/work/app"), TestingMode::Light);
        // The refusal is the one `set` gives.
        assert_eq!(
            set(&conn, "/work/app", None, false, None, 30).unwrap_err(),
            STALE
        );
        // A window that read the newest row wins, and then the one that read the old row loses.
        set_testing_mode(&conn, "/work/app", TestingMode::Off, Some(10), 40).unwrap();
        assert_eq!(
            set_testing_mode(&conn, "/work/app", TestingMode::Full, Some(10), 50).unwrap_err(),
            STALE
        );
        assert_eq!(testing_mode_for(&conn, "/work/app"), TestingMode::Off);
    }

    #[test]
    fn a_word_this_build_does_not_know_reads_as_the_default() {
        let conn = conn();
        conn.execute(
            "INSERT INTO delivery_settings (project, mode, merge_without_asking, testing_mode, updated_at)
             VALUES ('/work/app', NULL, 0, 'paranoid', 5)",
            [],
        )
        .unwrap();
        let stored = get(&conn, "/work/app").unwrap();
        assert_eq!(stored.testing_mode, None);
        assert_eq!(stored.updated_at, Some(5));
        assert_eq!(testing_mode_for(&conn, "/work/app"), TestingMode::AtShip);
        assert!(effective(stored, &Probe::default()).testing_defaulted);
        // The person's next pick replaces it, based on the row they read.
        let next = set_testing_mode(&conn, "/work/app", TestingMode::Light, Some(5), 6).unwrap();
        assert_eq!(next.testing_mode, Some(TestingMode::Light));
        // An empty or odd-cased word is not a mode either.
        for odd in ["", "AT-SHIP", "at ship", "Light"] {
            conn.execute(
                "UPDATE delivery_settings SET testing_mode = ?1 WHERE project = '/work/app'",
                [odd],
            )
            .unwrap();
            assert_eq!(
                testing_mode_for(&conn, "/work/app"),
                TestingMode::AtShip,
                "{odd:?}"
            );
        }
    }

    #[test]
    fn the_testing_choice_and_the_delivery_choice_do_not_overwrite_each_other() {
        let conn = conn();
        let first = set(&conn, "/work/app", Some(Mode::Pr), true, None, 10).unwrap();
        let second =
            set_testing_mode(&conn, "/work/app", TestingMode::Full, first.updated_at, 20).unwrap();
        assert_eq!(second.mode, Some(Mode::Pr));
        assert!(second.merge_without_asking);
        assert_eq!(second.testing_mode, Some(TestingMode::Full));
        let third = set(
            &conn,
            "/work/app",
            Some(Mode::Local),
            false,
            second.updated_at,
            30,
        )
        .unwrap();
        assert_eq!(third.mode, Some(Mode::Local));
        assert_eq!(third.testing_mode, Some(TestingMode::Full));
        let floor = set_protect_paths(&conn, "/work/app", true, third.updated_at, 40).unwrap();
        assert_eq!(floor.testing_mode, Some(TestingMode::Full));
    }

    #[test]
    fn two_spellings_of_one_folder_share_one_choice() {
        let conn = conn();
        set_testing_mode(&conn, "/work/my app/./é", TestingMode::Light, None, 10).unwrap();
        assert_eq!(
            testing_mode_for(&conn, "/work/my app/é"),
            TestingMode::Light
        );
        assert_eq!(
            testing_mode_for(&conn, "/work/my app/x/../é"),
            TestingMode::Light
        );
        assert_eq!(testing_mode_for(&conn, "/work/other"), TestingMode::AtShip);
    }

    #[test]
    fn a_blank_project_is_refused() {
        let conn = conn();
        assert_eq!(
            set_testing_mode(&conn, "  ", TestingMode::Light, None, 10).unwrap_err(),
            "Which project? Its folder is needed."
        );
    }

    #[test]
    fn a_database_from_before_the_column_gets_it_and_keeps_its_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE delivery_settings (
               project TEXT PRIMARY KEY,
               mode TEXT,
               merge_without_asking INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL,
               protect_paths INTEGER NOT NULL DEFAULT 0,
               protected_extra TEXT NOT NULL DEFAULT '[]'
             );
             INSERT INTO delivery_settings (project, mode, merge_without_asking, updated_at)
             VALUES ('/work/app', 'pr', 1, 7);",
        )
        .unwrap();
        super::super::ensure_tables(&conn).unwrap();
        // Running it again changes nothing.
        super::super::ensure_tables(&conn).unwrap();
        let stored = get(&conn, "/work/app").unwrap();
        assert_eq!(stored.mode, Some(Mode::Pr));
        assert_eq!(stored.testing_mode, None);
        assert_eq!(testing_mode_for(&conn, "/work/app"), TestingMode::AtShip);
        let next = set_testing_mode(&conn, "/work/app", TestingMode::Light, Some(7), 8).unwrap();
        assert_eq!(next.mode, Some(Mode::Pr));
        assert_eq!(next.testing_mode, Some(TestingMode::Light));
    }

    #[test]
    fn the_four_modes_have_their_exact_words() {
        let rows = [
            (
                TestingMode::AtShip,
                "at-ship",
                "Test at ship",
                "Tasks are checked for obvious slips only; tests and review run once, when you ship.",
            ),
            (
                TestingMode::Light,
                "light",
                "Light tests each task",
                "Every task that changes code runs the project's tests and gets a quick review.",
            ),
            (
                TestingMode::Full,
                "full",
                "Full checks each task",
                "Light, plus the task's own checks, the real-app check and a second reviewer.",
            ),
            (
                TestingMode::Off,
                "off",
                "No testing",
                "Tasks are not tested or reviewed.",
            ),
        ];
        assert_eq!(TestingMode::default(), TestingMode::AtShip);
        assert_eq!(TestingMode::ALL.len(), rows.len());
        for (mode, word, label, description) in rows {
            assert_eq!(mode.as_str(), word);
            assert_eq!(TestingMode::parse(word), Some(mode));
            assert_eq!(mode.label(), label);
            assert_eq!(mode.description(), description);
            assert_eq!(serde_json::to_string(&mode).unwrap(), format!("\"{word}\""));
            assert_eq!(
                serde_json::from_str::<TestingMode>(&format!("\"{word}\"")).unwrap(),
                mode
            );
        }
        assert_eq!(TestingMode::parse("At-Ship"), None);
        assert!(serde_json::from_str::<TestingMode>("\"strict\"").is_err());
    }

    #[test]
    fn the_webview_reads_the_testing_fields_by_their_camel_case_names() {
        let conn = conn();
        let shown = effective(get(&conn, "/work/app").unwrap(), &Probe::default());
        let json = serde_json::to_value(&shown).unwrap();
        assert_eq!(json["testingMode"], "at-ship");
        assert_eq!(json["testingDefaulted"], true);
        assert!(json["updatedAt"].is_null());
        let stored = set_testing_mode(&conn, "/work/app", TestingMode::Off, None, 3).unwrap();
        let json = serde_json::to_value(&stored).unwrap();
        assert_eq!(json["testingMode"], "off");
        assert_eq!(json["updatedAt"], 3);
    }
}
