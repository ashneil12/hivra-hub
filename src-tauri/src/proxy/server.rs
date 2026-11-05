// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/portless packages/portless/src/proxy.ts (Apache-2.0).
// Copyright 2025 Vercel Inc.
// The routing core is translated: `Host` decides the upstream, an unknown name is a 404, and
// an upgrade is forwarded in both directions. Hivra's version is plain HTTP/1.1 only (no TLS,
// no HTTP/2), runs on std::net threads with no new crate, and writes its own small log.

//! The local proxy: one per app copy, loopback only.
//!
//! It reads the request line and `Host`, takes the port from the name registry and forwards
//! the bytes. An unknown name is a 404, never a default route. No request or response header
//! is logged: the log holds the hostname, method, status and milliseconds only.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::labels::valid_hostname;
use super::ports::next_free_from;
use super::routes::RouteStore;

/// Answer header that tells a real Hivra proxy from anything else on the port.
pub const PROXY_HEADER: &str = "X-Hivra-Proxy";
/// The one address the proxy answers without a name.
pub const HEALTH_PATH: &str = "/.hivra/health";
/// Default loopback proxy port. A dev copy takes the next free one when the daily app has it.
pub const DEFAULT_PROXY_PORT: u16 = 7400;

const MAX_HEAD: usize = 64 * 1024;
const CLIENT_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub struct BoundProxy {
    pub port: u16,
    pub v4: SocketAddr,
    pub v6: Option<SocketAddr>,
}

/// Start a proxy on `port`, loopback only. The listener threads live for the process.
pub fn start(store: Arc<RouteStore>, port: u16, log_path: PathBuf) -> Result<BoundProxy, String> {
    let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .map_err(|error| format!("The proxy can't listen on 127.0.0.1:{port}: {error}"))?;
    let v4_addr = v4.local_addr().map_err(|error| error.to_string())?;
    // Port 0 (tests only) takes the port the v4 listener was given, so both families agree.
    let actual = v4_addr.port();
    // ::1 may be absent on a machine without IPv6. The v4 listener still serves every name.
    let v6 = TcpListener::bind((Ipv6Addr::LOCALHOST, actual)).ok();
    let v6_addr = v6.as_ref().and_then(|listener| listener.local_addr().ok());
    spawn_accept(v4, store.clone(), log_path.clone());
    if let Some(v6) = v6 {
        spawn_accept(v6, store, log_path);
    }
    Ok(BoundProxy {
        port: actual,
        v4: v4_addr,
        v6: v6_addr,
    })
}

/// Start this copy's proxy, or use the one already running. Returns its port.
///
/// A dev copy keeps its registry in its own data folder and never takes the daily app's port.
pub fn ensure_running(
    data_dir: &Path,
    include_dev_ports: bool,
    reserved: &HashSet<u16>,
) -> Result<u16, String> {
    let store = Arc::new(RouteStore::new(proxy_dir(data_dir)));
    if let Some(port) = store.read_port() {
        if running(port) {
            return Ok(port);
        }
    }
    let mut skip = reserved.clone();
    if include_dev_ports {
        // A dev copy never publishes a name on the daily proxy's port, even when it is free.
        if let Some(daily) = daily_proxy_port(data_dir) {
            skip.insert(daily);
        }
    }
    let port = next_free_from(DEFAULT_PROXY_PORT, &skip, |candidate| {
        TcpListener::bind((Ipv4Addr::LOCALHOST, candidate)).is_ok()
    })
    .ok_or("No free loopback port is left for the proxy.")?;
    let _ = store.prune_stale_routes();
    start(store.clone(), port, proxy_dir(data_dir).join("proxy.log"))?;
    store.write_port(port)?;
    store.write_pid()?;
    Ok(port)
}

pub fn proxy_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("proxy")
}

/// Whether a Hivra proxy answers on `port`. Uses the health path, so a dev server that happens
/// to hold the port is not mistaken for it.
pub fn running(port: u16) -> bool {
    for address in [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ] {
        let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300))
        else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
        let host = match address.ip() {
            IpAddr::V6(_) => format!("[::1]:{port}"),
            _ => format!("127.0.0.1:{port}"),
        };
        let request =
            format!("GET {HEALTH_PATH} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut reply = String::new();
        let mut reader = BufReader::new(stream);
        let _ = reader.read_to_string(&mut reply);
        if reply.starts_with("HTTP/1.1 204")
            && reply.to_ascii_lowercase().contains("x-hivra-proxy: 1")
        {
            return true;
        }
    }
    false
}

