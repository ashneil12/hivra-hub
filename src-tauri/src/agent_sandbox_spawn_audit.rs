//! Every process start under `src-tauri/src` is wrapped in the agent sandbox, or named in `ALLOW` with a reason.
//!
//! A start is `Command::new`, an empty `.spawn()`, `.output()` or `.status()` (turbofish allowed, HTTP
//! `response.status()` is not a start), an empty `.exec()` (it replaces the process), `open::that` or
//! `open::that_detached` (they start `/usr/bin/open`), or a call that runs a command built elsewhere:
//! `bounded::run`, `run_collected`, `spawn_managed`, `spawn_command`, `delivery::child`, and a
//! `use ... as` alias of one of those.
//! It is not a start when it sits in a comment or a string, when the call takes arguments (a thread, a
//! rayon scope, or some other method), or when it is test-only. Test-only means a `#[cfg(test)]` function,
//! a `#[cfg(test)]` module body, or a file brought in by `#[cfg(test)] mod` (including `tests.rs`). Those are
//! not in the binary.
//!
//! Wrapped means the smallest function that contains the start also contains a sandbox marker
//! (`contained_command`, `under_wrap`, `sandboxed_launch`, `action_wrap`, `more_agent_wrap`,
//! `SANDBOX_EXEC`, `sandbox-exec`), or the function is one of those. A marker only inside a nested function
//! does not cover the outer one. `git_cmd::command_for` counts as wrapped because it starts `sandbox-exec`
//! when the setting is on. Its plain branch is the setting being off, and Ash's own Commit, Push and Pull.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MARKERS: &[&str] = &[
    "contained_command",
    "under_wrap",
    "sandboxed_launch",
    "action_wrap",
    "more_agent_wrap",
    "SANDBOX_EXEC",
    "sandbox-exec",
];

