//! The commit guard: keeps files an agent writes for itself, and secrets, out of what Hivra stages, commits, pushes,
//! opens as a pull request or lands. The agent folders come from the shared list
//! (`src/shared/security/agentConfigPaths.json`, read through the floor's loader), and the secret patterns from
//! `src/features/portable/model/secretPatterns.json` (through `portable::scrubber`).
//!
//! - Staging leaves out an untracked agent file, so `git add -A` never takes it. A file the repo already tracks is
//!   staged as usual.
//! - Selecting or staging such a file by hand refuses the commit with one plain line.
//! - Before a push, a pull request, a land or a checked delivery, the commits being sent are checked: merge commits
//!   included, binary-marked files read as text, an agent file refused, and each added line scanned for a secret
//!   by its token shape or a long assigned value. A check that is too large or too slow refuses the step.
//! - Nothing here edits an ignore file. A refusal names the choices in words and leaves the person to pick.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::delivery::protected::{folded_segments, shared_list};

const APPROVALS_FILE: &str = "settings.local.json";
const TRANSCRIPT_EXT: &str = ".jsonl";
const APPROVALS: &str = "an agent's local approvals";
const TRANSCRIPT: &str = "an agent's saved transcript";
/// Agent folders the shared list's own `dirs` do not name: the repo's `.hivra` folder (the floor's `DIRECTORIES`).
const AGENT_FOLDERS: &[&str] = &[".hivra"];
/// The most patch text one check reads. Above it the step is refused rather than checked in part.
const MAX_CHECKED_BYTES: usize = 32 * 1024 * 1024;
/// How long one check's git may run before the step is refused.
const CHECK_TIMEOUT: Duration = Duration::from_secs(120);

const TOO_LARGE: &str = "This change is too large for the secret check, so nothing was sent. Split it into smaller pushes, or ask Ash to check it.";
const TIMED_OUT: &str = "The secret check did not finish in time, so nothing was sent. Try again, or ask Ash to check it.";

/// What kind of agent file a repo path is, or `None`. The folder must be one the shared list names (or `.hivra`).
/// A list that does not load is an error: the guard refuses rather than letting an agent file through.
fn agent_file_kind(path: &str) -> Result<Option<&'static str>, String> {
    let list = shared_list()?;
    let Some(segments) = folded_segments(path) else {
        return Ok(None);
    };
    let Some((name, folders)) = segments.split_last() else {
        return Ok(None);
    };
    let agent_folder = folders.iter().any(|folder| {
        list.folder_names().contains(folder) || AGENT_FOLDERS.contains(&folder.as_str())
    });
    if !agent_folder {
        return Ok(None);
    }
    if name == APPROVALS_FILE && list.file_names().iter().any(|file| file == APPROVALS_FILE) {
        return Ok(Some(APPROVALS));
    }
    if name.ends_with(TRANSCRIPT_EXT) {
        return Ok(Some(TRANSCRIPT));
    }
    Ok(None)
}

const RECOVERY: &str = "To go on, either untrack it, add it to this project's ignore file (after you say yes), or say it is a test value. Hivra does not edit any ignore file itself.";

fn left_out(path: &str, kind: &str) -> String {
    format!("Left out {path}: {kind}, not for GitHub. {RECOVERY}")
}

fn refused_to_push(path: &str, kind: &str) -> String {
    format!("Refused to push {path}: it is {kind}, not for GitHub. {RECOVERY}")
}

fn refused_to_land(path: &str, kind: &str) -> String {
    format!("Refused to land {path}: it is {kind}, and this project does not track it. {RECOVERY}")
}

fn secret_refusal(file: &str, line: usize) -> String {
    format!(
        "Possible secret in {file}:{line}. The value is not shown. To go on, either remove it from the commit, add the file to this project's ignore file (after you say yes), or say it is a test value. Hivra does not edit any ignore file itself."
    )
}

