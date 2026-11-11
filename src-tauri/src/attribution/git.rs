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
/// Untracked files larger than this are not read. A journal must not pull a
/// binary or a dump into the turn.
pub const MAX_FILE_BYTES: u64 = 1_048_576;

pub struct DirtyLines {
    pub repo: PathBuf,
    pub hashes: HashSet<String>,
    /// The cap stopped the read while a distinctive line was still unread.
    /// A later snapshot can then hold a line that was already dirty. Callers
    /// must not journal a run whose before snapshot is truncated.
    pub truncated: bool,
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

/// One extra try when git could not be started. A command git rejected is not
/// tried again, and neither is one that started and timed out: that wait already
/// used the whole timeout, and the command may have run part-way. The timeout
/// itself is unchanged.
const SPAWN_ATTEMPTS: u32 = 2;

/// Why one try failed. Only `Spawn` is worth another try.
#[derive(Debug)]
enum Miss {
    /// The child never started: git missing, briefly locked or out of processes.
    Spawn,
    /// The child started and did not finish within the wait.
    Timeout,
    /// The child finished and git rejected the command.
    Rejected,
}

/// Run a child and kill it when the wait exceeds `timeout`.
pub fn run_limited(mut cmd: Command, timeout: Duration) -> Result<String, GitFail> {
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    retry_spawn(|| run_once(&mut cmd, timeout))
}

/// Try again only after the child failed to start, then report every miss as
/// the `GitFail` callers already handle.
fn retry_spawn(mut run: impl FnMut() -> Result<String, Miss>) -> Result<String, GitFail> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match run() {
            Ok(out) => return Ok(out),
            Err(Miss::Spawn) if attempt < SPAWN_ATTEMPTS => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(Miss::Spawn | Miss::Timeout) => return Err(GitFail::Unavailable),
            Err(Miss::Rejected) => return Err(GitFail::Rejected),
        }
    }
}

fn run_once(cmd: &mut Command, timeout: Duration) -> Result<String, Miss> {
    let child = cmd.spawn().map_err(|_| Miss::Spawn)?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Ok(_) => Err(Miss::Rejected),
        Err(_) => {
            stop(pid);
            Err(Miss::Timeout)
        }
    }
}

fn git(repo: &Path, args: &[&str], timeout: Duration) -> Result<String, GitFail> {
    let mut cmd = crate::git_cmd::child_keep_hooks();
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

/// Stop once the cap is full. Lines past it are left out; that is not a failed read.
/// True when a distinctive line in `lines` was not stored.
fn hash_lines(lines: &[String], into: &mut HashSet<String>) -> bool {
    for (index, line) in lines.iter().enumerate() {
        if into.len() >= MAX_LINES {
            return lines[index..].iter().any(|line| {
                !logic::is_boilerplate(line) && !into.contains(&logic::hash_line(line))
            });
        }
        if logic::is_boilerplate(line) {
            continue;
        }
        into.insert(logic::hash_line(line));
    }
    false
}

/// The diff is already in memory. A line added past the cap still counts, unless
/// it is boilerplate or a duplicate of a hash already stored.
fn patch_past_cap_has_new_line(patch: &str, kept: &HashSet<String>) -> bool {
    let mut seen = 0usize;
    for raw in patch.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.starts_with("+++") || !line.starts_with('+') {
            continue;
        }
        let text = &line[1..];
        if seen < MAX_LINES {
            seen += 1;
            continue;
        }
        if !logic::is_boilerplate(text) && !kept.contains(&logic::hash_line(text)) {
            return true;
        }
    }
    false
}

