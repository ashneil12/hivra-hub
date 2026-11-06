// SPDX-License-Identifier: Apache-2.0
//
// Translated from Orbit (https://github.com/coollabsio/orbit):
//   apps/server/migrations/0027_page_search_fts.sql
//   apps/server/src/repositories/pages.rs (`fts_query`, `split_marks`, the search SQL)
//   crates/platform/src/integrity.rs (`integrity_check`, `fts5_table`)
// The upstream files do not carry a separate copyright line.
//
// Hivra WP-74: the same FTS5 index on tasks and docs, on rusqlite. Orbit's
// Postgres branch is not included. Chats keep the search they already have.

//! Full-text search for tasks and docs (docs/hivra/work/WP-74-finder.md).
//!
//! Each store keeps a side table of stable INTEGER rowids. A TEXT primary key
//! plus VACUUM can renumber an implicit rowid, which would point an index row
//! at a different record. Triggers keep the index in step. Trash hides a row
//! from queries; it does not delete the index row, so a restore needs no reindex.

#[cfg(test)]
use rusqlite::OptionalExtension;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::session_store::SessionStore;

const SEARCH_LIMIT: i64 = 20;
const SEARCH_MAX_TERMS: usize = 16;
/// Orbit's FEATURES.md also caps a query at 200 characters. `pages.rs` only
/// caps the term count. Both apply here.
const SEARCH_MAX_CHARS: usize = 200;
const SNIPPET_TOKENS: i64 = 24;
const MARK_OPEN: char = '\u{2}';
const MARK_CLOSE: char = '\u{3}';

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexedHit {
    pub id: String,
    pub project: String,
    pub title: String,
    pub snippet: String,
    pub title_highlights: Vec<TextRange>,
    pub snippet_highlights: Vec<TextRange>,
    pub score: f64,
    pub block_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexedSearch {
    pub tasks: Vec<IndexedHit>,
    pub docs: Vec<IndexedHit>,
}

pub(crate) fn ensure_index(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS task_search_rows (
            id INTEGER PRIMARY KEY,
            task_id TEXT NOT NULL UNIQUE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS task_search USING fts5(
            title,
            body,
            tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TABLE IF NOT EXISTS doc_search_rows (
            id INTEGER PRIMARY KEY,
            note_id TEXT NOT NULL UNIQUE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS doc_search USING fts5(
            title,
            body,
            tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS task_search_insert
        AFTER INSERT ON tasks
        BEGIN
            INSERT INTO task_search_rows (task_id) VALUES (NEW.id);
            INSERT INTO task_search (rowid, title, body)
            VALUES (
                (SELECT id FROM task_search_rows WHERE task_id = NEW.id),
                replace(replace(NEW.title, char(2), ''), char(3), ''),
                replace(replace(NEW.description, char(2), ''), char(3), '')
            );
        END;

        CREATE TRIGGER IF NOT EXISTS task_search_update
        AFTER UPDATE OF title, description ON tasks
        WHEN NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description
        BEGIN
            UPDATE task_search
            SET title = replace(replace(NEW.title, char(2), ''), char(3), ''),
                body = replace(replace(NEW.description, char(2), ''), char(3), '')
            WHERE rowid = (SELECT id FROM task_search_rows WHERE task_id = NEW.id);
        END;

        CREATE TRIGGER IF NOT EXISTS task_search_delete
        AFTER DELETE ON tasks
        BEGIN
            DELETE FROM task_search
            WHERE rowid = (SELECT id FROM task_search_rows WHERE task_id = OLD.id);
            DELETE FROM task_search_rows WHERE task_id = OLD.id;
        END;

        CREATE TRIGGER IF NOT EXISTS doc_search_insert
        AFTER INSERT ON notes
        WHEN NEW.content_kind = 'note'
        BEGIN
            INSERT INTO doc_search_rows (note_id) VALUES (NEW.id);
            INSERT INTO doc_search (rowid, title, body)
            VALUES (
                (SELECT id FROM doc_search_rows WHERE note_id = NEW.id),
                replace(replace(COALESCE(NEW.title, ''), char(2), ''), char(3), ''),
                replace(replace(COALESCE(NEW.body, ''), char(2), ''), char(3), '')
            );
        END;

        CREATE TRIGGER IF NOT EXISTS doc_search_update
        AFTER UPDATE OF title, body ON notes
        WHEN NEW.content_kind = 'note'
          AND (NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body)
        BEGIN
            UPDATE doc_search
            SET title = replace(replace(COALESCE(NEW.title, ''), char(2), ''), char(3), ''),
                body = replace(replace(COALESCE(NEW.body, ''), char(2), ''), char(3), '')
            WHERE rowid = (SELECT id FROM doc_search_rows WHERE note_id = NEW.id);
        END;

        CREATE TRIGGER IF NOT EXISTS doc_search_delete
        AFTER DELETE ON notes
        BEGIN
            DELETE FROM doc_search
            WHERE rowid = (SELECT id FROM doc_search_rows WHERE note_id = OLD.id);
            DELETE FROM doc_search_rows WHERE note_id = OLD.id;
        END;
        ",
    )?;
    backfill(conn)
}

fn backfill(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        INSERT OR IGNORE INTO task_search_rows (task_id) SELECT id FROM tasks;
        INSERT INTO task_search (rowid, title, body)
        SELECT
            task_search_rows.id,
            replace(replace(tasks.title, char(2), ''), char(3), ''),
            replace(replace(tasks.description, char(2), ''), char(3), '')
        FROM task_search_rows
        JOIN tasks ON tasks.id = task_search_rows.task_id
        WHERE task_search_rows.id NOT IN (SELECT rowid FROM task_search);

        INSERT OR IGNORE INTO doc_search_rows (note_id)
        SELECT id FROM notes WHERE content_kind = 'note';
        INSERT INTO doc_search (rowid, title, body)
        SELECT
            doc_search_rows.id,
            replace(replace(COALESCE(notes.title, ''), char(2), ''), char(3), ''),
            replace(replace(COALESCE(notes.body, ''), char(2), ''), char(3), '')
        FROM doc_search_rows
        JOIN notes ON notes.id = doc_search_rows.note_id
        WHERE notes.content_kind = 'note'
          AND doc_search_rows.id NOT IN (SELECT rowid FROM doc_search);
        ",
    )
}

/// An FTS5 query from user input, without exposing FTS syntax. Translated from
/// Orbit's `fts_query`: every whitespace-separated word is a quoted string (so
/// `AND`, `NEAR`, `col:`, `-`, `*`, `^` and parentheses are plain text), words
/// without a letter or digit are dropped, the last word is a prefix, and all
/// words must match. `None` when nothing is searchable.
pub(crate) fn fts_query(input: &str) -> Option<String> {
    let input: String = input.chars().take(SEARCH_MAX_CHARS).collect();
    let terms = input
        .split_whitespace()
        .map(|term| term.replace('"', " "))
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .take(SEARCH_MAX_TERMS)
        .collect::<Vec<_>>();
    let last = terms.len().checked_sub(1)?;
    Some(
        terms
            .iter()
            .enumerate()
            .map(|(index, term)| {
                if index == last {
                    format!("\"{term}\"*")
                } else {
                    format!("\"{term}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Removes highlight markers and returns the plain text with the marked spans
/// as UTF-16 ranges. Translated from Orbit's `split_marks`.
pub(crate) fn split_marks(marked: &str) -> (String, Vec<TextRange>) {
    let mut text = String::with_capacity(marked.len());
    let mut ranges = Vec::new();
    let mut offset = 0_u32;
    let mut open = None;
    for c in marked.chars() {
        match c {
            MARK_OPEN => open = Some(offset),
            MARK_CLOSE => {
                if let Some(start) = open.take() {
                    if offset > start {
                        ranges.push(TextRange { start, end: offset });
                    }
                }
            }
            c => {
                text.push(c);
                offset += c.len_utf16() as u32;
            }
        }
    }
    (text, ranges)
}

pub(crate) fn search(conn: &Connection, query: &str) -> rusqlite::Result<IndexedSearch> {
    let Some(expression) = fts_query(query) else {
        return Ok(IndexedSearch {
            tasks: Vec::new(),
            docs: Vec::new(),
        });
    };
    let tasks = search_tasks(conn, &expression)?;
    let docs = search_docs(conn, &expression, query)?;
    Ok(IndexedSearch { tasks, docs })
}

fn search_tasks(conn: &Connection, expression: &str) -> rusqlite::Result<Vec<IndexedHit>> {
    let mut statement = conn.prepare(
        "SELECT tasks.id AS id, tasks.project_id AS project, tasks.title AS title,
                tasks.updated_at AS updated_at,
                highlight(task_search, 0, char(2), char(3)) AS marked_title,
                snippet(task_search, 1, char(2), char(3), '…', ?1) AS marked_snippet,
                bm25(task_search, 10.0, 1.0) AS rank
         FROM task_search
         JOIN task_search_rows ON task_search_rows.id = task_search.rowid
         JOIN tasks ON tasks.id = task_search_rows.task_id
         WHERE task_search MATCH ?2 AND tasks.trashed_at IS NULL
         ORDER BY bm25(task_search, 10.0, 1.0), tasks.updated_at DESC, tasks.id DESC
         LIMIT ?3",
    )?;
    let rows = statement.query_map(params![SNIPPET_TOKENS, expression, SEARCH_LIMIT], |row| {
        hit_from_row(row, 4, 5, 6, None)
    })?;
    rows.collect()
}

fn search_docs(
    conn: &Connection,
    expression: &str,
    query: &str,
) -> rusqlite::Result<Vec<IndexedHit>> {
    let terms = block_terms(query);
    let mut statement = conn.prepare(
        "SELECT notes.id AS id, COALESCE(notes.source_cwd, '') AS project, notes.title AS title,
                notes.updated_at AS updated_at, notes.blocks_json AS blocks_json,
                highlight(doc_search, 0, char(2), char(3)) AS marked_title,
                snippet(doc_search, 1, char(2), char(3), '…', ?1) AS marked_snippet,
                bm25(doc_search, 10.0, 1.0) AS rank
         FROM doc_search
         JOIN doc_search_rows ON doc_search_rows.id = doc_search.rowid
         JOIN notes ON notes.id = doc_search_rows.note_id
         WHERE doc_search MATCH ?2 AND notes.trashed_at IS NULL AND notes.content_kind = 'note'
         ORDER BY bm25(doc_search, 10.0, 1.0), notes.updated_at DESC, notes.id DESC
         LIMIT ?3",
    )?;
    let rows = statement.query_map(params![SNIPPET_TOKENS, expression, SEARCH_LIMIT], |row| {
        let blocks: Option<String> = row.get(4)?;
        let block_id = blocks
            .as_deref()
            .and_then(|json| matching_block(json, &terms));
        hit_from_row(row, 5, 6, 7, block_id)
    })?;
    rows.collect()
}

fn hit_from_row(
    row: &rusqlite::Row<'_>,
    title_at: usize,
    snippet_at: usize,
    rank_at: usize,
    block_id: Option<String>,
) -> rusqlite::Result<IndexedHit> {
    let title: String = row.get(2)?;
    let marked_title: String = row.get::<_, Option<String>>(title_at)?.unwrap_or_default();
    let marked_snippet: String = row
        .get::<_, Option<String>>(snippet_at)?
        .unwrap_or_default();
    let rank: f64 = row.get(rank_at)?;
    let (marked_plain, title_highlights) = split_marks(&marked_title);
    let (snippet, snippet_highlights) = split_marks(&marked_snippet);
    let title_highlights = if marked_plain == title {
        title_highlights
    } else {
        Vec::new()
    };
    Ok(IndexedHit {
        id: row.get(0)?,
        project: row.get(1)?,
        title,
        snippet,
        title_highlights,
        snippet_highlights,
        score: positive_score(rank),
        block_id,
        updated_at: row.get(3)?,
    })
}

fn positive_score(rank: f64) -> f64 {
    if rank.is_finite() {
        -rank
    } else {
        0.0
    }
}

fn block_terms(input: &str) -> Vec<String> {
    let input: String = input.chars().take(SEARCH_MAX_CHARS).collect();
    input
        .split_whitespace()
        .flat_map(|term| {
            term.replace('"', " ")
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .take(SEARCH_MAX_TERMS)
        .map(|term| term.to_lowercase())
        .collect()
}

/// The first block whose text contains every query term. A block that has only
/// one of them is not the match. Invalid JSON is no block, not a failed search.
/// A title-only hit, or terms split across blocks, has no block id.
fn matching_block(json: &str, terms: &[String]) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    find_block(&value, terms)
}

fn find_block(value: &serde_json::Value, terms: &[String]) -> Option<String> {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(id) = find_block(item, terms) {
                    return Some(id);
                }
            }
            None
        }
        serde_json::Value::Object(map) => {
            let text = block_plain(map);
            let id = map
                .get("id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty());
            if let Some(id) = id {
                let lower = text.to_lowercase();
                if !text.is_empty() && terms.iter().all(|term| lower.contains(term.as_str())) {
                    return Some(id.to_string());
                }
            }
            map.get("children")
                .and_then(|children| find_block(children, terms))
        }
        _ => None,
    }
}

fn block_plain(map: &serde_json::Map<String, serde_json::Value>) -> String {
    let Some(content) = map.get("content").and_then(serde_json::Value::as_array) else {
        return String::new();
    };
    let mut text = String::new();
    for part in content {
        let Some(part) = part.as_object() else {
            continue;
        };
        match part.get("type").and_then(serde_json::Value::as_str) {
            Some("text") => {
                if let Some(piece) = part.get("text").and_then(serde_json::Value::as_str) {
                    text.push_str(piece);
                }
            }
            Some("link") => {
                if let Some(inner) = part.get("content").and_then(serde_json::Value::as_array) {
                    for item in inner {
                        if let Some(piece) = item.get("text").and_then(serde_json::Value::as_str) {
                            text.push_str(piece);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    text
}

/// `PRAGMA integrity_check`, except that an FTS5 "malformed inverted index"
/// line is confirmed with FTS5's own `integrity-check`. Orbit saw SQLite 3.46.0
/// report that after a row was updated twice, or after a rebuild, while the
/// index was fine. 3.46.1 stopped reporting it. This tree bundles SQLite 3.53.2
/// (`libsqlite3-sys` 0.38.2), so startup and ship keep the raw pragma. A real
/// failure of FTS5's own check still fails. Translated from Orbit's
/// `integrity_check`.
#[cfg(test)]
pub(crate) fn integrity(conn: &Connection) -> Result<(), String> {
    let mut statement = conn
        .prepare("PRAGMA integrity_check")
        .map_err(|error| error.to_string())?;
    let results: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    classify_integrity(&results, |schema, table| fts5_confirms(conn, schema, table))
}

#[cfg(test)]
fn classify_integrity(
    results: &[String],
    mut confirm: impl FnMut(&str, &str) -> bool,
) -> Result<(), String> {
    if results.len() == 1 && results[0].eq_ignore_ascii_case("ok") {
        return Ok(());
    }
    let mut remaining = Vec::new();
    for line in results {
        match fts5_table(line) {
            Some((schema, table)) => {
                if !confirm(schema, table) {
                    remaining.push(line.clone());
                }
            }
            None => remaining.push(line.clone()),
        }
    }
    if remaining.is_empty() {
        Ok(())
    } else {
        Err(remaining.join("; "))
    }
}

#[cfg(test)]
fn fts5_confirms(conn: &Connection, schema: &str, table: &str) -> bool {
    let line = format!("malformed inverted index for FTS5 table {schema}.{table}");
    let Some((schema, table)) = fts5_table(&line) else {
        return false;
    };
    let command =
        format!("INSERT INTO \"{schema}\".\"{table}\"(\"{table}\") VALUES ('integrity-check')");
    conn.execute_batch(&command).is_ok()
}

/// `(schema, table)` of an FTS5 index finding. Only plain identifiers, so the
/// confirmation statement cannot be shaped by a pragma line.
#[cfg(test)]
fn fts5_table(line: &str) -> Option<(&str, &str)> {
    let name = line.strip_prefix("malformed inverted index for FTS5 table ")?;
    let (schema, table) = name.split_once('.')?;
    let plain = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    };
    (plain(schema) && plain(table)).then_some((schema, table))
}

#[cfg(test)]
pub(crate) fn task_rowid(conn: &Connection, task_id: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT id FROM task_search_rows WHERE task_id = ?1",
        params![task_id],
        |row| row.get(0),
    )
    .optional()
}

#[cfg(test)]
pub(crate) fn doc_rowid(conn: &Connection, note_id: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT id FROM doc_search_rows WHERE note_id = ?1",
        params![note_id],
        |row| row.get(0),
    )
    .optional()
}

#[tauri::command(async)]
pub fn finder_search(
    store: State<'_, SessionStore>,
    query: String,
) -> Result<IndexedSearch, String> {
    let conn = store.lock_conn()?;
    search(&conn, &query).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::{create_doc, move_doc, trash_doc, update_doc, DocCreate, DocMove, DocUpdate};
    use crate::tasks::store::{create, update, Actor, CreateInput, UpdateInput};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn person(project: &str) -> Actor {
        Actor {
            id: "person".into(),
            project: project.into(),
            kind: "person".into(),
        }
    }

    /// A folder name nothing has used before: process id, a counter and the clock. The old name (id and counter
    /// only) was reused by a later run whose process got the same id, so its first database opened with the
    /// rows an earlier run had left in the folder, and four tests counted twice what they had put in.
    fn fresh_dir() -> std::path::PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "hivra-wp74-finder-{}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed),
            nanos
        ))
    }

    fn fresh() -> Connection {
        let dir = fresh_dir();
        // A folder with this name can only be left over; start from nothing.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("finder.db")).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        crate::notes::ensure_notes_table(&conn).unwrap();
        crate::tasks::ensure_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn a_leftover_folder_from_an_earlier_run_is_never_reused() {
        let pid = std::process::id();
        // What the old naming would have picked for the first database of a later run with this process id.
        let stale = std::env::temp_dir().join(format!("hivra-wp74-finder-{pid}-0"));
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("finder.db"), b"left over from an earlier run").unwrap();
        let names: Vec<_> = (0..3).map(|_| fresh_dir()).collect();
        let _ = std::fs::remove_dir_all(&stale);
        for (i, name) in names.iter().enumerate() {
            assert_ne!(name, &stale, "the folder name repeats an earlier run's");
            assert!(!name.exists(), "a new folder name already exists");
            assert!(!names[..i].contains(name), "two databases got one folder");
        }
    }

    fn indexed() -> Connection {
        let conn = fresh();
        ensure_index(&conn).unwrap();
        conn
    }

    fn make_task(
        conn: &mut Connection,
        project: &str,
        title: &str,
        parent: Option<&str>,
    ) -> String {
        create(
            conn,
            &person(project),
            &CreateInput {
                title: title.into(),
                parent_id: parent.map(str::to_string),
                ..Default::default()
            },
            1,
        )
        .unwrap()
        .task
        .id
    }

    fn doc_input(id: &str, title: &str, body: &str, blocks: &str, cwd: &str) -> DocCreate {
        DocCreate {
            id: id.into(),
            title: title.into(),
            body: body.into(),
            blocks_json: Some(blocks.into()),
            tags: Vec::new(),
            source_cwd: Some(cwd.into()),
            source_session_id: None,
            parent_id: None,
            origin: "person".into(),
            author_id: String::new(),
            author_name: String::new(),
        }
    }

    #[test]
    fn fts_query_quotes_syntax_and_drops_empty_words() {
        assert_eq!(fts_query("side"), Some("\"side\"*".into()));
        assert_eq!(fts_query("fix side"), Some("\"fix\" \"side\"*".into()));
        assert_eq!(fts_query("AND"), Some("\"AND\"*".into()));
        assert_eq!(fts_query("foo:bar"), Some("\"foo:bar\"*".into()));
        assert_eq!(fts_query("*"), None);
        assert_eq!(fts_query(""), None);
        assert_eq!(fts_query("   "), None);
        assert_eq!(fts_query("\""), None);
        assert_eq!(fts_query("fix\r\nside"), Some("\"fix\" \"side\"*".into()));
        let long = "w ".repeat(40);
        let built = fts_query(&long).unwrap();
        assert_eq!(built.split_whitespace().count(), 16);
        let wide = "x".repeat(500);
        assert!(fts_query(&wide).unwrap().chars().count() < 220);
    }

    #[test]
    fn split_marks_uses_utf16_offsets() {
        let (text, ranges) = split_marks("a\u{2}\u{1F600}\u{3}b");
        assert_eq!(text, "a😀b");
        assert_eq!(ranges, vec![TextRange { start: 1, end: 3 }]);
        let (text, ranges) = split_marks("\u{2}\u{3}plain");
        assert_eq!(text, "plain");
        assert!(ranges.is_empty());
    }

    #[test]
    fn fts5_table_rejects_anything_that_is_not_a_plain_name() {
        assert_eq!(
            fts5_table("malformed inverted index for FTS5 table main.task_search"),
            Some(("main", "task_search"))
        );
        assert_eq!(
            fts5_table("malformed inverted index for FTS5 table main.task_search extra"),
            None
        );
        assert_eq!(fts5_table("database disk image is malformed"), None);
        assert_eq!(
            fts5_table("malformed inverted index for FTS5 table .task"),
            None
        );
        assert_eq!(
            fts5_table("malformed inverted index for FTS5 table main."),
            None
        );
        assert_eq!(
            fts5_table("malformed inverted index for FTS5 table main.task\"search"),
            None
        );
    }

    #[test]
    fn a_non_fts_integrity_line_still_fails() {
        let err = classify_integrity(&["database disk image is malformed".into()], |_, _| true)
            .unwrap_err();
        assert!(err.contains("disk image"));
        assert!(classify_integrity(&["ok".into()], |_, _| false).is_ok());
        assert!(classify_integrity(
            &["malformed inverted index for FTS5 table main.task_search".into()],
            |_, _| true
        )
        .is_ok());
        assert!(classify_integrity(
            &["malformed inverted index for FTS5 table main.task_search".into()],
            |_, _| false
        )
        .is_err());
    }

    #[test]
    fn a_task_stays_in_step_through_edit_move_and_trash() {
        let mut conn = indexed();
        let project = r"C:\Work\My Project";
        let id = make_task(&mut conn, project, "Fix the sidebar", None);
        let parent = make_task(&mut conn, project, "Parent", None);
        let found = search(&conn, "side").unwrap();
        assert_eq!(found.tasks.len(), 1);
        assert_eq!(found.tasks[0].id, id);
        assert_eq!(found.tasks[0].project, project);
        assert!(found.tasks[0].score > 0.0);
        let rowid = task_rowid(&conn, &id).unwrap();

        update(
            &mut conn,
            &person(project),
            &UpdateInput {
                id: id.clone(),
                version: Some(1),
                title: Some("Repair the header".into()),
                ..Default::default()
            },
            2,
        )
        .unwrap();
        assert!(search(&conn, "side").unwrap().tasks.is_empty());
        assert_eq!(search(&conn, "header").unwrap().tasks[0].id, id);

        update(
            &mut conn,
            &person(project),
            &UpdateInput {
                id: id.clone(),
                version: Some(2),
                parent: crate::tasks::store::Set::Value(parent),
                ..Default::default()
            },
            3,
        )
        .unwrap();
        assert_eq!(search(&conn, "header").unwrap().tasks[0].id, id);
        assert_eq!(task_rowid(&conn, &id).unwrap(), rowid);

        update(
            &mut conn,
            &person(project),
            &UpdateInput {
                id: id.clone(),
                version: Some(3),
                trash: true,
                ..Default::default()
            },
            4,
        )
        .unwrap();
        assert!(search(&conn, "header").unwrap().tasks.is_empty());
        assert!(task_rowid(&conn, &id).unwrap().is_some());
        conn.execute(
            "UPDATE tasks SET trashed_at = NULL WHERE id = ?1",
            params![id],
        )
        .unwrap();
        assert_eq!(search(&conn, "header").unwrap().tasks[0].id, id);

        conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])
            .unwrap();
        assert!(search(&conn, "header").unwrap().tasks.is_empty());
        assert!(task_rowid(&conn, &id).unwrap().is_none());
    }

    #[test]
    fn a_doc_stays_in_step_and_names_the_block() {
        let conn = indexed();
        let blocks = r#"[{"id":"block-9","type":"paragraph","props":{},"content":[{"type":"text","text":"sidebar layout","styles":{}}],"children":[]}]"#;
        create_doc(
            &conn,
            &doc_input(
                "page-1",
                "Notes",
                "Fix the sidebar layout",
                blocks,
                "/work/proj",
            ),
        )
        .unwrap();
        let hit = &search(&conn, "side").unwrap().docs[0];
        assert_eq!(hit.id, "page-1");
        assert_eq!(hit.block_id.as_deref(), Some("block-9"));
        assert_eq!(hit.project, "/work/proj");
        let rowid = doc_rowid(&conn, "page-1").unwrap();

        update_doc(
            &conn,
            &DocUpdate {
                id: "page-1".into(),
                title: "Notes".into(),
                body: "Repair the header".into(),
                blocks_json: Some("[]".into()),
                expected_version: 1,
                snapshot: false,
                origin: "person".into(),
                author_id: String::new(),
                author_name: String::new(),
                tags: None,
            },
        )
        .unwrap();
        assert!(search(&conn, "side").unwrap().docs.is_empty());
        let hit = &search(&conn, "header").unwrap().docs[0];
        assert!(hit.block_id.is_none());

        create_doc(
            &conn,
            &doc_input("page-2", "Other", "Somewhere else", "[]", "/work/proj"),
        )
        .unwrap();
        let moved = move_doc(
            &conn,
            &DocMove {
                id: "page-1".into(),
                parent_id: Some("page-2".into()),
                index: 0,
                expected_version: 2,
                sibling_ids: Vec::new(),
            },
        )
        .unwrap();
        assert!(matches!(moved, crate::docs::DocWrite::Saved { .. }));
        assert_eq!(search(&conn, "header").unwrap().docs[0].id, "page-1");
        assert_eq!(doc_rowid(&conn, "page-1").unwrap(), rowid);

        trash_doc(&conn, "page-1").unwrap();
        assert!(search(&conn, "header").unwrap().docs.is_empty());
        conn.execute("UPDATE notes SET trashed_at = NULL WHERE id = 'page-1'", [])
            .unwrap();
        assert_eq!(search(&conn, "header").unwrap().docs[0].id, "page-1");
        conn.execute("DELETE FROM notes WHERE id = 'page-1'", [])
            .unwrap();
        assert!(search(&conn, "header").unwrap().docs.is_empty());
        assert!(doc_rowid(&conn, "page-1").unwrap().is_none());
    }

    #[test]
    fn diacritics_markers_and_fts_syntax_do_not_match_everything() {
        let mut conn = indexed();
        make_task(&mut conn, "proj", "Über den Fluss", None);
        assert_eq!(search(&conn, "uber").unwrap().tasks.len(), 1);
        assert!(search(&conn, "AND").unwrap().tasks.is_empty());
        assert!(search(&conn, "*").unwrap().tasks.is_empty());
        assert!(search(&conn, "foo:bar").unwrap().tasks.is_empty());
        assert!(search(&conn, "").unwrap().tasks.is_empty());
        conn.execute(
            "INSERT INTO tasks (id, project_id, number, title, description, status_id, sort_key, source, created_by, created_at, updated_at)
             VALUES ('marked', 'proj', 9, 'side\u{2}bar', '', 'backlog', 'a', 'person', 'person', 1, 1)",
            [],
        )
        .unwrap();
        let hit = &search(&conn, "sidebar").unwrap().tasks[0];
        assert_eq!(hit.id, "marked");
        let indexed: String = conn
            .query_row(
                "SELECT task_search.title FROM task_search
                 JOIN task_search_rows ON task_search_rows.id = task_search.rowid
                 WHERE task_search_rows.task_id = 'marked'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!indexed.contains('\u{2}'));
    }

    #[test]
    fn backfill_indexes_rows_written_before_the_index() {
        let mut conn = fresh();
        let id = make_task(&mut conn, "proj", "Written early", None);
        ensure_index(&conn).unwrap();
        ensure_index(&conn).unwrap();
        let found = search(&conn, "early").unwrap();
        assert_eq!(found.tasks.len(), 1);
        assert_eq!(found.tasks[0].id, id);
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM task_search_rows WHERE task_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn an_uncommitted_edit_is_not_visible_to_the_other_window() {
        let mut writer = indexed();
        let path = writer.path().unwrap().to_string();
        let id = make_task(&mut writer, "proj", "alpha word", None);
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        writer
            .execute(
                "UPDATE tasks SET title = 'beta word' WHERE id = ?1",
                params![id],
            )
            .unwrap();
        let reader = Connection::open(&path).unwrap();
        reader
            .busy_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert!(search(&reader, "beta").unwrap().tasks.is_empty());
        assert_eq!(search(&reader, "alpha").unwrap().tasks[0].id, id);
        writer.execute_batch("COMMIT").unwrap();
        assert_eq!(search(&reader, "beta").unwrap().tasks[0].id, id);
        assert!(search(&reader, "alpha").unwrap().tasks.is_empty());
    }

    #[test]
    fn invalid_blocks_do_not_fail_the_search() {
        let conn = indexed();
        create_doc(
            &conn,
            &doc_input(
                "page-3",
                "Broken",
                "findme in the title",
                "[]",
                "/work/proj",
            ),
        )
        .unwrap();
        conn.execute(
            "UPDATE notes SET blocks_json = 'not json' WHERE id = 'page-3'",
            [],
        )
        .unwrap();
        let hit = &search(&conn, "findme").unwrap().docs[0];
        assert!(hit.block_id.is_none());
    }

    #[test]
    fn a_doc_opens_on_the_block_that_contains_every_term() {
        let conn = indexed();
        let blocks = r#"[{"id":"block-1","type":"paragraph","props":{},"content":[{"type":"text","text":"Only the layout","styles":{}}],"children":[]},{"id":"block-2","type":"paragraph","props":{},"content":[{"type":"text","text":"The sidebar layout lives here","styles":{}}],"children":[]}]"#;
        create_doc(
            &conn,
            &doc_input(
                "page-split",
                "Notes",
                "sidebar layout",
                blocks,
                "/work/proj",
            ),
        )
        .unwrap();
        let hit = &search(&conn, "sidebar layout").unwrap().docs[0];
        assert_eq!(hit.id, "page-split");
        assert_eq!(hit.block_id.as_deref(), Some("block-2"));

        let split = r#"[{"id":"block-a","type":"paragraph","props":{},"content":[{"type":"text","text":"sidebar only","styles":{}}],"children":[]},{"id":"block-b","type":"paragraph","props":{},"content":[{"type":"text","text":"layout only","styles":{}}],"children":[]}]"#;
        create_doc(
            &conn,
            &doc_input("page-parts", "Parts", "sidebar layout", split, "/work/proj"),
        )
        .unwrap();
        let parts = search(&conn, "sidebar layout")
            .unwrap()
            .docs
            .into_iter()
            .find(|doc| doc.id == "page-parts")
            .unwrap();
        assert!(parts.block_id.is_none());
    }

    #[test]
    fn integrity_passes_after_a_row_is_updated_twice() {
        let mut conn = indexed();
        let id = make_task(&mut conn, "proj", "One", None);
        update(
            &mut conn,
            &person("proj"),
            &UpdateInput {
                id: id.clone(),
                version: Some(1),
                title: Some("Two".into()),
                ..Default::default()
            },
            2,
        )
        .unwrap();
        update(
            &mut conn,
            &person("proj"),
            &UpdateInput {
                id,
                version: Some(2),
                title: Some("Three".into()),
                ..Default::default()
            },
            3,
        )
        .unwrap();
        integrity(&conn).unwrap();
    }
}
