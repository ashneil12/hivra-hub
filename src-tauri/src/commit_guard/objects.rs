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
//! current folder would still use a repository above it. The push URL is resolved with the same global config `git
//! push` reads. `ls-remote` then keeps the credential helper and drops `url.*`, so a second rewrite cannot point the
//! base at a decoy. A commit is treated as already on the remote only when every push destination advertises it.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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
            || name.starts_with("GIT_REPLACE"),
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
}

impl Scan {
    fn empty() -> Self {
        Self {
            added: Vec::new(),
            files: Vec::new(),
            lines: Vec::new(),
            messages: Vec::new(),
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
        .chunks_exact(2)
        .map(|pair| {
            if big {
                u16::from_be_bytes([pair[0], pair[1]])
            } else {
                u16::from_le_bytes([pair[0], pair[1]])
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
    let mut scan = Scan::empty();
    let mut wanted = Vec::new();
    for change in &changes {
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
    for change in &changes {
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

/// The patch `land` applies. Built through the guard's git command, with textconv off, so a diff driver cannot
/// write bytes the blob scan never read.
pub(super) fn index_patch(repo: &Repo, index: &Path, base: &str) -> Result<Vec<u8>, String> {
    let mut cmd = command(repo);
    cmd.env("GIT_INDEX_FILE", index).args([
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-abbrev",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        base,
    ]);
    read_capped(cmd, None, CHECK_TIMEOUT, MAX_CHECKED_BYTES)
}

/// The staged blob for each path, or `None` when the index does not have that path (a deletion). Not the work tree.
pub(super) fn index_blobs(
    repo: &Repo,
    index: &Path,
    paths: &[String],
) -> Result<Vec<StagedBlob>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = String::new();
    for path in paths {
        if path.contains('\n') || path.contains('\0') {
            return Err(UNREADABLE_CHANGE.into());
        }
        input.push(':');
        input.push_str(path);
        input.push('\n');
    }
    let mut cmd = command(repo);
    cmd.env("GIT_INDEX_FILE", index)
        .args(["cat-file", "--batch"]);
    let bytes = read_capped(
        cmd,
        Some(input.as_bytes()),
        CHECK_TIMEOUT,
        MAX_CHECKED_BYTES,
    )?;
    let mut out = Vec::new();
    let mut index = 0;
    for path in paths {
        if index >= bytes.len() {
            return Err(UNREADABLE_CHANGE.into());
        }
        let Some(relative) = bytes[index..].iter().position(|byte| *byte == b'\n') else {
            return Err(UNREADABLE_CHANGE.into());
        };
        let header = std::str::from_utf8(&bytes[index..index + relative])
            .map_err(|_| UNREADABLE_CHANGE.to_string())?;
        index += relative + 1;
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
        if index + size > bytes.len() {
            return Err(UNREADABLE_CHANGE.into());
        }
        let blob = bytes[index..index + size].to_vec();
        index += size;
        if index < bytes.len() && bytes[index] == b'\n' {
            index += 1;
        }
        out.push((path.clone(), Some(blob)));
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

fn push_unique(urls: &mut Vec<String>, url: String) {
    let url = url.trim().to_string();
    if !url.is_empty() && !urls.iter().any(|have| have == &url) {
        urls.push(url);
    }
}

/// Every URL `git push` uses for `remote`. `get-url --push` already applies `pushInsteadOf`, or `insteadOf` when no
/// push rewrite matches, which is the same URL the push itself contacts. This call keeps the global config, because
/// the push does too. The configured string is not added as well: a checkout may rewrite a public name onto a local
/// stand-in, and asking that public name would refuse a push that never goes there. The caller then reads each of
/// these URLs from outside the repository, with `url.*` hidden, so a second `insteadOf` cannot point the check at a
/// decoy.
pub(super) fn push_destinations(repo: &Repo, remote: &str) -> Result<Vec<String>, String> {
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
        push_unique(&mut urls, url.to_string());
    }
    if urls.is_empty() {
        return Err(format!("the remote {remote} has no push URL"));
    }
    Ok(urls)
}

pub(super) fn destinations_for(repo: &Repo, target: &str) -> Result<Vec<String>, String> {
    if let Ok(urls) = push_destinations(repo, target) {
        if !urls.is_empty() {
            return Ok(urls);
        }
    }
    if target.contains("://") || target.starts_with('/') || target.starts_with('.') {
        return Ok(vec![target.to_string()]);
    }
    Err(format!("the remote {target} has no push URL"))
}

/// Tips a remote advertises, read from outside the repository. The credential helper is kept. `url.*` is not.
pub(super) fn advertised_shas(url: &str) -> Result<Vec<String>, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let scratch = std::env::temp_dir().join(format!("cg-ls-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&scratch).map_err(|error| error.to_string())?;
    let result = advertised_in(&scratch, url);
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

fn advertised_in(scratch: &Path, url: &str) -> Result<Vec<String>, String> {
    let empty = scratch.join("empty");
    std::fs::create_dir_all(&empty).map_err(|error| error.to_string())?;
    let xdg = scratch.join("xdg");
    std::fs::create_dir_all(&xdg).map_err(|error| error.to_string())?;
    // Git ignores a ceiling equal to the current directory. The ceiling has to be a proper ancestor, and the
    // command has to run somewhere that ancestor actually contains.
    let ceiling = match scratch.parent() {
        Some(parent) => crate::fs::canonical(parent).unwrap_or_else(|_| parent.to_path_buf()),
        None => scratch.to_path_buf(),
    };
    let global = sanitized_global(scratch)?;
    let mut cmd = crate::fs::git_cmd();
    strip_repo_env(&mut cmd, true);
    cmd.current_dir(&empty)
        .env("GIT_CEILING_DIRECTORIES", &ceiling)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", &global)
        .env("XDG_CONFIG_HOME", &xdg)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["--no-pager", "-c", "color.ui=never", "ls-remote", url]);
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

/// A copy of the global git config with `url.*` and includes removed, so `ls-remote` cannot be steered onto a decoy
/// and an include cannot put a rewrite back. The credential helper stays. The real config file is only read.
fn sanitized_global(scratch: &Path) -> Result<PathBuf, String> {
    let mut combined = String::new();
    for path in global_config_files() {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        combined.push_str(&text);
        if !combined.ends_with('\n') {
            combined.push('\n');
        }
    }
    let file = scratch.join("global.gitconfig");
    std::fs::write(&file, strip_url_config(&combined)).map_err(|error| error.to_string())?;
    Ok(file)
}

fn global_config_files() -> Vec<PathBuf> {
    if let Some(path) = std::env::var_os("GIT_CONFIG_GLOBAL") {
        if !path.is_empty() {
            return vec![PathBuf::from(path)];
        }
    }
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    let xdg = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    vec![home.join(".gitconfig"), xdg.join("git").join("config")]
}

fn strip_url_config(text: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim().trim_end_matches('\r');
        if trimmed.starts_with('[') && trimmed.contains(']') {
            skipping = url_or_include_section(trimmed);
        }
        if skipping {
            continue;
        }
        let key = trimmed
            .split(['=', ' ', '\t'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if key.starts_with("url.") || key == "include.path" || key.starts_with("includeif.") {
            continue;
        }
        out.push_str(line);
    }
    out
}

fn url_or_include_section(header: &str) -> bool {
    let inner = header.trim().trim_start_matches('[').trim_end_matches(']');
    let name = inner
        .split(|c: char| c.is_whitespace() || c == '"')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    name == "url" || name == "include" || name.starts_with("includeif")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_arguments_never_set_a_numeric_abbrev() {
        let repo = Repo {
            git_dir: PathBuf::from("git"),
            work_tree: PathBuf::from("work"),
        };
        let cmd = command(&repo);
        for arg in cmd.get_args() {
            let arg = arg.to_string_lossy();
            assert!(
                !numeric_abbrev(&arg),
                "a numeric abbrev is out of range on git 2.43: {arg}"
            );
        }
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
    }

    #[test]
    fn url_sections_are_dropped_and_the_credential_helper_stays() {
        let text = "\
[credential]\n\thelper = !'/tmp/helper.sh'\n\
[url \"file:///decoy\"]\n\tinsteadOf = https://example.test/\n\
[include]\n\tpath = /tmp/more\n\
";
        let kept = strip_url_config(text);
        assert!(kept.contains("helper"));
        assert!(!kept.contains("insteadOf"));
        assert!(!kept.contains("include"));
    }
}