/// `file` is relative to `src-tauri/src` with `/` separators. `function` is the smallest function that
/// contains the start. The reason says why that start is safe without the agent sandbox around it.
const ALLOW: &[(&str, &str, &str)] = &[
    (
        "agent_sandbox.rs",
        "preflight_with",
        "Runs /usr/bin/true under the sandbox-exec path it was given, to prove the profile starts. The parameter is named sandbox_exec, so the marker scan misses it.",
    ),
    (
        "agent_sandbox.rs",
        "self_check_in",
        "The sandbox self-check. Starts that same launcher on a fixed probe script in a temporary home.",
    ),
    (
        "attribution/git.rs",
        "run_once",
        "Spawns a Command the caller built. Callers are the app's own git reads, with an allow-listed environment.",
    ),
    (
        "attribution/git.rs",
        "stop",
        "kill or taskkill of a pid this app started.",
    ),
    (
        "autopilot.rs",
        "bootout",
        "/bin/launchctl bootout of this app's own LaunchAgent. Fixed program and args.",
    ),
    (
        "autopilot.rs",
        "bootstrap",
        "/bin/launchctl bootstrap of the watcher plist this app wrote.",
    ),
    (
        "autopilot.rs",
        "launch_domain",
        "/bin/launchctl print gui/<uid>, to choose gui or user. Fixed program.",
    ),
    (
        "autopilot.rs",
        "loaded",
        "/bin/launchctl print of this app's own label.",
    ),
    (
        "autopilot.rs",
        "watch_main",
        "/usr/bin/open of the bundle running.json names, and only when that path is an existing .app, after a crash.",
    ),
    (
        "backups/mod.rs",
        "spawn_app",
        "This app's own executable, environment cleared to an allow list, to reopen after a restore.",
    ),
    (
        "backups/mod.rs",
        "spawn_helper",
        "This app's own executable with the fixed argument backup-restore. Environment cleared to an allow list.",
    ),
    (
        "browser/engine.rs",
        "fetch_chromium",
        "node on playwright/cli.js inside the browser data folder, arguments install chromium. Any other path is refused.",
    ),
    (
        "browser/mod.rs",
        "command_line",
        "ps, or a fixed PowerShell CIM query, for one pid's command line. Two copies, one reason.",
    ),
    (
        "browser/mod.rs",
        "kill_one",
        "taskkill of a browser pid this app recorded. Unix uses libc::kill and starts no process.",
    ),
    (
        "browser/mod.rs",
        "list_group",
        "ps -g, or a fixed PowerShell parent query, for one process group this app recorded.",
    ),
    (
        "browser/mod.rs",
        "process_start",
        "node on the app's own start-time helper for one pid. Windows reads the process times and starts nothing.",
    ),
    (
        "browser/mod.rs",
        "process_state",
        "ps -o state= for one pid.",
    ),
    (
        "browser/mod.rs",
        "spawn_recorded",
        "Spawns the browser Command the caller built. The child is recorded only after its command line carries the token this app minted.",
    ),
    (
        "connectors/check.rs",
        "stdio_handshake",
        "Spawns stdio_command: the connector Ash configured, environment cleared, to run initialize and tools/list.",
    ),
    (
        "connectors/launch.rs",
        "stdio_command",
        "Builds that connector command. Environment is cleared to an allow list. Not an agent shell.",
    ),
    (
        "delivery/mod.rs",
        "child",
        "Builds a scrubbed command and returns it. It does not spawn. Callers that run the command are their own sites.",
    ),
    (
        "delivery_gate/mod.rs",
        "ensure_daemon",
        "Spawns the command tool_command already wrapped. That wrap allows only the tool's own home. Arguments are daemon run --root, never daemon start.",
    ),
    (
        "delivery_gate/mod.rs",
        "invoke",
        "Spawns the command tool_command already wrapped, for a fixed subcommand (axi run and the other listed ones).",
    ),
    (
        "disclaim.rs",
        "command",
        "Builds the disclaim launcher. An agent CLI is already sandbox-exec before this wraps it.",
    ),
    (
        "disclaim.rs",
        "plain_exec",
        "The disclaim helper runs the argv it was itself started with. Unix and the other copy share this name.",
    ),
    (
        "disclaim.rs",
        "disclaimed_exec",
        "The macOS disclaim helper replaces this process with posix_spawn SETEXEC. When a hash was approved, the file is hashed first and a mismatch does not exec. Not an agent shell.",
    ),
    (
        "external_editor.rs",
        "launch_editor_sync",
        "/usr/bin/open -a of an editor Ash picked, or that editor's own program, on a folder that exists.",
    ),
    (
        "hivra_cloud/mod.rs",
        "hivra_cloud_sign_in",
        "open::that_detached of the Hivra Cloud sign-in address in the browser, after Ash taps Sign in. Not an agent shell.",
    ),
    (
        "programme/gitrun.rs",
        "command",
        "Builds git_cmd::child() for git: scrubbed environment, hooks and fsmonitor off, the container profile while the sandbox is on. A non-git program is only a test's sleeper. Does not spawn.",
    ),
    (
        "programme/gitrun.rs",
        "run_program",
        "Spawns command(), so git_cmd::child(). ensure_safe refuses force and --no-verify first.",
    ),
    (
        "fs.rs",
        "git_hash_object",
        "Spawns git_cmd(), which is git_cmd::git(): the container profile while the sandbox is on, no hooks. Arguments are hash-object.",
    ),
    (
        "fs.rs",
        "git_ignored_names",
        "Same git_cmd(). Arguments are check-ignore.",
    ),
    (
        "fs.rs",
        "git_output_capped",
        "Same git_cmd(), with the read-only arguments the caller passed and GIT_TERMINAL_PROMPT=0.",
    ),
    (
        "fs.rs",
        "reveal_path_sync",
        "open -R, explorer, or xdg-open, of a path Ash asked to show. Fixed programs.",
    ),
    (
        "fs.rs",
        "open_path_with_default_app",
        "open of a path Ash asked to open with the default app. A file that would launch a program (a .command, an .app, a disk image, a script) is refused first. Not inside the agent sandbox.",
    ),
    (
        "gates.rs",
        "run_collected",
        "Spawns a Command the caller built. run_script and run_project_tests wrap with under_wrap before they call this.",
    ),
    (
        "harness.rs",
        "exec_output",
        "Command::new after provider_start_allowed. harness_exec (exec_args_allowed and is_resolved_harness_binary), the MCP probe and harness_update all start here with no sandbox-exec. A swapped binary is refused because the resolved file, its link target, its package folder and the Homebrew prefix are write-denied. The stored-path --version probe is contained_command in contained_version_output.",
    ),
    (
        "harness.rs",
        "read_harness_parents",
        "ps for the parent of pids this app already listed.",
    ),
    (
        "harness.rs",
        "signal_tree",
        "kill or taskkill of a pid in a tree this app started.",
    ),
    (
        "harness.rs",
        "snapshot_from_ps",
        "ps of argv only. It does not ask for the environment.",
    ),
    (
        "harness.rs",
        "spawn_managed",
        "Starts the harness child. An agent CLI is sandbox-exec before a chat reaches here. exec_output (harness_exec, the MCP probe and harness_update) also starts here with no sandbox-exec. The resolved file, its link target, its package folder and the Homebrew prefix are write-denied, which keeps a swapped binary from running.",
    ),
    (
        "harness.rs",
        "spawn_retrying_text_file_busy",
        "The same start, retried when the executable is busy.",
    ),
    (
        "inbox_media.rs",
        "github_auth_token",
        "gh auth token, fixed arguments, so the app can read its own login. The token is not logged.",
    ),
    (
        "land.rs",
        "git",
        "Spawns git_command, which uses git_cmd::git(): the container profile while the sandbox is on.",
    ),
    (
        "local_services/emulate.rs",
        "probe_node_within",
        "node --version on this copy's PATH. A missing Node is a notice.",
    ),
    (
        "local_services/emulate.rs",
        "ps_column",
        "ps -o of one column for one pid.",
    ),
    (
        "local_services/emulate.rs",
        "start",
        "node on the stand-in tool, arguments start --seed --host 127.0.0.1. The environment is cleared to an allow list. An agent cannot start a stack while the sandbox is on.",
    ),
    (
        "macos.rs",
        "relaunch_from_dev_bundle",
        "codesign of the dev bundle this debug build just wrote, then exec of that bundle's own binary. It refuses an identifier that is not a dev copy.",
    ),
    (
        "menu.rs",
        "dispatch",
        "open of a fixed https address (the help menu). Not a path an agent wrote.",
    ),
    (
        "macos.rs",
        "write_dev_bundle_icons",
        "/usr/bin/touch of that same bundle, so Finder notices the new icon.",
    ),
    (
        "notifications.rs",
        "open_settings",
        "open of the system Notifications settings URL, or cmd start ms-settings:notifications. Fixed. Two copies, one reason.",
    ),
    (
        "pasteboard.rs",
        "wl_paste",
        "wl-paste --type of one mime, to read the clipboard a focused client is already allowed to see.",
    ),
    (
        "platform/relaunch.rs",
        "run_powershell",
        "System32 powershell -Command - of the relaunch watcher script this app wrote.",
    ),
    (
        "platform/relaunch.rs",
        "systemctl",
        "systemctl, or MONOCODE_SHIP_SYSTEMCTL, with the arguments this app passes to remove its own unit.",
    ),
    (
        "platform/ship.rs",
        "run_task",
        "System32 powershell of the ship service script this app stored. The environment is allow-listed.",
    ),
    (
        "platform/ship.rs",
        "spawn_app_env",
        "The shipped bundle's own monocode binary, to reopen after a ship.",
    ),
    (
        "platform/ship.rs",
        "systemctl",
        "systemctl --user link and start of the unit this ship stored.",
    ),
    (
        "platform/wake.rs",
        "hold",
        "systemd-inhibit with the app's own wake reason.",
    ),
    (
        "plugins/creator.rs",
        "talk",
        "A program inside the plugin, or a known interpreter running a ./ script inside it, while Ash installs it. The environment is cleared.",
    ),
    (
        "plugins/install.rs",
        "run_steps",
        "A plugin's install steps, while Ash installs it. The environment is cleared down to proxy variables and PLUGIN_ROOT.",
    ),
    (
        "plugins/source.rs",
        "command",
        "Builds git or npm for a plugin Ash is installing. stdin is null. The caller starts it.",
    ),
    (
        "plugins/wiring.rs",
        "prepare_launch",
        "Builds the command for one plugin server Ash installed and left switched on. A plugin that is off or unknown is refused. The caller starts it.",
    ),
    (
        "portable.rs",
        "pathspecs_from_stdin",
        "Spawns the Command the caller built. Callers pass git() (the container profile while the sandbox is on) and feed pathspecs on stdin.",
    ),
    (
        "pr_watch/bounded.rs",
        "run",
        "Spawns a Command the caller built and kills its process group at a deadline. Callers that start gh or a check wrap before they call this, and those callers are their own sites.",
    ),
    (
        "project_actions.rs",
        "command",
        "When wrap is set, the prefix is action_wrap (sandbox-exec). The plain shell is the sandbox off, or Ash's Ship and Run dev slot. Windows is cmd /C and never wraps.",
    ),
    (
        "project_actions.rs",
        "spawn",
        "Spawns the Command that command() built.",
    ),
    (
        "pty.rs",
        "ps_label",
        "ps -o args= for one pid, to label a terminal.",
    ),
    (
        "pty.rs",
        "spawn_unix",
        "Ash's own terminal login shell. The files a login shell sources are write-denied, including the lines installers write, and a login PATH directory that is a link is write-denied where it points. Not wrapped on purpose.",
    ),
    (
        "pty.rs",
        "terminate",
        "taskkill of a terminal pid this app owns. Unix uses libc::kill and starts no process.",
    ),
    (
        "quick_composer.rs",
        "capture_screenshot",
        "/usr/sbin/screencapture -i -x -t png into the app's own screenshot path.",
    ),
    (
        "rate_limits.rs",
        "run_with_timeout",
        "Spawns the Command the caller built. The only caller here is security_run.",
    ),
    (
        "rate_limits.rs",
        "security_delete",
        "security with this app's keychain delete arguments. The sandbox leaves security allowed on purpose.",
    ),
    (
        "rate_limits.rs",
        "security_run",
        "security find-generic-password for this app's own keychain item. Same reason.",
    ),
    (
        "remote_ssh.rs",
        "command",
        "ssh with fixed options, including ForwardAgent=no, PermitLocalCommand=no, ControlMaster=no and ControlPath=none.",
    ),
    (
        "remote_ssh.rs",
        "device_name",
        "scutil --get ComputerName, or hostname. Fixed programs and arguments.",
    ),
    (
        "remote_ssh.rs",
        "run_remote_command",
        "Spawns the ssh that command() built.",
    ),
    (
        "remote_ssh.rs",
        "start_with_command",
        "Spawns that ssh as a forward from 127.0.0.1 to the remote port.",
    ),
    (
        "resources.rs",
        "process_snapshot",
        "/bin/ps -axww of pid, ppid, cpu, rss and command. It does not ask for the environment.",
    ),
    (
        "self_build.rs",
        "npm",
        "npm run of a script in the hub checkout, for this app's own check and build. A chat undo runs this only when the part's delivery is exactly in place.",
    ),
    (
        "self_build.rs",
        "stop_process",
        "/bin/ps of one pid. It signals only when that command line names the preview folder.",
    ),
    (
        "self_build.rs",
        "vite",
        "The worktree's own node_modules vite, or node on that vite.js, for a preview Ash opened.",
    ),
    (
        "ship.rs",
        "designated_requirement",
        "/usr/bin/codesign -d -r- of this app or a staged build.",
    ),
    (
        "ship.rs",
        "output_within",
        "Spawns the Command the caller built. ship_start's command is node on scripts/hub-ship.mjs in a checkout whose package name is monocode-desktop.",
    ),
    (
        "ship.rs",
        "reopen",
        "/usr/bin/open -n of the shipped app, or that bundle's own binary. startup checks the record's mac before it calls this.",
    ),
    (
        "ship.rs",
        "restart_runner",
        "/bin/launchctl of the ship's plist, or node on the runner the ship stored. A record this app did not write is refused.",
    ),
    (
        "ship.rs",
        "ship_start",
        "node on scripts/hub-ship.mjs. A chat's ship is refused while the sandbox is on (agent_ship_refused).",
    ),
    (
        "ship.rs",
        "verify_staged",
        "/usr/bin/codesign --verify --strict --deep of the staged build, after its designated requirement matched this app's.",
    ),
    (
        "spend_ledger.rs",
        "project_folder_for",
        "git rev-parse --path-format=absolute --git-common-dir. Fixed arguments.",
    ),
    (
        "stacks.rs",
        "output_within",
        "Spawns the Command the caller built. scrubbed builds it with env_clear, and an agent cannot start a stack while the sandbox is on.",
    ),
    (
        "stacks.rs",
        "run_timed",
        "Spawns that same scrubbed command.",
    ),
    (
        "stacks.rs",
        "scrubbed",
        "Command::new of the Compose or Docker program Ash started, with the environment cleared.",
    ),
    (
        "terminal_mirror.rs",
        "run",
        "Starts claude only, with an allow-listed environment. It resolves claude (a cask, an npm link, or a versions directory) and runs that file with no sandbox-exec. The resolved file, its link target, its package folder and the Homebrew prefix are write-denied.",
    ),
    (
        "watcher/checks.rs",
        "command_for",
        "Builds the check command and does not start it. run_in wraps it with action_wrap and under_wrap before it runs. Tests call this and stay unsandboxed.",
    ),
    (
        "windows.rs",
        "spawn_in_job",
        "Spawns the Command the caller built, inside a Windows job so its children die with it. The caller names the program.",
    ),
    (
        "worktree_autoclean.rs",
        "output_within",
        "Spawns the Command the caller built. The caller is read_process_folders, which runs /usr/sbin/lsof.",
    ),
    (
        "worktree_autoclean.rs",
        "read_process_folders",
        "/usr/sbin/lsof -d cwd, to see which folders have a program in them before anything is deleted. Linux reads /proc and starts nothing.",
    ),
    (
        "secrets/run.rs",
        "spawn_run",
        "Starts this app's own secret-run helper, the same binary, with a cleared environment. The command an agent chose is execute_controlled, which runs under the agent sandbox. Sandboxing this helper would deny it the database and the keychain, or that command would inherit an allow for them.",
    ),
    (
        "secrets/run.rs",
        "kill_group",
        "taskkill of a process group this app started. Unix uses libc::kill and starts no process.",
    ),
    (
        "azure_devops.rs",
        "azure_devops_repo_for",
        "git config --get-regexp of remote urls, through git_cmd::git(): the container profile while the sandbox is on, hooks off.",
    ),
    (
        "azure_devops.rs",
        "git_unified_hunks",
        "git diff of two temporary files, through git_cmd::git(): the container profile while the sandbox is on, hooks off.",
    ),
    (
        "checkpoint.rs",
        "diff_numstat",
        "git diff --no-index --numstat of two snapshot files, through git_cmd::git(): the container profile while the sandbox is on, hooks off.",
    ),
    (
        "checkpoint.rs",
        "git_head",
        "git rev-parse HEAD through git_cmd::git() after ensure_contained. Read only. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "checkpoint/turn.rs",
        "checked_output",
        "Runs the command the caller built. Callers pass git_command, which is git_cmd::git(): the container profile while the sandbox is on, hooks off.",
    ),
    (
        "connectors/launch.rs",
        "exec_stdio",
        "On Windows, starts the connector command stdio_command built, environment cleared. On Unix this process is replaced with exec. The .status() line is cfg(not(unix)), which the scanner still sees.",
    ),
    (
        "connectors/commands.rs",
        "connector_oauth",
        "open of the connector's own OAuth https address, so Ash can sign in. Not a file path.",
    ),
    (
        "crew/store.rs",
        "checkout_of",
        "bounded::run of fs::git_cmd(), which is git_cmd::git(), for rev-parse. Five second limit. Read only. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "delivery/deliver.rs",
        "git",
        "git_cmd::child(): scrubbed environment, the container profile while the sandbox is on, hooks off.",
    ),
    (
        "delivery/settings.rs",
        "git",
        "git_cmd::child(): scrubbed environment, the container profile while the sandbox is on, hooks off.",
    ),
    (
        "delivery/teardown.rs",
        "clean",
        "git status --porcelain through git_cmd::child(): scrubbed environment, the container profile while the sandbox is on, hooks off.",
    ),
    (
        "delivery/teardown.rs",
        "git_ok",
        "git_cmd::child() for the read the caller names. Scrubbed environment, the container profile while the sandbox is on, hooks off.",
    ),
    (
        "delivery/teardown.rs",
        "head",
        "git rev-parse HEAD through git_cmd::child(): scrubbed environment, the container profile while the sandbox is on, hooks off.",
    ),
    (
        "delivery_gate/mod.rs",
        "git",
        "git_cmd::child(): scrubbed environment, the container profile while the sandbox is on, hooks off.",
    ),
    (
        "firstmate/checkout_guard.rs",
        "git",
        "git_cmd::git() after ensure_contained, then extend_readonly. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "firstmate/gates.rs",
        "git",
        "git_cmd::git() with the arguments the caller passed. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "firstmate/protected_paths.rs",
        "common_git_dir",
        "git rev-parse --git-common-dir through git_cmd::git(). The container profile while the sandbox is on, hooks off.",
    ),
    (
        "fs.rs",
        "clone_repo_sync",
        "git clone through git_cmd_for_args. Clone is git_cmd::git() with hooks off: the container profile while the sandbox is on.",
    ),
    (
        "fs.rs",
        "git_branch_name",
        "git check-ref-format through git_cmd(), which is git_cmd::git(). The container profile while the sandbox is on, hooks off.",
    ),
    (
        "fs.rs",
        "git_checked",
        "git_cmd_for_args. A read is git_cmd::git() (container, hooks off). commit, push, pull and fetch are git_with_hooks: Ash's own, hooks on, not in the container.",
    ),
    (
        "fs.rs",
        "git_output",
        "git_cmd_for_args, same split as git_checked. Reads are the container profile. commit, push, pull and fetch keep Ash's hooks and are not in the container.",
    ),
    (
        "fs.rs",
        "git_selected_context_for",
        "git_cmd() against a private index, for one selection's staged diff. git_cmd() is git_cmd::git(): the container profile while the sandbox is on, hooks off.",
    ),
    (
        "fs.rs",
        "git_stdout",
        "git_cmd(), which is git_cmd::git(). The container profile while the sandbox is on, hooks off.",
    ),
    (
        "fs.rs",
        "locate_path",
        "git rev-parse --show-toplevel through git_cmd(), which is git_cmd::git(). The container profile while the sandbox is on, hooks off.",
    ),
    (
        "git_cmd.rs",
        "apply_scrub",
        "Copies the allow-listed environment from delivery::child onto a command. It does not start it. The scanner sees the delivery::child call.",
    ),
    (
        "gitlab.rs",
        "gitlab_repo_for",
        "git config --get-regexp of remote urls, through git_cmd::git(): the container profile while the sandbox is on, hooks off.",
    ),
    (
        "health.rs",
        "read_git",
        "git --version through fs::git_cmd(), which is git_cmd::git(). The container profile while the sandbox is on, hooks off.",
    ),
    (
        "land.rs",
        "merge3",
        "git merge-file -p of three temporary files, through git_cmd::git(): the container profile while the sandbox is on, hooks off.",
    ),
    (
        "land.rs",
        "refresh",
        "git merge-file of the worker copy against the project, through git_cmd::git(): the container profile while the sandbox is on, hooks off.",
    ),
    (
        "local_hub.rs",
        "make_project_folder",
        "git init -q through git_cmd::git(), after the folder and its README exist. A missing git is ignored. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "plugins/source.rs",
        "run",
        "Starts the command command() built: git or npm for a plugin Ash is installing. stdin is null. Not an agent shell.",
    ),
    (
        "plugins/wiring.rs",
        "run_main",
        "On Windows, starts the plugin server prepare_launch built. On Unix this process is replaced with exec. The .status() line is cfg(not(unix)), which the scanner still sees.",
    ),
    (
        "portable.rs",
        "history_bundle",
        "git log and git bundle create through git_cmd::git(), for one memory folder. A history that looks like it holds a secret is left out. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "portable.rs",
        "restore_history",
        "git clone and the later git commands through git_cmd::git(), with an empty config, attributes and hooks directory, to restore one memory folder from a checked bundle.",
    ),
    (
        "portable/folders.rs",
        "linked_worktrees",
        "git rev-parse --show-toplevel through fs::git_cmd(), which is git_cmd::git(), to list a project's linked worktrees. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "pr_watch/checkout.rs",
        "git_within",
        "bounded::run of git_cmd::git() after ensure_contained. Read only, with a timeout. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "pr_watch/github.rs",
        "run_with_timeout",
        "bounded::run of the command the caller built. Both callers (rest and graphql) use contained_command before they hand it over.",
    ),
    (
        "self_build.rs",
        "git",
        "git_cmd::git() for this app's own hub-change git, with a fixed user and signing off. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "stacks.rs",
        "git_line",
        "scrubbed git, environment cleared, to read this worktree's git dir before an env file is written. Not an agent shell.",
    ),
    (
        "stacks.rs",
        "remove_by_label",
        "docker ps filtered by this compose project's label, then stop and rm of those container ids. The command is scrubbed docker. An agent cannot start a stack while the sandbox is on.",
    ),
    (
        "worktree_janitor.rs",
        "git_out",
        "git_cmd::git() after ensure_contained, then extend_readonly. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "worktree_pool.rs",
        "git",
        "git_cmd::child(): scrubbed environment, the container profile while the sandbox is on, hooks off.",
    ),
    (
        "worktrees.rs",
        "git",
        "git_cmd::git() after ensure_contained, then extend_readonly. The container profile while the sandbox is on, hooks off.",
    ),
    (
        "dictation.rs",
        "start",
        "The Hub does not spawn the helper. launchd runs it while the setting is on. Never started by an agent, so not inside the agent sandbox.",
    ),
    (
        "commit_guard.rs",
        "push_url",
        "Spawns fs::git_cmd(), which is git_cmd::git(): the container profile while the sandbox is on, no hooks. Arguments are remote get-url --push.",
    ),
    (
        "commit_guard/objects.rs",
        "iconv_utf8",
        "Builds iconv -f <encoding> -t UTF-8 for read_capped, which feeds it the bytes of one change on stdin. A fixed program and arguments, run by the commit guard, not by an agent.",
    ),
    (
        "commit_guard/objects.rs",
        "read_capped",
        "Spawns a Command the caller built (the commit guard's own git reads and iconv) with a time and size cap. The callers are their own sites.",
    ),
];

