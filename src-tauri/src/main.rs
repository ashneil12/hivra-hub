#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
    match args.first().and_then(|arg| arg.to_str()) {
        Some("control") => std::process::exit(monocode_lib::control_cli::run(rest())),
        Some("app") => std::process::exit(monocode_lib::control_cli::run_app(rest())),
        // This binary's identity and build stamp; no window, no data access.
        Some("version") => std::process::exit(monocode_lib::instance::version_main(&rest())),
        // Migrate a copy of the live database with no window (src/instance.rs).
        Some("healthcheck") => {
            std::process::exit(monocode_lib::instance::healthcheck_main(&rest()))
        }
        _ => monocode_lib::run(),
    }
}
