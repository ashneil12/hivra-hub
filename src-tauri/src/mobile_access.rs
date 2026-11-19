//! A paired phone controls the workspace through its owning app window.
//! No arbitrary Tauri commands or direct session database writes are exposed.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use monocode_mobile_link::{now, Address, Gate, Identity, PORT, VERSION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    fingerprint: String,
}
// Hivra: every field defaults to off or empty. Upstream's Default opened a router port (open_router: true); here no
// port mapping happens unless the person ticks it.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    enabled: bool,
    #[serde(default)]
    open_router: bool,
    #[serde(default)]
    remote_address: String,
    #[serde(default)]
    devices: Vec<Device>,
}
struct Invitation {
    expires: u64,
}
struct Pending {
    window: String,
    /// The paired device that asked. The answer is refused once it is no longer paired.
    peer: String,
    reply: oneshot::Sender<Value>,
}
/// A phone watching a conversation through the window that owns it.
struct Watcher {
    window: String,
    peer: String,
    sink: monocode_mobile_link::WatchSink,
}
struct Inner {
    watches: HashMap<String, Watcher>,
    config: Config,
    identity: Option<Identity>,
    endpoint: Option<quinn::Endpoint>,
    invitations: HashMap<String, Invitation>,
    catalogs: HashMap<String, Value>,
    pending: HashMap<String, Pending>,
    router_address: Option<Address>,
    router_status: String,
    router_started: bool,
}
#[derive(Clone)]
pub struct MobileHost {
    inner: Arc<Mutex<Inner>>,
    gate: Gate,
    path: PathBuf,
}
pub fn init(app: &AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mobile-access.json");
    let config: Config = if path.exists() {
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        Config::default()
    };
    let enabled = config.enabled;
    let gate = Gate::default();
    for device in &config.devices {
        gate.allow(device.fingerprint.clone(), None);
    }
    let host = MobileHost {
        inner: Arc::new(Mutex::new(Inner {
            config,
            identity: None,
            endpoint: None,
            invitations: HashMap::new(),
            catalogs: HashMap::new(),
            pending: HashMap::new(),
            watches: HashMap::new(),
            router_address: None,
            router_status: "Off".into(),
            router_started: false,
        })),
        gate,
        path,
    };
    app.manage(host.clone());
    // A dev copy never opens phone access (port 38416, UPnP), even with a copied setting (src/instance.rs).
    if enabled && crate::instance::policy().phone_access {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = start(&app, &host).await {
                host.inner.lock().unwrap().router_status = error;
            }
        });
    }
    Ok(())
}
fn save(host: &MobileHost, config: &Config) -> Result<(), String> {
    let parent = host.path.parent().ok_or("Invalid mobile settings path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".mobile-access-{}.json", uuid::Uuid::new_v4()));
    std::fs::write(
        &temporary,
        serde_json::to_vec(config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &host.path).map_err(|e| e.to_string())
}
fn identity(host: &MobileHost) -> Result<Identity, String> {
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Mobile service unavailable")?;
    if let Some(identity) = &inner.identity {
        return Ok(identity.clone());
    }
    let account = format!("desktop:{}", host.path.display());
    let entry = keyring::Entry::new("com.monocode.mobile", &account).map_err(|e| e.to_string())?;
    let identity = match entry.get_password() {
        Ok(value) => {
            serde_json::from_str(&value).map_err(|_| "Saved desktop mobile identity is invalid")?
        }
        Err(keyring::Error::NoEntry) => {
            if !inner.config.devices.is_empty() {
                return Err("Desktop mobile identity is missing. Remove paired devices before creating a new identity.".into());
            }
            let identity = Identity::generate()?;
            entry
                .set_password(&serde_json::to_string(&identity).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            identity
        }
        Err(error) => return Err(format!("Cannot read desktop mobile identity: {error}")),
    };
    inner.identity = Some(identity.clone());
    Ok(identity)
}
fn addresses(inner: &Inner) -> Vec<Address> {
    let mut result: Vec<Address> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| {
            let ip = interface.ip();
            if ip.is_loopback()
                || ip.is_unspecified()
                || matches!(ip, std::net::IpAddr::V6(v) if v.is_unicast_link_local())
            {
                None
            } else {
                Some(Address {
                    host: ip.to_string(),
                    port: PORT,
                })
            }
        })
        .collect();
    if let Some(address) = &inner.router_address {
        result.insert(0, address.clone());
    }
    if let Ok(address) = Address::parse(&inner.config.remote_address) {
        result.insert(0, address);
    }
    result.dedup();
    result.truncate(16);
    result
}
fn name() -> String {
    hostname::get()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
#[tauri::command]
pub fn mobile_status(host: State<'_, MobileHost>) -> Result<Value, String> {
    let inner = host
        .inner
        .lock()
        .map_err(|_| "Mobile service unavailable")?;
    Ok(
        json!({"enabled":inner.config.enabled,"listening":inner.endpoint.is_some(),"name":name(),"fingerprint":inner.identity.as_ref().and_then(|v| v.fingerprint().ok()),"addresses":addresses(&inner),"devices":inner.config.devices,"openRouter":inner.config.open_router,"remoteAddress":inner.config.remote_address,"routerStatus":inner.router_status}),
    )
}
async fn start(app: &AppHandle, host: &MobileHost) -> Result<(), String> {
    let identity = identity(host)?;
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Mobile service unavailable")?;
    if inner.endpoint.is_some() {
        return Ok(());
    }
    let endpoint = monocode_mobile_link::server_endpoint(
        &identity,
        host.gate.clone(),
        format!("[::]:{PORT}").parse().unwrap(),
    )?;
    inner.endpoint = Some(endpoint.clone());
    drop(inner);
    let service = host.clone();
    let watching = host.clone();
    let app = app.clone();
    let watch_app = app.clone();
    tauri::async_runtime::spawn(monocode_mobile_link::serve(
        endpoint,
        host.gate.clone(),
        move |peer, request| {
            let host = service.clone();
            let app = app.clone();
            async move { handle(&app, &host, &peer, request).await }
        },
        move |peer, request, sink| {
            let host = watching.clone();
            let app = watch_app.clone();
            async move { watch(&app, &host, &peer, request, sink) }
        },
    ));
    crate::mobile_router::restart(host);
    Ok(())
}
#[tauri::command]
pub async fn mobile_configure(
    app: AppHandle,
    host: State<'_, MobileHost>,
    enabled: bool,
    open_router: bool,
    remote_address: String,
) -> Result<(), String> {
    if enabled && !crate::instance::policy().phone_access {
        return Err("Phone access is off in a dev copy.".into());
    }
    if !remote_address.trim().is_empty() {
        Address::parse(&remote_address)?;
    }
    {
        let mut inner = host
            .inner
            .lock()
            .map_err(|_| "Mobile service unavailable")?;
        let config = Config {
            enabled,
            open_router,
            remote_address: remote_address.trim().into(),
            devices: inner.config.devices.clone(),
        };
        save(&host, &config)?;
        inner.config = config;
        if !enabled {
            if let Some(endpoint) = inner.endpoint.take() {
                endpoint.close(1_u32.into(), b"Mobile access disabled");
            }
            for key in inner.invitations.keys() {
                host.gate.remove(key);
            }
            inner.invitations.clear();
            inner.pending.clear();
            inner.watches.clear();
        }
    }
    if enabled {
        start(&app, &host).await?;
    }
    crate::mobile_router::restart(&host);
    Ok(())
}
#[tauri::command]
pub fn mobile_invite(host: State<'_, MobileHost>) -> Result<Value, String> {
    let identity = identity(&host)?;
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Mobile service unavailable")?;
    if !inner.config.enabled || inner.endpoint.is_none() {
        return Err("Enable mobile access first".into());
    }
    // One visible invitation at a time; closing or replacing it revokes its key.
    for key in inner.invitations.keys() {
        host.gate.remove(key);
    }
    inner.invitations.clear();
    let join = Identity::generate()?;
    let key = join.fingerprint()?;
    let expires = now() + 15 * 60;
    host.gate.allow(key.clone(), Some(expires));
    inner.invitations.insert(key, Invitation { expires });
    let invitation = json!({"version":VERSION,"name":name(),"fingerprint":identity.fingerprint()?,"addresses":addresses(&inner),"identity":join,"expires":expires});
    let code = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invitation).map_err(|e| e.to_string())?);
    Ok(json!({"url":format!("monocode://pair?i={code}"),"expires":expires}))
}
#[tauri::command]
pub fn mobile_cancel_invite(host: State<'_, MobileHost>) {
    let mut inner = host.inner.lock().unwrap();
    for key in inner.invitations.keys() {
        host.gate.remove(key);
    }
    inner.invitations.clear();
}
#[tauri::command]
pub fn mobile_revoke(host: State<'_, MobileHost>, device_id: String) -> Result<(), String> {
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Mobile service unavailable")?;
    forget_device(&host, &mut inner, &device_id)
}

/// Drops one paired device: its key, its watches, then the saved list.
fn forget_device(host: &MobileHost, inner: &mut Inner, device_id: &str) -> Result<(), String> {
    let mut config = inner.config.clone();
    if let Some(device) = config.devices.iter().find(|v| v.id == device_id) {
        host.gate.remove(&device.fingerprint);
        let peer = device.fingerprint.clone();
        inner.watches.retain(|_, watch| watch.peer != peer);
    }
    config.devices.retain(|device| device.id != device_id);
    save(host, &config)?;
    inner.config = config;
    Ok(())
}
#[tauri::command]
pub fn mobile_publish(
    window: WebviewWindow,
    host: State<'_, MobileHost>,
    catalog: Value,
) -> Result<(), String> {
    if !crate::window::is_workspace_window(window.label()) {
        return Err("Only workspace windows can publish mobile data".into());
    }
    if !catalog["projects"].is_array()
        || !catalog["monos"].is_array()
        || !catalog["sessions"].is_array()
    {
        return Err("Invalid mobile catalog".into());
    }
    host.inner
        .lock()
        .map_err(|_| "Mobile service unavailable")?
        .catalogs
        .insert(window.label().into(), catalog);
    Ok(())
}
/// The owning window asks, right before it runs a phone approval, whether that approval is still
/// open. A request that timed out, was answered, or whose device was revoked or disabled is refused.
#[tauri::command]
pub fn mobile_admits(window: WebviewWindow, host: State<'_, MobileHost>, id: String) -> bool {
    let inner = host.inner.lock().unwrap();
    approval_still_open(
        &inner,
        &id,
        window.label(),
        crate::instance::policy().phone_access,
    )
}
#[tauri::command]
pub fn mobile_reply(
    window: WebviewWindow,
    host: State<'_, MobileHost>,
    id: String,
    response: Value,
) {
    let mut inner = host.inner.lock().unwrap();
    if inner
        .pending
        .get(&id)
        .is_some_and(|pending| pending.window == window.label())
    {
        if let Some(pending) = inner.pending.remove(&id) {
            let _ = pending.reply.send(response);
        }
    }
}
/// The owning window's next update for a watch. "busy" means the phone has not
/// taken the last ones yet: keep the baseline and send again later.
#[tauri::command]
pub fn mobile_push(
    window: WebviewWindow,
    host: State<'_, MobileHost>,
    id: String,
    update: Value,
) -> Result<(), String> {
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Mobile service unavailable")?;
    let watch = inner
        .watches
        .get(&id)
        .filter(|watch| watch.window == window.label())
        .ok_or("gone")?;
    match watch.sink.try_send(update) {
        Ok(()) => Ok(()),
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => Err("busy".into()),
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
            inner.watches.remove(&id);
            Err("gone".into())
        }
    }
}
/// A phone starts watching a conversation. The owning window sends its state,
/// then every change, through `mobile_push` until the phone or window goes.
fn watch(
    app: &AppHandle,
    host: &MobileHost,
    peer: &str,
    request: Value,
    sink: monocode_mobile_link::WatchSink,
) -> Result<(), String> {
    if request["version"] != VERSION {
        return Err("Update MonoCode on both devices".into());
    }
    if request["method"] != "conversation.watch" {
        return Err("Unsupported mobile operation".into());
    }
    let conversation = request["params"]["conversationId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .ok_or("Missing workspace item")?
        .to_string();
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Mobile service unavailable")?;
    if !inner.config.enabled {
        return Err("Mobile access disabled".into());
    }
    if !inner
        .config
        .devices
        .iter()
        .any(|device| device.fingerprint == peer)
    {
        return Err("Device revoked or not paired".into());
    }
    inner.watches.retain(|_, watch| !watch.sink.is_closed());
    if inner
        .watches
        .values()
        .filter(|watch| watch.peer == peer)
        .count()
        >= 4
    {
        return Err("Desktop is busy; try again".into());
    }
    merged_catalog(app, &mut inner);
    let window = pick_owner(&inner.catalogs, "conversation.watch", &conversation)
        .ok_or("This workspace item is no longer available")?;
    let id = uuid::Uuid::new_v4().to_string();
    app.emit_to(
        window.as_str(),
        "monocode-mobile-watch",
        json!({
            "id": id,
            "conversationId": conversation,
            "action": "start",
            // Where the phone wants the watch to open: its latest turns, or on
            // from the first turn it already has.
            "tail": request["params"]["tail"].as_u64(),
            "from": request["params"]["from"].as_str().filter(|from| from.len() <= 256),
            // Opt in: older phones continue receiving complete changed turns.
            "incremental": request["params"]["incremental"] == true,
        }),
    )
    .map_err(|_| "Desktop window is unavailable")?;
    inner.watches.insert(
        id.clone(),
        Watcher {
            window: window.clone(),
            peer: peer.into(),
            sink: sink.clone(),
        },
    );
    drop(inner);
    // End the watch with the phone or the window, whichever goes first.
    let host = host.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = sink.closed() => break,
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    let watching = host.inner.lock().is_ok_and(|inner| inner.watches.contains_key(&id));
                    if !watching || app.get_webview_window(&window).is_none() {
                        break;
                    }
                }
            }
        }
        if let Ok(mut inner) = host.inner.lock() {
            inner.watches.remove(&id);
        }
        let _ = app.emit_to(
            window.as_str(),
            "monocode-mobile-watch",
            json!({"id":id,"action":"stop"}),
        );
    });
    Ok(())
}
fn merged_catalog(app: &AppHandle, inner: &mut Inner) -> Value {
    inner
        .catalogs
        .retain(|window, _| app.get_webview_window(window).is_some());
    merge_catalogs(&inner.catalogs)
}

