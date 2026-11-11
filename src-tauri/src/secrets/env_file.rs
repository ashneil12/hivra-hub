//! WP-92: the other route, a gitignored `.env` in one worktree, on the person's tap.
//!
//! No tool writes a file; neither `secrets.run` nor a worker's environment route ever touches the disk. This module is
//! reached only by the Secrets page's own command.
//!
//! Before the value is read, in this order: the worktree belongs to the project (the app's own worktree list); it is a
//! repo root (`git rev-parse --show-toplevel`, canonicalised); `.env` is ignored ([`crate::fs::git_ignored_names`]);
//! `.env` is not tracked (an ignored file already in the index still commits); the target is a plain file or absent (a
//! symlink is refused without being followed). Then the value must be one line without a single quote.
//!
//! The write keeps every other line byte for byte, replaces one `NAME=` line in place, refuses two, keeps the file's own
//! line endings, creates a new file 0600 where the platform has modes, and goes through a temp file in the same folder.
//! It is refused if the file changed between the check and the write.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// A checked `.env`: where it is, and the hash of what was read so the write can prove nothing changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub root: PathBuf,
    pub path: PathBuf,
    pub hash: String,
}

pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn same_path(a: &Path, b: &Path) -> bool {
    let a = crate::fs::canonical(a).unwrap_or_else(|_| a.to_path_buf());
    let b = crate::fs::canonical(b).unwrap_or_else(|_| b.to_path_buf());
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// `cwd` resolves inside `project`. The project's canonical form is the only root allowed.
pub fn inside_project(project: &str, cwd: &str) -> Result<String, String> {
    let project = crate::fs::canonical(crate::fs::expand_home(project.trim()))
        .map_err(|_| "That project folder isn't there.".to_string())?;
    let cwd = crate::fs::canonical(crate::fs::expand_home(cwd.trim()))
        .map_err(|_| "That folder isn't there.".to_string())?;
    if !cwd.starts_with(&project) {
        return Err("That folder is outside the project.".into());
    }
    Ok(crate::fs::path_to_js(&cwd))
}

/// Steps 1 to 5: nothing here reads the secret. `project` is the chat's project folder; `worktree` is one path from the
/// app's own list.
pub fn check(project: &str, worktree: &str) -> Result<Target, String> {
    let project_root = crate::fs::canonical(crate::fs::expand_home(project.trim()))
        .map_err(|_| "That project folder isn't there.".to_string())?;
    let root = crate::fs::canonical(crate::fs::expand_home(worktree.trim()))
        .map_err(|_| "That worktree isn't there.".to_string())?;
    if !root.is_dir() {
        return Err("That worktree isn't there.".into());
    }
    // 1. the worktree is one the project owns, from the app's records (the project itself or one of its worktrees).
    let owned = same_path(&root, &project_root)
        || crate::worktrees::list(&project_root)
            .map(|list| {
                list.into_iter()
                    .any(|tree| same_path(Path::new(&tree.path), &root))
            })
            .unwrap_or(false);
    if !owned {
        return Err("That folder isn't one of this project's worktrees.".into());
    }
    // 2. it is a repo root, and the target sits directly in it.
    let toplevel =
        crate::fs::git_output_capped(&root, &["rev-parse", "--show-toplevel"], 16_384, None)
            .ok_or_else(|| "That worktree isn't a git checkout.".to_string())?;
    let toplevel = PathBuf::from(String::from_utf8_lossy(&toplevel.0).trim());
    let toplevel = crate::fs::canonical(&toplevel)
        .map_err(|_| "That worktree isn't a git checkout.".to_string())?;
    if !same_path(&toplevel, &root) {
        return Err(
            "The folder's git root is somewhere else. Pick the checkout's own folder.".into(),
        );
    }
    // 3. `.env` is ignored. If git can't answer, nothing is written.
    let ignored = crate::fs::git_ignored_names(&root, &[".env"])
        .ok_or_else(|| "Couldn't check that git ignores `.env` here.".to_string())?;
    if !ignored.iter().any(|name| name == ".env") {
        return Err("Git would commit this .env. Add `.env` to `.gitignore` first.".into());
    }
    // 4. it is not tracked: an ignored file already in the index still commits.
    if crate::fs::git_output_capped(
        &root,
        &["ls-files", "--error-unmatch", "--", ".env"],
        16_384,
        None,
    )
    .is_some()
    {
        return Err(
            "Git already tracks this .env, so it would commit it. Remove it from git first.".into(),
        );
    }
    // 5. the target is a plain file or absent; a symlink is refused without being followed.
    let path = root.join(".env");
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(
                    "That .env is a link to somewhere else, so nothing was written.".into(),
                );
            }
            if !meta.is_file() {
                return Err("That .env isn't a plain file, so nothing was written.".into());
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return Err("Couldn't look at that .env.".into()),
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err("Couldn't read that .env.".into()),
    };
    let hash = hash(&bytes);
    Ok(Target { root, path, hash })
}

