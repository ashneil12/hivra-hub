//! WP-101: what a plugin copy holds, read before the person is asked to install it. A block stops the install with
//! nothing placed; a warning is shown on the pending card and the person decides. Nothing here runs plugin code or
//! writes anything: it reads the staged folder and compares names.
//!
//! Translated from Row-Bot, `src/row_bot/skills_hub/scanner.py` (Apache-2.0, Copyright 2026 Row-Bot Contributors).
//! Changed for Hivra: Python became Rust; the thing scanned is a Hivra plugin (its manifest, skills and MCP servers)
//! rather than one public skill bundle, so a plugin with no skills is fine and a skill that won't load only warns; an
//! install the person approves may run its manifest's own setup steps, so those don't block here; and the file list
//! comes from the staged folder itself rather than a downloaded bundle's index.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::manifest::{split_frontmatter, LoadedPlugin};

pub const MAX_FILE_BYTES: u64 = 10_000_000;
pub const MAX_TOTAL_BYTES: u64 = 50_000_000;
pub const MAX_FILE_COUNT: usize = 500;
pub const MAX_MANIFEST_BYTES: usize = 1_000_000;
pub const HIGH_TOKEN_WARNING: usize = 4_000;

/// Extensions that something can run, worth naming on the card even though Hivra only copies them.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "py", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "js", "ts", "mjs", "cjs", "exe", "dll",
    "dylib", "so", "jar", "app", "command",
];
/// Binary formats a plugin can legitimately need. Any other binary is worth a warning (Row-Bot's list).
const ALLOWED_BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "docx", "xlsx", "pptx",
];
/// Frontmatter keys that ask for an installer rather than give instructions. `tools` is checked on its own because
/// it means something different (a skill trying to be a tool).
const INSTALLER_KEYS: &[&str] = &[
    "install",
    "installer",
    "setup",
    "setup_commands",
    "commands",
    "postinstall",
    "preinstall",
    "scripts",
];
/// Build and task files that another program starts when asked. Hivra only copies them, so they warn rather than
/// block; the person sees that the plugin carries them.
const RUNNER_FILES: &[&str] = &[
    "makefile",
    "gnumakefile",
    "justfile",
    "taskfile.yml",
    "taskfile.yaml",
    "rakefile",
    "gemfile",
    "procfile",
    "dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
];
/// package.json scripts npm runs by itself when it installs the package.
const INSTALL_SCRIPTS: &[&str] = &["preinstall", "install", "postinstall", "prepare"];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Block,
    Warn,
    Info,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub severity: Severity,
    /// A stable name for what was found, so the card and these tests speak the same language.
    pub code: String,
    /// A path relative to the plugin, when the finding is about one.
    pub path: String,
    /// What was found, in plain words.
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    /// True when any finding blocks: the install stops and nothing is placed.
    pub blocked: bool,
    pub findings: Vec<Finding>,
    pub files: usize,
    pub bytes: u64,
    /// The approximate size of what the agent will read, in tokens.
    pub token_estimate: usize,
    /// The content hash of the copy that was read (`fsutil::tree_digest`), checked again before the install lands.
    #[serde(default)]
    pub digest: String,
}

/// One entry of the staged copy: its path relative to the plugin root (as written, with either separator), its size,
/// and whether it is a link.
#[derive(Clone, Debug)]
pub struct Entry {
    pub path: String,
    pub bytes: u64,
    pub link: bool,
}

impl Entry {
    #[cfg(test)]
    pub fn file(path: impl Into<String>, bytes: u64) -> Self {
        Self {
            path: path.into(),
            bytes,
            link: false,
        }
    }
}

fn finding(severity: Severity, code: &str, path: &str, message: impl Into<String>) -> Finding {
    Finding {
        severity,
        code: code.into(),
        path: path.into(),
        message: message.into(),
    }
}

