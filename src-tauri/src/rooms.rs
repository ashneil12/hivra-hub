//! Rooms: the hub's group chats (a project's Leadership team and any chat Ash makes), kept in the app database
//! (docs/leadership/ROOM.md).
//!
//! The main window is the only writer: it runs the room (src/features/hub/model/hubChats.ts, roomConductor.ts) and
//! answers the agents' room tools (`rooms.post`, `rooms.read`, `monos.message`) on its own connection, so everything here
//! is plain rows and checks; nothing in this file decides who speaks.
//!
//! - **rooms**, **room_members** (in seat order), **room_conversations** (the room's threads, newest first), and
//!   **room_messages**: author (`ash`, a Mono id, or `app`), kind (`ash`, `mono`, `system`, `notice`), text, the message
//!   it replies to, reactions and a small meta object (quiet, the pick, a Need it is about). `seq` orders a room's
//!   messages for `rooms.read` ("since this message").
//! - **room_origins**: work a Mono delegated during a room turn, so its result comes back into that room ("X is back").
//! - Own tables, no numbered migration (like pr_watch and delegations), so an older build (a ship rollback) still opens
//!   the database. Writes are idempotent by id: a message or a room is never written twice, and an import only adds.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::session_store::{now_millis, SessionStore};

const ID_MAX: usize = 200;
const NAME_MAX: usize = 200;
/// A Lead's report or an imported message may be long; the agents' own posts are capped far lower (agentAppRooms.ts).
const TEXT_MAX: usize = 100_000;
const META_MAX: usize = 16_000;
const MEMBERS_MAX: usize = 64;
/// The newest messages of each conversation the window loads; older ones stay here for `rooms.read`.
pub const LOAD_PER_CONVERSATION: i64 = 500;
const READ_MAX: i64 = 200;
/// Origins nobody came back for are let go after this long.
const ORIGIN_KEEP: i64 = 14 * 24 * 60 * 60_000;
const KINDS: [&str; 4] = ["ash", "mono", "system", "notice"];

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rooms (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           name TEXT NOT NULL,
           is_default INTEGER NOT NULL DEFAULT 0,
           lead_id TEXT,
           seated INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS room_members (
           room_id TEXT NOT NULL,
           mono_id TEXT NOT NULL,
           position INTEGER NOT NULL,
           added_at INTEGER NOT NULL,
           PRIMARY KEY (room_id, mono_id)
         );
         CREATE TABLE IF NOT EXISTS room_conversations (
           room_id TEXT NOT NULL,
           id TEXT NOT NULL,
           title TEXT NOT NULL,
           named INTEGER NOT NULL DEFAULT 0,
           answered_through TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (room_id, id)
         );
         CREATE TABLE IF NOT EXISTS room_messages (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           room_id TEXT NOT NULL,
           conversation_id TEXT NOT NULL,
           id TEXT NOT NULL,
           author TEXT NOT NULL,
           kind TEXT NOT NULL,
           text TEXT NOT NULL,
           reply_to TEXT,
           meta_json TEXT NOT NULL DEFAULT '{}',
           reactions_json TEXT NOT NULL DEFAULT '{}',
           created_at INTEGER NOT NULL,
           UNIQUE (room_id, id)
         );
         CREATE INDEX IF NOT EXISTS room_messages_conversation
           ON room_messages (room_id, conversation_id, seq);
         CREATE TABLE IF NOT EXISTS room_origins (
           child_session TEXT PRIMARY KEY,
           room_id TEXT NOT NULL,
           conversation_id TEXT NOT NULL,
           mono_id TEXT NOT NULL,
           owner_session TEXT NOT NULL,
           title TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           posted_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS room_meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomInput {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub lead_id: Option<String>,
    #[serde(default)]
    pub seated: bool,
    #[serde(default)]
    pub member_ids: Vec<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationInput {
    pub room_id: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub named: bool,
    #[serde(default)]
    pub answered_through: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageInput {
    pub room_id: String,
    pub conversation_id: String,
    pub id: String,
    pub author: String,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub meta: Option<Value>,
    #[serde(default)]
    pub reactions: Option<Value>,
    #[serde(default)]
    pub created_at: Option<i64>,
}

/// A change to a message already written: its reactions or meta (a notice resolved), never its author or text.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagePatch {
    pub room_id: String,
    pub id: String,
    #[serde(default)]
    pub meta: Option<Value>,
    #[serde(default)]
    pub reactions: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub seq: i64,
    pub id: String,
    pub conversation_id: String,
    pub author: String,
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    pub meta: Value,
    pub reactions: Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub named: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answered_through: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<Message>,
    /// Older messages are stored than were loaded.
    pub more: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead_id: Option<String>,
    pub seated: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub member_ids: Vec<String>,
    pub conversations: Vec<Conversation>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub rooms: Vec<Room>,
    /// The one-time import of the rooms the window kept in its own storage before this store: when and how many.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_import: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportBundle {
    #[serde(default)]
    pub rooms: Vec<RoomInput>,
    #[serde(default)]
    pub conversations: Vec<ConversationInput>,
    #[serde(default)]
    pub messages: Vec<MessageInput>,
    /// Record the import under this key (the legacy migration's receipt).
    #[serde(default)]
    pub mark: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub rooms: i64,
    pub conversations: i64,
    pub messages: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Origin {
    pub child_session: String,
    pub room_id: String,
    pub conversation_id: String,
    pub mono_id: String,
    pub owner_session: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub created_at: i64,
}

fn id_ok(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > ID_MAX || value.chars().any(char::is_control) {
        return Err(format!("{what} must be 1 to {ID_MAX} characters"));
    }
    Ok(())
}

fn text_ok(value: &str, what: &str, max: usize) -> Result<(), String> {
    if value.len() > max {
        return Err(format!("{what} is longer than {max} bytes"));
    }
    Ok(())
}

/// An object, bounded; anything else is stored as `{}`.
fn object_json(value: Option<&Value>, what: &str) -> Result<String, String> {
    match value {
        None | Some(Value::Null) => Ok("{}".into()),
        Some(value @ Value::Object(_)) => {
            let text = value.to_string();
            text_ok(&text, what, META_MAX)?;
            Ok(text)
        }
        Some(_) => Err(format!("{what} must be an object")),
    }
}

fn check_room(input: &RoomInput) -> Result<(), String> {
    id_ok(&input.id, "room id")?;
    id_ok(&input.project_id, "project id")?;
    if input.name.trim().is_empty() || input.name.len() > NAME_MAX {
        return Err(format!("room name must be 1 to {NAME_MAX} characters"));
    }
    if let Some(lead) = &input.lead_id {
        id_ok(lead, "lead id")?;
    }
    if input.member_ids.len() > MEMBERS_MAX {
        return Err(format!("a room has at most {MEMBERS_MAX} members"));
    }
    for member in &input.member_ids {
        id_ok(member, "member id")?;
    }
    Ok(())
}

fn check_conversation(input: &ConversationInput) -> Result<(), String> {
    id_ok(&input.room_id, "room id")?;
    id_ok(&input.id, "conversation id")?;
    text_ok(&input.title, "title", NAME_MAX * 4)?;
    if let Some(through) = &input.answered_through {
        id_ok(through, "answeredThrough")?;
    }
    Ok(())
}

fn check_message(input: &MessageInput) -> Result<(), String> {
    id_ok(&input.room_id, "room id")?;
    id_ok(&input.conversation_id, "conversation id")?;
    id_ok(&input.id, "message id")?;
    id_ok(&input.author, "author")?;
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(format!("kind must be one of {}", KINDS.join(", ")));
    }
    text_ok(&input.text, "text", TEXT_MAX)?;
    if let Some(reply) = &input.reply_to {
        id_ok(reply, "replyTo")?;
    }
    Ok(())
}

/// Insert or update a room's own fields and its seats (in order). `created_at` is kept from the first write.
pub fn upsert_room(conn: &mut Connection, input: &RoomInput, now: i64) -> Result<(), String> {
    check_room(input)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    upsert_room_in(&tx, input, now, true)?;
    tx.commit().map_err(|e| e.to_string())
}

/// `replace`: an existing room takes these fields and seats; otherwise only a new room is written (an import).
fn upsert_room_in(
    conn: &Connection,
    input: &RoomInput,
    now: i64,
    replace: bool,
) -> Result<bool, String> {
    let created = input.created_at.unwrap_or(now);
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO rooms (id, project_id, name, is_default, lead_id, seated, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                input.id,
                input.project_id,
                input.name.trim(),
                input.is_default,
                input.lead_id,
                input.seated,
                created,
                now
            ],
        )
        .map_err(|e| e.to_string())?
        > 0;
    if !inserted && !replace {
        return Ok(false);
    }
    if !inserted {
        conn.execute(
            "UPDATE rooms SET project_id = ?2, name = ?3, is_default = ?4, lead_id = ?5, seated = ?6, updated_at = ?7
             WHERE id = ?1",
            params![
                input.id,
                input.project_id,
                input.name.trim(),
                input.is_default,
                input.lead_id,
                input.seated,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute("DELETE FROM room_members WHERE room_id = ?1", [&input.id])
        .map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    for (position, member) in input.member_ids.iter().enumerate() {
        if !seen.insert(member) {
            continue;
        }
        conn.execute(
            "INSERT INTO room_members (room_id, mono_id, position, added_at) VALUES (?1, ?2, ?3, ?4)",
            params![input.id, member, position as i64, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(inserted)
}

fn room_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM rooms WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn upsert_conversation(
    conn: &Connection,
    input: &ConversationInput,
    now: i64,
) -> Result<(), String> {
    check_conversation(input)?;
    if !room_exists(conn, &input.room_id)? {
        return Err(format!("No room {}", input.room_id));
    }
    upsert_conversation_in(conn, input, now, true).map(|_| ())
}

fn upsert_conversation_in(
    conn: &Connection,
    input: &ConversationInput,
    now: i64,
    replace: bool,
) -> Result<bool, String> {
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO room_conversations (room_id, id, title, named, answered_through, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                input.room_id,
                input.id,
                input.title,
                input.named,
                input.answered_through,
                input.created_at.unwrap_or(now),
                now
            ],
        )
        .map_err(|e| e.to_string())?
        > 0;
    if !inserted && replace {
        conn.execute(
            "UPDATE room_conversations SET title = ?3, named = ?4, answered_through = ?5, updated_at = ?6
             WHERE room_id = ?1 AND id = ?2",
            params![
                input.room_id,
                input.id,
                input.title,
                input.named,
                input.answered_through,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(inserted)
}

/// Write one message, once: a second write of the same id changes nothing and returns the stored row.
pub fn add_message(conn: &Connection, input: &MessageInput, now: i64) -> Result<Message, String> {
    check_message(input)?;
    let conversation: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM room_conversations WHERE room_id = ?1 AND id = ?2)",
            params![input.room_id, input.conversation_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !conversation {
        return Err(format!(
            "No conversation {} in room {}",
            input.conversation_id, input.room_id
        ));
    }
    add_message_in(conn, input, now)?;
    conn.execute(
        "UPDATE room_conversations SET updated_at = ?3 WHERE room_id = ?1 AND id = ?2",
        params![input.room_id, input.conversation_id, now],
    )
    .map_err(|e| e.to_string())?;
    message(conn, &input.room_id, &input.id)?.ok_or_else(|| "The message was not stored".into())
}

fn add_message_in(conn: &Connection, input: &MessageInput, now: i64) -> Result<bool, String> {
    let meta = object_json(input.meta.as_ref(), "meta")?;
    let reactions = object_json(input.reactions.as_ref(), "reactions")?;
    Ok(conn
        .execute(
            "INSERT OR IGNORE INTO room_messages
               (room_id, conversation_id, id, author, kind, text, reply_to, meta_json, reactions_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                input.room_id,
                input.conversation_id,
                input.id,
                input.author,
                input.kind,
                input.text,
                input.reply_to,
                meta,
                reactions,
                input.created_at.unwrap_or(now)
            ],
        )
        .map_err(|e| e.to_string())?
        > 0)
}

pub fn update_message(conn: &Connection, patch: &MessagePatch) -> Result<Option<Message>, String> {
    id_ok(&patch.room_id, "room id")?;
    id_ok(&patch.id, "message id")?;
    if let Some(meta) = &patch.meta {
        conn.execute(
            "UPDATE room_messages SET meta_json = ?3 WHERE room_id = ?1 AND id = ?2",
            params![patch.room_id, patch.id, object_json(Some(meta), "meta")?],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(reactions) = &patch.reactions {
        conn.execute(
            "UPDATE room_messages SET reactions_json = ?3 WHERE room_id = ?1 AND id = ?2",
            params![
                patch.room_id,
                patch.id,
                object_json(Some(reactions), "reactions")?
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    message(conn, &patch.room_id, &patch.id)
}

fn parse_object(text: String) -> Value {
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

const MESSAGE_COLUMNS: &str =
    "seq, id, conversation_id, author, kind, text, reply_to, meta_json, reactions_json, created_at";

fn message_row(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    Ok(Message {
        seq: row.get(0)?,
        id: row.get(1)?,
        conversation_id: row.get(2)?,
        author: row.get(3)?,
        kind: row.get(4)?,
        text: row.get(5)?,
        reply_to: row.get(6)?,
        meta: parse_object(row.get(7)?),
        reactions: parse_object(row.get(8)?),
        created_at: row.get(9)?,
    })
}

fn message(conn: &Connection, room: &str, id: &str) -> Result<Option<Message>, String> {
    conn.query_row(
        &format!("SELECT {MESSAGE_COLUMNS} FROM room_messages WHERE room_id = ?1 AND id = ?2"),
        params![room, id],
        message_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every room with its seats and each conversation's newest messages (oldest first), newest conversation first.
pub fn load(conn: &Connection, per_conversation: i64) -> Result<Snapshot, String> {
    let mut rooms = conn
        .prepare(
            "SELECT id, project_id, name, is_default, lead_id, seated, created_at, updated_at
             FROM rooms ORDER BY created_at, id",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |row| {
            Ok(Room {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                is_default: row.get(3)?,
                lead_id: row.get(4)?,
                seated: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                member_ids: Vec::new(),
                conversations: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut members = conn
        .prepare("SELECT mono_id FROM room_members WHERE room_id = ?1 ORDER BY position, mono_id")
        .map_err(|e| e.to_string())?;
    let mut conversations = conn
        .prepare(
            "SELECT id, title, named, answered_through, created_at, updated_at
             FROM room_conversations WHERE room_id = ?1 ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let mut newest = conn
        .prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM room_messages
             WHERE room_id = ?1 AND conversation_id = ?2 ORDER BY seq DESC LIMIT ?3"
        ))
        .map_err(|e| e.to_string())?;
    let mut count = conn
        .prepare("SELECT COUNT(*) FROM room_messages WHERE room_id = ?1 AND conversation_id = ?2")
        .map_err(|e| e.to_string())?;
    for room in &mut rooms {
        room.member_ids = members
            .query_map([&room.id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<String>>>()
            .map_err(|e| e.to_string())?;
        let threads = conversations
            .query_map([&room.id], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    named: row.get(2)?,
                    answered_through: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    messages: Vec::new(),
                    more: false,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        for mut thread in threads {
            let mut messages = newest
                .query_map(params![room.id, thread.id, per_conversation], message_row)
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            messages.reverse();
            let total: i64 = count
                .query_row(params![room.id, thread.id], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            thread.more = total > messages.len() as i64;
            thread.messages = messages;
            room.conversations.push(thread);
        }
    }
    let legacy_import = conn
        .query_row(
            "SELECT value FROM room_meta WHERE key = 'legacy_import'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .map(parse_object);
    Ok(Snapshot {
        rooms,
        legacy_import,
    })
}

/// A room's messages after `since` (a message id), oldest first, or its newest `limit` without one. With a
/// conversation, only that thread.
pub fn read(
    conn: &Connection,
    room: &str,
    conversation: Option<&str>,
    since: Option<&str>,
    limit: i64,
) -> Result<Vec<Message>, String> {
    id_ok(room, "room id")?;
    let limit = limit.clamp(1, READ_MAX);
    let after = match since {
        None => None,
        Some(id) => Some(
            conn.query_row(
                "SELECT seq FROM room_messages WHERE room_id = ?1 AND id = ?2",
                params![room, id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("No message {id} in this room"))?,
        ),
    };
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM room_messages
         WHERE room_id = ?1 AND (?2 IS NULL OR conversation_id = ?2) AND (?3 IS NULL OR seq > ?3)
         ORDER BY seq {} LIMIT ?4",
        if after.is_some() { "ASC" } else { "DESC" }
    );
    let mut messages = conn
        .prepare(&sql)
        .map_err(|e| e.to_string())?
        .query_map(params![room, conversation, after, limit], message_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    if after.is_none() {
        messages.reverse();
    }
    Ok(messages)
}

/// Add what is not here yet, in one transaction: rooms by id (with their seats), conversations, then messages.
/// Nothing already stored is changed, so running it twice adds nothing the second time.
pub fn import(
    conn: &mut Connection,
    bundle: &ImportBundle,
    now: i64,
) -> Result<ImportReport, String> {
    for room in &bundle.rooms {
        check_room(room)?;
    }
    for conversation in &bundle.conversations {
        check_conversation(conversation)?;
    }
    for message in &bundle.messages {
        check_message(message)?;
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut report = ImportReport::default();
    for room in &bundle.rooms {
        if upsert_room_in(&tx, room, now, false)? {
            report.rooms += 1;
        }
    }
    for conversation in &bundle.conversations {
        if !room_exists(&tx, &conversation.room_id)? {
            return Err(format!(
                "Conversation {} names no room ({})",
                conversation.id, conversation.room_id
            ));
        }
        if upsert_conversation_in(&tx, conversation, now, false)? {
            report.conversations += 1;
        }
    }
    for message in &bundle.messages {
        let known: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM room_conversations WHERE room_id = ?1 AND id = ?2)",
                params![message.room_id, message.conversation_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !known {
            return Err(format!(
                "Message {} names no conversation ({})",
                message.id, message.conversation_id
            ));
        }
        if add_message_in(&tx, message, now)? {
            report.messages += 1;
        }
    }
    if let Some(key) = &bundle.mark {
        id_ok(key, "mark")?;
        let totals: (i64, i64, i64) = tx
            .query_row(
                "SELECT (SELECT COUNT(*) FROM rooms), (SELECT COUNT(*) FROM room_conversations),
                        (SELECT COUNT(*) FROM room_messages)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO room_meta (key, value) VALUES (?1, ?2)",
            params![
                key,
                json!({
                    "at": now,
                    "added": report,
                    "rooms": totals.0,
                    "conversations": totals.1,
                    "messages": totals.2,
                })
                .to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(report)
}

pub fn add_origin(conn: &Connection, origin: &Origin, now: i64) -> Result<(), String> {
    id_ok(&origin.child_session, "childSession")?;
    id_ok(&origin.room_id, "room id")?;
    id_ok(&origin.conversation_id, "conversation id")?;
    id_ok(&origin.mono_id, "mono id")?;
    id_ok(&origin.owner_session, "owner session")?;
    text_ok(&origin.title, "title", NAME_MAX * 2)?;
    conn.execute(
        "INSERT OR IGNORE INTO room_origins
           (child_session, room_id, conversation_id, mono_id, owner_session, title, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            origin.child_session,
            origin.room_id,
            origin.conversation_id,
            origin.mono_id,
            origin.owner_session,
            origin.title,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Origins whose result has not come back into their room yet (older ones are let go).
pub fn open_origins(conn: &Connection, now: i64) -> Result<Vec<Origin>, String> {
    conn.execute(
        "DELETE FROM room_origins WHERE created_at < ?1",
        [now - ORIGIN_KEEP],
    )
    .map_err(|e| e.to_string())?;
    conn.prepare(
        "SELECT child_session, room_id, conversation_id, mono_id, owner_session, title, created_at
         FROM room_origins WHERE posted_at IS NULL ORDER BY created_at",
    )
    .map_err(|e| e.to_string())?
    .query_map([], |row| {
        Ok(Origin {
            child_session: row.get(0)?,
            room_id: row.get(1)?,
            conversation_id: row.get(2)?,
            mono_id: row.get(3)?,
            owner_session: row.get(4)?,
            title: row.get(5)?,
            created_at: row.get(6)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string())
}

/// The origin's result is in its room (or it never will be): it is not offered again.
pub fn origin_done(conn: &Connection, child_session: &str, now: i64) -> Result<bool, String> {
    Ok(conn
        .execute(
            "UPDATE room_origins SET posted_at = ?2 WHERE child_session = ?1 AND posted_at IS NULL",
            params![child_session, now],
        )
        .map_err(|e| e.to_string())?
        > 0)
}

#[tauri::command(async)]
pub fn rooms_load(store: State<'_, SessionStore>) -> Result<Snapshot, String> {
    load(&*store.lock_conn()?, LOAD_PER_CONVERSATION)
}

#[tauri::command(async)]
pub fn rooms_upsert(store: State<'_, SessionStore>, room: RoomInput) -> Result<(), String> {
    upsert_room(&mut *store.lock_conn()?, &room, now_millis())
}

#[tauri::command(async)]
pub fn rooms_conversation_upsert(
    store: State<'_, SessionStore>,
    conversation: ConversationInput,
) -> Result<(), String> {
    upsert_conversation(&*store.lock_conn()?, &conversation, now_millis())
}

#[tauri::command(async)]
pub fn rooms_message_add(
    store: State<'_, SessionStore>,
    message: MessageInput,
) -> Result<Message, String> {
    add_message(&*store.lock_conn()?, &message, now_millis())
}

#[tauri::command(async)]
pub fn rooms_message_update(
    store: State<'_, SessionStore>,
    patch: MessagePatch,
) -> Result<Option<Message>, String> {
    update_message(&*store.lock_conn()?, &patch)
}

#[tauri::command(async)]
pub fn rooms_read(
    store: State<'_, SessionStore>,
    room: String,
    conversation: Option<String>,
    since: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Message>, String> {
    read(
        &*store.lock_conn()?,
        &room,
        conversation.as_deref(),
        since.as_deref(),
        limit.unwrap_or(30),
    )
}

#[tauri::command(async)]
pub fn rooms_import(
    store: State<'_, SessionStore>,
    bundle: ImportBundle,
) -> Result<ImportReport, String> {
    import(&mut *store.lock_conn()?, &bundle, now_millis())
}

#[tauri::command(async)]
pub fn rooms_origin_add(store: State<'_, SessionStore>, origin: Origin) -> Result<(), String> {
    add_origin(&*store.lock_conn()?, &origin, now_millis())
}

#[tauri::command(async)]
pub fn rooms_origins_open(store: State<'_, SessionStore>) -> Result<Vec<Origin>, String> {
    open_origins(&*store.lock_conn()?, now_millis())
}

#[tauri::command(async)]
pub fn rooms_origin_done(
    store: State<'_, SessionStore>,
    child_session: String,
) -> Result<bool, String> {
    origin_done(&*store.lock_conn()?, &child_session, now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    fn room(id: &str, members: &[&str]) -> RoomInput {
        RoomInput {
            id: id.into(),
            project_id: "hub".into(),
            name: "Leadership team".into(),
            is_default: true,
            member_ids: members.iter().map(|m| m.to_string()).collect(),
            ..Default::default()
        }
    }

    fn thread(room: &str, id: &str, at: i64) -> ConversationInput {
        ConversationInput {
            room_id: room.into(),
            id: id.into(),
            title: format!("Thread {id}"),
            created_at: Some(at),
            ..Default::default()
        }
    }

    fn say(room: &str, conv: &str, id: &str, author: &str, text: &str) -> MessageInput {
        MessageInput {
            room_id: room.into(),
            conversation_id: conv.into(),
            id: id.into(),
            author: author.into(),
            kind: if author == "ash" { "ash" } else { "mono" }.into(),
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_room_keeps_its_seats_in_order_its_threads_newest_first_and_each_message_once() {
        let mut c = conn();
        upsert_room(
            &mut c,
            &room(
                "hub:leadership",
                &["chief-of-staff", "frank", "frank", "projects-manager"],
            ),
            10,
        )
        .unwrap();
        upsert_conversation(&c, &thread("hub:leadership", "c1", 100), 100).unwrap();
        upsert_conversation(&c, &thread("hub:leadership", "c2", 200), 200).unwrap();
        let first = add_message(
            &c,
            &say("hub:leadership", "c1", "m1", "ash", "wat now"),
            300,
        )
        .unwrap();
        let mut reply = say(
            "hub:leadership",
            "c1",
            "m2",
            "chief-of-staff",
            "Waiting on Critiquito.",
        );
        reply.reply_to = Some("m1".into());
        reply.meta =
            Some(json!({ "pick": { "by": "lead", "why": "the room's lead answers Ash first" } }));
        add_message(&c, &reply, 301).unwrap();
        // the same id again (a retried write) changes nothing
        let again = add_message(
            &c,
            &say("hub:leadership", "c1", "m1", "ash", "something else"),
            999,
        )
        .unwrap();
        assert_eq!(again, first);
        let snap = load(&c, 500).unwrap();
        assert_eq!(snap.rooms.len(), 1);
        let r = &snap.rooms[0];
        assert_eq!(
            r.member_ids,
            ["chief-of-staff", "frank", "projects-manager"]
        );
        assert_eq!(
            r.conversations
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["c2", "c1"]
        );
        let msgs = &r.conversations[1].messages;
        assert_eq!(
            msgs.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["wat now", "Waiting on Critiquito."]
        );
        assert_eq!(msgs[1].reply_to.as_deref(), Some("m1"));
        assert_eq!(msgs[1].meta["pick"]["by"], "lead");
        assert_eq!(msgs[1].kind, "mono");
        assert!(!r.conversations[1].more);
        // seats are replaced as a whole on the next write
        upsert_room(
            &mut c,
            &room("hub:leadership", &["frank", "chief-of-staff"]),
            20,
        )
        .unwrap();
        assert_eq!(
            load(&c, 500).unwrap().rooms[0].member_ids,
            ["frank", "chief-of-staff"]
        );
    }

    #[test]
    fn reactions_and_meta_change_but_author_and_text_never_do() {
        let mut c = conn();
        upsert_room(&mut c, &room("r", &["frank"]), 1).unwrap();
        upsert_conversation(&c, &thread("r", "c", 1), 1).unwrap();
        add_message(&c, &say("r", "c", "m", "frank", "06 passes from me."), 2).unwrap();
        let patched = update_message(
            &c,
            &MessagePatch {
                room_id: "r".into(),
                id: "m".into(),
                reactions: Some(json!({ "👍": ["projects-manager"] })),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(patched.reactions, json!({ "👍": ["projects-manager"] }));
        assert_eq!(patched.text, "06 passes from me.");
        assert!(update_message(
            &c,
            &MessagePatch {
                room_id: "r".into(),
                id: "m".into(),
                meta: Some(json!("x")),
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn read_gives_the_newest_or_everything_after_a_message_and_refuses_an_unknown_one() {
        let mut c = conn();
        upsert_room(&mut c, &room("r", &[]), 1).unwrap();
        upsert_conversation(&c, &thread("r", "a", 1), 1).unwrap();
        upsert_conversation(&c, &thread("r", "b", 2), 2).unwrap();
        for i in 0..6 {
            let conv = if i % 2 == 0 { "a" } else { "b" };
            add_message(
                &c,
                &say("r", conv, &format!("m{i}"), "frank", &format!("post {i}")),
                10 + i,
            )
            .unwrap();
        }
        let ids = |m: Vec<Message>| m.into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(
            ids(read(&c, "r", None, None, 3).unwrap()),
            ["m3", "m4", "m5"]
        );
        assert_eq!(
            ids(read(&c, "r", None, Some("m2"), 30).unwrap()),
            ["m3", "m4", "m5"]
        );
        assert_eq!(
            ids(read(&c, "r", Some("a"), Some("m0"), 30).unwrap()),
            ["m2", "m4"]
        );
        assert!(read(&c, "r", None, Some("nope"), 30).is_err());
        // load keeps only the newest of a long thread and says there are more
        let snap = load(&c, 2).unwrap();
        let a = snap.rooms[0]
            .conversations
            .iter()
            .find(|t| t.id == "a")
            .unwrap();
        assert_eq!(
            a.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["m2", "m4"]
        );
        assert!(a.more);
    }

    #[test]
    fn bad_input_is_refused_before_anything_is_written() {
        let mut c = conn();
        assert!(upsert_room(
            &mut c,
            &RoomInput {
                name: " ".into(),
                ..room("r", &[])
            },
            1
        )
        .is_err());
        upsert_room(&mut c, &room("r", &[]), 1).unwrap();
        assert!(upsert_conversation(&c, &thread("nope", "c", 1), 1).is_err());
        upsert_conversation(&c, &thread("r", "c", 1), 1).unwrap();
        let mut odd = say("r", "c", "m", "frank", "hi");
        odd.kind = "shout".into();
        assert!(add_message(&c, &odd, 1).is_err());
        assert!(add_message(&c, &say("r", "missing", "m", "frank", "hi"), 1).is_err());
        assert!(add_message(
            &c,
            &say("r", "c", "m", "frank", &"x".repeat(TEXT_MAX + 1)),
            1
        )
        .is_err());
        assert!(add_message(&c, &say("r", "c", "", "frank", "hi"), 1).is_err());
        assert!(load(&c, 10).unwrap().rooms[0].conversations[0]
            .messages
            .is_empty());
    }

    #[test]
    fn an_import_only_adds_is_idempotent_and_records_its_receipt() {
        let mut c = conn();
        upsert_room(
            &mut c,
            &RoomInput {
                name: "Renamed here".into(),
                ..room("r", &["frank"])
            },
            1,
        )
        .unwrap();
        upsert_conversation(&c, &thread("r", "kept", 1), 1).unwrap();
        let bundle = ImportBundle {
            rooms: vec![room("r", &["alfred"]), room("s", &["chief-of-staff"])],
            conversations: vec![
                thread("r", "kept", 5),
                thread("r", "new", 6),
                thread("s", "c", 7),
            ],
            messages: vec![
                say("r", "new", "1", "ash", "hello"),
                say("s", "c", "1", "ash", "hello again"),
                say("s", "c", "2", "chief-of-staff", "Heard."),
            ],
            mark: Some("legacy_import".into()),
        };
        let first = import(&mut c, &bundle, 50).unwrap();
        assert_eq!(
            first,
            ImportReport {
                rooms: 1,
                conversations: 2,
                messages: 3
            }
        );
        let second = import(&mut c, &bundle, 60).unwrap();
        assert_eq!(second, ImportReport::default());
        let snap = load(&c, 500).unwrap();
        let r = snap.rooms.iter().find(|r| r.id == "r").unwrap();
        assert_eq!(
            r.name, "Renamed here",
            "an import never changes a room that is here"
        );
        assert_eq!(r.member_ids, ["frank"]);
        let receipt = snap.legacy_import.unwrap();
        assert_eq!(receipt["at"], 60);
        assert_eq!(receipt["messages"], 3);
        // a message naming a conversation that isn't there fails the whole import
        let broken = ImportBundle {
            rooms: vec![room("t", &[])],
            messages: vec![say("t", "ghost", "1", "ash", "x")],
            ..Default::default()
        };
        assert!(import(&mut c, &broken, 70).is_err());
        assert!(
            load(&c, 500).unwrap().rooms.iter().all(|r| r.id != "t"),
            "nothing of a failed import stays"
        );
    }

    #[test]
    fn an_origin_is_offered_until_its_result_is_in_the_room_and_old_ones_are_let_go() {
        let c = conn();
        let origin = Origin {
            child_session: "app-mono-cos-1".into(),
            room_id: "hub:leadership".into(),
            conversation_id: "c1".into(),
            mono_id: "chief-of-staff".into(),
            owner_session: "mono-chief-of-staff".into(),
            title: "Launch platform shortlist".into(),
            created_at: 0,
        };
        add_origin(&c, &origin, 1_000).unwrap();
        add_origin(&c, &origin, 2_000).unwrap();
        let open = open_origins(&c, 5_000).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].created_at, 1_000);
        assert!(origin_done(&c, "app-mono-cos-1", 6_000).unwrap());
        assert!(!origin_done(&c, "app-mono-cos-1", 7_000).unwrap());
        assert!(open_origins(&c, 8_000).unwrap().is_empty());
        add_origin(
            &c,
            &Origin {
                child_session: "old".into(),
                ..origin
            },
            1_000,
        )
        .unwrap();
        assert!(open_origins(&c, 1_000 + ORIGIN_KEEP + 1)
            .unwrap()
            .is_empty());
    }
}
