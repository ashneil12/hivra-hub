//! A finished worktree gives its build output back by itself.
//!
//! The Mac's disk filled once because about 90 worktrees each kept a 9 to 12 GB `target/`. The janitor
//! (`worktree_janitor.rs`) only acts on Ash's tap, and only after a worktree has sat idle for days. This module
//! sweeps in the background (the daily app only: [`crate::instance::Policy::clear_build_output`]) and deletes the
//! build output of worktrees that are done.
//!
//! **Finished** means one of:
//! - a pull request from its branch merged or closed, with this exact commit as its head (the app's own PR watch
//!   says so, or, for a worktree no one watched, `gh pr list`, asked at most once an hour per commit);
//! - a delegated task in it was accepted (status `done`), every task in it is, and its commit is contained in the
//!   branch's upstream (or `origin/<branch>`);
//! - its branch is merged into the mainline, with its commit on a remote.
//!
//! **And** the worktree is a linked worktree (never the main checkout) with an empty `git status`, nothing running in
//! it (an agent, a terminal, a project action, a chat's turn, a dev copy, a cargo build holding its lock, or any other
//! process of this user's whose working folder is in it: a shell, an agent CLI or a dev server started by hand), and
//! nothing touched for ten minutes. A pull request still open for an accepted, pushed task doesn't hold it back: its code is
//! on the remote, and a rebuild is all a later fix costs.
//!
//! **Then** only these folders go, each a real folder (never a link) that git ignores and tracks nothing in:
//! `target/`, `src-tauri/target/`, `test-results/`, `playwright-report/` and every `node_modules/`. A `node_modules`
//! that is a symbolic link (setup links it to the main checkout) stays. Code, branches, chats and every other
//! ignored file stay.
//!
//! Each worktree is checked again under the removal reservation (`worktree_lifecycle.rs`), so no agent or terminal
//! can start in it between the check and the delete. The setting lives in `worktree-autoclean.json` in the app's
//! data folder: on by default, and off when the file can't be read (a guess never deletes anything).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::fs::{expand_home, path_to_js};
use crate::project_file;
use crate::worktree_janitor::{
    app_context, discover, gather, gh_prs_for_branch, git_out, git_text, human_age, human_bytes,
    ignored_by_git, managed_root, measure, now_ms, Context, Facts, GhPr, Kind, Seen,
};

/// Folders at the top of a worktree that this clean-up may delete, when git ignores them.
pub const FIXED_FOLDERS: &[&str] = &[
    "target",
    "src-tauri/target",
    "test-results",
    "playwright-report",
];
const NODE_MODULES: &str = "node_modules";

/// A worktree untouched for less than this is left alone: the last commit, the last chat message or the last git
/// command may be the end of something still going.
const QUIET_MS: u64 = 10 * 60_000;
const SWEEP_EVERY: Duration = Duration::from_secs(15 * 60);
const FIRST_SWEEP: Duration = Duration::from_secs(2 * 60);
/// A commit `gh` said nothing finished about is asked about again after this long.
const PR_RECHECK_MS: u64 = 60 * 60_000;
const MEASURE_LIMIT: Duration = Duration::from_secs(120);
/// Reading the other processes' working folders takes longer than this: the sweep stops and deletes nothing.
#[cfg(target_os = "macos")]
const PROCESS_READ_LIMIT: Duration = Duration::from_secs(30);
const SETTINGS_FILE: &str = "worktree-autoclean.json";

// ---- the setting ----------------------------------------------------------------------------------------------------

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_FILE)
}

/// Whether the sweep may delete. On when nothing was ever chosen; off when the file is there but can't be read as a
/// choice (a guess never deletes anything).
pub fn read_enabled(data_dir: &Path) -> bool {
    match std::fs::read(settings_path(data_dir)) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) => match value.get("enabled") {
                None => true,
                Some(enabled) => enabled.as_bool().unwrap_or(false),
            },
            Err(_) => false,
        },
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

pub fn write_enabled(data_dir: &Path, enabled: bool) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let path = settings_path(data_dir);
    let temp = data_dir.join(format!("{SETTINGS_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let body = serde_json::json!({ "enabled": enabled }).to_string();
    std::fs::write(&temp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        error.to_string()
    })
}

// ---- what finished means --------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Finished {
    /// A pull request from the branch merged or closed with this commit as its head.
    PullRequest { number: u64, merged: bool },
    /// Every delegated task in the worktree was accepted and the branch is pushed.
    Accepted,
    /// The branch is merged into the mainline and its commit is on a remote.
    Merged,
}

impl Finished {
    pub fn describe(&self) -> String {
        match self {
            Finished::PullRequest {
                number,
                merged: true,
            } => format!("pull request #{number} merged"),
            Finished::PullRequest {
                number,
                merged: false,
            } => format!("pull request #{number} closed"),
            Finished::Accepted => "task accepted and branch pushed".into(),
            Finished::Merged => "branch merged".into(),
        }
    }
}

/// What the records and the remote say about one worktree.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Evidence {
    /// A merged (`true`) or closed pull request whose head is exactly this commit.
    pub pull_request: Option<(u64, bool)>,
    /// Every delegated task in this worktree is accepted, and at least one exists.
    pub accepted: bool,
    /// HEAD is contained in the branch's upstream (or `origin/<branch>`).
    pub head_in_upstream: bool,
}

/// The hard stops, in plain words. Pure: the facts are gathered elsewhere.
pub fn guard(f: &Facts, now: u64) -> Result<(), String> {
    match f.kind {
        Kind::Main => return Err("The main checkout of its repository is never cleared".into()),
        Kind::Linked => {}
        _ => return Err("Not a linked worktree".into()),
    }
    if !f.registered {
        return Err("Its repository doesn't list it as a worktree".into());
    }
    if let Some(why) = &f.protected {
        return Err(why.clone());
    }
    if f.process_running {
        return Err("An agent, terminal or project action is running in it".into());
    }
    if f.chat_running {
        return Err("A chat in it is running, or was cut off mid-turn".into());
    }
    if f.locked {
        return Err("Locked in git".into());
    }
    if let Some(error) = &f.status_error {
        return Err(format!("git status failed: {error}"));
    }
    if f.tracked_changes > 0 || f.untracked > 0 {
        return Err("It has uncommitted changes".into());
    }
    if f.head.is_none() {
        return Err("Its commit is unknown".into());
    }
    match f.last_activity {
        Some(at) if now.saturating_sub(at) >= QUIET_MS => Ok(()),
        Some(at) => Err(format!("Active {} ago", human_age(now.saturating_sub(at)))),
        None => Err("Its last activity is unknown".into()),
    }
}

/// Whether the worktree is done, from what is known about it. Pure.
pub fn finished(f: &Facts, ev: &Evidence) -> Result<Finished, String> {
    if let Some((number, merged)) = ev.pull_request {
        return Ok(Finished::PullRequest { number, merged });
    }
    if ev.accepted {
        return if ev.head_in_upstream {
            Ok(Finished::Accepted)
        } else {
            Err("Its task was accepted, but its branch isn't pushed".into())
        };
    }
    if f.ahead == Some(0) && f.never_committed == Some(false) {
        return match f.unpushed {
            Some(0) => Ok(Finished::Merged),
            _ => Err("Its branch is merged, but its commit isn't on a remote".into()),
        };
    }
    Err("Not finished: no merged or closed pull request, no accepted task".into())
}

// ---- what the app's records say -------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
struct EndedPr {
    number: u64,
    merged: bool,
    head_ref: String,
    head_sha: Option<String>,
    worktree: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TaskChat {
    folder: PathBuf,
    accepted: bool,
}

/// The PR watch and the delegations, read once per sweep.
#[derive(Clone, Debug, Default)]
pub struct Records {
    ended: Vec<EndedPr>,
    tasks: Vec<TaskChat>,
    /// Worktrees the app knows beyond ~/Worktrees: a chat's own, a PR watch's.
    known: Vec<PathBuf>,
}

fn table_exists(conn: &rusqlite::Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

/// The real path, in the form the rest of the app uses (no `\\?\` prefix on Windows), so every comparison here is
/// between paths written the same way.
fn canonical(path: PathBuf) -> PathBuf {
    crate::fs::canonical(&path).unwrap_or(path)
}

impl Records {
    pub fn read(conn: &rusqlite::Connection) -> Result<Records, String> {
        let mut records = Records::default();
        let sql_error = |error: rusqlite::Error| error.to_string();
        if table_exists(conn, "pr_watches") {
            // A watch ends for other reasons too (a comment limit, failed reads): only merged and closed say the
            // pull request is over.
            let mut query = conn
                .prepare(
                    "SELECT end_reason, number, head_ref, head_sha, worktree FROM pr_watches
                     WHERE state = 'ended' AND end_reason IN ('merged', 'closed')",
                )
                .map_err(sql_error)?;
            let rows = query
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })
                .map_err(sql_error)?;
            for row in rows {
                let (reason, number, head_ref, head_sha, worktree) = row.map_err(sql_error)?;
                let worktree = worktree
                    .filter(|path| !path.trim().is_empty())
                    .map(|path| canonical(expand_home(&path)));
                if let Some(path) = &worktree {
                    records.known.push(path.clone());
                }
                records.ended.push(EndedPr {
                    number: number.max(0) as u64,
                    merged: reason == "merged",
                    head_ref,
                    head_sha: head_sha.filter(|sha| !sha.is_empty()),
                    worktree,
                });
            }
        }
        let trash = table_exists(conn, "trash_items");
        let sql = if trash {
            "SELECT id, COALESCE(NULLIF(worktree_cwd, ''), cwd), COALESCE(worktree_cwd, '') FROM sessions
             WHERE worktree_removed = 0 AND id NOT IN (SELECT item_id FROM trash_items WHERE kind = 'chat')"
        } else {
            "SELECT id, COALESCE(NULLIF(worktree_cwd, ''), cwd), COALESCE(worktree_cwd, '') FROM sessions
             WHERE worktree_removed = 0"
        };
        // A chat's newest delegated task, as the app shows it: accepted is `done`.
        let newest: HashMap<String, bool> =
            crate::delegations::acceptance(conn)?.into_iter().collect();
        let mut query = conn.prepare(sql).map_err(sql_error)?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(sql_error)?;
        for row in rows {
            let (id, folder, worktree) = row.map_err(sql_error)?;
            if !worktree.trim().is_empty() {
                records.known.push(canonical(expand_home(&worktree)));
            }
            if let Some(accepted) = newest.get(&id) {
                records.tasks.push(TaskChat {
                    folder: canonical(expand_home(&folder)),
                    accepted: *accepted,
                });
            }
        }
        records.known.sort();
        records.known.dedup();
        Ok(records)
    }

