//! The commit guard: keeps files an agent writes for itself, and secrets, out of what Hivra stages, commits, pushes,
//! opens as a pull request, lands, or self-builds. The agent folders come from the shared list
//! (`src/shared/security/agentConfigPaths.json`, through the floor's loader); the secret patterns from the scrubber
//! (`src/features/portable/model/secretPatterns.json`).
//!
//! - Staging leaves out an untracked agent file, so `git add -A` never takes it.
//! - A push is checked for the commits it sends: the pushed refs (the hook reads them from git's own stdin), each
//!   checked back to the tips the remote advertises now (`git ls-remote`), never to local tracking refs. Merge
//!   commits are included; binary-marked files are read as text; git's colour and encoding settings are overridden.
//! - An added line is a finding by its token shape or a long assigned value, and a private key by its whole block.
//! - A person may allow one finding from the app's UI. The allow is recorded under a refusal id, signed with a key in
//!   the Keychain, and kept in the app's data folder. Nothing else can make one.
//! - Nothing here edits an ignore file. A refusal names the choices in words and leaves the person to pick.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
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
const COLOUR_REFUSED: &str = "The secret check read output it cannot trust (terminal colour codes), so nothing was sent. Ask Ash to check this change.";
const UNREADABLE_PUSH: &str =
    "The push's list of refs could not be read, so nothing was sent. Ask Ash to check this push.";

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

/// A secret in a commit message or a file name: there is no file line to allow, so no id is given.
fn plain_secret_refusal(what: &str) -> String {
    format!(
        "Possible secret in {what}. The value is not shown. To go on, either remove it from the commit, add the file to this project's ignore file (after you say yes), or say it is a test value. Hivra does not edit any ignore file itself."
    )
}

