// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/emulate packages/@emulators/core/src/persistence.ts (Apache-2.0).
// Copyright 2025 Chris Tate.
// Translated to Rust for Hivra WP-90: write at `wx` 0600, fsync, rename; `link()` for
// create-or-read. The 0600 mode is Unix's; Windows keeps the profile folder's own ACL.

//! The stand-in's state file rules. A file is written whole or not at all, and only the first
//! writer of an initial state wins.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Replace `path` with `data` atomically. A reader sees the old file or the new one, never half.
pub fn save(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = parent(path)?;
    std::fs::create_dir_all(&dir)?;
    let temporary = temporary_name(path);
    let result = (|| {
        let mut file = create_private(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Write `data` only if `path` does not exist yet, then return whatever the file holds. A
/// second caller reads the first writer's file instead of replacing it.
///
/// Kept translated for a seed this app creates once; the stack's own seed may need merging,
/// so today only its tests drive it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn initialize(path: &Path, data: &[u8]) -> std::io::Result<String> {
    let dir = parent(path)?;
    std::fs::create_dir_all(&dir)?;
    let temporary = temporary_name(path);
    let result = (|| {
        let mut file = create_private(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        match std::fs::hard_link(&temporary, path) {
            Ok(()) => String::from_utf8(data.to_vec())
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "not text")),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read(path),
            Err(error) => Err(error),
        }
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

pub fn read(path: &Path) -> std::io::Result<String> {
    let mut text = String::new();
    std::fs::File::open(path)?.read_to_string(&mut text)?;
    Ok(text)
}

fn parent(path: &Path) -> std::io::Result<PathBuf> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no folder"))
}

fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn temporary_name(path: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|age| age.as_nanos())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "state".into());
    path.with_file_name(format!(".{name}.{}.{stamp}.{n}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(std::path::PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hivra-local-store-{name}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_saved_file_replaces_the_old_one_whole() {
        let temp = Temp::new("save");
        let path = temp.0.join("nested").join("state.json");
        save(&path, b"{\"one\":1}").unwrap();
        assert_eq!(read(&path).unwrap(), "{\"one\":1}");
        save(&path, b"{\"two\":2}").unwrap();
        assert_eq!(read(&path).unwrap(), "{\"two\":2}");
        // No temporary file is left behind.
        let left: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn initialize_creates_once_then_reads_the_first_writer() {
        let temp = Temp::new("initialize");
        let path = temp.0.join("state.json");
        assert_eq!(initialize(&path, b"{\"one\":1}").unwrap(), "{\"one\":1}");
        assert_eq!(initialize(&path, b"{\"two\":2}").unwrap(), "{\"one\":1}");
        assert_eq!(read(&path).unwrap(), "{\"one\":1}");
    }

    #[test]
    fn two_initializers_never_lose_an_update() {
        let temp = Temp::new("race");
        let path = std::sync::Arc::new(temp.0.join("state.json"));
        let mut hands = Vec::new();
        for writer in 0..2 {
            let path = std::sync::Arc::clone(&path);
            hands.push(std::thread::spawn(move || {
                initialize(&path, format!("writer-{writer}").as_bytes()).unwrap()
            }));
        }
        let first = hands.remove(0).join().unwrap();
        let second = hands.remove(0).join().unwrap();
        assert_eq!(first, second, "both callers must see the same file");
        assert_eq!(read(&path).unwrap(), first);
    }

    #[cfg(unix)]
    #[test]
    fn the_state_file_is_read_and_written_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let temp = Temp::new("mode");
        let path = temp.0.join("state.json");
        save(&path, b"{}").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
        initialize(&path.with_file_name("other.json"), b"{}").unwrap();
        let mode = std::fs::metadata(path.with_file_name("other.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
    }

    #[cfg(windows)]
    #[test]
    fn the_state_file_lives_in_the_owners_profile_folder() {
        // Windows has no Unix mode; the file inherits the profile folder's user-only ACL.
        let temp = Temp::new("mode");
        let path = temp.0.join("state.json");
        save(&path, b"{}").unwrap();
        assert!(path.is_file());
    }
}
