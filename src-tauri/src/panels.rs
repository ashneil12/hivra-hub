//! Plugin panels (WP-33). A panel is a PageSpec in a plugin's `hivra/panels/` folder. The catalog re-reads those
//! files (they are untrusted) and only lists a plugin that is enabled. Kept pages migrate into a local `my-panels`
//! plugin, through the same install and update path as any other plugin, so an edit can be rolled back.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::{json, Value};

use crate::plugins::hivra::{check_panel, PANEL_BLOCK_KINDS, PANEL_PERMISSIONS};
use crate::plugins::manifest::{skill_name_problem, within, PLUGIN_SCHEMA_1_0_0};
use crate::plugins::registry::{self, Host, Scope, Source};
use crate::plugins::{update_plugin, InstallResult, InstallSource, RequestedBy, Tools};

pub const MY_PANELS: &str = "my-panels";
const DESCRIPTION: &str = "My panels";
static PANEL_TMP: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPanel {
    pub plugin: String,
    pub id: String,
    pub title: String,
    pub kind: String,
    pub permissions: Vec<String>,
    /// The page spec the sandbox renders. A bespoke panel's HTML, CSS and JS are read from its files.
    pub spec: Value,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub added: Vec<String>,
    pub skipped: Vec<String>,
}

struct NewPanel {
    id: String,
    panel_json: String,
    html: Option<String>,
    css: Option<String>,
    js: Option<String>,
}

/// Enabled plugins' panels, re-validated from disk. A plugin or a panel that doesn't load is skipped.
pub fn catalog(host: &Host) -> Result<Vec<CatalogPanel>, String> {
    let registry = registry::read(host)?;
    let mut out = Vec::new();
    for (name, entry) in &registry.plugins {
        if !entry.enabled.any() {
            continue;
        }
        let Ok(loaded) = crate::plugins::load_plugin(&host.installed(name)) else {
            continue;
        };
        for panel in &loaded.hivra.panels {
            let rel = if panel.dir.is_empty() {
                format!("hivra/panels/{}", panel.id)
            } else {
                panel.dir.clone()
            };
            if rel
                .split(['/', '\\'])
                .any(|part| part.is_empty() || part == "." || part == "..")
            {
                continue;
            }
            let dir = loaded.root.join(&rel);
            let Some(spec) = spec_value(&loaded.root, &dir, &panel.id) else {
                continue;
            };
            out.push(CatalogPanel {
                plugin: name.clone(),
                id: panel.id.clone(),
                title: panel.title.clone(),
                kind: panel.kind.clone(),
                permissions: panel.permissions.clone(),
                spec,
            });
        }
    }
    Ok(out)
}

fn spec_value(root: &Path, dir: &Path, id: &str) -> Option<Value> {
    let panel = check_panel(root, dir, id).ok()?;
    let spec_path = within(root, &dir.join("panel.json"))?;
    let mut value: Value = serde_json::from_str(&std::fs::read_to_string(spec_path).ok()?).ok()?;
    if panel.kind == "bespoke" {
        let html = read_inside(root, &dir.join("index.html"))?;
        let obj = value.as_object_mut()?;
        obj.insert("html".into(), Value::String(html));
        if let Some(css) = read_inside(root, &dir.join("style.css")) {
            obj.insert("css".into(), Value::String(css));
        }
        if let Some(js) = read_inside(root, &dir.join("script.js")) {
            obj.insert("js".into(), Value::String(js));
        }
    }
    Some(value)
}

/// A regular file inside the plugin. A symlink is refused, so a link can't be followed out.
fn read_inside(root: &Path, path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let path = within(root, path)?;
    std::fs::read_to_string(path).ok()
}

