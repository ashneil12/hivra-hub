//! The apps computer use never touches, whatever the settings say: password managers, the keychain, wallets,
//! payment apps and the system's own sign-in and password prompts (WP-255).
//!
//! Ported from Up.computer (MIT, T3 Tools and Kirill Gurianov), `packages/computer-use-server/src/computerUse/
//! SensitiveApps.ts`. The sidecar keeps its own block list too (open-computer-use's AppSafetyPolicy); this one is
//! checked first, in Hivra, before a call ever reaches it.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

/// Matched anywhere in the name, which may be a visible name or a bundle identifier, so `com.apple.Passwords` and
/// `com.agilebits.onepassword7` are caught as well as "1Password".
const PATTERNS: &[&str] = &[
    r"pass(?:word|wd)",
    r"keychain",
    r"bitwarden",
    r"dashlane",
    r"lastpass",
    r"keepass",
    r"enpass",
    r"nordpass",
    r"proton\s*pass",
    r"wallet",
    r"payment",
    // The system's sign-in and password prompts.
    r"securityagent",
    r"coreautha",
    r"localauthentication",
    r"ticket[\s-]?viewer",
    r"netauthagent",
    r"escrowsecurity",
    r"парол",
    r"связка ключей",
];

/// The macOS password apps and sign-in prompts. Their names in every system language are read from the bundles' own
/// tables on a Mac.
#[cfg(target_os = "macos")]
const SYSTEM_BUNDLES: &[&str] = &[
    "/System/Applications/Passwords.app",
    "/System/Applications/Utilities/Keychain Access.app",
    "/System/Library/CoreServices/Applications/Keychain Access.app",
    "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle",
    "/System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle",
    "/System/Library/CoreServices/Applications/Ticket Viewer.app",
    "/System/Library/CoreServices/NetAuthAgent.app",
    "/System/Library/CoreServices/EscrowSecurityAlert.app",
    "/System/Library/CoreServices/Keychain Circle Notification.app",
];

/// Used when the bundles can't be read (another system, an older macOS, the tests).
const KNOWN_LOCALIZED_NAMES: &[&str] = &[
    // Passwords
    "Пароли",
    "Passwörter",
    "Mots de passe",
    "Contraseñas",
    "Senhas",
    "Wachtwoorden",
    "Salasanat",
    "Parolalar",
    "Hasła",
    "パスワード",
    "密码",
    "密碼",
    "암호",
    // Keychain Access
    "Связка ключей",
    "Schlüsselbundverwaltung",
    "Trousseaux d’accès",
    "Acceso a Llaveros",
    "Accesso Portachiavi",
    "キーチェーンアクセス",
    "钥匙串访问",
    "鑰匙圈存取",
    "키체인 접근",
];

/// Width-, case- and invisible-character-insensitive, with a trailing `.app` ignored.
pub fn normalize(value: &str) -> String {
    let folded: String = value
        .nfkc()
        .filter(|c| {
            !matches!(
                c,
                '\u{00AD}' | '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}'
            )
        })
        .map(|c| if matches!(c, '’' | '‘') { '\'' } else { c })
        .collect();
    let trimmed = folded.trim();
    let without_app = if trimmed.len() >= 4
        && trimmed.is_char_boundary(trimmed.len() - 4)
        && trimmed[trimmed.len() - 4..].eq_ignore_ascii_case(".app")
    {
        &trimmed[..trimmed.len() - 4]
    } else {
        trimmed
    };
    without_app.trim().to_lowercase()
}

fn patterns() -> &'static Vec<Regex> {
    static CELL: OnceLock<Vec<Regex>> = OnceLock::new();
    CELL.get_or_init(|| {
        PATTERNS
            .iter()
            .map(|p| Regex::new(&format!("(?iu){p}")).expect("sensitive-app pattern"))
            .collect()
    })
}

