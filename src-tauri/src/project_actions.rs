//! Runs a project's imported actions (src/project_file.rs): the Settings buttons, a Lead's `actions.run`, and the
//! setup that follows `git worktree add` (src/worktrees.rs).
//!
//! Each run is a child process in its own process group, in a checkout of the project (the main checkout or one of
//! its registered worktrees, nothing else), with a log file, a live tail sent to the window as `project-action`
//! events, and a timeout unless the action is long-running. The app stops every run when it exits.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::fs::{expand_home, path_to_js};
use crate::project_file::{self, ProjectAction, ProjectFileStatus};

pub const EVENT: &str = "project-action";
const TAIL_LINES: usize = 200;
const MAX_LINE_CHARS: usize = 2000;
const KEEP_FINISHED: usize = 40;
const KEEP_LOGS: usize = 80;
const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
    Stopped,
    TimedOut,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub project_root: String,
    pub cwd: String,
    pub action_id: String,
    pub action_name: String,
    pub command: String,
    /// `worktree-create`, `app` (a button) or `agent` (a Lead's actions.run).
    pub trigger: String,
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub log_path: String,
    /// The last lines of output, newest last.
    pub tail: Vec<String>,
    pub long_running: bool,
    pub error: Option<String>,
}

impl RunRecord {
    pub fn finished(&self) -> bool {
        self.status != RunStatus::Running
    }
}

struct Run {
    record: Mutex<RunRecord>,
    done: Condvar,
    stop: AtomicBool,
}

#[derive(Default)]
pub struct ActionRuns {
    runs: Mutex<VecDeque<Arc<Run>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionEvent<'a> {
    run_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run: Option<&'a RunRecord>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Where a run happens and what it runs; the caller has already checked trust and the checkout.
pub struct RunRequest<'a> {
    pub project_root: &'a Path,
    pub cwd: &'a Path,
    pub action: &'a ProjectAction,
    pub trigger: &'a str,
    pub log_dir: &'a Path,
    /// Shell PATH for the child; the app passes the login-shell search path.
    pub path_env: Option<String>,
    /// Extra variables for this command only (the verify stage hands its real-path recipe the file to write its
    /// verdict in). Set after the credential scrub, so a caller can never re-add an app endpoint.
    pub env: Vec<(String, String)>,
    /// Start from [`ALLOWED_ENV`] rather than everything the app inherited. The finish-line check asks for this: a
    /// command from a proposal must not see the app's own secrets in its environment.
    pub env_clear: bool,
    /// When the sandbox is on: the program and leading arguments that run the action's shell under it, for example
    /// `sandbox-exec -p <profile>` (agent_sandbox::action_wrap). None runs the shell directly.
    pub wrap: Option<Vec<std::ffi::OsString>>,
}

pub(crate) type Emit = Arc<dyn Fn(&str, Option<&str>, Option<&RunRecord>) + Send + Sync>;

impl ActionRuns {
    pub fn new() -> Self {
        Self::default()
    }

