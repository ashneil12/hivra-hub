//! Hivra WP-10: "a first mate never edits the project", checked after every first-mate turn on every CLI.
//!
//! Some CLIs can run a first mate read-only (readOnly.ts); the rest can't. So for every CLI the app snapshots the
//! project's main checkout when a first-mate turn starts and compares when it ends. A change that no landing explains (a
//! worker's finished work the app put into the project during that turn, land.rs) flags the turn, and the change is
//! offered for revert.
//!
//! - **Snapshot**: HEAD and, for each path `git status` lists (untracked included, ignored files not), a fingerprint of
//!   its status and its content. Nothing is written.
//! - **Check**: the paths whose fingerprint moved, plus the files of any commit made since, minus the files landed into
//!   that project during the turn.
//! - **Revert** is offered only for a path that was clean when the turn started and only undoes the turn's own change:
//!   back to the content at the turn's starting HEAD, or removed if it didn't exist then. A path that already had the
//!   person's own uncommitted edits is never reverted (that would lose them), and commits are never rewritten; those are
//!   listed for the person to decide. The flag records each path's fingerprint as the turn left it, and a revert skips a
//!   path that has changed since (the person, or a later turn, edited it after the flag): only the turn's own change is
//!   ever undone.
//!
//! Plain `git` processes, no shell, so it runs the same on Windows.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// One file the app landed into a project, kept so the check can tell a landing from a first mate's own edit.
#[derive(Clone, Debug)]
struct LandedFile {
    project: PathBuf,
    path: String,
    at: i64,
}

static LANDED: Mutex<Vec<LandedFile>> = Mutex::new(Vec::new());
const LANDED_MAX: usize = 2_000;

fn now_millis() -> i64 {
    crate::session_store::now_millis()
}

fn canonical(dir: &Path) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
}

/// land.rs: a worker's files went into `project` just now.
pub fn note_landing(project: &Path, files: &[String]) {
    note_landing_at(project, files, now_millis());
}

fn note_landing_at(project: &Path, files: &[String], at: i64) {
    let project = canonical(project);
    let mut landed = LANDED.lock().unwrap_or_else(|p| p.into_inner());
    landed.extend(files.iter().map(|path| LandedFile {
        project: project.clone(),
        path: path.clone(),
        at,
    }));
    if landed.len() > LANDED_MAX {
        let extra = landed.len() - LANDED_MAX;
        landed.drain(..extra);
    }
}