#[cfg(target_os = "macos")]
fn bundle_names(bundle: &str) -> Vec<String> {
    use std::process::Command;
    let read = |file: String| -> Option<serde_json::Value> {
        if !std::path::Path::new(&file).exists() {
            return None;
        }
        let out = Command::new("/usr/bin/plutil")
            .args(["-convert", "json", "-o", "-", &file])
            .output()
            .ok()?;
        serde_json::from_slice(&out.stdout).ok()
    };
    let mut names = Vec::new();
    let mut collect = |entry: &serde_json::Value| {
        for key in ["CFBundleDisplayName", "CFBundleName", "CFBundleIdentifier"] {
            if let Some(value) = entry.get(key).and_then(|v| v.as_str()) {
                if !value.trim().is_empty() {
                    names.push(value.to_string());
                }
            }
        }
    };
    if let Some(info) = read(format!("{bundle}/Contents/Info.plist")) {
        collect(&info);
    }
    if let Some(serde_json::Value::Object(tables)) =
        read(format!("{bundle}/Contents/Resources/InfoPlist.loctable"))
    {
        for entry in tables.values() {
            collect(entry);
        }
    }
    names
}

/// Every known name of the system's password apps and prompts, read once per process.
pub fn system_names() -> &'static HashSet<String> {
    static CELL: OnceLock<HashSet<String>> = OnceLock::new();
    CELL.get_or_init(|| {
        #[allow(unused_mut)]
        let mut names: Vec<String> = KNOWN_LOCALIZED_NAMES
            .iter()
            .map(|s| s.to_string())
            .collect();
        #[cfg(target_os = "macos")]
        for bundle in SYSTEM_BUNDLES {
            names.extend(bundle_names(bundle));
        }
        names.iter().map(|name| normalize(name)).collect()
    })
}

/// Whether `app` names a password, keychain, wallet or payment app, or a system sign-in prompt.
pub fn is_sensitive(app: &str) -> bool {
    let name = normalize(app);
    system_names().contains(&name) || patterns().iter().any(|p| p.is_match(&name))
}

#[cfg(test)]
mod tests {
    // Cases ported from Up.computer's ComputerUsePolicy.test.ts (MIT).
    use super::*;

    #[test]
    fn credential_and_payment_apps_are_caught_by_name_localized_name_or_bundle_id() {
        for app in [
            "Passwords",
            "com.apple.Passwords",
            "1Password",
            "1Password 7",
            "com.agilebits.onepassword7",
            "com.1password.1password",
            "Keychain Access",
            "com.apple.keychainaccess",
            "Bitwarden",
            "com.bitwarden.desktop",
            "KeePassXC",
            "Proton Pass",
            "NordPass",
            "Wallet",
            "Пароли",
            "Связка ключей",
            "Passwörter",
            "Mots de passe",
            "Contraseñas",
            "Schlüsselbund\u{00ad}verwaltung",
            "Trousseaux d’accès",
            "Acceso a Llaveros",
            "Passwords.app",
            "PASSWORDS.APP",
            "ＰＡＳＳＷＯＲＤＳ",
            "Pass\u{200b}words",
            "SecurityAgent",
            "com.apple.SecurityAgent",
            "Ticket Viewer",
            "com.apple.Ticket-Viewer",
            "coreautha",
            "com.apple.LocalAuthentication.UIAgent",
            "NetAuthAgent",
            "com.apple.NetAuthAgent",
            "Keychain Circle Notification",
            "com.apple.EscrowSecurityAlert",
        ] {
            assert!(is_sensitive(app), "{app}");
        }
    }

    #[test]
    fn ordinary_apps_are_not() {
        for app in [
            "Notes",
            "com.apple.Safari",
            "Finder",
            "TextEdit",
            "Passage",
            "Wall Street",
        ] {
            assert!(!is_sensitive(app), "{app}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn every_name_the_system_gives_its_password_apps_is_caught() {
        if !std::path::Path::new("/System/Applications/Passwords.app").exists() {
            return;
        }
        let names: Vec<&String> = system_names().iter().collect();
        assert!(names.len() > 40, "only {} names", names.len());
        assert!(names.iter().all(|name| is_sensitive(name)));
    }
}
