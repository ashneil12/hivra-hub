//! Discover (WP-32, docs/hivra/plugins/DISCOVER.md): list plugins from static indexes. Listing reads each index's
//! text (bundled, a file, an https URL, or a Claude Code marketplace in a GitHub repository) and maps its entries;
//! it never opens, downloads or runs a plugin. Installing an entry is WP-31's `plugins_install`, from the pinned
//! source an entry carries.
//!
//! This module never starts a process: the test `listing_never_executes_anything` reads these files and fails if
//! one does.

pub mod readers;

#[cfg(test)]
mod tests;

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub use readers::{read_index, Entry, Format, Index, InstallSource, Status};

/// The index this repo ships (`plugins/index.json`), built into the app so Discover works offline.
pub const BUNDLED_INDEX: &str = include_str!("../../../../plugins/index.json");
/// Largest index Discover reads.
pub const MAX_INDEX_BYTES: u64 = 4 * 1024 * 1024;
/// Most sources one listing reads.
pub const MAX_SOURCES: usize = 20;
const TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "Hivra-Discover";

/// Where an index is read from. The Settings list holds these; the default is `[Bundled]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IndexSource {
    /// `plugins/index.json` from this repo, as built into the app.
    Bundled,
    /// An index file at an https URL: any of the three formats.
    Url { url: String },
    /// A Claude Code marketplace in a GitHub repository (`.claude-plugin/marketplace.json`), read at `git_ref`
    /// (default: the default branch) resolved to its commit, so the entries inside it are pinned.
    Github {
        repo: String,
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
    },
    /// An index file on this computer.
    File { path: String },
}

/// What a reader knows about where the index came from: a Claude Code marketplace's relative sources are folders of
/// its repository and are pinned only when it was read at a known commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    Repository { url: String, commit: String },
    Elsewhere,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub source: IndexSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<Index>,
    /// Why nothing was listed from this source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The current platform in an index's words.
pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

/// Read every source, each on its own: one that fails reports why and the others still list.
pub fn discover(sources: &[IndexSource], fetch: &dyn Fn(&str) -> Result<Fetched, String>) -> Vec<IndexResult> {
    let mut results = Vec::new();
    for (position, source) in sources.iter().enumerate() {
        if position >= MAX_SOURCES {
            results.push(IndexResult {
                source: source.clone(),
                index: None,
                error: Some(format!("Discover reads at most {MAX_SOURCES} indexes; this one was left out.")),
            });
            continue;
        }
        let read = read_source(source, fetch).and_then(|(text, origin)| read_index(&text, &origin, platform()));
        results.push(match read {
            Ok(index) => IndexResult {
                source: source.clone(),
                index: Some(index),
                error: None,
            },
            Err(error) => IndexResult {
                source: source.clone(),
                index: None,
                error: Some(error),
            },
        });
    }
    results
}

/// An https response: its text and the URL it finally came from.
pub struct Fetched {
    pub text: String,
    pub url: String,
}

fn read_source(
    source: &IndexSource,
    fetch: &dyn Fn(&str) -> Result<Fetched, String>,
) -> Result<(String, Origin), String> {
    match source {
        IndexSource::Bundled => Ok((BUNDLED_INDEX.to_string(), Origin::Elsewhere)),
        IndexSource::File { path } => {
            let path = crate::fs::expand_home(path);
            Ok((read_file(&path)?, Origin::Elsewhere))
        }
        IndexSource::Url { url } => {
            let url = readers::web_url(url, false)
                .ok_or("An index URL must be an https address. Nothing was listed.")?;
            let fetched = fetch(&url)?;
            let origin = raw_github_origin(&fetched.url).unwrap_or(Origin::Elsewhere);
            Ok((fetched.text, origin))
        }
        IndexSource::Github { repo, git_ref } => {
            let (owner, name) = github_repo(repo)
                .ok_or("A GitHub source is written owner/repository. Nothing was listed.")?;
            let commit = match git_ref.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
                Some(r) if r.len() == 40 && r.chars().all(|c| c.is_ascii_hexdigit()) => r.to_ascii_lowercase(),
                other => {
                    let r = other.unwrap_or("HEAD");
                    if !r.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c)) {
                        return Err("That branch or tag name isn't one GitHub allows.".into());
                    }
                    resolve_commit(&owner, &name, r, fetch)?
                }
            };
            let url = format!("https://raw.githubusercontent.com/{owner}/{name}/{commit}/.claude-plugin/marketplace.json");
            let fetched = fetch(&url).map_err(|e| {
                format!("{e} (looked for .claude-plugin/marketplace.json in {owner}/{name} at {})", &commit[..7])
            })?;
            Ok((
                fetched.text,
                Origin::Repository {
                    url: format!("https://github.com/{owner}/{name}"),
                    commit,
                },
            ))
        }
    }
}

