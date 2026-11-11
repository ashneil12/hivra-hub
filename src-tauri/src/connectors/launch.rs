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
    prepare_with_vault(args, dir, store, crate::secrets::store::active())
}

/// WP-92: a saved login field may name a vault entry (`{"secret": "<name>"}`) instead of holding a copy, and this fills
/// the value in at launch. The value is read through the same scope a chat uses, so a rotation reaches every connector
/// that references the key. `prepare` is this with the copy's own vault; tests pass a memory one.
pub fn prepare_with_vault(
    args: &Args,
    dir: &Path,
    store: &dyn SecretStore,
    vault: &dyn crate::secrets::Vault,
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
    let settings = settings::load(dir)?;
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
            .map_err(|failure| redact(&failure.message(), &login.secrets()))?;
    }
    // A saved key never stands in for a server address the person typed: that would send the key to a host outside the
    // catalog. Such a login must hold its own copy, or the key stays out of the connector.
    if !login.refs.is_empty() && sends_to_a_typed_url(entry) {
        return Err(format!(
            "{} sends its key to a server URL you typed, so a key saved under Settings > Secrets can't be used for it. Paste the key into the connector instead.",
            entry.name
        ));
    }
    fill_from_vault(&mut login, dir, &args.projects, vault)?;
    let plan = plan(entry, &login)?;
    Ok((entry, login, plan))
}

/// A remote connector whose server address is a field the person types (`{mcp_url}`), not a fixed host.
fn sends_to_a_typed_url(entry: &Entry) -> bool {
    matches!(&entry.launch, Launch::Remote { url, .. } if url.contains('{'))
}

