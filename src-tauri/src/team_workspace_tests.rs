//! WP-80 tests. Loopback stand-ins only: no test reaches a real host, and no test needs an account.
//! The stand-in server below is the fixture contract for the shared machine. The real server is not built.

use super::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const NOW: u64 = 1_800_000_000;

fn join(ws: &mut Workspace, actor: &str, role: Role, account: &str) {
    let token = create_invitation(ws, actor, role, NOW).expect("invite");
    accept_invitation(ws, &token, account, NOW).expect("accept");
}

fn member_role(ws: &Workspace, account: &str) -> Option<Role> {
    ws.members
        .iter()
        .find(|m| m.account == account)
        .map(|m| m.role)
}

fn team() -> Workspace {
    let mut ws = new_workspace("ws-1", "owner");
    join(&mut ws, "owner", Role::Admin, "admin");
    join(&mut ws, "owner", Role::Member, "member");
    join(&mut ws, "owner", Role::Guest, "guest");
    ws
}

// --- roles -----------------------------------------------------------------------------------

#[test]
fn guest_reads_the_board_but_cannot_edit_or_invite() {
    let ws = team();
    assert!(authorize(&ws, "guest", Action::ReadBoard).is_ok());
    assert_eq!(
        authorize(&ws, "guest", Action::EditProject),
        Err(TeamError::Forbidden)
    );
    assert_eq!(
        authorize(&ws, "guest", Action::Invite),
        Err(TeamError::Forbidden)
    );
}

#[test]
fn member_edits_but_cannot_invite_or_manage_members() {
    let ws = team();
    assert!(authorize(&ws, "member", Action::EditProject).is_ok());
    assert_eq!(
        authorize(&ws, "member", Action::Invite),
        Err(TeamError::Forbidden)
    );
    assert_eq!(
        authorize(&ws, "member", Action::ManageMembers),
        Err(TeamError::Forbidden)
    );
}

#[test]
fn only_the_owner_deletes_the_workspace() {
    let ws = team();
    assert!(authorize(&ws, "owner", Action::DeleteWorkspace).is_ok());
    assert_eq!(
        authorize(&ws, "admin", Action::DeleteWorkspace),
        Err(TeamError::Forbidden)
    );
}

#[test]
fn someone_who_is_not_a_member_can_do_nothing() {
    let ws = team();
    assert_eq!(
        authorize(&ws, "stranger", Action::ReadBoard),
        Err(TeamError::NotMember)
    );
}

#[test]
fn an_admin_invites_members_and_guests_but_never_an_admin_or_owner() {
    let mut ws = team();
    assert!(create_invitation(&mut ws, "admin", Role::Member, NOW).is_ok());
    assert!(create_invitation(&mut ws, "admin", Role::Guest, NOW).is_ok());
    assert_eq!(
        create_invitation(&mut ws, "admin", Role::Admin, NOW),
        Err(TeamError::Forbidden)
    );
    assert_eq!(
        create_invitation(&mut ws, "admin", Role::Owner, NOW),
        Err(TeamError::Forbidden)
    );
}

#[test]
fn the_owner_invites_admins_but_never_another_owner() {
    let mut ws = team();
    assert!(create_invitation(&mut ws, "owner", Role::Admin, NOW).is_ok());
    assert_eq!(
        create_invitation(&mut ws, "owner", Role::Owner, NOW),
        Err(TeamError::Forbidden)
    );
}

#[test]
fn an_admin_cannot_remove_or_demote_an_admin_or_the_owner() {
    let mut ws = team();
    join(&mut ws, "owner", Role::Admin, "admin2");
    assert_eq!(
        remove_member(&mut ws, "admin", "admin2"),
        Err(TeamError::Forbidden)
    );
    assert_eq!(
        remove_member(&mut ws, "admin", "owner"),
        Err(TeamError::Forbidden)
    );
    assert_eq!(
        set_role(&mut ws, "admin", "admin2", Role::Guest),
        Err(TeamError::Forbidden)
    );
}

#[test]
fn an_admin_can_remove_a_member_and_the_owner_can_demote_an_admin() {
    let mut ws = team();
    // The admin removes first; demoting the admin would take away the power to remove anyone.
    assert!(remove_member(&mut ws, "admin", "member").is_ok());
    assert!(set_role(&mut ws, "owner", "admin", Role::Member).is_ok());
    assert!(remove_member(&mut ws, "owner", "guest").is_ok());
    assert!(!ws
        .members
        .iter()
        .any(|m| m.account == "guest" || m.account == "member"));
    assert_eq!(member_role(&ws, "admin"), Some(Role::Member));
}

#[test]
fn nobody_can_make_someone_the_owner_or_remove_the_owner() {
    let mut ws = team();
    assert_eq!(
        set_role(&mut ws, "owner", "admin", Role::Owner),
        Err(TeamError::Forbidden)
    );
    assert_eq!(
        remove_member(&mut ws, "owner", "owner"),
        Err(TeamError::Forbidden)
    );
}

// --- invitations -----------------------------------------------------------------------------

#[test]
fn an_invitation_works_once() {
    let mut ws = team();
    let token = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    assert_eq!(
        accept_invitation(&mut ws, &token, "newcomer", NOW),
        Ok(Role::Member)
    );
    assert_eq!(
        accept_invitation(&mut ws, &token, "second", NOW),
        Err(TeamError::InvalidInvitation)
    );
}

