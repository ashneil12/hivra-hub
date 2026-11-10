// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/emulate (Apache-2.0), Copyright 2025 Chris Tate.
// WP-90: the pinned package, its seed config and its one stand-in process per stack.
// The 14 emulators are not copied; they run as emulate's own Node program.

//! The stand-in: a pinned emulate package, one process per stack, and the seed it starts from.
//!
//! explicit configuration, no interception: an app reaches the stand-in only because the
//! stack's env block names its URL. If Node is missing or too old the stack still starts, and
//! the named URLs then fail closed (connection refused) instead of reaching the real service.

use std::io::Read;
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

/// How long `node --version` may take. It runs while the app opens, and a shim that waits on
/// the network, or a version manager that is updating itself, must not hold the window.
const NODE_PROBE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Ask the `node` on this copy's PATH. A missing or old Node is a notice, not a failure.
pub fn probe_node(path_env: Option<String>) -> NodeStatus {
    probe_node_within(path_env, NODE_PROBE_WAIT)
}

fn probe_node_within(path_env: Option<String>, wait: std::time::Duration) -> NodeStatus {
    let mut command = Command::new("node");
    crate::hide_window_console(&mut command);
    command.arg("--version");
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::null());
    if let Some(path) = path_env.filter(|path| !path.is_empty()) {
        command.env("PATH", path);
    }
    let Ok(mut child) = command.spawn() else {
        return NodeStatus::Unavailable(
            "Node isn't installed, so the stand-in didn't start. The stack still runs.".into(),
        );
    };
    // Read on a thread of its own, into a buffer this function can take at any time. A `node`
    // that is a shim exits, and the real node it started keeps the pipe: reading to the end here
    // would wait for that one. The thread is never joined, so it can outlive the probe.
    let text = std::sync::Arc::new(Mutex::new(String::new()));
    let (done, finished) = std::sync::mpsc::channel::<()>();
    if let Some(mut pipe) = child.stdout.take() {
        let text = std::sync::Arc::clone(&text);
        let _ = std::thread::Builder::new()
            .name("hivra-node-probe".into())
            .spawn(move || {
                let mut chunk = [0u8; 512];
                while let Ok(read) = pipe.read(&mut chunk) {
                    if read == 0 {
                        break;
                    }
                    let mut text = text.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    if text.len() < 4096 {
                        text.push_str(&String::from_utf8_lossy(&chunk[..read]));
                    }
                }
                let _ = done.send(());
            });
    } else {
        let _ = done.send(());
    }
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < wait => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            // Slow or stuck: ended, so nothing is left running behind the note.
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return NodeStatus::Unavailable(
                    "Node didn't answer in time, so the stand-in didn't start. The stack still runs."
                        .into(),
                );
            }
        }
    };
    if !status.success() {
        return NodeStatus::Unavailable(
            "Node didn't answer, so the stand-in didn't start. The stack still runs.".into(),
        );
    }
    // The answer is in the pipe already. The end of the pipe is waited for a moment, within the
    // time that is left, and what was read by then is the answer.
    let left = wait
        .saturating_sub(started.elapsed())
        .min(std::time::Duration::from_millis(500));
    let _ = finished.recv_timeout(left);
    let stdout = text
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    match parse_node_version(&stdout) {
        Some((version, major)) if major >= MIN_NODE_MAJOR => NodeStatus::Ready { version, major },
        Some((version, _)) => NodeStatus::Unavailable(format!(
            "Node {version} is older than {MIN_NODE_MAJOR}, so the stand-in didn't start. The stack still runs."
        )),
        None => NodeStatus::Unavailable(
            "Node's version could not be read, so the stand-in didn't start. The stack still runs."
                .into(),
        ),
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
    // Windows: the stand-in and whatever it starts (a Volta or Scoop shim starts the real node)
    // live in one job that ends with it, so ending the job ends the tree, and the OS ends it
    // with this app too.
    #[cfg(windows)]
    let job = crate::windows::create_job()
        .map_err(|error| format!("The stand-in's job couldn't be made: {error}"))?;
    #[cfg(windows)]
    let mut child = crate::windows::spawn_in_job(&mut command, &job)
        .map_err(|error| format!("The stand-in didn't start: {error}"))?;
    #[cfg(not(windows))]
    let mut child = command
        .spawn()
        .map_err(|error| format!("The stand-in didn't start: {error}"))?;
    let pid = child.id();
    // Asked of the child this app just started and has not waited for yet, so its pid cannot
    // have been given to anything else: the start time is this process's and no other's.
    #[cfg(windows)]
    let start_token = super::process_win::start_token_of_child(&child);
    #[cfg(unix)]
    let start_token = unix_start_token(pid);
    #[cfg(not(any(unix, windows)))]
    let start_token: Option<String> = None;
    let Some(start_token) = start_token else {
        // Without a start time the stand-in could never be told from another program later,
        // and a process this app cannot stop again is worse than no process.
        let _ = child.kill();
        let _ = child.wait();
        return Err(
            "The stand-in started, but its start time couldn't be read, so it was stopped.".into(),
        );
    };
    if let Err(error) = store::save(
        &request.stack_dir.join("emulate.pid"),
        pid_file_text(pid, Some(&start_token)).as_bytes(),
    ) {
        // A process this app cannot stop again is worse than no process.
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "The stand-in started, but its pid couldn't be written, so it was stopped: {error}"
        ));
    }
    #[cfg(windows)]
    super::process_win::keep_job(&request.stack_dir, job);
    // Reaped when it ends, so it is not left a zombie that keeps its process group looking
    // alive after everything in it is gone.
    let _ = std::thread::Builder::new()
        .name("hivra-stand-in-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        });
    Ok(pid)
}

/// Copied into a Windows stand-in. `SystemRoot` is how Windows finds its own libraries;
/// a node child started without it can fail before it listens. No secret is on this list.
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_CHILD_ENV_KEYS: &[&str] = &[
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "SystemRoot",
];

/// The child's whole environment: an allow-list, never this process's own.
pub fn child_env(path_env: Option<&str>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(path) = path_env.filter(|path| !path.is_empty()) {
        env.push(("PATH".to_string(), path.to_string()));
    }
    #[cfg(windows)]
    let keys = WINDOWS_CHILD_ENV_KEYS;
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

/// What can be proved about the process named by `emulate.pid`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    /// The process this app started: its start time is the one recorded, and it is node
    /// running the stand-in.
    Ours,
    /// The pid is alive and is plainly another program: a recycled pid.
    NotOurs,
    /// No such process.
    Gone,
    /// The pid is alive but cannot be proved either way: no start time was recorded, or one
    /// of them could not be read, or it is an emulate process that is not this stack's.
    Unknown,
}

/// What the kill step found, looking again at the moment it acts. Only `Failed` leaves the pid
/// file: the other three mean this stack has no stand-in running any more.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kill {
    /// It was this stack's stand-in and it has been ended.
    Killed,
    /// It exited between the first look and the kill.
    Gone,
    /// The pid had been given to another program in between. Nothing was ended.
    NotOurs,
    /// It is still there and could not be ended, or could not be looked at again, or it was
    /// ended and something still holds one of its ports.
    Failed,
}

