// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/emulate (Apache-2.0), Copyright 2025 Chris Tate.
// WP-90: the pinned package, its seed config and its one stand-in process per stack.
// The 14 emulators are not copied; they run as emulate's own Node program.

//! The stand-in: a pinned emulate package, one process per stack, and the seed it starts from.
//!
//! explicit configuration, no interception: an app reaches the stand-in only because the
//! stack's env block names its URL. If Node is missing or too old the stack still starts, and
//! the named URLs then fail closed (connection refused) instead of reaching the real service.

use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::pinned_tool::Fetcher;

use super::store;

/// The package version Hivra pins. Node 24 or newer is emulate's own requirement.
pub const VERSION: &str = "0.13.0";
pub const MIN_NODE_MAJOR: u32 = 24;

/// The runtime packages emulate imports. Every one of them must sit beside it or Node stops at
/// the first import, so `installed` asks for all three and the install fetches all three.
pub const DEPENDENCIES: [&str; 3] = ["yaml", "commander", "picocolors"];

/// Where one tarball's `package/` folder goes inside the tool folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    /// emulate itself. Its tarball is unpacked as it stands, so `package/dist/index.js` stays
    /// where Node runs the program from.
    Program,
    /// A runtime package. The one top folder `package/` is dropped and its contents become
    /// `package/node_modules/<name>/`, which is where Node looks for it with no `npm` involved.
    Dependency,
}

/// One file the stand-in runs from. `sha256` is that tarball's own hash, lowercase hex; an empty
/// or non-64-hex value is not a pin, and one bad pin refuses the whole install before anything is
/// downloaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tarball {
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub place: Place,
}

/// The four files the stand-in needs, hashed from the registry's own tarballs on 5 Nov 2026.
/// emulate 0.13.0 imports the other three and none of the three imports anything itself, so this
/// is the whole dependency tree. A version bump is a reviewed commit that changes both the
/// version and the hash.
pub const TARBALLS: [Tarball; 4] = [
    Tarball {
        name: "emulate",
        version: "0.13.0",
        url: "https://registry.npmjs.org/emulate/-/emulate-0.13.0.tgz",
        sha256: "3afa95d276cd2066366276d3c084c3676fd892e0fc8b406a9044b562032f42e3",
        place: Place::Program,
    },
    Tarball {
        name: "yaml",
        version: "2.9.1",
        url: "https://registry.npmjs.org/yaml/-/yaml-2.9.1.tgz",
        sha256: "4ef6c54cf559b8a207b7b518378230805a1c84af239b14960e8c67c7d59de5d3",
        place: Place::Dependency,
    },
    Tarball {
        name: "commander",
        version: "14.0.3",
        url: "https://registry.npmjs.org/commander/-/commander-14.0.3.tgz",
        sha256: "5849703c500e0f324eb01340d8bda1f9ec48fc37bb7be9712eb0dd52aad92f6c",
        place: Place::Dependency,
    },
    Tarball {
        name: "picocolors",
        version: "1.1.1",
        url: "https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz",
        sha256: "d3aedb2807967b7eb37fd11b03b7e3701e725af79c650d0812ff7213f8f882d9",
        place: Place::Dependency,
    },
];

/// The note a person sees when the stand-in couldn't be fetched and put in place. One sentence,
/// plain words, and the stack still runs: its named URLs then fail closed.
pub const DOWNLOAD_NOTE: &str =
    "Downloading the stand-in, once, didn't finish, so the tests use the named URLs with nothing behind them.";

/// The note when nothing was even downloaded, because a pin isn't set.
pub const NOT_INSTALLED_NOTE: &str =
    "The stand-in isn't installed, so the tests use the named URLs with nothing behind them.";

/// emulate's 14 services, in its own order.
pub const SERVICES: [&str; 14] = [
    "vercel",
    "github",
    "google",
    "slack",
    "apple",
    "microsoft",
    "okta",
    "aws",
    "resend",
    "stripe",
    "mongoatlas",
    "clerk",
    "linear",
    "twilio",
];

/// The hosts this file can name in a sentence. The rule below is wider than this list; the
/// list only turns `api.github.com` into "GitHub" in the message.
pub const REAL_HOSTS: [&str; 14] = [
    "github.com",
    "api.github.com",
    "api.stripe.com",
    "api.slack.com",
    "slack.com",
    "oauth2.googleapis.com",
    "accounts.google.com",
    "graph.microsoft.com",
    "login.microsoftonline.com",
    "api.linear.app",
    "api.twilio.com",
    "api.resend.com",
    "api.clerk.com",
    "api.vercel.com",
];

pub fn is_service(name: &str) -> bool {
    SERVICES.contains(&name)
}

/// The service's name as a person writes it.
pub fn display_name(service: &str) -> &str {
    match service {
        "github" => "GitHub",
        "google" => "Google",
        "slack" => "Slack",
        "microsoft" => "Microsoft",
        "okta" => "Okta",
        "aws" => "AWS",
        "resend" => "Resend",
        "stripe" => "Stripe",
        "mongoatlas" => "MongoDB Atlas",
        "clerk" => "Clerk",
        "linear" => "Linear",
        "twilio" => "Twilio",
        "apple" => "Apple",
        "vercel" => "Vercel",
        other => other,
    }
}

/// One emulated service's port from the stack block and the name its base URL uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServicePort {
    pub service: String,
    pub port: u16,
    pub base_url: String,
}

/// The seed file emulate starts from: each service's port from the block, its named base URL,
/// and the default test token. JSON is used deliberately; emulate reads `.json` as JSON.
pub fn config(services: &[ServicePort]) -> Value {
    let mut root = Map::new();
    root.insert(
        "tokens".into(),
        json!({
            "test_token_admin": {
                "login": "admin",
                "scopes": ["repo", "user", "admin:org", "admin:repo_hook"],
            }
        }),
    );
    for service in services {
        root.insert(
            service.service.clone(),
            json!({
                "port": service.port,
                "baseUrl": service.base_url,
            }),
        );
    }
    Value::Object(root)
}

