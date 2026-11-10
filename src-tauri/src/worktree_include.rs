//! WP-138: the `.worktreeinclude` file at a checkout root.
//!
//! One relative path per line. A blank line, or a line whose first non-space
//! character is `#`, is a comment. Paths that leave the checkout are refused.
//! A missing file is not an error: nothing is copied, which is today's behaviour.
//! Copied files are never staged, and their contents are never put in a note.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

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

/// At most this many files are copied. The rest are reported, not read.
const FILE_CAP: usize = 100;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct IncludeOutcome {
    /// Set when named files are in the new worktree and a CLI worktree would not have them.
    pub note: Option<String>,
    /// Set when a listed path could not be copied. Never contains file contents.
    pub warning: Option<String>,
}

/// Copy the allowed files from `source` into `dest`. Does not stage them and does not
/// remove the worktree when a copy fails.
pub(crate) fn apply(source: &Path, dest: &Path) -> IncludeOutcome {
    if !dest.is_dir() {
        return IncludeOutcome {
            note: None,
            warning: Some("Could not copy listed files into this worktree.".into()),
        };
    }
    let parsed = match read_manifest(source) {
        Manifest::Missing => {
            return IncludeOutcome {
                note: None,
                warning: None,
            };
        }
        Manifest::Unreadable => {
            return IncludeOutcome {
                note: None,
                warning: Some("Could not read .worktreeinclude.".into()),
            };
        }
        Manifest::Text(text) => parse_include(&text),
    };
    if parsed.allowed.is_empty() && parsed.refused == 0 {
        return IncludeOutcome {
            note: None,
            warning: None,
        };
    }

    let mut jobs = Vec::new();
    let mut seen = HashSet::new();
    let mut failed = Vec::new();
    let mut capped = false;
    for listed in &parsed.allowed {
        if jobs.len() >= FILE_CAP {
            capped = true;
            break;
        }
        expand(
            source,
            listed,
            &mut jobs,
            &mut seen,
            &mut failed,
            &mut capped,
        );
    }

    let mut copied = 0usize;
    let mut left = Vec::new();
    for relative in jobs {
        match place(source, dest, &relative) {
            Place::Copied => copied += 1,
            Place::Already if !tracked(dest, &relative) => copied += 1,
            Place::Already => {}
            Place::Left => left.push(relative),
            Place::Failed => failed.push(relative),
        }
    }
    IncludeOutcome {
        note: copied_note(copied),
        warning: warning_text(&failed, &left, parsed.refused, capped),
    }
}

fn copied_note(copied: usize) -> Option<String> {
    match copied {
        0 => None,
        1 => Some(
            "1 local file named in .worktreeinclude is in this worktree. A CLI that makes its own worktree will not have it."
                .into(),
        ),
        n => Some(format!(
            "{n} local files named in .worktreeinclude are in this worktree. A CLI that makes its own worktree will not have them."
        )),
    }
}

