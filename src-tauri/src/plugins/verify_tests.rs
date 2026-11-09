//! WP-42: Verify installs from the pinned index (the package is stubbed, never downloaded), a worker session gets its
//! MCP server, a web or mobile project is offered it, and `.e2e/` proof is attached to that worker's report.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use super::compat::Target;
use super::discover::{self, Status};
use super::fsutil;
use super::install::{self, InstallResult, RequestedBy};
use super::manifest::PLUGIN_SCHEMA_1_0_0;
use super::registry::{self, Host, Scope};
use super::source::{InstallSource, Tools};
use super::verify::{self, WHEN_TO_VERIFY};
use super::wiring;
use crate::delegations::{self, RecordInput, SettleInput, StallInput};
use crate::firstmate::report::WorkerReport;
use crate::session_store::SessionStore;

const MARKER: &str = "MARKER-KEEP";
const STUB: &str = r#"#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const args = process.argv.slice(2);
const cmd = args[0];
const dir = __dirname;
function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}
if (cmd === "view") {
  const bytes = fs.readFileSync(path.join(dir, "e2e.tgz"));
  const hash = crypto.createHash("sha512").update(bytes).digest("base64");
  const version = fs.readFileSync(path.join(dir, "version.txt"), "utf8").trim();
  process.stdout.write(JSON.stringify({ version, dist: { integrity: "sha512-" + hash } }));
  process.exit(0);
}
if (cmd === "pack") {
  const at = args.indexOf("--pack-destination");
  if (at < 0 || !args[at + 1]) fail("no destination");
  const filename = "e2e.tgz";
  fs.copyFileSync(path.join(dir, filename), path.join(args[at + 1], filename));
  process.stdout.write(JSON.stringify([{ filename }]));
  process.exit(0);
}
if (cmd === "install") process.exit(0);
fail("unexpected " + args.join(" "));
"#;

struct Tmp(PathBuf);

impl Tmp {
    fn new(label: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("hivra wp42 {label} plüg {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(fsutil::canonical(&dir).unwrap())
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn plugin_host(tmp: &Tmp) -> Host {
    let host = Host {
        root: tmp.path().join("app data/plugins"),
        agents_skills: tmp.path().join("home/.agents/skills"),
    };
    std::fs::create_dir_all(&host.root).unwrap();
    host
}

fn quiet_tools() -> Tools {
    Tools {
        git: OsString::from("git-must-not-run"),
        npm: OsString::from("npm-must-not-run"),
        path: None,
        target: Target::here(),
    }
}

fn npm_tools(dir: &Path) -> Tools {
    let js = dir.join("npm-stub.js");
    std::fs::write(&js, STUB).unwrap();
    #[cfg(unix)]
    let program = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&js, std::fs::Permissions::from_mode(0o755)).unwrap();
        js
    };
    #[cfg(windows)]
    let program = {
        let cmd = dir.join("npm-stub.cmd");
        std::fs::write(&cmd, "@echo off\r\nnode \"%~dp0npm-stub.js\" %*\r\n").unwrap();
        cmd
    };
    Tools {
        git: OsString::from("git-must-not-run"),
        npm: program.into_os_string(),
        path: std::env::var_os("PATH"),
        target: Target::here(),
    }
}

fn tarball(files: &[(&str, &str)]) -> Vec<u8> {
    let mut raw = tar::Builder::new(Vec::new());
    for (rel, text) in files {
        let bytes = text.as_bytes();
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        raw.append_data(&mut header, format!("package/{rel}"), bytes)
            .unwrap();
    }
    let raw = raw.into_inner().unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&raw).unwrap();
    gz.finish().unwrap()
}

fn pinned_npm() -> (String, String) {
    let index = discover::read_index(
        discover::BUNDLED_INDEX,
        &discover::Origin::Elsewhere,
        discover::platform(),
    )
    .unwrap();
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.name == "e2e-verify")
        .unwrap();
    assert_eq!(entry.status, Status::Available);
    match entry.source.as_ref().unwrap() {
        discover::InstallSource::Npm {
            package,
            version,
            registry,
        } => {
            assert_eq!(package, "e2e");
            assert_eq!(version, "0.23.0");
            assert!(registry.is_none());
            (package.clone(), version.clone())
        }
        other => panic!("pinned source is {other:?}"),
    }
}

fn skill(name: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: A skill kept with the package.\n---\n\n{body}\n")
}

fn package_json(name: &str, version: &str, extra: &str) -> String {
    if extra.is_empty() {
        format!("{{\"name\":\"{name}\",\"version\":\"{version}\",\"license\":\"Apache-2.0\"}}\n")
    } else {
        format!("{{\"name\":\"{name}\",\"version\":\"{version}\",\"license\":\"Apache-2.0\",{extra}}}\n")
    }
}

fn install_npm(
    host: &Host,
    stub: &Path,
    package: &str,
    version: &str,
    files: &[(&str, &str)],
    by: RequestedBy,
) -> Result<InstallResult, String> {
    std::fs::create_dir_all(stub).unwrap();
    std::fs::write(stub.join("e2e.tgz"), tarball(files)).unwrap();
    std::fs::write(stub.join("version.txt"), version).unwrap();
    let tools = npm_tools(stub);
    install::install(
        host,
        &tools,
        &InstallSource::Npm {
            package: package.into(),
            version: version.into(),
            registry: None,
        },
        by,
    )
}

fn e2e_files(version: &str) -> Vec<(String, String)> {
    vec![
        ("package.json".into(), package_json("e2e", version, "")),
        ("skills/e2e/SKILL.md".into(), skill("e2e", MARKER)),
        ("dist/cli/bin.js".into(), "process.exit(0)\n".into()),
    ]
}

fn as_pairs(files: &[(String, String)]) -> Vec<(&str, &str)> {
    files
        .iter()
        .map(|(name, text)| (name.as_str(), text.as_str()))
        .collect()
}

fn npm_source(package: &str) -> InstallSource {
    InstallSource::Npm {
        package: package.into(),
        version: "0.22.0".into(),
        registry: None,
    }
}

fn names(host: &Host) -> Vec<String> {
    registry::read(host)
        .unwrap()
        .plugins
        .keys()
        .cloned()
        .collect()
}

#[test]
fn the_bundled_entry_installs_from_the_index_and_a_worker_session_gets_the_server() {
    let defaults = include_str!("../../plugins/defaults.json");
    assert!(
        !defaults.contains("e2e-verify"),
        "Verify is offered, not installed with the app"
    );
    let (package, version) = pinned_npm();
    let tmp = Tmp::new("install");
    let host = plugin_host(&tmp);
    let files = e2e_files(&version);
    let installed = install_npm(
        &host,
        &tmp.path().join("stub"),
        &package,
        &version,
        &as_pairs(&files),
        RequestedBy::person(),
    )
    .unwrap();
    let InstallResult::Installed { entry, .. } = installed else {
        panic!("a package with nothing to run is installed when the person asks");
    };
    assert_eq!(entry.unwrap().name, "e2e-verify");
    let root = host.installed("e2e-verify");
    assert_eq!(
        std::fs::read_to_string(root.join("skills/when-to-verify/SKILL.md")).unwrap(),
        WHEN_TO_VERIFY
    );
    let kept = std::fs::read_to_string(root.join("skills/e2e/SKILL.md")).unwrap();
    assert!(kept.contains(MARKER));
    assert!(
        !kept.contains("no engine"),
        "the package's own skill is not rewritten"
    );
    let mcp: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("mcp.json")).unwrap()).unwrap();
    assert_eq!(mcp["mcpServers"]["e2e"]["command"], "node");
    assert_eq!(
        mcp["mcpServers"]["e2e"]["args"],
        json!(["./dist/cli/bin.js", "mcp"])
    );
    // Upstream's server sends anonymous usage events by default. Both documented switches are set, so the
    // environment wins over any saved preference (e2e reads E2E_TELEMETRY_DISABLED and DO_NOT_TRACK first).
    assert_eq!(
        mcp["mcpServers"]["e2e"]["env"],
        json!({ "E2E_TELEMETRY_DISABLED": "1", "DO_NOT_TRACK": "1" })
    );
    let entry = registry::read(&host).unwrap().plugins["e2e-verify"].clone();
    assert!(!entry.enabled.any(), "install does not switch it on");
    assert!(
        entry.skills().next().is_none(),
        "skills are recorded when it is switched on"
    );

    registry::enable(&host, "e2e-verify", &Scope::Global).unwrap();
    let entry = registry::read(&host).unwrap().plugins["e2e-verify"].clone();
    assert!(entry.skills().any(|name| name == "when-to-verify"));
    assert!(entry.skills().any(|name| name == "e2e"));
    assert!(entry.mcp_servers().any(|name| name == "e2e"));
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let wiring =
        wiring::session_wiring(&host, Some(&cwd), Some("monocode"), &Default::default()).unwrap();
    let key = "plugin-e2e-verify-e2e";
    let claude = wiring
        .claude_mcp_servers
        .get(key)
        .unwrap_or_else(|| panic!("missing {key} in {:?}", wiring.claude_mcp_servers));
    let codex = wiring.codex_mcp_servers.get(key).unwrap();
    for entry in [claude, codex] {
        assert_eq!(entry["command"], "monocode");
        let args: Vec<&str> = entry["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg.as_str().unwrap())
            .collect();
        assert!(
            args.windows(2).any(|pair| pair == ["--server", "e2e"]),
            "{args:?}"
        );
    }
}