/// The workspace poll. Approvals stay on each window's catalog; they are not part of this poll.
fn merge_catalogs(catalogs: &HashMap<String, Value>) -> Value {
    let mut result = json!({"projects":[],"monos":[],"sessions":[]});
    for field in ["projects", "monos", "sessions"] {
        let mut items = HashMap::new();
        for catalog in catalogs.values() {
            for item in catalog[field].as_array().into_iter().flatten() {
                if let Some(id) = item["id"].as_str() {
                    let rank = |value: &Value| {
                        (
                            value["busy"] == true,
                            value["live"] == true,
                            value["updatedAt"].as_u64(),
                        )
                    };
                    if items
                        .get(id)
                        .is_none_or(|previous| rank(item) > rank(previous))
                    {
                        items.insert(id.to_owned(), item.clone());
                    }
                }
            }
        }
        let mut items: Vec<_> = items.into_values().collect();
        items.sort_by(|a, b| {
            if field == "sessions" {
                return b["updatedAt"].as_u64().cmp(&a["updatedAt"].as_u64());
            }
            a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or(""))
        });
        result[field] = json!(items);
    }
    result
}
/// How many of a project's sessions the workspace poll carries; the sessions
/// sheet pages through the rest with `sessions.list`.
const RECENT_SESSIONS: usize = 20;
const SESSION_PAGE_MAX: usize = 100;

