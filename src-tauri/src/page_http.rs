//! A page's only way out to the web (C4). The page's own document keeps `connect-src 'none'`, so the request is made
//! here, by the app, on the bridge's word — and the bridge only speaks for a source Ash connected to that page.
//!
//! Three walls stand between a page and a host nobody allowed. The address must be https and covered by a grant the page
//! holds — an origin, and the path under it (the renderer checks its own list first; the same grants are handed here and
//! checked again, so a skipped check in the webview doesn't open a door). Every hop, redirects included, stays inside the
//! grant that authorised the first request and passes the public-address checks a link preview gets, so a page can't be
//! steered at this Mac, the local network, or another path on a host it was connected to. And the source's token, if it
//! has one, is read from the Keychain here and put on the request by the app: it never goes through the page and never
//! comes back.
//!
//! The page gets the status, the content type and the body as text, whatever the status: a 404 is the source's answer,
//! not a failure, so the page can show it. The body stays data — it arrives as a string the page may parse, never as
//! anything the app runs.

use std::io::Read;
use std::time::Duration;

use serde::Serialize;
use url::Url;

use crate::hub_keychain;
use crate::link_preview::validate_public_target;

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 5;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_REQUEST_BODY: usize = 200_000;
const MAX_URL: usize = 8192;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; MonoCode-Page/1.0)";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageHttpReply {
    status: u16,
    #[serde(rename = "type")]
    content_type: String,
    body: String,
    url: String,
}

/// One request for a page. The address must be covered by one of `grants`, the page's connected sources (origin and
/// the path under it), and every hop must stay inside that grant and be public.
#[tauri::command]
pub async fn page_http_fetch(
    page_id: String,
    url: String,
    grants: Vec<String>,
    method: String,
    body: Option<String>,
    accept: Option<String>,
    content_type: Option<String>,
) -> Result<PageHttpReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_for_page(
            &page_id,
            &url,
            &grants,
            &method,
            body.as_deref(),
            accept.as_deref(),
            content_type.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Keep a source's token for one page and one origin. It is only ever read back here, to put on a request.
#[tauri::command]
pub async fn page_source_token_set(
    page_id: String,
    origin: String,
    token: String,
) -> Result<(), String> {
    let (service, origin) = token_key(&page_id, &origin)?;
    hub_keychain::store(&service, &origin, token.trim())
}

#[tauri::command]
pub async fn page_source_token_exists(page_id: String, origin: String) -> Result<bool, String> {
    let (service, origin) = token_key(&page_id, &origin)?;
    hub_keychain::exists(&service, &origin)
}

/// Remove a source's token; false when there wasn't one.
#[tauri::command]
pub async fn page_source_token_clear(page_id: String, origin: String) -> Result<bool, String> {
    let (service, origin) = token_key(&page_id, &origin)?;
    hub_keychain::delete(&service, &origin)
}

fn token_service(page_id: &str) -> String {
    format!("monocode-hub:page-source:{page_id}")
}

/// A page's token is named for the page and the source's origin, both checked here so neither can name anything else.
fn token_key(page_id: &str, origin: &str) -> Result<(String, String), String> {
    check_page_id(page_id)?;
    let url = parse_origin(origin)?;
    Ok((token_service(page_id), url.origin().ascii_serialization()))
}

/// Page keys are the ones page_frames.rs already uses for its served documents (letters, digits, `-` and `.`).
fn check_page_id(page_id: &str) -> Result<(), String> {
    let plain = !page_id.is_empty()
        && page_id.len() <= 64
        && page_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if plain {
        Ok(())
    } else {
        Err("That isn't a page.".into())
    }
}

/// `https://host[:port]` and nothing more: what a grant is an origin of.
fn parse_origin(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim())
        .map_err(|_| "That isn't a source address. It should start with https://".to_string())?;
    if url.scheme() != "https"
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.path() != "/" && !url.path().is_empty())
    {
        return Err("That isn't a source address. It should start with https://".into());
    }
    Ok(url)
}

