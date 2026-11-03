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
    pub probe: Probe,
    /// Why the chosen mode can't run now, in words (a PR mode with no GitHub remote, or `gh` signed out).
    pub blocked: Option<String>,
}

/// A project folder as one key: its canonical path where it exists.
pub fn key(project: &str) -> String {
    let trimmed = project.trim();
    crate::fs::canonical(crate::fs::expand_home(trimmed))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| trimmed.to_string())
}

pub fn get(conn: &Connection, project: &str) -> Result<Stored, String> {
    let project = key(project);
    let found = conn
        .query_row(
            "SELECT mode, merge_without_asking FROM delivery_settings WHERE project = ?1",
            [&project],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match found {
        Some((mode, yolo)) => Stored {
            project,
            mode: mode.as_deref().and_then(Mode::parse),
            merge_without_asking: yolo != 0,
        },
        None => Stored {
            project,
            ..Stored::default()
        },
    })
}

pub fn set(
    conn: &Connection,
    project: &str,
    mode: Option<Mode>,
    merge_without_asking: bool,
    now: i64,
) -> Result<Stored, String> {
    let project = key(project);
    if project.is_empty() {
        return Err("Which project? Its folder is needed.".into());
    }
    conn.execute(
        "INSERT INTO delivery_settings (project, mode, merge_without_asking, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project) DO UPDATE SET mode = ?2, merge_without_asking = ?3, updated_at = ?4",
        params![project, mode.map(Mode::as_str), merge_without_asking as i64, now],
    )
    .map_err(|e| e.to_string())?;
    get(conn, &project)
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
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
        probe: probe.clone(),
        blocked,
    }
}