/// Move kept pages into the local My panels plugin. Pages that aren't kept, or that don't validate, are skipped.
/// An existing panel file is left as it is. Nothing is written into `installed/` except through install and update.
pub fn migrate(host: &Host, tools: &Tools, pages: &Value) -> Result<MigrateReport, String> {
    let source = host.root.join("sources").join(MY_PANELS);
    std::fs::create_dir_all(&source).map_err(|e| e.to_string())?;
    seed(host, &source)?;
    let source = crate::fs::canonical(&source).map_err(|e| e.to_string())?;
    let on_disk = existing_ids(&source);
    let mut batch = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut added = Vec::new();
    let mut skipped = Vec::new();
    let empty = Vec::new();
    let list = pages.as_array().unwrap_or(&empty);
    for page in list {
        let source_id = page
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match new_panel(page, &on_disk, &batch, &mut seen) {
            PanelStep::Skip => skipped.push(source_id),
            PanelStep::Add(panel) => {
                let id = panel.id.clone();
                match write_panel(&source, &panel) {
                    Ok(true) => {
                        batch.insert(id.clone());
                        added.push(id);
                    }
                    Ok(false) => skipped.push(source_id),
                    Err(why) => return Err(why),
                }
            }
        }
    }
    if !has_panel(&source) {
        return Ok(MigrateReport { added, skipped });
    }
    if !source.join("plugin.json").is_file() {
        write_new(
            &source,
            &source.join("plugin.json"),
            plugin_json()?.as_bytes(),
        )?;
    }
    put(host, tools, &source, &added)?;
    Ok(MigrateReport { added, skipped })
}

enum PanelStep {
    Add(NewPanel),
    Skip,
}

fn new_panel(
    page: &Value,
    on_disk: &BTreeSet<String>,
    batch: &BTreeSet<String>,
    seen: &mut BTreeSet<String>,
) -> PanelStep {
    let Some(obj) = page.as_object() else {
        return PanelStep::Skip;
    };
    if obj.get("removed").and_then(Value::as_bool).unwrap_or(false) || !kept_at(obj.get("keptAt")) {
        return PanelStep::Skip;
    }
    let Some(source_id) = obj.get("id").and_then(Value::as_str) else {
        return PanelStep::Skip;
    };
    if source_id.is_empty() || !seen.insert(source_id.to_string()) {
        return PanelStep::Skip;
    }
    let Some(base) = base_id(source_id) else {
        return PanelStep::Skip;
    };
    // A folder already on disk is an earlier migrate or an edit. Leave it, and don't file this page beside it.
    if on_disk.contains(&base) {
        return PanelStep::Skip;
    }
    let Some(id) = free_id(&base, on_disk, batch) else {
        return PanelStep::Skip;
    };
    let Some(spec) = obj.get("spec").and_then(Value::as_object) else {
        return PanelStep::Skip;
    };
    let Some(title) = spec.get("title").and_then(Value::as_str).map(str::trim) else {
        return PanelStep::Skip;
    };
    if title.is_empty() || title.chars().count() > 80 {
        return PanelStep::Skip;
    }
    match spec.get("kind").and_then(Value::as_str) {
        Some("blocks") => {
            let Some(blocks) = spec.get("blocks").and_then(Value::as_array) else {
                return PanelStep::Skip;
            };
            if blocks.is_empty() || blocks.len() > 12 || !blocks.iter().all(block_ok) {
                return PanelStep::Skip;
            }
            let panel_json =
                json!({ "kind": "blocks", "title": title, "blocks": blocks }).to_string();
            PanelStep::Add(NewPanel {
                id,
                panel_json,
                html: None,
                css: None,
                js: None,
            })
        }
        Some("bespoke") => {
            let Some(html) = spec.get("html").and_then(Value::as_str) else {
                return PanelStep::Skip;
            };
            if html.is_empty() || html.len() > 200_000 {
                return PanelStep::Skip;
            }
            let Some(permissions) = granted(obj, spec) else {
                return PanelStep::Skip;
            };
            let css = spec
                .get("css")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let js = spec
                .get("js")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            if spec
                .get("css")
                .is_some_and(|v| !v.is_string() && !v.is_null())
                || spec
                    .get("js")
                    .is_some_and(|v| !v.is_string() && !v.is_null())
            {
                return PanelStep::Skip;
            }
            let panel_json =
                json!({ "kind": "bespoke", "title": title, "permissions": permissions })
                    .to_string();
            PanelStep::Add(NewPanel {
                id,
                panel_json,
                html: Some(html.to_string()),
                css,
                js,
            })
        }
        _ => PanelStep::Skip,
    }
}

