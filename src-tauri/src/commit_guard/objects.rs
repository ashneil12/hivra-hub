//! How the guard reads a repository.
//!
//! The git dir is the `.git` entry of the folder the check was given (a directory, or a `gitdir:` file). It is not
//! `rev-parse --show-toplevel`, which follows `core.worktree` and would read a different checkout from the one `git
//! push` sends. Every later read passes that git dir.
//!
//! File content is the blob, not a diff. A line is new when it occurs more times in the commit's blob than in every
//! parent's blob. Attributes, textconv, colour and binary detection never see it.
//!
//! The one network read (`ls-remote`) runs in an empty folder, with no `-C` and no `GIT_DIR`, so the repository's url
//! rewrites and `core.sshCommand` cannot choose what it sees. That one call keeps the global and system config so a
//! credential helper still runs. A commit is treated as already on the remote only when every push destination
//! advertises it.

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

const UNREADABLE: &str = "The secret check could not read this repository, so nothing was sent.";
const UNREADABLE_CHANGE: &str = "The secret check could not read this change, so nothing was sent.";

pub(super) fn open_repo(start: &Path) -> Result<Repo, String> {
    let mut dir = crate::fs::canonical(start).unwrap_or_else(|_| start.to_path_buf());
    if !dir.is_dir() {
        dir.pop();
    }
    loop {
        let dot = dir.join(".git");
        if dot.is_dir() {
            let git_dir = crate::fs::canonical(&dot).map_err(|error| error.to_string())?;
            return Ok(Repo {
                git_dir,
                work_tree: dir,
            });
        }
        if dot.is_file() {
            let git_dir = gitdir_file(&dot, &dir)?;
            return Ok(Repo {
                git_dir,
                work_tree: dir,
            });
        }
        if !dir.pop() {
            break;
        }
    }
    Err(UNREADABLE.into())
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

fn gitdir_file(dot: &Path, dir: &Path) -> Result<PathBuf, String> {
    let text = std::fs::read_to_string(dot).map_err(|error| error.to_string())?;
    let rest = text
        .trim()
        .strip_prefix("gitdir:")
        .ok_or_else(|| UNREADABLE.to_string())?
        .trim();
    let raw = PathBuf::from(rest);
    let abs = if raw.is_absolute() {
        raw
    } else {
        dir.join(raw)
    };
    crate::fs::canonical(&abs).map_err(|error| error.to_string())
}

fn work_tree_for(git_dir: &Path, hint: &Path) -> PathBuf {
    let pointer = git_dir.join("gitdir");
    if let Ok(text) = std::fs::read_to_string(&pointer) {
        let raw = PathBuf::from(text.trim());
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

fn strip_repo_env(cmd: &mut Command, keep_global_config: bool) {
    for (name, _) in std::env::vars_os() {
        let Some(name) = name.to_str() else {
            continue;
        };
        let location = name.starts_with("GIT_DIR")
            || name.starts_with("GIT_WORK_TREE")
            || name.starts_with("GIT_INDEX")
            || name.starts_with("GIT_OBJECT")
            || name.starts_with("GIT_ALTERNATE")
            || name.starts_with("GIT_COMMON")
            || name.starts_with("GIT_NAMESPACE")
            || name.starts_with("GIT_REPLACE");
        let injected = name == "GIT_CONFIG_PARAMETERS"
            || name == "GIT_CONFIG_COUNT"
            || name.starts_with("GIT_CONFIG_KEY_")
            || name.starts_with("GIT_CONFIG_VALUE_");
        let config = name.starts_with("GIT_CONFIG");
        if location || injected || (config && !keep_global_config) {
            cmd.env_remove(name);
        }
    }
}

/// A guard read. Repository config is still read; the overrides below are the ones that would change the bytes.
pub(super) fn command(repo: &Repo) -> Command {
    let mut cmd = crate::fs::git_cmd();
    strip_repo_env(&mut cmd, false);
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
        .args(["-c", "core.abbrev=64"])
        .args(["-c", "core.fsmonitor=false"])
        .args(["-c", "diff.external="])
        .args(["-c", "filter.lfs.required=false"])
        .args(["-c", "filter.lfs.process="])
        .args(["-c", "filter.lfs.clean="])
        .args(["-c", "filter.lfs.smudge="])
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    cmd
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
    let mut per_parent: Vec<HashMap<String, Option<String>>> = Vec::new();
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
            let old = if super::is_zero_sha(&change.old_sha) {
                None
            } else {
                Some(change.old_sha)
            };
            map.insert(change.path, old);
        }
        per_parent.push(map);
    }
    let mut wanted: Vec<String> = Vec::new();
    for (path, (new_sha, _)) in &new_of {
        if super::is_zero_sha(new_sha) {
            continue;
        }
        let mut added = false;
        let mut same = false;
        for map in &per_parent {
            match map.get(path) {
                None => same = true,
                Some(None) => added = true,
                Some(Some(old)) if old == new_sha => same = true,
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
            if let Some(Some(old)) = map.get(path) {
                if old != new_sha {
                    wanted.push(old.clone());
                }
            }
        }
    }
    let blobs = cat_blobs(repo, &wanted)?;
    for (path, (new_sha, _)) in &new_of {
        if super::is_zero_sha(new_sha) {
            continue;
        }
        let mut same = false;
        let mut parent_blobs: Vec<Vec<u8>> = Vec::new();
        for map in &per_parent {
            match map.get(path) {
                None => same = true,
                Some(Some(old)) if old == new_sha => same = true,
                Some(None) => parent_blobs.push(Vec::new()),
                Some(Some(old)) => parent_blobs.push(blobs.get(old).cloned().unwrap_or_default()),
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
    let text = String::from_utf8_lossy(&bytes);
    let mut parents = Vec::new();
    let mut message = String::new();
    let mut header = true;
    for line in text.split_inclusive('\n') {
        if header {
            if line == "\n" {
                header = false;
                continue;
            }
            if let Some(parent) = line.strip_prefix("parent ") {
                parents.push(parent.trim().to_string());
            }
            continue;
        }
        message.push_str(line);
    }
    if message_is_coloured(&message) {
        return Err(COLOUR_REFUSED.into());
    }
    Ok((parents, message))
}

fn message_is_coloured(message: &str) -> bool {
    message
        .split('\n')
        .any(|line| line.as_bytes().first() == Some(&0x1b))
}

struct Change {
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
        "--abbrev=64",
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
        let _old_mode = parts.next().unwrap_or("").trim_start_matches(':');
        let new_mode = parts.next().unwrap_or("").to_string();
        let old_sha = parts.next().unwrap_or("").to_string();
        let new_sha = parts.next().unwrap_or("").to_string();
        let status = parts.next().unwrap_or("");
        if status.is_empty() || path.is_empty() || old_sha.is_empty() || new_sha.is_empty() {
            return Err(UNREADABLE_CHANGE.into());
        }
        out.push(Change {
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
        let size: usize = parts
            .next()
            .unwrap_or("0")
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
                let body = git_text(repo, &["cat-file", "tag", &current])?;
                if message_is_coloured(&body) {
                    return Err(COLOUR_REFUSED.into());
                }
                let next = tag_target(&body)?;
                messages.push(body);
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

fn tag_target(body: &str) -> Result<String, String> {
    body.lines()
        .find_map(|line| line.strip_prefix("object "))
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
        .ok_or_else(|| UNREADABLE_CHANGE.to_string())
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
        "--abbrev=64",
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
        if super::is_zero_sha(&change.old_sha)
            && !scan.added.iter().any(|have| have == &change.path)
        {
            scan.added.push(change.path.clone());
        }
        wanted.push(change.new_sha.clone());
        if !super::is_zero_sha(&change.old_sha) && change.old_sha != change.new_sha {
            wanted.push(change.old_sha.clone());
        }
    }
    let blobs = cat_blobs(repo, &wanted)?;
    for change in &changes {
        if change.new_mode == "160000" || super::is_zero_sha(&change.new_sha) {
            continue;
        }
        if change.old_sha == change.new_sha {
            continue;
        }
        let blob = blobs
            .get(&change.new_sha)
            .ok_or_else(|| UNREADABLE_CHANGE.to_string())?;
        let parent = if super::is_zero_sha(&change.old_sha) {
            Vec::new()
        } else {
            blobs.get(&change.old_sha).cloned().unwrap_or_default()
        };
        scan.lines
            .extend(novel_hits(blob, &[parent.as_slice()], &change.path, ""));
    }
    Ok(scan)
}

fn has_url_rewrite(repo: &Repo) -> Result<bool, String> {
    let output = command(repo)
        .args(["config", "--local", "--get-regexp", r"^url\."])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(!output.stdout.is_empty())
}

fn push_unique(urls: &mut Vec<String>, url: String) {
    let url = url.trim().to_string();
    if !url.is_empty() && !urls.iter().any(|have| have == &url) {
        urls.push(url);
    }
}

/// Every URL `git push` uses for `remote`. `get-url --push` already applies `pushInsteadOf`, or `insteadOf` when no
/// push rewrite matches, which is the same URL the push itself contacts. The configured string is not added as well:
/// a checkout may rewrite a public name onto a local stand-in, and asking that public name would refuse a push that
/// never goes there. The caller then reads each of these URLs from outside the repository, so a second `insteadOf`
/// cannot point the check at a decoy.
pub(super) fn push_destinations(repo: &Repo, remote: &str) -> Result<Vec<String>, String> {
    let output = command(repo)
        .args(["remote", "get-url", "--push", "--all", remote])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        if has_url_rewrite(repo)? {
            return Err(
                "The secret check could not read where this push goes, so nothing was sent.".into(),
            );
        }
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if message.is_empty() {
            return Err(format!("the remote {remote} has no push URL"));
        }
        return Err(message);
    }
    let mut urls = Vec::new();
    for url in String::from_utf8_lossy(&output.stdout).lines() {
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

/// Tips a remote advertises, read from outside the repository. Global and system config are kept.
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
    let mut cmd = crate::fs::git_cmd();
    strip_repo_env(&mut cmd, true);
    cmd.current_dir(scratch)
        .env("GIT_CEILING_DIRECTORIES", scratch)
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
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
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
    if over.load(Ordering::Relaxed) || out.len() > max_bytes {
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
