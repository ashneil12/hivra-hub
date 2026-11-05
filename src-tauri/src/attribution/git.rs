// SPDX-License-Identifier: Apache-2.0
// Hivra WP-86. Git is read with an allow-listed environment. A timeout or a
// missing git is an error, not an empty history.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use super::logic::{self, CommitView};

pub const MAX_LINES: usize = 5000;

pub struct DirtyLines {
    pub repo: PathBuf,
    pub hashes: HashSet<String>,
}

fn stop(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

/// A timeout or a missing git is not a rejected command. Callers keep stored rows.
#[derive(Debug)]
pub(crate) enum GitFail {
    Unavailable,
    Rejected,
}

/// Run a child and kill it when the wait exceeds `timeout`.
pub fn run_limited(mut cmd: Command, timeout: Duration) -> Result<String, GitFail> {
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    let child = cmd.spawn().map_err(|_| GitFail::Unavailable)?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Ok(_) => Err(GitFail::Rejected),
        Err(_) => {
            stop(pid);
            Err(GitFail::Unavailable)
        }
    }
}

fn git(repo: &Path, args: &[&str], timeout: Duration) -> Result<String, GitFail> {
    let mut cmd = crate::delivery::child("git");
    cmd.arg("--no-pager").arg("-C").arg(repo).args(args);
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_CONFIG_NOSYSTEM", "1");
    cmd.env("GIT_PAGER", "");
    run_limited(cmd, timeout)
}

fn git_text(repo: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    git(repo, args, timeout).map_err(|_| "git didn't answer".to_string())
}

pub fn toplevel(workdir: &Path) -> Result<PathBuf, String> {
    let out = git_text(
        workdir,
        &["rev-parse", "--show-toplevel"],
        Duration::from_secs(8),
    )?;
    let line = out.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Err("git didn't answer".into());
    }
    crate::fs::canonical(Path::new(line)).map_err(|_| "git didn't answer".to_string())
}

fn inside(root: &Path, child: &Path) -> bool {
    child.starts_with(root)
}

fn hash_lines(lines: &[String], into: &mut HashSet<String>) -> Result<(), String> {
    for line in lines {
        if into.len() >= MAX_LINES {
            return Err("git didn't answer".into());
        }
        if logic::is_boilerplate(line) {
            continue;
        }
        into.insert(logic::hash_line(line));
    }
    Ok(())
}

fn untracked_lines(repo: &Path, into: &mut HashSet<String>) -> Result<(), String> {
    let listed = git_text(
        repo,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        Duration::from_secs(8),
    )?;
    for rel in listed.split('\0') {
        if rel.is_empty() {
            continue;
        }
        if rel.contains('\0') || rel.split(['/', '\\']).any(|part| part == "..") {
            continue;
        }
        let path = repo.join(rel);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() || !meta.file_type().is_file() {
            continue;
        }
        if meta.len() > 1_048_576 {
            continue;
        }
        let Ok(canon) = crate::fs::canonical(&path) else {
            continue;
        };
        if !inside(repo, &canon) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&canon) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<String> = text.split('\n').map(|line| line.to_string()).collect();
        hash_lines(&lines, into)?;
    }
    Ok(())
}

/// Hashes of the distinctive lines currently dirty in the worktree.
/// Truncation and a missing git are errors, so the caller does not guess.
pub fn dirty_hashes(workdir: &Path) -> Result<DirtyLines, String> {
    let repo = toplevel(workdir)?;
    let mut hashes = HashSet::new();
    match git(
        &repo,
        &["diff", "-U0", "--no-ext-diff", "HEAD"],
        Duration::from_secs(8),
    ) {
        Ok(patch) => {
            let (lines, truncated) = logic::added_lines(&patch, MAX_LINES);
            if truncated {
                return Err("git didn't answer".into());
            }
            hash_lines(&lines, &mut hashes)?;
        }
        Err(_) => return Err("git didn't answer".into()),
    }
    untracked_lines(&repo, &mut hashes)?;
    Ok(DirtyLines { repo, hashes })
}

pub fn recent_shas(repo: &Path, limit: usize) -> Result<Vec<String>, String> {
    let limit = limit.clamp(1, 50);
    // No commit yet is an empty history. A timeout is not.
    match git(
        repo,
        &["rev-parse", "--verify", "-q", "HEAD"],
        Duration::from_secs(8),
    ) {
        Ok(_) => {}
        Err(GitFail::Rejected) => return Ok(Vec::new()),
        Err(GitFail::Unavailable) => return Err("git didn't answer".into()),
    }
    let out = git_text(
        repo,
        &["log", &format!("-n{limit}"), "--format=%H"],
        Duration::from_secs(15),
    )?;
    let mut shas = Vec::new();
    for line in out.lines() {
        let sha = line.trim();
        if logic::valid_sha(sha) {
            shas.push(sha.to_string());
        }
    }
    Ok(shas)
}

pub fn read_commit(repo: &Path, sha: &str) -> Result<CommitView, GitFail> {
    if !logic::valid_sha(sha) {
        return Err(GitFail::Rejected);
    }
    let message = git(
        repo,
        &["log", "-1", "--format=%B", sha],
        Duration::from_secs(15),
    )?;
    let patch = git(
        repo,
        &["show", "-U0", "--format=", "--no-ext-diff", sha],
        Duration::from_secs(15),
    )?;
    let numstat = git(
        repo,
        &["show", "--numstat", "--format=", sha],
        Duration::from_secs(15),
    )?;
    let (added, truncated) = logic::added_lines(&patch, MAX_LINES);
    let (file_count, line_count) = logic::numstat_counts(&numstat);
    Ok(CommitView {
        sha: sha.to_string(),
        message,
        added_lines: added,
        file_count,
        line_count,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    fn hang() -> Command {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        cmd
    }

    #[cfg(windows)]
    fn hang() -> Command {
        let mut cmd = Command::new("ping");
        cmd.args(["-n", "30", "127.0.0.1"]);
        cmd
    }

    #[test]
    fn a_timeout_is_a_failure() {
        let started = Instant::now();
        let result = super::run_limited(hang(), Duration::from_millis(300));
        assert!(matches!(result, Err(super::GitFail::Unavailable)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
