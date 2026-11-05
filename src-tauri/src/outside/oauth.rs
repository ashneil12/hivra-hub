// Copyright 2026 The Hivra authors.
// SPDX-License-Identifier: Apache-2.0
//
// Translated from Orbit (Apache-2.0, https://github.com/coollabsio/orbit)
// apps/server/src/oauth.rs. Axum and sqlx are not copied: Hivra's door is a
// loopback HTTP server and rusqlite. The checks are the same: public clients,
// loopback or HTTPS callbacks, S256 PKCE, one-minute codes, rotating refresh
// tokens, and a reused code or refresh token revokes the connection.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use url::Url;

use super::security::{
    hash_secret, parse_scope, pkce_ok, random_token, scope_list, valid_challenge, valid_redirect,
    ACCESS_SECONDS, CODE_MILLIS, DAY_MILLIS, MAX_CLIENTS, REFRESH_MILLIS, REGISTRATIONS_PER_IP,
    REQUEST_MILLIS, SCOPE,
};
use super::store;

#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, value: Value) -> Self {
        let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body,
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn redirect(location: &str) -> Self {
        Self {
            status: 302,
            headers: vec![("location".into(), location.to_string())],
            body: Vec::new(),
        }
    }
}

fn fail(status: u16, code: &str) -> Reply {
    Reply::json(status, json!({ "error": code }))
}

fn server_error(err: String) -> Reply {
    Reply::json(
        500,
        json!({ "error": "server_error", "error_description": err }),
    )
}

pub fn discovery(origin: &str) -> Reply {
    Reply::json(
        200,
        json!({
            "issuer": origin,
            "authorization_endpoint": format!("{origin}/oauth/authorize"),
            "token_endpoint": format!("{origin}/oauth/token"),
            "registration_endpoint": format!("{origin}/oauth/register"),
            "revocation_endpoint": format!("{origin}/oauth/revoke"),
            "scopes_supported": [SCOPE, super::security::WRITE_SCOPE],
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["none"],
            "code_challenge_methods_supported": ["S256"],
            "authorization_response_iss_parameter_supported": true
        }),
    )
}

pub fn resource_metadata(origin: &str) -> Reply {
    Reply::json(
        200,
        json!({
            "resource": format!("{origin}/mcp"),
            "authorization_servers": [origin],
            "scopes_supported": [SCOPE, super::security::WRITE_SCOPE],
            "bearer_methods_supported": ["header"]
        }),
    )
}

pub fn challenge(origin: &str) -> String {
    format!(
        "Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource/mcp\", scope=\"{SCOPE}\""
    )
}

struct Client {
    id: String,
    name: String,
    redirects: Vec<String>,
}

fn load_client(conn: &Connection, id: &str) -> Result<Option<Client>, String> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT id, name, redirect_uris FROM outside_clients WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((id, name, raw)) = row else {
        return Ok(None);
    };
    let redirects = serde_json::from_str(&raw).unwrap_or_default();
    Ok(Some(Client {
        id,
        name,
        redirects,
    }))
}