#[test]
fn every_skill_named_in_the_index_is_installed() {
    let index = discover::read_index(
        discover::BUNDLED_INDEX,
        &discover::Origin::Elsewhere,
        discover::platform(),
    )
    .unwrap();
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.name == "e2e-verify")
        .unwrap();
    let named = entry.adds.iter().find(|add| add.kind == "skills").unwrap();
    let (package, version) = pinned_npm();
    let tmp = Tmp::new("skills");
    let host = plugin_host(&tmp);
    install_npm(
        &host,
        &tmp.path().join("stub"),
        &package,
        &version,
        &as_pairs(&e2e_files(&version)),
        RequestedBy::person(),
    )
    .unwrap();
    let root = host.installed("e2e-verify");
    for name in &named.names {
        let skill = root.join("skills").join(name).join("SKILL.md");
        assert!(
            skill.is_file(),
            "{name} is in the index but {skill:?} was not installed"
        );
    }
}

#[test]
fn the_e2e_server_runs_in_the_workers_project() {
    let (package, version) = pinned_npm();
    let tmp = Tmp::new("cwd");
    let host = plugin_host(&tmp);
    install_npm(
        &host,
        &tmp.path().join("stub"),
        &package,
        &version,
        &as_pairs(&e2e_files(&version)),
        RequestedBy::person(),
    )
    .unwrap();
    registry::enable(&host, "e2e-verify", &Scope::Global).unwrap();
    let project = tmp.path().join("plüg app");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("e2e.config.ts"), "export default {}\n").unwrap();
    let via_parent = project.join("src").join("..");
    let wiring = wiring::session_wiring(
        &host,
        Some(&via_parent),
        Some("monocode"),
        &Default::default(),
    )
    .unwrap();
    let key = "plugin-e2e-verify-e2e";
    let args: Vec<String> = wiring.claude_mcp_servers[key]["args"]
        .as_array()
        .unwrap()
        .iter()
        .skip(1)
        .map(|arg| arg.as_str().unwrap().to_string())
        .collect();
    assert!(
        args.windows(2)
            .any(|pair| pair[0] == "--project" && Path::new(&pair[1]) == via_parent),
        "the session must name the worker checkout, got {args:?}"
    );
    let command = wiring::prepare_launch(&args).unwrap();
    assert_eq!(
        command.get_current_dir(),
        Some(fsutil::canonical(&project).unwrap().as_path())
    );
    let launched: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let script = launched
        .iter()
        .find(|arg| Path::new(arg).ends_with(Path::new("dist").join("cli").join("bin.js")))
        .unwrap_or_else(|| panic!("script arg missing in {launched:?}"));
    let plugin_root = fsutil::canonical(&host.installed("e2e-verify")).unwrap();
    assert!(
        Path::new(script).starts_with(&plugin_root),
        "{script} is not inside {plugin_root:?}"
    );
    assert!(script.starts_with('/') || script.chars().nth(1) == Some(':'));
    assert_eq!(launched.last().map(String::as_str), Some("mcp"));
    assert_eq!(command.get_program().to_string_lossy(), "node");
    let env: std::collections::BTreeMap<String, String> = command
        .get_envs()
        .filter_map(|(key, value)| {
            Some((
                key.to_string_lossy().into_owned(),
                value?.to_string_lossy().into_owned(),
            ))
        })
        .collect();
    assert_eq!(
        env.get("E2E_TELEMETRY_DISABLED").map(String::as_str),
        Some("1")
    );
    assert_eq!(env.get("DO_NOT_TRACK").map(String::as_str), Some("1"));
    let mcp = std::fs::read_to_string(host.installed("e2e-verify").join("mcp.json")).unwrap();
    assert!(
        mcp.contains("./dist/cli/bin.js"),
        "the installed mcp.json stays as shipped: {mcp}"
    );

    let elsewhere = tmp.path().join("other project");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let mut other = args.clone();
    let at = other.iter().position(|arg| arg == "--project").unwrap();
    other[at + 1] = elsewhere.display().to_string();
    let second = wiring::prepare_launch(&other).unwrap();
    assert_eq!(
        second.get_current_dir(),
        Some(fsutil::canonical(&elsewhere).unwrap().as_path())
    );

    let missing = tmp.path().join("gone");
    other[at + 1] = missing.display().to_string();
    let err = wiring::prepare_launch(&other).unwrap_err();
    assert!(
        err.contains("project folder"),
        "a missing checkout must not start in the plugin folder: {err}"
    );
}

#[test]
fn verify_on_for_one_project_does_not_start_in_another() {
    let (package, version) = pinned_npm();
    let tmp = Tmp::new("project-scope");
    let host = plugin_host(&tmp);
    install_npm(
        &host,
        &tmp.path().join("stub"),
        &package,
        &version,
        &as_pairs(&e2e_files(&version)),
        RequestedBy::person(),
    )
    .unwrap();
    let here = tmp.path().join("this project");
    let there = tmp.path().join("other project");
    std::fs::create_dir_all(&here).unwrap();
    std::fs::create_dir_all(&there).unwrap();
    registry::enable(
        &host,
        "e2e-verify",
        &Scope::Project(here.display().to_string()),
    )
    .unwrap();
    let entry = registry::read(&host).unwrap().plugins["e2e-verify"].clone();
    assert!(
        !entry.enabled.global,
        "the offer must not turn it on everywhere"
    );
    assert!(
        entry.enabled.projects.len() == 1,
        "only the offered project is on: {:?}",
        entry.enabled.projects
    );

    let key = "plugin-e2e-verify-e2e";
    let there_wiring =
        wiring::session_wiring(&host, Some(&there), Some("monocode"), &Default::default()).unwrap();
    assert!(
        !there_wiring.claude_mcp_servers.contains_key(key)
            && !there_wiring.codex_mcp_servers.contains_key(key),
        "another folder must not get the e2e server: {:?}",
        there_wiring.claude_mcp_servers
    );
    let none = wiring::session_wiring(&host, None, Some("monocode"), &Default::default()).unwrap();
    assert!(!none.claude_mcp_servers.contains_key(key));

    let here_wiring =
        wiring::session_wiring(&host, Some(&here), Some("monocode"), &Default::default()).unwrap();
    assert!(
        here_wiring.claude_mcp_servers.contains_key(key),
        "the offered project must get the server"
    );
    assert!(here_wiring.codex_mcp_servers.contains_key(key));
}

