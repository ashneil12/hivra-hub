//! Hivra's own extension folder in a plugin (Agent Plugins §8.2): what only Hivra understands. One validator per
//! type; a broken item is reported and skipped, its siblings load.
//!
//! ```text
//! my-plugin/hivra/
//! ├── panels/<id>/panel.json     a dashboard (WP-33): a Page spec, plus index.html for a bespoke one
//! ├── personas/<id>.md           a council persona (WP-23), council-of-high-intelligence's file format
//! ├── monos/<id>/mono.json       a Mono template (WP-05) with its SOUL.md beside it
//! ├── crew-rules.json            default crew rules (WP-13), beneath the person's own
//! └── commands/<name>.md         a slash command: a prompt file
//! ```

use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};

use super::manifest::{
    name_and_description, skill_name_problem, split_frontmatter, within, Report,
};

/// The extension namespace. The standard asks for a reverse-domain name; until Ash confirms Hivra's domain this is
/// the plain placeholder the WP-30 spec names. Change it here only (the folder and `extensions.<namespace>` follow).
pub const NAMESPACE: &str = "hivra";

/// What a Page may ask for (src/features/pages/model/pageSpec.ts `CAPABILITIES`; a test keeps the two equal).
pub const PANEL_PERMISSIONS: [&str; 17] = [
    "agents.read",
    "jobs.read",
    "needs.read",
    "rooms.read",
    "tasks.read",
    "project.read",
    "settings.read",
    "agents.answer",
    "agents.pick",
    "agents.message",
    "agents.stop",
    "chats.open",
    "tasks.write",
    "project.write",
    "mono.run",
    "automation.run",
    "settings.write",
];

/// The block kinds a blocks Page can hold (pageSpec.ts `BLOCK_KINDS`).
pub const PANEL_BLOCK_KINDS: [&str; 6] = ["status", "list", "chart", "barlist", "note", "calendar"];

/// The agent CLIs a crew rule can name (the providers in src/integrations/harness/providers).
pub const CREW_CLIS: [&str; 11] = [
    "claude",
    "codex",
    "cursor",
    "opencode",
    "pi",
    "omp",
    "fx",
    "grok",
    "hermes",
    "devin",
    "antigravity",
];