/// The workspace poll's sessions: each project's most recent, every busy one,
/// and every Mono's. `sessions` is newest first, as `merged_catalog` sorts it.
fn recent_sessions(sessions: &Value) -> Vec<Value> {
    let mut per_project: HashMap<&str, usize> = HashMap::new();
    sessions
        .as_array()
        .into_iter()
        .flatten()
        .filter(|session| {
            let count = per_project
                .entry(session["projectId"].as_str().unwrap_or(""))
                .or_default();
            *count += 1;
            *count <= RECENT_SESSIONS || session["busy"] == true || session["monoId"].is_string()
        })
        .cloned()
        .collect()
}

/// One page of a project's sessions, newest first, optionally matching a query
/// against title, model and branch.
fn session_page(sessions: &Value, params: &Value) -> Value {
    let project = params["projectId"].as_str().unwrap_or("");
    let query = params["query"].as_str().unwrap_or("").trim().to_lowercase();
    let offset = params["offset"].as_u64().unwrap_or(0) as usize;
    let limit = (params["limit"].as_u64().unwrap_or(30) as usize).clamp(1, SESSION_PAGE_MAX);
    // The Sessions screen's filters: active since a time, and providers left out.
    let since = params["since"].as_f64().unwrap_or(0.0);
    let hidden: Vec<&str> = params["hiddenHarnesses"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let matches: Vec<&Value> = sessions
        .as_array()
        .into_iter()
        .flatten()
        .filter(|session| session["projectId"] == project)
        .filter(|session| since <= 0.0 || session["updatedAt"].as_f64().unwrap_or(0.0) >= since)
        .filter(|session| {
            !session["harness"]
                .as_str()
                .is_some_and(|harness| hidden.contains(&harness))
        })
        .filter(|session| {
            query.is_empty()
                || ["title", "model", "branch"].iter().any(|field| {
                    session[*field]
                        .as_str()
                        .is_some_and(|value| value.to_lowercase().contains(&query))
                })
        })
        .collect();
    let page: Vec<&Value> = matches.iter().skip(offset).take(limit).copied().collect();
    json!({
        "sessions": page,
        "hasMore": offset + page.len() < matches.len(),
    })
}

/// `Number.MAX_SAFE_INTEGER`. A request id the phone cannot round-trip is not a request id.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn is_pairing_method(method: &str) -> bool {
    matches!(
        method,
        "session.approve" | "session.deny" | "inbox.list" | "crew.status"
    )
}

/// Whether `peer` may use the pairing methods right now: the service is on, phone access is on,
/// and the peer is still a paired device. handle() and the approval checks both use this.
fn authorize_pairing(config: &Config, peer: &str, phone_access: bool) -> Result<(), String> {
    let paired = config
        .devices
        .iter()
        .any(|device| device.fingerprint == peer);
    pairing_gate(config.enabled, phone_access, paired)
}

/// An approval the window may still run: its request is pending for this window, and the
/// device that asked is still paired with access on. A request that timed out, was answered,
/// or whose device was revoked or disabled is not run.
fn approval_still_open(inner: &Inner, id: &str, window: &str, phone_access: bool) -> bool {
    inner.pending.get(id).is_some_and(|pending| {
        pending.window == window
            && authorize_pairing(&inner.config, &pending.peer, phone_access).is_ok()
    })
}