pub fn register(conn: &Connection, body: &Value, now: i64, ip: &str) -> Reply {
    if let Err(err) = store::ensure(conn) {
        return server_error(err);
    }
    let Some(uris) = body.get("redirect_uris").and_then(|v| v.as_array()) else {
        return fail(400, "invalid_client_metadata");
    };
    if uris.is_empty() || uris.len() > 10 {
        return fail(400, "invalid_client_metadata");
    }
    let mut redirects = Vec::new();
    for uri in uris {
        let Some(uri) = uri.as_str() else {
            return fail(400, "invalid_client_metadata");
        };
        if !valid_redirect(uri) {
            return fail(400, "invalid_client_metadata");
        }
        redirects.push(uri.to_string());
    }
    if let Some(method) = body
        .get("token_endpoint_auth_method")
        .and_then(|v| v.as_str())
    {
        if method != "none" {
            return fail(400, "invalid_client_metadata");
        }
    }
    if let Some(grants) = body.get("grant_types").and_then(|v| v.as_array()) {
        let ok = grants.iter().all(|g| {
            matches!(
                g.as_str(),
                Some("authorization_code") | Some("refresh_token")
            )
        });
        if !ok {
            return fail(400, "invalid_client_metadata");
        }
    }
    if let Some(responses) = body.get("response_types").and_then(|v| v.as_array()) {
        if responses != [json!("code")].as_slice() {
            return fail(400, "invalid_client_metadata");
        }
    }
    let name = match body.get("client_name").and_then(|v| v.as_str()) {
        Some(name) => {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 100 {
                return fail(400, "invalid_client_metadata");
            }
            name.to_string()
        }
        None => "MCP client".to_string(),
    };
    if let Err(err) = store::prune_unused_clients(conn, now.saturating_sub(DAY_MILLIS)) {
        return server_error(err);
    }
    let key = super::security::registration_key(ip);
    let recent = match store::registrations_since(conn, &key, now.saturating_sub(DAY_MILLIS)) {
        Ok(n) => n,
        Err(err) => return server_error(err),
    };
    if recent >= REGISTRATIONS_PER_IP {
        return fail(429, "temporarily_unavailable");
    }
    let count = match store::client_count(conn) {
        Ok(n) => n,
        Err(err) => return server_error(err),
    };
    if count >= MAX_CLIENTS {
        return fail(429, "temporarily_unavailable");
    }
    let id = random_token("hivra-client-");
    let redirects_json = match serde_json::to_string(&redirects) {
        Ok(text) => text,
        Err(err) => return server_error(err.to_string()),
    };
    if let Err(err) = conn.execute(
        "INSERT INTO outside_clients (id, name, redirect_uris, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, redirects_json, now],
    ) {
        return server_error(err.to_string());
    }
    if let Err(err) = conn.execute(
        "INSERT INTO outside_registrations (ip, created_at) VALUES (?1, ?2)",
        params![key, now],
    ) {
        return server_error(err.to_string());
    }
    Reply::json(
        201,
        json!({
            "client_id": id,
            "client_name": name,
            "client_id_issued_at": now / 1000,
            "redirect_uris": redirects,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": SCOPE
        }),
    )
}

