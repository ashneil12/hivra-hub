//! Connector logins: one Keychain item per connector, never anywhere else.
//!
//! The item is `monocode-hub:connector:<id>` (a dev copy: `monocode-hub-dev:connector:<id>`, `hub_keychain.rs`), account
//! `login`, and its secret is the login as JSON: the fields Ash pasted, or the tokens an OAuth sign-in returned. Nothing
//! here prints a value: `Debug` lists field names only, and every error is a plain sentence without one.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// The shared Google OAuth client (client ID and secret) every Google connector signs in with.
pub const GOOGLE_CLIENT: &str = "google-client";
const ACCOUNT: &str = "login";

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(from = "WireLogin", into = "WireLogin")]
pub struct Login {
    /// Values the person pasted, or that arrived already at rest.
    pub fields: BTreeMap<String, String>,
    /// WP-92: a field that points at a vault entry instead of holding a copy: `{"secret": "<name>"}` in the saved JSON.
    pub refs: BTreeMap<String, String>,
    pub oauth: Option<OAuthTokens>,
}

/// The saved shape. A field value is a string, or `{"secret": "<name>"}`; the in-memory `Login` keeps the two apart.
#[derive(Clone, Serialize, Deserialize)]
struct WireLogin {
    #[serde(default)]
    fields: BTreeMap<String, WireField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    oauth: Option<OAuthTokens>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum WireField {
    Plain(String),
    Secret(SecretRef),
}

#[derive(Clone, Serialize, Deserialize)]
struct SecretRef {
    secret: String,
}

impl From<WireLogin> for Login {
    fn from(wire: WireLogin) -> Self {
        let mut fields = BTreeMap::new();
        let mut refs = BTreeMap::new();
        for (key, value) in wire.fields {
            match value {
                WireField::Plain(value) => {
                    fields.insert(key, value);
                }
                WireField::Secret(reference) => {
                    refs.insert(key, reference.secret);
                }
            }
        }
        Self {
            fields,
            refs,
            oauth: wire.oauth,
        }
    }
}

impl From<Login> for WireLogin {
    fn from(login: Login) -> Self {
        let mut fields: BTreeMap<String, WireField> = login
            .fields
            .into_iter()
            .map(|(key, value)| (key, WireField::Plain(value)))
            .collect();
        for (key, secret) in login.refs {
            fields.insert(key, WireField::Secret(SecretRef { secret }));
        }
        Self {
            fields,
            oauth: login.oauth,
        }
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    pub token_endpoint: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// RFC 8707 resource (the MCP server's URL) for MCP sign-ins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
}

impl fmt::Debug for Login {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Login")
            .field("fields", &self.fields.keys().collect::<Vec<_>>())
            .field("refs", &self.refs.keys().collect::<Vec<_>>())
            .field("oauth", &self.oauth.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl fmt::Debug for OAuthTokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OAuthTokens(<redacted>)")
    }
}

impl Login {
    /// What templates are filled from: the fields, plus `token` = the OAuth access token after a browser sign-in.
    pub fn values(&self) -> BTreeMap<String, String> {
        let mut values = self.fields.clone();
        if let Some(oauth) = &self.oauth {
            values.insert("token".into(), oauth.access_token.clone());
        }
        values
    }

    /// Every secret this login holds, for redacting anything that might be printed.
    pub fn secrets(&self) -> Vec<String> {
        let mut out: Vec<String> = self.fields.values().cloned().collect();
        if let Some(oauth) = &self.oauth {
            out.push(oauth.access_token.clone());
            out.extend(oauth.refresh_token.clone());
            out.extend(oauth.client_secret.clone());
        }
        out.retain(|value| value.len() >= 4);
        out
    }
}

/// Replace every secret in `text` with dots. Used on every line the launcher prints and every error it returns.
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    let mut sorted: Vec<&String> = secrets.iter().filter(|s| s.len() >= 4).collect();
    // Longest first, so a secret that contains another is hidden whole.
    sorted.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for secret in sorted {
        out = out.replace(secret.as_str(), "•••");
    }
    out
}

/// Where logins are kept. The app and the launcher use the Keychain; tests use memory.
pub trait SecretStore: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<Login>, String>;
    fn put(&self, id: &str, login: &Login) -> Result<(), String>;
    fn remove(&self, id: &str) -> Result<bool, String>;
}

pub fn service(id: &str) -> String {
    format!("monocode-hub:connector:{id}")
}

