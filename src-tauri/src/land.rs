//! r84 (c02 r83: four of five finished workers' changes stayed in their own copies; only the one the Lead re-did by hand
//! reached the project): when a delegated worker in its own checkout reports done, the app puts its changes into the
//! project. Everything it changed since its copy was made (commits and uncommitted work, new files too) goes in as one
//! patch, only if it applies cleanly; otherwise nothing changes and the Lead hears why. The worker's own index and copy
//! are never touched (a throwaway index is used), and nothing is committed in the project.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// One throwaway index per landing, so two workers finishing together never share one.
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// r86 (c02 r85 run 1: two jobs finishing close together both wrote `App.tsx`): one landing or refresh at a time, so
/// each reads the project as the one before it left it.
static LANDING: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
    LANDING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Landing {
    /// "landed", "already" (the project has it), "nothing" (no change), or "conflict" (it doesn't apply cleanly).
    pub outcome: String,
    pub files: Vec<String>,
    pub why: String,
}

fn git(
    dir: &Path,
    args: &[&str],
    index: Option<&Path>,
    stdin: Option<&[u8]>,
) -> Result<(bool, Vec<u8>, String), String> {
    use std::io::Write;
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    cmd.stdin(if stdin.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    })
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git couldn't start: {e}"))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(input).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok((
        out.status.success(),
        out.stdout,
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ))
}

/// The project a worker checkout belongs to: `<parent>/<name>-worktrees/<copy>` belongs to `<parent>/<name>`.
pub(crate) fn project_of(checkout: &Path, project: &Path) -> bool {
    let Some(folder) = checkout.parent() else {
        return false;
    };
    let (Some(name), Some(parent)) = (
        project.file_name().and_then(|n| n.to_str()),
        project.parent(),
    ) else {
        return false;
    };
    folder.file_name().and_then(|n| n.to_str()) == Some(&format!("{name}-worktrees"))
        && folder.parent() == Some(parent)
}

