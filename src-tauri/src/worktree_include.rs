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

/// At most this many bytes are copied in all. A file that would pass it is skipped and
/// reported, so a stray build output named by a pattern cannot fill the disk.
const BYTE_CAP: u64 = 50 * 1024 * 1024;

/// How many file names a note or warning spells out before it says how many more.
const NAMED_FILES: usize = 3;

/// A warning longer than this is rebuilt with counts, so it always fits the one line
/// the window keeps (worktreeIncludeNote.ts keeps up to 600 characters).
const WARNING_CHARS: usize = 500;

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
    apply_with(source, dest, LIST_BYTES, BYTE_CAP)
}

/// The top folder of the repository that holds `dir`. A project can be a subfolder of
/// its repository, and the worktree is made of the whole repository, so the file, the
/// listing and the copy all work from the top. `None` when git cannot say.
fn repo_top(dir: &Path) -> Option<PathBuf> {
    let (bytes, capped) =
        crate::fs::git_output_capped(dir, &["rev-parse", "--show-toplevel"], 16 * 1024, None)?;
    if capped {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    let line = text.strip_suffix('\n').unwrap_or(&text);
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.is_empty() {
        return None;
    }
    let top = PathBuf::from(line);
    top.is_dir().then_some(top)
}

/// [`apply`] with the listing cap and the byte cap passed in, so a test can use small ones.
fn apply_with(source: &Path, dest: &Path, list_bytes: usize, byte_cap: u64) -> IncludeOutcome {
    if !dest.is_dir() {
        return IncludeOutcome {
            note: None,
            warning: Some("Could not copy listed files into this worktree.".into()),
        };
    }
    // Not a repository (or git cannot answer): the manifest is looked for where the
    // project is, and the listing below then says it could not read it.
    let top = repo_top(source).unwrap_or_else(|| source.to_path_buf());
    let text = match read_manifest(&top) {
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
    let chosen = choose(&top, &text, list_bytes);
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
    let mut unplaced = Unplaced::default();
    let mut budget = byte_cap;
    for relative in &chosen.paths {
        // WP-248: an agent's settings (saved approvals, which can hold passwords typed in commands, hooks, logins)
        // never travel into a new worktree, whatever the file names.
        if crate::commit_guard::is_agent_settings_file(relative) {
            unplaced.agent.push(relative.clone());
            continue;
        }
        match place(&top, dest, relative, &mut budget) {
            Place::Copied | Place::Already => copied += 1,
            Place::Left => unplaced.left.push(relative.clone()),
            Place::Failed => unplaced.failed.push(relative.clone()),
            Place::TooBig => unplaced.too_big.push(relative.clone()),
        }
    }
    IncludeOutcome {
        note: copied_note(copied),
        warning: warning_text(&unplaced, chosen.stop, byte_cap),
    }
}

/// The listed files that did not end up in the worktree, and why.
#[derive(Default)]
struct Unplaced {
    failed: Vec<String>,
    left: Vec<String>,
    too_big: Vec<String>,
    /// WP-248: agent settings files the manifest names, which are never copied.
    agent: Vec<String>,
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
        let warning = super::warning_text(&super::Unplaced::default(), super::Stop::None, 1 << 20)
            .unwrap_or_default();
        assert!(!warning.contains("CLI"), "{warning}");
    }
}

fn warning_text(unplaced: &Unplaced, stop: Stop, byte_cap: u64) -> Option<String> {
    let named = warning_parts(unplaced, stop, byte_cap, true).join(" ");
    if named.chars().count() <= WARNING_CHARS {
        return (!named.is_empty()).then_some(named);
    }
    // Names that are long and many would not fit the one line the window keeps: say how
    // many instead.
    let counted = warning_parts(unplaced, stop, byte_cap, false).join(" ");
    (!counted.is_empty()).then_some(counted)
}

fn warning_parts(unplaced: &Unplaced, stop: Stop, byte_cap: u64, name: bool) -> Vec<String> {
    let Unplaced {
        failed,
        left,
        too_big,
        agent,
    } = unplaced;
    let mut parts = Vec::new();
    if !agent.is_empty() {
        parts.push(match (name, agent.len()) {
            (true, _) => format!(
                "Did not copy {}: an agent's settings stay out of new worktrees.",
                name_files(agent)
            ),
            (false, 1) => "Did not copy 1 agent settings file.".to_string(),
            (false, n) => format!("Did not copy {n} agent settings files."),
        });
    }
    if !failed.is_empty() {
        parts.push(if name {
            format!("Could not copy {} into this worktree.", name_files(failed))
        } else {
            format!(
                "Could not copy {} listed files into this worktree.",
                failed.len()
            )
        });
    }
    if !left.is_empty() {
        parts.push(match (name, left.len()) {
            (true, 1) => format!("Left {} as it was.", name_files(left)),
            (true, _) => format!("Left {} as they were.", name_files(left)),
            (false, 1) => "Left 1 file as it was.".to_string(),
            (false, n) => format!("Left {n} files as they were."),
        });
    }
    if !too_big.is_empty() {
        let limit = byte_limit_text(byte_cap);
        parts.push(if name {
            format!(
                "Skipped {} to stay under the {limit} limit.",
                name_files(too_big)
            )
        } else {
            format!(
                "Skipped {} files to stay under the {limit} limit.",
                too_big.len()
            )
        });
    }
    match stop {
        Stop::None => {}
        Stop::Cap => parts.push(format!(
            "Stopped after {FILE_CAP} files from .worktreeinclude."
        )),
        Stop::Listing => parts.push("Could not list every file named in .worktreeinclude.".into()),
    }
    parts
}

/// "50 MB" for the real cap. A cap that is not a whole number of megabytes is only a
/// test's, and is shown in bytes.
fn byte_limit_text(cap: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if cap >= MB && cap.is_multiple_of(MB) {
        format!("{} MB", cap / MB)
    } else {
        format!("{cap} byte")
    }
}

/// Up to [`NAMED_FILES`] names, then how many more: "a", "a and b", "a, b and c",
/// "a, b, c and 4 more".
fn name_files(paths: &[String]) -> String {
    let shown: Vec<String> = paths
        .iter()
        .take(NAMED_FILES)
        .map(|p| show_path(p))
        .collect();
    let more = paths.len().saturating_sub(NAMED_FILES);
    let mut text = match shown.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [first @ .., last] if more == 0 => format!("{} and {last}", first.join(", ")),
        all => all.join(", "),
    };
    if more > 0 {
        text.push_str(&format!(" and {more} more"));
    }
    text
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
    /// Copying it would pass the byte cap.
    TooBig,
}