/// The daily app's proxy port, read only, so a dev copy can avoid it.
fn daily_proxy_port(dev_data_dir: &Path) -> Option<u16> {
    let name = dev_data_dir.file_name()?.to_str()?;
    if !name.contains(".dev.") {
        return None;
    }
    let daily = dev_data_dir.parent()?.join("com.ash.monocode-hub");
    let text = std::fs::read_to_string(daily.join("proxy").join("proxy.port")).ok()?;
    text.trim().parse::<u16>().ok().filter(|port| *port != 0)
}

fn spawn_accept(listener: TcpListener, store: Arc<RouteStore>, log_path: PathBuf) {
    let _ = std::thread::Builder::new()
        .name("hivra-proxy".into())
        .spawn(move || {
            for accepted in listener.incoming() {
                let Ok(stream) = accepted else { continue };
                let store = Arc::clone(&store);
                let log_path = log_path.clone();
                let _ = std::thread::Builder::new()
                    .name("hivra-proxy-request".into())
                    .spawn(move || serve(stream, &store, &log_path));
            }
        });
}

struct RequestHead {
    method: String,
    target: String,
    version: String,
    /// Every header, in wire order, with the original names.
    headers: Vec<(String, String)>,
}

impl RequestHead {
    fn values<'a>(&'a self, name: &str) -> impl Iterator<Item = &'a str> + 'a {
        let name = name.to_string();
        self.headers
            .iter()
            .filter(move |(key, _)| key.eq_ignore_ascii_case(&name))
            .map(|(_, value)| value.as_str())
    }

    fn value<'a>(&'a self, name: &str) -> Option<&'a str> {
        self.values(name).next()
    }

    fn is_upgrade(&self) -> bool {
        self.value("upgrade").is_some()
            && self
                .value("connection")
                .is_some_and(|value| value.to_ascii_lowercase().contains("upgrade"))
    }
}

fn serve(mut client: TcpStream, store: &RouteStore, log_path: &Path) {
    if !client.peer_addr().is_ok_and(|peer| peer.ip().is_loopback()) {
        return;
    }
    let started = Instant::now();
    let _ = client.set_read_timeout(Some(CLIENT_TIMEOUT));
    let _ = client.set_write_timeout(Some(CLIENT_TIMEOUT));
    let peer = client.peer_addr().ok();
    let mut reader = BufReader::new(match client.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    });
    let head = match read_head(&mut reader) {
        Ok(head) => head,
        Err(status) => {
            let _ = respond_error(&mut client, status, status_text(status));
            log(log_path, "-", "-", status, started);
            return;
        }
    };

    // A health check is the only request answered without a name. It is loopback-only.
    if head.target == HEALTH_PATH && head.method == "GET" {
        let _ = client.write_all(
            format!(
                "HTTP/1.1 204 No Content\r\n{PROXY_HEADER}: 1\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        );
        return;
    }

    if let Err(status) = check_request(&head) {
        let _ = respond_error(&mut client, status, status_text(status));
        log(log_path, "-", &head.method, status, started);
        return;
    }
    let Some((hostname, _shown_port)) = host_without_port(head.value("host").unwrap_or("")) else {
        let _ = respond_error(&mut client, 400, status_text(400));
        log(log_path, "-", &head.method, 400, started);
        return;
    };
    let Some(route) = store.route_for_host(&hostname) else {
        let _ = respond_error(
            &mut client,
            404,
            &format!("No app is registered for {hostname}\n"),
        );
        log(log_path, &hostname, &head.method, 404, started);
        return;
    };

    let _ = peer;
    let upstream = match connect_upstream(route.port) {
        Ok(upstream) => upstream,
        Err(_) => {
            let _ = respond_error(
                &mut client,
                502,
                "The app named by this address is not answering.\n",
            );
            log(log_path, &hostname, &head.method, 502, started);
            return;
        }
    };
    let _ = upstream.set_read_timeout(Some(CLIENT_TIMEOUT));
    let _ = upstream.set_write_timeout(Some(CLIENT_TIMEOUT));

    if head.is_upgrade() {
        // Forward the handshake unchanged, then let the two sockets talk directly.
        let mut upstream = upstream;
        let mut raw = build_head(&head, false);
        if let Some(buffered) = buffered_tail(&reader) {
            raw.extend_from_slice(buffered);
        }
        if upstream.write_all(&raw).is_err() {
            let _ = respond_error(&mut client, 502, "The app did not accept the upgrade.\n");
            log(log_path, &hostname, &head.method, 502, started);
            return;
        }
        let status = tunnel(client, upstream).unwrap_or(101);
        log(log_path, &hostname, &head.method, status, started);
        return;
    }

    let mut upstream = upstream;
    if upstream.write_all(&build_head(&head, true)).is_err() {
        let _ = respond_error(&mut client, 502, "The app is not answering.\n");
        log(log_path, &hostname, &head.method, 502, started);
        return;
    }
    if let Err(status) = copy_body(&mut reader, &head, &mut upstream) {
        let _ = respond_error(&mut client, status, status_text(status));
        log(log_path, &hostname, &head.method, status, started);
        return;
    }
    let _ = upstream.shutdown(std::net::Shutdown::Write);

    let status = copy_response(&mut upstream, &mut client).unwrap_or(0);
    let _ = client.shutdown(std::net::Shutdown::Write);
    log(log_path, &hostname, &head.method, status, started);
}

fn read_head(reader: &mut BufReader<TcpStream>) -> Result<RequestHead, u16> {
    let mut raw = Vec::new();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return Err(400),
            Ok(_) => {}
            Err(_) => return Err(400),
        }
        raw.extend_from_slice(line.as_bytes());
        if raw.len() > MAX_HEAD {
            return Err(431);
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
    }
    let text = String::from_utf8_lossy(&raw);
    let mut lines = text.split("\r\n").flat_map(|line| line.split('\n'));
    let request = lines.next().unwrap_or("");
    let mut parts = request.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(400);
    };
    if parts.next().is_some()
        || method.is_empty()
        || !method
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err(400);
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(400);
        };
        let name = name.trim();
        if name.is_empty()
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            return Err(400);
        }
        headers.push((name.to_string(), value.trim().to_string()));
    }
    Ok(RequestHead {
        method: method.to_string(),
        target: target.to_string(),
        version: version.to_string(),
        headers,
    })
}

