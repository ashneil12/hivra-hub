//! WP-138: the `.worktreeinclude` file at a checkout root.
//!
//! The file uses gitignore syntax: patterns, `!` to drop a match, `**`, and `#`
//! comments. Only files git ignores are copied, as Claude Code does: a tracked
//! file is already in the new worktree, and an untracked file that is not
//! ignored is the person's work in progress. Git does the matching, so escaped
//! characters, negations and directory patterns behave exactly as they do in
//! `.gitignore`. A missing file is not an error: nothing is copied, which is
//! today's behaviour. Copied files are never staged, and their contents are
//! never put in a note.

use std::path::{Path, PathBuf};

/// How many bytes of the manifest we will read. A pattern list fits easily. Anything
/// larger is refused without reading it, so a huge file cannot be pulled into memory.
const MANIFEST_BYTES: u64 = 64 * 1024;

/// How many bytes of `git ls-files` output we will hold. A match list past this is
/// far beyond the copy cap; the copy stops and says so.
const LIST_BYTES: usize = 2 * 1024 * 1024;

/// At most this many files are copied. The rest are reported, not read.
const FILE_CAP: usize = 100;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Manifest {
    /// No `.worktreeinclude` in this checkout.
    Missing,
    /// Present, but not a small UTF-8 file we can trust (a link, a directory, too big, or unreadable).
    Unreadable,
    Text(String),
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
            // A NUL byte would cut the pattern list at whatever git's reader does with it.
            Ok(text) if !text.contains('\0') => Manifest::Text(text),
            _ => Manifest::Unreadable,
        },
        Err(_) => Manifest::Unreadable,
    }
}

