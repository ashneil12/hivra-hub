//! WP-42: the Verify plugin. The `e2e` npm package is installed unchanged (no vendored files). It has no
//! `plugin.json`, so install adds Hivra's entry: the MCP server, and one persona-free skill that says when to use it.
//! A project that looks like a web or mobile app is offered the plugin. Installing still waits for the person's OK.
//! Proof left under the worker's `.e2e/` is attached to that worker's report.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::OpenOptions;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::{json, Value};

use super::discover::{self, Status};
use super::fsutil;
use super::manifest::PLUGIN_SCHEMA_1_0_0;
use super::mcp::MCP_SCHEMA_1_0_0;
use super::registry::{self, Host};
use super::source;

const PLUGIN_NAME: &str = "e2e-verify";
const PACKAGE_NAME: &str = "e2e";
const SERVER_NAME: &str = "e2e";
const OFFERS_FILE: &str = "verify-offers.json";
const LOCK_FILE: &str = "verify-offers.lock";
const READ_CAP: u64 = 1_000_000;
const EVIDENCE_CAP: usize = 50;
const WALK_CAP: usize = 400;
/// How many `.e2e` entries a report will look through. Notable files are kept past `WALK_CAP`; this only stops a
/// huge tree from being read forever.
const SCAN_CAP: usize = 10_000;
const LOCK_TRIES: u32 = 20;
const LOCK_WAIT: Duration = Duration::from_millis(10);
const LOCK_STALE: Duration = Duration::from_secs(30);

/// Hivra's own skill. The package's skills are left as they shipped.
pub(crate) const WHEN_TO_VERIFY: &str = include_str!("when_to_verify.md");

const WEB_DEPS: &[&str] = &[
    "@angular/core",
    "@e2e-dev/web",
    "@remix-run/node",
    "@remix-run/react",
    "@sveltejs/kit",
    "astro",
    "gatsby",
    "next",
    "nuxt",
    "preact",
    "solid-js",
    "svelte",
    "vite",
    "vue",
];
const REACT_DEPS: &[&str] = &["react", "react-dom"];
const MOBILE_DEPS: &[&str] = &[
    "@capacitor/cli",
    "@capacitor/core",
    "@e2e-dev/mobile",
    "@expo/cli",
    "@ionic/core",
    "@ionic/react",
    "expo",
    "react-native",
];
const DESKTOP_DEPS: &[&str] = &[
    "@electron/remote",
    "@tauri-apps/api",
    "@tauri-apps/cli",
    "electron",
    "electron-builder",
    "electron-nightly",
];

const WEB_FILES: &[&[&str]] = &[
    &["angular.json"],
    &["astro.config.js"],
    &["astro.config.mjs"],
    &["astro.config.ts"],
    &["next.config.js"],
    &["next.config.mjs"],
    &["next.config.mts"],
    &["next.config.ts"],
    &["nuxt.config.js"],
    &["nuxt.config.mjs"],
    &["nuxt.config.ts"],
    &["remix.config.js"],
    &["remix.config.ts"],
    &["svelte.config.js"],
    &["svelte.config.ts"],
    &["vite.config.js"],
    &["vite.config.mjs"],
    &["vite.config.mts"],
    &["vite.config.ts"],
];
const MOBILE_FILES: &[&[&str]] = &[
    &["capacitor.config.js"],
    &["capacitor.config.json"],
    &["capacitor.config.ts"],
    &["ionic.config.json"],
];
const DESKTOP_FILES: &[&[&str]] = &[&["src-tauri", "tauri.conf.json"]];

/// What Settings shows for one project folder. `source` is the pinned index entry, never a version the page invents.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOffer {
    pub surfaces: Vec<String>,
    pub installed: bool,
    pub declined: bool,
    pub revision: u64,
    pub source: Option<source::InstallSource>,
}

