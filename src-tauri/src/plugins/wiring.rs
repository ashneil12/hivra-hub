//! How an installed plugin reaches each agent CLI's session (WP-30 build step 4), and the `plugin-mcp` launcher every
//! plugin stdio server starts through.
//!
//! - **Skills.** Claude Code: `--plugin-dir <root>/claude/<name>` per plugin on for the session's folder (a plugin
//!   holding only the skills). Codex and the other CLIs that read `~/.agents/skills`: a link per skill there while
//!   the plugin is on everywhere (registry.rs). A plugin on for one project only reaches Claude Code.
//! - **MCP servers.** Added per session: Claude Code through the app's `--mcp-config`, Codex through `thread/start`'s
//!   `config` (`mcp_servers.<name>`). A stdio server runs as `<app> plugin-mcp …`, which checks the plugin is still
//!   on, then starts the plugin's own program with `PLUGIN_ROOT`, `PLUGIN_DATA` and its working folder (§7.2, §9) and
//!   none of the app's own connection variables. Remote servers go to the CLI as URLs.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::manifest::{load_plugin, Report};
use super::mcp::{launch_plan, McpServer, Transport};
use super::registry::{self, Host};

pub const SUBCOMMAND: &str = "plugin-mcp";

/// What one session gets from the plugins on for its folder.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Wiring {
    /// Each a `--plugin-dir` for Claude Code.
    pub claude_plugin_dirs: Vec<String>,
    /// `mcpServers` entries for Claude Code's `--mcp-config`.
    pub claude_mcp_servers: Map<String, Value>,
    /// `mcp_servers.<name>` entries for Codex's thread config.
    pub codex_mcp_servers: Map<String, Value>,
    pub reports: Vec<Report>,
}

/// The prefix every plugin server's session name starts with.
pub const NAME_PREFIX: &str = "plugin-";

/// The name a server goes by in a session: `plugin-<plugin>-<server>`, a plugin's periods turned into `_`. It never
/// holds `__` (plugin names can't hold `_`, server names can't hold `__`), because Claude Code splits tool names
/// (`mcp__<server>__<tool>`) on it: with `__` inside, every plugin's server would read as one server called `plugin`
/// for permission rules. The rare pair of plugin servers that map to one name (`a` + `b-c`, `a-b` + `c`) is caught
/// like any other taken name in `session_wiring`: the second is left out and reported.
pub fn native_name(plugin: &str, server: &str) -> String {
    format!("{NAME_PREFIX}{}-{server}", plugin.replace('.', "_"))
}

/// `taken` is every server name the person already has (crate::mcp::names_in_use): a plugin server with one of those
/// names is left out and reported, because Codex would merge its own entry with the person's (their token or env
/// reaching the plugin) and Claude would swap the person's entry for it.
pub fn session_wiring(
    host: &Host,
    cwd: Option<&Path>,
    cli: Option<&str>,
    taken: &BTreeSet<String>,
) -> Result<Wiring, String> {
    let registry = registry::read(host)?;
    let mut out = Wiring::default();
    for entry in registry.plugins.values() {
        if !entry.active_for(cwd) {
            continue;
        }
        let wanted: Vec<&str> = entry.mcp_servers().collect();
        if entry.claude_shim().is_none() && wanted.is_empty() {
            continue;
        }
        // Checked again for every session: the shim links the plugin's live folder, which the plugin's own server
        // could have changed since it was switched on.
        let loaded = match load_plugin(&host.installed(&entry.name)) {
            Ok(loaded) => loaded,
            Err(why) => {
                out.reports
                    .push(Report::new(&entry.name, format!("Not loaded: {why}")));
                continue;
            }
        };
        if let Some(shim) = entry.claude_shim() {
            let changed: Vec<&str> = entry
                .skills()
                .filter(|name| !loaded.skills.iter().any(|s| s.name == *name))
                .collect();
            if changed.is_empty() {
                out.claude_plugin_dirs.push(shim.to_string());
            } else {
                let mut message = format!(
                    "Its skills were left out of this session: {} no longer pass the check.",
                    changed.join(", ")
                );
                // Codex reads the link, not this session's wiring, so a skill that no longer passes is unlinked too.
                if entry.enabled.global {
                    match registry::unlink_skills(host, &entry.name, &changed) {
                        Ok(gone) if !gone.is_empty() => message.push_str(&format!(
                            " Removed from the skills folder: {}.",
                            gone.join(", ")
                        )),
                        Err(why) => message
                            .push_str(&format!(" The skills folder couldn't be updated: {why}.")),
                        Ok(_) => {}
                    }
                }
                out.reports.push(Report::new(&entry.name, message));
            }
        }
        for server in loaded
            .mcp_servers
            .iter()
            .filter(|s| wanted.contains(&s.name.as_str()))
        {
            let name = native_name(&entry.name, &server.name);
            if taken.contains(&name) || out.claude_mcp_servers.contains_key(&name) {
                out.reports.push(Report::new(
                    format!("{}/mcp.json", entry.name),
                    format!(
                        "Left out \"{}\": a server called \"{name}\" is already set up.",
                        server.name
                    ),
                ));
                continue;
            }
            let project = (!entry.enabled.global).then_some(cwd).flatten();
            match server_entries(host, &entry.name, server, cli, project) {
                Ok((claude, codex)) => {
                    out.claude_mcp_servers.insert(name.clone(), claude);
                    match codex {
                        Some(codex) => {
                            out.codex_mcp_servers.insert(name, codex);
                        }
                        None => out.reports.push(Report::new(
                            format!("{}/mcp.json", entry.name),
                            format!(
                                "Codex can't reach \"{}\": it doesn't speak legacy HTTP+SSE.",
                                server.name
                            ),
                        )),
                    }
                }
                Err(why) => out
                    .reports
                    .push(Report::new(format!("{}/mcp.json", entry.name), why)),
            }
        }
    }
    Ok(out)
}

