//! The three index readers (WP-32): Hivra's own index, DeepSeek Harness's market index (format 1) and Claude Code
//! plugin marketplaces (`.claude-plugin/marketplace.json`). Each maps its entries into one [`Entry`] shape. Reading is
//! pure: the readers see only the index's text and where it came from. They never open a plugin, fetch its files or
//! run anything, so an entry's contributions are only what the index says about them.
//!
//! A broken entry is skipped with a plain report and the rest still list (WP-30's failure boundaries); a broken index
//! (not JSON, unknown format) lists nothing and says why.

use serde::Serialize;
use serde_json::{Map, Value};

use super::Origin;
use crate::plugins::manifest::plugin_name_problem;

pub const HIVRA_INDEX_FORMAT: &str = "hivra-plugin-index/1";
/// Entries one index may list; the rest are dropped with a report.
pub const MAX_ENTRIES: usize = 2000;
const PLATFORMS: &[&str] = &["macos", "windows", "linux"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Format {
    Hivra,
    Dsh,
    ClaudeMarketplace,
}

/// Whether Discover offers Install, and if not, why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    /// Pinned, usable here: Discover offers Install (WP-31).
    Available,
    /// In the index but not published yet.
    Planned,
    /// Its content only runs somewhere Hivra isn't (a DeepSeek Harness bundle, a Claude Code plugin with nothing
    /// portable).
    NotCompatible,
    /// Portable content, in a layout the installer doesn't take yet (Claude Code plugins).
    ListedOnly,
    /// The entry names its platforms and this one isn't among them.
    NotThisPlatform,
}

/// Where one exact version installs from: the shape WP-31's `plugins_install` takes. Always pinned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallSource {
    Git {
        url: String,
        commit: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Npm {
        package: String,
        version: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        registry: Option<String>,
    },
}

/// One kind of thing a plugin adds, as the index states it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adds {
    /// `skills`, `mcpServers`, `panels`, `personas`, `monoTemplates`, `crewRules` or `commands`.
    pub kind: String,
    /// How many, when the index says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    pub names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub title: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// SPDX id as the index gives it; `None` means the index doesn't say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub keywords: Vec<String>,
    /// Empty means every platform.
    pub platforms: Vec<String>,
    pub adds: Vec<Adds>,
    /// Parts of the plugin Hivra leaves out (a Claude Code plugin's hooks, agents, commands...).
    pub left_out: Vec<String>,
    pub permissions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The pinned source, shown in the detail view; Install is offered only when `status` is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<InstallSource>,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub format: Format,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub format: Format,
    pub entries: Vec<Entry>,
    /// Entries left out, each with its reason.
    pub skipped: Vec<String>,
}

type Obj = Map<String, Value>;

/// Read an index of any of the three formats.
pub fn read_index(text: &str, origin: &Origin, platform: &str) -> Result<Index, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| format!("This index isn't valid JSON ({e}). Nothing was listed."))?;
    let object = value
        .as_object()
        .ok_or("This index isn't a JSON object. Nothing was listed.")?;
    match object.get("format") {
        Some(Value::String(f)) if f == HIVRA_INDEX_FORMAT => read_hivra(object, platform),
        Some(Value::Number(n)) if n.as_u64() == Some(1) => read_dsh(object),
        Some(other) => Err(format!(
            "This index has a format Hivra doesn't know ({other}). Nothing was listed."
        )),
        None if object.get("plugins").is_some_and(Value::is_array)
            && object.get("name").is_some_and(Value::is_string) =>
        {
            read_claude(object, origin)
        }
        None => Err(
            "This file isn't a plugin index Hivra knows (Hivra, DeepSeek Harness or a Claude Code marketplace). \
             Nothing was listed."
                .into(),
        ),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Shared field readers

fn text(value: &Value) -> Option<String> {
    let s = value.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// A string, or DeepSeek Harness's localised text (`{ "en": ..., "zh": ... }`), read as English.
fn localized(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(_) => text(value?),
        Value::Object(map) => map.get("en").and_then(text),
        _ => None,
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(text).collect())
        .unwrap_or_default()
}

/// An absolute `https:` URL without credentials; `http:` only when `allow_http`.
pub(super) fn web_url(value: &str, allow_http: bool) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    let scheme_ok = url.scheme() == "https" || (allow_http && url.scheme() == "http");
    (scheme_ok && url.username().is_empty() && url.password().is_none() && url.host().is_some())
        .then(|| url.to_string())
}

