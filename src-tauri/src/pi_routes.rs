//! "Connect any model to any harness" (12 Nov 2026): the saved Other models, offered to Pi and Oh My Pi.
//!
//! Pi and its fork Oh My Pi load extensions given with `--extension <file>`, and an extension may register a model
//! provider. For each saved model the app starts the same local router Claude Code uses (model_router.rs) and hands
//! the child only what that router needs: its loopback address and a random per-session token, in environment
//! variables. A small extension (pi_routes_extension.js, no secrets in it) reads them and registers one provider per
//! model, speaking Anthropic Messages to the router. The model's real key never leaves this process (WP-129): the
//! router holds it, and the token stops working when the session ends. Claude models are never routed (may_route).
//!
//! A model whose key is missing or bound to another address is left out; it never fails the start, so one stale
//! entry can't stop Pi from opening.

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::model_router::{CustomRoute, RoutedEnv, SessionToken};

/// The most models handed to one child.
pub const MAX_ROUTES: usize = 16;
/// The env var holding the list the extension reads.
pub const ROUTES_ENV: &str = "DROPWAVE_PI_ROUTES";
const TOKEN_ENV_PREFIX: &str = "DROPWAVE_PI_TOKEN_";
const EXTENSION_NAME: &str = "dropwave-routes.js";
const EXTENSION_SOURCE: &str = include_str!("pi_routes_extension.js");
/// The Claude subscription for Pi and Oh My Pi: claude-code-pi (MIT, vendored unchanged) registers a
/// `claude-code-cli` provider that hands every call to the local Claude Code with `claude -p`. Anthropic's help
/// centre (Agent SDK with your Claude plan, Jun and Oct 2026) says `claude -p` signed in with a plan draws from the
/// subscription. The login stays inside Claude Code: nothing here reads or copies it.
const CLAUDE_EXTENSION_NAME: &str = "claude-code-pi.js";
const CLAUDE_EXTENSION_SOURCE: &str = include_str!("vendor/claude_code_pi.js");
/// The env var claude-code-pi reads for the Claude Code binary.
pub const CLAUDE_BIN_ENV: &str = "CLAUDE_CODE_PI_BIN";
/// Pi's default when the provider never said how big the window is.
const DEFAULT_WINDOW: u64 = 200_000;

/// The harnesses that take these routes.
pub fn takes_routes(binary_provider: Option<&str>) -> bool {
    matches!(binary_provider, Some("pi") | Some("omp"))
}

/// What a child is given: env vars to set and the router tokens to hold for the child's life.
pub struct PiRoutes {
    pub env: Vec<(String, String)>,
    pub sessions: Vec<SessionToken>,
}

/// A provider name Pi accepts: lowercase letters, digits and dashes, unique per saved model.
fn provider_name(custom_model_id: &str) -> String {
    let slug: String = custom_model_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    format!("dropwave-{slug}")
}

