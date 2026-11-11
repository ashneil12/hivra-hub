//! WP-141: the one gate a worker or session launch passes before its process starts. Route logic picks the CLI;
//! this decides. It refuses a CLI on Never use, a CLI other than the locked default while Always use my default is
//! on, and any launch whose policy can't be read. Nothing here starts or stops a process.

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use super::policy::cli_id_of;
use super::resolve::cli_label;
use super::store;

/// What a launch is about to run on, and the folder and Mono whose policy applies to it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCheck {
    /// The CLI the process would start.
    pub cli: String,
    #[serde(default)]
    pub mono: Option<String>,
    /// The project's folder, which is what its policy is saved under.
    #[serde(default)]
    pub project: Option<String>,
    /// The CLI the lock pins for this launch: the crew route's own pick. None when no default is known.
    #[serde(default)]
    pub locked_default: Option<String>,
}

fn label_of(cli: &str) -> String {
    cli_id_of(cli)
        .map(cli_label)
        .map(str::to_string)
        .unwrap_or_else(|| cli.to_string())
}

fn lock_on(policy: &Value) -> bool {
    policy.get("lockDefault").and_then(Value::as_bool) == Some(true)
}

fn never_listed(policy: &Value) -> Vec<String> {
    policy
        .get("neverUse")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Ok when the launch may start. The reason is one plain line, shown to the person and the Lead.
pub fn check_launch(conn: &Connection, input: &LaunchCheck) -> Result<(), String> {
    let policy = store::policy_for(conn, input.mono.as_deref(), input.project.as_deref()).map_err(
        |error| format!("The crew policy could not be read, so nothing was started ({error})."),
    )?;
    let cli = input.cli.trim();
    let name = label_of(cli);
    if never_listed(&policy).iter().any(|id| id == cli) {
        return Err(format!("{name} is on Never use, so it was not started."));
    }
    if !lock_on(&policy) {
        return Ok(());
    }
    let locked = input
        .locked_default
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    match locked {
        None => Err(format!(
            "Always use my default is on and no default CLI can take this work, so {name} was not started."
        )),
        Some(default) if default != cli => Err(format!(
            "Always use my default is on, and the default is {}, so {name} was not started.",
            label_of(default)
        )),
        Some(_) => Ok(()),
    }
}

/// How long a ticket stays good. A spawn follows its gate within a second; two minutes is slack, not a window.
const TICKET_TTL: std::time::Duration = std::time::Duration::from_secs(120);

/// What the gate decided for one session, kept so a later spawn of that session is judged against the same default.
#[derive(Clone, Debug)]
struct Grant {
    mono: Option<String>,
    locked_default: Option<String>,
}

/// A one-time permission to spawn one process: bound to the session, the CLI and the resolved folder.
#[derive(Debug)]
struct Ticket {
    id: String,
    session: String,
    cli: String,
    folder: String,
    expires: std::time::Instant,
}

static GRANTS: std::sync::Mutex<Option<std::collections::HashMap<String, Grant>>> =
    std::sync::Mutex::new(None);
static TICKETS: std::sync::Mutex<Vec<Ticket>> = std::sync::Mutex::new(Vec::new());

/// A session's own launches are the only ones with an `app-` id; a chat Ash opens from the UI has a UUID.
pub fn is_agent_session(session: &str) -> bool {
    session.starts_with("app-")
}

fn poisoned() -> String {
    "The crew gate is unavailable, so nothing was started.".to_string()
}

/// The gate's decision for a launch, kept for the session. Called once the launch has passed `check_launch`.
pub fn record_grant(session: &str, input: &LaunchCheck) -> Result<(), String> {
    let mut grants = GRANTS.lock().map_err(|_| poisoned())?;
    grants.get_or_insert_with(Default::default).insert(
        session.to_string(),
        Grant {
            mono: input.mono.clone(),
            locked_default: input
                .locked_default
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
        },
    );
    Ok(())
}

/// The spawn gate: judged again at the process, so a banned CLI is refused whichever path reached it.
/// Under the lock the CLI must be the one this session was granted. A session with no grant is refused under the lock.
pub fn issue_ticket(
    conn: &Connection,
    session: &str,
    cli: &str,
    folder: &str,
) -> Result<String, String> {
    let grant = GRANTS
        .lock()
        .map_err(|_| poisoned())?
        .as_ref()
        .and_then(|grants| grants.get(session).cloned());
    let mono = grant.as_ref().and_then(|grant| grant.mono.clone());
    let policy = store::policy_for(conn, mono.as_deref(), Some(folder)).map_err(|error| {
        format!("The crew policy could not be read, so nothing was started ({error}).")
    })?;
    let name = label_of(cli);
    if never_listed(&policy).iter().any(|id| id == cli) {
        return Err(format!("{name} is on Never use, so it was not started."));
    }
    if lock_on(&policy) {
        match grant.as_ref().and_then(|grant| grant.locked_default.as_deref()) {
            Some(default) if default == cli => {}
            Some(default) => {
                return Err(format!(
                    "Always use my default is on, and the default is {}, so {name} was not started.",
                    label_of(default)
                ))
            }
            None => {
                return Err(format!(
                    "Always use my default is on and this launch has no gate decision, so {name} was not started."
                ))
            }
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut tickets = TICKETS.lock().map_err(|_| poisoned())?;
    let now = std::time::Instant::now();
    tickets.retain(|ticket| ticket.expires > now);
    tickets.push(Ticket {
        id: id.clone(),
        session: session.to_string(),
        cli: cli.to_string(),
        folder: folder.to_string(),
        expires: now + TICKET_TTL,
    });
    Ok(id)
}

/// The spawn check. An `app-` session needs its ticket, which is spent here. Ash's own chats need none.
pub fn require_ticket(
    session: &str,
    cli: &str,
    folder: &str,
    ticket: Option<&str>,
) -> Result<(), String> {
    let Some(id) = ticket.map(str::trim).filter(|id| !id.is_empty()) else {
        if is_agent_session(session) {
            return Err("This agent launch has no crew gate ticket, so it was not started.".into());
        }
        return Ok(());
    };
    let mut tickets = TICKETS.lock().map_err(|_| poisoned())?;
    let Some(at) = tickets.iter().position(|ticket| ticket.id == id) else {
        return Err(
            "This crew gate ticket is unknown or was already used, so it was not started.".into(),
        );
    };
    let ticket = tickets.remove(at);
    if ticket.expires <= std::time::Instant::now() {
        return Err("This crew gate ticket has expired, so it was not started.".into());
    }
    if ticket.session != session || ticket.cli != cli || ticket.folder != folder {
        return Err("This crew gate ticket is for another launch, so it was not started.".into());
    }
    Ok(())
}