fn check_request(head: &RequestHead) -> Result<(), u16> {
    // Origin-form only. `GET http://example.com/` and CONNECT tunnels are not this proxy's job.
    if head.target.starts_with("http://")
        || head.target.starts_with("https://")
        || head.method == "CONNECT"
        || !(head.target.starts_with('/') || head.target == "*")
    {
        return Err(400);
    }
    if !head.version.starts_with("HTTP/1.") {
        return Err(505);
    }
    if head.values("host").count() != 1 {
        return Err(400);
    }
    let host = head.value("host").unwrap_or("");
    // A userinfo, a path, a second name in one header, or whitespace is not a Host.
    if host.contains(['@', '/', '\\', '?', '#', ',', ' ', '\t'])
        || host_from_authority(host).is_none()
    {
        return Err(400);
    }
    Ok(())
}

/// `host[:port]` split into its hostname and optional port. A bracketed IPv6 literal is not a
/// name this proxy routes.
fn host_without_port(authority: &str) -> Option<(String, Option<u16>)> {
    let authority = authority.trim().trim_end_matches('.');
    if authority.is_empty() || authority.starts_with('[') {
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) => {
            (host, Some(port.parse::<u16>().ok()?))
        }
        Some(_) => return None,
        None => (authority, None),
    };
    if !valid_hostname(host) {
        return None;
    }
    Some((host.to_ascii_lowercase(), port))
}

fn host_from_authority(authority: &str) -> Option<()> {
    host_without_port(authority).map(|_| ())
}

/// Rebuild the head with the same headers. A normal request gets `Connection: close`, so one
/// request per client connection always ends; an upgrade keeps the client's own headers.
fn build_head(head: &RequestHead, close: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(
        format!("{} {} {}\r\n", head.method, head.target, head.version).as_bytes(),
    );
    let mut wrote_close = false;
    for (name, value) in &head.headers {
        if close
            && (name.eq_ignore_ascii_case("connection") || name.eq_ignore_ascii_case("keep-alive"))
        {
            continue;
        }
        out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        if close && name.eq_ignore_ascii_case("connection") {
            wrote_close = true;
        }
    }
    if close && !wrote_close {
        out.extend_from_slice(b"Connection: close\r\n");
    }
    out.extend_from_slice(b"\r\n");
    out
}

