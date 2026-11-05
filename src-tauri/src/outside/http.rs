// Copyright 2026 The Hivra authors.
// SPDX-License-Identifier: Apache-2.0
//
// Translated from Orbit (Apache-2.0, https://github.com/coollabsio/orbit)
// crates/platform/src/http/security.rs. Hivra has no axum, so this is a small
// HTTP/1.1 server bound to 127.0.0.1. A missing Origin is allowed only on
// POST /mcp. The body limit is refused before the body is read.

use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::mcp;
use super::oauth::{self, Reply};
use super::security::{self, MCP_BODY_LIMIT, OAUTH_BODY_LIMIT};
use super::{now_ms, with_db, DbInner};

const HEADER_LIMIT: usize = 16 * 1024;

struct Asked {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

enum ReadStop {
    Bad,
    TooLarge,
}

pub(crate) enum Listen {
    /// The OS picks. A memory door has nothing to reuse, so tests can run side by side.
    Ephemeral,
    /// The saved port. Never try another one.
    Exact(u16),
    /// The first free port in this list, in order. Used only when nothing valid
    /// is saved yet. Production passes the copy's range. A test passes the ports
    /// it reserved, and no others.
    FirstFree(Vec<u16>),
}

pub(crate) enum ListenError {
    Taken(u16),
    NoneFree,
    Other(String),
}

pub(crate) fn serve(
    db: Arc<DbInner>,
    stop: Arc<AtomicBool>,
    redirects: super::Redirects,
    listen: Listen,
) -> Result<(u16, JoinHandle<()>), ListenError> {
    let (listener, port) = bind_listener(listen)?;
    listener
        .set_nonblocking(true)
        .map_err(|err| ListenError::Other(err.to_string()))?;
    let handle = thread::Builder::new()
        .name("hivra-outside".into())
        .spawn(move || accept_loop(listener, db, stop, redirects, port))
        .map_err(|err| ListenError::Other(err.to_string()))?;
    Ok((port, handle))
}

fn bind_listener(listen: Listen) -> Result<(TcpListener, u16), ListenError> {
    match listen {
        Listen::Ephemeral => {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .map_err(|err| ListenError::Other(err.to_string()))?;
            let port = listener
                .local_addr()
                .map_err(|err| ListenError::Other(err.to_string()))?
                .port();
            Ok((listener, port))
        }
        Listen::Exact(port) => match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            Ok(listener) => Ok((listener, port)),
            Err(err) if err.kind() == ErrorKind::AddrInUse => Err(ListenError::Taken(port)),
            Err(err) => Err(ListenError::Other(err.to_string())),
        },
        Listen::FirstFree(ports) => {
            for port in ports {
                match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
                    Ok(listener) => return Ok((listener, port)),
                    Err(err) if err.kind() == ErrorKind::AddrInUse => continue,
                    Err(err) => return Err(ListenError::Other(err.to_string())),
                }
            }
            Err(ListenError::NoneFree)
        }
    }
}

fn accept_loop(
    listener: TcpListener,
    db: Arc<DbInner>,
    stop: Arc<AtomicBool>,
    redirects: super::Redirects,
    port: u16,
) {
    // Joined before this function returns. A detached handler keeps its accepted
    // socket, and on macOS that socket holds the port: the listener can be closed
    // and a new one still cannot bind. Turning the door off has to let the port go.
    let mut handlers: Vec<JoinHandle<()>> = Vec::new();
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, addr)) => {
                if !addr.ip().is_loopback() {
                    continue;
                }
                // The listener is nonblocking, and an accepted socket keeps that.
                // A read then returns immediately with nothing in it, which is not
                // a bad request.
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                let db = Arc::clone(&db);
                let redirects = Arc::clone(&redirects);
                handlers.retain(|handle| !handle.is_finished());
                handlers.push(thread::spawn(move || {
                    let _ = handle_client(stream, addr, &db, &redirects, port);
                }));
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    drop(listener);
    for handle in handlers {
        let _ = handle.join();
    }
}

fn handle_client(
    mut stream: TcpStream,
    addr: SocketAddr,
    db: &DbInner,
    redirects: &super::Redirects,
    port: u16,
) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let origin = format!("http://127.0.0.1:{port}");
    let host = format!("127.0.0.1:{port}");
    let ip = match addr.ip() {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => ip.to_string(),
    };
    let reply = match read_request(&mut stream) {
        Err(ReadStop::TooLarge) => Reply::json(413, json!({ "error": "request_too_large" })),
        Err(ReadStop::Bad) => Reply::empty(400),
        Ok(asked) => dispatch(db, redirects, &asked, &origin, &host, &ip),
    };
    write_reply(&mut stream, &reply)
}

