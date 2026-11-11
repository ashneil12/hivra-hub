//! WP-92 step 6: one worker's environment.
//!
//! A first mate names up to three secrets for a worker it delegates. The app checks each name exactly as a command run
//! does, with the worker's own CLI as the executable, and asks the person first if that CLI has no grant. Only once
//! every name is approved are the handles armed under the new worker's session id. `harness_spawn` (Rust) reads the
//! values straight from the Keychain into that one child's environment, they never cross the webview, and the same
//! child's output is scrubbed before it reaches the app's transcript.
//!
//! What this route cannot do, said plainly on the card and in WP-92: the whole worker session holds the value, including
//! anything it starts. The command route (`secrets.run`) is the narrower one.
//!
//! Spec note: WP-92 asks for "the same cleared environment and allow-list as secret-run". A worker is a Claude/Codex/Devin
//! CLI that cannot start without its own HOME, PATH and provider login, so this route keeps the CLI's environment and
//! adds only the approved variable; it adds no `MONOCODE_*` value, no app token and no model key of its own. The command
//! route still uses the cleared allow-list.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::*;

/// The most one worker may be given.
pub const MAX_WORKER_SECRETS: usize = 3;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSecret {
    pub name: String,
    pub env: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRequest {
    /// The first mate's chat.
    pub chat: String,
    pub mono: String,
    #[serde(default)]
    pub project: Option<String>,
    /// The worker's CLI (its provider id, like `claude`), which the grants are for.
    pub executable: String,
    pub secrets: Vec<WorkerSecret>,
}

/// One approved handle, kept in memory only until the worker spawns.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmedSecret {
    pub scope: String,
    pub name: String,
    pub env: String,
    pub version: i64,
    /// The Mono whose worker it is, for the activity row and no other purpose.
    #[serde(skip)]
    pub mono: String,
    /// The worker's CLI, for the activity row.
    #[serde(skip)]
    pub executable: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state")]
pub enum WorkerOutcome {
    #[serde(rename = "missing")]
    Missing { name: String, scope: String },
    #[serde(rename = "waiting")]
    Waiting {
        #[serde(rename = "decisionKey")]
        decision_key: String,
        name: String,
        scope: String,
    },
    #[serde(rename = "denied")]
    Denied {
        #[serde(rename = "decisionKey")]
        decision_key: String,
        name: String,
    },
    /// Every name is approved: the handles may be armed for the worker's session.
    #[serde(rename = "ready")]
    Ready { secrets: Vec<ArmedSecret> },
}

/// The worker card's words. The whole worker session holds the value, and the CLI keeps a transcript of what it prints on
/// disk, so a value it prints stays there (fix round 3, M3).
pub fn worker_card_question(mono: &str, label: &str, whose: &str, env: &str) -> String {
    // Fix round 4 (N8): the worker's AI reads its own environment, so it can read the key and send it anywhere it can
    // reach (a web address, a memory, a room). The card says so, before the person answers.
    // Fix round 6: the card names the variable the key is put in, so the person is not approving an unnamed slot.
    format!(
        "Let {mono} start a worker with {label} ({whose}) in the environment variable {env}? The worker's AI can read the key and send it anywhere it can reach: a web address, a memory, a note or a room. The whole worker session will hold the value, including anything it starts, and the CLI keeps a transcript of what it prints on disk, so a value it prints stays there. Running one command with it is narrower: ask for that instead."
    )
}

/// App actions that do not store what they are given. Everything else an armed worker sends is scrubbed, so a write that
/// was added later cannot keep the value (fix round 5, L1).
fn read_only_app_action(action: &str) -> bool {
    matches!(
        action,
        "app.version"
            | "models.list"
            | "sessions.list"
            | "sessions.read"
            | "worktrees.list"
            | "actions.list"
            | "stacks.list"
            | "folders.list"
            | "notes.list"
            | "notes.read"
            | "artifacts.list"
            | "artifacts.read"
            | "soul.read"
            | "souls.read"
            | "memory.read"
            | "memory.search"
            | "memory.recall"
            | "skills.list"
            | "skills.read"
            | "habits.list"
            | "timers.list"
            | "activity.list"
            | "tasks.list"
            | "tasks.get"
            | "tasks.status"
            | "rooms.read"
            | "prs.status"
            | "docs.list"
            | "docs.get"
            | "secrets.list"
            | "creator.state"
            | "programme.list"
            | "work_log.read"
            | "autopilot.status"
    )
}

/// Scrub a worker's app action before it reaches the app: every string in its input is masked with the session's needles,
/// except a read. A session without armed values is left unchanged.
pub fn scrub_app_input(session_id: &str, action: &str, input: &mut serde_json::Value) {
    if read_only_app_action(action) {
        return;
    }
    let Ok(map) = session_values().lock() else {
        return;
    };
    let Some(values) = map.get(session_id) else {
        return;
    };
    mask_strings(input, &values.needles);
}

fn mask_strings(value: &mut serde_json::Value, needles: &[String]) {
    match value {
        serde_json::Value::String(text) => *text = scrub::mask(text, needles),
        serde_json::Value::Array(items) => items
            .iter_mut()
            .for_each(|item| mask_strings(item, needles)),
        serde_json::Value::Object(map) => map
            .values_mut()
            .for_each(|item| mask_strings(item, needles)),
        _ => {}
    }
}

/// Resolve every name, asking the person where there is no grant. Nothing is armed unless all names are ready.
pub fn prepare(
    vault: &dyn Vault,
    conn: &mut Connection,
    request: WorkerRequest,
    now: i64,
) -> Result<WorkerOutcome, String> {
    let chat = request.chat.trim();
    if chat.is_empty() {
        return Err("Which chat is asking?".into());
    }
    crate::decisions::check_may_ask(conn, chat)?;
    let mono = request.mono.trim();
    if mono.is_empty() {
        return Err("Which Mono is asking?".into());
    }
    let executable = request.executable.trim();
    if executable.is_empty()
        || executable.len() > 120
        || executable.contains(['/', '\\', ' ', '\0'])
    {
        return Err("That worker's CLI is unknown.".into());
    }
    if request.secrets.is_empty() {
        return Err("Name at least one secret.".into());
    }
    // Before the person is asked at all: a tool whose output the app never reads line by line would keep the key.
    if !delivers_line_stdout(executable) {
        return Err(REFUSED_OUTPUT.into());
    }
    if request.secrets.len() > MAX_WORKER_SECRETS {
        return Err(format!(
            "A worker gets at most {MAX_WORKER_SECRETS} secrets."
        ));
    }
    let project = request
        .project
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let mut names = HashSet::new();
    let mut envs = HashSet::new();
    let mut armed = Vec::new();
    for wanted in &request.secrets {
        let name = normalize_name(&wanted.name)?;
        if !names.insert(name.clone()) {
            return Err(format!("{name} is named twice."));
        }
        if let Some(why) = env_name_refusal(&wanted.env) {
            return Err(why);
        }
        if run::is_allowlisted_env(&wanted.env) {
            return Err(format!(
                "{} is one of the names the worker already gets. Pick a name of its own.",
                wanted.env
            ));
        }
        if !envs.insert(wanted.env.clone()) {
            return Err(format!("{} is used twice.", wanted.env));
        }
        let Some(row) = resolve(conn, project.as_deref(), &name)? else {
            return Ok(WorkerOutcome::Missing {
                name,
                scope: scope_for(project.as_deref()),
            });
        };
        if !has_value(vault, &row.scope, &row.name)? {
            return Ok(WorkerOutcome::Missing {
                name: row.name,
                scope: row.scope,
            });
        }
        let question =
            worker_card_question(mono, &row.label, &scope_words(&row.scope), &wanted.env);
        // A worker's grant is its own: keyed by the worker entry, never the CLI's name, so a `secrets.run` grant for the
        // same CLI does not spend it. A worker CLI can run any code, so the card offers no "Always".
        let worker_key = format!("worker:{executable}");
        match ensure_grant(
            conn,
            Approval {
                chat: chat.to_string(),
                mono: Some(mono.to_string()),
                project: project.clone(),
                scope: row.scope.clone(),
                name: row.name.clone(),
                executable: worker_key.clone(),
                identity: String::new(),
                key_source: worker_key.clone(),
                fingerprint: worker_key,
                question,
                options: approval_options(project.is_some(), false),
                recommended: "Once".into(),
            },
            now,
        )? {
            ApprovalOutcome::Granted => armed.push(ArmedSecret {
                scope: row.scope,
                name: row.name,
                env: wanted.env.clone(),
                version: row.version,
                mono: mono.to_string(),
                executable: executable.to_string(),
            }),
            ApprovalOutcome::Waiting { decision_key } => {
                return Ok(WorkerOutcome::Waiting {
                    decision_key,
                    name: row.name,
                    scope: row.scope,
                })
            }
            ApprovalOutcome::Denied { decision_key } => {
                return Ok(WorkerOutcome::Denied {
                    decision_key,
                    name: row.name,
                })
            }
        }
    }
    Ok(WorkerOutcome::Ready { secrets: armed })
}

/// Handles armed for a worker that has not spawned yet.
fn armed() -> &'static Mutex<HashMap<String, Vec<ArmedSecret>>> {
    static MAP: std::sync::OnceLock<Mutex<HashMap<String, Vec<ArmedSecret>>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Values held for a running worker, only to scrub its output. Cleared when the child exits.
struct SessionValues {
    /// The values themselves, held so their `Zeroizing` drop clears them when the child is gone.
    #[allow(dead_code)]
    values: Zeroizing<Vec<String>>,
    needles: Vec<String>,
}

fn session_values() -> &'static Mutex<HashMap<String, SessionValues>> {
    static MAP: std::sync::OnceLock<Mutex<HashMap<String, SessionValues>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Arm the approved handles under the worker's session id. Only `secrets_worker_arm` calls this.
pub fn arm(session_id: &str, secrets: Vec<ArmedSecret>) {
    if session_id.trim().is_empty() || secrets.is_empty() {
        return;
    }
    if let Ok(mut map) = armed().lock() {
        map.insert(session_id.to_string(), secrets);
    }
}

/// The worker programs whose whole output the app reads line by line and scrubs (`scrub_line`). Everything else is
/// refused the value: OpenCode talks over HTTP and SSE, so the app would never see the words its output turns into.
pub const LINE_STDOUT_WORKERS: [&str; 10] = [
    "claude",
    "codex",
    "cursor",
    "grok",
    "pi",
    "omp",
    "fx",
    "hermes",
    "antigravity",
    "devin",
];

/// The one sentence a worker's task shows when its tool cannot be given a key.
pub const REFUSED_OUTPUT: &str =
    "this tool can't keep a key out of its own output, so it was not given the key";

/// Whether this worker's output reaches the app as lines it can scrub.
pub fn delivers_line_stdout(executable: &str) -> bool {
    let base = executable
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(executable)
        .to_ascii_lowercase();
    LINE_STDOUT_WORKERS.contains(&base.as_str())
}

/// Put the armed values into one worker's own environment. Called by `harness_spawn` before the child forks.
///
/// Read and check first, consume last: the approval is only spent once every value is read, current and ready to go in,
/// and nothing is put in the child until then. A keychain that won't answer yet ("not now") leaves the approval where it
/// was, so the same spawn can be tried again. A refusal that can never change (the tool can't keep a key out of its
/// output, the value was deleted, the value changed since the person approved it) drops the approval, so a stale one
/// cannot be used by a later spawn.
pub fn apply_to_child(
    session_id: &str,
    vault: &dyn Vault,
    cmd: &mut Command,
    store: &crate::session_store::SessionStore,
    now: i64,
) -> Result<(), String> {
    let secrets = armed()
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).cloned())
        .unwrap_or_default();
    if secrets.is_empty() {
        return Ok(());
    }
    let drop_approval = || {
        if let Ok(mut map) = armed().lock() {
            map.remove(session_id);
        }
    };
    if secrets
        .iter()
        .any(|secret| !delivers_line_stdout(&secret.executable))
    {
        drop_approval();
        return Err(REFUSED_OUTPUT.into());
    }
    // The Keychain is read with the store's lock free: a system prompt left open must not stall every database writer.
    let mut values: Vec<Zeroizing<String>> = Vec::new();
    let mut needles = Vec::new();
    for secret in &secrets {
        let service = service(&secret.scope, &secret.name)?;
        // A refused read is "not now": the approval stays.
        let Some(value) = vault.read(&service, ACCOUNT)? else {
            drop_approval();
            return Err("That secret was deleted. Ask for it again.".into());
        };
        let value = Zeroizing::new(value);
        needles.extend(scrub::needles(&value));
        values.push(value);
    }
    // Then the lock, briefly: is each value still the version that was approved, and the log rows (which can fail). The
    // child's variables, the scrub values and the spent approval follow, and none of them can.
    {
        let conn = store.lock_conn()?;
        for secret in &secrets {
            let current = get_secret(&conn, &secret.scope, &secret.name)?
                .is_some_and(|row| row.version == secret.version);
            if !current {
                drop(conn);
                drop_approval();
                return Err("That secret changed. Ask for it again.".into());
            }
        }
        for secret in &secrets {
            touch_used(&conn, &secret.scope, &secret.name, now)?;
        }
        if let Some(first) = secrets.first() {
            record_worker(&conn, &first.mono, &first.executable, &secrets, now)?;
        }
    }
    // The worker keeps its tool's own environment (HOME, PATH, login), but never the app's `MONOCODE_*` variables: those
    // carry the control and app tokens, and an inherited copy would reach the tool that holds the key.
    // Stripped from the command as it now stands (configure_child may have set them) and from this process's environment.
    let set: Vec<std::ffi::OsString> = cmd
        .get_envs()
        .filter(|(key, _)| key.to_string_lossy().starts_with("MONOCODE_"))
        .map(|(key, _)| key.to_os_string())
        .collect();
    for key in set {
        cmd.env_remove(key);
    }
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("MONOCODE_") {
            cmd.env_remove(key);
        }
    }
    for (secret, value) in secrets.iter().zip(&values) {
        cmd.env(&secret.env, value.as_str());
    }
    needles.sort_by_key(|needle| std::cmp::Reverse(needle.len()));
    needles.dedup();
    if let Ok(mut map) = session_values().lock() {
        map.insert(
            session_id.to_string(),
            SessionValues {
                values: Zeroizing::new(values.iter().map(|value| value.to_string()).collect()),
                needles,
            },
        );
    }
    drop_approval();
    Ok(())
}