/// One thing a page may read: an origin, and the path under it (`/v1`; the root covers the whole origin). The renderer
/// keeps the same rule (pageGrants.ts's `covers`) and checks it before asking; this is the check that stands when it
/// doesn't, and the one every redirect is measured against.
#[derive(Clone, Debug)]
struct Grant {
    origin: String,
    /// The granted path with its trailing slashes dropped, or `/` for the whole origin.
    base: String,
}

impl Grant {
    fn parse(raw: &str) -> Option<Grant> {
        let url = Url::parse(raw.trim()).ok()?;
        if url.scheme() != "https"
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return None;
        }
        let base = url.path().trim_end_matches('/');
        Some(Grant {
            origin: url.origin().ascii_serialization(),
            base: if base.is_empty() {
                "/".to_string()
            } else {
                base.to_string()
            },
        })
    }

    /// Same origin, and the address is the granted path or under it.
    fn covers(&self, url: &Url) -> bool {
        if url.origin().ascii_serialization() != self.origin {
            return false;
        }
        self.base == "/"
            || url.path() == self.base
            || url.path().starts_with(&format!("{}/", self.base))
    }
}

fn fetch_for_page(
    page_id: &str,
    raw: &str,
    grants: &[String],
    method: &str,
    body: Option<&str>,
    accept: Option<&str>,
    content_type: Option<&str>,
) -> Result<PageHttpReply, String> {
    check_page_id(page_id)?;
    let method = method.trim().to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return Err(format!("A page can't send a “{method}” request."));
    }
    if body.is_some() && !carries_body(&method) {
        return Err(format!("A {method} request can't have a body."));
    }
    if body.is_some_and(|text| text.len() > MAX_REQUEST_BODY) {
        return Err("That request's body is too long for a page.".into());
    }

    let (mut url, grant) = parse_target(raw, grants)?;
    let origin = url.origin().ascii_serialization();
    let token = hub_keychain::read(&token_service(page_id), &origin)?;

    let agent = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .redirects(0)
        .build();
    let mut method = method;
    let mut body = body.map(str::to_string);

    for _ in 0..=MAX_REDIRECTS {
        validate_public_target(&url).map_err(|_| unreachable_target())?;
        let mut request = agent.request(&method, url.as_str());
        if let Some(accept) = accept {
            request = request.set("Accept", accept);
        }
        if let Some(content_type) = content_type {
            request = request.set("Content-Type", content_type);
        }
        if let Some(token) = token.as_deref() {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        request = request.set("User-Agent", USER_AGENT);

        let response = match body.as_deref() {
            Some(text) if carries_body(&method) => request.send_string(text),
            _ => request.call(),
        };
        let response = match response {
            Ok(response) => response,
            // A 4xx or 5xx is the source's answer, not the app's failure: the page sees the status and the body.
            Err(ureq::Error::Status(_status, response)) if !is_redirect(response.status()) => {
                return reply_from(response, &url, method == "HEAD");
            }
            Err(ureq::Error::Status(_, response)) => response,
            Err(_) => return Err("The source didn't answer. Nothing was read.".into()),
        };

        if is_redirect(response.status()) {
            let location = response.header("Location").ok_or_else(|| {
                "The source's redirect has no destination, so nothing was read.".to_string()
            })?;
            // Only where the grant that authorised the first request still covers it: letting a redirect leave that
            // grant would hand the page a fetch nobody connected, with the source's token on it.
            let next = redirect_target(&url, location, &grant)?;
            if response.status() == 303 {
                method = "GET".to_string();
                body = None;
            }
            url = next;
            continue;
        }

        return reply_from(response, &url, method == "HEAD");
    }

    Err("The source redirected too many times, so nothing was read.".into())
}

