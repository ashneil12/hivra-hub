//! Worktree janitor: one report over every worktree, and two taps that act on it (the worktree janitor design notes, "Worktree
//! janitor with a dry-run report"; the cases are ported from T3's apps/server/src/storageCleanup.ts).
//!
//! The report only reads: git runs with `GIT_OPTIONAL_LOCKS=0` (no index refresh), nothing is fetched, and folders are
//! measured with `lstat` without following a single symbolic link. Each worktree gets a verdict from the pure
//! [`verdict`] function:
//! - **remove**: a clean worktree whose branch is merged (or never moved, or whose pull request merged with this exact
//!   head), idle for a day. `git worktree remove` without `--force`; the branch stays, and its chats are detached so
//!   they keep their history (src/worktrees.rs `remove_with_sessions`).
//! - **free**: an idle worktree with build output (target/, node_modules/ ...) that git ignores. Only that output is
//!   deleted; a linked node_modules is never followed.
//! - **keep**, with the reason.
//!
//! Nothing is removed without Ash's tap, and the tap re-checks every worktree first: a worktree whose commit, files or
//! activity changed since the report is skipped.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::fs::{expand_home, path_to_js};
use crate::project_file;
use crate::worktrees::{contains_working_dir, Worktree};

const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 24 * HOUR_MS;
const MEASURE_LIMIT: Duration = Duration::from_secs(120);
const GIT_OUTPUT_LIMIT: usize = 256 * 1024;
const GH_TIMEOUT: Duration = Duration::from_secs(20);
const WORKERS: usize = 6;

/// Ignored files that never count as local work: they are rebuilt or recreated by tools.
const REGENERABLE: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    ".next",
    ".turbo",
    ".vite",
    "coverage",
    "test-results",
    "playwright-report",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".DS_Store",
];
/// Ignored paths (relative to the worktree) that tools regenerate: Tauri's generated schemas.
const REGENERABLE_PATHS: &[&str] = &["src-tauri/gen"];

/// Hard-linked files already counted in this worktree (cargo's target/ links its outputs), so each counts once, as
/// `du` does.
pub type Seen = std::collections::HashSet<(u64, u64)>;

#[derive(Clone, Debug)]
pub struct Policy {
    /// Build output of a worktree untouched this long may be freed.
    pub free_after_idle_days: u64,
    /// A merged, clean worktree untouched this long may be removed.
    pub remove_after_idle_hours: u64,
    /// Less build output than this isn't worth a line.
    pub min_free_bytes: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            free_after_idle_days: 3,
            remove_after_idle_hours: 24,
            min_free_bytes: 50 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// A linked worktree (`.git` is a file).
    Linked,
    /// A repository's main checkout.
    Main,
    /// A full clone (`.git` is a folder) that isn't the main checkout of anything here.
    FullClone,
    /// A folder with no git in it.
    NotGit,
    Symlink,
    Missing,
    /// Git can't read it (its repository moved, say).
    Broken,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOutput {
    /// Relative to the worktree.
    pub path: String,
    pub bytes: Option<u64>,
    /// A symbolic link (a node_modules linked to the main checkout): nothing to free, never followed.
    pub linked: bool,
    /// Git ignores it and tracks nothing inside it, so deleting it loses nothing.
    pub ignored: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub path: String,
    pub kind: Kind,
    /// The repository's main checkout.
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub registered: bool,
    pub locked: bool,
    pub tracked_changes: usize,
    pub untracked: usize,
    /// The first ignored file that is real local work (not build output, not a link).
    pub local_ignored: Option<String>,
    pub status_error: Option<String>,
    /// The mainline merges are checked against: the project file's `mainBranch`, else the branch the main checkout
    /// has checked out, else the remote's default (`origin/main`, as of the last fetch).
    pub default_ref: Option<String>,
    /// Commits on HEAD that the default branch doesn't have.
    pub ahead: Option<u64>,
    /// The branch tip is still where the branch was created.
    pub never_committed: Option<bool>,
    /// A merged pull request whose head is exactly this commit (a squash or rebase merge).
    pub merged_pr: Option<u64>,
    pub unpushed: Option<u64>,
    /// Newest of: the index, HEAD's log, the last commit, the folder, its chats. ms since 1970.
    pub last_activity: Option<u64>,
    pub chats: usize,
    pub chat_running: bool,
    pub process_running: bool,
    /// Why it must never be touched (the checkout this app runs from, a running dev copy's checkout).
    pub protected: Option<String>,
    pub total_bytes: Option<u64>,
    pub build_output: Vec<BuildOutput>,
    pub detail: Option<String>,
}

impl Facts {
    pub fn new(path: &Path, kind: Kind) -> Self {
        Self {
            path: path_to_js(path),
            kind,
            repo: None,
            branch: None,
            head: None,
            registered: false,
            locked: false,
            tracked_changes: 0,
            untracked: 0,
            local_ignored: None,
            status_error: None,
            default_ref: None,
            ahead: None,
            never_committed: None,
            merged_pr: None,
            unpushed: None,
            last_activity: None,
            chats: 0,
            chat_running: false,
            process_running: false,
            protected: None,
            total_bytes: None,
            build_output: Vec::new(),
            detail: None,
        }
    }

    /// Everything in the build-output folders (target/, node_modules/ ...): what this worktree holds that is rebuilt
    /// by a build. Links are never followed, so a linked node_modules counts nothing.
    pub fn build_output_bytes(&self) -> u64 {
        self.build_output
            .iter()
            .filter(|output| !output.linked)
            .filter_map(|output| output.bytes)
            .sum()
    }

