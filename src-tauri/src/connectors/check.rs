//! The Test button: does this login really work? A read-only identity call where the provider has one ("Connected as
//! ashneil12"), then a real MCP handshake (initialize and tools/list) against the server exactly as a session would
//! start it. Every message is redacted before it leaves.

use super::builtin::Telegram;
use super::catalog::Entry;
use super::launch::{find_on_path, plan, stdio_command, Plan};
use super::remote::{handshake, PostError, Remote};
use super::secrets::{redact, Login, SecretStore};
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// A local server may download itself on first use (`npx -y …`).
const STDIO_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<usize>,
}

/// `dir`: the app's data folder, where the connector's renewal lock is (renew.rs).
pub fn run(entry: &Entry, login: &mut Login, store: &dyn SecretStore, dir: &Path) -> Outcome {
    let outcome = test(entry, login, store, dir);
    let secrets = login.secrets();
    Outcome {
        message: redact(&outcome.message, &secrets),
        account: outcome.account.map(|a| redact(&a, &secrets)),
        ..outcome
    }
}

fn test(entry: &Entry, login: &mut Login, store: &dyn SecretStore, dir: &Path) -> Outcome {
    let account = match identity(entry, login) {
        Ok(account) => account,
        Err(why) => return failed(why),
    };
    let plan = match plan(entry, login) {
        Ok(plan) => plan,
        Err(why) => return failed(why),
    };
    let (tools, account) = match plan {
        Plan::Remote { url, headers } => {
            let remote = Remote::new(url, headers);
            let mut result = handshake(&remote);
            if result == Err(PostError::Unauthorized) && login.oauth.is_some() {
                // Renewed under the lock every session's bridge takes too, and kept before it is used (renew.rs): the
                // provider may have retired the old refresh token, so a login that isn't kept is lost.
                match super::renew::renew(dir, store, &entry.id, login) {
                    Ok(renewed) => {
                        *login = renewed;
                        if let Ok(Plan::Remote { url, headers }) = super::launch::plan(entry, login)
                        {
                            result = handshake(&Remote::new(url, headers));
                        }
                    }
                    Err(failure) => {
                        return failed(format!("{}: {}", entry.name, failure.message()))
                    }
                }
            }
            match result {
                Ok(count) => (count, account),
                Err(error) => return failed(error.message()),
            }
        }
        Plan::Telegram { token } => {
            let bot = Telegram::new(token);
            match bot.call("getMe", &serde_json::json!({})) {
                Ok(me) => (
                    Telegram::tools().as_array().map(Vec::len).unwrap_or(0),
                    me.get("username")
                        .and_then(Value::as_str)
                        .map(|u| format!("@{u}")),
                ),
                Err(why) => return failed(why),
            }
        }
        Plan::Stdio { command, args, env } => {
            match stdio_handshake(&command, &args, &env, STDIO_TIMEOUT) {
                Ok(count) => (count, account),
                Err(why) => return failed(why),
            }
        }
    };
    let message = match &account {
        Some(account) => format!("Connected as {account} · {tools} tools"),
        None => format!("Connected · {tools} tools"),
    };
    Outcome {
        ok: true,
        message,
        account,
        tools: Some(tools),
    }
}

fn failed(message: String) -> Outcome {
    Outcome {
        ok: false,
        message,
        account: None,
        tools: None,
    }
}

/// The provider's own "who am I" call, when the catalog names one.
fn identity(entry: &Entry, login: &Login) -> Result<Option<String>, String> {
    let Some(spec) = &entry.test else {
        return Ok(None);
    };
    let values = login.values();
    let mut request = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build()
        .get(&spec.url);
    for (name, value) in &spec.headers {
        request = request.set(name, &super::catalog::fill(value, &values)?);
    }
    let reply: Value = match request.call() {
        Ok(response) => super::remote::json_body(response)
            .ok_or_else(|| format!("{}'s answer wasn't readable.", entry.name))?,
        Err(ureq::Error::Status(401 | 403, _)) => {
            return Err(format!(
                "{} refused the login. Check it and sign in again.",
                entry.name
            ))
        }
        Err(ureq::Error::Status(code, _)) => {
            return Err(format!("{} answered {code}.", entry.name))
        }
        Err(ureq::Error::Transport(_)) => return Err(format!("Couldn't reach {}.", entry.name)),
    };
    if let Some(pointer) = &spec.ok_field {
        if reply.pointer(pointer) != Some(&Value::Bool(true)) {
            let why = reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("refused");
            return Err(format!("{} refused the login ({why}).", entry.name));
        }
    }
    Ok(spec
        .account
        .as_ref()
        .and_then(|pointer| reply.pointer(pointer))
        .and_then(|v| {
            v.as_str()
                .map(str::to_string)
                .or_else(|| Some(v.to_string()))
        })
        .filter(|s| !s.is_empty() && s != "null"))
}