pub const CREW_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    pub id: String,
    pub title: String,
    /// `blocks` or `bespoke`.
    pub kind: String,
    pub permissions: Vec<String>,
    /// Relative to the plugin root.
    pub dir: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Persona {
    pub id: String,
    pub description: String,
    pub file: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonoTemplate {
    pub id: String,
    pub name: String,
    pub role: Option<String>,
    pub skills: Vec<String>,
    pub crew_rules: Vec<CrewRule>,
    pub dir: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CrewRule {
    pub labels: Vec<String>,
    pub paths: Vec<String>,
    pub cli: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub name: String,
    pub description: String,
    pub file: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HivraContributions {
    pub panels: Vec<Panel>,
    pub personas: Vec<Persona>,
    pub monos: Vec<MonoTemplate>,
    pub crew_rules: Vec<CrewRule>,
    pub commands: Vec<Command>,
}

impl HivraContributions {
    pub fn is_empty(&self) -> bool {
        self.panels.is_empty()
            && self.personas.is_empty()
            && self.monos.is_empty()
            && self.crew_rules.is_empty()
            && self.commands.is_empty()
    }
}

const KNOWN: [&str; 5] = ["panels", "personas", "monos", "crew-rules.json", "commands"];

pub fn load(root: &Path, reports: &mut Vec<Report>) -> HivraContributions {
    let mut out = HivraContributions::default();
    let dir = root.join(NAMESPACE);
    if std::fs::symlink_metadata(&dir).is_err() {
        return out;
    }
    let Some(dir) = within(root, &dir).filter(|d| d.is_dir()) else {
        reports.push(Report::new(
            NAMESPACE,
            "Ignored the Hivra folder: it isn't a folder inside the plugin.",
        ));
        return out;
    };
    for entry in sorted(&dir) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !KNOWN.contains(&name.as_str()) && !name.starts_with('.') {
            reports.push(Report::new(
                format!("{NAMESPACE}/{name}"),
                "Ignored: Hivra doesn't know this.",
            ));
        }
    }
    each_child(
        root,
        &dir.join("panels"),
        "panels",
        reports,
        |path, id, rel, reports| {
            if !path.is_dir() {
                return;
            }
            match check_panel(root, path, id) {
                Ok(panel) => out.panels.push(Panel {
                    dir: rel.to_string(),
                    ..panel
                }),
                Err(why) => reports.push(Report::new(rel, format!("Skipped this panel: {why}"))),
            }
        },
    );
    each_child(
        root,
        &dir.join("personas"),
        "personas",
        reports,
        |path, file, rel, reports| {
            let Some(id) = file.strip_suffix(".md") else {
                return;
            };
            if !path.is_file() {
                return;
            }
            match check_persona(path, id) {
                Ok(description) => out.personas.push(Persona {
                    id: id.to_string(),
                    description,
                    file: rel.to_string(),
                }),
                Err(why) => reports.push(Report::new(rel, format!("Skipped this persona: {why}"))),
            }
        },
    );
    each_child(
        root,
        &dir.join("monos"),
        "monos",
        reports,
        |path, id, rel, reports| {
            if !path.is_dir() {
                return;
            }
            match check_mono(root, path, id) {
                Ok(mono) => out.monos.push(MonoTemplate {
                    dir: rel.to_string(),
                    ..mono
                }),
                Err(why) => reports.push(Report::new(
                    rel,
                    format!("Skipped this Mono template: {why}"),
                )),
            }
        },
    );
    let rules = dir.join("crew-rules.json");
    let rules_rel = format!("{NAMESPACE}/crew-rules.json");
    if std::fs::symlink_metadata(&rules).is_ok() {
        match within(root, &rules).filter(|p| p.is_file()) {
            Some(rules) => out.crew_rules = check_crew_rules_file(&rules, &rules_rel, reports),
            None => reports.push(Report::new(
                &rules_rel,
                "Skipped: it isn't a file inside the plugin.",
            )),
        }
    }
    each_child(
        root,
        &dir.join("commands"),
        "commands",
        reports,
        |path, file, rel, reports| {
            let Some(name) = file.strip_suffix(".md") else {
                return;
            };
            if !path.is_file() {
                return;
            }
            match check_command(path, name) {
                Ok(description) => out.commands.push(Command {
                    name: name.to_string(),
                    description,
                    file: rel.to_string(),
                }),
                Err(why) => reports.push(Report::new(rel, format!("Skipped this command: {why}"))),
            }
        },
    );
    out
}

fn sorted(dir: &Path) -> Vec<std::fs::DirEntry> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .collect();
    entries.sort_by_key(|e| e.file_name());
    entries
}

/// Visit each child of `<namespace>/<kind>/` that resolves inside the plugin.
fn each_child(
    root: &Path,
    dir: &Path,
    kind: &str,
    reports: &mut Vec<Report>,
    mut visit: impl FnMut(&Path, &str, &str, &mut Vec<Report>),
) {
    if std::fs::symlink_metadata(dir).is_err() {
        return;
    }
    let rel_dir = format!("{NAMESPACE}/{kind}");
    let Some(dir) = within(root, dir).filter(|d| d.is_dir()) else {
        reports.push(Report::new(
            &rel_dir,
            "Skipped: it isn't a folder inside the plugin.",
        ));
        return;
    };
    for entry in sorted(&dir) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let rel = format!("{rel_dir}/{name}");
        match within(root, &entry.path()) {
            Some(path) => visit(&path, &name, &rel, reports),
            None => reports.push(Report::new(&rel, "Skipped: it points outside the plugin.")),
        }
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|_| "it can't be read.".to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("it isn't valid JSON ({e})."))
}

fn closed(object: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), String> {
    match object.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(key) => Err(format!("\"{key}\" isn't a field of {what}.")),
        None => Ok(()),
    }
}

fn text_field(object: &Map<String, Value>, key: &str, max: usize) -> Result<String, String> {
    match object.get(key).and_then(Value::as_str).map(str::trim) {
        Some(text) if !text.is_empty() && text.chars().count() <= max => Ok(text.to_string()),
        _ => Err(format!("\"{key}\" must be text of 1 to {max} characters.")),
    }
}

fn string_list(value: Option<&Value>, key: &str) -> Result<Vec<String>, String> {
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
                    .ok_or(format!("every \"{key}\" entry must be text."))
            })
            .collect(),
        Some(_) => Err(format!("\"{key}\" must be a list.")),
    }
}

fn check_id(id: &str) -> Result<(), String> {
    match skill_name_problem(id) {
        Some(why) => Err(format!("its id \"{id}\" {why}.")),
        None => Ok(()),
    }
}

