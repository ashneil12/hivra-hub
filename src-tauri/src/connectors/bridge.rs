//! A hosted MCP server, spoken to over stdio: Claude Code starts `monocode connector-run <id>` like any local MCP
//! server, and this relays each line to the server with the login attached. The login is in this process's memory only:
//! never in Claude Code's config, argv or environment, never in a child process, never printed.

use super::remote::{PostError, Remote};
use super::renew::Failure;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Gets fresh headers when the server says the login expired (an OAuth refresh). `None` when there is no refresh.
/// [`Failure::SignedOut`] stops the bridge.
pub type Refresher = Arc<dyn Fn() -> Result<Vec<(String, String)>, Failure> + Send + Sync>;
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Bridge {
    pub remote: Arc<Remote>,
    pub refresh: Option<Refresher>,
    pub log: Log,
}

impl Bridge {
    /// Relay until stdin closes (or the login is signed out under it), then wait for answers still on their way and end
    /// the server's session.
    pub fn run(&self, input: impl BufRead, out: Arc<Mutex<dyn Write + Send>>) {
        let mut workers = Vec::new();
        let stopped = Arc::new(AtomicBool::new(false));
        for line in input.lines() {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let Ok(line) = line else { break };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let value: Option<serde_json::Value> = serde_json::from_str(&line).ok();
            let id = value.as_ref().and_then(|v| v.get("id").cloned());
            let is_initialize = value
                .as_ref()
                .and_then(|v| v.get("method"))
                .and_then(|m| m.as_str())
                == Some("initialize");
            // `initialize` sets up the session every later request carries, so it goes first, alone.
            if is_initialize {
                self.relay(&line, id, &out, true, &stopped);
                continue;
            }
            let remote = Arc::clone(&self.remote);
            let refresh = self.refresh.clone();
            let log = Arc::clone(&self.log);
            let out = Arc::clone(&out);
            let stopped = Arc::clone(&stopped);
            workers.push(std::thread::spawn(move || {
                Bridge {
                    remote,
                    refresh,
                    log,
                }
                .relay(&line, id, &out, false, &stopped);
            }));
            workers.retain(|w| !w.is_finished());
        }
        for worker in workers {
            let _ = worker.join();
        }
        self.remote.close();
    }

    fn relay(
        &self,
        line: &str,
        id: Option<serde_json::Value>,
        out: &Arc<Mutex<dyn Write + Send>>,
        is_initialize: bool,
        stopped: &AtomicBool,
    ) {
        let mut emit = |message: String| {
            if is_initialize {
                self.remote.note_protocol(&message);
            }
            let mut out = out.lock().unwrap();
            let _ = writeln!(out, "{message}");
            let _ = out.flush();
        };
        if stopped.load(Ordering::SeqCst) {
            return;
        }
        let mut result = self.remote.post(line, &mut emit);
        let mut signed_out = None;
        if result == Err(PostError::Unauthorized) {
            if let Some(refresh) = &self.refresh {
                match refresh() {
                    Ok(headers) => {
                        self.remote.set_headers(headers);
                        result = self.remote.post(line, &mut emit);
                    }
                    Err(Failure::SignedOut) => {
                        // Signed out in the app: nothing more goes to the server, and the bridge ends.
                        stopped.store(true, Ordering::SeqCst);
                        signed_out = Some(Failure::SignedOut.message());
                    }
                    Err(Failure::Failed(why)) => {
                        (self.log)(&format!("couldn't renew the login: {why}"))
                    }
                }
            }
        }
        if let Err(error) = result {
            let message = signed_out.unwrap_or_else(|| error.message());
            (self.log)(&message);
            // A request gets a JSON-RPC error back, so Claude Code sees a clean failure instead of waiting forever.
            if let Some(id) = id {
                emit(
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32000, "message": message }
                    })
                    .to_string(),
                );
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    /// What a fake MCP server saw: every request's headers and body.
    #[derive(Default)]
    pub struct Seen {
        pub requests: Mutex<Vec<(String, String)>>,
    }

