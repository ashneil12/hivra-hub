//! The Agent Plugins 1.0.0 loader (WP-30, https://agent-plugins.org/specification): `plugin.json`, `skills/` and
//! `mcp.json`, with the standard's failure boundaries. A broken manifest rejects the plugin; anything narrower (one
//! skill, `mcp.json`, one server, an unknown field) is reported and skipped while the rest loads.
//!
//! Nothing here runs plugin code: loading only reads files.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::fsutil::canonical;
use super::hivra::{self, HivraContributions};
use super::mcp::{self, McpServer};

/// The one Agent Plugins version this client implements.
pub const PLUGIN_SCHEMA_1_0_0: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/// The closed set of top-level manifest fields (§5.2).
const MANIFEST_FIELDS: [&str; 10] = [
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
];

/// Something the loader skipped or ignored, said plainly (the standard's "SHOULD report").
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The file or folder it is about, relative to the plugin root.
    pub path: String,
    pub message: String,
}

impl Report {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: Option<String>,
    pub email: Option<String>,
    pub url: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub author: Option<Author>,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub license: Option<String>,
    pub keywords: Vec<String>,
    /// Client data keyed by reverse-domain namespace; only objects are kept (§8.1).
    pub extensions: BTreeMap<String, Value>,
}

/// One skill under `skills/<name>/SKILL.md`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginSkill {
    pub name: String,
    pub description: String,
    /// The skill's folder, relative to the plugin root (`skills/<name>`).
    pub dir: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPlugin {
    /// The filesystem-resolved plugin root.
    pub root: PathBuf,
    pub manifest: Manifest,
    pub skills: Vec<PluginSkill>,
    pub mcp_servers: Vec<McpServer>,
    pub hivra: HivraContributions,
    pub reports: Vec<Report>,
}

/// Why a plugin was rejected as a whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected(pub String);

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Load a plugin from its folder. `Err` only for what the standard makes fatal: no readable `plugin.json` inside the
/// root, or a manifest that breaks its schema (other than unknown fields or a non-object `extensions`).
pub fn load_plugin(root: &Path) -> Result<LoadedPlugin, Rejected> {
    let root =
        canonical(root).map_err(|e| Rejected(format!("The plugin folder can't be read: {e}")))?;
    if !root.is_dir() {
        return Err(Rejected("The plugin isn't a folder.".into()));
    }
    let mut reports = Vec::new();
    let manifest_path = within(&root, &root.join("plugin.json"))
        .ok_or_else(|| Rejected("plugin.json is missing or points outside the plugin.".into()))?;
    if !manifest_path.is_file() {
        return Err(Rejected("plugin.json isn't a file.".into()));
    }
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| Rejected(format!("plugin.json can't be read: {e}")))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| Rejected(format!("plugin.json isn't valid JSON: {e}")))?;
    let manifest = parse_manifest(&value, &mut reports)?;

    let skills = discover_skills(&root, &mut reports);
    let mcp_servers = mcp::load_mcp(&root, &mut reports);
    let hivra = hivra::load(&root, &mut reports);
    Ok(LoadedPlugin {
        root,
        manifest,
        skills,
        mcp_servers,
        hivra,
        reports,
    })
}

/// A path that resolves inside the (already resolved) plugin root, or `None` (§4.1). A missing path resolves to
/// itself when its parent is inside.
pub(crate) fn within(root: &Path, path: &Path) -> Option<PathBuf> {
    let resolved = match canonical(path) {
        Ok(resolved) => resolved,
        Err(_) => {
            let parent = canonical(path.parent()?).ok()?;
            parent.join(path.file_name()?)
        }
    };
    resolved.starts_with(root).then_some(resolved)
}

fn opt_string(object: &Map<String, Value>, field: &str) -> Result<Option<String>, Rejected> {
    match object.get(field) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(Rejected(format!("plugin.json: \"{field}\" must be text."))),
    }
}

