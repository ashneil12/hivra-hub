// SPDX-License-Identifier: Apache-2.0
// Hivra WP-86. One hooks folder per repository, kept in this copy's data
// folder. A dev copy has its own data folder, so it never writes the daily
// app's hooks.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};

const SCRIPT: &str = include_str!("hook.sh");
pub(crate) const REFUSAL: &str = "The hooks folder isn't inside this copy's data.";
const GIT_REFUSAL: &str = "git didn't answer";
/// The line in hook.sh where the repository's own prepare-commit-msg path is
/// baked in. The frontend mirror replaces the same line.
const REAL_HOOK_LINE: &str = "real_hook=''";
/// The line in hook.sh that says what makes the repository's own hook runnable.
/// Unix uses the executable bit; Windows has none, so an existing file counts,
/// as it does for git. The frontend mirror replaces the same line.
const HOOK_TEST_LINE: &str = "hook_test='-x'";

const PREPARE: &str = "prepare-commit-msg";
/// The pre-push hook, which runs the commit guard (WP-200) before the repository's own one.
const PRE_PUSH: &str = "pre-push";

/// These three must never be files in the crew folder.
/// push-to-checkout: its presence makes receive-pack hand over the worktree
/// update, so a forwarder that exits 0 moves the ref and leaves the files stale
/// when receive.denyCurrentBranch is updateInstead.
/// proc-receive: git runs it only when that feature is configured, and it must
/// speak the pkt-line protocol. Exiting 0 does not.
/// fsmonitor-watchman: git never runs that name from the hooks directory.
const NEVER_FORWARD: &[&str] = &["fsmonitor-watchman", "proc-receive", "push-to-checkout"];

/// What `git config` reads to find the repository's own hooks. These are the
/// only variables handed to the lookup, so the crew's GIT_CONFIG_* entries
/// (which point at this folder) never hide the real value.
const CONFIG_ENV: &[&str] = &[
    "HOME",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
];

