//! The connector catalog: every app the hub can connect, and how each one is launched.
//!
//! One file is the source of truth for both sides: `src/features/hub/model/connectorCatalog.json`. The webview imports
//! it for the Connectors page; this module compiles it in, so the launcher (`monocode connector-run`) knows how to start
//! a connector without asking the webview. Templates such as `Bearer {token}` are filled only in memory, at launch.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

const RAW: &str = include_str!("../../../src/features/hub/model/connectorCatalog.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub version: u32,
    pub google_client: GoogleClient,
    pub connectors: Vec<Entry>,
}

/// Google has no dynamic client registration: Ash makes one OAuth client and every Google connector uses it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleClient {
    pub redirect: String,
    pub authorize: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    /// The Composio long-tail server: only when the Composio switch is on.
    #[serde(default)]
    pub composio: bool,
    pub launch: Launch,
    pub auth: Auth,
    #[serde(default)]
    pub test: Option<TestSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Launch {
    /// A hosted MCP server (Streamable HTTP). The launcher bridges it to stdio, holding the login in memory.
    Remote {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    /// A local MCP server the launcher starts with the login in that child's environment only.
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    /// A small MCP server built into this binary (`builtin.rs`).
    Builtin { server: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    pub methods: Vec<Method>,
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default)]
    pub oauth: Option<OAuthSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    /// Ash pastes a key or token he made on the provider's site.
    Token,
    /// Ash signs in on the provider's own page in his browser.
    Oauth,
    /// No login (a local server or a public one).
    None,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSpec {
    pub mode: OAuthMode,
    #[serde(default)]
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthMode {
    /// MCP authorization: discovery, dynamic client registration, PKCE.
    Mcp,
    /// Google's fixed endpoints with Ash's own OAuth client.
    Google,
}

/// A read-only identity call made by the Test button ("Connected as @ash").
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSpec {
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// JSON pointer to the account name in the reply.
    #[serde(default)]
    pub account: Option<String>,
    /// JSON pointer to a boolean that must be true (Slack answers 200 with `ok:false`).
    #[serde(default)]
    pub ok_field: Option<String>,
}

pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| serde_json::from_str(RAW).expect("connectorCatalog.json is valid"))
}

pub fn entry(id: &str) -> Option<&'static Entry> {
    catalog().connectors.iter().find(|entry| entry.id == id)
}

impl Entry {
    pub fn allows(&self, method: Method) -> bool {
        self.auth.methods.contains(&method)
    }

    /// Only a connector with no login at all can be turned on without one.
    pub fn needs_login(&self) -> bool {
        !(self.auth.methods.len() == 1 && self.auth.methods[0] == Method::None)
    }
}

/// The `{name}` placeholders a template uses.
pub fn placeholders(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else { break };
        out.push(after[..end].to_string());
        rest = &after[end + 1..];
    }
    out
}

/// Fill `{name}` placeholders from a login's values. An error names the missing key, never a value.
pub fn fill(template: &str, values: &BTreeMap<String, String>) -> Result<String, String> {
    let mut out = template.to_string();
    for key in placeholders(template) {
        let value = values
            .get(&key)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("The login has no {key}. Sign in again."))?;
        out = out.replace(&format!("{{{key}}}"), value);
    }
    Ok(out)
}

/// Ids are used in Keychain names, file keys and argv: lowercase letters, digits and hyphens only.
pub fn valid_id(id: &str) -> bool {
    (1..=48).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn the_catalog_parses_and_every_entry_is_launchable() {
        let catalog = catalog();
        assert!(
            catalog.connectors.len() >= 25,
            "as many connectors as we can"
        );
        let mut ids = BTreeSet::new();
        for entry in &catalog.connectors {
            assert!(valid_id(&entry.id), "{}", entry.id);
            assert!(ids.insert(entry.id.clone()), "duplicate {}", entry.id);
            assert!(!entry.auth.methods.is_empty(), "{}", entry.id);
            if entry.allows(Method::Oauth) {
                assert!(
                    entry.auth.oauth.is_some(),
                    "{} needs an oauth spec",
                    entry.id
                );
                assert!(
                    matches!(entry.launch, Launch::Remote { .. }),
                    "{}: OAuth logins only go to hosted servers",
                    entry.id
                );
            }
            // Every placeholder must be fillable from the login: a token field, or `token` from an OAuth sign-in.
            let mut known: BTreeSet<String> =
                entry.auth.fields.iter().map(|f| f.key.clone()).collect();
            if entry.allows(Method::Oauth) {
                known.insert("token".into());
            }
            let templates: Vec<&String> = match &entry.launch {
                Launch::Remote { url, headers } => {
                    std::iter::once(url).chain(headers.values()).collect()
                }
                Launch::Stdio { args, env, .. } => args.iter().chain(env.values()).collect(),
                Launch::Builtin { server } => {
                    assert_eq!(server, "telegram");
                    vec![]
                }
            };
            for template in templates {
                for key in placeholders(template) {
                    assert!(known.contains(&key), "{}: {{{key}}} has no field", entry.id);
                }
            }
            // A local server never gets its secret on the command line: only in its environment.
            if let Launch::Stdio { args, .. } = &entry.launch {
                for arg in args {
                    assert!(placeholders(arg).is_empty(), "{}: secret in argv", entry.id);
                }
            }
            // Every secret field reaches the server somewhere, and nothing secret is a literal.
            for field in &entry.auth.fields {
                assert!(field.secret, "{}: {} should be secret", entry.id, field.key);
            }
        }
        // The apps Ash named on day one.
        for id in [
            "github",
            "gmail",
            "google-calendar",
            "notion",
            "slack",
            "linear",
            "supabase",
            "vercel",
            "stripe",
            "telegram",
            "composio",
        ] {
            assert!(entry(id).is_some(), "{id} missing");
        }
        assert_eq!(
            catalog.connectors.iter().filter(|e| e.composio).count(),
            1,
            "Composio is one switch-gated entry"
        );
    }

    #[test]
    fn fill_only_names_missing_keys() {
        let values = BTreeMap::from([("token".to_string(), "s3cr3t".to_string())]);
        assert_eq!(fill("Bearer {token}", &values).unwrap(), "Bearer s3cr3t");
        let err = fill("{api_key}", &values).unwrap_err();
        assert!(err.contains("api_key") && !err.contains("s3cr3t"));
        let empty = BTreeMap::from([("token".to_string(), String::new())]);
        assert!(fill("Bearer {token}", &empty).is_err());
        assert_eq!(placeholders("{a} and {b}"), vec!["a", "b"]);
    }
}
