//! WP-129: the host a saved model key belongs to.
//!
//! A key saved under Other models may only be sent to the address it was saved with. The address is kept inside
//! the key's own Keychain item (`model_key_save` writes the item as the key with its provider and address), so the
//! only writer of the binding is that save, through the Keychain. Every command that reads a key by its id goes
//! through `bound_key`: the key is returned only when the route the webview gave has the stored provider and the
//! stored address. The address is compared after parsing, and the request URL is rebuilt from the parsed parts, so
//! a trailing dot, a different case, a default port, userinfo, a query or a look-alike host cannot point a key
//! somewhere else. An item with no binding (a plain key, or one saved with no usable address) is never sent.

use std::fs;
use std::path::Path;

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

/// Write one file under `root` by writing beside it and renaming, after proving the file's folder is `root`.
/// Used for the saved short-text route only (text_generation), never for a key's address.
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

/// Reads one Keychain item by its account, as the raw text. Production reads the model-key service; tests pass a map.
pub(crate) type ItemReader<'a> = &'a dyn Fn(&str) -> Result<Option<String>, String>;

/// The model-key item for one account: the key with the address it was saved with. Only `model_key_save` writes
/// it, through the Keychain, so the binding cannot be rewritten from a file. An item that is only a plain key
/// (saved with no usable address, or before this format) carries no binding and is never sent.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedItem {
    v: u8,
    provider: String,
    base_url: String,
    model_id: String,
    key: String,
}

const SEAL_VERSION: u8 = 1;
/// Longer than any sealed item we write; a longer value is not one.
const ITEM_MAX: usize = 8_192;

/// An opened item: the binding (provider, normalised address, model id, account) and the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Sealed {
    pub binding: CustomRoute,
    pub key: String,
}

/// The item to store for a key saved for `account`: the key sealed with `route`'s provider and address when that
/// route is usable for the account, otherwise the plain key (which is unbound and never sent).
pub(crate) fn item_for_save(key: &str, route: Option<&CustomRoute>, account: &str) -> String {
    route
        .filter(|route| route.custom_model_id == account)
        .and_then(|route| seal(route, key))
        .unwrap_or_else(|| key.to_string())
}

fn seal(route: &CustomRoute, key: &str) -> Option<String> {
    let url = normalize_base(&route.base_url)?;
    let clean = cleaned(route, &url);
    if !may_route(&clean) || !safe_account(&clean.custom_model_id) || key.trim().is_empty() {
        return None;
    }
    serde_json::to_string(&SealedItem {
        v: SEAL_VERSION,
        provider: clean.provider,
        base_url: clean.base_url,
        model_id: clean.model_id,
        key: key.trim().to_string(),
    })
    .ok()
}

/// An item's binding and key, or nothing when the item is not a sealed one or names an address that cannot route.
fn open(raw: &str, account: &str) -> Option<Sealed> {
    if raw.len() > ITEM_MAX || !raw.starts_with('{') || !safe_account(account) {
        return None;
    }
    let item: SealedItem = serde_json::from_str(raw).ok()?;
    if item.v != SEAL_VERSION || item.key.trim().is_empty() {
        return None;
    }
    let url = normalize_base(&item.base_url)?;
    let binding = CustomRoute {
        provider: item.provider,
        base_url: base_string(&url),
        model_id: item.model_id,
        custom_model_id: account.to_string(),
        reasoning_effort: None,
    };
    may_route(&binding).then_some(Sealed {
        binding,
        key: item.key,
    })
}

/// The opened item for `account`, or nothing. Keychain errors come back as errors.
pub(crate) fn read_sealed(read_item: ItemReader, account: &str) -> Result<Option<Sealed>, String> {
    if !safe_account(account) {
        return Ok(None);
    }
    Ok(read_item(account)?.and_then(|raw| open(&raw, account)))
}

/// The route and key to use for a model, or nothing. The key is returned only when the item for the route's
/// account was saved with the same provider and address (after parsing), and the route that comes back has its
/// address rebuilt from the parsed parts. Ollama has no key, so its route passes through with none.
pub(crate) fn bound_key(
    route: &CustomRoute,
    read_item: ItemReader,
) -> Result<Option<(CustomRoute, Option<String>)>, String> {
    if !may_route(route) {
        return Ok(None);
    }
    if route.provider == "ollama" {
        return Ok(Some((route.clone(), None)));
    }
    let Some(url) = normalize_base(&route.base_url) else {
        return Ok(None);
    };
    let Some(sealed) = read_sealed(read_item, &route.custom_model_id)? else {
        return Ok(None);
    };
    if sealed.binding.provider != route.provider
        || normalize_base(&sealed.binding.base_url) != Some(url.clone())
    {
        return Ok(None);
    }
    Ok(Some((
        CustomRoute {
            base_url: base_string(&url),
            ..route.clone()
        },
        Some(sealed.key),
    )))
}

/// The production reader: the model-key Keychain item for `account`.
pub(crate) fn keychain_item(account: &str) -> Result<Option<String>, String> {
    crate::model_router::read_key_in(crate::model_router::KEY_SERVICE, account)
}

/// Test helpers: a reader over a fixed set of items, and the item a save would write.
#[cfg(test)]
pub(crate) fn fake_keychain(
    items: Vec<(String, String)>,
) -> impl Fn(&str) -> Result<Option<String>, String> {
    move |account| {
        Ok(items
            .iter()
            .find(|(a, _)| a == account)
            .map(|(_, v)| v.clone()))
    }
}

