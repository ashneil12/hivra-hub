//! Change the hub by talking (ash-day step 15): a Mono hands Ash's words to a Claude Code worker, which edits a
//! preview copy of the hub's own repository (a git worktree under `<app data>/hub-changes/<id>`, one commit per
//! separate change). Ash sees Now | Preview in the running hub, then Apply or Discard; each applied part can be
//! undone on its own.
//!
//! Two lanes, one rule (Ash 22 Oct: "it can improve itself n its ui yes but the core code is diff"): the app's own
//! look is changed here, in the app Ash runs; the engine is not. The core app stays protected here, not in a prompt: a
//! change that touches anything outside `src/` and `public/`, the engine (Rust, the provider and platform layer, the
//! chat engine, the hub's own store, its agent tools), settings, keys, the Monos list, start-up or this flow itself,
//! is refused with the area named in plain words and goes to the MonoCode Hub lead instead (a worktree, checks, a dev
//! copy, then Ship).
//!
//! Two ways a change reaches the app, because a dev copy and an installed bundle are different things ([`Delivery`]):
//! - A dev copy runs from its worktree under vite. Preview puts the change into that worktree uncommitted
//!   (`git apply`) and Now takes it out, so it shows at once; Apply cherry-picks it there.
//! - The installed app runs from a bundle whose frontend is compiled in, so nothing it does can hot-reload. Preview
//!   starts vite in the change's worktree and opens `hub-dev.html` in the browser: the changed screens with example
//!   data, in a page that can't strand the real window. Apply puts the commits on the checkout's own branch (the
//!   "main repo") and hands that commit to the existing ship path ([`crate::ship`], `npm run hub:ship`): checks, a
//!   build, a staged trial that commits or rolls itself back. Nothing reaches the installed app any other way. The
//!   browser is chosen over shipping a trial as the preview because it costs no build, touches no data Ash keeps, and
//!   a broken change can only break a page that closes with the browser.
//!
//! An in-place preview that breaks the window can't strand Ash: the window pings every few seconds while it previews,
//! and a watchdog takes the preview out after [`PING_TIMEOUT`] without one, also after a crash (`live.json`).

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const PING_TIMEOUT: Duration = Duration::from_secs(30);
const DIR: &str = "hub-changes";
const LIVE_FILE: &str = "live.json";
const SOURCE_FILE: &str = "hub-source.json";
const PREVIEW_FILE: &str = "preview.json";
const PREVIEW_PAGE: &str = "hub-dev.html";

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
    let mut command = crate::git_cmd::git();
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

/// How a change reaches the app. Decided by the copy making it, never by the worker.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    /// A dev copy: the change goes into the worktree it runs from and shows at once.
    #[default]
    InPlace,
    /// The installed app: previewed in the browser, delivered by a build and Ship.
    Rebuild,
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
    /// Older records (before the installed app could change itself) were all dev copies.
    #[serde(default)]
    pub delivery: Delivery,
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
    pub delivery: Delivery,
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
pub fn prepare_with(
    repo: &Path,
    dir: &Path,
    id: &str,
    delivery: Delivery,
) -> Result<Change, String> {
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
        delivery,
    };
    std::fs::write(
        record_path(dir, id),
        serde_json::to_string_pretty(&change).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(change)
}

/// The commits in `range`, oldest first, each with the files it touches.
fn commits(folder: &Path, range: &str) -> Result<Vec<ChangeCommit>, String> {
    let log = git(folder, &["log", "--reverse", "--format=%H%x1f%s", range])?;
    let mut made = Vec::new();
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
        made.push(ChangeCommit {
            sha: sha.into(),
            subject: subject.into(),
            files,
        });
    }
    Ok(made)
}

/// Every file a change may not touch, named once.
fn blocked(made: &[ChangeCommit]) -> Vec<Blocked> {
    let mut out = Vec::new();
    for commit in made {
        for path in &commit.files {
            if let Some(area) = protected_area(path) {
                if !out.iter().any(|b: &Blocked| &b.path == path) {
                    out.push(Blocked {
                        path: path.clone(),
                        area: area.into(),
                    });
                }
            }
        }
    }
    out
}