/// A value this route can write: one line, no single quote. Anything else points at the command route.
pub fn writable_value(value: &str) -> Result<(), String> {
    if value.contains('\n') || value.contains('\r') {
        return Err(
            "That key has more than one line, so it can't go in a .env. Use the command route for it."
                .into(),
        );
    }
    if value.contains('\'') {
        return Err(
            "That key has a single quote, so it can't go in a .env safely. Use the command route for it."
                .into(),
        );
    }
    Ok(())
}

/// `NAME=value`, single-quoted only when the value holds a space, `#`, `$`, `!` or unicode.
pub fn line_for(env_name: &str, value: &str) -> String {
    let quote = value
        .chars()
        .any(|c| matches!(c, ' ' | '#' | '$' | '!') || !c.is_ascii());
    if quote {
        format!("{env_name}='{value}'")
    } else {
        format!("{env_name}={value}")
    }
}

/// The value a line holds, when it is this name's line.
fn line_value<'a>(line: &'a str, env_name: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(env_name)?.strip_prefix('=')?;
    if rest.len() >= 2 && rest.starts_with('\'') && rest.ends_with('\'') {
        Some(&rest[1..rest.len() - 1])
    } else {
        Some(rest)
    }
}

fn eol_of(bytes: &[u8]) -> &'static [u8] {
    if bytes.windows(2).any(|pair| pair == b"\r\n") {
        b"\r\n"
    } else {
        b"\n"
    }
}

/// The lines' byte ranges, without their terminator.
fn line_ranges(bytes: &[u8]) -> Vec<(usize, usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            let mut end = index;
            if end > start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            out.push((start, end, index + 1));
            start = index + 1;
        }
    }
    if start < bytes.len() {
        out.push((start, bytes.len(), bytes.len()));
    }
    out
}

