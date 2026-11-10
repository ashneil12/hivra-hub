//! WP-129: the host a saved model key belongs to.
//!
//! A key saved under Other models may only be sent to the address it was saved with. When the key is
//! saved, Rust stores the provider, model and address beside it: one small file per Keychain account, in
//! this copy's own data folder. Every command that reads a key by its id asks `bound_route` first, and the
//! key is read only when the route the webview gave has the stored provider and the stored address. The
//! address is compared after parsing, and the request URL is rebuilt from the parsed parts, so a trailing
//! dot, a different case, a default port, userinfo, a query or a look-alike host cannot point a key
//! somewhere else. A key with nothing stored is not used by those commands at all.
//!
//! The files are written only together with the key (`model_key_save`) and removed with it
//! (`model_key_delete`). The webview cannot write the folder.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model_router::{may_route, CustomRoute};

/// A base address after parsing: lowercase host, no trailing dot, no userinfo, no query or fragment,
/// and the default port left off. A request is built from these parts, never from the raw string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NormalUrl {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
    pub path: String,
}

pub(crate) fn normalize_base(raw: &str) -> Option<NormalUrl> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return None;
    }
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() || host.contains('@') || host.contains('/') || host.contains('\\') {
        return None;
    }
    let path = parsed.path().trim_end_matches('/').to_string();
    if path.split('/').any(|part| part == "." || part == "..") {
        return None;
    }
    Some(NormalUrl {
        scheme: parsed.scheme().to_string(),
        host,
        port: parsed.port(),
        path,
    })
}

