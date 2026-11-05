// Copyright 2026 The Hivra authors.
// SPDX-License-Identifier: Apache-2.0
//
// WP-79: a loopback door for AI tools on this computer. Off until Settings says
// otherwise. The port is chosen once and kept. A dev copy uses its own range,
// never the daily app's.

mod http;
mod mcp;
mod oauth;
mod security;
mod store;

use std::collections::HashMap;
#[cfg(test)]
use std::net::{Ipv4Addr, TcpListener};
use std::ops::Range;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use oauth::{Decision, Reply};

enum DbInner {
    #[cfg(test)]
    Memory(Mutex<Connection>),
    File(PathBuf),
}

fn with_db<T>(db: &DbInner, f: impl FnOnce(&mut Connection) -> T) -> Result<T, String> {
    match db {
        #[cfg(test)]
        DbInner::Memory(lock) => {
            let mut conn = lock
                .lock()
                .map_err(|_| "The door's database is locked".to_string())?;
            Ok(f(&mut conn))
        }
        DbInner::File(path) => {
            let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
            conn.busy_timeout(std::time::Duration::from_secs(5))
                .map_err(|e| e.to_string())?;
            let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
            Ok(f(&mut conn))
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

struct Run {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

/// The daily app's ports. A dev copy never binds one.
///
/// 27179–27199 sits above the hub dev grid (1430–1929) and below Linux's
/// ephemeral range (32768), so a port-0 bind cannot land here.
pub(crate) const DAILY_PORTS: Range<u16> = 27179..27200;
/// Dev copies, including several side by side. Disjoint from [`DAILY_PORTS`].
pub(crate) const DEV_PORTS: Range<u16> = 27200..27400;

fn port_range(kind: crate::instance::Kind) -> Range<u16> {
    match kind {
        crate::instance::Kind::Daily => DAILY_PORTS,
        crate::instance::Kind::Dev => DEV_PORTS,
    }
}

struct DoorFault {
    message: String,
    port_taken: bool,
}

enum Choice {
    Exact(u16),
    Insert,
    Replace(String),
}

fn note(place: &str, message: &str) {
    eprintln!("outside: {message} [{place}]");
    #[cfg(test)]
    {
        if let Ok(mut notes) = NOTES.lock() {
            notes.push((place.to_string(), message.to_string()));
        }
    }
}

#[cfg(test)]
static NOTES: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) fn noted_for(place: &str, fragment: &str) -> bool {
    NOTES
        .lock()
        .map(|notes| {
            notes
                .iter()
                .any(|(at, message)| at == place && message.contains(fragment))
        })
        .unwrap_or(false)
}

/// A saved port is a number in 1..=65535, nothing else. `0` would mean "any port".
fn parse_saved_port(raw: &str) -> Option<u16> {
    let raw = raw.trim();
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port = raw.parse::<u16>().ok()?;
    (port != 0).then_some(port)
}

fn shutdown(run: Run) {
    run.stop.store(true, Ordering::SeqCst);
    let _ = run.thread.join();
}

pub(crate) struct PendingRedirect {
    location: String,
    until: i64,
}

/// The code is not written to the database. It lives here until the browser
/// Claude opened follows it once, or until the code would have expired.
pub(crate) type Redirects = Arc<Mutex<HashMap<String, PendingRedirect>>>;

pub struct Outside {
    db: Option<Arc<DbInner>>,
    run: Mutex<Option<Run>>,
    redirects: Redirects,
    fault: Mutex<Option<DoorFault>>,
    /// Where a failure is logged. Not shown in Connected apps.
    place: String,
}

impl Outside {
    pub(crate) fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|err| format!("couldn't open {}: {err}", dir.display()))?;
        }
        let place = path.display().to_string();
        let door = Self {
            db: Some(Arc::new(DbInner::File(path.clone()))),
            run: Mutex::new(None),
            redirects: Arc::new(Mutex::new(HashMap::new())),
            fault: Mutex::new(None),
            place,
        };
        door.with_conn(|conn| store::ensure(conn))
            .map_err(|err| format!("couldn't open {}: {err}", path.display()))??;
        Ok(door)
    }

    /// A door that could not be opened. Connected apps can still show why.
    fn unavailable(place: &str, reason: &str) -> Self {
        let message = if reason.starts_with("couldn't start: ") {
            reason.to_string()
        } else {
            format!("couldn't start: {reason}")
        };
        Self {
            db: None,
            run: Mutex::new(None),
            redirects: Arc::new(Mutex::new(HashMap::new())),
            fault: Mutex::new(Some(DoorFault {
                message,
                port_taken: false,
            })),
            place: place.to_string(),
        }
    }

    #[cfg(test)]
    pub(crate) fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        store::ensure(&conn)?;
        Ok(Self {
            db: Some(Arc::new(DbInner::Memory(Mutex::new(conn)))),
            run: Mutex::new(None),
            redirects: Arc::new(Mutex::new(HashMap::new())),
            fault: Mutex::new(None),
            place: "memory".to_string(),
        })
    }

    fn has_db(&self) -> bool {
        self.db.is_some()
    }

    fn is_memory(&self) -> bool {
        #[cfg(test)]
        {
            matches!(self.db.as_deref(), Some(DbInner::Memory(_)))
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    pub(crate) fn with_conn<T>(&self, f: impl FnOnce(&mut Connection) -> T) -> Result<T, String> {
        let Some(db) = &self.db else {
            let (problem, _) = self.fault_view();
            return Err(
                problem.unwrap_or_else(|| "couldn't start: the door has no database".into())
            );
        };
        with_db(db, f)
    }

    fn fault_view(&self) -> (Option<String>, bool) {
        let fault = match self.fault.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        match fault.as_ref() {
            Some(fault) => (Some(fault.message.clone()), fault.port_taken),
            None => (None, false),
        }
    }

    fn remember(&self, message: &str, port_taken: bool) {
        note(&self.place, message);
        let mut fault = match self.fault.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *fault = Some(DoorFault {
            message: message.to_string(),
            port_taken,
        });
    }

    fn clear_fault(&self) {
        let mut fault = match self.fault.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *fault = None;
    }

    fn enabled_flag(&self) -> Result<bool, String> {
        self.with_conn(|conn| store::enabled(conn))?
    }

    pub(crate) fn port(&self) -> Option<u16> {
        self.run
            .lock()
            .ok()
            .and_then(|run| run.as_ref().map(|run| run.port))
    }

    /// Memory doors in tests bind an ephemeral port. File doors go through
    /// [`Self::ensure_running`], which production reaches from `init` and
    /// `set_enabled` instead.
    #[cfg(test)]
    pub(crate) fn start(&self) -> Result<u16, String> {
        if self.is_memory() {
            self.start_ephemeral()?;
        } else {
            self.ensure_running(port_range(crate::instance::kind()))?;
        }
        self.port()
            .ok_or_else(|| "The door didn't start.".to_string())
    }

    fn start_ephemeral(&self) -> Result<(), String> {
        let mut run = self
            .run
            .lock()
            .map_err(|_| "The door is locked".to_string())?;
        if run.is_some() {
            return Ok(());
        }
        *run = Some(
            self.spawn(http::Listen::Ephemeral)
                .map_err(|err| match err {
                    http::ListenError::Other(err) => err,
                    http::ListenError::Taken(port) => format!("port {port} is already in use"),
                    http::ListenError::NoneFree => "there is no free port".to_string(),
                })?,
        );
        Ok(())
    }

    /// Bind the saved port, or pick one in `range` and store it when none is saved.
    /// A saved port that is taken is left where it is.
    fn ensure_running(&self, range: Range<u16>) -> Result<(), String> {
        if self.is_memory() {
            self.start_ephemeral()?;
            self.clear_fault();
            return Ok(());
        }
        let mut run = self
            .run
            .lock()
            .map_err(|_| "The door is locked".to_string())?;
        if run.is_some() {
            drop(run);
            self.clear_fault();
            return Ok(());
        }
        let saved = self.with_conn(|conn| store::raw_setting(conn, "port"))??;
        let choice = match saved.as_deref() {
            Some(raw) => match parse_saved_port(raw).filter(|port| range.contains(port)) {
                Some(port) => Choice::Exact(port),
                None => {
                    note(&self.place, "the saved port is outside this copy's range");
                    Choice::Replace(raw.to_string())
                }
            },
            None => Choice::Insert,
        };
        match choice {
            Choice::Exact(port) => self.bind_exact(&mut run, port),
            Choice::Insert => self.bind_first(&mut run, range, None),
            Choice::Replace(raw) => self.bind_first(&mut run, range, Some(raw)),
        }
    }

    fn spawn(&self, listen: http::Listen) -> Result<Run, http::ListenError> {
        let Some(db) = &self.db else {
            return Err(http::ListenError::Other(
                "the door has no database".to_string(),
            ));
        };
        let stop = Arc::new(AtomicBool::new(false));
        let (port, thread) = http::serve(
            Arc::clone(db),
            Arc::clone(&stop),
            Arc::clone(&self.redirects),
            listen,
        )?;
        Ok(Run { port, stop, thread })
    }

    fn bind_exact(&self, run: &mut Option<Run>, port: u16) -> Result<(), String> {
        match self.spawn(http::Listen::Exact(port)) {
            Ok(started) => {
                *run = Some(started);
                self.clear_fault();
                Ok(())
            }
            Err(err) => self.listen_failed(err),
        }
    }

    fn bind_first(
        &self,
        run: &mut Option<Run>,
        range: Range<u16>,
        replace: Option<String>,
    ) -> Result<(), String> {
        let started = match self.spawn(http::Listen::FirstFree(range.clone())) {
            Ok(started) => started,
            Err(err) => return self.listen_failed(err),
        };
        let port = started.port;
        let stored = match self.commit_port(port, replace.as_deref()) {
            Ok(stored) => stored,
            Err(err) => {
                shutdown(started);
                let message = format!("couldn't start: {err}");
                self.remember(&message, false);
                return Err(message);
            }
        };
        if stored == port {
            *run = Some(started);
            self.clear_fault();
            return Ok(());
        }
        // The saved port changed while we were binding. Follow it, unless it
        // isn't one this copy is allowed to use. Don't keep a listener the
        // settings don't name.
        shutdown(started);
        if !range.contains(&stored) {
            let message = format!("couldn't start: port {stored} is not in this copy's range");
            self.remember(&message, false);
            return Err(message);
        }
        self.bind_exact(run, stored)
    }

    /// Write `port` only if the row is still the one we read. Returns the port
    /// that is saved now, which may be someone else's.
    fn commit_port(&self, port: u16, replace: Option<&str>) -> Result<u16, String> {
        self.with_conn(|conn| {
            let unchanged = replace.is_some_and(|raw| raw.trim() == port.to_string());
            let wrote = if unchanged {
                true
            } else {
                match replace {
                    Some(raw) => store::replace_port(conn, raw, port)?,
                    None => store::insert_port_if_empty(conn, port)?,
                }
            };
            if wrote {
                return Ok(port);
            }
            match store::raw_setting(conn, "port")? {
                Some(raw) => {
                    parse_saved_port(&raw).ok_or_else(|| "the saved port is not a port".to_string())
                }
                None => Err("the saved port is not a port".to_string()),
            }
        })?
    }

    fn listen_failed(&self, err: http::ListenError) -> Result<(), String> {
        let (message, taken) = match err {
            http::ListenError::Taken(port) => (
                format!("couldn't start: port {port} is already in use"),
                true,
            ),
            http::ListenError::NoneFree => {
                ("couldn't start: there is no free port".to_string(), false)
            }
            http::ListenError::Other(err) => (format!("couldn't start: {err}"), false),
        };
        self.remember(&message, taken);
        Err(message)
    }

    pub(crate) fn stop(&self) {
        let taken = {
            let mut run = match self.run.lock() {
                Ok(run) => run,
                Err(poisoned) => poisoned.into_inner(),
            };
            run.take()
        };
        if let Some(run) = taken {
            run.stop.store(true, Ordering::SeqCst);
            let _ = run.thread.join();
        }
    }

    pub(crate) fn status(&self) -> Result<DoorStatus, String> {
        let (problem, port_taken) = self.fault_view();
        let enabled = match self.enabled_flag() {
            Ok(enabled) => enabled,
            Err(_) if problem.is_some() => false,
            Err(err) => return Err(err),
        };
        let url = if enabled && problem.is_none() {
            self.port()
                .map(|port| format!("http://127.0.0.1:{port}/mcp"))
        } else {
            None
        };
        Ok(DoorStatus {
            enabled,
            url,
            problem,
            port_taken,
        })
    }

    pub(crate) fn set_enabled(&self, on: bool) -> Result<DoorStatus, String> {
        self.set_enabled_in(on, crate::instance::kind())
    }

    pub(crate) fn set_enabled_in(
        &self,
        on: bool,
        kind: crate::instance::Kind,
    ) -> Result<DoorStatus, String> {
        if !self.has_db() {
            return self.status();
        }
        if on {
            if self.ensure_running(port_range(kind)).is_err() {
                // The person asked for the door. Remember that, and show why it isn't up.
                self.with_conn(|conn| store::set_enabled(conn, true))??;
                return self.status();
            }
            if let Err(err) = self.with_conn(|conn| store::set_enabled(conn, true))? {
                self.stop();
                self.remember(&format!("couldn't start: {err}"), false);
                return self.status();
            }
        } else {
            self.with_conn(|conn| store::set_enabled(conn, false))??;
            self.stop();
            self.clear_fault();
        }
        self.status()
    }

    /// Bind a different port in this copy's range. Does nothing unless the saved
    /// port is the one that failed, so a working address never moves on its own.
    pub(crate) fn pick_new_port(&self, kind: crate::instance::Kind) -> Result<DoorStatus, String> {
        if !self.fault_view().1 {
            return self.status();
        }
        let Some(raw) = self.with_conn(|conn| store::raw_setting(conn, "port"))?? else {
            return self.status();
        };
        let range = port_range(kind);
        let previous = parse_saved_port(&raw).filter(|port| range.contains(port));
        let mut run = self
            .run
            .lock()
            .map_err(|_| "The door is locked".to_string())?;
        if run.is_some() {
            drop(run);
            self.clear_fault();
            return self.status();
        }
        let started = match self.spawn(http::Listen::FirstFree(range.clone())) {
            Ok(started) => started,
            Err(_) => {
                drop(run);
                if let Some(port) = previous {
                    self.remember(
                        &format!(
                            "couldn't start: port {port} is already in use, and there is no other free port"
                        ),
                        true,
                    );
                }
                return self.status();
            }
        };
        let port = started.port;
        if previous == Some(port) || raw.trim() == port.to_string() {
            *run = Some(started);
            drop(run);
            self.clear_fault();
            return self.status();
        }
        let wrote = self.with_conn(|conn| store::replace_port(conn, &raw, port))??;
        if !wrote {
            shutdown(started);
            drop(run);
            let _ = self.ensure_running(range);
            return self.status();
        }
        *run = Some(started);
        drop(run);
        self.clear_fault();
        self.status()
    }

    fn origin(&self) -> Result<String, String> {
        let port = self
            .port()
            .ok_or_else(|| "The door isn't on.".to_string())?;
        Ok(format!("http://127.0.0.1:{port}"))
    }
}

impl Drop for Outside {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Open the door and start it when the person left it on. A failure is logged
/// and kept on the door. This always returns a door, so startup can carry on.
pub(crate) fn init_at(path: PathBuf, kind: crate::instance::Kind) -> Result<Outside, String> {
    let place = path.display().to_string();
    let door = match Outside::open(path) {
        Ok(door) => door,
        Err(err) => {
            let door = Outside::unavailable(&place, &err);
            if let Some(message) = door.fault_view().0 {
                note(&place, &message);
            }
            return Ok(door);
        }
    };
    match door.enabled_flag() {
        Ok(true) => {
            let _ = door.ensure_running(port_range(kind));
        }
        Ok(false) => {}
        Err(err) => door.remember(&format!("couldn't start: {err}"), false),
    }
    Ok(door)
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let door = match app.path().app_data_dir() {
        Ok(dir) => init_at(dir.join("monocode.db"), crate::instance::kind())?,
        Err(err) => {
            let place = err.to_string();
            let door = Outside::unavailable(&place, &place);
            if let Some(message) = door.fault_view().0 {
                note(&place, &message);
            }
            door
        }
    };
    app.manage(door);
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoorStatus {
    pub enabled: bool,
    pub url: Option<String>,
    /// Why the door isn't listening, when the person asked for it or startup tried.
    pub problem: Option<String>,
    /// The saved port is in use. Connected apps can offer to pick another.
    pub port_taken: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    pub id: String,
    pub client_name: String,
    pub projects: Vec<String>,
    pub write: bool,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub id: String,
    pub client_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChoice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPage {
    pub requests: Vec<PendingView>,
    pub projects: Vec<ProjectChoice>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentResult {
    pub redirect_uri: String,
}

fn grant_views(conn: &Connection) -> Result<Vec<GrantView>, String> {
    store::ensure(conn)?;
    let live = oauth::live_projects(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT g.id, c.name, g.project_ids, g.mcp_scopes, g.last_used_at
             FROM outside_grants g
             JOIN outside_clients c ON c.id = g.client_id
             WHERE g.revoked_at IS NULL
             ORDER BY g.created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, client_name, projects_raw, scopes, last_used_at) =
            row.map_err(|e| e.to_string())?;
        let ids: Vec<String> = serde_json::from_str(&projects_raw).unwrap_or_default();
        let projects = ids
            .iter()
            .filter_map(|id| {
                live.iter()
                    .find(|project| project.id == *id)
                    .map(|project| project.name.clone())
            })
            .collect();
        out.push(GrantView {
            id,
            client_name,
            projects,
            write: scopes
                .split_whitespace()
                .any(|s| s == security::WRITE_SCOPE),
            last_used_at,
        });
    }
    Ok(out)
}

fn pending_page(conn: &Connection, now: i64) -> Result<PendingPage, String> {
    store::ensure(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT r.id, c.name
             FROM outside_requests r
             JOIN outside_clients c ON c.id = r.client_id
             WHERE r.code_hash IS NULL AND r.used_at IS NULL AND r.expires_at >= ?1
             ORDER BY r.created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([now], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut requests = Vec::new();
    for row in rows {
        let (id, client_name) = row.map_err(|e| e.to_string())?;
        requests.push(PendingView { id, client_name });
    }
    let projects = oauth::live_projects(conn)?
        .into_iter()
        .map(|project| ProjectChoice {
            id: project.id,
            name: project.name,
        })
        .collect();
    Ok(PendingPage { requests, projects })
}

fn consent_result(reply: Reply) -> Result<ConsentResult, String> {
    if reply.status != 200 {
        return Err(reply_message(&reply));
    }
    let value: Value = serde_json::from_slice(&reply.body).map_err(|e| e.to_string())?;
    let redirect_uri = value
        .get("redirect_uri")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(ConsentResult { redirect_uri })
}

fn reply_message(reply: &Reply) -> String {
    let value: Value = serde_json::from_slice(&reply.body).unwrap_or(Value::Null);
    match value.get("error").and_then(|v| v.as_str()) {
        Some("invalid_request") => "That request isn't valid.".into(),
        Some("invalid_scope") => "That permission isn't one Hivra gives.".into(),
        Some("invalid_client") => "That app isn't registered.".into(),
        _ => "That didn't work.".into(),
    }
}

pub(crate) fn lock_redirects(
    redirects: &Redirects,
) -> std::sync::MutexGuard<'_, HashMap<String, PendingRedirect>> {
    match redirects.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Drop a redirect whose code would already be refused. One caller gets it.
pub(crate) fn take_ready(
    waiting: &mut HashMap<String, PendingRedirect>,
    id: &str,
    now: i64,
) -> Option<String> {
    let until = waiting.get(id)?.until;
    if until < now {
        waiting.remove(id);
        return None;
    }
    waiting.remove(id).map(|pending| pending.location)
}

fn decide_local(
    door: &Outside,
    id: &str,
    approved: bool,
    project_ids: &[String],
    write: bool,
) -> Result<ConsentResult, String> {
    let origin = door.origin()?;
    let now = now_ms();
    // Hold this lock across the write, so a browser poll cannot see the code
    // in the database and also miss the redirect.
    let mut waiting = lock_redirects(&door.redirects);
    let reply = door.with_conn(|conn| {
        oauth::decide(
            conn,
            Decision {
                id,
                csrf: None,
                approved,
                project_ids,
                write,
                now,
                origin: &origin,
            },
        )
    })?;
    let result = consent_result(reply)?;
    if !result.redirect_uri.is_empty() {
        waiting.insert(
            id.to_string(),
            PendingRedirect {
                location: result.redirect_uri.clone(),
                until: now.saturating_add(security::CODE_MILLIS),
            },
        );
    }
    Ok(result)
}

#[tauri::command]
pub fn outside_status(door: State<'_, Outside>) -> Result<DoorStatus, String> {
    door.status()
}

#[tauri::command]
pub fn outside_set_enabled(door: State<'_, Outside>, enabled: bool) -> Result<DoorStatus, String> {
    door.set_enabled(enabled)
}

#[tauri::command]
pub fn outside_grants(door: State<'_, Outside>) -> Result<Vec<GrantView>, String> {
    if !door.has_db() {
        return Ok(Vec::new());
    }
    door.with_conn(|conn| grant_views(conn))?
}

#[tauri::command]
pub fn outside_disconnect(door: State<'_, Outside>, id: String) -> Result<bool, String> {
    let now = now_ms();
    door.with_conn(|conn| oauth::disconnect(conn, &id, now))?
}

#[tauri::command]
pub fn outside_pending(door: State<'_, Outside>) -> Result<PendingPage, String> {
    if !door.has_db() {
        return Ok(PendingPage {
            requests: Vec::new(),
            projects: Vec::new(),
        });
    }
    let now = now_ms();
    door.with_conn(|conn| pending_page(conn, now))?
}

#[tauri::command]
pub fn outside_approve(
    door: State<'_, Outside>,
    request_id: String,
    project_ids: Vec<String>,
    write: bool,
) -> Result<ConsentResult, String> {
    decide_local(&door, &request_id, true, &project_ids, write)
}

#[tauri::command]
pub fn outside_deny(door: State<'_, Outside>, request_id: String) -> Result<ConsentResult, String> {
    decide_local(&door, &request_id, false, &[], false)
}

#[tauri::command]
pub fn outside_pick_new_port(door: State<'_, Outside>) -> Result<DoorStatus, String> {
    door.pick_new_port(crate::instance::kind())
}

/// Bind a port and drop it, so a test can see that nothing of ours stayed there.
#[cfg(test)]
fn port_is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

#[cfg(test)]
mod tests;