struct Site {
    file: String,
    func: String,
    line: usize,
    wrapped: bool,
}

struct Func {
    name: String,
    start: usize,
    end: usize,
    test_only: bool,
}

struct Decl {
    name: String,
    path_attr: Option<String>,
}

struct Scan<'a> {
    file: &'a str,
    masked: &'a str,
    funcs: &'a [Func],
    test_mods: &'a [(usize, usize)],
}

enum Item {
    File,
    Inline { body: usize, end: usize },
    None,
}

#[test]
fn every_process_start_is_wrapped_or_explained() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    assert!(root.is_dir(), "missing {}", root.display());
    let sites = collect(&root);
    let mut fresh = Vec::new();
    for site in &sites {
        if site.wrapped
            || ALLOW
                .iter()
                .any(|row| row.0 == site.file && row.1 == site.func)
        {
            continue;
        }
        fresh.push(format!("{} {} (line {})", site.file, site.func, site.line));
    }
    fresh.sort();
    fresh.dedup();
    let dump = std::env::temp_dir().join("hivra-wp178-spawn-sites.txt");
    let _ = fs::write(&dump, fresh.join("\n"));
    assert!(
        fresh.is_empty(),
        "a process start is neither wrapped nor explained ({}). Wrote {}.\n{}",
        fresh.len(),
        dump.display(),
        fresh.join("\n")
    );
    for (file, func, why) in ALLOW {
        assert!(!why.trim().is_empty(), "{file} {func} has an empty reason");
        assert!(
            sites
                .iter()
                .any(|site| site.file == *file && site.func == *func && !site.wrapped),
            "allow list names {file} {func}, which is gone or now wrapped"
        );
    }
}

