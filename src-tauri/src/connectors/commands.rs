//! What the Connectors page can do, as commands of the `hub` plugin. A secret goes in (`connector_save_login`,
//! `connector_save_google_client`) and never comes back out: the page gets names, states and messages only.

use super::catalog::{self, Method, OAuthMode};
use super::check::{self, Outcome};
use super::launch::{data_dir, SUBCOMMAND};
use super::oauth;
use super::secrets::{redact, Keychain, Login, SecretStore, GOOGLE_CLIENT};
use super::settings::{self, ConnectorState, MonoChoice, Settings, Status};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// One writer at a time for `connectors.json` in this app.
static WRITE: Mutex<()> = Mutex::new(());
/// Set by Cancel while a browser sign-in waits.
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub settings: Settings,
    /// The binary a session's MCP config points at (`<this app> connector-run …`).
    pub launcher: String,
    pub subcommand: &'static str,
    /// "daily" or "dev": a dev copy's logins are its own (`monocode-hub-dev:*`).
    pub kind: crate::instance::Kind,
}

pub struct Service {
    pub dir: PathBuf,
    pub store: Arc<dyn SecretStore>,
    pub launcher: String,
}

fn launcher() -> String {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "monocode".into())
}

fn entry(id: &str) -> Result<&'static catalog::Entry, String> {
    catalog::entry(id).ok_or_else(|| format!("No connector called {id}."))
}

/// A server URL: https, or plain http only to this Mac (a server you run yourself).
fn secure_or_local(value: &str) -> bool {
    match url::Url::parse(value) {
        Ok(url) if url.scheme() == "https" => url.host_str().is_some(),
        Ok(url) if url.scheme() == "http" => {
            matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        }
        _ => false,
    }
}

fn check_allow(allow: &[String]) -> Result<(), String> {
    if allow.len() > 200 || !allow.iter().all(|scope| settings::valid_scope(scope)) {
        return Err("Those projects aren't valid.".into());
    }
    Ok(())
}

impl Service {
    pub fn live() -> Result<Self, String> {
        Ok(Self {
            dir: data_dir()?,
            store: Arc::new(Keychain),
            launcher: launcher(),
        })
    }

    pub fn view(&self) -> View {
        View {
            settings: settings::load(&self.dir),
            launcher: self.launcher.clone(),
            subcommand: SUBCOMMAND,
            kind: crate::instance::kind(),
        }
    }

    fn change(
        &self,
        edit: impl FnOnce(&mut Settings) -> Result<(), String>,
    ) -> Result<View, String> {
        let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        let mut current = settings::load(&self.dir);
        edit(&mut current)?;
        settings::save(&self.dir, &current)?;
        Ok(self.view())
    }

    fn signed_in(
        &self,
        id: &str,
        method: Method,
        allow: Option<Vec<String>>,
    ) -> Result<View, String> {
        self.change(|s| {
            let state = s.connectors.entry(id.to_string()).or_default();
            state.signed_in = true;
            state.method = Some(method);
            state.account = None;
            state.status = None;
            if let Some(allow) = allow {
                state.allow = allow;
            }
            Ok(())
        })
    }

    /// Ash pasted a key or token. It goes to the Keychain; the file only learns that there is one.
    pub fn save_login(
        &self,
        id: &str,
        fields: BTreeMap<String, String>,
        allow: Option<Vec<String>>,
    ) -> Result<View, String> {
        let entry = entry(id)?;
        if !entry.allows(Method::Token) {
            return Err(format!(
                "{} signs in through its own page, not with a pasted key.",
                entry.name
            ));
        }
        if let Some(allow) = &allow {
            check_allow(allow)?;
        }
        let mut clean = BTreeMap::new();
        for (key, value) in fields {
            let Some(field) = entry.auth.fields.iter().find(|f| f.key == key) else {
                return Err(format!("{} has no field called {key}.", entry.name));
            };
            let value = value.trim().to_string();
            if value.len() > 8192 || value.chars().any(char::is_control) {
                return Err("That value isn't valid.".into());
            }
            if key.ends_with("url") && !value.is_empty() && !secure_or_local(&value) {
                return Err(
                    "The address must start with https:// (or be a server on this Mac).".into(),
                );
            }
            if !value.is_empty() || !field.optional {
                clean.insert(key, value);
            }
        }
        for field in entry.auth.fields.iter().filter(|f| !f.optional) {
            if clean.get(&field.key).is_none_or(|v| v.is_empty()) {
                return Err(format!("{} needs every field filled in.", entry.name));
            }
        }
        self.store.put(
            id,
            &Login {
                fields: clean,
                oauth: None,
            },
        )?;
        self.signed_in(id, Method::Token, allow)
    }

