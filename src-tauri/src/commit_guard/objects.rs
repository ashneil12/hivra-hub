//! How the guard reads a repository.
//!
//! The git dir is `rev-parse --absolute-git-dir` from the folder the check was given, the same discovery `git push`
//! uses. It is not `rev-parse --show-toplevel`, which follows `core.worktree` and would read a different checkout.
//! Every later read passes that git dir with `--git-dir` and `--work-tree`.
//!
//! File content is the blob, not a diff. A line is new when it occurs more times in the commit's blob than in every
//! parent's blob. Attributes, textconv, colour and binary detection never see it. A gitlink is not file content: a
//! parent entry of mode 160000 counts as absent, and only a blob is accepted as content.
//!
//! The one network read (`ls-remote`) runs in a fresh empty folder under a scratch directory, with the discovery
//! ceiling set to that scratch directory's parent. Git stops only at a proper ancestor, so a ceiling equal to the
//! current folder would still use a repository above it. The push URL is resolved with the same config `git push`
//! reads, system file included: hiding that file lets a system `url.insteadOf` send the push somewhere this check never
//! asked. `ls-remote` keeps credential keys from the global and system config as `GIT_CONFIG_KEY_<n>` pairs (their
//! `includeIf` evaluated in the repository, as for the push) and points both files at `/dev/null`, so a swapped scratch
//! file or a `url.*` rewrite cannot steer the read. A commit is already on the remote only when every push destination
//! advertises it.
//!
//! A commit-graph and a pack bitmap are unverified caches. Guard reads turn both off. `git commit-graph verify` has to
//! accept a local graph, and an alternate object store that has a graph of its own is not trusted: a graph `git push`
//! walks with `pack.useSparse` can count a blob as already upstream that the push still sends. A blob a cache names and
//! the raw objects do not is scanned and then refused. A blob the diff skipped but the raw objects do contain is scanned
//! in full.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(test)]
pub(super) type IndexHook = Box<dyn FnMut(&Path)>;

#[cfg(test)]
thread_local! {
    static LANDING_INDEX_HOOK: std::cell::RefCell<Option<IndexHook>> = std::cell::RefCell::new(None);
}

/// Test-only. A landing check reads the index more than once; a test uses this to change the index
/// after one of those reads. Unset, this does nothing.
pub(super) fn note_index_read(index: &Path) {
    #[cfg(test)]
    LANDING_INDEX_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().as_mut() {
            hook(index);
        }
    });
    #[cfg(not(test))]
    {
        let _ = index;
    }
}

#[cfg(test)]
pub(super) fn set_landing_index_hook(hook: Option<IndexHook>) {
    LANDING_INDEX_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

use super::{colour_wrapped, CHECK_TIMEOUT, COLOUR_REFUSED, MAX_CHECKED_BYTES};

pub(super) struct Repo {
    pub git_dir: PathBuf,
    pub work_tree: PathBuf,
}

pub(super) const UNREADABLE: &str =
    "The secret check could not read this repository, so nothing was sent.";
const UNREADABLE_CHANGE: &str = "The secret check could not read this change, so nothing was sent.";
type HeaderParts = (Vec<String>, Option<String>, Vec<u8>);
pub(super) type StagedBlob = (String, Option<Vec<u8>>);

pub(super) fn open_repo(start: &Path) -> Result<Repo, String> {
    let mut dir = crate::fs::canonical(start).unwrap_or_else(|_| start.to_path_buf());
    if !dir.is_dir() {
        dir.pop();
    }
    let git_dir = absolute_git_dir(&dir)?;
    Ok(Repo {
        git_dir: git_dir.clone(),
        work_tree: work_tree_for(&git_dir, &dir),
    })
}

/// Git's own discovery, from the folder a push would use. The printed path keeps trailing spaces: git strips only
/// CR and LF from a `gitdir:` line. `safe.bareRepository=explicit` (set on the app's git command) would skip a bare
/// root and walk into a parent, so this command forces `all` and drops that injection.
fn absolute_git_dir(dir: &Path) -> Result<PathBuf, String> {
    let mut cmd = crate::fs::git_cmd();
    strip_repo_env(&mut cmd, true);
    cmd.current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").args([
        "--no-pager",
        "-c",
        "core.quotePath=false",
        "-c",
        "safe.bareRepository=all",
        "rev-parse",
        "--absolute-git-dir",
    ]);
    let out = match read_capped(cmd, None, super::CHECK_TIMEOUT, super::MAX_CHECKED_BYTES) {
        Ok(out) => out,
        Err(error) if error == super::TIMED_OUT || error == super::TOO_LARGE => return Err(error),
        Err(_) => return Err(UNREADABLE.into()),
    };
    let text = std::str::from_utf8(&out).map_err(|_| UNREADABLE.to_string())?;
    let path = trim_crlf(text);
    if path.is_empty() || path.contains('\n') || path.contains('\r') {
        return Err(UNREADABLE.into());
    }
    let raw = PathBuf::from(path);
    let git_dir = if raw.is_absolute() {
        raw
    } else {
        dir.join(raw)
    };
    if !git_dir.exists() {
        return Err(UNREADABLE.into());
    }
    Ok(git_dir)
}

fn trim_crlf(text: &str) -> &str {
    text.trim_end_matches(['\r', '\n'])
}

/// The hook's git dir. Git sets `GIT_DIR` when it runs the hook; the current directory may be `core.worktree`.
pub(super) fn open_git_dir(git_dir: &Path, hint: &Path) -> Result<Repo, String> {
    let abs = if git_dir.is_absolute() {
        crate::fs::canonical(git_dir).unwrap_or_else(|_| git_dir.to_path_buf())
    } else {
        let joined = hint.join(git_dir);
        crate::fs::canonical(&joined).unwrap_or(joined)
    };
    if !abs.exists() {
        return Err(UNREADABLE.into());
    }
    Ok(Repo {
        git_dir: abs.clone(),
        work_tree: work_tree_for(&abs, hint),
    })
}

fn work_tree_for(git_dir: &Path, hint: &Path) -> PathBuf {
    let pointer = git_dir.join("gitdir");
    if let Ok(text) = std::fs::read_to_string(&pointer) {
        let raw = PathBuf::from(trim_crlf(&text));
        let abs = if raw.is_absolute() {
            raw
        } else {
            git_dir.join(raw)
        };
        if let Some(parent) = abs.parent() {
            if parent.is_dir() {
                return parent.to_path_buf();
            }
        }
    }
    if git_dir.file_name().and_then(|name| name.to_str()) == Some(".git") {
        if let Some(parent) = git_dir.parent() {
            if parent.is_dir() {
                return parent.to_path_buf();
            }
        }
    }
    hint.to_path_buf()
}

struct EnvKind {
    location: bool,
    injected: bool,
    config: bool,
}

/// `fold` is what Windows does: environment names there ignore case. Unix names stay as written.
fn classify_env(name: &str, fold: bool) -> EnvKind {
    let upper;
    let name = if fold {
        upper = name.to_ascii_uppercase();
        upper.as_str()
    } else {
        name
    };
    EnvKind {
        location: name.starts_with("GIT_DIR")
            || name.starts_with("GIT_WORK_TREE")
            || name.starts_with("GIT_INDEX")
            || name.starts_with("GIT_OBJECT")
            || name.starts_with("GIT_ALTERNATE")
            || name.starts_with("GIT_COMMON")
            || name.starts_with("GIT_NAMESPACE")
            || name.starts_with("GIT_REPLACE")
            || name == "GIT_SHALLOW_FILE"
            || name == "GIT_GRAFT_FILE"
            || name == "GIT_REDIRECT_STDOUT",
        injected: name == "GIT_CONFIG_PARAMETERS"
            || name == "GIT_CONFIG_COUNT"
            || name.starts_with("GIT_CONFIG_KEY_")
            || name.starts_with("GIT_CONFIG_VALUE_"),
        config: name.starts_with("GIT_CONFIG"),
    }
}

