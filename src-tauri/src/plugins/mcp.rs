//! `mcp.json` (Agent Plugins 1.0.0 §7.2, §9): validation with per-server failure boundaries, `${PLUGIN_ROOT}` /
//! `${PLUGIN_DATA}` expansion, and the launch plan the `plugin-mcp` launcher runs. A plugin's server is always its own
//! process, never code inside the app.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use super::fsutil::canonical;
use super::manifest::{within, Report};

pub const MCP_SCHEMA_1_0_0: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/// One server's transport, exactly as the plugin declared it (placeholders unexpanded).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Transport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        cwd: Option<String>,
    },
    StreamableHttp {
        url: String,
        headers: BTreeMap<String, String>,
    },
    Sse {
        url: String,
        headers: BTreeMap<String, String>,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub transport: Transport,
}

/// Read `mcp.json` if there is one. A broken file disables MCP for the plugin; a broken entry skips that server.
pub fn load_mcp(root: &Path, reports: &mut Vec<Report>) -> Vec<McpServer> {
    let path = root.join("mcp.json");
    if std::fs::symlink_metadata(&path).is_err() {
        return Vec::new();
    }
    let disabled = |reports: &mut Vec<Report>, why: String| {
        reports.push(Report::new(
            "mcp.json",
            format!("No MCP servers loaded: {why}"),
        ));
        Vec::new()
    };
    let Some(path) = within(root, &path) else {
        return disabled(reports, "mcp.json points outside the plugin.".into());
    };
    if !path.is_file() {
        return disabled(reports, "mcp.json isn't a file.".into());
    }
    let value: Value = match std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
    {
        Ok(value) => value,
        Err(why) => return disabled(reports, format!("it isn't valid JSON ({why}).")),
    };
    let Some(object) = value.as_object() else {
        return disabled(reports, "it must be a JSON object.".into());
    };
    if let Some(extra) = object
        .keys()
        .find(|k| *k != "$schema" && *k != "mcpServers")
    {
        return disabled(
            reports,
            format!("\"{extra}\" isn't allowed at the top level."),
        );
    }
    match object.get("$schema").and_then(Value::as_str) {
        Some(MCP_SCHEMA_1_0_0) => {}
        Some(other) => {
            return disabled(
                reports,
                format!("it targets a different or unsupported Agent Plugins version ({other})."),
            )
        }
        None => return disabled(reports, "\"$schema\" is missing.".into()),
    }
    let Some(servers) = object.get("mcpServers").and_then(Value::as_object) else {
        return disabled(reports, "\"mcpServers\" must be an object.".into());
    };
    let mut out = Vec::new();
    for (name, entry) in servers {
        if let Some(why) = server_name_problem(name) {
            reports.push(Report::new(
                "mcp.json",
                format!("Skipped the server \"{name}\": {why}"),
            ));
            continue;
        }
        match parse_server(root, entry) {
            Ok(transport) => out.push(McpServer {
                name: name.clone(),
                transport,
            }),
            Err(why) => reports.push(Report::new(
                "mcp.json",
                format!("Skipped the server \"{name}\": {why}"),
            )),
        }
    }
    out
}

/// Server names are 1-64 letters, digits, `-` and `_`, without `__`: the characters every CLI accepts in a server
/// name, and nothing Claude Code's `mcp__<server>__<tool>` split could cut, so the name a session sees
/// (`plugin-<plugin>-<server>`, wiring.rs) keeps the plugin's server name unchanged.
pub(crate) fn server_name_problem(name: &str) -> Option<&'static str> {
    if name.is_empty() || name.chars().count() > 64 {
        return Some("its name must be 1 to 64 characters.");
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Some("its name may only use letters, digits, \"-\" and \"_\".");
    }
    if name.contains("__") {
        // Claude Code reads tool names as mcp__<server>__<tool>, splitting on "__".
        return Some("its name can't hold \"__\".");
    }
    None
}

