//! WP-92: the signed grant for one run.
//!
//! `secrets.run` approves a run and the app signs it into a base64 string that only the app's own `secret-run` child reads
//! (it is never returned to the webview, the control port or the agent). Inside is the run it permits, scope, name, version, subject,
//! the environment variable, the argv, the cwd, a nonce and an expiry, signed with HMAC-SHA256 under
//! `monocode-hub:secret-key:grant` (account `key`), created on first use and never handed to the webview. The item's
//! name has no scope segment, so it can never be mistaken for a secret.
//!
//! `monocode secret-run` verifies the signature before it reads anything, refuses an expired grant (60 seconds), and
//! refuses a nonce it has already seen. A tampered name, environment, command or cwd changes the payload, so the
//! signature no longer matches.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// The Keychain service. No scope segment, so it is never a secret's name.
pub const KEY_SERVICE: &str = "monocode-hub:secret-key:grant";
pub const KEY_ACCOUNT: &str = "key";
/// A grant lasts this long.
pub const TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub scope: String,
    pub name: String,
    pub version: i64,
    /// The Mono that asked.
    pub subject: String,
    /// The one environment variable the child gets.
    pub env: String,
    /// The argv, never a shell line.
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub nonce: String,
    /// Unix milliseconds.
    pub expires_at: i64,
    /// How long the command may run. Carried in the signed payload so a caller cannot stretch it.
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    /// The program's file identity when it was approved (`run::program_identity`). `command[0]` is its absolute path. A
    /// run refuses when the file no longer has this identity, so a program swapped after approval never runs.
    #[serde(default)]
    pub program_identity: String,
}

fn default_timeout() -> u64 {
    crate::secrets::TIMEOUT_DEFAULT
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    /// base64 of the payload's JSON.
    payload: String,
    /// The app's signature over that base64.
    sig: String,
}

fn encode_payload(payload: &Payload) -> Result<String, String> {
    let json = serde_json::to_vec(payload).map_err(|_| "Couldn't make the grant.".to_string())?;
    Ok(STANDARD.encode(json))
}

fn decode_payload(encoded: &str) -> Result<Payload, String> {
    let raw = STANDARD
        .decode(encoded)
        .map_err(|_| "That grant is damaged.".to_string())?;
    serde_json::from_slice(&raw).map_err(|_| "That grant is damaged.".to_string())
}

