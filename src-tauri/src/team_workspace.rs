//! WP-80: team workspaces. OFF by default and inert until Ash turns it on himself.
//!
//! Rules that hold everywhere in this file:
//! - Nothing leaves the machine unless `enabled` is true AND `endpoint` is set. Both default to off and empty, read
//!   from `team-workspace.json` in the app data folder. With either missing, `sync_outbound` makes no call at all.
//! - Only shared projects reach an outbound payload. A private project is filtered out before anything is serialised.
//! - Roles and invitations are checked here, in one place, before any change. A shared machine must run the same
//!   rules; this module is the reference for them.
//!
//! Not built here: live co-editing (Yjs), presence, the shared server itself, and wiring into the task and doc stores.
//! See docs/hivra/work/WP-80-team-workspaces.md.
//!
//! The functions the rest of the app will call (sync, transport, board) are only reached by tests until that wiring
//! lands, so they are allowed to be unused outside tests for now.
#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tauri::Manager;
use url::{Host, Url};
use uuid::Uuid;

#[cfg(test)]
#[path = "team_workspace_tests.rs"]
mod tests;

/// How long an invitation link works after it is made.
pub const INVITE_TTL_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Member,
    Guest,
}

impl Role {
    fn rank(self) -> u8 {
        match self {
            Role::Owner => 3,
            Role::Admin => 2,
            Role::Member => 1,
            Role::Guest => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    ReadBoard,
    EditProject,
    Invite,
    ManageMembers,
    DeleteWorkspace,
}

/// What each role may do. Guests read; members edit; admins also invite and manage members; only the owner deletes.
pub fn allowed(role: Role, action: Action) -> bool {
    match action {
        Action::ReadBoard => true,
        Action::EditProject => role.rank() >= Role::Member.rank(),
        Action::Invite | Action::ManageMembers => role.rank() >= Role::Admin.rank(),
        Action::DeleteWorkspace => role == Role::Owner,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamError {
    NotMember,
    Forbidden,
    NoSuchMember,
    AlreadyMember,
    /// Unknown, used or expired. One message for all three, so a guess reveals nothing.
    InvalidInvitation,
}

impl std::fmt::Display for TeamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TeamError::NotMember => "not a member of this workspace",
            TeamError::Forbidden => "your role does not allow this",
            TeamError::NoSuchMember => "no such member",
            TeamError::AlreadyMember => "already a member",
            TeamError::InvalidInvitation => "this invitation is invalid or has expired",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Member {
    pub account: String,
    pub role: Role,
}

/// Only a hash of the link's token is kept. The token itself is shown once, when the link is made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Invitation {
    pub token_hash: String,
    pub role: Role,
    pub invited_by: String,
    pub expires_at: u64,
    pub used: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub members: Vec<Member>,
    pub invitations: Vec<Invitation>,
}

pub fn new_workspace(id: &str, owner: &str) -> Workspace {
    Workspace {
        id: id.to_string(),
        members: vec![Member {
            account: owner.to_string(),
            role: Role::Owner,
        }],
        invitations: Vec::new(),
    }
}

fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn member<'a>(ws: &'a Workspace, account: &str) -> Option<&'a Member> {
    ws.members.iter().find(|m| m.account == account)
}

fn member_index(ws: &Workspace, account: &str) -> Result<usize, TeamError> {
    ws.members
        .iter()
        .position(|m| m.account == account)
        .ok_or(TeamError::NoSuchMember)
}

/// The actor's role if they are a member and the role allows the action.
pub fn authorize(ws: &Workspace, actor: &str, action: Action) -> Result<Role, TeamError> {
    let m = member(ws, actor).ok_or(TeamError::NotMember)?;
    if allowed(m.role, action) {
        Ok(m.role)
    } else {
        Err(TeamError::Forbidden)
    }
}

/// Makes an invitation link and returns its token (shown once). The role must be strictly below the inviter's, so an
/// admin can invite members and guests, and nobody can invite an owner or someone at their own level.
pub fn create_invitation(
    ws: &mut Workspace,
    actor: &str,
    role: Role,
    now: u64,
) -> Result<String, TeamError> {
    let actor_role = authorize(ws, actor, Action::Invite)?;
    if role.rank() >= actor_role.rank() {
        return Err(TeamError::Forbidden);
    }
    // Two v4 UUIDs from the OS random source: 256 bits in all.
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    ws.invitations.push(Invitation {
        token_hash: hash_token(&token),
        role,
        invited_by: actor.to_string(),
        expires_at: now + INVITE_TTL_SECS,
        used: false,
    });
    Ok(token)
}

/// Joins `account` with the invitation's role and spends the link. An existing member is refused before the link is
/// checked, so trying a link again never uses it up.
pub fn accept_invitation(
    ws: &mut Workspace,
    token: &str,
    account: &str,
    now: u64,
) -> Result<Role, TeamError> {
    if member(ws, account).is_some() {
        return Err(TeamError::AlreadyMember);
    }
    let hash = hash_token(token);
    let invitation = ws
        .invitations
        .iter_mut()
        .find(|i| i.token_hash == hash && !i.used && i.expires_at > now)
        .ok_or(TeamError::InvalidInvitation)?;
    invitation.used = true;
    let role = invitation.role;
    ws.members.push(Member {
        account: account.to_string(),
        role,
    });
    Ok(role)
}

/// Changes a member's role. The actor must outrank the member now and the new role, and nobody becomes an owner here.
pub fn set_role(
    ws: &mut Workspace,
    actor: &str,
    target: &str,
    new_role: Role,
) -> Result<(), TeamError> {
    let actor_role = authorize(ws, actor, Action::ManageMembers)?;
    let index = member_index(ws, target)?;
    let current = ws.members[index].role;
    if current.rank() >= actor_role.rank() || new_role.rank() >= actor_role.rank() {
        return Err(TeamError::Forbidden);
    }
    ws.members[index].role = new_role;
    Ok(())
}

/// Removes a member the actor outranks. Nobody removes an owner, or someone at their own level.
pub fn remove_member(ws: &mut Workspace, actor: &str, target: &str) -> Result<(), TeamError> {
    let actor_role = authorize(ws, actor, Action::ManageMembers)?;
    let index = member_index(ws, target)?;
    if ws.members[index].role.rank() >= actor_role.rank() {
        return Err(TeamError::Forbidden);
    }
    ws.members.remove(index);
    Ok(())
}

// --- the off switch and what may leave the machine --------------------------------------------

/// The settings file in the app data folder. Missing keys read as off and empty.
pub const CONFIG_FILE: &str = "team-workspace.json";

/// `team-workspace.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub endpoint: String,
}