/// The address and the grant that covers it, if one does: https, inside a source this page was connected to (origin
/// and path), and public. Refusals are in the page's own words: the page shows them as they are.
fn parse_target(raw: &str, grants: &[String]) -> Result<(Url, Grant), String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_URL {
        return Err("That isn't a web address. It should start with https://".into());
    }
    let url = Url::parse(value)
        .map_err(|_| "That isn't a web address. It should start with https://".to_string())?;
    if url.scheme() != "https" || url.host().is_none() {
        return Err("A page can only read https:// addresses, so the data can't be read or changed on the way.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the name and password out of the address.".into());
    }
    let grant = grants
        .iter()
        .filter_map(|raw| Grant::parse(raw))
        .find(|grant| grant.covers(&url))
        .ok_or_else(|| {
            format!(
                "This page isn't connected to {}, so it can't read it.",
                url.host_str().unwrap_or("that address")
            )
        })?;
    validate_public_target(&url).map_err(|_| unreachable_target())?;
    Ok((url, grant))
}

/// Where a redirect points, if the grant that authorised the first request still covers it. Another host, or another
/// path on this host, is a fetch nobody connected, so it is refused with the plain reason the page shows.
fn redirect_target(current: &Url, location: &str, grant: &Grant) -> Result<Url, String> {
    let next = current
        .join(location)
        .map_err(|_| "The source's redirect is invalid, so nothing was read.".to_string())?;
    if !grant.covers(&next) {
        let host = next.host_str().unwrap_or("another address");
        return Err(if next.origin().ascii_serialization() != grant.origin {
            format!("The source sent the page to {host}, which it isn't connected to, so nothing was read.")
        } else {
            format!(
                "The source sent the page to a different path on {host}, which the page isn't connected to, so nothing was read."
            )
        });
    }
    Ok(next)
}

fn unreachable_target() -> String {
    "That address is on this Mac or your local network. A page can only read a public web address."
        .into()
}