/// Small git answers (a name, a config value). Output that is not UTF-8 is read lossily, never an error.
fn git_out(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::fs::git_cmd()
        .arg("--no-pager")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// A check's git output, bounded: the run is killed after `limit`, and output past `max_bytes` refuses.
pub(crate) fn checked_output_within(
    root: &Path,
    args: &[&str],
    limit: Duration,
    max_bytes: usize,
) -> Result<String, String> {
    let mut child = crate::fs::git_cmd()
        .arg("--no-pager")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("git output was not piped")?;
    let mut stderr = child.stderr.take().ok_or("git errors were not piped")?;
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(TIMED_OUT.into());
        }
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(String::from_utf8_lossy(&err).trim().to_string());
    }
    if out.len() > max_bytes {
        return Err(TOO_LARGE.into());
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn git_checked_output(root: &Path, args: &[&str]) -> Result<String, String> {
    checked_output_within(root, args, CHECK_TIMEOUT, MAX_CHECKED_BYTES)
}

/// Whether HEAD already has the path. A repo with no commits has nothing tracked.
fn tracked_at_head(root: &Path, path: &str) -> bool {
    git_out(root, &["cat-file", "-e", &format!("HEAD:{path}")]).is_ok()
}

/// Agent files git does not track yet: the ones staging must leave out.
fn untracked_agent_paths(root: &Path) -> Result<Vec<String>, String> {
    let listed = git_out(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut found = Vec::new();
    for path in listed.split('\0').filter(|path| !path.is_empty()) {
        if agent_file_kind(path)?.is_some() {
            found.push(path.to_string());
        }
    }
    Ok(found)
}

/// The arguments of `git add -A` that leave out every untracked agent file.
pub fn add_all_pathspec(root: &Path) -> Result<Vec<String>, String> {
    let mut args = vec![
        "add".to_string(),
        "-A".to_string(),
        "--".to_string(),
        ".".to_string(),
    ];
    for path in untracked_agent_paths(root)? {
        args.push(format!(":(exclude,literal){path}"));
    }
    Ok(args)
}

/// Stages every change except untracked agent files.
pub fn stage_all(root: &Path) -> Result<(), String> {
    let args = add_all_pathspec(root)?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    crate::fs::git_checked(root, &refs)
}

/// Refuses a selection that names an untracked agent file.
pub fn refuse_selected(root: &Path, paths: &[String]) -> Result<(), String> {
    for path in paths {
        if let Some(kind) = agent_file_kind(path)? {
            if !tracked_at_head(root, path) {
                return Err(left_out(path, kind));
            }
        }
    }
    Ok(())
}

/// Refuses a commit whose index holds a new agent file, however it got there.
pub fn refuse_staged_agent_files(root: &Path) -> Result<(), String> {
    let names = git_out(
        root,
        &[
            "diff",
            "--cached",
            "--name-only",
            "--diff-filter=A",
            "--no-renames",
            "-z",
        ],
    )?;
    for path in names.split('\0').filter(|path| !path.is_empty()) {
        if let Some(kind) = agent_file_kind(path)? {
            return Err(left_out(path, kind));
        }
    }
    Ok(())
}

/// Refuses a land whose changed files name an agent file the project does not track (a worker's own approvals file,
/// committed or staged by the worker itself, never reaches the project).
pub fn refuse_land_names(project: &Path, names: &[String]) -> Result<(), String> {
    for path in names {
        if let Some(kind) = agent_file_kind(path)? {
            if !tracked_at_head(project, path) {
                return Err(refused_to_land(path, kind));
            }
        }
    }
    Ok(())
}

/// One added line of a patch: the file, its line number in the new file, and the text without its `+`.
struct Added {
    file: String,
    line: usize,
    text: String,
}

/// The first new-file line number in a hunk header's text (`-1,0 +2 @@ ...`).
fn new_start(header: &str) -> usize {
    header
        .split_whitespace()
        .find_map(|token| token.strip_prefix('+'))
        .and_then(|range| range.split(',').next())
        .and_then(|number| number.parse().ok())
        .unwrap_or(1)
}

/// The added lines of a unified diff. Only `+` lines count (never `-`, never a `+++` file header), and the `+` is
/// removed before the text is scanned, so a generic assignment on an added line is read as the line it is.
fn added_lines(patch: &str) -> Vec<Added> {
    let mut out = Vec::new();
    let mut file = String::new();
    let mut line_no = 0usize;
    let mut in_hunk = false;
    for raw in patch.lines() {
        if raw.starts_with("diff --git ") {
            in_hunk = false;
            file.clear();
            continue;
        }
        if let Some(header) = raw.strip_prefix("@@ ") {
            line_no = new_start(header);
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            if let Some(path) = raw.strip_prefix("+++ ") {
                file = path.strip_prefix("b/").unwrap_or(path).to_string();
            }
            continue;
        }
        if let Some(text) = raw.strip_prefix('+') {
            out.push(Added {
                file: file.clone(),
                line: line_no,
                text: text.to_string(),
            });
            line_no += 1;
        } else if raw.starts_with(' ') || raw.is_empty() {
            line_no += 1;
        }
    }
    out
}

/// Scans the added lines of a unified diff for secrets. The gate uses the scrubber's token-shape patterns and its
/// assigned-value pattern (a key name, then 16 or more letters and digits); it does not use the looser assignment
/// fallback that the export scan uses, which refused ordinary code (`let token = home.join("token");`). A private key
/// block spans lines, so the added lines of each file are also scanned together for one. A line a person allowed
/// (`allows`, for this repo `repo`) is not a finding.
pub fn scan_patch_with(patch: &str, allows: &[Allow], repo: &str) -> Result<(), String> {
    let scrubber = crate::portable::scrubber();
    let added = added_lines(patch);
    for line in &added {
        if !scrubber.findings(&line.text).is_empty()
            && !is_allowed(allows, repo, &line.file, &line.text)
        {
            return Err(secret_refusal(&line.file, line.line));
        }
    }
    let mut by_file: BTreeMap<&str, Vec<&Added>> = BTreeMap::new();
    for line in &added {
        by_file.entry(line.file.as_str()).or_default().push(line);
    }
    for (file, lines) in by_file {
        let block = lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if scrubber
            .findings(&block)
            .iter()
            .any(|name| name == "Private key")
        {
            let first = lines
                .iter()
                .find(|line| line.text.contains("-----BEGIN"))
                .unwrap_or(&lines[0]);
            if !is_allowed(allows, repo, file, &first.text) {
                return Err(secret_refusal(file, first.line));
            }
        }
    }
    Ok(())
}

/// The same scan with no allows: what a patch looks like before any person has allowed a line.
pub fn scan_patch(patch: &str) -> Result<(), String> {
    scan_patch_with(patch, &[], "")
}

/// Scans commit messages the way the diff is scanned: a secret pasted into a message is a finding too. The message
/// text is never shown; the refusal names the message and its line.
fn scan_message(message: &str) -> Result<(), String> {
    let scrubber = crate::portable::scrubber();
    for (index, line) in message.lines().enumerate() {
        if !scrubber.findings(line).is_empty() {
            return Err(secret_refusal("a commit message", index + 1));
        }
    }
    if scrubber
        .findings(message)
        .iter()
        .any(|name| name == "Private key")
    {
        return Err(secret_refusal("a commit message", 1));
    }
    Ok(())
}

/// Gates the commits named by `revs` (for example `HEAD --not --remotes=origin`). Merge commits are included: a merge
/// reads as the change it makes against its first parent, remerged so conflict resolutions show. Binary-marked files
/// are read as text (`--text`), so an attribute cannot hide them. The agent-file names and the added lines are checked.
pub fn gate_range(root: &Path, revs: &[&str]) -> Result<(), String> {
    let mut name_args = vec![
        "log",
        "--format=",
        "--name-only",
        "--diff-filter=A",
        "--no-renames",
        "--diff-merges=remerge",
        "-z",
    ];
    name_args.extend_from_slice(revs);
    let names = git_checked_output(root, &name_args)?;
    for path in names.split('\0').filter(|path| !path.is_empty()) {
        if let Some(kind) = agent_file_kind(path)? {
            return Err(refused_to_push(path, kind));
        }
    }
    let mut patch_args = vec![
        "log",
        "--format=",
        "-p",
        "-U0",
        "--text",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--diff-merges=remerge",
    ];
    patch_args.extend_from_slice(revs);
    let patch = git_checked_output(root, &patch_args)?;
    scan_patch_with(&patch, &load_allows(), &repo_id(root))?;
    let mut message_args = vec!["log", "--format=%B"];
    message_args.extend_from_slice(revs);
    let messages = git_checked_output(root, &message_args)?;
    scan_message(&messages)
}

/// The remote a push from this checkout goes to: the current branch's configured remote, or `origin`.
pub fn push_remote(root: &Path) -> String {
    let branch = git_out(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    if !branch.is_empty() && branch != "HEAD" {
        if let Ok(remote) = git_out(
            root,
            &["config", "--get", &format!("branch.{branch}.remote")],
        ) {
            let remote = remote.trim();
            if !remote.is_empty() {
                return remote.to_string();
            }
        }
    }
    "origin".to_string()
}

/// The gate before a push to `remote`: every commit that remote does not have yet, whichever other remote holds it.
pub fn gate_outgoing_to(root: &Path, remote: &str) -> Result<(), String> {
    let remotes = format!("--remotes={remote}");
    gate_range(root, &["HEAD", "--not", &remotes])
}

/// The gate before a push, a pull request or a checked delivery from this checkout.
pub fn gate_outgoing(root: &Path) -> Result<(), String> {
    gate_outgoing_to(root, &push_remote(root))
}

/// The gate for a patch that is about to land into a project (text of the same change, not the binary form).
pub fn scan_landing_patch(project: &Path, patch: &str) -> Result<(), String> {
    if patch.len() > MAX_CHECKED_BYTES {
        return Err(TOO_LARGE.into());
    }
    scan_patch_with(patch, &load_allows(), &repo_id(project))
}

/// What the pre-push hook checks: the same gate as the app's own push, to the remote git is pushing to.
pub fn pre_push_check(root: &Path, remote: &str) -> Result<(), String> {
    gate_outgoing_to(root, remote)
}

/// The `pre-push-guard` subcommand, run by a crew's pre-push hook in the repository (`$1` is the remote). Prints the
/// refusal on stderr and exits 1; exits 0 when the push may go on. Reads nothing from stdin.
pub fn pre_push_main(args: &[String]) -> i32 {
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("Refused to push: the check could not find the folder ({error}).");
            return 1;
        }
    };
    let remote = match args.first().filter(|remote| !remote.is_empty()) {
        Some(remote) => remote.clone(),
        None => push_remote(&cwd),
    };
    match pre_push_check(&cwd, &remote) {
        Ok(()) => 0,
        Err(why) => {
            eprintln!("{why}");
            1
        }
    }
}

// ---- person-approved allows ------------------------------------------------------------------------------------------

/// Where person-approved allows are kept: the app's own data folder, which no agent's repository reaches. The app
/// sets it at startup; with no store, nothing is allowed.
static ALLOW_STORE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

pub fn set_allow_store(path: std::path::PathBuf) {
    let _ = ALLOW_STORE.set(path);
}

/// One line a person allowed: the repository (a hash of its path), the file, and a hash of the line's text.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Allow {
    pub repo: String,
    pub file: String,
    pub hash: String,
}