    /// Build output that "Free build output" may delete.
    pub fn freeable_bytes(&self) -> u64 {
        self.build_output
            .iter()
            .filter(|output| output.ignored && !output.linked)
            .filter_map(|output| output.bytes)
            .sum()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Remove,
    Free,
    Keep,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub outcome: Outcome,
    /// merged, unchanged, pr-merged, ahead, dirty, detached, unknown, or why it isn't a worktree.
    pub state: &'static str,
    /// Why it is safe to act on, or why it is kept.
    pub reason: String,
    /// What "Free build output" may delete here (0 when it may not).
    pub freeable_bytes: u64,
    /// What the verdict frees.
    pub reclaim_bytes: u64,
}

pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else if value >= 100.0 {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

pub fn human_age(ms: u64) -> String {
    if ms < HOUR_MS {
        format!("{} min", (ms / 60_000).max(1))
    } else if ms < 2 * DAY_MS {
        let hours = ms / HOUR_MS;
        format!("{hours} hour{}", if hours == 1 { "" } else { "s" })
    } else {
        format!("{} days", ms / DAY_MS)
    }
}

fn plural(count: u64, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// The decision for one worktree. Pure: the facts are gathered elsewhere, so every case is testable.
pub fn verdict(f: &Facts, policy: &Policy, now: u64) -> Verdict {
    let keep = |state: &'static str, reason: String| Verdict {
        outcome: Outcome::Keep,
        state,
        reason,
        freeable_bytes: 0,
        reclaim_bytes: 0,
    };
    match f.kind {
        Kind::Main => return keep("main", "The main checkout of its repository".into()),
        Kind::Missing => {
            return keep(
                "missing",
                "The folder is gone; git worktree prune forgets it".into(),
            )
        }
        Kind::Symlink => {
            return keep(
                "link",
                "A symbolic link, not a worktree folder; never followed".into(),
            )
        }
        Kind::FullClone => {
            return keep(
                "clone",
                "A full clone, not a linked worktree; remove it by hand when it's done".into(),
            )
        }
        Kind::NotGit => {
            return keep(
                "other",
                if f.total_bytes == Some(0) {
                    "An empty folder, not a git worktree".into()
                } else {
                    "Not a git worktree".into()
                },
            )
        }
        Kind::Broken => {
            return keep(
                "broken",
                format!(
                    "Git can't read it: {}",
                    f.detail.as_deref().unwrap_or("unknown error")
                ),
            )
        }
        Kind::Linked => {}
    }
    if !f.registered {
        return keep(
            "unregistered",
            "Its repository doesn't list it as a worktree".into(),
        );
    }
    if let Some(why) = &f.protected {
        return keep("protected", why.clone());
    }
    if f.process_running {
        return keep(
            "busy",
            "An agent, terminal or project action is running in it".into(),
        );
    }
    if f.chat_running {
        return keep(
            "busy",
            "A chat in it is running, or was cut off mid-turn".into(),
        );
    }
    if f.locked {
        return keep("locked", "Locked in git".into());
    }

    let idle = f.last_activity.map(|at| now.saturating_sub(at));
    let idle_for = |limit: u64| idle.is_some_and(|ms| ms >= limit);
    let default = f.default_ref.as_deref().unwrap_or("the default branch");
    let clean = f.status_error.is_none()
        && f.tracked_changes == 0
        && f.untracked == 0
        && f.local_ignored.is_none();
    let merged: Option<(&'static str, String)> = if f.ahead == Some(0) {
        Some(if f.never_committed == Some(true) {
            ("unchanged", format!("no commits beyond {default}"))
        } else {
            ("merged", format!("merged into {default}"))
        })
    } else {
        f.merged_pr
            .map(|number| ("pr-merged", format!("pull request #{number} was merged")))
    };
    let state = if !clean {
        "dirty"
    } else if let Some((state, _)) = &merged {
        state
    } else if f.branch.is_none() {
        "detached"
    } else if f.ahead.is_some() {
        "ahead"
    } else {
        "unknown"
    };
    let freeable = f.freeable_bytes();
    let idle_text = idle.map(human_age);

    if let (true, Some(_), Some((_, why))) = (
        clean && idle_for(policy.remove_after_idle_hours * HOUR_MS),
        &f.branch,
        &merged,
    ) {
        return Verdict {
            outcome: Outcome::Remove,
            state,
            reason: format!(
                "{}; clean; idle {}. The branch and its chats stay",
                capitalize(why),
                idle_text.unwrap_or_default()
            ),
            freeable_bytes: freeable,
            reclaim_bytes: f.total_bytes.unwrap_or(freeable),
        };
    }

    let mut blocker = if let Some(error) = &f.status_error {
        format!("git status failed: {error}")
    } else if f.tracked_changes > 0 {
        format!(
            "has uncommitted changes ({})",
            plural(f.tracked_changes as u64, "file", "files")
        )
    } else if f.untracked > 0 {
        format!(
            "has untracked files ({})",
            plural(f.untracked as u64, "entry", "entries")
        )
    } else if let Some(path) = &f.local_ignored {
        format!("has ignored files that aren't build output ({path})")
    } else if f.branch.is_none() {
        "detached HEAD: no branch keeps its commits".into()
    } else if let Some((_, why)) = &merged {
        why.clone()
    } else if let Some(ahead) = f.ahead {
        let pushed = match f.unpushed {
            Some(0) => ", all pushed".to_string(),
            Some(count) => format!(", {count} not pushed"),
            None => String::new(),
        };
        format!(
            "{} not on {default}{pushed}",
            plural(ahead, "commit", "commits")
        )
    } else {
        "its default branch is unknown, so merged can't be checked".into()
    };
    match &idle_text {
        Some(age) if !idle_for(policy.remove_after_idle_hours * HOUR_MS) => {
            blocker.push_str(&format!("; active {age} ago"));
        }
        None => blocker.push_str("; last activity unknown"),
        _ => {}
    }

    if freeable >= policy.min_free_bytes && idle_for(policy.free_after_idle_days * DAY_MS) {
        let outputs: Vec<String> = f
            .build_output
            .iter()
            .filter(|output| output.ignored && !output.linked && output.bytes.unwrap_or(0) > 0)
            .map(|output| {
                format!(
                    "{}/ {}",
                    output.path,
                    human_bytes(output.bytes.unwrap_or(0))
                )
            })
            .collect();
        return Verdict {
            outcome: Outcome::Free,
            state,
            reason: format!(
                "Idle {}: {} can be rebuilt. The worktree stays: {blocker}",
                idle_text.unwrap_or_default(),
                outputs.join(", ")
            ),
            freeable_bytes: freeable,
            reclaim_bytes: freeable,
        };
    }
    if freeable >= policy.min_free_bytes {
        blocker.push_str(&format!(
            "; its build output ({}) can be freed once it is idle {} days",
            human_bytes(freeable),
            policy.free_after_idle_days
        ));
    }
    keep(state, capitalize(&blocker))
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

// ---- git -------------------------------------------------------------------------------------------------------------

/// Read-only git: no optional locks (status never rewrites the index), no prompts, plain English.
pub(crate) fn git_out(dir: &Path, args: &[&str]) -> Result<(String, bool), String> {
    crate::git_cmd::ensure_contained(dir)?;
    let mut command = crate::git_cmd::git();
    crate::hide_window_console(&mut command);
    command.arg("-C").arg(dir);
    crate::git_cmd::extend_readonly(&mut command, args);
    let output = command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("PATH", crate::harness::cached_gui_search_path())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr
            .lines()
            .next()
            .unwrap_or("git failed")
            .trim()
            .to_string());
    }
    let truncated = output.stdout.len() > GIT_OUTPUT_LIMIT;
    let bytes = &output.stdout[..output.stdout.len().min(GIT_OUTPUT_LIMIT)];
    Ok((String::from_utf8_lossy(bytes).into_owned(), truncated))
}

pub(crate) fn git_text(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_out(dir, args).map(|(text, _)| text.trim().to_string())
}

pub(crate) fn mtime_ms(path: &Path) -> Option<u64> {
    std::fs::symlink_metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

pub(crate) fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// One repository's worktree list and mainline, read once per scan.
#[derive(Clone, Debug)]
struct RepoInfo {
    main: PathBuf,
    trees: Vec<(PathBuf, Worktree)>,
    /// What "merged" is checked against: [`Mainline::reference`].
    default_ref: Option<String>,
    /// The mainline's branch name on the remote, for the merged pull request check.
    default_base: Option<String>,
    build_output: Vec<String>,
    /// The imported project file's `worktrees.regenerable`.
    regenerable: Vec<String>,
}

/// The branch finished work lands on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Mainline {
    /// A ref git resolves and the report names: `pm/pages-live` (a local branch) or `origin/main`.
    pub reference: String,
    /// The branch's own name, which pull requests target: `pm/pages-live`, `main`.
    pub branch: String,
}

fn ref_exists(main: &Path, full: &str) -> bool {
    git_text(main, &["rev-parse", "--verify", "--quiet", full]).is_ok()
}

/// The repository's real mainline, in this order:
/// 1. the project file's `mainBranch` (the local branch, else `origin/<name>`);
/// 2. the branch the main checkout has checked out (this repository: `pm/pages-live`, while `origin/HEAD` points at
///    an old `hub-frontend`);
/// 3. the remote's default branch, then `main`/`master`.
pub(crate) fn mainline(main: &Path, named: Option<&str>) -> Option<Mainline> {
    if let Some(name) = named
        .map(str::trim)
        .filter(|name| project_file::valid_branch_name(name))
    {
        if ref_exists(main, &format!("refs/heads/{name}")) {
            return Some(Mainline {
                reference: name.to_string(),
                branch: name.to_string(),
            });
        }
        if ref_exists(main, &format!("refs/remotes/origin/{name}")) {
            return Some(Mainline {
                reference: format!("origin/{name}"),
                branch: name.to_string(),
            });
        }
    }
    if let Ok(branch) = git_text(main, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        let branch = branch.trim();
        if project_file::valid_branch_name(branch)
            && ref_exists(main, &format!("refs/heads/{branch}"))
        {
            return Some(Mainline {
                reference: branch.to_string(),
                branch: branch.to_string(),
            });
        }
    }
    let reference = default_ref(main)?;
    let branch = reference
        .strip_prefix("origin/")
        .unwrap_or(&reference)
        .to_string();
    Some(Mainline { reference, branch })
}

fn default_ref(main: &Path) -> Option<String> {
    if let Ok(name) = git_text(
        main,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    ) {
        if let Some(short) = name.strip_prefix("refs/remotes/") {
            if git_text(main, &["rev-parse", "--verify", "--quiet", &name]).is_ok() {
                return Some(short.to_string());
            }
        }
    }
    for candidate in [
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
        "refs/heads/main",
        "refs/heads/master",
    ] {
        if git_text(main, &["rev-parse", "--verify", "--quiet", candidate]).is_ok() {
            return Some(
                candidate
                    .trim_start_matches("refs/remotes/")
                    .trim_start_matches("refs/heads/")
                    .to_string(),
            );
        }
    }
    None
}

fn repo_info(worktree: &Path, data_dir: Option<&Path>) -> Result<RepoInfo, String> {
    let trees = crate::worktrees::list(worktree)?;
    let main = PathBuf::from(&trees.first().ok_or("No working copies found")?.path);
    let main = main.canonicalize().unwrap_or(main);
    let trees = trees
        .into_iter()
        .map(|tree| {
            let path = PathBuf::from(&tree.path);
            (path.canonicalize().unwrap_or(path), tree)
        })
        .collect();
    let imported = data_dir.and_then(|data| project_file::trusted_file(data, &main));
    let build_output = imported
        .as_ref()
        .map(|file| file.build_output())
        .unwrap_or_else(project_file::default_build_output);
    let mainline = mainline(
        &main,
        imported
            .as_ref()
            .and_then(|file| file.main_branch.as_deref()),
    );
    let regenerable = imported
        .map(|file| file.worktrees.regenerable)
        .unwrap_or_default();
    Ok(RepoInfo {
        default_ref: mainline.as_ref().map(|line| line.reference.clone()),
        default_base: mainline.map(|line| line.branch),
        main,
        trees,
        build_output,
        regenerable,
    })
}

fn regenerable(entry: &str, extra: &[String]) -> bool {
    let trimmed = entry.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    let under = |path: &str| {
        trimmed == path
            || trimmed
                .strip_prefix(path)
                .is_some_and(|rest| rest.starts_with('/'))
    };
    REGENERABLE.contains(&name)
        || name.ends_with(".tsbuildinfo")
        || REGENERABLE_PATHS.iter().any(|path| under(path))
        || extra.iter().any(|path| under(path))
}

/// `git status` records: (tracked changes, untracked entries that count). A build-output entry that is a symbolic
/// link (setup's linked node_modules) doesn't count: it holds no work.
fn parse_status(text: &str, worktree: &Path, build_output: &[String]) -> (usize, usize) {
    let mut tracked = 0;
    let mut untracked = 0;
    let mut records = text.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let (code, path) = record.split_at(3);
        let code = code.trim_end();
        if code == "??" {
            let path = path.trim_end_matches('/');
            let linked_output = build_output.iter().any(|output| output == path)
                && is_symlink(&worktree.join(path));
            if !linked_output {
                untracked += 1;
            }
        } else {
            tracked += 1;
            // A rename or copy carries its source path as the next record.
            if code.starts_with('R') || code.starts_with('C') {
                records.next();
            }
        }
    }
    (tracked, untracked)
}

/// The first ignored entry that is real local work: not build output, not regenerable, not a link.
fn first_local_ignored(
    text: &str,
    worktree: &Path,
    build_output: &[String],
    extra_regenerable: &[String],
) -> Option<String> {
    text.split('\0')
        .filter(|entry| !entry.is_empty())
        .find(|entry| {
            let trimmed = entry.trim_end_matches('/');
            !regenerable(entry, extra_regenerable)
                && !build_output.iter().any(|output| output == trimmed)
                && !is_symlink(&worktree.join(trimmed))
        })
        .map(|entry| entry.to_string())
}

/// One pull request `gh pr list` found for a branch.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GhPr {
    pub number: u64,
    /// OPEN, MERGED or CLOSED.
    #[serde(default)]
    pub state: String,
    pub head_ref_oid: String,
    pub base_ref_name: String,
}

