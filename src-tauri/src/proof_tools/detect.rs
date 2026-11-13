//! PT-1: which proof tools fit a checkout and which it already has.
//!
//! The project is read as plain text, bounded and never followed through a link: its package.json (the Verify offer's own
//! reading, `plugins::verify`), its Cargo.toml `[dev-dependencies]`, its pyproject.toml and `requirements*.txt`, an OpenAPI
//! file and a few marker files. Everything read from the project is untrusted: sizes are capped (`read_capped`), walks are
//! bounded, a file that can't be read or parsed says nothing, and no value read here is ever put in a shell line.
//!
//! A tool FITS when its catalogue `detect` rule holds, and is INSTALLED when it fits and its `installed` rule holds. Rules
//! are evaluated lazily and left to right, so a program probe (`cargo mutants --version`) only runs when nothing cheaper
//! has already decided the answer. The probe itself is the caller's: in the app it goes through the same sandboxed runner as
//! the checks, with a short timeout; a failure is "not installed".

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::catalogue::{self, Rule, Stack, Tool};
use crate::plugins::verify;

/// The package.json, Cargo.toml and Python manifests read, each kind, across a project's folders.
const MANIFESTS_MAX: usize = 60;
/// The folders searched for manifests: the root, its immediate subfolders, and the children of the usual workspace parents.
const SUBDIRS_MAX: usize = 60;
const DIRS_MAX: usize = 160;
/// Entries looked at in one folder listing, and in one walk.
const ENTRIES_MAX: usize = 2_000;
const WALK_ENTRIES: usize = 5_000;
const WALK_DEPTH: usize = 4;
const REQ_FILES_MAX: usize = 20;
const REQ_LINES_MAX: usize = 5_000;
const YAML_LINES_MAX: usize = 20_000;
const RULE_DEPTH_MAX: usize = 8;

/// Folders no search goes into: other people's code and build output.
const SKIP_DIRS: [&str; 4] = ["node_modules", "target", "dist", "build"];
/// A folder whose immediate children are each a package of the project.
const WORKSPACE_PARENTS: [&str; 4] = ["packages", "apps", "libs", "crates"];
const PY_FILES: [&str; 4] = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"];
const OPENAPI_NAMES: [&str; 6] = [
    "openapi.yaml",
    "openapi.yml",
    "openapi.json",
    "swagger.yaml",
    "swagger.yml",
    "swagger.json",
];
/// Where besides the root an OpenAPI file is looked for.
const OPENAPI_DIRS: [&str; 4] = ["api", "docs", "spec", "openapi"];
/// Every stack, in the order a detection lists them.
const STACKS: [Stack; 5] = [
    Stack::Node,
    Stack::Rust,
    Stack::Python,
    Stack::Openapi,
    Stack::Web,
];

/// Whether a program the catalogue names answers (`cargo mutants --version`). The app's probe runs it through the sandboxed
/// runner with a short timeout; anything but a clean answer is `false`.
pub trait Probe {
    fn available(&self, argv: &[String]) -> bool;
}

/// A probe that finds nothing: every program is absent. For a read that must not run a program.
#[allow(dead_code)]
pub struct NoProbe;

impl Probe for NoProbe {
    fn available(&self, _argv: &[String]) -> bool {
        false
    }
}

/// What was read from a project, once, so each rule is a lookup.
#[derive(Debug, Default)]
pub struct Facts {
    /// The canonical root; empty when the project could not be read (nothing is then found).
    root: PathBuf,
    has_node: bool,
    npm: BTreeSet<String>,
    has_rust: bool,
    cargo_dev: BTreeSet<String>,
    has_python: bool,
    py: BTreeSet<String>,
    openapi: Option<String>,
    web: bool,
}

fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', '\0'])
        && !name.contains("..")
        && !name.chars().any(char::is_control)
}

fn skipped_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

/// The real (not linked) folders directly inside `dir`, by name, skipping hidden and build folders.
fn child_dirs(dir: &Path, cap: usize) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(String, PathBuf)> = entries
        .take(ENTRIES_MAX)
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            (!skipped_dir(&name)).then(|| (name, entry.path()))
        })
        .collect();
    found.sort();
    found.truncate(cap);
    found.into_iter().map(|(_, path)| path).collect()
}

/// The folders whose manifests are read: the root first, then its subfolders, then the children of `packages`, `apps`,
/// `libs` and `crates`.
fn manifest_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.to_path_buf()];
    let children = child_dirs(root, SUBDIRS_MAX);
    dirs.extend(children.iter().cloned());
    for child in &children {
        let parent = child
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| WORKSPACE_PARENTS.contains(&name));
        if parent {
            dirs.extend(child_dirs(child, SUBDIRS_MAX));
        }
    }
    dirs.truncate(DIRS_MAX);
    dirs
}

fn add_keys(out: &mut BTreeSet<String>, table: Option<&toml::Value>) {
    if let Some(table) = table.and_then(toml::Value::as_table) {
        out.extend(table.keys().cloned());
    }
}

/// The names in every `[dev-dependencies]` table of a Cargo.toml: the plain one, the older `dev_dependencies` spelling, the
/// per-target ones (`[target.'cfg(unix)'.dev-dependencies]`) and the `[dev-dependencies.name]` table form (a key either way).
fn cargo_dev_names(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Ok(doc) = toml::from_str::<toml::Value>(text) else {
        return out;
    };
    for key in ["dev-dependencies", "dev_dependencies"] {
        add_keys(&mut out, doc.get(key));
    }
    if let Some(targets) = doc.get("target").and_then(toml::Value::as_table) {
        for table in targets.values() {
            for key in ["dev-dependencies", "dev_dependencies"] {
                add_keys(&mut out, table.get(key));
            }
        }
    }
    out
}

/// A Python package name as the index compares it: lower case, runs of `-`, `_` and `.` one `-`.
fn normalise_py(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            if !dash {
                out.push('-');
                dash = true;
            }
        } else {
            out.extend(c.to_lowercase());
            dash = false;
        }
    }
    out
}

/// The package a requirement line names, normalised: `Hypothesis[numpy]>=6.0 ; python_version>"3"` is `hypothesis`. A
/// comment, a blank line, an option (`-r base.txt`, `--index-url ...`) and a bare URL name nothing. CRLF and a BOM are fine.
fn requirement_name(line: &str) -> Option<String> {
    let line = line.trim().trim_start_matches('\u{feff}').trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('-') {
        return None;
    }
    let line = line.split(" #").next().unwrap_or("");
    // An environment marker follows `;`.
    let line = line.split(';').next().unwrap_or("").trim();
    let head = match line.split_once(" @ ") {
        Some((name, _)) => name.trim(),
        None if line.contains("://") => return None,
        None => line,
    };
    let name: String = head
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    if !name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(normalise_py(&name))
}