/// Inbox, crew, and one tool call. Anything short of on, allowed, and paired is a refusal.
fn pairing_gate(enabled: bool, phone_access: bool, paired: bool) -> Result<(), String> {
    if !enabled {
        return Err("Mobile access disabled".into());
    }
    if !phone_access {
        return Err("Phone access is off.".into());
    }
    if !paired {
        return Err("Device revoked or not paired".into());
    }
    Ok(())
}

fn rejects_blanket(params: &Value) -> Result<(), String> {
    let Some(object) = params.as_object() else {
        return Ok(());
    };
    for key in ["all", "scope", "approveAll", "allowAll"] {
        if object.get(key).is_some_and(|value| !value.is_null()) {
            return Err("One tool call at a time.".into());
        }
    }
    if matches!(
        object.get("decision").and_then(Value::as_str),
        Some("allow_all" | "allow-all" | "all")
    ) {
        return Err("One tool call at a time.".into());
    }
    Ok(())
}

/// The method names the decision. A missing decision is that decision. Any other word is a refusal.
fn decision_conflict(method: &str, params: &Value) -> Result<(), String> {
    let expected = if method == "session.approve" {
        "allow"
    } else {
        "deny"
    };
    match params.get("decision") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(value)) if value == expected => Ok(()),
        _ => Err("This approval does not match a waiting tool call.".into()),
    }
}

fn command_equal(echo: Option<&Value>, stored: Option<&Value>) -> bool {
    let echo = echo.filter(|value| !value.is_null());
    let stored = stored.filter(|value| !value.is_null());
    match (echo, stored) {
        (None, None) => true,
        (Some(Value::String(left)), Some(Value::String(right))) => left == right,
        _ => false,
    }
}

fn path_text(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|path| path.len() <= 1024 && !path.contains('\0'))
}

/// Omitted paths match an empty list. Anything else must be the same list, in order.
fn paths_equal(echo: Option<&Value>, stored: Option<&Value>) -> bool {
    let Some(stored) = (match stored {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Array(paths)) if paths.len() <= 64 => {
            paths.iter().map(path_text).collect::<Option<Vec<_>>>()
        }
        Some(_) => None,
    }) else {
        return false;
    };
    match echo {
        None => stored.is_empty(),
        Some(Value::Array(paths)) if paths.len() == stored.len() && paths.len() <= 64 => paths
            .iter()
            .zip(stored)
            .all(|(echo, stored)| path_text(echo) == Some(stored)),
        Some(_) => false,
    }
}

fn echo_matches(params: &Value, row: &Value) -> bool {
    let Some(tool) = params.get("tool").and_then(Value::as_str) else {
        return false;
    };
    row.get("tool").and_then(Value::as_str) == Some(tool)
        && command_equal(params.get("command"), row.get("command"))
        && paths_equal(params.get("paths"), row.get("paths"))
}

/// A listed chat, or the session a published Mono names. A Mono's chat is not a session card.
fn conversation_listed(catalog: &Value, conversation: &str) -> bool {
    catalog
        .get("sessions")
        .and_then(Value::as_array)
        .is_some_and(|sessions| sessions.iter().any(|session| session["id"] == conversation))
        || catalog
            .get("monos")
            .and_then(Value::as_array)
            .is_some_and(|monos| monos.iter().any(|mono| mono["sessionId"] == conversation))
}

fn presence_rank(item: &Value) -> u8 {
    if item["busy"] == true {
        3
    } else if item["live"] == true {
        2
    } else {
        1
    }
}

/// The window that published this call. A Mono's chat routes with the Mono, not the session list.
fn approval_owner(catalogs: &HashMap<String, Value>, params: &Value) -> Option<String> {
    let conversation = params.get("conversationId").and_then(Value::as_str)?;
    let request_id = params.get("requestId").and_then(Value::as_u64)?;
    catalogs
        .iter()
        .filter_map(|(window, catalog)| {
            if !conversation_listed(catalog, conversation) {
                return None;
            }
            let rows = catalog.get("approvals").and_then(Value::as_array)?;
            let hit = rows.iter().any(|row| {
                row["conversationId"] == conversation
                    && row["requestId"].as_u64() == Some(request_id)
                    && echo_matches(params, row)
            });
            if !hit {
                return None;
            }
            let rank = catalog
                .get("sessions")
                .and_then(Value::as_array)
                .and_then(|sessions| {
                    sessions
                        .iter()
                        .find(|session| session["id"] == conversation)
                })
                .or_else(|| {
                    catalog
                        .get("monos")
                        .and_then(Value::as_array)
                        .and_then(|monos| {
                            monos.iter().find(|mono| mono["sessionId"] == conversation)
                        })
                })
                .map(presence_rank)
                .unwrap_or(1);
            Some((window, rank))
        })
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(window, _)| window.clone())
}

/// The phone's echo against every window's published calls. A disagreement wins over a match.
fn match_approval(catalogs: &HashMap<String, Value>, params: &Value) -> Result<(), String> {
    let conversation = params
        .get("conversationId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if conversation.is_empty() || conversation.len() > 256 || conversation.contains('\0') {
        return Err("This approval does not match a waiting tool call.".into());
    }
    let Some(request_id) = params.get("requestId").and_then(Value::as_u64) else {
        return Err("Missing approval request.".into());
    };
    if request_id > MAX_SAFE_INTEGER {
        return Err("Missing approval request.".into());
    }
    if catalogs
        .values()
        .any(|catalog| catalog.get("approvalsTruncated") == Some(&Value::Bool(true)))
    {
        return Err("Too many approvals to list from the phone.".into());
    }
    let mut agreed = false;
    let mut disagreed = false;
    for catalog in catalogs.values() {
        let Some(rows) = catalog.get("approvals").and_then(Value::as_array) else {
            continue;
        };
        let listed = conversation_listed(catalog, conversation);
        for row in rows {
            if row["conversationId"] != conversation
                || row["requestId"].as_u64() != Some(request_id)
            {
                continue;
            }
            // A window that did not publish the session is not a hit. A different command is.
            if !echo_matches(params, row) {
                disagreed = true;
            } else if listed {
                agreed = true;
            }
        }
    }
    if disagreed {
        return Err("The command does not match.".into());
    }
    if !agreed {
        return Err("This approval does not match a waiting tool call.".into());
    }
    Ok(())
}

/// The window that reads the inbox and the crew: a busy one, then a live one, then the smaller label.
fn workspace_owner(catalogs: &HashMap<String, Value>) -> Option<String> {
    catalogs
        .iter()
        .map(|(window, catalog)| {
            let rank = catalog
                .get("sessions")
                .and_then(Value::as_array)
                .map(|sessions| {
                    if sessions.iter().any(|session| session["busy"] == true) {
                        3
                    } else if sessions.iter().any(|session| session["live"] == true) {
                        2
                    } else {
                        1
                    }
                })
                .unwrap_or(1);
            (window, rank)
        })
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(window, _)| window.clone())
}