fn warning_text(
    failed: &[String],
    left: &[String],
    refused: usize,
    capped: bool,
) -> Option<String> {
    let mut parts = Vec::new();
    if refused == 1 {
        parts.push("Skipped 1 path that leaves the repository.".to_string());
    } else if refused > 1 {
        parts.push(format!(
            "Skipped {refused} paths that leave the repository."
        ));
    }
    match failed.len() {
        0 => {}
        1 => parts.push(format!(
            "Could not copy {} into this worktree.",
            show_path(&failed[0])
        )),
        n => parts.push(format!(
            "Could not copy {n} listed files into this worktree."
        )),
    }
    match left.len() {
        0 => {}
        1 => parts.push(format!("Left {} as it was.", show_path(&left[0]))),
        n => parts.push(format!("Left {n} files as they were.")),
    }
    if capped {
        parts.push(format!(
            "Stopped after {FILE_CAP} files from .worktreeinclude."
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

/// A path is safe to show. Control characters are dropped so a note stays one line
/// and cannot carry file contents.
fn show_path(relative: &str) -> String {
    if relative.chars().any(|c| c.is_control()) || relative.len() > 120 {
        "a listed file".into()
    } else {
        relative.to_string()
    }
}

fn expand(
    source: &Path,
    relative: &str,
    jobs: &mut Vec<String>,
    seen: &mut HashSet<String>,
    failed: &mut Vec<String>,
    capped: &mut bool,
) {
    if *capped || jobs.len() >= FILE_CAP {
        *capped = true;
        return;
    }
    let path = match located(source, relative) {
        Ok(path) => path,
        Err(()) => {
            failed.push(relative.to_string());
            return;
        }
    };
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(_) => {
            failed.push(relative.to_string());
            return;
        }
    };
    if meta.file_type().is_symlink() {
        failed.push(relative.to_string());
        return;
    }
    if meta.is_file() {
        if seen.insert(relative.to_string()) {
            jobs.push(relative.to_string());
        }
        return;
    }
    if !meta.is_dir() {
        failed.push(relative.to_string());
        return;
    }
    let entries = match std::fs::read_dir(&path) {
        Ok(entries) => entries,
        Err(_) => {
            failed.push(relative.to_string());
            return;
        }
    };
    for entry in entries {
        if jobs.len() >= FILE_CAP {
            *capped = true;
            return;
        }
        let Ok(entry) = entry else {
            failed.push(relative.to_string());
            continue;
        };
        let name_owned = entry.file_name();
        let Some(name) = name_owned.to_str() else {
            failed.push(relative.to_string());
            continue;
        };
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains('/')
            || name.contains('\0')
        {
            failed.push(relative.to_string());
            continue;
        }
        expand(
            source,
            &format!("{relative}/{name}"),
            jobs,
            seen,
            failed,
            capped,
        );
    }
}

enum Place {
    Copied,
    Already,
    Left,
    Failed,
}

fn place(source: &Path, dest: &Path, relative: &str) -> Place {
    let from = match located(source, relative) {
        Ok(path) => path,
        Err(()) => return Place::Failed,
    };
    let src_meta = match std::fs::symlink_metadata(&from) {
        Ok(meta) if meta.file_type().is_file() => meta,
        _ => return Place::Failed,
    };
    if ensure_parents(dest, relative).is_err() {
        return Place::Failed;
    }
    let to = match located(dest, relative) {
        Ok(path) => path,
        Err(()) => return Place::Failed,
    };
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&to)
    {
        Ok(mut out) => {
            let mut input = match std::fs::File::open(&from) {
                Ok(file) => file,
                Err(_) => {
                    let _ = std::fs::remove_file(&to);
                    return Place::Failed;
                }
            };
            if std::io::copy(&mut input, &mut out).is_err() {
                drop(out);
                let _ = std::fs::remove_file(&to);
                return Place::Failed;
            }
            #[cfg(unix)]
            {
                let _ = std::fs::set_permissions(&to, src_meta.permissions());
            }
            #[cfg(not(unix))]
            {
                let _ = src_meta.len();
            }
            if !stays_inside(dest, &to) {
                let _ = std::fs::remove_file(&to);
                return Place::Failed;
            }
            Place::Copied
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if !stays_inside(dest, &to) {
                return Place::Failed;
            }
            if same_contents(&from, &to) {
                Place::Already
            } else {
                Place::Left
            }
        }
        Err(_) => Place::Failed,
    }
}

fn stays_inside(root: &Path, path: &Path) -> bool {
    let Ok(root) = crate::fs::canonical(root) else {
        return false;
    };
    let parent = path.parent().unwrap_or(path);
    let Ok(parent) = crate::fs::canonical(parent) else {
        return false;
    };
    parent.starts_with(&root)
}

fn same_contents(left: &Path, right: &Path) -> bool {
    let Ok(left_meta) = std::fs::symlink_metadata(left) else {
        return false;
    };
    let Ok(right_meta) = std::fs::symlink_metadata(right) else {
        return false;
    };
    if !left_meta.is_file() || !right_meta.is_file() || left_meta.len() != right_meta.len() {
        return false;
    }
    let Ok(mut left_file) = std::fs::File::open(left) else {
        return false;
    };
    let Ok(mut right_file) = std::fs::File::open(right) else {
        return false;
    };
    let mut left_buf = [0u8; 8192];
    let mut right_buf = [0u8; 8192];
    loop {
        let read = match std::io::Read::read(&mut left_file, &mut left_buf) {
            Ok(0) => return true,
            Ok(n) => n,
            Err(_) => return false,
        };
        let mut got = 0;
        while got < read {
            match std::io::Read::read(&mut right_file, &mut right_buf[got..read]) {
                Ok(0) => return false,
                Ok(n) => got += n,
                Err(_) => return false,
            }
        }
        if left_buf[..read] != right_buf[..read] {
            return false;
        }
    }
}

/// A path under `root`, or an error when a link or a `..` would leave it.
fn located(root: &Path, relative: &str) -> Result<PathBuf, ()> {
    let root = crate::fs::canonical(root).map_err(|_| ())?;
    let mut cur = root.clone();
    let parts: Vec<&str> = relative
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    for (index, part) in parts.iter().enumerate() {
        if *part == ".." {
            return Err(());
        }
        cur.push(part);
        if !cur.starts_with(&root) {
            return Err(());
        }
        let last = index + 1 == parts.len();
        match std::fs::symlink_metadata(&cur) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(()),
            Ok(meta) if meta.is_dir() => {
                let canon = crate::fs::canonical(&cur).map_err(|_| ())?;
                if !canon.starts_with(&root) {
                    return Err(());
                }
                if last {
                    return Ok(canon);
                }
                cur = canon;
            }
            Ok(_) if last => return Ok(cur),
            Ok(_) => return Err(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && last => return Ok(cur),
            Err(_) => return Err(()),
        }
    }
    Err(())
}

fn ensure_parents(dest: &Path, relative: &str) -> Result<(), ()> {
    let root = crate::fs::canonical(dest).map_err(|_| ())?;
    let mut cur = root.clone();
    let parts: Vec<&str> = relative
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() <= 1 {
        return Ok(());
    }
    for part in &parts[..parts.len() - 1] {
        cur.push(part);
        match std::fs::symlink_metadata(&cur) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                let canon = crate::fs::canonical(&cur).map_err(|_| ())?;
                if !canon.starts_with(&root) {
                    return Err(());
                }
                cur = canon;
            }
            Ok(_) => return Err(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&cur).map_err(|_| ())?;
                let meta = std::fs::symlink_metadata(&cur).map_err(|_| ())?;
                if !meta.is_dir() || meta.file_type().is_symlink() {
                    return Err(());
                }
                let canon = crate::fs::canonical(&cur).map_err(|_| ())?;
                if !canon.starts_with(&root) {
                    return Err(());
                }
                cur = canon;
            }
            Err(_) => return Err(()),
        }
    }
    Ok(())
}