    /// A connector with no login (a local or public server) is simply turned on.
    pub fn turn_on(&self, id: &str, allow: Option<Vec<String>>) -> Result<View, String> {
        let entry = entry(id)?;
        if entry.needs_login() {
            return Err(format!("{} needs a sign-in.", entry.name));
        }
        if let Some(allow) = &allow {
            check_allow(allow)?;
        }
        self.signed_in(id, Method::None, allow)
    }

    pub fn save_google_client(&self, client_id: &str, client_secret: &str) -> Result<View, String> {
        let (client_id, client_secret) = (client_id.trim(), client_secret.trim());
        if client_id.is_empty()
            || client_secret.is_empty()
            || client_id.len() > 512
            || client_secret.len() > 512
        {
            return Err("Paste both the client ID and the client secret.".into());
        }
        if !client_id.ends_with(".apps.googleusercontent.com") {
            return Err(
                "That isn't a Google OAuth client ID (it ends in .apps.googleusercontent.com)."
                    .into(),
            );
        }
        let login = Login {
            fields: BTreeMap::from([
                ("client_id".to_string(), client_id.to_string()),
                ("client_secret".to_string(), client_secret.to_string()),
            ]),
            oauth: None,
        };
        self.store.put(GOOGLE_CLIENT, &login)?;
        self.change(|s| {
            s.google_client = true;
            Ok(())
        })
    }

    pub fn forget_google_client(&self) -> Result<View, String> {
        self.store.remove(GOOGLE_CLIENT)?;
        self.change(|s| {
            s.google_client = false;
            Ok(())
        })
    }

    /// The browser sign-in. `open` shows the provider's page; the code comes back to a loopback address.
    pub fn oauth(
        &self,
        id: &str,
        allow: Option<Vec<String>>,
        open: &dyn Fn(&str) -> Result<(), String>,
        cancel: &AtomicBool,
    ) -> Result<View, String> {
        let entry = entry(id)?;
        let spec = entry
            .auth
            .oauth
            .as_ref()
            .filter(|_| entry.allows(Method::Oauth))
            .ok_or_else(|| format!("{} has no browser sign-in.", entry.name))?;
        if let Some(allow) = &allow {
            check_allow(allow)?;
        }
        let catalog::Launch::Remote { url, .. } = &entry.launch else {
            return Err("Only hosted servers sign in through the browser.".into());
        };
        let google = match spec.mode {
            OAuthMode::Google => {
                let client = self
                    .store
                    .get(GOOGLE_CLIENT)?
                    .ok_or("Add your Google OAuth client first.")?;
                let field = |key: &str| client.fields.get(key).cloned().unwrap_or_default();
                Some((
                    &catalog::catalog().google_client,
                    field("client_id"),
                    field("client_secret"),
                ))
            }
            OAuthMode::Mcp => None,
        };
        let secrets = google
            .as_ref()
            .map(|(_, _, secret)| vec![secret.clone()])
            .unwrap_or_default();
        let tokens = oauth::sign_in(url, spec, google, open, cancel)
            .map_err(|why| redact(&why, &secrets))?;
        self.store.put(
            id,
            &Login {
                fields: BTreeMap::new(),
                oauth: Some(tokens),
            },
        )?;
        self.signed_in(id, Method::Oauth, allow)
    }

    pub fn sign_out(&self, id: &str) -> Result<View, String> {
        entry(id)?;
        self.store.remove(id)?;
        self.change(|s| {
            if let Some(state) = s.connectors.get_mut(id) {
                // The projects it was allowed in stay, so signing in again puts it back where it was.
                *state = ConnectorState {
                    allow: std::mem::take(&mut state.allow),
                    ..Default::default()
                };
            }
            Ok(())
        })
    }

    pub fn test(&self, id: &str) -> Result<Outcome, String> {
        let entry = entry(id)?;
        let mut login = if entry.needs_login() {
            match self.store.get(id)? {
                Some(login) => login,
                None => {
                    let outcome = Outcome {
                        ok: false,
                        message: format!("{} isn't signed in on this Mac.", entry.name),
                        account: None,
                        tools: None,
                    };
                    self.record(id, &outcome)?;
                    return Ok(outcome);
                }
            }
        } else {
            Login::default()
        };
        let outcome = check::run(entry, &mut login, self.store.as_ref());
        self.record(id, &outcome)?;
        Ok(outcome)
    }