#[test]
fn an_approved_install_enables_the_project_the_offer_was_for() {
    let (_package, version) = pinned_npm();
    let tmp = Tmp::new("approve project");
    let host = plugin_host(&tmp);
    let here = tmp.path().join("this project");
    let there = tmp.path().join("other project");
    std::fs::create_dir_all(&here).unwrap();
    std::fs::create_dir_all(&there).unwrap();
    let stub = tmp.path().join("stub-deps");
    std::fs::create_dir_all(&stub).unwrap();
    let files = [
        (
            "package.json",
            package_json("e2e", &version, "\"dependencies\":{\"left-pad\":\"1.0.0\"}"),
        ),
        ("dist/cli/bin.js", "process.exit(0)\n".to_string()),
    ];
    let owned: Vec<(String, String)> = files
        .iter()
        .map(|(name, text)| ((*name).to_string(), text.clone()))
        .collect();
    std::fs::write(stub.join("e2e.tgz"), tarball(&as_pairs(&owned))).unwrap();
    std::fs::write(stub.join("version.txt"), &version).unwrap();
    let tools = npm_tools(&stub);
    let waiting = install::install_for(
        &host,
        &tools,
        &InstallSource::Npm {
            package: "e2e".into(),
            version: version.clone(),
            registry: None,
        },
        RequestedBy::person(),
        Some(here.display().to_string()),
    )
    .unwrap();
    let install::InstallResult::Waiting { request } = waiting else {
        panic!("a package with dependencies waits for a yes");
    };
    let key = registry::project_key(&here.display().to_string()).unwrap();
    assert_eq!(
        request.project.as_deref(),
        Some(key.as_str()),
        "the pending install must remember the project that was offered"
    );
    assert!(
        !names(&host).contains(&"e2e-verify".to_string()),
        "nothing is installed while it waits"
    );
    let offer = verify::offer_for(&host, &here.display().to_string()).unwrap();
    assert!(
        !offer.installed,
        "the offer stays up until the approved install lands"
    );

    let approved = install::approve(&host, &tools, &request.id).unwrap();
    assert!(matches!(approved, install::InstallResult::Installed { .. }));
    let entry = registry::read(&host).unwrap().plugins["e2e-verify"].clone();
    assert!(
        !entry.enabled.global,
        "approval must not turn Verify on everywhere"
    );
    assert_eq!(
        entry.enabled.projects,
        vec![key],
        "approval turns Verify on for the offered project only: {:?}",
        entry.enabled.projects
    );
    let server = "plugin-e2e-verify-e2e";
    let there_wiring =
        wiring::session_wiring(&host, Some(&there), Some("monocode"), &Default::default()).unwrap();
    assert!(!there_wiring.claude_mcp_servers.contains_key(server));
    let here_wiring =
        wiring::session_wiring(&host, Some(&here), Some("monocode"), &Default::default()).unwrap();
    assert!(here_wiring.claude_mcp_servers.contains_key(server));
}

#[test]
fn an_agents_install_and_a_package_with_dependencies_wait_for_a_yes() {
    let (_package, version) = pinned_npm();
    let tmp = Tmp::new("wait");
    let host = plugin_host(&tmp);
    let files = e2e_files(&version);
    let waiting = install_npm(
        &host,
        &tmp.path().join("stub-agent"),
        "e2e",
        &version,
        &as_pairs(&files),
        RequestedBy {
            kind: "agent".into(),
            session: Some("chat-1".into()),
            reason: Some("the worker asked".into()),
            ..RequestedBy::default()
        },
    )
    .unwrap();
    let InstallResult::Waiting { .. } = waiting else {
        panic!("an agent's install waits");
    };
    assert!(names(&host).is_empty());
    assert_eq!(install::pending(&host).len(), 1);

    let deps = vec![
        (
            "package.json".into(),
            package_json("e2e", &version, "\"dependencies\":{\"left-pad\":\"1.0.0\"}"),
        ),
        ("dist/cli/bin.js".into(), "process.exit(0)\n".into()),
    ];
    let person = install_npm(
        &host,
        &tmp.path().join("stub-deps"),
        "e2e",
        &version,
        &as_pairs(&deps),
        RequestedBy::person(),
    )
    .unwrap();
    let InstallResult::Waiting { request } = person else {
        panic!("npm install waits for a yes");
    };
    assert!(!names(&host).contains(&"e2e-verify".to_string()));
    let tools = npm_tools(&tmp.path().join("stub-deps"));
    let approved = install::approve(&host, &tools, &request.id).unwrap();
    assert!(matches!(approved, InstallResult::Installed { .. }));
    assert!(names(&host).contains(&"e2e-verify".to_string()));
}

#[test]
fn only_the_e2e_package_is_wrapped_and_its_own_files_are_left_alone() {
    let tmp = Tmp::new("wrap");
    for name in ["left-pad", "E2E"] {
        let root = tmp.path().join(name);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("package.json"), package_json(name, "1.0.0", "")).unwrap();
        verify::prepare_package(&root, &npm_source(name)).unwrap();
        assert!(!root.join("plugin.json").exists(), "{name}");
    }

    let host = plugin_host(&tmp);
    let err = install_npm(
        &host,
        &tmp.path().join("stub-left"),
        "left-pad",
        "1.0.0",
        &[(
            "package.json",
            "{\"name\":\"left-pad\",\"version\":\"1.0.0\"}\n",
        )],
        RequestedBy::person(),
    )
    .unwrap_err();
    assert!(err.contains("plugin.json"), "{err}");
    assert!(names(&host).is_empty());
    let err = install_npm(
        &host,
        &tmp.path().join("stub-case"),
        "e2e",
        "1.0.0",
        &[("package.json", "{\"name\":\"E2E\",\"version\":\"1.0.0\"}\n")],
        RequestedBy::person(),
    )
    .unwrap_err();
    assert!(err.contains("plugin.json"), "{err}");
    assert!(names(&host).is_empty());

    let kept = json!({
        "$schema": PLUGIN_SCHEMA_1_0_0,
        "name": "kept-name",
        "version": "1.2.3",
    })
    .to_string();
    let own_skill = skill("e2e", MARKER);
    let own_when = "KEEP-MINE\n";
    let version = "9.9.9";
    let files = [
        ("package.json", package_json("e2e", version, "")),
        ("plugin.json", kept.clone()),
        ("skills/e2e/SKILL.md", own_skill.clone()),
        ("skills/when-to-verify/SKILL.md", own_when.into()),
    ];
    let pairs: Vec<(&str, &str)> = files
        .iter()
        .map(|(name, text)| (*name, text.as_str()))
        .collect();
    install_npm(
        &host,
        &tmp.path().join("stub-kept"),
        "e2e",
        version,
        &pairs,
        RequestedBy::person(),
    )
    .unwrap();
    let root = host.installed("kept-name");
    assert_eq!(
        std::fs::read_to_string(root.join("plugin.json")).unwrap(),
        kept
    );
    assert_eq!(
        std::fs::read_to_string(root.join("skills/e2e/SKILL.md")).unwrap(),
        own_skill
    );
    assert_eq!(
        std::fs::read_to_string(root.join("skills/when-to-verify/SKILL.md")).unwrap(),
        own_when
    );
    assert!(!root.join("mcp.json").exists());

    let local = tmp.path().join("local e2e");
    std::fs::create_dir_all(local.join("src")).unwrap();
    let manifest = package_json("e2e", "0.22.0", "");
    std::fs::write(local.join("package.json"), &manifest).unwrap();
    let err = install::install(
        &host,
        &quiet_tools(),
        &InstallSource::Local {
            path: local.display().to_string(),
        },
        RequestedBy::person(),
    )
    .unwrap_err();
    assert!(
        err.contains("plugin.json"),
        "a local folder with no plugin.json is refused: {err}"
    );
    assert!(
        !local.join("plugin.json").exists(),
        "Hivra must not rewrite a folder the person already has"
    );
    assert!(!local.join("mcp.json").exists());
    assert!(!local.join("skills").exists());
    assert_eq!(
        std::fs::read_to_string(local.join("package.json")).unwrap(),
        manifest
    );
    assert!(
        !names(&host).iter().any(|name| name == "e2e-verify"),
        "a local folder is not installed as Verify"
    );

    let crlf = tmp.path().join("crlf");
    std::fs::create_dir_all(&crlf).unwrap();
    std::fs::write(
        crlf.join("package.json"),
        "{\r\n  \"name\": \"e2e\",\r\n  \"version\": \"0.22.0\",\r\n  \"license\": \"Apache-2.0\"\r\n}\r\n",
    )
    .unwrap();
    verify::prepare_package(&crlf, &npm_source("e2e")).unwrap();
    let written = std::fs::read_to_string(crlf.join("plugin.json")).unwrap();
    assert!(written.contains("e2e-verify"));
    assert!(written.contains("Apache-2.0"));

    let mit = tmp.path().join("mit");
    std::fs::create_dir_all(&mit).unwrap();
    std::fs::write(
        mit.join("package.json"),
        "{\"name\":\"e2e\",\"version\":\"0.22.0\",\"license\":\"MIT\"}\n",
    )
    .unwrap();
    verify::prepare_package(&mit, &npm_source("e2e")).unwrap();
    let written = std::fs::read_to_string(mit.join("plugin.json")).unwrap();
    assert!(!written.contains("Apache-2.0"), "{written}");

    #[cfg(unix)]
    {
        let outside = tmp.path().join("outside.json");
        let body = "{\"name\":\"e2e\",\"version\":\"1.0.0\",\"license\":\"Apache-2.0\"}\n";
        std::fs::write(&outside, body).unwrap();
        let linked = tmp.path().join("linked-manifest");
        std::fs::create_dir_all(&linked).unwrap();
        std::os::unix::fs::symlink(&outside, linked.join("package.json")).unwrap();
        verify::prepare_package(&linked, &npm_source("e2e")).unwrap();
        assert!(!linked.join("plugin.json").exists());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), body);

        let outside_dir = tmp.path().join("outside-skills");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let linked_skills = tmp.path().join("linked-skills");
        std::fs::create_dir_all(&linked_skills).unwrap();
        std::fs::write(
            linked_skills.join("package.json"),
            "{\"name\":\"e2e\",\"version\":\"0.22.0\",\"license\":\"Apache-2.0\"}\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside_dir, linked_skills.join("skills")).unwrap();
        let err = verify::prepare_package(&linked_skills, &npm_source("e2e")).unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(!linked_skills.join("plugin.json").exists());
        assert!(!outside_dir.join("when-to-verify").exists());
    }
}

