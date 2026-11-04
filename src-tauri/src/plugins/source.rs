//! Where a plugin comes from (WP-31 build step 1) and how it is fetched: a git repository pinned to a commit or tag,
//! an npm package at an exact version, or a local folder. No floating versions: a branch, `latest` or a range is
//! refused with a plain reason.
//!
//! Fetching never runs plugin code. A git folder on this machine has its `plugin.json` read and checked before any
//! clone. A remote commit is fetched into a scratch repository (no checkout, so no hooks, smudge filters or LFS), its
//! `plugin.json` is read from the object store and checked, and only then does `git archive` unpack it. npm: `npm view`
//! reads the registry entry (no download) and is checked first, then `npm pack --ignore-scripts` downloads the tarball,
//! whose sha512 must match the registry's, and it is unpacked here. Nothing is trusted until WP-30's loader validates it.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::compat::{Declared, Target};
use super::fsutil;
use super::registry::Source;

/// What the person (or Discover, or an agent's request) asks to install.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum InstallSource {
    /// A repository pinned to a full commit id or a tag; `path` is the plugin's folder inside it.
    Git {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    /// A package at one exact version.
    Npm {
        package: String,
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        registry: Option<String>,
    },
    /// A folder on this machine.
    Local { path: String },
}

/// The programs a fetch runs, and the search path they run with.
#[derive(Clone, Debug)]
pub struct Tools {
    pub git: OsString,
    pub npm: OsString,
    pub path: Option<OsString>,
    pub target: Target,
}

impl Tools {
    /// The app's: git and npm from the login shell's search path (a Finder launch's PATH lacks them).
    pub fn app() -> Self {
        Self {
            git: "git".into(),
            npm: if cfg!(windows) { "npm.cmd" } else { "npm" }.into(),
            path: Some(crate::harness::cached_gui_search_path().into()),
            target: Target::here(),
        }
    }

    fn command(&self, program: &OsString) -> Command {
        let mut cmd = Command::new(program);
        crate::hide_window_console(&mut cmd);
        if let Some(path) = &self.path {
            cmd.env("PATH", path);
        }
        cmd.stdin(Stdio::null());
        cmd
    }

    fn git(&self) -> Command {
        let mut cmd = self.command(&self.git);
        cmd.env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_LFS_SKIP_SMUDGE", "1")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .args(["-c", "protocol.ext.allow=never"]);
        cmd
    }
}

fn run(mut cmd: Command, what: &str) -> Result<Vec<u8>, String> {
    let output = cmd
        .output()
        .map_err(|e| format!("{what} couldn't start: {e}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let line = err
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("it failed");
    Err(format!("{what} failed: {line}"))
}

fn is_hex_id(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

fn tag_problem(tag: &str) -> Option<&'static str> {
    if tag.is_empty() || tag.len() > 200 {
        return Some("a tag must be 1 to 200 characters");
    }
    if tag.starts_with(['-', '/', '.']) || tag.ends_with(['/', '.']) || tag.ends_with(".lock") {
        return Some("that isn't a tag name");
    }
    if tag.contains("..") || tag.contains("//") || tag.contains("@{") {
        return Some("that isn't a tag name");
    }
    if !tag
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/' | b'+'))
    {
        return Some("a tag may only use letters, digits, \".\", \"_\", \"-\", \"/\" and \"+\"");
    }
    None
}

fn git_url_problem(url: &str) -> Option<&'static str> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Some("the repository address is empty or starts with \"-\"");
    }
    if url.contains("::") {
        return Some("git transport helpers (\"name::address\") aren't allowed");
    }
    if url.chars().any(char::is_control) {
        return Some("the repository address holds a control character");
    }
    let lower = url.to_ascii_lowercase();
    let scheme_ok = ["https://", "http://", "ssh://", "git://", "file://"]
        .iter()
        .any(|s| lower.starts_with(s));
    let scp_like = !lower.contains("://")
        && url.split_once(':').is_some_and(|(host, _)| {
            host.contains('@') && !host.contains('/') && !host.contains('\\')
        });
    if scheme_ok || scp_like || Path::new(url).is_absolute() {
        return None;
    }
    Some("use an https://, ssh:// or git@host:path address, or a full folder path")
}

fn subpath_problem(path: &str) -> Option<&'static str> {
    let p = Path::new(path);
    if path.is_empty()
        || p.is_absolute()
        || path.contains('\\')
        || !p.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return Some("the plugin's folder in the repository must be a plain relative path");
    }
    None
}

