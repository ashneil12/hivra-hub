//! `monocode connector-run <id> --mono <mono id> [--project <project key>]…`: how a Claude Code session starts a
//! connector.
//!
//! The app gives a Mono's session `--mcp-config` entries that point here, with no login in them and signed by the app
//! (signing.rs). At launch this:
//! 1. refuses arguments the app didn't sign, then reads `connectors.json` again and refuses unless this Mono, in these
//!    projects, may use the connector;
//! 2. reads the login from the Keychain (renewing an expiring OAuth token);
//! 3. serves the connector: a hosted server through the stdio bridge (login in this process's memory only), a local
//!    server (found on a fixed PATH, with a cleared environment) with the login in its environment only, or a built-in
//!    server.
//!
//! Nothing it prints carries a secret: every line goes through `redact`.

use super::bridge::{Bridge, Log, Refresher};
use super::builtin::Telegram;
use super::catalog::{self, fill, Entry, Launch};
use super::oauth;
use super::remote::Remote;
use super::renew;
use super::secrets::{redact, Keychain, Login, SecretStore};
use super::settings;
use super::signing;
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
    /// The app's signature over the rest (signing.rs).
    pub sig: Option<String>,
}

pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut iter = args.iter();
    let id = iter.next().ok_or("which connector?")?.clone();
    if !catalog::valid_id(&id) {
        return Err(format!("{id:?} isn't a connector id"));
    }
    let (mut mono, mut projects, mut sig) = (None, Vec::new(), None);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--mono" => mono = Some(iter.next().ok_or("--mono needs an id")?.clone()),
            "--project" => projects.push(iter.next().ok_or("--project needs a key")?.clone()),
            signing::FLAG => sig = Some(iter.next().ok_or("--sig needs a value")?.clone()),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let mono = mono.ok_or("--mono is required: a connector always runs for one Mono")?;
    if !settings::valid_mono_id(&mono) || !projects.iter().all(|p| settings::valid_scope(p)) {
        return Err("bad --mono or --project".into());
    }
    Ok(Args {
        id,
        mono,
        projects,
        sig,
    })
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
    // Only a session the app started, for this Mono and these projects (signing.rs).
    signing::check(
        store,
        &args.id,
        &args.mono,
        &args.projects,
        args.sig.as_deref(),
    )?;
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
    if login.oauth.as_ref().is_some_and(oauth::expiring) {
        // Another session may be renewing the same login right now (renew.rs).
        login = renew::renew(dir, store, &entry.id, &login)
            .map_err(|why| redact(&why, &login.secrets()))?;
    }
    let plan = plan(entry, &login)?;
    Ok((entry, login, plan))
}