/// Scrub one line of a worker's output. A session without armed secrets is returned unchanged.
pub fn scrub_line(session_id: &str, line: String) -> String {
    let Ok(map) = session_values().lock() else {
        return line;
    };
    let Some(values) = map.get(session_id) else {
        return line;
    };
    scrub::mask(&line, &values.needles)
}

/// The child is gone: forget its values.
pub fn forget(session_id: &str) {
    if let Ok(mut map) = session_values().lock() {
        map.remove(session_id);
    }
    if let Ok(mut map) = armed().lock() {
        map.remove(session_id);
    }
}

/// One activity row per worker given a secret: the Mono, the CLI and the names. Never a value.
pub fn record_worker(
    conn: &Connection,
    mono: &str,
    executable: &str,
    secrets: &[ArmedSecret],
    at: i64,
) -> Result<(), String> {
    let names: Vec<&str> = secrets.iter().map(|secret| secret.name.as_str()).collect();
    crate::activity::record(
        conn,
        "secret.worker",
        &crate::activity::Who::mono(mono, mono),
        &crate::activity::Who::mono(mono, mono),
        "",
        executable,
        &format!(
            "{mono} started a worker with {} in its environment",
            names.join(", ")
        ),
        "",
        at,
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[cfg(test)]
pub(crate) fn clear_for_tests() {
    if let Ok(mut map) = armed().lock() {
        map.clear();
    }
    if let Ok(mut map) = session_values().lock() {
        map.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::store::Memory;
    use crate::session_store::SessionStore;

    const VALUE: &str = "sk_live_51NxAbCdEfGhIjKl";
    const NOW: i64 = 1_700_000_000_000;

    /// One saved key, armed for one worker session, with the store and the vault it reads from.
    fn armed_worker(session: &str) -> (SessionStore, Memory) {
        clear_for_tests();
        let store = SessionStore::open_in_memory().unwrap();
        let vault = Memory::new();
        let version = {
            let conn = store.lock_conn().unwrap();
            save_value(
                &vault,
                &conn,
                SCOPE_GLOBAL,
                "stripe-api-key",
                None,
                VALUE,
                NOW,
            )
            .unwrap();
            get_secret(&conn, SCOPE_GLOBAL, "stripe-api-key")
                .unwrap()
                .unwrap()
                .version
        };
        arm(
            session,
            vec![ArmedSecret {
                scope: SCOPE_GLOBAL.into(),
                name: "stripe-api-key".into(),
                env: "STRIPE_API_KEY".into(),
                version,
                mono: "m1".into(),
                executable: "claude".into(),
            }],
        );
        (store, vault)
    }

    // fix round 4 (N8): a worker's memory, note, room and doc writes keep no armed value; a read is left as it is.
    #[test]
    fn a_workers_memory_note_room_and_doc_writes_keep_no_armed_value() {
        let (store, vault) = armed_worker("worker-8");
        let mut cmd = Command::new("/usr/bin/true");
        apply_to_child("worker-8", &vault, &mut cmd, &store, NOW).unwrap();
        for action in ["memory.add", "notes.write", "rooms.post", "docs.create"] {
            let mut input = serde_json::json!({
                "title": "t",
                "body": format!("the key is {VALUE} done"),
                "nested": [VALUE.to_string()],
            });
            scrub_app_input("worker-8", action, &mut input);
            let text = input.to_string();
            assert!(!text.contains(VALUE), "{action} kept the value: {text}");
            assert!(text.contains(scrub::MARKER), "{action}: {text}");
        }
        let mut read = serde_json::json!({ "q": VALUE });
        scrub_app_input("worker-8", "rooms.read", &mut read);
        assert_eq!(read["q"], VALUE, "a read is not a write");
        // Round 5 (L1): every app action is scrubbed except an explicit read list. A send keeps what it is given.
        for action in ["sessions.send", "artifacts.write", "memory.replace"] {
            let mut input = serde_json::json!({ "prompt": format!("key {VALUE}") });
            scrub_app_input("worker-8", action, &mut input);
            let text = input.to_string();
            assert!(!text.contains(VALUE), "{action} kept the value: {text}");
            assert!(text.contains(scrub::MARKER), "{action}: {text}");
        }
        // docs.get is a read. The old prefix `docs.` scrubbed it.
        let mut get = serde_json::json!({ "id": VALUE });
        scrub_app_input("worker-8", "docs.get", &mut get);
        assert_eq!(get["id"], VALUE, "docs.get is a read");
    }

    // fix round 2 (M3): an armed worker's final environment holds no MONOCODE_* variable, even one configure_child set.
    #[test]
    fn an_armed_worker_keeps_no_app_token_in_its_final_environment() {
        let (store, vault) = armed_worker("worker-1");
        let mut cmd = Command::new("/usr/bin/true");
        cmd.env("MONOCODE_APP_TOKEN", "app-token-value")
            .env("MONOCODE_APP_ENDPOINT", "127.0.0.1:1")
            .env("MONOCODE_CONTROL_TOKEN", "control-token-value");
        apply_to_child("worker-1", &vault, &mut cmd, &store, NOW).unwrap();
        let envs: Vec<(String, bool)> = cmd
            .get_envs()
            .map(|(key, value)| (key.to_string_lossy().into_owned(), value.is_some()))
            .collect();
        // A removal is recorded as a key with no value: no MONOCODE_ variable may be set.
        assert!(
            envs.iter()
                .all(|(key, set)| !key.starts_with("MONOCODE_") || !set),
            "{envs:?}"
        );
        assert!(envs
            .iter()
            .any(|(key, set)| key == "STRIPE_API_KEY" && *set));
    }

    // fix round 2 (M4): the scrub values outlive the child, so a respawn of the same session still masks the value.
    #[test]
    fn the_scrub_outlives_the_child_so_a_respawn_still_masks_the_value() {
        let (store, vault) = armed_worker("worker-2");
        let mut first = Command::new("/usr/bin/true");
        apply_to_child("worker-2", &vault, &mut first, &store, NOW).unwrap();
        // The child exits. The harness no longer forgets the session's values at that point.
        // A respawn arms nothing and gets no variable, yet its output is still scrubbed.
        let mut respawn = Command::new("/usr/bin/true");
        apply_to_child("worker-2", &vault, &mut respawn, &store, NOW).unwrap();
        let line = scrub_line("worker-2", format!("key is {VALUE}"));
        assert!(!line.contains(VALUE), "{line}");
    }
}
