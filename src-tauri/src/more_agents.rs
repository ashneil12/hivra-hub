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
const ALLOWED_ENV: [&str; 10] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "USERPROFILE",
    "SYSTEMROOT",
];

pub(crate) const CHANGED: &str =
    "The list changed in another window (revision). Reload it and try again.";
pub(crate) const NOT_APPROVED: &str =
    "This agent is not approved to run. Allow it in More agents first.";
pub(crate) const NO_COMMAND_FROM_APP: &str = "A More agents start takes no command from the app.";
pub(crate) const CORRUPT: &str = "The saved More agents list cannot be read. It was left as it is.";

/// Serialises every read-modify-write of the file, so an approval and a list write cannot overwrite each other.
static LOCK: Mutex<()> = Mutex::new(());

/// What is on disk. `approvals` maps an id to the fingerprint of the command the person approved.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Stored {
    pub revision: u64,
    pub agents: Vec<Value>,
    pub approvals: BTreeMap<String, String>,
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
    // Approvals are read as untrusted: anything that is not a plain id and fingerprint is dropped.
    let approvals = object
        .get("approvals")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(id, fp)| Some((id.clone(), fp.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Ok(Stored {
        revision,
        agents,
        approvals,
    })
}

fn save(data_dir: &Path, stored: &Stored) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("Could not create the data folder: {e}"))?;
    let document = json!({
        "revision": stored.revision,
        "agents": stored.agents,
        "approvals": stored.approvals,
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
    Ok((id.to_string(), command.to_string(), args))
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
            if current.approvals.get(&id) == Some(&fp) {
                approvals.insert(id, fp);
            }
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

/// Record or withdraw the person's approval for one entry, for the command it has now.
pub(crate) fn set_approval(data_dir: &Path, id: &str, allowed: bool) -> Result<Stored, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut stored = read_stored(data_dir)?;
    let entry = stored
        .agents
        .iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(id))
        .cloned()
        .ok_or("This agent is not in your list.")?;
    if allowed {
        let (checked_id, command, args) = checked_fields(&entry)?;
        stored
            .approvals
            .insert(checked_id, fingerprint(&command, &args));
    } else {
        stored.approvals.remove(id);
    }
    save(data_dir, &stored)?;
    Ok(stored)
}

/// The entry for `id`, checked again, if its command is approved. This is what a More agents spawn runs.
pub(crate) fn approved_spawn(
    data_dir: &Path,
    id: &str,
    path_value: &str,
) -> Result<Resolved, String> {
    let stored = read_stored(data_dir)?;
    let entry = stored
        .agents
        .iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(id))
        .ok_or("This agent is no longer in your list.")?;
    let (checked_id, command, args) = checked_fields(entry)?;
    let fp = fingerprint(&command, &args);
    if stored.approvals.get(&checked_id) != Some(&fp) {
        return Err(NOT_APPROVED.into());
    }
    let resolved = resolve_command(&command, path_value)?;
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
        args,
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
        std::env::split_paths(path_value)
            .map(|dir| dir.join(command))
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
    Ok(candidate.to_string_lossy().into_owned())
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