/// Said when a stand-in cannot be proved this app's own to stop. The pid file is kept.
pub const STILL_RUNNING_NOTE: &str =
    "The old stand-in is still running; stop it from Activity Monitor or restart the app.";

/// Stop the stand-in recorded for this stack. A pid that cannot be proved to be this stack's
/// stand-in is never killed, and never forgotten either: the pid file stays so the next stop
/// can try again, and the message says how to end it by hand.
pub fn stop(stack_dir: &Path) -> Result<(), String> {
    // Windows: the stand-in this app started is in a job of its own. Ending the job ends the
    // process and everything it started, and no pid is involved, so no pid can be a wrong one.
    #[cfg(windows)]
    if super::process_win::end_held_job(stack_dir) {
        return if ports_released(stack_dir) {
            let _ = std::fs::remove_file(stack_dir.join("emulate.pid"));
            Ok(())
        } else {
            Err(STILL_RUNNING_NOTE.to_string())
        };
    }
    let dir = stack_dir.to_path_buf();
    stop_with(
        stack_dir,
        |pid| probe_stand_in(pid, stack_dir),
        move |pid| kill_if_still_ours(pid, &dir),
    )
}

/// The pid file is `pid` and the process start time on the next line, which is what tells the
/// stand-in from whatever has the pid later. Only the first line is the pid: a second line
/// must not make the record unreadable.
fn pid_file_text(pid: u32, start_token: Option<&str>) -> String {
    match start_token.filter(|token| valid_start_token(token)) {
        Some(token) => format!("{pid}\n{token}\n"),
        None => format!("{pid}\n"),
    }
}

fn pid_record(text: &str) -> Option<(u32, Option<String>)> {
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let pid = lines.next()?.parse::<u32>().ok()?;
    // 0 is this app's own process group and 1 is the init process. Neither is a stand-in, and a
    // pid file that says so is not a record of one.
    if pid <= 1 {
        return None;
    }
    let start = lines
        .next()
        .filter(|line| valid_start_token(line))
        .map(str::to_string);
    Some((pid, start))
}

/// A process start time: digits only, so a value read from disk cannot be anything but a number.
fn valid_start_token(token: &str) -> bool {
    (1..=32).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_digit())
}

/// The start time this app recorded for `pid`, or none when the pid file has none (an older
/// run, or a file somebody wrote) or names another pid.
fn recorded_start(stack_dir: &Path, pid: u32) -> Option<String> {
    let text = std::fs::read_to_string(stack_dir.join("emulate.pid")).ok()?;
    let (file_pid, start) = pid_record(&text)?;
    (file_pid == pid).then_some(start).flatten()
}

fn stop_with(
    stack_dir: &Path,
    probe: impl Fn(u32) -> Probe,
    kill: impl Fn(u32) -> Kill,
) -> Result<(), String> {
    let path = stack_dir.join("emulate.pid");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("The stand-in's pid couldn't be read: {error}")),
    };
    let Some((pid, _)) = pid_record(&text) else {
        remove_if_unchanged(&path, &text);
        return Ok(());
    };
    match probe(pid) {
        // The pid now names another program, or nothing: a stale entry, not a stand-in.
        Probe::NotOurs | Probe::Gone => {
            remove_if_unchanged(&path, &text);
            Ok(())
        }
        // The process may still hold this stack's ports. Keep the pid file so the next stop
        // can try again, and say in plain words how to end it now.
        Probe::Unknown => Err(STILL_RUNNING_NOTE.to_string()),
        Probe::Ours => {
            // `kill` looks again at the moment it acts. A stand-in that exited in between,
            // or a pid given to another program, is not a stand-in still running: the stack
            // has none, so the file goes and the stop is a success.
            match kill(pid) {
                Kill::Killed | Kill::Gone | Kill::NotOurs => {
                    remove_if_unchanged(&path, &text);
                    Ok(())
                }
                Kill::Failed => Err(STILL_RUNNING_NOTE.to_string()),
            }
        }
    }
}

/// Remove the pid file only if it still says what this stop read. A stop can take seconds, and
/// a start that came in meanwhile has written the record of a stand-in that is running.
fn remove_if_unchanged(path: &Path, read: &str) {
    if std::fs::read_to_string(path).is_ok_and(|now| now == read) {
        let _ = std::fs::remove_file(path);
    }
}

/// Whether `command` runs the stand-in on this stack's seed: `--seed <stack>/emulate.config.json`
/// as one whole argument. Every file in a stack's folder is called `emulate.<something>`, so a
/// command that merely names the folder or the log (`tail -f`, `less`, an editor) is not it, and
/// neither is one that names a longer stack id or a path inside some other folder.
fn names_seed(command: &str, stack_dir: &Path) -> bool {
    let config = stack_dir.join("emulate.config.json");
    let flag = format!("--seed {}", config.to_string_lossy());
    command.match_indices(&flag).any(|(at, _)| {
        let before = command[..at].chars().next_back();
        let after = command[at + flag.len()..].chars().next();
        before.is_none_or(char::is_whitespace) && after.is_none_or(char::is_whitespace)
    })
}

/// Whether a program's file is Node's: `node` or `node.exe`, in whatever folder.
fn image_is_node(image: &str) -> bool {
    let name = image.rsplit(['/', '\\']).next().unwrap_or(image);
    name.eq_ignore_ascii_case("node") || name.eq_ignore_ascii_case("node.exe")
}

/// What could be read about one pid. A missing field is not proof of anything.
struct ProcessFacts {
    image: Option<String>,
    command: Option<String>,
    start_token: Option<String>,
    alive: bool,
}

/// Whether the live process is the stand-in this stack started.
///
/// Proof is the start time this app recorded when it started the process, found again on the
/// live one, with the program being node, and, where the command line can be read, the command
/// being node running the stand-in on this stack's seed. A pid file with no start time is never
/// proof: the process is `Unknown` and is not signalled. A different start time is `NotOurs`,
/// whatever the command line says.
fn classify_stand_in(
    stack_dir: &Path,
    recorded_start: Option<&str>,
    facts: &ProcessFacts,
) -> Probe {
    let start_mismatch = matches!(
        (recorded_start, facts.start_token.as_deref()),
        (Some(recorded), Some(live)) if recorded != live
    );
    if start_mismatch {
        return Probe::NotOurs;
    }
    let node = facts.image.as_deref().is_some_and(image_is_node);
    // A program that is plainly not node is another program.
    if facts.image.is_some() && !node {
        return Probe::NotOurs;
    }
    if let Some(command) = facts.command.as_deref() {
        if !names_seed(command, stack_dir) {
            // Another stack's stand-in, or this one under a folder that moved, is not ours
            // to end and not provably a recycled pid either. Anything else is another program.
            return if command.contains("emulate") {
                Probe::Unknown
            } else {
                Probe::NotOurs
            };
        }
    }
    let start_matches = matches!(
        (recorded_start, facts.start_token.as_deref()),
        (Some(recorded), Some(live)) if recorded == live
    );
    if start_matches && node {
        return Probe::Ours;
    }
    if facts.alive || node {
        // Alive, but not provably ours: no start time recorded or readable, or no program name.
        return Probe::Unknown;
    }
    Probe::Gone
}