fn strip_repo_env(cmd: &mut Command, keep_global_config: bool) {
    let fold = cfg!(windows);
    for (name, _) in std::env::vars_os() {
        let Some(text) = name.to_str() else {
            continue;
        };
        let kind = classify_env(text, fold);
        if kind.location || kind.injected || (kind.config && !keep_global_config) {
            cmd.env_remove(name);
        }
    }
    // `git_cmd` adds `safe.bareRepository=explicit` on the command itself, under the next
    // `GIT_CONFIG_*` index. That is not in the process environment, so the loop above does not see it.
    // Leaving it on would skip a bare root and discover a parent repository instead.
    let inherited = std::env::var("GIT_CONFIG_COUNT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    cmd.env_remove("GIT_CONFIG_COUNT");
    cmd.env_remove("GIT_CONFIG_PARAMETERS");
    cmd.env_remove(format!("GIT_CONFIG_KEY_{inherited}"));
    cmd.env_remove(format!("GIT_CONFIG_VALUE_{inherited}"));
}

/// A guard read. Repository config is still read; the overrides below are the ones that would change the bytes.
/// Full object ids come from `--no-abbrev` on the diff commands. A numeric `core.abbrev` is rejected by git 2.43.
pub(super) fn command(repo: &Repo) -> Command {
    command_with(repo, false)
}

/// `keep_global` is only for resolving the push URL, which has to see the same global config `git push` does.
/// Content reads pass false and hide the global and system files.
fn command_with(repo: &Repo, keep_global: bool) -> Command {
    let mut cmd = crate::fs::git_cmd();
    strip_repo_env(&mut cmd, keep_global);
    cmd.current_dir(&repo.work_tree)
        .arg("--no-pager")
        .arg("--no-replace-objects")
        .arg("--git-dir")
        .arg(&repo.git_dir)
        .arg("--work-tree")
        .arg(&repo.work_tree)
        .args(["-c", "color.ui=never"])
        .args(["-c", "color.diff=never"])
        .args(["-c", "i18n.logOutputEncoding=UTF-8"])
        .args(["-c", "diff.relative=false"])
        .args(["-c", "log.showRoot=true"])
        .args(["-c", "core.fsmonitor=false"])
        .args(["-c", "diff.external="])
        .args(["-c", "filter.lfs.required=false"])
        .args(["-c", "filter.lfs.process="])
        .args(["-c", "filter.lfs.clean="])
        .args(["-c", "filter.lfs.smudge="])
        .args(["-c", "core.commitGraph=false"])
        .args(["-c", "pack.useBitmaps=false"])
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    if !keep_global {
        cmd.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null");
    }
    cmd
}

#[cfg(test)]
fn numeric_abbrev(arg: &str) -> bool {
    let rest = arg
        .strip_prefix("core.abbrev=")
        .or_else(|| arg.strip_prefix("--abbrev="));
    match rest {
        Some(rest) => !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit()),
        None => false,
    }
}

pub(super) struct LineHit {
    pub file: String,
    pub line: usize,
    pub text: String,
    pub commit: String,
}

pub(super) struct Scan {
    pub added: Vec<String>,
    pub files: Vec<String>,
    pub lines: Vec<LineHit>,
    pub messages: Vec<String>,
    /// Blob ids `cat-file` actually returned. A later walk refuses any blob a push would send that is not in here.
    pub blobs: HashSet<String>,
}

impl Scan {
    fn empty() -> Self {
        Self {
            added: Vec::new(),
            files: Vec::new(),
            lines: Vec::new(),
            messages: Vec::new(),
            blobs: HashSet::new(),
        }
    }
}

pub(super) struct Peel {
    pub commit: Option<String>,
    pub messages: Vec<String>,
    pub hits: Vec<LineHit>,
}

fn git_bytes(repo: &Repo, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut cmd = command(repo);
    cmd.args(args);
    read_capped(cmd, input, CHECK_TIMEOUT, MAX_CHECKED_BYTES)
}

fn git_text(repo: &Repo, args: &[&str]) -> Result<String, String> {
    let out = git_bytes(repo, args, None)?;
    if colour_wrapped(&out) {
        return Err(COLOUR_REFUSED.into());
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

pub(super) fn scan_revs(repo: &Repo, revs: &[&str]) -> Result<Scan, String> {
    if revs.iter().all(|rev| rev.trim().is_empty()) {
        return Ok(Scan::empty());
    }
    let mut args = vec!["rev-list"];
    args.extend_from_slice(revs);
    let listed = git_text(repo, &args)?;
    let mut scan = Scan::empty();
    for sha in listed.lines() {
        let sha = sha.trim();
        if sha.is_empty() {
            continue;
        }
        scan_commit(repo, sha, &mut scan)?;
    }
    Ok(scan)
}

fn scan_commit(repo: &Repo, sha: &str, scan: &mut Scan) -> Result<(), String> {
    let (parents, message) = commit_body(repo, sha)?;
    scan.messages.push(message);
    let diffs = if parents.is_empty() {
        vec![raw_diff(repo, &["--root", sha])?]
    } else {
        let mut diffs = Vec::new();
        for parent in &parents {
            diffs.push(raw_diff(repo, &[parent, sha])?);
        }
        diffs
    };
    let mut new_of: HashMap<String, (String, String)> = HashMap::new();
    let mut per_parent: Vec<HashMap<String, Option<(String, String)>>> = Vec::new();
    for changes in diffs {
        let mut map = HashMap::new();
        for change in changes {
            if change.new_mode == "160000" {
                continue;
            }
            new_of.insert(
                change.path.clone(),
                (change.new_sha.clone(), change.new_mode.clone()),
            );
            // A gitlink is not file content. The same object id with a different mode class is a new file.
            let old = if parent_absent(&change.old_mode, &change.old_sha) {
                None
            } else {
                Some((change.old_sha, change.old_mode))
            };
            map.insert(change.path, old);
        }
        per_parent.push(map);
    }
    let mut wanted: Vec<String> = Vec::new();
    for (path, (new_sha, new_mode)) in &new_of {
        if super::is_zero_sha(new_sha) {
            continue;
        }
        let mut added = false;
        let mut same = false;
        for map in &per_parent {
            match map.get(path) {
                None => same = true,
                Some(None) => added = true,
                Some(Some((old, old_mode)))
                    if old == new_sha && mode_class(old_mode) == mode_class(new_mode) =>
                {
                    same = true
                }
                Some(Some(_)) => {}
            }
        }
        if added && !scan.added.iter().any(|have| have == path) {
            scan.added.push(path.clone());
        }
        if same && !parents.is_empty() {
            continue;
        }
        wanted.push(new_sha.clone());
        for map in &per_parent {
            if let Some(Some((old, old_mode))) = map.get(path) {
                if old != new_sha || mode_class(old_mode) != mode_class(new_mode) {
                    wanted.push(old.clone());
                }
            }
        }
    }
    let blobs = cat_blobs(repo, &wanted)?;
    scan.blobs.extend(blobs.keys().cloned());
    for (path, (new_sha, new_mode)) in &new_of {
        if super::is_zero_sha(new_sha) {
            continue;
        }
        let mut same = false;
        let mut parent_blobs: Vec<Vec<u8>> = Vec::new();
        for map in &per_parent {
            match map.get(path) {
                None => same = true,
                Some(Some((old, old_mode)))
                    if old == new_sha && mode_class(old_mode) == mode_class(new_mode) =>
                {
                    same = true
                }
                Some(None) => parent_blobs.push(Vec::new()),
                Some(Some((old, _))) => {
                    parent_blobs.push(blobs.get(old).cloned().unwrap_or_default())
                }
            }
        }
        if same && !parents.is_empty() {
            continue;
        }
        let blob = blobs
            .get(new_sha)
            .ok_or_else(|| UNREADABLE_CHANGE.to_string())?;
        let refs: Vec<&[u8]> = parent_blobs.iter().map(Vec::as_slice).collect();
        scan.lines.extend(novel_hits(blob, &refs, path, sha));
    }
    Ok(())
}

fn commit_body(repo: &Repo, sha: &str) -> Result<(Vec<String>, String), String> {
    let bytes = git_bytes(repo, &["cat-file", "commit", sha], None)?;
    let (parents, encoding, message) = split_headers(&bytes, "parent ")?;
    let text = decode_message(&message, encoding.as_deref())?;
    if message_is_coloured(&text) {
        return Err(COLOUR_REFUSED.into());
    }
    Ok((parents, text))
}

/// Headers up to the blank line, then the raw message bytes. `id_prefix` is `parent ` for a commit and `object ` for a
/// tag. An `encoding` header is kept so the message can be turned into UTF-8 before it is scanned.
fn split_headers(bytes: &[u8], id_prefix: &str) -> Result<HeaderParts, String> {
    let prefix = id_prefix.as_bytes();
    let mut ids = Vec::new();
    let mut encoding = None;
    let mut index = 0;
    while index < bytes.len() {
        let end = bytes[index..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|at| index + at)
            .unwrap_or(bytes.len());
        let line = &bytes[index..end];
        let next = if end < bytes.len() { end + 1 } else { end };
        if line.is_empty() {
            return Ok((ids, encoding, bytes[next..].to_vec()));
        }
        if let Some(rest) = line.strip_prefix(prefix) {
            let id = String::from_utf8_lossy(rest).trim().to_string();
            if !id.is_empty() {
                ids.push(id);
            }
        } else if let Some(rest) = strip_ascii_prefix(line, b"encoding ") {
            encoding = Some(String::from_utf8_lossy(rest).trim().to_string());
        }
        index = next;
    }
    Ok((ids, encoding, Vec::new()))
}

fn strip_ascii_prefix<'a>(line: &'a [u8], prefix: &[u8]) -> Option<&'a [u8]> {
    if line.len() < prefix.len() {
        return None;
    }
    if line[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&line[prefix.len()..])
    } else {
        None
    }
}

fn same_encoding(name: &str, choices: &[&str]) -> bool {
    choices
        .iter()
        .any(|choice| name.eq_ignore_ascii_case(choice))
}