    /// Worktrees the app knows about, to add to ~/Worktrees.
    pub fn known_worktrees(&self) -> &[PathBuf] {
        &self.known
    }

    /// What the records say about one worktree (a canonical path), its branch and its commit.
    pub fn evidence(&self, path: &Path, branch: Option<&str>, head: &str) -> Evidence {
        let here = |worktree: &Option<PathBuf>| worktree.as_deref() == Some(path);
        let on_branch = |head_ref: &str| !head_ref.is_empty() && branch == Some(head_ref);
        let pull_request = self
            .ended
            .iter()
            .find(|pr| {
                (here(&pr.worktree) || on_branch(&pr.head_ref))
                    && pr.head_sha.as_deref() == Some(head)
            })
            .map(|pr| (pr.number, pr.merged));
        let here_tasks: Vec<&TaskChat> = self
            .tasks
            .iter()
            .filter(|task| task.folder.starts_with(path))
            .collect();
        Evidence {
            pull_request,
            accepted: !here_tasks.is_empty() && here_tasks.iter().all(|task| task.accepted),
            head_in_upstream: false,
        }
    }
}

// ---- GitHub, for worktrees no one watched ---------------------------------------------------------------------------

/// What `gh` knows about a branch's pull requests. A trait so a test can answer without the network.
pub trait Github {
    fn pull_requests(&self, worktree: &Path, branch: &str) -> Result<Vec<GhPr>, String>;
}

pub struct RealGithub;

impl Github for RealGithub {
    fn pull_requests(&self, worktree: &Path, branch: &str) -> Result<Vec<GhPr>, String> {
        gh_prs_for_branch(worktree, branch, "all")
    }
}

/// Commits `gh` was asked about, and when. A worktree still being worked in would otherwise cost a `gh` call every
/// sweep.
pub type PrChecks = HashMap<(PathBuf, String), u64>;

/// A merged pull request whose head is exactly this commit, else a closed one. An open pull request with this same
/// head says the commit is still under review, so it is not over.
fn read_prs(prs: &[GhPr], head: &str) -> Option<(u64, bool)> {
    let exact = |state: &str| {
        prs.iter()
            .find(|pr| pr.head_ref_oid == head && pr.state.eq_ignore_ascii_case(state))
            .map(|pr| pr.number)
    };
    if exact("OPEN").is_some() {
        return None;
    }
    exact("MERGED")
        .map(|number| (number, true))
        .or_else(|| exact("CLOSED").map(|number| (number, false)))
}

/// HEAD is already in the branch's upstream, or in `origin/<branch>`.
fn head_in_upstream(path: &Path, branch: &str) -> bool {
    let upstream = git_text(
        path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()
    .filter(|name| !name.is_empty());
    upstream
        .into_iter()
        .chain(std::iter::once(format!("origin/{branch}")))
        .any(|reference| {
            git_out(path, &["merge-base", "--is-ancestor", "HEAD", &reference]).is_ok()
        })
}

// ---- the folders ----------------------------------------------------------------------------------------------------

/// A real folder: not a symbolic link, not a file.
fn real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// A folder this clean-up may ever delete, whatever the caller says.
fn allowed_folder(relative: &str) -> bool {
    project_file::valid_relative_path(relative)
        && (FIXED_FOLDERS.contains(&relative) || relative.rsplit('/').next() == Some(NODE_MODULES))
}

/// What may be deleted here: the fixed folders and every `node_modules`, each a real folder. Whether git ignores
/// them is checked again at the delete.
pub fn find_folders(root: &Path) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut consider = |relative: &str| {
        if allowed_folder(relative)
            && real_dir(&root.join(relative))
            && !found.iter().any(|known| known == relative)
        {
            found.push(relative.to_string());
        }
    };
    for relative in FIXED_FOLDERS.iter().chain(std::iter::once(&NODE_MODULES)) {
        consider(relative);
    }
    // A node_modules below the top (a package's own): git lists ignored folders without walking into them.
    if let Ok((text, _)) = git_out(
        root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    ) {
        for entry in text.split('\0') {
            consider(entry.trim_end_matches('/'));
        }
    }
    found
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedFolder {
    pub folder: String,
    pub bytes: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Cleaning {
    pub cleared: Vec<ClearedFolder>,
    pub errors: Vec<String>,
}

/// Delete the folders, each after checking it again: allowed by name, a real folder inside the worktree with no
/// linked folder on the way, ignored by git with nothing tracked in it. Links inside are unlinked, never followed.
pub fn clear_folders(worktree: &Path, folders: &[String]) -> Result<Cleaning, String> {
    let root = crate::fs::canonical(worktree).map_err(|e| e.to_string())?;
    let mut cleaning = Cleaning::default();
    for relative in folders {
        if !allowed_folder(relative) {
            continue;
        }
        let path = root.join(relative);
        if !real_dir(&path) {
            continue;
        }
        match crate::fs::canonical(&path) {
            Ok(real) if real == path && real.starts_with(&root) => {}
            _ => continue,
        }
        if !ignored_by_git(&root, relative) {
            continue;
        }
        let bytes = measure(&path, &[], Instant::now() + MEASURE_LIMIT, &mut Seen::new());
        match std::fs::remove_dir_all(&path) {
            Ok(()) => cleaning.cleared.push(ClearedFolder {
                folder: relative.clone(),
                bytes,
            }),
            Err(error) => cleaning.errors.push(format!("{relative}: {error}")),
        }
    }
    Ok(cleaning)
}

/// Cargo holds an exclusive lock on a profile's folder while it builds: `target/<profile>/.cargo-lock`, or one folder
/// further down for a cross build. A lock someone holds means a build is running here.
#[cfg(unix)]
fn cargo_building(root: &Path, folders: &[String]) -> bool {
    use std::os::unix::io::AsRawFd;
    let held = |dir: &Path| -> bool {
        let Ok(file) = std::fs::File::open(dir.join(".cargo-lock")) else {
            return false;
        };
        // SAFETY: a plain flock on a descriptor this function owns. A lock taken here is released when `file` drops.
        let got = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) };
        got != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK)
    };
    let subdirs = |dir: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                    .map(|entry| entry.path())
                    .collect()
            })
            .unwrap_or_default()
    };
    folders
        .iter()
        .filter(|relative| relative.rsplit('/').next() == Some("target"))
        .any(|relative| {
            subdirs(&root.join(relative)).iter().any(|profile| {
                held(profile)
                    || (!profile.join(".cargo-lock").exists()
                        && subdirs(profile).iter().any(|inner| held(inner)))
            })
        })
}

#[cfg(not(unix))]
fn cargo_building(_root: &Path, _folders: &[String]) -> bool {
    false
}

// ---- what else runs in a worktree -----------------------------------------------------------------------------------

/// The working folders of this user's processes, each a real path. The app's own agents, terminals and actions are in
/// its records already; this catches the rest: a shell in Terminal, an agent CLI or a dev server started by hand, a
/// test run. An error when they can't be read, and then nothing is deleted (a guess never deletes anything).
pub type RunningFolders = dyn Fn() -> Result<Vec<PathBuf>, String>;

/// [`RunningFolders`] on this machine: `lsof` on macOS, `/proc` on Linux. Windows has no plain way to ask, so there it
/// is always an error and the sweep clears nothing.
pub fn process_folders() -> Result<Vec<PathBuf>, String> {
    let folders = read_process_folders()?;
    // This process has a working folder too: none at all means the answer was empty, not that nothing runs.
    if folders.is_empty() {
        return Err(
            "Which programs run in a worktree can't be read, so nothing was cleared".into(),
        );
    }
    Ok(folders.into_iter().map(canonical).collect())
}

#[cfg(target_os = "macos")]
fn read_process_folders() -> Result<Vec<PathBuf>, String> {
    let mut command = std::process::Command::new("/usr/sbin/lsof");
    command.args(["-w", "-n", "-P", "-d", "cwd", "-F", "n"]);
    Ok(lsof_folders(&output_within(
        &mut command,
        PROCESS_READ_LIMIT,
    )?))
}

