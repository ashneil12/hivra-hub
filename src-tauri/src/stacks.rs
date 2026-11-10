// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer apps/devstack (Apache-2.0): stack-id, ports, env-block, compose, registry, status, down.
// Translated to Rust. HumanLayer's TypeScript is not vendored.
// HumanLayer's own services (WorkOS, MinIO, Redis, Postgres seeding) are not included.

//! One stack per worktree: a stable id, a block of ports, a Compose project, a gitignored env file.
//!
//! A project with no `stack` in its imported project file is untouched. Docker is only called when
//! the declaration names a compose file that is actually in the worktree. A dev copy keeps its own
//! registry and a higher port range. Tests pass a stand-in; the `stand-in` file is read only when
//! this crate is built for tests, so a release build never treats it as Docker.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::local_services::emulate::{self, ServicePort};
use crate::pinned_tool::Fetcher;
use crate::proxy::labels::{stack_label, MAX_LABEL};
use crate::stack_decl::StackDecl;

const BLOCK: u16 = 10;
const DAILY_BASE: u16 = 22_000;
const DEV_BASE: u16 = 42_000;
const SPAN: u16 = 6_000;
const LOCK_ATTEMPTS: u32 = 40;
const LOCK_WAIT: Duration = Duration::from_millis(25);
/// A lock is only held around small file reads and writes. One older than this
/// belongs to a process that died, and waiting on it would block every stack.
const LOCK_STALE: Duration = Duration::from_secs(30);
const DOCKER_WAIT: Duration = Duration::from_secs(20);
const DOCKER_LATER: &str =
    "Docker didn't answer. The stack was left as it was and can be tried again.";
pub const STACKS_CHANGED: &str = "stacks://changed";

/// One stand-in per stack at a time, in this process. A reset and a start that arrive
/// together must not both stop-then-start, or one Node process is left running with the
/// stack's service ports bound and nothing naming it.
static STAND_IN_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

fn stand_in_lock(stack_dir: &Path) -> Arc<Mutex<()>> {
    let locks = STAND_IN_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(locks.entry(stack_dir.to_path_buf()).or_default())
}

pub struct StackEnv {
    pub dev: bool,
    pub data_dir: PathBuf,
    pub compose: Option<Arc<dyn ComposeRunner>>,
    pub probe: Option<Arc<dyn PortProbe>>,
    /// Shared port claims. Dev copies of one machine use one directory so they
    /// cannot take the same block. None means this registry is the only writer.
    pub claims_dir: Option<PathBuf>,
    /// WP-90: the name registry and the port of the proxy that answers those names.
    pub names: Option<Arc<dyn NameRegistry>>,
    pub proxy_port: Option<u16>,
    /// WP-90: the fake outside services one stack runs.
    pub stand_in: Option<Arc<dyn StandIn>>,
    pub path_env: Option<String>,
}

/// The name registry, as the stack code sees it. Tests pass a memory list.
pub trait NameRegistry: Send + Sync {
    fn add(&self, hostname: &str, port: u16, pid: u32, stack_id: &str) -> Result<(), String>;
    fn remove(&self, hostname: &str, pid: u32) -> Result<(), String>;
}

/// The real registry, in `<data>/proxy/routes.json`.
pub struct RouteNames {
    pub store: crate::proxy::routes::RouteStore,
}

impl NameRegistry for RouteNames {
    fn add(&self, hostname: &str, port: u16, pid: u32, stack_id: &str) -> Result<(), String> {
        self.store
            .add_route_owned(hostname, port, pid, true, Some(stack_id))
            .map_err(|error| error.to_string())
    }

    fn remove(&self, hostname: &str, pid: u32) -> Result<(), String> {
        self.store.remove_route(hostname, Some(pid))
    }
}

