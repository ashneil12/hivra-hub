//! The verify stage (I2): before a turn or a Lead says user-visible work is done, run what the project itself says
//! proves a change — its own checks for the folders that changed, and a real-path recipe for anything Ash would see —
//! and record the verdict the claim can cite.
//!
//! Honest by construction: a step that could not run is recorded as `couldNotExercise` or `notRun` and never folded
//! into a pass. Only steps that actually ran and passed can make the whole verdict `passed`.
//!
//! The recipe comes from `.monocode/project.json` (project_file.rs), so it is bounded by the same trust rule as the
//! action buttons: nothing runs until Ash imports the file, and only the imported text is ever run. Commands go
//! through the action runner (project_actions.rs) for its process group, timeout, log and credential scrub.
//!
//! Records live in `~/.monocode-hub-verify` (MONOCODE_VERIFY_DIR overrides it, and it follows HOME, so a dev copy
//! under a temporary HOME writes there), shared with `scripts/hub-harsh.mjs` and `scripts/hub-bench.mjs`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::fs::{expand_home, path_to_js};
use crate::project_actions::{self, ActionRuns};
use crate::project_file::{self, ProjectAction, VerifySettings};

/// Files that mark a folder as a project of its own, for deciding which folder a change belongs to.
const MARKERS: [&str; 4] = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"];
/// The environment variable a real-path recipe must write its verdict to.
const VERDICT_ENV: &str = "MONOCODE_VERIFY_VERDICT";
const MAX_DETAIL_CHARS: usize = 1200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Everything that could run ran, and passed.
    Passed,
    /// Something ran and failed.
    Failed,
    /// The stage or the recipe could not exercise the change at all (a prerequisite is missing). Never a pass.
    CouldNotExercise,
    /// Nothing ran: no recipe, nothing changed, or no checks declared for the folder that changed.
    NotRun,
}

impl Outcome {
    fn as_word(self) -> &'static str {
        match self {
            Outcome::Passed => "passed",
            Outcome::Failed => "failed",
            Outcome::CouldNotExercise => "couldn't be exercised",
            Outcome::NotRun => "not run",
        }
    }
}

/// One line of the verdict: a check, the real path, or the reason nothing ran for it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    /// `check` or `realPath`.
    pub kind: String,
    pub id: String,
    pub name: String,
    pub outcome: Outcome,
    /// Plain English: what ran, or why it couldn't.
    pub detail: String,
    pub run_id: Option<String>,
    pub log_path: Option<String>,
    pub seconds: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRecord {
    pub id: String,
    pub project_root: String,
    pub checkout: String,
    pub started_at: u64,
    pub ended_at: u64,
    pub outcome: Outcome,
    /// One plain line naming what ran and what could not.
    pub summary: String,
    pub steps: Vec<StepResult>,
    /// Folders the change touched that this project declares no checks for.
    pub gaps: Vec<String>,
    pub changed_files: Vec<String>,
}