fn untracked_lines(repo: &Path, into: &mut HashSet<String>) -> Result<bool, String> {
    let listed = git_text(
        repo,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        Duration::from_secs(8),
    )?;
    let mut truncated = false;
    for rel in listed.split('\0') {
        if rel.is_empty() || rel.split(['/', '\\']).any(|part| part == "..") {
            continue;
        }
        // A file still listed once the cap is full was not read. Opening it
        // would go past the cap, so the snapshot is truncated instead.
        if into.len() >= MAX_LINES {
            return Ok(true);
        }
        let path = repo.join(rel);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() || !meta.file_type().is_file() {
            continue;
        }
        if meta.len() > MAX_FILE_BYTES {
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
        if hash_lines(&lines, into) {
            truncated = true;
        }
    }
    Ok(truncated)
}

/// Hashes of the distinctive lines currently dirty in the worktree.
/// A tree past the line cap stops. The lines already collected still stand, so
/// the caller does not throw the snapshot away and try the whole read again.
/// `truncated` is set instead, and a truncated read is still `Ok`.
/// A missing git is an error, so the caller does not guess.
/// A repository with no commit yet still hashes untracked lines.
pub fn dirty_hashes(workdir: &Path) -> Result<DirtyLines, String> {
    let repo = toplevel(workdir)?;
    let mut hashes = HashSet::new();
    let mut truncated = false;
    match git(
        &repo,
        &["rev-parse", "--verify", "-q", "HEAD"],
        Duration::from_secs(8),
    ) {
        Ok(_) => match git(
            &repo,
            &["diff", "-U0", "--no-ext-diff", "HEAD"],
            Duration::from_secs(8),
        ) {
            Ok(patch) => {
                let (lines, cut) = logic::added_lines(&patch, MAX_LINES);
                if hash_lines(&lines, &mut hashes) {
                    truncated = true;
                }
                if cut && patch_past_cap_has_new_line(&patch, &hashes) {
                    truncated = true;
                }
            }
            Err(_) => return Err("git didn't answer".into()),
        },
        Err(GitFail::Rejected) => {}
        Err(GitFail::Unavailable) => return Err("git didn't answer".into()),
    }
    if untracked_lines(&repo, &mut hashes)? {
        truncated = true;
    }
    Ok(DirtyLines {
        repo,
        hashes,
        truncated,
    })
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
        // One 300 ms wait. A timeout is not tried again, so nothing doubles it.
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// Each start of the child appends a line to a marker file, then hangs. A
    /// second start after the timeout would add a second line.
    #[cfg(unix)]
    #[test]
    fn a_timeout_is_not_tried_again() {
        let marker = std::env::temp_dir().join(format!(
            "hivra-git-timeout-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&marker);
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("echo started >> \"$1\"; exec sleep 30")
            .arg("sh")
            .arg(&marker);
        let result = super::run_limited(cmd, Duration::from_secs(2));
        let starts = std::fs::read_to_string(&marker)
            .unwrap_or_default()
            .lines()
            .count();
        let _ = std::fs::remove_file(&marker);
        assert!(matches!(result, Err(super::GitFail::Unavailable)));
        assert_eq!(starts, 1, "the command was started {starts} times");
    }

    #[test]
    fn a_rejected_command_is_not_tried_again() {
        // A loaded Windows runner can take several seconds just to start git, so a
        // short wait turned a rejection into a timeout. Wait long enough that only a
        // real hang times out. Rejected (not Unavailable) is the proof: run_limited
        // tries again only after a failed start, so a rejection returns on the first try.
        let mut cmd = crate::git_cmd::git_keep_hooks();
        cmd.arg("not-a-command");
        let result = super::run_limited(cmd, Duration::from_secs(60));
        assert!(
            matches!(result, Err(super::GitFail::Rejected)),
            "expected Rejected, got {result:?}"
        );
    }

    /// Run the retry policy against a scripted child. Returns the outcome and
    /// how many times the child was started.
    fn scripted(
        script: Vec<Result<String, super::Miss>>,
    ) -> (Result<String, super::GitFail>, usize) {
        let mut script = script.into_iter();
        let mut starts = 0;
        let result = super::retry_spawn(|| {
            starts += 1;
            script.next().expect("started more often than scripted")
        });
        (result, starts)
    }

    #[test]
    fn a_failed_start_is_tried_once_more() {
        let (result, starts) = scripted(vec![Err(super::Miss::Spawn), Ok("sha\n".into())]);
        assert_eq!(result.expect("the second try answers"), "sha\n");
        assert_eq!(starts, 2);
    }

    #[test]
    fn two_failed_starts_are_unavailable() {
        let (result, starts) = scripted(vec![Err(super::Miss::Spawn), Err(super::Miss::Spawn)]);
        assert!(matches!(result, Err(super::GitFail::Unavailable)));
        assert_eq!(starts, super::SPAWN_ATTEMPTS as usize);
    }

    #[test]
    fn a_timeout_after_a_failed_start_is_not_tried_again() {
        let (result, starts) = scripted(vec![Err(super::Miss::Spawn), Err(super::Miss::Timeout)]);
        assert!(matches!(result, Err(super::GitFail::Unavailable)));
        assert_eq!(starts, 2);
    }

    #[test]
    fn a_timeout_is_one_try() {
        let (result, starts) = scripted(vec![Err(super::Miss::Timeout)]);
        assert!(matches!(result, Err(super::GitFail::Unavailable)));
        assert_eq!(starts, 1);
    }

    #[test]
    fn a_rejection_is_one_try() {
        let (result, starts) = scripted(vec![Err(super::Miss::Rejected)]);
        assert!(matches!(result, Err(super::GitFail::Rejected)));
        assert_eq!(starts, 1);
    }

    #[test]
    fn a_program_that_cannot_start_is_unavailable() {
        let cmd = Command::new("hivra-no-such-program-for-git-retry");
        let result = super::run_limited(cmd, Duration::from_secs(5));
        assert!(matches!(result, Err(super::GitFail::Unavailable)));
    }
}

/// Review r3 repro for PR #208 (WP-178). The builder's answer to open call (2) is that the app's own attribution git
/// calls are read-only and run no hooks. They run no hooks, but a read-only `git diff` still runs a textconv program
/// named in the repository's config, and the profile lets a sandboxed agent redirect that config with `.git/commondir`.
/// `dirty_hashes` then runs the agent's program outside the sandbox. Red at 4417a9621.
#[cfg(all(test, unix))]
mod review_r3_repro {
    use super::*;

    #[test]
    fn the_app_attribution_diff_never_runs_a_textconv_from_a_redirected_common_dir() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("attr-r3-{}-{nanos}", std::process::id()));
        let main = root.join("main");
        let evil = root.join("agent-common-dir");
        let marker = root.join("RAN-OUTSIDE-THE-SANDBOX");
        std::fs::create_dir_all(&main).unwrap();
        let run = |args: &[&str]| {
            let ok = crate::git_cmd::git()
                .arg("-C")
                .arg(&main)
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        run(&["init", "-q"]);
        std::fs::write(main.join("a.txt"), "hello\n").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "a"]);

        std::fs::create_dir_all(&evil).unwrap();
        std::os::unix::fs::symlink(main.join(".git/objects"), evil.join("objects")).unwrap();
        std::os::unix::fs::symlink(main.join(".git/refs"), evil.join("refs")).unwrap();
        std::fs::write(
            evil.join("config"),
            format!(
                "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[diff \"x\"]\n\ttextconv = \"touch '{}'; cat\"\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::write(main.join(".git/commondir"), format!("{}\n", evil.display())).unwrap();
        std::fs::write(main.join(".gitattributes"), "* diff=x\n").unwrap();
        std::fs::write(main.join("a.txt"), "hello\nmore\n").unwrap();

        let _ = dirty_hashes(&main);
        let ran = marker.exists();
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            !ran,
            "attribution's own git diff ran the agent's textconv outside the sandbox"
        );
    }
}
