//! WP-131: desktop dictation for the composer draft. Off in this build.
//!
//! The recogniser (the Mac's on-device speech API) is not in the main app. Its microphone and speech permissions
//! would belong to the Hub, and macOS charges a child process's microphone request to the app that started it, so
//! project actions, git hooks and setup scripts would inherit the grant. The planned fix is a helper bundle inside
//! the app, with its own identifier, usage strings and audio-input entitlement, started with responsibility
//! disclaimed. That helper is not built yet. Until it ships, the main app has no microphone usage strings and no
//! audio-input entitlement (see the test below), so it cannot open the microphone, and the composer does not offer
//! dictation. The engine as it stood before this change is in the git history of this file.
//!
//! The commands stay registered so the webview gets one clear answer: not available.

use serde::Serialize;

// The text below is the note the webview shows (src/features/sessions/model/dictation.ts). The webview matches it
// by ending, so it must not be reworded on one side only.
const OFF: &str = "Dictation is off in this version of the app.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    pub available: bool,
    pub reason: String,
}

fn support() -> Support {
    Support {
        available: false,
        reason: OFF.to_string(),
    }
}

#[tauri::command]
pub fn dictation_support() -> Support {
    support()
}

/// Refuses every start: nothing in this build can open the microphone.
#[tauri::command]
pub fn dictation_start() -> Result<u64, String> {
    Err(OFF.to_string())
}

/// Nothing is ever started, so there is nothing to stop.
#[tauri::command]
pub fn dictation_stop(session: u64) {
    let _ = session;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_main_app_asks_for_no_microphone_or_speech_recognition() {
        // The main app must never be able to open the microphone: no usage strings, no audio-input entitlement.
        let info = include_str!("../Info.plist");
        let entitlements = include_str!("../Entitlements.plist");
        assert!(!info.contains("NSMicrophoneUsageDescription"));
        assert!(!info.contains("NSSpeechRecognitionUsageDescription"));
        assert!(!entitlements.contains("com.apple.security.device.audio-input"));
    }

    #[test]
    fn dictation_is_off_and_every_start_is_refused() {
        assert!(!support().available);
        assert_eq!(dictation_start(), Err(OFF.to_string()));
        dictation_stop(1);
    }

    #[test]
    fn the_support_payload_is_camel_case_and_the_note_carries_no_path_or_dash() {
        let value = serde_json::to_value(support()).unwrap();
        assert!(value.get("available").is_some() && value.get("reason").is_some());
        assert!(!OFF.contains('/'), "no path in a note: {OFF}");
        assert!(
            !OFF.contains('\u{2013}') && !OFF.contains('\u{2014}'),
            "no dash in a note: {OFF}"
        );
    }
}
