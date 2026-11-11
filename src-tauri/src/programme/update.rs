//! Bring `main` into a package branch, in that package's worktree only.
//!
//! The push is a normal push: no `--force` and no `--no-verify`. `refs/heads/main`
//! is read at the start and must be the same sha at the end. A fetch that fails,
//! a timeout, or a push that is not a fast-forward leaves the package branch
//! where it was. Those are not final failures.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::Connection;
use serde::Serialize;

use super::checkout::{self, Checkout};
use super::gitrun::{self, FETCH_TIMEOUT, LOCAL_TIMEOUT};
use super::names;
use super::settings::{self, Strategy};

const LOCK_NAME: &str = "hivra-programme-update.lock";
const LOCK_STALE: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug)]
pub(crate) struct Plan {
    pub package_id: String,
    pub worktree: PathBuf,
    pub branch: String,
    pub base: String,
    pub remote: String,
    pub strategy: Strategy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    Updated { method: Strategy, head: String },
    AlreadyCurrent,
    Conflict { detail: String },
    Refused { reason: String },
    NotFinished { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    pub package_id: String,
    pub outcome: Outcome,
}

impl UpdateReport {
    pub fn refused(package_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            package_id: package_id.into(),
            outcome: Outcome::Refused {
                reason: reason.into(),
            },
        }
    }
}

#[cfg(test)]
pub fn update_from_main(conn: &Connection, package_id: &str) -> Result<UpdateReport, String> {
    match load(conn, package_id)? {
        Some(plan) => Ok(execute(&plan)),
        None => Ok(UpdateReport::refused(
            package_id.trim(),
            "That package has no worktree recorded.",
        )),
    }
}

pub(crate) fn load(conn: &Connection, package_id: &str) -> Result<Option<Plan>, String> {
    let Some(checkout) = checkout::get(conn, package_id)? else {
        return Ok(None);
    };
    Ok(Some(plan_from(conn, &checkout)?))
}

/// The package worktree: the one worktree of `folder` with `branch` checked out. Zero
/// matches is "not found"; several is refused, so the update never guesses.
pub(crate) fn branch_worktree(folder: &Path, branch: &str) -> Result<Option<PathBuf>, String> {
    let branch = names::branch_name(branch)?;
    let ran = gitrun::run(folder, &["worktree", "list", "--porcelain"], LOCAL_TIMEOUT)
        .map_err(run_error_text)?;
    if ran.code != 0 {
        return Err("The worktrees could not be read. Nothing was changed. Try again.".into());
    }
    let wanted = format!("refs/heads/{branch}");
    let mut found: Vec<PathBuf> = Vec::new();
    let mut current: Option<PathBuf> = None;
    for line in ran.stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current = Some(PathBuf::from(path));
        } else if line.strip_prefix("branch ") == Some(wanted.as_str()) {
            if let Some(path) = current.clone() {
                found.push(path);
            }
        } else if line.is_empty() {
            current = None;
        }
    }
    match found.len() {
        0 => Ok(None),
        1 => Ok(found.pop()),
        _ => Err("More than one worktree has that branch checked out. Nothing was changed.".into()),
    }
}

fn run_error_text(error: gitrun::RunError) -> String {
    match error {
        gitrun::RunError::Refused(reason) | gitrun::RunError::NotFinished(reason) => reason,
    }
}

fn plan_from(conn: &Connection, checkout: &Checkout) -> Result<Plan, String> {
    let branch = names::branch_name(&checkout.branch)?.to_string();
    let base = names::branch_name(&checkout.base)?.to_string();
    let remote = names::remote_name(&checkout.remote)?.to_string();
    let strategy = settings::get(conn, &checkout.project)?.strategy;
    Ok(Plan {
        package_id: checkout.package_id.clone(),
        worktree: checkout::path_of(checkout),
        branch,
        base,
        remote,
        strategy,
    })
}

pub(crate) fn execute(plan: &Plan) -> UpdateReport {
    let outcome = match try_update(plan) {
        Ok(outcome) => outcome,
        Err(outcome) => outcome,
    };
    UpdateReport {
        package_id: plan.package_id.clone(),
        outcome,
    }
}