fn buffered_tail(reader: &BufReader<TcpStream>) -> Option<&[u8]> {
    let buffered = reader.buffer();
    (!buffered.is_empty()).then_some(buffered)
}

fn copy_body(
    reader: &mut BufReader<TcpStream>,
    head: &RequestHead,
    upstream: &mut TcpStream,
) -> Result<(), u16> {
    if head
        .value("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        return copy_chunked(reader, upstream);
    }
    let Some(length) = head.value("content-length") else {
        return Ok(());
    };
    let length = length.parse::<u64>().map_err(|_| 400u16)?;
    let mut left = length;
    let mut buffer = [0u8; 16 * 1024];
    while left > 0 {
        let want = usize::try_from(left.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = reader.read(&mut buffer[..want]).map_err(|_| 400u16)?;
        if read == 0 {
            return Err(400);
        }
        upstream.write_all(&buffer[..read]).map_err(|_| 502u16)?;
        left -= read as u64;
    }
    Ok(())
}

fn copy_chunked(reader: &mut BufReader<TcpStream>, upstream: &mut TcpStream) -> Result<(), u16> {
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|_| 400u16)?;
        if line.is_empty() {
            return Err(400);
        }
        upstream.write_all(line.as_bytes()).map_err(|_| 502u16)?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(size_text, 16).map_err(|_| 400u16)?;
        if size == 0 {
            // Trailer headers end with an empty line.
            loop {
                let mut trailer = String::new();
                reader.read_line(&mut trailer).map_err(|_| 400u16)?;
                upstream.write_all(trailer.as_bytes()).map_err(|_| 502u16)?;
                if trailer == "\r\n" || trailer == "\n" || trailer.is_empty() {
                    return Ok(());
                }
            }
        }
        let mut left = size;
        let mut buffer = [0u8; 16 * 1024];
        while left > 0 {
            let want = usize::try_from(left.min(buffer.len() as u64)).unwrap_or(buffer.len());
            let read = reader.read(&mut buffer[..want]).map_err(|_| 400u16)?;
            if read == 0 {
                return Err(400);
            }
            upstream.write_all(&buffer[..read]).map_err(|_| 502u16)?;
            left -= read as u64;
        }
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf).map_err(|_| 400u16)?;
        if &crlf != b"\r\n" {
            return Err(400);
        }
        upstream.write_all(&crlf).map_err(|_| 502u16)?;
    }
}

/// Forward the response and return its status. `0` when the app answered nothing.
fn copy_response(upstream: &mut TcpStream, client: &mut TcpStream) -> Result<u16, ()> {
    let mut buffer = [0u8; 16 * 1024];
    let mut head = Vec::new();
    let mut status = 0u16;
    loop {
        let read = match upstream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        if status == 0 {
            head.extend_from_slice(&buffer[..read]);
            if let Some(found) = parse_status(&head) {
                status = found;
            }
        }
        if client.write_all(&buffer[..read]).is_err() {
            return Ok(status);
        }
    }
    Ok(status)
}

fn parse_status(head: &[u8]) -> Option<u16> {
    let text = String::from_utf8_lossy(head);
    let first = text.lines().next()?;
    let mut parts = first.split(' ');
    let _version = parts.next()?;
    parts.next()?.parse::<u16>().ok()
}

/// Pass bytes both ways until either side closes. The backend's status is the 101 the client
/// already received; this returns it for the log.
fn tunnel(client: TcpStream, upstream: TcpStream) -> Option<u16> {
    let client_read = client.try_clone().ok()?;
    let mut client_write = client;
    let upstream_read = upstream.try_clone().ok()?;
    let mut upstream_write = upstream;
    let a = std::thread::spawn(move || {
        let mut read = client_read;
        let _ = std::io::copy(&mut read, &mut upstream_write);
        let _ = upstream_write.shutdown(std::net::Shutdown::Write);
    });
    let mut read = upstream_read;
    let _ = std::io::copy(&mut read, &mut client_write);
    let _ = client_write.shutdown(std::net::Shutdown::Write);
    let _ = a.join();
    Some(101)
}

fn connect_upstream(port: u16) -> Result<TcpStream, ()> {
    TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        CONNECT_TIMEOUT,
    )
    .or_else(|_| {
        TcpStream::connect_timeout(
            &SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
            CONNECT_TIMEOUT,
        )
    })
    .map_err(|_| ())
}

