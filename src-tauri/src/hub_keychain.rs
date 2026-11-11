//! Connector logins in the macOS Keychain (Windows/Linux: the platform store, through `keyring`).
//!
//! Only items whose service starts with `monocode-hub` are ever written, checked or deleted: the app can never reach
//! another Keychain item through these commands. A login's secret goes in and never comes back out to the webview:
//! `connector_login_exists` answers yes or no only. Those three commands reach only `monocode-hub:login:<id>`, never a
//! model key or any other item the app keeps (see `connector_service_allowed`).
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

/// The More agents approval items (`monocode-hub:more-agents-*`) belong to the app's own code. A webview command
/// cannot write, read or delete them: a deleted item would reset the approvals to nothing and bring a withdrawn one back.
fn reserved(service: &str) -> bool {
    let name = service
        .strip_prefix(DEV_PREFIX)
        .or_else(|| service.strip_prefix("monocode-hub:"))
        .unwrap_or(service);
    name.starts_with("more-agents")
}

fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    entry_with(service, account, false)
}

fn entry_with(service: &str, account: &str, internal: bool) -> Result<keyring::Entry, String> {
    check_service(service)?;
    if !internal && reserved(service) {
        return Err("The app keeps its own More agents approvals.".into());
    }
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

/// For the app's own More agents items only (see `reserved`).
#[cfg(not(test))]
pub(crate) fn read_internal(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry_with(service, account, true)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(crate::platform::secrets::not_read().into()),
    }
}

#[cfg(not(test))]
pub(crate) fn store_internal(service: &str, account: &str, secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        return Err("Nothing to save.".into());
    }
    entry_with(service, account, true)?
        .set_password(secret)
        .map_err(|_| crate::platform::secrets::not_saved().to_string())
}

pub fn store(service: &str, account: &str, secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        return Err("Nothing to save.".into());
    }
    entry(service, account)?
        .set_password(secret)
        .map_err(|_| crate::platform::secrets::not_saved().to_string())
}

pub fn exists(service: &str, account: &str) -> Result<bool, String> {
    match entry(service, account)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err(crate::platform::secrets::not_checked().into()),
    }
}

/// For the app's own use in Rust only (the model router). Never exposed as a command: secrets don't go back to the webview.
pub(crate) fn read(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry(service, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(crate::platform::secrets::not_read().into()),
    }
}

pub fn delete(service: &str, account: &str) -> Result<bool, String> {
    match entry(service, account)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err(crate::platform::secrets::not_removed().into()),
    }
}

/// The webview's connector-login commands reach only this namespace: `monocode-hub:login:<id>`, or
/// `monocode-hub-test:login:<id>` for tests and proofs. No internal item is ever named like that (the model keys
/// are `monocode-hub:model-key`, connector secrets `monocode-hub:connector:<id>`, page tokens
/// `monocode-hub:page-source:<id>`), so the webview cannot overwrite, probe or delete one through these commands.
/// A model key is changed only by the model-key commands, which keep the address stored with it. The id is a
/// plain name: letters, digits, `-`, `_` and `.`, up to 64 characters.
const LOGIN_PREFIXES: [&str; 2] = ["monocode-hub:login:", "monocode-hub-test:login:"];

pub(crate) fn connector_service_allowed(service: &str) -> bool {
    LOGIN_PREFIXES.iter().any(|prefix| {
        service.strip_prefix(prefix).is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 64
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    })
}

fn check_login_service(service: &str) -> Result<(), String> {
    if connector_service_allowed(service) {
        Ok(())
    } else {
        Err("A connector login can only use a connector's own Keychain name.".into())
    }
}

/// What the connector-login commands do to the Keychain. Tests stand in for it.
pub(crate) trait LoginBackend {
    fn store(&self, service: &str, account: &str, secret: &str) -> Result<(), String>;
    fn exists(&self, service: &str, account: &str) -> Result<bool, String>;
    fn delete(&self, service: &str, account: &str) -> Result<bool, String>;
}

struct RealKeychain;

impl LoginBackend for RealKeychain {
    fn store(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        store(service, account, secret)
    }
    fn exists(&self, service: &str, account: &str) -> Result<bool, String> {
        exists(service, account)
    }
    fn delete(&self, service: &str, account: &str) -> Result<bool, String> {
        delete(service, account)
    }
}

pub(crate) fn login_store(
    backend: &dyn LoginBackend,
    service: &str,
    account: &str,
    secret: &str,
) -> Result<(), String> {
    check_login_service(service)?;
    backend.store(service, account, secret)
}

