//! Reading a file somebody else may have swapped for something worse.
//!
//! An export folder, or a picture dropped on a note, names files that this app didn't make. A plain `fs::read` of
//! one follows a link to a private key, waits forever on a pipe, and reads a device such as `/dev/urandom` until the
//! memory is gone. Every read of such a file goes through here:
//!
//! 1. the name itself is looked at first (`symlink_metadata`): a link or anything that isn't a plain file is refused;
//! 2. it is opened with `O_NOFOLLOW` (a link swapped in after that look is refused too) and `O_NONBLOCK` (a pipe
//!    swapped in opens at once instead of waiting for a writer);
//! 3. what was opened, the handle and not the name, is checked to be a plain file, and only then is `O_NONBLOCK`
//!    cleared: what is read from here on is an ordinary blocking read of a regular file (which is also what a file
//!    that iCloud has evicted needs, to wait while it comes back);
//! 4. at most `cap` bytes are read, and a file that holds more is refused as soon as one more byte shows up.
//!
//! On Windows the same two looks are for a symlink or a junction (a reparse point whose tag is a name surrogate):
//! `FILE_FLAG_OPEN_REPARSE_POINT` opens one swapped in after the first look as itself, and the handle's own look refuses
//! it. A OneDrive placeholder, a deduplicated or compressed file is a file.
//!
//! A folder on the way to the file is not looked at: callers that need that (a note's pictures folder) check it.

use std::fs;
use std::io::Read;
use std::path::Path;

/// Why a file wasn't read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The name is a link: never followed.
    Link,
    /// A folder, pipe, device or socket.
    NotAFile,
    /// Not there, or not readable.
    Unreadable,
    /// More bytes than the cap.
    TooBig,
}

/// Whether `meta` is a link: a symlink, and on Windows a junction too (std counts a reparse point as a link when its
/// tag is a name surrogate). Other reparse points are not: a OneDrive placeholder, a deduplicated or compressed file is
/// a file.
fn is_link(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// The file at `path` opened for reading, only if it is a plain file and not a link.
pub fn open(path: &Path) -> Result<fs::File, Refusal> {
    let meta = fs::symlink_metadata(path).map_err(|_| Refusal::Unreadable)?;
    if is_link(&meta) {
        return Err(Refusal::Link);
    }
    if !meta.file_type().is_file() {
        return Err(Refusal::NotAFile);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: a link swapped in after the look above is opened as itself, not followed.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).map_err(|error| {
        // O_NOFOLLOW on a link that was swapped in after the look above.
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return Refusal::Link;
        }
        let _ = error;
        Refusal::Unreadable
    })?;
    // The handle, not the name: what was opened is a plain file, and not a link.
    match file.metadata() {
        Ok(handle) if is_link(&handle) => return Err(Refusal::Link),
        Ok(handle) if handle.is_file() => {}
        Ok(_) => return Err(Refusal::NotAFile),
        Err(_) => return Err(Refusal::Unreadable),
    }
    // A regular file can't wait for a writer: from here a read blocks only for the disk (or iCloud).
    #[cfg(unix)]
    if !clear_nonblocking(&file) {
        return Err(Refusal::Unreadable);
    }
    Ok(file)
}

/// Whether O_NONBLOCK is set on `file`'s descriptor.
#[cfg(unix)]
fn nonblocking(file: &fs::File) -> Option<bool> {
    use std::os::fd::AsRawFd;
    // SAFETY: F_GETFL on a descriptor this process owns, read-only.
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    (flags >= 0).then_some(flags & libc::O_NONBLOCK != 0)
}

#[cfg(unix)]
fn clear_nonblocking(file: &fs::File) -> bool {
    use std::os::fd::AsRawFd;
    let Some(set) = nonblocking(file) else {
        return false;
    };
    if !set {
        return true;
    }
    // SAFETY: F_GETFL / F_SETFL on a descriptor this process owns; only O_NONBLOCK is cleared.
    unsafe {
        let flags = libc::fcntl(file.as_raw_fd(), libc::F_GETFL);
        flags >= 0 && libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) >= 0
    }
}