#[cfg(target_os = "linux")]
fn read_process_folders() -> Result<Vec<PathBuf>, String> {
    Ok(std::fs::read_dir("/proc")
        .map_err(|error| format!("Which programs run in a worktree can't be read: /proc: {error}"))?
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .filter_map(|entry| std::fs::read_link(entry.path().join("cwd")).ok())
        .collect())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_process_folders() -> Result<Vec<PathBuf>, String> {
    Err(
        "This computer doesn't say which programs run in a worktree, so nothing is cleared here"
            .into(),
    )
}

/// The `n` lines of `lsof -F n`: one working folder per process.
pub fn lsof_folders(text: &str) -> Vec<PathBuf> {
    text.lines()
        .filter_map(|line| line.strip_prefix('n'))
        .filter(|path| path.starts_with('/'))
        .map(PathBuf::from)
        .collect()
}

/// A command's output, read while it runs (a full pipe must not stall it), given up on after `limit`.
#[cfg(target_os = "macos")]
fn output_within(command: &mut std::process::Command, limit: Duration) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Which programs run in a worktree can't be read: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("lsof gave no output")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("Which programs run in a worktree took too long to read, so nothing was cleared".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(error.to_string()),
        }
    }
    let bytes = reader
        .join()
        .map_err(|_| "lsof's output couldn't be read")?;
    // lsof says 1 when it couldn't look at some processes (another user's): what it did list still counts.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The first folder something runs in, inside `root`.
fn running_in<'a>(root: &Path, folders: &'a [PathBuf]) -> Option<&'a PathBuf> {
    folders.iter().find(|folder| folder.starts_with(root))
}

// ---- one worktree ---------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedWorktree {
    pub path: String,
    pub branch: Option<String>,
    /// Why it counted as finished, in words.
    pub why: String,
    pub folders: Vec<ClearedFolder>,
    pub bytes: u64,
}

#[derive(Debug)]
pub enum Outcome {
    /// Nothing this clean-up deletes is there.
    NoOutput,
    Kept(String),
    Cleared(ClearedWorktree),
    Failed(String),
    /// What runs in the worktree couldn't be read: nothing was deleted, and the sweep stops.
    Blind(String),
}

/// Check one worktree and, when it is finished and quiet, delete its build output. The caller holds the removal
/// reservation and built `ctx` under it. What else runs in it is read last, just before anything goes.
pub fn clear_one(
    path: &Path,
    ctx: &Context,
    records: &Records,
    github: &dyn Github,
    running: &RunningFolders,
    checks: &mut PrChecks,
    now: u64,
) -> Outcome {
    let folders = find_folders(path);
    if folders.is_empty() {
        return Outcome::NoOutput;
    }
    let facts = gather(path, Kind::Linked, ctx);
    if let Err(reason) = guard(&facts, now) {
        return Outcome::Kept(reason);
    }
    let root = PathBuf::from(&facts.path);
    if cargo_building(&root, &folders) {
        return Outcome::Kept("A cargo build is running in it".into());
    }
    let head = facts.head.clone().unwrap_or_default();
    let branch = facts.branch.clone();
    let mut evidence = records.evidence(&root, branch.as_deref(), &head);
    if let Some(branch) = branch.as_deref() {
        let asked = (root.clone(), head.clone());
        let recently = checks
            .get(&asked)
            .is_some_and(|at| now.saturating_sub(*at) < PR_RECHECK_MS);
        if evidence.accepted {
            evidence.head_in_upstream = head_in_upstream(&root, branch);
        }
        // Not asked when the records already say it: a merged pull request, or an accepted task with its branch pushed.
        let settled =
            evidence.pull_request.is_some() || (evidence.accepted && evidence.head_in_upstream);
        if !settled && !recently {
            checks.insert(asked, now);
            if let Ok(prs) = github.pull_requests(&root, branch) {
                evidence.pull_request = read_prs(&prs, &head);
            }
        }
    }
    let why = match finished(&facts, &evidence) {
        Ok(why) => why,
        Err(reason) => return Outcome::Kept(reason),
    };
    match running() {
        Err(error) => return Outcome::Blind(error),
        Ok(busy) => {
            if let Some(folder) = running_in(&root, &busy) {
                return Outcome::Kept(format!(
                    "Something is running in it ({})",
                    path_to_js(folder)
                ));
            }
        }
    }
    match clear_folders(&root, &folders) {
        Ok(cleaning) if cleaning.cleared.is_empty() && !cleaning.errors.is_empty() => {
            Outcome::Failed(cleaning.errors.join("; "))
        }
        Ok(cleaning) if cleaning.cleared.is_empty() => {
            Outcome::Kept("What is there is tracked by git or not a plain folder".into())
        }
        Ok(cleaning) => {
            let bytes = cleaning.cleared.iter().filter_map(|f| f.bytes).sum();
            Outcome::Cleared(ClearedWorktree {
                path: facts.path.clone(),
                branch,
                why: why.describe(),
                bytes,
                folders: cleaning.cleared,
            })
        }
        Err(error) => Outcome::Failed(error),
    }
}

// ---- the sweep ------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub at: u64,
    pub took_ms: u64,
    /// Worktrees with build output this clean-up could delete.
    pub checked: usize,
    pub cleared: Vec<ClearedWorktree>,
    pub cleared_bytes: u64,
    /// Checked and kept: not finished, in use, or with work in them.
    pub held_back: usize,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub running: bool,
    pub last_run: Option<LastRun>,
}

struct Shared {
    last: Mutex<Option<LastRun>>,
    running: AtomicBool,
    nudged: Mutex<bool>,
    wake: Condvar,
}

fn shared() -> &'static Shared {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    SHARED.get_or_init(|| Shared {
        last: Mutex::new(None),
        running: AtomicBool::new(false),
        nudged: Mutex::new(false),
        wake: Condvar::new(),
    })
}

/// Sweep soon (the setting was just turned on).
pub fn nudge() {
    let shared = shared();
    *shared.nudged.lock().unwrap_or_else(|e| e.into_inner()) = true;
    shared.wake.notify_all();
}

fn wait_for(wait: Duration) {
    let shared = shared();
    let mut nudged = shared.nudged.lock().unwrap_or_else(|e| e.into_inner());
    if !*nudged {
        nudged = shared
            .wake
            .wait_timeout(nudged, wait)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
    *nudged = false;
}

pub fn status(data_dir: &Path) -> Status {
    let shared = shared();
    Status {
        enabled: read_enabled(data_dir),
        running: shared.running.load(Ordering::SeqCst),
        last_run: shared
            .last
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
    }
}

/// Check every candidate in turn. Each one with something to delete is held under the removal reservation while its
/// context is read and its folders go, so no agent or terminal can start in it meanwhile.
fn sweep_candidates(
    candidates: &[PathBuf],
    records: &Records,
    context: &dyn Fn(&Path) -> Result<Context, String>,
    github: &dyn Github,
    running: &RunningFolders,
    checks: &mut PrChecks,
    now: &dyn Fn() -> u64,
) -> LastRun {
    let mut run = LastRun {
        at: now(),
        ..LastRun::default()
    };
    for path in candidates {
        // Most worktrees have nothing to delete: that costs one `git ls-files`, not a context.
        if find_folders(path).is_empty() {
            continue;
        }
        run.checked += 1;
        let _reservation = match crate::worktree_lifecycle::reserve_removal(path) {
            Ok(reservation) => reservation,
            Err(_) => {
                run.held_back += 1;
                continue;
            }
        };
        let ctx = match context(path) {
            Ok(ctx) => ctx,
            Err(error) => {
                // Unreadable leases or sessions: nothing is guessed, so nothing more is checked this time.
                run.errors.push(error);
                break;
            }
        };
        match clear_one(path, &ctx, records, github, running, checks, now()) {
            // Gone between the two looks.
            Outcome::NoOutput => run.checked -= 1,
            Outcome::Kept(_) => run.held_back += 1,
            // Nothing is guessed: no more worktrees are checked this time.
            Outcome::Blind(error) => {
                run.held_back += 1;
                run.errors.push(error);
                break;
            }
            Outcome::Failed(error) => run.errors.push(format!("{}: {error}", path_to_js(path))),
            Outcome::Cleared(done) => {
                run.cleared_bytes += done.bytes;
                eprintln!(
                    "Worktree build output cleared: {} ({}; {})",
                    done.path,
                    done.why,
                    human_bytes(done.bytes)
                );
                run.cleared.push(done);
            }
        }
    }
    run
}

fn sweep(app: &AppHandle, checks: &mut PrChecks) -> Result<LastRun, String> {
    let started = Instant::now();
    let store = app.state::<crate::session_store::SessionStore>();
    let records = {
        let conn = store.lock_conn()?;
        Records::read(&conn)?
    };
    let roots: Vec<PathBuf> = managed_root()
        .filter(|root| root.is_dir())
        .into_iter()
        .collect();
    let candidates: Vec<PathBuf> = discover(&roots, records.known_worktrees())
        .into_iter()
        .filter(|(_, kind)| *kind == Kind::Linked)
        .map(|(path, _)| canonical(path))
        .collect();
    // The report's context measures every build-output folder; a sweep only needs the facts, and the folders it
    // deletes are measured once, as they go.
    let context = |path: &Path| {
        app_context(app, &[path.to_path_buf()], false, false).map(|ctx| Context {
            measure_build_output: false,
            ..ctx
        })
    };
    let mut run = sweep_candidates(
        &candidates,
        &records,
        &context,
        &RealGithub,
        &process_folders,
        checks,
        &now_ms,
    );
    run.took_ms = started.elapsed().as_millis() as u64;
    Ok(run)
}

fn run_loop(app: AppHandle, data_dir: PathBuf) {
    let mut checks = PrChecks::new();
    let mut wait = FIRST_SWEEP;
    loop {
        wait_for(wait);
        wait = SWEEP_EVERY;
        if !read_enabled(&data_dir) {
            continue;
        }
        let shared = shared();
        shared.running.store(true, Ordering::SeqCst);
        let result = sweep(&app, &mut checks);
        shared.running.store(false, Ordering::SeqCst);
        match result {
            Ok(run) => {
                *shared.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(run);
            }
            Err(error) => eprintln!("Worktree build output clean-up will retry: {error}"),
        }
    }
}

/// Start the background sweep. The caller checks the copy's policy: only the daily app clears build output.
pub fn init(app: AppHandle, data_dir: PathBuf) {
    let _ = std::thread::Builder::new()
        .name("worktree-autoclean".into())
        .spawn(move || run_loop(app, data_dir));
}

// ---- the commands ---------------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub async fn worktree_autoclean_status(app: AppHandle) -> Result<Status, String> {
    let data_dir = project_file::data_dir(&app)?;
    Ok(status(&data_dir))
}

