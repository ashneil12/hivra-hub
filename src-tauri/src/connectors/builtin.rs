//! MCP servers built into this binary, for apps with a plain HTTP API and no official server: Telegram's Bot API.
//!
//! The bot token is part of every Bot API URL, so no error here is ever formatted from the HTTP library (its errors
//! quote the URL). Each failure is a sentence of our own, and everything printed also goes through `redact`.

use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::time::Duration;

pub struct Telegram {
    token: String,
    api: String,
    agent: ureq::Agent,
}

impl Telegram {
    pub fn new(token: String) -> Self {
        Self::with_api(token, "https://api.telegram.org".into())
    }

    pub fn with_api(token: String, api: String) -> Self {
        Self {
            token,
            api,
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(70))
                .build(),
        }
    }

    /// Call one Bot API method. The answer's `result`, or a plain error naming the method and Telegram's description.
    pub fn call(&self, method: &str, params: &Value) -> Result<Value, String> {
        let url = format!("{}/bot{}/{method}", self.api, self.token);
        let reply: Value = match self
            .agent
            .post(&url)
            .set("Content-Type", "application/json")
            .send_string(&params.to_string())
        {
            Ok(response) => super::remote::json_body(response)
                .ok_or_else(|| format!("Telegram's answer to {method} wasn't readable."))?,
            Err(ureq::Error::Status(code, response)) => {
                let mut text = String::new();
                let _ = response.into_reader().take(4096).read_to_string(&mut text);
                let description = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_default();
                return Err(format!(
                    "Telegram refused {method} ({code}){}",
                    if description.is_empty() {
                        String::new()
                    } else {
                        format!(": {description}")
                    }
                ));
            }
            Err(ureq::Error::Transport(_)) => return Err("Couldn't reach Telegram.".into()),
        };
        if reply.get("ok") == Some(&Value::Bool(true)) {
            Ok(reply.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(format!("Telegram refused {method}."))
        }
    }

    pub fn tools() -> Value {
        json!([
            {
                "name": "telegram_get_me",
                "description": "Who the bot is (its username and id).",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "telegram_send_message",
                "description": "Send a text message from the bot to a chat it is in (a user who started it, a group or a channel).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "chat_id": { "type": ["string", "integer"], "description": "Chat id, or @channelusername" },
                        "text": { "type": "string" },
                        "parse_mode": { "type": "string", "enum": ["MarkdownV2", "HTML"] }
                    },
                    "required": ["chat_id", "text"]
                }
            },
            {
                "name": "telegram_get_updates",
                "description": "New messages sent to the bot since the last call (pass offset = last update_id + 1).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "offset": { "type": "integer" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                    }
                }
            }
        ])
    }

    fn tool(&self, name: &str, args: &Value) -> Result<Value, String> {
        match name {
            "telegram_get_me" => self.call("getMe", &json!({})),
            "telegram_send_message" => {
                let chat_id = args.get("chat_id").cloned().ok_or("chat_id is required")?;
                let text = args
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or("text is required")?;
                let mut params = json!({ "chat_id": chat_id, "text": text });
                if let Some(mode) = args.get("parse_mode").and_then(Value::as_str) {
                    params["parse_mode"] = json!(mode);
                }
                self.call("sendMessage", &params)
            }
            "telegram_get_updates" => {
                let mut params = json!({ "timeout": 0 });
                for key in ["offset", "limit"] {
                    if let Some(v) = args.get(key).and_then(Value::as_i64) {
                        params[key] = json!(v);
                    }
                }
                self.call("getUpdates", &params)
            }
            other => Err(format!("No tool called {other}.")),
        }
    }

    /// Answer one JSON-RPC message; `None` for a notification.
    pub fn handle(&self, message: &Value) -> Option<Value> {
        let id = message.get("id").cloned()?;
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": message.pointer("/params/protocolVersion").cloned().unwrap_or(json!(super::remote::PROTOCOL_VERSION)),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "monocode-telegram", "version": env!("CARGO_PKG_VERSION") }
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": Self::tools() })),
            "tools/call" => {
                let name = message
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let args = message
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                Ok(match self.tool(name, &args) {
                    Ok(value) => {
                        json!({ "content": [{ "type": "text", "text": value.to_string() }] })
                    }
                    Err(why) => {
                        json!({ "content": [{ "type": "text", "text": self.clean(&why) }], "isError": true })
                    }
                })
            }
            _ => Err(json!({ "code": -32601, "message": format!("Unknown method {method}") })),
        };
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
        })
    }

    fn clean(&self, text: &str) -> String {
        super::secrets::redact(text, std::slice::from_ref(&self.token))
    }

    /// Serve MCP over stdio until stdin closes.
    pub fn serve(&self, input: impl BufRead, mut out: impl Write) {
        for line in input.lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if let Some(reply) = self.handle(&message) {
                let text = self.clean(&reply.to_string());
                let _ = writeln!(out, "{text}");
                let _ = out.flush();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::bridge::tests::{read_request, Buffer};
    use super::*;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn fake_bot_api(seen: Arc<Mutex<Vec<String>>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let (head, body) = read_request(&mut stream);
                seen.lock().unwrap().push(format!("{head}{body}"));
                let reply = if head.contains("/botGOOD_TOKEN/getMe") {
                    json!({"ok": true, "result": {"id": 1, "username": "ash_hub_bot"}})
                } else if head.contains("/botGOOD_TOKEN/sendMessage") {
                    json!({"ok": true, "result": {"message_id": 7}})
                } else {
                    let b = json!({"ok": false, "description": "Unauthorized"}).to_string();
                    let _ = write!(stream, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
                    continue;
                };
                let b = reply.to_string();
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
            }
        });
        base
    }

    #[test]
    fn serves_mcp_over_stdio_against_the_bot_api() {
        let api = fake_bot_api(Arc::default());
        let bot = Telegram::with_api("GOOD_TOKEN".into(), api);
        let input = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"telegram_send_message","arguments":{"chat_id":42,"text":"hi"}}}"#,
            "\n",
        );
        let out = Buffer::default();
        bot.serve(input.as_bytes(), out.clone());
        let lines: Vec<Value> = out
            .text()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 3, "the notification gets no answer");
        assert_eq!(lines[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(lines[1]["result"]["tools"].as_array().unwrap().len(), 3);
        assert!(lines[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("message_id"));
        assert!(!out.text().contains("GOOD_TOKEN"));
    }

    #[test]
    fn a_refused_token_never_appears_in_the_answer() {
        let api = fake_bot_api(Arc::default());
        let bot = Telegram::with_api("BAD_TOKEN_SENTINEL".into(), api);
        let reply = bot
            .handle(&json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"telegram_get_me"}}))
            .unwrap();
        let text = reply.to_string();
        assert_eq!(reply["result"]["isError"], true);
        assert!(text.contains("Unauthorized"), "{text}");
        assert!(!text.contains("BAD_TOKEN_SENTINEL"), "{text}");
        let err = bot.call("getMe", &json!({})).unwrap_err();
        assert!(!err.contains("BAD_TOKEN_SENTINEL"), "{err}");
    }
}