/// A panel is the Pages spec (pageSpec.ts) in `panel.json`; a bespoke panel keeps its HTML in `index.html` (and
/// optional `style.css` / `script.js`) beside it instead of inline.
pub fn check_panel(root: &Path, dir: &Path, id: &str) -> Result<Panel, String> {
    check_id(id)?;
    let spec = within(root, &dir.join("panel.json"))
        .filter(|p| p.is_file())
        .ok_or("panel.json is missing.")?;
    let value = read_json(&spec).map_err(|why| format!("panel.json: {why}"))?;
    let object = value.as_object().ok_or("panel.json must be an object.")?;
    let title = text_field(object, "title", 80)?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "blocks" => {
            closed(object, &["kind", "title", "blocks"], "a blocks panel")?;
            let blocks = object
                .get("blocks")
                .and_then(Value::as_array)
                .filter(|b| !b.is_empty() && b.len() <= 12)
                .ok_or("a blocks panel needs 1 to 12 blocks.")?;
            for block in blocks {
                let block_kind = block
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !PANEL_BLOCK_KINDS.contains(&block_kind) {
                    return Err(format!("\"{block_kind}\" isn't a block kind Hivra has."));
                }
                if block
                    .get("title")
                    .and_then(Value::as_str)
                    .is_none_or(|t| t.trim().is_empty())
                {
                    return Err(format!("a {block_kind} block has no title."));
                }
            }
            Ok(Panel {
                id: id.to_string(),
                title,
                kind: kind.to_string(),
                permissions: Vec::new(),
                dir: String::new(),
            })
        }
        "bespoke" => {
            closed(object, &["kind", "title", "permissions"], "a bespoke panel")?;
            within(root, &dir.join("index.html"))
                .filter(|p| p.is_file())
                .ok_or("a bespoke panel needs index.html beside panel.json.")?;
            for optional in ["style.css", "script.js"] {
                let path = dir.join(optional);
                if std::fs::symlink_metadata(&path).is_ok() && within(root, &path).is_none() {
                    return Err(format!("{optional} points outside the plugin."));
                }
            }
            let permissions = string_list(object.get("permissions"), "permissions")?;
            if permissions.len() > 30 {
                return Err("a panel can ask for at most 30 permissions.".into());
            }
            for permission in &permissions {
                if !PANEL_PERMISSIONS.contains(&permission.as_str()) {
                    return Err(format!(
                        "\"{permission}\" isn't a permission a panel can ask for."
                    ));
                }
            }
            let mut permissions = permissions;
            permissions.dedup();
            Ok(Panel {
                id: id.to_string(),
                title,
                kind: kind.to_string(),
                permissions,
                dir: String::new(),
            })
        }
        _ => Err("panel.json's \"kind\" must be \"blocks\" or \"bespoke\".".into()),
    }
}

/// The body of a Markdown file after its frontmatter (all of it when there is none).
fn body_after_frontmatter(text: &str) -> &str {
    split_frontmatter(text).map_or(text, |(_, body)| body)
}

/// A council persona (council-of-high-intelligence's format): frontmatter with `name` equal to the file name and a
/// `description`, then the persona's text. Extra frontmatter (model, council: …) is kept for WP-23 to read.
pub fn check_persona(path: &Path, id: &str) -> Result<String, String> {
    check_id(id)?;
    let text = std::fs::read_to_string(path).map_err(|_| "it isn't readable text.".to_string())?;
    let (name, description) = name_and_description(&text).ok_or("it has no frontmatter block.")?;
    if name != id {
        return Err(format!("its name must be \"{id}\", the file's name."));
    }
    if description.is_empty() {
        return Err("it has no description.".into());
    }
    if body_after_frontmatter(&text).trim().is_empty() {
        return Err("it has no persona text after the frontmatter.".into());
    }
    Ok(description)
}

/// A Mono template: `mono.json` (name, optional role, skills, crew rules) and a non-empty `SOUL.md`.
pub fn check_mono(root: &Path, dir: &Path, id: &str) -> Result<MonoTemplate, String> {
    check_id(id)?;
    let soul = within(root, &dir.join("SOUL.md"))
        .filter(|p| p.is_file())
        .ok_or("SOUL.md is missing.")?;
    let soul =
        std::fs::read_to_string(soul).map_err(|_| "SOUL.md isn't readable text.".to_string())?;
    if soul.trim().is_empty() {
        return Err("SOUL.md is empty.".into());
    }
    let spec = within(root, &dir.join("mono.json"))
        .filter(|p| p.is_file())
        .ok_or("mono.json is missing.")?;
    let value = read_json(&spec).map_err(|why| format!("mono.json: {why}"))?;
    let object = value.as_object().ok_or("mono.json must be an object.")?;
    closed(
        object,
        &["name", "role", "skills", "crewRules", "habits"],
        "mono.json",
    )?;
    let name = text_field(object, "name", 60)?;
    let role = match object.get("role") {
        None => None,
        Some(_) => Some(text_field(object, "role", 200)?),
    };
    let skills = string_list(object.get("skills"), "skills")?;
    if let Some(bad) = skills.iter().find(|s| skill_name_problem(s).is_some()) {
        return Err(format!("\"{bad}\" isn't a skill name."));
    }
    let crew_rules = match object.get("crewRules") {
        None => Vec::new(),
        Some(Value::Array(rules)) => rules
            .iter()
            .map(check_crew_rule)
            .collect::<Result<_, _>>()
            .map_err(|why| format!("a crew rule: {why}"))?,
        Some(_) => return Err("\"crewRules\" must be a list.".into()),
    };
    match object.get("habits") {
        None => {}
        Some(Value::Array(habits)) => {
            for habit in habits {
                let habit = habit.as_object().ok_or("each habit must be an object.")?;
                closed(habit, &["title", "schedule", "prompt"], "a habit")?;
                for key in ["title", "schedule", "prompt"] {
                    text_field(habit, key, 4000).map_err(|why| format!("a habit: {why}"))?;
                }
            }
        }
        Some(_) => return Err("\"habits\" must be a list.".into()),
    }
    Ok(MonoTemplate {
        id: id.to_string(),
        name,
        role,
        skills,
        crew_rules,
        dir: String::new(),
    })
}