/// Every guard git call: plain output whatever the repository's or the person's config says (N1). The colour and
/// encoding settings are overridden on the command line, which wins over every config file.
fn guard_git(root: &Path) -> Command {
    let mut cmd = crate::fs::git_cmd();
    cmd.arg("--no-pager")
        .arg("-c")
        .arg("color.ui=never")
        .arg("-c")
        .arg("color.diff=never")
        .arg("-c")
        .arg("i18n.logOutputEncoding=UTF-8")
        .arg("-C")
        .arg(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    cmd
}

/// Whether git wrapped a line in colour codes. Colour is off on every guard command, so this should never be true; if
/// it is, the lines are not trusted. An escape byte inside a line is file content (a terminal test fixture, say) and is
/// data, not colour: git's own colour codes always lead a line.
fn colour_wrapped(bytes: &[u8]) -> bool {
    bytes
        .split(|byte| *byte == b'\n')
        .any(|line| line.first() == Some(&0x1b))
}

/// Small git answers (a name, a config value). Output with an escape byte is refused, never read.
fn git_out(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = guard_git(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    if colour_wrapped(&output.stdout) {
        return Err(COLOUR_REFUSED.into());
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
    let mut child = guard_git(root)
        .args(args)
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
    if colour_wrapped(&out) {
        return Err(COLOUR_REFUSED.into());
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
            "--no-color",
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

/// Refuses a land whose changed files name an agent file the project does not track.
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

/// One added line of a patch: the file, its line number in the new file, its text without the `+`, and its commit.
struct Added {
    file: String,
    line: usize,
    text: String,
    commit: String,
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

/// The added lines of a unified diff. Only `+` lines count (never `-`, never a `+++` file header). The `+` is removed
/// before the text is checked, and a `hivra-commit <sha>` line (the log's own marker) names the commit they belong to.
fn added_lines(patch: &str) -> Vec<Added> {
    let mut out = Vec::new();
    let mut file = String::new();
    let mut commit = String::new();
    let mut line_no = 0usize;
    let mut in_hunk = false;
    for raw in patch.lines() {
        if let Some(sha) = raw.strip_prefix("hivra-commit ") {
            commit = sha.trim().to_string();
            in_hunk = false;
            continue;
        }
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
                commit: commit.clone(),
            });
            line_no += 1;
        } else if raw.starts_with(' ') || raw.is_empty() {
            line_no += 1;
        }
    }
    out
}

/// A secret the check found: its file and line, the hash of the text it found (one line, or a whole private key
/// block), and the commit it came from (empty when the check had no commit).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub file: String,
    pub line: usize,
    pub hash: String,
    pub commit: String,
}

/// The first finding a person has not allowed. A line is found by its token shape or long assigned value; a private
/// key is found by its whole block, so an allow for one key does not allow another in the same file (N5).
fn check_patch(patch: &str, allows: &[Allow], repo: &str) -> Result<(), Finding> {
    let scrubber = crate::portable::scrubber();
    let added = added_lines(patch);
    for line in &added {
        if !scrubber.findings(&line.text).is_empty() {
            let hash = line_hash(&line.text);
            if !is_allowed(allows, repo, &line.file, &hash) {
                return Err(Finding {
                    file: line.file.clone(),
                    line: line.line,
                    hash,
                    commit: line.commit.clone(),
                });
            }
        }
    }
    let mut by_file: BTreeMap<&str, Vec<&Added>> = BTreeMap::new();
    for line in &added {
        by_file.entry(line.file.as_str()).or_default().push(line);
    }
    for (file, lines) in by_file {
        for start in 0..lines.len() {
            if !lines[start].text.contains("-----BEGIN") {
                continue;
            }
            let end = (start..lines.len())
                .find(|&index| lines[index].text.contains("-----END"))
                .unwrap_or(lines.len() - 1);
            let block = lines[start..=end]
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if scrubber
                .findings(&block)
                .iter()
                .any(|name| name == "Private key")
            {
                let hash = line_hash(&block);
                if !is_allowed(allows, repo, file, &hash) {
                    return Err(Finding {
                        file: file.to_string(),
                        line: lines[start].line,
                        hash,
                        commit: lines[start].commit.clone(),
                    });
                }
            }
        }
    }
    Ok(())
}

/// Scans the added lines of a unified diff with the given allows (for this repository `repo`). A line a person allowed
/// is not a finding. Tests and the land path use it; the gates record each refusal they raise.
pub fn scan_patch_with(patch: &str, allows: &[Allow], repo: &str) -> Result<(), String> {
    check_patch(patch, allows, repo).map_err(|finding| {
        let id = record_refusal(repo, &finding);
        refusal_text(&finding, None, &id)
    })
}

/// The same scan with no allows: what a patch looks like before any person has allowed a line.
pub fn scan_patch(patch: &str) -> Result<(), String> {
    scan_patch_with(patch, &[], "")
}

/// The refusal a person reads. Its id is what the person's one Allow button names; the folder and commit say where.
fn refusal_text(finding: &Finding, folder: Option<&str>, id: &str) -> String {
    let at = folder
        .filter(|folder| !folder.is_empty())
        .map(|folder| format!(" in {folder}"))
        .unwrap_or_default();
    let commit = if finding.commit.is_empty() {
        "none".to_string()
    } else {
        finding.commit.chars().take(12).collect()
    };
    format!(
        "Possible secret in {}:{}{at} (commit {commit}, refusal {id}). The value is not shown. To go on, either remove it from the commit, add the file to this project's ignore file (after you say yes), or say it is a test value. Hivra does not edit any ignore file itself.",
        finding.file, finding.line
    )
}

/// Scans commit messages the way the diff is scanned: a secret pasted into a message is a finding too.
fn scan_message(message: &str) -> Result<(), String> {
    let scrubber = crate::portable::scrubber();
    for (index, line) in message.lines().enumerate() {
        if !scrubber.findings(line).is_empty() {
            return Err(plain_secret_refusal(&format!(
                "a commit message:{}",
                index + 1
            )));
        }
    }
    if scrubber
        .findings(message)
        .iter()
        .any(|name| name == "Private key")
    {
        return Err(plain_secret_refusal("a commit message:1"));
    }
    Ok(())
}

/// The file names being sent: a secret shape in a name is refused too. The name is not shown.
fn scan_names(names: &[&str]) -> Result<(), String> {
    let scrubber = crate::portable::scrubber();
    for name in names {
        if !scrubber.findings(name).is_empty() {
            return Err(plain_secret_refusal("a file name (the name is not shown)"));
        }
    }
    Ok(())
}

/// Gates the commits named by `revs` (for example `sha --not <tips>`). Merge commits are included, as remerged diffs.
/// Binary-marked files are read as text, and the output is plain. The agent-file names, the file names and the added
/// lines are checked, and a refusal is recorded under its id for the person's one Allow.
pub fn gate_range(root: &Path, revs: &[&str]) -> Result<(), String> {
    let mut name_args = vec![
        "log",
        "--no-color",
        "--format=",
        "--name-only",
        "--diff-filter=A",
        "--no-renames",
        "--diff-merges=remerge",
        "-z",
    ];
    name_args.extend_from_slice(revs);
    let names = git_checked_output(root, &name_args)?;
    let names: Vec<&str> = names.split('\0').filter(|path| !path.is_empty()).collect();
    for path in &names {
        if let Some(kind) = agent_file_kind(path)? {
            return Err(refused_to_push(path, kind));
        }
    }
    scan_names(&names)?;
    let mut patch_args = vec![
        "log",
        "--no-color",
        "--format=hivra-commit %H",
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
    check_patch(&patch, &load_allows(), &repo_id(root)).map_err(|finding| {
        let folder = root.to_string_lossy().into_owned();
        let id = record_refusal(&repo_id(root), &finding);
        refusal_text(&finding, Some(&folder), &id)
    })?;
    let mut message_args = vec!["log", "--no-color", "--format=%B"];
    message_args.extend_from_slice(revs);
    let messages = git_checked_output(root, &message_args)?;
    scan_message(&messages)
}

/// The remote's tips as it advertises them now (`git ls-remote`), limited to commits this checkout has. The gate's
/// base comes from here and never from local remote-tracking refs, which a checkout can write (N3).
fn advertised_tips(root: &Path, remote: &str) -> Result<Vec<String>, String> {
    let listed = checked_output_within(
        root,
        &["ls-remote", remote],
        CHECK_TIMEOUT,
        MAX_CHECKED_BYTES,
    )?;
    let mut tips = Vec::new();
    for line in listed.lines() {
        let Some(sha) = line.split_whitespace().next() else {
            continue;
        };
        let hex = sha.chars().all(|c| c.is_ascii_hexdigit());
        if hex && (sha.len() == 40 || sha.len() == 64) && object_exists(root, sha) {
            tips.push(sha.to_string());
        }
    }
    Ok(tips)
}

fn object_exists(root: &Path, sha: &str) -> bool {
    git_out(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok()
}

fn is_zero_sha(sha: &str) -> bool {
    !sha.is_empty() && sha.chars().all(|c| c == '0')
}

/// Gates the commits reachable from `shas` that the remote does not advertise, for a push to `remote`.
fn gate_pushed(root: &Path, remote: &str, shas: &[String]) -> Result<(), String> {
    let tips = advertised_tips(root, remote)?;
    let mut revs: Vec<&str> = shas.iter().map(String::as_str).collect();
    revs.push("--not");
    revs.extend(tips.iter().map(String::as_str));
    gate_range(root, &revs)
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

/// The gate before a push to `remote` of the given commits (the app's own push, a PR, a checked delivery).
pub fn gate_outgoing_to(root: &Path, remote: &str) -> Result<(), String> {
    let head = git_out(root, &["rev-parse", "HEAD"])?;
    gate_pushed(root, remote, &[head.trim().to_string()])
}

/// The gate before the app's own push, a pull request or a checked delivery from this checkout.
pub fn gate_outgoing(root: &Path) -> Result<(), String> {
    gate_outgoing_to(root, &push_remote(root))
}

/// The pre-push check when git gives no list of refs (a manual run): every local branch and HEAD, so nothing that
/// might be pushed is left unchecked (N2).
pub fn pre_push_check(root: &Path, remote: &str) -> Result<(), String> {
    let heads = git_out(
        root,
        &["for-each-ref", "--format=%(objectname)", "refs/heads"],
    )?;
    let mut shas: Vec<String> = heads
        .lines()
        .map(str::trim)
        .filter(|sha| !sha.is_empty())
        .map(str::to_string)
        .collect();
    if let Ok(head) = git_out(root, &["rev-parse", "--verify", "-q", "HEAD"]) {
        shas.push(head.trim().to_string());
    }
    if shas.is_empty() {
        return Ok(());
    }
    gate_pushed(root, remote, &shas)
}

/// The pre-push check of what git is really sending: each `<local ref> <local sha> <remote ref> <remote sha>` line
/// on stdin is checked, so `git push origin leak`, `--all` and `<sha>:refs/heads/x` are covered whatever HEAD is (N2).
pub fn pre_push_stdin_check(root: &Path, remote: &str, stdin: &str) -> Result<(), String> {
    if stdin.trim().is_empty() {
        return pre_push_check(root, remote);
    }
    let mut shas = Vec::new();
    for line in stdin.lines().filter(|line| !line.trim().is_empty()) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() != 4 {
            return Err(UNREADABLE_PUSH.into());
        }
        if !is_zero_sha(parts[1]) {
            shas.push(parts[1].to_string());
        }
    }
    if shas.is_empty() {
        return Ok(());
    }
    gate_pushed(root, remote, &shas)
}

/// The `pre-push-guard` subcommand, run by a crew's pre-push hook in the repository. Arguments: the remote, then
/// `--store <path>` (the app's allow list). Reads git's ref lines from stdin. Prints the refusal on stderr and exits 1.
pub fn pre_push_main(args: &[String]) -> i32 {
    let mut remote: Option<String> = None;
    let mut store: Option<String> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if arg == "--store" {
            store = rest.next().cloned();
        } else if remote.is_none() {
            remote = Some(arg.clone());
        }
    }
    if let Some(path) = store {
        set_allow_store(PathBuf::from(path));
    }
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("Refused to push: the check could not find the folder ({error}).");
            return 1;
        }
    };
    let remote = remote
        .filter(|remote| !remote.is_empty())
        .unwrap_or_else(|| push_remote(&cwd));
    let mut stdin = String::new();
    if std::io::stdin().read_to_string(&mut stdin).is_err() {
        eprintln!("{UNREADABLE_PUSH}");
        return 1;
    }
    match pre_push_stdin_check(&cwd, &remote, &stdin) {
        Ok(()) => 0,
        Err(why) => {
            eprintln!("{why}");
            1
        }
    }
}

/// The gate for a patch that is about to land into a project (the text of the same change, not the binary form).
pub fn scan_landing_patch(project: &Path, patch: &str) -> Result<(), String> {
    if patch.len() > MAX_CHECKED_BYTES {
        return Err(TOO_LARGE.into());
    }
    check_patch(patch, &load_allows(), &repo_id(project)).map_err(|finding| {
        let folder = project.to_string_lossy().into_owned();
        let id = record_refusal(&repo_id(project), &finding);
        refusal_text(&finding, Some(&folder), &id)
    })
}

// ---- person-approved allows ------------------------------------------------------------------------------------------

/// Where person-approved allows are kept: the app's own data folder, which no agent's repository reaches. The app and
/// the pre-push guard set it; with no store, nothing is allowed.
static ALLOW_STORE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_allow_store(path: PathBuf) {
    let _ = ALLOW_STORE.set(path);
}

/// One line a person allowed: the repository (a hash of its canonical path), the file, the hash of the text, and a
/// signature over those three (an HMAC with the app's Keychain key). An entry without a valid signature is not used.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Allow {
    pub repo: String,
    pub file: String,
    pub hash: String,
    #[serde(default)]
    pub mac: String,
}