/// Hands the bytes of the plain file at `path` to `sink` in pieces and returns how many there were. A file with more
/// than `cap` bytes is refused (`TooBig`) after reading one byte past the cap, and the sink has been given at most
/// `cap` of them by then: nothing past the size a caller expects is ever read.
pub fn stream(path: &Path, cap: u64, mut sink: impl FnMut(&[u8])) -> Result<u64, Refusal> {
    let mut file = open(path)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        // One byte past the cap is enough to know the file is longer than that.
        let room = cap.saturating_add(1) - total;
        let want = room.min(buffer.len() as u64) as usize;
        match file.read(&mut buffer[..want]) {
            Ok(0) => return Ok(total),
            Ok(read) => {
                total += read as u64;
                if total > cap {
                    return Err(Refusal::TooBig);
                }
                sink(&buffer[..read]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(Refusal::Unreadable),
        }
    }
}

/// The bytes of the plain file at `path`, if it holds no more than `cap`.
pub fn read(path: &Path, cap: u64) -> Result<Vec<u8>, Refusal> {
    let mut bytes = Vec::new();
    stream(path, cap, |piece| bytes.extend_from_slice(piece))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Folder(std::path::PathBuf);

    impl Folder {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "monocode-plain-file-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_plain_file_is_read_up_to_and_including_the_cap() {
        let folder = Folder::new();
        let path = folder.0.join("a");
        fs::write(&path, b"hello").unwrap();
        assert_eq!(read(&path, 5).unwrap(), b"hello");
        assert_eq!(read(&path, 100).unwrap(), b"hello");
        assert_eq!(read(&path, 4), Err(Refusal::TooBig));
        fs::write(&path, b"").unwrap();
        assert_eq!(read(&path, 0).unwrap(), b"");
        fs::write(&path, b"x").unwrap();
        assert_eq!(read(&path, 0), Err(Refusal::TooBig));
    }

    #[test]
    fn nothing_past_one_byte_beyond_the_cap_is_ever_read() {
        let folder = Folder::new();
        let path = folder.0.join("sparse");
        // A file far longer than the cap that costs nothing on disk.
        let file = fs::File::create(&path).unwrap();
        file.set_len(512 * 1024 * 1024).unwrap();
        drop(file);
        let mut given = 0u64;
        let result = stream(&path, 100_000, |piece| given += piece.len() as u64);
        assert_eq!(result, Err(Refusal::TooBig));
        assert!(given <= 100_000, "{given} bytes were handed over");
        // And a cap of zero asks the file for a single byte.
        let mut given = 0u64;
        assert_eq!(
            stream(&path, 0, |piece| given += piece.len() as u64),
            Err(Refusal::TooBig)
        );
        assert_eq!(given, 0);
    }

    #[test]
    fn a_missing_file_and_a_folder_are_told_apart() {
        let folder = Folder::new();
        assert_eq!(
            read(&folder.0.join("nothing"), 10),
            Err(Refusal::Unreadable)
        );
        assert_eq!(read(&folder.0, 10), Err(Refusal::NotAFile));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_refused_whatever_it_points_at() {
        let folder = Folder::new();
        fs::write(folder.0.join("real"), b"bytes").unwrap();
        std::os::unix::fs::symlink(folder.0.join("real"), folder.0.join("to-file")).unwrap();
        std::os::unix::fs::symlink(&folder.0, folder.0.join("to-folder")).unwrap();
        std::os::unix::fs::symlink(folder.0.join("gone"), folder.0.join("dangling")).unwrap();
        // The target is a device that never ends: refused before a byte is read, so this returns at once.
        std::os::unix::fs::symlink("/dev/zero", folder.0.join("to-device")).unwrap();
        for name in ["to-file", "to-folder", "dangling", "to-device"] {
            assert_eq!(read(&folder.0.join(name), 10), Err(Refusal::Link), "{name}");
        }
        assert_eq!(read(&folder.0.join("real"), 10).unwrap(), b"bytes");
    }

    /// Opened with O_NONBLOCK so a swapped-in pipe can't hold the open, then back to a plain blocking file once it is
    /// known to be a regular one: a file that has to be fetched first (iCloud) is waited for, not failed with EAGAIN.
    #[cfg(unix)]
    #[test]
    fn a_file_that_passed_is_a_blocking_file() {
        let folder = Folder::new();
        let path = folder.0.join("a");
        fs::write(&path, b"x").unwrap();
        let file = open(&path).unwrap();
        assert_eq!(nonblocking(&file), Some(false));
    }

    #[cfg(unix)]
    #[test]
    fn a_pipe_is_refused_without_waiting_for_a_writer() {
        let folder = Folder::new();
        let path = folder.0.join("pipe");
        let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let target = path.clone();
        std::thread::spawn(move || {
            let _ = tx.send(read(&target, 10));
        });
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(10)),
            Ok(Err(Refusal::NotAFile))
        );
    }
}