fn add_specs(out: &mut BTreeSet<String>, list: Option<&toml::Value>) {
    if let Some(list) = list.and_then(toml::Value::as_array) {
        for item in list {
            if let Some(name) = item.as_str().and_then(requirement_name) {
                out.insert(name);
            }
        }
    }
}

fn add_py_keys(out: &mut BTreeSet<String>, table: Option<&toml::Value>) {
    if let Some(table) = table.and_then(toml::Value::as_table) {
        out.extend(table.keys().map(|key| normalise_py(key)));
    }
}

/// The dependency names in a pyproject.toml: PEP 621 (`project.dependencies`, `optional-dependencies`), PEP 735
/// (`dependency-groups`), Poetry (`dependencies`, `dev-dependencies`, `group.*.dependencies`) and uv's `dev-dependencies`.
fn pyproject_names(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Ok(doc) = toml::from_str::<toml::Value>(text) else {
        return out;
    };
    if let Some(project) = doc.get("project") {
        add_specs(&mut out, project.get("dependencies"));
        if let Some(groups) = project
            .get("optional-dependencies")
            .and_then(toml::Value::as_table)
        {
            for list in groups.values() {
                add_specs(&mut out, Some(list));
            }
        }
    }
    if let Some(groups) = doc.get("dependency-groups").and_then(toml::Value::as_table) {
        for list in groups.values() {
            add_specs(&mut out, Some(list));
        }
    }
    if let Some(tool) = doc.get("tool") {
        if let Some(poetry) = tool.get("poetry") {
            add_py_keys(&mut out, poetry.get("dependencies"));
            add_py_keys(&mut out, poetry.get("dev-dependencies"));
            if let Some(groups) = poetry.get("group").and_then(toml::Value::as_table) {
                for group in groups.values() {
                    add_py_keys(&mut out, group.get("dependencies"));
                }
            }
        }
        if let Some(uv) = tool.get("uv") {
            add_specs(&mut out, uv.get("dev-dependencies"));
        }
    }
    out
}

/// The `requirements*.txt` files directly in `dir`, by name.
fn requirement_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .take(ENTRIES_MAX)
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with("requirements") && name.ends_with(".txt"))
        .collect();
    names.sort();
    names.truncate(REQ_FILES_MAX);
    names
}

/// Whether any file under `root` (a bounded walk that skips hidden and build folders and follows no link) ends with
/// `suffix`.
fn any_file_with_suffix(root: &Path, suffix: &str) -> bool {
    if suffix.is_empty() || root.as_os_str().is_empty() {
        return false;
    }
    let mut seen = 0usize;
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > WALK_ENTRIES {
                return false;
            }
            let (Ok(kind), Ok(name)) = (entry.file_type(), entry.file_name().into_string()) else {
                continue;
            };
            if kind.is_file() {
                if name.len() > suffix.len() && name.ends_with(suffix) {
                    return true;
                }
            } else if kind.is_dir() && depth < WALK_DEPTH && !skipped_dir(&name) {
                pending.push((entry.path(), depth + 1));
            }
        }
    }
    false
}

impl Facts {
    /// Reads `root`. A root that isn't a folder reads as a project with nothing in it.
    pub fn read(root: &Path) -> Facts {
        let Ok(root) = crate::fs::canonical(root) else {
            return Facts::default();
        };
        if !root.is_dir() {
            return Facts::default();
        }
        let mut facts = Facts {
            root: root.clone(),
            ..Facts::default()
        };
        let (mut nodes, mut cargos, mut pythons) = (0usize, 0usize, 0usize);
        for dir in manifest_dirs(&root) {
            if nodes < MANIFESTS_MAX && verify::has_project_file(&dir, &["package.json"]) {
                nodes += 1;
                facts.has_node = true;
                if let Some(package) = verify::read_project_file(&dir, &["package.json"])
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                {
                    facts.npm.extend(verify::dep_names(&package));
                }
            }
            if cargos < MANIFESTS_MAX && verify::has_project_file(&dir, &["Cargo.toml"]) {
                cargos += 1;
                facts.has_rust = true;
                if let Some(text) = verify::read_project_file(&dir, &["Cargo.toml"]) {
                    facts.cargo_dev.extend(cargo_dev_names(&text));
                }
            }
            if pythons < MANIFESTS_MAX {
                let mut here = PY_FILES
                    .iter()
                    .any(|file| verify::has_project_file(&dir, &[*file]));
                if let Some(text) = verify::read_project_file(&dir, &["pyproject.toml"]) {
                    facts.py.extend(pyproject_names(&text));
                }
                for name in requirement_files(&dir) {
                    here = true;
                    if let Some(text) = verify::read_project_file(&dir, &[name.as_str()]) {
                        facts.py.extend(
                            text.lines()
                                .take(REQ_LINES_MAX)
                                .filter_map(requirement_name),
                        );
                    }
                }
                if here {
                    pythons += 1;
                    facts.has_python = true;
                }
            }
        }
        facts.openapi = openapi_file(&root);
        // A desktop shell (Tauri, Electron) is not a web app even when it uses Vite: `surfaces_of` already says so.
        facts.web = verify::surfaces_of(&root)
            .iter()
            .any(|surface| surface == "web");
        facts
    }

    fn has_stack(&self, stack: Stack) -> bool {
        match stack {
            Stack::Node => self.has_node,
            Stack::Rust => self.has_rust,
            Stack::Python => self.has_python,
            Stack::Openapi => self.openapi.is_some(),
            Stack::Web => self.web,
        }
    }

    fn has_file(&self, name: &str) -> bool {
        plain_name(name) && verify::project_file(&self.root, &[name]).is_some()
    }

    fn has_dir(&self, name: &str) -> bool {
        !self.root.as_os_str().is_empty()
            && plain_name(name)
            && std::fs::symlink_metadata(self.root.join(name))
                .is_ok_and(|meta| meta.file_type().is_dir())
    }

    fn has_file_with_prefix(&self, prefix: &str) -> bool {
        if prefix.is_empty() || self.root.as_os_str().is_empty() {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return false;
        };
        entries.take(ENTRIES_MAX).flatten().any(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(prefix))
        })
    }
}

