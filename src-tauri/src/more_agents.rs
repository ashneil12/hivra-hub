//! WP-134: More agents. The saved list of local ACP agents, the approval each one needs before it runs, and the
//! environment a More agents child gets. The webview names an entry by its id only. The command and its arguments are
//! read here, from the saved list, when the process starts (`harness_spawn` with `more_agent`), and only if the person
//! approved that exact command. The TypeScript side (src/features/providers/model/moreAgents.ts) validates the same
//! rules for display; this module is the last check before anything runs.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub(crate) const FILE_NAME: &str = "more-agents.json";
const PROTOCOL: &str = "acp-v1";
const MAX_AGENTS: usize = 100;
const MAX_ENTRY_BYTES: usize = 16 * 1024;
const MAX_ARGS: usize = 64;
const MAX_FIELD: usize = 4096;

/// The eleven first-class CLIs. An entry may use none of these ids (src/features/sessions/model/session.ts).
pub(crate) const FIRST_CLASS_IDS: [&str; 11] = [
    "claude",
    "codex",
    "cursor",
    "grok",
    "opencode",
    "pi",
    "omp",
    "fx",
    "hermes",
    "antigravity",
    "devin",
];

/// The commands the eleven CLIs run as. Kept in step with FIRST_CLASS_COMMANDS in moreAgents.ts.
pub(crate) const FIRST_CLASS_COMMANDS: [&str; 13] = [
    "claude",
    "codex",
    "cursor-agent",
    "agent",
    "grok",
    "opencode",
    "pi",
    "pi-coding-agent",
    "omp",
    "fx",
    "hermes",
    "agy_acp_server.par",
    "devin",
];

/// Environment names a More agents child may inherit. Everything else the app has (keys, tokens, the control
/// endpoint) is removed before the spawn.
const ALLOWED_ENV: [&str; 16] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "SYSTEMROOT",
    "APPDATA",
    "LOCALAPPDATA",
    "PATHEXT",
    "COMSPEC",
];

/// Shells and their inline-program flags. A More agent is one program, never a shell that runs a string.
const SHELLS: [&str; 12] = [
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "csh",
    "tcsh",
    "cmd",
    "powershell",
    "pwsh",
    "env",
];
const INLINE_FLAGS: [&str; 9] = [
    "-c",
    "-e",
    "--eval",
    "-p",
    "--print",
    "/c",
    "/k",
    "-command",
    "-encodedcommand",
];
pub(crate) const SHELL_REFUSED: &str =
    "A shell cannot be a More agent. Point at the agent program itself.";
pub(crate) const RELATIVE_REFUSED: &str =
    "An argument that names a file must give its full absolute path. A relative path is not pinned, so it is refused.";
pub(crate) const INLINE_REFUSED: &str =
    "An agent cannot be started with an inline program (-c, -e, --eval or -p). Point at its program file.";
pub(crate) const SHOWN_CHANGED: &str =
    "This agent changed since you looked at it. Review it again before you allow it.";
pub(crate) const ON_DISK_CHANGED: &str =
    "This agent's program changed on disk since you allowed it. Allow it again in More agents.";

pub(crate) const CHANGED: &str =
    "The list changed in another window (revision). Reload it and try again.";
pub(crate) const NOT_APPROVED: &str =
    "This agent is not approved to run. Allow it in More agents first.";
pub(crate) const NO_COMMAND_FROM_APP: &str = "A More agents start takes no command from the app.";
pub(crate) const CORRUPT: &str = "The saved More agents list cannot be read. It was left as it is.";

/// Serialises every read-modify-write of the file, so an approval and a list write cannot overwrite each other.
static LOCK: Mutex<()> = Mutex::new(());

/// What the person allowed for one entry: the fingerprint of its command and arguments, the file that resolved to at
/// the time, and that file's SHA-256. A later spawn must match all three.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Approval {
    pub fingerprint: String,
    pub path: String,
    pub sha256: String,
    /// Absolute file arguments that were files at approval, each with its SHA-256 then. Every one must still match.
    pub pins: Vec<(String, String)>,
    /// The approval generation this record was issued in. The Keychain holds the current one, so a record kept from an
    /// earlier generation (a withdrawn approval put back, say) does not count.
    pub generation: String,
    /// HMAC-SHA256 over every field above, keyed with the install's approval key (Keychain). A record edited by hand,
    /// or written without the key, does not verify and is dropped on read.
    pub mac: String,
}

#[cfg_attr(test, allow(dead_code))]
const GEN_SERVICE: &str = "monocode-hub:more-agents-approval-generation";
#[cfg_attr(test, allow(dead_code))]
const GEN_ACCOUNT: &str = "approvals";

#[cfg(test)]
thread_local! {
    pub(crate) static TEST_GEN: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// The current approval generation. Nothing in the data folder can move it back.
#[cfg(test)]
fn approval_generation() -> Result<Option<String>, String> {
    Ok(TEST_GEN.with(|g| g.borrow().clone()))
}

#[cfg(test)]
fn store_generation(generation: &str) -> Result<(), String> {
    TEST_GEN.with(|g| *g.borrow_mut() = Some(generation.to_string()));
    Ok(())
}

#[cfg(not(test))]
fn approval_generation() -> Result<Option<String>, String> {
    crate::hub_keychain::read_internal(GEN_SERVICE, GEN_ACCOUNT)
}

#[cfg(not(test))]
fn store_generation(generation: &str) -> Result<(), String> {
    crate::hub_keychain::store_internal(GEN_SERVICE, GEN_ACCOUNT, generation)
}

/// A new generation: random, so a value that was used before (a reset item, a copy) never comes back.
fn new_generation() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Keychain item for the approval key. Dev copies use `monocode-hub-dev:` through `hub_keychain`, like every app secret.
#[cfg_attr(test, allow(dead_code))]
const KEY_SERVICE: &str = "monocode-hub:more-agents-approval-key";
#[cfg_attr(test, allow(dead_code))]
const KEY_ACCOUNT: &str = "approvals";
const NO_KEY: &str =
    "The approval key is not available, so More agents approvals cannot be checked.";

#[cfg(test)]
thread_local! {
    /// Tests use this fake key store on their own thread. A test never reaches the Keychain.
    pub(crate) static TEST_KEY: std::cell::RefCell<Option<Vec<u8>>> = const { std::cell::RefCell::new(None) };
}

/// The approval key. `create` makes one on first use (a write); a read never creates one.
#[cfg(test)]
fn approval_key(create: bool) -> Result<Vec<u8>, String> {
    TEST_KEY.with(|key| {
        let mut key = key.borrow_mut();
        if key.is_none() && create {
            *key = Some(new_key());
        }
        key.clone().ok_or_else(|| NO_KEY.to_string())
    })
}

#[cfg(not(test))]
fn approval_key(create: bool) -> Result<Vec<u8>, String> {
    match crate::hub_keychain::read_internal(KEY_SERVICE, KEY_ACCOUNT)? {
        Some(text) => unhex(&text).ok_or_else(|| NO_KEY.to_string()),
        None if create => {
            let key = new_key();
            crate::hub_keychain::store_internal(KEY_SERVICE, KEY_ACCOUNT, &hex(&key))?;
            Ok(key)
        }
        None => Err(NO_KEY.to_string()),
    }
}

fn new_key() -> Vec<u8> {
    [
        uuid::Uuid::new_v4().as_bytes().as_slice(),
        uuid::Uuid::new_v4().as_bytes().as_slice(),
    ]
    .concat()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg_attr(test, allow(dead_code))]
fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// HMAC-SHA256 of length-prefixed parts, hex. Written out over `sha2` so the crate set does not grow.
fn mac(key: &[u8], parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let ipad: Vec<u8> = block.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = block.iter().map(|b| b ^ 0x5c).collect();
    let mut inner = Sha256::new();
    inner.update(&ipad);
    for part in parts {
        inner.update(format!("{}:", part.len()).as_bytes());
        inner.update(part.as_bytes());
    }
    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(inner.finalize());
    hex(&outer.finalize())
}

/// The MAC an approval must carry to be honoured: every field it holds, the pins and the generation included.
fn approval_mac_of(key: &[u8], id: &str, a: &Approval) -> String {
    let pins = a
        .pins
        .iter()
        .map(|(path, sha)| format!("{path}\u{0}{sha}"))
        .collect::<Vec<_>>()
        .join("\u{1}");
    mac(
        key,
        &[id, &a.fingerprint, &a.path, &a.sha256, &a.generation, &pins],
    )
}

/// The loader flags: each loads a file as code or configuration, so its value must be an absolute, pinned file.
const LOADER_FLAGS: [&str; 8] = [
    "-m",
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--env-file",
    "--preload",
];
pub(crate) const LOADER_REFUSED: &str =
    "A loader flag (-m, -r, --require, --import, --loader, --env-file, --preload) must name an absolute file.";
pub(crate) const OFF_REFUSED: &str =
    "More agents is off. Switch it on in Settings to run this agent.";
const ENABLED_FILE: &str = "more-agents-enabled";

/// The More agents switch as the app keeps it: a file in the app's folder that the webview writes when the person
/// flips the setting. Off unless the file says on.
pub(crate) fn enabled(data_dir: &Path) -> bool {
    std::fs::read_to_string(data_dir.join(ENABLED_FILE)).is_ok_and(|text| text.trim() == "on")
}

/// Writes the switch. Only the app's own command calls this.
pub(crate) fn set_enabled(data_dir: &Path, on: bool) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("Could not save the switch: {e}"))?;
    std::fs::write(data_dir.join(ENABLED_FILE), if on { "on" } else { "off" })
        .map_err(|e| format!("Could not save the switch: {e}"))
}

pub(crate) const FILE_ARG_REFUSED: &str =
    "A file named in the arguments must exist and be a file, given by its absolute path. A folder is not pinned.";

