//! The name a person reads (WP-07). Not `productName`, the identifier, the data folder, or a Keychain name.
//!
//! A label exists only on the platforms whose menu shows it. A test build keeps every label so the wording stays one list.

pub const DISPLAY_NAME: &str = "Hivra";

#[cfg(any(target_os = "macos", target_os = "windows", test))]
pub const QUIT_LABEL: &str = "Quit Hivra";

#[cfg(any(target_os = "macos", test))]
pub const ABOUT_LABEL: &str = "About Hivra";
#[cfg(any(target_os = "macos", test))]
pub const HIDE_LABEL: &str = "Hide Hivra";
#[cfg(any(target_os = "macos", test))]
pub const WEBSITE_LABEL: &str = "Hivra Website";
#[cfg(any(target_os = "macos", test))]
pub const EMPTY_MONO_MENU: &str = "Create a Mono in Hivra to chat here";

#[cfg(any(target_os = "windows", test))]
pub const SHOW_LABEL: &str = "Show Hivra";
#[cfg(any(target_os = "windows", test))]
pub const TRAY_TOOLTIP: &str = "Hivra";

#[cfg(test)]
mod tests {
    use super::*;

    fn read_json(name: &str) -> serde_json::Value {
        let path = format!("{}/{}", env!("CARGO_MANIFEST_DIR"), name);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{name} must exist"));
        serde_json::from_str(&text).unwrap_or_else(|_| panic!("{name} must be valid JSON"))
    }

    #[test]
    fn every_label_says_hivra_and_not_the_bundle_name() {
        let labels = [
            DISPLAY_NAME,
            QUIT_LABEL,
            ABOUT_LABEL,
            HIDE_LABEL,
            SHOW_LABEL,
            WEBSITE_LABEL,
            TRAY_TOOLTIP,
            EMPTY_MONO_MENU,
        ];
        for label in labels {
            assert!(label.contains(DISPLAY_NAME), "{label}");
            assert!(!label.contains("MonoCode"), "{label}");
        }
        assert_eq!(QUIT_LABEL, "Quit Hivra");
        assert_eq!(ABOUT_LABEL, "About Hivra");
        assert_eq!(HIDE_LABEL, "Hide Hivra");
        assert_eq!(SHOW_LABEL, "Show Hivra");
        assert_eq!(WEBSITE_LABEL, "Hivra Website");
        assert_eq!(TRAY_TOOLTIP, DISPLAY_NAME);
        assert_eq!(EMPTY_MONO_MENU, "Create a Mono in Hivra to chat here");
    }

    #[test]
    fn window_titles_say_hivra_and_the_bundle_name_stays() {
        let daily = read_json("tauri.conf.json");
        assert_eq!(daily["productName"], "MonoCode Hub");
        assert_eq!(daily["identifier"], "com.ash.monocode-hub");
        assert_eq!(daily["app"]["windows"][0]["title"], DISPLAY_NAME);
        for name in ["tauri.windows.conf.json", "tauri.linux.conf.json"] {
            let value = read_json(name);
            assert_eq!(value["app"]["windows"][0]["title"], DISPLAY_NAME, "{name}");
            assert!(value.get("productName").is_none(), "{name}");
            assert!(value.get("identifier").is_none(), "{name}");
        }
    }
}