pub(crate) fn parse_manifest(
    value: &Value,
    reports: &mut Vec<Report>,
) -> Result<Manifest, Rejected> {
    let object = value
        .as_object()
        .ok_or_else(|| Rejected("plugin.json must be a JSON object.".into()))?;
    for key in object.keys() {
        if !MANIFEST_FIELDS.contains(&key.as_str()) {
            reports.push(Report::new(
                "plugin.json",
                format!("Ignored the unknown field \"{key}\"."),
            ));
        }
    }
    match object.get("$schema") {
        Some(Value::String(schema)) if schema == PLUGIN_SCHEMA_1_0_0 => {}
        Some(Value::String(schema)) if !schema.is_empty() => {
            return Err(Rejected(format!(
                "plugin.json targets an Agent Plugins version Hivra doesn't support ({schema})."
            )))
        }
        _ => {
            return Err(Rejected(
                "plugin.json: \"$schema\" is missing or not text.".into(),
            ))
        }
    }
    let name = match object.get("name") {
        Some(Value::String(name)) => name.clone(),
        _ => {
            return Err(Rejected(
                "plugin.json: \"name\" is missing or not text.".into(),
            ))
        }
    };
    if let Some(why) = plugin_name_problem(&name) {
        return Err(Rejected(format!("plugin.json: the name \"{name}\" {why}.")));
    }
    let author = match object.get("author") {
        None => None,
        Some(Value::Object(author)) => {
            let mut out = Author::default();
            for (key, value) in author {
                let Value::String(text) = value else {
                    return Err(Rejected(format!("plugin.json: author.{key} must be text.")));
                };
                match key.as_str() {
                    "name" => out.name = Some(text.clone()),
                    "email" => out.email = Some(text.clone()),
                    "url" => out.url = Some(text.clone()),
                    _ => {
                        return Err(Rejected(format!(
                            "plugin.json: author may only have name, email and url, not \"{key}\"."
                        )))
                    }
                }
            }
            Some(out)
        }
        Some(_) => {
            return Err(Rejected(
                "plugin.json: \"author\" must be an object.".into(),
            ))
        }
    };
    let keywords = match object.get("keywords") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| Rejected("plugin.json: every keyword must be text.".into()))
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(Rejected("plugin.json: \"keywords\" must be a list.".into())),
    };
    let mut extensions = BTreeMap::new();
    match object.get("extensions") {
        None => {}
        Some(Value::Object(map)) => {
            for (namespace, data) in map {
                if data.is_object() {
                    extensions.insert(namespace.clone(), data.clone());
                } else if namespace == hivra::NAMESPACE {
                    // Unknown namespaces are ignored unvalidated (§8.1); our own must be an object.
                    reports.push(Report::new(
                        "plugin.json",
                        format!("Ignored extensions.{namespace}: it must be an object."),
                    ));
                }
            }
        }
        Some(_) => reports.push(Report::new(
            "plugin.json",
            "Ignored \"extensions\": it must be an object.",
        )),
    }
    Ok(Manifest {
        name,
        version: opt_string(object, "version")?,
        description: opt_string(object, "description")?,
        author,
        homepage: opt_string(object, "homepage")?,
        repository: opt_string(object, "repository")?,
        license: opt_string(object, "license")?,
        keywords,
        extensions,
    })
}

/// §5.5: 1-64 of `a-z 0-9 - .`, alphanumeric at both ends, no `--` or `..`.
pub fn plugin_name_problem(name: &str) -> Option<&'static str> {
    if name.is_empty() || name.chars().count() > 64 {
        return Some("must be 1 to 64 characters");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
    {
        return Some("may only use lowercase letters, digits, hyphens and periods");
    }
    let alnum = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
    if !alnum(name.chars().next()) || !alnum(name.chars().last()) {
        return Some("must start and end with a letter or digit");
    }
    if name.contains("--") || name.contains("..") {
        return Some("can't contain \"--\" or \"..\"");
    }
    None
}

/// The Agent Skills name rule: 1-64 of `a-z 0-9 -`, no hyphen at either end, no `--`.
pub fn skill_name_problem(name: &str) -> Option<&'static str> {
    if name.is_empty() || name.chars().count() > 64 {
        return Some("must be 1 to 64 characters");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Some("may only use lowercase letters, digits and hyphens");
    }
    if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return Some("can't start or end with a hyphen or contain \"--\"");
    }
    None
}

/// A Markdown file split into its frontmatter block (between the opening `---` and the closing one) and the body
/// after the closing line, or `None` when there is no complete block.
pub(crate) fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start_matches('\u{feff}');
    let rest = text.strip_prefix("---")?;
    let rest = rest.strip_prefix('\r').unwrap_or(rest);
    let rest = rest.strip_prefix('\n')?;
    let end = if rest.starts_with("---") {
        0
    } else {
        rest.find("\n---")? + 1
    };
    let after = &rest[end + 3..];
    let body = match after.find('\n') {
        Some(at) => &after[at + 1..],
        None => "",
    };
    Some((&rest[..end], body))
}

/// `name` and `description` from a Markdown file's frontmatter, using the skills scanner's YAML reading
/// (`skills.rs`). `None` when the file has no frontmatter block.
pub(crate) fn name_and_description(text: &str) -> Option<(String, String)> {
    split_frontmatter(text)?;
    Some(crate::skills::parse_frontmatter(text, ""))
}

