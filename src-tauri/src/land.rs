//! r84 (c02 r83: four of five finished workers' changes stayed in their own copies; only the one the Lead re-did by hand
//! reached the project): when a delegated worker in its own checkout reports done, the app puts its changes into the
//! project. Everything it changed since its copy was made (commits and uncommitted work, new files too) goes in as one
//! patch, only if it applies cleanly; otherwise nothing changes and the Lead hears why. The worker's own index and copy
//! are never touched (a throwaway index is used), and nothing is committed in the project.

use std::path::{Path, PathBuf};

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

fn git_command(
    dir: &Path,
    args: &[&str],
    index: Option<&Path>,
) -> Result<std::process::Command, String> {
    // Repo hooks, including post-merge, stay off. This is the app's own merge, not Ash's pull. Ash's commit, push
    // and pull go through fs::git_cmd, which leaves the repo's hooks on.
    crate::git_cmd::ensure_contained(dir)?;
    let mut cmd = crate::git_cmd::git();
    cmd.arg("-C").arg(dir).args(args);
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    Ok(cmd)
}

fn git(
    dir: &Path,
    args: &[&str],
    index: Option<&Path>,
    stdin: Option<&[u8]>,
) -> Result<(bool, Vec<u8>, String), String> {
    use std::io::Write;
    let mut cmd = git_command(dir, args, index)?;
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

type StagedSide = (String, Option<Vec<u8>>);
type WorkerPatch = (Vec<u8>, Vec<String>, String, Vec<StagedSide>);

/// An index path a same-user process cannot plant ahead of time. The name is random and the file is created with
/// `create_new`, then removed so `read-tree` can write a real index. An empty file is not a valid index.
fn exclusive_index() -> Result<PathBuf, String> {
    for _ in 0..8 {
        let path = std::env::temp_dir().join(format!(
            "monocode-land-{}.index",
            uuid::Uuid::new_v4().simple()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => {
                std::fs::remove_file(&path).map_err(|error| error.to_string())?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("the landing index could not be created".into())
}

/// The worker's whole change against where its copy started, as a binary patch, and the files it touches.
fn worker_patch(checkout: &Path, project: &Path) -> Result<WorkerPatch, String> {
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
    let index = exclusive_index()?;
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
        // WP-200: one tree of this index. The file list, the patch and the staged blobs all come from that
        // tree, so a later write to the index cannot put bytes into the patch that the check did not read.
        // A textconv driver and the working tree must not supply bytes either.
        let (files, patch, staged) =
            crate::commit_guard::read_landing_index(checkout, &index, &base, project)?;
        Ok((patch, files, base.clone(), staged))
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// Hivra WP-12 (the teardown guard, src/delivery/teardown.rs): whether everything the worker changed is already in the
/// project, so removing its copy loses nothing. A change that is only partly there counts as not landed.
pub(crate) fn landed_in(checkout: &Path, project: &Path) -> Result<bool, String> {
    let (patch, _, _, _) = worker_patch(checkout, project)?;
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
    let (patch, files, base, staged) = worker_patch(checkout, project)?;
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
        return Ok(match merged(checkout, project, &base, &files, &staged)? {
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
    // A random name, made here: a folder or link planted under a predictable name is never used (#227 r9 review).
    let dir =
        std::env::temp_dir().join(format!("monocode-merge-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let (o, b, t) = (dir.join("ours"), dir.join("base"), dir.join("theirs"));
        std::fs::write(&o, ours).map_err(|e| e.to_string())?;
        std::fs::write(&b, base).map_err(|e| e.to_string())?;
        std::fs::write(&t, theirs).map_err(|e| e.to_string())?;
        let out = crate::git_cmd::git()
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
    staged: &[StagedSide],
) -> Result<Result<Writes, Vec<String>>, String> {
    let mut writes = Vec::new();
    let mut clashing = Vec::new();
    for path in files {
        let start = start_of(checkout, base, path)?;
        let worker = match staged.iter().find(|(name, _)| name == path) {
            Some((_, bytes)) => bytes.clone(),
            None => {
                return Err(
                    "the copy's staged file couldn't be read, so nothing was landed.".into(),
                )
            }
        };
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
    let (_, files, base, _) = worker_patch(checkout, project)?;
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
        let out = crate::git_cmd::git()
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
        let ok = crate::git_cmd::git()
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn the_apps_own_merge_leaves_repo_hooks_off() {
        // The arguments only. Running `git config` here would open the real ~/.gitconfig.
        let dir = std::env::temp_dir().join(format!("monocode-land-hooks-{}", std::process::id()));
        let cmd = git_command(&dir, &["merge", "HEAD"], None).unwrap();
        let args: Vec<String> = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.iter().any(|arg| arg == "core.hooksPath=/dev/null"),
            "{args:?}"
        );
        assert!(
            args.iter().any(|arg| arg == "core.fsmonitor=false"),
            "{args:?}"
        );
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
        let status = crate::git_cmd::git()
            .arg("-C")
            .arg(&copy)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&status.stdout).contains("?? new.txt"));
    }

    /// The scan, the patch and the staged blobs each read the index. A write between those reads must not
    /// land: the bytes that land are the bytes that were checked.
    #[test]
    fn an_index_rewritten_between_the_reads_cannot_land() {
        let (project, copy) = repo("split-index");
        std::fs::write(copy.join("a.txt"), "two\n").unwrap();
        let fired = std::rc::Rc::new(std::cell::Cell::new(false));
        let flag = std::rc::Rc::clone(&fired);
        let copy_for_hook = copy.clone();
        crate::commit_guard::set_landing_index_hook(Some(Box::new(move |index| {
            if flag.replace(true) {
                return;
            }
            let key = format!("sk-ant-{}", "Ab3dEf7h".repeat(4));
            std::fs::write(
                copy_for_hook.join("secret.txt"),
                format!("const KEY: &str = \"{key}\";\n"),
            )
            .unwrap();
            let added = Command::new("git")
                .arg("-C")
                .arg(&copy_for_hook)
                .env("GIT_INDEX_FILE", index)
                .args(["add", "--", "secret.txt"])
                .output()
                .unwrap();
            assert!(
                added.status.success(),
                "git add into the landing index: {}",
                String::from_utf8_lossy(&added.stderr)
            );
        })));
        struct ClearHook;
        impl Drop for ClearHook {
            fn drop(&mut self) {
                crate::commit_guard::set_landing_index_hook(None);
            }
        }
        let _clear = ClearHook;
        let landing = land(&copy, &project).expect("the checked change still lands");
        assert!(fired.get(), "the landing never read the index");
        assert_eq!(landing.outcome, "landed");
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "two\n"
        );
        assert!(
            !project.join("secret.txt").exists(),
            "bytes added to the index after the scan landed"
        );
        let _ = std::fs::remove_dir_all(project.parent().unwrap());
    }

    #[test]
    fn a_landing_leaves_a_predictable_index_name_untouched() {
        let (project, copy) = repo("index-name");
        std::fs::write(copy.join("a.txt"), "two\n").unwrap();
        let pid = std::process::id();
        let mut planted = Vec::new();
        for n in 0..8 {
            let path = std::env::temp_dir().join(format!("monocode-land-{pid}-{n}.index"));
            std::fs::write(&path, b"planted-secret").unwrap();
            planted.push(path);
        }
        let landing = land(&copy, &project).unwrap();
        assert_eq!(landing.outcome, "landed");
        for path in &planted {
            assert_eq!(
                std::fs::read(path).unwrap(),
                b"planted-secret",
                "the landing index used a predictable name"
            );
            let _ = std::fs::remove_file(path);
        }
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
            crate::git_cmd::git()
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
