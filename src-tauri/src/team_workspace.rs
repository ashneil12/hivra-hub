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
//! Roles and invitations are checked in this file. They are not wired to a control-port action; the settings screen
//! joins through `team_workspace_accept` only.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    time::Duration,
};
use tauri::{Emitter, Manager};
use url::{Host, Url};
use uuid::Uuid;

#[cfg(test)]
#[path = "team_workspace_tests.rs"]
mod tests;

/// How long an invitation link works after it is made.
#[cfg_attr(not(test), allow(dead_code))]
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
    #[cfg_attr(not(test), allow(dead_code))]
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
#[cfg_attr(not(test), allow(dead_code))]
pub enum Action {
    ReadBoard,
    EditProject,
    Invite,
    ManageMembers,
    DeleteWorkspace,
}

/// What each role may do. Guests read; members edit; admins also invite and manage members; only the owner deletes.
#[cfg_attr(not(test), allow(dead_code))]
pub fn allowed(role: Role, action: Action) -> bool {
    match action {
        Action::ReadBoard => true,
        Action::EditProject => role.rank() >= Role::Member.rank(),
        Action::Invite | Action::ManageMembers => role.rank() >= Role::Admin.rank(),
        Action::DeleteWorkspace => role == Role::Owner,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum TeamError {
    NotMember,
    Forbidden,
    NoSuchMember,
    AlreadyMember,
    /// Unknown, used or expired. One message for all three, so a guess reveals nothing.
    InvalidInvitation,
    /// The joined name is empty, too long, or not a name.
    BadName,
}

impl std::fmt::Display for TeamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TeamError::NotMember => "not a member of this workspace",
            TeamError::Forbidden => "your role does not allow this",
            TeamError::NoSuchMember => "no such member",
            TeamError::AlreadyMember => "already a member",
            TeamError::InvalidInvitation => "this invitation is invalid or has expired",
            TeamError::BadName => {
                "Use a name up to 40 letters, digits, spaces, apostrophes, periods or hyphens."
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct Member {
    pub account: String,
    pub role: Role,
}

/// Only a hash of the link's token is kept. The token itself is shown once, when the link is made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct Invitation {
    pub token_hash: String,
    pub role: Role,
    pub invited_by: String,
    pub expires_at: u64,
    pub used: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct Workspace {
    pub id: String,
    pub members: Vec<Member>,
    pub invitations: Vec<Invitation>,
}

#[cfg_attr(not(test), allow(dead_code))]
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

#[cfg_attr(not(test), allow(dead_code))]
fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg_attr(not(test), allow(dead_code))]
fn member<'a>(ws: &'a Workspace, account: &str) -> Option<&'a Member> {
    ws.members.iter().find(|m| m.account == account)
}

#[cfg_attr(not(test), allow(dead_code))]
fn member_index(ws: &Workspace, account: &str) -> Result<usize, TeamError> {
    ws.members
        .iter()
        .position(|m| m.account == account)
        .ok_or(TeamError::NoSuchMember)
}

/// The actor's role if they are a member and the role allows the action.
#[cfg_attr(not(test), allow(dead_code))]
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
#[cfg_attr(not(test), allow(dead_code))]
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

/// A joined name: 1 to 40 letters, digits, spaces, apostrophes, periods or hyphens, after trimming.
pub fn check_joined_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    let ok = (1..=40).contains(&name.chars().count())
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '\'' | '.' | '-'));
    if ok {
        Ok(())
    } else {
        Err("Use a name up to 40 letters, digits, spaces, apostrophes, periods or hyphens.".into())
    }
}

/// Joins `account` with the invitation's role and spends the link. A name that is not a name, and an existing member,
/// are refused before the link is checked, so trying a link again never uses it up.
#[cfg_attr(not(test), allow(dead_code))]
pub fn accept_invitation(
    ws: &mut Workspace,
    token: &str,
    account: &str,
    now: u64,
) -> Result<Role, TeamError> {
    let account = account.trim();
    if check_joined_name(account).is_err() {
        return Err(TeamError::BadName);
    }
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
#[cfg_attr(not(test), allow(dead_code))]
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
#[cfg_attr(not(test), allow(dead_code))]
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

fn address_changed_of(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|raw| raw["addressChanged"].as_bool())
        .unwrap_or(false)
}