/// Whether `rule` holds for what was read. `AnyOf` and `AllOf` stop at the first answer, so a probe only runs when needed.
pub fn eval(rule: &Rule, facts: &Facts, probe: &dyn Probe) -> bool {
    eval_at(rule, facts, probe, 0)
}

fn eval_at(rule: &Rule, facts: &Facts, probe: &dyn Probe, depth: usize) -> bool {
    if depth > RULE_DEPTH_MAX {
        return false;
    }
    match rule {
        Rule::Stack(stack) => facts.has_stack(*stack),
        Rule::AnyOf(rules) => rules
            .iter()
            .any(|rule| eval_at(rule, facts, probe, depth + 1)),
        Rule::AllOf(rules) => {
            !rules.is_empty()
                && rules
                    .iter()
                    .all(|rule| eval_at(rule, facts, probe, depth + 1))
        }
        Rule::NpmDep(name) => facts.npm.contains(name),
        Rule::NpmDepPrefix(prefix) => {
            !prefix.is_empty() && facts.npm.iter().any(|dep| dep.starts_with(prefix.as_str()))
        }
        Rule::CargoDevDep(name) => facts.cargo_dev.contains(name),
        Rule::PyDep(name) => facts.py.contains(&normalise_py(name)),
        Rule::File(name) => facts.has_file(name),
        Rule::FilePrefix(prefix) => facts.has_file_with_prefix(prefix),
        Rule::AnyFileSuffix(suffix) => any_file_with_suffix(&facts.root, suffix),
        Rule::Dir(name) => facts.has_dir(name),
        Rule::Binary(argv) => !argv.is_empty() && probe.available(argv),
    }
}

/// A tool that fits the project, and whether the project already has it.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub tool: &'static Tool,
    pub installed: bool,
}

/// What a checkout is and which proof tools go with it. `fitting` is in catalogue order.
#[derive(Clone, Debug, PartialEq)]
pub struct Detection {
    /// The stacks found, in the enum's order.
    pub stacks: Vec<Stack>,
    pub fitting: Vec<Found>,
}

impl Detection {
    /// The tools that fit and that the project already has.
    pub fn installed(&self) -> Vec<&'static Tool> {
        self.fitting
            .iter()
            .filter(|found| found.installed)
            .map(|found| found.tool)
            .collect()
    }

    /// The tools that fit and that the project does not have: what a first mate may propose.
    pub fn missing(&self) -> Vec<&'static Tool> {
        self.fitting
            .iter()
            .filter(|found| !found.installed)
            .map(|found| found.tool)
            .collect()
    }

    pub fn has_installed(&self) -> bool {
        self.fitting.iter().any(|found| found.installed)
    }
}

/// `detect` over facts already read.
#[allow(dead_code)]
pub fn detect_with(facts: &Facts, probe: &dyn Probe) -> Detection {
    let stacks = STACKS
        .iter()
        .copied()
        .filter(|stack| facts.has_stack(*stack))
        .collect();
    let fitting = catalogue::tools()
        .iter()
        .filter(|tool| eval(&tool.detect, facts, probe))
        .map(|tool| Found {
            tool,
            installed: eval(&tool.installed, facts, probe),
        })
        .collect();
    Detection { stacks, fitting }
}

/// Which tools fit the checkout at `root` and which it already has. A root that isn't a folder fits nothing.
pub fn detect(root: &Path, probe: &dyn Probe) -> Detection {
    detect_with(&Facts::read(root), probe)
}

/// The project's OpenAPI file as a root-relative path with `/` between parts: `openapi.yaml`, `openapi.yml`,
/// `openapi.json` or a `swagger.*` file, in the root or in `api/`, `docs/`, `spec/` or `openapi/`. A link is not one.
pub fn openapi_file(root: &Path) -> Option<String> {
    let root = crate::fs::canonical(root)
        .ok()
        .filter(|path| path.is_dir())?;
    for dir in std::iter::once("").chain(OPENAPI_DIRS) {
        for name in OPENAPI_NAMES {
            let parts: Vec<&str> = if dir.is_empty() {
                vec![name]
            } else {
                vec![dir, name]
            };
            if verify::has_project_file(&root, &parts) {
                return Some(parts.join("/"));
            }
        }
    }
    None
}

/// An absolute http(s) URL whose host is this computer (`localhost`, `127.x.x.x`, `::1`), as written, or nothing. Anything
/// else is refused: a remote host, a relative URL, a `{variable}` template, a URL with a name and password in it. A
/// property tester is a fuzzer and is never pointed at a service the person didn't mean, so nothing is guessed.
fn loopback_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty()
        || url.len() > 300
        || url
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '{' | '}' | '\\'))
    {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    let rest = if lower.starts_with("http://") {
        &url[7..]
    } else if lower.starts_with("https://") {
        &url[8..]
    } else {
        return None;
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let (host, port): (&str, Option<&str>) = if let Some(inner) = authority.strip_prefix('[') {
        let close = inner.find(']')?;
        let tail = &inner[close + 1..];
        let port = if tail.is_empty() {
            None
        } else {
            Some(tail.strip_prefix(':')?)
        };
        (&inner[..close], port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    if let Some(port) = port {
        if port.is_empty()
            || port.len() > 5
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.parse::<u32>().ok()? > 65_535
        {
            return None;
        }
    }
    let host = host.to_ascii_lowercase();
    (host == "localhost" || host == "::1" || is_loopback_v4(&host)).then(|| url.to_string())
}

fn is_loopback_v4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 3
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.parse::<u8>().is_ok()
        })
        && parts[0] == "127"
}

/// A YAML scalar's value: quotes taken off, a trailing comment (and, in a `{flow, mapping}`, the next key) cut.
fn yaml_scalar(rest: &str, flow: bool) -> String {
    let rest = rest.trim();
    if let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let inner = &rest[1..];
        return inner
            .find(quote)
            .map_or(inner, |end| &inner[..end])
            .to_string();
    }
    let mut value = rest;
    if flow {
        if let Some(at) = value.find(['}', ',']) {
            value = &value[..at];
        }
    }
    value.split(" #").next().unwrap_or("").trim().to_string()
}

