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
        }
        #[cfg(not(target_os = "macos"))]
        {
            for sentence in [
                super::unreachable(),
                super::not_saved(),
                super::not_checked(),
                super::not_read(),
                super::not_removed(),
            ] {
                assert!(!sentence.contains("Keychain"), "{sentence}");
            }
        }
    }
}
