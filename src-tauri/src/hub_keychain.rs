//! Connector logins in the macOS Keychain (Windows/Linux: the platform store, through `keyring`).
//!
//! Only items whose service starts with `monocode-hub` are ever written, checked or deleted: the app can never reach
//! another Keychain item through these commands. A login's secret goes in and never comes back out to the webview:
//! `connector_login_exists` answers yes or no only.
//!
//! A dev copy (src/instance.rs) only ever uses `monocode-hub-dev:*`: it can never ask for, overwrite or delete one of
//! the daily app's logins or keys.

use crate::instance::Kind;

const PREFIX: &str = "monocode-hub";
/// Every Keychain service a dev copy uses starts with this.
pub(crate) const DEV_PREFIX: &str = "monocode-hub-dev:";

fn check_service(service: &str) -> Result<(), String> {
    let tidy = service.starts_with(PREFIX)
        && service.len() <= 120
        && service
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'));
    if tidy {
        Ok(())
    } else {
        Err("The app only keeps its own connector logins (monocode-hub…).".into())
    }
}

/// The Keychain service this copy really uses for `service`. The daily app uses it as given. A dev copy maps
/// `monocode-hub:<name>` to `monocode-hub-dev:<name>` and puts `monocode-hub-dev:` in front of anything else, so none
/// of its names is ever a daily one.
pub(crate) fn scoped_service(kind: Kind, service: &str) -> String {
    match kind {
        Kind::Daily => service.to_string(),
        Kind::Dev => {
            let name = service
                .strip_prefix(DEV_PREFIX)
                .or_else(|| service.strip_prefix("monocode-hub:"))
                .unwrap_or(service);
            format!("{DEV_PREFIX}{name}")
        }
    }
}

fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    check_service(service)?;
    if account.is_empty() || account.len() > 200 {
        return Err("A login needs an account name.".into());
    }
    // A daily copy under a temporary HOME (a test, a ship drill) keeps to dev names too: the login keychain is the
    // user's whatever HOME says (`instance::Policy::in_isolated_home`).
    let kind = if crate::instance::policy().daily_keychain {
        Kind::Daily
    } else {
        Kind::Dev
    };
    let service = scoped_service(kind, service);
    keyring::Entry::new(&service, account)
        .map_err(|_| crate::platform::secrets::unreachable().to_string())
}

/// The Mac's own codes for "the person said no, or there was no one to ask": `errSecUserCanceled`, `errSecAuthFailed` and
/// `errSecInteractionNotAllowed`. `keyring` hands them over as a platform failure whose inner error prints its `code`.
const DENIED_CODES: [&str; 3] = ["-128", "-25293", "-25308"];

/// Whether a platform failure is the person's "no" on a system prompt.
fn denied_by_person(inner: &dyn std::fmt::Debug) -> bool {
    let shown = format!("{inner:?}");
    DENIED_CODES
        .iter()
        .any(|code| shown.contains(&format!("code: {code}")))
}

/// WP-92: the words for a store failure. `keyring` reports a store that won't let this process in (a locked one
/// included) as `NoStorageAccess`, and a person clicking Deny on the system prompt as a platform failure carrying the
/// Mac's own code. Those are two different things to do, so they keep two different sentences; every other failure keeps
/// its own.
fn refusal(err: keyring::Error, fallback: &'static str) -> String {
    match err {
        keyring::Error::NoStorageAccess(_) => crate::platform::secrets::locked().to_string(),
        keyring::Error::PlatformFailure(inner) if denied_by_person(&inner) => {
            crate::platform::secrets::denied().to_string()
        }
        _ => fallback.to_string(),
    }
}

pub fn store(service: &str, account: &str, secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        return Err("Nothing to save.".into());
    }
    entry(service, account)?
        .set_password(secret)
        .map_err(|err| refusal(err, crate::platform::secrets::not_saved()))
}

pub fn exists(service: &str, account: &str) -> Result<bool, String> {
    match entry(service, account)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(err) => Err(refusal(err, crate::platform::secrets::not_checked())),
    }
}

/// For the app's own use in Rust only (the model router). Never exposed as a command: secrets don't go back to the webview.
pub(crate) fn read(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry(service, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(refusal(err, crate::platform::secrets::not_read())),
    }
}

pub fn delete(service: &str, account: &str) -> Result<bool, String> {
    match entry(service, account)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(err) => Err(refusal(err, crate::platform::secrets::not_removed())),
    }
}

#[tauri::command]
pub async fn connector_login_store(
    service: String,
    account: String,
    secret: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || store(&service, &account, &secret))
        .await
        .map_err(|_| crate::platform::secrets::unreachable().to_string())?
}

#[tauri::command]
pub async fn connector_login_exists(service: String, account: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || exists(&service, &account))
        .await
        .map_err(|_| crate::platform::secrets::unreachable().to_string())?
}