/// Proof that a person chose the allow in the app's UI. Only this module builds one, in the Tauri command below; no
/// MCP tool, CLI subcommand or agent path can, so an agent cannot set an allow.
pub struct PersonChoice(());

fn digest(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn repo_id(root: &Path) -> String {
    digest(&root.to_string_lossy())
}

fn line_hash(text: &str) -> String {
    digest(text)
}

fn is_allowed(allows: &[Allow], repo: &str, file: &str, text: &str) -> bool {
    let hash = line_hash(text);
    allows
        .iter()
        .any(|allow| allow.repo == repo && allow.file == file && allow.hash == hash)
}

/// The allows on disk. A store that is missing or does not parse allows nothing: every finding stays refused.
fn load_allows() -> Vec<Allow> {
    match ALLOW_STORE.get() {
        Some(path) => read_allows(path),
        None => Vec::new(),
    }
}

fn read_allows(path: &Path) -> Vec<Allow> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_allows(allows: &[Allow]) -> Result<(), String> {
    let path = ALLOW_STORE
        .get()
        .ok_or_else(|| "the allow list has no folder yet".to_string())?;
    write_allows(path, allows)
}

fn write_allows(path: &Path, allows: &[Allow]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(allows).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

/// The text of a line in the repository's HEAD: what a refusal's `file:line` points at now.
fn head_line(root: &Path, file: &str, line: usize) -> Result<String, String> {
    let text = git_out(root, &["show", &format!("HEAD:{file}")])?;
    text.lines()
        .nth(line.saturating_sub(1))
        .map(str::to_string)
        .ok_or_else(|| format!("{file} has no line {line} at HEAD"))
}

/// Records a person's allow for one flagged line. The line's text is read from HEAD, so the allow matches only that
/// exact line of that exact file in that repository.
pub fn allow_finding(
    _choice: PersonChoice,
    repo: &Path,
    file: &str,
    line: usize,
) -> Result<(), String> {
    let text = head_line(repo, file, line)?;
    let mut allows = load_allows();
    let allow = Allow {
        repo: repo_id(repo),
        file: file.to_string(),
        hash: line_hash(&text),
    };
    if !allows.contains(&allow) {
        allows.push(allow);
    }
    save_allows(&allows)
}

/// Allows one flagged line from the app's UI (registered in lib.rs; the webview calls it from the refusal or Settings).
#[tauri::command]
pub async fn commit_guard_allow(repo: String, file: String, line: usize) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::fs::expand_home(&repo);
        allow_finding(PersonChoice(()), &root, &file, line)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod review_tests;
#[cfg(test)]
mod tests;