/// A decline either landed or lost a race with another window. The offer is what is true after the attempt.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeclineResult {
    pub applied: bool,
    pub offer: VerifyOffer,
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Offers {
    pub(crate) revision: u64,
    pub(crate) declined: BTreeSet<String>,
    /// PT-1: which proof tool a first mate proposed for a folder, and whether the person said not now (per folder, per
    /// tool id; src-tauri/src/proof_tools/offers.rs). It shares this file, its lock and its `revision`, so one writer at a
    /// time and a stale writer loses. A file written before this existed has none, and reads as it always did.
    #[serde(
        default,
        skip_serializing_if = "BTreeMap::is_empty",
        deserialize_with = "lenient_tools"
    )]
    pub(crate) tools: BTreeMap<String, BTreeMap<String, ToolOffer>>,
}

/// PT-1: the `tools` record is read entry by entry. An entry that isn't one (a state this build doesn't know, a hand edit)
/// is left out, so it can never make the whole offer list unreadable and take the Verify offer down with it.
fn lenient_tools<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, BTreeMap<String, ToolOffer>>, D::Error> {
    let value = <Value as serde::Deserialize>::deserialize(deserializer)?;
    let mut out = BTreeMap::new();
    let Some(folders) = value.as_object() else {
        return Ok(out);
    };
    for (folder, tools) in folders {
        let Some(tools) = tools.as_object() else {
            continue;
        };
        let kept: BTreeMap<String, ToolOffer> = tools
            .iter()
            .filter_map(|(id, offer)| {
                serde_json::from_value::<ToolOffer>(offer.clone())
                    .ok()
                    .map(|offer| (id.clone(), offer))
            })
            .collect();
        if !kept.is_empty() {
            out.insert(folder.clone(), kept);
        }
    }
    Ok(out)
}

/// PT-1: what is on record about one proof tool in one folder. A tool with no record is open to be proposed.
#[derive(Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolState {
    /// A first mate put it to the person. It is never proposed again for this folder.
    Proposed,
    /// The person said not now (or turned it down in Settings). Never proposed again.
    Declined,
}

#[derive(Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolOffer {
    pub(crate) state: ToolState,
    /// The store's `revision` right after the proposal was recorded. Undoing a proposal that could not be asked (`release`)
    /// must match it, so a late undo of an older proposal never touches a newer one.
    #[serde(default)]
    pub(crate) claimed_at: u64,
}

struct PackageMeta {
    version: Option<String>,
    license: Option<String>,
}

/// Called after a package is fetched and before the loader reads it. Only the npm package `e2e` is wrapped. A local
/// folder or a git checkout is left as it is, so a folder with no `plugin.json` is still refused. An existing
/// `plugin.json` is never rewritten.
pub(crate) fn prepare_package(root: &Path, source: &source::InstallSource) -> Result<(), String> {
    let source::InstallSource::Npm { package, .. } = source else {
        return Ok(());
    };
    if package != PACKAGE_NAME {
        return Ok(());
    }
    let Some(meta) = package_meta(root) else {
        return Ok(());
    };
    let fresh = !has_regular_file(root, "plugin.json");
    // A link is refused before any write, so a `skills/` that points elsewhere can't receive the skill, and a
    // failure leaves the package as it was fetched.
    if fresh {
        guard_dest(root, "plugin.json")?;
        guard_dest(root, "mcp.json")?;
    }
    guard_dest(root, "skills/when-to-verify/SKILL.md")?;
    if fresh {
        let manifest = plugin_manifest(&meta)?;
        write_new(root, "plugin.json", manifest.as_bytes())?;
        let mcp = mcp_manifest();
        write_new(root, "mcp.json", mcp.as_bytes())?;
    }
    write_new(
        root,
        "skills/when-to-verify/SKILL.md",
        WHEN_TO_VERIFY.as_bytes(),
    )
}

