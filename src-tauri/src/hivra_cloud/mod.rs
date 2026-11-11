//! Hivra Cloud (WP-61): an optional managed machine. It is OFF by default. With the switch off, or no endpoint set,
//! nothing here opens a socket. Settings writes `<data>/hivra-cloud.json`
//! (`{"enabled": true, "endpoint": "https://..."}`). The default is off, with an empty address. The endpoint is a
//! placeholder until a service exists; it must be an address only (https, or http to this Mac).
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
/// The account-check notice was shown. Separate from the switch, so saving settings cannot turn Cloud on.
pub const NOTICE_FILE: &str = "hivra-cloud-notice.json";
/// Public client id for the desktop app. There is no client secret.
const CLIENT_ID: &str = "hivra-desktop";

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub endpoint: String,
    pub revision: u64,
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
    // A link is not a setting. Following one could turn Cloud on from somewhere else.
    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Config::default();
    }
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
    pub enabled: bool,
    pub endpoint: String,
    pub revision: u64,
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
        enabled: config.enabled,
        endpoint: config.endpoint.trim().to_string(),
        revision: config.revision,
        signed_in: signed_in && matches!(setup, Setup::Ready(_)),
        message,
    }
}

#[derive(Debug, PartialEq)]
pub enum SaveError {
    Invalid(String),
    Conflict(Config),
    Io(String),
}

impl SaveError {
    fn message(&self) -> String {
        match self {
            SaveError::Invalid(why) => why.clone(),
            SaveError::Conflict(_) => {
                "Hivra Cloud was changed somewhere else. Nothing was saved.".to_string()
            }
            SaveError::Io(why) => format!("Couldn't save Hivra Cloud. {why}"),
        }
    }
}

fn config_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn write_bytes(dir: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::io::Result::Ok(())
    })();
    if let Err(error) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(())
}

/// Writes the switch and address. A stale revision changes nothing. A bad address is not stored.
pub fn save_config(
    dir: &Path,
    expected_revision: u64,
    enabled: bool,
    endpoint: &str,
) -> Result<Config, SaveError> {
    let _guard = config_lock();
    let dir = crate::fs::canonical(dir).map_err(|error| SaveError::Io(error.to_string()))?;
    if !dir.is_dir() {
        return Err(SaveError::Io(
            "Hivra Cloud settings folder is missing.".into(),
        ));
    }
    let path = dir.join(CONFIG_FILE);
    if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(SaveError::Io("refusing to follow a link".into()));
    }
    let current = load_config(&path);
    if current.revision != expected_revision {
        return Err(SaveError::Conflict(current));
    }
    let trimmed = endpoint.trim();
    let endpoint = if trimmed.is_empty() {
        String::new()
    } else if let Err(why) = endpoint_url(trimmed) {
        if enabled {
            return Err(SaveError::Invalid(why));
        }
        let previous = current.endpoint.trim();
        if previous.is_empty() || endpoint_url(previous).is_ok() {
            previous.to_string()
        } else {
            String::new()
        }
    } else {
        trimmed.to_string()
    };
    let revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| SaveError::Io("Hivra Cloud settings can't be saved again.".into()))?;
    let next = Config {
        enabled,
        endpoint,
        revision,
    };
    let mut bytes =
        serde_json::to_vec_pretty(&next).map_err(|error| SaveError::Io(error.to_string()))?;
    bytes.push(b'\n');
    write_bytes(&dir, &path, &bytes).map_err(SaveError::Io)?;
    Ok(next)
}

