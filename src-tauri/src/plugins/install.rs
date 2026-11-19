//! Installing, updating and rolling back plugins safely (WP-31, docs/hivra/plugins/README.md "Installs"), after
//! DeepSeek Harness's plugin manager (ideas only, MIT): pinned sources (source.rs), a compatibility check before
//! download (compat.rs), stage, validate and swap, the person's OK before any script runs and for any install an
//! agent starts, and one-step rollback.
//!
//! ```text
//! pending/<id>/request.json   what waits for the person's OK: the plugin, what it adds, exactly what would run
//! pending/<id>/plugin/        the fetched, validated copy that goes into place once they say yes
//! previous/<name>/            the version the last update replaced
//! .trash/<id>/                what a swap moved aside, until it has finished (then removed)
//! ```
//!
//! Every step that fails puts back what was there: the installed folder, the previous version, the skills and
//! servers that were on, the registry and the lock file.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::compat::Declared;
use super::fsutil;
use super::manifest::{load_plugin, LoadedPlugin, Report};
use super::registry::{
    self, Contribution, Enablement, Entry, Host, Outcome, Registry, Snapshot, Source,
};
use super::scan;
use super::source::{self, InstallSource, Tools};
use super::wiring::passed_env;

/// Who asked for an install. An agent's request always waits for the person's OK.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestedBy {
    /// `person` or `agent`.
    pub kind: String,
    /// The asking agent's chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// The asking Mono, when one asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mono: Option<String>,
    /// Why it asked, in its words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl RequestedBy {
    pub fn person() -> Self {
        Self {
            kind: "person".into(),
            ..Self::default()
        }
    }
    fn is_agent(&self) -> bool {
        self.kind != "person"
    }
}

/// The app put the files in place. A person with no chat asked, a Mono when one
/// is named, otherwise the first mate's chat. The reason they typed is not kept.
fn install_initiator(by: &RequestedBy) -> crate::activity::Who {
    let session = by.session.as_deref().unwrap_or("").trim();
    let mono = by.mono.as_deref().unwrap_or("").trim();
    if by.kind == "person" || (session.is_empty() && mono.is_empty()) {
        return crate::activity::Who::person();
    }
    if !mono.is_empty() {
        return crate::activity::Who::mono(mono, "");
    }
    crate::activity::Who::first_mate(session, "")
}

fn note_install(host: &Host, request: &PendingRequest) {
    let (kind, verb) = if request.op == "update" {
        (crate::activity::PLUGIN_UPDATE, "Updated")
    } else {
        (crate::activity::PLUGIN_INSTALL, "Installed")
    };
    crate::activity::note_db(
        &registry::activity_db(host),
        kind,
        &crate::activity::Who::app(),
        &install_initiator(&request.requested_by),
        request.project.as_deref().unwrap_or(""),
        &request.name,
        &format!("{verb} {}.", request.name),
        "",
    );
}

/// One command an install wants to run, shown exactly before it does.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptStep {
    /// The program and its arguments, run without a shell.
    pub run: Vec<String>,
    /// Its working folder, relative to the plugin.
    pub cwd: String,
    /// Why it runs, and anything it will run in turn (package.json's install scripts).
    pub why: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub id: String,
    /// `install` or `update`.
    pub op: String,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// The version it would replace, for an update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
    pub source: InstallSource,
    /// The source as it was pinned (the commit a tag pointed at).
    pub resolved: Source,
    pub requested_by: RequestedBy,
    pub steps: Vec<ScriptStep>,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub reports: Vec<Report>,
    /// WP-101: what the scan of the staged copy found. Blocks never reach this (they refuse the install); warnings
    /// are shown on the pending card. Defaulted so a request saved by an earlier build still reads.
    #[serde(default)]
    pub scan: scan::ScanResult,
    pub created_at_ms: u64,
    /// The project folder to turn this plugin on for, once the install lands. None leaves it off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// What `install`, `update` and `approve` did: put it in place, or left it waiting for the person.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InstallResult {
    Installed {
        entry: Option<Box<Entry>>,
        reports: Vec<Report>,
    },
    Waiting {
        request: Box<PendingRequest>,
    },
}

const REQUEST_FILE: &str = "request.json";

fn pending_dir(host: &Host, id: &str) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("That request isn't waiting any more.".into());
    }
    Ok(host.pending().join(id))
}

/// Install a plugin from a pinned source. A person's install with nothing to run goes straight in; an agent's, or
/// one that wants to run something, waits (`Waiting`) for the person's OK.
pub fn install(
    host: &Host,
    tools: &Tools,
    source: &InstallSource,
    by: RequestedBy,
) -> Result<InstallResult, String> {
    install_for(host, tools, source, by, None)
}

