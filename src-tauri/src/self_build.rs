//! Change the hub by talking (ash-day step 15): a Mono hands Ash's words to a Claude Code worker, which edits a
//! preview copy of the hub's own repository (a git worktree under `<app data>/hub-changes/<id>`, one commit per
//! separate change). Ash sees Now | Preview in the running hub, then Apply or Discard; each applied commit can be
//! undone on its own (a `git revert`).
//!
//! Only a dev copy changes itself: it runs from its worktree under vite, so a file change shows at once. The
//! installed daily app is a bundle and says so instead.
//!
//! Two lanes, one rule (Ash 22 Oct: "it can improve itself n its ui yes but the core code is diff"): the app's own
//! look is changed here, in the app; the engine is not. The core app stays protected here, not in a prompt: a change
//! that touches anything outside `src/` and `public/`, the engine (Rust, the provider and platform layer, the chat
//! engine, the hub's own store, its agent tools), settings, keys, the Monos list, start-up or this flow itself, is
//! refused with the area named in plain words and goes to the MonoCode Hub lead instead (a worktree, checks, a dev
//! copy, then Ship).
//!
//! Preview puts the change into the running worktree uncommitted (`git apply`) and Now takes it out (`git apply -R`).
//! A preview that breaks the window can't strand Ash: the window pings every few seconds while it previews, and a
//! watchdog takes the preview out after [`PING_TIMEOUT`] without one, also after a crash (`live.json`).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const PING_TIMEOUT: Duration = Duration::from_secs(30);
const DIR: &str = "hub-changes";
const LIVE_FILE: &str = "live.json";

/// Where a change may go, and the plain name of each protected area.
const ALLOWED_ROOTS: [&str; 2] = ["src/", "public/"];
const PROTECTED: [(&str, &str); 13] = [
    ("src/features/settings/", "Settings"),
    ("src/features/providers/", "keys and providers"),
    ("src/features/connections/", "keys and sign-ins"),
    ("src/features/monos/model/", "the Monos list"),
    ("src/features/hubChange/", "the way changes are made"),
    ("src/features/selfBuild/", "the way changes are made"),
    ("src/features/hub/model/botChanges.ts", "Bot changes"),
    ("src/main.tsx", "how the app starts"),
    // The engine: how it works rather than how it looks. These go the Lead's way, where they're built and checked.
    ("src/integrations/", "the app's engine"),
    ("src/platform/", "the app's engine"),
    ("src/features/agent-app/", "the app's own tools"),
    ("src/features/sessions/model/", "the chat engine"),
    ("src/features/hub/model/", "the hub's own store"),
];

/// Why a path can't be changed, or None when it may.
pub fn protected_area(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if [
        "keychain",
        "secret",
        "credential",
        "apikey",
        "api-key",
        "api_key",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        return Some("keys and sign-ins");
    }
    if let Some((_, area)) = PROTECTED
        .iter()
        .find(|(prefix, _)| path.starts_with(prefix))
    {
        return Some(area);
    }
    if !ALLOWED_ROOTS.iter().any(|root| path.starts_with(root)) {
        return Some("the app's engine and build");
    }
    None
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    let output = command
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=MonoCode Hub",
            "-c",
            "user.email=hub@monocode.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("PATH", crate::harness::cached_gui_search_path())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if err.is_empty() { out } else { err });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn valid_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 40
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        Ok(())
    } else {
        Err("A change id is a-z, 0-9 and dashes".into())
    }
}

fn valid_sha(sha: &str) -> Result<(), String> {
    if (7..=64).contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("That isn't a commit of a hub change".into())
    }
}