    fn find(&self, id: &str) -> Option<Arc<Run>> {
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|run| run.record.lock().unwrap_or_else(|e| e.into_inner()).id == id)
            .cloned()
    }

    /// Newest first, for one project or all.
    pub fn list(&self, project_root: Option<&Path>) -> Vec<RunRecord> {
        let root = project_root.map(path_to_js);
        let runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.iter()
            .rev()
            .map(|run| run.record.lock().unwrap_or_else(|e| e.into_inner()).clone())
            .filter(|record| {
                root.as_deref()
                    .is_none_or(|root| record.project_root == root)
            })
            .collect()
    }

    fn insert(&self, run: Arc<Run>) {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.push_back(run);
        // Forget the oldest finished runs; a running one is never dropped.
        while runs.len() > KEEP_FINISHED {
            let Some(index) = runs.iter().position(|run| {
                run.record
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .finished()
            }) else {
                break;
            };
            runs.remove(index);
        }
    }

    /// Block until the run finishes or `timeout` passes; returns the record either way.
    pub fn wait(&self, id: &str, timeout: Duration) -> Option<RunRecord> {
        let run = self.find(id)?;
        let deadline = Instant::now() + timeout;
        let mut record = run.record.lock().unwrap_or_else(|e| e.into_inner());
        while !record.finished() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            record = run
                .done
                .wait_timeout(record, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        Some(record.clone())
    }

    pub fn stop(&self, id: &str) -> Option<RunRecord> {
        let run = self.find(id)?;
        run.stop.store(true, Ordering::SeqCst);
        let record = run.record.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Some(record)
    }

    /// Stop every running action (the app is exiting) and give them a moment to go.
    pub fn stop_all(&self) {
        let running: Vec<Arc<Run>> = self
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|run| {
                !run.record
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .finished()
            })
            .cloned()
            .collect();
        for run in &running {
            run.stop.store(true, Ordering::SeqCst);
        }
        let deadline = Instant::now() + STOP_GRACE + Duration::from_secs(1);
        for run in running {
            let mut record = run.record.lock().unwrap_or_else(|e| e.into_inner());
            while !record.finished() && Instant::now() < deadline {
                record = run
                    .done
                    .wait_timeout(record, Duration::from_millis(100))
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
        }
    }

    pub fn start(&self, request: RunRequest<'_>, emit: Option<Emit>) -> Result<RunRecord, String> {
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(request.log_dir).map_err(|e| e.to_string())?;
        prune_logs(request.log_dir);
        let log_path = request.log_dir.join(format!("{id}.log"));
        let mut log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
        let _ = writeln!(
            log,
            "$ {}\n# in {} ({})\n",
            request.action.command,
            request.cwd.display(),
            request.action.name
        );
        let record = RunRecord {
            id: id.clone(),
            project_root: path_to_js(request.project_root),
            cwd: path_to_js(request.cwd),
            action_id: request.action.id.clone(),
            action_name: request.action.name.clone(),
            command: request.action.command.clone(),
            trigger: request.trigger.into(),
            status: RunStatus::Running,
            exit_code: None,
            started_at: now_ms(),
            ended_at: None,
            log_path: path_to_js(&log_path),
            tail: Vec::new(),
            long_running: request.action.long_running,
            error: None,
        };
        let child = spawn(&request);
        let run = Arc::new(Run {
            record: Mutex::new(record),
            done: Condvar::new(),
            stop: AtomicBool::new(false),
        });
        let emit: Emit = emit.unwrap_or_else(|| Arc::new(|_, _, _| {}));
        let mut child = match child {
            Ok(child) => child,
            Err(error) => {
                let mut record = run.record.lock().unwrap_or_else(|e| e.into_inner());
                record.status = RunStatus::Failed;
                record.ended_at = Some(now_ms());
                record.error = Some(error.clone());
                let _ = writeln!(log, "Could not start: {error}");
                let snapshot = record.clone();
                drop(record);
                self.insert(run);
                emit(&snapshot.id, None, Some(&snapshot));
                return Ok(snapshot);
            }
        };
        let log = Arc::new(Mutex::new(log));
        let readers: Vec<_> = [
            child
                .stdout
                .take()
                .map(|out| Box::new(out) as Box<dyn std::io::Read + Send>),
            child
                .stderr
                .take()
                .map(|err| Box::new(err) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        .map(|stream| {
            let run = run.clone();
            let log = log.clone();
            let emit = emit.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut bytes = Vec::new();
                loop {
                    bytes.clear();
                    match reader.read_until(b'\n', &mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let text = String::from_utf8_lossy(&bytes);
                    let line: String = text
                        .trim_end_matches(['\n', '\r'])
                        .chars()
                        .take(MAX_LINE_CHARS)
                        .collect();
                    if let Ok(mut log) = log.lock() {
                        let _ = writeln!(log, "{line}");
                    }
                    {
                        let mut record = run.record.lock().unwrap_or_else(|e| e.into_inner());
                        record.tail.push(line.clone());
                        if record.tail.len() > TAIL_LINES {
                            let excess = record.tail.len() - TAIL_LINES;
                            record.tail.drain(..excess);
                        }
                    }
                    emit(&id, Some(&line), None);
                }
            })
        })
        .collect();
        self.insert(run.clone());
        let timeout = request.action.timeout_seconds().map(Duration::from_secs);
        let started = Instant::now();
        let snapshot = run.record.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let waiter_run = run.clone();
        let waiter_emit = emit.clone();
        std::thread::spawn(move || {
            let emit = waiter_emit;
            let run = waiter_run;
            let mut outcome = None;
            let mut stopping: Option<(Instant, RunStatus)> = None;
            let exit = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => {}
                    Err(error) => break Err(error.to_string()),
                }
                if stopping.is_none() {
                    let reason = if run.stop.load(Ordering::SeqCst) {
                        Some(RunStatus::Stopped)
                    } else if timeout.is_some_and(|limit| started.elapsed() >= limit) {
                        Some(RunStatus::TimedOut)
                    } else {
                        None
                    };
                    if let Some(reason) = reason {
                        signal(&mut child, false);
                        stopping = Some((Instant::now(), reason));
                        outcome = Some(reason);
                    }
                } else if let Some((since, _)) = stopping {
                    if since.elapsed() >= STOP_GRACE {
                        signal(&mut child, true);
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            // Background children can hold the pipes open; don't wait on them forever.
            let deadline = Instant::now() + Duration::from_secs(2);
            for reader in readers {
                while !reader.is_finished() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                if reader.is_finished() {
                    let _ = reader.join();
                }
            }
            let mut record = run.record.lock().unwrap_or_else(|e| e.into_inner());
            record.ended_at = Some(now_ms());
            match exit {
                Ok(status) => {
                    record.exit_code = status.code();
                    record.status = outcome.unwrap_or(if status.success() {
                        RunStatus::Succeeded
                    } else {
                        RunStatus::Failed
                    });
                }
                Err(error) => {
                    record.status = RunStatus::Failed;
                    record.error = Some(error);
                }
            }
            let summary = match record.status {
                RunStatus::Succeeded => "finished".to_string(),
                RunStatus::Failed => format!(
                    "failed{}",
                    record
                        .exit_code
                        .map(|code| format!(" (exit {code})"))
                        .unwrap_or_default()
                ),
                RunStatus::Stopped => "stopped".to_string(),
                RunStatus::TimedOut => "stopped after its timeout".to_string(),
                RunStatus::Running => unreachable!(),
            };
            if let Ok(mut log) = log.lock() {
                let _ = writeln!(log, "\n# {summary}");
            }
            let finished = record.clone();
            drop(record);
            run.done.notify_all();
            emit(&finished.id, None, Some(&finished));
        });
        emit(&snapshot.id, None, Some(&snapshot));
        Ok(snapshot)
    }
}

fn spawn(request: &RunRequest<'_>) -> Result<Child, String> {
    command(request)
        .spawn()
        .map_err(|error| format!("Failed to start the action: {error}"))
}

/// What control.rs hands an agent's process; a project action gets none of it.
const AGENT_CREDENTIALS: [&str; 4] = [
    "MONOCODE_APP_ENDPOINT",
    "MONOCODE_APP_TOKEN",
    "MONOCODE_CONTROL_ENDPOINT",
    "MONOCODE_CONTROL_TOKEN",
];

/// What a child started with `env_clear` may keep from the app's own environment: the things a shell, a toolchain and
/// a locale need to work at all. The project's own variables are set explicitly below, never inherited.
#[cfg(windows)]
const ALLOWED_ENV: [&str; 13] = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
];
#[cfg(not(windows))]
const ALLOWED_ENV: [&str; 7] = [
    "PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
];

/// The action's command line, environment and process group, not started yet.
fn command(request: &RunRequest<'_>) -> Command {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(&request.action.command);
        command
    };
    #[cfg(not(windows))]
    let mut command = match &request.wrap {
        Some(prefix) if !prefix.is_empty() => {
            let mut command = Command::new(&prefix[0]);
            command.args(&prefix[1..]);
            command
                .arg("/bin/sh")
                .arg("-c")
                .arg(&request.action.command);
            command
        }
        _ => {
            let mut command = Command::new("/bin/sh");
            command.arg("-c").arg(&request.action.command);
            command
        }
    };
    crate::hide_window_console(&mut command);
    if request.env_clear {
        command.env_clear();
        for name in ALLOWED_ENV {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
    command
        .current_dir(request.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("MONOCODE_PROJECT_ROOT", request.project_root)
        .env("MONOCODE_WORKTREE_PATH", request.cwd)
        .env("MONOCODE_ACTION_ID", &request.action.id)
        .env("NO_COLOR", "1");
    // The app and control endpoints belong to an agent's own process (control.rs `configure_child`), never to a project
    // script: whatever this app inherited goes, the known names and anything else under those prefixes.
    for name in AGENT_CREDENTIALS {
        command.env_remove(name);
    }
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_some_and(|name| {
            name.starts_with("MONOCODE_APP_") || name.starts_with("MONOCODE_CONTROL_")
        }) {
            command.env_remove(&name);
        }
    }
    for (name, value) in &request.env {
        command.env(name, value);
    }
    if let Some(path) = &request.path_env {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group, so stop and timeout reach everything the command started.
        command.process_group(0);
    }
    command
}

fn signal(child: &mut Child, kill: bool) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        let signal = if kill { libc::SIGKILL } else { libc::SIGTERM };
        // The child leads its own group (process_group(0)); signal the whole group.
        unsafe {
            libc::kill(-pid, signal);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = kill;
        let _ = child.kill();
    }
}

fn prune_logs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "log"))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    if logs.len() < KEEP_LOGS {
        return;
    }
    logs.sort();
    for (_, path) in logs.iter().take(logs.len() + 1 - KEEP_LOGS) {
        let _ = std::fs::remove_file(path);
    }
}

