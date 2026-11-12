//! Whether one computer-use call may run (WP-255).
//!
//! Ported from Up.computer (MIT, T3 Tools and Kirill Gurianov), `packages/computer-use-server/src/computerUse/
//! ComputerUsePolicy.ts`, in the same order: unknown tool, off, not an allowed app, the chat says no, a password or
//! payment app, reading, look-only, the chat says look only, coordinates, then yes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::sensitive::is_sensitive;
use super::tools::{tool, ToolDef, ToolMode};

/// What computer use may do at all, for every chat.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Look at apps only.
    #[default]
    Observe,
    /// Look and use them: click, type, scroll, drag.
    Control,
}

/// One chat's own say, on top of the setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatMode {
    Allow,
    ObserveOnly,
    Deny,
}

/// Settings > Computer use, kept in `<data>/computer-use.json`. A missing or unreadable file is all off.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub mode: Mode,
    /// When not empty, the only apps a tool may target; a tool with no app is then refused.
    pub allowed_apps: Vec<String>,
    /// Clicks and drags by x/y in a screenshot, rather than by element.
    pub allow_coordinates: bool,
    /// The open-computer-use program, found when computer use was turned on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidecar: Option<String>,
    /// Chats that were given their own say. A chat not listed follows the setting.
    pub chats: BTreeMap<String, ChatMode>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub allowed: bool,
    pub reason: Option<String>,
}

fn no(reason: &str) -> Decision {
    Decision {
        allowed: false,
        reason: Some(reason.to_string()),
    }
}

/// Whether the tool acts on one app, by its definition, not by the arguments passed.
fn targets_app(tool: &ToolDef) -> bool {
    tool.name != "computer_list_apps"
}