/// Install, and once it lands turn it on for `project` only. A package that has to wait keeps the folder on the
/// pending request, so the person's OK enables that project and no other.
pub fn install_for(
    host: &Host,
    tools: &Tools,
    source: &InstallSource,
    by: RequestedBy,
    project: Option<String>,
) -> Result<InstallResult, String> {
    let project = normalize_project(project)?;
    let (dir, request) = prepare(host, tools, source, None, by, project)?;
    settle(host, tools, dir, request)
}

/// An empty project is a mistake, not "everywhere". A real one is stored as the same key enable uses.
fn normalize_project(project: Option<String>) -> Result<Option<String>, String> {
    let Some(project) = project else {
        return Ok(None);
    };
    let project = project.trim();
    if project.is_empty() {
        return Err("Name a project folder.".into());
    }
    let path = crate::fs::expand_home(project);
    registry::project_key(&path.to_string_lossy()).map(Some)
}

/// Update an installed plugin to another pinned version. The installed one stays until the new one validates.
pub fn update(
    host: &Host,
    tools: &Tools,
    name: &str,
    source: &InstallSource,
    by: RequestedBy,
) -> Result<InstallResult, String> {
    let (dir, request) = prepare(host, tools, source, Some(name), by, None)?;
    settle(host, tools, dir, request)
}

fn settle(
    host: &Host,
    tools: &Tools,
    dir: PathBuf,
    request: PendingRequest,
) -> Result<InstallResult, String> {
    if request.requested_by.is_agent() || !request.steps.is_empty() {
        let text = serde_json::to_string_pretty(&request).map_err(|e| e.to_string())?;
        if let Err(why) = fsutil::write_atomic(&dir.join(REQUEST_FILE), text.as_bytes()) {
            drop_pending(host, &dir);
            return Err(format!("The request couldn't be saved: {why}"));
        }
        return Ok(InstallResult::Waiting {
            request: Box::new(request),
        });
    }
    commit(host, tools, &dir, &request, false)
}

/// The person said yes: run what it asked to run (if anything), then put it in place.
pub fn approve(host: &Host, tools: &Tools, id: &str) -> Result<InstallResult, String> {
    let dir = pending_dir(host, id)?;
    let request = read_request(&dir)?;
    commit(host, tools, &dir, &request, true)
}

/// The person said no: the fetched copy goes, nothing was installed.
pub fn decline(host: &Host, id: &str) -> Result<(), String> {
    let dir = pending_dir(host, id)?;
    read_request(&dir)?;
    fsutil::remove_tree(&dir)?;
    fsutil::remove_dir_if_empty(&host.pending());
    Ok(())
}

/// Everything waiting for the person, oldest first.
pub fn pending(host: &Host) -> Vec<PendingRequest> {
    let Ok(entries) = std::fs::read_dir(host.pending()) else {
        return Vec::new();
    };
    let mut out: Vec<PendingRequest> = entries
        .flatten()
        .filter_map(|entry| read_request(&entry.path()).ok())
        .collect();
    out.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then(a.id.cmp(&b.id)));
    out
}

fn read_request(dir: &Path) -> Result<PendingRequest, String> {
    let text = std::fs::read_to_string(dir.join(REQUEST_FILE))
        .map_err(|_| "That request isn't waiting any more.".to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("That request can't be read: {e}"))
}

fn drop_pending(host: &Host, dir: &Path) {
    let _ = fsutil::remove_tree(dir);
    fsutil::remove_dir_if_empty(&host.pending());
}

/// Fetch the request's pinned source back into `pending/<id>/plugin`. The pending request itself is left in place,
/// including when this fails, so the same approval can be tried again.
fn restage(dir: &Path, request: &PendingRequest, tools: &Tools) -> Result<(), String> {
    let staged = dir.join("plugin");
    let work = dir.join("fetch");
    let _ = fsutil::remove_tree(&work);
    let _ = fsutil::remove_tree(&staged);
    let outcome = (|| {
        let fetched = source::fetch(&request.source, tools, &work)?;
        super::verify::prepare_package(&fetched.root, &request.source)?;
        let checked = load_plugin(&fetched.root).map_err(|e| e.0)?;
        if checked.manifest.name != request.name {
            return Err(format!(
                "That source holds \"{}\", not \"{}\".",
                checked.manifest.name, request.name
            ));
        }
        manifest_declared(&checked)?.check(&tools.target)?;
        // WP-101: a re-fetched copy is scanned again; the pinned source could have changed under it. The re-fetched
        // copy is the one the person approves, so a warning the card never showed also stops it.
        refuse_changed(&new_scan(&fetched.root, &staged)?, request)?;
        Ok(())
    })();
    let _ = fsutil::remove_tree(&work);
    if outcome.is_err() {
        let _ = fsutil::remove_tree(&staged);
    }
    outcome
}