/// The pull requests whose head is `branch` in `state` (`merged`, `closed`, `open` or `all`), read-only, with a
/// timeout. Pull requests from forks are not found: only the repository's own branches.
pub fn gh_prs_for_branch(worktree: &Path, branch: &str, state: &str) -> Result<Vec<GhPr>, String> {
    let mut command = Command::new("gh");
    crate::hide_window_console(&mut command);
    let mut child = command
        .current_dir(worktree)
        .args([
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            state,
            "--json",
            "number,state,headRefOid,baseRefName",
            "--limit",
            "20",
        ])
        .env("PATH", crate::harness::cached_gui_search_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("gh: {error}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > GH_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("gh timed out".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    if !status.success() {
        return Err("gh pr list failed".into());
    }
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

fn gh_merged_pr(
    worktree: &Path,
    branch: &str,
    head: &str,
    base: &str,
) -> Result<Option<u64>, String> {
    Ok(gh_prs_for_branch(worktree, branch, "merged")?
        .into_iter()
        .find(|pr| pr.head_ref_oid == head && pr.base_ref_name == base)
        .map(|pr| pr.number))
}

// ---- measuring ------------------------------------------------------------------------------------------------------

#[cfg(unix)]
fn allocated(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.blocks() * 512
}

#[cfg(not(unix))]
fn allocated(meta: &std::fs::Metadata) -> u64 {
    meta.len()
}

/// A hard-linked file seen before in this walk counts nothing.
#[cfg(unix)]
fn first_sighting(meta: &std::fs::Metadata, seen: &mut Seen) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.nlink() <= 1 || seen.insert((meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn first_sighting(_meta: &std::fs::Metadata, _seen: &mut Seen) -> bool {
    true
}

/// Bytes under `root`, never following a symbolic link, each hard-linked file once. `None` when it takes longer than
/// `deadline`.
pub fn measure(root: &Path, skip: &[PathBuf], deadline: Instant, seen: &mut Seen) -> Option<u64> {
    match std::fs::symlink_metadata(root) {
        Ok(meta) if meta.file_type().is_symlink() => return Some(0),
        Ok(meta) if !meta.is_dir() => {
            return Some(if first_sighting(&meta, seen) {
                allocated(&meta)
            } else {
                0
            })
        }
        Ok(_) => {}
        Err(_) => return Some(0),
    }
    let mut stack = vec![root.to_path_buf()];
    let mut bytes = 0u64;
    let mut checked = 0u32;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            checked = checked.wrapping_add(1);
            if checked.is_multiple_of(4096) && Instant::now() > deadline {
                return None;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if !skip.contains(&path) {
                    stack.push(path);
                }
            } else if let Ok(meta) = entry.metadata() {
                if first_sighting(&meta, seen) {
                    bytes += allocated(&meta);
                }
            }
        }
    }
    Some(bytes)
}

/// Whether git ignores `relative` and tracks nothing inside it.
pub(crate) fn ignored_by_git(worktree: &Path, relative: &str) -> bool {
    git_out(
        worktree,
        &["check-ignore", "-q", "--no-index", "--", relative],
    )
    .is_ok()
        && git_out(worktree, &["ls-files", "-z", "--", relative])
            .is_ok_and(|(text, _)| text.is_empty())
}

fn build_outputs(
    worktree: &Path,
    names: &[String],
    deadline: Option<Instant>,
    seen: &mut Seen,
) -> Vec<BuildOutput> {
    names
        .iter()
        .filter_map(|name| {
            let path = worktree.join(name);
            let meta = std::fs::symlink_metadata(&path).ok()?;
            let linked = meta.file_type().is_symlink();
            if !linked && !meta.is_dir() {
                return None;
            }
            Some(BuildOutput {
                path: name.clone(),
                bytes: if linked {
                    Some(0)
                } else {
                    deadline.and_then(|deadline| measure(&path, &[], deadline, seen))
                },
                linked,
                ignored: ignored_by_git(worktree, name),
            })
        })
        .collect()
}

// ---- gathering ------------------------------------------------------------------------------------------------------

/// What the scan knows beyond git: chats, live processes, protected checkouts.
#[derive(Default)]
pub struct Context {
    /// (checkout, last update ms, in flight) for every chat whose checkout still exists.
    pub chats: Vec<(PathBuf, u64, bool)>,
    /// Paths with a running agent, terminal or project action (checked live by the app).
    pub busy: Vec<PathBuf>,
    /// Paths that must never be touched, with why. A worktree containing one is protected.
    pub protected: Vec<(PathBuf, String)>,
    /// Ask GitHub about squash-merged pull requests (`gh pr list`, read-only).
    pub check_pull_requests: bool,
    /// The app's data folder, for imported project files' buildOutput.
    pub data_dir: Option<PathBuf>,
    /// Measure total size and build output (the report); skipped when only re-checking.
    pub measure_total: bool,
    pub measure_build_output: bool,
}

#[derive(Default)]
struct RepoCache {
    repos: Mutex<HashMap<PathBuf, Result<RepoInfo, String>>>,
}

impl RepoCache {
    fn get(
        &self,
        common: &Path,
        worktree: &Path,
        data_dir: Option<&Path>,
    ) -> Result<RepoInfo, String> {
        if let Some(found) = self
            .repos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(common)
        {
            return found.clone();
        }
        let info = repo_info(worktree, data_dir);
        self.repos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(common.to_path_buf(), info.clone());
        info
    }
}

fn gather_linked(path: &Path, ctx: &Context, cache: &RepoCache, facts: &mut Facts) {
    let dirs = match git_text(
        path,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
        ],
    ) {
        Ok(text) => text,
        Err(error) => {
            facts.kind = Kind::Broken;
            facts.detail = Some(error);
            return;
        }
    };
    let mut lines = dirs.lines();
    let git_dir = PathBuf::from(lines.next().unwrap_or_default());
    let common = PathBuf::from(lines.next().unwrap_or_default());
    let repo = match cache.get(&common, path, ctx.data_dir.as_deref()) {
        Ok(repo) => repo,
        Err(error) => {
            facts.kind = Kind::Broken;
            facts.detail = Some(error);
            return;
        }
    };
    facts.repo = Some(path_to_js(&repo.main));
    facts.default_ref = repo.default_ref.clone();
    if repo.main == path {
        facts.kind = Kind::Main;
        return;
    }
    let Some((_, tree)) = repo.trees.iter().find(|(tree_path, _)| tree_path == path) else {
        facts.registered = false;
        return;
    };
    facts.registered = true;
    facts.locked = tree.locked;
    facts.branch = tree.branch.clone();
    facts.head = Some(tree.head.clone());

    let build_output = &repo.build_output;
    match git_out(
        path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ],
    ) {
        Ok((_, true)) => {
            facts.status_error = Some("local changes exceed the inspection limit".into())
        }
        Ok((text, false)) => {
            let (tracked, untracked) = parse_status(&text, path, build_output);
            facts.tracked_changes = tracked;
            facts.untracked = untracked;
        }
        Err(error) => facts.status_error = Some(error),
    }
    if facts.status_error.is_none() && facts.tracked_changes == 0 && facts.untracked == 0 {
        match git_out(
            path,
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
        ) {
            Ok((_, true)) => facts.local_ignored = Some("more than the inspection limit".into()),
            Ok((text, false)) => {
                facts.local_ignored =
                    first_local_ignored(&text, path, build_output, &repo.regenerable)
            }
            Err(error) => facts.status_error = Some(error),
        }
    }

    let head = tree.head.clone();
    if let Some(default) = &repo.default_ref {
        facts.ahead = git_text(path, &["rev-list", "--count", &format!("{default}..HEAD")])
            .ok()
            .and_then(|count| count.parse().ok());
    }
    if let Some(branch) = &tree.branch {
        if facts.ahead == Some(0) {
            // The oldest reflog entry is where the branch was created.
            facts.never_committed = git_text(
                path,
                &[
                    "reflog",
                    "show",
                    "--format=%H",
                    &format!("refs/heads/{branch}"),
                    "--",
                ],
            )
            .ok()
            .and_then(|log| log.lines().last().map(|created| created.trim() == head));
        }
        let clean = facts.status_error.is_none()
            && facts.tracked_changes == 0
            && facts.untracked == 0
            && facts.local_ignored.is_none();
        if ctx.check_pull_requests && clean && facts.ahead.is_some_and(|ahead| ahead > 0) {
            if let Some(base) = &repo.default_base {
                facts.merged_pr = gh_merged_pr(path, branch, &head, base).ok().flatten();
            }
        }
    }
    facts.unpushed = git_text(path, &["rev-list", "--count", "HEAD", "--not", "--remotes"])
        .ok()
        .and_then(|count| count.parse().ok());

    let commit_ms = git_text(path, &["log", "-1", "--format=%ct"])
        .ok()
        .and_then(|seconds| seconds.parse::<u64>().ok())
        .map(|seconds| seconds * 1000);
    let mut activity: Vec<u64> = [
        mtime_ms(&git_dir.join("index")),
        mtime_ms(&git_dir.join("HEAD")),
        mtime_ms(&git_dir.join("logs").join("HEAD")),
        mtime_ms(path),
        commit_ms,
    ]
    .into_iter()
    .flatten()
    .collect();
    for (cwd, updated, in_flight) in &ctx.chats {
        if contains_working_dir(path, cwd) {
            facts.chats += 1;
            facts.chat_running |= *in_flight;
            activity.push(*updated);
        }
    }
    facts.last_activity = activity.into_iter().max();

    let mut seen = Seen::new();
    if ctx.measure_build_output || ctx.measure_total {
        let deadline = Instant::now() + MEASURE_LIMIT;
        facts.build_output = build_outputs(path, build_output, Some(deadline), &mut seen);
        if ctx.measure_total {
            let skip: Vec<PathBuf> = facts
                .build_output
                .iter()
                .filter(|output| !output.linked)
                .map(|output| path.join(&output.path))
                .collect();
            let rest = measure(path, &skip, deadline, &mut seen);
            let outputs: Option<u64> = facts.build_output.iter().map(|output| output.bytes).sum();
            facts.total_bytes = rest.zip(outputs).map(|(rest, outputs)| rest + outputs);
        }
    } else {
        facts.build_output = build_outputs(path, build_output, None, &mut seen);
    }
}

/// Facts for one folder. `kind` comes from discovery; git may refine it.
pub fn gather(path: &Path, kind: Kind, ctx: &Context) -> Facts {
    gather_with(path, kind, ctx, &RepoCache::default())
}

fn gather_with(path: &Path, kind: Kind, ctx: &Context, cache: &RepoCache) -> Facts {
    let canonical = if kind == Kind::Symlink {
        path.to_path_buf()
    } else {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    };
    let mut facts = Facts::new(&canonical, kind);
    if !path.exists() && kind != Kind::Symlink {
        facts.kind = Kind::Missing;
        return facts;
    }
    if let Some((_, why)) = ctx
        .protected
        .iter()
        .find(|(protected, _)| contains_working_dir(&canonical, protected))
    {
        facts.protected = Some(why.clone());
    }
    facts.process_running = ctx
        .busy
        .iter()
        .any(|busy| contains_working_dir(&canonical, busy));
    match kind {
        Kind::Linked => gather_linked(&canonical, ctx, cache, &mut facts),
        Kind::NotGit | Kind::FullClone if ctx.measure_total => {
            facts.total_bytes = measure(
                &canonical,
                &[],
                Instant::now() + MEASURE_LIMIT,
                &mut Seen::new(),
            );
            facts.last_activity = mtime_ms(&canonical);
        }
        _ => {}
    }
    facts
}

