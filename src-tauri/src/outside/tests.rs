// Port of Orbit's oauth_api and mcp_api checks (Apache-2.0). Hivra has no
// login cookie, chat tool or delete_task. Consent without the app is 401
// login_required, which is Orbit's "consent without a session" case: the app
// command is the session.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::time::Duration;

use crate::instance::Kind;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::security::{self, MAX_CLIENTS, REGISTRATIONS_PER_IP};
use super::Outside;
use crate::tasks::{self, Actor, CreateInput};

const REDIRECT: &str = "http://127.0.0.1:9/cb";

struct Res {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn send(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    content_length: Option<u64>,
    host: Option<&str>,
) -> Res {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let host = host.unwrap_or("");
    let host = if host.is_empty() {
        format!("127.0.0.1:{port}")
    } else {
        host.to_string()
    };
    let length = content_length.unwrap_or(body.len() as u64);
    let mut head =
        format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: {length}\r\n");
    for (name, value) in headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).unwrap();
    if content_length.is_none() {
        stream.write_all(body).unwrap();
    }
    read_response(stream)
}

fn read_response(mut stream: TcpStream) -> Res {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => panic!("closed before headers: {}", String::from_utf8_lossy(&buf)),
            Ok(_) => buf.push(byte[0]),
            Err(err) => panic!("read headers: {err}; {}", String::from_utf8_lossy(&buf)),
        }
        if buf.ends_with(b"\r\n\r\n") || buf.len() > 64 * 1024 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    let mut lines = text.split("\r\n");
    let start = lines.next().unwrap_or("");
    let status: u16 = start.split(' ').nth(1).unwrap_or("0").parse().unwrap_or(0);
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if length > 0 {
        stream
            .read_exact(&mut body)
            .unwrap_or_else(|err| panic!("body: {err}"));
    }
    Res {
        status,
        headers,
        body,
    }
}

fn header<'a>(res: &'a Res, name: &str) -> &'a str {
    res.headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
        .unwrap_or("")
}

fn json_of(res: &Res) -> Value {
    serde_json::from_slice(&res.body).unwrap_or(Value::Null)
}

fn text_of(res: &Res) -> String {
    String::from_utf8_lossy(&res.body).to_string()
}

fn challenge() -> (String, String) {
    let verifier = "a".repeat(64);
    let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, digest)
}

fn door() -> (Outside, u16) {
    let door = Outside::open_memory().unwrap();
    let port = door.start().unwrap();
    (door, port)
}

fn seed(door: &Outside) {
    door.with_conn(|conn| {
        crate::local_hub::write_if(
            conn,
            "projects",
            &json!({
                "projects": [
                    {"id": "hivra", "name": "Hivra", "folder": "/work/hivra"},
                    {"id": "secret", "name": "Secret", "folder": "/work/secret"}
                ]
            }),
            None,
        )
        .unwrap();
    })
    .unwrap();
}

fn add_task(door: &Outside, folder: &str, title: &str) -> String {
    door.with_conn(|conn| {
        let written = tasks::create(
            conn,
            &Actor {
                id: "person".into(),
                project: folder.into(),
                kind: "person".into(),
            },
            &CreateInput {
                title: title.into(),
                project: Some(folder.into()),
                ..CreateInput::default()
            },
            1_700_000_000_000,
        )
        .unwrap();
        written.task.id
    })
    .unwrap()
}

fn form(pairs: &[(&str, &str)]) -> String {
    let mut out = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        out.append_pair(name, value);
    }
    out.finish()
}

fn register(port: u16, name: &str, redirect: &str) -> Res {
    let body = serde_json::to_vec(&json!({
        "client_name": name,
        "redirect_uris": [redirect],
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"]
    }))
    .unwrap();
    send(
        port,
        "POST",
        "/oauth/register",
        &[("content-type", "application/json")],
        &body,
        None,
        None,
    )
}

fn client_id(port: u16) -> String {
    let res = register(port, "Desk", REDIRECT);
    assert_eq!(res.status, 201, "{}", text_of(&res));
    json_of(&res)["client_id"].as_str().unwrap().to_string()
}

fn authorize(port: u16, client: &str, challenge: &str) -> String {
    let resource = format!("http://127.0.0.1:{port}/mcp");
    let query = form(&[
        ("response_type", "code"),
        ("client_id", client),
        ("redirect_uri", REDIRECT),
        ("state", "s1"),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("scope", "hivra:read"),
        ("resource", &resource),
    ]);
    let res = send(
        port,
        "GET",
        &format!("/oauth/authorize?{query}"),
        &[],
        &[],
        None,
        None,
    );
    assert_eq!(res.status, 302, "{}", text_of(&res));
    let location = header(&res, "location");
    url::Url::parse(location)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "request")
        .unwrap()
        .1
        .to_string()
}

fn code_from(redirect: &str) -> String {
    url::Url::parse(redirect)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "code")
        .unwrap()
        .1
        .to_string()
}

struct Tokens {
    access: String,
    refresh: String,
    scope: String,
}

fn exchange(port: u16, client: &str, code: &str, verifier: &str, resource: Option<&str>) -> Res {
    let mut pairs = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", REDIRECT),
        ("client_id", client),
        ("code_verifier", verifier),
    ];
    if let Some(resource) = resource {
        pairs.push(("resource", resource));
    }
    let body = form(&pairs);
    send(
        port,
        "POST",
        "/oauth/token",
        &[("content-type", "application/x-www-form-urlencoded")],
        body.as_bytes(),
        None,
        None,
    )
}

fn tokens_from(res: &Res) -> Tokens {
    assert_eq!(res.status, 200, "{}", text_of(res));
    let body = json_of(res);
    Tokens {
        access: body["access_token"].as_str().unwrap().to_string(),
        refresh: body["refresh_token"].as_str().unwrap().to_string(),
        scope: body["scope"].as_str().unwrap().to_string(),
    }
}

fn login(door: &Outside, port: u16, projects: &[&str], write: bool) -> (String, Tokens) {
    let (verifier, challenge) = challenge();
    let client = client_id(port);
    let request = authorize(port, &client, &challenge);
    let chosen: Vec<String> = projects.iter().map(|id| (*id).to_string()).collect();
    let redirect = super::decide_local(door, &request, true, &chosen, write)
        .unwrap()
        .redirect_uri;
    let query = |name: &str| -> String {
        url::Url::parse(&redirect)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default()
    };
    assert_eq!(query("state"), "s1", "{redirect}");
    assert_eq!(
        query("iss"),
        format!("http://127.0.0.1:{port}"),
        "{redirect}"
    );
    let code = code_from(&redirect);
    let resource = format!("http://127.0.0.1:{port}/mcp");
    let tokens = tokens_from(&exchange(port, &client, &code, &verifier, Some(&resource)));
    (client, tokens)
}

fn refresh(port: u16, client: &str, token: &str, scope: Option<&str>) -> Res {
    let mut pairs = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", token),
        ("client_id", client),
    ];
    if let Some(scope) = scope {
        pairs.push(("scope", scope));
    }
    let body = form(&pairs);
    send(
        port,
        "POST",
        "/oauth/token",
        &[("content-type", "application/x-www-form-urlencoded")],
        body.as_bytes(),
        None,
        None,
    )
}

fn mcp(port: u16, token: Option<&str>, body: Value, extra: &[(&str, &str)]) -> Res {
    let raw = serde_json::to_vec(&body).unwrap();
    let mut headers = vec![("content-type", "application/json")];
    let bearer;
    if let Some(token) = token {
        bearer = format!("Bearer {token}");
        headers.push(("authorization", &bearer));
    }
    headers.extend_from_slice(extra);
    send(port, "POST", "/mcp", &headers, &raw, None, None)
}

fn call_tool(port: u16, token: &str, name: &str, args: Value) -> Res {
    mcp(
        port,
        Some(token),
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}),
        &[],
    )
}