fn write_json(dir: &Path, name: &str, text: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(name), text).unwrap();
}

fn surfaces(host: &Host, dir: &Path) -> Vec<String> {
    verify::offer_for(host, &dir.display().to_string())
        .unwrap()
        .surfaces
}

#[test]
fn a_web_or_mobile_project_is_offered_and_a_desktop_shell_is_not() {
    let tmp = Tmp::new("offer");
    let host = plugin_host(&tmp);
    let case = |name: &str| tmp.path().join(name);

    let web = case("vite");
    write_json(
        &web,
        "package.json",
        "{\"devDependencies\":{\"vite\":\"5.0.0\"}}\n",
    );
    assert_eq!(surfaces(&host, &web), ["web"]);

    let both = case("both");
    write_json(
        &both,
        "package.json",
        "{\"dependencies\":{\"vite\":\"5.0.0\",\"expo\":\"51.0.0\",\"react\":\"18.0.0\"}}\n",
    );
    assert_eq!(surfaces(&host, &both), ["web", "mobile"]);

    let desktop = case("desktop");
    write_json(
        &desktop,
        "package.json",
        "{\"dependencies\":{\"react\":\"18.0.0\",\"electron\":\"30.0.0\"}}\n",
    );
    assert!(surfaces(&host, &desktop).is_empty());

    let tauri_web = case("tauri-web");
    write_json(
        &tauri_web,
        "package.json",
        "{\"dependencies\":{\"next\":\"14.0.0\",\"@tauri-apps/cli\":\"2.0.0\"}}\n",
    );
    assert!(surfaces(&host, &tauri_web).is_empty());

    let tauri_expo = case("tauri-expo");
    write_json(
        &tauri_expo,
        "package.json",
        "{\"dependencies\":{\"expo\":\"51.0.0\"}}\n",
    );
    write_json(&tauri_expo.join("src-tauri"), "tauri.conf.json", "{}\n");
    assert_eq!(surfaces(&host, &tauri_expo), ["mobile"]);

    let react_expo = case("react-expo");
    write_json(
        &react_expo,
        "package.json",
        "{\"dependencies\":{\"react\":\"18.0.0\",\"react-native\":\"0.74.0\"}}\n",
    );
    assert_eq!(surfaces(&host, &react_expo), ["mobile"]);

    let react_vite = case("react-vite");
    write_json(
        &react_vite,
        "package.json",
        "{\"dependencies\":{\"react\":\"18.0.0\",\"vite\":\"5.0.0\"}}\n",
    );
    assert_eq!(surfaces(&host, &react_vite), ["web"]);

    let react_only = case("react-only");
    write_json(
        &react_only,
        "package.json",
        "{\"dependencies\":{\"react-dom\":\"18.0.0\"}}\n",
    );
    assert_eq!(surfaces(&host, &react_only), ["web"]);

    let config = case("config");
    write_json(&config, "package.json", "{}\n");
    write_json(&config, "next.config.ts", "export default {}\n");
    assert_eq!(surfaces(&host, &config), ["web"]);

    let vite_file = case("vite-file");
    write_json(&vite_file, "vite.config.ts", "export default {}\n");
    assert_eq!(surfaces(&host, &vite_file), ["web"]);

    let flutter = case("flutter");
    write_json(
        &flutter,
        "pubspec.yaml",
        "name: app\nflutter:\n  sdk: flutter\n",
    );
    assert_eq!(surfaces(&host, &flutter), ["mobile"]);

    let comment = case("comment");
    write_json(&comment, "pubspec.yaml", "name: app\n# flutter:\n");
    assert!(surfaces(&host, &comment).is_empty());

    let expo_app = case("expo-app");
    write_json(&expo_app, "app.json", "{\"expo\":{}}\n");
    assert_eq!(surfaces(&host, &expo_app), ["mobile"]);

    let plain_app = case("plain-app");
    write_json(&plain_app, "app.json", "{\"name\":\"x\"}\n");
    assert!(surfaces(&host, &plain_app).is_empty());

    let capacitor = case("capacitor");
    write_json(&capacitor, "capacitor.config.ts", "export default {}\n");
    assert_eq!(surfaces(&host, &capacitor), ["mobile"]);

    let lodash = case("lodash");
    write_json(
        &lodash,
        "package.json",
        "{\"dependencies\":{\"lodash\":\"4.17.21\"}}\n",
    );
    assert!(surfaces(&host, &lodash).is_empty());

    let peers = case("peers");
    write_json(
        &peers,
        "package.json",
        "{\"peerDependencies\":{\"next\":\"14.0.0\"}}\n",
    );
    assert!(surfaces(&host, &peers).is_empty());

    assert!(
        surfaces(&host, &case("empty")).is_empty() || {
            std::fs::create_dir_all(case("empty")).unwrap();
            surfaces(&host, &case("empty")).is_empty()
        }
    );
    std::fs::create_dir_all(case("empty")).unwrap();
    assert!(surfaces(&host, &case("empty")).is_empty());

    let broken = case("broken");
    write_json(&broken, "package.json", "{");
    assert!(surfaces(&host, &broken).is_empty());
    let array = case("array");
    write_json(&array, "package.json", "[]");
    assert!(surfaces(&host, &array).is_empty());

    let bom = case("bom plüg");
    std::fs::create_dir_all(&bom).unwrap();
    std::fs::write(
        bom.join("package.json"),
        "\u{feff}{\"dependencies\":{\"next\":\"14.0.0\"}}\n",
    )
    .unwrap();
    assert_eq!(surfaces(&host, &bom), ["web"]);

    let crlf = case("crlf app");
    write_json(
        &crlf,
        "package.json",
        "{\"dependencies\":{\"vue\":\"3.0.0\"}}\r\n",
    );
    assert_eq!(surfaces(&host, &crlf), ["web"]);

    let via = format!("{}/../crlf app", crlf.display());
    assert_eq!(verify::offer_for(&host, &via).unwrap().surfaces, ["web"]);

    let missing = tmp.path().join("missing");
    let offer = verify::offer_for(&host, &missing.display().to_string()).unwrap();
    assert!(offer.surfaces.is_empty());
    assert!(!offer.installed);
    assert!(!host.root.join("verify-offers.json").exists());
    match offer.source.unwrap() {
        InstallSource::Npm {
            package,
            version,
            registry,
        } => {
            assert_eq!(package, "e2e");
            assert_eq!(version, "0.23.0");
            assert!(registry.is_none());
        }
        other => panic!("{other:?}"),
    }
    assert!(verify::offer_for(&host, "").unwrap_err().contains("folder"));
    assert!(verify::offer_for(&host, "   ").is_err());

    #[cfg(unix)]
    {
        let outside = tmp.path().join("outside-package.json");
        std::fs::write(&outside, "{\"dependencies\":{\"next\":\"14.0.0\"}}\n").unwrap();
        let linked = case("linked");
        std::fs::create_dir_all(&linked).unwrap();
        std::os::unix::fs::symlink(&outside, linked.join("package.json")).unwrap();
        assert!(surfaces(&host, &linked).is_empty());
    }

    let plugin = tmp.path().join("tiny plugin");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(
        plugin.join("plugin.json"),
        json!({
            "$schema": PLUGIN_SCHEMA_1_0_0,
            "name": "e2e-verify",
            "version": "0.0.1",
        })
        .to_string(),
    )
    .unwrap();
    install::install(
        &host,
        &quiet_tools(),
        &InstallSource::Local {
            path: plugin.display().to_string(),
        },
        RequestedBy::person(),
    )
    .unwrap();
    let offer = verify::offer_for(&host, &web.display().to_string()).unwrap();
    assert!(offer.installed);
    assert_eq!(offer.surfaces, ["web"]);
}