/// The checkout an action runs in must be the project's main checkout or one of its registered worktrees.
pub fn checkout_of_project(cwd: &Path) -> Result<(PathBuf, PathBuf), String> {
    if crate::chat_folder::is_blank(cwd) {
        return Err(crate::chat_folder::NEEDS_FOLDER.into());
    }
    let main = project_file::main_checkout(cwd)?;
    let wanted = crate::fs::canonical(cwd).map_err(|e| e.to_string())?;
    let registered = crate::worktrees::list(&main)?
        .into_iter()
        .filter_map(|tree| crate::fs::canonical(tree.path).ok())
        .any(|path| path == wanted);
    if !registered {
        return Err(
            "Actions run only in this project's main checkout or one of its worktrees".into(),
        );
    }
    Ok((main, wanted))
}

fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(project_file::data_dir(app)?.join("action-runs"))
}

pub(crate) fn emitter(app: &AppHandle) -> Emit {
    let app = app.clone();
    Arc::new(move |run_id, line, run| {
        let _ = app.emit(EVENT, ActionEvent { run_id, line, run });
    })
}

/// Start a trusted action in a checkout of its project.
pub(crate) fn run_action(
    app: &AppHandle,
    runs: &ActionRuns,
    cwd: &Path,
    action_id: &str,
    trigger: &str,
) -> Result<RunRecord, String> {
    let (main, checkout) = checkout_of_project(cwd)?;
    let data = project_file::data_dir(app)?;
    let file = project_file::trusted_file(&data, &main).ok_or(
        "This project's actions aren't imported yet. Ash imports .monocode/project.json in Settings > Worktrees.",
    )?;
    let action = file.action(action_id).ok_or_else(|| {
        format!("No action {action_id:?} in this project's imported project file")
    })?;
    // WP-87: only a long-running action with a declared stack prepares ports and Compose.
    // Check and ship pass an empty env and do not start Docker.
    // WP-178 (review r2 HIGH-2): while the sandbox is on, an action an agent or Setup starts runs under the profile.
    let wrap = crate::agent_sandbox::action_wrap(Some(&data))?;
    let stack_env = if action.long_running && file.stack.is_some() {
        let started = crate::stacks::maybe_start(
            &crate::stacks::env_from_app(app)?,
            &main,
            &checkout,
            true,
            file.stack.as_ref(),
            file.reaches.as_deref() == Some("real"),
            trigger == "app",
        );
        // A failed start can still have cleared `running`. The task card refetches either way.
        let _ = app.emit(crate::stacks::STACKS_CHANGED, ());
        started?
    } else {
        Vec::new()
    };
    start_command(
        runs,
        &main,
        &checkout,
        action,
        trigger,
        &log_dir(app)?,
        Some(crate::harness::cached_gui_search_path()),
        stack_env,
        false,
        Some(emitter(app)),
        wrap,
    )
}