#[tauri::command]
pub async fn connector_login_delete(service: String, account: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || delete(&service, &account))
        .await
        .map_err(|_| crate::platform::secrets::unreachable().to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_own_services_are_reachable() {
        for bad in [
            "",
            "Chrome Safe Storage",
            "github.com",
            "monocode",
            "xmonocode-hub",
            "monocode-hub test",
            "monocode-hub/../x",
        ] {
            assert!(check_service(bad).is_err(), "{bad} must be refused");
            assert!(store(bad, "a", "b").is_err());
            assert!(exists(bad, "a").is_err());
            assert!(delete(bad, "a").is_err());
        }
        assert!(check_service("monocode-hub:github").is_ok());
        assert!(check_service("monocode-hub-test:proof").is_ok());
    }

    #[test]
    fn a_store_that_wont_let_us_in_says_locked() {
        // Constructed errors only: this never reaches the login keychain.
        let locked = keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("locked")));
        assert_eq!(
            refusal(locked, "fallback"),
            crate::platform::secrets::locked()
        );
        let other = keyring::Error::PlatformFailure(Box::new(std::io::Error::other("nope")));
        assert_eq!(refusal(other, "fallback"), "fallback");
        let missing = keyring::Error::NoEntry;
        assert_eq!(refusal(missing, "fallback"), "fallback");
        // A locked store is "try again", never "wrong secret".
        assert!(crate::platform::secrets::locked().contains("again"));
        assert!(!crate::platform::secrets::locked().contains("wrong"));
    }

    /// A stand-in for the Mac's own error: it prints its code the way `security_framework::base::Error` does.
    struct MacError(i32);

    impl std::fmt::Debug for MacError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "Error {{ code: {}, message: \"x\" }}", self.0)
        }
    }

    impl std::fmt::Display for MacError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "mac error")
        }
    }

    impl std::error::Error for MacError {}

    #[test]
    fn a_person_clicking_deny_is_not_a_locked_keychain() {
        // Constructed errors only: this never reaches the login keychain.
        for code in [-128, -25293, -25308] {
            let denied = keyring::Error::PlatformFailure(Box::new(MacError(code)));
            let words = refusal(denied, "fallback");
            assert_eq!(words, crate::platform::secrets::denied(), "code {code}");
            assert_ne!(words, crate::platform::secrets::locked());
        }
        // Each has its own plain words, both say to try again, and neither says "wrong".
        assert_ne!(
            crate::platform::secrets::denied(),
            crate::platform::secrets::locked()
        );
        assert!(crate::platform::secrets::denied().contains("try again"));
        assert!(crate::platform::secrets::denied().contains("Allow"));
        assert!(!crate::platform::secrets::denied().contains("wrong"));
        // A locked or missing store keeps its own sentence, and any other code keeps the fallback.
        let locked = keyring::Error::NoStorageAccess(Box::new(MacError(-25291)));
        assert_eq!(
            refusal(locked, "fallback"),
            crate::platform::secrets::locked()
        );
        let other = keyring::Error::PlatformFailure(Box::new(MacError(-25299)));
        assert_eq!(refusal(other, "fallback"), "fallback");
    }

    #[test]
    fn a_dev_copy_never_forms_a_daily_keychain_name() {
        for service in [
            crate::model_router::KEY_SERVICE,
            "monocode-hub:github",
            "monocode-hub:gmail",
            "monocode-hub",
            "monocode-hub-test:proof",
            "monocode-hub-sandbox:model-key",
            "monocode-hub-dev:github",
            "monocode-hub:monocode-hub:x",
        ] {
            assert!(check_service(service).is_ok(), "{service}");
            let dev = scoped_service(Kind::Dev, service);
            assert!(dev.starts_with(DEV_PREFIX), "{service} -> {dev}");
            assert!(!dev.starts_with("monocode-hub:"), "{service} -> {dev}");
            // Applying it twice changes nothing: a dev name stays the same dev name.
            assert_eq!(scoped_service(Kind::Dev, &dev), dev);
            // The daily app's names are exactly what it was given.
            assert_eq!(scoped_service(Kind::Daily, service), service);
        }
        assert_eq!(
            scoped_service(Kind::Dev, crate::model_router::KEY_SERVICE),
            "monocode-hub-dev:model-key"
        );
        assert_eq!(
            scoped_service(Kind::Dev, "monocode-hub:github"),
            "monocode-hub-dev:github"
        );
    }

    /// Real Keychain round trip with a DUMMY login only (service `monocode-hub-test…`), deleted at the end.
    /// Opt-in: `MONOCODE_KEYCHAIN_PROOF=1 cargo test -p monocode hub_keychain -- --nocapture`
    #[test]
    fn a_dummy_login_lands_in_the_keychain_and_is_removed() {
        if std::env::var("MONOCODE_KEYCHAIN_PROOF").as_deref() != Ok("1") {
            return;
        }
        let service = format!("monocode-hub-test:proof-{}", std::process::id());
        let account = "dummy@example.invalid";
        assert!(!exists(&service, account).unwrap());
        store(&service, account, "not-a-real-secret").unwrap();
        assert!(exists(&service, account).unwrap());
        println!("[proof-12] stored {service} / {account} in the Keychain");
        let seen = std::process::Command::new("security")
            .args(["find-generic-password", "-s", &service, "-a", account])
            .output()
            .unwrap();
        println!(
            "[proof-12] `security find-generic-password -s {service}` exit {}",
            seen.status
        );
        assert!(
            seen.status.success(),
            "the Keychain should list the dummy item"
        );
        assert!(delete(&service, account).unwrap());
        assert!(!exists(&service, account).unwrap());
        let gone = std::process::Command::new("security")
            .args(["find-generic-password", "-s", &service, "-a", account])
            .output()
            .unwrap();
        println!(
            "[proof-12] after delete: exit {} (44 = not found)",
            gone.status
        );
        assert!(!gone.status.success());
    }
}