fn tracked(dest: &Path, relative: &str) -> bool {
    // Git not answering is not proof the file is tracked, and not a reason to overwrite it.
    crate::fs::git_checked(dest, &["ls-files", "--error-unmatch", "--", relative]).is_ok()
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

    const SECRET: &str = "SECRET-VALUE-do-not-leak";

    struct Tmp(std::path::PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp(label: &str) -> Tmp {
        let dir =
            std::env::temp_dir().join(format!("monocode-include-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }

    fn git(root: &std::path::Path, args: &[&str]) -> String {
        let mut command = std::process::Command::new("git");
        crate::hide_window_console(&mut command);
        let output = command
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("PATH", crate::harness::cached_gui_search_path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn commit(root: &std::path::Path, message: &str) {
        git(
            root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                message,
            ],
        );
    }

    fn init_repo(root: &std::path::Path) {
        std::fs::create_dir_all(root).unwrap();
        git(root, &["init", "-b", "main"]);
        // Windows runners default to core.autocrlf=true, which turns checked-out
        // "committed\n" into "committed\r\n" and breaks the byte compares below.
        git(root, &["config", "core.autocrlf", "false"]);
        git(
            root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        );
    }

    fn no_secret(text: &str) {
        assert!(!text.contains(SECRET), "{text}");
        assert!(!text.contains('—') && !text.contains('–'), "{text}");
    }

    #[test]
    fn create_copies_named_files_and_does_not_stage_them() {
        let tmp = tmp("create");
        let root = tmp.0.join("repo");
        init_repo(&root);
        std::fs::write(root.join(".gitignore"), ".env\n").unwrap();
        git(&root, &["add", ".gitignore"]);
        commit(&root, "ignore env");
        std::fs::write(root.join(".env"), SECRET).unwrap();
        std::fs::write(root.join("local.txt"), "local only\n").unwrap();
        std::fs::write(root.join("not-listed.txt"), "leave me\n").unwrap();
        std::fs::create_dir(root.join("extra")).unwrap();
        std::fs::write(root.join("extra").join("one.txt"), "one\n").unwrap();
        std::fs::write(
            root.join(".worktreeinclude"),
            ".env\r\nlocal.txt\nextra\n../escaped\n# comment\n",
        )
        .unwrap();

        let tree = crate::worktrees::create(&root, "feature/include", "HEAD", false).unwrap();
        let dest = std::path::Path::new(&tree.path);
        assert_eq!(std::fs::read_to_string(dest.join(".env")).unwrap(), SECRET);
        assert_eq!(
            std::fs::read_to_string(dest.join("local.txt")).unwrap(),
            "local only\n"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("extra").join("one.txt")).unwrap(),
            "one\n"
        );
        assert!(!dest.join("not-listed.txt").exists());
        assert!(!tmp.0.join("escaped").exists());
        let cached = git(dest, &["diff", "--cached", "--name-only"]);
        assert!(cached.trim().is_empty(), "{cached}");
        let status = git(dest, &["status", "--porcelain"]);
        assert!(!status.contains(".env"), "{status}");
        assert!(status.contains("?? local.txt"), "{status}");
        assert!(!status
            .lines()
            .any(|line| line.starts_with("A ") || line.starts_with("M ")));
        let note = tree.include_note.expect("note");
        no_secret(&note);
        assert!(note.contains("3 local files"));
        assert!(note.contains("A CLI that makes its own worktree will not have them."));
        let warning = tree.include_warning.expect("warning");
        no_secret(&warning);
        assert!(warning.contains("Skipped 1 path"));
        let again = apply(&root, dest);
        assert_eq!(std::fs::read_to_string(dest.join(".env")).unwrap(), SECRET);
        assert!(again.note.is_some());
        assert!(git(dest, &["diff", "--cached", "--name-only"])
            .trim()
            .is_empty());
    }

    #[test]
    fn a_missing_manifest_leaves_the_worktree_unchanged() {
        let tmp = tmp("absent");
        let root = tmp.0.join("repo");
        init_repo(&root);
        std::fs::write(root.join("only-here.txt"), SECRET).unwrap();
        let tree = crate::worktrees::create(&root, "feature/plain", "HEAD", false).unwrap();
        let dest = std::path::Path::new(&tree.path);
        assert!(!dest.join("only-here.txt").exists());
        assert!(tree.include_note.is_none());
        assert!(tree.include_warning.is_none());
    }

    #[test]
    fn a_tracked_file_is_not_overwritten_with_uncommitted_bytes() {
        let tmp = tmp("tracked");
        let root = tmp.0.join("repo");
        init_repo(&root);
        std::fs::write(root.join("hello.txt"), "committed\n").unwrap();
        git(&root, &["add", "hello.txt"]);
        commit(&root, "hello");
        std::fs::write(root.join("hello.txt"), SECRET).unwrap();
        std::fs::write(root.join(".worktreeinclude"), "hello.txt\n").unwrap();
        let tree = crate::worktrees::create(&root, "feature/tracked", "HEAD", false).unwrap();
        let dest = std::path::Path::new(&tree.path);
        assert_eq!(
            std::fs::read_to_string(dest.join("hello.txt")).unwrap(),
            "committed\n"
        );
        assert!(tree.include_note.is_none());
        let warning = tree.include_warning.expect("left in place");
        no_secret(&warning);
        assert!(warning.contains("Left hello.txt as it was."));
    }

    #[test]
    fn a_clean_tracked_file_is_not_called_a_local_copy() {
        let tmp = tmp("clean");
        let root = tmp.0.join("repo");
        init_repo(&root);
        std::fs::write(root.join("hello.txt"), "committed\n").unwrap();
        git(&root, &["add", "hello.txt"]);
        commit(&root, "hello");
        std::fs::write(root.join(".worktreeinclude"), "hello.txt\n").unwrap();
        let tree = crate::worktrees::create(&root, "feature/clean", "HEAD", false).unwrap();
        let dest = std::path::Path::new(&tree.path);
        assert_eq!(
            std::fs::read_to_string(dest.join("hello.txt")).unwrap(),
            "committed\n"
        );
        assert!(tree.include_note.is_none());
        assert!(tree.include_warning.is_none());
    }

    #[test]
    fn comments_only_copies_nothing() {
        let tmp = tmp("comments");
        let source = tmp.0.join("source");
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(source.join(".env"), SECRET).unwrap();
        std::fs::write(source.join(".worktreeinclude"), "# nothing\n\n  # still\n").unwrap();
        let outcome = apply(&source, &dest);
        assert!(outcome.note.is_none());
        assert!(outcome.warning.is_none());
        assert!(!dest.join(".env").exists());
    }

    #[test]
    fn copies_names_with_spaces_and_unicode() {
        let tmp = tmp("names");
        let source = tmp.0.join("source");
        let dest = tmp.0.join("dest");
        let notes = source.join("My Files");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(notes.join("notes.txt"), "notes\n").unwrap();
        let cafe = "cafe\u{0301}.env".to_string();
        std::fs::write(source.join(&cafe), "cafe\n").unwrap();
        std::fs::write(
            source.join(".worktreeinclude"),
            format!("My Files/notes.txt\n{cafe}\n"),
        )
        .unwrap();
        let outcome = apply(&source, &dest);
        assert_eq!(
            std::fs::read_to_string(dest.join("My Files").join("notes.txt")).unwrap(),
            "notes\n"
        );
        assert_eq!(std::fs::read_to_string(dest.join(&cafe)).unwrap(), "cafe\n");
        let note = outcome.note.expect("note");
        no_secret(&note);
        assert!(note.contains("2 local files"));
        assert!(outcome.warning.is_none());
    }

    #[test]
    fn an_existing_different_file_is_left_alone() {
        let tmp = tmp("left");
        let source = tmp.0.join("source");
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(source.join(".env"), SECRET).unwrap();
        std::fs::write(dest.join(".env"), "already here\n").unwrap();
        std::fs::write(source.join(".worktreeinclude"), ".env\n").unwrap();
        let outcome = apply(&source, &dest);
        assert_eq!(
            std::fs::read_to_string(dest.join(".env")).unwrap(),
            "already here\n"
        );
        assert!(outcome.note.is_none());
        let warning = outcome.warning.expect("warning");
        no_secret(&warning);
        assert!(warning.contains("Left .env as it was."));
    }

    #[test]
    fn stops_after_the_file_cap() {
        let tmp = tmp("cap");
        let source = tmp.0.join("source");
        let dest = tmp.0.join("dest");
        let many = source.join("many");
        std::fs::create_dir_all(&many).unwrap();
        std::fs::create_dir(&dest).unwrap();
        for index in 0..=FILE_CAP {
            std::fs::write(many.join(format!("f{index}.txt")), SECRET).unwrap();
        }
        std::fs::write(source.join(".worktreeinclude"), "many\n").unwrap();
        let outcome = apply(&source, &dest);
        let copied = std::fs::read_dir(dest.join("many")).unwrap().count();
        assert_eq!(copied, FILE_CAP);
        let note = outcome.note.expect("note");
        let warning = outcome.warning.expect("cap");
        no_secret(&note);
        no_secret(&warning);
        assert!(warning.contains("Stopped after 100 files"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_not_followed_and_the_mode_is_kept() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let tmp = tmp("link");
        let source = tmp.0.join("source");
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&dest).unwrap();
        let outside = tmp.0.join("outside");
        std::fs::write(&outside, SECRET).unwrap();
        symlink(&outside, source.join("linked.env")).unwrap();
        std::fs::create_dir(source.join("dir")).unwrap();
        std::fs::write(source.join("dir").join("ok.txt"), "ok\n").unwrap();
        symlink(&outside, source.join("dir").join("skip")).unwrap();
        let kept = source.join("kept.env");
        std::fs::write(&kept, "mode\n").unwrap();
        std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o640)).unwrap();
        let locked_dir = source.join("locked");
        std::fs::create_dir(&locked_dir).unwrap();
        std::fs::write(locked_dir.join("hidden"), SECRET).unwrap();
        std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::write(
            source.join(".worktreeinclude"),
            "linked.env\ndir\nkept.env\nlocked\n",
        )
        .unwrap();
        let outcome = apply(&source, &dest);
        std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!dest.join("linked.env").exists());
        assert_eq!(
            std::fs::read_to_string(dest.join("dir").join("ok.txt")).unwrap(),
            "ok\n"
        );
        assert!(!dest.join("dir").join("skip").exists());
        assert_eq!(
            std::fs::metadata(dest.join("kept.env"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        let note = outcome.note.unwrap_or_default();
        let warning = outcome.warning.unwrap_or_default();
        no_secret(&note);
        no_secret(&warning);
        assert!(warning.contains("Could not copy"));
        assert!(!std::fs::read_dir(&dest).unwrap().any(|entry| entry
            .unwrap()
            .path()
            .to_string_lossy()
            .contains(SECRET)));
    }

    #[cfg(windows)]
    #[test]
    fn symlink_copy_is_not_exercised_on_windows() {
        // Creating a symlink needs an extra privilege on Windows. The copy path
        // refuses a symlink from metadata alone; this test records the skip.
    }
}