/// A missing or unreadable file is the same as the default: off.
pub fn load_config(path: &Path) -> Config {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// One local project. Only `shared` projects are ever sent; `payload` is whatever the project holds.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalProject {
    pub id: String,
    pub shared: bool,
    pub payload: Value,
}

/// The shared projects a member may see on the board. Private projects are never on it, for anyone.
pub fn shared_board<'a>(
    ws: &Workspace,
    actor: &str,
    projects: &'a [LocalProject],
) -> Result<Vec<&'a LocalProject>, TeamError> {
    authorize(ws, actor, Action::ReadBoard)?;
    Ok(projects.iter().filter(|p| p.shared).collect())
}

/// Endpoint rules: https, or plain http only to this machine, and never with credentials in the address.
pub fn validate_endpoint(raw: &str) -> Result<Url, String> {
    let url =
        Url::parse(raw.trim()).map_err(|e| format!("the endpoint is not a valid address: {e}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the endpoint address must not carry a user name or password".into());
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_this_machine(&url) => Ok(url),
        _ => Err("the endpoint must be https, or http on this machine".into()),
    }
}

fn is_this_machine(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// How a sync attempt ended. `Disabled` and `NoEndpoint` mean nothing was sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOutcome {
    Disabled,
    NoEndpoint,
    Sent { projects: usize },
}

/// Where a payload goes. The real one is `HttpTransport`; tests use a counting double or a loopback stand-in.
pub trait Transport {
    fn post_json(&self, endpoint: &str, body: &str) -> Result<(), String>;
}

pub struct HttpTransport;

impl Transport for HttpTransport {
    fn post_json(&self, endpoint: &str, body: &str) -> Result<(), String> {
        // No redirects: a redirect would send the payload to an address the endpoint rules never checked. A 3xx is
        // not a success either, so only a 2xx answer counts as sent.
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(10))
            .redirects(0)
            .build();
        match agent
            .post(endpoint)
            .set("Content-Type", "application/json")
            .send_string(body)
        {
            Ok(response) if (200..300).contains(&response.status()) => Ok(()),
            Ok(response) => Err(format!(
                "the shared server answered {} and did not take the sync",
                response.status()
            )),
            Err(e) => Err(format!("the shared server did not accept the sync: {e}")),
        }
    }
}

/// Sends the shared projects, and nothing else, when the feature is on and an endpoint is set. Any other state returns
/// before the transport is touched.
pub fn sync_outbound(
    config: &Config,
    projects: &[LocalProject],
    transport: &dyn Transport,
) -> Result<SyncOutcome, String> {
    if !config.enabled {
        return Ok(SyncOutcome::Disabled);
    }
    if config.endpoint.trim().is_empty() {
        return Ok(SyncOutcome::NoEndpoint);
    }
    let url = validate_endpoint(&config.endpoint)?;
    let shared: Vec<Value> = projects
        .iter()
        .filter(|p| p.shared)
        .map(|p| json!({ "id": p.id, "payload": p.payload }))
        .collect();
    let count = shared.len();
    let body = serde_json::to_string(&json!({ "projects": shared })).map_err(|e| e.to_string())?;
    transport.post_json(url.as_str(), &body)?;
    Ok(SyncOutcome::Sent { projects: count })
}

/// What the settings screen may show. Reading it makes no network call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub endpoint_configured: bool,
    /// On, and the endpoint passes the address rules. Nothing is sent unless this is true.
    pub active: bool,
}

pub fn status_for(config: &Config) -> Status {
    let endpoint_configured = !config.endpoint.trim().is_empty();
    Status {
        enabled: config.enabled,
        endpoint_configured,
        active: config.enabled
            && endpoint_configured
            && validate_endpoint(&config.endpoint).is_ok(),
    }
}

#[tauri::command]
pub fn team_workspace_status(app: tauri::AppHandle) -> Result<Status, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(CONFIG_FILE);
    Ok(status_for(&load_config(&path)))
}