/// Proof that a person chose the allow in the app's UI. Only this module builds one, in the Tauri commands below.
pub struct PersonChoice(());

#[cfg(not(test))]
const KEY_SERVICE: &str = "monocode-hub:commit-guard";
#[cfg(not(test))]
const KEY_ACCOUNT: &str = "allow-key";

/// The app's allow key from the Keychain (a dev copy uses its own service name). None when it is missing or cannot be
/// read, and then nothing is allowed. Tests never reach the Keychain: they pass their own key.
#[cfg(not(test))]
fn allow_key() -> Option<Vec<u8>> {
    crate::hub_keychain::read(KEY_SERVICE, KEY_ACCOUNT)
        .ok()
        .flatten()
        .filter(|key| !key.is_empty())
        .map(String::into_bytes)
}

#[cfg(test)]
fn allow_key() -> Option<Vec<u8>> {
    None
}

/// The allow key, created on the first allow a person makes.
#[cfg(not(test))]
fn allow_key_or_create() -> Result<Vec<u8>, String> {
    if let Some(key) = allow_key() {
        return Ok(key);
    }
    let key = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    crate::hub_keychain::store(KEY_SERVICE, KEY_ACCOUNT, &key)?;
    Ok(key.into_bytes())
}

#[cfg(test)]
fn allow_key_or_create() -> Result<Vec<u8>, String> {
    Err("tests pass their own key".into())
}

