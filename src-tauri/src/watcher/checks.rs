//! WP-104: a check waits on a command the safe table already allows, then one wake.
//!
//! No model runs while it waits. The command is the autopilot list (`safe_cmd`, the same answers as
//! `safeCommand`), run by the PR watch's process runner with no shell. A miss, a timeout or a missing program is not
//! a final failure: the row stays armed and the next look is one interval on. Command output is never stored, logged
//! or put in the wake. The wake is the note only.

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
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS firstmate_checks_due ON firstmate_checks(state, next_at);",
    )
}

const COLUMNS: &str = "id, owner_session, command, pattern, note, interval_ms, next_at, deadline, \
                       generation, state, wake_id, created_at, updated_at";

struct RowCheck {
    check: Check,
    command: String,
    pattern: String,
    generation: i64,
}

fn from_row(row: &Row) -> rusqlite::Result<RowCheck> {
    Ok(RowCheck {
        command: row.get(2)?,
        pattern: row.get(3)?,
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
           (id, owner_session, command, pattern, note, interval_ms, next_at, deadline, generation, state, wake_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, NULL, ?10, ?10)",
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
            now
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

#[cfg(test)]
trait Runner {
    fn run(&self, command: &str, pattern: &str) -> Attempt;
}

/// Claim, run, settle. Tests pass a fake runner and a fake `now`. The real look is `watcher_tick`, which claims, drops
/// the lock, then settles.
#[cfg(test)]
fn poll(
    conn: &mut Connection,
    now: i64,
    runner: &impl Runner,
) -> Result<Vec<Wake>, String> {
    let due = claim_due(conn, now)?;
    let mut woke = Vec::new();
    for item in due {
        let attempt = if safe_cmd::verdict(&item.command).is_some() {
            Attempt::Stop
        } else {
            runner.run(&item.command, &item.pattern)
        };
        if let Some(wake) = settle(conn, &item, attempt, now)? {
            woke.push(wake);
        }
    }
    Ok(woke)
}

/// The PR watch runner: no shell, the same child setup `gh` uses, a 60s deadline. Output is dropped after the decision.
pub(crate) fn live_attempt(command: &str, pattern: &str) -> Attempt {
    let words = match safe_cmd::argv(command) {
        Ok(words) => words,
        Err(_) => return Attempt::Stop,
    };
    let mut cmd = Command::new(&words[0]);
    cmd.args(&words[1..]);
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
    use std::cell::Cell;
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
        }
    }

    struct Script {
        code: Option<i32>,
        stdout: String,
        stderr: String,
        calls: Cell<usize>,
    }

    impl Script {
        fn exit(code: i32, stdout: &str) -> Self {
            Self {
                code: Some(code),
                stdout: stdout.into(),
                stderr: String::new(),
                calls: Cell::new(0),
            }
        }

        fn wait() -> Self {
            Self {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                calls: Cell::new(0),
            }
        }
    }

    impl Runner for Script {
        fn run(&self, _command: &str, pattern: &str) -> Attempt {
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
        fn run(&self, command: &str, _: &str) -> Attempt {
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