/// initialize, then tools/list, over a running server's stdio; the number of tools.
fn talk(
    command: &str,
    stdin: &mut impl Write,
    rx: &mpsc::Receiver<Value>,
    deadline: Instant,
) -> Result<usize, String> {
    // A server that exits at once (a wrong key, a missing dependency) is one failure, whether it was
    // gone before a request was written (the write fails) or after (its output ends). Which of the two
    // we see is only timing, so both read the same.
    let stopped = || format!("{command} stopped before it answered.");
    let wait_for = |id: i64| -> Result<Value, String> {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!("{command} didn't answer in time."));
            }
            match rx.recv_timeout(left) {
                Ok(value) if value.get("id") == Some(&serde_json::json!(id)) => return Ok(value),
                Ok(_) => continue,
                Err(_) => return Err(stopped()),
            }
        }
    };
    let init = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion": super::remote::PROTOCOL_VERSION, "capabilities": {},
        "clientInfo": {"name": "monocode-hub-test", "version": env!("CARGO_PKG_VERSION")}}});
    writeln!(stdin, "{init}").map_err(|_| stopped())?;
    let reply = wait_for(1)?;
    if let Some(error) = reply.pointer("/error/message").and_then(Value::as_str) {
        return Err(format!("{command}: {error}"));
    }
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#
    )
    .and_then(|_| {
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{{}}}}"#
        )
    })
    .map_err(|_| stopped())?;
    let listed = wait_for(2)?;
    if let Some(error) = listed.pointer("/error/message").and_then(Value::as_str) {
        return Err(format!("{command}: {error}"));
    }
    Ok(listed
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0))
}

