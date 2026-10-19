//! `.monocode/project.json`: a project's checked-in actions (Setup, Run, Check, Ship ...) and worktree settings.
//!
//! The format is general on purpose: any repository can carry one, and its actions become one-click buttons for Ash
//! and `actions.*` calls for a Lead (src/features/agent-app/model/agentApp.ts).
//!
//! Trust (docs/T3-HARVEST.md, "Project file"): the file is read only from the project's MAIN checkout, never from a
//! worktree, so a branch from elsewhere can't add commands. Nothing in it runs until Ash imports it once, in Settings >
//! Worktrees. The import stores the exact text he reviewed, and every run uses that stored copy: a later edit, or
//! another branch checked out in the main checkout, changes nothing until he imports again.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::fs::{expand_home, path_to_js};

/// Where the file lives, relative to the main checkout.
pub const PROJECT_FILE: &str = ".monocode/project.json";
const PROJECT_DIR: &str = ".monocode";
const MAX_FILE_BYTES: u64 = 64 * 1024;
const MAX_ACTIONS: usize = 24;
const MAX_BUILD_OUTPUT: usize = 20;
/// How long an action may run before it is stopped, unless it sets its own `timeoutSeconds`.
pub const DEFAULT_TIMEOUT_SECONDS: u64 = 15 * 60;
const MAX_TIMEOUT_SECONDS: u64 = 4 * 60 * 60;
/// Icons the app knows how to draw; anything else is refused so a typo shows at import.
pub const ICONS: &[&str] = &[
    "play", "setup", "check", "ship", "build", "test", "terminal", "clean",
];
/// The trust store, in the copy's own data folder (a dev copy never sees the daily app's imports).
const TRUST_FILE: &str = "project-files.json";