/// What the list says, for the window: the entries as stored, and the ids whose current command is approved.
pub(crate) fn view(stored: &Stored) -> Value {
    let approved: Vec<String> = stored
        .agents
        .iter()
        .filter_map(|agent| checked_fields(agent).ok())
        .filter(|(id, command, args)| stored.approvals.get(id) == Some(&fingerprint(command, args)))
        .map(|(id, _, _)| id)
        .collect();
    json!({
        "revision": stored.revision,
        "agents": stored.agents,
        "approved": approved,
    })
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// The list for the window: its revision, its entries as saved, and which ids are approved to run.
#[tauri::command]
pub fn more_agents_read(app: AppHandle) -> Result<Value, String> {
    Ok(view(&read_stored(&data_dir(&app)?)?))
}

/// Replace the list if the window read the current revision. Approvals are not changed here.
#[tauri::command]
pub fn more_agents_write(
    app: AppHandle,
    expected_revision: u64,
    agents: Vec<Value>,
) -> Result<Value, String> {
    Ok(view(&write_agents(
        &data_dir(&app)?,
        expected_revision,
        agents,
    )?))
}

/// The person's own tap: allow or withdraw one entry's current command.
#[tauri::command]
pub fn more_agents_approve(app: AppHandle, id: String, allowed: bool) -> Result<Value, String> {
    Ok(view(&set_approval(&data_dir(&app)?, &id, allowed)?))
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
        let path = std::env::temp_dir().join(format!("wp134-more-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("scratch dir");
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

    #[test]
    fn an_entry_cannot_use_a_first_class_id_or_command() {
        let d = dir();
        write_agents(d.path(), 0, vec![entry("copilot", "/opt/copilot", &[])]).expect("seed");
        set_approval(d.path(), "copilot", true).expect("approve");
        let stored = read_stored(d.path()).expect("read");
        assert!(stored.approvals.contains_key("copilot"));
        // Not a registry entry at all: the id is a first-class one.
        write_agents(d.path(), 1, vec![entry("devin", "/opt/devin-helper", &[])]).expect("write");
        assert!(approved_spawn(d.path(), "devin", "/usr/bin").is_err());
        // The command is the Claude CLI under another name.
        write_agents(
            d.path(),
            2,
            vec![entry("zed", "/usr/local/bin/claude", &[])],
        )
        .expect("write");
        assert!(approved_spawn(d.path(), "zed", "/usr/bin").is_err());
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
        set_approval(d.path(), "copilot", true).expect("approve");
        let run = approved_spawn(d.path(), "copilot", "/usr/bin");
        // The path is not on disk, so the entry is not runnable even when approved.
        assert!(run.is_err());
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
        set_approval(d.path(), "copilot", true).expect("approve");
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
        set_approval(d.path(), "copilot", true).expect("approve");
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
        set_approval(d.path(), "copilot", true).expect("approve");
        let err = approved_spawn(d.path(), "copilot", "/usr/bin:/bin").expect_err("not resolvable");
        assert!(!err.is_empty());
    }

    #[test]
    fn the_fingerprint_separates_arguments_that_would_join_to_the_same_text() {
        let a = fingerprint("/opt/a", &["b c".to_string()]);
        let b = fingerprint("/opt/a", &["b".to_string(), "c".to_string()]);
        assert_ne!(a, b);
        assert_eq!(a, fingerprint("/opt/a", &["b c".to_string()]));
    }

    #[test]
    fn the_view_lists_only_approved_ids_for_their_current_command() {
        let d = dir();
        write_agents(d.path(), 0, vec![entry("copilot", "/opt/copilot", &[])]).expect("seed");
        set_approval(d.path(), "copilot", true).expect("approve");
        let stored = read_stored(d.path()).expect("read");
        let shown = view(&stored);
        assert_eq!(shown["revision"], json!(1));
        assert_eq!(shown["approved"], json!(["copilot"]));
    }

    #[cfg(unix)]
    #[test]
    fn an_approved_entry_runs_the_file_it_names_found_by_path_or_by_absolute_path() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir();
        let bin = d.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin dir");
        let tool = bin.join("wp134-tool");
        std::fs::write(&tool, b"#!/bin/sh\n").expect("tool");
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let path_value = bin.to_string_lossy().into_owned();
        write_agents(d.path(), 0, vec![entry("wp134", "wp134-tool", &["--acp"])]).expect("seed");
        set_approval(d.path(), "wp134", true).expect("approve");
        let run = approved_spawn(d.path(), "wp134", &path_value).expect("approved and present");
        assert_eq!(run.command, tool.to_string_lossy());
        assert_eq!(run.args, vec!["--acp".to_string()]);
        write_agents(
            d.path(),
            1,
            vec![entry("wp134", &tool.to_string_lossy(), &["--acp"])],
        )
        .expect("absolute");
        set_approval(d.path(), "wp134", true).expect("approve absolute");
        assert_eq!(
            approved_spawn(d.path(), "wp134", "/usr/bin")
                .expect("absolute path runs")
                .command,
            tool.to_string_lossy()
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
        set_approval(d.path(), "wp134", true).expect("approve");
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
        set_approval(d.path(), "wp134b", true).expect("approve");
        let run = approved_start(d.path(), "wp134b", "", &[], false, &path_value)
            .expect("approved and present");
        assert_eq!(run.id, "wp134b");
        assert_eq!(run.command, tool.to_string_lossy());
        assert_eq!(run.args, vec!["acp".to_string(), "--flag".to_string()]);
    }
}