/// A message with an `encoding` header is not scanned as raw bytes. UTF-8, ISO-8859-1 and UTF-16 are decoded here.
/// Anything else goes through `iconv` when the name is a plain token, and a failed conversion is a refusal.
fn decode_message(raw: &[u8], encoding: Option<&str>) -> Result<String, String> {
    let name = encoding.unwrap_or("UTF-8").trim();
    if name.is_empty() || same_encoding(name, &["utf-8", "utf8"]) {
        return if encoding.is_none() {
            Ok(String::from_utf8_lossy(raw).into_owned())
        } else {
            String::from_utf8(raw.to_vec()).map_err(|_| UNREADABLE_CHANGE.to_string())
        };
    }
    if same_encoding(name, &["iso-8859-1", "iso8859-1", "latin1", "latin-1"]) {
        return Ok(raw.iter().map(|byte| char::from(*byte)).collect());
    }
    if same_encoding(name, &["utf-16", "utf-16le", "utf-16be"]) {
        return decode_utf16(raw, name);
    }
    if !name
        .chars()
        .all(|char| char.is_ascii_alphanumeric() || char == '_' || char == '-')
    {
        return Err(UNREADABLE_CHANGE.into());
    }
    iconv_utf8(name, raw)
}

fn decode_utf16(raw: &[u8], name: &str) -> Result<String, String> {
    let (data, big) = if raw.starts_with(&[0xFF, 0xFE]) {
        (&raw[2..], false)
    } else if raw.starts_with(&[0xFE, 0xFF]) {
        (&raw[2..], true)
    } else if name.eq_ignore_ascii_case("utf-16be") {
        (raw, true)
    } else {
        (raw, false)
    };
    if data.len() % 2 != 0 {
        return Err(UNREADABLE_CHANGE.into());
    }
    let units: Vec<u16> = data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            if big {
                u16::from_be_bytes(*pair)
            } else {
                u16::from_le_bytes(*pair)
            }
        })
        .collect();
    String::from_utf16(&units).map_err(|_| UNREADABLE_CHANGE.to_string())
}

fn iconv_utf8(name: &str, raw: &[u8]) -> Result<String, String> {
    let mut cmd = Command::new("iconv");
    cmd.args(["-f", name, "-t", "UTF-8"])
        .env("PATH", crate::harness::cached_gui_search_path());
    let out = read_capped(
        cmd,
        Some(raw),
        super::CHECK_TIMEOUT,
        super::MAX_CHECKED_BYTES,
    )?;
    String::from_utf8(out).map_err(|_| UNREADABLE_CHANGE.to_string())
}

fn mode_class(mode: &str) -> &'static str {
    match mode {
        "160000" => "gitlink",
        "120000" => "symlink",
        _ => "file",
    }
}

fn parent_absent(mode: &str, sha: &str) -> bool {
    super::is_zero_sha(sha) || mode == "160000"
}

fn message_is_coloured(message: &str) -> bool {
    message
        .split('\n')
        .any(|line| line.as_bytes().first() == Some(&0x1b))
}

struct Change {
    old_mode: String,
    old_sha: String,
    new_sha: String,
    new_mode: String,
    path: String,
}

fn raw_diff(repo: &Repo, trees: &[&str]) -> Result<Vec<Change>, String> {
    let mut args = vec![
        "diff-tree",
        "-r",
        "-z",
        "--raw",
        "--no-renames",
        "--no-commit-id",
        "--no-abbrev",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
    ];
    args.extend(trees);
    parse_raw(&git_bytes(repo, &args, None)?)
}

fn parse_raw(bytes: &[u8]) -> Result<Vec<Change>, String> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        if rest.iter().all(|byte| byte.is_ascii_whitespace()) {
            break;
        }
        let Some(end) = rest.iter().position(|byte| *byte == 0) else {
            return Err(UNREADABLE_CHANGE.into());
        };
        let head = &rest[..end];
        rest = &rest[end + 1..];
        let Some(path_end) = rest.iter().position(|byte| *byte == 0) else {
            return Err(UNREADABLE_CHANGE.into());
        };
        let path = String::from_utf8_lossy(&rest[..path_end]).into_owned();
        rest = &rest[path_end + 1..];
        let head = String::from_utf8_lossy(head);
        let mut parts = head.split_whitespace();
        let old_mode = parts
            .next()
            .unwrap_or("")
            .trim_start_matches(':')
            .to_string();
        let new_mode = parts.next().unwrap_or("").to_string();
        let old_sha = parts.next().unwrap_or("").to_string();
        let new_sha = parts.next().unwrap_or("").to_string();
        let status = parts.next().unwrap_or("");
        if status.is_empty()
            || path.is_empty()
            || old_mode.is_empty()
            || new_mode.is_empty()
            || old_sha.is_empty()
            || new_sha.is_empty()
        {
            return Err(UNREADABLE_CHANGE.into());
        }
        out.push(Change {
            old_mode,
            old_sha,
            new_sha,
            new_mode,
            path,
        });
    }
    Ok(out)
}

fn cat_blobs(repo: &Repo, shas: &[String]) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut unique = Vec::new();
    for sha in shas {
        if super::is_zero_sha(sha) || unique.iter().any(|have: &String| have == sha) {
            continue;
        }
        unique.push(sha.clone());
    }
    if unique.is_empty() {
        return Ok(HashMap::new());
    }
    let input = unique.join("\n") + "\n";
    let bytes = git_bytes(repo, &["cat-file", "--batch"], Some(input.as_bytes()))?;
    parse_batch(&bytes)
}

fn parse_batch(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut map = HashMap::new();
    let mut index = 0;
    while index < bytes.len() {
        let Some(relative) = bytes[index..].iter().position(|byte| *byte == b'\n') else {
            return Err(UNREADABLE_CHANGE.into());
        };
        let header = std::str::from_utf8(&bytes[index..index + relative])
            .map_err(|_| UNREADABLE_CHANGE.to_string())?;
        index += relative + 1;
        let mut parts = header.split_whitespace();
        let sha = parts.next().unwrap_or("");
        let kind = parts.next().unwrap_or("");
        if kind == "missing" {
            continue;
        }
        // Content is a blob. A commit, a tree, or a header this parser does not know is a refusal.
        if kind != "blob" {
            return Err(UNREADABLE_CHANGE.into());
        }
        let Some(size_text) = parts.next() else {
            return Err(UNREADABLE_CHANGE.into());
        };
        let size: usize = size_text
            .parse()
            .map_err(|_| UNREADABLE_CHANGE.to_string())?;
        if sha.is_empty() || index + size > bytes.len() {
            return Err(UNREADABLE_CHANGE.into());
        }
        map.insert(sha.to_string(), bytes[index..index + size].to_vec());
        index += size;
        if index < bytes.len() && bytes[index] == b'\n' {
            index += 1;
        }
    }
    Ok(map)
}

fn lines_of(bytes: &[u8]) -> Vec<Vec<u8>> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<Vec<u8>> = bytes
        .split(|byte| *byte == b'\n')
        .map(|part| {
            let mut line = part.to_vec();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            line
        })
        .collect();
    if bytes.last() == Some(&b'\n') {
        lines.pop();
    }
    lines
}

fn display_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\0', "")
}

fn count_lines(lines: &[Vec<u8>]) -> HashMap<Vec<u8>, usize> {
    let mut counts = HashMap::new();
    for line in lines {
        *counts.entry(line.clone()).or_insert(0) += 1;
    }
    counts
}

/// A line is new when this occurrence is past every parent's count of the same bytes.
fn novel_hits(blob: &[u8], parents: &[&[u8]], file: &str, commit: &str) -> Vec<LineHit> {
    let commit_lines = lines_of(blob);
    let parent_counts: Vec<HashMap<Vec<u8>, usize>> = parents
        .iter()
        .map(|parent| count_lines(&lines_of(parent)))
        .collect();
    let mut seen: HashMap<Vec<u8>, usize> = HashMap::new();
    let mut hits = Vec::new();
    for (index, line) in commit_lines.iter().enumerate() {
        let count = seen.entry(line.clone()).or_insert(0);
        *count += 1;
        let most = parent_counts
            .iter()
            .map(|counts| counts.get(line).copied().unwrap_or(0))
            .max()
            .unwrap_or(0);
        if *count > most {
            hits.push(LineHit {
                file: file.to_string(),
                line: index + 1,
                text: display_line(line),
                commit: commit.to_string(),
            });
        }
    }
    hits
}

fn all_hits(bytes: &[u8], file: &str, commit: &str) -> Vec<LineHit> {
    lines_of(bytes)
        .into_iter()
        .enumerate()
        .map(|(index, line)| LineHit {
            file: file.to_string(),
            line: index + 1,
            text: display_line(&line),
            commit: commit.to_string(),
        })
        .collect()
}