fn env_value<'a>(set: &'a [(&'static str, String)], name: &str) -> Option<&'a str> {
    set.iter()
        .find(|(key, _)| *key == name)
        .map(|(_, v)| v.as_str())
}

/// Prepares one route's router: production is model_router::prepare_routed_session.
pub type Prepare<'a> = &'a dyn Fn(&CustomRoute) -> Result<(RoutedEnv, SessionToken), String>;

/// Build the env for `routes`, preparing each with `prepare` (production: model_router::prepare_routed_session).
/// Routes that can't be prepared are skipped and named in the returned list of skipped model ids.
pub fn build_with(routes: &[CustomRoute], prepare: Prepare) -> (PiRoutes, Vec<String>) {
    let mut env = Vec::new();
    let mut sessions = Vec::new();
    let mut listed = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for route in routes.iter().take(MAX_ROUTES) {
        if !seen.insert(route.custom_model_id.clone()) {
            continue;
        }
        let ((set, _remove), session) = match prepare(route) {
            Ok(ready) => ready,
            Err(_) => {
                skipped.push(route.custom_model_id.clone());
                continue;
            }
        };
        let (Some(base), Some(token)) = (
            env_value(&set, "ANTHROPIC_BASE_URL"),
            env_value(&set, "ANTHROPIC_AUTH_TOKEN"),
        ) else {
            skipped.push(route.custom_model_id.clone());
            continue;
        };
        let window = env_value(&set, "CLAUDE_CODE_MAX_CONTEXT_TOKENS")
            .and_then(|w| w.parse::<u64>().ok())
            .unwrap_or(DEFAULT_WINDOW);
        let token_env = format!("{TOKEN_ENV_PREFIX}{}", listed.len());
        listed.push(json!({
            "provider": provider_name(&route.custom_model_id),
            "name": format!("{} (Dropwave)", route.model_id.trim()),
            "baseUrl": base,
            "modelId": route.model_id.trim(),
            "tokenEnv": token_env,
            "contextWindow": window,
        }));
        env.push((token_env, token.to_string()));
        sessions.push(session);
    }
    if !listed.is_empty() {
        env.push((
            ROUTES_ENV.to_string(),
            serde_json::Value::Array(listed).to_string(),
        ));
    }
    (PiRoutes { env, sessions }, skipped)
}

/// The routes for a Pi or Oh My Pi start, with the real router and Keychain.
pub fn build(routes: &[CustomRoute]) -> PiRoutes {
    let (ready, skipped) = build_with(routes, &crate::model_router::prepare_routed_session_quick);
    if !skipped.is_empty() {
        eprintln!(
            "[monocode] {} saved model(s) not offered to Pi: key missing or saved for another address",
            skipped.len()
        );
    }
    ready
}

/// Write the extension into a private folder under `root` and return its path. The file holds no secret; it is
/// rewritten on every start so a changed file can't stick.
pub fn write_extension_in(root: &Path) -> Result<PathBuf, String> {
    write_file_in(root, EXTENSION_NAME, EXTENSION_SOURCE)
}

/// Write the Claude subscription extension (claude-code-pi) beside it.
pub fn write_claude_extension_in(root: &Path) -> Result<PathBuf, String> {
    write_file_in(root, CLAUDE_EXTENSION_NAME, CLAUDE_EXTENSION_SOURCE)
}

/// Where the Claude extension lives: the same temp folder as the routes extension.
pub fn write_claude_extension() -> Result<PathBuf, String> {
    write_claude_extension_in(&std::env::temp_dir())
}

fn write_file_in(root: &Path, name: &str, source: &str) -> Result<PathBuf, String> {
    let fail = |e: &dyn std::fmt::Display| format!("Couldn't prepare Pi's model list: {e}");
    std::fs::create_dir_all(root).map_err(|e| fail(&e))?;
    let dir = root.join("dropwave-pi");
    match std::fs::create_dir(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(fail(&e)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // Never follow a link or use a folder someone else made: Pi runs whatever file is here.
        let meta = std::fs::symlink_metadata(&dir).map_err(|e| fail(&e))?;
        let uid = unsafe { libc::getuid() };
        if !meta.file_type().is_dir() || meta.uid() != uid {
            return Err(fail(&"its folder is not this user's own"));
        }
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| fail(&e))?;
    }
    let path = dir.join(name);
    // A unique name per write, so two starts at once never share a half-written file.
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, source)
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            fail(&e)
        })?;
    Ok(path)
}