    fn record(&self, id: &str, outcome: &Outcome) -> Result<View, String> {
        self.change(|s| {
            let state = s.connectors.entry(id.to_string()).or_default();
            state.status = Some(Status {
                ok: outcome.ok,
                message: outcome.message.clone(),
                at: oauth::now(),
            });
            if outcome.account.is_some() {
                state.account = outcome.account.clone();
            }
            Ok(())
        })
    }

    pub fn set_allow(&self, id: &str, allow: Vec<String>) -> Result<View, String> {
        entry(id)?;
        check_allow(&allow)?;
        self.change(|s| {
            s.connectors.entry(id.to_string()).or_default().allow = allow;
            Ok(())
        })
    }

    pub fn set_mono(&self, mono: &str, choice: Option<MonoChoice>) -> Result<View, String> {
        if !settings::valid_mono_id(mono) {
            return Err("That isn't a Mono.".into());
        }
        if let Some(MonoChoice::All { except: ids } | MonoChoice::Only { ids }) = &choice {
            if ids.len() > 200 || !ids.iter().all(|id| catalog::valid_id(id)) {
                return Err("Those connectors aren't valid.".into());
            }
        }
        self.change(|s| {
            match choice {
                Some(choice) => s.monos.insert(mono.to_string(), choice),
                None => s.monos.remove(mono),
            };
            Ok(())
        })
    }

    pub fn set_composio(&self, on: bool) -> Result<View, String> {
        self.change(|s| {
            s.composio = on;
            Ok(())
        })
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce(Service) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work(Service::live()?))
        .await
        .map_err(|_| "Couldn't reach the connector settings.".to_string())?
}

#[tauri::command]
pub async fn connectors_state() -> Result<View, String> {
    blocking(|s| Ok(s.view())).await
}

#[tauri::command]
pub async fn connector_save_login(
    id: String,
    fields: BTreeMap<String, String>,
    allow: Option<Vec<String>>,
) -> Result<View, String> {
    blocking(move |s| s.save_login(&id, fields, allow)).await
}

#[tauri::command]
pub async fn connector_turn_on(id: String, allow: Option<Vec<String>>) -> Result<View, String> {
    blocking(move |s| s.turn_on(&id, allow)).await
}

#[tauri::command]
pub async fn connector_save_google_client(
    client_id: String,
    client_secret: String,
) -> Result<View, String> {
    blocking(move |s| s.save_google_client(&client_id, &client_secret)).await
}

#[tauri::command]
pub async fn connector_forget_google_client() -> Result<View, String> {
    blocking(|s| s.forget_google_client()).await
}

#[tauri::command]
pub async fn connector_oauth(id: String, allow: Option<Vec<String>>) -> Result<View, String> {
    CANCEL.store(false, Ordering::SeqCst);
    blocking(move |s| {
        s.oauth(
            &id,
            allow,
            &|url| open::that_detached(url).map_err(|_| "Couldn't open the browser.".to_string()),
            &CANCEL,
        )
    })
    .await
}

#[tauri::command]
pub fn connector_oauth_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn connector_sign_out(id: String) -> Result<View, String> {
    blocking(move |s| s.sign_out(&id)).await
}

#[tauri::command]
pub async fn connector_test(id: String) -> Result<Outcome, String> {
    blocking(move |s| s.test(&id)).await
}

#[tauri::command]
pub async fn connector_set_allow(id: String, allow: Vec<String>) -> Result<View, String> {
    blocking(move |s| s.set_allow(&id, allow)).await
}

#[tauri::command]
pub async fn connector_set_mono(
    mono_id: String,
    choice: Option<MonoChoice>,
) -> Result<View, String> {
    blocking(move |s| s.set_mono(&mono_id, choice)).await
}

#[tauri::command]
pub async fn connectors_set_composio(on: bool) -> Result<View, String> {
    blocking(move |s| s.set_composio(on)).await
}

#[cfg(test)]
mod tests {
    use super::super::bridge::tests::Buffer;
    use super::super::launch::{prepare, Args, Plan};
    use super::super::secrets::Memory;
    use super::super::settings::{EVERYWHERE, OUTSIDE};
    use super::*;

    const SENTINEL: &str = "ghp_SENTINEL_9f8e7d6c5b4a";

    fn service() -> (Service, Arc<Memory>) {
        let dir = std::env::temp_dir().join(format!("mc-svc-{}", uuid::Uuid::new_v4()));
        let memory = Arc::new(Memory::default());
        (
            Service {
                dir,
                store: memory.clone(),
                launcher: "/Applications/MonoCode Hub.app/Contents/MacOS/monocode".into(),
            },
            memory,
        )
    }

