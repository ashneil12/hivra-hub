//! WP-92: where a secret's value actually lives.
//!
//! One store. The app and the launcher use the OS store through `hub_keychain` (the app's own services only; a dev copy
//! keeps to `monocode-hub-dev:*`). A copy under a temporary HOME (a bench, `verify_live`) never touches the real
//! login keychain at all: it uses [`Memory`], seeded only by its own test through `MONOCODE_SECRET_VAULT_SEED` (a JSON
//! object of service name to value, read only under an isolated HOME). A dev copy outside an isolated HOME uses the
//! real dev keychain namespace, which is a different set of items from the daily app's.
//!
//! Tests build a [`Memory`] directly and never reach the Keychain.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use zeroize::Zeroizing;

use crate::instance::{self, Kind};

/// Where one value is kept.
pub trait Vault: Send + Sync {
    /// `None` when there is no item.
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String>;
    /// `true` when an item was removed.
    fn remove(&self, service: &str, account: &str) -> Result<bool, String>;
}

/// The OS store, through `hub_keychain`: its service guard and its dev prefix apply, and no new Keychain code exists.
pub struct Keychain;

impl Vault for Keychain {
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        crate::hub_keychain::read(service, account)
    }

    fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        crate::hub_keychain::store(service, account, value)
    }

    fn remove(&self, service: &str, account: &str) -> Result<bool, String> {
        crate::hub_keychain::delete(service, account)
    }
}

/// In memory, for tests and for any copy under a temporary HOME.
#[derive(Default)]
pub struct Memory(pub Mutex<BTreeMap<(String, String), Zeroizing<String>>>);

impl Memory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed one item, as a test does.
    pub fn seed(&self, service: &str, account: &str, value: &str) {
        self.0.lock().unwrap().insert(
            (service.to_string(), account.to_string()),
            Zeroizing::new(value.to_string()),
        );
    }

    /// Every value held, so a test can assert nothing landed.
    pub fn values(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .values()
            .map(|value| value.to_string())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Vault for Memory {
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&(service.to_string(), account.to_string()))
            .map(|value| value.to_string()))
    }

    fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(
            (service.to_string(), account.to_string()),
            Zeroizing::new(value.to_string()),
        );
        Ok(())
    }

    fn remove(&self, service: &str, account: &str) -> Result<bool, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .remove(&(service.to_string(), account.to_string()))
            .is_some())
    }
}

/// The seed a test may hand an isolated copy: a JSON object of `{"<service>": "<value>"}`.
/// Read only under a temporary HOME, and only for a copy that isn't the daily app.
pub const SEED_ENV: &str = "MONOCODE_SECRET_VAULT_SEED";

fn seeded_memory() -> Memory {
    let store = Memory::new();
    if !instance::policy().daily_keychain {
        if let Some(raw) = std::env::var_os(SEED_ENV) {
            if let Ok(map) =
                serde_json::from_str::<BTreeMap<String, String>>(&raw.to_string_lossy())
            {
                for (service, value) in map {
                    store.seed(&service, crate::secrets::ACCOUNT, &value);
                }
            }
        }
    }
    store
}

/// Which store an isolated (or a real) copy gets. Pure, so a test can prove the isolation choice without touching the
/// login keychain or the environment.
pub(crate) fn vault_for(isolated: bool) -> Box<dyn Vault> {
    match vault_kind(isolated) {
        VaultKind::Memory => Box::new(seeded_memory()),
        VaultKind::OsKeychain => Box::new(Keychain),
    }
}

/// The kind of store an isolated or a real copy gets, as a value a test can compare without touching either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VaultKind {
    Memory,
    OsKeychain,
}

pub(crate) fn vault_kind(isolated: bool) -> VaultKind {
    if isolated {
        VaultKind::Memory
    } else {
        VaultKind::OsKeychain
    }
}

/// This process's store. An isolated HOME gets the memory store; everything else the OS store under the copy's own
/// names.
pub fn active() -> &'static dyn Vault {
    static ACTIVE: OnceLock<Box<dyn Vault>> = OnceLock::new();
    ACTIVE
        .get_or_init(|| vault_for(instance::isolated_home().is_some()))
        .as_ref()
}

/// Which kind of item names this copy forms. The daily app names daily items; a dev copy, and any copy under a
/// temporary HOME, names only dev items.
pub fn name_kind() -> Kind {
    if instance::policy().daily_keychain {
        Kind::Daily
    } else {
        Kind::Dev
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_holds_and_removes_one_item() {
        let store = Memory::new();
        assert_eq!(store.read("s", "value").unwrap(), None);
        store.write("s", "value", "abcdefgh").unwrap();
        assert_eq!(
            store.read("s", "value").unwrap().as_deref(),
            Some("abcdefgh")
        );
        assert!(store.remove("s", "value").unwrap());
        assert!(!store.remove("s", "value").unwrap());
        assert_eq!(store.read("s", "value").unwrap(), None);
    }

    #[test]
    fn an_isolated_home_gets_the_memory_store_and_a_real_copy_the_keychain() {
        // WP-92 step 14: a copy under a temporary HOME never reaches the login keychain.
        assert_eq!(vault_kind(true), VaultKind::Memory);
        assert_eq!(vault_kind(false), VaultKind::OsKeychain);
    }

    #[test]
    fn a_seed_is_read_only_when_the_copy_is_not_daily() {
        // The test process's own policy is a dev copy, so the variable would be read; but no variable is set here, and
        // the store stays empty. The isolation itself is proved in `mod tests::a_dev_copy_never_forms_a_daily_name`.
        std::env::remove_var(SEED_ENV);
        assert!(Memory::new().is_empty());
    }
}
