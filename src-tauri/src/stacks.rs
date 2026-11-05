// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer apps/devstack (Apache-2.0): stack-id, ports, env-block, compose, registry, status, down.
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// HumanLayer's own services (WorkOS, MinIO, Redis, Postgres seeding) are not included.

//! One stack per worktree: a stable id, a block of ports, a Compose project, a gitignored env file.
//!
//! A project with no `stack` in its imported project file is untouched. Docker is only called when
//! the declaration names a compose file that is actually in the worktree. A dev copy keeps its own
//! registry and a higher port range. Tests pass a stand-in; the `stand-in` file is read only when
//! this crate is built for tests, so a release build never treats it as Docker.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::stack_decl::StackDecl;

const BLOCK: u16 = 10;
const DAILY_BASE: u16 = 22_000;
const DEV_BASE: u16 = 42_000;
const SPAN: u16 = 6_000;
const LOCK_ATTEMPTS: u32 = 40;
const LOCK_WAIT: Duration = Duration::from_millis(25);
const LOCK_STALE: Duration = Duration::from_secs(300);
const DOCKER_WAIT: Duration = Duration::from_secs(20);
const DOCKER_LATER: &str =
    "Docker didn't answer. The stack was left as it was and can be tried again.";

pub struct StackEnv {
    pub dev: bool,
    pub data_dir: PathBuf,
    pub compose: Option<Arc<dyn ComposeRunner>>,
    pub probe: Option<Arc<dyn PortProbe>>,
}

pub trait ComposeRunner: Send + Sync {
    fn up(&self, request: &UpRequest) -> Result<(), ComposeFailure>;
    fn down(&self, project: &str, compose_file: Option<&Path>) -> Result<(), ComposeFailure>;
}

pub struct UpRequest {
    pub project: String,
    pub compose_file: PathBuf,
    pub env_file: PathBuf,
    pub services: Vec<String>,
    pub cwd: PathBuf,
}

#[derive(Debug)]
pub enum ComposeFailure {
    TimedOut,
    Unreachable,
    Failed(String),
}