fn try_update(plan: &Plan) -> Result<Outcome, Outcome> {
    let branch = names::branch_name(&plan.branch).map_err(refused)?;
    let base = names::branch_name(&plan.base).map_err(refused)?;
    let remote = names::remote_name(&plan.remote).map_err(refused)?;
    if names::is_protected(branch, base) {
        return Err(refused("That branch is main. It was not updated."));
    }
    let worktree = crate::fs::canonical(&plan.worktree)
        .map_err(|_| refused("That worktree folder could not be read. Nothing was changed."))?;
    if !worktree.is_dir() {
        return Err(refused(
            "That worktree folder could not be read. Nothing was changed.",
        ));
    }
    require_work_tree(&worktree)?;
    if main_checkout(&worktree)? {
        return Err(refused(
            "This is the main checkout, not a package worktree. Nothing was changed.",
        ));
    }
    same_branch(&worktree, branch)?;
    ensure_clean(&worktree)?;
    let main_before = rev(&worktree, &format!("refs/heads/{base}"))?;
    let old = head(&worktree)?;
    let git_dir = absolute_git_dir(&worktree)?;
    let _lock = hold_lock(&git_dir)?;
    same_branch(&worktree, branch)?;
    ensure_clean(&worktree)?;

    fetch(&worktree, remote, base)?;
    guard_main(&worktree, base, &main_before)?;
    // The fetch can take a while and the package's builder may still be working here.
    same_branch(&worktree, branch)?;
    ensure_clean(&worktree)?;
    unmoved(&worktree, &old)?;
    let tracking = format!("refs/remotes/{remote}/{base}");
    if rev(&worktree, &tracking)?.is_none() {
        return Err(not_finished(
            "Main could not be fetched. Nothing was changed. Try again.",
        ));
    }
    if ancestor(&worktree, &tracking, "HEAD")? {
        guard_main(&worktree, base, &main_before)?;
        return Ok(Outcome::AlreadyCurrent);
    }

    match plan.strategy {
        Strategy::Merge => merge(&worktree, remote, base, &old, branch)?,
        Strategy::Rebase => rebase(&worktree, remote, base, &old, branch)?,
    }
    let new_head = head(&worktree)?;
    if new_head == old {
        guard_main(&worktree, base, &main_before)?;
        return Ok(Outcome::AlreadyCurrent);
    }
    if let Err(outcome) = push(&worktree, remote, branch, base) {
        undo_ours(&worktree, branch, &old, &new_head)?;
        guard_main(&worktree, base, &main_before)?;
        return Err(outcome);
    }
    guard_main(&worktree, base, &main_before)?;
    if head(&worktree)? != new_head {
        return Err(not_finished(
            "The branch changed while it was pushed, so the result was not trusted. Nothing was force-pushed.",
        ));
    }
    Ok(Outcome::Updated {
        method: plan.strategy,
        head: new_head,
    })
}

pub(crate) fn fetch_args(remote: &str, base: &str) -> Vec<String> {
    vec![
        "fetch".into(),
        "--no-tags".into(),
        remote.into(),
        format!("refs/heads/{base}:refs/remotes/{remote}/{base}"),
    ]
}

pub(crate) fn merge_args(remote: &str, base: &str) -> Vec<String> {
    vec![
        "merge".into(),
        "--no-edit".into(),
        format!("refs/remotes/{remote}/{base}"),
    ]
}

pub(crate) fn rebase_args(remote: &str, base: &str) -> Vec<String> {
    vec!["rebase".into(), format!("refs/remotes/{remote}/{base}")]
}

/// Config before the push subcommand, then the flags and destination after it. The subcommand name is written in
/// `push`, beside the gate: a helper that named it would be a push the guard does not see.
pub(crate) fn push_transport_args(url: &str, refspec: &str) -> (Vec<String>, Vec<String>) {
    (
        vec![
            "-c".into(),
            "core.commitGraph=false".into(),
            "-c".into(),
            "pack.useBitmaps=false".into(),
        ],
        vec![
            "--no-follow-tags".into(),
            "--recurse-submodules=no".into(),
            url.into(),
            refspec.into(),
        ],
    )
}

fn fetch(worktree: &Path, remote: &str, base: &str) -> Result<(), Outcome> {
    let args = fetch_args(remote, base);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let ran = git(worktree, &borrowed, FETCH_TIMEOUT)?;
    if ran.code == 0 {
        return Ok(());
    }
    Err(not_finished(
        "Main could not be fetched. Nothing was changed. Try again.",
    ))
}