fn package_meta(root: &Path) -> Option<PackageMeta> {
    let text = read_project_file(root, &["package.json"])?;
    let value: Value = serde_json::from_str(&text).ok()?;
    if value.get("name").and_then(Value::as_str) != Some(PACKAGE_NAME) {
        return None;
    }
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .and_then(usable_version);
    let license = value
        .get("license")
        .and_then(Value::as_str)
        .filter(|license| !license.trim().is_empty())
        .map(str::to_string);
    Some(PackageMeta { version, license })
}

fn usable_version(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 64 {
        return None;
    }
    text.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        .then(|| text.to_string())
}

fn plugin_manifest(meta: &PackageMeta) -> Result<String, String> {
    let mut value = json!({
        "$schema": PLUGIN_SCHEMA_1_0_0,
        "name": PLUGIN_NAME,
        "description": "Workers prove UI changes by driving the app and attaching evidence.",
        "homepage": "https://github.com/tester-army/e2e",
        "author": { "name": "Tester Army" },
    });
    if let Some(version) = &meta.version {
        value["version"] = json!(version);
    }
    if meta.license.as_deref() == Some("Apache-2.0") {
        value["license"] = json!("Apache-2.0");
    }
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

/// Both switches upstream documents turn its anonymous usage events off. The environment wins over the saved
/// preference, so a person who turned telemetry on elsewhere still sends nothing from a worker's session.
const TELEMETRY_OFF: [(&str, &str); 2] = [("E2E_TELEMETRY_DISABLED", "1"), ("DO_NOT_TRACK", "1")];

fn mcp_manifest() -> String {
    let env: serde_json::Map<String, Value> = TELEMETRY_OFF
        .iter()
        .map(|(key, value)| ((*key).to_string(), json!(value)))
        .collect();
    json!({
        "$schema": MCP_SCHEMA_1_0_0,
        "mcpServers": {
            SERVER_NAME: {
                "type": "stdio",
                "command": "node",
                "args": ["./dist/cli/bin.js", "mcp"],
                "env": env,
            },
        },
    })
    .to_string()
}

/// e2e finds the project by starting in it (`npx e2e mcp` from that folder). No other server does.
pub(crate) fn runs_in_session_folder(plugin: &str, server: &str) -> bool {
    plugin == PLUGIN_NAME && server == SERVER_NAME
}

/// The checkout e2e must start in. `Ok(None)` for every other server. A missing folder is an error, not the plugin
/// directory: e2e would then report that the project has no config.
pub(crate) fn project_workdir(
    plugin: &str,
    server: &str,
    project: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    if !runs_in_session_folder(plugin, server) {
        return Ok(None);
    }
    let Some(project) = project.map(str::trim).filter(|text| !text.is_empty()) else {
        return Err("Verify needs the worker's project folder.".into());
    };
    let folder = crate::fs::canonical(Path::new(project))
        .map_err(|_| "Verify's project folder isn't on this computer.".to_string())?;
    if !folder.is_dir() {
        return Err("Verify's project folder isn't on this computer.".into());
    }
    Ok(Some(folder))
}

/// `./` arguments become absolute paths inside the plugin. e2e's `node ./dist/cli/bin.js` would otherwise look in the
/// project after the working directory moves. Anything else is left as the plugin wrote it.
pub(crate) fn absolute_plugin_args(
    args: &[String],
    plugin_root: &Path,
) -> Result<Vec<String>, String> {
    let root = crate::fs::canonical(plugin_root).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(args.len());
    for arg in args {
        let Some(rel) = arg.strip_prefix("./") else {
            out.push(arg.clone());
            continue;
        };
        if rel.is_empty()
            || rel
                .split(['/', '\\'])
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("the server's program leaves the plugin.".into());
        }
        let path = crate::fs::canonical(root.join(rel))
            .map_err(|_| "the server's program isn't in the plugin.".to_string())?;
        if !path.starts_with(&root) {
            return Err("the server's program leaves the plugin.".into());
        }
        out.push(path.to_string_lossy().into_owned());
    }
    Ok(out)
}

