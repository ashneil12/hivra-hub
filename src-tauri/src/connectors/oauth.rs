//! Browser sign-in for connectors whose provider allows it. Ash signs in on the provider's own page; the app never
//! sees or types his password. It only receives the authorization code on a loopback address and swaps it for tokens,
//! which go straight into the Keychain.
//!
//! - **MCP servers** (Notion, Linear, Supabase, Vercel, …): MCP authorization. Discovery from the server
//!   (RFC 9728 protected-resource metadata, then RFC 8414 / OIDC metadata), dynamic client registration (RFC 7591),
//!   authorization code with PKCE (S256), and the RFC 8707 `resource` on every request.
//! - **Google** (Gmail, Calendar, Drive, Docs, Sheets): Google has no client registration, so Ash makes one OAuth client
//!   in his own Google Cloud project; its ID and secret are kept in the Keychain like any login.

use super::catalog::{GoogleClient, OAuthMode, OAuthSpec};
use super::remote::{display_url, json_body};
use super::secrets::OAuthTokens;
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Long enough to find a password manager and approve on a phone.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq)]
pub struct Endpoints {
    pub authorize: String,
    pub token: String,
    pub register: Option<String>,
    pub scopes: Vec<String>,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// An address a login may go to: https, or plain http only to this Mac (a server Ash runs himself).
pub fn secure_or_loopback(value: &str) -> bool {
    match url::Url::parse(value) {
        Ok(url) if url.scheme() == "https" => url.host_str().is_some(),
        Ok(url) if url.scheme() == "http" => {
            matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        }
        _ => false,
    }
}

/// `value`, if it is [`secure_or_loopback`]; else why not, in words.
fn secure(value: String, what: &str) -> Result<String, String> {
    if secure_or_loopback(&value) {
        Ok(value)
    } else {
        Err(format!(
            "The sign-in server named an address for its {what} that isn't https ({}), so MonoCode Hub won't send a login there.",
            display_url(&value)
        ))
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .redirects(3)
        .build()
}

fn get_json(agent: &ureq::Agent, url: &str) -> Option<Value> {
    json_body(
        agent
            .get(url)
            .set("Accept", "application/json")
            .call()
            .ok()?,
    )
}

/// `resource_metadata="…"` and `scope="…"` from a 401's `WWW-Authenticate: Bearer …`.
pub fn parse_www_authenticate(header: &str) -> (Option<String>, Option<String>) {
    let param = |name: &str| -> Option<String> {
        let at = header.find(&format!("{name}=\""))?;
        let rest = &header[at + name.len() + 2..];
        rest.find('"').map(|end| rest[..end].to_string())
    };
    (param("resource_metadata"), param("scope"))
}

/// Find the authorization server of an MCP server.
pub fn discover(mcp_url: &str) -> Result<Endpoints, String> {
    let agent = agent();
    let base =
        url::Url::parse(mcp_url).map_err(|_| "The server address isn't valid.".to_string())?;
    let origin = base.origin().ascii_serialization();
    // An unauthenticated initialize: the 401 names the metadata (MCP 2025-06-18).
    let probe = agent
        .post(mcp_url)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send_string(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"monocode-hub","version":"1"}}}"#);
    let (mut metadata_url, mut scope) = (None, None);
    if let Err(ureq::Error::Status(401, response)) = probe {
        if let Some(header) = response.header("www-authenticate") {
            (metadata_url, scope) = parse_www_authenticate(header);
        }
    }
    let path = base.path().trim_end_matches('/');
    // Metadata over plain http could be swapped on the way: only an https (or loopback) address is read.
    let mut candidates: Vec<String> = metadata_url
        .into_iter()
        .filter(|url| secure_or_loopback(url))
        .collect();
    if !path.is_empty() {
        candidates.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
    }
    candidates.push(format!("{origin}/.well-known/oauth-protected-resource"));
    let resource = candidates.iter().find_map(|url| get_json(&agent, url));
    let issuer = resource
        .as_ref()
        .and_then(|r| r.pointer("/authorization_servers/0"))
        .and_then(Value::as_str)
        .map(str::to_string)
        // The 2025-03-26 spec: the MCP server's own origin is the authorization server.
        .unwrap_or_else(|| origin.clone());
    let scopes: Vec<String> = scope
        .map(|s| s.split_whitespace().map(str::to_string).collect())
        .or_else(|| {
            resource
                .as_ref()
                .and_then(|r| r.get("scopes_supported"))
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
        })
        .unwrap_or_default();
    let issuer = secure(issuer, "sign-in")?;
    let issuer_url =
        url::Url::parse(&issuer).map_err(|_| "The sign-in server isn't valid.".to_string())?;
    let issuer_origin = issuer_url.origin().ascii_serialization();
    let issuer_path = issuer_url.path().trim_end_matches('/');
    let metadata_candidates = if issuer_path.is_empty() {
        vec![
            format!("{issuer_origin}/.well-known/oauth-authorization-server"),
            format!("{issuer_origin}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{issuer_origin}/.well-known/oauth-authorization-server{issuer_path}"),
            format!("{issuer_origin}/.well-known/openid-configuration{issuer_path}"),
            format!("{issuer_origin}{issuer_path}/.well-known/openid-configuration"),
        ]
    };
    let metadata = metadata_candidates
        .iter()
        .find_map(|url| get_json(&agent, url));
    let field = |name: &str, fallback: &str| -> String {
        metadata
            .as_ref()
            .and_then(|m| m.get(name))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{issuer_origin}{fallback}"))
    };
    let register = metadata
        .as_ref()
        .map(|m| {
            m.get("registration_endpoint")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| Some(format!("{issuer_origin}/register")));
    Ok(Endpoints {
        authorize: secure(
            field("authorization_endpoint", "/authorize"),
            "sign-in page",
        )?,
        token: secure(field("token_endpoint", "/token"), "tokens")?,
        register: register
            .map(|url| secure(url, "app registration"))
            .transpose()?,
        scopes,
    })
}

/// Dynamic client registration: the hub registers itself for this one redirect address.
pub fn register(endpoint: &str, redirect: &str) -> Result<(String, Option<String>), String> {
    secure(endpoint.to_string(), "app registration")?;
    let body = serde_json::json!({
        "client_name": "MonoCode Hub",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let response = agent()
        .post(endpoint)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!(
                "{} didn't let the app register for sign-in ({code}).",
                display_url(endpoint)
            ),
            ureq::Error::Transport(_) => format!("Couldn't reach {}.", display_url(endpoint)),
        })?;
    let reply = json_body(response).ok_or("The sign-in server's answer wasn't readable.")?;
    let id = reply
        .get("client_id")
        .and_then(Value::as_str)
        .ok_or("The sign-in server didn't give the app a client ID.")?;
    let secret = reply
        .get("client_secret")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((id.to_string(), secret))
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn pkce() -> Pkce {
    // Two v4 UUIDs: 64 characters from the OS random source, inside RFC 7636's alphabet and 43–128 length.
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    Pkce {
        verifier,
        challenge,
    }
}

pub struct Request<'a> {
    pub authorize: &'a str,
    pub client_id: &'a str,
    pub redirect: &'a str,
    pub challenge: &'a str,
    pub state: &'a str,
    pub scopes: &'a [String],
    pub resource: Option<&'a str>,
    /// Google: `access_type=offline&prompt=consent`, or no refresh token comes back.
    pub offline: bool,
}

pub fn authorize_url(request: &Request) -> Result<String, String> {
    let mut url = url::Url::parse(request.authorize)
        .map_err(|_| "The sign-in page address isn't valid.".to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", request.client_id)
            .append_pair("redirect_uri", request.redirect)
            .append_pair("code_challenge", request.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", request.state);
        if !request.scopes.is_empty() {
            query.append_pair("scope", &request.scopes.join(" "));
        }
        if let Some(resource) = request.resource {
            query.append_pair("resource", resource);
        }
        if request.offline {
            query
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
        }
    }
    Ok(url.to_string())
}

/// Wait for the browser to come back to the loopback address with `?code=…&state=…`.
pub fn wait_for_code(
    listeners: &[TcpListener],
    state: &str,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<String, String> {
    for listener in listeners {
        listener
            .set_nonblocking(true)
            .map_err(|_| "Couldn't listen for the sign-in.".to_string())?;
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return Err("The sign-in was cancelled.".into());
        }
        for listener in listeners {
            if let Ok((stream, _)) = listener.accept() {
                if let Some(result) = handle_callback(stream, state) {
                    return result;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("The sign-in wasn't finished in time. Try again.".into())
}

/// `None` for a request that isn't the callback (a favicon), so the wait goes on.
fn handle_callback(mut stream: TcpStream, state: &str) -> Option<Result<String, String>> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    let target = head.lines().next()?.split_whitespace().nth(1)?.to_string();
    let url = url::Url::parse(&format!("http://localhost{target}")).ok()?;
    if url.path() != "/callback" {
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return None;
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.to_string())
    };
    let result = if param("state").as_deref() != Some(state) {
        Err("The sign-in came back for a different request. Try again.".to_string())
    } else if let Some(error) = param("error") {
        Err(if error == "access_denied" {
            "The sign-in was cancelled.".to_string()
        } else {
            format!(
                "The provider said: {}",
                error.chars().take(80).collect::<String>()
            )
        })
    } else {
        param("code").ok_or_else(|| "The provider didn't send a code back.".to_string())
    };
    let page = if result.is_ok() {
        "You're signed in. You can close this tab and go back to MonoCode Hub."
    } else {
        "That sign-in didn't go through. Go back to MonoCode Hub to try again."
    };
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>MonoCode Hub</title><body style=\"font:15px -apple-system,sans-serif;padding:48px\">{page}</body>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    Some(result)
}

fn token_request(endpoint: &str, form: &[(&str, &str)]) -> Result<Value, String> {
    // A code, a refresh token or a client secret only ever goes over https (or to this Mac).
    secure(endpoint.to_string(), "tokens")?;
    match agent()
        .post(endpoint)
        .set("Accept", "application/json")
        .send_form(form)
    {
        Ok(response) => json_body(response)
            .ok_or_else(|| "The sign-in server's answer wasn't readable.".to_string()),
        Err(ureq::Error::Status(code, response)) => {
            let reason = json_body(response)
                .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            Err(format!(
                "The sign-in server refused the code ({code}{}).",
                if reason.is_empty() {
                    String::new()
                } else {
                    format!(", {reason}")
                }
            ))
        }
        Err(ureq::Error::Transport(_)) => Err(format!("Couldn't reach {}.", display_url(endpoint))),
    }
}

pub struct Client {
    pub token_endpoint: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub resource: Option<String>,
}

fn tokens_from(
    reply: &Value,
    client: &Client,
    previous_refresh: Option<String>,
) -> Result<OAuthTokens, String> {
    let access = reply
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("The sign-in server didn't send an access token.")?;
    Ok(OAuthTokens {
        access_token: access.to_string(),
        refresh_token: reply
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(previous_refresh),
        expires_at: reply
            .get("expires_in")
            .and_then(Value::as_u64)
            .map(|secs| now() + secs),
        token_endpoint: client.token_endpoint.clone(),
        client_id: client.client_id.clone(),
        client_secret: client.client_secret.clone(),
        resource: client.resource.clone(),
    })
}

pub fn exchange(
    client: &Client,
    code: &str,
    verifier: &str,
    redirect: &str,
) -> Result<OAuthTokens, String> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", client.client_id.as_str()),
        ("code_verifier", verifier),
    ];
    if let Some(secret) = client.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    if let Some(resource) = client.resource.as_deref() {
        form.push(("resource", resource));
    }
    let reply = token_request(&client.token_endpoint, &form)?;
    tokens_from(&reply, client, None)
}

/// Hivra Cloud's code exchange. Unlike [`exchange`], this does not follow a redirect and does not use an
/// environment proxy, so the authorization code cannot be sent on to another host. A reply with no `expires_in`
/// is already expired.
pub fn exchange_once(
    client: &Client,
    code: &str,
    verifier: &str,
    redirect: &str,
) -> Result<OAuthTokens, String> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", client.client_id.as_str()),
        ("code_verifier", verifier),
    ];
    if let Some(secret) = client.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    if let Some(resource) = client.resource.as_deref() {
        form.push(("resource", resource));
    }
    let reply = post_form_once(&client.token_endpoint, &form)?;
    let mut tokens = tokens_from(&reply, client, None)?;
    if reply.get("expires_in").and_then(Value::as_u64).is_none() {
        tokens.expires_at = Some(0);
    }
    Ok(tokens)
}