#[test]
fn the_scanner_ignores_comments_strings_tests_and_nested_markers() {
    let src = r##"
        fn real() { Command::new("git"); }
        fn wrapped() { Command::new(SANDBOX_EXEC); }
        fn mentioned() { let _ = "Command::new"; }
        fn rawish() { let _ = r#"Command::new("x")"#; }
        fn commented() { /* Command::new("x") { } */ }
        // Command::new("nope")
        #[cfg(test)]
        fn only_test() { Command::new("t"); }
        #[cfg(not(test))]
        fn not_a_test() { Command::new("git"); }
        #[cfg(test)]
        mod tests {
            fn inside() { Command::new("x"); }
        }
        fn threaded() { scope.spawn(|| {}); }
        fn uses_thread() { std::thread::spawn(|| {}); }
        fn launched() { cmd.spawn(); }
        fn multi() {
            command
                .spawn()
        }
        fn outer() {
            fn inner() { let _ = SANDBOX_EXEC; }
            Command::new("outer");
        }
    "##;
    let sites = classify("fixture.rs", src);
    assert!(sites
        .iter()
        .any(|site| site.func == "wrapped" && site.wrapped));
    let mut names: Vec<_> = sites
        .iter()
        .filter(|site| !site.wrapped)
        .map(|site| site.func.as_str())
        .collect();
    names.sort();
    names.dedup();
    assert_eq!(
        names,
        vec!["launched", "multi", "not_a_test", "outer", "real"]
    );
}

#[test]
fn a_cfg_test_declaration_is_a_separate_file_and_a_production_mod_is_not() {
    let src = r#"
        #[cfg(test)]
        mod tests;
        mod project_tests;
        #[cfg(all(test, unix))]
        #[path = "extra_tests.rs"]
        mod extra;
        #[cfg(test)]
        mod inline {
            fn inside() { Command::new("x"); }
        }
    "#;
    let decls = test_mod_decls(src);
    let mut names: Vec<_> = decls.iter().map(|decl| decl.name.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["extra", "tests"]);
    let extra = decls.iter().find(|decl| decl.name == "extra").unwrap();
    assert_eq!(extra.path_attr.as_deref(), Some("extra_tests.rs"));
}

fn collect(root: &Path) -> Vec<Site> {
    let skip = test_only_rels(root);
    let mut files = Vec::new();
    gather_rs(root, &mut files);
    let mut sites = Vec::new();
    for path in files {
        let Some(rel) = rel_path(root, &path) else {
            continue;
        };
        if skip.contains(&rel) {
            continue;
        }
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        sites.extend(classify(&rel, &text));
    }
    sites
}

fn classify(file: &str, src: &str) -> Vec<Site> {
    let masked = mask(src);
    let funcs = functions(&masked);
    let test_mods = test_module_ranges(&masked);
    let scan = Scan {
        file,
        masked: &masked,
        funcs: &funcs,
        test_mods: &test_mods,
    };
    let mut found = Vec::new();
    find_sites(&scan, &mut found);
    found
}

fn test_only_rels(root: &Path) -> HashSet<String> {
    let mut files = Vec::new();
    gather_rs(root, &mut files);
    let mut skip = HashSet::new();
    for path in files {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        for decl in test_mod_decls(&text) {
            let Some(resolved) = resolve_decl(&path, &decl) else {
                continue;
            };
            let Some(rel) = rel_path(root, &resolved) else {
                continue;
            };
            skip.insert(rel);
        }
    }
    skip
}

fn test_mod_decls(src: &str) -> Vec<Decl> {
    let masked = mask(src);
    let bytes = masked.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if !keyword_at(bytes, i, "mod") {
            i += 1;
            continue;
        }
        let start = attribute_start(&masked, i);
        if !is_test_cfg(&masked[start..i]) {
            i += 3;
            continue;
        }
        let name_at = skip_ws(bytes, i + 3);
        let name = read_ident(bytes, name_at);
        if name.is_empty() {
            i += 3;
            continue;
        }
        match following_item(bytes, name_at + name.len()) {
            Item::File => {
                out.push(Decl {
                    name,
                    path_attr: path_attr(&src[start..i]),
                });
                i = name_at + 1;
            }
            Item::Inline { body, .. } => i = body + 1,
            Item::None => i += 3,
        }
    }
    out
}

