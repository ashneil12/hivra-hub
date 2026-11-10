//! WP-134b: start a More agents process.
//!
//! A More agent is a command the person already has installed, named on the More agents page. This module starts it
//! the way the page described it and registers it with the same host as every other chat process, so `harness_write`
//! and `harness_kill` reach it and its output comes back on the same events.
//!
//! What it does not do: resolve one of the eleven CLIs (those have their own start in `harness_spawn`), download or
//! install anything, open a port, or hand the child the app's control port or a model key. The arguments are literal
//! strings and no shell reads them. The child gets the app's environment plus the variables typed on that one entry,
//! and nothing from another entry. Those values are never logged and never put in an error.
//!
//! A child module of `harness` so it can share the host's private pieces without widening them.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::{
    is_executable_file, prepare_child, spawn_managed, spawn_output_batcher, terminate,
    which_in_path, HarnessExit, HarnessHost, HarnessLines, LiveChild, EXIT_EVENT,
    OUTPUT_DRAIN_WAIT, SPAWN_CANCELLED, STDOUT_EVENT,
};
use crate::fs::expand_home;

const MAX_TEXT: usize = 4096;
const MAX_ARGS: usize = 64;
const MAX_ENV: usize = 32;

/// The eleven CLIs, which have their own start. `src/features/sessions/model/session.ts` (`HARNESSES`) is the source;
/// a test reads it and fails when the two disagree. `cursor-agent` and the Antigravity server are the binaries two of
/// them run.
const BUILTIN_BINARIES: [&str; 13] = [
    "claude",
    "codex",
    "cursor",
    "grok",
    "opencode",
    "pi",
    "omp",
    "fx",
    "hermes",
    "antigravity",
    "devin",
    "cursor-agent",
    "agy_acp_server.par",
];

const SHELLS: [&str; 9] = [
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "cmd",
    "powershell",
    "pwsh",
    "env",
];

/// What the app puts in a chat process's environment so that process can call back into the app. A More agent never
/// gets them, and an entry cannot name them (the `MONOCODE_` prefix is reserved).
const APP_GRANT_VARIABLES: [&str; 4] = [
    "MONOCODE_CONTROL_ENDPOINT",
    "MONOCODE_CONTROL_TOKEN",
    "MONOCODE_APP_ENDPOINT",
    "MONOCODE_APP_TOKEN",
];

/// One environment variable typed on an entry. The value is a secret as far as logs go.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct RegistryEnv {
    name: String,
    value: String,
}

impl std::fmt::Debug for RegistryEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegistryEnv")
            .field("name", &self.name)
            .field("value", &"<hidden>")
            .finish()
    }
}

/// A request that passed every check that needs no disk.
#[derive(Debug, PartialEq, Eq)]
struct Checked {
    args: Vec<String>,
    env: Vec<(String, String)>,
}

fn plain_text(text: &str) -> bool {
    text.len() <= MAX_TEXT && !text.contains('\0') && !text.contains('\n') && !text.contains('\r')
}

fn session_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The file name of `command`, lowercased, without a Windows launcher extension.
fn binary_name(command: &str) -> String {
    let base = command
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_ascii_lowercase();
    for extension in [".exe", ".bat", ".cmd"] {
        if let Some(stem) = base.strip_suffix(extension) {
            return stem.to_string();
        }
    }
    base
}