/// The text an argument may carry a path in: the argument itself, the part after `=`, or the rest of a short flag.
fn candidates(arg: &str) -> Vec<&str> {
    if !arg.starts_with('-') {
        return vec![arg];
    }
    let mut out = Vec::new();
    if let Some((_, value)) = arg.split_once('=') {
        out.push(value);
    }
    if arg.len() > 2 && !arg.starts_with("--") {
        if let Some(value) = arg.get(2..) {
            out.push(value);
        }
    }
    out
}

/// The programs that run code named by an argument: a loader flag, an inline program or an eval is only a risk for
/// these. Any other program keeps its own `-m`, `-r` and `-c`, which it reads as its own options.
fn interpreter_command(command: &str) -> bool {
    let name = command_basename(command);
    matches!(
        name.as_str(),
        "node"
            | "nodejs"
            | "bun"
            | "deno"
            | "ruby"
            | "perl"
            | "php"
            | "uv"
            | "uvx"
            | "tsx"
            | "ts-node"
    ) || name.starts_with("python")
}

/// The loader flag an argument is, if it is one: a long flag, or a short cluster of up to three letters that holds m or r
/// (`-m`, `-Bm`, `-um`). Returns the index of that letter in a short cluster, or None.
fn loader_flag_position(arg: &str) -> Option<LoaderFlag> {
    let lower = arg.to_ascii_lowercase();
    let flag = lower.split('=').next().unwrap_or("");
    if LOADER_FLAGS.contains(&flag) {
        return Some(LoaderFlag::Long {
            attached: arg.contains('='),
        });
    }
    if arg.starts_with('-') && !arg.starts_with("--") && (2..=4).contains(&arg.len()) {
        let letters = &arg[1..];
        if letters.chars().all(|c| c.is_ascii_alphabetic()) {
            if let Some(at) = letters.find(['m', 'r', 'M', 'R']) {
                return Some(LoaderFlag::Short {
                    letter_last: at + 1 == letters.len(),
                });
            }
        }
    }
    None
}

enum LoaderFlag {
    /// A long flag; `attached` when its value follows `=`, else the next argument.
    Long { attached: bool },
    /// A short cluster; `letter_last` when the loader letter ends it, so the value is the next argument.
    Short { letter_last: bool },
}

/// The canonical path of an argument that names a file. A folder, a missing path or a link to nothing is refused.
fn canonical_file(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    if !path.is_file() {
        return Err(FILE_ARG_REFUSED.into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| FILE_ARG_REFUSED.to_string())?;
    Ok(canonical.to_string_lossy().into_owned())
}

/// One argument as the child will get it, and the absolute files it names (whole, after `=`, or a short flag's value).
fn pin_arg(arg: &str) -> Result<(String, Vec<String>), String> {
    if Path::new(arg).is_absolute() {
        let canonical = canonical_file(arg)?;
        return Ok((canonical.clone(), vec![canonical]));
    }
    if arg.starts_with('-') {
        if let Some((flag, value)) = arg.split_once('=') {
            if Path::new(value).is_absolute() {
                let canonical = canonical_file(value)?;
                return Ok((format!("{flag}={canonical}"), vec![canonical]));
            }
        }
        if arg.len() > 2 && !arg.starts_with("--") {
            if let (Some(value), Some(head)) = (arg.get(2..), arg.get(..2)) {
                if Path::new(value).is_absolute() {
                    let canonical = canonical_file(value)?;
                    return Ok((format!("{head}{canonical}"), vec![canonical]));
                }
            }
        }
    }
    Ok((arg.to_string(), Vec::new()))
}

/// The pins for an argument list, each file with its SHA-256, and the arguments as the child gets them (paths made
/// canonical). The same call at approval and at spawn: the two lists must be equal, or nothing starts.
/// Pinned files: each path with the SHA-256 it had.
type Pins = Vec<(String, String)>;

fn pin_set(args: &[String]) -> Result<(Pins, Vec<String>), String> {
    let mut pins: Vec<(String, String)> = Vec::new();
    let mut rewritten = Vec::new();
    for arg in args {
        let (text, paths) = pin_arg(arg)?;
        for path in paths {
            if !pins.iter().any(|(pinned, _)| pinned == &path) {
                let sha = file_sha256(Path::new(&path))?;
                pins.push((path, sha));
            }
        }
        rewritten.push(text);
    }
    Ok((pins, rewritten))
}

/// A line for the Allow card when the entry fetches its program at start: only the launcher is pinned.
fn remote_note(command: &str, args: &[String]) -> Option<String> {
    let name = command_basename(command);
    let first = args.first().map(String::as_str).unwrap_or("");
    let remote = match name.as_str() {
        "npx" | "bunx" | "uvx" | "pnpx" => true,
        "bun" => first == "x",
        "npm" => first == "exec" || first == "x",
        "pnpm" | "yarn" => first == "dlx",
        "pipx" => first == "run",
        // A deno run of a file on this Mac is local; a URL or an npm:/jsr: specifier is fetched at start.
        "deno" => {
            first == "run"
                && args.iter().any(|a| {
                    a.starts_with("npm:")
                        || a.starts_with("jsr:")
                        || (a.contains("://") && !a.starts_with("file://"))
                })
        }
        _ => false,
    };
    remote.then(|| {
        format!("This runs a package fetched by {name} at start; only {name} itself is pinned.")
    })
}

/// What is on disk. `approvals` maps an id to what the person allowed for it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Stored {
    pub revision: u64,
    pub agents: Vec<Value>,
    pub approvals: BTreeMap<String, Approval>,
}

/// A saved entry, checked, ready to start. `command` is the resolved executable.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Resolved {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

pub(crate) fn file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// The file as it is. A missing file is an empty list at revision 0. A file that cannot be read is an error, and a
/// write refuses to replace it, so a damaged list is never silently emptied.
pub(crate) fn read_stored(data_dir: &Path) -> Result<Stored, String> {
    let path = file_path(data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Stored {
                revision: 0,
                agents: Vec::new(),
                approvals: BTreeMap::new(),
            });
        }
        Err(_) => return Err(CORRUPT.into()),
    };
    let value: Value = serde_json::from_str(&text).map_err(|_| CORRUPT.to_string())?;
    let object = value.as_object().ok_or_else(|| CORRUPT.to_string())?;
    let revision = object
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| CORRUPT.to_string())?;
    let agents = object
        .get("agents")
        .and_then(Value::as_array)
        .ok_or_else(|| CORRUPT.to_string())?
        .clone();
    // Approvals are read as untrusted: anything that is not a complete approval record is dropped, so an approval
    // written in the old format simply asks again.
    let mut approvals: BTreeMap<String, Approval> = object
        .get("approvals")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(id, record)| {
                    let record = record.as_object()?;
                    let text = |key: &str| Some(record.get(key)?.as_str()?.to_string());
                    let pins = record
                        .get("pins")?
                        .as_array()?
                        .iter()
                        .map(|pin| {
                            Some((
                                pin.get("path")?.as_str()?.to_string(),
                                pin.get("sha256")?.as_str()?.to_string(),
                            ))
                        })
                        .collect::<Option<Vec<_>>>()?;
                    Some((
                        id.clone(),
                        Approval {
                            fingerprint: text("fingerprint")?,
                            path: text("path")?,
                            sha256: text("sha256")?,
                            pins,
                            generation: record.get("generation")?.as_str()?.to_string(),
                            mac: text("mac")?,
                        },
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    // An approval counts only if its MAC verifies under the install's key. With no key (or a missing one), none does.
    if !approvals.is_empty() {
        let key = approval_key(false).ok();
        // A missing generation item means no approval counts (fail closed).
        let current = approval_generation().ok().flatten();
        approvals.retain(|id, a| match (key.as_deref(), current.as_deref()) {
            (Some(key), Some(current)) => {
                a.generation == current && approval_mac_of(key, id, a) == a.mac
            }
            _ => false,
        });
    }
    Ok(Stored {
        revision,
        agents,
        approvals,
    })
}

fn save(data_dir: &Path, stored: &Stored) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("Could not create the data folder: {e}"))?;
    let approvals: serde_json::Map<String, Value> = stored
        .approvals
        .iter()
        .map(|(id, a)| {
            let pins: Vec<Value> = a
                .pins
                .iter()
                .map(|(path, sha256)| json!({ "path": path, "sha256": sha256 }))
                .collect();
            (
                id.clone(),
                json!({
                    "fingerprint": a.fingerprint,
                    "path": a.path,
                    "sha256": a.sha256,
                    "pins": pins,
                    "generation": a.generation,
                    "mac": a.mac,
                }),
            )
        })
        .collect();
    let document = json!({
        "revision": stored.revision,
        "agents": stored.agents,
        "approvals": approvals,
    });
    let text = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    let path = file_path(data_dir);
    let temp = data_dir.join(format!("{FILE_NAME}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, text.as_bytes()).map_err(|e| format!("Could not save the list: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Could not save the list: {e}")
    })
}

