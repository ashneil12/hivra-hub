// Copyright 2026 The Hivra authors.
// SPDX-License-Identifier: Apache-2.0
//
// Translated from Orbit (Apache-2.0, https://github.com/coollabsio/orbit)
// apps/server/migrations/0035_mcp_oauth.sql and 0064_mcp_permissions.sql.
// Orbit's sqlx tables become rusqlite. There is one person, so user and
// workspace columns are not kept.

use rusqlite::{params, Connection, OptionalExtension};

pub fn ensure(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS outside_clients (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           redirect_uris TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS outside_registrations (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ip TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS outside_grants (
           id TEXT PRIMARY KEY,
           client_id TEXT NOT NULL,
           project_ids TEXT NOT NULL,
           resource TEXT NOT NULL,
           scope TEXT NOT NULL,
           mcp_scopes TEXT NOT NULL DEFAULT '',
           revoked_at INTEGER,
           created_at INTEGER NOT NULL,
           last_used_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS outside_requests (
           id TEXT PRIMARY KEY,
           client_id TEXT NOT NULL,
           redirect_uri TEXT NOT NULL,
           state TEXT NOT NULL,
           challenge TEXT NOT NULL,
           resource TEXT NOT NULL,
           csrf_hash BLOB,
           expires_at INTEGER NOT NULL,
           code_hash BLOB UNIQUE,
           grant_id TEXT,
           used_at INTEGER,
           mcp_scopes TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS outside_tokens (
           access_hash BLOB PRIMARY KEY,
           refresh_hash BLOB NOT NULL UNIQUE,
           grant_id TEXT NOT NULL,
           access_expires_at INTEGER NOT NULL,
           refresh_expires_at INTEGER NOT NULL,
           refresh_used_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS outside_settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
    .map_err(|e| e.to_string())
}

pub fn enabled(conn: &Connection) -> Result<bool, String> {
    ensure(conn)?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM outside_settings WHERE key = 'enabled'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(value.as_deref() == Some("1"))
}

pub fn set_enabled(conn: &Connection, on: bool) -> Result<(), String> {
    ensure(conn)?;
    conn.execute(
        "INSERT INTO outside_settings (key, value) VALUES ('enabled', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![if on { "1" } else { "0" }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn client_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM outside_clients", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

pub fn registrations_since(conn: &Connection, ip: &str, since: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM outside_registrations WHERE ip = ?1 AND created_at >= ?2",
        params![ip, since],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Drop unused clients older than a day. A client with a request or a grant stays.
pub fn prune_unused_clients(conn: &Connection, cutoff: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM outside_registrations WHERE created_at < ?1",
        params![cutoff],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM outside_clients
         WHERE created_at < ?1
           AND id NOT IN (SELECT client_id FROM outside_requests)
           AND id NOT IN (SELECT client_id FROM outside_grants)",
        params![cutoff],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