fn tool_body(res: &Res) -> Value {
    assert_eq!(res.status, 200, "{}", text_of(res));
    json_of(res)
}

fn task_count(door: &Outside) -> i64 {
    door.with_conn(|conn| {
        tasks::ensure_tables(conn).unwrap();
        conn.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap()
    })
    .unwrap()
}

#[test]
fn the_door_is_off_until_this_copy_turns_it_on() {
    // Ports this test holds, outside the ephemeral range, so another test's
    // bind(0) cannot be given one of them between release and the check.
    let mut mine = HeldPort::reserve();
    let mut theirs = HeldPort::reserve();
    let port = mine.port;
    let other_port = theirs.port;
    mine.release();
    theirs.release();

    let door = Outside::open_memory_on(&[port]).unwrap();
    let status = door.status().unwrap();
    assert!(!status.enabled);
    assert!(status.url.is_none());
    assert!(door.port().is_none());

    let on = door.set_enabled(true).unwrap();
    assert!(on.enabled);
    let url = on.url.unwrap();
    assert_eq!(door.port(), Some(port));
    assert!(url.contains(&format!(":{port}/")), "{url}");
    assert_eq!(
        door.set_enabled(true).unwrap().url.as_deref(),
        Some(url.as_str())
    );

    let other = Outside::open_memory_on(&[other_port]).unwrap();
    other.set_enabled(true).unwrap();
    assert_eq!(other.port(), Some(other_port));
    assert_ne!(port, other_port);
    let crossed = send(
        port,
        "GET",
        "/.well-known/oauth-authorization-server",
        &[],
        &[],
        None,
        Some(&format!("127.0.0.1:{other_port}")),
    );
    assert_eq!(crossed.status, 403);

    door.set_enabled(false).unwrap();
    assert!(!door.status().unwrap().enabled);
    assert!(door.port().is_none());
    // Binding it and keeping it proves the door let go. A probe that binds and
    // drops would race with every other test in the process.
    let released = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .unwrap_or_else(|err| panic!("the door still holds {port}: {err}"));
    let _keep = released;
}

#[test]
fn paths_match_across_slashes_and_keep_case_on_unix() {
    assert!(security::same_path("C:/work/hivra", r"C:\work\hivra"));
    assert!(security::same_path("/work/hivra/", "/work/hivra"));
    assert!(!security::same_path("", ""));
    #[cfg(windows)]
    assert!(security::same_path("/Work", "/work"));
    #[cfg(not(windows))]
    assert!(!security::same_path("/Work", "/work"));
    let v6 = "2001:db8:1:2:3:4:5:6";
    assert_eq!(
        security::registration_key(v6),
        security::registration_key("2001:db8:1:2::9")
    );
    assert_eq!(security::registration_key("127.0.0.1"), "127.0.0.1");
}

#[test]
fn discovery_and_a_full_pkce_grant_store_only_hashes() {
    let (door, port) = door();
    seed(&door);
    let empty = send(port, "POST", "/mcp", &[], &[], None, None);
    assert_eq!(empty.status, 401);
    let challenge = header(&empty, "www-authenticate");
    assert!(
        challenge.contains(&format!(
        "resource_metadata=\"http://127.0.0.1:{port}/.well-known/oauth-protected-resource/mcp\""
    )),
        "{challenge}"
    );

    let meta = send(
        port,
        "GET",
        "/.well-known/oauth-authorization-server",
        &[],
        &[],
        None,
        None,
    );
    assert_eq!(meta.status, 200);
    let meta = json_of(&meta);
    assert_eq!(meta["issuer"], format!("http://127.0.0.1:{port}"));
    assert_eq!(meta["code_challenge_methods_supported"], json!(["S256"]));

    let (_client, tokens) = login(&door, port, &["hivra"], false);
    assert_eq!(tokens.scope, "hivra:read");
    door.with_conn(|conn| {
        let hash: Vec<u8> = conn
            .query_row("SELECT access_hash FROM outside_tokens", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(hash.len(), 32);
        assert_ne!(hash, tokens.access.as_bytes());
        let connects: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM activity WHERE kind = 'outside.connect'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(connects, 1);
    })
    .unwrap();

    let listed = call_tool(port, &tokens.access, "list_projects", json!({}));
    let body = tool_body(&listed);
    assert!(body.get("error").is_none(), "{body}");
    assert_eq!(
        body["result"]["structuredContent"]["items"][0]["id"],
        "hivra"
    );
    assert!(text_of(&listed).contains(security::DATA_NOTICE));
    assert!(!text_of(&listed).contains("Secret"));
}

#[test]
fn a_wrong_proof_does_not_spend_the_code_and_reuse_revokes() {
    let (door, port) = door();
    seed(&door);
    let (verifier, challenge) = challenge();
    let client = client_id(port);
    let request = authorize(port, &client, &challenge);
    let agreed = super::decide_local(&door, &request, true, &["hivra".to_string()], false).unwrap();
    let code = code_from(&agreed.redirect_uri);
    let resource = format!("http://127.0.0.1:{port}/mcp");

    let wrong_verifier = exchange(port, &client, &code, &"z".repeat(64), Some(&resource));
    assert_eq!(wrong_verifier.status, 400, "{}", text_of(&wrong_verifier));
    let wrong_client = exchange(port, "hivra-client-nope", &code, &verifier, Some(&resource));
    assert_eq!(wrong_client.status, 400);
    let wrong_redirect = {
        let body = form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", "http://127.0.0.1:9/other"),
            ("client_id", &client),
            ("code_verifier", &verifier),
            ("resource", &resource),
        ]);
        send(
            port,
            "POST",
            "/oauth/token",
            &[("content-type", "application/x-www-form-urlencoded")],
            body.as_bytes(),
            None,
            None,
        )
    };
    assert_eq!(wrong_redirect.status, 400);
    let wrong_resource = exchange(
        port,
        &client,
        &code,
        &verifier,
        Some("http://127.0.0.1:1/mcp"),
    );
    assert_eq!(wrong_resource.status, 400);

    let first = tokens_from(&exchange(port, &client, &code, &verifier, Some(&resource)));
    let reuse = exchange(port, &client, &code, &verifier, None);
    assert_eq!(reuse.status, 400);
    assert_eq!(json_of(&reuse)["error"], "invalid_grant");
    let again = mcp(
        port,
        Some(&first.access),
        json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        &[],
    );
    assert_eq!(again.status, 401);
    door.with_conn(|conn| {
        let revoked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outside_grants WHERE revoked_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revoked, 1);
        let notes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM activity WHERE kind = 'outside.disconnect'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(notes, 1);
    })
    .unwrap();
}

#[test]
fn refresh_tokens_rotate_and_reuse_revokes() {
    let (door, port) = door();
    seed(&door);
    let (client, tokens) = login(&door, port, &["hivra"], false);
    let next = tokens_from(&refresh(port, &client, &tokens.refresh, None));
    assert_ne!(next.refresh, tokens.refresh);
    let still = mcp(
        port,
        Some(&next.access),
        json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        &[],
    );
    assert_eq!(still.status, 200, "{}", text_of(&still));
    let reused = refresh(port, &client, &tokens.refresh, None);
    assert_eq!(reused.status, 400);
    let dead = mcp(
        port,
        Some(&next.access),
        json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        &[],
    );
    assert_eq!(dead.status, 401);

    let (_client2, write_tokens) = login(&door, port, &["hivra"], false);
    let widened = refresh(
        port,
        &_client2,
        &write_tokens.refresh,
        Some("hivra:read tasks:write"),
    );
    assert_eq!(widened.status, 400);
    assert_eq!(json_of(&widened)["error"], "invalid_scope");
    let kept = tokens_from(&refresh(port, &_client2, &write_tokens.refresh, None));
    assert_eq!(kept.scope, "hivra:read");
}