fn carries_body(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn reply_from(
    response: ureq::Response,
    final_url: &Url,
    head: bool,
) -> Result<PageHttpReply, String> {
    let status = response.status();
    let content_type = response.header("Content-Type").unwrap_or("").to_string();
    if head {
        return Ok(PageHttpReply {
            status,
            content_type,
            body: String::new(),
            url: final_url.as_str().to_string(),
        });
    }
    if response
        .header("Content-Length")
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_BYTES)
    {
        return Err("The source answered with more than a page can hold (1 MB).".into());
    }
    let mut reader = response.into_reader().take(MAX_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| "The source's answer couldn't be read.".to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("The source answered with more than a page can hold (1 MB).".into());
    }
    Ok(PageHttpReply {
        status,
        content_type,
        body: String::from_utf8_lossy(&bytes).into_owned(),
        url: final_url.as_str().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(url: &str) -> String {
        Url::parse(url).unwrap().origin().ascii_serialization()
    }

    #[test]
    fn a_page_key_is_plain() {
        assert!(check_page_id("page-abc123").is_ok());
        assert!(check_page_id("a.b_c-D").is_ok());
        assert!(check_page_id("").is_err());
        assert!(check_page_id("../etc").is_err());
        assert!(check_page_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn only_https_sources_are_reachable() {
        let granted = vec![origin("https://93.184.216.34")];
        assert!(parse_target("https://93.184.216.34/x", &granted).is_ok());
        assert!(parse_target("http://93.184.216.34/x", &granted).is_err());
        assert!(parse_target("file:///etc/passwd", &granted).is_err());
        assert!(parse_target("not a url", &granted).is_err());
        assert!(parse_target(
            &format!("https://93.184.216.34/{}", "a".repeat(MAX_URL)),
            &granted
        )
        .is_err());
    }

    #[test]
    fn an_ungranted_host_is_refused_by_name() {
        let granted = vec![origin("https://93.184.216.34")];
        let why = parse_target("https://93.184.216.35/x", &granted).unwrap_err();
        assert!(why.contains("93.184.216.35"), "{why}");
        let why = parse_target("https://93.184.216.34/x", &[]).unwrap_err();
        assert!(why.contains("isn't connected"), "{why}");
    }

    #[test]
    fn this_mac_and_the_local_network_are_never_public() {
        for raw in [
            "https://127.0.0.1/x",
            "https://10.1.2.3/x",
            "https://192.168.0.10/x",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/x",
        ] {
            let granted = vec![origin(raw)];
            let why = parse_target(raw, &granted).unwrap_err();
            assert!(why.contains("local network"), "{raw}: {why}");
        }
    }

    #[test]
    fn an_address_with_a_name_and_password_is_refused() {
        let raw = "https://me:secret@93.184.216.34/x";
        let granted = vec![origin("https://93.184.216.34")];
        assert!(parse_target(raw, &granted).is_err());
    }

    #[test]
    fn only_simple_requests_are_sent() {
        let granted = vec![origin("https://93.184.216.34")];
        assert!(fetch_for_page(
            "page-a",
            "https://93.184.216.34/x",
            &granted,
            "TRACE",
            None,
            None,
            None
        )
        .is_err());
        let why = fetch_for_page(
            "page-a",
            "https://93.184.216.34/x",
            &granted,
            "GET",
            Some("{}"),
            None,
            None,
        )
        .unwrap_err();
        assert!(why.contains("can't have a body"), "{why}");
        let why = fetch_for_page(
            "page-a",
            "https://93.184.216.34/x",
            &granted,
            "POST",
            Some(&"a".repeat(MAX_REQUEST_BODY + 1)),
            None,
            None,
        )
        .unwrap_err();
        assert!(why.contains("too long"), "{why}");
    }

    #[test]
    fn a_token_is_named_for_the_page_and_its_origin() {
        assert_eq!(token_service("page-a"), "monocode-hub:page-source:page-a");
        let (service, account) = token_key("page-a", "https://api.example.com").unwrap();
        assert_eq!(service, "monocode-hub:page-source:page-a");
        assert_eq!(account, "https://api.example.com");
        assert!(token_key("page-a", "http://api.example.com").is_err());
        // A token is named for an origin; a grant's path never names one.
        assert!(token_key("page-a", "https://api.example.com/v1").is_err());
        assert!(token_key("../x", "https://api.example.com").is_err());
        assert!(token_key("page-a", "https://api.example.com/v1?q=1").is_err());
    }

    #[test]
    fn a_grant_covers_its_path_and_nothing_beside_it() {
        let granted = vec!["https://93.184.216.34/v1".to_string()];
        let (url, grant) = parse_target("https://93.184.216.34/v1/players", &granted).unwrap();
        assert_eq!(url.as_str(), "https://93.184.216.34/v1/players");
        assert_eq!(grant.base, "/v1");
        // The same host outside the granted path is a fetch nobody connected.
        assert!(parse_target("https://93.184.216.34/admin", &granted).is_err());
        assert!(parse_target("https://93.184.216.34/v10", &granted).is_err());
        assert!(parse_target("https://93.184.216.34", &granted).is_err());
        // A bare origin covers every path on it.
        let whole = vec!["https://93.184.216.34".to_string()];
        assert!(parse_target("https://93.184.216.34/anything/at/all", &whole).is_ok());
        // A grant that doesn't parse grants nothing.
        assert!(parse_target("https://93.184.216.34/v1", &["not a url".to_string()]).is_err());
    }

    #[test]
    fn a_redirect_is_only_followed_where_the_original_grant_still_covers_it() {
        let granted = vec!["https://93.184.216.34/v1".to_string()];
        let (start, grant) = parse_target("https://93.184.216.34/v1/players", &granted).unwrap();

        // Under the granted path it is a second address on the source that was allowed.
        let hop = redirect_target(&start, "/v1/other", &grant).unwrap();
        assert_eq!(hop.as_str(), "https://93.184.216.34/v1/other");

        // Another path on the same source is a fetch nobody connected, even with the source's token on it.
        let why = redirect_target(&start, "/admin", &grant).unwrap_err();
        assert!(why.contains("different path on 93.184.216.34"), "{why}");
        // So is another host, and an address with `..` that leaves the path.
        assert!(redirect_target(&start, "https://evil.example/x", &grant).is_err());
        assert!(redirect_target(&start, "/v1/../admin", &grant).is_err());

        // A chain is checked hop by hop: the first hop stays inside, the next one out of it is refused.
        let why = redirect_target(&hop, "/admin", &grant).unwrap_err();
        assert!(why.contains("different path"), "{why}");
    }
}