const GIT_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) fn hook_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    if !matches!(chars.next(), Some(c) if c.is_ascii_lowercase()) {
        return false;
    }
    (2..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn contained(root: &Path, child: &Path) -> bool {
    child.starts_with(root) && child != root
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// The refusal, with the check that failed after it. The first sentence is
/// what a person reads; the rest names which check it was, so a log or a failing
/// test says where to look instead of one sentence covering a dozen checks.
fn refuse(check: &str) -> String {
    format!("{REFUSAL} (check: {check})")
}

/// `refuse`, plus the error the filesystem gave. An OS error prints its number
/// ("os error 5"), which tells a sharing violation from a real denial.
fn refuse_io(check: &str, err: &io::Error) -> String {
    format!("{REFUSAL} (check: {check}: {err})")
}

/// How many times one filesystem call is tried while another crew, or a virus
/// scanner, has the file or folder at that instant.
pub(crate) const FS_TRIES: u32 = 8;
/// The pause after try `n` is `n` times this, so the longest wait for one call
/// is 5 + 10 + ... + 35 = 140 ms.
const FS_PAUSE_MS: u64 = 5;

/// Win32 errors that say another process has the file or folder right now, not
/// that anything is wrong with it. `ERROR_ACCESS_DENIED` is also what a delete
/// that is still pending answers with.
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;

/// Windows says "nothing there" in two codes. Rust maps more than these to
/// `ErrorKind::NotFound` (53, a bad network path, and 67, a bad network name),
/// and those are not another crew's folder that has not shown up yet.
const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PATH_NOT_FOUND: i32 = 3;

pub(crate) fn busy_code(code: i32) -> bool {
    matches!(
        code,
        ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION
    )
}

fn missing_code(code: i32) -> bool {
    matches!(code, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
}

/// "Nothing there". On Windows that is the two codes above, never the wider
/// `NotFound` kind.
pub(crate) fn is_missing(err: &io::Error, windows: bool) -> bool {
    if windows {
        err.raw_os_error().is_some_and(missing_code)
    } else {
        err.kind() == io::ErrorKind::NotFound
    }
}

/// Is this failure worth another try? Only ever on Windows: the same numbers
/// mean something else on Unix (5 is EIO, 32 is EPIPE, 33 is EDOM), where a
/// failure stays final. `mid_create` says the folder or file was just seen, or
/// just reported to exist, so "not found" (error 2 or 3 only) now is another
/// crew's create or replace that has not finished showing up, not a missing
/// path. Nothing here is a containment decision: a path that resolves outside
/// the data folder is not an error from the filesystem, and the caller refuses
/// it at once.
pub(crate) fn is_transient(err: &io::Error, windows: bool, mid_create: bool) -> bool {
    if !windows {
        return false;
    }
    match err.raw_os_error() {
        Some(code) if busy_code(code) => true,
        Some(code) => mid_create && missing_code(code),
        None => false,
    }
}

/// The pause after the `attempt`-th failed try (1 is the first).
pub(crate) fn pause_for(attempt: u32) -> Duration {
    Duration::from_millis(FS_PAUSE_MS * u64::from(attempt))
}

/// The filesystem calls the install makes, by kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Call {
    Stat,
    Create,
    Resolve,
    List,
    Rename,
}

/// The seam a test uses to answer a call with an error instead of making it,
/// the way Windows answers one under a race. Production never sets it.
pub(crate) type Fault<'a> = &'a mut dyn FnMut(Call, &Path) -> Option<io::Error>;

/// Test only: what `resolve` answers instead of what the filesystem said, to
/// play back a path Windows gave that is not the path that was asked about.
#[cfg(test)]
pub(crate) type Relabel<'a> = &'a mut dyn FnMut(&Path, PathBuf) -> PathBuf;

/// The install's filesystem calls, with the retry for the errors in
/// `is_transient` built in. `windows` is a field so a test can play Windows
/// errors back on any platform.
pub(crate) struct Fs<'a> {
    windows: bool,
    fault: Option<Fault<'a>>,
    #[cfg(test)]
    relabel: Option<Relabel<'a>>,
}

impl<'a> Fs<'a> {
    pub(crate) fn real() -> Fs<'static> {
        Fs {
            windows: cfg!(windows),
            fault: None,
            #[cfg(test)]
            relabel: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn playing(windows: bool, fault: Fault<'a>) -> Self {
        Fs {
            windows,
            fault: Some(fault),
            relabel: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn relabeling(windows: bool, relabel: Relabel<'a>) -> Self {
        Fs {
            windows,
            fault: None,
            relabel: Some(relabel),
        }
    }

    /// One call, tried up to `tries` times while the error is transient. Any
    /// other error, and the last transient one, is returned as it came.
    fn call<T>(
        &mut self,
        call: Call,
        path: &Path,
        tries: u32,
        mid_create: bool,
        real: impl Fn(&Path) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut attempt = 1;
        loop {
            let result = match self.fault.as_mut().and_then(|fault| fault(call, path)) {
                Some(err) => Err(err),
                None => real(path),
            };
            match result {
                Err(err) if attempt < tries && is_transient(&err, self.windows, mid_create) => {
                    std::thread::sleep(pause_for(attempt));
                    attempt += 1;
                }
                other => return other,
            }
        }
    }

    /// A single look. The caller decides what a failed look means.
    fn stat(&mut self, path: &Path) -> io::Result<std::fs::Metadata> {
        self.call(Call::Stat, path, 1, false, |path| {
            std::fs::symlink_metadata(path)
        })
    }

    /// A look at a hook just published, or just replaced by another crew: busy,
    /// and "not found" while the replace finishes, are waited out.
    fn stat_published(&mut self, path: &Path) -> io::Result<std::fs::Metadata> {
        self.call(Call::Stat, path, FS_TRIES, true, |path| {
            std::fs::symlink_metadata(path)
        })
    }

    /// A look at a path that might be there, such as a hook about to be
    /// replaced: a busy answer is waited out.
    fn stat_settled(&mut self, path: &Path) -> io::Result<std::fs::Metadata> {
        self.call(Call::Stat, path, FS_TRIES, false, |path| {
            std::fs::symlink_metadata(path)
        })
    }

    fn create(&mut self, path: &Path) -> io::Result<()> {
        self.call(Call::Create, path, 1, false, |path| {
            std::fs::create_dir(path)
        })
    }

    /// The real path of something that exists, or that another crew is making
    /// or replacing right now.
    fn resolve(&mut self, path: &Path) -> io::Result<PathBuf> {
        let found = self.call(Call::Resolve, path, FS_TRIES, true, |path| {
            crate::fs::canonical(path)
        })?;
        #[cfg(test)]
        let found = match self.relabel.as_mut() {
            Some(relabel) => relabel(path, found),
            None => found,
        };
        Ok(found)
    }

    /// One try at `from` over `to`. The caller waits out a busy answer on the
    /// same file, because a scanner that opened it the moment it was written, or
    /// another crew mid-replace, refuses the move for a few tens of milliseconds.
    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        self.call(Call::Rename, from, 1, false, |from| {
            std::fs::rename(from, to)
        })
    }

    fn list(&mut self, path: &Path) -> io::Result<std::fs::ReadDir> {
        self.call(Call::List, path, FS_TRIES, false, |path| {
            std::fs::read_dir(path)
        })
    }

    /// Wait before the next round of a loop that makes more than one call.
    fn pause(&self, round: u32) {
        std::thread::sleep(pause_for(round));
    }
}

/// What a path that fell outside the data folder looks like, without the path
/// itself (the refusal reaches a log). It tells a Windows quirk from a real
/// escape: the name Windows gives a file it has unlinked (a folder under
/// `$Extend`), the `\\?\` form that was not stripped, or the right place in
/// another case.
fn outside_shape(root: &Path, found: &Path) -> &'static str {
    let text = found.to_string_lossy();
    if text.contains("$Extend") || text.contains("$Deleted") {
        "the name of an unlinked file"
    } else if text.starts_with(r"\\?\") {
        "a verbatim path"
    } else if text
        .to_lowercase()
        .starts_with(&root.to_string_lossy().to_lowercase())
    {
        "the data folder in another case"
    } else {
        "elsewhere"
    }
}

fn folder_is_real(meta: &std::fs::Metadata, what: &str) -> Result<(), String> {
    if meta.file_type().is_symlink() {
        return Err(refuse(&format!("{what}: is a link")));
    }
    if !meta.is_dir() {
        return Err(refuse(&format!("{what}: is not a folder")));
    }
    Ok(())
}

/// Make `next` a real folder, or confirm it is one. Another crew can be making
/// it at the same moment, so a failed create is not final: look again, and if
/// the folder still is not there and the failure is one of the transient kinds,
/// go round once more. A link or a file in the way is refused on the first look.
fn make_folder(fs: &mut Fs, next: &Path, what: &str) -> Result<(), String> {
    let mut round = 1;
    loop {
        // The folder is there on every call but the first.
        if let Ok(meta) = fs.stat(next) {
            return folder_is_real(&meta, what);
        }
        let create = match fs.create(next) {
            Ok(()) => return Ok(()),
            Err(err) => err,
        };
        // The other crew made the folder between our look and our create.
        let look = match fs.stat(next) {
            Ok(meta) => return folder_is_real(&meta, what),
            Err(err) => err,
        };
        // Only two answers to the create mean the other crew has the folder: it
        // said "already exists", or it was refused as busy. Then a look that
        // does not see the folder (not found, or busy too) is that folder not
        // having finished showing up. A create that failed any other way, such
        // as a missing parent or a real denial, followed by "not found" is a
        // real failure and is not tried again.
        let other_crew_has_it = create.kind() == io::ErrorKind::AlreadyExists
            || is_transient(&create, fs.windows, false);
        let not_visible_yet =
            is_missing(&look, fs.windows) || is_transient(&look, fs.windows, true);
        let settling = other_crew_has_it && not_visible_yet;
        if !settling || round >= FS_TRIES {
            return Err(refuse(&format!(
                "{what}: create: {create}; then look: {look}"
            )));
        }
        fs.pause(round);
        round += 1;
    }
}

fn ensure_child(root: &Path, rel: &str, what: &str) -> Result<PathBuf, String> {
    ensure_child_with(&mut Fs::real(), root, rel, what)
}

/// `what` names the folder in a refusal ("attribution", "hooks", "repo").
pub(crate) fn ensure_child_with(
    fs: &mut Fs,
    root: &Path,
    rel: &str,
    what: &str,
) -> Result<PathBuf, String> {
    if rel.is_empty() || rel == "." || rel == ".." {
        return Err(refuse(&format!("{what}: not a folder name")));
    }
    let next = root.join(rel);
    if !contained(root, &next) {
        return Err(refuse(&format!("{what}: path leaves the data folder")));
    }
    make_folder(fs, &next, what)?;
    let canon = fs
        .resolve(&next)
        .map_err(|err| refuse_io(&format!("{what}: resolve"), &err))?;
    if !contained(root, &canon) {
        return Err(refuse(&format!(
            "{what}: resolves outside the data folder ({})",
            outside_shape(root, &canon)
        )));
    }
    Ok(canon)
}

static HOOK_TMP: AtomicU64 = AtomicU64::new(0);

/// The temp names `hook_temp` makes. A hook name can never look like one: it
/// starts with a lowercase letter and holds no dot.
const TEMP_PREFIX: &str = ".prepare-commit-msg.";
const TEMP_SUFFIX: &str = ".tmp";

/// How long a temp file has to sit untouched before it counts as a crashed
/// crew's leftover. Two crews can install into one folder at the same time, so
/// a fresh temp file belongs to whoever is writing it right now.
pub(crate) const TEMP_GRACE: Duration = Duration::from_secs(60);

/// A fresh path for every install. Two crews in one process must not share a file.
pub(crate) fn hook_temp(dir: &Path) -> PathBuf {
    let n = HOOK_TMP.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(
        "{TEMP_PREFIX}{}.{n}{TEMP_SUFFIX}",
        std::process::id()
    ))
}

/// True for the names `hook_temp` makes: `.prepare-commit-msg.<pid>.<n>.tmp`.
/// `hook_name_ok` never accepts a name that starts with a dot, so a file with
/// one of these names is only ever a temp file.
pub(crate) fn is_hook_temp(name: &str) -> bool {
    name.strip_prefix(TEMP_PREFIX)
        .and_then(|rest| rest.strip_suffix(TEMP_SUFFIX))
        .and_then(|middle| middle.split_once('.'))
        .is_some_and(|(pid, n)| {
            !pid.is_empty()
                && !n.is_empty()
                && pid.bytes().all(|byte| byte.is_ascii_digit())
                && n.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// Old enough that no crew can still be writing it. A time that can't be read,
/// or sits in the future, is treated as fresh: leaving a stray temp file is
/// harmless, removing a live one breaks its crew's install.
fn temp_is_stale(meta: &std::fs::Metadata) -> bool {
    meta.modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > TEMP_GRACE)
}

fn script_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    Some(text.replace("\r\n", "\n"))
}

/// `publish_hook_in` on the real filesystem. `next_temp` is a parameter so a
/// test can make one attempt's write fail.
#[cfg(test)]
pub(crate) fn publish_hook_with(
    root: &Path,
    dir: &Path,
    dest: &Path,
    script: &str,
    next_temp: impl FnMut(&Path) -> PathBuf,
) -> Result<(), String> {
    publish_hook_in(&mut Fs::real(), root, dir, dest, script, next_temp)
}

/// Publish the hook. A lost rename is not a failure when the installed file is
/// already this script: the other crew got there first. Only our temp file is
/// removed. A rename refused as busy is retried on the same temp file for up to
/// `FS_TRIES` tries; any other failure moves on to a new temp name. `fs` is a
/// parameter so a test can make the rename answer as Windows does.
pub(crate) fn publish_hook_in(
    fs: &mut Fs,
    root: &Path,
    dir: &Path,
    dest: &Path,
    script: &str,
    mut next_temp: impl FnMut(&Path) -> PathBuf,
) -> Result<(), String> {
    // What the last attempt hit, for the refusal if none of them publishes.
    let mut last = String::from("no attempt ran");
    for attempt in 0..8 {
        let tmp = next_temp(dir);
        if !contained(root, &tmp) {
            return Err(refuse("publish: temp name leaves the data folder"));
        }
        if std::fs::symlink_metadata(&tmp).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(refuse("publish: temp name is a link"));
        }
        if let Err(err) = std::fs::write(&tmp, script.as_bytes()) {
            // Not final. Windows can refuse the write while another crew holds
            // or is deleting the file, so the next attempt writes a new temp
            // name instead of failing the whole install.
            last = format!("write temp: {err}");
            let _ = std::fs::remove_file(&tmp);
            if attempt + 1 < 8 {
                std::thread::sleep(Duration::from_millis(2));
            }
            continue;
        }
        // A busy answer is waited out on this same temp file: writing a new one
        // only hands a scanner another file to hold. If the other crew got there
        // first there is nothing left to wait for.
        for tries in 1..=FS_TRIES {
            let err = match fs.rename(&tmp, dest) {
                Ok(()) => return Ok(()),
                Err(err) => err,
            };
            last = format!("rename temp over the hook: {err}");
            if script_text(dest).as_deref() == Some(script)
                || tries == FS_TRIES
                || !is_transient(&err, fs.windows, false)
            {
                break;
            }
            fs.pause(tries);
        }
        let _ = std::fs::remove_file(&tmp);
        if script_text(dest).as_deref() == Some(script) {
            return Ok(());
        }
        if attempt + 1 < 8 {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    if script_text(dest).as_deref() == Some(script) {
        Ok(())
    } else {
        Err(refuse(&format!(
            "publish: gave up after 8 tries and the installed hook is not this script (last: {last})"
        )))
    }
}

fn install_one(root: &Path, dir: &Path, name: &str, script: &str) -> Result<(), String> {
    install_one_with(&mut Fs::real(), root, dir, name, script)
}

pub(crate) fn install_one_with(
    fs: &mut Fs,
    root: &Path,
    dir: &Path,
    name: &str,
    script: &str,
) -> Result<(), String> {
    if !hook_name_ok(name) {
        return Err(refuse("hook: not a hook name"));
    }
    let dest = dir.join(name);
    if !contained(root, &dest) {
        return Err(refuse("hook: path leaves the data folder"));
    }
    if let Ok(meta) = fs.stat_settled(&dest) {
        if meta.file_type().is_symlink() {
            return Err(refuse("hook: is a link"));
        }
        if !meta.is_file() {
            return Err(refuse("hook: is not a file"));
        }
    }
    hook_folder_inside(fs, root, dir, "before publish")?;
    let same = std::fs::read(&dest)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .is_some_and(|current| current.replace("\r\n", "\n") == script);
    if !same {
        publish_hook_in(fs, root, dir, &dest, script, hook_temp)?;
    }
    mark_executable(&dest).map_err(|err| refuse_io("hook: mark executable", &err))?;
    hook_folder_inside(fs, root, dir, "after publish")?;
    let meta = fs
        .stat_published(&dest)
        .map_err(|err| refuse_io("hook: look after publish", &err))?;
    if meta.file_type().is_symlink() {
        return Err(refuse("hook: is a link after publish"));
    }
    if !meta.is_file() {
        return Err(refuse("hook: is not a file after publish"));
    }
    Ok(())
}

/// The containment check for a hook file: the folder it lives in resolves to a
/// place inside the data folder. It resolves the folder and not the file on
/// purpose. Asking Windows for the path of a file means opening it, and when
/// another crew replaces that file at that moment Windows answers with the name
/// of the unlinked file (a folder under `$Extend`), which is outside the data
/// folder though nothing escaped. A folder is never replaced, so its answer is
/// stable, and a link anywhere in its path still resolves outside it and is
/// refused at once. The file itself is a plain file and not a link, which a
/// look at it says without opening it.
fn hook_folder_inside(fs: &mut Fs, root: &Path, dir: &Path, when: &str) -> Result<(), String> {
    let resolved = fs
        .resolve(dir)
        .map_err(|err| refuse_io(&format!("hook folder: resolve {when}"), &err))?;
    if !contained(root, &resolved) {
        return Err(refuse(&format!(
            "hook folder: resolves outside the data folder {when} ({})",
            outside_shape(root, &resolved)
        )));
    }
    Ok(())
}

/// The value a config variable has for the crew: its own override first, then
/// this process. The crew's GIT_CONFIG_* entries are never read here.
fn config_value(env: &[(String, String)], key: &str) -> Option<String> {
    if let Some((_, value)) = env.iter().rev().find(|(name, _)| name == key) {
        return Some(value.clone());
    }
    std::env::var(key).ok()
}

fn git(
    workdir: &Path,
    env: &[(String, String)],
    args: &[&str],
) -> Result<String, super::git::GitFail> {
    let mut cmd = crate::delivery::child("git");
    cmd.arg("--no-pager").arg("-C").arg(workdir).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    for key in CONFIG_ENV {
        if let Some(value) = config_value(env, key) {
            cmd.env(key, value);
        }
    }
    super::git::run_limited(cmd, GIT_TIMEOUT)
}

fn first_line(raw: &str) -> String {
    raw.lines().next().unwrap_or("").trim().to_string()
}

/// The two paths rev-parse prints, made absolute. A relative common dir is
/// relative to the directory git ran in.
fn two_paths(out: &str, workdir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let mut lines = out.lines().map(str::trim).filter(|line| !line.is_empty());
    let common = lines.next().ok_or_else(|| GIT_REFUSAL.to_string())?;
    let top = lines.next().ok_or_else(|| GIT_REFUSAL.to_string())?;
    let absolute = |text: &str| {
        let path = Path::new(text);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            workdir.join(path)
        }
    };
    Ok((absolute(common), absolute(top)))
}

fn expand_tilde(value: &str, home: Option<&str>) -> Option<String> {
    if value == "~" {
        return home.map(str::to_string);
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.map(|home| format!("{home}/{rest}"));
    }
    Some(value.to_string())
}

fn windows_slash(text: &str) -> String {
    #[cfg(windows)]
    {
        text.replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        text.to_string()
    }
}

/// A POSIX shell word for a path. Git runs hooks with sh on every platform.
fn shell_quote(text: &str) -> Option<String> {
    if text.contains('\0') {
        return None;
    }
    Some(format!("'{}'", windows_slash(text).replace('\'', "'\\''")))
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

fn folder_key(common: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(common.as_bytes());
    hex(&hasher.finalize())
}

struct Resolved {
    common: PathBuf,
    real_hooks: PathBuf,
}

/// Resolve the repository's own hooks once, at crew spawn. The crew's own
/// core.hooksPath override is not in the environment here, so a husky-style
/// path in local, global or system config is what the lookup returns.
fn resolve(workdir: &Path, env: &[(String, String)]) -> Result<Resolved, String> {
    let (common, toplevel) = match git(
        workdir,
        env,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--show-toplevel",
        ],
    ) {
        Ok(out) => two_paths(&out, workdir)?,
        Err(super::git::GitFail::Rejected) => {
            // A git older than 2.31 has no --path-format.
            let out = git(
                workdir,
                env,
                &["rev-parse", "--git-common-dir", "--show-toplevel"],
            )
            .map_err(|_| GIT_REFUSAL.to_string())?;
            two_paths(&out, workdir)?
        }
        Err(super::git::GitFail::Unavailable) => return Err(GIT_REFUSAL.into()),
    };
    let common = crate::fs::canonical(&common).map_err(|_| GIT_REFUSAL.to_string())?;
    let toplevel = crate::fs::canonical(&toplevel).map_err(|_| GIT_REFUSAL.to_string())?;
    let configured = match git(workdir, env, &["config", "--get", "core.hooksPath"]) {
        Ok(out) => Some(first_line(&out)),
        Err(super::git::GitFail::Rejected) => None,
        // A timeout is not "nothing is set": guessing would skip the
        // repository's own hooks, so the crew runs without an override instead.
        Err(super::git::GitFail::Unavailable) => return Err(GIT_REFUSAL.into()),
    };
    let real_hooks = match configured.filter(|value| !value.is_empty()) {
        Some(value) => {
            let home = config_value(env, "HOME");
            let expanded =
                expand_tilde(&value, home.as_deref()).ok_or_else(|| GIT_REFUSAL.to_string())?;
            let path = PathBuf::from(expanded);
            if path.is_absolute() {
                path
            } else {
                toplevel.join(path)
            }
        }
        None => common.join("hooks"),
    };
    let real_hooks = crate::fs::canonical(&real_hooks).unwrap_or(real_hooks);
    Ok(Resolved { common, real_hooks })
}

#[cfg(unix)]
fn hook_runnable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn hook_runnable(meta: &std::fs::Metadata) -> bool {
    meta.is_file()
}

struct RealHook {
    name: String,
    path: String,
}

/// The hooks the repository itself would run right now. Symlinks are followed,
/// as git follows them. A name that cannot be baked into a shell word is not
/// guessed at: the whole install fails, so the crew runs with its own config.
fn real_hooks(dir: &Path) -> Result<Vec<RealHook>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // No hooks folder, or one that cannot be read: the repository has no hooks.
        Err(_) => return Ok(Vec::new()),
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !hook_name_ok(name) || NEVER_FORWARD.contains(&name) {
            continue;
        }
        let path = dir.join(name);
        match std::fs::metadata(&path) {
            Ok(meta) if hook_runnable(&meta) => {}
            _ => continue,
        }
        let path = crate::fs::canonical(&path)
            .unwrap_or(path)
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| refuse("real hook: path is not text"))?;
        found.push(RealHook {
            name: name.to_string(),
            path,
        });
    }
    Ok(found)
}