/// One change's record beside its worktree.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub repo: String,
    pub folder: String,
    pub branch: String,
    pub base: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeCommit {
    pub sha: String,
    pub subject: String,
    pub files: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Blocked {
    pub path: String,
    pub area: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Collected {
    pub commits: Vec<ChangeCommit>,
    pub blocked: Vec<Blocked>,
}

fn record_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

pub fn load(dir: &Path, id: &str) -> Result<Change, String> {
    valid_id(id)?;
    let text = std::fs::read_to_string(record_path(dir, id))
        .map_err(|_| "That hub change is gone.".to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// A preview copy of `repo` at its current commit, on its own branch.
pub fn prepare(repo: &Path, dir: &Path, id: &str) -> Result<Change, String> {
    valid_id(id)?;
    let repo = PathBuf::from(git(repo, &["rev-parse", "--show-toplevel"])?.trim());
    let base = git(&repo, &["rev-parse", "HEAD"])?.trim().to_string();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let folder = dir.join(id);
    let branch = format!("hub-change/{id}");
    if !folder.exists() {
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &folder.to_string_lossy(),
                &base,
            ],
        )?;
        // The worker can typecheck and test without an install (node_modules is ignored as a link too).
        let modules = repo.join("node_modules");
        if modules.exists() {
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(&modules, folder.join("node_modules"));
        }
    }
    let change = Change {
        id: id.into(),
        repo: repo.to_string_lossy().into_owned(),
        folder: folder.to_string_lossy().into_owned(),
        branch,
        base,
    };
    std::fs::write(
        record_path(dir, id),
        serde_json::to_string_pretty(&change).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(change)
}

/// What the worker made: anything left uncommitted becomes one last commit, then each commit with its files, and
/// every file a change may not touch.
pub fn collect(change: &Change) -> Result<Collected, String> {
    let folder = Path::new(&change.folder);
    if !git(folder, &["status", "--porcelain"])?.trim().is_empty() {
        git(folder, &["add", "-A"])?;
        git(folder, &["commit", "-q", "-m", "Hub change"])?;
    }
    let range = format!("{}..HEAD", change.base);
    let log = git(folder, &["log", "--reverse", "--format=%H%x1f%s", &range])?;
    let mut commits = Vec::new();
    let mut blocked = Vec::new();
    for line in log.lines().filter(|l| !l.trim().is_empty()) {
        let (sha, subject) = line.split_once('\u{1f}').unwrap_or((line, ""));
        let files: Vec<String> = git(
            folder,
            &[
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "--no-renames",
                "-r",
                sha,
            ],
        )?
        .lines()
        .map(str::to_string)
        .filter(|f| !f.is_empty())
        .collect();
        for path in &files {
            if let Some(area) = protected_area(path) {
                if !blocked.iter().any(|b: &Blocked| &b.path == path) {
                    blocked.push(Blocked {
                        path: path.clone(),
                        area: area.into(),
                    });
                }
            }
        }
        commits.push(ChangeCommit {
            sha: sha.into(),
            subject: subject.into(),
            files,
        });
    }
    Ok(Collected { commits, blocked })
}

fn checked(change: &Change) -> Result<Collected, String> {
    let collected = collect(change)?;
    if let Some(first) = collected.blocked.first() {
        return Err(format!(
            "This change touches {}, which goes the Lead's way rather than in here. Nothing changed: the MonoCode Hub lead makes it in a worktree, checks it, shows you a dev copy and ships it.",
            first.area
        ));
    }
    if collected.commits.is_empty() {
        return Err("The preview copy has no changes yet, so there's nothing to show.".into());
    }
    Ok(collected)
}

fn patch_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.patch"))
}

/// Preview on: the change goes into the running worktree, uncommitted. Off: it comes back out.
pub fn preview(change: &Change, dir: &Path, on: bool) -> Result<(), String> {
    let repo = Path::new(&change.repo);
    let patch = patch_path(dir, &change.id);
    if on {
        checked(change)?;
        let range = format!("{}..{}", change.base, change.branch);
        let diff = git(repo, &["diff", "--binary", &range])?;
        std::fs::write(&patch, diff).map_err(|e| e.to_string())?;
        let path = patch.to_string_lossy();
        git(repo, &["apply", "--check", &path]).map_err(|_| {
            "The hub's own files moved since this preview was made, so it can't be shown. Ask for it again.".to_string()
        })?;
        git(repo, &["apply", &path])?;
    } else if patch.exists() {
        let path = patch.to_string_lossy();
        if git(repo, &["apply", "-R", "--check", &path]).is_ok() {
            git(repo, &["apply", "-R", &path])?;
        }
        let _ = std::fs::remove_file(&patch);
    }
    Ok(())
}

/// Apply: each commit of the change goes into the running worktree (preview taken out first). Returns the new
/// commits, oldest first, so each can be undone on its own.
pub fn apply(change: &Change, dir: &Path) -> Result<Vec<ChangeCommit>, String> {
    let collected = checked(change)?;
    preview(change, dir, false)?;
    let repo = Path::new(&change.repo);
    let before = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    let range = format!("{}..{}", change.base, change.branch);
    if let Err(error) = git(repo, &["cherry-pick", "--allow-empty", &range]) {
        let _ = git(repo, &["cherry-pick", "--abort"]);
        return Err(format!(
            "It didn't go in: the hub's own files clash with it ({}). Nothing changed.",
            error.lines().next().unwrap_or("conflict")
        ));
    }
    let log = git(
        repo,
        &[
            "log",
            "--reverse",
            "--format=%H",
            &format!("{before}..HEAD"),
        ],
    )?;
    let shas: Vec<&str> = log.lines().filter(|l| !l.is_empty()).collect();
    Ok(shas
        .iter()
        .zip(collected.commits)
        .map(|(sha, c)| ChangeCommit {
            sha: (*sha).into(),
            ..c
        })
        .collect())
}

/// Discard: preview out, preview copy and its branch gone. The running hub is as it was.
pub fn discard(change: &Change, dir: &Path) -> Result<(), String> {
    preview(change, dir, false)?;
    let repo = Path::new(&change.repo);
    let _ = git(repo, &["worktree", "remove", "--force", &change.folder]);
    let _ = git(repo, &["branch", "-D", &change.branch]);
    let _ = std::fs::remove_file(record_path(dir, &change.id));
    Ok(())
}

/// Undo one applied commit, or redo it by reverting its undo: a new commit either way. Returns that commit.
pub fn revert(repo: &Path, sha: &str) -> Result<String, String> {
    valid_sha(sha)?;
    let files = git(
        repo,
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "--no-renames",
            "-r",
            sha,
        ],
    )?;
    if let Some(area) = files.lines().find_map(protected_area) {
        return Err(format!(
            "That commit touches {area}, so it isn't one of the hub's own changes."
        ));
    }
    if let Err(error) = git(repo, &["revert", "--no-edit", sha]) {
        let _ = git(repo, &["revert", "--abort"]);
        return Err(format!(
            "A later change sits on top of this one, so it can't be undone alone ({}). Undo that one first.",
            error.lines().next().unwrap_or("conflict")
        ));
    }
    Ok(git(repo, &["rev-parse", "HEAD"])?.trim().to_string())
}

// ---- the app: which repo, the watchdog ---------------------------------------------------------------------------------

/// The repo this copy runs from: a dev copy's own worktree, or None for the installed app.
fn own_repo() -> Option<PathBuf> {
    if crate::instance::kind() != crate::instance::Kind::Dev {
        return None;
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    root.join(".git").exists().then_some(root)
}

const INSTALLED: &str = "This is your installed hub, so it can't change itself here. A change to the app goes to the MonoCode Hub lead, who builds it in a worktree, shows you a dev copy and ships it when you say so.";

fn changes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(DIR))
}