/// Scan a staged plugin folder. A folder that can't be read blocks: an install the person was told nothing about
/// must not go ahead. The result carries the copy's content hash, so the same copy can be proved at commit time.
pub fn scan(root: &Path) -> ScanResult {
    match walk(root) {
        Ok(entries) => {
            let mut result = scan_entries(root, &entries);
            // WP-101 fix round 2, item H(b): a file the walk found but can't read can't be read for a reason, and a
            // copy that hides one from the check is not the copy the person was told about. Read here, where the
            // entries are real files, not in the pure pass above, so a swap to an unreadable file blocks.
            for entry in &entries {
                if entry.link || escapes(&entry.path) {
                    continue;
                }
                if let Err(e) = std::fs::read(local(root, &entry.path)).map(|_| ()) {
                    result.findings.push(finding(
                        Severity::Block,
                        "unreadable_file",
                        &entry.path,
                        format!("This file couldn't be read ({e}), so nothing was installed."),
                    ));
                    result.blocked = true;
                }
            }
            result.digest = super::fsutil::tree_digest(root);
            result
        }
        Err(why) => unreadable(why),
    }
}

/// A staged copy, with reads that arrive from disk treated as untrusted: any finding not shaped as one is dropped, and
/// every other field is rebuilt rather than passed through.
pub fn scan_untrusted(root: &Path) -> ScanResult {
    let mut result = scan(root);
    result.findings = result
        .findings
        .into_iter()
        .filter_map(|f| {
            let message = sanitized(&f.message, 400);
            if message.is_empty() {
                return None;
            }
            Some(Finding {
                severity: f.severity,
                code: sanitized(&f.code, 40),
                path: sanitized(&f.path, 200),
                message,
            })
        })
        .collect();
    result
}

/// Text on a card: one line, no control characters, no NUL, trimmed and cut to `most` characters at a character
/// boundary (so a name in any script stays whole).
pub(super) fn sanitized(text: &str, most: usize) -> String {
    let clean: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .filter(|c| *c != '\0')
        .collect();
    let mut cut: String = clean.trim().chars().take(most).collect();
    if cut.chars().count() == most && clean.trim().chars().count() > most {
        cut.push_str("...");
    }
    cut
}

/// The same scan for a plugin the loader has already read.
pub fn scan_loaded(loaded: &LoadedPlugin) -> ScanResult {
    scan(&loaded.root)
}

/// Read a fetched folder before it is copied into place: links and paths that climb out are blocks here, since the
/// copy silently leaves them out (fsutil::copy_plugin_tree) and the person should know rather than have it vanish.
/// Only paths and kinds are compared; the same folder is scanned again once staged, for everything else.
pub fn scan_source(fetched: &Path, staged: &Path) -> Vec<Finding> {
    let Ok(entries) = walk(fetched) else {
        return Vec::new();
    };
    let mut findings = Vec::new();
    for entry in &entries {
        if escapes(&entry.path) {
            findings.push(finding(
                Severity::Block,
                "path_traversal",
                &entry.path,
                "This file's path leads outside the plugin folder.",
            ));
        }
        if entry.link && dropped_by_copy(fetched, staged, &entry.path) {
            findings.push(finding(
                Severity::Block,
                "symlink",
                &entry.path,
                "This is a link to another place on the computer, so the install stops.",
            ));
        }
    }
    findings
}

/// Whether the copy leaves this link out: it points outside the plugin. (A link that points inside is copied as the
/// file it points to, so it is not a reason to stop.)
fn dropped_by_copy(fetched: &Path, _staged: &Path, rel: &str) -> bool {
    let source = local(fetched, rel);
    let Some(target) = std::fs::read_link(&source).ok() else {
        return false;
    };
    let real = if target.is_absolute() {
        target
    } else {
        source.parent().unwrap_or(fetched).join(target)
    };
    let Ok(real) = super::fsutil::canonical(&real) else {
        return true;
    };
    let Ok(root) = super::fsutil::canonical(fetched) else {
        return false;
    };
    !real.starts_with(&root)
}

