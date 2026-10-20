//! `monocode connector-run <id> --mono <mono id> [--project <project key>]…`: how a Claude Code session starts a
//! connector.
//!
//! The app gives a Mono's session `--mcp-config` entries that point here, with no login in them. At launch this:
//! 1. reads `connectors.json` again and refuses unless this Mono, in these projects, may use the connector;
//! 2. reads the login from the Keychain (renewing an expiring OAuth token);
//! 3. serves the connector: a hosted server through the stdio bridge (login in this process's memory only), a local
//!    server as a child with the login in that child's environment only, or a built-in server.
//!
//! Nothing it prints carries a secret: every line goes through `redact`.

use super::bridge::{Bridge, Log, Refresher};
use super::builtin::Telegram;
use super::catalog::{self, fill, Entry, Launch};
use super::oauth;
use super::remote::Remote;
use super::secrets::{redact, Keychain, Login, SecretStore};
use super::settings;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// The subcommand, as the app writes it into a session's MCP config.
pub const SUBCOMMAND: &str = "connector-run";
/// `EX_NOPERM`: not allowed, or not signed in.
pub const EXIT_REFUSED: i32 = 77;

#[derive(Debug, PartialEq)]
pub struct Args {
    pub id: String,
    pub mono: String,
    pub projects: Vec<String>,
}

pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut iter = args.iter();
    let id = iter.next().ok_or("which connector?")?.clone();
    if !catalog::valid_id(&id) {
        return Err(format!("{id:?} isn't a connector id"));
    }
    let (mut mono, mut projects) = (None, Vec::new());
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--mono" => mono = Some(iter.next().ok_or("--mono needs an id")?.clone()),
            "--project" => projects.push(iter.next().ok_or("--project needs a key")?.clone()),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let mono = mono.ok_or("--mono is required: a connector always runs for one Mono")?;
    if !settings::valid_mono_id(&mono) || !projects.iter().all(|p| settings::valid_scope(p)) {
        return Err("bad --mono or --project".into());
    }
    Ok(Args { id, mono, projects })
}

/// What will be started, with the login filled in. `Debug` shows no values.
pub enum Plan {
    Remote {
        url: String,
        headers: Vec<(String, String)>,
    },
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
    Telegram {
        token: String,
    },
}

impl fmt::Debug for Plan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Plan::Remote { headers, .. } => write!(
                f,
                "Remote {{ headers: {:?} }}",
                headers.iter().map(|(k, _)| k).collect::<Vec<_>>()
            ),
            Plan::Stdio { command, args, env } => write!(
                f,
                "Stdio {{ command: {command:?}, args: {args:?}, env: {:?} }}",
                env.iter().map(|(k, _)| k).collect::<Vec<_>>()
            ),
            Plan::Telegram { .. } => f.write_str("Telegram"),
        }
    }
}

pub fn plan(entry: &Entry, login: &Login) -> Result<Plan, String> {
    let values = login.values();
    Ok(match &entry.launch {
        Launch::Remote { url, headers } => Plan::Remote {
            url: fill(url, &values)?,
            headers: headers
                .iter()
                .map(|(name, value)| Ok((name.clone(), fill(value, &values)?)))
                .collect::<Result<_, String>>()?,
        },
        Launch::Stdio { command, args, env } => Plan::Stdio {
            command: command.clone(),
            // Arguments are literals (the catalog test refuses placeholders in them): no secret on a command line.
            args: args.clone(),
            env: env
                .iter()
                .map(|(name, value)| Ok((name.clone(), fill(value, &values)?)))
                .collect::<Result<_, String>>()?,
        },
        Launch::Builtin { server } if server == "telegram" => Plan::Telegram {
            token: values
                .get("token")
                .cloned()
                .ok_or("The login has no token. Sign in again.")?,
        },
        Launch::Builtin { server } => return Err(format!("No built-in server called {server}.")),
    })
}

/// The data folder of this copy (the daily app's, or a dev slot's): the same rule Tauri uses.
pub fn data_dir() -> Result<PathBuf, String> {
    crate::instance::data_dir(&crate::instance::current().identifier)
        .ok_or_else(|| "There is no home folder.".to_string())
}