#[test]
fn a_bad_consent_does_not_spend_the_request() {
    let (door, port) = door();
    seed(&door);
    let (_verifier, challenge) = challenge();
    let client = client_id(port);
    let request = authorize(port, &client, &challenge);
    let origin = format!("http://127.0.0.1:{port}");
    let posted = serde_json::to_vec(&json!({
        "approved": true,
        "csrf_token": "hivra-csrf-nope",
        "project_ids": ["hivra"],
        "write": false
    }))
    .unwrap();
    let bad = send(
        port,
        "POST",
        &format!("/oauth/consent/{request}"),
        &[("content-type", "application/json"), ("origin", &origin)],
        &posted,
        None,
        None,
    );
    assert_eq!(bad.status, 401, "{}", text_of(&bad));
    let missing = super::decide_local(&door, &request, true, &["not-a-project".to_string()], false);
    assert!(missing.is_err(), "{missing:?}");
    let folder = super::decide_local(&door, &request, true, &["/work/hivra".to_string()], false);
    assert!(folder.is_err(), "{folder:?}");
    let pending = door
        .with_conn(|conn| super::pending_page(conn, super::now_ms()))
        .unwrap()
        .unwrap();
    assert_eq!(pending.requests.len(), 1);

    let denied = super::decide_local(&door, &request, false, &[], false).unwrap();
    assert!(
        denied.redirect_uri.contains("error=access_denied"),
        "{}",
        denied.redirect_uri
    );
    let browser = send(
        port,
        "GET",
        &format!("/oauth/consent/{request}"),
        &[("accept", "text/html")],
        &[],
        None,
        None,
    );
    assert_eq!(browser.status, 302, "{}", text_of(&browser));
    let location = header(&browser, "location");
    assert!(location.contains("error=access_denied"), "{location}");
    assert!(!location.contains("code="), "{location}");
    let again = super::decide_local(&door, &request, false, &[], false);
    assert!(again.is_err(), "{again:?}");
}

