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

/// Run a child and kill it when the wait exceeds `timeout`.
/// A timeout or a missing program is `Unavailable`. A command that runs and
/// fails is `Rejected`. Neither is started again: a second child would hide
/// a hang, and a caller that still wants another read does that itself.
pub fn run_limited(mut cmd: Command, timeout: Duration) -> Result<String, GitFail> {
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    run_once(&mut cmd, timeout)
}

fn run_once(cmd: &mut Command, timeout: Duration) -> Result<String, GitFail> {
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
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static NEXT_ONCE: AtomicU64 = AtomicU64::new(0);

    /// A scratch folder under the temp dir. Each child appends one line to
    /// `log` before it hangs or exits, so a second start is a second line.
    struct Once {
        dir: PathBuf,
        log: PathBuf,
    }

    impl Once {
        fn new() -> Self {
            let n = NEXT_ONCE.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("hivra-git-once-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self {
                log: dir.join("tries"),
                dir,
            }
        }

        fn tries(&self) -> usize {
            match std::fs::read_to_string(&self.log) {
                Ok(text) => text.lines().filter(|line| !line.is_empty()).count(),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
                Err(err) => panic!("could not read the start log: {err}"),
            }
        }
    }

    impl Drop for Once {
        fn drop(&mut self) {
            let Ok(dir) = crate::fs::canonical(&self.dir) else {
                return;
            };
            let Ok(temp) = crate::fs::canonical(std::env::temp_dir()) else {
                return;
            };
            if dir != temp && dir.starts_with(&temp) {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    fn write_script(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(path, perms).unwrap();
        }
    }

    /// The child records one start, then becomes the long wait. `exec` keeps
    /// the same pid, so killing the child kills the wait.
    #[cfg(unix)]
    fn hang(once: &Once) -> Command {
        let script = once.dir.join("hang.sh");
        write_script(
            &script,
            "#!/bin/sh\nprintf 'x\\n' >> \"$HIVRA_TRIES\"\nexec sleep 30\n",
        );
        let mut cmd = Command::new(script);
        cmd.env("HIVRA_TRIES", &once.log);
        cmd
    }

    #[cfg(windows)]
    fn hang(once: &Once) -> Command {
        let script = once.dir.join("hang.bat");
        write_script(
            &script,
            "@echo off\r\necho x>>\"%HIVRA_TRIES%\"\r\nping -n 30 127.0.0.1 >nul\r\n",
        );
        let path = script.to_string_lossy().into_owned();
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", path.as_str()]);
        cmd.env("HIVRA_TRIES", &once.log);
        cmd
    }

    #[cfg(unix)]
    fn reject(once: &Once) -> Command {
        let script = once.dir.join("reject.sh");
        write_script(
            &script,
            "#!/bin/sh\nprintf 'x\\n' >> \"$HIVRA_TRIES\"\nexit 1\n",
        );
        let mut cmd = Command::new(script);
        cmd.env("HIVRA_TRIES", &once.log);
        cmd
    }

    #[cfg(windows)]
    fn reject(once: &Once) -> Command {
        let script = once.dir.join("reject.bat");
        write_script(
            &script,
            "@echo off\r\necho x>>\"%HIVRA_TRIES%\"\r\nexit /b 1\r\n",
        );
        let path = script.to_string_lossy().into_owned();
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", path.as_str()]);
        cmd.env("HIVRA_TRIES", &once.log);
        cmd
    }

    #[test]
    fn a_timeout_is_a_failure() {
        let once = Once::new();
        let result = super::run_limited(hang(&once), Duration::from_secs(2));
        assert!(matches!(result, Err(super::GitFail::Unavailable)));
        // The child writes one line before it waits. A second start is a second line.
        assert_eq!(once.tries(), 1);
    }

    #[test]
    fn a_rejected_command_is_not_tried_again() {
        let once = Once::new();
        let result = super::run_limited(reject(&once), Duration::from_secs(15));
        assert!(matches!(result, Err(super::GitFail::Rejected)));
        assert_eq!(once.tries(), 1);
    }
}