fn kept_at(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0),
        _ => false,
    }
}

fn block_ok(block: &Value) -> bool {
    let Some(obj) = block.as_object() else {
        return false;
    };
    let kind = obj.get("kind").and_then(Value::as_str).unwrap_or("");
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    PANEL_BLOCK_KINDS.contains(&kind) && !title.is_empty()
}

/// Grants are the page's approved list, and only the ones its spec also asks for. A missing list approves nothing.
/// A list that isn't permissions is refused, so the spec's asks are never installed in its place.
fn granted(
    page: &serde_json::Map<String, Value>,
    spec: &serde_json::Map<String, Value>,
) -> Option<Vec<String>> {
    let asks = permissions_of(spec.get("permissions"))?;
    let approved = match page.get("permissions") {
        None => Vec::new(),
        Some(value) => permissions_of(Some(value))?,
    };
    Some(
        approved
            .into_iter()
            .filter(|item| asks.iter().any(|ask| ask == item))
            .collect(),
    )
}

fn permissions_of(value: Option<&Value>) -> Option<Vec<String>> {
    let list = value?.as_array()?;
    if list.len() > 30 {
        return None;
    }
    let mut out = Vec::new();
    for item in list {
        let text = item.as_str()?;
        if !PANEL_PERMISSIONS.contains(&text) {
            return None;
        }
        if !out.iter().any(|known| known == text) {
            out.push(text.to_string());
        }
    }
    Some(out)
}

/// A page id as a folder name, before another page in this batch has taken it. A path is refused.
fn base_id(raw: &str) -> Option<String> {
    if raw.contains("..") || raw.contains('/') || raw.contains('\\') || raw.contains('\0') {
        return None;
    }
    let mut base = String::new();
    let mut dash = false;
    for ch in raw.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            base.push(ch);
            dash = false;
        } else if !dash && !base.is_empty() {
            base.push('-');
            dash = true;
        }
    }
    while base.ends_with('-') {
        base.pop();
    }
    if base.chars().count() > 64 {
        base = base.chars().take(64).collect();
        while base.ends_with('-') {
            base.pop();
        }
    }
    if skill_name_problem(&base).is_some() {
        None
    } else {
        Some(base)
    }
}

fn free_id(base: &str, on_disk: &BTreeSet<String>, batch: &BTreeSet<String>) -> Option<String> {
    if !on_disk.contains(base) && !batch.contains(base) {
        return Some(base.to_string());
    }
    for n in 2..100 {
        let suffix = format!("-{n}");
        let mut cut: String = base.chars().take(64 - suffix.chars().count()).collect();
        while cut.ends_with('-') {
            cut.pop();
        }
        let next = format!("{cut}{suffix}");
        if skill_name_problem(&next).is_none() && !on_disk.contains(&next) && !batch.contains(&next)
        {
            return Some(next);
        }
    }
    None
}

fn existing_ids(source: &Path) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    let Ok(read) = std::fs::read_dir(source.join("hivra").join("panels")) else {
        return ids;
    };
    for entry in read.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if skill_name_problem(&name).is_some() {
            continue;
        }
        if check_panel(source, &entry.path(), &name).is_ok() {
            ids.insert(name);
        }
    }
    ids
}

fn has_panel(source: &Path) -> bool {
    !existing_ids(source).is_empty()
}

fn plugin_json() -> Result<String, String> {
    serde_json::to_string_pretty(&json!({
        "$schema": PLUGIN_SCHEMA_1_0_0,
        "name": MY_PANELS,
        "version": "1.0.0",
        "description": DESCRIPTION,
    }))
    .map_err(|e| e.to_string())
}