/// The key, from the vault's store (the Keychain in the app; memory under a temporary HOME). `create`: make one (32
/// random bytes) when there is none; the launcher never does. The bytes never leave Rust and never reach a command.
pub fn key(vault: &dyn super::store::Vault, create: bool) -> Result<Option<Vec<u8>>, String> {
    match vault.read(KEY_SERVICE, KEY_ACCOUNT)? {
        Some(text) => {
            let bytes = unhex(text.trim()).ok_or_else(|| {
                "The secret signing key in the Keychain is damaged. Delete it under Settings > Secrets."
                    .to_string()
            })?;
            if bytes.len() < 32 {
                return Err(
                    "The secret signing key in the Keychain is damaged. Delete it under Settings > Secrets."
                        .to_string(),
                );
            }
            Ok(Some(bytes))
        }
        None if create => {
            let mut fresh = Vec::with_capacity(32);
            fresh.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
            fresh.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
            vault.write(KEY_SERVICE, KEY_ACCOUNT, &hex(&fresh))?;
            Ok(Some(fresh))
        }
        None => Ok(None),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The key `secret-run` uses: read only, never created (the app makes it).
pub fn signing_key(vault: &dyn super::store::Vault) -> Result<Vec<u8>, String> {
    key(vault, false)?.ok_or_else(|| {
        "The app didn't sign this run, so it won't start. Ask the Mono again from the app."
            .to_string()
    })
}

/// Sign one payload and return the base64 the app passes to `monocode secret-run` on stdin.
pub fn sign_payload(vault: &dyn super::store::Vault, payload: &Payload) -> Result<String, String> {
    let key =
        key(vault, true)?.ok_or_else(|| "Couldn't make the secret signing key.".to_string())?;
    let encoded = encode_payload(payload)?;
    let sig = crate::connectors::signing::sign(&key, &encoded, "", &[]);
    let envelope = serde_json::to_vec(&Envelope {
        payload: encoded,
        sig,
    })
    .map_err(|_| "Couldn't make the grant.".to_string())?;
    Ok(STANDARD.encode(envelope))
}

/// Whether the grant's 60 seconds are up. `now` is Unix milliseconds.
pub fn is_expired(payload: &Payload, now: i64) -> bool {
    now > payload.expires_at
}

/// What a saved `connectors.json` login may hold in place of a value: `{"secret": "<name>"}`, resolved through the same
/// vault scope at launch (see `connectors::launch`).
pub const REFERENCE_KEY: &str = "secret";

/// Unix milliseconds.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Verify the signature, the expiry and the nonce, in that order. `now` is Unix milliseconds.
pub fn check(
    vault: &dyn super::store::Vault,
    grant: &str,
    nonce_dir: &Path,
    now: i64,
) -> Result<Payload, String> {
    let raw = STANDARD
        .decode(grant.trim())
        .map_err(|_| "That grant is damaged.".to_string())?;
    let envelope: Envelope =
        serde_json::from_slice(&raw).map_err(|_| "That grant is damaged.".to_string())?;
    let payload = decode_payload(&envelope.payload)?;
    let key = signing_key(vault)?;
    if !crate::connectors::signing::verify(&key, &envelope.payload, "", &[], &envelope.sig) {
        return Err(
            "The app didn't sign this run, so it won't start. Ask the Mono again from the app."
                .to_string(),
        );
    }
    if is_expired(&payload, now) {
        return Err("That approval took too long. Ask the Mono to run it again.".to_string());
    }
    claim_nonce(nonce_dir, &payload.nonce, now)?;
    Ok(payload)
}

/// A nonce is good once. `create_new` is the atomic claim: two launches of the same grant cannot both pass.
fn claim_nonce(dir: &Path, nonce: &str, now: i64) -> Result<(), String> {
    if nonce.len() < 8 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("That grant is damaged.".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|_| "Couldn't check that grant.".to_string())?;
    prune_nonces(dir, now);
    let path = dir.join(nonce);
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            Err("That approval was already used. Ask the Mono to run it again.".to_string())
        }
        Err(_) => Err("Couldn't check that grant.".to_string()),
    }
}