fn has_regular_file(root: &Path, rel: &str) -> bool {
    let path = root.join(rel);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta.is_file() && !meta.file_type().is_symlink(),
        Err(_) => false,
    }
}

/// Refuse `rel` when it leaves `root` or a component is a link. This writes nothing.
fn guard_dest(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.as_os_str().is_empty()
        || !rel_path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err("The plugin file to write leaves the package.".into());
    }
    let mut cursor = root.to_path_buf();
    let last = rel_path.components().count();
    for (index, component) in rel_path.components().enumerate() {
        let Component::Normal(name) = component else {
            return Err("The plugin file to write leaves the package.".into());
        };
        cursor.push(name);
        let Ok(meta) = std::fs::symlink_metadata(&cursor) else {
            continue;
        };
        if !meta.file_type().is_symlink() {
            continue;
        }
        return Err(if index + 1 == last {
            "A file in the package points outside it, so it was left as it is.".into()
        } else {
            "A folder in the package points outside it, so nothing was written.".into()
        });
    }
    Ok(cursor)
}

/// Write `rel` under `root` unless it is already a real file. Parents are created one level at a time and never by
/// following a link.
fn write_new(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let dest = guard_dest(root, rel)?;
    if let Ok(meta) = std::fs::symlink_metadata(&dest) {
        if meta.is_file() {
            return Ok(());
        }
        return Err("The plugin file to write leaves the package.".into());
    }
    let root_canon = crate::fs::canonical(root).map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        let mut cursor = root.to_path_buf();
        if let Ok(rel_parent) = parent.strip_prefix(root) {
            for component in rel_parent.components() {
                let Component::Normal(name) = component else {
                    return Err("The plugin file to write leaves the package.".into());
                };
                cursor.push(name);
                match std::fs::symlink_metadata(&cursor) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        return Err(
                            "A folder in the package points outside it, so nothing was written."
                                .into(),
                        );
                    }
                    Ok(meta) if meta.is_dir() => {}
                    Ok(_) => return Err("The plugin file to write leaves the package.".into()),
                    Err(_) => std::fs::create_dir(&cursor).map_err(|e| e.to_string())?,
                }
            }
        }
        let parent_canon = crate::fs::canonical(parent).map_err(|e| e.to_string())?;
        if !parent_canon.starts_with(&root_canon) {
            return Err("The plugin file to write leaves the package.".into());
        }
    }
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())
}

/// Add `.e2e/` files to a worker's report. A missing folder, a link that leaves it, or a path that can't be read
/// adds nothing and is not a failure. Only files last modified at or after `since_ms` (epoch milliseconds) are
/// kept. Paths are stored relative to the worktree, with `/` between parts. Settle collects the files first
/// (`evidence_files`) and applies them later (`append_evidence`), so this is the tests' one-call form.
#[cfg(test)]
pub(crate) fn merge_evidence(
    report: &mut crate::firstmate::report::WorkerReport,
    worktree: &Path,
    since_ms: i64,
) {
    append_evidence(report, evidence_files(worktree, since_ms));
}

/// `.e2e/` files modified at or after `since_ms`, in walk order. A missing folder adds nothing. This only reads
/// the filesystem, so a settle can call it before it opens its write transaction.
pub(crate) fn evidence_files(worktree: &Path, since_ms: i64) -> Vec<String> {
    let Ok(root) = crate::fs::canonical(worktree) else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }
    let e2e = root.join(".e2e");
    let Ok(meta) = std::fs::symlink_metadata(&e2e) else {
        return Vec::new();
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Vec::new();
    }
    let Ok(e2e_root) = crate::fs::canonical(&e2e) else {
        return Vec::new();
    };
    if !e2e_root.starts_with(&root) {
        return Vec::new();
    }
    let mut found = Vec::new();
    walk_e2e(&e2e_root, &root, evidence_since(since_ms), &mut found);
    found
}