/// WP-92: turn every `{"secret": "<name>"}` field into its value, from the project's own scope first, then global.
/// Nothing is written: a launch only reads. A key with no value yet is a plain sentence, never a Keychain prompt.
fn fill_from_vault(
    login: &mut Login,
    dir: &Path,
    projects: &[String],
    vault: &dyn crate::secrets::Vault,
) -> Result<(), String> {
    if login.refs.is_empty() {
        return Ok(());
    }
    let conn = rusqlite::Connection::open_with_flags(
        dir.join("monocode.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "Couldn't read your saved keys.".to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    for (field, name) in std::mem::take(&mut login.refs) {
        let name = crate::secrets::normalize_name(&name)?;
        let mut row = None;
        for project in projects {
            row =
                crate::secrets::get_secret(&conn, &crate::secrets::scope_for(Some(project)), &name)
                    .map_err(|_| "Couldn't read your saved keys.".to_string())?;
            if row.is_some() {
                break;
            }
        }
        let row = match row {
            Some(row) => Some(row),
            None => crate::secrets::get_secret(&conn, crate::secrets::SCOPE_GLOBAL, &name)
                .map_err(|_| "Couldn't read your saved keys.".to_string())?,
        };
        let Some(row) = row else {
            return Err(format!(
                "The key {name} isn't saved any more. Add it under Settings > Secrets."
            ));
        };
        if row.version <= 0 {
            return Err(format!(
                "The key {name} has no value yet. Add it under Settings > Secrets."
            ));
        }
        let value = crate::secrets::read_value(vault, &row.scope, &row.name)?;
        login.fields.insert(field, value.to_string());
    }
    Ok(())
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
            _ => Err(renew::Failure::Failed("not a hosted server".into())),
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

/// The system part of where a local server's program is looked for, and the PATH it runs with: never the caller's.
#[cfg(not(windows))]
/// Fix round 4 (N3): the folders the system owns come first, so a program of the same name in a folder the account writes
/// never shadows one of them. Homebrew and /usr/local come after.
pub const SAFE_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

/// [`SAFE_PATH`] plus the account's own `~/.local/bin` (where uvx installs), taken from the user database so a caller's
/// HOME can't point it anywhere else.
#[cfg(not(windows))]
pub fn safe_path() -> String {
    match crate::instance::real_home() {
        Some(home) => format!("{SAFE_PATH}:{}", home.join(".local/bin").display()),
        None => SAFE_PATH.to_string(),
    }
}

/// Windows' own folders, Node's, Git for Windows' `cmd` (git and gh children such as treehouse and no-mistakes run
/// git themselves) and the account's `.local\bin` (uvx) and `npm` (npx-installed tools), joined with `;`. The profile
/// comes from Windows itself ([`crate::instance::real_home`]), never from the caller's HOME.
#[cfg(windows)]
pub fn safe_path() -> String {
    let system = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let programs = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let mut dirs = vec![
        system.join("System32"),
        system.clone(),
        system.join(r"System32\WindowsPowerShell\v1.0"),
        programs.join("nodejs"),
        programs.join(r"Git\cmd"),
    ];
    if let Some(home) = crate::instance::real_home() {
        dirs.push(home.join(r".local\bin"));
        dirs.push(home.join(r"AppData\Roaming\npm"));
    }
    std::env::join_paths(dirs)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// All a local server gets from the caller's environment, besides [`safe_path`] and its own login.
#[cfg(not(windows))]
const PASSED_ENV: &[&str] = &["HOME", "USER", "LANG", "TMPDIR"];
/// The same on Windows, plus what Windows programs (Node among them) can't start without.
#[cfg(windows)]
const PASSED_ENV: &[&str] = &[
    "HOME",
    "USERNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
];

/// `command` on [`safe_path`] (a full path is taken as it is), or `None`. On Windows a bare name also matches its
/// `.exe`, `.cmd` or `.bat` (`npx` is `npx.cmd`).
pub fn find_on_path(command: &str) -> Option<PathBuf> {
    if command.contains('/') || (cfg!(windows) && command.contains('\\')) {
        let path = PathBuf::from(command);
        return path.is_file().then_some(path);
    }
    let names: Vec<String> = if cfg!(windows) && Path::new(command).extension().is_none() {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| format!("{command}.{ext}"))
            .collect()
    } else {
        vec![command.to_string()]
    };
    std::env::split_paths(&safe_path()).find_map(|dir| {
        names
            .iter()
            .map(|name| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

/// How a local server is started: `program` with its arguments, an environment cleared down to [`PASSED_ENV`] and
/// [`safe_path`] (so a caller's NODE_OPTIONS, PATH or npm settings never reach it), and its login.
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
    child.env("PATH", safe_path()).envs(env.iter().cloned());
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
            refs: BTreeMap::new(),
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
                    refs: BTreeMap::new(),
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

    /// WP-92: a saved login may point at the vault (`{"secret": "<name>"}`); the launch fills the value in, and a
    /// rotation reaches the connector without the login being rewritten.
    #[test]
    fn a_login_that_points_at_the_vault_is_filled_at_launch() {
        let dir = temp_dir();
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
        let vault = crate::secrets::store::Memory::new();
        let project_scope = crate::secrets::scope_for(Some("/p/hivra"));
        let db = rusqlite::Connection::open(dir.join("monocode.db")).unwrap();
        crate::secrets::ensure_tables(&db).unwrap();
        crate::secrets::save_value(
            &vault,
            &db,
            crate::secrets::SCOPE_GLOBAL,
            "github-token",
            Some("GitHub token"),
            "ghp_GLOBAL_SENTINEL",
            1_000,
        )
        .unwrap();
        crate::secrets::save_value(
            &vault,
            &db,
            &project_scope,
            "github-token",
            Some("GitHub token"),
            "ghp_PROJECT_SENTINEL",
            1_000,
        )
        .unwrap();
        drop(db);

        let store = Memory::default();
        store
            .put(
                "github",
                &Login {
                    fields: BTreeMap::new(),
                    refs: BTreeMap::from([("token".into(), "github-token".into())]),
                    oauth: None,
                },
            )
            .unwrap();
        let a = signed(&store, "github", "m", &["/p/hivra"]);
        // The chat's project scope wins over global, as it does for a chat.
        let (_, login, plan) = prepare_with_vault(&a, &dir, &store, &vault).unwrap();
        let Plan::Remote { headers, .. } = plan else {
            panic!()
        };
        assert_eq!(
            headers,
            vec![(
                "Authorization".to_string(),
                "Bearer ghp_PROJECT_SENTINEL".to_string()
            )]
        );
        assert!(!format!("{login:?}").contains("PROJECT_SENTINEL"));

        // A rotation is seen at the next launch; the saved login still holds the reference, never a copy.
        let db = rusqlite::Connection::open(dir.join("monocode.db")).unwrap();
        crate::secrets::save_value(
            &vault,
            &db,
            &project_scope,
            "github-token",
            Some("GitHub token"),
            "ghp_ROTATED_SENTINEL",
            2_000,
        )
        .unwrap();
        drop(db);
        let stored = store.get("github").unwrap().unwrap();
        assert_eq!(stored.refs["token"], "github-token");
        assert!(stored.fields.is_empty(), "a reference stays a reference");
        let (_, _, plan) = prepare_with_vault(&a, &dir, &store, &vault).unwrap();
        let Plan::Remote { headers, .. } = plan else {
            panic!()
        };
        assert!(headers
            .iter()
            .any(|(_, value)| value == "Bearer ghp_ROTATED_SENTINEL"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// WP-92 hard rule: a Keychain key is never sent to a server URL the person typed. Zapier's URL is a typed field
    /// (`{mcp_url}`), so a saved key may not stand in for it, and nothing is read from the vault for that launch.
    #[test]
    fn a_saved_key_is_never_sent_to_a_url_the_person_typed() {
        let dir = temp_dir();
        let mut s = Settings::default();
        s.connectors.insert(
            "zapier".into(),
            ConnectorState {
                signed_in: true,
                method: Some(Method::Token),
                allow: vec![EVERYWHERE.into()],
                ..Default::default()
            },
        );
        settings::save(&dir, &s).unwrap();
        let vault = crate::secrets::store::Memory::new();
        let db = rusqlite::Connection::open(dir.join("monocode.db")).unwrap();
        crate::secrets::ensure_tables(&db).unwrap();
        crate::secrets::save_value(
            &vault,
            &db,
            crate::secrets::SCOPE_GLOBAL,
            "zapier-url",
            Some("Zapier URL"),
            "https://mcp.zapier.com/api/mcp/SENTINEL_TYPED_URL",
            1_000,
        )
        .unwrap();
        drop(db);
        let store = Memory::default();
        store
            .put(
                "zapier",
                &Login {
                    fields: BTreeMap::new(),
                    refs: BTreeMap::from([("mcp_url".into(), "zapier-url".into())]),
                    oauth: None,
                },
            )
            .unwrap();
        let a = signed(&store, "zapier", "m", &["/p/hivra"]);
        let err = prepare_with_vault(&a, &dir, &store, &vault).unwrap_err();
        assert!(err.contains("typed"), "{err}");
        assert!(!err.contains("SENTINEL"), "{err}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_reference_that_is_gone_or_has_no_value_is_a_plain_sentence() {
        let dir = temp_dir();
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
        let vault = crate::secrets::store::Memory::new();
        let db = rusqlite::Connection::open(dir.join("monocode.db")).unwrap();
        crate::secrets::ensure_tables(&db).unwrap();
        drop(db);
        let store = Memory::default();
        store
            .put(
                "github",
                &Login {
                    fields: BTreeMap::new(),
                    refs: BTreeMap::from([("token".into(), "gone-key".into())]),
                    oauth: None,
                },
            )
            .unwrap();
        let a = signed(&store, "github", "m", &[]);
        let err = prepare_with_vault(&a, &dir, &store, &vault).unwrap_err();
        assert!(err.contains("gone-key isn't saved any more"), "{err}");

        // An imported row is listed but unusable until the person types its value.
        let db = rusqlite::Connection::open(dir.join("monocode.db")).unwrap();
        crate::secrets::import_index(
            &db,
            &serde_json::json!({"secrets": [{
                "name": "gone-key",
                "scope": "global",
                "label": "GitHub token",
                "last4": "7890",
                "createdAt": 1_000,
            }]}),
            1_000,
        )
        .unwrap();
        drop(db);
        let err = prepare_with_vault(&a, &dir, &store, &vault).unwrap_err();
        assert!(err.contains("has no value yet"), "{err}");
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
            refs: BTreeMap::new(),
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
        let mut allowed: Vec<&str> = PASSED_ENV.to_vec();
        allowed.extend(["PATH", "SLACK_MCP_XOXP_TOKEN"]);
        // Windows names are case-insensitive (`Path`, `SYSTEMROOT`), so compare them the way Windows does.
        let allowed_key = |key: &str| allowed.iter().any(|a| a.eq_ignore_ascii_case(key));
        assert!(
            std::env::vars().any(|(key, _)| !allowed_key(&key)),
            "the test process has more in its environment than a server may get"
        );
        // Something that prints the environment it was given: `env`, or `cmd /c set` on Windows.
        #[cfg(not(windows))]
        let (program, args) = (find_on_path("env").unwrap(), Vec::<String>::new());
        #[cfg(windows)]
        let (program, args) = (
            find_on_path("cmd").unwrap(),
            vec!["/d".to_string(), "/c".to_string(), "set".to_string()],
        );
        let output = stdio_command(
            &program,
            &args,
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
            .map(|(k, v)| (k.to_ascii_uppercase(), v.to_string()))
            .collect();
        for key in seen.keys() {
            // cmd sets PROMPT for itself when it starts; it never came from the caller.
            if cfg!(windows) && key == "PROMPT" {
                continue;
            }
            assert!(allowed_key(key), "{key} reached the server");
        }
        assert_eq!(seen["PATH"], safe_path());
        assert_eq!(seen["SLACK_MCP_XOXP_TOKEN"], "xoxp-SENTINEL");
        let home = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        assert!(seen.get(home).is_some_and(|home| !home.is_empty()));
        #[cfg(not(windows))]
        {
            assert_eq!(
                SAFE_PATH,
                "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
            );
            assert_eq!(find_on_path("env"), Some(PathBuf::from("/usr/bin/env")));
        }
        #[cfg(windows)]
        {
            let found = find_on_path("cmd").unwrap();
            assert!(found.ends_with(r"System32\cmd.exe"), "{}", found.display());
        }
    }

    #[test]
    fn the_accounts_own_local_bin_is_on_the_path_never_the_callers_home() {
        // uvx installs to ~/.local/bin; that folder comes from the user database (Windows: the profile known
        // folder), so a caller's HOME can't move it.
        let own = crate::instance::real_home().expect("a home folder from the system");
        let path = safe_path();
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        #[cfg(not(windows))]
        {
            assert!(path.starts_with(SAFE_PATH), "{path}");
            assert!(
                path.ends_with(&format!(":{}", own.join(".local/bin").display())),
                "{path}"
            );
        }
        assert!(dirs.contains(&own.join(".local").join("bin")), "{path}");
        assert!(!path.contains("/tmp"), "{path}");
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

    /// Ash signs out while a session's bridge runs: its next renewal stops it, and never puts the login back.
    #[test]
    fn a_bridge_signed_out_under_it_stops_and_never_brings_the_login_back() {
        use super::super::oauth::tests::{rotating_login, rotating_token_endpoint};
        let (token_url, sent) = rotating_token_endpoint(std::time::Duration::ZERO);
        let dir = temp_dir();
        let entry = catalog::entry("notion").unwrap();
        let store: Arc<dyn SecretStore> = Arc::new(Memory::default());
        let started = rotating_login(&token_url, oauth::now() + 3600);
        store.put("notion", &started).unwrap();
        let bridge_refresh = refresher(entry, started, Arc::clone(&store), dir.clone()).unwrap();
        // Settings > Connectors > Sign out.
        store.remove("notion").unwrap();
        assert_eq!(bridge_refresh(), Err(renew::Failure::SignedOut));
        assert_eq!(store.get("notion").unwrap(), None, "the login came back");
        assert!(sent.lock().unwrap().is_empty(), "a refresh token was spent");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn telegram_runs_built_in() {
        let telegram = catalog::entry("telegram").unwrap();
        let login = Login {
            fields: BTreeMap::from([("token".into(), "1:ABC".into())]),
            refs: BTreeMap::new(),
            oauth: None,
        };
        assert!(
            matches!(plan(telegram, &login).unwrap(), Plan::Telegram { token } if token == "1:ABC")
        );
    }
}