pub fn authorize(conn: &Connection, query: &[(String, String)], origin: &str, now: i64) -> Reply {
    if let Err(err) = store::ensure(conn) {
        return server_error(err);
    }
    let get = |name: &str| -> Option<String> {
        query
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    if get("response_type").as_deref() != Some("code") {
        return fail(400, "invalid_request");
    }
    let Some(client_id) = get("client_id") else {
        return fail(400, "invalid_request");
    };
    let Some(redirect) = get("redirect_uri") else {
        return fail(400, "invalid_request");
    };
    let Some(challenge) = get("code_challenge") else {
        return fail(400, "invalid_request");
    };
    let method = get("code_challenge_method").unwrap_or_default();
    if !valid_challenge(&method, &challenge) {
        return fail(400, "invalid_request");
    }
    let state = get("state").unwrap_or_default();
    if state.len() > 2048 {
        return fail(400, "invalid_request");
    }
    let write = match parse_scope(get("scope").as_deref()) {
        Ok(write) => write,
        Err(()) => return fail(400, "invalid_scope"),
    };
    let resource = format!("{origin}/mcp");
    if let Some(given) = get("resource") {
        if given != resource {
            return fail(400, "invalid_target");
        }
    }
    let client = match load_client(conn, &client_id) {
        Ok(Some(client)) => client,
        Ok(None) => return fail(400, "invalid_client"),
        Err(err) => return server_error(err),
    };
    if !client.redirects.iter().any(|uri| uri == &redirect) {
        return fail(400, "invalid_request");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let extras = if write {
        super::security::WRITE_SCOPE
    } else {
        ""
    };
    if let Err(err) = conn.execute(
        "INSERT INTO outside_requests (
           id, client_id, redirect_uri, state, challenge, resource, csrf_hash,
           expires_at, code_hash, grant_id, used_at, mcp_scopes, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, NULL, NULL, NULL, ?8, ?9)",
        params![
            id,
            client.id,
            redirect,
            state,
            challenge,
            resource,
            now.saturating_add(REQUEST_MILLIS),
            extras,
            now
        ],
    ) {
        return server_error(err.to_string());
    }
    Reply::redirect(&format!("{origin}/oauth/consent?request={id}"))
}

struct RequestRow {
    id: String,
    client_id: String,
    redirect_uri: String,
    state: String,
    challenge: String,
    resource: String,
    csrf_hash: Option<Vec<u8>>,
    expires_at: i64,
    code_hash: Option<Vec<u8>>,
    grant_id: Option<String>,
    used_at: Option<i64>,
    mcp_scopes: String,
}

fn request_by_id(conn: &Connection, id: &str) -> Result<Option<RequestRow>, String> {
    conn.query_row(
        "SELECT id, client_id, redirect_uri, state, challenge, resource, csrf_hash,
                expires_at, code_hash, grant_id, used_at, mcp_scopes
         FROM outside_requests WHERE id = ?1",
        params![id],
        |row| {
            Ok(RequestRow {
                id: row.get(0)?,
                client_id: row.get(1)?,
                redirect_uri: row.get(2)?,
                state: row.get(3)?,
                challenge: row.get(4)?,
                resource: row.get(5)?,
                csrf_hash: row.get(6)?,
                expires_at: row.get(7)?,
                code_hash: row.get(8)?,
                grant_id: row.get(9)?,
                used_at: row.get(10)?,
                mcp_scopes: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn request_by_code(conn: &Connection, hash: &[u8]) -> Result<Option<RequestRow>, String> {
    conn.query_row(
        "SELECT id, client_id, redirect_uri, state, challenge, resource, csrf_hash,
                expires_at, code_hash, grant_id, used_at, mcp_scopes
         FROM outside_requests WHERE code_hash = ?1",
        params![hash],
        |row| {
            Ok(RequestRow {
                id: row.get(0)?,
                client_id: row.get(1)?,
                redirect_uri: row.get(2)?,
                state: row.get(3)?,
                challenge: row.get(4)?,
                resource: row.get(5)?,
                csrf_hash: row.get(6)?,
                expires_at: row.get(7)?,
                code_hash: row.get(8)?,
                grant_id: row.get(9)?,
                used_at: row.get(10)?,
                mcp_scopes: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[derive(Clone, Debug)]
pub struct LiveProject {
    pub id: String,
    pub name: String,
    pub folder: String,
}

pub fn live_projects(conn: &Connection) -> Result<Vec<LiveProject>, String> {
    let doc = crate::local_hub::read_doc(conn, "projects")?;
    let Some(value) = doc.value else {
        return Ok(Vec::new());
    };
    let Some(items) = value.get("projects").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(|v| v.as_str()).map(str::trim) else {
            continue;
        };
        if id.is_empty() || id.len() > 1000 {
            continue;
        }
        if item.get("archived").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id);
        let folder = item
            .get("folder")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        out.push(LiveProject {
            id: id.to_string(),
            name: name.to_string(),
            folder,
        });
    }
    Ok(out)
}

pub fn consent_page(conn: &Connection, id: &str, now: i64, redirect_waiting: bool) -> Reply {
    if let Err(err) = store::ensure(conn) {
        return server_error(err);
    }
    let row = match request_by_id(conn, id) {
        Ok(Some(row)) => row,
        Ok(None) => return fail(400, "invalid_request"),
        Err(err) => return server_error(err),
    };
    let client_name = load_client(conn, &row.client_id)
        .ok()
        .flatten()
        .map(|c| c.name)
        .unwrap_or_else(|| "An app".into());
    if row.code_hash.is_some() {
        if redirect_waiting {
            return waiting_page(&client_name);
        }
        return html_page("You can close this window.");
    }
    if row.expires_at < now {
        return html_page("This request has expired. Start the connection again.");
    }
    waiting_page(&client_name)
}

/// Orbit's consent routes return 401 login_required when no one is logged in.
/// Hivra has no login cookie. The app command is that session.
pub fn login_required() -> Reply {
    fail(401, "login_required")
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn html_page(text: &str) -> Reply {
    page(&format!("<p>{}</p>", escape(text)), false)
}

fn waiting_page(client: &str) -> Reply {
    page(
        &format!(
            "<p>{} wants to read Hivra. Allow it in Hivra. This page continues when you do.</p>",
            escape(client)
        ),
        true,
    )
}

fn page(body: &str, refresh: bool) -> Reply {
    let refresh = if refresh {
        "<meta http-equiv=\"refresh\" content=\"1\">"
    } else {
        ""
    };
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">{refresh}<title>Connect</title></head><body>{body}</body></html>"
    );
    Reply {
        status: 200,
        headers: vec![("content-type".into(), "text/html; charset=utf-8".into())],
        body: html.into_bytes(),
    }
}

pub struct Decision<'a> {
    pub id: &'a str,
    pub csrf: Option<&'a str>,
    pub approved: bool,
    pub project_ids: &'a [String],
    pub write: bool,
    pub now: i64,
    pub origin: &'a str,
}

pub fn decide(conn: &Connection, decision: Decision<'_>) -> Reply {
    if let Err(err) = store::ensure(conn) {
        return server_error(err);
    }
    let row = match request_by_id(conn, decision.id) {
        Ok(Some(row)) => row,
        Ok(None) => return fail(400, "invalid_request"),
        Err(err) => return server_error(err),
    };
    if row.code_hash.is_some() || row.used_at.is_some() || row.expires_at < decision.now {
        return fail(400, "invalid_request");
    }
    if let Some(csrf) = decision.csrf {
        let Some(stored) = row.csrf_hash.as_deref() else {
            return fail(400, "invalid_request");
        };
        if hash_secret(csrf).as_slice() != stored {
            return fail(400, "invalid_request");
        }
    }
    let client = match load_client(conn, &row.client_id) {
        Ok(Some(client)) => client,
        Ok(None) => return fail(400, "invalid_client"),
        Err(err) => return server_error(err),
    };
    if !decision.approved {
        if let Err(err) = conn.execute(
            "DELETE FROM outside_requests WHERE id = ?1 AND code_hash IS NULL",
            params![decision.id],
        ) {
            return server_error(err.to_string());
        }
        return Reply::json(
            200,
            json!({ "redirect_uri": callback(&row.redirect_uri, &[("error", "access_denied"), ("state", &row.state)], decision.origin) }),
        );
    }
    if decision.project_ids.is_empty() || decision.project_ids.len() > 100 {
        return fail(400, "invalid_request");
    }
    let live = match live_projects(conn) {
        Ok(projects) => projects,
        Err(err) => return server_error(err),
    };
    let mut chosen = Vec::new();
    for id in decision.project_ids {
        if !live.iter().any(|p| p.id == *id) || chosen.iter().any(|have| have == id) {
            if !live.iter().any(|p| p.id == *id) {
                return fail(400, "invalid_request");
            }
            continue;
        }
        chosen.push(id.clone());
    }
    if chosen.is_empty() {
        return fail(400, "invalid_request");
    }
    let grant_id = uuid::Uuid::new_v4().to_string();
    let code = random_token("hivra-code-");
    let code_hash = hash_secret(&code);
    let projects_json = match serde_json::to_string(&chosen) {
        Ok(text) => text,
        Err(err) => return server_error(err.to_string()),
    };
    let extras = if decision.write {
        super::security::WRITE_SCOPE
    } else {
        ""
    };
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(err) => return server_error(err.to_string()),
    };
    let inserted = tx.execute(
        "INSERT INTO outside_grants (
           id, client_id, project_ids, resource, scope, mcp_scopes, revoked_at, created_at, last_used_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, NULL)",
        params![
            grant_id,
            row.client_id,
            projects_json,
            row.resource,
            SCOPE,
            extras,
            decision.now
        ],
    );
    if let Err(err) = inserted {
        return server_error(err.to_string());
    }
    let updated = tx.execute(
        "UPDATE outside_requests
         SET code_hash = ?1, grant_id = ?2, csrf_hash = NULL, expires_at = ?3, mcp_scopes = ?4
         WHERE id = ?5 AND code_hash IS NULL",
        params![
            code_hash.as_slice(),
            grant_id,
            decision.now.saturating_add(CODE_MILLIS),
            extras,
            decision.id
        ],
    );
    match updated {
        Ok(1) => {}
        Ok(_) => return fail(400, "invalid_request"),
        Err(err) => return server_error(err.to_string()),
    }
    if let Err(err) = note(
        &tx,
        "outside.connect",
        &chosen.join(" "),
        &grant_id,
        &format!("Connected {}.", client.name),
        decision.now,
    ) {
        return server_error(err);
    }
    if let Err(err) = tx.commit() {
        return server_error(err.to_string());
    }
    Reply::json(
        200,
        json!({
            "redirect_uri": callback(
                &row.redirect_uri,
                &[("code", code.as_str()), ("state", row.state.as_str())],
                decision.origin,
            )
        }),
    )
}

fn callback(redirect: &str, pairs: &[(&str, &str)], origin: &str) -> String {
    let Ok(mut url) = Url::parse(redirect) else {
        return redirect.to_string();
    };
    {
        let mut query = url.query_pairs_mut();
        for (name, value) in pairs {
            if name == &"state" && value.is_empty() {
                continue;
            }
            query.append_pair(name, value);
        }
        query.append_pair("iss", origin);
    }
    url.to_string()
}

fn note(
    conn: &Connection,
    kind: &str,
    project: &str,
    target: &str,
    summary: &str,
    at: i64,
) -> Result<(), String> {
    crate::activity::ensure_tables(conn).map_err(|e| e.to_string())?;
    let who = crate::activity::Who::person();
    crate::activity::record(conn, kind, &who, &who, project, target, summary, "", at)?;
    Ok(())
}

fn form_value<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

pub fn token(conn: &Connection, fields: &[(String, String)], now: i64) -> Reply {
    if let Err(err) = store::ensure(conn) {
        return server_error(err);
    }
    match form_value(fields, "grant_type") {
        Some("authorization_code") => exchange_code(conn, fields, now),
        Some("refresh_token") => exchange_refresh(conn, fields, now),
        Some(_) => fail(400, "unsupported_grant_type"),
        None => fail(400, "invalid_request"),
    }
}

fn exchange_code(conn: &Connection, fields: &[(String, String)], now: i64) -> Reply {
    let Some(code) = form_value(fields, "code") else {
        return fail(400, "invalid_request");
    };
    let Some(client_id) = form_value(fields, "client_id") else {
        return fail(400, "invalid_request");
    };
    let Some(redirect) = form_value(fields, "redirect_uri") else {
        return fail(400, "invalid_request");
    };
    let Some(verifier) = form_value(fields, "code_verifier") else {
        return fail(400, "invalid_request");
    };
    let hash = hash_secret(code);
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(err) => return server_error(err.to_string()),
    };
    let row = match request_by_code(&tx, &hash) {
        Ok(Some(row)) => row,
        Ok(None) => return fail(400, "invalid_grant"),
        Err(err) => return server_error(err),
    };
    if row.used_at.is_some() {
        return commit_revoke(tx, row.grant_id.as_deref(), now);
    }
    let resource_ok = match form_value(fields, "resource") {
        Some(given) => given == row.resource,
        None => true,
    };
    let bound = row.client_id == client_id
        && row.redirect_uri == redirect
        && resource_ok
        && pkce_ok(&row.challenge, verifier);
    if !bound || row.expires_at < now || row.grant_id.is_none() {
        return fail(400, "invalid_grant");
    }
    let marked = match tx.execute(
        "UPDATE outside_requests SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL",
        params![now, row.id],
    ) {
        Ok(n) => n,
        Err(err) => return server_error(err.to_string()),
    };
    if marked != 1 {
        return commit_revoke(tx, row.grant_id.as_deref(), now);
    }
    let write = row
        .mcp_scopes
        .split_whitespace()
        .any(|s| s == super::security::WRITE_SCOPE);
    let Some(grant_id) = row.grant_id.as_deref() else {
        return fail(400, "invalid_grant");
    };
    let issued = match issue(&tx, grant_id, write, now) {
        Ok(reply) => reply,
        Err(err) => return server_error(err),
    };
    if let Err(err) = tx.commit() {
        return server_error(err.to_string());
    }
    issued
}

fn exchange_refresh(conn: &Connection, fields: &[(String, String)], now: i64) -> Reply {
    let Some(refresh) = form_value(fields, "refresh_token") else {
        return fail(400, "invalid_request");
    };
    let Some(client_id) = form_value(fields, "client_id") else {
        return fail(400, "invalid_request");
    };
    if refresh.len() > 512 {
        return fail(400, "invalid_grant");
    }
    let asked = match parse_scope(form_value(fields, "scope")) {
        Ok(write) => write,
        Err(()) => return fail(400, "invalid_scope"),
    };
    let hash = hash_secret(refresh);
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(err) => return server_error(err.to_string()),
    };
    let found: Option<RefreshRow> = match tx
        .query_row(
            "SELECT t.grant_id, t.refresh_expires_at, t.refresh_used_at, g.client_id, g.revoked_at, g.mcp_scopes
             FROM outside_tokens t
             JOIN outside_grants g ON g.id = t.grant_id
             WHERE t.refresh_hash = ?1",
            params![hash.as_slice()],
            |row| {
                Ok(RefreshRow {
                    grant_id: row.get(0)?,
                    refresh_expires: row.get(1)?,
                    used: row.get(2)?,
                    owner: row.get(3)?,
                    revoked: row.get(4)?,
                    scopes: row.get(5)?,
                })
            },
        )
        .optional()
    {
        Ok(row) => row,
        Err(err) => return server_error(err.to_string()),
    };
    let Some(row) = found else {
        return fail(400, "invalid_grant");
    };
    if row.owner != client_id || row.revoked.is_some() || row.refresh_expires < now {
        return fail(400, "invalid_grant");
    }
    if row.used.is_some() {
        return commit_revoke(tx, Some(&row.grant_id), now);
    }
    let granted_write = row
        .scopes
        .split_whitespace()
        .any(|s| s == super::security::WRITE_SCOPE);
    if asked && !granted_write {
        return fail(400, "invalid_scope");
    }
    let marked = match tx.execute(
        "UPDATE outside_tokens SET refresh_used_at = ?1 WHERE refresh_hash = ?2 AND refresh_used_at IS NULL",
        params![now, hash.as_slice()],
    ) {
        Ok(n) => n,
        Err(err) => return server_error(err.to_string()),
    };
    if marked != 1 {
        return commit_revoke(tx, Some(&row.grant_id), now);
    }
    let issued = match issue(&tx, &row.grant_id, granted_write, now) {
        Ok(reply) => reply,
        Err(err) => return server_error(err),
    };
    if let Err(err) = tx.commit() {
        return server_error(err.to_string());
    }
    issued
}

/// A reused code or refresh token ends the connection. The refusal is only sent
/// after that revoke is committed, so the access token issued from it dies too.
fn commit_revoke(tx: rusqlite::Transaction<'_>, grant_id: Option<&str>, now: i64) -> Reply {
    if let Some(id) = grant_id {
        match tx.execute(
            "UPDATE outside_grants SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![now, id],
        ) {
            Ok(1) => {
                // The revoke has to stick even if the activity note cannot be written.
                let _ = note(
                    &tx,
                    "outside.disconnect",
                    "",
                    id,
                    "Disconnected a connection after a token was reused.",
                    now,
                );
            }
            Ok(_) => {}
            Err(err) => return server_error(err.to_string()),
        }
    }
    if let Err(err) = tx.commit() {
        return server_error(err.to_string());
    }
    fail(400, "invalid_grant")
}

fn issue(conn: &Connection, grant_id: &str, write: bool, now: i64) -> Result<Reply, String> {
    let access = random_token("hivra-mcp-a-");
    let refresh = random_token("hivra-mcp-r-");
    conn.execute(
        "INSERT INTO outside_tokens (
           access_hash, refresh_hash, grant_id, access_expires_at, refresh_expires_at, refresh_used_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
        params![
            hash_secret(&access).as_slice(),
            hash_secret(&refresh).as_slice(),
            grant_id,
            now.saturating_add(ACCESS_SECONDS * 1000),
            now.saturating_add(REFRESH_MILLIS)
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(Reply::json(
        200,
        json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ACCESS_SECONDS,
            "refresh_token": refresh,
            "scope": scope_list(write)
        }),
    ))
}

pub struct Access {
    pub project_ids: Vec<String>,
    pub write: bool,
}

struct RefreshRow {
    grant_id: String,
    refresh_expires: i64,
    used: Option<i64>,
    owner: String,
    revoked: Option<i64>,
    scopes: String,
}

pub fn authenticate(conn: &Connection, token: &str, now: i64) -> Result<Option<Access>, String> {
    store::ensure(conn)?;
    if !token.starts_with("hivra-mcp-a-") {
        return Ok(None);
    }
    let hash = hash_secret(token);
    let row: Option<(String, String, String, Option<i64>, i64)> = conn
        .query_row(
            "SELECT g.id, g.project_ids, g.mcp_scopes, g.revoked_at, t.access_expires_at
             FROM outside_tokens t
             JOIN outside_grants g ON g.id = t.grant_id
             WHERE t.access_hash = ?1",
            params![hash.as_slice()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((grant_id, projects_raw, scopes, revoked, expires)) = row else {
        return Ok(None);
    };
    if revoked.is_some() || expires < now {
        return Ok(None);
    }
    let stored: Vec<String> = serde_json::from_str(&projects_raw).unwrap_or_default();
    let live = live_projects(conn)?;
    let project_ids: Vec<String> = stored
        .into_iter()
        .filter(|id| live.iter().any(|p| p.id == *id))
        .collect();
    if project_ids.is_empty() {
        return Ok(None);
    }
    let _ = conn.execute(
        "UPDATE outside_grants SET last_used_at = ?1 WHERE id = ?2",
        params![now, grant_id],
    );
    Ok(Some(Access {
        project_ids,
        write: scopes
            .split_whitespace()
            .any(|s| s == super::security::WRITE_SCOPE),
    }))
}

pub fn disconnect(conn: &Connection, id: &str, now: i64) -> Result<bool, String> {
    store::ensure(conn)?;
    let name: Option<String> = conn
        .query_row(
            "SELECT c.name FROM outside_grants g
             JOIN outside_clients c ON c.id = g.client_id
             WHERE g.id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(name) = name else {
        return Ok(false);
    };
    let changed = conn
        .execute(
            "UPDATE outside_grants SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![now, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 1 {
        note(
            conn,
            "outside.disconnect",
            "",
            id,
            &format!("Disconnected {name}."),
            now,
        )?;
    }
    Ok(true)
}

pub fn revoke_token(conn: &Connection, fields: &[(String, String)], now: i64) -> Reply {
    if let Err(err) = store::ensure(conn) {
        return server_error(err);
    }
    // RFC 7009: an unknown token is still a success, so a client cannot probe.
    let Some(token) = form_value(fields, "token") else {
        return Reply::empty(200);
    };
    if token.len() > 512 {
        return Reply::empty(200);
    }
    let hash = hash_secret(token);
    let grant: Option<String> = conn
        .query_row(
            "SELECT grant_id FROM outside_tokens WHERE access_hash = ?1 OR refresh_hash = ?1",
            params![hash.as_slice()],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);
    if let Some(id) = grant {
        let _ = disconnect(conn, &id, now);
    }
    Reply::empty(200)
}