fn is_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// A relative folder inside a repository: plain segments, no `.` or `..`, no leading `/`.
fn repo_path(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_start_matches("./").trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let ok = trimmed.split('/').all(|seg| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._@+-".contains(c))
    });
    ok.then(|| trimmed.to_string())
}

/// A git repository URL Hivra will clone: `https:`, a host and at least two path segments, not a tarball.
fn git_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let segments: Vec<&str> = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect();
    let path = url.path().to_ascii_lowercase();
    if segments.len() < 2 || path.ends_with(".tgz") || path.ends_with(".tar.gz") {
        return None;
    }
    Some(url.to_string().trim_end_matches('/').to_string())
}

fn npm_package_ok(name: &str) -> bool {
    let body = match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((scope, rest)) if npm_segment(scope) => rest,
            _ => return false,
        },
        None => name,
    };
    name.len() <= 214 && npm_segment(body)
}

fn npm_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._~-".contains(c))
}

/// SemVer 2.0.0 exact version: `MAJOR.MINOR.PATCH`, optional `-prerelease` and `+build`.
pub(super) fn exact_version(value: &str) -> bool {
    let (core, _build) = match value.split_once('+') {
        Some((core, build)) => {
            let ok = build
                .split('.')
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
            if !ok {
                return false;
            }
            (core, Some(build))
        }
        None => (value, None),
    };
    let (release, pre) = match core.split_once('-') {
        Some((release, pre)) => (release, Some(pre)),
        None => (core, None),
    };
    let numeric = |p: &str| {
        !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && (p == "0" || !p.starts_with('0'))
    };
    let parts: Vec<&str> = release.split('.').collect();
    if parts.len() != 3 || !parts.iter().all(|p| numeric(p)) {
        return false;
    }
    pre.is_none_or(|pre| {
        pre.split('.').all(|p| {
            !p.is_empty()
                && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                && (!p.chars().all(|c| c.is_ascii_digit()) || numeric(p))
        })
    })
}

/// SemVer precedence, for picking an entry's newest version. Only called on [`exact_version`]s.
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let split = |v: &str| {
        let core = v.split('+').next().unwrap_or(v);
        let (release, pre) = match core.split_once('-') {
            Some((r, p)) => (r.to_string(), Some(p.to_string())),
            None => (core.to_string(), None),
        };
        let nums: Vec<u64> = release.split('.').map(|p| p.parse().unwrap_or(0)).collect();
        (nums, pre)
    };
    let (an, ap) = split(a);
    let (bn, bp) = split(b);
    match an.cmp(&bn) {
        Ordering::Equal => {}
        other => return other,
    }
    match (ap, bp) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => {
            let (a, b): (Vec<&str>, Vec<&str>) = (a.split('.').collect(), b.split('.').collect());
            for (x, y) in a.iter().zip(b.iter()) {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
            a.len().cmp(&b.len())
        }
    }
}

/// A DeepSeek Harness / Hivra version source: `{ type: "git", url, commit, path? }` or `{ type: "npm", registry? }`.
fn version_source(
    value: Option<&Value>,
    package: &str,
    version: &str,
) -> Result<InstallSource, String> {
    let source = value
        .and_then(Value::as_object)
        .ok_or("has no source")?;
    match source.get("type").and_then(Value::as_str) {
        Some("git") => {
            let url = source
                .get("url")
                .and_then(Value::as_str)
                .and_then(git_url)
                .ok_or("has a git source whose url isn't an https repository")?;
            let commit = source
                .get("commit")
                .and_then(Value::as_str)
                .filter(|c| is_commit(c))
                .ok_or("has a git source that isn't pinned to a full 40-character commit")?;
            let path = match source.get("path") {
                None => None,
                Some(p) => Some(
                    p.as_str()
                        .and_then(repo_path)
                        .ok_or("has a git source whose path leaves the repository")?,
                ),
            };
            Ok(InstallSource::Git {
                url,
                commit: commit.to_string(),
                path,
            })
        }
        Some("npm") => {
            let package = source
                .get("package")
                .and_then(Value::as_str)
                .unwrap_or(package);
            if !npm_package_ok(package) {
                return Err(format!("names npm package {package:?}, which isn't a valid npm name"));
            }
            let registry = match source.get("registry") {
                None => None,
                Some(r) => Some(
                    r.as_str()
                        .and_then(|r| web_url(r, false))
                        .ok_or("has an npm registry that isn't an https URL")?,
                ),
            };
            Ok(InstallSource::Npm {
                package: package.to_string(),
                version: version.to_string(),
                registry,
            })
        }
        _ => Err("has a source that is neither git nor npm".into()),
    }
}

