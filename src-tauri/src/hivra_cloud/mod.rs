//! Hivra Cloud (WP-61): an optional managed machine. It is OFF by default. With the switch off, or no endpoint set,
//! nothing here opens a socket. Ash turns it on himself in `<data>/hivra-cloud.json`:
//! `{"enabled": true, "endpoint": "https://..."}`. The endpoint is a placeholder until a service exists; it must be an
//! address only (https, or http to this Mac).
//!
//! - Sign-in is a browser flow on a loopback address (PKCE S256, state checked, the connectors' flow). The access
//!   token lives in memory only: never the Keychain, a file or a log, and it is sent only to the configured endpoint.
//! - Pairing sends a one-time code, never a long-lived key. The machine it returns goes through the existing Add
//!   machine (SSH) path; this module adds nothing to the machine list itself.
//! - The account check is cached, fails soft and never blocks the app.
//! - `routines` holds the safety rules for work on the machine and the away feed (WP-60 stamps the runs it reads).

pub mod client;
// Not called by a command yet: the machine scheduler and WP-60's run records will call these. Tests cover them.
#[allow(dead_code)]
mod routines;

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;

use crate::connectors::oauth;
use crate::connectors::secrets::OAuthTokens;

pub use client::{AccountCache, AccountView, Client, CloudError, PairedMachine};

/// The file in the app's data folder that holds the switch and the endpoint.
pub const CONFIG_FILE: &str = "hivra-cloud.json";
/// Public client id for the desktop app. There is no client secret.
const CLIENT_ID: &str = "hivra-desktop";

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub endpoint: String,
}

#[derive(Debug, PartialEq)]
pub enum Setup {
    Off,
    NoEndpoint,
    BadEndpoint(String),
    Ready(Url),
}

impl Setup {
    pub fn state(&self) -> &'static str {
        match self {
            Setup::Off => "off",
            Setup::NoEndpoint => "no_endpoint",
            Setup::BadEndpoint(_) => "bad_endpoint",
            Setup::Ready(_) => "ready",
        }
    }
}

/// The endpoint must be only an address: https, or plain http to this Mac, with no path, query, fragment or login.
pub fn endpoint_url(raw: &str) -> Result<Url, String> {
    let url =
        Url::parse(raw).map_err(|_| "The Hivra Cloud address isn't a valid URL.".to_string())?;
    if !oauth::secure_or_loopback(raw) {
        return Err("The Hivra Cloud address must be https, or http to this Mac.".to_string());
    }
    let bare = (url.path().is_empty() || url.path() == "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    if !bare {
        return Err(
            "The Hivra Cloud address must be only an address, with no path, query or login."
                .to_string(),
        );
    }
    Ok(url)
}

pub fn setup(config: &Config) -> Setup {
    if !config.enabled {
        return Setup::Off;
    }
    let raw = config.endpoint.trim();
    if raw.is_empty() {
        return Setup::NoEndpoint;
    }
    match endpoint_url(raw) {
        Ok(url) => Setup::Ready(url),
        Err(why) => Setup::BadEndpoint(why),
    }
}

/// A missing or unreadable file means off. Nothing is switched on by a bad file.
pub fn load_config(path: &Path) -> Config {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Config>(&raw).ok())
        .unwrap_or_default()
}

/// The access token of this run. Memory only.
static SESSION: Mutex<Option<OAuthTokens>> = Mutex::new(None);
static ACCOUNT_CACHE: Mutex<AccountCache> = Mutex::new(AccountCache::new());

/// Browser sign-in against `endpoint`. `open` shows the authorize page; the callback is read on loopback.
pub fn sign_in_with(
    endpoint: &Url,
    open: &dyn Fn(&str) -> Result<(), String>,
    cancel: &AtomicBool,
) -> Result<OAuthTokens, String> {
    if !oauth::secure_or_loopback(endpoint.as_str()) {
        return Err("Hivra Cloud must be reached over https, or on this Mac.".to_string());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Couldn't listen for the sign-in.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Couldn't listen for the sign-in.".to_string())?
        .port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let authorize = endpoint
        .join("/oauth/authorize")
        .map_err(|_| "The Hivra Cloud address isn't valid.".to_string())?;
    let token = endpoint
        .join("/oauth/token")
        .map_err(|_| "The Hivra Cloud address isn't valid.".to_string())?;
    let pkce = oauth::pkce();
    let state = uuid::Uuid::new_v4().simple().to_string();
    let url = oauth::authorize_url(&oauth::Request {
        authorize: authorize.as_str(),
        client_id: CLIENT_ID,
        redirect: &redirect,
        challenge: &pkce.challenge,
        state: &state,
        scopes: &[],
        resource: None,
        offline: false,
    })?;
    open(&url)?;
    let code = oauth::wait_for_code(&[listener], &state, oauth::SIGN_IN_TIMEOUT, cancel)?;
    let client = oauth::Client {
        token_endpoint: token.to_string(),
        client_id: CLIENT_ID.to_string(),
        client_secret: None,
        resource: None,
    };
    oauth::exchange(&client, &code, &pkce.verifier, &redirect)
}

/// Account view for the app. Off or not set up means no network call at all.
pub fn account_with(
    config: &Config,
    token: Option<String>,
    cache: &mut AccountCache,
    now: u64,
) -> AccountView {
    let base = match setup(config) {
        Setup::Ready(url) => url,
        _ => return AccountView::without_account("off"),
    };
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        return AccountView::without_account("signed_out");
    };
    let client = match Client::new(base, Some(token)) {
        Ok(client) => client,
        Err(_) => return AccountView::without_account("signed_out"),
    };
    cache.view(now, &mut || client.account())
}

