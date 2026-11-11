//! WP-141: the one gate a worker or session launch passes before its process starts. Route logic picks the CLI;
//! this decides. It refuses a CLI on Never use, a CLI other than the locked default while Always use my default is
//! on, and any launch whose policy can't be read. Nothing here starts or stops a process.
//!
//! Round 6 invariant: every agent CLI start (`harness_spawn`, and the OpenCode 2.x service through `crew_spawn_ticket`)
//! judges Never use for that CLI. Round 7: the policy in force is the UNION of the Mono, the project the grant names,
//! the project owning the grant's folder, the project owning the spawn folder, and the system's. A worktree or a
//! subfolder counts as its project. The lock applies to `app-` sessions only.

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use super::policy::cli_id_of;
use super::resolve::cli_label;
use super::store::{self, Grant};

/// What a launch is about to run on, and the folder and Mono whose policy applies to it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCheck {
    /// The CLI the process would start.
    pub cli: String,
    #[serde(default)]
    pub mono: Option<String>,
    /// The folder the launch runs in. Its policy is the one of the project that owns it.
    #[serde(default)]
    pub project: Option<String>,
    /// The CLI the lock pins for this launch: the crew route's own pick. None when no default is known.
    #[serde(default)]
    pub locked_default: Option<String>,
}

/// Settings > Crew Defaults, named the same way in every refusal, so the person knows where the rule is changed.
const CREW_DEFAULTS: &str = "Settings > Crew Defaults";

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

fn unreadable(error: String) -> String {
    format!("The crew policy could not be read, so nothing was started ({error}).")
}

/// Ok when the launch may start. The reason is one plain line, shown to the person and the Lead.
pub fn check_launch(conn: &Connection, input: &LaunchCheck) -> Result<(), String> {
    let folders: Vec<String> = input.project.iter().cloned().collect();
    let projects = store::projects_owning_all(conn, &folders).map_err(unreadable)?;
    let policy =
        store::policy_for_all(conn, input.mono.as_deref(), &projects).map_err(unreadable)?;
    let cli = input.cli.trim();
    let name = label_of(cli);
    if never_listed(&policy).iter().any(|id| id == cli) {
        return Err(never_use_message(
            conn,
            input.mono.as_deref(),
            &projects,
            cli,
        )?);
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
            "Always use my default is on and no default CLI can take this work, so {name} was not started. Change it in {CREW_DEFAULTS}."
        )),
        Some(default) if default != cli => Err(format!(
            "Always use my default is on, and the default is {}, so {name} was not started. Change it in {CREW_DEFAULTS}.",
            label_of(default)
        )),
        Some(_) => Ok(()),
    }
}

/// How long a ticket stays good. A spawn follows its gate within a second; two minutes is slack, not a window.
const TICKET_TTL: std::time::Duration = std::time::Duration::from_secs(120);

/// A one-time permission to spawn one process: bound to the session, the CLI and the resolved folder.
#[derive(Debug)]
struct Ticket {
    id: String,
    session: String,
    cli: String,
    folder: String,
    expires: std::time::Instant,
}

static TICKETS: std::sync::Mutex<Vec<Ticket>> = std::sync::Mutex::new(Vec::new());

/// The session a launch is judged as. An Antigravity child is `app-…#n`; its decision is its session's, `app-…`.
pub fn session_of(session: &str) -> &str {
    session.split('#').next().unwrap_or(session).trim()
}

/// A session's own launches are the only ones with an `app-` id; a chat Ash opens from the UI has a UUID.
pub fn is_agent_session(session: &str) -> bool {
    session_of(session).starts_with("app-")
}

fn poisoned() -> String {
    "The crew gate is unavailable, so nothing was started.".to_string()
}

/// The gate's decision for a launch, saved for its session in the app database. Called once the launch has passed
/// `check_launch`, so a restart, a resumed worker or Ash typing into a worker is judged against the same default.
/// The folder is stored as the project that owns it, when one does, so the grant names the project, not a worktree.
pub fn record_grant(conn: &Connection, session: &str, input: &LaunchCheck) -> Result<(), String> {
    let project = match input
        .project
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(folder) => Some(
            store::project_owning(conn, folder)
                .map_err(unreadable)?
                .unwrap_or_else(|| folder.to_string()),
        ),
        None => None,
    };
    let grant = Grant {
        mono: input
            .mono
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
        project,
        locked_default: input
            .locked_default
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
    };
    store::save_grant(
        conn,
        session_of(session),
        &grant,
        crate::session_store::now_millis(),
    )
}