fn replace_lines(bytes: &[u8], replacements: &[(usize, usize, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 64);
    let mut at = 0;
    for (start, end, replacement) in replacements {
        out.extend_from_slice(&bytes[at..*start]);
        out.extend_from_slice(replacement);
        at = *end;
    }
    out.extend_from_slice(&bytes[at..]);
    out
}

/// Whether other accounts on this Mac can read this file (group or world readable). Where the platform has no modes the
/// answer is no.
pub fn readable_by_others(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o044 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// Where the temp file goes. Its name starts `.env.tmp-`, so a `.env*` ignore rule covers it; when the person's rules
/// only name `.env`, it goes into git's own folder instead, where `git add -A` can never reach it. (A rename from there
/// is atomic on the same volume, which a worktree and its git folder share.)
fn temp_path(root: &Path) -> PathBuf {
    let name = format!(".env.tmp-{}", uuid::Uuid::new_v4().simple());
    let ignored = crate::fs::git_ignored_names(root, &[name.as_str()])
        .is_some_and(|names| names.iter().any(|ignored| *ignored == name));
    if ignored {
        return root.join(name);
    }
    match crate::fs::git_output_capped(root, &["rev-parse", "--absolute-git-dir"], 16_384, None) {
        Some((out, ..)) => {
            let dir = PathBuf::from(String::from_utf8_lossy(&out).trim());
            if dir.is_dir() {
                return dir.join(name);
            }
            root.join(name)
        }
        None => root.join(name),
    }
}

/// Removes the temp file on every way out, a panic included, unless the rename took it.
struct TempGuard {
    path: PathBuf,
    armed: bool,
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Rewrite the file through a temp file on the same volume, then rename.
fn replace_file(target: &Target, bytes: &[u8]) -> Result<(), String> {
    if is_symlink(&target.path) {
        return Err("That .env became a link, so nothing was written.".into());
    }
    let first = temp_path(&target.root);
    let beside = target.root.join(
        first
            .file_name()
            .map(|name| name.to_os_string())
            .unwrap_or_default(),
    );
    // A temp in git's folder that cannot be renamed into place (another volume) falls back to one beside the file.
    let mut places = vec![first.clone()];
    if beside != first {
        places.push(beside);
    }
    let mut last = Err("Couldn't write that .env.".to_string());
    for temp in places {
        last = write_through(&temp, target, bytes);
        if last.is_ok() {
            break;
        }
    }
    last
}

fn write_through(temp: &Path, target: &Target, bytes: &[u8]) -> Result<(), String> {
    let mut guard = TempGuard {
        path: temp.to_path_buf(),
        armed: true,
    };
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(temp)
        .map_err(|_| "Couldn't write that .env.".to_string())?;
    file.write_all(bytes)
        .map_err(|_| "Couldn't write that .env.".to_string())?;
    file.sync_all()
        .map_err(|_| "Couldn't write that .env.".to_string())?;
    // An existing file keeps its own permissions (a private one stays private, and one other accounts can read is
    // reported, not changed); a new one stays 0600.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&target.path) {
            let _ =
                fs::set_permissions(temp, fs::Permissions::from_mode(meta.permissions().mode()));
        }
    }
    fs::rename(temp, &target.path).map_err(|_| "Couldn't write that .env.".to_string())?;
    guard.armed = false;
    Ok(())
}

/// Write one line. The caller has already checked the target and read the value.
pub fn write(target: &Target, env_name: &str, value: &str) -> Result<(), String> {
    if !crate::secrets::valid_env_name(env_name) {
        return Err(
            "A name is capital letters, digits and underscores, like STRIPE_API_KEY.".into(),
        );
    }
    writable_value(value)?;
    let bytes = match fs::read(&target.path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err("Couldn't read that .env.".into()),
    };
    // The re-read and the hash compare: someone else wrote it while the person was saving.
    if hash(&bytes) != target.hash {
        return Err("That .env changed while saving, so nothing was written. Try again.".into());
    }
    let ranges = line_ranges(&bytes);
    let mut found = Vec::new();
    for (start, end, after) in &ranges {
        let line = String::from_utf8_lossy(&bytes[*start..*end]);
        if line.starts_with(env_name) && line.as_bytes().get(env_name.len()) == Some(&b'=') {
            found.push((*start, *end, *after));
        }
    }
    if found.len() > 1 {
        return Err(format!(
            "That .env already has two {env_name}= lines, so nothing was written. Untangle them first."
        ));
    }
    let line = line_for(env_name, value);
    let out = match found.first() {
        Some((start, end, _)) => replace_lines(&bytes, &[(*start, *end, line.into_bytes())]),
        None => {
            let eol = eol_of(&bytes);
            let mut out = bytes.clone();
            if !out.is_empty() && !out.ends_with(b"\n") {
                out.extend_from_slice(eol);
            }
            out.extend_from_slice(line.as_bytes());
            out.extend_from_slice(eol);
            out
        }
    };
    replace_file(target, &out)
}

/// Whether the line still holds `old`; a hand-edited line is left alone and reported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LineChange {
    Changed,
    LeftAlone,
    Missing,
    /// The file no longer passes the checks a write passes (now tracked, no longer ignored, now a link, ...), so it was
    /// left exactly as it was. The words say why.
    Refused(String),
}