#[test]
fn an_expired_or_unknown_invitation_is_refused() {
    let mut ws = team();
    let token = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let late = NOW + INVITE_TTL_SECS;
    assert_eq!(
        accept_invitation(&mut ws, &token, "late", late),
        Err(TeamError::InvalidInvitation)
    );
    assert_eq!(
        accept_invitation(&mut ws, "not-a-real-token", "guess", NOW),
        Err(TeamError::InvalidInvitation)
    );
}

#[test]
fn an_existing_member_using_a_link_does_not_spend_it() {
    let mut ws = team();
    let token = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    assert_eq!(
        accept_invitation(&mut ws, &token, "member", NOW),
        Err(TeamError::AlreadyMember)
    );
    assert_eq!(
        accept_invitation(&mut ws, &token, "newcomer", NOW),
        Ok(Role::Member)
    );
}

#[test]
fn the_token_is_never_stored_only_its_hash() {
    let mut ws = new_workspace("ws-2", "owner");
    let token = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let stored = serde_json::to_string(&ws).unwrap();
    assert!(
        !stored.contains(&token),
        "raw invitation token leaked into storage"
    );
    assert!(stored.contains(&hash_token(&token)));
}

// --- config, the off switch and saving ------------------------------------------------------

#[test]
fn the_default_config_is_off_with_no_endpoint_and_no_token() {
    let config = Config::default();
    assert!(!config.enabled);
    assert!(config.endpoint.is_empty());
    assert!(config.token.is_empty());
}

#[test]
fn a_missing_config_file_loads_as_off() {
    let dir = std::env::temp_dir().join(format!("tw-missing-{}", uuid::Uuid::new_v4()));
    assert_eq!(
        load_config(&dir.join("team-workspace.json")),
        Config::default()
    );
}

#[derive(Default)]
struct MemoryStore(std::cell::RefCell<Option<String>>);

impl TokenStore for MemoryStore {
    fn read(&self) -> Result<Option<String>, String> {
        Ok(self.0.borrow().clone())
    }
    fn write(&self, token: &str) -> Result<(), String> {
        *self.0.borrow_mut() = Some(token.to_string());
        Ok(())
    }
}

#[test]
fn saving_the_switch_and_endpoint_keeps_the_token_in_the_store_not_the_file() {
    let dir = std::env::temp_dir().join(format!("tw-save-{}", uuid::Uuid::new_v4()));
    let path = dir.join(CONFIG_FILE);
    let store = MemoryStore::default();
    remember_token(&store, "secret-token").unwrap();
    save_config(&path, true, "https://sync.example.test/v1").unwrap();
    save_config(&path, false, "http://127.0.0.1:4010").unwrap();

    let on_disk = std::fs::read_to_string(&path).unwrap();
    assert!(
        !on_disk.contains("secret-token"),
        "the token reached the settings file"
    );

    let loaded = load_signed_in_config(&path, &store);
    assert!(!loaded.enabled);
    assert_eq!(loaded.endpoint, "http://127.0.0.1:4010");
    assert_eq!(loaded.token, "secret-token");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_store_that_cannot_be_read_counts_as_signed_out() {
    struct Broken;
    impl TokenStore for Broken {
        fn read(&self) -> Result<Option<String>, String> {
            Err("locked".into())
        }
        fn write(&self, _: &str) -> Result<(), String> {
            Err("locked".into())
        }
    }
    assert_eq!(recall_token(&Broken), "");
    assert!(remember_token(&Broken, "t").is_err());
}

#[test]
fn saving_refuses_a_bad_endpoint_and_writes_nothing() {
    let dir = std::env::temp_dir().join(format!("tw-bad-{}", uuid::Uuid::new_v4()));
    let path = dir.join(CONFIG_FILE);
    assert!(save_config(&path, true, "http://sync.example.test").is_err());
    assert!(!path.exists());
}

#[test]
fn a_config_that_only_says_enabled_makes_no_call() {
    let config: Config = serde_json::from_str(r#"{"enabled": true}"#).unwrap();
    assert_eq!(
        sync_outbound(&config, &projects()).unwrap(),
        SyncOutcome::NoEndpoint
    );
}

#[test]
fn disabled_or_endpoint_empty_opens_no_connection_at_all() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let endpoint = format!("http://{addr}");

    let off = Config {
        enabled: false,
        endpoint: endpoint.clone(),
        token: "t".into(),
    };
    assert_eq!(
        sync_outbound(&off, &projects()).unwrap(),
        SyncOutcome::Disabled
    );

    let no_endpoint = Config {
        enabled: true,
        endpoint: "   ".into(),
        token: "t".into(),
    };
    assert_eq!(
        sync_outbound(&no_endpoint, &projects()).unwrap(),
        SyncOutcome::NoEndpoint
    );

    assert_no_connection(&listener);
}

#[test]
fn sync_without_a_signed_in_token_makes_no_call() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let config = Config {
        enabled: true,
        endpoint: format!("http://{addr}"),
        token: String::new(),
    };
    assert!(sync_outbound(&config, &projects()).is_err());
    assert_no_connection(&listener);
}

