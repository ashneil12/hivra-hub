//! Who may start a connector: only a session the app launched, for the Mono and projects the app named.
//!
//! `monocode connector-run` is the app's own binary, so it reads the Keychain without a prompt. Its arguments alone
//! (`--mono`, `--project`) would let any shell on this Mac name another Mono and get that Mono's login. So the app signs
//! each connector entry it puts in a session's `--mcp-config` (`harness_spawn` calls [`sign_session_args`]): an
//! HMAC-SHA256 over `id|mono|projects` (the projects joined by newlines, which a project key can't contain) with a
//! per-install key kept in the Keychain through the connector store (`monocode-hub:connector:launch-key`). The
//! launcher checks it before anything else ([`check`]) and refuses a missing or wrong one.
//!
//! The key never leaves Rust: the webview builds the entries without it, and no command or CLI hands out a signature.

use super::launch::{parse_args, SUBCOMMAND};
use super::secrets::{Keychain, Login, SecretStore};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// The connector store's name for the key. Not a catalog id, so no connector command can show, replace or remove it.
pub const KEY_ID: &str = "launch-key";
/// The launcher's argument that carries the signature.
pub const FLAG: &str = "--sig";
const FIELD: &str = "key";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

/// HMAC-SHA256 (RFC 2104).
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

fn message(id: &str, mono: &str, projects: &[String]) -> String {
    format!("{id}|{mono}|{}", projects.join("\n"))
}

/// The signature for one connector, one Mono, these projects (in this order).
pub fn sign(key: &[u8], id: &str, mono: &str, projects: &[String]) -> String {
    hex(&hmac_sha256(key, message(id, mono, projects).as_bytes()))
}

/// Whether `signature` is this key's for these arguments. Compared in constant time.
pub fn verify(key: &[u8], id: &str, mono: &str, projects: &[String], signature: &str) -> bool {
    let Some(given) = unhex(signature) else {
        return false;
    };
    let wanted = hmac_sha256(key, message(id, mono, projects).as_bytes());
    given.len() == wanted.len()
        && given
            .iter()
            .zip(wanted.iter())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

/// The key, from the store. `create`: make one (32 random bytes) when there is none; the launcher never does.
pub fn key(store: &dyn SecretStore, create: bool) -> Result<Option<Vec<u8>>, String> {
    if let Some(login) = store.get(KEY_ID)? {
        return login
            .fields
            .get(FIELD)
            .and_then(|text| unhex(text))
            .filter(|key| key.len() >= 32)
            .map(Some)
            .ok_or_else(|| "The connector signing key in the Keychain is damaged.".to_string());
    }
    if !create {
        return Ok(None);
    }
    let mut fresh = Vec::with_capacity(32);
    fresh.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    fresh.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    store.put(
        KEY_ID,
        &Login {
            fields: BTreeMap::from([(FIELD.to_string(), hex(&fresh))]),
            refs: BTreeMap::new(),
            oauth: None,
        },
    )?;
    Ok(Some(fresh))
}

/// The launcher's check: refused unless the app signed exactly these arguments.
pub fn check(
    store: &dyn SecretStore,
    id: &str,
    mono: &str,
    projects: &[String],
    signature: Option<&str>,
) -> Result<(), String> {
    const UNSIGNED: &str = "MonoCode Hub didn't start this connector for this Mono and these projects, so it won't run. Connectors start only from the app's own sessions.";
    let Some(signature) = signature else {
        return Err(UNSIGNED.into());
    };
    let Some(key) = key(store, false)? else {
        return Err(UNSIGNED.into());
    };
    if verify(&key, id, mono, projects, signature) {
        Ok(())
    } else {
        Err(UNSIGNED.into())
    }
}

/// Sign the connector entries of every inline `--mcp-config` in a Claude Code argv: each `mcpServers` entry whose command
/// is `launcher` and whose arguments are `connector-run …` gets `--sig` (any signature already there is replaced).
/// Anything else is left exactly as it was. The key is only read (or made) when there is an entry to sign.
pub fn sign_mcp_configs(
    args: Vec<String>,
    launcher: &str,
    key: &mut dyn FnMut() -> Result<Vec<u8>, String>,
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(args.len());
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--mcp-config" {
            out.push(arg);
            if let Some(raw) = iter.next() {
                out.push(sign_config(raw, launcher, key)?);
            }
        } else if let Some(raw) = arg.strip_prefix("--mcp-config=") {
            let signed = sign_config(raw.to_string(), launcher, key)?;
            out.push(format!("--mcp-config={signed}"));
        } else {
            out.push(arg);
        }
    }
    Ok(out)
}