pub trait PortProbe: Send + Sync {
    fn free(&self, port: u16) -> bool;
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Assigned {
    env: String,
    port: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    key: String,
    worktree: String,
    project: String,
    compose_project: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    compose_file: Option<String>,
    has_compose: bool,
    block: u16,
    ports: Vec<Assigned>,
    env: BTreeMap<String, String>,
    url: Option<String>,
    running: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Store {
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    stacks: Vec<Entry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackRow {
    pub id: String,
    pub worktree: String,
    pub compose_project: String,
    pub url: Option<String>,
    pub running: bool,
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub declared: bool,
    pub url: Option<String>,
    pub stacks: Vec<StackRow>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleRow {
    pub id: String,
    pub worktree: String,
    pub compose_project: String,
}

pub fn env_from_app(app: &AppHandle) -> Result<StackEnv, String> {
    Ok(StackEnv {
        dev: crate::instance::kind() != crate::instance::Kind::Daily,
        data_dir: crate::project_file::data_dir(app)?,
        compose: None,
        probe: None,
    })
}

/// Ports and env for a long-running action whose imported project file declares a stack.
/// Anything else returns an empty list and does not create a registry or call Docker.
pub fn maybe_start(
    env: &StackEnv,
    project: &Path,
    worktree: &Path,
    long_running: bool,
    stack: Option<&StackDecl>,
) -> Result<Vec<(String, String)>, String> {
    let Some(stack) = stack else {
        return Ok(Vec::new());
    };
    if !long_running {
        return Ok(Vec::new());
    }
    crate::stack_decl::validate(stack)?;
    let worktree = canonical(worktree)?;
    let project = canonical(project)?;
    let compose_file = compose_file(stack, &worktree)?;
    ignore_env_file(&project, &worktree)?;
    let dir = registry_dir(&env.data_dir);
    let entry = update(&dir, |store| {
        reserve(
            env,
            store,
            &project,
            &worktree,
            stack,
            compose_file.as_deref(),
        )
    })?;
    write_env_file(&worktree, &entry)?;
    if entry.has_compose {
        let Some(compose_file) = compose_file else {
            return Err("The compose file is missing, so nothing was started.".into());
        };
        let request = UpRequest {
            project: entry.compose_project.clone(),
            compose_file,
            env_file: env_path(&worktree),
            services: service_names(stack),
            cwd: worktree.clone(),
        };
        with_retry(|| compose_of(env).up(&request))?;
    }
    let key = entry.key.clone();
    let id = entry.id.clone();
    update(&dir, |store| {
        if let Some(found) = store
            .stacks
            .iter_mut()
            .find(|item| item.id == id && keys_eq(&item.key, &key))
        {
            found.running = true;
        }
        Ok(())
    })?;
    Ok(entry.env.into_iter().collect())
}

pub fn down(env: &StackEnv, worktree: &Path) -> Result<(), String> {
    let dir = registry_dir(&env.data_dir);
    let key = path_key(worktree);
    let store = load(&dir)?;
    let Some(entry) = store
        .stacks
        .iter()
        .find(|item| keys_eq(&item.key, &key))
        .cloned()
    else {
        return Ok(());
    };
    stop_entry(env, &entry)?;
    update(&dir, |store| {
        if let Some(found) = store.stacks.iter_mut().find(|item| item.id == entry.id) {
            found.running = false;
        }
        Ok(())
    })
}

/// Stop the stack for a pool slot, before the slot is returned. No registry means nothing to stop.
pub fn stop_for_worktree(data_dir: &Path, worktree: &Path) -> Result<(), String> {
    let env = StackEnv {
        dev: false,
        data_dir: data_dir.to_path_buf(),
        compose: None,
        probe: None,
    };
    down(&env, worktree)
}

pub fn stale(env: &StackEnv) -> Result<Vec<StaleRow>, String> {
    let store = load(&registry_dir(&env.data_dir))?;
    Ok(store
        .stacks
        .iter()
        .filter(|entry| missing(Path::new(&entry.worktree)))
        .map(|entry| StaleRow {
            id: entry.id.clone(),
            worktree: crate::fs::path_to_js(Path::new(&entry.worktree)),
            compose_project: entry.compose_project.clone(),
        })
        .collect())
}

pub fn remove_stale(env: &StackEnv, id: &str) -> Result<(), String> {
    if !valid_stack_id(id) {
        return Err("That stack id is not one this app created, so nothing was removed.".into());
    }
    let dir = registry_dir(&env.data_dir);
    let store = load(&dir)?;
    let Some(entry) = store.stacks.iter().find(|item| item.id == id).cloned() else {
        return Err("That stack is not in the list, so nothing was removed.".into());
    };
    if !missing(Path::new(&entry.worktree)) {
        return Err("That worktree is back, so the stack was left in place.".into());
    }
    stop_entry(env, &entry)?;
    update(&dir, |store| {
        let Some(pos) = store.stacks.iter().position(|item| item.id == id) else {
            return Ok(());
        };
        if !missing(Path::new(&store.stacks[pos].worktree)) {
            return Err("That worktree is back, so the stack was left in place.".into());
        }
        store.stacks.remove(pos);
        Ok(())
    })
}

pub fn status_for(env: &StackEnv, cwd: &Path) -> Result<StatusView, String> {
    let store = load(&registry_dir(&env.data_dir))?;
    let main = crate::project_file::main_checkout(cwd).ok();
    let declared = main
        .as_ref()
        .and_then(|root| crate::project_file::trusted_file(&env.data_dir, root))
        .and_then(|file| file.stack)
        .is_some();
    let main_key = main.as_ref().map(|path| path_key(path));
    let cwd_key = path_key(cwd);
    let stacks: Vec<StackRow> = store
        .stacks
        .iter()
        .filter(|entry| {
            main_key
                .as_ref()
                .is_some_and(|key| keys_eq(&entry.project, key))
                || keys_eq(&entry.key, &cwd_key)
        })
        .map(|entry| StackRow {
            id: entry.id.clone(),
            worktree: crate::fs::path_to_js(Path::new(&entry.worktree)),
            compose_project: entry.compose_project.clone(),
            url: entry.url.as_deref().and_then(local_url),
            running: entry.running,
            stale: missing(Path::new(&entry.worktree)),
        })
        .collect();
    let url = task_url(&cwd_key, &stacks);
    Ok(StatusView {
        declared,
        url,
        stacks,
    })
}

fn task_url(cwd_key: &str, rows: &[StackRow]) -> Option<String> {
    if let Some(row) = rows.iter().find(|row| {
        row.running && keys_eq(&path_key(Path::new(&row.worktree)), cwd_key) && row.url.is_some()
    }) {
        return row.url.clone();
    }
    let running: Vec<_> = rows
        .iter()
        .filter(|row| row.running && row.url.is_some())
        .collect();
    if running.len() == 1 {
        return running[0].url.clone();
    }
    None
}

/// `http://127.0.0.1:<port>` or `http://localhost:<port>`, and nothing else.
pub fn local_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let (host, port) = rest.split_once(':')?;
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    if port.is_empty() || port.len() > 5 || !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let number: u16 = port.parse().ok()?;
    if number == 0 {
        return None;
    }
    Some(url.to_string())
}

fn stop_entry(env: &StackEnv, entry: &Entry) -> Result<(), String> {
    if !entry.has_compose {
        return Ok(());
    }
    if !valid_compose_project(&entry.compose_project) {
        return Err(
            "That stack's Compose name is not one this app created, so it was left running.".into(),
        );
    }
    let file = entry.compose_file.as_deref().map(Path::new);
    with_retry(|| compose_of(env).down(&entry.compose_project, file))
}

fn reserve(
    env: &StackEnv,
    store: &mut Store,
    project: &Path,
    worktree: &Path,
    stack: &StackDecl,
    compose_path: Option<&Path>,
) -> Result<Entry, String> {
    let has_file = compose_path.is_some();
    let key = path_key(worktree);
    let project_key = path_key(project);
    let names = port_names(stack);
    if let Some(existing) = store
        .stacks
        .iter_mut()
        .find(|item| keys_eq(&item.key, &key))
    {
        if existing.ports.iter().map(|port| &port.env).eq(names.iter()) {
            let assigned: Vec<(String, u16)> = existing
                .ports
                .iter()
                .map(|port| (port.env.clone(), port.port))
                .collect();
            let (values, url) = materialise(stack, &assigned)?;
            existing.project = project_key;
            existing.worktree = worktree.to_string_lossy().into_owned();
            existing.has_compose = existing.has_compose || has_file;
            if let Some(path) = compose_path {
                existing.compose_file = Some(path.to_string_lossy().into_owned());
            }
            existing.env = values;
            existing.url = url;
            existing.running = !existing.has_compose;
            return Ok(existing.clone());
        }
    }
    let id = if let Some(existing) = store.stacks.iter().find(|item| keys_eq(&item.key, &key)) {
        existing.id.clone()
    } else {
        stack_id(&key, store)
    };
    let compose_project = compose_name(env.dev, &id);
    if !valid_compose_project(&compose_project) {
        return Err("The Compose name could not be made, so nothing was started.".into());
    }
    let (block, assigned) = assign_ports(env, store, &key, &names)?;
    let (values, url) = materialise(stack, &assigned)?;
    let entry = Entry {
        id,
        key,
        worktree: worktree.to_string_lossy().into_owned(),
        project: project_key,
        compose_project,
        compose_file: compose_path.map(|path| path.to_string_lossy().into_owned()),
        has_compose: has_file,
        block,
        ports: assigned
            .iter()
            .map(|(name, port)| Assigned {
                env: name.clone(),
                port: *port,
            })
            .collect(),
        env: values,
        url,
        running: !has_file,
    };
    if let Some(pos) = store
        .stacks
        .iter()
        .position(|item| keys_eq(&item.key, &entry.key))
    {
        store.stacks[pos] = entry.clone();
    } else {
        store.stacks.push(entry.clone());
    }
    Ok(entry)
}

fn assign_ports(
    env: &StackEnv,
    store: &Store,
    key: &str,
    names: &[String],
) -> Result<(u16, Vec<(String, u16)>), String> {
    if names.len() > usize::from(BLOCK) {
        return Err("This stack asks for more ports than one block holds.".into());
    }
    let base = if env.dev { DEV_BASE } else { DAILY_BASE };
    let slots = SPAN / BLOCK;
    let preferred = preferred_block(key);
    let probe = probe_of(env);
    for offset in 0..slots {
        let index = (preferred + offset) % slots;
        let start = base + index * BLOCK;
        let range: Vec<u16> = (0..BLOCK).map(|step| start + step).collect();
        if range.iter().any(|port| taken(store, key, *port)) {
            continue;
        }
        if range.iter().any(|port| !probe.free(*port)) {
            continue;
        }
        let assigned = names
            .iter()
            .enumerate()
            .map(|(index, name)| (name.clone(), start + u16::try_from(index).unwrap_or(0)))
            .collect();
        return Ok((index, assigned));
    }
    Err("No free port block is left, so nothing was started.".into())
}

fn taken(store: &Store, self_key: &str, port: u16) -> bool {
    store
        .stacks
        .iter()
        .filter(|entry| !keys_eq(&entry.key, self_key))
        .any(|entry| {
            entry.block_ports().contains(&port) || entry.ports.iter().any(|item| item.port == port)
        })
}

impl Entry {
    fn block_ports(&self) -> Vec<u16> {
        let base = if self.compose_project.starts_with("hivra-dev-") {
            DEV_BASE
        } else {
            DAILY_BASE
        };
        let start = base + self.block * BLOCK;
        (0..BLOCK).map(|step| start + step).collect()
    }
}

fn preferred_block(key: &str) -> u16 {
    let digest = Sha256::digest(key.as_bytes());
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    (n % u32::from(SPAN / BLOCK)) as u16
}

fn stack_id(key: &str, store: &Store) -> String {
    let hex = hex_encode(Sha256::digest(key.as_bytes()).as_slice());
    for len in [8usize, 12, 16, 24, 32, 64] {
        let id = format!("s{}", &hex[..len]);
        let clash = store
            .stacks
            .iter()
            .any(|entry| entry.id == id && !keys_eq(&entry.key, key));
        if !clash {
            return id;
        }
    }
    format!("s{hex}")
}

fn compose_name(dev: bool, id: &str) -> String {
    if dev {
        format!("hivra-dev-{id}")
    } else {
        format!("hivra-{id}")
    }
}

fn valid_stack_id(id: &str) -> bool {
    let Some(hex) = id.strip_prefix('s') else {
        return false;
    };
    (8..=64).contains(&hex.len())
        && hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn valid_compose_project(name: &str) -> bool {
    let rest = name
        .strip_prefix("hivra-dev-")
        .or_else(|| name.strip_prefix("hivra-"));
    let Some(rest) = rest else {
        return false;
    };
    valid_stack_id(rest)
}

fn port_names(stack: &StackDecl) -> Vec<String> {
    stack
        .services
        .iter()
        .flat_map(|service| service.ports.iter().map(|port| port.env.clone()))
        .collect()
}

fn service_names(stack: &StackDecl) -> Vec<String> {
    let mut names = Vec::new();
    for service in &stack.services {
        let name = service
            .compose
            .clone()
            .unwrap_or_else(|| service.name.clone());
        if service_ok(&name) && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

fn materialise(
    stack: &StackDecl,
    assigned: &[(String, u16)],
) -> Result<(BTreeMap<String, String>, Option<String>), String> {
    let numbers: BTreeMap<String, String> = assigned
        .iter()
        .map(|(name, port)| (name.clone(), port.to_string()))
        .collect();
    let mut env = numbers.clone();
    let mut url = None;
    for service in &stack.services {
        for port in &service.ports {
            if port.url && url.is_none() {
                if let Some(number) = numbers.get(&port.env) {
                    let text = format!("http://127.0.0.1:{number}");
                    url = local_url(&text);
                }
            }
        }
        for (key, value) in &service.env {
            env.insert(key.clone(), substitute(value, &numbers)?);
        }
    }
    Ok((env, url))
}

fn substitute(value: &str, ports: &BTreeMap<String, String>) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find('}')
            .ok_or_else(|| "an env value has an unclosed ${".to_string())?;
        let name = &after[..end];
        let number = ports.get(name).ok_or_else(|| {
            format!("{name} is not a port this stack declares, so nothing was started")
        })?;
        out.push_str(number);
        rest = &after[end + 1..];
    }
    if rest.contains('$') {
        return Err("an env value can only use ${PORT} names this stack declares".into());
    }
    out.push_str(rest);
    Ok(out)
}

fn compose_file(stack: &StackDecl, worktree: &Path) -> Result<Option<PathBuf>, String> {
    let Some(rel) = &stack.compose_file else {
        return Ok(None);
    };
    if !crate::project_file::valid_relative_path(rel) {
        return Err(format!(
            "{rel} is not a path inside the worktree, so nothing was started"
        ));
    }
    let path = worktree.join(rel);
    if !path.is_file() {
        return Err(format!(
            "{rel} is not in this worktree, so nothing was started"
        ));
    }
    let canon = canonical(&path)?;
    if !path_inside(worktree, &canon) {
        return Err("The compose file is outside the worktree, so nothing was started.".into());
    }
    Ok(Some(canon))
}

fn env_path(worktree: &Path) -> PathBuf {
    worktree.join(".monocode").join("stack.env")
}

fn write_env_file(worktree: &Path, entry: &Entry) -> Result<(), String> {
    let dir = worktree.join(".monocode");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let dir_canon = canonical(&dir)?;
    if !path_inside(worktree, &dir_canon) {
        return Err("The env file would sit outside the worktree, so it was not written.".into());
    }
    let target = env_path(worktree);
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err("The env file is a link, so it was left alone.".into());
        }
    }
    let mut body = String::new();
    for (key, value) in &entry.env {
        if !crate::stack_decl::valid_env(key) || value.contains(['\n', '\r', '\0']) {
            return Err(
                "The env block had a value that is not one line, so it was not written.".into(),
            );
        }
        body.push_str(key);
        body.push('=');
        body.push_str(value);
        body.push('\n');
    }
    let tmp = dir.join(format!(".stack.env.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body.as_bytes()).map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        error.to_string()
    })?;
    Ok(())
}

/// Gitignore pattern. Git always wants `/` here, including on Windows.
const ENV_IGNORE: &str = ".monocode/stack.env";

fn uses_crlf(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|pair| pair == b"\r\n")
}

fn ignore_env_file(project: &Path, worktree: &Path) -> Result<(), String> {
    // info/exclude lives in the common git dir. A linked worktree's own git dir does not hold it.
    let git_raw = git_line(worktree, &["rev-parse", "--git-dir"])?;
    let common_raw = git_line(worktree, &["rev-parse", "--git-common-dir"])?;
    let exclude_raw = git_line(worktree, &["rev-parse", "--git-path", "info/exclude"])?;
    let git_dir = canonical(&absolute_in(worktree, git_raw.trim())).map_err(|_| {
        "The git directory could not be checked, so the env file was not written.".to_string()
    })?;
    let common_dir = canonical(&absolute_in(worktree, common_raw.trim())).map_err(|_| {
        "The git directory could not be checked, so the env file was not written.".to_string()
    })?;
    let owned = linked_git_dir(worktree)?;
    if owned != git_dir
        || !path_inside(&common_dir, &git_dir)
        || !sits_in(project, worktree, &git_dir)
        || !sits_in(project, worktree, &common_dir)
    {
        return Err(
            "The git directory is outside this project, so the env file was not written.".into(),
        );
    }
    let exclude = absolute_in(worktree, exclude_raw.trim());
    let Some(parent) = exclude.parent() else {
        return Err("The git exclude file has no folder, so the env file was not written.".into());
    };
    if !parent.exists() {
        let logical = normalize_absolute(parent);
        if !path_inside(&common_dir, &logical) {
            return Err(
                "The git exclude file is outside the git directory, so the env file was not written."
                    .into(),
            );
        }
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let parent_canon = canonical(parent).map_err(|error| error.to_string())?;
    if !path_inside(&common_dir, &parent_canon) {
        return Err(
            "The git exclude file is outside the git directory, so the env file was not written."
                .into(),
        );
    }
    if let Ok(meta) = std::fs::symlink_metadata(&exclude) {
        if meta.file_type().is_symlink() {
            return Err("The git exclude file is a link, so it was left alone.".into());
        }
    }
    let existing = std::fs::read(&exclude).unwrap_or_default();
    let text = String::from_utf8_lossy(&existing);
    if text.lines().any(|line| line.trim() == ENV_IGNORE) {
        return Ok(());
    }
    let newline: &[u8] = if uses_crlf(&existing) { b"\r\n" } else { b"\n" };
    let mut next = existing;
    if !next.is_empty() && !next.ends_with(b"\n") {
        next.extend_from_slice(newline);
    }
    next.extend_from_slice(ENV_IGNORE.as_bytes());
    next.extend_from_slice(newline);
    let tmp = parent.join(format!(".exclude.{}.tmp", std::process::id()));
    std::fs::write(&tmp, &next).map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, &exclude).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        error.to_string()
    })?;
    Ok(())
}

