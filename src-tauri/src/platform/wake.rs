// WP-09: keep the machine awake while autopilot is on.
// macOS stays on IOPMAssertion (autopilot.rs). That assertion dies with the process,
// so a crash never leaves the Mac awake. These two do the same: the Windows call is
// cleared when its thread ends, and the Linux inhibit ends when the pipe closes.

#[cfg(any(test, target_os = "linux"))]
use std::cell::RefCell;
#[cfg(any(test, target_os = "linux"))]
use std::process::Command;
#[cfg(any(test, target_os = "linux"))]
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
        Box::new(InhibitWake {
            child: RefCell::new(None),
        })
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

#[cfg(any(test, target_os = "linux"))]
struct InhibitWake {
    child: RefCell<Option<std::process::Child>>,
}

#[cfg(any(test, target_os = "linux"))]
impl Wake for InhibitWake {
    fn hold(&mut self, reason: &str) -> Result<(), String> {
        // A child that has already exited is not a hold. Spawn again.
        if self.held() {
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
        *self.child.borrow_mut() = Some(child);
        Ok(())
    }

    fn release(&mut self) {
        let Some(mut child) = self.child.borrow_mut().take() else {
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
        let mut slot = self.child.borrow_mut();
        let Some(child) = slot.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => true,
            // Reaped. Dropping it here does not wait a second time.
            Ok(Some(_)) => {
                *slot = None;
                false
            }
            // Can't tell. Treat it as held so a second inhibit isn't started.
            Err(_) => true,
        }
    }
}

#[cfg(any(test, target_os = "linux"))]
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

    #[test]
    fn a_finished_inhibit_child_is_not_held_and_hold_does_not_pretend_it_is() {
        use super::InhibitWake;
        use crate::autopilot::Wake;
        use std::cell::RefCell;
        use std::process::Command;
        use std::time::Duration;
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        } else {
            Command::new("true")
        };
        let child = command
            .spawn()
            .expect("a short-lived process to stand in for systemd-inhibit");
        let mut wake = InhibitWake {
            child: RefCell::new(Some(child)),
        };
        let start = std::time::Instant::now();
        while wake.held() && start.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !wake.held(),
            "an inhibit child that has exited is not still holding the machine awake"
        );
        // No session bus is not a passing hold. Ok is only allowed when a new child is running.
        let again = wake.hold("MonoCode Hub autopilot test");
        if again.is_ok() {
            assert!(wake.held(), "hold returned ok but nothing is running");
            wake.release();
        } else {
            assert!(!wake.held());
        }
    }
}