/// Every folder under the roots that could be a worktree: `<root>/<name>` and `<root>/<repo>/<branch>` (Ash's
/// layout), plus `extra` (a project's own worktrees elsewhere). Links are listed, never followed.
pub fn discover(roots: &[PathBuf], extra: &[PathBuf]) -> Vec<(PathBuf, Kind)> {
    fn classify(path: &Path) -> Option<Kind> {
        let meta = std::fs::symlink_metadata(path).ok()?;
        if meta.file_type().is_symlink() {
            return Some(Kind::Symlink);
        }
        if !meta.is_dir() {
            return None;
        }
        match std::fs::symlink_metadata(path.join(".git")) {
            Ok(git) if git.is_file() => Some(Kind::Linked),
            Ok(git) if git.is_dir() => Some(Kind::FullClone),
            _ => Some(Kind::NotGit),
        }
    }
    fn children(dir: &Path) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        paths.sort();
        paths
    }
    let mut found: Vec<(PathBuf, Kind)> = Vec::new();
    for root in roots {
        for child in children(root) {
            // WP-82: treehouse keeps its own state here. It is not a worktree.
            if child.file_name().and_then(|name| name.to_str()) == Some(".treehouse") {
                continue;
            }
            match classify(&child) {
                Some(Kind::NotGit) => {
                    let nested: Vec<(PathBuf, Kind)> = children(&child)
                        .into_iter()
                        .filter_map(|grandchild| match classify(&grandchild) {
                            Some(kind @ (Kind::Linked | Kind::FullClone | Kind::Symlink)) => {
                                Some((grandchild, kind))
                            }
                            _ => None,
                        })
                        .collect();
                    if nested.is_empty() {
                        found.push((child, Kind::NotGit));
                    } else {
                        found.extend(nested);
                    }
                }
                Some(kind) => found.push((child, kind)),
                None => {}
            }
        }
    }
    for path in extra {
        found.push((path.clone(), classify(path).unwrap_or(Kind::Missing)));
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|(path, kind)| {
        let key = if *kind == Kind::Symlink {
            path.clone()
        } else {
            path.canonicalize().unwrap_or_else(|_| path.clone())
        };
        seen.insert(key)
    });
    found
}

// ---- the report -----------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub facts: Facts,
    pub verdict: Verdict,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub generated_at: u64,
    pub roots: Vec<String>,
    pub entries: Vec<Entry>,
    pub total_bytes: u64,
    /// What every worktree holds in build output (inside `total_bytes`), and how many hold any.
    pub build_output_bytes: u64,
    pub build_output_count: usize,
    pub remove_count: usize,
    pub remove_bytes: u64,
    pub free_count: usize,
    pub free_bytes: u64,
    pub keep_count: usize,
    /// What the scan could and couldn't check.
    pub notes: Vec<String>,
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn report(
    roots: &[PathBuf],
    extra: &[PathBuf],
    ctx: &Context,
    policy: &Policy,
    now: u64,
) -> Report {
    let candidates = discover(roots, extra);
    let cache = RepoCache::default();
    let next = Mutex::new(0usize);
    let results: Mutex<Vec<Option<Facts>>> = Mutex::new(vec![None; candidates.len()]);
    std::thread::scope(|scope| {
        for _ in 0..WORKERS.min(candidates.len().max(1)) {
            scope.spawn(|| loop {
                let index = {
                    let mut next = next.lock().unwrap_or_else(|e| e.into_inner());
                    let index = *next;
                    *next += 1;
                    index
                };
                let Some((path, kind)) = candidates.get(index) else {
                    break;
                };
                let facts = gather_with(path, *kind, ctx, &cache);
                results.lock().unwrap_or_else(|e| e.into_inner())[index] = Some(facts);
            });
        }
    });
    let mut entries: Vec<Entry> = results
        .into_inner()
        .unwrap_or_else(|e| e.into_inner())
        .into_iter()
        .flatten()
        .map(|facts| {
            let verdict = verdict(&facts, policy, now);
            Entry { facts, verdict }
        })
        .collect();
    let rank = |outcome: Outcome| match outcome {
        Outcome::Remove => 0,
        Outcome::Free => 1,
        Outcome::Keep => 2,
    };
    entries.sort_by(|a, b| {
        rank(a.verdict.outcome)
            .cmp(&rank(b.verdict.outcome))
            .then(
                b.facts
                    .total_bytes
                    .unwrap_or(0)
                    .cmp(&a.facts.total_bytes.unwrap_or(0)),
            )
            .then(a.facts.path.cmp(&b.facts.path))
    });
    let count = |outcome| {
        entries
            .iter()
            .filter(|e| e.verdict.outcome == outcome)
            .count()
    };
    let bytes = |outcome| {
        entries
            .iter()
            .filter(|e| e.verdict.outcome == outcome)
            .map(|e| e.verdict.reclaim_bytes)
            .sum()
    };
    let mut notes = vec![
        "Merged is checked against each repository's last fetch of its default branch; nothing was fetched.".to_string(),
    ];
    if !ctx.check_pull_requests {
        notes.push(
            "Pull requests weren't checked, so squash-merged branches show as not merged.".into(),
        );
    }
    if ctx.measure_total
        && entries
            .iter()
            .any(|e| e.facts.total_bytes.is_none() && e.facts.kind == Kind::Linked)
    {
        notes.push("Some folders took too long to measure; their size shows as unknown.".into());
    }
    Report {
        generated_at: now,
        roots: roots.iter().map(|root| path_to_js(root)).collect(),
        total_bytes: entries.iter().filter_map(|e| e.facts.total_bytes).sum(),
        build_output_bytes: entries.iter().map(|e| e.facts.build_output_bytes()).sum(),
        build_output_count: entries
            .iter()
            .filter(|e| e.facts.build_output_bytes() > 0)
            .count(),
        remove_count: count(Outcome::Remove),
        remove_bytes: bytes(Outcome::Remove),
        free_count: count(Outcome::Free),
        free_bytes: bytes(Outcome::Free),
        keep_count: count(Outcome::Keep),
        entries,
        notes,
    }
}

fn pretty(path: &str) -> String {
    match dirs::home_dir() {
        Some(home) => {
            let home = path_to_js(&home);
            path.strip_prefix(&home)
                .map(|rest| format!("~{rest}"))
                .unwrap_or_else(|| path.to_string())
        }
        None => path.to_string(),
    }
}

/// The report as plain text (the CLI, and the proof saved for Ash).
pub fn render_text(report: &Report, now: u64) -> String {
    let mut out = String::new();
    let roots: Vec<String> = report.roots.iter().map(|root| pretty(root)).collect();
    out.push_str(&format!(
        "Worktree clean-up report for {} (report only: nothing was removed)\n",
        roots.join(", ")
    ));
    out.push_str(&format!(
        "{} folders, {} measured. Remove: {} ({}). Free build output: {} ({}). Keep: {}.\n",
        report.entries.len(),
        human_bytes(report.total_bytes),
        report.remove_count,
        human_bytes(report.remove_bytes),
        report.free_count,
        human_bytes(report.free_bytes),
        report.keep_count
    ));
    out.push_str(&format!(
        "Build output held: {} in {}\n",
        human_bytes(report.build_output_bytes),
        plural(report.build_output_count as u64, "worktree", "worktrees")
    ));
    out.push_str(&format!(
        "Reclaimable with both taps: {}\n",
        human_bytes(report.remove_bytes + report.free_bytes)
    ));
    for note in &report.notes {
        out.push_str(&format!("Note: {note}\n"));
    }
    for (outcome, title) in [
        (
            Outcome::Remove,
            "REMOVE (merged and clean; branch and chats stay)",
        ),
        (
            Outcome::Free,
            "FREE BUILD OUTPUT (idle; the worktree stays)",
        ),
        (Outcome::Keep, "KEEP"),
    ] {
        let rows: Vec<&Entry> = report
            .entries
            .iter()
            .filter(|entry| entry.verdict.outcome == outcome)
            .collect();
        if rows.is_empty() {
            continue;
        }
        out.push_str(&format!("\n{title}: {}\n", rows.len()));
        for entry in rows {
            let size = entry
                .facts
                .total_bytes
                .map(human_bytes)
                .unwrap_or_else(|| "size unknown".into());
            let idle = entry
                .facts
                .last_activity
                .map(|at| format!("active {} ago", human_age(now.saturating_sub(at))))
                .unwrap_or_else(|| "activity unknown".into());
            let branch = entry
                .facts
                .branch
                .as_deref()
                .map(|branch| format!(" [{branch}]"))
                .unwrap_or_default();
            let output = match entry.facts.build_output_bytes() {
                0 => String::new(),
                bytes => format!(", build output {}", human_bytes(bytes)),
            };
            out.push_str(&format!(
                "  {}{branch}\n    {size}{output}, {idle}, {}: {}\n",
                pretty(&entry.facts.path),
                entry.verdict.state,
                entry.verdict.reason
            ));
        }
    }
    out
}

// ---- protections ----------------------------------------------------------------------------------------------------

#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    pid > 0
        && (unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

#[cfg(not(unix))]
fn pid_alive(_pid: i32) -> bool {
    false
}

/// Checkouts no clean-up may touch: the one this binary runs from, and every running dev copy's (its app runs from
/// that checkout's target/).
pub fn standard_protections() -> Vec<(PathBuf, String)> {
    let mut protected = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        let exe = exe.canonicalize().unwrap_or(exe);
        protected.push((
            exe,
            "The checkout this running app was built from".to_string(),
        ));
    }
    let Some(home) = dirs::home_dir() else {
        return protected;
    };
    let registry = home.join(".monocode-hub-dev").join("slots.json");
    let Some(slots) = std::fs::read(&registry)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return protected;
    };
    let Some(data) = dirs::data_dir() else {
        return protected;
    };
    if let Some(slots) = slots.get("slots").and_then(|slots| slots.as_object()) {
        for (slot, entry) in slots {
            let Some(worktree) = entry.get("worktree").and_then(|w| w.as_str()) else {
                continue;
            };
            let dir = data.join(format!("{}{slot}", crate::instance::DEV_IDENTIFIER_PREFIX));
            let running = crate::instance::read_running(&dir)
                .and_then(|record| record.get("pid").and_then(|pid| pid.as_i64()))
                .is_some_and(|pid| pid_alive(pid as i32));
            if running {
                let path = PathBuf::from(worktree);
                protected.push((
                    path.canonicalize().unwrap_or(path),
                    format!("Its dev copy (slot {slot}) is running"),
                ));
            }
        }
    }
    protected
}

/// The managed root: `~/Worktrees` (Ash, 9 Oct).
pub fn managed_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Worktrees"))
}

// ---- acting ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    /// Delete ignored build output of idle worktrees.
    Free,
    /// `git worktree remove` merged, clean worktrees.
    Remove,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanItem {
    pub path: String,
    /// The commit the report saw; a different one now skips the worktree.
    pub head: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    pub path: String,
    /// Free: the output was deleted. Remove: it passed the re-check and is ready for the app's removal.
    pub done: bool,
    pub freed_bytes: u64,
    pub message: String,
    /// Remove: the main checkout to remove it from.
    pub repo: Option<String>,
}