/// The newest valid version of an entry's `versions` list, with its pinned source.
fn newest_version(
    object: &Obj,
    package: &str,
) -> Result<(String, InstallSource), String> {
    let versions = object
        .get("versions")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
        .ok_or("has no versions to install")?;
    let mut best: Option<(String, InstallSource)> = None;
    for (position, version) in versions.iter().enumerate() {
        let v = version
            .as_object()
            .ok_or_else(|| format!("version {position} isn't an object"))?;
        let number = v
            .get("version")
            .and_then(Value::as_str)
            .filter(|n| exact_version(n))
            .ok_or_else(|| format!("version {position} isn't an exact version (like 1.2.3)"))?;
        let source = version_source(v.get("source"), package, number)
            .map_err(|e| format!("version {number} {e}"))?;
        if best
            .as_ref()
            .is_none_or(|(b, _)| compare_versions(number, b).is_gt())
        {
            best = Some((number.to_string(), source));
        }
    }
    best.ok_or_else(|| "has no versions to install".into())
}

fn author_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(_) => text(value?),
        Value::Object(map) => map.get("name").and_then(text),
        _ => None,
    }
}

fn repository_of(value: Option<&Value>) -> Option<String> {
    let url = match value? {
        Value::String(s) => s.clone(),
        Value::Object(map) => map.get("url")?.as_str()?.to_string(),
        _ => return None,
    };
    web_url(&url, true)
}

fn cap_entries(items: &[Value], skipped: &mut Vec<String>) -> usize {
    if items.len() > MAX_ENTRIES {
        skipped.push(format!(
            "This index lists {} plugins; only the first {MAX_ENTRIES} are shown.",
            items.len()
        ));
        MAX_ENTRIES
    } else {
        items.len()
    }
}

fn entry_label(value: &Value, position: usize) -> String {
    value
        .get("name")
        .and_then(Value::as_str)
        .map(|n| format!("{n:?}"))
        .unwrap_or_else(|| format!("number {}", position + 1))
}

// ---------------------------------------------------------------------------------------------------------------
// Hivra's own index

const CONTRIBUTION_KINDS: &[&str] = &[
    "skills",
    "mcpServers",
    "panels",
    "personas",
    "monoTemplates",
    "crewRules",
    "commands",
];

fn read_hivra(object: &Obj, platform: &str) -> Result<Index, String> {
    let title = localized(object.get("title")).ok_or("This Hivra index has no title. Nothing was listed.")?;
    let items = object
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or("This Hivra index has no plugins list. Nothing was listed.")?;
    let mut skipped = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    for (position, item) in items[..cap_entries(items, &mut skipped)].iter().enumerate() {
        match hivra_entry(item, platform) {
            Ok(entry) if entries.iter().any(|e| e.name == entry.name) => skipped.push(format!(
                "Plugin {:?} is listed twice; the first one is kept.",
                entry.name
            )),
            Ok(entry) => entries.push(entry),
            Err(reason) => skipped.push(format!("Plugin {} {reason}.", entry_label(item, position))),
        }
    }
    Ok(Index {
        title,
        description: localized(object.get("description")),
        format: Format::Hivra,
        entries,
        skipped,
    })
}