/// What makes the repository's own hook runnable. Git for Windows has no
/// executable bit, so a hook file that exists is one git runs.
fn hook_test() -> &'static str {
    if cfg!(windows) {
        "-f"
    } else {
        "-x"
    }
}

fn prepare_script(real: Option<&str>) -> Result<String, String> {
    let template = SCRIPT.replace("\r\n", "\n");
    if !template.contains(REAL_HOOK_LINE) || !template.contains(HOOK_TEST_LINE) {
        return Err(refuse(
            "script: the template lost a line the install replaces",
        ));
    }
    let template = template.replacen(HOOK_TEST_LINE, &format!("hook_test='{}'", hook_test()), 1);
    let Some(real) = real else {
        return Ok(template);
    };
    let quoted = shell_quote(real).ok_or_else(|| refuse("script: hook path has a NUL"))?;
    Ok(template.replacen(REAL_HOOK_LINE, &format!("real_hook={quoted}"), 1))
}

fn forwarder_script(real: &str) -> Result<String, String> {
    let quoted = shell_quote(real).ok_or_else(|| refuse("forwarder: hook path has a NUL"))?;
    Ok(format!(
        "#!/bin/sh\n\
         # SPDX-License-Identifier: Apache-2.0\n\
         # Hivra WP-86. Runs the repository's own hook, whose path was resolved when\n\
         # the crew started. A hook added or changed during the run is picked up on\n\
         # the next run.\n\
         real_hook={quoted}\n\
         if [ {test} \"$real_hook\" ]; then\n\
         \texec \"$real_hook\" \"$@\"\n\
         fi\n\
         exit 0\n",
        test = hook_test()
    ))
}

