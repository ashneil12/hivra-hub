//! The accept write. A hash mismatch is "try again", not a lost edit.
//!
//! A plugin path is refused even if a caller names it. A secret is not saved.
//! The size rule matches the TypeScript budget: over the cap, the edit must shrink.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const INSTRUCTION_CAP: usize = 2000;
const PROFILE_CAP: usize = 1500;
const MAX_STATE_BYTES: usize = 1_000_000;
const CAP_REFUSAL: &str =
    "This edit must remove or merge something so the file stays under its size.";
const PLUGIN_REFUSAL: &str =
    "A plugin's files are not edited. A lesson about a plugin goes in the first mate's own instructions.";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedState {
    pub revision: u64,
    pub state: Value,
}

fn lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

const LEARN_FILES: [&str; 4] = ["opinions.md", "voice.md", "AGENTS.md", "CLAUDE.md"];

/// The command's write. Only a profile file inside this learn folder, then the hash check.
pub fn apply_inside(
    dir: &Path,
    path: &Path,
    expected_sha256: &str,
    next: &str,
    role: &str,
) -> Result<bool, String> {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err("That file isn't in the learn folder.".into());
    };
    if !LEARN_FILES.contains(&name)
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || is_symlink(dir)
    {
        return Err("That file isn't in the learn folder.".into());
    }
    let joined = absolute(dir).join(name);
    if absolute(path) != joined {
        return Err("That file isn't in the learn folder.".into());
    }
    learn_apply(&joined, expected_sha256, next, role)
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

pub fn learn_apply(
    path: &Path,
    expected_sha256: &str,
    next: &str,
    role: &str,
) -> Result<bool, String> {
    let _guard = lock();
    let text = path.to_string_lossy();
    if text.contains('\0')
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("That path is not inside the named file.".into());
    }
    if is_plugin_path(&text) {
        return Err(PLUGIN_REFUSAL.into());
    }
    if mentions_secret(next) {
        return Err("That edit looks like it contains a secret, so it was not saved.".into());
    }
    if is_symlink(path) {
        return Err("Couldn't save that file.".into());
    }
    let Some(parent) = path.parent() else {
        return Err("Couldn't save that file.".into());
    };
    if parent.as_os_str().is_empty() || is_symlink(parent) {
        return Err("Couldn't save that file.".into());
    }
    let current = if path.is_file() {
        fs::read(path).map_err(|_| "Couldn't save that file.".to_string())?
    } else if path.exists() {
        return Err("Couldn't save that file.".into());
    } else {
        Vec::new()
    };
    let current_text = String::from_utf8_lossy(&current);
    if budget_blocks(&current_text, next, cap_for(role)) {
        return Err(CAP_REFUSAL.into());
    }
    if !sha_matches(&current, expected_sha256) {
        return Ok(false);
    }
    fs::create_dir_all(parent).map_err(|_| "Couldn't save that file.".to_string())?;
    let fresh = if path.is_file() {
        fs::read(path).map_err(|_| "Couldn't save that file.".to_string())?
    } else {
        Vec::new()
    };
    if fresh != current {
        return Ok(false);
    }
    let tmp = temp_path(path);
    if is_symlink(&tmp) {
        if tmp.parent() != Some(parent) {
            return Err("Couldn't save that file.".into());
        }
        fs::remove_file(&tmp).map_err(|_| "Couldn't save that file.".to_string())?;
    }
    let mut file = File::create(&tmp).map_err(|_| "Couldn't save that file.".to_string())?;
    file.write_all(next.as_bytes())
        .map_err(|_| "Couldn't save that file.".to_string())?;
    file.sync_all()
        .map_err(|_| "Couldn't save that file.".to_string())?;
    drop(file);
    if is_symlink(path) {
        let _ = fs::remove_file(&tmp);
        return Err("Couldn't save that file.".into());
    }
    fs::rename(&tmp, path).map_err(|_| "Couldn't save that file.".to_string())?;
    Ok(true)
}

pub fn state_load(dir: &Path) -> Result<LoadedState, String> {
    let _guard = lock();
    load_unlocked(dir)
}

pub fn state_cas(dir: &Path, expected: u64, state: Value) -> Result<bool, String> {
    let _guard = lock();
    if !state.is_object() {
        return Err("That could not be saved.".into());
    }
    let bytes = serde_json::to_vec_pretty(&json!({
        "revision": expected + 1,
        "state": state,
    }))
    .map_err(|_| "That could not be saved.".to_string())?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err("That could not be saved.".into());
    }
    let text = String::from_utf8_lossy(&bytes);
    if mentions_secret(&text) {
        return Err("That looks like it contains a secret, so it was not saved.".into());
    }
    if is_symlink(dir) {
        return Err("Couldn't save that.".into());
    }
    fs::create_dir_all(dir).map_err(|_| "Couldn't save that.".to_string())?;
    let path = dir.join("state.json");
    if path.parent() != Some(dir) || is_symlink(&path) {
        return Err("Couldn't save that.".into());
    }
    let current = load_unlocked(dir)?;
    if current.revision != expected {
        return Ok(false);
    }
    let tmp = dir.join("state.json.tmp");
    if is_symlink(&tmp) {
        fs::remove_file(&tmp).map_err(|_| "Couldn't save that.".to_string())?;
    }
    let mut file = File::create(&tmp).map_err(|_| "Couldn't save that.".to_string())?;
    file.write_all(&bytes)
        .map_err(|_| "Couldn't save that.".to_string())?;
    file.sync_all()
        .map_err(|_| "Couldn't save that.".to_string())?;
    drop(file);
    if is_symlink(&path) {
        let _ = fs::remove_file(&tmp);
        return Err("Couldn't save that.".into());
    }
    fs::rename(&tmp, &path).map_err(|_| "Couldn't save that.".to_string())?;
    Ok(true)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProfiles {
    pub opinions: String,
    pub voice: String,
    pub agents: String,
    pub claude: String,
    pub opinions_sha256: String,
    pub voice_sha256: String,
    pub agents_sha256: String,
    pub claude_sha256: String,
}