/// The same server: equal after trim, or the same scheme, host, port and path. A trailing slash does not make a new one.
fn same_server(a: &str, b: &str) -> bool {
    let a = a.trim();
    let b = b.trim();
    if a == b {
        return true;
    }
    let (Ok(left), Ok(right)) = (Url::parse(a), Url::parse(b)) else {
        return false;
    };
    left.scheme() == right.scheme()
        && left.host() == right.host()
        && left.port_or_known_default() == right.port_or_known_default()
        && left.path().trim_end_matches('/') == right.path().trim_end_matches('/')
        && left.query() == right.query()
}

fn write_config_with(
    path: &Path,
    config: &Config,
    account: Option<String>,
    address_changed: bool,
) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut body: Value = serde_json::to_value(config).map_err(|e| e.to_string())?;
    if let Some(account) = account {
        body["account"] = json!(account);
    }
    if address_changed {
        body["addressChanged"] = json!(true);
    }
    let body = serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Saves the switch and the endpoint. The endpoint is checked first, so a bad address writes nothing. Changing the
/// address marks the saved token as belonging to the previous server; it is dropped the next time sharing is on.
pub fn save_config(path: &Path, enabled: bool, endpoint: &str) -> Result<Config, String> {
    let endpoint = endpoint.trim().to_string();
    if !endpoint.is_empty() {
        validate_endpoint(&endpoint)?;
    }
    let mut config = load_config(path);
    let previous = config.endpoint.clone();
    config.enabled = enabled;
    config.endpoint = endpoint;
    let changed = address_changed_of(path)
        || (!previous.trim().is_empty() && !same_server(&previous, &config.endpoint));
    let account = load_account(path);
    write_config_with(
        path,
        &config,
        (!account.is_empty()).then_some(account),
        changed,
    )?;
    Ok(config)
}

/// The name this device joined with, kept beside the switch. It is not a secret, and the presence list shows it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn remember_account(path: &Path, account: &str) -> Result<(), String> {
    write_config_with(
        path,
        &load_config(path),
        Some(account.to_string()),
        address_changed_of(path),
    )
}

/// The joined name, or empty when none was kept.
pub fn load_account(path: &Path) -> String {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|raw| raw["account"].as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Where this device's workspace token lives: the Keychain in the app, a memory double in tests.
pub trait TokenStore {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, token: &str) -> Result<(), String>;
    /// Drops the token. A store that only exists to prove it is never touched can leave this as a no-op.
    fn clear(&self) -> Result<(), String> {
        Ok(())
    }
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
    fn clear(&self) -> Result<(), String> {
        crate::hub_keychain::delete(TOKEN_SERVICE, TOKEN_ACCOUNT).map(|_| ())
    }
}

/// Keeps the token the shared machine issued at accept time, in the store and never in the settings file.
#[cfg_attr(not(test), allow(dead_code))]
pub fn remember_token(store: &dyn TokenStore, token: &str) -> Result<(), String> {
    store.write(token)
}

/// The token and the server address it was issued for, kept together in the store and never in the settings file.
#[derive(Serialize, Deserialize)]
struct StoredToken {
    token: String,
    endpoint: String,
}

/// Keeps the token for the server address it was issued for. The address is stored with the token.
pub fn remember_token_for(
    store: &dyn TokenStore,
    endpoint: &str,
    token: &str,
) -> Result<(), String> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() || token.is_empty() {
        return Err("a token needs the server address it was issued for".into());
    }
    let raw = serde_json::to_string(&StoredToken {
        token: token.to_string(),
        endpoint: endpoint.to_string(),
    })
    .map_err(|e| e.to_string())?;
    store.write(&raw)
}

/// A stored secret: a bound token and its address, or a raw token from before addresses were stored.
fn stored_token(raw: &str) -> (String, Option<String>) {
    if let Ok(stored) = serde_json::from_str::<StoredToken>(raw) {
        if !stored.token.is_empty() && !stored.endpoint.trim().is_empty() {
            return (stored.token, Some(stored.endpoint));
        }
    }
    (raw.to_string(), None)
}