pub(super) fn peel(repo: &Repo, sha: &str) -> Result<Peel, String> {
    let mut seen = HashSet::new();
    let mut current = sha.to_string();
    let mut messages = Vec::new();
    loop {
        if !seen.insert(current.clone()) {
            return Err("The secret check could not read this tag, so nothing was sent.".into());
        }
        match object_type(repo, &current)?.as_str() {
            "commit" => {
                return Ok(Peel {
                    commit: Some(current),
                    messages,
                    hits: Vec::new(),
                });
            }
            "tag" => {
                let bytes = git_bytes(repo, &["cat-file", "tag", &current], None)?;
                let (targets, encoding, message) = split_headers(&bytes, "object ")?;
                let next = targets
                    .into_iter()
                    .next()
                    .filter(|sha| !sha.is_empty())
                    .ok_or_else(|| UNREADABLE_CHANGE.to_string())?;
                let text = decode_message(&message, encoding.as_deref())?;
                if message_is_coloured(&text) {
                    return Err(COLOUR_REFUSED.into());
                }
                messages.push(text);
                current = next;
            }
            "blob" => {
                let bytes = one_blob(repo, &current)?;
                return Ok(Peel {
                    commit: None,
                    messages,
                    hits: all_hits(&bytes, "tagged-blob", ""),
                });
            }
            "tree" => {
                return Ok(Peel {
                    commit: None,
                    messages,
                    hits: tree_hits(repo, &current)?,
                });
            }
            other => {
                return Err(format!(
                    "The secret check could not read this object ({other}), so nothing was sent."
                ));
            }
        }
    }
}

fn object_type(repo: &Repo, sha: &str) -> Result<String, String> {
    let text = git_text(repo, &["cat-file", "-t", sha])?;
    Ok(text.trim().to_string())
}

fn one_blob(repo: &Repo, sha: &str) -> Result<Vec<u8>, String> {
    let map = cat_blobs(repo, &[sha.to_string()])?;
    map.get(sha)
        .cloned()
        .ok_or_else(|| UNREADABLE_CHANGE.to_string())
}

fn tree_hits(repo: &Repo, sha: &str) -> Result<Vec<LineHit>, String> {
    let listed = git_bytes(repo, &["ls-tree", "-r", "-z", sha], None)?;
    let mut paths = Vec::new();
    let mut shas = Vec::new();
    let mut rest = listed.as_slice();
    while !rest.is_empty() {
        if rest.iter().all(|byte| byte.is_ascii_whitespace()) {
            break;
        }
        let Some(end) = rest.iter().position(|byte| *byte == 0) else {
            return Err(UNREADABLE_CHANGE.into());
        };
        let record = String::from_utf8_lossy(&rest[..end]);
        rest = &rest[end + 1..];
        let Some((meta, path)) = record.split_once('\t') else {
            return Err(UNREADABLE_CHANGE.into());
        };
        let mut parts = meta.split_whitespace();
        let mode = parts.next().unwrap_or("");
        let kind = parts.next().unwrap_or("");
        let blob = parts.next().unwrap_or("");
        if kind != "blob" || mode == "160000" || blob.is_empty() || path.is_empty() {
            continue;
        }
        paths.push(path.to_string());
        shas.push(blob.to_string());
    }
    let blobs = cat_blobs(repo, &shas)?;
    let mut hits = Vec::new();
    for (path, sha) in paths.iter().zip(shas.iter()) {
        let Some(bytes) = blobs.get(sha) else {
            return Err(UNREADABLE_CHANGE.into());
        };
        hits.extend(all_hits(bytes, path, ""));
    }
    Ok(hits)
}

/// The index against `base`: every changed path, and the lines the index adds over that tree.
pub(super) fn scan_index(repo: &Repo, index: &Path, base: &str) -> Result<Scan, String> {
    let mut cmd = command(repo);
    cmd.env("GIT_INDEX_FILE", index).args([
        "diff-index",
        "--cached",
        "-r",
        "-z",
        "--raw",
        "--no-renames",
        "--no-abbrev",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        base,
    ]);
    let bytes = read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES)?;
    let changes = parse_raw(&bytes)?;
    let scan = scan_changes(repo, &changes)?;
    note_index_read(index);
    Ok(scan)
}

fn scan_changes(repo: &Repo, changes: &[Change]) -> Result<Scan, String> {
    let mut scan = Scan::empty();
    let mut wanted = Vec::new();
    for change in changes {
        if !scan.files.iter().any(|have| have == &change.path) {
            scan.files.push(change.path.clone());
        }
        if change.new_mode == "160000" || super::is_zero_sha(&change.new_sha) {
            continue;
        }
        let absent = parent_absent(&change.old_mode, &change.old_sha);
        let same = !absent
            && change.old_sha == change.new_sha
            && mode_class(&change.old_mode) == mode_class(&change.new_mode);
        if absent && !scan.added.iter().any(|have| have == &change.path) {
            scan.added.push(change.path.clone());
        }
        if same {
            continue;
        }
        wanted.push(change.new_sha.clone());
        if !absent {
            wanted.push(change.old_sha.clone());
        }
    }
    let blobs = cat_blobs(repo, &wanted)?;
    scan.blobs.extend(blobs.keys().cloned());
    for change in changes {
        if change.new_mode == "160000" || super::is_zero_sha(&change.new_sha) {
            continue;
        }
        let absent = parent_absent(&change.old_mode, &change.old_sha);
        let same = !absent
            && change.old_sha == change.new_sha
            && mode_class(&change.old_mode) == mode_class(&change.new_mode);
        if same {
            continue;
        }
        let blob = blobs
            .get(&change.new_sha)
            .ok_or_else(|| UNREADABLE_CHANGE.to_string())?;
        let parent = if absent {
            Vec::new()
        } else {
            blobs.get(&change.old_sha).cloned().unwrap_or_default()
        };
        scan.lines
            .extend(novel_hits(blob, &[parent.as_slice()], &change.path, ""));
    }
    Ok(scan)
}

/// Writes `index` to one tree and returns that id. The test hook runs only after the id is in hand, so a
/// later edit of the index cannot change a scan, a patch or a blob read that all use this id.
pub(super) fn index_tree(repo: &Repo, index: &Path) -> Result<String, String> {
    let mut write = command(repo);
    write.env("GIT_INDEX_FILE", index).args(["write-tree"]);
    let written = read_capped(write, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES)?;
    let tree = String::from_utf8_lossy(&written).trim().to_string();
    if !is_oid(&tree) {
        return Err(UNREADABLE_CHANGE.into());
    }
    note_index_read(index);
    Ok(tree)
}

fn commit_tree(repo: &Repo, base: &str) -> Result<String, String> {
    let base_tree = git_text(repo, &["rev-parse", &format!("{base}^{{tree}}")])?;
    let base_tree = base_tree.trim().to_string();
    if !is_oid(&base_tree) {
        return Err(UNREADABLE_CHANGE.into());
    }
    Ok(base_tree)
}

/// The same scan as `scan_index`, read from a tree id instead of the index.
pub(super) fn scan_tree(repo: &Repo, tree: &str, base: &str) -> Result<Scan, String> {
    let base_tree = commit_tree(repo, base)?;
    let changes = raw_diff(repo, &[&base_tree, tree])?;
    scan_changes(repo, &changes)
}

/// The patch `land` applies. `git diff --cached` can return the work tree when the index stat matches, so this
/// writes the index to a tree and diffs that tree. Textconv stays off, and the patch has no commit line, so
/// `git apply` can still take it.
pub(super) fn index_patch(repo: &Repo, index: &Path, base: &str) -> Result<Vec<u8>, String> {
    let tree = index_tree(repo, index)?;
    tree_patch(repo, &tree, base)
}

pub(super) fn tree_patch(repo: &Repo, tree: &str, base: &str) -> Result<Vec<u8>, String> {
    let base_tree = commit_tree(repo, base)?;
    let mut diff = command(repo);
    diff.args([
        "diff-tree",
        "-p",
        "--binary",
        "--full-index",
        "--no-abbrev",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-commit-id",
        &base_tree,
        tree,
    ]);
    read_capped(diff, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES)
}

fn is_oid(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64) && text.chars().all(|c| c.is_ascii_hexdigit())
}

fn git_path(repo: &Repo, name: &str) -> Result<PathBuf, String> {
    let mut cmd = command(repo);
    cmd.args(["rev-parse", "--git-path", name]);
    let out = read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES)?;
    if colour_wrapped(&out) {
        return Err(COLOUR_REFUSED.into());
    }
    let text = String::from_utf8_lossy(&out).trim().to_string();
    if text.is_empty() {
        return Err(UNREADABLE.into());
    }
    let path = PathBuf::from(text);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(repo.work_tree.join(path))
    }
}

/// A commit-graph file git would read from this object store: the single file, or a split chain.
fn commit_graph_file(objects: &Path) -> bool {
    let info = objects.join("info");
    if info.join("commit-graph").is_file() {
        return true;
    }
    let graphs = info.join("commit-graphs");
    if graphs.join("commit-graph-chain").is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(&graphs) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("graph"))
}

