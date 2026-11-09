//! WP-138: the `.worktreeinclude` file at a checkout root.
//!
//! One relative path per line. A blank line, or a line whose first non-space
//! character is `#`, is a comment. Paths that leave the checkout are refused.
//! A missing file is not an error: nothing is copied, which is today's behaviour.
//!
//! Creation calls these once it is copying. Until then the lib target has no
//! caller outside the tests, so the dead-code lint is held back on purpose.

#![allow(dead_code)]

use std::collections::HashSet;
use std::path::Path;

/// How many bytes of the manifest we will read. A path list fits easily. Anything
/// larger is refused without reading it, so a huge file cannot be pulled into memory.
const MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ParsedInclude {
    /// Repo-relative paths, `/`-separated, duplicates removed, in first-seen order.
    pub allowed: Vec<String>,
    /// Lines that were not comments and did not name a path inside the checkout.
    pub refused: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Manifest {
    /// No `.worktreeinclude` in this checkout.
    Missing,
    /// Present, but not a small UTF-8 file we can trust (a link, a directory, too big, or unreadable).
    Unreadable,
    Text(String),
}

/// Parse a manifest. Does not touch the disk.
pub(crate) fn parse_include(text: &str) -> ParsedInclude {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut allowed = Vec::new();
    let mut seen = HashSet::new();
    let mut refused = 0usize;
    for raw in text.split('\n') {
        let line = raw.trim().trim_end_matches('\r');
        // `trim` already drops `\r`. Trim again so a comment line with odd space is still a comment.
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match normalize_include_path(line) {
            Some(path) => {
                if seen.insert(path.clone()) {
                    allowed.push(path);
                }
            }
            None => refused += 1,
        }
    }
    ParsedInclude { allowed, refused }
}

/// Read `.worktreeinclude` from `root`. Missing is [`Manifest::Missing`], not an error.
pub(crate) fn read_manifest(root: &Path) -> Manifest {
    let path = root.join(".worktreeinclude");
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Manifest::Missing,
        Err(_) => return Manifest::Unreadable,
    };
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return Manifest::Unreadable;
    }
    if meta.len() > MANIFEST_BYTES {
        return Manifest::Unreadable;
    }
    match std::fs::read(&path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => Manifest::Text(text),
            Err(_) => Manifest::Unreadable,
        },
        Err(_) => Manifest::Unreadable,
    }
}

/// `Some` is a relative path that stays inside the checkout. `None` refuses the line.
fn normalize_include_path(line: &str) -> Option<String> {
    if line.contains('\0') || line.starts_with('/') || line.starts_with('\\') {
        return None;
    }
    let bytes = line.as_bytes();
    // `C:\...` and `C:/...`. A colon in the second position is a drive, not a file name.
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return None;
    }
    // `\` is a separator, so a Windows `..\` cannot hide in a file name.
    let unified = line.replace('\\', "/");
    let unified = unified.strip_suffix('/').unwrap_or(&unified);
    if unified.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in unified.split('/') {
        if part.is_empty() || part == ".." {
            return None;
        }
        if part == "." {
            continue;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(text: &str) -> Vec<String> {
        parse_include(text).allowed
    }

    #[test]
    fn allows_relative_paths_comments_and_duplicates() {
        let parsed = parse_include(
            "\u{feff}# local files\n\n.env\r\n  # indented comment\n./config/local.json\nconfig/./local.json\n.env\nMy Files/notes.txt\ncafe\u{0301}.env\nconfig\\\n",
        );
        assert_eq!(parsed.refused, 0);
        assert_eq!(
            parsed.allowed,
            vec![
                ".env".to_string(),
                "config/local.json".to_string(),
                "My Files/notes.txt".to_string(),
                "cafe\u{0301}.env".to_string(),
                "config".to_string(),
            ]
        );
    }

    #[test]
    fn refuses_paths_that_leave_the_checkout() {
        for line in [
            "../.env",
            "/etc/passwd",
            "foo/../../x",
            "foo/..",
            "..",
            ".",
            "./",
            "foo//bar",
            "C:/Windows/win.ini",
            "C:\\Windows\\win.ini",
            "\\\\server\\share\\secret",
            "foo\\..\\..\\outside",
            ".env\0hidden",
            "a:name",
        ] {
            let parsed = parse_include(line);
            assert!(
                parsed.allowed.is_empty(),
                "{line:?} should be refused, got {:?}",
                parsed.allowed
            );
            assert_eq!(parsed.refused, 1, "{line:?}");
        }
        // A refused line does not drop the lines that are fine.
        let mixed = parse_include(".env\n../outside\nconfig/local.json\n");
        assert_eq!(
            mixed.allowed,
            vec![".env".to_string(), "config/local.json".to_string()]
        );
        assert_eq!(mixed.refused, 1);
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let dir =
            std::env::temp_dir().join(format!("monocode-include-missing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_manifest(&dir), Manifest::Missing);
        assert!(allowed("").is_empty());
        assert_eq!(parse_include("# only a comment\n\n").refused, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_link_or_a_huge_file_is_not_read() {
        let dir =
            std::env::temp_dir().join(format!("monocode-include-unread-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join(".worktreeinclude");
        std::fs::write(&manifest, vec![b'x'; (MANIFEST_BYTES as usize) + 1]).unwrap();
        assert_eq!(read_manifest(&dir), Manifest::Unreadable);
        // The oversized body must not come back as text.
        assert!(!matches!(read_manifest(&dir), Manifest::Text(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_manifest_is_not_followed() {
        let dir =
            std::env::temp_dir().join(format!("monocode-include-link-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("monocode-include-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&outside, "SECRET-VALUE-do-not-leak\n").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(".worktreeinclude")).unwrap();
        assert_eq!(read_manifest(&dir), Manifest::Unreadable);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn symlink_manifest_is_not_exercised_on_windows() {
        // Creating a symlink needs an extra privilege on Windows. The metadata check
        // (is_symlink -> Unreadable) is the same; this test records the skip.
    }
}
