//! The folder a chat works in, checked where something starts there (an agent, a terminal, a project action, a git
//! command). A chat whose folder was cleared (an imported chat whose folder wasn't a project here, see
//! docs/PORTABLE.md) has none, and must never run in the home folder, in `/`, or in whatever folder the app itself runs
//! from, so every launcher asks this first.

use std::path::{Path, PathBuf};

/// What a chat with no folder is told, in these words wherever it is refused (the webview says the same,
/// src/features/sessions/model/chatFolder.ts).
pub const NEEDS_FOLDER: &str = "Choose a project folder for this chat first.";

/// The folder to start in: a real folder, written as a full path (`~` is this Mac's home). A blank folder is refused
/// with [`NEEDS_FOLDER`], and so is the filesystem root, which is what a blank path can turn into when something
/// tidies it.
pub fn require(cwd: &str) -> Result<PathBuf, String> {
    if cwd.trim().is_empty() {
        return Err(NEEDS_FOLDER.into());
    }
    let dir = crate::fs::expand_home(cwd);
    // A relative path would be read against the folder the app runs in; the root is never a project.
    if !dir.is_absolute() || dir.parent().is_none() {
        return Err(NEEDS_FOLDER.into());
    }
    if !dir.is_dir() {
        return Err(format!(
            "Working directory does not exist: {}",
            dir.display()
        ));
    }
    Ok(dir)
}

/// True for the path a blank folder becomes once it is a `Path`.
pub fn is_blank(path: &Path) -> bool {
    path.as_os_str().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_folder_is_refused_in_plain_words() {
        for blank in ["", " ", "\t\n"] {
            assert_eq!(require(blank), Err(NEEDS_FOLDER.to_string()), "{blank:?}");
        }
    }

    #[test]
    fn the_filesystem_root_is_not_a_chats_folder() {
        assert_eq!(require("/"), Err(NEEDS_FOLDER.to_string()));
    }

    #[test]
    fn a_relative_folder_is_not_resolved_against_the_folder_the_app_runs_in() {
        // `src` exists beside the test's own working folder, which is exactly why it must not count.
        assert!(Path::new("src").is_dir());
        assert!(require("src").is_err());
    }

    #[test]
    fn a_real_full_path_and_the_home_shorthand_are_kept() {
        let dir = std::env::temp_dir();
        assert_eq!(require(&dir.to_string_lossy()), Ok(dir.clone()));
        assert!(require("~").is_ok());
        // A full path on this platform (a bare `/no/such` has no drive on Windows, so it isn't one there).
        let missing = dir.join("no-such-folder-for-a-chat-7f3c1d");
        assert!(!missing.exists());
        assert!(require(&missing.to_string_lossy())
            .unwrap_err()
            .contains("does not exist"));
    }

    #[test]
    fn a_blank_path_is_blank_and_a_named_one_is_not() {
        assert!(is_blank(Path::new("")));
        assert!(!is_blank(Path::new("/tmp")));
    }
}