/// What the worker made: anything left uncommitted becomes one last commit, then each commit with its files, and
/// every file a change may not touch.
pub fn collect(change: &Change) -> Result<Collected, String> {
    let folder = Path::new(&change.folder);
    if !git(folder, &["status", "--porcelain"])?.trim().is_empty() {
        git(folder, &["add", "-A"])?;
        git(folder, &["commit", "-q", "-m", "Hub change"])?;
    }
    let made = commits(folder, &format!("{}..HEAD", change.base))?;
    Ok(Collected {
        delivery: change.delivery,
        blocked: blocked(&made),
        commits: made,
    })
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

/// A dev copy's Preview. On: the change goes into the running worktree, uncommitted. Off: it comes back out.
pub fn preview(change: &Change, dir: &Path, on: bool) -> Result<(), String> {
    let repo = Path::new(&change.repo);
    let patch = patch_path(dir, &change.id);
    if on {
        checked(change)?;
        let range = format!("{}..{}", change.base, change.branch);
        let diff = git(repo, &["diff", "--binary", &range])?;
        std::fs::write(&patch, diff).map_err(|e| e.to_string())?;
        let path = patch.to_string_lossy().into_owned();
        git(repo, &["apply", "--check", &path]).map_err(|_| {
            "The hub's own files moved since this preview was made, so it can't be shown. Ask for it again.".to_string()
        })?;
        git(repo, &["apply", &path])?;
    } else if patch.exists() {
        let path = patch.to_string_lossy().into_owned();
        if git(repo, &["apply", "-R", "--check", &path]).is_ok() {
            git(repo, &["apply", "-R", &path])?;
        }
        let _ = std::fs::remove_file(&patch);
    }
    Ok(())
}

/// A dev copy's Apply: each commit of the change goes into the running worktree (preview taken out first). Returns
/// the new commits, oldest first, so each can be undone on its own.
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

/// Put the change's commits on the checkout's own branch, after moving them onto its current tip. Nothing is
/// written when it can't (unsaved work, another branch checked out, a clash).
pub fn land(change: &Change) -> Result<Vec<ChangeCommit>, String> {
    let repo = Path::new(&change.repo);
    let folder = Path::new(&change.folder);
    if !git(repo, &["status", "--porcelain"])?.trim().is_empty() {
        return Err("The hub's own code folder has unsaved work, so a change can't go into it right now. Nothing changed; it can go in once that folder is tidy.".into());
    }
    let branch = git(repo, &["symbolic-ref", "--short", "HEAD"]).map_err(|_| {
        "The hub's own code folder isn't on a branch, so a change can't go into it. Nothing changed."
            .to_string()
    })?;
    let branch = branch.trim().to_string();
    let made = commits(folder, &format!("{}..HEAD", change.base))?;
    if let Some(first) = blocked(&made).first() {
        return Err(format!(
            "This change touches {}, which goes the Lead's way rather than in here. Nothing changed.",
            first.area
        ));
    }
    if made.is_empty() {
        return Err("The preview copy has no changes yet, so there's nothing to put in.".into());
    }
    let head = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    if change.base != head {
        if let Err(error) = git(folder, &["rebase", &head]) {
            let _ = git(folder, &["rebase", "--abort"]);
            return Err(format!(
                "The hub's own code moved since this change started and the two clash ({}). Nothing changed; ask for the change again.",
                error.lines().next().unwrap_or("conflict")
            ));
        }
    }
    if let Err(error) = git(repo, &["merge", "--ff-only", &change.branch]) {
        return Err(format!(
            "The change couldn't go into {branch} ({}). Nothing changed.",
            error.lines().next().unwrap_or("conflict")
        ));
    }
    commits(folder, &format!("{head}..HEAD"))
}

/// `npm run <script>` in the checkout, with the login shell's PATH (a GUI app starts with a short one).
fn npm(repo: &Path, script: &str) -> Result<(), String> {
    let path = crate::harness::cached_gui_search_path();
    let npm = std::env::split_paths(&path)
        .map(|dir| dir.join("npm"))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "npm isn't installed where the hub can find it.".to_string())?;
    let mut command = Command::new(npm);
    crate::hide_window_console(&mut command);
    let output = command
        .args(["run", script])
        .current_dir(repo)
        .env("PATH", &path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let tail: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .rev()
        .take(6)
        .collect();
    let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
    Err(if tail.is_empty() {
        format!("npm run {script} failed.")
    } else {
        tail
    })
}

/// Build and ship the checkout exactly as a Lead does, and wait for the ship's report. The commit is already in.
fn deliver(repo: &Path) -> Result<(), String> {
    npm(repo, "hub:check-all")
        .map_err(|e| format!("The checks didn't pass, so nothing was rebuilt: {e}"))?;
    npm(repo, "hub:build").map_err(|e| format!("The build failed, so nothing was rebuilt: {e}"))?;
    crate::ship::ship_start(
        repo.to_string_lossy().into_owned(),
        None,
        Some("wait".into()),
    )?;
    Ok(())
}

/// The installed app's Apply: the commits land in the checkout, then a build and Ship put them in the app.
fn apply_by_ship(change: &Change, dir: &Path) -> Result<Vec<ChangeCommit>, String> {
    checked(change)?;
    stop_preview(change, dir);
    let landed = land(change)?;
    if let Err(reason) = deliver(Path::new(&change.repo)) {
        return Err(format!(
            "{reason} The change is in the hub's own code ({}) and isn't lost; it just isn't in the app yet.",
            change.branch
        ));
    }
    Ok(landed)
}

/// Discard: preview gone, preview copy and its branch gone. The running hub is as it was.
pub fn discard(change: &Change, dir: &Path) -> Result<(), String> {
    if change.delivery == Delivery::InPlace {
        preview(change, dir, false)?;
    } else {
        stop_preview(change, dir);
    }
    let repo = Path::new(&change.repo);
    let _ = git(repo, &["worktree", "remove", "--force", &change.folder]);
    let _ = git(repo, &["branch", "-D", &change.branch]);
    let _ = std::fs::remove_file(record_path(dir, &change.id));
    Ok(())
}

/// Undo one applied commit, or redo it by reverting its undo: a new commit either way. Returns that commit.
pub fn revert(repo: &Path, sha: &str) -> Result<String, String> {
    valid_sha(sha)?;
    if !git(repo, &["status", "--porcelain"])?.trim().is_empty() {
        return Err("The hub's own code folder has unsaved work, so that can't be undone right now. Nothing changed.".into());
    }
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

// ---- whose code it is, and the browser preview -------------------------------------------------------------------

/// Where the hub's own code lives for this copy, and how a change got from it into the app.
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub repo: PathBuf,
    pub delivery: Delivery,
}

/// A checkout this app may change: this app, with the ship script a build goes through.
fn is_hub_checkout(path: &Path) -> bool {
    if !path.join(".git").exists() || !path.join("scripts/hub-ship.mjs").is_file() {
        return false;
    }
    let package = std::fs::read_to_string(path.join("package.json")).unwrap_or_default();
    let config =
        std::fs::read_to_string(path.join("src-tauri/tauri.conf.json")).unwrap_or_default();
    package.contains("\"monocode-desktop\"")
        && config.contains("\"com.ash.monocode-hub\"")
        && path.join("src/app").is_dir()
}

/// A dev copy's own worktree (the folder the bundle was built from).
fn dev_repo() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    root.join(".git").exists().then_some(root)
}