fn app_of(args: &Map<String, Value>) -> String {
    args.get("app")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// The allowed-apps list applies to every tool that targets an app, and such a tool without an app is refused.
fn app_allowed(settings: &Settings, tool: &ToolDef, args: &Map<String, Value>) -> bool {
    if settings.allowed_apps.is_empty() || !targets_app(tool) {
        return true;
    }
    let app = app_of(args).to_lowercase();
    !app.is_empty()
        && settings
            .allowed_apps
            .iter()
            .any(|entry| entry.trim().to_lowercase() == app)
}

fn uses_coordinates(args: &Map<String, Value>) -> bool {
    ["x", "y", "fromX", "fromY", "toX", "toY"]
        .iter()
        .any(|key| args.contains_key(*key))
}

pub fn decide(name: &str, args: &Map<String, Value>, settings: &Settings, chat: &str) -> Decision {
    let Some(tool) = tool(name) else {
        return no(&format!("Computer use has no tool {name}."));
    };
    if !settings.enabled {
        return no("Computer use is off in Settings.");
    }
    if !app_allowed(settings, tool, args) {
        return no("That app isn't in the allowed apps list in Settings > Computer use.");
    }
    let chat_mode = settings.chats.get(chat).copied();
    if chat_mode == Some(ChatMode::Deny) {
        return no("Computer use is off for this chat.");
    }
    // Every tool but the app list names an app; checked for all of them, reading included.
    let app = app_of(args);
    if !app.is_empty() && is_sensitive(&app) {
        return no("Computer use never opens password, keychain, wallet or payment apps, or system sign-in prompts.");
    }
    if tool.mode == ToolMode::Observe {
        return Decision {
            allowed: true,
            reason: None,
        };
    }
    if settings.mode != Mode::Control {
        return no("Computer use is set to look only in Settings.");
    }
    if chat_mode == Some(ChatMode::ObserveOnly) {
        return no("Computer use is look only in this chat.");
    }
    if !settings.allow_coordinates && uses_coordinates(args) {
        return no("Clicking by position is off in Settings > Computer use. Click an element by its index.");
    }
    Decision {
        allowed: true,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    // Cases ported from Up.computer's ComputerUsePolicy.test.ts (MIT), plus the chat modes.
    use super::*;
    use serde_json::json;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn on(mode: Mode) -> Settings {
        Settings {
            enabled: true,
            mode,
            ..Settings::default()
        }
    }

    #[test]
    fn off_by_default_and_unknown_tools_are_refused() {
        let settings = Settings::default();
        assert!(!settings.enabled);
        let d = decide("computer_list_apps", &args(json!({})), &settings, "c");
        assert_eq!(
            d.reason.as_deref(),
            Some("Computer use is off in Settings.")
        );
        let d = decide(
            "computer_select_text",
            &args(json!({ "app": "Notes" })),
            &on(Mode::Control),
            "c",
        );
        assert!(!d.allowed);
        assert!(d.reason.unwrap().contains("no tool"));
    }

    #[test]
    fn password_apps_are_refused_for_reading_and_acting_in_every_mode() {
        let settings = Settings {
            allow_coordinates: true,
            ..on(Mode::Control)
        };
        for app in [
            "1Password",
            "Passwords",
            "com.apple.keychainaccess",
            "Wallet",
            "SecurityAgent",
        ] {
            for name in [
                "computer_get_app_state",
                "computer_screenshot",
                "computer_click",
            ] {
                let d = decide(
                    name,
                    &args(json!({ "app": app, "elementIndex": 1 })),
                    &settings,
                    "c",
                );
                assert!(!d.allowed, "{name} on {app}");
                assert!(d.reason.unwrap().contains("never opens password"));
            }
        }
        // Even when Ash lists one as allowed.
        let listed = Settings {
            allowed_apps: vec!["1Password".into()],
            ..settings
        };
        assert!(
            !decide(
                "computer_get_app_state",
                &args(json!({ "app": "1Password" })),
                &listed,
                "c"
            )
            .allowed
        );
    }

    #[test]
    fn ordinary_apps_stay_usable() {
        for app in ["Notes", "com.apple.Safari", "Finder"] {
            let d = decide(
                "computer_click",
                &args(json!({ "app": app, "elementIndex": 1 })),
                &on(Mode::Control),
                "c",
            );
            assert!(d.allowed, "{app}");
        }
    }

    #[test]
    fn look_only_reads_but_never_acts() {
        let settings = on(Mode::Observe);
        assert!(decide("computer_list_apps", &args(json!({})), &settings, "c").allowed);
        assert!(
            decide(
                "computer_get_app_state",
                &args(json!({ "app": "Notes" })),
                &settings,
                "c"
            )
            .allowed
        );
        for (name, a) in [
            (
                "computer_click",
                json!({ "app": "Notes", "elementIndex": 1 }),
            ),
            (
                "computer_type_text",
                json!({ "app": "Notes", "text": "hi" }),
            ),
            (
                "computer_press_key",
                json!({ "app": "Notes", "key": "Return" }),
            ),
            (
                "computer_drag",
                json!({ "app": "Notes", "fromX": 1, "fromY": 1, "toX": 2, "toY": 2 }),
            ),
        ] {
            let d = decide(name, &args(a), &settings, "c");
            assert_eq!(
                d.reason.as_deref(),
                Some("Computer use is set to look only in Settings."),
                "{name}"
            );
        }
    }

    #[test]
    fn a_chat_can_be_look_only_or_off() {
        let mut settings = on(Mode::Control);
        settings.chats.insert("calm".into(), ChatMode::ObserveOnly);
        settings.chats.insert("none".into(), ChatMode::Deny);
        settings.chats.insert("busy".into(), ChatMode::Allow);
        let click = args(json!({ "app": "Notes", "elementIndex": 1 }));
        let read = args(json!({ "app": "Notes" }));
        assert!(decide("computer_click", &click, &settings, "busy").allowed);
        assert!(decide("computer_click", &click, &settings, "other").allowed);
        assert!(decide("computer_get_app_state", &read, &settings, "calm").allowed);
        assert_eq!(
            decide("computer_click", &click, &settings, "calm")
                .reason
                .as_deref(),
            Some("Computer use is look only in this chat.")
        );
        assert_eq!(
            decide("computer_list_apps", &args(json!({})), &settings, "none")
                .reason
                .as_deref(),
            Some("Computer use is off for this chat.")
        );
        // A chat's "allow" never lifts look-only in Settings.
        settings.mode = Mode::Observe;
        assert!(!decide("computer_click", &click, &settings, "busy").allowed);
    }

    #[test]
    fn an_allowed_apps_list_limits_every_tool_that_targets_an_app() {
        let settings = Settings {
            allowed_apps: vec!["Notes".into()],
            ..on(Mode::Control)
        };
        let decide_on = |name: &str, a: Value| decide(name, &args(a), &settings, "c");
        assert!(decide_on("computer_list_apps", json!({})).allowed);
        assert!(decide_on("computer_get_app_state", json!({ "app": "notes" })).allowed);
        assert!(
            decide_on(
                "computer_click",
                json!({ "app": "Notes", "elementIndex": 1 })
            )
            .allowed
        );
        for (name, a) in [
            ("computer_get_app_state", json!({ "app": "Safari" })),
            (
                "computer_click",
                json!({ "app": "Safari", "elementIndex": 1 }),
            ),
            // A tool that targets an app may not drop the app to slip past the list.
            ("computer_get_app_state", json!({})),
            ("computer_screenshot", json!({})),
            ("computer_press_key", json!({ "key": "return" })),
        ] {
            let d = decide_on(name, a.clone());
            assert!(!d.allowed, "{name} {a}");
            assert!(d.reason.unwrap().contains("allowed apps list"));
        }
    }

    #[test]
    fn clicking_by_position_needs_its_own_setting() {
        let mut settings = on(Mode::Control);
        let point = args(json!({ "app": "Notes", "x": 5, "y": 5 }));
        assert!(!decide("computer_click", &point, &settings, "c").allowed);
        settings.allow_coordinates = true;
        assert!(decide("computer_click", &point, &settings, "c").allowed);
    }

    #[test]
    fn settings_read_from_json_with_everything_missing_as_off() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
        let s: Settings = serde_json::from_value(json!({
            "enabled": true, "mode": "control", "allowedApps": ["Notes"],
            "chats": { "a": "observe-only", "b": "deny" }
        }))
        .unwrap();
        assert_eq!(s.mode, Mode::Control);
        assert_eq!(s.chats.get("a"), Some(&ChatMode::ObserveOnly));
    }
}