fn closed(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    match object.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(format!("\"{key}\" isn't a field of this transport.")),
        None => Ok(()),
    }
}

fn strings(value: Option<&Value>, what: &str) -> Result<Vec<String>, String> {
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or(format!("every {what} must be text."))
            })
            .collect(),
        Some(_) => Err(format!("{what} must be a list.")),
    }
}

fn string_map(value: Option<&Value>, what: &str) -> Result<BTreeMap<String, String>, String> {
    match value {
        None => Ok(BTreeMap::new()),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(k, v)| {
                v.as_str()
                    .map(|v| (k.clone(), v.to_string()))
                    .ok_or(format!("every {what} value must be text."))
            })
            .collect(),
        Some(_) => Err(format!("{what} must be an object.")),
    }
}

fn parse_server(root: &Path, entry: &Value) -> Result<Transport, String> {
    let object = entry.as_object().ok_or("it must be an object.")?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or("it has no \"type\".")?;
    match kind {
        "stdio" => {
            closed(object, &["type", "command", "args", "env", "cwd"])?;
            let command = object
                .get("command")
                .and_then(Value::as_str)
                .ok_or("\"command\" is missing or not text.")?
                .to_string();
            check_command(root, &command)?;
            let args = strings(object.get("args"), "argument")?;
            let env = string_map(object.get("env"), "env")?;
            if env.keys().any(|key| {
                key.eq_ignore_ascii_case("PLUGIN_ROOT") || key.eq_ignore_ascii_case("PLUGIN_DATA")
            }) {
                return Err("env can't set PLUGIN_ROOT or PLUGIN_DATA.".into());
            }
            let cwd = match object.get("cwd") {
                None => None,
                Some(Value::String(cwd)) => {
                    check_cwd(root, cwd)?;
                    Some(cwd.clone())
                }
                Some(_) => return Err("\"cwd\" must be text.".into()),
            };
            Ok(Transport::Stdio {
                command,
                args,
                env,
                cwd,
            })
        }
        "streamable-http" | "sse" => {
            closed(object, &["type", "url", "headers"])?;
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .ok_or("\"url\" is missing or not text.")?
                .to_string();
            check_url(&url)?;
            let headers = string_map(object.get("headers"), "header")?;
            check_headers(&headers)?;
            Ok(if kind == "sse" {
                Transport::Sse { url, headers }
            } else {
                Transport::StreamableHttp { url, headers }
            })
        }
        other => Err(format!(
            "\"{other}\" isn't a transport Agent Plugins defines."
        )),
    }
}

fn has_parent_dir(path: &str) -> bool {
    Path::new(path)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
}

/// One executable token: a bare name, or `./path` that stays inside the plugin.
fn check_command(root: &Path, command: &str) -> Result<(), String> {
    if command.is_empty() || command.trim() != command {
        return Err("\"command\" must be one executable name or ./path.".into());
    }
    if let Some(rel) = command.strip_prefix("./") {
        if rel.is_empty() || has_parent_dir(rel) || within(root, &root.join(rel)).is_none() {
            return Err("\"command\" points outside the plugin.".into());
        }
        return Ok(());
    }
    if command.contains('/') || command.contains('\\') || command.chars().any(char::is_whitespace) {
        return Err(
            "\"command\" must be one executable name or a ./ path, not a shell command.".into(),
        );
    }
    Ok(())
}

fn check_cwd(root: &Path, cwd: &str) -> Result<(), String> {
    let rest = if let Some(rel) = cwd.strip_prefix("./") {
        if within(root, &root.join(rel)).is_none() {
            return Err("\"cwd\" points outside the plugin.".into());
        }
        rel
    } else if let Some(rest) = placeholder_rest(cwd, "${PLUGIN_ROOT}") {
        rest
    } else if let Some(rest) = placeholder_rest(cwd, "${PLUGIN_DATA}") {
        rest
    } else {
        return Err("\"cwd\" must start with ./, ${PLUGIN_ROOT} or ${PLUGIN_DATA}.".into());
    };
    if has_parent_dir(rest) {
        return Err("\"cwd\" can't climb out with \"..\".".into());
    }
    Ok(())
}