/// Where the extension lives: the user's temp folder, which the agent sandbox lets a child read.
pub fn write_extension() -> Result<PathBuf, String> {
    write_extension_in(&std::env::temp_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(id: &str, model: &str) -> CustomRoute {
        CustomRoute {
            provider: "xai".into(),
            base_url: "https://api.x.ai/v1".into(),
            model_id: model.into(),
            custom_model_id: id.into(),
            reasoning_effort: None,
        }
    }

    fn fake_session(token: &str) -> SessionToken {
        crate::model_router::test_session_token(token)
    }

    fn prepared(
        r: &CustomRoute,
        token: &str,
        window: Option<u64>,
    ) -> Result<(RoutedEnv, SessionToken), String> {
        Ok((
            crate::model_router::routed_env(r, token, 4321, window),
            fake_session(token),
        ))
    }

    #[test]
    fn gives_the_child_the_router_and_token_never_the_key() {
        let routes = vec![route("grok-1", "grok-4.7"), route("ds", "deepseek-chat")];
        let (ready, skipped) = build_with(&routes, &|r| {
            prepared(r, &format!("tok-{}", r.custom_model_id), Some(131072))
        });
        assert!(skipped.is_empty());
        assert_eq!(ready.sessions.len(), 2);
        let get = |k: &str| {
            ready
                .env
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("DROPWAVE_PI_TOKEN_0").as_deref(), Some("tok-grok-1"));
        assert_eq!(get("DROPWAVE_PI_TOKEN_1").as_deref(), Some("tok-ds"));
        let list: serde_json::Value = serde_json::from_str(&get(ROUTES_ENV).unwrap()).unwrap();
        assert_eq!(list[0]["provider"], "dropwave-grok-1");
        assert_eq!(list[0]["baseUrl"], "http://127.0.0.1:4321");
        assert_eq!(list[0]["modelId"], "grok-4.7");
        assert_eq!(list[0]["tokenEnv"], "DROPWAVE_PI_TOKEN_0");
        assert_eq!(list[0]["contextWindow"], 131072);
        // The list itself carries no token.
        assert!(!get(ROUTES_ENV).unwrap().contains("tok-"));
        // Nothing Claude Code reads leaks into Pi's env.
        assert!(get("ANTHROPIC_AUTH_TOKEN").is_none());
        assert!(get("ANTHROPIC_BASE_URL").is_none());
    }

    #[test]
    fn skips_a_model_whose_key_is_missing_and_keeps_the_rest() {
        let routes = vec![route("stale", "grok-3"), route("ok", "grok-4.7")];
        let (ready, skipped) = build_with(&routes, &|r| {
            if r.custom_model_id == "stale" {
                Err(crate::key_binding::NOT_STORED_FOR_THIS.into())
            } else {
                prepared(r, "t", None)
            }
        });
        assert_eq!(skipped, vec!["stale".to_string()]);
        assert_eq!(ready.sessions.len(), 1);
        let list = ready.env.iter().find(|(k, _)| k == ROUTES_ENV).unwrap();
        let list: serde_json::Value = serde_json::from_str(&list.1).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["contextWindow"], DEFAULT_WINDOW);
        assert_eq!(list[0]["tokenEnv"], "DROPWAVE_PI_TOKEN_0");
    }

    #[test]
    fn nothing_saved_means_no_env_and_duplicates_count_once() {
        let (ready, _) = build_with(&[], &|r| prepared(r, "t", None));
        assert!(ready.env.is_empty());
        let routes = vec![route("a", "m"), route("a", "m")];
        let (ready, _) = build_with(&routes, &|r| prepared(r, "t", None));
        assert_eq!(ready.sessions.len(), 1);
    }

    #[test]
    fn caps_the_number_of_models() {
        let routes: Vec<_> = (0..40).map(|i| route(&format!("m{i}"), "grok")).collect();
        let (ready, _) = build_with(&routes, &|r| prepared(r, "t", None));
        assert_eq!(ready.sessions.len(), MAX_ROUTES);
    }

    #[test]
    fn provider_names_are_safe_for_pi() {
        assert_eq!(provider_name("Grok_4.7"), "dropwave-grok-4-7");
    }

    #[test]
    fn only_pi_and_omp_take_routes() {
        assert!(takes_routes(Some("pi")));
        assert!(takes_routes(Some("omp")));
        assert!(!takes_routes(Some("claude")));
        assert!(!takes_routes(None));
    }

    #[test]
    fn writes_the_extension_without_secrets() {
        let dir = std::env::temp_dir().join(format!("pi-routes-test-{}", uuid::Uuid::new_v4()));
        let path = write_extension_in(&dir).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(ROUTES_ENV));
        assert!(text.contains("registerProvider"));
        // Written again over an old copy.
        std::fs::write(&path, "tampered").unwrap();
        let again = write_extension_in(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(again).unwrap(), EXTENSION_SOURCE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_linked_folder() {
        let root = std::env::temp_dir().join(format!("pi-routes-link-{}", uuid::Uuid::new_v4()));
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("dropwave-pi")).unwrap();
        assert!(write_extension_in(&root).is_err());
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn writes_the_claude_extension_that_only_runs_claude_p() {
        let dir = std::env::temp_dir().join(format!("pi-claude-test-{}", uuid::Uuid::new_v4()));
        let path = write_claude_extension_in(&dir).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("// Vendored from claude-code-pi"));
        assert!(text.contains("MIT License"));
        assert!(text.contains("registerProvider(PROVIDER_ID"));
        assert!(text.contains(CLAUDE_BIN_ENV));
        // A CLI bridge only: no direct HTTP calls to Anthropic and no reading of Claude's credentials.
        assert!(!text.contains("fetch("));
        assert!(!text.contains("api.anthropic.com"));
        assert!(!text.contains(".credentials"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