fn sits_in(project: &Path, worktree: &Path, path: &Path) -> bool {
    path_inside(project, path) || path_inside(worktree, path)
}

fn normalize_absolute(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The git dir this worktree's own `.git` names. A link is refused.
fn linked_git_dir(worktree: &Path) -> Result<PathBuf, String> {
    let dot = worktree.join(".git");
    let meta = std::fs::symlink_metadata(&dot).map_err(|_| {
        "This worktree is not a git checkout, so the env file was not written.".to_string()
    })?;
    if meta.file_type().is_symlink() {
        return Err("The worktree git entry is a link, so the env file was not written.".into());
    }
    if meta.is_dir() {
        return canonical(&dot);
    }
    let text = std::fs::read_to_string(&dot).map_err(|error| error.to_string())?;
    let line = text.lines().next().unwrap_or("").trim();
    let Some(raw) = line.strip_prefix("gitdir:") else {
        return Err("This worktree is not a git checkout, so the env file was not written.".into());
    };
    canonical(&absolute_in(worktree, raw.trim()))
}

fn absolute_in(worktree: &Path, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        worktree.join(path)
    }
}

fn git_line(worktree: &Path, args: &[&str]) -> Result<String, String> {
    let run = || {
        let mut cmd = scrubbed("git");
        cmd.current_dir(worktree);
        cmd.env("GIT_CONFIG_NOSYSTEM", "1");
        cmd.env("GIT_CONFIG_COUNT", "0");
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.args(args);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let output = cmd.output().map_err(|_| ComposeFailure::Unreachable)?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(ComposeFailure::Failed(
                "This worktree is not a git checkout, so the env file was not written.".into(),
            ))
        }
    };
    match run() {
        Ok(text) => Ok(text),
        Err(ComposeFailure::Failed(message)) => Err(message),
        Err(ComposeFailure::TimedOut | ComposeFailure::Unreachable) => match run() {
            Ok(text) => Ok(text),
            Err(_) => Err(
                "Git didn't answer, so the env file was not written. It can be tried again.".into(),
            ),
        },
    }
}