    /// Every file under `dir`, as text.
    fn every_file(dir: &std::path::Path) -> String {
        let mut out = String::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            if entry.path().is_file() {
                out.push_str(&std::fs::read_to_string(entry.path()).unwrap_or_default());
            }
        }
        out
    }

    #[test]
    fn a_pasted_token_lands_in_the_store_and_nowhere_else() {
        let (svc, memory) = service();
        let view = svc
            .save_login(
                "github",
                BTreeMap::from([("token".into(), format!("  {SENTINEL} "))]),
                Some(vec!["/p/hivra".into()]),
            )
            .unwrap();
        // The view the webview gets back: no secret.
        let shown = serde_json::to_string(&view).unwrap();
        assert!(!shown.contains(SENTINEL), "{shown}");
        assert!(view.settings.connectors["github"].signed_in);
        assert_eq!(view.settings.connectors["github"].allow, vec!["/p/hivra"]);
        // The settings file: no secret.
        assert!(!every_file(&svc.dir).contains(SENTINEL));
        // The store: exactly the trimmed secret, under the connector's own Keychain name.
        let raw = memory
            .0
            .lock()
            .unwrap()
            .get("monocode-hub:connector:github")
            .cloned()
            .unwrap();
        assert!(raw.contains(SENTINEL) && !raw.contains(&format!(" {SENTINEL}")));

        // The session's launch: a Mono in that project gets a plan with the token only in the header, filled in memory.
        let args = Args {
            id: "github".into(),
            mono: "m".into(),
            projects: vec!["/p/hivra".into()],
        };
        let (_, _, plan) = prepare(&args, &svc.dir, memory.as_ref()).unwrap();
        assert!(matches!(plan, Plan::Remote { .. }));

        svc.sign_out("github").unwrap();
        assert!(
            memory.0.lock().unwrap().is_empty(),
            "signed out: gone from the store"
        );
        let after = svc.view().settings.connectors["github"].clone();
        assert!(!after.signed_in);
        assert_eq!(
            after.allow,
            vec!["/p/hivra"],
            "projects kept for the next sign-in"
        );
        std::fs::remove_dir_all(&svc.dir).unwrap();
    }

    #[test]
    fn logins_are_validated() {
        let (svc, _) = service();
        let token = |v: &str| BTreeMap::from([("token".to_string(), v.to_string())]);
        assert!(svc
            .save_login("github", token(""), None)
            .unwrap_err()
            .contains("every field"));
        assert!(svc
            .save_login(
                "github",
                BTreeMap::from([("password".into(), "x".into())]),
                None
            )
            .is_err());
        assert!(svc
            .save_login("notion", token("x"), None)
            .unwrap_err()
            .contains("its own page"));
        assert!(svc.save_login("nope", token("x"), None).is_err());
        assert!(svc
            .save_login(
                "zapier",
                BTreeMap::from([("mcp_url".into(), "http://insecure.example.com/mcp".into())]),
                None
            )
            .unwrap_err()
            .contains("https://"));
        assert!(svc
            .save_login(
                "zapier",
                BTreeMap::from([("mcp_url".into(), "http://127.0.0.1:8123/mcp".into())]),
                None
            )
            .is_ok());
        assert!(!secure_or_local("http://127.0.0.1.evil.com/x"));
        assert!(!secure_or_local("ftp://127.0.0.1/x"));
        assert!(svc.save_login("github", token("a\nb"), None).is_err());
        assert!(svc
            .turn_on("github", None)
            .unwrap_err()
            .contains("needs a sign-in"));
        assert!(svc
            .turn_on("context7", Some(vec![EVERYWHERE.into()]))
            .is_ok());
        assert!(svc.set_allow("github", vec!["bad\u{0}".into()]).is_err());
        assert!(svc.set_mono("../evil", None).is_err());
        assert!(svc.save_google_client("not-google", "s").is_err());
        let _ = std::fs::remove_dir_all(&svc.dir);
    }

    #[test]
    fn the_google_client_is_shared_and_kept_like_a_login() {
        let (svc, memory) = service();
        let view = svc
            .save_google_client("123.apps.googleusercontent.com", "GOCSPX-SENTINEL")
            .unwrap();
        assert!(view.settings.google_client);
        assert!(!serde_json::to_string(&view)
            .unwrap()
            .contains("GOCSPX-SENTINEL"));
        assert!(!every_file(&svc.dir).contains("GOCSPX-SENTINEL"));
        assert!(memory
            .0
            .lock()
            .unwrap()
            .contains_key("monocode-hub:connector:google-client"));
        // A Google sign-in without the client says what to do first.
        let (bare, _) = service();
        let err = bare
            .oauth("gmail", None, &|_| Ok(()), &AtomicBool::new(false))
            .unwrap_err();
        assert!(err.contains("Google OAuth client"), "{err}");
        let view = svc.forget_google_client().unwrap();
        assert!(!view.settings.google_client);
        let _ = std::fs::remove_dir_all(&svc.dir);
    }

    #[test]
    fn mono_choices_and_composio_round_trip() {
        let (svc, _) = service();
        assert!(!svc.view().settings.composio, "Composio is off by default");
        assert!(svc.set_composio(true).unwrap().settings.composio);
        let view = svc
            .set_mono(
                "mono-1",
                Some(MonoChoice::Only {
                    ids: vec!["github".into()],
                }),
            )
            .unwrap();
        assert_eq!(
            view.settings.monos["mono-1"],
            MonoChoice::Only {
                ids: vec!["github".into()]
            }
        );
        assert!(svc
            .set_mono("mono-1", None)
            .unwrap()
            .settings
            .monos
            .is_empty());
        let view = svc.set_allow("slack", vec![OUTSIDE.into()]).unwrap();
        assert!(
            !view.settings.connectors["slack"].signed_in,
            "allowing doesn't sign in"
        );
        let _ = std::fs::remove_dir_all(&svc.dir);
    }

    /// The whole path a secret takes, scanned at every stop: the settings file, what the webview sees, the session's
    /// `--mcp-config` (argv), the launcher's log, and the bridge's stdout. The secret may only reach the server.
    #[test]
    fn end_to_end_the_secret_reaches_only_the_server() {
        use super::super::bridge::{tests::fake_mcp, tests::Seen, Bridge};
        use super::super::remote::Remote;
        let (svc, memory) = service();
        let seen = Arc::new(Seen::default());
        let server = fake_mcp(Arc::new(Mutex::new(SENTINEL.into())), Arc::clone(&seen));
        // GitHub with a bearer token; the plan's headers are then sent to the fake server instead of GitHub's.
        svc.save_login(
            "github",
            BTreeMap::from([("token".into(), SENTINEL.into())]),
            Some(vec![EVERYWHERE.into()]),
        )
        .unwrap();

        // 1. The session's MCP config, as the webview builds it (mirrored here): launcher + ids only.
        let config = serde_json::json!({"mcpServers": {"github": {
            "command": svc.launcher, "args": [SUBCOMMAND, "github", "--mono", "m", "--project", "/p/hivra"]}}});
        assert!(!config.to_string().contains(SENTINEL));
        // 2. The settings file and the view.
        assert!(!every_file(&svc.dir).contains(SENTINEL));
        assert!(!serde_json::to_string(&svc.view())
            .unwrap()
            .contains(SENTINEL));
        // 3. The launch, with its log captured.
        let args = Args {
            id: "github".into(),
            mono: "m".into(),
            projects: vec!["/p/hivra".into()],
        };
        let (_, login, plan) = prepare(&args, &svc.dir, memory.as_ref()).unwrap();
        let Plan::Remote { headers, .. } = plan else {
            panic!()
        };
        let log = Buffer::default();
        let log_to = log.clone();
        let secrets = login.secrets();
        let bridge = Bridge {
            remote: Arc::new(Remote::new(server, headers)),
            refresh: None,
            log: Arc::new(move |line| {
                use std::io::Write as _;
                let _ = writeln!(log_to.clone(), "{}", redact(line, &secrets));
            }),
        };
        let out = Buffer::default();
        let stdin = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude","version":"1"}}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"say":"ghp_SENTINEL_9f8e7d6c5b4a"}}}"#,
            "\n"
        );
        bridge.run(stdin.as_bytes(), Arc::new(Mutex::new(out.clone())));
        assert!(out.text().contains("\"tools\""), "{}", out.text());
        assert!(!log.text().contains(SENTINEL), "log: {}", log.text());
        // 4. The server got it, in the Authorization header only.
        let requests = seen.requests.lock().unwrap();
        assert!(requests
            .iter()
            .all(|(head, _)| head.contains(&format!("Bearer {SENTINEL}"))));
        let _ = std::fs::remove_dir_all(&svc.dir);
    }
}