fn unreadable(why: String) -> ScanResult {
    ScanResult {
        blocked: true,
        findings: vec![finding(
            Severity::Block,
            "unreadable_folder",
            "",
            format!("The plugin folder couldn't be read ({why}). Nothing was installed."),
        )],
        ..ScanResult::default()
    }
}

/// Every file and link under `root`, sorted, with links read as links and never followed.
fn walk(root: &Path) -> Result<Vec<Entry>, String> {
    fn visit(base: &Path, dir: &Path, out: &mut Vec<Entry>) -> Result<(), String> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if entry.file_name() == ".git" {
                continue;
            }
            let path = entry.path();
            let rel = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                out.push(Entry {
                    path: rel,
                    bytes: 0,
                    link: true,
                });
            } else if meta.is_dir() {
                visit(base, &path, out)?;
            } else if meta.is_file() {
                out.push(Entry {
                    path: rel,
                    bytes: meta.len(),
                    link: false,
                });
            }
        }
        Ok(())
    }
    if !std::fs::symlink_metadata(root)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("it isn't a folder".into());
    }
    let mut out = Vec::new();
    visit(root, root, &mut out)?;
    Ok(out)
}

/// Whether a relative path stays inside the folder it was found in: no drive, no root and no `..`.
fn escapes(path: &str) -> bool {
    let bytes = path.as_bytes();
    if path.is_empty() || path.starts_with('/') || path.starts_with('\\') {
        return true;
    }
    if bytes.len() > 1 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    path.split(['/', '\\']).any(|part| part == "..")
}

/// The file's extension, lowercased; empty when it has none (a leading dot isn't an extension).
fn suffix(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn local(root: &Path, rel: &str) -> PathBuf {
    root.join(rel.replace('\\', "/"))
}

/// Read a file as text; anything unreadable comes back empty, which can only mean fewer warnings.
fn read_text(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(local(root, rel)).unwrap_or_default()
}

/// Whether a file reads as text, judged from its first bytes: a NUL byte or invalid UTF-8 means binary.
fn reads_as_text(root: &Path, rel: &str) -> bool {
    let Ok(bytes) = std::fs::read(local(root, rel)) else {
        return true;
    };
    let head = &bytes[..bytes.len().min(8_000)];
    !head.contains(&0) && std::str::from_utf8(head).is_ok()
}

/// Whether the file's first line starts with `#!`, which is how a script names the program that runs it. Only the
/// first two bytes are read, so a large file costs nothing.
fn starts_with_shebang(root: &Path, rel: &str) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(local(root, rel)) else {
        return false;
    };
    let mut head = [0u8; 2];
    file.read_exact(&mut head).is_ok() && &head == b"#!"
}

/// Whether a package.json asks npm to run one of its own install scripts. Only a warning: npm runs those on install,
/// and the install card already says so.
fn install_script_finding(root: &Path, rel: &str, findings: &mut Vec<Finding>) {
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&read_text(root, rel)) else {
        return;
    };
    let Some(scripts) = package
        .get("scripts")
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };
    let ran: Vec<&str> = INSTALL_SCRIPTS
        .iter()
        .copied()
        .filter(|name| {
            scripts
                .get(*name)
                .and_then(serde_json::Value::as_str)
                .is_some()
        })
        .collect();
    if !ran.is_empty() {
        findings.push(finding(
            Severity::Warn,
            "install_script",
            rel,
            format!(
                "package.json runs {} when npm installs it; Hivra only copies it unless the person approves the install.",
                ran.join(", ")
            ),
        ));
    }
}