fn read_request(stream: &mut TcpStream) -> Result<Asked, ReadStop> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= HEADER_LIMIT {
            return Err(ReadStop::Bad);
        }
        match stream.read(&mut byte) {
            Ok(0) => return Err(ReadStop::Bad),
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ReadStop::Bad),
            Ok(_) => buf.push(byte[0]),
        }
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let Some(start) = lines.next() else {
        return Err(ReadStop::Bad);
    };
    let mut parts = start.split(' ');
    let (Some(method), Some(target), Some(_)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(ReadStop::Bad);
    };
    let (path, query_raw) = target.split_once('?').unwrap_or((target, ""));
    if !path.starts_with('/') || path.contains("..") {
        return Err(ReadStop::Bad);
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(ReadStop::Bad);
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    if headers.iter().any(|(name, value)| {
        name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked")
    }) {
        return Err(ReadStop::Bad);
    }
    let lengths = headers
        .iter()
        .filter(|(name, _)| name == "content-length")
        .map(|(_, value)| value.parse::<u64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ReadStop::Bad)?;
    if lengths.len() > 1 {
        return Err(ReadStop::Bad);
    }
    let length = lengths.first().copied().unwrap_or(0);
    let limit = if path == "/mcp" {
        MCP_BODY_LIMIT
    } else {
        OAUTH_BODY_LIMIT
    } as u64;
    if length > limit {
        return Err(ReadStop::TooLarge);
    }
    let mut body = vec![0u8; length as usize];
    if !body.is_empty() {
        stream.read_exact(&mut body).map_err(|_| ReadStop::Bad)?;
    }
    let query = url::form_urlencoded::parse(query_raw.as_bytes())
        .into_owned()
        .collect();
    Ok(Asked {
        method: method.to_ascii_uppercase(),
        path: path.to_string(),
        query,
        headers,
        body,
    })
}

fn header_values<'a>(headers: &'a [(String, String)], name: &str) -> Vec<&'a str> {
    headers
        .iter()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
        .collect()
}

fn one_header(headers: &[(String, String)], name: &str) -> Option<String> {
    let values = header_values(headers, name);
    (values.len() == 1).then(|| values[0].to_string())
}

fn is_public(path: &str) -> bool {
    matches!(path, "/oauth/register" | "/oauth/token" | "/oauth/revoke")
        || path.starts_with("/.well-known/")
}

fn dispatch(
    db: &DbInner,
    redirects: &super::Redirects,
    asked: &Asked,
    origin: &str,
    host: &str,
    ip: &str,
) -> Reply {
    let hosts = header_values(&asked.headers, "host");
    if hosts.len() != 1 || hosts[0] != host {
        return Reply::empty(403);
    }
    let public = is_public(&asked.path);
    if asked.method == "OPTIONS" && public {
        return finish(Reply::empty(204), true);
    }
    let origins: Vec<String> = header_values(&asked.headers, "origin")
        .into_iter()
        .map(str::to_string)
        .collect();
    if !security::origin_allowed(&asked.path, &asked.method, &origins, origin) {
        return Reply::empty(403);
    }
    if asked.path.starts_with("/oauth/consent") {
        return finish(consent(db, redirects, asked), false);
    }
    match with_db(db, |conn| route(conn, asked, origin, ip, now_ms())) {
        Ok(reply) => finish(reply, public),
        Err(err) => finish(
            Reply::json(
                500,
                json!({"error": "server_error", "error_description": err}),
            ),
            public,
        ),
    }
}

fn finish(mut reply: Reply, public: bool) -> Reply {
    if public {
        reply
            .headers
            .push(("access-control-allow-origin".into(), "*".into()));
        reply.headers.push((
            "access-control-allow-methods".into(),
            "GET, POST, OPTIONS".into(),
        ));
        reply.headers.push((
            "access-control-allow-headers".into(),
            "Content-Type, Authorization".into(),
        ));
    }
    reply
}