/// Delete one worktree's ignored build output, after checking each folder again. Links are never followed or removed.
pub fn free_build_output(worktree: &Path, facts: &Facts) -> Result<u64, String> {
    let root = worktree.canonicalize().map_err(|e| e.to_string())?;
    let mut freed = 0;
    for output in &facts.build_output {
        if output.linked || !output.ignored || !project_file::valid_relative_path(&output.path) {
            continue;
        }
        let path = root.join(&output.path);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        // The folder must really be inside this worktree (no linked parent on the way).
        let real = path.canonicalize().map_err(|e| e.to_string())?;
        if real != path || !real.starts_with(&root) {
            continue;
        }
        if !ignored_by_git(&root, &output.path) {
            continue;
        }
        // remove_dir_all unlinks symbolic links inside it without following them.
        std::fs::remove_dir_all(&path).map_err(|error| format!("{}: {error}", output.path))?;
        freed += output.bytes.unwrap_or(0);
    }
    Ok(freed)
}

/// Unlink the build-output links setup made (node_modules -> main checkout) that git doesn't ignore, so git sees a clean
/// worktree. Only the links; the main checkout's folder is untouched. Ignored links are left to `git worktree remove`,
/// which unlinks without following.
fn unlink_output_links(worktree: &Path, facts: &Facts) {
    let Ok(root) = worktree.canonicalize() else {
        return;
    };
    for output in facts
        .build_output
        .iter()
        .filter(|output| output.linked && !output.ignored)
    {
        if !project_file::valid_relative_path(&output.path) {
            continue;
        }
        let path = root.join(&output.path);
        if !is_symlink(&path) {
            continue;
        }
        // The link must really be inside this worktree, as in `free_build_output`: no linked folder on the way.
        let Some(parent) = path.parent() else {
            continue;
        };
        match parent.canonicalize() {
            Ok(real) if real == parent && real.starts_with(&root) => {
                let _ = std::fs::remove_file(&path);
            }
            _ => {}
        }
    }
}

fn chats_from_store(conn: &rusqlite::Connection) -> Vec<(PathBuf, u64, bool)> {
    let Ok(mut query) = conn.prepare(
        "SELECT COALESCE(NULLIF(s.worktree_cwd, ''), s.cwd), s.updated_at, f.session_id IS NOT NULL
         FROM sessions s LEFT JOIN in_flight_sessions f ON f.session_id = s.id
         WHERE s.worktree_removed = 0",
    ) else {
        return Vec::new();
    };
    let rows = query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, bool>(2)?,
        ))
    });
    let Ok(rows) = rows else {
        return Vec::new();
    };
    rows.flatten()
        .map(|(cwd, updated, in_flight)| {
            // Older rows may be in seconds.
            let updated = updated.max(0) as u64;
            let updated = if updated < 100_000_000_000 {
                updated * 1000
            } else {
                updated
            };
            (expand_home(&cwd), updated, in_flight)
        })
        .collect()
}

/// The candidates something is running in: an agent or a terminal (`process_in`, the app's live hosts), or a project
/// action that hasn't finished (a setup's install, a dev server) whose working folder is inside it.
fn busy_paths(
    paths: &[PathBuf],
    process_in: impl Fn(&Path) -> bool,
    runs: &[crate::project_actions::RunRecord],
) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|path| {
            process_in(path)
                || runs
                    .iter()
                    .any(|run| !run.finished() && contains_working_dir(path, Path::new(&run.cwd)))
        })
        .cloned()
        .collect()
}

pub(crate) fn app_context(
    app: &AppHandle,
    paths: &[PathBuf],
    check_pull_requests: bool,
    measure_total: bool,
) -> Result<Context, String> {
    let store = app.state::<crate::session_store::SessionStore>();
    let chats = {
        let conn = store.lock_conn()?;
        chats_from_store(&conn)
    };
    let agents = app.state::<crate::harness::HarnessHost>();
    let terminals = app.state::<crate::pty::PtyHost>();
    let runs = app.state::<crate::project_actions::ActionRuns>().list(None);
    let busy = busy_paths(
        paths,
        |path| agents.has_working_dir(path) || terminals.has_working_dir(path),
        &runs,
    );
    // WP-82: a leased slot is never cleaned up. Unreadable leases stop the report
    // rather than guessing that a slot is free.
    let mut protected = standard_protections();
    if let Ok(data_dir) = project_file::data_dir(app) {
        protected.extend(crate::worktree_pool::leased_protections(&data_dir)?);
    }
    Ok(Context {
        chats,
        busy,
        protected,
        check_pull_requests,
        data_dir: project_file::data_dir(app).ok(),
        measure_total,
        measure_build_output: true,
    })
}