fn digest(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The repository's id in the allow list: a hash of its canonical path, so the UI's path and the gate's path match.
fn repo_id(root: &Path) -> String {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    digest(&canonical.to_string_lossy())
}

fn line_hash(text: &str) -> String {
    digest(text)
}

/// HMAC-SHA256 (RFC 2104) over sha2, in hex.
fn hmac_hex(key: &[u8], message: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let ipad: Vec<u8> = block.iter().map(|byte| byte ^ 0x36).collect();
    let opad: Vec<u8> = block.iter().map(|byte| byte ^ 0x5c).collect();
    let inner = Sha256::new()
        .chain_update(&ipad)
        .chain_update(message)
        .finalize();
    let outer = Sha256::new()
        .chain_update(&opad)
        .chain_update(inner)
        .finalize();
    outer.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn signature(key: &[u8], allow: &Allow) -> String {
    hmac_hex(
        key,
        format!("{}\n{}\n{}", allow.repo, allow.file, allow.hash).as_bytes(),
    )
}

fn signed(key: &[u8], mut allow: Allow) -> Allow {
    allow.mac = signature(key, &allow);
    allow
}

fn is_allowed(allows: &[Allow], repo: &str, file: &str, hash: &str) -> bool {
    allows
        .iter()
        .any(|allow| allow.repo == repo && allow.file == file && allow.hash == hash)
}

/// The entries that carry a valid signature for `key`. Anything else (hand-written, changed, unsigned) is dropped.
fn verified(entries: Vec<Allow>, key: &[u8]) -> Vec<Allow> {
    entries
        .into_iter()
        .filter(|allow| !allow.mac.is_empty() && allow.mac == signature(key, allow))
        .collect()
}

fn read_raw(path: &Path) -> Vec<Allow> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// The allows in `path` that carry a valid signature for `key`.
fn read_allows_with(path: &Path, key: &[u8]) -> Vec<Allow> {
    verified(read_raw(path), key)
}

/// The allows on disk, verified with the app's key. With no key, nothing is allowed.
fn read_allows(path: &Path) -> Vec<Allow> {
    match allow_key() {
        Some(key) => read_allows_with(path, &key),
        None => Vec::new(),
    }
}

fn load_allows() -> Vec<Allow> {
    match ALLOW_STORE.get() {
        Some(path) => read_allows(path),
        None => Vec::new(),
    }
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

/// A refusal the gates raised, kept in the app's memory under its id. The person's Allow names the id, and only that.
#[derive(Clone, Debug)]
struct Refusal {
    id: String,
    repo: String,
    file: String,
    hash: String,
}

static REFUSALS: Mutex<Vec<Refusal>> = Mutex::new(Vec::new());
const MAX_REFUSALS: usize = 200;

fn refusal_id(repo: &str, finding: &Finding) -> String {
    digest(&format!(
        "{repo}\n{}\n{}\n{}\n{}",
        finding.file, finding.line, finding.hash, finding.commit
    ))
    .chars()
    .take(12)
    .collect()
}

/// Records a refusal and returns its id. The same finding gets the same id.
fn record_refusal(repo: &str, finding: &Finding) -> String {
    let id = refusal_id(repo, finding);
    if let Ok(mut refusals) = REFUSALS.lock() {
        if !refusals.iter().any(|known| known.id == id) {
            refusals.push(Refusal {
                id: id.clone(),
                repo: repo.to_string(),
                file: finding.file.clone(),
                hash: finding.hash.clone(),
            });
            let excess = refusals.len().saturating_sub(MAX_REFUSALS);
            refusals.drain(..excess);
        }
    }
    id
}

fn find_refusal(id: &str) -> Option<Refusal> {
    REFUSALS
        .lock()
        .ok()?
        .iter()
        .find(|refusal| refusal.id == id)
        .cloned()
}

fn store_path() -> Result<&'static PathBuf, String> {
    ALLOW_STORE
        .get()
        .ok_or_else(|| "the allow list has no folder yet".to_string())
}

/// Records a person's allow for the refusal `id`, signed with `key`. The entry is the refusal's own repository, file
/// and text hash, so it allows exactly the text that was refused, not whatever the file says now.
fn allow_refusal_with(store: &Path, id: &str, key: &[u8]) -> Result<(), String> {
    let refusal = find_refusal(id)
        .ok_or_else(|| "That refusal is no longer on record. Run the check again.".to_string())?;
    if refusal.repo.is_empty() {
        return Err("That refusal has no repository to allow it for.".into());
    }
    let entry = signed(
        key,
        Allow {
            repo: refusal.repo,
            file: refusal.file,
            hash: refusal.hash,
            mac: String::new(),
        },
    );
    let mut allows = read_allows_with(store, key);
    if !allows.contains(&entry) {
        allows.push(entry);
    }
    write_allows(store, &allows)
}

/// Allows one refusal from the app's UI (the person's one Allow button, by id).
pub fn allow_refusal(_choice: PersonChoice, id: &str) -> Result<(), String> {
    let key = allow_key_or_create()?;
    allow_refusal_with(store_path()?, id, &key)
}

/// Removes one allow. Removal reads the list as it is (it cannot grant anything), so an unsigned entry can be removed.
fn remove_allow_in(store: &Path, allow: &Allow) -> Result<(), String> {
    let kept: Vec<Allow> = read_raw(store)
        .into_iter()
        .filter(|entry| {
            !(entry.repo == allow.repo && entry.file == allow.file && entry.hash == allow.hash)
        })
        .collect();
    write_allows(store, &kept)
}

/// Removes an allow (the app's UI, through `commit_guard_remove`).
pub fn remove_allow(_choice: PersonChoice, allow: &Allow) -> Result<(), String> {
    remove_allow_in(store_path()?, allow)
}

/// Allows one refusal from the app's UI. The webview names the id it was shown and nothing else.
#[tauri::command]
pub async fn commit_guard_allow(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || allow_refusal(PersonChoice(()), &id))
        .await
        .map_err(|e| e.to_string())?
}

/// The allows on record, for the Settings list. Holds a repository's id, not its path.
#[tauri::command]
pub async fn commit_guard_allows() -> Result<Vec<Allow>, String> {
    Ok(load_allows())
}

/// Removes one allow from the Settings list (the app's UI, through a direct click).
#[tauri::command]
pub async fn commit_guard_remove(repo: String, file: String, hash: String) -> Result<(), String> {
    let allow = Allow {
        repo,
        file,
        hash,
        mac: String::new(),
    };
    remove_allow(PersonChoice(()), &allow)
}

#[cfg(test)]
mod review_tests;
#[cfg(test)]
mod review_tests_r3;
#[cfg(test)]
mod review_repro_r4;
#[cfg(test)]
mod tests;