/// Put already-collected proof onto a report, newest-run files only, without reading the disk again.
pub(crate) fn append_evidence(
    report: &mut crate::firstmate::report::WorkerReport,
    mut found: Vec<String>,
) {
    found.sort_by(|a, b| rank(a).cmp(&rank(b)).then(a.cmp(b)));
    let room = EVIDENCE_CAP.saturating_sub(report.evidence.len());
    let mut add = Vec::new();
    for rel in found {
        if add.len() >= room {
            break;
        }
        if report.evidence.iter().any(|have| have == &rel) || add.contains(&rel) {
            continue;
        }
        add.push(rel);
    }
    report.evidence.extend(add);
}

fn evidence_since(since_ms: i64) -> Option<SystemTime> {
    if since_ms <= 0 {
        return Some(SystemTime::UNIX_EPOCH);
    }
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_millis(since_ms as u64))
}

fn modified_in_run(meta: &std::fs::Metadata, since: Option<SystemTime>) -> bool {
    let Some(since) = since else {
        return false;
    };
    matches!(meta.modified(), Ok(modified) if modified >= since)
}

fn is_notable(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name == "report.json" || name == "trace.md"
}

/// Breadth-first, so a top-level `report.json` is seen before a `cache/` that sorts first. `report.json` and
/// `trace.md` are kept even after ordinary files have filled `WALK_CAP`. `SCAN_CAP` is the only hard stop.
fn walk_e2e(dir: &Path, worktree: &Path, since: Option<SystemTime>, out: &mut Vec<String>) {
    let mut notables = Vec::new();
    let mut rest = Vec::new();
    let mut queue = VecDeque::new();
    queue.push_back(dir.to_path_buf());
    let mut seen = 0usize;
    while let Some(current) = queue.pop_front() {
        if seen >= SCAN_CAP {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect();
        paths.sort();
        let mut dirs = Vec::new();
        for path in paths {
            if seen >= SCAN_CAP {
                break;
            }
            seen += 1;
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                dirs.push(path);
                continue;
            }
            if !meta.is_file() || !modified_in_run(&meta, since) {
                continue;
            }
            let Ok(canon) = crate::fs::canonical(&path) else {
                continue;
            };
            let Some(rel) = relative_proof(&canon, worktree) else {
                continue;
            };
            if is_notable(&rel) {
                if !notables.contains(&rel) {
                    notables.push(rel);
                }
            } else if rest.len() < WALK_CAP && !rest.contains(&rel) {
                rest.push(rel);
            }
        }
        for child in dirs {
            queue.push_back(child);
        }
    }
    out.extend(notables);
    out.extend(rest);
}

fn relative_proof(file: &Path, worktree: &Path) -> Option<String> {
    let rel = file.strip_prefix(worktree).ok()?;
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            _ => return None,
        }
    }
    if parts.first().map(String::as_str) != Some(".e2e") || parts.len() < 2 {
        return None;
    }
    Some(parts.join("/"))
}

fn rank(rel: &str) -> u8 {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if name == "report.json" {
        return 0;
    }
    if name == "trace.md" {
        return 1;
    }
    match name.rsplit('.').next().unwrap_or("") {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "mp4" | "webm" => 2,
        _ => 3,
    }
}

/// Whether Verify should be offered for `folder`. This only reads. It never installs.
pub(crate) fn offer_for(host: &Host, folder: &str) -> Result<VerifyOffer, String> {
    if folder.trim().is_empty() {
        return Err("Name a project folder.".into());
    }
    let offers = read_offers(host)?;
    let installed = installed(host)?;
    let Some(key) = folder_key(folder).ok() else {
        return Ok(VerifyOffer {
            surfaces: Vec::new(),
            installed,
            declined: false,
            revision: offers.revision,
            source: pinned_source(),
        });
    };
    view(host, &offers, &key)
}