/// The report for Settings > Worktrees: `~/Worktrees`, plus the selected project's own worktrees.
#[tauri::command(async)]
pub async fn worktree_janitor_report(
    app: AppHandle,
    project_cwd: Option<String>,
    check_pull_requests: Option<bool>,
) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<PathBuf> = managed_root()
            .filter(|root| root.is_dir())
            .into_iter()
            .collect();
        let extra: Vec<PathBuf> = project_cwd
            .map(|cwd| expand_home(&cwd))
            .and_then(|cwd| crate::worktrees::list(&cwd).ok())
            .map(|trees| {
                trees
                    .into_iter()
                    .filter(|tree| !tree.is_main)
                    .map(|tree| PathBuf::from(tree.path))
                    .collect()
            })
            .unwrap_or_default();
        let candidates: Vec<PathBuf> = discover(&roots, &extra)
            .into_iter()
            .map(|(path, _)| path.canonicalize().unwrap_or(path))
            .collect();
        let ctx = app_context(&app, &candidates, check_pull_requests.unwrap_or(true), true)?;
        Ok(report(&roots, &extra, &ctx, &Policy::default(), now_ms()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ash's tap. Every worktree is checked again right before anything is deleted; one that changed is skipped.
/// Free deletes the build output here. Remove re-checks (and unlinks setup's links, so the app's own removal check
/// sees a clean worktree): the app then removes each ready worktree through its usual path, which stops and detaches
/// its chats (src/app/App.tsx `onRemoveWorktree`) and deletes through [`worktree_janitor_remove`], checking it once more
/// in the same step as the delete.
#[tauri::command(async)]
pub async fn worktree_janitor_clean(
    app: AppHandle,
    tier: Tier,
    items: Vec<CleanItem>,
) -> Result<Vec<CleanResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        for item in items {
            let path = expand_home(&item.path);
            results.push(clean_one(&app, tier, &path, item.head.as_deref()));
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn clean_one(app: &AppHandle, tier: Tier, path: &Path, head: Option<&str>) -> CleanResult {
    let mut result = CleanResult {
        path: path_to_js(path),
        done: false,
        freed_bytes: 0,
        message: String::new(),
        repo: None,
    };
    let skip = |mut result: CleanResult, message: String| {
        result.message = message;
        result
    };
    // Held for the whole step: no agent or terminal can start here meanwhile.
    let _reservation = match crate::worktree_lifecycle::reserve_removal(path) {
        Ok(reservation) => reservation,
        Err(error) => return skip(result, error),
    };
    let ctx = match app_context(app, &[path.to_path_buf()], tier == Tier::Remove, false) {
        Ok(ctx) => ctx,
        Err(error) => return skip(result, error),
    };
    let facts = gather(path, Kind::Linked, &ctx);
    if head.is_some() && facts.head.as_deref() != head {
        return skip(result, "Its commit changed since the report; kept".into());
    }
    let verdict = verdict(&facts, &Policy::default(), now_ms());
    match tier {
        Tier::Free => {
            if verdict.outcome == Outcome::Keep || verdict.freeable_bytes == 0 {
                return skip(result, format!("Kept: {}", verdict.reason));
            }
            match free_build_output(path, &facts) {
                Ok(freed) => {
                    result.done = true;
                    result.freed_bytes = freed;
                    result.message = format!("Freed {}", human_bytes(freed));
                }
                Err(error) => result.message = error,
            }
        }
        Tier::Remove => {
            if verdict.outcome != Outcome::Remove {
                return skip(result, format!("Kept: {}", verdict.reason));
            }
            let Some(repo) = facts.repo.clone() else {
                return skip(result, "Its repository is unknown; kept".into());
            };
            unlink_output_links(path, &facts);
            result.done = true;
            result.freed_bytes = verdict.reclaim_bytes;
            result.repo = Some(repo);
            result.message = "Checked again: ready to remove".into();
        }
    }
    result
}

/// Remove one worktree the report found ready, if it still is: the same re-check as the tap's (its commit unchanged, the
/// verdict still Remove), then setup's links unlinked and the worktree removed with its chats detached so they keep
/// their history (worktrees.rs `remove_with_sessions`, `git worktree remove` without --force; the branch stays). The
/// caller holds the removal reservation from before the re-check to after the delete.
pub(crate) fn remove_if_still_ready(
    conn: &rusqlite::Connection,
    path: &Path,
    head: Option<&str>,
    ctx: &Context,
    now: u64,
) -> Result<crate::worktrees::WorktreeRemoval, String> {
    let facts = gather(path, Kind::Linked, ctx);
    if head.is_some() && facts.head.as_deref() != head {
        return Err("Its commit changed since the report; kept".into());
    }
    let verdict = verdict(&facts, &Policy::default(), now);
    if verdict.outcome != Outcome::Remove {
        return Err(format!("Kept: {}", verdict.reason));
    }
    let repo = facts
        .repo
        .clone()
        .ok_or("Its repository is unknown; kept")?;
    unlink_output_links(path, &facts);
    crate::worktrees::remove_with_sessions(conn, Path::new(&repo), path, false, true)
}

/// Remove after Ash's tap, through the app's usual removal (src/features/source-control/model/worktrees.ts
/// `removeWorktree`, which stops and detaches the worktree's chats first): the re-check and the delete happen in one
/// step under the removal reservation, so nothing can start or change in the worktree between them.
#[tauri::command(async)]
pub async fn worktree_janitor_remove(
    app: AppHandle,
    path: String,
    head: Option<String>,
) -> Result<crate::worktrees::WorktreeRemoval, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = expand_home(&path);
        let _reservation = crate::worktree_lifecycle::reserve_removal(&path)?;
        let ctx = app_context(&app, std::slice::from_ref(&path), true, false)?;
        let store = app.state::<crate::session_store::SessionStore>();
        let conn = store.lock_conn()?;
        remove_if_still_ready(&conn, &path, head.as_deref(), &ctx, now_ms())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- the command line -----------------------------------------------------------------------------------------------

/// `monocode worktrees-report [--root PATH]... [--json] [--no-pr]`: the clean-up report with no window and no app
/// data. It only reads; there is no command-line way to remove anything.
pub fn report_main(args: &[String]) -> i32 {
    let mut roots = Vec::new();
    let mut json_out = false;
    let mut check_pull_requests = true;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--root" => match iter.next() {
                Some(path) => roots.push(expand_home(path)),
                None => {
                    eprintln!("monocode worktrees-report: --root needs a path");
                    return 2;
                }
            },
            "--json" => json_out = true,
            "--no-pr" => check_pull_requests = false,
            other => {
                eprintln!(
                    "monocode worktrees-report: unknown argument {other}\nusage: monocode worktrees-report [--root PATH]... [--json] [--no-pr]"
                );
                return 2;
            }
        }
    }
    if roots.is_empty() {
        roots.extend(managed_root());
    }
    let ctx = Context {
        protected: standard_protections(),
        check_pull_requests,
        measure_total: true,
        measure_build_output: true,
        ..Context::default()
    };
    let now = now_ms();
    let mut report = report(&roots, &[], &ctx, &Policy::default(), now);
    report
        .notes
        .push("Chats and running agents weren't checked from the command line; the app checks both before it acts.".into());
    if json_out {
        match serde_json::to_string_pretty(&report) {
            Ok(text) => println!("{text}"),
            Err(error) => {
                eprintln!("{error}");
                return 1;
            }
        }
    } else {
        print!("{}", render_text(&report, now));
    }
    0
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

    #[test]
    fn treehouse_state_is_not_listed_as_a_worktree() {
        let temp = temp("monocode-janitor-treehouse");
        let root = temp.0.join("Worktrees");
        std::fs::create_dir_all(root.join(".treehouse")).unwrap();
        std::fs::write(root.join(".treehouse").join("slots.json"), b"{}").unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let found = discover(&[root], &[]);
        assert!(found.iter().all(|(path, _)| {
            path.file_name().and_then(|name| name.to_str()) != Some(".treehouse")
        }));
        assert!(found
            .iter()
            .any(|(path, kind)| path.ends_with("notes") && *kind == Kind::NotGit));
    }

    /// A clean, merged, idle linked worktree: the remove case. Each test changes one thing.
    fn merged() -> Facts {
        let mut facts = Facts::new(Path::new("/w/feature"), Kind::Linked);
        facts.repo = Some("/repo".into());
        facts.registered = true;
        facts.branch = Some("feature".into());
        facts.head = Some("abc".into());
        facts.default_ref = Some("origin/main".into());
        facts.ahead = Some(0);
        facts.never_committed = Some(false);
        facts.unpushed = Some(0);
        facts.last_activity = Some(NOW - 5 * DAY_MS);
        facts.total_bytes = Some(900_000_000);
        facts.build_output = vec![
            BuildOutput {
                path: "target".into(),
                bytes: Some(800_000_000),
                linked: false,
                ignored: true,
            },
            BuildOutput {
                path: "node_modules".into(),
                bytes: Some(0),
                linked: true,
                ignored: false,
            },
        ];
        facts
    }

    fn judge(facts: &Facts) -> Verdict {
        verdict(facts, &Policy::default(), NOW)
    }

    #[test]
    fn a_merged_clean_idle_worktree_can_be_removed() {
        let v = judge(&merged());
        assert_eq!(v.outcome, Outcome::Remove);
        assert_eq!(v.state, "merged");
        assert!(
            v.reason
                .starts_with("Merged into origin/main; clean; idle 5 days"),
            "{}",
            v.reason
        );
        assert!(v.reason.contains("branch and its chats stay"));
        assert_eq!(v.reclaim_bytes, 900_000_000);
        assert_eq!(
            v.freeable_bytes, 800_000_000,
            "a linked node_modules frees nothing"
        );
    }

    #[test]
    fn unchanged_and_squash_merged_branches_count_as_merged() {
        let mut unchanged = merged();
        unchanged.never_committed = Some(true);
        let v = judge(&unchanged);
        assert_eq!((v.outcome, v.state), (Outcome::Remove, "unchanged"));
        assert!(v.reason.contains("No commits beyond origin/main"));

        // T3: a squash merge leaves the head outside main; the merged PR must name this exact commit.
        let mut squashed = merged();
        squashed.ahead = Some(3);
        squashed.merged_pr = Some(42);
        let v = judge(&squashed);
        assert_eq!((v.outcome, v.state), (Outcome::Remove, "pr-merged"));
        assert!(v.reason.contains("#42"));

        let mut open = merged();
        open.ahead = Some(3);
        open.unpushed = Some(1);
        open.last_activity = Some(NOW - 10 * DAY_MS);
        let v = judge(&open);
        assert_eq!((v.outcome, v.state), (Outcome::Free, "ahead"));
        assert!(
            v.reason
                .contains("3 commits not on origin/main, 1 not pushed"),
            "{}",
            v.reason
        );
        assert!(v.reason.contains("target/ 800 MB"), "{}", v.reason);
    }

    #[test]
    fn local_work_keeps_the_worktree_but_not_its_build_output() {
        // T3 localChangesReason: uncommitted, untracked, then ignored files that aren't build output.
        for (change, expected) in [
            (
                Box::new(|f: &mut Facts| f.tracked_changes = 2) as Box<dyn Fn(&mut Facts)>,
                "uncommitted changes (2 files)",
            ),
            (
                Box::new(|f: &mut Facts| f.untracked = 1),
                "untracked files (1 entry)",
            ),
            (
                Box::new(|f: &mut Facts| f.local_ignored = Some("notes.local".into())),
                "ignored files that aren't build output (notes.local)",
            ),
            (
                Box::new(|f: &mut Facts| f.status_error = Some("index.lock exists".into())),
                "git status failed",
            ),
        ] {
            let mut facts = merged();
            change(&mut facts);
            let v = judge(&facts);
            assert_eq!(v.outcome, Outcome::Free, "{expected}");
            assert_eq!(v.state, "dirty");
            assert!(v.reason.contains(expected), "{}", v.reason);
            assert_eq!(v.reclaim_bytes, 800_000_000);
        }
    }

    #[test]
    fn activity_holds_both_taps() {
        let mut fresh = merged();
        fresh.last_activity = Some(NOW - 2 * HOUR_MS);
        let v = judge(&fresh);
        assert_eq!(v.outcome, Outcome::Keep);
        assert!(v.reason.contains("active 2 hours ago"), "{}", v.reason);
        assert!(v.reason.contains("once it is idle 3 days"), "{}", v.reason);

        // Removable after a day, but build output alone waits for three.
        let mut ahead = merged();
        ahead.ahead = Some(1);
        ahead.last_activity = Some(NOW - 2 * DAY_MS);
        assert_eq!(judge(&ahead).outcome, Outcome::Keep);

        let mut unknown = merged();
        unknown.last_activity = None;
        let v = judge(&unknown);
        assert_eq!(v.outcome, Outcome::Keep);
        assert!(v.reason.contains("last activity unknown"));
    }

    #[test]
    fn running_work_and_protected_checkouts_are_never_touched() {
        type Change = Box<dyn Fn(&mut Facts)>;
        let cases: Vec<(Change, &str, &str)> = vec![
            (
                Box::new(|f| {
                    f.protected = Some("The checkout this running app was built from".into())
                }),
                "protected",
                "built from",
            ),
            (
                Box::new(|f| f.process_running = true),
                "busy",
                "terminal or project action",
            ),
            (Box::new(|f| f.chat_running = true), "busy", "chat in it"),
            (Box::new(|f| f.locked = true), "locked", "Locked"),
            (
                Box::new(|f| f.registered = false),
                "unregistered",
                "doesn't list it",
            ),
            (Box::new(|f| f.kind = Kind::Main), "main", "main checkout"),
            (
                Box::new(|f| f.kind = Kind::Symlink),
                "link",
                "never followed",
            ),
            (
                Box::new(|f| f.kind = Kind::FullClone),
                "clone",
                "full clone",
            ),
            (Box::new(|f| f.kind = Kind::Missing), "missing", "gone"),
            (
                Box::new(|f| {
                    f.kind = Kind::Broken;
                    f.detail = Some("not a git repository".into());
                }),
                "broken",
                "not a git repository",
            ),
            (
                Box::new(|f| {
                    f.kind = Kind::NotGit;
                    f.total_bytes = Some(0);
                }),
                "other",
                "empty folder",
            ),
        ];
        for (change, state, text) in cases {
            let mut facts = merged();
            change(&mut facts);
            let v = judge(&facts);
            assert_eq!(v.outcome, Outcome::Keep, "{state}");
            assert_eq!(v.state, state);
            assert!(v.reason.contains(text), "{state}: {}", v.reason);
            assert_eq!((v.freeable_bytes, v.reclaim_bytes), (0, 0));
        }
    }

    #[test]
    fn a_detached_or_unknown_branch_is_kept() {
        let mut detached = merged();
        detached.branch = None;
        detached.ahead = Some(2);
        detached.build_output.clear();
        let v = judge(&detached);
        assert_eq!((v.outcome, v.state), (Outcome::Keep, "detached"));
        assert!(v.reason.contains("no branch keeps its commits"));

        let mut unknown = merged();
        unknown.ahead = None;
        unknown.default_ref = None;
        unknown.build_output.clear();
        let v = judge(&unknown);
        assert_eq!((v.outcome, v.state), (Outcome::Keep, "unknown"));
        assert!(v.reason.contains("default branch is unknown"));

        // A small build output isn't worth a line.
        let mut small = merged();
        small.ahead = Some(1);
        small.build_output[0].bytes = Some(1_000);
        assert_eq!(judge(&small).outcome, Outcome::Keep);
        // Output git doesn't ignore is never freed.
        let mut tracked = merged();
        tracked.ahead = Some(1);
        tracked.build_output[0].ignored = false;
        assert_eq!(judge(&tracked).outcome, Outcome::Keep);
    }

    #[test]
    fn status_parsing_skips_linked_build_output_and_counts_renames_once() {
        let temp = temp("monocode-janitor-status");
        std::fs::create_dir_all(temp.0.join("real")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(temp.0.join("real"), temp.0.join("node_modules")).unwrap();
        let outputs = vec!["node_modules".to_string()];
        let text = " M a.txt\0R  new.txt\0old.txt\0?? node_modules\0?? scratch/\0";
        let (tracked, untracked) = parse_status(text, &temp.0, &outputs);
        assert_eq!(tracked, 2);
        assert_eq!(untracked, if cfg!(unix) { 1 } else { 2 });
        assert_eq!(
            first_local_ignored(
                "node_modules/\0target/\0.DS_Store\0x.tsbuildinfo\0src-tauri/gen/\0src-tauri/gen/schemas/\0src-tauri/general.txt\0notes.txt\0",
                &temp.0,
                &outputs,
                &[]
            ),
            Some("src-tauri/general.txt".into())
        );
        assert_eq!(
            first_local_ignored("app/node_modules/\0dist/\0", &temp.0, &outputs, &[]),
            None
        );
        // A project file can name more regenerable files (its imported worktrees.regenerable).
        let extra = vec![".identity-baseline.json".to_string()];
        assert_eq!(
            first_local_ignored(".identity-baseline.json\0", &temp.0, &outputs, &[]),
            Some(".identity-baseline.json".into())
        );
        assert_eq!(
            first_local_ignored(".identity-baseline.json\0", &temp.0, &outputs, &extra),
            None
        );
    }

    #[cfg(unix)]
    fn git_commit_file(root: &Path, name: &str, text: &str) {
        std::fs::write(root.join(name), text).unwrap();
        git_checked(root, &["add", name]).unwrap();
        commit(root, name);
    }

    /// The real thing in a temporary repository: facts from git, the verdicts, and both taps' file effects.
    #[cfg(unix)]
    #[test]
    fn gathers_real_facts_and_frees_only_ignored_output_without_following_links() {
        let temp = temp("monocode-janitor-repo");
        let main = repo(&temp.0);
        std::fs::write(main.join(".gitignore"), "target/\nnode_modules\n.env\n").unwrap();
        git_checked(&main, &["add", ".gitignore"]).unwrap();
        commit(&main, "ignore build output");
        // The main checkout's node_modules, which worktrees link to. It must survive everything.
        std::fs::create_dir_all(main.join("node_modules/pkg")).unwrap();
        std::fs::write(main.join("node_modules/pkg/index.js"), "keep me").unwrap();
        std::fs::write(main.join(".env"), "SECRET=1").unwrap();

        let root = temp.0.join("Worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let add = |name: &str| {
            let path = root.join(name);
            git_checked(
                &main,
                &["worktree", "add", "-b", name, path.to_str().unwrap()],
            )
            .unwrap();
            path
        };
        let merged_tree = add("merged");
        git_commit_file(&merged_tree, "feature.txt", "done");
        git_checked(&main, &["merge", "--ff-only", "merged"]).unwrap();
        let ahead_tree = add("ahead");
        git_commit_file(&ahead_tree, "wip.txt", "wip");
        let dirty_tree = add("dirty");
        std::fs::write(dirty_tree.join("notes.txt"), "mine").unwrap();
        let fresh_tree = add("fresh");
        for tree in [&merged_tree, &ahead_tree, &dirty_tree, &fresh_tree] {
            std::fs::create_dir_all(tree.join("target/debug")).unwrap();
            std::fs::write(tree.join("target/debug/big.bin"), vec![7u8; 200_000]).unwrap();
            // A link inside build output pointing out of the worktree: deleting must not follow it.
            std::os::unix::fs::symlink(main.join("node_modules"), tree.join("target/debug/escape"))
                .unwrap();
            std::os::unix::fs::symlink(main.join("node_modules"), tree.join("node_modules"))
                .unwrap();
            std::os::unix::fs::symlink(main.join(".env"), tree.join(".env")).unwrap();
        }
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::os::unix::fs::symlink(&main, root.join("link-to-main")).unwrap();

        let ctx = Context {
            measure_total: true,
            measure_build_output: true,
            ..Context::default()
        };
        let policy = Policy {
            min_free_bytes: 1,
            ..Policy::default()
        };
        // Everything looks idle a week from now.
        let later = now_ms() + 7 * DAY_MS;
        let report = report(std::slice::from_ref(&root), &[], &ctx, &policy, later);
        let find = |name: &str| {
            report
                .entries
                .iter()
                .find(|entry| entry.facts.path.ends_with(&format!("/{name}")))
                .unwrap_or_else(|| panic!("{name} missing from {report:#?}"))
        };
        let merged_entry = find("merged");
        assert_eq!(merged_entry.facts.ahead, Some(0));
        assert_eq!(merged_entry.facts.never_committed, Some(false));
        assert_eq!(
            merged_entry.facts.untracked, 0,
            "linked node_modules and .env hold no work"
        );
        assert_eq!(
            merged_entry.verdict.outcome,
            Outcome::Remove,
            "{:?}",
            merged_entry.verdict
        );
        assert_eq!(find("fresh").verdict.state, "unchanged");
        let ahead = find("ahead");
        assert_eq!(
            (ahead.facts.ahead, ahead.verdict.outcome),
            (Some(1), Outcome::Free)
        );
        let dirty = find("dirty");
        assert_eq!(
            (dirty.facts.untracked, dirty.verdict.outcome),
            (1, Outcome::Free)
        );
        let target = ahead
            .facts
            .build_output
            .iter()
            .find(|o| o.path == "target")
            .unwrap();
        assert!(target.ignored && !target.linked && target.bytes.unwrap() >= 200_000);
        let modules = ahead
            .facts
            .build_output
            .iter()
            .find(|o| o.path == "node_modules")
            .unwrap();
        assert!(modules.linked);
        assert_eq!(find("empty").verdict.state, "other");
        assert_eq!(find("link-to-main").verdict.state, "link");
        assert_eq!(report.remove_count, 2);

        // Protected: the checkout a running app was built from.
        let protected_ctx = Context {
            protected: vec![(
                ahead_tree.canonicalize().unwrap().join("target/debug/app"),
                "running".into(),
            )],
            ..Context::default()
        };
        assert_eq!(
            verdict(
                &gather(&ahead_tree, Kind::Linked, &protected_ctx),
                &policy,
                later
            )
            .state,
            "protected"
        );

        // Tier 1 on the dirty one: target/ goes, notes.txt, the links and the main checkout's files stay.
        let freed = free_build_output(&dirty_tree, &dirty.facts).unwrap();
        assert!(freed >= 200_000);
        assert!(!dirty_tree.join("target").exists());
        assert!(dirty_tree.join("notes.txt").exists());
        assert!(is_symlink(&dirty_tree.join("node_modules")));
        assert_eq!(
            std::fs::read_to_string(main.join("node_modules/pkg/index.js")).unwrap(),
            "keep me"
        );
        assert_eq!(
            std::fs::read_to_string(main.join(".env")).unwrap(),
            "SECRET=1"
        );

        // Tier 2 on the merged one, as the app does it: unlink setup's links git doesn't ignore (none here), then git
        // worktree remove without --force, which must unlink the ignored node_modules and .env links, not follow them.
        unlink_output_links(&merged_tree, &merged_entry.facts);
        assert!(
            is_symlink(&merged_tree.join("node_modules")),
            "an ignored link is left to git"
        );
        crate::worktrees::remove(&main, &merged_tree, false).unwrap();
        assert!(!merged_tree.exists());
        assert!(
            git_text(&main, &["rev-parse", "--verify", "refs/heads/merged"]).is_ok(),
            "the branch stays"
        );
        assert_eq!(
            std::fs::read_to_string(main.join("node_modules/pkg/index.js")).unwrap(),
            "keep me"
        );
        assert_eq!(
            std::fs::read_to_string(main.join(".env")).unwrap(),
            "SECRET=1"
        );
        let text = render_text(&report, later);
        assert!(text.contains("nothing was removed"));
        assert!(text.contains("REMOVE"));
        // The report says how much build output each worktree holds, and the total.
        assert_eq!(report.build_output_count, 4);
        assert!(report.build_output_bytes >= 4 * 200_000);
        assert_eq!(
            report.build_output_bytes,
            report
                .entries
                .iter()
                .map(|entry| entry.facts.build_output_bytes())
                .sum::<u64>()
        );
        assert!(ahead.facts.build_output_bytes() >= 200_000);
        assert!(text.contains("Build output held:"), "{text}");
        assert!(text.contains(", build output "), "{text}");
    }

    /// The tap's removal re-checks the worktree it deletes, in the same step: work that landed after the report (a new
    /// commit, a chat that started) keeps it.
    #[cfg(unix)]
    #[test]
    fn removal_rechecks_the_worktree_it_deletes() {
        let temp = temp("monocode-janitor-recheck");
        let main = repo(&temp.0);
        let tree = temp.0.join("merged");
        git_checked(
            &main,
            &["worktree", "add", "-b", "merged", tree.to_str().unwrap()],
        )
        .unwrap();
        git_commit_file(&tree, "feature.txt", "done");
        git_checked(&main, &["merge", "--ff-only", "merged"]).unwrap();
        let later = now_ms() + 7 * DAY_MS;
        let quiet = Context::default();
        let reported = gather(&tree, Kind::Linked, &quiet);
        assert_eq!(
            verdict(&reported, &Policy::default(), later).outcome,
            Outcome::Remove
        );
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();

        // After the report, work lands in it: a commit the mainline doesn't have.
        git_commit_file(&tree, "more.txt", "more");
        let Err(err) = remove_if_still_ready(
            &store.lock_conn().unwrap(),
            &tree,
            reported.head.as_deref(),
            &quiet,
            later,
        ) else {
            panic!("removed a worktree with new work in it")
        };
        assert!(err.contains("changed"), "{err}");
        assert!(tree.join("more.txt").exists());

        // Merged again, but a chat is running in it now.
        git_checked(&main, &["merge", "--ff-only", "merged"]).unwrap();
        let head = gather(&tree, Kind::Linked, &quiet).head;
        let chatting = Context {
            chats: vec![(tree.canonicalize().unwrap(), now_ms(), true)],
            ..Context::default()
        };
        let Err(err) = remove_if_still_ready(
            &store.lock_conn().unwrap(),
            &tree,
            head.as_deref(),
            &chatting,
            later,
        ) else {
            panic!("removed a worktree with a chat running in it")
        };
        assert!(err.contains("Kept"), "{err}");
        assert!(tree.exists());

        // Still ready: removed, the branch kept.
        assert!(remove_if_still_ready(
            &store.lock_conn().unwrap(),
            &tree,
            head.as_deref(),
            &quiet,
            later,
        )
        .is_ok());
        assert!(!tree.exists());
        assert!(git_text(&main, &["rev-parse", "--verify", "refs/heads/merged"]).is_ok());
    }

    /// Only links really inside the worktree are unlinked: never one reached through a linked folder, nor a path that
    /// climbs out.
    #[cfg(unix)]
    #[test]
    fn unlinking_setups_links_stays_inside_the_worktree() {
        let temp = temp("monocode-janitor-unlink");
        let tree = temp.0.join("tree");
        let outside = temp.0.join("outside");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::create_dir_all(outside.join("real")).unwrap();
        // Someone else's links, outside the worktree.
        std::os::unix::fs::symlink(outside.join("real"), outside.join("node_modules")).unwrap();
        std::os::unix::fs::symlink(outside.join("real"), temp.0.join("node_modules")).unwrap();
        // The worktree reaches them through a linked folder, or a path that climbs out.
        std::os::unix::fs::symlink(&outside, tree.join("vendor")).unwrap();
        // And its own link from setup, which may go.
        std::os::unix::fs::symlink(outside.join("real"), tree.join("node_modules")).unwrap();
        let mut facts = Facts::new(&tree, Kind::Linked);
        facts.build_output = ["vendor/node_modules", "../node_modules", "node_modules"]
            .into_iter()
            .map(|path| BuildOutput {
                path: path.into(),
                bytes: None,
                linked: true,
                ignored: false,
            })
            .collect();
        unlink_output_links(&tree, &facts);
        assert!(
            is_symlink(&outside.join("node_modules")),
            "reached through a linked folder"
        );
        assert!(
            is_symlink(&temp.0.join("node_modules")),
            "a path that climbs out"
        );
        assert!(!is_symlink(&tree.join("node_modules")), "its own link goes");
        assert!(outside.join("real").is_dir());
    }

    /// A project action still running in a worktree (its setup's npm ci, a dev server Ash started) makes it busy, like
    /// an agent or a terminal: never removed or freed under it.
    #[test]
    fn a_running_project_action_makes_its_worktree_busy() {
        use crate::project_actions::{RunRecord, RunStatus};
        let temp = temp("monocode-janitor-actions");
        let (tree, other) = (temp.0.join("tree"), temp.0.join("other"));
        std::fs::create_dir_all(tree.join("app")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let run = |cwd: &Path, status: RunStatus| RunRecord {
            id: "r1".into(),
            project_root: "/repo".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            action_id: "setup".into(),
            action_name: "Setup".into(),
            command: "npm ci".into(),
            trigger: "worktree-create".into(),
            status,
            exit_code: None,
            started_at: 1,
            ended_at: None,
            log_path: "/tmp/log".into(),
            tail: vec![],
            long_running: false,
            error: None,
        };
        let paths = vec![tree.clone(), other.clone()];
        let idle = |_: &Path| false;
        assert_eq!(
            busy_paths(&paths, idle, &[run(&tree.join("app"), RunStatus::Running)]),
            vec![tree.clone()]
        );
        assert!(busy_paths(&paths, idle, &[run(&tree, RunStatus::Succeeded)]).is_empty());
        // And the verdict keeps it.
        let ctx = Context {
            busy: busy_paths(&paths, idle, &[run(&tree, RunStatus::Running)]),
            ..Context::default()
        };
        let mut facts = merged();
        facts.process_running = ctx.busy.iter().any(|b| contains_working_dir(&tree, b));
        assert_eq!(
            verdict(&facts, &Policy::default(), NOW).outcome,
            Outcome::Keep
        );
    }

    /// "Merged" means on the repository's real mainline. Here `origin/HEAD` still points at an old `hub-frontend`
    /// while work lands on `pm/pages-live`, the branch the main checkout has checked out (this repository's case).
    #[cfg(unix)]
    #[test]
    fn merged_means_on_the_real_mainline_not_an_old_remote_default() {
        let temp = temp("monocode-janitor-mainline");
        let main = repo(&temp.0);
        let initial = git_text(&main, &["rev-parse", "HEAD"]).unwrap();
        let initial = initial.trim();
        git_checked(
            &main,
            &["update-ref", "refs/remotes/origin/hub-frontend", initial],
        )
        .unwrap();
        git_checked(
            &main,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/hub-frontend",
            ],
        )
        .unwrap();
        git_checked(&main, &["checkout", "-q", "-b", "pm/pages-live"]).unwrap();
        let root = temp.0.join("Worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let add = |name: &str| {
            let path = root.join(name);
            git_checked(
                &main,
                &["worktree", "add", "-q", "-b", name, path.to_str().unwrap()],
            )
            .unwrap();
            path
        };
        let landed = add("landed");
        git_commit_file(&landed, "landed.txt", "done");
        git_checked(&main, &["merge", "-q", "--ff-only", "landed"]).unwrap();
        let open = add("open");
        git_commit_file(&open, "open.txt", "wip");
        // What the janitor used to compare against: the landed work is not on the old remote default.
        assert_eq!(
            git_text(
                &main,
                &["rev-list", "--count", "origin/hub-frontend..landed"]
            )
            .unwrap()
            .trim(),
            "1"
        );

        let ctx = Context::default();
        let policy = Policy::default();
        let later = now_ms() + 7 * DAY_MS;
        let entry = |report: &Report, name: &str| {
            report
                .entries
                .iter()
                .find(|entry| entry.facts.path.ends_with(&format!("/{name}")))
                .unwrap_or_else(|| panic!("{name} missing from {report:#?}"))
                .clone()
        };
        let scan = report(std::slice::from_ref(&root), &[], &ctx, &policy, later);
        let merged = entry(&scan, "landed");
        assert_eq!(merged.facts.default_ref.as_deref(), Some("pm/pages-live"));
        assert_eq!(merged.facts.ahead, Some(0));
        assert_eq!(merged.verdict.state, "merged", "{:?}", merged.verdict);
        assert_eq!(merged.verdict.outcome, Outcome::Remove);
        assert!(
            merged.verdict.reason.contains("pm/pages-live"),
            "{}",
            merged.verdict.reason
        );
        let unmerged = entry(&scan, "open");
        assert_eq!(unmerged.facts.ahead, Some(1));
        assert_ne!(unmerged.verdict.outcome, Outcome::Remove);

        // The project file can name the mainline; a name that isn't a branch falls through to the checkout's.
        git_checked(&main, &["branch", "release", initial]).unwrap();
        git_checked(
            &main,
            &["update-ref", "refs/remotes/origin/staging", initial],
        )
        .unwrap();
        let line = |reference: &str, branch: &str| {
            Some(Mainline {
                reference: reference.into(),
                branch: branch.into(),
            })
        };
        assert_eq!(mainline(&main, Some("release")), line("release", "release"));
        assert_eq!(
            mainline(&main, Some("staging")),
            line("origin/staging", "staging")
        );
        assert_eq!(
            mainline(&main, Some("missing")),
            line("pm/pages-live", "pm/pages-live")
        );
        assert_eq!(
            mainline(&main, Some("--evil")),
            line("pm/pages-live", "pm/pages-live")
        );
        assert_eq!(
            mainline(&main, None),
            line("pm/pages-live", "pm/pages-live")
        );

        // An imported project file's mainBranch is what the report uses.
        let data = temp.0.join("data");
        std::fs::create_dir_all(main.join(".monocode")).unwrap();
        std::fs::write(
            main.join(".monocode/project.json"),
            r#"{"version":1,"mainBranch":"release"}"#,
        )
        .unwrap();
        let reviewed = project_file::status(&data, &main).file_hash.unwrap();
        project_file::import(&data, &main, &reviewed).unwrap();
        let named_ctx = Context {
            data_dir: Some(data),
            ..Context::default()
        };
        let named = report(std::slice::from_ref(&root), &[], &named_ctx, &policy, later);
        let against_release = entry(&named, "landed");
        assert_eq!(
            against_release.facts.default_ref.as_deref(),
            Some("release")
        );
        assert_eq!(against_release.facts.ahead, Some(1));
        assert_ne!(against_release.verdict.outcome, Outcome::Remove);

        // A detached main checkout and no project file: the remote's default, as before.
        git_checked(&main, &["checkout", "-q", "--detach"]).unwrap();
        assert_eq!(
            mainline(&main, None),
            line("origin/hub-frontend", "hub-frontend")
        );
    }

    #[cfg(unix)]
    #[test]
    fn measuring_counts_a_hard_linked_file_once_and_never_follows_links() {
        let temp = temp("monocode-janitor-measure");
        let dir = temp.0.join("target");
        std::fs::create_dir_all(dir.join("deps")).unwrap();
        std::fs::write(dir.join("deps/app-123"), vec![1u8; 100_000]).unwrap();
        std::fs::hard_link(dir.join("deps/app-123"), dir.join("app")).unwrap();
        let outside = temp.0.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("big"), vec![1u8; 500_000]).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        let once = measure(&dir, &[], Instant::now() + MEASURE_LIMIT, &mut Seen::new()).unwrap();
        let file = measure(
            &dir.join("app"),
            &[],
            Instant::now() + MEASURE_LIMIT,
            &mut Seen::new(),
        )
        .unwrap();
        assert!(file >= 100_000);
        assert_eq!(
            once, file,
            "one copy of the hard-linked file, nothing behind the link"
        );
    }

    #[test]
    fn human_units() {
        assert_eq!(human_bytes(999), "999 B");
        assert_eq!(human_bytes(1_500_000), "1.5 MB");
        assert_eq!(human_bytes(43_200_000_000), "43.2 GB");
        assert_eq!(human_bytes(250_000_000_000), "250 GB");
        assert_eq!(human_age(5 * 60_000), "5 min");
        assert_eq!(human_age(HOUR_MS), "1 hour");
        assert_eq!(human_age(30 * HOUR_MS), "30 hours");
        assert_eq!(human_age(9 * DAY_MS), "9 days");
    }
}

/// Review r5 repro for PR #208 (WP-178). Red at a5bc60a97.
#[cfg(test)]
mod review_r5_repro {
    /// HIGH (H-E still open): round 5 moved the PR watch's and the Git panel's `gh` into `contained_command`, but the
    /// worktree sweep (worktree_autoclean, every 15 minutes and 2 minutes after launch, no tap) still runs
    /// `Command::new("gh")` plain, with the cached GUI PATH, in a worktree an agent wrote. Whatever `gh` that PATH finds
    /// first, and whatever it loads, runs outside the sandbox. The seam is `contained_command`; a unit test cannot see the
    /// container (`contain_now` is plain in tests), so this reads the function.
    #[test]
    fn the_sweeps_gh_pr_list_runs_contained() {
        let source = include_str!("worktree_janitor.rs");
        let start = source
            .find("pub fn gh_prs_for_branch(")
            .expect("gh_prs_for_branch");
        let body = &source[start..start + 400];
        assert!(
            body.contains("contained_command"),
            "the sweep's gh pr list starts outside the sandbox: {}",
            body.lines().nth(1).unwrap_or("")
        );
    }
}