fn resolve_decl(file: &Path, decl: &Decl) -> Option<PathBuf> {
    let dir = file.parent()?;
    if let Some(rel) = &decl.path_attr {
        if rel.is_empty() || rel.contains("..") || Path::new(rel).is_absolute() {
            return None;
        }
        let joined = dir.join(rel);
        return joined.is_file().then_some(joined);
    }
    // `lib.rs` and `mod.rs` keep submodules beside themselves. `portable.rs` keeps them in `portable/`.
    let module_dir = if matches!(
        file.file_name()?.to_str(),
        Some("mod.rs" | "lib.rs" | "main.rs")
    ) {
        dir.to_path_buf()
    } else {
        dir.join(file.file_stem()?)
    };
    for base in [module_dir, dir.to_path_buf()] {
        let rs = base.join(format!("{}.rs", decl.name));
        if rs.is_file() {
            return Some(rs);
        }
        let nested = base.join(&decl.name).join("mod.rs");
        if nested.is_file() {
            return Some(nested);
        }
    }
    None
}

fn gather_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        fs::read_dir(dir).unwrap_or_else(|error| panic!("read {}: {error}", dir.display()));
    let mut paths = Vec::new();
    for entry in entries {
        paths.push(entry.unwrap_or_else(|error| panic!("{error}")).path());
    }
    paths.sort();
    for path in paths {
        if path.is_dir() {
            gather_rs(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn rel_path(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok().map(|suffix| {
        suffix
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    })
}

fn find_sites(scan: &Scan, found: &mut Vec<Site>) {
    let bytes = scan.masked.as_bytes();
    let command = b"Command::new";
    let mut i = 0;
    while let Some(rel) = find_at(&bytes[i..], command) {
        let at = i + rel;
        if token_at(bytes, at, command.len()) {
            push_site(scan, at, found);
        }
        i = at + command.len();
    }
    // `.output` and `.status` follow `.spawn`: the byte before `.` is an identifier, so token_at would miss them.
    for method in [
        b".spawn".as_slice(),
        b".output".as_slice(),
        b".status".as_slice(),
    ] {
        i = 0;
        while let Some(rel) = find_at(&bytes[i..], method) {
            let at = i + rel;
            if method == b".status" && http_status_receiver(bytes, at) {
                i = at + method.len();
                continue;
            }
            if empty_spawn(bytes, at + method.len()) {
                push_site(scan, at, found);
            }
            i = at + method.len();
        }
    }
    for name in [
        "bounded::run",
        "run_collected",
        "spawn_managed",
        "spawn_command",
        "delivery::child",
    ] {
        push_calls(scan, name, found);
    }
    for alias in call_aliases(scan.masked) {
        push_calls(scan, &alias, found);
    }
    // `open::that` is a prefix of `open::that_detached`, so the longer name is listed first. token_at still
    // keeps them apart: the byte after `that` is `_`, which is an identifier.
    for name in ["open::that_detached", "open::that"] {
        push_calls(scan, name, found);
    }
    // `.exec` replaces the process. The byte before `.` is an identifier, so token_at would miss it, the same
    // way `.spawn` is found.
    let method = b".exec";
    i = 0;
    while let Some(rel) = find_at(&bytes[i..], method) {
        let at = i + rel;
        if empty_spawn(bytes, at + method.len()) {
            push_site(scan, at, found);
        }
        i = at + method.len();
    }
}

fn push_calls(scan: &Scan, name: &str, found: &mut Vec<Site>) {
    let bytes = scan.masked.as_bytes();
    let needle = name.as_bytes();
    let mut i = 0;
    while let Some(rel) = find_at(&bytes[i..], needle) {
        let at = i + rel;
        if token_at(bytes, at, needle.len())
            && followed_by_call(bytes, at + needle.len())
            && !defines_function(bytes, at)
        {
            push_site(scan, at, found);
        }
        i = at + needle.len();
    }
}

fn followed_by_call(bytes: &[u8], mut i: usize) -> bool {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i < bytes.len() && bytes[i] == b'('
}

/// `fn spawn_managed(` is a definition, not a call.
fn defines_function(bytes: &[u8], at: usize) -> bool {
    let mut i = at;
    while i > 0 && bytes[i - 1].is_ascii_whitespace() {
        i -= 1;
    }
    ends_with_word(bytes, i, "fn")
}

/// `response.status()` is an HTTP status, not a process. A call whose receiver is not one of these stays a start.
fn http_status_receiver(bytes: &[u8], dot: usize) -> bool {
    let mut i = dot;
    while i > 0 && bytes[i - 1].is_ascii_whitespace() {
        i -= 1;
    }
    if i == 0 || !is_ident(bytes[i - 1]) {
        return false;
    }
    let end = i;
    while i > 0 && is_ident(bytes[i - 1]) {
        i -= 1;
    }
    matches!(
        std::str::from_utf8(&bytes[i..end]).unwrap_or(""),
        "response" | "resp" | "res" | "reply" | "r" | "self" | "door"
    )
}

/// Aliases from `use path::builder as name`, so `name(...)` is still a start.
fn call_aliases(masked: &str) -> Vec<String> {
    let bytes = masked.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if keyword_at(bytes, i, "use") {
            let start = skip_ws(bytes, i + 3);
            let end = use_stmt_end(bytes, start);
            remember_aliases(&masked[start..end], &mut out);
            i = end.max(start + 1);
            continue;
        }
        i += 1;
    }
    out
}

fn use_stmt_end(bytes: &[u8], mut i: usize) -> usize {
    let mut depth = 0i32;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            b';' if depth <= 0 => return i,
            _ => {}
        }
        i += 1;
    }
    i
}