/// The macOS Keychain (through `hub_keychain`, which keeps a dev copy to `monocode-hub-dev:*`).
pub struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, id: &str) -> Result<Option<Login>, String> {
        match crate::hub_keychain::read(&service(id), ACCOUNT)? {
            None => Ok(None),
            Some(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|_| "The saved login couldn't be read. Sign in again.".to_string()),
        }
    }

    fn put(&self, id: &str, login: &Login) -> Result<(), String> {
        let raw =
            serde_json::to_string(login).map_err(|_| "Couldn't save the login.".to_string())?;
        crate::hub_keychain::store(&service(id), ACCOUNT, &raw)
    }

    fn remove(&self, id: &str) -> Result<bool, String> {
        crate::hub_keychain::delete(&service(id), ACCOUNT)
    }
}

/// In memory, stored as the same JSON the Keychain would hold, so tests can scan exactly what would be kept.
#[cfg(test)]
#[derive(Default)]
pub struct Memory(pub std::sync::Mutex<BTreeMap<String, String>>);

#[cfg(test)]
impl SecretStore for Memory {
    fn get(&self, id: &str) -> Result<Option<Login>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&service(id))
            .map(|raw| serde_json::from_str(raw).unwrap()))
    }
    fn put(&self, id: &str, login: &Login) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(service(id), serde_json::to_string(login).unwrap());
        Ok(())
    }
    fn remove(&self, id: &str) -> Result<bool, String> {
        Ok(self.0.lock().unwrap().remove(&service(id)).is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Login {
        Login {
            fields: BTreeMap::from([("token".into(), "ghp_SENTINEL_FIELD".into())]),
            refs: BTreeMap::new(),
            oauth: Some(OAuthTokens {
                access_token: "ACCESS_SENTINEL".into(),
                refresh_token: Some("REFRESH_SENTINEL".into()),
                expires_at: Some(1),
                token_endpoint: "https://as.example/token".into(),
                client_id: "client".into(),
                client_secret: Some("CLIENT_SECRET_SENTINEL".into()),
                resource: None,
            }),
        }
    }

    #[test]
    fn debug_output_never_shows_a_value() {
        let shown = format!("{:?} {:?}", sample(), sample().oauth.unwrap());
        for secret in sample().secrets() {
            assert!(!shown.contains(&secret), "{shown}");
        }
        assert!(shown.contains("token"), "field names are fine: {shown}");
    }

    #[test]
    fn redact_hides_every_secret_even_nested() {
        let login = sample();
        let line = "auth failed for ghp_SENTINEL_FIELD with ACCESS_SENTINEL/REFRESH_SENTINEL";
        let clean = redact(line, &login.secrets());
        for secret in login.secrets() {
            assert!(!clean.contains(&secret), "{clean}");
        }
        assert_eq!(redact("abcdef", &["abcdef".into(), "bcd".into()]), "•••");
        // Very short values aren't treated as secrets (they would mangle ordinary text).
        assert_eq!(redact("a b c", &["a".into()]), "a b c");
    }

    #[test]
    fn a_login_field_may_point_at_the_vault() {
        let raw = r#"{"fields":{"token":{"secret":"github-token"}}}"#;
        let login: Login = serde_json::from_str(raw).unwrap();
        assert!(login.fields.is_empty());
        assert_eq!(login.refs["token"], "github-token");
        // The saved shape stays a reference: it round-trips as one, and never grows a plain value.
        let stored = serde_json::to_string(&login).unwrap();
        assert_eq!(stored, raw, "{stored}");
        let back: Login = serde_json::from_str(&stored).unwrap();
        assert_eq!(back, login);
        // Plain values and references live side by side in one saved login.
        let mixed = Login {
            fields: BTreeMap::from([("mcp_url".into(), "https://mcp.example/sse".into())]),
            refs: BTreeMap::from([("token".into(), "github-token".into())]),
            oauth: None,
        };
        let saved = serde_json::to_string(&mixed).unwrap();
        assert!(
            saved.contains(r#""token":{"secret":"github-token"}"#),
            "{saved}"
        );
        assert!(
            saved.contains(r#""mcp_url":"https://mcp.example/sse""#),
            "{saved}"
        );
        assert!(
            !saved.contains("refs"),
            "the saved shape has no refs map: {saved}"
        );
        // A reference is a name, not a value: redaction has nothing to hide for it, and Debug shows the key only.
        assert!(mixed.secrets().is_empty() || !mixed.secrets().contains(&"github-token".into()));
        assert!(!format!("{mixed:?}").contains("https://mcp.example/sse"));
    }

    #[test]
    fn oauth_values_fill_the_token_placeholder() {
        let values = sample().values();
        assert_eq!(values["token"], "ACCESS_SENTINEL");
    }

    #[test]
    fn dev_and_daily_connector_items_never_share_a_name() {
        use crate::hub_keychain::scoped_service;
        use crate::instance::Kind;
        let daily = scoped_service(Kind::Daily, &service("github"));
        let dev = scoped_service(Kind::Dev, &service("github"));
        assert_eq!(daily, "monocode-hub:connector:github");
        assert_eq!(dev, "monocode-hub-dev:connector:github");
    }
}