#[test]
fn an_expired_access_token_refreshes_and_disconnect_kills_both() {
    let (door, port) = door();
    seed(&door);
    let (client, tokens) = login(&door, port, &["hivra"], false);
    door.with_conn(|conn| {
        conn.execute("UPDATE outside_tokens SET access_expires_at = 1", [])
            .unwrap();
    })
    .unwrap();
    let expired = mcp(
        port,
        Some(&tokens.access),
        json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        &[],
    );
    assert_eq!(expired.status, 401);
    let renewed = tokens_from(&refresh(port, &client, &tokens.refresh, None));
    let alive = mcp(
        port,
        Some(&renewed.access),
        json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        &[],
    );
    assert_eq!(alive.status, 200, "{}", text_of(&alive));

    let grant: String = door
        .with_conn(|conn| {
            conn.query_row(
                "SELECT id FROM outside_grants WHERE revoked_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap()
        })
        .unwrap();
    let origin = format!("http://127.0.0.1:{port}");
    let gone = send(
        port,
        "DELETE",
        &format!("/oauth/grants/{grant}"),
        &[("origin", &origin)],
        &[],
        None,
        None,
    );
    assert_eq!(gone.status, 204, "{}", text_of(&gone));
    let after = mcp(
        port,
        Some(&renewed.access),
        json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        &[],
    );
    assert_eq!(after.status, 401);
    let refresh_after = refresh(port, &client, &renewed.refresh, None);
    assert_eq!(refresh_after.status, 400);
}

#[test]
fn registration_rejects_unsafe_redirects_and_throttles() {
    let (_door, port) = door();
    for uri in [
        "http://evil.test/callback",
        "javascript:alert(1)",
        "https://evil.test/callback#fragment",
        "https://user:password@evil.test/callback",
    ] {
        let res = register(port, "Desk", uri);
        assert_eq!(res.status, 400, "{uri} {}", text_of(&res));
    }
    let https = register(port, "Desk", "https://evil.test/callback");
    assert_eq!(https.status, 201, "{}", text_of(&https));

    let options = send(
        port,
        "OPTIONS",
        "/oauth/token",
        &[("origin", "https://evil.test")],
        &[],
        None,
        None,
    );
    assert_eq!(options.status, 204, "{}", text_of(&options));
    assert_eq!(header(&options, "access-control-allow-origin"), "*");

    let foreign = send(
        port,
        "POST",
        "/oauth/consent/bad",
        &[
            ("origin", "https://evil.test"),
            ("content-type", "application/json"),
        ],
        b"{}",
        None,
        None,
    );
    assert_eq!(foreign.status, 403);

    let limited = Outside::open_memory().unwrap();
    let limited_port = limited.start().unwrap();
    for n in 0..REGISTRATIONS_PER_IP {
        let res = register(limited_port, "Desk", REDIRECT);
        assert_eq!(res.status, 201, "registration {n} {}", text_of(&res));
    }
    let blocked = register(limited_port, "Desk", REDIRECT);
    assert_eq!(blocked.status, 429, "{}", text_of(&blocked));
}

#[test]
fn old_unused_clients_are_pruned_and_a_full_registry_refuses() {
    let (door, port) = door();
    door.with_conn(|conn| {
        conn.execute(
            "INSERT INTO outside_clients (id, name, redirect_uris, created_at) VALUES ('old', 'Old', '[]', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO outside_clients (id, name, redirect_uris, created_at) VALUES ('kept', 'Kept', '[]', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO outside_grants (id, client_id, project_ids, resource, scope, mcp_scopes, created_at)
             VALUES ('g', 'kept', '[]', 'http://127.0.0.1/mcp', 'hivra:read', '', 0)",
            [],
        )
        .unwrap();
    })
    .unwrap();
    assert_eq!(register(port, "Desk", REDIRECT).status, 201);
    door.with_conn(|conn| {
        let old: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outside_clients WHERE id = 'old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let kept: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outside_clients WHERE id = 'kept'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old, 0);
        assert_eq!(kept, 1);
    })
    .unwrap();

    let full = Outside::open_memory().unwrap();
    let full_port = full.start().unwrap();
    let now = super::now_ms();
    full.with_conn(|conn| {
        let tx = conn.transaction().unwrap();
        for n in 0..MAX_CLIENTS {
            tx.execute(
                "INSERT INTO outside_clients (id, name, redirect_uris, created_at) VALUES (?1, 'n', '[]', ?2)",
                params![format!("c{n}"), now],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    })
    .unwrap();
    let refused = register(full_port, "Desk", REDIRECT);
    assert_eq!(refused.status, 429, "{}", text_of(&refused));
}

#[test]
fn granted_tools_hide_everything_outside_the_grant() {
    let (door, port) = door();
    seed(&door);
    let approved = add_task(&door, "/work/hivra", "Approved task");
    let secret = add_task(&door, "/work/secret", "Secret task");
    add_task(&door, "/work/hivra", "Second task");
    door.with_conn(|conn| {
        conn.execute(
            "UPDATE tasks SET parent_id = ?1 WHERE id = ?2",
            params![secret, approved],
        )
        .unwrap();
    })
    .unwrap();
    let (_client, tokens) = login(&door, port, &["hivra"], false);
    let (_other_client, other) = login(&door, port, &["secret"], false);

    let projects = tool_body(&call_tool(port, &tokens.access, "list_projects", json!({})));
    assert_eq!(
        projects["result"]["structuredContent"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let page = tool_body(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"limit": 1}),
    ));
    let items = &page["result"]["structuredContent"]["items"];
    assert_eq!(items.as_array().unwrap().len(), 1);
    assert!(page["result"]["structuredContent"]["next_cursor"].is_string());
    let first_id = items[0]["id"].as_str().unwrap().to_string();
    let cursor = page["result"]["structuredContent"]["next_cursor"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!text_of(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"limit": 1})
    ))
    .contains("Secret task"));

    let one = call_tool(
        port,
        &tokens.access,
        "get_task",
        json!({"task_id": approved}),
    );
    assert_eq!(
        tool_body(&one)["result"]["structuredContent"]["title"],
        "Approved task"
    );
    let shown = text_of(&one);
    assert!(!shown.contains("Secret task"), "{shown}");
    assert!(!shown.contains(&secret), "{shown}");

    let hidden = tool_body(&call_tool(
        port,
        &tokens.access,
        "get_task",
        json!({"task_id": secret}),
    ));
    assert_eq!(hidden["result"]["isError"], true);
    assert!(!text_of(&call_tool(
        port,
        &tokens.access,
        "get_task",
        json!({"task_id": secret})
    ))
    .contains(&secret));

    let other_project = tool_body(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"project_id": "secret"}),
    ));
    assert_eq!(other_project["result"]["isError"], true);
    let unknown = tool_body(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"project_id": "bad"}),
    ));
    assert!(unknown.get("error").is_some(), "{unknown}");

    let searched = tool_body(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"query": "Secret"}),
    ));
    assert!(searched["result"]["structuredContent"]["items"]
        .as_array()
        .unwrap()
        .is_empty());
    let found = tool_body(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"query": "Second"}),
    ));
    assert_eq!(
        found["result"]["structuredContent"]["items"][0]["title"],
        "Second task"
    );
    let mismatched = tool_body(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"query": "Second", "cursor": cursor}),
    ));
    assert_eq!(mismatched["result"]["isError"], true);
    let next = tool_body(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"limit": 1, "cursor": cursor}),
    ));
    assert_ne!(
        next["result"]["structuredContent"]["items"][0]["id"],
        first_id
    );

    let only_secret = tool_body(&call_tool(port, &other.access, "list_tasks", json!({})));
    let titles: Vec<_> = only_secret["result"]["structuredContent"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["title"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(titles, vec!["Secret task".to_string()]);

    let before = task_count(&door);
    for (name, args) in [
        ("list_tasks", json!({"limit": 0})),
        ("list_tasks", json!({"limit": 101})),
        ("list_tasks", json!({"workspace_id": "x"})),
        (
            "create_task",
            json!({"project_id": "hivra", "title": "Nope"}),
        ),
    ] {
        let refused = tool_body(&call_tool(port, &tokens.access, name, args));
        assert!(refused.get("error").is_some(), "{name} {refused}");
        assert!(
            refused["result"].is_null() || refused.get("result").is_none(),
            "{refused}"
        );
    }
    assert_eq!(task_count(&door), before);

    door.with_conn(|conn| {
        conn.execute(
            "UPDATE tasks SET trashed_at = 1 WHERE id = ?1",
            params![approved],
        )
        .unwrap();
    })
    .unwrap();
    let trashed = tool_body(&call_tool(
        port,
        &tokens.access,
        "get_task",
        json!({"task_id": approved}),
    ));
    assert_eq!(trashed["result"]["isError"], true, "{trashed}");
    let after_trash = tool_body(&call_tool(port, &tokens.access, "list_tasks", json!({})));
    assert!(after_trash["result"]["structuredContent"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["id"] != approved));
}

#[test]
fn the_door_checks_origin_host_and_body_size() {
    let (door, port) = door();
    seed(&door);
    let (_client, tokens) = login(&door, port, &["hivra"], false);
    let init = mcp(
        port,
        Some(&tokens.access),
        json!({"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2026-07-28"}}),
        &[],
    );
    assert_eq!(init.status, 200, "{}", text_of(&init));
    assert_eq!(json_of(&init)["result"]["serverInfo"]["name"], "hivra");
    assert_eq!(json_of(&init)["result"]["protocolVersion"], "2026-07-28");

    let evil = mcp(
        port,
        Some(&tokens.access),
        json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        &[("origin", "https://evil.test")],
    );
    assert_eq!(evil.status, 403);
    let bad_host = send(
        port,
        "POST",
        "/mcp",
        &[("authorization", "Bearer x")],
        b"{}",
        None,
        Some("evil.test"),
    );
    assert_eq!(bad_host.status, 403);
    let two = send(
        port,
        "POST",
        "/mcp",
        &[("authorization", "Bearer a"), ("authorization", "Bearer b")],
        b"{}",
        None,
        None,
    );
    assert_eq!(two.status, 401);
    assert!(header(&two, "www-authenticate").contains("resource_metadata"));

    let missing = send(port, "POST", "/mcp", &[], b"{}", None, None);
    assert_eq!(missing.status, 401);
    let other = send(port, "POST", "/mcp/other", &[], b"{}", None, None);
    assert_eq!(other.status, 403);
    let doubled = send(
        port,
        "POST",
        "/mcp",
        &[("origin", "http://a"), ("origin", "http://b")],
        b"{}",
        None,
        None,
    );
    assert_eq!(doubled.status, 403);
    let get = send(port, "GET", "/mcp", &[], &[], None, None);
    assert_eq!(get.status, 405);

    let huge = send(port, "POST", "/mcp", &[], &[], Some(70_000), None);
    assert_eq!(huge.status, 413, "{}", text_of(&huge));
    assert_eq!(json_of(&huge)["error"], "request_too_large");
    let oauth_huge = send(
        port,
        "POST",
        "/oauth/token",
        &[],
        &[],
        Some(17 * 1024),
        None,
    );
    assert_eq!(oauth_huge.status, 413);
    let chunked = send(
        port,
        "POST",
        "/oauth/token",
        &[("transfer-encoding", "chunked")],
        &[],
        Some(0),
        None,
    );
    assert_eq!(chunked.status, 400);

    for version in ["2026-07-28", "2025-11-25"] {
        let listed = mcp(
            port,
            Some(&tokens.access),
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"protocolVersion": version}}),
            &[],
        );
        let body = tool_body(&listed);
        assert_eq!(body["result"]["ttlMs"], 0);
        assert_eq!(body["result"]["cacheScope"], "private");
        let names: Vec<_> = body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                "list_projects",
                "list_tasks",
                "get_task",
                "list_docs",
                "get_doc",
                "current_work"
            ]
        );
    }

    door.with_conn(|conn| {
        crate::local_hub::write_if(
            conn,
            "projects",
            &json!({"projects": [{"id": "hivra", "name": "Hivra", "folder": "/work/hivra", "archived": true}]}),
            Some(1),
        )
        .unwrap();
    })
    .unwrap();
    let archived = mcp(
        port,
        Some(&tokens.access),
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        &[],
    );
    assert_eq!(archived.status, 401, "{}", text_of(&archived));
}