fn remember_aliases(clause: &str, out: &mut Vec<String>) {
    let bytes = clause.as_bytes();
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut i = 0usize;
    while i <= bytes.len() {
        let split = i == bytes.len() || (bytes[i] == b',' && depth == 0);
        if !split {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => depth -= 1,
                _ => {}
            }
            i += 1;
            continue;
        }
        let segment = clause[start..i]
            .trim()
            .trim_matches(|ch| ch == '{' || ch == '}')
            .trim();
        if let Some((path, alias)) = segment.rsplit_once(" as ") {
            let alias = alias.trim();
            if plain_ident(alias) && imports_builder(path) && !out.iter().any(|have| have == alias)
            {
                out.push(alias.to_string());
            }
        }
        start = i + 1;
        i += 1;
    }
}

fn plain_ident(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() || ch == '_' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn imports_builder(path: &str) -> bool {
    let flat: String = path
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace())
        .collect();
    let flat = flat.trim_matches(|ch| ch == '{' || ch == '}');
    flat.ends_with("delivery::child")
        || flat.ends_with("bounded::run")
        || flat.ends_with("::run_collected")
        || flat == "run_collected"
        || flat.ends_with("::spawn_managed")
        || flat == "spawn_managed"
        || flat.ends_with("::spawn_command")
        || flat == "spawn_command"
}

fn push_site(scan: &Scan, at: usize, found: &mut Vec<Site>) {
    if scan
        .test_mods
        .iter()
        .any(|&(start, end)| contained(start, end, at))
    {
        return;
    }
    if scan
        .funcs
        .iter()
        .any(|func| func.test_only && contained(func.start, func.end, at))
    {
        return;
    }
    let Some(func) = scan
        .funcs
        .iter()
        .filter(|func| !func.test_only && contained(func.start, func.end, at))
        .min_by_key(|func| func.end - func.start)
    else {
        found.push(Site {
            file: scan.file.to_string(),
            func: "<outside>".to_string(),
            line: line_no(scan.masked, at),
            wrapped: false,
        });
        return;
    };
    found.push(Site {
        file: scan.file.to_string(),
        func: func.name.clone(),
        line: line_no(scan.masked, func.start),
        wrapped: function_wrapped(scan.masked, func, scan.funcs),
    });
}

fn contained(start: usize, end: usize, at: usize) -> bool {
    at >= start && at < end
}

fn function_wrapped(masked: &str, func: &Func, funcs: &[Func]) -> bool {
    if MARKERS.contains(&func.name.as_str()) {
        return true;
    }
    let mut bytes = masked.as_bytes()[func.start..func.end].to_vec();
    let base = func.start;
    for other in funcs {
        if other.start > func.start && other.end <= func.end {
            let from = other.start - base;
            let to = (other.end - base).min(bytes.len());
            for byte in &mut bytes[from..to] {
                if *byte != b'\n' {
                    *byte = b' ';
                }
            }
        }
    }
    has_marker(&String::from_utf8(bytes).expect("function text stays utf-8"))
}