fn registry_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("worktree-stacks")
}

fn registry_path(dir: &Path) -> PathBuf {
    dir.join("registry.json")
}

fn update<T>(
    dir: &Path,
    change: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let _lock = Lock::acquire(dir)?;
    let mut store = load(dir)?;
    let result = change(&mut store)?;
    store.revision = store.revision.saturating_add(1);
    save(dir, &store)?;
    Ok(result)
}

fn load(dir: &Path) -> Result<Store, String> {
    let path = registry_path(dir);
    match std::fs::read(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(_) => Err("The stack list couldn't be read, so it was left as it was.".into()),
        Ok(bytes) if bytes.iter().all(|byte| byte.is_ascii_whitespace()) => Ok(Store::default()),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "The stack list couldn't be read, so it was left as it was.".to_string()),
    }
}

fn save(dir: &Path, store: &Store) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let path = registry_path(dir);
    let tmp = dir.join(format!("registry.json.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?;
    {
        let mut file = std::fs::File::create(&tmp).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().ok();
    }
    std::fs::rename(&tmp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        error.to_string()
    })
}

struct Lock {
    path: PathBuf,
}

impl Lock {
    fn acquire(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let path = dir.join(".stack.lock");
        for _ in 0..LOCK_ATTEMPTS {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Self { path }),
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
        Err("The stack list is busy, so nothing was changed.".into())
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn lock_is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > LOCK_STALE)
}

fn compose_of(env: &StackEnv) -> Arc<dyn ComposeRunner> {
    if let Some(runner) = &env.compose {
        return Arc::clone(runner);
    }
    #[cfg(test)]
    {
        let dir = registry_dir(&env.data_dir);
        if dir.join("stand-in").is_file() {
            return Arc::new(FileStandIn { dir });
        }
    }
    Arc::new(RealDocker)
}

fn probe_of(env: &StackEnv) -> Arc<dyn PortProbe> {
    env.probe.clone().unwrap_or_else(|| Arc::new(BindProbe))
}

struct BindProbe;

impl PortProbe for BindProbe {
    fn free(&self, port: u16) -> bool {
        std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok()
    }
}

struct RealDocker;

impl ComposeRunner for RealDocker {
    fn up(&self, request: &UpRequest) -> Result<(), ComposeFailure> {
        if !valid_compose_project(&request.project) {
            return Err(ComposeFailure::Failed(
                "The Compose name is not one this app created.".into(),
            ));
        }
        for service in &request.services {
            if !service_ok(service) {
                return Err(ComposeFailure::Failed(
                    "A service name is not one this stack declared.".into(),
                ));
            }
        }
        let mut cmd = docker_command();
        cmd.current_dir(&request.cwd);
        cmd.arg("compose");
        cmd.arg("-p");
        cmd.arg(&request.project);
        cmd.arg("-f");
        cmd.arg(&request.compose_file);
        cmd.arg("--env-file");
        cmd.arg(&request.env_file);
        cmd.arg("up");
        cmd.arg("-d");
        for service in &request.services {
            cmd.arg(service);
        }
        run_timed(&mut cmd)
    }