/// The worker's whole change against where its copy started, as a binary patch, and the files it touches.
fn worker_patch(checkout: &Path, project: &Path) -> Result<(Vec<u8>, Vec<String>, String), String> {
    let (ok, head, why) = git(project, &["rev-parse", "HEAD"], None, None)?;
    if !ok {
        return Err(format!("the project's commit couldn't be read: {why}"));
    }
    let project_head = String::from_utf8_lossy(&head).trim().to_string();
    let (ok, base, why) = git(checkout, &["merge-base", "HEAD", &project_head], None, None)?;
    if !ok {
        return Err(format!(
            "the copy's starting point couldn't be found: {why}"
        ));
    }
    let base = String::from_utf8_lossy(&base).trim().to_string();
    let index: PathBuf = std::env::temp_dir().join(format!(
        "monocode-land-{}-{}.index",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = std::fs::remove_file(&index);
    let result = (|| {
        let (ok, _, why) = git(checkout, &["read-tree", "HEAD"], Some(&index), None)?;
        if !ok {
            return Err(format!("the copy couldn't be read: {why}"));
        }
        // WP-91: a worker's handoff is a note kept in its own checkout, never one of its changes (checkpoint.rs leaves
        // it out of integration too), so it is not work that has to land before the copy can go.
        let handoff = format!(":(exclude){}", crate::goal_graph::handoff::DIR);
        // WP-200: untracked agent files (local approvals, saved transcripts) are left out of what lands too.
        let mut add = crate::commit_guard::add_all_pathspec(checkout)?;
        add.push(handoff);
        let add: Vec<&str> = add.iter().map(String::as_str).collect();
        let (ok, _, why) = git(checkout, &add, Some(&index), None)?;
        if !ok {
            return Err(format!("the copy's changes couldn't be gathered: {why}"));
        }
        // WP-200: the staged blobs are checked, not a coloured diff. Git LFS and submodules are not followed.
        let files = crate::commit_guard::scan_landing_index(checkout, &index, &base, project)?;
        let (ok, patch, why) = git(
            checkout,
            &[
                "diff",
                "--cached",
                "--binary",
                "--no-color",
                "--no-ext-diff",
                &base,
            ],
            Some(&index),
            None,
        )?;
        if !ok {
            return Err(format!("the copy's change couldn't be written out: {why}"));
        }
        Ok((patch, files, base.clone()))
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// Hivra WP-12 (the teardown guard, src/delivery/teardown.rs): whether everything the worker changed is already in the
/// project, so removing its copy loses nothing. A change that is only partly there counts as not landed.
pub(crate) fn landed_in(checkout: &Path, project: &Path) -> Result<bool, String> {
    let (patch, _, _) = worker_patch(checkout, project)?;
    if patch.is_empty() {
        return Ok(true);
    }
    let (already, _, _) = git(
        project,
        &["apply", "--check", "-R", "-"],
        None,
        Some(&patch),
    )?;
    Ok(already)
}

pub(crate) fn land(checkout: &Path, project: &Path) -> Result<Landing, String> {
    if !project_of(checkout, project) {
        return Err("Only a worker's own copy of this project lands in it.".into());
    }
    let _turn = one_at_a_time();
    let (patch, files, base) = worker_patch(checkout, project)?;
    if patch.is_empty() {
        return Ok(Landing {
            outcome: "nothing".into(),
            files,
            why: "the worker changed no files".into(),
        });
    }
    // WP-200: an agent's approvals file the worker committed or staged itself does not land.
    crate::commit_guard::refuse_land_names(project, &files)?;
    let (fits, _, why) = git(project, &["apply", "--check", "-"], None, Some(&patch))?;
    if !fits {
        let (already, _, _) = git(
            project,
            &["apply", "--check", "-R", "-"],
            None,
            Some(&patch),
        )?;
        if already {
            return Ok(Landing {
                outcome: "already".into(),
                files,
                why: "the project already has these changes".into(),
            });
        }
        // Another worker changed the same files first: a three-way merge per file, written only if every file merges.
        return Ok(match merged(checkout, project, &base, &files)? {
            Ok(writes) => {
                for (path, content) in writes {
                    let target = project.join(&path);
                    match content {
                        Some(bytes) => {
                            if let Some(dir) = target.parent() {
                                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                            }
                            std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
                        }
                        None => {
                            let _ = std::fs::remove_file(&target);
                        }
                    }
                }
                Landing {
                    outcome: "landed".into(),
                    files,
                    why: "merged with changes already in the project".into(),
                }
            }
            Err(clashing) => Landing {
                outcome: "conflict".into(),
                files: clashing,
                why: crate::gates::tail(&why, 300),
            },
        });
    }
    let (ok, _, why) = git(project, &["apply", "-"], None, Some(&patch))?;
    if !ok {
        return Ok(Landing {
            outcome: "conflict".into(),
            files,
            why: crate::gates::tail(&why, 600),
        });
    }
    Ok(Landing {
        outcome: "landed".into(),
        files,
        why: String::new(),
    })
}

/// A file at the copy's starting point, if it was there.
fn at_base(checkout: &Path, base: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let (ok, bytes, _) = git(checkout, &["show", &format!("{base}:{path}")], None, None)?;
    Ok(ok.then_some(bytes))
}

/// Where `refresh` keeps the project's version of each file it merged into the copy: from then on that is the file's
/// starting point, so the worker's settled file is its change on top of the project's, not a clash with it.
fn snapshot_dir(checkout: &Path) -> Result<PathBuf, String> {
    let (ok, dir, why) = git(checkout, &["rev-parse", "--absolute-git-dir"], None, None)?;
    if !ok {
        return Err(format!("the copy's git folder couldn't be found: {why}"));
    }
    Ok(PathBuf::from(String::from_utf8_lossy(&dir).trim()).join("monocode-refreshed"))
}

/// A file's starting point: the project's version `refresh` merged in, else the copy's starting commit's.
fn start_of(checkout: &Path, base: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let kept = snapshot_dir(checkout)?.join(path);
    if kept.exists() {
        return Ok(read(&kept));
    }
    at_base(checkout, base, path)
}

fn read(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

/// Three-way merge of one file's three versions: the merged bytes, or None when they clash (or aren't text).
fn merge3(ours: &[u8], base: &[u8], theirs: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let dir = std::env::temp_dir().join(format!(
        "monocode-merge-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let (o, b, t) = (dir.join("ours"), dir.join("base"), dir.join("theirs"));
        std::fs::write(&o, ours).map_err(|e| e.to_string())?;
        std::fs::write(&b, base).map_err(|e| e.to_string())?;
        std::fs::write(&t, theirs).map_err(|e| e.to_string())?;
        let out = Command::new("git")
            .arg("merge-file")
            .arg("-p")
            .arg(&o)
            .arg(&b)
            .arg(&t)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(out.status.success().then_some(out.stdout))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

type Writes = Vec<(String, Option<Vec<u8>>)>;

/// What each changed file becomes in the project when the worker's change and the project's own since the copy's
/// start are merged; Err with the files that clash.
fn merged(
    checkout: &Path,
    project: &Path,
    base: &str,
    files: &[String],
) -> Result<Result<Writes, Vec<String>>, String> {
    let mut writes = Vec::new();
    let mut clashing = Vec::new();
    for path in files {
        let start = start_of(checkout, base, path)?;
        let worker = read(&checkout.join(path));
        let now = read(&project.join(path));
        if worker == now || worker == start {
            continue;
        }
        if now == start {
            writes.push((path.clone(), worker));
            continue;
        }
        match (&now, &start, &worker) {
            (Some(now), Some(start), Some(worker)) => match merge3(now, start, worker)? {
                Some(bytes) => writes.push((path.clone(), Some(bytes))),
                None => clashing.push(path.clone()),
            },
            _ => clashing.push(path.clone()),
        }
    }
    Ok(if clashing.is_empty() {
        Ok(writes)
    } else {
        Err(clashing)
    })
}

/// The files the project changed since `base`: committed or not, and new ones it doesn't ignore.
fn project_changes(project: &Path, base: &str) -> Result<Vec<String>, String> {
    let (ok, changed, why) = git(project, &["diff", "--name-only", base], None, None)?;
    if !ok {
        return Err(format!("the project's changes couldn't be read: {why}"));
    }
    let (_, added, _) = git(
        project,
        &["ls-files", "--others", "--exclude-standard"],
        None,
        None,
    )?;
    let mut paths: Vec<String> = String::from_utf8_lossy(&changed)
        .lines()
        .chain(String::from_utf8_lossy(&added).lines())
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// r84 (c02: the last-week worker clashed with the shared-type one in App.tsx): the project's changes merged into the
/// worker's own copy, conflict markers left where both changed the same lines, so the worker can settle them and report
/// again. Returns the files that now carry markers. The project is never touched.
pub(crate) fn refresh(checkout: &Path, project: &Path) -> Result<Vec<String>, String> {
    if !project_of(checkout, project) {
        return Err("Only a worker's own copy of this project is brought up to date.".into());
    }
    let _turn = one_at_a_time();
    let (_, files, base) = worker_patch(checkout, project)?;
    let mut marked = Vec::new();
    let kept = snapshot_dir(checkout)?;
    // r86 (c02 r85 run 1: the copy got the project's App.tsx calling `weekTotals`, but not the format.ts that defines
    // it): every file the project changed since the copy's start that the worker left alone comes in as the project
    // has it, and becomes that file's starting point, so the copy is the project plus the worker's own change.
    for path in project_changes(project, base.as_str())? {
        if files.contains(&path) {
            continue;
        }
        let now = read(&project.join(&path));
        if now == start_of(checkout, base.as_str(), &path)? {
            continue;
        }
        let target = checkout.join(&path);
        match &now {
            Some(bytes) => {
                if let Some(dir) = target.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
            }
            None => {
                let _ = std::fs::remove_file(&target);
            }
        }
        if let Some(bytes) = now {
            let snapshot = kept.join(&path);
            if let Some(dir) = snapshot.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(&snapshot, bytes).map_err(|e| e.to_string())?;
        }
    }
    for path in &files {
        let start = start_of(checkout, base.as_str(), path)?;
        let (worker, now) = (read(&checkout.join(path)), read(&project.join(path)));
        if worker == now || now == start {
            continue;
        }
        let (Some(_), Some(start), Some(now)) = (worker, start, now) else {
            marked.push(path.clone());
            continue;
        };
        let target = checkout.join(path);
        let tag = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let b = std::env::temp_dir().join(format!("monocode-base-{}-{tag}", std::process::id()));
        let n = std::env::temp_dir().join(format!("monocode-now-{}-{tag}", std::process::id()));
        std::fs::write(&b, &start).map_err(|e| e.to_string())?;
        std::fs::write(&n, &now).map_err(|e| e.to_string())?;
        let out = Command::new("git")
            .arg("merge-file")
            .args([
                "-L",
                "your copy",
                "-L",
                "where you started",
                "-L",
                "the project now",
            ])
            .arg(&target)
            .arg(&b)
            .arg(&n)
            .output();
        let _ = std::fs::remove_file(&b);
        let _ = std::fs::remove_file(&n);
        let out = out.map_err(|e| e.to_string())?;
        if !out.status.success() {
            marked.push(path.clone());
        }
        let snapshot = kept.join(path);
        if let Some(dir) = snapshot.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&snapshot, &now).map_err(|e| e.to_string())?;
    }
    Ok(marked)
}

/// Bring a worker's copy up to date with its project after its changes clashed (see `refresh`).
#[tauri::command]
pub async fn refresh_worker_copy(checkout: String, project: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let checkout = crate::gates::worker_checkout(&checkout)?;
        let project = crate::fs::canonical(&project)
            .map_err(|_| "The project folder isn't there.".to_string())?;
        refresh(&checkout, &project)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put a finished worker's changes into its project (see the module note).
#[tauri::command]
pub async fn land_worker_copy(checkout: String, project: String) -> Result<Landing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let checkout = crate::gates::worker_checkout(&checkout)?;
        let project = crate::fs::canonical(&project)
            .map_err(|_| "The project folder isn't there.".to_string())?;
        let landing = land(&checkout, &project)?;
        // Hivra WP-10: a landing explains these files to the first mate's checkout guard.
        if landing.outcome == "landed" {
            crate::firstmate::checkout_guard::note_landing(&project, &landing.files);
        }
        Ok(landing)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo(name: &str) -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("monocode-land-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let project = root.join("tally");
        std::fs::create_dir_all(&project).unwrap();
        sh(&project, &["init", "-q"]);
        // The test compares bytes: keep a Windows runner's `core.autocrlf=true` from turning them into CRLF.
        sh(&project, &["config", "core.autocrlf", "false"]);
        sh(&project, &["config", "user.email", "t@example.com"]);
        sh(&project, &["config", "user.name", "t"]);
        std::fs::write(project.join("a.txt"), "one\n").unwrap();
        sh(&project, &["add", "."]);
        sh(&project, &["commit", "-qm", "start"]);
        let copy = root.join("tally-worktrees").join("mc-1");
        sh(
            &project,
            &["worktree", "add", "-q", "--detach", copy.to_str().unwrap()],
        );
        (
            crate::fs::canonical(project).unwrap(),
            crate::fs::canonical(copy).unwrap(),
        )
    }

    #[test]
    fn a_finished_copy_lands_its_edits_and_new_files_once() {
        let (project, copy) = repo("lands");
        std::fs::write(copy.join("a.txt"), "two\n").unwrap();
        std::fs::write(copy.join("new.txt"), "fresh\n").unwrap();
        let first = land(&copy, &project).unwrap();
        assert_eq!(first.outcome, "landed");
        assert_eq!(
            first.files,
            vec!["a.txt".to_string(), "new.txt".to_string()]
        );
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "two\n"
        );
        assert_eq!(
            std::fs::read_to_string(project.join("new.txt")).unwrap(),
            "fresh\n"
        );
        assert_eq!(land(&copy, &project).unwrap().outcome, "already");
        // The worker's own index is untouched: new.txt is still untracked there.
        let status = Command::new("git")
            .arg("-C")
            .arg(&copy)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&status.stdout).contains("?? new.txt"));
    }

    #[test]
    fn a_clash_changes_nothing_and_says_so() {
        let (project, copy) = repo("clash");
        std::fs::write(copy.join("a.txt"), "two\n").unwrap();
        std::fs::write(project.join("a.txt"), "three\n").unwrap();
        let landing = land(&copy, &project).unwrap();
        assert_eq!(landing.outcome, "conflict");
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "three\n"
        );
    }

    #[test]
    fn two_workers_in_one_file_both_land_when_their_lines_differ() {
        let (project, copy) = repo("merge");
        let lines = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
        std::fs::write(project.join("a.txt"), lines).unwrap();
        sh(&project, &["commit", "-qam", "lines"]);
        sh(&copy, &["checkout", "-q", "--detach", "HEAD"]);
        let main = String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(&project)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        sh(&copy, &["checkout", "-q", "--detach", main.trim()]);
        std::fs::write(project.join("a.txt"), lines.replace("2\n", "two\n")).unwrap();
        std::fs::write(copy.join("a.txt"), lines.replace("8\n", "eight\n")).unwrap();
        let landing = land(&copy, &project).unwrap();
        assert_eq!(landing.outcome, "landed");
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "1\ntwo\n3\n4\n5\n6\n7\neight\n9\n"
        );
    }

    #[test]
    fn a_clash_is_brought_into_the_copy_with_markers_and_then_lands() {
        let (project, copy) = repo("refresh");
        std::fs::write(copy.join("a.txt"), "two\n").unwrap();
        std::fs::write(project.join("a.txt"), "three\n").unwrap();
        assert_eq!(land(&copy, &project).unwrap().outcome, "conflict");
        assert_eq!(refresh(&copy, &project).unwrap(), vec!["a.txt".to_string()]);
        let marked = std::fs::read_to_string(copy.join("a.txt")).unwrap();
        assert!(marked.contains("<<<<<<< your copy") && marked.contains(">>>>>>> the project now"));
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "three\n"
        );
        // The worker settles it keeping both.
        std::fs::write(copy.join("a.txt"), "three\ntwo\n").unwrap();
        assert_eq!(land(&copy, &project).unwrap().outcome, "landed");
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "three\ntwo\n"
        );
    }

    #[test]
    fn a_refresh_brings_in_the_project_files_the_worker_left_alone() {
        // r86 (c02 r85 run 1): the copy got App.tsx calling weekTotals but not the format.ts defining it.
        let (project, copy) = repo("whole");
        std::fs::write(copy.join("a.txt"), "two\n").unwrap();
        std::fs::write(project.join("a.txt"), "three\n").unwrap();
        std::fs::write(project.join("format.txt"), "weekTotals\n").unwrap();
        assert_eq!(land(&copy, &project).unwrap().outcome, "conflict");
        assert_eq!(refresh(&copy, &project).unwrap(), vec!["a.txt".to_string()]);
        assert_eq!(
            std::fs::read_to_string(copy.join("format.txt")).unwrap(),
            "weekTotals\n"
        );
        // The project moves on in that file; the worker's landing doesn't take it back.
        std::fs::write(project.join("format.txt"), "weekTotals\nlastWeek\n").unwrap();
        std::fs::write(copy.join("a.txt"), "three\ntwo\n").unwrap();
        assert_eq!(land(&copy, &project).unwrap().outcome, "landed");
        assert_eq!(
            std::fs::read_to_string(project.join("format.txt")).unwrap(),
            "weekTotals\nlastWeek\n"
        );
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "three\ntwo\n"
        );
    }

    #[test]
    fn landings_into_one_file_at_once_both_get_in() {
        let (project, first) = repo("together");
        let lines = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
        std::fs::write(project.join("a.txt"), lines).unwrap();
        sh(&project, &["commit", "-qam", "lines"]);
        let head = git(&project, &["rev-parse", "HEAD"], None, None).unwrap().1;
        let head = String::from_utf8(head).unwrap();
        sh(&first, &["checkout", "-q", "--detach", head.trim()]);
        let second = project
            .parent()
            .unwrap()
            .join("tally-worktrees")
            .join("mc-2");
        sh(
            &project,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                second.to_str().unwrap(),
            ],
        );
        let second = crate::fs::canonical(second).unwrap();
        std::fs::write(first.join("a.txt"), lines.replace("2\n", "two\n")).unwrap();
        std::fs::write(second.join("a.txt"), lines.replace("8\n", "eight\n")).unwrap();
        let (p1, c1, p2, c2) = (
            project.clone(),
            first.clone(),
            project.clone(),
            second.clone(),
        );
        let a = std::thread::spawn(move || land(&c1, &p1).unwrap().outcome);
        let b = std::thread::spawn(move || land(&c2, &p2).unwrap().outcome);
        assert_eq!(
            (a.join().unwrap(), b.join().unwrap()),
            ("landed".to_string(), "landed".to_string())
        );
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "1\ntwo\n3\n4\n5\n6\n7\neight\n9\n"
        );
    }

    #[test]
    fn only_its_own_project() {
        let (project, copy) = repo("own");
        assert!(land(&copy, project.parent().unwrap()).is_err());
        assert!(land(&project, &project).is_err());
        assert_eq!(land(&copy, &project).unwrap().outcome, "nothing");
    }
}