/// The projects whose policy applies to a launch: the one the grant names, the one owning the grant's folder, and the
/// one owning the spawn folder. Round 7: a grant never sheds the Never use of the project that owns the folder.
fn projects_in_force(
    conn: &Connection,
    grant: Option<&Grant>,
    folder: &str,
) -> Result<Vec<String>, String> {
    let mut folders = Vec::new();
    if let Some(project) = grant.and_then(|grant| grant.project.clone()) {
        folders.push(project);
    }
    folders.push(folder.to_string());
    store::projects_owning_all(conn, &folders).map_err(unreadable)
}

fn policy_of(
    conn: &Connection,
    grant: Option<&Grant>,
    projects: &[String],
) -> Result<Value, String> {
    store::policy_for_all(
        conn,
        grant.and_then(|grant| grant.mono.as_deref()),
        projects,
    )
    .map_err(unreadable)
}

/// The refusal for a CLI on Never use. It names the CLI, the list that holds it and where to change it, so the person
/// (and the Lead, which sees the same line in the chat) knows what to do.
fn never_use_message(
    conn: &Connection,
    mono: Option<&str>,
    projects: &[String],
    cli: &str,
) -> Result<String, String> {
    let scope = store::never_use_scope(conn, mono, projects, cli)
        .map_err(unreadable)?
        .unwrap_or_else(|| "everything (the system default)".into());
    Ok(format!(
        "{} is on Never use for {scope}, so it was not started. To change that, open {CREW_DEFAULTS} and edit Never use for {scope}.",
        label_of(cli)
    ))
}

/// The start judgment every agent CLI process passes: Never use for the CLI in force, and under the lock an `app-`
/// session must be the granted default. A session with no decision is refused under the lock, never judged by its folder.
pub fn judge_start(
    conn: &Connection,
    session: &str,
    cli: &str,
    folder: &str,
) -> Result<(), String> {
    let grant = store::grant_of(conn, session_of(session))?;
    let projects = projects_in_force(conn, grant.as_ref(), folder)?;
    let policy = policy_of(conn, grant.as_ref(), &projects)?;
    let cli = cli.trim();
    let name = label_of(cli);
    if never_listed(&policy).iter().any(|id| id == cli) {
        return Err(never_use_message(
            conn,
            grant.as_ref().and_then(|grant| grant.mono.as_deref()),
            &projects,
            cli,
        )?);
    }
    if !is_agent_session(session) {
        return Ok(());
    }
    // An agent session with no decision is never judged by its folder: under a lock in force anywhere it is refused.
    let Some(grant) = grant else {
        if lock_on(&policy) || store::any_lock(conn)? {
            return Err("This agent launch has no gate decision, so it was not started. Start the worker again from its chat so it is granted its default.".into());
        }
        return Ok(());
    };
    // Every judged start refreshes the grant, so the idle rule counts from the last start.
    store::touch_grant(
        conn,
        session_of(session),
        crate::session_store::now_millis(),
    )?;
    if !lock_on(&policy) {
        return Ok(());
    }
    match grant.locked_default.as_deref() {
        Some(default) if default == cli => Ok(()),
        Some(default) => Err(format!(
            "Always use my default is on, and the default is {}, so {name} was not started. Change it in {CREW_DEFAULTS}.",
            label_of(default)
        )),
        None => Err(format!(
            "Always use my default is on and this launch has no gate decision, so {name} was not started. Change it in {CREW_DEFAULTS}."
        )),
    }
}

/// The spawn gate: judged again at the process, so a banned CLI is refused whichever path reached it.
/// The ticket an `app-` session brings is minted by `issue_ticket` from the same judgment.
pub fn issue_ticket(
    conn: &Connection,
    session: &str,
    cli: &str,
    folder: &str,
) -> Result<String, String> {
    judge_start(conn, session, cli, folder)?;
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

/// The check the OpenCode 2.x service start runs before its session is bound. It has no process to spawn, so the ticket
/// is required outright and consumed here: a bind without a valid, unused ticket is refused.
pub fn bind_v2_session(
    conn: &Connection,
    session: &str,
    cli: &str,
    folder: &str,
    ticket: Option<&str>,
) -> Result<(), String> {
    if ticket.map(str::trim).filter(|id| !id.is_empty()).is_none() {
        return Err("This OpenCode session has no crew gate ticket, so it was not started.".into());
    }
    judge_spawn(conn, session, cli, folder, ticket)
}

/// The check `harness_spawn` runs before any agent process starts: the start judgment for every session, then the
/// one-time ticket an `app-` session must carry. Ash's own chats and Monos' chats need no ticket, only the judgment.
pub fn judge_spawn(
    conn: &Connection,
    session: &str,
    cli: &str,
    folder: &str,
    ticket: Option<&str>,
) -> Result<(), String> {
    judge_start(conn, session, cli, folder)?;
    require_ticket(session, cli, folder, ticket)
}

/// The ticket check. An `app-` session needs its ticket, which is spent here. Ash's own chats need none.
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
