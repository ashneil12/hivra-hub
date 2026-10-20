//! The client half of MCP's Streamable HTTP transport: POST one JSON-RPC message, read back JSON or an SSE stream.
//!
//! Used by the stdio bridge (`bridge.rs`) and the Test button. Headers (with the login) live only in this struct, in
//! memory; errors never include them or the URL's query.

use std::io::{BufRead, BufReader, Read};
use std::sync::Mutex;
use std::time::Duration;

pub const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Debug, PartialEq, Eq)]
pub enum PostError {
    /// 401: the login was refused or has expired.
    Unauthorized,
    /// Another HTTP status, with a short reason.
    Status(u16, String),
    /// The server couldn't be reached.
    Transport(String),
}

impl PostError {
    pub fn message(&self) -> String {
        match self {
            PostError::Unauthorized => "The server refused the login (401). Sign in again.".into(),
            PostError::Status(code, reason) if reason.is_empty() => {
                format!("The server answered {code}.")
            }
            PostError::Status(code, reason) => format!("The server answered {code}: {reason}"),
            PostError::Transport(why) => why.clone(),
        }
    }
}

pub struct Remote {
    agent: ureq::Agent,
    url: String,
    headers: Mutex<Vec<(String, String)>>,
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
}

pub fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        // A tool call can take minutes; SSE streams stay open until the reply.
        .timeout_read(Duration::from_secs(600))
        .timeout_write(Duration::from_secs(60))
        .build()
}

/// The URL as it may be shown: scheme and host only. A key can live in the path (Zapier) or the query.
pub fn display_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or("")),
        Err(_) => "the server".into(),
    }
}

impl Remote {
    pub fn new(url: String, headers: Vec<(String, String)>) -> Self {
        Self {
            agent: agent(),
            url,
            headers: Mutex::new(headers),
            session: Mutex::new(None),
            protocol: Mutex::new(None),
        }
    }

    pub fn set_headers(&self, headers: Vec<(String, String)>) {
        *self.headers.lock().unwrap() = headers;
    }

    pub fn session_id(&self) -> Option<String> {
        self.session.lock().unwrap().clone()
    }

    /// Send one message. Every JSON-RPC message the server answers with is handed to `emit` (one per line).
    pub fn post(&self, body: &str, emit: &mut dyn FnMut(String)) -> Result<(), PostError> {
        let mut request = self
            .agent
            .post(&self.url)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream");
        for (name, value) in self.headers.lock().unwrap().iter() {
            request = request.set(name, value);
        }
        if let Some(session) = self.session.lock().unwrap().as_deref() {
            request = request.set("Mcp-Session-Id", session);
        }
        if let Some(protocol) = self.protocol.lock().unwrap().as_deref() {
            request = request.set("MCP-Protocol-Version", protocol);
        }
        let response = match request.send_string(body) {
            Ok(response) => response,
            Err(ureq::Error::Status(401, _)) => return Err(PostError::Unauthorized),
            Err(ureq::Error::Status(code, response)) => {
                return Err(PostError::Status(code, short_reason(response)))
            }
            Err(ureq::Error::Transport(_)) => {
                return Err(PostError::Transport(format!(
                    "Couldn't reach {}.",
                    display_url(&self.url)
                )))
            }
        };
        if let Some(session) = response.header("mcp-session-id") {
            *self.session.lock().unwrap() = Some(session.to_string());
        }
        let content_type = response
            .header("content-type")
            .unwrap_or("")
            .to_ascii_lowercase();
        let status = response.status();
        if status == 202 || status == 204 {
            return Ok(());
        }
        let reader = response.into_reader();
        if content_type.starts_with("text/event-stream") {
            read_sse(reader, emit);
        } else {
            let mut text = String::new();
            reader
                .take(64 * 1024 * 1024)
                .read_to_string(&mut text)
                .map_err(|_| PostError::Transport("The server's answer was cut off.".into()))?;
            let text = text.trim();
            if !text.is_empty() {
                // A batch answer is split into one message per line, as stdio expects.
                match serde_json::from_str::<serde_json::Value>(text) {
                    Ok(serde_json::Value::Array(items)) => {
                        for item in items {
                            emit(item.to_string());
                        }
                    }
                    Ok(value) => emit(value.to_string()),
                    Err(_) => {
                        return Err(PostError::Status(status, "the answer wasn't JSON".into()))
                    }
                }
            }
        }
        Ok(())
    }