/// Everything before the server starts. Refuses unless allowed; renews an expiring OAuth token and keeps the new one.
pub fn prepare(
    args: &Args,
    dir: &Path,
    store: &dyn SecretStore,
) -> Result<(&'static Entry, Login, Plan), String> {
    let entry =
        catalog::entry(&args.id).ok_or_else(|| format!("No connector called {}.", args.id))?;
    let settings = settings::load(dir);
    settings::allowed(&settings, entry, &args.mono, &args.projects)
        .map_err(|denied| denied.message(&entry.name))?;
    let mut login = if entry.needs_login() {
        store.get(&entry.id)?.ok_or_else(|| {
            format!(
                "{} isn't signed in on this Mac. Sign in under Settings > Connectors.",
                entry.name
            )
        })?
    } else {
        Login::default()
    };
    if let Some(tokens) = login.oauth.as_ref().filter(|t| oauth::expiring(t)) {
        let renewed = oauth::refresh(tokens).map_err(|why| redact(&why, &login.secrets()))?;
        login.oauth = Some(renewed);
        store.put(&entry.id, &login)?;
    }
    let plan = plan(entry, &login)?;
    Ok((entry, login, plan))
}

/// Renews an OAuth login when the server says it expired, keeps it, and hands back the new headers.
fn refresher(
    entry: &'static Entry,
    login: Login,
    store: Arc<dyn SecretStore>,
) -> Option<Refresher> {
    login.oauth.as_ref()?;
    let login = Arc::new(Mutex::new(login));
    Some(Arc::new(move || {
        let mut login = login.lock().unwrap();
        let tokens = login.oauth.clone().ok_or("no OAuth login")?;
        let renewed = oauth::refresh(&tokens)?;
        login.oauth = Some(renewed);
        store.put(&entry.id, &login)?;
        match plan(entry, &login)? {
            Plan::Remote { headers, .. } => Ok(headers),
            _ => Err("not a hosted server".into()),
        }
    }))
}

pub fn run_main(args: &[String]) -> i32 {
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(why) => {
            eprintln!("usage: monocode {SUBCOMMAND} <connector id> --mono <mono id> [--project <key>]… ({why})");
            return 2;
        }
    };
    let dir = match data_dir() {
        Ok(dir) => dir,
        Err(why) => {
            eprintln!("monocode connector {}: {why}", parsed.id);
            return EXIT_REFUSED;
        }
    };
    let store: Arc<dyn SecretStore> = Arc::new(Keychain);
    let (entry, login, plan) = match prepare(&parsed, &dir, store.as_ref()) {
        Ok(ready) => ready,
        Err(why) => {
            eprintln!("monocode connector {}: {why}", parsed.id);
            return EXIT_REFUSED;
        }
    };
    let secrets = login.secrets();
    let id = entry.id.clone();
    let log: Log =
        Arc::new(move |line| eprintln!("[monocode connector {id}] {}", redact(line, &secrets)));
    match plan {
        Plan::Remote { url, headers } => {
            let bridge = Bridge {
                remote: Arc::new(Remote::new(url, headers)),
                refresh: refresher(entry, login, store),
                log,
            };
            let stdin = std::io::stdin();
            bridge.run(stdin.lock(), Arc::new(Mutex::new(std::io::stdout())));
            0
        }
        Plan::Telegram { token } => {
            let stdin = std::io::stdin();
            Telegram::new(token).serve(stdin.lock(), std::io::stdout());
            0
        }
        Plan::Stdio { command, args, env } => exec_stdio(entry, &command, &args, env, &log),
    }
}

/// `command` on PATH, or `None`.
pub fn find_on_path(command: &str) -> Option<PathBuf> {
    if command.contains('/') {
        let path = PathBuf::from(command);
        return path.is_file().then_some(path);
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(command))
            .find(|candidate| candidate.is_file())
    })
}