/// npm's package name rules (validate-npm-package-name, new packages).
fn npm_name_problem(name: &str) -> Option<&'static str> {
    let ok_part = |part: &str| {
        !part.is_empty()
            && !part.starts_with(['.', '_'])
            && part.bytes().all(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'-' | b'.' | b'_' | b'~')
            })
    };
    let valid = name.len() <= 214
        && match name.strip_prefix('@') {
            Some(scoped) => scoped
                .split_once('/')
                .is_some_and(|(scope, pkg)| ok_part(scope) && ok_part(pkg)),
            None => ok_part(name),
        };
    (!valid).then_some("that isn't an npm package name")
}

fn registry_problem(registry: &str) -> Option<&'static str> {
    let Ok(url) = url::Url::parse(registry) else {
        return Some("the registry must be a web address");
    };
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() == "https" || (url.scheme() == "http" && loopback) {
        return None;
    }
    Some("the registry must be an https address")
}

impl InstallSource {
    /// Refuse anything that isn't pinned or can't be passed safely to git or npm.
    pub fn check(&self) -> Result<(), String> {
        let refuse = |why: &str| Err(format!("This source can't be installed: {why}."));
        match self {
            InstallSource::Git {
                url,
                commit,
                tag,
                path,
            } => {
                if let Some(why) = git_url_problem(url) {
                    return refuse(why);
                }
                match (commit, tag) {
                    (Some(commit), None) if is_hex_id(commit) => {}
                    (Some(_), None) => {
                        return refuse(
                            "a commit must be its full id (40 hex characters), never a branch",
                        )
                    }
                    (None, Some(tag)) => {
                        if let Some(why) = tag_problem(tag) {
                            return refuse(why);
                        }
                    }
                    (Some(_), Some(_)) => return refuse("give a commit or a tag, not both"),
                    (None, None) => {
                        return refuse("it needs a commit or a tag; a branch would move under you")
                    }
                }
                if let Some(why) = path.as_deref().and_then(subpath_problem) {
                    return refuse(why);
                }
                Ok(())
            }
            InstallSource::Npm {
                package,
                version,
                registry,
            } => {
                if let Some(why) = npm_name_problem(package) {
                    return refuse(why);
                }
                if semver::Version::parse(version).is_err() {
                    return refuse(
                        "it needs an exact version such as 1.2.3, never a range or \"latest\"",
                    );
                }
                if let Some(why) = registry.as_deref().and_then(registry_problem) {
                    return refuse(why);
                }
                Ok(())
            }
            InstallSource::Local { path } => {
                if !Path::new(path).is_absolute() {
                    return refuse("a folder needs its full path");
                }
                Ok(())
            }
        }
    }

    /// The source as the registry and lock file keep it, before the pin is known for sure.
    fn recorded(&self, pin: Option<String>) -> Source {
        match self {
            InstallSource::Git { url, tag, path, .. } => Source {
                kind: "git".into(),
                location: url.clone(),
                pin,
                tag: tag.clone(),
                path: path.clone(),
                registry: None,
            },
            InstallSource::Npm {
                package, registry, ..
            } => Source {
                kind: "npm".into(),
                location: package.clone(),
                pin,
                tag: None,
                path: None,
                registry: registry.clone(),
            },
            InstallSource::Local { path } => Source {
                pin,
                ..Source::local(Path::new(path))
            },
        }
    }
}

/// A fetched plugin: `root` is its folder inside `work` (which the caller removes).
#[derive(Debug)]
pub struct Fetched {
    pub root: PathBuf,
    pub source: Source,
}

/// Fetch `source` into `work` (an empty scratch folder), checking it can run on `tools.target` before anything is
/// downloaded where the source allows it.
pub fn fetch(source: &InstallSource, tools: &Tools, work: &Path) -> Result<Fetched, String> {
    source.check()?;
    std::fs::create_dir_all(work).map_err(|e| format!("A scratch folder couldn't be made: {e}"))?;
    match source {
        InstallSource::Git {
            url,
            commit,
            tag,
            path,
        } => fetch_git(
            source,
            tools,
            work,
            url,
            commit.as_deref(),
            tag.as_deref(),
            path.as_deref(),
        ),
        InstallSource::Npm {
            package,
            version,
            registry,
        } => fetch_npm(source, tools, work, package, version, registry.as_deref()),
        InstallSource::Local { path } => {
            let dir = crate::fs::expand_home(path);
            if !dir.is_dir() {
                return Err(format!("{} isn't a folder.", dir.display()));
            }
            Ok(Fetched {
                root: dir,
                source: source.recorded(None),
            })
        }
    }
}