pub(crate) fn host_for_url(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

pub(crate) fn base_string(url: &NormalUrl) -> String {
    let port = url.port.map(|port| format!(":{port}")).unwrap_or_default();
    format!(
        "{}://{}{}{}",
        url.scheme,
        host_for_url(&url.host),
        port,
        url.path
    )
}

/// A Keychain account that is also safe as a file name.
pub(crate) fn safe_account(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id.len() <= 120
        && !id.contains("..")
        && !id.contains('/')
        && !id.contains('\\')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredRoute {
    provider: String,
    base_url: String,
    model_id: String,
    custom_model_id: String,
}

/// The route with its address rebuilt from the parsed parts and its model id trimmed.
pub(crate) fn cleaned(route: &CustomRoute, url: &NormalUrl) -> CustomRoute {
    CustomRoute {
        provider: route.provider.clone(),
        base_url: base_string(url),
        model_id: route.model_id.trim().to_string(),
        custom_model_id: route.custom_model_id.clone(),
        reasoning_effort: None,
    }
}

/// A route as the bytes that are kept on disk.
pub(crate) fn to_json(route: &CustomRoute) -> Option<Vec<u8>> {
    serde_json::to_vec(&StoredRoute {
        provider: route.provider.clone(),
        base_url: route.base_url.clone(),
        model_id: route.model_id.clone(),
        custom_model_id: route.custom_model_id.clone(),
    })
    .ok()
}

/// A route read back from disk, or nothing when it is not a plain, usable one. Files are untrusted.
pub(crate) fn from_json(text: &str) -> Option<CustomRoute> {
    if text.len() > 4_096 {
        return None;
    }
    let stored: StoredRoute = serde_json::from_str(text).ok()?;
    if !matches!(
        stored.provider.as_str(),
        "xai" | "openrouter" | "deepseek" | "ollama" | "custom"
    ) {
        return None;
    }
    normalize_base(&stored.base_url)?;
    // Ollama has no key, so its route may have no account.
    let account_ok = safe_account(&stored.custom_model_id)
        || (stored.provider == "ollama" && stored.custom_model_id.is_empty());
    if !account_ok {
        return None;
    }
    Some(CustomRoute {
        provider: stored.provider,
        base_url: stored.base_url,
        model_id: stored.model_id,
        custom_model_id: stored.custom_model_id,
        reasoning_effort: None,
    })
}

/// This copy's folder of stored key hosts. Missing when there is no data folder yet.
pub fn store_dir() -> Option<PathBuf> {
    let id = crate::instance::current().identifier.clone();
    crate::instance::data_dir(&id).map(|dir| dir.join("model-key-hosts"))
}

/// Write one file under `root` by writing beside it and renaming, after proving the file's folder is `root`.
pub(crate) fn write_atomic(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), ()> {
    let root = crate::fs::canonical(root).map_err(|_| ())?;
    let parent = crate::fs::canonical(path.parent().ok_or(())?).map_err(|_| ())?;
    if !parent.starts_with(&root) {
        return Err(());
    }
    let name = path.file_name().and_then(|name| name.to_str()).ok_or(())?;
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(());
    }
    let path = parent.join(name);
    if path.parent() != Some(parent.as_path()) {
        return Err(());
    }
    let tmp = parent.join(format!("{name}.tmp"));
    fs::write(&tmp, bytes).map_err(|_| ())?;
    if fs::rename(&tmp, &path).is_err() {
        if path.starts_with(&root) {
            let _ = fs::remove_file(&path);
        }
        fs::rename(&tmp, &path).map_err(|_| ())?;
    }
    Ok(())
}

/// The file for one account, inside `dir`. The folder is made when it is missing.
fn account_file(dir: &Path, account: &str) -> Option<PathBuf> {
    if !safe_account(account) {
        return None;
    }
    fs::create_dir_all(dir).ok()?;
    let root = crate::fs::canonical(dir).ok()?;
    let path = root.join(account);
    if path.parent()? != root {
        return None;
    }
    Some(path)
}

/// What was stored when the key for `account` was saved.
pub fn read_one(dir: &Path, account: &str) -> Option<CustomRoute> {
    if !safe_account(account) {
        return None;
    }
    let text = fs::read_to_string(dir.join(account)).ok()?;
    let route = from_json(&text)?;
    (route.custom_model_id == account).then_some(route)
}

/// Remember the address that belongs to this key. Called only when the key itself is saved. The
/// address must be one a router would use at all (https, or http on this Mac), for a model that is not
/// Claude. A named provider's own host is not checked here: a person may point a provider at a proxy,
/// and the key still goes only to that address. A command that wants one fixed host checks it too.
pub fn record(dir: &Path, route: &CustomRoute) -> Result<(), ()> {
    let url = normalize_base(&route.base_url).ok_or(())?;
    let clean = cleaned(route, &url);
    if !may_route(&clean) {
        return Err(());
    }
    let path = account_file(dir, &clean.custom_model_id).ok_or(())?;
    let root = path.parent().ok_or(())?;
    write_atomic(root, &path, &to_json(&clean).ok_or(())?)
}

/// Drop the address stored for one key, and only that file.
pub fn remove(dir: &Path, account: &str) {
    if !safe_account(account) || !dir.is_dir() {
        return;
    }
    let Ok(root) = crate::fs::canonical(dir) else {
        return;
    };
    let path = root.join(account);
    if path.parent() != Some(root.as_path()) {
        return;
    }
    let _ = fs::remove_file(path);
}

/// A key was just saved for `account`. Store the address it was saved with, or drop what was stored for
/// the account before: a new key must not inherit the old key's host. With no usable address nothing is
/// stored, and the commands that read a key by its id will not send that key anywhere.
pub fn rebind(dir: &Path, account: &str, route: Option<&CustomRoute>) {
    if let Some(route) = route {
        if route.custom_model_id == account && record(dir, route).is_ok() {
            return;
        }
    }
    remove(dir, account);
}

/// The route to use for a stored key, or nothing. Ollama has no key, so its route is passed through.
/// Any other provider needs the provider and the address that were stored with the key, and the given
/// address must equal the stored one after parsing. The route that comes back has its address rebuilt
/// from the parsed parts, so that is the address to build the request from. `dir` is `None` when this
/// copy has no data folder, and then no key is used.
pub fn bound_route(dir: Option<&Path>, route: &CustomRoute) -> Option<CustomRoute> {
    if !may_route(route) {
        return None;
    }
    if route.provider == "ollama" {
        return Some(route.clone());
    }
    let url = normalize_base(&route.base_url)?;
    let bound = read_one(dir?, &route.custom_model_id)?;
    if bound.provider != route.provider || normalize_base(&bound.base_url)? != url {
        return None;
    }
    Some(CustomRoute {
        base_url: base_string(&url),
        ..route.clone()
    })
}

/// The plain sentence for a key whose host is not the one stored with it.
pub const NOT_STORED_FOR_THIS: &str =
    "That model's key isn't saved for this address. Save it again under Other models.";

/// Test helper: a server answers one request with a redirect to a second listener. Returns what the
/// call gave, the first server's request text in lower case, and whether the second listener got a
/// connection (it must not).
#[cfg(test)]
pub(crate) fn redirect_probe<R>(code: u16, call: impl FnOnce(&str) -> R) -> (R, String, bool) {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};
    let elsewhere = TcpListener::bind("127.0.0.1:0").unwrap();
    elsewhere.set_nonblocking(true).unwrap();
    let other = elsewhere.local_addr().unwrap().port();
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    upstream.set_nonblocking(true).unwrap();
    let port = upstream.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let started = Instant::now();
        let mut stream = loop {
            match upstream.accept() {
                Ok((stream, _)) => break stream,
                Err(_) if started.elapsed() < Duration::from_secs(10) => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return String::new(),
            }
        };
        stream.set_nonblocking(false).unwrap();
        // Read the whole request, body included, so closing the socket is not a reset.
        let mut seen = Vec::new();
        let mut buf = [0u8; 2048];
        loop {
            let text = String::from_utf8_lossy(&seen).to_ascii_lowercase();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if seen.len() >= end + 4 + length {
                    break;
                }
            }
            let n = stream.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            seen.extend_from_slice(&buf[..n]);
        }
        let reply = format!(
            "HTTP/1.1 {code} Moved\r\nLocation: http://127.0.0.1:{other}/stolen\r\n\
             Content-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.write_all(reply.as_bytes());
        String::from_utf8_lossy(&seen).to_ascii_lowercase()
    });
    let out = call(&format!("http://127.0.0.1:{port}"));
    let seen = server.join().unwrap();
    std::thread::sleep(Duration::from_millis(150));
    let followed = elsewhere.accept().is_ok();
    (out, seen, followed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(provider: &str, base: &str, account: &str) -> CustomRoute {
        CustomRoute {
            provider: provider.into(),
            base_url: base.into(),
            model_id: "m".into(),
            custom_model_id: account.into(),
            reasoning_effort: None,
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wp129-hosts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_address_is_compared_after_parsing() {
        let base = normalize_base("https://llm.example/v1").unwrap();
        for same in [
            "https://LLM.Example./v1/",
            "https://llm.example:443/v1",
            " https://llm.example/v1 ",
        ] {
            assert_eq!(normalize_base(same), Some(base.clone()), "{same}");
        }
        for different in [
            "https://llm.example:8443/v1",
            "http://llm.example/v1",
            "https://llm.example/v10",
            "https://llm.example/V1",
            "https://llm.example",
            "https://sub.llm.example/v1",
            // Dot segments are resolved by the parser, so this is the `/v2` address and nothing else.
            "https://llm.example/v1/../v2",
        ] {
            assert_ne!(normalize_base(different), Some(base.clone()), "{different}");
        }
        for refused in [
            "https://user@llm.example/v1",
            "https://user:pw@llm.example/v1",
            "https://llm.example@evil.example/v1",
            "https://llm.example/v1?x=1",
            "https://llm.example/v1#x",
            "ftp://llm.example/v1",
            "not a url",
            "",
        ] {
            assert_eq!(normalize_base(refused), None, "{refused}");
        }
        assert_eq!(
            base_string(&normalize_base("HTTP://[::1]:11434/").unwrap()),
            "http://[::1]:11434"
        );
    }

    #[test]
    fn a_claude_model_or_an_unusable_address_is_never_stored() {
        let dir = temp("never");
        for (provider, base, model) in [
            ("custom", "https://llm.example/v1", "claude-sonnet"),
            ("custom", "https://api.anthropic.com/v1", "m"),
            ("custom", "ftp://llm.example/v1", "m"),
            ("custom", "http://llm.example/v1", "m"),
            ("custom", "https://user@llm.example/v1", "m"),
            ("custom", "https://llm.example/v1?x=1", "m"),
            ("nobody", "https://llm.example/v1", "m"),
            ("custom", "https://llm.example/v1", " "),
        ] {
            let mut given = route(provider, base, "acct-1");
            given.model_id = model.into();
            assert!(record(&dir, &given).is_err(), "{provider} {base} {model}");
            assert!(!dir.join("acct-1").exists());
        }
        // Plain http is fine on this Mac.
        assert!(record(
            &dir,
            &route("custom", "http://127.0.0.1:1234/v1", "local-1")
        )
        .is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_a_key_again_replaces_or_drops_the_address_stored_with_it() {
        let dir = temp("rebind");
        let first = route("custom", "https://llm.example/v1", "custom-1");
        let bound = |given: &CustomRoute| bound_route(Some(&dir), given).is_some();
        rebind(&dir, "custom-1", Some(&first));
        assert!(bound(&first));
        // Saved again with an address that cannot be used: the old address is not kept.
        rebind(
            &dir,
            "custom-1",
            Some(&route("custom", "ftp://llm.example", "custom-1")),
        );
        assert!(!bound(&first));
        // Saved with no address at all: nothing is stored.
        rebind(&dir, "custom-1", Some(&first));
        rebind(&dir, "custom-1", None);
        assert!(!bound(&first));
        // Saved for a new address: the key follows it, and the old one is gone.
        let moved = route("custom", "https://other.example/v1", "custom-1");
        rebind(&dir, "custom-1", Some(&first));
        rebind(&dir, "custom-1", Some(&moved));
        assert!(!bound(&first) && bound(&moved));
        // An address for another account is not this account's.
        rebind(
            &dir,
            "custom-1",
            Some(&route("custom", "https://x.example/v1", "custom-2")),
        );
        assert!(!bound(&moved));
        assert!(!dir.join("custom-2").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_or_foreign_file_is_not_a_binding() {
        let dir = temp("damaged");
        let saved = route("custom", "https://llm.example/v1", "custom-1");
        record(&dir, &saved).unwrap();
        // The file is named for one account and holds another.
        fs::copy(dir.join("custom-1"), dir.join("custom-2")).unwrap();
        assert!(bound_route(
            Some(&dir),
            &route("custom", "https://llm.example/v1", "custom-2")
        )
        .is_none());
        fs::write(dir.join("custom-1"), "{").unwrap();
        assert!(bound_route(Some(&dir), &saved).is_none());
        fs::write(dir.join("custom-1"), "x".repeat(5_000)).unwrap();
        assert!(bound_route(Some(&dir), &saved).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_a_key_removes_only_its_own_file() {
        let dir = temp("remove");
        record(&dir, &route("custom", "https://llm.example/v1", "custom-1")).unwrap();
        record(&dir, &route("custom", "https://llm.example/v1", "custom-2")).unwrap();
        remove(&dir, "custom-1");
        remove(&dir, "../custom-2");
        remove(&dir, "..");
        assert!(!dir.join("custom-1").exists());
        assert!(dir.join("custom-2").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_key_is_bound_to_the_provider_and_address_it_was_saved_with() {
        let dir = temp("bound");
        let saved = route("custom", "https://llm.example/v1", "custom-1");
        record(&dir, &saved).unwrap();
        let ok = bound_route(
            Some(&dir),
            &route("custom", "https://LLM.Example./v1/", "custom-1"),
        );
        assert_eq!(ok.unwrap().base_url, "https://llm.example/v1");
        for (provider, base, account) in [
            ("custom", "https://evil.example/v1", "custom-1"),
            ("custom", "https://llm.example@evil.example/v1", "custom-1"),
            ("custom", "https://user@llm.example/v1", "custom-1"),
            ("custom", "https://llm.example.evil.example/v1", "custom-1"),
            ("custom", "https://llm.example:8443/v1", "custom-1"),
            ("custom", "https://llm.example/v1/extra", "custom-1"),
            ("custom", "https://llm.example/v1?x=1", "custom-1"),
            ("custom", "http://llm.example/v1", "custom-1"),
            // The same address under another provider, and under another account.
            ("openrouter", "https://llm.example/v1", "custom-1"),
            ("custom", "https://llm.example/v1", "custom-2"),
            ("custom", "https://llm.example/v1", ""),
            ("custom", "https://llm.example/v1", "../custom-1"),
        ] {
            assert!(
                bound_route(Some(&dir), &route(provider, base, account)).is_none(),
                "{provider} {base} {account}"
            );
        }
        // No data folder, nothing stored: no key is used.
        assert!(bound_route(None, &saved).is_none());
        assert!(bound_route(Some(&dir.join("missing")), &saved).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_named_provider_keeps_the_address_it_was_saved_with() {
        // A person may point a provider at a proxy. The key then goes to that proxy and nowhere else.
        let dir = temp("proxy");
        let proxied = route("xai", "https://proxy.example/xai/v1", "xai-1");
        record(&dir, &proxied).unwrap();
        assert!(bound_route(Some(&dir), &proxied).is_some());
        let official = route("xai", "https://api.x.ai/v1", "xai-1");
        assert!(bound_route(Some(&dir), &official).is_none());
        // A key with nothing stored is not used, whatever the address says.
        let unsaved = route("xai", "https://api.x.ai/v1", "xai-2");
        assert!(bound_route(Some(&dir), &unsaved).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ollama_has_no_key_and_passes_through() {
        let local = route("ollama", "http://localhost:11434", "");
        assert_eq!(bound_route(None, &local), Some(local.clone()));
    }
}