/// Scan a copy described by `entries`, reading its manifest, skills and files from `root`. Tests use this to
/// describe a copy (paths, sizes, links) without making one; the install path always calls `scan`.
pub fn scan_entries(root: &Path, entries: &[Entry]) -> ScanResult {
    let mut findings: Vec<Finding> = Vec::new();
    let mut total: u64 = 0;
    let mut skill_files = 0usize;
    let mut manifests: Vec<String> = Vec::new();

    if entries.len() > MAX_FILE_COUNT {
        findings.push(finding(
            Severity::Block,
            "too_many_files",
            "",
            format!(
                "It holds {} files, more than the {MAX_FILE_COUNT} a plugin may have.",
                entries.len()
            ),
        ));
    }

    for entry in entries {
        let path = entry.path.replace('\\', "/");
        total = total.saturating_add(entry.bytes);
        if escapes(&entry.path) {
            findings.push(finding(
                Severity::Block,
                "path_traversal",
                &entry.path,
                "This file's path leads outside the plugin folder.",
            ));
        }
        if entry.link {
            findings.push(finding(
                Severity::Block,
                "symlink",
                &entry.path,
                "This is a link to another place on the computer, so the install stops.",
            ));
        }
        if entry.bytes > MAX_FILE_BYTES {
            findings.push(finding(
                Severity::Block,
                "file_too_large",
                &entry.path,
                format!(
                    "This file is larger than {} MB.",
                    MAX_FILE_BYTES / 1_000_000
                ),
            ));
        }
        let name = path.rsplit('/').next().unwrap_or(&path);
        let lower = name.to_lowercase();
        if lower == "plugin.json" {
            manifests.push(path.clone());
        }
        if lower == "skill.md" {
            skill_files += 1;
        }
        let ext = suffix(&path);
        if path.starts_with("scripts/") || path.contains("/scripts/") {
            findings.push(finding(
                Severity::Warn,
                "scripts_present",
                &entry.path,
                "A script is copied with the plugin; Hivra never runs it.",
            ));
        }
        if EXECUTABLE_EXTENSIONS.contains(&ext.as_str()) {
            findings.push(finding(
                Severity::Warn,
                "executable_extension",
                &entry.path,
                "Something else could run this file; Hivra only copies it.",
            ));
        } else if !ALLOWED_BINARY_EXTENSIONS.contains(&ext.as_str()) && !reads_as_text(root, &path)
        {
            findings.push(finding(
                Severity::Warn,
                "suspicious_binary",
                &entry.path,
                "This file isn't text and isn't a common format; it is copied, never run.",
            ));
        }
        // A file with no extension that another program can still start: a #! first line, or a name a runner looks
        // for. Hivra never runs it, and the person is told it is there.
        if !entry.link && !escapes(&entry.path) {
            let runner_name = RUNNER_FILES.contains(&lower.as_str());
            if runner_name || starts_with_shebang(root, &path) {
                findings.push(finding(
                    Severity::Warn,
                    "runnable_file",
                    &entry.path,
                    if runner_name {
                        "A program on this computer can start this file; Hivra only copies it."
                    } else {
                        "This file starts with a script line, so a program could run it; Hivra only copies it."
                    },
                ));
            }
            if lower == "package.json" {
                install_script_finding(root, &path, &mut findings);
            }
        }
        if lower == "hooks.json" {
            findings.push(finding(
                Severity::Warn,
                "hooks_file",
                &entry.path,
                "This is a hooks file; Hivra doesn't run plugin hooks, and the person may want to check it.",
            ));
        }
        let lower_path = path.to_lowercase();
        if lower_path.starts_with(".husky/") || lower_path.contains("/.husky/") {
            findings.push(finding(
                Severity::Warn,
                "hook_script",
                &entry.path,
                "This runs when someone commits with git; Hivra only copies it.",
            ));
        }
    }

    if total > MAX_TOTAL_BYTES {
        findings.push(finding(
            Severity::Block,
            "bundle_too_large",
            "",
            format!(
                "The plugin is larger than {} MB.",
                MAX_TOTAL_BYTES / 1_000_000
            ),
        ));
    }

    manifest_findings(root, &manifests, &mut findings);
    skill_findings(root, entries, &mut findings);

    let instructions = instructions(root, entries, &manifests);
    let token_estimate = instructions.len() / 4;
    if token_estimate > HIGH_TOKEN_WARNING {
        findings.push(finding(
            Severity::Warn,
            "high_token_estimate",
            "",
            format!("The skills' instructions are long, about {token_estimate} tokens."),
        ));
    }
    for (code, message) in wording_findings(&instructions) {
        findings.push(finding(Severity::Warn, code, "", message));
    }

    findings.push(finding(
        Severity::Info,
        "file_count",
        "",
        format!(
            "It holds {} files, about {token_estimate} tokens of instructions.",
            entries.len()
        ),
    ));
    if skill_files == 0 {
        findings.push(finding(
            Severity::Info,
            "no_skills",
            "",
            "It adds no skills.",
        ));
    }

    let blocked = findings.iter().any(|f| f.severity == Severity::Block);
    ScanResult {
        blocked,
        findings,
        files: entries.len(),
        bytes: total,
        token_estimate,
        digest: String::new(),
    }
}