/// True only for `{"shown": true}` in the notice file. Anything else, including a link, counts as not shown.
pub fn notice_was_shown(path: &Path) -> bool {
    if path.file_name().and_then(|name| name.to_str()) != Some(NOTICE_FILE) {
        return false;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > 4096 {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.get("shown").and_then(|flag| flag.as_bool()))
        .unwrap_or(false)
}

pub fn mark_notice_shown(path: &Path) -> Result<(), String> {
    if path.file_name().and_then(|name| name.to_str()) != Some(NOTICE_FILE) {
        return Err("refusing to write any other file".into());
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "missing folder".to_string())?;
    let parent = crate::fs::canonical(parent).map_err(|error| error.to_string())?;
    if !parent.is_dir() {
        return Err("not a folder".into());
    }
    let dest = parent.join(NOTICE_FILE);
    if std::fs::symlink_metadata(&dest).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("refusing to follow a link".into());
    }
    write_bytes(&parent, &dest, b"{\"shown\":true}\n")
}

/// Account view, with the shown flag kept in `notice_path` across runs. Never returns an error.
pub fn account_from(
    config: &Config,
    token: Option<String>,
    cache: &mut AccountCache,
    now: u64,
    notice_path: Option<&Path>,
) -> AccountView {
    let already = notice_path.is_some_and(notice_was_shown);
    if already {
        cache.suppress_notice();
    }
    let view = account_with(config, token, cache, now);
    if !already && cache.notice_is_shown() {
        if let Some(path) = notice_path {
            let _ = mark_notice_shown(path);
        }
    }
    view
}

fn drop_token_if_off(config: &Config) {
    if config.enabled {
        return;
    }
    let mut session = SESSION.lock().unwrap_or_else(|poison| poison.into_inner());
    *session = None;
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
    let notice = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(NOTICE_FILE));
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = ACCOUNT_CACHE
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        account_from(&config, token, &mut cache, oauth::now(), notice.as_deref())
    })
    .await
    .unwrap_or_else(|_| AccountView::without_account("unavailable"))
}