fn respond_error(client: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let body = body.replace(['\r', '\n'], " ");
    let reply = format!(
        "HTTP/1.1 {status} {}\r\n{PROXY_HEADER}: 1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}\n",
        status_text(status),
        body.len() + 1
    );
    client.write_all(reply.as_bytes())
}

fn status_text(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        404 => "Not Found",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        505 => "HTTP Version Not Supported",
        _ => "",
    }
}

/// hostname, method, status and milliseconds. Never a header: no Cookie, Authorization or
/// Set-Cookie can reach this line because none of them is passed in.
pub fn log_line(hostname: &str, method: &str, status: u16, millis: u128) -> String {
    let status = if status == 0 {
        "-".to_string()
    } else {
        status.to_string()
    };
    let host = sanitize_field(hostname);
    let method = sanitize_field(method);
    format!("{host} {method} {status} {millis}ms\n")
}

fn sanitize_field(text: &str) -> String {
    if text.is_empty() {
        return "-".into();
    }
    text.chars()
        .take(200)
        .map(|ch| if ch.is_ascii_graphic() { ch } else { '?' })
        .collect()
}

fn log(path: &Path, hostname: &str, method: &str, status: u16, started: Instant) {
    let line = log_line(hostname, method, status, started.elapsed().as_millis());
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Guard(std::path::PathBuf);

    impl Guard {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hivra-proxy-server-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A tiny HTTP backend that answers one request per connection and then closes.
    fn backend(body: &'static str, requests: usize) -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&seen);
        std::thread::spawn(move || {
            for _ in 0..requests {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    head.push_str(&line);
                    if line == "\r\n" || line == "\n" || line.is_empty() {
                        break;
                    }
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
                let _ = stream.flush();
            }
        });
        (port, seen)
    }

    fn request(proxy: &BoundProxy, raw: &str) -> String {
        let mut stream = TcpStream::connect_timeout(&proxy.v4, Duration::from_secs(2)).unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        reply
    }

    fn get(host: &str) -> String {
        format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")
    }

    fn proxy_with(names: &[(&str, u16)], tag: &str) -> (Guard, BoundProxy) {
        let dir = Guard::new(tag);
        let store = Arc::new(RouteStore::new(dir.path()));
        for (name, port) in names {
            store
                .add_route(name, *port, std::process::id(), false)
                .unwrap();
        }
        let bound = start(store, 0, dir.path().join("proxy.log")).unwrap();
        (dir, bound)
    }

    #[test]
    fn routes_the_host_to_the_right_port() {
        let (a, _) = backend("app-one", 1);
        let (b, _) = backend("app-two", 1);
        let dir = Guard::new("route");
        let store = Arc::new(RouteStore::new(dir.path()));
        store
            .add_route("shop-one.localhost", a, std::process::id(), false)
            .unwrap();
        store
            .add_route("shop-two.localhost", b, std::process::id(), false)
            .unwrap();
        let bound = start(store, 0, dir.path().join("proxy.log")).unwrap();
        let one = request(&bound, &get("shop-one.localhost"));
        let two = request(&bound, &get("shop-two.localhost"));
        assert!(one.ends_with("app-one"), "{one}");
        assert!(two.ends_with("app-two"), "{two}");
    }

    #[test]
    fn an_unknown_name_is_a_404_not_a_default_route() {
        let (a, _) = backend("app-one", 1);
        let (dir, bound) = proxy_with(&[("shop-one.localhost", a)], "one");
        let reply = request(&bound, &get("shop-unknown.localhost"));
        assert!(reply.starts_with("HTTP/1.1 404"), "{reply}");
        assert!(reply.contains("No app is registered"));
        drop(dir);
    }

    #[test]
    fn absolute_form_userinfo_and_two_host_headers_are_refused() {
        let (a, _) = backend("app-one", 1);
        let (dir, bound) = proxy_with(&[("shop-one.localhost", a)], "one");
        for raw in [
            "GET http://example.com/ HTTP/1.1\r\nHost: shop-one.localhost\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: user@shop-one.localhost\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: shop-one.localhost\r\nHost: shop-one.localhost\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: shop-one.localhost/path\r\n\r\n",
            "CONNECT shop-one.localhost:443 HTTP/1.1\r\nHost: shop-one.localhost\r\n\r\n",
        ] {
            let reply = request(&bound, raw);
            assert!(reply.starts_with("HTTP/1.1 400"), "{raw:?} -> {reply}");
        }
        drop(dir);
    }

    #[test]
    fn a_websocket_upgrade_passes_bytes_both_ways() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello",
                )
                .unwrap();
            let mut buffer = [0u8; 16];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => return,
                    Ok(read) => {
                        if stream.write_all(&buffer[..read]).is_err() {
                            return;
                        }
                    }
                }
            }
        });
        let dir = Guard::new("upgrade");
        let store = Arc::new(RouteStore::new(dir.path()));
        store
            .add_route("shop-ws.localhost", port, std::process::id(), false)
            .unwrap();
        let bound = start(store, 0, dir.path().join("proxy.log")).unwrap();
        let mut stream = TcpStream::connect_timeout(&bound.v4, Duration::from_secs(2)).unwrap();
        stream
            .write_all(
                b"GET /socket HTTP/1.1\r\nHost: shop-ws.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            )
            .unwrap();
        let mut buffer = [0u8; 512];
        let read = stream.read(&mut buffer).unwrap();
        let text = String::from_utf8_lossy(&buffer[..read]);
        assert!(text.contains("101 Switching Protocols"), "{text}");
        assert!(text.contains("hello"), "{text}");
        stream.write_all(b"ping").unwrap();
        let read = stream.read(&mut buffer).unwrap();
        assert_eq!(&buffer[..read], b"ping");
    }

    #[test]
    fn the_bound_addresses_are_loopback_only() {
        let (a, _) = backend("app-one", 0);
        let (dir, bound) = proxy_with(&[("shop-one.localhost", a)], "one");
        assert!(bound.v4.ip().is_loopback());
        if let Some(v6) = bound.v6 {
            assert!(v6.ip().is_loopback());
        }
        drop(dir);
    }

    #[test]
    fn the_log_has_the_host_method_status_and_ms_but_no_header() {
        let (a, _) = backend("app-one", 1);
        let dir = Guard::new("log");
        let log_path = dir.path().join("proxy.log");
        let store = Arc::new(RouteStore::new(dir.path()));
        store
            .add_route("shop-one.localhost", a, std::process::id(), false)
            .unwrap();
        let bound = start(store, 0, log_path.clone()).unwrap();
        let reply = request(
            &bound,
            "GET /secret HTTP/1.1\r\nHost: shop-one.localhost\r\nAuthorization: Bearer SEKRIT-TOKEN\r\nCookie: sid=SEKRIT-COOKIE\r\nConnection: close\r\n\r\n",
        );
        assert!(reply.ends_with("app-one"));
        // The log line is written just after the response; give the request thread a moment.
        let mut text = String::new();
        for _ in 0..40 {
            text = std::fs::read_to_string(&log_path).unwrap_or_default();
            if text.contains("shop-one.localhost GET 200") {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(text.contains("shop-one.localhost GET 200"), "{text}");
        assert!(text.contains("ms"), "{text}");
        assert!(
            !text.contains("SEKRIT"),
            "a header value reached the log: {text}"
        );
        assert!(!text.contains("Authorization"));
        assert!(!text.contains("Cookie"));
    }

    #[test]
    fn the_health_path_proves_which_proxy_holds_the_port() {
        let (a, _) = backend("app-one", 0);
        let (dir, bound) = proxy_with(&[("shop-one.localhost", a)], "one");
        let reply = request(
            &bound,
            &format!(
                "GET {HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                bound.port
            ),
        );
        assert!(reply.starts_with("HTTP/1.1 204"), "{reply}");
        assert!(reply.to_ascii_lowercase().contains("x-hivra-proxy: 1"));
        let mut live = running(bound.port);
        for _ in 0..20 {
            if live {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
            live = running(bound.port);
        }
        assert!(
            live,
            "the proxy on {} did not answer the health check",
            bound.port
        );
        drop(dir);
    }

    #[test]
    fn a_proxy_that_is_not_there_is_not_running() {
        // Pick a port nothing listens on, then close it.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!running(port));
    }

    #[test]
    fn the_log_line_never_takes_a_header() {
        let line = log_line("shop-one.localhost", "POST", 201, 12);
        assert_eq!(line, "shop-one.localhost POST 201 12ms\n");
        assert_eq!(log_line("", "", 0, 1), "- - - 1ms\n");
    }
}
