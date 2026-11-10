// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/portless packages/portless/src/proxy.ts (Apache-2.0).
// Copyright 2025 Vercel Inc.
// The routing core is translated: `Host` decides the upstream, an unknown name is a 404, and
// an upgrade is forwarded in both directions. Hivra's version is plain HTTP/1.1 only (no TLS,
// no HTTP/2), runs on std::net threads with no new crate, and writes its own small log.
// WP-139 (portless 0.17.0, packages/portless/src/utils.ts createLoopbackConnection): 127.0.0.1
// and ::1 are dialed together and the first connection wins.

//! The local proxy: one per app copy, loopback only.
//!
//! It reads the request line and `Host`, takes the port from the name registry and forwards
//! the bytes. An unknown name is a 404, never a default route. No request or response header
//! is logged: the log holds the hostname, method, status and milliseconds only.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::labels::valid_hostname;
use super::ports::next_free_from;
use super::routes::RouteStore;

/// Header that names which data folder this proxy belongs to.
const DATA_HEADER: &str = "X-Hivra-Data";

/// Answer header that tells a real Hivra proxy from anything else on the port.
pub const PROXY_HEADER: &str = "X-Hivra-Proxy";
/// The one address the proxy answers without a name.
pub const HEALTH_PATH: &str = "/.hivra/health";
/// Default loopback proxy port. A dev copy takes the next free one when the daily app has it.
pub const DEFAULT_PROXY_PORT: u16 = 7400;

const MAX_HEAD: usize = 64 * 1024;
/// Reading the request line and headers only.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(30);
/// After the head: a WebSocket, an SSE body or a long poll may send nothing for much longer
/// than half a minute and still be alive. This is a backstop for a peer that vanished without
/// closing, not an idle timeout.
const STREAM_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the proxy waits on a socket. Reading the request head is the only part with a
/// short limit; once a request is routed a quiet socket is normal (a Vite HMR WebSocket, an
/// SSE body), so the stream limit is a backstop for a peer that vanished, not an idle timeout.
#[derive(Clone, Copy, Debug)]
struct Timeouts {
    head: Duration,
    stream: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            head: CLIENT_TIMEOUT,
            stream: STREAM_TIMEOUT,
        }
    }
}

pub struct BoundProxy {
    pub port: u16,
    pub v4: SocketAddr,
    pub v6: Option<SocketAddr>,
}

impl BoundProxy {
    /// Both listeners are loopback. The v6 one may be absent on a machine without IPv6.
    pub fn loopback_only(&self) -> bool {
        self.v4.ip().is_loopback() && self.v6.is_none_or(|address| address.ip().is_loopback())
    }
}

/// Start a proxy on `port`, loopback only. The listener threads live for the process.
///
/// `data_id` names the data folder this proxy belongs to. It is held in memory and sent with
/// every health reply, so no file is read to answer one. `None` answers as an older proxy
/// did, with no id.
pub fn start(
    store: Arc<RouteStore>,
    port: u16,
    log_path: PathBuf,
    data_id: Option<&str>,
) -> Result<BoundProxy, String> {
    start_with(store, port, log_path, data_id, Timeouts::default())
}

fn start_with(
    store: Arc<RouteStore>,
    port: u16,
    log_path: PathBuf,
    data_id: Option<&str>,
    timeouts: Timeouts,
) -> Result<BoundProxy, String> {
    // The id goes into a response header, so only one this app makes is ever sent.
    let data_id: Option<Arc<str>> = data_id.filter(|id| valid_data_id(id)).map(Arc::from);
    let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .map_err(|error| format!("The proxy can't listen on 127.0.0.1:{port}: {error}"))?;
    let v4_addr = v4.local_addr().map_err(|error| error.to_string())?;
    // Port 0 (tests only) takes the port the v4 listener was given, so both families agree.
    let actual = v4_addr.port();
    // ::1 may be absent on a machine without IPv6. The v4 listener still serves every name.
    let v6 = TcpListener::bind((Ipv6Addr::LOCALHOST, actual)).ok();
    let v6_addr = v6.as_ref().and_then(|listener| listener.local_addr().ok());
    spawn_accept(
        v4,
        store.clone(),
        log_path.clone(),
        data_id.clone(),
        timeouts,
    );
    if let Some(v6) = v6 {
        spawn_accept(v6, store, log_path, data_id, timeouts);
    }
    Ok(BoundProxy {
        port: actual,
        v4: v4_addr,
        v6: v6_addr,
    })
}