/// The manifest: exactly one `plugin.json` at the top, readable, a JSON object, with a name. An unreadable one
/// blocks, since nothing about the install can be described without it.
fn manifest_findings(root: &Path, manifests: &[String], findings: &mut Vec<Finding>) {
    match manifests {
        [] => findings.push(finding(
            Severity::Block,
            "missing_manifest",
            "",
            "There is no plugin.json at the top of the plugin.",
        )),
        [only] if only != "plugin.json" => findings.push(finding(
            Severity::Block,
            "nested_manifest",
            only,
            "plugin.json belongs at the top of the plugin, not inside a folder.",
        )),
        [_, second, ..] => findings.push(finding(
            Severity::Block,
            "duplicate_manifest",
            second,
            "There is more than one plugin.json, so the plugin can't be read as one thing.",
        )),
        [only] => {
            let size = std::fs::metadata(local(root, only))
                .map_or(0, |meta| meta.len())
                .min(usize::MAX as u64) as usize;
            let text = read_text(root, only);
            if size > MAX_MANIFEST_BYTES {
                findings.push(finding(
                    Severity::Block,
                    "manifest_too_large",
                    only,
                    "plugin.json is far larger than a manifest can usefully be.",
                ));
            } else if text.trim().is_empty() {
                findings.push(finding(
                    Severity::Block,
                    "unreadable_manifest",
                    only,
                    "plugin.json can't be read.",
                ));
            } else {
                match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(serde_json::Value::Object(object)) => {
                        let named = object
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|name| !name.trim().is_empty());
                        if !named {
                            findings.push(finding(
                                Severity::Block,
                                "manifest_name",
                                only,
                                "plugin.json has no name.",
                            ));
                        }
                    }
                    Ok(_) => findings.push(finding(
                        Severity::Block,
                        "unreadable_manifest",
                        only,
                        "plugin.json must be a JSON object.",
                    )),
                    Err(_) => findings.push(finding(
                        Severity::Block,
                        "unreadable_manifest",
                        only,
                        "plugin.json isn't valid JSON.",
                    )),
                }
            }
        }
    }
}