/// Replace this process with the local server, its login in the server's environment only.
fn exec_stdio(
    entry: &Entry,
    command: &str,
    args: &[String],
    env: Vec<(String, String)>,
    log: &Log,
) -> i32 {
    let Some(program) = find_on_path(command) else {
        log(&format!(
            "{command} isn't installed on this Mac, and {} needs it.",
            entry.name
        ));
        return EXIT_REFUSED;
    };
    let mut child = std::process::Command::new(program);
    child.args(args).envs(env);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = child.exec();
        log(&format!("couldn't start {command}: {}", error.kind()));
        1
    }
    #[cfg(not(unix))]
    {
        match child.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                log(&format!("couldn't start {command}: {}", error.kind()));
                1
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::catalog::Method;
    use super::super::secrets::Memory;
    use super::super::settings::{ConnectorState, MonoChoice, Settings, EVERYWHERE};
    use super::*;
    use std::collections::BTreeMap;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mc-launch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn arguments_name_the_connector_the_mono_and_its_projects() {
        assert_eq!(
            parse_args(&args(&[
                "github",
                "--mono",
                "mono-1",
                "--project",
                "/p/a",
                "--project",
                "/p/b"
            ]))
            .unwrap(),
            Args {
                id: "github".into(),
                mono: "mono-1".into(),
                projects: vec!["/p/a".into(), "/p/b".into()]
            }
        );
        assert!(
            parse_args(&args(&["github"])).is_err(),
            "a connector always runs for a Mono"
        );
        assert!(parse_args(&args(&["../x", "--mono", "m"])).is_err());
        assert!(parse_args(&args(&["github", "--mono", "m", "--token", "x"])).is_err());
    }

    #[test]
    fn a_local_server_gets_its_login_only_in_its_environment() {
        let slack = catalog::entry("slack").unwrap();
        let login = Login {
            fields: BTreeMap::from([("token".into(), "xoxp-SENTINEL".into())]),
            oauth: None,
        };
        let Plan::Stdio { command, args, env } = plan(slack, &login).unwrap() else {
            panic!()
        };
        assert_eq!(command, "npx");
        assert!(
            !args.iter().any(|a| a.contains("SENTINEL")),
            "argv: {args:?}"
        );
        assert_eq!(
            env,
            vec![(
                "SLACK_MCP_XOXP_TOKEN".to_string(),
                "xoxp-SENTINEL".to_string()
            )]
        );
        let shown = format!("{:?}", plan(slack, &login).unwrap());
        assert!(!shown.contains("SENTINEL"), "{shown}");
    }

    #[test]
    fn prepare_refuses_until_allowed_and_signed_in() {
        let dir = temp_dir();
        let store = Memory::default();
        let a = Args {
            id: "github".into(),
            mono: "m1".into(),
            projects: vec!["/p/hivra".into()],
        };
        assert!(prepare(&a, &dir, &store)
            .unwrap_err()
            .contains("isn't signed in"));

        let mut s = Settings::default();
        s.connectors.insert(
            "github".into(),
            ConnectorState {
                signed_in: true,
                method: Some(Method::Token),
                allow: vec!["/p/nibbii".into()],
                ..Default::default()
            },
        );
        settings::save(&dir, &s).unwrap();
        let err = prepare(&a, &dir, &store).unwrap_err();
        assert!(err.contains("off for the project /p/hivra"), "{err}");

        s.connectors.get_mut("github").unwrap().allow = vec!["/p/hivra".into()];
        settings::save(&dir, &s).unwrap();
        // Allowed, but the Keychain has nothing (signed out elsewhere): still refused.
        assert!(prepare(&a, &dir, &store)
            .unwrap_err()
            .contains("isn't signed in on this Mac"));

        store
            .put(
                "github",
                &Login {
                    fields: BTreeMap::from([("token".into(), "ghp_SENTINEL".into())]),
                    oauth: None,
                },
            )
            .unwrap();
        let (_, _, plan) = prepare(&a, &dir, &store).unwrap();
        let Plan::Remote { headers, .. } = plan else {
            panic!()
        };
        assert_eq!(
            headers,
            vec![(
                "Authorization".to_string(),
                "Bearer ghp_SENTINEL".to_string()
            )]
        );

        // This Mono turned it off: refused even though the project allows it.
        s.monos.insert(
            "m1".into(),
            MonoChoice::All {
                except: vec!["github".into()],
            },
        );
        settings::save(&dir, &s).unwrap();
        assert!(prepare(&a, &dir, &store)
            .unwrap_err()
            .contains("off for this Mono"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_no_login_connector_needs_no_keychain_item() {
        let dir = temp_dir();
        let mut s = Settings::default();
        s.connectors.insert(
            "context7".into(),
            ConnectorState {
                signed_in: true,
                method: Some(Method::None),
                allow: vec![EVERYWHERE.into()],
                ..Default::default()
            },
        );
        settings::save(&dir, &s).unwrap();
        let a = Args {
            id: "context7".into(),
            mono: "m".into(),
            projects: vec![],
        };
        let (_, login, plan) = prepare(&a, &dir, &Memory::default()).unwrap();
        assert!(login.secrets().is_empty());
        assert!(
            matches!(plan, Plan::Remote { ref url, .. } if url == "https://mcp.context7.com/mcp")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn telegram_runs_built_in() {
        let telegram = catalog::entry("telegram").unwrap();
        let login = Login {
            fields: BTreeMap::from([("token".into(), "1:ABC".into())]),
            oauth: None,
        };
        assert!(
            matches!(plan(telegram, &login).unwrap(), Plan::Telegram { token } if token == "1:ABC")
        );
    }
}