fn merge(
    worktree: &Path,
    remote: &str,
    base: &str,
    old: &str,
    branch: &str,
) -> Result<(), Outcome> {
    let args = merge_args(remote, base);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let ran = git(worktree, &borrowed, LOCAL_TIMEOUT)?;
    if ran.code == 0 {
        return Ok(());
    }
    let conflict = ran.stderr.contains("CONFLICT")
        || ran.stdout.contains("CONFLICT")
        || ran.stderr.contains("Automatic merge failed")
        || in_merge(worktree);
    cancel_merge(worktree, old, branch)?;
    if conflict {
        return Err(Outcome::Conflict {
            detail:
                "The merge hit conflicts, so it was cancelled and the branch was left as it was."
                    .into(),
        });
    }
    Err(not_finished(
        "The merge did not finish. Nothing was changed. Try again.",
    ))
}

fn rebase(
    worktree: &Path,
    remote: &str,
    base: &str,
    old: &str,
    branch: &str,
) -> Result<(), Outcome> {
    let args = rebase_args(remote, base);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let ran = git(worktree, &borrowed, LOCAL_TIMEOUT)?;
    if ran.code == 0 {
        return Ok(());
    }
    let conflict = ran.stderr.contains("CONFLICT")
        || ran.stdout.contains("CONFLICT")
        || ran.stderr.contains("could not apply")
        || in_rebase(worktree);
    cancel_rebase(worktree, old, branch)?;
    if conflict {
        return Err(Outcome::Conflict {
            detail:
                "The rebase hit conflicts, so it was cancelled and the branch was left as it was."
                    .into(),
        });
    }
    Err(not_finished(
        "The rebase did not finish. Nothing was changed. Try again.",
    ))
}

fn push(worktree: &Path, remote: &str, branch: &str, base: &str) -> Result<(), Outcome> {
    if names::is_protected(branch, base) {
        return Err(refused("That branch is main. It was not updated."));
    }
    // The gate returns the URLs it checked. The push names those URLs, not the remote: a pushurl written after
    // the check would otherwise send the commit somewhere the check never read.
    let checked =
        crate::commit_guard::gate_outgoing_to(worktree, remote).map_err(outcome_from_gate)?;
    if checked.urls.is_empty() {
        return Err(outcome_from_gate(format!(
            "the remote {remote} has no push URL"
        )));
    }
    let refspec = format!("{}:refs/heads/{branch}", checked.sha);
    for url in &checked.urls {
        let (before, after) = push_transport_args(url, &refspec);
        let mut args = before;
        args.push("push".to_string());
        args.extend(after);
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let ran = git(worktree, &borrowed, FETCH_TIMEOUT)?;
        if ran.code != 0 {
            return Err(not_finished(
                "A normal push was refused, so the branch was put back. Nothing was force-pushed.",
            ));
        }
    }
    record_pushed_refs(worktree, remote, branch, &checked.sha);
    Ok(())
}

/// A secret or an agent file is a final refusal. Anything else (the remote could not be read, a timeout) is not:
/// the caller puts the branch back and the update can be tried again.
fn outcome_from_gate(error: String) -> Outcome {
    if error.starts_with("Possible secret") || error.starts_with("Refused to push") {
        return refused(error);
    }
    not_finished(format!(
        "{error} The branch was put back. Nothing was force-pushed."
    ))
}

/// A push of a raw URL does not move `refs/remotes/`. Write the refs the remote's fetch refspec maps. The objects
/// have already landed, so a missing refspec is not a failed push. Upstream is not set: this push never did.
fn record_pushed_refs(worktree: &Path, remote: &str, branch: &str, sha: &str) {
    let key = format!("remote.{remote}.fetch");
    let Ok(ran) = git(worktree, &["config", "--get-all", &key], LOCAL_TIMEOUT) else {
        return;
    };
    if ran.code != 0 {
        return;
    }
    for dst in crate::commit_guard::remote_tracking_refs(&ran.stdout, branch) {
        let _ = git(worktree, &["update-ref", &dst, sha], LOCAL_TIMEOUT);
    }
}