#[test]
fn writes_use_the_version_that_was_read_and_stay_inside_the_grant() {
    let (door, port) = door();
    seed(&door);
    let approved = add_task(&door, "/work/hivra", "Approved task");
    let (_client, read) = login(&door, port, &["hivra"], false);
    let (_writer, write) = login(&door, port, &["hivra"], true);
    assert_eq!(write.scope, "hivra:read tasks:write");
    let listed = mcp(
        port,
        Some(&write.access),
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        &[],
    );
    let names: Vec<_> = tool_body(&listed)["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"create_task".to_string()));
    assert!(names.contains(&"update_task".to_string()));
    assert!(tool_body(&mcp(
        port,
        Some(&read.access),
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        &[],
    ))["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["name"] != "create_task" && tool["name"] != "update_task"));

    let refused = tool_body(&call_tool(
        port,
        &read.access,
        "update_task",
        json!({"task_id": approved, "expected_version": 1, "title": "Stolen"}),
    ));
    assert!(refused.get("error").is_some(), "{refused}");

    let current = tool_body(&call_tool(
        port,
        &write.access,
        "get_task",
        json!({"task_id": approved}),
    ));
    let version = current["result"]["structuredContent"]["version"]
        .as_i64()
        .unwrap();
    let renamed = tool_body(&call_tool(
        port,
        &write.access,
        "update_task",
        json!({"task_id": approved, "expected_version": version, "title": "Renamed task"}),
    ));
    assert_eq!(renamed["result"]["isError"], false, "{renamed}");
    assert_eq!(
        renamed["result"]["structuredContent"]["title"],
        "Renamed task"
    );
    let stale = tool_body(&call_tool(
        port,
        &write.access,
        "update_task",
        json!({"task_id": approved, "expected_version": version, "title": "Old again"}),
    ));
    assert_eq!(stale["result"]["isError"], true, "{stale}");
    let kept = tool_body(&call_tool(
        port,
        &write.access,
        "get_task",
        json!({"task_id": approved}),
    ));
    assert_eq!(kept["result"]["structuredContent"]["title"], "Renamed task");

    let before = task_count(&door);
    let outside = call_tool(
        port,
        &write.access,
        "create_task",
        json!({"project_id": "secret", "title": "Foreign title"}),
    );
    assert_eq!(
        tool_body(&outside)["result"]["isError"],
        true,
        "{}",
        text_of(&outside)
    );
    assert!(!text_of(&outside).contains("Foreign title"));
    assert_eq!(task_count(&door), before);
    let created = tool_body(&call_tool(
        port,
        &write.access,
        "create_task",
        json!({"project_id": "hivra", "title": "From the tool"}),
    ));
    assert_eq!(
        created["result"]["structuredContent"]["title"],
        "From the tool"
    );
    assert_eq!(
        created["result"]["structuredContent"]["projectId"],
        "/work/hivra"
    );
}

#[test]
fn docs_and_current_work_stay_inside_the_grant() {
    let (door, port) = door();
    seed(&door);
    door.with_conn(|conn| {
        crate::notes::ensure_notes_table(conn).unwrap();
        conn.execute(
            "INSERT INTO notes (id, slug, title, body, source_cwd, created_at, updated_at) VALUES
             ('doc-1', 'door', 'Door notes', 'The door notes', '/work/hivra', 1, 2),
             ('doc-2', 'secret', 'Secret doc', 'SECRET DOC BODY', '/work/secret', 1, 2),
             ('doc-3', 'loose', 'Loose', 'UNSCOPED DOC', NULL, 1, 2)",
            [],
        )
        .unwrap();
        crate::delegations::ensure_tables(conn).unwrap();
        conn.execute(
            "INSERT INTO delegations (
               id, owner_session, owner_mono, root_id, child_session, request_id, state, delivery,
               created_at, updated_at, project, title, brief, result, pending_question
             ) VALUES
             ('d1', 'sess', 'Ada', 'd1', 'child', 'r1', 'running', 'keep', 1, 5, '/work/hivra', 'Writing the door', 'SECRET BRIEF', 'SECRET RESULT', 'SECRET QUESTION'),
             ('d2', 'sess', 'Bea', 'd2', 'child-2', 'r2', 'running', 'keep', 1, 5, '/work/secret', 'Secret work', 'SECRET BRIEF', 'SECRET RESULT', 'SECRET QUESTION'),
             ('d3', 'sess', 'Ada', 'd3', 'child-3', 'r3', 'done', 'keep', 1, 4, '/work/hivra', 'Finished work', '', '', '')",
            [],
        )
        .unwrap();
    })
    .unwrap();
    let (_client, tokens) = login(&door, port, &["hivra"], false);
    let docs = tool_body(&call_tool(port, &tokens.access, "list_docs", json!({})));
    let titles: Vec<_> = docs["result"]["structuredContent"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["title"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(titles, vec!["Door notes".to_string()]);
    assert!(!text_of(&call_tool(port, &tokens.access, "list_docs", json!({}))).contains("body"));
    let readable = text_of(&call_tool(
        port,
        &tokens.access,
        "get_doc",
        json!({"doc_id": "doc-1"}),
    ));
    assert!(readable.contains("The door notes"), "{readable}");
    let hidden = text_of(&call_tool(
        port,
        &tokens.access,
        "get_doc",
        json!({"doc_id": "doc-2"}),
    ));
    assert!(hidden.contains("Doc is not available."), "{hidden}");
    assert!(!hidden.contains("SECRET DOC BODY"), "{hidden}");
    let loose = text_of(&call_tool(
        port,
        &tokens.access,
        "get_doc",
        json!({"doc_id": "doc-3"}),
    ));
    assert!(!loose.contains("UNSCOPED DOC"), "{loose}");

    let work = text_of(&call_tool(port, &tokens.access, "current_work", json!({})));
    assert!(work.contains("Ada"), "{work}");
    assert!(work.contains("Writing the door"), "{work}");
    assert!(!work.contains("SECRET BRIEF"), "{work}");
    assert!(!work.contains("SECRET RESULT"), "{work}");
    assert!(!work.contains("SECRET QUESTION"), "{work}");
    assert!(!work.contains("Secret work"), "{work}");
    assert!(!work.contains("Finished work"), "{work}");
}

#[test]
fn one_granted_task_has_no_next_page_when_a_secret_task_exists() {
    let (door, port) = door();
    seed(&door);
    add_task(&door, "/work/hivra", "Approved task");
    add_task(&door, "/work/secret", "Secret task");
    let (_client, tokens) = login(&door, port, &["hivra"], false);
    let page = tool_body(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"limit": 1}),
    ));
    assert_eq!(
        page["result"]["structuredContent"]["items"][0]["title"],
        "Approved task"
    );
    assert!(page["result"]["structuredContent"]["next_cursor"].is_null());
    assert!(!text_of(&call_tool(
        port,
        &tokens.access,
        "list_tasks",
        json!({"limit": 1})
    ))
    .contains("Secret task"));
}

#[test]
fn the_app_can_approve_without_the_browser_token() {
    let (door, port) = door();
    seed(&door);
    let (_verifier, challenge) = challenge();
    let client = client_id(port);
    let request = authorize(port, &client, &challenge);
    let result = super::decide_local(&door, &request, true, &["hivra".to_string()], false).unwrap();
    assert!(
        result.redirect_uri.contains("code="),
        "{}",
        result.redirect_uri
    );
    let pending = door
        .with_conn(|conn| super::pending_page(conn, super::now_ms()))
        .unwrap()
        .unwrap();
    assert!(pending.requests.is_empty());
    let grants = door
        .with_conn(|conn| super::grant_views(conn))
        .unwrap()
        .unwrap();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].client_name, "Desk");
    assert_eq!(grants[0].projects, vec!["Hivra".to_string()]);
    assert!(!grants[0].write);
    assert!(grants[0].last_used_at.is_none());
}

/// The steps a program on this computer would take: read the request id from
/// the authorize redirect, ask the consent page for JSON, and post an approval.
/// Orbit answers that with 401 because there is no logged-in session.
#[test]
fn a_program_cannot_approve_its_own_grant() {
    let (door, port) = door();
    seed(&door);
    let (_verifier, challenge) = challenge();
    let client = client_id(port);
    let request = authorize(port, &client, &challenge);
    let origin = format!("http://127.0.0.1:{port}");

    let api = send(
        port,
        "GET",
        &format!("/oauth/consent/{request}"),
        &[("accept", "application/json")],
        &[],
        None,
        None,
    );
    assert_eq!(api.status, 401, "{}", text_of(&api));
    assert_eq!(json_of(&api)["error"], "login_required");
    let api_body = text_of(&api);
    assert!(!api_body.contains("csrf"), "{api_body}");
    assert!(!api_body.contains("secret"), "{api_body}");
    assert!(!api_body.contains("hivra"), "{api_body}");

    let page = send(
        port,
        "GET",
        &format!("/oauth/consent/{request}"),
        &[("accept", "text/html")],
        &[],
        None,
        None,
    );
    assert_eq!(page.status, 200, "{}", text_of(&page));
    let html = text_of(&page);
    assert!(!html.contains("secret"), "{html}");
    assert!(!html.contains("csrf"), "{html}");
    assert!(!html.contains("project_id"), "{html}");
    assert!(!html.to_ascii_lowercase().contains("<form"), "{html}");

    let posted = serde_json::to_vec(&json!({
        "approved": true,
        "csrf_token": "hivra-csrf-stolen",
        "project_ids": ["hivra", "secret"],
        "write": true
    }))
    .unwrap();
    let post = send(
        port,
        "POST",
        &format!("/oauth/consent/{request}"),
        &[
            ("content-type", "application/json"),
            ("origin", &origin),
            ("accept", "application/json"),
        ],
        &posted,
        None,
        None,
    );
    assert_eq!(post.status, 401, "{}", text_of(&post));
    assert_eq!(json_of(&post)["error"], "login_required");

    let form_post = send(
        port,
        "POST",
        &format!("/oauth/consent/{request}"),
        &[
            ("content-type", "application/x-www-form-urlencoded"),
            ("origin", &origin),
        ],
        b"approved=true&csrf_token=x&project_id=hivra&project_id=secret&write=1",
        None,
        None,
    );
    assert_eq!(form_post.status, 401, "{}", text_of(&form_post));

    door.with_conn(|conn| {
        let grants: i64 = conn
            .query_row("SELECT COUNT(*) FROM outside_grants", [], |row| row.get(0))
            .unwrap();
        assert_eq!(grants, 0);
        let codes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outside_requests WHERE code_hash IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(codes, 0);
    })
    .unwrap();

    // The person's later Allow in the app still works. The program did not spend it.
    let redirect =
        super::decide_local(&door, &request, true, &["hivra".to_string()], false).unwrap();
    assert!(
        redirect.redirect_uri.contains("code="),
        "{}",
        redirect.redirect_uri
    );
}