/// Fetch, check and stage a plugin under `pending/<id>/plugin`. Nothing outside that folder changes, and on failure
/// it goes too.
fn prepare(
    host: &Host,
    tools: &Tools,
    source: &InstallSource,
    updating: Option<&str>,
    by: RequestedBy,
    project: Option<String>,
) -> Result<(PathBuf, PendingRequest), String> {
    source.check()?;
    let installed = registry::read(host)?;
    if let Some(name) = updating {
        if !installed.plugins.contains_key(name) {
            return Err(format!("\"{name}\" isn't installed."));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = host.pending().join(&id);
    let result = (|| {
        let work = dir.join("fetch");
        let fetched = source::fetch(source, tools, &work)?;
        // WP-42: the npm package e2e has no plugin.json. Add Hivra's entry before the loader reads it.
        super::verify::prepare_package(&fetched.root, source)?;
        let checked = load_plugin(&fetched.root).map_err(|e| e.0)?;
        manifest_declared(&checked)?.check(&tools.target)?;
        let name = checked.manifest.name.clone();
        let replaces = match updating {
            Some(want) if want != name => {
                return Err(format!(
                    "That source holds \"{name}\", not \"{want}\", so it can't update it."
                ))
            }
            Some(want) => Some(
                installed.plugins[want]
                    .version
                    .clone()
                    .unwrap_or_else(|| "its current version".into()),
            ),
            None if installed.plugins.contains_key(&name) => {
                return Err(format!(
                    "\"{name}\" is already installed. Update it instead."
                ))
            }
            None => None,
        };
        let staged = dir.join("plugin");
        // WP-101: read the fetched folder before the copy, so a link that points outside the plugin is refused with a
        // reason rather than silently left out, then read the copy for everything else. A block refuses now, with
        // nothing placed and the pending folder dropped by the caller; warnings travel on the request for the card.
        let scanned = new_scan(&fetched.root, &staged)?;
        if scanned.blocked {
            return Err(format!(
                "\"{name}\" didn't pass the install check: {}",
                scan::blocking_reason(&scanned)
            ));
        }
        let _ = fsutil::remove_tree(&work);
        let loaded = load_plugin(&staged).map_err(|e| e.0)?;
        let steps = script_steps(&loaded)?;
        Ok(PendingRequest {
            id: id.clone(),
            op: if updating.is_some() {
                "update"
            } else {
                "install"
            }
            .into(),
            name,
            version: loaded.manifest.version.clone(),
            description: loaded.manifest.description.clone(),
            replaces,
            source: source.clone(),
            resolved: fetched.source,
            requested_by: by,
            steps,
            skills: loaded.skills.iter().map(|s| s.name.clone()).collect(),
            mcp_servers: loaded.mcp_servers.iter().map(|s| s.name.clone()).collect(),
            reports: loaded.reports,
            scan: scanned,
            created_at_ms: registry::now_ms(),
            project,
        })
    })();
    match result {
        Ok(request) => Ok((dir, request)),
        Err(why) => {
            drop_pending(host, &dir);
            Err(why)
        }
    }
}

/// Copy `fetched` into `staged`, then read it: first the fetched folder for links and paths that would be dropped, then
/// the copy for everything else. The result carries the copy's content hash.
fn new_scan(fetched: &Path, staged: &Path) -> Result<scan::ScanResult, String> {
    let runway = scan::scan_source(fetched, staged);
    if runway.iter().any(|f| f.severity == scan::Severity::Block) {
        return Ok(scan::ScanResult {
            blocked: true,
            findings: runway,
            ..scan::ScanResult::default()
        });
    }
    fsutil::copy_plugin_tree(fetched, staged)?;
    let mut result = scan::scan_untrusted(staged);
    result.findings.extend(runway);
    result.blocked = result
        .findings
        .iter()
        .any(|f| f.severity == scan::Severity::Block);
    Ok(result)
}

/// The copy fetched again has to be the copy the person was shown: same content, same findings. Anything else stops,
/// because they approved a card that no longer describes what would land.
fn refuse_changed(fresh: &scan::ScanResult, request: &PendingRequest) -> Result<(), String> {
    if fresh.blocked {
        return Err(scan::blocking_reason(fresh));
    }
    let shown = &request.scan;
    // WP-101 fix round 2, item H(c): a request written without a hash (an older build, a hand-edited one) cannot
    // prove the copy is the one that was read, so it stops rather than skipping the check.
    if shown.digest.is_empty() {
        return Err(
            "That request was saved before the install check kept a hash, so the copy can't be proved. Start the install again."
                .into(),
        );
    }
    let same_digest = fresh.digest == shown.digest;
    if same_digest && fresh.findings.len() == shown.findings.len() {
        let mut had: Vec<(&str, &str, &str)> = fresh
            .findings
            .iter()
            .map(|f| (f.code.as_str(), f.path.as_str(), f.message.as_str()))
            .collect();
        let mut seen: Vec<(&str, &str, &str)> = shown
            .findings
            .iter()
            .map(|f| (f.code.as_str(), f.path.as_str(), f.message.as_str()))
            .collect();
        had.sort_unstable();
        seen.sort_unstable();
        if had == seen {
            return Ok(());
        }
    }
    Err("The copy fetched again isn't the one you were shown, so nothing was installed. Ask for it again to see what changed.".into())
}

fn manifest_declared(loaded: &LoadedPlugin) -> Result<Declared, String> {
    let value = serde_json::json!({ "extensions": loaded.manifest.extensions });
    Declared::from_manifest(&value)
}

/// Whether the staged copy, or a folder anywhere inside it, is now a link (WP-101 fix round 2, item H(d)). The scan
/// that recorded the digest walked real folders; a link in their place reads whatever it points to, so it is a change
/// however the files behind it look. A top-level link is refused by `scan`'s own walk ("it isn't a folder"); this
/// catches the ones deeper in, which the walk follows silently.
fn staged_swapped_for_link(staged: &Path) -> Option<String> {
    fn visit(dir: &Path) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // A link is a link whatever it points at: `symlink_metadata` reports the link itself, so this checks the
            // link before looking at whether a real folder would have been walked. Reading through the link's target
            // would hide exactly the change this looks for.
            if fsutil::link_target(&path).is_some() {
                return true;
            }
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() && visit(&path) {
                return true;
            }
        }
        false
    }
    if fsutil::link_target(staged).is_some() {
        return Some(
            "The downloaded copy was replaced by a link after it was read, so nothing was installed. Ask for it again."
                .into(),
        );
    }
    if visit(staged) {
        return Some(
            "A folder in the downloaded copy was replaced by a link after it was read, so nothing was installed. Ask for it again."
                .into(),
        );
    }
    None
}