    fn down(&self, project: &str, compose_file: Option<&Path>) -> Result<(), ComposeFailure> {
        if !valid_compose_project(project) {
            return Err(ComposeFailure::Failed(
                "The Compose name is not one this app created.".into(),
            ));
        }
        if let Some(file) = compose_file {
            if file.is_file() {
                return compose_down(project, file);
            }
        }
        remove_by_label(project)
    }
}

fn compose_down(project: &str, file: &Path) -> Result<(), ComposeFailure> {
    let mut cmd = docker_command();
    if let Some(cwd) = file.parent() {
        if cwd.is_dir() {
            cmd.current_dir(cwd);
        }
    }
    cmd.arg("compose");
    cmd.arg("-p");
    cmd.arg(project);
    cmd.arg("-f");
    cmd.arg(file);
    cmd.args(["down", "--timeout", "10"]);
    run_timed(&mut cmd)
}

fn service_ok(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && (1..=31).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn remove_by_label(project: &str) -> Result<(), ComposeFailure> {
    let mut list = docker_command();
    list.args([
        "ps",
        "-aq",
        "--filter",
        &format!("label=com.docker.compose.project={project}"),
    ]);
    let output = list.output().map_err(|_| ComposeFailure::Unreachable)?;
    if !output.status.success() {
        return Err(ComposeFailure::Failed(one_line(&output.stderr)));
    }
    let ids: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            line.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        })
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let mut stop = docker_command();
    stop.arg("stop");
    stop.args(&ids);
    run_timed(&mut stop)?;
    let mut remove = docker_command();
    remove.arg("rm");
    remove.args(&ids);
    run_timed(&mut remove)
}

fn docker_command() -> Command {
    let mut cmd = scrubbed("docker");
    for key in ["DOCKER_HOST", "DOCKER_CONTEXT"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd
}

fn scrubbed(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        for key in ["SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC", "SYSTEMDRIVE"] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
    }
    crate::hide_window_console(&mut cmd);
    cmd
}

fn run_timed(cmd: &mut Command) -> Result<(), ComposeFailure> {
    let mut child = cmd.spawn().map_err(|_| ComposeFailure::Unreachable)?;
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr {
            let mut tmp = [0u8; 512];
            while let Ok(n) = pipe.read(&mut tmp) {
                if n == 0 {
                    break;
                }
                let room = 2048usize.saturating_sub(buf.len());
                if room > 0 {
                    buf.extend_from_slice(&tmp[..n.min(room)]);
                }
            }
        }
        buf
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > DOCKER_WAIT => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(ComposeFailure::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(_) => {
                let _ = child.kill();
                let _ = reader.join();
                return Err(ComposeFailure::Unreachable);
            }
        }
    };
    let stderr = reader.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(ComposeFailure::Failed(one_line(&stderr)))
    }
}

fn one_line(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Docker compose failed.");
    let clean: String = line.chars().filter(|c| !c.is_control()).take(180).collect();
    if clean.is_empty() {
        "Docker compose failed.".into()
    } else {
        clean
    }
}

fn with_retry(op: impl Fn() -> Result<(), ComposeFailure>) -> Result<(), String> {
    match op() {
        Ok(()) => Ok(()),
        Err(ComposeFailure::Failed(message)) => Err(message),
        Err(ComposeFailure::TimedOut | ComposeFailure::Unreachable) => match op() {
            Ok(()) => Ok(()),
            Err(ComposeFailure::Failed(message)) => Err(message),
            Err(ComposeFailure::TimedOut | ComposeFailure::Unreachable) => {
                Err(DOCKER_LATER.to_string())
            }
        },
    }
}

fn missing(path: &Path) -> bool {
    matches!(
        std::fs::symlink_metadata(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    crate::fs::canonical(path).map_err(|error| error.to_string())
}

fn path_key(path: &Path) -> String {
    let canon = crate::fs::canonical(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    });
    let text = canon.to_string_lossy();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.into_owned()
    }
}