/// opinions.md, voice.md and the one instruction file, only inside this folder.
pub fn profile_load(dir: &Path) -> Result<LoadedProfiles, String> {
    let _guard = lock();
    if is_symlink(dir) {
        return Err("Couldn't read that file.".into());
    }
    let (opinions, opinions_sha256) = read_named(dir, "opinions.md")?;
    let (voice, voice_sha256) = read_named(dir, "voice.md")?;
    let (agents, agents_sha256) = read_named(dir, "AGENTS.md")?;
    let (claude, claude_sha256) = read_named(dir, "CLAUDE.md")?;
    Ok(LoadedProfiles {
        opinions,
        voice,
        agents,
        claude,
        opinions_sha256,
        voice_sha256,
        agents_sha256,
        claude_sha256,
    })
}

pub fn profile_save(dir: &Path, which: &str, expected: &str, next: &str) -> Result<bool, String> {
    let (name, role) = match which {
        "opinions" => ("opinions.md", "opinions"),
        "voice" => ("voice.md", "voice"),
        "agents" => ("AGENTS.md", "instruction"),
        "claude" => ("CLAUDE.md", "instruction"),
        _ => return Err("That file isn't one of the profile files.".into()),
    };
    if is_symlink(dir) {
        return Err("Couldn't save that file.".into());
    }
    let path = dir.join(name);
    if path.parent() != Some(dir) {
        return Err("Couldn't save that file.".into());
    }
    learn_apply(&path, expected, next, role)
}

fn read_named(dir: &Path, name: &str) -> Result<(String, String), String> {
    let path = dir.join(name);
    if path.parent() != Some(dir) || is_symlink(&path) {
        return Err("Couldn't read that file.".into());
    }
    if !path.exists() {
        return Ok((String::new(), sha256_hex(b"")));
    }
    if !path.is_file() {
        return Err("Couldn't read that file.".into());
    }
    let bytes = fs::read(&path).map_err(|_| "Couldn't read that file.".to_string())?;
    let sha = sha256_hex(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| "Couldn't read that file.".to_string())?;
    Ok((text, sha))
}

fn load_unlocked(dir: &Path) -> Result<LoadedState, String> {
    let path = dir.join("state.json");
    if is_symlink(&path) {
        return Err("Couldn't read the saved lessons.".into());
    }
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) if value.is_object() => Ok(LoadedState {
                revision: value.get("revision").and_then(Value::as_u64).unwrap_or(0),
                state: value
                    .get("state")
                    .cloned()
                    .filter(|state| state.is_object())
                    .unwrap_or_else(|| json!({})),
            }),
            Ok(_) | Err(_) => Err("Couldn't read the saved lessons.".into()),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(LoadedState {
            revision: 0,
            state: json!({}),
        }),
        Err(_) => Err("Couldn't read the saved lessons.".into()),
    }
}

fn cap_for(role: &str) -> usize {
    if role == "opinions" || role == "voice" {
        PROFILE_CAP
    } else {
        INSTRUCTION_CAP
    }
}

fn tokens(text: &str) -> usize {
    text.len().saturating_add(3) / 4
}

fn budget_blocks(current: &str, next: &str, cap: usize) -> bool {
    let now = tokens(current);
    let projected = tokens(next);
    if now <= cap && projected > cap {
        return true;
    }
    if now > cap && projected >= now {
        return true;
    }
    false
}

fn sha_matches(bytes: &[u8], expected: &str) -> bool {
    sha256_hex(bytes) == expected.trim().to_ascii_lowercase()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(".learn.tmp");
    path.with_file_name(name)
}

fn is_plugin_path(file: &str) -> bool {
    let norm = file.replace('\\', "/");
    let parts: Vec<&str> = norm
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    for index in 0..parts.len().saturating_sub(1) {
        let here = parts[index].to_ascii_lowercase();
        let next = parts[index + 1].to_ascii_lowercase();
        if here == "plugins" && (next == "installed" || next == "pstack") {
            return true;
        }
        if here == "pstack" && next == "skills" {
            return true;
        }
    }
    false
}

fn mentions_secret(text: &str) -> bool {
    let scrubber = crate::portable::scrubber();
    if scrubber.has_secret(text) {
        return true;
    }
    if !(text.contains('/') || text.contains('\\') || text.contains(':')) {
        return false;
    }
    scrubber.has_secret(&text.replace(['/', '\\', ':'], " "))
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}