struct Live {
    dir: PathBuf,
    id: String,
    pinged: Instant,
}
static LIVE: Mutex<Option<Live>> = Mutex::new(None);

fn set_live(dir: &Path, id: Option<&str>) {
    let mut live = LIVE.lock().unwrap_or_else(|e| e.into_inner());
    match id {
        Some(id) => {
            *live = Some(Live {
                dir: dir.into(),
                id: id.into(),
                pinged: Instant::now(),
            });
            let _ = std::fs::write(dir.join(LIVE_FILE), id);
        }
        None => {
            *live = None;
            let _ = std::fs::remove_file(dir.join(LIVE_FILE));
        }
    }
}

/// Take a preview out that nobody is looking at: the window stopped pinging, or the app went down with it on.
fn watchdog_tick(timeout: Duration) {
    let stale = {
        let live = LIVE.lock().unwrap_or_else(|e| e.into_inner());
        live.as_ref()
            .filter(|l| l.pinged.elapsed() > timeout)
            .map(|l| (l.dir.clone(), l.id.clone()))
    };
    if let Some((dir, id)) = stale {
        if let Ok(change) = load(&dir, &id) {
            let _ = preview(&change, &dir, false);
        }
        set_live(&dir, None);
    }
}

/// At start-up: a preview left on by a crash is taken out after the timeout, unless the window picks it up again.
pub fn start(app: &AppHandle) {
    let Ok(dir) = changes_dir(app) else { return };
    if let Ok(id) = std::fs::read_to_string(dir.join(LIVE_FILE)) {
        set_live(&dir, Some(id.trim()));
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(5));
        watchdog_tick(PING_TIMEOUT);
    });
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn hub_change_prepare(app: AppHandle, id: String) -> Result<Change, String> {
    let repo = own_repo().ok_or_else(|| INSTALLED.to_string())?;
    let dir = changes_dir(&app)?;
    blocking(move || prepare(&repo, &dir, &id)).await
}