/// Read a seed the stack already has and put this run's ports back on top. A missing or invalid
/// file falls back to the default seed and returns one sentence saying so.
pub fn seed_or_default(path: &Path, services: &[ServicePort]) -> (Value, Option<String>) {
    let fallback = config(services);
    let Ok(text) = store::read(path) else {
        return (
            fallback,
            Some("There was no seed file, so the stand-in starts from its default seed.".into()),
        );
    };
    let Ok(Value::Object(mut stored)) = serde_json::from_str::<Value>(&text) else {
        return (
            fallback,
            Some(
                "The seed file could not be read, so the stand-in starts from its default seed."
                    .into(),
            ),
        );
    };
    for service in services {
        let entry = stored
            .entry(service.service.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        let Some(object) = entry.as_object_mut() else {
            return (
                fallback,
                Some("The seed file could not be read, so the stand-in starts from its default seed.".into()),
            );
        };
        // The block owns ports; a seed can never move a service off it.
        object.insert("port".into(), json!(service.port));
        object.insert("baseUrl".into(), json!(service.base_url));
    }
    if !stored.contains_key("tokens") {
        if let Value::Object(defaults) = config(services) {
            if let Some(tokens) = defaults.get("tokens") {
                stored.insert("tokens".into(), tokens.clone());
            }
        }
    }
    (Value::Object(stored), None)
}

/// Write the seed the stand-in is started with, then return its path and the one-time notice.
pub fn write_config(
    stack_dir: &Path,
    services: &[ServicePort],
) -> Result<(PathBuf, Option<String>), String> {
    let path = stack_dir.join("emulate.config.json");
    let (value, notice) = seed_or_default(&path, services);
    let text = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("The seed could not be written: {error}"))?;
    // The seed can carry tokens; it is written like the state file: owner only.
    store::save(&path, &text).map_err(|error| format!("The seed could not be written: {error}"))?;
    Ok((path, notice))
}

/// The service a person calls this host, for the hosts this file knows by name.
fn known_service(host: &str) -> Option<&'static str> {
    match host {
        "github.com" | "api.github.com" => Some("github"),
        "api.stripe.com" => Some("stripe"),
        "api.slack.com" | "slack.com" => Some("slack"),
        "oauth2.googleapis.com" | "accounts.google.com" => Some("google"),
        "graph.microsoft.com" | "login.microsoftonline.com" => Some("microsoft"),
        "api.linear.app" => Some("linear"),
        "api.twilio.com" => Some("twilio"),
        "api.resend.com" => Some("resend"),
        "api.clerk.com" => Some("clerk"),
        "api.vercel.com" => Some("vercel"),
        _ => None,
    }
}

/// A plain-words name for a real host: "GitHub" for a host this file knows, else the host
/// itself. Only the sentence uses this; the list no longer decides what is real.
pub fn host_name(host: &str) -> String {
    if !REAL_HOSTS.contains(&host) {
        return host.to_string();
    }
    known_service(host)
        .map(|service| display_name(service).to_string())
        .unwrap_or_else(|| host.to_string())
}

/// The host a value names when that host is a real outside service: a URL's host, or a bare
/// host such as `api.github.com`, unless it is loopback or a `.localhost` name. A value that
/// is not a host at all (a number, a word, a `${...}` placeholder) names no real host.
///
/// Wider than the old list on purpose: a value that cannot be proven local is treated as
/// real, so `www.googleapis.com` is caught whether or not it is listed.
pub fn real_target(value: &str) -> Option<String> {
    let host = host_in(value)?;
    (!is_local_host(&host)).then_some(host)
}

fn host_in(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() || text.len() > 2048 {
        return None;
    }
    if let Ok(parsed) = url::Url::parse(text) {
        if let Some(host) = parsed.host_str() {
            let host = host
                .trim_matches(['[', ']'])
                .trim_end_matches('.')
                .to_ascii_lowercase();
            // `https://${HOST}/x` parses, but `${host}` is not a host to judge.
            if host.parse::<std::net::IpAddr>().is_ok() || plausible_host(&host) {
                return Some(host);
            }
            return None;
        }
    }
    if text.contains("://") {
        // A URL this cannot parse is not a value to read a host out of.
        return None;
    }
    // No scheme: `api.github.com`, `api.github.com:443`, `user@api.github.com/path`.
    let authority = text.split('/').next()?;
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, after)| after);
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return None,
        None => authority,
    };
    looks_like_host(host).then(|| host.to_ascii_lowercase())
}

fn plausible_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

/// A dotted name with a letter in its last label: `api.github.com` yes, `3000` or `build` no.
fn looks_like_host(host: &str) -> bool {
    if !plausible_host(host) {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    labels.len() >= 2
        && labels
            .last()
            .is_some_and(|last| last.bytes().any(|byte| byte.is_ascii_alphabetic()))
}

fn is_local_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let bare = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(&host);
    if bare == "localhost" || bare.ends_with(".localhost") {
        return true;
    }
    bare.parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeStatus {
    Ready { version: String, major: u32 },
    Unavailable(String),
}

/// Parse `node --version` (`v24.1.0`). Anything else is not a Node this app can use.
pub fn parse_node_version(output: &str) -> Option<(String, u32)> {
    let text = output.trim();
    let version = text.strip_prefix('v').unwrap_or(text);
    let major = version.split('.').next()?.parse::<u32>().ok()?;
    Some((version.to_string(), major))
}

/// Ask the `node` on this copy's PATH. A missing or old Node is a notice, not a failure.
pub fn probe_node(path_env: Option<String>) -> NodeStatus {
    let mut command = Command::new("node");
    crate::hide_window_console(&mut command);
    command.arg("--version");
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    if let Some(path) = path_env.filter(|path| !path.is_empty()) {
        command.env("PATH", path);
    }
    match command.output() {
        Err(_) => NodeStatus::Unavailable(
            "Node isn't installed, so the stand-in didn't start. The stack still runs.".into(),
        ),
        Ok(output) if !output.status.success() => NodeStatus::Unavailable(
            "Node didn't answer, so the stand-in didn't start. The stack still runs.".into(),
        ),
        Ok(output) => match parse_node_version(&String::from_utf8_lossy(&output.stdout)) {
            Some((version, major)) if major >= MIN_NODE_MAJOR => NodeStatus::Ready { version, major },
            Some((version, _)) => NodeStatus::Unavailable(format!(
                "Node {version} is older than {MIN_NODE_MAJOR}, so the stand-in didn't start. The stack still runs."
            )),
            None => NodeStatus::Unavailable(
                "Node's version could not be read, so the stand-in didn't start. The stack still runs."
                    .into(),
            ),
        },
    }
}

pub fn tool_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tools").join("emulate").join(VERSION)
}