/// Pairs a machine with a one-time code from the Hivra Cloud page. Off or not set up means no network call.
pub fn pair_with(
    config: &Config,
    token: Option<String>,
    code: &str,
) -> Result<PairedMachine, CloudError> {
    let base = match setup(config) {
        Setup::Ready(url) => url,
        _ => return Err(CloudError::NotSetUp),
    };
    if !client::valid_pair_code(code) {
        return Err(CloudError::BadCode);
    }
    Client::new(base, token)?.pair(code)
}

/// The status the app reads at start-up. It never touches the network.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: &'static str,
    pub signed_in: bool,
    pub message: Option<String>,
}

pub fn status_for(config: &Config, signed_in: bool) -> Status {
    let setup = setup(config);
    let message = match &setup {
        Setup::BadEndpoint(why) => Some(why.clone()),
        _ => None,
    };
    Status {
        state: setup.state(),
        signed_in: signed_in && matches!(setup, Setup::Ready(_)),
        message,
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .map_err(|_| "Hivra Cloud can't find this Mac's data folder.".to_string())
}

fn current_config(app: &AppHandle) -> Config {
    config_path(app)
        .map(|path| load_config(&path))
        .unwrap_or_default()
}

/// The access token, unless it has expired. Never written anywhere.
fn token_now() -> Option<String> {
    let session = SESSION.lock().ok()?;
    let tokens = session.as_ref()?;
    if oauth::expiring(tokens) {
        return None;
    }
    Some(tokens.access_token.clone())
}

#[tauri::command]
pub fn hivra_cloud_status(app: AppHandle) -> Status {
    status_for(&current_config(&app), token_now().is_some())
}

#[tauri::command]
pub async fn hivra_cloud_sign_in(app: AppHandle) -> Result<Status, String> {
    let config = current_config(&app);
    let endpoint = match setup(&config) {
        Setup::Ready(url) => url,
        other => return Err(format!("Hivra Cloud is not set up ({}).", other.state())),
    };
    let tokens = tauri::async_runtime::spawn_blocking(move || {
        let opener = |url: &str| {
            open::that_detached(url).map_err(|_| "Couldn't open the browser.".to_string())
        };
        sign_in_with(&endpoint, &opener, &AtomicBool::new(false))
    })
    .await
    .map_err(|e| e.to_string())??;
    *SESSION
        .lock()
        .map_err(|_| "Hivra Cloud is busy.".to_string())? = Some(tokens);
    Ok(status_for(&config, true))
}

#[tauri::command]
pub fn hivra_cloud_sign_out(app: AppHandle) -> Status {
    if let Ok(mut session) = SESSION.lock() {
        *session = None;
    }
    status_for(&current_config(&app), false)
}

#[tauri::command]
pub async fn hivra_cloud_account(app: AppHandle) -> AccountView {
    let config = current_config(&app);
    let token = token_now();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = ACCOUNT_CACHE
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        account_with(&config, token, &mut cache, oauth::now())
    })
    .await
    .unwrap_or_else(|_| AccountView::without_account("unavailable"))
}

#[tauri::command]
pub async fn hivra_cloud_pair(app: AppHandle, code: String) -> Result<PairedMachine, String> {
    let config = current_config(&app);
    let token = token_now();
    tauri::async_runtime::spawn_blocking(move || pair_with(&config, token, &code))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|error| error.message())
}

#[cfg(test)]
mod tests {
    use super::client::stub::{serve, silent};
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::thread;

    fn cfg(enabled: bool, endpoint: &str) -> Config {
        Config {
            enabled,
            endpoint: endpoint.into(),
        }
    }

    #[test]
    fn the_endpoint_is_only_an_address() {
        assert!(endpoint_url("https://cloud.example").is_ok());
        assert!(endpoint_url("http://127.0.0.1:9").is_ok());
        assert!(
            endpoint_url("http://cloud.example").is_err(),
            "plain http off this Mac"
        );
        assert!(endpoint_url("https://cloud.example/path").is_err());
        assert!(endpoint_url("https://cloud.example/?token=1").is_err());
        assert!(endpoint_url("https://user:pw@cloud.example").is_err());
        assert!(endpoint_url("").is_err());
    }