fn keys_eq(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

fn path_inside(parent: &Path, child: &Path) -> bool {
    let mut parent = parent.components();
    let mut child = child.components();
    loop {
        match (parent.next(), child.next()) {
            (None, _) => return true,
            (Some(left), Some(right)) if component_eq(left, right) => {}
            _ => return false,
        }
    }
}

fn component_eq(left: Component<'_>, right: Component<'_>) -> bool {
    if cfg!(windows) {
        left.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    } else {
        left == right
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
struct FileStandIn {
    dir: PathBuf,
}

#[cfg(test)]
impl ComposeRunner for FileStandIn {
    fn up(&self, request: &UpRequest) -> Result<(), ComposeFailure> {
        self.act("up", &request.project)
    }

    fn down(&self, project: &str, _compose_file: Option<&Path>) -> Result<(), ComposeFailure> {
        self.act("down", project)
    }
}

#[cfg(test)]
impl FileStandIn {
    fn act(&self, verb: &str, project: &str) -> Result<(), ComposeFailure> {
        let mode = std::fs::read_to_string(self.dir.join("stand-in")).unwrap_or_default();
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("log"))
            .map_err(|_| ComposeFailure::Unreachable)?;
        let mode = mode.trim();
        let _ = writeln!(log, "{mode}-{verb} {project}");
        match mode {
            "timeout" => Err(ComposeFailure::TimedOut),
            "unreachable" => Err(ComposeFailure::Unreachable),
            "fail" => Err(ComposeFailure::Failed("The stand-in refused.".into())),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
pub(crate) fn remember_running(
    data_dir: &Path,
    worktree: &Path,
    compose_project: &str,
    has_compose: bool,
) {
    let dir = registry_dir(data_dir);
    let key = path_key(worktree);
    let id = compose_project
        .trim_start_matches("hivra-dev-")
        .trim_start_matches("hivra-")
        .to_string();
    update(&dir, |store| {
        store.stacks.push(Entry {
            id,
            key,
            worktree: worktree.to_string_lossy().into_owned(),
            project: String::new(),
            compose_project: compose_project.to_string(),
            compose_file: None,
            has_compose,
            block: 0,
            ports: Vec::new(),
            env: BTreeMap::new(),
            url: None,
            running: true,
        });
        Ok(())
    })
    .unwrap();
}

#[tauri::command(async)]
pub async fn stack_status(app: AppHandle, cwd: String) -> Result<StatusView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::fs::expand_home(&cwd);
        status_for(&env_from_app(&app)?, &cwd)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn stack_down(app: AppHandle, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::fs::expand_home(&cwd);
        down(&env_from_app(&app)?, &cwd)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn stack_stale(app: AppHandle) -> Result<Vec<StaleRow>, String> {
    tauri::async_runtime::spawn_blocking(move || stale(&env_from_app(&app)?))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn stack_remove_stale(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_stale(&env_from_app(&app)?, &id))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    enum Script {
        Ok,
        Timeout,
        Unreachable,
        Fail,
    }

    struct Mem {
        calls: Mutex<Vec<String>>,
        script: Mutex<Vec<Script>>,
    }

    impl ComposeRunner for Mem {
        fn up(&self, request: &UpRequest) -> Result<(), ComposeFailure> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("up {}", request.project));
            self.next()
        }

        fn down(&self, project: &str, _compose_file: Option<&Path>) -> Result<(), ComposeFailure> {
            self.calls.lock().unwrap().push(format!("down {project}"));
            self.next()
        }
    }

    impl Mem {
        fn next(&self) -> Result<(), ComposeFailure> {
            let mut script = self.script.lock().unwrap();
            let step = if script.is_empty() {
                Script::Ok
            } else {
                script.remove(0)
            };
            match step {
                Script::Ok => Ok(()),
                Script::Timeout => Err(ComposeFailure::TimedOut),
                Script::Unreachable => Err(ComposeFailure::Unreachable),
                Script::Fail => Err(ComposeFailure::Failed("compose failed".into())),
            }
        }
    }

    struct AllFree;

    impl PortProbe for AllFree {
        fn free(&self, _port: u16) -> bool {
            true
        }
    }

    struct Busy(std::collections::HashSet<u16>);

    impl PortProbe for Busy {
        fn free(&self, port: u16) -> bool {
            !self.0.contains(&port)
        }
    }

    struct Tmp {
        root: PathBuf,
    }

    impl Tmp {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "wp87-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let Ok(root) = crate::fs::canonical(&self.root) else {
                return;
            };
            let Ok(tmp) = crate::fs::canonical(std::env::temp_dir()) else {
                return;
            };
            if root != tmp && path_inside(&tmp, &root) {
                let _ = std::fs::remove_dir_all(&root);
            }
        }
    }

    struct Fix {
        tmp: Tmp,
        data: PathBuf,
        main: PathBuf,
        first: PathBuf,
        second: PathBuf,
        runner: Arc<Mem>,
    }

    impl Fix {
        fn new() -> Self {
            let tmp = Tmp::new();
            let main = tmp.root.join("main");
            let first = tmp.root.join("my work").join("café");
            let second = tmp.root.join("other");
            std::fs::create_dir_all(first.parent().unwrap()).unwrap();
            git(&tmp.root, &["init", "-b", "main", main.to_str().unwrap()]);
            std::fs::write(main.join("README"), "hello\n").unwrap();
            git(&main, &["add", "README"]);
            git(&main, &["commit", "-qm", "initial"]);
            git(
                &main,
                &["worktree", "add", "-b", "a", first.to_str().unwrap()],
            );
            git(
                &main,
                &["worktree", "add", "-b", "b", second.to_str().unwrap()],
            );
            for tree in [&first, &second] {
                std::fs::write(tree.join("docker-compose.yml"), "services: {}\n").unwrap();
            }
            Self {
                data: tmp.root.join("data"),
                main,
                first,
                second,
                runner: Arc::new(Mem {
                    calls: Mutex::new(Vec::new()),
                    script: Mutex::new(Vec::new()),
                }),
                tmp,
            }
        }

        fn env(&self) -> StackEnv {
            StackEnv {
                dev: false,
                data_dir: self.data.clone(),
                compose: Some(self.runner.clone()),
                probe: Some(Arc::new(AllFree)),
            }
        }
    }

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_COUNT", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap_or_else(|error| panic!("git failed to start: {error}"));
        assert!(
            output.status.success(),
            "git {args:?} -> {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn decl() -> StackDecl {
        serde_json::from_str(
            r#"{
              "composeFile": "docker-compose.yml",
              "services": [
                {"name": "web", "ports": [{"env": "PORT", "url": true}, {"env": "VITE_PORT"}]},
                {"name": "db", "compose": "postgres", "ports": [{"env": "DATABASE_PORT"}],
                 "env": {"DATABASE_URL": "postgres://127.0.0.1:${DATABASE_PORT}/app"}}
              ]
            }"#,
        )
        .unwrap()
    }

    fn ports_only() -> StackDecl {
        serde_json::from_str(r#"{"services":[{"name":"web","ports":[{"env":"PORT","url":true}]}]}"#)
            .unwrap()
    }

    fn calls(fix: &Fix) -> Vec<String> {
        fix.runner.calls.lock().unwrap().clone()
    }

    #[test]
    fn two_worktrees_get_different_ports_and_compose_names() {
        let fix = Fix::new();
        let env = fix.env();
        let stack = decl();
        let first = maybe_start(&env, &fix.main, &fix.first, true, Some(&stack)).unwrap();
        let second = maybe_start(&env, &fix.main, &fix.second, true, Some(&stack)).unwrap();
        let port = |pairs: &[(String, String)], name: &str| {
            pairs.iter().find(|(key, _)| key == name).unwrap().1.clone()
        };
        assert_ne!(port(&first, "PORT"), port(&second, "PORT"));
        assert_ne!(port(&first, "VITE_PORT"), port(&second, "VITE_PORT"));
        assert_ne!(
            port(&first, "DATABASE_PORT"),
            port(&second, "DATABASE_PORT")
        );
        let url = port(&first, "DATABASE_URL");
        assert!(url.contains(&port(&first, "DATABASE_PORT")), "{url}");
        assert!(!url.contains("${"), "{url}");
        let started = calls(&fix);
        assert_eq!(started.len(), 2, "{started:?}");
        assert_ne!(started[0], started[1]);
        assert!(started[0].starts_with("up hivra-s"), "{started:?}");
        assert!(started[1].starts_with("up hivra-s"), "{started:?}");
        let body = std::fs::read(fix.first.join(".monocode").join("stack.env")).unwrap();
        assert!(!body.contains(&b'\r'), "env file must be LF");
        assert!(body.windows(5).any(|chunk| chunk == b"PORT="));
        let ignored = Command::new("git")
            .current_dir(&fix.first)
            .args(["check-ignore", "-q", ".monocode/stack.env"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_COUNT", "0")
            .status()
            .unwrap();
        assert!(ignored.success());
    }

    #[test]
    fn the_same_worktree_gets_the_same_stack_id_again() {
        let fix = Fix::new();
        let env = fix.env();
        let stack = decl();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack)).unwrap();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack)).unwrap();
        let started = calls(&fix);
        assert_eq!(started.len(), 2, "{started:?}");
        assert_eq!(started[0], started[1]);
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert_eq!(store.stacks.len(), 1);
        assert!(store.stacks[0].running);
    }

    #[test]
    fn down_stops_only_its_own_stack() {
        let fix = Fix::new();
        let env = fix.env();
        let stack = decl();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack)).unwrap();
        maybe_start(&env, &fix.main, &fix.second, true, Some(&stack)).unwrap();
        down(&env, &fix.first).unwrap();
        down(&env, &fix.tmp.root.join("missing")).unwrap();
        let log = calls(&fix);
        let downs: Vec<_> = log
            .iter()
            .filter(|line| line.starts_with("down "))
            .collect();
        assert_eq!(downs.len(), 1, "{log:?}");
        assert!(log[0].ends_with(downs[0].trim_start_matches("down ")));
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        let first = store
            .stacks
            .iter()
            .find(|entry| keys_eq(&entry.key, &path_key(&fix.first)))
            .unwrap();
        let second = store
            .stacks
            .iter()
            .find(|entry| keys_eq(&entry.key, &path_key(&fix.second)))
            .unwrap();
        assert!(!first.running);
        assert!(second.running);
        assert_ne!(first.compose_project, second.compose_project);
    }

    #[test]
    fn a_stale_stack_is_listed_and_stays_until_remove() {
        let fix = Fix::new();
        let env = fix.env();
        let stack = decl();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack)).unwrap();
        maybe_start(&env, &fix.main, &fix.second, true, Some(&stack)).unwrap();
        let id = load(&registry_dir(&env.data_dir))
            .unwrap()
            .stacks
            .iter()
            .find(|entry| keys_eq(&entry.key, &path_key(&fix.first)))
            .unwrap()
            .id
            .clone();
        std::fs::remove_dir_all(&fix.first).unwrap();
        let before = std::fs::read(registry_path(&registry_dir(&env.data_dir))).unwrap();
        let listed = stale(&env).unwrap();
        let after = std::fs::read(registry_path(&registry_dir(&env.data_dir))).unwrap();
        assert_eq!(before, after, "listing stale stacks must not write");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert!(load(&registry_dir(&env.data_dir))
            .unwrap()
            .stacks
            .iter()
            .any(|entry| entry.id == id));
        remove_stale(&env, &id).unwrap();
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert!(store.stacks.iter().all(|entry| entry.id != id));
        assert_eq!(store.stacks.len(), 1);
        let log = calls(&fix);
        assert_eq!(
            log.iter().filter(|line| line.starts_with("down ")).count(),
            1,
            "{log:?}"
        );
        let error = remove_stale(&env, "../etc").unwrap_err();
        assert!(error.contains("not one"), "{error}");
    }

    #[test]
    fn a_project_with_no_stack_is_unchanged() {
        let fix = Fix::new();
        let env = fix.env();
        let stack = decl();
        let none = maybe_start(&env, &fix.main, &fix.first, true, None).unwrap();
        let quiet = maybe_start(&env, &fix.main, &fix.first, false, Some(&stack)).unwrap();
        assert!(none.is_empty());
        assert!(quiet.is_empty());
        assert!(!registry_path(&registry_dir(&env.data_dir)).exists());
        assert!(calls(&fix).is_empty());
        assert!(!fix.first.join(".monocode").join("stack.env").exists());
    }

    #[test]
    fn a_timeout_is_tried_again_and_is_not_final() {
        let fix = Fix::new();
        let env = fix.env();
        fix.runner
            .script
            .lock()
            .unwrap()
            .extend([Script::Timeout, Script::Timeout]);
        let error = maybe_start(&env, &fix.main, &fix.first, true, Some(&decl())).unwrap_err();
        assert_eq!(error, DOCKER_LATER);
        assert_eq!(calls(&fix).len(), 2);
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert_eq!(store.stacks.len(), 1);
        assert!(!store.stacks[0].running);
        let id = store.stacks[0].id.clone();
        fix.runner.script.lock().unwrap().clear();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&decl())).unwrap();
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert_eq!(store.stacks[0].id, id);
        assert!(store.stacks[0].running);
    }

    #[test]
    fn a_compose_failure_is_not_retried() {
        let fix = Fix::new();
        let env = fix.env();
        fix.runner.script.lock().unwrap().push(Script::Fail);
        let error = maybe_start(&env, &fix.main, &fix.first, true, Some(&decl())).unwrap_err();
        assert!(error.contains("compose failed"), "{error}");
        assert_eq!(calls(&fix).len(), 1);
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert_eq!(store.stacks.len(), 1);
        assert!(!store.stacks[0].running);
    }

    #[test]
    fn an_unreachable_docker_is_tried_again() {
        let fix = Fix::new();
        let env = fix.env();
        fix.runner
            .script
            .lock()
            .unwrap()
            .extend([Script::Unreachable, Script::Ok]);
        maybe_start(&env, &fix.main, &fix.first, true, Some(&decl())).unwrap();
        assert_eq!(calls(&fix).len(), 2);
        assert!(load(&registry_dir(&env.data_dir)).unwrap().stacks[0].running);
    }

    #[test]
    fn a_corrupt_registry_is_not_overwritten() {
        let fix = Fix::new();
        let env = fix.env();
        let dir = registry_dir(&env.data_dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(registry_path(&dir), b"{").unwrap();
        let error = maybe_start(&env, &fix.main, &fix.first, true, Some(&decl())).unwrap_err();
        assert!(error.contains("left as it was"), "{error}");
        assert_eq!(std::fs::read(registry_path(&dir)).unwrap(), b"{");
        assert!(calls(&fix).is_empty());
    }

    #[test]
    fn a_crlf_registry_still_reads() {
        let fix = Fix::new();
        let env = fix.env();
        let dir = registry_dir(&env.data_dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            registry_path(&dir),
            b"{\r\n  \"revision\": 3,\r\n  \"stacks\": []\r\n}\r\n",
        )
        .unwrap();
        let listed = stale(&env).unwrap();
        assert!(listed.is_empty());
        let bytes = std::fs::read(registry_path(&dir)).unwrap();
        assert!(uses_crlf(&bytes));
    }

    #[test]
    fn dev_copies_use_a_higher_port_range() {
        let fix = Fix::new();
        let mut env = fix.env();
        env.dev = true;
        let pairs = maybe_start(&env, &fix.main, &fix.first, true, Some(&decl())).unwrap();
        let port: u16 = pairs
            .iter()
            .find(|(key, _)| key == "PORT")
            .unwrap()
            .1
            .parse()
            .unwrap();
        assert!((DEV_BASE..DEV_BASE + SPAN).contains(&port), "{port}");
        let name = calls(&fix)[0].clone();
        assert!(name.starts_with("up hivra-dev-s"), "{name}");
    }

    #[test]
    fn a_busy_port_block_is_skipped() {
        let fix = Fix::new();
        let mut env = fix.env();
        let key = path_key(&fix.first);
        let index = preferred_block(&key);
        let start = DAILY_BASE + index * BLOCK;
        let busy: std::collections::HashSet<u16> = (start..start + BLOCK).collect();
        env.probe = Some(Arc::new(Busy(busy)));
        let pairs = maybe_start(&env, &fix.main, &fix.first, true, Some(&ports_only())).unwrap();
        let port: u16 = pairs
            .iter()
            .find(|(name, _)| name == "PORT")
            .unwrap()
            .1
            .parse()
            .unwrap();
        assert!(!(start..start + BLOCK).contains(&port), "{port}");
    }

    #[test]
    fn a_short_stack_id_grows_on_a_clash() {
        let fix = Fix::new();
        let env = fix.env();
        let key = path_key(&fix.first);
        let short = stack_id(&key, &Store::default());
        update(&registry_dir(&env.data_dir), |store| {
            store.stacks.push(Entry {
                id: short.clone(),
                key: "other-path".into(),
                worktree: fix.second.to_string_lossy().into_owned(),
                project: path_key(&fix.main),
                compose_project: compose_name(false, &short),
                compose_file: None,
                has_compose: false,
                block: 0,
                ports: Vec::new(),
                env: BTreeMap::new(),
                url: None,
                running: false,
            });
            Ok(())
        })
        .unwrap();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&ports_only())).unwrap();
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        let grown = store
            .stacks
            .iter()
            .find(|entry| keys_eq(&entry.key, &key))
            .unwrap();
        assert!(grown.id.starts_with(&short));
        assert!(grown.id.len() > short.len());
    }

    #[test]
    fn several_running_stacks_do_not_guess_a_url() {
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&ports_only())).unwrap();
        maybe_start(&env, &fix.main, &fix.second, true, Some(&ports_only())).unwrap();
        let from_main = status_for(&env, &fix.main).unwrap();
        assert!(from_main.url.is_none(), "{:?}", from_main.url);
        let from_first = status_for(&env, &fix.first).unwrap();
        assert!(from_first.url.unwrap().starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn a_stored_url_that_is_not_local_is_dropped() {
        assert!(local_url("http://127.0.0.1:22010").is_some());
        assert!(local_url("http://localhost:80").is_some());
        assert!(local_url("http://evil.example").is_none());
        assert!(local_url("http://127.0.0.1:22010/admin").is_none());
        assert!(local_url("https://127.0.0.1:22010").is_none());
        assert!(local_url("http://127.0.0.1.evil:80").is_none());
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&ports_only())).unwrap();
        update(&registry_dir(&env.data_dir), |store| {
            store.stacks[0].url = Some("http://evil.example/steal".into());
            Ok(())
        })
        .unwrap();
        let view = status_for(&env, &fix.first).unwrap();
        assert!(view.url.is_none());
        assert!(view.stacks[0].url.is_none());
    }

    #[test]
    fn a_missing_compose_file_changes_nothing() {
        let fix = Fix::new();
        let env = fix.env();
        std::fs::remove_file(fix.first.join("docker-compose.yml")).unwrap();
        let error = maybe_start(&env, &fix.main, &fix.first, true, Some(&decl())).unwrap_err();
        assert!(error.contains("not in this worktree"), "{error}");
        assert!(!registry_path(&registry_dir(&env.data_dir)).exists());
        assert!(calls(&fix).is_empty());
    }

    #[test]
    fn ports_only_never_calls_docker() {
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&ports_only())).unwrap();
        assert!(calls(&fix).is_empty());
        down(&env, &fix.first).unwrap();
        assert!(calls(&fix).is_empty());
        assert!(!load(&registry_dir(&env.data_dir)).unwrap().stacks[0].running);
    }

    #[test]
    fn two_writers_do_not_lose_a_stack() {
        let fix = Fix::new();
        let dir = registry_dir(&fix.data);
        let left = {
            let dir = dir.clone();
            std::thread::spawn(move || {
                update(&dir, |store| {
                    std::thread::sleep(Duration::from_millis(40));
                    store.stacks.push(Entry {
                        id: "s01234567".into(),
                        key: "left".into(),
                        worktree: "left".into(),
                        project: "p".into(),
                        compose_project: "hivra-s01234567".into(),
                        compose_file: None,
                        has_compose: false,
                        block: 1,
                        ports: Vec::new(),
                        env: BTreeMap::new(),
                        url: None,
                        running: false,
                    });
                    Ok(())
                })
            })
        };
        let right = {
            let dir = dir.clone();
            std::thread::spawn(move || {
                update(&dir, |store| {
                    store.stacks.push(Entry {
                        id: "s89abcdef".into(),
                        key: "right".into(),
                        worktree: "right".into(),
                        project: "p".into(),
                        compose_project: "hivra-s89abcdef".into(),
                        compose_file: None,
                        has_compose: false,
                        block: 2,
                        ports: Vec::new(),
                        env: BTreeMap::new(),
                        url: None,
                        running: false,
                    });
                    Ok(())
                })
            })
        };
        left.join().unwrap().unwrap();
        right.join().unwrap().unwrap();
        let store = load(&dir).unwrap();
        assert_eq!(store.stacks.len(), 2);
        assert_eq!(store.revision, 2);
    }

    #[test]
    fn a_worktree_that_returns_does_not_stop_when_it_has_no_compose() {
        let fix = Fix::new();
        std::fs::create_dir_all(registry_dir(&fix.data)).unwrap();
        std::fs::write(registry_dir(&fix.data).join("stand-in"), b"").unwrap();
        remember_running(&fix.data, &fix.first, "hivra-s0123abcd", false);
        stop_for_worktree(&fix.data, &fix.first).unwrap();
        assert!(!registry_dir(&fix.data).join("log").exists());
    }
}
