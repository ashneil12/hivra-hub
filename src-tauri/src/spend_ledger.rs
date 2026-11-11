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
         CREATE INDEX IF NOT EXISTS spend_ledger_at ON spend_ledger(at);",
    )
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
                return text.to_string();
            }
            match common.strip_suffix("/.git") {
                Some(parent) if !parent.is_empty() => parent.to_string(),
                _ => common,
            }
        }
        _ => text.to_string(),
    }
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
