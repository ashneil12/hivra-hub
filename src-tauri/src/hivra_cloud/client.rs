//! The Hivra Cloud HTTP calls. Each call names a fixed route; no caller passes a URL. The bearer token goes only to
//! the configured endpoint, redirects are never followed, and every answer is read as data.

use std::io::Read;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::connectors::oauth;

pub const ACCOUNT_PATH: &str = "/v1/account";
pub const PAIR_PATH: &str = "/v1/machines/pair";
pub const ACCOUNT_TTL_SECS: u64 = 6 * 3600;
pub const FAILURE_RETRY_SECS: u64 = 15 * 60;
const MAX_REPLY_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum CloudError {
    NotSetUp,
    NotSignedIn,
    BadCode,
    Unreachable,
    Refused(u16),
    BadReply,
}

impl CloudError {
    pub fn message(&self) -> String {
        match self {
            CloudError::NotSetUp => "Hivra Cloud is not set up on this Mac.".to_string(),
            CloudError::NotSignedIn => "Sign in to Hivra Cloud first.".to_string(),
            CloudError::BadCode => {
                "That pairing code isn't valid. Copy it again from Hivra Cloud.".to_string()
            }
            CloudError::Unreachable => "Couldn't reach Hivra Cloud. Try again later.".to_string(),
            CloudError::Refused(code) => format!("Hivra Cloud refused the request ({code})."),
            CloudError::BadReply => {
                "Hivra Cloud sent an answer this app couldn't read.".to_string()
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub plan: Option<String>,
    pub machine_limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedMachine {
    pub id: String,
    pub label: String,
    pub ssh_host: Option<String>,
}

pub struct Client {
    base: Url,
    token: String,
    agent: ureq::Agent,
}

impl Client {
    /// `base` must be an endpoint address (https, or loopback). The token is kept for this client only.
    pub fn new(base: Url, token: Option<String>) -> Result<Self, CloudError> {
        if !oauth::secure_or_loopback(base.as_str()) {
            return Err(CloudError::NotSetUp);
        }
        let token = token
            .filter(|t| !t.is_empty())
            .ok_or(CloudError::NotSignedIn)?;
        let agent = ureq::AgentBuilder::new()
            .try_proxy_from_env(false)
            .redirects(0)
            .timeout_connect(Duration::from_secs(5))
            .timeout_read(Duration::from_secs(20))
            .build();
        Ok(Client { base, token, agent })
    }

    fn url(&self, route: &str) -> Result<String, CloudError> {
        self.base
            .join(route)
            .map(|url| url.to_string())
            .map_err(|_| CloudError::BadReply)
    }

    fn send(&self, request: ureq::Request, body: Option<&Value>) -> Result<Value, CloudError> {
        let request = request
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Accept", "application/json");
        let result = match body {
            Some(body) => request
                .set("Content-Type", "application/json")
                .send_string(&body.to_string()),
            None => request.call(),
        };
        match result {
            // ureq returns a 3xx as a normal answer when redirects are off: refuse it, never follow it.
            Ok(response) if (200..300).contains(&response.status()) => {
                read_json(response).ok_or(CloudError::BadReply)
            }
            Ok(response) => Err(CloudError::Refused(response.status())),
            Err(ureq::Error::Status(code, _)) => Err(CloudError::Refused(code)),
            Err(ureq::Error::Transport(_)) => Err(CloudError::Unreachable),
        }
    }

    pub fn account(&self) -> Result<AccountInfo, CloudError> {
        let url = self.url(ACCOUNT_PATH)?;
        let value = self.send(self.agent.get(&url), None)?;
        serde_json::from_value(value).map_err(|_| CloudError::BadReply)
    }

    /// Sends the one-time code only. No key, token or password goes in the body.
    pub fn pair(&self, code: &str) -> Result<PairedMachine, CloudError> {
        if !valid_pair_code(code) {
            return Err(CloudError::BadCode);
        }
        let url = self.url(PAIR_PATH)?;
        let body = serde_json::json!({ "code": code });
        let value = self.send(self.agent.post(&url), Some(&body))?;
        serde_json::from_value(value).map_err(|_| CloudError::BadReply)
    }
}

fn read_json(response: ureq::Response) -> Option<Value> {
    let mut text = String::new();
    response
        .into_reader()
        .take(MAX_REPLY_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    serde_json::from_str(&text).ok()
}

/// Only letters, digits and dashes, 6 to 64 long: a one-time code, never a key.
pub fn valid_pair_code(code: &str) -> bool {
    (6..=64).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// What the app shows for the account: fresh, cached, unavailable, signed out, or off.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub status: &'static str,
    pub plan: Option<String>,
    pub machine_limit: Option<u32>,
    /// Set once per process, the first time the account is unavailable. Never repeated.
    pub notice: Option<String>,
}

impl AccountView {
    /// A view with no account data: `off`, or `signed_out`.
    pub fn without_account(status: &'static str) -> Self {
        AccountView {
            status,
            plan: None,
            machine_limit: None,
            notice: None,
        }
    }

    fn with_info(status: &'static str, info: &AccountInfo, notice: Option<String>) -> Self {
        AccountView {
            status,
            plan: info.plan.clone(),
            machine_limit: info.machine_limit,
            notice,
        }
    }
}

#[derive(Debug)]
pub struct AccountCache {
    ok: Option<(u64, AccountInfo)>,
    failed_at: Option<u64>,
    notice_shown: bool,
}

impl Default for AccountCache {
    fn default() -> Self {
        Self::new()
    }
}

impl AccountCache {
    pub const fn new() -> Self {
        AccountCache {
            ok: None,
            failed_at: None,
            notice_shown: false,
        }
    }

    /// Reads the account through `fetch` unless a fresh answer or a recent failure is already cached. Never returns an
    /// error: a failed check is `unavailable`, and the app goes on.
    pub fn view(
        &mut self,
        now: u64,
        fetch: &mut dyn FnMut() -> Result<AccountInfo, CloudError>,
    ) -> AccountView {
        if let Some((at, info)) = &self.ok {
            if now.saturating_sub(*at) < ACCOUNT_TTL_SECS {
                return AccountView::with_info("cached", info, None);
            }
        }
        let recently_failed = self
            .failed_at
            .is_some_and(|at| now.saturating_sub(at) < FAILURE_RETRY_SECS);
        if !recently_failed {
            match fetch() {
                Ok(info) => {
                    self.ok = Some((now, info.clone()));
                    self.failed_at = None;
                    return AccountView::with_info("fresh", &info, None);
                }
                Err(_) => self.failed_at = Some(now),
            }
        }
        match &self.ok {
            Some((_, info)) => AccountView::with_info("cached", info, None),
            None => {
                let notice = if self.notice_shown {
                    None
                } else {
                    self.notice_shown = true;
                    Some(
                        "Hivra Cloud can't be reached right now. Your own machines still work."
                            .to_string(),
                    )
                };
                AccountView::without_account("unavailable").with_notice(notice)
            }
        }
    }
}

impl AccountView {
    fn with_notice(mut self, notice: Option<String>) -> Self {
        self.notice = notice;
        self
    }
}
#[cfg(test)]
pub(crate) mod stub {
    //! Loopback stand-ins only: a stub cloud on 127.0.0.1 and a listener that records any connection to it.

    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    pub struct Stub {
        pub base: String,
        pub seen: Arc<Mutex<Vec<String>>>,
    }

    /// Answers one connection per reply, in order. Each request is kept whole (head and body) for assertions.
    pub fn serve(replies: Vec<(u16, String, String)>) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("addr").port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_in = seen.clone();
        thread::spawn(move || {
            for (status, headers, body) in replies {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let request = read_request(&mut stream);
                seen_in.lock().unwrap().push(request);
                let reply = format!(
                    "HTTP/1.1 {status} Stub\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        Stub {
            base: format!("http://127.0.0.1:{port}"),
            seen,
        }
    }

    fn read_request(stream: &mut std::net::TcpStream) -> String {
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            data.extend_from_slice(&buf[..n]);
            if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&data[..end]).to_string();
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("Content-Length: ")
                            .or(l.strip_prefix("content-length: "))
                    })
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if data.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&data).to_string()
    }

    /// A loopback port that nothing answers on. Every connection it receives is counted.
    pub struct Silent {
        pub base: String,
        pub port: u16,
        listener: TcpListener,
    }

    pub fn silent() -> Silent {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("addr").port();
        Silent {
            base: format!("http://127.0.0.1:{port}"),
            port,
            listener,
        }
    }

    impl Silent {
        pub fn connections(&self) -> usize {
            let mut count = 0;
            while self.listener.accept().is_ok() {
                count += 1;
            }
            count
        }
    }
}

#[cfg(test)]
mod tests {
    use super::stub::{serve, silent};
    use super::*;

    fn base(url: &str) -> Url {
        Url::parse(url).unwrap()
    }

    #[test]
    fn pairing_sends_only_the_one_time_code_and_no_key() {
        let stub = serve(vec![(
            200,
            String::new(),
            r#"{"id":"m-1","label":"Cloud box","sshHost":"box.example"}"#.into(),
        )]);
        let client = Client::new(base(&stub.base), Some("short-token".into())).unwrap();
        let machine = client.pair("ABCD-1234").unwrap();
        assert_eq!(machine.id, "m-1");
        assert_eq!(machine.label, "Cloud box");
        assert_eq!(machine.ssh_host.as_deref(), Some("box.example"));
        let seen = stub.seen.lock().unwrap();
        let request = &seen[0];
        assert!(request.starts_with("POST /v1/machines/pair "), "{request}");
        let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
        assert_eq!(body, r#"{"code":"ABCD-1234"}"#);
    }

    #[test]
    fn a_bad_pairing_code_never_reaches_the_network() {
        let silent = silent();
        let client = Client::new(base(&silent.base), Some("t".into())).unwrap();
        assert_eq!(client.pair("x y"), Err(CloudError::BadCode));
        assert_eq!(silent.connections(), 0);
    }

    #[test]
    fn the_token_is_never_sent_to_a_redirect_target() {
        let other = silent();
        let stub = serve(vec![(
            302,
            format!("Location: http://127.0.0.1:{}/v1/account\r\n", other.port),
            String::new(),
        )]);
        let client = Client::new(base(&stub.base), Some("short-token".into())).unwrap();
        assert_eq!(client.account(), Err(CloudError::Refused(302)));
        assert_eq!(other.connections(), 0);
    }

    #[test]
    fn a_client_without_a_token_refuses_before_any_request() {
        let silent = silent();
        assert_eq!(
            Client::new(base(&silent.base), None).err(),
            Some(CloudError::NotSignedIn)
        );
        assert_eq!(silent.connections(), 0);
    }

    #[test]
    fn account_is_fetched_once_then_cached_for_six_hours() {
        let mut cache = AccountCache::new();
        let mut calls = 0;
        let mut fetch = || {
            calls += 1;
            Ok(AccountInfo {
                plan: Some("pro".into()),
                machine_limit: Some(2),
            })
        };
        let first = cache.view(1_000, &mut fetch);
        assert_eq!(first.status, "fresh");
        assert_eq!(first.plan.as_deref(), Some("pro"));
        let second = cache.view(1_000 + ACCOUNT_TTL_SECS - 1, &mut fetch);
        assert_eq!(second.status, "cached");
        assert_eq!(calls, 1);
    }

    #[test]
    fn a_failed_account_check_fails_soft_and_retries_only_after_the_wait() {
        let mut cache = AccountCache::new();
        let mut calls = 0;
        let mut fetch = || {
            calls += 1;
            Err(CloudError::Unreachable)
        };
        let first = cache.view(5_000, &mut fetch);
        assert_eq!(first.status, "unavailable");
        assert!(first.notice.is_some(), "the first failure says so once");
        let soon = cache.view(5_000 + 60, &mut fetch);
        assert_eq!(soon.status, "unavailable");
        assert_eq!(soon.notice, None, "never nag twice");
        let later = cache.view(5_000 + FAILURE_RETRY_SECS, &mut fetch);
        assert_eq!(later.notice, None);
        assert_eq!(calls, 2, "one try, then one retry after the wait");
    }

    #[test]
    fn an_account_refusal_from_a_stub_is_unavailable_not_an_error() {
        let stub = serve(vec![(500, String::new(), r#"{"error":"down"}"#.into())]);
        let client = Client::new(base(&stub.base), Some("t".into())).unwrap();
        let mut cache = AccountCache::new();
        let view = cache.view(10, &mut || client.account());
        assert_eq!(view.status, "unavailable");
    }

    #[test]
    fn codes_are_letters_digits_and_dashes_only() {
        assert!(valid_pair_code("ABCD-1234"));
        assert!(!valid_pair_code("short"));
        assert!(!valid_pair_code("has space 12"));
        assert!(!valid_pair_code("https://x.example/key"));
    }
}