/// The id, command and arguments of an entry, checked the same way the list checks one on screen.
fn checked_fields(entry: &Value) -> Result<(String, String, Vec<String>), String> {
    let record = entry
        .as_object()
        .ok_or("This entry is not a list item Hivra can read.")?;
    let id = record
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !valid_id(id) {
        return Err(
            "The id may only use lowercase letters, digits and hyphens, up to 48 characters."
                .into(),
        );
    }
    if FIRST_CLASS_IDS.contains(&id) {
        return Err(
            "This is one of Hivra's own agent CLIs. Set it up under Agent CLIs instead.".into(),
        );
    }
    if record.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) {
        return Err("This agent does not speak the version Hivra supports.".into());
    }
    let command = record
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if command.is_empty() || command.len() > MAX_FIELD || command.contains(['\0', '\n', '\r']) {
        return Err("The command is not a single line Hivra can run.".into());
    }
    if FIRST_CLASS_COMMANDS.contains(&command_basename(command).as_str()) {
        return Err(
            "This is one of Hivra's own agent CLIs. Set it up under Agent CLIs instead.".into(),
        );
    }
    if SHELLS.contains(&command_basename(command).as_str()) {
        return Err(SHELL_REFUSED.into());
    }
    let args = match record.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or("The arguments must be a list of words.")
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("The arguments must be a list of words.".into()),
    };
    if args.len() > MAX_ARGS
        || args
            .iter()
            .any(|arg| arg.len() > MAX_FIELD || arg.contains('\0'))
    {
        return Err("There are too many arguments, or one is too long.".into());
    }
    let interpreter = interpreter_command(command);
    if interpreter
        && (args.iter().any(|arg| inline_flag(arg))
            || (command_basename(command) == "php" && args.iter().any(|arg| arg == "-r"))
            || (matches!(command_basename(command).as_str(), "deno" | "bun")
                && args.iter().any(|arg| arg == "eval")))
    {
        return Err(INLINE_REFUSED.into());
    }
    if args.iter().any(|arg| relative_file_arg(arg)) {
        return Err(RELATIVE_REFUSED.into());
    }
    for (index, arg) in args.iter().enumerate() {
        if !interpreter {
            continue;
        }
        if let Some(flag) = loader_flag_position(arg) {
            let value = match flag {
                LoaderFlag::Long { attached: true } => arg.split_once('=').map(|(_, value)| value),
                LoaderFlag::Long { attached: false } => args.get(index + 1).map(String::as_str),
                LoaderFlag::Short { letter_last: true } => args.get(index + 1).map(String::as_str),
                LoaderFlag::Short { letter_last: false } => {
                    let letters = &arg[1..];
                    let at = letters.find(['m', 'r', 'M', 'R']).unwrap_or(0);
                    arg.get(at + 2..)
                }
            };
            if !value.is_some_and(|value| Path::new(value).is_absolute()) {
                return Err(LOADER_REFUSED.into());
            }
        }
    }
    Ok((id.to_string(), command.to_string(), args))
}

/// An inline-program flag, with or without `=value`, or a short-flag cluster that holds c, e or p (`-pe`, `-Ic`).
fn inline_flag(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    let flag = lower.split('=').next().unwrap_or("");
    if INLINE_FLAGS.contains(&flag) {
        return true;
    }
    match lower.strip_prefix('-') {
        Some(cluster)
            if !cluster.is_empty()
                && !cluster.starts_with('-')
                && cluster.len() <= 4
                && cluster.chars().all(|c| c.is_ascii_alphabetic()) =>
        {
            cluster.chars().any(|c| "cep".contains(c))
        }
        _ => false,
    }
}

/// A relative path argument: the child would read it from the folder it runs in, which nothing pins. A scoped package
/// name (`@scope/pkg`) and a URL are not paths. Every value an argument can carry is checked, not only the argument.
fn relative_file_arg(arg: &str) -> bool {
    candidates(arg).into_iter().any(|value| {
        !value.is_empty()
            && !value.contains("://")
            && !value.starts_with('@')
            && !Path::new(value).is_absolute()
            && (value.contains(['/', '\\'])
                || value.starts_with('.')
                || names_a_script_or_config(value))
    })
}

/// A bare file name by its extension: `agent.mjs`, `settings.json`. A version (`pkg@1.2.3`), a model (`gpt-4.1`)
/// or an address (`127.0.0.1`) does not end in one of these.
fn names_a_script_or_config(value: &str) -> bool {
    const EXTENSIONS: [&str; 22] = [
        "mjs", "cjs", "js", "jsx", "ts", "tsx", "py", "rb", "pl", "php", "lua", "sh", "json",
        "yaml", "yml", "toml", "ini", "env", "conf", "cfg", "wasm", "txt",
    ];
    let lower = value.to_ascii_lowercase();
    lower
        .rsplit_once('.')
        .is_some_and(|(_, ext)| EXTENSIONS.contains(&ext))
}

fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 48
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn command_basename(command: &str) -> String {
    let last = command.rsplit(['/', '\\']).next().unwrap_or("");
    let lower = last.to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat"] {
        if let Some(stripped) = lower.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    lower
}

/// Replace the list on top of `expected` (the revision the window read). Approvals are kept only for entries that
/// are still there and still have the command that was approved.
pub(crate) fn write_agents(
    data_dir: &Path,
    expected: u64,
    agents: Vec<Value>,
) -> Result<Stored, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let current = read_stored(data_dir)?;
    if current.revision != expected {
        return Err(CHANGED.into());
    }
    if agents.len() > MAX_AGENTS {
        return Err("The list has too many agents.".into());
    }
    if agents
        .iter()
        .any(|agent| agent.to_string().len() > MAX_ENTRY_BYTES)
    {
        return Err("One agent in the list is too large.".into());
    }
    let mut approvals = BTreeMap::new();
    for agent in &agents {
        if let Ok((id, command, args)) = checked_fields(agent) {
            let fp = fingerprint(&command, &args);
            if let Some(approval) = current.approvals.get(&id) {
                if approval.fingerprint == fp {
                    approvals.insert(id, approval.clone());
                }
            }
        }
    }
    if approvals.len() != current.approvals.len() {
        // An allowance was dropped (an edit or a removal): move the generation on, so a copy of it cannot come back.
        let key = approval_key(true)?;
        let generation = new_generation();
        store_generation(&generation)?;
        for (id, a) in approvals.iter_mut() {
            a.generation = generation.clone();
            a.mac = approval_mac_of(&key, id, a);
        }
    }
    let next = Stored {
        revision: expected + 1,
        agents,
        approvals,
    };
    save(data_dir, &next)?;
    Ok(next)
}

/// Record or withdraw the person's approval for one entry. `shown` is the fingerprint the window displayed: an allow
/// is refused unless it is the entry as it is now, so a change made in another window is never approved unseen.
pub(crate) fn set_approval(
    data_dir: &Path,
    id: &str,
    allowed: bool,
    shown: Option<&str>,
    path_value: &str,
) -> Result<Stored, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut stored = read_stored(data_dir)?;
    let entry = stored
        .agents
        .iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(id))
        .cloned()
        .ok_or("This agent is not in your list.")?;
    let key = approval_key(true)?;
    let mut approvals = stored.approvals.clone();
    if allowed {
        let (checked_id, command, args) = checked_fields(&entry)?;
        let fp = fingerprint(&command, &args);
        let path = resolve_command(&command, path_value)?;
        // The window must have shown this command AND the file it resolves to now (a PATH change shows another file).
        if shown != Some(shown_fingerprint(&command, &args, &path).as_str()) {
            return Err(SHOWN_CHANGED.into());
        }
        let sha256 = file_sha256(Path::new(&path))?;
        let (pins, _) = pin_set(&args)?;
        approvals.insert(
            checked_id,
            Approval {
                fingerprint: fp,
                path,
                sha256,
                pins,
                generation: String::new(),
                mac: String::new(),
            },
        );
    } else {
        approvals.remove(id);
    }
    // Every change moves the generation on and re-MACs what is kept, so a withdrawn record cannot be put back.
    let generation = new_generation();
    store_generation(&generation)?;
    for (aid, a) in approvals.iter_mut() {
        a.generation = generation.clone();
        a.mac = approval_mac_of(&key, aid, a);
    }
    stored.approvals = approvals;
    save(data_dir, &stored)?;
    Ok(stored)
}

/// The entry for `id`, checked again, if its command is approved. This is what a More agents spawn runs.
pub(crate) fn approved_spawn(
    data_dir: &Path,
    id: &str,
    path_value: &str,
) -> Result<Resolved, String> {
    if !enabled(data_dir) {
        return Err(OFF_REFUSED.into());
    }
    let stored = read_stored(data_dir)?;
    let entry = stored
        .agents
        .iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(id))
        .ok_or("This agent is no longer in your list.")?;
    let (checked_id, command, args) = checked_fields(entry)?;
    let fp = fingerprint(&command, &args);
    let approval = stored
        .approvals
        .get(&checked_id)
        .filter(|approval| approval.fingerprint == fp)
        .ok_or(NOT_APPROVED)?;
    let resolved = resolve_command(&command, path_value)?;
    if !still_approved(approval, &fp, Some(&resolved)) {
        return Err(ON_DISK_CHANGED.into());
    }
    // Pins are taken again over the same arguments: a file that changed, moved behind a link, or appeared since the
    // approval refuses the start, and the child is given the canonical paths.
    let (pins_now, canonical_args) = pin_set(&args)?;
    if pins_now != approval.pins {
        return Err(ON_DISK_CHANGED.into());
    }
    // The program that runs is a private copy named by its hash, not the file the person approved: nothing that can
    // write the original after the check can change what starts (the copy is hashed before it is named).
    let resolved = private_copy(data_dir, &approval.sha256, Path::new(&resolved))?
        .to_string_lossy()
        .into_owned();
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&checked_id)
        .trim()
        .to_string();
    Ok(Resolved {
        id: checked_id,
        name,
        command: resolved,
        args: canonical_args,
    })
}

/// The start of a More agents process. The webview names the entry by its id and nothing else: a command, an argument
/// or any other start field it sends (`other_fields_sent`: a binary, an account, a custom route, a Codex store, the
/// Devin approval flag) is refused before the list is read. The command and arguments are the saved entry's, and only
/// once the person has approved that command (`approved_spawn`).
pub(crate) fn approved_start(
    data_dir: &Path,
    more_agent: &str,
    command: &str,
    args: &[String],
    other_fields_sent: bool,
    path_value: &str,
) -> Result<Resolved, String> {
    if !command.is_empty() || !args.is_empty() || other_fields_sent {
        return Err(NO_COMMAND_FROM_APP.into());
    }
    approved_spawn(data_dir, more_agent, path_value)
}