/// Open a file for reading without following a link, and without waiting on a pipe.
/// A path checked a moment ago can be swapped for a link, so the open itself refuses one.
fn open_source(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NONBLOCK so a pipe swapped in for the file cannot hold the open forever.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: a link is opened as itself, and refused below.
        options.custom_flags(0x0020_0000);
    }
    options.open(path)
}

/// Whether two handles name the same file. Windows has no cheap answer in std, so the
/// link refusal at open time is what it relies on.
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right);
        true
    }
}

/// The source file, opened and checked after it was opened: a regular file, not a link,
/// still the file at the checked path, and still inside `source`.
fn open_checked(source: &Path, relative: &str) -> Result<(std::fs::File, std::fs::Metadata), ()> {
    let from = located(source, relative)?;
    let file = open_source(&from).map_err(|_| ())?;
    let opened = file.metadata().map_err(|_| ())?;
    if !opened.is_file() {
        return Err(());
    }
    // The path is checked again now that the file is open, so a folder swapped for a
    // link between the first check and the open is caught here.
    let again = located(source, relative)?;
    let now = std::fs::symlink_metadata(&again).map_err(|_| ())?;
    if again != from || now.file_type().is_symlink() || !same_file(&opened, &now) {
        return Err(());
    }
    Ok((file, opened))
}

/// The permission bits a copy is created with: the source's own, so a secret that is
/// private there is private from the first byte.
#[cfg(unix)]
fn mode_bits(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o777
}

/// A new file at `path` that is already private when it is empty, with the source's mode.
/// Fails when the file exists.
fn create_new_like(path: &Path, source: &std::fs::Metadata) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode_bits(source));
    }
    #[cfg(not(unix))]
    {
        let _ = source;
    }
    options.open(path)
}

