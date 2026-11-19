// WP-09: the secret store's name, and the words a failure uses.
// macOS strings stay exactly the Keychain sentences hub_keychain already showed.
// keyring itself is already selected per platform in Cargo.toml (Credential Manager, Secret Service).

/// Which store this build talks to. Tests check the name; they never write a real secret.
#[cfg(test)]
pub fn backend_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "keychain"
    }
    #[cfg(target_os = "windows")]
    {
        "credential-manager"
    }
    #[cfg(target_os = "linux")]
    {
        "secret-service"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "none"
    }
}

pub fn unreachable() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Couldn't reach the Keychain."
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Couldn't reach the secret store."
    }
}

pub fn not_saved() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "The Keychain didn't save the login."
    }
    #[cfg(not(target_os = "macos"))]
    {
        "The secret store didn't save the login."
    }
}

pub fn not_checked() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Couldn't check the Keychain."
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Couldn't check the secret store."
    }
}

pub fn not_read() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Couldn't read the key from the Keychain."
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Couldn't read the key from the secret store."
    }
}

/// WP-92: a store that won't let this process in, in the person's words. `keyring` reports that as `NoStorageAccess`;
/// a Mac denies or unlocks interactively, and that refusal keeps its own sentence ("try again").
pub fn locked() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Your Mac's keychain is locked. Unlock it and try again."
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Your secret store is locked. Unlock it and try again."
    }
}

pub fn not_removed() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "The Keychain didn't remove the login."
    }
    #[cfg(not(target_os = "macos"))]
    {
        "The secret store didn't remove the login."
    }
}

/// WP-92: the person said no to the system prompt (or it could not be shown). Not "locked": nothing needs unlocking,
/// the person only has to allow it when it asks again.
pub fn denied() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Your Mac's keychain didn't let this app use that key. Click Allow when macOS asks, then try again."
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Your secret store didn't let this app use that key. Allow it when it asks, then try again."
    }
}

#[cfg(test)]
mod tests {
    use super::backend_name;

    #[test]
    fn the_secret_store_is_the_one_this_platform_has() {
        let name = backend_name();
        #[cfg(target_os = "macos")]
        assert_eq!(name, "keychain");
        #[cfg(target_os = "windows")]
        assert_eq!(name, "credential-manager");
        #[cfg(target_os = "linux")]
        assert_eq!(name, "secret-service");
    }

    #[test]
    fn failure_words_stay_the_keychain_sentences_on_a_mac() {
        #[cfg(target_os = "macos")]
        {
            assert_eq!(super::unreachable(), "Couldn't reach the Keychain.");
            assert_eq!(super::not_saved(), "The Keychain didn't save the login.");
            assert_eq!(super::not_checked(), "Couldn't check the Keychain.");
            assert_eq!(
                super::not_read(),
                "Couldn't read the key from the Keychain."
            );
            assert_eq!(
                super::not_removed(),
                "The Keychain didn't remove the login."
            );
            assert_eq!(
                super::locked(),
                "Your Mac's keychain is locked. Unlock it and try again."
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            for sentence in [
                super::unreachable(),
                super::not_saved(),
                super::not_checked(),
                super::not_read(),
                super::not_removed(),
                super::locked(),
                super::denied(),
            ] {
                assert!(!sentence.contains("Keychain"), "{sentence}");
            }
        }
    }
}