fn landed_since(project: &Path, since: i64) -> BTreeSet<String> {
    let project = canonical(project);
    LANDED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|f| f.project == project && f.at >= since)
        .map(|f| f.path.clone())
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub dir: String,
    pub head: Option<String>,
    /// Each listed path's status and content fingerprint.
    pub dirty: BTreeMap<String, String>,
    pub taken_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPath {
    pub path: String,
    /// It can be put back as the turn found it (see the module docs).
    pub revertable: bool,
    /// Why not, when it can't.
    pub why_not: Option<String>,
    /// Its status and content as the turn left it (none when it is clean or gone from `git status`). A revert refuses a
    /// path whose fingerprint has moved since.
    #[serde(default)]
    pub fingerprint: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    pub dir: String,
    pub changed: Vec<ChangedPath>,
    /// HEAD moved during the turn: the commit before and after.
    pub head_moved: Option<(Option<String>, Option<String>)>,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RevertOutcome {
    pub reverted: Vec<String>,
    pub skipped: Vec<ChangedPath>,
}

fn git(dir: &Path, args: &[&str]) -> Result<(bool, Vec<u8>), String> {
    // A checkout whose git dir was pointed somewhere else is refused before git runs, so a filter in that config
    // never starts. Read-only calls also ignore the checkout's attributes and textconv.
    crate::git_cmd::ensure_contained(dir)?;
    let mut cmd = crate::git_cmd::git();
    cmd.arg("-C").arg(dir).args(["-c", "core.quotepath=off"]);
    crate::git_cmd::extend_readonly(&mut cmd, args);
    let out = cmd
        .output()
        .map_err(|e| format!("git could not run: {e}"))?;
    Ok((out.status.success(), out.stdout))
}

fn head(dir: &Path) -> Option<String> {
    match git(dir, &["rev-parse", "--verify", "-q", "HEAD"]) {
        Ok((true, out)) => {
            Some(String::from_utf8_lossy(&out).trim().to_string()).filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

/// `git status --porcelain=v1 -z`: each entry's status and path; a rename or copy names both paths.
fn status(dir: &Path) -> Result<Vec<(String, String)>, String> {
    let (ok, out) = git(
        dir,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !ok {
        return Err("This folder isn't a git checkout the app can read.".into());
    }
    let mut entries = Vec::new();
    let mut parts = out.split(|b| *b == 0).filter(|p| !p.is_empty());
    while let Some(part) = parts.next() {
        if part.len() < 4 {
            continue;
        }
        let code = String::from_utf8_lossy(&part[..2]).to_string();
        let path = String::from_utf8_lossy(&part[3..]).to_string();
        if code.contains('R') || code.contains('C') {
            if let Some(orig) = parts.next() {
                entries.push((code.clone(), String::from_utf8_lossy(orig).to_string()));
            }
        }
        entries.push((code, path));
    }
    Ok(entries)
}

fn fingerprints(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut dirty = BTreeMap::new();
    for (code, path) in status(dir)? {
        dirty.insert(path.clone(), fingerprint(dir, &code, &path));
    }
    Ok(dirty)
}

fn fingerprint(dir: &Path, code: &str, path: &str) -> String {
    let full = dir.join(path);
    let content = match std::fs::read(&full) {
        Ok(bytes) => format!("{:x}", Sha256::digest(&bytes)),
        Err(_) if full.is_dir() => "dir".into(),
        Err(_) => "absent".into(),
    };
    format!("{code}:{content}")
}

pub fn snapshot(dir: &Path) -> Result<Snapshot, String> {
    let dir = canonical(dir);
    // Before the scan: a landing that happens while it runs must still count as inside the turn.
    let taken_at = now_millis();
    let head = head(&dir);
    let dirty = fingerprints(&dir)?;
    Ok(Snapshot {
        dir: dir.to_string_lossy().to_string(),
        head,
        dirty,
        taken_at,
    })
}

fn committed_between(dir: &Path, from: &Option<String>, to: &Option<String>) -> BTreeSet<String> {
    let (Some(from), Some(to)) = (from, to) else {
        return BTreeSet::new();
    };
    match git(dir, &["diff", "--name-only", "-z", from, to]) {
        Ok((true, out)) => out
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).to_string())
            .collect(),
        _ => BTreeSet::new(),
    }
}

/// The paths a turn changed that no landing explains, or none when the checkout is as the turn found it.
pub fn check(before: &Snapshot) -> Result<Option<Flag>, String> {
    let dir = PathBuf::from(&before.dir);
    let after = snapshot(&dir)?;
    let landed = landed_since(&dir, before.taken_at);
    let head_moved = (after.head != before.head).then(|| (before.head.clone(), after.head.clone()));
    let committed = committed_between(&dir, &before.head, &after.head);
    let mut paths: BTreeSet<String> = BTreeSet::new();
    for path in before.dirty.keys().chain(after.dirty.keys()) {
        if before.dirty.get(path) != after.dirty.get(path) {
            paths.insert(path.clone());
        }
    }
    let mut changed = Vec::new();
    for path in paths.iter().chain(committed.iter()) {
        if landed.contains(path) || changed.iter().any(|c: &ChangedPath| &c.path == path) {
            continue;
        }
        let in_commit = committed.contains(path);
        let was_dirty = before.dirty.contains_key(path);
        let why_not = if was_dirty {
            Some("It already had uncommitted changes when the turn started; reverting would lose them.".to_string())
        } else if in_commit {
            Some("It was committed during the turn; commits are never rewritten.".to_string())
        } else {
            None
        };
        changed.push(ChangedPath {
            path: path.clone(),
            revertable: why_not.is_none(),
            why_not,
            fingerprint: after.dirty.get(path).cloned(),
        });
    }
    if changed.is_empty() && head_moved.is_none() {
        return Ok(None);
    }
    let summary = match (changed.len(), &head_moved) {
        (0, Some(_)) => "The first mate's turn moved the project's HEAD.".to_string(),
        (1, _) => format!(
            "The first mate's turn changed {} in the project's own checkout.",
            changed[0].path
        ),
        (n, _) => format!("The first mate's turn changed {n} files in the project's own checkout."),
    };
    Ok(Some(Flag {
        dir: before.dir.clone(),
        changed,
        head_moved,
        summary,
    }))
}

fn existed_at(dir: &Path, head: &Option<String>, path: &str) -> bool {
    let Some(head) = head else { return false };
    matches!(
        git(dir, &["cat-file", "-e", &format!("{head}:{path}")]),
        Ok((true, _))
    )
}

fn skipped(path: &str, why: &str) -> ChangedPath {
    ChangedPath {
        path: path.to_string(),
        revertable: false,
        why_not: Some(why.into()),
        fingerprint: None,
    }
}

/// Put back the named paths the turn changed: only those the flag called revertable, the check still calls revertable,
/// and nobody has touched since the flag. Everything else is skipped, with why.
pub fn revert(before: &Snapshot, flag: &Flag, paths: &[String]) -> Result<RevertOutcome, String> {
    let dir = PathBuf::from(&before.dir);
    let now = check(before)?;
    let changed = now.map(|f| f.changed).unwrap_or_default();
    let mut outcome = RevertOutcome {
        reverted: Vec::new(),
        skipped: Vec::new(),
    };
    for path in paths {
        let (Some(flagged), Some(entry)) = (
            flag.changed.iter().find(|c| &c.path == path),
            changed.iter().find(|c| &c.path == path),
        ) else {
            outcome.skipped.push(skipped(
                path,
                "The turn didn't change it, or it is already back.",
            ));
            continue;
        };
        if !flagged.revertable || !entry.revertable || path.split(['/', '\\']).any(|p| p == "..") {
            outcome.skipped.push(entry.clone());
            continue;
        }
        if entry.fingerprint != flagged.fingerprint {
            outcome.skipped.push(skipped(
                path,
                "It changed again after the turn ended; reverting would lose that later change.",
            ));
            continue;
        }
        let done = if existed_at(&dir, &before.head, path) {
            let head = before.head.as_deref().unwrap_or("HEAD");
            matches!(
                git(
                    &dir,
                    &[
                        "restore",
                        &format!("--source={head}"),
                        "--staged",
                        "--worktree",
                        "--",
                        path
                    ]
                ),
                Ok((true, _))
            )
        } else {
            let _ = git(
                &dir,
                &["rm", "--cached", "-q", "--ignore-unmatch", "--", path],
            );
            let full = dir.join(path);
            !full.exists() || std::fs::remove_file(&full).is_ok()
        };
        if done {
            outcome.reverted.push(path.clone());
        } else {
            outcome
                .skipped
                .push(skipped(path, "git could not put it back."));
        }
    }
    Ok(outcome)
}

#[cfg(test)]
pub(crate) fn note_landing_for_test(project: &Path, files: &[String], at: i64) {
    note_landing_at(project, files, at);
}

/// Review r2 repro for PR #208 (WP-178): the sandbox profile denies writes to `.git/config` and `.git/hooks` only by
/// path text. An agent in a linked worktree rewrites the worktree's `.git` file (not matched) to a git dir it wrote
/// (its `config` is not under a `.git/` path either). The app's own after-turn `git status` then runs that config's
/// `core.fsmonitor`, outside the sandbox. Red at 73263a6a7.
#[cfg(test)]
mod review_r2_repro {
    use super::*;

    #[test]
    fn the_after_turn_snapshot_never_runs_a_command_from_a_redirected_git_dir() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("cg-r2-{}-{nanos}", std::process::id()));
        let main = root.join("main");
        let wt = root.join("wt");
        let evil = root.join("evil-gitdir");
        let marker = root.join("RAN-OUTSIDE-THE-SANDBOX");
        std::fs::create_dir_all(&main).unwrap();
        let run = |dir: &Path, args: &[&str]| {
            let ok = crate::git_cmd::git()
                .arg("-C")
                .arg(dir)
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        run(&main, &["init", "-q"]);
        run(&main, &["commit", "-q", "--allow-empty", "-m", "x"]);
        run(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        // What a sandboxed agent can do: neither path matches `/\.git/config$` or `/\.git/hooks(/|$)`.
        run(&root, &["init", "-q", "--bare", evil.to_str().unwrap()]);
        std::fs::write(
            evil.join("config"),
            format!(
                "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = {}\n\tfsmonitor = \"touch '{}'; false #\"\n",
                wt.display(),
                marker.display()
            ),
        )
        .unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", evil.display())).unwrap();

        let _ = snapshot(&wt);
        let ran = marker.exists();
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            !ran,
            "the app's own git status ran the agent's core.fsmonitor command outside the sandbox"
        );
    }
}