#[tauri::command(async)]
pub async fn worktree_autoclean_set(app: AppHandle, enabled: bool) -> Result<Status, String> {
    let data_dir = project_file::data_dir(&app)?;
    write_enabled(&data_dir, enabled)?;
    if enabled {
        nudge();
    }
    Ok(status(&data_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::fs::git_checked;
    use crate::project_file::tests::temp;
    #[cfg(unix)]
    use crate::project_file::tests::{commit, repo};

    const NOW: u64 = 1_800_000_000_000;

    fn facts() -> Facts {
        let mut facts = Facts::new(Path::new("/w/feature"), Kind::Linked);
        facts.repo = Some("/repo".into());
        facts.registered = true;
        facts.branch = Some("feature".into());
        facts.head = Some("abc".into());
        facts.default_ref = Some("origin/main".into());
        facts.ahead = Some(3);
        facts.unpushed = Some(0);
        facts.last_activity = Some(NOW - 2 * 3_600_000);
        facts
    }

    fn merged_pr() -> Evidence {
        Evidence {
            pull_request: Some((7, true)),
            ..Evidence::default()
        }
    }

    #[test]
    fn a_dirty_tree_a_busy_one_and_a_protected_one_are_kept() {
        assert_eq!(guard(&facts(), NOW), Ok(()));
        let mut main = facts();
        main.kind = Kind::Main;
        assert!(guard(&main, NOW).unwrap_err().contains("main checkout"));
        let mut clone = facts();
        clone.kind = Kind::FullClone;
        assert!(guard(&clone, NOW).is_err());
        let mut dirty = facts();
        dirty.tracked_changes = 1;
        assert!(guard(&dirty, NOW).unwrap_err().contains("uncommitted"));
        let mut untracked = facts();
        untracked.untracked = 2;
        assert!(guard(&untracked, NOW).unwrap_err().contains("uncommitted"));
        let mut broken = facts();
        broken.status_error = Some("boom".into());
        assert!(guard(&broken, NOW).is_err());
        let mut dev = facts();
        dev.protected = Some("Its dev copy (slot x) is running".into());
        assert!(guard(&dev, NOW).unwrap_err().contains("dev copy"));
        let mut busy = facts();
        busy.process_running = true;
        assert!(guard(&busy, NOW).unwrap_err().contains("running"));
        let mut chat = facts();
        chat.chat_running = true;
        assert!(guard(&chat, NOW).unwrap_err().contains("chat"));
        let mut locked = facts();
        locked.locked = true;
        assert!(guard(&locked, NOW).is_err());
        let mut unregistered = facts();
        unregistered.registered = false;
        assert!(guard(&unregistered, NOW).is_err());
        let mut fresh = facts();
        fresh.last_activity = Some(NOW - 60_000);
        assert!(guard(&fresh, NOW).unwrap_err().starts_with("Active 1 min"));
        let mut unknown = facts();
        unknown.last_activity = None;
        assert!(guard(&unknown, NOW).is_err());
    }

    #[test]
    fn finished_needs_a_merged_or_closed_pr_an_accepted_pushed_task_or_a_merge() {
        let f = facts();
        assert_eq!(
            finished(&f, &merged_pr()),
            Ok(Finished::PullRequest {
                number: 7,
                merged: true
            })
        );
        let closed = Evidence {
            pull_request: Some((8, false)),
            ..Evidence::default()
        };
        assert_eq!(
            finished(&f, &closed),
            Ok(Finished::PullRequest {
                number: 8,
                merged: false
            })
        );
        // An accepted task counts only once the branch is pushed.
        let accepted = Evidence {
            accepted: true,
            head_in_upstream: true,
            ..Evidence::default()
        };
        assert_eq!(finished(&f, &accepted), Ok(Finished::Accepted));
        let unpushed = Evidence {
            accepted: true,
            ..Evidence::default()
        };
        assert!(finished(&f, &unpushed)
            .unwrap_err()
            .contains("isn't pushed"));
        // Nothing says it is done.
        assert!(finished(&f, &Evidence::default())
            .unwrap_err()
            .starts_with("Not finished"));
        // Merged into the mainline counts only with its commit on a remote, and a new branch isn't merged.
        let mut merged = facts();
        merged.ahead = Some(0);
        merged.never_committed = Some(false);
        assert_eq!(
            finished(&merged, &Evidence::default()),
            Ok(Finished::Merged)
        );
        merged.unpushed = Some(2);
        assert!(finished(&merged, &Evidence::default())
            .unwrap_err()
            .contains("isn't on a remote"));
        let mut fresh = facts();
        fresh.ahead = Some(0);
        fresh.never_committed = Some(true);
        assert!(finished(&fresh, &Evidence::default()).is_err());
    }

    #[test]
    fn the_setting_is_on_until_chosen_and_never_guesses_when_it_cannot_be_read() {
        let dir = temp("monocode-autoclean-setting");
        assert!(read_enabled(&dir.0), "on by default");
        write_enabled(&dir.0, false).unwrap();
        assert!(!read_enabled(&dir.0));
        write_enabled(&dir.0, true).unwrap();
        assert!(read_enabled(&dir.0));
        assert!(std::fs::read_dir(&dir.0)
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));
        for (text, expected) in [
            ("{}", true),
            ("not json", false),
            (r#"{"enabled": "yes"}"#, false),
            (r#"{"enabled": false, "other": 1}"#, false),
        ] {
            std::fs::write(settings_path(&dir.0), text).unwrap();
            assert_eq!(read_enabled(&dir.0), expected, "{text}");
        }
        // A file that is a folder can't be read as a choice: off.
        std::fs::remove_file(settings_path(&dir.0)).unwrap();
        std::fs::create_dir(settings_path(&dir.0)).unwrap();
        assert!(!read_enabled(&dir.0));
    }

    #[test]
    fn only_listed_folders_are_ever_named_for_deletion() {
        for ok in [
            "target",
            "src-tauri/target",
            "test-results",
            "playwright-report",
            "node_modules",
            "web/node_modules",
            "packages/app/node_modules",
        ] {
            assert!(allowed_folder(ok), "{ok}");
        }
        for no in [
            "dist",
            "build",
            ".next",
            "coverage",
            "src",
            "crates/x/target",
            "web/target",
            "../target",
            "/target",
            "target/../src",
            "node_modules/../src",
            "",
            ".git",
        ] {
            assert!(!allowed_folder(no), "{no}");
        }
    }

    #[test]
    fn a_pull_request_read_from_gh_must_have_this_commit_as_its_head() {
        let pr = |number, state: &str, head: &str| GhPr {
            number,
            state: state.into(),
            head_ref_oid: head.into(),
            base_ref_name: "main".into(),
        };
        assert_eq!(read_prs(&[], "abc"), None);
        assert_eq!(read_prs(&[pr(1, "MERGED", "abc")], "abc"), Some((1, true)));
        assert_eq!(read_prs(&[pr(2, "CLOSED", "abc")], "abc"), Some((2, false)));
        // Merged wins over an older closed one.
        assert_eq!(
            read_prs(&[pr(2, "CLOSED", "abc"), pr(3, "MERGED", "abc")], "abc"),
            Some((3, true))
        );
        // Another commit's pull request says nothing about this one.
        assert_eq!(read_prs(&[pr(4, "MERGED", "other")], "abc"), None);
        // An open one for this same commit means it is still under review.
        assert_eq!(
            read_prs(&[pr(5, "OPEN", "abc"), pr(6, "MERGED", "abc")], "abc"),
            None
        );
        // An open one for an older commit of the branch doesn't undo a merge of this one.
        assert_eq!(
            read_prs(&[pr(5, "OPEN", "other"), pr(6, "MERGED", "abc")], "abc"),
            Some((6, true))
        );
    }

    // ---- real git ---------------------------------------------------------------------------------------------------

    #[cfg(unix)]
    struct Fixture {
        _temp: crate::project_file::tests::Temp,
        main: PathBuf,
        origin: PathBuf,
        root: PathBuf,
    }

    /// A repository with a bare origin, a pushed `main`, and `.gitignore` the way this repo's is.
    #[cfg(unix)]
    fn fixture() -> Fixture {
        let temp = temp("monocode-autoclean");
        let main = repo(&temp.0);
        let origin = temp.0.join("origin.git");
        git_checked(
            &temp.0,
            &["init", "--bare", "-b", "main", origin.to_str().unwrap()],
        )
        .unwrap();
        git_checked(
            &main,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        )
        .unwrap();
        std::fs::write(
            main.join(".gitignore"),
            "target/\nnode_modules\ntest-results/\nplaywright-report/\ndist/\n.env\nscratch-ignored/\n",
        )
        .unwrap();
        git_checked(&main, &["add", ".gitignore"]).unwrap();
        commit(&main, "ignore build output");
        git_checked(&main, &["push", "-u", "origin", "main"]).unwrap();
        let root = temp.0.join("Worktrees");
        std::fs::create_dir_all(&root).unwrap();
        Fixture {
            _temp: temp,
            main,
            origin,
            root,
        }
    }

    #[cfg(unix)]
    impl Fixture {
        fn add(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            git_checked(
                &self.main,
                &["worktree", "add", "-b", name, path.to_str().unwrap()],
            )
            .unwrap();
            path
        }

        /// A commit in the worktree, pushed when asked.
        fn work(&self, tree: &Path, file: &str, push: bool) -> String {
            std::fs::write(tree.join(file), file).unwrap();
            git_checked(tree, &["add", file]).unwrap();
            commit(tree, file);
            if push {
                let branch = git_text(tree, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
                git_checked(tree, &["push", "-u", "origin", &branch]).unwrap();
            }
            git_text(tree, &["rev-parse", "HEAD"]).unwrap()
        }
    }

    /// Build output the way a worker leaves it, with a link out of it that deleting must not follow.
    #[cfg(unix)]
    fn leave_output(tree: &Path, outside: &Path) {
        for folder in [
            "target/debug",
            "src-tauri/target/debug",
            "test-results",
            "playwright-report",
        ] {
            std::fs::create_dir_all(tree.join(folder)).unwrap();
            std::fs::write(tree.join(folder).join("big.bin"), vec![1u8; 50_000]).unwrap();
        }
        std::os::unix::fs::symlink(outside, tree.join("target/debug/escape")).unwrap();
    }

    #[cfg(unix)]
    struct Fake {
        prs: Result<Vec<GhPr>, String>,
        calls: std::cell::Cell<u32>,
    }

    #[cfg(unix)]
    impl Github for Fake {
        fn pull_requests(&self, _worktree: &Path, _branch: &str) -> Result<Vec<GhPr>, String> {
            self.calls.set(self.calls.get() + 1);
            self.prs.clone()
        }
    }

    #[cfg(unix)]
    fn no_prs() -> Fake {
        Fake {
            prs: Ok(Vec::new()),
            calls: std::cell::Cell::new(0),
        }
    }

    #[cfg(unix)]
    fn pr_records(
        reason: &str,
        head_ref: &str,
        head_sha: &str,
        worktree: Option<&Path>,
    ) -> Records {
        let mut records = Records::default();
        records.ended.push(EndedPr {
            number: 41,
            merged: reason == "merged",
            head_ref: head_ref.into(),
            head_sha: Some(head_sha.into()),
            worktree: worktree.map(|path| crate::fs::canonical(path).unwrap()),
        });
        records
    }

    /// No process of the user's runs in any worktree.
    #[cfg(unix)]
    fn nothing_running() -> Result<Vec<PathBuf>, String> {
        Ok(vec![PathBuf::from("/")])
    }

    #[cfg(unix)]
    fn later() -> u64 {
        now_ms() + 24 * 3_600_000
    }

    #[cfg(unix)]
    fn run(tree: &Path, ctx: &Context, records: &Records, github: &dyn Github) -> Outcome {
        clear_one(
            tree,
            ctx,
            records,
            github,
            &nothing_running,
            &mut PrChecks::new(),
            later(),
        )
    }

    #[cfg(unix)]
    fn kept(outcome: Outcome) -> String {
        match outcome {
            Outcome::Kept(reason) => reason,
            other => panic!("expected Kept, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_finished_worktree_loses_only_its_listed_folders() {
        let fx = fixture();
        let tree = fx.add("feature");
        std::fs::create_dir_all(tree.join("web/src")).unwrap();
        fx.work(&tree, "web/src/keep.txt", false);
        let head = fx.work(&tree, "feature.txt", true);
        let outside = fx._temp.0.join("outside");
        std::fs::create_dir_all(outside.join("pkg")).unwrap();
        std::fs::write(outside.join("pkg/index.js"), "keep me").unwrap();
        leave_output(&tree, &outside);
        // A real node_modules at the top and a package's own, plus things that must stay.
        std::fs::create_dir_all(tree.join("node_modules/dep")).unwrap();
        std::fs::write(tree.join("node_modules/dep/index.js"), "dep").unwrap();
        std::fs::create_dir_all(tree.join("web/node_modules/dep")).unwrap();
        std::fs::write(tree.join("web/node_modules/dep/index.js"), "dep").unwrap();
        for stay in ["dist", "scratch-ignored"] {
            std::fs::create_dir_all(tree.join(stay)).unwrap();
            std::fs::write(tree.join(stay).join("keep.txt"), "mine").unwrap();
        }
        std::fs::write(tree.join(".env"), "SECRET=1").unwrap();

        let records = pr_records("merged", "feature", &head, Some(&tree));
        let ctx = Context::default();
        let outcome = run(&tree, &ctx, &records, &no_prs());
        let Outcome::Cleared(done) = outcome else {
            panic!("a merged worktree should be cleared: {outcome:?}")
        };
        assert_eq!(done.why, "pull request #41 merged");
        let mut folders: Vec<&str> = done.folders.iter().map(|f| f.folder.as_str()).collect();
        folders.sort_unstable();
        assert_eq!(
            folders,
            [
                "node_modules",
                "playwright-report",
                "src-tauri/target",
                "target",
                "test-results",
                "web/node_modules"
            ]
        );
        assert!(done.bytes >= 150_000, "{}", done.bytes);
        for gone in [
            "target",
            "src-tauri/target",
            "test-results",
            "playwright-report",
            "node_modules",
            "web/node_modules",
        ] {
            assert!(!tree.join(gone).exists(), "{gone} should be gone");
        }
        // Code, other ignored files and everything the links pointed at stay.
        assert_eq!(
            std::fs::read_to_string(tree.join("feature.txt")).unwrap(),
            "feature.txt"
        );
        assert!(tree.join("dist/keep.txt").exists());
        assert!(tree.join("scratch-ignored/keep.txt").exists());
        assert_eq!(
            std::fs::read_to_string(tree.join("web/src/keep.txt")).unwrap(),
            "web/src/keep.txt"
        );
        assert_eq!(
            std::fs::read_to_string(tree.join(".env")).unwrap(),
            "SECRET=1"
        );
        assert_eq!(
            std::fs::read_to_string(outside.join("pkg/index.js")).unwrap(),
            "keep me"
        );
        assert!(git_text(&tree, &["status", "--porcelain"])
            .unwrap()
            .is_empty());
        // Nothing left to clear.
        assert!(matches!(
            run(&tree, &ctx, &records, &no_prs()),
            Outcome::NoOutput
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_closed_pull_request_finishes_a_worktree_too() {
        let fx = fixture();
        let tree = fx.add("abandoned");
        let head = fx.work(&tree, "a.txt", true);
        leave_output(&tree, &fx._temp.0);
        let records = pr_records("closed", "abandoned", &head, None);
        let Outcome::Cleared(done) = run(&tree, &Context::default(), &records, &no_prs()) else {
            panic!("a closed pull request finishes it")
        };
        assert_eq!(done.why, "pull request #41 closed");
    }

    #[cfg(unix)]
    #[test]
    fn the_main_checkout_is_never_cleared() {
        let fx = fixture();
        std::fs::create_dir_all(fx.main.join("target/debug")).unwrap();
        std::fs::write(fx.main.join("target/debug/big.bin"), vec![1u8; 10_000]).unwrap();
        std::fs::create_dir_all(fx.main.join("node_modules/dep")).unwrap();
        let head = git_text(&fx.main, &["rev-parse", "HEAD"]).unwrap();
        // Even with a merged pull request on record for its branch and commit.
        let records = pr_records("merged", "main", &head, Some(&fx.main));
        let reason = kept(run(&fx.main, &Context::default(), &records, &no_prs()));
        assert!(reason.contains("main checkout"), "{reason}");
        assert!(fx.main.join("target/debug/big.bin").exists());
        assert!(fx.main.join("node_modules/dep").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_dirty_tree_keeps_its_build_output() {
        let fx = fixture();
        let tree = fx.add("dirty");
        let head = fx.work(&tree, "a.txt", true);
        leave_output(&tree, &fx._temp.0);
        let records = pr_records("merged", "dirty", &head, None);
        let ctx = Context::default();

        std::fs::write(tree.join("wip.txt"), "mine").unwrap();
        assert!(kept(run(&tree, &ctx, &records, &no_prs())).contains("uncommitted"));
        assert!(tree.join("target/debug/big.bin").exists());
        std::fs::remove_file(tree.join("wip.txt")).unwrap();

        std::fs::write(tree.join("a.txt"), "edited").unwrap();
        assert!(kept(run(&tree, &ctx, &records, &no_prs())).contains("uncommitted"));
        assert!(tree.join("target/debug/big.bin").exists());
        git_checked(&tree, &["checkout", "--", "a.txt"]).unwrap();

        assert!(matches!(
            run(&tree, &ctx, &records, &no_prs()),
            Outcome::Cleared(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn unpushed_commits_keep_the_build_output_even_for_an_accepted_task() {
        let fx = fixture();
        let tree = fx.add("worker");
        fx.work(&tree, "a.txt", true);
        // The task is accepted, but one more commit never left this Mac.
        fx.work(&tree, "b.txt", false);
        leave_output(&tree, &fx._temp.0);
        let mut records = Records::default();
        records.tasks.push(TaskChat {
            folder: crate::fs::canonical(&tree).unwrap(),
            accepted: true,
        });
        let ctx = Context::default();
        let reason = kept(run(&tree, &ctx, &records, &no_prs()));
        assert!(reason.contains("isn't pushed"), "{reason}");
        assert!(tree.join("target/debug/big.bin").exists());

        // Pushed, it is cleared.
        git_checked(&tree, &["push", "origin", "worker"]).unwrap();
        let Outcome::Cleared(done) = run(&tree, &ctx, &records, &no_prs()) else {
            panic!("an accepted, pushed task is finished")
        };
        assert_eq!(done.why, "task accepted and branch pushed");
        assert!(!tree.join("target").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_task_still_open_in_the_worktree_keeps_it() {
        let fx = fixture();
        let tree = fx.add("two-chats");
        fx.work(&tree, "a.txt", true);
        leave_output(&tree, &fx._temp.0);
        let folder = crate::fs::canonical(&tree).unwrap();
        let mut records = Records::default();
        records.tasks.push(TaskChat {
            folder: folder.clone(),
            accepted: true,
        });
        records.tasks.push(TaskChat {
            folder,
            accepted: false,
        });
        assert!(kept(run(&tree, &Context::default(), &records, &no_prs())).contains("Not finished"));
        assert!(tree.join("target").exists());
    }

    #[cfg(unix)]
    #[test]
    fn an_open_pull_request_holds_back_a_merge_read_for_its_commit_but_not_an_accepted_pushed_task()
    {
        let fx = fixture();
        let tree = fx.add("open-pr");
        let head = fx.work(&tree, "a.txt", true);
        leave_output(&tree, &fx._temp.0);
        let ctx = Context::default();
        let pr = |number, state: &str, oid: &str| GhPr {
            number,
            state: state.into(),
            head_ref_oid: oid.into(),
            base_ref_name: "main".into(),
        };
        // A closed pull request and an open one for the same commit: still under review.
        let both = Fake {
            prs: Ok(vec![pr(8, "CLOSED", &head), pr(9, "OPEN", &head)]),
            calls: std::cell::Cell::new(0),
        };
        assert!(kept(run(&tree, &ctx, &Records::default(), &both)).contains("Not finished"));
        assert!(tree.join("target/debug/big.bin").exists());
        // A merged pull request for another commit of the branch doesn't finish this one.
        let other = pr_records("merged", "open-pr", "0000000", None);
        assert!(kept(run(&tree, &ctx, &other, &no_prs())).contains("Not finished"));
        // The task was accepted and the branch is pushed: finished, whatever is open on GitHub, and GitHub isn't asked.
        let mut accepted = Records::default();
        accepted.tasks.push(TaskChat {
            folder: crate::fs::canonical(&tree).unwrap(),
            accepted: true,
        });
        let open = Fake {
            prs: Ok(vec![pr(9, "OPEN", &head)]),
            calls: std::cell::Cell::new(0),
        };
        let Outcome::Cleared(done) = run(&tree, &ctx, &accepted, &open) else {
            panic!("an accepted, pushed task is finished")
        };
        assert_eq!(done.why, "task accepted and branch pushed");
        assert_eq!(open.calls.get(), 0);
    }

    /// Squash-merged and the branch deleted on GitHub: the remote branch is gone after a prune, so the accepted task
    /// can't prove it is pushed, but the merged pull request with this exact head can.
    #[cfg(unix)]
    #[test]
    fn an_accepted_task_whose_branch_was_deleted_after_the_merge_is_found_through_its_pull_request()
    {
        let fx = fixture();
        let tree = fx.add("squashed");
        let head = fx.work(&tree, "a.txt", true);
        git_checked(&tree, &["push", "origin", "--delete", "squashed"]).unwrap();
        git_checked(&tree, &["fetch", "--prune", "origin"]).unwrap();
        leave_output(&tree, &fx._temp.0);
        let mut accepted = Records::default();
        accepted.tasks.push(TaskChat {
            folder: crate::fs::canonical(&tree).unwrap(),
            accepted: true,
        });
        let ctx = Context::default();
        let reason = kept(run(&tree, &ctx, &accepted, &no_prs()));
        assert!(reason.contains("isn't pushed"), "{reason}");
        let merged = Fake {
            prs: Ok(vec![GhPr {
                number: 77,
                state: "MERGED".into(),
                head_ref_oid: head,
                base_ref_name: "main".into(),
            }]),
            calls: std::cell::Cell::new(0),
        };
        let Outcome::Cleared(done) = run(&tree, &ctx, &accepted, &merged) else {
            panic!("a merged pull request with this head finishes it")
        };
        assert_eq!(done.why, "pull request #77 merged");
    }

    #[cfg(unix)]
    #[test]
    fn a_merged_pull_request_found_through_gh_finishes_a_worktree_no_one_watched() {
        let fx = fixture();
        let tree = fx.add("unwatched");
        let head = fx.work(&tree, "a.txt", true);
        leave_output(&tree, &fx._temp.0);
        let ctx = Context::default();
        // gh unreachable: nothing says it is done.
        let down = Fake {
            prs: Err("gh timed out".into()),
            calls: std::cell::Cell::new(0),
        };
        assert!(kept(run(&tree, &ctx, &Records::default(), &down)).contains("Not finished"));
        assert!(tree.join("target").exists());
        // Asked once an hour per commit, not every sweep.
        let merged = Fake {
            prs: Ok(vec![GhPr {
                number: 12,
                state: "MERGED".into(),
                head_ref_oid: head,
                base_ref_name: "main".into(),
            }]),
            calls: std::cell::Cell::new(0),
        };
        let mut checks = PrChecks::new();
        let now = later();
        clear_one(
            &tree,
            &ctx,
            &Records::default(),
            &down,
            &nothing_running,
            &mut checks,
            now,
        );
        assert!(matches!(
            clear_one(
                &tree,
                &ctx,
                &Records::default(),
                &merged,
                &nothing_running,
                &mut checks,
                now + 60_000
            ),
            Outcome::Kept(_)
        ));
        assert_eq!(merged.calls.get(), 0, "asked again within the hour");
        let Outcome::Cleared(done) = clear_one(
            &tree,
            &ctx,
            &Records::default(),
            &merged,
            &nothing_running,
            &mut checks,
            now + PR_RECHECK_MS + 1,
        ) else {
            panic!("a merged pull request finishes it")
        };
        assert_eq!(done.why, "pull request #12 merged");
    }

    #[cfg(unix)]
    #[test]
    fn a_branch_merged_into_the_mainline_and_pushed_is_finished() {
        let fx = fixture();
        let tree = fx.add("landed");
        fx.work(&tree, "a.txt", true);
        git_checked(&fx.main, &["merge", "--ff-only", "landed"]).unwrap();
        git_checked(&fx.main, &["push", "origin", "main"]).unwrap();
        leave_output(&tree, &fx._temp.0);
        let Outcome::Cleared(done) =
            run(&tree, &Context::default(), &Records::default(), &no_prs())
        else {
            panic!("a merged, pushed branch is finished")
        };
        assert_eq!(done.why, "branch merged");
        // A branch that never moved is not finished: a worker may just be starting.
        let fresh = fx.add("fresh");
        leave_output(&fresh, &fx._temp.0);
        assert!(kept(run(
            &fresh,
            &Context::default(),
            &Records::default(),
            &no_prs()
        ))
        .contains("Not finished"));
        assert!(fresh.join("target").exists());
        let _ = &fx.origin;
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_node_modules_stays_and_a_real_one_goes() {
        let fx = fixture();
        std::fs::create_dir_all(fx.main.join("node_modules/pkg")).unwrap();
        std::fs::write(fx.main.join("node_modules/pkg/index.js"), "keep me").unwrap();
        let linked = fx.add("linked");
        let head_linked = fx.work(&linked, "a.txt", true);
        std::os::unix::fs::symlink(fx.main.join("node_modules"), linked.join("node_modules"))
            .unwrap();
        leave_output(&linked, &fx._temp.0);
        let real = fx.add("real");
        let head_real = fx.work(&real, "b.txt", true);
        std::fs::create_dir_all(real.join("node_modules/dep")).unwrap();
        std::fs::write(real.join("node_modules/dep/index.js"), "dep").unwrap();
        let mut records = pr_records("merged", "linked", &head_linked, None);
        records
            .ended
            .extend(pr_records("merged", "real", &head_real, None).ended);
        let ctx = Context::default();

        let Outcome::Cleared(done) = run(&linked, &ctx, &records, &no_prs()) else {
            panic!("cleared")
        };
        assert!(done.folders.iter().all(|f| f.folder != "node_modules"));
        assert!(std::fs::symlink_metadata(linked.join("node_modules"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(fx.main.join("node_modules/pkg/index.js")).unwrap(),
            "keep me",
            "the main checkout's node_modules is untouched"
        );
        assert!(!linked.join("target").exists());

        let Outcome::Cleared(done) = run(&real, &ctx, &records, &no_prs()) else {
            panic!("cleared")
        };
        assert_eq!(done.folders.len(), 1);
        assert_eq!(done.folders[0].folder, "node_modules");
        assert!(!real.join("node_modules").exists());
    }

    #[cfg(unix)]
    #[test]
    fn deleting_refuses_a_folder_that_is_a_link_is_tracked_or_sits_behind_a_link() {
        let fx = fixture();
        let tree = fx.add("tricky");
        fx.work(&tree, "a.txt", true);
        let outside = fx._temp.0.join("outside");
        std::fs::create_dir_all(outside.join("node_modules/dep")).unwrap();
        std::fs::create_dir_all(outside.join("target")).unwrap();
        std::fs::write(outside.join("target/precious"), "keep me").unwrap();
        // `target` is a link out of the worktree; `web` is a link whose node_modules would be outside.
        std::os::unix::fs::symlink(outside.join("target"), tree.join("target")).unwrap();
        std::os::unix::fs::symlink(&outside, tree.join("web")).unwrap();
        // A tracked file under a name this clean-up knows is never deleted.
        std::fs::create_dir_all(tree.join("playwright-report")).unwrap();
        git_checked(&tree, &["add", "-f", "--", "playwright-report"]).ok();
        std::fs::write(tree.join("playwright-report/keep.txt"), "tracked").unwrap();
        git_checked(&tree, &["add", "-f", "playwright-report/keep.txt"]).unwrap();
        commit(&tree, "track a report");
        let folders = vec![
            "target".to_string(),
            "web/node_modules".to_string(),
            "playwright-report".to_string(),
            "src".to_string(),
            "../outside".to_string(),
        ];
        let cleaning = clear_folders(&tree, &folders).unwrap();
        assert!(cleaning.cleared.is_empty(), "{:?}", cleaning.cleared);
        assert_eq!(
            std::fs::read_to_string(outside.join("target/precious")).unwrap(),
            "keep me"
        );
        assert!(outside.join("node_modules/dep").exists());
        assert!(tree.join("playwright-report/keep.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_running_dev_copy_an_agent_a_chat_and_a_cargo_build_each_keep_the_worktree() {
        let fx = fixture();
        let tree = fx.add("busy");
        let head = fx.work(&tree, "a.txt", true);
        leave_output(&tree, &fx._temp.0);
        let records = pr_records("merged", "busy", &head, None);
        let real = crate::fs::canonical(&tree).unwrap();

        let dev = Context {
            protected: vec![(real.clone(), "Its dev copy (slot busy) is running".into())],
            ..Context::default()
        };
        assert!(kept(run(&tree, &dev, &records, &no_prs())).contains("dev copy"));
        let agent = Context {
            busy: vec![real.join("src-tauri")],
            ..Context::default()
        };
        assert!(kept(run(&tree, &agent, &records, &no_prs())).contains("running in it"));
        let chat = Context {
            chats: vec![(real.clone(), now_ms(), true)],
            ..Context::default()
        };
        assert!(kept(run(&tree, &chat, &records, &no_prs())).contains("chat"));

        // A cargo build holds `.cargo-lock` for as long as it runs.
        use std::os::unix::io::AsRawFd;
        let lock = std::fs::File::create(tree.join("target/debug/.cargo-lock")).unwrap();
        assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
        assert!(kept(run(&tree, &Context::default(), &records, &no_prs())).contains("cargo build"));
        assert!(tree.join("target/debug/big.bin").exists());
        drop(lock);
        assert!(matches!(
            run(&tree, &Context::default(), &records, &no_prs()),
            Outcome::Cleared(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_worktree_touched_in_the_last_ten_minutes_is_left_alone() {
        let fx = fixture();
        let tree = fx.add("just-now");
        let head = fx.work(&tree, "a.txt", true);
        leave_output(&tree, &fx._temp.0);
        let records = pr_records("merged", "just-now", &head, None);
        let ctx = Context::default();
        let reason = kept(clear_one(
            &tree,
            &ctx,
            &records,
            &no_prs(),
            &nothing_running,
            &mut PrChecks::new(),
            now_ms(),
        ));
        assert!(reason.starts_with("Active"), "{reason}");
        assert!(tree.join("target").exists());
    }

    /// A whole ~/Worktrees: the sweep clears what is finished and leaves everything else as it is.
    #[cfg(unix)]
    #[test]
    fn a_sweep_clears_the_finished_worktrees_and_leaves_the_rest() {
        let fx = fixture();
        let merged = fx.add("merged-pr");
        let merged_head = fx.work(&merged, "m.txt", true);
        let closed = fx.add("closed-pr");
        let closed_head = fx.work(&closed, "c.txt", true);
        let dirty = fx.add("dirty-but-merged");
        let dirty_head = fx.work(&dirty, "d.txt", true);
        std::fs::write(dirty.join("wip.txt"), "mine").unwrap();
        let working = fx.add("still-working");
        fx.work(&working, "w.txt", true);
        let held = fx.add("being-removed");
        let held_head = fx.work(&held, "h.txt", true);
        let empty = fx.add("nothing-to-clear");
        let empty_head = fx.work(&empty, "e.txt", true);
        for tree in [&merged, &closed, &dirty, &working, &held] {
            leave_output(tree, &fx._temp.0);
        }
        let mut records = pr_records("merged", "merged-pr", &merged_head, None);
        for (reason, branch, head) in [
            ("closed", "closed-pr", closed_head),
            ("merged", "dirty-but-merged", dirty_head),
            ("merged", "being-removed", held_head),
            ("merged", "nothing-to-clear", empty_head),
        ] {
            records
                .ended
                .extend(pr_records(reason, branch, &head, None).ended);
        }
        let candidates: Vec<PathBuf> = discover(std::slice::from_ref(&fx.root), &[])
            .into_iter()
            .filter(|(_, kind)| *kind == Kind::Linked)
            .map(|(path, _)| crate::fs::canonical(&path).unwrap())
            .collect();
        assert_eq!(candidates.len(), 6);
        // Another removal (a tap in Settings) holds this one right now.
        let reservation = crate::worktree_lifecycle::reserve_removal(&held).unwrap();

        let mut checks = PrChecks::new();
        let run = sweep_candidates(
            &candidates,
            &records,
            &|_| Ok(Context::default()),
            &no_prs(),
            &nothing_running,
            &mut checks,
            &later,
        );
        let mut cleared: Vec<&str> = run
            .cleared
            .iter()
            .map(|c| c.path.rsplit('/').next().unwrap())
            .collect();
        cleared.sort_unstable();
        assert_eq!(cleared, ["closed-pr", "merged-pr"]);
        assert!(run.cleared_bytes >= 2 * 150_000, "{}", run.cleared_bytes);
        assert_eq!(
            run.cleared_bytes,
            run.cleared.iter().map(|c| c.bytes).sum::<u64>()
        );
        // Five had build output; two were cleared; dirty, unfinished and the one being removed stayed.
        assert_eq!((run.checked, run.held_back), (5, 3), "{run:?}");
        assert!(run.errors.is_empty(), "{:?}", run.errors);
        for (gone, code) in [(&merged, "m.txt"), (&closed, "c.txt")] {
            assert!(!gone.join("target").exists());
            assert!(!gone.join("src-tauri/target").exists());
            assert_eq!(std::fs::read_to_string(gone.join(code)).unwrap(), code);
        }
        for stays in [&dirty, &working, &held] {
            assert!(stays.join("target/debug/big.bin").exists(), "{stays:?}");
        }
        assert!(dirty.join("wip.txt").exists());
        assert!(fx.main.join(".gitignore").exists());

        // The next sweep has nothing left to do for those two, and the freed one is cleared once it is released.
        drop(reservation);
        let again = sweep_candidates(
            &candidates,
            &records,
            &|_| Ok(Context::default()),
            &no_prs(),
            &nothing_running,
            &mut checks,
            &later,
        );
        assert_eq!(again.cleared.len(), 1);
        assert!(again.cleared[0].path.ends_with("being-removed"));
        assert_eq!((again.checked, again.held_back), (3, 2));
    }

    #[cfg(unix)]
    #[test]
    fn a_sweep_that_cannot_read_what_runs_in_a_worktree_deletes_nothing() {
        let fx = fixture();
        let tree = fx.add("merged-pr");
        let head = fx.work(&tree, "m.txt", true);
        leave_output(&tree, &fx._temp.0);
        let records = pr_records("merged", "merged-pr", &head, None);
        let candidates = vec![crate::fs::canonical(&tree).unwrap()];
        let run = sweep_candidates(
            &candidates,
            &records,
            &|_| Err("A lease file can't be read".into()),
            &no_prs(),
            &nothing_running,
            &mut PrChecks::new(),
            &later,
        );
        assert_eq!(run.errors, ["A lease file can't be read"]);
        assert!(run.cleared.is_empty());
        assert!(tree.join("target/debug/big.bin").exists());
    }

    /// A shell, an agent CLI or a dev server started outside the app, with its working folder in the worktree.
    #[cfg(unix)]
    #[test]
    fn a_worktree_another_program_runs_in_keeps_its_build_output() {
        let fx = fixture();
        let tree = crate::fs::canonical(fx.add("feature")).unwrap();
        let head = fx.work(&tree, "f.txt", true);
        leave_output(&tree, &fx._temp.0);
        let records = pr_records("merged", "feature", &head, None);
        let inside = tree.join("src-tauri");
        let in_it = move || Ok::<_, String>(vec![PathBuf::from("/"), inside.clone()]);
        let reason = kept(clear_one(
            &tree,
            &Context::default(),
            &records,
            &no_prs(),
            &in_it,
            &mut PrChecks::new(),
            later(),
        ));
        assert!(reason.starts_with("Something is running in it"), "{reason}");
        assert!(tree.join("target/debug/big.bin").exists());
        // A neighbour whose name only starts the same way is somewhere else.
        let neighbour = PathBuf::from(format!("{}-2", tree.display()));
        let next_door = move || Ok::<_, String>(vec![neighbour.clone()]);
        let outcome = clear_one(
            &tree,
            &Context::default(),
            &records,
            &no_prs(),
            &next_door,
            &mut PrChecks::new(),
            later(),
        );
        assert!(matches!(outcome, Outcome::Cleared(_)), "{outcome:?}");
        assert!(!tree.join("target").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_sweep_that_cannot_see_what_else_runs_deletes_nothing() {
        let fx = fixture();
        let one = fx.add("merged-one");
        let one_head = fx.work(&one, "a.txt", true);
        let two = fx.add("merged-two");
        let two_head = fx.work(&two, "b.txt", true);
        let mut records = pr_records("merged", "merged-one", &one_head, None);
        records
            .ended
            .extend(pr_records("merged", "merged-two", &two_head, None).ended);
        for tree in [&one, &two] {
            leave_output(tree, &fx._temp.0);
        }
        let candidates = vec![
            crate::fs::canonical(&one).unwrap(),
            crate::fs::canonical(&two).unwrap(),
        ];
        let blind = || Err::<Vec<PathBuf>, String>("lsof couldn't run".into());
        let run = sweep_candidates(
            &candidates,
            &records,
            &|_| Ok(Context::default()),
            &no_prs(),
            &blind,
            &mut PrChecks::new(),
            &later,
        );
        assert_eq!(run.errors, ["lsof couldn't run"]);
        assert!(run.cleared.is_empty());
        // It stopped at the first one rather than guess about the rest.
        assert_eq!((run.checked, run.held_back), (1, 1), "{run:?}");
        for tree in [&one, &two] {
            assert!(tree.join("target/debug/big.bin").exists(), "{tree:?}");
        }
    }

    #[test]
    fn lsof_lists_one_working_folder_per_process() {
        let text = "p1\nfcwd\nn/\np42\nfcwd\nn/Users/ash/Worktrees/hub-x\np43\nfcwd\nnrelative\n";
        assert_eq!(
            lsof_folders(text),
            [
                PathBuf::from("/"),
                PathBuf::from("/Users/ash/Worktrees/hub-x")
            ]
        );
        assert!(lsof_folders("").is_empty());
    }

    #[test]
    fn something_runs_in_a_worktree_only_inside_its_folder() {
        let root = Path::new("/w/feature");
        let busy = |folder: &str| running_in(root, &[PathBuf::from(folder)]).is_some();
        assert!(busy("/w/feature"));
        assert!(busy("/w/feature/src-tauri"));
        assert!(!busy("/w/feature-2"));
        assert!(!busy("/w"));
        assert!(!busy("/"));
    }

    /// The real reading: this test's own working folder is among the answers. Windows can't say, so it never clears.
    #[test]
    fn this_process_is_among_the_programs_running() {
        let read = process_folders();
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            let here = crate::fs::canonical(std::env::current_dir().unwrap()).unwrap();
            let folders = read.expect("the working folders can be read here");
            assert!(folders.contains(&here), "{here:?} not in {folders:?}");
        } else {
            assert!(read.is_err());
        }
    }

    /// A chat's newest delegated task, by the status the app shows, says whether its worktree is done.
    #[test]
    fn an_accepted_task_is_the_newest_done_one_for_its_chat() {
        use crate::delegations::{record, settle, RecordInput, SettleInput};
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        let folder = temp("monocode-autoclean-tasks");
        let make = |name: &str| {
            let tree = folder.0.join(name);
            std::fs::create_dir_all(&tree).unwrap();
            conn.execute(
                "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at, worktree_cwd)
                 VALUES (?1, ?2, 'claude', 'm', 'agent', 't', 1, 1, ?2)",
                rusqlite::params![name, tree.to_string_lossy()],
            )
            .unwrap();
            crate::fs::canonical(&tree).unwrap()
        };
        let done = make("done-chat");
        let redone = make("redone-chat");
        let working = make("working-chat");
        let failed = make("failed-chat");
        let plain = make("plain-chat");
        let launch = |conn: &mut rusqlite::Connection, child: &str, request: &str, at: i64| {
            record(
                conn,
                RecordInput {
                    owner_session: "lead".into(),
                    request_id: request.into(),
                    child_session: child.into(),
                    ..Default::default()
                },
                at,
            )
            .unwrap()
        };
        let finish = |conn: &mut rusqlite::Connection,
                      row: &crate::delegations::Delegation,
                      state: &str,
                      at: i64| {
            settle(
                conn,
                SettleInput {
                    id: row.id.clone(),
                    generation: row.generation,
                    state: state.into(),
                    result: Some("All done".into()),
                    error: (state == "failed").then(|| "it broke".into()),
                    ..Default::default()
                },
                at,
            )
            .unwrap();
        };
        let row = launch(&mut conn, "done-chat", "r1", 10);
        finish(&mut conn, &row, "completed", 11);
        // A finished task and then a redo that is still running: not done.
        let first = launch(&mut conn, "redone-chat", "r2", 20);
        finish(&mut conn, &first, "completed", 21);
        launch(&mut conn, "redone-chat", "r3", 30);
        launch(&mut conn, "working-chat", "r4", 40);
        let broken = launch(&mut conn, "failed-chat", "r5", 50);
        finish(&mut conn, &broken, "failed", 51);

        let records = Records::read(&conn).unwrap();
        let accepted = |tree: &Path| records.evidence(tree, None, "abc").accepted;
        assert!(accepted(&done));
        assert!(!accepted(&redone), "its newest task is still running");
        assert!(!accepted(&working));
        assert!(!accepted(&failed));
        assert!(
            !accepted(&plain),
            "a chat with no delegated task proves nothing"
        );
        // The worktree folders are known to the sweep even outside ~/Worktrees.
        for tree in [&done, &redone, &working, &failed, &plain] {
            assert!(records.known_worktrees().contains(tree));
        }
    }

    #[test]
    fn the_pr_watch_records_say_which_pull_requests_are_over() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let folder = temp("monocode-autoclean-records");
        let tree = folder.0.join("wt");
        std::fs::create_dir_all(&tree).unwrap();
        let tree_text = tree.to_string_lossy().to_string();
        let insert_watch = |id: &str,
                            number: i64,
                            state: &str,
                            reason: Option<&str>,
                            head_ref: &str,
                            sha: &str| {
            conn.execute(
                    "INSERT INTO pr_watches (id, owner_session, repo, repo_key, number, state, end_reason, memo, head_sha,
                       head_ref, worktree, next_read_at, created_at, updated_at)
                     VALUES (?1, 'lead', 'o/r', 'o/r', ?2, ?3, ?4, '{}', ?5, ?6, ?7, 0, 0, 0)",
                    rusqlite::params![id, number, state, reason, sha, head_ref, tree_text],
                )
                .unwrap();
        };
        insert_watch("w1", 1, "ended", Some("merged"), "feature", "abc");
        insert_watch("w2", 2, "ended", Some("comment-limit"), "other", "def");
        insert_watch("w3", 3, "watching", None, "third", "ghi");
        let records = Records::read(&conn).unwrap();
        let real = crate::fs::canonical(&tree).unwrap();
        assert_eq!(records.known_worktrees(), std::slice::from_ref(&real));
        // By folder, and by branch and commit.
        assert_eq!(
            records
                .evidence(&real, Some("other-branch"), "abc")
                .pull_request,
            Some((1, true))
        );
        assert_eq!(
            records
                .evidence(Path::new("/nowhere"), Some("feature"), "abc")
                .pull_request,
            Some((1, true))
        );
        // Another commit isn't covered, and a watch that ended for another reason, or is still going, says nothing.
        assert_eq!(
            records
                .evidence(Path::new("/nowhere"), Some("feature"), "zzz")
                .pull_request,
            None
        );
        assert_eq!(
            records
                .evidence(Path::new("/nowhere"), Some("other"), "def")
                .pull_request,
            None
        );
        assert_eq!(
            records
                .evidence(Path::new("/nowhere"), Some("third"), "ghi")
                .pull_request,
            None
        );
    }
}