fn hivra_entry(value: &Value, platform: &str) -> Result<Entry, String> {
    let object = value.as_object().ok_or("isn't an object")?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or("has no name")?
        .to_string();
    if let Some(problem) = plugin_name_problem(&name) {
        return Err(format!("has a name that {problem}"));
    }
    let platforms = strings(object.get("platforms"));
    if let Some(unknown) = platforms.iter().find(|p| !PLATFORMS.contains(&p.as_str())) {
        return Err(format!("names a platform Hivra doesn't know ({unknown:?})"));
    }
    let adds = contributions(object.get("contributes"))?;
    let planned = object.get("status").and_then(Value::as_str) == Some("planned");
    let (version, source, status, reason) = if planned {
        let when = object
            .get("plannedIn")
            .and_then(text)
            .map(|wp| format!(" (being built in {wp})"))
            .unwrap_or_default();
        (
            None,
            None,
            Status::Planned,
            Some(format!("Not published yet{when}.")),
        )
    } else {
        let (version, source) = newest_version(object, &name)?;
        let (status, reason) = if platforms.is_empty() || platforms.iter().any(|p| p == platform) {
            (Status::Available, None)
        } else {
            (
                Status::NotThisPlatform,
                Some(format!("Only for {}.", platforms.join(", "))),
            )
        };
        (Some(version), Some(source), status, reason)
    };
    Ok(Entry {
        title: localized(object.get("title")).unwrap_or_else(|| name.clone()),
        description: localized(object.get("description")).unwrap_or_default(),
        author: author_of(object.get("author")),
        license: object.get("license").and_then(text),
        homepage: object
            .get("homepage")
            .and_then(Value::as_str)
            .and_then(|u| web_url(u, true)),
        repository: repository_of(object.get("repository")),
        category: object.get("category").and_then(text),
        keywords: strings(object.get("keywords")),
        platforms,
        adds,
        left_out: Vec::new(),
        permissions: strings(object.get("permissions")),
        version,
        source,
        status,
        reason,
        format: Format::Hivra,
        name,
    })
}

/// `contributes`: each kind is a list of names, a count, or (crew rules) `true`.
fn contributions(value: Option<&Value>) -> Result<Vec<Adds>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let object = value.as_object().ok_or("has a contributes field that isn't an object")?;
    let mut adds = Vec::new();
    for kind in CONTRIBUTION_KINDS {
        let Some(item) = object.get(*kind) else {
            continue;
        };
        let add = match item {
            Value::Array(names) => {
                let names: Vec<String> = names.iter().filter_map(text).collect();
                Adds {
                    kind: kind.to_string(),
                    count: Some(names.len() as u32),
                    names,
                }
            }
            Value::Number(n) => Adds {
                kind: kind.to_string(),
                count: Some(
                    n.as_u64()
                        .and_then(|n| u32::try_from(n).ok())
                        .ok_or_else(|| format!("has a {kind} count that isn't a whole number"))?,
                ),
                names: Vec::new(),
            },
            Value::Bool(true) => Adds {
                kind: kind.to_string(),
                count: None,
                names: Vec::new(),
            },
            Value::Bool(false) => continue,
            _ => return Err(format!("has a {kind} entry that is neither names nor a count")),
        };
        if add.count != Some(0) {
            adds.push(add);
        }
    }
    if let Some(unknown) = object.keys().find(|k| !CONTRIBUTION_KINDS.contains(&k.as_str())) {
        return Err(format!("says it adds {unknown:?}, which Hivra doesn't know"));
    }
    Ok(adds)
}

// ---------------------------------------------------------------------------------------------------------------
// DeepSeek Harness market index, format 1 (packages/util/plugin-market-index, MIT)

pub const DSH_REASON: &str = "A DeepSeek Harness bundle: it runs inside DeepSeek Harness's own agent loop, which \
                              Hivra doesn't have.";

fn read_dsh(object: &Obj) -> Result<Index, String> {
    let title = localized(object.get("title"))
        .ok_or("This DeepSeek Harness index has no title. Nothing was listed.")?;
    let items = object
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or("This DeepSeek Harness index has no plugins list. Nothing was listed.")?;
    let categories = object
        .get("metadata")
        .and_then(|m| m.get("categories"))
        .and_then(Value::as_object);
    let mut skipped = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    for (position, item) in items[..cap_entries(items, &mut skipped)].iter().enumerate() {
        match dsh_entry(item, categories) {
            Ok(entry) if entries.iter().any(|e| e.name == entry.name) => skipped.push(format!(
                "Plugin {:?} is listed twice; the first one is kept.",
                entry.name
            )),
            Ok(entry) => entries.push(entry),
            Err(reason) => skipped.push(format!("Plugin {} {reason}.", entry_label(item, position))),
        }
    }
    Ok(Index {
        title,
        description: localized(object.get("description")),
        format: Format::Dsh,
        entries,
        skipped,
    })
}