/// An alternate object store with a commit-graph is untrusted. `git commit-graph verify` reads the repository's own
/// graph, not one reached through `objects/info/alternates`, and `git push` would still walk that graph. The stores
/// come from `count-objects -v`, which lists nested alternates and unquotes a quoted line the way `git push` does. A
/// path it still prints quoted is untrusted.
fn alternate_has_commit_graph(repo: &Repo) -> Result<bool, String> {
    let text = git_text(repo, &["-c", "core.quotePath=false", "count-objects", "-v"])?;
    for line in text.lines() {
        let Some(store) = line.strip_prefix("alternate: ") else {
            continue;
        };
        if store.starts_with('"') || commit_graph_file(Path::new(store)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `true` when a local graph fails `git commit-graph verify`, or an alternate store has a graph. No graph is trusted.
/// The command carries the guard's usual `-c` flags. Any failure, including a timeout, is untrusted.
fn commit_graph_untrusted(repo: &Repo) -> Result<bool, String> {
    if alternate_has_commit_graph(repo)? {
        return Ok(true);
    }
    let single = git_path(repo, "objects/info/commit-graph")?;
    let chain = git_path(repo, "objects/info/commit-graphs/commit-graph-chain")?;
    if !single.is_file() && !chain.is_file() {
        return Ok(false);
    }
    let mut cmd = command(repo);
    cmd.args(["commit-graph", "verify"]);
    match read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES) {
        Ok(_) => Ok(false),
        Err(_) => Ok(true),
    }
}

/// Blobs a push of `revs` would send that `read` did not already scan.
///
/// The honest walk turns the commit-graph and pack bitmaps off, which is what the app's own push does. A second
/// walk turns each cache back on, because a pre-push hook cannot pass those flags to the parent `git push`. A blob
/// only the cache names is scanned and then refused. A blob the honest walk names and the diff skipped is scanned
/// and allowed when it is clean. A graph `git commit-graph verify` rejects, or a graph in an alternate object store,
/// is untrusted even when the two walks name the same blobs: the parent's push walks trees sparsely and can still send
/// a blob both walks counted as already upstream.
pub(super) struct Reach {
    pub added: Vec<String>,
    pub lines: Vec<LineHit>,
    pub untrusted: bool,
}

pub(super) fn reachable_extra(
    repo: &Repo,
    revs: &[&str],
    read: &HashSet<String>,
) -> Result<Reach, String> {
    if revs.iter().all(|rev| rev.trim().is_empty()) {
        return Ok(Reach {
            added: Vec::new(),
            lines: Vec::new(),
            untrusted: false,
        });
    }
    let honest = blob_map(repo, &[], &[], revs)?;
    let graphed = blob_map(repo, &["-c", "core.commitGraph=true"], &[], revs)?;
    let bitmapped = match blob_map(
        repo,
        &["-c", "pack.useBitmaps=true"],
        &["--use-bitmap-index"],
        revs,
    ) {
        Ok(map) => map,
        Err(error) => {
            let lower = error.to_ascii_lowercase();
            let unknown = lower.contains("unknown")
                || lower.contains("unrecognized")
                || lower.contains("invalid");
            if unknown && lower.contains("bitmap") {
                HashMap::new()
            } else {
                return Err(error);
            }
        }
    };
    let untrusted = commit_graph_untrusted(repo)?
        || graphed
            .keys()
            .chain(bitmapped.keys())
            .any(|oid| !honest.contains_key(oid));
    let mut wanted: HashMap<String, String> = HashMap::new();
    for map in [&honest, &graphed, &bitmapped] {
        for (oid, path) in map {
            if read.contains(oid) {
                continue;
            }
            wanted.entry(oid.clone()).or_insert_with(|| path.clone());
        }
    }
    let oids: Vec<String> = wanted.keys().cloned().collect();
    let blobs = cat_blobs(repo, &oids)?;
    let mut added = Vec::new();
    let mut lines = Vec::new();
    for (oid, path) in &wanted {
        let Some(blob) = blobs.get(oid) else {
            return Err(UNREADABLE_CHANGE.into());
        };
        if !path.is_empty() && !added.iter().any(|have| have == path) {
            added.push(path.clone());
        }
        lines.extend(all_hits(blob, path, ""));
    }
    Ok(Reach {
        added,
        lines,
        untrusted,
    })
}

/// `rev-list --objects` lines are `<oid>` or `<oid> <path>`. Later `-c` overrides the guard's own flags.
/// Only blobs are kept. A missing object is not a blob a push can send.
fn blob_map(
    repo: &Repo,
    config: &[&str],
    flags: &[&str],
    revs: &[&str],
) -> Result<HashMap<String, String>, String> {
    let mut cmd = command(repo);
    cmd.args(config);
    cmd.arg("rev-list");
    cmd.arg("--objects");
    cmd.args(flags);
    for rev in revs {
        if !rev.trim().is_empty() {
            cmd.arg(*rev);
        }
    }
    let out = read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES)?;
    if colour_wrapped(&out) {
        return Err(COLOUR_REFUSED.into());
    }
    let mut listed: HashMap<String, String> = HashMap::new();
    for line in String::from_utf8_lossy(&out).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (oid, path) = match line.split_once(' ') {
            Some((oid, path)) => (oid, path),
            None => (line, ""),
        };
        if !is_oid(oid) {
            continue;
        }
        listed
            .entry(oid.to_string())
            .or_insert_with(|| path.to_string());
    }
    if listed.is_empty() {
        return Ok(HashMap::new());
    }
    let mut input = String::new();
    for oid in listed.keys() {
        input.push_str(oid);
        input.push('\n');
    }
    let checked = git_bytes(repo, &["cat-file", "--batch-check"], Some(input.as_bytes()))?;
    if colour_wrapped(&checked) {
        return Err(COLOUR_REFUSED.into());
    }
    let mut blobs = HashMap::new();
    for line in String::from_utf8_lossy(&checked).lines() {
        let mut parts = line.split_whitespace();
        let oid = parts.next().unwrap_or("");
        let kind = parts.next().unwrap_or("");
        if kind == "blob" {
            if let Some(path) = listed.get(oid) {
                blobs.insert(oid.to_string(), path.clone());
            }
        }
    }
    Ok(blobs)
}

/// The staged blob for each path, or `None` when the index does not have that path (a deletion). Not the work tree.
pub(super) fn index_blobs(
    repo: &Repo,
    index: &Path,
    paths: &[String],
) -> Result<Vec<StagedBlob>, String> {
    staged_at(repo, Some(index), paths, |path| format!(":{path}"))
}

/// Blobs from a tree id. A missing path is a deletion. This does not read the index.
pub(super) fn tree_blobs(
    repo: &Repo,
    tree: &str,
    paths: &[String],
) -> Result<Vec<StagedBlob>, String> {
    if !is_oid(tree) {
        return Err(UNREADABLE_CHANGE.into());
    }
    staged_at(repo, None, paths, |path| format!("{tree}:{path}"))
}

fn staged_at(
    repo: &Repo,
    index: Option<&Path>,
    paths: &[String],
    spec: impl Fn(&str) -> String,
) -> Result<Vec<StagedBlob>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = String::new();
    for path in paths {
        if path.contains('\n') || path.contains('\0') {
            return Err(UNREADABLE_CHANGE.into());
        }
        input.push_str(&spec(path));
        input.push('\n');
    }
    let mut cmd = command(repo);
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    cmd.args(["cat-file", "--batch"]);
    let bytes = read_capped(
        cmd,
        Some(input.as_bytes()),
        CHECK_TIMEOUT,
        MAX_CHECKED_BYTES,
    )?;
    let mut out = Vec::new();
    let mut at = 0;
    for path in paths {
        if at >= bytes.len() {
            return Err(UNREADABLE_CHANGE.into());
        }
        let Some(relative) = bytes[at..].iter().position(|byte| *byte == b'\n') else {
            return Err(UNREADABLE_CHANGE.into());
        };
        let header = std::str::from_utf8(&bytes[at..at + relative])
            .map_err(|_| UNREADABLE_CHANGE.to_string())?;
        at += relative + 1;
        // The object name is the path, which may contain spaces, so the type and size are the last two words.
        if header.ends_with(" missing") {
            out.push((path.clone(), None));
            continue;
        }
        let Some((head, size_text)) = header.rsplit_once(' ') else {
            return Err(UNREADABLE_CHANGE.into());
        };
        let Some((_, kind)) = head.rsplit_once(' ') else {
            return Err(UNREADABLE_CHANGE.into());
        };
        if kind != "blob" {
            return Err(UNREADABLE_CHANGE.into());
        }
        let size: usize = size_text
            .parse()
            .map_err(|_| UNREADABLE_CHANGE.to_string())?;
        if at + size > bytes.len() {
            return Err(UNREADABLE_CHANGE.into());
        }
        let blob = bytes[at..at + size].to_vec();
        at += size;
        if at < bytes.len() && bytes[at] == b'\n' {
            at += 1;
        }
        out.push((path.clone(), Some(blob)));
    }
    if let Some(index) = index {
        note_index_read(index);
    }
    Ok(out)
}