/// What follows the placeholder when `value` is exactly it or it plus `/…`.
fn placeholder_rest<'a>(value: &'a str, placeholder: &str) -> Option<&'a str> {
    let rest = value.strip_prefix(placeholder)?;
    if rest.is_empty() {
        Some("")
    } else {
        rest.strip_prefix('/')
    }
}

fn check_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|_| "\"url\" isn't an absolute URL.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("\"url\" can't carry a user name or password.".into());
    }
    if url.fragment().is_some() {
        return Err("\"url\" can't have a #fragment.".into());
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_loopback(&url) => Ok(()),
        "http" => Err("\"url\" must use https unless it is on this machine.".into()),
        _ => Err("\"url\" must be http or https.".into()),
    }
}

fn is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

fn check_headers(headers: &BTreeMap<String, String>) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for (name, value) in headers {
        let token = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b));
        if !token {
            return Err(format!("\"{name}\" isn't a valid header name."));
        }
        if value.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) {
            return Err(format!("the header \"{name}\" has a line break in it."));
        }
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err(format!("the header \"{name}\" is listed twice."));
        }
    }
    Ok(())
}

/// §9.2: one non-recursive pass replacing the two placeholders; anything else stays literal.
pub fn expand(value: &str, root: &Path, data: &Path) -> String {
    let root = root.to_string_lossy();
    let data = data.to_string_lossy();
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find("${PLUGIN_") {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        if let Some(after) = tail.strip_prefix("${PLUGIN_ROOT}") {
            out.push_str(&root);
            rest = after;
        } else if let Some(after) = tail.strip_prefix("${PLUGIN_DATA}") {
            out.push_str(&data);
            rest = after;
        } else {
            out.push_str("${PLUGIN_");
            rest = &tail["${PLUGIN_".len()..];
        }
    }
    out.push_str(rest);
    out
}

/// How a stdio server is started: the resolved program, expanded args, the env overlay (configured values, then
/// `PLUGIN_ROOT` / `PLUGIN_DATA`) and the working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

pub fn launch_plan(root: &Path, data: &Path, server: &McpServer) -> Result<LaunchPlan, String> {
    let Transport::Stdio {
        command,
        args,
        env,
        cwd,
    } = &server.transport
    else {
        return Err(format!("\"{}\" isn't a stdio server.", server.name));
    };
    let program = match command.strip_prefix("./") {
        Some(rel) => {
            within(root, &root.join(rel)).ok_or("\"command\" points outside the plugin.")?
        }
        None => PathBuf::from(command),
    };
    let cwd = match cwd {
        None => root.to_path_buf(),
        Some(cwd) => {
            let expanded = expand(cwd, root, data);
            let path = match cwd.strip_prefix("./") {
                Some(rel) => root.join(rel),
                None => PathBuf::from(expanded),
            };
            let base = if cwd.starts_with("${PLUGIN_DATA}") {
                data
            } else {
                root
            };
            let resolved =
                canonical(&path).map_err(|_| "the server's working folder doesn't exist.")?;
            let base = canonical(base).map_err(|e| e.to_string())?;
            if !resolved.starts_with(&base) {
                return Err("the server's working folder is outside its plugin.".into());
            }
            resolved
        }
    };
    let mut env: Vec<(String, String)> = env
        .iter()
        .map(|(k, v)| (k.clone(), expand(v, root, data)))
        .collect();
    env.push(("PLUGIN_ROOT".into(), root.to_string_lossy().into_owned()));
    env.push(("PLUGIN_DATA".into(), data.to_string_lossy().into_owned()));
    Ok(LaunchPlan {
        program,
        args: args.iter().map(|a| expand(a, root, data)).collect(),
        env,
        cwd,
    })
}