fn outside(why: &str) -> String {
    format!("{why} would land outside My panels.")
}

fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// Refuse a symlink anywhere along `rel` under `root`, then prove the canonical path stays inside `root`.
fn stays_inside(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let root = crate::fs::canonical(root).map_err(|e| e.to_string())?;
    let mut cur = root.clone();
    for part in rel.components() {
        cur.push(part);
        if is_link(&cur) {
            return Err(outside("A panel file"));
        }
    }
    if cur.exists() {
        let resolved = crate::fs::canonical(&cur).map_err(|e| e.to_string())?;
        if resolved != root && !resolved.starts_with(&root) {
            return Err(outside("A panel file"));
        }
        return Ok(resolved);
    }
    if let Some(parent) = cur.parent() {
        if parent.exists() {
            let parent = crate::fs::canonical(parent).map_err(|e| e.to_string())?;
            if parent != root && !parent.starts_with(&root) {
                return Err(outside("A panel file"));
            }
        }
    }
    Ok(cur)
}

/// `true` when the panel was written. `false` when a finished panel is already there (left untouched) or this one
/// doesn't validate. Files are written into a temporary folder and renamed into place. Any error removes that
/// folder, so a failed write is tried again next time instead of being kept as an edit.
fn write_panel(source: &Path, panel: &NewPanel) -> Result<bool, String> {
    let rel = PathBuf::from("hivra").join("panels").join(&panel.id);
    stays_inside(source, &rel)?;
    let dir = source.join(&rel);
    if is_link(&dir) || is_link(&dir.join("panel.json")) || is_link(&dir.join("index.html")) {
        return Err(outside("That panel path"));
    }
    if check_panel(source, &dir, &panel.id).is_ok() {
        return Ok(false);
    }
    let tmp_rel = PathBuf::from("hivra").join("panels").join(format!(
        ".{}-{}-{}.tmp",
        panel.id,
        std::process::id(),
        PANEL_TMP.fetch_add(1, Ordering::Relaxed)
    ));
    let tmp = source.join(&tmp_rel);
    match fill_panel(source, &tmp, &tmp_rel, panel) {
        Ok(true) => {}
        Ok(false) => {
            let _ = remove_try(source, &tmp);
            return Ok(false);
        }
        Err(why) => {
            let _ = remove_try(source, &tmp);
            return Err(why);
        }
    }
    // Someone else may have finished it while this folder was being written. Don't replace that.
    if check_panel(source, &dir, &panel.id).is_ok() {
        let _ = remove_try(source, &tmp);
        return Ok(false);
    }
    if std::fs::symlink_metadata(&dir).is_ok() {
        if let Err(why) = remove_inside(source, &dir) {
            let _ = remove_try(source, &tmp);
            return Err(why);
        }
    }
    match std::fs::rename(&tmp, &dir) {
        Ok(()) => Ok(true),
        Err(e) => {
            let _ = remove_try(source, &tmp);
            if check_panel(source, &dir, &panel.id).is_ok() {
                Ok(false)
            } else {
                let _ = remove_try(source, &dir);
                Err(e.to_string())
            }
        }
    }
}