/// The start time of `pid` as digits, in the form the pid file holds.
///
/// Linux: field 22 of `/proc/<pid>/stat`, in clock ticks since boot.
#[cfg(target_os = "linux")]
fn unix_start_token(pid: u32) -> Option<String> {
    start_ticks_from_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// macOS: the process's start time from `proc_pidinfo`, in microseconds.
#[cfg(target_os = "macos")]
fn unix_start_token(pid: u32) -> Option<String> {
    let pid = i32::try_from(pid).ok()?;
    // SAFETY: an all-zero `proc_bsdinfo` is a valid value for a struct of plain numbers.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is a writable struct of exactly `size` bytes that outlives the call.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    let micros = info
        .pbi_start_tvsec
        .checked_mul(1_000_000)?
        .checked_add(info.pbi_start_tvusec)?;
    (micros != 0).then(|| micros.to_string())
}

/// Another Unix has no start time this app reads, so it never has a stand-in it could end.
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn unix_start_token(_pid: u32) -> Option<String> {
    None
}

/// The 22nd field of `/proc/<pid>/stat`. The name (field 2) is in parentheses and may hold
/// spaces and parentheses of its own, so the fields are counted from the last `)`.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn start_ticks_from_stat(stat: &str) -> Option<String> {
    let after_name = &stat[stat.rfind(')')? + 1..];
    // After the name come the state (field 3) and then 18 more fields before the start time.
    let ticks = after_name.split_whitespace().nth(19)?;
    valid_start_token(ticks).then(|| ticks.to_string())
}

#[cfg(unix)]
fn probe_stand_in(pid: u32, stack_dir: &Path) -> Probe {
    let Some(command) = command_of(pid) else {
        return if crate::proxy::routes::process_alive(pid) {
            Probe::Unknown
        } else {
            Probe::Gone
        };
    };
    let facts = ProcessFacts {
        image: program_of(pid),
        command: Some(command),
        start_token: unix_start_token(pid),
        alive: true,
    };
    classify_stand_in(stack_dir, recorded_start(stack_dir, pid).as_deref(), &facts)
}

#[cfg(unix)]
fn command_of(pid: u32) -> Option<String> {
    ps_column("command=", pid)
}

/// The program's file (a full path on macOS, the short name on Linux).
#[cfg(unix)]
fn program_of(pid: u32) -> Option<String> {
    ps_column("comm=", pid)
}

#[cfg(unix)]
fn ps_column(column: &str, pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", column, "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// How long a stand-in gets to end on SIGTERM before it is looked at again.
#[cfg(unix)]
const TERM_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

/// Whether anything is still in the process group `pid` leads. While any process is in a
/// group, its id cannot be given to another program, so a group that answers here, having
/// answered at every look since the stand-in was signalled, is the stand-in's own: its leader
/// may be gone and a child that ignored SIGTERM may be what is left.
#[cfg(unix)]
fn group_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks for the group; it sends nothing. `pid > 1` keeps the target
    // a real group: `-1` would be every process the user owns.
    pid > 1 && unsafe { libc::kill(-pid, 0) } == 0
}

/// SIGTERM the stand-in's process group; if the group is still there when the wait is over, and
/// has been at every look, SIGKILL it. The group, not the leader, is what is looked at: a child
/// that ignores SIGTERM outlives a leader that does not, and it is still the stand-in's.
/// A group that is not there at a look is never signalled again: its id could be anyone's.
///
/// `pid` 0 and 1 are never a group of ours: `kill(0, ..)` is this app's own group and
/// `kill(-1, ..)` is every process the user owns.
#[cfg(unix)]
fn end_group(
    pid: u32,
    grace: std::time::Duration,
    group_alive: impl Fn() -> bool,
    send: impl Fn(i32, i32),
) {
    let Ok(pid) = i32::try_from(pid) else {
        return;
    };
    if pid <= 1 {
        return;
    }
    send(-pid, libc::SIGTERM);
    let deadline = std::time::Instant::now() + grace;
    loop {
        if !group_alive() {
            return;
        }
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            break;
        }
        std::thread::sleep(left.min(std::time::Duration::from_millis(25)));
    }
    send(-pid, libc::SIGKILL);
}

/// Kill only when the pid is still this stack's stand-in, looked at again now. On Windows the
/// look and the kill are one open handle, so a pid reused in between is never ended.
#[cfg(unix)]
fn kill_if_still_ours(pid: u32, stack_dir: &Path) -> Kill {
    match probe_stand_in(pid, stack_dir) {
        Probe::Ours => {
            end_group(
                pid,
                TERM_GRACE,
                || group_alive(pid),
                |target, signal| {
                    // SAFETY: the pid was proved to be this stack's own stand-in just before
                    // this, and the group has been there at every look since.
                    unsafe {
                        libc::kill(target, signal);
                    }
                },
            );
            if ports_released(stack_dir) {
                Kill::Killed
            } else {
                Kill::Failed
            }
        }
        Probe::Gone => Kill::Gone,
        Probe::NotOurs => Kill::NotOurs,
        Probe::Unknown => Kill::Failed,
    }
}

/// How long a stopped stand-in's ports get to be let go of.
const PORTS_RELEASE_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// Whether something answers on a loopback port.
pub fn accepts_on_loopback(port: u16) -> bool {
    port != 0
        && std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
            std::time::Duration::from_millis(200),
        )
        .is_ok()
}

/// The ports the stand-in was given: each service's `port` in the seed it was started with.
fn stand_in_ports(stack_dir: &Path) -> Vec<u16> {
    let Ok(text) = std::fs::read_to_string(stack_dir.join("emulate.config.json")) else {
        return Vec::new();
    };
    let Ok(Value::Object(config)) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    config
        .values()
        .filter_map(|service| service.get("port")?.as_u64())
        .filter_map(|port| u16::try_from(port).ok())
        .collect()
}