pub(crate) fn login_exists(
    backend: &dyn LoginBackend,
    service: &str,
    account: &str,
) -> Result<bool, String> {
    check_login_service(service)?;
    backend.exists(service, account)
}

pub(crate) fn login_delete(
    backend: &dyn LoginBackend,
    service: &str,
    account: &str,
) -> Result<bool, String> {
    check_login_service(service)?;
    backend.delete(service, account)
}

#[tauri::command]
pub async fn connector_login_store(
    service: String,
    account: String,
    secret: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        login_store(&RealKeychain, &service, &account, &secret)
    })
    .await
    .map_err(|_| crate::platform::secrets::unreachable().to_string())?
}

#[tauri::command]
pub async fn connector_login_exists(service: String, account: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || login_exists(&RealKeychain, &service, &account))
        .await
        .map_err(|_| crate::platform::secrets::unreachable().to_string())?
}

#[tauri::command]
pub async fn connector_login_delete(service: String, account: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || login_delete(&RealKeychain, &service, &account))
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

    /// Stands in for the Keychain and remembers what the connector-login commands asked of it.
    #[derive(Default)]
    struct Calls(std::cell::RefCell<Vec<String>>);

    impl LoginBackend for Calls {
        fn store(&self, service: &str, account: &str, _secret: &str) -> Result<(), String> {
            self.0
                .borrow_mut()
                .push(format!("store {service} {account}"));
            Ok(())
        }
        fn exists(&self, service: &str, account: &str) -> Result<bool, String> {
            self.0
                .borrow_mut()
                .push(format!("exists {service} {account}"));
            Ok(true)
        }
        fn delete(&self, service: &str, account: &str) -> Result<bool, String> {
            self.0
                .borrow_mut()
                .push(format!("delete {service} {account}"));
            Ok(true)
        }
    }

    #[test]
    fn the_webview_cannot_reach_a_model_key_or_any_other_internal_item_through_connector_logins() {
        let internal = [
            crate::model_router::KEY_SERVICE.to_string(),
            "monocode-hub-test:model-key".to_string(),
            "monocode-hub-dev:model-key".to_string(),
            "monocode-hub-sandbox:model-key".to_string(),
            crate::connectors::secrets::service("github"),
            "monocode-hub:page-source:p1".to_string(),
            // The bare name an earlier build used, and every way to make a login look like another item.
            "monocode-hub:github".to_string(),
            "monocode-hub:model-key:login:x".to_string(),
            "monocode-hub:login:".to_string(),
            "monocode-hub:login:model-key:x".to_string(),
            "monocode-hub:login:../x".to_string(),
            "monocode-hub:login:x y".to_string(),
            "monocode-hub:login:x\0y".to_string(),
            format!("monocode-hub:login:{}", "a".repeat(65)),
            "monocode-hub-dev:login:x".to_string(),
            "monocode-hub-sandbox:login:x".to_string(),
            "MONOCODE-HUB:login:x".to_string(),
            " monocode-hub:login:x".to_string(),
            "monocode-hub:login:x ".to_string(),
        ];
        for service in &internal {
            let calls = Calls::default();
            assert!(
                login_store(&calls, service, "custom-1", "secret-value").is_err(),
                "{service}"
            );
            assert!(
                login_exists(&calls, service, "custom-1").is_err(),
                "{service}"
            );
            assert!(
                login_delete(&calls, service, "custom-1").is_err(),
                "{service}"
            );
            assert!(
                calls.0.borrow().is_empty(),
                "{service}: {:?}",
                calls.0.borrow()
            );
        }
    }

    #[test]
    fn a_connector_login_service_is_the_login_namespace_and_nothing_else() {
        for service in [
            "monocode-hub:login:github",
            "monocode-hub:login:c-github",
            "monocode-hub:login:a.b_c-1",
            "monocode-hub-test:login:github",
        ] {
            let calls = Calls::default();
            login_store(&calls, service, "me@example.invalid", "secret-value").unwrap();
            assert!(login_exists(&calls, service, "me@example.invalid").unwrap());
            assert!(login_delete(&calls, service, "me@example.invalid").unwrap());
            assert_eq!(calls.0.borrow().len(), 3, "{service}");
        }
        // No internal service ever sits in that namespace.
        let id = "github";
        for internal in [
            crate::model_router::KEY_SERVICE.to_string(),
            crate::connectors::secrets::service(id),
            format!("monocode-hub:page-source:{id}"),
        ] {
            assert!(!connector_service_allowed(&internal), "{internal}");
        }
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