/// The first `url:` under a top-level `servers:` in an OpenAPI YAML file, by a bounded line scan. The first server only:
/// when it has no url, nothing is declared.
fn yaml_server_url(text: &str) -> Option<String> {
    let mut inside = false;
    let mut item_indent: Option<usize> = None;
    let mut items = 0usize;
    for raw in text.lines().take(YAML_LINES_MAX) {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if indent == 0 {
            inside = trimmed
                .strip_prefix("servers:")
                .is_some_and(|rest| rest.trim().is_empty() || rest.trim().starts_with('#'));
            item_indent = None;
            items = 0;
            continue;
        }
        if !inside {
            continue;
        }
        let mut item = trimmed;
        if let Some(after) = trimmed.strip_prefix('-') {
            if after.is_empty() || after.starts_with(char::is_whitespace) {
                if item_indent.is_none_or(|first| first == indent) {
                    item_indent = Some(indent);
                    items += 1;
                    if items > 1 {
                        return None;
                    }
                }
                item = after.trim_start();
            }
        }
        let flow = item.starts_with('{');
        if flow {
            item = item[1..].trim_start();
        }
        if let Some(rest) = item.strip_prefix("url:") {
            return Some(yaml_scalar(rest, flow));
        }
    }
    None
}

fn json_server_url(text: &str) -> Option<String> {
    serde_json::from_str::<Value>(text)
        .ok()?
        .get("servers")?
        .as_array()?
        .first()?
        .get("url")?
        .as_str()
        .map(str::to_string)
}

/// The base URL the project's own OpenAPI document declares (its first `servers` entry), when it is on this computer. A
/// project that declares none, or a remote one, has none: Schemathesis then "could not run", never a guessed address.
/// `schema` is the root-relative path `openapi_file` returned.
pub fn declared_base_url(root: &Path, schema: &str) -> Option<String> {
    let parts: Vec<&str> = schema.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains('\\'))
    {
        return None;
    }
    let text = verify::read_project_file(root, &parts)?;
    let url =
        if schema.to_ascii_lowercase().ends_with(".json") || text.trim_start().starts_with('{') {
            json_server_url(&text)?
        } else {
            yaml_server_url(&text)?
        };
    loopback_url(&url)
}

/// The project's own Semgrep rules: `.semgrep.yml`, else the `.semgrep` folder. Never `--config auto`, which reaches
/// Semgrep's servers.
pub fn semgrep_config(root: &Path) -> Option<String> {
    let root = crate::fs::canonical(root)
        .ok()
        .filter(|path| path.is_dir())?;
    if verify::has_project_file(&root, &[".semgrep.yml"]) {
        return Some(".semgrep.yml".to_string());
    }
    std::fs::symlink_metadata(root.join(".semgrep"))
        .is_ok_and(|meta| meta.file_type().is_dir())
        .then(|| ".semgrep".to_string())
}

