//! WP-104: a check waits on a command the safe table already allows, then one wake.
//!
//! No model runs while it waits. The command is the autopilot list (`safe_cmd`, the same answers as
//! `safeCommand`), run by the PR watch's process runner with no shell, in the folder of the chat that set it (stored
//! with the row, so a restart still runs it there). The program is found the way the app finds every other CLI
//! (`harness::which_in_path` on the GUI search path), so `npm` is `npm.cmd` on Windows. A miss, a timeout, a missing
//! program or a folder that has gone is not a final failure: the row stays armed and the next look is one interval on.
//! Command output is never stored, logged or put in the wake. The wake is the note only.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use rusqlite::{params, Connection, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::queue::{self, Wake, WakeInput};
use super::safe_cmd;

const ARMED: &str = "armed";
/// At least a minute between looks, and at most a day.
pub const MIN_INTERVAL: i64 = 60_000;
pub const MAX_INTERVAL: i64 = 24 * 60 * 60 * 1000;
/// A check lives 24 hours from when it was set.
pub const LIFE: i64 = 24 * 60 * 60 * 1000;
/// Separate from the 20 timers a chat may hold.
pub const ARMED_MAX: usize = 5;
const COMMAND_MAX: usize = 2_000;
const PATTERN_MAX: usize = 200;
const NOTE_MAX: usize = 500;
const CWD_MAX: usize = 4_096;
const RUN_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub owner_session: String,
    pub note: String,
    pub interval_ms: i64,
    pub next_at: i64,
    pub deadline: i64,
    pub state: String,
    pub created_at: i64,
}

/// One claimed look. The generation is the one `settle` must still see.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Claimed {
    pub id: String,
    pub owner_session: String,
    pub command: String,
    pub pattern: String,
    pub note: String,
    /// The folder the chat works in. Empty only on a row made before this was stored.
    pub cwd: String,
    pub generation: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInput {
    pub owner_session: String,
    pub command: String,
    #[serde(default)]
    pub pattern: String,
    pub note: String,
    pub interval_ms: i64,
    /// The folder the chat works in (its working copy, else its project). Required.
    #[serde(default)]
    pub cwd: String,
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS firstmate_checks (
           id TEXT PRIMARY KEY,
           owner_session TEXT NOT NULL,
           command TEXT NOT NULL,
           pattern TEXT NOT NULL,
           note TEXT NOT NULL,
           interval_ms INTEGER NOT NULL,
           next_at INTEGER NOT NULL,
           deadline INTEGER NOT NULL,
           generation INTEGER NOT NULL,
           state TEXT NOT NULL,
           wake_id TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           cwd TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS firstmate_checks_due ON firstmate_checks(state, next_at);",
    )?;
    // A table made before the folder was stored: add the column, keep the rows. Those rows have no folder and stop.
    crate::session_store::ensure_table_column(
        conn,
        "firstmate_checks",
        "cwd",
        "TEXT NOT NULL DEFAULT ''",
    )
}

const COLUMNS: &str = "id, owner_session, command, pattern, note, interval_ms, next_at, deadline, \
                       generation, state, wake_id, created_at, updated_at, cwd";

struct RowCheck {
    check: Check,
    command: String,
    pattern: String,
    cwd: String,
    generation: i64,
}

fn from_row(row: &Row) -> rusqlite::Result<RowCheck> {
    Ok(RowCheck {
        command: row.get(2)?,
        pattern: row.get(3)?,
        cwd: row.get(13)?,
        generation: row.get(8)?,
        check: Check {
            id: row.get(0)?,
            owner_session: row.get(1)?,
            note: row.get(4)?,
            interval_ms: row.get(5)?,
            next_at: row.get(6)?,
            deadline: row.get(7)?,
            state: row.get(9)?,
            created_at: row.get(11)?,
        },
    })
}

fn query(
    conn: &Connection,
    clause: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<RowCheck>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM firstmate_checks {clause}"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(args, from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string());
    rows
}

/// The folder a check will run in, settled once: a full path to a folder that is there now, `~` and `..` resolved.
/// Nothing is stored for a path that isn't one.
fn folder(raw: &str) -> Result<String, String> {
    const WHICH: &str = "a check runs in the chat's folder";
    if raw.trim().is_empty() {
        return Err(format!("{WHICH}: none was given"));
    }
    if raw.chars().count() > CWD_MAX || raw.contains('\0') {
        return Err(format!("{WHICH}: that folder name can't be used"));
    }
    let path = crate::fs::expand_home(raw);
    if !path.is_absolute() {
        return Err(format!("{WHICH}: that isn't a full path"));
    }
    let dir =
        crate::fs::canonical(&path).map_err(|_| format!("{WHICH}: that folder isn't there"))?;
    if !dir.is_dir() {
        return Err(format!("{WHICH}: that isn't a folder"));
    }
    dir.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{WHICH}: that folder name can't be used"))
}