/// Allow in the app must send the browser Claude opened to the client's callback.
/// A JSON poll must not be able to take that redirect first, and a second load
/// must not hand the code out again.
#[test]
fn allow_sends_the_open_browser_to_the_callback() {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let callback_port = listener.local_addr().unwrap().port();
    let redirect_uri = format!("http://127.0.0.1:{callback_port}/cb");

    let (door, port) = door();
    seed(&door);
    let (verifier, challenge) = challenge();
    let registered = register(port, "Desk", &redirect_uri);
    assert_eq!(registered.status, 201, "{}", text_of(&registered));
    let client = json_of(&registered)["client_id"]
        .as_str()
        .unwrap()
        .to_string();
    let resource = format!("http://127.0.0.1:{port}/mcp");
    let query = form(&[
        ("response_type", "code"),
        ("client_id", &client),
        ("redirect_uri", &redirect_uri),
        ("state", "s1"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("scope", "hivra:read"),
        ("resource", &resource),
    ]);
    let started = send(
        port,
        "GET",
        &format!("/oauth/authorize?{query}"),
        &[],
        &[],
        None,
        None,
    );
    assert_eq!(started.status, 302, "{}", text_of(&started));
    let request = url::Url::parse(header(&started, "location"))
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "request")
        .unwrap()
        .1
        .to_string();

    let result = super::decide_local(&door, &request, true, &["hivra".to_string()], false).unwrap();
    let code = code_from(&result.redirect_uri);

    // The program's JSON poll neither reveals the code nor uses up the redirect.
    let polled = send(
        port,
        "GET",
        &format!("/oauth/consent/{request}"),
        &[("accept", "application/json")],
        &[],
        None,
        None,
    );
    assert_eq!(polled.status, 401, "{}", text_of(&polled));
    assert!(!text_of(&polled).contains(&code));

    let browser = send(
        port,
        "GET",
        &format!("/oauth/consent/{request}"),
        &[("accept", "text/html")],
        &[],
        None,
        None,
    );
    assert_eq!(browser.status, 302, "{}", text_of(&browser));
    let location = header(&browser, "location").to_string();
    assert!(location.starts_with(&redirect_uri), "{location}");
    let query = |name: &str| -> String {
        url::Url::parse(&location)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default()
    };
    assert_eq!(query("code"), code, "{location}");
    assert_eq!(query("state"), "s1", "{location}");
    assert_eq!(
        query("iss"),
        format!("http://127.0.0.1:{port}"),
        "{location}"
    );

    let seen = follow_redirect(&listener, &location);
    assert!(seen.contains(&format!("code={code}")), "{seen}");
    assert!(seen.contains("state=s1"), "{seen}");

    let again = send(
        port,
        "GET",
        &format!("/oauth/consent/{request}"),
        &[("accept", "text/html")],
        &[],
        None,
        None,
    );
    assert_ne!(again.status, 302, "{}", text_of(&again));
    assert!(!text_of(&again).contains(&code), "{}", text_of(&again));
    assert!(!header(&again, "location").contains(&code));

    let body = form(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect_uri),
        ("client_id", &client),
        ("code_verifier", &verifier),
        ("resource", &resource),
    ]);
    let traded = send(
        port,
        "POST",
        "/oauth/token",
        &[("content-type", "application/x-www-form-urlencoded")],
        body.as_bytes(),
        None,
        None,
    );
    let tokens = tokens_from(&traded);
    assert_eq!(tokens.scope, "hivra:read");
}

/// A redirect older than the code is not sent, and the code is not left on the page.
#[test]
fn an_expired_approval_is_not_sent_to_the_browser() {
    let (door, port) = door();
    seed(&door);
    let (_verifier, challenge) = challenge();
    let client = client_id(port);
    let request = authorize(port, &client, &challenge);
    let result = super::decide_local(&door, &request, true, &["hivra".to_string()], false).unwrap();
    let code = code_from(&result.redirect_uri);
    {
        let mut waiting = super::lock_redirects(&door.redirects);
        waiting.get_mut(&request).unwrap().until = 0;
    }
    let browser = send(
        port,
        "GET",
        &format!("/oauth/consent/{request}"),
        &[("accept", "text/html")],
        &[],
        None,
        None,
    );
    assert_ne!(browser.status, 302, "{}", text_of(&browser));
    assert!(!text_of(&browser).contains(&code), "{}", text_of(&browser));
    assert!(!header(&browser, "location").contains(&code));
}

/// One browser follows the callback. A second load must not be able to present
/// the same code to the client's listener and trip reuse-revoke.
fn follow_redirect(listener: &std::net::TcpListener, location: &str) -> String {
    let url = url::Url::parse(location).unwrap();
    let port = url.port().unwrap();
    let path = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };
    let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    client.write_all(request.as_bytes()).unwrap();
    let (mut incoming, _) = listener.accept().unwrap();
    let mut buf = [0u8; 4096];
    let n = incoming.read(&mut buf).unwrap();
    let seen = String::from_utf8_lossy(&buf[..n]).to_string();
    let _ =
        incoming.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let _ = client.read(&mut buf);
    seen
}