/// Build output the janitor may free when a project file names none. Each is deleted only if git ignores it and
/// tracks nothing inside it (src/worktree_janitor.rs).
pub const DEFAULT_BUILD_OUTPUT: &[&str] = &[
    "target",
    "node_modules",
    "dist",
    ".next",
    ".turbo",
    ".vite",
    "src-tauri/target",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFile {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// Format version. Only 1 exists.
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub actions: Vec<ProjectAction>,
    #[serde(default)]
    pub worktrees: WorktreeSettings,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAction {
    /// Stable name for `actions.run` (lowercase letters, digits and hyphens).
    pub id: String,
    /// Button label.
    pub name: String,
    /// Shell command, run in the chosen checkout with MONOCODE_PROJECT_ROOT and MONOCODE_WORKTREE_PATH set.
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Runs in every new worktree right after `git worktree add`. At most one action may set it.
    #[serde(default)]
    pub run_on_worktree_create: bool,
    /// With `runOnWorktreeCreate`: the chat's first turn waits for it (the default, unlike T3). `false` lets the
    /// agent start while it runs.
    #[serde(default = "default_hold")]
    pub hold: bool,
    /// Runs until stopped (a dev server): no timeout, and nothing waits for it.
    #[serde(default)]
    pub long_running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    /// Shown, and must be confirmed, before the app's button runs it (Ship).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
}

fn default_hold() -> bool {
    true
}

impl ProjectAction {
    pub fn timeout_seconds(&self) -> Option<u64> {
        (!self.long_running).then(|| self.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeSettings {
    /// Folders, relative to a checkout, that "Free build output" may delete. Git must ignore each one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub build_output: Vec<String>,
    /// Other ignored files a worktree may lose when it is removed (tool state that is recreated). Without them, an
    /// ignored file that isn't build output keeps the worktree.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regenerable: Vec<String>,
}

impl ProjectFile {
    pub fn setup_action(&self) -> Option<&ProjectAction> {
        self.actions
            .iter()
            .find(|action| action.run_on_worktree_create)
    }

    pub fn action(&self, id: &str) -> Option<&ProjectAction> {
        self.actions.iter().find(|action| action.id == id)
    }

    /// What the janitor may free in this project's checkouts.
    pub fn build_output(&self) -> Vec<String> {
        if self.worktrees.build_output.is_empty() {
            default_build_output()
        } else {
            self.worktrees.build_output.clone()
        }
    }
}

pub fn default_build_output() -> Vec<String> {
    DEFAULT_BUILD_OUTPUT.iter().map(|s| s.to_string()).collect()
}

fn bounded(value: &str, what: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{what} must not be empty"));
    }
    if value.chars().count() > max {
        return Err(format!("{what} must be at most {max} characters"));
    }
    Ok(())
}

fn single_line(value: &str, what: &str) -> Result<(), String> {
    if value.chars().any(char::is_control) {
        return Err(format!("{what} must be one line of plain text"));
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= 40
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A relative path that stays inside the checkout: no root, no `..`, no `.` tricks.
pub fn valid_relative_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 200 || path.contains('\\') || path.contains('\0') {
        return false;
    }
    // `components()` quietly drops a `.` in the middle, so check the raw segments too.
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return false;
    }
    let path = Path::new(path);
    !path.is_absolute() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

/// Parse and check a project file. Unknown fields are errors, so a typo never silently does nothing.
pub fn parse(text: &str) -> Result<ProjectFile, String> {
    let file: ProjectFile =
        serde_json::from_str(text).map_err(|error| format!("{PROJECT_FILE}: {error}"))?;
    validate(&file).map_err(|error| format!("{PROJECT_FILE}: {error}"))?;
    Ok(file)
}

pub fn validate(file: &ProjectFile) -> Result<(), String> {
    if file.version != 1 {
        return Err(format!(
            "version {} is not supported; this build reads version 1",
            file.version
        ));
    }
    if let Some(name) = &file.name {
        bounded(name, "name", 80)?;
        single_line(name, "name")?;
    }
    if file.actions.len() > MAX_ACTIONS {
        return Err(format!("at most {MAX_ACTIONS} actions are allowed"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut setup = None;
    for action in &file.actions {
        if !valid_id(&action.id) {
            return Err(format!(
                "action id {:?} must be 1-40 lowercase letters, digits or hyphens",
                action.id
            ));
        }
        if !seen.insert(action.id.as_str()) {
            return Err(format!("action id {:?} is used twice", action.id));
        }
        let what = format!("action {:?}", action.id);
        bounded(&action.name, &format!("{what} name"), 60)?;
        single_line(&action.name, &format!("{what} name"))?;
        bounded(&action.command, &format!("{what} command"), 4000)?;
        if action.command.contains('\0') {
            return Err(format!("{what} command contains a NUL character"));
        }
        if let Some(description) = &action.description {
            bounded(description, &format!("{what} description"), 300)?;
        }
        if let Some(icon) = &action.icon {
            if !ICONS.contains(&icon.as_str()) {
                return Err(format!(
                    "{what} icon {icon:?} is not one of {}",
                    ICONS.join(", ")
                ));
            }
        }
        if let Some(confirm) = &action.confirm {
            bounded(confirm, &format!("{what} confirm"), 300)?;
        }
        if let Some(timeout) = action.timeout_seconds {
            if action.long_running {
                return Err(format!(
                    "{what} is longRunning, so it can't have timeoutSeconds"
                ));
            }
            if timeout == 0 || timeout > MAX_TIMEOUT_SECONDS {
                return Err(format!(
                    "{what} timeoutSeconds must be from 1 to {MAX_TIMEOUT_SECONDS}"
                ));
            }
        }
        if action.run_on_worktree_create {
            if action.long_running {
                return Err(format!(
                    "{what} can't both run on worktree creation and be longRunning"
                ));
            }
            if let Some(other) = setup.replace(action.id.as_str()) {
                return Err(format!(
                    "only one action may set runOnWorktreeCreate ({other:?} and {:?} both do)",
                    action.id
                ));
            }
        }
    }
    if file.worktrees.build_output.len() > MAX_BUILD_OUTPUT {
        return Err(format!(
            "worktrees.buildOutput has more than {MAX_BUILD_OUTPUT} entries"
        ));
    }
    if file.worktrees.regenerable.len() > MAX_BUILD_OUTPUT {
        return Err(format!(
            "worktrees.regenerable has more than {MAX_BUILD_OUTPUT} entries"
        ));
    }
    for (field, paths) in [
        ("buildOutput", &file.worktrees.build_output),
        ("regenerable", &file.worktrees.regenerable),
    ] {
        for path in paths {
            if !valid_relative_path(path) {
                return Err(format!(
                    "worktrees.{field} entry {path:?} must be a plain relative path inside the checkout"
                ));
            }
        }
    }
    Ok(())
}

pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// ---- the main checkout ----------------------------------------------------------------------------------------------

/// The main checkout of the repository that `cwd` belongs to (a worktree resolves to its main checkout).
pub fn main_checkout(cwd: &Path) -> Result<PathBuf, String> {
    let trees = crate::worktrees::list(cwd)?;
    let main = trees.first().ok_or("No working copies found")?;
    let main = PathBuf::from(&main.path);
    // A bare repository's first entry has no checkout, so no project file to read.
    match std::fs::symlink_metadata(main.join(".git")) {
        Ok(_) => {}
        Err(_) => return Err("This repository has no main checkout".into()),
    }
    main.canonicalize().map_err(|error| error.to_string())
}

/// What the main checkout holds right now.
#[derive(Clone, Debug, PartialEq)]
pub enum FileState {
    Missing,
    Invalid {
        error: String,
        hash: Option<String>,
    },
    Valid {
        hash: String,
        text: String,
        file: ProjectFile,
    },
}

/// Read `<main>/.monocode/project.json`. Symbolic links are refused at both levels: the file must really be in the
/// main checkout.
pub fn read_main_file(main: &Path) -> FileState {
    let invalid = |error: String| FileState::Invalid { error, hash: None };
    let dir = main.join(PROJECT_DIR);
    match std::fs::symlink_metadata(&dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return FileState::Missing,
        Err(error) => return invalid(format!("{PROJECT_DIR}: {error}")),
        Ok(meta) if meta.file_type().is_symlink() => {
            return invalid(format!(
                "{PROJECT_DIR} is a symbolic link; the project file must be a real file in the main checkout"
            ))
        }
        Ok(meta) if !meta.is_dir() => return invalid(format!("{PROJECT_DIR} is not a folder")),
        Ok(_) => {}
    }
    let path = main.join(PROJECT_FILE);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return FileState::Missing,
        Err(error) => return invalid(format!("{PROJECT_FILE}: {error}")),
        Ok(meta) if meta.file_type().is_symlink() => {
            return invalid(format!(
                "{PROJECT_FILE} is a symbolic link; the project file must be a real file in the main checkout"
            ))
        }
        Ok(meta) if !meta.is_file() => return invalid(format!("{PROJECT_FILE} is not a file")),
        Ok(meta) if meta.len() > MAX_FILE_BYTES => {
            return invalid(format!(
                "{PROJECT_FILE} is larger than {} KB",
                MAX_FILE_BYTES / 1024
            ))
        }
        Ok(_) => {}
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => return invalid(format!("{PROJECT_FILE}: {error}")),
    };
    let digest = hash(&bytes);
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            return FileState::Invalid {
                error: format!("{PROJECT_FILE} is not UTF-8 text"),
                hash: Some(digest),
            }
        }
    };
    match parse(&text) {
        Ok(file) => FileState::Valid {
            hash: digest,
            text,
            file,
        },
        Err(error) => FileState::Invalid {
            error,
            hash: Some(digest),
        },
    }
}

// ---- trust ----------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trusted {
    pub hash: String,
    /// The exact text Ash imported. Runs parse this, never the file on disk.
    pub text: String,
    pub imported_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustStore {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    projects: BTreeMap<String, Trusted>,
}

fn trust_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TRUST_FILE)
}

fn load_store(data_dir: &Path) -> TrustStore {
    std::fs::read(trust_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_store(data_dir: &Path, store: &TrustStore) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let path = trust_path(data_dir);
    let temporary = data_dir.join(format!(".{TRUST_FILE}.{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

fn key(main: &Path) -> String {
    path_to_js(main)
}

pub fn trusted(data_dir: &Path, main: &Path) -> Option<Trusted> {
    load_store(data_dir).projects.remove(&key(main))
}

/// The actions that may run for this project: the imported copy, or nothing.
pub fn trusted_file(data_dir: &Path, main: &Path) -> Option<ProjectFile> {
    trusted(data_dir, main).and_then(|trusted| parse(&trusted.text).ok())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Import the main checkout's file, but only if it is still the one Ash reviewed (`expected_hash`).
pub fn import(data_dir: &Path, main: &Path, expected_hash: &str) -> Result<Trusted, String> {
    match read_main_file(main) {
        FileState::Valid { hash, text, .. } if hash == expected_hash => {
            let entry = Trusted {
                hash,
                text,
                imported_at: now_ms(),
            };
            let mut store = load_store(data_dir);
            store.version = 1;
            store.projects.insert(key(main), entry.clone());
            save_store(data_dir, &store)?;
            Ok(entry)
        }
        FileState::Valid { .. } => Err(format!(
            "{PROJECT_FILE} changed since you reviewed it. Review it again before importing."
        )),
        FileState::Invalid { error, .. } => Err(error),
        FileState::Missing => Err(format!("{PROJECT_FILE} is missing from the main checkout")),
    }
}

pub fn forget(data_dir: &Path, main: &Path) -> Result<(), String> {
    let mut store = load_store(data_dir);
    if store.projects.remove(&key(main)).is_some() {
        save_store(data_dir, &store)?;
    }
    Ok(())
}

// ---- status ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileStatus {
    /// The main checkout the file is read from.
    pub project_root: String,
    pub path: String,
    /// `none` (no file, nothing imported), `new` (a file that was never imported), `trusted` (the file is the
    /// imported one), `changed` (the file differs from, or lost, the imported one: the imported copy still runs),
    /// `invalid` (a broken file and nothing imported).
    pub state: &'static str,
    pub error: Option<String>,
    /// The file in the main checkout now, for review before an import.
    pub file_hash: Option<String>,
    pub file: Option<ProjectFile>,
    /// What runs.
    pub trusted_hash: Option<String>,
    pub trusted: Option<ProjectFile>,
    pub imported_at: Option<u64>,
}

pub fn status(data_dir: &Path, main: &Path) -> ProjectFileStatus {
    let current = read_main_file(main);
    let imported = trusted(data_dir, main);
    let imported_file = imported.as_ref().and_then(|t| parse(&t.text).ok());
    let (file_hash, file, error) = match &current {
        FileState::Missing => (None, None, None),
        FileState::Invalid { error, hash } => (hash.clone(), None, Some(error.clone())),
        FileState::Valid { hash, file, .. } => (Some(hash.clone()), Some(file.clone()), None),
    };
    let state = match (&current, &imported) {
        (FileState::Missing, None) => "none",
        (FileState::Valid { .. }, None) => "new",
        (FileState::Invalid { .. }, None) => "invalid",
        (FileState::Valid { hash, .. }, Some(t)) if *hash == t.hash => "trusted",
        (_, Some(_)) => "changed",
    };
    let error = match (&current, &imported) {
        (FileState::Missing, Some(_)) => Some(format!(
            "{PROJECT_FILE} is no longer in the main checkout; the imported copy still runs until you forget it"
        )),
        _ => error,
    };
    ProjectFileStatus {
        project_root: path_to_js(main),
        path: path_to_js(&main.join(PROJECT_FILE)),
        state,
        error,
        file_hash,
        file,
        trusted_hash: imported.as_ref().map(|t| t.hash.clone()),
        trusted: imported_file,
        imported_at: imported.map(|t| t.imported_at),
    }
}

pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn project_file_status(app: AppHandle, cwd: String) -> Result<ProjectFileStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let main = main_checkout(&expand_home(&cwd))?;
        Ok(status(&data_dir(&app)?, &main))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ash's explicit import, from Settings > Worktrees. Agents have no route to it.
#[tauri::command(async)]
pub async fn project_file_import(
    app: AppHandle,
    cwd: String,
    hash: String,
) -> Result<ProjectFileStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let main = main_checkout(&expand_home(&cwd))?;
        let data = data_dir(&app)?;
        import(&data, &main, &hash)?;
        Ok(status(&data, &main))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub async fn project_file_forget(app: AppHandle, cwd: String) -> Result<ProjectFileStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let main = main_checkout(&expand_home(&cwd))?;
        let data = data_dir(&app)?;
        forget(&data, &main)?;
        Ok(status(&data, &main))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fs::git_checked;

    pub(crate) struct Temp(pub PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub(crate) fn temp(prefix: &str) -> Temp {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Temp(dir.canonicalize().unwrap())
    }

    pub(crate) fn commit(root: &Path, message: &str) {
        git_checked(
            root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                message,
            ],
        )
        .unwrap();
    }

    /// A repository at `<dir>/repo` with one commit on main.
    pub(crate) fn repo(dir: &Path) -> PathBuf {
        let root = dir.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git_checked(&root, &["init", "-b", "main"]).unwrap();
        commit(&root, "initial");
        root
    }

    const GOOD: &str = r#"{
      "version": 1,
      "name": "Example",
      "actions": [
        {"id": "setup", "name": "Setup", "command": "node scripts/setup-worktree.mjs", "icon": "setup", "runOnWorktreeCreate": true},
        {"id": "dev", "name": "Run dev", "command": "npm run dev", "icon": "play", "longRunning": true},
        {"id": "check", "name": "Check", "command": "npm run check", "timeoutSeconds": 3600},
        {"id": "ship", "name": "Ship", "command": "npm run ship", "confirm": "Replace the daily app?"}
      ],
      "worktrees": {"buildOutput": ["target", "node_modules"]}
    }"#;

    #[test]
    fn parses_a_general_project_file() {
        let file = parse(GOOD).unwrap();
        assert_eq!(file.actions.len(), 4);
        let setup = file.setup_action().unwrap();
        assert_eq!(setup.id, "setup");
        assert!(setup.hold, "hold defaults to true");
        assert_eq!(setup.timeout_seconds(), Some(DEFAULT_TIMEOUT_SECONDS));
        assert_eq!(file.action("dev").unwrap().timeout_seconds(), None);
        assert_eq!(file.action("check").unwrap().timeout_seconds(), Some(3600));
        assert_eq!(file.build_output(), vec!["target", "node_modules"]);
        let minimal = parse(r#"{"version":1}"#).unwrap();
        assert!(minimal.actions.is_empty());
        assert_eq!(minimal.build_output(), default_build_output());
    }

    #[test]
    fn refuses_files_that_would_do_something_unexpected() {
        let cases = [
            (r#"{"version":2}"#, "version 2"),
            (r#"{"version":1,"scripts":[]}"#, "unknown field"),
            (
                r#"{"version":1,"actions":[{"id":"a","name":"A","command":"x","runOnCreate":true}]}"#,
                "unknown field",
            ),
            (
                r#"{"version":1,"actions":[{"id":"Setup","name":"A","command":"x"}]}"#,
                "lowercase",
            ),
            (
                r#"{"version":1,"actions":[{"id":"a","name":"A","command":"x"},{"id":"a","name":"B","command":"y"}]}"#,
                "used twice",
            ),
            (
                r#"{"version":1,"actions":[{"id":"a","name":"A","command":"  "}]}"#,
                "must not be empty",
            ),
            (
                r#"{"version":1,"actions":[{"id":"a","name":"A\nB","command":"x"}]}"#,
                "one line",
            ),
            (
                r#"{"version":1,"actions":[{"id":"a","name":"A","command":"x","icon":"rocket"}]}"#,
                "icon",
            ),
            (
                r#"{"version":1,"actions":[{"id":"a","name":"A","command":"x","runOnWorktreeCreate":true},{"id":"b","name":"B","command":"y","runOnWorktreeCreate":true}]}"#,
                "only one action",
            ),
            (
                r#"{"version":1,"actions":[{"id":"a","name":"A","command":"x","runOnWorktreeCreate":true,"longRunning":true}]}"#,
                "longRunning",
            ),
            (
                r#"{"version":1,"actions":[{"id":"a","name":"A","command":"x","timeoutSeconds":0}]}"#,
                "timeoutSeconds",
            ),
            (
                r#"{"version":1,"worktrees":{"buildOutput":["../elsewhere"]}}"#,
                "relative path",
            ),
            (
                r#"{"version":1,"worktrees":{"buildOutput":["/tmp"]}}"#,
                "relative path",
            ),
            (
                r#"{"version":1,"worktrees":{"regenerable":["../x"]}}"#,
                "worktrees.regenerable",
            ),
            ("not json", "project.json"),
        ];
        for (text, expected) in cases {
            let error = parse(text).unwrap_err();
            assert!(
                error.contains(expected),
                "{text}: expected {expected:?} in {error:?}"
            );
        }
    }

    #[test]
    fn this_repositorys_project_file_is_valid() {
        let file = parse(include_str!("../../.monocode/project.json")).unwrap();
        let ids: Vec<&str> = file.actions.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["setup", "dev", "check", "ship"]);
        let setup = file.setup_action().unwrap();
        assert_eq!(setup.command, "node scripts/setup-worktree.mjs");
        assert!(setup.hold);
        assert!(file.action("dev").unwrap().long_running);
        let ship = file.action("ship").unwrap();
        assert_eq!(ship.command, "npm run hub:ship");
        assert!(ship.confirm.is_some());
        assert_eq!(file.build_output(), vec!["target", "node_modules", "dist"]);
        assert_eq!(file.worktrees.regenerable, vec![".identity-baseline.json"]);
    }

    #[test]
    fn relative_paths_stay_inside_the_checkout() {
        assert!(valid_relative_path("target"));
        assert!(valid_relative_path("src-tauri/target"));
        for bad in ["", "..", "a/../b", "/abs", "./a", "a\\b", "a/./b"] {
            assert!(!valid_relative_path(bad), "{bad}");
        }
    }

    fn write_file(root: &Path, text: &str) {
        std::fs::create_dir_all(root.join(PROJECT_DIR)).unwrap();
        std::fs::write(root.join(PROJECT_FILE), text).unwrap();
    }

    #[test]
    fn reads_only_the_main_checkout_and_runs_only_the_imported_copy() {
        let temp = temp("monocode-project-file");
        let main = repo(&temp.0);
        let data = temp.0.join("data");
        // A worktree carries its own (hostile) file; the main checkout has the real one.
        let tree = temp.0.join("tree");
        git_checked(
            &main,
            &["worktree", "add", "-b", "feature", tree.to_str().unwrap()],
        )
        .unwrap();
        write_file(
            &tree,
            r#"{"version":1,"actions":[{"id":"evil","name":"Evil","command":"rm -rf ~"}]}"#,
        );
        assert_eq!(main_checkout(&tree).unwrap(), main);
        assert_eq!(
            read_main_file(&main_checkout(&tree).unwrap()),
            FileState::Missing
        );
        assert_eq!(status(&data, &main).state, "none");

        write_file(&main, GOOD);
        let first = status(&data, &main);
        assert_eq!(first.state, "new");
        assert!(
            trusted_file(&data, &main).is_none(),
            "nothing runs before an import"
        );
        let reviewed = first.file_hash.clone().unwrap();

        // The file changes between review and import: refused.
        write_file(
            &main,
            &GOOD.replace("npm run check", "npm run check && curl evil"),
        );
        assert!(import(&data, &main, &reviewed)
            .unwrap_err()
            .contains("changed since you reviewed"));
        write_file(&main, GOOD);
        import(&data, &main, &reviewed).unwrap();
        let imported = status(&data, &main);
        assert_eq!(imported.state, "trusted");
        assert_eq!(imported.trusted, Some(parse(GOOD).unwrap()));

        // A later edit (or another branch checked out in main) changes nothing until it is imported again.
        write_file(
            &main,
            &GOOD.replace("npm run check", "npm run check && curl evil"),
        );
        let changed = status(&data, &main);
        assert_eq!(changed.state, "changed");
        assert_eq!(
            trusted_file(&data, &main)
                .unwrap()
                .action("check")
                .unwrap()
                .command,
            "npm run check"
        );
        std::fs::remove_file(main.join(PROJECT_FILE)).unwrap();
        let removed = status(&data, &main);
        assert_eq!(removed.state, "changed");
        assert!(removed.error.unwrap().contains("no longer"));
        forget(&data, &main).unwrap();
        assert_eq!(status(&data, &main).state, "none");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_project_file_reached_through_a_symbolic_link() {
        let temp = temp("monocode-project-link");
        let main = repo(&temp.0);
        let outside = temp.0.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("project.json"), GOOD).unwrap();
        std::os::unix::fs::symlink(&outside, main.join(PROJECT_DIR)).unwrap();
        assert!(matches!(
            read_main_file(&main),
            FileState::Invalid { ref error, .. } if error.contains("symbolic link")
        ));
        std::fs::remove_file(main.join(PROJECT_DIR)).unwrap();
        std::fs::create_dir_all(main.join(PROJECT_DIR)).unwrap();
        std::os::unix::fs::symlink(outside.join("project.json"), main.join(PROJECT_FILE)).unwrap();
        assert!(matches!(
            read_main_file(&main),
            FileState::Invalid { ref error, .. } if error.contains("symbolic link")
        ));
        assert!(import(&temp.0.join("data"), &main, &hash(GOOD.as_bytes())).is_err());
    }
}