fn has_url_rewrite(repo: &Repo) -> Result<bool, String> {
    let mut cmd = command(repo);
    cmd.args(["config", "--local", "--get-regexp", r"^url\."]);
    match read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES) {
        Ok(out) => Ok(!out.is_empty()),
        // `git config --get-regexp` exits 1, with nothing on stderr, when no key matches.
        Err(error) if error == "git failed" || error.is_empty() => Ok(false),
        Err(error) => Err(error),
    }
}

/// A push URL with no scheme and no host. `ls-remote` would resolve it from its scratch folder.
fn is_relative_push_url(url: &str) -> bool {
    if url.is_empty() || url.contains("://") || is_windows_drive(url) || is_scp_style(url) {
        return false;
    }
    !Path::new(url).is_absolute()
}

fn is_windows_drive(url: &str) -> bool {
    let mut chars = url.chars();
    let Some(letter) = chars.next() else {
        return false;
    };
    if !letter.is_ascii_alphabetic() || chars.next() != Some(':') {
        return false;
    }
    matches!(chars.next(), Some('/' | '\\') | None)
}

/// `host:path`, which git does not resolve as a file. A single-letter head is a Windows drive, not a host.
fn is_scp_style(url: &str) -> bool {
    let Some(colon) = url.find(':') else {
        return false;
    };
    if colon == 0 {
        return false;
    }
    let head = &url[..colon];
    if head.contains('/') || head.contains('\\') {
        return false;
    }
    if head.len() == 1 && head.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    true
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolves a relative push URL from `work_tree`. Anything else is returned unchanged. The result is
/// lexical: the directory does not have to exist, and a symlink in the temp path is not rewritten.
fn settle_push_url(work_tree: &Path, url: &str) -> String {
    let url = url.trim();
    if !is_relative_push_url(url) {
        return url.to_string();
    }
    lexical_normalize(&work_tree.join(url))
        .to_str()
        .unwrap_or(url)
        .to_string()
}

fn push_unique(urls: &mut Vec<String>, url: String) {
    let url = url.trim().to_string();
    if !url.is_empty() && !urls.iter().any(|have| have == &url) {
        urls.push(url);
    }
}

/// Every URL `git push` uses for `remote`. `get-url --push` already applies `pushInsteadOf`, or `insteadOf` when no
/// push rewrite matches, which is the same URL the push itself contacts. This call keeps the global and the system
/// config, because the push does too. Hiding the system file would let a system `url.insteadOf` send the push to a
/// remote this check never asked. The configured string is not added as well: a checkout may rewrite a public name
/// onto a local stand-in, and asking that public name would refuse a push that never goes there. The caller then reads
/// each of these URLs from outside the repository, with `url.*` hidden, so a second `insteadOf` cannot point the check
/// at a decoy.
pub(super) fn push_destinations(repo: &Repo, remote: &str) -> Result<Vec<String>, String> {
    refuse_own_push_command(repo, remote)?;
    let mut cmd = command_with(repo, true);
    cmd.args(["remote", "get-url", "--push", "--all", remote]);
    let output = match read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES) {
        Ok(output) => output,
        Err(error) => {
            if has_url_rewrite(repo)? {
                return Err(
                    "The secret check could not read where this push goes, so nothing was sent."
                        .into(),
                );
            }
            if error == "git failed" || error.is_empty() {
                return Err(format!("the remote {remote} has no push URL"));
            }
            return Err(error);
        }
    };
    let mut urls = Vec::new();
    for url in String::from_utf8_lossy(&output).lines() {
        // A relative URL is resolved from this checkout. `ls-remote` runs in a scratch folder, so the
        // same string would otherwise name a different directory there than `git push` uses.
        push_unique(&mut urls, settle_push_url(&repo.work_tree, url));
    }
    if urls.is_empty() {
        return Err(format!("the remote {remote} has no push URL"));
    }
    Ok(urls)
}

/// `remote.<name>.receivepack` and `remote.<name>.vcs` pick what `git push` runs for that remote, and git keeps the
/// first value it reads, so the app's own `-c` cannot replace one the repository sets. The check reads each push URL
/// with plain git from outside the repository, so a remote that sets either is refused: its push can reach a
/// repository that read never asked (a decoy URL with `receivepack = git-receive-pack '<real>' #`).
pub(super) fn refuse_own_push_command(repo: &Repo, remote: &str) -> Result<(), String> {
    for key in ["receivepack", "vcs"] {
        let mut cmd = command_with(repo, true);
        cmd.args(["config", "--get-all", &format!("remote.{remote}.{key}")]);
        match read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES) {
            Ok(_) => {
                return Err(format!(
                    "The remote {remote} sets its own push command (remote.{remote}.{key}), so the secret check cannot tell where the push goes. Nothing was sent."
                ))
            }
            // `git config --get-all` exits 1, with nothing on stderr, when the key is not set.
            Err(error) if error == "git failed" || error.is_empty() => {}
            Err(error) => return Err(error),
        }
    }
    // The same for `core.sshCommand` set by the repository itself: the check's read runs outside the repository with
    // plain ssh, while the push would run the repository's command, which can send it to another host than the URL
    // names. Ash's own global or system value is the same for both, so only a local or worktree value is refused.
    let mut cmd = command_with(repo, true);
    cmd.args(["config", "--show-scope", "--get-all", "core.sshCommand"]);
    match read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES) {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out);
            if text
                .lines()
                .any(|line| line.starts_with("local\t") || line.starts_with("worktree\t"))
            {
                return Err(
                    "This repository sets its own ssh command (core.sshCommand), so the secret check cannot tell where the push goes. Nothing was sent."
                        .to_string(),
                );
            }
        }
        Err(error) if error == "git failed" || error.is_empty() => {}
        Err(error) => return Err(error),
    }
    Ok(())
}

pub(super) fn destinations_for(repo: &Repo, target: &str) -> Result<Vec<String>, String> {
    if let Ok(urls) = push_destinations(repo, target) {
        if !urls.is_empty() {
            return Ok(urls);
        }
    }
    if target.contains("://") || target.starts_with('/') || target.starts_with('.') {
        return Ok(vec![settle_push_url(&repo.work_tree, target)]);
    }
    Err(format!("the remote {target} has no push URL"))
}

/// Tips a remote advertises, read from outside the repository. The credential helper is kept. `url.*` is not.
pub(super) fn advertised_shas(repo: &Repo, url: &str) -> Result<Vec<String>, String> {
    let scratch = exclusive_scratch("cg-ls")?;
    let result = advertised_in(&scratch, url, &repo.git_dir);
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// A scratch folder whose name a same-user racer cannot guess, created so that an existing path fails the attempt.
fn exclusive_scratch(prefix: &str) -> Result<PathBuf, String> {
    for _ in 0..8 {
        let path = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("The secret check could not make a temporary folder, so nothing was sent.".into())
}

fn advertised_in(scratch: &Path, url: &str, git_dir: &Path) -> Result<Vec<String>, String> {
    let mut cmd = ls_remote_cmd(scratch, Some(git_dir))?;
    cmd.args(["--no-pager", "-c", "color.ui=never", "ls-remote", url]);
    let out = read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES)?;
    if colour_wrapped(&out) {
        return Err(COLOUR_REFUSED.into());
    }
    let text = String::from_utf8_lossy(&out);
    Ok(text
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .filter(|sha| {
            (sha.len() == 40 || sha.len() == 64) && sha.chars().all(|c| c.is_ascii_hexdigit())
        })
        .map(str::to_string)
        .collect())
}

pub(super) fn local_tips(repo: &Repo, shas: &[String]) -> Result<Vec<String>, String> {
    if shas.is_empty() {
        return Ok(Vec::new());
    }
    let input = format!("{}\n", shas.join("\n"));
    let out = git_bytes(repo, &["cat-file", "--batch-check"], Some(input.as_bytes()))?;
    if colour_wrapped(&out) {
        return Err(COLOUR_REFUSED.into());
    }
    let text = String::from_utf8_lossy(&out);
    Ok(text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let sha = parts.next()?.to_string();
            let kind = parts.next()?.to_string();
            (kind == "commit" || kind == "tag").then_some(sha)
        })
        .collect())
}