/// The token this device holds, or empty. A store that cannot be read counts as signed out, never as signed in.
#[cfg_attr(not(test), allow(dead_code))]
pub fn recall_token(store: &dyn TokenStore) -> String {
    store
        .read()
        .ok()
        .flatten()
        .map(|raw| stored_token(&raw).0)
        .unwrap_or_default()
}

/// The settings with the device token filled in from the store. While sharing is on, a token for a different address
/// is dropped, so an edited address is not sent the previous server's Bearer token.
pub fn load_signed_in_config(path: &Path, store: &dyn TokenStore) -> Config {
    let mut config = load_config(path);
    config.token = token_for_config(path, store, &config);
    config
}

fn token_for_config(path: &Path, store: &dyn TokenStore, config: &Config) -> String {
    let raw = match store.read() {
        Ok(Some(raw)) if !raw.is_empty() => raw,
        _ => {
            if config.enabled && address_changed_of(path) {
                let _ = write_config_with(path, config, account_of(path), false);
            }
            return String::new();
        }
    };
    let (token, bound) = stored_token(&raw);
    let mismatch = bound
        .as_ref()
        .is_some_and(|endpoint| !same_server(endpoint, &config.endpoint));
    if config.enabled && (address_changed_of(path) || mismatch) {
        let _ = store.clear();
        if address_changed_of(path) {
            let _ = write_config_with(path, config, account_of(path), false);
        }
        return String::new();
    }
    token
}

fn account_of(path: &Path) -> Option<String> {
    let account = load_account(path);
    (!account.is_empty()).then_some(account)
}

/// One local project. Only `shared` projects are ever sent; `payload` is whatever the project holds.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq)]
pub struct LocalProject {
    pub id: String,
    pub shared: bool,
    pub payload: Value,
}

/// The shared projects a member may see on the board. Private projects are never on it, for anyone.
#[cfg_attr(not(test), allow(dead_code))]
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
#[cfg_attr(not(test), allow(dead_code))]
pub struct AgentScope {
    pub account: String,
    pub role: Role,
}

impl AgentScope {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn can_edit(&self) -> bool {
        allowed(self.role, Action::EditProject)
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn agent_for(ws: &Workspace, member_account: &str) -> Result<AgentScope, TeamError> {
    let m = member(ws, member_account).ok_or(TeamError::NotMember)?;
    Ok(AgentScope {
        account: m.account.clone(),
        role: m.role,
    })
}

/// What an agent may read on the board: the shared projects only.
#[cfg_attr(not(test), allow(dead_code))]
pub fn agent_board<'a>(scope: &AgentScope, projects: &'a [LocalProject]) -> Vec<&'a LocalProject> {
    let _ = scope;
    projects.iter().filter(|p| p.shared).collect()
}

/// Endpoint rules: https, and never with credentials in the address. Plain http to this machine is for the loopback
/// stand-in in the tests only; the app itself never sends to a plain http address.
pub fn validate_endpoint(raw: &str) -> Result<Url, String> {
    endpoint_rules(raw, cfg!(test))
}

