//! WP-80: team workspaces. OFF by default and inert until Ash turns it on himself.
//!
//! Rules that hold everywhere in this file:
//! - Nothing leaves the machine unless `enabled` is true AND `endpoint` is set. Both default to off and empty, read
//!   from `team-workspace.json` in the app data folder. With either missing, no request is made.
//! - Every request after accepting an invitation carries the workspace token that the server issued for that person.
//!   A request with no token is not sent.
//! - Only shared projects reach an outbound payload. A private project is filtered out before anything is serialised.
//! - Roles and invitations are checked here, in one place, before any change. The shared machine runs the same rules;
//!   the loopback stand-in in the tests is the fixture for that contract.
//!
//! Wired to the Hub's stored projects: every change to the `projects` document (`local_hub_write`) runs
//! `sync_after_change`, which sends the shared projects when the switch is on. Not built here: the real hosted server,
//! live editing with Yjs (documents use revision checks instead), and task and doc stores. See
//! docs/hivra/work/WP-80-team-workspaces.md.
//!
//! The functions the rest of the app will call are only reached by tests until that wiring lands, so they are allowed
//! to be unused outside tests for now.
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

/// The settings file in the app data folder. Missing keys read as off and empty.
pub const CONFIG_FILE: &str = "team-workspace.json";

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

// --- the settings file and the off switch -----------------------------------------------------

/// `team-workspace.json`. Missing keys read as off and empty. `token` is this device's workspace token, issued when an
/// invitation is accepted; it is a secret and is never shown by the status command.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub endpoint: String,
    /// Never written to the settings file. It lives in the Keychain and is filled in at read time.
    #[serde(skip)]
    pub token: String,
}

/// A missing or unreadable file is the same as the default: off.
pub fn load_config(path: &Path) -> Config {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_config(path: &Path, config: &Config) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Saves the switch and the endpoint. The endpoint is checked first, so a bad address writes nothing. The token stays.
pub fn save_config(path: &Path, enabled: bool, endpoint: &str) -> Result<Config, String> {
    let endpoint = endpoint.trim().to_string();
    if !endpoint.is_empty() {
        validate_endpoint(&endpoint)?;
    }
    let mut config = load_config(path);
    config.enabled = enabled;
    config.endpoint = endpoint;
    write_config(path, &config)?;
    Ok(config)
}

/// Where this device's workspace token lives: the Keychain in the app, a memory double in tests.
pub trait TokenStore {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, token: &str) -> Result<(), String>;
}

/// The macOS Keychain (or the platform store). A dev copy's service is scoped to `monocode-hub-dev:` by hub_keychain.
pub struct Keychain;

pub const TOKEN_SERVICE: &str = "monocode-hub:team-workspace";
pub const TOKEN_ACCOUNT: &str = "device-token";

impl TokenStore for Keychain {
    fn read(&self) -> Result<Option<String>, String> {
        crate::hub_keychain::read(TOKEN_SERVICE, TOKEN_ACCOUNT)
    }
    fn write(&self, token: &str) -> Result<(), String> {
        crate::hub_keychain::store(TOKEN_SERVICE, TOKEN_ACCOUNT, token)
    }
}

/// Keeps the token the shared machine issued at accept time, in the store and never in the settings file.
pub fn remember_token(store: &dyn TokenStore, token: &str) -> Result<(), String> {
    store.write(token)
}

/// The token this device holds, or empty. A store that cannot be read counts as signed out, never as signed in.
pub fn recall_token(store: &dyn TokenStore) -> String {
    store.read().ok().flatten().unwrap_or_default()
}

/// The settings with the device token filled in from the store.
pub fn load_signed_in_config(path: &Path, store: &dyn TokenStore) -> Config {
    let mut config = load_config(path);
    config.token = recall_token(store);
    config
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

/// An agent acts for one member and inherits that member's role. It never sees a private project.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentScope {
    pub account: String,
    pub role: Role,
}

impl AgentScope {
    pub fn can_edit(&self) -> bool {
        allowed(self.role, Action::EditProject)
    }
}

pub fn agent_for(ws: &Workspace, member_account: &str) -> Result<AgentScope, TeamError> {
    let m = member(ws, member_account).ok_or(TeamError::NotMember)?;
    Ok(AgentScope {
        account: m.account.clone(),
        role: m.role,
    })
}

/// What an agent may read on the board: the shared projects only.
pub fn agent_board<'a>(scope: &AgentScope, projects: &'a [LocalProject]) -> Vec<&'a LocalProject> {
    let _ = scope;
    projects.iter().filter(|p| p.shared).collect()
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

/// The outcome of a field write. Each field is merged on its own: a field whose revision is still current is written, and
/// a field someone else changed first is reported with the revision the server holds, so nothing is silently lost.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FieldWrite {
    pub written: std::collections::HashMap<String, u64>,
    pub conflicts: std::collections::HashMap<String, u64>,
}