/// The installed program, and only when every file it imports is there too. A half-installed
/// tool is never accepted: Node would stop at the first import.
pub fn installed(data_dir: &Path) -> Option<PathBuf> {
    let package = tool_dir(data_dir).join("package");
    let index = package.join("dist").join("index.js");
    if !index.is_file() {
        return None;
    }
    for name in DEPENDENCIES {
        if !package
            .join("node_modules")
            .join(name)
            .join("package.json")
            .is_file()
        {
            return None;
        }
    }
    Some(index)
}

/// Whether every file the stand-in needs carries a real pin. Without one nothing is downloaded.
pub fn all_pinned(tarballs: &[Tarball]) -> bool {
    tarballs.iter().all(|tarball| is_pin(tarball.sha256))
}

fn is_pin(sha256: &str) -> bool {
    sha256.len() == 64 && sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// One install at a time in this process. Two stacks can start together, each on its own worker
/// thread; without this they would share one staging folder and one could put a half-unpacked
/// tool in place.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// Fetch and install the files the stand-in runs from, against the pins in `tarballs` — the real
/// table in production, fixtures in a test. A matching copy already there is kept and nothing is
/// downloaded. All or nothing: the tool folder is left exactly as it was unless every one arrives.
pub fn install_files(
    data_dir: &Path,
    fetch: &dyn Fetcher,
    tarballs: &[Tarball],
) -> Result<PathBuf, String> {
    // A pin that isn't a pin refuses the whole install, and downloads nothing at all.
    for tarball in tarballs {
        if !is_pin(tarball.sha256) {
            return Err(format!(
                "The pin for {} {} isn't set, so it wasn't installed.",
                tarball.name, tarball.version
            ));
        }
    }
    // The check for an installed copy and the install itself are one step: a second stack
    // starting at the same moment waits here and then finds the finished tool.
    let _installing = INSTALL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(tool) = installed(data_dir) {
        return Ok(tool);
    }
    let target = writable_tool_dir(data_dir)?;
    let staging = target.with_file_name(format!("{VERSION}.installing"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("The emulate package couldn't be unpacked: {error}"))?;
    let result = (|| {
        for tarball in tarballs {
            let bytes = fetch.fetch(tarball.url)?;
            // The hash is checked against the pin before a byte of this one is unpacked.
            let actual = crate::pinned_tool::sha256_hex(&bytes);
            if !actual.eq_ignore_ascii_case(tarball.sha256) {
                return Err(format!(
                    "The {} package does not match its pin, so it wasn't installed.",
                    tarball.name
                ));
            }
            unpack(bytes.as_slice(), &staging, tarball)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        // Nothing of a half-installed tool survives: the staging folder goes and the tool
        // folder was never touched.
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target)
        .map_err(|error| format!("The emulate package couldn't be put in place: {error}"))?;
    installed(data_dir).ok_or_else(|| "The emulate package did not contain its program.".into())
}

/// The tool folder, proved to be under this copy's data folder before anything is written into
/// it or removed from it. The check runs on resolved paths; the folder handed back is the one
/// `tool_dir` names, so every reader and writer here agrees on one path.
fn writable_tool_dir(data_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("The emulate package couldn't be unpacked: {error}"))?;
    let root = crate::fs::canonical(data_dir)
        .map_err(|error| format!("The emulate package couldn't be unpacked: {error}"))?;
    // The folder a link could redirect: made first, then resolved, so a symlinked `tools` or
    // `emulate` can't put the download anywhere else.
    let parent = root.join("tools").join("emulate");
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("The emulate package couldn't be unpacked: {error}"))?;
    let resolved = crate::fs::canonical(&parent)
        .map_err(|error| format!("The emulate package couldn't be unpacked: {error}"))?;
    if !resolved.starts_with(&root) || resolved == root {
        return Err("Refusing to write outside this copy's data folder.".into());
    }
    let target = tool_dir(data_dir);
    if std::fs::symlink_metadata(&target).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("The stand-in's folder is a link, so it was refused.".into());
    }
    Ok(target)
}

/// Where one tarball's files are placed inside the staging folder.
fn dest_dir(staging: &Path, tarball: &Tarball) -> PathBuf {
    match tarball.place {
        Place::Program => staging.to_path_buf(),
        Place::Dependency => staging
            .join("package")
            .join("node_modules")
            .join(tarball.name),
    }
}

/// Where one entry of a tarball lands. A dependency's leading `package/` is dropped so its
/// contents sit at the package's own root; the program keeps its `package/` folder as it stands.
fn placed_path(root: &Path, entry: &Path, place: Place) -> PathBuf {
    match place {
        Place::Program => root.join(entry),
        Place::Dependency => root.join(entry.strip_prefix("package").unwrap_or(entry)),
    }
}

/// Unpack one tarball into the folder it belongs in. Entries and links that would escape it are
/// refused, and nothing is written outside it.
fn unpack(bytes: &[u8], staging: &Path, tarball: &Tarball) -> Result<(), String> {
    let root = dest_dir(staging, tarball);
    if !root.starts_with(staging) {
        return Err(
            "The emulate package's folder isn't where it belongs, so it wasn't installed.".into(),
        );
    }
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("The emulate package couldn't be unpacked: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("The emulate package couldn't be read: {error}"))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("The emulate package couldn't be read: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("The emulate package has an unreadable path: {error}"))?;
        if !safe_entry(&path) {
            return Err(
                "The emulate package has a path outside its folder, so it wasn't installed.".into(),
            );
        }
        // A link whose target escapes the folder is as bad as a file path that does.
        if entry.header().entry_type().is_symlink() || entry.header().entry_type().is_hard_link() {
            let link_target = entry
                .link_name()
                .map_err(|error| format!("The emulate package has an unreadable link: {error}"))?;
            if !safe_link(link_target.as_deref()) {
                return Err(
                    "The emulate package has a link outside its folder, so it wasn't installed."
                        .into(),
                );
            }
        }
        let placed = placed_path(&root, &path, tarball.place);
        if !placed.starts_with(&root) {
            return Err(
                "The emulate package has a path outside its folder, so it wasn't installed.".into(),
            );
        }
        // A tarball that lists a file without its folders is unpacked anyway; the folders are
        // made here, inside the folder this entry belongs to and nowhere else.
        if let Some(parent) = placed.parent() {
            if !parent.starts_with(&root) {
                return Err(
                    "The emulate package has a path outside its folder, so it wasn't installed."
                        .into(),
                );
            }
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("The emulate package couldn't be unpacked: {error}"))?;
        }
        entry
            .unpack(&placed)
            .map_err(|error| format!("The emulate package couldn't be unpacked: {error}"))?;
    }
    Ok(())
}