/// The pre-push hook (WP-200): the commit guard checks what this push sends (secrets, agent files, merge commits
/// included) and refuses it with its own line; then the repository's own pre-push hook runs, if it has one. `guard` is
/// this app's binary, so a crew's shell push meets the same rules as the app's own push. Git passes the remote name as
/// `$1`; the stdin of a push is left for the repository's hook.
pub(crate) fn pre_push_script(guard: &str, real: Option<&str>) -> Result<String, String> {
    let guard = shell_quote(guard).ok_or_else(|| refuse("pre-push: guard path has a NUL"))?;
    let real = match real {
        Some(path) => shell_quote(path).ok_or_else(|| refuse("pre-push: hook path has a NUL"))?,
        None => "''".to_string(),
    };
    Ok(format!(
        "#!/bin/sh\n\
         # SPDX-License-Identifier: Apache-2.0\n\
         # Hivra WP-200. Checks what this push sends before git sends it. Then runs the\n\
         # repository's own pre-push hook, whose path was resolved when the crew started.\n\
         guard={guard}\n\
         real_hook={real}\n\
         \"$guard\" pre-push-guard \"$1\" || exit 1\n\
         if [ {test} \"$real_hook\" ]; then\n\
         \texec \"$real_hook\" \"$@\"\n\
         fi\n\
         exit 0\n",
        test = hook_test()
    ))
}

