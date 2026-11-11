//! WP-176: the app's own spend ledger. One row per turn, written when the turn ends, with the project it belongs to
//! and whether its price was reported. Chat delete and trash never touch it, so a limit cannot be lowered by removing
//! a chat. Nothing here estimates a price: `micros` is the CLI's measured cost, and `priced` is 0 when none was reported.

use std::process::Command;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::session_store::SessionStore;

const MAX_TEXT: usize = 4096;
/// One turn can cost this much at most. A larger figure is refused rather than stored.
const MAX_MICROS: i64 = 1_000_000_000_000_000;

/// The limits book could not be read or judged, so an automated turn is held.
const BOOK_UNREADABLE: &str = "The spend limits could not be read, so this automated run is held.";

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Refuses an automated turn (here: a first mate's verdict) when the app's limit, or the project's own limit, is
/// reached on the ledger. A book that is missing its shape is unreadable, so it holds too. Nothing is written.
pub fn admit_automated(conn: &Connection, project: Option<&str>, now: i64) -> Result<(), String> {
    let Some((_, body)) = read_book(conn)? else {
        return Ok(());
    };
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| BOOK_UNREADABLE.to_string())?;
    let limits = value
        .get("limits")
        .and_then(|v| v.as_array())
        .ok_or_else(|| BOOK_UNREADABLE.to_string())?;
    for limit in limits {
        let scope = limit.get("scope").and_then(|v| v.as_str()).unwrap_or("");
        let period = limit.get("period").and_then(|v| v.as_str()).unwrap_or("");
        let amount = limit
            .get("amountUsd")
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite() && *v > 0.0)
            .ok_or_else(|| BOOK_UNREADABLE.to_string())?;
        let since: i64 = conn
            .query_row(
                "SELECT CAST(strftime('%s', ?1 / 1000, 'unixepoch', 'localtime', ?2, 'utc') AS INTEGER) * 1000",
                params![now, match period {
                    "day" => "start of day",
                    "month" => "start of month",
                    _ => return Err(BOOK_UNREADABLE.to_string()),
                }],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let spent: i64 = match scope {
            "app" => conn.query_row(
                "SELECT COALESCE(SUM(micros), 0) FROM spend_ledger WHERE at >= ?1",
                params![since],
                |row| row.get(0),
            ),
            "project" => {
                let Some(project) = project else { continue };
                if limit.get("project").and_then(|v| v.as_str()) != Some(project) {
                    continue;
                }
                conn.query_row(
                    "SELECT COALESCE(SUM(micros), 0) FROM spend_ledger WHERE at >= ?1 AND project_key = ?2",
                    params![since, project],
                    |row| row.get(0),
                )
            }
            _ => return Err(BOOK_UNREADABLE.to_string()),
        }
        .map_err(|e| e.to_string())?;
        let cap = (amount * 1_000_000.0).round() as i64;
        if spent >= cap {
            return Err(format!(
                "Spend limit reached: ${:.2} of ${:.2} this {}. This automated run is held.",
                spent as f64 / 1_000_000.0,
                amount,
                if period == "day" { "day" } else { "month" }
            ));
        }
    }
    Ok(())
}

/// Notes an automated call whose cost is not reported (a verdict): it is counted as unpriced and adds no money.
pub fn note_unpriced(conn: &Connection, project: &str, now: i64) -> Result<(), String> {
    append(
        conn,
        &TurnEntry {
            session_id: format!("verdict-{}", uuid::Uuid::new_v4()),
            project_key: project.to_string(),
            at: now,
            micros: 0,
            priced: false,
        },
    )
}

#[tauri::command(async)]
pub fn spend_redo_links(
    store: State<'_, SessionStore>,
) -> Result<Vec<crate::delegations::RedoLink>, String> {
    let conn = store.lock_conn()?;
    crate::delegations::redo_links(&conn)
}

pub fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS spend_ledger (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           session_id TEXT NOT NULL,
           project_key TEXT NOT NULL,
           at INTEGER NOT NULL,
           micros INTEGER NOT NULL,
           priced INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS spend_ledger_at ON spend_ledger(at);
         CREATE TRIGGER IF NOT EXISTS spend_ledger_no_update BEFORE UPDATE ON spend_ledger
           BEGIN SELECT RAISE(ABORT, 'The spend ledger is append-only.'); END;
         CREATE TRIGGER IF NOT EXISTS spend_ledger_no_delete BEFORE DELETE ON spend_ledger
           BEGIN SELECT RAISE(ABORT, 'The spend ledger is append-only.'); END;
         CREATE TABLE IF NOT EXISTS spend_limit_book (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           revision INTEGER NOT NULL,
           body TEXT NOT NULL
         );",
    )
}