/// Arm a check. Refuses a command the safe table does not already allow, and does not insert a row then.
pub fn set(conn: &mut Connection, input: CheckInput, now: i64) -> Result<Check, String> {
    let owner = input.owner_session.trim().to_string();
    if !queue::session_ok(&owner) {
        return Err("a check names the chat it wakes".into());
    }
    let note: String = input.note.trim().chars().take(NOTE_MAX).collect();
    if note.is_empty() {
        return Err("say what this check is for".into());
    }
    if input.interval_ms < MIN_INTERVAL {
        return Err("a check waits at least a minute between tries".into());
    }
    if input.interval_ms > MAX_INTERVAL {
        return Err("a check waits at most a day between tries".into());
    }
    let command = input.command.trim();
    if command.chars().count() > COMMAND_MAX {
        return Err("that command is too long".into());
    }
    if let Some(why) = safe_cmd::verdict(command) {
        return Err(why);
    }
    // Parse once here so a command the table allows is also one we can exec with no shell.
    safe_cmd::argv(command)?;
    let cwd = folder(&input.cwd)?;
    if input.pattern.chars().count() > PATTERN_MAX {
        return Err("the text to watch for is too long".into());
    }
    let next_at = now
        .checked_add(input.interval_ms)
        .ok_or_else(|| "a check waits at least a minute between tries".to_string())?;
    let deadline = now
        .checked_add(LIFE)
        .ok_or_else(|| "a check stops after a day".to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let armed: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM firstmate_checks WHERE owner_session = ?1 AND state = 'armed'",
            params![owner],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if armed as usize >= ARMED_MAX {
        return Err(format!(
            "this chat already has {ARMED_MAX} checks waiting; cancel one first"
        ));
    }
    let check = Check {
        id: format!("check-{}", uuid::Uuid::new_v4().simple()),
        owner_session: owner,
        note,
        interval_ms: input.interval_ms,
        next_at,
        deadline,
        state: ARMED.into(),
        created_at: now,
    };
    tx.execute(
        "INSERT INTO firstmate_checks
           (id, owner_session, command, pattern, note, interval_ms, next_at, deadline, generation, state, wake_id, created_at, updated_at, cwd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, NULL, ?10, ?10, ?11)",
        params![
            check.id,
            check.owner_session,
            command,
            input.pattern,
            check.note,
            check.interval_ms,
            check.next_at,
            check.deadline,
            check.state,
            now,
            cwd
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(check)
}

/// Cancel one of this chat's armed checks. None when it isn't armed, or isn't this chat's.
pub fn cancel(
    conn: &mut Connection,
    owner: &str,
    id: &str,
    now: i64,
) -> Result<Option<Check>, String> {
    let changed = conn
        .execute(
            "UPDATE firstmate_checks SET state = 'cancelled', updated_at = ?3
              WHERE id = ?1 AND owner_session = ?2 AND state = 'armed'",
            params![id, owner, now],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Ok(None);
    }
    Ok(query(conn, "WHERE id = ?1", &[&id])?
        .into_iter()
        .next()
        .map(|row| row.check))
}

/// Delete settled checks `queue::KEEP_SETTLED` on. Armed rows stay.
pub fn prune(conn: &Connection, now: i64) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM firstmate_checks
          WHERE state IN ('fired', 'cancelled', 'expired', 'refused') AND updated_at < ?1",
        params![now - queue::KEEP_SETTLED],
    )
    .map_err(|e| e.to_string())
}

/// Claim every armed check that is due. Each claim bumps the generation, so a second look gets nothing and a late
/// result cannot wake. Past the deadline, the row expires and is not run. `now == deadline` still runs.
pub(crate) fn claim_due(conn: &mut Connection, now: i64) -> Result<Vec<Claimed>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let due = query(
        &tx,
        "WHERE state = 'armed' AND next_at <= ?1 ORDER BY next_at, id",
        &[&now],
    )?;
    let mut claimed = Vec::new();
    for row in due {
        if now > row.check.deadline {
            tx.execute(
                "UPDATE firstmate_checks SET state = 'expired', updated_at = ?3
                  WHERE id = ?1 AND generation = ?2 AND state = 'armed'",
                params![row.check.id, row.generation, now],
            )
            .map_err(|e| e.to_string())?;
            continue;
        }
        let next_at = now.saturating_add(row.check.interval_ms);
        let changed = tx
            .execute(
                "UPDATE firstmate_checks
                    SET generation = generation + 1, next_at = ?3, updated_at = ?4
                  WHERE id = ?1 AND generation = ?2 AND state = 'armed'",
                params![row.check.id, row.generation, next_at, now],
            )
            .map_err(|e| e.to_string())?;
        if changed == 1 {
            claimed.push(Claimed {
                id: row.check.id,
                owner_session: row.check.owner_session,
                command: row.command,
                pattern: row.pattern,
                note: row.check.note,
                cwd: row.cwd,
                generation: row.generation + 1,
            });
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(claimed)
}

/// What one look decided. Carries no command output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Attempt {
    /// Exit 0, or the text matched. One wake.
    Wake,
    /// Still waiting. Not a failure.
    Wait,
    /// The command is no longer one the safe table allows. Stop the row.
    Stop,
}

/// A finished process, only while we decide. Dropped before anything is stored.
struct Finish<'a> {
    code: Option<i32>,
    stdout: &'a str,
    stderr: &'a str,
}

