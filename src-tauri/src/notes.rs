use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::fs::expand_home;
use crate::plain_file::{self, Refusal};
use crate::session_store::{now_millis, validate_id, SessionStore};

const TITLE_MAX: usize = 200;
const BODY_MAX: usize = 1_000_000;
const TAG_MAX: usize = 48;
const TAGS_MAX: usize = 20;
/// The largest picture a note takes, and the most an export will read of one.
pub(crate) const IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const NOTE_ASSET_DIR: &str = "note-assets";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_cwd: Option<String>,
    /// The slug was generated for a note created without a title and is
    /// replaced once, from the first real title. Notes that predate this
    /// column, or were created with a title, keep their slug permanently.
    pub slug_pending: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpsert {
    pub id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub source_cwd: Option<String>,
    /// Set once the title is done being typed (blur/close), not on debounced
    /// saves, so a half-typed title doesn't become the permanent slug. Only
    /// affects notes whose slug is still pending.
    #[serde(default)]
    pub finalize_slug: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteImageAsset {
    pub name: String,
    pub markdown_path: String,
}

pub fn ensure_notes_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes (
           id TEXT PRIMARY KEY,
           slug TEXT NOT NULL UNIQUE,
           title TEXT NOT NULL,
           body TEXT NOT NULL DEFAULT '',
           tags_json TEXT NOT NULL DEFAULT '[]',
           source_session_id TEXT,
           source_cwd TEXT,
           slug_pending INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS notes_updated_idx
           ON notes (updated_at DESC, id);",
    )?;
    let tags_present: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'tags_json'",
        [],
        |row| row.get(0),
    )?;
    if tags_present == 0 {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    let pending_present: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'slug_pending'",
        [],
        |row| row.get(0),
    )?;
    if pending_present == 0 {
        // Existing slugs may already be referenced, so every existing row
        // starts established (0) whatever its slug looks like.
        conn.execute(
            "ALTER TABLE notes ADD COLUMN slug_pending INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let kind_present: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'content_kind'",
        [],
        |row| row.get(0),
    )?;
    if kind_present == 0 {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'note'",
            [],
        )?;
    }
    let artifact_kind_present: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'artifact_kind'",
        [],
        |row| row.get(0),
    )?;
    if artifact_kind_present == 0 {
        conn.execute("ALTER TABLE notes ADD COLUMN artifact_kind TEXT", [])?;
    }
    // WP-72: docs columns and history live on notes, not in a second store.
    crate::docs::ensure_docs_schema(conn)?;
    Ok(())
}