/// What a stack asks a stand-in to run.
pub struct StandInRequest {
    /// Seeds and state live here, not in the worktree, so a returned pool slot keeps them.
    pub stack_dir: PathBuf,
    pub services: Vec<ServicePort>,
    pub path_env: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StandInOutcome {
    pub pid: Option<u32>,
    /// One sentence when the stand-in did not start. The stack still runs.
    pub note: Option<String>,
}

pub trait StandIn: Send + Sync {
    fn start(&self, request: &StandInRequest) -> Result<StandInOutcome, String>;
    fn stop(&self, stack_dir: &Path) -> Result<(), String>;
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
    /// Computed for the env file. Not stored: a value can carry a secret, and the
    /// next start builds it again from the project file.
    #[serde(skip)]
    env: BTreeMap<String, String>,
    url: Option<String>,
    running: bool,
    /// WP-90: the worktree's name, its published hostnames, and the process that added them.
    #[serde(default)]
    label: String,
    #[serde(default)]
    names: Vec<Published>,
    #[serde(default)]
    emulated: Vec<Emulated>,
    #[serde(default)]
    owner_pid: u32,
    #[serde(default)]
    proxy_port: Option<u16>,
    #[serde(default)]
    reaches_real: bool,
    /// One sentence about a stand-in that could not start. Cleared on a good start.
    #[serde(default)]
    note: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Published {
    hostname: String,
    port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    service: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Emulated {
    service: String,
    env: String,
    port: u16,
    base_url: String,
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
    /// WP-90: every published name and the URL it opens.
    pub names: Vec<NamedRow>,
    pub emulated: Vec<String>,
    /// One line: "Tests use fake GitHub and Stripe", "Reaches the real internet", or neither.
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRow {
    pub hostname: String,
    pub url: String,
    pub port: u16,
    /// A fake service's name, or none for the app itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    pub emulated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub declared: bool,
    pub url: Option<String>,
    pub stacks: Vec<StackRow>,
    /// The mode line for the app this checkout would open.
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_port: Option<u16>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleRow {
    pub id: String,
    pub worktree: String,
    pub compose_project: String,
}

pub fn env_from_app(app: &AppHandle) -> Result<StackEnv, String> {
    let dev = crate::instance::kind() != crate::instance::Kind::Daily;
    let claims_dir = if dev {
        Some(
            PathBuf::from(crate::dirs_home().ok_or("There is no home folder for stack ports.")?)
                .join(".monocode-hub-dev")
                .join("stack-ports"),
        )
    } else {
        None
    };
    let data_dir = crate::project_file::data_dir(app)?;
    // WP-90: this copy's proxy is already running (lib.rs starts it). A failure here leaves
    // the stack on its local URL rather than stopping it.
    let proxy_port = crate::proxy::server::ensure_running(&data_dir, dev, &HashSet::new()).ok();
    let names = proxy_port.map(|_| {
        Arc::new(RouteNames {
            store: crate::proxy::routes::RouteStore::new(crate::proxy::server::proxy_dir(
                &data_dir,
            )),
        }) as Arc<dyn NameRegistry>
    });
    let path_env = Some(crate::harness::cached_gui_search_path());
    Ok(StackEnv {
        dev,
        data_dir: data_dir.clone(),
        compose: None,
        probe: None,
        claims_dir,
        names,
        proxy_port,
        stand_in: Some(Arc::new(EmulateStandIn::new(data_dir))),
        path_env,
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
    reaches_real: bool,
    person: bool,
) -> Result<Vec<(String, String)>, String> {
    let Some(stack) = stack else {
        return Ok(Vec::new());
    };
    if !long_running {
        return Ok(Vec::new());
    }
    crate::stack_decl::validate(stack)?;
    // WP-90: a declared service that names a real outside account needs the project's word,
    // and then only the person starts it. A crew's tests always meet the stand-in.
    if reaches_real && !person {
        return Err(
            "This stack reaches the real internet, so only the person can start it.".into(),
        );
    }
    if let Some(real) = real_service(stack) {
        if !reaches_real {
            return Err(format!(
                "{real} is a real outside service. Mark the project reaches: real to use it."
            ));
        }
        if !person {
            return Err(format!(
                "{real} is a real outside service, so only the person can start this stack."
            ));
        }
    }
    let worktree = canonical(worktree)?;
    let project = canonical(project)?;
    let compose_file = compose_file(stack, &worktree)?;
    ignore_env_file(&project, &worktree)?;
    let dir = registry_dir(&env.data_dir);
    let previous = load(&dir)?
        .stacks
        .into_iter()
        .find(|item| keys_eq(&item.key, &path_key(&worktree)));
    let mut stopped = false;
    if compose_file.is_none() {
        if let Some(previous) = previous.as_ref().filter(|item| item.has_compose) {
            stop_entry(env, previous)?;
            stopped = true;
        }
    }
    let entry = update(&dir, |store| {
        reserve(
            env,
            store,
            &project,
            &worktree,
            stack,
            compose_file.as_deref(),
            reaches_real,
        )
    })?;
    write_env_file(&worktree, &entry)?;
    // A name the old declaration published and the new one does not goes before the new set:
    // a branch change or a removed service never leaves a stale address behind.
    if !stopped {
        if let Some(previous) = &previous {
            retire_names(env, previous, &entry);
        }
    }
    // A name is published before anything starts: a clash is a refusal, not a wrong address.
    publish_names(env, &entry)?;
    let note = start_stand_in(env, &entry)?;
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
            found.note = note;
        }
        Ok(())
    })?;
    Ok(entry.env.into_iter().collect())
}

/// The first real outside host a stack's declared services name, if any. Every service
/// counts, emulated or not: a fake GitHub whose env also names a real host is still a stack
/// that reaches the internet.
fn real_service(stack: &StackDecl) -> Option<String> {
    for service in &stack.services {
        for value in service.env.values() {
            if let Some(host) = emulate::real_target(value) {
                return Some(emulate::host_name(&host));
            }
        }
    }
    None
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

/// WP-90: put this stack's stand-in back to its seed between runs. Names and ports stay.
pub fn reset(env: &StackEnv, worktree: &Path) -> Result<(), String> {
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
    let note = start_stand_in(env, &entry)?;
    update(&dir, |store| {
        if let Some(found) = store.stacks.iter_mut().find(|item| item.id == entry.id) {
            found.note = note;
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
        claims_dir: None,
        names: Some(Arc::new(RouteNames {
            store: crate::proxy::routes::RouteStore::new(crate::proxy::server::proxy_dir(data_dir)),
        })),
        proxy_port: None,
        stand_in: Some(Arc::new(EmulateStandIn::new(data_dir.to_path_buf()))),
        path_env: None,
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
    })?;
    if let Some(claims) = &env.claims_dir {
        release_claim(claims, &path_key(&env.data_dir), &entry.key)?;
    }
    // Its stand-in is stopped and its names are gone; the seeds go with the stack.
    let dir = stack_dir(&env.data_dir, &entry.id);
    if path_inside(&registry_dir(&env.data_dir), &dir) {
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(())
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
            names: entry
                .names
                .iter()
                .filter_map(|name| {
                    let url = named_url(&name.hostname, entry.proxy_port)?;
                    Some(NamedRow {
                        hostname: name.hostname.clone(),
                        url,
                        port: name.port,
                        service: name.service.clone(),
                        emulated: name.service.is_some(),
                    })
                })
                .collect(),
            emulated: entry
                .emulated
                .iter()
                .map(|service| service.service.clone())
                .collect(),
            mode: entry.mode(),
            note: entry.note.clone(),
        })
        .collect();
    let url = task_url(&cwd_key, &stacks);
    let mode = stacks
        .iter()
        .find(|row| row.running && keys_eq(&path_key(Path::new(&row.worktree)), &cwd_key))
        .or_else(|| (stacks.len() == 1).then(|| &stacks[0]))
        .map(|row| row.mode.clone())
        .unwrap_or_default();
    Ok(StatusView {
        declared,
        url,
        stacks,
        mode,
        proxy_port: env.proxy_port.or_else(|| {
            load(&registry_dir(&env.data_dir))
                .ok()?
                .stacks
                .iter()
                .find_map(|entry| entry.proxy_port)
        }),
    })
}

fn named_url(hostname: &str, proxy_port: Option<u16>) -> Option<String> {
    let port = proxy_port?;
    let url = format!("http://{hostname}:{port}");
    local_url(&url)
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

/// A loopback URL, or one published name (`http://shop-wp-90.localhost:7400`), and nothing else.
pub fn local_url(url: &str) -> Option<String> {
    if url.len() > 300 || !url.starts_with("http://") {
        return None;
    }
    let rest = url.strip_prefix("http://")?;
    let (host, port) = rest.split_once(':')?;
    if port.is_empty()
        || port.len() > 5
        || !port.chars().all(|c| c.is_ascii_digit())
        || port.contains('/')
    {
        return None;
    }
    let number: u16 = port.parse().ok()?;
    if number == 0 {
        return None;
    }
    if host == "127.0.0.1" || host == "localhost" {
        return Some(url.to_string());
    }
    // `.localhost` resolves to loopback by itself (RFC 6761); anything else is not ours.
    let label = host.strip_suffix(".localhost")?;
    crate::proxy::labels::valid_hostname(host).then_some(())?;
    (!label.is_empty()).then(|| url.to_string())
}

/// WP-90: a stack that was still running when the app last quit keeps its names. The proxy is
/// in-process, so the previous owner pid is gone and the new proxy has pruned every name;
/// this puts them back under this process, before anything lists a stack.
pub fn resume_names(env: &StackEnv) -> Result<(), String> {
    let dir = registry_dir(&env.data_dir);
    let store = load(&dir)?;
    if !store.stacks.iter().any(|entry| entry.running) {
        return Ok(());
    }
    let own = std::process::id();
    // A port that is not accepting is not republished: the stand-in has gone, or something
    // else would be reached by the old name.
    let mut open: Vec<(String, String)> = Vec::new();
    if let Some(names) = &env.names {
        for entry in store.stacks.iter().filter(|entry| entry.running) {
            for name in &entry.names {
                if !port_accepts(name.port) {
                    continue;
                }
                // A name another live process holds is not this stack's to take.
                let _ = names.add(&name.hostname, name.port, own, &entry.id);
                open.push((entry.id.clone(), name.hostname.clone()));
            }
        }
    }
    update(&dir, |store| {
        for entry in store.stacks.iter_mut().filter(|entry| entry.running) {
            if env.names.is_some() {
                entry.names.retain(|name| {
                    open.iter()
                        .any(|(id, host)| id == &entry.id && host == &name.hostname)
                });
            }
            entry.owner_pid = own;
            if let Some(proxy_port) = env.proxy_port {
                entry.proxy_port = Some(proxy_port);
                if let Some(app) = entry.names.iter().find(|name| name.service.is_none()) {
                    entry.url = Some(format!("http://{}:{proxy_port}", app.hostname));
                }
            }
        }
        Ok(())
    })
}

/// Whether something on this machine accepts TCP on the loopback port a name points at.
fn port_accepts(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Stop every fake service this data folder started. Called on quit and at the next start,
/// so a stand-in does not keep running after the app is gone.
pub fn stop_stand_ins(data_dir: &Path) -> Result<(), String> {
    let stand_in = EmulateStandIn::new(data_dir.to_path_buf());
    let mut failure = None;
    // An unreadable list is reported, but the stacks folder below is what was started, so it
    // is still walked.
    match load(&registry_dir(data_dir)) {
        Ok(store) => {
            for entry in &store.stacks {
                if let Err(error) = stand_in.stop(&stack_dir(data_dir, &entry.id)) {
                    failure.get_or_insert(error);
                }
            }
        }
        Err(error) => {
            failure.get_or_insert(error);
        }
    }
    let root = registry_dir(data_dir).join("stacks");
    let Ok(canonical_root) = crate::fs::canonical(&root) else {
        return failure.map_or(Ok(()), Err);
    };
    let Ok(read) = std::fs::read_dir(&root) else {
        return failure.map_or(Ok(()), Err);
    };
    for item in read.flatten() {
        let path = item.path();
        if !path.join("emulate.pid").is_file() {
            continue;
        }
        let Ok(canonical) = crate::fs::canonical(&path) else {
            continue;
        };
        // A link that leaves the stacks folder is not this app's stand-in to stop.
        if !path_inside(&canonical_root, &canonical) {
            continue;
        }
        if let Err(error) = stand_in.stop(&canonical) {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

fn stop_entry(env: &StackEnv, entry: &Entry) -> Result<(), String> {
    // WP-90: the stand-in and this stack's names go first, whatever runs in Compose.
    let mut failure = None;
    if let Some(stand_in) = &env.stand_in {
        if let Err(error) = stand_in.stop(&stack_dir(&env.data_dir, &entry.id)) {
            failure = Some(error);
        }
    }
    if let Some(names) = &env.names {
        for name in &entry.names {
            let owner = if entry.owner_pid == 0 {
                std::process::id()
            } else {
                entry.owner_pid
            };
            if let Err(error) = names.remove(&name.hostname, owner) {
                failure.get_or_insert(error);
            }
        }
    }
    if !entry.has_compose {
        return failure.map_or(Ok(()), Err);
    }
    if !valid_compose_project(&entry.compose_project) {
        return Err(
            "That stack's Compose name is not one this app created, so it was left running.".into(),
        );
    }
    let file = compose_file_for_stop(entry);
    with_retry(|| compose_of(env).down(&entry.compose_project, file.as_deref()))?;
    failure.map_or(Ok(()), Err)
}

/// `<data>/worktree-stacks/stacks/<id>`: seeds and stand-in state, kept with the stack.
///
/// An id read from disk is untrusted: only one this app made can name a folder.
fn stack_dir(data_dir: &Path, id: &str) -> PathBuf {
    let base = registry_dir(data_dir).join("stacks");
    if valid_stack_id(id) {
        base.join(id)
    } else {
        base.join("invalid")
    }
}

/// A compose path from the registry is untrusted. Only a real file inside the
/// worktree is passed to Docker. Anything else is stopped by the project name.
fn compose_file_for_stop(entry: &Entry) -> Option<PathBuf> {
    let raw = entry.compose_file.as_deref()?;
    let root = crate::fs::canonical(Path::new(&entry.worktree)).ok()?;
    let file = crate::fs::canonical(Path::new(raw)).ok()?;
    path_inside(&root, &file).then_some(file)
}

/// Names the previous declaration published that this one does not. Only this stack's own.
fn retire_names(env: &StackEnv, previous: &Entry, entry: &Entry) {
    let Some(names) = &env.names else {
        return;
    };
    let owner = if previous.owner_pid == 0 {
        std::process::id()
    } else {
        previous.owner_pid
    };
    for old in &previous.names {
        if !entry.names.iter().any(|name| name.hostname == old.hostname) {
            let _ = names.remove(&old.hostname, owner);
        }
    }
}

/// WP-90: publish every name for this stack, and take back the ones already added if one clashes.
fn publish_names(env: &StackEnv, entry: &Entry) -> Result<(), String> {
    let Some(names) = &env.names else {
        return Ok(());
    };
    let pid = std::process::id();
    let mut added: Vec<&str> = Vec::new();
    for name in &entry.names {
        if let Err(error) = names.add(&name.hostname, name.port, pid, &entry.id) {
            for hostname in added {
                let _ = names.remove(hostname, pid);
            }
            return Err(error);
        }
        added.push(&name.hostname);
    }
    Ok(())
}

/// Start this stack's stand-in. A missing or old Node is a note, not a failed stack: the named
/// base URLs then fail closed (connection refused) rather than reaching the real service.
fn start_stand_in(env: &StackEnv, entry: &Entry) -> Result<Option<String>, String> {
    let Some(stand_in) = &env.stand_in else {
        return Ok(None);
    };
    let dir = stack_dir(&env.data_dir, &entry.id);
    // Stop-then-start is one step: a second reset waits for this one rather than interleaving
    // and leaving the first stand-in running.
    let lock = stand_in_lock(&dir);
    let _one_at_a_time = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    stand_in.stop(&dir)?;
    if entry.emulated.is_empty() {
        return Ok(None);
    }
    let services = entry
        .emulated
        .iter()
        .map(|service| ServicePort {
            service: service.service.clone(),
            port: service.port,
            base_url: service.base_url.clone(),
        })
        .collect();
    let outcome = stand_in.start(&StandInRequest {
        stack_dir: dir,
        services,
        path_env: env.path_env.clone(),
    })?;
    Ok(outcome.note)
}

struct EmulateStandIn {
    data_dir: PathBuf,
    /// The one downloader the app has. A test hands it fixtures instead.
    fetcher: Arc<dyn Fetcher + Send + Sync>,
}

impl EmulateStandIn {
    fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            fetcher: Arc::new(crate::pinned_tool::UreqFetcher),
        }
    }

    /// The tool to run, fetching it the first time and never again. `start` uses the real pin
    /// table; a test passes its own.
    fn tool_for(&self, tarballs: &[emulate::Tarball]) -> Result<PathBuf, StandInOutcome> {
        if let Some(tool) = emulate::installed(&self.data_dir) {
            return Ok(tool);
        }
        match emulate::install_files(&self.data_dir, self.fetcher.as_ref(), tarballs) {
            Ok(tool) => Ok(tool),
            // Nothing was even downloaded, so there is no download to explain.
            Err(_) if !emulate::all_pinned(tarballs) => Err(StandInOutcome {
                pid: None,
                note: Some(emulate::NOT_INSTALLED_NOTE.into()),
            }),
            // Offline, a mismatched file or no disk room: the stack still runs, and its named
            // URLs then fail closed instead of reaching the real service.
            Err(_) => Err(StandInOutcome {
                pid: None,
                note: Some(emulate::DOWNLOAD_NOTE.into()),
            }),
        }
    }

    fn start_with(
        &self,
        request: &StandInRequest,
        tarballs: &[emulate::Tarball],
    ) -> Result<StandInOutcome, String> {
        match emulate::probe_node(request.path_env.clone()) {
            emulate::NodeStatus::Ready { .. } => {}
            emulate::NodeStatus::Unavailable(note) => {
                return Ok(StandInOutcome {
                    pid: None,
                    note: Some(note),
                })
            }
        }
        let tool = match self.tool_for(tarballs) {
            Ok(tool) => tool,
            Err(outcome) => return Ok(outcome),
        };
        // emulate's own precedence: this stack's named URL wins over any environment value.
        let emulate_env = std::env::var("EMULATE_BASE_URL").ok();
        let services: Vec<emulate::ServicePort> = request
            .services
            .iter()
            .map(|service| emulate::ServicePort {
                base_url: crate::local_services::base_url::resolve(
                    crate::local_services::base_url::BaseUrlOptions {
                        service: &service.service,
                        port: service.port,
                        base_url: None,
                        seed_base_url: Some(&service.base_url),
                        emulate_env: emulate_env.as_deref(),
                        portless_env: None,
                    },
                ),
                ..service.clone()
            })
            .collect();
        let (config, notice) = emulate::write_config(&request.stack_dir, &services)?;
        match emulate::start(&emulate::StartRequest {
            stack_dir: request.stack_dir.clone(),
            config,
            tool,
            path_env: request.path_env.clone(),
        }) {
            Ok(pid) => Ok(StandInOutcome {
                pid: Some(pid),
                note: notice,
            }),
            Err(error) => Ok(StandInOutcome {
                pid: None,
                note: Some(format!("The stand-in didn't start: {error}")),
            }),
        }
    }
}

impl StandIn for EmulateStandIn {
    fn start(&self, request: &StandInRequest) -> Result<StandInOutcome, String> {
        self.start_with(request, &emulate::TARBALLS)
    }

    fn stop(&self, stack_dir: &Path) -> Result<(), String> {
        // The tool folder is not consulted: a stand-in from a previous version, or from a
        // data folder whose tools were removed, is ours by its command line and still has to
        // be stopped rather than forgotten.
        emulate::stop(stack_dir)
    }
}

/// The worktree's branch, or none when git cannot answer (detached, missing, or slow).
fn git_branch(worktree: &Path) -> Option<String> {
    git_line(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|branch| branch.trim().to_string())
        .filter(|branch| !branch.is_empty())
}

/// A pool slot lives under a `worktree-pool` folder. Its name comes from its stack id, so a
/// return and a new lease keep the same hostnames and the stand-in's state.
fn is_pool_slot(worktree: &Path) -> bool {
    worktree
        .ancestors()
        .any(|path| path.file_name().is_some_and(|name| name == "worktree-pool"))
}

fn reserve(
    env: &StackEnv,
    store: &mut Store,
    project: &Path,
    worktree: &Path,
    stack: &StackDecl,
    compose_path: Option<&Path>,
    reaches_real: bool,
) -> Result<Entry, String> {
    let has_file = compose_path.is_some();
    let key = path_key(worktree);
    let project_key = path_key(project);
    let names = port_names(stack);
    let emulated_services: Vec<String> = crate::stack_decl::emulated(stack)
        .into_iter()
        .filter_map(|service| service.emulate.clone())
        .collect();
    if let Some(existing) = store
        .stacks
        .iter_mut()
        .find(|item| keys_eq(&item.key, &key))
    {
        let same_ports = existing.ports.iter().map(|port| &port.env).eq(names.iter());
        let same_services = existing
            .emulated
            .iter()
            .map(|service| &service.service)
            .eq(emulated_services.iter());
        if same_ports && same_services {
            let assigned: Vec<(String, u16)> = existing
                .ports
                .iter()
                .map(|port| (port.env.clone(), port.port))
                .collect();
            let emulated_ports: Vec<(String, u16)> = existing
                .emulated
                .iter()
                .map(|service| (service.service.clone(), service.port))
                .collect();
            let (values, url, published, emulated, label) = layout(
                env,
                project,
                worktree,
                &existing.id,
                stack,
                &assigned,
                &emulated_ports,
            )?;
            if let Some(dir) = &env.claims_dir {
                let _lock = Lock::acquire(dir)?;
                let ports: Vec<u16> = assigned
                    .iter()
                    .chain(emulated_ports.iter())
                    .map(|(_, port)| *port)
                    .collect();
                store_claim(dir, &path_key(&env.data_dir), &key, &ports)?;
            }
            existing.project = project_key;
            existing.worktree = worktree.to_string_lossy().into_owned();
            existing.has_compose = has_file;
            existing.compose_file = compose_path.map(|path| path.to_string_lossy().into_owned());
            existing.env = values;
            existing.url = url;
            existing.label = label;
            existing.names = published;
            existing.emulated = emulated;
            existing.owner_pid = std::process::id();
            existing.proxy_port = env.proxy_port;
            existing.reaches_real = reaches_real;
            existing.running = !has_file;
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
    let (block, assigned, emulated_ports) =
        assign_ports(env, store, &key, names.len(), emulated_services.len())?;
    let assigned: Vec<(String, u16)> = names.into_iter().zip(assigned).collect();
    let emulated_ports: Vec<(String, u16)> =
        emulated_services.into_iter().zip(emulated_ports).collect();
    let (values, url, published, emulated, label) = layout(
        env,
        project,
        worktree,
        &id,
        stack,
        &assigned,
        &emulated_ports,
    )?;
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
        label,
        names: published,
        emulated,
        owner_pid: std::process::id(),
        proxy_port: env.proxy_port,
        reaches_real,
        note: None,
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

/// The env block, the app URL, the published names, the fake services, and the label.
type Layout = (
    BTreeMap<String, String>,
    Option<String>,
    Vec<Published>,
    Vec<Emulated>,
    String,
);

/// The env block, the app URL, and the names and services this stack publishes.
fn layout(
    env: &StackEnv,
    project: &Path,
    worktree: &Path,
    id: &str,
    stack: &StackDecl,
    assigned: &[(String, u16)],
    emulated_ports: &[(String, u16)],
) -> Result<Layout, String> {
    let (mut values, _) = materialise(stack, assigned)?;
    let label = stack_label(id, git_branch(worktree).as_deref(), is_pool_slot(worktree))
        .filter(|label| label.len() <= MAX_LABEL)
        .ok_or("This worktree's name could not be made, so nothing was started.")?;
    let project_label = project
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".into());
    let app_port = stack
        .services
        .iter()
        .flat_map(|service| service.ports.iter())
        .find(|port| port.url)
        .and_then(|port| {
            assigned
                .iter()
                .find(|(name, _)| *name == port.env)
                .map(|(_, port)| *port)
        })
        .or_else(|| assigned.first().map(|(_, port)| *port));
    let app_url = match (
        app_port,
        env.proxy_port,
        crate::proxy::labels::app_hostname(&project_label, &label),
    ) {
        (Some(_port), Some(proxy), Some(host)) => format!("http://{host}:{proxy}"),
        (Some(port), _, _) => format!("http://127.0.0.1:{port}"),
        (None, _, _) => return Err("This stack publishes no port, so nothing was started.".into()),
    };
    let url = local_url(&app_url);
    values.insert("PUBLIC_URL".into(), app_url.clone());

    let mut published = Vec::new();
    if let (Some(app_port), Some(_), Some(host)) = (
        app_port,
        env.proxy_port,
        crate::proxy::labels::app_hostname(&project_label, &label),
    ) {
        published.push(Published {
            hostname: host,
            port: app_port,
            service: None,
        });
    }
    let mut emulated = Vec::new();
    for service in crate::stack_decl::emulated(stack) {
        let Some(name) = service.emulate.clone() else {
            continue;
        };
        let Some((_, port)) = emulated_ports.iter().find(|(service, _)| *service == name) else {
            continue;
        };
        // The name is what the stand-in advertises (links, the proxy). The env block is what
        // server-side code fetches. Node resolves through the OS, which does not treat
        // `*.localhost` as loopback, so that address is the service's own loopback port.
        let named = match (
            env.proxy_port,
            crate::proxy::labels::service_hostname(&name, &project_label, &label),
        ) {
            (Some(proxy), Some(host)) => {
                published.push(Published {
                    hostname: host.clone(),
                    port: *port,
                    service: Some(name.clone()),
                });
                Some(format!("http://{host}:{proxy}"))
            }
            _ => None,
        };
        let fetch_url = format!("http://127.0.0.1:{port}");
        let env_name = crate::stack_decl::base_url_env(service)
            .ok_or("An emulated service has no URL variable, so nothing was started.")?;
        values.insert(env_name.clone(), fetch_url);
        emulated.push(Emulated {
            service: name,
            env: env_name,
            port: *port,
            base_url: named.unwrap_or_else(|| format!("http://127.0.0.1:{port}")),
        });
    }
    Ok((values, url, published, emulated, label))
}

fn assign_ports(
    env: &StackEnv,
    store: &Store,
    key: &str,
    declared: usize,
    emulated: usize,
) -> Result<(u16, Vec<u16>, Vec<u16>), String> {
    let count = declared + emulated;
    if count > usize::from(BLOCK) {
        return Err("This stack asks for more ports than one block holds.".into());
    }
    let base = if env.dev { DEV_BASE } else { DAILY_BASE };
    let slots = SPAN / BLOCK;
    let preferred = preferred_block(key);
    let probe = probe_of(env);
    let owner = path_key(&env.data_dir);
    // Registry lock is already held. Claims come second, never the other way round.
    let _claims = match &env.claims_dir {
        Some(dir) => Some(Lock::acquire(dir)?),
        None => None,
    };
    let held = match &env.claims_dir {
        Some(dir) => claimed_by_others(dir, &owner, key)?,
        None => HashSet::new(),
    };
    for offset in 0..slots {
        let index = (preferred + offset) % slots;
        let start = base + index * BLOCK;
        let range: Vec<u16> = (0..BLOCK).map(|step| start + step).collect();
        if range
            .iter()
            .any(|port| taken(store, key, *port) || held.contains(port))
        {
            continue;
        }
        if !crate::proxy::ports::block_is_usable(start, BLOCK, &HashSet::new())
            || range.iter().any(|port| !probe.free(*port))
        {
            continue;
        }
        let ports: Vec<u16> = (0..count)
            .map(|index| start + u16::try_from(index).unwrap_or(0))
            .collect();
        if let Some(dir) = &env.claims_dir {
            store_claim(dir, &owner, key, &ports)?;
        }
        // Declared port names come first, then one port per emulated service.
        return Ok((
            index,
            ports[..declared].to_vec(),
            ports[declared..].to_vec(),
        ));
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
    /// One line for the stack card: fake services, the real internet, or neither.
    fn mode(&self) -> String {
        if !self.emulated.is_empty() {
            let names: Vec<&str> = self
                .emulated
                .iter()
                .map(|service| emulate::display_name(&service.service))
                .collect();
            return format!("Tests use fake {}", names.join(" and "));
        }
        if self.reaches_real {
            return "Reaches the real internet".into();
        }
        "No outside services".into()
    }

    fn block_ports(&self) -> Vec<u16> {
        // A stored block is untrusted. Only 0..600 is a real block; anything else
        // contributes no ports, so a wild value cannot panic or look taken.
        let slots = SPAN / BLOCK;
        if self.block >= slots {
            return Vec::new();
        }
        let base = if self.compose_project.starts_with("hivra-dev-") {
            DEV_BASE
        } else {
            DAILY_BASE
        };
        let Some(start) = self
            .block
            .checked_mul(BLOCK)
            .and_then(|span| base.checked_add(span))
        else {
            return Vec::new();
        };
        if start.checked_add(BLOCK - 1).is_none() {
            return Vec::new();
        }
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
    // The env block can hold a database URL. Write it privately, and under a
    // unique name so two starts in one process cannot clobber the same temp file.
    let tmp = tmp_name(&dir, "stack.env");
    write_new_private(&tmp, body.as_bytes()).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    if let Err(error) = make_private(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    std::fs::rename(&tmp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        error.to_string()
    })?;
    Ok(())
}

/// A temporary name no other start can pick. The process id alone repeats
/// after a restart, and a crash can leave the old file behind, so the clock
/// and a counter are in the name too.
fn tmp_name(dir: &Path, what: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|age| age.as_nanos())
        .unwrap_or(0);
    dir.join(format!(".{what}.{}.{stamp}.{n}.tmp", std::process::id()))
}

fn write_new_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all().ok();
    Ok(())
}

#[cfg(unix)]
fn make_private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms).map_err(|error| error.to_string())
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
    let tmp = tmp_name(parent, "exclude");
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    owner: String,
    key: String,
    #[serde(default)]
    ports: Vec<u16>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimFile {
    #[serde(default)]
    claims: Vec<Claim>,
}

fn claims_path(dir: &Path) -> PathBuf {
    dir.join("claims.json")
}

fn load_claims(dir: &Path) -> Result<Vec<Claim>, String> {
    let path = claims_path(dir);
    match std::fs::read(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("The port list couldn't be read, so nothing was started.".into()),
        Ok(bytes) if bytes.iter().all(|byte| byte.is_ascii_whitespace()) => Ok(Vec::new()),
        Ok(bytes) => serde_json::from_slice::<ClaimFile>(&bytes)
            .map(|file| file.claims)
            .map_err(|_| "The port list couldn't be read, so nothing was started.".to_string()),
    }
}

fn save_claims(dir: &Path, claims: &[Claim]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let path = claims_path(dir);
    let tmp = dir.join(format!("claims.json.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(&ClaimFile {
        claims: claims.to_vec(),
    })
    .map_err(|error| error.to_string())?;
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

/// Ports held by any other copy. Our own claim for this worktree is not held:
/// two copies of one worktree must still see each other, and a retry of our own
/// start must not be blocked by the claim we just wrote.
fn claimed_by_others(dir: &Path, owner: &str, key: &str) -> Result<HashSet<u16>, String> {
    let mut held = HashSet::new();
    for claim in load_claims(dir)? {
        if keys_eq(&claim.owner, owner) && keys_eq(&claim.key, key) {
            continue;
        }
        held.extend(claim.ports);
    }
    Ok(held)
}

/// Caller holds the claims lock. A file that cannot be read is left untouched.
fn store_claim(dir: &Path, owner: &str, key: &str, ports: &[u16]) -> Result<(), String> {
    let mut claims = load_claims(dir)?;
    claims.retain(|claim| !(keys_eq(&claim.owner, owner) && keys_eq(&claim.key, key)));
    if !ports.is_empty() {
        claims.push(Claim {
            owner: owner.to_string(),
            key: key.to_string(),
            ports: ports.to_vec(),
        });
    }
    save_claims(dir, &claims)
}

fn release_claim(dir: &Path, owner: &str, key: &str) -> Result<(), String> {
    let _lock = Lock::acquire(dir)?;
    let mut claims = load_claims(dir)?;
    let before = claims.len();
    claims.retain(|claim| !(keys_eq(&claim.owner, owner) && keys_eq(&claim.key, key)));
    if claims.len() == before {
        return Ok(());
    }
    save_claims(dir, &claims)
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
                // Windows can refuse the new lock file while another writer still
                // has it (access denied, sharing violation). That is the same
                // wait as "already exists", not a final failure. Other errors
                // still stop. The attempt budget is unchanged.
                Err(error) if transient_lock(&error) => {
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

/// ERROR_ACCESS_DENIED is 5 and ERROR_SHARING_VIOLATION is 32. The same
/// numbers are real errno values on Unix (EIO, EPIPE), so they count only
/// on Windows.
fn transient_lock(error: &std::io::Error) -> bool {
    transient_lock_code(cfg!(windows), error.raw_os_error())
}

fn transient_lock_code(windows: bool, raw: Option<i32>) -> bool {
    windows && matches!(raw, Some(5) | Some(32))
}

#[cfg(test)]
mod transient_lock_tests {
    use super::transient_lock_code;

    #[test]
    fn only_windows_sharing_and_access_denied_are_retried() {
        assert!(transient_lock_code(true, Some(5)));
        assert!(transient_lock_code(true, Some(32)));
        assert!(!transient_lock_code(true, Some(2)));
        assert!(!transient_lock_code(true, None));
        // 5 and 32 are EIO and EPIPE on Unix, so they must not be retried there.
        assert!(!transient_lock_code(false, Some(5)));
        assert!(!transient_lock_code(false, Some(32)));
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
        // WP-90: the four-address probe portless uses. BSD lets a wildcard bind coexist with a
        // listener on one address, and the proxy dials both loopback families.
        crate::proxy::ports::probe_free(port)
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
        push_compose_up(&mut cmd, request);
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
    push_compose_down(&mut cmd, project, file);
    run_timed(&mut cmd)
}

fn push_compose_up(cmd: &mut Command, request: &UpRequest) {
    cmd.arg("compose");
    cmd.arg("-p");
    cmd.arg(&request.project);
    cmd.arg("-f");
    cmd.arg(&request.compose_file);
    cmd.arg("--env-file");
    cmd.arg(&request.env_file);
    cmd.arg("up");
    cmd.arg("-d");
    // An old container from a service this file no longer names would keep the port.
    cmd.arg("--remove-orphans");
    for service in &request.services {
        cmd.arg(service);
    }
}

fn push_compose_down(cmd: &mut Command, project: &str, file: &Path) {
    cmd.arg("compose");
    cmd.arg("-p");
    cmd.arg(project);
    cmd.arg("-f");
    cmd.arg(file);
    // Volumes stay. Down stops containers, it does not delete their data.
    cmd.args(["down", "--timeout", "10", "--remove-orphans"]);
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
    let ids = container_ids(&String::from_utf8_lossy(&output.stdout))?;
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
    docker_command_from(crate::harness::login_shell_path(), |key| {
        std::env::var_os(key)
    })
}

/// `login_path` is the shell PATH a terminal would have. A Finder launch only
/// has /usr/bin:/bin:/usr/sbin:/sbin, so `docker` on /usr/local/bin or Homebrew
/// is missed. HOME (and the Docker config variables) stay so the CLI can read
/// ~/.docker/config.json: the Desktop context and the compose plugin directory.
/// An empty value is left out. Anything else stays cleared.
fn docker_command_from(
    login_path: Option<String>,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Command {
    let mut cmd = scrubbed("docker");
    if let Some(path) = login_path.filter(|path| !path.is_empty()) {
        cmd.env("PATH", path);
    }
    for key in docker_env_keys() {
        if let Some(value) = var(key).filter(|value| !value.is_empty()) {
            cmd.env(key, value);
        }
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd
}

fn docker_env_keys() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        &[
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "HOME",
            "DOCKER_CONFIG",
            "DOCKER_CERT_PATH",
            "DOCKER_TLS_VERIFY",
            "USERPROFILE",
            "APPDATA",
        ]
    }
    #[cfg(not(windows))]
    {
        &[
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "HOME",
            "DOCKER_CONFIG",
            "DOCKER_CERT_PATH",
            "DOCKER_TLS_VERIFY",
        ]
    }
}

/// `docker ps -q` prints one full id per line. Anything shorter can prefix-match
/// the wrong container, so a bad line fails the whole removal.
fn container_ids(stdout: &str) -> Result<Vec<String>, ComposeFailure> {
    let mut ids = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let ok = (12..=64).contains(&line.len())
            && line
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
        if !ok {
            return Err(ComposeFailure::Failed(
                "Docker returned a container id this app will not remove.".into(),
            ));
        }
        ids.push(line.to_string());
    }
    Ok(ids)
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
    let stdout = child.stdout.take();
    let err_reader = std::thread::spawn(move || capped(stderr));
    // Stdout is discarded, but it has to be read to the end. A full pipe blocks
    // the child until the wait kills it, and the retry then blocks the same way.
    let out_reader = std::thread::spawn(move || discard(stdout));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > DOCKER_WAIT => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = err_reader.join();
                let _ = out_reader.join();
                return Err(ComposeFailure::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(_) => {
                let _ = child.kill();
                let _ = err_reader.join();
                let _ = out_reader.join();
                return Err(ComposeFailure::Unreachable);
            }
        }
    };
    let stderr = err_reader.join().unwrap_or_default();
    let _ = out_reader.join();
    if status.success() {
        Ok(())
    } else {
        Err(ComposeFailure::Failed(one_line(&stderr)))
    }
}

fn capped(pipe: Option<impl Read>) -> Vec<u8> {
    let mut buf = Vec::new();
    let Some(mut pipe) = pipe else {
        return buf;
    };
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
    buf
}

fn discard(pipe: Option<impl Read>) {
    let Some(mut pipe) = pipe else {
        return;
    };
    let mut tmp = [0u8; 8192];
    loop {
        match pipe.read(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
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
            label: String::new(),
            names: Vec::new(),
            emulated: Vec::new(),
            owner_pid: 0,
            proxy_port: None,
            reaches_real: false,
            note: None,
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
    let app_for_work = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::fs::expand_home(&cwd);
        down(&env_from_app(&app_for_work)?, &cwd)
    })
    .await
    .map_err(|error| error.to_string())?;
    if outcome.is_ok() {
        let _ = app.emit(STACKS_CHANGED, ());
    }
    outcome
}

#[tauri::command(async)]
pub async fn stack_reset(app: AppHandle, cwd: String) -> Result<(), String> {
    let app_for_work = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::fs::expand_home(&cwd);
        reset(&env_from_app(&app_for_work)?, &cwd)
    })
    .await
    .map_err(|error| error.to_string())?;
    if outcome.is_ok() {
        let _ = app.emit(STACKS_CHANGED, ());
    }
    outcome
}

#[tauri::command(async)]
pub async fn stack_stale(app: AppHandle) -> Result<Vec<StaleRow>, String> {
    tauri::async_runtime::spawn_blocking(move || stale(&env_from_app(&app)?))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn stack_remove_stale(app: AppHandle, id: String) -> Result<(), String> {
    let app_for_work = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        remove_stale(&env_from_app(&app_for_work)?, &id)
    })
    .await
    .map_err(|error| error.to_string())?;
    if outcome.is_ok() {
        let _ = app.emit(STACKS_CHANGED, ());
    }
    outcome
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
        files: Mutex<Vec<Option<PathBuf>>>,
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

        fn down(&self, project: &str, compose_file: Option<&Path>) -> Result<(), ComposeFailure> {
            self.calls.lock().unwrap().push(format!("down {project}"));
            self.files
                .lock()
                .unwrap()
                .push(compose_file.map(|path| path.to_path_buf()));
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
                    files: Mutex::new(Vec::new()),
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
                claims_dir: None,
                names: None,
                proxy_port: None,
                stand_in: None,
                path_env: None,
            }
        }

        /// WP-90: the same stack, with a memory name registry, a proxy port and a stand-in.
        fn named_env(
            &self,
            names: Arc<MemoryNames>,
            proxy_port: u16,
            stand_in: Arc<MemoryStandIn>,
        ) -> StackEnv {
            StackEnv {
                names: Some(names),
                proxy_port: Some(proxy_port),
                stand_in: Some(stand_in),
                ..self.env()
            }
        }
    }

    #[derive(Default)]
    struct MemoryNames {
        routes: Mutex<Vec<(String, u16, u32, String)>>,
    }

    impl NameRegistry for MemoryNames {
        fn add(&self, hostname: &str, port: u16, pid: u32, stack_id: &str) -> Result<(), String> {
            let mut routes = self.routes.lock().unwrap();
            if let Some((.., held)) = routes.iter().find(|(name, ..)| name == hostname) {
                if !held.is_empty() && held != stack_id {
                    return Err(format!(
                        "{hostname} is already a name used by another stack"
                    ));
                }
            }
            if routes
                .iter()
                .any(|(name, _, owner, _)| name == hostname && *owner != pid)
            {
                return Err(format!(
                    "{hostname} is already a name used by a running process"
                ));
            }
            routes.retain(|(name, ..)| name != hostname);
            routes.push((hostname.to_string(), port, pid, stack_id.to_string()));
            Ok(())
        }

        fn remove(&self, hostname: &str, pid: u32) -> Result<(), String> {
            self.routes
                .lock()
                .unwrap()
                .retain(|(name, _, owner, _)| name != hostname || *owner != pid);
            Ok(())
        }
    }

    /// A stand-in whose start and stop take a moment, so two of them overlap unless the
    /// stack's own lock serialises them. Tracks the pids that are alive.
    #[derive(Default)]
    struct RacyStandIn {
        live: Mutex<HashSet<u32>>,
        next: Mutex<u32>,
        starts: Mutex<Vec<u32>>,
    }

    impl StandIn for RacyStandIn {
        fn start(&self, _request: &StandInRequest) -> Result<StandInOutcome, String> {
            std::thread::sleep(Duration::from_millis(40));
            let mut next = self.next.lock().unwrap();
            *next += 1;
            let pid = *next;
            self.live.lock().unwrap().insert(pid);
            self.starts.lock().unwrap().push(pid);
            Ok(StandInOutcome {
                pid: Some(pid),
                note: None,
            })
        }

        fn stop(&self, _stack_dir: &Path) -> Result<(), String> {
            std::thread::sleep(Duration::from_millis(40));
            self.live.lock().unwrap().clear();
            Ok(())
        }
    }

    #[derive(Default)]
    struct MemoryStandIn {
        started: Mutex<Vec<(String, Vec<ServicePort>)>>,
        stopped: Mutex<Vec<String>>,
        note: Mutex<Option<String>>,
    }

    impl StandIn for MemoryStandIn {
        fn start(&self, request: &StandInRequest) -> Result<StandInOutcome, String> {
            self.started.lock().unwrap().push((
                crate::fs::path_to_js(&request.stack_dir),
                request.services.clone(),
            ));
            Ok(StandInOutcome {
                pid: Some(42),
                note: self.note.lock().unwrap().clone(),
            })
        }

        fn stop(&self, stack_dir: &Path) -> Result<(), String> {
            self.stopped
                .lock()
                .unwrap()
                .push(crate::fs::path_to_js(stack_dir));
            Ok(())
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
        let first =
            maybe_start(&env, &fix.main, &fix.first, true, Some(&stack), false, true).unwrap();
        let second = maybe_start(
            &env,
            &fix.main,
            &fix.second,
            true,
            Some(&stack),
            false,
            true,
        )
        .unwrap();
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
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack), false, true).unwrap();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack), false, true).unwrap();
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
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack), false, true).unwrap();
        maybe_start(
            &env,
            &fix.main,
            &fix.second,
            true,
            Some(&stack),
            false,
            true,
        )
        .unwrap();
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
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack), false, true).unwrap();
        maybe_start(
            &env,
            &fix.main,
            &fix.second,
            true,
            Some(&stack),
            false,
            true,
        )
        .unwrap();
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
        let none = maybe_start(&env, &fix.main, &fix.first, true, None, false, true).unwrap();
        let quiet = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            false,
            Some(&stack),
            false,
            true,
        )
        .unwrap();
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
        let error = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap_err();
        assert_eq!(error, DOCKER_LATER);
        assert_eq!(calls(&fix).len(), 2);
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert_eq!(store.stacks.len(), 1);
        assert!(!store.stacks[0].running);
        let id = store.stacks[0].id.clone();
        fix.runner.script.lock().unwrap().clear();
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap();
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert_eq!(store.stacks[0].id, id);
        assert!(store.stacks[0].running);
    }

    #[test]
    fn a_compose_failure_is_not_retried() {
        let fix = Fix::new();
        let env = fix.env();
        fix.runner.script.lock().unwrap().push(Script::Fail);
        let error = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap_err();
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
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap();
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
        let error = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap_err();
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
    fn temporary_names_do_not_repeat() {
        let first = tmp_name(&std::env::temp_dir(), "stack.env");
        let second = tmp_name(&std::env::temp_dir(), "stack.env");
        assert_ne!(first, second);
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".tmp"));
    }

    /// A process that died while holding the lock must not block every stack
    /// for long. The threshold is short, so waiting is all a start needs.
    #[test]
    fn an_old_lock_file_is_taken_over() {
        let fix = Fix::new();
        let env = fix.env();
        let dir = registry_dir(&env.data_dir);
        std::fs::create_dir_all(&dir).unwrap();
        let lock = dir.join(".stack.lock");
        std::fs::write(&lock, b"dead").unwrap();
        let old = SystemTime::now() - LOCK_STALE - Duration::from_secs(1);
        let file = OpenOptions::new().write(true).open(&lock).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        drop(file);
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
        assert!(!lock.exists(), "the dead owner's lock was left behind");
    }

    #[test]
    fn dev_copies_use_a_higher_port_range() {
        let fix = Fix::new();
        let mut env = fix.env();
        env.dev = true;
        let pairs = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap();
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
        let pairs = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
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
                label: String::new(),
                names: Vec::new(),
                emulated: Vec::new(),
                owner_pid: 0,
                proxy_port: None,
                reaches_real: false,
                note: None,
            });
            Ok(())
        })
        .unwrap();
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
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
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
        maybe_start(
            &env,
            &fix.main,
            &fix.second,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
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
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
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
        let error = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap_err();
        assert!(error.contains("not in this worktree"), "{error}");
        assert!(!registry_path(&registry_dir(&env.data_dir)).exists());
        assert!(calls(&fix).is_empty());
    }

    #[test]
    fn ports_only_never_calls_docker() {
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
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
                        label: String::new(),
                        names: Vec::new(),
                        emulated: Vec::new(),
                        owner_pid: 0,
                        proxy_port: None,
                        reaches_real: false,
                        note: None,
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
                        label: String::new(),
                        names: Vec::new(),
                        emulated: Vec::new(),
                        owner_pid: 0,
                        proxy_port: None,
                        reaches_real: false,
                        note: None,
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

    fn same_ports_no_compose() -> StackDecl {
        let mut stack = decl();
        stack.compose_file = None;
        stack
    }

    #[test]
    fn dropping_the_compose_file_stops_the_old_stack_and_starts() {
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap();
        let again = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&same_ports_no_compose()),
            false,
            true,
        )
        .unwrap();
        assert!(again.iter().any(|(key, _)| key == "PORT"));
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&same_ports_no_compose()),
            false,
            true,
        )
        .unwrap();
        let log = calls(&fix);
        assert_eq!(
            log.iter().filter(|line| line.starts_with("up ")).count(),
            1,
            "{log:?}"
        );
        assert_eq!(
            log.iter().filter(|line| line.starts_with("down ")).count(),
            1,
            "{log:?}"
        );
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert!(!store.stacks[0].has_compose);
        assert!(store.stacks[0].compose_file.is_none());
        assert!(store.stacks[0].running);
    }

    #[test]
    fn dropping_compose_keeps_the_flag_when_docker_will_not_stop() {
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap();
        fix.runner
            .script
            .lock()
            .unwrap()
            .extend([Script::Timeout, Script::Timeout]);
        let error = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&same_ports_no_compose()),
            false,
            true,
        )
        .unwrap_err();
        assert_eq!(error, DOCKER_LATER);
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert!(store.stacks[0].has_compose);
        assert!(store.stacks[0].compose_file.is_some());
    }

    #[test]
    fn a_full_stdout_pipe_does_not_stall() {
        let mut cmd = if cfg!(windows) {
            let mut cmd = Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-Command",
                "$buf = [byte[]]::new(262144); [Console]::OpenStandardOutput().Write($buf, 0, $buf.Length)",
            ]);
            cmd
        } else {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "dd if=/dev/zero bs=1024 count=256 2>/dev/null"]);
            cmd
        };
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let started = Instant::now();
        run_timed(&mut cmd).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "stdout filled the pipe and the wait hit the docker timeout"
        );
    }

    #[test]
    fn two_dev_copies_do_not_take_the_same_ports() {
        let fix = Fix::new();
        let claims = fix.tmp.root.join("claims");
        let mut left = fix.env();
        left.dev = true;
        left.data_dir = fix.tmp.root.join("data-a");
        left.claims_dir = Some(claims.clone());
        let mut right = fix.env();
        right.dev = true;
        right.data_dir = fix.tmp.root.join("data-b");
        right.claims_dir = Some(claims);
        let stack = ports_only();
        let first = maybe_start(
            &left,
            &fix.main,
            &fix.first,
            true,
            Some(&stack),
            false,
            true,
        )
        .unwrap();
        let second = maybe_start(
            &right,
            &fix.main,
            &fix.first,
            true,
            Some(&stack),
            false,
            true,
        )
        .unwrap();
        let port = |pairs: &[(String, String)]| {
            pairs
                .iter()
                .find(|(key, _)| key == "PORT")
                .unwrap()
                .1
                .parse::<u16>()
                .unwrap()
        };
        let a = port(&first);
        let b = port(&second);
        assert_ne!(a, b, "both copies took {a}");
        assert!((DEV_BASE..DEV_BASE + SPAN).contains(&a), "{a}");
        assert!((DEV_BASE..DEV_BASE + SPAN).contains(&b), "{b}");
    }

    #[test]
    fn a_restart_publishes_ports_another_copy_must_avoid() {
        let fix = Fix::new();
        let claims = fix.tmp.root.join("claims");
        let mut left = fix.env();
        left.dev = true;
        left.data_dir = fix.tmp.root.join("data-a");
        left.claims_dir = Some(claims.clone());
        let mut right = fix.env();
        right.dev = true;
        right.data_dir = fix.tmp.root.join("data-b");
        right.claims_dir = Some(claims.clone());
        let stack = ports_only();
        let first = maybe_start(
            &left,
            &fix.main,
            &fix.first,
            true,
            Some(&stack),
            false,
            true,
        )
        .unwrap();
        std::fs::remove_file(claims.join("claims.json")).unwrap();
        maybe_start(
            &left,
            &fix.main,
            &fix.first,
            true,
            Some(&stack),
            false,
            true,
        )
        .unwrap();
        let second = maybe_start(
            &right,
            &fix.main,
            &fix.first,
            true,
            Some(&stack),
            false,
            true,
        )
        .unwrap();
        let port = |pairs: &[(String, String)]| {
            pairs
                .iter()
                .find(|(key, _)| key == "PORT")
                .unwrap()
                .1
                .parse::<u16>()
                .unwrap()
        };
        assert_ne!(
            port(&first),
            port(&second),
            "a restart left the ports unclaimed"
        );
    }

    #[test]
    fn a_wild_block_in_the_registry_does_not_panic() {
        let fix = Fix::new();
        let env = fix.env();
        update(&registry_dir(&env.data_dir), |store| {
            store.stacks.push(Entry {
                id: "s01234567".into(),
                key: "other-path".into(),
                worktree: fix.second.to_string_lossy().into_owned(),
                project: path_key(&fix.main),
                compose_project: "hivra-s01234567".into(),
                compose_file: None,
                has_compose: false,
                block: 6000,
                ports: Vec::new(),
                env: BTreeMap::new(),
                url: None,
                running: false,
                label: String::new(),
                names: Vec::new(),
                emulated: Vec::new(),
                owner_pid: 0,
                proxy_port: None,
                reaches_real: false,
                note: None,
            });
            Ok(())
        })
        .unwrap();
        let pairs = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
        let port: u16 = pairs
            .iter()
            .find(|(name, _)| name == "PORT")
            .unwrap()
            .1
            .parse()
            .unwrap();
        assert!((DAILY_BASE..DAILY_BASE + SPAN).contains(&port), "{port}");
    }

    #[test]
    fn down_ignores_a_compose_file_outside_the_worktree() {
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap();
        down(&env, &fix.first).unwrap();
        let root = crate::fs::canonical(&fix.first).unwrap();
        let first = fix.runner.files.lock().unwrap().last().cloned().unwrap();
        assert!(
            first.as_ref().is_some_and(|path| path_inside(&root, path)),
            "{first:?}"
        );
        let outside = fix.tmp.root.join("elsewhere.yml");
        std::fs::write(&outside, "services: {}\n").unwrap();
        update(&registry_dir(&env.data_dir), |store| {
            store.stacks[0].compose_file = Some(outside.to_string_lossy().into_owned());
            store.stacks[0].running = true;
            Ok(())
        })
        .unwrap();
        down(&env, &fix.first).unwrap();
        let passed = fix.runner.files.lock().unwrap().last().cloned().unwrap();
        assert!(passed.is_none(), "compose ran against {passed:?}");
    }

    #[test]
    fn remove_stale_ignores_a_compose_file_outside_the_worktree() {
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&decl()),
            false,
            true,
        )
        .unwrap();
        let outside = fix.tmp.root.join("elsewhere.yml");
        std::fs::write(&outside, "services: {}\n").unwrap();
        let id = {
            let store = load(&registry_dir(&env.data_dir)).unwrap();
            store.stacks[0].id.clone()
        };
        update(&registry_dir(&env.data_dir), |store| {
            store.stacks[0].compose_file = Some(outside.to_string_lossy().into_owned());
            Ok(())
        })
        .unwrap();
        std::fs::remove_dir_all(&fix.first).unwrap();
        remove_stale(&env, &id).unwrap();
        let passed = fix.runner.files.lock().unwrap().last().cloned().unwrap();
        assert!(passed.is_none(), "compose ran against {passed:?}");
    }

    #[test]
    fn a_secret_in_an_env_value_stays_out_of_the_registry() {
        let fix = Fix::new();
        let env = fix.env();
        let stack: StackDecl = serde_json::from_str(
            r#"{"services":[{"name":"db","ports":[{"env":"DATABASE_PORT"}],
               "env":{"DATABASE_URL":"postgres://user:s3cret@127.0.0.1:${DATABASE_PORT}/app"}}]}"#,
        )
        .unwrap();
        let pairs =
            maybe_start(&env, &fix.main, &fix.first, true, Some(&stack), false, true).unwrap();
        let url = &pairs
            .iter()
            .find(|(key, _)| key == "DATABASE_URL")
            .unwrap()
            .1;
        assert!(url.contains("s3cret"), "{url}");
        let registry =
            std::fs::read_to_string(registry_path(&registry_dir(&env.data_dir))).unwrap();
        assert!(!registry.contains("s3cret"), "{registry}");
        let body = std::fs::read_to_string(fix.first.join(".monocode").join("stack.env")).unwrap();
        assert!(body.contains("s3cret"), "{body}");
    }

    fn env_of(cmd: &Command, key: &str) -> Option<String> {
        cmd.get_envs()
            .find(|(name, _)| *name == std::ffi::OsStr::new(key))
            .and_then(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
    }

    /// Finder's PATH is only /usr/bin:/bin:/usr/sbin:/sbin. Docker has to see the
    /// login shell's PATH, and HOME, or it cannot find the binary or the Desktop
    /// context. Both are injected so the test does not read this process.
    #[test]
    fn docker_command_carries_home_and_the_login_shell_path() {
        let login = "/injected/login/bin:/usr/local/bin";
        let supplied = |key: &str| -> Option<std::ffi::OsString> {
            Some(
                match key {
                    "HOME" => "/Users/ada",
                    "DOCKER_HOST" => "unix:///Users/ada/.docker/run/docker.sock",
                    "DOCKER_CONTEXT" => "desktop-linux",
                    "DOCKER_CONFIG" => "/Users/ada/.docker",
                    "DOCKER_CERT_PATH" => "/Users/ada/.docker/certs",
                    "DOCKER_TLS_VERIFY" => "1",
                    "USERPROFILE" => r"C:\Users\ada",
                    "APPDATA" => r"C:\Users\ada\AppData\Roaming",
                    "PATH" => "/usr/bin:/bin:/usr/sbin:/sbin",
                    "SECRET_TOKEN" => "nope",
                    _ => return None,
                }
                .into(),
            )
        };
        let cmd = docker_command_from(Some(login.to_string()), supplied);
        assert_eq!(env_of(&cmd, "PATH").as_deref(), Some(login));
        assert_ne!(
            env_of(&cmd, "PATH").as_deref(),
            Some("/usr/bin:/bin:/usr/sbin:/sbin"),
            "docker must not keep the Finder PATH"
        );
        assert_eq!(env_of(&cmd, "HOME").as_deref(), Some("/Users/ada"));
        for key in docker_env_keys() {
            let want = supplied(key).map(|value| value.to_string_lossy().into_owned());
            assert_eq!(env_of(&cmd, key), want, "{key}");
        }
        assert!(env_of(&cmd, "SECRET_TOKEN").is_none());
    }

    #[test]
    fn an_empty_login_path_does_not_wipe_path_and_an_empty_home_is_left_out() {
        let cmd = docker_command_from(Some(String::new()), |key| {
            (key == "HOME" || key == "DOCKER_HOST").then(std::ffi::OsString::new)
        });
        assert_eq!(
            env_of(&cmd, "PATH").as_deref(),
            std::env::var("PATH").ok().as_deref()
        );
        assert!(env_of(&cmd, "HOME").is_none());
        assert!(env_of(&cmd, "DOCKER_HOST").is_none());
    }

    #[test]
    #[ignore = "needs a local Docker; reads compose version only and launches no app"]
    fn real_docker_compose_answers() {
        let mut cmd = docker_command();
        cmd.args(["compose", "version"]);
        let output = cmd
            .output()
            .expect("docker compose version could not start");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "stdout: {stdout}\nstderr: {stderr}"
        );
        let text = stdout.to_ascii_lowercase();
        assert!(
            text.contains("version") || text.contains("compose"),
            "{stdout}"
        );
    }

    #[test]
    fn a_short_or_odd_container_id_is_not_removed() {
        let full = "a".repeat(64);
        assert_eq!(container_ids(&full).unwrap(), vec![full.clone()]);
        assert_eq!(container_ids("\n\n").unwrap(), Vec::<String>::new());
        assert_eq!(
            container_ids(&format!("  {full}  \r\n")).unwrap(),
            vec![full.clone()]
        );
        assert!(container_ids(&"ab".repeat(6)).is_ok(), "12 hex digits");
        for bad in [
            "abc",
            &"ab".repeat(33),
            "DEADBEEFDEAD",
            "not-an-id",
            &format!("{full}\nbad"),
        ] {
            assert!(container_ids(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn compose_up_and_down_drop_orphans_and_keep_volumes() {
        let request = UpRequest {
            project: "hivra-s01234567".into(),
            compose_file: PathBuf::from("/work/docker-compose.yml"),
            env_file: PathBuf::from("/work/.monocode/stack.env"),
            services: vec!["web".into()],
            cwd: PathBuf::from("/work"),
        };
        let mut up = Command::new("docker");
        push_compose_up(&mut up, &request);
        let up_args: Vec<_> = up
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            up_args,
            vec![
                "compose",
                "-p",
                "hivra-s01234567",
                "-f",
                "/work/docker-compose.yml",
                "--env-file",
                "/work/.monocode/stack.env",
                "up",
                "-d",
                "--remove-orphans",
                "web",
            ]
        );
        let mut down = Command::new("docker");
        push_compose_down(
            &mut down,
            "hivra-s01234567",
            Path::new("/work/docker-compose.yml"),
        );
        let down_args: Vec<_> = down
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            down_args,
            vec![
                "compose",
                "-p",
                "hivra-s01234567",
                "-f",
                "/work/docker-compose.yml",
                "down",
                "--timeout",
                "10",
                "--remove-orphans",
            ]
        );
        assert!(up_args.iter().all(|arg| arg != "--volumes" && arg != "-v"));
        assert!(down_args
            .iter()
            .all(|arg| arg != "--volumes" && arg != "-v"));
    }

    /// Docker publishes on 0.0.0.0, so a listener on the wildcard address must
    /// count as taken. A dev server or the phone door may hold only 127.0.0.1,
    /// which a wildcard bind alone can miss on BSD-derived systems, so both are
    /// checked.
    #[test]
    fn the_port_probe_checks_the_wildcard_and_loopback_addresses() {
        // WP-90: the probe checks every address the proxy might dial, not just the wildcard.
        for addr in [
            std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        ] {
            let listener = std::net::TcpListener::bind((addr, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            assert!(!BindProbe.free(port), "{addr}:{port} is taken");
            drop(listener);
        }
        let mut saw_free = false;
        for _ in 0..20 {
            let listener =
                std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            if BindProbe.free(port) {
                saw_free = true;
                break;
            }
        }
        assert!(saw_free, "a released port was never reported free");
    }

    #[cfg(unix)]
    #[test]
    fn the_env_file_is_private_and_a_link_is_left_alone() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
        let path = fix.first.join(".monocode").join("stack.env");
        let meta = std::fs::symlink_metadata(&path).unwrap();
        assert!(meta.file_type().is_file());
        assert!(!meta.file_type().is_symlink());
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);

        let linked = fix.second.join(".monocode");
        std::fs::create_dir_all(&linked).unwrap();
        let elsewhere = fix.tmp.root.join("elsewhere.env");
        std::fs::write(&elsewhere, "SECRET=1\n").unwrap();
        symlink(&elsewhere, linked.join("stack.env")).unwrap();
        let error = maybe_start(
            &env,
            &fix.main,
            &fix.second,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap_err();
        assert!(error.contains("link"), "{error}");
        assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "SECRET=1\n");
    }

    #[cfg(windows)]
    #[test]
    fn the_env_file_is_a_regular_file() {
        let fix = Fix::new();
        let env = fix.env();
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
        let path = fix.first.join(".monocode").join("stack.env");
        let meta = std::fs::symlink_metadata(&path).unwrap();
        assert!(meta.is_file());
        assert!(!meta.file_type().is_symlink());
    }

    // WP-90 ---------------------------------------------------------------------------------

    fn emulated_decl() -> StackDecl {
        serde_json::from_str(
            r#"{
              "services": [
                {"name": "web", "ports": [{"env": "PORT", "url": true}]},
                {"name": "git", "emulate": "github"},
                {"name": "pay", "emulate": "stripe", "urlEnv": "STRIPE_URL"}
              ]
            }"#,
        )
        .unwrap()
    }

    fn real_decl() -> StackDecl {
        serde_json::from_str(
            r#"{"services":[{"name":"web","ports":[{"env":"PORT","url":true}],
                 "env":{"GITHUB_API":"https://api.github.com"}}]}"#,
        )
        .unwrap()
    }

    fn pair<'a>(pairs: &'a [(String, String)], name: &str) -> &'a str {
        pairs
            .iter()
            .find(|(key, _)| key == name)
            .unwrap_or_else(|| panic!("{name} missing from {pairs:?}"))
            .1
            .as_str()
    }

    #[test]
    fn a_named_stack_publishes_its_app_and_fake_services_with_the_blocks_ports() {
        let fix = Fix::new();
        let stand_in = Arc::new(MemoryStandIn::default());
        let names = Arc::new(MemoryNames::default());
        let env = fix.named_env(Arc::clone(&names), 7400, Arc::clone(&stand_in));
        let pairs = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        // The app is named after the project and this worktree's branch.
        assert_eq!(pair(&pairs, "PUBLIC_URL"), "http://main-a.localhost:7400");
        // The env block is the loopback port. The name, with the project in it, is published.
        assert!(pair(&pairs, "GITHUB_BASE_URL").starts_with("http://127.0.0.1:"));
        assert!(pair(&pairs, "STRIPE_URL").starts_with("http://127.0.0.1:"));
        // The stand-in got one port per service from the same block, none of them the app's.
        let started = stand_in.started.lock().unwrap();
        assert_eq!(started.len(), 1);
        let services = &started[0].1;
        assert_eq!(services.len(), 2);
        let app_port: u16 = pair(&pairs, "PORT").parse().unwrap();
        let mut ports: Vec<u16> = services.iter().map(|service| service.port).collect();
        assert!(!ports.contains(&app_port), "{ports:?}");
        ports.sort_unstable();
        ports.dedup();
        assert_eq!(ports.len(), 2);

        let names = names.routes.lock().unwrap();
        let hosts: Vec<&str> = names.iter().map(|(host, ..)| host.as_str()).collect();
        assert!(hosts.contains(&"main-a.localhost"));
        assert!(hosts.contains(&"github-main-a.localhost"));
        assert!(hosts.contains(&"stripe-main-a.localhost"));

        let status = status_for(&env, &fix.first).unwrap();
        let row = &status.stacks[0];
        assert_eq!(row.url.as_deref(), Some("http://main-a.localhost:7400"));
        assert_eq!(row.names.len(), 3);
        assert_eq!(row.emulated, vec!["github", "stripe"]);
        assert_eq!(row.mode, "Tests use fake GitHub and Stripe");
    }

    /// Node resolves names with the OS resolver, which does not treat `*.localhost` as loopback
    /// (ENOTFOUND on Linux). The env block is what server-side code fetches, so it has to be the
    /// service's own loopback port. The name stays the address the stand-in advertises.
    #[test]
    fn a_server_fetches_the_fake_service_at_the_env_url_with_node() {
        let fix = Fix::new();
        let stand_in = Arc::new(MemoryStandIn::default());
        let names = Arc::new(MemoryNames::default());
        let env = fix.named_env(Arc::clone(&names), 7400, Arc::clone(&stand_in));
        let pairs = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        let github = pair(&pairs, "GITHUB_BASE_URL").to_string();
        assert!(
            github.starts_with("http://127.0.0.1:"),
            "the env block must be an address Node can resolve, not a name: {github}"
        );
        let stripe = pair(&pairs, "STRIPE_URL");
        assert!(
            stripe.starts_with("http://127.0.0.1:"),
            "the env block must be an address Node can resolve, not a name: {stripe}"
        );
        assert_ne!(github, stripe);
        // The app's own address is still the name a browser resolves.
        assert_eq!(pair(&pairs, "PUBLIC_URL"), "http://main-a.localhost:7400");
        let advertised = stand_in
            .started
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, services)| services.clone())
            .find(|service| service.service == "github")
            .unwrap()
            .base_url;
        assert!(
            advertised.starts_with("http://github-"),
            "the stand-in must keep advertising the named url: {advertised}"
        );
        assert!(
            !advertised.contains("127.0.0.1"),
            "the stand-in must keep advertising the named url: {advertised}"
        );

        let port: u16 = github
            .trim_start_matches("http://127.0.0.1:")
            .parse()
            .unwrap();
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .unwrap_or_else(|error| panic!("the env port {port} was not free: {error}"));
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0u8; 1024];
            let _ = std::io::Read::read(&mut stream, &mut buf);
            let body = b"from-the-fake";
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = std::io::Write::write_all(&mut stream, head.as_bytes());
            let _ = std::io::Write::write_all(&mut stream, body);
        });
        let output = Command::new("node")
            .args([
                "-e",
                "fetch(process.argv[1]).then(r=>r.text()).then(t=>{process.stdout.write(t)}).catch(e=>{console.error(e);process.exit(1)})",
                &github,
            ])
            .output()
            .expect("node is required to prove the env url is fetchable");
        assert!(
            output.status.success(),
            "node could not fetch {github}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout), "from-the-fake");
    }

    /// Two projects on one branch used to publish `github-<branch>.localhost` and the second
    /// write, force-added under this process's pid, silently replaced the first.
    #[test]
    fn two_projects_on_the_same_branch_both_faking_github_keep_their_own_name() {
        let fix = Fix::new();
        let blog = fix.tmp.root.join("blog");
        let blog_tree = fix.tmp.root.join("blog work");
        git(
            &fix.tmp.root,
            &["init", "-b", "main", blog.to_str().unwrap()],
        );
        std::fs::write(blog.join("README"), "blog\n").unwrap();
        git(&blog, &["add", "README"]);
        git(&blog, &["commit", "-qm", "initial"]);
        git(
            &blog,
            &["worktree", "add", "-b", "a", blog_tree.to_str().unwrap()],
        );
        std::fs::write(blog_tree.join("docker-compose.yml"), "services: {}\n").unwrap();

        let routes =
            crate::proxy::routes::RouteStore::new(crate::proxy::server::proxy_dir(&fix.data));
        let env = StackEnv {
            names: Some(Arc::new(RouteNames {
                store: routes.clone(),
            })),
            proxy_port: Some(7400),
            stand_in: Some(Arc::new(MemoryStandIn::default())),
            ..fix.env()
        };
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        maybe_start(
            &env,
            &blog,
            &blog_tree,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();

        let live = routes.load_routes_raw().unwrap();
        let mut github: Vec<_> = live
            .iter()
            .filter(|route| route.hostname.starts_with("github-"))
            .collect();
        assert_eq!(github.len(), 2, "{live:?}");
        github.sort_by(|left, right| left.hostname.cmp(&right.hostname));
        assert_eq!(github[0].hostname, "github-blog-a.localhost");
        assert_eq!(github[1].hostname, "github-main-a.localhost");
        assert_ne!(github[0].port, github[1].port);
        assert_ne!(github[0].stack_id, github[1].stack_id);
        assert!(github[0].stack_id.is_some() && github[1].stack_id.is_some());

        let held = github[1];
        let err = routes.add_route_owned(
            &held.hostname,
            held.port.saturating_add(1),
            std::process::id(),
            true,
            github[0].stack_id.as_deref(),
        );
        assert!(err.is_err(), "the other project took {}", held.hostname);
        let still = routes.route_for_host(&held.hostname).unwrap();
        assert_eq!(still.port, held.port);
        assert_eq!(still.stack_id, held.stack_id);
    }

    #[test]
    fn down_removes_only_this_stacks_names_and_stops_its_stand_in() {
        let fix = Fix::new();
        let stand_in = Arc::new(MemoryStandIn::default());
        let names = Arc::new(MemoryNames::default());
        let env = fix.named_env(Arc::clone(&names), 7400, Arc::clone(&stand_in));
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        maybe_start(
            &env,
            &fix.main,
            &fix.second,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        down(&env, &fix.first).unwrap();
        let routes = names.routes.lock().unwrap();
        assert!(
            routes.iter().all(|(host, ..)| !host.contains("-a.")),
            "{routes:?}"
        );
        assert!(
            routes.iter().any(|(host, ..)| host.contains("-b.")),
            "{routes:?}"
        );
        let first_id = load(&registry_dir(&env.data_dir))
            .unwrap()
            .stacks
            .iter()
            .find(|entry| keys_eq(&entry.key, &path_key(&fix.first)))
            .unwrap()
            .id
            .clone();
        let stopped = stand_in.stopped.lock().unwrap();
        assert!(
            stopped.iter().any(|dir| dir.ends_with(&first_id)),
            "{stopped:?}"
        );
    }

    #[test]
    fn reset_puts_the_stand_in_back_without_moving_its_names() {
        let fix = Fix::new();
        let stand_in = Arc::new(MemoryStandIn::default());
        let names = Arc::new(MemoryNames::default());
        let env = fix.named_env(Arc::clone(&names), 7400, Arc::clone(&stand_in));
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        let before = names.routes.lock().unwrap().clone();
        let started = stand_in.started.lock().unwrap().len();
        reset(&env, &fix.first).unwrap();
        assert_eq!(stand_in.started.lock().unwrap().len(), started + 1);
        assert_eq!(*names.routes.lock().unwrap(), before);
        assert!(stand_in
            .stopped
            .lock()
            .unwrap()
            .iter()
            .any(|dir| dir.contains('s')));
    }

    #[test]
    fn a_branch_change_moves_the_name_and_leaves_no_stale_one() {
        let fix = Fix::new();
        let stand_in = Arc::new(MemoryStandIn::default());
        let names = Arc::new(MemoryNames::default());
        let env = fix.named_env(Arc::clone(&names), 7400, stand_in);
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
        assert!(names
            .routes
            .lock()
            .unwrap()
            .iter()
            .any(|(host, ..)| host == "main-a.localhost"));
        git(&fix.first, &["switch", "-c", "renamed"]);
        let pairs = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
        assert_eq!(
            pair(&pairs, "PUBLIC_URL"),
            "http://main-renamed.localhost:7400"
        );
        let routes = names.routes.lock().unwrap();
        assert!(
            routes.iter().all(|(host, ..)| host != "main-a.localhost"),
            "{routes:?}"
        );
        assert!(routes
            .iter()
            .any(|(host, ..)| host == "main-renamed.localhost"));
    }

    #[test]
    fn a_pool_slot_keeps_its_name_and_state_across_a_return_and_a_new_lease() {
        let fix = Fix::new();
        let pool = fix
            .tmp
            .root
            .join("worktree-pool")
            .join("slots")
            .join("repo-slot1");
        std::fs::create_dir_all(pool.parent().unwrap()).unwrap();
        git(
            &fix.main,
            &[
                "worktree",
                "add",
                "-b",
                "pool-branch",
                pool.to_str().unwrap(),
            ],
        );
        let stand_in = Arc::new(MemoryStandIn::default());
        let names = Arc::new(MemoryNames::default());
        let env = fix.named_env(Arc::clone(&names), 7400, Arc::clone(&stand_in));
        let first = maybe_start(
            &env,
            &fix.main,
            &pool,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        let first_url = pair(&first, "PUBLIC_URL").to_string();
        // The slot's state lives with the stack and survives a return.
        let dir = load(&registry_dir(&env.data_dir)).unwrap().stacks[0]
            .id
            .clone();
        let state = stack_dir(&env.data_dir, &dir);
        std::fs::create_dir_all(&state).unwrap();
        down(&env, &pool).unwrap();
        assert!(state.is_dir());
        let second = maybe_start(
            &env,
            &fix.main,
            &pool,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        assert_eq!(pair(&second, "PUBLIC_URL"), first_url);
        // Its name is the stack id, so a branch change cannot move it.
        assert!(first_url.contains(&dir), "{first_url}");
    }

    #[test]
    fn a_declared_real_host_refuses_without_reaches_real_and_a_crew_never_starts_one() {
        let fix = Fix::new();
        let env = fix.env();
        let error = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&real_decl()),
            false,
            true,
        )
        .unwrap_err();
        assert!(error.contains("reaches: real"), "{error}");
        let error = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&real_decl()),
            true,
            false,
        )
        .unwrap_err();
        assert!(error.contains("only the person"), "{error}");
        // The person may start it once the project says so.
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&real_decl()),
            true,
            true,
        )
        .unwrap();
        let store = load(&registry_dir(&env.data_dir)).unwrap();
        assert!(store.stacks[0].reaches_real);
        assert_eq!(store.stacks[0].mode(), "Reaches the real internet");
    }

    #[test]
    fn a_running_stack_gets_its_names_back_after_a_restart() {
        let fix = Fix::new();
        let base = fix.env();
        let routes =
            crate::proxy::routes::RouteStore::new(crate::proxy::server::proxy_dir(&base.data_dir));
        // The previous app process published every name and is now gone.
        // Two ports are still accepting; one name's port is closed and must not come back.
        let app_listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let fake_listener =
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let app_port = app_listener.local_addr().unwrap().port();
        let fake_port = fake_listener.local_addr().unwrap().port();
        let closed = {
            let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            port
        };
        let dead = u32::MAX;
        routes
            .add_route("main-a.localhost", app_port, dead, false)
            .unwrap();
        routes
            .add_route("github-a.localhost", fake_port, dead, false)
            .unwrap();
        routes
            .add_route("stripe-a.localhost", closed, dead, false)
            .unwrap();
        routes
            .add_route("main-b.localhost", closed, dead, false)
            .unwrap();
        let entry = |id: &str, tree: &Path, running: bool, names: Vec<Published>| Entry {
            id: id.into(),
            key: path_key(tree),
            worktree: crate::fs::path_to_js(tree),
            project: path_key(&fix.main),
            compose_project: format!("hivra-{id}"),
            compose_file: None,
            has_compose: true,
            block: 22010,
            ports: Vec::new(),
            env: BTreeMap::new(),
            url: names
                .first()
                .map(|name| format!("http://{}:7400", name.hostname)),
            running,
            label: "a".into(),
            names,
            emulated: Vec::new(),
            owner_pid: dead,
            proxy_port: Some(7400),
            reaches_real: false,
            note: None,
        };
        update(&registry_dir(&base.data_dir), |store| {
            store.stacks.push(entry(
                "s0001",
                &fix.first,
                true,
                vec![
                    Published {
                        hostname: "main-a.localhost".into(),
                        port: app_port,
                        service: None,
                    },
                    Published {
                        hostname: "github-a.localhost".into(),
                        port: fake_port,
                        service: Some("github".into()),
                    },
                    Published {
                        hostname: "stripe-a.localhost".into(),
                        port: closed,
                        service: Some("stripe".into()),
                    },
                ],
            ));
            store.stacks.push(entry(
                "s0002",
                &fix.second,
                false,
                vec![Published {
                    hostname: "main-b.localhost".into(),
                    port: closed,
                    service: None,
                }],
            ));
            Ok(())
        })
        .unwrap();
        // The start of the new proxy removes the dead owner's names first.
        assert_eq!(routes.prune_stale_routes().unwrap().len(), 4);

        let env = StackEnv {
            names: Some(Arc::new(RouteNames {
                store: routes.clone(),
            })),
            proxy_port: Some(7500),
            ..fix.env()
        };
        resume_names(&env).unwrap();

        let _hold = (app_listener, fake_listener);
        let live = routes.load_routes_raw().unwrap();
        assert_eq!(live.len(), 2, "{live:?}");
        let own = std::process::id();
        for (name, port) in [
            ("main-a.localhost", app_port),
            ("github-a.localhost", fake_port),
        ] {
            let route = routes
                .route_for_host(name)
                .unwrap_or_else(|| panic!("{name} is not routed"));
            assert_eq!(route.pid, own, "{name}");
            assert_eq!(route.port, port, "{name}");
        }
        // A stack that was stopped before the restart is not brought back, and a name whose
        // port is closed is not put back either.
        assert!(routes.route_for_host("main-b.localhost").is_none());
        assert!(routes.route_for_host("stripe-a.localhost").is_none());
        let store = load(&registry_dir(&base.data_dir)).unwrap();
        let running = store.stacks.iter().find(|entry| entry.running).unwrap();
        assert_eq!(running.owner_pid, own);
        assert_eq!(running.proxy_port, Some(7500));
        // The app URL follows the proxy's new port too.
        assert_eq!(running.url.as_deref(), Some("http://main-a.localhost:7500"));
        assert!(running
            .names
            .iter()
            .all(|name| name.hostname != "stripe-a.localhost"));
    }

    /// A stack list that can't be read must not leave a stand-in running: the stacks folder is
    /// the record of what was started, not the list.
    #[cfg(unix)]
    #[test]
    fn a_fake_is_stopped_even_when_the_stack_list_cannot_be_read() {
        use std::os::unix::process::CommandExt;
        let fix = Fix::new();
        let inside = registry_dir(&fix.data).join("stacks").join("s01234567");
        std::fs::create_dir_all(&inside).unwrap();
        let inside = crate::fs::canonical(&inside).unwrap();
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(format!("sleep 30; : emulate {}", inside.display()))
            .process_group(0);
        let mut child = command.spawn().unwrap();
        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(inside.join("emulate.pid"), format!("{}\n", child.id())).unwrap();
        std::fs::write(registry_path(&registry_dir(&fix.data)), b"{ not json").unwrap();
        // The unreadable list is reported, and the stand-in is stopped anyway.
        assert!(stop_stand_ins(&fix.data).is_err());
        let gone = child.try_wait().ok().flatten().is_some()
            || Command::new("ps")
                .args(["-p", &child.id().to_string()])
                .output()
                .map(|output| !output.status.success())
                .unwrap_or(true);
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            gone,
            "the stand-in was left running behind an unreadable list"
        );
        assert!(!inside.join("emulate.pid").exists());
    }

    /// A stand-in left behind by a quit or a crash is stopped, and a pid file that is not inside
    /// this data folder's stacks directory is left alone.
    #[cfg(unix)]
    #[test]
    fn a_fake_left_behind_is_stopped_and_one_outside_the_folder_is_not() {
        use std::os::unix::fs::symlink;
        use std::os::unix::process::CommandExt;
        let fix = Fix::new();
        let inside = registry_dir(&fix.data).join("stacks").join("s01234567");
        let outside = fix.tmp.root.join("outside");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // The same path stop will prove against: canonicalize follows the temp symlink.
        let inside = crate::fs::canonical(&inside).unwrap();
        let outside = crate::fs::canonical(&outside).unwrap();
        let spawn = |dir: &Path| {
            let mut command = Command::new("sh");
            command
                .arg("-c")
                .arg(format!("sleep 30; : emulate {}", dir.display()))
                .process_group(0);
            let child = command.spawn().unwrap();
            std::thread::sleep(Duration::from_millis(50));
            let pid = child.id();
            std::fs::write(dir.join("emulate.pid"), format!("{pid}\n")).unwrap();
            child
        };
        let mut ours = spawn(&inside);
        let mut foreign = spawn(&outside);
        // A link inside the stacks folder that points out of it must not be followed.
        symlink(
            &outside,
            registry_dir(&fix.data).join("stacks").join("linked"),
        )
        .unwrap();
        stop_stand_ins(&fix.data).unwrap();
        let gone = ours.try_wait().ok().flatten().is_some()
            || Command::new("ps")
                .args(["-p", &ours.id().to_string()])
                .output()
                .map(|output| !output.status.success())
                .unwrap_or(true);
        assert!(
            gone,
            "the stand-in inside the data folder was still running"
        );
        let still = Command::new("ps")
            .args(["-p", &foreign.id().to_string()])
            .output()
            .unwrap();
        assert!(
            still.status.success(),
            "a process outside the stacks folder was killed"
        );
        let _ = ours.wait();
        let _ = foreign.kill();
        let _ = foreign.wait();
        assert!(!inside.join("emulate.pid").exists());
        assert!(outside.join("emulate.pid").exists());
    }

    #[test]
    fn two_resets_of_one_stack_leave_one_stand_in() {
        use std::sync::Barrier;
        let fix = Fix::new();
        let stand_in = Arc::new(RacyStandIn::default());
        let env = Arc::new(StackEnv {
            stand_in: Some(stand_in.clone()),
            ..fix.env()
        });
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        assert_eq!(stand_in.live.lock().unwrap().len(), 1);

        let barrier = Arc::new(Barrier::new(2));
        let spawn_reset = || {
            let env = Arc::clone(&env);
            let tree = fix.first.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                reset(&env, &tree)
            })
        };
        let first = spawn_reset();
        let second = spawn_reset();
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
        // Both resets stopped and started; only one of the two stand-ins may be left running.
        assert_eq!(*stand_in.next.lock().unwrap(), 3);
        assert_eq!(stand_in.live.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_emulated_service_pointing_at_an_unlisted_real_host_is_refused() {
        let fix = Fix::new();
        let env = fix.env();
        // The card would say "fake GitHub", but this value names a real Google host.
        let stack: StackDecl = serde_json::from_str(
            r#"{"services":[
                 {"name":"web","ports":[{"env":"PORT","url":true}]},
                 {"name":"git","emulate":"github","env":{"GITHUB_WEB":"https://www.googleapis.com"}}
               ]}"#,
        )
        .unwrap();
        let error =
            maybe_start(&env, &fix.main, &fix.first, true, Some(&stack), false, true).unwrap_err();
        assert!(error.contains("real outside service"), "{error}");
        assert!(error.contains("www.googleapis.com"), "{error}");
    }

    #[test]
    fn loopback_and_localhost_values_are_not_real_hosts() {
        let fix = Fix::new();
        let env = fix.env();
        let stack: StackDecl = serde_json::from_str(
            r#"{"services":[{"name":"web","ports":[{"env":"PORT","url":true}],
                 "env":{"LOCAL_API":"http://127.0.0.1:3000",
                        "SELF":"http://main-a.localhost:7400",
                        "IPV6":"http://[::1]:3000"}}]}"#,
        )
        .unwrap();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack), false, true).unwrap();
    }

    #[test]
    fn an_emulated_service_on_its_named_local_url_still_starts() {
        let fix = Fix::new();
        let env = fix.env();
        let stack: StackDecl = serde_json::from_str(
            r#"{"services":[
                 {"name":"web","ports":[{"env":"PORT","url":true}]},
                 {"name":"git","emulate":"github",
                  "env":{"GITHUB_WEB":"http://github-a.localhost:7400"}}
               ]}"#,
        )
        .unwrap();
        maybe_start(&env, &fix.main, &fix.first, true, Some(&stack), false, true).unwrap();
    }

    #[test]
    fn a_dev_stack_takes_ports_from_the_dev_range_only() {
        let fix = Fix::new();
        let mut env = fix.env();
        env.dev = true;
        let pairs = maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&ports_only()),
            false,
            true,
        )
        .unwrap();
        let port: u16 = pair(&pairs, "PORT").parse().unwrap();
        assert!((DEV_BASE..DEV_BASE + SPAN).contains(&port), "{port}");
        for reserved in [80, 443, 1420, 1421, 1430, 1919] {
            assert_ne!(port, reserved);
        }
    }

    #[test]
    fn a_returned_pool_slot_has_its_names_removed_from_the_real_registry() {
        let fix = Fix::new();
        let routes =
            crate::proxy::routes::RouteStore::new(crate::proxy::server::proxy_dir(&fix.data));
        let env = StackEnv {
            names: Some(Arc::new(RouteNames {
                store: routes.clone(),
            })),
            proxy_port: Some(7400),
            stand_in: Some(Arc::new(MemoryStandIn::default())),
            ..fix.env()
        };
        maybe_start(
            &env,
            &fix.main,
            &fix.first,
            true,
            Some(&emulated_decl()),
            false,
            true,
        )
        .unwrap();
        assert_eq!(routes.load_routes_raw().unwrap().len(), 3);
        stop_for_worktree(&fix.data, &fix.first).unwrap();
        assert!(routes.load_routes_raw().unwrap().is_empty());
    }

    /// Everything the real stand-in needs to run without a network or Node 24: a throwaway data
    /// folder, a stack folder, the four fixture tarballs, and a `node` on PATH that answers with
    /// a version this app accepts. `None` where the platform has no `/bin/sh` to write it with.
    struct StandInFix {
        /// Held only to keep the temp folder alive for the test's lifetime.
        _temp: Tmp,
        data: PathBuf,
        stack_dir: PathBuf,
        request: StandInRequest,
        table: Vec<emulate::Tarball>,
        bodies: Vec<(String, Vec<u8>)>,
    }

    impl StandInFix {
        // On Windows the block below is gone and the early `return` is the last statement; clippy calls it needless there.
        #[cfg_attr(windows, allow(clippy::needless_return))]
        fn new() -> Option<Self> {
            #[cfg(windows)]
            {
                return None;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let temp = Tmp::new();
                let data = temp.root.join("data");
                let stack_dir = temp.root.join("stack");
                let bin = temp.root.join("bin");
                std::fs::create_dir_all(&bin).unwrap();
                let node = bin.join("node");
                std::fs::write(
                    &node,
                    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo v24.0.0; fi\nexit 0\n",
                )
                .unwrap();
                std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
                let (table, bodies) = emulate::tests::fixture();
                let request = StandInRequest {
                    stack_dir: stack_dir.clone(),
                    services: vec![ServicePort {
                        service: "github".into(),
                        port: 22010,
                        base_url: "http://github-shop-wp-90.localhost:7400".into(),
                    }],
                    path_env: Some(bin.to_string_lossy().into_owned()),
                };
                Some(Self {
                    _temp: temp,
                    data,
                    stack_dir,
                    request,
                    table,
                    bodies,
                })
            }
        }

        fn stand_in(&self, fetcher: Arc<dyn Fetcher + Send + Sync>) -> EmulateStandIn {
            EmulateStandIn {
                data_dir: self.data.clone(),
                fetcher,
            }
        }

        fn online(&self) -> Arc<emulate::tests::Fake> {
            Arc::new(emulate::tests::Fake::online(self.bodies.clone()))
        }
    }

    fn without_a_shell() -> Option<StandInFix> {
        println!("skipped: this platform has no /bin/sh to make a fake node with");
        None
    }

    #[test]
    fn a_first_start_installs_the_stand_in_and_a_second_one_downloads_nothing() {
        let Some(fix) = StandInFix::new().or_else(without_a_shell) else {
            return;
        };
        let fetcher = fix.online();
        let stand_in = fix.stand_in(fetcher.clone());
        let first = stand_in.start_with(&fix.request, &fix.table).unwrap();
        assert!(first.pid.is_some(), "{first:?}");
        assert_eq!(fetcher.hits(), 4);
        assert!(emulate::installed(&fix.data).is_some());
        assert!(fix.stack_dir.join("emulate.config.json").is_file());
        assert!(fix.stack_dir.join("emulate.pid").is_file());
        let second = stand_in.start_with(&fix.request, &fix.table).unwrap();
        assert!(second.pid.is_some(), "{second:?}");
        assert_eq!(fetcher.hits(), 4, "the second start fetched something");
    }

    #[test]
    fn an_offline_download_leaves_the_stack_running_with_a_plain_note() {
        let Some(fix) = StandInFix::new().or_else(without_a_shell) else {
            return;
        };
        let fetcher: Arc<emulate::tests::Fake> = Arc::new(emulate::tests::Fake::offline());
        let stand_in = fix.stand_in(fetcher.clone());
        let outcome = stand_in.start_with(&fix.request, &fix.table).unwrap();
        assert_eq!(outcome.pid, None);
        assert_eq!(outcome.note.as_deref(), Some(emulate::DOWNLOAD_NOTE));
        assert_eq!(fetcher.hits(), 1);
        assert!(!fix.stack_dir.join("emulate.pid").exists());
        // Nothing that `installed` would accept, and no version folder left half-made.
        assert!(emulate::installed(&fix.data).is_none());
        assert!(!emulate::tool_dir(&fix.data).exists());
    }

    #[test]
    fn a_start_with_no_pin_says_nothing_was_downloaded() {
        let Some(fix) = StandInFix::new().or_else(without_a_shell) else {
            return;
        };
        let mut table = fix.table.clone();
        table[0].sha256 = "";
        let fetcher = fix.online();
        let stand_in = fix.stand_in(fetcher.clone());
        let outcome = stand_in.start_with(&fix.request, &table).unwrap();
        assert_eq!(outcome.pid, None);
        assert_eq!(outcome.note.as_deref(), Some(emulate::NOT_INSTALLED_NOTE));
        assert_eq!(fetcher.hits(), 0);
    }

    #[test]
    fn a_node_older_than_24_is_a_note_and_not_a_download() {
        let Some(fix) = StandInFix::new().or_else(without_a_shell) else {
            return;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let bin = fix.request.path_env.clone().unwrap();
            std::fs::write(
                Path::new(&bin).join("node"),
                "#!/bin/sh\necho v22.23.4\nexit 0\n",
            )
            .unwrap();
            std::fs::set_permissions(
                Path::new(&bin).join("node"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let fetcher = fix.online();
        let stand_in = fix.stand_in(fetcher.clone());
        let outcome = stand_in.start_with(&fix.request, &fix.table).unwrap();
        assert_eq!(outcome.pid, None);
        assert!(outcome
            .note
            .as_deref()
            .is_some_and(|note| note.contains("older than 24")));
        assert_eq!(fetcher.hits(), 0);
    }
}