fn assert_no_connection(listener: &TcpListener) {
    match listener.accept() {
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
        other => panic!("something connected while it should not: {other:?}"),
    }
}

// --- endpoint rules --------------------------------------------------------------------------

#[test]
fn an_endpoint_must_be_https_unless_it_is_this_machine() {
    assert!(validate_endpoint("https://sync.example.test/v1").is_ok());
    assert!(validate_endpoint("http://127.0.0.1:4010").is_ok());
    assert!(validate_endpoint("http://localhost:4010").is_ok());
    assert!(validate_endpoint("http://[::1]:4010").is_ok());
    assert!(validate_endpoint("http://sync.example.test/v1").is_err());
    assert!(validate_endpoint("ftp://127.0.0.1/x").is_err());
    assert!(validate_endpoint("not a url").is_err());
}

#[test]
fn an_endpoint_never_carries_credentials() {
    assert!(validate_endpoint("https://user:secret@sync.example.test/v1").is_err());
    assert!(validate_endpoint("https://user@sync.example.test/v1").is_err());
}

#[test]
fn a_refused_endpoint_is_never_called() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let config = Config {
        enabled: true,
        endpoint: "http://sync.example.test/v1".into(),
        token: "t".into(),
    };
    assert!(sync_outbound(&config, &projects()).is_err());
    assert_no_connection(&listener);
}

// --- the loopback stand-in for the shared machine ---------------------------------------------

/// The fixture: a shared machine that enforces the same rules as the module, on loopback only.
struct Server {
    ws: Workspace,
    sessions: HashMap<String, String>,
    docs: HashMap<String, HashMap<String, (u64, String)>>,
    presence: HashMap<String, u64>,
    synced: Vec<Value>,
    /// Ids of shared projects: every `project:<id>` document that has been written.
    projects: std::collections::BTreeSet<String>,
}

impl Server {
    fn new(ws: Workspace) -> Self {
        Server {
            ws,
            sessions: HashMap::new(),
            docs: HashMap::new(),
            presence: HashMap::new(),
            synced: Vec::new(),
            projects: Default::default(),
        }
    }
}

struct Req {
    method: String,
    path: String,
    auth: Option<String>,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Req> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut len = 0usize;
    let mut auth = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            len = v.trim().parse().ok()?;
        }
        if lower.starts_with("authorization:") {
            auth = Some(trimmed["authorization:".len()..].trim().to_string());
        }
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).ok()?;
    Some(Req {
        method,
        path,
        auth,
        body: String::from_utf8(buf).ok()?,
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Bad Request",
    }
}

fn route(req: &Req, s: &mut Server) -> (u16, Value) {
    let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
    if req.method == "POST" && req.path == "/v1/accept" {
        let token = body["token"].as_str().unwrap_or_default();
        let account = body["account"].as_str().unwrap_or_default();
        return match accept_invitation(&mut s.ws, token, account, NOW) {
            Ok(role) => {
                let bearer = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                s.sessions.insert(hash_token(&bearer), account.to_string());
                (200, json!({ "token": bearer, "role": role }))
            }
            Err(_) => (403, json!({ "error": "invalid invitation" })),
        };
    }
    let account = match req
        .auth
        .as_deref()
        .and_then(|a| a.strip_prefix("Bearer "))
        .and_then(|t| s.sessions.get(&hash_token(t)))
    {
        Some(a) => a.clone(),
        None => return (401, json!({ "error": "unauthenticated" })),
    };
    let role = match member_role(&s.ws, &account) {
        Some(r) => r,
        None => return (403, json!({ "error": "no longer a member" })),
    };
    let doc_id = req.path.strip_prefix("/v1/docs/").map(str::to_string);
    match (req.method.as_str(), req.path.as_str(), doc_id) {
        ("POST", "/v1/sync", _) => {
            if !allowed(role, Action::EditProject) {
                return (403, json!({ "error": "role cannot push" }));
            }
            s.synced.push(body);
            (200, json!({ "ok": true }))
        }
        ("POST", "/v1/presence", _) => {
            s.presence.insert(account, NOW);
            (200, json!({ "ok": true }))
        }
        ("GET", "/v1/presence", _) => {
            let mut accounts: Vec<&String> = s.presence.keys().collect();
            accounts.sort();
            (200, json!({ "accounts": accounts }))
        }
        ("GET", "/v1/projects", _) => {
            let ids: Vec<&String> = s.projects.iter().collect();
            (200, json!({ "ids": ids }))
        }
        ("GET", _, Some(id)) => {
            let fields = s.docs.get(&id).cloned().unwrap_or_default();
            let out: serde_json::Map<String, Value> = fields
                .into_iter()
                .map(|(name, (rev, text))| (name, json!({ "rev": rev, "body": text })))
                .collect();
            (200, json!({ "fields": out }))
        }
        ("PUT", _, Some(id)) => {
            if !allowed(role, Action::EditProject) {
                return (403, json!({ "error": "role cannot edit" }));
            }
            let Some(incoming) = body["fields"].as_object() else {
                return (400, json!({ "error": "no fields" }));
            };
            if let Some(project) = id.strip_prefix("project:") {
                s.projects.insert(project.to_string());
            }
            let doc = s.docs.entry(id).or_default();
            let mut written = serde_json::Map::new();
            let mut conflicts = serde_json::Map::new();
            for (name, change) in incoming {
                let current = doc.get(name).map(|f| f.0).unwrap_or(0);
                if change["ifRev"].as_u64() == Some(current) {
                    let text = change["body"].as_str().unwrap_or_default().to_string();
                    doc.insert(name.clone(), (current + 1, text));
                    written.insert(name.clone(), json!(current + 1));
                } else {
                    conflicts.insert(name.clone(), json!(current));
                }
            }
            (200, json!({ "written": written, "conflicts": conflicts }))
        }
        _ => (404, json!({})),
    }
}