#[tauri::command]
pub async fn hub_change_collect(app: AppHandle, id: String) -> Result<Collected, String> {
    let dir = changes_dir(&app)?;
    blocking(move || collect(&load(&dir, &id)?)).await
}

#[tauri::command]
pub async fn hub_change_preview(app: AppHandle, id: String, on: bool) -> Result<(), String> {
    let dir = changes_dir(&app)?;
    blocking(move || {
        let change = load(&dir, &id)?;
        preview(&change, &dir, on)?;
        set_live(&dir, on.then_some(id.as_str()));
        Ok(())
    })
    .await
}

/// The window is still there and still previewing.
#[tauri::command]
pub fn hub_change_ping() {
    if let Some(live) = LIVE.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        live.pinged = Instant::now();
    }
}

/// The change being previewed right now, if any (a reloaded window picks it back up).
#[tauri::command]
pub fn hub_change_live() -> Option<String> {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|l| l.id.clone())
}

#[tauri::command]
pub async fn hub_change_apply(app: AppHandle, id: String) -> Result<Vec<ChangeCommit>, String> {
    let dir = changes_dir(&app)?;
    blocking(move || {
        let change = load(&dir, &id)?;
        let applied = apply(&change, &dir)?;
        set_live(&dir, None);
        let _ = discard(&change, &dir);
        Ok(applied)
    })
    .await
}

