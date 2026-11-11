//! Git with an allow-listed environment. A timeout is not a final failure: the
//! caller leaves the branch as it was and says to try again.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::delivery;

pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub struct Ran {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug)]
pub enum RunError {
    Refused(String),
    NotFinished(String),
}

pub fn run(cwd: &Path, args: &[&str], timeout: Duration) -> Result<Ran, RunError> {
    run_program("git", cwd, args, timeout, true)
}

pub fn run_program(
    program: &str,
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
    git: bool,
) -> Result<Ran, RunError> {
    if git {
        ensure_safe(args)?;
    }
    let mut cmd = command(program, cwd, args, git);
    let mut child = cmd.spawn().map_err(|error| {
        RunError::NotFinished(format!(
            "Git could not be started ({error}). Nothing was changed. Try again."
        ))
    })?;
    let mut stdout = child.stdout.take().ok_or_else(|| {
        RunError::NotFinished("Git could not be started. Nothing was changed. Try again.".into())
    })?;
    let mut stderr = child.stderr.take().ok_or_else(|| {
        RunError::NotFinished("Git could not be started. Nothing was changed. Try again.".into())
    })?;
    let out_handle = thread::spawn(move || read_to_string(&mut stdout));
    let err_handle = thread::spawn(move || read_to_string(&mut stderr));
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = out_handle.join().unwrap_or_default();
                let stderr = err_handle.join().unwrap_or_default();
                let Some(code) = status.code() else {
                    return Err(RunError::NotFinished(
                        "The update did not finish. Nothing was changed. Try again.".into(),
                    ));
                };
                return Ok(Ran {
                    code,
                    stdout,
                    stderr,
                });
            }
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_handle.join();
                let _ = err_handle.join();
                return Err(RunError::NotFinished(
                    "The update did not finish in time. Nothing was changed. Try again.".into(),
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::NotFinished(format!(
                    "The update did not finish ({error}). Nothing was changed. Try again."
                )));
            }
        }
    }
}

pub fn ensure_safe(args: &[&str]) -> Result<(), RunError> {
    for arg in args {
        if forbidden(arg) {
            return Err(RunError::Refused(
                "That git command is not allowed. Nothing was changed.".into(),
            ));
        }
    }
    Ok(())
}

fn forbidden(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "--force" | "--force-with-lease" | "--force-if-includes" | "-f" | "--no-verify"
    ) || arg.starts_with('+')
        || lower.contains("--no-verify")
        || lower.contains("--force")
}

fn command(program: &str, cwd: &Path, args: &[&str], git: bool) -> Command {
    // Git comes from git_cmd::child(): the scrubbed environment, hooks and fsmonitor off, and the container profile
    // while the agent sandbox is on. A rebase here must not run hooks an agent wrote.
    let mut cmd = if git {
        crate::git_cmd::child()
    } else {
        delivery::child(program)
    };
    if git {
        cmd.arg("--no-pager").arg("-C").arg(cwd);
    } else {
        cmd.current_dir(cwd);
    }
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

fn read_to_string(pipe: &mut dyn Read) -> String {
    let mut buf = Vec::new();
    let _ = pipe.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}
