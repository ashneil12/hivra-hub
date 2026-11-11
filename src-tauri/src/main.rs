#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The harness launcher (src/disclaim.rs) goes first: it becomes the CLI in place, with the env the Hub gave it.
    {
        let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
        if args.first().and_then(|arg| arg.to_str()) == Some(monocode_lib::disclaim::SUBCOMMAND) {
            std::process::exit(monocode_lib::disclaim::main(&args[1..]));
        }
    }
    if let Some(code) = monocode_lib::ssh_askpass::maybe_run() {
        std::process::exit(code);
    }
    // Only the subcommand has to be text: a launch with any other argument goes straight to the app.
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let rest = || -> Vec<String> {
        args[1..]
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    };
    // Fix round 3 (H4): a subcommand that reads the Keychain runs only from the daily app's folder, as the app does. It is
    // checked before the subcommand runs, since the subcommands run before the app's own startup check.
    if matches!(
        args.first().and_then(|arg| arg.to_str()),
        Some("secret-run") | Some("connector-run")
    ) {
        if let Some(why) = monocode_lib::instance::keychain_subcommand_refusal() {
            eprintln!("monocode: {why}");
            std::process::exit(78);
        }
    }
    match args.first().and_then(|arg| arg.to_str()) {
        Some("control") => std::process::exit(monocode_lib::control_cli::run(rest())),
        Some("app") => std::process::exit(monocode_lib::control_cli::run_app(rest())),
        // The delegate tool: a stdio MCP server for a Mono's chat (src/mcp_server.rs).
        Some("mcp") => std::process::exit(monocode_lib::mcp_server::run(rest())),
        // This binary's identity and build stamp; no window, no data access.
        Some("version") => std::process::exit(monocode_lib::instance::version_main(&rest())),
        // Migrate a copy of the live database with no window (src/instance.rs).
        Some("healthcheck") => {
            std::process::exit(monocode_lib::instance::healthcheck_main(&rest()))
        }
        // A connector for a Claude Code session: checks it is allowed, reads its login from the Keychain and serves it
        // over stdio (src/connectors/launch.rs). No window, no database.
        Some("connector-run") => std::process::exit(monocode_lib::connectors::run_main(&rest())),
        // WP-92: one secret into one child's environment, from a grant the app signed (src/secrets/run.rs).
        Some("secret-run") => std::process::exit(monocode_lib::secrets::run::run_main(&rest())),
        // WP-30: a plugin's stdio MCP server, started for an agent CLI's session once the plugin is checked to be on
        // (src/plugins/wiring.rs). No window, no database.
        Some("plugin-mcp") => std::process::exit(monocode_lib::plugins::run_main(&rest())),
        // Ash's answer about the build he is using: Today's card, from a terminal (src/ship.rs).
        Some("accept") => std::process::exit(monocode_lib::ship::accept_main(&rest())),
        // The worktree clean-up report: reads only, no window, no app data (src/worktree_janitor.rs).
        Some("worktrees-report") => {
            std::process::exit(monocode_lib::worktree_janitor::report_main(&rest()))
        }
        // The autopilot LaunchAgent's check: reopen the app after a crash (src/autopilot.rs).
        Some("autopilot-watch") => std::process::exit(monocode_lib::autopilot::watch_main(&rest())),
        // WP-200: the pre-push hook of a crew's repository runs the commit guard on what a push sends (src/commit_guard.rs).
        Some("pre-push-guard") => {
            std::process::exit(monocode_lib::commit_guard::pre_push_main(&rest()))
        }
        // WP-248: the pre-commit hook of a crew's repository runs the same check on what a commit takes.
        Some("pre-commit-guard") => {
            std::process::exit(monocode_lib::commit_guard::pre_commit_main(&rest()))
        }
        // WP-75: put a staged backup back once this copy has released its data folder, then open the app.
        Some("backup-restore") => {
            std::process::exit(monocode_lib::backups::restore_helper_main(&rest()))
        }
        _ => monocode_lib::run(),
    }
}