fn place(source: &Path, dest: &Path, relative: &str, budget: &mut u64) -> Place {
    let (mut input, src_meta) = match open_checked(source, relative) {
        Ok(opened) => opened,
        Err(()) => return Place::Failed,
    };
    if ensure_parents(source, dest, relative).is_err() {
        return Place::Failed;
    }
    let to = match located(dest, relative) {
        Ok(path) => path,
        Err(()) => return Place::Failed,
    };
    // A file that is already there costs nothing, so only a new copy is held to the cap.
    let is_new = matches!(
        std::fs::symlink_metadata(&to),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    );
    if is_new && src_meta.len() > *budget {
        return Place::TooBig;
    }
    match create_new_like(&to, &src_meta) {
        Ok(mut out) => {
            // One byte more than the budget is read, so a file that grew since it was
            // measured is caught instead of copied whole.
            let mut limited = std::io::Read::take(&mut input, budget.saturating_add(1));
            let copied = match std::io::copy(&mut limited, &mut out) {
                Ok(copied) => copied,
                Err(_) => {
                    drop(out);
                    let _ = std::fs::remove_file(&to);
                    return Place::Failed;
                }
            };
            drop(out);
            if copied > *budget {
                let _ = std::fs::remove_file(&to);
                return Place::TooBig;
            }
            *budget -= copied;
            #[cfg(unix)]
            {
                // The mode the source has, even where the umask would have narrowed it.
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    &to,
                    std::fs::Permissions::from_mode(mode_bits(&src_meta)),
                );
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
            drop(input);
            let from = match located(source, relative) {
                Ok(path) => path,
                Err(()) => return Place::Failed,
            };
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

/// The folders above `relative` in `dest`. A folder made here gets the mode its source
/// folder has (with the owner able to write, so the files can be placed in it).
fn ensure_parents(source: &Path, dest: &Path, relative: &str) -> Result<(), ()> {
    let root = crate::fs::canonical(dest).map_err(|_| ())?;
    let source_root = crate::fs::canonical(source).map_err(|_| ())?;
    let mut cur = root.clone();
    let mut from = source_root;
    let parts: Vec<&str> = relative
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() <= 1 {
        return Ok(());
    }
    for part in &parts[..parts.len() - 1] {
        cur.push(part);
        from.push(part);
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
                make_dir_like(&cur, &from)?;
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

/// Make one folder with the mode of the folder it mirrors. The owner can always write,
/// or the files that follow could not be placed in it.
fn make_dir_like(path: &Path, like: &Path) -> Result<(), ()> {
    // `mut` is only needed where the mode is set.
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let meta = std::fs::symlink_metadata(like).map_err(|_| ())?;
        builder.mode(mode_bits(&meta) | 0o700);
    }
    #[cfg(not(unix))]
    {
        let _ = like;
    }
    builder.create(path).map_err(|_| ())
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
        let mut command = crate::git_cmd::git();
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
    fn a_project_folder_below_the_repository_top_is_worked_from_the_top() {
        let tmp = repo_with_ignore("sub", "app/.env\nsecret.txt\n");
        let root = tmp.0.join("repo");
        let app = root.join("app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("main.txt"), "tracked\n").unwrap();
        git(&root, &["add", "app/main.txt"]);
        commit(&root, "app");
        std::fs::write(app.join(".env"), SECRET).unwrap();
        std::fs::write(root.join("secret.txt"), SECRET).unwrap();
        // The file at the top names paths from the top. One below it is not read.
        std::fs::write(root.join(".worktreeinclude"), "app/.env\nsecret.txt\n").unwrap();
        std::fs::write(app.join(".worktreeinclude"), ".env\n").unwrap();

        // The project is the `app` folder, not the repository.
        let tree = crate::worktrees::create(&app, "feature/sub", "HEAD", false).unwrap();
        let dest = std::path::Path::new(&tree.path);
        assert_eq!(
            std::fs::read_to_string(dest.join("app").join(".env")).unwrap(),
            SECRET
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("secret.txt")).unwrap(),
            SECRET
        );
        // Not at the top of the worktree, where the repository does not ignore it and a
        // `git add -A` would commit it.
        assert!(!dest.join(".env").exists());
        let status = git(dest, &["status", "--porcelain"]);
        assert!(status.trim().is_empty(), "{status}");
        assert_eq!(
            tree.include_note.as_deref(),
            Some("2 files named in .worktreeinclude are in this worktree.")
        );

        // Only a file below the top: nothing is read from it.
        std::fs::remove_file(root.join(".worktreeinclude")).unwrap();
        let other = tmp.0.join("other");
        std::fs::create_dir(&other).unwrap();
        let outcome = apply(&app, &other);
        assert_eq!(std::fs::read_dir(&other).unwrap().count(), 0);
        assert!(outcome.note.is_none());
        assert!(outcome.warning.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_private_file_is_private_from_the_moment_it_exists() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tmp("private");
        let from = tmp.0.join("source.env");
        std::fs::write(&from, SECRET).unwrap();
        std::fs::set_permissions(&from, std::fs::Permissions::from_mode(0o600)).unwrap();
        let meta = std::fs::symlink_metadata(&from).unwrap();
        let to = tmp.0.join("copy.env");
        let created = create_new_like(&to, &meta).unwrap();
        // Nothing is written yet, and it is already private.
        let seen = std::fs::metadata(&to).unwrap();
        assert_eq!(seen.len(), 0);
        assert_eq!(seen.permissions().mode() & 0o777, 0o600);
        drop(created);
    }

    #[cfg(unix)]
    #[test]
    fn copies_and_the_folders_made_for_them_keep_their_source_modes() {
        use std::os::unix::fs::PermissionsExt;
        let mode =
            |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let tmp = repo_with_ignore("modes", ".env\nsecrets/\n");
        let root = tmp.0.join("repo");
        let inner = root.join("secrets").join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(root.join(".env"), SECRET).unwrap();
        std::fs::write(inner.join("key"), SECRET).unwrap();
        std::fs::write(root.join("secrets").join("run.sh"), "#!/bin/sh\n").unwrap();
        for (path, bits) in [
            (root.join(".env"), 0o600),
            (inner.join("key"), 0o600),
            (root.join("secrets").join("run.sh"), 0o755),
            (inner.clone(), 0o700),
            (root.join("secrets"), 0o700),
        ] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(bits)).unwrap();
        }
        std::fs::write(root.join(".worktreeinclude"), ".env\nsecrets/\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
        assert!(outcome.warning.is_none(), "{:?}", outcome.warning);
        assert_eq!(mode(&dest.join(".env")), 0o600);
        assert_eq!(mode(&dest.join("secrets").join("inner").join("key")), 0o600);
        assert_eq!(mode(&dest.join("secrets").join("run.sh")), 0o755);
        assert_eq!(mode(&dest.join("secrets")), 0o700);
        assert_eq!(mode(&dest.join("secrets").join("inner")), 0o700);
    }

    #[test]
    fn files_past_the_byte_cap_are_skipped_and_named() {
        let tmp = repo_with_ignore("bytes", "*.bin\n");
        let root = tmp.0.join("repo");
        std::fs::write(root.join("a.bin"), "aaaaaa").unwrap();
        std::fs::write(root.join("b.bin"), "bbbbbb").unwrap();
        std::fs::write(root.join("c.bin"), "ccc").unwrap();
        std::fs::write(root.join(".worktreeinclude"), "*.bin\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        // Ten bytes in all: `a.bin` fits, `b.bin` would pass the cap, `c.bin` still fits.
        let outcome = apply_with(&root, &dest, LIST_BYTES, 10);
        assert!(dest.join("a.bin").is_file());
        assert!(!dest.join("b.bin").exists());
        assert!(dest.join("c.bin").is_file());
        assert_eq!(
            outcome.note.as_deref(),
            Some("2 files named in .worktreeinclude are in this worktree.")
        );
        assert_eq!(
            outcome.warning.as_deref(),
            Some("Skipped b.bin to stay under the 10 byte limit.")
        );
    }

    #[test]
    fn the_real_byte_cap_is_fifty_megabytes() {
        let tmp = repo_with_ignore("bigbytes", "*.bin\n");
        let root = tmp.0.join("repo");
        // A sparse file one byte over the cap: it is measured, never read.
        let big = std::fs::File::create(root.join("big.bin")).unwrap();
        big.set_len(BYTE_CAP + 1).unwrap();
        drop(big);
        std::fs::write(root.join("small.bin"), "small").unwrap();
        std::fs::write(root.join(".worktreeinclude"), "*.bin\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
        assert!(!dest.join("big.bin").exists());
        assert_eq!(
            std::fs::read_to_string(dest.join("small.bin")).unwrap(),
            "small"
        );
        assert_eq!(
            outcome.warning.as_deref(),
            Some("Skipped big.bin to stay under the 50 MB limit.")
        );
    }

    #[test]
    fn a_warning_names_the_files_it_is_about() {
        let names = |count: usize| -> Vec<String> {
            ["a.env", "b.env", "c.env", "d.env", "e.env"][..count]
                .iter()
                .map(|name| name.to_string())
                .collect()
        };
        let warn = |unplaced: Unplaced| warning_text(&unplaced, Stop::None, BYTE_CAP).unwrap();
        let failed = |count| Unplaced {
            failed: names(count),
            ..Default::default()
        };
        assert_eq!(warn(failed(1)), "Could not copy a.env into this worktree.");
        assert_eq!(
            warn(failed(2)),
            "Could not copy a.env and b.env into this worktree."
        );
        assert_eq!(
            warn(failed(3)),
            "Could not copy a.env, b.env and c.env into this worktree."
        );
        assert_eq!(
            warn(failed(5)),
            "Could not copy a.env, b.env, c.env and 2 more into this worktree."
        );
        assert_eq!(
            warn(Unplaced {
                left: names(2),
                ..Default::default()
            }),
            "Left a.env and b.env as they were."
        );
        // Names too long for the one line the window keeps are counted instead.
        let long: Vec<String> = (0..5).map(|n| format!("{n}{}", "x".repeat(110))).collect();
        let text = warn(Unplaced {
            failed: long.clone(),
            left: long.clone(),
            too_big: long,
            agent: Vec::new(),
        });
        assert!(text.chars().count() <= WARNING_CHARS, "{text}");
        assert!(text.starts_with("Could not copy 5 listed files into this worktree."));
        no_secret(&text);
    }

    /// WP-248: a manifest that names an agent's settings (saved approvals, hooks, a login) never copies them into a
    /// new worktree, even when git ignores them. The project's own files still come across.
    #[test]
    fn agent_settings_files_are_never_copied() {
        let tmp = repo_with_ignore(
            "agent",
            ".claude/
.codex/
*.env
",
        );
        let root = tmp.0.join("repo");
        for rel in [
            ".claude/settings.local.json",
            ".claude/settings.json",
            ".claude/projects/app/session.jsonl",
            ".codex/config.toml",
            ".codex/auth.json",
        ] {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, SECRET).unwrap();
        }
        std::fs::write(
            root.join("app.env"),
            "PORT=1
",
        )
        .unwrap();
        std::fs::write(
            root.join(".worktreeinclude"),
            ".claude/
.codex/
*.env
",
        )
        .unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
        assert!(
            dest.join("app.env").is_file(),
            "the project's own file is copied"
        );
        for rel in [
            ".claude/settings.local.json",
            ".claude/settings.json",
            ".claude/projects/app/session.jsonl",
            ".codex/config.toml",
            ".codex/auth.json",
        ] {
            assert!(!dest.join(rel).exists(), "{rel} was copied");
        }
        assert_eq!(
            outcome.note.as_deref(),
            Some("1 file named in .worktreeinclude is in this worktree.")
        );
        let warning = outcome.warning.unwrap_or_default();
        assert!(warning.starts_with("Did not copy "), "{warning}");
        assert!(
            warning.contains("an agent's settings stay out of new worktrees"),
            "{warning}"
        );
        no_secret(&warning);
    }

    #[test]
    fn the_agent_settings_rule_names_only_agent_files() {
        use crate::commit_guard::is_agent_settings_file as agent;
        for path in [
            ".claude/settings.local.json",
            "sub/.claude/settings.local.json",
            ".claude/settings.json",
            ".Claude/Settings.Local.json",
            ".cursor/mcp.json",
            ".codex/config.toml",
            ".claude/.credentials.json",
            ".claude.json",
            ".claude/projects/x/y.jsonl",
        ] {
            assert!(agent(path), "{path} must be denied");
        }
        for path in [
            ".env",
            ".env.local",
            "config/settings.local.json",
            "settings.json",
            "src/auth.json",
            "node_modules/pkg/config.toml",
            ".mcp.json",
        ] {
            assert!(!agent(path), "{path} must be copied");
        }
    }

    #[test]
    fn two_files_left_as_they_were_are_both_named() {
        let tmp = repo_with_ignore("left2", "*.env\n");
        let root = tmp.0.join("repo");
        std::fs::write(root.join("a.env"), SECRET).unwrap();
        std::fs::write(root.join("b.env"), SECRET).unwrap();
        std::fs::write(root.join(".worktreeinclude"), "*.env\n").unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.env"), "already\n").unwrap();
        std::fs::write(dest.join("b.env"), "here\n").unwrap();
        let outcome = apply(&root, &dest);
        assert!(outcome.note.is_none());
        assert_eq!(
            outcome.warning.as_deref(),
            Some("Left a.env and b.env as they were.")
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_source_is_opened_without_following_a_link_or_waiting_on_a_pipe() {
        let tmp = tmp("open");
        let root = tmp.0.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("real.txt"), SECRET).unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();
        // The open itself refuses a link, even one that points at a file in the project.
        assert!(open_source(&root.join("link.txt")).is_err());
        assert!(open_source(&root.join("real.txt")).is_ok());
        assert!(open_checked(&root, "real.txt").is_ok());

        // A pipe swapped in for the file is refused after it is opened, and the open
        // does not wait for a writer.
        let pipe = std::ffi::CString::new(root.join("pipe").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
        let (sender, receiver) = std::sync::mpsc::channel();
        let looked_in = root.clone();
        std::thread::spawn(move || {
            let _ = sender.send(open_checked(&looked_in, "pipe").is_err());
        });
        assert_eq!(
            receiver.recv_timeout(std::time::Duration::from_secs(10)),
            Ok(true),
            "opening a pipe waited or was accepted"
        );
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
        // Composed characters only: macOS lists a name in its composed form and Linux as
        // it was written, so a decomposed name behaves differently on the two. A composed
        // one, and a name with no combining marks at all, is found the same way everywhere.
        let cafe = "caf\u{e9}.env";
        let nihon = "\u{65e5}\u{672c}\u{8a9e}";
        let tmp = repo_with_ignore("names", &format!("My Files/\n{cafe}\n{nihon}/\n"));
        let root = tmp.0.join("repo");
        let notes = root.join("My Files");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("notes.txt"), "notes\n").unwrap();
        std::fs::write(root.join(cafe), "cafe\n").unwrap();
        std::fs::create_dir_all(root.join(nihon)).unwrap();
        std::fs::write(root.join(nihon).join("a.txt"), "nihon\n").unwrap();
        std::fs::write(
            root.join(".worktreeinclude"),
            format!("My Files/notes.txt\n{cafe}\n{nihon}/\n"),
        )
        .unwrap();
        let dest = tmp.0.join("dest");
        std::fs::create_dir(&dest).unwrap();
        let outcome = apply(&root, &dest);
        assert_eq!(
            std::fs::read_to_string(dest.join("My Files").join("notes.txt")).unwrap(),
            "notes\n"
        );
        assert_eq!(std::fs::read_to_string(dest.join(cafe)).unwrap(), "cafe\n");
        assert_eq!(
            std::fs::read_to_string(dest.join(nihon).join("a.txt")).unwrap(),
            "nihon\n"
        );
        let note = outcome.note.expect("note");
        no_secret(&note);
        assert_eq!(
            note,
            "3 files named in .worktreeinclude are in this worktree."
        );
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
        let outcome = apply_with(&root, &dest, 4096, BYTE_CAP);
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
        let outcome = apply_with(&root, &dest, 1024, BYTE_CAP);
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