/// Remove forwarders for hooks the repository no longer has, and temp files a
/// failed publish left behind. Only regular files and links inside the folder
/// are touched; removing a link removes the link, never what it points at.
/// Another crew installing into the same folder right now keeps its temp file.
pub(crate) fn prune(root: &Path, dir: &Path, keep: &BTreeSet<String>) -> Result<(), String> {
    prune_in(&mut Fs::real(), root, dir, keep, |path| {
        std::fs::remove_file(path)
    })
}

/// `prune_in` on the real filesystem. `remove` is a parameter so a test can make
/// one removal fail the way Windows fails it, without needing a Windows machine
/// to hold a file open.
#[cfg(test)]
pub(crate) fn prune_with(
    root: &Path,
    dir: &Path,
    keep: &BTreeSet<String>,
    remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    prune_in(&mut Fs::real(), root, dir, keep, remove)
}

/// A real hook file whose removal is refused as busy (an open handle, or a
/// delete another crew has pending) is tried again, up to `FS_TRIES` times, on
/// Windows only. Any other failure of that removal is a refusal at once.
pub(crate) fn prune_in(
    fs: &mut Fs,
    root: &Path,
    dir: &Path,
    keep: &BTreeSet<String>,
    mut remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let entries = fs
        .list(dir)
        .map_err(|err| refuse_io("prune: list the folder", &err))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !contained(root, &path) {
            return Err(refuse("prune: an entry leaves the data folder"));
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if keep.contains(name) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            continue;
        }
        let temp = is_hook_temp(name);
        if temp && !temp_is_stale(&meta) {
            continue;
        }
        let mut tries = 1;
        let removed = loop {
            match remove(&path) {
                // A temp file is disposable and is never waited for.
                Err(err) if !temp && tries < FS_TRIES && is_transient(&err, fs.windows, false) => {
                    fs.pause(tries);
                    tries += 1;
                }
                other => break other,
            }
        };
        match removed {
            Ok(()) => {}
            // The other crew renamed or removed it since the listing.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            // A temp file is disposable, so never fail an install over one. On
            // Windows a file another process holds open refuses removal with
            // ERROR_SHARING_VIOLATION (os error 32), which Rust does not map to
            // PermissionDenied (only ERROR_ACCESS_DENIED, os error 5, is
            // mapped), and a file already marked for deletion gives
            // ERROR_ACCESS_DENIED. Both mean the same thing here: another crew
            // owns that name and ours is not needed.
            Err(_) if temp => {}
            // A real hook file that will not go is a refusal: git would keep
            // running a forwarder for a hook the repository no longer has.
            Err(err) => return Err(refuse_io("prune: remove a hook file", &err)),
        }
    }
    Ok(())
}