/// What the skills declare. A skill that won't load only warns here: the loader already skips it and says why. A skill
/// asking to be a tool, or carrying its own installer, blocks: a plugin skill is instructions only, and anything that
/// runs belongs in plugin.json, where the pending card shows it.
fn skill_findings(root: &Path, entries: &[Entry], findings: &mut Vec<Finding>) {
    if let Ok(children) = std::fs::read_dir(root.join("skills")) {
        let mut children: Vec<_> = children.flatten().collect();
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            if !path.is_dir() {
                continue;
            }
            let rel = format!("skills/{}", child.file_name().to_string_lossy());
            // A lower-case skill.md is the same file to a loader on a case-insensitive disk, so it is read here too.
            let text = skill_file(&path).map(|(_, text)| text).unwrap_or_default();
            if text.trim().is_empty() {
                findings.push(finding(
                    Severity::Warn,
                    "skill_not_loadable",
                    &rel,
                    "This skill has no SKILL.md the agent can read, so it won't load.",
                ));
            }
        }
    }
    let mut installer_keys: Vec<String> = Vec::new();
    let mut declares_tools = false;
    for entry in entries {
        let rel = entry.path.replace('\\', "/");
        if !name_is(&rel, "SKILL.md") || escapes(&entry.path) || entry.link {
            continue;
        }
        let text = read_text(root, &rel);
        let front = split_frontmatter(&text).map_or("", |(front, _)| front);
        for line in front.lines() {
            let Some((key, _)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim().to_ascii_lowercase();
            if key == "tools" {
                declares_tools = true;
            } else if INSTALLER_KEYS.contains(&key.as_str()) && !installer_keys.contains(&key) {
                installer_keys.push(key);
            }
        }
    }
    if declares_tools {
        findings.push(finding(
            Severity::Block,
            "tools_metadata",
            "",
            "A skill asks to become a tool or a tool guide; plugin skills are instructions only.",
        ));
    }
    if !installer_keys.is_empty() {
        findings.push(finding(
            Severity::Block,
            "installer_metadata",
            "",
            format!(
                "A skill carries installer details ({}); installers belong in plugin.json, where the person approves them.",
                installer_keys.join(", ")
            ),
        ));
    }
}

/// The instructions an agent would read, joined, so the wording checks see the whole plugin: each skill's body and
/// frontmatter (a description is what every session shows about the skill, so it is read as instructions too),
/// every other `.md` or `.txt` file, which a skill can point the agent at, and every piece of text the manifest
/// declares (the name and description are shown in the installed list, and extension fields are text too).
fn instructions(root: &Path, entries: &[Entry], manifests: &[String]) -> String {
    let mut out = String::new();
    for path in manifests {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&read_text(root, path)) else {
            continue;
        };
        let mut strings = Vec::new();
        collect_strings(&value, &mut strings);
        out.push_str(&strings.join("\n"));
        out.push('\n');
    }
    for entry in entries {
        let rel = entry.path.replace('\\', "/");
        if escapes(&entry.path) || entry.link {
            continue;
        }
        let ext = suffix(&rel);
        if name_is(&rel, "SKILL.md") {
            let text = read_text(root, &rel);
            out.push_str(&text);
            out.push('\n');
        } else if ext == "md" || ext == "txt" {
            out.push_str(&read_text(root, &rel));
            out.push('\n');
        }
    }
    out
}

/// Every string inside a JSON value, however deeply it nests (a manifest is small and already size-capped). Keys are
/// read too: a description can sit under a key a version of the schema added later.
fn collect_strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => out.push(text.clone()),
        serde_json::Value::Array(items) => {
            for item in items {
                collect_strings(item, out);
            }
        }
        serde_json::Value::Object(fields) => {
            for (key, field) in fields {
                out.push(key.clone());
                collect_strings(field, out);
            }
        }
        _ => {}
    }
}

/// Whether the file name at the end of `path` is `name`, ignoring case: a loader on a case-insensitive disk finds
/// `skill.md` where it asks for `SKILL.md`, so the scan has to read it as one too.
fn name_is(path: &str, name: &str) -> bool {
    path.rsplit(['/', '\\'])
        .next()
        .is_some_and(|last| last.eq_ignore_ascii_case(name))
}

/// A skill's own instruction file, whatever its case: the name as it is on disk, and the text.
fn skill_file(dir: &Path) -> Option<(String, String)> {
    let children = std::fs::read_dir(dir).ok()?;
    for child in children.flatten() {
        let name = child.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case("SKILL.md") {
            let text = std::fs::read_to_string(child.path()).ok()?;
            return Some((name, text));
        }
    }
    None
}