fn fetch_git(
    source: &InstallSource,
    tools: &Tools,
    work: &Path,
    url: &str,
    commit: Option<&str>,
    tag: Option<&str>,
    path: Option<&str>,
) -> Result<Fetched, String> {
    let commit = match (commit, tag) {
        (Some(commit), _) => commit.to_ascii_lowercase(),
        (None, Some(tag)) => resolve_tag(tools, url, tag)?,
        (None, None) => unreachable!("checked"),
    };
    // A folder on this machine can be refused before any clone. A remote commit has to be fetched before its
    // plugin.json can be read; the tree is still not unpacked until the check below passes.
    if let Some(dir) = local_git_dir(url) {
        let manifest = show_plugin_json(tools, &dir, &commit, path)?;
        check_manifest_bytes(&manifest, &tools.target)?;
    }
    let repo = work.join("repo");
    let mut init = tools.git();
    // No template: the scratch repository starts with no hooks at all.
    init.args(["init", "-q", "--bare", "--template="])
        .arg(&repo);
    run(init, "git init")?;
    let mut fetch = tools.git();
    fetch
        .arg("-C")
        .arg(&repo)
        .args(["fetch", "-q", "--depth", "1", "--no-tags", "--"])
        .arg(url)
        .arg(&commit);
    if run(fetch, "git fetch").is_err() {
        // A server that won't hand out a commit by id: fetch its branches and tags, then look for it.
        let mut all = tools.git();
        all.arg("-C")
            .arg(&repo)
            .args(["fetch", "-q", "--no-tags", "--"])
            .arg(url)
            .args([
                "+refs/heads/*:refs/remotes/src/*",
                "+refs/tags/*:refs/tags/*",
            ]);
        run(all, "git fetch")?;
    }
    let mut verify = tools.git();
    verify
        .arg("-C")
        .arg(&repo)
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("{commit}^{{commit}}"));
    let found = run(verify, "git rev-parse")
        .map(|out| String::from_utf8_lossy(&out).trim().to_ascii_lowercase())
        .map_err(|_| format!("The commit {commit} isn't in {url}."))?;
    if found != commit {
        return Err(format!("The commit {commit} isn't in {url}."));
    }
    let tree = match path {
        Some(path) => format!("{commit}:{path}"),
        None => commit.clone(),
    };
    // Read plugin.json from the object store and check it before a single file is written out.
    let manifest = show_plugin_json(tools, &repo, &commit, path)?;
    check_manifest_bytes(&manifest, &tools.target)?;
    let out = work.join("plugin");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let mut archive = tools.git();
    archive
        .arg("-C")
        .arg(&repo)
        .args(["archive", "--format=tar"])
        .arg(&tree);
    let tar = run(archive, "git archive")?;
    unpack_tar(&tar[..], &out, false)?;
    let _ = fsutil::remove_tree(&repo);
    Ok(Fetched {
        root: out,
        source: source.recorded(Some(commit)),
    })
}

/// A git address that is a folder on this machine (`/path`, `C:\path`, `file://…`), when that folder exists.
fn local_git_dir(url: &str) -> Option<PathBuf> {
    let path = if url.to_ascii_lowercase().starts_with("file://") {
        url::Url::parse(url).ok()?.to_file_path().ok()?
    } else if url.contains("://") {
        return None;
    } else {
        PathBuf::from(url)
    };
    (path.is_absolute() && path.is_dir()).then_some(path)
}

/// `plugin.json` from a commit's object store. No checkout, so nothing of the plugin runs.
fn show_plugin_json(
    tools: &Tools,
    repo: &Path,
    commit: &str,
    path: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut show = tools.git();
    show.arg("-C")
        .arg(repo)
        .args(["show", "--no-textconv"])
        .arg(match path {
            Some(path) => format!("{commit}:{path}/plugin.json"),
            None => format!("{commit}:plugin.json"),
        });
    run(show, "git show").map_err(|_| {
        format!(
            "There's no plugin.json at {} in that commit.",
            path.unwrap_or("the top of the repository")
        )
    })
}

fn resolve_tag(tools: &Tools, url: &str, tag: &str) -> Result<String, String> {
    let mut cmd = tools.git();
    cmd.args(["ls-remote", "--tags", "--"])
        .arg(url)
        .arg(format!("refs/tags/{tag}"))
        .arg(format!("refs/tags/{tag}^{{}}"));
    let out = run(cmd, "git ls-remote")?;
    let text = String::from_utf8_lossy(&out);
    let mut direct = None;
    let mut peeled = None;
    for line in text.lines() {
        let Some((id, name)) = line.split_once('\t') else {
            continue;
        };
        if name == format!("refs/tags/{tag}^{{}}") {
            peeled = Some(id.trim().to_ascii_lowercase());
        } else if name == format!("refs/tags/{tag}") {
            direct = Some(id.trim().to_ascii_lowercase());
        }
    }
    peeled
        .or(direct)
        .filter(|id| is_hex_id(id))
        .ok_or_else(|| format!("{url} has no tag \"{tag}\"."))
}

