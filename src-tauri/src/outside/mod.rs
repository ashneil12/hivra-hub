// Copyright 2026 The Hivra authors.
// SPDX-License-Identifier: Apache-2.0
//
// WP-79: a loopback door for AI tools on this computer. Off until Settings says
// otherwise. A dev copy has its own database, so it never binds the daily app's port.

mod http;
mod mcp;
mod oauth;
mod security;
mod store;

#[cfg(test)]
use std::net::{Ipv4Addr, TcpListener};
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

pub struct Outside {
    db: Arc<DbInner>,
    run: Mutex<Option<Run>>,
}

impl Outside {
    pub(crate) fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let door = Self {
            db: Arc::new(DbInner::File(path)),
            run: Mutex::new(None),
        };
        door.with_conn(|conn| store::ensure(conn))??;
        Ok(door)
    }

    #[cfg(test)]
    pub(crate) fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        store::ensure(&conn)?;
        Ok(Self {
            db: Arc::new(DbInner::Memory(Mutex::new(conn))),
            run: Mutex::new(None),
        })
    }

    pub(crate) fn with_conn<T>(&self, f: impl FnOnce(&mut Connection) -> T) -> Result<T, String> {
        with_db(&self.db, f)
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

    pub(crate) fn start(&self) -> Result<u16, String> {
        let mut run = self
            .run
            .lock()
            .map_err(|_| "The door is locked".to_string())?;
        if let Some(existing) = run.as_ref() {
            return Ok(existing.port);
        }
        let stop = Arc::new(AtomicBool::new(false));
        let (port, thread) =
            http::serve(Arc::clone(&self.db), Arc::clone(&stop)).map_err(|e| e.to_string())?;
        *run = Some(Run { port, stop, thread });
        Ok(port)
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
        let enabled = self.enabled_flag()?;
        let url = if enabled {
            self.port()
                .map(|port| format!("http://127.0.0.1:{port}/mcp"))
        } else {
            None
        };
        Ok(DoorStatus { enabled, url })
    }

    pub(crate) fn set_enabled(&self, on: bool) -> Result<DoorStatus, String> {
        if on {
            self.start()?;
            if let Err(err) = self.with_conn(|conn| store::set_enabled(conn, true))? {
                self.stop();
                return Err(err);
            }
        } else {
            self.with_conn(|conn| store::set_enabled(conn, false))??;
            self.stop();
        }
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

pub fn init(app: &AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let door = Outside::open(dir.join("monocode.db"))?;
    if door.enabled_flag()? {
        door.start()?;
    }
    app.manage(door);
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoorStatus {
    pub enabled: bool,
    pub url: Option<String>,
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

fn decide_local(
    door: &Outside,
    id: &str,
    approved: bool,
    project_ids: &[String],
    write: bool,
) -> Result<ConsentResult, String> {
    let origin = door.origin()?;
    let now = now_ms();
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
    consent_result(reply)
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
    door.with_conn(|conn| grant_views(conn))?
}

#[tauri::command]
pub fn outside_disconnect(door: State<'_, Outside>, id: String) -> Result<bool, String> {
    let now = now_ms();
    door.with_conn(|conn| oauth::disconnect(conn, &id, now))?
}

#[tauri::command]
pub fn outside_pending(door: State<'_, Outside>) -> Result<PendingPage, String> {
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

/// Bind a port and drop it, so a test can see that nothing of ours stayed there.
#[cfg(test)]
fn port_is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

#[cfg(test)]
mod tests;