#[tauri::command]
pub fn hivra_cloud_save(
    app: AppHandle,
    enabled: bool,
    endpoint: String,
    expected_revision: u64,
) -> Result<Status, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Hivra Cloud can't find this Mac's data folder.".to_string())?;
    let config = save_config(&dir, expected_revision, enabled, &endpoint)
        .map_err(|error| error.message())?;
    drop_token_if_off(&config);
    Ok(status_for(&config, token_now().is_some()))
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
    use std::path::PathBuf;
    use std::thread;

    fn cfg(enabled: bool, endpoint: &str) -> Config {
        Config {
            enabled,
            endpoint: endpoint.into(),
            revision: 0,
        }
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivra-cloud-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_endpoint_is_only_an_address() {
        assert!(endpoint_url("https://cloud.example").is_ok());
        assert!(endpoint_url("HTTPS://Cloud.Example").is_ok());
        assert!(endpoint_url("http://127.0.0.1:9").is_ok());
        assert!(endpoint_url("HTTP://Cloud.Example").is_err());
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

    #[test]
    fn saving_the_switch_writes_the_file_and_opens_no_socket() {
        let silent = silent();
        let dir = scratch();
        let saved = save_config(&dir, 0, true, &format!("  {}  ", silent.base)).unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.endpoint, silent.base);
        assert_eq!(saved.revision, 1);
        assert_eq!(load_config(&dir.join(CONFIG_FILE)), saved);
        assert_eq!(
            silent.connections(),
            0,
            "saving does not contact the address"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(CONFIG_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "the settings file is private");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_address_is_saved_and_still_contacts_nothing() {
        let silent = silent();
        let dir = scratch();
        let saved = save_config(&dir, 0, true, " \n ").unwrap();
        assert_eq!(saved.endpoint, "");
        assert_eq!(setup(&saved), Setup::NoEndpoint);
        assert_eq!(silent.connections(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_address_is_not_stored_while_turning_on() {
        let dir = scratch();
        let error = save_config(&dir, 0, true, "http://cloud.example").unwrap_err();
        assert!(matches!(error, SaveError::Invalid(_)));
        assert!(!dir.join(CONFIG_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn turning_off_keeps_the_previous_good_address() {
        let dir = scratch();
        save_config(&dir, 0, true, "https://cloud.example").unwrap();
        let off = save_config(&dir, 1, false, "http://cloud.example/secret").unwrap();
        assert!(!off.enabled);
        assert_eq!(off.endpoint, "https://cloud.example");
        assert_eq!(off.revision, 2);
        assert_eq!(load_config(&dir.join(CONFIG_FILE)), off);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_revision_changes_nothing() {
        let dir = scratch();
        let first = save_config(&dir, 0, true, "https://cloud.example").unwrap();
        let error = save_config(&dir, 0, false, "").unwrap_err();
        match error {
            SaveError::Conflict(current) => assert_eq!(current, first),
            other => panic!("expected a conflict, got {other:?}"),
        }
        assert_eq!(load_config(&dir.join(CONFIG_FILE)), first);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_old_file_without_a_revision_stays_at_zero() {
        let dir = scratch();
        let path = dir.join(CONFIG_FILE);
        std::fs::write(
            &path,
            "{\r\n  \"enabled\": true,\r\n  \"endpoint\": \"https://cloud.example\"\r\n}\r\n",
        )
        .unwrap();
        assert_eq!(load_config(&path), cfg(true, "https://cloud.example"));
        let saved = save_config(&dir, 0, true, "https://cloud.example").unwrap();
        assert_eq!(saved.revision, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_with_spaces_and_the_parent_marker_still_saves_inside_it() {
        let dir = scratch().join("cloud tëst");
        std::fs::create_dir_all(&dir).unwrap();
        let via_parent = dir.join("nested").join("..");
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        let saved = save_config(&via_parent, 0, false, "").unwrap();
        assert_eq!(saved.revision, 1);
        assert!(dir.join(CONFIG_FILE).is_file());
        assert!(!dir.join("nested").join(CONFIG_FILE).exists());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn turning_the_switch_off_drops_the_in_memory_token() {
        let tokens = crate::connectors::secrets::OAuthTokens {
            access_token: "tok".into(),
            refresh_token: None,
            expires_at: None,
            token_endpoint: "https://cloud.example/oauth/token".into(),
            client_id: "hivra-desktop".into(),
            client_secret: None,
            resource: None,
        };
        {
            let mut session = super::SESSION
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *session = Some(tokens);
        }
        let dir = scratch();
        let saved = save_config(&dir, 0, false, "").unwrap();
        super::drop_token_if_off(&saved);
        assert!(super::SESSION
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_shown_flag_is_quiet_next_run_but_the_check_still_runs() {
        let stub = serve(vec![
            (500, String::new(), String::new()),
            (500, String::new(), String::new()),
        ]);
        let dir = scratch();
        let notice = dir.join(NOTICE_FILE);
        let config = cfg(true, &stub.base);
        let mut cache = AccountCache::new();
        let first = account_from(&config, Some("t".into()), &mut cache, 0, Some(&notice));
        assert_eq!(first.status, "unavailable");
        assert_eq!(
            first.notice.as_deref(),
            Some("Hivra Cloud can't be reached right now. Your own machines still work.")
        );
        assert!(notice_was_shown(&notice));
        let text = std::fs::read_to_string(&notice).unwrap();
        let as_config: Config = serde_json::from_str(&text).unwrap();
        assert!(!as_config.enabled, "the notice file cannot turn Cloud on");
        assert!(as_config.endpoint.is_empty());
        let mut again = AccountCache::new();
        let second = account_from(&config, Some("t".into()), &mut again, 10, Some(&notice));
        assert_eq!(second.status, "unavailable");
        assert_eq!(
            second.notice, None,
            "already shown, including after a restart"
        );
        assert_eq!(stub.seen.lock().unwrap().len(), 2, "the check still ran");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_notice_file_counts_as_not_shown() {
        let dir = scratch();
        let notice = dir.join(NOTICE_FILE);
        std::fs::write(&notice, "{\"shown\":\"true\"}").unwrap();
        assert!(!notice_was_shown(&notice));
        std::fs::write(&notice, "{ not json").unwrap();
        assert!(!notice_was_shown(&notice));
        assert!(!notice_was_shown(&dir.join("other.json")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_off_account_check_does_not_write_the_notice_or_connect() {
        let silent = silent();
        let dir = scratch();
        let notice = dir.join(NOTICE_FILE);
        let mut cache = AccountCache::new();
        let view = account_from(
            &cfg(false, &silent.base),
            Some("t".into()),
            &mut cache,
            0,
            Some(&notice),
        );
        assert_eq!(view.status, "off");
        assert!(!notice.exists());
        assert_eq!(silent.connections(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_settings_link_is_not_followed() {
        use std::os::unix::fs::symlink;
        let dir = scratch();
        let outside = scratch();
        let real = outside.join(CONFIG_FILE);
        std::fs::write(
            &real,
            "{\"enabled\":true,\"endpoint\":\"https://cloud.example\"}",
        )
        .unwrap();
        symlink(&real, dir.join(CONFIG_FILE)).unwrap();
        assert_eq!(load_config(&dir.join(CONFIG_FILE)), Config::default());
        let error = save_config(&dir, 0, false, "").unwrap_err();
        assert!(matches!(error, SaveError::Io(_)));
        assert!(std::fs::read_to_string(&real)
            .unwrap()
            .contains("https://cloud.example"));
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "do not touch").unwrap();
        symlink(&secret, dir.join(NOTICE_FILE)).unwrap();
        assert!(!notice_was_shown(&dir.join(NOTICE_FILE)));
        assert!(mark_notice_shown(&dir.join(NOTICE_FILE)).is_err());
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "do not touch");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    // Review of PR #240 (MED): the in-memory token is not bound to the address that issued it. Changing the address
    // while the switch stays on (Settings saves the address on blur) keeps the token, reports "signed in" for the new
    // address, and the next account check or pairing sends the old address's bearer token to the new one.
    #[test]
    fn review_a_token_from_one_address_is_never_sent_to_another() {
        let first = silent();
        let second = serve(vec![(200, String::new(), r#"{"plan":"pro"}"#.into())]);
        let dir = scratch();
        save_config(&dir, 0, true, &first.base).unwrap();
        {
            let mut session = super::SESSION
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *session = Some(crate::connectors::secrets::OAuthTokens {
                access_token: "token-issued-by-first".into(),
                refresh_token: None,
                expires_at: None,
                token_endpoint: format!("{}/oauth/token", first.base),
                client_id: "hivra-desktop".into(),
                client_secret: None,
                resource: None,
            });
        }
        // What hivra_cloud_save does when the address changes and the switch stays on.
        let saved = save_config(&dir, 1, true, &second.base).unwrap();
        super::drop_token_if_off(&saved);
        let status = status_for(&saved, super::token_now().is_some());
        let mut cache = AccountCache::new();
        let _ = account_with(&saved, super::token_now(), &mut cache, 0);
        let leaked = second.seen.lock().unwrap().iter().any(|request| {
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer")
        });
        {
            let mut session = super::SESSION
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *session = None;
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            !leaked,
            "the first address's bearer token was sent to the second address"
        );
        assert!(
            !status.signed_in,
            "a new address must not report signed in with the old address's token"
        );
    }

    #[cfg(windows)]
    #[test]
    fn saving_replaces_a_normal_file_on_windows() {
        let dir = scratch();
        let path = dir.join(CONFIG_FILE);
        std::fs::write(&path, "{}\n").unwrap();
        let saved = save_config(&dir, 0, true, "https://cloud.example").unwrap();
        assert_eq!(saved.endpoint, "https://cloud.example");
        assert_eq!(saved.revision, 1);
        assert!(path.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
