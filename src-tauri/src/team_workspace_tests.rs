//! WP-80 tests. Loopback stand-ins only: no test reaches a real host, and no test needs an account.

use super::*;
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

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

// --- config and the off switch ----------------------------------------------------------------

#[test]
fn the_default_config_is_off_with_no_endpoint() {
    let config = Config::default();
    assert!(!config.enabled);
    assert!(config.endpoint.is_empty());
}

#[test]
fn a_missing_config_file_loads_as_off() {
    let dir = std::env::temp_dir().join(format!("tw-missing-{}", uuid::Uuid::new_v4()));
    assert_eq!(
        load_config(&dir.join("team-workspace.json")),
        Config::default()
    );
}

#[test]
fn a_config_that_only_says_enabled_still_makes_no_call() {
    let config: Config = serde_json::from_str(r#"{"enabled": true}"#).unwrap();
    let counter = Counting::default();
    let outcome = sync_outbound(&config, &projects(), &counter).unwrap();
    assert_eq!(outcome, SyncOutcome::NoEndpoint);
    assert_eq!(counter.calls(), 0);
}

#[test]
fn disabled_or_endpoint_empty_opens_no_connection_at_all() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let endpoint = format!("http://{addr}/sync");

    let off = Config {
        enabled: false,
        endpoint: endpoint.clone(),
    };
    assert_eq!(
        sync_outbound(&off, &projects(), &HttpTransport).unwrap(),
        SyncOutcome::Disabled
    );

    let no_endpoint = Config {
        enabled: true,
        endpoint: "   ".into(),
    };
    assert_eq!(
        sync_outbound(&no_endpoint, &projects(), &HttpTransport).unwrap(),
        SyncOutcome::NoEndpoint
    );

    match listener.accept() {
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
        other => panic!("something connected while the feature was off: {other:?}"),
    }
}

// --- endpoint rules --------------------------------------------------------------------------

#[test]
fn an_endpoint_must_be_https_unless_it_is_this_machine() {
    assert!(validate_endpoint("https://sync.example.test/v1").is_ok());
    assert!(validate_endpoint("http://127.0.0.1:4010/sync").is_ok());
    assert!(validate_endpoint("http://localhost:4010/sync").is_ok());
    assert!(validate_endpoint("http://[::1]:4010/sync").is_ok());
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
    let config = Config {
        enabled: true,
        endpoint: "http://sync.example.test/v1".into(),
    };
    let counter = Counting::default();
    assert!(sync_outbound(&config, &projects(), &counter).is_err());
    assert_eq!(counter.calls(), 0);
}

// --- private projects never leave the machine -------------------------------------------------

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

#[derive(Default)]
struct Counting(std::cell::Cell<usize>);
impl Counting {
    fn calls(&self) -> usize {
        self.0.get()
    }
}
impl Transport for Counting {
    fn post_json(&self, _endpoint: &str, _body: &str) -> Result<(), String> {
        self.0.set(self.0.get() + 1);
        Ok(())
    }
}

fn read_body(stream: &mut TcpStream) -> String {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut len = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap();
        }
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).unwrap();
    String::from_utf8(buf).unwrap()
}

#[test]
fn when_on_only_shared_projects_reach_a_loopback_stand_in() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let body = read_body(&mut stream);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .unwrap();
        body
    });

    let config = Config {
        enabled: true,
        endpoint: format!("http://{addr}/sync"),
    };
    let outcome = sync_outbound(&config, &projects(), &HttpTransport).unwrap();
    assert_eq!(outcome, SyncOutcome::Sent { projects: 1 });

    let body = server.join().unwrap();
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

// --- status shown to the person (no network) ---------------------------------------------------

#[test]
fn status_is_off_and_says_so_by_default() {
    let status = status_for(&Config::default());
    assert!(!status.enabled);
    assert!(!status.endpoint_configured);
    assert!(!status.active);
}

#[test]
fn status_is_active_only_when_on_with_a_valid_endpoint() {
    let on_no_endpoint = status_for(&Config {
        enabled: true,
        endpoint: String::new(),
    });
    assert!(on_no_endpoint.enabled && !on_no_endpoint.active);

    let on_bad = status_for(&Config {
        enabled: true,
        endpoint: "http://sync.example.test".into(),
    });
    assert!(on_bad.endpoint_configured && !on_bad.active);

    let on_good = status_for(&Config {
        enabled: true,
        endpoint: "https://sync.example.test/v1".into(),
    });
    assert!(on_good.enabled && on_good.endpoint_configured && on_good.active);
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
        let _ = read_body(&mut stream);
        let reply = format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(reply.as_bytes()).unwrap();
    });

    let config = Config {
        enabled: true,
        endpoint: format!("http://{addr}/sync"),
    };
    assert!(sync_outbound(&config, &projects(), &HttpTransport).is_err());
    server.join().unwrap();

    match elsewhere.accept() {
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
        other => panic!("the redirect target was contacted: {other:?}"),
    }
}