/// `Ok(false)` when the files were written but the panel doesn't validate. The caller removes them.
fn fill_panel(source: &Path, dir: &Path, rel: &Path, panel: &NewPanel) -> Result<bool, String> {
    stays_inside(source, rel)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dir = stays_inside(source, rel)?;
    write_bytes(&dir.join("panel.json"), panel.panel_json.as_bytes())?;
    if let Some(html) = &panel.html {
        write_bytes(&dir.join("index.html"), html.as_bytes())?;
    }
    if let Some(css) = &panel.css {
        write_bytes(&dir.join("style.css"), css.as_bytes())?;
    }
    if let Some(js) = &panel.js {
        write_bytes(&dir.join("script.js"), js.as_bytes())?;
    }
    let root = crate::fs::canonical(source).map_err(|e| e.to_string())?;
    Ok(check_panel(&root, &dir, &panel.id).is_ok())
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if is_link(path) {
        return Err(outside("A panel file"));
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

/// Create a file only when it is not already there. A second window's write is left as it was.
fn write_new(root: &Path, path: &Path, bytes: &[u8]) -> Result<bool, String> {
    if let Some(parent) = path.parent() {
        let parent = crate::fs::canonical(parent).map_err(|e| e.to_string())?;
        if !parent.starts_with(root) {
            return Err("That file would land outside My panels.".into());
        }
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(bytes).map_err(|e| e.to_string())?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

fn remove_try(root: &Path, path: &Path) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if meta.file_type().is_symlink() {
        return std::fs::remove_file(path).map_err(|e| e.to_string());
    }
    remove_inside(root, path)
}

fn remove_inside(root: &Path, path: &Path) -> Result<(), String> {
    let root = crate::fs::canonical(root).map_err(|e| e.to_string())?;
    let path = crate::fs::canonical(path).map_err(|e| e.to_string())?;
    if path == root || !path.starts_with(&root) {
        return Err(format!(
            "{} is outside My panels, so it was left alone.",
            path.display()
        ));
    }
    std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
}

/// Copy the installed plugin's own panel files into the source folder when the source is empty, so an update
/// doesn't replace them with only the pages added this time. A symlink is not followed.
fn seed(host: &Host, source: &Path) -> Result<(), String> {
    if source.join("plugin.json").is_file() {
        return Ok(());
    }
    let installed = host.installed(MY_PANELS);
    if !installed.join("plugin.json").is_file() {
        return Ok(());
    }
    copy_regular(&installed, source, Path::new("plugin.json"))?;
    let panels = installed.join("hivra").join("panels");
    let Ok(read) = std::fs::read_dir(&panels) else {
        return Ok(());
    };
    for entry in read.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if skill_name_problem(&name).is_some() {
            continue;
        }
        for file in ["panel.json", "index.html", "style.css", "script.js"] {
            let rel = PathBuf::from("hivra").join("panels").join(&name).join(file);
            copy_regular(&installed, source, &rel)?;
        }
    }
    Ok(())
}

fn copy_regular(from_root: &Path, to_root: &Path, rel: &Path) -> Result<(), String> {
    let from = from_root.join(rel);
    let Ok(meta) = std::fs::symlink_metadata(&from) else {
        return Ok(());
    };
    if !meta.file_type().is_file() {
        return Ok(());
    }
    let to = to_root.join(rel);
    if let Ok(dest) = std::fs::symlink_metadata(&to) {
        if dest.file_type().is_symlink() {
            return Err(outside("A panel file"));
        }
        if dest.file_type().is_file() {
            return Ok(());
        }
        return Err(outside("A panel file"));
    }
    if let Some(parent) = rel.parent() {
        stays_inside(to_root, parent)?;
        std::fs::create_dir_all(to.parent().unwrap_or(to_root)).map_err(|e| e.to_string())?;
        stays_inside(to_root, parent)?;
    }
    if is_link(&to) {
        return Err(outside("A panel file"));
    }
    let bytes = std::fs::read(&from).map_err(|e| e.to_string())?;
    write_bytes(&to, &bytes)
}

fn put(host: &Host, tools: &Tools, source: &Path, added: &[String]) -> Result<(), String> {
    let installed = registry::read(host)?.plugins.contains_key(MY_PANELS);
    if !installed {
        match registry::install_local(host, source, Source::local(source)) {
            Ok(_) => registry::enable(host, MY_PANELS, &Scope::Global).map(|_| ()),
            Err(why) if why.contains("already installed") => {
                if added.is_empty() {
                    Ok(())
                } else {
                    refresh(host, tools, source)
                }
            }
            Err(why) => Err(why),
        }
    } else if added.is_empty() {
        Ok(())
    } else {
        refresh(host, tools, source)
    }
}

fn refresh(host: &Host, tools: &Tools, source: &Path) -> Result<(), String> {
    let path = crate::fs::canonical(source).map_err(|e| e.to_string())?;
    let source = InstallSource::Local {
        path: path.to_string_lossy().into_owned(),
    };
    match update_plugin(host, tools, MY_PANELS, &source, RequestedBy::person())? {
        InstallResult::Installed { .. } => Ok(()),
        InstallResult::Waiting { .. } => Err("My panels is waiting to be updated.".into()),
    }
}

#[tauri::command(async)]
pub fn panels_catalog(app: tauri::AppHandle) -> Result<Vec<CatalogPanel>, String> {
    catalog(&crate::plugins::host(&app)?)
}

#[tauri::command(async)]
pub fn panels_migrate(app: tauri::AppHandle, pages: Value) -> Result<MigrateReport, String> {
    migrate(&crate::plugins::host(&app)?, &Tools::app(), &pages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::Target;

    struct Tmp(PathBuf);

    impl Tmp {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("hivra-panels-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Tmp(crate::fs::canonical(&dir).unwrap())
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn host_of(tmp: &Tmp) -> Host {
        let host = Host {
            root: tmp.0.join("plugins"),
            agents_skills: tmp.0.join("skills"),
        };
        std::fs::create_dir_all(&host.root).unwrap();
        std::fs::create_dir_all(&host.agents_skills).unwrap();
        host
    }

    fn tools() -> Tools {
        Tools {
            git: "git".into(),
            npm: "npm".into(),
            path: None,
            target: Target::here(),
        }
    }

    fn blocks(id: &str, title: &str) -> Value {
        json!({
            "id": id,
            "keptAt": 10,
            "spec": { "kind": "blocks", "title": title, "blocks": [{ "kind": "note", "title": "Hello", "text": "Example: a note" }] }
        })
    }

    fn bespoke(id: &str) -> Value {
        json!({
            "id": id,
            "keptAt": 11,
            "permissions": ["tasks.read"],
            "spec": { "kind": "bespoke", "title": "Custom", "html": "a\r\nb", "permissions": ["tasks.read", "tasks.read"] }
        })
    }

    #[test]
    fn kept_pages_become_my_panels_and_a_second_pass_adds_nothing() {
        let tmp = Tmp::new();
        let host = host_of(&tmp);
        let pages = json!([
            blocks("Board", "看板"),
            bespoke("custom"),
            { "id": "preview", "spec": { "kind": "blocks", "title": "Preview", "blocks": [{ "kind": "note", "title": "N", "text": "x" }] } },
            { "id": "gone", "keptAt": 1, "removed": true, "spec": { "kind": "blocks", "title": "Gone", "blocks": [{ "kind": "note", "title": "N", "text": "x" }] } },
            { "id": "../secret", "keptAt": 1, "spec": { "kind": "blocks", "title": "Secret", "blocks": [{ "kind": "note", "title": "N", "text": "x" }] } },
        ]);
        let report = migrate(&host, &tools(), &pages).unwrap();
        assert_eq!(report.added, ["board", "custom"]);
        assert!(report.skipped.iter().any(|id| id == "../secret"));
        assert!(report.skipped.iter().any(|id| id == "gone"));

        let source = host.root.join("sources").join(MY_PANELS);
        let plugin: Value =
            serde_json::from_str(&std::fs::read_to_string(source.join("plugin.json")).unwrap())
                .unwrap();
        assert_eq!(plugin["name"], MY_PANELS);
        assert_eq!(plugin["description"], DESCRIPTION);
        let board: Value = serde_json::from_str(
            &std::fs::read_to_string(source.join("hivra/panels/board/panel.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(board["title"], "看板");
        assert_eq!(
            std::fs::read_to_string(source.join("hivra/panels/custom/index.html")).unwrap(),
            "a\r\nb"
        );
        assert!(!source.join("hivra/panels/secret").exists());

        let listed = catalog(&host).unwrap();
        assert_eq!(listed.len(), 2);
        let custom = listed.iter().find(|p| p.id == "custom").unwrap();
        assert_eq!(custom.permissions, ["tasks.read"]);
        assert_eq!(custom.spec["html"], "a\r\nb");
        assert!(listed
            .iter()
            .find(|p| p.id == "board")
            .unwrap()
            .permissions
            .is_empty());

        let again = migrate(&host, &tools(), &pages).unwrap();
        assert!(again.added.is_empty());
        assert!(!host.previous(MY_PANELS).exists());
    }

    #[test]
    fn disabling_the_plugin_drops_it_from_the_catalog_and_an_edit_is_kept() {
        let tmp = Tmp::new();
        let host = host_of(&tmp);
        migrate(&host, &tools(), &json!([blocks("board", "Board")])).unwrap();
        registry::disable(&host, MY_PANELS, &Scope::Global).unwrap();
        assert!(catalog(&host).unwrap().is_empty());

        let path = host
            .root
            .join("sources")
            .join(MY_PANELS)
            .join("hivra/panels/board/panel.json");
        let edited = "{\"kind\":\"blocks\",\"title\":\"Edited\",\"blocks\":[{\"kind\":\"note\",\"title\":\"Hello\",\"text\":\"x\"}]}";
        std::fs::write(&path, edited).unwrap();
        let report = migrate(&host, &tools(), &json!([blocks("board", "Replaced")])).unwrap();
        assert!(report.added.is_empty());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
    }

    #[test]
    fn an_unapproved_page_is_installed_with_no_grants() {
        let tmp = Tmp::new();
        let host = host_of(&tmp);
        let pages = json!([
            {
                "id": "agents",
                "keptAt": 11,
                "permissions": [],
                "spec": {
                    "kind": "bespoke",
                    "title": "Agents",
                    "html": "<p>a</p>",
                    "permissions": ["agents.read", "agents.answer"]
                }
            },
            {
                "id": "custom",
                "keptAt": 12,
                "permissions": ["jobs.read", "jobs.read"],
                "spec": {
                    "kind": "bespoke",
                    "title": "Custom",
                    "html": "<p>b</p>",
                    "permissions": ["tasks.read", "jobs.read"]
                }
            },
            {
                "id": "junk",
                "keptAt": 13,
                "permissions": "agents.read",
                "spec": {
                    "kind": "bespoke",
                    "title": "Junk",
                    "html": "<p>c</p>",
                    "permissions": ["agents.read"]
                }
            }
        ]);
        let report = migrate(&host, &tools(), &pages).unwrap();
        assert_eq!(report.added, ["agents", "custom"]);
        assert!(report.skipped.iter().any(|id| id == "junk"));
        let source = host.root.join("sources").join(MY_PANELS);
        let agents: Value = serde_json::from_str(
            &std::fs::read_to_string(source.join("hivra/panels/agents/panel.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(agents["permissions"], json!([]));
        let custom: Value = serde_json::from_str(
            &std::fs::read_to_string(source.join("hivra/panels/custom/panel.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(custom["permissions"], json!(["jobs.read"]));
        let listed = catalog(&host).unwrap();
        assert!(listed
            .iter()
            .find(|p| p.id == "agents")
            .unwrap()
            .permissions
            .is_empty());
    }

    #[test]
    fn an_incomplete_panel_is_rewritten_instead_of_kept_as_an_edit() {
        let tmp = Tmp::new();
        let host = host_of(&tmp);
        let source = host.root.join("sources").join(MY_PANELS);
        let dir = source.join("hivra").join("panels").join("custom");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("panel.json"),
            r#"{"kind":"bespoke","title":"Custom","permissions":["tasks.read"]}"#,
        )
        .unwrap();
        let report = migrate(&host, &tools(), &json!([bespoke("custom")])).unwrap();
        assert_eq!(report.added, ["custom"]);
        assert_eq!(
            std::fs::read_to_string(dir.join("index.html")).unwrap(),
            "a\r\nb"
        );
    }

    #[test]
    fn a_write_that_cannot_finish_does_not_leave_panel_json() {
        let tmp = Tmp::new();
        let host = host_of(&tmp);
        let source = host.root.join("sources").join(MY_PANELS);
        let dir = source.join("hivra").join("panels").join("custom");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir(dir.join("index.html")).unwrap();
        let first = migrate(&host, &tools(), &json!([bespoke("custom")]));
        let json = dir.join("panel.json");
        let html = dir.join("index.html");
        let finished = std::fs::read_to_string(&html).ok();
        assert!(
            finished.as_deref() == Some("a\r\nb") || !json.exists(),
            "a failed write left panel.json, so the next migrate treats it as an edit"
        );
        if first.is_err() || finished.as_deref() != Some("a\r\nb") {
            let _ = std::fs::remove_dir_all(&dir);
            let again = migrate(&host, &tools(), &json!([bespoke("custom")])).unwrap();
            assert_eq!(again.added, ["custom"]);
        }
    }

    #[test]
    fn seed_does_not_follow_a_symlink_out_of_my_panels() {
        use std::os::unix::fs::symlink;
        let tmp = Tmp::new();
        let host = host_of(&tmp);
        let installed = host.installed(MY_PANELS);
        std::fs::create_dir_all(installed.join("hivra/panels/board")).unwrap();
        std::fs::write(
            installed.join("plugin.json"),
            r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"my-panels","version":"1.0.0","description":"My panels"}"#,
        )
        .unwrap();
        let body = r#"{"kind":"blocks","title":"Board","blocks":[{"kind":"note","title":"Hello","text":"x"}]}"#;
        std::fs::write(installed.join("hivra/panels/board/panel.json"), body).unwrap();

        let source = host.root.join("sources").join(MY_PANELS);
        std::fs::create_dir_all(source.join("hivra/panels/board")).unwrap();
        let outside = tmp.0.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let stolen = outside.join("stolen.json");
        symlink(&stolen, source.join("hivra/panels/board/panel.json")).unwrap();

        let _ = migrate(&host, &tools(), &json!([]));
        assert!(
            !stolen.exists(),
            "seed followed a dangling symlink and created a file outside My panels"
        );

        let tmp2 = Tmp::new();
        let host2 = host_of(&tmp2);
        let installed2 = host2.installed(MY_PANELS);
        std::fs::create_dir_all(installed2.join("hivra/panels/board")).unwrap();
        std::fs::write(
            installed2.join("plugin.json"),
            r#"{"name":"my-panels","version":"1.0.0","description":"My panels"}"#,
        )
        .unwrap();
        std::fs::write(installed2.join("hivra/panels/board/panel.json"), body).unwrap();
        let source2 = host2.root.join("sources").join(MY_PANELS);
        std::fs::create_dir_all(source2.join("hivra")).unwrap();
        let outside_panels = tmp2.0.join("outside-panels");
        std::fs::create_dir_all(&outside_panels).unwrap();
        symlink(&outside_panels, source2.join("hivra/panels")).unwrap();
        let _ = migrate(&host2, &tools(), &json!([]));
        assert!(
            !outside_panels.join("board/panel.json").exists(),
            "seed followed a directory symlink out of My panels"
        );
    }

    #[test]
    fn a_bad_payload_and_a_windows_path_add_nothing() {
        let tmp = Tmp::new();
        let host = host_of(&tmp);
        let report = migrate(&host, &tools(), &json!("nope")).unwrap();
        assert!(report.added.is_empty());
        assert!(!host.installed(MY_PANELS).exists());
        let report = migrate(
            &host,
            &tools(),
            &json!([{ "id": "C:\\secret", "keptAt": 1, "spec": { "kind": "blocks", "title": "Win", "blocks": [{ "kind": "note", "title": "N", "text": "x" }] } }]),
        )
        .unwrap();
        assert!(report.added.is_empty());
        assert!(report.skipped.iter().any(|id| id.contains("secret")));
    }
}