/// Starts the stand-in on loopback and returns its base address. The thread lives until the test process exits.
fn serve(server: Arc<Mutex<Server>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let server = server.clone();
            std::thread::spawn(move || {
                let Some(req) = read_request(&mut stream) else {
                    return;
                };
                let (status, reply) = {
                    let mut guard = server.lock().unwrap();
                    route(&req, &mut guard)
                };
                let payload = reply.to_string();
                let head = format!(
                    "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reason(status),
                    payload.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(payload.as_bytes());
            });
        }
    });
    format!("http://{addr}")
}

fn client_for(endpoint: &str, token: &str) -> Client {
    let config = Config {
        enabled: true,
        endpoint: endpoint.into(),
        token: token.into(),
    };
    Client::from_config(&config)
        .unwrap()
        .expect("active client")
}

#[test]
fn the_stand_in_refuses_a_payload_with_no_token() {
    let server = Arc::new(Mutex::new(Server::new(team())));
    let endpoint = serve(server.clone());
    let client = client_for(&endpoint, "");
    assert!(client.push_projects(&projects()).is_err());
    assert!(server.lock().unwrap().synced.is_empty());
}

#[test]
fn an_invitation_is_accepted_for_a_token_and_the_link_is_spent() {
    let mut ws = team();
    let invite = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let server = Arc::new(Mutex::new(Server::new(ws)));
    let endpoint = serve(server);
    let client = client_for(&endpoint, "");
    let grant = client.accept(&invite, "newcomer").unwrap();
    assert_eq!(grant.role, Role::Member);
    assert!(grant.token.len() >= 64);
    assert!(client.accept(&invite, "second").is_err());
}

#[test]
fn a_guest_cannot_push_or_edit_through_the_stand_in() {
    let mut ws = team();
    let invite = create_invitation(&mut ws, "owner", Role::Guest, NOW).unwrap();
    let server = Arc::new(Mutex::new(Server::new(ws)));
    let endpoint = serve(server.clone());
    let grant = client_for(&endpoint, "")
        .accept(&invite, "visitor")
        .unwrap();
    let client = client_for(&endpoint, &grant.token);
    assert!(client.push_projects(&projects()).is_err());
    assert!(client.put_fields("plan", &[("title", 0, "hello")]).is_err());
    assert!(server.lock().unwrap().synced.is_empty());
}

#[test]
fn two_clients_editing_different_fields_at_once_both_survive() {
    let mut ws = team();
    let invite_a = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let invite_b = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let server = Arc::new(Mutex::new(Server::new(ws)));
    let endpoint = serve(server);
    let a = client_for(
        &endpoint,
        &client_for(&endpoint, "")
            .accept(&invite_a, "ann")
            .unwrap()
            .token,
    );
    let b = client_for(
        &endpoint,
        &client_for(&endpoint, "")
            .accept(&invite_b, "ben")
            .unwrap()
            .token,
    );

    // Both saw revision 0 of every field, then both write at once.
    let ann = a
        .put_fields("task-7", &[("title", 0, "Ship the pilot")])
        .unwrap();
    let ben = b
        .put_fields("task-7", &[("body", 0, "Needs the stand-in first")])
        .unwrap();
    assert_eq!(ann.conflicts.len(), 0);
    assert_eq!(ben.conflicts.len(), 0);

    let fields = a.get_fields("task-7").unwrap();
    assert_eq!(fields["title"].1, "Ship the pilot");
    assert_eq!(fields["body"].1, "Needs the stand-in first");
}

#[test]
fn two_clients_editing_the_same_field_do_not_lose_either_write() {
    let mut ws = team();
    let invite_a = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let invite_b = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let server = Arc::new(Mutex::new(Server::new(ws)));
    let endpoint = serve(server);
    let a = client_for(
        &endpoint,
        &client_for(&endpoint, "")
            .accept(&invite_a, "ann")
            .unwrap()
            .token,
    );
    let b = client_for(
        &endpoint,
        &client_for(&endpoint, "")
            .accept(&invite_b, "ben")
            .unwrap()
            .token,
    );

    a.put_fields("task-7", &[("title", 0, "Ann's title")])
        .unwrap();
    // Ben saw revision 0 before Ann wrote: his write is reported, not stored over hers.
    let stale = b
        .put_fields("task-7", &[("title", 0, "Ben's title")])
        .unwrap();
    assert_eq!(stale.conflicts.get("title"), Some(&1));
    assert!(stale.written.is_empty());
    assert_eq!(b.get_fields("task-7").unwrap()["title"].1, "Ann's title");

    // Ben retries from the revision he now sees, and his write lands as revision 2.
    let retry = b
        .put_fields("task-7", &[("title", 1, "Ben's title, after Ann")])
        .unwrap();
    assert_eq!(retry.written.get("title"), Some(&2));
}