fn cancel_merge(worktree: &Path, old: &str, branch: &str) -> Result<(), Outcome> {
    if in_merge(worktree) {
        let _ = git(worktree, &["merge", "--abort"], LOCAL_TIMEOUT);
    }
    settled(worktree, old, branch)
}

fn cancel_rebase(worktree: &Path, old: &str, branch: &str) -> Result<(), Outcome> {
    if in_rebase(worktree) {
        let _ = git(worktree, &["rebase", "--abort"], LOCAL_TIMEOUT);
    }
    settled(worktree, old, branch)
}

fn settled(worktree: &Path, old: &str, branch: &str) -> Result<(), Outcome> {
    same_branch(worktree, branch)?;
    // A failed merge or rebase leaves HEAD where it was. A HEAD that moved is someone
    // else's commit, so it is never reset away.
    unmoved(worktree, old)?;
    if clean_tree(worktree)? {
        return Ok(());
    }
    if can_reset(worktree)? {
        let _ = git(worktree, &["reset", "--hard", old], LOCAL_TIMEOUT);
    }
    same_branch(worktree, branch)?;
    if head(worktree)?.as_str() == old && clean_tree(worktree)? {
        return Ok(());
    }
    Err(not_finished(
        "The update could not be undone cleanly. The worktree was left for you.",
    ))
}

fn unmoved(worktree: &Path, old: &str) -> Result<(), Outcome> {
    if head(worktree)?.as_str() == old {
        return Ok(());
    }
    Err(not_finished(
        "The branch moved during the update, so it was left as it is. Nothing was force-pushed. Try again.",
    ))
}

fn undo_ours(worktree: &Path, branch: &str, old: &str, ours: &str) -> Result<(), Outcome> {
    same_branch(worktree, branch)?;
    if head(worktree)?.as_str() != ours {
        return Err(not_finished(
            "The branch changed during the update, so it was left as it was. Nothing was force-pushed.",
        ));
    }
    if !clean_tree(worktree)? {
        return Err(not_finished(
            "The worktree changed during the update, so it was left as it was. Nothing was force-pushed.",
        ));
    }
    let ran = git(worktree, &["reset", "--hard", old], LOCAL_TIMEOUT)?;
    if ran.code != 0 || head(worktree)?.as_str() != old {
        return Err(not_finished(
            "The branch could not be put back after the push was refused. Nothing was force-pushed.",
        ));
    }
    Ok(())
}

fn require_work_tree(worktree: &Path) -> Result<(), Outcome> {
    let ran = git(
        worktree,
        &["rev-parse", "--is-inside-work-tree"],
        LOCAL_TIMEOUT,
    )?;
    if ran.code == 0 && ran.stdout.trim() == "true" {
        return Ok(());
    }
    Err(refused(
        "That folder is not a git worktree. Nothing was changed.",
    ))
}

fn main_checkout(worktree: &Path) -> Result<bool, Outcome> {
    let git_dir = absolute_git_dir(worktree)?;
    let common = absolute_common_dir(worktree)?;
    let git_dir = crate::fs::canonical(&git_dir).unwrap_or(git_dir);
    let common = crate::fs::canonical(&common).unwrap_or(common);
    Ok(git_dir == common)
}

fn same_branch(worktree: &Path, branch: &str) -> Result<(), Outcome> {
    let current = current_branch(worktree)?;
    if current == branch {
        return Ok(());
    }
    Err(refused(format!(
        "The worktree is on {current}, not {branch}. Nothing was changed."
    )))
}

fn current_branch(worktree: &Path) -> Result<String, Outcome> {
    let ran = git(
        worktree,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        LOCAL_TIMEOUT,
    )?;
    if ran.code != 0 {
        return Err(not_finished(
            "The worktree branch could not be read. Nothing was changed. Try again.",
        ));
    }
    Ok(ran.stdout.trim().to_string())
}

fn ensure_clean(worktree: &Path) -> Result<(), Outcome> {
    if in_merge(worktree) || in_rebase(worktree) {
        return Err(refused(
            "A merge or rebase is already in progress, so the worktree was left alone.",
        ));
    }
    if !clean_tree(worktree)? {
        return Err(refused(
            "The package worktree has uncommitted work, so it was left alone.",
        ));
    }
    Ok(())
}