    /// The protocol version the server agreed in `initialize`, sent on every later request.
    pub fn note_protocol(&self, message: &str) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(message) {
            if let Some(version) = value
                .pointer("/result/protocolVersion")
                .and_then(|v| v.as_str())
            {
                *self.protocol.lock().unwrap() = Some(version.to_string());
            }
        }
    }

    /// Best-effort goodbye: ends the server's session.
    pub fn close(&self) {
        let Some(session) = self.session_id() else {
            return;
        };
        let mut request = self.agent.delete(&self.url).set("Mcp-Session-Id", &session);
        for (name, value) in self.headers.lock().unwrap().iter() {
            request = request.set(name, value);
        }
        let _ = request.call();
    }
}

/// Server-sent events: each event's `data:` lines joined, handed on when the blank line ends it.
pub fn read_sse(reader: impl Read, emit: &mut dyn FnMut(String)) {
    let mut data: Vec<String> = Vec::new();
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        let line = line.strip_suffix('\r').unwrap_or(&line).to_string();
        if line.is_empty() {
            if !data.is_empty() {
                emit(data.join("\n"));
                data.clear();
            }
        } else if let Some(rest) = line.strip_prefix("data:") {
            data.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
        // `event:`, `id:`, `retry:` and `:` comments carry nothing the stdio side needs.
    }
    if !data.is_empty() {
        emit(data.join("\n"));
    }
}

/// A response body as JSON (at most 4 MB), or `None`. (ureq is built without its json feature here.)
pub fn json_body(response: ureq::Response) -> Option<serde_json::Value> {
    let mut text = String::new();
    response
        .into_reader()
        .take(4 * 1024 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    serde_json::from_str(&text).ok()
}

fn short_reason(response: ureq::Response) -> String {
    let mut text = String::new();
    let _ = response.into_reader().take(2048).read_to_string(&mut text);
    let value: Option<serde_json::Value> = serde_json::from_str(&text).ok();
    let reason = value
        .as_ref()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.pointer("/error_description"))
                .or_else(|| v.pointer("/message"))
                .or_else(|| v.pointer("/error"))
        })
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_default();
    reason.chars().take(200).collect()
}

/// Run `initialize`, `notifications/initialized` and `tools/list` against a server: what the Test button proves.
pub fn handshake(remote: &Remote) -> Result<usize, PostError> {
    let init = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "monocode-hub-test", "version": env!("CARGO_PKG_VERSION") }
        }
    });
    let mut replies = Vec::new();
    remote.post(&init.to_string(), &mut |m| replies.push(m))?;
    let reply = replies
        .iter()
        .find(|m| m.contains("\"id\":1"))
        .ok_or_else(|| PostError::Status(200, "no answer to initialize".into()))?;
    if let Some(error) = rpc_error(reply) {
        return Err(PostError::Status(200, error));
    }
    remote.note_protocol(reply);
    remote.post(
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        &mut |_| {},
    )?;
    let mut listed = Vec::new();
    remote.post(
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        &mut |m| listed.push(m),
    )?;
    let tools = listed
        .iter()
        .filter_map(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .find(|v| v.get("id") == Some(&serde_json::json!(2)))
        .ok_or_else(|| PostError::Status(200, "no answer to tools/list".into()))?;
    if let Some(error) = tools.pointer("/error/message").and_then(|v| v.as_str()) {
        return Err(PostError::Status(200, error.chars().take(200).collect()));
    }
    let count = tools
        .pointer("/result/tools")
        .and_then(|v| v.as_array())
        .map(Vec::len)
        .unwrap_or(0);
    remote.close();
    Ok(count)
}

fn rpc_error(message: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(message).ok()?;
    value
        .pointer("/error/message")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_events_become_one_message_each() {
        let stream = "event: message\r\ndata: {\"a\":1}\r\n\r\n: keep-alive\n\ndata: {\"b\":\ndata: 2}\n\ndata: {\"c\":3}";
        let mut got = Vec::new();
        read_sse(stream.as_bytes(), &mut |m| got.push(m));
        assert_eq!(got, vec!["{\"a\":1}", "{\"b\":\n2}", "{\"c\":3}"]);
    }

    #[test]
    fn display_url_drops_paths_queries_and_user_info() {
        assert_eq!(
            display_url("https://user:pw@mcp.example.com/api/mcp/s/SECRET/mcp?api_key=SECRET"),
            "https://mcp.example.com"
        );
        assert_eq!(display_url("not a url"), "the server");
    }
}
