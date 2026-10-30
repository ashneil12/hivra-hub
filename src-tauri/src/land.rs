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
fn worker_patch(checkout: &Path, project: &Path) -> Result<(Vec<u8>, Vec<String>), String> {
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
        let (ok, _, why) = git(checkout, &["add", "-A", "."], Some(&index), None)?;
        if !ok {
            return Err(format!("the copy's changes couldn't be gathered: {why}"));
        }
        let (_, names, _) = git(
            checkout,
            &["diff", "--cached", "--name-only", &base],
            Some(&index),
            None,
        )?;
        let (ok, patch, why) = git(
            checkout,
            &["diff", "--cached", "--binary", &base],
            Some(&index),
            None,
        )?;
        if !ok {
            return Err(format!("the copy's change couldn't be written out: {why}"));
        }
        let files = String::from_utf8_lossy(&names)
            .lines()
            .map(str::to_string)
            .filter(|l| !l.is_empty())
            .collect();
        Ok((patch, files))
    })();
    let _ = std::fs::remove_file(&index);
    result
}

pub(crate) fn land(checkout: &Path, project: &Path) -> Result<Landing, String> {
    if !project_of(checkout, project) {
        return Err("Only a worker's own copy of this project lands in it.".into());
    }
    let (patch, files) = worker_patch(checkout, project)?;
    if patch.is_empty() {
        return Ok(Landing {
            outcome: "nothing".into(),
            files,
            why: "the worker changed no files".into(),
        });
    }
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
        return Ok(Landing {
            outcome: "conflict".into(),
            files,
            why: crate::gates::tail(&why, 600),
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

/// Put a finished worker's changes into its project (see the module note).
#[tauri::command]
pub async fn land_worker_copy(checkout: String, project: String) -> Result<Landing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let checkout = crate::gates::worker_checkout(&checkout)?;
        let project = std::fs::canonicalize(&project)
            .map_err(|_| "The project folder isn't there.".to_string())?;
        land(&checkout, &project)
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
            std::fs::canonicalize(project).unwrap(),
            std::fs::canonicalize(copy).unwrap(),
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
    fn only_its_own_project() {
        let (project, copy) = repo("own");
        assert!(land(&copy, project.parent().unwrap()).is_err());
        assert!(land(&project, &project).is_err());
        assert_eq!(land(&copy, &project).unwrap().outcome, "nothing");
    }
}