#[test]
fn presence_shows_who_checked_in_to_everyone_on_the_board() {
    let mut ws = team();
    let invite_a = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let invite_g = create_invitation(&mut ws, "owner", Role::Guest, NOW).unwrap();
    let server = Arc::new(Mutex::new(Server::new(ws)));
    let endpoint = serve(server);
    let a = client_for(
        &endpoint,
        &client_for(&endpoint, "")
            .accept(&invite_a, "ann")
            .unwrap()
            .token,
    );
    let g = client_for(
        &endpoint,
        &client_for(&endpoint, "")
            .accept(&invite_g, "gus")
            .unwrap()
            .token,
    );
    a.heartbeat("ann").unwrap();
    assert_eq!(g.presence().unwrap(), vec!["ann".to_string()]);
}

#[test]
fn only_shared_projects_are_pushed_through_the_client() {
    let mut ws = team();
    let invite = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let server = Arc::new(Mutex::new(Server::new(ws)));
    let endpoint = serve(server.clone());
    let grant = client_for(&endpoint, "").accept(&invite, "ann").unwrap();
    let config = Config {
        enabled: true,
        endpoint: endpoint.clone(),
        token: grant.token,
    };
    assert_eq!(
        sync_outbound(&config, &projects()).unwrap(),
        SyncOutcome::Sent { projects: 1 }
    );

    let guard = server.lock().unwrap();
    let body = guard.synced[0].to_string();
    assert!(
        body.contains("ship the pilot"),
        "shared project missing: {body}"
    );
    assert!(
        !body.contains("PRIVATE-SECRET-TEXT"),
        "private project body left the machine"
    );
    assert!(
        !body.contains("private-1"),
        "private project id left the machine"
    );
}

#[test]
fn a_redirect_from_the_endpoint_is_never_followed() {
    let elsewhere = TcpListener::bind("127.0.0.1:0").unwrap();
    elsewhere.set_nonblocking(true).unwrap();
    let target = format!("http://{}/collect", elsewhere.local_addr().unwrap());

    let front = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = front.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = front.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
        }
        let reply = format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(reply.as_bytes()).unwrap();
    });

    let config = Config {
        enabled: true,
        endpoint: format!("http://{addr}"),
        token: "t".into(),
    };
    assert!(sync_outbound(&config, &projects()).is_err());
    server.join().unwrap();
    assert_no_connection(&elsewhere);
}

// --- agents scoped to the shared board ------------------------------------------------------

#[test]
fn an_agent_sees_only_the_shared_board_of_the_member_it_acts_for() {
    let ws = team();
    let scope = agent_for(&ws, "member").unwrap();
    let all = projects();
    let board = agent_board(&scope, &all);
    assert_eq!(
        board.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        vec!["shared-1"]
    );
    assert!(scope.can_edit());
}

#[test]
fn an_agent_for_a_guest_reads_but_cannot_edit() {
    let ws = team();
    let scope = agent_for(&ws, "guest").unwrap();
    let all = projects();
    assert_eq!(agent_board(&scope, &all).len(), 1);
    assert!(!scope.can_edit());
}

#[test]
fn an_agent_with_no_membership_gets_nothing() {
    let ws = team();
    assert_eq!(agent_for(&ws, "stranger").err(), Some(TeamError::NotMember));
}

// --- projects and the board -------------------------------------------------------------------

fn projects() -> Vec<LocalProject> {
    vec![
        LocalProject {
            id: "shared-1".into(),
            shared: true,
            payload: json!({"name": "Shared board", "tasks": ["ship the pilot"]}),
        },
        LocalProject {
            id: "private-1".into(),
            shared: false,
            payload: json!({"name": "Private", "secret": "PRIVATE-SECRET-TEXT"}),
        },
    ]
}

#[test]
fn the_board_shows_a_member_only_shared_projects() {
    let ws = team();
    let all = projects();
    let board = shared_board(&ws, "guest", &all).unwrap();
    assert_eq!(
        board.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        vec!["shared-1"]
    );
    assert_eq!(
        shared_board(&ws, "stranger", &all),
        Err(TeamError::NotMember)
    );
}

#[test]
fn status_is_off_and_says_so_by_default() {
    let status = status_for(&Config::default());
    assert!(!status.enabled);
    assert!(!status.endpoint_configured);
    assert!(!status.signed_in);
    assert!(!status.active);
}

#[test]
fn status_is_active_only_when_on_with_a_valid_endpoint_and_a_token() {
    let on_no_endpoint = status_for(&Config {
        enabled: true,
        endpoint: String::new(),
        token: "t".into(),
    });
    assert!(on_no_endpoint.enabled && !on_no_endpoint.active);

    let on_bad = status_for(&Config {
        enabled: true,
        endpoint: "http://sync.example.test".into(),
        token: "t".into(),
    });
    assert!(on_bad.endpoint_configured && !on_bad.active);

    let no_token = status_for(&Config {
        enabled: true,
        endpoint: "https://sync.example.test/v1".into(),
        token: String::new(),
    });
    assert!(!no_token.signed_in && !no_token.active);

    let on_good = status_for(&Config {
        enabled: true,
        endpoint: "https://sync.example.test/v1".into(),
        token: "t".into(),
    });
    assert!(on_good.enabled && on_good.endpoint_configured && on_good.signed_in && on_good.active);
}