#[test]
fn declining_an_offer_is_one_decision_per_folder() {
    let tmp = Tmp::new("decline");
    let host = plugin_host(&tmp);
    let a = tmp.path().join("folder a");
    let b = tmp.path().join("folder b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let first = verify::decline(&host, &a.display().to_string(), 0).unwrap();
    assert!(first.applied);
    assert!(first.offer.declined);
    assert_eq!(first.offer.revision, 1);
    let lost = verify::decline(&host, &b.display().to_string(), 0).unwrap();
    assert!(!lost.applied);
    assert!(!lost.offer.declined);
    assert!(
        verify::offer_for(&host, &a.display().to_string())
            .unwrap()
            .declined
    );
    let second = verify::decline(&host, &b.display().to_string(), lost.offer.revision).unwrap();
    assert!(second.applied);
    assert!(second.offer.declined);

    let parent = tmp.path().join("parent");
    let proj = parent.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let via = verify::decline(&host, &proj.display().to_string(), second.offer.revision).unwrap();
    assert!(via.applied);
    let spelled = format!("{}/../proj", proj.display());
    let again = verify::decline(&host, &spelled, via.offer.revision).unwrap();
    assert!(again.applied);
    let saved: Value = serde_json::from_str(
        &std::fs::read_to_string(host.root.join("verify-offers.json")).unwrap(),
    )
    .unwrap();
    let declined = saved["declined"].as_array().unwrap();
    let key = fsutil::display(&fsutil::canonical(&proj).unwrap());
    assert_eq!(
        declined
            .iter()
            .filter(|item| item.as_str() == Some(key.as_str()))
            .count(),
        1
    );
    assert_eq!(declined.len(), 3);

    for body in ["{", "[]"] {
        let broken = Tmp::new("corrupt");
        let host = plugin_host(&broken);
        let dir = broken.path().join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        let path = host.root.join("verify-offers.json");
        std::fs::write(&path, body).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(verify::offer_for(&host, &dir.display().to_string()).is_err());
        assert!(verify::decline(&host, &dir.display().to_string(), 0).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    let locked = Tmp::new("lock");
    let host = plugin_host(&locked);
    let dir = locked.path().join("proj");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(host.root.join("verify-offers.lock"), b"held").unwrap();
    let err = verify::decline(&host, &dir.display().to_string(), 0).unwrap_err();
    assert!(err.contains("Try again"), "{err}");
    assert!(!host.root.join("verify-offers.json").exists());

    let stale = Tmp::new("stale");
    let host = plugin_host(&stale);
    let dir = stale.path().join("proj");
    std::fs::create_dir_all(&dir).unwrap();
    let lock = host.root.join("verify-offers.lock");
    std::fs::write(&lock, b"old").unwrap();
    OpenOptions::new()
        .write(true)
        .open(&lock)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(31))
        .unwrap();
    assert!(
        verify::decline(&host, &dir.display().to_string(), 0)
            .unwrap()
            .applied
    );
    assert!(!lock.exists());
}

fn proof(dir: &Path, rel: &str, text: &str) {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn e2e_proof_is_attached_and_a_link_that_leaves_the_folder_is_not() {
    let tmp = Tmp::new("proof");
    let work = tmp.path().join("plüg work");
    let e2e = work.join(".e2e");
    proof(&e2e, "report.json", "{}\n");
    proof(&e2e, "results/x/trace.md", "trace\n");
    proof(&e2e, "shot.png", "png\n");
    proof(&e2e, "plüg.png", "png\n");
    let mut report = WorkerReport::default();
    verify::merge_evidence(&mut report, &work, 0);
    verify::merge_evidence(&mut report, &work, 0);
    assert_eq!(
        report.evidence,
        vec![
            ".e2e/report.json".to_string(),
            ".e2e/results/x/trace.md".to_string(),
            ".e2e/plüg.png".to_string(),
            ".e2e/shot.png".to_string(),
        ]
    );
    assert!(report
        .evidence
        .iter()
        .all(|item| !item.contains("..") && !item.contains('\\')));

    let mut capped = WorkerReport {
        evidence: (0..50)
            .map(|i| format!("https://example.com/{i}"))
            .collect(),
        ..WorkerReport::default()
    };
    verify::merge_evidence(&mut capped, &work, 0);
    assert_eq!(capped.evidence.len(), 50);
    assert!(capped
        .evidence
        .iter()
        .all(|item| item.starts_with("https://")));

    let crowded = tmp.path().join("crowded");
    let folder = crowded.join(".e2e");
    proof(&folder, "report.json", "{}\n");
    for index in 0..59 {
        proof(&folder, &format!("n{index}.txt"), "x\n");
    }
    let mut many = WorkerReport::default();
    verify::merge_evidence(&mut many, &crowded, 0);
    assert_eq!(many.evidence.len(), 50);
    assert!(many.evidence.iter().any(|item| item == ".e2e/report.json"));

    // `cache/` sorts first. A depth-first walk that stops at 400 files never sees the report beside it.
    let buried = tmp.path().join("buried");
    let buried_e2e = buried.join(".e2e");
    proof(&buried_e2e, "report.json", "{}\n");
    proof(&buried_e2e, "results/home/trace.md", "trace\n");
    for index in 0..400 {
        proof(&buried_e2e, &format!("cache/f{index:04}.txt"), "x\n");
    }
    let mut buried_report = WorkerReport::default();
    verify::merge_evidence(&mut buried_report, &buried, 0);
    assert!(
        buried_report
            .evidence
            .iter()
            .any(|item| item == ".e2e/report.json"),
        "{:?}",
        buried_report.evidence
    );
    assert!(
        buried_report
            .evidence
            .iter()
            .any(|item| item == ".e2e/results/home/trace.md"),
        "{:?}",
        buried_report.evidence
    );
    assert_eq!(buried_report.evidence.len(), 50);

    let absent = tmp.path().join("absent");
    std::fs::create_dir_all(&absent).unwrap();
    let mut empty = WorkerReport::default();
    verify::merge_evidence(&mut empty, &absent, 0);
    assert!(empty.evidence.is_empty());
    proof(&absent, ".e2e", "not a folder\n");
    verify::merge_evidence(&mut empty, &absent, 0);
    assert!(empty.evidence.is_empty());

    #[cfg(unix)]
    {
        let outside = tmp.path().join("secret-marker.png");
        std::fs::write(&outside, b"secret").unwrap();
        let linked = tmp.path().join("linked-file");
        let linked_e2e = linked.join(".e2e");
        std::fs::create_dir_all(&linked_e2e).unwrap();
        proof(&linked_e2e, "report.json", "{}\n");
        std::os::unix::fs::symlink(&outside, linked_e2e.join("secret-marker.png")).unwrap();
        let mut report = WorkerReport::default();
        verify::merge_evidence(&mut report, &linked, 0);
        assert!(report
            .evidence
            .iter()
            .all(|item| !item.contains("secret-marker")));
        assert_eq!(report.evidence, vec![".e2e/report.json".to_string()]);

        let outside_dir = tmp.path().join("outside-e2e");
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(outside_dir.join("report.json"), b"{}").unwrap();
        let linked_dir = tmp.path().join("linked-dir");
        std::fs::create_dir_all(&linked_dir).unwrap();
        std::os::unix::fs::symlink(&outside_dir, linked_dir.join(".e2e")).unwrap();
        let mut report = WorkerReport::default();
        verify::merge_evidence(&mut report, &linked_dir, 0);
        assert!(report.evidence.is_empty());
    }
}

const REPORT: &str = "\
## Report
Summary: proved the button
Files changed:
- src/a.ts
Checks:
- npm test: passed (1 passed)
Evidence:
- .e2e/report.json
- https://example.com/run
Open questions:
- none
";

const PLAIN: &str = "\
## Report
Summary: no files yet
Files changed:
- src/a.ts
Checks:
- npm test: passed (1 passed)
Evidence:
- https://example.com/run
Open questions:
- none
";

fn evidence_of(report: &Option<String>) -> Vec<String> {
    let value: Value = serde_json::from_str(report.as_deref().unwrap()).unwrap();
    serde_json::from_value(value["evidence"].clone()).unwrap()
}

fn insert_session(conn: &rusqlite::Connection, id: &str, cwd: &str, worktree: Option<&str>) {
    conn.execute(
        "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at, worktree_cwd)
         VALUES (?1, ?2, 'claude', 'test', 'code', 'worker', 1, 1, ?3)",
        rusqlite::params![id, cwd, worktree],
    )
    .unwrap();
}

fn launch(owner: &str, request: &str, child: &str) -> RecordInput {
    RecordInput {
        owner_session: owner.into(),
        request_id: request.into(),
        child_session: child.into(),
        ..RecordInput::default()
    }
}

fn finish(id: &str, result: Option<&str>) -> SettleInput {
    SettleInput {
        id: id.into(),
        generation: 1,
        state: "completed".into(),
        result: result.map(str::to_string),
        ..SettleInput::default()
    }
}

#[test]
fn settling_a_worker_attaches_its_e2e_folder_and_a_miss_changes_nothing() {
    let tmp = Tmp::new("settle");
    let work = tmp.path().join("plüg work");
    let e2e = work.join(".e2e");
    proof(&e2e, "report.json", "{}\n");
    proof(&e2e, "results/home/trace.md", "trace\n");
    let cwd_only = tmp.path().join("cwd only");
    proof(&cwd_only.join(".e2e"), "only-cwd.txt", "x\n");
    let empty_tree = tmp.path().join("empty tree");
    std::fs::create_dir_all(&empty_tree).unwrap();

    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    insert_session(
        &conn,
        "worker-1",
        &cwd_only.display().to_string(),
        Some(&work.display().to_string()),
    );
    insert_session(
        &conn,
        "worker-2",
        &cwd_only.display().to_string(),
        Some(&empty_tree.display().to_string()),
    );
    insert_session(&conn, "worker-3", &work.display().to_string(), Some(""));
    insert_session(&conn, "worker-4", &work.display().to_string(), None);

    let row = delegations::record(&mut conn, launch("owner-1", "req-1", "worker-1"), 10).unwrap();
    let first = delegations::settle(&mut conn, finish(&row.id, Some(REPORT)), 11).unwrap();
    assert!(first.applied);
    let evidence = evidence_of(&first.row.as_ref().unwrap().report);
    assert_eq!(
        evidence
            .iter()
            .filter(|item| item.as_str() == "https://example.com/run")
            .count(),
        1
    );
    assert_eq!(
        evidence
            .iter()
            .filter(|item| item.as_str() == ".e2e/report.json")
            .count(),
        1
    );
    assert!(evidence
        .iter()
        .any(|item| item == ".e2e/results/home/trace.md"));
    assert!(evidence.iter().all(|item| !item.contains("..")));

    proof(&e2e, "later.txt", "x\n");
    let second = delegations::settle(&mut conn, finish(&row.id, Some(REPORT)), 12).unwrap();
    assert!(!second.applied);
    assert_eq!(evidence_of(&second.row.as_ref().unwrap().report), evidence);
    assert!(!evidence_of(&second.row.unwrap().report)
        .iter()
        .any(|item| item.contains("later")));

    let preferred =
        delegations::record(&mut conn, launch("owner-1", "req-2", "worker-2"), 13).unwrap();
    let settled = delegations::settle(&mut conn, finish(&preferred.id, Some(PLAIN)), 14).unwrap();
    let evidence = evidence_of(&settled.row.unwrap().report);
    assert!(evidence.iter().all(|item| !item.contains(".e2e")));

    for (child, request) in [("worker-3", "req-3"), ("worker-4", "req-4")] {
        let row = delegations::record(&mut conn, launch("owner-1", request, child), 15).unwrap();
        let settled = delegations::settle(&mut conn, finish(&row.id, Some(PLAIN)), 16).unwrap();
        let evidence = evidence_of(&settled.row.unwrap().report);
        assert!(
            evidence.iter().any(|item| item == ".e2e/report.json"),
            "{child}"
        );
    }

    let ghost =
        delegations::record(&mut conn, launch("owner-1", "req-5", "ghost-worker"), 17).unwrap();
    let settled = delegations::settle(&mut conn, finish(&ghost.id, Some(PLAIN)), 18).unwrap();
    assert!(settled.applied);
    assert!(evidence_of(&settled.row.unwrap().report)
        .iter()
        .all(|item| !item.contains(".e2e")));

    let quiet = delegations::record(&mut conn, launch("owner-1", "req-6", "worker-1"), 19).unwrap();
    let settled = delegations::settle(
        &mut conn,
        SettleInput {
            id: quiet.id,
            generation: 1,
            state: "cancelled".into(),
            result: None,
            ..SettleInput::default()
        },
        20,
    )
    .unwrap();
    assert!(settled.applied);
    assert!(settled.row.unwrap().report.is_none());
}

fn set_mtime(path: &Path, ms: u64) {
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(ms))
        .unwrap();
}

#[test]
fn only_e2e_files_from_this_run_are_attached() {
    let start = 1_700_000_000_000_i64;
    let tmp = Tmp::new("fresh proof");
    let old_dir = tmp.path().join("old run");
    proof(&old_dir.join(".e2e"), "report.json", "{}\n");
    set_mtime(&old_dir.join(".e2e/report.json"), (start - 60_000) as u64);
    let new_dir = tmp.path().join("new run");
    proof(&new_dir.join(".e2e"), "report.json", "{}\n");
    set_mtime(&new_dir.join(".e2e/report.json"), start as u64);
    let resumed_dir = tmp.path().join("resumed run");
    proof(&resumed_dir.join(".e2e"), "report.json", "{}\n");
    proof(
        &resumed_dir.join(".e2e"),
        "results/home/trace.md",
        "trace\n",
    );
    set_mtime(&resumed_dir.join(".e2e/report.json"), start as u64);
    set_mtime(
        &resumed_dir.join(".e2e/results/home/trace.md"),
        (start + 120_000) as u64,
    );

    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    insert_session(&conn, "old-worker", &old_dir.display().to_string(), None);
    insert_session(&conn, "new-worker", &new_dir.display().to_string(), None);
    insert_session(
        &conn,
        "resumed-worker",
        &resumed_dir.display().to_string(),
        None,
    );

    let old = delegations::record(&mut conn, launch("owner", "old", "old-worker"), start).unwrap();
    let settled = delegations::settle(&mut conn, finish(&old.id, Some(PLAIN)), start + 1).unwrap();
    assert!(
        evidence_of(&settled.row.unwrap().report)
            .iter()
            .all(|item| item != ".e2e/report.json"),
        "a report from before this run is not this worker's proof"
    );

    let new = delegations::record(&mut conn, launch("owner", "new", "new-worker"), start).unwrap();
    let settled = delegations::settle(&mut conn, finish(&new.id, Some(PLAIN)), start + 1).unwrap();
    assert!(
        evidence_of(&settled.row.unwrap().report)
            .iter()
            .any(|item| item == ".e2e/report.json"),
        "a report written as this run started is kept"
    );

    let resumed =
        delegations::record(&mut conn, launch("owner", "again", "resumed-worker"), start).unwrap();
    let again = delegations::reattach(&mut conn, "resumed-worker", true, None, start + 120_000)
        .unwrap()
        .unwrap();
    assert_eq!(again.generation, 2);
    let settled = delegations::settle(
        &mut conn,
        SettleInput {
            id: resumed.id,
            generation: 2,
            state: "completed".into(),
            result: Some(PLAIN.into()),
            ..SettleInput::default()
        },
        start + 120_001,
    )
    .unwrap();
    let evidence = evidence_of(&settled.row.unwrap().report);
    assert!(
        evidence.iter().all(|item| item != ".e2e/report.json"),
        "proof from before the resume is an earlier run: {evidence:?}"
    );
    assert!(
        evidence
            .iter()
            .any(|item| item == ".e2e/results/home/trace.md"),
        "proof from the resumed run is kept: {evidence:?}"
    );
}

#[test]
fn a_trimmed_resume_line_does_not_attach_the_earlier_runs_proof() {
    let start = 1_700_000_000_000_i64;
    let resume_at = start + 120_000;
    let tmp = Tmp::new("trimmed resume");
    let dir = tmp.path().join("shared project");
    proof(&dir.join(".e2e"), "report.json", "{}\n");
    proof(&dir.join(".e2e"), "results/home/trace.md", "trace\n");
    set_mtime(&dir.join(".e2e/report.json"), start as u64);
    set_mtime(&dir.join(".e2e/results/home/trace.md"), resume_at as u64);

    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    insert_session(&conn, "trimmed-worker", &dir.display().to_string(), None);
    let row = delegations::record(
        &mut conn,
        launch("owner", "trimmed", "trimmed-worker"),
        start,
    )
    .unwrap();
    let again = delegations::reattach(&mut conn, "trimmed-worker", true, None, resume_at)
        .unwrap()
        .unwrap();
    assert_eq!(again.generation, 2);
    for n in 0..30 {
        let at = resume_at + n;
        delegations::set_stall(
            &mut conn,
            StallInput {
                id: row.id.clone(),
                generation: 2,
                kind: Some("quiet".into()),
                reason: Some(format!("stuck {n}")),
                since: Some(at),
                by: None,
            },
            at,
        )
        .unwrap();
        delegations::set_stall(
            &mut conn,
            StallInput {
                id: row.id.clone(),
                generation: 2,
                kind: None,
                reason: None,
                since: None,
                by: None,
            },
            at,
        )
        .unwrap();
    }
    let open = delegations::get(&conn, &row.id).unwrap().unwrap();
    assert!(
        open.log
            .iter()
            .all(|entry| entry.get("event").and_then(Value::as_str) != Some("resumed")),
        "the resume line has been trimmed, so the cutoff cannot depend on it"
    );
    let settled = delegations::settle(
        &mut conn,
        SettleInput {
            id: row.id,
            generation: 2,
            state: "completed".into(),
            result: Some(PLAIN.into()),
            ..SettleInput::default()
        },
        resume_at + 1,
    )
    .unwrap();
    let evidence = evidence_of(&settled.row.unwrap().report);
    assert!(
        evidence.iter().all(|item| item != ".e2e/report.json"),
        "proof from before the resume is an earlier run even after the log forgot it: {evidence:?}"
    );
    assert!(
        evidence
            .iter()
            .any(|item| item == ".e2e/results/home/trace.md"),
        "proof from the resumed run is kept: {evidence:?}"
    );
}

#[test]
fn an_old_row_resumed_before_the_column_existed_keeps_that_start() {
    let start = 1_700_000_000_000_i64;
    let earlier = start + 60_000;
    let resume_at = start + 120_000;
    let tmp = Tmp::new("old resume");
    let dir = tmp.path().join("old project");
    proof(&dir.join(".e2e"), "report.json", "{}\n");
    proof(&dir.join(".e2e"), "mid.json", "{}\n");
    proof(&dir.join(".e2e"), "results/home/trace.md", "trace\n");
    set_mtime(&dir.join(".e2e/report.json"), start as u64);
    set_mtime(&dir.join(".e2e/mid.json"), earlier as u64);
    set_mtime(&dir.join(".e2e/results/home/trace.md"), resume_at as u64);

    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    insert_session(&conn, "old-resume", &dir.display().to_string(), None);
    let row = delegations::record(
        &mut conn,
        launch("owner", "old-resume", "old-resume"),
        start,
    )
    .unwrap();
    delegations::reattach(&mut conn, "old-resume", true, None, earlier)
        .unwrap()
        .unwrap();
    let again = delegations::reattach(&mut conn, "old-resume", true, None, resume_at)
        .unwrap()
        .unwrap();
    assert_eq!(again.generation, 3);
    // The column arrived after this resume, so the stored start is still unknown while the log remembers it.
    conn.execute(
        "UPDATE delegations SET run_started_at = NULL WHERE id = ?1",
        [&row.id],
    )
    .unwrap();

    let settled = delegations::settle(
        &mut conn,
        SettleInput {
            id: row.id.clone(),
            generation: 3,
            state: "completed".into(),
            result: Some(PLAIN.into()),
            ..SettleInput::default()
        },
        resume_at + 1,
    )
    .unwrap();
    let evidence = evidence_of(&settled.row.unwrap().report);
    assert!(
        evidence.iter().all(|item| item != ".e2e/report.json"),
        "proof from the original run is not this resume: {evidence:?}"
    );
    assert!(
        evidence.iter().all(|item| item != ".e2e/mid.json"),
        "an earlier resume is not the latest one: {evidence:?}"
    );
    assert!(
        evidence
            .iter()
            .any(|item| item == ".e2e/results/home/trace.md"),
        "proof from the latest resume is kept: {evidence:?}"
    );
    let stored: Option<i64> = conn
        .query_row(
            "SELECT run_started_at FROM delegations WHERE id = ?1",
            [&row.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored,
        Some(resume_at),
        "a save must not write the created time back over a real resume"
    );
}

#[test]
fn reviving_a_refused_row_does_not_attach_proof_from_before_the_retry() {
    let start = 1_700_000_000_000_i64;
    let revive_at = start + 90_000;
    let tmp = Tmp::new("revived proof");
    let dir = tmp.path().join("retry project");
    proof(&dir.join(".e2e"), "report.json", "{}\n");
    proof(&dir.join(".e2e"), "results/home/trace.md", "trace\n");
    set_mtime(&dir.join(".e2e/report.json"), start as u64);
    set_mtime(&dir.join(".e2e/results/home/trace.md"), revive_at as u64);

    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    insert_session(&conn, "revived-worker", &dir.display().to_string(), None);
    let row = delegations::record(
        &mut conn,
        launch("owner", "same-receipt", "revived-worker"),
        start,
    )
    .unwrap();
    assert!(
        delegations::refuse(&mut conn, &row.id, None, start + 1)
            .unwrap()
            .applied
    );
    let revived = delegations::record(
        &mut conn,
        launch("owner", "same-receipt", "revived-worker"),
        revive_at,
    )
    .unwrap();
    assert_eq!(revived.id, row.id);
    let settled = delegations::settle(
        &mut conn,
        SettleInput {
            id: revived.id,
            generation: 1,
            state: "completed".into(),
            result: Some(PLAIN.into()),
            ..SettleInput::default()
        },
        revive_at + 1,
    )
    .unwrap();
    let evidence = evidence_of(&settled.row.unwrap().report);
    assert!(
        evidence.iter().all(|item| item != ".e2e/report.json"),
        "proof from before the retry is an earlier run: {evidence:?}"
    );
    assert!(
        evidence
            .iter()
            .any(|item| item == ".e2e/results/home/trace.md"),
        "proof from the retry is kept: {evidence:?}"
    );
}

#[test]
fn a_failed_enable_keeps_the_pending_approval_so_it_can_be_retried() {
    let (_package, version) = pinned_npm();
    let tmp = Tmp::new("enable retry");
    let host = plugin_host(&tmp);
    let here = tmp.path().join("offered project");
    std::fs::create_dir_all(&here).unwrap();
    let stub = tmp.path().join("stub-deps");
    std::fs::create_dir_all(&stub).unwrap();
    let files = [
        (
            "package.json",
            package_json("e2e", &version, "\"dependencies\":{\"left-pad\":\"1.0.0\"}"),
        ),
        ("dist/cli/bin.js", "process.exit(0)\n".to_string()),
    ];
    let owned: Vec<(String, String)> = files
        .iter()
        .map(|(name, text)| ((*name).to_string(), text.clone()))
        .collect();
    std::fs::write(stub.join("e2e.tgz"), tarball(&as_pairs(&owned))).unwrap();
    std::fs::write(stub.join("version.txt"), &version).unwrap();
    let tools = npm_tools(&stub);
    let waiting = install::install_for(
        &host,
        &tools,
        &InstallSource::Npm {
            package: "e2e".into(),
            version: version.clone(),
            registry: None,
        },
        RequestedBy::person(),
        Some(here.display().to_string()),
    )
    .unwrap();
    let install::InstallResult::Waiting { request } = waiting else {
        panic!("a package with dependencies waits for a yes");
    };
    // The shim folder is a file, so turning the plugin on cannot write it. The install itself can.
    std::fs::write(host.root.join("claude"), "not a folder\n").unwrap();

    let err = install::approve(&host, &tools, &request.id).unwrap_err();
    assert!(
        install::pending(&host)
            .iter()
            .any(|waiting| waiting.id == request.id),
        "a failed enable must leave the approval to retry, not drop it: {err}"
    );
    assert!(
        names(&host).contains(&"e2e-verify".to_string()),
        "the plugin is installed even though it could not be turned on"
    );
    let key = registry::project_key(&here.display().to_string()).unwrap();
    let entry = registry::read(&host).unwrap().plugins["e2e-verify"].clone();
    assert!(
        !entry.enabled.projects.contains(&key),
        "the failed enable must not claim the project"
    );

    std::fs::remove_file(host.root.join("claude")).unwrap();
    let approved = install::approve(&host, &tools, &request.id).unwrap();
    assert!(matches!(approved, install::InstallResult::Installed { .. }));
    let entry = registry::read(&host).unwrap().plugins["e2e-verify"].clone();
    assert!(!entry.enabled.global);
    assert_eq!(entry.enabled.projects, vec![key]);
    assert!(
        install::pending(&host)
            .iter()
            .all(|waiting| waiting.id != request.id),
        "a retry that lands removes the approval"
    );
}

#[test]
fn an_old_row_with_only_a_retried_line_keeps_that_start() {
    let start = 1_700_000_000_000_i64;
    let retry_at = start + 90_000;
    let tmp = Tmp::new("retried only");
    let dir = tmp.path().join("retry only");
    proof(&dir.join(".e2e"), "report.json", "{}\n");
    proof(&dir.join(".e2e"), "results/home/trace.md", "trace\n");
    set_mtime(&dir.join(".e2e/report.json"), start as u64);
    set_mtime(&dir.join(".e2e/results/home/trace.md"), retry_at as u64);

    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    insert_session(&conn, "retry-only", &dir.display().to_string(), None);
    let row = delegations::record(
        &mut conn,
        launch("owner", "retry-only", "retry-only"),
        start,
    )
    .unwrap();
    assert!(
        delegations::refuse(&mut conn, &row.id, None, start + 1)
            .unwrap()
            .applied
    );
    delegations::record(
        &mut conn,
        launch("owner", "retry-only", "retry-only"),
        retry_at,
    )
    .unwrap();
    conn.execute(
        "UPDATE delegations SET run_started_at = NULL WHERE id = ?1",
        [&row.id],
    )
    .unwrap();

    let settled = delegations::settle(
        &mut conn,
        SettleInput {
            id: row.id.clone(),
            generation: 1,
            state: "completed".into(),
            result: Some(PLAIN.into()),
            ..SettleInput::default()
        },
        retry_at + 1,
    )
    .unwrap();
    let evidence = evidence_of(&settled.row.unwrap().report);
    assert!(
        evidence.iter().all(|item| item != ".e2e/report.json"),
        "a retried line with no resume is still a new run: {evidence:?}"
    );
    assert!(
        evidence
            .iter()
            .any(|item| item == ".e2e/results/home/trace.md"),
        "proof from the retry is kept: {evidence:?}"
    );
    let stored: Option<i64> = conn
        .query_row(
            "SELECT run_started_at FROM delegations WHERE id = ?1",
            [&row.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, Some(retry_at));
}

#[test]
fn an_old_row_retried_before_the_column_existed_keeps_that_start() {
    let start = 1_700_000_000_000_i64;
    let resumed_at = start + 60_000;
    let retry_at = start + 120_000;
    let tmp = Tmp::new("old retry");
    let dir = tmp.path().join("retried project");
    proof(&dir.join(".e2e"), "report.json", "{}\n");
    proof(&dir.join(".e2e"), "mid.json", "{}\n");
    proof(&dir.join(".e2e"), "results/home/trace.md", "trace\n");
    set_mtime(&dir.join(".e2e/report.json"), start as u64);
    set_mtime(&dir.join(".e2e/mid.json"), resumed_at as u64);
    set_mtime(&dir.join(".e2e/results/home/trace.md"), retry_at as u64);

    let store = SessionStore::open_in_memory().unwrap();
    let mut conn = store.lock_conn().unwrap();
    insert_session(&conn, "old-retry", &dir.display().to_string(), None);
    let row =
        delegations::record(&mut conn, launch("owner", "old-retry", "old-retry"), start).unwrap();
    assert!(
        delegations::refuse(&mut conn, &row.id, None, start + 1)
            .unwrap()
            .applied
    );
    let revived = delegations::record(
        &mut conn,
        launch("owner", "old-retry", "old-retry"),
        retry_at,
    )
    .unwrap();
    assert_eq!(revived.id, row.id);
    assert!(
        revived
            .log
            .iter()
            .all(|entry| entry.get("event").and_then(Value::as_str) != Some("resumed")),
        "this old row was retried, not resumed"
    );
    // A resume from before the retry is an earlier run. The column arrived after both, so it is still unknown.
    let mut log = revived.log.clone();
    log.insert(
        0,
        json!({ "at": resumed_at, "by": "test", "event": "resumed" }),
    );
    conn.execute(
        "UPDATE delegations SET run_started_at = NULL, log = ?1 WHERE id = ?2",
        (serde_json::to_string(&log).unwrap(), &row.id),
    )
    .unwrap();

    let settled = delegations::settle(
        &mut conn,
        SettleInput {
            id: row.id.clone(),
            generation: 1,
            state: "completed".into(),
            result: Some(PLAIN.into()),
            ..SettleInput::default()
        },
        retry_at + 1,
    )
    .unwrap();
    let evidence = evidence_of(&settled.row.unwrap().report);
    assert!(
        evidence.iter().all(|item| item != ".e2e/report.json"),
        "proof from before the retry is an earlier run: {evidence:?}"
    );
    assert!(
        evidence.iter().all(|item| item != ".e2e/mid.json"),
        "an earlier resume is not the latest new run: {evidence:?}"
    );
    assert!(
        evidence
            .iter()
            .any(|item| item == ".e2e/results/home/trace.md"),
        "proof from the retry is kept: {evidence:?}"
    );
    let stored: Option<i64> = conn
        .query_row(
            "SELECT run_started_at FROM delegations WHERE id = ?1",
            [&row.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored,
        Some(retry_at),
        "a save must not write the created time, or an earlier resume, over a later retry"
    );
}

#[test]
fn a_second_approval_restages_a_missing_copy_and_can_still_turn_verify_on() {
    let (_package, version) = pinned_npm();
    let tmp = Tmp::new("restage approval");
    let host = plugin_host(&tmp);
    let here = tmp.path().join("offered project");
    std::fs::create_dir_all(&here).unwrap();
    let stub = tmp.path().join("stub-deps");
    std::fs::create_dir_all(&stub).unwrap();
    let files = [
        (
            "package.json",
            package_json("e2e", &version, "\"dependencies\":{\"left-pad\":\"1.0.0\"}"),
        ),
        ("dist/cli/bin.js", "process.exit(0)\n".to_string()),
    ];
    let owned: Vec<(String, String)> = files
        .iter()
        .map(|(name, text)| ((*name).to_string(), text.clone()))
        .collect();
    let packed = tarball(&as_pairs(&owned));
    std::fs::write(stub.join("e2e.tgz"), &packed).unwrap();
    std::fs::write(stub.join("version.txt"), &version).unwrap();
    let tools = npm_tools(&stub);
    let waiting = install::install_for(
        &host,
        &tools,
        &InstallSource::Npm {
            package: "e2e".into(),
            version: version.clone(),
            registry: None,
        },
        RequestedBy::person(),
        Some(here.display().to_string()),
    )
    .unwrap();
    let install::InstallResult::Waiting { request } = waiting else {
        panic!("a package with dependencies waits for a yes");
    };
    let staged = host.pending().join(&request.id).join("plugin");
    assert!(staged.is_dir(), "the first fetch leaves a staged copy");
    std::fs::remove_dir_all(&staged).unwrap();
    // The pin cannot be fetched again yet, so this approval must not throw the request away.
    std::fs::remove_file(stub.join("e2e.tgz")).unwrap();

    let err = install::approve(&host, &tools, &request.id).unwrap_err();
    assert!(
        install::pending(&host)
            .iter()
            .any(|waiting| waiting.id == request.id),
        "a missing staged copy must leave the approval to try again, not drop it: {err}"
    );
    assert!(
        err.to_lowercase().contains("try again"),
        "the failure must say to try again: {err}"
    );
    assert!(
        !names(&host).contains(&"e2e-verify".to_string()),
        "a failed re-fetch must not claim the plugin is installed"
    );

    std::fs::write(stub.join("e2e.tgz"), &packed).unwrap();
    let approved = install::approve(&host, &tools, &request.id).unwrap();
    assert!(matches!(approved, install::InstallResult::Installed { .. }));
    let key = registry::project_key(&here.display().to_string()).unwrap();
    let entry = registry::read(&host).unwrap().plugins["e2e-verify"].clone();
    assert!(!entry.enabled.global);
    assert_eq!(entry.enabled.projects, vec![key]);
    assert!(
        install::pending(&host)
            .iter()
            .all(|waiting| waiting.id != request.id),
        "a retry that lands removes the approval"
    );
}