/// Reads child output until the cap, then kills the child. The cap is not applied after the process has finished.
pub(super) fn read_capped(
    mut cmd: Command,
    input: Option<&[u8]>,
    limit: Duration,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| error.to_string())?;
    let stdin = child.stdin.take();
    let data = input.map(|bytes| bytes.to_vec());
    let writer = std::thread::spawn(move || {
        if let (Some(mut pipe), Some(bytes)) = (stdin, data) {
            let _ = pipe.write_all(&bytes);
        }
    });
    let mut stdout = child.stdout.take().ok_or("git output was not piped")?;
    let mut stderr = child.stderr.take().ok_or("git errors were not piped")?;
    let over = Arc::new(AtomicBool::new(false));
    let flag = over.clone();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > max_bytes {
                        flag.store(true, Ordering::Relaxed);
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        buf
    });
    let err_flag = over.clone();
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > max_bytes {
                        err_flag.store(true, Ordering::Relaxed);
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        buf
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        if over.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = writer.join();
            let _ = out_reader.join();
            let _ = err_reader.join();
            return Err(super::TOO_LARGE.into());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = writer.join();
            let _ = out_reader.join();
            let _ = err_reader.join();
            return Err(super::TIMED_OUT.into());
        }
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let _ = writer.join();
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    if over.load(Ordering::Relaxed) || out.len() > max_bytes || err.len() > max_bytes {
        return Err(super::TOO_LARGE.into());
    }
    if !status.success() {
        let message = String::from_utf8_lossy(&err).trim().to_string();
        if message.is_empty() {
            return Err("git failed".into());
        }
        return Err(message);
    }
    Ok(out)
}

/// `ls-remote` outside the repository. Credential keys from the global and system config are passed as
/// `GIT_CONFIG_KEY_<n>` pairs. Both config files are `/dev/null`, so a file planted in the scratch folder cannot
/// replace them and a `url.*` rewrite cannot steer the read. A missing config or a failed lookup is no extra
/// credentials, not a failed push. `git_dir` is the repository `git push` runs in, for `includeIf` (see below).
fn ls_remote_cmd(scratch: &Path, git_dir: Option<&Path>) -> Result<Command, String> {
    let empty = scratch.join("empty");
    std::fs::create_dir_all(&empty).map_err(|error| error.to_string())?;
    // Git ignores a ceiling equal to the current directory. The ceiling has to be a proper ancestor, and the
    // command has to run somewhere that ancestor actually contains.
    let ceiling = match scratch.parent() {
        Some(parent) => crate::fs::canonical(parent).unwrap_or_else(|_| parent.to_path_buf()),
        None => scratch.to_path_buf(),
    };
    let pairs = kept_credential_pairs(git_dir);
    let mut cmd = crate::fs::git_cmd();
    strip_repo_env(&mut cmd, true);
    cmd.current_dir(&empty)
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_CEILING_DIRECTORIES", &ceiling)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0");
    apply_config_pairs(&mut cmd, &pairs);
    Ok(cmd)
}

/// System credentials, then global ones. Git applies the later value for a single key and keeps every
/// `credential.helper`. `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_GLOBAL`, when set, name the files. Otherwise git reads
/// its usual ones. Nothing from a repository config is copied: only the system and global files are read.
fn kept_credential_pairs(git_dir: Option<&Path>) -> Vec<(String, String)> {
    let system = std::env::var_os("GIT_CONFIG_SYSTEM").filter(|value| !value.is_empty());
    let global = std::env::var_os("GIT_CONFIG_GLOBAL").filter(|value| !value.is_empty());
    let mut pairs = scoped_credentials("--system", system.as_deref().map(Path::new), git_dir);
    pairs.extend(scoped_credentials(
        "--global",
        global.as_deref().map(Path::new),
        git_dir,
    ));
    pairs
}

fn scoped_credentials(
    scope: &str,
    file: Option<&Path>,
    git_dir: Option<&Path>,
) -> Vec<(String, String)> {
    let Ok(scratch) = exclusive_scratch("cg-cred") else {
        return Vec::new();
    };
    let pairs = credentials_in(&scratch, scope, file, git_dir);
    let _ = std::fs::remove_dir_all(&scratch);
    pairs
}

/// `scope` is `--system` or `--global`. `file`, when set, is the config git reads for that scope. The command runs
/// in an empty folder whose parent is the discovery ceiling. `git_dir`, when set, is passed with `--git-dir`, so an
/// `includeIf gitdir:` or `onbranch:` in the system or global file matches as it does for `git push` in that
/// repository: auth Ash keeps behind `includeIf` reaches the read. Only that scope's files are read, never the
/// repository's own config. `--includes` is required: without it, `git config --system` and `--global` do not open
/// included files, so a system file that starts with an include would lose that helper and keep only its own.
/// A missing file, no match, or any other failure is no credentials.
fn credentials_in(
    scratch: &Path,
    scope: &str,
    file: Option<&Path>,
    git_dir: Option<&Path>,
) -> Vec<(String, String)> {
    let empty = scratch.join("empty");
    if std::fs::create_dir_all(&empty).is_err() {
        return Vec::new();
    }
    let ceiling = match scratch.parent() {
        Some(parent) => crate::fs::canonical(parent).unwrap_or_else(|_| parent.to_path_buf()),
        None => scratch.to_path_buf(),
    };
    let var = match scope {
        "--system" => "GIT_CONFIG_SYSTEM",
        "--global" => "GIT_CONFIG_GLOBAL",
        _ => return Vec::new(),
    };
    let mut cmd = crate::fs::git_cmd();
    strip_repo_env(&mut cmd, true);
    cmd.current_dir(&empty)
        .env("GIT_CEILING_DIRECTORIES", &ceiling)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_CONFIG_NOSYSTEM");
    if let Some(path) = file {
        cmd.env(var, path);
    }
    apply_config_pairs(&mut cmd, &[]);
    if let Some(git_dir) = git_dir {
        cmd.arg("--git-dir").arg(git_dir);
    }
    cmd.args([
        "--no-pager",
        "-c",
        "color.ui=never",
        "config",
        "--null",
        scope,
        "--includes",
        "--show-origin",
        "--get-regexp",
        r"^credential\.",
    ]);
    let out = match read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES) {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };
    if colour_wrapped(&out) {
        return Vec::new();
    }
    parse_credential_lines(&String::from_utf8_lossy(&out))
}

/// Credential pairs from `git config --show-origin --get-regexp`. The command passes `--null`, so a value
/// keeps its spaces and newlines: `origin NUL key LF value NUL`. Text with no NUL is the older line form
/// (`file:<path><TAB>key value`), which the unit test still feeds in. Only `credential.*` keys from a file
/// origin are kept, so a command-line pair or a `url.*` line cannot come back through.
fn parse_credential_lines(text: &str) -> Vec<(String, String)> {
    if text.contains('\0') {
        return parse_credential_null(text);
    }
    let mut pairs = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let Some((origin, rest)) = line.split_once('\t') else {
            continue;
        };
        if !origin.starts_with("file:") {
            continue;
        }
        let (key, value) = match rest.split_once(' ') {
            Some((key, value)) => (key, value),
            None => (rest, ""),
        };
        if key.starts_with("credential.") && !key.is_empty() {
            pairs.push((key.to_string(), value.to_string()));
        }
    }
    pairs
}

fn parse_credential_null(text: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut parts = text.split('\0');
    while let Some(origin) = parts.next() {
        let Some(body) = parts.next() else {
            break;
        };
        if !origin.starts_with("file:") {
            continue;
        }
        let Some((key, value)) = body.split_once('\n') else {
            continue;
        };
        let key = key.trim_end_matches('\r');
        if key.starts_with("credential.") && !key.is_empty() {
            pairs.push((key.to_string(), value.to_string()));
        }
    }
    pairs
}