/// Check a `plugin.json` read before the plugin's files are unpacked. A manifest that can't be read here is left to
/// the loader, which refuses it with its own reason.
fn check_manifest_bytes(bytes: &[u8], target: &Target) -> Result<(), String> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(manifest) => Declared::from_manifest(&manifest)?.check(target),
        Err(_) => Ok(()),
    }
}

fn fetch_npm(
    source: &InstallSource,
    tools: &Tools,
    work: &Path,
    package: &str,
    version: &str,
    registry: Option<&str>,
) -> Result<Fetched, String> {
    let spec = format!("{package}@{version}");
    let with_registry = |cmd: &mut Command| {
        if let Some(registry) = registry {
            cmd.arg("--registry").arg(registry);
        }
    };
    // The registry entry first: no download, and refused here if it can't run on this machine.
    let mut view = tools.command(&tools.npm);
    view.args(["view", "--json"]).arg(&spec);
    with_registry(&mut view);
    let entry = run(view, "npm view")?;
    let entry: Value =
        serde_json::from_slice(&entry).map_err(|_| format!("npm couldn't describe {spec}."))?;
    let entry = match entry {
        Value::Array(mut items) => items.pop().unwrap_or(Value::Null),
        other => other,
    };
    if entry.get("version").and_then(Value::as_str) != Some(version) {
        return Err(format!("npm has no {spec}."));
    }
    Declared::from_npm(&entry)?.check(&tools.target)?;
    let integrity = entry
        .get("dist")
        .and_then(|d| d.get("integrity"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let download = work.join("download");
    std::fs::create_dir_all(&download).map_err(|e| e.to_string())?;
    let mut pack = tools.command(&tools.npm);
    pack.args(["pack", "--json", "--ignore-scripts", "--pack-destination"])
        .arg(&download)
        .arg(&spec)
        .current_dir(&download);
    with_registry(&mut pack);
    let packed = run(pack, "npm pack")?;
    let filename = serde_json::from_slice::<Value>(&packed)
        .ok()
        .and_then(|v| v.get(0)?.get("filename")?.as_str().map(str::to_string))
        .ok_or_else(|| format!("npm pack didn't say where it put {spec}."))?;
    let name = Path::new(&filename)
        .file_name()
        .ok_or_else(|| "npm pack named no file.".to_string())?;
    let tarball = download.join(name);
    let bytes = std::fs::read(&tarball).map_err(|e| format!("The package can't be read: {e}"))?;
    if let Some(expected) = &integrity {
        let actual = sha512_integrity(&bytes);
        if expected.split_whitespace().all(|one| one != actual) {
            return Err(format!(
                "The downloaded {spec} doesn't match the registry's checksum, so it was refused."
            ));
        }
    }
    let out = work.join("plugin");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    unpack_tar(flate2::read::GzDecoder::new(&bytes[..]), &out, true)?;
    let package_json = std::fs::read(out.join("package.json")).unwrap_or_default();
    if let Ok(manifest) = serde_json::from_slice::<Value>(&package_json) {
        Declared::from_npm(&manifest)?.check(&tools.target)?;
    }
    let _ = fsutil::remove_tree(&download);
    Ok(Fetched {
        root: out,
        source: source.recorded(Some(version.to_string())),
    })
}

pub fn sha512_integrity(bytes: &[u8]) -> String {
    use base64::Engine;
    use sha2::Digest;
    let digest = sha2::Sha512::digest(bytes);
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(digest)
    )
}

/// Unpack plain files and folders only (links and devices are left out), never outside `out`. npm tarballs keep
/// everything under one top folder (`package/`), which `strip_top` drops.
fn unpack_tar(reader: impl Read, out: &Path, strip_top: bool) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    archive.set_preserve_permissions(false);
    archive.set_overwrite(true);
    let entries = archive
        .entries()
        .map_err(|e| format!("The download can't be unpacked: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("The download can't be unpacked: {e}"))?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| format!("The download can't be unpacked: {e}"))?
            .into_owned();
        let mut parts = path
            .components()
            .filter(|c| !matches!(c, Component::CurDir));
        if strip_top {
            parts.next();
        }
        let rel: PathBuf = parts.collect();
        if rel.as_os_str().is_empty() {
            continue;
        }
        if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(format!(
                "The download holds a path that leaves its folder ({}), so it was refused.",
                path.display()
            ));
        }
        let dest = out.join(&rel);
        if kind.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = std::fs::File::create(&dest)
            .map_err(|e| format!("{} couldn't be written: {e}", rel.display()))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|e| format!("{} couldn't be written: {e}", rel.display()))?;
        #[cfg(unix)]
        if let Ok(mode) = entry.header().mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &dest,
                std::fs::Permissions::from_mode(mode & 0o755 | 0o600),
            );
        }
    }
    Ok(())
}