fn read_file(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Couldn't open {} ({e}). Nothing was listed.", path.display()))?;
    let mut text = String::new();
    file.take(MAX_INDEX_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("Couldn't read {} as text ({e}). Nothing was listed.", path.display()))?;
    if text.len() as u64 > MAX_INDEX_BYTES {
        return Err(too_big());
    }
    Ok(text)
}

fn too_big() -> String {
    format!("This index is larger than {} MB. Nothing was listed.", MAX_INDEX_BYTES / (1024 * 1024))
}

/// `owner/name`, each a GitHub-shaped segment.
pub fn github_repo(repo: &str) -> Option<(String, String)> {
    let repo = repo.trim().trim_start_matches("https://github.com/").trim_end_matches('/');
    let (owner, name) = repo.split_once('/')?;
    let name = name.trim_end_matches(".git");
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    (ok(owner) && ok(name)).then(|| (owner.to_string(), name.to_string()))
}

/// A branch or tag to its commit through GitHub's API (an https read; nothing is cloned).
fn resolve_commit(
    owner: &str,
    name: &str,
    git_ref: &str,
    fetch: &dyn Fn(&str) -> Result<Fetched, String>,
) -> Result<String, String> {
    let url = format!("https://api.github.com/repos/{owner}/{name}/commits/{git_ref}");
    let fetched = fetch(&url).map_err(|e| format!("Couldn't find {git_ref} in {owner}/{name}: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&fetched.text)
        .map_err(|_| format!("GitHub didn't say which commit {git_ref} is in {owner}/{name}."))?;
    value
        .get("sha")
        .and_then(serde_json::Value::as_str)
        .filter(|s| s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| format!("GitHub didn't say which commit {git_ref} is in {owner}/{name}."))
}

/// `https://raw.githubusercontent.com/<owner>/<repo>/<commit>/...` read at a full commit: its repository and commit.
pub fn raw_github_origin(url: &str) -> Option<Origin> {
    let rest = url.strip_prefix("https://raw.githubusercontent.com/")?;
    let mut parts = rest.splitn(4, '/');
    let (owner, name, commit) = (parts.next()?, parts.next()?, parts.next()?);
    let (owner, name) = github_repo(&format!("{owner}/{name}"))?;
    (commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit())).then(|| Origin::Repository {
        url: format!("https://github.com/{owner}/{name}"),
        commit: commit.to_ascii_lowercase(),
    })
}

/// GET an https URL: redirects only to https, at most [`MAX_INDEX_BYTES`].
pub fn fetch_https(url: &str) -> Result<Fetched, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .redirects(0)
        .build();
    let mut current = url.to_string();
    for _ in 0..5 {
        if !current.starts_with("https://") {
            return Err("The index moved to an address that isn't https. Nothing was listed.".into());
        }
        let response = match agent
            .get(&current)
            .set("User-Agent", USER_AGENT)
            .set("Accept", "application/json")
            .call()
        {
            Ok(response) => response,
            Err(ureq::Error::Status(status, response)) if (300..400).contains(&status) => response,
            Err(ureq::Error::Status(404, _)) => return Err("Not found (404). Nothing was listed.".into()),
            Err(ureq::Error::Status(status, _)) => {
                return Err(format!("The server answered {status}. Nothing was listed."))
            }
            Err(_) => return Err("The index didn't answer. Nothing was listed.".into()),
        };
        if (300..400).contains(&response.status()) {
            let next = response
                .header("Location")
                .ok_or("The index redirected without saying where. Nothing was listed.")?;
            current = url::Url::parse(&current)
                .and_then(|base| base.join(next))
                .map_err(|_| "The index redirected to an address that isn't valid.".to_string())?
                .to_string();
            continue;
        }
        let final_url = response.get_url().to_string();
        let mut text = String::new();
        response
            .into_reader()
            .take(MAX_INDEX_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|_| "The index isn't readable text. Nothing was listed.".to_string())?;
        if text.len() as u64 > MAX_INDEX_BYTES {
            return Err(too_big());
        }
        return Ok(Fetched { text, url: final_url });
    }
    Err("The index redirected too many times. Nothing was listed.".into())
}

/// List plugins from `sources` (the Settings list). Reads only; installing is WP-31's `plugins_install`.
#[tauri::command(async)]
pub fn plugins_discover(sources: Vec<IndexSource>) -> Vec<IndexResult> {
    discover(&sources, &fetch_https)
}