/// Read the staged copy again. A link, a scan that blocks, or (when `expected` is set) a different hash is a change,
/// and the same sentences the earlier check uses are returned. With no expected hash, the hash of this read is
/// returned so a later read can be compared with it: an approved script is allowed to write, and that result is what
/// gets installed.
fn read_staged(staged: &Path, expected: Option<&str>) -> Result<String, String> {
    if let Some(why) = staged_swapped_for_link(staged) {
        return Err(why);
    }
    let now = scan::scan_untrusted(staged);
    if now.blocked {
        return Err(format!(
            "The copy changed after it was read: {} Ask for it again.",
            scan::blocking_reason(&now)
        ));
    }
    if expected.is_some_and(|expected| expected != now.digest) || now.digest.is_empty() {
        return Err(
            "The copy changed after it was read, so nothing was installed. Ask for it again to see what changed."
                .into(),
        );
    }
    Ok(now.digest)
}

/// After the approved steps. Their writes are part of the copy; a link or a blocked scan is not.
fn seal_after_steps(staged: &Path, sealed: &mut String) -> Result<(), String> {
    *sealed = read_staged(staged, None)?;
    Ok(())
}

/// Inside the registry lock, immediately before the copy is moved. A test may write one file first; either way a
/// difference from `sealed` stops the install.
fn prove_unchanged(staged: &Path, sealed: &str) -> Result<(), String> {
    tamper_before_install(staged);
    read_staged(staged, Some(sealed))?;
    Ok(())
}

