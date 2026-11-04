// Docs are notes (WP-72). Blocks, the page tree and history are columns and
// tables beside the Markdown body, not a second store.
//
// Version rules are translated from Orbit's page_versions.rs. Orbit waits ten
// minutes between snapshots; Hivra does not. A version is stored when the
// caller asks (the editor went idle, the page closed, or an agent wrote),
// unless the page is blank or identical to the newest version. Restoring
// writes a new version and keeps the current state when it would be lost.
// Yjs co-editing is WP-80 and is not stored here.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::fs::canonical;
use crate::notes::unique_slug;
use crate::session_store::{now_millis, validate_id, SessionStore};

const BODY_MAX: usize = 1_000_000;
const BLOCKS_MAX: usize = 2_000_000;
const TITLE_MAX: usize = 200;

const PAGE_COLUMNS: &str = "id, slug, title, body, blocks_json, parent_id, sort_order, doc_version, tags_json, source_cwd, source_session_id, favourite, last_opened_at, trashed_at, created_at, updated_at";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocPage {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub body: String,
    pub blocks_json: Option<String>,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub version: i64,
    pub tags: Vec<String>,
    pub source_cwd: Option<String>,
    pub source_session_id: Option<String>,
    pub favourite: bool,
    pub last_opened_at: Option<i64>,
    pub trashed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocMention {
    pub kind: String,
    pub target_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DocWrite {
    Saved {
        page: Box<DocPage>,
        new_mentions: Vec<DocMention>,
    },
    Conflict {
        version: i64,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocVersion {
    pub id: String,
    pub note_id: String,
    pub version: i64,
    pub title: String,
    pub body: String,
    pub blocks_json: Option<String>,
    pub kind: String,
    pub author_kind: String,
    pub author_id: String,
    pub author_name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocResolved {
    pub found: bool,
    pub kind: String,
    pub target_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocCreate {
    pub id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub blocks_json: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_cwd: Option<String>,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default = "person_origin")]
    pub origin: String,
    #[serde(default)]
    pub author_id: String,
    #[serde(default)]
    pub author_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocUpdate {
    pub id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub blocks_json: Option<String>,
    pub expected_version: i64,
    #[serde(default)]
    pub snapshot: bool,
    #[serde(default = "person_origin")]
    pub origin: String,
    #[serde(default)]
    pub author_id: String,
    #[serde(default)]
    pub author_name: String,
    /// Absent tags stay as they are. An empty list clears them.
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMove {
    pub id: String,
    pub parent_id: Option<String>,
    pub index: i64,
    pub expected_version: i64,
    /// Siblings the caller ordered against, not including the moved page.
    /// A list that no longer matches the parent is a stale move.
    #[serde(default)]
    pub sibling_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRestore {
    pub id: String,
    pub version: i64,
    pub expected_version: i64,
    #[serde(default)]
    pub author_id: String,
    #[serde(default)]
    pub author_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocExportRequest {
    pub id: String,
    pub dest: String,
    #[serde(default)]
    pub tree: bool,
}

fn person_origin() -> String {
    "person".into()
}

struct Author {
    kind: String,
    id: String,
    name: String,
}

pub(crate) fn ensure_docs_schema(conn: &Connection) -> rusqlite::Result<()> {
    for (name, ddl) in [
        (
            "blocks_json",
            "ALTER TABLE notes ADD COLUMN blocks_json TEXT",
        ),
        ("parent_id", "ALTER TABLE notes ADD COLUMN parent_id TEXT"),
        (
            "sort_order",
            "ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "doc_version",
            "ALTER TABLE notes ADD COLUMN doc_version INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "favourite",
            "ALTER TABLE notes ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "last_opened_at",
            "ALTER TABLE notes ADD COLUMN last_opened_at INTEGER",
        ),
        (
            "trashed_at",
            "ALTER TABLE notes ADD COLUMN trashed_at INTEGER",
        ),
    ] {
        if !has_column(conn, "notes", name)? {
            conn.execute(ddl, [])?;
        }
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS note_versions (
           id TEXT PRIMARY KEY,
           note_id TEXT NOT NULL,
           version INTEGER NOT NULL,
           title TEXT NOT NULL,
           body TEXT NOT NULL,
           blocks_json TEXT,
           kind TEXT NOT NULL,
           author_kind TEXT NOT NULL,
           author_id TEXT NOT NULL,
           author_name TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           UNIQUE(note_id, version)
         );
         CREATE INDEX IF NOT EXISTS note_versions_note_idx
           ON note_versions (note_id, version DESC);
         CREATE TABLE IF NOT EXISTS note_mentions (
           note_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           target_id TEXT NOT NULL,
           name TEXT NOT NULL,
           PRIMARY KEY (note_id, kind, target_id)
         );
         CREATE INDEX IF NOT EXISTS notes_parent_idx
           ON notes (parent_id, sort_order);",
    )?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, name: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        params![name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn has_table(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

#[tauri::command(async)]
pub fn docs_list(store: State<'_, SessionStore>) -> Result<Vec<DocPage>, String> {
    let conn = store.lock_conn()?;
    list_docs(&conn)
}

#[tauri::command(async)]
pub fn docs_get(store: State<'_, SessionStore>, id: String) -> Result<Option<DocPage>, String> {
    validate_id(&id, "page")?;
    let conn = store.lock_conn()?;
    get_doc(&conn, &id)
}

#[tauri::command(async)]
pub fn docs_create(store: State<'_, SessionStore>, page: DocCreate) -> Result<DocWrite, String> {
    let conn = store.lock_conn()?;
    create_doc(&conn, &page)
}

#[tauri::command(async)]
pub fn docs_update(store: State<'_, SessionStore>, page: DocUpdate) -> Result<DocWrite, String> {
    let conn = store.lock_conn()?;
    update_doc(&conn, &page)
}

#[tauri::command(async)]
pub fn docs_adopt(
    store: State<'_, SessionStore>,
    id: String,
    blocks_json: String,
    body: String,
    expected_version: i64,
) -> Result<DocWrite, String> {
    validate_id(&id, "page")?;
    let conn = store.lock_conn()?;
    adopt_blocks(&conn, &id, &blocks_json, &body, expected_version)
}

#[tauri::command(async)]
pub fn docs_move(store: State<'_, SessionStore>, move_page: DocMove) -> Result<DocWrite, String> {
    let conn = store.lock_conn()?;
    move_doc(&conn, &move_page)
}

#[tauri::command(async)]
pub fn docs_versions(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<Vec<DocVersion>, String> {
    validate_id(&id, "page")?;
    let conn = store.lock_conn()?;
    list_versions(&conn, &id)
}

#[tauri::command(async)]
pub fn docs_restore(
    store: State<'_, SessionStore>,
    restore: DocRestore,
) -> Result<DocWrite, String> {
    let conn = store.lock_conn()?;
    restore_doc(&conn, &restore)
}

#[tauri::command(async)]
pub fn docs_favourite(
    store: State<'_, SessionStore>,
    id: String,
    favourite: bool,
) -> Result<DocPage, String> {
    validate_id(&id, "page")?;
    let conn = store.lock_conn()?;
    set_favourite(&conn, &id, favourite)
}

#[tauri::command(async)]
pub fn docs_touch(store: State<'_, SessionStore>, id: String) -> Result<DocPage, String> {
    validate_id(&id, "page")?;
    let conn = store.lock_conn()?;
    touch_doc(&conn, &id)
}

#[tauri::command(async)]
pub fn docs_trash(store: State<'_, SessionStore>, id: String) -> Result<(), String> {
    validate_id(&id, "page")?;
    let conn = store.lock_conn()?;
    trash_doc(&conn, &id)
}

#[tauri::command(async)]
pub fn docs_export(
    store: State<'_, SessionStore>,
    request: DocExportRequest,
) -> Result<Vec<String>, String> {
    validate_id(&request.id, "page")?;
    let conn = store.lock_conn()?;
    export_doc(&conn, &request.id, Path::new(&request.dest), request.tree)
}

#[tauri::command(async)]
pub fn docs_resolve(
    store: State<'_, SessionStore>,
    kind: String,
    target_id: String,
) -> Result<DocResolved, String> {
    let conn = store.lock_conn()?;
    Ok(resolve_mention(&conn, &kind, &target_id))
}

pub(crate) fn list_docs(conn: &Connection) -> Result<Vec<DocPage>, String> {
    let sql = format!(
        "SELECT {PAGE_COLUMNS} FROM notes
         WHERE content_kind = 'note' AND trashed_at IS NULL
         ORDER BY sort_order, title, id"
    );
    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], read_page)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn get_doc(conn: &Connection, id: &str) -> Result<Option<DocPage>, String> {
    let sql = format!("SELECT {PAGE_COLUMNS} FROM notes WHERE id = ?1 AND content_kind = 'note'");
    conn.query_row(&sql, params![id], read_page)
        .optional()
        .map_err(|e| e.to_string())
}

fn read_page(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocPage> {
    let tags_json: String = row.get(8)?;
    let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
    let favourite: i64 = row.get(11)?;
    Ok(DocPage {
        id: row.get(0)?,
        slug: row.get(1)?,
        title: row.get(2)?,
        body: row.get(3)?,
        blocks_json: row.get(4)?,
        parent_id: row.get(5)?,
        sort_order: row.get(6)?,
        version: row.get(7)?,
        tags,
        source_cwd: row.get(9)?,
        source_session_id: row.get(10)?,
        favourite: favourite != 0,
        last_opened_at: row.get(12)?,
        trashed_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

pub(crate) fn create_doc(conn: &Connection, input: &DocCreate) -> Result<DocWrite, String> {
    validate_id(&input.id, "page")?;
    let author = author_of(&input.origin, &input.author_id, &input.author_name)?;
    let body = normalize_body(&input.body)?;
    let blocks = checked_blocks(&input.blocks_json)?;
    let title = normalize_title(&input.title);
    let blank = input.title.trim().is_empty() && body.trim().is_empty();
    if let Some(parent) = input.parent_id.as_deref() {
        validate_id(parent, "page")?;
        require_parent(conn, parent)?;
        if parent_chain_loops(conn, parent)? {
            return Err("This page tree has a cycle".into());
        }
    }
    if let Some(session) = input
        .source_session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        validate_id(session, "session")?;
    }
    if let Some(existing) = get_doc(conn, &input.id)? {
        if existing.title == title && existing.body == body {
            return Ok(saved(existing, Vec::new()));
        }
        return Err("This page already exists".into());
    }
    let tags = normalize_tags(&input.tags);
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    let source_cwd = clean_cwd(input.source_cwd.as_deref());
    let source_session = input
        .source_session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let now = now_millis();
    let slug = unique_slug(conn, &title).map_err(|e| e.to_string())?;
    let sort_order = next_sort(conn, input.parent_id.as_deref())?;
    let version = if blank { 0 } else { 1 };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO notes (
           id, slug, title, body, tags_json, source_session_id, source_cwd,
           created_at, updated_at, slug_pending, content_kind,
           blocks_json, parent_id, sort_order, doc_version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 'note', ?10, ?11, ?12, ?13)",
        params![
            input.id,
            slug,
            title,
            body,
            tags_json,
            source_session,
            source_cwd,
            now,
            now,
            blocks,
            input.parent_id,
            sort_order,
            version
        ],
    )
    .map_err(|e| e.to_string())?;
    if !blank {
        insert_version(
            &tx,
            &VersionWrite {
                note_id: &input.id,
                title: &title,
                body: &body,
                blocks: blocks.as_deref(),
                kind: version_kind(&author),
                author: &author,
                now,
            },
        )?;
    }
    let new_mentions = replace_mentions(&tx, &input.id, blocks.as_deref())?;
    tx.commit().map_err(|e| e.to_string())?;
    let page = get_doc(conn, &input.id)?.ok_or_else(|| "Page was not found".to_string())?;
    Ok(saved(page, new_mentions))
}

pub(crate) fn update_doc(conn: &Connection, input: &DocUpdate) -> Result<DocWrite, String> {
    validate_id(&input.id, "page")?;
    let author = author_of(&input.origin, &input.author_id, &input.author_name)?;
    let body = normalize_body(&input.body)?;
    let blocks = checked_blocks(&input.blocks_json)?;
    let title = normalize_title(&input.title);
    let blank = input.title.trim().is_empty() && body.trim().is_empty();
    let current = get_doc(conn, &input.id)?.ok_or_else(|| "Page was not found".to_string())?;
    if current.version != input.expected_version {
        return Ok(DocWrite::Conflict {
            version: current.version,
        });
    }
    let tags = match &input.tags {
        Some(tags) => normalize_tags(tags),
        None => current.tags.clone(),
    };
    let same = current.title == title
        && current.body == body
        && tags == current.tags
        && same_blocks(current.blocks_json.as_deref(), blocks.as_deref());
    // The row can already hold this text (a keystroke save) while the newest
    // version is still older. Idle and agent saves still record it.
    if same {
        if input.snapshot && !blank {
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let newest = newest_version(&tx, &input.id)?;
            if !same_as_newest(&title, &body, blocks.as_deref(), newest.as_ref()) {
                insert_version(
                    &tx,
                    &VersionWrite {
                        note_id: &input.id,
                        title: &title,
                        body: &body,
                        blocks: blocks.as_deref(),
                        kind: version_kind(&author),
                        author: &author,
                        now: now_millis(),
                    },
                )?;
                tx.commit().map_err(|e| e.to_string())?;
            }
        }
        let page = get_doc(conn, &input.id)?.ok_or_else(|| "Page was not found".to_string())?;
        return Ok(saved(page, Vec::new()));
    }
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    let now = now_millis();
    let newest = newest_version(conn, &input.id)?;
    let store_version = input.snapshot
        && !blank
        && !same_as_newest(&title, &body, blocks.as_deref(), newest.as_ref());
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx
        .execute(
            "UPDATE notes
             SET title = ?1, body = ?2, blocks_json = ?3, tags_json = ?4,
                 doc_version = doc_version + 1, updated_at = ?5
             WHERE id = ?6 AND doc_version = ?7 AND content_kind = 'note'",
            params![
                title,
                body,
                blocks,
                tags_json,
                now,
                input.id,
                input.expected_version
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        let version = get_doc(&tx, &input.id)?
            .map(|page| page.version)
            .unwrap_or(input.expected_version);
        return Ok(DocWrite::Conflict { version });
    }
    if store_version {
        insert_version(
            &tx,
            &VersionWrite {
                note_id: &input.id,
                title: &title,
                body: &body,
                blocks: blocks.as_deref(),
                kind: version_kind(&author),
                author: &author,
                now,
            },
        )?;
    }
    let new_mentions = replace_mentions(&tx, &input.id, blocks.as_deref())?;
    tx.commit().map_err(|e| e.to_string())?;
    let page = get_doc(conn, &input.id)?.ok_or_else(|| "Page was not found".to_string())?;
    Ok(saved(page, new_mentions))
}

pub(crate) fn adopt_blocks(
    conn: &Connection,
    id: &str,
    blocks_json: &str,
    body: &str,
    expected_version: i64,
) -> Result<DocWrite, String> {
    let blocks = checked_blocks(&Some(blocks_json.to_string()))?;
    let current = get_doc(conn, id)?.ok_or_else(|| "Page was not found".to_string())?;
    if current.blocks_json.is_some() {
        return Ok(saved(current, Vec::new()));
    }
    if current.body != body {
        return Err("The page changed before it could be converted".into());
    }
    if current.version != expected_version {
        return Ok(DocWrite::Conflict {
            version: current.version,
        });
    }
    let now = now_millis();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx
        .execute(
            "UPDATE notes
             SET blocks_json = ?1, doc_version = doc_version + 1, updated_at = ?2
             WHERE id = ?3 AND blocks_json IS NULL AND body = ?4 AND doc_version = ?5
               AND content_kind = 'note'",
            params![blocks, now, id, body, expected_version],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        let page = get_doc(&tx, id)?;
        if page
            .as_ref()
            .and_then(|page| page.blocks_json.as_ref())
            .is_some()
        {
            return Ok(saved(page.unwrap(), Vec::new()));
        }
        let version = page.map(|page| page.version).unwrap_or(expected_version);
        return Ok(DocWrite::Conflict { version });
    }
    let new_mentions = replace_mentions(&tx, id, blocks.as_deref())?;
    tx.commit().map_err(|e| e.to_string())?;
    let page = get_doc(conn, id)?.ok_or_else(|| "Page was not found".to_string())?;
    Ok(saved(page, new_mentions))
}

pub(crate) fn move_doc(conn: &Connection, input: &DocMove) -> Result<DocWrite, String> {
    validate_id(&input.id, "page")?;
    if let Some(parent) = input.parent_id.as_deref() {
        validate_id(parent, "page")?;
        if parent == input.id {
            return Err("A page cannot move into itself".into());
        }
        require_parent(conn, parent)?;
    }
    let current = get_doc(conn, &input.id)?.ok_or_else(|| "Page was not found".to_string())?;
    if current.trashed_at.is_some() {
        return Err("Page was not found".into());
    }
    if current.version != input.expected_version {
        return Ok(DocWrite::Conflict {
            version: current.version,
        });
    }
    if let Some(parent) = input.parent_id.as_deref() {
        if would_cycle(conn, &input.id, parent)? {
            return Err("A page cannot move into itself".into());
        }
    }
    // The caller's sibling list is the order it decided against. If a page has
    // moved since, applying that order would rewrite the wrong parent.
    let fresh = sibling_ids(conn, input.parent_id.as_deref(), &input.id)?;
    if fresh != input.sibling_ids {
        return Ok(DocWrite::Conflict {
            version: current.version,
        });
    }
    let mut siblings = fresh;
    let index = input.index.max(0) as usize;
    let index = index.min(siblings.len());
    siblings.insert(index, input.id.clone());
    let unchanged = current.parent_id.as_deref() == input.parent_id.as_deref()
        && sibling_ids(conn, current.parent_id.as_deref(), "")?
            .into_iter()
            .position(|id| id == input.id)
            == Some(index);
    if unchanged {
        return Ok(saved(current, Vec::new()));
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let again = sibling_ids(&tx, input.parent_id.as_deref(), &input.id)?;
    if again != input.sibling_ids {
        return Ok(DocWrite::Conflict {
            version: current.version,
        });
    }
    let changed = tx
        .execute(
            "UPDATE notes
             SET parent_id = ?1, sort_order = ?2, doc_version = doc_version + 1
             WHERE id = ?3 AND doc_version = ?4 AND content_kind = 'note' AND trashed_at IS NULL",
            params![
                input.parent_id,
                index as i64,
                input.id,
                input.expected_version
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        let version = get_doc(&tx, &input.id)?
            .map(|page| page.version)
            .unwrap_or(input.expected_version);
        return Ok(DocWrite::Conflict { version });
    }
    for (order, id) in siblings.iter().enumerate() {
        if id == &input.id {
            continue;
        }
        // Only a page that is still under this parent. A row that moved is a conflict,
        // and the move above is rolled back with the transaction.
        let updated = match input.parent_id.as_deref() {
            Some(parent) => tx.execute(
                "UPDATE notes SET sort_order = ?1
                 WHERE id = ?2 AND parent_id = ?3 AND content_kind = 'note' AND trashed_at IS NULL",
                params![order as i64, id, parent],
            ),
            None => tx.execute(
                "UPDATE notes SET sort_order = ?1
                 WHERE id = ?2 AND parent_id IS NULL AND content_kind = 'note' AND trashed_at IS NULL",
                params![order as i64, id],
            ),
        }
        .map_err(|e| e.to_string())?;
        if updated == 0 {
            let version = get_doc(&tx, &input.id)?
                .map(|page| page.version)
                .unwrap_or(input.expected_version);
            return Ok(DocWrite::Conflict { version });
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    let page = get_doc(conn, &input.id)?.ok_or_else(|| "Page was not found".to_string())?;
    Ok(saved(page, Vec::new()))
}

pub(crate) fn list_versions(conn: &Connection, id: &str) -> Result<Vec<DocVersion>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, note_id, version, title, body, blocks_json, kind, author_kind, author_id, author_name, created_at
             FROM note_versions WHERE note_id = ?1 ORDER BY version DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![id], |row| {
            Ok(DocVersion {
                id: row.get(0)?,
                note_id: row.get(1)?,
                version: row.get(2)?,
                title: row.get(3)?,
                body: row.get(4)?,
                blocks_json: row.get(5)?,
                kind: row.get(6)?,
                author_kind: row.get(7)?,
                author_id: row.get(8)?,
                author_name: row.get(9)?,
                created_at: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn restore_doc(conn: &Connection, input: &DocRestore) -> Result<DocWrite, String> {
    validate_id(&input.id, "page")?;
    let author = author_of("person", &input.author_id, &input.author_name)?;
    let current = get_doc(conn, &input.id)?.ok_or_else(|| "Page was not found".to_string())?;
    if current.version != input.expected_version {
        return Ok(DocWrite::Conflict {
            version: current.version,
        });
    }
    let restored = version_by_number(conn, &input.id, input.version)?
        .ok_or_else(|| "That version was not found".to_string())?;
    let newest = newest_version(conn, &input.id)?;
    let current_blank = current.title.trim().is_empty() && current.body.trim().is_empty();
    let same_as_restored = same_state(
        &current.title,
        &current.body,
        current.blocks_json.as_deref(),
        &restored.title,
        &restored.body,
        restored.blocks_json.as_deref(),
    );
    let same_as_newest = match &newest {
        Some(newest) => same_state(
            &current.title,
            &current.body,
            current.blocks_json.as_deref(),
            &newest.title,
            &newest.body,
            newest.blocks_json.as_deref(),
        ),
        None => false,
    };
    if same_as_restored {
        return Ok(saved(current, Vec::new()));
    }
    let keep_current = !current_blank && !same_as_newest;
    let now = now_millis();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if keep_current {
        insert_version(
            &tx,
            &VersionWrite {
                note_id: &input.id,
                title: &current.title,
                body: &current.body,
                blocks: current.blocks_json.as_deref(),
                kind: "auto",
                author: &author,
                now,
            },
        )?;
    }
    insert_version(
        &tx,
        &VersionWrite {
            note_id: &input.id,
            title: &restored.title,
            body: &restored.body,
            blocks: restored.blocks_json.as_deref(),
            kind: "restore",
            author: &author,
            now,
        },
    )?;
    let changed = tx
        .execute(
            "UPDATE notes
             SET title = ?1, body = ?2, blocks_json = ?3,
                 doc_version = doc_version + 1, updated_at = ?4
             WHERE id = ?5 AND doc_version = ?6 AND content_kind = 'note'",
            params![
                restored.title,
                restored.body,
                restored.blocks_json,
                now,
                input.id,
                input.expected_version
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        let version = get_doc(&tx, &input.id)?
            .map(|page| page.version)
            .unwrap_or(input.expected_version);
        return Ok(DocWrite::Conflict { version });
    }
    let new_mentions = replace_mentions(&tx, &input.id, restored.blocks_json.as_deref())?;
    tx.commit().map_err(|e| e.to_string())?;
    let page = get_doc(conn, &input.id)?.ok_or_else(|| "Page was not found".to_string())?;
    Ok(saved(page, new_mentions))
}

pub(crate) fn set_favourite(
    conn: &Connection,
    id: &str,
    favourite: bool,
) -> Result<DocPage, String> {
    let changed = conn
        .execute(
            "UPDATE notes SET favourite = ?1 WHERE id = ?2 AND content_kind = 'note'",
            params![i64::from(favourite), id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Page was not found".into());
    }
    get_doc(conn, id)?.ok_or_else(|| "Page was not found".to_string())
}

pub(crate) fn touch_doc(conn: &Connection, id: &str) -> Result<DocPage, String> {
    let changed = conn
        .execute(
            "UPDATE notes SET last_opened_at = ?1 WHERE id = ?2 AND content_kind = 'note'",
            params![now_millis(), id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Page was not found".into());
    }
    get_doc(conn, id)?.ok_or_else(|| "Page was not found".to_string())
}

pub(crate) fn trash_doc(conn: &Connection, id: &str) -> Result<(), String> {
    if get_doc(conn, id)?.is_none() {
        return Err("Page was not found".into());
    }
    let now = now_millis();
    for page_id in subtree(conn, id)? {
        conn.execute(
            "UPDATE notes SET trashed_at = ?1 WHERE id = ?2 AND trashed_at IS NULL",
            params![now, page_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn export_doc(
    conn: &Connection,
    id: &str,
    dest: &Path,
    tree: bool,
) -> Result<Vec<String>, String> {
    let root = canonical(dest).map_err(|_| "Choose a folder that exists".to_string())?;
    if !root.is_dir() {
        return Err("Choose a folder that exists".into());
    }
    let pages = all_docs(conn)?;
    let by_id: std::collections::HashMap<&str, &DocPage> =
        pages.iter().map(|page| (page.id.as_str(), page)).collect();
    let page = by_id
        .get(id)
        .copied()
        .ok_or_else(|| "Page was not found".to_string())?;
    if page.trashed_at.is_some() {
        return Err("Page was not found".into());
    }
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut job = ExportJob {
        root: &root,
        by_id: &by_id,
        tree,
        seen: &mut seen,
        files: &mut files,
    };
    write_export(&mut job, page, "", true)?;
    Ok(files)
}

struct ExportJob<'a> {
    root: &'a Path,
    by_id: &'a std::collections::HashMap<&'a str, &'a DocPage>,
    tree: bool,
    seen: &'a mut HashSet<String>,
    files: &'a mut Vec<String>,
}

fn write_export(
    job: &mut ExportJob<'_>,
    page: &DocPage,
    directory: &str,
    is_root: bool,
) -> Result<(), String> {
    if !job.seen.insert(page.id.clone()) {
        return Ok(());
    }
    let slug = safe_slug(&page.slug)?;
    let kids: Vec<&DocPage> = job
        .by_id
        .values()
        .filter(|child| {
            child.parent_id.as_deref() == Some(page.id.as_str()) && child.trashed_at.is_none()
        })
        .copied()
        .collect();
    let nested = job.tree && (is_root || !kids.is_empty());
    let relative = if nested {
        format!("{directory}{slug}/index.md")
    } else {
        format!("{directory}{slug}.md")
    };
    let path = place_file(job.root, &relative)?;
    write_page_file(&path, &page_markdown(page))?;
    job.files.push(relative);
    if !job.tree {
        return Ok(());
    }
    let mut kids = kids;
    kids.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then(a.id.cmp(&b.id)));
    let child_dir = format!("{directory}{slug}/");
    for child in kids {
        write_export(job, child, &child_dir, false)?;
    }
    Ok(())
}

fn page_markdown(page: &DocPage) -> String {
    let title = page.title.replace(['\n', '\r'], " ").trim().to_string();
    let body = page.body.replace("\r\n", "\n").replace('\r', "\n");
    if title.is_empty() {
        return body;
    }
    if body.trim().is_empty() {
        format!("# {title}\n")
    } else {
        format!("# {title}\n\n{body}")
    }
}

fn place_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() || relative.contains('\\') || relative.contains(':') {
        return Err("This page has no safe file name".into());
    }
    let rel = Path::new(relative);
    for component in rel.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_string_lossy();
                if text == "." || text == ".." || text.contains('/') || text.contains('\\') {
                    return Err("This page has no safe file name".into());
                }
            }
            _ => return Err("This page has no safe file name".into()),
        }
    }
    let full = root.join(rel);
    let parent = full
        .parent()
        .ok_or_else(|| "This page has no safe file name".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let parent_canon = canonical(parent).map_err(|e| e.to_string())?;
    if !parent_canon.starts_with(root) {
        return Err("This page has no safe file name".into());
    }
    Ok(full)
}

/// Writes the page without following a symlink at the destination. A link
/// whose target sits outside the folder must not be overwritten.
fn write_page_file(path: &Path, contents: &str) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("This page has no safe file name".into());
    }
    write_nofollow(path, contents)
}

#[cfg(unix)]
fn write_nofollow(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "This page has no safe file name".to_string())?;
    file.write_all(contents.as_bytes())
        .map_err(|_| "This page has no safe file name".to_string())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_nofollow(path: &Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|_| "This page has no safe file name".to_string())
}

fn safe_slug(slug: &str) -> Result<&str, String> {
    let mut parts = slug.split('-');
    let Some(first) = parts.next() else {
        return Err("This page has no safe file name".into());
    };
    let ok = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    };
    if ok(first) && parts.all(ok) {
        Ok(slug)
    } else {
        Err("This page has no safe file name".into())
    }
}

fn all_docs(conn: &Connection) -> Result<Vec<DocPage>, String> {
    let sql = format!("SELECT {PAGE_COLUMNS} FROM notes WHERE content_kind = 'note'");
    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], read_page)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn resolve_mention(conn: &Connection, kind: &str, target_id: &str) -> DocResolved {
    let missing = |name: &str| DocResolved {
        found: false,
        kind: kind.to_string(),
        target_id: target_id.to_string(),
        name: name.to_string(),
    };
    if validate_id(target_id, "mention").is_err() {
        return missing(target_id);
    }
    match kind {
        "page" => page_target(conn, target_id).unwrap_or_else(|| missing(target_id)),
        "chat" => chat_target(conn, target_id).unwrap_or_else(|| missing(target_id)),
        "task" => task_target(conn, target_id).unwrap_or_else(|| missing(target_id)),
        "mono" => missing(target_id),
        _ => missing(target_id),
    }
}

fn page_target(conn: &Connection, target_id: &str) -> Option<DocResolved> {
    conn.query_row(
        "SELECT id, title FROM notes
         WHERE content_kind = 'note' AND trashed_at IS NULL AND (id = ?1 OR slug = ?1)
         ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END
         LIMIT 1",
        params![target_id],
        |row| {
            Ok(DocResolved {
                found: true,
                kind: "page".into(),
                target_id: row.get(0)?,
                name: row.get(1)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn chat_target(conn: &Connection, target_id: &str) -> Option<DocResolved> {
    let title: String = conn
        .query_row(
            "SELECT title FROM sessions WHERE id = ?1",
            params![target_id],
            |row| row.get(0),
        )
        .ok()?;
    Some(DocResolved {
        found: true,
        kind: "chat".into(),
        target_id: target_id.to_string(),
        name: if title.trim().is_empty() {
            target_id.to_string()
        } else {
            title
        },
    })
}

fn task_target(conn: &Connection, target_id: &str) -> Option<DocResolved> {
    // WP-70 owns tasks. Until that table exists, a task mention is not found,
    // and that is not a failure.
    if !has_table(conn, "tasks").ok()? {
        return None;
    }
    let title: String = conn
        .query_row(
            "SELECT title FROM tasks WHERE id = ?1",
            params![target_id],
            |row| row.get(0),
        )
        .ok()?;
    Some(DocResolved {
        found: true,
        kind: "task".into(),
        target_id: target_id.to_string(),
        name: title,
    })
}

fn saved(page: DocPage, new_mentions: Vec<DocMention>) -> DocWrite {
    DocWrite::Saved {
        page: Box::new(page),
        new_mentions,
    }
}

fn author_of(origin: &str, id: &str, name: &str) -> Result<Author, String> {
    if origin != "person" && origin != "agent" {
        return Err("Unknown author".into());
    }
    let id = {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            origin.to_string()
        } else {
            trimmed.chars().take(128).collect()
        }
    };
    let name = {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            origin.to_string()
        } else {
            trimmed.chars().take(200).collect()
        }
    };
    Ok(Author {
        kind: origin.to_string(),
        id,
        name,
    })
}

fn normalize_title(title: &str) -> String {
    let sliced: String = title.trim().chars().take(TITLE_MAX).collect();
    let sliced = sliced.trim().to_string();
    if sliced.is_empty() {
        "Untitled".into()
    } else {
        sliced
    }
}

fn normalize_body(body: &str) -> Result<String, String> {
    if body.len() > BODY_MAX {
        return Err("This page is too large".into());
    }
    Ok(body.replace("\r\n", "\n").replace('\r', "\n"))
}

fn checked_blocks(raw: &Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.len() > BLOCKS_MAX {
        return Err("This page is too large".into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "Blocks are not valid".to_string())?;
    if !value.is_array() {
        return Err("Blocks are not valid".into());
    }
    Ok(Some(raw.clone()))
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for tag in tags {
        let tag: String = tag
            .trim()
            .trim_start_matches('#')
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-")
            .to_lowercase()
            .chars()
            .take(48)
            .collect();
        let tag = tag.trim_end_matches('-').to_string();
        if tag.is_empty() || out.contains(&tag) {
            continue;
        }
        out.push(tag);
        if out.len() == 20 {
            break;
        }
    }
    out
}

fn clean_cwd(cwd: Option<&str>) -> Option<String> {
    cwd.map(str::trim)
        .filter(|cwd| !cwd.is_empty() && cwd.len() <= 1024)
        .map(str::to_string)
}

fn require_parent(conn: &Connection, id: &str) -> Result<(), String> {
    let page = get_doc(conn, id)?.ok_or_else(|| "That page was not found".to_string())?;
    if page.trashed_at.is_some() {
        return Err("That page was not found".into());
    }
    Ok(())
}

fn parent_chain_loops(conn: &Connection, start: &str) -> Result<bool, String> {
    let mut seen = HashSet::new();
    let mut cursor = Some(start.to_string());
    while let Some(id) = cursor {
        if !seen.insert(id.clone()) {
            return Ok(true);
        }
        cursor = parent_of(conn, &id)?;
    }
    Ok(false)
}

fn would_cycle(conn: &Connection, id: &str, new_parent: &str) -> Result<bool, String> {
    let mut seen = HashSet::new();
    let mut cursor = Some(new_parent.to_string());
    while let Some(current) = cursor {
        if current == id {
            return Ok(true);
        }
        if !seen.insert(current.clone()) {
            return Ok(true);
        }
        cursor = parent_of(conn, &current)?;
    }
    Ok(false)
}

fn parent_of(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT parent_id FROM notes WHERE id = ?1 AND content_kind = 'note'",
        params![id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|parent| parent.flatten())
}

fn next_sort(conn: &Connection, parent: Option<&str>) -> Result<i64, String> {
    let sql = match parent {
        Some(_) => "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM notes WHERE parent_id = ?1 AND content_kind = 'note'",
        None => "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM notes WHERE parent_id IS NULL AND content_kind = 'note'",
    };
    let value = if let Some(parent) = parent {
        conn.query_row(sql, params![parent], |row| row.get(0))
    } else {
        conn.query_row(sql, [], |row| row.get(0))
    };
    value.map_err(|e| e.to_string())
}

fn sibling_ids(
    conn: &Connection,
    parent: Option<&str>,
    except: &str,
) -> Result<Vec<String>, String> {
    if let Some(parent) = parent {
        let mut statement = conn
            .prepare(
                "SELECT id FROM notes
                 WHERE parent_id = ?1 AND content_kind = 'note' AND trashed_at IS NULL AND id != ?2
                 ORDER BY sort_order, id",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![parent, except], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        return rows
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string());
    }
    let mut statement = conn
        .prepare(
            "SELECT id FROM notes
             WHERE parent_id IS NULL AND content_kind = 'note' AND trashed_at IS NULL AND id != ?1
             ORDER BY sort_order, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![except], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())
}

fn subtree(conn: &Connection, root: &str) -> Result<Vec<String>, String> {
    let mut out = vec![root.to_string()];
    let mut seen = HashSet::from([root.to_string()]);
    let mut index = 0;
    while index < out.len() {
        let id = out[index].clone();
        index += 1;
        let mut statement = conn
            .prepare("SELECT id FROM notes WHERE parent_id = ?1 AND content_kind = 'note'")
            .map_err(|e| e.to_string())?;
        let kids = statement
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for kid in kids {
            if seen.insert(kid.clone()) {
                out.push(kid);
            }
        }
    }
    Ok(out)
}

struct VersionWrite<'a> {
    note_id: &'a str,
    title: &'a str,
    body: &'a str,
    blocks: Option<&'a str>,
    kind: &'a str,
    author: &'a Author,
    now: i64,
}

fn version_kind(author: &Author) -> &'static str {
    if author.kind == "agent" {
        "agent"
    } else {
        "auto"
    }
}

fn insert_version(conn: &Connection, version: &VersionWrite<'_>) -> Result<(), String> {
    let number: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM note_versions WHERE note_id = ?1",
            params![version.note_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO note_versions (
           id, note_id, version, title, body, blocks_json, kind, author_kind, author_id, author_name, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            uuid::Uuid::new_v4().to_string(),
            version.note_id,
            number,
            version.title,
            version.body,
            version.blocks,
            version.kind,
            version.author.kind,
            version.author.id,
            version.author.name,
            version.now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn newest_version(conn: &Connection, note_id: &str) -> Result<Option<DocVersion>, String> {
    list_versions(conn, note_id).map(|versions| versions.into_iter().next())
}

fn version_by_number(
    conn: &Connection,
    note_id: &str,
    version: i64,
) -> Result<Option<DocVersion>, String> {
    list_versions(conn, note_id)
        .map(|versions| versions.into_iter().find(|row| row.version == version))
}

/// Keeps the row's text as a version before Notes replaces it. A blank page,
/// and text that is already the newest version, are left alone.
pub(crate) fn keep_note_text(conn: &Connection, id: &str) -> Result<(), String> {
    let Some(page) = get_doc(conn, id)? else {
        return Ok(());
    };
    let blank =
        page.body.trim().is_empty() && (page.title.trim().is_empty() || page.title == "Untitled");
    if blank {
        return Ok(());
    }
    let newest = newest_version(conn, id)?;
    if same_as_newest(
        &page.title,
        &page.body,
        page.blocks_json.as_deref(),
        newest.as_ref(),
    ) {
        return Ok(());
    }
    let author = author_of("person", "notes", "Notes")?;
    insert_version(
        conn,
        &VersionWrite {
            note_id: id,
            title: &page.title,
            body: &page.body,
            blocks: page.blocks_json.as_deref(),
            kind: "auto",
            author: &author,
            now: now_millis(),
        },
    )
}

fn same_as_newest(
    title: &str,
    body: &str,
    blocks: Option<&str>,
    newest: Option<&DocVersion>,
) -> bool {
    match newest {
        Some(newest) => same_state(
            title,
            body,
            blocks,
            &newest.title,
            &newest.body,
            newest.blocks_json.as_deref(),
        ),
        None => false,
    }
}

fn same_state(
    title: &str,
    body: &str,
    blocks: Option<&str>,
    other_title: &str,
    other_body: &str,
    other_blocks: Option<&str>,
) -> bool {
    if title != other_title || body != other_body {
        return false;
    }
    match (canonical_blocks(blocks), canonical_blocks(other_blocks)) {
        (Some(left), Some(right)) => left == right,
        // Missing blocks still match when the Markdown does. Ids are ignored.
        _ => true,
    }
}

fn same_blocks(left: Option<&str>, right: Option<&str>) -> bool {
    match (canonical_blocks(left), canonical_blocks(right)) {
        (Some(left), Some(right)) => left == right,
        (None, None) => true,
        _ => false,
    }
}

fn canonical_blocks(raw: Option<&str>) -> Option<Value> {
    let mut value: Value = serde_json::from_str(raw?).ok()?;
    strip_ids(&mut value);
    Some(value)
}

fn strip_ids(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                strip_ids(item);
            }
        }
        Value::Object(map) => {
            map.remove("id");
            for child in map.values_mut() {
                strip_ids(child);
            }
        }
        _ => {}
    }
}

fn replace_mentions(
    conn: &Connection,
    note_id: &str,
    blocks: Option<&str>,
) -> Result<Vec<DocMention>, String> {
    let before = stored_mentions(conn, note_id)?;
    conn.execute(
        "DELETE FROM note_mentions WHERE note_id = ?1",
        params![note_id],
    )
    .map_err(|e| e.to_string())?;
    let after = mentions_in(blocks);
    for mention in &after {
        conn.execute(
            "INSERT INTO note_mentions (note_id, kind, target_id, name) VALUES (?1, ?2, ?3, ?4)",
            params![note_id, mention.kind, mention.target_id, mention.name],
        )
        .map_err(|e| e.to_string())?;
    }
    let had: HashSet<(String, String)> = before
        .into_iter()
        .map(|mention| (mention.kind, mention.target_id))
        .collect();
    Ok(after
        .into_iter()
        .filter(|mention| !had.contains(&(mention.kind.clone(), mention.target_id.clone())))
        .collect())
}

fn stored_mentions(conn: &Connection, note_id: &str) -> Result<Vec<DocMention>, String> {
    let mut statement = conn
        .prepare("SELECT kind, target_id, name FROM note_mentions WHERE note_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![note_id], |row| {
            Ok(DocMention {
                kind: row.get(0)?,
                target_id: row.get(1)?,
                name: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn mentions_in(blocks: Option<&str>) -> Vec<DocMention> {
    let Some(raw) = blocks else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    walk_mentions(&value, &mut found);
    let mut seen = HashSet::new();
    found.retain(|mention| seen.insert((mention.kind.clone(), mention.target_id.clone())));
    found
}

fn walk_mentions(value: &Value, out: &mut Vec<DocMention>) {
    match value {
        Value::Array(items) => {
            for item in items {
                walk_mentions(item, out);
            }
        }
        Value::Object(map) => {
            match map.get("type").and_then(Value::as_str) {
                Some("mention") => {
                    if let Some(mention) = mention_from(map) {
                        out.push(mention);
                    }
                }
                Some("page") => {
                    if let Some(id) = map
                        .get("props")
                        .and_then(|props| props.get("pageId"))
                        .and_then(Value::as_str)
                    {
                        if let Some(mention) = checked_mention("page", id, id) {
                            out.push(mention);
                        }
                    }
                }
                _ => {}
            }
            for child in map.values() {
                walk_mentions(child, out);
            }
        }
        _ => {}
    }
}

fn mention_from(map: &serde_json::Map<String, Value>) -> Option<DocMention> {
    let props = map.get("props")?;
    let kind = props.get("kind").and_then(Value::as_str)?;
    let target = props.get("targetId").and_then(Value::as_str)?;
    let name = props.get("name").and_then(Value::as_str).unwrap_or(target);
    checked_mention(kind, target, name)
}

fn checked_mention(kind: &str, target: &str, name: &str) -> Option<DocMention> {
    if !matches!(kind, "page" | "task" | "chat" | "mono") {
        return None;
    }
    if validate_id(target, "mention").is_err() {
        return None;
    }
    let name = name.trim();
    let name = if name.is_empty() { target } else { name };
    Some(DocMention {
        kind: kind.to_string(),
        target_id: target.to_string(),
        name: name.chars().take(200).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::notes::ensure_notes_table(&conn).unwrap();
        conn
    }

    fn page(title: &str, body: &str) -> DocCreate {
        DocCreate {
            id: "page-1".into(),
            title: title.into(),
            body: body.into(),
            blocks_json: Some("[]".into()),
            tags: Vec::new(),
            source_cwd: None,
            source_session_id: None,
            parent_id: None,
            origin: "person".into(),
            author_id: "ash".into(),
            author_name: "Ash".into(),
        }
    }

    fn saved_page(write: DocWrite) -> DocPage {
        match write {
            DocWrite::Saved { page, .. } => *page,
            DocWrite::Conflict { version } => panic!("conflict at {version}"),
        }
    }

    #[test]
    fn old_notes_gain_doc_columns_and_keep_their_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
               id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
               body TEXT NOT NULL DEFAULT '', source_session_id TEXT, source_cwd TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
             );
             INSERT INTO notes VALUES ('old', 'personal', 'Personal', 'Kept', NULL, NULL, 1, 2);",
        )
        .unwrap();
        ensure_docs_schema(&conn).unwrap();
        ensure_docs_schema(&conn).unwrap();
        let body: String = conn
            .query_row("SELECT body FROM notes WHERE id = 'old'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(body, "Kept");
        let blocks: Option<String> = conn
            .query_row(
                "SELECT blocks_json FROM notes WHERE id = 'old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(blocks.is_none());
    }

    #[test]
    fn a_blank_page_has_no_version_and_text_stores_one() {
        let conn = memory();
        let blank = saved_page(create_doc(&conn, &page("", "")).unwrap());
        assert_eq!(blank.version, 0);
        assert!(list_versions(&conn, "page-1").unwrap().is_empty());
        let written = saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    id: "page-2".into(),
                    title: "Plan".into(),
                    body: "Hello".into(),
                    ..page("", "")
                },
            )
            .unwrap(),
        );
        assert_eq!(written.version, 1);
        let versions = list_versions(&conn, "page-2").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].kind, "auto");
        assert_eq!(versions[0].author_name, "Ash");
    }

    #[test]
    fn a_stale_write_does_not_overwrite_and_a_duplicate_is_not_a_new_version() {
        let conn = memory();
        let created = saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    body: "one".into(),
                    blocks_json: Some(r#"[{"id":"a","type":"paragraph"}]"#.into()),
                    ..page("Plan", "one")
                },
            )
            .unwrap(),
        );
        let conflict = update_doc(
            &conn,
            &DocUpdate {
                id: "page-1".into(),
                title: "Plan".into(),
                body: "stolen".into(),
                blocks_json: Some("[]".into()),
                expected_version: created.version - 1,
                snapshot: true,
                origin: "person".into(),
                author_id: "ash".into(),
                author_name: "Ash".into(),
                tags: None,
            },
        )
        .unwrap();
        assert!(matches!(conflict, DocWrite::Conflict { version } if version == created.version));
        assert_eq!(get_doc(&conn, "page-1").unwrap().unwrap().body, "one");

        let typed = saved_page(update_doc(
            &conn,
            &DocUpdate {
                id: "page-1".into(),
                title: "Plan".into(),
                body: "two".into(),
                blocks_json: Some(r#"[{"id":"b","type":"paragraph","content":[{"type":"text","text":"two"}]}]"#.into()),
                expected_version: created.version,
                snapshot: false,
                origin: "person".into(),
                author_id: "ash".into(),
                author_name: "Ash".into(),
                tags: None,
            },
        )
        .unwrap());
        assert_eq!(list_versions(&conn, "page-1").unwrap().len(), 1);

        let idle = saved_page(update_doc(
            &conn,
            &DocUpdate {
                id: "page-1".into(),
                title: "Plan".into(),
                body: "two".into(),
                blocks_json: Some(r#"[{"id":"c","type":"paragraph","content":[{"type":"text","text":"two"}]}]"#.into()),
                expected_version: typed.version,
                snapshot: true,
                origin: "person".into(),
                author_id: "ash".into(),
                author_name: "Ash".into(),
                tags: None,
            },
        )
        .unwrap());
        assert_eq!(list_versions(&conn, "page-1").unwrap()[0].kind, "auto");

        let again = update_doc(
            &conn,
            &DocUpdate {
                id: "page-1".into(),
                title: "Plan".into(),
                body: "two".into(),
                blocks_json: Some(
                    r#"[{"id":"d","type":"paragraph","content":[{"type":"text","text":"two"}]}]"#
                        .into(),
                ),
                expected_version: idle.version,
                snapshot: true,
                origin: "agent".into(),
                author_id: "mono-1".into(),
                author_name: "Ada".into(),
                tags: None,
            },
        )
        .unwrap();
        let again = saved_page(again);
        assert_eq!(again.version, idle.version);
        assert_eq!(list_versions(&conn, "page-1").unwrap().len(), 2);

        let agent = saved_page(update_doc(
            &conn,
            &DocUpdate {
                id: "page-1".into(),
                title: "Plan".into(),
                body: "three".into(),
                blocks_json: Some(r#"[{"id":"e","type":"paragraph","content":[{"type":"text","text":"three"}]}]"#.into()),
                expected_version: again.version,
                snapshot: true,
                origin: "agent".into(),
                author_id: "mono-1".into(),
                author_name: "Ada".into(),
                tags: None,
            },
        )
        .unwrap());
        let versions = list_versions(&conn, "page-1").unwrap();
        assert_eq!(versions[0].kind, "agent");
        assert_eq!(versions[0].author_name, "Ada");
        assert_eq!(agent.body, "three");
    }

    #[test]
    fn restoring_keeps_the_current_text_and_writes_a_new_version() {
        let conn = memory();
        let created = saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    body: "one".into(),
                    ..page("Plan", "one")
                },
            )
            .unwrap(),
        );
        let edited = saved_page(
            update_doc(
                &conn,
                &DocUpdate {
                    id: "page-1".into(),
                    title: "Plan".into(),
                    body: "two".into(),
                    blocks_json: Some("[]".into()),
                    expected_version: created.version,
                    snapshot: false,
                    origin: "person".into(),
                    author_id: "ash".into(),
                    author_name: "Ash".into(),
                    tags: None,
                },
            )
            .unwrap(),
        );
        let restored = saved_page(
            restore_doc(
                &conn,
                &DocRestore {
                    id: "page-1".into(),
                    version: 1,
                    expected_version: edited.version,
                    author_id: "ash".into(),
                    author_name: "Ash".into(),
                },
            )
            .unwrap(),
        );
        assert_eq!(restored.body, "one");
        let versions = list_versions(&conn, "page-1").unwrap();
        assert_eq!(versions.len(), 3);
        assert_eq!(versions[0].kind, "restore");
        assert_eq!(versions[1].body, "two");
        assert_eq!(versions[1].kind, "auto");
        let same = saved_page(
            restore_doc(
                &conn,
                &DocRestore {
                    id: "page-1".into(),
                    version: versions[0].version,
                    expected_version: restored.version,
                    author_id: "ash".into(),
                    author_name: "Ash".into(),
                },
            )
            .unwrap(),
        );
        assert_eq!(same.version, restored.version);
        assert_eq!(list_versions(&conn, "page-1").unwrap().len(), 3);
    }

    #[test]
    fn a_move_into_itself_or_a_cycle_is_refused() {
        let conn = memory();
        saved_page(create_doc(&conn, &page("Parent", "p")).unwrap());
        saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    id: "child".into(),
                    parent_id: Some("page-1".into()),
                    ..page("Child", "c")
                },
            )
            .unwrap(),
        );
        let parent = get_doc(&conn, "page-1").unwrap().unwrap();
        let refused = move_doc(
            &conn,
            &DocMove {
                id: "page-1".into(),
                parent_id: Some("child".into()),
                index: 0,
                expected_version: parent.version,
                sibling_ids: Vec::new(),
            },
        );
        assert!(refused.unwrap_err().contains("itself"));
        assert!(get_doc(&conn, "page-1")
            .unwrap()
            .unwrap()
            .parent_id
            .is_none());

        conn.execute(
            "UPDATE notes SET parent_id = 'child' WHERE id = 'page-1'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE notes SET parent_id = 'page-1' WHERE id = 'child'",
            [],
        )
        .unwrap();
        let started = std::time::Instant::now();
        let looped = would_cycle(&conn, "page-1", "child").unwrap();
        assert!(looped);
        assert!(started.elapsed().as_secs() < 2);

        conn.execute("UPDATE notes SET parent_id = NULL WHERE id = 'page-1'", [])
            .unwrap();
        let moved = saved_page(
            move_doc(
                &conn,
                &DocMove {
                    id: "child".into(),
                    parent_id: None,
                    index: 0,
                    expected_version: get_doc(&conn, "child").unwrap().unwrap().version,
                    sibling_ids: vec!["page-1".into()],
                },
            )
            .unwrap(),
        );
        assert!(moved.parent_id.is_none());
        let order = list_docs(&conn).unwrap();
        assert_eq!(order[0].id, "child");
    }

    #[test]
    fn adopt_writes_blocks_only_while_the_body_is_unchanged() {
        let conn = memory();
        let created = saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    blocks_json: None,
                    body: "hello".into(),
                    ..page("Plan", "hello")
                },
            )
            .unwrap(),
        );
        assert!(created.blocks_json.is_none());
        let adopted = saved_page(
            adopt_blocks(
                &conn,
                "page-1",
                r#"[{"id":"a","type":"paragraph"}]"#,
                "hello",
                created.version,
            )
            .unwrap(),
        );
        assert!(adopted.blocks_json.is_some());
        assert_eq!(adopted.body, "hello");
        let again = saved_page(
            adopt_blocks(
                &conn,
                "page-1",
                r#"[{"id":"b","type":"paragraph"}]"#,
                "hello",
                adopted.version,
            )
            .unwrap(),
        );
        assert_eq!(again.blocks_json, adopted.blocks_json);
        conn.execute(
            "UPDATE notes SET blocks_json = NULL, body = 'other' WHERE id = 'page-1'",
            [],
        )
        .unwrap();
        let missed = adopt_blocks(
            &conn,
            "page-1",
            "[]",
            "hello",
            get_doc(&conn, "page-1").unwrap().unwrap().version,
        );
        assert!(missed.is_err());
        assert_eq!(get_doc(&conn, "page-1").unwrap().unwrap().body, "other");
        assert!(get_doc(&conn, "page-1")
            .unwrap()
            .unwrap()
            .blocks_json
            .is_none());
    }

    #[test]
    fn a_mention_already_on_the_page_is_not_new() {
        let conn = memory();
        let blocks = r#"[{"id":"a","type":"paragraph","content":[{"type":"mention","props":{"kind":"task","targetId":"task-1","name":"Write the spec"}}]}]"#;
        let created = create_doc(
            &conn,
            &DocCreate {
                blocks_json: Some(blocks.into()),
                body: "see".into(),
                ..page("Plan", "see")
            },
        )
        .unwrap();
        let DocWrite::Saved {
            new_mentions, page, ..
        } = created
        else {
            panic!("conflict")
        };
        assert_eq!(new_mentions.len(), 1);
        assert_eq!(new_mentions[0].target_id, "task-1");
        let again = update_doc(
            &conn,
            &DocUpdate {
                id: "page-1".into(),
                title: "Plan".into(),
                body: "see more".into(),
                blocks_json: Some(blocks.into()),
                expected_version: page.version,
                snapshot: true,
                origin: "person".into(),
                author_id: "ash".into(),
                author_name: "Ash".into(),
                tags: None,
            },
        )
        .unwrap();
        let DocWrite::Saved { new_mentions, .. } = again else {
            panic!("conflict")
        };
        assert!(new_mentions.is_empty());
        let resolved = resolve_mention(&conn, "task", "task-1");
        assert!(!resolved.found);
        let page_hit = resolve_mention(&conn, "page", "plan");
        assert!(page_hit.found);
        assert_eq!(page_hit.name, "Plan");
    }

    #[test]
    fn export_stays_inside_the_folder_and_refuses_a_bad_slug() {
        let conn = memory();
        saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    id: "parent".into(),
                    ..page("Notes", "n")
                },
            )
            .unwrap(),
        );
        // create_doc used title Notes from page(), slug notes. Child:
        saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    id: "child".into(),
                    title: "Child page".into(),
                    body: "c".into(),
                    parent_id: Some("parent".into()),
                    ..page("Child page", "c")
                },
            )
            .unwrap(),
        );
        conn.execute("UPDATE notes SET trashed_at = 1 WHERE id = 'gone'", [])
            .unwrap();
        let dir = std::env::temp_dir().join(format!("hivra-wp72-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let files = export_doc(&conn, "parent", &dir, true).unwrap();
        assert!(files.contains(&"notes/index.md".to_string()));
        assert!(files.iter().any(|file| file == "notes/child-page.md"));
        let written = std::fs::read_to_string(dir.join("notes/index.md")).unwrap();
        assert!(written.starts_with("# Notes"));
        conn.execute("UPDATE notes SET slug = '..' WHERE id = 'parent'", [])
            .unwrap();
        assert!(export_doc(&conn, "parent", &dir, false).is_err());
        conn.execute("UPDATE notes SET slug = 'a/b' WHERE id = 'parent'", [])
            .unwrap();
        assert!(export_doc(&conn, "parent", &dir, false)
            .unwrap_err()
            .contains("safe file name"));
        let temp = canonical(std::env::temp_dir()).unwrap();
        let target = canonical(&dir).unwrap();
        assert!(target.starts_with(&temp));
        std::fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn trash_hides_a_page_and_the_pages_under_it() {
        let conn = memory();
        saved_page(create_doc(&conn, &page("Parent", "p")).unwrap());
        saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    id: "child".into(),
                    parent_id: Some("page-1".into()),
                    ..page("Child", "c")
                },
            )
            .unwrap(),
        );
        trash_doc(&conn, "page-1").unwrap();
        assert!(list_docs(&conn).unwrap().is_empty());
        assert!(get_doc(&conn, "child")
            .unwrap()
            .unwrap()
            .trashed_at
            .is_some());
    }

    #[test]
    fn a_notes_save_bumps_the_version_so_a_stale_docs_save_cannot_replace_it() {
        let conn = memory();
        let created = saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    body: "one".into(),
                    blocks_json: Some(r#"[{"id":"a","type":"paragraph"}]"#.into()),
                    ..page("Plan", "one")
                },
            )
            .unwrap(),
        );
        let typed = saved_page(
            update_doc(
                &conn,
                &DocUpdate {
                    id: "page-1".into(),
                    title: "Plan".into(),
                    body: "two".into(),
                    blocks_json: Some(r#"[{"id":"b","type":"paragraph"}]"#.into()),
                    expected_version: created.version,
                    snapshot: false,
                    origin: "person".into(),
                    author_id: "ash".into(),
                    author_name: "Ash".into(),
                    tags: None,
                },
            )
            .unwrap(),
        );
        crate::notes::upsert_content(
            &conn,
            &crate::notes::NoteUpsert {
                id: "page-1".into(),
                title: "Plan".into(),
                body: "from notes".into(),
                tags: Vec::new(),
                source_session_id: None,
                source_cwd: None,
                finalize_slug: false,
            },
            "note",
            None,
        )
        .unwrap();
        let after = get_doc(&conn, "page-1").unwrap().unwrap();
        assert_eq!(after.body, "from notes");
        assert!(after.version > typed.version);
        let kept = list_versions(&conn, "page-1").unwrap();
        assert!(
            kept.iter().any(|row| row.body == "two"),
            "the text notes replaced must already be a version"
        );
        let stale = update_doc(
            &conn,
            &DocUpdate {
                id: "page-1".into(),
                title: "Plan".into(),
                body: "stale".into(),
                blocks_json: Some("[]".into()),
                expected_version: typed.version,
                snapshot: true,
                origin: "person".into(),
                author_id: "ash".into(),
                author_name: "Ash".into(),
                tags: None,
            },
        )
        .unwrap();
        assert!(matches!(stale, DocWrite::Conflict { .. }));
        assert_eq!(
            get_doc(&conn, "page-1").unwrap().unwrap().body,
            "from notes"
        );
    }

    #[test]
    fn a_stale_reorder_does_not_rewrite_a_page_that_already_moved() {
        let conn = memory();
        for (id, title) in [("a", "A"), ("b", "B"), ("c", "C"), ("folder", "Folder")] {
            saved_page(
                create_doc(
                    &conn,
                    &DocCreate {
                        id: id.into(),
                        title: title.into(),
                        body: title.into(),
                        ..page(title, title)
                    },
                )
                .unwrap(),
            );
        }
        let moved = move_doc(
            &conn,
            &DocMove {
                id: "c".into(),
                parent_id: Some("folder".into()),
                index: 0,
                expected_version: get_doc(&conn, "c").unwrap().unwrap().version,
                sibling_ids: Vec::new(),
            },
        );
        let moved = saved_page(moved.unwrap());
        assert_eq!(moved.parent_id.as_deref(), Some("folder"));
        let c_sort = moved.sort_order;
        let b_sort = get_doc(&conn, "b").unwrap().unwrap().sort_order;
        let a_parent = get_doc(&conn, "a").unwrap().unwrap().parent_id.clone();
        let stale = move_doc(
            &conn,
            &DocMove {
                id: "a".into(),
                parent_id: None,
                index: 0,
                expected_version: get_doc(&conn, "a").unwrap().unwrap().version,
                sibling_ids: vec!["b".into(), "c".into()],
            },
        )
        .unwrap();
        assert!(
            matches!(stale, DocWrite::Conflict { .. }),
            "a move built from an old sibling list must not be written"
        );
        let c = get_doc(&conn, "c").unwrap().unwrap();
        assert_eq!(c.parent_id.as_deref(), Some("folder"));
        assert_eq!(c.sort_order, c_sort);
        assert_eq!(get_doc(&conn, "b").unwrap().unwrap().sort_order, b_sort);
        assert_eq!(get_doc(&conn, "a").unwrap().unwrap().parent_id, a_parent);
    }

    #[cfg(unix)]
    #[test]
    fn export_does_not_follow_a_symlink_file() {
        use std::os::unix::fs::symlink;
        let conn = memory();
        saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    body: "secret".into(),
                    ..page("Plan", "secret")
                },
            )
            .unwrap(),
        );
        let dir = std::env::temp_dir().join(format!("hivra-wp72-link-{}", uuid::Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("hivra-wp72-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&outside, "kept").unwrap();
        symlink(&outside, dir.join("plan.md")).unwrap();
        let exported = export_doc(&conn, "page-1", &dir, false);
        assert!(exported.is_err(), "a symlink file must not be overwritten");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "kept");
        assert!(std::fs::symlink_metadata(dir.join("plan.md"))
            .unwrap()
            .file_type()
            .is_symlink());
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_file(&outside).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn export_does_not_follow_a_symlink_file() {
        use std::os::windows::fs::symlink_file;
        let conn = memory();
        saved_page(
            create_doc(
                &conn,
                &DocCreate {
                    body: "secret".into(),
                    ..page("Plan", "secret")
                },
            )
            .unwrap(),
        );
        let dir = std::env::temp_dir().join(format!("hivra-wp72-link-{}", uuid::Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("hivra-wp72-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&outside, "kept").unwrap();
        // Creating a symlink can be refused without extra rights. That is a skip, not a pass.
        if symlink_file(&outside, dir.join("plan.md")).is_err() {
            std::fs::remove_dir_all(&dir).unwrap();
            std::fs::remove_file(&outside).unwrap();
            return;
        }
        let exported = export_doc(&conn, "page-1", &dir, false);
        assert!(exported.is_err(), "a symlink file must not be overwritten");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "kept");
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_file(&outside).unwrap();
    }
}
