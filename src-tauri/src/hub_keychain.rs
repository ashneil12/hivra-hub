//! Connector logins in the macOS Keychain (Windows/Linux: the platform store, through `keyring`).
//!
//! Only items whose service starts with `monocode-hub` are ever written, checked or deleted: the app can never reach
//! another Keychain item through these commands. A login's secret goes in and never comes back out to the webview:
//! `connector_login_exists` answers yes or no only.

const PREFIX: &str = "monocode-hub";

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

fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    check_service(service)?;
    if account.is_empty() || account.len() > 200 {
        return Err("A login needs an account name.".into());
    }
    keyring::Entry::new(service, account).map_err(|_| "Couldn't reach the Keychain.".to_string())
}

pub fn store(service: &str, account: &str, secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        return Err("Nothing to save.".into());
    }
    entry(service, account)?
        .set_password(secret)
        .map_err(|_| "The Keychain didn't save the login.".to_string())
}

pub fn exists(service: &str, account: &str) -> Result<bool, String> {
    match entry(service, account)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("Couldn't check the Keychain.".into()),
    }
}

/// For the app's own use in Rust only (the model router). Never exposed as a command: secrets don't go back to the webview.
pub(crate) fn read(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry(service, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Couldn't read the key from the Keychain.".into()),
    }
}

pub fn delete(service: &str, account: &str) -> Result<bool, String> {
    match entry(service, account)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("The Keychain didn't remove the login.".into()),
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
        .map_err(|_| "Couldn't reach the Keychain.".to_string())?
}

#[tauri::command]
pub async fn connector_login_exists(service: String, account: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || exists(&service, &account))
        .await
        .map_err(|_| "Couldn't reach the Keychain.".to_string())?
}

#[tauri::command]
pub async fn connector_login_delete(service: String, account: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || delete(&service, &account))
        .await
        .map_err(|_| "Couldn't reach the Keychain.".to_string())?
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