// --- store wiring: the app's own project document goes out when the switch is on ---------------

fn stored_projects() -> Value {
    json!({ "projects": [
        { "id": "shared-1", "name": "Shared board", "shared": true, "folder": "/opt/local-only/projects/shared-1",
          "shortName": "Shared", "iconShape": "folder", "tasks": ["ship the pilot"] },
        { "id": "private-1", "name": "Private", "shared": false, "folder": "/opt/local-only/projects/private-1",
          "secret": "PRIVATE-SECRET-TEXT" },
        { "id": "unmarked", "name": "No flag at all", "secret": "PRIVATE-SECRET-TEXT" },
    ]})
}

#[test]
fn only_shared_projects_from_the_stored_document_are_kept_and_the_local_folder_is_stripped() {
    let shared = shared_projects_from_doc(&stored_projects());
    assert_eq!(shared.len(), 1);
    assert_eq!(shared[0].id, "shared-1");
    let body = shared[0].payload.to_string();
    assert!(body.contains("ship the pilot"));
    assert!(
        !body.contains("/opt/local-only"),
        "a local folder path left the machine: {body}"
    );
    // The keys are gone; the value "folder" in iconShape is the project's own and stays.
    assert!(!body.contains("\"folder\":"));
    assert!(!body.contains("\"shared\":"));
}

#[test]
fn a_document_with_nothing_shared_or_no_projects_sends_nothing() {
    assert!(shared_projects_from_doc(&json!({ "projects": [] })).is_empty());
    assert!(shared_projects_from_doc(&json!({})).is_empty());
    assert!(shared_projects_from_doc(&Value::Null).is_empty());
}

/// A token store that fails the test if anything reads it: when the switch is off, the Keychain is never touched.
struct NeverRead;
impl TokenStore for NeverRead {
    fn read(&self) -> Result<Option<String>, String> {
        panic!("the token store was read while team workspaces are off");
    }
    fn write(&self, _: &str) -> Result<(), String> {
        panic!("the token store was written while team workspaces are off");
    }
}

#[test]
fn a_change_with_the_switch_off_reads_no_token_and_opens_no_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let dir = std::env::temp_dir().join(format!("tw-wire-off-{}", Uuid::new_v4()));
    let path = dir.join(CONFIG_FILE);
    // The address is saved, but the switch is off: nothing is read or sent.
    save_config(
        &path,
        false,
        &format!("http://{}", listener.local_addr().unwrap()),
    )
    .unwrap();
    assert_eq!(
        sync_on_write(&path, &NeverRead, &stored_projects()).unwrap(),
        SyncOutcome::Disabled
    );
    assert_no_connection(&listener);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_change_with_the_switch_on_sends_only_the_shared_projects_to_the_stand_in() {
    let mut ws = team();
    let invite = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let server = Arc::new(Mutex::new(Server::new(ws)));
    let endpoint = serve(server.clone());
    let grant = client_for(&endpoint, "").accept(&invite, "ann").unwrap();

    let dir = std::env::temp_dir().join(format!("tw-wire-on-{}", Uuid::new_v4()));
    let path = dir.join(CONFIG_FILE);
    save_config(&path, true, &endpoint).unwrap();
    let store = MemoryStore::default();
    remember_token(&store, &grant.token).unwrap();

    assert_eq!(
        sync_on_write(&path, &store, &stored_projects()).unwrap(),
        SyncOutcome::Sent { projects: 1 }
    );
    let guard = server.lock().unwrap();
    assert_eq!(guard.synced.len(), 1);
    let body = guard.synced[0].to_string();
    assert!(body.contains("shared-1"));
    assert!(
        !body.contains("PRIVATE-SECRET-TEXT"),
        "private text left the machine: {body}"
    );
    assert!(
        !body.contains("/opt/local-only"),
        "a local folder left the machine: {body}"
    );
    drop(guard);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_status_shows_the_saved_address_and_never_the_token() {
    let config = Config {
        enabled: true,
        endpoint: "https://team.example.test/v1".into(),
        token: "device-secret-token".into(),
    };
    let status = status_for(&config);
    assert_eq!(status.endpoint, "https://team.example.test/v1");
    assert!(status.signed_in && status.active);
    let shown = serde_json::to_string(&status).unwrap();
    assert!(shown.contains("\"endpoint\":\"https://team.example.test/v1\""));
    assert!(!shown.contains("device-secret-token"));
}

// --- pull and per-field merge between members ------------------------------------------------

fn two_members() -> (Client, Client, Arc<Mutex<Server>>) {
    let mut ws = team();
    let invite_a = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let invite_b = create_invitation(&mut ws, "owner", Role::Member, NOW).unwrap();
    let server = Arc::new(Mutex::new(Server::new(ws)));
    let endpoint = serve(server.clone());
    let ann = client_for(
        &endpoint,
        &client_for(&endpoint, "")
            .accept(&invite_a, "ann")
            .unwrap()
            .token,
    );
    let ben = client_for(
        &endpoint,
        &client_for(&endpoint, "")
            .accept(&invite_b, "ben")
            .unwrap()
            .token,
    );
    (ann, ben, server)
}

fn shared_record(id: &str, name: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "shared": true,
        "folder": "/opt/local-only/projects/exo",
        "shortName": "EXO",
        "tasks": []
    })
}