fn route(conn: &mut Connection, asked: &Asked, origin: &str, ip: &str, now: i64) -> Reply {
    let path = asked.path.as_str();
    match (asked.method.as_str(), path) {
        ("GET", "/.well-known/oauth-authorization-server") => oauth::discovery(origin),
        ("GET", "/.well-known/oauth-protected-resource/mcp") => oauth::resource_metadata(origin),
        ("POST", "/oauth/register") => oauth::register(conn, &json_body(&asked.body), now, ip),
        ("GET", "/oauth/authorize") => oauth::authorize(conn, &asked.query, origin, now),
        ("POST", "/oauth/token") => oauth::token(conn, &form_body(&asked.body), now),
        ("POST", "/oauth/revoke") => oauth::revoke_token(conn, &form_body(&asked.body), now),
        ("DELETE", path) if path.starts_with("/oauth/grants/") => {
            let id = &path["/oauth/grants/".len()..];
            if id.is_empty() || id.contains('/') {
                return Reply::empty(404);
            }
            match oauth::disconnect(conn, id, now) {
                Ok(true) => Reply::empty(204),
                Ok(false) => Reply::empty(404),
                Err(err) => Reply::json(
                    500,
                    json!({"error": "server_error", "error_description": err}),
                ),
            }
        }
        ("POST", "/mcp") => mcp_post(conn, asked, origin, now),
        (_, "/mcp") => Reply::empty(405),
        _ => Reply::empty(404),
    }
}

fn json_body(body: &[u8]) -> Value {
    if body.is_empty() {
        return Value::Null;
    }
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn form_body(body: &[u8]) -> Vec<(String, String)> {
    url::form_urlencoded::parse(body).into_owned().collect()
}

fn consent_id(path: &str, query: &[(String, String)]) -> String {
    let rest = path
        .trim_start_matches("/oauth/consent")
        .trim_start_matches('/');
    if !rest.is_empty() {
        return rest.to_string();
    }
    query
        .iter()
        .find(|(key, _)| key == "request")
        .map(|(_, value)| value.clone())
        .unwrap_or_default()
}

/// JSON and POST are the program's path. They are 401, and they do not take
/// the redirect the browser is waiting on. The browser holds the redirect lock
/// across the database read so it cannot miss a decision that just landed.
fn consent(db: &DbInner, redirects: &super::Redirects, asked: &Asked) -> Reply {
    if asked.method != "GET" {
        return oauth::login_required();
    }
    let wants_json = one_header(&asked.headers, "accept")
        .unwrap_or_default()
        .contains("application/json");
    if wants_json {
        return oauth::login_required();
    }
    let id = consent_id(&asked.path, &asked.query);
    let now = now_ms();
    let mut waiting = super::lock_redirects(redirects);
    if let Some(location) = super::take_ready(&mut waiting, &id, now) {
        return Reply::redirect(&location);
    }
    let still_there = waiting.get(&id).is_some();
    match with_db(db, |conn| oauth::consent_page(conn, &id, now, still_there)) {
        Ok(reply) => reply,
        Err(err) => Reply::json(
            500,
            json!({"error": "server_error", "error_description": err}),
        ),
    }
}

fn mcp_post(conn: &mut Connection, asked: &Asked, origin: &str, now: i64) -> Reply {
    let authorizations: Vec<String> = header_values(&asked.headers, "authorization")
        .into_iter()
        .map(str::to_string)
        .collect();
    let Some(token) = security::bearer(&authorizations) else {
        return unauthorized(origin);
    };
    match oauth::authenticate(conn, &token, now) {
        Ok(Some(access)) => mcp::call(conn, &access, &asked.body, now),
        Ok(None) => unauthorized(origin),
        Err(err) => Reply::json(
            500,
            json!({"error": "server_error", "error_description": err}),
        ),
    }
}

fn unauthorized(origin: &str) -> Reply {
    let mut reply = Reply::empty(401);
    reply
        .headers
        .push(("www-authenticate".into(), oauth::challenge(origin)));
    reply
}

fn write_reply(stream: &mut TcpStream, reply: &Reply) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", reply.status, reason(reply.status));
    for (name, value) in &reply.headers {
        if name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("Cache-Control: no-store\r\n");
    head.push_str("Pragma: no-cache\r\n");
    head.push_str(&format!("Content-Length: {}\r\n", reply.body.len()));
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&reply.body)?;
    let _ = stream.flush();
    Ok(())
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        _ => "Error",
    }
}