/// Regenerate the folder for this repository: prepare-commit-msg, plus a
/// forwarder for each hook git would run at spawn (the executable bit on Unix,
/// existence on Windows). Every file
/// is published atomically, one at a time, and the path is refused unless it
/// stays inside the data directory. One failed file fails the install, so git
/// is not pointed at a half-written folder; the crew then runs with no
/// override and the repository's own hooks still apply.
pub fn install_for_repo(
    data_dir: &Path,
    workdir: &Path,
    env: &[(String, String)],
) -> Result<PathBuf, String> {
    let guard =
        std::env::current_exe().map_err(|err| refuse_io("commit guard: find the app", &err))?;
    install_for_repo_with(data_dir, workdir, env, &guard)
}

/// The install with the commit guard's binary given: the app passes its own; a test passes a stand-in.
pub(crate) fn install_for_repo_with(
    data_dir: &Path,
    workdir: &Path,
    env: &[(String, String)],
    guard: &Path,
) -> Result<PathBuf, String> {
    let root =
        crate::fs::canonical(data_dir).map_err(|err| refuse_io("data folder: resolve", &err))?;
    if !root.is_dir() {
        return Err(refuse("data folder: is not a folder"));
    }
    let resolved = super::read_with_retry(|| resolve(workdir, env))?;
    let common = resolved
        .common
        .to_str()
        .ok_or_else(|| refuse("repository path is not text"))?;
    let attribution = ensure_child(&root, "attribution", "attribution")?;
    let hooks_root = ensure_child(&attribution, "hooks", "hooks")?;
    let dir = ensure_child(&hooks_root, &folder_key(common), "repo folder")?;
    if !contained(&root, &dir) {
        return Err(refuse("repo folder: leaves the data folder"));
    }
    let found = real_hooks(&resolved.real_hooks)?;
    let prepare = found.iter().find(|hook| hook.name == PREPARE);
    install_one(
        &root,
        &dir,
        PREPARE,
        &prepare_script(prepare.map(|hook| hook.path.as_str()))?,
    )?;
    // WP-200: a crew's shell `git push` runs the commit guard first, whether or not the repository has a pre-push hook.
    let guard = guard
        .to_str()
        .ok_or_else(|| refuse("commit guard: the app's path is not text"))?;
    let real_pre_push = found
        .iter()
        .find(|hook| hook.name == PRE_PUSH)
        .map(|hook| hook.path.as_str());
    install_one(
        &root,
        &dir,
        PRE_PUSH,
        &pre_push_script(guard, real_pre_push)?,
    )?;
    let mut keep = BTreeSet::new();
    keep.insert(PREPARE.to_string());
    keep.insert(PRE_PUSH.to_string());
    for hook in &found {
        if hook.name == PREPARE || hook.name == PRE_PUSH {
            continue;
        }
        install_one(&root, &dir, &hook.name, &forwarder_script(&hook.path)?)?;
        keep.insert(hook.name.clone());
    }
    prune(&root, &dir, &keep)?;
    Ok(dir)
}