    /// A tiny Streamable HTTP MCP server on 127.0.0.1. It answers only when `Authorization: Bearer <token>` matches
    /// `accept` (a shared slot, so a test can rotate the token), and answers tools/list with an SSE stream.
    pub fn fake_mcp(accept: Arc<Mutex<String>>, seen: Arc<Seen>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let accept = Arc::clone(&accept);
                let seen = Arc::clone(&seen);
                thread::spawn(move || serve(stream, &accept, &seen));
            }
        });
        url
    }

    fn serve(mut stream: TcpStream, accept: &Mutex<String>, seen: &Seen) {
        let (head, body) = read_request(&mut stream);
        seen.requests
            .lock()
            .unwrap()
            .push((head.clone(), body.clone()));
        let authorized = head.lines().any(|l| {
            l.eq_ignore_ascii_case(&format!("authorization: Bearer {}", accept.lock().unwrap()))
        });
        if !authorized {
            let _ = stream.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        if head.starts_with("DELETE") {
            let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
            return;
        }
        let value: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let id = value.get("id").cloned();
        let method = value.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let reply = match (method, id) {
            ("initialize", Some(id)) => serde_json::json!({"jsonrpc":"2.0","id":id,"result":{
                "protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"1"}}}),
            ("tools/list", Some(id)) => {
                let event = serde_json::json!({"jsonrpc":"2.0","id":id,"result":{"tools":[{"name":"a"},{"name":"b"}]}});
                let body = format!("event: message\ndata: {event}\n\n");
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nMcp-Session-Id: sess-1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                return;
            }
            (_, Some(id)) => serde_json::json!({"jsonrpc":"2.0","id":id,"result":{}}),
            (_, None) => {
                let _ = stream.write_all(
                    b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
                return;
            }
        };
        let body = reply.to_string();
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: sess-1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }

    pub fn read_request(stream: &mut TcpStream) -> (String, String) {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        while !buf.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                break;
            }
            buf.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&buf).to_string();
        let length = head
            .lines()
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
            })
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        let _ = stream.read_exact(&mut body);
        (head, String::from_utf8_lossy(&body).to_string())
    }

    #[derive(Clone, Default)]
    pub struct Buffer(pub Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Buffer {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Buffer {
        pub fn text(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).to_string()
        }
    }

    const STDIN: &str = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude","version":"1"}}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        "\n"
    );

    #[test]
    fn relays_stdio_to_the_server_with_the_login_attached() {
        let seen = Arc::new(Seen::default());
        let url = fake_mcp(
            Arc::new(Mutex::new("TOKEN_SENTINEL".into())),
            Arc::clone(&seen),
        );
        let logged = Buffer::default();
        let log_buf = logged.clone();
        let bridge = Bridge {
            remote: Arc::new(Remote::new(
                url,
                vec![("Authorization".into(), "Bearer TOKEN_SENTINEL".into())],
            )),
            refresh: None,
            log: Arc::new(move |line| {
                let _ = writeln!(log_buf.clone(), "{line}");
            }),
        };
        let out = Buffer::default();
        bridge.run(STDIN.as_bytes(), Arc::new(Mutex::new(out.clone())));
        let text = out.text();
        assert!(text.contains("\"serverInfo\""), "{text}");
        assert!(text.contains("\"tools\":[{\"name\":\"a\"}"), "{text}");
        assert_eq!(text.lines().count(), 2, "one line per answer: {text}");
        // The session id from initialize rides on later requests; the protocol version too.
        let requests = seen.requests.lock().unwrap();
        let later = requests
            .iter()
            .find(|(_, b)| b.contains("tools/list"))
            .unwrap();
        assert!(later
            .0
            .to_ascii_lowercase()
            .contains("mcp-session-id: sess-1"));
        assert!(later
            .0
            .to_ascii_lowercase()
            .contains("mcp-protocol-version: 2025-06-18"));
        // The stdio side never sees the token.
        assert!(!text.contains("TOKEN_SENTINEL"));
        assert!(!logged.text().contains("TOKEN_SENTINEL"));
    }

    #[test]
    fn an_expired_login_is_renewed_once_and_the_request_retried() {
        let seen = Arc::new(Seen::default());
        let accept = Arc::new(Mutex::new("NEW_TOKEN".to_string()));
        let url = fake_mcp(Arc::clone(&accept), Arc::clone(&seen));
        let refreshed = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&refreshed);
        let bridge = Bridge {
            remote: Arc::new(Remote::new(
                url,
                vec![("Authorization".into(), "Bearer OLD_TOKEN".into())],
            )),
            refresh: Some(Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(vec![("Authorization".into(), "Bearer NEW_TOKEN".into())])
            })),
            log: Arc::new(|_| {}),
        };
        let out = Buffer::default();
        bridge.run(STDIN.as_bytes(), Arc::new(Mutex::new(out.clone())));
        assert!(out.text().contains("\"serverInfo\""), "{}", out.text());
        assert_eq!(
            refreshed.load(Ordering::SeqCst),
            1,
            "renewed once, then the new token sticks"
        );
    }

    #[test]
    fn a_login_signed_out_under_a_running_bridge_stops_it() {
        let seen = Arc::new(Seen::default());
        let url = fake_mcp(Arc::new(Mutex::new("RIGHT".into())), Arc::clone(&seen));
        let bridge = Bridge {
            remote: Arc::new(Remote::new(
                url,
                vec![("Authorization".into(), "Bearer EXPIRED".into())],
            )),
            refresh: Some(Arc::new(|| Err(Failure::SignedOut))),
            log: Arc::new(|_| {}),
        };
        let out = Buffer::default();
        let input = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"a"}}"#,
            "\n",
        );
        bridge.run(input.as_bytes(), Arc::new(Mutex::new(out.clone())));
        let text = out.text();
        assert!(
            text.contains("\"id\":1") && text.contains("signed out"),
            "{text}"
        );
        // Nothing after the sign-out reached the server.
        let requests = seen.requests.lock().unwrap();
        assert!(
            !requests.iter().any(|(_, body)| body.contains("tools/")),
            "{requests:?}"
        );
    }

    #[test]
    fn a_refused_request_gets_a_json_rpc_error_not_silence() {
        let seen = Arc::new(Seen::default());
        let url = fake_mcp(Arc::new(Mutex::new("RIGHT".into())), seen);
        let logged = Buffer::default();
        let log_buf = logged.clone();
        let bridge = Bridge {
            remote: Arc::new(Remote::new(
                url,
                vec![("Authorization".into(), "Bearer WRONG_SECRET".into())],
            )),
            refresh: None,
            log: Arc::new(move |line| {
                let _ = writeln!(log_buf.clone(), "{line}");
            }),
        };
        let out = Buffer::default();
        bridge.run(STDIN.as_bytes(), Arc::new(Mutex::new(out.clone())));
        let text = out.text();
        assert!(text.contains("\"id\":1") && text.contains("401"), "{text}");
        assert!(text.contains("\"id\":2"), "{text}");
        assert!(!text.contains("WRONG_SECRET") && !logged.text().contains("WRONG_SECRET"));
    }
}