/// §6, §7.1: immediate children of `skills/` holding a regular `SKILL.md`; a skill that breaks the Agent Skills
/// rules is skipped and reported, its siblings load.
fn discover_skills(root: &Path, reports: &mut Vec<Report>) -> Vec<PluginSkill> {
    let dir = root.join("skills");
    if std::fs::symlink_metadata(&dir).is_err() {
        return Vec::new();
    }
    let Some(dir) = within(root, &dir) else {
        reports.push(Report::new(
            "skills",
            "Skipped all skills: skills/ points outside the plugin.",
        ));
        return Vec::new();
    };
    if !dir.is_dir() {
        reports.push(Report::new(
            "skills",
            "Skipped all skills: skills isn't a folder.",
        ));
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        reports.push(Report::new(
            "skills",
            "Skipped all skills: skills/ can't be read.",
        ));
        return Vec::new();
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    let mut out = Vec::new();
    for entry in entries {
        let folder = entry.file_name().to_string_lossy().into_owned();
        let rel = format!("skills/{folder}");
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if std::fs::symlink_metadata(&skill_md).is_err() {
            continue;
        }
        let Some(skill_md) = within(root, &skill_md) else {
            reports.push(Report::new(
                &rel,
                "Skipped: SKILL.md points outside the plugin.",
            ));
            continue;
        };
        if within(root, &path).is_none() {
            reports.push(Report::new(
                &rel,
                "Skipped: the folder points outside the plugin.",
            ));
            continue;
        }
        if !skill_md.is_file() {
            continue;
        }
        match check_skill(&skill_md, &folder) {
            Ok((name, description)) => out.push(PluginSkill {
                name,
                description,
                dir: rel,
            }),
            Err(why) => reports.push(Report::new(&rel, format!("Skipped: {why}"))),
        }
    }
    out
}

/// The Agent Skills checks that matter for loading: frontmatter, a valid `name` equal to the folder, a
/// `description` of 1-1024 characters.
/// Frontmatter keys a skill-only plugin may not carry: Claude Code runs `hooks` as shell commands in the session, and
/// `allowed-tools` pre-approves tools while the skill is in use. A plugin's skills are instructions, nothing more.
const REFUSED_SKILL_KEYS: &[&str] = &["hooks", "allowed-tools", "allowed_tools", "allowedtools"];

/// Why a skill's frontmatter asks for more than instructions, if it does. Only the plainest YAML passes: every line
/// that isn't blank or a comment is either a top-level `key:` in column 0 whose key is letters, digits, `-` and `_`,
/// or an indented line under such a key. So a key can't arrive escaped (`"hoo\x6bs"`), tagged (`!!str hooks`),
/// aliased (`*k :`), merged (`<<:`), as a flow map, or from a block indented as a whole; then the key itself is checked.
pub(crate) fn agent_power_problem(front: &str) -> Option<String> {
    let mut seen_key = false;
    for line in front.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.len() != line.len() {
            if !seen_key {
                return Some(
                    "its frontmatter starts indented; keys must start in the first column.".into(),
                );
            }
            continue;
        }
        let key = plain_key(line).ok_or_else(|| {
            "its frontmatter has a line that isn't a plain \"key: value\" (letters, digits, - and _ only).".to_string()
        });
        let key = match key {
            Ok(key) => key.to_ascii_lowercase(),
            Err(why) => return Some(why),
        };
        seen_key = true;
        if REFUSED_SKILL_KEYS.contains(&key.as_str()) {
            return Some(format!(
                "it sets \"{key}\", which would let it run commands or approve tools; plugin skills can't."
            ));
        }
    }
    None
}

/// `key` from a column-0 `key:` line (`^[A-Za-z0-9_-]+\s*:`), followed by a space, a tab or nothing.
fn plain_key(line: &str) -> Option<&str> {
    let end = line
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .unwrap_or(line.len());
    let key = &line[..end];
    let rest = line[end..].trim_start_matches([' ', '\t']);
    let after = rest.strip_prefix(':')?;
    (!key.is_empty() && (after.is_empty() || after.starts_with([' ', '\t']))).then_some(key)
}

fn check_skill(skill_md: &Path, folder: &str) -> Result<(String, String), String> {
    let text = std::fs::read_to_string(skill_md)
        .map_err(|_| "SKILL.md isn't readable text.".to_string())?;
    let (name, description) =
        name_and_description(&text).ok_or("SKILL.md has no frontmatter block.")?;
    if let Some((front, _)) = split_frontmatter(&text) {
        if let Some(why) = agent_power_problem(front) {
            return Err(why);
        }
    }
    if name.is_empty() {
        return Err("SKILL.md has no valid name.".into());
    }
    if let Some(why) = skill_name_problem(&name) {
        return Err(format!("the skill name \"{name}\" {why}."));
    }
    if name != folder {
        return Err(format!(
            "the skill is named \"{name}\" but its folder is \"{folder}\"."
        ));
    }
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err("SKILL.md has no description.".into());
    }
    if description.chars().count() > 1024 {
        return Err("the description is longer than 1024 characters.".into());
    }
    Ok((name, description))
}