/// The folder a More agents child runs in: app-owned and new for each start, so no file in the chat folder is a
/// relative input to it.
pub(crate) fn run_folder(data_dir: &Path) -> Result<PathBuf, String> {
    let err = |e: std::io::Error| format!("Could not prepare the More agents folder: {e}");
    let base = data_dir.join("more-agents");
    let run = base.join("run");
    // The app's own folders only: a link where one of them should be is replaced (the link, never its target) or
    // refused, so the child never starts inside a folder an agent can write.
    for folder in [&base, &run] {
        match std::fs::symlink_metadata(folder) {
            Ok(meta) if meta.file_type().is_symlink() && folder == &base => {
                return Err("The More agents folder is a link, so it is not used.".into());
            }
            Ok(meta) if meta.file_type().is_symlink() => {
                std::fs::remove_file(folder).map_err(err)?;
            }
            _ => {}
        }
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&run).map_err(err)?;
    // Folders from earlier starts are not needed once they are an hour old; a fresh one may be a start in progress.
    if let Ok(entries) = std::fs::read_dir(&run) {
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > std::time::Duration::from_secs(3600));
            if old {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let dir = run.join(uuid::Uuid::new_v4().simple().to_string());
    builder.create(&dir).map_err(err)?;
    // An empty package.json stops npm's search for a project above this folder.
    std::fs::write(dir.join("package.json"), b"{}").map_err(err)?;
    Ok(dir)
}

/// An absolute path that is a file, or a bare name found on `path_value`. Anything else is not started.
fn resolve_command(command: &str, path_value: &str) -> Result<String, String> {
    let not_found = "This agent was not found. Check the command in More agents.";
    let candidate = if command.contains(['/', '\\']) {
        let path = PathBuf::from(command);
        if !path.is_absolute() {
            return Err("The command must be an absolute path or a name on the PATH.".into());
        }
        path
    } else {
        // Only absolute folders: an empty or relative PATH entry would find a file in the working folder.
        std::env::split_paths(path_value)
            .filter(|dir| dir.is_absolute())
            .flat_map(|dir| path_candidates(&dir, command))
            .find(|candidate| candidate.is_file())
            .ok_or(not_found)?
    };
    if !candidate.is_file() {
        return Err(not_found.into());
    }
    let name = candidate.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if FIRST_CLASS_COMMANDS.contains(&command_basename(name).as_str()) {
        return Err(
            "This is one of Hivra's own agent CLIs. Set it up under Agent CLIs instead.".into(),
        );
    }
    let resolved = std::fs::canonicalize(&candidate).map_err(|_| not_found.to_string())?;
    let real = resolved.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if SHELLS.contains(&command_basename(real).as_str())
        || FIRST_CLASS_COMMANDS.contains(&command_basename(real).as_str())
    {
        return Err(SHELL_REFUSED.into());
    }
    Ok(resolved.to_string_lossy().into_owned())
}

/// The file names a bare command may resolve to in one folder. Windows also tries the PATHEXT extensions.
fn path_candidates(dir: &Path, command: &str) -> Vec<PathBuf> {
    let mut out = vec![dir.join(command)];
    if cfg!(windows) {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            out.push(dir.join(format!("{command}{ext}")));
        }
    }
    out
}

/// Whether an approval still stands: the same command and arguments, resolving to the same file, with the same bytes.
fn still_approved(approval: &Approval, fp: &str, path: Option<&str>) -> bool {
    let Some(path) = path else { return false };
    approval.fingerprint == fp
        && approval.path == path
        && file_sha256(Path::new(path)).is_ok_and(|sha| sha == approval.sha256)
        && approval
            .pins
            .iter()
            .all(|(pin, sha)| file_sha256(Path::new(pin)).is_ok_and(|now| &now == sha))
}

/// Copies an approved program into the app's own folder under its hash and returns that copy's path. The bytes are
/// read once and hashed; only a copy whose hash is the approved one is written, and it is named by that hash.
fn private_copy(data_dir: &Path, sha256: &str, source: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let dir = data_dir.join("more-agents").join("bin");
    std::fs::create_dir_all(&dir).map_err(|_| NOT_APPROVED.to_string())?;
    let target = dir.join(sha256);
    if target.is_file() && file_sha256(&target).is_ok_and(|now| now == sha256) {
        return Ok(target);
    }
    let bytes = std::fs::read(source).map_err(|_| NOT_APPROVED.to_string())?;
    let hashed: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if hashed != sha256 {
        return Err(ON_DISK_CHANGED.into());
    }
    let temp = dir.join(format!("{sha256}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, &bytes).map_err(|_| NOT_APPROVED.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o500));
    }
    std::fs::rename(&temp, &target).map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        NOT_APPROVED.to_string()
    })?;
    Ok(target)
}

/// SHA-256 of a file's bytes, hex. A file that cannot be read is not approved.
fn file_sha256(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let meta = std::fs::metadata(path).map_err(|_| NOT_APPROVED.to_string())?;
    let stamp = FileStamp::of(&meta);
    if let Some((cached, sha)) = SHA_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
        .cloned()
    {
        if cached == stamp {
            return Ok(sha);
        }
    }
    #[cfg(test)]
    HASHES.with(|h| h.set(h.get() + 1));
    let bytes = std::fs::read(path).map_err(|_| NOT_APPROVED.to_string())?;
    let sha: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    SHA_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf(), (stamp, sha.clone()));
    Ok(sha)
}

/// What a cached hash is keyed on: the file's modification time, size and inode.
#[derive(Clone, PartialEq, Eq, Debug)]
struct FileStamp {
    modified: u128,
    size: u64,
    inode: u64,
}

impl FileStamp {
    fn of(meta: &std::fs::Metadata) -> Self {
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        #[cfg(unix)]
        let inode = std::os::unix::fs::MetadataExt::ino(meta);
        #[cfg(not(unix))]
        let inode = 0;
        FileStamp {
            modified,
            size: meta.len(),
            inode,
        }
    }
}

static SHA_CACHE: Mutex<BTreeMap<PathBuf, (FileStamp, String)>> = Mutex::new(BTreeMap::new());
#[cfg(test)]
thread_local! {
    /// How many times this thread read a file to hash it (tests only).
    static HASHES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The Allow card's line for an entry that reads a file in the app's own folder (`--config <app folder>/settings.json`).
/// If the agent rewrites that file on a run, the next start no longer matches the pin and needs a new approval.
pub(crate) fn data_folder_notes(
    stored: &Stored,
    data_dir: &Path,
    notes: &mut serde_json::Map<String, Value>,
) {
    // Pins are canonical paths, so the folder is compared canonical too (macOS links /var to /private/var).
    let folder = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    for (id, approval) in &stored.approvals {
        if approval
            .pins
            .iter()
            .any(|(path, _)| Path::new(path).starts_with(&folder))
        {
            notes.insert(
                id.clone(),
                json!("This entry reads a file in the app's folder. If the agent rewrites that file, the next start needs a new approval."),
            );
        }
    }
}

/// Whether a file starts with `#!`, a script whose interpreter the app does not pin.
fn starts_with_shebang(path: &str) -> bool {
    use std::io::Read;
    let mut head = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut head))
        .is_ok()
        && &head == b"#!"
}

/// What the Allow card shows the person and the window sends back: the command, its arguments, and the absolute file
/// the command resolves to. A change to any of them is a different thing to approve.
pub(crate) fn shown_fingerprint(command: &str, args: &[String], resolved: &str) -> String {
    fingerprint(&format!("{resolved}\u{0}{command}"), args)
}

