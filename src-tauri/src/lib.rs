use tauri::Manager;

mod account_identity;
// WP-61: Hivra Cloud. Off by default; no socket is opened until Ash turns it on.
mod hivra_cloud;
// WP-78: the activity log.
mod activity;
// WP-157: the work log. Not a numbered migration.
mod work_log;
// WP-86: commit attribution. Not a numbered migration.
mod artifacts;
mod attribution;
// WP-79: a loopback door for outside AI tools.
mod outside;
// WP-04: the one-time, read-only import from the retired Ash OS bridge.
mod ash_os_import;
mod automations;
pub mod autopilot;
mod azure_devops;
mod background_work;
// WP-128: one prompt at a chosen time. Not a numbered migration, and it starts no thread.
mod one_time_schedule;
// WP-75: checked backups, one-item restore, and a full restore through the ship path.
pub mod backups;
mod chat_background;
mod chat_folder;
mod chat_media;
mod checkpoint;
mod codex_mono_store;
pub mod connectors;
mod control;
pub mod control_cli;
mod cursor_store;
mod decisions;
mod delegations;
mod dev_fault;
mod finder; // WP-74: one search box for tasks, docs and everything else.
mod github_issues;
// WP-91: the goal graph — a finish line proved first, write scopes, handoffs, repairs and the run verdict.
pub mod goal_graph;
mod tasks; // WP-70: tasks shared by the person and their agents. // WP-77: labelled GitHub issues become tasks.
           // WP-159: the programme of packages a first mate keeps. Not the per-job worker queue.
mod programme; // WP-162: update a package branch from main, and the programme lead lease.

// Hivra WP-12: delivery modes and the one merge path.
mod delivery;
mod git_cmd;
// Hivra WP-81: a pinned tool, downloaded and checked, then the local gate before GitHub.
mod delivery_gate;
mod pinned_tool;
// Hivra WP-13: crew rules, routing and reroute.
mod agent_sandbox;
mod crew;
mod devin_config;
mod devin_usage;
mod spend_ledger;
// WP-131b: desktop dictation into the composer draft; the microphone is held by a helper app, never sends.
// Off in this build (dictation::ENABLED is false): the helper is never found, checked or started.
mod dictation;
pub mod disclaim;
mod explore_agent; // WP-143: read-only check for an Explore agent the person already defined.
mod external_editor;
mod firstmate;
// Hivra WP-172: the checkpoint of a First Mate fan-out, kept so a crash mid-plan can resume.
mod fanout_checkpoint;
mod fs;
mod gates;
mod gitlab;
mod harness;
mod harness_runs;
mod harness_updates;
// WP-50: read past chats, with a person's OK, into a proposal.
mod history_import;
mod hub_keychain;
// Hivra WP-92: the secret vault. A value exists in the keychain and one place the person chose.
pub mod secrets;
// WP-85: Claude sessions started in a terminal.
mod terminal_mirror;
// WP-51: memory the person reviews.
mod memory_review;
// WP-103: the cheap memory tier asks a model the person added, on its own key.
mod memory_cheap;
// WP-129: the address each saved model key belongs to, so a command sends a key only there.
mod key_binding;
// WP-129: one short completion for titles, commits, pull requests and branch names.
mod text_generation;
// WP-83: learn from past chats. Readers, and the write after an accept.
mod learn_stores;
// WP-04: the hub plugin (local store, import, connectors, keys); the Ash OS bridge (hub.rs) is retired.
mod hub_plugin;
mod inbox_media;
pub mod instance;
// WP-07: the name a person reads. Not the bundle name.
pub mod commit_guard;
mod display_name;
mod jira;
mod jsonc;
mod land;
mod launch_guard;
// WP-104: daily log and crash records.
mod diagnostics;
// WP-104: machine facts for the health list.
mod health;
mod linear;
mod link_preview;
mod live_turns;
// WP-04: projects, Monos per project and kept Pages, in the app's own database.
mod local_hub;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod macos_background;
mod mcp;
pub mod mcp_server;
mod menu;
mod mobile_access;
mod mobile_router;
mod model_router;
mod mono;
#[cfg(target_os = "macos")]
mod mono_chat;
mod mono_home;
mod mono_transcript;
// WP-134: the More agents list, its approvals and the environment its child gets.
mod more_agents;
mod notes;
// WP-72: docs are notes, with blocks, versions and a tree.
pub(crate) mod docs;
mod notifications;
mod page_frames;
mod page_http;
mod pasteboard;
mod pi_usage;
// WP-76: one trash for chats, Monos, projects, notes, docs and tasks.
mod team_workspace;
mod trash;
// WP-30: plugin format, registry and per-CLI wiring (src/plugins/).
pub mod plugins;
// WP-43: a browser profile per agent, and Stop.
pub mod browser;
// WP-33: plugin panels, the catalog and the My panels migration.
mod panels;
// Reads of files this app didn't make: never through a link, a pipe, or past the size expected.
mod plain_file;
mod portable;
pub(crate) mod pr_watch;
mod project_actions;
mod project_file;
mod project_logo;
mod project_tests;
mod provider_session_transfer;
mod pty;
#[cfg(target_os = "macos")]
mod quick_composer;
mod rate_limits;
mod reminders;
mod remote;
mod remote_ssh;
mod resources;
// WP-161: load, free memory and free disk. The command takes no path.
mod builder_health;
mod room_council;
mod rooms;
mod search;
mod self_build;
mod session_store;
pub mod ship;
// WP-09: Windows and Linux seams for ship, keep-awake, relaunch and secrets.
mod platform;
mod skills;
pub mod ssh_askpass;
// Hivra WP-82: ready worktrees, driven by the pinned treehouse tool.
mod worktree_pool;
// WP-87: a stack per worktree, with its own ports and Compose project.
mod local_services; // WP-90: the fake outside service each stack can run
mod proxy; // WP-90: names per worktree, and the local proxy that routes by them
mod stack_decl;
mod stacks;
// Hivra WP-14: steering messages to running workers.
mod steering;
mod tool_detail;
#[cfg(target_os = "macos")]
mod trackpad_zoom;
#[cfg(target_os = "windows")]
mod tray;
mod verify_live;
mod verify_stage;
// Hivra WP-11: the watcher's wake queue and timers.
mod watcher;
mod window;
mod window_frame;
mod window_transfer;
#[cfg(windows)]
mod windows;
mod worker_queue;
pub mod worktree_autoclean;
pub mod worktree_janitor;
// WP-138: copy the files named in .worktreeinclude when a worktree is created.
mod worktree_include;
mod worktree_lifecycle;
mod worktrees;

