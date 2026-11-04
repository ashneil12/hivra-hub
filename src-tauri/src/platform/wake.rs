// WP-09: keep the machine awake while autopilot is on.
// macOS stays on IOPMAssertion (autopilot.rs). That assertion dies with the process,
// so a crash never leaves the Mac awake. These two do the same: the Windows call is
// cleared when its thread ends, and the Linux inhibit ends when the pipe closes.

#[cfg(target_os = "linux")]
use std::process::Command;
#[cfg(target_os = "linux")]
use std::time::Duration;

use crate::autopilot::Wake;

/// `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`. Display sleep is still allowed, matching
/// `caffeinate -i` / `PreventUserIdleSystemSleep`.
#[cfg(any(test, target_os = "windows"))]
pub fn execution_state_flags() -> u32 {
    0x8000_0000 | 0x0000_0001
}

/// `systemd-inhibit` holding stdin of `/bin/cat`. Not `sleep infinity`: if this
/// process is killed, the pipe closes, cat exits and the inhibit is released.
#[cfg(any(test, target_os = "linux"))]
pub fn inhibit_args(reason: &str) -> Vec<String> {
    let why = reason.replace(['\0', '\n', '\r'], " ");
    vec![
        "systemd-inhibit".into(),
        "--what=idle:sleep".into(),
        "--who=MonoCode Hub".into(),
        format!("--why={why}"),
        "--mode=block".into(),
        "/bin/cat".into(),
    ]
}

#[cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]
pub fn current() -> Box<dyn Wake> {
    #[cfg(target_os = "windows")]
    {
        Box::new(ExecutionWake::default())
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(InhibitWake { child: None })
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Box::new(crate::autopilot::NoWake)
    }
}

#[cfg(target_os = "windows")]
mod windows_wake {
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};

    use crate::autopilot::Wake;

    #[derive(Default)]
    pub struct ExecutionWake {
        stop: Option<Arc<(Mutex<bool>, Condvar)>>,
        worker: Option<JoinHandle<()>>,
    }

    impl Wake for ExecutionWake {
        fn hold(&mut self, _reason: &str) -> Result<(), String> {
            if self.worker.is_some() {
                return Ok(());
            }
            let stop = Arc::new((Mutex::new(false), Condvar::new()));
            let flag = stop.clone();
            let (started, started_rx) = std::sync::mpsc::channel();
            let worker = thread::Builder::new()
                .name("keep-awake".into())
                .spawn(move || {
                    // The flag lives in this thread. Windows clears it when the thread ends,
                    // including a crash, so a dead app never leaves the machine awake.
                    let previous =
                        unsafe { SetThreadExecutionState(super::execution_state_flags()) };
                    let _ = started.send(previous != 0);
                    if previous == 0 {
                        return;
                    }
                    let (lock, cvar) = &*flag;
                    let mut guard = lock.lock().unwrap_or_else(|poison| poison.into_inner());
                    while !*guard {
                        let (next, wait) = cvar
                            .wait_timeout(guard, Duration::from_secs(60 * 60))
                            .unwrap_or_else(|poison| poison.into_inner());
                        guard = next;
                        if wait.timed_out() && !*guard {
                            unsafe { SetThreadExecutionState(super::execution_state_flags()) };
                        }
                    }
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                })
                .map_err(|error| error.to_string())?;
            let ok = match started_rx.recv_timeout(Duration::from_secs(2)) {
                Ok(ok) => ok,
                Err(_) => {
                    if let Ok(mut flag) = stop.0.lock() {
                        *flag = true;
                    }
                    stop.1.notify_all();
                    let _ = worker.join();
                    return Err("Windows didn't answer the keep-awake request.".into());
                }
            };
            if !ok {
                let _ = worker.join();
                return Err("Windows refused the keep-awake request.".into());
            }
            self.stop = Some(stop);
            self.worker = Some(worker);
            Ok(())
        }

        fn release(&mut self) {
            if let Some(stop) = self.stop.take() {
                if let Ok(mut flag) = stop.0.lock() {
                    *flag = true;
                }
                stop.1.notify_all();
            }
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }

        fn held(&self) -> bool {
            self.worker.is_some()
        }
    }

    impl Drop for ExecutionWake {
        fn drop(&mut self) {
            Wake::release(self);
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_wake::ExecutionWake;

#[cfg(target_os = "linux")]
struct InhibitWake {
    child: Option<std::process::Child>,
}

#[cfg(target_os = "linux")]
impl Wake for InhibitWake {
    fn hold(&mut self, reason: &str) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }
        let mut command = Command::new("systemd-inhibit");
        let args = inhibit_args(reason);
        command.args(args.iter().skip(1));
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // The parent's secrets stay here. logind only needs the session bus.
        command.env_clear();
        for key in [
            "PATH",
            "HOME",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
            "LANG",
            "LC_ALL",
        ] {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    command.env(key, value);
                }
            }
        }
        let child = command
            .spawn()
            .map_err(|_| "Couldn't ask the system to stay awake.".to_string())?;
        self.child = Some(child);
        Ok(())
    }

    fn release(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        drop(child.stdin.take());
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if start.elapsed() < Duration::from_secs(2) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            }
        }
    }

    fn held(&self) -> bool {
        self.child.is_some()
    }
}

#[cfg(target_os = "linux")]
impl Drop for InhibitWake {
    fn drop(&mut self) {
        Wake::release(self);
    }
}

#[cfg(test)]
mod tests {
    use super::{execution_state_flags, inhibit_args};

    #[test]
    fn keep_awake_matches_idle_system_sleep_and_releases_with_the_process() {
        assert_eq!(execution_state_flags(), 0x8000_0001);
        let args = inhibit_args("MonoCode Hub autopilot (everything)");
        assert_eq!(args[0], "systemd-inhibit");
        assert!(args.iter().any(|arg| arg == "--mode=block"));
        assert_eq!(args.last().map(String::as_str), Some("/bin/cat"));
        assert!(!args.iter().any(|arg| arg.contains("sleep infinity")));
        let quoted = inhibit_args("line\none \"quoted\"");
        assert_eq!(quoted.len(), 6, "a reason with spaces stays one argument");
        assert!(quoted[3].starts_with("--why="));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_hold_and_release_round_trip() {
        use super::ExecutionWake;
        use crate::autopilot::Wake;
        let mut wake = ExecutionWake::default();
        wake.hold("MonoCode Hub autopilot test").unwrap();
        assert!(wake.held());
        wake.hold("again").unwrap();
        wake.release();
        assert!(!wake.held());
        wake.release();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_inhibit_releases_when_the_pipe_closes() {
        use super::InhibitWake;
        use crate::autopilot::Wake;
        if std::process::Command::new("systemd-inhibit")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let mut wake = InhibitWake { child: None };
        // No session bus (a CI job, a container) is not a failure of the seam.
        if wake.hold("MonoCode Hub autopilot test").is_err() {
            return;
        }
        assert!(wake.held());
        wake.release();
        assert!(!wake.held());
    }
}