/// Wording worth the person's eye before a plugin goes on. These never block: ordinary plugins say "send the token
/// count" and "ignore the permission prompt in the tutorial", so the person reads the warning and decides. The wording
/// is best effort: it reads a folded copy of the text, so a line break, a look-alike letter or a zero-width space
/// doesn't hide a phrase, but a determined author can still write around it, which is why the card says "may".
fn wording_findings(text: &str) -> Vec<(&'static str, &'static str)> {
    let folded = folded(text);
    let words = lower_words(&folded);
    if words.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    if near(&words, EXFILTRATE_VERBS, SECRET_NOUNS, 12) || reads_private_key(&words) {
        out.push((
            "secret_exfiltration",
            "Its instructions may be talking about sending or revealing a secret; read them before adding it.",
        ));
    }
    if near(&words, BYPASS_VERBS, APPROVAL_NOUNS, 12) {
        out.push((
            "approval_bypass",
            "Its instructions may be talking about getting past an approval or a sandbox; read them before adding it.",
        ));
    }
    if near(&words, CREDENTIAL_WORDS, KEY_NOUNS, 1)
        || has_phrase(&words, &["environment", "variable"])
        || mentions_ssh_home(&words)
    {
        out.push((
            "credentials_language",
            "Its instructions may be talking about keys or credentials; read them before adding it.",
        ));
    }
    if INJECTION_PHRASES
        .iter()
        .any(|phrase| has_phrase(&words, phrase))
        || has_phrase(&words, &["ignore", "instructions"])
        || split_letter_phrase(&words, "ignore")
    {
        out.push((
            "prompt_injection_language",
            "Its instructions may be telling the agent to ignore other instructions; read them before adding it.",
        ));
    }
    out
}

/// The text with look-alike letters and typographic marks folded to plain letters and a plain space.
fn folded(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let nfkc: String = text.nfkc().collect();
    let mut out = String::with_capacity(nfkc.len());
    for ch in nfkc.chars() {
        // Zero-width and bidi controls carry no sound, so they are dropped; "ig\u{200b}nore" is "ignore".
        if matches!(
            ch,
            '\u{200b}'..='\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2060}'..='\u{2064}'
                | '\u{feff}'
                | '\u{00ad}'
        ) {
            continue;
        }
        // NFKC has already folded full-width letters; Cyrillic and Greek look-alikes are folded by hand for the few
        // letters a wordlist cares about, in either case.
        out.push(match ch.to_lowercase().next().unwrap_or(ch) {
            'а' => 'a',
            'е' => 'e',
            'о' => 'o',
            'р' => 'p',
            'с' => 'c',
            'у' => 'y',
            'х' => 'x',
            'і' => 'i',
            'ѕ' => 's',
            'ј' => 'j',
            'ӏ' => 'l',
            'ο' => 'o',
            'α' => 'a',
            'ε' => 'e',
            'ι' => 'i',
            'ν' => 'v',
            'ρ' => 'p',
            'τ' => 't',
            'υ' => 'u',
            'χ' => 'x',
            other => other,
        });
    }
    out
}

/// "curl -d @~/.ssh/id_rsa" or "upload ~/.ssh/key": a private key path going somewhere.
fn reads_private_key(words: &[String]) -> bool {
    words
        .iter()
        .any(|word| word.contains(".ssh") || word.contains("id_rsa"))
}

/// "ssh key in ~/.ssh": a private key named in the instructions, wherever it sits.
fn mentions_ssh_home(words: &[String]) -> bool {
    words.iter().any(|word| word == ".ssh")
}

/// Whether a run of one-letter words spells `word`: "i.g.n.o.r.e" is "ignore" to a reader.
fn split_letter_phrase(words: &[String], word: &str) -> bool {
    let letters: Vec<char> = word.chars().collect();
    if letters.len() < 4 || words.len() < letters.len() {
        return false;
    }
    words.windows(letters.len()).any(|run| {
        run.iter()
            .zip(&letters)
            .all(|(part, letter)| part.chars().count() == 1 && part.starts_with(*letter))
    })
}