/// Whether the change touches the part of the project a person sees: a web app, and a changed file a browser shows
/// (`diff::is_ui_path`).
pub fn touches_ui(stacks: &[Stack], changed: &[String]) -> bool {
    stacks.contains(&Stack::Web) && changed.iter().any(|path| super::diff::is_ui_path(path))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct Tmp(PathBuf);

    impl Tmp {
        fn new() -> Tmp {
            let dir =
                std::env::temp_dir().join(format!("hivra pt1 détect {}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Tmp(crate::fs::canonical(&dir).unwrap())
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A probe that knows a set of programs and remembers every program it was asked about.
    struct FakeProbe {
        has: Vec<Vec<String>>,
        asked: RefCell<Vec<Vec<String>>>,
    }

    impl FakeProbe {
        fn with(programs: &[&[&str]]) -> FakeProbe {
            FakeProbe {
                has: programs
                    .iter()
                    .map(|argv| argv.iter().map(|word| word.to_string()).collect())
                    .collect(),
                asked: RefCell::new(Vec::new()),
            }
        }

        fn calls(&self) -> usize {
            self.asked.borrow().len()
        }

        fn has_asked_for(&self, argv: &[&str]) -> bool {
            self.asked
                .borrow()
                .iter()
                .any(|asked| asked.iter().map(String::as_str).eq(argv.iter().copied()))
        }
    }

    impl Probe for FakeProbe {
        fn available(&self, argv: &[String]) -> bool {
            self.asked.borrow_mut().push(argv.to_vec());
            self.has.iter().any(|known| known.as_slice() == argv)
        }
    }

    fn installed_ids(detection: &Detection) -> Vec<&'static str> {
        detection
            .installed()
            .iter()
            .map(|tool| tool.id.as_str())
            .collect()
    }

    fn fitting_ids(detection: &Detection) -> Vec<&'static str> {
        detection
            .fitting
            .iter()
            .map(|found| found.tool.id.as_str())
            .collect()
    }

    fn package(deps: &str) -> String {
        format!(r#"{{"name":"x","devDependencies":{{{deps}}}}}"#)
    }

    // ---- stacks -----------------------------------------------------------------------------------------------------

    #[test]
    fn an_empty_folder_has_no_stack_and_nothing_fits() {
        let tmp = Tmp::new();
        let found = detect(tmp.path(), &NoProbe);
        assert!(found.stacks.is_empty());
        assert!(found.fitting.is_empty());
        assert!(!found.has_installed());
        assert!(found.missing().is_empty());
    }

    #[test]
    fn a_path_that_is_not_a_folder_fits_nothing_and_does_not_panic() {
        let tmp = Tmp::new();
        tmp.write("file.txt", "x");
        for path in [tmp.path().join("file.txt"), tmp.path().join("nothing here")] {
            let found = detect(&path, &NoProbe);
            assert!(
                found.stacks.is_empty() && found.fitting.is_empty(),
                "{path:?}"
            );
        }
        assert_eq!(openapi_file(&tmp.path().join("file.txt")), None);
        assert_eq!(semgrep_config(&tmp.path().join("nothing here")), None);
    }

    #[test]
    fn this_repos_shape_is_node_rust_and_web_until_it_is_a_desktop_shell() {
        let tmp = Tmp::new();
        tmp.write(
            "package.json",
            r#"{"dependencies":{"react":"19","react-dom":"19"},"devDependencies":{"vite":"7","vitest":"4"}}"#,
        );
        tmp.write(
            "src-tauri/Cargo.toml",
            "[package]\nname = \"x\"\n\n[dev-dependencies]\ntempfile = \"3\"\n",
        );
        let found = detect(tmp.path(), &NoProbe);
        assert_eq!(found.stacks, vec![Stack::Node, Stack::Rust, Stack::Web]);
        assert!(fitting_ids(&found).contains(&"fast-check"));
        assert!(fitting_ids(&found).contains(&"proptest"));
        assert!(fitting_ids(&found).contains(&"playwright"));
        assert!(!fitting_ids(&found).contains(&"hypothesis"));
        assert!(found.installed().is_empty());
        // A Tauri shell is a desktop app: the Verify offer's own reading says it is not a web app.
        tmp.write("src-tauri/tauri.conf.json", "{}");
        let desktop = detect(tmp.path(), &NoProbe);
        assert_eq!(desktop.stacks, vec![Stack::Node, Stack::Rust]);
        assert!(!fitting_ids(&desktop).contains(&"playwright"));
    }

    #[test]
    fn manifests_are_found_in_subfolders_and_workspace_packages_and_never_in_build_folders() {
        let tmp = Tmp::new();
        tmp.write("packages/ui/package.json", &package(r#""fast-check":"4""#));
        tmp.write(
            "crates/core/Cargo.toml",
            "[dev-dependencies]\nproptest = \"1\"\n",
        );
        tmp.write("backend/requirements.txt", "hypothesis==6\n");
        tmp.write(
            "node_modules/dep/package.json",
            &package(r#""@stryker-mutator/core":"1""#),
        );
        tmp.write("target/x/Cargo.toml", "[dev-dependencies]\nserde = \"1\"\n");
        tmp.write(
            ".hidden/package.json",
            &package(r#""@playwright/test":"1""#),
        );
        let found = detect(tmp.path(), &NoProbe);
        assert_eq!(found.stacks, vec![Stack::Node, Stack::Rust, Stack::Python]);
        assert_eq!(
            installed_ids(&found),
            vec!["fast-check", "proptest", "hypothesis"]
        );
    }

    // ---- node -------------------------------------------------------------------------------------------------------

    #[test]
    fn fast_check_in_package_json_is_installed_and_the_other_node_tools_fit_but_are_not() {
        let tmp = Tmp::new();
        tmp.write("package.json", &package(r#""fast-check":"^4.10.2""#));
        let found = detect(tmp.path(), &NoProbe);
        assert_eq!(found.stacks, vec![Stack::Node]);
        assert_eq!(installed_ids(&found), vec!["fast-check"]);
        let missing: Vec<&str> = found
            .missing()
            .iter()
            .map(|tool| tool.id.as_str())
            .collect();
        assert_eq!(missing, vec!["stryker", "ast-grep", "semgrep"]);
        assert!(found.has_installed());
    }

    #[test]
    fn a_fast_check_helper_package_alone_counts_through_the_prefix_rule() {
        let tmp = Tmp::new();
        tmp.write("package.json", &package(r#""@fast-check/vitest":"0.5.0""#));
        assert_eq!(
            installed_ids(&detect(tmp.path(), &NoProbe)),
            vec!["fast-check"]
        );
    }

    #[test]
    fn stryker_is_its_core_package() {
        let tmp = Tmp::new();
        tmp.write(
            "package.json",
            &package(r#""@stryker-mutator/core":"10.1.1""#),
        );
        assert_eq!(
            installed_ids(&detect(tmp.path(), &NoProbe)),
            vec!["stryker"]
        );
        // The runner plugin alone is not the tool.
        tmp.write(
            "package.json",
            &package(r#""@stryker-mutator/vitest-runner":"10.1.1""#),
        );
        assert!(detect(tmp.path(), &NoProbe).installed().is_empty());
    }

    #[test]
    fn playwright_needs_its_package_and_a_config_and_a_web_app() {
        let tmp = Tmp::new();
        tmp.write(
            "package.json",
            &package(r#""@playwright/test":"1.65.0","vite":"7""#),
        );
        let without = detect(tmp.path(), &NoProbe);
        assert!(fitting_ids(&without).contains(&"playwright"));
        assert!(!installed_ids(&without).contains(&"playwright"));
        tmp.write("playwright.config.ts", "export default {};");
        assert_eq!(
            installed_ids(&detect(tmp.path(), &NoProbe)),
            vec!["playwright"]
        );
    }

    #[test]
    fn e2e_needs_its_package_and_a_config_or_a_spec_file_anywhere_in_the_project() {
        let tmp = Tmp::new();
        tmp.write("package.json", &package(r#""e2e":"0.23.0","vite":"7""#));
        assert!(!installed_ids(&detect(tmp.path(), &NoProbe)).contains(&"e2e"));
        tmp.write("e2e.config.ts", "export default {};");
        assert_eq!(installed_ids(&detect(tmp.path(), &NoProbe)), vec!["e2e"]);
        std::fs::remove_file(tmp.path().join("e2e.config.ts")).unwrap();
        // A spec file four folders down; and one inside node_modules does not count.
        tmp.write("node_modules/x/other.e2e.ts", "");
        assert!(!installed_ids(&detect(tmp.path(), &NoProbe)).contains(&"e2e"));
        tmp.write("tests/flows/checkout/foo.e2e.ts", "");
        assert_eq!(installed_ids(&detect(tmp.path(), &NoProbe)), vec!["e2e"]);
    }

    #[test]
    fn a_walk_stops_at_its_depth_and_ignores_a_file_named_only_the_suffix() {
        let tmp = Tmp::new();
        tmp.write("a/b/c/d/e/f/deep.e2e.ts", "");
        tmp.write(".e2e.ts", "");
        assert!(!any_file_with_suffix(tmp.path(), ".e2e.ts"));
        tmp.write("a/b/c/d/ok.e2e.ts", "");
        assert!(any_file_with_suffix(tmp.path(), ".e2e.ts"));
        assert!(!any_file_with_suffix(tmp.path(), ""));
    }

    #[test]
    fn a_manifest_that_is_huge_or_broken_says_nothing_and_does_not_panic() {
        let tmp = Tmp::new();
        let pad = "x".repeat(1_100_000);
        tmp.write(
            "package.json",
            &format!(r#"{{"devDependencies":{{"fast-check":"4"}},"pad":"{pad}"}}"#),
        );
        assert!(detect(tmp.path(), &NoProbe).installed().is_empty());
        tmp.write("package.json", "{ this is not json");
        assert!(detect(tmp.path(), &NoProbe).installed().is_empty());
        tmp.write("package.json", "[1, 2, 3]");
        assert!(detect(tmp.path(), &NoProbe).installed().is_empty());
        tmp.write("Cargo.toml", "this = [is not toml");
        assert!(detect(tmp.path(), &NoProbe).installed().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_package_json_is_not_the_projects_manifest() {
        let tmp = Tmp::new();
        tmp.write("outside/package.json", &package(r#""fast-check":"4""#));
        std::fs::create_dir_all(tmp.path().join("project")).unwrap();
        std::os::unix::fs::symlink(
            tmp.path().join("outside/package.json"),
            tmp.path().join("project/package.json"),
        )
        .unwrap();
        let found = detect(&tmp.path().join("project"), &NoProbe);
        assert!(found.stacks.is_empty());
        assert!(found.fitting.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_subfolder_is_not_searched() {
        let tmp = Tmp::new();
        tmp.write("outside/package.json", &package(r#""fast-check":"4""#));
        std::fs::create_dir_all(tmp.path().join("project")).unwrap();
        std::os::unix::fs::symlink(
            tmp.path().join("outside"),
            tmp.path().join("project/linked"),
        )
        .unwrap();
        assert!(detect(&tmp.path().join("project"), &NoProbe)
            .stacks
            .is_empty());
    }

    // ---- rust -------------------------------------------------------------------------------------------------------

    #[test]
    fn proptest_counts_in_every_dev_dependencies_spelling() {
        let cases = [
            "[dev-dependencies]\nproptest = \"1.12\"\n",
            "[dev-dependencies]\nproptest = { version = \"1.12\", features = [\"std\"] }\n",
            "[dev-dependencies.proptest]\nversion = \"1.12\"\n",
            "[target.'cfg(unix)'.dev-dependencies]\nproptest = \"1.12\"\n",
            "[dev_dependencies]\nproptest = \"1.12\"\n",
        ];
        for (at, manifest) in cases.iter().enumerate() {
            let tmp = Tmp::new();
            tmp.write("Cargo.toml", manifest);
            let found = detect(tmp.path(), &NoProbe);
            assert_eq!(found.stacks, vec![Stack::Rust], "case {at}");
            assert_eq!(installed_ids(&found), vec!["proptest"], "case {at}");
        }
    }

    #[test]
    fn proptest_only_in_dependencies_or_build_dependencies_is_not_a_dev_dependency() {
        let tmp = Tmp::new();
        tmp.write(
            "Cargo.toml",
            "[dependencies]\nproptest = \"1\"\n[build-dependencies]\nproptest = \"1\"\n",
        );
        let found = detect(tmp.path(), &NoProbe);
        assert!(fitting_ids(&found).contains(&"proptest"));
        assert!(found.installed().is_empty());
    }

    // ---- python -----------------------------------------------------------------------------------------------------

    #[test]
    fn a_pyproject_names_its_dependencies_in_every_table() {
        let cases = [
            "[project]\nname = \"x\"\ndependencies = [\"requests>=2\", \"Hypothesis[numpy]>=6.0\"]\n\
             [project.optional-dependencies]\ndev = [\"mutmut==3.8.1\"]\n",
            "[tool.poetry.group.dev.dependencies]\nHypothesis = \"^6\"\nmutmut = \"^3\"\n",
            "[tool.poetry.dev-dependencies]\nhypothesis = \"^6\"\nmutmut = \"^3\"\n",
            "[dependency-groups]\ntest = [\"hypothesis>=6\", {include-group = \"lint\"}]\nmut = [\"mutmut\"]\n",
            "[tool.uv]\ndev-dependencies = [\"hypothesis>=6\", \"mut_mut\"]\n",
        ];
        for (at, manifest) in cases.iter().enumerate() {
            let tmp = Tmp::new();
            tmp.write("pyproject.toml", manifest);
            let found = detect(tmp.path(), &NoProbe);
            assert_eq!(found.stacks, vec![Stack::Python], "case {at}");
            assert!(installed_ids(&found).contains(&"hypothesis"), "case {at}");
            // `mut_mut` (uv) is a different package; every other case names mutmut.
            assert_eq!(
                installed_ids(&found).contains(&"mutmut"),
                at != 4,
                "case {at}"
            );
        }
    }

    #[test]
    fn a_requirements_file_is_read_with_extras_markers_options_comments_crlf_and_a_bom() {
        let tmp = Tmp::new();
        tmp.write(
            "requirements-dev.txt",
            "\u{feff}-r base.txt\r\n# a comment\r\n--index-url https://example.com/simple\r\n\
             Hypothesis[numpy]>=6.0 ; python_version>\"3\"\r\nmutmut @ https://example.com/mutmut.whl\r\n\
             git+https://example.com/x.git#egg=other\r\n",
        );
        let found = detect(tmp.path(), &NoProbe);
        assert_eq!(found.stacks, vec![Stack::Python]);
        assert_eq!(installed_ids(&found), vec!["hypothesis", "mutmut"]);
    }

    #[test]
    fn requirement_lines_name_the_package_and_nothing_else() {
        let name = requirement_name;
        assert_eq!(name("Hypothesis_Extra>=1"), Some("hypothesis-extra".into()));
        assert_eq!(
            name("  schemathesis==4.33.4  # pinned"),
            Some("schemathesis".into())
        );
        assert_eq!(name("a.b_c-d"), Some("a-b-c-d".into()));
        assert_eq!(name("a-_-b"), Some("a-b".into()));
        assert_eq!(name("# schemathesis"), None);
        assert_eq!(name("-e ."), None);
        assert_eq!(name("-r base.txt"), None);
        assert_eq!(name(""), None);
        assert_eq!(name("https://example.com/x.whl"), None);
        assert_eq!(name("[odd]"), None);
        assert_eq!(name("&& rm -rf ~"), None);
    }

    #[test]
    fn the_python_tools_by_package_or_by_program() {
        let tmp = Tmp::new();
        tmp.write("requirements.txt", "requests\n");
        let none = detect(tmp.path(), &NoProbe);
        assert!(none.installed().is_empty());
        assert_eq!(
            fitting_ids(&none),
            vec!["hypothesis", "mutmut", "ast-grep", "semgrep"]
        );
        // mutmut on the PATH counts too, and the probe is asked for exactly that program.
        let probe = FakeProbe::with(&[&["mutmut", "--version"]]);
        assert_eq!(installed_ids(&detect(tmp.path(), &probe)), vec!["mutmut"]);
    }

    // ---- openapi ----------------------------------------------------------------------------------------------------

    #[test]
    fn an_openapi_file_in_the_root_or_a_docs_folder_is_a_stack_and_schemathesis_fits() {
        let tmp = Tmp::new();
        tmp.write("openapi.yaml", "openapi: 3.0.0\n");
        assert_eq!(openapi_file(tmp.path()), Some("openapi.yaml".to_string()));
        let found = detect(tmp.path(), &NoProbe);
        assert_eq!(found.stacks, vec![Stack::Openapi]);
        assert_eq!(fitting_ids(&found), vec!["schemathesis"]);
        assert!(found.installed().is_empty());

        let other = Tmp::new();
        other.write("docs/openapi.json", "{}");
        assert_eq!(
            openapi_file(other.path()),
            Some("docs/openapi.json".to_string())
        );
        other.write("swagger.json", "{}");
        assert_eq!(openapi_file(other.path()), Some("swagger.json".to_string()));
        let nothing = Tmp::new();
        nothing.write("notes/openapi.yaml", "x");
        assert_eq!(openapi_file(nothing.path()), None);
    }

    #[test]
    fn schemathesis_is_installed_as_a_python_package() {
        let tmp = Tmp::new();
        tmp.write("openapi.yml", "openapi: 3.0.0\n");
        tmp.write("requirements.txt", "schemathesis==4.33.4\n");
        assert_eq!(
            installed_ids(&detect(tmp.path(), &NoProbe)),
            vec!["schemathesis"]
        );
    }

    #[test]
    fn the_base_url_is_only_what_the_openapi_file_declares_and_only_on_this_computer() {
        let tmp = Tmp::new();
        let yaml = |servers: &str| {
            format!("openapi: 3.0.0\ninfo:\n  title: t\nservers:\n{servers}\npaths: {{}}\n")
        };
        let url = |text: &str| {
            tmp.write("openapi.yaml", text);
            declared_base_url(tmp.path(), "openapi.yaml")
        };
        assert_eq!(
            url(&yaml(
                "  - url: http://localhost:8000\n    description: local"
            )),
            Some("http://localhost:8000".to_string())
        );
        assert_eq!(
            url(&yaml("  - url: \"http://127.0.0.1:3000/api\"  # dev")),
            Some("http://127.0.0.1:3000/api".to_string())
        );
        assert_eq!(
            url(&yaml("  - {url: 'http://[::1]:9000', description: x}")),
            Some("http://[::1]:9000".to_string())
        );
        assert_eq!(
            url(&yaml("    - url: http://127.1.2.3/v1\r")),
            Some("http://127.1.2.3/v1".to_string())
        );
        // Not on this computer, relative, templated, with a password, or not there: nothing is guessed.
        for servers in [
            "  - url: https://api.example.com/v1",
            "  - url: /api/v1",
            "  - url: https://{host}/v1",
            "  - url: http://localhost:{port}",
            "  - url: http://user:secret@localhost:8000",
            "  - url: http://localhost.evil.example",
            "  - description: no url here\n  - url: http://localhost:1",
            "  - url: ",
        ] {
            assert_eq!(url(&yaml(servers)), None, "{servers}");
        }
        assert_eq!(url("openapi: 3.0.0\npaths: {}\n"), None);
        assert_eq!(
            url("openapi: 3.0.0\nx-servers:\n  - url: http://localhost:1\n"),
            None
        );
        assert_eq!(url("servers: []\n"), None);
    }

    #[test]
    fn the_base_url_is_read_from_a_json_description_too_and_never_from_outside_the_project() {
        let tmp = Tmp::new();
        tmp.write(
            "docs/openapi.json",
            r#"{"openapi":"3.0.0","servers":[{"url":"http://localhost:5000"},{"url":"https://prod.example.com"}]}"#,
        );
        assert_eq!(
            declared_base_url(tmp.path(), "docs/openapi.json"),
            Some("http://localhost:5000".to_string())
        );
        tmp.write(
            "docs/openapi.json",
            r#"{"servers":[{"url":"https://prod.example.com"}]}"#,
        );
        assert_eq!(declared_base_url(tmp.path(), "docs/openapi.json"), None);
        tmp.write("docs/openapi.json", r#"{"servers":[]}"#);
        assert_eq!(declared_base_url(tmp.path(), "docs/openapi.json"), None);
        tmp.write("docs/openapi.json", "not json");
        assert_eq!(declared_base_url(tmp.path(), "docs/openapi.json"), None);
        for bad in [
            "../openapi.json",
            "/etc/passwd",
            "docs//openapi.json",
            "docs\\openapi.json",
            "",
        ] {
            assert_eq!(declared_base_url(tmp.path(), bad), None, "{bad:?}");
        }
    }

    #[test]
    fn only_a_host_on_this_computer_is_a_loopback_url() {
        for ok in [
            "http://localhost",
            "HTTP://LOCALHOST:8080/x",
            "https://127.0.0.1",
            "http://127.255.255.254:1",
            "http://[::1]",
            "http://[::1]:8000/api",
        ] {
            assert_eq!(loopback_url(ok), Some(ok.to_string()), "{ok}");
        }
        for bad in [
            "",
            "localhost:8000",
            "ftp://localhost",
            "http://localhost:99999",
            "http://localhost:",
            "http://localhost:80a",
            "http://127.0.0.1.evil.com",
            "http://127.1",
            "http://128.0.0.1",
            "http://0.0.0.0:80",
            "http://[::2]",
            "http://[::1",
            "http://[::1]x",
            "http://",
            "http:///path",
            "http://local host",
            "http://localhost\\@evil.com",
        ] {
            assert_eq!(loopback_url(bad), None, "{bad}");
        }
    }

    // ---- programs and marker files ----------------------------------------------------------------------------------

    #[test]
    fn cargo_mutants_is_installed_only_when_its_program_answers() {
        let tmp = Tmp::new();
        tmp.write("Cargo.toml", "[package]\nname = \"x\"\n");
        let absent = FakeProbe::with(&[]);
        assert!(!installed_ids(&detect(tmp.path(), &absent)).contains(&"cargo-mutants"));
        let present = FakeProbe::with(&[&["cargo", "mutants", "--version"]]);
        assert_eq!(
            installed_ids(&detect(tmp.path(), &present)),
            vec!["cargo-mutants"]
        );
        // A project that isn't Rust never asks, whatever is on the PATH.
        let other = Tmp::new();
        other.write("package.json", &package(""));
        let asked = FakeProbe::with(&[&["cargo", "mutants", "--version"]]);
        assert!(!installed_ids(&detect(other.path(), &asked)).contains(&"cargo-mutants"));
        assert!(!asked.has_asked_for(&["cargo", "mutants", "--version"]));
    }

    #[test]
    fn any_of_stops_at_the_first_answer_so_a_program_is_only_run_when_needed() {
        let tmp = Tmp::new();
        tmp.write(
            "pyproject.toml",
            "[project]\nname = \"x\"\ndependencies = [\"mutmut\"]\n",
        );
        let probe = FakeProbe::with(&[]);
        let found = detect(tmp.path(), &probe);
        assert!(installed_ids(&found).contains(&"mutmut"));
        // mutmut's package was found, so its program is never asked about. ast-grep stops at its missing sgconfig.yml.
        // Only semgrep, whose program is its first test, probes (once).
        assert!(!probe.has_asked_for(&["mutmut", "--version"]));
        assert!(probe.has_asked_for(&["semgrep", "--version"]));
        assert_eq!(probe.calls(), 1);
    }

    #[test]
    fn ast_grep_needs_its_config_and_its_program_or_package() {
        let tmp = Tmp::new();
        tmp.write("package.json", &package(""));
        // Only the program: no config, so the program is never asked about.
        let probe = FakeProbe::with(&[&["ast-grep", "--version"]]);
        let found = detect(tmp.path(), &probe);
        assert!(!installed_ids(&found).contains(&"ast-grep"));
        assert!(!probe.has_asked_for(&["ast-grep", "--version"]));
        // The config and the package.
        tmp.write("sgconfig.yml", "ruleDirs: [rules]\n");
        tmp.write("package.json", &package(r#""@ast-grep/cli":"0.51.2""#));
        let by_package = FakeProbe::with(&[]);
        assert_eq!(
            installed_ids(&detect(tmp.path(), &by_package)),
            vec!["ast-grep"]
        );
        // The config and the program on the PATH.
        tmp.write("package.json", &package(""));
        assert_eq!(installed_ids(&detect(tmp.path(), &probe)), vec!["ast-grep"]);
        // The config alone is not the tool.
        assert!(detect(tmp.path(), &FakeProbe::with(&[]))
            .installed()
            .is_empty());
    }

    #[test]
    fn semgrep_needs_its_program_and_the_projects_own_config() {
        let tmp = Tmp::new();
        tmp.write("package.json", &package(""));
        let has = FakeProbe::with(&[&["semgrep", "--version"]]);
        assert!(detect(tmp.path(), &has).installed().is_empty());
        tmp.write(".semgrep.yml", "rules: []\n");
        assert_eq!(installed_ids(&detect(tmp.path(), &has)), vec!["semgrep"]);
        assert_eq!(semgrep_config(tmp.path()), Some(".semgrep.yml".to_string()));
        // The config without the program is not installed.
        assert!(detect(tmp.path(), &FakeProbe::with(&[]))
            .installed()
            .is_empty());
        // The `.semgrep` folder works too, and the file wins when both exist.
        std::fs::remove_file(tmp.path().join(".semgrep.yml")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".semgrep")).unwrap();
        assert_eq!(semgrep_config(tmp.path()), Some(".semgrep".to_string()));
        assert_eq!(installed_ids(&detect(tmp.path(), &has)), vec!["semgrep"]);
        std::fs::remove_dir_all(tmp.path().join(".semgrep")).unwrap();
        assert_eq!(semgrep_config(tmp.path()), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_marker_file_or_folder_is_not_a_marker() {
        let tmp = Tmp::new();
        tmp.write("elsewhere/sgconfig.yml", "x");
        std::fs::create_dir_all(tmp.path().join("elsewhere/rules")).unwrap();
        tmp.write(
            "project/package.json",
            &package(r#""@ast-grep/cli":"0.51.2""#),
        );
        std::os::unix::fs::symlink(
            tmp.path().join("elsewhere/sgconfig.yml"),
            tmp.path().join("project/sgconfig.yml"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            tmp.path().join("elsewhere/rules"),
            tmp.path().join("project/.semgrep"),
        )
        .unwrap();
        let project = tmp.path().join("project");
        assert!(detect(&project, &FakeProbe::with(&[]))
            .installed()
            .is_empty());
        assert_eq!(semgrep_config(&project), None);
    }

    #[test]
    fn a_rule_that_nests_too_deep_or_names_nothing_holds_for_nothing() {
        let facts = Facts::default();
        let program = || Rule::Binary(vec!["tool".to_string(), "--version".to_string()]);
        let nested = |levels: usize| {
            let mut rule = program();
            for _ in 0..levels {
                rule = Rule::AnyOf(vec![rule]);
            }
            rule
        };
        let knows_it = FakeProbe::with(&[&["tool", "--version"]]);
        assert!(eval(&nested(3), &facts, &knows_it));
        assert!(!eval(&nested(12), &facts, &knows_it));
        assert!(!eval(&Rule::AnyOf(vec![]), &facts, &NoProbe));
        assert!(!eval(&Rule::AllOf(vec![]), &facts, &NoProbe));
        assert!(!eval(
            &Rule::Binary(vec![]),
            &facts,
            &FakeProbe::with(&[&[]])
        ));
        assert!(!eval(&Rule::File("package.json".into()), &facts, &NoProbe));
        assert!(!eval(&Rule::Dir(".semgrep".into()), &facts, &NoProbe));
        assert!(!eval(&Rule::FilePrefix("a".into()), &facts, &NoProbe));
        assert!(!eval(&Rule::AnyFileSuffix(".ts".into()), &facts, &NoProbe));
        assert!(!eval(
            &Rule::File("../package.json".into()),
            &facts,
            &NoProbe
        ));
    }

    // ---- the change -------------------------------------------------------------------------------------------------

    #[test]
    fn a_change_touches_the_ui_only_in_a_web_app_and_only_for_a_file_a_browser_shows() {
        let paths = |list: &[&str]| list.iter().map(|path| path.to_string()).collect::<Vec<_>>();
        assert!(touches_ui(
            &[Stack::Node, Stack::Web],
            &paths(&["src/lib.rs", "src/App.tsx"])
        ));
        assert!(touches_ui(&[Stack::Web], &paths(&["app/Header.vue"])));
        assert!(!touches_ui(
            &[Stack::Web],
            &paths(&["src/lib.rs", "README.md"])
        ));
        assert!(!touches_ui(
            &[Stack::Node, Stack::Rust],
            &paths(&["src/App.tsx"])
        ));
        assert!(!touches_ui(&[Stack::Web], &[]));
        assert!(!touches_ui(&[], &paths(&["src/App.tsx"])));
    }
}