    #[test]
    fn off_is_the_default_and_an_empty_endpoint_does_nothing() {
        assert_eq!(setup(&Config::default()), Setup::Off);
        assert_eq!(setup(&cfg(true, "")), Setup::NoEndpoint);
        assert_eq!(setup(&cfg(true, "  ")), Setup::NoEndpoint);
        assert!(matches!(
            setup(&cfg(true, "http://cloud.example")),
            Setup::BadEndpoint(_)
        ));
        assert!(matches!(
            setup(&cfg(true, "https://cloud.example")),
            Setup::Ready(_)
        ));
        assert!(matches!(
            setup(&cfg(false, "https://cloud.example")),
            Setup::Off
        ));
    }

    #[test]
    fn a_missing_or_broken_config_file_leaves_it_off() {
        let dir = std::env::temp_dir().join(format!("hivra-cloud-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CONFIG_FILE);
        assert_eq!(load_config(&path), Config::default(), "missing file");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load_config(&path), Config::default(), "broken file");
        std::fs::write(
            &path,
            r#"{"enabled":true,"endpoint":"https://cloud.example"}"#,
        )
        .unwrap();
        assert_eq!(load_config(&path), cfg(true, "https://cloud.example"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn with_the_switch_off_account_and_pairing_never_connect() {
        let silent = silent();
        let off = cfg(false, &silent.base);
        let mut cache = AccountCache::new();
        let view = account_with(&off, Some("t".into()), &mut cache, 0);
        assert_eq!(view.status, "off");
        assert_eq!(view.notice, None);
        assert_eq!(
            pair_with(&off, Some("t".into()), "ABCD-1234"),
            Err(CloudError::NotSetUp)
        );
        let empty = cfg(true, "");
        assert_eq!(
            account_with(&empty, Some("t".into()), &mut cache, 0).status,
            "off"
        );
        assert_eq!(silent.connections(), 0, "no socket was opened");
    }

    #[test]
    fn signed_out_is_reported_without_a_request() {
        let silent = silent();
        let on = cfg(true, &silent.base);
        let mut cache = AccountCache::new();
        assert_eq!(account_with(&on, None, &mut cache, 0).status, "signed_out");
        assert_eq!(silent.connections(), 0);
    }

    #[test]
    fn the_status_says_what_is_set_up_and_never_asks_the_network() {
        let status = status_for(&Config::default(), false);
        assert_eq!(status.state, "off");
        assert!(!status.signed_in);
        assert_eq!(
            status_for(&cfg(true, "https://cloud.example"), true).state,
            "ready"
        );
        assert_eq!(status_for(&cfg(true, ""), false).state, "no_endpoint");
    }

    #[test]
    fn sign_in_gets_a_token_from_the_loopback_stub_with_pkce_and_state() {
        let stub = serve(vec![(
            200,
            String::new(),
            r#"{"access_token":"tok-123","expires_in":3600}"#.into(),
        )]);
        let endpoint = Url::parse(&stub.base).unwrap();
        let cancel = AtomicBool::new(false);
        let open = |url: &str| -> Result<(), String> {
            let authorize = Url::parse(url).unwrap();
            assert_eq!(
                authorize.origin(),
                endpoint.origin(),
                "the sign-in page is on the endpoint"
            );
            let query: std::collections::HashMap<String, String> =
                authorize.query_pairs().into_owned().collect();
            assert_eq!(query["code_challenge_method"], "S256");
            assert!(!query["code_challenge"].is_empty());
            let redirect = Url::parse(&query["redirect_uri"]).unwrap();
            let target = format!("{}?code=code-1&state={}", redirect.path(), query["state"]);
            let port = redirect.port().unwrap();
            thread::spawn(move || {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                let _ = write!(stream, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
                let mut sink = Vec::new();
                let _ = stream.read_to_end(&mut sink);
            });
            Ok(())
        };
        let tokens = sign_in_with(&endpoint, &open, &cancel).unwrap();
        assert_eq!(tokens.access_token, "tok-123");
        let seen = stub.seen.lock().unwrap();
        assert!(seen[0].starts_with("POST /oauth/token "), "{}", seen[0]);
        assert!(seen[0].contains("code=code-1"));
        assert!(seen[0].contains("code_verifier="));
        assert!(
            !seen[0].contains("client_secret"),
            "a public client sends no secret"
        );
    }

    #[test]
    fn sign_in_refuses_a_callback_for_another_request() {
        let stub = serve(vec![]);
        let endpoint = Url::parse(&stub.base).unwrap();
        let cancel = AtomicBool::new(false);
        let open = |url: &str| -> Result<(), String> {
            let query: std::collections::HashMap<String, String> = Url::parse(url)
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
            let redirect = Url::parse(&query["redirect_uri"]).unwrap();
            let port = redirect.port().unwrap();
            let path = redirect.path().to_string();
            thread::spawn(move || {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                let _ = write!(
                    stream,
                    "GET {path}?code=code-1&state=someone-else HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
                );
                let mut sink = Vec::new();
                let _ = stream.read_to_end(&mut sink);
            });
            Ok(())
        };
        assert!(sign_in_with(&endpoint, &open, &cancel).is_err());
        assert!(
            stub.seen.lock().unwrap().is_empty(),
            "no code was exchanged"
        );
    }
}
