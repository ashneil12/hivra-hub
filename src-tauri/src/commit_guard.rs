//! The commit guard: keeps files an agent writes for itself, and secrets, out of what Hivra stages, commits, pushes,
//! opens as a pull request or lands. One list of agent files (`src/shared/security/agentConfigPaths.json`) and one
//! secret scrubber (`src/features/portable/model/secretPatterns.json`, through `portable::scrubber`) serve every path.
//!
//! - Staging leaves out an untracked agent file, so `git add -A` never takes it. A file the repo already tracks is
//!   staged as usual.
//! - Selecting or staging such a file by hand refuses the commit with one plain line.
//! - Before a push, a pull request or a land, the lines being added are scanned for secrets, and any agent file in
//!   the commits being sent stops the step. Only added lines are scanned: a removed secret is not shipped.
//! - Nothing here edits an ignore file. A refusal names the choices in words and leaves the person to pick.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;

const AGENT_PATHS: &str = include_str!("../../src/shared/security/agentConfigPaths.json");

#[derive(Deserialize)]
struct AgentPaths {
    exact: Vec<ExactRule>,
    under: Vec<UnderRule>,
}

#[derive(Deserialize)]
struct ExactRule {
    path: String,
    kind: String,
}

#[derive(Deserialize)]
struct UnderRule {
    dir: String,
    ext: String,
    kind: String,
}

fn agent_paths() -> &'static AgentPaths {
    static PATHS: OnceLock<AgentPaths> = OnceLock::new();
    PATHS.get_or_init(|| serde_json::from_str(AGENT_PATHS).expect("agentConfigPaths.json parses"))
}

/// What kind of agent file a repo path is, in the words the refusal uses, or `None` for any other file.
fn agent_file_kind(path: &str) -> Option<&'static str> {
    let paths = agent_paths();
    if let Some(rule) = paths.exact.iter().find(|rule| rule.path == path) {
        return Some(rule.kind.as_str());
    }
    paths
        .under
        .iter()
        .find(|rule| path.starts_with(&rule.dir) && path.ends_with(&rule.ext))
        .map(|rule| rule.kind.as_str())
}

const RECOVERY: &str = "To go on, either untrack it, add it to this project's ignore file (after you say yes), or say it is a test value. Hivra does not edit any ignore file itself.";

fn left_out(path: &str, kind: &str) -> String {
    format!("Left out {path}: {kind}, not for GitHub. {RECOVERY}")
}

fn refused_to_push(path: &str, kind: &str) -> String {
    format!("Refused to push {path}: it is {kind}, not for GitHub. {RECOVERY}")
}

fn secret_refusal(file: &str, line: usize) -> String {
    format!(
        "Possible secret in {file}:{line}. The value is not shown. To go on, either remove it from the commit, add the file to this project's ignore file (after you say yes), or say it is a test value. Hivra does not edit any ignore file itself."
    )
}

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
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

/// Whether HEAD already has the path. A repo with no commits has nothing tracked.
fn tracked_at_head(root: &Path, path: &str) -> bool {
    git_out(root, &["cat-file", "-e", &format!("HEAD:{path}")]).is_ok()
}

/// Agent files git does not track yet: the ones staging must leave out.
fn untracked_agent_paths(root: &Path) -> Result<Vec<String>, String> {
    let listed = git_out(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    Ok(listed
        .split('\0')
        .filter(|path| !path.is_empty() && agent_file_kind(path).is_some())
        .map(str::to_string)
        .collect())
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
        if let Some(kind) = agent_file_kind(path) {
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
        if let Some(kind) = agent_file_kind(path) {
            return Err(left_out(path, kind));
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

/// Scans the added lines of a unified diff for secrets. A single line is scanned as one line; a private key block
/// spans lines, so the added lines of each file are also scanned together for one.
pub fn scan_patch(patch: &str) -> Result<(), String> {
    let scrubber = crate::portable::scrubber();
    let added = added_lines(patch);
    for line in &added {
        if scrubber.has_secret(&line.text) {
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
            return Err(secret_refusal(file, first.line));
        }
    }
    Ok(())
}

/// Gates the commits named by `revs` (for example `HEAD --not --remotes`): refuses an agent file added in them, and
/// scans their added lines for secrets.
pub fn gate_range(root: &Path, revs: &[&str]) -> Result<(), String> {
    let mut name_args = vec![
        "log",
        "--no-merges",
        "--format=",
        "--name-only",
        "--diff-filter=A",
        "--no-renames",
        "-z",
    ];
    name_args.extend_from_slice(revs);
    let names = git_out(root, &name_args)?;
    for path in names.split('\0').filter(|path| !path.is_empty()) {
        if let Some(kind) = agent_file_kind(path) {
            return Err(refused_to_push(path, kind));
        }
    }
    let mut patch_args = vec![
        "log",
        "--no-merges",
        "--format=",
        "-p",
        "-U0",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
    ];
    patch_args.extend_from_slice(revs);
    let patch = git_out(root, &patch_args)?;
    scan_patch(&patch)
}

/// The gate before a push or a pull request: every commit the remote does not have yet.
pub fn gate_outgoing(root: &Path) -> Result<(), String> {
    gate_range(root, &["HEAD", "--not", "--remotes"])
}

#[cfg(test)]
mod tests;