/// The proxies this process started, by data folder id, and the port each listens on. The
/// listener threads live as long as the process, so such a proxy needs no health check: it
/// cannot have gone away.
static STARTED: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();

/// One caller at a time per data folder. Two callers that both find no proxy would each start
/// one, on neighbouring ports.
static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn gate_for(data_id: &str) -> Arc<Mutex<()>> {
    let gates = GATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut gates = gates.lock().unwrap_or_else(PoisonError::into_inner);
    Arc::clone(gates.entry(data_id.to_string()).or_default())
}

fn started_port(data_id: &str) -> Option<u16> {
    let started = STARTED.get_or_init(|| Mutex::new(HashMap::new()));
    let started = started.lock().unwrap_or_else(PoisonError::into_inner);
    started.get(data_id).copied()
}

fn remember_started(data_id: &str, port: u16) {
    let started = STARTED.get_or_init(|| Mutex::new(HashMap::new()));
    let mut started = started.lock().unwrap_or_else(PoisonError::into_inner);
    started.insert(data_id.to_string(), port);
}

/// Start this copy's proxy, or use the one already running. Returns its port.
///
/// A dev copy keeps its registry in its own data folder and never takes the daily app's port.
/// This is called on every status, down, reset and stale check, from several threads: it writes
/// nothing when the proxy is already up.
pub fn ensure_running(
    data_dir: &Path,
    include_dev_ports: bool,
    reserved: &HashSet<u16>,
) -> Result<u16, String> {
    let store = Arc::new(RouteStore::new(proxy_dir(data_dir)));
    let data_id = data_folder_id(data_dir);
    let gate = gate_for(&data_id);
    let _one_at_a_time = gate.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(port) = started_port(&data_id) {
        // Started by this process, so it is still there. The port file is put right if
        // something changed it, and a folder that can't be written to still has its proxy.
        let _ = store.write_port(port);
        return Ok(port);
    }
    if let Some(port) = store.read_port() {
        // A port is reused only when the proxy answering there belongs to this folder.
        // Anything else, including the daily app's proxy and one that names no folder
        // (an older build), is left alone.
        if running_as(port, &data_id) {
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
    let _ = store.prune_stale_routes();
    for _ in 0..5 {
        let Some(port) = next_free_from(DEFAULT_PROXY_PORT, &skip, |candidate| {
            TcpListener::bind((Ipv4Addr::LOCALHOST, candidate)).is_ok()
        }) else {
            break;
        };
        match start(
            store.clone(),
            port,
            proxy_dir(data_dir).join("proxy.log"),
            Some(&data_id),
        ) {
            Ok(bound) => {
                debug_assert!(bound.loopback_only());
                remember_started(&data_id, bound.port);
                store.write_port(bound.port)?;
                store.write_pid()?;
                return Ok(bound.port);
            }
            Err(_) if running_as(port, &data_id) => {
                // Another process of this same folder started it between the probe and our bind.
                store.write_port(port)?;
                return Ok(port);
            }
            Err(_) => {
                // The port was taken by something else; try the next one.
                skip.insert(port);
            }
        }
    }
    Err("No free loopback port is left for the proxy.".into())
}

pub fn proxy_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("proxy")
}

/// A stable id for a data folder: hex of its canonical path, never the path itself.
pub fn data_folder_id(data_dir: &Path) -> String {
    let path = crate::fs::canonical(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    let mut out = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Whether a Hivra proxy answers on `port`. Uses the health path, so a dev server that happens
/// to hold the port is not mistaken for it. A copy decides whether to reuse the port with
/// [`running_as`], which also checks the data folder.
#[cfg_attr(not(test), allow(dead_code))]
pub fn running(port: u16) -> bool {
    proxy_reply(port).is_some()
}

/// Whether the proxy on `port` belongs to the data folder `data_id` names.
pub fn running_as(port: u16, data_id: &str) -> bool {
    proxy_reply(port).is_some_and(|reply| data_header(&reply) == Some(data_id))
}

/// Lowercase hex, short enough for one header and not a path.
fn valid_data_id(id: &str) -> bool {
    (16..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn data_header(reply: &str) -> Option<&str> {
    reply.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("x-hivra-data")
            .then(|| value.trim())
            .filter(|value| !value.is_empty())
    })
}

fn proxy_reply(port: u16) -> Option<String> {
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
            return Some(reply);
        }
    }
    None
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

fn spawn_accept(
    listener: TcpListener,
    store: Arc<RouteStore>,
    log_path: PathBuf,
    data_id: Option<Arc<str>>,
    timeouts: Timeouts,
) {
    let _ = std::thread::Builder::new()
        .name("hivra-proxy".into())
        .spawn(move || {
            for accepted in listener.incoming() {
                let Ok(stream) = accepted else { continue };
                let store = Arc::clone(&store);
                let log_path = log_path.clone();
                let data_id = data_id.clone();
                let _ = std::thread::Builder::new()
                    .name("hivra-proxy-request".into())
                    .spawn(move || serve(stream, &store, &log_path, data_id.as_deref(), timeouts));
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

fn serve(
    mut client: TcpStream,
    store: &RouteStore,
    log_path: &Path,
    data_id: Option<&str>,
    timeouts: Timeouts,
) {
    if !client.peer_addr().is_ok_and(|peer| peer.ip().is_loopback()) {
        return;
    }
    let started = Instant::now();
    let _ = client.set_read_timeout(Some(timeouts.head));
    let _ = client.set_write_timeout(Some(timeouts.head));
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

    // The head is in. Everything after it may be quiet for a long time without being dead.
    let _ = client.set_read_timeout(Some(timeouts.stream));
    let _ = client.set_write_timeout(Some(timeouts.stream));

    // A health check is the only request answered without a name. It is loopback-only.
    // The data-folder id comes from memory, so a check never depends on a file another call
    // may be writing. A proxy started with no id (an older build) answers without one, and a
    // dev copy can tell that answer is not its own.
    if head.target == HEALTH_PATH && head.method == "GET" {
        let data = data_id
            .map(|id| format!("{DATA_HEADER}: {id}\r\n"))
            .unwrap_or_default();
        let _ = client.write_all(
            format!(
                "HTTP/1.1 204 No Content\r\n{PROXY_HEADER}: 1\r\n{data}Cache-Control: no-store\r\nConnection: close\r\n\r\n"
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
        Err(detail) => {
            let _ = respond_error(&mut client, 502, &detail);
            log(log_path, &hostname, &head.method, 502, started);
            return;
        }
    };
    let _ = upstream.set_read_timeout(Some(timeouts.stream));
    let _ = upstream.set_write_timeout(Some(timeouts.stream));

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

/// One header line, never more than the bytes left in the head budget. A peer that sends no
/// newline cannot make the proxy allocate past `MAX_HEAD`.
fn read_line_limited(reader: &mut BufReader<TcpStream>, left: usize) -> Result<String, u16> {
    if left == 0 {
        return Err(431);
    }
    let mut bytes = Vec::new();
    let read = reader
        .by_ref()
        .take(left as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| 400u16)?;
    if read == 0 {
        return Err(400);
    }
    if !bytes.ends_with(b"\n") {
        return Err(431);
    }
    String::from_utf8(bytes).map_err(|_| 400)
}

fn read_head(reader: &mut BufReader<TcpStream>) -> Result<RequestHead, u16> {
    let mut raw = Vec::new();
    loop {
        let line = read_line_limited(reader, MAX_HEAD - raw.len())?;
        raw.extend_from_slice(line.as_bytes());
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
    // Two framings for one body is request smuggling, not a request.
    if head.values("content-length").count() > 1 {
        return Err(400);
    }
    if head.value("transfer-encoding").is_some() && head.value("content-length").is_some() {
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
        let line = read_line_limited(reader, 8 * 1024)?;
        upstream.write_all(line.as_bytes()).map_err(|_| 502u16)?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(size_text, 16).map_err(|_| 400u16)?;
        if size == 0 {
            // Trailer headers end with an empty line.
            loop {
                let trailer = read_line_limited(reader, 8 * 1024)?;
                upstream.write_all(trailer.as_bytes()).map_err(|_| 502u16)?;
                if trailer == "\r\n" || trailer == "\n" {
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

/// Dial `127.0.0.1` and `::1` together. The first connection wins and the other attempt is
/// dropped, so a stall on one family does not delay the other. Loopback only.
fn connect_upstream(port: u16) -> Result<TcpStream, String> {
    race_loopback(port, CONNECT_TIMEOUT, dial_timeout)
}

fn dial_timeout(addr: SocketAddr, timeout: Duration) -> std::io::Result<TcpStream> {
    TcpStream::connect_timeout(&addr, timeout)
}

/// Start both loopback families at once and keep the first `TcpStream`. Each attempt gets
/// `timeout` of its own; the caller waits about that long, not twice that, because the dials
/// overlap. Dropping the receiver lets a late attempt discard its socket instead of holding
/// the request.
fn race_loopback<F>(port: u16, timeout: Duration, dial: F) -> Result<TcpStream, String>
where
    F: Fn(SocketAddr, Duration) -> std::io::Result<TcpStream> + Send + Sync + 'static,
{
    let dial = Arc::new(dial);
    let targets = [
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
    ];
    let (tx, rx) = std::sync::mpsc::channel();
    for (index, addr) in targets.into_iter().enumerate() {
        let tx_thread = tx.clone();
        let dial = Arc::clone(&dial);
        if let Err(error) = std::thread::Builder::new()
            .name(format!("hivra-proxy-dial-{index}"))
            .spawn(move || {
                let result = dial(addr, timeout);
                let _ = tx_thread.send((index, result));
            })
        {
            let _ = tx.send((index, Err(error)));
        }
    }
    drop(tx);

    let mut errors: [Option<std::io::Error>; 2] = [None, None];
    let mut pending = targets.len();
    let deadline = Instant::now() + timeout + Duration::from_millis(500);
    while pending > 0 {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left) {
            Ok((_index, Ok(stream))) => return Ok(stream),
            Ok((index, Err(error))) => {
                if let Some(slot) = errors.get_mut(index) {
                    *slot = Some(error);
                }
                pending -= 1;
            }
            Err(_) => break,
        }
    }
    Err(loopback_failure(&errors))
}

fn loopback_failure(errors: &[Option<std::io::Error>; 2]) -> String {
    let hosts = ["127.0.0.1", "::1"];
    let detail = hosts
        .iter()
        .zip(errors.iter())
        .map(|(host, error)| match error {
            Some(error) => format!("{host} ({error})"),
            None => format!("{host} (timed out)"),
        })
        .collect::<Vec<_>>()
        .join("; ");
    format!("The app named by this address is not answering: {detail}.")
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

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
        let bound = start(store, 0, dir.path().join("proxy.log"), None).unwrap();
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
        let bound = start(store, 0, dir.path().join("proxy.log"), None).unwrap();
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
            "POST / HTTP/1.1\r\nHost: shop-one.localhost\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabc",
            "POST / HTTP/1.1\r\nHost: shop-one.localhost\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
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
        let bound = start(store, 0, dir.path().join("proxy.log"), None).unwrap();
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

    fn proxy_with_timeouts(
        names: &[(&str, u16)],
        tag: &str,
        timeouts: Timeouts,
    ) -> (Guard, BoundProxy) {
        let dir = Guard::new(tag);
        let store = Arc::new(RouteStore::new(dir.path()));
        for (name, port) in names {
            store
                .add_route(name, *port, std::process::id(), false)
                .unwrap();
        }
        let bound = start_with(store, 0, dir.path().join("proxy.log"), None, timeouts).unwrap();
        (dir, bound)
    }

    /// A backend that reads one request head, stays quiet longer than the head timeout, and
    /// only then answers. An app thinking for a moment is not an app that has gone.
    fn sleepy_backend(delay: Duration) -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            std::thread::sleep(delay);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
            );
        });
        port
    }

    fn short_head() -> Timeouts {
        Timeouts {
            head: Duration::from_millis(150),
            stream: Duration::from_secs(5),
        }
    }

    #[test]
    fn a_slow_response_body_is_not_cut_by_the_head_timeout() {
        let port = sleepy_backend(Duration::from_millis(500));
        let (dir, bound) =
            proxy_with_timeouts(&[("shop-slow.localhost", port)], "slow", short_head());
        let reply = request(&bound, &get("shop-slow.localhost"));
        assert!(reply.ends_with("hello"), "the body was cut: {reply:?}");
        drop(dir);
    }

    #[test]
    fn an_idle_websocket_is_not_cut_by_the_head_timeout() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            if stream
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
                )
                .is_err()
            {
                return;
            }
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
        let (dir, bound) =
            proxy_with_timeouts(&[("shop-idle.localhost", port)], "ws-idle", short_head());
        let mut stream = TcpStream::connect_timeout(&bound.v4, Duration::from_secs(2)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .write_all(
                b"GET /socket HTTP/1.1\r\nHost: shop-idle.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
            )
            .unwrap();
        let mut buffer = [0u8; 512];
        let read = stream.read(&mut buffer).unwrap();
        let text = String::from_utf8_lossy(&buffer[..read]);
        assert!(text.contains("101 Switching Protocols"), "{text}");
        // Quiet for longer than the head timeout: a live socket may send nothing for minutes.
        std::thread::sleep(Duration::from_millis(500));
        stream.write_all(b"ping").unwrap();
        let read = stream
            .read(&mut buffer)
            .expect("the idle socket was closed");
        assert_eq!(&buffer[..read], b"ping");
        drop(dir);
    }

    #[test]
    fn a_cookie_set_for_one_name_is_not_sent_to_the_other() {
        // The proxy is host-transparent: each backend sees only the Cookie its own origin sent.
        fn echo_cookie() -> u16 {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for _ in 0..2 {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut cookie = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            break;
                        }
                        if let Some(value) = line.to_ascii_lowercase().strip_prefix("cookie:") {
                            cookie = value.trim().to_string();
                        }
                        if line == "\r\n" {
                            break;
                        }
                    }
                    let body = if cookie.is_empty() {
                        "no-cookie".to_string()
                    } else {
                        cookie
                    };
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(reply.as_bytes());
                }
            });
            port
        }
        let one = echo_cookie();
        let two = echo_cookie();
        let dir = Guard::new("cookies");
        let store = Arc::new(RouteStore::new(dir.path()));
        store
            .add_route("shop-one.localhost", one, std::process::id(), false)
            .unwrap();
        store
            .add_route("shop-two.localhost", two, std::process::id(), false)
            .unwrap();
        let bound = start(store, 0, dir.path().join("proxy.log"), None).unwrap();
        let signed_in = request(
            &bound,
            "GET / HTTP/1.1\r\nHost: shop-one.localhost\r\nCookie: sid=one\r\nConnection: close\r\n\r\n",
        );
        assert!(signed_in.ends_with("sid=one"), "{signed_in}");
        let other = request(
            &bound,
            "GET / HTTP/1.1\r\nHost: shop-two.localhost\r\nConnection: close\r\n\r\n",
        );
        assert!(other.ends_with("no-cookie"), "{other}");
        // The same cookie sent to the other name would be a different origin's cookie; the
        // proxy forwards whatever it is given and invents nothing.
        let forwarded = request(
            &bound,
            "GET / HTTP/1.1\r\nHost: shop-two.localhost\r\nCookie: sid=one\r\nConnection: close\r\n\r\n",
        );
        assert!(forwarded.ends_with("sid=one"), "{forwarded}");
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
        let bound = start(store, 0, log_path.clone(), None).unwrap();
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
    fn a_dev_copy_does_not_adopt_another_folders_proxy() {
        let daily = Guard::new("adopt-daily");
        let dev = Guard::new("adopt-dev");
        let daily_port = ensure_running(daily.path(), false, &HashSet::new()).unwrap();
        // The dev copy's saved port is the other folder's proxy, which is what a dev
        // copy used to adopt.
        std::fs::create_dir_all(proxy_dir(dev.path())).unwrap();
        std::fs::write(
            proxy_dir(dev.path()).join("proxy.port"),
            format!("{daily_port}\n"),
        )
        .unwrap();
        let dev_port = ensure_running(dev.path(), true, &HashSet::new()).unwrap();
        assert_ne!(
            daily_port, dev_port,
            "the dev copy took the other folder's proxy"
        );
        let daily_id = data_folder_id(daily.path());
        let dev_id = data_folder_id(dev.path());
        assert_ne!(daily_id, dev_id);
        let mut saw_daily = false;
        let mut saw_dev = false;
        for _ in 0..40 {
            saw_daily = running_as(daily_port, &daily_id);
            saw_dev = running_as(dev_port, &dev_id);
            if saw_daily && saw_dev {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(saw_daily, "the first folder's proxy did not name itself");
        assert!(saw_dev, "the dev copy's proxy did not name itself");
        assert!(!running_as(daily_port, &dev_id));
        assert!(!running_as(dev_port, &daily_id));
        // Once each proxy has named its own folder, a later start reuses that port and no other.
        assert_eq!(
            ensure_running(daily.path(), false, &HashSet::new()).unwrap(),
            daily_port
        );
        assert_eq!(
            ensure_running(dev.path(), true, &HashSet::new()).unwrap(),
            dev_port
        );
        assert!(running(daily_port));
        assert!(running(dev_port));
    }

    /// An older daily build's proxy answers the health check with no `X-Hivra-Data` at all. It
    /// is not this folder's, so a dev copy that finds its port in the saved file must start its
    /// own proxy rather than take it over.
    #[test]
    fn a_dev_copy_does_not_adopt_a_proxy_that_names_no_folder() {
        let older = Guard::new("older-daily");
        let dev = Guard::new("older-dev");
        let store = Arc::new(RouteStore::new(proxy_dir(older.path())));
        let older_bound = start(store, 0, older.path().join("proxy.log"), None).unwrap();
        let older_port = older_bound.port;
        // The reply really carries no id.
        let reply = request(
            &older_bound,
            &format!("GET {HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{older_port}\r\n\r\n"),
        );
        assert!(reply.starts_with("HTTP/1.1 204"), "{reply}");
        assert!(
            !reply.to_ascii_lowercase().contains("x-hivra-data"),
            "{reply}"
        );
        assert!(running(older_port));
        // The dev copy's saved port is that proxy.
        std::fs::create_dir_all(proxy_dir(dev.path())).unwrap();
        std::fs::write(
            proxy_dir(dev.path()).join("proxy.port"),
            format!("{older_port}\n"),
        )
        .unwrap();
        let dev_id = data_folder_id(dev.path());
        assert!(!running_as(older_port, &dev_id));
        let dev_port = ensure_running(dev.path(), true, &HashSet::new()).unwrap();
        assert_ne!(dev_port, older_port, "the dev copy took a proxy with no id");
        assert_eq!(
            RouteStore::new(proxy_dir(dev.path())).read_port(),
            Some(dev_port)
        );
        assert!(running_as(dev_port, &dev_id));
    }

    /// `stacks::env_from_app` calls `ensure_running` on every status, down, reset, stale check
    /// and action start. Each call used to empty and rewrite `proxy/data.id`, and a health
    /// check that landed in the gap got no `X-Hivra-Data` header, so the running proxy read as
    /// someone else's and a second one was started on the next port. Callers at the same time,
    /// from a cold start, must all end up on one proxy.
    #[test]
    fn callers_at_the_same_time_all_get_the_one_proxy_and_its_port() {
        let dir = Guard::new("callers");
        let data = dir.path().to_path_buf();
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let data = data.clone();
                std::thread::spawn(move || {
                    (0..40)
                        .map(|_| ensure_running(&data, false, &HashSet::new()).unwrap())
                        .collect::<Vec<u16>>()
                })
            })
            .collect();
        let mut ports: Vec<u16> = threads
            .into_iter()
            .flat_map(|thread| thread.join().unwrap())
            .collect();
        ports.sort_unstable();
        ports.dedup();
        assert_eq!(ports.len(), 1, "callers saw different proxies: {ports:?}");
        let store = RouteStore::new(proxy_dir(&data));
        assert_eq!(store.read_port(), Some(ports[0]));
        // The port is that folder's own proxy, and nothing else answers for it.
        assert!(running_as(ports[0], &data_folder_id(&data)));
    }

    #[test]
    fn a_dev_copy_reads_the_daily_port_so_it_can_avoid_it() {
        let root = Guard::new("daily-port");
        let daily = root.path().join("com.ash.monocode-hub");
        let dev = root.path().join("com.ash.monocode-hub.dev.mine");
        std::fs::create_dir_all(daily.join("proxy")).unwrap();
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::write(daily.join("proxy").join("proxy.port"), "7400\n").unwrap();
        assert_eq!(daily_proxy_port(&dev), Some(7400));
        // The daily copy itself does not skip a port: it owns it.
        assert_eq!(daily_proxy_port(&daily), None);
        assert_eq!(daily_proxy_port(&root.path().join("elsewhere")), None);
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

    /// One accept, then the bytes `marker`. `None` when this machine has no IPv6 loopback.
    fn oneshot(addr: SocketAddr, marker: &'static [u8]) -> Option<u16> {
        let listener = match TcpListener::bind(addr) {
            Ok(listener) => listener,
            Err(error)
                if addr.ip().is_ipv6()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
                    ) =>
            {
                return None;
            }
            Err(error) => panic!("could not bind {addr}: {error}"),
        };
        let port = listener.local_addr().unwrap().port();
        let marker = marker.to_vec();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let _ = stream.write_all(&marker);
        });
        Some(port)
    }

    fn read_marker(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut buf = [0u8; 2];
        stream.read_exact(&mut buf).unwrap();
        String::from_utf8(buf.to_vec()).unwrap()
    }

    #[test]
    fn a_v4_only_backend_still_answers() {
        let port = oneshot(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), b"v4").unwrap();
        let started = Instant::now();
        let mut stream = connect_upstream(port).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "v4 dial took {:?}",
            started.elapsed()
        );
        assert!(stream.peer_addr().unwrap().ip().is_ipv4());
        assert_eq!(read_marker(&mut stream), "v4");
    }

    #[test]
    fn a_v6_only_backend_still_answers() {
        let Some(port) = oneshot(SocketAddr::from((Ipv6Addr::LOCALHOST, 0)), b"v6") else {
            return;
        };
        let started = Instant::now();
        let mut stream = connect_upstream(port).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "v6 dial waited on v4: {:?}",
            started.elapsed()
        );
        assert!(stream.peer_addr().unwrap().ip().is_ipv6());
        assert_eq!(read_marker(&mut stream), "v6");
    }

    #[test]
    fn a_v6_only_backend_is_reached_while_ipv4_is_still_dialing() {
        let Some(port) = oneshot(SocketAddr::from((Ipv6Addr::LOCALHOST, 0)), b"v6") else {
            return;
        };
        // A closed v4 port refuses at once, so it cannot stand in for a stall. This dial sleeps
        // for the whole timeout on 127.0.0.1 and connects for real on ::1.
        let timeout = Duration::from_millis(1500);
        let v4_started = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&v4_started);
        let started = Instant::now();
        let mut stream = race_loopback(port, timeout, move |addr, per_try| {
            if addr.ip().is_ipv4() {
                flag.store(true, Ordering::SeqCst);
                std::thread::sleep(per_try);
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "connection timed out",
                ))
            } else {
                TcpStream::connect_timeout(&addr, per_try)
            }
        })
        .expect("v6 backend");
        let elapsed = started.elapsed();
        assert!(
            elapsed < timeout / 2,
            "v6 waited for the v4 dial ({elapsed:?}, timeout {timeout:?})"
        );
        assert!(stream.peer_addr().unwrap().ip().is_ipv6());
        assert_eq!(read_marker(&mut stream), "v6");
        let mut saw_v4 = v4_started.load(Ordering::SeqCst);
        for _ in 0..50 {
            if saw_v4 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
            saw_v4 = v4_started.load(Ordering::SeqCst);
        }
        assert!(saw_v4, "the v4 dial never started");
    }

    #[test]
    fn a_dual_loopback_failure_names_both_addresses() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let started = Instant::now();
        let error = connect_upstream(port).unwrap_err();
        assert!(
            started.elapsed() < CONNECT_TIMEOUT + Duration::from_secs(2),
            "the two families were not dialed together: {:?}",
            started.elapsed()
        );
        assert!(error.contains("127.0.0.1"), "{error}");
        assert!(error.contains("::1"), "{error}");
        assert!(
            !error.contains("0.0.0.0") && !error.contains("not answering: ."),
            "{error}"
        );
    }

    #[test]
    fn loopback_dials_try_only_localhost() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let error = race_loopback(1, Duration::from_millis(200), move |addr, _timeout| {
            log.lock().expect("dial log").push(addr.ip());
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "closed",
            ))
        })
        .unwrap_err();
        let ips = seen.lock().expect("dial log").clone();
        assert_eq!(ips.len(), 2, "{ips:?}");
        assert!(ips.iter().all(|ip| ip.is_loopback()), "{ips:?}");
        assert!(error.contains("127.0.0.1"), "{error}");
        assert!(error.contains("::1"), "{error}");
    }
}