fn env_name_ok(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn env_name_reserved(name: &str) -> bool {
    name.starts_with("MONOCODE_")
        || name.starts_with("DYLD_")
        || name == "LD_PRELOAD"
        || name == "LD_LIBRARY_PATH"
        || name == "NODE_OPTIONS"
}

/// The shape of a request, before any file is touched. A refusal names the problem and never a value.
fn check_request(
    session_id: &str,
    command: &str,
    args: &[String],
    env: &[RegistryEnv],
) -> Result<Checked, String> {
    if !session_id_ok(session_id) {
        return Err("registry-invalid: the chat id is not valid".into());
    }
    if command.trim().is_empty() || !plain_text(command) {
        return Err("registry-invalid: the command is not valid".into());
    }
    if command.chars().any(|c| {
        matches!(
            c,
            '|' | '&' | ';' | '<' | '>' | '`' | '$' | '(' | ')' | '{' | '}'
        )
    }) {
        return Err("registry-invalid: the command is not a single executable".into());
    }
    let has_separator = command.contains('/') || command.contains('\\');
    if !has_separator && command.chars().any(char::is_whitespace) {
        return Err("registry-invalid: the command is not a single executable".into());
    }
    if command.split(['/', '\\']).any(|part| part == "..") {
        return Err("registry-invalid: the command cannot contain ..".into());
    }
    let name = binary_name(command);
    if SHELLS.contains(&name.as_str()) {
        return Err("registry-invalid: a shell is not an agent".into());
    }
    if BUILTIN_BINARIES.contains(&name.as_str()) {
        return Err("registry-builtin: that command is one of the built-in CLIs".into());
    }
    if args.len() > MAX_ARGS || args.iter().any(|arg| !plain_text(arg)) {
        return Err("registry-invalid: an argument is not valid".into());
    }
    if env.len() > MAX_ENV {
        return Err("registry-invalid: there are too many environment variables".into());
    }
    let mut seen: Vec<&str> = Vec::new();
    let mut pairs = Vec::with_capacity(env.len());
    for item in env {
        if !env_name_ok(&item.name) || env_name_reserved(&item.name) {
            return Err("registry-invalid: an environment name is not valid".into());
        }
        if seen.contains(&item.name.as_str()) {
            return Err("registry-invalid: an environment name is repeated".into());
        }
        if !plain_text(&item.value) {
            return Err("registry-invalid: an environment value is not valid".into());
        }
        seen.push(&item.name);
        pairs.push((item.name.clone(), item.value.clone()));
    }
    Ok(Checked {
        args: args.to_vec(),
        env: pairs,
    })
}

/// The executable `command` names: an absolute path (after `~`), or a bare name found on `search_path`. A relative
/// path with a separator is not resolved against anything, so it is not found.
fn resolve_program(command: &str, search_path: &str) -> Option<PathBuf> {
    if command.contains('/') || command.contains('\\') || command.starts_with('~') {
        let path = expand_home(command);
        return (path.is_absolute() && is_executable_file(&path)).then_some(path);
    }
    which_in_path(search_path, command)
}

/// Everything that goes on the command except the program and the pipes. Later settings win over earlier ones, so the
/// entry's own variables come last.
fn apply_entry(cmd: &mut Command, checked: &Checked, workdir: &Path) {
    cmd.args(&checked.args).current_dir(workdir);
    for name in APP_GRANT_VARIABLES {
        cmd.env_remove(name);
    }
    for (name, value) in &checked.env {
        cmd.env(name, value);
    }
}

/// Start the process and register it with `host`. `emit_lines` receives batches of stdout lines. `on_exit` runs once
/// the process has ended and its last output has gone out, with its exit code and pid.
fn start_child<L, X>(
    host: &HarnessHost,
    session_id: &str,
    program: &Path,
    checked: &Checked,
    workdir: &Path,
    emit_lines: L,
    on_exit: X,
) -> Result<u32, String>
where
    L: FnMut(Vec<String>) + Send + 'static,
    X: FnOnce(Option<i32>, u32) + Send + 'static,
{
    let (epoch, kill_all, prev) = host.begin_spawn(session_id);
    if let Some(prev) = prev {
        terminate(prev.pid);
    }

    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    prepare_child(&mut cmd, &program.to_string_lossy());
    apply_entry(&mut cmd, checked, workdir);

    let mut child = spawn_managed(&mut cmd).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "registry-not-found: the command could not be started".to_string()
        } else {
            format!(
                "registry-start: the command could not be started ({})",
                error.kind()
            )
        }
    })?;
    let pid = child.id();

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "registry-start: the agent's input could not be opened".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "registry-start: the agent's output could not be opened".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "registry-start: the agent's errors could not be opened".to_string())?;

    let run = host.runs.start(session_id, pid, &workdir.to_string_lossy());
    let live = Arc::new(LiveChild {
        cwd: workdir.to_path_buf(),
        stdin: Mutex::new(stdin),
        pid,
        identity: crate::resources::identity(pid),
        account: None,
        run: Some(run.clone()),
    });
    if let Some(rejected) = host.install_spawn(session_id.to_string(), epoch, kill_all, live) {
        run.lock()
            .unwrap_or_else(|e| e.into_inner())
            .exited(crate::harness_runs::now_ms());
        // A stop, or a newer start, won the race while this one was forking. Reap it without saying anything.
        terminate(rejected.pid);
        thread::spawn(move || {
            let _ = child.wait();
        });
        return Err(SPAWN_CANCELLED.to_string());
    }

    let (stdout_tx, stdout_drained) = spawn_output_batcher(emit_lines);
    let stdout_run = run.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if crate::harness_runs::ends_turn(&line) {
                stdout_run
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .output(&line, crate::harness_runs::now_ms());
            }
            if stdout_tx.send(line).is_err() {
                break;
            }
        }
    });

    // Read and dropped: an agent that fills its error pipe would stop, and its errors can carry what the person typed.
    thread::spawn(move || {
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
    });

    thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        run.lock()
            .unwrap_or_else(|e| e.into_inner())
            .exited(crate::harness_runs::now_ms());
        // The last batched lines go out before the exit that follows them.
        let _ = stdout_drained.recv_timeout(OUTPUT_DRAIN_WAIT);
        on_exit(code, pid);
    });

    Ok(pid)
}