fn doc_with(records: Vec<Value>) -> Value {
    json!({ "projects": records })
}

fn record<'a>(doc: &'a Value, id: &str) -> &'a Value {
    doc["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap()
}

#[test]
fn a_change_on_one_device_arrives_on_the_other_on_its_next_round() {
    let (ann, ben, _server) = two_members();
    let a1 = sync_round(
        &ann,
        &doc_with(vec![shared_record("exo", "EXO")]),
        &SyncState::default(),
    )
    .unwrap();
    let b1 = sync_round(&ben, &doc_with(vec![]), &SyncState::default()).unwrap();
    assert_eq!(record(&b1.doc, "exo")["name"], "EXO");
    assert_eq!(record(&b1.doc, "exo")["shared"], true);
    assert!(
        record(&b1.doc, "exo").get("folder").is_none(),
        "the local folder arrived on the other device"
    );

    let a2 = sync_round(
        &ann,
        &doc_with(vec![shared_record("exo", "EXO game")]),
        &a1.state,
    )
    .unwrap();
    assert!(a2.pushed > 0);
    let b2 = sync_round(&ben, &b1.doc, &b1.state).unwrap();
    assert_eq!(record(&b2.doc, "exo")["name"], "EXO game");
}

#[test]
fn the_local_folder_and_the_shared_flag_never_reach_the_server() {
    let (ann, _ben, server) = two_members();
    sync_round(
        &ann,
        &doc_with(vec![shared_record("exo", "EXO")]),
        &SyncState::default(),
    )
    .unwrap();
    let guard = server.lock().unwrap();
    let stored = serde_json::to_string(&guard.docs).unwrap();
    assert!(
        !stored.contains("/opt/local-only"),
        "a local folder path left the machine: {stored}"
    );
    assert!(
        !stored.contains("\"shared\""),
        "the shared flag was stored: {stored}"
    );
    assert!(guard.docs.contains_key("project:exo"));
}

#[test]
fn a_local_edit_is_never_replaced_by_a_value_pulled_from_the_server() {
    let (ann, ben, _server) = two_members();
    let a1 = sync_round(
        &ann,
        &doc_with(vec![shared_record("exo", "EXO")]),
        &SyncState::default(),
    )
    .unwrap();
    let b1 = sync_round(&ben, &doc_with(vec![]), &SyncState::default()).unwrap();
    // Ann renames and syncs. Ben has typed his own name for the same field, not synced yet.
    let a2 = sync_round(
        &ann,
        &doc_with(vec![shared_record("exo", "EXO game")]),
        &a1.state,
    )
    .unwrap();
    let mut ben_local = b1.doc.clone();
    ben_local["projects"][0]["name"] = json!("Ben's title");

    let b2 = sync_round(&ben, &ben_local, &b1.state).unwrap();
    assert_eq!(record(&b2.doc, "exo")["name"], "Ben's title");
    assert!(
        b2.state.conflicts.iter().any(|c| c == "exo.name"),
        "the replaced edit was not recorded"
    );

    // The server now holds Ben's value, so Ann gets it on her next round.
    let a3 = sync_round(&ann, &a2.doc, &a2.state).unwrap();
    assert_eq!(record(&a3.doc, "exo")["name"], "Ben's title");
}

#[test]
fn concurrent_edits_to_different_fields_both_survive() {
    let (ann, ben, _server) = two_members();
    let a1 = sync_round(
        &ann,
        &doc_with(vec![shared_record("exo", "EXO")]),
        &SyncState::default(),
    )
    .unwrap();
    let b1 = sync_round(&ben, &doc_with(vec![]), &SyncState::default()).unwrap();
    let mut ann_local = a1.doc.clone();
    ann_local["projects"][0]["name"] = json!("EXO game");
    let mut ben_local = b1.doc.clone();
    ben_local["projects"][0]["shortName"] = json!("XG");

    let a2 = sync_round(&ann, &ann_local, &a1.state).unwrap();
    let b2 = sync_round(&ben, &ben_local, &b1.state).unwrap();
    let a3 = sync_round(&ann, &a2.doc, &a2.state).unwrap();
    for doc in [&a3.doc, &b2.doc] {
        assert_eq!(record(doc, "exo")["name"], "EXO game");
        assert_eq!(record(doc, "exo")["shortName"], "XG");
    }
    assert!(a3.state.conflicts.is_empty() && b2.state.conflicts.is_empty());
}

#[test]
fn an_unshared_project_stops_syncing_and_is_not_pulled_back() {
    let (ann, ben, _server) = two_members();
    let a1 = sync_round(
        &ann,
        &doc_with(vec![shared_record("exo", "EXO")]),
        &SyncState::default(),
    )
    .unwrap();
    let mut unshared = a1.doc.clone();
    unshared["projects"][0]["shared"] = json!(false);
    let a2 = sync_round(&ann, &unshared, &a1.state).unwrap();
    assert_eq!(a2.pushed, 0, "an unshared project was pushed");

    let mut private_edit = a2.doc.clone();
    private_edit["projects"][0]["name"] = json!("private rename");
    let a3 = sync_round(&ann, &private_edit, &a2.state).unwrap();
    assert_eq!(record(&a3.doc, "exo")["name"], "private rename");

    let b1 = sync_round(&ben, &doc_with(vec![]), &SyncState::default()).unwrap();
    assert_eq!(
        record(&b1.doc, "exo")["name"],
        "EXO",
        "ben got the private rename"
    );
}