/// The fingerprint of the command the person approves: its command and its arguments, length-prefixed.
pub(crate) fn fingerprint(command: &str, args: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for piece in std::iter::once(command).chain(args.iter().map(String::as_str)) {
        hasher.update(format!("{}:", piece.len()).as_bytes());
        hasher.update(piece.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Clears the child's environment, then passes only the allow-listed names and the given PATH.
pub(crate) fn restrict_env(cmd: &mut Command, path_value: &str) {
    cmd.env_clear();
    for name in ALLOWED_ENV {
        if let Some(value) = std::env::var_os(name) {
            cmd.env(name, value);
        }
    }
    cmd.env("PATH", path_value);
}

/// What the list says, for the window: the entries as stored, the ids allowed to run as they are now, and for each
/// entry the fingerprint the window must send back to allow it and the absolute file it resolves to (null if none).
pub(crate) fn view(stored: &Stored, path_value: &str) -> Value {
    let mut approved = Vec::new();
    let mut fingerprints = serde_json::Map::new();
    let mut resolved = serde_json::Map::new();
    let mut notes = serde_json::Map::new();
    for agent in &stored.agents {
        let Ok((id, command, args)) = checked_fields(agent) else {
            continue;
        };
        let fp = fingerprint(&command, &args);
        let path = resolve_command(&command, path_value).ok();
        let shown = shown_fingerprint(&command, &args, path.as_deref().unwrap_or(""));
        // The list checks what the start checks: the same pins over the same arguments, so a re-pointed link
        // does not show as allowed.
        let pins_match = pin_set(&args)
            .is_ok_and(|(pins, _)| stored.approvals.get(&id).is_some_and(|a| a.pins == pins));
        let allowed = pins_match
            && stored
                .approvals
                .get(&id)
                .is_some_and(|a| still_approved(a, &fp, path.as_deref()));
        if let Some(note) = remote_note(&command, &args) {
            notes.insert(id.clone(), json!(note));
        } else if path.as_deref().is_some_and(starts_with_shebang) {
            // LOW-F: the interpreter on a script's first line is not pinned, so the card says so.
            notes.insert(
                id.clone(),
                json!("This program is a script. The interpreter named on its first line is not pinned."),
            );
        }
        if allowed {
            approved.push(id.clone());
        }
        fingerprints.insert(id.clone(), json!(shown));
        resolved.insert(id, json!(path));
    }
    json!({
        "revision": stored.revision,
        "agents": stored.agents,
        "approved": approved,
        "fingerprints": fingerprints,
        "resolved": resolved,
        "notes": notes,
    })
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// The list for the window: its revision, its entries as saved, and which ids are approved to run.
#[tauri::command]
pub async fn more_agents_read(app: AppHandle) -> Result<Value, String> {
    off_main(move || {
        let dir = data_dir(&app)?;
        let stored = read_stored(&dir)?;
        let mut shown = view(&stored, &crate::harness::gui_search_path());
        if let Some(notes) = shown["notes"].as_object_mut() {
            data_folder_notes(&stored, &dir, notes);
        }
        Ok(shown)
    })
    .await
}

/// The person's switch for More agents, written by the app when Settings changes it.
#[tauri::command]
pub async fn more_agents_set_enabled(app: AppHandle, on: bool) -> Result<(), String> {
    off_main(move || set_enabled(&data_dir(&app)?, on)).await
}

/// Runs the work on a blocking thread: the hashing of a program must not hold up the window.
async fn off_main<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Replace the list if the window read the current revision. Approvals are not changed here.
#[tauri::command]
pub async fn more_agents_write(
    app: AppHandle,
    expected_revision: u64,
    agents: Vec<Value>,
) -> Result<Value, String> {
    off_main(move || {
        let stored = write_agents(&data_dir(&app)?, expected_revision, agents)?;
        announce(&app);
        Ok(view(&stored, &crate::harness::gui_search_path()))
    })
    .await
}

/// Tells every window the list changed, so each one re-reads it and stops runs whose entry was withdrawn.
fn announce(app: &AppHandle) {
    let _ = tauri::Emitter::emit(app, "more-agents-changed", ());
}

/// Whether an entry may run right now: approved as it is, and its file unchanged. A running agent is checked this
/// way before each turn, so a withdrawn or edited entry stops answering.
#[tauri::command]
pub async fn more_agents_check(app: AppHandle, id: String) -> Result<(), String> {
    off_main(move || {
        approved_spawn(&data_dir(&app)?, &id, &crate::harness::gui_search_path()).map(|_| ())
    })
    .await
}

/// The person's own tap: allow or withdraw one entry. `shown` is the fingerprint the window displayed for it.
#[tauri::command]
pub async fn more_agents_approve(
    app: AppHandle,
    id: String,
    allowed: bool,
    shown: Option<String>,
) -> Result<Value, String> {
    off_main(move || {
        let stored = set_approval(
            &data_dir(&app)?,
            &id,
            allowed,
            shown.as_deref(),
            &crate::harness::gui_search_path(),
        )?;
        announce(&app);
        Ok(view(&stored, &crate::harness::gui_search_path()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, command: &str, args: &[&str]) -> Value {
        json!({
            "id": id,
            "name": format!("{id} agent"),
            "command": command,
            "args": args,
            "protocol": "acp-v1",
        })
    }

    /// A folder under the system temp dir, removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            if self.0.starts_with(std::env::temp_dir()) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn dir() -> Scratch {
        // A fake key for this test thread: no test reads or writes the real Keychain.
        TEST_KEY.with(|key| *key.borrow_mut() = Some(vec![7u8; 32]));
        TEST_GEN.with(|g| *g.borrow_mut() = Some("gen-test".to_string()));
        let path = std::env::temp_dir().join(format!("wp134-more-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("scratch dir");
        set_enabled(&path, true).expect("switch on for the test");
        Scratch(path)
    }

    #[test]
    fn a_missing_file_is_an_empty_list_at_revision_zero() {
        let d = dir();
        let stored = read_stored(d.path()).expect("read");
        assert_eq!(stored.revision, 0);
        assert!(stored.agents.is_empty());
    }

    #[test]
    fn a_write_goes_on_top_of_the_revision_it_read_and_bumps_it() {
        let d = dir();
        let first = write_agents(
            d.path(),
            0,
            vec![entry("copilot", "/opt/copilot", &["--acp"])],
        )
        .expect("first write");
        assert_eq!(first.revision, 1);
        let second = write_agents(
            d.path(),
            1,
            vec![
                entry("copilot", "/opt/copilot", &["--acp"]),
                entry("zed", "/opt/zed", &[]),
            ],
        )
        .expect("second write");
        assert_eq!(second.revision, 2);
        assert_eq!(second.agents.len(), 2);
    }

    #[test]
    fn a_stale_revision_is_refused_so_one_window_cannot_wipe_another() {
        let d = dir();
        write_agents(d.path(), 0, vec![entry("copilot", "/opt/copilot", &[])]).expect("first");
        let err = write_agents(d.path(), 0, vec![]).expect_err("stale write must fail");
        assert!(
            err.contains("revision"),
            "the window is told to reload: {err}"
        );
        assert_eq!(read_stored(d.path()).expect("read").agents.len(), 1);
    }

    #[test]
    fn a_bad_entry_is_kept_as_written_so_it_does_not_wipe_the_list() {
        let d = dir();
        let broken = json!({ "id": "broken" });
        let stored = write_agents(
            d.path(),
            0,
            vec![entry("copilot", "/opt/copilot", &[]), broken.clone()],
        )
        .expect("write");
        assert_eq!(stored.agents[1], broken);
    }

    #[test]
    fn a_damaged_file_is_not_overwritten() {
        let d = dir();
        let path = file_path(d.path());
        std::fs::write(&path, b"{ not json").expect("seed");
        assert_eq!(read_stored(d.path()).expect_err("read must fail"), CORRUPT);
        assert!(write_agents(d.path(), 0, vec![]).is_err());
        assert_eq!(std::fs::read(&path).expect("still there"), b"{ not json");
    }

    /// Allow `id` the way the window does: the fingerprint it displayed is sent back with the allow.
    #[cfg(unix)]
    fn approve(dir: &Path, id: &str, path_value: &str) -> Result<Stored, String> {
        let stored = read_stored(dir)?;
        let shown = view(&stored, path_value)["fingerprints"][id]
            .as_str()
            .map(str::to_string);
        set_approval(dir, id, true, shown.as_deref(), path_value)
    }

    #[cfg(unix)]
    fn make_tool(dir: &Path, name: &str, body: &[u8]) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).expect("tool dir");
        let tool = dir.join(name);
        std::fs::write(&tool, body).expect("tool");
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        tool
    }

    #[test]
    fn an_entry_cannot_use_a_first_class_id_command_or_shell() {
        let d = dir();
        write_agents(d.path(), 0, vec![entry("devin", "/opt/devin-helper", &[])]).expect("seed");
        assert!(checked_fields(&entry("devin", "/opt/devin-helper", &[])).is_err());
        assert!(checked_fields(&entry("zed", "/usr/local/bin/claude", &[])).is_err());
        assert_eq!(
            checked_fields(&entry("zed", "/bin/sh", &["-x"])).expect_err("shell"),
            SHELL_REFUSED
        );
        assert_eq!(
            checked_fields(&entry("zed", "/opt/node", &["-e", "x"])).expect_err("inline"),
            INLINE_REFUSED
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_allow_is_refused_unless_it_names_the_entry_as_shown() {
        let d = dir();
        let tool = make_tool(&d.path().join("bin"), "wp134-a", b"#!/bin/sh\n");
        let path_value = tool.parent().unwrap().to_string_lossy().into_owned();
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", &tool.to_string_lossy(), &["--acp"])],
        )
        .expect("seed");
        // A window that showed other arguments, or nothing, cannot allow this entry.
        let other = fingerprint(&tool.to_string_lossy(), &["--other".to_string()]);
        assert_eq!(
            set_approval(d.path(), "wp134", true, Some(&other), &path_value).expect_err("stale"),
            SHOWN_CHANGED
        );
        assert!(set_approval(d.path(), "wp134", true, None, &path_value).is_err());
        assert!(read_stored(d.path()).expect("read").approvals.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_program_is_not_run_on_the_old_approval() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-b", b"#!/bin/sh\necho one\n");
        let path_value = bin.to_string_lossy().into_owned();
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-b", &["--acp"])]).expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        assert!(approved_spawn(d.path(), "wp134", &path_value).is_ok());
        make_tool(&bin, "wp134-b", b"#!/bin/sh\necho two\n");
        assert_eq!(
            approved_spawn(d.path(), "wp134", &path_value).expect_err("changed"),
            ON_DISK_CHANGED
        );
        let shown = view(&read_stored(d.path()).expect("read"), &path_value);
        assert_eq!(shown["approved"], json!([]));
    }

    #[cfg(unix)]
    #[test]
    fn a_relative_or_empty_path_folder_is_never_searched() {
        // Cargo runs tests in the package folder, which holds Cargo.toml: a relative or empty PATH folder must not find it.
        assert!(std::path::Path::new("Cargo.toml").is_file());
        assert!(resolve_command("Cargo.toml", ".").is_err());
        assert!(resolve_command("Cargo.toml", "").is_err());
        assert!(resolve_command("Cargo.toml", "relative-dir:.").is_err());
    }

    #[test]
    fn nothing_runs_until_the_person_approves_that_command() {
        let d = dir();
        write_agents(
            d.path(),
            0,
            vec![entry("copilot", "/opt/copilot", &["--acp"])],
        )
        .expect("seed");
        assert_eq!(
            approved_spawn(d.path(), "copilot", "/usr/bin").expect_err("not approved"),
            NOT_APPROVED
        );
    }

    #[test]
    fn editing_the_command_withdraws_the_approval() {
        let d = dir();
        write_agents(
            d.path(),
            0,
            vec![entry("copilot", "/opt/copilot", &["--acp"])],
        )
        .expect("seed");
        set_approval(d.path(), "copilot", false, None, "/usr/bin").expect("withdraw");
        write_agents(
            d.path(),
            1,
            vec![entry("copilot", "/opt/other", &["--acp"])],
        )
        .expect("edit");
        assert!(read_stored(d.path()).expect("read").approvals.is_empty());
    }

    #[test]
    fn removing_and_adding_the_same_entry_needs_a_new_approval() {
        let d = dir();
        write_agents(d.path(), 0, vec![entry("copilot", "/opt/copilot", &[])]).expect("seed");
        write_agents(d.path(), 1, vec![]).expect("remove");
        write_agents(d.path(), 2, vec![entry("copilot", "/opt/copilot", &[])]).expect("re-add");
        assert!(read_stored(d.path()).expect("read").approvals.is_empty());
    }

    #[test]
    fn a_list_write_cannot_add_an_approval() {
        let d = dir();
        write_agents(d.path(), 0, vec![entry("copilot", "/opt/copilot", &[])]).expect("seed");
        // The approvals field is not part of the list: a window cannot mark an entry approved by writing it.
        let forged = json!({ "id": "copilot", "name": "x", "command": "/opt/copilot", "args": [], "protocol": "acp-v1", "approved": true });
        write_agents(d.path(), 1, vec![forged]).expect("write");
        assert!(read_stored(d.path()).expect("read").approvals.is_empty());
    }

    #[test]
    fn a_relative_command_is_refused() {
        let d = dir();
        write_agents(d.path(), 0, vec![entry("copilot", "copilot-helper", &[])]).expect("seed");
        let err = approved_spawn(d.path(), "copilot", "/usr/bin:/bin").expect_err("not approved");
        assert!(!err.is_empty());
    }

    #[test]
    fn the_fingerprint_separates_arguments_that_would_join_to_the_same_text() {
        let a = fingerprint("/opt/a", &["b c".to_string()]);
        let b = fingerprint("/opt/a", &["b".to_string(), "c".to_string()]);
        assert_ne!(a, b);
        assert_eq!(a, fingerprint("/opt/a", &["b c".to_string()]));
    }

    #[cfg(unix)]
    #[test]
    fn the_view_lists_only_approved_ids_with_their_resolved_file_and_fingerprint() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-d", b"#!/bin/sh\n");
        let path_value = bin.to_string_lossy().into_owned();
        write_agents(d.path(), 0, vec![entry("copilot", "wp134-d", &[])]).expect("seed");
        approve(d.path(), "copilot", &path_value).expect("approve");
        let shown = view(&read_stored(d.path()).expect("read"), &path_value);
        assert_eq!(shown["revision"], json!(1));
        assert_eq!(shown["approved"], json!(["copilot"]));
        assert!(shown["resolved"]["copilot"]
            .as_str()
            .unwrap()
            .ends_with("wp134-d"));
        assert!(shown["fingerprints"]["copilot"].as_str().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn an_approved_entry_runs_the_file_it_names_found_by_path_or_by_absolute_path() {
        let d = dir();
        let tool = make_tool(&d.path().join("bin"), "wp134-tool", b"#!/bin/sh\n");
        let path_value = tool.parent().unwrap().to_string_lossy().into_owned();
        let canonical = std::fs::canonicalize(&tool).expect("canonical");
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-tool", &["--acp"])]).expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        let run = approved_spawn(d.path(), "wp134", &path_value).expect("approved and present");
        assert_eq!(
            file_sha256(Path::new(&run.command)).expect("copy"),
            file_sha256(&canonical).expect("original")
        );
        assert_eq!(run.args, vec!["--acp".to_string()]);
        write_agents(
            d.path(),
            1,
            vec![entry("wp134", &tool.to_string_lossy(), &["--acp"])],
        )
        .expect("absolute");
        approve(d.path(), "wp134", "/usr/bin").expect("approve absolute");
        let again = approved_spawn(d.path(), "wp134", "/usr/bin").expect("absolute path runs");
        assert_eq!(
            file_sha256(Path::new(&again.command)).expect("copy"),
            file_sha256(&canonical).expect("original")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_more_agents_child_gets_no_app_secret() {
        std::env::set_var("MONOCODE_WP134_SECRET", "must-not-leak");
        let mut cmd = Command::new("/usr/bin/env");
        cmd.env("MONOCODE_WP134_SECRET", "also-not");
        restrict_env(&mut cmd, "/usr/bin:/bin");
        let out = cmd.output().expect("env runs");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(!text.contains("MONOCODE_WP134_SECRET"), "{text}");
        assert!(
            text.lines().any(|line| line == "PATH=/usr/bin:/bin"),
            "{text}"
        );
    }

    /// WP-134b: the webview names an entry by its id and sends nothing else. A request that carries a command, an
    /// argument or any other start field is refused before a file is looked at.
    #[test]
    fn a_webview_command_never_starts_a_more_agent() {
        let d = dir();
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", "/opt/approved-agent", &["acp"])],
        )
        .expect("seed");
        for (command, args, other_fields) in [
            ("/bin/sh", vec![], false),
            ("/opt/approved-agent", vec![], false),
            ("", vec!["-c".to_string(), "id".to_string()], false),
            ("", vec![], true),
        ] {
            let refused =
                approved_start(d.path(), "wp134", command, &args, other_fields, "/usr/bin")
                    .expect_err("a webview-supplied start field is refused");
            assert_eq!(refused, NO_COMMAND_FROM_APP);
        }
    }

    /// WP-134b: an id that is not in the saved list, or is not approved, starts nothing.
    #[test]
    fn a_more_agent_id_outside_the_saved_approved_list_starts_nothing() {
        let d = dir();
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", "/opt/approved-agent", &["acp"])],
        )
        .expect("seed");
        assert_eq!(
            approved_start(d.path(), "wp134", "", &[], false, "/usr/bin").expect_err("unapproved"),
            NOT_APPROVED
        );
        assert_eq!(
            approved_start(d.path(), "nobody", "", &[], false, "/usr/bin").expect_err("not listed"),
            "This agent is no longer in your list."
        );
    }

    /// WP-134b: an approved entry starts the command it names, found by the same rule as the eleven CLIs' path.
    #[cfg(unix)]
    #[test]
    fn an_approved_entry_starts_through_approved_start_with_its_saved_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir();
        let bin = d.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin dir");
        let tool = bin.join("wp134b-tool");
        std::fs::write(&tool, b"#!/bin/sh\n").expect("tool");
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let path_value = bin.to_string_lossy().into_owned();
        write_agents(
            d.path(),
            0,
            vec![entry("wp134b", "wp134b-tool", &["acp", "--flag"])],
        )
        .expect("seed");
        approve(d.path(), "wp134b", &path_value).expect("approve");
        let run = approved_start(d.path(), "wp134b", "", &[], false, &path_value)
            .expect("approved and present");
        assert_eq!(run.id, "wp134b");
        let canonical = std::fs::canonicalize(&tool).expect("canonical");
        assert_ne!(
            run.command,
            canonical.to_string_lossy(),
            "the approved file is not what runs"
        );
        assert!(run.command.starts_with(d.path().to_string_lossy().as_ref()));
        assert_eq!(
            file_sha256(Path::new(&run.command)).expect("copy"),
            file_sha256(&canonical).expect("original")
        );
        assert_eq!(run.args, vec!["acp".to_string(), "--flag".to_string()]);
    }

    #[cfg(unix)]
    fn write_doc(dir: &Path, doc: &Value) {
        std::fs::write(
            file_path(dir),
            serde_json::to_vec_pretty(doc).expect("json"),
        )
        .expect("write");
    }

    #[cfg(unix)]
    #[test]
    fn a_hand_edited_approval_is_refused() {
        let d = dir();
        let tool = make_tool(&d.path().join("bin"), "wp134-k", b"#!/bin/sh\n");
        let path_value = tool.parent().unwrap().to_string_lossy().into_owned();
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-k", &[])]).expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        // Point the record at another file, keeping the old MAC: it no longer verifies.
        let mut doc: Value =
            serde_json::from_str(&std::fs::read_to_string(file_path(d.path())).unwrap()).unwrap();
        doc["approvals"]["wp134"]["path"] = json!("/tmp/evil-agent");
        write_doc(d.path(), &doc);
        assert!(read_stored(d.path()).expect("read").approvals.is_empty());
        assert_eq!(
            approved_spawn(d.path(), "wp134", &path_value).expect_err("refused"),
            NOT_APPROVED
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_approval_written_without_a_mac_is_dropped() {
        let d = dir();
        let tool = make_tool(&d.path().join("bin"), "wp134-m", b"#!/bin/sh\n");
        let path_value = tool.parent().unwrap().to_string_lossy().into_owned();
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-m", &[])]).expect("seed");
        let sha = file_sha256(&tool).expect("sha");
        let fp = fingerprint(&tool.to_string_lossy(), &[]);
        write_doc(
            d.path(),
            &json!({
                "revision": 1,
                "agents": [entry("wp134", "wp134-m", &[])],
                "approvals": { "wp134": { "fingerprint": fp, "path": tool.to_string_lossy(), "sha256": sha } },
            }),
        );
        assert!(read_stored(d.path()).expect("read").approvals.is_empty());
        assert!(approved_spawn(d.path(), "wp134", &path_value).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn without_the_install_key_no_approval_counts() {
        let d = dir();
        let tool = make_tool(&d.path().join("bin"), "wp134-n", b"#!/bin/sh\n");
        let path_value = tool.parent().unwrap().to_string_lossy().into_owned();
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-n", &[])]).expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        TEST_KEY.with(|key| *key.borrow_mut() = None);
        assert!(read_stored(d.path()).expect("read").approvals.is_empty());
        assert!(approved_spawn(d.path(), "wp134", &path_value).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn an_approval_cannot_be_moved_to_another_entry() {
        let d = dir();
        let tool = make_tool(&d.path().join("bin"), "wp134-o", b"#!/bin/sh\n");
        let path_value = tool.parent().unwrap().to_string_lossy().into_owned();
        write_agents(
            d.path(),
            0,
            vec![
                entry("wp134", "wp134-o", &[]),
                entry("other", "wp134-o", &[]),
            ],
        )
        .expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        let mut doc: Value =
            serde_json::from_str(&std::fs::read_to_string(file_path(d.path())).unwrap()).unwrap();
        let record = doc["approvals"]["wp134"].clone();
        doc["approvals"]["other"] = record;
        write_doc(d.path(), &doc);
        assert!(!read_stored(d.path())
            .expect("read")
            .approvals
            .contains_key("other"));
        assert!(approved_spawn(d.path(), "other", &path_value).is_err());
    }

    #[test]
    fn the_mac_depends_on_the_key_and_every_part() {
        let a = Approval {
            fingerprint: "fp".into(),
            path: "/opt/a".into(),
            sha256: "sha".into(),
            pins: vec![("/opt/s.mjs".into(), "pin".into())],
            generation: "gen-1".to_string(),
            mac: String::new(),
        };
        let base = approval_mac_of(b"key-one", "id", &a);
        assert_eq!(base, approval_mac_of(b"key-one", "id", &a));
        assert_ne!(base, approval_mac_of(b"key-two", "id", &a));
        assert_ne!(base, approval_mac_of(b"key-one", "other", &a));
        assert_ne!(
            base,
            approval_mac_of(
                b"key-one",
                "id",
                &Approval {
                    path: "/opt/b".into(),
                    ..a.clone()
                }
            )
        );
        assert_ne!(
            base,
            approval_mac_of(
                b"key-one",
                "id",
                &Approval {
                    generation: "gen-2".to_string(),
                    ..a.clone()
                }
            )
        );
        assert_ne!(
            base,
            approval_mac_of(
                b"key-one",
                "id",
                &Approval {
                    pins: vec![],
                    ..a.clone()
                }
            )
        );
    }

    // Review r3 repro (MEDIUM, M3 residual): a withdrawn approval comes back when its saved record is written back.
    // The MAC binds id, fingerprint, path and SHA-256, but nothing that a withdraw changes, so a copy taken earlier
    // verifies again. Red on 11be1d122.
    #[cfg(unix)]
    #[test]
    fn review_r3_a_withdrawn_approval_cannot_be_replayed() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-r", b"#!/bin/sh\n");
        let path_value = bin.to_string_lossy().into_owned();
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-r", &["--acp"])]).expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        let file = file_path(d.path());
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(&file).expect("read")).expect("json");
        let record = saved["approvals"]["wp134"].clone();
        set_approval(d.path(), "wp134", false, None, &path_value).expect("withdraw");
        assert!(approved_spawn(d.path(), "wp134", &path_value).is_err());
        // Anything with write access to the data folder puts the old record back.
        let mut now: Value =
            serde_json::from_str(&std::fs::read_to_string(&file).expect("read")).expect("json");
        now["approvals"]["wp134"] = record;
        std::fs::write(&file, serde_json::to_string(&now).expect("text")).expect("write");
        assert!(
            approved_spawn(d.path(), "wp134", &path_value).is_err(),
            "a withdrawn approval was replayed from a saved record"
        );
    }

    // Review r3 repro (MEDIUM, M2 residual): an interpreter entry pins the interpreter, not the script it runs.
    // Red on 11be1d122.
    #[cfg(unix)]
    #[test]
    fn review_r3_an_interpreter_entry_pins_the_script_it_runs() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-node", b"#!/bin/sh\n");
        let script = d.path().join("agent.mjs");
        std::fs::write(&script, b"console.log('approved')").expect("script");
        let path_value = bin.to_string_lossy().into_owned();
        let script_arg = script.to_string_lossy().into_owned();
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", "wp134-node", &[script_arg.as_str()])],
        )
        .expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        std::fs::write(&script, b"require('child_process').exec('anything')").expect("swap");
        assert!(
            approved_spawn(d.path(), "wp134", &path_value).is_err(),
            "the script changed after approval and still starts"
        );
    }

    // Review r3 repro (LOW, M1 residual): the shell check reads the name as typed, not the file it resolves to.
    // Red on 11be1d122.
    #[cfg(unix)]
    #[test]
    fn review_r3_a_shell_behind_a_symlink_is_refused() {
        let d = dir();
        let bin = d.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        std::os::unix::fs::symlink("/bin/sh", bin.join("wp134-agent")).expect("link");
        let path_value = bin.to_string_lossy().into_owned();
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-agent", &["-s"])]).expect("seed");
        assert!(
            approve(d.path(), "wp134", &path_value).is_err(),
            "a shell was approved through a symlink"
        );
    }

    // Review r4 repro (MEDIUM): a bare file name is as relative as `./agent.mjs`. The child reads it from the chat
    // folder, which nothing pins, yet only an argument with a slash is refused. `--env-file=.env` is the same.
    #[test]
    fn review_r4_a_bare_relative_file_argument_is_refused() {
        for args in [
            &["agent.mjs"][..],
            &["--env-file=.env", "/opt/agent.mjs"][..],
        ] {
            assert_eq!(
                checked_fields(&entry("wp134", "/opt/node", args))
                    .err()
                    .as_deref(),
                Some(RELATIVE_REFUSED),
                "{args:?} reads a file from the chat folder and is not refused"
            );
        }
    }

    // Review r4 repro (MEDIUM): the pin is taken on the symlink's target, but the child is given the link. Pointing the
    // link at another file runs that file while the pin still matches.
    #[cfg(unix)]
    #[test]
    fn review_r4_a_pinned_argument_behind_a_symlink_cannot_be_redirected() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-node", b"#!/bin/sh\n");
        let real = d.path().join("agent.mjs");
        let evil = d.path().join("evil.mjs");
        let link = d.path().join("current.mjs");
        std::fs::write(&real, b"console.log('approved')").expect("script");
        std::fs::write(&evil, b"require('child_process').exec('anything')").expect("evil");
        std::os::unix::fs::symlink(&real, &link).expect("link");
        let path_value = bin.to_string_lossy().into_owned();
        let link_arg = link.to_string_lossy().into_owned();
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", "wp134-node", &[link_arg.as_str()])],
        )
        .expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        std::fs::remove_file(&link).expect("unlink");
        std::os::unix::fs::symlink(&evil, &link).expect("relink");
        assert!(
            approved_spawn(d.path(), "wp134", &path_value).is_err(),
            "the argument now runs another file and still starts"
        );
    }

    // Review r4 repro (MEDIUM): an absolute argument that was not a file at approval is never pinned, so a file put
    // there afterwards runs unpinned.
    #[cfg(unix)]
    #[test]
    fn review_r4_an_absolute_file_that_appears_after_approval_does_not_run() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-node", b"#!/bin/sh\n");
        let script = d.path().join("agent.mjs");
        let path_value = bin.to_string_lossy().into_owned();
        let script_arg = script.to_string_lossy().into_owned();
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", "wp134-node", &[script_arg.as_str()])],
        )
        .expect("seed");
        // Approval refuses a missing file; had it been allowed, the planted file must still not run.
        let _ = approve(d.path(), "wp134", &path_value);
        std::fs::write(&script, b"require('child_process').exec('anything')").expect("plant");
        assert!(
            approved_spawn(d.path(), "wp134", &path_value).is_err(),
            "a file that appeared after approval runs unpinned"
        );
    }

    // Review r4 repro (MEDIUM): an absolute file given as a flag value (`--import=/abs/hook.mjs`) is not pinned.
    #[cfg(unix)]
    #[test]
    fn review_r4_an_absolute_file_given_as_a_flag_value_is_pinned() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-node", b"#!/bin/sh\n");
        let hook = d.path().join("hook.mjs");
        std::fs::write(&hook, b"// approved hook").expect("hook");
        let path_value = bin.to_string_lossy().into_owned();
        let flag = format!("--import={}", hook.to_string_lossy());
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", "wp134-node", &[flag.as_str()])],
        )
        .expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        std::fs::write(&hook, b"require('child_process').exec('anything')").expect("swap");
        assert!(
            approved_spawn(d.path(), "wp134", &path_value).is_err(),
            "the hook changed after approval and still starts"
        );
    }

    // Review r4 repro (MEDIUM): the generation is a counter that a missing Keychain item reads as 0. Once the item is
    // gone (deleted, or a `monocode-hub:` connector sign-out names it), the counter climbs through the old values
    // again and a record withdrawn at one of them verifies again.
    #[cfg(unix)]
    #[test]
    fn review_r4_a_reset_generation_does_not_revive_a_withdrawn_record() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-a", b"#!/bin/sh\n");
        make_tool(&bin, "wp134-b", b"#!/bin/sh\n");
        let path_value = bin.to_string_lossy().into_owned();
        write_agents(
            d.path(),
            0,
            vec![
                entry("wp134a", "wp134-a", &[]),
                entry("wp134b", "wp134-b", &[]),
            ],
        )
        .expect("seed");
        approve(d.path(), "wp134a", &path_value).expect("approve a");
        let file = file_path(d.path());
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(&file).expect("read")).expect("json");
        let record = saved["approvals"]["wp134a"].clone();
        set_approval(d.path(), "wp134a", false, None, &path_value).expect("withdraw");
        // The Keychain item goes away: the next read is 0, and the next change issues generation 1 again.
        TEST_GEN.with(|g| *g.borrow_mut() = None);
        approve(d.path(), "wp134b", &path_value).expect("approve b");
        let mut now: Value =
            serde_json::from_str(&std::fs::read_to_string(&file).expect("read")).expect("json");
        now["approvals"]["wp134a"] = record;
        std::fs::write(&file, serde_json::to_string(&now).expect("text")).expect("write");
        assert!(
            approved_spawn(d.path(), "wp134a", &path_value).is_err(),
            "a withdrawn approval came back once the generation counter restarted"
        );
    }

    // Review round 6 tests. Each one fails on the code before its fix.

    #[cfg(unix)]
    #[test]
    fn an_approved_program_runs_from_the_app_folder_not_the_original() {
        let d = dir();
        let tool = make_tool(&d.path().join("bin"), "wp134-copy", b"#!/bin/sh\n");
        let path_value = tool.parent().unwrap().to_string_lossy().into_owned();
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-copy", &[])]).expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        let run = approved_spawn(d.path(), "wp134", &path_value).expect("run");
        let original = std::fs::canonicalize(&tool).expect("canonical");
        assert_ne!(Path::new(&run.command), original.as_path());
        assert!(Path::new(&run.command).starts_with(d.path()));
    }

    #[cfg(unix)]
    #[test]
    fn the_allow_card_fingerprint_changes_when_the_same_name_resolves_to_another_file() {
        let d = dir();
        let first = d.path().join("first");
        let second = d.path().join("second");
        make_tool(&first, "wp134-p", b"#!/bin/sh\necho one\n");
        make_tool(&second, "wp134-p", b"#!/bin/sh\necho two\n");
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-p", &[])]).expect("seed");
        let fp_first = view(
            &read_stored(d.path()).expect("read"),
            &first.to_string_lossy(),
        )["fingerprints"]["wp134"]
            .as_str()
            .unwrap()
            .to_string();
        let fp_second = view(
            &read_stored(d.path()).expect("read"),
            &second.to_string_lossy(),
        )["fingerprints"]["wp134"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(fp_first, fp_second);
        // The window showed the first file; the approval now resolves to the second, and is refused.
        assert_eq!(
            set_approval(
                d.path(),
                "wp134",
                true,
                Some(&fp_first),
                &second.to_string_lossy()
            )
            .expect_err("refused"),
            SHOWN_CHANGED
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unchanged_program_is_hashed_once_and_a_changed_one_again() {
        let d = dir();
        let file = d.path().join("hashed-once");
        std::fs::write(&file, b"first version").expect("write");
        let before = HASHES.with(|h| h.get());
        let first = file_sha256(&file).expect("hash");
        assert_eq!(file_sha256(&file).expect("hash again"), first);
        assert_eq!(
            HASHES.with(|h| h.get()) - before,
            1,
            "the unchanged file was read again"
        );
        std::fs::write(&file, b"a longer second version").expect("rewrite");
        assert_ne!(file_sha256(&file).expect("hash changed"), first);
        assert_eq!(HASHES.with(|h| h.get()) - before, 2);
    }

    #[test]
    fn a_remote_launcher_is_named_on_the_card_in_every_form() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<String>>();
        for (command, list) in [
            ("bunx", vec!["pkg"]),
            ("bun", vec!["x", "pkg"]),
            ("npm", vec!["exec", "pkg"]),
            ("npm", vec!["x", "pkg"]),
            ("pnpm", vec!["dlx", "pkg"]),
            ("yarn", vec!["dlx", "pkg"]),
            ("pipx", vec!["run", "pkg"]),
            ("deno", vec!["run", "npm:pkg"]),
            ("deno", vec!["run", "https://example.com/agent.ts"]),
        ] {
            assert!(
                remote_note(command, &args(&list)).is_some(),
                "{command} {list:?} is not named"
            );
        }
        assert!(remote_note("deno", &args(&["run", "file:///opt/agent.ts"])).is_none());
        assert!(remote_note("npm", &args(&["install", "pkg"])).is_none());
    }

    #[test]
    fn an_inline_program_is_refused_in_every_interpreter_form() {
        for (command, list) in [
            ("/usr/bin/python3", vec!["-uc", "print(1)"]),
            ("/usr/bin/perl", vec!["-we", "system('x')"]),
            ("/opt/node", vec!["-pe", "1"]),
            ("/usr/bin/php", vec!["-r", "echo 1;"]),
        ] {
            let args: Vec<&str> = list;
            let e = entry("wp134", command, &args);
            assert_eq!(
                checked_fields(&e).expect_err("refused"),
                INLINE_REFUSED,
                "{command} {args:?}"
            );
        }
    }

    #[test]
    fn a_relative_file_argument_is_refused_and_a_package_name_is_not() {
        assert!(checked_fields(&entry("wp134", "/opt/node", &["agent.mjs"])).is_err());
        assert!(checked_fields(&entry("wp134", "/opt/node", &["--env-file=.env"])).is_err());
        assert!(checked_fields(&entry("wp134", "/opt/node", &["./agent.mjs"])).is_err());
        assert!(checked_fields(&entry("wp134", "/opt/npx", &["-y", "@scope/pkg"])).is_ok());
        assert!(checked_fields(&entry("wp134", "/opt/npx", &["https://example.com/a.ts"])).is_ok());
    }

    #[test]
    fn a_missing_generation_item_approves_nothing() {
        let d = dir();
        write_agents(d.path(), 0, vec![entry("wp134", "/opt/agent", &[])]).expect("seed");
        set_approval(d.path(), "wp134", false, None, "/usr/bin").expect("first change");
        // An approval recorded, then the generation item is gone (a deleted Keychain item reads as absent).
        TEST_GEN.with(|g| *g.borrow_mut() = None);
        assert!(read_stored(d.path()).expect("read").approvals.is_empty());
    }

    // Review r5 check (should pass): a space-separated loader value and an attached short value are both pinned, and
    // the child is given the canonical path, not the link.
    #[cfg(unix)]
    #[test]
    fn review_r5_space_separated_and_attached_values_are_pinned_and_canonical() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-node", b"#!/bin/sh\n");
        let hook = d.path().join("hook.mjs");
        let req = d.path().join("req.cjs");
        let link = d.path().join("hook-link.mjs");
        std::fs::write(&hook, b"// hook").expect("hook");
        std::fs::write(&req, b"// req").expect("req");
        std::os::unix::fs::symlink(&hook, &link).expect("link");
        let path_value = bin.to_string_lossy().into_owned();
        let link_arg = link.to_string_lossy().into_owned();
        let attached = format!("-r{}", req.to_string_lossy());
        write_agents(
            d.path(),
            0,
            vec![entry(
                "wp134",
                "wp134-node",
                &["--import", link_arg.as_str(), attached.as_str()],
            )],
        )
        .expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        let run = approved_spawn(d.path(), "wp134", &path_value).expect("starts as approved");
        let canonical_hook = std::fs::canonicalize(&hook).expect("canon");
        assert_eq!(run.args[1], canonical_hook.to_string_lossy());
        std::fs::write(&req, b"require('child_process').exec('anything')").expect("swap");
        assert!(approved_spawn(d.path(), "wp134", &path_value).is_err());
    }

    // Review r5 repro (LOW): `-m` inside a short-flag cluster (`python3 -Bm mod`, `-um mod`) loads a module by name and
    // is not seen as a loader flag, because only the second character is checked.
    #[test]
    fn review_r5_a_loader_flag_inside_a_cluster_is_refused() {
        for cluster in ["-Bm", "-um", "-Im"] {
            assert_eq!(
                checked_fields(&entry("wp134", "/opt/python3", &[cluster, "agentmod"]))
                    .err()
                    .as_deref(),
                Some(LOADER_REFUSED),
                "{cluster} agentmod loads a module by name"
            );
        }
    }

    // Review r5 repro (MEDIUM, functional): a dot alone now makes an argument a relative file, so a version-pinned
    // package, a dotted model name and an address are refused.
    #[test]
    fn review_r5_a_dotted_word_that_is_not_a_path_is_accepted() {
        for args in [
            &["some-acp-agent@1.2.3", "--acp"][..],
            &["--model=gpt-4.1"][..],
            &["--host", "127.0.0.1"][..],
        ] {
            assert!(
                checked_fields(&entry("wp134", "/opt/npx", args)).is_ok(),
                "{args:?} is refused as a relative file"
            );
        }
    }

    // Review r5 repro (LOW): the run folder is made with `create_dir_all`, which follows a link planted at
    // `<data>/more-agents/run`, so the child can start inside a folder an agent writes; and it is not private (0700).
    #[cfg(unix)]
    #[test]
    fn review_r5_the_run_folder_stays_inside_the_data_folder_and_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir();
        let data = d.path().join("data");
        let outside = d.path().join("project");
        std::fs::create_dir_all(data.join("more-agents")).expect("data");
        std::fs::create_dir_all(&outside).expect("outside");
        std::os::unix::fs::symlink(&outside, data.join("more-agents").join("run")).expect("plant");
        let run = run_folder(&data).expect("run folder");
        let real = std::fs::canonicalize(&run).expect("canon");
        let mode = std::fs::metadata(&run).expect("meta").permissions().mode() & 0o777;
        assert!(
            real.starts_with(std::fs::canonicalize(&data).expect("canon data")) && mode == 0o700,
            "run folder is {real:?} with mode {mode:o}"
        );
    }

    #[test]
    fn the_switch_off_refuses_every_more_agents_spawn() {
        let d = dir();
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", "/opt/approved-agent", &[])],
        )
        .expect("seed");
        set_enabled(d.path(), false).expect("off");
        assert_eq!(
            approved_spawn(d.path(), "wp134", "/usr/bin").expect_err("off"),
            OFF_REFUSED
        );
        // Off is the default: a folder that never saw the switch refuses too.
        std::fs::remove_file(d.path().join(ENABLED_FILE)).expect("remove");
        assert!(!enabled(d.path()));
        assert!(approved_spawn(d.path(), "wp134", "/usr/bin").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_pinned_file_in_the_app_folder_is_named_on_the_card() {
        let d = dir();
        let config = d.path().join("settings.json");
        std::fs::write(&config, b"{}").expect("config");
        let tool = make_tool(&d.path().join("bin"), "wp134-cfg", b"#!/bin/sh\n");
        let path_value = tool.parent().unwrap().to_string_lossy().into_owned();
        let arg = format!("--config={}", config.to_string_lossy());
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", "wp134-cfg", &[arg.as_str()])],
        )
        .expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        let stored = read_stored(d.path()).expect("read");
        let mut notes = serde_json::Map::new();
        data_folder_notes(&stored, d.path(), &mut notes);
        assert!(notes["wp134"]
            .as_str()
            .unwrap()
            .contains("needs a new approval"));
    }

    #[cfg(unix)]
    #[test]
    fn a_re_pointed_link_is_not_shown_as_allowed() {
        let d = dir();
        let bin = d.path().join("bin");
        make_tool(&bin, "wp134-link", b"#!/bin/sh\n");
        let real = d.path().join("agent.js");
        let evil = d.path().join("evil.js");
        let link = d.path().join("current.js");
        std::fs::write(&real, b"ok").expect("real");
        std::fs::write(&evil, b"bad").expect("evil");
        std::os::unix::fs::symlink(&real, &link).expect("link");
        let path_value = bin.to_string_lossy().into_owned();
        let arg = link.to_string_lossy().into_owned();
        write_agents(
            d.path(),
            0,
            vec![entry("wp134", "wp134-link", &[arg.as_str()])],
        )
        .expect("seed");
        approve(d.path(), "wp134", &path_value).expect("approve");
        std::fs::remove_file(&link).expect("unlink");
        std::os::unix::fs::symlink(&evil, &link).expect("relink");
        let shown = view(&read_stored(d.path()).expect("read"), &path_value);
        assert_eq!(shown["approved"], json!([]));
    }
}