/// Start a command in a checkout of its project, with the same process group, timeout, log and credential scrub as an
/// action button. The caller owns trust: the verify stage only builds these from the imported project file.
#[allow(clippy::too_many_arguments)]
pub(crate) fn start_command(
    runs: &ActionRuns,
    project_root: &Path,
    cwd: &Path,
    action: &ProjectAction,
    trigger: &str,
    log_dir: &Path,
    path_env: Option<String>,
    env: Vec<(String, String)>,
    env_clear: bool,
    emit: Option<Emit>,
    wrap: Option<Vec<std::ffi::OsString>>,
) -> Result<RunRecord, String> {
    if let Some(running) = runs
        .list(Some(project_root))
        .into_iter()
        .find(|run| !run.finished() && run.action_id == action.id && Path::new(&run.cwd) == cwd)
    {
        return Err(format!(
            "{} is already running in this checkout (run {})",
            action.name, running.id
        ));
    }
    runs.start(
        RunRequest {
            project_root,
            cwd,
            action,
            trigger,
            log_dir,
            path_env,
            env,
            env_clear,
            wrap,
        },
        emit,
    )
}

/// What `git_worktree_create` reports about the setup it started.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetup {
    pub action_id: Option<String>,
    pub name: Option<String>,
    pub command: Option<String>,
    /// The chat's first turn waits for it.
    pub hold: bool,
    pub run: Option<RunRecord>,
    /// Why nothing ran (the project file isn't imported, say).
    pub skipped: Option<String>,
}