#[tauri::command(async)]
pub fn notes_list(store: State<'_, SessionStore>) -> Result<Vec<Note>, String> {
    let conn = store.lock_conn()?;
    list_notes(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn notes_get(store: State<'_, SessionStore>, id: String) -> Result<Option<Note>, String> {
    validate_id(&id, "note")?;
    let conn = store.lock_conn()?;
    get_note(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn notes_upsert(store: State<'_, SessionStore>, note: NoteUpsert) -> Result<Note, String> {
    save_content(store, note, "note", None)
}

pub(crate) fn save_content(
    store: State<'_, SessionStore>,
    note: NoteUpsert,
    kind: &str,
    artifact_kind: Option<&str>,
) -> Result<Note, String> {
    validate_id(&note.id, kind)?;
    if let Some(session_id) = note.source_session_id.as_deref() {
        if !session_id.is_empty() {
            validate_id(session_id, "session")?;
        }
    }
    if note.body.len() > BODY_MAX {
        return Err("Content is too large".into());
    }
    let conn = store.lock_conn()?;
    upsert_content(&conn, &note, kind, artifact_kind).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn notes_delete(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    validate_id(&id, "note")?;
    let conn = store.lock_conn()?;
    let kind: Option<String> = conn
        .query_row(
            "SELECT content_kind FROM notes WHERE id = ?1",
            params![&id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    // Artifacts share this table and are not trash. A missing row is already gone.
    if kind.as_deref() != Some("note") {
        return Ok(());
    }
    if crate::trash::is_trashed(&conn, "note", &id).map_err(|error| error.to_string())? {
        return Ok(());
    }
    let title: String = conn
        .query_row(
            "SELECT title FROM notes WHERE id = ?1",
            params![&id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "Untitled".into());
    let source_cwd: Option<String> = conn
        .query_row(
            "SELECT source_cwd FROM notes WHERE id = ?1",
            params![&id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    drop(conn);
    // WP-76: images move first. If the ledger insert fails, they come back.
    // A failed rollback is returned, and the ledger is tried again so the folder stays listed.
    crate::trash::park_note_assets(&app, &id).map_err(|error| error.to_string())?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let name = format!("note-{id}");
    let original = data.join("note-assets").join(&id);
    let conn = store.lock_conn()?;
    let parked = crate::trash::record_after_moves(
        &conn,
        &data.join("trash"),
        &[(name, original)],
        &crate::trash::Item {
            kind: "note".into(),
            id: id.clone(),
            title,
            parent_kind: source_cwd.as_ref().map(|_| "project".into()),
            parent_id: source_cwd,
            payload: "{}".into(),
        },
        &[],
        crate::session_store::now_millis(),
    );
    drop(conn);
    if let Err(error) = parked {
        return Err(error.to_string());
    }
    let _ = app.emit(crate::trash::CHANGED, ());
    Ok(())
}

#[tauri::command]
pub async fn notes_save_image(
    app: AppHandle,
    note_id: String,
    source_path: String,
) -> Result<NoteImageAsset, String> {
    tauri::async_runtime::spawn_blocking(move || save_note_image_sync(&app, &note_id, &source_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub fn notes_image_path(app: AppHandle, asset: String) -> Result<String, String> {
    let relative = validate_note_asset_path(&asset)?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(relative);
    if !path.is_file() {
        return Err("Note image was not found".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn note_assets_dir(app: &AppHandle, note_id: &str) -> Result<PathBuf, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    note_assets_dir_in(&data, note_id)
}

fn note_assets_dir_in(data_dir: &Path, note_id: &str) -> Result<PathBuf, String> {
    validate_id(note_id, "note")?;
    Ok(data_dir.join(NOTE_ASSET_DIR).join(note_id))
}

fn save_note_image_sync(
    app: &AppHandle,
    note_id: &str,
    source_path: &str,
) -> Result<NoteImageAsset, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    save_note_image_into(&data, note_id, source_path)
}

fn save_note_image_into(
    data_dir: &Path,
    note_id: &str,
    source_path: &str,
) -> Result<NoteImageAsset, String> {
    let source = expand_home(source_path);
    let (display_name, safe_name) = note_image_names(&source)?;
    // A picture that is a link isn't followed (it could lead to a private key, and the next export would carry the
    // copy out), a pipe or device isn't one, and no more than the cap is ever read.
    let bytes = plain_file::read(&source, IMAGE_MAX_BYTES).map_err(|why| match why {
        Refusal::Link => "That image is a link. Pick the image file itself.".to_string(),
        Refusal::NotAFile => "Not a file".to_string(),
        Refusal::Unreadable => format!("{}: couldn't be read", source.display()),
        Refusal::TooBig => format!(
            "Image is too large (maximum {} MB).",
            IMAGE_MAX_BYTES / 1024 / 1024
        ),
    })?;

    let dir = note_assets_dir_in(data_dir, note_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let stored_name = format!("{stamp}-{safe_name}");
    let destination = dir.join(&stored_name);
    write_new_file(&destination, &bytes)
        .map_err(|error| format!("{}: {error}", destination.display()))?;

    Ok(NoteImageAsset {
        name: display_name,
        markdown_path: format!("/{NOTE_ASSET_DIR}/{note_id}/{stored_name}"),
    })
}

/// `bytes` as a new file at `path`: never over one that is there, never through a link at that name. A file that
/// couldn't be created isn't this function's to remove (it may be somebody else's); one it created and then couldn't
/// finish writing is removed, so no half of a picture is left.
fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let written = file.write_all(bytes);
    if written.is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    written
}

fn note_image_names(source: &Path) -> Result<(String, String), String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Image must be a PNG, JPG, GIF, WebP, or SVG file.".into());
    }
    let display_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let mut safe_stem: String = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .take(80)
        .collect();
    safe_stem = safe_stem.trim_matches('-').to_string();
    if safe_stem.is_empty() {
        safe_stem = "image".into();
    }
    Ok((display_name, format!("{safe_stem}.{extension}")))
}

fn validate_note_asset_path(asset: &str) -> Result<PathBuf, String> {
    let relative = asset
        .strip_prefix('/')
        .ok_or_else(|| "Invalid note image path".to_string())?;
    let path = Path::new(relative);
    let parts = path
        .components()
        .map(|part| match part {
            Component::Normal(value) => value.to_str().map(str::to_string),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| "Invalid note image path".to_string())?;
    if parts.len() != 3 || parts[0] != NOTE_ASSET_DIR {
        return Err("Invalid note image path".into());
    }
    validate_id(&parts[1], "note")?;
    if parts[2].is_empty()
        || !parts[2]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Invalid note image path".into());
    }
    Ok(path.to_path_buf())
}

pub(crate) fn remove_note_assets(app: &AppHandle, note_id: &str) -> Result<(), String> {
    let dir = note_assets_dir(app, note_id)?;
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn list_notes(conn: &Connection) -> rusqlite::Result<Vec<Note>> {
    list_content(conn, "note")
}

fn hidden_note_clause(conn: &Connection) -> &'static str {
    // A notes database from before the trash ledger has no `trash_items` yet. Listing must
    // still work; once the ledger exists, trashed notes stay out of the list and out of get.
    match conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trash_items'",
        [],
        |_| Ok(1i64),
    ) {
        Ok(_) => crate::trash::HIDDEN_NOTE_CLAUSE,
        Err(_) => "",
    }
}

fn list_content(conn: &Connection, kind: &str) -> rusqlite::Result<Vec<Note>> {
    let hidden = hidden_note_clause(conn);
    let mut stmt = conn.prepare(&format!(
        "SELECT id, slug, title, body, source_session_id, source_cwd, tags_json,
                created_at, updated_at, slug_pending
         FROM notes
         WHERE content_kind = ?1{hidden}
         ORDER BY updated_at DESC, id ASC"
    ))?;
    let rows = stmt.query_map(params![kind], read_note)?;
    rows.collect()
}

fn get_note(conn: &Connection, id: &str) -> rusqlite::Result<Option<Note>> {
    get_content(conn, id, "note")
}

fn get_content(conn: &Connection, id: &str, kind: &str) -> rusqlite::Result<Option<Note>> {
    let hidden = hidden_note_clause(conn);
    conn.query_row(
        &format!(
            "SELECT id, slug, title, body, source_session_id, source_cwd, tags_json,
                    created_at, updated_at, slug_pending
             FROM notes
             WHERE id = ?1 AND content_kind = ?2{hidden}"
        ),
        params![id, kind],
        read_note,
    )
    .optional()
}

#[cfg(test)]
fn upsert_note(conn: &Connection, note: &NoteUpsert) -> rusqlite::Result<Note> {
    upsert_content(conn, note, "note", None)
}

fn note_failed(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(message.into())
}

pub(crate) fn upsert_content(
    conn: &Connection,
    note: &NoteUpsert,
    kind: &str,
    artifact_kind: Option<&str>,
) -> rusqlite::Result<Note> {
    let existing_kind: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT content_kind, artifact_kind FROM notes WHERE id = ?1",
            params![note.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if existing_kind
        .as_ref()
        .is_some_and(|(category, subtype)| category != kind || subtype.as_deref() != artifact_kind)
    {
        return Err(rusqlite::Error::InvalidParameterName(
            "Content belongs to a different kind".into(),
        ));
    }
    let title = normalize_title(&note.title);
    let body = note.body.replace("\r\n", "\n").replace('\r', "\n");
    let tags = normalize_tags(&note.tags);
    let tags_json = serde_json::to_string(&tags)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let source_session_id = note
        .source_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let source_cwd = note
        .source_cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let now = now_millis();

    if let Some(existing) = get_content(conn, &note.id, kind)? {
        let project_cwd = source_cwd.map(str::to_string).or(existing.source_cwd);
        // Project changes keep the note in its current position in the list.
        let updated_at =
            if title == existing.title && body == existing.body && tags == existing.tags {
                existing.updated_at
            } else {
                now
            };
        // A pending slug is replaced once, by the first finalizing save with
        // a real title; every other slug stays put so @note/ references keep
        // working. Nothing here sets pending back on.
        let (slug, slug_pending) =
            if note.finalize_slug && existing.slug_pending && !is_placeholder_title(&title) {
                (unique_slug(conn, &title)?, false)
            } else {
                (existing.slug, existing.slug_pending)
            };
        // WP-72: a Notes edit that changes the Markdown drops the derived blocks.
        // The next Docs open converts again. The same body keeps them. `body` on
        // the right is the row's current value, not the new one.
        // A text change also keeps the row as a version and bumps doc_version, so
        // a Docs client still holding the old version cannot put that text back.
        if kind == "note" && (title != existing.title || body != existing.body) {
            let tx = conn.unchecked_transaction()?;
            let doc_version: i64 = tx.query_row(
                "SELECT COALESCE(doc_version, 0) FROM notes WHERE id = ?1",
                params![note.id],
                |row| row.get(0),
            )?;
            crate::docs::keep_note_text(&tx, &note.id).map_err(note_failed)?;
            let changed = tx.execute(
                "UPDATE notes
                 SET title = ?1, body = ?2, tags_json = ?3, updated_at = ?4,
                     source_cwd = ?6, slug = ?7, slug_pending = ?8,
                     blocks_json = CASE WHEN ?2 = body THEN blocks_json ELSE NULL END,
                     doc_version = doc_version + 1
                 WHERE id = ?5 AND doc_version = ?9",
                params![
                    title,
                    body,
                    tags_json,
                    updated_at,
                    note.id,
                    project_cwd,
                    slug,
                    slug_pending,
                    doc_version
                ],
            )?;
            if changed != 1 {
                return Err(note_failed("The page changed somewhere else"));
            }
            tx.commit()?;
        } else {
            conn.execute(
                "UPDATE notes
                 SET title = ?1, body = ?2, tags_json = ?3, updated_at = ?4,
                     source_cwd = ?6, slug = ?7, slug_pending = ?8,
                     blocks_json = CASE WHEN ?2 = body THEN blocks_json ELSE NULL END
                 WHERE id = ?5",
                params![
                    title,
                    body,
                    tags_json,
                    updated_at,
                    note.id,
                    project_cwd,
                    slug,
                    slug_pending
                ],
            )?;
        }
        Ok(Note {
            id: note.id.clone(),
            slug,
            title,
            body,
            tags,
            source_session_id: existing.source_session_id,
            source_cwd: project_cwd,
            slug_pending,
            created_at: existing.created_at,
            updated_at,
        })
    } else {
        // Decided before normalization: a blank title gets a generated slug,
        // while an explicit "Untitled" or "Untitled 2" owns the slug it gets.
        let slug_pending = note.title.trim().is_empty();
        let slug = unique_slug(conn, &title)?;
        conn.execute(
            "INSERT INTO notes (
               id, slug, title, body, source_session_id, source_cwd, tags_json,
               created_at, updated_at, slug_pending, content_kind, artifact_kind
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                note.id,
                slug,
                title,
                body,
                source_session_id,
                source_cwd,
                tags_json,
                now,
                now,
                slug_pending,
                kind,
                artifact_kind
            ],
        )?;
        Ok(Note {
            id: note.id.clone(),
            slug,
            title,
            body,
            tags,
            source_session_id: source_session_id.map(str::to_string),
            source_cwd: source_cwd.map(str::to_string),
            slug_pending,
            created_at: now,
            updated_at: now,
        })
    }
}

fn delete_note(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    // WP-72: a deleted note takes its versions and mentions with it.
    conn.execute("DELETE FROM note_versions WHERE note_id = ?1", params![id])?;
    conn.execute("DELETE FROM note_mentions WHERE note_id = ?1", params![id])?;
    conn.execute(
        "DELETE FROM notes WHERE id = ?1 AND content_kind = 'note'",
        params![id],
    )?;
    Ok(())
}

/// Hard-delete a note row. Assets are removed by the caller. Only purge and delete-forever use this.
pub(crate) fn purge_note(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    delete_note(conn, id)
}

fn read_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let tags_json: String = row.get(6)?;
    let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
    Ok(Note {
        id: row.get(0)?,
        slug: row.get(1)?,
        title: row.get(2)?,
        body: row.get(3)?,
        tags,
        source_session_id: row.get(4)?,
        source_cwd: row.get(5)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        slug_pending: row.get(9)?,
    })
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for input in tags {
        let tag = input
            .trim()
            .trim_start_matches('#')
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-")
            .to_lowercase();
        let tag: String = tag.chars().take(TAG_MAX).collect();
        let tag = tag.trim_end_matches('-').to_string();
        if tag.is_empty() || normalized.contains(&tag) {
            continue;
        }
        normalized.push(tag);
        if normalized.len() == TAGS_MAX {
            break;
        }
    }
    normalized
}

fn normalize_title(title: &str) -> String {
    let trimmed = title.trim();
    let sliced: String = trimmed.chars().take(TITLE_MAX).collect();
    let sliced = sliced.trim().to_string();
    if sliced.is_empty() {
        "Untitled".into()
    } else {
        sliced
    }
}

/// Lowercase ASCII words of `title` joined by single hyphens, untruncated.
fn slug_words(title: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in title.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

fn slugify(title: &str) -> String {
    let words = slug_words(title);
    let slug = words[..words.len().min(48)].trim_end_matches('-');
    if slug.is_empty() {
        "note".into()
    } else {
        slug.into()
    }
}

/// "Untitled" and "Untitled 2" read like generated slugs, so finalizing a
/// pending note under such a title would just trade one placeholder for
/// another; the note stays pending until it gets a real title. Checks the
/// whole title so text past the slug length cutoff still counts.
fn is_placeholder_title(title: &str) -> bool {
    let words = slug_words(title);
    match words.strip_prefix("untitled") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('-')
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())),
        None => false,
    }
}

pub(crate) fn unique_slug(conn: &Connection, title: &str) -> rusqlite::Result<String> {
    let base = slugify(title);
    for index in 0..1000 {
        let candidate = if index == 0 {
            base.clone()
        } else {
            format!("{base}-{}", index + 1)
        };
        let taken: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE slug = ?1",
            params![candidate],
            |row| row.get(0),
        )?;
        if taken == 0 {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}-{}", now_millis()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::SessionStore;

    fn upsert(store: &SessionStore, id: &str, title: &str, body: &str) -> Note {
        let conn = store.lock_conn().unwrap();
        upsert_note(
            &conn,
            &NoteUpsert {
                id: id.into(),
                title: title.into(),
                body: body.into(),
                tags: Vec::new(),
                source_session_id: None,
                source_cwd: None,
                finalize_slug: true,
            },
        )
        .unwrap()
    }

    #[test]
    fn migrate_creates_notes_table() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'notes'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table, 1);
        let version: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 13",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn artifacts_stay_out_of_notes_and_cannot_be_reclassified() {
        let store = SessionStore::open_in_memory().unwrap();
        upsert(&store, "note-1", "Personal note", "Keep this in Notes");
        let conn = store.lock_conn().unwrap();
        let input = NoteUpsert {
            id: "doc-1".into(),
            title: "PR report".into(),
            body: "# Report\n\nDetailed review".into(),
            tags: Vec::new(),
            source_session_id: Some("mono-1".into()),
            source_cwd: None,
            finalize_slug: false,
        };
        upsert_content(&conn, &input, "artifact", Some("document")).unwrap();
        assert_eq!(list_notes(&conn).unwrap().len(), 1);
        assert_eq!(list_notes(&conn).unwrap()[0].id, "note-1");
        assert!(get_note(&conn, "doc-1").unwrap().is_none());
        assert!(get_content(&conn, "note-1", "artifact").unwrap().is_none());
        assert_eq!(list_content(&conn, "artifact").unwrap()[0].id, "doc-1");
        assert!(upsert_content(&conn, &input, "artifact", Some("code")).is_err());
        assert!(upsert_note(&conn, &input).is_err());
        assert!(upsert_content(
            &conn,
            &NoteUpsert {
                id: "note-1".into(),
                ..input.clone()
            },
            "artifact",
            Some("document"),
        )
        .is_err());
        delete_note(&conn, "doc-1").unwrap();
        assert!(get_content(&conn, "doc-1", "artifact").unwrap().is_some());
        upsert_content(
            &conn,
            &NoteUpsert {
                body: "Revised report".into(),
                ..input
            },
            "artifact",
            Some("document"),
        )
        .unwrap();
        assert_eq!(
            get_content(&conn, "doc-1", "artifact")
                .unwrap()
                .unwrap()
                .body,
            "Revised report"
        );
    }

    #[test]
    fn content_kind_migration_keeps_existing_rows_as_notes() {
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
        ensure_notes_table(&conn).unwrap();
        ensure_notes_table(&conn).unwrap();
        assert_eq!(list_notes(&conn).unwrap()[0].body, "Kept");
        assert!(list_content(&conn, "artifact").unwrap().is_empty());
    }

    #[test]
    fn ensure_table_adds_tags_to_an_existing_notes_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
               id TEXT PRIMARY KEY,
               slug TEXT NOT NULL UNIQUE,
               title TEXT NOT NULL,
               body TEXT NOT NULL DEFAULT '',
               source_session_id TEXT,
               source_cwd TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             INSERT INTO notes (id, slug, title, body, source_cwd, created_at, updated_at)
               VALUES ('old', 'untitled', 'Untitled', 'kept', '/repo', 1, 2);",
        )
        .unwrap();

        ensure_notes_table(&conn).unwrap();
        ensure_notes_table(&conn).unwrap();

        let tags_column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'tags_json'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tags_column, 1);
        let note = get_note(&conn, "old").unwrap().unwrap();
        assert_eq!(note.slug, "untitled");
        assert_eq!(note.title, "Untitled");
        assert_eq!(note.body, "kept");
        assert_eq!(note.source_cwd.as_deref(), Some("/repo"));
        assert!(note.tags.is_empty());
        assert!(!note.slug_pending);
        assert_eq!((note.created_at, note.updated_at), (1, 2));
    }

    #[test]
    fn insert_update_and_list_newest_first() {
        let store = SessionStore::open_in_memory().unwrap();
        let first = upsert(&store, "n1", "Alpha", "one");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = upsert(&store, "n2", "Beta", "two");
        assert_eq!(first.slug, "alpha");
        assert_eq!(second.slug, "beta");

        let conn = store.lock_conn().unwrap();
        let listed = list_notes(&conn).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|note| note.id.as_str())
                .collect::<Vec<_>>(),
            vec!["n2", "n1"]
        );

        std::thread::sleep(std::time::Duration::from_millis(5));
        let updated = upsert_note(
            &conn,
            &NoteUpsert {
                id: "n1".into(),
                title: "Alpha renamed".into(),
                body: "changed".into(),
                tags: vec!["Ideas".into(), "project docs".into(), "ideas".into()],
                source_session_id: Some("sess-1".into()),
                source_cwd: Some("/tmp/a".into()),
                finalize_slug: false,
            },
        )
        .unwrap();
        assert_eq!(updated.slug, "alpha");
        assert_eq!(updated.title, "Alpha renamed");
        assert_eq!(updated.body, "changed");
        assert_eq!(updated.tags, vec!["ideas", "project-docs"]);
        assert_eq!(updated.created_at, first.created_at);
        assert!(updated.updated_at > first.updated_at);
        // Keep the source session when changing the note's project.
        assert_eq!(updated.source_session_id, None);
        assert_eq!(updated.source_cwd.as_deref(), Some("/tmp/a"));
        assert_eq!(
            get_note(&conn, "n1")
                .unwrap()
                .unwrap()
                .source_cwd
                .as_deref(),
            Some("/tmp/a")
        );

        drop(conn);
        let edited = upsert(&store, "n1", "Alpha renamed", "another edit");
        assert_eq!(edited.source_cwd.as_deref(), Some("/tmp/a"));
    }

    #[test]
    fn changing_only_project_preserves_note_order() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut input = NoteUpsert {
            id: "older".into(),
            title: "Plan".into(),
            body: "Keep this text.".into(),
            tags: vec!["ideas".into()],
            source_session_id: Some("original-session".into()),
            source_cwd: Some("/work/Edefyn".into()),
            finalize_slug: false,
        };
        let original = upsert_note(&conn, &input).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        upsert_note(
            &conn,
            &NoteUpsert {
                id: "newer".into(),
                title: "Newer note".into(),
                body: "Another note.".into(),
                tags: vec![],
                source_session_id: None,
                source_cwd: None,
                finalize_slug: true,
            },
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));

        input.source_cwd = Some("/work/portognjeeen".into());
        let moved = upsert_note(&conn, &input).unwrap();
        assert_eq!(moved.updated_at, original.updated_at);
        assert_eq!(moved.source_cwd.as_deref(), Some("/work/portognjeeen"));
        assert_eq!(moved.source_session_id, original.source_session_id);
        assert_eq!(moved.slug, original.slug);
        assert_eq!(moved.created_at, original.created_at);

        let listed = list_notes(&conn).unwrap();
        assert_eq!(listed[0].id, "newer");
        assert_eq!(listed[1].id, "older");
        assert_eq!(listed[1].updated_at, original.updated_at);
        assert_eq!(listed[1].source_cwd, moved.source_cwd);

        input.title = "Updated plan".into();
        input.source_cwd = Some("/work/Edefyn".into());
        let edited = upsert_note(&conn, &input).unwrap();
        assert!(edited.updated_at > original.updated_at);
        assert_eq!(list_notes(&conn).unwrap()[0].id, "older");
    }

    #[test]
    fn slug_collisions_get_a_numeric_suffix() {
        let store = SessionStore::open_in_memory().unwrap();
        let first = upsert(&store, "n1", "Auth approach", "a");
        let second = upsert(&store, "n2", "Auth approach", "b");
        assert_eq!(first.slug, "auth-approach");
        assert_eq!(second.slug, "auth-approach-2");
    }

    fn save(store: &SessionStore, id: &str, title: &str, finalize_slug: bool) -> Note {
        let conn = store.lock_conn().unwrap();
        upsert_note(
            &conn,
            &NoteUpsert {
                id: id.into(),
                title: title.into(),
                body: String::new(),
                tags: Vec::new(),
                source_session_id: None,
                source_cwd: None,
                finalize_slug,
            },
        )
        .unwrap()
    }

    #[test]
    fn only_a_blank_title_creates_a_pending_slug() {
        let store = SessionStore::open_in_memory().unwrap();
        let blank = save(&store, "blank", "  ", false);
        assert_eq!(
            (blank.title.as_str(), blank.slug.as_str()),
            ("Untitled", "untitled")
        );
        assert!(blank.slug_pending);
        for (id, title, slug) in [
            ("typed", "Untitled", "untitled-2"),
            ("numbered", "Untitled 2", "untitled-2-2"),
            ("named", "Plan", "plan"),
        ] {
            let created = save(&store, id, title, false);
            assert_eq!(created.slug, slug);
            assert!(!created.slug_pending);
            let finalized = save(&store, id, "Release notes", true);
            assert_eq!(finalized.slug, slug);
            assert!(!finalized.slug_pending);
        }
    }

    #[test]
    fn pending_slug_survives_debounced_saves_and_finalizes_once() {
        let store = SessionStore::open_in_memory().unwrap();
        save(&store, "n1", "", false);
        save(&store, "n1", "This i", false);
        let typed = save(&store, "n1", "This is my first note", false);
        assert_eq!(typed.slug, "untitled");
        let reopened = get_note(&store.lock_conn().unwrap(), "n1")
            .unwrap()
            .unwrap();
        assert_eq!(reopened.title, "This is my first note");
        assert!(reopened.slug_pending);

        let finalized = save(&store, "n1", "This is my first note", true);
        assert_eq!(finalized.slug, "this-is-my-first-note");
        assert!(!finalized.slug_pending);

        // Renaming or clearing an established note never makes it pending.
        for title in ["Renamed", "", "Another name"] {
            let renamed = save(&store, "n1", title, true);
            assert_eq!(renamed.slug, "this-is-my-first-note");
            assert!(!renamed.slug_pending);
        }
    }

    #[test]
    fn pending_slug_waits_for_a_real_title() {
        let store = SessionStore::open_in_memory().unwrap();
        save(&store, "n1", "", false);
        for title in ["Untitled", "   ", "Untitled 2"] {
            let saved = save(&store, "n1", title, true);
            assert_eq!(saved.slug, "untitled");
            assert!(saved.slug_pending);
        }
        assert_eq!(
            save(&store, "n1", "Auth approach", true).slug,
            "auth-approach"
        );
    }

    #[test]
    fn finalizing_a_pending_slug_avoids_collisions() {
        let store = SessionStore::open_in_memory().unwrap();
        save(&store, "n1", "Plan", false);
        save(&store, "n2", "", false);
        let second_blank = save(&store, "n3", "", false);
        assert_eq!(second_blank.slug, "untitled-2");
        assert_eq!(save(&store, "n2", "Plan", true).slug, "plan-2");
        assert_eq!(save(&store, "n3", "Plan", true).slug, "plan-3");
    }

    #[test]
    fn notes_from_before_slug_pending_keep_their_slugs() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
               id TEXT PRIMARY KEY,
               slug TEXT NOT NULL UNIQUE,
               title TEXT NOT NULL,
               body TEXT NOT NULL DEFAULT '',
               tags_json TEXT NOT NULL DEFAULT '[]',
               source_session_id TEXT,
               source_cwd TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             INSERT INTO notes (id, slug, title, created_at, updated_at)
               VALUES ('blank', 'untitled', 'Untitled', 0, 0),
                      ('named-later', 'untitled-2', 'Auth approach', 0, 0),
                      ('numbered', 'untitled-3', 'Untitled 3', 0, 0),
                      ('titled', 'plan', 'Plan', 0, 0),
                      ('cleared', 'roadmap', 'Untitled', 0, 0);",
        )
        .unwrap();

        ensure_notes_table(&conn).unwrap();
        ensure_notes_table(&conn).unwrap();

        let rows = [
            ("blank", "untitled"),
            ("named-later", "untitled-2"),
            ("numbered", "untitled-3"),
            ("titled", "plan"),
            ("cleared", "roadmap"),
        ];
        for (id, slug) in rows {
            let note = get_note(&conn, id).unwrap().unwrap();
            assert_eq!(note.slug, slug);
            assert!(!note.slug_pending);
            for finalize_slug in [false, true] {
                let saved = upsert_note(
                    &conn,
                    &NoteUpsert {
                        id: id.into(),
                        title: "Release notes".into(),
                        body: "edited".into(),
                        tags: Vec::new(),
                        source_session_id: None,
                        source_cwd: None,
                        finalize_slug,
                    },
                )
                .unwrap();
                assert_eq!(saved.slug, slug);
                assert!(!saved.slug_pending);
            }
            let resolved: String = conn
                .query_row(
                    "SELECT id FROM notes WHERE slug = ?1",
                    params![slug],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(resolved, id);
        }
    }

    #[test]
    fn placeholder_title_detection() {
        assert!(is_placeholder_title("Untitled"));
        assert!(is_placeholder_title("untitled 2"));
        assert!(is_placeholder_title("Untitled-137"));
        assert!(!is_placeholder_title("Untitled draft"));
        assert!(!is_placeholder_title("Untitled2"));
        assert!(!is_placeholder_title("My untitled"));
        // The slug cuts off at 48 chars; the meaningful suffix still counts.
        let long = format!("Untitled {} draft", "1".repeat(40));
        assert!(slugify(&long).len() <= 48);
        assert!(!is_placeholder_title(&long));
        assert!(is_placeholder_title(&format!(
            "Untitled {}",
            "1".repeat(60)
        )));
    }

    #[test]
    fn real_title_past_the_slug_cutoff_finalizes() {
        let store = SessionStore::open_in_memory().unwrap();
        save(&store, "n1", "", false);
        let title = format!("Untitled {} draft", "1".repeat(40));
        let finalized = save(&store, "n1", &title, true);
        assert!(!finalized.slug_pending);
        assert_eq!(finalized.slug, slugify(&title));
    }

    #[test]
    fn empty_title_becomes_untitled() {
        let store = SessionStore::open_in_memory().unwrap();
        let note = upsert(&store, "n1", "   ", "");
        assert_eq!(note.title, "Untitled");
        assert_eq!(note.slug, "untitled");
    }

    #[test]
    fn note_image_names_are_safe_and_keep_supported_extensions() {
        assert_eq!(
            note_image_names(Path::new("/tmp/Architecture draft [2].PNG")).unwrap(),
            (
                "Architecture draft [2].PNG".into(),
                "Architecture-draft--2.png".into()
            )
        );
        assert!(note_image_names(Path::new("/tmp/archive.zip")).is_err());
    }

    #[test]
    fn note_asset_paths_cannot_escape_app_data() {
        assert_eq!(
            validate_note_asset_path("/note-assets/note-1/123-image.png").unwrap(),
            PathBuf::from("note-assets/note-1/123-image.png")
        );
        assert!(validate_note_asset_path("/note-assets/note-1/../secret.png").is_err());
        assert!(validate_note_asset_path("/other/note-1/image.png").is_err());
    }

    /// A throwaway data folder with a "somewhere else" beside it, both gone at the end of the test.
    struct Folders {
        root: PathBuf,
        data: PathBuf,
        elsewhere: PathBuf,
    }

    impl Folders {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "monocode-notes-image-{}",
                uuid::Uuid::new_v4().simple()
            ));
            let data = root.join("data");
            let elsewhere = root.join("elsewhere");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::create_dir_all(&elsewhere).unwrap();
            Self {
                root,
                data,
                elsewhere,
            }
        }

        /// Every file under the data folder's note-assets, with what it holds.
        fn saved(&self) -> Vec<(String, Vec<u8>)> {
            fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
                let Ok(entries) = std::fs::read_dir(dir) else {
                    return;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        walk(base, &path, out);
                    } else {
                        let name = path.strip_prefix(base).unwrap().to_string_lossy();
                        out.push((name.into_owned(), std::fs::read(&path).unwrap()));
                    }
                }
            }
            let mut out = Vec::new();
            let base = self.data.join(NOTE_ASSET_DIR);
            walk(&base, &base, &mut out);
            out
        }
    }

    impl Drop for Folders {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(unix)]
    const PRIVATE_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAPLANTED\n-----END OPENSSH PRIVATE KEY-----";

    #[test]
    fn a_plain_image_is_saved_into_the_notes_folder() {
        let folders = Folders::new();
        let image = folders.elsewhere.join("Mock up.png");
        std::fs::write(&image, [0x89, b'P', b'N', b'G', 1, 2, 3]).unwrap();
        let asset =
            save_note_image_into(&folders.data, "note-1", &image.to_string_lossy()).unwrap();
        assert_eq!(asset.name, "Mock up.png");
        let saved = folders.saved();
        assert_eq!(saved.len(), 1, "{saved:?}");
        assert_eq!(saved[0].1, [0x89, b'P', b'N', b'G', 1, 2, 3]);
        assert!(asset
            .markdown_path
            .starts_with(&format!("/{NOTE_ASSET_DIR}/note-1/")));
    }

    /// Dropping `mockup.png` that is a link to a private key must not copy the key into the notes' pictures: the next
    /// export would carry it out.
    #[cfg(unix)]
    #[test]
    fn an_image_that_is_a_link_is_refused_and_its_target_never_copied() {
        let folders = Folders::new();
        let key = folders.elsewhere.join("id_rsa");
        std::fs::write(&key, PRIVATE_KEY).unwrap();
        let link = folders.elsewhere.join("mockup.png");
        std::os::unix::fs::symlink(&key, &link).unwrap();

        let result = save_note_image_into(&folders.data, "note-1", &link.to_string_lossy());
        assert!(result.is_err(), "a link was followed: {result:?}");
        assert_eq!(
            folders.saved(),
            Vec::<(String, Vec<u8>)>::new(),
            "the key was copied into the notes' pictures"
        );
    }

    /// A copy that finds a file already at its name fails, and the file that was there stays.
    #[test]
    fn a_copy_never_removes_a_file_it_did_not_create() {
        let folders = Folders::new();
        let taken = folders.elsewhere.join("taken.png");
        std::fs::write(&taken, b"mine").unwrap();
        let error = write_new_file(&taken, b"theirs").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&taken).unwrap(), b"mine");
        // A file nobody had is written whole.
        let fresh = folders.elsewhere.join("fresh.png");
        write_new_file(&fresh, b"theirs").unwrap();
        assert_eq!(std::fs::read(&fresh).unwrap(), b"theirs");
    }

    /// A pipe named `x.png` is not a picture, and reading it must not wait for a writer.
    #[cfg(unix)]
    #[test]
    fn an_image_that_is_a_pipe_is_refused() {
        let folders = Folders::new();
        let pipe = folders.elsewhere.join("x.png");
        let c_path = std::ffi::CString::new(pipe.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let data = folders.data.clone();
        let source = pipe.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            let _ = tx.send(save_note_image_into(&data, "note-1", &source).is_err());
        });
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(10)),
            Ok(true),
            "a pipe was waited on or accepted"
        );
        assert!(folders.saved().is_empty());
    }

    /// Larger than the cap is refused, and what is refused leaves nothing behind.
    #[test]
    fn an_image_past_the_size_cap_is_refused_and_leaves_nothing() {
        let folders = Folders::new();
        let big = folders.elsewhere.join("big.png");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(IMAGE_MAX_BYTES + 1).unwrap();
        drop(file);
        let error =
            save_note_image_into(&folders.data, "note-1", &big.to_string_lossy()).unwrap_err();
        assert!(error.contains("too large"), "{error}");
        assert!(folders.saved().is_empty());
    }

    #[test]
    fn delete_removes_the_row() {
        let store = SessionStore::open_in_memory().unwrap();
        upsert(&store, "n1", "Gone", "bye");
        let conn = store.lock_conn().unwrap();
        delete_note(&conn, "n1").unwrap();
        assert!(get_note(&conn, "n1").unwrap().is_none());
        assert!(list_notes(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_notes_edit_keeps_blocks_only_when_the_body_stays() {
        let store = SessionStore::open_in_memory().unwrap();
        upsert(&store, "n1", "Plan", "hello");
        let conn = store.lock_conn().unwrap();
        conn.execute(
            "UPDATE notes SET blocks_json = '[{\"id\":\"b\"}]' WHERE id = 'n1'",
            [],
        )
        .unwrap();
        let same = NoteUpsert {
            id: "n1".into(),
            title: "Plan".into(),
            body: "hello".into(),
            tags: Vec::new(),
            source_session_id: None,
            source_cwd: None,
            finalize_slug: false,
        };
        upsert_note(&conn, &same).unwrap();
        let kept: Option<String> = conn
            .query_row("SELECT blocks_json FROM notes WHERE id = 'n1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept.as_deref(), Some("[{\"id\":\"b\"}]"));
        upsert_note(
            &conn,
            &NoteUpsert {
                body: "changed".into(),
                ..same
            },
        )
        .unwrap();
        let cleared: Option<String> = conn
            .query_row("SELECT blocks_json FROM notes WHERE id = 'n1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(cleared.is_none());
    }

    #[test]
    fn slugify_strips_punctuation() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("***"), "note");
        assert_eq!(slugify("Ä"), "note");
    }
}