// Phase 1 seam: spawn / kill harness children per MonoCode thread.
// Adapters own the protocol; this host only supervises processes.

/// Project directory for new sessions — prefer cwd, else home.
#[tauri::command]
fn default_cwd() -> String {
    if let Ok(cwd) = std::env::current_dir() {
        return fs::path_to_js(&cwd);
    }
    dirs_home()
        .map(|home| fs::path_to_js(std::path::Path::new(&home)))
        .unwrap_or_else(|| "~".into())
}

#[tauri::command]
fn home_dir() -> String {
    dirs_home()
        .map(|home| fs::path_to_js(std::path::Path::new(&home)))
        .unwrap_or_else(|| "~".into())
}

pub(crate) struct PasswdIdentity {
    pub home: String,
    pub user: String,
    pub shell: String,
}

pub(crate) fn dirs_home() -> Option<String> {
    #[cfg(windows)]
    let keys = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let keys = ["HOME", "USERPROFILE"];
    for key in keys {
        if let Some(home) = std::env::var_os(key) {
            let home = home.to_string_lossy().into_owned();
            if !home.is_empty() {
                return Some(home);
            }
        }
    }
    match (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        (Ok(drive), Ok(path)) if !drive.is_empty() && !path.is_empty() => {
            Some(format!("{drive}{path}"))
        }
        _ => passwd_identity().map(|id| id.home),
    }
}

/// Hide the console window that Windows allocates for GUI-spawned children.
pub(crate) fn hide_window_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(WINDOWS_BACKGROUND_CREATION_FLAGS);
    }
    let _ = cmd;
}

#[cfg(windows)]
const WINDOWS_BACKGROUND_CREATION_FLAGS: u32 = 0x0800_0000; // CREATE_NO_WINDOW

#[cfg(all(test, windows))]
mod background_command_tests {
    use super::*;