/// Run what the request asked for (it was approved, or asked for nothing), validate again, then put it in place.
fn commit(
    host: &Host,
    tools: &Tools,
    dir: &Path,
    request: &PendingRequest,
    approved: bool,
) -> Result<InstallResult, String> {
    let staged = dir.join("plugin");
    // A previous approval installed it and then failed to turn it on. The staged copy was moved into
    // place, so this retry must not run the steps again or install a second time. It only enables.
    let already = if request.op.as_str() == "update" {
        None
    } else {
        registry::read(host)
            .ok()
            .and_then(|registry| registry.plugins.get(&request.name).cloned())
    };
    // The staged copy can already be gone while the plugin is still not installed: a previous attempt moved it
    // and then failed. Fetch the pinned source again. If that cannot be done, keep the request so it can be tried again.
    if already.is_none() && !staged.is_dir() {
        if let Err(why) = restage(dir, request, tools) {
            return Err(format!(
                "The downloaded copy is gone and couldn't be fetched again ({why}). Try again."
            ));
        }
    }
    // The hash of the copy last read. An approved script may write into the staged folder, and then this
    // becomes the hash of that result. With no script it is the hash matched to the card.
    let mut sealed = String::new();
    if already.is_none() && staged.is_dir() {
        // WP-101: the copy that lands is the copy that was read. Anything changed since the scan (a retry, a moved
        // tag, something writing in the data folder) stops the install rather than installing what nobody saw.
        // WP-101 fix round 2, item H(c): a request with no hash can't prove anything, so it stops too.
        if request.scan.digest.is_empty() {
            drop_pending(host, dir);
            return Err(
                "That request was saved before the install check kept a hash, so the copy can't be proved. Start the install again."
                    .into(),
            );
        }
        match read_staged(&staged, Some(request.scan.digest.as_str())) {
            Ok(digest) => sealed = digest,
            Err(why) => {
                drop_pending(host, dir);
                return Err(why);
            }
        }
    }
    if already.is_none() && !request.steps.is_empty() {
        if !approved {
            return Err("It needs the person's OK before anything runs.".into());
        }
        if let Err(why) = run_steps(&staged, &request.steps, tools) {
            drop_pending(host, dir);
            return Err(format!("{why} Nothing was installed."));
        }
        // The steps ran in the staged copy. Read that copy before it is trusted: a link, or a scan that blocks,
        // is not what was approved. The hash of this read is what must still be there when the copy is put in place.
        if let Err(why) = seal_after_steps(&staged, &mut sealed) {
            drop_pending(host, dir);
            return Err(why);
        }
    }
    let mut placed = false;
    let result = {
        let _guard = registry::lock();
        if let Some(entry) = already {
            Ok(registry::Outcome {
                entry: Some(entry),
                reports: Vec::new(),
            })
        } else {
            // Immediately before the copy is moved. A change since the last read, including one a test writes here,
            // stops the install. The pending folder is removed by the caller once this lock is released.
            if let Err(why) = prove_unchanged(&staged, &sealed) {
                Err(why)
            } else {
                placed = true;
                match request.op.as_str() {
                    "update" => {
                        update_staged(host, &request.name, &staged, request.resolved.clone())
                    }
                    _ => registry::install_staged(host, &staged, request.resolved.clone()),
                }
            }
        }
    };
    let outcome = match result {
        Ok(outcome) => {
            if placed {
                // WP-78: the files are in place, before enable (a failed enable can be retried
                // without a second row). The reason they gave is not stored.
                note_install(host, request);
            }
            outcome
        }
        Err(why) => {
            drop_pending(host, dir);
            return Err(why);
        }
    };
    // WP-42: the offer's project was stored on the request. Turn it on for that folder only, once it is in place.
    // Enable takes the registry lock itself, so this stays outside the install lock above.
    let outcome = if let Some(project) = &request.project {
        match registry::enable(
            host,
            &request.name,
            &registry::Scope::Project(project.clone()),
        ) {
            Ok(enabled) => enabled,
            Err(why) => {
                // The plugin is in place, but not on for this project. Keep the request so the same approval
                // can be retried; dropping it would leave Verify off with nothing left to approve.
                return Err(why);
            }
        }
    } else {
        outcome
    };
    // WP-43: install the pinned browser engine into the plugin's data folder. A failure here
    // (no npm, a pin that is not a real checksum) does not undo the plugin.
    if request.name == "browser" {
        let _ = crate::browser::engine::install_engine(
            &host.installed("browser"),
            &host.data("browser"),
            tools,
        );
    }
    drop_pending(host, dir);
    Ok(InstallResult::Installed {
        entry: outcome.entry.map(Box::new),
        reports: outcome.reports,
    })
}

// ---- scripts ---------------------------------------------------------------------------------------------------

const NPM_INSTALL: [&str; 5] = ["npm", "install", "--omit=dev", "--no-audit", "--no-fund"];
const LIFECYCLE: [&str; 4] = ["preinstall", "install", "postinstall", "prepare"];

/// What an install would run: the Hivra extension's `setup` list when the plugin has one, otherwise `npm install`
/// for a `package.json` with dependencies or install scripts and no `node_modules` yet. Nothing else ever runs.
pub fn script_steps(loaded: &LoadedPlugin) -> Result<Vec<ScriptStep>, String> {
    let root = &loaded.root;
    let setup = loaded
        .manifest
        .extensions
        .get(super::hivra::NAMESPACE)
        .and_then(|ext| ext.get("setup"));
    if let Some(setup) = setup {
        return declared_steps(root, setup);
    }
    let Ok(text) = std::fs::read_to_string(root.join("package.json")) else {
        return Ok(Vec::new());
    };
    let Ok(package) = serde_json::from_str::<Value>(&text) else {
        return Ok(Vec::new());
    };
    if root.join("node_modules").exists() {
        return Ok(Vec::new());
    }
    let deps = package
        .get("dependencies")
        .and_then(Value::as_object)
        .map_or(0, |d| d.len());
    let scripts: Vec<String> = LIFECYCLE
        .iter()
        .filter_map(|name| {
            let command = package.get("scripts")?.get(*name)?.as_str()?;
            Some(format!("{name}: {command}"))
        })
        .collect();
    if deps == 0 && scripts.is_empty() {
        return Ok(Vec::new());
    }
    let mut why = match deps {
        0 => "package.json asks for an install".to_string(),
        1 => "package.json lists 1 dependency to download".to_string(),
        n => format!("package.json lists {n} dependencies to download"),
    };
    if !scripts.is_empty() {
        why.push_str(&format!(
            ", and npm will run its scripts: {}",
            scripts.join("; ")
        ));
    }
    if deps > 0 {
        why.push_str(". Their own install scripts run too");
    }
    why.push('.');
    Ok(vec![ScriptStep {
        run: NPM_INSTALL.iter().map(|s| s.to_string()).collect(),
        cwd: ".".into(),
        why,
    }])
}