/// Remember that this folder was offered Verify and the person said not now. A stale `expected` revision writes
/// nothing: the other window's decision stands, and the returned offer is the current one.
pub(crate) fn decline(host: &Host, folder: &str, expected: u64) -> Result<DeclineResult, String> {
    let key = folder_key(folder)?;
    let _lock = exclusive(host)?;
    let mut offers = read_offers(host)?;
    if offers.revision != expected {
        return Ok(DeclineResult {
            applied: false,
            offer: view(host, &offers, &key)?,
        });
    }
    offers.declined.insert(fsutil::display(&key));
    offers.revision = offers.revision.saturating_add(1);
    write_offers(host, &offers)?;
    Ok(DeclineResult {
        applied: true,
        offer: view(host, &offers, &key)?,
    })
}

fn view(host: &Host, offers: &Offers, folder: &Path) -> Result<VerifyOffer, String> {
    Ok(VerifyOffer {
        surfaces: surfaces_of(folder),
        installed: installed(host)?,
        declined: offers.declined.contains(&fsutil::display(folder)),
        revision: offers.revision,
        source: pinned_source(),
    })
}

fn installed(host: &Host) -> Result<bool, String> {
    Ok(registry::read(host)?.plugins.contains_key(PLUGIN_NAME))
}

pub(crate) fn folder_key(folder: &str) -> Result<PathBuf, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("Name a project folder.".into());
    }
    let path = crate::fs::canonical(crate::fs::expand_home(folder))
        .map_err(|_| "That folder isn't on this computer.".to_string())?;
    if !path.is_dir() {
        return Err("That folder isn't on this computer.".into());
    }
    Ok(path)
}

fn pinned_source() -> Option<source::InstallSource> {
    let index = discover::read_index(
        discover::BUNDLED_INDEX,
        &discover::Origin::Elsewhere,
        discover::platform(),
    )
    .ok()?;
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.name == PLUGIN_NAME && entry.status == Status::Available)?;
    entry.source.as_ref().map(to_install_source)
}

fn to_install_source(source: &discover::InstallSource) -> source::InstallSource {
    match source {
        discover::InstallSource::Npm {
            package,
            version,
            registry,
        } => source::InstallSource::Npm {
            package: package.clone(),
            version: version.clone(),
            registry: registry.clone(),
        },
        discover::InstallSource::Git { url, commit, path } => source::InstallSource::Git {
            url: url.clone(),
            commit: Some(commit.clone()),
            tag: None,
            path: path.clone(),
        },
        // WP-43: a plugin can be pinned to its own folder. That is a local install, not an npm package.
        discover::InstallSource::Local { path } => {
            source::InstallSource::Local { path: path.clone() }
        }
    }
}

/// `web` and `mobile`, in that order. A desktop shell (Tauri, Electron) is not a web app even when it uses Vite.
pub(crate) fn surfaces_of(root: &Path) -> Vec<String> {
    let Some(root) = crate::fs::canonical(root).ok().filter(|path| path.is_dir()) else {
        return Vec::new();
    };
    let package = read_project_file(&root, &["package.json"])
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    let deps = dep_names(&package);
    let has = |names: &[&str]| names.iter().any(|name| deps.contains(*name));
    let desktop = has(DESKTOP_DEPS)
        || DESKTOP_FILES
            .iter()
            .any(|parts| has_project_file(&root, parts));
    let mobile = has(MOBILE_DEPS)
        || MOBILE_FILES
            .iter()
            .any(|parts| has_project_file(&root, parts))
        || read_project_file(&root, &["app.json"]).is_some_and(|text| expo_app(&text))
        || read_project_file(&root, &["pubspec.yaml"]).is_some_and(|text| flutter_pubspec(&text));
    let mut web = has(WEB_DEPS)
        || WEB_FILES.iter().any(|parts| has_project_file(&root, parts))
        || (has(REACT_DEPS) && !mobile);
    if desktop {
        web = false;
    }
    let mut surfaces = Vec::new();
    if web {
        surfaces.push("web".into());
    }
    if mobile {
        surfaces.push("mobile".into());
    }
    surfaces
}