/// A directory under the temp folder, with a space and a non-ascii name, removed
/// only if it is still inside that temp folder.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("hivra outside 門 {}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap_or_else(|err| panic!("scratch dir: {err}"));
        Self(path)
    }

    fn db(&self) -> PathBuf {
        self.0.join("monocode.db")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let temp = std::env::temp_dir();
        if self.0.starts_with(&temp) && self.0 != temp {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

/// One port the OS picks for this test. The listener stays bound until
/// `release`, so the port is taken for that whole time.
///
/// The number comes from binding port 0 and reading it back, never from a
/// range the test walks. A range walked from its first number hands the same
/// port to two copies of this module at once — two overlapping `cargo test`
/// runs — and the copy that loses the race to bind it fails with "already in
/// use". Asking the OS, separately in each process, cannot do that. Ports
/// picked this way are ephemeral (49152 and up on macOS, 32768 and up on
/// Linux), above both the daily and dev ranges; an OS configured lower gets
/// asked again.
struct HeldPort {
    port: u16,
    listener: Option<TcpListener>,
}

impl HeldPort {
    fn reserve() -> Self {
        for _ in 0..16 {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .unwrap_or_else(|err| panic!("ask the OS for a port: {err}"));
            let port = listener
                .local_addr()
                .unwrap_or_else(|err| panic!("read back the port: {err}"))
                .port();
            if super::DAILY_PORTS.contains(&port) || super::DEV_PORTS.contains(&port) {
                drop(listener);
                continue;
            }
            return Self {
                port,
                listener: Some(listener),
            };
        }
        panic!("the OS kept handing out ports inside this app's ranges");
    }

    fn release(&mut self) {
        self.listener.take();
    }
}

fn must_init_ports(path: PathBuf, kind: Kind, ports: &[u16]) -> Outside {
    match super::init_ports(path, kind, ports) {
        Ok(door) => door,
        Err(err) => panic!("startup returned an error: {err}"),
    }
}

/// Save `port` and leave the door switched on, without binding it.
fn remember_port(path: &Path, port: u16) {
    let door = Outside::open(path.to_path_buf(), Kind::Daily, &[])
        .unwrap_or_else(|err| panic!("open: {err}"));
    door.with_conn(|conn| {
        super::store::set_enabled(conn, true)?;
        if !super::store::insert_port_if_empty(conn, port)? {
            return Err("the port was already saved".to_string());
        }
        Ok(())
    })
    .unwrap_or_else(|err| panic!("write: {err}"))
    .unwrap_or_else(|err| panic!("settings: {err}"));
}

fn must_init(path: PathBuf, kind: Kind) -> Outside {
    match super::init_at(path, kind) {
        Ok(door) => door,
        Err(err) => panic!("startup returned an error: {err}"),
    }
}

fn saved_port(path: &Path) -> Option<String> {
    let door = Outside::open(path.to_path_buf(), Kind::Daily, &[])
        .unwrap_or_else(|err| panic!("open: {err}"));
    door.with_conn(|conn| super::store::raw_setting(conn, "port"))
        .unwrap_or_else(|err| panic!("read: {err}"))
        .unwrap_or_else(|err| panic!("setting: {err}"))
}

fn problem_of(door: &Outside) -> super::DoorStatus {
    door.status().unwrap_or_else(|err| panic!("status: {err}"))
}

/// Startup must not fail when the database cannot be opened. The door says why.
#[test]
fn init_still_opens_when_the_database_cannot() {
    let scratch = Scratch::new();
    let blocker = scratch.0.join("not a directory");
    std::fs::write(&blocker, b"x").unwrap();
    let db = blocker.join("monocode.db");
    let door = must_init(db, Kind::Daily);
    let status = problem_of(&door);
    let problem = status.problem.expect("the door should say why");
    assert!(problem.starts_with("couldn't start: "), "{problem}");
    assert!(problem.len() > "couldn't start: ".len(), "{problem}");
    assert!(!status.enabled);
    assert!(status.url.is_none());
    assert!(!status.port_taken);
    assert!(door.port().is_none());
    assert!(door.noted("couldn't start"), "the failure should be logged");
}

/// Startup must not fail when the saved port is already taken. The door names it.
#[test]
fn init_still_opens_when_the_port_cannot_be_bound() {
    let held = HeldPort::reserve();
    let scratch = Scratch::new();
    let db = scratch.db();
    remember_port(&db, held.port);
    let door = must_init_ports(db.clone(), Kind::Daily, &[held.port]);
    let status = problem_of(&door);
    let problem = status.problem.expect("the door should say why");
    assert!(problem.starts_with("couldn't start: "), "{problem}");
    assert!(problem.contains(&held.port.to_string()), "{problem}");
    assert!(status.port_taken, "{problem}");
    assert!(status.enabled);
    assert!(status.url.is_none());
    assert!(door.port().is_none());
    assert_eq!(
        saved_port(&db).as_deref(),
        Some(held.port.to_string()).as_deref()
    );
    assert!(door.noted("couldn't start"), "the failure should be logged");
}

/// The address given to `claude mcp add` survives a restart.
#[test]
fn the_door_uses_the_same_port_after_a_restart() {
    let mut held = HeldPort::reserve();
    let port = held.port;
    let ports = [port];
    held.release();
    let scratch = Scratch::new();
    let db = scratch.db();
    let first = Outside::open(db.clone(), Kind::Daily, &ports).unwrap();
    let status = first.set_enabled(true).unwrap();
    assert_eq!(first.port(), Some(port));
    let url = status.url.expect("an enabled door has an address");
    assert!(url.contains(&format!(":{port}/")), "{url}");
    drop(first);
    // A restart starts after the old app is gone. Dropping a door lets its listener go from its own thread, a moment
    // after the drop (longer on a busy machine), so wait for that before the second start.
    drop(bind_when_released(port, "the first door"));

    let second = must_init_ports(db.clone(), Kind::Daily, &ports);
    assert_eq!(second.port(), Some(port));
    let again = problem_of(&second);
    assert_eq!(again.url.as_deref(), Some(url.as_str()));
    assert!(again.problem.is_none());
    assert!(!again.port_taken);
    assert_eq!(
        saved_port(&db).as_deref(),
        Some(port.to_string()).as_deref()
    );
}

/// Switching the door off does not forget the port the person already gave out.
#[test]
fn turning_the_door_off_and_on_keeps_the_port() {
    let mut held = HeldPort::reserve();
    let port = held.port;
    let ports = [port];
    held.release();
    let scratch = Scratch::new();
    let door = Outside::open(scratch.db(), Kind::Daily, &ports).unwrap();
    door.set_enabled(true).unwrap();
    assert_eq!(door.port(), Some(port));
    door.set_enabled(false).unwrap();
    assert!(door.port().is_none());
    assert!(problem_of(&door).url.is_none());
    door.set_enabled(true).unwrap();
    assert_eq!(door.port(), Some(port));
    assert_eq!(
        saved_port(&scratch.db()).as_deref(),
        Some(port.to_string()).as_deref()
    );
}

/// Bind `port` once whoever held it has let go, waiting up to ten seconds for
/// a listener that closes from another thread (a busy machine is slow to run it).
/// Fails with the last error if it never frees, which is the real "still holds" failure.
fn bind_when_released(port: u16, who: &str) -> TcpListener {
    let mut waited = Duration::ZERO;
    loop {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            Ok(listener) => return listener,
            Err(err) if waited >= Duration::from_secs(10) => {
                panic!("{who} still holds {port}: {err}")
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(25));
                waited += Duration::from_millis(25);
            }
        }
    }
}

/// Two copies of the door's restart-and-toggle body, run at the same moment
/// the way two `cargo test` runs on one machine run it. Each copy asks the OS
/// for its own port and cannot be handed the other's, so both keep their port
/// across an off/on and a restart and both let it go at the end.
#[test]
fn two_copies_of_the_door_body_run_at_the_same_time() {
    let moment = Arc::new(Barrier::new(2));
    let copies: Vec<_> = (0..2)
        .map(|copy| {
            let moment = Arc::clone(&moment);
            std::thread::spawn(move || {
                let mut held = HeldPort::reserve();
                let port = held.port;
                let scratch = Scratch::new();
                let db = scratch.db();
                let ports = [port];
                // Both copies hold their port now, so the two differ.
                moment.wait();
                held.release();
                // And both start their door at the same moment.
                moment.wait();

                let door = Outside::open(db.clone(), Kind::Daily, &ports).unwrap();
                door.set_enabled(true).unwrap();
                assert_eq!(door.port(), Some(port), "copy {copy}");
                door.set_enabled(false).unwrap();
                assert!(door.port().is_none(), "copy {copy}");
                door.set_enabled(true).unwrap();
                assert_eq!(door.port(), Some(port), "copy {copy}");
                drop(door);
                // As in a real restart, the old door has let go before the new one starts.
                drop(bind_when_released(
                    port,
                    &format!("copy {copy}'s first door"),
                ));

                let restarted = must_init_ports(db.clone(), Kind::Daily, &ports);
                assert_eq!(restarted.port(), Some(port), "copy {copy}");
                assert!(problem_of(&restarted).problem.is_none(), "copy {copy}");
                drop(restarted);

                // Dropping a door lets its listener go from its own thread, so the
                // port frees a moment later, not at the drop. Wait for that moment.
                drop(bind_when_released(port, &format!("copy {copy}")));
                port
            })
        })
        .collect();
    let ports: Vec<u16> = copies
        .into_iter()
        .map(|copy| copy.join().expect("both copies finish"))
        .collect();
    assert_ne!(ports[0], ports[1], "the two copies picked the same port");
}