/// Start the More agents process for one chat. Fails closed: every refusal is an error string the page turns into one
/// fixed sentence, and nothing is started.
#[tauri::command(async)]
pub fn registry_agent_spawn(
    app: AppHandle,
    host: State<'_, HarnessHost>,
    session_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<RegistryEnv>,
) -> Result<u32, String> {
    // A bench starts only the plan's wrapper.
    crate::verify_live::provider_start_allowed(crate::verify_live::plan(), None, &command)?;
    let checked = check_request(&session_id, &command, &args, &env)?;
    let program = resolve_program(&command, &super::gui_search_path()).ok_or_else(|| {
        "registry-not-found: the command is not an executable on this Mac".to_string()
    })?;
    let workdir = expand_home(&cwd);
    if !workdir.is_dir() {
        return Err("registry-cwd: the working folder does not exist".to_string());
    }
    let _reservation = crate::worktree_lifecycle::reserve_spawn(&workdir)?;

    let stdout_app = app.clone();
    let stdout_id = session_id.clone();
    let exit_app = app.clone();
    let exit_id = session_id.clone();
    start_child(
        &host,
        &session_id,
        &program,
        &checked,
        &workdir,
        move |lines| {
            let _ = stdout_app.emit(
                STDOUT_EVENT,
                HarnessLines {
                    session_id: stdout_id.clone(),
                    lines,
                },
            );
        },
        move |code, pid| {
            if let Some(host) = exit_app.try_state::<HarnessHost>() {
                host.remove_if_pid(&exit_id, pid);
            }
            let _ = exit_app.emit(
                EXIT_EVENT,
                HarnessExit {
                    session_id: exit_id,
                    code,
                    pid,
                },
            );
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str, value: &str) -> RegistryEnv {
        RegistryEnv {
            name: name.into(),
            value: value.into(),
        }
    }

    fn check(command: &str) -> Result<Checked, String> {
        check_request("chat-1", command, &[], &[])
    }

    fn refused(result: Result<Checked, String>) -> String {
        result.expect_err("the request must be refused")
    }

    #[test]
    fn a_plain_command_with_literal_arguments_passes() {
        let args = vec!["acp".to_string(), "--flag=$HOME; rm x".to_string()];
        let checked = check_request(
            "chat-1",
            "/opt/agents/my agent",
            &args,
            &[env("MODE", "one")],
        )
        .unwrap();
        // Nothing is expanded or split.
        assert_eq!(checked.args, args);
        assert_eq!(checked.env, vec![("MODE".to_string(), "one".to_string())]);
        assert!(check("my-agent").is_ok());
    }

    #[test]
    fn the_eleven_clis_and_their_binaries_are_never_a_more_agent() {
        for name in BUILTIN_BINARIES {
            assert!(
                refused(check(name)).starts_with("registry-builtin"),
                "{name} should be refused"
            );
            assert!(
                refused(check(&format!("/usr/local/bin/{name}"))).starts_with("registry-builtin")
            );
        }
        assert!(refused(check("C:\\tools\\Claude.EXE")).starts_with("registry-builtin"));
        assert!(refused(check("/opt/CODEX")).starts_with("registry-builtin"));
    }

    #[test]
    fn this_list_matches_the_eleven_the_page_knows() {
        let source = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/features/sessions/model/session.ts"),
        )
        .unwrap();
        let start = source.find("export const HARNESSES").unwrap();
        let body = &source[start..];
        // `HARNESSES: HarnessId[] = [` has two brackets: the list starts after the `=`.
        let open = body.find("= [").unwrap() + 3;
        let list = &body[open..open + body[open..].find(']').unwrap()];
        let ids: Vec<&str> = list
            .split(',')
            .map(|item| item.trim().trim_matches('"'))
            .filter(|item| !item.is_empty())
            .collect();
        assert_eq!(ids.len(), 11);
        for id in &ids {
            assert!(
                BUILTIN_BINARIES.contains(id),
                "{id} is a CLI the list does not know"
            );
        }
        for name in BUILTIN_BINARIES {
            let extra = matches!(name, "cursor-agent" | "agy_acp_server.par");
            assert!(
                extra || ids.contains(&name),
                "{name} is not one of the eleven"
            );
        }
    }

    #[test]
    fn a_shell_or_a_command_line_is_refused() {
        for command in [
            "sh",
            "/bin/bash",
            "zsh",
            "cmd.exe",
            "pwsh",
            "env",
            "/usr/bin/env",
        ] {
            assert!(refused(check(command)).contains("shell"), "{command}");
        }
        for command in [
            "my-agent acp",
            "my-agent; rm -rf x",
            "a|b",
            "a&&b",
            "$(whoami)",
            "`id`",
            "../escape/agent",
            "/opt/../agent",
            "",
            "   ",
            "a\nb",
            "a\0b",
        ] {
            assert!(check(command).is_err(), "{command:?} should be refused");
        }
        let long = "a".repeat(MAX_TEXT + 1);
        assert!(check(&long).is_err());
    }

    #[test]
    fn a_bad_chat_id_is_refused() {
        for id in ["", "a b", "../x", "a/b", &"x".repeat(129)] {
            assert!(check_request(id, "my-agent", &[], &[]).is_err(), "{id:?}");
        }
        assert!(check_request("chat_1-A", "my-agent", &[], &[]).is_ok());
    }

    #[test]
    fn arguments_are_bounded_and_single_line() {
        let many = vec!["x".to_string(); MAX_ARGS + 1];
        assert!(check_request("c", "my-agent", &many, &[]).is_err());
        for bad in ["a\nb", "a\0b", &"x".repeat(MAX_TEXT + 1)] {
            assert!(check_request("c", "my-agent", &[bad.to_string()], &[]).is_err());
        }
        let edge = vec!["x".repeat(MAX_TEXT); MAX_ARGS];
        assert!(check_request("c", "my-agent", &edge, &[]).is_ok());
    }

    #[test]
    fn environment_names_and_values_are_checked_and_never_echoed() {
        let secret = "s3cret-value";
        for (name, why) in [
            ("1BAD", "starts with a digit"),
            ("A-B", "has a dash"),
            ("", "is empty"),
            ("MONOCODE_CONTROL_TOKEN", "reserved"),
            ("MONOCODE_ANYTHING", "reserved prefix"),
            ("DYLD_INSERT_LIBRARIES", "reserved prefix"),
            ("LD_PRELOAD", "reserved"),
            ("LD_LIBRARY_PATH", "reserved"),
            ("NODE_OPTIONS", "reserved"),
        ] {
            let message = refused(check_request("c", "my-agent", &[], &[env(name, secret)]));
            assert!(!message.contains(secret), "{name} {why}: the value leaked");
        }
        let repeated = refused(check_request(
            "c",
            "my-agent",
            &[],
            &[env("A", secret), env("A", secret)],
        ));
        assert!(!repeated.contains(secret));
        let newline = refused(check_request("c", "my-agent", &[], &[env("A", "x\ny")]));
        assert!(!newline.contains("x\ny"));
        let too_many: Vec<RegistryEnv> =
            (0..=MAX_ENV).map(|i| env(&format!("V{i}"), "x")).collect();
        assert!(check_request("c", "my-agent", &[], &too_many).is_err());
        assert!(
            check_request("c", "my-agent", &[], &[env("PATH", "/x"), env("_ok1", "v")]).is_ok()
        );
    }

    #[test]
    fn an_environment_value_never_shows_in_a_debug_line() {
        let shown = format!("{:?}", env("TOKEN", "s3cret-value"));
        assert!(shown.contains("TOKEN"));
        assert!(!shown.contains("s3cret-value"));
    }

    #[test]
    fn the_app_s_own_grants_are_removed_from_the_child() {
        let checked = check_request("c", "my-agent", &[], &[env("MODE", "one")]).unwrap();
        let mut cmd = Command::new("true");
        apply_entry(&mut cmd, &checked, Path::new("/"));
        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for name in APP_GRANT_VARIABLES {
            assert!(
                envs.contains(&(name.to_string(), None)),
                "{name} must be removed, not inherited"
            );
        }
        assert!(envs.contains(&("MODE".to_string(), Some("one".to_string()))));
    }

    #[cfg(unix)]
    mod processes {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::mpsc;
        use std::time::Duration;

        fn scratch(label: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "monocode-registry-agent-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        #[test]
        fn a_path_is_found_only_when_it_is_an_absolute_executable() {
            let dir = scratch("resolve");
            let agent = script(&dir, "my-agent", "exit 0");
            let plain = dir.join("not-executable");
            std::fs::write(&plain, "x").unwrap();
            let search = dir.to_string_lossy().into_owned();

            assert_eq!(
                resolve_program(&agent.to_string_lossy(), ""),
                Some(agent.clone())
            );
            assert_eq!(resolve_program("my-agent", &search), Some(agent));
            assert_eq!(resolve_program("not-executable", &search), None);
            assert_eq!(resolve_program(&plain.to_string_lossy(), ""), None);
            assert_eq!(resolve_program(&dir.to_string_lossy(), ""), None);
            assert_eq!(resolve_program("missing-agent", &search), None);
            assert_eq!(resolve_program("my-agent", ""), None);
            // A relative path is not guessed at.
            assert_eq!(resolve_program("./my-agent", &search), None);
            assert_eq!(resolve_program("sub/my-agent", &search), None);
            let _ = std::fs::remove_dir_all(&dir);
        }

        struct Run {
            lines: mpsc::Receiver<Vec<String>>,
            exit: mpsc::Receiver<(Option<i32>, u32)>,
            pid: u32,
        }

        fn run(
            host: &HarnessHost,
            session: &str,
            program: &Path,
            args: &[&str],
            env_pairs: &[(&str, &str)],
            workdir: &Path,
        ) -> Result<Run, String> {
            let request_args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            let request_env: Vec<RegistryEnv> = env_pairs.iter().map(|(n, v)| env(n, v)).collect();
            let checked = check_request(session, "my-agent", &request_args, &request_env)?;
            let (line_tx, lines) = mpsc::channel();
            let (exit_tx, exit) = mpsc::channel();
            let pid = start_child(
                host,
                session,
                program,
                &checked,
                workdir,
                move |batch| {
                    let _ = line_tx.send(batch);
                },
                move |code, pid| {
                    let _ = exit_tx.send((code, pid));
                },
            )?;
            Ok(Run { lines, exit, pid })
        }

        fn collect(run: &Run, until: &str) -> Vec<String> {
            let mut all = Vec::new();
            while let Ok(batch) = run.lines.recv_timeout(Duration::from_secs(10)) {
                all.extend(batch);
                if all.iter().any(|line| line.starts_with(until)) {
                    break;
                }
            }
            all
        }

        fn write_line(host: &HarnessHost, session: &str, line: &str) {
            use std::io::Write;
            let live = host.get(session).expect("the child is registered");
            let mut stdin = live.stdin.lock().unwrap();
            stdin.write_all(line.as_bytes()).unwrap();
            stdin.write_all(b"\n").unwrap();
            stdin.flush().unwrap();
        }

        #[test]
        fn the_agent_gets_its_own_arguments_environment_and_folder_and_answers_on_the_same_pipes() {
            let dir = scratch("run");
            let agent = script(
                &dir,
                "my-agent",
                "echo \"arg1=$1\"\necho \"arg2=$2\"\necho \"mode=$MODE\"\necho \"other=${OTHER_ENTRY-unset}\"\necho \"token=${MONOCODE_CONTROL_TOKEN-unset}\"\necho \"pwd=$(pwd -P)\"\nwhile read line; do echo \"heard=$line\"; done",
            );
            let host = HarnessHost::new();
            let started = run(
                &host,
                "chat-1",
                &agent,
                &["acp", "--flag=$HOME; echo hi"],
                &[("MODE", "typed-value")],
                &dir,
            )
            .unwrap();
            assert!(started.pid > 1);

            let seen = collect(&started, "pwd=");
            assert!(seen.contains(&"arg1=acp".to_string()), "{seen:?}");
            // No shell read the second argument.
            assert!(
                seen.contains(&"arg2=--flag=$HOME; echo hi".to_string()),
                "{seen:?}"
            );
            assert!(seen.contains(&"mode=typed-value".to_string()), "{seen:?}");
            // Another entry's variable is not here, and neither is a control grant.
            assert!(seen.contains(&"other=unset".to_string()), "{seen:?}");
            assert!(seen.contains(&"token=unset".to_string()), "{seen:?}");
            let canonical = std::fs::canonicalize(&dir).unwrap();
            assert!(
                seen.contains(&format!("pwd={}", canonical.display())),
                "{seen:?}"
            );

            write_line(&host, "chat-1", "{\"jsonrpc\":\"2.0\"}");
            let echoed = collect(&started, "heard={\"jsonrpc\":\"2.0\"}");
            assert!(
                echoed.contains(&"heard={\"jsonrpc\":\"2.0\"}".to_string()),
                "{echoed:?}"
            );

            // Stopping it by chat id reaches the process and the exit comes back with its pid.
            let live = host
                .kill_session("chat-1")
                .expect("registered under the chat id");
            terminate(live.pid);
            let (_, exited_pid) = started.exit.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(exited_pid, started.pid);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn two_agents_do_not_see_each_others_variables() {
            let dir = scratch("two");
            let agent = script(
                &dir,
                "my-agent",
                "echo \"mine=${SECRET_A-no}/${SECRET_B-no}\"\nsleep 30",
            );
            let host = HarnessHost::new();
            let first = run(&host, "chat-a", &agent, &[], &[("SECRET_A", "alpha")], &dir).unwrap();
            let second = run(&host, "chat-b", &agent, &[], &[("SECRET_B", "bravo")], &dir).unwrap();
            assert!(collect(&first, "mine=alpha/no").contains(&"mine=alpha/no".to_string()));
            assert!(collect(&second, "mine=no/bravo").contains(&"mine=no/bravo".to_string()));
            for session in ["chat-a", "chat-b"] {
                let live = host.kill_session(session).unwrap();
                terminate(live.pid);
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_command_that_cannot_start_is_an_error_and_registers_nothing() {
            let dir = scratch("missing");
            let missing = dir.join("no-such-agent");
            let host = HarnessHost::new();
            let error = run(&host, "chat-1", &missing, &[], &[], &dir)
                .err()
                .expect("starting a missing file must fail");
            assert!(error.starts_with("registry-not-found"), "{error}");
            assert!(host.get("chat-1").is_none());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn an_agent_that_exits_on_its_own_still_reports_its_exit_and_last_output() {
            let dir = scratch("exit");
            let agent = script(&dir, "my-agent", "echo last-words\nexit 7");
            let host = HarnessHost::new();
            let started = run(&host, "chat-1", &agent, &[], &[], &dir).unwrap();
            let (code, pid) = started.exit.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(code, Some(7));
            assert_eq!(pid, started.pid);
            // The line it printed was delivered before the exit was reported.
            let mut lines = Vec::new();
            while let Ok(batch) = started.lines.try_recv() {
                lines.extend(batch);
            }
            assert_eq!(lines, vec!["last-words".to_string()]);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_second_start_for_the_same_chat_replaces_the_first() {
            let dir = scratch("replace");
            let agent = script(&dir, "my-agent", "sleep 30");
            let host = HarnessHost::new();
            let first = run(&host, "chat-1", &agent, &[], &[], &dir).unwrap();
            let second = run(&host, "chat-1", &agent, &[], &[], &dir).unwrap();
            assert_ne!(first.pid, second.pid);
            assert_eq!(host.get("chat-1").map(|live| live.pid), Some(second.pid));
            // The replaced process is stopped and reports its exit.
            assert!(first.exit.recv_timeout(Duration::from_secs(10)).is_ok());
            let live = host.kill_session("chat-1").unwrap();
            terminate(live.pid);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