/// Puts `pairs` on the command, then `safe.bareRepository=explicit`. `strip_repo_env` has already dropped the pair
/// `git_cmd` added, so this is the only copy, and it stays last.
fn apply_config_pairs(cmd: &mut Command, pairs: &[(String, String)]) {
    let bare = pairs.len();
    cmd.env("GIT_CONFIG_COUNT", (bare + 1).to_string());
    for (index, (key, value)) in pairs.iter().enumerate() {
        cmd.env(format!("GIT_CONFIG_KEY_{index}"), key);
        cmd.env(format!("GIT_CONFIG_VALUE_{index}"), value);
    }
    cmd.env(format!("GIT_CONFIG_KEY_{bare}"), "safe.bareRepository");
    cmd.env(format!("GIT_CONFIG_VALUE_{bare}"), "explicit");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn a_repository_that_sets_its_own_ssh_command_or_receive_pack_is_refused() {
        let dir = std::env::temp_dir().join(format!("cg-own-push-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = crate::fs::canonical(&dir).unwrap();
        plain_git(&dir, &["init", "-q"]);
        plain_git(
            &dir,
            &["remote", "add", "origin", "git@example.test:o/r.git"],
        );
        let repo = open_repo(&dir).unwrap();
        assert!(refuse_own_push_command(&repo, "origin").is_ok());
        plain_git(
            &dir,
            &[
                "config",
                "core.sshCommand",
                "ssh -o HostName=elsewhere.test",
            ],
        );
        let refused = refuse_own_push_command(&repo, "origin").unwrap_err();
        assert!(refused.contains("core.sshCommand"), "{refused}");
        plain_git(&dir, &["config", "--unset", "core.sshCommand"]);
        plain_git(
            &dir,
            &[
                "config",
                "remote.origin.receivepack",
                "git-receive-pack '/elsewhere' #",
            ],
        );
        let refused = refuse_own_push_command(&repo, "origin").unwrap_err();
        assert!(refused.contains("receivepack"), "{refused}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn guard_arguments_never_set_a_numeric_abbrev() {
        let repo = Repo {
            git_dir: PathBuf::from("git"),
            work_tree: PathBuf::from("work"),
        };
        let cmd = command(&repo);
        let args: Vec<String> = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for arg in &args {
            assert!(
                !numeric_abbrev(arg),
                "a numeric abbrev is out of range on git 2.43: {arg}"
            );
        }
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "core.commitGraph=false"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "pack.useBitmaps=false"));
        for arg in ["--no-abbrev", "--full-index", "--no-textconv"] {
            assert!(!numeric_abbrev(arg), "{arg}");
        }
        assert!(numeric_abbrev("core.abbrev=64"));
        assert!(numeric_abbrev("--abbrev=40"));
        assert!(!numeric_abbrev("--no-abbrev"));
        assert!(!numeric_abbrev("core.abbrev=no"));
    }

    #[test]
    fn windows_env_names_fold_before_they_match() {
        assert!(classify_env("Git_Dir", true).location);
        assert!(!classify_env("Git_Dir", false).location);
        assert!(classify_env("git_config_count", true).injected);
        assert!(!classify_env("git_config_count", false).injected);
        assert!(classify_env("Git_Config_Global", true).config);
        assert!(!classify_env("PATH", true).config);
        assert!(classify_env("GIT_SHALLOW_FILE", false).location);
        assert!(classify_env("GIT_GRAFT_FILE", false).location);
        assert!(classify_env("GIT_REDIRECT_STDOUT", false).location);
        assert!(classify_env("git_shallow_file", true).location);
        assert!(!classify_env("git_shallow_file", false).location);
    }

    #[test]
    fn the_ls_remote_scratch_folder_is_unpredictable_and_exclusive() {
        let path = exclusive_scratch("cg-ls").unwrap();
        let id = path.file_name().unwrap().to_string_lossy();
        let id = id.rsplit('-').next().unwrap();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        let err = std::fs::create_dir(&path).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        std::fs::remove_dir_all(&path).unwrap();
    }

    #[test]
    fn credential_lines_keep_file_helpers_and_drop_other_origins() {
        let text = "\
file:/etc/gitconfig\tcredential.helper osxkeychain\n\
file:/etc/gitconfig\tcredential.helper !'/tmp/helper.sh'\n\
command line:\tcredential.helper planted\n\
file:/etc/gitconfig\turl.http://example.test/.insteadof http://decoy/\n\
file:/etc/gitconfig\tprotocol.version 0\n\
";
        let pairs = parse_credential_lines(text);
        let helpers: Vec<&str> = pairs
            .iter()
            .filter(|(key, _)| key == "credential.helper")
            .map(|(_, value)| value.as_str())
            .collect();
        assert_eq!(helpers, ["osxkeychain", "!'/tmp/helper.sh'"]);
        assert!(pairs.iter().all(|(key, _)| key.starts_with("credential.")));
    }

    /// A helper value with a space, and a newline inside it. The line printer splits that value in
    /// two, so the space-bearing helper comes back short. `--null` keeps the whole value.
    #[test]
    fn a_credential_value_with_a_space_is_kept_whole() {
        let dir = exclusive_scratch("cg-space").unwrap();
        let system = dir.join("system.gitconfig");
        std::fs::write(
            &system,
            "[credential]\n\thelper = \"store --file /tmp/my creds\\nmore\"\n\tusername = ada lovelace\n",
        )
        .unwrap();
        let pairs = credentials_in(&dir, "--system", Some(&system), None);
        let _ = std::fs::remove_dir_all(&dir);
        let helper = pairs
            .iter()
            .find(|(key, _)| key == "credential.helper")
            .map(|(_, value)| value.as_str());
        let username = pairs
            .iter()
            .find(|(key, _)| key == "credential.username")
            .map(|(_, value)| value.as_str());
        assert_eq!(
            helper,
            Some("store --file /tmp/my creds\nmore"),
            "pairs {pairs:?}"
        );
        assert_eq!(username, Some("ada lovelace"), "pairs {pairs:?}");
    }

    #[test]
    fn a_system_file_keeps_its_own_helper_when_it_starts_with_an_include() {
        let dir = exclusive_scratch("cg-include").unwrap();
        let included = dir.join("included.gitconfig");
        std::fs::write(
            &included,
            "[credential]\n\thelper = included-helper\n[url \"http://127.0.0.1:1/\"]\n\tinsteadOf = https://\n",
        )
        .unwrap();
        let conditional = dir.join("conditional.gitconfig");
        std::fs::write(
            &conditional,
            "[credential]\n\thelper = conditional-helper\n",
        )
        .unwrap();
        let system = dir.join("system.gitconfig");
        let included_path = included.to_string_lossy().replace('\\', "/");
        let conditional_path = conditional.to_string_lossy().replace('\\', "/");
        std::fs::write(
            &system,
            format!(
                "[include]\n\tpath = {included_path}\n\
                 [includeIf \"gitdir:/no/such/cg-includeif/**\"]\n\tpath = {conditional_path}\n\
                 [credential]\n\thelper = own-helper\n\
                 [url \"http://127.0.0.1:1/decoy/\"]\n\tinsteadOf = http://127.0.0.1:\n\
                 [protocol]\n\tversion = 0\n"
            ),
        )
        .unwrap();
        let pairs = credentials_in(&dir, "--system", Some(&system), None);
        let _ = std::fs::remove_dir_all(&dir);
        let helpers: Vec<&str> = pairs
            .iter()
            .filter(|(key, _)| key == "credential.helper")
            .map(|(_, value)| value.as_str())
            .collect();
        assert!(
            helpers.contains(&"included-helper"),
            "the included helper was dropped: {helpers:?}"
        );
        assert!(
            helpers.contains(&"own-helper"),
            "the system file's own helper was dropped: {helpers:?}"
        );
        assert!(
            !helpers.contains(&"conditional-helper"),
            "an includeIf that does not match was copied: {helpers:?}"
        );
        assert!(pairs.iter().all(|(key, value)| {
            key.starts_with("credential.") && !value.contains("insteadOf") && value != "0"
        }));
    }

    #[test]
    fn repeated_credential_helpers_round_trip_through_the_environment() {
        let pairs = vec![
            ("credential.helper".to_string(), "alpha".to_string()),
            ("credential.helper".to_string(), "beta".to_string()),
        ];
        let mut cmd = crate::fs::git_cmd();
        strip_repo_env(&mut cmd, false);
        cmd.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null");
        apply_config_pairs(&mut cmd, &pairs);
        cmd.args(["config", "--get-all", "credential.helper"]);
        let out = read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES).unwrap();
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("alpha"), "{text}");
        assert!(text.contains("beta"), "{text}");
    }

    #[test]
    fn ls_remote_does_not_read_a_config_file_in_the_scratch_folder() {
        let scratch = exclusive_scratch("cg-ls").unwrap();
        let planted = scratch.join("global.gitconfig");
        std::fs::write(
            &planted,
            "[url \"http://127.0.0.1:1/\"]\n\tinsteadOf = https://\n",
        )
        .unwrap();
        std::fs::write(scratch.join("blank-system.gitconfig"), "planted").unwrap();
        let cmd = ls_remote_cmd(&scratch, None).unwrap();
        let mut global = None;
        let mut system = None;
        let mut count = None;
        let mut keys = Vec::new();
        for (name, value) in cmd.get_envs() {
            let name = name.to_string_lossy();
            let value = value.map(|item| item.to_string_lossy().into_owned());
            if name == "GIT_CONFIG_GLOBAL" {
                global = value.clone();
            } else if name == "GIT_CONFIG_SYSTEM" {
                system = value.clone();
            } else if name == "GIT_CONFIG_COUNT" {
                count = value.clone();
            } else if name.starts_with("GIT_CONFIG_KEY_") {
                // A removed inherited key (the test runner's own `GIT_CONFIG_KEY_<n>`) has no value.
                if let Some(key) = value.clone() {
                    keys.push(key);
                }
            }
            if let Some(value) = value.as_deref() {
                assert!(
                    !value.contains("global.gitconfig") && !value.contains("blank-system"),
                    "the scratch config is on the command"
                );
            }
        }
        let _ = std::fs::remove_dir_all(&scratch);
        assert_eq!(global.as_deref(), Some("/dev/null"));
        assert_eq!(system.as_deref(), Some("/dev/null"));
        assert!(
            count.is_some(),
            "credential keys were not passed in the environment"
        );
        assert!(
            keys.iter().any(|key| key == "safe.bareRepository"),
            "safe.bareRepository was dropped"
        );
        assert!(keys
            .iter()
            .all(|key| key.starts_with("credential.") || key == "safe.bareRepository"));
    }
}