/// One POST. A 3xx is a refusal. Env proxies are off, so they cannot move the code.
fn post_form_once(endpoint: &str, form: &[(&str, &str)]) -> Result<Value, String> {
    secure(endpoint.to_string(), "tokens")?;
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .timeout(Duration::from_secs(30))
        .build();
    match agent
        .post(endpoint)
        .set("Accept", "application/json")
        .send_form(form)
    {
        Ok(response) if (200..300).contains(&response.status()) => json_body(response)
            .ok_or_else(|| "The sign-in server's answer wasn't readable.".to_string()),
        Ok(response) => Err(format!(
            "The sign-in server refused the code ({}).",
            response.status()
        )),
        Err(ureq::Error::Status(code, response)) => {
            let reason = json_body(response)
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            Err(format!(
                "The sign-in server refused the code ({code}{}).",
                if reason.is_empty() {
                    String::new()
                } else {
                    format!(", {reason}")
                }
            ))
        }
        Err(ureq::Error::Transport(_)) => Err(format!("Couldn't reach {}.", display_url(endpoint))),
    }
}

/// Swap the refresh token for a new access token. The old refresh token is kept when none comes back.
pub fn refresh(tokens: &OAuthTokens) -> Result<OAuthTokens, String> {
    let refresh = tokens
        .refresh_token
        .as_deref()
        .ok_or("The login expired and can't be renewed. Sign in again.")?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", tokens.client_id.as_str()),
    ];
    if let Some(secret) = tokens.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    if let Some(resource) = tokens.resource.as_deref() {
        form.push(("resource", resource));
    }
    let client = Client {
        token_endpoint: tokens.token_endpoint.clone(),
        client_id: tokens.client_id.clone(),
        client_secret: tokens.client_secret.clone(),
        resource: tokens.resource.clone(),
    };
    let reply = token_request(&tokens.token_endpoint, &form)?;
    tokens_from(&reply, &client, tokens.refresh_token.clone())
}