// PT-1: `pub(crate)` so proof-tool detection reads package.json the way the Verify offer does.
pub(crate) fn dep_names(package: &Value) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for field in ["dependencies", "devDependencies"] {
        let Some(object) = package.get(field).and_then(Value::as_object) else {
            continue;
        };
        names.extend(object.keys().cloned());
    }
    names
}

fn expo_app(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get("expo").cloned())
        .is_some_and(|value| !value.is_null())
}

fn flutter_pubspec(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim().trim_end_matches('\r');
        !line.starts_with('#') && (line == "flutter:" || line.starts_with("flutter:"))
    })
}

pub(crate) fn has_project_file(root: &Path, parts: &[&str]) -> bool {
    project_file(root, parts).is_some()
}

/// A known relative file inside `root`, or nothing. Links are not followed: a `package.json` that points somewhere
/// else is not this project's manifest.
pub(crate) fn read_project_file(root: &Path, parts: &[&str]) -> Option<String> {
    let path = project_file(root, parts)?;
    read_capped(&path)
}

pub(crate) fn project_file(root: &Path, parts: &[&str]) -> Option<PathBuf> {
    if parts.is_empty() {
        return None;
    }
    let root = crate::fs::canonical(root).ok()?;
    if !root.is_dir() {
        return None;
    }
    let mut path = root.clone();
    for part in parts {
        if part.is_empty() || part.contains("..") || part.contains('/') || part.contains('\\') {
            return None;
        }
        path.push(part);
    }
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return None;
    }
    let canon = crate::fs::canonical(&path).ok()?;
    canon.starts_with(&root).then_some(canon)
}

pub(crate) fn read_capped(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(READ_CAP + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > READ_CAP {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    Some(text.trim_start_matches('\u{feff}').to_string())
}

fn offers_path(host: &Host) -> PathBuf {
    host.root.join(OFFERS_FILE)
}

pub(crate) fn read_offers(host: &Host) -> Result<Offers, String> {
    match std::fs::read_to_string(offers_path(host)) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|_| "The offer list can't be read. Nothing was changed.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Offers::default()),
        Err(error) => Err(format!("The offer list can't be read: {error}")),
    }
}

pub(crate) fn write_offers(host: &Host, offers: &Offers) -> Result<(), String> {
    std::fs::create_dir_all(&host.root).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(offers).map_err(|e| e.to_string())?;
    fsutil::write_atomic(&offers_path(host), text.as_bytes())
}

pub(crate) struct Lock(PathBuf);

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// One writer at a time. A lock left by a dead window is taken after it goes stale; a live one is a reason to try
/// again, not a final failure.
pub(crate) fn exclusive(host: &Host) -> Result<Lock, String> {
    std::fs::create_dir_all(&host.root).map_err(|e| e.to_string())?;
    let path = host.root.join(LOCK_FILE);
    for _ in 0..LOCK_TRIES {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(Lock(path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(&path) {
                    let _ = std::fs::remove_file(&path);
                    continue;
                }
                std::thread::sleep(LOCK_WAIT);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Another window is saving this. Try again.".into())
}

fn lock_is_stale(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified)
        .ok()
        .is_some_and(|age| age > LOCK_STALE)
}

#[tauri::command(async)]
pub fn plugins_verify_offer(app: tauri::AppHandle, folder: String) -> Result<VerifyOffer, String> {
    offer_for(&super::host(&app)?, &folder)
}

#[tauri::command(async)]
pub fn plugins_verify_decline(
    app: tauri::AppHandle,
    folder: String,
    revision: u64,
) -> Result<DeclineResult, String> {
    decline(&super::host(&app)?, &folder, revision)
}