impl VerifyRecord {
    /// Any failure fails the whole verdict; otherwise a step that could not run is reported as such; otherwise a
    /// step that ran and passed makes it a pass; nothing ran at all is "not run".
    pub fn aggregate(steps: &[StepResult]) -> Outcome {
        if steps.iter().any(|s| s.outcome == Outcome::Failed) {
            Outcome::Failed
        } else if steps.iter().any(|s| s.outcome == Outcome::CouldNotExercise) {
            Outcome::CouldNotExercise
        } else if steps.iter().any(|s| s.outcome == Outcome::Passed) {
            Outcome::Passed
        } else {
            Outcome::NotRun
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyStatus {
    pub project_root: String,
    pub checkout: String,
    /// The project file is imported, so its recipe may run.
    pub imported: bool,
    pub verify: VerifySettings,
    /// Why nothing can run, when that is the case.
    pub note: Option<String>,
    pub latest: Option<VerifyRecord>,
}

/// `~/.monocode-hub-verify`, or MONOCODE_VERIFY_DIR. Follows HOME, so a copy under a temporary HOME writes there.
pub fn records_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("MONOCODE_VERIFY_DIR") {
        return PathBuf::from(dir);
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".monocode-hub-verify")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn truncate(text: &str) -> String {
    let text = text.trim();
    let mut out: String = text.chars().take(MAX_DETAIL_CHARS).collect();
    if out.len() < text.len() {
        out.push('…');
    }
    out
}

// ---- what changed ---------------------------------------------------------------------------------------------------

/// What changed in a checkout: the turn's own paths when it named them, else everything git sees as changed.
pub fn changed_files(checkout: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if !paths.is_empty() {
        let mut out: Vec<String> = paths
            .iter()
            .filter_map(|path| relative_to(checkout, &expand_home(path)))
            .collect();
        out.sort();
        out.dedup();
        return Ok(out);
    }
    let (bytes, _) = crate::fs::git_output_capped(
        checkout,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        256 * 1024,
        None,
    )
    .ok_or("Could not read what changed in this checkout (git is not available)")?;
    let text = String::from_utf8_lossy(&bytes);
    let mut fields = text.split('\0');
    let mut out = Vec::new();
    while let Some(entry) = fields.next() {
        // `XY path`; a rename or copy is followed by the old path as its own NUL-terminated field.
        if entry.len() < 4 {
            continue;
        }
        let status = &entry[..2];
        out.push(entry[3..].to_string());
        if status.starts_with('R') || status.starts_with('C') {
            let _ = fields.next();
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

fn relative_to(checkout: &Path, path: &Path) -> Option<String> {
    let relative = if path.is_absolute() {
        path.strip_prefix(checkout).ok()?
    } else {
        path
    };
    let text = relative.to_string_lossy().replace('\\', "/");
    let text = text.trim_start_matches("./").to_string();
    if text.is_empty() || text.split('/').any(|s| s == ".." || s.is_empty()) {
        return None;
    }
    Some(text)
}

/// The nearest folder at or above each changed file that holds a project marker (package.json, Cargo.toml, …).
pub fn changed_folders(checkout: &Path, files: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for file in files {
        let mut dir = Path::new(file).parent();
        let folder = loop {
            match dir {
                Some(part) => {
                    let text = part.to_string_lossy().replace('\\', "/");
                    if MARKERS
                        .iter()
                        .any(|marker| checkout.join(part).join(marker).is_file())
                    {
                        break Some(text);
                    }
                    dir = part.parent();
                }
                None => break None,
            }
        };
        if let Some(folder) = folder {
            if !out.contains(&folder) {
                out.push(folder);
            }
        }
    }
    out
}

/// Checkout-relative paths in `folder`'s subtree (`""` is the root).
pub(crate) fn in_folder(path: &str, folder: &str) -> bool {
    if folder.is_empty() {
        true
    } else {
        path == folder || path.starts_with(&format!("{folder}/"))
    }
}

// ---- globs ----------------------------------------------------------------------------------------------------------

/// A checkout-relative glob: `**` spans folders, `*` and `?` stay inside one segment.
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    segments_match(&pattern, &path)
}

fn segments_match(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.first() {
        None => path.is_empty(),
        Some(&"**") => (0..=path.len()).any(|skip| segments_match(&pattern[1..], &path[skip..])),
        Some(segment) => {
            !path.is_empty()
                && segment_matches(segment, path[0])
                && segments_match(&pattern[1..], &path[1..])
        }
    }
}

fn segment_matches(pattern: &str, text: &str) -> bool {
    fn go(pattern: &[char], text: &[char]) -> bool {
        match pattern.first() {
            None => text.is_empty(),
            Some('*') => (0..=text.len()).any(|skip| go(&pattern[1..], &text[skip..])),
            Some('?') => !text.is_empty() && go(&pattern[1..], &text[1..]),
            Some(c) => text.first() == Some(c) && go(&pattern[1..], &text[1..]),
        }
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    go(&pattern, &text)
}

// ---- the real-path verdict ------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Verdict {
    outcome: String,
    #[serde(default)]
    detail: String,
}

fn read_verdict(path: &Path) -> Result<(Outcome, String), String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("its verdict file could not be read ({error})"))?;
    let verdict: Verdict = serde_json::from_str(&text)
        .map_err(|error| format!("its verdict file is not valid JSON ({error})"))?;
    let outcome = match verdict.outcome.as_str() {
        "passed" => Outcome::Passed,
        "failed" => Outcome::Failed,
        "couldNotExercise" => Outcome::CouldNotExercise,
        other => {
            return Err(format!(
                "its verdict {other:?} is not one this stage understands"
            ))
        }
    };
    Ok((outcome, truncate(&verdict.detail)))
}

// ---- the run --------------------------------------------------------------------------------------------------------

fn action_for(
    kind: &str,
    action_id: &str,
    name: &str,
    command: &str,
    timeout: u64,
) -> ProjectAction {
    ProjectAction {
        id: action_id.to_string(),
        name: name.to_string(),
        command: command.to_string(),
        description: Some(format!("verify stage {kind}")),
        icon: Some("check".into()),
        run_on_worktree_create: false,
        hold: false,
        long_running: false,
        timeout_seconds: Some(timeout),
        confirm: None,
    }
}

fn run_command(
    app: &AppHandle,
    main: &Path,
    checkout: &Path,
    action: &ProjectAction,
    env: Vec<(String, String)>,
) -> Result<(crate::project_actions::RunRecord, f64), String> {
    let runs = app.state::<ActionRuns>();
    let started = std::time::Instant::now();
    // WP-178 (review r2 HIGH-2): a verify run is an agent's own command, so it runs under the sandbox while it is on.
    let data = project_file::data_dir(app)?;
    let named = checkout.to_path_buf();
    let wrap = crate::agent_sandbox::action_wrap(Some(&data), std::slice::from_ref(&named))?;
    let record = project_actions::start_command(
        &runs,
        main,
        checkout,
        action,
        "verify",
        &data.join("action-runs"),
        Some(crate::harness::cached_gui_search_path()),
        env,
        false,
        Some(project_actions::emitter(app)),
        wrap,
    )?;
    let limit = Duration::from_secs(
        action
            .timeout_seconds()
            .unwrap_or(project_file::DEFAULT_TIMEOUT_SECONDS),
    ) + Duration::from_secs(30);
    let record = runs
        .wait(&record.id, limit)
        .ok_or("the run disappeared before it finished")?;
    Ok((record, started.elapsed().as_secs_f64()))
}

/// Run one of the project's checks in `checkout` through the action runner. Also the `checks` gate's runner (Hivra WP-40,
/// firstmate/gates.rs): a check that couldn't start is `CouldNotExercise`, never a pass.
pub(crate) fn run_check(
    app: &AppHandle,
    main: &Path,
    checkout: &Path,
    id: &str,
    name: &str,
    command: &str,
    timeout: u64,
) -> StepResult {
    let (outcome, detail, run_id, log_path, seconds) = match run_command(
        app,
        main,
        checkout,
        &action_for("check", &format!("verify-{id}"), name, command, timeout),
        Vec::new(),
    ) {
        Ok((run, seconds)) => match run.status {
            crate::project_actions::RunStatus::Succeeded => (
                Outcome::Passed,
                "ran and passed".to_string(),
                Some(run.id.clone()),
                Some(run.log_path.clone()),
                seconds,
            ),
            crate::project_actions::RunStatus::Failed => (
                Outcome::Failed,
                match run.exit_code {
                    Some(code) => format!("failed (exit {code})"),
                    None => "failed".to_string(),
                },
                Some(run.id.clone()),
                Some(run.log_path.clone()),
                seconds,
            ),
            crate::project_actions::RunStatus::TimedOut => (
                Outcome::Failed,
                "was stopped after its timeout".to_string(),
                Some(run.id.clone()),
                Some(run.log_path.clone()),
                seconds,
            ),
            crate::project_actions::RunStatus::Stopped => (
                Outcome::Failed,
                "was stopped before it finished".to_string(),
                Some(run.id.clone()),
                Some(run.log_path.clone()),
                seconds,
            ),
            crate::project_actions::RunStatus::Running => (
                Outcome::CouldNotExercise,
                "did not finish".to_string(),
                Some(run.id.clone()),
                Some(run.log_path.clone()),
                seconds,
            ),
        },
        Err(error) => (Outcome::CouldNotExercise, truncate(&error), None, None, 0.0),
    };
    StepResult {
        kind: "check".into(),
        id: id.to_string(),
        name: name.to_string(),
        outcome,
        detail,
        run_id,
        log_path,
        seconds,
    }
}

/// SC-3b: a check that exited cleanly but whose log says its runner ran zero tests tested nothing: it could not be
/// exercised and is never a pass. SC-3a put this rule in the gates' reading of a step (`gates::step_evidence`); the
/// verify stage and the ship check get it here. A step that failed, one that could not run for another reason and one
/// whose log holds no test summary (a build, a lint) keep their word. The whole log is read, not its tail.
pub(crate) fn downgrade_zero_tests(mut step: StepResult) -> StepResult {
    if step.outcome != Outcome::Passed {
        return step;
    }
    let Some(log) = step
        .log_path
        .as_deref()
        .and_then(|path| std::fs::read(path).ok())
    else {
        return step;
    };
    if let Some(note) = crate::firstmate::gates::zero_tests_note(&String::from_utf8_lossy(&log)) {
        step.outcome = Outcome::CouldNotExercise;
        step.detail = note;
    }
    step
}

pub(crate) fn run(app: &AppHandle, cwd: &Path, paths: Vec<String>) -> Result<VerifyRecord, String> {
    run_kept(app, cwd, paths, true)
}

/// SC-3b: the same run, left out of the project's verify history. The ship check runs this over a commit range and keeps
/// its own record, so the "Check this turn" card's latest verdict stays the last turn's, not a range's.
pub(crate) fn run_unrecorded(
    app: &AppHandle,
    cwd: &Path,
    paths: Vec<String>,
) -> Result<VerifyRecord, String> {
    run_kept(app, cwd, paths, false)
}

fn run_kept(
    app: &AppHandle,
    cwd: &Path,
    paths: Vec<String>,
    keep: bool,
) -> Result<VerifyRecord, String> {
    let (main, checkout) = project_actions::checkout_of_project(cwd)?;
    let data = project_file::data_dir(app)?;
    let id = uuid::Uuid::new_v4().to_string();
    let started_at = now_ms();
    let mut record = VerifyRecord {
        id: id.clone(),
        project_root: path_to_js(&main),
        checkout: path_to_js(&checkout),
        started_at,
        ended_at: started_at,
        outcome: Outcome::NotRun,
        summary: String::new(),
        steps: Vec::new(),
        gaps: Vec::new(),
        changed_files: Vec::new(),
    };

    let Some(file) = project_file::trusted_file(&data, &main) else {
        record.summary = if project_file::read_main_file(&main) == project_file::FileState::Missing
        {
            "Nothing was run: this project has no .monocode/project.json, so it declares no checks or real path."
                .into()
        } else {
            "Nothing was run: this project's .monocode/project.json isn't imported yet (Settings > Worktrees)."
                .into()
        };
        record.ended_at = now_ms();
        if keep {
            let _ = save(&record);
        }
        return Ok(record);
    };
    let verify = file.verify.clone();

    let changed = changed_files(&checkout, &paths)?;
    let mut gaps = Vec::new();
    if changed.is_empty() {
        record.summary = "Nothing was run: this checkout has no changed files to check.".into();
    } else {
        // Checks cover every change under their folder; a changed folder no check covers is named, not hidden.
        for check in &verify.checks {
            let touched = changed.iter().any(|path| in_folder(path, check.dir()));
            if !touched {
                continue;
            }
            // SC-3b: a check whose runner ran zero tests could not be exercised, not passed.
            record.steps.push(downgrade_zero_tests(run_check(
                app,
                &main,
                &checkout,
                &check.id,
                &check.name,
                &check.command,
                check.timeout_seconds(),
            )));
        }
        for folder in changed_folders(&checkout, &changed) {
            if !verify
                .checks
                .iter()
                .any(|check| in_folder(&folder, check.dir()))
            {
                gaps.push(if folder.is_empty() {
                    "the checkout root".to_string()
                } else {
                    format!("{folder}/")
                });
            }
        }
    }

    // The real path: anyone-visible change is driven for real, and its own verdict file decides the outcome.
    if let Some(real) = &verify.real_path {
        let applies = !changed.is_empty() && real.applies_to.is_empty()
            || changed
                .iter()
                .any(|path| real.applies_to.iter().any(|glob| glob_matches(glob, path)));
        if !applies {
            record.steps.push(StepResult {
                kind: "realPath".into(),
                id: "real-path".into(),
                name: "Real path".into(),
                outcome: Outcome::NotRun,
                detail: "not run: nothing in this change is something Ash would see".into(),
                run_id: None,
                log_path: None,
                seconds: 0.0,
            });
        } else {
            let verdict_path = records_dir().join("verdicts").join(format!("{id}.json"));
            if let Some(parent) = verdict_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::remove_file(&verdict_path);
            let step = match run_command(
                app,
                &main,
                &checkout,
                &action_for(
                    "realPath",
                    "verify-real-path",
                    "Real path",
                    &real.command,
                    real.timeout_seconds(),
                ),
                vec![(
                    VERDICT_ENV.to_string(),
                    path_to_js(&verdict_path).to_string(),
                )],
            ) {
                Ok((run, seconds)) => {
                    let (outcome, detail) = real_path_outcome(run.status, run.exit_code, || {
                        read_verdict(&verdict_path)
                    });
                    StepResult {
                        kind: "realPath".into(),
                        id: "real-path".into(),
                        name: "Real path".into(),
                        outcome,
                        detail,
                        run_id: Some(run.id.clone()),
                        log_path: Some(run.log_path.clone()),
                        seconds,
                    }
                }
                Err(error) => StepResult {
                    kind: "realPath".into(),
                    id: "real-path".into(),
                    name: "Real path".into(),
                    outcome: Outcome::CouldNotExercise,
                    detail: truncate(&error),
                    run_id: None,
                    log_path: None,
                    seconds: 0.0,
                },
            };
            let _ = std::fs::remove_file(&verdict_path);
            record.steps.push(step);
        }
    } else if !changed.is_empty() {
        record.steps.push(StepResult {
            kind: "realPath".into(),
            id: "real-path".into(),
            name: "Real path".into(),
            outcome: Outcome::NotRun,
            detail: "not run: this project declares no real-path recipe, so nothing was driven the way Ash would see it"
                .into(),
            run_id: None,
            log_path: None,
            seconds: 0.0,
        });
    }

    record.gaps = gaps;
    record.changed_files = changed;
    record.outcome = VerifyRecord::aggregate(&record.steps);
    record.summary = summary_of(&record);
    record.ended_at = now_ms();
    let saved = if keep { save(&record) } else { Ok(()) };
    if let Err(error) = saved {
        record.summary = format!(
            "{} (the record could not be saved: {error})",
            record.summary
        );
    }
    Ok(record)
}

fn summary_of(record: &VerifyRecord) -> String {
    let mut parts: Vec<String> = record
        .steps
        .iter()
        .map(|step| format!("{} {}", step.name, step.outcome.as_word()))
        .collect();
    if !record.gaps.is_empty() {
        parts.push(format!("no checks declared for {}", record.gaps.join(", ")));
    }
    if parts.is_empty() {
        return match record.outcome {
            Outcome::Passed => "Everything that ran passed.".into(),
            _ => "Nothing was run.".into(),
        };
    }
    match record.outcome {
        Outcome::Passed => format!("Verified: {}.", parts.join("; ")),
        Outcome::Failed => format!("Failed: {}.", parts.join("; ")),
        Outcome::CouldNotExercise => {
            format!("Could not exercise the change: {}.", parts.join("; "))
        }
        Outcome::NotRun => format!("Nothing was run: {}.", parts.join("; ")),
    }
}

// ---- records --------------------------------------------------------------------------------------------------------

fn key(project_root: &str) -> String {
    project_file::hash(project_root.as_bytes())[..16].to_string()
}

fn save(record: &VerifyRecord) -> Result<(), String> {
    save_in(&records_dir(), record)
}

fn save_in(dir: &Path, record: &VerifyRecord) -> Result<(), String> {
    let latest = dir.join("latest");
    std::fs::create_dir_all(&latest).map_err(|e| e.to_string())?;
    let text = serde_json::to_string(record).map_err(|e| e.to_string())?;
    std::fs::write(
        latest.join(format!("{}.json", key(&record.project_root))),
        &text,
    )
    .map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("history.jsonl"))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{text}").map_err(|e| e.to_string())
}

/// The last verdict for this project, if one was recorded.
pub fn latest(project_root: &str) -> Option<VerifyRecord> {
    latest_in(&records_dir(), project_root)
}

fn latest_in(dir: &Path, project_root: &str) -> Option<VerifyRecord> {
    let text = std::fs::read_to_string(
        dir.join("latest")
            .join(format!("{}.json", key(project_root))),
    )
    .ok()?;
    let record: VerifyRecord = serde_json::from_str(&text).ok()?;
    (record.project_root == project_root).then_some(record)
}

// ---- commands -------------------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub async fn verify_stage_status(app: AppHandle, cwd: String) -> Result<VerifyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (main, checkout) = project_actions::checkout_of_project(&expand_home(&cwd))?;
        let data = project_file::data_dir(&app)?;
        let file = project_file::trusted_file(&data, &main);
        let project_root = path_to_js(&main);
        let (verify, imported, note) = match file {
            Some(file) => (file.verify.clone(), true, None),
            None => (
                VerifySettings::default(),
                false,
                Some(
                    if project_file::read_main_file(&main) == project_file::FileState::Missing {
                        "This project has no .monocode/project.json, so it declares no checks or real path."
                            .to_string()
                    } else {
                        "This project's .monocode/project.json isn't imported yet, so nothing can run. Ash imports it in Settings > Worktrees."
                            .to_string()
                    },
                ),
            ),
        };
        Ok(VerifyStatus {
            latest: latest(&project_root),
            project_root,
            checkout: path_to_js(&checkout),
            imported,
            verify,
            note,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub async fn verify_stage_run(
    app: AppHandle,
    cwd: String,
    paths: Option<Vec<String>>,
) -> Result<VerifyRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run(&app, &expand_home(&cwd), paths.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub async fn verify_stage_latest(cwd: String) -> Result<Option<VerifyRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let main = project_file::main_checkout(&expand_home(&cwd))?;
        Ok(latest(&path_to_js(&main)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How a finished real-path run reads in the verdict. Its own verdict file decides only when it finished successfully;
/// a run Ash stopped proves nothing, exactly as a stopped check does, so it fails the stage instead of reading as "not
/// applicable" beside a passing check.
fn real_path_outcome(
    status: crate::project_actions::RunStatus,
    exit_code: Option<i32>,
    verdict: impl FnOnce() -> Result<(Outcome, String), String>,
) -> (Outcome, String) {
    use crate::project_actions::RunStatus;
    match status {
        RunStatus::Succeeded => match verdict() {
            Ok((Outcome::NotRun, detail)) | Ok((Outcome::CouldNotExercise, detail)) => (
                Outcome::CouldNotExercise,
                if detail.is_empty() {
                    "ran, but reported it could not exercise the change".to_string()
                } else {
                    detail
                },
            ),
            Ok((outcome, detail)) => (outcome, detail),
            Err(error) => (
                Outcome::Failed,
                format!("finished without a usable verdict: {error}"),
            ),
        },
        RunStatus::Failed => {
            if exit_code == Some(127) {
                (
                    Outcome::CouldNotExercise,
                    "could not run: its command was not found".to_string(),
                )
            } else {
                (
                    Outcome::Failed,
                    match exit_code {
                        Some(code) => format!("failed (exit {code})"),
                        None => "failed".to_string(),
                    },
                )
            }
        }
        RunStatus::TimedOut => (
            Outcome::CouldNotExercise,
            "did not finish before its timeout".to_string(),
        ),
        RunStatus::Stopped => (
            Outcome::Failed,
            "was stopped before it finished".to_string(),
        ),
        RunStatus::Running => (Outcome::CouldNotExercise, "did not finish".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(kind: &str, outcome: Outcome) -> StepResult {
        StepResult {
            kind: kind.into(),
            id: kind.into(),
            name: kind.into(),
            outcome,
            detail: String::new(),
            run_id: None,
            log_path: None,
            seconds: 0.0,
        }
    }

    #[test]
    fn a_check_that_could_not_run_never_counts_as_a_pass() {
        assert_eq!(
            VerifyRecord::aggregate(&[
                step("a", Outcome::Passed),
                step("b", Outcome::CouldNotExercise)
            ]),
            Outcome::CouldNotExercise
        );
        assert_eq!(
            VerifyRecord::aggregate(&[
                step("a", Outcome::CouldNotExercise),
                step("b", Outcome::Failed)
            ]),
            Outcome::Failed
        );
        assert_eq!(
            VerifyRecord::aggregate(&[step("a", Outcome::Passed), step("b", Outcome::NotRun)]),
            Outcome::Passed
        );
        assert_eq!(
            VerifyRecord::aggregate(&[step("a", Outcome::NotRun)]),
            Outcome::NotRun
        );
        assert_eq!(VerifyRecord::aggregate(&[]), Outcome::NotRun);
    }

    #[test]
    fn a_stopped_real_path_fails_the_stage_instead_of_reading_as_not_applicable() {
        use crate::project_actions::RunStatus;
        // Its verdict file is never read: a run Ash stopped proves nothing, whatever it would have reported.
        let (outcome, detail) = real_path_outcome(RunStatus::Stopped, Some(0), || {
            Ok((Outcome::Passed, "passed".to_string()))
        });
        assert_eq!(outcome, Outcome::Failed);
        assert_eq!(detail, "was stopped before it finished");
        // Beside a passing check, the stage must not read as a pass.
        assert_eq!(
            VerifyRecord::aggregate(&[step("web", Outcome::Passed), step("real-path", outcome)]),
            Outcome::Failed
        );
    }

    #[test]
    fn globs_cover_the_folders_they_name() {
        assert!(glob_matches("src/**", "src/a.ts"));
        assert!(glob_matches("src/**", "src/ui/deep/a.tsx"));
        assert!(glob_matches("src/**", "src"));
        assert!(!glob_matches("src/**", "src-tauri/a.rs"));
        assert!(glob_matches("*.html", "index.html"));
        assert!(!glob_matches("*.html", "web/index.html"));
        assert!(glob_matches("**/*.rs", "a.rs"));
        assert!(glob_matches("**/*.rs", "src-tauri/src/lib.rs"));
        assert!(glob_matches("src-tauri/src/*.rs", "src-tauri/src/lib.rs"));
        assert!(!glob_matches(
            "src-tauri/src/*.rs",
            "src-tauri/src/deep/lib.rs"
        ));
        assert!(glob_matches("a?c", "abc"));
        assert!(!glob_matches("a?c", "ac"));
    }

    #[test]
    fn folders_are_the_nearest_marked_folder_above_each_file() {
        let dir = std::env::temp_dir().join(format!("verify-stage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("web/src")).unwrap();
        std::fs::create_dir_all(dir.join("src-tauri/src")).unwrap();
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join("web/package.json"), "{}").unwrap();
        std::fs::write(dir.join("src-tauri/Cargo.toml"), "").unwrap();
        let files = vec![
            "web/src/a.ts".to_string(),
            "src-tauri/src/lib.rs".to_string(),
            "docs/readme.md".to_string(),
            "package.json".to_string(),
        ];
        // docs/ has no marker of its own, so it belongs to the root folder; the root covers everything.
        assert_eq!(changed_folders(&dir, &files), vec!["web", "src-tauri", ""]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_says_what_changed_when_the_turn_named_nothing() {
        let temp = crate::project_file::tests::temp("verify-changed");
        let repo = crate::project_file::tests::repo(&temp.0);
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/new.ts"), "x").unwrap();
        std::fs::write(repo.join("staged.ts"), "x").unwrap();
        crate::fs::git_checked(&repo, &["add", "staged.ts"]).unwrap();
        let changed = changed_files(&repo, &[]).unwrap();
        assert!(changed.contains(&"src/new.ts".to_string()), "{changed:?}");
        assert!(changed.contains(&"staged.ts".to_string()), "{changed:?}");
        // A turn that names its own paths gets exactly those, made relative to the checkout.
        let named =
            changed_files(&repo, &["src/new.ts".to_string(), "../outside".to_string()]).unwrap();
        assert_eq!(named, vec!["src/new.ts".to_string()]);
    }

    #[test]
    fn a_verdict_file_decides_the_real_path_outcome() {
        let dir = std::env::temp_dir().join(format!("verify-verdict-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("verdict.json");
        std::fs::write(
            &path,
            r#"{"outcome":"couldNotExercise","detail":"no browser here"}"#,
        )
        .unwrap();
        assert_eq!(
            read_verdict(&path).unwrap(),
            (Outcome::CouldNotExercise, "no browser here".to_string())
        );
        std::fs::write(&path, r#"{"outcome":"passed"}"#).unwrap();
        assert_eq!(
            read_verdict(&path).unwrap(),
            (Outcome::Passed, String::new())
        );
        std::fs::write(&path, r#"{"outcome":"fine"}"#).unwrap();
        assert!(read_verdict(&path)
            .unwrap_err()
            .contains("not one this stage understands"));
        std::fs::write(&path, r#"{"detail":"x"}"#).unwrap();
        assert!(read_verdict(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(read_verdict(&path)
            .unwrap_err()
            .contains("could not be read"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_round_trips_and_latest_finds_it_by_project() {
        let dir = std::env::temp_dir().join(format!("verify-record-{}", uuid::Uuid::new_v4()));
        let record = VerifyRecord {
            id: "r1".into(),
            project_root: "/tmp/project".into(),
            checkout: "/tmp/project".into(),
            started_at: 1,
            ended_at: 2,
            outcome: Outcome::Passed,
            summary: "Verified: Web checks passed.".into(),
            steps: vec![step("check", Outcome::Passed)],
            gaps: Vec::new(),
            changed_files: vec!["src/a.ts".into()],
        };
        save_in(&dir, &record).unwrap();
        let found = latest_in(&dir, "/tmp/project").unwrap();
        assert_eq!(found.id, "r1");
        assert_eq!(found.outcome, Outcome::Passed);
        assert!(latest_in(&dir, "/tmp/other").is_none());
        assert!(std::fs::read_to_string(dir.join("history.jsonl"))
            .unwrap()
            .contains("\"r1\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A passed check with its log on disk.
    fn passed_with_log(log: &str) -> (StepResult, PathBuf) {
        let dir = std::env::temp_dir().join(format!("verify-zero-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("run.log");
        std::fs::write(&path, log).unwrap();
        let mut found = step("check", Outcome::Passed);
        found.detail = "ran and passed".into();
        found.log_path = Some(path.to_string_lossy().into_owned());
        (found, dir)
    }

    #[test]
    fn a_check_that_ran_zero_tests_could_not_be_exercised() {
        let zero = "running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
        let (found, dir) = passed_with_log(zero);
        let found = downgrade_zero_tests(found);
        assert_eq!(found.outcome, Outcome::CouldNotExercise);
        assert!(
            found.detail.starts_with("ran zero tests"),
            "{}",
            found.detail
        );
        // Beside a passing check it must not read as a pass.
        assert_eq!(
            VerifyRecord::aggregate(&[step("web", Outcome::Passed), found]),
            Outcome::CouldNotExercise
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_check_that_ran_tests_or_has_no_summary_keeps_its_word() {
        // 500 tests in the library, then the empty doc-tests: the last summary is not the run's.
        let ran = "running 500 tests\ntest result: ok. 500 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 4.2s\n   Doc-tests tally\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
        let (found, dir) = passed_with_log(ran);
        assert_eq!(downgrade_zero_tests(found).outcome, Outcome::Passed);
        let (found, other) = passed_with_log("Compiling tally\nFinished dev profile\n");
        assert_eq!(downgrade_zero_tests(found).outcome, Outcome::Passed);
        // A failed step, and a passed one whose log is gone, are not touched.
        let mut failed = step("check", Outcome::Failed);
        failed.log_path = Some("/nonexistent/run.log".into());
        assert_eq!(downgrade_zero_tests(failed).outcome, Outcome::Failed);
        let mut gone = step("check", Outcome::Passed);
        gone.log_path = Some("/nonexistent/run.log".into());
        assert_eq!(downgrade_zero_tests(gone).outcome, Outcome::Passed);
        assert_eq!(
            downgrade_zero_tests(step("check", Outcome::Passed)).outcome,
            Outcome::Passed
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }
}