fn endpoint_rules(raw: &str, loopback_http: bool) -> Result<Url, String> {
    let url =
        Url::parse(raw.trim()).map_err(|e| format!("the endpoint is not a valid address: {e}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the endpoint address must not carry a user name or password".into());
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback_http && is_this_machine(&url) => Ok(url),
        _ => Err("the endpoint must be an https address".into()),
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
#[cfg_attr(not(test), allow(dead_code))]
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

    /// Accepts an invitation and returns this device's workspace token and role. A name that is not a name is refused
    /// before any request, so a bad name never reaches the server and never spends the invitation.
    pub fn accept(&self, invitation: &str, account: &str) -> Result<Grant, String> {
        let account = account.trim();
        check_joined_name(account)?;
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
    #[cfg_attr(not(test), allow(dead_code))]
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
#[cfg_attr(not(test), allow(dead_code))]
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
#[cfg_attr(not(test), allow(dead_code))]
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
#[cfg_attr(not(test), allow(dead_code))]
pub fn sync_on_write(
    path: &Path,
    store: &dyn TokenStore,
    doc: &Value,
) -> Result<SyncOutcome, String> {
    let config = load_config(path);
    if !config.enabled {
        return Ok(SyncOutcome::Disabled);
    }
    let config = load_signed_in_config(path, store);
    sync_outbound(&config, &shared_projects_from_doc(doc))
}

pub const PROJECT_DOC_PREFIX: &str = "project:";
/// The app-store document that holds, per field, what this device last agreed with the server.
pub const SYNC_STATE_KEY: &str = "team-sync";
const CONFLICT_LIMIT: usize = 50;
/// How often a device with the switch on asks the server for other members' changes.
pub const POLL_SECS: u64 = 15;

/// The server revision of one field and the value it had at that revision, as this device last saw it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FieldBase {
    pub rev: u64,
    /// None when the field was absent (or removed) at that revision.
    pub value: Option<Value>,
}

/// Per shared project, per field: what this device last agreed with the server. A local value that differs from its
/// base is an edit not yet synced; a server revision that differs from the base is another member's edit.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SyncState {
    pub projects: BTreeMap<String, BTreeMap<String, FieldBase>>,
    /// Fields where this device's edit replaced another member's edit, as "project.field" (the newest last).
    pub conflicts: Vec<String>,
    /// Shared projects this device had, then deleted. A later pull does not add them back.
    pub removed: BTreeSet<String>,
}

/// The shared machine as the project sync sees it. `Client` is the real one; the tests use the same trait.
pub trait ProjectRemote {
    fn list_projects(&self) -> Result<Vec<String>, String>;
    fn read_fields(&self, doc: &str) -> Result<HashMap<String, (u64, String)>, String>;
    fn write_fields(&self, doc: &str, changes: &[(&str, u64, &str)]) -> Result<FieldWrite, String>;
}

impl ProjectRemote for Client {
    fn list_projects(&self) -> Result<Vec<String>, String> {
        let (status, body) = self.call("GET", "/v1/projects", None)?;
        let body = Self::ok(status, body, "listing the shared projects")?;
        Ok(body["ids"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }
    fn read_fields(&self, doc: &str) -> Result<HashMap<String, (u64, String)>, String> {
        self.get_fields(doc)
    }
    fn write_fields(&self, doc: &str, changes: &[(&str, u64, &str)]) -> Result<FieldWrite, String> {
        self.put_fields(doc, changes)
    }
}

/// What one round did: the project document and sync state to keep, and how many fields moved each way.
#[derive(Debug, Clone, PartialEq)]
pub struct Round {
    pub doc: Value,
    pub state: SyncState,
    pub pushed: usize,
    pub pulled: usize,
}

/// A project id that is safe to put in a document path: lowercase letters, digits, dashes and underscores.
fn safe_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Icon shapes the local hub accepts (`ICON_SHAPES` in the web model). Anything else is not a pulled icon.
const ICON_SHAPES: &[&str] = &[
    "gamepad",
    "sparkles",
    "palette",
    "gauge",
    "folder",
    "code",
    "rocket",
    "chart",
    "briefcase",
    "megaphone",
    "book",
    "heart",
    "globe",
    "bolt",
];

fn name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    let mut len = 1usize;
    for c in chars {
        len += 1;
        if len > 60 {
            return false;
        }
        if !(c.is_ascii_alphanumeric()
            || matches!(c, ' ' | '.' | ',' | '&' | '\'' | '(' | ')' | '+' | '-'))
        {
            return false;
        }
    }
    true
}

fn words_of(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn slug_of(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "project".into()
    } else {
        out
    }
}

fn name_clash(doc: &Value, own_id: &str, name: &str) -> bool {
    let wanted = words_of(name);
    let id = slug_of(name);
    doc["projects"].as_array().is_some_and(|list| {
        list.iter().any(|project| {
            let pid = project["id"].as_str().unwrap_or("");
            pid != own_id
                && (words_of(project["name"].as_str().unwrap_or("")) == wanted || pid == id)
        })
    })
}

fn short_ok(value: &str) -> bool {
    let count = value.chars().count();
    (1..=16).contains(&count) && value.trim() == value
}

fn icon_ok(value: &str) -> bool {
    ICON_SHAPES.contains(&value)
}

/// A pulled field the local hub would keep. `archived` is never taken, so another member cannot archive this copy.
fn pulled_ok(name: &str, value: &Option<Value>, doc: &Value, id: &str) -> bool {
    match name {
        "name" => value
            .as_ref()
            .and_then(|v| v.as_str())
            .is_some_and(|text| name_ok(text) && !name_clash(doc, id, text)),
        "shortName" => value
            .as_ref()
            .and_then(|v| v.as_str())
            .is_some_and(short_ok),
        "iconShape" => value.as_ref().and_then(|v| v.as_str()).is_some_and(icon_ok),
        "archived" => false,
        "status" => value.as_ref().and_then(|v| v.as_str()) == Some("active"),
        _ => true,
    }
}

fn note_conflict(state: &mut SyncState, item: String) {
    if !state.conflicts.contains(&item) {
        state.conflicts.push(item);
    }
    let extra = state.conflicts.len().saturating_sub(CONFLICT_LIMIT);
    state.conflicts.drain(0..extra);
}

/// A field's text as the server keeps it (JSON). "null" is a removed field.
fn parse_body(body: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(body) {
        Ok(Value::Null) => None,
        Ok(value) => Some(value),
        Err(_) => Some(Value::String(body.to_string())),
    }
}

/// The id, the shared flag and the local folder never leave the machine, and a pull never takes them either.
fn synced_field(name: &str) -> bool {
    !matches!(name, "id" | "folder" | "shared")
}

/// The fields a project record syncs. The id, the shared flag and the local folder never leave the machine.
fn record_fields(record: &Value) -> BTreeMap<String, Value> {
    record
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .filter(|(name, value)| synced_field(name) && !value.is_null())
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn record_index(doc: &Value, id: &str) -> Option<usize> {
    doc["projects"]
        .as_array()?
        .iter()
        .position(|p| p["id"].as_str() == Some(id))
}

/// One pass of the project sync, pure so the tests can run it against any `ProjectRemote`.
///
/// Pull: a shared project another member made that this device does not have yet is added. Push and pull per field:
/// - a field only this device changed is pushed on top of the revision it was based on;
/// - a field only another member changed is taken, unless this device has an edit to it that is not synced;
/// - a field both changed keeps this device's value (it is never overwritten by a pulled value), is pushed on top of
///   the server's current revision, and is recorded in `conflicts`.
///
/// Projects not marked shared (including ones that were unshared) are never sent, and an id that is not a plain name
/// is never sent. The local folder path and the shared flag are never sent.
pub fn sync_round(
    remote: &dyn ProjectRemote,
    doc: &Value,
    state: &SyncState,
) -> Result<Round, String> {
    let mut doc = if doc["projects"].is_array() {
        doc.clone()
    } else {
        json!({ "projects": [] })
    };
    let mut state = state.clone();
    let mut pushed = 0;
    let mut pulled = 0;

    let mut have: BTreeSet<String> = doc["projects"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|p| p["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    // A shared project this device had, and no longer has, stays gone. Unshared projects are still in the document.
    let known: Vec<String> = state.projects.keys().cloned().collect();
    for id in known {
        if !have.contains(&id) {
            state.removed.insert(id.clone());
            state.projects.remove(&id);
        }
    }
    for id in &have {
        state.removed.remove(id);
    }
    for id in remote.list_projects()? {
        if !safe_project_id(&id) || have.contains(&id) || state.removed.contains(&id) {
            continue;
        }
        let fields = remote.read_fields(&format!("{PROJECT_DOC_PREFIX}{id}"))?;
        let mut record = json!({ "id": id, "shared": true });
        let mut accepted: Vec<(String, u64, Option<Value>)> = Vec::new();
        let mut name: Option<String> = None;
        let mut bad_icon = false;
        for (field_name, (rev, body)) in fields {
            if !synced_field(&field_name) {
                continue;
            }
            let value = parse_body(&body);
            match field_name.as_str() {
                "name" => {
                    if let Some(text) = value.as_ref().and_then(|v| v.as_str()) {
                        if name_ok(text) {
                            name = Some(text.to_string());
                            accepted.push((field_name, rev, value));
                        }
                    }
                }
                "shortName" => {
                    if value
                        .as_ref()
                        .and_then(|v| v.as_str())
                        .is_some_and(short_ok)
                    {
                        accepted.push((field_name, rev, value));
                    }
                }
                "iconShape" => {
                    if value.as_ref().and_then(|v| v.as_str()).is_some_and(icon_ok) {
                        accepted.push((field_name, rev, value));
                    } else if value.is_some() {
                        bad_icon = true;
                    }
                }
                "archived" => {}
                "status" => {
                    if value.as_ref().and_then(|v| v.as_str()) == Some("active") {
                        accepted.push((field_name, rev, value));
                    }
                }
                _ => accepted.push((field_name, rev, value)),
            }
        }
        let Some(name) = name else { continue };
        if name_clash(&doc, &id, &name) {
            continue;
        }
        for (field_name, _, value) in &accepted {
            if let Some(value) = value {
                record[field_name.as_str()] = value.clone();
            }
        }
        if bad_icon {
            record["iconShape"] = json!("folder");
        }
        let base = state.projects.entry(id.clone()).or_default();
        for (field_name, rev, value) in accepted {
            base.insert(field_name, FieldBase { rev, value });
        }
        if bad_icon {
            base.insert(
                "iconShape".into(),
                FieldBase {
                    rev: 0,
                    value: Some(json!("folder")),
                },
            );
        }
        if let Some(list) = doc["projects"].as_array_mut() {
            list.push(record);
        }
        have.insert(id);
        pulled += 1;
    }

    let local_ids: Vec<String> = doc["projects"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|p| p["shared"].as_bool() == Some(true))
                .filter_map(|p| p["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    for id in local_ids {
        if !safe_project_id(&id) {
            continue;
        }
        let Some(index) = record_index(&doc, &id) else {
            continue;
        };
        let doc_id = format!("{PROJECT_DOC_PREFIX}{id}");
        let mut server = remote.read_fields(&doc_id)?;
        server.retain(|name, _| synced_field(name));
        let local = record_fields(&doc["projects"][index]);
        let base_map = state.projects.get(&id).cloned().unwrap_or_default();
        let names: BTreeSet<String> = local
            .keys()
            .chain(server.keys())
            .chain(base_map.keys())
            .cloned()
            .collect();

        // (name, revision to write on top of, value to send or None for a removal, the server moved on too)
        let mut writes: Vec<(String, u64, Option<Value>, bool)> = Vec::new();
        // (name, value to take, server revision) for fields only another member changed.
        let mut takes: Vec<(String, Option<Value>, u64)> = Vec::new();
        for name in names {
            let mine = local.get(&name).cloned();
            let base = base_map.get(&name).cloned().unwrap_or_default();
            let (server_rev, server_value) = match server.get(&name) {
                Some((rev, body)) => (*rev, parse_body(body)),
                None => (0, None),
            };
            // A field the server has no record of (a new server, or one that lost the project) is not another
            // member's removal: the local value stays and is sent again. Only an explicit removal is taken.
            let on_server = server.contains_key(&name);
            let local_changed = mine != base.value;
            let server_changed = on_server && server_rev != base.rev;
            match (local_changed, server_changed) {
                (false, false) if !on_server && mine.is_some() => {
                    writes.push((name, 0, mine, false))
                }
                (false, false) => {}
                (false, true) => {
                    if pulled_ok(&name, &server_value, &doc, &id) {
                        takes.push((name, server_value, server_rev));
                    } else if name != "archived" && name != "status" {
                        // Keep the local value and send it back, so a bad pull does not stick on the server.
                        writes.push((name, server_rev, mine, true));
                    } else {
                        note_conflict(&mut state, format!("{id}.{name}"));
                    }
                }
                (true, moved) => {
                    let base_rev = if !on_server {
                        0
                    } else if moved {
                        server_rev
                    } else {
                        base.rev
                    };
                    writes.push((name, base_rev, mine, moved && server_value != base.value));
                }
            }
        }

        for (name, value, rev) in takes {
            match &value {
                Some(value) => doc["projects"][index][name.as_str()] = value.clone(),
                None => {
                    if let Some(fields) = doc["projects"][index].as_object_mut() {
                        fields.remove(&name);
                    }
                }
            }
            state
                .projects
                .entry(id.clone())
                .or_default()
                .insert(name, FieldBase { rev, value });
            pulled += 1;
        }

        if writes.is_empty() {
            continue;
        }
        let body_of =
            |value: &Option<Value>| value.as_ref().map_or("null".to_string(), Value::to_string);
        let first: Vec<(String, u64, String)> = writes
            .iter()
            .map(|(name, rev, value, _)| (name.clone(), *rev, body_of(value)))
            .collect();
        let refs: Vec<(&str, u64, &str)> = first
            .iter()
            .map(|(n, r, b)| (n.as_str(), *r, b.as_str()))
            .collect();
        let mut result = remote.write_fields(&doc_id, &refs)?;

        // A field that moved on the server since it was read gets one more try on top of the server's revision. The
        // local value wins, and the replaced edit is recorded.
        let retry: Vec<(String, u64, String)> = first
            .iter()
            .filter_map(|(name, _, body)| {
                result
                    .conflicts
                    .get(name)
                    .map(|current| (name.clone(), *current, body.clone()))
            })
            .collect();
        if !retry.is_empty() {
            let refs: Vec<(&str, u64, &str)> = retry
                .iter()
                .map(|(n, r, b)| (n.as_str(), *r, b.as_str()))
                .collect();
            let second = remote.write_fields(&doc_id, &refs)?;
            result.written.extend(second.written);
            result.conflicts = second.conflicts;
        }

        let mut replaced: Vec<String> = writes
            .iter()
            .filter(|(_, _, _, moved)| *moved)
            .map(|(name, _, _, _)| format!("{id}.{name}"))
            .collect();
        replaced.extend(retry.iter().map(|(name, _, _)| format!("{id}.{name}")));
        let entry = state.projects.entry(id.clone()).or_default();
        for (name, rev) in &result.written {
            let value = writes
                .iter()
                .find(|(n, _, _, _)| n == name)
                .and_then(|(_, _, value, _)| value.clone());
            entry.insert(name.clone(), FieldBase { rev: *rev, value });
            pushed += 1;
        }
        for item in replaced {
            note_conflict(&mut state, item);
        }
    }

    Ok(Round {
        doc,
        state,
        pushed,
        pulled,
    })
}

/// What a round wrote back. `projects_rev` is set only when the projects document itself was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kept {
    pub projects_rev: Option<i64>,
    pub state_written: bool,
}

/// Writes a round into the local store. The projects document is written only when the round changed it, and only if
/// it is still at `rev`. The sync state is written whenever the round changed it, including when the projects write
/// was refused.
pub fn keep_round(
    conn: &rusqlite::Connection,
    doc: &Value,
    rev: i64,
    state: &SyncState,
    round: &Round,
) -> Result<Kept, String> {
    let doc_changed = &round.doc != doc;
    let state_changed = &round.state != state;
    if !doc_changed && !state_changed {
        return Ok(Kept {
            projects_rev: None,
            state_written: false,
        });
    }
    let projects_rev = if doc_changed {
        crate::local_hub::write_if(conn, "projects", &round.doc, Some(rev))?
    } else {
        None
    };
    let state_written = if state_changed {
        let state_json = serde_json::to_value(&round.state).map_err(|e| e.to_string())?;
        crate::local_hub::write_if(conn, SYNC_STATE_KEY, &state_json, None)?.is_some()
    } else {
        false
    };
    Ok(Kept {
        projects_rev,
        state_written,
    })
}

/// One round against the configured server, for the stored `projects` document. Does nothing, and reads no token, while
/// the switch is off. The document is written only if it has not changed since it was read; otherwise the next round
/// tries again. The shared machine is never called while the store's lock is held.
pub fn run_round<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let path = config_path(app)?;
    if !load_config(&path).enabled {
        return Ok(());
    }
    let config = load_signed_in_config(&path, &Keychain);
    let Some(client) = Client::from_config(&config)? else {
        return Ok(());
    };
    if config.token.is_empty() {
        return Ok(());
    }
    let account = load_account(&path);
    if !account.is_empty() {
        client.heartbeat(&account)?;
    }
    if let Ok(people) = client.presence() {
        if let Ok(mut shown) = PRESENCE.lock() {
            *shown = people;
        }
    }

    let store = app.state::<crate::session_store::SessionStore>();
    let (doc, rev, stored_state) = {
        let conn = store.lock_conn()?;
        let current = crate::local_hub::read_doc(&conn, "projects")?;
        let state = crate::local_hub::read_doc(&conn, SYNC_STATE_KEY)?;
        (
            current.value.unwrap_or_else(|| json!({ "projects": [] })),
            current.rev,
            state.value,
        )
    };
    let state: SyncState = stored_state
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let round = sync_round(&client, &doc, &state)?;
    let kept = {
        let conn = store.lock_conn()?;
        keep_round(&conn, &doc, rev, &state, &round)?
    };
    if let Some(new_rev) = kept.projects_rev {
        if round.pulled > 0 {
            let _ = app.emit(
                crate::local_hub::CHANGED_EVENT,
                json!({ "key": "projects", "rev": new_rev }),
            );
        }
    }
    Ok(())
}

/// Called after the app keeps a new `projects` document: runs a round on a worker thread. A failure is logged only; the
/// local store stays the source of truth and the next round tries again.
pub fn sync_after_change<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(reason) = run_round(&app) {
            eprintln!("team workspace: the change did not sync: {reason}");
        }
    });
}

/// Runs a round every `POLL_SECS`, so another member's change arrives without a restart. Off costs one file read.
pub fn start_polling<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(POLL_SECS));
        if let Err(reason) = run_round(&app) {
            eprintln!("team workspace: a sync round did not finish: {reason}");
        }
    });
}