/// Start the local server as a session would, and run initialize + tools/list over its stdio.
pub fn stdio_handshake(
    command: &str,
    args: &[String],
    env: &[(String, String)],
    timeout: Duration,
) -> Result<usize, String> {
    let program =
        find_on_path(command).ok_or_else(|| format!("{command} isn't installed on this Mac."))?;
    // Started exactly as a session's launcher starts it (launch.rs `stdio_command`).
    let mut child = stdio_command(&program, args, env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // A server's own log could echo its configuration: never read it.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start {command}: {}", e.kind()))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let result = talk(command, &mut stdin, &rx, Instant::now() + timeout);
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[cfg(test)]
mod tests {
    use super::super::bridge::tests::{fake_mcp, Seen};
    use super::super::catalog;
    use super::super::secrets::Memory;
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    #[test]
    fn a_local_server_is_tested_over_its_own_stdio() {
        // A stand-in MCP server: a script that answers initialize and tools/list, and checks its env. A shell script
        // here, a batch file on Windows (which can't run `.sh`). `set /p` may take both of the client's next lines at
        // once from a pipe, so the batch file reads once before its second answer.
        let dir = std::env::temp_dir().join(format!("mc-stdio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(not(windows))]
        let (script, text) = (
            dir.join("fake-mcp.sh"),
            "#!/bin/sh\n[ \"$FAKE_KEY\" = \"KEY_SENTINEL\" ] || exit 3\nread a\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'\nread b\nread c\necho '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"x\"}]}}'\nsleep 5\n",
        );
        #[cfg(windows)]
        let (script, text) = (
            dir.join("fake-mcp.cmd"),
            "@echo off\r\nif not \"%FAKE_KEY%\"==\"KEY_SENTINEL\" exit /b 3\r\nset /p a=\r\necho {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\r\nset /p b=\r\necho {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"x\"}]}}\r\nping -n 6 127.0.0.1 >nul\r\n",
        );
        std::fs::write(&script, text).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = script.to_string_lossy().to_string();
        let ok = stdio_handshake(
            &path,
            &[],
            &[("FAKE_KEY".into(), "KEY_SENTINEL".into())],
            Duration::from_secs(10),
        );
        assert_eq!(ok, Ok(1));
        let wrong = stdio_handshake(
            &path,
            &[],
            &[("FAKE_KEY".into(), "nope".into())],
            Duration::from_secs(10),
        );
        assert!(wrong.unwrap_err().contains("stopped before it answered"));
        assert!(
            stdio_handshake("no-such-command-here", &[], &[], Duration::from_secs(1))
                .unwrap_err()
                .contains("isn't installed")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_hosted_server_is_tested_with_a_real_handshake() {
        let seen = Arc::new(Seen::default());
        let url = fake_mcp(Arc::new(Mutex::new("GOOD".into())), seen);
        let remote = Remote::new(
            url.clone(),
            vec![("Authorization".into(), "Bearer GOOD".into())],
        );
        assert_eq!(handshake(&remote), Ok(2));
        let refused = Remote::new(url, vec![("Authorization".into(), "Bearer BAD".into())]);
        assert_eq!(handshake(&refused), Err(PostError::Unauthorized));
    }

    /// A store whose every write fails (a locked Keychain, say).
    #[derive(Default)]
    struct ReadOnly(Memory);
    impl SecretStore for ReadOnly {
        fn get(&self, id: &str) -> Result<Option<Login>, String> {
            self.0.get(id)
        }
        fn put(&self, _: &str, _: &Login) -> Result<(), String> {
            Err("The Keychain refused the change.".into())
        }
        fn remove(&self, id: &str) -> Result<bool, String> {
            self.0.remove(id)
        }
    }

    /// A hosted server reached with an OAuth login whose access token the server no longer takes.
    fn oauth_entry(url: String) -> Entry {
        use super::super::catalog::{Auth, Launch, Method};
        Entry {
            id: "notion".into(),
            name: "Notion".into(),
            composio: false,
            launch: Launch::Remote {
                url,
                headers: BTreeMap::from([("Authorization".into(), "Bearer {token}".into())]),
            },
            auth: Auth {
                methods: vec![Method::Oauth],
                fields: vec![],
                oauth: None,
            },
            test: None,
        }
    }

    #[test]
    fn a_renewed_login_that_cant_be_saved_fails_the_test() {
        use super::super::oauth::tests::{rotating_login, rotating_token_endpoint};
        let (token_url, sent) = rotating_token_endpoint(Duration::ZERO);
        // The server takes only the renewed token.
        let mcp = fake_mcp(
            Arc::new(Mutex::new("ACCESS_1".into())),
            Arc::new(Seen::default()),
        );
        let entry = oauth_entry(mcp);
        let mut login = rotating_login(&token_url, super::super::oauth::now() + 3600);
        let store = ReadOnly::default();
        store.0.put("notion", &login).unwrap();
        let dir = std::env::temp_dir().join(format!("mc-check-{}", uuid::Uuid::new_v4()));
        let outcome = run(&entry, &mut login, &store, &dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(*sent.lock().unwrap(), vec!["REFRESH_0".to_string()]);
        // The provider has moved on to REFRESH_1, but the Keychain still holds REFRESH_0: not "Connected".
        assert!(!outcome.ok, "{outcome:?}");
        assert!(
            outcome.message.contains("couldn't be saved"),
            "{}",
            outcome.message
        );
    }

    #[test]
    fn a_failed_test_never_quotes_the_login() {
        // The identity call goes to GitHub's real API only when a test opts in; here a refused handshake stands in.
        let entry = catalog::entry("zapier").unwrap();
        let mut login = Login {
            fields: BTreeMap::from([(
                "mcp_url".into(),
                "http://127.0.0.1:9/SECRET_PATH_SENTINEL/mcp".into(),
            )]),
            refs: BTreeMap::new(),
            oauth: None,
        };
        let outcome = run(entry, &mut login, &Memory::default(), &std::env::temp_dir());
        assert!(!outcome.ok);
        assert!(
            !outcome.message.contains("SECRET_PATH_SENTINEL"),
            "{}",
            outcome.message
        );
    }
}
