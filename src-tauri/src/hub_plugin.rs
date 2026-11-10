//! The `hub` plugin: the webview's door to the Hub's own Rust commands (connector logins, model keys, the local hub
//! store). Registered in `lib.rs` with one `.plugin(hub_plugin::init())`; its permissions come from `build.rs`.
//!
//! WP-04 retired the Ash OS bridge that used to live here (`hub.rs`: `hub_call`, the change feed and the Ash OS MCP
//! entry). The plugin keeps its name, so every `plugin:hub|…` command the webview already calls still resolves. The
//! last commit with the bridge carries an `archive/` tag (CLAUDE.md).

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("hub")
        .invoke_handler(tauri::generate_handler![
            crate::local_hub::local_hub_read,
            crate::local_hub::local_hub_write,
            crate::local_hub::local_hub_make_folder,
            crate::ash_os_import::ash_os_import_fetch,
            crate::hub_keychain::connector_login_store,
            crate::hub_keychain::connector_login_exists,
            crate::hub_keychain::connector_login_delete,
            // WP-92: the secret vault. `secrets_reveal` is the one command that returns a value.
            crate::secrets::commands::secrets_list,
            crate::secrets::commands::secrets_pending,
            crate::secrets::commands::secrets_requests,
            crate::secrets::commands::secrets_save_new,
            crate::secrets::commands::secrets_begin_save,
            crate::secrets::commands::secrets_save,
            crate::secrets::commands::secrets_decline,
            crate::secrets::commands::secrets_request,
            crate::secrets::commands::secrets_rename,
            crate::secrets::commands::secrets_rotate,
            crate::secrets::commands::secrets_delete,
            crate::secrets::commands::secrets_reveal,
            crate::secrets::commands::secrets_grants,
            crate::secrets::commands::secrets_revoke_grant,
            crate::secrets::commands::secrets_grant,
            crate::secrets::commands::secrets_env_write,
            crate::secrets::commands::secrets_env_remove,
            crate::secrets::commands::secrets_slug,
            crate::secrets::commands::secrets_index,
            crate::secrets::commands::secrets_env_files,
            crate::secrets::commands::secrets_worker_arm,
            crate::secrets::commands::secrets_always_for_any_code,
            crate::secrets::commands::secrets_set_always_for_any_code,
            crate::connectors::commands::connectors_state,
            crate::connectors::commands::connector_save_login,
            // WP-92: one click on a connector moves its saved key into the vault.
            crate::connectors::commands::connector_move_login_to_vault,
            crate::connectors::commands::connector_turn_on,
            crate::connectors::commands::connector_save_google_client,
            crate::connectors::commands::connector_forget_google_client,
            crate::connectors::commands::connector_oauth,
            crate::connectors::commands::connector_oauth_cancel,
            crate::connectors::commands::connector_sign_out,
            crate::connectors::commands::connector_test,
            crate::connectors::commands::connector_set_allow,
            crate::connectors::commands::connector_set_mono,
            crate::connectors::commands::connectors_set_composio,
            crate::model_router::model_key_save,
            crate::model_router::model_key_test,
            crate::model_router::model_key_delete,
            crate::model_router::model_context_window,
            // WP-22: a room's auto responder asks the quick model through this.
            crate::model_router::model_quick_pick,
            // WP-103: the cheap memory tier, and its "Test this model" check.
            crate::memory_cheap::memory_cheap_ask,
            crate::memory_cheap::memory_cheap_test
        ])
        // The main window is always shown at a usable size, whatever a later startup step does (launch_guard.rs).
        .on_event(|app, event| match event {
            tauri::RunEvent::Ready => crate::launch_guard::start(app.clone()),
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Focused(true),
                ..
            } => {
                if let Some(window) = tauri::Manager::get_webview_window(app, label) {
                    crate::launch_guard::check(app, &window, "focused");
                }
            }
            _ => {}
        })
        .build()
}