/// Rewrite or remove the line `NAME=old` in one worktree's `.env`. A file is rewritten only after the same checks a
/// write makes (steps 1 to 5): between the write and now it may have become tracked, lost its ignore rule or turned into
/// a link.
pub fn rewrite_line(
    worktree: &Path,
    env_name: &str,
    old: &str,
    new: Option<&str>,
) -> Result<LineChange, String> {
    if !worktree.is_dir() {
        return Ok(LineChange::Missing);
    }
    // A recorded worktree is its own project: the first check (who owns it) passed when the person chose it.
    let shown = crate::fs::path_to_js(worktree);
    let target = match check(&shown, &shown) {
        Ok(target) => target,
        Err(why) => return Ok(LineChange::Refused(why)),
    };
    let bytes = match fs::read(&target.path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(LineChange::Missing),
    };
    // The file read here is the file checked there.
    if hash(&bytes) != target.hash {
        return Ok(LineChange::Refused(
            "That .env changed while saving, so nothing was written. Try again.".into(),
        ));
    }
    let ranges = line_ranges(&bytes);
    let mut hits = Vec::new();
    for (start, end, after) in &ranges {
        let line = String::from_utf8_lossy(&bytes[*start..*end]);
        if line.starts_with(env_name) && line.as_bytes().get(env_name.len()) == Some(&b'=') {
            hits.push((
                *start,
                *end,
                *after,
                line_value(&line, env_name).map(str::to_string),
            ));
        }
    }
    if hits.is_empty() {
        return Ok(LineChange::Missing);
    }
    if hits.len() > 1 {
        return Ok(LineChange::LeftAlone);
    }
    let (start, end, after, value) = hits.pop().unwrap();
    if value.as_deref() != Some(old) {
        return Ok(LineChange::LeftAlone);
    }
    let out = match new {
        Some(new) => {
            writable_value(new)?;
            replace_lines(
                &bytes,
                &[(start, end, line_for(env_name, new).into_bytes())],
            )
        }
        None => {
            // Remove the line and its terminator.
            let mut out = Vec::with_capacity(bytes.len());
            out.extend_from_slice(&bytes[..start]);
            out.extend_from_slice(&bytes[after..]);
            out
        }
    };
    replace_file(&target, &out)?;
    Ok(LineChange::Changed)
}