fn declared_steps(root: &Path, setup: &Value) -> Result<Vec<ScriptStep>, String> {
    let refuse = |why: &str| Err(format!("plugin.json: extensions.hivra.setup {why}."));
    let Some(items) = setup.as_array() else {
        return refuse("must be a list");
    };
    let mut steps = Vec::new();
    for item in items {
        let run: Vec<String> = match item.get("run").and_then(Value::as_array) {
            Some(args) if !args.is_empty() => args
                .iter()
                .map(|a| a.as_str().map(str::to_string))
                .collect::<Option<_>>()
                .ok_or_else(|| {
                    "plugin.json: a setup step's run must be a list of text".to_string()
                })?,
            _ => return refuse("needs \"run\": [program, args…] in every step"),
        };
        let program = &run[0];
        let bare = !program.is_empty()
            && program
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            && !program.starts_with('.');
        let in_plugin = program.starts_with("./")
            && Path::new(&program[2..])
                .components()
                .all(|c| matches!(c, Component::Normal(_)));
        if !(bare || in_plugin) {
            return refuse("runs a program by name (\"npm\") or from inside the plugin (\"./bin/setup\"), never a shell line");
        }
        let cwd = item.get("cwd").and_then(Value::as_str).unwrap_or(".");
        let cwd_ok = cwd == "."
            || Path::new(cwd)
                .components()
                .all(|c| matches!(c, Component::Normal(_)));
        if !cwd_ok || !root.join(cwd).is_dir() {
            return refuse("names a working folder that isn't inside the plugin");
        }
        let why = item
            .get("why")
            .and_then(Value::as_str)
            .unwrap_or("The plugin asks for it.")
            .to_string();
        steps.push(ScriptStep {
            run,
            cwd: cwd.to_string(),
            why,
        });
    }
    Ok(steps)
}

/// What a script may see: what a plugin server gets (wiring::PASSED_ENV), plus the proxy and certificate settings a
/// download needs. No API keys, no app connection.
const SCRIPT_ENV: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
];

fn run_steps(root: &Path, steps: &[ScriptStep], tools: &Tools) -> Result<(), String> {
    for step in steps {
        let program: OsString = match step.run[0].as_str() {
            "npm" => tools.npm.clone(),
            p if p.starts_with("./") => root.join(&p[2..]).into_os_string(),
            p => p.into(),
        };
        let mut cmd = Command::new(&program);
        crate::hide_window_console(&mut cmd);
        cmd.args(&step.run[1..])
            .current_dir(root.join(&step.cwd))
            .env_clear()
            .envs(passed_env(std::env::vars_os()))
            .envs(
                std::env::vars_os()
                    .filter(|(k, _)| SCRIPT_ENV.contains(&k.to_string_lossy().as_ref())),
            )
            .env("PLUGIN_ROOT", root)
            .stdin(Stdio::null());
        if let Some(path) = &tools.path {
            cmd.env("PATH", path);
        }
        let shown = step.run.join(" ");
        let output = cmd
            .output()
            .map_err(|e| format!("\"{shown}\" couldn't start: {e}."))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let last = err
                .lines()
                .map(str::trim)
                .rfind(|l| !l.is_empty())
                .unwrap_or("it failed");
            return Err(format!("\"{shown}\" failed: {last}."));
        }
    }
    Ok(())
}

// ---- update and rollback ----------------------------------------------------------------------------------------