fn sign_config(
    raw: String,
    launcher: &str,
    key: &mut dyn FnMut() -> Result<Vec<u8>, String>,
) -> Result<String, String> {
    let Ok(mut config) = serde_json::from_str::<Value>(&raw) else {
        return Ok(raw);
    };
    let Some(servers) = config.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Ok(raw);
    };
    let mut changed = false;
    for server in servers.values_mut() {
        if server.get("command").and_then(Value::as_str) != Some(launcher) {
            continue;
        }
        let Some(list) = server.get("args").and_then(Value::as_array) else {
            continue;
        };
        let Some(words) = list
            .iter()
            .map(|v| v.as_str().map(str::to_string))
            .collect::<Option<Vec<String>>>()
        else {
            continue;
        };
        if words.first().map(String::as_str) != Some(SUBCOMMAND) {
            continue;
        }
        // Whatever signature came with it is dropped; the app signs what it will really run.
        let mut plain = Vec::new();
        let mut rest = words[1..].iter();
        while let Some(word) = rest.next() {
            if word == FLAG {
                rest.next();
            } else {
                plain.push(word.clone());
            }
        }
        let Ok(parsed) = parse_args(&plain) else {
            continue;
        };
        let signature = sign(&key()?, &parsed.id, &parsed.mono, &parsed.projects);
        let mut signed: Vec<Value> = vec![Value::from(SUBCOMMAND)];
        signed.extend(plain.into_iter().map(Value::from));
        signed.push(Value::from(FLAG));
        signed.push(Value::from(signature));
        server["args"] = Value::Array(signed);
        changed = true;
    }
    Ok(if changed { config.to_string() } else { raw })
}

/// The app's key, read once per run of the app (made on first use).
fn app_key() -> Result<Vec<u8>, String> {
    static KEY: Mutex<Option<Vec<u8>>> = Mutex::new(None);
    let mut cached = KEY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(key) = cached.as_ref() {
        return Ok(key.clone());
    }
    let key = key(&Keychain, true)?.ok_or("Couldn't make the connector signing key.")?;
    *cached = Some(key.clone());
    Ok(key)
}

/// `harness_spawn`'s hook: sign this session's connector entries with the app's key. If the key can't be read, the
/// entries go unsigned and each connector refuses to start with a message saying why.
pub fn sign_session_args(args: Vec<String>) -> Vec<String> {
    let launcher = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    if launcher.is_empty() {
        return args;
    }
    match sign_mcp_configs(args.clone(), &launcher, &mut app_key) {
        Ok(signed) => signed,
        Err(why) => {
            eprintln!("Connectors: couldn't sign this session's connectors: {why}");
            args
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::secrets::Memory;
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231() {
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // A key longer than the block is hashed first (test case 6).
        assert_eq!(
            hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn the_key_is_made_once_and_never_by_the_launcher() {
        let store = Memory::default();
        assert_eq!(key(&store, false).unwrap(), None);
        let made = key(&store, true).unwrap().unwrap();
        assert_eq!(made.len(), 32);
        assert_eq!(key(&store, false).unwrap(), Some(made.clone()));
        assert_eq!(key(&store, true).unwrap(), Some(made));
        assert!(
            super::super::catalog::entry(KEY_ID).is_none(),
            "no connector shares the key's name"
        );
    }
}