/// One crew rule: what it matches (labels the first mate sets, or paths) and at least one of a CLI, model or effort.
pub fn check_crew_rule(value: &Value) -> Result<CrewRule, String> {
    let object = value.as_object().ok_or("it must be an object.")?;
    closed(object, &["match", "cli", "model", "effort"], "a crew rule")?;
    let matcher = object
        .get("match")
        .and_then(Value::as_object)
        .ok_or("it needs a \"match\" object.")?;
    closed(matcher, &["labels", "paths"], "a rule's match")?;
    let labels = string_list(matcher.get("labels"), "labels")?;
    let paths = string_list(matcher.get("paths"), "paths")?;
    if labels.is_empty() && paths.is_empty() {
        return Err("it matches nothing: give labels or paths.".into());
    }
    let pick = |key: &str| -> Result<Option<String>, String> {
        match object.get(key) {
            None => Ok(None),
            Some(Value::String(v)) if !v.trim().is_empty() => Ok(Some(v.clone())),
            Some(_) => Err(format!("\"{key}\" must be text.")),
        }
    };
    let rule = CrewRule {
        labels,
        paths,
        cli: pick("cli")?,
        model: pick("model")?,
        effort: pick("effort")?,
    };
    if let Some(cli) = &rule.cli {
        if !CREW_CLIS.contains(&cli.as_str()) {
            return Err(format!("\"{cli}\" isn't an agent CLI Hivra drives."));
        }
    }
    if let Some(effort) = &rule.effort {
        if !CREW_EFFORTS.contains(&effort.as_str()) {
            return Err(format!("\"{effort}\" isn't an effort level."));
        }
    }
    if rule.cli.is_none() && rule.model.is_none() && rule.effort.is_none() {
        return Err("it picks nothing: give a cli, model or effort.".into());
    }
    Ok(rule)
}

/// `crew-rules.json`: `{ "rules": [...] }`. A broken file is skipped; a broken rule is skipped and the rest kept.
fn check_crew_rules_file(path: &Path, rel: &str, reports: &mut Vec<Report>) -> Vec<CrewRule> {
    let value = match read_json(path) {
        Ok(value) => value,
        Err(why) => {
            reports.push(Report::new(rel, format!("Skipped: {why}")));
            return Vec::new();
        }
    };
    let Some(object) = value.as_object() else {
        reports.push(Report::new(
            rel,
            "Skipped: it must be an object with \"rules\".",
        ));
        return Vec::new();
    };
    if let Err(why) = closed(object, &["rules"], "crew-rules.json") {
        reports.push(Report::new(rel, format!("Skipped: {why}")));
        return Vec::new();
    }
    let Some(rules) = object.get("rules").and_then(Value::as_array) else {
        reports.push(Report::new(rel, "Skipped: \"rules\" must be a list."));
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, rule) in rules.iter().enumerate() {
        match check_crew_rule(rule) {
            Ok(rule) => out.push(rule),
            Err(why) => reports.push(Report::new(
                rel,
                format!("Skipped rule {}: {why}", index + 1),
            )),
        }
    }
    out
}

/// A slash command: `commands/<name>.md`, a prompt with optional frontmatter (`description`).
pub fn check_command(path: &Path, name: &str) -> Result<String, String> {
    if let Some(why) = skill_name_problem(name) {
        return Err(format!("the command name \"{name}\" {why}."));
    }
    let text = std::fs::read_to_string(path).map_err(|_| "it isn't readable text.".to_string())?;
    if body_after_frontmatter(&text).trim().is_empty() {
        return Err("the prompt is empty.".into());
    }
    Ok(name_and_description(&text)
        .map(|(_, d)| d)
        .unwrap_or_default())
}