/// Whether none of the stand-in's ports answers any more, after a moment's wait. A stand-in
/// that was ended but whose child still holds a port has not been stopped, and nothing could
/// find that child again once its pid file was gone.
fn ports_released(stack_dir: &Path) -> bool {
    let ports = stand_in_ports(stack_dir);
    let deadline = std::time::Instant::now() + PORTS_RELEASE_WAIT;
    loop {
        if ports.iter().all(|port| !accepts_on_loopback(*port)) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// The first look, on Windows: open the process, and judge it by its start time and image.
#[cfg(windows)]
fn probe_stand_in(pid: u32, stack_dir: &Path) -> Probe {
    use super::process_win::{OpenFailure, Process};
    match Process::open(pid, false) {
        Err(OpenFailure::Gone) => Probe::Gone,
        Err(OpenFailure::Refused) => Probe::Unknown,
        Ok(process) => probe_held(&process, pid, stack_dir),
    }
}

/// Judge an open process. A process that has ended is gone, whatever else its handle says.
#[cfg(windows)]
fn probe_held(process: &super::process_win::Process, pid: u32, stack_dir: &Path) -> Probe {
    if process.exited() {
        return Probe::Gone;
    }
    let recorded = recorded_start(stack_dir, pid);
    let facts = ProcessFacts {
        image: process.image_name(),
        command: None,
        start_token: process.start_token(),
        alive: true,
    };
    classify_stand_in(stack_dir, recorded.as_deref(), &facts)
}

/// The second look and the kill, on one handle, for a stand-in this app did not start in this
/// run (a job is what ends the ones it did). The process is opened once, compared with the
/// start time this app recorded when it started it, and ended through that same handle, so a
/// pid that was reused between the first look and now is never the process that is ended.
#[cfg(windows)]
fn kill_if_still_ours(pid: u32, stack_dir: &Path) -> Kill {
    use super::process_win::{OpenFailure, Process};
    let process = match Process::open(pid, true) {
        Ok(process) => process,
        Err(OpenFailure::Gone) => return Kill::Gone,
        Err(OpenFailure::Refused) => return Kill::Failed,
    };
    match probe_held(&process, pid, stack_dir) {
        Probe::Ours => {
            if process.terminate() {
                if ports_released(stack_dir) {
                    Kill::Killed
                } else {
                    Kill::Failed
                }
            } else if process.exited() {
                Kill::Gone
            } else {
                Kill::Failed
            }
        }
        Probe::Gone => Kill::Gone,
        Probe::NotOurs => Kill::NotOurs,
        Probe::Unknown => Kill::Failed,
    }
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

    /// `node --version` runs while the app opens. A `node` that never answers (a shim waiting on
    /// the network, a version manager updating itself) is ended after a moment and the stack
    /// gets a note, instead of holding the window until it does.
    #[cfg(unix)]
    #[test]
    fn a_node_that_never_answers_is_ended_and_noted() {
        use std::os::unix::fs::PermissionsExt;
        let temp = Temp::new("node-slow");
        let bin = temp.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        let status = probe_node_within(
            Some(format!("{}:/usr/bin:/bin", bin.display())),
            Duration::from_millis(300),
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the probe waited for a node that never answers"
        );
        match status {
            NodeStatus::Unavailable(note) => assert!(note.contains("in time"), "{note}"),
            other => panic!("a node that never answered was taken as {other:?}"),
        }
        // The wait the app uses is short.
        assert!(NODE_PROBE_WAIT <= Duration::from_secs(10));
    }

    /// A `node` that is a shim starts the real node and exits, and the real one keeps the pipe
    /// that `--version` is read from. Reading to the end after the shim exited waited for it.
    #[cfg(unix)]
    #[test]
    fn a_node_whose_child_keeps_the_pipe_open_does_not_hold_the_probe() {
        use std::os::unix::fs::PermissionsExt;
        let temp = Temp::new("node-pipe");
        let bin = temp.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, "#!/bin/sh\nsleep 12 &\necho v24.0.0\nexit 0\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        let status = probe_node_within(
            Some(format!("{}:/usr/bin:/bin", bin.display())),
            Duration::from_secs(2),
        );
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "the probe waited for a child that holds the pipe: {:?}",
            started.elapsed()
        );
        // What the shim printed before it exited is the answer.
        assert!(
            matches!(&status, NodeStatus::Ready { major: 24, .. }),
            "{status:?}"
        );
    }

    /// The pipe that never closes and prints nothing is a node that did not answer in time.
    #[cfg(unix)]
    #[test]
    fn a_node_that_exits_and_leaves_the_pipe_open_with_no_answer_is_noted() {
        use std::os::unix::fs::PermissionsExt;
        let temp = Temp::new("node-pipe-silent");
        let bin = temp.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, "#!/bin/sh\nsleep 12 &\nexit 0\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        let status = probe_node_within(
            Some(format!("{}:/usr/bin:/bin", bin.display())),
            Duration::from_secs(2),
        );
        assert!(started.elapsed() < Duration::from_secs(8));
        assert!(matches!(status, NodeStatus::Unavailable(_)), "{status:?}");
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
        assert_eq!(
            real_target("user@api.linear.app/x").as_deref(),
            Some("api.linear.app")
        );
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
        // Nothing in the package may rewrite the process title: the stop finds the stand-in by the
        // `--seed <stack>/emulate.config.json` argument in its command line.
        let titled = files_mentioning(&tool_dir(&temp.0), "process.title");
        println!("files that mention process.title: {titled:?}");
        assert!(
            titled.is_empty(),
            "the package sets its process title: {titled:?}"
        );
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
            // The app hands the child its login shell's PATH. With none, `node` is looked up in
            // the system's default path only, which is not where a version manager puts it.
            path_env: std::env::var("PATH").ok(),
        }) {
            Ok(pid) => pid,
            Err(error) => panic!("the stand-in didn't start: {error}"),
        };
        // Whatever happens next, the process this test started is stopped before it ends.
        let answered = wait_for_status(port, Duration::from_secs(60));
        // What the system shows for the real stand-in, and what the stop makes of it. If emulate
        // changed its process title, the command line would no longer carry `--seed`, and a real
        // stand-in would never be recognised as ours.
        #[cfg(unix)]
        let probe = {
            println!("the stand-in's command: {:?}", command_of(pid));
            println!("the stand-in's program: {:?}", program_of(pid));
            println!(
                "the stand-in's start time: {:?}, recorded: {:?}",
                unix_start_token(pid),
                recorded_start(&stack_dir, pid)
            );
            let probe = probe_stand_in(pid, &stack_dir);
            println!("the stand-in is probed as: {probe:?}");
            probe
        };
        let stopped = stop(&stack_dir);
        let line = match answered {
            Some(line) => line,
            None => panic!("nothing answered on 127.0.0.1:{port}"),
        };
        println!("the stand-in answered: {line}");
        #[cfg(unix)]
        assert_eq!(
            probe,
            Probe::Ours,
            "a real stand-in is not recognised as ours"
        );
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

    /// The JavaScript files under `dir` whose text contains `needle`.
    fn files_mentioning(dir: &Path, needle: &str) -> Vec<String> {
        let mut found = Vec::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(next) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&next) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if path
                    .extension()
                    .is_some_and(|ext| ext == "js" || ext == "mjs" || ext == "cjs")
                    && std::fs::read_to_string(&path).is_ok_and(|text| text.contains(needle))
                {
                    found.push(path.display().to_string());
                }
            }
        }
        found
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

    fn wait_until_accepts(port: u16, within: Duration) -> bool {
        let deadline = std::time::Instant::now() + within;
        loop {
            if accepts_on_loopback(port) {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
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

    /// A real `node` that is, to the system, the stand-in of `stack_dir`: it runs
    /// `-- start --seed <stack>/emulate.config.json --host 127.0.0.1` as its own process group,
    /// and its pid file holds the start time, as `start` writes it. `None` where `node` is not
    /// installed; the caller skips.
    #[cfg(unix)]
    pub(crate) fn node_stand_in(stack_dir: &Path) -> Option<std::process::Child> {
        use std::os::unix::process::CommandExt;
        std::fs::create_dir_all(stack_dir).ok()?;
        let child = Command::new("node")
            .args(["-e", "setTimeout(() => {}, 30000)", "--", "start", "--seed"])
            .arg(stack_dir.join("emulate.config.json"))
            .args(["--host", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .ok()?;
        let token = unix_start_token(child.id());
        std::fs::write(
            stack_dir.join("emulate.pid"),
            pid_file_text(child.id(), token.as_deref()),
        )
        .ok()?;
        Some(child)
    }

    fn pid_file(stack: &Path, pid: u32) {
        std::fs::create_dir_all(stack).unwrap();
        std::fs::write(stack.join("emulate.pid"), format!("{pid}\n")).unwrap();
    }

    #[test]
    fn a_stand_in_whose_command_names_this_stack_is_stopped() {
        let temp = Temp::new("stop-ours");
        let stack = temp.0.join("stack");
        pid_file(&stack, 4242);
        let killed = Mutex::new(Vec::new());
        stop_with(
            &stack,
            |_| Probe::Ours,
            |pid| {
                killed.lock().unwrap().push(pid);
                Kill::Killed
            },
        )
        .unwrap();
        assert_eq!(*killed.lock().unwrap(), vec![4242]);
        assert!(!stack.join("emulate.pid").exists());
    }

    #[test]
    fn a_pid_that_cannot_be_proved_is_kept_and_the_error_says_what_to_do() {
        let temp = Temp::new("stop-unknown");
        let stack = temp.0.join("stack");
        pid_file(&stack, 4242);
        let killed = Mutex::new(Vec::new());
        let error = stop_with(
            &stack,
            |_| Probe::Unknown,
            |pid| {
                killed.lock().unwrap().push(pid);
                Kill::Killed
            },
        )
        .unwrap_err();
        assert!(error.contains("still running"), "{error}");
        // Not forgotten: the next stop, or the person, can still find it.
        assert!(stack.join("emulate.pid").exists());
        assert!(killed.lock().unwrap().is_empty());
    }

    #[test]
    fn a_recycled_pid_is_neither_killed_nor_kept() {
        let temp = Temp::new("stop-recycled");
        let stack = temp.0.join("stack");
        pid_file(&stack, 4242);
        let killed = Mutex::new(Vec::new());
        stop_with(
            &stack,
            |_| Probe::NotOurs,
            |pid| {
                killed.lock().unwrap().push(pid);
                Kill::Killed
            },
        )
        .unwrap();
        assert!(killed.lock().unwrap().is_empty());
        assert!(!stack.join("emulate.pid").exists());
    }

    #[test]
    fn a_pid_that_is_gone_is_forgotten() {
        let temp = Temp::new("stop-gone");
        let stack = temp.0.join("stack");
        pid_file(&stack, 4242);
        let killed = Mutex::new(Vec::new());
        stop_with(
            &stack,
            |_| Probe::Gone,
            |pid| {
                killed.lock().unwrap().push(pid);
                Kill::Killed
            },
        )
        .unwrap();
        assert!(killed.lock().unwrap().is_empty());
        assert!(!stack.join("emulate.pid").exists());
    }

    /// Identity is the recorded start time, node, and node running the stand-in on this stack's
    /// seed: all of them, read from the live process.
    #[cfg(unix)]
    #[test]
    fn a_process_is_ours_only_by_start_time_and_node_running_this_stacks_seed() {
        let temp = Temp::new("probe");
        let stack = temp.0.join("stack");
        let Some(mut node) = node_stand_in(&stack) else {
            println!("skipped: node is not installed");
            return;
        };
        assert_eq!(probe_stand_in(node.id(), &stack), Probe::Ours);
        // The seed of another stack is another stack's stand-in: kept, never ended.
        let other = temp.0.join("other");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(probe_stand_in(node.id(), &other), Probe::Unknown);
        // A start time that is not this process's: the pid was given to another program.
        std::fs::write(
            stack.join("emulate.pid"),
            pid_file_text(node.id(), Some("1")),
        )
        .unwrap();
        assert_eq!(probe_stand_in(node.id(), &stack), Probe::NotOurs);
        // No start time recorded at all: never proof, however much the command line says.
        std::fs::write(stack.join("emulate.pid"), pid_file_text(node.id(), None)).unwrap();
        assert_eq!(probe_stand_in(node.id(), &stack), Probe::Unknown);
        let _ = node.kill();
        let _ = node.wait();
    }

    /// The end of a stand-in: its group gets SIGTERM, and SIGKILL only if the group has been
    /// there at every look since. While any process is in a group its id cannot be given to
    /// another program, so a group that is still there is the stand-in's own, whether or not its
    /// leader has gone; a group that is gone could be anyone's by the next look.
    #[cfg(unix)]
    #[test]
    fn the_kill_after_the_wait_is_sent_only_while_the_group_is_still_there() {
        let looks = std::cell::Cell::new(0);
        // The wait is a deadline, not a count of looks: a busy runner can sleep well past each 25 ms step. A group that
        // goes part way gets a wait long enough to reach its last look on any runner (it returns as soon as the group
        // is gone, so the test stays quick); only the group that never goes waits the short one out.
        for (gone_after, grace, expected) in [
            // Never gone: it ignored SIGTERM, so it gets SIGKILL.
            (
                usize::MAX,
                Duration::from_millis(200),
                vec![libc::SIGTERM, libc::SIGKILL],
            ),
            // Gone at the first look: nothing more is sent.
            (0, Duration::from_secs(30), vec![libc::SIGTERM]),
            // Gone part way through the wait: nothing more is sent.
            (3, Duration::from_secs(30), vec![libc::SIGTERM]),
        ] {
            looks.set(0);
            let sent = Mutex::new(Vec::new());
            end_group(
                4242,
                grace,
                || {
                    looks.set(looks.get() + 1);
                    looks.get() <= gone_after
                },
                |target, signal| sent.lock().unwrap().push((target, signal)),
            );
            let sent = sent.into_inner().unwrap();
            assert_eq!(
                sent.iter().map(|(_, signal)| *signal).collect::<Vec<_>>(),
                expected,
                "group gone after {gone_after} looks"
            );
            // Always the whole group, never a bare pid.
            assert!(sent.iter().all(|(target, _)| *target == -4242));
        }
    }

    /// `kill(0, ...)` is this app's own group and `kill(-1, ...)` is every process the user owns.
    /// No pid read from a file, however it got there, may make a signal go to either.
    #[cfg(unix)]
    #[test]
    fn a_pid_that_would_mean_every_process_or_our_own_group_is_never_signalled() {
        for pid in [0u32, 1, u32::MAX, u32::MAX / 2 + 7] {
            let sent = Mutex::new(Vec::new());
            end_group(
                pid,
                Duration::from_millis(1),
                || true,
                |target, signal| sent.lock().unwrap().push((target, signal)),
            );
            let sent = sent.into_inner().unwrap();
            assert!(sent.is_empty(), "pid {pid} was signalled: {sent:?}");
        }
        // And a pid file that holds one is not a record of a stand-in at all.
        assert_eq!(pid_record("0\n100\n"), None);
        assert_eq!(pid_record("1\n100\n"), None);
        assert_eq!(pid_record("2\n100\n").map(|(pid, _)| pid), Some(2));
    }

    /// The stand-in ends on SIGTERM and a child of it, in its group, ignores SIGTERM and holds
    /// the port. The leader going away must not end the stop: the child is still the stand-in's,
    /// and nothing could find it again once its pid file was gone.
    #[cfg(unix)]
    #[test]
    fn a_child_that_ignores_sigterm_is_ended_with_the_stand_in() {
        let temp = Temp::new("stop-stubborn");
        let port = free_port();
        let script = "const { spawn } = require('node:child_process');\n\
            const fs = require('node:fs');\n\
            const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--seed') + 1], 'utf8'));\n\
            const serve = `process.on('SIGTERM', () => {}); require('node:net').createServer().listen(${config.github.port}, '127.0.0.1'); setTimeout(() => process.exit(0), 20000)`;\n\
            spawn(process.execPath, ['-e', serve], { stdio: 'ignore' });\n\
            setTimeout(() => {}, 60000);\n";
        let Some(stack) = start_scripted(&temp, script, port) else {
            return;
        };
        assert!(
            wait_until_accepts(port, Duration::from_secs(15)),
            "the child never started listening on {port}"
        );
        let result = stop(&stack);
        let released = wait_until_gone(port, Duration::from_secs(5));
        // The child ends itself after twenty seconds, so a failing test leaves nothing behind.
        assert!(
            released,
            "the child that ignores SIGTERM still holds port {port}"
        );
        result.unwrap();
        assert!(!stack.join("emulate.pid").exists());
    }

    /// A real stand-in is ended for real: found by its start time and command, signalled, and
    /// its pid file goes.
    #[cfg(unix)]
    #[test]
    fn a_node_stand_in_is_ended_by_stop() {
        let temp = Temp::new("stop-node");
        let stack = temp.0.join("stack");
        let Some(mut node) = node_stand_in(&stack) else {
            println!("skipped: node is not installed");
            return;
        };
        stop(&stack).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut ended = false;
        while std::time::Instant::now() < deadline {
            if node.try_wait().unwrap().is_some() {
                ended = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = node.kill();
        let _ = node.wait();
        assert!(ended, "the stand-in was not ended");
        assert!(!stack.join("emulate.pid").exists());
    }

    fn facts(
        image: Option<&str>,
        command: Option<&str>,
        start: Option<&str>,
        alive: bool,
    ) -> ProcessFacts {
        ProcessFacts {
            image: image.map(str::to_string),
            command: command.map(str::to_string),
            start_token: start.map(str::to_string),
            alive,
        }
    }

    #[test]
    fn a_reused_node_pid_is_not_this_stand_in() {
        let stack = Path::new("/stacks/s01234567");
        let ours = &format!(
            "node index.js start --seed {}",
            stack.join("emulate.config.json").display()
        );
        // The command line names this stack, but the start time is a different process.
        assert_eq!(
            classify_stand_in(
                stack,
                Some("100"),
                &facts(Some("node.exe"), Some(ours), Some("200"), true)
            ),
            Probe::NotOurs
        );
        // The same start time is the process this app launched, even with no command line.
        assert_eq!(
            classify_stand_in(
                stack,
                Some("100"),
                &facts(Some("node.exe"), None, Some("100"), true)
            ),
            Probe::Ours
        );
        // No start time was recorded: the command line is not enough, so it is never signalled.
        assert_eq!(
            classify_stand_in(
                stack,
                None,
                &facts(Some("node.exe"), Some(ours), None, true)
            ),
            Probe::Unknown
        );
        // Another node tree at the reused pid. Image alone used to count as proof.
        assert_eq!(
            classify_stand_in(
                stack,
                Some("100"),
                &facts(Some("node.exe"), Some("node other-app.js"), None, true)
            ),
            Probe::NotOurs
        );
        assert_eq!(
            classify_stand_in(stack, None, &facts(Some("node.exe"), None, None, true)),
            Probe::Unknown
        );
        assert_eq!(
            classify_stand_in(stack, None, &facts(Some("Finder.exe"), None, None, true)),
            Probe::NotOurs
        );
        assert_eq!(
            classify_stand_in(stack, None, &facts(None, None, None, false)),
            Probe::Gone
        );
    }

    /// The kill step looks again when it acts. A stand-in that cannot be ended is still running:
    /// the file stays and the sentence says how to end it by hand.
    #[test]
    fn a_kill_that_fails_keeps_the_file_and_says_it_is_still_running() {
        let temp = Temp::new("stop-failed");
        let stack = temp.0.join("stack");
        pid_file(&stack, 4242);
        let killed = Mutex::new(Vec::new());
        let error = stop_with(
            &stack,
            |_| Probe::Ours,
            |pid| {
                killed.lock().unwrap().push(pid);
                Kill::Failed
            },
        )
        .unwrap_err();
        assert!(error.contains("still running"), "{error}");
        assert!(stack.join("emulate.pid").exists());
        // The closure was asked, and it refused. Nothing else may be killed.
        assert_eq!(*killed.lock().unwrap(), vec![4242]);
    }

    /// A fake that exits between the first look and the kill used to be "still running": the
    /// stop failed and the pid file was kept for a process that was not there. It is gone, which
    /// is what a stop is for, so it is a success and the file goes. The same holds when the pid
    /// was given to another program in the gap, and nothing was ended.
    #[test]
    fn a_fake_that_is_gone_or_replaced_by_the_second_look_is_a_stop_that_worked() {
        for (outcome, name) in [(Kill::Gone, "gone"), (Kill::NotOurs, "reused")] {
            let temp = Temp::new(&format!("stop-{name}-race"));
            let stack = temp.0.join("stack");
            pid_file(&stack, 4242);
            stop_with(&stack, |_| Probe::Ours, |_| outcome).unwrap();
            assert!(
                !stack.join("emulate.pid").exists(),
                "the pid file of a stand-in that was {name} is still there"
            );
        }
    }

    /// Every file in a stack's folder is called `emulate.<something>`, so a person who tails the
    /// log, or opens it in `less`, has a command line that names `emulate` and the folder. On a
    /// pid the stack's pid file still holds, that was proof enough to end the whole process
    /// group at the next launch. Neither a pid file with no start time nor one with another
    /// process's start time may end anything.
    #[cfg(unix)]
    #[test]
    fn a_tail_of_the_stand_ins_log_on_the_recorded_pid_is_not_signalled() {
        use std::os::unix::process::CommandExt;
        for recorded in [None, Some("1")] {
            let temp = Temp::new("tail-reused");
            let stack = temp.0.join("stack");
            std::fs::create_dir_all(&stack).unwrap();
            let log = stack.join("emulate.log");
            std::fs::write(&log, "hello\n").unwrap();
            let mut tail = Command::new("tail")
                .arg("-f")
                .arg(&log)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap();
            std::thread::sleep(Duration::from_millis(100));
            std::fs::write(
                stack.join("emulate.pid"),
                pid_file_text(tail.id(), recorded),
            )
            .unwrap();
            let _ = stop(&stack);
            let alive = tail.try_wait().unwrap().is_none();
            let _ = tail.kill();
            let _ = tail.wait();
            assert!(
                alive,
                "a tail of the log was signalled (recorded start {recorded:?})"
            );
        }
    }

    /// The start time is read the way each system keeps it, and is the same every time for one
    /// live process.
    #[cfg(unix)]
    #[test]
    fn a_live_process_has_a_start_time_that_does_not_change() {
        let first = unix_start_token(std::process::id()).expect("a start time");
        assert!(valid_start_token(&first), "{first}");
        assert_eq!(
            unix_start_token(std::process::id()).as_deref(),
            Some(first.as_str())
        );
        // A process that does not exist has none.
        assert_eq!(unix_start_token(u32::MAX - 1), None);
    }

    /// `/proc/<pid>/stat`: the name is in parentheses and may hold spaces and parentheses, so the
    /// fields are counted from the last `)`. The start time is the 22nd field.
    #[test]
    fn the_start_time_is_the_22nd_field_after_the_name() {
        let stat = "1234 (node (x) y) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 5000 200 18446744073709551615";
        assert_eq!(start_ticks_from_stat(stat).as_deref(), Some("987654"));
        assert_eq!(start_ticks_from_stat("1234 (node) S 1"), None);
        assert_eq!(start_ticks_from_stat("garbage"), None);
    }

    /// A stop reads the pid file, looks at the process, and may wait seconds for a stand-in to
    /// end. In that time a start can write a new pid file for a new stand-in. Removing "the pid
    /// file" afterwards removed the new stand-in's record. Only the file that was read goes.
    #[test]
    fn a_pid_file_written_while_a_stop_ran_is_not_removed() {
        let new_record = "9999\n555\n";
        for (name, probe, kill) in [
            ("gone", Probe::Gone, Kill::Killed),
            ("reused", Probe::NotOurs, Kill::Killed),
            ("killed", Probe::Ours, Kill::Killed),
            ("exited before the kill", Probe::Ours, Kill::Gone),
            ("replaced before the kill", Probe::Ours, Kill::NotOurs),
        ] {
            let temp = Temp::new("stop-new-file");
            let stack = temp.0.join("stack");
            pid_file(&stack, 4242);
            let path = stack.join("emulate.pid");
            let rewrite = || std::fs::write(&path, new_record).unwrap();
            stop_with(
                &stack,
                |_| {
                    if probe != Probe::Ours {
                        rewrite();
                    }
                    probe
                },
                |_| {
                    rewrite();
                    kill
                },
            )
            .unwrap();
            assert_eq!(
                std::fs::read_to_string(&path).ok().as_deref(),
                Some(new_record),
                "the pid file a new start wrote was removed ({name})"
            );
        }
        // An unchanged file is still removed.
        let temp = Temp::new("stop-same-file");
        let stack = temp.0.join("stack");
        pid_file(&stack, 4242);
        stop_with(&stack, |_| Probe::Gone, |_| Kill::Gone).unwrap();
        assert!(!stack.join("emulate.pid").exists());
    }

    /// The stand-in is found by `--seed <stack>/emulate.config.json` as one whole argument. A
    /// command that names the folder or its log (`tail -f`, `less`), a longer stack id that
    /// starts like this one, or a path inside some other folder is not it.
    #[test]
    fn a_command_is_the_stand_in_only_by_its_own_seed_argument() {
        // Paths are joined the way this system joins them: a Windows command line has `\`.
        let seed = |dir: &str, file: &str| Path::new(dir).join(file).display().to_string();
        let stack = Path::new("/data/stacks/s0000a001");
        let ours = format!(
            "node /tools/emulate/index.js start --seed {} --host 127.0.0.1",
            seed("/data/stacks/s0000a001", "emulate.config.json")
        );
        let longer = format!(
            "node /tools/emulate/index.js start --seed {} --host 127.0.0.1",
            seed("/data/stacks/s0000a0010", "emulate.config.json")
        );
        let nested = format!(
            "node /tools/emulate/index.js start --seed {}",
            seed("/other/data/stacks/s0000a001", "emulate.config.json")
        );
        let tail = format!("tail -f {}", seed("/data/stacks/s0000a001", "emulate.log"));
        let other_file = format!(
            "node x.js --seed {}",
            seed("/data/stacks/s0000a001", "emulate.log")
        );
        let glued = format!(
            "node x.js --seed {}.bak",
            seed("/data/stacks/s0000a001", "emulate.config.json")
        );
        let (ours, longer, nested, tail, other_file, glued) = (
            ours.as_str(),
            longer.as_str(),
            nested.as_str(),
            tail.as_str(),
            other_file.as_str(),
            glued.as_str(),
        );
        for (command, expected) in [
            (ours, true),
            (longer, false),
            (nested, false),
            (tail, false),
            (other_file, false),
            (glued, false),
        ] {
            assert_eq!(names_seed(command, stack), expected, "{command}");
        }
        // A folder with a space in its name (macOS "Application Support") still matches.
        let spaced = Path::new("/Users/me/Library/Application Support/app/stacks/s1");
        let command = format!(
            "node /t/index.js start --seed {} --host 127.0.0.1",
            spaced.join("emulate.config.json").display()
        );
        assert!(names_seed(&command, spaced));
        // With the start time and node it is ours; the longer id's stand-in is another stack's.
        for (command, expected) in [(ours, Probe::Ours), (longer, Probe::Unknown)] {
            assert_eq!(
                classify_stand_in(
                    stack,
                    Some("100"),
                    &facts(
                        Some("/usr/local/bin/node"),
                        Some(command),
                        Some("100"),
                        true
                    )
                ),
                expected,
                "{command}"
            );
        }
        // A tail of the log with the very start time recorded is still not node.
        assert_eq!(
            classify_stand_in(
                stack,
                Some("100"),
                &facts(Some("/usr/bin/tail"), Some(tail), Some("100"), true)
            ),
            Probe::NotOurs
        );
        // No start time recorded: never ours, even for node with the right command.
        assert_eq!(
            classify_stand_in(
                stack,
                None,
                &facts(Some("node"), Some(ours), Some("100"), true)
            ),
            Probe::Unknown
        );
    }

    #[test]
    fn a_pid_file_keeps_its_pid_when_a_start_time_follows() {
        assert_eq!(
            pid_record("4242\n133000\n").unwrap(),
            (4242, Some("133000".to_string()))
        );
        assert_eq!(pid_record("4242\n").unwrap(), (4242, None));
        // A second line that is not a start time is ignored, not a reason to drop the pid.
        assert_eq!(pid_record("4242\nnot-a-time\n").unwrap(), (4242, None));
        assert_eq!(pid_record("nope\n"), None);
        // What is written is what is read back, and a token that is not digits is never written.
        assert_eq!(pid_file_text(4242, Some("133000")), "4242\n133000\n");
        assert_eq!(pid_file_text(4242, None), "4242\n");
        assert_eq!(pid_file_text(4242, Some("12;calc")), "4242\n");
        assert_eq!(
            pid_record(&pid_file_text(4242, Some("133000"))).unwrap(),
            (4242, Some("133000".to_string()))
        );
    }

    /// Windows only: real processes, so the handle calls are exercised and not just the rules.
    #[cfg(windows)]
    fn record_pid(stack: &Path, child: &std::process::Child) {
        std::fs::create_dir_all(stack).unwrap();
        let token = super::super::process_win::start_token_of_child(child);
        std::fs::write(
            stack.join("emulate.pid"),
            pid_file_text(child.id(), token.as_deref()),
        )
        .unwrap();
    }

    /// A pid that now belongs to another program is not ended, and its pid file goes.
    #[cfg(windows)]
    #[test]
    fn a_program_that_is_not_node_at_the_recorded_pid_is_left_running() {
        let temp = Temp::new("win-reused");
        let stack = temp.0.join("stack");
        let mut other = Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        record_pid(&stack, &other);
        stop(&stack).unwrap();
        let still_running = other.try_wait().unwrap().is_none();
        let _ = other.kill();
        let _ = other.wait();
        assert!(still_running, "another program was ended");
        assert!(!stack.join("emulate.pid").exists());
    }

    /// The stand-in is `node.exe`: found by its start time and image, then ended through the
    /// handle it was opened with. Skipped where Node is not installed.
    #[cfg(windows)]
    #[test]
    fn a_node_stand_in_is_ended_through_its_handle() {
        let temp = Temp::new("win-node");
        let stack = temp.0.join("stack");
        let Ok(mut node) = Command::new("node")
            .args(["-e", "setTimeout(() => {}, 30000)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            println!("skipped: node is not installed");
            return;
        };
        record_pid(&stack, &node);
        let result = stop(&stack);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut ended = false;
        while std::time::Instant::now() < deadline {
            if node.try_wait().unwrap().is_some() {
                ended = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = node.kill();
        let _ = node.wait();
        result.unwrap();
        assert!(ended, "the node stand-in is still running");
        assert!(!stack.join("emulate.pid").exists());
    }

    fn node_is_installed() -> bool {
        Command::new("node")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// Starts a stand-in made by `script` (a node program that gets `start --seed <config>`)
    /// for a service on `port`, the way `start` does. `None` where node is not installed.
    fn start_scripted(temp: &Temp, script: &str, port: u16) -> Option<PathBuf> {
        if !node_is_installed() {
            println!("skipped: node is not installed");
            return None;
        }
        let stack = temp.0.join("stack");
        let tool = temp.0.join("index.js");
        std::fs::write(&tool, script).unwrap();
        let (config, _) = write_config(
            &stack,
            &[ServicePort {
                service: "github".into(),
                port,
                base_url: format!("http://github.shop.localhost:{port}"),
            }],
        )
        .unwrap();
        start(&StartRequest {
            stack_dir: stack.clone(),
            config,
            tool,
            path_env: std::env::var("PATH").ok(),
        })
        .unwrap_or_else(|error| panic!("the scripted stand-in did not start: {error}"));
        Some(stack)
    }

    /// A stand-in that starts the real server as a child and waits for it, which is what a
    /// Volta or Scoop `node` shim does. Ending only the pid the stack recorded leaves the child
    /// holding the port, and with the pid file gone nothing could find it again.
    #[test]
    fn stopping_a_stand_in_ends_what_it_started_too() {
        let temp = Temp::new("stop-tree");
        let port = free_port();
        let script = "const { spawn } = require('node:child_process');\n\
            const fs = require('node:fs');\n\
            const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--seed') + 1], 'utf8'));\n\
            const serve = `require('node:net').createServer().listen(${config.github.port}, '127.0.0.1')`;\n\
            spawn(process.execPath, ['-e', serve], { stdio: 'ignore' });\n\
            setTimeout(() => {}, 60000);\n";
        let Some(stack) = start_scripted(&temp, script, port) else {
            return;
        };
        assert!(
            wait_until_accepts(port, Duration::from_secs(15)),
            "the child never started listening on {port}"
        );
        let result = stop(&stack);
        let released = wait_until_gone(port, Duration::from_secs(5));
        assert!(
            released,
            "the child of the stand-in still holds port {port}"
        );
        result.unwrap();
        assert!(!stack.join("emulate.pid").exists());
    }

    /// A stand-in that was ended while one of its ports is still answering has not been stopped:
    /// the pid file stays, so the next stop can look again, and the sentence says it is running.
    #[test]
    fn a_port_still_held_after_the_stop_keeps_the_pid_file() {
        let temp = Temp::new("stop-held");
        // The port is held by something that is not the stand-in.
        let stranger = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = stranger.local_addr().unwrap().port();
        let script = "setTimeout(() => {}, 60000);\n";
        let Some(stack) = start_scripted(&temp, script, port) else {
            return;
        };
        let error = stop(&stack).unwrap_err();
        assert!(error.contains("still running"), "{error}");
        assert!(stack.join("emulate.pid").exists());
        drop(stranger);
        // The stand-in is gone by now, and with the port free the next stop finishes the job.
        stop(&stack).unwrap();
        assert!(!stack.join("emulate.pid").exists());
    }

    #[test]
    fn the_windows_allow_list_has_system_root_and_no_secrets() {
        assert!(WINDOWS_CHILD_ENV_KEYS.contains(&"SystemRoot"));
        assert_eq!(
            WINDOWS_CHILD_ENV_KEYS,
            [
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
                "TEMP",
                "TMP",
                "SystemRoot",
            ]
        );
        for key in WINDOWS_CHILD_ENV_KEYS {
            let upper = key.to_ascii_uppercase();
            assert!(!upper.contains("TOKEN"), "{key}");
            assert!(!upper.contains("SECRET"), "{key}");
            assert!(!upper.contains("KEY"), "{key}");
        }
    }

    #[test]
    fn the_env_name_is_the_services_uppercase_name() {
        assert_eq!(env_name("github"), "GITHUB_BASE_URL");
        assert_eq!(env_name("mongoatlas"), "MONGOATLAS_BASE_URL");
    }
}
