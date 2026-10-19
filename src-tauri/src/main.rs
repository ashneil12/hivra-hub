#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = monocode_lib::ssh_askpass::maybe_run() {
        std::process::exit(code);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("control") => std::process::exit(monocode_lib::control_cli::run(args[1..].to_vec())),
        Some("app") => std::process::exit(monocode_lib::control_cli::run_app(args[1..].to_vec())),
        // This binary's identity and build stamp; no window, no data access.
        Some("version") => std::process::exit(monocode_lib::instance::version_main(&args[1..])),
        // Migrate a copy of the live database with no window (src/instance.rs).
        Some("healthcheck") => {
            std::process::exit(monocode_lib::instance::healthcheck_main(&args[1..]))
        }
        _ => monocode_lib::run(),
    }
}
