// SPDX-License-Identifier: Apache-2.0
//! One Windows process, held by a handle.
//!
//! A process id can be given to another program the moment its owner exits. A handle cannot:
//! it names one process for as long as it is open. The stand-in is looked at and ended through
//! the same handle, so a pid reused in between is never the process that is ended. Nothing here
//! starts another program: no PowerShell, no `taskkill`, and so nothing that can hang.

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

/// How long `terminate` waits for the process to be gone, so the ports it held are free again.
const EXIT_WAIT_MS: u32 = 3_000;

/// Why a process could not be opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFailure {
    /// No such process: its id is not in use.
    Gone,
    /// It exists, but this app may not open it (another user's, or protected).
    Refused,
}

/// An open process. The handle is closed when this is dropped.
pub struct Process(HANDLE);

impl Process {
    /// Open `pid` to look at it, and with `to_end` to end it too.
    pub fn open(pid: u32, to_end: bool) -> Result<Self, OpenFailure> {
        let mut access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
        if to_end {
            access |= PROCESS_TERMINATE;
        }
        // SAFETY: the handle is closed when the returned value is dropped.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            // SAFETY: reads the calling thread's last error, set by the call above.
            let code = unsafe { GetLastError() };
            return Err(if code == ERROR_INVALID_PARAMETER {
                OpenFailure::Gone
            } else {
                OpenFailure::Refused
            });
        }
        Ok(Self(handle))
    }

    /// When the process was created, as a Windows file time in digits. This is the same text
    /// the pid file holds, taken from the handle the app got when it started the process.
    pub fn start_token(&self) -> Option<String> {
        start_token_of(self.0)
    }

    /// The program file's name, such as `node.exe`, without its folders.
    pub fn image_name(&self) -> Option<String> {
        // Long paths are allowed on Windows 10, so the buffer is the longest one there is.
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        // SAFETY: `buffer` is `length` wide and outlives the call; the handle is open.
        let ok = unsafe {
            QueryFullProcessImageNameW(self.0, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut length)
        };
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..(length as usize).min(buffer.len())]);
        let name = path.rsplit(['\\', '/']).next().unwrap_or("").to_string();
        (!name.is_empty()).then_some(name)
    }

    /// Whether the process has ended. A handle to a process that has ended still opens, so
    /// this is asked before anything else is believed about it.
    pub fn exited(&self) -> bool {
        // SAFETY: the handle is open and was opened with the right to wait on it.
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
    }

    /// End the process and wait a moment for it to go. False when it could not be ended.
    pub fn terminate(&self) -> bool {
        // SAFETY: the handle is open and was opened with the right to end it.
        let ended = unsafe { TerminateProcess(self.0, 1) } != 0;
        if ended {
            // SAFETY: as above.
            unsafe { WaitForSingleObject(self.0, EXIT_WAIT_MS) };
        }
        ended
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: the handle came from `OpenProcess` and is closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// The creation time of the process `handle` names, in digits. Asked of the handle `spawn`
/// returned, it is the time of the process this app started and no other.
pub fn start_token_of(handle: HANDLE) -> Option<String> {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: every pointer is to a local that outlives the call.
    let ok = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    let ticks = u64::from(created.dwLowDateTime) | (u64::from(created.dwHighDateTime) << 32);
    (ticks != 0).then(|| ticks.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};

    fn long_running() -> std::process::Child {
        Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("ping starts")
    }

    #[test]
    fn a_held_process_gives_its_start_time_and_image_and_can_be_ended() {
        let mut child = long_running();
        let spawned = start_token_of(child.as_raw_handle()).expect("a start time at spawn");
        let held = Process::open(child.id(), true)
            .unwrap_or_else(|error| panic!("the process did not open: {error:?}"));
        assert_eq!(held.start_token().as_deref(), Some(spawned.as_str()));
        assert!(held
            .image_name()
            .is_some_and(|image| image.eq_ignore_ascii_case("ping.exe")));
        assert!(!held.exited());
        assert!(held.terminate());
        assert!(held.exited());
        let _ = child.wait();
    }

    #[test]
    fn a_process_id_in_use_by_nothing_is_gone() {
        // Windows ids are small multiples of four; this one is never handed out.
        assert_eq!(
            Process::open(u32::MAX - 3, false).err(),
            Some(OpenFailure::Gone)
        );
    }
}