fn safe_entry(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

/// A link inside the package must point at a plain relative path, never outside it.
fn safe_link(target: Option<&Path>) -> bool {
    target.is_some_and(safe_entry)
}

pub struct StartRequest {
    /// The stack's own folder; the seed, log and pid live here and survive a return.
    pub stack_dir: PathBuf,
    pub config: PathBuf,
    pub tool: PathBuf,
    pub path_env: Option<String>,
}

/// Start one stand-in for this stack. Its pid is written beside the seed so `down` can stop
/// exactly this process and nothing else.
pub fn start(request: &StartRequest) -> Result<u32, String> {
    std::fs::create_dir_all(&request.stack_dir)
        .map_err(|error| format!("The stand-in's folder couldn't be made: {error}"))?;
    let log_path = request.stack_dir.join("emulate.log");
    let log = std::fs::File::create(&log_path)
        .map_err(|error| format!("The stand-in's log couldn't be made: {error}"))?;
    let errors = log
        .try_clone()
        .map_err(|error| format!("The stand-in's log couldn't be made: {error}"))?;
    let mut command = Command::new("node");
    crate::hide_window_console(&mut command);
    command
        .arg(&request.tool)
        .arg("start")
        .arg("--seed")
        .arg(&request.config)
        .arg("--host")
        .arg("127.0.0.1")
        .current_dir(&request.stack_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errors));
    // The stand-in gets nothing from this app by inheritance: not a shell's GH_TOKEN, not a
    // model key, not the control endpoint. Only the allow-list below is set.
    command.env_clear();
    for (key, value) in child_env(request.path_env.as_deref()) {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("The stand-in didn't start: {error}"))?;
    let pid = child.id();
    if let Err(error) = store::save(
        &request.stack_dir.join("emulate.pid"),
        format!("{pid}\n").as_bytes(),
    ) {
        // A process this app cannot stop again is worse than no process.
        let _ = child.kill();
        return Err(format!(
            "The stand-in started, but its pid couldn't be written, so it was stopped: {error}"
        ));
    }
    Ok(pid)
}

/// The child's whole environment: an allow-list, never this process's own.
pub fn child_env(path_env: Option<&str>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(path) = path_env.filter(|path| !path.is_empty()) {
        env.push(("PATH".to_string(), path.to_string()));
    }
    #[cfg(windows)]
    let keys = ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"];
    #[cfg(not(windows))]
    let keys = ["HOME", "TMPDIR"];
    for key in keys {
        if let Some(value) = std::env::var_os(key) {
            if let Ok(value) = value.into_string() {
                if !value.is_empty() {
                    env.push((key.to_string(), value));
                }
            }
        }
    }
    env.push(("NO_COLOR".to_string(), "1".to_string()));
    env
}

