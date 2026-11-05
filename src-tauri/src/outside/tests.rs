// Port of Orbit's oauth_api and mcp_api checks (Apache-2.0). Hivra has no
// session cookie, chat tool or delete_task, so those cases are not here.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::time::Duration;

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

fn csrf_of(port: u16, request: &str) -> String {
    let res = send(
        port,
        "GET",
        &format!("/oauth/consent/{request}"),
        &[("accept", "application/json")],
        &[],
        None,
        None,
    );
    assert_eq!(res.status, 200, "{}", text_of(&res));
    json_of(&res)["csrf_token"].as_str().unwrap().to_string()
}

fn consent(
    port: u16,
    request: &str,
    csrf: &str,
    projects: &[&str],
    write: bool,
    approved: bool,
) -> Res {
    let origin = format!("http://127.0.0.1:{port}");
    let body = serde_json::to_vec(&json!({
        "approved": approved,
        "csrf_token": csrf,
        "project_ids": projects,
        "write": write
    }))
    .unwrap();
    send(
        port,
        "POST",
        &format!("/oauth/consent/{request}"),
        &[("content-type", "application/json"), ("origin", &origin)],
        &body,
        None,
        None,
    )
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

fn login(port: u16, projects: &[&str], write: bool) -> (String, Tokens) {
    let (verifier, challenge) = challenge();
    let client = client_id(port);
    let request = authorize(port, &client, &challenge);
    let csrf = csrf_of(port, &request);
    let agreed = consent(port, &request, &csrf, projects, write, true);
    assert_eq!(agreed.status, 200, "{}", text_of(&agreed));
    let redirect = json_of(&agreed)["redirect_uri"]
        .as_str()
        .unwrap()
        .to_string();
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
    let door = Outside::open_memory().unwrap();
    let status = door.status().unwrap();
    assert!(!status.enabled);
    assert!(status.url.is_none());
    assert!(door.port().is_none());

    let on = door.set_enabled(true).unwrap();
    assert!(on.enabled);
    let url = on.url.unwrap();
    let port: u16 = url
        .trim_start_matches("http://127.0.0.1:")
        .trim_end_matches("/mcp")
        .parse()
        .unwrap();
    assert_eq!(
        door.set_enabled(true).unwrap().url.as_deref(),
        Some(url.as_str())
    );

    let other = Outside::open_memory().unwrap();
    let other_port = other.start().unwrap();
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
    assert!(super::port_is_free(port));
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

    let (_client, tokens) = login(port, &["hivra"], false);
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
    let csrf = csrf_of(port, &request);
    let agreed = consent(port, &request, &csrf, &["hivra"], false, true);
    let code = code_from(json_of(&agreed)["redirect_uri"].as_str().unwrap());
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
    let (_door, port) = door();
    seed(&_door);
    let (client, tokens) = login(port, &["hivra"], false);
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

    let (_client2, write_tokens) = login(port, &["hivra"], false);
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
    let (_door, port) = door();
    seed(&_door);
    let (_verifier, challenge) = challenge();
    let client = client_id(port);
    let request = authorize(port, &client, &challenge);
    let csrf = csrf_of(port, &request);
    let bad = consent(port, &request, "hivra-csrf-nope", &["hivra"], false, true);
    assert_eq!(bad.status, 400);
    let missing = consent(port, &request, &csrf, &["not-a-project"], false, true);
    assert_eq!(missing.status, 400);
    let folder = consent(port, &request, &csrf, &["/work/hivra"], false, true);
    assert_eq!(folder.status, 400);
    let denied = consent(port, &request, &csrf, &[], false, false);
    assert_eq!(denied.status, 200, "{}", text_of(&denied));
    assert!(json_of(&denied)["redirect_uri"]
        .as_str()
        .unwrap()
        .contains("error=access_denied"));
    let again = consent(port, &request, &csrf, &[], false, false);
    assert_eq!(again.status, 400);
}

#[test]
fn an_expired_access_token_refreshes_and_disconnect_kills_both() {
    let (door, port) = door();
    seed(&door);
    let (client, tokens) = login(port, &["hivra"], false);
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
    let (_client, tokens) = login(port, &["hivra"], false);
    let (_other_client, other) = login(port, &["secret"], false);

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
    let (_client, tokens) = login(port, &["hivra"], false);
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
    let (_client, read) = login(port, &["hivra"], false);
    let (_writer, write) = login(port, &["hivra"], true);
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
    let (_client, tokens) = login(port, &["hivra"], false);
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
    let (_client, tokens) = login(port, &["hivra"], false);
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