fn clean_tree(worktree: &Path) -> Result<bool, Outcome> {
    let ran = git(
        worktree,
        &["status", "--porcelain=v1", "--untracked-files=all", "-z"],
        LOCAL_TIMEOUT,
    )?;
    if ran.code != 0 {
        return Err(not_finished(
            "The worktree could not be read. Nothing was changed. Try again.",
        ));
    }
    Ok(ran.stdout.is_empty())
}

fn can_reset(worktree: &Path) -> Result<bool, Outcome> {
    let ran = git(
        worktree,
        &["status", "--porcelain=v1", "--untracked-files=all", "-z"],
        LOCAL_TIMEOUT,
    )?;
    if ran.code != 0 {
        return Ok(false);
    }
    if ran.stdout.is_empty() {
        return Ok(true);
    }
    Ok(ran
        .stdout
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .all(unmerged_or_untracked))
}

fn unmerged_or_untracked(entry: &str) -> bool {
    let mut chars = entry.chars();
    let x = chars.next();
    let y = chars.next();
    match (x, y) {
        (Some('?'), Some('?')) => true,
        (Some(x), Some(y)) => is_unmerged(x, y),
        _ => false,
    }
}

fn is_unmerged(x: char, y: char) -> bool {
    matches!(
        (x, y),
        ('U', 'U') | ('A', 'A') | ('D', 'D') | ('A', 'U') | ('U', 'A') | ('D', 'U') | ('U', 'D')
    )
}

fn in_merge(worktree: &Path) -> bool {
    git(
        worktree,
        &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
        LOCAL_TIMEOUT,
    )
    .map(|ran| ran.code == 0)
    .unwrap_or(false)
}

fn in_rebase(worktree: &Path) -> bool {
    git_path_exists(worktree, "rebase-merge") || git_path_exists(worktree, "rebase-apply")
}

fn git_path_exists(worktree: &Path, name: &str) -> bool {
    let Ok(ran) = git(worktree, &["rev-parse", "--git-path", name], LOCAL_TIMEOUT) else {
        return false;
    };
    if ran.code != 0 {
        return false;
    }
    let path = PathBuf::from(ran.stdout.trim());
    let path = if path.is_absolute() {
        path
    } else {
        worktree.join(path)
    };
    path.exists()
}

fn ancestor(worktree: &Path, older: &str, newer: &str) -> Result<bool, Outcome> {
    let ran = git(
        worktree,
        &["merge-base", "--is-ancestor", older, newer],
        LOCAL_TIMEOUT,
    )?;
    match ran.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(not_finished(
            "Main could not be compared with the package branch. Nothing was changed. Try again.",
        )),
    }
}

fn head(worktree: &Path) -> Result<String, Outcome> {
    let ran = git(worktree, &["rev-parse", "HEAD"], LOCAL_TIMEOUT)?;
    if ran.code != 0 {
        return Err(not_finished(
            "The worktree commit could not be read. Nothing was changed. Try again.",
        ));
    }
    Ok(ran.stdout.trim().to_string())
}

fn rev(worktree: &Path, name: &str) -> Result<Option<String>, Outcome> {
    let ran = git(
        worktree,
        &["rev-parse", "--verify", "--quiet", name],
        LOCAL_TIMEOUT,
    )?;
    if ran.code == 0 {
        let sha = ran.stdout.trim().to_string();
        if sha.is_empty() {
            return Ok(None);
        }
        return Ok(Some(sha));
    }
    Ok(None)
}

fn guard_main(worktree: &Path, base: &str, before: &Option<String>) -> Result<(), Outcome> {
    let now = rev(worktree, &format!("refs/heads/{base}"))?;
    if &now != before {
        return Err(not_finished(
            "Main's branch changed, so the update stopped. It was not meant to edit main.",
        ));
    }
    Ok(())
}

fn absolute_git_dir(worktree: &Path) -> Result<PathBuf, Outcome> {
    let ran = git(
        worktree,
        &["rev-parse", "--absolute-git-dir"],
        LOCAL_TIMEOUT,
    )?;
    if ran.code != 0 {
        return Err(not_finished(
            "The worktree could not be read. Nothing was changed. Try again.",
        ));
    }
    Ok(PathBuf::from(ran.stdout.trim()))
}