/// What the shared machine grants when an invitation is accepted.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Grant {
    pub token: String,
    pub role: Role,
}

/// A client for the shared machine. Only exists when the switch is on and an endpoint is set, so every network path
/// goes through `from_config` first.
#[derive(Debug, Clone)]
pub struct Client {
    base: String,
    token: String,
}

impl Client {
    pub fn from_config(config: &Config) -> Result<Option<Client>, String> {
        if !config.enabled || config.endpoint.trim().is_empty() {
            return Ok(None);
        }
        let url = validate_endpoint(&config.endpoint)?;
        Ok(Some(Client {
            base: url.as_str().trim_end_matches('/').to_string(),
            token: config.token.clone(),
        }))
    }

    fn agent() -> ureq::Agent {
        // No redirects: a redirect would send data to an address the endpoint rules never checked.
        ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(10))
            .redirects(0)
            .build()
    }

    /// One request. Returns the status and the JSON body; only the caller decides what a status means.
    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), String> {
        let mut request = Self::agent()
            .request(method, &format!("{}{path}", self.base))
            .set("Accept", "application/json");
        if !self.token.is_empty() {
            request = request.set("Authorization", &format!("Bearer {}", self.token));
        }
        let result = match body {
            Some(b) => request
                .set("Content-Type", "application/json")
                .send_string(&b.to_string()),
            None => request.call(),
        };
        let (status, text) = match result {
            Ok(resp) => (resp.status(), resp.into_string().unwrap_or_default()),
            Err(ureq::Error::Status(status, resp)) => {
                (status, resp.into_string().unwrap_or_default())
            }
            Err(e) => return Err(format!("the shared server could not be reached: {e}")),
        };
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    fn ok(status: u16, body: Value, what: &str) -> Result<Value, String> {
        if (200..300).contains(&status) {
            Ok(body)
        } else {
            Err(format!("{what}: the shared server answered {status}"))
        }
    }

    /// Accepts an invitation and returns this device's workspace token and role.
    pub fn accept(&self, invitation: &str, account: &str) -> Result<Grant, String> {
        let (status, body) = self.call(
            "POST",
            "/v1/accept",
            Some(&json!({ "token": invitation, "account": account })),
        )?;
        let body = Self::ok(status, body, "accepting the invitation")?;
        serde_json::from_value(body)
            .map_err(|e| format!("the shared server sent an unexpected reply: {e}"))
    }

    /// Pushes the shared projects and nothing else.
    pub fn push_projects(&self, projects: &[LocalProject]) -> Result<usize, String> {
        let shared: Vec<Value> = projects
            .iter()
            .filter(|p| p.shared)
            .map(|p| json!({ "id": p.id, "payload": p.payload }))
            .collect();
        let count = shared.len();
        let (status, body) = self.call("POST", "/v1/sync", Some(&json!({ "projects": shared })))?;
        Self::ok(status, body, "sync").map(|_| count)
    }

    /// Writes fields of a document. Each change is `(field, revision the writer saw, text)`.
    pub fn put_fields(
        &self,
        id: &str,
        changes: &[(&str, u64, &str)],
    ) -> Result<FieldWrite, String> {
        let fields: serde_json::Map<String, Value> = changes
            .iter()
            .map(|(name, if_rev, text)| {
                (name.to_string(), json!({ "ifRev": if_rev, "body": text }))
            })
            .collect();
        let (status, body) = self.call(
            "PUT",
            &format!("/v1/docs/{id}"),
            Some(&json!({ "fields": fields })),
        )?;
        let body = Self::ok(status, body, "saving the doc")?;
        serde_json::from_value(body)
            .map_err(|e| format!("the shared server sent an unexpected reply: {e}"))
    }

    /// Reads every field of a document as `field -> (revision, text)`.
    pub fn get_fields(
        &self,
        id: &str,
    ) -> Result<std::collections::HashMap<String, (u64, String)>, String> {
        let (status, body) = self.call("GET", &format!("/v1/docs/{id}"), None)?;
        let body = Self::ok(status, body, "reading the doc")?;
        Ok(body["fields"]
            .as_object()
            .map(|f| {
                f.iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            (
                                v["rev"].as_u64().unwrap_or(0),
                                v["body"].as_str().unwrap_or_default().to_string(),
                            ),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Says this person is here. The server takes the name from the token, not from the request.
    pub fn heartbeat(&self, account: &str) -> Result<(), String> {
        let (status, body) =
            self.call("POST", "/v1/presence", Some(&json!({ "account": account })))?;
        Self::ok(status, body, "presence").map(|_| ())
    }

    pub fn presence(&self) -> Result<Vec<String>, String> {
        let (status, body) = self.call("GET", "/v1/presence", None)?;
        let body = Self::ok(status, body, "presence")?;
        Ok(body["accounts"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }
}

/// Sends the shared projects, and nothing else, when the feature is on, an endpoint is set and this device has a token.
/// Any other state returns before a request is made.
pub fn sync_outbound(config: &Config, projects: &[LocalProject]) -> Result<SyncOutcome, String> {
    if !config.enabled {
        return Ok(SyncOutcome::Disabled);
    }
    if config.endpoint.trim().is_empty() {
        return Ok(SyncOutcome::NoEndpoint);
    }
    validate_endpoint(&config.endpoint)?;
    if config.token.is_empty() {
        return Err("accept an invitation before syncing".into());
    }
    let client = Client::from_config(config)?.ok_or("team workspaces are off")?;
    let sent = client.push_projects(projects)?;
    Ok(SyncOutcome::Sent { projects: sent })
}

/// The shared projects in the app's stored `projects` document, ready for an outbound payload. Only a record with
/// `shared: true` goes out, and its local `folder` (a path on this machine) and the `shared` flag are left out.
pub fn shared_projects_from_doc(doc: &Value) -> Vec<LocalProject> {
    doc["projects"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|p| p["shared"].as_bool() == Some(true))
                .filter_map(|p| {
                    let id = p["id"].as_str()?.to_string();
                    let mut payload = p.clone();
                    if let Some(record) = payload.as_object_mut() {
                        record.remove("folder");
                        record.remove("shared");
                    }
                    Some(LocalProject {
                        id,
                        shared: true,
                        payload,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What a change to the stored projects does. The switch is read first: with it off this returns before the token store
/// is touched, so the Keychain is never read for nothing. With it on, the token is read and the shared projects go out.
pub fn sync_on_write(
    path: &Path,
    store: &dyn TokenStore,
    doc: &Value,
) -> Result<SyncOutcome, String> {
    let config = load_config(path);
    if !config.enabled {
        return Ok(SyncOutcome::Disabled);
    }
    let config = Config {
        token: recall_token(store),
        ..config
    };
    sync_outbound(&config, &shared_projects_from_doc(doc))
}

/// Called after the app keeps a new `projects` document. The sync runs on a worker thread, and a failure is logged only:
/// the local store stays the source of truth, and the next change tries again.
pub fn sync_after_change<R: tauri::Runtime>(app: &tauri::AppHandle<R>, doc: Value) {
    let Ok(path) = config_path(app) else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(reason) = sync_on_write(&path, &Keychain, &doc) {
            eprintln!("team workspace: the change did not sync: {reason}");
        }
    });
}

/// What the settings screen may show. Reading it makes no network call and never reveals the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    /// The saved address. Not a secret, so the settings screen shows it and keeps it when the switch is turned off.
    pub endpoint: String,
    pub endpoint_configured: bool,
    /// This device holds a workspace token from an accepted invitation.
    pub signed_in: bool,
    /// On, the endpoint passes the address rules, and a token is held. Nothing is sent unless this is true.
    pub active: bool,
}

pub fn status_for(config: &Config) -> Status {
    let endpoint_configured = !config.endpoint.trim().is_empty();
    let signed_in = !config.token.is_empty();
    Status {
        enabled: config.enabled,
        endpoint: config.endpoint.trim().to_string(),
        endpoint_configured,
        signed_in,
        active: config.enabled
            && endpoint_configured
            && signed_in
            && validate_endpoint(&config.endpoint).is_ok(),
    }
}

fn config_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(CONFIG_FILE))
}

#[tauri::command]
pub fn team_workspace_status(app: tauri::AppHandle) -> Result<Status, String> {
    Ok(status_for(&load_signed_in_config(
        &config_path(&app)?,
        &Keychain,
    )))
}

/// Saves the switch and endpoint that Ash sets in Settings. Off writes no network call.
#[tauri::command]
pub fn team_workspace_save(
    app: tauri::AppHandle,
    enabled: bool,
    endpoint: String,
) -> Result<Status, String> {
    let config = save_config(&config_path(&app)?, enabled, &endpoint)?;
    Ok(status_for(&config))
}

/// Accepts an invitation against the configured endpoint and keeps the token it returns. Off refuses before any call.
#[tauri::command]
pub fn team_workspace_accept(
    app: tauri::AppHandle,
    invitation: String,
    account: String,
) -> Result<Status, String> {
    let path = config_path(&app)?;
    let config = load_config(&path);
    let client =
        Client::from_config(&config)?.ok_or("team workspaces are off; turn them on first")?;
    let grant = client.accept(invitation.trim(), account.trim())?;
    remember_token(&Keychain, &grant.token)?;
    Ok(status_for(&load_signed_in_config(&path, &Keychain)))
}