/// Renews an OAuth login when the server says it expired, keeps it, and hands back the new headers.
fn refresher(
    entry: &'static Entry,
    login: Login,
    store: Arc<dyn SecretStore>,
    dir: PathBuf,
) -> Option<Refresher> {
    login.oauth.as_ref()?;
    let login = Arc::new(Mutex::new(login));
    Some(Arc::new(move || {
        let mut login = login.lock().unwrap();
        // The renewal another session already made, or a new one (renew.rs).
        *login = renew::renew(&dir, store.as_ref(), &entry.id, &login)?;
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
            eprintln!("usage: monocode {SUBCOMMAND} <connector id> --mono <mono id> [--project <key>]… --sig <app signature> ({why})");
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
                refresh: refresher(entry, login, store, dir.clone()),
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

/// Where a local server's program is looked for, and the PATH it runs with: never the caller's.
pub const SAFE_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
/// All a local server gets from the caller's environment, besides [`SAFE_PATH`] and its own login.
const PASSED_ENV: [&str; 4] = ["HOME", "USER", "LANG", "TMPDIR"];

/// `command` on [`SAFE_PATH`] (a full path is taken as it is), or `None`.
pub fn find_on_path(command: &str) -> Option<PathBuf> {
    if command.contains('/') {
        let path = PathBuf::from(command);
        return path.is_file().then_some(path);
    }
    std::env::split_paths(SAFE_PATH)
        .map(|dir| dir.join(command))
        .find(|candidate| candidate.is_file())
}

/// How a local server is started: `program` with its arguments, an environment cleared down to [`PASSED_ENV`] and
/// [`SAFE_PATH`] (so a caller's NODE_OPTIONS, PATH or npm settings never reach it), and its login.
pub fn stdio_command(
    program: &Path,
    args: &[String],
    env: &[(String, String)],
) -> std::process::Command {
    let mut child = std::process::Command::new(program);
    child.args(args).env_clear();
    for key in PASSED_ENV {
        if let Some(value) = std::env::var_os(key) {
            child.env(key, value);
        }
    }
    child.env("PATH", SAFE_PATH).envs(env.iter().cloned());
    child
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
    let mut child = stdio_command(&program, args, &env);
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
pub(crate) mod tests {
    use super::super::catalog::Method;
    use super::super::secrets::Memory;
    use super::super::settings::{ConnectorState, MonoChoice, Settings, EVERYWHERE};
    use super::*;
    use std::collections::BTreeMap;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// What a session the app started passes: the arguments, signed with the store's key (made if needed).
    pub(crate) fn signed(store: &dyn SecretStore, id: &str, mono: &str, projects: &[&str]) -> Args {
        let projects: Vec<String> = projects.iter().map(|p| p.to_string()).collect();
        let key = signing::key(store, true).unwrap().unwrap();
        Args {
            sig: Some(signing::sign(&key, id, mono, &projects)),
            id: id.into(),
            mono: mono.into(),
            projects,
        }
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
                projects: vec!["/p/a".into(), "/p/b".into()],
                sig: None,
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
        let a = signed(&store, "github", "m1", &["/p/hivra"]);
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
        let store = Memory::default();
        let a = signed(&store, "context7", "m", &[]);
        let (_, login, plan) = prepare(&a, &dir, &store).unwrap();
        assert!(login.secrets().is_empty());
        assert!(
            matches!(plan, Plan::Remote { ref url, .. } if url == "https://mcp.context7.com/mcp")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Any shell on this Mac can run the app's binary. Naming another Mono, or projects it doesn't have, gets nothing.
    #[test]
    fn a_launch_the_app_did_not_sign_is_refused() {
        let dir = temp_dir();
        let store = Memory::default();
        let mut s = Settings::default();
        s.connectors.insert(
            "github".into(),
            ConnectorState {
                signed_in: true,
                method: Some(Method::Token),
                allow: vec![EVERYWHERE.into()],
                ..Default::default()
            },
        );
        settings::save(&dir, &s).unwrap();
        let login = Login {
            fields: BTreeMap::from([("token".into(), "ghp_SENTINEL".into())]),
            oauth: None,
        };
        store.put("github", &login).unwrap();
        // The app's own session for Mono m starts it.
        let mine = signed(&store, "github", "m", &["/p/hivra"]);
        assert!(prepare(&mine, &dir, &store).is_ok());
        // What a shell would type: another Mono, no signature.
        let bare = parse_args(&args(&[
            "github",
            "--mono",
            "other",
            "--project",
            "/p/hivra",
        ]))
        .unwrap();
        let err = prepare(&bare, &dir, &store).unwrap_err();
        assert!(err.contains("didn't start this connector"), "{err}");
        // The app's real signature, moved to another Mono or other projects.
        let sig = mine.sig.clone().unwrap();
        for (mono, projects) in [
            ("other", vec!["/p/hivra"]),
            ("m", vec!["/p/nibbii"]),
            ("m", vec![]),
            ("m", vec!["/p/hivra", "/p/x"]),
        ] {
            let mut argv = vec!["github", "--mono", mono];
            for project in &projects {
                argv.extend(["--project", project]);
            }
            argv.extend(["--sig", &sig]);
            let moved = parse_args(&args(&argv)).unwrap();
            let err = prepare(&moved, &dir, &store).unwrap_err();
            assert!(err.contains("didn't start"), "{mono} {projects:?}: {err}");
        }
        for junk in ["", "zz", &sig[..sig.len() - 2], &format!("{sig}00")] {
            let forged = Args {
                sig: Some(junk.to_string()),
                ..signed(&store, "github", "m", &["/p/hivra"])
            };
            assert!(prepare(&forged, &dir, &store).is_err(), "{junk:?}");
        }
        // A Mac with no signing key refuses everything, and the launcher never makes one.
        let bare_store = Memory::default();
        bare_store.put("github", &login).unwrap();
        assert!(prepare(&mine, &dir, &bare_store)
            .unwrap_err()
            .contains("didn't start"));
        assert_eq!(signing::key(&bare_store, false).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The app signs its own connector entries in a session's --mcp-config, and nothing else.
    #[test]
    fn the_app_signs_exactly_its_own_connector_entries() {
        let store = Memory::default();
        let launcher = "/Applications/MonoCode Hub.app/Contents/MacOS/monocode";
        let config = serde_json::json!({"mcpServers": {
            "github": {"command": launcher, "args": [SUBCOMMAND, "github", "--mono", "m", "--project", "/p/hivra", "--sig", "forged"]},
            "monocode": {"command": launcher, "args": ["mcp"]},
            "other-program": {"command": "/tmp/not-the-app", "args": [SUBCOMMAND, "github", "--mono", "m"]},
        }});
        let argv = vec![
            "-p".to_string(),
            "--mcp-config".to_string(),
            config.to_string(),
            format!("--mcp-config={config}"),
        ];
        let mut reads = 0;
        let mut key = || {
            reads += 1;
            Ok(signing::key(&store, true)?.unwrap())
        };
        let out = signing::sign_mcp_configs(argv, launcher, &mut key).unwrap();
        assert_eq!(out[0], "-p");
        for raw in [
            out[2].as_str(),
            out[3].strip_prefix("--mcp-config=").unwrap(),
        ] {
            let value: serde_json::Value = serde_json::from_str(raw).unwrap();
            let words: Vec<String> = value["mcpServers"]["github"]["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w.as_str().unwrap().to_string())
                .collect();
            assert!(!words.contains(&"forged".to_string()), "{words:?}");
            let parsed = parse_args(&words[1..]).unwrap();
            assert_eq!(
                (parsed.mono.as_str(), parsed.projects.clone()),
                ("m", vec!["/p/hivra".to_string()])
            );
            assert!(signing::check(
                &store,
                &parsed.id,
                &parsed.mono,
                &parsed.projects,
                parsed.sig.as_deref()
            )
            .is_ok());
            assert_eq!(
                value["mcpServers"]["monocode"],
                config["mcpServers"]["monocode"]
            );
            // An entry for another program never gets a signature it could replay.
            assert_eq!(
                value["mcpServers"]["other-program"],
                config["mcpServers"]["other-program"]
            );
        }
        // A session with no connector entry never touches the key.
        let mut untouched = 0;
        let plain = vec![
            "--mcp-config".to_string(),
            r#"{"mcpServers":{}}"#.to_string(),
        ];
        let same = signing::sign_mcp_configs(plain.clone(), launcher, &mut || {
            untouched += 1;
            Err("no key".into())
        })
        .unwrap();
        assert_eq!((same, untouched), (plain, 0));
    }

    /// A local server starts with nothing from the caller's environment but a few plain variables, and is found on a
    /// fixed PATH: a caller's NODE_OPTIONS or PATH can't reach it.
    #[test]
    fn a_local_server_gets_a_clean_environment_and_a_fixed_path() {
        let allowed = [
            "HOME",
            "USER",
            "LANG",
            "TMPDIR",
            "PATH",
            "SLACK_MCP_XOXP_TOKEN",
        ];
        assert!(
            std::env::vars().any(|(key, _)| !allowed.contains(&key.as_str())),
            "the test process has more in its environment than a server may get"
        );
        let output = stdio_command(
            Path::new("/usr/bin/env"),
            &[],
            &[(
                "SLACK_MCP_XOXP_TOKEN".to_string(),
                "xoxp-SENTINEL".to_string(),
            )],
        )
        .output()
        .unwrap();
        let seen: BTreeMap<String, String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        for key in seen.keys() {
            assert!(allowed.contains(&key.as_str()), "{key} reached the server");
        }
        assert_eq!(seen["PATH"], SAFE_PATH);
        assert_eq!(seen["SLACK_MCP_XOXP_TOKEN"], "xoxp-SENTINEL");
        assert!(seen.get("HOME").is_some_and(|home| !home.is_empty()));
        assert_eq!(SAFE_PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
        assert_eq!(find_on_path("env"), Some(PathBuf::from("/usr/bin/env")));
    }

    fn oauth_on_everywhere(dir: &Path, id: &str) {
        let mut s = Settings::default();
        s.connectors.insert(
            id.into(),
            ConnectorState {
                signed_in: true,
                method: Some(Method::Oauth),
                allow: vec![EVERYWHERE.into()],
                ..Default::default()
            },
        );
        settings::save(dir, &s).unwrap();
    }

    fn bearer(plan: &Plan) -> String {
        let Plan::Remote { headers, .. } = plan else {
            panic!("{plan:?}")
        };
        headers
            .iter()
            .find(|(name, _)| name == "Authorization")
            .map(|(_, value)| value.clone())
            .unwrap()
    }

    /// Two sessions start the same connector at once with an expired login. The provider rotates refresh tokens (each
    /// works once): only one launch may spend it, and the other must take what that one got.
    #[test]
    fn two_launches_renew_an_expired_login_once() {
        use super::super::oauth::tests::{rotating_login, rotating_token_endpoint};
        let (token_url, sent) = rotating_token_endpoint(std::time::Duration::from_millis(300));
        let dir = temp_dir();
        oauth_on_everywhere(&dir, "notion");
        let store = Arc::new(Memory::default());
        store.put("notion", &rotating_login(&token_url, 1)).unwrap();
        let args = Arc::new(signed(store.as_ref(), "notion", "m", &[]));
        let start = Arc::new(std::sync::Barrier::new(2));
        let launches: Vec<_> = (0..2)
            .map(|_| {
                let (dir, store, args, start) = (
                    dir.clone(),
                    Arc::clone(&store),
                    Arc::clone(&args),
                    Arc::clone(&start),
                );
                std::thread::spawn(move || {
                    start.wait();
                    prepare(&args, &dir, store.as_ref()).map(|(_, _, plan)| bearer(&plan))
                })
            })
            .collect();
        for launch in launches {
            assert_eq!(launch.join().unwrap(), Ok("Bearer ACCESS_1".to_string()));
        }
        assert_eq!(*sent.lock().unwrap(), vec!["REFRESH_0".to_string()]);
        let kept = store.get("notion").unwrap().unwrap().oauth.unwrap();
        assert_eq!(kept.refresh_token.as_deref(), Some("REFRESH_1"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A running bridge whose server says the token expired takes the renewal another session already made, instead of
    /// spending the refresh token that session already spent.
    #[test]
    fn a_bridge_takes_a_renewal_another_session_made() {
        use super::super::oauth::tests::{rotating_login, rotating_token_endpoint};
        let (token_url, sent) = rotating_token_endpoint(std::time::Duration::ZERO);
        let dir = temp_dir();
        let entry = catalog::entry("notion").unwrap();
        let store: Arc<dyn SecretStore> = Arc::new(Memory::default());
        let started = rotating_login(&token_url, oauth::now() + 3600);
        store.put("notion", &started).unwrap();
        let first = refresher(entry, started.clone(), Arc::clone(&store), dir.clone()).unwrap();
        let second = refresher(entry, started, Arc::clone(&store), dir.clone()).unwrap();
        let auth = |headers: Vec<(String, String)>| headers[0].1.clone();
        assert_eq!(first().map(auth), Ok("Bearer ACCESS_1".to_string()));
        assert_eq!(second().map(auth), Ok("Bearer ACCESS_1".to_string()));
        assert_eq!(*sent.lock().unwrap(), vec!["REFRESH_0".to_string()]);
        // Told again that ACCESS_1 expired, it really renews (with the refresh token now kept).
        assert_eq!(second().map(auth), Ok("Bearer ACCESS_2".to_string()));
        assert_eq!(
            *sent.lock().unwrap(),
            vec!["REFRESH_0".to_string(), "REFRESH_1".to_string()]
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