fn absolute_common_dir(worktree: &Path) -> Result<PathBuf, Outcome> {
    let ran = git(
        worktree,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        LOCAL_TIMEOUT,
    )?;
    if ran.code == 0 {
        return Ok(PathBuf::from(ran.stdout.trim()));
    }
    let ran = git(worktree, &["rev-parse", "--git-common-dir"], LOCAL_TIMEOUT)?;
    if ran.code != 0 {
        return Err(not_finished(
            "The worktree could not be read. Nothing was changed. Try again.",
        ));
    }
    let path = PathBuf::from(ran.stdout.trim());
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(worktree.join(path))
    }
}

struct HeldLock {
    path: PathBuf,
    root: PathBuf,
    token: String,
}

impl Drop for HeldLock {
    fn drop(&mut self) {
        release_lock(&self.path, &self.root, &self.token);
    }
}

fn hold_lock(git_dir: &Path) -> Result<HeldLock, Outcome> {
    let root = crate::fs::canonical(git_dir).map_err(|_| {
        not_finished("The worktree could not be read. Nothing was changed. Try again.")
    })?;
    let path = root.join(LOCK_NAME);
    if path.parent() != Some(root.as_path()) {
        return Err(refused(
            "The update lock would sit outside the worktree. Nothing was changed.",
        ));
    }
    if let Some(held) = create_lock(&path, &root)? {
        return Ok(held);
    }
    if lock_is_stale(&path) {
        remove_lock_file(&path, &root)?;
        if let Some(held) = create_lock(&path, &root)? {
            return Ok(held);
        }
    }
    Err(not_finished(
        "Another update is already running in this worktree. Nothing was changed.",
    ))
}

fn create_lock(path: &Path, root: &Path) -> Result<Option<HeldLock>, Outcome> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            let token = uuid::Uuid::new_v4().simple().to_string();
            let _ = writeln!(file, "{token}");
            Ok(Some(HeldLock {
                path: path.to_path_buf(),
                root: root.to_path_buf(),
                token,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
        Err(_) => Err(not_finished(
            "The update could not lock the worktree. Nothing was changed. Try again.",
        )),
    }
}

fn lock_is_stale(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified)
        .map(|age| age > LOCK_STALE)
        .unwrap_or(false)
}

fn remove_lock_file(path: &Path, root: &Path) -> Result<(), Outcome> {
    let Ok(canonical) = crate::fs::canonical(path) else {
        return Ok(());
    };
    let Ok(root) = crate::fs::canonical(root) else {
        return Err(refused(
            "The update lock would sit outside the worktree. Nothing was changed.",
        ));
    };
    if canonical.parent() != Some(root.as_path())
        || canonical.file_name().and_then(|n| n.to_str()) != Some(LOCK_NAME)
    {
        return Err(refused(
            "The update lock would sit outside the worktree. Nothing was changed.",
        ));
    }
    let _ = fs::remove_file(canonical);
    Ok(())
}

fn release_lock(path: &Path, root: &Path, token: &str) {
    let Ok(canonical) = crate::fs::canonical(path) else {
        return;
    };
    let Ok(root) = crate::fs::canonical(root) else {
        return;
    };
    if canonical.parent() != Some(root.as_path())
        || canonical.file_name().and_then(|name| name.to_str()) != Some(LOCK_NAME)
    {
        return;
    }
    let Ok(mut file) = fs::File::open(&canonical) else {
        return;
    };
    let mut found = String::new();
    if file.read_to_string(&mut found).is_err() {
        return;
    }
    if found.trim() == token {
        let _ = fs::remove_file(canonical);
    }
}

fn git(cwd: &Path, args: &[&str], timeout: Duration) -> Result<gitrun::Ran, Outcome> {
    gitrun::run(cwd, args, timeout).map_err(|error| match error {
        gitrun::RunError::Refused(reason) => refused(reason),
        gitrun::RunError::NotFinished(reason) => not_finished(reason),
    })
}

fn refused(reason: impl Into<String>) -> Outcome {
    Outcome::Refused {
        reason: reason.into(),
    }
}

fn not_finished(reason: impl Into<String>) -> Outcome {
    Outcome::NotFinished {
        reason: reason.into(),
    }
}