#[tauri::command]
pub async fn hub_change_discard(app: AppHandle, id: String) -> Result<(), String> {
    let dir = changes_dir(&app)?;
    blocking(move || {
        let change = load(&dir, &id)?;
        discard(&change, &dir)?;
        set_live(&dir, None);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn hub_change_revert(sha: String) -> Result<String, String> {
    let repo = own_repo().ok_or_else(|| INSTALLED.to_string())?;
    blocking(move || revert(&repo, &sha)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("monocode-selfbuild-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, path: &str, text: &str) {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn read(dir: &Path, path: &str) -> String {
        std::fs::read_to_string(dir.join(path)).unwrap()
    }

    /// A hub repo with a sidebar and a theme, and the changes folder beside it.
    fn hub() -> (PathBuf, PathBuf) {
        let root = temp();
        let repo = root.join("hub");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]).unwrap();
        write(
            &repo,
            "src/app/shell/Sidebar.tsx",
            "export const Sidebar = 'long';\n",
        );
        write(&repo, "src/theme.css", ":root { --accent: blue; }\n");
        write(
            &repo,
            "src/features/settings/Settings.tsx",
            "export const Settings = 1;\n",
        );
        git(&repo, &["add", "-A"]).unwrap();
        git(&repo, &["commit", "-q", "-m", "hub"]).unwrap();
        (repo, root.join("changes"))
    }

    fn commit(folder: &str, path: &str, text: &str, subject: &str) {
        let folder = Path::new(folder);
        write(folder, path, text);
        git(folder, &["add", "-A"]).unwrap();
        git(folder, &["commit", "-q", "-m", subject]).unwrap();
    }

    #[test]
    fn protected_areas_are_named_and_the_rest_may_change() {
        assert_eq!(protected_area("src/app/shell/Sidebar.tsx"), None);
        assert_eq!(protected_area("src/index.css"), None);
        assert_eq!(protected_area("public/logo.png"), None);
        assert_eq!(
            protected_area("src/features/settings/Keys.tsx"),
            Some("Settings")
        );
        assert_eq!(
            protected_area("src/features/monos/model/mono.ts"),
            Some("the Monos list")
        );
        assert_eq!(
            protected_area("src/app/keychainBridge.ts"),
            Some("keys and sign-ins")
        );
        assert_eq!(
            protected_area("src-tauri/src/lib.rs"),
            Some("the app's engine and build")
        );
        assert_eq!(
            protected_area("package.json"),
            Some("the app's engine and build")
        );
        assert_eq!(
            protected_area("src/features/selfBuild/model/hubCodeChange.ts"),
            Some("the way changes are made")
        );
    }

    /// Ash 22 Oct: the app may change its own look; its engine goes the Lead's way (a worktree, checks, then Ship).
    #[test]
    fn the_engine_is_the_leads_way_not_the_in_app_lane() {
        for (path, area) in [
            ("src/integrations/harness/core/child.ts", "the app's engine"),
            ("src/platform/desktop.ts", "the app's engine"),
            (
                "src/features/agent-app/model/agentApp.ts",
                "the app's own tools",
            ),
            ("src/features/sessions/model/session.ts", "the chat engine"),
            ("src/features/hub/model/hubStore.ts", "the hub's own store"),
            ("src-tauri/src/lib.rs", "the app's engine and build"),
            ("package.json", "the app's engine and build"),
        ] {
            assert_eq!(protected_area(path), Some(area), "{path}");
        }
        // The look stays in the app, next to the engine it sits on.
        assert_eq!(
            protected_area("src/features/sessions/ui/Composer.tsx"),
            None
        );
        assert_eq!(protected_area("src/features/hub/ui/Today.tsx"), None);
        assert_eq!(protected_area("src/app/shell/Sidebar.tsx"), None);
        assert_eq!(protected_area("src/styles/theme.css"), None);
    }

    #[test]
    fn an_engine_change_is_turned_away_towards_the_lead() {
        let (repo, dir) = hub();
        commit(
            repo.to_str().unwrap(),
            "src/integrations/harness/core/child.ts",
            "export {};\n",
            "engine",
        );
        let change = prepare(&repo, &dir, "c5").unwrap();
        commit(
            &change.folder,
            "src/integrations/harness/core/child.ts",
            "export const spawn = 'elsewhere';\n",
            "Spawn chats differently",
        );
        let got = collect(&change).unwrap();
        assert_eq!(got.blocked[0].area, "the app's engine");
        let err = preview(&change, &dir, true).unwrap_err();
        assert!(err.contains("goes the Lead's way"), "{err}");
        assert!(read(&repo, "src/integrations/harness/core/child.ts").contains("export {}"));
    }

    #[test]
    fn preview_shows_the_change_now_takes_it_out_and_discard_leaves_nothing() {
        let (repo, dir) = hub();
        let change = prepare(&repo, &dir, "c1").unwrap();
        commit(
            &change.folder,
            "src/theme.css",
            ":root { --accent: purple; }\n",
            "Accent is more purple",
        );
        preview(&change, &dir, true).unwrap();
        assert!(read(&repo, "src/theme.css").contains("purple"));
        preview(&change, &dir, false).unwrap();
        assert!(read(&repo, "src/theme.css").contains("blue"));
        preview(&change, &dir, true).unwrap();
        discard(&change, &dir).unwrap();
        assert!(read(&repo, "src/theme.css").contains("blue"));
        assert!(git(&repo, &["status", "--porcelain"])
            .unwrap()
            .trim()
            .is_empty());
        assert!(!Path::new(&change.folder).exists());
        assert!(git(&repo, &["branch", "--list", "hub-change/c1"])
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn apply_keeps_each_part_and_undo_takes_out_only_that_part() {
        let (repo, dir) = hub();
        let change = prepare(&repo, &dir, "c2").unwrap();
        commit(
            &change.folder,
            "src/app/shell/Sidebar.tsx",
            "export const Sidebar = 'collapsible';\n",
            "Monos area folds away",
        );
        // Left uncommitted by the worker: collected as one last commit.
        write(
            Path::new(&change.folder),
            "src/theme.css",
            ":root { --accent: purple; }\n",
        );
        let got = collect(&change).unwrap();
        assert_eq!(got.commits.len(), 2);
        assert!(got.blocked.is_empty());
        preview(&change, &dir, true).unwrap();
        let applied = apply(&change, &dir).unwrap();
        assert_eq!(applied.len(), 2);
        assert_eq!(applied[0].subject, "Monos area folds away");
        assert_eq!(applied[1].files, vec!["src/theme.css".to_string()]);
        assert!(read(&repo, "src/app/shell/Sidebar.tsx").contains("collapsible"));
        assert!(read(&repo, "src/theme.css").contains("purple"));
        // "undo that colour": only the colour goes back.
        let undo = revert(&repo, &applied[1].sha).unwrap();
        assert!(read(&repo, "src/theme.css").contains("blue"));
        assert!(read(&repo, "src/app/shell/Sidebar.tsx").contains("collapsible"));
        // Redo is the undo's own revert.
        revert(&repo, &undo).unwrap();
        assert!(read(&repo, "src/theme.css").contains("purple"));
        assert!(git(&repo, &["status", "--porcelain"])
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn a_change_to_a_protected_area_is_refused_in_plain_words_and_nothing_moves() {
        let (repo, dir) = hub();
        let change = prepare(&repo, &dir, "c3").unwrap();
        commit(
            &change.folder,
            "src/features/settings/Settings.tsx",
            "export const Settings = 2;\n",
            "Settings tweak",
        );
        let got = collect(&change).unwrap();
        assert_eq!(got.blocked[0].area, "Settings");
        let err = preview(&change, &dir, true).unwrap_err();
        assert!(
            err.contains("touches Settings, which goes the Lead's way"),
            "{err}"
        );
        assert!(apply(&change, &dir).is_err());
        assert!(read(&repo, "src/features/settings/Settings.tsx").contains("= 1"));
        assert!(git(&repo, &["status", "--porcelain"])
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn an_empty_preview_says_so() {
        let (repo, dir) = hub();
        let change = prepare(&repo, &dir, "c4").unwrap();
        assert!(preview(&change, &dir, true)
            .unwrap_err()
            .contains("no changes yet"));
    }

    #[test]
    fn the_watchdog_takes_out_a_preview_nobody_pings() {
        let (repo, dir) = hub();
        let change = prepare(&repo, &dir, "c5").unwrap();
        commit(
            &change.folder,
            "src/theme.css",
            ":root { --accent: purple; }\n",
            "Accent",
        );
        preview(&change, &dir, true).unwrap();
        set_live(&dir, Some("c5"));
        watchdog_tick(Duration::from_secs(3600));
        assert!(
            read(&repo, "src/theme.css").contains("purple"),
            "still pinged recently"
        );
        watchdog_tick(Duration::ZERO);
        assert!(read(&repo, "src/theme.css").contains("blue"));
        assert!(hub_change_live().is_none());
        assert!(!dir.join(LIVE_FILE).exists());
    }

    #[test]
    fn ids_and_shas_are_checked() {
        let (repo, dir) = hub();
        assert!(prepare(&repo, &dir, "../x").is_err());
        assert!(revert(&repo, "HEAD~1").is_err());
        assert!(load(&dir, "missing").unwrap_err().contains("gone"));
    }
}