const EXFILTRATE_VERBS: &[&str] = &[
    "reveal",
    "dump",
    "exfiltrate",
    "send",
    "upload",
    "steal",
    "paste",
    "print",
    "copy",
];
const SECRET_NOUNS: &[&str] = &[
    "secret",
    "secrets",
    "token",
    "tokens",
    "key",
    "keys",
    "password",
    "passwords",
    "credential",
    "credentials",
    "env",
];
const BYPASS_VERBS: &[&str] = &["bypass", "ignore", "disable", "circumvent", "skip"];
const APPROVAL_NOUNS: &[&str] = &[
    "approval",
    "approvals",
    "sandbox",
    "consent",
    "permission",
    "permissions",
    "instruction",
    "instructions",
];
const CREDENTIAL_WORDS: &[&str] = &[
    "api",
    "token",
    "tokens",
    "credential",
    "credentials",
    "secret",
    "secrets",
    "password",
    "passwords",
];
const KEY_NOUNS: &[&str] = &[
    "key",
    "keys",
    "token",
    "tokens",
    "credential",
    "credentials",
    "secret",
    "secrets",
    "variable",
    "variables",
    "var",
    "vars",
];
const INJECTION_PHRASES: &[&[&str]] = &[
    &["ignore", "previous"],
    &["ignore", "all", "previous"],
    &["ignore", "above"],
    &["ignore", "the", "above"],
    &["system", "prompt"],
    &["developer", "message"],
    &["hidden", "instructions"],
    &["higher", "priority", "instruction"],
];

fn lower_words(text: &str) -> Vec<String> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn has_phrase(words: &[String], phrase: &[&str]) -> bool {
    words
        .windows(phrase.len())
        .any(|window| window.iter().map(String::as_str).eq(phrase.iter().copied()))
}

/// Whether a word from each set occurs within `limit` words of the other, in either order.
fn near(words: &[String], first: &[&str], second: &[&str], limit: usize) -> bool {
    let at = |set: &[&str]| -> Vec<usize> {
        words
            .iter()
            .enumerate()
            .filter(|(_, word)| set.contains(&word.as_str()))
            .map(|(index, _)| index)
            .collect()
    };
    let a = at(first);
    let b = at(second);
    a.iter().any(|i| b.iter().any(|j| i.abs_diff(*j) <= limit))
}

/// What stops an install, in plain sentences the person reads instead of a card.
pub fn blocking_reason(result: &ScanResult) -> String {
    let reasons: Vec<&str> = result
        .findings
        .iter()
        .filter(|f| f.severity == Severity::Block)
        .map(|f| f.message.as_str())
        .collect();
    if reasons.is_empty() {
        return String::new();
    }
    format!("{} Nothing was installed.", reasons.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_path_is_read_with_both_separators() {
        assert!(!escapes("a/b/c.txt"));
        assert!(!escapes("a\\b\\c.txt"));
        assert!(!escapes("..a/c.txt"));
        assert!(escapes("../x"));
        assert!(escapes("a/../x"));
        assert!(escapes("a\\..\\x"));
        assert!(escapes("/etc/passwd"));
        assert!(escapes("C:\\Windows"));
        assert!(escapes("c:relative"));
        assert!(escapes(""));
    }

    #[test]
    fn a_suffix_is_read_after_the_last_separator() {
        assert_eq!(suffix("a/b.TS"), "ts");
        assert_eq!(suffix("a\\.env"), "");
        assert_eq!(suffix("noext"), "");
        assert_eq!(suffix("a/.hidden"), "");
    }

    #[test]
    fn wording_is_read_as_lowercase_words() {
        let words = lower_words("Send an API key to the server.");
        assert!(near(&words, CREDENTIAL_WORDS, KEY_NOUNS, 1));
        assert!(near(&words, EXFILTRATE_VERBS, SECRET_NOUNS, 12));
        let quiet = lower_words("Read the file and summarize it.");
        assert!(!near(&quiet, CREDENTIAL_WORDS, KEY_NOUNS, 1));
        assert!(has_phrase(
            &lower_words("Then ignore previous instructions."),
            &["ignore", "previous"]
        ));
    }
}