/// The manifest text git will read: no BOM, and one line ending so a `\r` cannot
/// ride at the end of a pattern.
fn manifest_text(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// A manifest git can read from a path. The manifest may sit in a checkout that is
/// walked by other tools, so git gets a private copy and the copy goes away.
struct StagedManifest(PathBuf);

impl Drop for StagedManifest {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn stage_manifest(text: &str) -> Option<StagedManifest> {
    let path =
        std::env::temp_dir().join(format!("monocode-worktreeinclude-{}", uuid::Uuid::new_v4()));
    std::fs::write(&path, text.as_bytes()).ok()?;
    Some(StagedManifest(path))
}

/// Why the match list stopped short of every file it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stop {
    /// Every match is in the list.
    None,
    /// The list was cut at [`FILE_CAP`].
    Cap,
    /// Git's list was too large to read whole.
    Listing,
}

struct Chosen {
    /// Repo-relative paths, in the order git lists them.
    paths: Vec<String>,
    stop: Stop,
    /// False when the manifest or git could not be read at all.
    readable: bool,
}

fn nothing_chosen(readable: bool) -> Chosen {
    Chosen {
        paths: Vec::new(),
        stop: Stop::None,
        readable,
    }
}

/// The files git ignores that the manifest selects. Git owns the pattern language,
/// so negation, `**`, escapes and directory patterns all behave as they do in
/// `.gitignore`. A pattern that matches nothing is not an error.
fn choose(source: &Path, manifest: &str, list_bytes: usize) -> Chosen {
    let Some(staged) = stage_manifest(manifest) else {
        return nothing_chosen(false);
    };
    let exclude = format!("--exclude-from={}", staged.0.to_string_lossy());
    // The untracked files the manifest's patterns match. This includes a file the
    // checkout's own rules let through (untracked and not ignored), so it is
    // filtered below.
    let Some((selected, selected_cut)) = git_paths(
        source,
        &["ls-files", "-z", "--others", "--ignored", &exclude],
        list_bytes,
    ) else {
        return nothing_chosen(false);
    };
    if selected.is_empty() {
        return nothing_chosen(true);
    }
    // Which of those the checkout's own rules ignore (`.gitignore`, `.git/info/exclude`
    // and the person's global ignore file). Git is asked about these names only. Listing
    // every ignored file instead would fill the cap with a tree like `node_modules` and
    // drop a later `.env`.
    let names: Vec<&str> = selected.iter().map(String::as_str).collect();
    let Some(ignored) = crate::fs::git_ignored_names(source, &names) else {
        return nothing_chosen(false);
    };
    let mut paths: Vec<String> = selected
        .into_iter()
        .filter(|path| ignored.contains(path))
        .collect();
    let mut stop = if selected_cut {
        Stop::Listing
    } else {
        Stop::None
    };
    if paths.len() > FILE_CAP {
        paths.truncate(FILE_CAP);
        stop = Stop::Cap;
    }
    Chosen {
        paths,
        stop,
        readable: true,
    }
}

/// `git`'s NUL-separated path list, and whether the list was cut short.
fn git_paths(root: &Path, args: &[&str], list_bytes: usize) -> Option<(Vec<String>, bool)> {
    let (bytes, capped) = crate::fs::git_output_capped(root, args, list_bytes, None)?;
    let complete = bytes.is_empty() || bytes.ends_with(&[0]);
    let mut parts: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    if !complete {
        // The cap can cut a path in half; half a path names nothing.
        parts.pop();
    }
    let paths = parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();
    Some((paths, capped || !complete))
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct IncludeOutcome {
    /// Set when named files are in the new worktree.
    pub note: Option<String>,
    /// Set when a listed path could not be copied. Never contains file contents.
    pub warning: Option<String>,
}

/// Copy the selected gitignored files from `source` into `dest`. Does not stage them
/// and does not remove the worktree when a copy fails.
pub(crate) fn apply(source: &Path, dest: &Path) -> IncludeOutcome {
    apply_with_list_cap(source, dest, LIST_BYTES)
}

/// [`apply`] with the listing cap passed in, so a test can use a small one.
fn apply_with_list_cap(source: &Path, dest: &Path, list_bytes: usize) -> IncludeOutcome {
    if !dest.is_dir() {
        return IncludeOutcome {
            note: None,
            warning: Some("Could not copy listed files into this worktree.".into()),
        };
    }
    let text = match read_manifest(source) {
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
        Manifest::Text(text) => manifest_text(&text),
    };
    let chosen = choose(source, &text, list_bytes);
    if !chosen.readable {
        return IncludeOutcome {
            note: None,
            warning: Some("Could not read .worktreeinclude.".into()),
        };
    }
    if chosen.paths.is_empty() && chosen.stop == Stop::None {
        return IncludeOutcome {
            note: None,
            warning: None,
        };
    }

    let mut copied = 0usize;
    let mut left = Vec::new();
    let mut failed = Vec::new();
    for relative in &chosen.paths {
        match place(source, dest, relative) {
            Place::Copied | Place::Already => copied += 1,
            Place::Left => left.push(relative.clone()),
            Place::Failed => failed.push(relative.clone()),
        }
    }
    IncludeOutcome {
        note: copied_note(copied),
        warning: warning_text(&failed, &left, chosen.stop),
    }
}

fn copied_note(copied: usize) -> Option<String> {
    match copied {
        0 => None,
        1 => Some("1 file named in .worktreeinclude is in this worktree.".into()),
        n => Some(format!(
            "{n} files named in .worktreeinclude are in this worktree."
        )),
    }
}

#[cfg(test)]
mod note_tests {
    // A regression guard in its own module so it runs with `cargo test --lib note`.
    #[test]
    fn the_note_never_claims_another_cli_will_not_have_the_files() {
        // Claude Code honours the same file for worktrees it makes itself, so the
        // old sentence ("A CLI that makes its own worktree will not have them") was
        // wrong. Any note the copy step can build must stay free of it.
        for copied in [0usize, 1, 2, 3, 100] {
            let note = super::copied_note(copied).unwrap_or_default();
            assert!(!note.contains("CLI"), "{note}");
            assert!(!note.contains("will not have"), "{note}");
        }
        let warning = super::warning_text(&[], &[], super::Stop::None).unwrap_or_default();
        assert!(!warning.contains("CLI"), "{warning}");
    }
}

fn warning_text(failed: &[String], left: &[String], stop: Stop) -> Option<String> {
    let mut parts = Vec::new();
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
    match stop {
        Stop::None => {}
        Stop::Cap => parts.push(format!(
            "Stopped after {FILE_CAP} files from .worktreeinclude."
        )),
        Stop::Listing => parts.push("Could not list every file named in .worktreeinclude.".into()),
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

enum Place {
    Copied,
    /// The same bytes are already there, so the worktree has the file either way.
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

#[cfg(test)]
mod tests {
    use super::*;

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

    /// A repo whose `.gitignore` is committed, so ignored files can exist beside it.
    fn repo_with_ignore(label: &str, ignore: &str) -> Tmp {
        let tmp = tmp(label);
        let root = tmp.0.join("repo");
        init_repo(&root);
        std::fs::write(root.join(".gitignore"), ignore).unwrap();
        git(&root, &["add", ".gitignore"]);
        commit(&root, "ignore");
        tmp
    }

    fn no_secret(text: &str) {
        assert!(!text.contains(SECRET), "{text}");
        assert!(!text.contains('—') && !text.contains('–'), "{text}");
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let dir =
            std::env::temp_dir().join(format!("monocode-include-missing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_manifest(&dir), Manifest::Missing);
        let dest = dir.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&dir, &dest);
        assert_eq!(outcome.note, None);
        assert_eq!(outcome.warning, None);
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

    #[test]
    fn a_manifest_with_a_nul_byte_is_not_read() {
        let dir =
            std::env::temp_dir().join(format!("monocode-include-nul-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".worktreeinclude"), ".env\0hidden\n").unwrap();
        assert_eq!(read_manifest(&dir), Manifest::Unreadable);
        let dest = dir.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&dir, &dest);
        assert_eq!(
            outcome.warning.as_deref(),
            Some("Could not read .worktreeinclude.")
        );
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

    #[test]
    fn create_copies_only_gitignored_files_named_in_the_manifest() {
        let tmp = repo_with_ignore("create", ".env\nlocal/\nnotes/\n");
        let root = tmp.0.join("repo");
        std::fs::write(root.join(".env"), SECRET).unwrap();
        // Untracked and not ignored: someone's work in progress, not ours to copy.
        std::fs::write(root.join("local.txt"), "local only\n").unwrap();
        std::fs::create_dir(root.join("local")).unwrap();
        std::fs::write(root.join("local").join("one.txt"), "one\n").unwrap();
        std::fs::create_dir(root.join("notes")).unwrap();
        std::fs::write(root.join("notes").join("a.md"), SECRET).unwrap();
        std::fs::write(
            root.join(".worktreeinclude"),
            // A BOM and CRLF line endings are accepted, and `local.txt` is listed
            // but not ignored, so it stays behind.
            "\u{feff}.env\r\nlocal/\r\nnotes/**/*.md\r\n# comment\r\nlocal.txt\r\n",
        )
        .unwrap();

        let tree = crate::worktrees::create(&root, "feature/include", "HEAD", false).unwrap();
        let dest = std::path::Path::new(&tree.path);
        assert_eq!(std::fs::read_to_string(dest.join(".env")).unwrap(), SECRET);
        assert_eq!(
            std::fs::read_to_string(dest.join("local").join("one.txt")).unwrap(),
            "one\n"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("notes").join("a.md")).unwrap(),
            SECRET
        );
        assert!(!dest.join("local.txt").exists());
        let cached = git(dest, &["diff", "--cached", "--name-only"]);
        assert!(cached.trim().is_empty(), "{cached}");
        let status = git(dest, &["status", "--porcelain"]);
        assert!(!dest.join("local.txt").exists(), "{status}");
        assert!(!status
            .lines()
            .any(|line| line.starts_with("A ") || line.starts_with("M ")));
        let note = tree.include_note.expect("note");
        no_secret(&note);
        assert_eq!(
            note,
            "3 files named in .worktreeinclude are in this worktree."
        );
        assert!(tree.include_warning.is_none());
        // Running it again finds the same bytes and does not rewrite them.
        let again = apply(&root, dest);
        assert_eq!(std::fs::read_to_string(dest.join(".env")).unwrap(), SECRET);
        assert!(again.note.is_some());
        assert!(git(dest, &["diff", "--cached", "--name-only"])
            .trim()
            .is_empty());
    }

    #[test]
    fn gitignore_patterns_support_negation_and_directories() {
        let tmp = repo_with_ignore("glob", "*.env\n*.log\nconfig/\n");
        let root = tmp.0.join("repo");
        std::fs::write(root.join("a.env"), SECRET).unwrap();
        std::fs::write(root.join("keep.env"), SECRET).unwrap();
        std::fs::write(root.join("debug.log"), SECRET).unwrap();
        std::fs::create_dir(root.join("config")).unwrap();
        std::fs::write(root.join("config").join("x.json"), "x\n").unwrap();
        std::fs::write(root.join("config").join("z.txt"), SECRET).unwrap();
        std::fs::write(
            root.join(".worktreeinclude"),
            "*.env\n!keep.env\n*.log\nconfig/**/*.json\nnope/*.txt\n",
        )
        .unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
        assert_eq!(std::fs::read_to_string(dest.join("a.env")).unwrap(), SECRET);
        assert_eq!(
            std::fs::read_to_string(dest.join("debug.log")).unwrap(),
            SECRET
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("config").join("x.json")).unwrap(),
            "x\n"
        );
        // `!keep.env` drops a match, and `config/z.txt` is ignored but not selected.
        assert!(!dest.join("keep.env").exists());
        assert!(!dest.join("config").join("z.txt").exists());
        // A pattern that matches nothing is not a warning.
        assert!(outcome.warning.is_none());
        let note = outcome.note.expect("note");
        no_secret(&note);
        assert!(note.contains("3 files"));
    }

    #[test]
    fn patterns_cannot_reach_outside_the_checkout() {
        let tmp = tmp("escape");
        let root = tmp.0.join("repo");
        init_repo(&root);
        std::fs::write(tmp.0.join("outside.txt"), SECRET).unwrap();
        std::fs::write(root.join(".env"), SECRET).unwrap();
        std::fs::write(root.join(".gitignore"), ".env\n").unwrap();
        git(&root, &["add", ".gitignore"]);
        commit(&root, "ignore");
        std::fs::write(
            root.join(".worktreeinclude"),
            "../outside.txt\n/outside.txt\nC:/Windows/win.ini\nC:\\Windows\\win.ini\nfoo\\..\\..\\outside.txt\n",
        )
        .unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
        // Nothing was copied: no pattern reached a file inside the checkout.
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 0);
        assert!(outcome.note.is_none());
        assert!(outcome.warning.is_none());
        // The same manifest still copies the file it can reach.
        std::fs::write(root.join(".worktreeinclude"), "../outside.txt\n.env\n").unwrap();
        let outcome = apply(&root, &dest);
        assert_eq!(std::fs::read_to_string(dest.join(".env")).unwrap(), SECRET);
        assert!(outcome.note.expect("note").contains("1 file"));
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
        // A tracked file is not a local file: git put it in the worktree already.
        assert!(tree.include_note.is_none());
        assert!(tree.include_warning.is_none());
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
    fn a_leading_slash_anchors_a_pattern_and_a_bare_name_matches_at_any_depth() {
        let tmp = repo_with_ignore("anchor", ".env\nsecret.txt\n");
        let root = tmp.0.join("repo");
        for path in [
            ".env",
            "server/.env",
            "secret.txt",
            "server/secret.txt",
            "a/b/secret.txt",
            "a/server/secret.txt",
        ] {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, SECRET).unwrap();
        }

        // `/.env` is the root file only; a bare `secret.txt` is found at every depth.
        std::fs::write(root.join(".worktreeinclude"), "/.env\nsecret.txt\n").unwrap();
        let first = tmp.0.join("first");
        std::fs::create_dir(&first).unwrap();
        let outcome = apply(&root, &first);
        for path in [".env", "secret.txt", "server/secret.txt", "a/b/secret.txt"] {
            assert!(first.join(path).is_file(), "{path} should be copied");
        }
        assert!(!first.join("server/.env").exists(), "/.env is anchored");
        assert_eq!(
            outcome.note.as_deref(),
            Some("5 files named in .worktreeinclude are in this worktree.")
        );

        // A bare `.env` is found at every depth; `server/secret.txt` has a slash in the
        // middle, so it is anchored to the root and `a/server/secret.txt` is not named.
        std::fs::write(root.join(".worktreeinclude"), ".env\nserver/secret.txt\n").unwrap();
        let second = tmp.0.join("second");
        std::fs::create_dir(&second).unwrap();
        let outcome = apply(&root, &second);
        for path in [".env", "server/.env", "server/secret.txt"] {
            assert!(second.join(path).is_file(), "{path} should be copied");
        }
        for path in ["secret.txt", "a/b/secret.txt", "a/server/secret.txt"] {
            assert!(!second.join(path).exists(), "{path} is not named");
        }
        assert_eq!(
            outcome.note.as_deref(),
            Some("3 files named in .worktreeinclude are in this worktree.")
        );
        assert!(outcome.warning.is_none());
    }

    #[test]
    fn a_tracked_file_that_is_also_ignored_is_not_copied() {
        let tmp = repo_with_ignore("forced", ".env\n");
        let root = tmp.0.join("repo");
        std::fs::write(root.join(".env"), "committed\n").unwrap();
        git(&root, &["add", "-f", ".env"]);
        commit(&root, "force the ignored file in");
        std::fs::write(root.join(".env"), SECRET).unwrap();
        std::fs::write(root.join(".worktreeinclude"), ".env\n").unwrap();
        let tree = crate::worktrees::create(&root, "feature/forced", "HEAD", false).unwrap();
        let dest = std::path::Path::new(&tree.path);
        // Git put the committed bytes there; the include does not replace them.
        assert_eq!(
            std::fs::read_to_string(dest.join(".env")).unwrap(),
            "committed\n"
        );
        assert!(tree.include_note.is_none());
        assert!(tree.include_warning.is_none());
    }

    #[test]
    fn a_missing_manifest_leaves_the_worktree_unchanged() {
        let tmp = tmp("absent");
        let root = tmp.0.join("repo");
        init_repo(&root);
        std::fs::write(root.join(".gitignore"), "only-here.txt\n").unwrap();
        git(&root, &["add", ".gitignore"]);
        commit(&root, "ignore");
        std::fs::write(root.join("only-here.txt"), SECRET).unwrap();
        let tree = crate::worktrees::create(&root, "feature/plain", "HEAD", false).unwrap();
        let dest = std::path::Path::new(&tree.path);
        assert!(!dest.join("only-here.txt").exists());
        assert!(tree.include_note.is_none());
        assert!(tree.include_warning.is_none());
    }

    #[test]
    fn comments_only_copies_nothing() {
        let tmp = repo_with_ignore("comments", ".env\n");
        let root = tmp.0.join("repo");
        std::fs::write(root.join(".env"), SECRET).unwrap();
        std::fs::write(root.join(".worktreeinclude"), "# nothing\n\n  # still\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
        assert!(outcome.note.is_none());
        assert!(outcome.warning.is_none());
        assert!(!dest.join(".env").exists());
    }

    #[test]
    fn copies_names_with_spaces_and_unicode() {
        let tmp = repo_with_ignore("names", "My Files/\ncafe\u{0301}.env\n");
        let root = tmp.0.join("repo");
        let notes = root.join("My Files");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("notes.txt"), "notes\n").unwrap();
        let cafe = "cafe\u{0301}.env".to_string();
        std::fs::write(root.join(&cafe), "cafe\n").unwrap();
        std::fs::write(
            root.join(".worktreeinclude"),
            format!("My Files/notes.txt\n{cafe}\n"),
        )
        .unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
        assert_eq!(
            std::fs::read_to_string(dest.join("My Files").join("notes.txt")).unwrap(),
            "notes\n"
        );
        // macOS stores names as they were written. The `.gitignore` names the composed
        // form git lists, so the decomposed spelling is not ignored and stays behind.
        assert!(!dest.join(&cafe).exists());
        let note = outcome.note.expect("note");
        no_secret(&note);
        assert!(note.contains("1 file"));
        assert!(outcome.warning.is_none());
    }

    #[test]
    fn an_existing_different_file_is_left_alone() {
        let tmp = repo_with_ignore("left", ".env\n");
        let root = tmp.0.join("repo");
        std::fs::write(root.join(".env"), SECRET).unwrap();
        std::fs::write(root.join(".worktreeinclude"), ".env\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join(".env"), "already here\n").unwrap();
        let outcome = apply(&root, &dest);
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
        let tmp = repo_with_ignore("cap", "many/\n");
        let root = tmp.0.join("repo");
        let many = root.join("many");
        std::fs::create_dir_all(&many).unwrap();
        for index in 0..=FILE_CAP {
            std::fs::write(many.join(format!("f{index}.txt")), SECRET).unwrap();
        }
        std::fs::write(root.join(".worktreeinclude"), "many\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
        let copied = std::fs::read_dir(dest.join("many")).unwrap().count();
        assert_eq!(copied, FILE_CAP);
        let note = outcome.note.expect("note");
        let warning = outcome.warning.expect("cap");
        no_secret(&note);
        no_secret(&warning);
        assert!(warning.contains("Stopped after 100 files"));
    }

    #[test]
    fn a_large_ignored_tree_does_not_hide_a_file_listed_after_it() {
        // `node_modules` is ignored and sorts before `server`. Asking git for every
        // ignored file would fill the listing cap with it and drop `server/.env`.
        let tmp = repo_with_ignore("big-ignored", "node_modules/\n.env\n");
        let root = tmp.0.join("repo");
        let modules = root.join("node_modules");
        std::fs::create_dir_all(&modules).unwrap();
        for index in 0..400 {
            std::fs::write(modules.join(format!("package-number-{index:04}.js")), "x\n").unwrap();
        }
        std::fs::create_dir(root.join("server")).unwrap();
        std::fs::write(root.join("server").join(".env"), SECRET).unwrap();
        std::fs::write(root.join(".env"), SECRET).unwrap();
        std::fs::write(root.join(".worktreeinclude"), ".env\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        // The whole ignored tree is about 14 KB of paths. The two files asked for are far under 4 KB.
        let outcome = apply_with_list_cap(&root, &dest, 4096);
        assert_eq!(std::fs::read_to_string(dest.join(".env")).unwrap(), SECRET);
        assert_eq!(
            std::fs::read_to_string(dest.join("server").join(".env")).unwrap(),
            SECRET
        );
        assert!(!dest.join("node_modules").exists());
        assert_eq!(outcome.warning, None);
        assert_eq!(
            outcome.note.as_deref(),
            Some("2 files named in .worktreeinclude are in this worktree.")
        );
    }

    #[test]
    fn a_pattern_list_too_long_to_read_whole_copies_what_it_read_and_says_so() {
        let tmp = repo_with_ignore("cut-list", "many/\n");
        let root = tmp.0.join("repo");
        let many = root.join("many");
        std::fs::create_dir_all(&many).unwrap();
        for index in 0..200 {
            std::fs::write(many.join(format!("file-number-{index:04}.txt")), SECRET).unwrap();
        }
        std::fs::write(root.join(".worktreeinclude"), "many/\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply_with_list_cap(&root, &dest, 1024);
        let copied = std::fs::read_dir(dest.join("many")).unwrap().count();
        assert!(copied > 0 && copied < 200, "{copied}");
        // A path cut in half names nothing, so every file that was copied is a whole file.
        for entry in std::fs::read_dir(dest.join("many")).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(
                name.starts_with("file-number-") && name.ends_with(".txt"),
                "{name}"
            );
            assert_eq!(name.len(), "file-number-0000.txt".len(), "{name}");
        }
        let warning = outcome.warning.expect("warning");
        no_secret(&warning);
        assert!(warning.contains("Could not list every file"), "{warning}");
        assert!(outcome.note.is_some());
    }

    #[test]
    fn a_source_that_is_not_a_repository_copies_nothing_and_says_so() {
        let tmp = tmp("norepo");
        let source = tmp.0.join("source");
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(source.join(".env"), SECRET).unwrap();
        std::fs::write(source.join(".worktreeinclude"), ".env\n").unwrap();
        let outcome = apply(&source, &dest);
        assert!(!dest.join(".env").exists());
        assert_eq!(
            outcome.warning.as_deref(),
            Some("Could not read .worktreeinclude.")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_not_followed_and_the_mode_is_kept() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let tmp = repo_with_ignore("link", "linked.env\ndir/\nkept.env\n");
        let root = tmp.0.join("repo");
        let outside = tmp.0.join("outside");
        std::fs::write(&outside, SECRET).unwrap();
        symlink(&outside, root.join("linked.env")).unwrap();
        std::fs::create_dir(root.join("dir")).unwrap();
        std::fs::write(root.join("dir").join("ok.txt"), "ok\n").unwrap();
        symlink(&outside, root.join("dir").join("skip")).unwrap();
        let kept = root.join("kept.env");
        std::fs::write(&kept, "mode\n").unwrap();
        std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o640)).unwrap();
        std::fs::write(root.join(".worktreeinclude"), "linked.env\ndir\nkept.env\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
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