/// One server as Claude Code's and Codex's config want it (Codex: `None` when it can't use the transport).
fn server_entries(
    host: &Host,
    plugin: &str,
    server: &McpServer,
    cli: Option<&str>,
    project: Option<&Path>,
) -> Result<(Value, Option<Value>), String> {
    match &server.transport {
        Transport::Stdio { .. } => {
            let cli = cli.ok_or_else(|| {
                format!(
                    "\"{}\" needs the app's launcher, which isn't known yet.",
                    server.name
                )
            })?;
            let mut args = vec![
                SUBCOMMAND.to_string(),
                "--root".into(),
                host.root.to_string_lossy().into_owned(),
                "--agents-skills".into(),
                host.agents_skills.to_string_lossy().into_owned(),
                "--plugin".into(),
                plugin.to_string(),
                "--server".into(),
                server.name.clone(),
            ];
            if let Some(project) = project {
                args.extend(["--project".into(), project.to_string_lossy().into_owned()]);
            }
            let entry = json!({ "command": cli, "args": args });
            Ok((entry.clone(), Some(entry)))
        }
        Transport::StreamableHttp { url, headers } => Ok((
            json!({ "type": "http", "url": url, "headers": headers }),
            Some(json!({ "url": url, "http_headers": headers })),
        )),
        Transport::Sse { url, headers } => Ok((
            json!({ "type": "sse", "url": url, "headers": headers }),
            None,
        )),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct LaunchArgs {
    host: Host,
    plugin: String,
    server: String,
    project: Option<String>,
}

impl PartialEq for Host {
    fn eq(&self, other: &Self) -> bool {
        self.root == other.root && self.agents_skills == other.agents_skills
    }
}
impl Eq for Host {}

fn parse_launch_args(args: &[String]) -> Result<LaunchArgs, String> {
    let mut root = None;
    let mut agents_skills = None;
    let mut plugin = None;
    let mut server = None;
    let mut project = None;
    let mut iter = args.iter();
    while let Some(flag) = iter.next() {
        let value = iter
            .next()
            .ok_or_else(|| format!("{flag} needs a value"))?
            .clone();
        match flag.as_str() {
            "--root" => root = Some(value),
            "--agents-skills" => agents_skills = Some(value),
            "--plugin" => plugin = Some(value),
            "--server" => server = Some(value),
            "--project" => project = Some(value),
            other => return Err(format!("unknown option {other}")),
        }
    }
    let root = root.ok_or("--root is missing")?;
    Ok(LaunchArgs {
        host: Host {
            agents_skills: agents_skills
                .map(Into::into)
                .unwrap_or_else(|| Path::new(&root).join("agents-skills")),
            root: root.into(),
        },
        plugin: plugin.ok_or("--plugin is missing")?,
        server: server.ok_or("--server is missing")?,
        project,
    })
}

/// The process to start for one plugin server: refuses a plugin that is off, unknown, or no longer offers it.
pub fn prepare_launch(args: &[String]) -> Result<std::process::Command, String> {
    let LaunchArgs {
        host,
        plugin,
        server,
        project,
    } = parse_launch_args(args)?;
    let registry = registry::read(&host)?;
    let entry = registry
        .plugins
        .get(&plugin)
        .ok_or_else(|| format!("the plugin \"{plugin}\" isn't installed."))?;
    if !entry.active_for(project.as_deref().map(Path::new)) {
        return Err(format!("the plugin \"{plugin}\" is switched off here."));
    }
    if !entry.mcp_servers().any(|s| s == server) {
        return Err(format!(
            "the plugin \"{plugin}\" has no server \"{server}\"."
        ));
    }
    let loaded = load_plugin(&host.installed(&plugin)).map_err(|e| e.0)?;
    let found = loaded
        .mcp_servers
        .iter()
        .find(|s| s.name == server)
        .ok_or_else(|| {
            format!("the plugin \"{plugin}\" no longer has a valid server \"{server}\".")
        })?;
    let data = host.data(&plugin);
    std::fs::create_dir_all(&data).map_err(|e| format!("its data folder couldn't be made: {e}"))?;
    let plan = launch_plan(&loaded.root, &super::fsutil::resolved(&data), found)?;
    let mut command = std::process::Command::new(&plan.program);
    command.args(&plan.args).current_dir(&plan.cwd);
    // A plugin server starts from a clean environment: only what a program needs to run (`passed_env`) plus its own
    // `env` and PLUGIN_ROOT / PLUGIN_DATA. The session's tokens and the app's connection never reach it.
    command.env_clear();
    command.envs(passed_env(std::env::vars_os()));
    for (key, value) in &plan.env {
        command.env(key, value);
    }
    // WP-44: the desktop gate's paths come from this app, after the environment was cleared, so a
    // worker's HIVRA_DESKTOP_* variables are not there. The pin is the installed plugin's pin.json.
    if plugin == "desktop-control" {
        for (key, value) in desktop_launch_env(&host, &plugin) {
            command.env(key, value);
        }
    }
    Ok(command)
}

/// Registry, consent and the pinned binary live in the app's plugin data, outside the installed
/// plugin folder. The pin file is the copy installed with the plugin.
pub(crate) fn desktop_launch_env(host: &Host, plugin: &str) -> Vec<(String, PathBuf)> {
    vec![
        (
            "DESKTOP_LAUNCH_REGISTRY".into(),
            host.root.join("registry.json"),
        ),
        (
            "DESKTOP_LAUNCH_CONSENT".into(),
            host.data(plugin).join("consent.json"),
        ),
        (
            "DESKTOP_LAUNCH_BINARY".into(),
            host.data(plugin).join("agent-desktop"),
        ),
        (
            "DESKTOP_LAUNCH_PIN".into(),
            host.installed(plugin).join("pin.json"),
        ),
    ]
}

/// Variables a plugin server inherits: the path, home, user, locale, time zone, terminal and temp folders, and on
/// Windows the system folders a program needs to start. Everything else (API keys, auth tokens, the app's own
/// MONOCODE_* connection) stays behind.
pub(crate) const PASSED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "TZ",
    "LANG",
    "LANGUAGE",
    "TMPDIR",
    "TMP",
    "TEMP",
    // Windows
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
];

pub(crate) fn passed_env(
    vars: impl Iterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    vars.filter(|(key, _)| {
        let key = key.to_string_lossy().to_ascii_uppercase();
        PASSED_ENV.contains(&key.as_str()) || key.starts_with("LC_")
    })
    .collect()
}

/// `monocode plugin-mcp --root <dir> --plugin <name> --server <name> [--project <dir>]`: becomes the plugin's server
/// on this stdio. Exit 78 when refused.
pub fn run_main(args: &[String]) -> i32 {
    let mut command = match prepare_launch(args) {
        Ok(command) => command,
        Err(why) => {
            eprintln!("hivra plugin server: {why}");
            return 78;
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        eprintln!("hivra plugin server: it couldn't start: {error}");
        127
    }
    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("hivra plugin server: it couldn't start: {error}");
                127
            }
        }
    }
}