fn has_marker(text: &str) -> bool {
    let bytes = text.as_bytes();
    MARKERS.iter().any(|marker| {
        let needle = marker.as_bytes();
        let mut i = 0;
        while let Some(rel) = find_at(&bytes[i..], needle) {
            let at = i + rel;
            if token_at(bytes, at, needle.len()) {
                return true;
            }
            i = at + needle.len();
        }
        false
    })
}

fn functions(masked: &str) -> Vec<Func> {
    let bytes = masked.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if keyword_at(bytes, i, "fn") {
            let name_at = skip_ws(bytes, i + 2);
            let name = read_ident(bytes, name_at);
            if !name.is_empty() {
                if let Item::Inline { body, end } = following_item(bytes, name_at + name.len()) {
                    let test_only = is_test_cfg(&masked[attribute_start(masked, i)..i]);
                    out.push(Func {
                        name,
                        start: i,
                        end,
                        test_only,
                    });
                    i = body + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

fn test_module_ranges(masked: &str) -> Vec<(usize, usize)> {
    let bytes = masked.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if keyword_at(bytes, i, "mod") {
            let start = attribute_start(masked, i);
            if is_test_cfg(&masked[start..i]) {
                let name_at = skip_ws(bytes, i + 3);
                let name = read_ident(bytes, name_at);
                if !name.is_empty() {
                    if let Item::Inline { body, end } = following_item(bytes, name_at + name.len())
                    {
                        ranges.push((body, end));
                        i = body + 1;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    ranges
}

fn following_item(bytes: &[u8], mut i: usize) -> Item {
    let mut paren = 0i32;
    let mut bracket = 0i32;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => paren += 1,
            b')' => paren -= 1,
            b'[' => bracket += 1,
            b']' => bracket -= 1,
            b';' if paren == 0 && bracket == 0 => return Item::File,
            b'{' if paren == 0 && bracket == 0 => {
                let Some(end) = match_brace(bytes, i) else {
                    return Item::None;
                };
                return Item::Inline { body: i, end };
            }
            _ => {}
        }
        if paren < 0 || bracket < 0 {
            return Item::None;
        }
        i += 1;
    }
    Item::None
}

fn match_brace(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn empty_spawn(bytes: &[u8], mut i: usize) -> bool {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'<' {
        let mut depth = 0i32;
        while i < bytes.len() {
            match bytes[i] {
                b'<' => depth += 1,
                b'>' => {
                    depth -= 1;
                    if depth == 0 {
                        i += 1;
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
    }
    if i >= bytes.len() || bytes[i] != b'(' {
        return false;
    }
    i += 1;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i < bytes.len() && bytes[i] == b')'
}

fn is_test_cfg(attrs: &str) -> bool {
    let flat: String = attrs
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace())
        .collect();
    let mut rest = flat.as_str();
    while let Some(at) = rest.find("cfg(") {
        let after = &rest[at + 4..];
        if after.starts_with("test)")
            || after.starts_with("all(test")
            || after.starts_with("any(test")
        {
            return true;
        }
        if (after.starts_with("all(") || after.starts_with("any(")) && cfg_group_names_test(after) {
            return true;
        }
        rest = &rest[at + 4..];
    }
    false
}

fn cfg_group_names_test(after: &str) -> bool {
    let Some(open) = after.find('(') else {
        return false;
    };
    let mut depth = 1i32;
    let mut token = String::new();
    for ch in after[open + 1..].chars() {
        match ch {
            '(' => {
                depth += 1;
                token.clear();
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return token == "test";
                }
                token.clear();
            }
            ',' if depth == 1 => {
                if token == "test" {
                    return true;
                }
                token.clear();
            }
            _ if depth == 1 && (ch.is_ascii_alphanumeric() || ch == '_') => token.push(ch),
            _ => token.clear(),
        }
    }
    false
}

fn attribute_start(masked: &str, at: usize) -> usize {
    let bytes = masked.as_bytes();
    let mut i = at;
    loop {
        while i > 0 && bytes[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        if i == 0 {
            return 0;
        }
        if bytes[i - 1] == b']' {
            match attr_open(bytes, i - 1) {
                Some(start) => {
                    i = start;
                    continue;
                }
                None => return i,
            }
        }
        if bytes[i - 1] == b'"' {
            i = walk_back_string(bytes, i - 1);
            continue;
        }
        if bytes[i - 1] == b')' {
            match matching_open(bytes, i - 1, b'(', b')') {
                Some(open) => {
                    i = open;
                    continue;
                }
                None => return i,
            }
        }
        let mut consumed = false;
        for word in ["pub", "async", "unsafe", "const", "extern"] {
            if ends_with_word(bytes, i, word) {
                i -= word.len();
                consumed = true;
                break;
            }
        }
        if !consumed {
            return i;
        }
    }
}

fn attr_open(bytes: &[u8], close: usize) -> Option<usize> {
    let bracket = matching_open(bytes, close, b'[', b']')?;
    (bracket > 0 && bytes[bracket - 1] == b'#').then_some(bracket - 1)
}

fn matching_open(bytes: &[u8], close: usize, open_byte: u8, close_byte: u8) -> Option<usize> {
    let mut depth = 1i32;
    let mut i = close;
    while i > 0 && depth > 0 {
        i -= 1;
        if bytes[i] == close_byte {
            depth += 1;
        } else if bytes[i] == open_byte {
            depth -= 1;
        }
    }
    (depth == 0).then_some(i)
}

fn walk_back_string(bytes: &[u8], close: usize) -> usize {
    let mut i = close;
    while i > 0 {
        i -= 1;
        if bytes[i] == b'"' && !escaped(bytes, i) {
            return i;
        }
    }
    0
}

fn escaped(bytes: &[u8], at: usize) -> bool {
    let mut slashes = 0;
    let mut i = at;
    while i > 0 && bytes[i - 1] == b'\\' {
        slashes += 1;
        i -= 1;
    }
    slashes % 2 == 1
}

fn path_attr(attrs: &str) -> Option<String> {
    let bytes = attrs.as_bytes();
    let mut i = 0;
    while i + 4 < bytes.len() {
        if keyword_at(bytes, i, "path") {
            let mut j = skip_ws(bytes, i + 4);
            if j < bytes.len() && bytes[j] == b'=' {
                j = skip_ws(bytes, j + 1);
                if j < bytes.len() && bytes[j] == b'"' {
                    let start = j + 1;
                    let mut end = start;
                    while end < bytes.len() && bytes[end] != b'"' {
                        end += 1;
                    }
                    return Some(attrs[start..end].to_string());
                }
            }
        }
        i += 1;
    }
    None
}

fn ends_with_word(bytes: &[u8], end: usize, word: &str) -> bool {
    let word = word.as_bytes();
    if end < word.len() {
        return false;
    }
    let start = end - word.len();
    &bytes[start..end] == word && (start == 0 || !is_ident(bytes[start - 1]))
}

fn keyword_at(bytes: &[u8], i: usize, word: &str) -> bool {
    let word = word.as_bytes();
    i + word.len() <= bytes.len()
        && &bytes[i..i + word.len()] == word
        && token_at(bytes, i, word.len())
}

fn token_at(bytes: &[u8], at: usize, len: usize) -> bool {
    let before = at == 0 || !is_ident(bytes[at - 1]);
    let after = at + len;
    before && (after >= bytes.len() || !is_ident(bytes[after]))
}

fn read_ident(bytes: &[u8], mut i: usize) -> String {
    if i + 1 < bytes.len() && bytes[i] == b'r' && bytes[i + 1] == b'#' {
        i += 2;
    }
    let start = i;
    while i < bytes.len() && is_ident(bytes[i]) {
        i += 1;
    }
    String::from_utf8_lossy(&bytes[start..i]).into_owned()
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn line_no(src: &str, at: usize) -> usize {
    src[..at].bytes().filter(|byte| *byte == b'\n').count() + 1
}

fn find_at(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len())
        .position(|window| window == needle)
}

fn mask(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = vec![b' '; bytes.len()];
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            let start = i;
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            keep_newlines(&mut out, bytes, start, i);
            continue;
        }
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            let start = i;
            i = skip_block_comment(bytes, i);
            keep_newlines(&mut out, bytes, start, i);
            continue;
        }
        if bytes[i] == b'"' {
            let start = i;
            i = if let Some(hashes) = raw_hashes(bytes, i) {
                skip_raw(bytes, i, hashes)
            } else {
                skip_normal_string(bytes, i)
            };
            keep_newlines(&mut out, bytes, start, i);
            continue;
        }
        if bytes[i] == b'\'' {
            let start = i;
            i = skip_char_or_lifetime(bytes, i);
            keep_newlines(&mut out, bytes, start, i);
            continue;
        }
        out[i] = bytes[i];
        i += 1;
    }
    let masked = String::from_utf8(out).expect("masked rust source stays utf-8");
    debug_assert_eq!(masked.len(), src.len());
    masked
}

fn keep_newlines(out: &mut [u8], bytes: &[u8], from: usize, to: usize) {
    for i in from..to.min(bytes.len()) {
        if bytes[i] == b'\n' {
            out[i] = b'\n';
        }
    }
}

fn skip_block_comment(bytes: &[u8], start: usize) -> usize {
    let mut i = start + 2;
    let mut depth = 1i32;
    while i < bytes.len() && depth > 0 {
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            depth += 1;
            i += 2;
            continue;
        }
        if bytes[i] == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            depth -= 1;
            i += 2;
            continue;
        }
        i += 1;
    }
    i
}

fn skip_normal_string(bytes: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' {
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

fn skip_raw(bytes: &[u8], quote: usize, hashes: usize) -> usize {
    let mut i = quote + 1;
    while i < bytes.len() {
        if bytes[i] == b'"'
            && i + 1 + hashes <= bytes.len()
            && bytes[i + 1..i + 1 + hashes]
                .iter()
                .all(|byte| *byte == b'#')
        {
            return i + 1 + hashes;
        }
        i += 1;
    }
    bytes.len()
}

fn raw_hashes(bytes: &[u8], quote: usize) -> Option<usize> {
    let mut j = quote;
    let mut hashes = 0usize;
    while j > 0 && bytes[j - 1] == b'#' {
        hashes += 1;
        j -= 1;
    }
    if j == 0 || bytes[j - 1] != b'r' {
        return None;
    }
    let r_at = j - 1;
    match r_at.checked_sub(1).map(|at| bytes[at]) {
        None => Some(hashes),
        Some(byte) if !is_ident(byte) => Some(hashes),
        Some(b'b' | b'c') => {
            let prefix = r_at - 1;
            (prefix == 0 || !is_ident(bytes[prefix - 1])).then_some(hashes)
        }
        _ => None,
    }
}

fn skip_char_or_lifetime(bytes: &[u8], start: usize) -> usize {
    if start + 1 >= bytes.len() {
        return bytes.len();
    }
    let next = bytes[start + 1];
    if next.is_ascii_alphabetic() || next == b'_' {
        if start + 2 < bytes.len() && bytes[start + 2] == b'\'' {
            return start + 3;
        }
        let mut i = start + 1;
        while i < bytes.len() && is_ident(bytes[i]) {
            i += 1;
        }
        return i;
    }
    let mut i = start + 1;
    while i < bytes.len() && bytes[i] != b'\'' {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        i += 1;
    }
    if i < bytes.len() {
        i + 1
    } else {
        i
    }
}

/// Review r6 repro for PR #208 (WP-178), red at 520e3d4e3.
mod review_r6_repro {
    use super::*;

    /// MED (the audit holds by luck): a start is only `Command::new` or an empty `.spawn()`. A command another module
    /// builds (`delivery::child`, an allow-listed builder) and this function runs with `.output()` or `.status()`, or
    /// hands to an allow-listed runner (`pr_watch::bounded::run`), is never a site. Two such starts ship today:
    /// github_issues/gh.rs `run` (plain `gh` found on the login PATH, on the webview's issue poll, in a project folder)
    /// and worktree_pool.rs `run_tool`. The reasons on `delivery/mod.rs child` ("git uses command_for") and on
    /// `pr_watch/bounded.rs run` ("the check runner wraps", "the janitor's gh is contained") do not cover them.
    #[test]
    fn a_start_through_another_modules_command_builder_is_still_listed() {
        let fixture = r#"
            fn polled() {
                let mut command = crate::delivery::child("gh");
                command.args(["issue", "list"]);
                let _ = command.output();
            }
            fn handed_on() {
                let command = crate::delivery::child("gh");
                let _ = crate::pr_watch::bounded::run(command, TIMEOUT);
            }
        "#;
        let mut names: Vec<String> = classify("fixture.rs", fixture)
            .into_iter()
            .filter(|site| !site.wrapped)
            .map(|site| site.func)
            .collect();
        names.sort();
        names.dedup();
        assert_eq!(
            names,
            vec!["handed_on".to_string(), "polled".to_string()],
            "a start through another module's builder is not seen by the audit"
        );
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let sites = collect(&root);
        for (file, func) in [
            ("github_issues/gh.rs", "run"),
            ("worktree_pool.rs", "run_tool"),
        ] {
            assert!(
                sites
                    .iter()
                    .any(|site| site.file == file && site.func == func),
                "{file} {func} starts a process outside the sandbox and the audit does not list it"
            );
        }
    }
}

/// Review r7 repro for PR #208 (WP-178).
#[path = "agent_sandbox_spawn_audit_review_r7_repro.rs"]
mod review_r7_repro;