/// A dev copy is given the dev range, which does not meet the daily app's.
/// Opening the door does not bind: the range is recorded, not probed.
#[test]
fn a_dev_copy_never_binds_the_daily_range() {
    let scratch = Scratch::new();
    let door = must_init(scratch.db(), Kind::Dev);
    assert_eq!(door.kind(), Kind::Dev);
    assert_eq!(door.ports(), super::ports_for(Kind::Dev).as_slice());
    assert!(door.port().is_none(), "a door that is off binds nothing");
    assert!(!door.ports().is_empty());
    for port in door.ports() {
        assert!(super::DEV_PORTS.contains(port), "{port}");
        assert!(!super::DAILY_PORTS.contains(port), "{port}");
    }
    let daily_scratch = Scratch::new();
    let daily = must_init(daily_scratch.db(), Kind::Daily);
    assert_eq!(daily.ports(), super::ports_for(Kind::Daily).as_slice());
    for port in daily.ports() {
        assert!(super::DAILY_PORTS.contains(port), "{port}");
        assert!(!super::DEV_PORTS.contains(port), "{port}");
    }
}

/// A port saved from the daily range is not bound by a dev copy. The dev copy
/// binds a port it owns, then the same one again after a restart.
#[test]
fn a_dev_copy_does_not_bind_a_saved_daily_port() {
    let mut own = HeldPort::reserve();
    let port = own.port;
    own.release();
    let scratch = Scratch::new();
    let db = scratch.db();
    let daily_port = super::DAILY_PORTS.start;
    assert!(super::DAILY_PORTS.contains(&daily_port));
    assert!(!super::DEV_PORTS.contains(&daily_port));
    let door = Outside::open(db.clone(), Kind::Dev, &[port]).unwrap();
    door.with_conn(|conn| {
        super::store::set_enabled(conn, true)?;
        if !super::store::insert_port_if_empty(conn, daily_port)? {
            return Err("the port was already saved".to_string());
        }
        Ok(())
    })
    .unwrap()
    .unwrap();
    drop(door);

    let started = must_init_ports(db.clone(), Kind::Dev, &[port]);
    let bound = started
        .port()
        .expect("a dev copy still starts on its own port");
    assert_eq!(bound, port);
    assert_ne!(bound, daily_port);
    assert!(!super::DAILY_PORTS.contains(&bound), "{bound}");
    assert_eq!(
        saved_port(&db).as_deref(),
        Some(bound.to_string()).as_deref()
    );
    drop(started);

    let again = must_init_ports(db.clone(), Kind::Dev, &[port]);
    assert_eq!(again.port(), Some(port));
}

/// A value that is not a port in range is not bound. A real port is chosen instead.
#[test]
fn a_garbage_saved_port_is_not_bound() {
    let mut own = HeldPort::reserve();
    let port = own.port;
    own.release();
    let scratch = Scratch::new();
    let db = scratch.db();
    let door = Outside::open(db.clone(), Kind::Daily, &[port]).unwrap();
    door.with_conn(|conn| {
        super::store::set_enabled(conn, true)?;
        conn.execute(
            "INSERT INTO outside_settings (key, value) VALUES ('port', ?1)",
            params!["..\r\n0"],
        )
        .map_err(|err| err.to_string())?;
        Ok::<(), String>(())
    })
    .unwrap()
    .unwrap();
    drop(door);

    let started = must_init_ports(db.clone(), Kind::Daily, &[port]);
    let bound = started
        .port()
        .expect("a garbage port is replaced, not fatal");
    assert_eq!(bound, port);
    assert!(!super::DAILY_PORTS.contains(&bound) && !super::DEV_PORTS.contains(&bound));
    assert_eq!(
        saved_port(&db).as_deref(),
        Some(bound.to_string()).as_deref()
    );
    assert!(problem_of(&started).problem.is_none());
}

/// The saved port is not swapped for another one while something else holds it.
/// Asking for a new port is what moves it.
#[test]
fn a_taken_port_stays_put_until_a_new_one_is_asked_for() {
    let taken = HeldPort::reserve();
    let mut free = HeldPort::reserve();
    assert_ne!(taken.port, free.port);
    let scratch = Scratch::new();
    let db = scratch.db();
    let ports = [taken.port, free.port];
    remember_port(&db, taken.port);

    let door = must_init_ports(db.clone(), Kind::Daily, &ports);
    assert!(problem_of(&door).port_taken);
    assert_eq!(
        saved_port(&db).as_deref(),
        Some(taken.port.to_string()).as_deref()
    );
    assert!(door.port().is_none());

    // Released only once we ask. Until then the door has nowhere else to go,
    // and it must not take this port on its own.
    free.release();
    let moved = door.pick_new_port().unwrap();
    let next = door.port().expect("the new port is bound");
    assert_eq!(next, free.port);
    assert_ne!(next, taken.port);
    assert_eq!(moved.url.as_deref(), problem_of(&door).url.as_deref());
    assert!(moved.problem.is_none(), "{moved:?}");
    assert!(!moved.port_taken);
    assert_eq!(
        saved_port(&db).as_deref(),
        Some(next.to_string()).as_deref()
    );
    // The old port is still held. Nothing of ours took it.
    assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, taken.port)).is_err());
}

/// A working port is not moved just because something asked.
#[test]
fn asking_for_a_new_port_does_nothing_while_this_one_works() {
    let mut held = HeldPort::reserve();
    let port = held.port;
    let ports = [port];
    held.release();
    let scratch = Scratch::new();
    let door = Outside::open(scratch.db(), Kind::Daily, &ports).unwrap();
    door.set_enabled(true).unwrap();
    assert_eq!(door.port(), Some(port));
    let status = door.pick_new_port().unwrap();
    assert_eq!(door.port(), Some(port));
    assert!(status.problem.is_none());
    assert!(!status.port_taken);
    assert_eq!(
        saved_port(&scratch.db()).as_deref(),
        Some(port.to_string()).as_deref()
    );
}

/// Two doors on the same database: the second does not steal or replace the port.
#[test]
fn a_second_door_does_not_take_the_port_from_the_first() {
    let mut held = HeldPort::reserve();
    let port = held.port;
    let ports = [port];
    held.release();
    let scratch = Scratch::new();
    let db = scratch.db();
    let first = Outside::open(db.clone(), Kind::Daily, &ports).unwrap();
    first.set_enabled(true).unwrap();
    assert_eq!(first.port(), Some(port));

    let second = must_init_ports(db.clone(), Kind::Daily, &ports);
    let status = problem_of(&second);
    assert!(status.port_taken, "{status:?}");
    assert!(status.problem.unwrap().contains(&port.to_string()));
    assert!(second.port().is_none());
    assert_eq!(
        saved_port(&db).as_deref(),
        Some(port.to_string()).as_deref()
    );
    TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("the first door still has the port");
    assert_eq!(first.port(), Some(port));
}

/// Every port the door is allowed to use is busy, and nothing is saved yet.
/// Startup still returns, and no port is invented outside that list.
#[test]
fn no_free_port_is_reported_without_failing_startup() {
    let held = HeldPort::reserve();
    let scratch = Scratch::new();
    let db = scratch.db();
    let door = Outside::open(db.clone(), Kind::Daily, &[held.port]).unwrap();
    door.with_conn(|conn| super::store::set_enabled(conn, true))
        .unwrap()
        .unwrap();
    drop(door);

    let started = must_init_ports(db.clone(), Kind::Daily, &[held.port]);
    let status = problem_of(&started);
    let problem = status.problem.expect("the door should say why");
    assert!(problem.starts_with("couldn't start: "), "{problem}");
    assert!(status.enabled);
    assert!(status.url.is_none());
    assert!(started.port().is_none());
    assert!(saved_port(&db).is_none());
}