/// Delete a secret's line from a worktree's `.env`, only while it still holds the value.
pub fn remove_line(
    worktree: &Path,
    env_name: &str,
    old: Option<&str>,
) -> Result<LineChange, String> {
    let Some(old) = old else {
        return Ok(LineChange::Missing);
    };
    rewrite_line(worktree, env_name, old, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);

    impl Tmp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("mc-env-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            let tmp = Self(path);
            tmp.git(&["init", "-q"]);
            tmp
        }

        fn git(&self, args: &[&str]) {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", std::env::temp_dir())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn env(&self) -> PathBuf {
            self.0.join(".env")
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn ignore_env(tmp: &Tmp) {
        fs::write(tmp.path().join(".gitignore"), ".env\n").unwrap();
    }

    fn target(tmp: &Tmp) -> Target {
        let bytes = fs::read(tmp.env()).unwrap_or_default();
        Target {
            root: tmp.path().to_path_buf(),
            path: tmp.env(),
            hash: hash(&bytes),
        }
    }

    #[test]
    fn a_plain_env_with_a_space_values_written_byte_for_byte() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"# my keys\nOTHER=keep-me\n").unwrap();
        let t = target(&tmp);
        writable_value("sk_live_abcdefgh").unwrap();
        write(&t, "STRIPE_API_KEY", "sk_live_abcdefgh").unwrap();
        let text = fs::read_to_string(tmp.env()).unwrap();
        assert_eq!(
            text,
            "# my keys\nOTHER=keep-me\nSTRIPE_API_KEY=sk_live_abcdefgh\n"
        );
    }

    #[test]
    fn a_crlf_file_stays_crlf_and_an_lf_file_stays_lf() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"A=1\r\nB=2\r\n").unwrap();
        write(&target(&tmp), "C", "abcdefgh").unwrap();
        assert_eq!(
            fs::read(tmp.env()).unwrap(),
            b"A=1\r\nB=2\r\nC=abcdefgh\r\n"
        );

        fs::write(tmp.env(), b"A=1\nB=2\n").unwrap();
        write(&target(&tmp), "C", "abcdefgh").unwrap();
        assert_eq!(fs::read(tmp.env()).unwrap(), b"A=1\nB=2\nC=abcdefgh\n");
    }

    #[test]
    fn an_existing_line_is_replaced_in_place_and_two_are_refused() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"A=1\nK=old-value\nB=2\n").unwrap();
        write(&target(&tmp), "K", "new-value").unwrap();
        assert_eq!(fs::read(tmp.env()).unwrap(), b"A=1\nK=new-value\nB=2\n");

        fs::write(tmp.env(), b"K=one\nK=two\n").unwrap();
        let err = write(&target(&tmp), "K", "three").unwrap_err();
        assert!(err.contains("two K= lines"), "{err}");
        assert_eq!(fs::read(tmp.env()).unwrap(), b"K=one\nK=two\n");
    }

    #[test]
    fn the_value_is_quoted_only_when_it_needs_to_be() {
        assert_eq!(line_for("K", "plain-value"), "K=plain-value");
        for value in [
            "with space",
            "hash#tag",
            "dollar$sign",
            "bang!now",
            "café-key-1",
        ] {
            assert_eq!(line_for("K", value), format!("K='{value}'"));
        }
    }

    #[test]
    fn a_value_with_a_quote_or_a_line_break_is_refused() {
        assert!(writable_value("it's-a-key").is_err());
        assert!(writable_value("line-one\nline-two").is_err());
        assert!(writable_value("carriage\rreturn").is_err());
    }

    #[test]
    fn a_changed_file_is_not_written() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"A=1\n").unwrap();
        let t = target(&tmp);
        fs::write(tmp.env(), b"A=2\n").unwrap();
        let err = write(&t, "K", "abcdefgh").unwrap_err();
        assert!(err.contains("changed while saving"), "{err}");
        assert_eq!(fs::read(tmp.env()).unwrap(), b"A=2\n");
    }

    #[test]
    fn a_rotate_rewrites_only_a_line_that_still_holds_the_old_value() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"K=old-value\n").unwrap();
        assert_eq!(
            rewrite_line(tmp.path(), "K", "old-value", Some("new-value")).unwrap(),
            LineChange::Changed
        );
        assert_eq!(fs::read(tmp.env()).unwrap(), b"K=new-value\n");
        // A hand-edited line is left alone and reported.
        fs::write(tmp.env(), b"K=hand-made\n").unwrap();
        assert_eq!(
            rewrite_line(tmp.path(), "K", "new-value", Some("third-value")).unwrap(),
            LineChange::LeftAlone
        );
        assert_eq!(fs::read(tmp.env()).unwrap(), b"K=hand-made\n");
    }

    #[test]
    fn delete_removes_the_line_it_wrote_and_not_a_hand_edited_one() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"K=mine\nA=1\n").unwrap();
        assert_eq!(
            remove_line(tmp.path(), "K", Some("mine")).unwrap(),
            LineChange::Changed
        );
        assert_eq!(fs::read(tmp.env()).unwrap(), b"A=1\n");
        fs::write(tmp.env(), b"K=theirs\n").unwrap();
        assert_eq!(
            remove_line(tmp.path(), "K", Some("mine")).unwrap(),
            LineChange::LeftAlone
        );
        assert_eq!(fs::read(tmp.env()).unwrap(), b"K=theirs\n");
    }

    #[test]
    fn a_unicode_path_with_spaces_works() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        let spaced = tmp.path().join("a folder ünïcode");
        fs::create_dir(&spaced).unwrap();
        fs::write(spaced.join(".env"), b"A=1\n").unwrap();
        let root = crate::fs::canonical(&spaced).unwrap();
        let t = Target {
            root: root.clone(),
            path: root.join(".env"),
            hash: hash(b"A=1\n"),
        };
        write(&t, "STRIPE_API_KEY", "sk_live_abcdefgh").unwrap();
        assert!(fs::read_to_string(root.join(".env"))
            .unwrap()
            .contains("STRIPE_API_KEY=sk_live_abcdefgh"));
    }

    #[test]
    fn an_unignored_env_is_refused_and_left_alone() {
        let tmp = Tmp::new();
        fs::write(tmp.env(), "KEEP=1\n").unwrap();
        let err = check(
            &crate::fs::path_to_js(tmp.path()),
            &crate::fs::path_to_js(tmp.path()),
        )
        .unwrap_err();
        assert_eq!(
            err,
            "Git would commit this .env. Add `.env` to `.gitignore` first."
        );
        assert_eq!(fs::read_to_string(tmp.env()).unwrap(), "KEEP=1\n");
    }

    #[test]
    fn a_tracked_env_is_refused_even_when_ignored() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), "KEEP=1\n").unwrap();
        tmp.git(&["add", "-f", ".env"]);
        let err = check(
            &crate::fs::path_to_js(tmp.path()),
            &crate::fs::path_to_js(tmp.path()),
        )
        .unwrap_err();
        // `git check-ignore` doesn't call a tracked path ignored, so in practice the ignore rule refuses it first;
        // the tracked check behind it stays as the spec's second guard. Either way nothing is read or written.
        assert!(err.contains("Git would commit"), "{err}");
        assert!(!err.contains("KEEP=1"), "{err}");
        assert_eq!(fs::read_to_string(tmp.env()).unwrap(), "KEEP=1\n");
    }

    #[test]
    fn a_directory_named_env_is_refused() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::create_dir(tmp.env()).unwrap();
        let err = check(
            &crate::fs::path_to_js(tmp.path()),
            &crate::fs::path_to_js(tmp.path()),
        )
        .unwrap_err();
        assert!(err.contains("isn't a plain file"), "{err}");
    }

    #[test]
    fn a_symlink_target_is_not_followed() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        let outside = tmp.path().join("outside.txt");
        fs::write(&outside, b"keep-these-bytes").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&outside, tmp.env()).unwrap();
            let err = check(
                &crate::fs::path_to_js(tmp.path()),
                &crate::fs::path_to_js(tmp.path()),
            )
            .unwrap_err();
            assert!(err.contains("is a link"), "{err}");
            assert_eq!(fs::read(&outside).unwrap(), b"keep-these-bytes");
        }
        #[cfg(windows)]
        {
            // A file symlink needs a privilege Windows may not grant; the plain-file rule is covered there by
            // `a_directory_named_env_is_refused` above.
            let _ = outside;
        }
    }

    #[test]
    fn inside_project_refuses_a_path_that_leaves_it() {
        let tmp = Tmp::new();
        let inner = tmp.path().join("inner");
        fs::create_dir(&inner).unwrap();
        assert!(inside_project(
            &crate::fs::path_to_js(tmp.path()),
            &crate::fs::path_to_js(&inner)
        )
        .is_ok());
        let outside = std::env::temp_dir().join(format!("mc-out-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&outside).unwrap();
        assert!(inside_project(
            &crate::fs::path_to_js(&inner),
            &crate::fs::path_to_js(&outside)
        )
        .is_err());
        // A `..` that leaves the project is refused after canonicalizing, not by string prefix.
        let parent = inner.join("..");
        assert!(inside_project(
            &crate::fs::path_to_js(&inner),
            &crate::fs::path_to_js(&parent)
        )
        .is_err());
        let _ = fs::remove_dir_all(&outside);
    }

    // ---- fix round 1, item H: a rotate and a delete check the file again, say who can read it, and leave no temp ---------

    fn refused(change: &LineChange) -> &str {
        match change {
            LineChange::Refused(why) => why,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_rotate_refuses_a_file_that_has_become_tracked() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"K=old-value\n").unwrap();
        tmp.git(&["add", "-f", ".env"]);
        let change = rewrite_line(tmp.path(), "K", "old-value", Some("new-value")).unwrap();
        assert!(refused(&change).contains("Git"), "{change:?}");
        assert_eq!(fs::read(tmp.env()).unwrap(), b"K=old-value\n");
    }

    #[test]
    fn a_rotate_refuses_a_file_git_no_longer_ignores() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"K=old-value\n").unwrap();
        fs::remove_file(tmp.path().join(".gitignore")).unwrap();
        let change = rewrite_line(tmp.path(), "K", "old-value", Some("new-value")).unwrap();
        assert_eq!(
            refused(&change),
            "Git would commit this .env. Add `.env` to `.gitignore` first."
        );
        assert_eq!(fs::read(tmp.env()).unwrap(), b"K=old-value\n");
    }

    #[cfg(unix)]
    #[test]
    fn a_rotate_refuses_a_file_that_has_become_a_link() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        ignore_env(&tmp);
        let outside = tmp.path().join("outside.txt");
        fs::write(&outside, b"K=old-value\n").unwrap();
        symlink(&outside, tmp.env()).unwrap();
        let change = rewrite_line(tmp.path(), "K", "old-value", Some("new-value")).unwrap();
        assert!(refused(&change).contains("is a link"), "{change:?}");
        assert_eq!(fs::read(&outside).unwrap(), b"K=old-value\n");
    }

    #[test]
    fn a_delete_checks_the_file_too_and_a_folder_that_is_gone_is_just_missing() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"K=mine\n").unwrap();
        tmp.git(&["add", "-f", ".env"]);
        let change = remove_line(tmp.path(), "K", Some("mine")).unwrap();
        assert!(refused(&change).contains("Git"), "{change:?}");
        assert_eq!(fs::read(tmp.env()).unwrap(), b"K=mine\n");
        let gone = std::env::temp_dir().join(format!("mc-gone-{}", uuid::Uuid::new_v4()));
        assert_eq!(
            remove_line(&gone, "K", Some("mine")).unwrap(),
            LineChange::Missing
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_other_accounts_can_read_keeps_its_mode_and_the_result_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"A=1\n").unwrap();
        fs::set_permissions(tmp.env(), fs::Permissions::from_mode(0o644)).unwrap();
        write(&target(&tmp), "K", "sk_live_abcdefgh").unwrap();
        // The person's file keeps its own mode; the app says other accounts can read it.
        assert_eq!(
            fs::metadata(tmp.env()).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert!(readable_by_others(&tmp.env()));
        // Group-readable counts too.
        fs::set_permissions(tmp.env(), fs::Permissions::from_mode(0o640)).unwrap();
        assert!(readable_by_others(&tmp.env()));
        // A private file, and a file the app creates, are not.
        fs::set_permissions(tmp.env(), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!readable_by_others(&tmp.env()));
        fs::remove_file(tmp.env()).unwrap();
        write(&target(&tmp), "K", "sk_live_abcdefgh").unwrap();
        assert_eq!(
            fs::metadata(tmp.env()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!readable_by_others(&tmp.env()));
        assert!(!readable_by_others(&tmp.path().join("no-such-file")));
    }

    fn temp_leftovers(tmp: &Tmp) -> Vec<String> {
        let mut found = Vec::new();
        for dir in [tmp.path().to_path_buf(), tmp.path().join(".git")] {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(".env.tmp-") {
                    found.push(name);
                }
            }
        }
        found
    }

    #[test]
    fn the_temp_file_is_gone_after_a_write_and_after_a_failed_one() {
        let tmp = Tmp::new();
        ignore_env(&tmp);
        fs::write(tmp.env(), b"A=1\n").unwrap();
        write(&target(&tmp), "K", "sk_live_abcdefgh").unwrap();
        assert_eq!(temp_leftovers(&tmp), Vec::<String>::new());
        // A rename that cannot happen (the target is a folder) is an error, and the temp is removed.
        fs::remove_file(tmp.env()).unwrap();
        fs::create_dir(tmp.env()).unwrap();
        let broken = Target {
            root: tmp.path().to_path_buf(),
            path: tmp.env(),
            hash: hash(b""),
        };
        assert!(replace_file(&broken, b"K=sk_live_abcdefgh\n").is_err());
        assert_eq!(temp_leftovers(&tmp), Vec::<String>::new());
    }

    #[test]
    fn the_temp_file_stays_in_the_work_tree_only_when_git_ignores_its_name() {
        // `.env` alone does not cover `.env.tmp-…`, so the temp is kept out of the work tree (in git's own folder),
        // where a careless `git add -A` can never stage it.
        let tmp = Tmp::new();
        ignore_env(&tmp);
        let git_dir = crate::fs::canonical(tmp.path().join(".git")).unwrap();
        let outside = temp_path(&crate::fs::canonical(tmp.path()).unwrap());
        assert!(outside.starts_with(&git_dir), "{outside:?}");
        assert!(outside
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".env.tmp-"));
        // With the family ignored (`.env*`), the temp sits beside the file, and its name is matched by that pattern.
        fs::write(tmp.path().join(".gitignore"), ".env*\n").unwrap();
        let beside = temp_path(&crate::fs::canonical(tmp.path()).unwrap());
        assert_eq!(
            beside.parent().unwrap(),
            crate::fs::canonical(tmp.path()).unwrap()
        );
        let name = beside.file_name().unwrap().to_string_lossy().into_owned();
        let ignored = crate::fs::git_ignored_names(tmp.path(), &[name.as_str()]).unwrap();
        assert!(ignored.iter().any(|ignored| *ignored == name), "{name}");
    }
}