#[cfg(test)]
pub(crate) fn sealed_item(route: &CustomRoute, key: &str) -> String {
    item_for_save(key, Some(route), &route.custom_model_id)
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

    /// The Keychain as one account sees it: `items` are (account, raw item text).
    fn keychain(items: &[(&str, String)]) -> impl Fn(&str) -> Result<Option<String>, String> {
        fake_keychain(
            items
                .iter()
                .map(|(a, v)| (a.to_string(), v.clone()))
                .collect(),
        )
    }

    fn bound(items: &[(&str, String)], given: &CustomRoute) -> Option<CustomRoute> {
        let read = keychain(items);
        bound_key(given, &read).unwrap().map(|(route, _)| route)
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
    fn a_claude_model_or_an_unusable_address_is_never_sealed() {
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
            assert!(
                seal(&given, "sk-key").is_none(),
                "{provider} {base} {model}"
            );
            // Saved with no usable address: the plain key, which is unbound.
            assert_eq!(item_for_save("sk-key", Some(&given), "acct-1"), "sk-key");
        }
        // Plain http is fine on this Mac.
        assert!(seal(&route("custom", "http://127.0.0.1:1234/v1", "local-1"), "k").is_some());
    }

    #[test]
    fn a_key_saved_again_takes_the_address_it_is_saved_with_or_none() {
        let first = route("custom", "https://llm.example/v1", "custom-1");
        let key_for = |raw: String| vec![("custom-1", raw)];
        assert!(bound(&key_for(sealed_item(&first, "sk-1")), &first).is_some());
        // Saved again with no usable address: the old address is not kept.
        let plain = item_for_save(
            "sk-2",
            Some(&route("custom", "ftp://llm.example", "custom-1")),
            "custom-1",
        );
        assert!(bound(&key_for(plain), &first).is_none());
        // Saved for a new address: the key follows it, and the old one is gone.
        let moved = route("custom", "https://other.example/v1", "custom-1");
        let items = key_for(sealed_item(&moved, "sk-3"));
        assert!(bound(&items, &first).is_none());
        assert!(bound(&items, &moved).is_some());
        // A route saved for another account is not this account's.
        assert_eq!(
            item_for_save(
                "sk-4",
                Some(&route("custom", "https://x.example/v1", "custom-2")),
                "custom-1"
            ),
            "sk-4"
        );
    }

    #[test]
    fn a_plain_or_damaged_item_is_never_a_binding() {
        let saved = route("custom", "https://llm.example/v1", "custom-1");
        // A key saved before this format, or with no address: no binding.
        assert!(bound(&[("custom-1", "sk-plain-0123456789".into())], &saved).is_none());
        for raw in [
            "{".to_string(),
            r#"{"v":2,"provider":"custom","baseUrl":"https://llm.example/v1","modelId":"m","key":"k"}"#.into(),
            r#"{"v":1,"provider":"custom","baseUrl":"https://llm.example/v1","modelId":"m","key":""}"#.into(),
            r#"{"v":1,"provider":"custom","baseUrl":"https://llm.example/v1","modelId":"claude-x","key":"k"}"#.into(),
            format!(r#"{{"v":1,"provider":"custom","baseUrl":"https://llm.example/v1","modelId":"m","key":"{}"}}"#, "x".repeat(9_000)),
        ] {
            assert!(bound(&[("custom-1", raw.clone())], &saved).is_none(), "{raw:.60}");
        }
        assert!(bound(&[], &saved).is_none());
    }

    #[test]
    fn a_planted_file_cannot_bind_a_key() {
        // The address lived in a file before; nothing reads files now, so a file with an address binds nothing.
        let saved = route("custom", "https://evil.example/v1", "custom-1");
        let planted = r#"{"provider":"custom","baseUrl":"https://evil.example/v1","modelId":"m","customModelId":"custom-1"}"#;
        assert!(bound(&[("custom-1", planted.into())], &saved).is_none());
    }

    #[test]
    fn a_key_is_bound_to_the_provider_and_address_it_was_saved_with() {
        let saved = route("custom", "https://llm.example/v1", "custom-1");
        let items = [("custom-1", sealed_item(&saved, "sk-0123456789"))];
        let ok = bound(
            &items,
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
            ("openrouter", "https://llm.example/v1", "custom-1"),
            ("custom", "https://llm.example/v1", "custom-2"),
            ("custom", "https://llm.example/v1", ""),
            ("custom", "https://llm.example/v1", "../custom-1"),
        ] {
            assert!(
                bound(&items, &route(provider, base, account)).is_none(),
                "{provider} {base} {account}"
            );
        }
        // No item at all: no key is used.
        assert!(bound(&[], &saved).is_none());
    }

    #[test]
    fn a_named_provider_keeps_the_address_it_was_saved_with() {
        // A person may point a provider at a proxy. The key then goes to that proxy and nowhere else.
        let proxied = route("xai", "https://proxy.example/xai/v1", "xai-1");
        let items = [("xai-1", sealed_item(&proxied, "xai-key-0123456789"))];
        assert!(bound(&items, &proxied).is_some());
        assert!(bound(&items, &route("xai", "https://api.x.ai/v1", "xai-1")).is_none());
        assert!(bound(&items, &route("xai", "https://api.x.ai/v1", "xai-2")).is_none());
    }

    #[test]
    fn ollama_has_no_key_and_passes_through() {
        let local = route("ollama", "http://localhost:11434", "");
        let read = keychain(&[]);
        assert_eq!(
            bound_key(&local, &read).unwrap(),
            Some((local.clone(), None))
        );
    }
}
