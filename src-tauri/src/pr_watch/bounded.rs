//! A child process with a deadline, for everything the PR watch runs (`gh`, `git fetch`): the poller is one thread, so a
//! call that hangs on the network would hold up every watch. At the deadline the child is killed together with
//! everything it started (git's remote helpers, ssh), so nothing is left holding its pipes.

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// A run that finished, in time.
pub struct Ran {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Failed {
    /// The program isn't installed.
    NotFound,
    /// It didn't finish within the deadline and was stopped.
    TimedOut,
    Other(String),
}

/// Run `command` to its end, or stop it (and its process group) after `timeout`. Stdin is closed; stdout and stderr are
/// read whole.
pub fn run(mut command: Command, timeout: Duration) -> Result<Ran, Failed> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group, so the deadline reaches what it starts too.
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Failed::NotFound
        } else {
            Failed::Other(error.to_string())
        }
    })?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > timeout => {
                #[cfg(unix)]
                // SAFETY: a plain signal to the child's own process group (made above); no memory is involved.
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failed::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failed::Other(error.to_string()));
            }
        }
    };
    Ok(Ran {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// "2 s", "2 minutes": a deadline in words.
pub fn words(timeout: Duration) -> String {
    let secs = timeout.as_secs();
    if secs >= 60 && secs.is_multiple_of(60) {
        let minutes = secs / 60;
        format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" })
    } else {
        format!("{secs} s")
    }
}
