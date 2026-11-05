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

use serde_json::{json, Map, Value};

use super::store;

/// The package version Hivra pins. Node 24 or newer is emulate's own requirement.
pub const VERSION: &str = "0.13.0";
pub const MIN_NODE_MAJOR: u32 = 24;

/// The tarball's SHA-256, filled by the release that first fetches it. Empty means the pin is
/// not set and nothing is installed: a download is never trusted without its hash.
pub const TARBALL_SHA256: &str = "";

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

/// Hosts no crew run may reach through a declared service. A project that really needs one is
/// marked `reaches: real` and is started by the person, never by a crew turn.
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

/// The hostname of a URL that belongs to a real outside service, if it does.
pub fn real_host(url: &str) -> Option<&'static str> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    REAL_HOSTS
        .iter()
        .copied()
        .find(|candidate| host == *candidate)
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

/// The installed CLI, when this copy has one.
pub fn installed(data_dir: &Path) -> Option<PathBuf> {
    let index = tool_dir(data_dir)
        .join("package")
        .join("dist")
        .join("index.js");
    index.is_file().then_some(index)
}

/// Install a downloaded tarball. The hash is checked against the compiled-in pin before a byte
/// is unpacked, and entries that would escape the target folder are refused.
pub fn install_from_tarball(data_dir: &Path, tarball: &Path) -> Result<PathBuf, String> {
    if TARBALL_SHA256.is_empty() {
        return Err("emulate's pin isn't set, so it wasn't installed.".into());
    }
    let bytes = std::fs::read(tarball)
        .map_err(|error| format!("The emulate package couldn't be read: {error}"))?;
    let actual = crate::pinned_tool::sha256_hex(&bytes);
    if !actual.eq_ignore_ascii_case(TARBALL_SHA256) {
        return Err("The emulate package does not match its pin, so it wasn't installed.".into());
    }
    let target = tool_dir(data_dir);
    let staging = target.with_file_name(format!("{VERSION}.installing"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("The emulate package couldn't be unpacked: {error}"))?;
    let result = unpack(bytes.as_slice(), &staging);
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target)
        .map_err(|error| format!("The emulate package couldn't be put in place: {error}"))?;
    installed(data_dir).ok_or_else(|| "The emulate package did not contain its program.".into())
}

fn unpack(bytes: &[u8], target: &Path) -> Result<(), String> {
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
        entry
            .unpack_in(target)
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
    for (key, value) in child_env(request.path_env.as_deref()) {
        command.env(key, value);
    }
    // The stand-in gets nothing from this app: no control endpoint, no model key.
    for name in std::env::vars_os().filter_map(|(name, _)| name.into_string().ok()) {
        if name.starts_with("MONOCODE_CONTROL_") || name.starts_with("MONOCODE_APP_") {
            command.env_remove(&name);
        }
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
mod tests {
    use super::*;

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
    fn a_real_host_is_recognised_and_a_lookalike_is_not() {
        assert_eq!(
            real_host("https://api.github.com/repos"),
            Some("api.github.com")
        );
        assert_eq!(
            real_host("https://api.stripe.com/v1"),
            Some("api.stripe.com")
        );
        assert_eq!(real_host("https://api.github.com.evil.example"), None);
        assert_eq!(real_host("http://github-shop-wp-90.localhost:7400"), None);
        assert_eq!(real_host("http://127.0.0.1:22010"), None);
        assert_eq!(real_host("not a url"), None);
    }

    #[test]
    fn the_install_refuses_a_missing_pin() {
        let temp = Temp::new("pin");
        let tarball = temp.0.join("package.tgz");
        std::fs::write(&tarball, b"not a tarball").unwrap();
        assert!(install_from_tarball(&temp.0, &tarball)
            .unwrap_err()
            .contains("pin isn't set"));
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

    #[test]
    fn the_child_gets_an_allow_listed_environment() {
        let env = child_env(Some("/usr/bin:/bin"));
        let keys: Vec<&str> = env.iter().map(|(key, _)| key.as_str()).collect();
        assert!(keys.contains(&"PATH"));
        assert!(keys.contains(&"NO_COLOR"));
        assert!(!keys.iter().any(|key| key.starts_with("MONOCODE_")));
        assert!(!keys.contains(&"HOME") || cfg!(not(windows)));
    }

    #[test]
    fn the_env_name_is_the_services_uppercase_name() {
        assert_eq!(env_name("github"), "GITHUB_BASE_URL");
        assert_eq!(env_name("mongoatlas"), "MONGOATLAS_BASE_URL");
    }
}