/// Old nonce files are removed; a file only needs to outlive the grant's 60 seconds.
fn prune_nonces(dir: &Path, now: i64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(since) = modified.duration_since(UNIX_EPOCH) else {
            continue;
        };
        let age = now.saturating_sub(since.as_millis() as i64);
        if age > 10 * 60 * 1000 {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Where nonce files live: the copy's own data folder.
pub fn nonce_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets").join("nonces")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> Payload {
        Payload {
            program_identity: String::new(),
            scope: "global".into(),
            name: "stripe-api-key".into(),
            version: 1,
            subject: "mono-1".into(),
            env: "STRIPE_API_KEY".into(),
            command: vec!["stripe".into(), "customers".into(), "list".into()],
            cwd: None,
            nonce: "0011223344556677".into(),
            expires_at: now_millis() + 60_000,
            timeout_seconds: 120,
        }
    }

    /// Sign with a key of the test's own, so no Keychain is touched.
    fn sign_with(key: &[u8], payload: &Payload) -> String {
        let encoded = encode_payload(payload).unwrap();
        let sig = crate::connectors::signing::sign(key, &encoded, "", &[]);
        STANDARD.encode(
            serde_json::to_vec(&Envelope {
                payload: encoded,
                sig,
            })
            .unwrap(),
        )
    }

    fn verify_with(key: &[u8], grant: &str) -> bool {
        let Ok(raw) = STANDARD.decode(grant.trim()) else {
            return false;
        };
        let Ok(envelope) = serde_json::from_slice::<Envelope>(&raw) else {
            return false;
        };
        crate::connectors::signing::verify(key, &envelope.payload, "", &[], &envelope.sig)
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mc-grant-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_signed_payload_verifies_and_round_trips() {
        let key = b"0123456789abcdef0123456789abcdef";
        let original = payload();
        let grant = sign_with(key, &original);
        assert!(verify_with(key, &grant));
        let raw = STANDARD.decode(&grant).unwrap();
        let envelope: Envelope = serde_json::from_slice(&raw).unwrap();
        assert_eq!(decode_payload(&envelope.payload).unwrap(), original);
    }

    #[test]
    fn a_tampered_name_env_command_or_cwd_does_not_verify() {
        let key = b"0123456789abcdef0123456789abcdef";
        let original = payload();
        let good = sign_with(key, &original);
        for tampered in [
            Payload {
                name: "other-key".into(),
                ..original.clone()
            },
            Payload {
                env: "OTHER_API_KEY".into(),
                ..original.clone()
            },
            Payload {
                command: vec!["sh".into(), "-c".into(), "echo hi".into()],
                ..original.clone()
            },
            Payload {
                cwd: Some("/tmp".into()),
                ..original.clone()
            },
            Payload {
                version: 2,
                ..original.clone()
            },
        ] {
            // Swap the payload but keep the signature: the signature no longer matches.
            let raw = STANDARD.decode(&good).unwrap();
            let mut envelope: Envelope = serde_json::from_slice(&raw).unwrap();
            envelope.payload = encode_payload(&tampered).unwrap();
            let forged = STANDARD.encode(serde_json::to_vec(&envelope).unwrap());
            assert!(!verify_with(key, &forged), "{tampered:?}");
        }
        assert!(verify_with(key, &good));
    }

    #[test]
    fn an_expired_grant_is_refused_and_a_wrong_key_is_refused() {
        let now = now_millis();
        assert!(is_expired(&payload(), now + 61_000));
        assert!(!is_expired(&payload(), now + 59_000));
        // A grant signed with another key does not verify, so the run never starts.
        let theirs = b"ffffffffffffffffffffffffffffffff";
        let ours = b"0123456789abcdef0123456789abcdef";
        assert!(verify_with(ours, &sign_with(ours, &payload())));
        assert!(!verify_with(ours, &sign_with(theirs, &payload())));
        // A damaged grant is refused before any store read.
        let vault = super::super::store::Memory::new();
        assert!(check(&vault, "not-base64", &temp_dir(), now).is_err());
        assert!(check(&vault, "eyJwYXlsb2FkIjoiIiwic2lnIjoiIn0=", &temp_dir(), now).is_err());
    }

    #[test]
    fn a_nonce_is_good_once() {
        let dir = temp_dir();
        let now = now_millis();
        assert!(claim_nonce(&dir, "0011223344556677", now).is_ok());
        assert!(claim_nonce(&dir, "0011223344556677", now).is_err());
        assert!(claim_nonce(&dir, "8899aabbccddeeff", now).is_ok());
        // A nonce must look like one; the file name is not a place to smuggle a path.
        assert!(claim_nonce(&dir, "../escape", now).is_err());
        assert!(claim_nonce(&dir, "short", now).is_err());
    }

    #[test]
    fn the_key_item_is_never_a_secret_name() {
        // A secret's service always carries a scope segment; the key's does not.
        assert!(!KEY_SERVICE.contains(":secret:"));
        assert!(KEY_SERVICE.starts_with("monocode-hub"));
        assert!(
            crate::hub_keychain::scoped_service(crate::instance::Kind::Dev, KEY_SERVICE)
                .starts_with(crate::hub_keychain::DEV_PREFIX)
        );
    }
}