fn recorded_source(data: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(data.join(SOURCE_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(PathBuf::from(value.get("repo")?.as_str()?))
}

fn remember_source(data: &Path, repo: &Path) {
    if recorded_source(data).as_deref() == Some(repo) {
        return;
    }
    let value = serde_json::json!({ "repo": repo.to_string_lossy() });
    let _ = std::fs::write(data.join(SOURCE_FILE), value.to_string());
}

/// The checkout this copy changes itself in. The installed app is told where it is (`MONOCODE_HUB_REPO`, or the repo
/// it remembered last time) and otherwise looks beside the home folder it was started with. A copy started under a
/// temporary home (a test, a proof copy) passes `home: None`, so it never finds the real one that way.
pub fn source(
    kind: crate::instance::Kind,
    data: &Path,
    home: Option<&Path>,
    named: Option<PathBuf>,
) -> Result<Source, String> {
    if kind == crate::instance::Kind::Dev {
        return dev_repo()
            .map(|repo| Source {
                repo,
                delivery: Delivery::InPlace,
            })
            .ok_or_else(|| {
                "This dev copy has no code folder of its own, so it can't change itself."
                    .to_string()
            });
    }
    if let Some(named) = named {
        if is_hub_checkout(&named) {
            return Ok(Source {
                repo: named,
                delivery: Delivery::Rebuild,
            });
        }
        return Err(format!(
            "{} isn't a MonoCode Hub checkout, so there's nothing to change there. Point MONOCODE_HUB_REPO at one, or unset it.",
            named.display()
        ));
    }
    if let Some(recorded) = recorded_source(data) {
        if is_hub_checkout(&recorded) {
            return Ok(Source {
                repo: recorded,
                delivery: Delivery::Rebuild,
            });
        }
    }
    if let Some(home) = home {
        let beside = home.join("Projects/monocode-hub");
        if is_hub_checkout(&beside) {
            return Ok(Source {
                repo: beside,
                delivery: Delivery::Rebuild,
            });
        }
    }
    Err("The hub can't find its own code folder, so it can't change itself yet. It looks in ~/Projects/monocode-hub, or where MONOCODE_HUB_REPO points.".into())
}

fn source_here(app: &AppHandle) -> Result<Source, String> {
    let data = changes_dir(app)?;
    let named = std::env::var_os("MONOCODE_HUB_REPO").map(PathBuf::from);
    let home = if crate::instance::isolated_home().is_some() {
        None
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    };
    let source = source(crate::instance::kind(), &data, home.as_deref(), named)?;
    if source.delivery == Delivery::Rebuild {
        remember_source(&data, &source.repo);
    }
    Ok(source)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRun {
    id: String,
    pid: u32,
    port: u16,
    folder: String,
}

fn preview_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/{PREVIEW_PAGE}")
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("The preview couldn't start: {e}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|e| e.to_string())
}

/// vite in the change's worktree, in its own process group so the whole preview ends together.
fn vite(folder: &Path, port: u16) -> Result<Command, String> {
    let modules = folder.join("node_modules");
    let bin = modules.join(".bin/vite");
    let script = modules.join("vite/bin/vite.js");
    let mut command = if bin.exists() {
        Command::new(bin)
    } else if script.exists() {
        let node = std::env::split_paths(&crate::harness::cached_gui_search_path())
            .map(|dir| dir.join("node"))
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| {
                "Node isn't installed where the hub can find it, so a preview can't open."
                    .to_string()
            })?;
        let mut command = Command::new(node);
        command.arg(script);
        command
    } else {
        return Err("This change's copy has no packages installed, so its preview can't open. The copy needs npm install first.".into());
    };
    crate::hide_window_console(&mut command);
    command
        .arg("--port")
        .arg(port.to_string())
        .arg("--strictPort")
        .current_dir(folder)
        .env("VITE_MONOCODE_HUB", "1")
        .env("PATH", crate::harness::cached_gui_search_path())
        .stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    Ok(command)
}

fn wait_until_serving(port: u16, child: &mut Child, log: &Path) -> Result<(), String> {
    use std::net::{Ipv4Addr, SocketAddr};
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let limit = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let text = std::fs::read_to_string(log).unwrap_or_default();
            let tail = text
                .lines()
                .filter(|l| !l.trim().is_empty())
                .rev()
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" ");
            return Err(
                format!("The preview stopped before it opened ({status}). {tail}")
                    .trim()
                    .to_string(),
            );
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        if Instant::now() > limit {
            return Err("The preview didn't open in time. Nothing changed in your hub.".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// End the preview process only if it really is the vite for this folder (its own group, so its children go too).
#[cfg(unix)]
fn stop_process(pid: u32, folder: &Path) {
    let command = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default();
    let folder_name = folder.to_string_lossy().into_owned();
    if !command.contains(&folder_name) {
        return;
    }
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn stop_process(_pid: u32, _folder: &Path) {}

fn preview_record(dir: &Path) -> Option<PreviewRun> {
    let text = std::fs::read_to_string(dir.join(PREVIEW_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// The installed app's Preview: vite in the change's copy, the hub's dev page in the browser.
fn start_preview(change: &Change, dir: &Path) -> Result<String, String> {
    checked(change)?;
    stop_preview(change, dir);
    let folder = Path::new(&change.folder);
    let port = free_port()?;
    let log = dir.join(format!("{}.preview.log", change.id));
    let mut command = vite(folder, port)?;
    let log_file = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    command.stdout(Stdio::from(
        log_file.try_clone().map_err(|e| e.to_string())?,
    ));
    command.stderr(Stdio::from(log_file));
    let mut child = command
        .spawn()
        .map_err(|e| format!("The preview couldn't start: {e}"))?;
    if let Err(reason) = wait_until_serving(port, &mut child, &log) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(reason);
    }
    let record = PreviewRun {
        id: change.id.clone(),
        pid: child.id(),
        port,
        folder: change.folder.clone(),
    };
    std::fs::write(
        dir.join(PREVIEW_FILE),
        serde_json::to_string(&record).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let url = preview_url(port);
    if let Err(error) = open::that_detached(&url) {
        stop_process(child.id(), folder);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_file(dir.join(PREVIEW_FILE));
        return Err(format!(
            "The preview started but its page couldn't open: {error}"
        ));
    }
    // The preview runs until it's taken down; reap it so it can't linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(url)
}

fn stop_preview(change: &Change, dir: &Path) {
    let folder = Path::new(&change.folder);
    if let Some(record) = preview_record(dir) {
        if Path::new(&record.folder) == folder {
            stop_process(record.pid, folder);
        }
    }
    let _ = std::fs::remove_file(dir.join(PREVIEW_FILE));
}

/// A preview from a run that ended: the app that started it has closed, so it goes with it.
fn stop_stale(dir: &Path) {
    if let Some(record) = preview_record(dir) {
        stop_process(record.pid, Path::new(&record.folder));
        let _ = std::fs::remove_file(dir.join(PREVIEW_FILE));
    }
}

// ---- the app: the changes folder and the watchdog -----------------------------------------------------------------

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
            if change.delivery == Delivery::InPlace {
                let _ = preview(&change, &dir, false);
            }
        }
        set_live(&dir, None);
    }
}

/// At start-up: a preview left on by a crash is taken out after the timeout, unless the window picks it up again.
pub fn start(app: &AppHandle) {
    let Ok(dir) = changes_dir(app) else { return };
    stop_stale(&dir);
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
    let source = source_here(&app)?;
    let dir = changes_dir(&app)?;
    blocking(move || prepare_with(&source.repo, &dir, &id, source.delivery)).await
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
        match change.delivery {
            Delivery::InPlace => {
                preview(&change, &dir, on)?;
                set_live(&dir, on.then_some(id.as_str()));
            }
            Delivery::Rebuild if on => {
                start_preview(&change, &dir)?;
            }
            Delivery::Rebuild => stop_preview(&change, &dir),
        }
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

/// A change previewing right now, if any (a reloaded window picks it back up).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveView {
    pub id: String,
    pub delivery: Delivery,
}

#[tauri::command]
pub fn hub_change_live(app: AppHandle) -> Option<LiveView> {
    if let Some(id) = LIVE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|l| l.id.clone())
    {
        return Some(LiveView {
            id,
            delivery: Delivery::InPlace,
        });
    }
    let dir = changes_dir(&app).ok()?;
    preview_record(&dir).map(|record| LiveView {
        id: record.id,
        delivery: Delivery::Rebuild,
    })
}

#[tauri::command]
pub async fn hub_change_apply(app: AppHandle, id: String) -> Result<Vec<ChangeCommit>, String> {
    let dir = changes_dir(&app)?;
    blocking(move || {
        let change = load(&dir, &id)?;
        let applied = match change.delivery {
            Delivery::InPlace => apply(&change, &dir)?,
            Delivery::Rebuild => apply_by_ship(&change, &dir)?,
        };
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
pub async fn hub_change_revert(app: AppHandle, sha: String) -> Result<String, String> {
    let source = source_here(&app)?;
    blocking(move || match source.delivery {
        Delivery::InPlace => revert(&source.repo, &sha),
        Delivery::Rebuild => {
            let undone = revert(&source.repo, &sha)?;
            deliver(&source.repo).map_err(|reason| {
                format!("{reason} The undo is in the hub's own code ({undone}) and isn't lost; it just isn't in the app yet.")
            })?;
            Ok(undone)
        }
    })
    .await
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
        // Files are written here as LF; keep a Windows runner's `core.autocrlf=true` from reading them as changed.
        git(&repo, &["config", "core.autocrlf", "false"]).unwrap();
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

    /// A folder that passes for the hub's own checkout: identity, package name, ship script, source.
    fn checkout(root: &Path) -> PathBuf {
        let repo = root.join("Projects/monocode-hub");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]).unwrap();
        // Files are written here as LF; keep a Windows runner's `core.autocrlf=true` from reading them as changed.
        git(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        write(&repo, "package.json", "{\"name\":\"monocode-desktop\"}\n");
        write(
            &repo,
            "src-tauri/tauri.conf.json",
            "{\"identifier\":\"com.ash.monocode-hub\"}\n",
        );
        write(&repo, "scripts/hub-ship.mjs", "// ship\n");
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
        repo
    }

    fn commit(folder: &str, path: &str, text: &str, subject: &str) {
        let folder = Path::new(folder);
        write(folder, path, text);
        git(folder, &["add", "-A"]).unwrap();
        git(folder, &["commit", "-q", "-m", subject]).unwrap();
    }

    /// What a dev copy makes: its worktree is the one it runs from.
    fn in_place(repo: &Path, dir: &Path, id: &str) -> Result<Change, String> {
        prepare_with(repo, dir, id, Delivery::InPlace)
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
        let change = in_place(&repo, &dir, "c5").unwrap();
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
        let change = in_place(&repo, &dir, "c1").unwrap();
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
        let change = in_place(&repo, &dir, "c2").unwrap();
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
        let change = in_place(&repo, &dir, "c3").unwrap();
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
        let change = in_place(&repo, &dir, "c4").unwrap();
        assert!(preview(&change, &dir, true)
            .unwrap_err()
            .contains("no changes yet"));
    }

    #[test]
    fn the_watchdog_takes_out_a_preview_nobody_pings() {
        let (repo, dir) = hub();
        let change = in_place(&repo, &dir, "c5").unwrap();
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
        assert!(hub_change_live_placeholder().is_none());
        assert!(!dir.join(LIVE_FILE).exists());
    }

    /// `hub_change_live` needs a window; the watchdog's own state is what it reads first.
    fn hub_change_live_placeholder() -> Option<String> {
        LIVE.lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|l| l.id.clone())
    }

    #[test]
    fn ids_and_shas_are_checked() {
        let (repo, dir) = hub();
        assert!(in_place(&repo, &dir, "../x").is_err());
        assert!(revert(&repo, "HEAD~1").is_err());
        assert!(load(&dir, "missing").unwrap_err().contains("gone"));
    }

    // ---- the installed app: its own checkout, landing, and the browser preview --------------------------------------

    #[test]
    fn a_copy_finds_its_own_checkout_beside_its_home_and_tests_never_do() {
        let root = temp();
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let repo = checkout(&home);
        assert!(is_hub_checkout(&repo));

        let found = source(crate::instance::Kind::Daily, &data, Some(&home), None).unwrap();
        assert_eq!(
            found,
            Source {
                repo: repo.clone(),
                delivery: Delivery::Rebuild
            }
        );

        // A copy under a temporary home (a test, a proof) is given no home to look beside.
        assert!(source(crate::instance::Kind::Daily, &data, None, None).is_err());

        // Told where, or remembering where, it goes there.
        let elsewhere = checkout(&root);
        assert_eq!(
            source(
                crate::instance::Kind::Daily,
                &data,
                None,
                Some(elsewhere.clone())
            )
            .unwrap()
            .repo,
            elsewhere
        );
        let other_data = root.join("data2");
        std::fs::create_dir_all(&other_data).unwrap();
        remember_source(&other_data, &repo);
        assert_eq!(
            source(crate::instance::Kind::Daily, &other_data, None, None)
                .unwrap()
                .repo,
            repo
        );

        // A folder that isn't this app is refused, not changed.
        let stranger = elsewhere.with_file_name("stranger");
        std::fs::create_dir_all(&stranger).unwrap();
        write(&stranger, "package.json", "{\"name\":\"something-else\"}\n");
        write(&stranger, "scripts/hub-ship.mjs", "// ship\n");
        write(&stranger, "src/app/x.ts", "1\n");
        std::fs::create_dir_all(stranger.join(".git")).unwrap();
        assert!(!is_hub_checkout(&stranger));
        let err = source(
            crate::instance::Kind::Daily,
            &data,
            None,
            Some(stranger.clone()),
        )
        .unwrap_err();
        assert!(err.contains("isn't a MonoCode Hub checkout"), "{err}");
    }

    #[test]
    fn apply_in_the_installed_app_puts_the_change_on_the_checkouts_own_branch() {
        let root = temp();
        let repo = checkout(&root);
        let dir = root.join("changes");
        let change = prepare_with(&repo, &dir, "c7", Delivery::Rebuild).unwrap();
        assert_eq!(change.delivery, Delivery::Rebuild);
        commit(
            &change.folder,
            "src/app/shell/Sidebar.tsx",
            "export const Sidebar = 'short';\n",
            "Sidebar is shorter",
        );
        let landed = land(&change).unwrap();
        assert_eq!(landed.len(), 1);
        assert_eq!(landed[0].subject, "Sidebar is shorter");
        assert!(read(&repo, "src/app/shell/Sidebar.tsx").contains("short"));
        assert_eq!(
            git(&repo, &["rev-parse", "HEAD"]).unwrap().trim(),
            landed[0].sha
        );
        assert!(git(&repo, &["status", "--porcelain"])
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn landing_refuses_a_checkout_with_unsaved_work_and_changes_nothing() {
        let root = temp();
        let repo = checkout(&root);
        let dir = root.join("changes");
        let change = prepare_with(&repo, &dir, "c8", Delivery::Rebuild).unwrap();
        commit(
            &change.folder,
            "src/app/shell/Sidebar.tsx",
            "export const Sidebar = 'short';\n",
            "Sidebar is shorter",
        );
        write(&repo, "notes.txt", "unsaved\n");
        let err = land(&change).unwrap_err();
        assert!(err.contains("unsaved work"), "{err}");
        assert!(read(&repo, "src/app/shell/Sidebar.tsx").contains("long"));
    }

    #[test]
    fn a_change_made_before_the_hub_moved_goes_on_top_of_what_moved() {
        let root = temp();
        let repo = checkout(&root);
        let dir = root.join("changes");
        let change = prepare_with(&repo, &dir, "c9", Delivery::Rebuild).unwrap();
        commit(
            &change.folder,
            "src/app/shell/Sidebar.tsx",
            "export const Sidebar = 'short';\n",
            "Sidebar is shorter",
        );
        // The hub's own code moves on while the change is being made.
        commit(
            repo.to_str().unwrap(),
            "src/theme.css",
            ":root { --accent: green; }\n",
            "Green accent",
        );
        let landed = land(&change).unwrap();
        assert_eq!(landed.len(), 1);
        assert!(read(&repo, "src/theme.css").contains("green"));
        assert!(read(&repo, "src/app/shell/Sidebar.tsx").contains("short"));
        assert!(git(&repo, &["status", "--porcelain"])
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn the_installed_lane_still_refuses_the_engine_before_anything_lands() {
        let root = temp();
        let repo = checkout(&root);
        let dir = root.join("changes");
        let change = prepare_with(&repo, &dir, "c10", Delivery::Rebuild).unwrap();
        commit(
            &change.folder,
            "src/features/settings/Settings.tsx",
            "export const Settings = 2;\n",
            "Settings tweak",
        );
        let err = land(&change).unwrap_err();
        assert!(err.contains("goes the Lead's way"), "{err}");
        assert!(read(&repo, "src/features/settings/Settings.tsx").contains("= 1"));
    }

    #[test]
    fn the_installed_preview_opens_the_hubs_dev_page_and_says_when_it_cant() {
        assert_eq!(preview_url(5173), "http://127.0.0.1:5173/hub-dev.html");
        let root = temp();
        let repo = checkout(&root);
        let dir = root.join("changes");
        let change = prepare_with(&repo, &dir, "c11", Delivery::Rebuild).unwrap();
        commit(
            &change.folder,
            "src/theme.css",
            ":root { --accent: purple; }\n",
            "Accent",
        );
        // This copy has no packages, so vite can't start; the change itself is untouched and nothing is left behind.
        let err = start_preview(&change, &dir).unwrap_err();
        assert!(err.contains("no packages installed"), "{err}");
        assert!(!dir.join(PREVIEW_FILE).exists());
        assert!(read(&repo, "src/theme.css").contains("blue"));
    }
}