/// Expired, or within a minute of it.
pub fn expiring(tokens: &OAuthTokens) -> bool {
    tokens.expires_at.is_some_and(|at| at <= now() + 60)
}

/// The whole browser sign-in. `open` shows the provider's page (the user's browser); Ash does the rest there.
pub fn sign_in(
    mcp_url: &str,
    spec: &OAuthSpec,
    google: Option<(&GoogleClient, String, String)>,
    open: &dyn Fn(&str) -> Result<(), String>,
    cancel: &AtomicBool,
) -> Result<OAuthTokens, String> {
    let (listeners, redirect, client, endpoints, offline) = match spec.mode {
        OAuthMode::Mcp => {
            let listener = TcpListener::bind("127.0.0.1:0")
                .map_err(|_| "Couldn't listen for the sign-in.".to_string())?;
            let port = listener
                .local_addr()
                .map_err(|_| "Couldn't listen for the sign-in.".to_string())?
                .port();
            let redirect = format!("http://127.0.0.1:{port}/callback");
            let endpoints = discover(mcp_url)?;
            let register_at = endpoints.register.clone().ok_or(
                "This server needs a registered app, which MonoCode Hub can't make by itself.",
            )?;
            let (client_id, client_secret) = register(&register_at, &redirect)?;
            let client = Client {
                token_endpoint: endpoints.token.clone(),
                client_id,
                client_secret,
                resource: Some(mcp_url.to_string()),
            };
            let scopes = if spec.scopes.is_empty() {
                endpoints.scopes.clone()
            } else {
                spec.scopes.clone()
            };
            (
                vec![listener],
                redirect,
                client,
                Endpoints {
                    scopes,
                    ..endpoints
                },
                false,
            )
        }
        OAuthMode::Google => {
            let (config, client_id, client_secret) = google
                .ok_or("Add your Google OAuth client first (Settings > Connectors > Google).")?;
            let port = url::Url::parse(&config.redirect)
                .ok()
                .and_then(|u| u.port())
                .ok_or("The Google redirect address isn't valid.")?;
            let mut listeners = vec![TcpListener::bind(("127.0.0.1", port)).map_err(|_| {
                format!("Port {port} on this Mac is busy, so Google can't hand the sign-in back. Close what uses it and try again.")
            })?];
            // `localhost` may be tried over IPv6 first.
            if let Ok(v6) = TcpListener::bind(("::1", port)) {
                listeners.push(v6);
            }
            let client = Client {
                token_endpoint: config.token.clone(),
                client_id,
                client_secret: Some(client_secret),
                resource: None,
            };
            let endpoints = Endpoints {
                authorize: config.authorize.clone(),
                token: config.token.clone(),
                register: None,
                scopes: spec.scopes.clone(),
            };
            (listeners, config.redirect.clone(), client, endpoints, true)
        }
    };
    let pkce = pkce();
    let state = uuid::Uuid::new_v4().simple().to_string();
    let url = authorize_url(&Request {
        authorize: &endpoints.authorize,
        client_id: &client.client_id,
        redirect: &redirect,
        challenge: &pkce.challenge,
        state: &state,
        scopes: &endpoints.scopes,
        resource: client.resource.as_deref(),
        offline,
    })?;
    open(&url)?;
    let code = wait_for_code(&listeners, &state, SIGN_IN_TIMEOUT, cancel)?;
    exchange(&client, &code, &pkce.verifier, &redirect)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::bridge::tests::read_request;
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// A token endpoint that rotates refresh tokens the way strict providers do: each refresh token works once
    /// (`REFRESH_0` → `ACCESS_1`/`REFRESH_1` → …) and a reused one is refused with invalid_grant. Each answer comes after
    /// `delay`. Returns its URL and every refresh token it was sent, in order.
    pub(crate) fn rotating_token_endpoint(delay: Duration) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let valid = Arc::new(Mutex::new((String::from("REFRESH_0"), 0u32)));
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let (log, valid) = (Arc::clone(&log), Arc::clone(&valid));
                thread::spawn(move || {
                    let (_, body) = read_request(&mut stream);
                    let sent = body
                        .split('&')
                        .find_map(|pair| pair.strip_prefix("refresh_token="))
                        .unwrap_or("")
                        .to_string();
                    log.lock().unwrap().push(sent.clone());
                    thread::sleep(delay);
                    let mut valid = valid.lock().unwrap();
                    let (status, reply) = if sent == valid.0 {
                        valid.1 += 1;
                        let n = valid.1;
                        valid.0 = format!("REFRESH_{n}");
                        (
                            "200 OK",
                            serde_json::json!({"access_token": format!("ACCESS_{n}"), "refresh_token": format!("REFRESH_{n}"), "expires_in": 3600}),
                        )
                    } else {
                        (
                            "400 Bad Request",
                            serde_json::json!({"error": "invalid_grant"}),
                        )
                    };
                    let body = reply.to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                });
            }
        });
        (url, seen)
    }

    /// An OAuth login at `REFRESH_0` against `token_endpoint`, its access token `ACCESS_0` expiring at `expires_at`.
    pub(crate) fn rotating_login(
        token_endpoint: &str,
        expires_at: u64,
    ) -> super::super::secrets::Login {
        super::super::secrets::Login {
            fields: Default::default(),
            refs: Default::default(),
            oauth: Some(OAuthTokens {
                access_token: "ACCESS_0".into(),
                refresh_token: Some("REFRESH_0".into()),
                expires_at: Some(expires_at),
                token_endpoint: token_endpoint.into(),
                client_id: "client".into(),
                client_secret: None,
                resource: None,
            }),
        }
    }

    #[test]
    fn pkce_matches_rfc_7636() {
        let p = pkce();
        assert_eq!(p.verifier.len(), 64);
        assert!(p.verifier.bytes().all(|b| b.is_ascii_alphanumeric()));
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(p.verifier.as_bytes()));
        assert_eq!(p.challenge, expected);
        assert_ne!(pkce().verifier, p.verifier);
    }

    #[test]
    fn www_authenticate_parameters() {
        let (meta, scope) = parse_www_authenticate(
            r#"Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="read write""#,
        );
        assert_eq!(
            meta.as_deref(),
            Some("https://mcp.example.com/.well-known/oauth-protected-resource")
        );
        assert_eq!(scope.as_deref(), Some("read write"));
        assert_eq!(parse_www_authenticate("Bearer"), (None, None));
    }

    #[test]
    fn the_authorize_url_carries_pkce_resource_and_offline() {
        let url = authorize_url(&Request {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth",
            client_id: "cid",
            redirect: "http://localhost:47821/callback",
            challenge: "chal",
            state: "st",
            scopes: &["a".into(), "b".into()],
            resource: Some("https://mcp.example.com/mcp"),
            offline: true,
        })
        .unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["scope"], "a b");
        assert_eq!(q["resource"], "https://mcp.example.com/mcp");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["redirect_uri"], "http://localhost:47821/callback");
    }

    /// A fake authorization server and MCP server in one: 401 with resource metadata, PRM, AS metadata, DCR, token.
    fn fake_auth_server(seen: Arc<Mutex<Vec<String>>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let me = base.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let (head, body) = read_request(&mut stream);
                seen.lock().unwrap().push(format!("{head}\n{body}"));
                let line = head.lines().next().unwrap_or("").to_string();
                let json = |s: &mut TcpStream, v: Value| {
                    let b = v.to_string();
                    let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
                };
                if line.starts_with("POST /mcp") {
                    let _ = write!(stream, "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer resource_metadata=\"{me}/.well-known/oauth-protected-resource/mcp\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                } else if line.starts_with("GET /.well-known/oauth-protected-resource/mcp") {
                    json(
                        &mut stream,
                        serde_json::json!({"resource": format!("{me}/mcp"), "authorization_servers": [format!("{me}/")], "scopes_supported": ["mcp"]}),
                    );
                } else if line.starts_with("GET /.well-known/oauth-authorization-server") {
                    json(
                        &mut stream,
                        serde_json::json!({"issuer": me, "authorization_endpoint": format!("{me}/authorize"), "token_endpoint": format!("{me}/token"), "registration_endpoint": format!("{me}/register")}),
                    );
                } else if line.starts_with("POST /register") {
                    json(&mut stream, serde_json::json!({"client_id": "dyn-client"}));
                } else if line.starts_with("POST /token") {
                    if body.contains("grant_type=refresh_token") {
                        json(
                            &mut stream,
                            serde_json::json!({"access_token": "ACCESS_2", "expires_in": 3600}),
                        );
                    } else {
                        json(
                            &mut stream,
                            serde_json::json!({"access_token": "ACCESS_1", "refresh_token": "REFRESH_1", "expires_in": 3600}),
                        );
                    }
                } else {
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
            }
        });
        base
    }

    #[test]
    fn mcp_sign_in_discovers_registers_and_swaps_the_code_with_pkce() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let base = fake_auth_server(Arc::clone(&seen));
        let mcp_url = format!("{base}/mcp");
        let endpoints = discover(&mcp_url).unwrap();
        assert_eq!(endpoints.token, format!("{base}/token"));
        assert_eq!(endpoints.scopes, vec!["mcp"]);

        // The "browser": follows the authorize URL's redirect_uri back with a code, as the provider would after Ash
        // signs in. It never sees a password; neither does the app.
        let opened = Arc::new(Mutex::new(String::new()));
        let opened_by = Arc::clone(&opened);
        let browser = move |url: &str| -> Result<(), String> {
            *opened_by.lock().unwrap() = url.to_string();
            let parsed = url::Url::parse(url).unwrap();
            let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
            let back = format!("{}?code=THE_CODE&state={}", q["redirect_uri"], q["state"]);
            thread::spawn(move || {
                let _ = ureq::get(&back).call();
            });
            Ok(())
        };
        let spec = OAuthSpec {
            mode: OAuthMode::Mcp,
            scopes: vec![],
        };
        let tokens = sign_in(&mcp_url, &spec, None, &browser, &AtomicBool::new(false)).unwrap();
        assert_eq!(tokens.access_token, "ACCESS_1");
        assert_eq!(tokens.refresh_token.as_deref(), Some("REFRESH_1"));
        assert_eq!(tokens.client_id, "dyn-client");
        assert_eq!(tokens.resource.as_deref(), Some(mcp_url.as_str()));
        let opened = opened.lock().unwrap().clone();
        assert!(opened.starts_with(&format!("{base}/authorize?")));
        assert!(opened.contains("code_challenge_method=S256"));
        let log = seen.lock().unwrap().join("\n---\n");
        assert!(
            log.contains("code_verifier="),
            "PKCE verifier sent with the code"
        );
        assert!(log.contains("code=THE_CODE"));
        assert!(
            log.contains("resource="),
            "RFC 8707 resource on the token request"
        );

        let renewed = refresh(&tokens).unwrap();
        assert_eq!(renewed.access_token, "ACCESS_2");
        assert_eq!(
            renewed.refresh_token.as_deref(),
            Some("REFRESH_1"),
            "kept when none comes back"
        );
        assert!(!expiring(&renewed));
    }

    /// An MCP server on this Mac whose metadata names the authorization endpoints given (by `me`, its own address).
    fn server_naming(endpoints: impl Fn(&str) -> Value + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let me = base.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let (head, _) = read_request(&mut stream);
                let line = head.lines().next().unwrap_or("").to_string();
                let body = if line.starts_with("GET /.well-known/oauth-protected-resource") {
                    serde_json::json!({"resource": format!("{me}/mcp"), "authorization_servers": [format!("{me}/")]})
                } else if line.starts_with("GET /.well-known/oauth-authorization-server") {
                    endpoints(&me)
                } else {
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                };
                let b = body.to_string();
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
            }
        });
        format!("{base}/mcp")
    }

    /// A server's metadata can name any address: the code, the tokens and the refresh token go there. Only https (or
    /// plain http to this Mac) is taken.
    #[test]
    fn discovered_endpoints_must_be_https() {
        for (field, bad) in [
            ("token_endpoint", "http://attacker.example/token"),
            (
                "authorization_endpoint",
                "http://attacker.example/authorize",
            ),
            ("registration_endpoint", "http://attacker.example/register"),
            ("token_endpoint", "ftp://attacker.example/token"),
        ] {
            let mcp = server_naming(move |me| {
                let mut metadata = serde_json::json!({
                    "issuer": me,
                    "authorization_endpoint": format!("{me}/authorize"),
                    "token_endpoint": format!("{me}/token"),
                    "registration_endpoint": format!("{me}/register"),
                });
                metadata[field] = Value::from(bad);
                metadata
            });
            let err = discover(&mcp).unwrap_err();
            assert!(err.contains("https"), "{field} {bad}: {err}");
        }
        // Loopback http is fine (a server Ash runs himself, and these tests).
        let local = server_naming(|me| {
            serde_json::json!({"issuer": me, "authorization_endpoint": format!("{me}/authorize"),
                "token_endpoint": format!("{me}/token"), "registration_endpoint": format!("{me}/register")})
        });
        assert!(discover(&local).is_ok());
        // A login kept from before is never renewed over plain http either.
        let tokens = OAuthTokens {
            access_token: "A".into(),
            refresh_token: Some("REFRESH_SENTINEL".into()),
            expires_at: Some(1),
            token_endpoint: "http://attacker.example/token".into(),
            client_id: "c".into(),
            client_secret: None,
            resource: None,
        };
        let err = refresh(&tokens).unwrap_err();
        assert!(err.contains("https"), "{err}");
    }

    #[test]
    fn a_callback_with_the_wrong_state_is_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let _ = ureq::get(&format!("http://127.0.0.1:{port}/favicon.ico")).call();
            let _ = ureq::get(&format!(
                "http://127.0.0.1:{port}/callback?code=x&state=forged"
            ))
            .call();
        });
        let err = wait_for_code(
            &[listener],
            "expected",
            Duration::from_secs(10),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(err.contains("different request"), "{err}");
    }

    #[test]
    fn a_cancelled_sign_in_stops_waiting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let err = wait_for_code(
            &[listener],
            "s",
            Duration::from_secs(30),
            &AtomicBool::new(true),
        )
        .unwrap_err();
        assert!(err.contains("cancelled"), "{err}");
    }
}