/// Stop the stand-in recorded for this stack. A pid whose command does not name this copy's
/// emulate program is left alone: a recycled pid is never killed.
pub fn stop(stack_dir: &Path, tool: &Path) -> Result<(), String> {
    let path = stack_dir.join("emulate.pid");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("The stand-in's pid couldn't be read: {error}")),
    };
    let Ok(pid) = text.trim().parse::<u32>() else {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    };
    if !process_names_tool(pid, tool) {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(pid) {
            // SAFETY: the pid was checked against this copy's program above.
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = std::fs::remove_file(&path);
    Ok(())
}

#[cfg(unix)]
fn process_names_tool(pid: u32, tool: &Path) -> bool {
    let Ok(output) = Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let command = String::from_utf8_lossy(&output.stdout);
    let wanted = tool.to_string_lossy();
    command.contains(wanted.as_ref())
}

#[cfg(not(unix))]
fn process_names_tool(_pid: u32, _tool: &Path) -> bool {
    // Windows has no cheap, race-free command-line check here; the recorded pid is ours.
    true
}

/// A stable map from a service to its env name: `GITHUB_BASE_URL`, `MONGODBATLAS_BASE_URL`.
pub fn env_name(service: &str) -> String {
    let mut out = String::with_capacity(service.len() + 9);
    for ch in service.chars() {
        out.push(ch.to_ascii_uppercase());
    }
    out.push_str("_BASE_URL");
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::time::Duration;

    fn ports() -> Vec<ServicePort> {
        vec![
            ServicePort {
                service: "github".into(),
                port: 22010,
                base_url: "http://github-shop-wp-90.localhost:7400".into(),
            },
            ServicePort {
                service: "stripe".into(),
                port: 22011,
                base_url: "http://stripe-shop-wp-90.localhost:7400".into(),
            },
        ]
    }

    struct Temp(std::path::PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hivra-emulate-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_config_puts_each_services_block_port_and_named_url_in_the_seed() {
        let config = config(&ports());
        assert_eq!(config["github"]["port"], 22010);
        assert_eq!(config["stripe"]["port"], 22011);
        assert_eq!(
            config["github"]["baseUrl"],
            "http://github-shop-wp-90.localhost:7400"
        );
        assert_eq!(config["tokens"]["test_token_admin"]["login"], "admin");
    }

    #[test]
    fn a_valid_seed_keeps_its_own_keys_but_never_its_ports() {
        let temp = Temp::new("seed");
        let path = temp.0.join("emulate.config.json");
        std::fs::write(
            &path,
            r#"{"github":{"port":9999,"users":[{"login":"octocat"}]},"tokens":{"x":{"login":"x"}}}"#,
        )
        .unwrap();
        let (value, notice) = seed_or_default(&path, &ports());
        assert!(notice.is_none());
        assert_eq!(value["github"]["port"], 22010);
        assert_eq!(value["github"]["users"][0]["login"], "octocat");
        assert_eq!(value["tokens"]["x"]["login"], "x");
        assert_eq!(value["stripe"]["port"], 22011);
    }

    #[test]
    fn a_missing_or_invalid_seed_falls_back_to_the_default_and_says_so() {
        let temp = Temp::new("fallback");
        let missing = temp.0.join("missing.json");
        let (value, notice) = seed_or_default(&missing, &ports());
        assert!(notice.is_some());
        assert_eq!(value["github"]["port"], 22010);

        let broken = temp.0.join("broken.json");
        std::fs::write(&broken, b"{not json").unwrap();
        let (value, notice) = seed_or_default(&broken, &ports());
        assert!(notice.unwrap().contains("could not be read"));
        assert_eq!(value["stripe"]["port"], 22011);
    }

    #[test]
    fn node_versions_below_24_are_reported_not_used() {
        assert_eq!(parse_node_version("v24.1.0\n"), Some(("24.1.0".into(), 24)));
        assert_eq!(parse_node_version("22.23.4"), Some(("22.23.4".into(), 22)));
        assert_eq!(parse_node_version("not a version"), None);
    }

    #[test]
    fn a_real_host_is_recognised_by_its_name_and_local_ones_are_not() {
        assert_eq!(
            real_target("https://api.github.com/repos").as_deref(),
            Some("api.github.com")
        );
        // Not on the old list, and still real.
        assert_eq!(
            real_target("https://www.googleapis.com/oauth2").as_deref(),
            Some("www.googleapis.com")
        );
        assert_eq!(
            real_target("https://api.github.com.evil.example").as_deref(),
            Some("api.github.com.evil.example")
        );
        assert_eq!(
            real_target("api.stripe.com:443").as_deref(),
            Some("api.stripe.com")
        );
        assert_eq!(real_target("user@api.linear.app/x").as_deref(), Some("api.linear.app"));
        assert_eq!(real_target("http://github-shop-wp-90.localhost:7400"), None);
        assert_eq!(real_target("http://127.0.0.1:22010"), None);
        assert_eq!(real_target("http://[::1]:3000"), None);
        assert_eq!(real_target("http://localhost:3000"), None);
        assert_eq!(real_target("postgres://127.0.0.1:5432/${DB}"), None);
        assert_eq!(real_target("https://${HOST}/x"), None);
        assert_eq!(real_target("not a url"), None);
        assert_eq!(real_target("3000"), None);
        assert_eq!(real_target(""), None);
        assert_eq!(host_name("api.github.com"), "GitHub");
        assert_eq!(host_name("www.googleapis.com"), "www.googleapis.com");
    }

    /// The four pins, checked as data: every one is a 64-hex hash of the registry's own file.
    #[test]
    fn every_file_the_stand_in_needs_carries_a_real_pin() {
        assert_eq!(TARBALLS.len(), 4);
        assert!(all_pinned(&TARBALLS));
        assert_eq!(TARBALLS[0].name, "emulate");
        assert_eq!(TARBALLS[0].place, Place::Program);
        assert_eq!(TARBALLS[0].version, VERSION);
        assert_eq!(
            TARBALLS[0].url,
            "https://registry.npmjs.org/emulate/-/emulate-0.13.0.tgz"
        );
        for tarball in &TARBALLS[1..] {
            assert_eq!(tarball.place, Place::Dependency);
        }
        let names: Vec<&str> = TARBALLS.iter().map(|tarball| tarball.name).collect();
        assert_eq!(names, ["emulate", "yaml", "commander", "picocolors"]);
        for tarball in &TARBALLS {
            assert!(is_pin(tarball.sha256), "{} is not pinned", tarball.name);
            assert!(tarball.url.starts_with("https://registry.npmjs.org/"));
            assert!(tarball.url.ends_with(".tgz"));
            assert!(tarball.url.contains(tarball.version));
        }
        assert!(!all_pinned(&[Tarball {
            sha256: "",
            ..TARBALLS[0]
        }]));
        assert!(!is_pin("ab"));
        assert!(!is_pin(&"ab".repeat(31)));
        assert!(!is_pin(&"zz".repeat(32)));
    }

    /// The pins are the ones the lead hashed from the registry on 5 Nov 2026.
    #[test]
    fn the_pins_are_the_ones_hashed_from_the_registry() {
        assert_eq!(
            TARBALLS[0].sha256,
            "3afa95d276cd2066366276d3c084c3676fd892e0fc8b406a9044b562032f42e3"
        );
        assert_eq!(
            TARBALLS[1].sha256,
            "4ef6c54cf559b8a207b7b518378230805a1c84af239b14960e8c67c7d59de5d3"
        );
        assert_eq!(
            TARBALLS[2].sha256,
            "5849703c500e0f324eb01340d8bda1f9ec48fc37bb7be9712eb0dd52aad92f6c"
        );
        assert_eq!(
            TARBALLS[3].sha256,
            "d3aedb2807967b7eb37fd11b03b7e3701e725af79c650d0812ff7213f8f882d9"
        );
    }

    /// A tar the `tar` builder refuses to write, so a `..` name can still be tested.
    pub(crate) fn raw_tar_gz(name: &str, data: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];
        let name_bytes = name.as_bytes();
        assert!(name_bytes.len() < 100);
        header[..name_bytes.len()].copy_from_slice(name_bytes);
        header[100..108].copy_from_slice(b"0000644\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        let size = format!("{:011o}\0", data.len());
        header[124..136].copy_from_slice(size.as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        header[148..156].copy_from_slice(b"        ");
        header[156] = b'0';
        header[257..262].copy_from_slice(b"ustar");
        header[263..265].copy_from_slice(b"00");
        let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
        let cksum = format!("{sum:06o}\0 ");
        header[148..156].copy_from_slice(cksum.as_bytes());
        let mut raw = Vec::new();
        raw.extend_from_slice(&header);
        raw.extend_from_slice(data);
        let pad = (512 - (data.len() % 512)) % 512;
        raw.extend(std::iter::repeat_n(0, pad));
        raw.extend(std::iter::repeat_n(0, 1024));
        gzip(&raw)
    }

    pub(crate) fn tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, *name, *data).unwrap();
        }
        gzip(&builder.into_inner().unwrap())
    }

    fn gzip(raw: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(raw).unwrap();
        enc.finish().unwrap()
    }

    pub(crate) fn leak(value: String) -> &'static str {
        Box::leak(value.into_boxed_str())
    }

    /// A fetcher that serves the fixtures a test hands it, and counts every call.
    pub(crate) struct Fake {
        bodies: Vec<(String, Vec<u8>)>,
        hits: std::sync::atomic::AtomicUsize,
        offline: bool,
    }

    impl Fake {
        pub(crate) fn online(bodies: Vec<(String, Vec<u8>)>) -> Self {
            Self {
                bodies,
                hits: std::sync::atomic::AtomicUsize::new(0),
                offline: false,
            }
        }

        pub(crate) fn offline() -> Self {
            Self {
                bodies: Vec::new(),
                hits: std::sync::atomic::AtomicUsize::new(0),
                offline: true,
            }
        }

        pub(crate) fn hits(&self) -> usize {
            self.hits.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Fetcher for Fake {
        fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
            self.hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.offline {
                return Err("The download didn't finish. Try again.".into());
            }
            self.bodies
                .iter()
                .find(|(candidate, _)| candidate == url)
                .map(|(_, body)| body.clone())
                .ok_or_else(|| "The download didn't finish. Try again.".to_string())
        }
    }

    /// The four names, in the order the real table lists them.
    pub(crate) const FIXTURE_NAMES: [(&str, Place); 4] = [
        ("emulate", Place::Program),
        ("yaml", Place::Dependency),
        ("commander", Place::Dependency),
        ("picocolors", Place::Dependency),
    ];

    /// Four tiny tarballs shaped like the registry's: one top folder `package/`, holding the
    /// program at `dist/index.js` and a dependency's `package.json`.
    pub(crate) fn fixture() -> (Vec<Tarball>, Vec<(String, Vec<u8>)>) {
        let mut table = Vec::new();
        let mut bodies = Vec::new();
        for (name, place) in FIXTURE_NAMES {
            let bytes = match place {
                Place::Program => tar_gz(&[("package/dist/index.js", b"program")]),
                Place::Dependency => tar_gz(&[
                    ("package/package.json", b"{\"name\":\"dep\"}"),
                    ("package/dist/index.js", b"module"),
                ]),
            };
            let url = leak(format!("https://example.invalid/{name}-{VERSION}.tgz"));
            let sha256 = leak(crate::pinned_tool::sha256_hex(&bytes));
            table.push(Tarball {
                name,
                version: VERSION,
                url,
                sha256,
                place,
            });
            bodies.push((url.to_string(), bytes));
        }
        (table, bodies)
    }

    #[test]
    fn the_four_files_land_and_the_program_is_installed() {
        let temp = Temp::new("install");
        let (table, bodies) = fixture();
        let fetcher = Fake::online(bodies);
        let tool = install_files(&temp.0, &fetcher, &table).unwrap();
        assert_eq!(tool, installed(&temp.0).unwrap());
        assert_eq!(fetcher.hits(), 4);
        let package = tool_dir(&temp.0).join("package");
        assert_eq!(std::fs::read(&tool).unwrap(), b"program");
        for name in DEPENDENCIES {
            let dep = package.join("node_modules").join(name);
            assert!(dep.join("package.json").is_file(), "{name} is missing");
            assert!(dep.join("dist").join("index.js").is_file());
        }
        // Nothing of the staging folder is left behind.
        assert!(!tool_dir(&temp.0)
            .with_file_name(format!("{VERSION}.installing"))
            .exists());
    }

    #[test]
    fn a_hash_mismatch_on_one_writes_nothing() {
        let temp = Temp::new("mismatch");
        let (mut table, bodies) = fixture();
        // commander is the third of the four, so the first two have already been unpacked
        // into the staging folder by the time this one is refused.
        table[2].sha256 = leak("ab".repeat(32));
        let target = tool_dir(&temp.0);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("kept.txt"), b"as it was").unwrap();
        let before = listing(&target);
        let fetcher = Fake::online(bodies);
        let error = install_files(&temp.0, &fetcher, &table).unwrap_err();
        assert!(error.contains("does not match its pin"), "{error}");
        assert_eq!(listing(&target), before);
        assert!(!target.join("package").exists());
        assert!(installed(&temp.0).is_none());
        assert!(!target
            .with_file_name(format!("{VERSION}.installing"))
            .exists());
    }

    #[test]
    fn a_path_that_escapes_a_packages_folder_is_refused() {
        let temp = Temp::new("escape");
        let (mut table, mut bodies) = fixture();
        // A dependency whose tarball holds an entry above the folder it is unpacked into.
        let bad = raw_tar_gz("../outside", b"nope");
        table[1].sha256 = leak(crate::pinned_tool::sha256_hex(&bad));
        bodies[1].1 = bad;
        let fetcher = Fake::online(bodies);
        let error = install_files(&temp.0, &fetcher, &table).unwrap_err();
        assert!(error.contains("outside its folder"), "{error}");
        assert!(installed(&temp.0).is_none());
        assert!(!temp
            .0
            .join("tools")
            .join("emulate")
            .join("outside")
            .exists());
        assert!(!temp.0.join("outside").exists());
        assert!(!tool_dir(&temp.0).exists());
    }

    #[test]
    fn a_second_install_downloads_nothing() {
        let temp = Temp::new("second");
        let (table, bodies) = fixture();
        let fetcher = Fake::online(bodies);
        let first = install_files(&temp.0, &fetcher, &table).unwrap();
        assert_eq!(fetcher.hits(), 4);
        let again = install_files(&temp.0, &fetcher, &table).unwrap();
        assert_eq!(again, first);
        assert_eq!(fetcher.hits(), 4, "the second install fetched something");
    }

    /// Two stacks can start at the same moment, each on its own worker thread. They must not
    /// share the staging folder, and the second must find the first's finished copy.
    #[test]
    fn two_installs_at_once_install_one_copy() {
        let temp = Temp::new("once");
        let (table, bodies) = fixture();
        let fetcher = Fake::online(bodies);
        let tools: Vec<PathBuf> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| scope.spawn(|| install_files(&temp.0, &fetcher, &table)))
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap().unwrap())
                .collect()
        });
        assert!(tools.iter().all(|tool| *tool == tools[0]));
        assert_eq!(fetcher.hits(), 4, "a second thread downloaded its own copy");
        assert!(installed(&temp.0).is_some());
    }

    #[test]
    fn a_half_installed_tool_is_not_accepted() {
        let temp = Temp::new("half");
        let (table, bodies) = fixture();
        let fetcher = Fake::online(bodies);
        install_files(&temp.0, &fetcher, &table).unwrap();
        assert!(installed(&temp.0).is_some());
        // One dependency gone: Node would stop at its first import, so this is not installed.
        for name in DEPENDENCIES {
            let dep = tool_dir(&temp.0)
                .join("package")
                .join("node_modules")
                .join(name);
            let moved = temp.0.join(format!("{name}.aside"));
            std::fs::rename(&dep, &moved).unwrap();
            assert!(installed(&temp.0).is_none(), "{name} went unnoticed");
            std::fs::rename(&moved, &dep).unwrap();
            assert!(installed(&temp.0).is_some());
        }
    }

    #[test]
    fn an_unset_pin_refuses_without_downloading() {
        let temp = Temp::new("unset");
        let (mut table, bodies) = fixture();
        table[3].sha256 = "";
        let fetcher = Fake::online(bodies);
        let error = install_files(&temp.0, &fetcher, &table).unwrap_err();
        assert!(error.contains("isn't set"), "{error}");
        assert_eq!(fetcher.hits(), 0);
        assert!(!temp.0.join("tools").exists());
        assert!(!all_pinned(&table));
    }

    #[test]
    fn an_offline_install_leaves_nothing_behind() {
        let temp = Temp::new("offline");
        let (table, _) = fixture();
        let fetcher = Fake::offline();
        let error = install_files(&temp.0, &fetcher, &table).unwrap_err();
        assert!(error.contains("didn't finish"), "{error}");
        assert_eq!(fetcher.hits(), 1);
        assert!(installed(&temp.0).is_none());
        assert!(!tool_dir(&temp.0).exists());
        assert!(!tool_dir(&temp.0)
            .with_file_name(format!("{VERSION}.installing"))
            .exists());
    }

    /// The one test that uses the real registry, the real Node and a real socket:
    /// `cargo test --manifest-path src-tauri/Cargo.toml emulate_real_install_and_start -- --ignored`
    /// with the network on. It is `#[ignore]`d so CI never reaches out.
    #[test]
    #[ignore = "downloads emulate from the npm registry and needs Node 24 or newer"]
    fn emulate_real_install_and_start() {
        let temp = Temp::new("real");
        match probe_node(None) {
            NodeStatus::Ready { version, .. } => println!("using Node {version}"),
            NodeStatus::Unavailable(note) => {
                println!("skipped: {note}");
                return;
            }
        }
        let tool = match install_files(&temp.0, &crate::pinned_tool::UreqFetcher, &TARBALLS) {
            Ok(tool) => tool,
            Err(error) => panic!("the stand-in could not be installed: {error}"),
        };
        assert_eq!(installed(&temp.0).as_ref(), Some(&tool));
        let port = free_port();
        let stack_dir = temp.0.join("stack");
        let (config, notice) = write_config(
            &stack_dir,
            &[ServicePort {
                service: "github".into(),
                port,
                base_url: format!("http://github-real.localhost:{}", port),
            }],
        )
        .unwrap();
        assert!(notice.is_some(), "a first start has no seed to keep");
        let pid = match start(&StartRequest {
            stack_dir: stack_dir.clone(),
            config,
            tool: tool.clone(),
            path_env: None,
        }) {
            Ok(pid) => pid,
            Err(error) => panic!("the stand-in didn't start: {error}"),
        };
        // Whatever happens next, the process this test started is stopped before it ends.
        let answered = wait_for_status(port, Duration::from_secs(60));
        let stopped = stop(&stack_dir, &tool);
        let line = match answered {
            Some(line) => line,
            None => panic!("nothing answered on 127.0.0.1:{port}"),
        };
        println!("the stand-in answered: {line}");
        assert!(stopped.is_ok(), "the stand-in could not be stopped");
        assert!(
            line.starts_with("HTTP/1."),
            "not an HTTP status line: {line:?}"
        );
        assert!(
            wait_until_gone(port, Duration::from_secs(15)),
            "something is still listening on 127.0.0.1:{port}"
        );
        assert!(!stack_dir.join("emulate.pid").exists());
        #[cfg(unix)]
        assert!(
            wait_for_exit(pid, Duration::from_secs(15)),
            "process {pid} is still running"
        );
        #[cfg(not(unix))]
        let _ = pid;
    }

    /// A free port from the OS, released straight away. The stand-in takes it a moment later;
    /// on a quiet machine nothing else wants it in between.
    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    /// One GET at the status line, or `None` when nothing answers.
    fn get_status(port: u16) -> Option<String> {
        use std::io::{BufRead, BufReader, Write};
        let stream = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let mut writer = stream.try_clone().ok()?;
        writer
            .write_all(
                format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .ok()?;
        writer.flush().ok()?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).ok()?;
        let line = line.trim_end().to_string();
        (!line.is_empty()).then_some(line)
    }

    fn wait_for_status(port: u16, within: Duration) -> Option<String> {
        let deadline = std::time::Instant::now() + within;
        loop {
            if let Some(line) = get_status(port) {
                return Some(line);
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn wait_until_gone(port: u16, within: Duration) -> bool {
        let deadline = std::time::Instant::now() + within;
        loop {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// The stand-in's own process is gone. Its exit is collected here, so a killed child that
    /// has not been reaped yet is not mistaken for a running one.
    #[cfg(unix)]
    fn wait_for_exit(pid: u32, within: Duration) -> bool {
        let deadline = std::time::Instant::now() + within;
        loop {
            let mut status = 0;
            // SAFETY: this test started the process, so it is this process's child.
            let reaped = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
            if reaped == pid as i32 || reaped < 0 {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Every file under a folder, for an exact "nothing changed" comparison.
    fn listing(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(next) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&next) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(bytes) = std::fs::read(&path) {
                    out.push((path.to_string_lossy().into_owned(), bytes));
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn a_tar_entry_that_escapes_the_folder_is_refused() {
        assert!(safe_entry(Path::new("package/dist/index.js")));
        assert!(safe_entry(Path::new("./package/dist/index.js")));
        assert!(!safe_entry(Path::new("../outside")));
        assert!(!safe_entry(Path::new("/etc/hosts")));
        assert!(safe_link(Some(Path::new("package/dist/index.js"))));
        assert!(!safe_link(Some(Path::new("../outside"))));
        assert!(!safe_link(Some(Path::new("/etc/hosts"))));
        assert!(!safe_link(None));
    }

    /// The spawned stand-in's own view of its environment, not the helper's list: the fake
    /// `node` prints `env` to the log `start` gives it.
    #[cfg(unix)]
    #[test]
    fn the_child_gets_an_allow_listed_environment() {
        use std::os::unix::fs::PermissionsExt;
        let temp = Temp::new("env");
        let bin = temp.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        // `set` prints every variable the shell was given; PATH holds only this bin, so a
        // separate `env` command would not be found.
        std::fs::write(&node, "#!/bin/sh\nset\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tool = temp.0.join("index.js");
        std::fs::write(&tool, "").unwrap();
        let config = temp.0.join("emulate.config.json");
        std::fs::write(&config, "{}").unwrap();
        let stack = temp.0.join("stack");

        // Hivra launched from a shell that had these exported.
        std::env::set_var("GH_TOKEN", "secret-from-the-shell");
        std::env::set_var("ANTHROPIC_API_KEY", "secret-from-the-shell");
        let started = start(&StartRequest {
            stack_dir: stack.clone(),
            config,
            tool,
            path_env: Some(bin.to_string_lossy().into_owned()),
        });
        std::env::remove_var("GH_TOKEN");
        std::env::remove_var("ANTHROPIC_API_KEY");
        started.unwrap();

        let log = stack.join("emulate.log");
        let mut text = String::new();
        for _ in 0..100 {
            text = std::fs::read_to_string(&log).unwrap_or_default();
            if text.lines().any(|line| line.starts_with("NO_COLOR=")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let keys: Vec<&str> = text
            .lines()
            .filter_map(|line| line.split_once('=').map(|(key, _)| key))
            .collect();
        assert!(keys.contains(&"PATH"), "{text}");
        assert!(keys.contains(&"NO_COLOR"), "{text}");
        assert!(
            !keys.contains(&"GH_TOKEN"),
            "a shell token reached the stand-in: {text}"
        );
        assert!(
            !keys.contains(&"ANTHROPIC_API_KEY"),
            "a model key reached the stand-in: {text}"
        );
    }

    #[test]
    fn the_env_name_is_the_services_uppercase_name() {
        assert_eq!(env_name("github"), "GITHUB_BASE_URL");
        assert_eq!(env_name("mongoatlas"), "MONGOATLAS_BASE_URL");
    }
}