#[cfg(test)]
thread_local! {
    /// Tests: fail an update or rollback right after its swap, to prove the way back.
    pub(super) static FAIL_AFTER_SWAP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Tests: write one file into the staged copy after it was last read and before it is put in place.
    pub(super) static TAMPER_BEFORE_INSTALL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// A test writes one file here, once, and the flag is cleared as it is read so a later install on this thread is
/// left alone. A real install never sets the flag.
fn tamper_before_install(staged: &Path) {
    #[cfg(test)]
    if TAMPER_BEFORE_INSTALL.with(|flag| flag.replace(false)) {
        let _ = std::fs::write(staged.join("tamper.txt"), b"tampered");
    }
    #[cfg(not(test))]
    let _ = staged;
}

fn failed_after_swap() -> Result<(), String> {
    #[cfg(test)]
    if FAIL_AFTER_SWAP.with(|f| f.get()) {
        return Err("The new version didn't validate (test).".into());
    }
    Ok(())
}

/// Make what an enabled plugin contributes, for the scopes in `enabled`.
fn reactivate(
    host: &Host,
    loaded: &LoadedPlugin,
    enabled: &Enablement,
    registry: &mut Registry,
    reports: &mut Vec<Report>,
) -> Result<Vec<Contribution>, String> {
    if !enabled.any() {
        return Ok(Vec::new());
    }
    let mut made = registry::activate(host, loaded)?;
    if enabled.global {
        match registry::link_skills(host, loaded, &mut registry.created_dirs, reports) {
            Ok(links) => made.extend(links),
            Err(why) => {
                registry::dispose_all(host, made.iter().rev());
                return Err(why);
            }
        }
    }
    Ok(made)
}

fn rename(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(from, to).map_err(|e| format!("{} couldn't be moved: {e}", from.display()))
}

/// Switch everything a plugin contributes off for a swap, keeping its files and data. `Err` when something couldn't be
/// undone; the plugin is then left switched off, which the error says.
fn switch_off(host: &Host, entry: &Entry, registry: &mut Registry) -> Result<Entry, String> {
    let mut off = entry.clone();
    off.enabled = Enablement::default();
    let failures = registry::retire(host, &mut off);
    if failures.is_empty() {
        return Ok(off);
    }
    registry.plugins.insert(entry.name.clone(), off);
    let _ = registry::write(host, registry);
    Err(format!(
        "It was switched off, but some of it couldn't be undone, so nothing was changed: {}",
        failures.join("; ")
    ))
}

/// Put an old version back after a failed swap: its folder in `installed/`, the previous version in `previous/`, and
/// what it contributed. The registry gets `old` back.
fn put_back(
    host: &Host,
    old: &Entry,
    off: &Entry,
    registry: &mut Registry,
    aside: &Path,
    old_installed_at: &Path,
) -> String {
    let mut problems = Vec::new();
    let installed = host.installed(&old.name);
    if old_installed_at != installed {
        if installed.exists() {
            if let Err(why) = rename(&installed, &aside.join("failed")) {
                problems.push(why);
            }
        }
        if let Err(why) = rename(old_installed_at, &installed) {
            problems.push(why);
        }
    }
    let kept_previous = aside.join("previous");
    if kept_previous.exists() {
        if let Err(why) = rename(&kept_previous, &host.previous(&old.name)) {
            problems.push(why);
        }
    }
    let mut entry = off.clone();
    match load_plugin(&installed) {
        Ok(loaded) => {
            let mut reports = Vec::new();
            match reactivate(host, &loaded, &old.enabled, registry, &mut reports) {
                Ok(made) => {
                    entry.contributions.extend(made);
                    entry.enabled = old.enabled.clone();
                }
                Err(why) => problems.push(why),
            }
        }
        Err(why) => problems.push(why.0),
    }
    if problems.is_empty() {
        entry = old.clone();
    }
    registry.plugins.insert(old.name.clone(), entry);
    if let Err(why) = registry::write(host, registry) {
        problems.push(why);
    }
    let _ = fsutil::remove_tree(aside);
    fsutil::remove_dir_if_empty(&host.trash());
    problems.join("; ")
}

fn undo_message(why: String, problems: String) -> String {
    if problems.is_empty() {
        format!("{why} The installed version was put back.")
    } else {
        format!("{why} Putting the installed version back also hit a problem: {problems}")
    }
}

/// Swap a staged new version in for `name`. The caller holds `registry::lock()`. The staged folder is consumed.
pub(super) fn update_staged(
    host: &Host,
    name: &str,
    staged: &Path,
    source: Source,
) -> Result<Outcome, String> {
    let consume = |why: String| {
        let _ = fsutil::remove_tree(staged);
        Err(why)
    };
    let mut registry = match registry::read(host) {
        Ok(registry) => registry,
        Err(why) => return consume(why),
    };
    let Some(old) = registry.plugins.get(name).cloned() else {
        return consume(format!("\"{name}\" isn't installed."));
    };
    match load_plugin(staged) {
        Ok(loaded) if loaded.manifest.name == name => {}
        Ok(loaded) => {
            return consume(format!(
                "That holds \"{}\", not \"{name}\".",
                loaded.manifest.name
            ))
        }
        Err(why) => return consume(format!("The new version didn't validate: {why}")),
    }
    let aside = host.trash().join(uuid::Uuid::new_v4().to_string());
    let installed = host.installed(name);
    let previous = host.previous(name);
    if previous.exists() {
        if let Err(why) = rename(&previous, &aside.join("previous")) {
            return consume(why);
        }
    }
    let off = match switch_off(host, &old, &mut registry) {
        Ok(off) => off,
        Err(why) => {
            let _ = rename(&aside.join("previous"), &previous);
            return consume(why);
        }
    };
    if let Err(why) = rename(&installed, &previous) {
        let problems = put_back(host, &old, &off, &mut registry, &aside, &installed);
        return consume(undo_message(why, problems));
    }
    let result = (|| -> Result<(Entry, Vec<Report>), String> {
        rename(staged, &installed)?;
        failed_after_swap()?;
        let loaded =
            load_plugin(&installed).map_err(|e| format!("The new version didn't validate: {e}"))?;
        let mut reports = loaded.reports.clone();
        let made = reactivate(host, &loaded, &old.enabled, &mut registry, &mut reports)?;
        let mut entry = off.clone();
        entry.version = loaded.manifest.version.clone();
        entry.source = source.clone();
        entry.installed_at_ms = registry::now_ms();
        entry.integrity = Some(fsutil::tree_digest(&installed));
        entry.enabled = old.enabled.clone();
        entry.previous = Some(Box::new(Snapshot::of(&old)));
        entry.contributions.extend(made.iter().cloned());
        registry.plugins.insert(name.to_string(), entry.clone());
        if let Err(why) = registry::write(host, &mut registry) {
            registry::dispose_all(host, made.iter().rev());
            return Err(why);
        }
        Ok((entry, reports))
    })();
    match result {
        Ok((entry, reports)) => {
            let _ = fsutil::remove_tree(&aside);
            fsutil::remove_dir_if_empty(&host.trash());
            Ok(Outcome {
                entry: Some(entry),
                reports,
            })
        }
        Err(why) => {
            // Whatever the new version made is undone by switching it off again before the old one goes back.
            if let Some(now) = registry.plugins.get(name).cloned() {
                if now.previous.is_some() {
                    let mut new_off = now.clone();
                    new_off.enabled = Enablement::default();
                    registry::retire(host, &mut new_off);
                }
            }
            let problems = put_back(host, &old, &off, &mut registry, &aside, &previous);
            let _ = fsutil::remove_tree(staged);
            Err(undo_message(why, problems))
        }
    }
}

/// Go back to the version the last update replaced, in one step. The newer version's files go; its data stays.
pub fn rollback(host: &Host, name: &str) -> Result<Outcome, String> {
    let _guard = registry::lock();
    let mut registry = registry::read(host)?;
    let current = registry
        .plugins
        .get(name)
        .cloned()
        .ok_or_else(|| format!("\"{name}\" isn't installed."))?;
    let Some(snapshot) = current.previous.clone() else {
        return Err(format!("\"{name}\" has no earlier version to go back to."));
    };
    let previous = host.previous(name);
    if let Err(why) = load_plugin(&previous) {
        return Err(format!(
            "The earlier version of \"{name}\" no longer loads, so nothing was changed: {why}"
        ));
    }
    let off = switch_off(host, &current, &mut registry)?;
    let aside = host.trash().join(uuid::Uuid::new_v4().to_string());
    let installed = host.installed(name);
    let current_aside = aside.join("current");
    if let Err(why) = rename(&installed, &current_aside) {
        let problems = put_back(host, &current, &off, &mut registry, &aside, &installed);
        return Err(undo_message(why, problems));
    }
    let result = (|| -> Result<(Entry, Vec<Report>), String> {
        rename(&previous, &installed)?;
        failed_after_swap()?;
        let loaded = load_plugin(&installed).map_err(|e| e.0)?;
        let mut reports = loaded.reports.clone();
        let made = reactivate(host, &loaded, &current.enabled, &mut registry, &mut reports)?;
        let mut entry = off.clone();
        entry.version = snapshot.version.clone();
        entry.source = snapshot.source.clone();
        entry.installed_at_ms = snapshot.installed_at_ms;
        entry.integrity = snapshot.integrity.clone();
        entry.enabled = current.enabled.clone();
        entry.previous = None;
        entry.contributions.extend(made.iter().cloned());
        registry.plugins.insert(name.to_string(), entry.clone());
        if let Err(why) = registry::write(host, &mut registry) {
            registry::dispose_all(host, made.iter().rev());
            return Err(why);
        }
        Ok((entry, reports))
    })();
    match result {
        Ok((entry, reports)) => {
            let _ = fsutil::remove_tree(&aside);
            fsutil::remove_dir_if_empty(&host.trash());
            // WP-78: the earlier version is back. The person asked; the app moved the files.
            crate::activity::note_db(
                &registry::activity_db(host),
                crate::activity::PLUGIN_ROLLBACK,
                &crate::activity::Who::app(),
                &crate::activity::Who::person(),
                "",
                name,
                &format!("Rolled {name} back."),
                "",
            );
            Ok(Outcome {
                entry: Some(entry),
                reports,
            })
        }
        Err(why) => {
            // The earlier version goes back to previous/ and the current one back into place.
            if installed.exists() {
                if let Some(now) = registry.plugins.get(name).cloned() {
                    if now.previous.is_none() {
                        let mut now_off = now.clone();
                        now_off.enabled = Enablement::default();
                        registry::retire(host, &mut now_off);
                    }
                }
                let _ = rename(&installed, &previous);
            }
            let problems = put_back(host, &current, &off, &mut registry, &aside, &current_aside);
            Err(undo_message(why, problems))
        }
    }
}