/// The largest saved book the app accepts. A limits book is a short list; anything bigger is not written.
const MAX_BOOK: usize = 1_000_000;

/// The stored limits book: its revision and its JSON text. None until a book was first saved.
pub fn read_book(conn: &Connection) -> Result<Option<(i64, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT revision, body FROM spend_limit_book WHERE id = 1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => row.map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// Saves the book only when the stored revision is still `expected` (0 when no book is stored). The body must be a JSON
/// object that names the same revision, so the row cannot say one thing and hold another.
pub fn write_book(
    conn: &Connection,
    expected: i64,
    revision: i64,
    body: &str,
) -> Result<(), String> {
    if body.len() > MAX_BOOK {
        return Err("The spend limits are too large to save.".into());
    }
    if revision <= expected || revision < 1 {
        return Err("The spend limits revision does not move forward.".into());
    }
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "The spend limits are not a readable book.".to_string())?;
    if value.get("revision").and_then(|v| v.as_i64()) != Some(revision) {
        return Err("The spend limits revision does not match the book.".into());
    }
    let changed = conn
        .execute(
            "INSERT INTO spend_limit_book (id, revision, body) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, body = excluded.body
               WHERE spend_limit_book.revision = ?3",
            params![revision, body, expected],
        )
        .map_err(|e| e.to_string())?;
    if changed == 1 {
        Ok(())
    } else {
        Err("The spend limits changed in another window. Reload them before saving.".into())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnEntry {
    pub session_id: String,
    pub project_key: String,
    pub at: i64,
    pub micros: i64,
    pub priced: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DayTotal {
    pub project_key: String,
    pub session_id: String,
    pub day: String,
    pub micros: i64,
    pub priced: i64,
    pub unpriced: i64,
}

fn clean(entry: &TurnEntry) -> Result<(), String> {
    if entry.session_id.trim().is_empty() || entry.session_id.len() > MAX_TEXT {
        return Err("The turn has no session.".into());
    }
    if entry.project_key.trim().is_empty() || entry.project_key.len() > MAX_TEXT {
        return Err("The turn has no project.".into());
    }
    if entry.micros < 0 || entry.micros > MAX_MICROS || entry.at <= 0 {
        return Err("The turn's cost is not a usable amount.".into());
    }
    Ok(())
}

pub fn append(conn: &Connection, entry: &TurnEntry) -> Result<(), String> {
    clean(entry)?;
    conn.execute(
        "INSERT INTO spend_ledger (session_id, project_key, at, micros, priced) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            entry.session_id,
            entry.project_key,
            entry.at,
            entry.micros,
            if entry.priced { 1 } else { 0 }
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Per project, session and local day, from `since` on. Unpriced turns are counted apart, never added as $0.
pub fn totals(conn: &Connection, since: i64) -> Result<Vec<DayTotal>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT project_key, session_id,
                    strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS day,
                    SUM(micros), SUM(priced), SUM(1 - priced)
               FROM spend_ledger WHERE at >= ?1
              GROUP BY project_key, session_id, day
              ORDER BY project_key, session_id, day",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![since], |row| {
            Ok(DayTotal {
                project_key: row.get(0)?,
                session_id: row.get(1)?,
                day: row.get(2)?,
                micros: row.get(3)?,
                priced: row.get(4)?,
                unpriced: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The project a working copy belongs to: the main checkout, for a worktree, a pool slot or the checkout itself.
/// A bare repository's common dir is its own folder. Falls back to the copy's own folder when git says nothing.
pub fn project_folder_for(cwd: &str) -> String {
    let text = cwd.trim();
    if text.is_empty() {
        return String::new();
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(text)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let common = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if common.is_empty() {
                return canonical_or_as_written(text);
            }
            match common.strip_suffix("/.git") {
                Some(parent) if !parent.is_empty() => parent.to_string(),
                _ => common,
            }
        }
        _ => canonical_or_as_written(text),
    }
}

/// The real path of a folder (symlinks resolved, so /var and /private/var are one folder). As written when it cannot be
/// resolved, so a missing folder still compares as the text it was given.
fn canonical_or_as_written(text: &str) -> String {
    std::fs::canonicalize(text)
        .ok()
        .and_then(|path| path.to_str().map(str::to_string))
        .unwrap_or_else(|| text.to_string())
}

#[tauri::command(async)]
pub fn spend_project_folder(cwd: String) -> Result<String, String> {
    Ok(project_folder_for(&cwd))
}

#[tauri::command(async)]
pub fn spend_ledger_append(store: State<'_, SessionStore>, entry: TurnEntry) -> Result<(), String> {
    let conn = store.lock_conn()?;
    append(&conn, &entry)
}

/// The stored book as the app's database holds it: its revision and its JSON text.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookRow {
    pub revision: i64,
    pub body: String,
}

#[tauri::command(async)]
pub fn spend_book_read(store: State<'_, SessionStore>) -> Result<Option<BookRow>, String> {
    let conn = store.lock_conn()?;
    Ok(read_book(&conn)?.map(|(revision, body)| BookRow { revision, body }))
}

#[tauri::command(async)]
pub fn spend_book_write(
    store: State<'_, SessionStore>,
    expected: i64,
    revision: i64,
    body: String,
) -> Result<(), String> {
    let conn = store.lock_conn()?;
    write_book(&conn, expected, revision, &body)
}

#[tauri::command(async)]
pub fn spend_ledger_totals(
    store: State<'_, SessionStore>,
    since: i64,
) -> Result<Vec<DayTotal>, String> {
    let conn = store.lock_conn()?;
    totals(&conn, since)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_table(&conn).unwrap();
        conn
    }

    fn turn(session: &str, project: &str, at: i64, micros: i64, priced: bool) -> TurnEntry {
        TurnEntry {
            session_id: session.into(),
            project_key: project.into(),
            at,
            micros,
            priced,
        }
    }

    #[test]
    fn totals_sum_by_project_session_and_day_and_count_unpriced_apart() {
        let conn = db();
        let day = 1_700_000_000_000;
        append(&conn, &turn("a", "hivra", day, 2_000_000, true)).unwrap();
        append(&conn, &turn("a", "hivra", day + 1_000, 0, false)).unwrap();
        append(&conn, &turn("b", "hivra", day, 3_000_000, true)).unwrap();
        append(&conn, &turn("c", "other", day, 9_000_000, true)).unwrap();
        let rows = totals(&conn, 0).unwrap();
        let a = rows
            .iter()
            .find(|row| row.project_key == "hivra" && row.session_id == "a")
            .unwrap();
        assert_eq!(a.micros, 2_000_000);
        assert_eq!(a.priced, 1);
        assert_eq!(a.unpriced, 1);
        assert_eq!(
            rows.iter()
                .filter(|row| row.project_key == "hivra")
                .map(|row| row.micros)
                .sum::<i64>(),
            5_000_000
        );
    }

    #[test]
    fn a_turn_is_kept_when_its_chat_is_gone_and_a_window_cuts_older_turns() {
        let conn = db();
        append(
            &conn,
            &turn("gone-chat", "hivra", 1_700_000_000_000, 4_000_000, true),
        )
        .unwrap();
        // The ledger has no link back to a chat row, so deleting one cannot reduce it.
        assert_eq!(totals(&conn, 1_700_000_000_000).unwrap().len(), 1);
        assert!(totals(&conn, 1_700_000_001_000).unwrap().is_empty());
    }

    #[test]
    fn a_broken_entry_is_refused_and_nothing_is_stored() {
        let conn = db();
        assert!(append(&conn, &turn("", "hivra", 1, 1, true)).is_err());
        assert!(append(&conn, &turn("a", "", 1, 1, true)).is_err());
        assert!(append(&conn, &turn("a", "hivra", 1, -1, true)).is_err());
        assert!(append(&conn, &turn("a", "hivra", 1, MAX_MICROS + 1, true)).is_err());
        assert!(totals(&conn, 0).unwrap().is_empty());
    }

    #[test]
    fn the_ledger_refuses_an_update_or_a_delete() {
        // WP-176 round 3: a recorded turn is append-only. Neither a reader nor a later write may rewrite or remove it.
        let conn = db();
        append(
            &conn,
            &turn("a", "hivra", 1_700_000_000_000, 2_000_000, true),
        )
        .unwrap();
        assert!(conn
            .execute("UPDATE spend_ledger SET micros = 0", [])
            .is_err());
        assert!(conn.execute("DELETE FROM spend_ledger", []).is_err());
        assert_eq!(totals(&conn, 0).unwrap()[0].micros, 2_000_000);
    }

    #[test]
    fn the_limits_book_saves_only_over_the_revision_it_read() {
        // WP-176 round 3: the book lives in the app database. A write must name the revision it replaces, so two
        // windows cannot both save over the same one, and a missing row is revision 0.
        let conn = db();
        assert!(read_book(&conn).unwrap().is_none());
        write_book(&conn, 0, 1, r#"{"revision":1,"limits":[]}"#).unwrap();
        assert_eq!(read_book(&conn).unwrap().unwrap().0, 1);
        assert!(write_book(&conn, 0, 1, r#"{"revision":1,"limits":[]}"#).is_err());
        write_book(&conn, 1, 2, r#"{"revision":2,"limits":[]}"#).unwrap();
        assert_eq!(read_book(&conn).unwrap().unwrap().0, 2);
        assert!(write_book(&conn, 2, 3, r#"{"revision":9,"limits":[]}"#).is_err());
        assert!(write_book(&conn, 2, 3, "not json").is_err());
    }

    #[test]
    fn an_automated_verdict_is_refused_over_the_limit_and_noted_unpriced() {
        // Round 4 M-4: claude_verdict is an automated turn. Over the app's limit it is refused; under it, the call is
        // noted in the ledger as unpriced and counts nothing.
        let conn = db();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        write_book(&conn, 0, 1, r#"{"revision":1,"limits":[{"scope":"app","period":"month","amountUsd":10,"warnAt":0.8}],"ceilings":{}}"#).unwrap();
        append(&conn, &turn("chat", "hivra", now, 12_000_000, true)).unwrap();
        assert!(admit_automated(&conn, Some("hivra"), now).is_err());
        write_book(&conn, 1, 2, r#"{"revision":2,"limits":[{"scope":"app","period":"month","amountUsd":50,"warnAt":0.8}],"ceilings":{}}"#).unwrap();
        assert!(admit_automated(&conn, Some("hivra"), now).is_ok());
        note_unpriced(&conn, "hivra", now).unwrap();
        let row = totals(&conn, 0)
            .unwrap()
            .into_iter()
            .find(|r| r.project_key == "hivra" && r.session_id.starts_with("verdict-"))
            .unwrap();
        assert_eq!((row.micros, row.priced, row.unpriced), (0, 0, 1));
        // A book that cannot be read holds the verdict too.
        conn.execute("UPDATE spend_limit_book SET body = 'not json'", [])
            .unwrap();
        assert!(admit_automated(&conn, Some("hivra"), now).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn a_folder_reached_through_a_symlink_resolves_to_its_real_path() {
        // WP-176 round 3: macOS temp folders are symlinks (/var -> /private/var). Both sides must compare real paths.
        let dir = std::env::temp_dir().join(format!("wp176-link-{}", std::process::id()));
        let real = dir.join("real-folder");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.join("linked-folder");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let expected = std::fs::canonicalize(&real).unwrap();
        assert_eq!(
            project_folder_for(link.to_str().unwrap()),
            expected.to_str().unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pool_slot_or_worktree_resolves_to_its_main_checkout() {
        let dir = std::env::temp_dir().join(format!("wp176-ledger-{}", std::process::id()));
        let main = dir.join("main-repo");
        std::fs::create_dir_all(&main).unwrap();
        let git = |args: &[&str], cwd: &std::path::Path| {
            Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q"], &main).status.success());
        assert!(git(
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "i"
            ],
            &main
        )
        .status
        .success());
        let slot = dir.join("pool-slot1");
        assert!(
            git(&["worktree", "add", "-q", slot.to_str().unwrap()], &main)
                .status
                .success()
        );
        // git reports the real path (macOS resolves /var to /private/var), so compare against that.
        let real = std::fs::canonicalize(&main).unwrap();
        let main_text = real.to_str().unwrap();
        assert_eq!(project_folder_for(main.to_str().unwrap()), main_text);
        assert_eq!(project_folder_for(slot.to_str().unwrap()), main_text);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