/// The people checked in at the shared machine, as of the last round. Empty while the switch is off.
static PRESENCE: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[tauri::command]
pub fn team_workspace_presence() -> Vec<String> {
    PRESENCE
        .lock()
        .map(|people| people.clone())
        .unwrap_or_default()
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
    /// Fields where this device kept its own copy, as "project.field". Empty when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
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
        conflicts: Vec::new(),
    }
}

fn conflict_label(item: &str) -> bool {
    let mut parts = item.split('.');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(id), Some(field), None) => {
            safe_project_id(id)
                && !field.is_empty()
                && field.len() <= 32
                && field.chars().all(|c| c.is_ascii_alphanumeric())
        }
        _ => false,
    }
}

fn conflicts_in(value: &Value) -> Vec<String> {
    value
        .get("conflicts")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str())
                .filter(|item| conflict_label(item))
                .take(CONFLICT_LIMIT)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn read_conflicts<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    let Some(store) = app.try_state::<crate::session_store::SessionStore>() else {
        return Vec::new();
    };
    let Ok(conn) = store.lock_conn() else {
        return Vec::new();
    };
    let Ok(doc) = crate::local_hub::read_doc(&conn, SYNC_STATE_KEY) else {
        return Vec::new();
    };
    doc.value.as_ref().map(conflicts_in).unwrap_or_default()
}