#[test]
fn a_project_id_that_is_not_a_plain_name_is_never_sent() {
    let (ann, _ben, server) = two_members();
    sync_round(
        &ann,
        &doc_with(vec![shared_record("../escape", "x")]),
        &SyncState::default(),
    )
    .unwrap();
    assert!(server.lock().unwrap().projects.is_empty());
}

#[test]
fn the_joined_name_survives_saving_the_switch_and_is_kept_out_of_the_token_store() {
    let dir = std::env::temp_dir().join(format!("tw-account-{}", Uuid::new_v4()));
    let path = dir.join(CONFIG_FILE);
    remember_account(&path, "ann").unwrap();
    save_config(&path, true, "https://team.example.test/v1").unwrap();
    save_config(&path, false, "https://team.example.test/v1").unwrap();
    assert_eq!(load_account(&path), "ann");
    assert!(load_config(&path).token.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

// --- review of PR #221: a pull never takes a local-only field, and never empties a project ----

#[test]
fn a_pulled_value_never_replaces_the_local_folder_id_or_shared_flag() {
    let (ann, ben, _server) = two_members();
    let a1 = sync_round(
        &ann,
        &doc_with(vec![shared_record("exo", "EXO")]),
        &SyncState::default(),
    )
    .unwrap();
    // Another member (or a bad server) writes the fields that never sync.
    ben.put_fields(
        "project:exo",
        &[
            ("folder", 0, "\"/Users/someone-else/elsewhere\""),
            ("id", 0, "\"other\""),
            ("shared", 0, "false"),
        ],
    )
    .unwrap();

    let a2 = sync_round(&ann, &a1.doc, &a1.state).unwrap();
    let mine = &a2.doc["projects"][0];
    assert_eq!(mine["id"], "exo", "a pull replaced the project id");
    assert_eq!(
        mine["folder"], "/opt/local-only/projects/exo",
        "a pull replaced the local folder"
    );
    assert_eq!(mine["shared"], true, "a pull replaced the shared flag");

    // A device that pulls the project for the first time takes no folder from the server either.
    let b1 = sync_round(&ben, &doc_with(vec![]), &SyncState::default()).unwrap();
    let pulled = &b1.doc["projects"][0];
    assert_eq!(pulled["id"], "exo");
    assert!(
        pulled.get("folder").is_none(),
        "a folder path came from the server"
    );
    assert_eq!(pulled["shared"], true);
}

#[test]
fn a_server_that_does_not_have_the_project_never_empties_it_locally() {
    let (ann, _ben, _server) = two_members();
    let a1 = sync_round(
        &ann,
        &doc_with(vec![shared_record("exo", "EXO")]),
        &SyncState::default(),
    )
    .unwrap();
    // The team server address changes (or the server lost the project): the sync state still names the old revisions.
    let (fresh, _other, fresh_server) = two_members();
    let a2 = sync_round(&fresh, &a1.doc, &a1.state).unwrap();
    let mine = record(&a2.doc, "exo");
    assert_eq!(mine["name"], "EXO", "the project's name was deleted");
    assert_eq!(mine["shortName"], "EXO", "the short name was deleted");
    assert_eq!(mine["tasks"], json!([]), "a field was deleted");
    // The project is sent to the server that lacked it.
    let guard = fresh_server.lock().unwrap();
    assert!(
        guard
            .docs
            .get("project:exo")
            .is_some_and(|f| f.contains_key("name")),
        "the project was not sent to the new server"
    );
}

#[test]
fn the_settings_status_reads_no_token_while_the_switch_is_off() {
    let dir = std::env::temp_dir().join(format!("tw-status-off-{}", Uuid::new_v4()));
    let path = dir.join(CONFIG_FILE);
    save_config(&path, false, "https://team.example.test/v1").unwrap();
    let status = status_at(&path, &NeverRead);
    assert!(!status.enabled && !status.active && !status.signed_in);
    assert_eq!(status.endpoint, "https://team.example.test/v1");
    assert!(!status_at(&dir.join("missing.json"), &NeverRead).enabled);

    // On, the token is read so the screen can say whether this device has joined.
    save_config(&path, true, "https://team.example.test/v1").unwrap();
    let store = MemoryStore::default();
    remember_token(&store, "device-token").unwrap();
    assert!(status_at(&path, &store).active);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_app_sends_only_to_https_and_plain_http_is_for_the_test_stand_in() {
    for raw in [
        "http://127.0.0.1:4010",
        "http://localhost:4010",
        "http://[::1]:4010",
        "http://sync.example.test/v1",
    ] {
        assert!(endpoint_rules(raw, false).is_err(), "{raw} was accepted");
    }
    assert!(endpoint_rules("https://sync.example.test/v1", false).is_ok());
    assert!(endpoint_rules("http://127.0.0.1:4010", true).is_ok());
    assert!(endpoint_rules("http://sync.example.test/v1", true).is_err());
}