/// Wake on exit 0, or when a non-empty pattern is in the text. An empty pattern does not match everything.
/// A missing result (timeout, not installed, spawn error) waits.
fn judge(finished: Option<Finish<'_>>, pattern: &str) -> Attempt {
    let Some(finished) = finished else {
        return Attempt::Wait;
    };
    let matched = finished.code == Some(0)
        || (!pattern.is_empty()
            && (finished.stdout.contains(pattern) || finished.stderr.contains(pattern)));
    if matched {
        Attempt::Wake
    } else {
        Attempt::Wait
    }
}

/// Turn a claimed look into a wake, or leave it waiting. The wake text is the note only.
pub(crate) fn settle(
    conn: &mut Connection,
    item: &Claimed,
    attempt: Attempt,
    now: i64,
) -> Result<Option<Wake>, String> {
    match attempt {
        Attempt::Wait => Ok(None),
        Attempt::Stop => {
            conn.execute(
                "UPDATE firstmate_checks SET state = 'refused', updated_at = ?3
                  WHERE id = ?1 AND generation = ?2 AND state = 'armed'",
                params![item.id, item.generation, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(None)
        }
        Attempt::Wake => {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let changed = tx
                .execute(
                    "UPDATE firstmate_checks SET state = 'fired', updated_at = ?3
                      WHERE id = ?1 AND generation = ?2 AND state = 'armed'",
                    params![item.id, item.generation, now],
                )
                .map_err(|e| e.to_string())?;
            if changed != 1 {
                tx.commit().map_err(|e| e.to_string())?;
                return Ok(None);
            }
            let added = queue::add_in(
                &tx,
                WakeInput {
                    owner_session: item.owner_session.clone(),
                    kind: "timer".into(),
                    key: format!("check:{}", item.id),
                    title: Some("Check".into()),
                    text: format!("Your check: {}", item.note),
                    ..Default::default()
                },
                now,
            )?;
            tx.execute(
                "UPDATE firstmate_checks SET wake_id = ?2 WHERE id = ?1",
                params![item.id, added.wake.id],
            )
            .map_err(|e| e.to_string())?;
            let fresh = added.fresh;
            let wake = added.wake;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(fresh.then_some(wake))
        }
    }
}

/// Runs one command in one folder and says what it decided. The live one starts a process; tests pass their own.
pub(crate) trait Runner {
    fn run(&self, command: &str, pattern: &str, cwd: &Path) -> Attempt;
}

/// The app's own runner: a real process, no shell, on the GUI search path.
pub(crate) struct LiveRunner;

impl Runner for LiveRunner {
    fn run(&self, command: &str, pattern: &str, cwd: &Path) -> Attempt {
        run_in(command, pattern, cwd, &crate::harness::gui_search_path())
    }
}

/// What one claimed look decides. A command the table no longer allows, or a row with no folder, stops the row: it
/// never runs, and never runs wherever the app happens to be. A folder that has gone waits, and runs again if it
/// comes back (an unplugged drive or a renamed working copy is not a final failure).
pub(crate) fn look(item: &Claimed, runner: &impl Runner) -> Attempt {
    if safe_cmd::verdict(&item.command).is_some() || item.cwd.is_empty() {
        return Attempt::Stop;
    }
    let cwd = Path::new(&item.cwd);
    if !cwd.is_dir() {
        return Attempt::Wait;
    }
    runner.run(&item.command, &item.pattern, cwd)
}

/// Claim, look, settle. Tests pass a fake runner and a fake `now`. The real look is `watcher_tick`, which claims, drops
/// the lock, then settles.
#[cfg(test)]
fn poll(conn: &mut Connection, now: i64, runner: &impl Runner) -> Result<Vec<Wake>, String> {
    let due = claim_due(conn, now)?;
    let mut woke = Vec::new();
    for item in due {
        let attempt = look(&item, runner);
        if let Some(wake) = settle(conn, &item, attempt, now)? {
            woke.push(wake);
        }
    }
    Ok(woke)
}

/// The command a check starts: the program found on `search` by the harness resolver, its arguments, in `cwd`. `None`
/// when the program isn't there. `windows` says what kind of machine is asking, because a bare `npm` is `npm.cmd` on
/// Windows and `cargo` is `cargo.exe`: the app passes its own, a test passes `true` to see the Windows answer anywhere.
fn command_for(words: &[String], cwd: &Path, search: &str, windows: bool) -> Option<Command> {
    let program = crate::harness::which_in_path_as(search, words.first()?, windows)?;
    let mut cmd = Command::new(program);
    cmd.args(&words[1..]).current_dir(cwd);
    Some(cmd)
}

/// The PR watch runner: no shell, the same child setup `gh` uses, a 60s deadline, in `cwd`. The program is found on
/// `search` the way the app finds every CLI (`npm` is `npm.cmd` on Windows); one that isn't there waits. Output is
/// dropped after the decision.
fn run_in(command: &str, pattern: &str, cwd: &Path, search: &str) -> Attempt {
    let words = match safe_cmd::argv(command) {
        Ok(words) => words,
        Err(_) => return Attempt::Stop,
    };
    let Some(mut cmd) = command_for(&words, cwd, search, cfg!(windows)) else {
        return Attempt::Wait;
    };
    crate::background_work::configure_child(&mut cmd);
    crate::harness::apply_gui_env(&mut cmd);
    let finished = match crate::pr_watch::bounded::run(cmd, RUN_TIMEOUT) {
        Ok(ran) => Some((ran.status.code(), ran.stdout, ran.stderr)),
        Err(_) => None,
    };
    let attempt = judge(
        finished.as_ref().map(|(code, stdout, stderr)| Finish {
            code: *code,
            stdout,
            stderr,
        }),
        pattern,
    );
    drop(finished);
    attempt
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::SessionStore;
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;

    const MIN: i64 = 60_000;
    const DAY: i64 = 24 * 60 * 60 * 1000;
    const SECRET: &str = "SECRET-OUTPUT";

    fn store() -> SessionStore {
        SessionStore::open_in_memory().unwrap()
    }

    fn input(command: &str, pattern: &str, note: &str) -> CheckInput {
        CheckInput {
            owner_session: "lead".into(),
            command: command.into(),
            pattern: pattern.into(),
            note: note.into(),
            interval_ms: MIN,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        }
    }

    /// A folder made for one test, under the temp folder, removed when it goes out of scope.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("hivra-wp104-{}", uuid::Uuid::new_v4().simple()))
                .join(name);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }

        fn canonical(&self) -> PathBuf {
            crate::fs::canonical(&self.0).unwrap()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let Some(root) = self.0.parent() else {
                return;
            };
            let Ok(root) = crate::fs::canonical(root) else {
                return;
            };
            let Ok(tmp) = crate::fs::canonical(std::env::temp_dir()) else {
                return;
            };
            if root.starts_with(&tmp) && root != tmp {
                let _ = std::fs::remove_dir_all(&root);
            }
        }
    }

    struct Script {
        code: Option<i32>,
        stdout: String,
        stderr: String,
        calls: Cell<usize>,
        cwds: RefCell<Vec<PathBuf>>,
    }

    impl Script {
        fn exit(code: i32, stdout: &str) -> Self {
            Self {
                code: Some(code),
                stdout: stdout.into(),
                stderr: String::new(),
                calls: Cell::new(0),
                cwds: RefCell::new(Vec::new()),
            }
        }

        fn wait() -> Self {
            Self {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                calls: Cell::new(0),
                cwds: RefCell::new(Vec::new()),
            }
        }
    }

    impl Runner for Script {
        fn run(&self, _command: &str, pattern: &str, cwd: &Path) -> Attempt {
            self.cwds.borrow_mut().push(cwd.to_path_buf());
            self.calls.set(self.calls.get() + 1);
            judge(
                Some(Finish {
                    code: self.code,
                    stdout: &self.stdout,
                    stderr: &self.stderr,
                }),
                pattern,
            )
        }
    }

    struct PanicRun;

    impl Runner for PanicRun {
        fn run(&self, command: &str, _: &str, _: &Path) -> Attempt {
            panic!("ran a command: {command}");
        }
    }

    fn dump(conn: &Connection) -> String {
        let mut out = String::new();
        let mut checks = conn
            .prepare(
                "SELECT command, pattern, note, state, COALESCE(wake_id, '') FROM firstmate_checks",
            )
            .unwrap();
        let mut rows = checks.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for i in 0..5 {
                let value: String = row.get(i).unwrap();
                out.push_str(&value);
                out.push('\n');
            }
        }
        let mut wakes = conn
            .prepare("SELECT key, COALESCE(title, ''), text FROM firstmate_wakes")
            .unwrap();
        let mut rows = wakes.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for i in 0..3 {
                let value: String = row.get(i).unwrap();
                out.push_str(&value);
                out.push('\n');
            }
        }
        out
    }

    #[test]
    fn an_exit_of_zero_wakes_once_and_a_miss_does_not() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let check = set(&mut conn, input("npm test", "", "the build"), 0).unwrap();
        assert_eq!(check.next_at, MIN);
        assert_eq!(check.deadline, DAY);
        let early = poll(&mut conn, MIN - 1, &Script::exit(0, SECRET)).unwrap();
        assert!(early.is_empty());
        let waiting = poll(&mut conn, MIN, &Script::exit(1, "still failing")).unwrap();
        assert!(waiting.is_empty());
        let row = query(&conn, "WHERE id = ?1", &[&check.id]).unwrap();
        assert_eq!(row[0].check.state, ARMED);
        assert_eq!(row[0].check.next_at, MIN + MIN);
        let woke = poll(&mut conn, MIN + MIN, &Script::exit(0, SECRET)).unwrap();
        assert_eq!(woke.len(), 1);
        assert_eq!(woke[0].kind, "timer");
        assert_eq!(woke[0].key, format!("check:{}", check.id));
        assert_eq!(woke[0].text, "Your check: the build");
        assert!(!woke[0].text.contains(SECRET));
        let again = poll(&mut conn, MIN * 4, &Script::exit(0, SECRET)).unwrap();
        assert!(again.is_empty());
        assert!(!dump(&conn).contains(SECRET));
    }

    #[test]
    fn matching_text_wakes_even_when_the_exit_is_not_zero() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let check = set(&mut conn, input("rg -n ready src", "ready", "the word"), 0).unwrap();
        let mut script = Script::exit(1, "not yet");
        script.stderr = "build is ready\r\n".into();
        // stdout does not match; stderr does. An empty pattern would not.
        let woke = poll(&mut conn, MIN, &script).unwrap();
        assert_eq!(woke.len(), 1);
        assert_eq!(woke[0].text, "Your check: the word");
        assert!(!dump(&conn).contains("build is ready"));
        let _ = check;
    }

    #[test]
    fn an_empty_pattern_does_not_match_every_string() {
        assert_eq!(
            judge(
                Some(Finish {
                    code: Some(1),
                    stdout: "anything",
                    stderr: ""
                }),
                ""
            ),
            Attempt::Wait
        );
        assert_eq!(
            judge(
                Some(Finish {
                    code: Some(0),
                    stdout: "",
                    stderr: ""
                }),
                ""
            ),
            Attempt::Wake
        );
        assert_eq!(judge(None, "ready"), Attempt::Wait);
        assert_eq!(
            judge(
                Some(Finish {
                    code: None,
                    stdout: "ready",
                    stderr: ""
                }),
                "ready"
            ),
            Attempt::Wake
        );
    }

    #[test]
    fn a_refused_command_is_not_stored_and_a_planted_row_is_not_run() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        for command in ["rm -rf build", "git status; rm -rf ~/data", "cargo fmt"] {
            assert!(
                set(&mut conn, input(command, "", "no"), 0).is_err(),
                "{command}"
            );
        }
        assert!(query(&conn, "", &[]).unwrap().is_empty());
        conn.execute(
            "INSERT INTO firstmate_checks
               (id, owner_session, command, pattern, note, interval_ms, next_at, deadline, generation, state, wake_id, created_at, updated_at)
             VALUES ('check-planted', 'lead', 'rm -rf build', '', 'no', ?1, ?1, ?2, 1, 'armed', NULL, 0, 0)",
            params![MIN, DAY],
        )
        .unwrap();
        let woke = poll(&mut conn, MIN, &PanicRun).unwrap();
        assert!(woke.is_empty());
        let row = query(&conn, "WHERE id = 'check-planted'", &[]).unwrap();
        assert_eq!(row[0].check.state, "refused");
    }

    #[test]
    fn five_per_chat_and_a_timer_still_fits() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        for n in 0..ARMED_MAX {
            set(&mut conn, input("git status", "", &format!("n{n}")), 0).unwrap();
        }
        let sixth = set(&mut conn, input("git status", "", "too many"), 0);
        assert!(sixth.unwrap_err().contains("5 checks"));
        let other = CheckInput {
            owner_session: "other".into(),
            ..input("pwd", "", "theirs")
        };
        assert!(set(&mut conn, other, 0).is_ok());
        let timer = super::super::timers::set(
            &mut conn,
            super::super::timers::TimerInput {
                owner_session: "lead".into(),
                due_at: MIN,
                note: "a timer".into(),
            },
            0,
        );
        assert!(timer.is_ok());
    }

    #[test]
    fn bounds_and_blank_input_are_refused() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let mut too_soon = input("pwd", "", "soon");
        too_soon.interval_ms = MIN - 1;
        assert!(set(&mut conn, too_soon, 0).is_err());
        let mut too_far = input("pwd", "", "far");
        too_far.interval_ms = MAX_INTERVAL + 1;
        assert!(set(&mut conn, too_far, 0).is_err());
        let mut blank = input("pwd", "", "   ");
        blank.note = "  ".into();
        assert!(set(&mut conn, blank, 0).is_err());
        let mut nameless = input("pwd", "", "ok");
        nameless.owner_session = "has space".into();
        assert!(set(&mut conn, nameless, 0).is_err());
        let mut long = input("pwd", "", "ok");
        long.pattern = "x".repeat(PATTERN_MAX + 1);
        assert!(set(&mut conn, long, 0).is_err());
        assert!(set(&mut conn, input("pwd", "", "ok"), 0).is_ok());
        assert!(query(&conn, "", &[]).unwrap().len() == 1);
    }

    #[test]
    fn a_timeout_is_not_a_final_failure() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let check = set(&mut conn, input("npm test", "", "ci"), 0).unwrap();
        let woke = poll(&mut conn, MIN, &Script::wait()).unwrap();
        assert!(woke.is_empty());
        let row = query(&conn, "WHERE id = ?1", &[&check.id]).unwrap();
        assert_eq!(row[0].check.state, ARMED);
        assert_eq!(row[0].check.next_at, MIN + MIN);
    }

    #[test]
    fn cancel_while_a_run_is_out_does_not_wake() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let check = set(&mut conn, input("git status", "", "status"), 0).unwrap();
        let due = claim_due(&mut conn, MIN).unwrap();
        assert_eq!(due.len(), 1);
        let again = claim_due(&mut conn, MIN).unwrap();
        assert!(again.is_empty());
        assert!(cancel(&mut conn, "lead", &check.id, MIN).unwrap().is_some());
        assert!(cancel(&mut conn, "other", &check.id, MIN)
            .unwrap()
            .is_none());
        let wake = settle(&mut conn, &due[0], Attempt::Wake, MIN).unwrap();
        assert!(wake.is_none());
        assert!(queue::open(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_late_result_after_a_newer_claim_does_not_wake() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        set(&mut conn, input("git status", "", "status"), 0).unwrap();
        let due = claim_due(&mut conn, MIN).unwrap();
        conn.execute(
            "UPDATE firstmate_checks SET generation = generation + 1 WHERE id = ?1",
            params![due[0].id],
        )
        .unwrap();
        let wake = settle(&mut conn, &due[0], Attempt::Wake, MIN).unwrap();
        assert!(wake.is_none());
        let row = query(&conn, "WHERE id = ?1", &[&due[0].id]).unwrap();
        assert_eq!(row[0].check.state, ARMED);
    }

    #[test]
    fn the_deadline_runs_once_and_then_expires_without_a_run() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let check = set(&mut conn, input("pwd", "done", "the day"), 0).unwrap();
        let script = Script::exit(1, "nope");
        let woke = poll(&mut conn, DAY, &script).unwrap();
        assert!(woke.is_empty());
        assert_eq!(script.calls.get(), 1);
        let row = query(&conn, "WHERE id = ?1", &[&check.id]).unwrap();
        assert_eq!(row[0].check.state, ARMED);
        let later = poll(&mut conn, DAY + MIN, &PanicRun).unwrap();
        assert!(later.is_empty());
        let row = query(&conn, "WHERE id = ?1", &[&check.id]).unwrap();
        assert_eq!(row[0].check.state, "expired");
    }

    #[test]
    fn exactly_at_the_deadline_still_runs() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let mut once = input("pwd", "", "once");
        once.interval_ms = MAX_INTERVAL;
        let check = set(&mut conn, once, 0).unwrap();
        assert_eq!(check.next_at, check.deadline);
        let woke = poll(&mut conn, DAY, &Script::exit(0, "")).unwrap();
        assert_eq!(woke.len(), 1);
    }

    #[test]
    fn a_check_stores_the_chats_folder_and_runs_there() {
        let folder = TempDir::new("héllo wörld 日本語");
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let mut one = input("npm test", "", "in the folder");
        one.cwd = folder.path();
        let check = set(&mut conn, one, 0).unwrap();
        let stored: String = conn
            .query_row(
                "SELECT cwd FROM firstmate_checks WHERE id = ?1",
                params![check.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(PathBuf::from(&stored), folder.canonical());
        let claimed = claim_due(&mut conn, MIN).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(PathBuf::from(&claimed[0].cwd), folder.canonical());
        // The look is made in that folder, and nowhere else.
        let script = Script::exit(0, "");
        let attempt = look(&claimed[0], &script);
        assert_eq!(attempt, Attempt::Wake);
        assert_eq!(*script.cwds.borrow(), vec![folder.canonical()]);
    }

    #[test]
    fn a_check_needs_a_real_folder_and_stores_nothing_without_one() {
        let folder = TempDir::new("real");
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let file = folder.0.join("a-file.txt");
        std::fs::write(&file, "x").unwrap();
        let missing = folder.0.join("not there");
        let long = format!("/{}", "a".repeat(5_000));
        for bad in [
            String::new(),
            "   ".to_string(),
            "src".to_string(),
            "../elsewhere".to_string(),
            "./here".to_string(),
            "a\0b".to_string(),
            file.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
            long,
        ] {
            let mut one = input("pwd", "", "no");
            one.cwd = bad.clone();
            assert!(set(&mut conn, one, 0).is_err(), "{bad:?}");
        }
        assert!(query(&conn, "", &[]).unwrap().is_empty());
        // A `..` inside a full path is settled before it is stored.
        let mut dotted = input("pwd", "", "dotted");
        dotted.cwd = folder
            .0
            .join("real")
            .join("..")
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(folder.0.join("real")).unwrap();
        set(&mut conn, dotted, 0).unwrap();
        let rows = query(&conn, "", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(PathBuf::from(&rows[0].cwd), folder.canonical());
    }

    #[test]
    fn a_folder_that_has_gone_waits_and_comes_back_to_a_wake() {
        let folder = TempDir::new("comes and goes");
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let mut one = input("npm test", "", "the build");
        one.cwd = folder.path();
        let check = set(&mut conn, one, 0).unwrap();
        std::fs::remove_dir(&folder.0).unwrap();
        // Not a final failure: nothing runs, the row stays armed and is looked at again an interval on.
        assert!(poll(&mut conn, MIN, &PanicRun).unwrap().is_empty());
        let row = query(&conn, "WHERE id = ?1", &[&check.id]).unwrap();
        assert_eq!(row[0].check.state, ARMED);
        assert_eq!(row[0].check.next_at, MIN + MIN);
        std::fs::create_dir_all(&folder.0).unwrap();
        let script = Script::exit(0, "");
        let woke = poll(&mut conn, MIN + MIN, &script).unwrap();
        assert_eq!(woke.len(), 1);
        assert_eq!(*script.cwds.borrow(), vec![folder.canonical()]);
    }

    #[test]
    fn a_row_with_no_folder_is_stopped_not_run_where_the_app_happens_to_be() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        conn.execute(
            "INSERT INTO firstmate_checks
               (id, owner_session, command, pattern, note, interval_ms, next_at, deadline, generation, state, wake_id, created_at, updated_at)
             VALUES ('check-nofolder', 'lead', 'npm test', '', 'old', ?1, ?1, ?2, 1, 'armed', NULL, 0, 0)",
            params![MIN, DAY],
        )
        .unwrap();
        assert!(poll(&mut conn, MIN, &PanicRun).unwrap().is_empty());
        let row = query(&conn, "WHERE id = 'check-nofolder'", &[]).unwrap();
        assert_eq!(row[0].check.state, "refused");
    }

    #[test]
    fn a_table_made_before_the_folder_column_gets_it_and_keeps_its_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE firstmate_checks (
               id TEXT PRIMARY KEY, owner_session TEXT NOT NULL, command TEXT NOT NULL, pattern TEXT NOT NULL,
               note TEXT NOT NULL, interval_ms INTEGER NOT NULL, next_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
               generation INTEGER NOT NULL, state TEXT NOT NULL, wake_id TEXT, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             INSERT INTO firstmate_checks VALUES ('check-old', 'lead', 'npm test', '', 'old', 60000, 60000, 86400000, 1, 'armed', NULL, 0, 0);",
        )
        .unwrap();
        ensure_tables(&conn).unwrap();
        ensure_tables(&conn).unwrap();
        let rows = query(&conn, "", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].cwd, "");
        assert_eq!(rows[0].check.id, "check-old");
    }

    /// A stand-in for npm that exits 0 only when it is run in a folder holding `wp104-marker`. It is a shell script
    /// on Unix and an `npm.cmd` on Windows, which is the shape the real npm has there.
    fn fake_npm(dir: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("npm");
            std::fs::write(&path, "#!/bin/sh\ntest -f wp104-marker\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        std::fs::write(
            dir.join("npm.cmd"),
            "@echo off\r\nif exist wp104-marker exit /b 0\r\nexit /b 1\r\n",
        )
        .unwrap();
    }

    struct Search(String);

    impl Runner for Search {
        fn run(&self, command: &str, pattern: &str, cwd: &Path) -> Attempt {
            run_in(command, pattern, cwd, &self.0)
        }
    }

    fn path_of(dir: &Path) -> String {
        std::env::join_paths([dir])
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn npm_is_found_through_the_search_path_and_runs_in_the_chats_folder() {
        let bin = TempDir::new("bin dir");
        fake_npm(&bin.0);
        let project = TempDir::new("project one");
        let elsewhere = TempDir::new("project two");
        std::fs::write(project.0.join("wp104-marker"), "").unwrap();
        let search = path_of(&bin.0);
        // The shim is found by its Windows name too: `npm` is `npm.cmd` there.
        let found = crate::harness::which_in_path(&search, "npm").unwrap();
        assert_eq!(
            found.file_name().unwrap().to_string_lossy(),
            if cfg!(windows) { "npm.cmd" } else { "npm" }
        );
        assert_eq!(run_in("npm test", "", &project.0, &search), Attempt::Wake);
        assert_eq!(run_in("npm test", "", &elsewhere.0, &search), Attempt::Wait);
    }

    fn words(command: &str) -> Vec<String> {
        safe_cmd::argv(command).unwrap()
    }

    #[test]
    fn on_a_windows_machine_npm_and_cargo_start_as_their_launchers() {
        let bin = TempDir::new("windows bin");
        let project = TempDir::new("the chat's project");
        // What a Windows install of npm leaves: a shell shim named plain `npm` beside the launcher `npm.cmd`. A bare
        // `Command::new("npm")` finds neither there; the shim is not a program Windows can start. Cargo is an .exe.
        // None of these has an execute bit, because Windows has none: the name is what makes a file a program.
        for name in ["npm", "npm.cmd", "npm.ps1", "cargo.exe", "node.exe"] {
            std::fs::write(bin.0.join(name), "x").unwrap();
        }
        let search = path_of(&bin.0);

        let npm = command_for(&words("npm test"), &project.0, &search, true).unwrap();
        assert_eq!(npm.get_program(), bin.0.join("npm.cmd").as_os_str());
        assert_eq!(npm.get_args().collect::<Vec<_>>(), ["test"]);
        assert_eq!(npm.get_current_dir(), Some(project.0.as_path()));

        let cargo =
            command_for(&words("cargo test --workspace"), &project.0, &search, true).unwrap();
        assert_eq!(cargo.get_program(), bin.0.join("cargo.exe").as_os_str());
        assert_eq!(
            cargo.get_args().collect::<Vec<_>>(),
            ["test", "--workspace"]
        );
        assert_eq!(cargo.get_current_dir(), Some(project.0.as_path()));

        // The same folder seen by a machine that isn't Windows has no `npm` it can run (no execute bit) and no
        // `cargo`: the launchers are not found by the bare name there.
        assert!(command_for(&words("npm test"), &project.0, &search, false).is_none());
        assert!(command_for(&words("cargo test"), &project.0, &search, false).is_none());
    }

    #[test]
    fn on_a_windows_machine_a_shell_shim_alone_is_not_a_program_and_the_check_waits() {
        let bin = TempDir::new("shim only");
        let project = TempDir::new("project");
        std::fs::write(bin.0.join("npm"), "#!/bin/sh\n").unwrap();
        let search = path_of(&bin.0);
        assert!(command_for(&words("npm test"), &project.0, &search, true).is_none());
    }

    #[test]
    fn a_program_that_is_not_installed_waits() {
        let empty = TempDir::new("nothing here");
        let project = TempDir::new("project");
        let search = path_of(&empty.0);
        assert_eq!(run_in("npm test", "", &project.0, &search), Attempt::Wait);
        assert_eq!(run_in("cargo test", "", &project.0, &search), Attempt::Wait);
    }

    #[test]
    fn a_real_check_runs_in_its_folder_from_set_to_one_wake() {
        let bin = TempDir::new("bin");
        fake_npm(&bin.0);
        let project = TempDir::new("the chat's project");
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let mut one = input("npm test", "", "the build");
        one.cwd = project.path();
        let check = set(&mut conn, one, 0).unwrap();
        let runner = Search(path_of(&bin.0));
        // Not done yet: the marker is missing, so the look waits.
        assert!(poll(&mut conn, MIN, &runner).unwrap().is_empty());
        std::fs::write(project.0.join("wp104-marker"), "").unwrap();
        let woke = poll(&mut conn, MIN + MIN, &runner).unwrap();
        assert_eq!(woke.len(), 1);
        assert_eq!(woke[0].key, format!("check:{}", check.id));
        assert_eq!(woke[0].text, "Your check: the build");
        assert!(poll(&mut conn, MIN * 5, &runner).unwrap().is_empty());
    }

    struct TempDb(PathBuf);

    impl TempDb {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("hivra-wp104-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDb(dir.join("monocode.db"))
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let Some(dir) = self.0.parent() else {
                return;
            };
            let Ok(dir) = crate::fs::canonical(dir) else {
                return;
            };
            let Ok(tmp) = crate::fs::canonical(std::env::temp_dir()) else {
                return;
            };
            if dir.starts_with(&tmp) && dir != tmp {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }

    #[test]
    fn a_check_survives_a_restart_and_wakes_once() {
        let file = TempDb::new();
        let id = {
            let store = SessionStore::open(file.0.clone()).unwrap();
            let mut conn = store.lock_conn().unwrap();
            let check = set(&mut conn, input("npm test", "ready", "after a restart"), 0).unwrap();
            let woke = poll(&mut conn, MIN, &Script::exit(1, "still compiling")).unwrap();
            assert!(woke.is_empty());
            check.id
        };
        let store = SessionStore::open(file.0.clone()).unwrap();
        let mut conn = store.lock_conn().unwrap();
        let woke = poll(&mut conn, MIN + MIN, &Script::exit(0, SECRET)).unwrap();
        assert_eq!(woke.len(), 1);
        assert_eq!(woke[0].text, "Your check: after a restart");
        assert_eq!(woke[0].key, format!("check:{id}"));
        let again = poll(&mut conn, MIN * 5, &Script::exit(0, SECRET)).unwrap();
        assert!(again.is_empty());
        assert_eq!(queue::open(&conn).unwrap().len(), 1);
        assert!(!dump(&conn).contains(SECRET));
    }
}

/// Review r5 repro for PR #208 (WP-178). Red at a5bc60a97.
#[cfg(test)]
mod review_r5_repro {
    /// HIGH (new): `monocode app timers.check {"command":"npm test"}` from a Mono's or a team's chat (agentAppTimers.ts)
    /// stores the command with the chat's folder, and the watcher runs it every minute through `LiveRunner`: no shell,
    /// but no sandbox either. `npm test`, `npm run check|lint|build`, `cargo test|check|clippy` (build.rs, proc macros)
    /// and `node --test` all run code the agent wrote in that folder. The agent sets `"test": "printf off > …/settings/
    /// agent-sandbox"` in package.json, arms the check and ends its turn; within a minute the app turns the sandbox off
    /// (or plants a LaunchAgent, or reads ~/.ssh) outside the sandbox. Verify runs and goal checks are wrapped
    /// (`action_wrap`); this runner is not. The seam is `agent_sandbox::action_wrap` / `under_wrap`; a unit test cannot
    /// turn the sandbox on off macOS, so this reads the live runner.
    #[test]
    fn a_check_an_agent_armed_runs_under_the_agent_sandbox() {
        let source = include_str!("checks.rs");
        let start = source
            .find("impl Runner for LiveRunner")
            .expect("LiveRunner");
        let end = source.find("#[cfg(test)]\nmod tests").expect("tests");
        let live = &source[start..end];
        assert!(
            live.contains("agent_sandbox::"),
            "a check an agent armed (npm test, cargo test, node --test in its own folder) runs outside the sandbox"
        );
    }
}