    #[test]
    fn background_commands_keep_piped_output_and_exit_status() {
        assert_eq!(WINDOWS_BACKGROUND_CREATION_FLAGS, 0x0800_0000);

        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.args(["/D", "/C", "(echo stdout)&(echo stderr 1>&2)&exit /b 7"]);
        hide_window_console(&mut cmd);

        let output = cmd.output().expect("background command should run");
        assert_eq!(output.status.code(), Some(7));
        assert!(String::from_utf8_lossy(&output.stdout).contains("stdout"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("stderr"));
    }
}

/// Finder-launched .app bundles often omit HOME/USER/SHELL. Fall back to the
/// passwd database so harness CLIs still find `~/.fx` and the login keychain.
pub(crate) fn passwd_identity() -> Option<PasswdIdentity> {
    #[cfg(unix)]
    {
        let uid = unsafe { libc::getuid() };
        let mut buf = vec![0u8; 4096];
        let mut pwd = unsafe { std::mem::zeroed::<libc::passwd>() };
        let mut result = std::ptr::null_mut::<libc::passwd>();
        let rc = unsafe {
            libc::getpwuid_r(
                uid,
                &mut pwd,
                buf.as_mut_ptr() as *mut libc::c_char,
                buf.len(),
                &mut result,
            )
        };
        if rc != 0 || result.is_null() {
            return None;
        }
        unsafe {
            let user = std::ffi::CStr::from_ptr(pwd.pw_name)
                .to_string_lossy()
                .into_owned();
            let home = std::ffi::CStr::from_ptr(pwd.pw_dir)
                .to_string_lossy()
                .into_owned();
            let shell = std::ffi::CStr::from_ptr(pwd.pw_shell)
                .to_string_lossy()
                .into_owned();
            if user.is_empty() || home.is_empty() {
                return None;
            }
            Some(PasswdIdentity { home, user, shell })
        }
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[tauri::command]
fn set_traffic_lights_visible(
    #[allow(unused_variables)] window: tauri::WebviewWindow,
    #[allow(unused_variables)] visible: bool,
) {
    #[cfg(target_os = "macos")]
    macos::set_visible(&window, visible);
}

#[tauri::command]
fn set_window_background_blur(
    #[allow(unused_variables)] window: tauri::WebviewWindow,
    #[allow(unused_variables)] radius: u8,
) {
    #[cfg(target_os = "macos")]
    macos::set_background_blur_radius(&window, radius);
}

#[tauri::command]
fn set_dock_badge(
    #[allow(unused_variables)] window: tauri::WebviewWindow,
    #[allow(unused_variables)] count: u32,
) {
    #[cfg(target_os = "macos")]
    macos::set_window_badge(&window, count);
}

#[tauri::command]
fn set_trackpad_zoom_enabled(
    #[allow(unused_variables)] window: tauri::WebviewWindow,
    #[allow(unused_variables)] enabled: bool,
) {
    #[cfg(target_os = "macos")]
    trackpad_zoom::set_enabled(&window, enabled);
}

// Async so the window is built off the main thread on Windows (a sync command
// deadlocks WebView2 and leaves the new window blank). On macOS, WKWebView
// must be created on the main thread: doing it here abort()s with
// "Rust cannot catch foreign exceptions".
#[tauri::command]
async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(window::open_new_window(&handle));
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    window::open_new_window(&app)
}

fn should_request_quit(code: Option<i32>) -> bool {
    code.is_some() || cfg!(any(target_os = "linux", target_os = "windows"))
}

/// The Tauri context: the config compiled into this binary, `--config` overlays included. One expansion, shared by
/// `run()` and `instance` (identity, `monocode version`), so the binary embeds its assets once.
pub(crate) fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Under a temporary HOME (a test, a ship drill), keep Cocoa's home folder there too, before anything asks for it
    // (src/instance.rs).
    instance::isolate_home();
    let context = context();
    // Which copy this is, before the dev relaunch, plugin setup or any app-data access (src/instance.rs). Refusals
    // show an alert and exit here.
    let identity = instance::startup(&context.config().identifier);
    let version = context.package_info().version.to_string();
    let product = context
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "MonoCode Hub".into());
    #[cfg(all(debug_assertions, target_os = "macos"))]
    {
        let config = context.config();
        let bundle_version = config
            .bundle
            .macos
            .bundle_version
            .as_deref()
            .unwrap_or(&version);
        macos::ensure_dev_bundle(&macos::DevBundle {
            name: &product,
            identifier: &identity.identifier,
            version: &version,
            bundle_version,
            signing_identity: config.bundle.macos.signing_identity.as_deref(),
        });
    }
    // Rule 3, then one app per data folder: the lock is held until this process ends.
    let claim = instance::claim(&identity, &version);
    // WP-92: a secret run that crashed can leave its old home under the temporary folder. Clear those. The sealed
    // home a run uses now is not in that folder, and this never deletes it.
    secrets::run::remove_leftover_run_homes();
    // WP-104: daily log and crash records, before the rest of startup.
    diagnostics::install(&claim.data_dir, &version);
    // Before the database opens: finish whatever a ship's runner left (a trial, a restore), or call it off
    // (src/ship.rs). May exit.
    let boot = ship::startup(&identity, &claim.data_dir);
    // WP-75: finish a full restore a dead helper left, before the database opens.
    if let Err(error) = backups::finish_pending(&claim.data_dir) {
        eprintln!("backup: {error}");
    }
    if let Err(error) = instance::apply_dev_environment(&identity) {
        instance::refuse(&instance::Refusal::DevSetup { error });
    }
    let policy = instance::effective_policy(&identity);
    let mut app_info = instance::app_info(&identity, &product, &version);
    app_info["ship"] = boot.for_window();
    #[cfg(target_os = "macos")]
    macos::register_spellcheck_default();
    #[cfg(windows)]
    windows::initialize().expect("Failed to initialize Windows process safety");
    let builder = tauri::Builder::default();
    // Closing to the tray leaves the process running without a taskbar entry,
    // so a second launch must reopen it instead of starting another instance.
    // Registered first so the duplicate exits before any setup runs.
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        let _ = window::show_hidden_or_open_new(app);
    }));
    let app = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(hub_plugin::init())
        .plugin(instance::plugin(&app_info))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(window::is_workspace_window)
                .with_state_flags(window_frame::plugin_flags())
                .build(),
        )
        .register_uri_scheme_protocol(artifacts::HTML_SCHEME, |ctx, request| {
            artifacts::serve_html(ctx.app_handle(), &request)
        })
        .manage(page_frames::PageFrames::default())
        .manage(harness::HarnessHost::new())
        .manage(pty::PtyHost::new())
        .manage(project_actions::ActionRuns::new())
        .manage(remote::RemoteConnections::default())
        .manage(window_transfer::WindowTransferState::new())
        .manage(live_turns::LiveTurns::default())
        .setup(move |app| {
            // WP-80: while the team switch is on, pick up other members' changes every few seconds (off costs a file read).
            team_workspace::start_polling(app.handle().clone());
            // Windows: still here, so no running copy took over this launch (instance::claim).
            if !claim.owner {
                instance::claim_after_handoff(&identity, &version, &claim.data_dir);
            }
            // The lock must guard the folder this app really uses.
            let app_data = app.path().app_data_dir().ok();
            if app_data.as_deref() != Some(claim.data_dir.as_path()) {
                instance::refuse(&instance::Refusal::NoLock {
                    data_dir: claim.data_dir.clone(),
                    error: format!("the app's data folder is {app_data:?}"),
                });
            }
            // WP-200: the person-approved allows of the commit guard live in this copy's data folder, nowhere else.
            commit_guard::set_allow_store(claim.data_dir.join("commit-guard-allows.json"));
            // WP-90: this copy's proxy answers every stack name, loopback only. A dev copy
            // keeps its own registry and takes the next free port above 7400.
            let dev_copy = identity.kind != instance::Kind::Daily;
            if let Err(error) = proxy::server::ensure_running(
                &claim.data_dir,
                dev_copy,
                &std::collections::HashSet::new(),
            ) {
                eprintln!("WP-90: the named-app proxy did not start: {error}");
            }
            // WP-90 and stack-fakes (#88): the last run's fakes are stopped and a running stack's
            // fakes and names put back, in the background. Neither the stop nor `node --version`
            // holds the window, and a stack action that comes in waits for it.
            stacks::resume_at_launch(app.handle(), claim.data_dir.clone());
            // WP-30: work out where plugins live (and where their skills are linked) before anything lists skills.
            let _ = plugins::host(app.handle());
            // WP-41: install and switch on the default plugins (pstack) once per data folder, in the background.
            plugins::defaults::start(app.handle());
            // Never served to a page: reading the lock file in this process would release the lock.
            for name in [instance::LOCK_FILE, "instance-owner.sqlite-journal"] {
                let _ = app
                    .asset_protocol_scope()
                    .forbid_file(claim.data_dir.join(name));
            }
            if policy.reap_orphans {
                harness::reap_orphaned_harness_processes();
            }
            // A hub-change preview left on by a crash comes back out (self_build.rs).
            self_build::start(app.handle());
            session_store::init(app.handle())?;
            // WP-76: drop anything that has been in the trash for 30 days, then again each day.
            trash::start_daily_purge(app.handle().clone());
            ship::init(app.handle(), claim.data_dir.clone(), boot);
            // WP-75: scheduled backups. A dev copy stays off until Settings says otherwise.
            backups::init(claim.data_dir.clone());
            worker_queue::init(app.handle());
            autopilot::init(app.handle(), &identity, claim.data_dir.clone());
            pr_watch::init(app.handle());
            // A finished worktree gives its build output back (worktree_autoclean.rs); the daily app only.
            if policy.clear_build_output {
                worktree_autoclean::init(app.handle().clone(), claim.data_dir.clone());
            }
            control::init(app.handle())?;
            // WP-85: the loopback port for terminal Claude sessions. A failure here does not stop the app.
            terminal_mirror::init(app.handle().clone(), claim.data_dir.clone(), identity.kind);
            outside::init(app.handle())?; // WP-79
            mobile_access::init(app.handle())?;
            reminders::init(app.handle());
            one_time_schedule::init(app.handle()); // WP-128
            checkpoint::init(app.handle())?;
            menu::install(app.handle())?;
            #[cfg(target_os = "windows")]
            tray::install(app.handle())?;
            #[cfg(target_os = "macos")]
            {
                quick_composer::init(app.handle())?;
                mono_chat::init(app.handle())?;
                macos::install_dock_menu(app.handle());
                if let Some(window) = app.get_webview_window("main") {
                    macos::install(&window);
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    let _ = window.set_shadow(true);
                }
            }
            // r65: the main window's size and place, in points, after the title bar is set up (window_frame.rs).
            window_frame::restore(app.handle());
            if identity.kind == instance::Kind::Dev {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&instance::dev_window_title(&instance::stamp()));
                }
                // An agent testing a dev copy must not pull a window in front of Ash (19 Oct: "this spams a lot"):
                // `hub:dev --background` (the default when no terminal is attached) runs it as an accessory app, which
                // never activates itself or takes focus. Screenshots by window id still work.
                #[cfg(target_os = "macos")]
                if std::env::var("MONOCODE_HUB_BACKGROUND").as_deref() == Ok("1") {
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::dispatch(app, event.id().as_ref());
        })
        // WP-131b: a page that starts loading again (reload, navigation) loses its dictation session.
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                dictation::window_lost(webview.app_handle(), webview.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            // WP-131b: desktop dictation (the helper in Contents/Helpers holds the microphone).
            dictation::dictation_support,
            dictation::dictation_start,
            dictation::dictation_stop,
            // WP-61: Hivra Cloud (off by default).
            hivra_cloud::hivra_cloud_status,
            hivra_cloud::hivra_cloud_save,
            hivra_cloud::hivra_cloud_sign_in,
            hivra_cloud::hivra_cloud_sign_out,
            hivra_cloud::hivra_cloud_account,
            hivra_cloud::hivra_cloud_pair,
            mobile_access::mobile_status,
            team_workspace::team_workspace_status,
            team_workspace::team_workspace_save,
            team_workspace::team_workspace_accept,
            team_workspace::team_workspace_presence,
            mobile_access::mobile_configure,
            mobile_access::mobile_invite,
            mobile_access::mobile_cancel_invite,
            mobile_access::mobile_revoke,
            mobile_access::mobile_publish,
            mobile_access::mobile_admits,
            mobile_access::mobile_reply,
            mobile_access::mobile_push,
            remote::remote_machines,
            remote::remote_connect,
            remote::remote_disconnect,
            remote::remote_request,
            remote::remote_ssh_begin,
            remote::remote_ssh_reconnect,
            remote::remote_ssh_poll,
            remote::remote_ssh_answer,
            remote::remote_ssh_cancel,
            ship::ship_status,
            ship::ship_ready,
            ship::ship_restart_now,
            ship::ship_seen,
            ship::ship_accept,
            ship::ship_receipt,
            ship::ship_start,
            backups::backups_status,
            backups::backups_set_schedule,
            backups::backups_set_folder,
            backups::backups_create,
            backups::backups_list,
            backups::backups_items,
            backups::backups_restore_item,
            backups::backups_restore_all,
            instance::db_health,
            control::control_enable,
            control::control_disable,
            control::control_reply,
            control::control_save,
            control::control_load,
            control::control_scopes,
            control::control_write_path,
            control::control_attach_worker,
            control::control_authorize_turn,
            control::control_turn_finished,
            control::app_cli_path,
            default_cwd,
            home_dir,
            notifications::notification_permission,
            notifications::request_notification_permission,
            notifications::show_notification,
            notifications::open_notification_settings,
            reminders::reminder_list,
            reminders::reminder_set,
            reminders::reminder_clear,
            reminders::reminder_configure,
            reminders::reminder_take_open,
            reminders::reminder_register_window,
            reminders::reminder_open,
            delegations::delegations_record,
            delegations::delegations_settle,
            // WP-157: one work log line when checks send work back.
            delegations::delegations_sent_back,
            // WP-157: the first mate's work log tool.
            work_log::work_log_add,
            work_log::work_log_read,
            delegations::delegations_reattach,
            delegations::delegations_set_question,
            delegations::delegations_set_stall,
            delegations::delegations_set_delivery,
            delegations::delegations_cancel,
            delegations::delegations_refuse,
            delegations::delegations_note_redo,
            delegations::delegations_list_open,
            delegations::delegations_followed_into,
            delegations::delegations_tree,
            // Hivra WP-10: the first mate contract.
            firstmate::firstmate_check_depth,
            firstmate::firstmate_set_question_owner,
            firstmate::firstmate_parse_report,
            firstmate::firstmate_checkout_snapshot,
            firstmate::protected_paths::firstmate_protected_fingerprints,
            firstmate::firstmate_checkout_check,
            firstmate::firstmate_checkout_revert,
            // Hivra WP-40: completion and verdict gates.
            firstmate::gates::firstmate_gates_resolve,
            firstmate::gates::firstmate_gates_plan,
            firstmate::gates::firstmate_run_gates,
            firstmate::gates::firstmate_gate_evidence,
            firstmate::gates::firstmate_gates_decide,
            // Hivra WP-12: delivery modes and the one merge path.
            delivery::delivery_settings_get,
            delivery::delivery_settings_set,
            // WP-158: the protected-path floor. Off until the project turns it on.
            delivery::delivery_protect_paths_set,
            delivery::delivery_protected_paths_add,
            delivery::delivery_list,
            delivery::delivery_deliver,
            delivery::delivery_fix_ask,
            delivery::delivery_merge,
            delivery::delivery_merge_approve,
            delivery::delivery_merges,
            delivery::delivery_events_open,
            delivery::delivery_events_consume,
            // WP-162: update a package branch from main, and the lead lease.
            programme::programme_update_settings_get,
            programme::programme_update_settings_set,
            programme::programme_bind_checkout,
            programme::programme_update_from_main,
            programme::programme_lead_acquire,
            programme::programme_lead_heartbeat,
            programme::programme_consider_conflict,
            // Hivra WP-81: the check before work goes to GitHub.
            delivery_gate::gate_setting_get,
            delivery_gate::gate_setting_set,
            // WP-85: terminal Claude sessions.
            terminal_mirror::terminal_mirror_status,
            terminal_mirror::terminal_mirror_set,
            terminal_mirror::terminal_mirror_list,
            terminal_mirror::terminal_mirror_steer,
            terminal_mirror::terminal_mirror_attach,
            delivery_gate::gate_cards,
            delivery_gate::gate_respond,
            // Hivra WP-11: the watcher's wake queue and timers.
            watcher::watcher_wake_add,
            watcher::watcher_wakes_open,
            watcher::watcher_wakes_of,
            watcher::watcher_wake_drain,
            watcher::watcher_wake_ack,
            watcher::watcher_wake_delivered,
            watcher::watcher_wake_delivery,
            watcher::watcher_dispose_owner,
            watcher::watcher_timer_set,
            watcher::watcher_timer_cancel,
            watcher::watcher_timers,
            watcher::watcher_tick,
            // WP-104: a check waits on a safe command, then one wake.
            watcher::watcher_check_set,
            watcher::watcher_check_cancel,
            // Hivra WP-13: crew rules, routing and reroute.
            crew::crew_rules_get,
            spend_ledger::spend_ledger_append,
            spend_ledger::spend_ledger_totals,
            spend_ledger::spend_project_folder,
            spend_ledger::spend_book_read,
            spend_ledger::spend_book_write,
            spend_ledger::spend_redo_links,
            spend_ledger::spend_set_project_folders,
            crew::crew_rules_set,
            // WP-141: the person's lock, never-use list and fallback order.
            crew::crew_policy_set,
            crew::crew_route,
            crew::crew_launch_check,
            crew::crew_spawn_ticket,
            crew::crew_bind_v2_session,
            crew::crew_projects_owning,
            crew::crew_any_lock,
            crew::crew_pick,
            crew::crew_on_failure,
            crew::crew_note_pause,
            steering::steering_record,
            steering::steering_pending,
            steering::steering_list,
            steering::steering_settle,
            decisions::decisions_ask,
            decisions::decisions_answer,
            // WP-215: a first mate notes a call it settled.
            decisions::decisions_note,
            decisions::decisions_list,
            // WP-156: standing answers stay off until this setting is on.
            decisions::decisions_standing_enabled,
            decisions::decisions_standing_brief,
            decisions::decisions_standing_list,
            decisions::decisions_reuse_list,
            decisions::decisions_set_standing_enabled,
            decisions::decisions_retire,
            decisions::decisions_set_standing,
            // WP-91: the goal graph's rules, its finish-line check and a worker's handoff.
            goal_graph::goal_graph_check_plan,
            goal_graph::goal_graph_check_repair,
            goal_graph::goal_graph_report,
            goal_graph::goal_graph_run_check,
            goal_graph::goal_graph_read_handoff,
            delegations::delegations_recent,
            delegations::delegations_owned,
            delegations::delegations_reports_seen,
            delegations::delegations_bind_chat,
            // WP-70: tasks shared by the person and their agents.
            tasks::commands::tasks_list,
            tasks::commands::tasks_get,
            tasks::commands::tasks_create,
            tasks::commands::tasks_update,
            // WP-71: saved views and the statuses a board draws.
            tasks::commands::tasks_views_list,
            tasks::commands::tasks_views_save,
            tasks::commands::tasks_views_delete,
            tasks::commands::tasks_statuses,
            // WP-159: the programme of packages a first mate keeps. Not the per-job worker queue.
            programme::commands::programme_list,
            programme::commands::programme_enqueue,
            programme::commands::programme_set_status,
            programme::commands::programme_park,
            programme::commands::programme_clear,
            // WP-74: full-text search over tasks and docs.
            finder::finder_search,
            // WP-77: labelled GitHub issues become tasks. Reads only.
            github_issues::github_issues_setting_get,
            github_issues::github_issues_setting_set,
            github_issues::github_issues_poll,
            dev_fault::dev_fault_take_worker_failure,
            gates::run_worker_gate,
            project_tests::run_project_tests,
            land::land_worker_copy,
            land::refresh_worker_copy,
            worker_queue::worker_queue_list,
            worker_queue::worker_queue_add,
            worker_queue::worker_queue_take,
            worker_queue::worker_queue_import_local,
            worker_queue::worker_queue_claim,
            worker_queue::worker_queue_finish,
            // Hivra WP-172: a fan-out's checkpoint (save, list for resume, remove when settled).
            fanout_checkpoint::fanout_checkpoint_save,
            fanout_checkpoint::fanout_checkpoint_list,
            fanout_checkpoint::fanout_checkpoint_remove,
            fanout_checkpoint::fanout_lease_acquire,
            fanout_checkpoint::fanout_lease_renew,
            fanout_checkpoint::fanout_lease_release,
            worker_queue::worker_settings,
            worker_queue::worker_limits_set,
            worker_queue::worker_model_set,
            // WP-89: the system-wide worker default, beside a project's own.
            worker_queue::worker_default_set,
            // WP-161: the shared builder ceiling and the optional health pauses.
            worker_queue::builder_scale_set,
            worker_queue::worker_heavy_mark,
            worker_queue::worker_settings_import_local,
            autopilot::autopilot_status,
            autopilot::autopilot_set,
            autopilot::autopilot_off,
            autopilot::autopilot_log_add,
            autopilot::autopilot_log_list,
            autopilot::autopilot_log_seen,
            autopilot::autopilot_auto_resume_set,
            autopilot::autopilot_resume_arm,
            autopilot::autopilot_resume_settle,
            autopilot::autopilot_resumes,
            pr_watch::pr_watch_add,
            pr_watch::pr_watch_remove,
            pr_watch::pr_watch_list,
            pr_watch::pr_watch_wakes_open,
            pr_watch::pr_watch_wake_delivery,
            self_build::hub_change_prepare,
            self_build::hub_change_collect,
            self_build::hub_change_preview,
            self_build::hub_change_ping,
            self_build::hub_change_live,
            self_build::hub_change_apply,
            self_build::hub_change_discard,
            self_build::hub_change_revert,
            rooms::rooms_load,
            rooms::rooms_upsert,
            room_council::rooms_set_council, // WP-23: a council's row, written on its own so a room save cannot wipe it
            rooms::rooms_delete,
            rooms::rooms_conversation_delete,
            rooms::rooms_conversation_upsert,
            rooms::rooms_message_add,
            rooms::rooms_message_update,
            rooms::rooms_read,
            rooms::rooms_import,
            rooms::rooms_origin_add,
            rooms::rooms_origins_open,
            rooms::rooms_origin_done,
            automations::automations_list,
            automations::automations_upsert,
            automations::automations_delete,
            automations::automation_runs_list,
            automations::automation_runs_recover,
            automations::automation_run_now,
            automations::automations_claim_due,
            automations::automations_claim_event,
            automations::automation_run_update,
            // WP-128: one prompt at a chosen time.
            one_time_schedule::one_time_schedules_list,
            one_time_schedule::one_time_schedules_create,
            one_time_schedule::one_time_schedules_cancel,
            one_time_schedule::one_time_schedules_miss_closed,
            one_time_schedule::one_time_schedules_claim,
            one_time_schedule::one_time_schedules_remember_session,
            one_time_schedule::one_time_schedules_ack_fired,
            one_time_schedule::one_time_schedules_release,
            one_time_schedule::one_time_schedules_mark_handed_off,
            one_time_schedule::one_time_schedules_mark_undeliverable,
            one_time_schedule::one_time_schedules_mark_late,
            one_time_schedule::one_time_schedules_note,
            external_editor::list_external_editors,
            external_editor::open_in_external_editor,
            fs::resolve_project_location,
            fs::open_path_with_default_app,
            fs::list_dir,
            fs::list_project_files,
            fs::git_diff_stats,
            fs::git_diff_index,
            fs::git_diff_files,
            fs::git_file_diff,
            fs::git_history,
            fs::git_commit_files,
            fs::git_commit_file_diff,
            fs::git_stage_file,
            fs::git_stage_contents,
            fs::git_unstage_file,
            fs::git_discard_file,
            fs::git_discard_all,
            fs::git_stage_all,
            fs::git_unstage_all,
            fs::git_commit,
            fs::git_locate_files,
            fs::git_canonical_paths,
            fs::git_head_message,
            fs::git_staged_context,
            fs::git_push,
            fs::git_pull,
            fs::git_sync,
            fs::git_range_context,
            fs::git_pr_status,
            fs::git_pr_create,
            commit_guard::commit_guard_allow,
            commit_guard::commit_guard_allows,
            commit_guard::commit_guard_refusal,
            commit_guard::commit_guard_remove,
            fs::git_github_status,
            fs::github_monocode_star_status,
            fs::github_star_monocode,
            fs::git_github_repo,
            fs::git_github_repositories,
            fs::git_github_work_item,
            fs::git_github_work_items,
            fs::git_github_work_item_details,
            fs::git_github_work_item_thread,
            fs::git_github_work_item_comment,
            fs::git_github_pr_action,
            fs::git_github_pr_diff,
            fs::git_github_pr_checks,
            fs::git_github_check_details,
            inbox_media::fetch_inbox_media,
            gitlab::gitlab_status,
            gitlab::gitlab_set_config,
            gitlab::gitlab_repo,
            gitlab::gitlab_list_work_items,
            gitlab::gitlab_list_todos,
            gitlab::gitlab_work_item_details,
            gitlab::gitlab_work_item_thread,
            gitlab::gitlab_work_item_comment,
            gitlab::gitlab_mr_diff,
            azure_devops::azure_devops_status,
            azure_devops::azure_devops_set_config,
            azure_devops::azure_devops_repo,
            azure_devops::azure_devops_list_work_items,
            azure_devops::azure_devops_list_todos,
            azure_devops::azure_devops_work_item_details,
            azure_devops::azure_devops_work_item_thread,
            azure_devops::azure_devops_work_item_comment,
            azure_devops::azure_devops_mr_diff,
            linear::linear_status,
            linear::linear_set_token,
            linear::linear_list_teams,
            linear::linear_list_issues,
            linear::linear_issue_details,
            linear::linear_issue_thread,
            linear::linear_issue_comment,
            jira::jira_status,
            jira::jira_set_config,
            jira::jira_list_projects,
            jira::jira_list_issues,
            jira::jira_issue_details,
            jira::jira_issue_thread,
            jira::jira_issue_comment,
            link_preview::fetch_link_preview,
            fs::git_branches,
            fs::git_checkout,
            fs::git_create_branch,
            fs::git_stash,
            worktrees::git_worktrees,
            worktrees::git_worktree_create,
            worktrees::git_orchestration_worktree_create,
            worktrees::git_worktree_rename_branch,
            worktrees::git_worktree_check_remove,
            worktrees::git_worktree_remove,
            worktrees::git_orchestration_worktree_remove,
            worktrees::git_orchestration_branch_remove,
            worktree_pool::worktree_pool_status,
            worktree_pool::worktree_pool_settings,
            worktree_pool::worktree_pool_set_settings,
            worktree_pool::worktree_pool_prune,
            stacks::stack_status,
            stacks::stack_down,
            stacks::stack_reset,
            stacks::stack_stale,
            stacks::stack_remove_stale,
            project_file::project_file_status,
            project_file::project_file_import,
            project_file::project_file_forget,
            project_actions::project_actions_list,
            project_actions::project_action_run,
            project_actions::project_action_stop,
            project_actions::project_action_wait,
            verify_stage::verify_stage_status,
            verify_stage::verify_stage_run,
            verify_stage::verify_stage_latest,
            worktree_autoclean::worktree_autoclean_status,
            worktree_autoclean::worktree_autoclean_set,
            worktree_janitor::worktree_janitor_report,
            worktree_janitor::worktree_janitor_clean,
            worktree_janitor::worktree_janitor_remove,
            fs::create_path,
            fs::rename_path,
            fs::delete_path,
            fs::copy_path,
            fs::move_path,
            fs::reveal_path,
            pasteboard::clipboard_file_paths,
            pasteboard::clipboard_image,
            pasteboard::copy_file_to_clipboard,
            fs::clone_repo,
            fs::resolve_existing_path,
            fs::read_file_preview,
            fs::stat_files,
            fs::inspect_paths,
            fs::read_file_base64,
            fs::read_binary_file,
            fs::read_project_image,
            fs::read_chat_image,
            fs::allow_video_stream,
            fs::write_attachment,
            fs::save_generated_image,
            fs::copy_generated_image,
            fs::read_generated_image,
            fs::delete_generated_images,
            fs::read_text_file,
            fs::mobile_list_dir,
            fs::mobile_read_text_file,
            fs::omp_session_interjections,
            fs::omp_active_assistant_texts,
            fs::claude_shell_commands,
            fs::write_text_file,
            // WP-143: is an Explore agent already defined? Reads only; nothing is written.
            explore_agent::claude_explore_agent_defined,
            skills::list_skills,
            // WP-30: plugins.
            plugins::plugins_list,
            plugins::plugins_inspect,
            plugins::plugins_install_local,
            plugins::plugins_enable,
            plugins::plugins_disable,
            plugins::plugins_uninstall,
            plugins::plugins_session_wiring,
            // WP-31: pinned install, update, rollback, and the person's OK.
            plugins::plugins_install,
            plugins::plugins_update,
            plugins::plugins_approve,
            plugins::plugins_decline,
            plugins::plugins_pending,
            plugins::plugins_rollback,
            // WP-32: Discover. Listing reads indexes; it never runs plugin code.
            plugins::discover::plugins_discover,
            // WP-43: browser profiles and the visible Stop.
            browser::browser_profiles,
            browser::browser_clear,
            browser::browser_watch,
            browser::browser_choose_own,
            browser::browser_drives,
            browser::browser_stop,
            browser::browser_stop_all,
            // WP-43: which browser, and downloading one when Chrome is missing.
            browser::browser_engine,
            browser::browser_get_browser,
            // WP-44: desktop control stays off until it is installed and turned on.
            plugins::desktop::desktop_consent_read,
            plugins::desktop::desktop_consent_write,
            plugins::desktop::desktop_control_install,
            plugins::desktop::desktop_control_fetch,
            // WP-42: offer Verify for a web or mobile project. Listing it does not install it.
            plugins::verify::plugins_verify_offer,
            plugins::verify::plugins_verify_decline,
            // WP-33: panels from plugins, and kept pages moved into My panels.
            panels::panels_catalog,
            panels::panels_migrate,
            // WP-34: Creator mode. A scratch plugin, previewed in one view, then kept or undone.
            plugins::creator::creator_start,
            plugins::creator::creator_draft,
            plugins::creator::creator_check,
            plugins::creator::creator_state,
            plugins::creator::creator_preview,
            plugins::creator::creator_keep,
            plugins::creator::creator_undo,
            plugins::creator::creator_discard,
            plugins::creator::creator_approve_mcp,
            plugins::creator::creator_probe_mcp,
            search::search_project,
            search::cancel_project_search,
            cursor_store::cursor_tool_calls,
            cursor_store::cursor_subagent_runs,
            harness::harness_resolve_cursor,
            harness::harness_resolve_codex,
            harness::harness_resolve_opencode,
            harness::harness_resolve_configured,
            harness::harness_runtime_binary_paths,
            verify_live::verify_live_take,
            verify_live::verify_live_done,
            // WP-04: the bench's mid-run messages, from its plan (the stub that answered them is retired).
            verify_live::verify_live_messages,
            verify_live::verify_live_quit,
            harness::harness_resolve_claude,
            // WP-16: the retired launcher command is gone.
            harness::claude_mcp_list,
            mcp::mcp_discover,
            mcp::mcp_add,
            harness::claude_mcp_add,
            harness::claude_mcp_remove,
            harness::mcp_provider_login,
            harness::harness_resolve_omp,
            harness::harness_resolve_pi,
            harness::harness_resolve_fx,
            harness::harness_resolve_grok,
            harness::harness_resolve_hermes,
            harness::harness_resolve_devin,
            harness::harness_resolve_antigravity,
            harness::harness_free_port,
            harness::harness_spawn,
            // WP-134: the More agents list, its approvals (src-tauri/src/more_agents.rs).
            more_agents::more_agents_read,
            more_agents::more_agents_write,
            more_agents::more_agents_approve,
            more_agents::more_agents_set_enabled,
            more_agents::more_agents_check,
            codex_mono_store::codex_mono_store_prepare,
            codex_mono_store::codex_mono_store_copy,
            codex_mono_store::codex_mono_store_restore_agent_state,
            provider_session_transfer::provider_session_transfer,
            harness::harness_write,
            harness::harness_kill,
            harness::harness_kill_all,
            harness::harness_runs,
            harness::harness_http,
            harness::harness_sse_open,
            harness::harness_sse_close,
            harness::harness_exec,
            harness_updates::harness_latest_version,
            harness_updates::harness_update_check_claim,
            harness_updates::harness_update,
            harness::provider_account_remove,
            account_identity::provider_account_identity,
            pi_usage::fetch_pi_usage,
            rate_limits::fetch_claude_usage,
            rate_limits::fetch_opencode_go_usage,
            devin_usage::fetch_devin_usage,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_status,
            pty::pty_kill,
            pty::pty_kill_all,
            session_store::session_upsert,
            session_store::session_list_by_project,
            session_store::session_list_folderless,
            session_store::session_rebase_project,
            session_store::session_list_linked,
            // WP-108: counts and names only, for the usage history page.
            session_store::session_usage_rows,
            session_store::session_search,
            session_store::cancel_session_search,
            session_store::session_get,
            // WP-177: a move reads the full row. The sidebar read still shortens tool output.
            session_store::session_get_for_move,
            // WP-177: recovery lists chats that still carry a move note, including one in the trash.
            session_store::session_list_moved,
            // WP-111: ids of chats memory must not read.
            session_store::session_private_keys,
            session_store::session_tool_detail,
            mono_transcript::mono_session_get,
            mono_transcript::mono_session_page,
            mono_transcript::mono_session_upsert,
            mono_transcript::mono_session_find,
            session_store::session_delete,
            session_store::session_set_archived,
            session_store::session_set_pinned,
            // WP-111: the private flag, written on its own so a transcript save cannot clear it.
            session_store::session_set_private,
            // WP-134: one browser link copied onto the session row, and only while the row has none.
            session_store::session_adopt_registry_agent,
            session_store::session_set_linked_work_item,
            session_store::session_set_in_flight,
            session_store::session_list_in_flight,
            session_store::session_take_in_flight,
            session_store::session_drop_in_flight,
            live_turns::live_turns_set,
            live_turns::live_turns_list,
            session_store::workspace_set_snapshot,
            session_store::workspace_get_snapshot,
            notes::notes_list,
            notes::notes_get,
            notes::notes_upsert,
            artifacts::artifacts_list,
            artifacts::artifacts_get,
            artifacts::artifacts_upsert,
            artifacts::artifacts_delete,
            page_frames::page_frame_put,
            page_frames::visual_frame_put,
            page_frames::visual_frame_drop,
            page_http::page_http_fetch,
            page_http::page_source_token_set,
            page_http::page_source_token_exists,
            page_http::page_source_token_clear,
            notes::notes_delete,
            // WP-76: trash screen.
            trash::trash_list,
            trash::trash_restore,
            trash::trash_delete_forever,
            trash::trash_empty,
            trash::trash_project,
            trash::trash_mono,
            notes::notes_save_image,
            notes::notes_image_path,
            // WP-72: docs commands. The pages are notes.
            docs::docs_list,
            docs::docs_get,
            docs::docs_create,
            docs::docs_update,
            docs::docs_adopt,
            docs::docs_move,
            docs::docs_versions,
            docs::docs_restore,
            docs::docs_favourite,
            docs::docs_touch,
            docs::docs_trash,
            docs::docs_export,
            docs::docs_resolve,
            mono::mono_load,
            mono::mono_read,
            mono::mono_save,
            mono::mono_tree_load,
            mono::mono_tree_write,
            mono::mono_archive,
            mono::mono_unarchive,
            mono::mono_team_dir,
            mono::mono_home_info,
            mono::mono_roster_load,
            mono::mono_roster_save,
            mono::mono_rename,
            portable::portable_info,
            portable::portable_mono_files,
            portable::portable_find_skills,
            portable::portable_paths_exist,
            portable::portable_project_folder_checks,
            portable::portable_relink_candidate,
            portable::portable_relink_candidates,
            portable::portable_relink_apply,
            portable::portable_session_engines,
            portable::portable_export,
            portable::portable_inspect,
            portable::portable_import,
            checkpoint::session_checkpoint_ensure,
            checkpoint::session_checkpoint_begin_turn,
            checkpoint::session_checkpoint_finish_turn,
            checkpoint::session_checkpoint_prepare,
            checkpoint::session_checkpoint_capture,
            checkpoint::session_checkpoint_status,
            checkpoint::session_checkpoint_apply,
            checkpoint::session_checkpoint_cleanup_safe,
            checkpoint::session_checkpoint_forget,
            checkpoint::session_checkpoint_file_diff,
            checkpoint::session_checkpoint_undo,
            checkpoint::session_checkpoint_keep,
            set_traffic_lights_visible,
            set_window_background_blur,
            set_dock_badge,
            set_trackpad_zoom_enabled,
            #[cfg(target_os = "macos")]
            menu::keybindings_set_overrides,
            #[cfg(target_os = "macos")]
            menu::autosave_set_enabled,
            open_new_window,
            window::hide_window,
            window::destroy_window,
            window::quit_poll_reply,
            window::quit_decision,
            window::quit_ready,
            window::set_window_glass_enabled,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_set_enabled,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_prepare,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_fit,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_submit,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_take,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_ack,
            #[cfg(target_os = "macos")]
            quick_composer::screenshots::quick_composer_release_capture,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_capture,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_git_open,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_git_state,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_git_fit,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_git_complete,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_composer_dismiss,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_sync,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_publish,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_state,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_ready,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_action,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_take,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_accept,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_reply,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_keep_alive,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_switch,
            #[cfg(target_os = "macos")]
            mono_chat::mono_menu_bar_set_visible,
            window_transfer::stage_window_transfer,
            window_transfer::take_window_transfer,
            chat_background::save_chat_background,
            resources::resource_usage,
            // WP-161: the health sample the builder pause reads. No path argument.
            builder_health::builder_health,
            resources::resource_processes,
            resources::resource_stop_tool,
            chat_background::remove_chat_background,
            chat_background::save_project_chat_background,
            chat_background::remove_project_chat_background,
            project_logo::save_project_logo,
            project_logo::remove_project_logo,
            project_logo::forget_logo_file,
            // WP-78: Settings → Activity.
            activity::activity_list,
            // WP-86: commits on a task, and the agents behind a pull request.
            attribution::attribution_for_task,
            attribution::attribution_for_commits,
            // WP-89: a worker-default change, beside the activity list.
            activity::activity_note,
            activity::activity_note_first_mate,
            agent_sandbox::agent_sandbox_status,
            agent_sandbox::agent_sandbox_set,
            // WP-50: past chats, only with a person's OK, drafted for review.
            history_import::history_import_roots,
            history_import::history_import_list,
            history_import::history_import_read,
            history_import::history_import_load_state,
            history_import::history_import_cas_state,
            history_import::history_import_write_proposal,
            history_import::history_import_ask,
            // WP-51: memory the person reviews, and a decision on a drafted chat.
            memory_review::memory_review_load,
            memory_review::memory_review_cas,
            history_import::history_import_list_proposals,
            history_import::history_import_review_proposal,
            // WP-83: proposals from past chats, accepted one at a time.
            learn_stores::learn_stores_list,
            learn_stores::learn_stores_read,
            learn_stores::learn_apply_edit,
            learn_stores::learn_state_load,
            learn_stores::learn_state_cas,
            learn_stores::learn_profile_load,
            learn_stores::learn_profile_save,
            // WP-79: Settings → Connected apps.
            outside::outside_status,
            outside::outside_set_enabled,
            outside::outside_grants,
            outside::outside_disconnect,
            outside::outside_pending,
            outside::outside_approve,
            outside::outside_deny,
            outside::outside_pick_new_port,
            // WP-104: the logs folder, and the lines the copy action masks.
            diagnostics::diagnostics_folder,
            diagnostics::diagnostics_sources,
            // WP-104: machine facts for the health list.
            health::health_facts,
        ])
        .build(context)
        .expect("error while building MonoCode");

    app.run(move |handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            // A visible floating panel must not make a hidden workspace
            // unreachable from the Dock.
            if !window::workspace_windows(handle)
                .iter()
                .any(|window| window.is_visible().unwrap_or(false))
            {
                let _ = window::show_hidden_or_open_new(handle);
            }
        }
        tauri::RunEvent::Ready => {
            #[cfg(target_os = "macos")]
            {
                if policy.notification_prompt {
                    macos::request_badge_authorization();
                }
                notifications::install_delegate(handle);
                #[cfg(debug_assertions)]
                macos::prefer_bundle_dock_icon();
            }
            window::ensure_launch_window_visible(handle);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            window::forget_quit_window(handle, &label);
            dictation::window_lost(handle, &label);
            let other_window = window::workspace_windows(handle)
                .iter()
                .any(|window| window.label() != label);
            control::window_closed(handle, &label);
            live_turns::window_closed(handle, &label);
            #[cfg(target_os = "macos")]
            mono_chat::window_closed(handle, &label);
            if !other_window {
                reap_harness_children(handle);
            }
        }
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if window::allow_exit() {
                return;
            }
            api.prevent_exit();
            // Last window destroyed (red button). Stay in the dock on macOS;
            // ⌘Q is a separate menu handler and arrives with an exit code.
            // Linux and Windows have no dock, so the last close is a quit.
            if !should_request_quit(code) {
                return;
            }
            window::request_quit(handle);
        }
        tauri::RunEvent::Exit => {
            window_frame::save(handle);
            // A normal quit: the autopilot watcher never reopens it (src/autopilot.rs).
            autopilot::on_exit(handle);
            handle.state::<remote::RemoteConnections>().shutdown();
            reap_harness_children(handle);
            // WP-81: stop the check's daemon with the app. It is not a login item.
            crate::delivery_gate::stop_daemons();
            // stack-fakes (#88): fake services stop with the app, not after it.
            match crate::project_file::data_dir(handle) {
                Ok(dir) => {
                    if let Err(error) = stacks::stop_stand_ins(&dir) {
                        eprintln!("WP-90: a fake service was not stopped at quit: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("WP-90: the fake services were not stopped at quit: {error}");
                }
            }
        }
        _ => {}
    });
}

fn reap_harness_children(handle: &tauri::AppHandle) {
    if let Some(host) = handle.try_state::<harness::HarnessHost>() {
        host.kill_all();
    }
    if let Some(host) = handle.try_state::<pty::PtyHost>() {
        host.kill_all();
    }
    if let Some(runs) = handle.try_state::<project_actions::ActionRuns>() {
        runs.stop_all();
    }
}

#[cfg(test)]
mod tests {
    use super::should_request_quit;

    #[test]
    fn explicit_exit_requests_quit() {
        assert!(should_request_quit(Some(0)));
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn last_window_close_requests_quit_without_dock() {
        assert!(should_request_quit(None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn last_window_close_stays_alive_with_dock() {
        assert!(!should_request_quit(None));
    }
}