/// Run the project's `runOnWorktreeCreate` action in a worktree that `git worktree add` just made. Nothing when the
/// project has no project file; a `skipped` note when it has one that isn't imported, so the chat can say so.
pub(crate) fn start_worktree_setup(app: &AppHandle, worktree: &Path) -> Option<WorktreeSetup> {
    let main = project_file::main_checkout(worktree).ok()?;
    let data = project_file::data_dir(app).ok()?;
    let Some(file) = project_file::trusted_file(&data, &main) else {
        return match project_file::read_main_file(&main) {
            project_file::FileState::Missing => None,
            _ => Some(WorktreeSetup {
                action_id: None,
                name: None,
                command: None,
                hold: false,
                run: None,
                skipped: Some(
                    "Setup didn't run: this project's .monocode/project.json isn't imported yet (Settings > Worktrees)."
                        .into(),
                ),
            }),
        };
    };
    let action = file.setup_action()?;
    let runs = app.state::<ActionRuns>();
    let started = run_action(app, &runs, worktree, &action.id, "worktree-create");
    Some(WorktreeSetup {
        action_id: Some(action.id.clone()),
        name: Some(action.name.clone()),
        command: Some(action.command.clone()),
        hold: action.hold,
        skipped: started
            .as_ref()
            .err()
            .map(|error| format!("Setup didn't start: {error}")),
        run: started.ok(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionsListing {
    pub status: ProjectFileStatus,
    /// The imported actions: what can run.
    pub actions: Vec<ProjectAction>,
    pub runs: Vec<RunRecord>,
}

#[tauri::command(async)]
pub async fn project_actions_list(app: AppHandle, cwd: String) -> Result<ActionsListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let main = project_file::main_checkout(&expand_home(&cwd))?;
        let status = project_file::status(&project_file::data_dir(&app)?, &main);
        let actions = status
            .trusted
            .as_ref()
            .map(|file| file.actions.clone())
            .unwrap_or_default();
        let runs = app.state::<ActionRuns>().list(Some(&main));
        Ok(ActionsListing {
            status,
            actions,
            runs,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub async fn project_action_run(
    app: AppHandle,
    cwd: String,
    action_id: String,
    trigger: Option<String>,
) -> Result<RunRecord, String> {
    let trigger = match trigger.as_deref() {
        Some("agent") => "agent",
        _ => "app",
    };
    tauri::async_runtime::spawn_blocking(move || {
        let runs = app.state::<ActionRuns>();
        run_action(&app, &runs, &expand_home(&cwd), &action_id, trigger)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn project_action_stop(
    runs: State<'_, ActionRuns>,
    run_id: String,
) -> Result<RunRecord, String> {
    runs.stop(&run_id)
        .ok_or_else(|| "No such action run".into())
}

#[tauri::command(async)]
pub async fn project_action_wait(
    app: AppHandle,
    run_id: String,
    timeout_ms: u64,
) -> Result<RunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<ActionRuns>()
            .wait(&run_id, Duration::from_millis(timeout_ms.min(60_000)))
            .ok_or_else(|| "No such action run".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_file::tests::{repo, temp};

    fn action(command: &str) -> ProjectAction {
        ProjectAction {
            id: "check".into(),
            name: "Check".into(),
            command: command.into(),
            description: None,
            icon: None,
            run_on_worktree_create: false,
            hold: true,
            long_running: false,
            timeout_seconds: None,
            confirm: None,
        }
    }

    /// `git -C ""` reads the folder the app runs in, so an action could be tied to the app's own checkout.
    #[test]
    fn an_action_is_never_tied_to_a_chat_with_no_folder() {
        assert_eq!(
            checkout_of_project(Path::new("")),
            Err(crate::chat_folder::NEEDS_FOLDER.to_string())
        );
        assert_eq!(
            project_file::main_checkout(Path::new("")),
            Err(crate::chat_folder::NEEDS_FOLDER.to_string())
        );
    }

    #[test]
    fn runs_in_the_checkout_with_the_project_environment_and_keeps_a_log() {
        let temp = temp("monocode-actions");
        let root = temp.0.join("checkout");
        std::fs::create_dir_all(&root).unwrap();
        let logs = temp.0.join("logs");
        let runs = ActionRuns::new();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let seen = lines.clone();
        let emit: Emit = Arc::new(move |_, line, _| {
            if let Some(line) = line {
                seen.lock().unwrap().push(line.to_string());
            }
        });
        // Actions run under `/bin/sh` here and `cmd` on Windows, so each gets the same script in its own words.
        #[cfg(not(windows))]
        let script =
            "echo root=$MONOCODE_PROJECT_ROOT; echo tree=$MONOCODE_WORKTREE_PATH; pwd; echo oops >&2; exit 3";
        #[cfg(windows)]
        let script = "echo root=%MONOCODE_PROJECT_ROOT%& echo tree=%MONOCODE_WORKTREE_PATH%& cd& echo oops>&2& exit 3";
        let action = action(script);
        let started = runs
            .start(
                RunRequest {
                    project_root: &temp.0,
                    cwd: &root,
                    action: &action,
                    trigger: "app",
                    log_dir: &logs,
                    path_env: None,
                    env: Vec::new(),
                    env_clear: false,
                    wrap: None,
                },
                Some(emit),
            )
            .unwrap();
        assert_eq!(started.status, RunStatus::Running);
        let done = runs.wait(&started.id, Duration::from_secs(10)).unwrap();
        assert_eq!(done.status, RunStatus::Failed);
        assert_eq!(done.exit_code, Some(3));
        assert!(done.tail.contains(&format!("root={}", temp.0.display())));
        assert!(done.tail.contains(&format!("tree={}", root.display())));
        assert!(done.tail.contains(&root.display().to_string()));
        assert!(done.tail.contains(&"oops".to_string()));
        assert!(lines.lock().unwrap().contains(&"oops".to_string()));
        let log = std::fs::read_to_string(&done.log_path).unwrap();
        assert!(log.contains("oops") && log.contains("failed (exit 3)"));
        assert_eq!(runs.list(Some(&temp.0)).len(), 1);
        assert!(runs.list(Some(&root)).is_empty());
    }

    #[test]
    fn an_action_never_gets_an_agents_app_or_control_credentials() {
        let temp = temp("monocode-actions-env");
        let action = action("true");
        let request = RunRequest {
            project_root: &temp.0,
            cwd: &temp.0,
            action: &action,
            trigger: "app",
            log_dir: &temp.0,
            path_env: None,
            env: Vec::new(),
            env_clear: false,
            wrap: None,
        };
        let command = command(&request);
        let removed: Vec<String> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        for key in [
            "MONOCODE_APP_ENDPOINT",
            "MONOCODE_APP_TOKEN",
            "MONOCODE_CONTROL_ENDPOINT",
            "MONOCODE_CONTROL_TOKEN",
        ] {
            assert!(removed.iter().any(|name| name == key), "{key}: {removed:?}");
        }
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "MONOCODE_ACTION_ID" && value.is_some()));
    }

    #[test]
    fn a_cleared_environment_keeps_only_the_allow_listed_variables() {
        let temp = temp("monocode-actions-clear");
        let logs = temp.0.join("logs");
        let runs = ActionRuns::new();
        // Set in the parent, as the app would be launched with them; the child must not see either.
        std::env::set_var("GITHUB_TOKEN", "secret-github-token");
        std::env::set_var("ANTHROPIC_API_KEY", "secret-anthropic-key");
        #[cfg(not(windows))]
        let script = "echo github=$GITHUB_TOKEN; echo anthropic=$ANTHROPIC_API_KEY; \
                      if [ -n \"$PATH\" ]; then echo path-kept; fi";
        #[cfg(windows)]
        let script = "echo github=%GITHUB_TOKEN%& echo anthropic=%ANTHROPIC_API_KEY%& \
                      if defined PATH echo path-kept";
        let started = runs.start(
            RunRequest {
                project_root: &temp.0,
                cwd: &temp.0,
                action: &action(script),
                trigger: "app",
                log_dir: &logs,
                path_env: None,
                env: Vec::new(),
                env_clear: true,
                wrap: None,
            },
            None,
        );
        std::env::remove_var("GITHUB_TOKEN");
        std::env::remove_var("ANTHROPIC_API_KEY");
        let done = runs
            .wait(&started.unwrap().id, Duration::from_secs(15))
            .unwrap();
        let tail = done.tail.join("\n");
        assert!(!tail.contains("secret-github-token"), "{tail}");
        assert!(!tail.contains("secret-anthropic-key"), "{tail}");
        // The allow list still reaches the child, so a shell and a toolchain work.
        assert!(tail.contains("path-kept"), "{tail}");
    }

    #[test]
    fn a_timeout_or_a_stop_ends_the_whole_process_group() {
        let temp = temp("monocode-actions-stop");
        let logs = temp.0.join("logs");
        let runs = ActionRuns::new();
        let mut slow = action("sleep 30 & sleep 30; echo never");
        slow.timeout_seconds = Some(1);
        let started = runs
            .start(
                RunRequest {
                    project_root: &temp.0,
                    cwd: &temp.0,
                    action: &slow,
                    trigger: "app",
                    log_dir: &logs,
                    path_env: None,
                    env: Vec::new(),
                    env_clear: false,
                    wrap: None,
                },
                None,
            )
            .unwrap();
        let done = runs.wait(&started.id, Duration::from_secs(15)).unwrap();
        assert_eq!(done.status, RunStatus::TimedOut);
        assert!(!done.tail.contains(&"never".to_string()));

        let mut server = action("sleep 30");
        server.long_running = true;
        let started = runs
            .start(
                RunRequest {
                    project_root: &temp.0,
                    cwd: &temp.0,
                    action: &server,
                    trigger: "app",
                    log_dir: &logs,
                    path_env: None,
                    env: Vec::new(),
                    env_clear: false,
                    wrap: None,
                },
                None,
            )
            .unwrap();
        assert_eq!(
            runs.wait(&started.id, Duration::from_millis(300))
                .unwrap()
                .status,
            RunStatus::Running
        );
        runs.stop(&started.id).unwrap();
        let done = runs.wait(&started.id, Duration::from_secs(10)).unwrap();
        assert_eq!(done.status, RunStatus::Stopped);
    }

    #[test]
    fn actions_run_only_in_checkouts_of_their_project() {
        let temp = temp("monocode-actions-checkout");
        let main = repo(&temp.0);
        let tree = temp.0.join("tree");
        crate::fs::git_checked(
            &main,
            &["worktree", "add", "-b", "feature", tree.to_str().unwrap()],
        )
        .unwrap();
        assert_eq!(
            checkout_of_project(&tree).unwrap(),
            (main.clone(), tree.clone())
        );
        assert_eq!(
            checkout_of_project(&main).unwrap(),
            (main.clone(), main.clone())
        );
        let inside = main.join("sub");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(checkout_of_project(&inside).is_err());
        assert!(checkout_of_project(&temp.0).is_err());
    }
}