fn config_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(CONFIG_FILE))
}

/// The status for the settings screen. With the switch off the token store is not read, so opening Settings never
/// touches the Keychain for a feature that is off.
pub fn status_at(path: &Path, store: &dyn TokenStore) -> Status {
    let config = load_config(path);
    if !config.enabled {
        return status_for(&config);
    }
    status_for(&load_signed_in_config(path, store))
}

#[tauri::command]
pub fn team_workspace_status(app: tauri::AppHandle) -> Result<Status, String> {
    let mut status = status_at(&config_path(&app)?, &Keychain);
    status.conflicts = read_conflicts(&app);
    Ok(status)
}

/// Saves the switch and endpoint that Ash sets in Settings. Off writes no network call.
#[tauri::command]
pub fn team_workspace_save(
    app: tauri::AppHandle,
    enabled: bool,
    endpoint: String,
) -> Result<Status, String> {
    let path = config_path(&app)?;
    save_config(&path, enabled, &endpoint)?;
    // The saved file plus, only while on, whether this device holds a token: a joined device stays joined on screen.
    Ok(status_at(&path, &Keychain))
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
    remember_token_for(&Keychain, &config.endpoint, &grant.token)?;
    let fresh = load_config(&path);
    write_config_with(&path, &fresh, Some(account.trim().to_string()), false)?;
    Ok(status_for(&load_signed_in_config(&path, &Keychain)))
}