fn pick_owner(catalogs: &HashMap<String, Value>, method: &str, entity: &str) -> Option<String> {
    catalogs
        .iter()
        .filter_map(|(window, catalog)| {
            let (field, id) = if method == "session.start" || method == "project.changes" {
                ("projects", entity)
            } else if let Some(mono) = entity.strip_prefix("mono:") {
                ("monos", mono)
            } else {
                ("sessions", entity)
            };
            catalog[field]
                .as_array()?
                .iter()
                .find(|item| item["id"] == id)
                .map(|item| {
                    let rank = if item["busy"] == true {
                        3
                    } else if item["live"] == true {
                        2
                    } else {
                        1
                    };
                    (window, rank)
                })
        })
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(window, _)| window.clone())
}
fn session_id(command_id: &str) -> String {
    let digest = Sha256::digest(format!("monocode-mobile/session:{command_id}"));
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    // UUID version 8 reserves the custom data format used here.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}
fn enroll(
    host: &MobileHost,
    inner: &mut Inner,
    peer: &str,
    params: &Value,
) -> Result<Value, String> {
    let invitation = inner
        .invitations
        .get(peer)
        .ok_or("Invitation already used or revoked")?;
    if invitation.expires <= now() {
        return Err("Invitation expired".into());
    }
    let certificate = params["certificate"]
        .as_str()
        .ok_or("Missing device identity")?;
    let proof = params["proof"].as_str().ok_or("Missing device proof")?;
    let fingerprint = monocode_mobile_link::verify_proof(certificate, peer, proof)?;
    let name = params["name"]
        .as_str()
        .unwrap_or("Phone")
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    let id = uuid::Uuid::new_v4().to_string();
    let mut config = inner.config.clone();
    config
        .devices
        .retain(|device| device.fingerprint != fingerprint);
    config.devices.push(Device {
        id: id.clone(),
        name,
        fingerprint: fingerprint.clone(),
    });
    save(host, &config)?;
    inner.config = config;
    inner.invitations.remove(peer);
    host.gate.remove(peer);
    host.gate.allow(fingerprint, None);
    Ok(
        json!({"deviceId":id,"name":crate::mobile_access::name(),"fingerprint":inner.identity.as_ref().unwrap().fingerprint()?,"addresses":addresses(inner)}),
    )
}
async fn handle(
    app: &AppHandle,
    host: &MobileHost,
    peer: &str,
    request: Value,
) -> Result<Value, String> {
    if request["version"] != VERSION {
        return Err("Update MonoCode on both devices".into());
    }
    let method = request["method"].as_str().ok_or("Invalid mobile method")?;
    let mut params = request["params"].clone();
    if !params.is_object() {
        return Err("Invalid mobile parameters".into());
    }
    let receiver = {
        let mut inner = host
            .inner
            .lock()
            .map_err(|_| "Mobile service unavailable")?;
        if !inner.config.enabled {
            return Err("Mobile access disabled".into());
        }
        if method == "device.enroll" {
            return enroll(host, &mut inner, peer, &params);
        }
        let device = inner
            .config
            .devices
            .iter()
            .find(|device| device.fingerprint == peer)
            .ok_or("Device revoked or not paired")?
            .clone();
        if method == "device.leave" {
            let mut config = inner.config.clone();
            config.devices.retain(|v| v.id != device.id);
            save(host, &config)?;
            inner.config = config;
            host.gate.remove(peer);
            inner.watches.retain(|_, watch| watch.peer != peer);
            return Ok(Value::Null);
        }
        if method == "workspace.list" {
            let mut catalog = merged_catalog(app, &mut inner);
            catalog["sessions"] = json!(recent_sessions(&catalog["sessions"]));
            catalog["addresses"] = json!(addresses(&inner));
            return Ok(catalog);
        }
        if method == "sessions.list" {
            let catalog = merged_catalog(app, &mut inner);
            return Ok(session_page(&catalog["sessions"], &params));
        }
        // WP-150: inbox, crew, and one tool call. Refused unless phone access is on.
        if is_pairing_method(method) {
            authorize_pairing(&inner.config, peer, crate::instance::policy().phone_access)?;
        }
        if ![
            "conversation.read",
            "conversation.older",
            "models.list",
            "accounts.usage",
            "session.configure",
            "project.changes",
            "project.worktrees",
            "project.files",
            "project.file",
            "project.search",
            "project.fileHighlight",
            "project.git",
            "project.gitAction",
            "session.start",
            "conversation.send",
            "session.answerQuestion",
            "session.keepQuestionOpen",
            "session.resumeUsage",
            "session.resumeUsageAtReset",
            "session.cancel",
            "session.rename",
            "session.delete",
            "session.archive",
            "session.approve",
            "session.deny",
            "inbox.list",
            "crew.status",
        ]
        .contains(&method)
        {
            return Err("Unsupported mobile operation".into());
        }
        if inner.pending.len() >= 16 {
            return Err("Desktop is busy; try again".into());
        }
        let catalog = merged_catalog(app, &mut inner);
        if method == "session.approve" || method == "session.deny" {
            // The window checks the phone's original echo again. Do not rewrite it.
            rejects_blanket(&params)?;
            decision_conflict(method, &params)?;
            match_approval(&inner.catalogs, &params)?;
        }
        // The model sheet asks about a conversation when it has one, else a
        // project, and goes to the window that owns whichever it named.
        let owner = if method == "inbox.list" || method == "crew.status" {
            workspace_owner(&inner.catalogs).ok_or("Desktop window is unavailable")?
        } else if method == "session.approve" || method == "session.deny" {
            // The window that published the call, including a Mono's own chat.
            approval_owner(&inner.catalogs, &params)
                .ok_or("This workspace item is no longer available")?
        } else {
            let route = match method {
                "models.list" if params["conversationId"].is_string() => "conversation.read",
                "models.list"
                | "accounts.usage"
                | "project.worktrees"
                | "project.files"
                | "project.file"
                | "project.search"
                | "project.fileHighlight"
                | "project.git"
                | "project.gitAction" => "project.changes",
                _ => method,
            };
            let entity = if route == "session.start" || route == "project.changes" {
                params["projectId"].as_str()
            } else {
                params["conversationId"].as_str()
            }
            .ok_or("Missing workspace item")?;
            pick_owner(&inner.catalogs, route, entity)
                .ok_or("This workspace item is no longer available")?
        };
        drop(catalog);
        let id = uuid::Uuid::new_v4().to_string();
        let command_id = request["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("Missing command ID")?;
        let command_id = format!("{}:{command_id}", device.id);
        if method == "session.start" {
            params["sessionId"] = json!(session_id(&command_id));
        }
        let (send, receive) = oneshot::channel();
        inner.pending.insert(
            id.clone(),
            Pending {
                window: owner.clone(),
                peer: peer.to_string(),
                reply: send,
            },
        );
        if app
            .emit_to(
                owner.as_str(),
                "monocode-mobile-request",
                json!({"id":id,"commandId":command_id,"method":method,"params":params}),
            )
            .is_err()
        {
            inner.pending.remove(&id);
            return Err("Desktop window is unavailable".into());
        }
        (id, receive)
    };
    let response = tokio::time::timeout(Duration::from_secs(25), receiver.1).await;
    host.inner.lock().unwrap().pending.remove(&receiver.0);
    let response = response
        .map_err(|_| "Desktop window did not answer")?
        .map_err(|_| "Desktop window closed")?;
    if !host.gate.admits(peer) {
        return Err("Device revoked".into());
    }
    if response["ok"] == true {
        Ok(response["result"].clone())
    } else {
        Err(response["error"]
            .as_str()
            .unwrap_or("Desktop request failed")
            .into())
    }
}

pub(super) fn router_config(host: &MobileHost) -> bool {
    let inner = host.inner.lock().unwrap();
    inner.config.enabled && inner.config.open_router && inner.endpoint.is_some()
}
pub(super) fn router_result(host: &MobileHost, address: Option<Address>, status: String) {
    let mut inner = host.inner.lock().unwrap();
    inner.router_address = address;
    inner.router_status = status;
}
pub(super) fn router_claim(host: &MobileHost) -> bool {
    let mut inner = host.inner.lock().unwrap();
    if inner.router_started {
        false
    } else {
        inner.router_started = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_prefer_the_live_busy_owner_and_choose_stably_between_idle_windows() {
        let catalogs = HashMap::from([
            (
                "main".into(),
                json!({"sessions":[{"id":"s","live":false}],"projects":[{"id":"p"}]}),
            ),
            (
                "workspace-1".into(),
                json!({"sessions":[{"id":"s","live":true,"busy":true}],"projects":[{"id":"p"}]}),
            ),
        ]);
        assert_eq!(
            pick_owner(&catalogs, "conversation.send", "s").as_deref(),
            Some("workspace-1")
        );
        assert_eq!(
            pick_owner(&catalogs, "session.start", "p").as_deref(),
            Some("main")
        );
        assert!(pick_owner(&catalogs, "conversation.read", "missing").is_none());
    }
    #[test]
    fn the_poll_carries_recent_sessions_and_pages_serve_the_rest() {
        let sessions: Vec<Value> = (0..30)
            .map(|i| json!({"id":format!("s{i}"),"projectId":"p","title":format!("Task {i}"),"busy":i == 25}))
            .chain([json!({"id":"m","projectId":"p","monoId":"mono"})])
            .collect();
        let sessions = json!(sessions);
        let recent = recent_sessions(&sessions);
        assert_eq!(recent.len(), RECENT_SESSIONS + 2);
        assert!(recent.iter().any(|s| s["id"] == "s25"));

        let page = session_page(&sessions, &json!({"projectId":"p","offset":28,"limit":10}));
        assert_eq!(page["sessions"].as_array().unwrap().len(), 3);
        assert_eq!(page["hasMore"], false);
        let page = session_page(&sessions, &json!({"projectId":"p","limit":2}));
        assert_eq!(page["hasMore"], true);
        let found = session_page(&sessions, &json!({"projectId":"p","query":"task 2"}));
        assert_eq!(found["sessions"].as_array().unwrap().len(), 11);
        let filtered: Vec<Value> = [
            json!({"id":"a","projectId":"p","harness":"claude","updatedAt":200}),
            json!({"id":"b","projectId":"p","harness":"codex","updatedAt":300}),
            json!({"id":"c","projectId":"p","harness":"claude","updatedAt":100}),
        ]
        .into();
        let filtered = json!(filtered);
        let ids = |params: Value| -> Vec<String> {
            session_page(&filtered, &params)["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["id"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(ids(json!({"projectId":"p","since":150})), ["a", "b"]);
        assert_eq!(
            ids(json!({"projectId":"p","hiddenHarnesses":["codex"]})),
            ["a", "c"]
        );
        assert!(
            session_page(&sessions, &json!({"projectId":"q"}))["sessions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn session_commands_have_stable_device_scoped_ids_across_restarts() {
        let id = session_id("device-a:request-a");
        assert_eq!(id, session_id("device-a:request-a"));
        assert_ne!(id, session_id("device-b:request-a"));
        assert!(uuid::Uuid::parse_str(&id).is_ok());
    }
    fn fixture() -> (MobileHost, Identity, Identity) {
        let join = Identity::generate().unwrap();
        let phone = Identity::generate().unwrap();
        let key = join.fingerprint().unwrap();
        let gate = Gate::default();
        gate.allow(key.clone(), Some(now() + 900));
        let path = std::env::temp_dir()
            .join(format!("monocode-mobile-test-{}", uuid::Uuid::new_v4()))
            .join("settings.json");
        let mut invitations = HashMap::new();
        invitations.insert(
            key,
            Invitation {
                expires: now() + 900,
            },
        );
        let host = MobileHost {
            gate,
            path,
            inner: Arc::new(Mutex::new(Inner {
                config: Config {
                    enabled: true,
                    ..Config::default()
                },
                identity: Some(Identity::generate().unwrap()),
                endpoint: None,
                invitations,
                catalogs: HashMap::new(),
                pending: HashMap::new(),
                watches: HashMap::new(),
                router_address: None,
                router_status: "Off".into(),
                router_started: false,
            })),
        };
        (host, join, phone)
    }
    #[test]
    fn invitation_is_consumed_once_and_only_public_device_metadata_is_persisted() {
        let (host, join, phone) = fixture();
        let key = join.fingerprint().unwrap();
        let params = json!({"certificate":phone.certificate,"proof":phone.proof(&key).unwrap(),"name":"iPhone"});
        let mut inner = host.inner.lock().unwrap();
        let result = enroll(&host, &mut inner, &key, &params).unwrap();
        assert!(result["deviceId"].is_string());
        assert!(!host.gate.admits(&key));
        assert!(host.gate.admits(&phone.fingerprint().unwrap()));
        assert!(enroll(&host, &mut inner, &key, &params).is_err());
        let saved = std::fs::read_to_string(&host.path).unwrap();
        assert!(!saved.contains("privateKey") && !saved.contains(&phone.private_key));
        assert_eq!(inner.config.devices.len(), 1);
        std::fs::remove_dir_all(host.path.parent().unwrap()).unwrap();
    }
    #[test]
    fn invalid_proof_or_expiration_does_not_consume_an_invitation_or_enroll_a_device() {
        let (host, join, phone) = fixture();
        let key = join.fingerprint().unwrap();
        let mut inner = host.inner.lock().unwrap();
        let params = json!({"certificate":phone.certificate,"proof":phone.proof("different-invitation").unwrap()});
        assert!(enroll(&host, &mut inner, &key, &params).is_err());
        assert!(inner.config.devices.is_empty() && inner.invitations.contains_key(&key));
        inner.invitations.get_mut(&key).unwrap().expires = now() - 1;
        let params = json!({"certificate":phone.certificate,"proof":phone.proof(&key).unwrap()});
        assert!(enroll(&host, &mut inner, &key, &params).is_err());
        assert!(inner.config.devices.is_empty() && !host.path.exists());
    }
    #[test]
    fn mobile_access_stays_off_and_the_router_default_is_off() {
        let config = Config::default();
        assert!(!config.enabled);
        assert!(!config.open_router);
        assert!(config.devices.is_empty());
        assert!(config.remote_address.is_empty());
    }
    #[test]
    fn pairing_methods_are_refused_unless_access_policy_and_the_device_all_allow() {
        assert_eq!(
            pairing_gate(false, true, true).unwrap_err(),
            "Mobile access disabled"
        );
        assert_eq!(
            pairing_gate(true, false, true).unwrap_err(),
            "Phone access is off."
        );
        assert_eq!(
            pairing_gate(true, true, false).unwrap_err(),
            "Device revoked or not paired"
        );
        assert!(pairing_gate(true, true, true).is_ok());
        assert!(is_pairing_method("session.approve"));
        assert!(is_pairing_method("session.deny"));
        assert!(is_pairing_method("inbox.list"));
        assert!(is_pairing_method("crew.status"));
        assert!(!is_pairing_method("session.approveAll"));
        assert!(!is_pairing_method("session.approve "));
        assert!(!is_pairing_method("decision.answer"));
    }
    fn published(command: &str, paths: Value) -> Value {
        json!({
            "conversationId": "chat-1",
            "requestId": 7,
            "tool": "Bash",
            "command": command,
            "paths": paths,
        })
    }
    fn catalogs_with(rows: Vec<Value>, sessions: Value) -> HashMap<String, Value> {
        HashMap::from([(
            "main".into(),
            json!({"sessions": sessions, "approvals": rows}),
        )])
    }
    #[test]
    fn an_approval_matches_only_the_published_call() {
        let command = "echo café \r\nC:\\work\\my proj";
        let paths = json!(["C:\\work\\my proj\\a.ts"]);
        let echo = published(command, paths.clone());
        let row = published(command, paths.clone());
        let catalogs = catalogs_with(vec![row.clone(), row.clone()], json!([{"id": "chat-1"}]));
        assert!(match_approval(&catalogs, &echo).is_ok());

        let stored_null = catalogs_with(
            vec![json!({"conversationId": "chat-1", "requestId": 7, "tool": "Bash", "paths": []})],
            json!([{"id": "chat-1"}]),
        );
        let mut echo_null = echo.clone();
        echo_null["command"] = Value::Null;
        echo_null["paths"] = json!([]);
        assert!(match_approval(&stored_null, &echo_null).is_ok());
        // A missing command is the same as a null one, and an omitted path list matches nothing to write.
        let mut omitted = echo_null.clone();
        omitted.as_object_mut().unwrap().remove("command");
        omitted.as_object_mut().unwrap().remove("paths");
        assert!(match_approval(&stored_null, &omitted).is_ok());
        omitted["paths"] = json!(["src/a.ts"]);
        assert_eq!(
            match_approval(&stored_null, &omitted).unwrap_err(),
            "The command does not match."
        );

        let mut other = HashMap::new();
        other.insert(
            "main".into(),
            json!({"sessions": [{"id": "chat-1"}], "approvals": [row]}),
        );
        other.insert(
            "other".into(),
            json!({
                "sessions": [{"id": "chat-1"}],
                "approvals": [published("rm -rf /", json!([]))],
            }),
        );
        let err = match_approval(&other, &echo).unwrap_err();
        assert_eq!(err, "The command does not match.");
        assert!(!err.contains(command) && !err.contains("rm -rf"));

        let mut truncated = catalogs_with(
            vec![published(command, paths.clone())],
            json!([{"id": "chat-1"}]),
        );
        truncated.get_mut("main").unwrap()["approvalsTruncated"] = json!(true);
        assert_eq!(
            match_approval(&truncated, &echo).unwrap_err(),
            "Too many approvals to list from the phone."
        );

        let unlisted = catalogs_with(vec![published(command, paths)], json!([{"id": "other"}]));
        assert_eq!(
            match_approval(&unlisted, &echo).unwrap_err(),
            "This approval does not match a waiting tool call."
        );

        for request_id in [
            json!("7"),
            json!(7.5),
            json!(-1),
            json!(MAX_SAFE_INTEGER + 1),
        ] {
            let mut bad = echo.clone();
            bad["requestId"] = request_id;
            assert_eq!(
                match_approval(&catalogs, &bad).unwrap_err(),
                "Missing approval request."
            );
        }
        let mut nul = echo.clone();
        nul["conversationId"] = json!("chat\u{0}1");
        assert_eq!(
            match_approval(&catalogs, &nul).unwrap_err(),
            "This approval does not match a waiting tool call."
        );
        let mut shortened = echo.clone();
        shortened["command"] = json!("echo café");
        assert_eq!(
            match_approval(&catalogs, &shortened).unwrap_err(),
            "The command does not match."
        );

        // A Mono's own chat is not on the session list. Its call still matches, and a stranger's does not.
        let mono = HashMap::from([(
            "main".into(),
            json!({
                "sessions": [],
                "monos": [{"id": "mono-1", "sessionId": "chat-1", "busy": true}],
                "approvals": [published(command, echo["paths"].clone())],
            }),
        )]);
        assert!(match_approval(&mono, &echo).is_ok());
        assert_eq!(approval_owner(&mono, &echo).as_deref(), Some("main"));
        let stranger = HashMap::from([(
            "main".into(),
            json!({
                "sessions": [],
                "monos": [{"id": "mono-1", "sessionId": "other"}],
                "approvals": [published(command, echo["paths"].clone())],
            }),
        )]);
        assert_eq!(
            match_approval(&stranger, &echo).unwrap_err(),
            "This approval does not match a waiting tool call."
        );
        assert!(approval_owner(&stranger, &echo).is_none());
    }
    #[test]
    fn a_blanket_decision_is_refused_before_it_can_allow() {
        for params in [
            json!({"all": true}),
            json!({"scope": "session"}),
            json!({"approveAll": true}),
            json!({"allowAll": true}),
            json!({"decision": "allow_all"}),
            json!({"decision": "allow-all"}),
            json!({"decision": "all"}),
        ] {
            assert_eq!(
                rejects_blanket(&params).unwrap_err(),
                "One tool call at a time."
            );
        }
        assert!(rejects_blanket(&json!({"all": null, "decision": null})).is_ok());
        assert!(decision_conflict("session.approve", &json!({})).is_ok());
        assert!(decision_conflict("session.deny", &json!({"decision": null})).is_ok());
        assert!(decision_conflict("session.approve", &json!({"decision": "allow"})).is_ok());
        assert_eq!(
            decision_conflict("session.approve", &json!({"decision": "deny"})).unwrap_err(),
            "This approval does not match a waiting tool call."
        );
    }
    #[test]
    fn the_workspace_poll_does_not_carry_approvals() {
        let catalogs = HashMap::from([(
            "main".into(),
            json!({
                "projects": [{"id": "p", "name": "P"}],
                "monos": [],
                "sessions": [{"id": "s", "updatedAt": 2}],
                "approvals": [{"command": "echo secret-token"}],
                "approvalsTruncated": false
            }),
        )]);
        let merged = merge_catalogs(&catalogs);
        assert!(merged.get("approvals").is_none());
        assert!(merged.get("approvalsTruncated").is_none());
        assert_eq!(merged["sessions"][0]["id"], "s");
        assert!(!merged.to_string().contains("secret-token"));
    }
    #[test]
    fn inbox_and_crew_prefer_a_busy_window_then_the_smaller_label() {
        let idle = HashMap::from([
            ("b".into(), json!({"sessions": [{"id": "s", "live": true}]})),
            ("a".into(), json!({"sessions": [{"id": "s", "live": true}]})),
        ]);
        assert_eq!(workspace_owner(&idle).as_deref(), Some("a"));
        let busy = HashMap::from([
            ("a".into(), json!({"sessions": [{"id": "s", "live": true}]})),
            ("z".into(), json!({"sessions": [{"id": "s", "busy": true}]})),
        ]);
        assert_eq!(workspace_owner(&busy).as_deref(), Some("z"));
        assert!(workspace_owner(&HashMap::new()).is_none());
    }
    #[test]
    fn forgetting_a_device_drops_its_key() {
        let (host, join, phone) = fixture();
        let parent = host.path.parent().unwrap().to_path_buf();
        let key = join.fingerprint().unwrap();
        let fingerprint = phone.fingerprint().unwrap();
        let params = json!({"certificate": phone.certificate, "proof": phone.proof(&key).unwrap(), "name": "iPhone"});
        let mut inner = host.inner.lock().unwrap();
        let result = enroll(&host, &mut inner, &key, &params).unwrap();
        let device_id = result["deviceId"].as_str().unwrap().to_string();
        assert!(host.gate.admits(&fingerprint));
        forget_device(&host, &mut inner, &device_id).unwrap();
        assert!(!host.gate.admits(&fingerprint));
        assert!(inner.config.devices.is_empty());
        assert!(pairing_gate(true, true, false).is_err());
        drop(inner);
        std::fs::remove_dir_all(&parent).unwrap();
    }
    #[test]
    fn a_new_setup_does_not_open_a_router_port() {
        assert!(!Config::default().open_router);
        assert!(!Config::default().enabled);
        let saved: Config = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(!saved.open_router);
    }

    #[test]
    fn pairing_is_authorized_only_for_an_enabled_paired_device_with_phone_access() {
        let mut config = Config {
            enabled: true,
            ..Config::default()
        };
        config.devices.push(Device {
            id: "d1".into(),
            name: "iPhone".into(),
            fingerprint: "peer-a".into(),
        });
        assert!(authorize_pairing(&config, "peer-a", true).is_ok());
        assert_eq!(
            authorize_pairing(&config, "peer-a", false).unwrap_err(),
            "Phone access is off."
        );
        assert_eq!(
            authorize_pairing(&config, "peer-b", true).unwrap_err(),
            "Device revoked or not paired"
        );
        let mut off = config.clone();
        off.enabled = false;
        assert_eq!(
            authorize_pairing(&off, "peer-a", true).unwrap_err(),
            "Mobile access disabled"
        );
        // A revoked device is refused by the same check that handle() runs, not by a stub.
        config.devices.clear();
        assert_eq!(
            authorize_pairing(&config, "peer-a", true).unwrap_err(),
            "Device revoked or not paired"
        );
    }

    #[test]
    fn an_approval_in_flight_is_not_run_once_its_window_device_or_access_is_gone() {
        let (host, _join, _phone) = fixture();
        let mut inner = host.inner.lock().unwrap();
        inner.config.devices.push(Device {
            id: "d1".into(),
            name: "iPhone".into(),
            fingerprint: "peer-a".into(),
        });
        let (reply, _receiver) = oneshot::channel();
        inner.pending.insert(
            "req-1".into(),
            Pending {
                window: "main".into(),
                peer: "peer-a".into(),
                reply,
            },
        );
        assert!(approval_still_open(&inner, "req-1", "main", true));
        // Another window, phone access off, a timed-out or answered request, a revoked device, or a disabled service.
        assert!(!approval_still_open(&inner, "req-1", "other", true));
        assert!(!approval_still_open(&inner, "req-1", "main", false));
        assert!(!approval_still_open(&inner, "missing", "main", true));
        inner.config.devices.clear();
        assert!(!approval_still_open(&inner, "req-1", "main", true));
        inner.config.devices.push(Device {
            id: "d1".into(),
            name: "iPhone".into(),
            fingerprint: "peer-a".into(),
        });
        inner.config.enabled = false;
        assert!(!approval_still_open(&inner, "req-1", "main", true));
    }
}