fn dsh_entry(value: &Value, categories: Option<&Obj>) -> Result<Entry, String> {
    let object = value.as_object().ok_or("isn't an object")?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| npm_package_ok(n))
        .ok_or("has no valid npm package name")?
        .to_string();
    let (version, source) = newest_version(object, &name)?;
    let metadata = object.get("metadata").and_then(Value::as_object);
    let category = metadata
        .and_then(|m| m.get("category"))
        .and_then(Value::as_str)
        .map(|id| {
            categories
                .and_then(|c| c.get(id))
                .and_then(|c| localized(c.get("title")))
                .unwrap_or_else(|| id.to_string())
        });
    Ok(Entry {
        title: localized(object.get("title")).unwrap_or_else(|| name.clone()),
        description: localized(object.get("description")).unwrap_or_default(),
        author: author_of(object.get("author")),
        license: None,
        homepage: object
            .get("homepage")
            .and_then(Value::as_str)
            .and_then(|u| web_url(u, true)),
        repository: repository_of(object.get("repository")),
        category,
        keywords: strings(metadata.and_then(|m| m.get("keywords"))),
        platforms: Vec::new(),
        adds: Vec::new(),
        left_out: Vec::new(),
        permissions: Vec::new(),
        version: Some(version),
        source: Some(source),
        status: Status::NotCompatible,
        reason: Some(DSH_REASON.into()),
        format: Format::Dsh,
        name,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code plugin marketplaces

/// Claude Code plugin parts Hivra can't use: they run inside Claude Code itself.
const CLAUDE_LEFT_OUT: &[(&str, &str)] = &[
    ("commands", "slash commands"),
    ("agents", "agents"),
    ("hooks", "hooks"),
    ("lspServers", "language servers"),
    ("outputStyles", "output styles"),
];

pub const CLAUDE_REASON: &str = "A Claude Code plugin. Hivra can use its skills and MCP servers, but can't install \
                                 Claude Code's plugin layout yet.";

fn read_claude(object: &Obj, origin: &Origin) -> Result<Index, String> {
    let name = object.get("name").and_then(text).ok_or("This marketplace has no name.")?;
    let items = object.get("plugins").and_then(Value::as_array).ok_or("no plugins")?;
    let metadata = object.get("metadata").and_then(Value::as_object);
    let plugin_root = metadata
        .and_then(|m| m.get("pluginRoot"))
        .and_then(Value::as_str)
        .and_then(repo_path);
    let mut skipped = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    for (position, item) in items[..cap_entries(items, &mut skipped)].iter().enumerate() {
        match claude_entry(item, origin, plugin_root.as_deref()) {
            Ok(entry) if entries.iter().any(|e| e.name == entry.name) => skipped.push(format!(
                "Plugin {:?} is listed twice; the first one is kept.",
                entry.name
            )),
            Ok(entry) => entries.push(entry),
            Err(reason) => skipped.push(format!("Plugin {} {reason}.", entry_label(item, position))),
        }
    }
    let owner = author_of(object.get("owner"));
    Ok(Index {
        title: owner
            .map(|owner| format!("{name} ({owner})"))
            .unwrap_or(name),
        description: metadata
            .and_then(|m| m.get("description"))
            .and_then(text)
            .or_else(|| object.get("description").and_then(text)),
        format: Format::ClaudeMarketplace,
        entries,
        skipped,
    })
}

fn claude_entry(value: &Value, origin: &Origin, plugin_root: Option<&str>) -> Result<Entry, String> {
    let object = value.as_object().ok_or("isn't an object")?;
    let name = object
        .get("name")
        .and_then(text)
        .filter(|n| n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
        .ok_or("has no usable name")?;
    let version = object.get("version").and_then(text);
    let source = claude_source(object.get("source"), origin, plugin_root);

    let mut adds = Vec::new();
    if let Some(skills) = object.get("skills") {
        adds.push(path_list("skills", skills));
    }
    if let Some(servers) = object.get("mcpServers") {
        adds.push(match servers {
            Value::Object(map) => Adds {
                kind: "mcpServers".into(),
                count: Some(map.len() as u32),
                names: map.keys().cloned().collect(),
            },
            other => path_list("mcpServers", other),
        });
    }
    adds.retain(|a| a.count != Some(0));
    let left_out: Vec<String> = CLAUDE_LEFT_OUT
        .iter()
        .filter(|(key, _)| object.get(*key).is_some_and(|v| !v.is_null()))
        .map(|(_, label)| label.to_string())
        .collect();

    let (status, reason) = if adds.is_empty() && !left_out.is_empty() {
        (
            Status::NotCompatible,
            format!(
                "A Claude Code plugin with only {}, which run inside Claude Code itself.",
                left_out.join(", ")
            ),
        )
    } else {
        let mut reason = CLAUDE_REASON.to_string();
        if source.is_none() {
            reason.push_str(" Its source isn't pinned to a commit or exact version either.");
        }
        (Status::ListedOnly, reason)
    };

    let keywords = {
        let mut k = strings(object.get("keywords"));
        k.extend(strings(object.get("tags")));
        k
    };
    Ok(Entry {
        title: name.clone(),
        description: object.get("description").and_then(text).unwrap_or_default(),
        author: author_of(object.get("author")),
        license: object.get("license").and_then(text),
        homepage: object
            .get("homepage")
            .and_then(Value::as_str)
            .and_then(|u| web_url(u, true)),
        repository: repository_of(object.get("repository")),
        category: object.get("category").and_then(text),
        keywords,
        platforms: Vec::new(),
        adds,
        left_out,
        permissions: Vec::new(),
        version,
        source,
        status,
        reason: Some(reason),
        format: Format::ClaudeMarketplace,
        name,
    })
}

/// A component given as paths (`"./skills/a"` or a list of them): names are the last path segment.
fn path_list(kind: &str, value: &Value) -> Adds {
    let paths: Vec<String> = match value {
        Value::String(s) => vec![s.clone()],
        Value::Array(items) => items.iter().filter_map(text).collect(),
        _ => Vec::new(),
    };
    // A single folder of skills (`"./skills"`) says nothing about how many it holds.
    let single_folder = matches!(value, Value::String(_));
    Adds {
        kind: kind.into(),
        count: (!single_folder).then_some(paths.len() as u32),
        names: if single_folder {
            Vec::new()
        } else {
            paths
                .iter()
                .filter_map(|p| p.trim_end_matches('/').rsplit('/').next())
                .filter(|n| !n.is_empty() && *n != ".")
                .map(str::to_string)
                .collect()
        },
    }
}

/// A marketplace entry's source, pinned, or `None` when it names no exact commit or version.
fn claude_source(value: Option<&Value>, origin: &Origin, plugin_root: Option<&str>) -> Option<InstallSource> {
    match value? {
        // A folder inside the marketplace's own repository: pinned only when the marketplace was read at a commit.
        Value::String(relative) => {
            let Origin::Repository { url, commit } = origin else {
                return None;
            };
            let path = if relative.starts_with("./") || relative == "." {
                repo_path(relative)
            } else {
                let joined = match plugin_root {
                    Some(root) => format!("{root}/{relative}"),
                    None => relative.clone(),
                };
                repo_path(&joined)
            };
            Some(InstallSource::Git {
                url: url.clone(),
                commit: commit.clone(),
                path,
            })
        }
        Value::Object(source) => {
            let pinned_commit = source
                .get("sha")
                .and_then(Value::as_str)
                .filter(|s| is_commit(s))
                .map(str::to_string);
            match source.get("source").and_then(Value::as_str)? {
                "github" => {
                    let repo = source.get("repo").and_then(Value::as_str)?;
                    let (owner, name) = repo.split_once('/')?;
                    let segment_ok =
                        |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
                    if !segment_ok(owner) || !segment_ok(name) || name.contains('/') {
                        return None;
                    }
                    Some(InstallSource::Git {
                        url: format!("https://github.com/{owner}/{}", name.trim_end_matches(".git")),
                        commit: pinned_commit?,
                        path: source.get("path").and_then(Value::as_str).and_then(repo_path),
                    })
                }
                "url" | "git" | "git-subdir" => Some(InstallSource::Git {
                    url: source
                        .get("url")
                        .and_then(Value::as_str)
                        .map(|u| u.trim_end_matches(".git"))
                        .and_then(git_url)?,
                    commit: pinned_commit?,
                    path: source.get("path").and_then(Value::as_str).and_then(repo_path),
                }),
                "npm" => {
                    let package = source.get("package").and_then(Value::as_str)?;
                    let version = source.get("version").and_then(Value::as_str)?;
                    (npm_package_ok(package) && exact_version(version)).then(|| InstallSource::Npm {
                        package: package.into(),
                        version: version.into(),
                        registry: source
                            .get("registry")
                            .and_then(Value::as_str)
                            .and_then(|r| web_url(r, false)),
                    })
                }
                _ => None,
            }
        }
        _ => None,
    }
}
